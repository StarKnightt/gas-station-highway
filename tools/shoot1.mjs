#!/usr/bin/env node
/**
 * Screenshot harness for System 1 (terrain, road, lot, soil, wet surfaces).
 *
 *   node tools/shoot1.mjs                                # every pose
 *   node tools/shoot1.mjs --shots=verge,puddle
 *   node tools/shoot1.mjs --no-build --query=tforce=nowet --suffix=_nowet
 *
 * Port 5131 and a private build directory `.shot-build/terrain/`. Ports 5112,
 * 5113, 5116 and 5119 belong to other agents and `dist/` is shared by all of
 * them, so a capture pointed at either photographs somebody else's bundle.
 *
 * Hard failures, all after full teardown:
 *   - a software rasteriser (never pass --enable-unsafe-swiftshader)
 *   - any shader compile or link error in the console; GLSL has no static
 *     checking anywhere in this project, so the driver is the only checker
 *   - a non-empty window.__SYSTEM_ERRORS
 *   - a frame that fails the content check below
 *   - the bundle moving underneath the run
 *
 * Teardown contract: SIGINT / SIGTERM / uncaughtException / unhandledRejection
 * are installed BEFORE the preview server or the browser starts, both are
 * closed on every exit path, and the process always ends in process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import { assertHardwareGpu, assertSceneGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "terrain");
const PORT = 5131;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 240_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system1");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/**
 * Reject any flag this harness does not implement.
 *
 * `arg()` matches on the literal prefix `--name=`, so a flag passed in any other
 * form silently returns its fallback. That is not a typo guard: two forms of the
 * same mistake cost real time in one round. `--shots walk_store` with a space
 * captured all ten poses instead of two, and `--force=nowet` — a plausible name
 * for a flag that is actually spelt `--query=tforce=nowet` — produced a round
 * that was byte-for-byte the default and was about to be read as a control arm
 * showing the feature doing nothing.
 *
 * That second one is the dangerous one, and it is NOTES.md 43 in a new costume:
 * a control that cannot fail certifies whatever it is pointed at. The value
 * `nowet` was spelt correctly and the flag name was wrong, so the existing
 * unknown-pose check could not see it.
 */
{
  const KNOWN_VALUE = ["system", "query", "suffix", "shots"];
  const KNOWN_BARE = ["no-build", "allow-software"];
  const bad = argv.filter((a) => {
    if (!a.startsWith("--")) return true;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq < 0) return !KNOWN_BARE.includes(body);
    return !KNOWN_VALUE.includes(body.slice(0, eq));
  });
  if (bad.length) {
    console.error(`[shoot1] unrecognised argument(s): ${bad.join(" ")}`);
    console.error(`[shoot1] flags taking a value (require '='): ${KNOWN_VALUE.map((k) => `--${k}=`).join(" ")}`);
    console.error(`[shoot1] flags taking none: ${KNOWN_BARE.map((k) => `--${k}`).join(" ")}`);
    console.error(`[shoot1] to force a control arm use --query=tforce=<token> --suffix=_<token>`);
    process.exit(2);
  }
}

/**
 * `eye` is metres above the walkable surface at the camera's XZ.
 *
 * The sun is at azimuth 203.4 degrees and about 6 degrees of elevation, so the
 * direction *to* it is roughly (-0.91, +0.11, -0.39): it lies toward -X-Z and
 * every shadow is thrown toward +X+Z. `puddle` and `ground` both look back
 * along that bearing, which is the only geometry in which a horizontal wet
 * surface can return a specular streak to the lens.
 */
