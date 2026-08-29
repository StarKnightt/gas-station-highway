#!/usr/bin/env node
/**
 * Does the interior have shading, or only albedo?
 *
 *   node tools/probe-shelfshade.mjs shots/system2/rounds/<id>/door.png [...]
 *
 * ## The question this is trying to make measurable
 *
 * The critic's interior verdict, twice, has been that products are "solid-colour
 * boxes" and shelves "plain grey slabs", and the answer both times looked like a
 * texture problem. It is not: the maps bind and the albedo is right. What the
 * frame is missing is the *shading* — a shelf underside sees almost no ceiling
 * and so should be much darker than its top, and a product base should be darker
 * than a product top.
 *
 * That is hard to catch by eye, because a bright frame with plenty of detail
 * looks fine, and it is easy to fake with a hand-picked rectangle. So measure it
 * without choosing regions, in two ways that fail differently:
 *
 * 1. **The histogram's dark tail.** A photograph of a real interior has one.
 *    Report the percentile ladder, so "no shadow anywhere" shows up as a black
 *    point that is nowhere near black.
 * 2. **Vertical local contrast.** For every pixel, the signed difference to the
 *    pixel a shelf-lip's-worth above it. Shading from above produces a strongly
 *    *asymmetric* distribution — dark bands under horizontal edges — whereas
 *    albedo-only detail produces a symmetric one. The asymmetry is the
 *    discriminator, and it needs no coordinates.
 *
 * A frame lit only by ambient cannot produce the asymmetry no matter how much
 * texture detail it carries, which is exactly why the two previous rounds of
 * texture work did not move the verdict.
 */

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node tools/probe-shelfshade.mjs <png> [png...]");
  process.exit(1);
}

/** Rec. 709 luma on the sRGB values, which is what the viewer sees. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(f));
  const { width: w, height: h, data } = png;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    L[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }

  const sorted = Float32Array.from(L).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

  // Vertical local contrast at a shelf-lip scale. 6 px at 1024 wide is roughly
  // the depth of a shelf lip's shadow at the distance these poses frame.
  const D = 6;
  let neg = 0;
  let pos = 0;
  let negSum = 0;
  let posSum = 0;
  let strongNeg = 0;
  let strongPos = 0;
  for (let y = D; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Positive means this pixel is brighter than the one above it.
      const d = L[y * w + x] - L[(y - D) * w + x];
      if (d < 0) {
        neg++;
        negSum -= d;
        if (d < -24) strongNeg++;
      } else {
        pos++;
        posSum += d;
        if (d > 24) strongPos++;
      }
    }
  }
  const n = neg + pos;

  console.log(`\n${path.basename(f)}  ${w}x${h}`);
  console.log(
    `  luma percentiles  p0 ${pct(0).toFixed(0)}  p1 ${pct(1).toFixed(0)}  ` +
      `p5 ${pct(5).toFixed(0)}  p25 ${pct(25).toFixed(0)}  p50 ${pct(50).toFixed(0)}  ` +
      `p75 ${pct(75).toFixed(0)}  p95 ${pct(95).toFixed(0)}  p100 ${pct(100).toFixed(0)}`
  );
  console.log(
    `  below 32: ${((100 * sorted.findIndex((v) => v >= 32)) / sorted.length).toFixed(2)}%   ` +
      `below 64: ${((100 * sorted.findIndex((v) => v >= 64)) / sorted.length).toFixed(2)}%   ` +
      `above 224: ${(100 * (1 - sorted.findIndex((v) => v >= 224) / sorted.length)).toFixed(2)}%`
  );
  console.log(
    `  vertical contrast at ${D} px:  darker-than-above ${((100 * neg) / n).toFixed(1)}% ` +
      `(mean ${(negSum / Math.max(1, neg)).toFixed(2)})   ` +
      `brighter ${((100 * pos) / n).toFixed(1)}% (mean ${(posSum / Math.max(1, pos)).toFixed(2)})`
  );
  console.log(
    `  strong (>24) below-edge dark ${((100 * strongNeg) / n).toFixed(3)}%  ` +
      `vs above-edge bright ${((100 * strongPos) / n).toFixed(3)}%  ` +
      `asymmetry ${(strongNeg / Math.max(1, strongPos)).toFixed(2)}x`
  );
}
