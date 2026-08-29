// Measure the arch gap in the frame, in tyre-relative units.
//
// The critic's claim is "roughly a full extra tyre-sidewall's worth" of air
// between the arch lip and the tyre. That is a ratio, so it can be settled
// without any camera arithmetic: a 215/60R16 has a 129 mm sidewall on a 663 mm
// overall diameter, so one sidewall of gap is 0.195 of the tyre's diameter.
// Measure both in pixels off the saved PNG and compare.
//
// The generator's nominal is 33-36 mm, i.e. 0.054 of the diameter. If the frame
// agrees, the ride height is fine and something else is reading as air.
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/ridemeasure.mjs <png> [columns...]");
  process.exit(2);
}
const png = PNG.sync.read(await fs.readFile(path.resolve(file)));
const lum = (x, y) => {
  const i = (y * png.width + x) * 4;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
};

const cols = process.argv.slice(3).map(Number);
const step = Number(process.env.STEP ?? 8);
const [Y0, Y1] = (process.env.YRANGE ?? `0,${png.height}`).split(",").map(Number);
console.log(`${path.basename(file)}  ${png.width}x${png.height}`);
for (const x of cols) {
  // Print the profile so the structure is visible rather than assumed:
  // body panel, arch lip, whatever is inside the arch, then the tyre.
  const out = [];
  for (let y = Y0; y < Y1; y += step) out.push(`${y}:${lum(x, y).toFixed(0)}`);
  console.log(`\ncolumn x=${x}\n  ${out.join(" ")}`);

  // Contrast across the whole span the critic has to read the gap from. If this
  // is tiny, the gap is not measurable by eye no matter what its true size is,
  // and no amount of dropping the body will change what the frame communicates.
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = Y0; y < Y1; y++) {
    const v = lum(x, y);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  console.log(`  span ${Y0}-${Y1}: min ${lo.toFixed(1)}  max ${hi.toFixed(1)}  range ${(hi - lo).toFixed(1)}`);
}