const POSES = {
  // The critics' familiar framing, kept so scores are comparable across rounds.
  approach: { pos: [-30.0, 0, -7.6], eye: 1.65, look: [-1.0, 1.6, 20.0], fov: 46 },
  lot: { pos: [19.0, 0, 36.4], eye: 1.65, look: [-2.0, 1.2, 18.0], fov: 52 },
  ground: { pos: [21.5, 0, 38.6], eye: 0.42, look: [-9.0, 3.4, 13.0], fov: 56 },
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },

  // Open ground with nothing built on it, looking along the highway swale.
  // This is the pose the "bare graded dirt to the horizon" complaint is about,
  // and the only one where the soil has to carry the frame by itself.
  verge: { pos: [-74.0, 0, 9.4], eye: 1.35, look: [64.0, 1.2, 11.0], fov: 46 },

  // Low over the driveway low spot at (12.5, 10.4), placed on the reciprocal
  // of the sun bearing so the standing water can mirror the sky and the sun.
  puddle: { pos: [25.3, 0, 15.9], eye: 0.55, look: [12.5, 0.02, 10.4], fov: 44 },

  // Standing on the forecourt looking across the lot low spot at (-19.6, 10.6)
  // toward the light, for the wet/dry fringe at a human eye height.
  fringe: { pos: [-6.4, 0, 15.1], eye: 1.6, look: [-21.0, 0.1, 9.8], fov: 40 },

  // The margin at reading distance. `fringe` and `puddle` are both grazing
  // views from twelve to fifteen metres, where the whole wet region collapses
  // into a band forty pixels tall against the horizon: fine for asking whether
  // water is present, useless for asking whether its edge is any good, which
  // is the actual deliverable. This one stands four metres off the near rim of
  // the largest low spot, at (22.6, 38.2), still on the reciprocal of the sun
  // bearing, and looks down into it. The near shoreline crosses the lower half
  // of the frame at roughly a centimetre per pixel.
  // Of the four low spots only 12.5/10.4 can be shot close and into the light
  // from inside the lot: 22.6/38.2 is hard against PAD.maxZ so every camera
  // behind it stands in the scrub, and -3.5/31.6 is under the store's front
  // wall. Same spot `puddle` looks at, at six metres instead of fourteen.
  rim: { pos: [17.6, 0, 14.6], eye: 1.25, look: [12.8, -0.03, 10.7], fov: 40 },

  /**
   * Two walking poses, added because every pose above is a framed portrait and
   * the deliverable is an 18-second walk.
   *
   * All nine earlier poses either stand still and compose, or drop to 0.42-1.25 m
   * to inspect a specific feature at a chosen angle. None of them is the view the
   * film spends its time in: eye height, ordinary field of view, looking along
   * the direction of travel, with the ground occupying the bottom third of the
   * frame at a grazing angle. **A grazing view of wet asphalt at a low sun is a
   * different problem from a near-vertical one** — it is where the Fresnel ramp,
   * the skylight sheen and the wet/dry boundary either read or do not, and none
   * of the poses above ask that question.
   *
   * These two are a deliberate pair rather than two samples, because the whole
   * point of a wet surface is that it is not symmetric about the light. The sun
   * bearing is (-0.39, -0.90) in XZ at 11 degrees elevation, so:
   *
   * - `walk_store` heads roughly (-0.67, +0.74), which is away from the sun.
   *   This is the direction the film actually walks. Damp asphalt here should be
   *   DARKER than dry, and what saves it from being a flat black expanse is
   *   skylight reflected at grazing incidence, brightening toward the horizon.
   * - `walk_sun` heads roughly (-0.36, -0.93), almost exactly along the sun
   *   bearing. Damp asphalt here should be MUCH BRIGHTER than dry.
   *
   * A wetness treatment that darkens without reflecting passes the second test
   * and fails the first, and only the first appears in the film.
   */
  walk_store: { pos: [5.0, 0, 20.0], eye: 1.62, look: [-5.0, 1.35, 31.0], fov: 50 },
  walk_sun: { pos: [-4.0, 0, 26.0], eye: 1.62, look: [-11.0, 0.9, 8.0], fov: 50 },

  /**
   * Along the fuelling lane, past the island, at walking height.
   *
   * The third walking pose, and it exists because the first two could not see
   * the thing I had just changed. Both of them were authored to judge the ground
   * plane and its wetness, so they look across open forecourt; the tyre scrub and
   * oil live at the stances, at x within +/-4 and z of 21.25 and 25.15, and
   * neither pose has a stance in frame. Measuring "the marks do not read" from a
   * view that cannot contain them is the confident null again, one level up from
   * the crop that was all broad shading.
   *
   * Heading is roughly (+0.99, +0.13), which is close to perpendicular to the
   * sun bearing. That is deliberate and it is the third distinct lighting case
   * after the with-the-light and into-the-light pair: cross-lit is where surface
   * marks show best, being neither washed out by glare nor buried in shadow. If
   * the scrub does not read here it does not read.
   */
  walk_pump: { pos: [-8.5, 0, 19.9], eye: 1.62, look: [7.5, 1.1, 22.0], fov: 50 },

  /**
   * THE INTERACTIVE SPAWN, reproduced exactly. The first frame anyone records.
   *
   * Not authored — DERIVED from the spawn state archived in
   * `shots/walkprobe-film-0637/run.log`, because Film's verge complaint is about
   * this frame and a pose that merely resembles it would answer a different
   * question. `walkprobe.mjs` produces the real thing by letting `PlayerSystem`
   * spawn with no shot preset, but it overwrites its output and takes no force
   * token, so it cannot carry a control arm.
   *
   * Archived: position (-14.0000, 1.8674, 2.0000), forward
   * (0.6247, -0.0098, 0.7808), fov 52, pitch -0.559 deg, yaw 38.660 deg.
   *
   * `groundHeight(-14, 2)` is 0.2174, so `eye: 1.650` lands on 1.8674 exactly.
   * `look` is that position advanced 30 m along the archived forward. Verified by
   * reconstruction: the forward implied by pos -> look matches the archive to
   * 2.0e-6 per component, pitch -0.562 and yaw 38.662 against -0.559 and 38.660,
   * the residual being the archive's four printed decimals rather than drift.
   *
   * **fov 52 is `Game.ts`'s camera default and must stay 52.** The other poses
   * here choose a fov to frame a subject; this one is not framing anything, it is
   * standing where the player stands. A 46 or 50 here would silently change the
   * regime the complaint lives in — the verge is immediate foreground, the camera
   * is level to within half a degree, and the bottom frame row is ground at
   * 3.30 m where one screen pixel spans 8.3 mm. Narrow the fov and that row moves
   * out, the magnification falls, and the measurement passes while the frame the
   * user screenshots stays ugly.
   */
  spawn: { pos: [-14.0, 0, 2.0], eye: 1.65, look: [4.741, 1.573, 25.424], fov: 52 },
};

