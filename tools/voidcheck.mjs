/**
 * The five void conditions from `QUIET-HOST-PROTOCOL.md` §4.1, as code.
 *
 * ## Why this file exists
 *
 * The protocol shipped its safeguards as **prose in a markdown document**. Five
 * numbered conditions that void a run, each requiring whoever reads the output
 * to remember them, find the relevant number in a 60-line report, and apply a
 * threshold by eye.
 *
 * That is the exact failure this project has paid for more than any other: a
 * check that is present, correct, and never actually executed. A void condition
 * nobody evaluates is not a safeguard, it is a paragraph — and the run it was
 * supposed to discard will instead be argued about, which is precisely what the
 * protocol was written to prevent.
 *
 * So the conditions live here, as a pure function over the run record, with no
 * I/O and no dependency on the harness. That makes them unit-testable, which
 * matters because **a void condition that has never been seen to fire is not
 * known to work**: see `voidcheck.test.mjs`, which forces each of the five.
 *
 * ## Contract
 *
 * Returns `{ void: boolean, fired: [...], checked: [...], undecidable: [...] }`.
 *
 * `undecidable` is load-bearing and separate from `fired`. A condition whose
 * inputs are missing has **not passed** — it could not be evaluated — and
 * collapsing that into "did not fire" is how a run with no VRAM sampling at all
 * would sail through the memory gates. A run with any undecidable condition is
 * treated as void, because the alternative is trusting a gate that never ran.
 */

/** Thresholds, named so a test cannot silently disagree with the document. */
export const LIMITS = {
  baselineDriftMiB: 100, // §4.1.1
  parkedGpuUtilPct: 50, // §4.1.2
  coldLoadSpreadRatio: 2, // §2.1
};

const num = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param out The harness's run record (`tools/perf-out/stress-*.json`).
 */
export function evaluateVoidConditions(out) {
  const fired = [];
  const checked = [];
  const undecidable = [];

  const decide = (id, title, inputsPresent, isViolated, detail) => {
    if (!inputsPresent) {
      undecidable.push({ id, title, why: detail });
      return;
    }
    checked.push({ id, title, detail });
    if (isViolated) fired.push({ id, title, detail });
  };

  const vram = out?.vram;
  const phases = Array.isArray(vram?.phases) ? vram.phases : null;

  /* 1. The host was not quiet: its own memory moved more than the gate allows. */
  decide(
    1,
    "baseline drift",
    num(vram?.baseDriftMiB),
    vram?.baseDriftMiB >= LIMITS.baselineDriftMiB,
    num(vram?.baseDriftMiB)
      ? `${vram.baseDriftMiB.toFixed(0)} MiB peak-to-trough before launch (limit ${LIMITS.baselineDriftMiB})`
      : "no pre-launch VRAM baseline was sampled"
  );

  /* 2. Something else was on the GPU: a static camera cannot pin it. */
  const parkedPhase = phases?.find((p) => p.phase === "parked-control");
  decide(
    2,
    "GPU busy while parked",
    num(parkedPhase?.utilMeanPct),
    parkedPhase?.utilMeanPct >= LIMITS.parkedGpuUtilPct,
    num(parkedPhase?.utilMeanPct)
      ? `${parkedPhase.utilMeanPct.toFixed(0)}% mean GPU utilisation with the camera static (limit ${LIMITS.parkedGpuUtilPct})`
      : "no parked-control VRAM phase was sampled; was --park set?"
  );

  /* 3. Another process released memory mid-run, so no delta is readable. A phase
   *    cannot use less than the host used before we existed.
   *
   *    The `baseline` phase is excluded, and it has to be: the baseline mean is
   *    the mean *of that phase*, so its own minimum is below it by construction
   *    unless every sample was identical. §4.1.3 as originally written ("any
   *    card phase") therefore fired on literally every run, which the clean-run
   *    control in the test caught — a gate that always fires is worse than no
   *    gate, because it gets switched off. Only phases after launch can be
   *    compared against the baseline. */
  const afterLaunch = phases?.filter((p) => p.phase !== "baseline") ?? [];
  const belowBaseline = afterLaunch.filter((p) => num(p.minMiB) && p.minMiB < vram.baseMeanMiB);
  decide(
    3,
    "phase minimum below baseline",
    !!afterLaunch.length && num(vram?.baseMeanMiB),
    belowBaseline.length > 0,
    belowBaseline.length
      ? `${belowBaseline.map((p) => `${p.phase} min ${p.minMiB} MiB`).join(", ")} vs baseline mean ${vram.baseMeanMiB.toFixed(0)} MiB`
      : afterLaunch.length
        ? `every post-launch phase stayed at or above the ${vram.baseMeanMiB?.toFixed(0)} MiB baseline mean`
        : "no post-launch VRAM phases were sampled"
  );

  /* 4. The inversion that voided every previous run: a static frame cannot cost
   *    more than a moving one if the scene is the bottleneck. */
  const walkMedian = out?.steadyState?.medianMs ?? out?.overall?.medianMs;
  decide(
    4,
    "parked mean above walking median",
    num(out?.parked?.meanMs) && num(walkMedian),
    out?.parked?.meanMs > walkMedian,
    num(out?.parked?.meanMs) && num(walkMedian)
      ? `parked mean ${out.parked.meanMs} ms vs walking median ${walkMedian} ms`
      : "missing the parked control or the walking stats"
  );

  /* 5. Not a frametime result at all. Report as a crash. */
  const deaths = [
    out?.died ? "the run died" : null,
    out?.survived === false ? "survived=false" : null,
    out?.browserDeath ? "the browser process disconnected" : null,
    out?.contextLost ? "the WebGL context was lost" : null,
    !num(out?.readyMs) ? "the scene never reached ready" : null,
  ].filter(Boolean);
  decide(
    5,
    "run did not complete",
    out !== null && typeof out === "object",
    deaths.length > 0,
    deaths.length ? deaths.join("; ") : "reached ready, survived, context intact"
  );

  return { void: fired.length > 0 || undecidable.length > 0, fired, checked, undecidable };
}

