#!/usr/bin/env node
/**
 * CPU-only measurement of scrub placement. No GPU.
 *
 * Two of the critic's findings are pure statements about a point set and need no
 * renderer to check:
 *
 *  - "no vegetation at the road shoulder ... the 1-2 m runoff-and-grit ribbon is
 *    the densest weed strip on any real neglected highway, and yours is bare
 *    dirt while tufts sit further out". Countable: clumps per 10 m of highway,
 *    binned by distance out from the pavement edge.
 *  - "near-constant nearest-neighbour spacing reading as a dot lattice".
 *    Measurable: the coefficient of variation of the nearest-neighbour
 *    distance. A Poisson process gives ~0.52; a jittered lattice gives ~0.2 or
 *    less; genuinely clustered growth gives well above 0.6.
 *
 *   node tools/vegscatter.mjs
 */
import { rmSync } from "node:fs";
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { sites, site } = await import("../.shot-build/cpu/vegscatter.mjs");

const all = sites(1);
const { ROAD, PAD } = site;

console.log(`total clumps: ${all.length}`);
const byKind = {};
for (const s of all) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
console.log(`by kind: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ")}`);

/* ---------------- the highway shoulder ribbon ---------------- */
// Only the stretch a camera can actually see: the presets all look at the site
// between roughly x = -60 and x = +60.
const VIEW_X = 60;
const bins = [
  [-0.2, 0.3],
  [0.3, 1.0],
  [1.0, 2.0],
  [2.0, 4.0],
  [4.0, 8.0],
];
console.log(`\nhighway shoulder, both sides, |x| < ${VIEW_X} m  (${VIEW_X * 2 * 2} m of edge)`);
for (const [lo, hi] of bins) {
  const n = all.filter((s) => {
    if (Math.abs(s.x) > VIEW_X) return false;
    const out = Math.abs(s.z) - ROAD.halfPaved;
    return out >= lo && out < hi;
  }).length;
  console.log(
    `  ${lo.toFixed(1)}-${hi.toFixed(1)} m out: ${String(n).padStart(4)} clumps` +
      `  = ${(n / ((VIEW_X * 2 * 2) / 10)).toFixed(2)} per 10 m of edge` +
      (lo < 2 && n / ((VIEW_X * 2 * 2) / 10) < 1.0 ? "   !! sparse for a runoff ribbon" : "")
  );
}

/* ---------------- fence line ---------------- */
// Kept in step with FENCE_PATH in VegetationSystem.ts.
const FENCE = [
  [-42, 14],
  [-42, 47],
  [44, 47],
  [44, 20],
];
let fenceLen = 0;
for (let i = 0; i + 1 < FENCE.length; i++) fenceLen += Math.hypot(FENCE[i + 1][0] - FENCE[i][0], FENCE[i + 1][1] - FENCE[i][1]);
const distToFence = (x, z) => {
  let best = Infinity;
  for (let i = 0; i + 1 < FENCE.length; i++) {
    const [x0, z0] = FENCE[i];
    const [x1, z1] = FENCE[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
  }
  return best;
};
const nFence = all.filter((s) => distToFence(s.x, s.z) < 1.4).length;
console.log(
  `\nwithin 1.4 m of the fence line (${fenceLen.toFixed(0)} m of fence): ${nFence} clumps` +
    ` = ${(nFence / (fenceLen / 10)).toFixed(2)} per 10 m` +
    (nFence / (fenceLen / 10) < 1.5 ? "   !! sparse for an unmown fence line" : "")
);

/* ---------------- nearest-neighbour statistics ---------------- */
function nnStats(pts) {
  if (pts.length < 3) return null;
  // Uniform grid bucketing so this stays quick at a few thousand points.
  const cell = 2.0;
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (let i = 0; i < pts.length; i++) {
    const gi = Math.floor(pts[i].x / cell);
    const gj = Math.floor(pts[i].z / cell);
    const k = key(gi, gj);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const d = [];
  for (let i = 0; i < pts.length; i++) {
    const gi = Math.floor(pts[i].x / cell);
    const gj = Math.floor(pts[i].z / cell);
    let best = Infinity;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        for (const j of grid.get(key(gi + a, gj + b)) ?? []) {
          if (j === i) continue;
          const dx = pts[i].x - pts[j].x;
          const dz = pts[i].z - pts[j].z;
          const dd = dx * dx + dz * dz;
          if (dd < best) best = dd;
        }
      }
    }
    if (best < Infinity) d.push(Math.sqrt(best));
  }
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
  const s = [...d].sort((a, b) => a - b);
  return { n: d.length, mean: m, cv: sd / m, p05: s[(d.length * 0.05) | 0], p95: s[(d.length * 0.95) | 0] };
}

const regions = {
  "whole site": all,
  "open dirt (z > 55)": all.filter((s) => s.z > 55),
  "frontage verge": all.filter((s) => s.z > ROAD.halfPaved + 0.8 && s.z < PAD.minZ),
  "shoulder ribbon": all.filter((s) => Math.abs(Math.abs(s.z) - ROAD.halfPaved) < 2.2),
};
console.log(`\nnearest-neighbour spacing  (Poisson CV ~0.52; jittered lattice <0.25; clustered >0.6)`);
for (const [name, pts] of Object.entries(regions)) {
  const st = nnStats(pts);
  if (!st) {
    console.log(`  ${name.padEnd(22)} too few points (${pts.length})`);
    continue;
  }
  console.log(
    `  ${name.padEnd(22)} n=${String(st.n).padStart(4)}  mean ${st.mean.toFixed(2)} m  CV ${st.cv.toFixed(3)}` +
      `  p05 ${st.p05.toFixed(2)}  p95 ${st.p95.toFixed(2)}` +
      (st.cv < 0.3 ? "   !! LATTICE" : st.cv < 0.45 ? "   !  regular" : "")
  );
}

/* ---------------- size variety ---------------- */
const sz = all.map((s) => s.size).sort((a, b) => a - b);
console.log(
  `\nclump size: p05 ${sz[(sz.length * 0.05) | 0].toFixed(2)} m  p50 ${sz[(sz.length * 0.5) | 0].toFixed(2)} m  ` +
    `p95 ${sz[(sz.length * 0.95) | 0].toFixed(2)} m  ratio p95/p05 ${(sz[(sz.length * 0.95) | 0] / sz[(sz.length * 0.05) | 0]).toFixed(2)}x`
);

rmSync(".shot-build/cpu", { recursive: true, force: true });
