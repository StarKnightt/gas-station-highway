/**
 * Grey-card reflectance derivation from a substitution pair.
 *
 * Give it two captures of the same pose - one with the real material, one with
 * a known-albedo reference in the SAME mesh - and it reports the reflectance the
 * real material is actually delivering.
 *
 * The region is not hand-picked. It is defined as "the pixels that changed when
 * the material was swapped", which is the only definition that cannot be wrong:
 * a pixel that did not move was not showing the material, so it has no business
 * in the average. That doubles as the region validator - if the changed area is
 * a tiny fraction of the frame, the swap did not take and the numbers are void.
 *
 * Usage:
 *   node tools/greycard.mjs <real.png> <reference.png> [--albedo=0.18] [--min=2]
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("usage: greycard.mjs <real.png> <reference.png> [--albedo=0.18]");
  process.exit(2);
}

function num(flag, dflt) {
  const hit = args.find((a) => a.startsWith(`--${flag}=`));
  if (!hit) return dflt;
  const raw = hit.slice(flag.length + 3);
  const v = Number(raw);
  // A bare or malformed flag must fail loudly. A gate a typo can disable is not
  // a gate, and this project has already lost a round to `--baseline` parsing to
  // the empty string and silently skipping the check.
  if (raw === "" || !Number.isFinite(v)) {
    console.error(`--${flag} needs a finite number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return v;
}

const REF_ALBEDO = num("albedo", 0.18);
/** Per-channel 8-bit delta below which a pixel counts as "did not move". */
const MIN_DELTA = num("min", 2);

const read = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`missing: ${p}`);
    process.exit(2);
  }
  const png = PNG.sync.read(fs.readFileSync(p));
  if (!png.width || !png.height) {
    console.error(`${p} is ${png.width}x${png.height} - a zero-dimension capture`);
    process.exit(2);
  }
  return png;
};

const A = read(files[0]);
const B = read(files[1]);
if (A.width !== B.width || A.height !== B.height) {
  console.error(`size mismatch: ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  process.exit(2);
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Accumulators over the changed region, in linear light. */
const acc = { a: [0, 0, 0], b: [0, 0, 0], n: 0 };
// Extent of the changed region. A region defined by a diff still has to be
// SHAPED like the thing it claims to be: if the swap leaks into the sky or the
// asphalt, the bounding box says so immediately and the mean does not.
const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
const total = A.width * A.height;
for (let i = 0; i < total; i++) {
  const o = i * 4;
  const dr = Math.abs(A.data[o] - B.data[o]);
  const dg = Math.abs(A.data[o + 1] - B.data[o + 1]);
  const db = Math.abs(A.data[o + 2] - B.data[o + 2]);
  if (Math.max(dr, dg, db) < MIN_DELTA) continue;
  acc.n++;
  const px = i % A.width;
  const py = (i - px) / A.width;
  if (px < bb.x0) bb.x0 = px;
  if (px > bb.x1) bb.x1 = px;
  if (py < bb.y0) bb.y0 = py;
  if (py > bb.y1) bb.y1 = py;
  for (let c = 0; c < 3; c++) {
    acc.a[c] += srgbToLinear(A.data[o + c] / 255);
    acc.b[c] += srgbToLinear(B.data[o + c] / 255);
  }
}

if (acc.n < 200) {
  console.error(
    `only ${acc.n} pixels moved between the two arms. The substitution did not ` +
      `take, or the poses differ. Refusing to report a reflectance.`
  );
  process.exit(1);
}

const meanA = acc.a.map((v) => v / acc.n);
const meanB = acc.b.map((v) => v / acc.n);
const lumA = LUM(...meanA);
const lumB = LUM(...meanB);

// The reference tells us the irradiance the region is receiving, expressed as
// "rendered linear per unit albedo". Everything else divides through it.
const perAlbedo = lumB / REF_ALBEDO;
const delivered = lumA / perAlbedo;

const f = (v) => v.toFixed(4);
console.log(`\nregion: ${acc.n} px changed of ${total} (${((100 * acc.n) / total).toFixed(2)}% of frame)`);
console.log(`        defined by the swap, not by hand - every pixel here showed the material`);
const bw = bb.x1 - bb.x0 + 1;
const bh = bb.y1 - bb.y0 + 1;
console.log(
  `extent: x ${bb.x0}-${bb.x1} (${bw}px), y ${bb.y0}-${bb.y1} (${bh}px) ` +
    `in ${A.width}x${A.height}`
);
console.log(
  `        fill of that box ${((100 * acc.n) / (bw * bh)).toFixed(1)}% - a solid ` +
    `object is dense, a leak is sparse\n`
);
console.log(`  real       linear RGB  ${meanA.map(f).join("  ")}   lum ${f(lumA)}`);
console.log(`  reference  linear RGB  ${meanB.map(f).join("  ")}   lum ${f(lumB)}`);
console.log(`\n  reference albedo        ${f(REF_ALBEDO)} (given)`);
console.log(`  rendered per unit albedo ${f(perAlbedo)}`);
console.log(`  => delivered reflectance ${f(delivered)}  (luminance)`);
console.log(`     real / reference       ${(lumA / lumB).toFixed(3)}x\n`);

// Per-channel delivered reflectance, which is what tells you about the hue
// rather than just the value.
const perCh = meanA.map((v, c) => (v / (meanB[c] / REF_ALBEDO)));
console.log(`  delivered per channel    ${perCh.map(f).join("  ")}`);
console.log(`  R-B of delivered         ${f(perCh[0] - perCh[2])}\n`);