const ALL = Object.keys(POSES);
const SHOTS = ONLY.length ? ALL.filter((s) => ONLY.includes(s)) : ALL;
if (ONLY.length) {
  // NOTES.md case 25: a hook that selects behaviour by string must reject an
  // unrecognised value. A misspelt pose name that silently captures nothing
  // returns a clean run and an empty round.
  const unknown = ONLY.filter((s) => !ALL.includes(s));
  if (unknown.length) {
    console.error(`[shoot1] unknown pose(s): ${unknown.join(", ")}. Known: ${ALL.join(", ")}`);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null, round: null, gpu: null, sysErrors: null };
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
  if (reason) console.error(`\n[shoot1] shutting down: ${reason}`);
  const closers = [
    [
      "archive round",
      async () => {
        const r = resources.round;
        if (!r) return;
        resources.round = null;
        await r.finalise({
          gpu: resources.gpu,
          systemErrors: resources.sysErrors,
          keep: 12,
          outcome: reason ? "failed" : "ok",
          failure: reason ?? null,
        });
        console.log(`[shoot1] round ${r.id} -> ${path.relative(ROOT, r.dir)}`);
      },
    ],
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
      console.error(`[shoot1] failed to close ${label}: ${err?.message ?? err}`);
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

const SHADER_FAIL =
  /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS|THREE\.WebGLProgram/i;
/**
 * Warnings that are not failures.
 *
 * The pattern above matches "Program Info Log", which is the envelope every
 * shader diagnostic arrives in — including the benign ones. ANGLE's HLSL
 * backend emits `warning X4122: sum of 0.996094 and -2.98545e-017 cannot be
 * represented accurately in double precision` for ordinary constant folding, and
 * that aborted a round whose frame had already been captured correctly.
 *
 * Keeping compile and link errors fatal is right and is not being relaxed. What
 * is being fixed is the classification: a warning reported as a failure is the
 * false positive that gets a gate switched off, which is the more expensive
 * outcome. Anything matching this is logged and not counted; anything that also
 * says `error` is still fatal, since `error` wins by being checked first.
 */
const SHADER_BENIGN = /\bwarning X\d+\b|cannot be represented accurately/i;
const isShaderFailure = (t) => SHADER_FAIL.test(t) && !(SHADER_BENIGN.test(t) && !/\berror\b/i.test(t));
// Case-sensitive and word-bounded on purpose: `NaN` and `Infinity` are JS
// literals with one spelling each, and a case-insensitive substring search for
// "NaN" matches the middle of "luminance".
const WORLD_UNSAFE = /\bnon-finite\b|\bNaN\b|\bInfinity\b/;

/**
 * Refuse a frame that cannot be this scene, whatever the console said.
 *
 * A sky-mean check on its own passes a completely broken frame: the sky dome is
 * a ShaderMaterial and the distant backdrop is MeshBasicMaterial, so neither
 * samples `scene.environment` and both render perfectly through a poisoned
 * PMREM that blacks out every lit surface below them. The lower third and the
 * near-black fraction are the two numbers that separated the known-good round
 * from the known-broken one (lower third 24.2 against exactly 0.0, near-black
 * 33% against 66%), so those are the ones that do the work here.
 *
 * The lower-third floor is deliberately generous. This system is about to make
 * parts of the ground genuinely darker — wet asphalt is roughly half the albedo
 * of dry — and a guard that fires on the feature being built gets deleted.
 */
async function assertFrameIsLit(file, label, failures) {
  const png = PNG.sync.read(await fs.readFile(file));
  // Dimensions before statistics. Everything below is a mean, and the mean of
  // no pixels is NaN, and every comparison against NaN is false - so a 0x0 or
  // truncated capture sails through every content check in this function and
  // is reported as a healthy frame. Another harness in this repo was found
  // writing 0x0 PNGs; this is the assertion that would have caught it, and it
  // has to come first because it is the one failure the rest cannot see.
  if (png.width < WIDTH || png.height < HEIGHT) {
    failures.push(`${label}: capture is ${png.width}x${png.height}, expected ${WIDTH}x${HEIGHT}`);
    return { skyMean: 0, lowMean: 0, lowSd: 0, darkFrac: 1 };
  }
  let sky = 0;
  let skyN = 0;
  let low = 0;
  let lowN = 0;
  let lowSq = 0;
  let dark = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (l < 24) dark++;
      if (y < png.height / 8) {
        sky += l;
        skyN++;
      } else if (y > (png.height * 2) / 3) {
        low += l;
        lowSq += l * l;
        lowN++;
      }
    }
  }
  const skyMean = sky / skyN;
  const lowMean = low / lowN;
  const lowSd = Math.sqrt(Math.max(0, lowSq / lowN - lowMean * lowMean));
  const darkPct = (dark / (png.width * png.height)) * 100;
  if (skyMean < 55) failures.push(`${label}: sky mean luma ${skyMean.toFixed(1)} — frame is black, not a dawn sky`);
  // Dark is not dead, and the difference is structure, not level.
  //
  // A mean-only floor cannot tell a legitimately dark frame from a broken one.
  // `ground` is 0.42 m over asphalt in dawn shade and measured 6.1 against a
  // floor of 8 while the stalls, the stripes and the car all read perfectly
  // well — a false positive on a correct frame. Meanwhile this system is about
  // to make wet asphalt roughly half the albedo of dry, so raising the floor
  // to accommodate that would leave nothing that fires on the failure it
  // exists for. A frame killed by a poisoned environment is not merely dark:
  // every lit surface clamps to the same value, so the region loses its
  // variance as well as its level. Requiring BOTH is what separates them —
  // the known-broken round measured lower third 0.0 with no spread at all.
  if (lowMean < 8 && lowSd < 4)
    failures.push(
      `${label}: lower-third mean luma ${lowMean.toFixed(1)} with sd ${lowSd.toFixed(1)} — the ground is unlit, ` +
        `not merely dark: it has no structure either. Check the environment map for non-finite values before ` +
        `blaming any surface material`
    );
  if (darkPct > 50) failures.push(`${label}: ${darkPct.toFixed(1)}% of pixels near-black — frame is a silhouette`);
  return { skyMean, lowMean, lowSd, darkPct };
}

