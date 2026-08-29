#!/usr/bin/env node
/**
 * How long does it take to be able to walk around, and why is the first time
 * so much worse than every time after it?
 *
 *   node tools/coldload.mjs              # build, then cold / warm / cold again
 *   node tools/coldload.mjs --no-build   # reuse the last build
 *   node tools/coldload.mjs --runs 3     # extra cold profiles, for variance
 *
 * ## The question
 *
 * Perf measured 218.7 s, 171.9 s and one hard tab crash on *first* loads,
 * against a steady 20.8-21.9 s on repeats, across three independent sequences.
 * That is a 3-10x gap, and the number the user will actually experience is the
 * slow one, because their first load of this scene is a first load. Confirming
 * the gap is worth little on its own; what changes the advice is *what makes a
 * load cold*, and there are several candidates that a single stopwatch cannot
 * tell apart:
 *
 * - **The GPU program cache.** Chrome compiles GLSL to a driver binary and
 *   caches it on disk, keyed to the browser profile and the driver version. If
 *   this is the cause, the penalty is paid roughly once per machine and the
 *   right advice is "load it once before you record".
 * - **The HTTP cache.** Only ~2 requests and a few MB of bundle, so this should
 *   be small, but it is free to rule out.
 * - **Neither.** If a fresh profile is fast and the very first run of the
 *   session is slow regardless, it is the driver or the OS, and the advice is
 *   different again.
 *
 * So this does not time "the app". It runs the same page under three conditions
 * that differ in exactly one thing each, and reports where the time goes inside
 * each load rather than only the total.
 *
 * ## Why a persistent profile rather than the usual launch
 *
 * Every other harness here uses `browser.newContext()`, which is deliberately
 * incognito — a fresh cache and a fresh GPU program cache every single time. In
 * other words **every measurement this project has ever taken of load time was
 * a cold one, and none of them could have observed the warm case at all.** A
 * cold-versus-warm question cannot be asked without a profile on disk that
 * survives between loads, which is what `launchPersistentContext` gives.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOptions, assertSceneGpu, readGpuInfo } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join("shots", "coldload", ".build");
const OUT_DIR = path.join(ROOT, "shots", "coldload");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
/**
 * Overridable, and deliberately outside the block every other harness draws
 * from: this one may need to run alongside the quiet window rather than inside
 * it, so whoever is scheduling should be able to move it without editing a file
 * they do not own.
 */
const PORT = opt("port", 5171);
const COLD_RUNS = opt("runs", 2);
/**
 * Generous, because the thing being measured is reported to take three minutes
 * and to sometimes crash. A timeout shorter than the phenomenon turns "slow" into
 * "failed" and loses the number.
 */
const LOAD_TIMEOUT_MS = opt("timeout", 420) * 1000;

/**
 * Installed before any module runs, so the clock starts at navigation rather
 * than at whenever the test got around to asking.
 *
 * `Game` already publishes the two milestones this needs — it removes the
 * loading overlay on rendered frame 2 and sets `__SCENE_READY` on frame 6 — so
 * this listens for those rather than polling for a guess at readiness. What it
 * adds is the split *before* the first frame, which is where a procedural scene
 * spends its time: module evaluation, then every system's `init()` generating
 * geometry on the CPU, then the first frame, which is where the driver compiles
 * every shader the scene uses.
 */
/**
 * Injected **after the navigation commits**, not as an init script.
 *
 * ## Why, and how the first version failed
 *
 * The first version was an `addInitScript` that set up an object, added a
 * `scene-ready` listener on `window`, attached a `MutationObserver`, and started
 * a rAF loop. All eight loads came back with an empty frame array and no
 * first-frame mark, while the scene demonstrably rendered 235 frames.
 *
 * `document.documentElement` **is null in an init script** — measured, not
 * assumed: `readyState` is `"loading"` and `documentElement` reads `NULL`. So
 * `observe(document.documentElement, ...)` throws
 * `TypeError: parameter 1 is not of type 'Node'`, and **Playwright swallows
 * exceptions thrown by init scripts** — nothing reaches `pageerror`, nothing is
 * logged, the run continues. Every statement after the throw, including the rAF
 * registration, simply never happened.
 *
 * What made it hard to see is that the survivors looked like a working probe.
 * The object was readable and the `scene-ready` mark was correct, because both
 * were established *before* the throwing line. So the probe reported an empty
 * frames array whose `Math.max` is `-Infinity`, and an unset mark that a
 * division turned into a confident `0.0 s`.
 *
 * **The boundary between what worked and what did not was exactly the line that
 * threw**, which is what identified it. Ordering is diagnostic when a script
 * dies halfway.
 *
 * Injecting after commit removes the whole class: the document exists, an
 * exception surfaces as a rejected `evaluate`, and `performance.now()` still
 * measures from this document's time origin so no precision is lost.
 */
