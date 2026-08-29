#!/usr/bin/env node
/**
 * Measures *soft blotchiness* over a whole frame, and compares it across
 * frames, without anyone choosing a region.
 *
 * Written for one specific complaint: "patterned blotches on the ground that
 * read like shadow-map noise, not surface detail". That sentence contains the
 * whole measurement problem, because a blotch and a surface are the same thing
 * to every instrument already in this repo:
 *
 *   - `regionstat` reports sd inside a rectangle. Asphalt grain and shadow
 *     mottle both raise sd, so a high number proves nothing, and the rectangle
 *     is hand-placed besides.
 *   - `framescan` works on whole rows, so a 40-px patch is averaged into 1600
 *     px of row and disappears.
 *
 * The separation that does work is **spatial scale**. Procedural asphalt grain
 * in this project is per-pixel to a few pixels. Shadow-filter artefacts are the
 * size of the filter footprint projected to screen, which at a 6-degree sun is
 * tens of pixels. So:
 *
 *   1. Box-downsample luma by `--down` (default 8). This is a low-pass: grain
 *      averages away, soft patches survive.
 *   2. Compute local standard deviation over a `--win` (default 5) window of
 *      the downsampled image. At the defaults that is sensitive to structure
 *      of roughly 16-320 screen px, which is the blotch band and not the grain
 *      band.
 *   3. Report percentiles over every window in the frame, plus the worst
 *      windows with coordinates in ORIGINAL pixels so `regionstat` can confirm.
 *
 * **This tool cannot tell you a blotch is a shadow artefact.** A single number
 * from a single frame is uninterpretable, and reporting one would repeat the
 * mistake this file exists to avoid. It is built to be run across a sweep of
 * one variable, where the *response* is the evidence: receiver-plane and
 * filter-footprint errors scale with the filter radius, and surface detail does
 * not. Pass several frames and read the trend, not the value.
 *
 * usage:
 *   node tools/mottle.mjs a.png b.png c.png
 *   node tools/mottle.mjs --down=8 --win=5 --rows=0.45,1.0 a.png b.png
 *
 * `--rows` restricts to a fractional vertical band (default 0.45-1.0, i.e. the
 * lower part of the frame where the ground is). It is applied identically to
 * every frame, which is the only reason a shared crop is legitimate here: it
 * cannot favour one variant over another. `--rows=0,1` scans everything.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DOWN = Number(arg("down", "8"));
const WIN = Number(arg("win", "5"));
const ROWS = arg("rows", "0.45,1.0").split(",").map(Number);
const files = argv.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("usage: node tools/mottle.mjs [--down=8] [--win=5] [--rows=0.45,1.0] frame.png ...");
  process.exit(1);
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function measure(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: W, height: H, data } = png;

  const y0 = Math.max(0, Math.floor(ROWS[0] * H));
  const y1 = Math.min(H, Math.ceil(ROWS[1] * H));

  // ---- 1. box-downsample luma. Rec.709 on the stored (sRGB-encoded) values:
  // this is a perceptual blotch measure, not a radiometric one, and the critic
  // is reacting to the encoded image.
  const dw = Math.floor(W / DOWN);
  const dh = Math.floor((y1 - y0) / DOWN);
  const small = new Float64Array(dw * dh);
  for (let by = 0; by < dh; by++) {
    for (let bx = 0; bx < dw; bx++) {
      let sum = 0;
      for (let j = 0; j < DOWN; j++) {
        const yy = y0 + by * DOWN + j;
        for (let i = 0; i < DOWN; i++) {
          const idx = (yy * W + bx * DOWN + i) << 2;
          sum += 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
        }
      }
      small[by * dw + bx] = sum / (DOWN * DOWN);
    }
  }

  // ---- 2. local sd over WIN x WIN of the downsampled image.
  const half = Math.floor(WIN / 2);
  const sds = [];
  const worst = [];
  for (let by = half; by < dh - half; by++) {
    for (let bx = half; bx < dw - half; bx++) {
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let j = -half; j <= half; j++) {
        for (let i = -half; i <= half; i++) {
          const v = small[(by + j) * dw + bx + i];
          s += v;
          s2 += v * v;
          n++;
        }
      }
      const mean = s / n;
      const varr = Math.max(0, s2 / n - mean * mean);
      const sd = Math.sqrt(varr);
      sds.push(sd);
      worst.push({ sd, x: bx * DOWN, y: y0 + by * DOWN, mean });
    }
  }

  sds.sort((a, b) => a - b);
  worst.sort((a, b) => b.sd - a.sd);
  return {
    file,
    n: sds.length,
    p50: pct(sds, 50),
    p90: pct(sds, 90),
    p99: pct(sds, 99),
    max: sds[sds.length - 1],
    worst: worst.slice(0, 5),
  };
}

const results = files.map(measure);

console.log(
  `mottle: down=${DOWN} win=${WIN} rows=${ROWS[0]}-${ROWS[1]}  ` +
    `(sensitive to ~${DOWN * 2}-${DOWN * WIN * 8} px structure)`
);
console.log("  " + "frame".padEnd(34) + "windows".padStart(9) + "p50".padStart(8) + "p90".padStart(8) + "p99".padStart(8) + "max".padStart(8));
for (const r of results) {
  const short = r.file.split(/[\\/]/).pop().padEnd(34);
  console.log(
    "  " +
      short +
      String(r.n).padStart(9) +
      r.p50.toFixed(3).padStart(8) +
      r.p90.toFixed(3).padStart(8) +
      r.p99.toFixed(3).padStart(8) +
      r.max.toFixed(3).padStart(8)
  );
}

// The comparison is the result, so print it rather than leaving it to be
// eyeballed off the table. Ratios against the first frame listed.
if (results.length > 1) {
  const base = results[0];
  console.log(`\n  ratio vs ${base.file.split(/[\\/]/).pop()}:`);
  for (const r of results.slice(1)) {
    const short = r.file.split(/[\\/]/).pop().padEnd(34);
    console.log(
      "  " +
        short +
        `  p50 x${(r.p50 / base.p50).toFixed(3)}` +
        `  p90 x${(r.p90 / base.p90).toFixed(3)}` +
        `  p99 x${(r.p99 / base.p99).toFixed(3)}`
    );
  }
}

console.log(`\n  worst windows in ${results[results.length - 1].file.split(/[\\/]/).pop()} (original px, hand to regionstat):`);
for (const w of results[results.length - 1].worst) {
  console.log(`    sd ${w.sd.toFixed(2)}  mean ${w.mean.toFixed(1)}  ${w.x},${w.y},${DOWN * WIN},${DOWN * WIN}`);
}
