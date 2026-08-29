#!/usr/bin/env node
/**
 * Screenshot harness for System 3, the fuel dispensers and bollards.
 *
 *   node tools/shoot3.mjs                          # all presets -> shots/system3/
 *   node tools/shoot3.mjs --shots=pump_close,hose
 *   node tools/shoot3.mjs --no-build               # reuse .shot-build/pumps
 *   node tools/shoot3.mjs --query=force=grime --suffix=_force
 *   node tools/shoot3.mjs --lift=1 --suffix=_lift1 # sweep the nozzle out first
 *
 * Port 5113, and its own build directory: the car harness is on 5116 and the
 * vegetation one on 5119, and a concurrent `vite build` into the shared dist/
 * has already once swapped the bundle out from under a capture in progress.
 *
 * Captures go through tools/archive.mjs (NOTES.md case 13), so every PNG is
 * traceable to the bundle that produced it and last round's pixels still exist
 * to diff against.
 *
 * Teardown contract: the preview server and the browser are registered with a
 * single shutdown routine wired to normal completion, thrown errors, SIGINT,
 * SIGTERM, uncaughtException and unhandledRejection BEFORE either is started.
 * Nothing is detached and the process always ends in an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5113;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 240_000;
/** Private build dir; never dist/, which three other harnesses also write. */
const BUILD_DIR = ".shot-build/pumps";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system3");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const LIFT = arg("lift", "");
const FUEL = arg("fuel", "");
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/**
 * Two kinds of pose.
 *
 * Absolute: `pos` in world metres, with `eye` metres above the walkable
 * surface at that XZ when present, and an absolute `look`.
 *
 * Anchored: `anchor` names something in the scene and the camera is placed at
 * `offset` metres from it, looking at it. Every tight pose is anchored,
 * because the tight ones are the ones that get framing wrong — the island cap
 * height is the sum of a height field, a slab and a curb reveal, and hand
 * arithmetic on that put the first nozzle capture 600 mm low and cost a round.
 * An anchored pose also survives the terrain system re-tuning under it.
 *
 * Island 0 is at z = 16.6 with dispensers at x = -2.4 and +2.4; island 1 is at
 * z = 23.2 with one at x = 0. Bollards sit at x = +-4.08 on each island.
 */