/** Content hash over the whole private build dir, plus the newest mtime. */
async function bundleStamp() {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(OUT_DIR);
  if (!files.length) return { hash: "missing", mtime: "-", text: `${path.relative(ROOT, OUT_DIR)}/ missing` };
  files.sort();
  const h = crypto.createHash("sha256");
  let newest = 0;
  for (const f of files) {
    const st = await fs.stat(f);
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    h.update(path.relative(ROOT, f));
    h.update(await fs.readFile(f));
  }
  return {
    hash: h.digest("hex").slice(0, 12),
    mtime: new Date(newest).toLocaleString("sv-SE"),
    get text() {
      return `${this.hash} built ${this.mtime}`;
    },
  };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[shoot1] building into .shot-build/terrain ...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot1] bundle ${stamp.text}`);
  if (stamp.hash === "missing") throw new Error("no bundle in .shot-build/terrain — run without --no-build");

  console.log(`[shoot1] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot1] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shoot1", allowSoftware: ALLOW_SOFTWARE });
  resources.gpu = gpuInfo?.renderer ?? "unknown";
  await gpuPage.close();

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    tag: "shoot1",
    bundleHash: stamp.hash,
    bundleMtime: stamp.mtime,
    extra: { port: PORT, viewport: `${WIDTH}x${HEIGHT}`, query: QUERY || null, suffix: SUFFIX || null },
  });
  resources.round = round;
  console.log(`[shoot1] round ${round.id}`);

  const written = [];
  // The program cache is per-context, so it is reported once per run, not per pose.
  let programsReported = false;
  const failures = [];
  let reported = false;

  for (const shot of SHOTS) {
    const pose = POSES[shot];
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" || SHADER_FAIL.test(t) || WORLD_UNSAFE.test(t)) problems.push(`console: ${t}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    // `shot=system1` is not a preset any system claims, so PlayerSystem leaves
    // the camera alone and the pose below is the only thing that moves it.
    const parts = ["shot=system1", "gpu=1"];
    if (QUERY) parts.push(QUERY);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    // Per shot, from the live context, not once at launch from a throwaway
    // canvas. Playwright injects --enable-unsafe-swiftshader into every
    // Chromium it starts whatever flags we pass, so the fallback path is always
    // open; and a run of six poses allocates and frees the whole scene six
    // times, which is exactly when the card runs out and the context is lost.
    // A lost context keeps calling the animation loop and keeps producing
    // files, so without this the harness reports success on stale pixels.
    resources.gpu = await assertSceneGpu(page, { tag: "shoot1", when: `for ${shot}`, allowSoftware: ALLOW_SOFTWARE });

    const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
    resources.sysErrors = sysErrors;
    if (!Array.isArray(sysErrors)) failures.push(`${shot}: window.__SYSTEM_ERRORS was never published`);
    else if (sysErrors.length)
      failures.push(
        `${shot}: ${sysErrors.length} system(s) failed -> ` +
          sysErrors.map((e) => `${e.system}.${e.phase}: ${e.message}`).join(" | ")
      );

    if (!reported) {
      reported = true;
      const t = await page.evaluate(() => window.__TERRAIN ?? null);
      console.log(`[shoot1] __TERRAIN: ${JSON.stringify(t)}`);
      if (!t) failures.push("window.__TERRAIN was never published — TerrainSystem did not run");

      // Init phase breakdown, printed here rather than left in the page console
      // so a round's log is self-contained. `unaccountedMs` is printed even when
      // it is small, because the whole point of the remainder is that it is not
      // reported only when someone remembers to look for it.
      const ph = await page.evaluate(() => window.__INIT_PHASES?.terrain ?? null);
      if (ph) {
        const s = (ms) => `${(ms / 1000).toFixed(2)}s`;
        console.log(
          `[shoot1] terrain init ${s(ph.totalMs)}: ` +
            ph.phases.map((p) => `${p.label} ${s(p.ms)}`).join(", ") +
            ` | UNACCOUNTED ${s(ph.unaccountedMs)}`
        );
      }
    }

    const applied = await page.evaluate((p) => {
      const g = window.__GAME;
      if (!g) return { ok: false, why: "no __GAME" };
      const cam = g.camera;
      let y = p.pos[1];
      if (p.eye !== undefined) {
        const gh = g.tryGet ? g.tryGet("groundHeight") : null;
        if (typeof gh !== "function") return { ok: false, why: "no groundHeight service" };
        y = gh(p.pos[0], p.pos[2]) + p.eye;
      }
      cam.position.set(p.pos[0], y, p.pos[2]);
      cam.up.set(0, 1, 0);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(p.look[0], p.look[1], p.look[2]);
      cam.fov = p.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return { ok: true, y };
    }, pose);
    if (!applied.ok) {
      failures.push(`${shot}: could not apply pose (${applied.why})`);
      await page.close();
      continue;
    }

    // The shadow cascade refits to the camera every frame, so the pose has to
    // survive a full update before the depth pass agrees with the colour pass.
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 18 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    const stats = await page.evaluate(() => {
      const r = window.__GAME?.renderer;
      if (!r) return null;
      /**
       * The compiled program cache, read here because the page is already
       * loaded and drawn, so it is free.
       *
       * `renderer.info.programs` is three's live cache and each entry carries
       * the `cacheKey` it was keyed on. That key is the only thing in the
       * runtime that says WHO owns a program, which is what makes a per-owner
       * count possible at all — grouped below on the key's leading token.
       *
       * Read AFTER the 18-frame settle above, not at scene-ready: programs are
       * created on first draw, so a count taken early is a count of whatever
       * happened to have been drawn, and it reads low in a way that looks like
       * a saving.
       */
      const list = r.info.programs;
      const keys = Array.isArray(list) ? list.map((p) => String(p.cacheKey ?? "")) : null;
      return {
        calls: r.info.render.calls,
        tris: r.info.render.triangles,
        // null and 0 are different findings: null means the probe never reached
        // the cache, 0 would mean a drawn frame compiled nothing, which is
        // impossible and would indicate the read is wrong rather than the scene.
        programKeys: keys,
      };
    });

    /**
     * Per-owner program counts, grouped on the key prefix. Reported once, on the
     * first shot of the run, because the cache is per-context and does not
     * change between poses in one browser.
     *
     * Grouped by the leading token rather than by a hand-written owner list, so
     * a system that starts keying programs shows up as a new group instead of
     * being silently folded into "other".
     */
    if (stats && !programsReported) {
      programsReported = true;
      if (stats.programKeys === null) {
        failures.push(
          `${shot}: renderer.info.programs is not an array. A frame was drawn, so this is the probe ` +
            `failing to reach the renderer rather than a scene with no programs.`
        );
      } else {
        /**
         * Group on the CUSTOM key, which three appends to the END of its own.
         *
         * The first attempt grouped on the leading token and reported garbage,
         * because every three cacheKey begins `physical,STANDARD,,highp,...` —
         * the stock program descriptor. The owner-identifying part, when there
         * is one, is whatever `customProgramCacheKey` returned, and it is at the
         * tail.
         *
         * Systems that do NOT set a custom key cannot be attributed at all from
         * here, and they are reported as exactly that rather than bucketed into
         * a plausible-looking owner. An attribution that invents a denominator
         * is worse than one that admits a gap.
         */
        const OWNERS = [
          ["wd (applyWorldDetail, Terrain)", /wd:(hi|lo):/],
          ["veg", /\bveg[:_]/i],
          ["canopy", /\bcanopy[:_]/i],
          ["pump", /\bpump[:_]/i],
          ["car", /\bcar[:_]/i],
          ["building", /\bbld[:_]|\bbuilding[:_]/i],
        ];
        const groups = new Map();
        for (const k of stats.programKeys) {
          const hit = OWNERS.find(([, re]) => re.test(k));
          groups.set(
            hit ? hit[0] : "unattributable (no customProgramCacheKey)",
            (groups.get(hit ? hit[0] : "unattributable (no customProgramCacheKey)") ?? 0) + 1
          );
        }
        const wd = stats.programKeys.filter((k) => /wd:(hi|lo):/.test(k));
        console.log(`[shoot1] PROGRAMS renderer.info.programs.length = ${stats.programKeys.length}   (wd: ${wd.length})`);
        for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) {
          console.log(`[shoot1] PROGRAMS   ${String(n).padStart(4)}  ${g}`);
        }
        // The distinct wd keys, tail-sliced so the custom portion is visible
        // rather than 96 characters of stock descriptor. A collapse that shared
        // programs shows as a shorter list here, rather than being inferred from
        // a total that other systems also move.
        const distinct = [...new Set(wd.map((k) => (/wd:(hi|lo):[^,]*/.exec(k)?.[0] ?? k).slice(0, 110)))].sort();
        console.log(`[shoot1] PROGRAMS   ${wd.length} wd programs over ${distinct.length} distinct wd keys`);
        for (const k of distinct) console.log(`[shoot1] PROGRAMS     ${k}`);
      }
    }

    const file = await round.save(`${shot}${SUFFIX}`, (dest) => page.screenshot({ path: dest, type: "png" }));
    written.push(file);
    const lit = await assertFrameIsLit(file, shot, failures);
    console.log(
      `[shoot1] ${shot.padEnd(9)} -> ${path.relative(ROOT, file)}  eye y=${applied.y.toFixed(2)}  ` +
        `draws=${stats?.calls ?? "?"} tris=${stats?.tris ?? "?"}  ` +
        `sky=${lit.skyMean.toFixed(0)} low=${lit.lowMean.toFixed(0)}±${lit.lowSd.toFixed(0)} ` +
        `black=${lit.darkPct.toFixed(0)}%  ` +
        `(${Date.now() - t0} ms)  bundle ${stamp.text}`
    );

    const shaderProblems = problems.filter((p) => isShaderFailure(p));
    if (shaderProblems.length) failures.push(`${shot}: shader failure -> ${shaderProblems[0]}`);
    // Benign shader diagnostics are printed rather than dropped: a warning that
    // nothing ever mentions is how a real one hides in a familiar shape.
    const shaderNotes = problems.filter((p) => SHADER_FAIL.test(p) && !isShaderFailure(p));
    for (const n of shaderNotes) console.log(`[shoot1] ${shot}: shader note (not fatal) -> ${n}`);
    const worldProblems = problems.filter((p) => WORLD_UNSAFE.test(p));
    if (worldProblems.length)
      failures.push(`${shot}: non-finite value reported on the page -> ${worldProblems[0]}`);
    if (problems.length) console.warn(`[shoot1]   page problems:\n    ${problems.slice(0, 8).join("\n    ")}`);
    await page.close();
  }

  await context.close();

  const after = await bundleStamp();
  if (after.hash !== stamp.hash)
    failures.push(`bundle changed mid-capture: ${stamp.hash} -> ${after.hash}. Every shot above is suspect.`);

  console.log(
    `\n[shoot1] ${written.length}/${SHOTS.length} screenshots -> ${path.relative(ROOT, round.dir)}` +
      ` (stable copies in ${path.join("shots", SYSTEM)})`
  );
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