const RECORDER = () => {
  const L = { t0: performance.now(), marks: {}, frames: [], armed: true };
  window.__LOAD = L;
  window.addEventListener("scene-ready", () => {
    L.marks.sceneReady = performance.now() - L.t0;
    // Where readiness falls in the frame record, so the enormous single "frame"
    // that is really the synchronous init block can be reported as what it is
    // rather than contaminating the after-load frame statistics.
    L.marks.readyAtFrame = L.frames.length;
  });

  // Frame 2 is where Game removes the overlay. Absence is not removal — a naive
  // "is it gone?" fires immediately on a document that has not parsed the node
  // yet — so this waits until it has been seen present.
  let seen = !!document.getElementById("loading");
  new MutationObserver(() => {
    if (document.getElementById("loading")) seen = true;
    else if (seen && L.marks.firstFrames === undefined) {
      L.marks.firstFrames = performance.now() - L.t0;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Per-frame times, so "interactive" can be defined as the scene actually
  // holding a frame rate rather than as a milestone having fired. A scene that
  // reaches frame 6 and then spends four seconds compiling a shader the moment
  // you turn around is not interactive, and a milestone cannot tell you that.
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    L.frames.push(+(now - last).toFixed(2));
    last = now;
    if (L.frames.length < 900) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { armed: true, documentElement: document.documentElement?.tagName ?? null };
};

/** First moment the scene holds a frame budget for a sustained stretch. */
function settled(frames, budgetMs = 25, need = 30) {
  let run = 0;
  let elapsed = 0;
  for (let i = 0; i < frames.length; i++) {
    elapsed += frames[i];
    run = frames[i] <= budgetMs ? run + 1 : 0;
    if (run >= need) return { atMs: elapsed, frame: i };
  }
  return null;
}

async function measure(page, url) {
  const started = Date.now();
  let crashed = null;
  page.on("crash", () => (crashed = "the tab crashed"));
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 60_000 });
    // After commit, so the document exists and a failure here is loud.
    const armed = await page.evaluate(RECORDER);
    if (!armed?.armed || !armed.documentElement) {
      throw new Error(`the frame recorder did not arm (documentElement: ${armed?.documentElement})`);
    }
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  } catch (e) {
    return { failed: crashed ?? e.message.split("\n")[0], wallMs: Date.now() - started };
  }
  // Let the frame recorder run on past readiness, because the interesting
  // stalls are after it.
  await page.waitForTimeout(6000);
  const load = await page.evaluate(() => ({
    marks: window.__LOAD.marks,
    frames: window.__LOAD.frames,
    programs: window.__GAME?.renderer?.info?.programs?.length ?? null,
    errors: (window.__SYSTEM_ERRORS ?? []).map((e) => `${e.system}/${e.phase}: ${e.message}`),
    contextLost: window.__CONTEXT_LOST ?? null,
  }));
  /**
   * The liveness guard. An empty frames array is not a fast scene, it is an
   * instrument that never ran, and the two are indistinguishable downstream:
   * `Math.max()` of nothing is `-Infinity` and a null mark divided by 1000 prints
   * as `0.0`. So the count is carried through and every derived figure is null
   * unless the recorder actually produced samples.
   */
  const live = load.frames.length > 0;
  /**
   * Split at readiness. The frame record spans the load, and `Game.start()`
   * builds the whole world synchronously — so the main thread is blocked and rAF
   * cannot fire, which the recorder sees as one "frame" of 13 s warm and 242 s
   * cold. That is a real and useful number, but it is a measure of the init
   * block, not of a hitch while playing, and mixing the two makes the worst-frame
   * figure meaningless in both directions.
   */
  const after = live ? load.frames.slice(load.marks.readyAtFrame ?? 0) : [];
  const s = after.length ? settled(after) : null;
  return {
    wallMs: Date.now() - started,
    recorded: load.frames.length,
    afterReady: after.length,
    firstFramesMs: load.marks.firstFrames ?? null,
    sceneReadyMs: load.marks.sceneReady ?? null,
    settledMs: s ? Math.round((load.marks.sceneReady ?? 0) + s.atMs) : null,
    blockMs: live ? Math.max(...load.frames) : null,
    worstAfterMs: after.length ? Math.max(...after) : null,
    programs: load.programs,
    errors: load.errors,
    contextLost: load.contextLost,
  };
}