const POSES = {
  // Standing at the south face of the first dispenser, about to use it.
  pump_close: { pos: [-2.66, 0, 14.42], eye: 1.62, look: [-2.36, 1.62, 16.36], fov: 44 },
  // Off the -X end of pump 1, which is where the hose swivel is and where the
  // catenary loop shows its profile against the ground. Defect 1 lives here.
  hose: { pos: [-6.15, 0, 13.75], eye: 1.44, look: [-3.05, 1.22, 16.15], fov: 40 },
  // Tight on the boot, the nozzle and the scuff annulus. Defects 3 and 4.
  nozzle: { anchor: { face: "pump-1:south", part: "nozzle" }, offset: [-0.62, 0.06, -0.78], fov: 34 },
  // One bollard filling the frame. Far enough back that a 168 mm post is not
  // lens-distorted: the stock ratio is the thing being judged here.
  bollard: { anchor: { object: "bollard-1" }, offset: [-1.85, 0.30, -1.90], fov: 30 },
  // Three-quarter on the cabinet corner: the chamfer highlight and the plan
  // ratio are only legible from an angle that shows two faces at once.
  corner: { pos: [-4.95, 0, 13.55], eye: 1.55, look: [-2.40, 1.10, 16.55], fov: 42 },
  // The whole front island seen from the forecourt.
  island: { pos: [-9.6, 0, 11.6], eye: 1.65, look: [1.2, 1.15, 19.8], fov: 52 },
  // Distance silhouette. Defect 9 is judged here and nowhere else.
  wide: { pos: [-15.5, 0, 6.8], eye: 4.6, look: [7.5, 1.0, 27.0], fov: 58 },

  /*
   * read — the price head from where the game itself stands the player.
   *
   * The pump is one of three named interactions, so the display is something a
   * person stops and reads, and it has to be judged from the interaction stance
   * rather than a photogenic one. Both ends of this camera are *published
   * values*, not coordinates typed here: the eye is `standPosition`, which is
   * what `InteractionSystem` measures abandonment from, and the target is
   * `displayCentre`, which is the aim point for the click. Nothing to drift out
   * of agreement with the game, and if either moves the pose follows.
   *
   * fov 44 matches `pump_close`, so px-per-mm is comparable between them.
   */
  read: { stand: "pump-1:south", eye: 1.62, fov: 44 },

  /*
   * unit1/2/3 — the same camera in each dispenser's own local frame.
   *
   * These exist to answer one question that no other pose can: are the three
   * units actually different objects, or three copies? Any pose that sees more
   * than one pump sees each of them from a different angle and distance, so the
   * differences you are looking for are buried under perspective and shading,
   * and a critic and a builder can look at the same frame and honestly disagree
   * — which is exactly what happened on round 154136Z.
   *
   * `localTo` cancels the pump's world position *and* its yaw, so the three
   * frames are pixel-comparable: the cabinet lands on the same pixels in all
   * three, and `tools/diff.mjs unit1 unit2` is then a direct measurement of how
   * much the *asset* differs. Sun direction is still shared, which is the point
   * — it is the one thing that must not be cancelled, or a real difference in
   * shading would be mistaken for a difference in the unit.
   */
  /*
   * panels — raking, close, on the -Z cabinet face.
   *
   * Edge chamfers and shut lines are both millimetre features, and the poses
   * above cannot settle either: `corner` runs 3.37 mm/px on the cabinet, so a
   * 5 mm chamfer is 1.5 px and a 4 mm shut gap is 1.2 px there. This pose sits
   * 1.3 m out at fov 30, which is 0.78 mm/px — a chamfer is 6 px and a gap is
   * 5 px, so if the feature is absent it is absent, not merely unresolved.
   * Grazing on purpose: a rim line needs the key near the surface tangent.
   */
  panels: { localTo: "pump-1", eyeLocal: [0.95, 1.05, -1.05], at: [-0.10, 0.80, -0.36], fov: 30 },

  unit1: { localTo: "pump-1", eyeLocal: [-0.34, 1.28, -1.95], at: [0, 1.02, 0], fov: 42 },
  unit2: { localTo: "pump-2", eyeLocal: [-0.34, 1.28, -1.95], at: [0, 1.02, 0], fov: 42 },
  unit3: { localTo: "pump-3", eyeLocal: [-0.34, 1.28, -1.95], at: [0, 1.02, 0], fov: 42 },
};

const ALL = Object.keys(POSES);
const SHOTS = ONLY.length ? ALL.filter((s) => ONLY.includes(s)) : ALL;

/**
 * `--ab=<query>` — both arms of a comparison from one build, one server, one
 * browser, back to back.
 *
 * Every A/B this system has run was two rounds minutes or tens of minutes apart,
 * and in a tree six agents are committing to that is long enough for the
 * comparison to be about somebody else's work. It already happened: a +6.27 mean
 * luma tile confidently attributed to this system's base splash turned out to be
 * the car, and the -1.43 tile that replaced it turned out to be the shared
 * contact shadow landing. The arithmetic was right both times, including a
 * pre/post difference that mirrored the A/B exactly; the attribution was wrong,
 * and no amount of care inside one frame can fix a control captured against a
 * different tree.
 *
 * So the arms are captured in the same process. Nothing in `src/` can change
 * between them, which is the only way the difference is guaranteed to be the
 * flag.
 */
