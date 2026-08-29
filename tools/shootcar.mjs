#!/usr/bin/env node
/**
 * Screenshot harness for the parked car.
 *
 *   node tools/shootcar.mjs                       # all presets -> shots/car/
 *   node tools/shootcar.mjs --shots=side
 *   node tools/shootcar.mjs --no-build            # reuse the existing dist/
 *   node tools/shootcar.mjs --query=force=grime --suffix=_forced
 *
 * Port 5116 so it runs beside the other four harnesses.
 *
 * Poses are expressed in CAR-LOCAL metres (+Z nose, +X the car's left, y=0 on
 * the ground under the tyres) and pushed through the car root's world matrix
 * that the page hands back. That means a pose keeps framing the car even if the
 * stall placement or the site height field moves under it, which has already
 * happened once in this project.
 *
 * Teardown contract: the preview server and the browser are registered with one
 * shutdown routine wired to normal completion, thrown errors, SIGINT, SIGTERM,
 * uncaughtException and unhandledRejection BEFORE either is started. Nothing is
 * detached and the process always ends in an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5116;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 240_000;
/** Own build directory, so a concurrent agent's `vite build` into dist/ cannot
 *  swap the bundle out from under a capture that is already running. */
const BUILD_DIR = ".shot-build/car";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = arg("out", "car");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/**
 * `local` poses are in car space and get transformed by the car's world matrix.
 * `world` poses are absolute, with `eye` metres above the walkable surface.
 *
 * `side` is deliberately a long lens from 12 m out: a wide lens from close up
 * adds its own perspective distortion to the profile, and the profile is the
 * one view where a proportion error cannot hide.
 */
