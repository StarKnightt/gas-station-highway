#!/usr/bin/env node
/**
 * Mean colour of one or more rectangles inside a single PNG.
 *
 *   node tools/regionstat.mjs frame.png x,y,w,h:label [more rects...]
 *
 * The companion to `tools/regiondiff.mjs`, and it exists for NOTES.md case 20:
 * an absolute reading cannot tell a dark object from a dark light. "The
 * gondola end reads black" is an absolute reading; "the gondola end is 21/255
 * while the block wall two metres behind it is 158/255 under the same lamps"
 * is a measurement, and only the second one says whether the material or the
 * lighting is at fault. So this always wants at least two rectangles, one of
 * which is a control you believe is correct.
 *
 * Reports per rectangle: mean and stddev of luminance, mean R/G/B, R-B (the
 * warm/cool cast figure that ended the "brass wheels" round), and min/max
 * luminance so a rectangle that straddles an edge is visible as such.
 *
 * Pure computation. Nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const file = args[0];
const rects = args.slice(1).map((s) => {
  const [spec, label] = s.split(":");
  const [x, y, w, h] = spec.split(",").map(Number);
  return { x, y, w, h, label: label ?? spec };
});

if (!file || !rects.length) {
  console.error("usage: regionstat.mjs frame.png x,y,w,h[:label] [...]");
  process.exit(2);
}

const img = PNG.sync.read(fs.readFileSync(file));
console.log(`${file}  ${img.width}x${img.height}`);
console.log(
  `  ${"region".padEnd(18)} ${"n".padStart(7)} ${"meanL".padStart(7)} ${"sd".padStart(6)} ` +
    `${"R".padStart(6)} ${"G".padStart(6)} ${"B".padStart(6)} ${"R-B".padStart(6)} ${"min".padStart(5)} ${"max".padStart(5)}`
);

for (const r of rects) {
  let n = 0;
  let sR = 0;
  let sG = 0;
  let sB = 0;
  let sL = 0;
  let sL2 = 0;
  let lo = 255;
  let hi = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      const R = img.data[i];
      const G = img.data[i + 1];
      const B = img.data[i + 2];
      const L = (R + G + B) / 3;
      sR += R;
      sG += G;
      sB += B;
      sL += L;
      sL2 += L * L;
      if (L < lo) lo = L;
      if (L > hi) hi = L;
      n++;
    }
  }
  if (!n) {
    console.log(`  ${r.label.padEnd(18)} EMPTY (rect outside image)`);
    continue;
  }
  const mL = sL / n;
  const sd = Math.sqrt(Math.max(0, sL2 / n - mL * mL));
  console.log(
    `  ${r.label.padEnd(18)} ${String(n).padStart(7)} ${mL.toFixed(1).padStart(7)} ${sd.toFixed(1).padStart(6)} ` +
      `${(sR / n).toFixed(1).padStart(6)} ${(sG / n).toFixed(1).padStart(6)} ${(sB / n).toFixed(1).padStart(6)} ` +
      `${(sR / n - sB / n).toFixed(1).padStart(6)} ${lo.toFixed(0).padStart(5)} ${hi.toFixed(0).padStart(5)}`
  );
}
