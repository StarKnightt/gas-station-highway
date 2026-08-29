#!/usr/bin/env node
/**
 * Why `framescan`'s RULED HORIZON number may be measuring its own selection.
 *
 * `framescan` finds each column's skyline as the first row with a >25 luma
 * downward step, then **keeps only columns whose skyline is within 12 px of the
 * modal row** before computing raggedness. On a frame where the skyline
 * genuinely wanders 30 px that gate discards precisely the columns that wander,
 * and the surviving set is, by construction, the flattest part of the edge. It
 * then computes "mean jump between adjacent columns" over that subset, which is
 * an average over a population selected for not jumping.
 *
 * Second, independent suspicion: the row index is an integer. An edge that
 * moves 0.4 px per column produces a run of identical integers and then a step
 * of 1, so "% of adjacent columns identical" measures **quantisation**, not
 * flatness, at any amplitude under a pixel per column. A sub-pixel estimate of
 * the same edge has no such floor.
 *
 * So this reports the same frame four ways, and the spread between them is the
 * finding:
 *
 *   gated   / integer   <- exactly what framescan reports today
 *   ungated / integer
 *   gated   / sub-pixel
 *   ungated / sub-pixel <- what the edge actually does
 *
 * Sub-pixel position is the linear crossing of the half-way luma between the
 * sky 4 px above and the ground 4 px below that column's own edge, which is
 * local on both sides (NOTES: "if the feature is local, the reference has to be
 * local too, and it has to be on both sides").
 *
 *   node tools/hzprobe.mjs <png> [...]
 *
 * Pure computation. No GPU, no server, nothing to tear down.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: hzprobe.mjs <png> [...]");
  process.exit(2);
}

function stats(vals) {
  if (!vals.length) return { n: 0, mean: NaN, ident: NaN };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  // "Identical" for a sub-pixel series means below a quarter pixel, since exact
  // float equality would always report 0% and would flatter the sub-pixel view.
  const ident = vals.filter((v) => v < 0.25).length / vals.length;
  return { n: vals.length, mean, ident };
}

function jumps(cols, key) {
  const out = [];
  for (let i = 1; i < cols.length; i++)
    if (cols[i].x === cols[i - 1].x + 1) out.push(Math.abs(cols[i][key] - cols[i - 1][key]));
  return out;
}

for (const file of files) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const W = png.width;
  const H = png.height;
  const lum = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  };

  const cols = [];
  for (let x = 0; x < W; x++) {
    for (let y = Math.round(H * 0.05); y < H - 6; y++) {
      if (lum(x, y) - lum(x, y + 1) > 25) {
        const yi = y + 1;
        // Sub-pixel: where the profile crosses the midpoint between this
        // column's own sky and its own ground, searched only across the edge.
        const sky = lum(x, Math.max(0, yi - 4));
        const gnd = lum(x, Math.min(H - 1, yi + 4));
        const half = (sky + gnd) / 2;
        let sy = yi;
        for (let k = yi - 4; k < yi + 4; k++) {
          const a = lum(x, k);
          const b = lum(x, k + 1);
          if (a >= half && b < half) {
            sy = k + (a - half) / Math.max(1e-6, a - b);
            break;
          }
        }
        cols.push({ x, yi, sy });
        break;
      }
    }
  }
  if (cols.length < 32) {
    console.log(`\n${path.basename(file)}: only ${cols.length} columns found an edge`);
    continue;
  }

  const bucket = new Map();
  for (const c of cols) {
    const k = Math.floor(c.yi / 10) * 10;
    bucket.set(k, (bucket.get(k) ?? 0) + 1);
  }
  const ground = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const gated = cols.filter((c) => Math.abs(c.yi - ground) <= 12);

  const rows = cols.map((c) => c.sy).sort((a, b) => a - b);
  const p = (q) => rows[Math.min(rows.length - 1, Math.floor(q * rows.length))];

  console.log(`\n${path.basename(file)}  ${W}x${H}   modal skyline row ${ground}`);
  console.log(
    `  edge found in ${cols.length}/${W} columns; ${gated.length} survive framescan's +/-12 px gate ` +
      `(${((gated.length / cols.length) * 100).toFixed(0)}%)`
  );
  console.log(
    `  skyline row spread over ALL columns: p05 ${p(0.05).toFixed(1)}  p50 ${p(0.5).toFixed(1)}  ` +
      `p95 ${p(0.95).toFixed(1)}   (p95-p05 = ${(p(0.95) - p(0.05)).toFixed(1)} px)`
  );

  const rowsOf = (set, key) => {
    const s = stats(jumps(set, key));
    return `${s.mean.toFixed(2)} px mean jump, ${(s.ident * 100).toFixed(0)}% identical  (n=${s.n})`;
  };
  console.log(`  gated   / integer  : ${rowsOf(gated, "yi")}   <- framescan reports this`);
  console.log(`  ungated / integer  : ${rowsOf(cols, "yi")}`);
  console.log(`  gated   / sub-pixel: ${rowsOf(gated, "sy")}`);
  console.log(`  ungated / sub-pixel: ${rowsOf(cols, "sy")}   <- what the edge does`);
}