/** Seconds, or an em dash — never a zero standing in for "not measured". */
const secs = (ms) => (ms === null || ms === undefined ? "—" : (ms / 1000).toFixed(1) + " s");

const results = [];
const profiles = [];

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (!flag("no-build")) {
    const t = Date.now();
    console.log("[cold] building");
    await build({ root: ROOT, logLevel: "error", build: { outDir: BUILD_DIR, target: "es2022", sourcemap: false } });
    console.log(`[cold] build: ${((Date.now() - t) / 1000).toFixed(1)} s`);
    results.push({ label: "vite build", wallMs: Date.now() - t, kind: "build" });
  }

  const server = await preview({
    root: ROOT,
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`[cold] serving ${url}`);

  try {
    for (let run = 1; run <= COLD_RUNS; run++) {
      // A directory that has never seen this page: no HTTP cache, and no GPU
      // program cache, which is the candidate this whole test exists to check.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dawn-cold-"));
      profiles.push(dir);
      const ctx = await chromium.launchPersistentContext(dir, {
        ...launchOptions(),
        viewport: { width: 1600, height: 900 },
      });
      try {
        const page = await ctx.newPage();
        page.on("console", (m) => {
          const t = m.text();
          if (/error|fail|shader|lost/i.test(t) && m.type() !== "debug") console.log(`    page: ${t.slice(0, 160)}`);
        });

        console.log(`\n[cold] run ${run}: COLD — brand new browser profile`);
        const cold = await measure(page, url);
        results.push({ label: `cold #${run} (new profile)`, ...cold });
        report(cold);
        if (run === 1 && !cold.failed) {
          const gpu = await readGpuInfo(page);
          console.log(`  GPU: ${gpu.renderer}`);
          await assertSceneGpu(page, { tag: "cold", when: "after the cold load" });
        }

        // Same profile, same page: the HTTP cache and the GPU program cache are
        // now both warm, so this is the repeat load Perf measured at ~21 s.
        console.log(`[cold] run ${run}: WARM — same profile, reloaded`);
        await page.evaluate(() => {
          window.__SCENE_READY = false;
        });
        const warm = await measure(page, url);
        results.push({ label: `warm #${run} (same profile, reload)`, ...warm });
        report(warm);

        // And once more with the HTTP cache bypassed but the profile — and so
        // the shader cache — still warm. If this is fast, the bundle is not the
        // cost and the shaders are.
        console.log(`[cold] run ${run}: WARM, HTTP CACHE BYPASSED`);
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        const nocache = await measure(page, url);
        results.push({ label: `warm #${run}, no HTTP cache`, ...nocache });
        report(nocache);
      } finally {
        await ctx.close().catch(() => {});
      }

      /**
       * The condition that decides what we tell the user, and the one nothing
       * else here can reach.
       *
       * Perf established that the penalty recurs in every fresh browser
       * *process*, and reasoned from that to Chrome's per-profile on-disk
       * program cache: Playwright throws its profile away on every launch, a
       * real user keeps theirs. That is a good deduction and the README is
       * about to be rewritten on the strength of it — telling the user the
       * three-minute wait is a one-time cost they keep across restarts and
       * reboots, rather than a toll they pay every session.
       *
       * But the deduction has never been tested, because testing it needs a
       * profile directory that outlives a browser process, and every harness in
       * this project discards the profile with the process. So the same
       * directory is reopened here in a brand new browser: the process is cold,
       * the profile is warm, and nothing else differs.
       *
       * Fast means the warmth is genuinely on disk and the kind advice is true.
       * Slow means the warm state was only ever process-local memory, the
       * per-profile cache is not what carries it, and the user pays three
       * minutes *every time they open their browser* — which is the opposite of
       * what we are about to promise them, and much worse to discover from a
       * user than from a test.
       */
      console.log(`[cold] run ${run}: NEW PROCESS, WARM PROFILE — the same profile directory reopened`);
      const again = await chromium.launchPersistentContext(dir, {
        ...launchOptions(),
        viewport: { width: 1600, height: 900 },
      });
      try {
        const page = await again.newPage();
        const survived = await measure(page, url);
        results.push({ label: `new process #${run}, warm profile`, ...survived });
        report(survived);
      } finally {
        await again.close().catch(() => {});
      }
    }
  } finally {
    await server.close().catch(() => {});
  }

  table();
}

