#!/usr/bin/env node
/**
 * Screenshot harness for the forecourt canopy.
 *
 *   node tools/shoot5.mjs                        # all presets -> shots/canopy/
 *   node tools/shoot5.mjs --shots=soffit,silhouette
 *   node tools/shoot5.mjs --no-build             # reuse .shot-build/canopy
 *   node tools/shoot5.mjs --query=cforce=nogrime --suffix=_nogrime
 *
 * Port 5153 and a private build directory. Everything from 5110 to 5152 and the
 * shared dist/ belong to sibling agents, and a concurrent `vite build` into a
 * shared outDir has already swapped the bundle out from under a capture here.
 *
 * Beyond taking pictures this harness measures the canopy's cost by toggling
 * `group.visible` and reading `renderer.info` on both sides. That is deliberate:
 * the draw-call count is a quantity that MUST change by construction when the
 * canopy is hidden, so if it does not change, the toggle did not apply and
 * every other number from the run is worthless. Two agents tonight read frames
 * from a control that silently did nothing; this one cannot.
 *
 * Teardown: preview server and browser are registered with one shutdown routine
 * wired to completion, throws, SIGINT, SIGTERM, uncaughtException and
 * unhandledRejection BEFORE either is started. Nothing is detached.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5153;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 240_000;
const BUILD_DIR = ".shot-build/canopy";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "canopy");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/*
 * The canopy deck spans x -6.6..6.6, z 13.1..26.7, soffit at about y 5.6.
 * Islands are at z 16.6 and 23.2; columns stand on them at x = +-3.6.
 *
 * `eye` is metres above the walkable surface at that XZ, resolved through the
 * groundHeight service rather than by hand: the forecourt is a height field
 * plus a slab plus a curb reveal and hand arithmetic on that stack has put a
 * capture 600 mm out before.
 */
const POSES = {
  // Standing under the deck between the islands, looking up. This is the shot
  // the brief cares most about: soffit, battens, fixtures, soot.
  soffit: { pos: [-1.2, 0, 19.9], eye: 1.62, look: [0.4, 5.4, 20.6], fov: 62 },
  // Head-up at the fixture line, near enough to resolve a lens.
  fixture: { pos: [-3.4, 0, 18.4], eye: 1.65, look: [-1.9, 5.35, 19.9], fov: 40 },
  // The column at the -X end of the front island, base included: plinth, collar,
  // scuffs and the drainage boot, at the height the eye actually checks.
  column: { pos: [-5.15, 0, 13.85], eye: 1.55, look: [-3.6, 1.05, 16.5], fov: 44 },
  // Full column, floor to soffit, to judge the proportion in one frame.
  column_full: { pos: [-6.9, 0, 14.6], eye: 1.6, look: [-3.6, 3.2, 16.6], fov: 66 },
  // The fascia band read across the -Z face, with the drip lip and its shadow.
  fascia: { pos: [-2.0, 0, 6.6], eye: 1.62, look: [-0.4, 5.55, 13.1], fov: 34 },
  // Square on to the road-facing band with both the logo panel and the price
  // panel in frame, at the 11 m the delivered-pixel table in
  // `tools/probe-canopy.mjs` sizes the wordmark against. The point of a
  // dedicated pose is that the arithmetic and the capture then refer to the
  // same viewpoint, rather than the sizing being done for one distance and
  // judged at another.
  sign: { pos: [0.4, 0, 2.4], eye: 1.62, look: [0.6, 5.45, 13.1], fov: 46 },
  // The silhouette from the road approach: what a canopy is for, from a
  // distance. Judge the band, the drip line and the column rhythm here.
  silhouette: { pos: [-19.5, 0, -2.5], eye: 1.7, look: [1.0, 4.6, 18.0], fov: 50 },
  // Three-quarter from the forecourt corner: deck, columns and the shadow on
  // the ground in one frame.
  approach: { pos: [-13.0, 0, 6.0], eye: 1.66, look: [1.5, 3.6, 20.0], fov: 58 },
  // Standing at a dispenser, which is where a player spends their time. Tests
  // that the canopy reads correctly *behind* the thing in the foreground.
  at_pump: { pos: [-2.66, 0, 14.42], eye: 1.62, look: [-2.2, 3.4, 16.6], fov: 58 },
  // From high and outside, to see the roof and confirm it is not an open box.
  above: { pos: [-16.0, 0, 4.0], eye: 11.0, look: [0.5, 5.2, 20.0], fov: 46 },
};

