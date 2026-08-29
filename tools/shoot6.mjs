#!/usr/bin/env node
/**
 * Screenshot harness for System 6 (vegetation, distant landscape, edges).
 *
 *   node tools/shoot6.mjs                                  # all presets
 *   node tools/shoot6.mjs --shots=horizon,edge
 *   node tools/shoot6.mjs --no-build --query=vforce=noline --suffix=_noline
 *
 * Port 5119, and it builds into `.shot-build/system6/` rather than the shared
 * `dist/`. That is not tidiness: four other agents build this repo
 * concurrently, and a capture pointed at `dist/` photographs whatever bundle
 * happened to be on disk when the browser fetched it. The bundle hash and
 * local mtime are printed on every captured line, and the hash is re-checked
 * after the last shot — a run whose bundle moved underneath it fails.
 *
 * Hard failures, all after full teardown:
 *   - a software rasteriser (never pass --enable-unsafe-swiftshader)
 *   - any shader compile or link error in the console
 *   - a non-empty window.__SYSTEM_ERRORS (Game.ts now isolates a throwing
 *     system instead of blanking the page, so a broken system is invisible
 *     unless something checks that array)
 *   - window.__VEGETATION missing, or reporting that it built nothing
 *
 * Teardown contract: SIGINT / SIGTERM / uncaughtException / unhandledRejection
 * handlers are installed BEFORE the preview server or the browser is started,
 * both are closed on every exit path, and the process always ends in an
 * explicit process.exit(). Nothing is detached and nothing is left resident.
 *
 * Captures go through `tools/archive.mjs`, so each run lands in its own
 * `shots/system6/rounds/<UTC>-<hash>/` with a manifest, and the familiar
 * `shots/system6/<preset>.png` paths survive as copies. A round is finalised on
 * the failure paths too — a run that failed is exactly the run somebody wants to
 * look at afterwards.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { openRound } from "./archive.mjs";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "system6");
const PORT = 5119;
const READY_TIMEOUT_MS = 240_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system6");
const QUERY = arg("query", "");
const SUFFIX = arg("suffix", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
/**
 * `--ab=<query>` captures both arms of a comparison inside one process.
 *
 * Adopted from the pumps harness after a cross-round diff in this system
 * produced a confident, entirely false finding. Two arms shot as separate runs
 * are separated by a rebuild, and six agents commit continuously, so the diff
 * measures every edit anyone made in between and attributes all of it to yours.
 * It is most convincing exactly when it should be least believed: this system
 * "measured" a sprig-only edit moving the pine crowns and the sky, wrote it up
 * as a shared-uniform leak, and reverted a correct fix — the real cause was
 * another agent touching LightingSystem between the builds.
 *
 * One build, one preview, one browser, two pages. Nothing in `src/` can change
 * between the arms because no rebuild happens between them.
 */
const AB = arg("ab", "");
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
const LENIENT = argv.includes("--lenient");

import { POSES, WIDTH, HEIGHT } from "./vegposes.mjs";

