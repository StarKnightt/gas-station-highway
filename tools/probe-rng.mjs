/**
 * Read-only probe (no source files modified). CPU-only, no GPU.
 *
 * Characterises seed-to-first-draw correlation in the project's PRNGs, and
 * measures the real call sites that seed a *set* from adjacent integers.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-rng.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const noise = await import(pathToFileURL(path.join(ROOT, "src/gen/noise.ts")).href);
const pumpParts = await import(pathToFileURL(path.join(ROOT, "src/gen/pumpParts.ts")).href);

// Verbatim copy of src/audio/dsp.ts makeRng (mulberry32). Copied rather than
// imported because dsp.ts uses a constructor parameter property, which Node's
// strip-only TypeScript mode rejects. Kept identical so the control is valid.
const dsp = {
  makeRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
};

const { makeRng, seededRng } = noise;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy || 1e-30);
}

/** Spearman rank correlation: catches monotone-but-nonlinear coupling. */
function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

/** Draw k (1-based) from `factory(seed)` for each seed. */
const drawK = (factory, seeds, k) =>
  seeds.map((s) => {
    const r = factory(s);
    let v = 0;
    for (let i = 0; i < k; i++) v = r();
    return v;
  });

function correlationTable(label, factory, seeds) {
  console.log(`\n  ${label}   (${seeds.length} seeds: ${seeds[0]}..${seeds[seeds.length - 1]})`);
  console.log("    draw   pearson   spearman     min      max     range   mean");
  for (let k = 1; k <= 8; k++) {
    const ys = drawK(factory, seeds, k);
    const p = pearson(seeds, ys);
    const sp = spearman(seeds, ys);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const flag = Math.abs(p) > 0.3 || Math.abs(sp) > 0.3 || max - min < 0.5 ? "  <--" : "";
    console.log(
      `    ${String(k).padStart(4)}  ${p.toFixed(4).padStart(8)}  ${sp.toFixed(4).padStart(8)}   ` +
        `${min.toFixed(4)}  ${max.toFixed(4)}  ${(max - min).toFixed(4)}  ${mean.toFixed(4)}${flag}`
    );
  }
}

const range = (a, b, step = 1) => {
  const out = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
};

/* ------------------------------------------------------------------ */
/* 1. characterise makeRng                                             */
/* ------------------------------------------------------------------ */
console.log("=".repeat(78));
console.log("1. gen/noise.ts makeRng - xorshift32 seeded directly with the caller's integer");
console.log("=".repeat(78));

console.log("\n  The pine case verbatim: first draw for ten consecutive small seeds\n");
for (const s of range(1, 10)) {
  const r = makeRng(s);
  const d = [r(), r(), r(), r()];
  console.log(
    `    seed ${String(s).padStart(3)}  ->  ${d.map((v) => v.toFixed(6)).join("  ")}`
  );
}

correlationTable("consecutive seeds 1..10", makeRng, range(1, 10));
correlationTable("consecutive seeds 1..200", makeRng, range(1, 200));
correlationTable("consecutive seeds 1000..1199", makeRng, range(1000, 1199));
correlationTable("consecutive seeds 4000..4599", makeRng, range(4000, 4599));
correlationTable("spaced by 977 (pump idiom)", makeRng, range(990, 990 + 977 * 9, 977));
correlationTable("spaced by 37 (veg idiom)", makeRng, range(3100, 3100 + 37 * 19, 37));

console.log("\n  How far does a decision threshold get fooled?");
console.log("  Fraction of seeds where draw k < 0.5 (should be ~0.50):\n");
for (const [lbl, seeds] of [
  ["1..10", range(1, 10)],
  ["1..200", range(1, 200)],
  ["4000..4599", range(4000, 4599)],
  ["990 step 977 (x10)", range(990, 990 + 977 * 9, 977)],
]) {
  const row = [];
  for (let k = 1; k <= 8; k++) {
    const ys = drawK(makeRng, seeds, k);
    row.push((ys.filter((v) => v < 0.5).length / ys.length).toFixed(2));
  }
  console.log(`    ${lbl.padEnd(20)} ${row.map((v) => v.padStart(6)).join("")}`);
}

