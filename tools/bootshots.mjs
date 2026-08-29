#!/usr/bin/env node
/**
 * Pixel evidence for the boot overlay (`src/core/loadingScreen.ts`).
 *
 *   node tools/bootshots.mjs                # build, then a cold load and a warm one
 *   node tools/bootshots.mjs --no-build     # reuse the last build
 *   node tools/bootshots.mjs --warm-only    # skip the slow cold run
 *   node tools/bootshots.mjs --fail-only    # photograph the failure report only
 *
 * Writes `shots/boot/<tag>/frames.json`: the full compositor frame-arrival
 * series, the gap distribution, and the gaps attributed to the load stage they
 * fell in. That file is the deliverable for anyone measuring init, not the
 * summary line — see the note on `writeFrameSeries`.
 *
 * ## Why this is not just "screenshot at the end"
 *
 * The overlay's whole job is what it shows *during* a load, and its hardest
 * claim is that it keeps moving while procedural generation has the main
 * thread pinned. So this photographs the same load repeatedly on a wall-clock
 * schedule and never asks the page a question while it is doing it: a
 * `page.evaluate` would queue behind the block and only answer once the block
 * was over, which would prove nothing about the moment it was asked. CDP
 * screenshots are served by the browser process from the compositor, so they
 * come back during a block, which is exactly the case under test.
 *
 * ## Cold means a browser profile that has never seen this page
 *
 * Every other harness here uses the default incognito context. That is cold by
 * accident, but it is also thrown away, so it can never be compared with a warm
 * load. `launchPersistentContext` over a fresh temp directory gives a real cold
 * profile — no HTTP cache and, more importantly, no GPU program cache — and
 * then reloading in the same profile gives the warm case for free.
 *
 * Port 5163. Builds into `.shot-build/boot/`, never into `.shot-build/` itself.
 */
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOptions, assertSceneGpu, readGpuInfo, isSoftwareRenderer } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(".shot-build", "boot");
const OUT_DIR = path.join(ROOT, "shots", "boot");
const PORT = 5163;

const argv = process.argv.slice(2);
const KNOWN = new Set(["--no-build", "--warm-only", "--fail-only", "--timeout"]);
for (const a of argv) {
  if (a.startsWith("--") && !KNOWN.has(a.split("=")[0])) {
    console.error(`[boot] unknown flag ${a}. Known: ${[...KNOWN].join(", ")}`);
    process.exit(2);
  }
}
const flag = (n) => argv.includes(`--${n}`);
const TIMEOUT_MS = 300_000;

/** When to photograph, in seconds from navigation. Dense early, then sparse. */
const SCHEDULE = [0.35, 1.2, 2.5, 4, 6.5, 9, 12, 16, 21, 26, 31, 34, 45, 60, 75, 92, 95, 120, 150, 190, 230, 270];

let server = null;
let ctx = null;
const profiles = [];
const failures = [];

async function shutdown(code, why) {
  if (why) console.error(`[boot] teardown: ${why}`);
  try {
    await ctx?.close();
  } catch {}
  try {
    await server?.close();
  } catch {}
  for (const d of profiles) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  const listening = await portInUse(PORT);
  console.log(`[boot] port ${PORT} after teardown: ${listening ? "STILL LISTENING" : "free"}`);
  process.exit(listening ? 1 : code);
}
process.on("SIGINT", () => shutdown(130, "interrupted"));
process.on("SIGTERM", () => shutdown(143, "terminated"));
process.on("uncaughtException", (e) => shutdown(1, e?.stack ?? String(e)));
process.on("unhandledRejection", (e) => shutdown(1, e?.stack ?? String(e)));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    setTimeout(() => (s.destroy(), resolve(false)), 800);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Records every value `#loading`'s textContent takes, from inside the page.
 *
 * This exists because of a real silent break: for one round `#loading` was
 * retained as an empty marker and nothing wrote to it, so `lightProbe.mjs`,
 * `reticleprobe.mjs` and `shoot7.mjs` printed `""` as their only diagnostic in
 * exactly the failure case they were written for. `textContent` on an empty div
 * is `""`, so no guard anywhere could catch it. A test is the only thing that
 * can, and it has to record from inside the page: `#loading` is removed on
 * rendered frame 2, and for the eleven seconds before that the main thread is
 * blocked and cannot be polled from outside.
 */
