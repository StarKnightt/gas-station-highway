/**
 * Luminance profile down a single screen column of a capture.
 *
 * A pixel diff can prove a crease changed the image without proving it made a
 * highlight *terminate* - the first attempt at feature lines changed 47,000
 * pixels while still reading as a soft tonal band. This walks one column and
 * prints luminance per row, so a step and a ramp can be told apart by looking
 * at the numbers rather than at a JPEG.
 *
 *   node tools/carprobe.mjs shots/car/side.png 512 [y0 y1]
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [file, xs, y0s, y1s] = process.argv.slice(2);
if (!file || !xs) {
  console.error("usage: node tools/carprobe.mjs <png> <x> [y0 y1]");
  process.exit(2);
}
const png = PNG.sync.read(fs.readFileSync(file));
const x = Number(xs);
const y0 = y0s ? Number(y0s) : 0;
const y1 = y1s ? Number(y1s) : png.height - 1;

const lum = (y) => {
  const i = (png.width * y + x) * 4;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
};

const rows = [];
for (let y = y0; y <= y1; y++) rows.push({ y, L: lum(y) });

// Largest single-row jump, which is what a terminating highlight looks like.
let best = { y: y0, d: 0 };
for (let i = 1; i < rows.length; i++) {
  const d = rows[i].L - rows[i - 1].L;
  if (Math.abs(d) > Math.abs(best.d)) best = { y: rows[i].y, d };
}
const span = Math.max(...rows.map((r) => r.L)) - Math.min(...rows.map((r) => r.L));

console.log(`${file}  column x=${x}, rows ${y0}..${y1}`);
for (const r of rows) {
  const n = Math.round(r.L / 3);
  console.log(`  y=${String(r.y).padStart(4)}  ${r.L.toFixed(1).padStart(6)}  ${"#".repeat(Math.min(70, n))}`);
}
console.log(`\n  range over column: ${span.toFixed(1)}`);
console.log(`  biggest single-row step: ${best.d.toFixed(1)} at y=${best.y}`);
console.log(`  step as fraction of range: ${(Math.abs(best.d) / Math.max(1, span) * 100).toFixed(0)}%`);
console.log("  A crease that terminates a highlight puts most of the range into");
console.log("  one or two rows. A ramp spreads it over many.");
