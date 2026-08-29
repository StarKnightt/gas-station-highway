#!/usr/bin/env node
/**
 * Whole-frame hunt for the *veiled* frame, with no region supplied by the
 * caller. The opposite tail of `probe-zeroscan.mjs`, and the same argument.
 *
 *   node tools/probe-washscan.mjs shots/walkprobe/*.png
 *   node tools/probe-washscan.mjs --selftest
 *
 * `zeroscan` looks for a distribution no real object can produce at the dark
 * end: many exact zeros with an empty tail above them. This looks for the one
 * no real scene can produce at the other end — a frame with **no black point**.
 *
 * The signature, and why each part is needed:
 *
 *  - **Black point.** The 0.1th percentile of luma. Any real interior has
 *    somewhere the light does not reach: a shelf underside, a gap behind a
 *    facing, the seam where two boxes meet. If the darkest thousandth of the
 *    frame is a mid-tone, nothing in view is in shadow, which is not a lighting
 *    result, it is something added on top of the whole image.
 *
 *  - **Local contrast, not global.** Global RMS contrast cannot tell a veiled
 *    frame from an honestly uniform one: a photograph of a grey wall has low
 *    global contrast and nothing wrong with it. So this measures the standard
 *    deviation inside each 8x8 tile and takes the median across tiles. A veil
 *    is additive and *scales down every local difference in the frame at once*,
 *    which is a thing lighting does not do. Detail survives dimming; it does
 *    not survive a veil.
 *
 *  - **Both together.** Either alone has honest explanations — a foggy shot has
 *    a high black point, a flat-lit shot has low local contrast. A frame with a
 *    high black point *and* collapsed local contrast *and* a colour cast is a
 *    frame with something in front of the lens.
 *
 *  - **Cast.** Channel means. A veil that is a material rather than an exposure
 *    error carries that material's colour, and the difference between "the
 *    exposure is wrong" and "you are looking through something" is often just
 *    whether R, G and B moved together.
 *
 * Deliberately reports the numbers for every frame rather than only the ones it
 * flags, because the useful reading is nearly always a *comparison* between two
 * frames of the same scene, and a tool that prints only its own verdict makes
 * that comparison impossible. The verdict is a prompt to look, not a finding.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const SELFTEST = args.includes("--selftest");
const files = args.filter((a) => !a.startsWith("--"));

/** Rec. 709 luma, the same weighting the rest of the tools use. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * A frame with no black point. Real interiors reach the single digits.
 *
 * This is the only thresholded criterion, and the restraint is deliberate. The
 * first version also flagged on median 8x8 tile standard deviation below 8,
 * which flagged **every frame in the project including the healthy ones**: a
 * frame containing a lot of sky or asphalt has a low median tile sd by rights,
 * and 8 was a number picked from the synthetic fixture rather than from any
 * real render. A detector that fires on everything has told you nothing, and it
 * is worse than nothing because the one frame that deserved the flag is now in
 * a list of five. Local contrast and cast are still computed and printed, but
 * they are only meaningful **compared against another frame of the same
 * scene**, so they are reported and left to the reader.
 */
const BLACK_POINT_MAX = 24;

function percentile(hist, total, q) {
  let seen = 0;
  const want = total * q;
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return hist.length - 1;
}

export function analyse(png) {
  const { width: W, height: H, data } = png;
  const N = W * H;
  const hist = new Float64Array(256);
  const L = new Float32Array(N);
  let sr = 0;
  let sg = 0;
  let sb = 0;

  for (let i = 0; i < N; i++) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    sr += r;
    sg += g;
    sb += b;
    const y = luma(r, g, b);
    L[i] = y;
    hist[Math.min(255, Math.round(y))]++;
  }

  const p = (q) => percentile(hist, N, q);
  const mean = L.reduce((a, v) => a + v, 0) / N;
  let variance = 0;
  for (let i = 0; i < N; i++) variance += (L[i] - mean) ** 2;
  const globalSd = Math.sqrt(variance / N);

  // Median standard deviation over 8x8 tiles. Detail survives dimming; it does
  // not survive a veil, so this is the number that separates the two.
  const tiles = [];
  for (let ty = 0; ty + 8 <= H; ty += 8) {
    for (let tx = 0; tx + 8 <= W; tx += 8) {
      let s = 0;
      let ss = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = L[(ty + y) * W + tx + x];
          s += v;
          ss += v * v;
        }
      }
      tiles.push(Math.sqrt(Math.max(0, ss / 64 - (s / 64) ** 2)));
    }
  }
  tiles.sort((a, b) => a - b);
  const tileSd = (q) => tiles[Math.min(tiles.length - 1, Math.floor(tiles.length * q))];

  return {
    width: W,
    height: H,
    blackPoint: p(0.001),
    p01: p(0.01),
    p05: p(0.05),
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    whitePoint: p(0.999),
    mean,
    globalSd,
    localSdMedian: tileSd(0.5),
    localSdP90: tileSd(0.9),
    under32: hist.slice(0, 32).reduce((a, v) => a + v, 0) / N,
    over224: hist.slice(224).reduce((a, v) => a + v, 0) / N,
    channelMean: [sr / N, sg / N, sb / N],
    /** Warm cast in luma-equivalent units. Positive is cream, negative is cold. */
    cast: (sr - sb) / N,
  };
}

