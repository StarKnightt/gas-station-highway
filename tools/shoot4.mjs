#!/usr/bin/env node
/**
 * Screenshot harness for System 4 (lighting and atmosphere).
 *
 *   node tools/shoot4.mjs                              # all presets -> shots/system4/
 *   node tools/shoot4.mjs --shots=door_spill           # subset
 *   node tools/shoot4.mjs --no-build                   # reuse the existing dist/
 *   node tools/shoot4.mjs --query=lforce=noshadow --suffix=_noshadow
 *
 * Port 5115 and its own poses, so it can run beside the other harnesses.
 *
 * Two things this one does that the earlier harnesses do not:
 *
 *  - It prints the built bundle's mtime with every capture. A stale dist/ has
 *    already produced a round of review on screenshots of code that had been
 *    replaced, and the timestamp makes that impossible to miss.
 *  - It reads `window.__LIGHTING` back out of the page and asserts on it:
 *    a black PMREM environment and a failed shader-chunk patch are both silent
 *    at runtime, so they are checked explicitly rather than eyeballed.
 *
 * Teardown contract: the preview server and the browser are registered with a
 * single shutdown routine wired to normal completion, thrown errors, SIGINT,
 * SIGTERM, uncaughtException and unhandledRejection BEFORE either is started.
 * Nothing is detached and the process always ends in an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Private output directory. Other agents' harnesses build into `dist/` from
 * their own worktrees at the same time, and a half-written `dist/` produced a
 * round of captures of somebody else's in-flight shader. Owning the directory
 * makes the bundle mtime printed below actually mean something.
 */
const OUT_DIR = path.join(ROOT, ".shot-build", "system4");
const PORT = 5125;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 240_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system4");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
/**
 * Orbit the camera by this many degrees about the pose's look point, keeping
 * the same target and distance. This is the camera-locked / world-locked
 * discriminator: a shadow cast by scene geometry stays on the same square
 * centimetre of the receiving object when the camera moves, and anything
 * derived from the *view* frustum does not.
 */
const ORBIT_DEG = Number(arg("orbit", "0"));

/**
 * Several staged captures of the same pose in one browser, one build and one
 * archive round.
 *
 *   --variants='base|;noshadow|lforce=noshadow;near|sdist=30'
 *
 * `name|query`, semicolon separated. The pseudo-token `__orbit=<deg>` inside a
 * variant's query is consumed here rather than sent to the page. Running them
 * in one process is not just a speed win: a cross-build A/B has no clean
 * control in this repo (NOTES.md case 23), because another agent's system can
 * change between two builds, so every frame a conclusion rests on has to come
 * from the same bundle.
 */
const VARIANTS = (() => {
  const raw = arg("variants", null);
  if (!raw) return [{ name: SUFFIX, query: QUERY, orbit: ORBIT_DEG }];
  return raw.split(";").filter(Boolean).map((spec) => {
    const bar = spec.indexOf("|");
    const name = bar < 0 ? spec : spec.slice(0, bar);
    const tokens = (bar < 0 ? "" : spec.slice(bar + 1)).split("&").filter(Boolean);
    let orbit = ORBIT_DEG;
    const keep = [];
    for (const t of tokens) {
      if (t.startsWith("__orbit=")) orbit = Number(t.slice(8));
      else keep.push(t);
    }
    return { name: `_${name}`, query: keep.join("&"), orbit };
  });
})();

/**
 * `eye` is metres above the walkable surface at the camera's XZ; without it the
 * Y in `pos` is absolute. `door` forces the entry door open by that fraction.
 *
 * The sun is at 6.2 degrees in the west-south-west, so it travels toward +X+Z:
 * shadows rake from the pumps and the building across the lot and the parking
 * bays, and the storefront's south elevation is lit almost edge-on.
 */
