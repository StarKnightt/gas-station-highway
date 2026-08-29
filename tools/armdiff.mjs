#!/usr/bin/env node
/**
 * Compare a feature arm against its forced-off control, per band of the frame.
 *
 * Written because a whole-frame mean is the wrong instrument for a ground
 * feature. `walk_sun` moved from 59 to 57 between default and `nowet`, which is
 * indistinguishable from noise, and yet the ground it is supposed to act on is
 * only the lower half of the frame and is at wildly different depths within it.
 * NOTES.md 52: an instrument dominated by the signal it is not measuring returns
 * a confident null. Sky, building and canopy are all in that mean and none of
 * them can move.
 *
 * So this bands the frame horizontally, and within each band reports the mean
 * signed change in luminance and the fraction of pixels that moved at all. A
 * feature acting on the near ground shows as a large signed change in the
 * bottom bands and nothing above the horizon; a feature doing nothing shows as
 * zeros everywhere, and the two are only distinguishable if you look separately.
 *
 * Usage:
 *   node tools/armdiff.mjs <default.png> <control.png> [--bands=8] [--x0=0] [--x1=1]
 *
 * `--x0/--x1` restrict to a horizontal slice, for when one side of the frame is
 * the surface of interest and the other is a building.
 */
import { PNG } from "pngjs";
import fs from "node:fs";

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? Number(h.slice(n.length + 3)) : d;
};
if (files.length !== 2) {
  console.error("usage: armdiff.mjs <default.png> <control.png> [--bands=8] [--x0=0] [--x1=1]");
  process.exit(2);
}
const BANDS = arg("bands", 8);
const X0 = arg("x0", 0);
const X1 = arg("x1", 1);

const read = (p) => {
  const png = PNG.sync.read(fs.readFileSync(p));
  // A zero-dimension PNG satisfies every mean-based check by making the mean
  // NaN and every comparison against NaN false. NOTES.md on the 0x0 capture.
  if (!png.width || !png.height) throw new Error(`${p} is ${png.width}x${png.height}`);
  return png;
};
const a = read(files[0]);
const b = read(files[1]);
if (a.width !== b.width || a.height !== b.height) {
  throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const xa = Math.floor(X0 * a.width);
const xb = Math.ceil(X1 * a.width);

console.log(`${files[0].split(/[\\/]/).pop()} vs ${files[1].split(/[\\/]/).pop()}  ${a.width}x${a.height}  x in [${xa},${xb})`);
console.log("band  rows          meanΔ    |Δ|      moved>1   moved>4   maxΔ");

let totMoved = 0;
let totN = 0;
for (let band = 0; band < BANDS; band++) {
  const y0 = Math.floor((band * a.height) / BANDS);
  const y1 = Math.floor(((band + 1) * a.height) / BANDS);
  let sum = 0;
  let sumAbs = 0;
  let m1 = 0;
  let m4 = 0;
  let n = 0;
  let mx = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * a.width + x) * 4;
      const d = lum(a.data, i) - lum(b.data, i);
      sum += d;
      const ad = Math.abs(d);
      sumAbs += ad;
      if (ad > 1) m1++;
      if (ad > 4) m4++;
      if (ad > Math.abs(mx)) mx = d;
      n++;
    }
  }
  totMoved += m1;
  totN += n;
  const pc = (v) => `${((100 * v) / n).toFixed(1)}%`;
  console.log(
    `${String(band).padStart(4)}  ${String(y0).padStart(4)}-${String(y1).padEnd(5)}  ` +
      `${(sum / n).toFixed(3).padStart(7)}  ${(sumAbs / n).toFixed(3).padStart(6)}  ` +
      `${pc(m1).padStart(8)}  ${pc(m4).padStart(8)}  ${mx.toFixed(1).padStart(6)}`,
  );
}
console.log(`overall moved>1: ${((100 * totMoved) / totN).toFixed(2)}%`);
if (totMoved === 0) {
  console.log("VERDICT: byte-identical. The arm is not reaching this frame at all.");
}

/**
 * Per-band contrast, for both frames separately.
 *
 * A mean difference cannot answer the question that matters for a lit scene at a
 * low sun. An arm that adds an *unshadowed* term - an environment reflection is
 * unshadowed by construction, since the shadow map only gates the sun - lifts
 * shadowed pixels and lit pixels by different amounts, and can raise the mean
 * while destroying the shadow contrast that the composition is made of. The mean
 * says "brighter" and the frame says "flatter", and only a spread statistic can
 * tell those apart.
 *
 * p90-p10 within a band is the right spread here rather than a variance, because
 * at a low sun each band is close to bimodal - in sun or in shadow - and the
 * two modes are what the percentiles land on.
 */
console.log("\nband  rows          p10  p50  p90   spread(p90-p10)      control spread   delta");
for (let band = 0; band < BANDS; band++) {
  const y0 = Math.floor((band * a.height) / BANDS);
  const y1 = Math.floor(((band + 1) * a.height) / BANDS);
  const grab = (png) => {
    const v = [];
    for (let y = y0; y < y1; y++) {
      for (let x = xa; x < xb; x++) v.push(lum(png.data, (y * png.width + x) * 4));
    }
    v.sort((p, q) => p - q);
    return v;
  };
  const pct = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const va = grab(a);
  const vb = grab(b);
  const sa = pct(va, 0.9) - pct(va, 0.1);
  const sb = pct(vb, 0.9) - pct(vb, 0.1);
  console.log(
    `${String(band).padStart(4)}  ${String(y0).padStart(4)}-${String(y1).padEnd(5)}  ` +
      `${pct(va, 0.1).toFixed(0).padStart(3)}  ${pct(va, 0.5).toFixed(0).padStart(3)}  ${pct(va, 0.9).toFixed(0).padStart(3)}   ` +
      `${sa.toFixed(1).padStart(10)}      ${sb.toFixed(1).padStart(10)}   ${(sa - sb).toFixed(1).padStart(6)}`,
  );
}
