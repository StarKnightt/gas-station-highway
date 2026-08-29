/**
 * General defence against seed-correlated variation. Read-only, CPU-only.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-rngsets.mjs
 *
 * The failure this catches: a generator seeds a *set* of things from adjacent
 * integers and then branches on an early draw. If the PRNG's early draws are a
 * function of the seed, every member of the set makes the same decision and the
 * set comes out uniform. It looks exactly like a logic bug or a missing feature,
 * which is why it cost a critic round on the pines before anyone suspected the
 * shared RNG.
 *
 * Two tests per seed set, per draw index:
 *
 *   1. UNANIMITY. For a decision `rng() < p`, if all N members agree when the
 *      chance of that is < ALPHA, the draw is not deciding anything. This is the
 *      test that maps directly onto the observed symptom.
 *   2. COVERAGE + MONOTONICITY. How much of 0..1 the draw actually spans across
 *      the set, and its Spearman rank correlation against the seed. A draw that
 *      spans 8% of its range is not providing variation even if no single
 *      decision is unanimous.
 *
 * Register real seed sets below. A synthetic known-bad case is included last so
 * a run that reports everything clean is self-evidently not vacuous.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const noise = await import(pathToFileURL(path.join(ROOT, "src/gen/noise.ts")).href);
const pumpParts = await import(pathToFileURL(path.join(ROOT, "src/gen/pumpParts.ts")).href);
const { makeRng, seededRng } = noise;

/**
 * Significance level. Every flag below is a p-value against this, not a bare
 * magnitude threshold, because the sets here are small: a Spearman of 1.000
 * across three pumps happens one run in six by chance, and sweeping eleven
 * decision thresholds over four draws and six sets is ~264 tests, which throws
 * a couple of 2%-level coincidences every run. A probe that cries wolf gets
 * ignored, and an ignored probe is worth nothing.
 */
const ALPHA = 0.01;
/** Draws to examine. Anything past this is not an "early" decision. */
const DRAWS = 4;

const THRESHOLDS = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9];
/** Bonferroni across the threshold sweep within a single draw. */
const ALPHA_UNANIMITY = ALPHA / THRESHOLDS.length;

const rank = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
  return r;
};

function rankCorr(xs, ys) {
  const a = rank(xs);
  const b = rank(ys);
  const n = a.length;
  const m = (n - 1) / 2;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - m) * (b[i] - m);
    saa += (a[i] - m) ** 2;
    sbb += (b[i] - m) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1e-30);
}