const POSES = {
  // Long shadows raking across the lot, sun behind the left shoulder.
  lot_shadows: { pos: [-14.5, 0, 20.0], eye: 1.62, look: [14.0, 0.7, 33.0], fov: 54 },
  // Contre-jour: straight into the low sun with the station against it.
  sun_low: { pos: [15.0, 0, 33.0], eye: 1.58, look: [-16.0, 3.2, 14.0], fov: 50 },
  // The signature shot. Standing in the front-east corner of the shop looking
  // back west across the floor: the doorway is the one warm aperture in the
  // frame, the beam through it runs toward the camera along +X+Z, and the cold
  // fluorescent room and the reach-in cooler sit behind it to the right.
  door_spill: { pos: [2.55, 0, 33.05], eye: 1.58, look: [-6.2, 0.95, 33.6], fov: 56, door: 1 },
  // Inside, showing fluorescent character and the reach-in cooler.
  interior_cold: { pos: [1.2, 0, 36.4], eye: 1.62, look: [-7.4, 1.35, 38.6], fov: 58, door: 1 },
  // Three-quarter of the whole site in golden light.
  wide_golden: { pos: [30.0, 9.5, 6.0], look: [-6.0, 1.2, 30.0], fov: 48 },

  // Byte-for-byte the car harness's `side_sun` pose, in the car's own local
  // frame. This is not a car shot: it is the pose the rectangular block
  // artefact was reported in, and reproducing it exactly is what lets a
  // lighting-side change be compared against `shots/car/rounds/*/side_sun*`.
  car_side_sun: { local: true, pos: [5.4, 1.0, 1.65], look: [0, 0.74, -0.35], fov: 32 },

  // The penumbra rig. Needs `?lpost=1`, which puts one 1.2 m post on open
  // asphalt at (-18, 4); its shadow runs 11 m toward +x+z at this sun.
  //
  // The camera sits on the sun side of the post and looks down the shadow from
  // above, so that **image row maps monotonically to distance from the base**,
  // which is the whole reason the pose exists: one shadow edge whose
  // occluder-to-receiver distance sweeps from zero to 11 m, sampled by
  // `penumbra.mjs --rows`. Elevated to 8 m rather than eye height because a
  // grazing view compresses the far half of the shadow into a few rows and the
  // far half is where contact hardening has to show itself.
  post_penumbra: { pos: [-19.4, 7.0, 5.2], look: [-7.9, 0.0, 10.2], fov: 45 },

  // Aerial perspective needs the same surface at two distances in one frame.
  // The lot's own bay stripes run away from the camera for 40 m and the ridge
  // sits at ~700 m, so a single column of this frame crosses four decades of
  // depth on geometry whose albedo is known.
  haze_depth: { pos: [-18.0, 0, 6.0], eye: 1.62, look: [26.0, 2.6, 46.0], fov: 46 },

  // The mirror test. Needs `?lmirror=1`, which puts a chrome sphere and a
  // vertical chrome plate at the environment capture point. A rendered mirror
  // beats every statistic available here: "the lower hemisphere's standard
  // deviation is 4.9" persuades nobody, and "the plate shows the store, the
  // treeline and the tarmac joint" ends the argument.
  mirror: { pos: [21.0, 0, 19.2], eye: 1.85, look: [13.4, 1.72, 26.0], fov: 42, mirror: true },
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
  if (reason) console.error(`\n[shoot4] shutting down: ${reason}`);
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
      console.error(`[shoot4] failed to close ${label}: ${err?.message ?? err}`);
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

/** Anything matching this in the console means a program never linked. */
const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;

/**
 * A `Program Info Log` that carries only HLSL/GLSL *warnings* and no error.
 *
 * `SHADER_FAIL` matches the words "program info log", which is right, because
 * three prints that header for both warnings and errors and a round must never
 * continue past an error. But the D3D compiler behind ANGLE also emits advisory
 * warnings, and the first one this project ever saw — `X4122: sum of 0.996094
 * and -2.98545e-017 cannot be represented accurately in double precision`, from
 * constant folding in the spot-shadow program — failed a round whose five
 * screenshots had all rendered correctly.
 *
 * The tightening is deliberately narrow, and inverted: rather than listing
 * warnings to forgive, require that the log contain *no* error-shaped token at
 * all. A log with both a warning and an error still fails. Widening
 * `SHADER_FAIL` instead is the mistake that already cost this project a round in
 * the other direction, when the pattern was loose enough to hide a real failing
 * line.
 */
const SHADER_WARN_ONLY = (text) =>
  /program info log/i.test(text) && /\bwarning\b/i.test(text) && !/\berror\b|ERROR:|undeclared identifier|VALIDATE_STATUS/i.test(text);

/**
 * Newest mtime and a content hash of the private build dir, so a stale bundle
 * cannot be mistaken for a fresh one and every archived round names the build
 * that produced it (NOTES.md case 13).
 */
async function bundleStamp() {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
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
      else {
        const st = await fs.stat(full);
        if (st.mtimeMs > newest) {
          newest = st.mtimeMs;
          file = path.relative(ROOT, full);
        }
        files.push(full);
      }
    }
  };
  await walk(OUT_DIR);
  for (const f of files) h.update(path.relative(ROOT, f)).update(await fs.readFile(f));
  return {
    hash: files.length ? h.digest("hex").slice(0, 12) : "nobundle",
    iso: newest ? new Date(newest).toISOString() : "missing",
    text: newest ? `${new Date(newest).toISOString()} (${file})` : `${path.relative(ROOT, OUT_DIR)}/ missing`,
  };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  // A control must prove it was applied, and that includes the harness itself.
  //
  // Twice tonight a variant died on `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, which
  // reads like a server or a page fault and is neither: `.shot-build/system4/`
  // had been deleted between the build and the navigation. The cause is a
  // sibling building into `.shot-build/` **root** with `emptyOutDir: true`,
  // which empties the whole directory and takes every agent's private
  // subdirectory with it. Evidence at the time: a top-level `assets/` and
  // `index.html` timestamped inside my round's window, next to freshly
  // rebuilt `canopy/`, `pumps/` and `winding/` siblings.
  //
  // The point of checking immediately before each `goto` rather than once after
  // the build is that the wipe can land mid-round, so an early check passes and
  // a later pose still fails. Named loudly because an opaque network error
  // invites a retry, and retrying is exactly wrong here.
  const assertBuildStillPresent = () => {
    if (!fsSync.existsSync(path.join(OUT_DIR, "index.html"))) {
      throw new Error(
        `build output ${path.relative(ROOT, OUT_DIR)}/index.html has disappeared since the build. ` +
          `This is almost always a sibling agent running a vite build with outDir=.shot-build ` +
          `(the root, not a subdirectory) and emptyOutDir:true, which deletes every agent's ` +
          `private build dir. Do not retry blindly - check .shot-build/ for a top-level ` +
          `index.html and assets/, and ask that agent to build into its own subdirectory.`
      );
    }
  };

  if (DO_BUILD) {
    console.log("[shoot4] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot4] bundle mtime: ${stamp.text}  hash ${stamp.hash}`);

  console.log(`[shoot4] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot4] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "shoot4", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const outDir = path.join(ROOT, "shots", SYSTEM);
  await fs.mkdir(outDir, { recursive: true });

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    bundleHash: stamp.hash,
    bundleMtime: stamp.iso,
    tag: "shoot4",
    extra: { presets: SHOTS, suffix: SUFFIX || null, query: QUERY || null, orbitDeg: ORBIT_DEG || 0 },
  });
  console.log(`[shoot4] round ${round.id}`);

  const written = [];
  const failures = [];
  let reported = false;
  let sysErrs = null;
  const gpuInfo = gpu;

  const jobs = SHOTS.flatMap((shot) => VARIANTS.map((v) => ({ shot, v })));
  for (const { shot, v } of jobs) {
    const pose = POSES[shot];
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      const t = m.text();
      if (SHADER_WARN_ONLY(t)) {
        // Surfaced, never fatal, and never silently dropped: a warning that
        // appears the round a shader changes is worth reading even when it is
        // benign.
        console.warn(`[shoot4]   shader warning (not fatal): ${t.slice(0, 200)}`);
      } else if (m.type() === "error" || SHADER_FAIL.test(t)) {
        problems.push(`console: ${t}`);
      }
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    // `shot=system4` is not a preset any system claims, so the player
    // controller disables itself and leaves the camera to the pose below.
    const parts = [`shot=system4`, `gpu=1`];
    if (pose.door) parts.push(`bopen=1`, `ldoor=${pose.door}`);
    if (pose.mirror) parts.push(`lmirror=1`, `envdump=1`);
    if (v.query) parts.push(v.query);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    assertBuildStillPresent();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    // Per case 8: a page that renders is not necessarily a page that is
    // healthy, so this is read every shot and recorded in the manifest.
    const errs = await page.evaluate(() => (window.__SYSTEM_ERRORS ?? []).map((e) => String(e?.message ?? e)));
    if (errs.length) failures.push(`${shot}: __SYSTEM_ERRORS -> ${errs.join(" | ")}`);
    sysErrs = [...(sysErrs ?? []), ...errs];

    if (!reported) {
      reported = true;
      const info = await page.evaluate(() => window.__LIGHTING ?? null);
      console.log(`[shoot4] __LIGHTING: ${JSON.stringify(info)}`);
      if (!info) failures.push("window.__LIGHTING was never published");
      else {
        // `pcf` and `pcss` are alternative shadow filters and exactly one of
        // them is installed, so requiring `pcf` outright fails every contact
        // hardening round. Requiring one *or* the other still catches the case
        // this assertion is for, which is a string-matching chunk patch that
        // silently found no anchor.
        if (info.patches && (!(info.patches.pcf || info.patches.pcss) || !info.patches.fog)) {
          failures.push(`shader chunk patch did not apply: ${JSON.stringify(info.patches)}`);
        }
        if (!(info.env && info.env.mean > 1e-4)) {
          failures.push(`environment map is black or unreadable: ${JSON.stringify(info.env)}`);
        }
        if (!(info.interior && info.interior.built)) {
          failures.push(`interior lighting was not built: ${JSON.stringify(info.interior)}`);
        }
      }
    }

    // The environment guard. `env.mean > 0` above only catches a *black*
    // environment; a lower hemisphere of one constant non-black colour sails
    // through it, which is exactly how the featureless capture survived a full
    // day of five systems tuning material response against it. The property
    // that discriminates is variance on the downward face. NOTES.md case 28.
    //
    // Not checked when a variant deliberately disables the world capture -
    // `lforce=flatenv` is the control that has to fail, and a control that
    // cannot fail is not evidence.
    // Only assert on the world capture when the variant actually asked for it.
    // It is opt-in while the NaN is open so that other agents' rounds are clean.
    const envOn = /worldenv=1/.test(v.query ?? "");
    if (envOn) {
      const we = await page.evaluate(() => window.__LIGHTING?.worldEnv ?? null);
      if (!we || !we.built) {
        failures.push(`${shot}${v.name}: world environment was not captured: ${JSON.stringify(we)}`);
      } else {
        const down = we.faces?.[3];
        console.log(
          `[shoot4]   env @ ${JSON.stringify(we.position)} cube ${we.cubeSize} installed=${we.installed} ` +
            `bad=${we.badCube}/${we.badFiltered} peak=${Math.max(...we.faces.map((f) => f.maxChannel)).toFixed(1)}  ` +
            we.faces.map((f) => `${f.face} m${f.mean.toFixed(3)}/s${f.std.toFixed(3)}`).join(" ")
        );
        if (!(down && down.std > 1e-5)) {
          failures.push(
            `${shot}${v.name}: environment lower hemisphere is FEATURELESS ` +
              `(downward face std ${down?.std}) - every vertical surface reflects one constant colour`
          );
        }
        if (we.badCube > 0 || we.badFiltered > 0) {
          failures.push(
            `${shot}${v.name}: environment has non-finite pixels (cube ${we.badCube}, filtered ${we.badFiltered})`
          );
        }
      }

      const url = await page.evaluate(() => window.__ENV_DUMP ?? null);
      if (pose.mirror && !url) failures.push(`${shot}${v.name}: ?envdump produced no cube dump`);
      if (url) {
        const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
        const dumped = await round.save(`envcube${v.name}`, png);
        console.log(`[shoot4]   cube dump -> ${path.relative(ROOT, dumped)}`);
      }
    }

    const applied = await page.evaluate(
      ({ p, orbitDeg }) => {
        const g = window.__GAME;
        if (!g) return { ok: false, why: "no __GAME" };
        const cam = g.camera;
        let pos = p.pos.slice();
        let look = p.look.slice();

        if (p.local) {
          // Same transform the car harness uses, so `car_side_sun` lands on the
          // same pixels as `shots/car/.../side_sun`.
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
          const fh = g.tryGet ? g.tryGet("building.floorHeight") : null;
          const gh = g.tryGet ? g.tryGet("groundHeight") : null;
          const h = typeof fh === "function" ? fh : gh;
          if (typeof h !== "function") return { ok: false, why: "no height service" };
          pos[1] = h(pos[0], pos[2]) + p.eye;
        }

        if (orbitDeg) {
          const a = (orbitDeg * Math.PI) / 180;
          const dx = pos[0] - look[0];
          const dz = pos[2] - look[2];
          pos[0] = look[0] + dx * Math.cos(a) - dz * Math.sin(a);
          pos[2] = look[2] + dx * Math.sin(a) + dz * Math.cos(a);
        }

        cam.position.set(pos[0], pos[1], pos[2]);
        cam.up.set(0, 1, 0);
        cam.rotation.set(0, 0, 0);
        cam.lookAt(look[0], look[1], look[2]);
        cam.fov = p.fov;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        return { ok: true, y: pos[1], pos, look };
      },
      { p: pose, orbitDeg: v.orbit }
    );

    if (!applied.ok) {
      failures.push(`${shot}: could not apply pose (${applied.why})`);
      await page.close();
      continue;
    }

    // Extra rAF ticks: the shadow frustum refits against the camera every
    // frame, so the pose has to be in place for at least one full update
    // before the depth pass matches what the colour pass will show.
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 16 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    const file = await round.save(`${shot}${v.name}`, (dest) => page.screenshot({ path: dest, type: "png" }));
    written.push(file);
    console.log(
      `[shoot4] ${(shot + v.name).padEnd(24)} -> ${path.relative(ROOT, file)}  eye y=${applied.y.toFixed(2)}  ` +
        `(${Date.now() - t0} ms)  bundle ${stamp.hash}`
    );

    const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
    if (shaderProblems.length) failures.push(`${shot}: shader failure -> ${shaderProblems[0]}`);
    if (problems.length) console.warn(`[shoot4]   page problems:\n    ${problems.slice(0, 8).join("\n    ")}`);
    await page.close();
  }

  await context.close();
  // On the failure paths too: a round that failed is exactly the round
  // somebody will want to read later.
  await round.finalise({ gpu: gpuInfo?.renderer ?? null, systemErrors: sysErrs, keep: 12 });
  console.log(`\n[shoot4] ${written.length}/${jobs.length} screenshots -> shots/${SYSTEM}/rounds/${round.id}`);
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
