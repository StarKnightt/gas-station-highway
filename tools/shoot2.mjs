#!/usr/bin/env node
/**
 * Screenshot harness for System 2 (the store building).
 *
 *   node tools/shoot2.mjs                       # all presets -> shots/system2/
 *   node tools/shoot2.mjs --shots=front,cooler  # subset
 *   node tools/shoot2.mjs --no-build            # reuse the existing dist/
 *   node tools/shoot2.mjs --query=bweather=8    # debug params, for pixel diffs
 *   node tools/shoot2.mjs --suffix=-forced      # write front-forced.png etc.
 *
 * A separate harness from tools/shoot.mjs deliberately: that file and its shot
 * list belong to System 1, it is hard-wired to port 5111, and three other
 * agents are working in this repo right now. This one runs on 5112 and takes
 * its poses from src/gen/buildingShots.ts, which BuildingSystem resolves.
 *
 * Renderer contract (repo-wide): the run must be on the discrete GPU.
 * `--enable-unsafe-swiftshader` is never passed and a software rasteriser is a
 * hard failure - see tools/gpu.mjs.
 *
 * Teardown contract (repo-wide): the vite preview server and the Playwright
 * browser are registered with a single shutdown routine wired to every exit
 * path - normal completion, thrown errors, SIGINT, SIGTERM, uncaughtException
 * and unhandledRejection - BEFORE either is started. Nothing is detached and
 * the process always ends with an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5112;
/**
 * Private build output. Five agents are active in this repo and concurrent
 * rebuilds of the shared `dist/` were the real cause of screenshots that did
 * not match the code that produced them - one agent's build would land between
 * another's build and its capture. Nothing outside this harness touches this
 * directory, so a capture can only ever show System 2's own bundle.
 */
const OUT_DIR = path.join(".shot-build", "system2");
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system2");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");

const ALL_SHOTS = ["front", "door", "interior", "cooler", "corner", "wall", "base", "bottle"];
const SHOTS = ONLY.length ? ALL_SHOTS.filter((s) => ONLY.includes(s)) : ALL_SHOTS;

/**
 * Per-pose frame health, checked on every capture before the round is handed to
 * anyone.
 *
 * Three separate failures argue for this. Two rounds came back entirely black
 * and the harness reported them as successes, because nothing looked at the
 * pixels. A critic's worst finding in the round before that was a band of
 * hard-edged pure-black rectangles in the glazing, which any near-black count
 * would have flagged instantly. And a third capture was returned as unusable
 * for the opposite reason - a crushed base band - which is the same axis at the
 * other end.
 *
 * `sky` is declared per pose rather than inferred, because the `interior`,
 * `cooler` and `base` poses legitimately have no sky in frame and a check that
 * cannot express that either fails them forever or is turned off. It is also
 * not sufficient on its own: the vegetation agent's poisoned frame passed a
 * sky-mean check at 126.1, since the sky dome is not a `MeshStandardMaterial`
 * and survives whatever kills everything else. The lower third and the
 * near-black fraction are the load-bearing tests.
 */
const HEALTH = {
  front: { sky: true, lowerThirdMin: 12, maxNearBlack: 0.02 },
  door: { sky: false, lowerThirdMin: 10, maxNearBlack: 0.03 },
  interior: { sky: false, lowerThirdMin: 8, maxNearBlack: 0.02 },
  cooler: { sky: false, lowerThirdMin: 8, maxNearBlack: 0.02 },
  corner: { sky: true, lowerThirdMin: 12, maxNearBlack: 0.02 },
  wall: { sky: false, lowerThirdMin: 14, maxNearBlack: 0.02 },
  base: { sky: false, lowerThirdMin: 14, maxNearBlack: 0.02 },
  /**
   * The bottle sits inside a lit merchandiser and fills most of the frame, so
   * the lower third is bright and near-black is the load-bearing test: a
   * transmissive leaf sampling an uninitialised transmission target comes out
   * exactly black, which is the failure this system has already had once, and at
   * this framing it would cover a third of the picture.
   */
  bottle: { sky: false, lowerThirdMin: 20, maxNearBlack: 0.01 },
};