const ALL = Object.keys(POSES);
const SHOTS = ONLY.length ? ALL.filter((s) => ONLY.includes(s)) : ALL;

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
  if (reason) console.error(`\n[shoot6] shutting down: ${reason}`);
  const closers = [
    // First, so that a round interrupted by Ctrl-C still gets its manifest and
    // is identifiable later as partial rather than looking like a clean run.
    [
      "archive round",
      async () => {
        const r = resources.round;
        if (!r) return;
        resources.round = null;
        await r.finalise({
          gpu: resources.gpu,
          systemErrors: resources.sysErrors,
          keep: 10,
          outcome: reason ? "failed" : "ok",
          failure: reason ?? null,
        });
        console.log(`[shoot6] round ${r.id} -> ${path.relative(ROOT, r.dir)}`);
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
      console.error(`[shoot6] failed to close ${label}: ${err?.message ?? err}`);
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
const SHADER_FAIL =
  /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS|THREE\.WebGLProgram/i;

/**
 * A poisoned environment map, which is worse than a crash because it is silent.
 *
 * NaN or Inf anywhere in the PMREM propagates through every material that
 * samples it, and the frame comes back black or as a pure silhouette with
 * `window.__SYSTEM_ERRORS` still empty — so every existing assertion in this
 * harness passes. Two other agents lost rounds to it before anyone knew to look,
 * and for this system the failure is especially treacherous: a silhouetted frame
 * looks exactly like the foliage defects I have spent several rounds chasing —
 * dark crowns, no sunlit/shadow separation, a flat horizon band. I would have
 * read it as my own bug.
 */
const WORLD_UNSAFE = /non-finite|NaN|Infinity/;

// Word boundaries, and case-sensitive for the two JS literals, because the first
// version of this guard failed all six frames of a healthy round on its very
// first run. It matched this benign line:
//
//   [lighting] env mean luminance 0.0741 (max 2.85)
//
// "lumi-NAN-ce". A case-insensitive substring search for "NaN" matches the middle
// of "luminance", and of "nanometre", and of "finance". Had I shipped this to the
// other five harnesses as it stood, I would have broken every capture in the
// project with a guard whose entire purpose was to stop rounds being lost.
//
// Two things worth keeping from it. `NaN` and `Infinity` are JS literals with
// fixed casing, so the `/i` that felt like safety was the whole bug — being
// permissive about a token with exactly one correct spelling only widens the
// false-positive surface. And a guard that fires on healthy frames gets deleted
// by whoever it annoys, at which point it protects nobody; so the frame-content
// check below matters more than this pattern, because it cannot be fooled by
// prose. On this round it was the content check that was right: it passed all six
// frames at sky 123-143 and lower third 22-54 while this line was failing them.

/**
 * Refuse a frame that cannot be a dawn scene, whatever the console said.
 *
 * The console pattern above only fires if whoever poisoned the environment
 * happens to be logging about it. This is the backstop that needs no cooperation
 * from another system: it reads the PNG that was just written and checks the
 * three things that were true of both observed failures and are never true of a
 * healthy capture.
 *
 * Thresholds are set well below measured-healthy rather than near it, because
 * this must not start rejecting legitimately dark dawn frames. Healthy rounds of
 * mine measure sky 122-136, lower third 24-27, near-black 23-33%. The poisoned
 * rounds measured lower third **exactly 0.0** and near-black 55-68%, and the
 * other agents' were black frame-wide.
 */
async function assertFrameIsLit(file, label, failures) {
  const png = PNG.sync.read(await fs.readFile(file));
  let sky = 0, skyN = 0, low = 0, lowN = 0, dark = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (l < 24) dark++;
      if (y < png.height / 8) { sky += l; skyN++; }
      else if (y > (png.height * 2) / 3) { low += l; lowN++; }
    }
  }
  const skyMean = sky / skyN;
  const lowMean = low / lowN;
  const darkPct = (dark / (png.width * png.height)) * 100;
  if (skyMean < 55)
    failures.push(`${label}: sky mean luma ${skyMean.toFixed(1)} — frame is black, not a dawn sky`);
  if (lowMean < 8)
    failures.push(
      `${label}: lower-third mean luma ${lowMean.toFixed(1)} — ground is unlit. ` +
        `Check the environment map for non-finite values before blaming any system's geometry`
    );
  if (darkPct > 50)
    failures.push(`${label}: ${darkPct.toFixed(1)}% of pixels near-black — frame is a silhouette`);
  return { skyMean, lowMean, darkPct };
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
  const hash = h.digest("hex").slice(0, 12);
  const mtime = new Date(newest).toLocaleString("sv-SE");
  return { hash, mtime, text: `${hash} built ${mtime}` };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[shoot6] building into .shot-build/system6 ...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot6] bundle ${stamp.text}`);
  if (stamp.hash === "missing") throw new Error("no bundle in .shot-build/system6 — run without --no-build");

  console.log(`[shoot6] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot6] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(gpuPage, { tag: "shoot6", allowSoftware: ALLOW_SOFTWARE });
  resources.gpu = gpuInfo?.renderer ?? gpuInfo?.unmaskedRenderer ?? String(gpuInfo ?? "unknown");
  await gpuPage.close();

  const round = await openRound({
    root: ROOT,
    system: SYSTEM,
    tag: "shoot6",
    bundleHash: stamp.hash,
    bundleMtime: stamp.mtime,
    extra: { port: PORT, viewport: `${WIDTH}x${HEIGHT}`, query: QUERY || null, suffix: SUFFIX || null },
  });
  resources.round = round;
  console.log(`[shoot6] round ${round.id}`);

  const written = [];
  const failures = [];
  let reported = false;

  /*
   * The arms. With no `--ab` this is a single arm and the loop below is exactly
   * the old behaviour, same filenames and all.
   */
  const ARMS = AB
    ? [
        { query: QUERY, suffix: SUFFIX, label: "A" },
        { query: [QUERY, AB].filter(Boolean).join("&"), suffix: `${SUFFIX}_ab`, label: "B" },
      ]
    : [{ query: QUERY, suffix: SUFFIX, label: null }];
  /** Per-shot record of what each arm echoed, so the pair can be checked. */
  const armEcho = new Map();

  for (const shot of SHOTS) {
   for (const arm of ARMS) {
    const pose = POSES[shot];
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" || SHADER_FAIL.test(t) || WORLD_UNSAFE.test(t)) problems.push(`console: ${t}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    // `shot=system6` is not a preset any system claims, so PlayerSystem
    // disables its controller and leaves the camera to the pose below.
    const parts = ["shot=system6", "gpu=1"];
    if (arm.query) parts.push(arm.query);
    const url = `${base}?${parts.join("&")}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

    const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
    resources.sysErrors = sysErrors;
    if (!Array.isArray(sysErrors)) failures.push(`${shot}: window.__SYSTEM_ERRORS was never published`);
    else if (sysErrors.length) {
      failures.push(
        `${shot}: ${sysErrors.length} system(s) failed -> ` +
          sysErrors.map((e) => `${e.system}.${e.phase}: ${e.message}`).join(" | ")
      );
    }

    {
      const veg = await page.evaluate(() => window.__VEGETATION ?? null);
      // Recorded for every arm, printed for the first. The record is what makes
      // an A/B pair checkable rather than merely captured: an arm whose flag
      // silently failed to apply produces two identical frames and a diff of
      // zero, which reads as "no effect" and is the failure this whole flag
      // exists to prevent.
      if (arm.label) {
        armEcho.set(`${shot}:${arm.label}`, {
          force: veg?.force ?? null,
          scatter: veg?.debrisScatter?.built ?? null,
          sizeScale: veg?.debrisScatter?.sizeScale ?? null,
        });
      }
      if (!reported) {
      reported = true;
      console.log(`[shoot6] __VEGETATION: ${JSON.stringify(veg)}`);
      }
      if (!veg) failures.push("window.__VEGETATION was never published — VegetationSystem did not run");
      else if (!LENIENT) {
        const need = ["horizonTriangles", "pines", "foliageCards", "clumps", "poles", "fencePosts"];
        for (const k of need) if (!veg[k]) failures.push(`__VEGETATION.${k} is ${veg[k]} — nothing was built`);
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
    // be in place for a full update before the depth pass agrees with the
    // colour pass.
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
      // The GPU is re-read here, from the live context that just drew this
      // frame, and not only from the throwaway probe page at startup.
      //
      // The startup check proves less than it looks like it proves: it runs in
      // a different page, and Playwright has been observed adding
      // `--enable-unsafe-swiftshader` to the Chromium command line regardless
      // of what the harness passes. So "the browser could reach the 4060 once,
      // eight minutes ago, in another tab" is not the claim anyone needs. The
      // claim needed is "this frame was drawn on the 4060", and the only place
      // that can be established is the context that drew it.
      let renderer = "unknown";
      try {
        const gl = r.getContext();
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      } catch {
        renderer = "unavailable";
      }
      return { calls: r.info.render.calls, tris: r.info.render.triangles, renderer };
    });

    // Fatal, for the same reason a shader link failure is fatal: a frame drawn
    // by a software rasteriser is not evidence about the frame we ship, and
    // silently accepting one turns every measurement in the round into fiction.
    const liveGpu = stats?.renderer ?? "unknown";
    if (!ALLOW_SOFTWARE && /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(liveGpu)) {
      failures.push(`${shot}: drawn on a software renderer at sample time -> ${liveGpu}`);
    }
    if (liveGpu !== "unknown" && liveGpu !== "unavailable" && resources.gpu && liveGpu !== resources.gpu) {
      failures.push(
        `${shot}: live GPU differs from the startup probe -> sample "${liveGpu}" vs startup "${resources.gpu}"`
      );
    }

    const file = await round.save(`${shot}${arm.suffix}`, (dest) => page.screenshot({ path: dest, type: "png" }));
    written.push(file);
    const lit = await assertFrameIsLit(file, shot, failures);
    console.log(
      `[shoot6] ${(arm.label ? `${shot}[${arm.label}]` : shot).padEnd(9)} -> ${path.relative(ROOT, file)}  eye y=${applied.y.toFixed(2)}  ` +
        `draws=${stats?.calls ?? "?"} tris=${stats?.tris ?? "?"}  ` +
        `gpu=${/NVIDIA|RTX/i.test(liveGpu) ? "hw" : liveGpu}  ` +
        `sky=${lit.skyMean.toFixed(0)} low=${lit.lowMean.toFixed(0)} black=${lit.darkPct.toFixed(0)}%  ` +
        `(${Date.now() - t0} ms)  bundle ${stamp.text}`
    );

    const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
    if (shaderProblems.length) failures.push(`${shot}: shader failure -> ${shaderProblems[0]}`);
    const worldProblems = problems.filter((p) => WORLD_UNSAFE.test(p));
    if (worldProblems.length)
      failures.push(
        `${shot}: the environment map is not finite, so nothing in this frame can be trusted -> ` +
          worldProblems[0]
      );
    if (problems.length) console.warn(`[shoot6]   page problems:\n    ${problems.slice(0, 8).join("\n    ")}`);
    await page.close();
   }
  }

  /*
   * The pair check. Both arms came from one build in one browser, so the bundle
   * is identical by construction rather than by assertion — but "the flag was
   * applied" is not, and that is the half that has actually failed here before.
   * If the two arms echo the same state, the B arm did nothing and any diff
   * taken from the pair measures noise while looking like a clean negative.
   */
  if (AB) {
    console.log(`\n[shoot6] A/B pairs, one bundle ${stamp.text}, arms differ only by "${AB}":`);
    for (const shot of SHOTS) {
      const a = armEcho.get(`${shot}:A`);
      const b = armEcho.get(`${shot}:B`);
      if (!a || !b) {
        failures.push(`${shot}: A/B requested but one arm never echoed __VEGETATION`);
        continue;
      }
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      console.log(`[shoot6]   ${shot.padEnd(9)} A ${sa}`);
      console.log(`[shoot6]   ${" ".repeat(9)} B ${sb}`);
      if (sa === sb) {
        failures.push(
          `${shot}: the B arm echoed the same state as A, so "${AB}" changed nothing in the scene. ` +
            `Any diff from this pair is noise. Check the token is one VegetationSystem parses.`
        );
      }
    }
  }

  await context.close();

  const after = await bundleStamp();
  if (after.hash !== stamp.hash) {
    failures.push(`bundle changed mid-capture: ${stamp.hash} -> ${after.hash}. Every shot above is suspect.`);
  }

  console.log(
    `\n[shoot6] ${written.length}/${SHOTS.length} screenshots -> ${path.relative(ROOT, round.dir)}` +
      ` (stable copies in ${path.join("shots", SYSTEM)})`
  );
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
