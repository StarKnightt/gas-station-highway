#!/usr/bin/env node
/**
 * Print the luminance profile of one pixel column of a PNG, and the rows where
 * it dips into a local minimum. Used to physically count masonry courses in a
 * capture instead of eyeballing them.
 *
 *   node tools/probe-column.mjs shots/system2/front.png 60 [y0] [y1]
 *
 * Pure computation - no servers, no browsers, nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const [path, xRaw, y0Raw, y1Raw] = process.argv.slice(2);
const png = PNG.sync.read(fs.readFileSync(path));
const x = Number(xRaw);
const y0 = Number(y0Raw ?? 0);
const y1 = Number(y1Raw ?? png.height);

const lum = [];
for (let y = y0; y < y1; y++) {
  const i = (y * png.width + x) * 4;
  lum.push(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
}

// Smooth by 1 px so single-pixel noise does not register as a joint.
const s = lum.map((_, i) => (lum[Math.max(i - 1, 0)] + lum[i] + lum[Math.min(i + 1, lum.length - 1)]) / 3);

const mins = [];
for (let i = 2; i < s.length - 2; i++) {
  if (s[i] <= s[i - 1] && s[i] <= s[i + 1] && s[i] < s[i - 2] && s[i] < s[i + 2]) {
    const depth = Math.min(s[i - 2], s[i + 2]) - s[i];
    if (depth > 1.5) mins.push({ y: y0 + i, v: s[i].toFixed(1), depth: depth.toFixed(1) });
  }
}

console.log(`column x=${x}, rows ${y0}..${y1}`);
console.log("local minima (candidate joint lines):");
for (const m of mins) console.log(`  y=${m.y}  lum=${m.v}  depth=${m.depth}`);
const gaps = [];
for (let i = 1; i < mins.length; i++) gaps.push(mins[i].y - mins[i - 1].y);
console.log("gaps:", gaps.join(" "));
console.log("count:", mins.length);
process.exit(0);
