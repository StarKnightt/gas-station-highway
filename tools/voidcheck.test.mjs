/**
 * `node tools/voidcheck.test.mjs`
 *
 * Forces each of the five void conditions in `QUIET-HOST-PROTOCOL.md` §4.1 and
 * confirms it actually voids the run.
 *
 * **A void condition that has never been observed to fire is not known to work.**
 * The protocol's whole purpose is that a contended run gets discarded rather than
 * argued over, and that only holds if each gate has been seen to trigger on an
 * input that should trigger it — and, just as importantly, seen *not* to trigger
 * on a clean one, because a gate that always fires gets disabled within a day.
 */

import { evaluateVoidConditions, evaluateColdLoads, formatVerdict, LIMITS } from "./voidcheck.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A run record that passes all five. Each case below breaks exactly one field. */
function cleanRun() {
  return {
    readyMs: 24_000,
    died: null,
    survived: true,
    browserDeath: null,
    contextLost: null,
    parked: { frames: 6000, meanMs: 9.1, medianMs: 9.0, over100: 0 },
    steadyState: { frames: 40_000, meanMs: 12.4, medianMs: 11.8, over100: 0 },
    overall: { frames: 45_000, medianMs: 11.9 },
    vram: {
      totalMiB: 8188,
      baseMeanMiB: 1200,
      baseDriftMiB: 30,
      phases: [
        { phase: "baseline", minMiB: 1190, meanMiB: 1200, maxMiB: 1215, utilMeanPct: 2 },
        { phase: "init", minMiB: 1400, meanMiB: 2100, maxMiB: 3000, utilMeanPct: 40 },
        { phase: "steady", minMiB: 3200, meanMiB: 3210, maxMiB: 3220, utilMeanPct: 30 },
        { phase: "parked-control", minMiB: 3200, meanMiB: 3205, maxMiB: 3210, utilMeanPct: 12 },
        { phase: "walk", minMiB: 3200, meanMiB: 3260, maxMiB: 3300, utilMeanPct: 55 },
      ],
    },
  };
}

console.log("\n--- the control: a clean run must NOT be voided ---");
{
  const r = evaluateVoidConditions(cleanRun());
  check("clean run counts", r.void === false, `fired=${JSON.stringify(r.fired)} undecidable=${JSON.stringify(r.undecidable)}`);
  // Four voting conditions: 2 was downgraded to advisory by ruling (2026-08-29).
  check("all four voting conditions were evaluated", r.checked.length === 4, `checked ${r.checked.length}`);
  check("nothing undecidable on a complete record", r.undecidable.length === 0);
}

console.log("\n--- the report must not print a fired condition as ok ---");
{
  // The rehearsal caught this: `checked` holds every evaluated condition
  // including the violated ones, so the formatter printed "ok 1." immediately
  // above "VOID 1." for the same condition. Four ok lines then four VOID lines
  // is a report a skimming reader misreads as a pass.
  const o = cleanRun();
  o.vram.baseDriftMiB = 237;
  const r = evaluateVoidConditions(o);
  const text = formatVerdict(r);
  check("the fired condition appears once, as VOID", (text.match(/^\s+(ok|VOID)\s+1\./gm) ?? []).length === 1, text);
  check("and it is not labelled ok", !/ok\s+1\. baseline drift/.test(text), text);
  check("conditions that passed still print as ok", /ok\s+5\./.test(text), text);
}

console.log("\n--- condition 1: baseline drift ---");
{
  const o = cleanRun();
  o.vram.baseDriftMiB = LIMITS.baselineDriftMiB; // exactly at the limit: ">=" must fire
  const r = evaluateVoidConditions(o);
  check("fires at exactly the limit", r.void && r.fired.some((f) => f.id === 1));

  const o2 = cleanRun();
  o2.vram.baseDriftMiB = LIMITS.baselineDriftMiB - 1;
  check("does not fire just below the limit", evaluateVoidConditions(o2).void === false);

  const o3 = cleanRun();
  o3.vram.baseDriftMiB = 1171; // the drift actually observed on this host
  const r3 = evaluateVoidConditions(o3);
  check("fires on the 1171 MiB drift really seen", r3.void && r3.fired.some((f) => f.id === 1));
}