async function frameHealth(file, shot) {
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(await fs.readFile(file));
  const spec = HEALTH[shot] ?? { sky: false, lowerThirdMin: 8, maxNearBlack: 0.03 };
  const lum = (i) => 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];

  let nearBlack = 0;
  let lower = 0;
  let lowerN = 0;
  let skySum = 0;
  let skyN = 0;
  const y0 = Math.floor(png.height * (2 / 3));
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const l = lum((y * png.width + x) * 4);
      if (l < 4) nearBlack++;
      if (y >= y0) {
        lower += l;
        lowerN++;
      }
      if (y < png.height * 0.12) {
        skySum += l;
        skyN++;
      }
    }
  }
  const out = {
    nearBlack: nearBlack / (png.width * png.height),
    lowerThird: lower / lowerN,
    sky: skyN ? skySum / skyN : null,
  };
  const fails = [];
  if (out.nearBlack > spec.maxNearBlack) {
    fails.push(
      `${(out.nearBlack * 100).toFixed(2)}% of the frame is near-black (limit ${(spec.maxNearBlack * 100).toFixed(0)}%)`
    );
  }
  if (out.lowerThird < spec.lowerThirdMin) {
    fails.push(`lower third mean luma ${out.lowerThird.toFixed(1)} below floor ${spec.lowerThirdMin}`);
  }
  if (spec.sky && out.sky !== null && out.sky < 40) {
    fails.push(`sky band mean luma ${out.sky.toFixed(1)} below 40`);
  }
  return { ...out, fails };
}

/**
 * A shader that fails to link still renders a frame, and `tsc` stays green, so
 * the only thing standing between a dead shader and a plausible-looking
 * screenshot is this check. That has now failed three times on this project
 * (NOTES.md case 4), most recently on `void(x)` - not valid GLSL - which
 * produced forced-value diffs of exactly zero changed pixels.
 */
const FATAL_CONSOLE = /shader|program|glsl|link|compile/i;

/**
 * three dumps the entire numbered shader source into one console error, so the
 * one line that matters is buried in two thousand. Pull it out.
 */
const GLSL_ERROR = /ERROR:\s*\d+:\d+:[^\n]*/g;

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

/**
 * The open archive round, and everything finalise() needs. Held at module
 * scope so shutdown() can close the round on *every* exit path - a run that
 * failed is exactly the run somebody will want to read later, and the manifest
 * is the only record of __SYSTEM_ERRORS at capture time.
 */
const roundState = { round: null, gpu: null, systemErrors: null, cost: null, finalised: false };

