#!/usr/bin/env node
/**
 * Whole-frame hunt for a repeating pattern, with no lag and no region supplied
 * by the caller.
 *
 *   node tools/probe-period.mjs shots/system2/rounds/<id>/*.png
 *   node tools/probe-period.mjs --selftest
 *
 * Written because a measurement and an observer disagreed, and both were right.
 * A critic reading rendered frames said the block courses "repeat visibly
 * across the wall at a period of a few blocks". The measurement that was
 * supposed to have settled that question tested the correlation between a
 * block and the block four along — a single lag, chosen because the albedo
 * tile is about four blocks wide — and returned -0.09, i.e. nothing.
 *
 * **A correlation at one lag is not a test for periodicity.** It answers "does
 * the pattern repeat at exactly this spacing", and it answers it in the units
 * of whatever quantity you fed it. It cannot see a period you did not guess, it
 * cannot see a period that drifts across the elevation, and it cannot see one
 * carried by a different quantity than the one sampled. An observer looking at
 * the picture is not doing any of that: they are seeing *whatever* repeats.
 *
 * So this asks the observer's question instead. For every horizontal band of
 * the frame it high-passes each row to kill the shading gradient, then
 * correlates the row against itself at every lag from 2 to 160 px and averages
 * over the band. A peak anywhere in that sweep is a repeat, and its lag says
 * what repeats — the caller supplies neither the lag nor the place.
 *
 * Reported per band: the three strongest peaks, their lag in pixels, and the
 * correlation. Bands are ranked so the worst one leads. A wall with genuine
 * per-unit variation has a peak at the masonry unit and nothing above it; a
 * wall repeating a texture tile has a second, usually stronger, peak at some
 * multiple of it, and that is the signature this exists to find.
 *
 * Pure computation. Nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const BANDS = 9;
const MIN_LAG = 2;
const MAX_LAG = 160;
/** Rows this far apart in a perspective view differ in scale, so bands stay short. */
const HIGHPASS = 9;

function luma(png) {
  const { width: w, height: h, data } = png;
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

/**
 * Subtract a running mean. Without this every row correlates with itself at
 * every lag simply because one end of the wall is brighter than the other, and
 * the sweep returns a smooth ramp with no peaks in it.
 */
function highpass(row) {
  const n = row.length;
  const out = new Float64Array(n);
  const r = HIGHPASS;
  let sum = 0;
  for (let i = 0; i < Math.min(r, n); i++) sum += row[i];
  let lo = 0;
  let hi = Math.min(r, n) - 1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + r)) sum += row[++hi];
    while (lo < Math.max(0, i - r)) sum -= row[lo++];
    out[i] = row[i] - sum / (hi - lo + 1);
  }
  return out;
}

function bandAutocorr(lum, w, y0, y1) {
  const acc = new Float64Array(MAX_LAG + 1);
  const cnt = new Float64Array(MAX_LAG + 1);
  let rows = 0;
  for (let y = y0; y < y1; y++) {
    const row = highpass(lum.subarray(y * w, y * w + w));
    let e = 0;
    for (let i = 0; i < w; i++) e += row[i] * row[i];
    // A flat row - sky, a shadow, an unlit face - carries no pattern and would
    // otherwise dilute the average towards zero for every band that contains
    // any sky at all.
    if (e / w < 1.0) continue;
    rows++;
    for (let L = MIN_LAG; L <= MAX_LAG; L++) {
      let s = 0;
      let n = 0;
      for (let i = 0; i + L < w; i++, n++) s += row[i] * row[i + L];
      acc[L] += s / n / (e / w);
      cnt[L]++;
    }
  }
  if (rows < 8) return null;
  const out = [];
  for (let L = MIN_LAG; L <= MAX_LAG; L++) out.push({ lag: L, r: acc[L] / cnt[L] });
  return { rows, curve: out };
}

/** Local maxima only: a broad shoulder is not a repeat. */
function peaks(curve, k = 3) {
  const p = [];
  for (let i = 2; i < curve.length - 2; i++) {
    const c = curve[i].r;
    if (c > curve[i - 1].r && c > curve[i + 1].r && c > curve[i - 2].r && c > curve[i + 2].r && c > 0.05) {
      p.push(curve[i]);
    }
  }
  return p.sort((a, b) => b.r - a.r).slice(0, k);
}

