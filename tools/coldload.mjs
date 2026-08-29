#!/usr/bin/env node
/**
 * `node tools/coldload.mjs [--n=5] [--no-build] [--rehearsal]`
 *
 * Loads the scene from cold, N times, and reports whether every load reached
 * `__SCENE_READY` and how far apart the ready times were.
 *
 * ## Why this is a separate harness
 *
 * `stress.mjs` loads the scene exactly **once**, so it says nothing about
 * whether a load *reliably* succeeds. The deliverable is a single continuous
 * take that must survive init on the user's machine, once, with no second
 * attempt — and **a stutter can be re-shot while a failed init cannot be shot at
 * all**, which makes this the higher-priority reliability question of the two.
 *
 * It is not hypothetical. Under contention, four cold loads of the same bundle
 * minutes apart gave one hard `Page crashed` on `page.goto` and one timeout at
 * 171.9 s against 21.9 s and 30.9 s for the two that succeeded. Two sibling
 * agents independently reported the same two faults.
 *
 * Pass criteria are `QUIET-HOST-PROTOCOL.md` §2.1, evaluated by
 * `voidcheck.mjs#evaluateColdLoads` rather than by eye.
 *
 * Also records every non-2xx response, which covers the icon 404 that
 * `PERF.md` §13.7 removed — free to keep, and it is a regression test now.
 */

import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer } from "./gpu.mjs";
import { assertPrivateBuildDir, assertBuildIntact } from "./scratch.mjs";
import { evaluateColdLoads } from "./voidcheck.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const BUILD_DIR = ".shot-build/coldload";
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const N = Number(arg("n", "5"));
const DO_BUILD = !argv.includes("--no-build");
const REHEARSAL = argv.includes("--rehearsal");
/** Generous: the point is to distinguish slow from never, not to enforce a budget. */
const READY_TIMEOUT_MS = Number(arg("timeout", "150000"));

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`\n[coldload] ${reason}`);
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
      await fn();
    } catch (err) {
      console.error(`[coldload] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  console.log((await portInUse(PORT)) ? `[coldload] !! port ${PORT} still held` : `[coldload] teardown: port ${PORT} free`);
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
    console.log("[coldload] building...");
    assertPrivateBuildDir(ROOT, BUILD_DIR, "coldload");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }
  assertBuildIntact(ROOT, BUILD_DIR, "coldload", "the first cold load");

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;
  console.log(`[coldload] preview on :${PORT}, ${N} cold loads, ready timeout ${(READY_TIMEOUT_MS / 1000).toFixed(0)}s`);

  resources.browser = await chromium.launch(launchOptions({}));

  const loads = [];
  for (let i = 1; i <= N; i++) {
    const before = await card();
    // A fresh context per attempt: a new GPU surface and a cold shader cache
    // for the page, which is what "cold load" has to mean here.
    const context = await resources.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let crashed = false;
    const bad = [];
    page.on("crash", () => (crashed = true));
    page.on("response", (r) => {
      if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
    });
    page.on("requestfailed", (r) => bad.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ""}`));

    let outcome = "ready";
    let gpu = null;
    const t0 = Date.now();
    try {
      await page.goto(base, { waitUntil: "load", timeout: 120_000 });
      if (i === 1) {
        gpu = await assertHardwareGpu(page, { tag: "coldload" });
        if (isSoftwareRenderer(gpu?.renderer)) throw new Error(`software renderer: ${gpu.renderer}`);
      }
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch (e) {
      const msg = String(e?.message ?? e).split("\n")[0];
      outcome = crashed || /crash/i.test(msg) ? "crashed" : /Timeout|timeout/.test(msg) ? "timed-out" : `error: ${msg}`;
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(1);
    const after = await card();
    loads.push({ attempt: i, outcome, secs, cardBefore: before?.used ?? null, cardAfter: after?.used ?? null, gpuUtil: before?.util ?? null, nonOk: bad });
    console.log(
      `[coldload] ${i}/${N}: ${outcome} in ${secs}s   card ${before?.used ?? "?"} -> ${after?.used ?? "?"} MiB, gpu ${before?.util ?? "?"}%` +
        (bad.length ? `   non-2xx: ${bad.join(", ")}` : "")
    );
    try {
      await context.close();
    } catch {
      /* a crashed context can refuse to close; the attempt is already recorded */
    }
  }

  const verdict = evaluateColdLoads(loads, N);
  const anyNonOk = loads.some((l) => l.nonOk.length);

  console.log(`\n=================== cold loads (QUIET-HOST-PROTOCOL.md §2.1) ===================`);
  for (const l of loads) console.log(`  ${l.attempt}. ${l.outcome.padEnd(11)} ${String(l.secs).padStart(6)}s   card ${l.cardBefore} -> ${l.cardAfter} MiB`);
  console.log(`  reached ready   ${verdict.readyCount} / ${loads.length}`);
  if (verdict.fastest !== null) console.log(`  repeat spread   ${verdict.fastest}s to ${verdict.slowest}s  (${verdict.ratio.toFixed(1)}x, limit 2.0x)`);
  if (verdict.firstLoad !== null) {
    // The number the user actually experiences: their run is a first load.
    console.log(
      `  FIRST LOAD      ${verdict.firstLoad}s` +
        (verdict.firstLoadRatio ? `  (${verdict.firstLoadRatio.toFixed(1)}x the ${verdict.medianRepeat}s median repeat)` : "")
    );
    if (verdict.firstLoadRatio && verdict.firstLoadRatio > 2) {
      console.log(`                  ^ the user's run IS a first load. A warm repeat time is not the figure that matters.`);
    }
  }
  console.log(`  any non-2xx     ${anyNonOk ? "YES — see above" : "no"}`);
  console.log(`  verdict         ${verdict.pass ? "PASS" : "FAIL"}`);
  for (const p of verdict.problems) console.log(`    - ${p}`);
  if (REHEARSAL) {
    console.log(`\n  REHEARSAL: this was a test of the harness on a contended host. Every number`);
    console.log(`  here is void by construction and must not be quoted as a result.`);
  }
  console.log(`================================================================================`);

  await fs.mkdir(path.join(ROOT, "tools", "perf-out"), { recursive: true });
  const file = path.join(ROOT, "tools", "perf-out", `coldload-${REHEARSAL ? "REHEARSAL-" : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify({ when: new Date().toISOString(), rehearsal: REHEARSAL, n: N, loads, verdict }, null, 2));
  console.log(`[coldload] record: ${path.relative(ROOT, file)}`);

  // A rehearsal on a contended host is expected to fail its criteria, so it must
  // not report failure as if it were a result about the scene.
  return REHEARSAL ? 0 : verdict.pass && !anyNonOk ? 0 : 1;
}

await run().then(
  (code) => shutdown(code),
  (err) => shutdown(1, err?.stack ?? String(err))
);