async function finaliseRound() {
  if (!roundState.round || roundState.finalised) return;
  roundState.finalised = true;
  try {
    await roundState.round.finalise({
      gpu: roundState.gpu,
      systemErrors: roundState.systemErrors,
      // Kept with the round rather than only printed: a draw-call count is
      // only useful against the previous round's, and the log scrolls away.
      cost: roundState.cost,
      keep: 10,
    });
    console.log(`[shoot2] round ${roundState.round.id} -> ${path.relative(ROOT, roundState.round.dir)}`);
  } catch (err) {
    console.error(`[shoot2] could not finalise round: ${err?.message ?? err}`);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[shoot2] shutting down: ${reason}`);

  await finaliseRound();

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
      console.error(`[shoot2] failed to close ${label}: ${err?.message ?? err}`);
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
    /* best effort only */
  }
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[shoot2] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }

  console.log(`[shoot2] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  // Identify the exact bundle being served. Vite puts a content hash in the
  // filename, so the hash alone proves whether a capture reflects the current
  // source; the mtime catches the case where the hash happens to be unchanged.
  const assetsDir = path.join(ROOT, OUT_DIR, "assets");
  let newest = 0;
  let bundle = "(none)";
  for (const f of await fs.readdir(assetsDir).catch(() => [])) {
    if (!f.endsWith(".js")) continue;
    const st = await fs.stat(path.join(assetsDir, f));
    if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
      bundle = f;
    }
  }
  const stamp = `${bundle} @ ${new Date(newest).toISOString()}`;
  console.log(`[shoot2] serving ${OUT_DIR}/assets/${bundle}  mtime ${new Date(newest).toISOString()}`);
  // Vite already puts a content hash in the filename, so that is the bundle
  // identity the archive round is keyed by - no need to re-hash the file.
  const bundleHash = (bundle.match(/-([A-Za-z0-9_-]{6,})\.js$/)?.[1] ?? "nohash").slice(0, 12);

  console.log("[shoot2] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: false }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shoot2", allowSoftware: false });
  await gpuPage.close();
  roundState.gpu = gpuInfo?.renderer ?? gpuInfo?.unmaskedRenderer ?? null;

  const outDir = path.join(ROOT, "shots", SYSTEM);
  await fs.mkdir(outDir, { recursive: true });

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    bundleHash,
    bundleMtime: new Date(newest).toISOString(),
    tag: "shoot2",
    extra: { query: QUERY || null, suffix: SUFFIX || null, shots: SHOTS.slice() },
  });
  roundState.round = round;
  // [] means "asked, and every system initialised"; null means "never asked".
  // The distinction is the whole point of recording it (NOTES.md case 8).
  roundState.systemErrors = [];
  console.log(`[shoot2] round ${round.id}`);

  const written = [];
  const fatal = [];
  for (const shot of SHOTS) {
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const url = `${base}?shot=${encodeURIComponent(shot)}${QUERY ? `&${QUERY}` : ""}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch (err) {
      // A scene that never signals ready is nearly always a shader that failed
      // to link or an exception during init, and the message is sitting in the
      // page console. Losing it to the timeout costs a whole capture cycle.
      console.error(`[shoot2] ${shot}: never became ready. Page console:`);
      for (const p of problems.slice(0, 20)) console.error(`    ${p}`);
      throw err;
    }
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 10 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    /**
     * Render cost, per pose, measured rather than reasoned about.
     *
     * Draw calls come from `renderer.info.render`, which counts the frame that
     * has just been drawn — including the shadow passes, which is why it is
     * read after the ten warm-up frames rather than before them.
     *
     * Texture bytes are counted by walking the scene for unique `THREE.Texture`
     * objects, because `info.memory.textures` is a *count* and a count says
     * nothing: one 2048 sheet costs sixteen 512s. Every map is 8-bit RGBA on
     * upload, and mipmapping adds a third, so `w * h * 4 * 4/3` is the figure
     * the driver actually allocates. Attribution is by which group the mesh
     * hangs under, so this system's share is separable from the rest.
     */
    const cost = await page.evaluate(() => {
      const g = window.__GAME;
      if (!g) return null;
      const seen = new Map();
      const bytesOf = (t) => {
        const im = t.image ?? {};
        const w = im.width ?? t.source?.data?.width ?? 0;
        const h = im.height ?? t.source?.data?.height ?? 0;
        if (!w || !h) return 0;
        const faces = t.isCubeTexture ? 6 : 1;
        return Math.round(w * h * 4 * faces * (t.generateMipmaps === false ? 1 : 4 / 3));
      };
      const owner = (o) => {
        let n = o;
        while (n) {
          if (n.parent === g.scene) return n.name || "(unnamed group)";
          n = n.parent;
        }
        return "(detached)";
      };
      g.scene.traverse((o) => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) {
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (!v || !v.isTexture) continue;
            const hit = seen.get(v.uuid);
            if (hit) {
              // Counted once, however many materials point at it. Reusing an
              // atlas is the difference between a new map costing megabytes
              // and costing nothing, and this is where that shows.
              hit.refs.add(`${m.uuid}:${k}`);
            } else {
              const im = v.image ?? {};
              seen.set(v.uuid, {
                bytes: bytesOf(v),
                owner: owner(o),
                dim: `${im.width ?? 0}x${im.height ?? 0}`,
                refs: new Set([`${m.uuid}:${k}`]),
              });
            }
          }
        }
      });
      const byOwner = {};
      let total = 0;
      const big = [];
      for (const t of seen.values()) {
        byOwner[t.owner] = (byOwner[t.owner] ?? 0) + t.bytes;
        total += t.bytes;
        big.push({ owner: t.owner, dim: t.dim, bytes: t.bytes, refs: t.refs.size });
      }
      big.sort((a, b) => b.bytes - a.bytes);
      return {
        calls: g.renderer.info.render.calls,
        triangles: g.renderer.info.render.triangles,
        programs: g.renderer.info.programs?.length ?? 0,
        textureCount: seen.size,
        textureBytes: total,
        byOwner,
        largest: big.slice(0, 12),
      };
    });
    if (cost) {
      const mb = (b) => (b / 1048576).toFixed(2);
      const mine = Object.entries(cost.byOwner)
        .filter(([k]) => /building/i.test(k))
        .reduce((s, [, v]) => s + v, 0);
      console.log(
        `[shoot2]   cost: ${cost.calls} draw calls  ${(cost.triangles / 1000).toFixed(0)}k tris  ` +
          `${cost.programs} programs  ${cost.textureCount} textures ${mb(cost.textureBytes)} MB ` +
          `(building ${mb(mine)} MB)`
      );
      (roundState.cost ??= {})[shot] = cost;
    }

    // Archive path, with a copy at shots/<system>/<shot>.png. Log the archive
    // one: per NOTES.md case 13, that is the copy still readable next week and
    // the only one stamped with the bundle that produced it.
    const file = await round.save(`${shot}${SUFFIX}`, (dest) => page.screenshot({ path: dest, type: "png" }));
    written.push(file);
    const health = await frameHealth(file, shot);
    console.log(
      `[shoot2] ${shot.padEnd(9)} -> ${path.relative(ROOT, file)}  (${Date.now() - t0} ms)  bundle ${stamp}\n` +
        `[shoot2]   health: near-black ${(health.nearBlack * 100).toFixed(2)}%  ` +
        `lower-third ${health.lowerThird.toFixed(1)}  ` +
        `sky ${health.sky === null ? "n/a" : health.sky.toFixed(1)}`
    );
    for (const f of health.fails) {
      console.error(`[shoot2]   HEALTH ${shot}: ${f}`);
      fatal.push(`${shot}: frame health - ${f}`);
    }
    // Game.ts disables a system whose init threw and carries on to
    // __SCENE_READY, so a broken BuildingSystem now fails quietly. This array
    // is the only thing that says so.
    const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    roundState.systemErrors = [...(roundState.systemErrors ?? []), ...sysErrors.map((e) => ({ shot, ...e }))];
    for (const e of sysErrors) {
      fatal.push(`${shot}: system '${e.system}' failed in ${e.phase}: ${e.message}`);
    }

    // The GLSL error line first, on its own, because it is the actionable part.
    const glsl = new Set();
    for (const p of problems) for (const m of p.match(GLSL_ERROR) ?? []) glsl.add(m.trim());
    for (const m of glsl) {
      console.error(`[shoot2]   GLSL ${m}`);
      fatal.push(`${shot}: GLSL ${m}`);
    }
    if (problems.length) {
      // Truncate each message, not the list: a dropped message is a dropped
      // failure, whereas three's 2000-line shader dumps carry no extra signal.
      const seen = new Set(problems.map((p) => p.slice(0, 160)));
      console.warn(`[shoot2]   page problems:\n    ${[...seen].join("\n    ")}`);
      for (const p of problems) if (FATAL_CONSOLE.test(p) && !glsl.size) fatal.push(`${shot}: ${p.slice(0, 160)}`);
    }
    await page.close();
  }

  await context.close();

  console.log(`\n[shoot2] ${written.length}/${SHOTS.length} screenshots -> ${path.join("shots", SYSTEM)}`);
  const missing = SHOTS.filter((s) => !written.some((w) => w.endsWith(`${s}${SUFFIX}.png`)));
  const bad = [...new Set([...missing.map((m) => `missing: ${m}`), ...fatal])];

  // A status file as well as the exit code. Every capture in this project gets
  // run through a `| grep` to keep the log readable, and a pipeline reports
  // grep's exit status, not the harness's - which is exactly how a hard failure
  // went unnoticed for two cycles. This file cannot be masked that way.
  const statusFile = path.join(ROOT, "shots", SYSTEM, "STATUS.txt");
  await fs.writeFile(
    statusFile,
    `${bad.length ? "FAIL" : "OK"}  ${new Date().toISOString()}  bundle ${stamp}\n${bad.map((b) => `  ${b}\n`).join("")}`
  );
  if (bad.length) {
    console.error(`\n[shoot2] ##### FAIL ##### ${bad.length} problem(s); screenshots above are NOT trustworthy:`);
    for (const b of bad) console.error(`[shoot2]   ${b}`);
  }
  await shutdown(bad.length ? 1 : 0, bad.length ? `${bad.length} fatal problem(s), see STATUS.txt` : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