console.log("\n  Why: for a small seed the middle xorshift step is a no-op.");
console.log("  s ^= s >> 17 does nothing while s < 2^17, so draw 1 is very nearly linear.\n");
for (const s of [1, 2, 4, 8, 16, 100, 1000, 10000, 100000, 1000000]) {
  let v = (s >>> 0) || 1;
  v ^= v << 13;
  v >>>= 0;
  const shifted = v >> 17;
  console.log(
    `    seed ${String(s).padStart(8)}  after s^=s<<13: ${String(v).padStart(12)}   s>>17 = ${String(
      shifted
    ).padStart(6)}${shifted === 0 ? "   (no-op)" : ""}`
  );
}

/* ------------------------------------------------------------------ */
/* 2. controls: the two generators that are already fine               */
/* ------------------------------------------------------------------ */
console.log("\n" + "=".repeat(78));
console.log("2. controls");
console.log("=".repeat(78));
correlationTable("gen/noise.ts seededRng 1..200", seededRng, range(1, 200));
correlationTable("audio/dsp.ts makeRng 1..200", dsp.makeRng, range(1, 200));

/* ------------------------------------------------------------------ */
/* 3. the real call site: a row of fuel pumps                          */
/* ------------------------------------------------------------------ */
console.log("\n" + "=".repeat(78));
console.log("3. PumpSystem: buildPump(i+1) / pumpVariation(i+1), i = 0..n");
console.log("=".repeat(78));
console.log("\n  pumpVariation(seed) = makeRng(seed * 977 + 13), then three consecutive draws.\n");
console.log("    pump  seed   hoseLen(m)   hoseSeed   nozzleRake(rad)");
const varies = [];
for (let i = 0; i < 8; i++) {
  const v = pumpParts.pumpVariation(i + 1);
  varies.push(v);
  console.log(
    `    ${String(i + 1).padStart(4)}  ${String(i + 1).padStart(4)}   ` +
      `${v.hoseLen.toFixed(5).padStart(9)}   ${String(v.hoseSeed).padStart(8)}   ${v.nozzleRake.toFixed(5).padStart(9)}`
  );
}
// PumpSystem's LAYOUT has three entries, so the shipped set is pumps 1-3. The
// table above runs to 8 to show the trend; the numbers that matter are these.
console.log("\n  SHIPPED SET - PumpSystem LAYOUT has 3 entries, so seeds are 1, 2, 3:");
{
  const three = varies.slice(0, 3);
  const hl = three.map((v) => v.hoseLen);
  console.log(
    `    hoseLen ${hl.map((v) => v.toFixed(4)).join(", ")}  ->  spread ${(
      (Math.max(...hl) - Math.min(...hl)) *
      1000
    ).toFixed(0)} mm of the authored 260 mm = ${(((Math.max(...hl) - Math.min(...hl)) / 0.26) * 100).toFixed(1)}%`
  );
  console.log(
    `    step between consecutive pumps: ${((hl[1] - hl[0]) * 1000).toFixed(1)} mm, ${(
      (hl[2] - hl[1]) *
      1000
    ).toFixed(1)} mm - a ramp, not a sample`
  );
}

{
  const idx = varies.map((_, i) => i + 1);
  for (const [name, get, lo, hi] of [
    ["hoseLen", (v) => v.hoseLen, 1.44, 1.70],
    ["hoseSeed", (v) => v.hoseSeed, 0, 9999],
    ["nozzleRake", (v) => v.nozzleRake, 0.24, 0.38],
  ]) {
    const ys = varies.map(get);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const used = (max - min) / (hi - lo);
    console.log(
      `\n    ${name.padEnd(11)} pearson vs index ${pearson(idx, ys).toFixed(4).padStart(8)}   ` +
        `spearman ${spearman(idx, ys).toFixed(4).padStart(8)}`
    );
    console.log(
      `    ${"".padEnd(11)} spans ${min.toFixed(4)}..${max.toFixed(4)} of the authored ` +
        `${lo}..${hi} range = ${(used * 100).toFixed(1)}% of the intended variation`
    );
  }
}

