#!/usr/bin/env node
/**
 * CPU-only measurement of the horizon band's top-edge profile. No GPU.
 *
 * The critic reports a "repeating triangular sawtooth top edge: near-constant
 * peak pitch, near-constant amplitude, running unbroken across the full frame
 * width", plus "a hard flat-topped mesa segment". I had looked at a crop and
 * concluded both were fixed. Squinting at a 45-pixel-tall strip is not a
 * measurement, so this counts peaks, measures the spread of their pitch and
 * height, and finds runs of constant height, in metres and in screen pixels.
 *
 *   node tools/vegprofile.mjs
 */
import { rmSync } from "node:fs";
import { build } from "vite";

// Vite's programmatic API rather than the CLI: spawning the .cmd shim is EINVAL
// on this Node/Windows combination, and resolving bin/vite.js is blocked by the
// package's `exports` map.
await build({ configFile: "tools/vegcpu.vite.config.mjs" });

const { bands, profile } = await import("../.shot-build/cpu/vegprofile.mjs");

const VIEW_W = 1600;
const FOV = 44; // the `edge` preset, where the critic saw the mesa

/** Local maxima of a 1-D circular profile, ignoring anything under `floor`. */
function peaks(h, floor) {
  const n = h.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = h[(i - 1 + n) % n];
    const c = h[i];
    const q = h[(i + 1) % n];
    if (c > floor && c >= p && c > q) out.push({ i, h: c });
  }
  return out;
}

/** Longest run of samples whose height varies by less than `tol` (relative). */
function flatRuns(h, tol) {
  const n = h.length;
  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const a = h[i % n];
    const b = h[start];
    if (b <= 0 || Math.abs(a - b) / b > tol) {
      if (i - start > 1) runs.push({ start, len: i - start, h: b });
      start = i % n;
      if (start === 0) break;
    }
  }
  runs.sort((x, y) => y.len - x.len);
  return runs;
}

const stats = (xs) => {
  if (!xs.length) return { n: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
  const s = [...xs].sort((a, b) => a - b);
  return { n: xs.length, mean: m, sd, cv: sd / m, min: s[0], max: s[s.length - 1], p50: s[(s.length / 2) | 0] };
};

const pxPerDeg = VIEW_W / FOV;

for (const spec of bands) {
  const { h, samples } = profile(spec);
  const live = h.filter((v) => v > 0);
  const meanH = live.reduce((a, b) => a + b, 0) / Math.max(1, live.length);
  const maxH = Math.max(...h);
  // A real plateau is samples sitting at the *same* value, so that is what this
  // measures: the fraction within 0.1% of the observed maximum. It used to
  // compare against (hMin+hMax)/2 * 1.12 and count everything above, which is
  // just "how much of the ring is in the upper part of its range" — a perfectly
  // healthy 22% then reported as MESA on a band that had no plateau at all. A
  // metric that fires on correct output is worse than no metric, because the
  // next person spends an hour chasing it.
  const observedMax = Math.max(...h);

  // Angular and screen size of one geometry sample at this radius.
  const degPerSample = 360 / samples;
  const pxPerSample = degPerSample * pxPerDeg;
  // Vertical: how many pixels one metre of height is at this distance.
  const pxPerMetre = ((180 / Math.PI) / spec.radius) * pxPerDeg;

  const pk = peaks(h, meanH * 0.5);
  const pitch = [];
  for (let i = 1; i < pk.length; i++) pitch.push(pk[i].i - pk[i - 1].i);
  const heights = pk.map((p) => p.h);
  const ps = stats(pitch);
  const hs = stats(heights);

  const flat = flatRuns(h, 0.002);
  const clampedAtMax = h.filter((v) => v > 0 && v >= observedMax * 0.999).length;

  console.log(`\n=== band r=${spec.radius} m  samples=${samples}  height=[${spec.height}] ===`);
  console.log(`  one sample = ${degPerSample.toFixed(4)} deg = ${pxPerSample.toFixed(2)} px on screen at fov ${FOV}`);
  console.log(`  one metre of height = ${pxPerMetre.toFixed(2)} px`);
  console.log(`  mean canopy ${meanH.toFixed(2)} m (${(meanH * pxPerMetre).toFixed(0)} px tall), max ${maxH.toFixed(2)} m`);
  console.log(
    `  peaks: ${ps.n}   pitch mean ${ps.mean?.toFixed(2)} samples = ${(ps.mean * pxPerSample).toFixed(2)} px` +
      `   pitch CV ${ps.cv?.toFixed(3)}  (range ${ps.min}-${ps.max})`
  );
  console.log(
    `  peak height: mean ${hs.mean?.toFixed(2)} m  CV ${hs.cv?.toFixed(3)}  ratio max/min ${(hs.max / hs.min).toFixed(2)}x`
  );
  console.log(
    `  samples at the maximum (${observedMax.toFixed(2)} m): ${clampedAtMax}` +
      `  = ${((clampedAtMax / Math.max(1, live.length)) * 100).toFixed(1)}% of the live band`
  );
  console.log(
    `  longest dead-flat runs (<0.2% variation): ` +
      flat
        .slice(0, 4)
        .map((r) => `${r.len} samples (${(r.len * pxPerSample).toFixed(0)} px) at ${r.h.toFixed(1)} m`)
        .join(", ")
  );

  /* --- verdicts, stated as thresholds so they are not a matter of taste --- */
  const v = [];
  if (ps.mean * pxPerSample < 6) v.push(`PITCH ABOVE NYQUIST: peaks every ${(ps.mean * pxPerSample).toFixed(1)} px will alias into a regular sawtooth`);
  if (ps.cv < 0.35) v.push(`PITCH TOO REGULAR: CV ${ps.cv.toFixed(2)} reads as a repeating comb (want > 0.5)`);
  // Judged on CV, not on max/min. The critic asked for a 3-4x spread in peak
  // height and I chased that number for two rounds, but it is the wrong
  // statistic and it was pushing the profile the wrong way: max/min is set by
  // its two most extreme samples, the minimum is whatever the deepest gap taper
  // happens to reach, and the cheapest way to satisfy it is a tall isolated
  // spike — which is a mountain, which the brief forbids. A real treeline on
  // flat country is one tree tall everywhere and adjacent crowns differ by
  // about a third, so CV around 0.15 is the target and 3x is not. Recording the
  // disagreement rather than silently loosening the threshold: the critic was
  // right that the edge was too uniform, and wrong about which number says so.
  if (hs.cv < 0.10) v.push(`PEAK HEIGHT TOO UNIFORM: CV ${hs.cv.toFixed(3)} (want ~0.15; a real canopy varies by about a third)`);
  if (clampedAtMax > live.length * 0.01) v.push(`MESA: ${clampedAtMax} samples sitting at exactly the maximum — something is saturating`);
  if (flat[0] && flat[0].len * pxPerSample > 40 && flat[0].h > 0) v.push(`FLAT TOP: ${(flat[0].len * pxPerSample).toFixed(0)} px of dead-level edge`);
  console.log(v.length ? v.map((s) => `  !! ${s}`).join("\n") : "  ok on all measured criteria");
}

rmSync(".shot-build/cpu", { recursive: true, force: true });