function report(r) {
  if (r.failed) {
    console.log(`    FAILED after ${(r.wallMs / 1000).toFixed(1)} s — ${r.failed}`);
    return;
  }
  console.log(
    `    total ${secs(r.wallMs)} | scene-ready ${secs(r.sceneReadyMs)} | ` +
      `main thread blocked ${r.blockMs === null ? "—" : (r.blockMs / 1000).toFixed(1) + " s"} in one go | ` +
      `walkable ${r.settledMs === null ? (r.afterReady ? "never" : "not measured") : secs(r.settledMs)} | ` +
      `worst frame after ready ${r.worstAfterMs === null ? "—" : r.worstAfterMs.toFixed(0) + " ms"} | ` +
      `${r.programs} programs`
  );
  if (!r.recorded) console.log(`    WARNING the frame recorder produced no samples; walkability is unmeasured, not good`);
  for (const e of r.errors) console.log(`    SYSTEM ERROR ${e}`);
  if (r.contextLost) console.log(`    CONTEXT LOST ${JSON.stringify(r.contextLost)}`);
}

function table() {
  console.log("\n[cold] ===================== summary =====================");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("condition", 34) + pad("total", 10) + pad("blocked", 11) + pad("walkable", 11) + "worst frame after ready");
  for (const r of results) {
    if (r.kind === "build") {
      console.log(pad(r.label, 34) + pad((r.wallMs / 1000).toFixed(1) + " s", 10));
      continue;
    }
    if (r.failed) {
      console.log(pad(r.label, 34) + pad((r.wallMs / 1000).toFixed(1) + " s", 10) + "FAILED — " + r.failed);
      continue;
    }
    console.log(
      pad(r.label, 34) +
        pad(secs(r.wallMs), 10) +
        pad(secs(r.blockMs), 11) +
        pad(r.settledMs === null ? (r.afterReady ? "never" : "—") : secs(r.settledMs), 11) +
        (r.worstAfterMs === null ? "—" : r.worstAfterMs.toFixed(0) + " ms")
    );
  }

  const cold = results.filter((r) => r.label?.startsWith("cold") && !r.failed);
  const warm = results.filter((r) => r.label?.startsWith("warm #") && r.label.endsWith("reload)") && !r.failed);
  const nocache = results.filter((r) => r.label?.includes("no HTTP cache") && !r.failed);
  const survivors = results.filter((r) => r.label?.startsWith("new process") && !r.failed);
  const mean = (a) => (a.length ? a.reduce((s, r) => s + r.wallMs, 0) / a.length / 1000 : null);
  const c = mean(cold);
  const w = mean(warm);
  const n = mean(nocache);
  const s = mean(survivors);
  console.log("");
  if (c && w) {
    console.log(`[cold] cold mean ${c.toFixed(1)} s against warm mean ${w.toFixed(1)} s — ${(c / w).toFixed(1)}x`);
    if (n) {
      // A warm profile with the HTTP cache disabled still has the compiled
      // shaders on disk; if that is fast, the bundle is not what makes a cold
      // load cold.
      console.log(
        `[cold] warm with the HTTP cache disabled: ${n.toFixed(1)} s — ` +
          (n < w * 1.5
            ? "bundle transfer is NOT the cost, so the penalty is the GPU program cache or CPU-side first-run work"
            : "bundle transfer is a material part of the cost")
      );
    }
    if (s) {
      // What the user is told hangs on this line.
      const carries = s < w * 1.8;
      console.log(
        `[cold] new browser process against a warm profile: ${s.toFixed(1)} s — ` +
          (carries
            ? `the warmth SURVIVES a browser restart, so the wait is a one-time cost per profile ` +
              `and the README's advice holds`
            : `the warmth DOES NOT survive a browser restart (${(s / w).toFixed(1)}x the warm load), so it was ` +
              `process-local, the per-profile cache is not what carries it, and the user pays this EVERY SESSION ` +
              `— the README must not promise a one-time cost`)
      );
    } else if (survivors.length) {
      console.log(`[cold] new browser process against a warm profile: every attempt FAILED, which is itself the answer`);
    }
  }
  const failures = results.filter((r) => r.failed);
  if (failures.length) console.log(`[cold] ${failures.length} of ${results.length - 1} loads failed outright`);
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error(`\n[cold] FAILED: ${e.message}`);
  code = 1;
} finally {
  for (const d of profiles) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
}
process.exit(code);