console.log("\n  Downstream: hangingHose(seed = hoseSeed + 7 | + 19) draws three times");
console.log("  immediately - two kink phases and a kink amplitude.\n");
console.log("    pump  side   hoseSeed+off   phase1(rad)  phase2(rad)  kink(m)");
const hosePhases = { 1: [], [-1]: [] };
for (let i = 0; i < 8; i++) {
  for (const face of [1, -1]) {
    const s = varies[i].hoseSeed + (face === 1 ? 7 : 19);
    const r = makeRng(s);
    const p1 = r() * Math.PI * 2;
    const p2 = r() * Math.PI * 2;
    const kink = 0.016 + r() * 0.014;
    hosePhases[face].push([p1, p2, kink]);
    console.log(
      `    ${String(i + 1).padStart(4)}  ${String(face).padStart(4)}   ${String(s).padStart(12)}   ` +
        `${p1.toFixed(4).padStart(10)}  ${p2.toFixed(4).padStart(10)}  ${kink.toFixed(5).padStart(8)}`
    );
  }
}
for (const face of [1, -1]) {
  const p1s = hosePhases[face].map((p) => p[0]);
  const kinks = hosePhases[face].map((p) => p[2]);
  console.log(
    `\n    side ${String(face).padStart(2)}  phase1 spans ${Math.min(...p1s).toFixed(3)}..${Math.max(...p1s).toFixed(
      3
    )} of 0..6.283 = ${(((Math.max(...p1s) - Math.min(...p1s)) / (Math.PI * 2)) * 100).toFixed(1)}%` +
      `   kink spans ${(Math.min(...kinks) * 1000).toFixed(2)}..${(Math.max(...kinks) * 1000).toFixed(2)} mm of 16..30 mm`
  );
}

/* ------------------------------------------------------------------ */
/* 4. what a fix would cost: does hashing change every result?         */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 4. scope bound: does the bias reach the texture call sites?         */
/* ------------------------------------------------------------------ */
console.log("\n" + "=".repeat(78));
console.log("4. scope - most makeRng users are texture builders on a single fixed seed");
console.log("=".repeat(78));
console.log("\n  They spend hundreds of draws on a noise lattice, so the biased first draw");
console.log("  should be one cell out of thousands. Measured rather than assumed.\n");
{
  const { fbm, valueNoise, worley } = noise;
  const SIZE = 128;
  const stat = (a) => {
    let s = 0;
    for (const v of a) s += v;
    const mean = s / a.length;
    let vr = 0;
    for (const v of a) vr += (v - mean) ** 2;
    return { mean, sd: Math.sqrt(vr / a.length) };
  };
  const fieldCorr = (a, b) => {
    const sa = stat(a);
    const sb = stat(b);
    let c = 0;
    for (let i = 0; i < a.length; i++) c += (a[i] - sa.mean) * (b[i] - sb.mean);
    return c / (a.length * sa.sd * sb.sd || 1e-30);
  };
  // The car's texture seeds: a 22-wide band.
  const seeds = [3301, 3313, 3319, 3323];
  for (const [label, build] of [
    ["fbm(freq 9, 5 oct)", (s) => fbm(SIZE, 9, makeRng(s), { octaves: 5, gain: 0.52 })],
    ["valueNoise(freq 16)", (s) => valueNoise(SIZE, 16, makeRng(s))],
    ["worley(freq 12)", (s) => worley(SIZE, 12, makeRng(s))],
  ]) {
    const fields = seeds.map(build);
    let worst = 0;
    let at = "";
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        const c = fieldCorr(fields[i], fields[j]);
        if (Math.abs(c) > Math.abs(worst)) {
          worst = c;
          at = `${seeds[i]} vs ${seeds[j]}`;
        }
      }
    }
    const ctrl = fieldCorr(build(11), build(9000001));
    console.log(
      `    ${label.padEnd(21)} worst adjacent-seed field corr ${worst.toFixed(4).padStart(8)} (${at})` +
        `   distant-seed control ${ctrl.toFixed(4).padStart(8)}`
    );
  }
  console.log("\n  Share of the first octave that draw 1 actually sets:");
  for (const freq of [3, 5, 9, 16, 34]) {
    const cells = freq * freq;
    console.log(
      `    freq ${String(freq).padStart(2)}: ${String(cells).padStart(4)} lattice cells -> draw 1 sets ${(
        (1 / cells) *
        100
      )
        .toFixed(2)
        .padStart(5)}%`
    );
  }
  console.log("\n  Caveat: at freq 3 that is 11% of the first octave, so a builder whose");
  console.log("  FIRST rng consumer is a freq-3 field would be marginal. None currently is -");
  console.log("  makeAsphalt spends its first draws on worley aggregate, not on the freq-3");
  console.log("  patch noise.");
}