const MIRROR_PROBE = `
window.__LOADING_MIRROR = [];
(() => {
  const start = () => {
    const el = document.getElementById("loading");
    if (!el) return void setTimeout(start, 5);
    const rec = () => {
      const text = el.textContent ?? "";
      const last = window.__LOADING_MIRROR[window.__LOADING_MIRROR.length - 1];
      if (!last || last.text !== text) window.__LOADING_MIRROR.push({ t: Math.round(performance.now()), text });
    };
    rec();
    new MutationObserver(rec).observe(el, { childList: true, characterData: true, subtree: true });
  };
  start();
})();
`;

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/**
 * The full frame-arrival series and its gap distribution, on disk.
 *
 * The first version of this harness printed the longest gap and threw the
 * series away, which is the same mistake in miniature as the one above:
 * a number that passes is not evidence, and Perf asked for the distribution
 * because *where* the gaps cluster is the attribution — a 5 s gap during
 * `init()` would mean the overlay's compositor animations are not actually
 * independent of the main thread, and the same gap during shader compilation
 * means the driver has the GPU and nothing on the page can be composited at
 * all. Those are opposite conclusions from the same maximum.
 */
async function writeFrameSeries(dir, tag, frameTimes, trace, navOffsetMs, wallMs) {
  const gaps = [];
  for (let i = 1; i < frameTimes.length; i++) gaps.push({ at: frameTimes[i - 1], gap: +(frameTimes[i] - frameTimes[i - 1]).toFixed(3) });

  // `trace` is page time (ms since navigation); frame arrivals are seconds
  // since the harness called goto. One offset reconciles them.
  const stageAt = (elapsedS) => {
    const pageMs = elapsedS * 1000 - navOffsetMs;
    let label = "before first status";
    for (const e of trace ?? []) {
      if (e.t <= pageMs) label = e.text;
      else break;
    }
    return label;
  };

  const byStage = new Map();
  for (const g of gaps) {
    const s = stageAt(g.at);
    const rec = byStage.get(s) ?? { stage: s, frames: 0, totalGapS: 0, maxGapS: 0 };
    rec.frames++;
    rec.totalGapS += g.gap;
    rec.maxGapS = Math.max(rec.maxGapS, g.gap);
    byStage.set(s, rec);
  }

  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const HIST = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, Infinity];
  const histogram = HIST.map((hi, i) => ({
    upToS: hi === Infinity ? null : hi,
    count: gaps.filter((g) => g.gap <= hi && g.gap > (i ? HIST[i - 1] : 0)).length,
  }));

  const summary = {
    tag,
    wallMs,
    navOffsetMs: Math.round(navOffsetMs),
    frameCount: frameTimes.length,
    meanFps: +(frameTimes.length / (wallMs / 1000)).toFixed(2),
    gapSeconds: {
      p50: +quantile(sorted, 0.5).toFixed(3),
      p90: +quantile(sorted, 0.9).toFixed(3),
      p99: +quantile(sorted, 0.99).toFixed(3),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    },
    histogram,
    byStage: [...byStage.values()].map((r) => ({ ...r, totalGapS: +r.totalGapS.toFixed(2), maxGapS: +r.maxGapS.toFixed(3) })),
    statusTrace: trace ?? null,
    // The raw series last, so the summary is readable without scrolling past it.
    frameArrivalSeconds: frameTimes,
  };
  await fs.writeFile(path.join(dir, "frames.json"), JSON.stringify(summary, null, 2));

  console.log(
    `  [${tag}] gaps: p50 ${summary.gapSeconds.p50}s, p90 ${summary.gapSeconds.p90}s, ` +
      `p99 ${summary.gapSeconds.p99}s, max ${summary.gapSeconds.max}s`
  );
  for (const r of summary.byStage) {
    console.log(`  [${tag}]   ${r.frames} frames in "${r.stage}" — worst gap ${r.maxGapS}s`);
  }
  return summary;
}

