#!/usr/bin/env node
/**
 * Locate straight screen-axis-aligned brightness steps in a capture.
 *
 * A shadow cast by geometry lands on a curved car flank as a curved edge, and a
 * shadow-map texel boundary is aligned to the *light's* basis, not the screen's.
 * A step that is straight and axis-aligned in screen space over hundreds of
 * pixels is therefore a strong discriminator, and it is what this counts.
 *
 *   node tools/probe-block.mjs shot.png [x0 y0 x1 y1]
 *
 * Pure computation - no servers, no browsers, nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const [path, ...rect] = process.argv.slice(2);
const img = PNG.sync.read(fs.readFileSync(path));
const [x0, y0, x1, y1] = rect.length === 4 ? rect.map(Number) : [0, 0, img.width, img.height];

const lum = (x, y) => {
  const i = (y * img.width + x) * 4;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
};

// Mean |d/dx| down each column and |d/dy| across each row. A real edge in the
// scene contributes to a few columns; a screen-aligned step contributes to one.
const cols = [];
for (let x = x0 + 1; x < x1; x++) {
  let s = 0;
  for (let y = y0; y < y1; y++) s += lum(x, y) - lum(x - 1, y);
  cols.push([x, s / (y1 - y0)]);
}
const rows = [];
for (let y = y0 + 1; y < y1; y++) {
  let s = 0;
  for (let x = x0; x < x1; x++) s += lum(x, y) - lum(x, y - 1);
  rows.push([y, s / (x1 - x0)]);
}

const top = (arr, label) => {
  const sorted = [...arr].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
  console.log(`${label}: ` + sorted.map(([p, v]) => `${p}:${v.toFixed(2)}`).join("  "));
};
top(cols, "signed mean d/dx by column (top 12)");
top(rows, "signed mean d/dy by row    (top 12)");
