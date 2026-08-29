#!/usr/bin/env node
/**
 * Per-pixel difference between two PNGs.
 *
 *   node tools/diff.mjs a.png b.png [threshold]
 *
 * Prints the number of pixels whose max channel delta exceeds the threshold
 * (default 3, i.e. above dither noise), the largest delta seen anywhere, and
 * the mean delta. Used to prove a rendering feature actually reaches the
 * framebuffer instead of trusting that the code that draws it ran.
 *
 * Pure computation - no servers, no browsers, nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const [aPath, bPath, thrRaw] = process.argv.slice(2);
const threshold = Number(thrRaw ?? 3);

const a = PNG.sync.read(fs.readFileSync(aPath));
const b = PNG.sync.read(fs.readFileSync(bPath));
if (a.width !== b.width || a.height !== b.height) {
  console.error("size mismatch");
  process.exit(2);
}

let changed = 0;
let max = 0;
let sum = 0;
const n = a.width * a.height;
for (let i = 0; i < n; i++) {
  const d = Math.max(
    Math.abs(a.data[i * 4] - b.data[i * 4]),
    Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]),
    Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2])
  );
  sum += d;
  if (d > max) max = d;
  if (d > threshold) changed++;
}

const pct = ((changed / n) * 100).toFixed(2);
console.log(`changed=${changed} (${pct}%)  max=${max}  mean=${(sum / n).toFixed(2)}`);
process.exit(0);
