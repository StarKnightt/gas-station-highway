#!/usr/bin/env node
/**
 * CPU-only measurement of pine crown structure. No GPU.
 *
 * The critic identified the trees as Norfolk Island pine / monkey puzzle on two
 * specific grounds: "regular horizontal whorls at even vertical intervals" and
 * "radially symmetric". Both are measurable from the foliage card positions
 * without rendering anything:
 *
 *  - Vertical periodicity: autocorrelate the card count per height bin. A crown
 *    built from evenly-spaced planar whorls has a strong autocorrelation peak at
 *    the whorl pitch. A crown whose limbs are scattered in height does not.
 *  - Radial symmetry: card count per azimuth sector. A radially symmetric crown
 *    distributes evenly; a real one is lopsided toward the light and has holes.
 *
 *   node tools/vegpine.mjs
 */
import { rmSync } from "node:fs";
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { pineCards } = await import("../.shot-build/cpu/vegprofile.mjs");

const TREES = [
  { seed: 4101, h: 13.0 },
  { seed: 4207, h: 9.8 },
  { seed: 4311, h: 15.2 },
  { seed: 4423, h: 11.4 },
  { seed: 4531, h: 8.6 },
];

const stats = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return { mean: m, sd, cv: m > 0 ? sd / m : 0 };
};

let worstPeriodicity = 0;
let leastAsymmetry = Infinity;

for (const t of TREES) {
  const { cards, height, crownRadius, woodTriangles } = pineCards(t.seed, t.h);

  /* ---- vertical periodicity ---- */
  // 10 cm bins over the crown. Whorl pitch in this generator is 3-6% of the
  // height, i.e. 30-90 cm, so 10 cm resolves it comfortably.
  const bin = 0.1;
  const nb = Math.ceil(height / bin);
  const hist = new Float64Array(nb);
  for (const c of cards) hist[Math.min(nb - 1, Math.max(0, Math.floor(c.y / bin)))]++;
  // Detrend against a 1 m moving average before autocorrelating. Without this
  // the metric reports 0.4-0.76 at the shortest lag it tests for *any* crown,
  // because a dense crown's card-per-10-cm histogram is simply smooth on that
  // scale — adjacent bins are correlated whether or not there are whorls. What
  // we want is periodicity in the residual: ring, gap, ring, gap.
  const TREND = 10; // bins, = 1 m
  const dev = new Array(nb).fill(0);
  for (let i = 0; i < nb; i++) {
    let s = 0;
    let n = 0;
    for (let j = i - TREND; j <= i + TREND; j++) {
      if (j < 0 || j >= nb) continue;
      s += hist[j];
      n++;
    }
    dev[i] = hist[i] - s / n;
  }
  const norm = dev.reduce((a, b) => a + b * b, 0);
  let peak = 0;
  let peakLag = 0;
  // Lags of 2-15 bins = 20 cm to 1.5 m, which covers every plausible whorl
  // pitch. Lag 1 is just bin noise.
  for (let lag = 2; lag <= Math.min(15, nb - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < nb; i++) s += dev[i] * dev[i + lag];
    const r = norm > 0 ? s / norm : 0;
    if (r > peak) {
      peak = r;
      peakLag = lag;
    }
  }

  /* ---- radial symmetry ---- */
  const SEC = 12;
  const sect = new Array(SEC).fill(0);
  for (const c of cards) {
    const a = Math.atan2(c.z, c.x);
    sect[Math.min(SEC - 1, Math.floor(((a + Math.PI) / (Math.PI * 2)) * SEC))]++;
  }
  const ss = stats(sect);

  /* ---- crown extent, for the "tapering spike" question ---- */
  const top = Math.max(...cards.map((c) => c.y));
  const bareTip = height - top;

  console.log(
    `seed ${t.seed}  h ${height.toFixed(1)} m  ${cards.length} cards  crownR ${crownRadius.toFixed(2)} m  wood ${woodTriangles} tris`
  );
  console.log(
    `   vertical autocorrelation peak ${peak.toFixed(3)} at lag ${(peakLag * bin).toFixed(1)} m` +
      (peak > 0.25 ? "   !! periodic: whorls will read as rings" : "")
  );
  console.log(
    `   azimuth spread CV ${ss.cv.toFixed(3)} over ${SEC} sectors` +
      (ss.cv < 0.22 ? "   !! radially symmetric" : "") +
      `   bare tip above the top card ${bareTip.toFixed(2)} m`
  );
  worstPeriodicity = Math.max(worstPeriodicity, peak);
  leastAsymmetry = Math.min(leastAsymmetry, ss.cv);
}

console.log(`\nworst vertical periodicity across the set: ${worstPeriodicity.toFixed(3)} (want < 0.25)`);
console.log(`least azimuth asymmetry across the set:    ${leastAsymmetry.toFixed(3)} (want > 0.22)`);

rmSync(".shot-build/cpu", { recursive: true, force: true });
