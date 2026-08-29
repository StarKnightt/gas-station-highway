#!/usr/bin/env node
/**
 * Performance and stability harness.
 *
 *   node tools/perf.mjs                    # baseline + 45 s simulated walk
 *   node tools/perf.mjs --seconds=180      # leak hunt over a longer walk
 *   node tools/perf.mjs --systems          # per-system sweep (?skip= / ?solo=)
 *   node tools/perf.mjs --no-build         # reuse .shot-build/perf
 *   node tools/perf.mjs --shots            # every pose in src/core/shots.ts
 *   node tools/perf.mjs --lights           # what each class of light costs
 *   node tools/perf.mjs --ab='a=x=1;b=x=2' # arbitrary query-flag comparison
 *
 * Each run copies src/ into `.perf-snapshot/` and builds from there, so that a
 * measurement is not silently taken against a tree that six agents are editing
 * underneath it (`--no-snapshot` opts out; `--no-build` re-uses the previous
 * snapshot's build). **Delete `.perf-snapshot/` when you are done with a round
 * of measuring** — while it exists the repo contains a second, stale copy of
 * every source file, and the next agent to grep for a symbol will find both.
 *
 * Port 5152 is reserved for this harness. 5150, 5151 and the six system agent
 * ports (5112/5113/5116/5119/5125/5131/5132) belong to other processes and are
 * never touched.
 *
 * Teardown contract copied from tools/shoot.mjs: the preview server and browser
 * are registered with one shutdown routine wired to every exit path before
 * either is started, and the process always ends in an explicit process.exit().
 *
 * Hardware GPU is mandatory (tools/gpu.mjs). `--allow-software` is deliberately
 * NOT offered: every number this tool prints would be meaningless on a CPU
 * rasteriser, and a meaningless number that looks like a measurement is the
 * single most expensive failure mode this project has.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { assertHardwareGpu, assertSceneGpu, launchOptions, launchWarmProfile, isSoftwareRenderer } from "./gpu.mjs";
import { assertPrivateBuildDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const BUILD_DIR = ".shot-build/perf";
const WIDTH = 1920;
const HEIGHT = 1080;
const READY_TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
/** `--warm` reuses a persistent profile; see the launch site for why this is opt-in. */
const WARM_PROFILE = process.argv.includes("--warm");
const SECONDS = Number(arg("seconds", "45"));
const DO_BUILD = !argv.includes("--no-build");
const DO_SYSTEMS = argv.includes("--systems");
const TAG = arg("tag", "run");
const SNAPSHOT = !argv.includes("--no-snapshot");
const SHOTS = argv.includes("--shots");

const SYSTEMS = ["lighting", "terrain", "pumps", "car", "player", "building", "vegetation", "audio", "interaction"];

/* ------------------------------------------------------------------ */
/* teardown, wired before anything starts                              */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

function withTimeout(p, ms, what) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[perf] shutting down: ${reason}`);
  for (const [label, fn] of [
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
  ]) {
    try {
      await withTimeout(fn(), 10_000, label);
    } catch (err) {
      console.error(`[perf] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  const stillUp = await portInUse(PORT).catch(() => null);
  console.log(`[perf] teardown: port ${PORT} ${stillUp ? "STILL LISTENING (!)" : "free"}`);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

function portInUse(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    setTimeout(() => {
      s.destroy();
      res(false);
    }, 1200).unref?.();
  });
}

/**
 * Card-level VRAM, from nvidia-smi.
 *
 * The in-page GL accounting says what *this* scene asked for. It cannot say
 * how close the card is to full, and on a machine where six other agents are
 * rendering the same scene concurrently that is the number that decides
 * whether the page survives. Sampled by the harness itself so the series lines
 * up with the phase labels instead of having to be matched up by wall clock.
 */
function gpuMemory() {
  return new Promise((res) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) return res(null);
        const [used, total, util] = String(stdout).trim().split(/,\s*/).map(Number);
        res({ usedMiB: used, totalMiB: total, utilPct: util, freeMiB: total - used });
      }
    );
  });
}

/* ------------------------------------------------------------------ */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

/**
 * Frame-time distribution. The "1% low" is the *mean of the slowest 1% of
 * frames*, which is the figure that corresponds to what a scene feels like when
 * it hitches — not p99, which is a single sample and moves around.
 */
function frameStats(dts) {
  if (!dts.length) return null;
  const s = [...dts].sort((a, b) => a - b);
  const worstN = Math.max(1, Math.round(s.length * 0.01));
  const worst = s.slice(-worstN);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    frames: s.length,
    meanMs: +mean.toFixed(2),
    medianMs: +pct(s, 50).toFixed(2),
    p95Ms: +pct(s, 95).toFixed(2),
    p99Ms: +pct(s, 99).toFixed(2),
    maxMs: +s[s.length - 1].toFixed(2),
    onePctLowMs: +(worst.reduce((a, b) => a + b, 0) / worst.length).toFixed(2),
    meanFps: +(1000 / mean).toFixed(1),
    onePctLowFps: +(1000 / (worst.reduce((a, b) => a + b, 0) / worst.length)).toFixed(1),
    over33ms: s.filter((d) => d > 33.4).length,
    over100ms: s.filter((d) => d > 100).length,
  };
}