const ALL = Object.keys(POSES);
const SHOTS = ONLY.length ? ALL.filter((s) => ONLY.includes(s)) : ALL;

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[shoot5] shutting down: ${reason}`);
  const closers = [
    ["browser", async () => resources.browser && (await resources.browser.close())],
    [
      "preview server",
      async () => {
        const s = resources.server;
        if (!s) return;
        if (typeof s.close === "function") await s.close();
        else if (s.httpServer) await new Promise((r) => s.httpServer.close(r));
      },
    ],
  ];
  for (const [label, fn] of closers) {
    try {
      await withTimeout(fn(), 10_000);
    } catch (err) {
      console.error(`[shoot5] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (err) => void shutdown(1, `uncaughtException: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => void shutdown(1, `unhandledRejection: ${err?.stack ?? err}`));

/* ------------------------------------------------------------------ */

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort */
  }
}

async function waitForPort(port, budgetMs) {
  const net = await import("node:net");
  const free = () =>
    new Promise((resolve) => {
      const s = net.createConnection({ port, host: "127.0.0.1" });
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    if (await free()) {
      if (announced) console.log(`[shoot5] :${port} free after ${((Date.now() - t0) / 1000) | 0}s`);
      return;
    }
    if (Date.now() - t0 > budgetMs) throw new Error(`port ${port} still busy after ${budgetMs} ms`);
    if (!announced) {
      announced = true;
      console.log(`[shoot5] :${port} is busy; waiting up to ${budgetMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;
/**
 * Identifiers that only appear in the injected grime GLSL this system uses.
 * An allowlist of ours, not a denylist of other people's: the denylist version
 * elsewhere in this repo mistook a vegetation billboard's error for its own and
 * failed a whole run. A shader failure that matches nothing here belongs to a
 * sibling and is reported loudly but is not fatal to this capture.
 */
const MY_SHADER = /uG(Field|Scale|Film|Streak|Dust|Spots|Base|Rough|Focus|Scuff)|vGObj|vGNrm/;

async function bundleStamp() {
  const dist = path.join(ROOT, BUILD_DIR);
  const { createHash } = await import("node:crypto");
  const h = createHash("sha1");
  let newest = 0;
  let file = "";
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(dist);
  if (!files.length) return { text: `${BUILD_DIR}/ MISSING`, hash: "none", iso: "none" };
  for (const f of files) {
    const st = await fs.stat(f);
    if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
      file = path.relative(ROOT, f);
    }
    h.update(path.relative(ROOT, f));
    h.update(await fs.readFile(f));
  }
  const hash = h.digest("hex").slice(0, 12);
  const iso = new Date(newest).toISOString();
  return { text: `${iso} sha1:${hash} (${file})`, hash, iso };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[shoot5] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot5] bundle: ${stamp.text}`);

  await waitForPort(PORT, 240_000);

  console.log(`[shoot5] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot5] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shoot5", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const outDir = path.join(ROOT, "shots", SYSTEM);
  await fs.mkdir(outDir, { recursive: true });

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    bundleHash: stamp.hash,
    bundleMtime: stamp.iso,
    tag: "shoot5",
    extra: { presets: SHOTS, suffix: SUFFIX || null, query: QUERY || null },
  });

  const written = [];
  const failures = [];
  let reportedHandles = false;
  let foreignReported = false;
  let checkedSystemErrors = null;
  let cost = null;

  for (const shot of SHOTS) {
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || SHADER_FAIL.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const parts = ["shot=canopy", "gpu=1"];
    if (QUERY) parts.push(QUERY);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    // A page that renders is not a page that is healthy. `Game` catches
    // per-system init failures so one broken system cannot blank the scene,
    // which means the canopy could be entirely absent and the capture would
    // still look like a plausible forecourt. Assert on the record.
    const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    checkedSystemErrors = sysErrs;
    if (sysErrs.length) {
      for (const e of sysErrs) console.error(`[shoot5] system ${e.system} failed in ${e.phase}: ${e.message}`);
      failures.push(`${sysErrs.length} system(s) failed to initialise: ${sysErrs.map((e) => e.system).join(", ")}`);
    }

    if (!reportedHandles) {
      reportedHandles = true;

      const h = await page.evaluate(() => {
        const g = window.__GAME;
        const svc = g?.tryGet ? g.tryGet("canopy") : null;
        const blockers = g?.tryGet ? g.tryGet("canopy.blockers") : null;
        const fixtures = g?.tryGet ? g.tryGet("canopy.fixtures") : null;
        if (!svc) return null;
        return {
          serviceKeys: Object.keys(svc).sort(),
          deck: svc.deck,
          soffitY: +svc.soffitY.toFixed(3),
          clearHeight: svc.clearHeight,
          columns: svc.columns?.length ?? null,
          fixtures: Array.isArray(fixtures) ? fixtures.length : null,
          fixtureKeys: fixtures?.[0] ? Object.keys(fixtures[0]).sort() : null,
          firstFixture: fixtures?.[0]
            ? { x: +fixtures[0].position.x.toFixed(2), y: +fixtures[0].position.y.toFixed(2), z: +fixtures[0].position.z.toFixed(2) }
            : null,
          blockers: Array.isArray(blockers) ? blockers.length : null,
          blockerKeys: blockers?.[0] ? Object.keys(blockers[0]).sort() : null,
          fixturesOn: typeof svc.fixturesOn === "function" ? svc.fixturesOn() : null,
        };
      });
      console.log(`[shoot5] canopy services: ${JSON.stringify(h, null, 2).replace(/\n/g, "\n           ")}`);
      if (!h) failures.push('service "canopy" was never provided');
      else {
        if (h.columns !== 4) failures.push(`expected 4 columns, got ${h.columns}`);
        if (h.blockers !== 4) failures.push(`expected 4 collision blockers, got ${h.blockers}`);
        if (!h.fixtures) failures.push("no canopy.fixtures published for Lighting");
        for (const k of ["minX", "maxX", "minZ", "maxZ"]) {
          if (h.blockerKeys && !h.blockerKeys.includes(k))
            failures.push(`canopy.blockers entries are missing "${k}" — the player will not see them`);
        }
        for (const k of ["colour", "depth", "name", "normal", "position", "width"]) {
          if (h.fixtureKeys && !h.fixtureKeys.includes(k)) failures.push(`CanopyFixtureHandle is missing "${k}"`);
        }
      }

      const rep = await page.evaluate(() => window.__CANOPY ?? null);
      if (rep) console.log(`[shoot5] __CANOPY: ${JSON.stringify(rep, null, 2).replace(/\n/g, "\n           ")}`);
      else failures.push("__CANOPY self-report absent");

      /*
       * Cost, measured rather than estimated.
       *
       * The scene is rendered twice with only `canopy.visible` changed, and
       * `renderer.info` read on both sides. `calls` is the control: hiding a
       * group with eleven meshes in it MUST reduce the draw count, so a zero
       * delta there means the toggle never applied and no other number from
       * this block may be believed.
       */
      cost = await page.evaluate(async () => {
        const g = window.__GAME;
        const r = g.renderer;
        const root = g.scene.getObjectByName("canopy");
        if (!root) return { error: "no object named canopy in the scene graph" };
        const frame = () =>
          new Promise((res) => requestAnimationFrame(() => {
            r.render(g.scene, g.camera);
            res({
              calls: r.info.render.calls,
              triangles: r.info.render.triangles,
              textures: r.info.memory.textures,
              geometries: r.info.memory.geometries,
              programs: r.info.programs?.length ?? null,
            });
          }));
        const on = await frame();
        root.visible = false;
        const off = await frame();
        root.visible = true;
        const back = await frame();
        return { on, off, back };
      });
      if (cost?.error) failures.push(`cost measurement: ${cost.error}`);
      else if (cost) {
        const dCalls = cost.on.calls - cost.off.calls;
        const dTris = cost.on.triangles - cost.off.triangles;
        console.log(
          `[shoot5] measured cost of the canopy in the live frame:\n` +
            `           draw calls  ${cost.off.calls} -> ${cost.on.calls}   (+${dCalls})\n` +
            `           triangles   ${cost.off.triangles} -> ${cost.on.triangles}   (+${dTris})\n` +
            `           textures    ${cost.off.textures} (scene total, unchanged by visibility)\n` +
            `           geometries  ${cost.off.geometries}\n` +
            `           programs    ${cost.on.programs}`
        );
        // The control. Not a nice-to-have.
        if (dCalls <= 0)
          failures.push(
            `the visibility toggle did not apply: draw calls went ${cost.off.calls} -> ${cost.on.calls}. ` +
              `Every cost number above is meaningless.`
          );
        if (cost.back.calls !== cost.on.calls)
          failures.push(`canopy was not restored after the cost probe (${cost.on.calls} -> ${cost.back.calls} calls)`);
      }
    }

    const applied = await page.evaluate((p) => {
      const g = window.__GAME;
      if (!g) return { ok: false, why: "no __GAME" };
      const cam = g.camera;
      const pos = p.pos.slice();
      const look = p.look.slice();
      if (p.eye !== undefined) {
        const gh = g.tryGet ? g.tryGet("groundHeight") : null;
        if (typeof gh !== "function") return { ok: false, why: "no groundHeight service" };
        pos[1] = gh(pos[0], pos[2]) + p.eye;
      }
      cam.position.set(pos[0], pos[1], pos[2]);
      cam.up.set(0, 1, 0);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(look[0], look[1], look[2]);
      cam.fov = p.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return { ok: true, y: pos[1] };
    }, POSES[shot]);

    if (!applied.ok) {
      failures.push(`${shot}: could not apply pose (${applied.why})`);
      await page.close();
      continue;
    }

    // Let the pose settle: the sun shadow frustum refits against the camera
    // every frame, and the canopy is now the largest caster on the site.
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 16 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    const file = await round.save(`${shot}${SUFFIX}`, (dest) => page.screenshot({ path: dest, type: "png" }));
    written.push(file);
    console.log(
      `[shoot5] ${shot.padEnd(12)} -> ${path.relative(ROOT, file)}  eye y=${applied.y.toFixed(2)}  (${Date.now() - t0} ms)`
    );

    const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
    const mine = shaderProblems.filter((p) => MY_SHADER.test(p));
    const foreign = shaderProblems.filter((p) => !MY_SHADER.test(p));
    if (mine.length) failures.push(`${shot}: shader failure -> ${mine[0].slice(0, 400)}`);
    if (foreign.length && !foreignReported) {
      foreignReported = true;
      console.warn(
        `[shoot5] NOTE: another system's shader failed to link. Not fatal here, but it is\n` +
          `         changing the frame. First 300 chars:\n         ${foreign[0].slice(0, 300).replace(/\n/g, "\n         ")}`
      );
    }
    if (problems.length) console.warn(`[shoot5]   page problems: ${problems.length} (first: ${problems[0].slice(0, 200)})`);
    await page.close();
  }

  await context.close();

  const { manifest } = await round.finalise({
    gpu: gpuInfo?.renderer ?? null,
    gpuInfo: gpuInfo ?? null,
    systemErrors: checkedSystemErrors,
    cost,
    keep: 10,
  });
  console.log(
    `\n[shoot5] ${written.length}/${SHOTS.length} screenshots -> ${path.relative(ROOT, round.dir)}\n` +
      `[shoot5] mirrored to ${path.join("shots", SYSTEM)}  round ${round.id}` +
      `  manifest ${manifest ? "written" : "MISSING"}`
  );
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