/** Two-sided p-value for a rank correlation: exact for small n, normal beyond. */
function rankCorrP(rho, n) {
  if (n < 4) return 1; // no arrangement of 3 items is ever significant
  if (n <= 8) {
    // Exact permutation null: enumerate all orderings of 0..n-1.
    const base = Array.from({ length: n }, (_, i) => i);
    let total = 0;
    let atLeast = 0;
    const perm = (arr, k) => {
      if (k === arr.length) {
        total++;
        if (Math.abs(rankCorr(base, arr)) >= Math.abs(rho) - 1e-12) atLeast++;
        return;
      }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        perm(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    };
    perm(base.slice(), 0);
    return atLeast / total;
  }
  const z = Math.abs(rho) * Math.sqrt(n - 1);
  // Two-sided normal tail via erfc.
  const t = 1 / (1 + 0.5 * (z / Math.SQRT2));
  const erfc =
    t *
    Math.exp(
      -((z / Math.SQRT2) ** 2) -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return Math.min(1, erfc);
}

/**
 * P(range of n uniform draws <= r). Low coverage is the substantive signal - a
 * draw spanning 13% of its range is not providing the variation the author
 * asked for - but it still needs a p-value, because three uniform draws span
 * only half their range on average.
 */
const coverageP = (r, n) => Math.max(0, Math.min(1, n * r ** (n - 1) - (n - 1) * r ** n));

const findings = [];

function checkSet({ name, seeds, factory, note }) {
  const n = seeds.length;
  console.log(`\n  ${name}`);
  console.log(`    ${n} seeds: ${seeds.slice(0, 8).join(", ")}${n > 8 ? ", ..." : ""}`);
  if (note) console.log(`    ${note}`);
  if (n < 2) {
    console.log("    single seed - not a set, nothing to correlate");
    return;
  }

  const draws = [];
  for (const s of seeds) {
    const r = factory(s);
    const row = [];
    for (let k = 0; k < DRAWS; k++) row.push(r());
    draws.push(row);
  }

  console.log("    draw   coverage (p)      spearman (p)     unanimous decisions");
  for (let k = 0; k < DRAWS; k++) {
    const ys = draws.map((row) => row[k]);
    const coverage = Math.max(...ys) - Math.min(...ys);
    const covP = coverageP(coverage, n);
    const rho = rankCorr(seeds, ys);
    const rhoP = rankCorrP(rho, n);

    const unanimous = [];
    for (const p of THRESHOLDS) {
      const below = ys.filter((v) => v < p).length;
      if (below !== 0 && below !== n) continue;
      const chance = p ** n + (1 - p) ** n;
      if (chance < ALPHA_UNANIMITY) unanimous.push({ p, chance, dir: below === n ? "all <" : "all >=" });
    }

    const bad = [];
    if (unanimous.length) bad.push("unanimous early decision");
    if (covP < ALPHA) bad.push("coverage too low to be chance");
    if (rhoP < ALPHA) bad.push("rank-correlated with seed");

    console.log(
      `    ${String(k + 1).padStart(4)}   ${(coverage * 100).toFixed(1).padStart(5)}% (${covP
        .toFixed(4)
        .padStart(6)})   ${rho.toFixed(3).padStart(6)} (${rhoP.toFixed(4).padStart(6)})   ` +
        (unanimous.length
          ? unanimous.map((u) => `${u.dir} ${u.p} (p=${u.chance.toExponential(1)})`).join(", ")
          : "none") +
        (bad.length ? `   <-- ${bad.join("; ")}` : "")
    );

    if (bad.length) findings.push({ set: name, draw: k + 1, coverage, covP, rho, rhoP, reasons: bad, unanimous });
  }
}

console.log("=".repeat(78));
console.log("Seed-set decorrelation audit");
console.log(`ALPHA=${ALPHA}  DRAWS=${DRAWS}  unanimity alpha=${ALPHA_UNANIMITY.toFixed(5)} (Bonferroni /${THRESHOLDS.length})`);
console.log("Every flag is a p-value against ALPHA. Small sets are weak on their own;");
console.log("a flagged draw should be confirmed against the mechanism (tools/probe-rng.mjs).");
console.log("=".repeat(78));

/* ---------------- real call sites ---------------- */

// PumpSystem.ts:512-513 - three dispensers, seeded i+1.
checkSet({
  name: "pumps: pumpVariation(i+1)  [PumpSystem.ts:513]",
  seeds: [1, 2, 3],
  factory: seededRng,
  note: "draws: 1=hoseLen, 2=hoseSeed, 3=nozzleRake",
});

// The hose seeds those pumps then hand to hangingHose, both sides of each.
{
  const hoseSeeds = [];
  for (let i = 0; i < 3; i++) {
    const v = pumpParts.pumpVariation(i + 1);
    hoseSeeds.push(v.hoseSeed + 7, v.hoseSeed + 19);
  }
  checkSet({
    name: "pump hoses: hangingHose(seed)  [pumpParts.ts:561, PumpSystem.ts:721]",
    seeds: hoseSeeds,
    factory: seededRng,
    note: "draws: 1=kink phase 1, 2=kink phase 2, 3=kink amplitude",
  });
}

// PumpSystem.ts:616 - bollards. Not makeRng: the seed is used directly as a
// phase, so it is checked here as a phase set rather than a draw set.
{
  const phases = [];
  for (let bi = 0; bi < 6; bi++) phases.push(((3 + bi) * 1.7) % (Math.PI * 2));
  const cov = (Math.max(...phases) - Math.min(...phases)) / (Math.PI * 2);
  console.log("\n  bollards: buildBollard(h, 3+bi)  [PumpSystem.ts:616]");
  console.log("    does not use makeRng - seed becomes an oval phase directly");
  console.log(
    `    6 phases span ${(cov * 100).toFixed(1)}% of 0..2pi  ->  ${cov < 0.5 ? "CLUSTERED" : "well spread"}`
  );
  console.log("    (note, out of scope: the two dent lobes use fixed angles, so every");
  console.log("     bollard is dented in the same two places regardless of seed)");
}

// VegetationSystem.ts:244 - pines. The case that started this.
checkSet({
  name: "pines: buildPine(3100 + i*977)  [VegetationSystem.ts:244]",
  seeds: Array.from({ length: 10 }, (_, i) => 3100 + i * 977),
  factory: seededRng,
  note: "draw 1 chose the species; under makeRng all ten chose the same one",
});

// vegGround.ts:181/190/210 - clump sets.
checkSet({
  name: "veg ground clumps: seed + i*37  [vegGround.ts:181]",
  seeds: Array.from({ length: 12 }, (_, i) => 5000 + i * 37),
  factory: seededRng,
});
checkSet({
  name: "veg scatter: seed + i*13  [vegGround.ts:210]",
  seeds: Array.from({ length: 12 }, (_, i) => 900 + i * 13),
  factory: seededRng,
});

/* ---------------- deliberate known-bad control ---------------- */
checkSet({
  name: "CONTROL (must fail): bare makeRng on 10 consecutive seeds",
  seeds: Array.from({ length: 10 }, (_, i) => i + 1),
  factory: makeRng,
  note: "the pine bug as it was; if this reports clean, the test itself is broken",
});

/* ---------------- verdict ---------------- */
console.log("\n" + "=".repeat(78));
const control = findings.filter((f) => f.set.startsWith("CONTROL"));
const real = findings.filter((f) => !f.set.startsWith("CONTROL"));

if (!control.length) {
  console.error("BROKEN: the known-bad control passed. The test is not measuring anything.");
  process.exitCode = 1;
} else {
  console.log(`Control behaved as expected (${control.length} finding(s) on the known-bad set).`);
}

if (real.length) {
  console.error(`\nFAIL: ${real.length} finding(s) on real call sites:\n`);
  for (const f of real) {
    console.error(
      `  ${f.set}\n    draw ${f.draw}: ${f.reasons.join("; ")}\n` +
        `      coverage ${(f.coverage * 100).toFixed(1)}% (p=${f.covP.toFixed(4)}), ` +
        `spearman ${f.rho.toFixed(3)} (p=${f.rhoP.toFixed(4)})`
    );
    for (const u of f.unanimous) {
      console.error(`      every member decided "${u.dir} ${u.p}" - chance ${u.chance.toExponential(1)}`);
    }
  }
  console.error(
    "\nA set seeded from adjacent integers is branching on a draw that is a\n" +
      "function of the seed. Use seededRng from gen/noise.ts instead of makeRng,\n" +
      "or draw later. tools/probe-rng.mjs shows the mechanism."
  );
  process.exitCode = 1;
} else {
  console.log("OK: no real seed set is making a correlated early decision.");
}