function verdict(a) {
  const reasons = [];
  if (a.blackPoint > BLACK_POINT_MAX) {
    reasons.push(
      `no black point — darkest 0.1% is luma ${a.blackPoint}, nothing in view is in shadow ` +
        `(local sd ${a.localSdMedian.toFixed(1)}, warm cast ${a.cast >= 0 ? "+" : ""}${a.cast.toFixed(0)})`
    );
  }
  return reasons;
}

function report(label, a) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`\n${label}  ${a.width}x${a.height}`);
  console.log(
    `  luma      black ${String(a.blackPoint).padStart(3)}  p1 ${String(a.p01).padStart(3)}  p5 ${String(a.p05).padStart(3)}` +
      `  p50 ${String(a.p50).padStart(3)}  p95 ${String(a.p95).padStart(3)}  p99 ${String(a.p99).padStart(3)}  white ${String(a.whitePoint).padStart(3)}`
  );
  console.log(
    `  spread    range ${String(a.whitePoint - a.blackPoint).padStart(3)}  global sd ${a.globalSd.toFixed(1).padStart(5)}` +
      `  local sd (median) ${a.localSdMedian.toFixed(1).padStart(5)}  (p90) ${a.localSdP90.toFixed(1).padStart(5)}`
  );
  console.log(
    `  tails     under 32 ${pct(a.under32).padStart(6)}  over 224 ${pct(a.over224).padStart(6)}` +
      `   rgb means ${a.channelMean.map((v) => v.toFixed(1)).join(" / ")}  warm cast ${a.cast >= 0 ? "+" : ""}${a.cast.toFixed(1)}`
  );
  const reasons = verdict(a);
  if (reasons.length) console.log(`  VEILED    ${reasons.join("; ")}`);
  else console.log(`  ok        black point luma ${a.blackPoint} — the frame reaches shadow`);
  return reasons.length;
}

function selftest() {
  // A synthetic textured scene, then the same scene behind an additive veil.
  // The detail has to be *sub-tile*: the first version of this fixture was an
  // 8x8 checkerboard on an 8x8 tile grid, which has zero variance inside every
  // tile and so reported the clean frame as contrastless. The selftest caught
  // it, which is the argument for having one.
  const make = (veil) => {
    const png = new PNG({ width: 256, height: 256 });
    let seed = 12345;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const base = (seed >>> 8) % 200; // full-range per-pixel detail, 0..199
        const v = Math.round(base * (1 - veil) + 235 * veil);
        png.data[i] = v;
        png.data[i + 1] = v;
        png.data[i + 2] = v;
        png.data[i + 3] = 255;
      }
    }
    return png;
  };
  const clear = analyse(make(0));
  const veiled = analyse(make(0.82));
  console.log("[washscan] selftest");
  const a = report("  synthetic, no veil", clear);
  const b = report("  synthetic, 82% veil", veiled);
  const ok = a === 0 && b > 0;
  console.log(`\n[washscan] selftest ${ok ? "PASS" : "FAIL"} — clear frame clean, veiled frame flagged`);
  process.exitCode = ok ? 0 : 1;
}

if (SELFTEST) {
  selftest();
} else if (!files.length) {
  console.error("usage: node tools/probe-washscan.mjs <png...> | --selftest");
  process.exitCode = 2;
} else {
  let flagged = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`missing: ${f}`);
      process.exitCode = 2;
      continue;
    }
    flagged += report(f, analyse(PNG.sync.read(fs.readFileSync(f)))) > 0 ? 1 : 0;
  }
  console.log(`\n[washscan] ${flagged} of ${files.length} frame(s) flagged`);
}
