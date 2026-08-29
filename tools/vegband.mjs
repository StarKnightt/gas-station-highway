#!/usr/bin/env node
/**
 * Measures the horizon bands *in the rendered pixels*, per band.
 *
 * This tool exists because `vegHorizonBands.ts` asserts that each band is
 * lighter and bluer than the one in front and that assertion passed happily
 * while the critic was looking at a flat black cutout. The assertion was true
 * and useless: it checked the *authored* numbers were ordered, not that the
 * rendered result had any usable range. Authored 0.046 sRGB became 0.0036
 * linear on the way to the GPU and the whole four-layer stack collapsed into
 * the bottom 6% of the display range, where ordering is invisible.
 *
 * So the rule this encodes: for anything whose whole job is a tonal
 * relationship, assert the relationship *in output pixels*, not in the numbers
 * you typed. Ordering is necessary and nowhere near sufficient; the spread has
 * to be big enough to see.
 *
 *   node tools/vegband.mjs <png> [--col=N]
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: vegband.mjs <png>");
  process.exit(2);
}

const png = PNG.sync.read(fs.readFileSync(file));
const { width: W, height: H } = png;
const at = (x, y) => {
  const i = (W * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

console.log(`${file}  ${W}x${H}`);

/* --- find the skyline: the topmost strong downward luma step per column --- */
const sky = [];
const bandTop = [];
for (let x = 0; x < W; x++) {
  let found = -1;
  for (let y = Math.round(H * 0.25); y < Math.round(H * 0.62); y++) {
    if (luma(at(x, y)) - luma(at(x, y + 1)) > 25) {
      found = y + 1;
      break;
    }
  }
  bandTop.push(found);
  sky.push(found > 0 ? luma(at(x, found - 3)) : NaN);
}

const live = bandTop.filter((v) => v > 0);
console.log(`  skyline found in ${live.length}/${W} columns`);

/* --- is "the skyline" one thing in this frame? ----------------------- */
// Added after this tool passed `wide.png` at band luma 99.6 while two critics
// independently reported a cold band at the horizon in that exact file. Two
// separate reasons, and this is the first: the detector takes the topmost luma
// step per column, which in any frame with a pine or a building in it is the
// crown or the parapet, not the horizon. Every statistic below is then a blend
// of tree and horizon, and a blend cannot be compared against a threshold.
// Reported rather than corrected, because the numbers below are what the
// vegetation work has been tuned against and moving them silently would be its
// own version of this bug.
{
  const bucket = new Map();
  for (const v of live) bucket.set(Math.floor(v / 10) * 10, (bucket.get(Math.floor(v / 10) * 10) ?? 0) + 1);
  const [modal, count] = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const share = count / Math.max(1, live.length);
  console.log(`  modal skyline row ${modal}; ${(share * 100).toFixed(0)}% of columns agree`);
  if (share < 0.5)
    console.log(
      `  !! BLENDED SKYLINE: only ${(share * 100).toFixed(0)}% of columns put the skyline near row ${modal},` +
        ` so every mean below mixes horizon pixels with whatever else crosses that row.` +
        ` Crop to open sky with --col, or use tools/framescan.mjs, which takes the modal row.`
    );
}
if (!live.length) {
  console.log("  !! NO SKYLINE: nothing is closing the horizon in this frame");
  process.exit(0);
}

/* --- silhouette roughness at native resolution --- */
let steps = 0;
let sumAbs = 0;
for (let x = 1; x < W; x++) {
  if (bandTop[x] > 0 && bandTop[x - 1] > 0) {
    const d = Math.abs(bandTop[x] - bandTop[x - 1]);
    sumAbs += d;
    if (d > 0) steps++;
  }
}
const minY = Math.min(...live);
const maxY = Math.max(...live);
console.log(
  `  skyline y range ${minY}-${maxY} = ${maxY - minY} px of relief;` +
    ` mean |dy/dx| ${(sumAbs / live.length).toFixed(2)} px;` +
    ` ${((steps / live.length) * 100).toFixed(0)}% of columns step`
);
// A tree-crown edge changes height almost every column. A ridge is smooth.
if (sumAbs / live.length < 0.6)
  console.log(
    `  !! SMOOTH EDGE: mean step ${(sumAbs / live.length).toFixed(2)} px/column reads as a landform ridge,` +
      ` not as crowns (want > 1.0)`
  );

/* --- tonal relationship: sky, then successive tones going down --- */
const meanSky = sky.filter((v) => !isNaN(v)).reduce((a, b) => a + b, 0) / live.length;
console.log(`  sky just above the skyline: luma ${meanSky.toFixed(1)}`);

// Sample down from the skyline. The four bands stack, so distinct plateaus
// going down are the successive layers, nearest last.
const depth = 46;
const prof = [];
for (let d = 1; d <= depth; d++) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let x = 0; x < W; x++) {
    if (bandTop[x] < 0) continue;
    const y = bandTop[x] + d;
    if (y >= H) continue;
    const c = at(x, y);
    r += c[0];
    g += c[1];
    b += c[2];
    n++;
  }
  if (n) prof.push({ d, c: [r / n, g / n, b / n], l: luma([r / n, g / n, b / n]) });
}
console.log("  depth below skyline -> mean rgb, luma, blue/red:");
for (const p of prof) {
  if (p.d % 6 !== 1) continue;
  console.log(
    `    +${String(p.d).padStart(2)} px  rgb(${p.c.map((v) => v.toFixed(0)).join(",")})` +
      `  luma ${p.l.toFixed(1)}  b/r ${(p.c[2] / Math.max(p.c[0], 1)).toFixed(3)}`
  );
}

const bandL = prof[2].l;
console.log(
  `\n  VERDICT  sky ${meanSky.toFixed(1)}  band ${bandL.toFixed(1)}` +
    `  contrast ${(meanSky - bandL).toFixed(1)} levels`
);
if (bandL < 60)
  console.log(
    `  !! BAND TOO DARK: luma ${bandL.toFixed(1)}/255. The furthest object in the frame cannot be the` +
      ` darkest; aerial perspective means it should sit well up toward the sky.`
  );
if (meanSky - bandL > 90)
  console.log(
    `  !! CONTRAST TOO HIGH: ${(meanSky - bandL).toFixed(0)} levels across the skyline reads as a cutout`
  );

// The second reason this tool passed a frame two critics failed: everything
// above is luminance, and "the horizon reads as water" is a statement about
// hue. The b/r column in the profile carries the answer and nothing asserts on
// it. A band can sit at a perfectly healthy luma and still be the only cool
// thing in a warm frame, which is what makes it read as a different substance
// rather than as distance. That axis lives in tools/framescan.mjs, which
// sweeps the whole frame for it rather than sampling three rows below a
// skyline it may have mislocated.
console.log(
  `  NOTE  every check above is luminance-only. For the hue axis — a cool band in a warm` +
    ` frame reads as water however well lit it is — run: node tools/framescan.mjs ${file}`
);
