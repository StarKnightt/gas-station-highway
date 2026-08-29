#!/usr/bin/env node
/**
 * `node tools/firstload.mjs [--n=4] [--probe-at=1] [--no-build]`
 *
 * Is the first load of this scene really 3-10x slower than the loads after it,
 * or was that my own instrument?
 *
 * Named `firstload` and not `coldload` because Film owns `tools/coldload.mjs`
 * and its three-condition design is better for the cold-versus-warm question.
 * This file asks a narrower and more urgent one: **whether the observation that
 * started all of it is real.**
 *
 * ## The suspicion
 *
 * Two sequences reported a slow first load — 218.7 s then 20.8/21.3 s, and
 * 171.9 s then 30.9/21.9 s. Both came from harnesses I wrote, and both contained
 * this:
 *
 *     await page.goto(base, ...);
 *     if (i === 1) {                                  // <- attempt 1 only
 *       gpu = await assertHardwareGpu(page, ...);      // <- allocates a SECOND
 *     }                                               //    WebGL2 context
 *     await page.waitForFunction(() => window.__SCENE_READY === true, ...);
 *
 * The clock starts before `goto`, so on attempt 1 and **only** attempt 1 the
 * measured window contains an extra WebGL2 context allocation, requested with
 * `powerPreference: "high-performance"`, while the scene is generating, on a card
 * already at 6-8 GB of 8 GB. "First load" and "the attempt that does an extra
 * thing" are perfectly confounded across both sequences.
 *
 * There was also a control already sitting in the data, unexamined: `stress.mjs`
 * launches a **fresh browser and a fresh context every run** and reaches ready in
 * ~21-31 s every time, because its GPU assertion runs *after* ready rather than
 * inside the timed window. A genuinely first load, in a genuinely fresh browser,
 * that is fast.
 *
 * ## Design: symmetry, then a substitution control
 *
 * Phase 1 — every attempt runs a **byte-identical** code path. The GPU assertion
 * happens once on a throwaway page before the loop, so it is outside every
 * measurement. If attempt 1 is now the same as the rest, position was never the
 * variable.
 *
 * Phase 2 — the substitution control, which is what makes this an attribution
 * rather than a disappearance: put the extra probe back, on a **later** attempt
 * (`--probe-at=3`). If the penalty follows the probe instead of staying with
 * position 1, the probe is the cause. Eliminating a suspect is not an
 * attribution; moving the effect is.
 */

import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer, readGpuInfo } from "./gpu.mjs";
import { assertPrivateBuildDir, assertBuildIntact } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const BUILD_DIR = ".shot-build/firstload";
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const N = Number(arg("n", "4"));
/** Which attempt gets the extra in-window WebGL probe. 0 = none (the clean run). */
const PROBE_AT = Number(arg("probe-at", "0"));
const DO_BUILD = !argv.includes("--no-build");
const READY_TIMEOUT_MS = Number(arg("timeout", "300000"));

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`\n[firstload] ${reason}`);
  try {
    await resources.browser?.close();
  } catch {}
  try {
    const s = resources.server;
    if (s?.close) await s.close();
    else if (s?.httpServer) await new Promise((r) => s.httpServer.close(r));
  } catch {}
  console.log((await portInUse(PORT)) ? `[firstload] !! port ${PORT} still held` : `[firstload] teardown: port ${PORT} free`);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? e));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? e));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    setTimeout(() => done(false), 700);
  });
}

