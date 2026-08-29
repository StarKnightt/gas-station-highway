#!/usr/bin/env node
/**
 * Sustained interactive walk — the stability test the crash report needed.
 *
 *   node tools/stress.mjs                      # 20 minutes of continuous play
 *   node tools/stress.mjs --minutes=30
 *   node tools/stress.mjs --no-build           # reuse .shot-build/stress
 *   node tools/stress.mjs --minutes=2 --smoke  # route check, not a result
 *
 * Every other harness in this repo measures a *pose*: it loads the scene, puts
 * the camera at a fixed transform and reads the frame. That answers "what does
 * this cost to draw" and cannot answer "can a person play this", which is the
 * question the user actually asked after their browser died. The two differ in
 * everything that only happens when someone moves: the store threshold, the
 * door hinge, the fuel session, the audio graph arming a node per event, and
 * the accumulation of all of them over twenty minutes.
 *
 * So this drives the real path. Real `KeyboardEvent`s into `PlayerSystem`, real
 * `pointerdown` on the canvas into `InteractionSystem`, collision resolution
 * doing its job, and a route that walks the whole site and goes in and out of
 * the store on every lap. See tools/stress-drive.js for why each of those is a
 * real event rather than a direct call.
 *
 * Port 5152, same as tools/perf.mjs. 5150, 5151 and the six system agent ports
 * are never touched. Teardown is wired before anything starts.
 *
 * Hardware GPU is mandatory and is re-checked on the live context after the
 * scene is ready, not just at launch — see tools/gpu.mjs and NOTES.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { assertHardwareGpu, assertSceneGpu, launchOptions, isSoftwareRenderer } from "./gpu.mjs";
import { assertPrivateBuildDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const BUILD_DIR = ".shot-build/stress";
const WIDTH = 1920;
const HEIGHT = 1080;
const READY_TIMEOUT_MS = 240_000;

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const MINUTES = Number(arg("minutes", "20"));
const DO_BUILD = !argv.includes("--no-build");
const SMOKE = argv.includes("--smoke");
const TAG = arg("tag", "stress");
const PARK = Number(arg("park", "0")); // seconds of stationary control before walking
// Card sampled with nothing of ours running, to establish the host's own level
// and its drift. Long enough to see the drift, short enough not to pad the run.
const BASELINE_MS = Number(arg("baseline", "8000"));
const OUT_DIR = path.join(ROOT, "tools", "perf-out");

/* ------------------------------------------------------------------ */
/* teardown, wired before anything starts                              */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null, startedServer: false, vram: null };
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
  if (reason) console.error(`\n[stress] shutting down: ${reason}`);
  // First, so the sampler cannot outlive the run and spend four seconds in an
  // execFile timeout while everything else is trying to close.
  try {
    resources.vram?.stop();
  } catch {
    /* nothing depends on this closing cleanly */
  }
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
      console.error(`[stress] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  const started = resources.startedServer;
  resources.browser = null;
  resources.server = null;
  const stillUp = await portInUse(PORT).catch(() => null);
  // Distinguish "we failed to release the port" from "somebody else has it and
  // we never started". Reporting the second as the first sends the next person
  // hunting an orphan of ours that does not exist.
  console.log(
    `[stress] teardown: port ${PORT} ${
      !stillUp ? "free" : started ? "STILL LISTENING (!) — our server did not release it" : "held by another process (never ours this run)"
    }`
  );
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
/* card-level VRAM timeline                                            */
/* ------------------------------------------------------------------ */

/**
 * Polls `nvidia-smi` on a fixed interval and tags each sample with the phase
 * the harness says it is in.
 *
 * ## Why a timeline and not a reading
 *
 * The deliverable is a single continuous run that must survive **init** and
 * then hold framerate, and the user's browser died during scene generation, not
 * during play. A steady-state figure cannot see that: an allocation that exists
 * for 300 ms during init is invisible to a reading taken afterwards and is
 * exactly what exhausts a card.
 *
 * ## What this can and cannot attribute
 *
 * `nvidia-smi --query-compute-apps=used_memory` returns `[N/A]` on this host —
 * WDDM does not report per-process VRAM — so **card usage cannot be attributed
 * to our own browser**. With sibling agents rendering concurrently the absolute
 * `used` figure is worthless as a statement about this scene.
 *
 * What survives that is the **baseline-relative delta**: sample the card before
 * launching anything, characterise how much it drifts on its own, and then read
 * our run's rise above it. The drift is reported alongside as the error bar, so
 * a delta smaller than the drift is correctly readable as "cannot tell".
 */
function startVramSampler({ intervalMs = 250 } = {}) {
  const samples = [];
  let phase = "baseline";
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    const m = await gpuMemory();
    busy = false;
    if (m && !stopped) samples.push({ t: Date.now(), phase, ...m });
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    samples,
    setPhase(p) {
      phase = p;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Per-phase min/mean/max of `usedMiB`, in the order the phases occurred. */
    summarise() {
      const order = [];
      const byPhase = new Map();
      for (const s of samples) {
        if (!byPhase.has(s.phase)) {
          byPhase.set(s.phase, []);
          order.push(s.phase);
        }
        byPhase.get(s.phase).push(s);
      }
      const base = byPhase.get("baseline") ?? [];
      const baseUsed = base.map((s) => s.usedMiB);
      const baseMean = baseUsed.length ? baseUsed.reduce((a, b) => a + b, 0) / baseUsed.length : null;
      // Peak-to-trough of the baseline: how much the card moves with nothing of
      // ours on it. Any delta below this is inside the host's own noise.
      const baseDrift = baseUsed.length ? Math.max(...baseUsed) - Math.min(...baseUsed) : null;
      return {
        totalMiB: samples.length ? samples[0].totalMiB : null,
        baseMeanMiB: baseMean,
        baseDriftMiB: baseDrift,
        phases: order.map((p) => {
          const used = byPhase.get(p).map((s) => s.usedMiB);
          const util = byPhase.get(p).map((s) => s.utilPct);
          const mean = used.reduce((a, b) => a + b, 0) / used.length;
          return {
            phase: p,
            samples: used.length,
            minMiB: Math.min(...used),
            meanMiB: mean,
            maxMiB: Math.max(...used),
            deltaMaxMiB: baseMean === null ? null : Math.max(...used) - baseMean,
            utilMeanPct: util.reduce((a, b) => a + b, 0) / util.length,
          };
        }),
      };
    },
  };
}

/**
 * Content hash of a source tree, plus the newest mtime in it. Identifies the
 * exact program a result refers to in a repo with no commits.
 */
async function hashTree(dir) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha1");
  let files = 0;
  let newest = 0;
  const walk = async (d) => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|js|glsl|json|html)$/.test(e.name)) {
        const buf = await fs.readFile(p);
        h.update(path.relative(dir, p)).update(buf);
        files++;
        const st = await fs.stat(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  await walk(dir);
  return { hash: h.digest("hex").slice(0, 12), files, newest: new Date(newest).toISOString() };
}

/* ------------------------------------------------------------------ */
/* the route                                                           */
/* ------------------------------------------------------------------ */

/**
 * One lap of the site. Coordinates are world metres, read out of src/site.ts
 * and the systems that place things; the `seek` steps then confirm by probing
 * rather than trusting them, because a coordinate that is 300 mm out aims at
 * the wall beside a door and produces a lap that silently never opens it.
 *
 * `targets` carries positions that can only be known at runtime (the bottle is
 * placed procedurally on a cooler shelf).
 */
function lap(n, targets, { bottle = false, cooler = true } = {}) {
  const L = (phase, steps) => steps.map((s) => ({ ...s, phase, lap: n }));
  const pumpY = 1.15;
  // If the back of the store cannot be walked to, stop pretending. Spend the
  // time on threshold crossings instead, which is the part of the store that
  // nobody has measured and that this test exists to exercise.
  const inStore = cooler
    ? [
        ...L("store-interior", [
          { op: "go", to: [0.5, 35.5], timeout: 15000 },
          { op: "go", to: [targets.cooler[0], targets.cooler[2] - 1.3], tol: 0.5, timeout: 18000 },
        ]),
        ...L("cooler-shut-look", [
          { op: "seek", at: [targets.cooler[0], targets.cooler[1], targets.cooler[2]], want: "cooler" },
          { op: "wait", ms: 3000 },
        ]),
        ...L("cooler-open-look", [
          { op: "click", want: "cooler", mark: "cooler-open" },
          { op: "wait", ms: 4000 },
        ]),
        ...(bottle && targets.bottle
          ? L("bottle", [
              { op: "seek", at: targets.bottle, want: "bottle" },
              { op: "click", want: "bottle", mark: "bottle-grab" },
              { op: "wait", ms: 1200 },
            ])
          : []),
        ...L("cooler-leave", [
          { op: "wait", ms: 3000 },
          { op: "back", to: [targets.cooler[0], targets.cooler[2] - 2.6], tol: 0.8, timeout: 9000 },
        ]),
      ]
    : L("store-interior", [
        { op: "go", to: [-3.0, 33.2], tol: 0.5, timeout: 12000 },
        { op: "wait", ms: 2500 },
        { op: "go", to: [-7.8, 33.0], tol: 0.5, timeout: 12000 },
        { op: "wait", ms: 2500 },
      ]);

  return [
    ...L("forecourt-approach", [
      { op: "go", to: [-10, 10] },
      { op: "go", to: [-4, 14] },
    ]),

    // Pump 1, south face. Start fuelling, let it run, stop it. The running
    // session is the expensive part: an 18 Hz canvas redraw on the display and
    // a 120-segment tube rebuild as the nozzle lifts.
    ...L("pump-1", [
      { op: "go", to: [-2.4, 15.2], tol: 0.35 },
      { op: "seek", at: [-2.4, pumpY, 16.2], want: "pump" },
      { op: "click", want: "pump", mark: "fuel-start" },
      { op: "wait", ms: 6000 },
      { op: "seek", at: [-2.4, pumpY, 16.2], want: "pump" },
      { op: "click", want: "pump", mark: "fuel-stop" },
    ]),

    ...L("cross-forecourt", [
      { op: "go", to: [4, 18] },
      { op: "go", to: [9, 24] },
      { op: "go", to: [2, 25] },
    ]),

    ...L("pump-3", [
      { op: "go", to: [0, 22.0], tol: 0.35 },
      { op: "seek", at: [0, pumpY, 22.8], want: "pump" },
      { op: "click", want: "pump", mark: "fuel-start" },
      { op: "wait", ms: 4000 },
      { op: "seek", at: [0, pumpY, 22.8], want: "pump" },
      { op: "click", want: "pump", mark: "fuel-stop" },
    ]),

    ...L("store-approach", [
      { op: "go", to: [-6.0, 28.0] },
      { op: "go", to: [-6.0, 30.3], tol: 0.3 },
    ]),

    // The door and the threshold. Everything the shot presets cannot reach.
    ...L("store-enter", [
      { op: "seek", at: [-6.0, 1.35, 31.6], want: "door" },
      { op: "click", want: "door", mark: "door-open" },
      { op: "wait", ms: 700 },
      { op: "go", to: [-6.0, 33.2], tol: 0.4, timeout: 15000 },
    ]),

    // A paired look at the cooler from one pose, shut then open — see `inStore`
    // above. The first routed run put every one of its worst frames at this
    // spot and could not say whether that was the glass, the door being open,
    // or simply where the walk happened to wedge. Holding the camera still
    // across the click is the only version of that question with an answer.
    ...inStore,

    // Straight back out. Repeated crossings of the same threshold in quick
    // succession are the part nobody has measured, so do three of them.
    ...L("store-exit", [
      { op: "go", to: [-6.0, 33.5] },
      { op: "go", to: [-6.0, 30.5], tol: 0.5, timeout: 15000 },
    ]),
    ...L("threshold-drill", [
      { op: "go", to: [-6.0, 33.0], tol: 0.6, timeout: 12000 },
      { op: "go", to: [-6.0, 30.4], tol: 0.6, timeout: 12000 },
      { op: "go", to: [-6.0, 33.0], tol: 0.6, timeout: 12000 },
      { op: "go", to: [-6.0, 30.4], tol: 0.6, timeout: 12000 },
    ]),

    // A wide sweep of the rest of the site: parking, the far apron, the road
    // edge and back. This is where the terrain, vegetation and canopy get
    // drawn from angles no shot preset uses.
    ...L("site-sweep", [
      { op: "go", to: [8, 30] },
      { op: "go", to: [14, 22] },
      { op: "go", to: [16, 12] },
      { op: "go", to: [4, 8] },
      { op: "go", to: [-12, 9] },
      { op: "go", to: [-20, 16] },
      { op: "go", to: [-16, 26] },
      { op: "go", to: [-10, 20] },
    ]),
  ];
}

/* ------------------------------------------------------------------ */
/* statistics                                                          */
/* ------------------------------------------------------------------ */

const pct = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];

function frameStats(dts) {
  if (!dts.length) return null;
  const s = [...dts].sort((a, b) => a - b);
  const worstN = Math.max(1, Math.round(s.length * 0.01));
  const worst = s.slice(-worstN);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const low = worst.reduce((a, b) => a + b, 0) / worst.length;
  return {
    frames: s.length,
    meanMs: +mean.toFixed(2),
    medianMs: +pct(s, 50).toFixed(2),
    p95Ms: +pct(s, 95).toFixed(2),
    p99Ms: +pct(s, 99).toFixed(2),
    maxMs: +s[s.length - 1].toFixed(2),
    onePctLowMs: +low.toFixed(2),
    meanFps: +(1000 / mean).toFixed(1),
    onePctLowFps: +(1000 / low).toFixed(1),
    over33: s.filter((d) => d > 33.4).length,
    over100: s.filter((d) => d > 100).length,
    over250: s.filter((d) => d > 250).length,
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

/* ------------------------------------------------------------------ */

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");
  const probe = await fs.readFile(path.join(ROOT, "tools/perf-probe.js"), "utf8");
  const drive = await fs.readFile(path.join(ROOT, "tools/stress-drive.js"), "utf8");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  /* Start sampling the card before anything of ours touches it. The first
   * `BASELINE_MS` of samples are the host on its own, which is what makes the
   * later deltas readable at all on a machine with six other agents rendering. */
  const vram = startVramSampler();
  resources.vram = vram;
  await new Promise((r) => setTimeout(r, BASELINE_MS));

  const out = {
    tag: TAG,
    when: new Date().toISOString(),
    viewport: [WIDTH, HEIGHT],
    minutes: MINUTES,
    phase: "startup",
  };

  // Deliberately NOT snapshotting src/ the way perf.mjs does. This run is a
  // claim about whether the scene as it stands right now can be played, and a
  // snapshot would make it a claim about a copy.
  //
  // The repo has no commits, so there is no rev to quote. Hash the sources
  // instead: six agents are editing them, and a result that cannot name the
  // tree it was measured against is not reproducible by anybody.
  out.tree = await hashTree(path.join(ROOT, "src"));
  out.builtThisRun = DO_BUILD;
  console.log(`[stress] tree under test: src/ = ${out.tree.hash} (${out.tree.files} files, newest ${out.tree.newest})`);
  if (!DO_BUILD) {
    // The hash describes src/ as it is now; --no-build runs the bundle from a
    // previous run. Six agents edit continuously, so those are routinely
    // different programs and quoting the hash as "the tree under test" would
    // be a lie of exactly the kind this file exists to prevent.
    console.warn(
      `[stress] --no-build: the bundle in ${BUILD_DIR} is from an earlier run and may NOT be the hash above. ` +
        `Comparable with other --no-build runs against the same bundle; not with a fresh build.`
    );
  }

  if (DO_BUILD) {
    console.log("[stress] building...");
    assertPrivateBuildDir(ROOT, BUILD_DIR, "stress");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }

  console.log(`[stress] preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  resources.startedServer = true;
  const base = `http://127.0.0.1:${PORT}/`;

  out.gpuBefore = await gpuMemory();
  if (out.gpuBefore) {
    console.log(
      `[stress] card before launch: ${out.gpuBefore.usedMiB} / ${out.gpuBefore.totalMiB} MiB used ` +
        `(${out.gpuBefore.freeMiB} MiB free), ${out.gpuBefore.utilPct}% busy`
    );
  }

  vram.setPhase("browser-launch");
  resources.browser = await chromium.launch(launchOptions());
  out.browserDeath = null;
  resources.browser.on("disconnected", () => {
    if (!out.finishedCleanly) {
      out.browserDeath = { at: new Date().toISOString(), phase: out.phase };
      console.error(`[stress] !! BROWSER PROCESS DISCONNECTED during "${out.phase}"`);
    }
  });

  const context = await resources.browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "stress" });
  if (isSoftwareRenderer(gpu.renderer)) throw new Error("software renderer");
  await gpuPage.close();
  out.gpu = gpu;
  console.log(`[stress] adapter: ${gpu.renderer}`);

  /* ---------------- load ---------------- */

  const page = await context.newPage();
  const problems = [];
  let crashed = false;
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") problems.push({ at: Date.now(), text: `console: ${t}` });
  });
  page.on("pageerror", (e) => problems.push({ at: Date.now(), text: `pageerror: ${e.message}` }));
  page.on("crash", () => {
    crashed = true;
    problems.push({ at: Date.now(), text: "PAGE CRASHED" });
    console.error(`[stress] !! PAGE CRASHED during "${out.phase}"`);
  });
  await page.addInitScript({ content: instrument });
  await page.addInitScript({ content: probe });
  await page.addInitScript({ content: drive });

  out.phase = "load";
  // The phase the user's browser actually died in.
  vram.setPhase("init");
  console.log(`[stress] loading ${base}`);
  const tLoad = Date.now();
  await page.goto(base, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
  out.readyMs = Date.now() - tLoad;
  await assertSceneGpu(page, { tag: "stress", when: "after ready" });
  console.log(`[stress] ready in ${(out.readyMs / 1000).toFixed(1)}s`);

  // Let lazily compiled programs land before anything is called steady state.
  await page.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n < 90 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); }));

  vram.setPhase("steady");
  out.gpuAfterLoad = await gpuMemory();
  out.atReady = await page.evaluate(() => window.__STRESS.stats());
  console.log(
    `[stress] at ready: ${out.atReady.drawCalls} draws, ${(out.atReady.triangles / 1e6).toFixed(2)}M tris, ` +
      `${out.atReady.programs} programs, ${out.atReady.liveTexMB} MB tex, heap ${out.atReady.heapMB} MB`
  );

  /* ---------------- resolve runtime target positions ---------------- */

  const targets = await page.evaluate(() => {
    const g = window.__GAME;
    // World translation straight off matrixWorld — no THREE in page scope.
    const wp = (o) => {
      if (!o) return null;
      o.updateMatrixWorld(true);
      const e = o.matrixWorld.elements;
      return [+e[12].toFixed(3), +e[13].toFixed(3), +e[14].toFixed(3)];
    };
    const st = window.__INTERACT ? window.__INTERACT.state() : null;
    const doors = g.tryGet("building.coolerDoors") || [];
    const bottle = st && st.bottle ? [st.bottle.x, st.bottle.y, st.bottle.z] : null;

    // Pick the cooler door that covers the bottle, not an arbitrary one: the
    // bottle sits behind the glass, so a ray at it is stopped by whichever
    // leaf is shut in front of it. Opening a different door leaves the grab
    // permanently unreachable and the lap silently one interaction short.
    let best = doors[3] || doors[0];
    if (bottle && doors.length) {
      let bd = Infinity;
      for (const d of doors) {
        const p = wp(d);
        if (!p) continue;
        const dx = Math.abs(p[0] + 0.42 - bottle[0]);
        if (dx < bd) {
          bd = dx;
          best = d;
        }
      }
    }
    const pivot = wp(best);
    // Offset toward the leaf centre so the aim starts on glass, not on the
    // hinge stile, and about chest height.
    return {
      cooler: pivot ? [pivot[0] + 0.42, pivot[1] + 1.0, pivot[2]] : [-5.4, 1.4, 38.6],
      coolerCount: doors.length,
      bottle,
      door: wp(g.tryGet("building.entryDoor")),
      interactServices: st ? st.services : null,
    };
  });
  out.targets = targets;
  console.log(`[stress] targets: cooler ${JSON.stringify(targets.cooler)} (${targets.coolerCount} doors), bottle ${JSON.stringify(targets.bottle)}`);
  if (!targets.interactServices) console.warn(`[stress] WARNING: __INTERACT is absent — no interaction will fire this run`);

  // Sample the game's own collision field so the walk routes around the store
  // shelving instead of grinding along it. See stress-drive.js.
  out.grid = await page.evaluate(() => window.__STRESS.buildGrid());
  console.log(
    `[stress] walkable grid: ${out.grid.free} of ${out.grid.cells} cells free (${out.grid.pct}%) at 0.4 m; ` +
      `${out.grid.reachable} reachable from spawn, ${out.grid.strandedFreeCells} free but stranded ` +
      `(doorway opened through ${out.grid.doorwayCellsOpened} cells)`
  );
  if (!out.grid.free) console.warn(`[stress] WARNING: no collision field — the walk will path in straight lines`);

  // Which of the things the route wants to visit can actually be walked to.
  // A waypoint behind a wall does not produce an error: it produces a lap that
  // spends its whole budget grinding into the wall, and a "sustained walk"
  // result that is mostly a sustained stand.
  out.reach = await page.evaluate(
    (t) => ({
      collision: window.__STRESS.describeCollision(),
      points: {
        "pump-1": window.__STRESS.canReach(-2.4, 15.2),
        "pump-3": window.__STRESS.canReach(0, 22.0),
        "store-door": window.__STRESS.canReach(-6.0, 30.3),
        "store-inside": window.__STRESS.canReach(-6.0, 33.2),
        "store-mid": window.__STRESS.canReach(0.5, 35.5),
        cooler: window.__STRESS.canReach(t.cooler[0], t.cooler[2] - 1.3),
      },
      transects: {
        "store centre, front to back": window.__STRESS.transect(-6, 30, -6, 39.5, 20),
        "store, left to right at z=35": window.__STRESS.transect(-8.5, 35, 3, 35, 24),
      },
    }),
    targets
  );
  console.log(`[stress] reachable from spawn: ${Object.entries(out.reach.points).map(([k, v]) => `${k}=${v ? "yes" : "NO"}`).join("  ")}`);
  for (const [name, tr] of Object.entries(out.reach.transects)) {
    const strip = tr.map((c) => (c.state === "walkable" ? "." : c.state === "solid" ? "#" : c.state === "stranded" ? "x" : " ")).join("");
    console.log(`[stress]   ${name.padEnd(30)} |${strip}|  (. walkable  # solid  x free-but-unreachable)`);
  }
  // Is the back of the store impassable, or merely tight? Re-sample the grid
  // at a range of body radii. "Cannot fit" and "cannot fit by 20 mm" are
  // different bug reports and only one of them is worth another agent's night.
  out.reachByRadius = await page.evaluate((t) => {
    const rows = [];
    for (const r of [0.34, 0.32, 0.3, 0.26, 0.22, 0.16, 0.1]) {
      window.__STRESS.buildGrid(r, Math.min(r, 0.22));
      rows.push({
        radius: r,
        cooler: window.__STRESS.canReach(t.cooler[0], t.cooler[2] - 1.3),
        storeMid: window.__STRESS.canReach(0.5, 35.5),
        storeBack: window.__STRESS.canReach(-6, 38.5),
      });
    }
    return rows;
  }, targets);
  console.log(`[stress] reachability vs body radius (the player's is 0.32 m, doorways 0.20 m):`);
  for (const r of out.reachByRadius) {
    console.log(
      `[stress]   r=${r.radius.toFixed(2)} m   cooler ${r.cooler ? "yes" : "NO "}   store-mid ${r.storeMid ? "yes" : "NO "}   store-back ${r.storeBack ? "yes" : "NO "}`
    );
  }
  // Leave the grid at the real body radius for the walk itself.
  await page.evaluate(() => window.__STRESS.buildGrid(0.34, 0.22));

  const unreachable = Object.entries(out.reach.points).filter(([, v]) => v === false).map(([k]) => k);
  if (unreachable.length) {
    console.warn(`[stress] WARNING: ${unreachable.join(", ")} cannot be walked to. Those legs are dropped from the route.`);
  }
  out.unreachable = unreachable;

  /* ---------------- the walk ---------------- */

  out.phase = "walk";
  vram.setPhase(PARK > 0 ? "parked-control" : "walk");
  const LAPS = SMOKE ? 1 : 60; // more than can run in the window; the clock stops it
  const route = [];
  // A stationary control, first. Camera parked at spawn, no input, nothing in
  // the route running. Any frame over 100 ms here cannot be caused by the walk,
  // by an interaction, or by anything the scene allocates — so it separates
  // "this scene hitches" from "this machine hitches", which no amount of
  // in-scene counting can do.
  if (PARK > 0) route.push({ op: "wait", ms: PARK * 1000, phase: "parked-control", lap: 0, mark: "park" });
  const canCooler = out.reach.points.cooler !== false;
  for (let i = 1; i <= LAPS; i++) route.push(...lap(i, targets, { bottle: i === 1 && canCooler, cooler: canCooler }));
  out.routeSteps = route.length;

  console.log(`\n[stress] === walking the real interactive path for ${MINUTES} min ===`);
  console.log(`[stress] route: ${route.length} steps, up to ${LAPS} laps, each lap = 2 fuel sessions, 1 door, 1 cooler, 5 threshold crossings\n`);

  const listenersAtStart = await page.evaluate(() => JSON.parse(JSON.stringify(window.__GLSTAT.listeners.byKey)));
  await page.evaluate((r) => window.__STRESS.begin(r), route);
  // The parked control runs first and in-page, so the sampler is told when it
  // ends rather than inferring it. Card usage while parked is the control for
  // card usage while moving, the same way parked frame time is for moving frame
  // time.
  if (PARK > 0) setTimeout(() => vram.setPhase("walk"), PARK * 1000).unref?.();

  const track = [];
  const allSamples = [];
  const allLog = [];
  const t0 = Date.now();
  const deadline = t0 + MINUTES * 60_000;
  let died = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (crashed || !resources.browser?.isConnected()) {
      died = { atS: +((Date.now() - t0) / 1000).toFixed(1), reason: crashed ? "page crash" : "browser disconnected" };
      break;
    }
    let batch;
    try {
      batch = await page.evaluate(() => {
        const d = window.__STRESS.drain();
        return { stats: window.__STRESS.stats(), samples: d.samples, log: d.log };
      });
    } catch (err) {
      died = { atS: +((Date.now() - t0) / 1000).toFixed(1), reason: `page unreachable: ${err?.message ?? err}` };
      break;
    }

    allSamples.push(...batch.samples);
    allLog.push(...batch.log);

    const s = batch.stats;
    const gpuNow = await gpuMemory();
    const window5 = batch.samples.filter((r) => r.dt > 0);
    const fs5 = frameStats(window5.map((r) => r.dt));
    const row = {
      s: +((Date.now() - t0) / 1000).toFixed(1),
      ...s,
      gpuUsedMiB: gpuNow?.usedMiB ?? null,
      // Occupancy, not just allocation. The 25-minute run recorded memory only
      // and so could not separate "the scene hitched" from "another process
      // had the card" — every scene-side counter was identical across hitching
      // and calm windows, which rules the scene out but names nothing.
      gpuUtilPct: gpuNow?.utilPct ?? null,
      meanMs: fs5?.meanMs ?? null,
      onePctLowMs: fs5?.onePctLowMs ?? null,
      maxMs: fs5?.maxMs ?? null,
    };
    track.push(row);

    process.stdout.write(
      `  ${String(Math.round(row.s)).padStart(4)}s lap ${String(s.lap).padStart(2)} ${String(s.phase).padEnd(19)} ` +
        `${s.inside ? "IN " : "out"} ` +
        `frame ${String(row.meanMs ?? "-").padStart(6)}ms (1% low ${String(row.onePctLowMs ?? "-").padStart(7)}) ` +
        `tex ${String(s.liveTexMB).padStart(7)}MB heap ${String(s.heapMB).padStart(6)}MB ` +
        `geo ${String(s.geometries).padStart(5)} prog ${String(s.programs).padStart(4)} ` +
        `audio ${s.audioNodes ? String(s.audioNodes.live).padStart(4) : "  n/a"} ` +
        `gpu ${String(row.gpuUsedMiB ?? "-").padStart(5)}MiB/${String(row.gpuUtilPct ?? "-").padStart(3)}%` +
        `${s.contextLost ? "  !! CONTEXT LOST" : ""}${s.systemErrors ? `  !! ${s.systemErrors} system errors` : ""}\n`
    );

    if (s.contextLost) {
      died = { atS: row.s, reason: "webgl context lost" };
      break;
    }
    if (s.finished) {
      console.log(`[stress] route exhausted after ${row.s}s (${LAPS} laps) — extend --minutes or add laps`);
      break;
    }
  }

  out.phase = "report";
  vram.stop();
  out.vram = vram.summarise();
  const elapsedS = (Date.now() - t0) / 1000;
  out.walkSeconds = +elapsedS.toFixed(1);
  out.died = died;
  out.survived = !died;

  if (!died) {
    try {
      const final = await page.evaluate(() => {
        const d = window.__STRESS.drain();
        window.__STRESS.stop();
        return { stats: window.__STRESS.stats(), samples: d.samples, log: d.log, lost: window.__CONTEXT_LOST ?? null, errors: window.__SYSTEM_ERRORS ?? [] };
      });
      allSamples.push(...final.samples);
      allLog.push(...final.log);
      out.atEnd = final.stats;
      out.contextLost = final.lost;
      out.systemErrors = final.errors;
      out.listenerDelta = await page.evaluate((start) => {
        const end = window.__GLSTAT.listeners;
        return Object.entries(end.byKey)
          .map(([k, n]) => ({ key: k, added: n - (start[k] || 0), stack: (end.stacks[k] || [])[0] || "" }))
          .filter((r) => r.added > 0)
          .sort((a, b) => b.added - a.added)
          .slice(0, 12);
      }, listenersAtStart);
    } catch (err) {
      out.died = died = { atS: out.walkSeconds, reason: `page unreachable at teardown: ${err?.message ?? err}` };
      out.survived = false;
    }
  }

  out.gpuAfter = await gpuMemory();
  out.problems = problems.slice(0, 40).map((p) => p.text);
  out.log = allLog;
  out.track = track;

  /* ---------------- analysis ---------------- */

  const moving = allSamples.filter((r) => r.dt > 0 && r.dt < 5000);
  out.overall = frameStats(moving.map((r) => r.dt));

  // Steady state: drop the first 60 s, which contains the last of the lazy
  // program links and the first pass over every part of the site.
  const tStart = moving.length ? moving[0].t : 0;
  const steady = moving.filter((r) => r.phase !== "parked-control" && r.t - tStart > 60_000 + PARK * 1000);
  out.steadyState = frameStats(steady.map((r) => r.dt));

  // Drop the first two seconds of the control: the sampler's own first frame
  // and the tail of program linking land there.
  const parkFrames = moving.filter((r) => r.phase === "parked-control" && r.t - tStart > 2000);
  out.parked = frameStats(parkFrames.map((r) => r.dt));

  // Per phase, so a slow frame has an owner rather than a timestamp.
  const byPhase = new Map();
  for (const r of steady) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase).push(r.dt);
  }
  out.byPhase = [...byPhase.entries()]
    .map(([phase, dts]) => ({ phase, ...frameStats(dts) }))
    .sort((a, b) => b.onePctLowMs - a.onePctLowMs);

  // The store threshold specifically: frames within 500 ms either side of a
  // crossing. A shot preset cannot produce these at all.
  const crossings = allSamples.filter((r) => r.cross);
  out.crossings = crossings.length;
  const nearCross = [];
  for (const c of crossings) {
    for (const r of moving) {
      if (Math.abs(r.t - c.t) < 500) nearCross.push(r.dt);
    }
  }
  out.thresholdFrames = frameStats(nearCross);

  // Worst frames, with the phase and position that produced them.
  out.worst = [...moving]
    .sort((a, b) => b.dt - a.dt)
    .slice(0, 20)
    .map((r) => ({
      atS: +((r.t - tStart) / 1000).toFixed(1),
      ms: +r.dt.toFixed(1),
      phase: r.phase,
      lap: r.lap,
      pos: [r.x, r.z],
      inside: r.inside,
      draws: r.draws,
      progLinked: r.progLinked,
      texKB: +(r.texBytes / 1024).toFixed(0),
    }));

  // Growth. Regressed over the whole walk, per minute, so a slope is directly
  // comparable to a twenty-minute session.
  const mins = track.map((r) => r.s / 60);
  out.growthPerMinute = {};
  for (const k of ["liveTexMB", "liveBufMB", "heapMB", "geometries", "textures", "programs", "framebuffers", "sceneChildren", "listenerRegistrations"]) {
    const ys = track.map((r) => r[k]).filter((v) => typeof v === "number");
    if (ys.length !== track.length || ys.length < 4) continue;
    const { slope, r2 } = linreg(mins, ys);
    out.growthPerMinute[k] = { perMin: +slope.toFixed(3), r2: +r2.toFixed(2), first: ys[0], last: ys[ys.length - 1] };
  }
  const audio = track.map((r) => r.audioNodes).filter(Boolean);
  if (audio.length >= 4) {
    const live = audio.map((a) => a.live);
    const { slope, r2 } = linreg(mins.slice(0, live.length), live);
    out.audioNodes = {
      created: audio[audio.length - 1].created,
      ended: audio[audio.length - 1].ended,
      liveFirst: live[0],
      liveLast: live[live.length - 1],
      liveMax: Math.max(...live),
      perMin: +slope.toFixed(3),
      r2: +r2.toFixed(2),
      state: audio[audio.length - 1].state,
    };
  }

  // Interactions actually performed, and the ones that missed.
  const clicks = allLog.filter((l) => l.kind === "click");
  out.interactions = {
    attempted: clicks.length,
    hit: clicks.filter((c) => !c.missed).length,
    missed: clicks.filter((c) => c.missed).length,
    byKind: clicks.reduce((a, c) => {
      const k = c.hit ? c.hit.split(":")[0] : "miss";
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {}),
  };
  out.seekMisses = allLog.filter((l) => l.kind === "seek-miss").length;
  out.stuck = allLog.filter((l) => l.kind === "stuck");
  out.unstick = allLog.filter((l) => l.kind === "unstick").length;
  out.skippedLegs = allLog.filter((l) => l.kind === "skip-leg").length;
  out.lapsCompleted = allLog.length ? Math.max(...allLog.map((l) => l.lap)) : 0;

  print(out);

  const file = path.join(OUT_DIR, `stress-${TAG}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 1));
  console.log(`\n[stress] full record: ${path.relative(ROOT, file)}`);

  out.finishedCleanly = true;
  await shutdown(died ? 1 : 0, null);
}

function print(o) {
  const line = (s = "") => console.log(s);
  line();
  line("=".repeat(96));
  line(`SUSTAINED INTERACTIVE WALK — ${o.walkSeconds}s (${(o.walkSeconds / 60).toFixed(1)} min)`);
  line("=".repeat(96));
  line(`tree            src/ ${o.tree.hash}, ${o.tree.files} files, newest edit ${o.tree.newest}`);
  line(`adapter         ${o.gpu?.renderer}`);
  line(`viewport        ${o.viewport[0]}x${o.viewport[1]}`);
  line(`scene ready in  ${(o.readyMs / 1000).toFixed(1)}s`);
  line();
  line(o.survived ? `SURVIVED. No crash, no context loss, no page error.` : `DIED at ${o.died.atS}s: ${o.died.reason}`);
  line();

  const f = (s, label) => {
    if (!s) return;
    line(
      `${label.padEnd(16)} mean ${String(s.meanMs).padStart(6)} ms (${String(s.meanFps).padStart(5)} fps)   ` +
        `median ${String(s.medianMs).padStart(6)}   p95 ${String(s.p95Ms).padStart(6)}   ` +
        `1% low ${String(s.onePctLowMs).padStart(7)} ms (${s.onePctLowFps} fps)   max ${String(s.maxMs).padStart(8)}   ` +
        `>33ms ${s.over33}  >100ms ${s.over100}  >250ms ${s.over250}   [${s.frames} frames]`
    );
  };
  line("--- frame time ---");
  f(o.overall, "whole walk");
  f(o.steadyState, "steady (>60s)");
  f(o.parked, "parked control");
  f(o.thresholdFrames, "store threshold");
  line();
  if (o.parked && o.parked.over100) {
    line(
      `  NOTE: ${o.parked.over100} frames over 100 ms with the camera parked and nothing in the route running. ` +
        `Those are not the scene.`
    );
    line();
  }
  if (o.reachByRadius) {
    line("--- can the player fit? (their body radius is 0.32 m) ---");
    for (const r of o.reachByRadius) {
      line(`  radius ${r.radius.toFixed(2)} m   cooler ${r.cooler ? "reachable" : "NO"}   store-mid ${r.storeMid ? "reachable" : "NO"}   store-back ${r.storeBack ? "reachable" : "NO"}`);
    }
    line();
  }

  if (o.vram?.phases?.length) {
    const v = o.vram;
    line(`--- card VRAM by phase (total ${v.totalMiB} MiB) ---`);
    line(
      `  host baseline before we launched: ${v.baseMeanMiB?.toFixed(0)} MiB used, ` +
        `drifting ${v.baseDriftMiB?.toFixed(0)} MiB on its own`
    );
    line(`  ${"phase".padEnd(16)} ${"min".padStart(6)} ${"mean".padStart(7)} ${"max".padStart(7)}  ${"vs baseline".padStart(11)}  gpu%`);
    for (const p of v.phases) {
      line(
        `  ${p.phase.padEnd(16)} ${p.minMiB.toFixed(0).padStart(6)} ${p.meanMiB.toFixed(0).padStart(7)} ` +
          `${p.maxMiB.toFixed(0).padStart(7)}  ${(p.deltaMaxMiB === null ? "-" : `+${p.deltaMaxMiB.toFixed(0)} MiB`).padStart(11)}  ${p.utilMeanPct.toFixed(0)}%`
      );
    }
    line(
      `  NOTE: per-process VRAM is [N/A] on WDDM, and sibling agents render on this card concurrently, so the ` +
        `absolute figures are NOT this scene. Only the rise above baseline is ours, and only where it exceeds ` +
        `the ${v.baseDriftMiB?.toFixed(0)} MiB baseline drift.`
    );
    line();
  }

  if (o.byPhase?.length) {
    line("--- by phase, worst 1% low first ---");
    for (const p of o.byPhase) f(p, p.phase);
    line();
  }

  line("--- worst frames ---");
  for (const w of o.worst.slice(0, 12)) {
    line(
      `  ${String(w.ms).padStart(8)} ms  at ${String(w.atS).padStart(6)}s  lap ${String(w.lap).padStart(2)}  ` +
        `${w.phase.padEnd(19)} ${w.inside ? "inside " : "outside"} (${w.pos[0]}, ${w.pos[1]})  ` +
        `${w.draws} draws${w.progLinked ? `  ${w.progLinked} PROGRAMS LINKED` : ""}${w.texKB > 64 ? `  ${w.texKB} KB uploaded` : ""}`
    );
  }
  line();

  line("--- what the walk actually did ---");
  line(`  laps completed        ${o.lapsCompleted}`);
  line(`  store crossings       ${o.crossings}`);
  line(`  interactions          ${o.interactions.attempted} attempted, ${o.interactions.hit} hit, ${o.interactions.missed} missed`);
  line(`  by kind               ${JSON.stringify(o.interactions.byKind)}`);
  line(`  aim failures          ${o.seekMisses}`);
  line(`  collision stalls      ${o.stuck.length} gave up, ${o.unstick} strafed free, ${o.skippedLegs} route legs abandoned`);
  for (const s of o.stuck.slice(0, 6)) {
    line(`     wedged at (${s.at?.[0]}, ${s.at?.[1]}) heading for (${s.to}) — ${s.around ? Object.entries(s.around).map(([k, v]) => `${k}:${v}`).join(" ") : "no field"}`);
    if (s.coolers?.length) line(`       cooler doors open: ${s.coolers.map((c) => `#${c.index}@${c.amount.toFixed(2)}`).join(" ")}`);
  }
  line(
    `  walkable grid         ${o.grid.free}/${o.grid.cells} free, ${o.grid.reachable} reachable from spawn` +
      `${o.grid.strandedFreeCells ? `, ${o.grid.strandedFreeCells} free but walled off` : ""}`
  );
  if (o.unreachable?.length) line(`  UNREACHABLE           ${o.unreachable.join(", ")}`);
  line();

  line("--- growth per minute (r2 says whether it is a trend or noise) ---");
  for (const [k, v] of Object.entries(o.growthPerMinute)) {
    const flag = v.r2 > 0.7 && Math.abs(v.perMin) > 0.01 ? (v.perMin > 0 ? "  <-- rising" : "  <-- falling") : "";
    line(`  ${k.padEnd(22)} ${String(v.perMin).padStart(10)} /min   r2 ${String(v.r2).padStart(4)}   ${v.first} -> ${v.last}${flag}`);
  }
  if (o.audioNodes) {
    const a = o.audioNodes;
    line(
      `  audio nodes            ${a.created} started, ${a.ended} ended, live ${a.liveFirst} -> ${a.liveLast} ` +
        `(max ${a.liveMax}), ${a.perMin}/min r2 ${a.r2}, context ${a.state}`
    );
  }
  line();

  if (o.listenerDelta?.length) {
    line("--- listener registrations during the walk ---");
    for (const l of o.listenerDelta) line(`  +${String(l.added).padStart(5)}  ${l.key}${l.stack ? `   ${l.stack.slice(0, 70)}` : ""}`);
    line();
  }

  line("--- memory ---");
  line(`  GL texture bytes      ${o.atReady.liveTexMB} MB at ready -> ${o.atEnd?.liveTexMB ?? "?"} MB at end (peak ${o.atEnd?.peakTexMB ?? "?"} MB)`);
  line(`  JS heap               ${o.atReady.heapMB} MB -> ${o.atEnd?.heapMB ?? "?"} MB`);
  line(`  geometries            ${o.atReady.geometries} -> ${o.atEnd?.geometries ?? "?"}`);
  line(`  programs              ${o.atReady.programs} -> ${o.atEnd?.programs ?? "?"}`);
  line(`  framebuffers          ${o.atReady.framebuffers} -> ${o.atEnd?.framebuffers ?? "?"}`);
  line(
    `  card                  ${o.gpuBefore?.usedMiB ?? "?"} MiB before launch -> ${o.gpuAfterLoad?.usedMiB ?? "?"} after load -> ` +
      `${o.gpuAfter?.usedMiB ?? "?"} at end (of ${o.gpuAfter?.totalMiB ?? "?"})`
  );
  line();

  if (o.systemErrors?.length) {
    line(`--- ${o.systemErrors.length} system errors ---`);
    for (const e of o.systemErrors.slice(0, 10)) line(`  ${e.system}/${e.phase}: ${e.message}`);
    line();
  }
  if (o.problems?.length) {
    line(`--- ${o.problems.length} page problems ---`);
    for (const p of o.problems.slice(0, 12)) line(`  ${p.slice(0, 140)}`);
    line();
  }
  line("=".repeat(96));
}

run().catch((e) => shutdown(1, e?.stack ?? String(e)));