/**
 * Photographs the page on the schedule while waiting for `scene-ready`.
 *
 * Via `Page.startScreencast`, not `page.screenshot`. The first version of this
 * harness used `page.screenshot` and every single capture attempted during
 * procedural generation timed out at 15 s, because that path waits on the
 * page's own main thread — the one that is blocked. A screencast is pushed
 * from the browser side whenever the compositor produces a frame, so it can
 * photograph precisely the stretches that matter here, and the arrival times
 * of its frames are themselves the measurement of whether the overlay's
 * animations are still running while nothing else is.
 */
async function loadAndShoot(page, url, tag, query = "") {
  const dir = path.join(OUT_DIR, tag);
  await fs.mkdir(dir, { recursive: true });
  const t0 = Date.now();
  let ready = false;
  let crashed = null;
  page.once("crash", () => (crashed = "the tab crashed"));

  const cdp = await page.context().newCDPSession(page);
  const pending = [...SCHEDULE];
  const shots = [];
  /** Arrival time of every compositor frame, in ms from navigation. */
  const frameTimes = [];
  const writes = [];

  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    const el = (Date.now() - t0) / 1000;
    frameTimes.push(+el.toFixed(2));
    if (ready || pending.length === 0 || el < pending[0]) return;
    while (pending.length && el >= pending[0]) pending.shift();
    const file = path.join(dir, `t${el.toFixed(1).replace(".", "_")}s.png`);
    shots.push({ at: +el.toFixed(1), file });
    console.log(`  [${tag}] ${el.toFixed(1)}s -> ${path.relative(ROOT, file)}`);
    writes.push(fs.writeFile(file, Buffer.from(f.data, "base64")));
  });

  await page.goto(url + query, { waitUntil: "commit", timeout: 60_000 });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: 1600, maxHeight: 900, everyNthFrame: 3 });

  const readyPromise = page
    .waitForFunction(() => window.__SCENE_READY === true, null, { timeout: TIMEOUT_MS })
    .then(() => (ready = true))
    .catch(() => {});

  await readyPromise;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await Promise.all(writes);
  const wallMs = Date.now() - t0;

  // The claim under test: the overlay keeps moving while the main thread is
  // pinned. A gap here is a stretch during which the compositor produced
  // nothing at all, which is what a frozen loading screen looks like.
  let worstGap = 0;
  let worstAt = 0;
  for (let i = 1; i < frameTimes.length; i++) {
    const g = frameTimes[i] - frameTimes[i - 1];
    if (g > worstGap) (worstGap = g), (worstAt = frameTimes[i - 1]);
  }
  console.log(
    `  [${tag}] ${frameTimes.length} compositor frames over ${(wallMs / 1000).toFixed(1)}s; ` +
      `longest gap ${worstGap.toFixed(2)}s at t=${worstAt.toFixed(1)}s`
  );

  // Reconciles page time with harness time. Only safe to ask now: an evaluate
  // issued during `init()` queues behind the block.
  const cal = crashed || !ready ? null : await page.evaluate(() => ({ now: performance.now(), epoch: Date.now() })).catch(() => null);
  const navOffsetMs = cal ? cal.epoch - cal.now - t0 : 0;
  const trace = cal ? await page.evaluate(() => window.__BOOT_TRACE ?? null).catch(() => null) : null;
  if (frameTimes.length) await writeFrameSeries(dir, tag, frameTimes, trace, navOffsetMs, wallMs);
  // Two different stalls are possible and only one of them is this overlay's
  // fault. A gap during `init()` means the compositor animations are not
  // actually running independently of the main thread, which is a defect here.
  // A gap during shader compilation means the driver has the GPU and nothing
  // on the page can be composited at all — measured at 4.5 s on a cold load,
  // and not something a loading screen can do anything about. Hence a warning
  // band above a hard limit rather than one threshold.
  if (worstGap > 2.5) console.log(`  [${tag}] NOTE: a ${worstGap.toFixed(2)}s gap is long enough to read as a freeze`);
  if (worstGap > 8) failures.push(`${tag}: compositor stalled for ${worstGap.toFixed(2)}s at t=${worstAt.toFixed(1)}s — the overlay froze`);

  if (crashed) {
    failures.push(`${tag}: ${crashed}`);
    return { tag, wallMs, crashed, shots };
  }
  if (!ready) {
    failures.push(`${tag}: never reached __SCENE_READY within ${TIMEOUT_MS / 1000}s`);
    return { tag, wallMs, shots };
  }

  // Only now, once the main thread is free, is it safe to ask questions.
  const state = await page.evaluate(() => ({
    bootPresent: !!document.getElementById("boot"),
    loadingPresent: !!document.getElementById("loading"),
    mirror: window.__LOADING_MIRROR ?? null,
    errors: (window.__SYSTEM_ERRORS ?? []).map((e) => `${e.system}/${e.phase}: ${e.message}`),
    timings: window.__INIT_TIMINGS ?? null,
    contextLost: window.__CONTEXT_LOST ?? null,
    frames: window.__GAME?.renderer?.info?.render?.frame ?? null,
  }));
  await page.screenshot({ path: path.join(dir, "zz-after-ready.png"), timeout: 15_000 });

  /* The regression guard for the silent break described at MIRROR_PROBE.
   * Three conditions, because each one fails differently:
   *   - non-empty, or the three probe harnesses print "" as before;
   *   - more than one distinct value, or the mirror is a stuck constant that
   *     cannot name the system a load hung in;
   *   - names the most expensive system, since that is the one a hang is most
   *     likely to be inside and the one worth being able to point at. */
  const mirror = state.mirror ?? [];
  const texts = mirror.map((m) => m.text).filter((t) => t.length > 0);
  const distinct = new Set(texts);
  if (!texts.length) failures.push(`${tag}: #loading was never written to — lightProbe/reticleprobe/shoot7 would print ""`);
  else if (distinct.size < 2) failures.push(`${tag}: #loading held one constant value (${[...distinct][0]}) — it cannot name a hung system`);
  else if (!texts.includes("shaping the ground"))
    failures.push(`${tag}: #loading never carried terrain's label; saw ${[...distinct].join(" / ")}`);
  else console.log(`  [${tag}] #loading mirror: ${mirror.length} values, e.g. ${[...distinct].slice(0, 4).join(" -> ")}`);

  return { tag, wallMs, ready: true, shots, ...state };
}