console.log("\n--- condition 2: GPU busy while parked ---");
{
  // DOWNGRADED TO ADVISORY BY RULING, 2026-08-29. These assertions now assert the
  // OPPOSITE of what they originally did, deliberately.
  //
  // The premise was "a static camera cannot pin the GPU". That is false for this
  // build: the renderer has no frame cap, so it pins the card near 100% whenever
  // the scene is up, and it measured 99% during the one exclusive quiet window
  // this project ever got. The quantity the condition actually wanted — another
  // process's share — is not attributable per process on WDDM.
  //
  // A gate no valid run can pass is not a gate, it is a permanent failure, and it
  // dilutes the conditions that mean something.
  const o = cleanRun();
  o.vram.phases.find((p) => p.phase === "parked-control").utilMeanPct = 95;
  const r = evaluateVoidConditions(o);
  check("95% parked utilisation does NOT void", r.void === false, JSON.stringify(r.fired));
  check("it is reported as an advisory instead", r.advisories.some((a) => /GPU busy while parked/.test(a)));
  check("and it is not a voting condition", !r.checked.some((c) => c.id === 2));

  const o2 = cleanRun();
  o2.vram.phases.find((p) => p.phase === "parked-control").utilMeanPct = 100;
  check("even 100% does not void", evaluateVoidConditions(o2).void === false);
}

console.log("\n--- condition 3: a phase minimum below baseline ---");
{
  const o = cleanRun();
  // The real fault: walk min 3875 against a 5445 baseline.
  o.vram.baseMeanMiB = 5445;
  o.vram.phases.find((p) => p.phase === "walk").minMiB = 3875;
  const r = evaluateVoidConditions(o);
  check("fires when a phase dips below baseline", r.void && r.fired.some((f) => f.id === 3));
  check("names the offending phase", r.fired.find((f) => f.id === 3).detail.includes("walk"));
}

console.log("\n--- condition 4: parked mean above walking median ---");
{
  const o = cleanRun();
  // The inversion actually measured: parked 19.78 ms, walking median 11.4 ms.
  o.parked.meanMs = 19.78;
  o.steadyState.medianMs = 11.4;
  const r = evaluateVoidConditions(o);
  check("fires on the real inversion", r.void && r.fired.some((f) => f.id === 4));

  const o2 = cleanRun();
  o2.parked.meanMs = 11.79;
  o2.steadyState.medianMs = 11.8;
  check("does not fire when parked is barely cheaper", evaluateVoidConditions(o2).void === false);

  // Falls back to the whole-walk median when steady state is absent.
  const o3 = cleanRun();
  delete o3.steadyState;
  o3.parked.meanMs = 30;
  o3.overall.medianMs = 12;
  check("falls back to overall median", evaluateVoidConditions(o3).fired.some((f) => f.id === 4));
}

console.log("\n--- condition 5: the run did not complete ---");
{
  for (const [label, mutate] of [
    ["died", (o) => (o.died = { atS: 90, reason: "page crashed" })],
    ["survived=false", (o) => (o.survived = false)],
    ["browser disconnected", (o) => (o.browserDeath = { at: "now", phase: "walk" })],
    ["context lost", (o) => (o.contextLost = { reason: "GL_OUT_OF_MEMORY" })],
    ["never ready", (o) => delete o.readyMs],
  ]) {
    const o = cleanRun();
    mutate(o);
    const r = evaluateVoidConditions(o);
    check(`fires on ${label}`, r.void && r.fired.some((f) => f.id === 5), JSON.stringify(r.fired));
  }
}

console.log("\n--- undecidable is not the same as passing ---");
{
  // The case that matters: a run with no VRAM sampling at all must not sail
  // through the three memory gates by having nothing to test.
  const o = cleanRun();
  delete o.vram;
  const r = evaluateVoidConditions(o);
  check("a run with no VRAM data is void", r.void === true);
  check("conditions 1 and 3 are undecidable, not passed", [1, 3].every((id) => r.undecidable.some((u) => u.id === id)), JSON.stringify(r.undecidable));
  check("neither 1 nor 3 is reported as checked", ![1, 3].some((id) => r.checked.some((c) => c.id === id)));

  const o2 = cleanRun();
  o2.vram.phases = o2.vram.phases.filter((p) => p.phase !== "parked-control");
  const r2 = evaluateVoidConditions(o2);
  // Advisory now, so it cannot void on its own account -- but it must still be
  // *said* rather than silently dropped, which is the whole point of the change.
  check("a missing parked control is reported, not silently dropped", r2.advisories.some((a) => /not sampled/.test(a)));

  const o3 = cleanRun();
  delete o3.parked;
  const r3 = evaluateVoidConditions(o3);
  check("no parked stats makes condition 4 undecidable", r3.undecidable.some((u) => u.id === 4) && r3.void);
}