function linreg(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return { slope: sxx ? sxy / sxx : 0, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

const MB = (b) => +(b / 1048576).toFixed(2);

async function makePage(context, instrument, probe) {
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") problems.push(`console: ${t}`);
    else if (m.type() === "warning" && /WebGL|shader|memory|context/i.test(t)) problems.push(`warn: ${t}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("crash", () => problems.push("PAGE CRASHED"));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  await page.addInitScript({ content: instrument });
  await page.addInitScript({ content: probe });
  page.__problems = problems;
  return page;
}

async function loadScene(page, base, query) {
  const url = `${base}${query ? `?${query}` : ""}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  try {
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  } catch (err) {
    if (page.__problems.length) console.error(`[perf] never ready. Page said:\n    ${page.__problems.join("\n    ")}`);
    throw err;
  }
  // The launch-time check was on a throwaway canvas before this page existed.
  // This one is on the context that just drew the scene. See gpu.mjs.
  await assertSceneGpu(page, { tag: "perf", when: `after ready (${query || "no flags"})` });
  return Date.now() - t0;
}

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");
  const probe = await fs.readFile(path.join(ROOT, "tools/perf-probe.js"), "utf8");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);

  const out = { tag: TAG, when: new Date().toISOString(), viewport: [WIDTH, HEIGHT], seconds: SECONDS };

  // Six agents edit `src/` continuously; two builds ten minutes apart are two
  // different programs, and half of one measurement pass was spent on a tree
  // that had a syntax error in it when the build ran. Copying the sources into
  // a private snapshot first means every number in a run refers to one bundle,
  // and the snapshot timestamp says which. It lives inside the repo so Node
  // still resolves the shared `node_modules` by walking up.
  let root = ROOT;
  const snap = path.join(ROOT, ".perf-snapshot");
  if (SNAPSHOT && !DO_BUILD) {
    // Re-measuring the bundle a previous run already built. Re-copying would
    // point the preview server at a snapshot that no longer matches it.
    root = snap;
    console.log(`[perf] reusing the existing snapshot build in .perf-snapshot`);
  } else if (SNAPSHOT) {
    await fs.rm(snap, { recursive: true, force: true });
    await fs.mkdir(snap, { recursive: true });
    for (const f of ["src", "index.html", "vite.config.ts", "tsconfig.json"]) {
      await fs.cp(path.join(ROOT, f), path.join(snap, f), { recursive: true });
    }
    root = snap;
    out.snapshotAt = new Date().toISOString();
    console.log(`[perf] snapshot of src/ taken at ${out.snapshotAt} -> .perf-snapshot`);
  }

  if (DO_BUILD) {
    console.log("[perf] building...");
    lowerPriority();
    // Unminified so the allocation stacks the instrumentation captures name
    // real functions. Minification changes no GPU behaviour; it only decides
    // whether the 268 MB allocation is attributable or anonymous.
    assertPrivateBuildDir(ROOT, BUILD_DIR, "perf");
    await build({ root, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }

  console.log(`[perf] preview on :${PORT}`);
  resources.server = await preview({
    root,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  const before = await gpuMemory();
  out.gpuMemoryBeforeLaunch = before;
  if (before) {
    console.log(`[perf] card before launch: ${before.usedMiB} / ${before.totalMiB} MiB used (${before.freeMiB} MiB free), ${before.utilPct}% busy`);
    if (before.freeMiB < 1500) {
      console.warn(
        `[perf] WARNING: only ${before.freeMiB} MiB of VRAM free before this run starts. Other GPU processes ` +
          `(sibling capture harnesses, the desktop) already hold the card. Frame times below are contended and ` +
          `the page may be evicted mid-run.`
      );
    }
  }

  // `--warm` reuses a persistent profile so the driver shader cache survives
  // between runs, turning a 192-349 s cold load into ~21 s.
  //
  // Deliberately OPT-IN rather than the default, unlike `stress.mjs`. This
  // harness *reports* `readyMs` as a headline figure, so warming the profile
  // silently changes what that number means — from "what a user waits for on
  // first open" to "what a repeat load costs". Those differ by 10x here, and a
  // run that quietly swapped one for the other would look healthier and be
  // wrong. Use `--warm` when init is setup cost; leave it off when init is the
  // measurement. Either way the profile state is printed next to the number.
  if (WARM_PROFILE) {
    resources.context = await launchWarmProfile({ tag: "perf", viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    resources.browser = resources.context.browser();
    for (const pg of resources.context.pages()) await pg.close().catch(() => {});
  } else {
    resources.browser = await chromium.launch(launchOptions());
  }
  // A browser that dies takes every subsequent measurement with it and the
  // Playwright error ("Target page, context or browser has been closed") names
  // the symptom, not the cause. Record the moment and the card state instead.
  out.browserDeath = null;
  resources.browser.on("disconnected", async () => {
    out.browserDeath = { at: new Date().toISOString(), phase: out.phase ?? "unknown" };
    console.error(`[perf] !! BROWSER PROCESS DISCONNECTED during phase "${out.phase ?? "unknown"}"`);
  });
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "perf" });
  if (isSoftwareRenderer(gpu.renderer)) throw new Error("software renderer");
  if (!/rtx|nvidia|geforce/i.test(String(gpu.renderer))) {
    console.warn(`[perf] WARNING: adapter is not the discrete NVIDIA part: ${gpu.renderer}`);
  }
  await gpuPage.close();
  out.gpu = gpu;

  /* ---------------- baseline: full scene, static ---------------- */
  if (!argv.includes("--no-baseline")) {
  out.phase = "baseline";
  console.log(`\n[perf] === baseline: full scene, ${WIDTH}x${HEIGHT} ===`);
  const page = await makePage(context, instrument, probe);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  // Poll the heap while the scene generates. The steady-state heap says nothing
  // about the peak: every procedural texture is built as a JS typed array first,
  // and a page that dies during generation dies here, not later.
  const initTrack = [];
  let polling = true;
  const poller = (async () => {
    const t = Date.now();
    while (polling) {
      try {
        const m = await cdp.send("Performance.getMetrics");
        const g = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
        initTrack.push({ s: +((Date.now() - t) / 1000).toFixed(1), heapMB: MB(g("JSHeapUsedSize")), totalMB: MB(g("JSHeapTotalSize")) });
      } catch {
        /* page navigating */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // `--query=` puts flags on the baseline load too, so a leak hunt can be run
  // against `?skip=audio` and compared with the same walk against the full
  // scene. Without it the only configurable phase is the sweep, which does not
  // walk and therefore cannot see anything that grows over time.
  const baseQuery = arg("query", "");
  const readyMs = await loadScene(page, base, baseQuery);
  polling = false;
  await poller;
  const peakInit = initTrack.reduce((a, b) => (b.heapMB > a.heapMB ? b : a), { heapMB: 0, s: 0 });
  out.initHeap = { track: initTrack, peakMB: peakInit.heapMB, peakAtS: peakInit.s };
  console.log(`[perf] scene ready in ${(readyMs / 1000).toFixed(1)}s (${WARM_PROFILE ? "WARM profile: a repeat-load figure" : "cold profile: a first-open figure"})   peak JS heap during generation ${peakInit.heapMB} MB (at t=${peakInit.s}s)`);

  // Settle: let lazily compiled programs and mipmaps land before the snapshot.
  await page.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n < 60 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); }));

  const atReady = await page.evaluate(() => window.__PERF.sceneStats());
  out.baseline = atReady;
  out.baseline.readyMs = readyMs;
  out.baseline.problems = [...page.__problems];

  printStatic(atReady, readyMs);

  /* ---------------- the walk ---------------- */
  console.log(`\n[perf] === walking for ${SECONDS}s (real PlayerSystem, W held, yaw swept) ===`);
  // Allocation sampling with stacks. The heap trace shows sawtooth churn; only
  // this says which function is producing it, and guessing from a read of the
  // update() methods is exactly the kind of plausible-but-unverified answer
  // this project keeps getting burnt by.
  let allocProfile = null;
  try {
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384 });
  } catch (e) {
    console.warn(`[perf] allocation sampling unavailable: ${e?.message ?? e}`);
  }
  // Snapshot the listener census so the walk's delta can be attributed. Init
  // registers a fixed set once; anything that appears between here and the end
  // of the walk is per-play, which is the kind that ends a long session.
  const listenersAtStart = await page.evaluate(() => JSON.parse(JSON.stringify(window.__GLSTAT.listeners)));
  await page.evaluate(() => { window.__PERF.startSampling(); window.__PERF.startWalk(); });

  const heapTrack = [];
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SECONDS) {
    await new Promise((r) => setTimeout(r, 3000));
    const m = await cdp.send("Performance.getMetrics");
    const get = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    const live = await page.evaluate(() => ({
      texMB: +(window.__GLSTAT.live.texBytes / 1048576).toFixed(2),
      bufMB: +(window.__GLSTAT.live.bufBytes / 1048576).toFixed(2),
      rboMB: +(window.__GLSTAT.live.rboBytes / 1048576).toFixed(2),
      texCount: window.__GLSTAT.live.texCount,
      geoms: window.__GAME.renderer.info.memory.geometries,
      texs: window.__GAME.renderer.info.memory.textures,
      programs: window.__GAME.renderer.info.programs?.length ?? 0,
      nodes: window.__GAME.scene.children.length,
      lost: window.__GLSTAT.contextLost.length,
    }));
    const row = {
      s: +((Date.now() - t0) / 1000).toFixed(1),
      heapMB: MB(get("JSHeapUsedSize")),
      heapTotalMB: MB(get("JSHeapTotalSize")),
      docs: get("Documents"),
      nodes: get("Nodes"),
      listeners: get("JSEventListeners"),
      ...live,
    };
    heapTrack.push(row);
    process.stdout.write(
      `  t=${String(row.s).padStart(5)}s  heap ${String(row.heapMB).padStart(7)} MB  ` +
        `glTex ${String(row.texMB).padStart(8)} MB (${row.texCount})  glBuf ${String(row.bufMB).padStart(7)} MB  ` +
        `geoms ${row.geoms}  texs ${row.texs}  progs ${row.programs}${row.lost ? "  CONTEXT LOST" : ""}\n`
    );
  }

  const endPos = await page.evaluate(() => window.__PERF.stopWalk());
  const samples = await page.evaluate(() => window.__PERF.stopSampling());
  const listenersAtEnd = await page.evaluate(() => JSON.parse(JSON.stringify(window.__GLSTAT.listeners)));
  out.walk = { samples: samples.length, endPos, heapTrack };

  out.walk.listenerDelta = Object.entries(listenersAtEnd.byKey)
    .map(([k, n]) => ({ key: k, added: n - (listenersAtStart.byKey[k] || 0), stack: (listenersAtEnd.stacks[k] || [])[0] || "" }))
    .filter((r) => r.added > 0)
    .sort((a, b) => b.added - a.added);

  // Discard the first 2 s: shader compilation for newly visible material
  // variants lands there and is a one-off, not a steady-state cost.
  const warm = samples.filter((s) => s.t - samples[0].t > 2000);
  out.walk.frame = frameStats(warm.map((s) => s.dt));
  out.walk.frameAll = frameStats(samples.map((s) => s.dt));

  const steady = warm;
  out.walk.perFrame = {
    drawsMedian: median(steady.map((s) => s.draws)),
    drawsMax: Math.max(...steady.map((s) => s.draws)),
    trisMedian: Math.round(median(steady.map((s) => s.tris))),
    trisMax: Math.round(Math.max(...steady.map((s) => s.tris))),
    infoCallsMedian: median(steady.map((s) => s.infoCalls)),
    texUploadFrames: steady.filter((s) => s.texCalls > 0).length,
    texUploadCalls: steady.reduce((a, s) => a + s.texCalls, 0),
    texUploadMB: MB(steady.reduce((a, s) => a + s.texBytes, 0)),
    bufUploadFrames: steady.filter((s) => s.bufCalls > 0).length,
    bufUploadCalls: steady.reduce((a, s) => a + s.bufCalls, 0),
    programLinksAfterWarm: steady.reduce((a, s) => a + s.progLinked, 0),
    readPixelFrames: steady.filter((s) => s.reads > 0).length,
    readPixelCalls: steady.reduce((a, s) => a + s.reads, 0),
  };

  const xs = heapTrack.map((h) => h.s);
  out.walk.growth = {
    heapMBPerMin: +(linreg(xs, heapTrack.map((h) => h.heapMB)).slope * 60).toFixed(3),
    heapR2: +linreg(xs, heapTrack.map((h) => h.heapMB)).r2.toFixed(3),
    glTexMBPerMin: +(linreg(xs, heapTrack.map((h) => h.texMB)).slope * 60).toFixed(3),
    glBufMBPerMin: +(linreg(xs, heapTrack.map((h) => h.bufMB)).slope * 60).toFixed(3),
    geomsPerMin: +(linreg(xs, heapTrack.map((h) => h.geoms)).slope * 60).toFixed(2),
    texsPerMin: +(linreg(xs, heapTrack.map((h) => h.texs)).slope * 60).toFixed(2),
    programsPerMin: +(linreg(xs, heapTrack.map((h) => h.programs)).slope * 60).toFixed(2),
    listenersPerMin: +(linreg(xs, heapTrack.map((h) => h.listeners)).slope * 60).toFixed(2),
  };

  try {
    const r = await cdp.send("HeapProfiler.stopSampling");
    allocProfile = summariseAlloc(r.profile, SECONDS);
    await cdp.send("HeapProfiler.disable");
  } catch {
    /* already reported above */
  }
  out.walk.alloc = allocProfile;
  if (allocProfile) {
    console.log(`\n  allocation during the walk: ${allocProfile.totalMB} MB total, ${allocProfile.mbPerMin} MB/min. Top sites:`);
    for (const s of allocProfile.top) console.log(`     ${String(s.mb).padStart(8)} MB  ${s.where}`);
  }

  out.walk.after = await page.evaluate(() => window.__PERF.sceneStats());
  out.walk.problems = page.__problems.filter((p) => !out.baseline.problems.includes(p));
  printWalk(out);

  await page.close();
  }

  /* ---------------- sweeps ---------------- */
  const sweep = async (title, configs, walkMs, walk = true) => {
    /* `cfg.fx` is a page-side mutation applied after the scene is ready and
     * before the measurement window, so an experiment that needs a runtime
     * change (lights off, shadows off) does not need a source edit in a file
     * another agent owns. */
    const rows = [];
    console.log(`\n[perf] === ${title} (${configs.length} loads) ===`);
    for (const cfg of configs) {
      const p = await makePage(context, instrument, probe);
      const rec = { label: cfg.label, query: cfg.q };
      out.phase = `${title}/${cfg.label}`;
      rec.gpuBefore = await gpuMemory();
      try {
        rec.readyMs = await loadScene(p, base, cfg.q);
        if (cfg.fx) {
          // A bare *expression* string, not a function literal: Playwright
          // evaluates a string as an expression, so `() => f()` returns an
          // unserialisable function (undefined) and the mutation never runs —
          // which produced six identical rows that looked like a null result.
          rec.fxResult = await p.evaluate(cfg.fx);
          console.log(`     fx applied: ${JSON.stringify(rec.fxResult ?? null).slice(0, 200)}`);
          if (rec.fxResult == null) throw new Error(`fx "${cfg.fx}" returned nothing; the experiment did not run`);
        }
        // Long settle: a light-count change recompiles every program, and
        // measuring across the recompile would report the compile, not the frame.
        await p.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n < 120 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); }));
        // Never drive the camera on a `?shot=` row: the pose is the whole point
        // of those, and a walk would make two rows uncomparable and any pixel
        // diff between them meaningless.
        const doWalk = walk && !cfg.q.includes("shot=");
        rec.walked = doWalk;
        await p.evaluate((w) => { window.__PERF.startSampling(); if (w) window.__PERF.startWalk(); }, doWalk);
        await new Promise((r) => setTimeout(r, walkMs));
        if (doWalk) await p.evaluate(() => window.__PERF.stopWalk());
        const sm = await p.evaluate(() => window.__PERF.stopSampling());
        const st = await p.evaluate(() => window.__PERF.sceneStats());
        const wm = sm.filter((s) => s.t - sm[0].t > 2000);
        rec.frame = frameStats(wm.map((s) => s.dt));
        rec.draws = median(wm.map((s) => s.draws));
        rec.tris = Math.round(median(wm.map((s) => s.tris)));
        rec.glTexMB = MB(st.gl.live.texBytes);
        rec.glBufMB = MB(st.gl.live.bufBytes);
        // Uploaded-minus-live is what generation cost at its peak, which is the
        // number that decides whether the page survives loading rather than how
        // fast it runs once loaded.
        rec.glUploadMB = MB(st.gl.tex.bytes);
        rec.glTransientMB = MB(st.gl.tex.bytes - st.gl.live.texBytes);
        rec.programs = st.renderer.programs;
        rec.objects = st.counts.objects;
        rec.textures = st.counts.textures;
        rec.sceneTris = st.totals.tris;
        rec.sceneTexMB = MB(st.totals.texBytes);
        rec.shadow = st.lights.filter((l) => l.castShadow).map((l) => l.mapSize?.join("x"));
        rec.systemErrors = st.systemErrors.map((e) => `${e.system}/${e.phase}: ${e.message}`);
        rec.roots = st.roots;
        rec.glBiggest = st.glBiggest.slice(0, 6).map((b) => `${b.w}x${b.h}=${MB(b.bytes)}MB`);
        rec.unmasked = st.renderer.unmasked;
        rec.contextLost = st.renderer.contextLost || st.glExtras.contextLost.length > 0;
        if (isSoftwareRenderer(rec.unmasked)) {
          // Every number in this row is now meaningless. Say so in the row
          // rather than letting a CPU-rendered frame time sit in the table.
          rec.error = `SOFTWARE RENDERER MID-RUN: ${rec.unmasked} — row is void`;
        }
      } catch (err) {
        rec.error = String(err?.message ?? err);
      }
      if (SHOTS && !rec.error) {
        try {
          const dir = path.join(ROOT, "tools/perf-out/perf-shots");
          await fs.mkdir(dir, { recursive: true });
          rec.shot = path.join(dir, `${title.replace(/[^a-z0-9]+/gi, "-")}-${cfg.label.replace(/[^a-z0-9]+/gi, "-")}.png`);
          await p.screenshot({ path: rec.shot, type: "png" });
        } catch {
          /* a frame we cannot photograph is reported by the row, not fatal */
        }
      }
      rec.gpuAfter = await gpuMemory();
      rows.push(rec);
      console.log(
        `  ${cfg.label.padEnd(18)} ready ${String(((rec.readyMs ?? 0) / 1000).toFixed(1)).padStart(5)}s  ` +
          `draws ${String(rec.draws ?? "-").padStart(5)}  tris ${String(rec.tris ?? "-").padStart(9)}  ` +
          `glTex ${String(rec.glTexMB ?? "-").padStart(8)} MB (+${String(rec.glTransientMB ?? "-").padStart(6)} transient)  progs ${String(rec.programs ?? "-").padStart(3)}  ` +
          `mean ${String(rec.frame?.meanMs ?? "-").padStart(6)} ms  1%low ${String(rec.frame?.onePctLowMs ?? "-").padStart(7)} ms` +
          `  vram ${String(rec.gpuBefore?.usedMiB ?? "-").padStart(5)}->${String(rec.gpuAfter?.usedMiB ?? "-").padStart(5)} MiB` +
          (rec.systemErrors?.length ? `  ERRORS: ${rec.systemErrors.join(" | ")}` : "") +
          (rec.error ? `  FAILED: ${rec.error.split("\n")[0]}` : "")
      );
      try {
        await p.close();
      } catch {
        /* the browser may already be gone; the row above records that */
      }
      if (!resources.browser?.isConnected()) {
        console.error(`[perf] browser is gone; abandoning the rest of "${title}"`);
        break;
      }
    }
    return rows;
  };

  if (DO_SYSTEMS) {
    out.systems = await sweep(
      "per-system sweep",
      [{ label: "all", q: "" }, ...SYSTEMS.map((s) => ({ label: `skip:${s}`, q: `skip=${s}` }))],
      9000
    );
    printSystems(out);
  }

  const AB = arg("ab", "");
  if (AB) {
    out.ab = await sweep(
      "A/B sweep",
      AB.split(";").filter(Boolean).map((pair) => {
        const i = pair.indexOf("=");
        return { label: pair.slice(0, i), q: pair.slice(i + 1) };
      }),
      12000
    );
  }

  if (argv.includes("--lights")) {
    // Held at a fixed pose so the only difference between rows is the lighting
    // configuration. A free walk samples different views each run and cannot
    // support a difference this size being read as a light cost.
    const at = (fx) => fx;
    out.lights = await sweep(
      "lighting cost A/B (fixed pose, shot=pumps)",
      [
        { label: "as-shipped", q: "shot=pumps" },
        { label: "no rect-area", q: "shot=pumps", fx: at(`window.__PERF.setLights({ rect: false })`) },
        { label: "no point/spot", q: "shot=pumps", fx: at(`window.__PERF.setLights({ point: false, spot: false })`) },
        { label: "sun+hemi only", q: "shot=pumps", fx: at(`window.__PERF.setLights({ rect: false, point: false, spot: false })`) },
        { label: "no sun shadow", q: "shot=pumps", fx: at(`window.__PERF.setSunShadow(false)`) },
        { label: "sun+hemi, no shadow", q: "shot=pumps", fx: at(`[window.__PERF.setLights({ rect: false, point: false, spot: false }).length, window.__PERF.setSunShadow(false)]`) },
        // Same shadow resolution, same depth texture, R8 instead of RGBA8 for
        // the colour attachment three allocates and never reads.
        { label: "R8 shadow colour", q: "shot=pumps", fx: at(`window.__PERF.shrinkShadowColour()`) },
      ],
      10000,
      false
    );
  }

  const POSES = arg("poses", "");
  if (POSES) {
    // Deterministic camera poses. A free walk samples a different set of views
    // every run, so it cannot compare two builds; ?shot= can.
    out.poses = await sweep(
      "fixed-pose sweep",
      POSES.split(",").filter(Boolean).map((s) => ({ label: s, q: `shot=${s}` })),
      8000,
      false
    );
  }

  await context.close();

  await fs.mkdir(path.join(ROOT, "tools/perf-out"), { recursive: true });
  const file = path.join(ROOT, `tools/perf-out/perf-${TAG}.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  console.log(`\n[perf] full record -> ${path.relative(ROOT, file)}`);

  const fatal = [];
  if (out.baseline?.systemErrors?.length) fatal.push(`__SYSTEM_ERRORS: ${out.baseline.systemErrors.map((e) => e.system).join(",")}`);
  if (out.baseline?.glExtras?.contextLost?.length) fatal.push("webgl context lost during baseline");
  if (out.browserDeath) fatal.push(`browser process died during "${out.browserDeath.phase}"`);
  if (fatal.length) console.error(`[perf] FATAL: ${fatal.join("; ")}`);
  await shutdown(fatal.length ? 1 : 0, null);
}

/**
 * Fold a CDP sampling-heap profile into "bytes charged to each call site".
 * Self size only, so a parent frame is not credited with its children's
 * allocations and the table names the function that actually allocated.
 */
function summariseAlloc(profile, seconds) {
  const bySite = new Map();
  let total = 0;
  const walkNode = (node) => {
    const f = node.callFrame;
    const bytes = (node.selfSize ?? 0) || (node.samples?.reduce?.((a, s) => a + s.size, 0) ?? 0);
    if (bytes) {
      const where = `${f.functionName || "(anonymous)"}  ${String(f.url || "").split("/").pop()}:${f.lineNumber + 1}`;
      bySite.set(where, (bySite.get(where) || 0) + bytes);
      total += bytes;
    }
    for (const c of node.children || []) walkNode(c);
  };
  walkNode(profile.head);
  // selfSize on the head tree is not populated in every Chrome build; the
  // `samples` array always is, so fall back to it rather than reporting zero.
  if (total === 0 && profile.samples?.length) {
    const byId = new Map();
    const index = (node) => {
      byId.set(node.id, node);
      for (const c of node.children || []) index(c);
    };
    index(profile.head);
    for (const s of profile.samples) {
      const n = byId.get(s.nodeId);
      const f = n?.callFrame;
      const where = f ? `${f.functionName || "(anonymous)"}  ${String(f.url || "").split("/").pop()}:${f.lineNumber + 1}` : "(unknown)";
      bySite.set(where, (bySite.get(where) || 0) + s.size);
      total += s.size;
    }
  }
  return {
    totalMB: MB(total),
    mbPerMin: +((total / 1048576 / seconds) * 60).toFixed(2),
    top: [...bySite.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([where, bytes]) => ({ mb: MB(bytes), where })),
  };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

function printStatic(s, readyMs) {
  console.log(`  init                ${(readyMs / 1000).toFixed(1)} s to __SCENE_READY`);
  console.log(`  drawing buffer      ${s.renderer.drawingBufferPx.join("x")}  pixelRatio ${s.renderer.pixelRatio}  antialias ${s.glExtras.contextAttrs?.antialias}`);
  console.log(`  scene               ${s.counts.objects} drawables in ${s.counts.sceneChildren} roots, ${s.counts.geometries} geometries, ${s.counts.materials} materials, ${s.counts.textures} textures`);
  console.log(`  lights              ${s.counts.lights} (${s.counts.shadowLights} casting shadow)`);
  for (const l of s.lights.filter((l) => l.castShadow)) console.log(`     shadow           ${l.type} "${l.name}" ${l.mapSize?.join("x")}`);
  console.log(`  triangles (scene)   ${s.totals.tris.toLocaleString()} total, ${s.totals.visibleTris.toLocaleString()} on visible objects`);
  console.log(`  renderer.info       calls ${s.renderer.info.render.calls}  tris ${s.renderer.info.render.triangles.toLocaleString()}  geometries ${s.renderer.info.memory.geometries}  textures ${s.renderer.info.memory.textures}  programs ${s.renderer.programs}`);
  console.log(`  GL uploads (init)   textures ${MB(s.gl.tex.bytes)} MB in ${s.gl.tex.calls} calls / ${s.gl.tex.allocs} objects; buffers ${MB(s.gl.buf.bytes)} MB in ${s.gl.buf.calls} calls`);
  console.log(`  GL live             tex ${MB(s.gl.live.texBytes)} MB (${s.gl.live.texCount} objects)  buf ${MB(s.gl.live.bufBytes)} MB  rbo ${MB(s.gl.live.rboBytes)} MB`);
  console.log(`  scene-graph est.    tex ${MB(s.totals.texBytes)} MB  geom ${MB(s.totals.geomBytes)} MB   [cross-check against GL live above]`);
  console.log(`  framebuffers        ${s.gl.framebuffers.created} created, ${s.gl.framebuffers.deleted} deleted;  readPixels ${s.gl.readPixels}`);
  console.log(`  shared sources      ${s.counts.sharedTextureSources} sources bound under >1 THREE.Texture (free — three keys the upload on the source)`);
  console.log(`  content duplicates  ${s.counts.contentDuplicateGroups} groups of byte-identical pixels in distinct sources, wasting ${s.counts.contentDuplicateWastedMB} MB`);
  for (const d of (s.contentDupes ?? []).slice(0, 8)) {
    console.log(`     ${`${d.w}x${d.h_}`.padEnd(11)} x${d.count}  wastes ${String(d.wastedMB).padStart(7)} MB  slots ${[...new Set(d.slots)].join(",")}  owners ${d.roots.slice(0, 4).join(",")}`);
  }
  console.log(`\n  per-owner cost (top 22; texture bytes counted against every owner that references them, so the column over-sums):`);
  console.log(`     ${"owner".padEnd(26)} ${"obj".padStart(5)} ${"tris".padStart(11)} ${"texMB".padStart(8)} ${"shared".padStart(7)} ${"geomMB".padStart(7)} ${"inst".padStart(5)} ${"casters".padStart(8)}`);
  for (const r of s.roots.slice(0, 22)) {
    console.log(
      `     ${r.name.slice(0, 26).padEnd(26)} ${String(r.objects).padStart(5)} ${String(Math.round(r.tris).toLocaleString()).padStart(11)} ` +
        `${String(r.texMB).padStart(8)} ${String(r.sharedTexMB).padStart(7)} ${String(r.geomMB).padStart(7)} ${String(r.instanced).padStart(5)} ${String(r.shadowCasters).padStart(8)}`
    );
  }
  console.log(`\n  largest textures:`);
  for (const t of s.topTextures.slice(0, 14)) {
    console.log(`     ${`${t.w}x${t.h}`.padEnd(11)} ${String(MB(t.bytes)).padStart(7)} MB  ${t.slot.padEnd(14)} used by ${t.users}  ${[...t.roots].slice(0, 3).join(",")}`);
  }
  console.log(`\n  largest GL allocations (includes render targets and shadow maps, which the scene graph cannot see):`);
  for (const b of s.glBiggest.slice(0, 12)) {
    console.log(`     ${`${b.w}x${b.h}`.padEnd(11)} ${String(MB(b.bytes)).padStart(8)} MB  ${b.kind.padEnd(13)} t=${b.t}ms`);
    if (b.stack) console.log(`        ${b.stack.slice(0, 300)}`);
  }
  console.log(`\n  texture size histogram: ${Object.entries(s.texHistogram).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join("  ")}`);
  if (s.systemErrors.length) console.error(`  !! __SYSTEM_ERRORS: ${JSON.stringify(s.systemErrors)}`);
  if (s.problems?.length) console.error(`  !! page problems:\n     ${s.problems.slice(0, 8).join("\n     ")}`);
}

function printWalk(out) {
  const f = out.walk.frame;
  console.log(`\n  frame time (steady state, ${f.frames} frames)`);
  console.log(`     mean ${f.meanMs} ms (${f.meanFps} fps)   median ${f.medianMs}   p95 ${f.p95Ms}   p99 ${f.p99Ms}   max ${f.maxMs}`);
  console.log(`     1% low ${f.onePctLowMs} ms (${f.onePctLowFps} fps)   frames >33ms: ${f.over33ms}   >100ms: ${f.over100ms}`);
  const p = out.walk.perFrame;
  console.log(`  per frame: ${p.drawsMedian} GL draws (max ${p.drawsMax}), ${p.trisMedian.toLocaleString()} tris (max ${p.trisMax.toLocaleString()}), renderer.info.calls ${p.infoCallsMedian}`);
  console.log(`  steady-state churn: texture uploads on ${p.texUploadFrames} frames (${p.texUploadCalls} calls, ${p.texUploadMB} MB), buffer uploads on ${p.bufUploadFrames} frames (${p.bufUploadCalls} calls)`);
  console.log(`  late program links: ${p.programLinksAfterWarm}   readPixels during walk: ${p.readPixelCalls} on ${p.readPixelFrames} frames`);
  const g = out.walk.growth;
  console.log(`  growth: heap ${g.heapMBPerMin} MB/min (r2 ${g.heapR2})  glTex ${g.glTexMBPerMin} MB/min  glBuf ${g.glBufMBPerMin} MB/min  geoms ${g.geomsPerMin}/min  texs ${g.texsPerMin}/min  programs ${g.programsPerMin}/min  listeners ${g.listenersPerMin}/min`);
  if (out.walk.listenerDelta?.length) {
    console.log(`  event listeners registered during the walk (the ones that persist are the leak):`);
    for (const r of out.walk.listenerDelta.slice(0, 8)) {
      console.log(`     +${String(r.added).padStart(4)}  ${r.key}`);
      if (r.stack) console.log(`            ${r.stack.slice(0, 190)}`);
    }
  } else {
    console.log(`  event listeners registered during the walk: none`);
  }
  if (out.walk.problems.length) console.error(`  !! new page problems during walk:\n     ${out.walk.problems.slice(0, 8).join("\n     ")}`);
}

function printSystems(out) {
  const all = out.systems.find((s) => s.label === "all");
  if (!all) return;
  console.log(`\n[perf] marginal cost of each system (all minus skip:<system>)`);
  console.log(`  ${"system".padEnd(13)} ${"draws".padStart(7)} ${"tris".padStart(11)} ${"glTexMB".padStart(9)} ${"progs".padStart(6)} ${"objects".padStart(8)} ${"init s".padStart(7)}   notes`);
  for (const r of out.systems.filter((s) => s.label !== "all")) {
    if (r.error) {
      console.log(`  ${r.label.slice(5).padEnd(13)} FAILED: ${r.error}`);
      continue;
    }
    const d = (k) => (all[k] ?? 0) - (r[k] ?? 0);
    console.log(
      `  ${r.label.slice(5).padEnd(13)} ${String(d("draws")).padStart(7)} ${String(Math.round(d("tris")).toLocaleString()).padStart(11)} ` +
        `${String(+(all.glTexMB - r.glTexMB).toFixed(2)).padStart(9)} ${String(d("programs")).padStart(6)} ${String(d("objects")).padStart(8)} ` +
        `${String(+(((all.readyMs - r.readyMs) / 1000)).toFixed(1)).padStart(7)}   ${r.systemErrors?.length ? `CASCADE: ${r.systemErrors.join("; ")}` : ""}`
    );
  }
  console.log(`\n  (positive = the cost that disappears when the system is skipped. A cascade note means`);
  console.log(`   skipping it broke a dependent system, so the delta includes that system's cost too.)`);
}

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort */
  }
}

run().catch((err) => void shutdown(1, err?.stack ?? String(err)));
