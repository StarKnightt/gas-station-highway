#!/usr/bin/env node
/**
 * CPU-only measurement of the continuous inter-plant mat. No GPU.
 *
 * Three questions, none of which a render answers well and all of which a
 * render can hide:
 *
 *  1. **Is the cover field actually varying, or is it a constant?** The failure
 *     mode for a ground-cover layer is a uniform carpet, and a uniform carpet
 *     at the right average tone looks plausible in a still. So the histogram
 *     is printed, not the mean. A field whose p05..p95 span is narrow is a
 *     carpet whatever its average says.
 *  2. **Does it agree with the soil?** The whole argument for consuming
 *     `groundSoil` rather than inventing a mask is that the mat has to be
 *     absent from the wheel ruts and dense in the damp hollows. That is a
 *     correlation and it is checkable: cover is binned against disturbance and
 *     against wetness, and if the trend is flat the service is being consumed
 *     in name only.
 *  3. **What does it cost?** Triangles and instances, before anyone spends a
 *     capture on it.
 *
 *   node tools/vegmat.mjs
 */
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const M = await import("../.shot-build/cpu/vegmat.mjs");
const { makeMatField, buildMatSheet, scatterSprigs, thatchSprigGeometry, makeSoilField, DRIVEWAYS, PAD, ROAD } = M;

const soilField = makeSoilField();
const soil = {
  disturbance: soilField.disturbance,
  wetness: soilField.wetness,
  drainage: soilField.drainage,
  material: soilField.material,
};

// The same exclusion the system applies. Duplicated rather than imported
// because the system's version closes over the building footprint, which needs
// a scene; the paved part is what dominates the yield and it is static.
const blocked = (x, z) => {
  if (Math.abs(z) <= ROAD.halfPaved - 0.13) return true;
  if (x >= PAD.minX - 0.02 && x <= PAD.maxX + 0.02 && z >= PAD.minZ - 0.02 && z <= PAD.maxZ + 0.02) return true;
  if (z > ROAD.halfPaved && z < PAD.minZ) {
    for (const d of DRIVEWAYS) if (x > d.minX - 0.1 && x < d.maxX + 0.1) return true;
  }
  return false;
};

const field = makeMatField({ soil, blocked, seed: 8821 });

/* ---- 1. the histogram ---- */
const CX = 0;
const CZ = 24;
const R = 62;
const samples = [];
for (let j = -R; j <= R; j += 0.5) {
  for (let i = -R; i <= R; i += 0.5) {
    if (Math.hypot(i, j) > R) continue;
    const x = CX + i;
    const z = CZ + j;
    if (blocked(x, z)) continue;
    samples.push(field.cover(x, z));
  }
}
samples.sort((a, b) => a - b);
const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log(`\ncover over ${samples.length} unblocked points inside r=${R} m of (${CX}, ${CZ})`);
console.log(
  `  mean ${mean.toFixed(3)}   p05 ${q(0.05).toFixed(3)}  p25 ${q(0.25).toFixed(3)}  ` +
    `p50 ${q(0.5).toFixed(3)}  p75 ${q(0.75).toFixed(3)}  p95 ${q(0.95).toFixed(3)}`
);
console.log(`  p05..p95 span ${(q(0.95) - q(0.05)).toFixed(3)}   bare (<0.05) ${(samples.filter((v) => v < 0.05).length / samples.length * 100).toFixed(1)}%   dense (>0.6) ${(samples.filter((v) => v > 0.6).length / samples.length * 100).toFixed(1)}%`);
const BINS = 10;
const hist = new Array(BINS).fill(0);
for (const v of samples) hist[Math.min(BINS - 1, Math.floor(v * BINS))]++;
console.log("  histogram (0.0 -> 1.0):");
const peak = Math.max(...hist);
hist.forEach((h, i) => {
  const bar = "#".repeat(Math.round((h / peak) * 46));
  console.log(`    ${(i / BINS).toFixed(1)}-${((i + 1) / BINS).toFixed(1)}  ${String(h).padStart(6)}  ${bar}`);
});

/* ---- 2. does it agree with the soil ---- */
function trend(name, get, lo, hi, bins) {
  const sum = new Array(bins).fill(0);
  const n = new Array(bins).fill(0);
  for (let j = -R; j <= R; j += 0.7) {
    for (let i = -R; i <= R; i += 0.7) {
      if (Math.hypot(i, j) > R) continue;
      const x = CX + i;
      const z = CZ + j;
      if (blocked(x, z)) continue;
      const v = get(x, z);
      const b = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins)));
      sum[b] += field.cover(x, z);
      n[b]++;
    }
  }
  console.log(`\n  cover vs ${name}:`);
  for (let b = 0; b < bins; b++) {
    if (!n[b]) continue;
    const m = sum[b] / n[b];
    console.log(
      `    ${(lo + ((hi - lo) * b) / bins).toFixed(2)}..${(lo + ((hi - lo) * (b + 1)) / bins).toFixed(2)}  ` +
        `n=${String(n[b]).padStart(6)}  cover ${m.toFixed(3)}  ${"#".repeat(Math.round(m * 44))}`
    );
  }
}
console.log("\nagreement with groundSoil — a flat trend means the service is consumed in name only");
trend("disturbance", soil.disturbance, 0, 1, 8);
trend("wetness", soil.wetness, 0, 1, 8);
trend("drainage (m)", soil.drainage, -0.6, 0.6, 8);

/* ---- 3. the bill ---- */
const ground = () => 0;
const sheet = buildMatSheet({ soil, blocked, ground, centre: [CX, CZ], radius: R, pitch: 0.85, seed: 8821 });
const sprigs = scatterSprigs({ soil, blocked, ground, centre: [CX, CZ], radius: 42, budget: 7000, seed: 8821 });
const sprigGeo = thatchSprigGeometry();
const sprigTris = sprigGeo.index.count / 3;
console.log(`\nbill`);
console.log(`  sheet : ${sheet.kept}/${sheet.cells} cells kept (${((sheet.kept / sheet.cells) * 100).toFixed(1)}%), ${sheet.triangles} triangles, 1 draw call`);
console.log(`  sprigs: ${sprigs.length} instances x ${sprigTris} tri = ${sprigs.length * sprigTris} triangles, 1 draw call`);
console.log(`  total : ${sheet.triangles + sprigs.length * sprigTris} triangles, 2 draw calls\n`);