function card() {
  return new Promise((r) =>
    execFile("nvidia-smi", ["--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 4000 }, (e, o) => {
      if (e) return r(null);
      const [used, util] = String(o).trim().split(/,\s*/).map(Number);
      r({ used, util });
    })
  );
}

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);

  if (DO_BUILD) {
    console.log("[firstload] building...");
    assertPrivateBuildDir(ROOT, BUILD_DIR, "firstload");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }
  assertBuildIntact(ROOT, BUILD_DIR, "firstload", "the first load");

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;
  resources.browser = await chromium.launch(launchOptions({}));

  /* The GPU check, once, on a throwaway page, OUTSIDE every measurement. This
   * placement is the entire point of the file. */
  {
    const scratchPage = await resources.browser.newPage();
    await scratchPage.goto("about:blank");
    const gpu = await readGpuInfo(scratchPage);
    if (isSoftwareRenderer(gpu?.renderer)) throw new Error(`software renderer: ${gpu.renderer}`);
    console.log(`[firstload] GPU: ${gpu.renderer}`);
    await scratchPage.close();
  }

  console.log(
    `[firstload] preview on :${PORT}; ${N} attempts, identical code path` +
      (PROBE_AT ? `, EXCEPT attempt ${PROBE_AT} which gets the extra in-window WebGL probe (substitution control)` : "")
  );

  const attempts = [];
  for (let i = 1; i <= N; i++) {
    const before = await card();
    const context = await resources.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let crashed = false;
    page.on("crash", () => (crashed = true));

    let outcome = "ready";
    const probed = i === PROBE_AT;
    const t0 = Date.now();
    try {
      await page.goto(base, { waitUntil: "load", timeout: 120_000 });
      if (probed) {
        // Deliberately reproducing the defect, in the same position in the same
        // timed window, to see whether the penalty travels with it.
        const gpu = await assertHardwareGpu(page, { tag: "firstload-probe" });
        if (isSoftwareRenderer(gpu?.renderer)) throw new Error(`software renderer: ${gpu.renderer}`);
      }
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
    } catch (e) {
      const msg = String(e?.message ?? e).split("\n")[0];
      outcome = crashed || /crash/i.test(msg) ? "crashed" : /[Tt]imeout/.test(msg) ? "timed-out" : `error: ${msg}`;
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(1);
    const after = await card();
    attempts.push({ attempt: i, probed, outcome, secs, cardBefore: before?.used ?? null, cardAfter: after?.used ?? null, gpuUtil: before?.util ?? null });
    console.log(
      `[firstload] ${i}/${N}${probed ? " [PROBED]" : "         "}: ${outcome} in ${secs}s   ` +
        `card ${before?.used ?? "?"} -> ${after?.used ?? "?"} MiB, gpu ${before?.util ?? "?"}%`
    );
    try {
      await context.close();
    } catch {}
  }

  const line = (s = "") => console.log(s);
  const ready = attempts.filter((a) => a.outcome === "ready");
  line();
  line("=============== is the first load special? ===============");
  for (const a of attempts) {
    line(`  attempt ${a.attempt}${a.probed ? " (extra WebGL probe in window)" : ""}: ${a.outcome === "ready" ? `${a.secs}s` : a.outcome}`);
  }
  line();
  if (ready.length >= 2) {
    const times = ready.map((a) => a.secs);
    const fastest = Math.min(...times);
    const slowest = Math.max(...times);
    line(`  spread across all attempts: ${fastest}s to ${slowest}s (${(slowest / fastest).toFixed(2)}x)`);
    const first = attempts[0];
    const rest = ready.filter((a) => a.attempt !== 1).map((a) => a.secs);
    if (first.outcome === "ready" && rest.length) {
      const medianRest = [...rest].sort((a, b) => a - b)[Math.floor(rest.length / 2)];
      line(`  attempt 1 vs median of the rest: ${first.secs}s vs ${medianRest}s = ${(first.secs / medianRest).toFixed(2)}x`);
    }
    if (PROBE_AT) {
      const probedRun = attempts.find((a) => a.probed);
      const unprobed = ready.filter((a) => !a.probed).map((a) => a.secs);
      const medianUnprobed = unprobed.length ? [...unprobed].sort((a, b) => a - b)[Math.floor(unprobed.length / 2)] : null;
      line();
      line(`  SUBSTITUTION CONTROL: the probe was moved to attempt ${PROBE_AT}.`);
      line(
        `    probed attempt: ${probedRun.outcome === "ready" ? `${probedRun.secs}s` : probedRun.outcome}` +
          (medianUnprobed ? `   unprobed median: ${medianUnprobed}s` : "")
      );
      line(`    If the penalty followed the probe, the probe is the cause and the`);
      line(`    "first load is slow" finding was an artefact of my own harness.`);
    }
  } else {
    line(`  Only ${ready.length} attempt(s) reached ready; not enough to compare.`);
  }
  line("==========================================================");

  await fs.mkdir(path.join(ROOT, "tools", "perf-out"), { recursive: true });
  const file = path.join(ROOT, "tools", "perf-out", `firstload-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify({ when: new Date().toISOString(), probeAt: PROBE_AT, attempts }, null, 2));
  console.log(`[firstload] record: ${path.relative(ROOT, file)}`);
  return 0;
}

await run().then(
  (code) => shutdown(code),
  (err) => shutdown(1, err?.stack ?? String(err))
);