// Repeatable: `--ab=pseam=0 --ab=plip=0` gives three arms from one build, so two
// isolations can be compared against a control and against each other with no
// possibility of sibling drift between any pair.
const ABS = argv.filter((a) => a.startsWith("--ab=")).map((a) => a.slice(5)).filter(Boolean);
const JOBS = [];
for (const shot of SHOTS) {
  JOBS.push({ shot, query: QUERY, suffix: SUFFIX });
  ABS.forEach((ab, i) => {
    const tag = ab.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
    JOBS.push({ shot, query: [QUERY, ab].filter(Boolean).join("&"), suffix: `${SUFFIX}__${tag || `ab${i}`}` });
  });
}

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
  if (reason) console.error(`\n[shoot3] shutting down: ${reason}`);
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
      console.error(`[shoot3] failed to close ${label}: ${err?.message ?? err}`);
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
      if (announced) console.log(`[shoot3] :${port} free after ${((Date.now() - t0) / 1000) | 0}s`);
      return;
    }
    if (Date.now() - t0 > budgetMs) throw new Error(`port ${port} still busy after ${budgetMs} ms`);
    if (!announced) {
      announced = true;
      console.log(`[shoot3] :${port} is busy; waiting up to ${budgetMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Anything matching this in the console means a program never linked. */
const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;

/**
 * Identifiers that only appear in System 3's own injected GLSL — the grime
 * pass in `hardsurface.ts`. Three.js prints the offending source alongside the
 * info log, so a link failure in our chunk carries one of these.
 *
 * Deliberately an allowlist of OURS rather than a denylist of other systems'
 * prefixes: the denylist version silently treated a vegetation billboard's
 * `half` reserved-word error as ours and failed the whole run, and it would
 * have gone on missing every new foreign shader anybody added. A failure that
 * matches nothing is somebody else's and is reported loudly but not fatally —
 * a dead program anywhere still changes the frame.
 */
const MY_SHADER = /uG(Field|Scale|Film|Streak|Dust|Spots|Base|Rough|Focus|Scuff)|vGObj|vGNrm/;

/** Newest mtime AND a content hash of the private build directory. */
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
  if (!files.length) {
    // `--no-build` against a pruned or never-built directory used to print this
    // as a note and carry on, and the preview server then served nothing, so the
    // round died on `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE` — which
    // reads like a browser or network fault and was filed as one twice. The
    // cause is local and knowable before Chromium is ever launched.
    console.error(
      `[shoot3] FATAL: ${BUILD_DIR}/ is empty or missing, so there is nothing to serve.\n` +
        `         Drop --no-build. (This is what surfaces later as ERR_HTTP_RESPONSE_CODE_FAILURE.)`
    );
    process.exit(1);
  }
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
    console.log("[shoot3] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot3] bundle: ${stamp.text}`);

  await waitForPort(PORT, 240_000);

  console.log(`[shoot3] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot3] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shoot3", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const outDir = path.join(ROOT, "shots", SYSTEM);
  await fs.mkdir(outDir, { recursive: true });

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    bundleHash: stamp.hash,
    bundleMtime: stamp.iso,
    tag: "shoot3",
    extra: { presets: SHOTS, suffix: SUFFIX || null, query: QUERY || null, ab: ABS, lift: LIFT || null, fuel: FUEL || null },
  });

  const written = [];
  const failures = [];
  let reportedHandles = false;
  let foreignReported = false;
  // null until a page has actually been interrogated; see the note at finalise.
  let checkedSystemErrors = null;
  // Guards against the exact failure of tonight: a round that captures a scene
  // this system is not in.
  let sawPumpGeometry = false;

  for (const { shot, query: QUERY, suffix: SUFFIX } of JOBS) {
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || SHADER_FAIL.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    // `shot=system3` is not a preset in core/shots.ts, which is what we want:
    // the player controller disables itself but leaves the camera alone, so the
    // pose below is the only thing driving it.
    const parts = ["shot=system3", "gpu=1"];
    if (QUERY) parts.push(QUERY);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    // A page that renders is not the same as a page that is healthy. `Game`
    // catches per-system init failures so one broken system cannot blank the
    // scene (NOTES.md case 8), which means the pumps could be missing entirely
    // and the capture would still look plausible. Assert on the record.
    // The startup assertion above ran on a throwaway page that was then closed.
    // That proves the browser *can* get the discrete GPU, not that this context
    // still has it: a lost context is recovered on a software backend without
    // any error the page can see, so a round can begin on the 4060 and finish on
    // SwiftShader while every log line still says 4060. Re-read the renderer
    // string from the live context that is about to be photographed.
    const liveGpu = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") ?? c.getContext("webgl");
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    if (!liveGpu || !/nvidia|rtx|geforce/i.test(liveGpu) || /swiftshader|llvmpipe|software|angle \(google/i.test(liveGpu)) {
      failures.push(`${shot}: live context is not the hardware GPU: ${liveGpu ?? "no renderer string"}`);
      console.error(`[shoot3] FATAL live GPU for ${shot}: ${liveGpu}`);
    } else {
      console.log(`[shoot3] ${shot}: live GPU ${liveGpu}`);
    }

    // A control has to prove it was applied.
    //
    // This round's env A/B was captured with `?noenv=1`, which parses from
    // `?lforce=noenv` and therefore did nothing. The result was `changed=0,
    // max=2` against the normal frame — read as "the environment contributes
    // nothing to this scene", which is a dramatic finding and was false: the same
    // scene had been photographed twice. **A null result from a control that was
    // never applied is indistinguishable from a null result from one that was**,
    // and it manufactures a confident negative at exactly the moment you are
    // trying to rule something out.
    //
    // So rather than trusting the URL, read the effect back out of the running
    // scene and assert on it. This checks the *value the renderer will use*, not
    // the flag that was meant to set it, which also catches a flag that parses
    // and is then overwritten downstream.
    const live = await page.evaluate(() => {
      const g = window.__GAME;
      const sc = g?.scene;
      if (!sc) return null;
      let sun = null;
      sc.traverse((o) => {
        if (o.isDirectionalLight && (sun === null || o.intensity > sun)) sun = o.intensity;
      });
      // Proof of effect for `?pscuff=0`, which cannot be checked by counting
      // meshes because it zeroes an amplitude rather than removing geometry.
      // A null diff from an unapplied control is indistinguishable from a null
      // diff from an applied one, so the attribute itself is interrogated: with
      // scuff on, some vertex colour must depart from 1.0; with it off, none may.
      //
      // The first version of this matched `o.name.includes(":nozzle")`, and the
      // three nozzle meshes were the only unnamed meshes on the model — so it
      // matched none, sampled nothing, and reported a span of exactly 0, which
      // is also what a genuinely absent attribute looks like. **A probe that
      // samples nothing must say so rather than return zero**, so the sample
      // count is carried out alongside the value and checked first.
      let scuffSpan = 0;
      let scuffSamples = 0;
      const named = (o) => {
        for (let n = o; n; n = n.parent) if (n.name && n.name.includes(":nozzle")) return true;
        return false;
      };
      sc.traverse((o) => {
        if (!o.isMesh || !named(o)) return;
        const col = o.geometry?.getAttribute?.("color");
        if (!col) return;
        for (let i = 0; i < col.count; i += 7) {
          scuffSamples++;
          scuffSpan = Math.max(scuffSpan, Math.abs(col.getX(i) - 1), Math.abs(col.getZ(i) - 1));
        }
      });
      // Which pump sub-meshes exist. `?pseam=0` and `?plip=0` remove meshes, so
      // their absence is checkable and their presence is a control that failed.
      const suffixes = new Set();
      sc.traverse((o) => {
        if (!o.isMesh || !o.name) return;
        const m = /^pump-\d+:([a-z]+)/.exec(o.name);
        if (m) suffixes.add(m[1]);
      });
      return {
        pumpMeshes: [...suffixes].sort(),
        envIntensity: sc.environmentIntensity ?? null,
        hasEnvMap: !!sc.environment,
        sun,
        scuffSpan,
        scuffSamples,
        search: location.search,
      };
    });
    if (!live) {
      failures.push(`${shot}: could not read the live scene back to verify controls`);
    } else {
      console.log(
        `[shoot3] ${shot}: controls env=${live.envIntensity} envMap=${live.hasEnvMap} sun=${live.sun} ` +
          `meshes=[${live.pumpMeshes?.join(",")}] nozzleScuff=${live.scuffSpan?.toFixed(4)}/${live.scuffSamples} search=${live.search}`
      );
      // Both directions are checked: a part still present under `=0` means the
      // control silently failed, and a part absent without `=0` means the two
      // arms are the same scene. "lip" was on this list until the panel lip was
      // deleted, at which point the second check became true of a part that no
      // longer exists — a self-check outliving its subject reports a defect that
      // is really a stale expectation, so it comes off the list with the part.
      for (const [flag, name] of [
        ["pseam", "seam"],
        ["pweep", "weep"],
      ]) {
        const off = new RegExp(`(?:^|&)${flag}=0(?:&|$)`).test(QUERY);
        const present = live.pumpMeshes?.includes(name);
        if (off && present) {
          failures.push(
            `${shot}: CONTROL NOT APPLIED — asked for ${flag}=0 but a "${name}" mesh is still ` +
              `in the scene. Any A/B from this frame is worthless.`
          );
        }
        if (!off && !present) {
          failures.push(
            `${shot}: no "${name}" mesh exists although ${flag} was not disabled, so the ` +
              `control arm and the reference arm are the same scene.`
          );
        }
      }

      const scuffOff = /(?:^|&)pscuff=0(?:&|$)/.test(QUERY);
      if (scuffOff && live.scuffSpan > 1e-6) {
        failures.push(
          `${shot}: CONTROL NOT APPLIED — asked for pscuff=0 but nozzle vertex colour still ` +
            `departs from 1.0 by ${live.scuffSpan.toFixed(4)}.`
        );
      }
      if (!live.scuffSamples) {
        failures.push(
          `${shot}: the nozzle scuff probe sampled 0 vertices, so its span of ` +
            `${live.scuffSpan} is the absence of a measurement and not a measurement of absence.`
        );
      } else if (!scuffOff && live.scuffSpan < 1e-6) {
        failures.push(
          `${shot}: nozzle scuff is nominally on but no vertex colour departs from 1.0, so the ` +
            `attribute is absent or was overwritten. Nothing measured here is about scuff.`
        );
      }
      const want = /(?:^|&)env=([\d.]+)(?:&|$)/.exec(QUERY);
      if (want) {
        const expect = Number(want[1]);
        if (live.envIntensity === null || Math.abs(live.envIntensity - expect) > 1e-6) {
          failures.push(
            `${shot}: CONTROL NOT APPLIED — asked for env=${expect}, scene is running ` +
              `environmentIntensity=${live.envIntensity}. Any A/B from this frame is worthless.`
          );
        }
      }
      // Any unrecognised bare flag in QUERY is suspicious for the same reason.
      for (const kv of QUERY.split("&").filter(Boolean)) {
        const k = kv.split("=")[0];
        if (/^(no|force)/.test(k) && !/^lforce$/.test(k)) {
          console.warn(
            `[shoot3] WARNING: "${k}" is not a recognised bare query flag in this project. ` +
              `Debug switches parse from ?lforce=<csv>. A flag that does nothing is worse than no flag.`
          );
        }
      }
    }

    const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    checkedSystemErrors = sysErrs;
    if (sysErrs.length) {
      for (const e of sysErrs) console.error(`[shoot3] system ${e.system} failed in ${e.phase}: ${e.message}`);
      failures.push(`${sysErrs.length} system(s) failed to initialise: ${sysErrs.map((e) => e.system).join(", ")}`);
    }

    if (!reportedHandles) {
      reportedHandles = true;
      const h = await page.evaluate(() => {
        const g = window.__GAME;
        const pumps = g?.tryGet ? g.tryGet("pumps") : null;
        const faces = g?.tryGet ? g.tryGet("pumpFaces") : null;
        const byName = g?.tryGet ? g.tryGet("pumpsByName") : null;
        const pick = g?.tryGet ? g.tryGet("pumpPickables") : null;
        if (!Array.isArray(pumps)) return null;
        let tris = 0;
        let meshes = 0;
        for (const p of pumps) {
          p.root.traverse((o) => {
            if (o.isMesh && o.geometry) {
              meshes++;
              const gg = o.geometry;
              tris += gg.index ? gg.index.count / 3 : gg.attributes.position.count / 3;
            }
          });
        }
        return {
          pumps: pumps.length,
          faces: Array.isArray(faces) ? faces.length : null,
          byName: byName ? Object.keys(byName).length : null,
          pickables: Array.isArray(pick) ? pick.length : null,
          faceKeys: faces?.[0] ? Object.keys(faces[0]).sort() : null,
          meshes,
          tris: Math.round(tris),
        };
      });
      console.log(`[shoot3] pumps registry: ${JSON.stringify(h)}`);
      if (h && h.tris > 0 && h.pumps > 0) sawPumpGeometry = true;
      if (!h) failures.push('service "pumps" was never provided');
      else {
        if (h.pumps !== 3) failures.push(`expected 3 pumps, got ${h.pumps}`);
        if (h.faces !== 6) failures.push(`expected 6 pump faces, got ${h.faces}`);
        for (const k of ["name", "facing", "standPosition", "displayCentre", "pickables", "setDisplay",
          "resetDisplay", "setActive", "setNozzleLift", "getNozzleLift"]) {
          if (h.faceKeys && !h.faceKeys.includes(k)) failures.push(`PumpFaceHandle is missing "${k}"`);
        }
      }

      const rep = await page.evaluate(() => window.__PUMPS ?? null);
      if (rep) console.log(`[shoot3] __PUMPS: ${JSON.stringify(rep, null, 2).replace(/\n/g, "\n           ")}`);
      else console.warn("[shoot3] __PUMPS report absent");
    }

    if (FUEL !== "") {
      // A sale on the head, integrated with `InteractionSystem`'s own constants
      // so the frame shows a value the game could actually reach at that moment
      // rather than a round number chosen to flatter the digits. Set through the
      // published face handle, and echoed, because a display showing a plausible
      // value it was handed is not the same claim as a running session.
      const secs = Number(FUEL);
      const sale = await page.evaluate((t) => {
        const FLOW_GPS = 9.2 / 60;
        const SPINUP_S = 1.15;
        const TANK = 13.6;
        const TAPER = 0.55;
        const ss = (a, b, v) => {
          const x = Math.min(1, Math.max(0, (v - a) / (b - a)));
          return x * x * (3 - 2 * x);
        };
        // Fixed 1/120 s steps: the integral of a spin-up ramp is not the ramp,
        // and a closed form here would disagree with the running system.
        let gal = 0;
        for (let e = 0; e < t; e += 1 / 120) {
          gal = Math.min(TANK, gal + FLOW_GPS * ss(0, SPINUP_S, e) * ss(0, TAPER, TANK - gal) / 120);
        }
        const faces = window.__GAME?.tryGet ? window.__GAME.tryGet("pumpFaces") : null;
        if (!Array.isArray(faces) || !faces.length) return null;
        const f = faces.find((q) => q.name === "pump-1:south") ?? faces[0];
        const price = f.getDisplay().price;
        f.setActive(true);
        f.setDisplay({ dollars: gal * price, gallons: gal });
        f.setNozzleLift(0.8);
        const got = f.getDisplay();
        return { gallons: got.gallons, dollars: got.dollars, price, active: got.active };
      }, secs);
      if (!sale) failures.push(`${shot}: could not apply --fuel=${FUEL}`);
      else if (!sale.active) failures.push(`${shot}: --fuel set values but the head is not active`);
      else
        console.log(
          `[shoot3] ${shot}: head shows ${sale.gallons.toFixed(2)} gal ` +
            `$${sale.dollars.toFixed(2)} at $${sale.price.toFixed(3)}/gal after ${secs}s`
        );
    }

    if (LIFT !== "") {
      const t = Number(LIFT);
      const ok = await page.evaluate((v) => {
        const faces = window.__GAME?.tryGet ? window.__GAME.tryGet("pumpFaces") : null;
        if (!Array.isArray(faces)) return false;
        for (const f of faces) f.setNozzleLift(v);
        return true;
      }, t);
      if (!ok) failures.push(`${shot}: could not apply --lift=${LIFT}`);
    }

    const applied = await page.evaluate((p) => {
      const g = window.__GAME;
      if (!g) return { ok: false, why: "no __GAME" };
      const cam = g.camera;
      let pos;
      let look;

      if (p.localTo) {
        // Camera placed in the named object's own frame, so its world position
        // and yaw drop out and the three unit shots are directly comparable.
        // The matrix is applied by hand rather than through THREE.Vector3
        // because `window.__GAME` does not re-export the library.
        const o = g.scene.getObjectByName(p.localTo);
        if (!o) return { ok: false, why: `no object named "${p.localTo}"` };
        o.updateMatrixWorld(true);
        const e = o.matrixWorld.elements; // column-major
        const toWorld = (v) => [
          e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12],
          e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13],
          e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14],
        ];
        look = toWorld(p.at);
        pos = toWorld(p.eyeLocal);
      } else if (p.stand) {
        const faces = g.tryGet ? g.tryGet("pumpFaces") : null;
        if (!Array.isArray(faces)) return { ok: false, why: "no pumpFaces service" };
        const f = faces.find((q) => q.name === p.stand);
        if (!f) return { ok: false, why: `no pump face "${p.stand}"` };
        if (!f.standPosition || !f.displayCentre) {
          return { ok: false, why: `"${p.stand}" publishes no standPosition/displayCentre` };
        }
        look = [f.displayCentre.x, f.displayCentre.y, f.displayCentre.z];
        const gh = g.tryGet ? g.tryGet("groundHeight") : null;
        if (typeof gh !== "function") return { ok: false, why: "no groundHeight service" };
        pos = [f.standPosition.x, gh(f.standPosition.x, f.standPosition.z) + p.eye, f.standPosition.z];
      } else if (p.anchor) {
        // Resolve the anchor to a world point, then sit `offset` from it. No
        // silent fallback: a pose that cannot find its subject must fail the
        // capture rather than quietly photograph the forecourt (NOTES.md 15).
        /**
         * Centre of an object's rendered extent, in world space.
         *
         * Not its origin. Every pump part is baked into pump space and hung on
         * a group sitting at the pump's own origin on the island cap, so
         * `nozzle.matrixWorld` translates to the foot of the dispenser and the
         * first anchored nozzle capture came out 600 mm low and framed the
         * skid. A vertex-space bound cannot make that mistake.
         */
        const centreOf = (o) => {
          o.updateMatrixWorld(true);
          const lo = [Infinity, Infinity, Infinity];
          const hi = [-Infinity, -Infinity, -Infinity];
          const seen = { n: 0 };
          o.traverse((m) => {
            if (!m.isMesh || !m.geometry) return;
            m.geometry.computeBoundingBox();
            const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
            lo[0] = Math.min(lo[0], bb.min.x);
            lo[1] = Math.min(lo[1], bb.min.y);
            lo[2] = Math.min(lo[2], bb.min.z);
            hi[0] = Math.max(hi[0], bb.max.x);
            hi[1] = Math.max(hi[1], bb.max.y);
            hi[2] = Math.max(hi[2], bb.max.z);
            seen.n++;
          });
          if (!seen.n) return null;
          return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        };

        let at = null;
        if (p.anchor.object) {
          const o = g.scene.getObjectByName(p.anchor.object);
          if (!o) return { ok: false, why: `no object named "${p.anchor.object}"` };
          at = centreOf(o);
          if (!at) return { ok: false, why: `"${p.anchor.object}" has no mesh geometry` };
        } else if (p.anchor.face) {
          const faces = g.tryGet ? g.tryGet("pumpFaces") : null;
          if (!Array.isArray(faces)) return { ok: false, why: "no pumpFaces service" };
          const f = faces.find((q) => q.name === p.anchor.face);
          if (!f) return { ok: false, why: `no pump face "${p.anchor.face}"` };
          if (p.anchor.part === "nozzle") {
            at = centreOf(f.nozzle);
            if (!at) return { ok: false, why: `"${p.anchor.face}" nozzle has no geometry` };
          } else {
            at = [f.displayCentre.x, f.displayCentre.y, f.displayCentre.z];
          }
        }
        if (!at) return { ok: false, why: "anchor did not resolve" };
        look = at;
        pos = [at[0] + p.offset[0], at[1] + p.offset[1], at[2] + p.offset[2]];
      } else {
        pos = p.pos.slice();
        look = p.look.slice();
        if (p.eye !== undefined) {
          const gh = g.tryGet ? g.tryGet("groundHeight") : null;
          if (typeof gh !== "function") return { ok: false, why: "no groundHeight service" };
          pos[1] = gh(pos[0], pos[2]) + p.eye;
        }
      }

      cam.position.set(pos[0], pos[1], pos[2]);
      cam.up.set(0, 1, 0);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(look[0], look[1], look[2]);
      cam.fov = p.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return { ok: true, y: pos[1], pos, look };
    }, POSES[shot]);

    if (!applied.ok) {
      failures.push(`${shot}: could not apply pose (${applied.why})`);
      await page.close();
      continue;
    }

    // Let the pose settle: anything that refits against the camera each frame
    // (shadow frusta, LOD) needs a full update or the depth pass disagrees
    // with the colour pass.
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
      `[shoot3] ${shot.padEnd(11)} -> ${path.relative(ROOT, file)}  eye y=${applied.y.toFixed(2)}  ` +
        `(${Date.now() - t0} ms)  bundle ${stamp.iso} sha1:${stamp.hash}`
    );

    const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
    const mine = shaderProblems.filter((p) => MY_SHADER.test(p));
    const foreign = shaderProblems.filter((p) => !MY_SHADER.test(p));
    if (mine.length) failures.push(`${shot}: shader failure -> ${mine[0].slice(0, 400)}`);
    if (foreign.length && !foreignReported) {
      foreignReported = true;
      console.warn(
        `[shoot3] NOTE: another system's shader failed to link. Not fatal here, but it is\n` +
          `         changing the frame. First 300 chars:\n         ${foreign[0].slice(0, 300).replace(/\n/g, "\n         ")}`
      );
    }
    if (problems.length) console.warn(`[shoot3]   page problems: ${problems.length} (first: ${problems[0].slice(0, 200)})`);
    await page.close();
  }

  await context.close();

  // Any non-empty `__SYSTEM_ERRORS` condemns the round, whoever owns the entry.
  //
  // This used to log another system's failure and archive the round anyway, on
  // the reasoning that a foreign failure is not this system's bug. That
  // reasoning is wrong about what a round is *for*. `Game.ts` catches an init
  // throw, records it, disables that system and carries on, so the frame still
  // renders and still looks plausible — and tonight a missing import in a live
  // edit disabled *this* system while the capture continued, which would have
  // produced eleven pump-free frames with a manifest and a GPU assertion on
  // them. A shot of a scene with a system missing is not weak evidence about
  // that scene; it is evidence about a different scene.
  //
  // So the round is marked unjudgeable on disk rather than merely reported at
  // the end, where a caller reading the last line can miss it. The general form:
  // **a system that degrades gracefully is indistinguishable from one that works
  // at a glance**, so the check has to be somewhere a glance cannot skip.
  if (checkedSystemErrors === null) {
    failures.push("no page was ever interrogated for __SYSTEM_ERRORS");
  } else if (checkedSystemErrors.length) {
    const who = [...new Set(checkedSystemErrors.map((e) => e.system))].join(", ");
    failures.push(`round is UNJUDGEABLE: system(s) disabled during capture: ${who}`);
    await fs.writeFile(
      path.join(round.dir, "DO-NOT-JUDGE"),
      `__SYSTEM_ERRORS was not empty during this round, so at least one system was\n` +
        `disabled and the frames are of a different scene than the one intended.\n\n` +
        checkedSystemErrors.map((e) => `${e.system} failed in ${e.phase}: ${e.message}`).join("\n") +
        "\n"
    );
    console.error(`[shoot3] wrote DO-NOT-JUDGE: ${who} disabled`);
  }

  // A pump-free capture is the specific failure this system has to be able to
  // detect, and the registry check above only runs on the first shot. Assert it
  // reached a non-zero triangle count at all.
  if (!sawPumpGeometry) failures.push("no pump geometry was ever counted in this round");

  // `systemErrors` is deliberately null-or-array: null records "this harness
  // never looked", which is a different and much worse state than [] meaning
  // "looked, and the scene was healthy".
  const { manifest } = await round.finalise({
    gpu: gpuInfo?.renderer ?? null,
    gpuInfo: gpuInfo ?? null,
    systemErrors: checkedSystemErrors,
    keep: 10,
  });
  console.log(
    `\n[shoot3] ${written.length}/${SHOTS.length} screenshots -> ${path.relative(ROOT, round.dir)}\n` +
      `[shoot3] mirrored to ${path.join("shots", SYSTEM)}  round ${round.id}` +
      `  manifest ${manifest ? "written" : "MISSING"}`
  );
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