const POSES = {
  three_quarter_front: { local: true, pos: [2.75, 1.32, 4.85], look: [0, 0.7, 0.3], fov: 40 },
  // Pure profile, from the car's RIGHT side. Local +X is the car's left, which
  // under the stall yaw of PI + 0.052 maps to world -X and puts the camera
  // inside the store building - that is what made the first side capture 80%
  // wall. Local -X maps to world +X, out across the lot, with PAD.maxX = 26 at
  // roughly 11.9 m of clearance.
  side: { local: true, pos: [-11.5, 0.8, 0.02], look: [0, 0.78, 0.02], fov: 25 },
  three_quarter_rear: { local: true, pos: [2.95, 1.42, -4.95], look: [0, 0.68, -0.45], fov: 40 },
  wheel_close: { local: true, pos: [-2.05, 0.62, 2.6], look: [-0.8, 0.36, 1.36], fov: 38 },
  in_scene: { world: true, pos: [6.2, 0, 28.6], eye: 1.63, look: [11.6, 0.85, 34.2], fov: 50 },

  // The SUNLIT flank, which `side` is not.
  //
  // The sun is at azimuth 203 degrees, so it lies toward world -X-Z; the car's
  // yaw of PI + 0.052 maps local +X onto world -X, which makes local +X the lit
  // side and local -X - where `side` shoots from - the shaded one. The first
  // round of this came back with the entire near flank in shadow, so the
  // crease, the weathering and the paint colour were all unjudgeable in the
  // views that exist to judge them.
  //
  // Not a mirrored `side`: local +X at 11.5 m puts the camera inside the store,
  // which is the same trap that made the first `side` capture 80% wall. Held to
  // 5.4 m on a longer lens and swung slightly forward, which keeps it in open
  // lot (world x ~6.4, near where `in_scene` stands) and rakes the low sun
  // along the flank rather than flattening it head-on.
  side_sun: { local: true, pos: [5.4, 1.0, 1.65], look: [0, 0.74, -0.35], fov: 32 },

  // The nose, close. The front fascia came back looking torn across the grille
  // and it cannot be resolved at three-quarter distance.
  nose_close: { local: true, pos: [1.25, 0.88, 4.15], look: [0.05, 0.72, 2.2], fov: 34 },

  // THE ONLY POSE THAT MATCHES THE DELIVERABLE, and it was missing.
  //
  // Every pose above is a car PORTRAIT: close, on a long lens, framed to fill.
  // The deliverable is a 15-20 second walk through the scene, where the car is a
  // hero object glanced at from walking distance - so every judgement made so far
  // has been made on a frame no viewer will ever see. A defect that dominates at
  // 34 mm and 1.2 m may be invisible here, and a proportion that reads at
  // three-quarter distance may not.
  //
  // Eye height 1.65 m, 8.8 m back, and a 40 degree field which is roughly what a
  // person or a phone sees rather than a flattering telephoto. Local, so it
  // follows the car if the parking spot moves.
  walk_by: { local: true, pos: [7.5, 1.65, 4.5], look: [0, 0.75, 0], fov: 40 },
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
  if (reason) console.error(`\n[shootcar] shutting down: ${reason}`);
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
      console.error(`[shootcar] failed to close ${label}: ${err?.message ?? err}`);
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

/** Resolves once nothing is listening on `port`, or throws after `budgetMs`. */
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
      if (announced) console.log(`[shootcar] :${port} free after ${((Date.now() - t0) / 1000) | 0}s`);
      return;
    }
    if (Date.now() - t0 > budgetMs) throw new Error(`port ${port} still busy after ${budgetMs} ms`);
    if (!announced) {
      announced = true;
      console.log(`[shootcar] :${port} is busy (another agent's tool); waiting up to ${budgetMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Anything matching this in the console means a program never linked. */
const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;

/**
 * Shader-injection prefixes owned by other systems. A link failure carrying one
 * of these is somebody else's bug: it still gets printed loudly, because a dead
 * program anywhere changes what the frame looks like, but it does not fail this
 * harness, or a neighbouring agent's in-flight edit blocks every car capture.
 * Anything NOT matching is treated as ours and is fatal.
 */
const FOREIGN_SHADER = /vBw|uBc|bcCoursing|uTr|vTr|uPd|uSky|offDir|uMinPixels|metresPerPixel/;

/**
 * The car has no raw ShaderMaterial: every car material is a Mesh*Material with
 * an onBeforeCompile patch, so Three reports its type as MeshStandardMaterial or
 * MeshPhysicalMaterial. A shader error naming `ShaderMaterial` therefore cannot
 * be ours, whatever uniforms it happens to mention.
 *
 * Worth having as well as the name list above, which is an allowlist and so
 * fails open: the vegetation billboard shader broke on `float half` - `half` is
 * reserved in GLSL ES - and because none of its identifiers were listed, this
 * harness reported another agent's in-flight bug as five car shader failures
 * and failed a run that was otherwise green.
 */
const FOREIGN_MATERIAL = /Material Type:\s*(Raw)?ShaderMaterial/;

/**
 * Newest mtime AND a content hash of the private build directory.
 *
 * Both, not just the mtime: four agents are active, and a concurrent `vite
 * build` into the shared dist/ was the real cause of a round of review being
 * done on screenshots of code that had already been replaced. Building into
 * `.shot-build/car/` stops the collision; printing the hash on every captured
 * line proves after the fact which bytes were actually on screen.
 */
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
    console.log("[shootcar] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shootcar] bundle: ${stamp.text}`);

  // Port 5116 is this harness's assigned port, but tools/lightProbe.mjs also
  // binds it, and killing another agent's capture mid-run would be worse than
  // waiting. Poll until it frees rather than dying on first contact.
  await waitForPort(PORT, 240_000);

  console.log(`[shootcar] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shootcar] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shootcar", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const outDir = path.join(ROOT, "shots", OUT);
  await fs.mkdir(outDir, { recursive: true });

  // Every round used to overwrite shots/car/*.png in place, so two critics
  // scored two different cars through identical filenames and the difference
  // read as the critics disagreeing rather than as the car changing. The round
  // archive keeps each set under its own bundle hash and timestamp and still
  // mirrors to the stable paths the critic prompts use.
  const round = await openRound({
    root: ROOT,
    system: OUT,
    bundleHash: stamp.hash,
    bundleMtime: stamp.iso,
    tag: "shootcar",
    extra: { presets: SHOTS, suffix: SUFFIX || null },
  });

  const written = [];
  const failures = [];
  let reportedHandle = false;
  let foreignReported = false;
  // null until a page has actually been interrogated. See the note at finalise.
  let checkedSystemErrors = null;

  for (const shot of SHOTS) {
    const pose = POSES[shot];
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || SHADER_FAIL.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    // `shot=car` is not a preset any system claims, so the player controller
    // leaves itself disabled and the camera below survives to the render.
    const parts = ["shot=car", "gpu=1"];
    if (QUERY) parts.push(QUERY);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    // A page that renders is not the same as a page that is healthy. Game
    // catches per-system init failures so one broken system cannot blank the
    // scene, which means the car could be missing entirely and the capture
    // would still look plausible. Assert on the record instead.
    const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    // Recorded for the manifest, which distinguishes "checked and clean" from
    // "never checked". Assigning here rather than at the declaration is what
    // makes null mean the former could not have happened.
    checkedSystemErrors = sysErrs;
    if (sysErrs.length) {
      for (const e of sysErrs) console.error(`[shootcar] system ${e.system} failed in ${e.phase}: ${e.message}`);
      failures.push(`${sysErrs.length} system(s) failed to initialise: ${sysErrs.map((e) => e.system).join(", ")}`);
    }

    // The environment is a shared resource that this system does not own and
    // cannot see failing. A NaN anywhere in the PMREM poisons every
    // MeshStandardMaterial that samples it, and the result is a black or
    // silhouetted frame with an empty `__SYSTEM_ERRORS` - the building agent
    // lost two rounds to it and the pumps agent one, each time investigating
    // their own system first. A round that silently renders black is worse than
    // one that fails loudly, so check the texels before spending the capture.
    const envHealth = await page.evaluate(() => {
      const g = window.__GAME;
      const env = g?.scene?.environment;
      if (!env) return { ok: false, why: "scene.environment is null" };
      const renderer = g.renderer;
      const gl = renderer.getContext();
      const tex = renderer.properties.get(env)?.__webglTexture;
      if (!tex) return { ok: false, why: "environment has no GPU texture" };
      const W = Math.min(256, env.image?.width ?? 256);
      const H = Math.min(256, env.image?.height ?? 256);
      const fb = gl.createFramebuffer();
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
        gl.deleteFramebuffer(fb);
        return { ok: false, why: "environment framebuffer incomplete" };
      }
      const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
      const buf = type === gl.FLOAT ? new Float32Array(W * H * 4) : new Uint16Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, type, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
      gl.deleteFramebuffer(fb);
      const h2f = (h) => {
        const s = (h & 0x8000) >> 15;
        const e = (h & 0x7c00) >> 10;
        const f = h & 0x03ff;
        if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
        if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
        return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
      };
      const val = type === gl.FLOAT ? (i) => buf[i] : (i) => h2f(buf[i]);
      let bad = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < W * H; i++) {
        for (let c = 0; c < 3; c++) {
          const v = val(i * 4 + c);
          if (!Number.isFinite(v)) bad++;
          else {
            sum += v;
            n++;
          }
        }
      }
      return { ok: bad === 0, bad, mean: n ? sum / n : 0, sampled: W * H };
    });
    if (!envHealth.ok) {
      failures.push(
        `environment is not safe to capture against: ${envHealth.why ?? `${envHealth.bad} non-finite texels`}. ` +
          `NaN in the PMREM poisons every standard material and renders black or silhouetted with an empty ` +
          `__SYSTEM_ERRORS. This is Lighting's, not the car's — check lightSky.ts / LightingSystem.ts mtimes.`
      );
    } else {
      console.log(`[shootcar] environment healthy: ${envHealth.sampled} texels, mean ${envHealth.mean.toFixed(4)}`);
    }

    if (!reportedHandle) {
      reportedHandle = true;
      const h = await page.evaluate(() => {
        const g = window.__GAME;
        const c = g?.tryGet ? g.tryGet("car.parked") : null;
        const list = g?.tryGet ? g.tryGet("cars") : null;
        if (!c) return null;
        let tris = 0;
        let meshes = 0;
        c.root.traverse((o) => {
          if (o.isMesh && o.geometry) {
            meshes++;
            const g2 = o.geometry;
            tris += g2.index ? g2.index.count / 3 : g2.attributes.position.count / 3;
          }
        });
        return {
          keys: Object.keys(c).sort(),
          name: c.name,
          size: c.size,
          heading: c.heading,
          position: c.position,
          pickables: Array.isArray(c.pickables) ? c.pickables.length : null,
          setPaint: typeof c.setPaint,
          carsIsArray: Array.isArray(list),
          carsLen: Array.isArray(list) ? list.length : null,
          carsSame: Array.isArray(list) ? list[0] === c : null,
          meshes,
          tris: Math.round(tris),
        };
      });
      console.log(`[shootcar] car.parked: ${JSON.stringify(h)}`);
      if (!h) failures.push('service "car.parked" was never provided');
      else {
        for (const k of ["name", "root", "position", "heading", "size", "pickables", "setPaint"]) {
          if (!h.keys.includes(k)) failures.push(`car.parked is missing "${k}"`);
        }
        if (!h.carsIsArray || !h.carsSame) failures.push(`"cars" is not [car.parked]: ${JSON.stringify(h)}`);
      }

      // Numbers the eye cannot check: patch partition, crease count, arch gap,
      // winding. NOTES.md is six entries of "it looked plausible and was wrong",
      // so the build publishes what it actually made and the harness prints it.
      const rep = await page.evaluate(() => window.__CAR ?? null);
      if (rep) console.log(`[shootcar] __CAR: ${JSON.stringify(rep, null, 2).replace(/\n/g, "\n           ")}`);
      else console.warn("[shootcar] __CAR report absent");
      if (rep && rep.windingOutward === false) failures.push(`body winding is INWARD: ${JSON.stringify(rep.winding)}`);

      // Surface-projection fallbacks. A non-zero count means parts were laid on
      // a substituted flat plane instead of the real fascia or flank, which
      // shows up as noise or tearing on the panel rather than as anything
      // obviously missing - NOTES.md case 14 cost two critic passes to find at
      // 39%. Fail before spending a capture and a review on it.
      if (rep && rep.fallbacks) {
        const fb = rep.fallbacks;
        const total = Object.values(fb).reduce((a, b) => a + b, 0);
        if (total > 0) {
          failures.push(
            `${total} surface-projection fallback(s) during build: ${JSON.stringify(fb)} — ` +
              `parts are on a substituted plane, not the real surface. ` +
              `Run tools/carburied.mjs to see which.`
          );
        }
      } else if (rep) {
        console.warn("[shootcar] __CAR.fallbacks absent — projection counters not reported");
      }
    }

    const applied = await page.evaluate((p) => {
      const g = window.__GAME;
      if (!g) return { ok: false, why: "no __GAME" };
      const cam = g.camera;
      let pos = p.pos.slice();
      let look = p.look.slice();

      if (p.local) {
        const car = g.tryGet ? g.tryGet("car.parked") : null;
        if (!car) return { ok: false, why: "no car.parked" };
        car.root.updateMatrixWorld(true);
        const e = car.root.matrixWorld.elements;
        const tp = (v) => [
          e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12],
          e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13],
          e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14],
        ];
        pos = tp(pos);
        look = tp(look);
      } else if (p.eye !== undefined) {
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
      return { ok: true, pos, look };
    }, pose);

    if (!applied.ok) {
      failures.push(`${shot}: could not apply pose (${applied.why})`);
      await page.close();
      continue;
    }

    // Let the pose settle for a few frames before grabbing: anything that
    // refits against the camera each frame (shadow frusta, LOD) needs at least
    // one full update or the depth pass disagrees with the colour pass.
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
    const at = applied.pos.map((v) => v.toFixed(2)).join(",");
    console.log(
      `[shootcar] ${shot.padEnd(20)} -> ${path.relative(ROOT, file)}  cam=(${at})  ` +
        `(${Date.now() - t0} ms)  bundle ${stamp.iso} sha1:${stamp.hash}`
    );

    const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
    const isForeign = (p) => FOREIGN_SHADER.test(p) || FOREIGN_MATERIAL.test(p);
    const mine = shaderProblems.filter((p) => !isForeign(p));
    const foreign = shaderProblems.filter(isForeign);
    if (mine.length) failures.push(`${shot}: shader failure -> ${mine[0].slice(0, 400)}`);
    if (foreign.length && !foreignReported) {
      foreignReported = true;
      console.warn(
        `[shootcar] NOTE: another system's shader failed to link. Not fatal here, but it is\n` +
          `           changing the frame. First 300 chars:\n           ${foreign[0].slice(0, 300).replace(/\n/g, "\n           ")}`
      );
    }
    if (problems.length) console.warn(`[shootcar]   page problems: ${problems.length} (first: ${problems[0].slice(0, 160)})`);
    await page.close();
  }

  await context.close();

  // `systemErrors` is deliberately null-or-array: null records "this harness
  // never looked", which is a different and much worse state than [] meaning
  // "looked, and the scene was healthy". A manifest that cannot tell those
  // apart is how a broken system hides in a plausible-looking capture.
  const { manifest } = await round.finalise({
    gpu: gpuInfo,
    systemErrors: checkedSystemErrors,
    keep: 10,
  });
  console.log(
    `\n[shootcar] ${written.length}/${SHOTS.length} screenshots -> ${path.relative(ROOT, round.dir)}\n` +
      `[shootcar] mirrored to ${path.join("shots", OUT)}  round ${round.id}` +
      `  manifest ${manifest ? "written" : "MISSING"}`
  );
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