/**
 * §2.1: cold loads. Every load must reach ready, and the *repeat* loads must be
 * consistent with each other.
 *
 * ## Why the first load is scored separately
 *
 * Rehearsing this found a pattern that changes what the criterion should be.
 * Across three independent sequences on a contended host, **the first load was
 * the worst every time**: 218.7 s against 20.8 s and 21.3 s; 171.9 s (timing
 * out) against 30.9 s and 21.9 s; and a hard crash on the first attempt of the
 * sequence before that. Three for three is not the shape of random contention.
 *
 * If first-load cost is systematic, then a flat "spread within 2×" rule fails on
 * every run for a reason that is not a harness fault — and worse, it would
 * report the single most deliverable-relevant number in this whole document as
 * noise. **The user's run is a first load.** The ~21 s init everyone quotes is
 * the warm figure.
 *
 * So: `pass` requires every load to reach ready, and the spread limit applies to
 * loads 2..N, which are genuinely comparable to each other. The first load's
 * absolute time and its ratio to the rest are returned as `firstLoad` and
 * `firstLoadRatio` — reported prominently, never folded into a spread.
 *
 * @param loads `[{ outcome: "ready" | ..., secs: number }]`, in order.
 */
export function evaluateColdLoads(loads, expected = 5) {
  const ready = loads.filter((l) => l.outcome === "ready");
  const problems = [];

  if (loads.length !== expected) problems.push(`${loads.length} loads attempted, expected ${expected}`);
  if (ready.length !== loads.length)
    problems.push(
      `${loads.length - ready.length} of ${loads.length} did not reach ready: ` +
        loads.filter((l) => l.outcome !== "ready").map((l) => `#${l.attempt ?? "?"} ${l.outcome}`).join(", ")
    );

  const firstLoad = loads.length && loads[0].outcome === "ready" && num(Number(loads[0].secs)) ? Number(loads[0].secs) : null;

  // Repeats only: the first load is a different measurement, not an outlier.
  const repeats = ready.slice(loads.length && loads[0].outcome === "ready" ? 1 : 0).map((l) => Number(l.secs)).filter(num);
  const fastest = repeats.length ? Math.min(...repeats) : null;
  const slowest = repeats.length ? Math.max(...repeats) : null;
  const ratio = fastest ? slowest / fastest : null;
  if (ratio !== null && ratio > LIMITS.coldLoadSpreadRatio)
    problems.push(`repeat loads spread ${ratio.toFixed(1)}x (${fastest}s to ${slowest}s), limit ${LIMITS.coldLoadSpreadRatio}x`);

  const medianRepeat = repeats.length ? [...repeats].sort((a, b) => a - b)[Math.floor(repeats.length / 2)] : null;
  const firstLoadRatio = firstLoad !== null && medianRepeat ? firstLoad / medianRepeat : null;

  return {
    pass: problems.length === 0,
    problems,
    readyCount: ready.length,
    firstLoad,
    firstLoadRatio,
    medianRepeat,
    fastest,
    slowest,
    ratio,
  };
}

/** Human-readable verdict, for the harness to print at the end of a run. */
export function formatVerdict(result, { rehearsal = false } = {}) {
  const lines = [];
  lines.push(`--- protocol verdict (QUIET-HOST-PROTOCOL.md §4.1) ---`);
  // Only conditions that did NOT fire may print as ok. `checked` deliberately
  // contains every evaluated condition including the violated ones, so that the
  // completeness of the evaluation can be asserted — but printing those as `ok`
  // put an "ok" line above the matching "VOID" line for the same condition, and
  // a reader skimming five ok lines would have stopped there.
  const firedIds = new Set(result.fired.map((f) => f.id));
  for (const c of result.checked) {
    if (firedIds.has(c.id)) continue;
    lines.push(`  ok       ${c.id}. ${c.title}: ${c.detail}`);
  }
  for (const u of result.undecidable) lines.push(`  UNKNOWN  ${u.id}. ${u.title}: ${u.why}`);
  for (const f of result.fired) lines.push(`  VOID     ${f.id}. ${f.title}: ${f.detail}`);
  lines.push("");
  if (rehearsal) {
    lines.push(`  REHEARSAL: every number in this run is void by construction. This was a test of`);
    lines.push(`  the harness, not a measurement. Do not quote anything from it.`);
  } else if (result.void) {
    lines.push(
      `  RUN IS VOID: ${result.fired.length} condition(s) fired, ${result.undecidable.length} undecidable. ` +
        `No frame-time number from this run may be quoted.`
    );
  } else {
    lines.push(`  RUN COUNTS: all five conditions checked and none fired.`);
  }
  return lines.join("\n");
}