/** A second pass with the overlay pinned open, so 100% can be photographed. */
async function shootFinalState(page, url, tag) {
  const dir = path.join(OUT_DIR, tag);
  await fs.mkdir(dir, { recursive: true });
  await page.goto(`${url}?boothold=3000`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: TIMEOUT_MS });
  const file = path.join(dir, "hold-100pct.png");
  await page.screenshot({ path: file, timeout: 15_000 });
  console.log(`  [${tag}] held at ready -> ${path.relative(ROOT, file)}`);
  await page.waitForTimeout(3500);
  const gone = await page.evaluate(() => !document.getElementById("boot"));
  if (!gone) failures.push(`${tag}: overlay still present after boothold expired`);
  await page.screenshot({ path: path.join(dir, "hold-dismissed.png"), timeout: 15_000 });
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (!flag("no-build")) {
    console.log("[boot] building into .shot-build/boot");
    await build({ root: ROOT, logLevel: "error", build: { outDir: BUILD_DIR, target: "es2022", sourcemap: false } });
  }

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use — pick another`);
  server = await preview({
    root: ROOT,
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`[boot] serving ${url}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dawn-boot-"));
  profiles.push(dir);
  ctx = await chromium.launchPersistentContext(dir, { ...launchOptions(), viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(MIRROR_PROBE);

  // A shader that fails to link renders without its effect and logs nothing
  // else, so this is a hard failure, not a warning.
  page.on("console", (m) => {
    const t = m.text();
    if (/shader|program|link|compile/i.test(t) && /error|fail/i.test(t)) failures.push(`shader: ${t.slice(0, 200)}`);
    if (/error|fail|lost/i.test(t) && m.type() === "error") console.log(`    page: ${t.slice(0, 180)}`);
  });
  page.on("pageerror", (e) => failures.push(`pageerror: ${String(e).slice(0, 200)}`));

  if (flag("fail-only")) {
    // Requirement: if a system is missing from the scene, the overlay must say
    // so rather than present a plausible frame with a hole in it. `Game`
    // isolates a throwing system and records it on `__SYSTEM_ERRORS`, so the
    // honest way to exercise the *display* — without breaking a system for
    // everyone in a shared tree — is to put an entry on that array. This tests
    // the report, not the isolation; the isolation has its own coverage.
    await page.addInitScript(() => {
      const push = () => {
        const arr = window.__SYSTEM_ERRORS;
        if (!arr) return void setTimeout(push, 20);
        arr.push({ system: "vegetation", phase: "init", message: "injected fault, to photograph the failure report" });
      };
      push();
    });
    const dir = path.join(OUT_DIR, "failure");
    await fs.mkdir(dir, { recursive: true });
    await page.goto(url, { waitUntil: "commit", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: TIMEOUT_MS });
    const file = path.join(dir, "system-failed.png");
    await page.screenshot({ path: file, timeout: 15_000 });
    console.log(`  [failure] -> ${path.relative(ROOT, file)}`);
    const shown = await page.evaluate(() => document.querySelector("#boot .boot-fail")?.textContent?.trim() ?? null);
    console.log(`  [failure] overlay says: ${shown ?? "(nothing — the report did not reach the screen)"}`);
    if (!shown || !shown.includes("vegetation")) failures.push("failure: the overlay did not name the failed system");
    await page.waitForTimeout(5000);
    if (!(await page.evaluate(() => !document.getElementById("boot"))))
      failures.push("failure: the overlay never dismissed after holding the failure");
    else console.log("  [failure] overlay dismissed after the hold, as intended");
    if (failures.length) for (const f of failures) console.log(`[boot] FAIL ${f}`);
    return failures.length ? 1 : 0;
  }

  const results = [];
  if (!flag("warm-only")) {
    console.log("\n[boot] COLD — brand new browser profile, no GPU program cache");
    results.push(await loadAndShoot(page, url, "cold"));
  }
  console.log("\n[boot] WARM — same profile, reloaded");
  results.push(await loadAndShoot(page, url, "warm"));

  // GPU, from the live context that drew the frames, after the last load.
  const info = await readGpuInfo(page);
  console.log(`[boot] GPU: ${info.renderer}  aniso ${info.maxAnisotropy}`);
  if (isSoftwareRenderer(info.renderer)) failures.push(`software rasteriser: ${info.renderer}`);
  const sceneGpu = await assertSceneGpu(page, { tag: "boot", when: "after the warm load" });
  console.log(`[boot] scene context: ${sceneGpu}`);

  console.log("\n[boot] holding the overlay open to photograph 100%");
  await shootFinalState(page, url, "final");

  console.log("\n[boot] ===================== summary =====================");
  for (const r of results) {
    if (!r.ready) {
      console.log(`${r.tag}: FAILED after ${(r.wallMs / 1000).toFixed(1)}s — ${r.crashed ?? "no scene-ready"}`);
      continue;
    }
    console.log(
      `${r.tag}: ready in ${(r.wallMs / 1000).toFixed(1)}s, ${r.shots.length} in-load frames captured, ` +
        `#boot ${r.bootPresent ? "STILL PRESENT" : "removed"}, #loading ${r.loadingPresent ? "STILL PRESENT" : "removed"}`
    );
    if (r.timings) {
      const ranked = Object.entries(r.timings).sort((a, b) => b[1] - a[1]);
      console.log(`   init: ${ranked.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(2)}s`).join(", ")}`);
    }
    if (r.bootPresent) failures.push(`${r.tag}: the overlay was still on screen after scene-ready`);
    for (const e of r.errors) console.log(`   SYSTEM ERROR ${e}`);
    if (r.contextLost) failures.push(`${r.tag}: WebGL context lost — ${JSON.stringify(r.contextLost)}`);
  }

  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`[boot] FAIL ${f}`);
  }
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`\n[boot] FAILED: ${e.stack ?? e.message}`);
  code = 1;
}
await shutdown(code);