/* ------------------------------------------------------------------ */
/* 5. what the case-16 fix actually moved                              */
/* ------------------------------------------------------------------ */
console.log("\n" + "=".repeat(78));
console.log("5. what the case-16 fix moved - old makeRng(seed*977+13) vs today");
console.log("=".repeat(78));
console.log("\n  The only geometry the fix was allowed to change. Texture builders still");
console.log("  call makeRng with their original fixed seeds and are byte-identical.\n");
console.log("    pump   hoseLen  was -> now      delta      nozzleRake  was -> now      delta");
for (let i = 0; i < 3; i++) {
  const old = makeRng((i + 1) * 977 + 13);
  const wasLen = 1.44 + old() * 0.26;
  old();
  const wasRake = 0.24 + old() * 0.14;
  const now = pumpParts.pumpVariation(i + 1);
  console.log(
    `    ${String(i + 1).padStart(4)}   ${wasLen.toFixed(4)} -> ${now.hoseLen.toFixed(4)}   ` +
      `${((now.hoseLen - wasLen) * 1000).toFixed(1).padStart(8)} mm    ` +
      `${wasRake.toFixed(4)} -> ${now.nozzleRake.toFixed(4)}   ` +
      `${(((now.nozzleRake - wasRake) * 180) / Math.PI).toFixed(2).padStart(7)} deg`
  );
}
{
  const hl = [0, 1, 2].map((i) => pumpParts.pumpVariation(i + 1).hoseLen);
  const spread = Math.max(...hl) - Math.min(...hl);
  console.log(
    `\n    hoseLen across the three shipped pumps now spans ${(spread * 1000).toFixed(0)} mm ` +
      `= ${((spread / 0.26) * 100).toFixed(1)}% of the authored 260 mm (was 33 mm / 12.7%)`
  );
  const phases = [];
  for (let i = 0; i < 3; i++) {
    for (const off of [7, 19]) {
      const r = seededRng(pumpParts.pumpVariation(i + 1).hoseSeed + off);
      phases.push(r() * Math.PI * 2);
    }
  }
  console.log(
    `    the six hose kink phases now span ${(
      ((Math.max(...phases) - Math.min(...phases)) / (Math.PI * 2)) *
      100
    ).toFixed(1)}% of 0..2pi (was 7.9%)`
  );
  const pairs = [0, 2, 4].map((k) => Math.abs(phases[k] - phases[k + 1]));
  console.log(
    `    the +7 / +19 offset now separates the two faces of one pump by ` +
      `${pairs.map((p) => ((p * 180) / Math.PI).toFixed(0) + " deg").join(", ")} (was 0.25 deg)`
  );
}
