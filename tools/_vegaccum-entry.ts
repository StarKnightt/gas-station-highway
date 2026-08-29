/**
 * CPU-only: probe Terrain's `groundAccum` at MY geometry before composing.
 *
 * Terrain published p50/p95 for five fields measured on a 1 m grid over the
 * lot, n=11,468, and flagged `shelter` and `swept` as bimodal — near 0 or near
 * 1 rather than a ramp. Those percentiles describe Terrain's sampling domain.
 * My plant sites are not a sample of that domain: they are the places the
 * planting rules chose, which are sheltered and off the pavement by
 * construction. A consumer that reaches for the published p50 as "typical here"
 * is reading a statistic of somebody else's domain.
 *
 * So: sample the five fields at the real plant sites and at a matched uniform
 * grid, and print both against the published contract. Compose against the
 * numbers that hold where the debris will actually be drawn.
 */
import { makeSoilField } from "../src/gen/groundSoil";
import { makeAccumField } from "../src/gen/groundAccum";
import { collectSites } from "./_vegscale-entry";

type Field = "shelter" | "fines" | "litter" | "grime" | "swept";
const FIELDS: Field[] = ["shelter", "fines", "litter", "grime", "swept"];

function stats(v: number[]): { p50: number; p95: number; min: number; max: number; nearZero: number; nearOne: number } {
  const s = [...v].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))];
  const span = Math.max(1e-9, s[s.length - 1] - s[0]);
  return {
    p50: q(0.5),
    p95: q(0.95),
    min: s[0],
    max: s[s.length - 1],
    // Bimodality, measured rather than taken on trust: what fraction sits in
    // the outer tenth at each end of the field's own observed span.
    nearZero: v.filter((x) => x < s[0] + 0.1 * span).length / v.length,
    nearOne: v.filter((x) => x > s[s.length - 1] - 0.1 * span).length / v.length,
  };
}

