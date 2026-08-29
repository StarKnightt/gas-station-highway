#!/usr/bin/env node
/**
 * pumpchroma — does this frame's shadow run cool, as dawn does, or is it warm
 * everywhere?
 *
 *   node tools/pumpchroma.mjs <png>...
 *
 * The environment was corrected tonight — sun 5.6 -> 4.4, environment 1.0 -> 2.4
 * — on the physical argument that at 6.2 degrees of elevation the sun crosses ten
 * air masses and loses to the sky. The consequence is a claim about *colour*, not
 * about level: a shaded surface at dawn is lit mostly by blue skylight, so **warm
 * key against cool shadow is dawn and uniformly warm shadow is a preset**. Every
 * material authored before that correction is suspect, across every system.
 *
 * The measurement has to be coordinate-free, because picking a lit patch and a
 * shaded patch by hand is how you confirm whatever you already believe. So this
 * sweeps the whole frame, buckets every pixel by luma into deciles, and reports
 * the mean chromaticity of each decile. The *shape* of the resulting curve is the
 * answer and no region was chosen:
 *
 *   b-y falling as luma falls   -> dark pixels are bluer: dawn is working
 *   b-y flat or rising          -> shadow is as warm as key: a preset
 *
 * Sky is excluded, since the sky is not a shaded surface and its own gradient
 * would dominate the top deciles. Everything else, including other systems'
 * geometry, is in — a scene-wide defect should show scene-wide.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node tools/pumpchroma.mjs <png>...");
  process.exit(2);
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Two opponent axes on linear values, normalised by luminance so they describe
 * hue rather than brightness. Positive `by` is warm (yellow over blue).
 */
function chroma(r, g, b) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (y <= 1e-6) return null;
  return { y, by: ((r + g) / 2 - b) / y, rg: (r - g) / y };
}

for (const file of files) {
  const png = PNG.sync.read(await fs.readFile(path.resolve(file)));
  const px = [];
  // Sky rejection by column: everything above the first row in that column that
  // is not sky-like. Cheap and does not need a horizon estimate.
  for (let x = 0; x < png.width; x++) {
    let started = false;
    for (let y = 0; y < png.height; y++) {
      const i = (y * png.width + x) * 4;
      const r = srgbToLinear(png.data[i] / 255);
      const g = srgbToLinear(png.data[i + 1] / 255);
      const b = srgbToLinear(png.data[i + 2] / 255);
      // Sky here is bright and blue-dominant at the top of the frame; a surface
      // is anything after the first pixel in the column that is not.
      const isSky = !started && b > r * 0.95 && 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.15;
      if (!isSky) started = true;
      if (!started) continue;
      const c = chroma(r, g, b);
      if (c) px.push(c);
    }
  }
  if (px.length < 1000) {
    console.log(`${path.basename(file)}: only ${px.length} surface pixels, skipping`);
    continue;
  }
  px.sort((a, b) => a.y - b.y);
  console.log(`\n${path.basename(file)}  ${png.width}x${png.height}  ${px.length} surface pixels`);
  console.log("decile   luma      warm(b-y)   red(r-g)");
  const deciles = [];
  for (let d = 0; d < 10; d++) {
    const a = Math.floor((d * px.length) / 10);
    const b = Math.floor(((d + 1) * px.length) / 10);
    let sy = 0, sby = 0, srg = 0;
    for (let i = a; i < b; i++) {
      sy += px[i].y;
      sby += px[i].by;
      srg += px[i].rg;
    }
    const n = b - a;
    const row = { d, y: sy / n, by: sby / n, rg: srg / n };
    deciles.push(row);
    console.log(
      `${String(d + 1).padStart(4)}   ${row.y.toFixed(4).padStart(7)}   ` +
        `${row.by.toFixed(4).padStart(9)}   ${row.rg.toFixed(4).padStart(8)}`
    );
  }
  // Darkest three deciles against the brightest three. A dawn scene should show
  // the dark end measurably less warm.
  const dark = deciles.slice(0, 3).reduce((s, r) => s + r.by, 0) / 3;
  const lit = deciles.slice(-3).reduce((s, r) => s + r.by, 0) / 3;
  const delta = dark - lit;
  console.log(
    `  shadow warmth ${dark.toFixed(4)} vs key ${lit.toFixed(4)}  ->  ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
  );
  console.log(
    delta < -0.02
      ? "  PASS: shadow runs cooler than key, which is what a blue-skylight ambient does."
      : delta > 0.02
        ? "  FAIL: shadow is WARMER than key. Nothing in a dawn sky does that; this is a preset."
        : "  FLAT: shadow and key are the same hue. The ambient is not contributing colour."
  );
}
