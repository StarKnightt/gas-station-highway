#!/usr/bin/env node
/**
 * Characterise a suspect region of a capture pixel by pixel.
 *
 *   node tools/probe-band.mjs shots/.../interior.png 780,420,340,90
 *
 * "A band of hard-edged pure-black blocks" is a description, not a
 * measurement, and the two candidate causes have opposite fixes: an *object*
 * that is unlit still carries fog, haze and a little sky, so it bottoms out
 * somewhere in the teens and has soft edges where it meets the sky; a *shading
 * failure* clamps to exactly zero and has edges one pixel wide. This reports
 * which of those it is.
 *
 * Prints the exact-zero fraction, the histogram of the dark tail, and the
 * sharpness of the transition at the blocks' boundary.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [, , src, rect] = process.argv;
if (!src || !rect) {
  console.error("usage: probe-band.mjs <png> <x,y,w,h>");
  process.exit(2);
}
const [rx, ry, rw, rh] = rect.split(",").map(Number);
const png = PNG.sync.read(fs.readFileSync(src));
const at = (x, y) => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

let exactZero = 0;
let n = 0;
const tail = new Array(16).fill(0);
for (let y = ry; y < ry + rh; y++) {
  for (let x = rx; x < rx + rw; x++) {
    const c = at(x, y);
    n++;
    if (c[0] === 0 && c[1] === 0 && c[2] === 0) exactZero++;
    const l = luma(c);
    if (l < 16) tail[Math.floor(l)]++;
  }
}

// Edge sharpness: for every horizontal run, how many pixels does it take to go
// from "dark" to "bright"? A real object against the sky has a filtered edge
// two or three pixels wide; a clamped shading failure steps in one.
const edges = [];
for (let y = ry; y < ry + rh; y++) {
  for (let x = rx + 1; x < rx + rw; x++) {
    const a = luma(at(x - 1, y));
    const b = luma(at(x, y));
    if (a < 4 && b > 60) edges.push(b - a);
    if (a > 60 && b < 4) edges.push(a - b);
  }
}

console.log(`\n${src}  region ${rect}  (${png.width}x${png.height})`);
console.log(`  pixels                    ${n}`);
console.log(`  exactly rgb(0,0,0)        ${exactZero}  (${((exactZero / n) * 100).toFixed(1)}%)`);
console.log(`  luma histogram 0..15      ${tail.join(" ")}`);
console.log(`  one-pixel dark<->bright steps  ${edges.length}`);
if (edges.length) {
  const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
  console.log(`    mean magnitude          ${mean.toFixed(1)} / 255`);
}
console.log(
  exactZero / n > 0.05
    ? "  => a large exactly-zero area with hard steps is a SHADING FAILURE, not an unlit object\n"
    : "  => no significant exactly-zero area; consistent with dark geometry\n"
);
