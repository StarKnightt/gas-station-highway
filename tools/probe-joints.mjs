#!/usr/bin/env node
/**
 * Measure masonry joint contrast, separately for bed (horizontal) and head
 * (vertical) joints, by folding a region at its own dominant period.
 *
 *   node tools/probe-joints.mjs <png> <x,y,w,h> [--tiles 4x3]
 *
 * WHY THIS EXISTS
 *
 * A critic's test for whether coursing carries height information: the joints
 * must NOT look the same under raking light as under flat light. Real CMU
 * joints are strongly light-direction-dependent; a joint painted into the
 * albedo is not. Comparing two elevations by eye is the right test and this
 * makes it a number.
 *
 * WHAT IT MEASURES
 *
 * Within each tile, the mean luma profile is folded at every candidate period
 * from 6 to 64 px and the period with the largest folded amplitude wins. That
 * amplitude, divided by the tile's mean luma, is the joint contrast: a
 * scale-free percentage that survives a change in exposure, which matters
 * because the two frames being compared are lit differently.
 *
 * HOW IT AVOIDS FLATTERING ME
 *
 * It reports every tile, not an aggregate, and the median rather than the best.
 * An agent choosing the coordinates chooses them where the feature it just
 * built is (NOTES.md case 18), and three probes lied in their author's favour
 * on this project in one day. A grid with every cell printed makes a
 * cherry-picked cell visible in the output instead of invisible in the
 * arguments.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const src = args[0];
const rect = args[1];
const tileSpec = (args[args.indexOf("--tiles") + 1] ?? "4x3").split("x").map(Number);
/**
 * Optional period locks in pixels, `--bed 17 --head 34`.
 *
 * Autodetection answers "what is the strongest periodic signal here", which is
 * a different question and on this scene a misleading one: on the front
 * elevation it locks onto the mullion spacing and the bracket stubs at 44-64 px
 * and reports 20-56% contrast that has nothing to do with masonry. When the
 * question is "how strong is the signal at the coursing frequency", the period
 * should come from the geometry - unit size, distance, focal length - and not
 * from the image. The autodetected period is still printed alongside so a lock
 * that disagrees with the image is visible rather than silently assumed.
 */
const lock = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : null;
};
const BED = lock("bed");
const HEAD = lock("head");
if (!src || !rect) {
  console.error("usage: probe-joints.mjs <png> <x,y,w,h> [--tiles CxR]");
  process.exit(2);
}
const [rx, ry, rw, rh] = rect.split(",").map(Number);
const [tc, tr] = tileSpec;

const png = PNG.sync.read(fs.readFileSync(src));
const luma = (x, y) => {
  const i = (y * png.width + x) * 4;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
};

/**
 * Fold `profile` at every period in range and return the strongest.
 * Amplitude is the peak-to-trough of the folded profile, which is what the eye
 * reads as "the joints are visible".
 */
function amplitudeAt(profile, p) {
  if (!p || profile.length / p < 3) return 0;
  const acc = new Float64Array(p);
  const cnt = new Float64Array(p);
  for (let i = 0; i < profile.length; i++) {
    acc[i % p] += profile[i];
    cnt[i % p]++;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p; i++) {
    const v = acc[i] / cnt[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

function dominantPeriod(profile) {
  let best = { period: 0, amp: 0 };
  for (let p = 6; p <= Math.min(64, Math.floor(profile.length / 3)); p++) {
    const acc = new Float64Array(p);
    const cnt = new Float64Array(p);
    for (let i = 0; i < profile.length; i++) {
      acc[i % p] += profile[i];
      cnt[i % p]++;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < p; i++) {
      const v = acc[i] / cnt[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Require several whole periods so a long ramp cannot masquerade as one.
    if (profile.length / p < 3) continue;
    if (hi - lo > best.amp) best = { period: p, amp: hi - lo };
  }
  return best;
}

const tw = Math.floor(rw / tc);
const th = Math.floor(rh / tr);
const bed = [];
const head = [];

console.log(`\n${src}  region ${rect}  tiles ${tc}x${tr} of ${tw}x${th}px`);
console.log(
  `  tile        mean   bed: ${BED ? `@${BED}px` : "auto  "}  contrast   head: ${HEAD ? `@${HEAD}px` : "auto  "}  contrast   (autodetected)`
);

for (let ty = 0; ty < tr; ty++) {
  for (let tx = 0; tx < tc; tx++) {
    const x0 = rx + tx * tw;
    const y0 = ry + ty * th;
    const rows = new Float64Array(th);
    const cols = new Float64Array(tw);
    let sum = 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const l = luma(x0 + x, y0 + y);
        rows[y] += l / tw;
        cols[x] += l / th;
        sum += l;
      }
    }
    const mean = sum / (tw * th);
    const b = dominantPeriod(rows);
    const h = dominantPeriod(cols);
    const bAmp = BED ? amplitudeAt(rows, BED) : b.amp;
    const hAmp = HEAD ? amplitudeAt(cols, HEAD) : h.amp;
    const bc = mean > 1 ? (bAmp / mean) * 100 : 0;
    const hc = mean > 1 ? (hAmp / mean) * 100 : 0;
    bed.push(bc);
    head.push(hc);
    console.log(
      `  ${String(tx)},${String(ty)}      ${mean.toFixed(1).padStart(6)}` +
        `         ${bc.toFixed(2).padStart(6)}%` +
        `            ${hc.toFixed(2).padStart(6)}%` +
        `        bed ${String(b.period).padStart(2)}px head ${String(h.period).padStart(2)}px`
    );
  }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.log(`\n  MEDIAN   bed ${median(bed).toFixed(2)}%   head ${median(head).toFixed(2)}%`);
console.log(`  MAX      bed ${Math.max(...bed).toFixed(2)}%   head ${Math.max(...head).toFixed(2)}%\n`);