export async function run(): Promise<void> {
  const soil = makeSoilField();
  const accum = makeAccumField(soil);
  const { sites } = await collectSites();

  const atSites: Record<string, number[]> = {};
  const atGrid: Record<string, number[]> = {};
  for (const f of FIELDS) {
    atSites[f] = [];
    atGrid[f] = [];
  }

  for (const s of sites) {
    for (const f of FIELDS) atSites[f].push((accum as never as Record<Field, (x: number, z: number) => number>)[f](s.x, s.z));
  }
  // A matched grid over the same bounding box the sites occupy, so the
  // comparison is site-selection against uniform coverage of the same ground
  // rather than against Terrain's whole lot.
  const xs = sites.map((s) => s.x);
  const zs = sites.map((s) => s.z);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      for (const f of FIELDS) atGrid[f].push((accum as never as Record<Field, (x: number, z: number) => number>)[f](x, z));
    }
  }

  console.log(`groundAccum at Vegetation's geometry: ${sites.length} plant sites`);
  console.log(`  matched grid: 1 m over x[${x0.toFixed(0)}, ${x1.toFixed(0)}] z[${z0.toFixed(0)}, ${z1.toFixed(0)}], n=${atGrid.shelter.length}\n`);
  console.log("  field     shape       published        at my sites          matched grid      near0/near1 at sites");
  for (const f of FIELDS) {
    const pub = accum.range[f];
    const a = stats(atSites[f]);
    const g = stats(atGrid[f]);
    console.log(
      "  " +
        f.padEnd(10) +
        pub.shape.padEnd(11) +
        `p50 ${pub.p50.toFixed(3)}`.padEnd(13) +
        `p50 ${a.p50.toFixed(3)} p95 ${a.p95.toFixed(3)}`.padEnd(22) +
        `p50 ${g.p50.toFixed(3)} p95 ${g.p95.toFixed(3)}`.padEnd(22) +
        `${(100 * a.nearZero).toFixed(0)}% / ${(100 * a.nearOne).toFixed(0)}%`
    );
  }

  console.log("\n  ratio of my p50 to the published p50, which is the number that bites:");
  for (const f of FIELDS) {
    const pub = accum.range[f];
    const a = stats(atSites[f]);
    const r = pub.p50 > 1e-6 ? (a.p50 / pub.p50).toFixed(2) + "x" : a.p50 > 1e-6 ? "published p50 is 0, mine is not" : "both 0";
    console.log(`    ${f.padEnd(10)} ${r}`);
  }

  /*
   * The gain the shipped skirt ACTUALLY ran at, read back out of the built
   * scene — not recomputed here.
   *
   * The previous version of this block evaluated the gain expression itself,
   * with a comment saying it was "kept in step with
   * VegetationSystem.debrisContext by being the same three lines". That is a
   * metric with no control: it agreed with the source by construction and
   * would have printed a healthy distribution no matter what the system did,
   * including the thing the system was in fact doing — taking the
   * no-such-service branch, running the whole skirt at gain 1, and reporting
   * `debrisAccum: null`. The harness never provided `groundAccum`, so the
   * composition this tool exists to check had never once executed in it.
   *
   * So the assertion below is on the echo, and the echo being ABSENT is now a
   * failure rather than a blank line. A control must prove it was applied.
   */
  const report = (globalThis as unknown as { __VEGETATION?: Record<string, unknown> }).__VEGETATION ?? {};
  const echoed = report.debrisAccum as
    | { samples: number; min: number; p50: number; max: number; bound: [number, number] }
    | null
    | undefined;
  const scatter = report.debrisScatter as
    | Record<string, number | string | boolean>
    | null
    | undefined;

  console.log("\n  debris skirt gain, echoed out of the built scene (NOT recomputed here):");
  if (!echoed) {
    console.error(
      `    __VEGETATION.debrisAccum is ${echoed === null ? "null" : "absent"} — the system did not consume ` +
        "groundAccum. Every 'composed against the field' claim below is false."
    );
    process.exitCode = 1;
  } else {
    const [lo, hi] = echoed.bound;
    console.log(
      `    samples ${echoed.samples}  min ${echoed.min.toFixed(3)}  p50 ${echoed.p50.toFixed(3)}  ` +
        `max ${echoed.max.toFixed(3)}   declared bound [${lo}, ${hi}]`
    );
    if (echoed.min < lo - 1e-9 || echoed.max > hi + 1e-9) {
      console.error("    BOUND VIOLATED — the declared bound is wrong, which is worse than no bound");
      process.exitCode = 1;
    }
    // A gain that is constant is a gain that is doing nothing, and would read in
    // a report as "composed" while being indistinguishable from the fallback.
    const spread = echoed.max - echoed.min;
    console.log(
      `    spread ${spread.toFixed(3)}` +
        (spread < 0.05
          ? "  <-- effectively constant: the composition is not doing anything"
          : "  (varies across the site)")
    );
    if (spread < 0.05) process.exitCode = 1;
    // Independent arm: the same gain evaluated here from the same field. This
    // is deliberately kept as a CROSS-CHECK of the echo rather than as the
    // measurement — if it disagrees with the echo, one of the two is reading a
    // different field than it thinks, which is the failure the echo exists for.
    const smooth = (t: number) => {
      const u = Math.max(0, Math.min(1, t));
      return u * u * (3 - 2 * u);
    };
    const mine = stats(
      sites.map(
        (s) => (0.78 + 0.52 * smooth(accum.shelter(s.x, s.z))) * (1 - 0.7 * smooth(accum.swept(s.x, s.z)))
      )
    );
    const agree = Math.abs(mine.p50 - echoed.p50) < 0.02 && Math.abs(mine.max - echoed.max) < 0.02;
    console.log(
      `    independent recompute: p50 ${mine.p50.toFixed(3)} max ${mine.max.toFixed(3)}  ` +
        (agree ? "agrees with the echo" : "<-- DISAGREES with the echo")
    );
    if (!agree) process.exitCode = 1;
  }

  console.log("\n  scattered litter, echoed out of the built scene:");
  if (!scatter) {
    console.error("    __VEGETATION.debrisScatter absent — no scattered litter was built");
    process.exitCode = 1;
  } else {
    for (const [k, v] of Object.entries(scatter)) console.log(`    ${k.padEnd(22)} ${v}`);

    const num = (k: string) => Number(scatter[k]);
    const fail = (m: string) => {
      console.error(`    FAIL: ${m}`);
      process.exitCode = 1;
    };

    if (scatter.built !== true) fail("the scatter did not build");

    /*
     * The unit check, and the reason it is here rather than in a comment.
     *
     * `expected` is `sum(density * cellArea * profile * gain)` — the count the
     * physical model asks for. `placed` is what the conversion produced. They
     * agree only if the density was treated as a density. Swap the conversion
     * for the obvious `if (hash < density * profile * gain)` and `placed` jumps
     * by roughly `1 / cellArea` — 28x at a 0.19 m cell — while the frame merely
     * looks busier and every other number in this report stays plausible.
     */
    const ratio = num("placedOverExpected");
    if (!(ratio > 0.9 && ratio < 1.1)) {
      fail(
        `placed/expected = ${ratio}, outside [0.9, 1.1]. The density is items per SQUARE METRE ` +
          `and must be multiplied by cell area (${num("cellMetres") ** 2} m2) to give a count.`
      );
    }

    /*
     * And the check that keeps the previous one honest. `placed/expected ~ 1`
     * is also true of a plain Bernoulli whenever no cell ever wants more than
     * one item — the two forms are identical there, so the ratio would pass
     * while proving nothing. It only proves something if cells over 1 exist.
     */
    const over = num("cellsOverOne");
    const shortfall = num("bernoulliShortfall");
    if (over === 0) {
      console.log(
        "    note: no cell exceeds one item, so floor+frac and Bernoulli agree here " +
          "and the ratio above does not discriminate between them."
      );
    } else {
      console.log(
        `    ${over} of ${num("cells")} cells want more than one item (max ${num("maxPerCell")}). ` +
          `A plain Bernoulli would have placed ${num("bernoulliWouldPlace")} of ${num("expected")} ` +
          `— ${(shortfall * 100).toFixed(1)}% short, and silently.`
      );
    }

    if (scatter.overBudget === true) fail(`placed ${num("placed")} exceeds budget ${num("budget")}`);

    // A profile or a gain that is flat where the scatter samples it is a term
    // that is not doing anything, which reads in a report as "composed".
    const g = String(scatter.gain).split(",").map(Number);
    const p = String(scatter.profile).split(",").map(Number);
    if (g[2] - g[0] < 0.05) fail(`site gain spans only ${(g[2] - g[0]).toFixed(3)} at the scatter's cells — flat`);
    if (p[1] < 0.2) fail(`crown profile peaks at only ${p[1]} — the profile is not reaching the scatter`);
  }

  console.log("\n  safeAsMultiplier, per the contract:");
  for (const f of FIELDS) {
    const pub = accum.range[f];
    console.log(
      `    ${f.padEnd(10)} ${pub.safeAsMultiplier ? "yes" : "NO  <-- recentre first"}  units: ${pub.units}` +
        (pub.note ? `\n               note: ${pub.note}` : "")
    );
  }
}

run();