/** Transpose, so the same row machinery answers the column question. */
function transpose(lum, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = lum[y * w + x];
  return out;
}

function axis(label, lum, w, h, tag) {
  const bands = [];
  const bh = Math.floor(h / BANDS);
  for (let b = 0; b < BANDS; b++) {
    const res = bandAutocorr(lum, w, b * bh, (b + 1) * bh);
    if (!res) continue;
    bands.push({ y0: b * bh, y1: (b + 1) * bh, peaks: peaks(res.curve) });
  }
  bands.sort((a, b) => (b.peaks[0]?.r ?? 0) - (a.peaks[0]?.r ?? 0));
  console.log(`  --- ${label} ---`);
  if (!bands.length) {
    console.log("    no band carries enough contrast to test");
    return null;
  }
  for (const b of bands) {
    const top = b.peaks.map((p) => `lag ${String(p.lag).padStart(3)}px r ${p.r.toFixed(3)}`).join("   ");
    console.log(`    ${tag} ${String(b.y0).padStart(4)}-${String(b.y1).padStart(4)}  ${top || "(no peak above 0.05)"}`);
  }
  return bands[0];
}

function scan(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const lum = luma(png);
  console.log(`\n${file}  (${png.width}x${png.height})`);
  // Both axes, because the two complaints this exists to test are different
  // shapes: a texture tile repeating *along* a wall is horizontal, and courses
  // alternating between two values is vertical, and a probe that only sweeps
  // one axis will call the other one clean.
  const hor = axis("horizontal repeats, swept over rows", lum, png.width, png.height, "y");
  const ver = axis("vertical repeats, swept over columns", transpose(lum, png.width, png.height), png.height, png.width, "x");

  let worst = null;
  let which = "";
  for (const [b, name] of [
    [hor, "horizontal"],
    [ver, "vertical"],
  ]) {
    const r = b?.peaks[0]?.r ?? 0;
    if (r > (worst?.peaks[0]?.r ?? 0)) {
      worst = b;
      which = name;
    }
  }
  const top = worst?.peaks[0];
  if (top && top.r >= 0.25) {
    console.log(
      `  => strongest repeat: ${which} r ${top.r.toFixed(3)} at ${top.lag}px in ${worst.y0}-${worst.y1}` +
        ` — visible periodicity, check what has that spacing`
    );
  } else {
    console.log(`  => no band repeats above r 0.25 on either axis (max ${(top?.r ?? 0).toFixed(3)})`);
  }
}

/**
 * Self-test, because a probe that returns "clean" is worthless until it has
 * been shown to return "dirty" on something known dirty. Two synthetic frames:
 * one with a 23 px stripe pattern, one of pure noise.
 */
function selftest() {
  const w = 400;
  const h = 200;
  const mk = (fn) => {
    const p = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = fn(x, y);
        const i = (y * w + x) * 4;
        p.data[i] = p.data[i + 1] = p.data[i + 2] = v;
        p.data[i + 3] = 255;
      }
    }
    return p;
  };
  const rnd = (() => {
    let s = 1;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  })();
  const striped = mk((x) => 128 + 50 * Math.sin((x / 23) * 2 * Math.PI));
  const noisy = mk(() => 128 + (rnd() - 0.5) * 100);
  fs.writeFileSync("/tmp/_period_striped.png", PNG.sync.write(striped));
  fs.writeFileSync("/tmp/_period_noise.png", PNG.sync.write(noisy));
  console.log("--- expect a strong peak at 23px ---");
  scan("/tmp/_period_striped.png");
  console.log("\n--- expect nothing ---");
  scan("/tmp/_period_noise.png");
}

const files = process.argv.slice(2);
if (files[0] === "--selftest") selftest();
else if (!files.length) {
  console.error("usage: node tools/probe-period.mjs <frame.png ...>   |   --selftest");
  process.exit(2);
} else for (const f of files) scan(f);