console.log("\n--- §2.1 cold loads ---");
{
  const ok = [1, 2, 3, 4, 5].map((i) => ({ outcome: "ready", secs: 22 + i }));
  check("five clean loads pass", evaluateColdLoads(ok).pass === true, JSON.stringify(evaluateColdLoads(ok).problems));

  // The real observation: one timeout at 171.9 s against 21.9 s and 30.9 s.
  const real = [
    { outcome: "timed-out", secs: 171.9 },
    { outcome: "ready", secs: 30.9 },
    { outcome: "ready", secs: 21.9 },
  ];
  const rr = evaluateColdLoads(real);
  check("the observed contended result fails", rr.pass === false);
  check("it fails for BOTH count and outcome", rr.problems.length >= 2, JSON.stringify(rr.problems));

  // Five ready loads, but one is 3x the fastest: the spread criterion alone.
  const spread = [
    { outcome: "ready", secs: 21 },
    { outcome: "ready", secs: 22 },
    { outcome: "ready", secs: 23 },
    { outcome: "ready", secs: 24 },
    { outcome: "ready", secs: 66 },
  ];
  const rs = evaluateColdLoads(spread);
  check("a 3x spread fails even with 5/5 ready", rs.pass === false && rs.problems.some((p) => p.includes("spread")));

  const edge = [
    { outcome: "ready", secs: 20 },
    { outcome: "ready", secs: 40 },
    { outcome: "ready", secs: 30 },
    { outcome: "ready", secs: 25 },
    { outcome: "ready", secs: 22 },
  ];
  check("exactly 2x on repeats passes (limit is 'within', not 'under')", evaluateColdLoads(edge).pass === true, JSON.stringify(evaluateColdLoads(edge).problems));
}

console.log("\n--- the first load is scored separately, not as an outlier ---");
{
  // The rehearsal's real numbers: 218.7s, then 20.8s and 21.3s. All reached
  // ready, and the repeats agree closely — so the spread criterion must not fail
  // on the first load, and the first load must still be reported loudly.
  const observed = [
    { attempt: 1, outcome: "ready", secs: 218.7 },
    { attempt: 2, outcome: "ready", secs: 20.8 },
    { attempt: 3, outcome: "ready", secs: 21.3 },
  ];
  const r = evaluateColdLoads(observed, 3);
  check("repeats-only spread passes", r.ratio !== null && r.ratio <= 2, `ratio=${r.ratio}`);
  check("the run passes despite a 10x first load", r.pass === true, JSON.stringify(r.problems));
  check("the first load is reported", r.firstLoad === 218.7);
  check("and its ratio to the repeats is computed", r.firstLoadRatio !== null && r.firstLoadRatio > 10, `${r.firstLoadRatio}`);

  // But a slow first load must never hide a failure among the repeats.
  const bad = [
    { attempt: 1, outcome: "ready", secs: 218.7 },
    { attempt: 2, outcome: "ready", secs: 20.8 },
    { attempt: 3, outcome: "ready", secs: 90 },
  ];
  check("a bad repeat still fails", evaluateColdLoads(bad, 3).pass === false);

  // A failed first load is a failure, not a separate category.
  const crashedFirst = [
    { attempt: 1, outcome: "crashed", secs: 14 },
    { attempt: 2, outcome: "ready", secs: 21 },
    { attempt: 3, outcome: "ready", secs: 22 },
  ];
  const rc = evaluateColdLoads(crashedFirst, 3);
  check("a crashed first load fails the run", rc.pass === false && rc.problems.some((p) => p.includes("crashed")));
  check("and firstLoad is null rather than a time", rc.firstLoad === null);
}

console.log(`\n====== ${pass} passed, ${fail} failed ======`);
if (fail) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
