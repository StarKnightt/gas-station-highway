#!/usr/bin/env node
/**
 * Difference between two PNGs inside one or more rectangles.
 *
 *   node tools/regiondiff.mjs a.png b.png x,y,w,h[:label] [more rects...]
 *
 * Why this exists rather than `tools/diff.mjs`. Whole-image diffs are useless
 * whenever the two frames disagree about anything outside the subject — which
 * is always true when comparing two *instances* of an object photographed in
 * place, because the background behind each one differs. The signal you want
 * is confined to the object, and averaged over the frame it disappears.
 *
 * Reports, per rectangle: changed-pixel fraction above a threshold, mean and
 * max channel delta, and — the number that actually answers "are these the
 * same asset" — the **structural** delta, i.e. the delta remaining after each
 * rectangle's mean brightness is equalised. Two units that differ only in how
 * much sun they catch have a large raw delta and a near-zero structural one.
 * Two units that are genuinely different objects have both.
 *
 * Pure computation. Nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const [aPath, bPath] = args;
const rects = args.slice(2).map((s) => {
  const [spec, label] = s.split(":");
  const [x, y, w, h] = spec.split(",").map(Number);
  return { x, y, w, h, label: label ?? spec };
});

if (!aPath || !bPath || !rects.length) {
  console.error("usage: regiondiff.mjs a.png b.png x,y,w,h[:label] [...]");
  process.exit(2);
}

const a = PNG.sync.read(fs.readFileSync(aPath));
const b = PNG.sync.read(fs.readFileSync(bPath));
if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(2);
}

const THRESH = 3;
console.log(`${aPath}\n${bPath}`);

for (const r of rects) {
  let n = 0;
  let sum = 0;
  let max = 0;
  let changed = 0;
  let meanA = 0;
  let meanB = 0;

  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4;
      const la = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
      const lb = (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3;
      meanA += la;
      meanB += lb;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      sum += d;
      if (d > max) max = d;
      if (d > THRESH) changed++;
      n++;
    }
  }
  if (!n) {
    console.log(`  ${r.label.padEnd(16)} EMPTY (rect outside image)`);
    continue;
  }
  meanA /= n;
  meanB /= n;

  // Structural pass: equalise the two rectangles' mean luminance first, so a
  // pure exposure or sun-angle difference cancels and only pattern survives.
  const bias = meanA - meanB;
  let sSum = 0;
  let sMax = 0;
  let sChanged = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - (b.data[i + c] + bias)));
      sSum += d;
      if (d > sMax) sMax = d;
      if (d > THRESH) sChanged++;
    }
  }

  console.log(
    `  ${r.label.padEnd(16)} n=${n}  meanL ${meanA.toFixed(1)} vs ${meanB.toFixed(1)}\n` +
      `  ${"".padEnd(16)}   raw:        changed ${((changed / n) * 100).toFixed(1)}%  ` +
      `mean ${(sum / n).toFixed(2)}  max ${max}\n` +
      `  ${"".padEnd(16)}   structural: changed ${((sChanged / n) * 100).toFixed(1)}%  ` +
      `mean ${(sSum / n).toFixed(2)}  max ${sMax}`
  );
}
