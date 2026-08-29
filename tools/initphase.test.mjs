#!/usr/bin/env node
/**
 * `node tools/initphase.test.mjs`
 *
 * Tests `src/core/initPhase.ts`, the sub-phase timing helper published for
 * Terrain. It is instrumentation, so nothing in the scene breaks if it is
 * wrong — it just reports the wrong number, quietly, to whoever is trying to
 * find 14 seconds. That is the failure mode this project has lost the most time
 * to, so it gets a test.
 *
 * The TS is transformed with esbuild (already a vite dependency) and imported
 * from a data URL, against a stub `window`, so the real source is under test
 * rather than a transcription of it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = {};

/* Via vite's `transformWithOxc`. Not esbuild: this project is on vite 8, which
 * moved to oxc, and `transformWithEsbuild` now throws unless esbuild is
 * installed separately. Not node's `--experimental-strip-types` either, because
 * that would need the flag at the call site and this should be runnable as a
 * bare `node tools/initphase.test.mjs` alongside the other suites. */
const { transformWithOxc } = await import("vite");
const srcPath = path.join(ROOT, "src/core/initPhase.ts");
const src = await fs.readFile(srcPath, "utf8");
const { code } = await transformWithOxc(src, srcPath, { lang: "ts" });
const { initPhases } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

let failures = 0;
const quiet = () => {
  const orig = console.log;
  console.log = () => {};
  return () => (console.log = orig);
};
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : `\n        ${detail}`}`);
}
/** Burn wall time without sleeping, so the test stays synchronous. */
const burn = (ms) => {
  const t = performance.now();
  while (performance.now() - t < ms) {
    /* spin */
  }
};

console.log("[initphase] tests");

{
  const restore = quiet();
  const phase = initPhases("t1");
  phase("a");
  burn(30);
  phase("b");
  burn(15);
  phase.end();
  restore();
  const r = window.__INIT_PHASES.t1;
  check("publishes under the system name", !!r);
  check("both phases recorded", r.phases.length === 2, JSON.stringify(r.phases));
  check("sorted by cost, dearest first", r.phases[0].label === "a", JSON.stringify(r.phases));
  check("phase a is roughly 30 ms", r.phases[0].ms > 20 && r.phases[0].ms < 200, `${r.phases[0].ms}`);
  check(
    "accounted is within a few ms of total",
    Math.abs(r.totalMs - r.accountedMs) < 8,
    `total ${r.totalMs} accounted ${r.accountedMs}`
  );
}

{
  /* The property that matters most: time no phase claimed must show up. A
   * helper that only reported its labelled phases would let a system instrument
   * three cheap sections, watch them sum to 400 ms, and conclude init was fast
   * with 13 s sitting in the gaps. */
  const restore = quiet();
  const phase = initPhases("t2");
  burn(40); // before any phase opens
  phase("only");
  burn(10);
  phase.end();
  restore();
  const r = window.__INIT_PHASES.t2;
  check("unaccounted time is reported, not absorbed", r.unaccountedMs > 25, `unaccounted ${r.unaccountedMs}`);
  check("and is not folded into the labelled phase", r.phases[0].ms < 30, `${r.phases[0].ms}`);
}

{
  const restore = quiet();
  const phase = initPhases("t3");
  const out = phase.of("wrapped", () => {
    burn(20);
    return 42;
  });
  phase.end();
  restore();
  const r = window.__INIT_PHASES.t3;
  check("phase.of returns the value", out === 42, `${out}`);
  check("phase.of records the cost", r.phases[0].label === "wrapped" && r.phases[0].ms > 12, JSON.stringify(r.phases));
}

{
  // A throw inside phase.of must still close the phase, or every later phase
  // inherits the failed one's label.
  const restore = quiet();
  const phase = initPhases("t4");
  try {
    phase.of("boom", () => {
      burn(15);
      throw new Error("expected");
    });
  } catch {
    /* expected */
  }
  phase("after");
  burn(5);
  phase.end();
  restore();
  const r = window.__INIT_PHASES.t4;
  check("a throwing phase.of still closes its phase", r.phases.some((p) => p.label === "boom"), JSON.stringify(r.phases));
  check("and the next phase is separate", r.phases.some((p) => p.label === "after"), JSON.stringify(r.phases));
}

{
  const restore = quiet();
  const phase = initPhases("t5");
  phase("loop");
  burn(10);
  phase("other");
  burn(5);
  phase("loop"); // re-entered
  burn(10);
  phase.end();
  restore();
  const r = window.__INIT_PHASES.t5;
  const loop = r.phases.filter((p) => p.label === "loop");
  check("a re-entered label accumulates into one line", loop.length === 1, JSON.stringify(r.phases));
  check("with both visits summed", loop[0].ms > 14, `${loop[0]?.ms}`);
}

{
  const restore = quiet();
  const phase = initPhases("t6");
  phase("a");
  burn(5);
  phase.end();
  const before = window.__INIT_PHASES.t6.totalMs;
  burn(20);
  phase.end(); // second call
  phase("late"); // and a marker after end
  restore();
  const r = window.__INIT_PHASES.t6;
  check("end() is idempotent", r.totalMs === before, `${r.totalMs} vs ${before}`);
  check("a marker after end() is ignored", !r.phases.some((p) => p.label === "late"), JSON.stringify(r.phases));
}

{
  // Never instrumented, never called: must not publish a misleading zero.
  const restore = quiet();
  initPhases("t7");
  restore();
  check("a helper that is never ended publishes nothing", !window.__INIT_PHASES.t7);
}

if (failures) {
  console.error(`[initphase] ${failures} test(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("[initphase] tests passed");
}
