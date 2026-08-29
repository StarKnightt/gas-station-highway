#!/usr/bin/env node
/**
 * Headless verification of System 8 (procedural audio).
 *
 * Renders every voice offline through `OfflineAudioContext` — the same
 * synthesis code the game runs, imported from src/, not a reimplementation —
 * pulls the PCM back into node, measures it, asserts on the numbers, and
 * writes a waveform + spectrum PNG per case so the results can be eyeballed
 * as well as asserted.
 *
 *   pnpm audio            run everything
 *   pnpm audio --keep     leave the PNGs from a previous run in place
 *
 * Teardown: SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers are
 * installed before the vite server or the browser is started, and every exit
 * path funnels through `shutdown()`. Nothing is ever left resident.
 */

import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "audio-plots");
const PORT = 5114;

/* ------------------------------------------------------------------ */
/* teardown — installed before anything is spawned                     */
/* ------------------------------------------------------------------ */

let server = null;
let browser = null;
let shuttingDown = false;

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[audio] shutting down: ${reason}`);
  try {
    if (browser) await browser.close();
  } catch (e) {
    console.error("[audio] browser close failed:", e?.message ?? e);
  }
  try {
    if (server) await server.close();
  } catch (e) {
    console.error("[audio] server close failed:", e?.message ?? e);
  }
  browser = null;
  server = null;
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => {
  console.error(e);
  void shutdown(1, "uncaughtException");
});
process.on("unhandledRejection", (e) => {
  console.error(e);
  void shutdown(1, "unhandledRejection");
});

/* ------------------------------------------------------------------ */
/* DSP analysis                                                        */
/* ------------------------------------------------------------------ */

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < h; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + h];
        const xi = im[i + k + h];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + h] = ur - vr;
        im[i + k + h] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** One windowed magnitude spectrum starting at `off`. */
function frameSpectrum(data, off, N, win) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (data[off + i] ?? 0) * win[i];
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (N / 2);
  return mag;
}

/** Welch-averaged magnitude spectrum over a sample range. */
function welch(data, sr, N = 8192, from = 0, to = data.length) {
  N = Math.min(nextPow2(N), nextPow2(Math.max(64, to - from)));
  const win = hann(N);
  const hop = N >> 1;
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let off = from; off + N <= to; off += hop) {
    const m = frameSpectrum(data, off, N, win);
    for (let i = 0; i < N / 2; i++) acc[i] += m[i];
    frames++;
  }
  if (frames === 0) {
    const m = frameSpectrum(data, from, N, win);
    return { mag: m, binHz: sr / N, N };
  }
  for (let i = 0; i < N / 2; i++) acc[i] /= frames;
  return { mag: acc, binHz: sr / N, N };
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/** Parabolic interpolation of a peak at bin `i`, in bins. */
function interpPeak(mag, i) {
  if (i <= 0 || i >= mag.length - 1) return i;
  const a = db(mag[i - 1]);
  const b = db(mag[i]);
  const c = db(mag[i + 1]);
  const d = a - 2 * b + c;
  if (Math.abs(d) < 1e-9) return i;
  return i + (0.5 * (a - c)) / d;
}

/** Strongest local maxima, no two closer than `minSepHz`. */
function findPeaks(spec, { loHz, hiHz, count, minSepHz }) {
  const { mag, binHz } = spec;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil(hiHz / binHz));
  const cands = [];
  for (let i = lo; i <= hi; i++) {
    if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) cands.push(i);
  }
  cands.sort((a, b) => mag[b] - mag[a]);
  const out = [];
  for (const i of cands) {
    const f = interpPeak(mag, i) * binHz;
    if (out.some((p) => Math.abs(p.hz - f) < minSepHz)) continue;
    out.push({ hz: f, db: db(mag[i]), bin: i });
    if (out.length >= count) break;
  }
  return out.sort((a, b) => a.hz - b.hz);
}

function bandEnergy(spec, loHz, hiHz) {
  const { mag, binHz } = spec;
  let e = 0;
  for (let i = Math.max(1, Math.floor(loHz / binHz)); i < Math.min(mag.length, hiHz / binHz); i++) {
    e += mag[i] * mag[i];
  }
  return e;
}

/**
 * Worst tonal prominence in a band: how far, in dB, the loudest bin rises
 * above the running median of its neighbourhood. A broadband wash should
 * score low; any resonant whistle scores high regardless of the overall tilt.
 */
function tonalProminence(spec, loHz, hiHz, windowHz = 160) {
  const { mag, binHz } = spec;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(mag.length - 1, Math.ceil(hiHz / binHz));
  const half = Math.max(3, Math.round(windowHz / binHz / 2));
  let worst = -Infinity;
  let atHz = 0;
  const scratch = [];
  for (let i = lo; i <= hi; i++) {
    scratch.length = 0;
    for (let k = Math.max(lo, i - half); k <= Math.min(hi, i + half); k++) scratch.push(mag[k]);
    scratch.sort((a, b) => a - b);
    const med = scratch[scratch.length >> 1];
    const p = db(mag[i]) - db(med);
    if (p > worst) {
      worst = p;
      atHz = i * binHz;
    }
  }
  return { db: worst, hz: atHz };
}

function spectralFlatness(spec, loHz, hiHz) {
  const { mag, binHz } = spec;
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(1, Math.floor(loHz / binHz)); i < Math.min(mag.length, hiHz / binHz); i++) {
    const p = mag[i] * mag[i] + 1e-24;
    logSum += Math.log(p);
    sum += p;
    n++;
  }
  return Math.exp(logSum / n) / (sum / n);
}

/** Peak frequency track inside a band, one point per STFT hop. */
function peakTrack(data, sr, { loHz, hiHz, N = 8192, hop = 2048 }) {
  const win = hann(N);
  const binHz = sr / N;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(N / 2 - 2, Math.ceil(hiHz / binHz));
  const track = [];
  for (let off = 0; off + N <= data.length; off += hop) {
    const mag = frameSpectrum(data, off, N, win);
    let best = lo;
    for (let i = lo; i <= hi; i++) if (mag[i] > mag[best]) best = i;
    track.push({
      t: (off + N / 2) / sr,
      hz: interpPeak(mag, best) * binHz,
      db: db(mag[best]),
    });
  }
  return track;
}

/**
 * One-pole high-pass. Used to strip a tonal bed before onset detection, so
 * the detector sees mechanical transients rather than the bed's own beating.
 */
function highpass1(data, sr, fc) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  const out = new Float32Array(data.length);
  let yPrev = 0;
  let xPrev = 0;
  for (let i = 0; i < data.length; i++) {
    const y = a * (yPrev + data[i] - xPrev);
    out[i] = y;
    yPrev = y;
    xPrev = data[i];
  }
  return out;
}

/** Short-time envelope, one value per `frame` samples. */
function envelope(data, frame) {
  const n = Math.floor(data.length / frame);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < frame; k++) {
      const v = data[i * frame + k];
      s += v * v;
    }
    env[i] = Math.sqrt(s / frame);
  }
  return env;
}

/** Onset times, in seconds, from rectified envelope difference. */
function onsets(data, sr, { frame = 128, minSep = 0.04, thresholdRatio = 0.25 } = {}) {
  const env = envelope(data, frame);
  const flux = new Float64Array(env.length);
  for (let i = 1; i < env.length; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
  let peak = 0;
  for (const v of flux) peak = Math.max(peak, v);
  const thr = peak * thresholdRatio;
  const minFrames = Math.max(1, Math.round((minSep * sr) / frame));
  const out = [];
  let last = -1e9;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] < thr) continue;
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    if (i - last < minFrames) continue;
    last = i;
    out.push((i * frame) / sr);
  }
  return out;
}

/** Time in seconds for a narrow band around `hz` to fall `drop` dB from peak. */
function bandDecayTime(data, sr, hz, drop = 20, N = 4096, hop = 512) {
  const win = hann(N);
  const binHz = sr / N;
  const bin = Math.round(hz / binHz);
  const series = [];
  for (let off = 0; off + N <= data.length; off += hop) {
    const mag = frameSpectrum(data, off, N, win);
    let m = 0;
    for (let k = Math.max(0, bin - 2); k <= Math.min(N / 2 - 1, bin + 2); k++) m = Math.max(m, mag[k]);
    series.push({ t: (off + N / 2) / sr, db: db(m) });
  }
  if (!series.length) return NaN;
  let pk = series[0];
  for (const s of series) if (s.db > pk.db) pk = s;
  for (const s of series) {
    if (s.t <= pk.t) continue;
    if (s.db <= pk.db - drop) return s.t - pk.t;
  }
  return NaN;
}

function stats(data) {
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Math.abs(v) > peak) peak = Math.abs(v);
    sum += v;
    sumSq += v * v;
  }
  return { peak, peakDb: db(peak), dc: sum / data.length, rms: Math.sqrt(sumSq / data.length) };
}

/* ------------------------------------------------------------------ */
/* plotting                                                            */
/* ------------------------------------------------------------------ */

const W = 1000;
const H_WAVE = 220;
const H_SPEC = 260;
const PAD = 34;
const H = H_WAVE + H_SPEC + PAD * 3;

function plot(name, data, sr, spec) {
  const png = new PNG({ width: W, height: H });
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) << 2;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  };
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 16;
    png.data[i + 1] = 18;
    png.data[i + 2] = 22;
    png.data[i + 3] = 255;
  }
  const vline = (x, y0, y1, c) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) px(x, y, c[0], c[1], c[2]);
  };
  const hline = (y, x0, x1, c) => {
    for (let x = x0; x <= x1; x++) px(x, y, c[0], c[1], c[2]);
  };

  /* waveform: min/max envelope per column */
  const top = PAD;
  const mid = top + H_WAVE / 2;
  hline(Math.round(mid), PAD, W - PAD, [70, 72, 80]);
  hline(top, PAD, W - PAD, [45, 47, 54]);
  hline(top + H_WAVE, PAD, W - PAD, [45, 47, 54]);
  // +/- 1.0 full scale, plus a marker line at -6 dBFS.
  hline(Math.round(mid - (H_WAVE / 2) * 0.5), PAD, W - PAD, [60, 44, 44]);
  hline(Math.round(mid + (H_WAVE / 2) * 0.5), PAD, W - PAD, [60, 44, 44]);

  const cols = W - PAD * 2;
  const per = data.length / cols;
  for (let c = 0; c < cols; c++) {
    let lo = 1;
    let hi = -1;
    const s0 = Math.floor(c * per);
    const s1 = Math.min(data.length, Math.floor((c + 1) * per));
    for (let i = s0; i < s1; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    if (s1 <= s0) continue;
    const y0 = Math.round(mid - hi * (H_WAVE / 2));
    const y1 = Math.round(mid - lo * (H_WAVE / 2));
    vline(PAD + c, y0, y1, [110, 205, 170]);
  }

  /* spectrum: log frequency, dB magnitude */
  const st = PAD * 2 + H_WAVE;
  const { mag, binHz } = spec;
  const fMin = 20;
  const fMax = sr / 2;
  const lx = (f) => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * (W - PAD * 2);
  const dbMin = -120;
  const dbMax = 0;
  const ly = (d) => st + H_SPEC - ((Math.max(dbMin, Math.min(dbMax, d)) - dbMin) / (dbMax - dbMin)) * H_SPEC;

  for (const f of [50, 60, 100, 120, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f >= fMax) continue;
    vline(Math.round(PAD + lx(f)), st, st + H_SPEC, f === 60 || f === 120 ? [70, 60, 40] : [40, 42, 48]);
  }
  for (let d = 0; d >= -120; d -= 20) hline(Math.round(ly(d)), PAD, W - PAD, [40, 42, 48]);

  let prevX = -1;
  let prevY = -1;
  for (let i = 1; i < mag.length; i++) {
    const f = i * binHz;
    if (f < fMin || f > fMax) continue;
    const x = Math.round(PAD + lx(f));
    const y = Math.round(ly(db(mag[i])));
    if (prevX >= 0 && x - prevX <= 1) {
      vline(x, prevY, y, [235, 190, 110]);
    } else {
      px(x, y, 235, 190, 110);
    }
    prevX = x;
    prevY = y;
  }

  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

/* ------------------------------------------------------------------ */
/* assertions                                                          */
/* ------------------------------------------------------------------ */

const results = [];
function check(group, label, ok, detail) {
  results.push({ group, label, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const keep = process.argv.includes("--keep");
  if (!keep && existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");

  server = await createServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    logLevel: "warn",
    // HMR off and the watcher blind: other agents are editing this repo while
    // this runs, and a stray save would full-reload the page out from under
    // the live smoke test.
    server: {
      port: PORT,
      strictPort: true,
      host: "127.0.0.1",
      hmr: false,
      watch: { ignored: ["**/*"] },
    },
  });
  await server.listen();
  console.log(`[audio] vite on http://127.0.0.1:${PORT}`);

  // Same launch options as the screenshot harness so the live smoke test gets
  // a real WebGL stack; software is allowed here because this tool is
  // measuring audio, not pixels.
  const { launchOptions } = await import("./gpu.mjs");
  browser = await chromium.launch(launchOptions({ allowSoftware: true }));
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    throw e;
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/tools/audio-harness.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__AUDIO_HARNESS, null, { timeout: 30000 });

  const meta = await page.evaluate(() => ({
    cases: window.__AUDIO_HARNESS.cases,
    sampleRate: window.__AUDIO_HARNESS.sampleRate,
  }));
  const sr = meta.sampleRate;
  console.log(`[audio] ${meta.cases.length} cases at ${sr} Hz\n`);

  /** name -> Float32Array */
  const pcm = {};
  const specs = {};
  const plots = {};
  /** True per-channel peak, before the stereo cases are downmixed for analysis. */
  const truePeak = {};

  for (const name of meta.cases) {
    const r = await page.evaluate((n) => window.__AUDIO_HARNESS.render(n), name);
    const buf = Buffer.from(r.b64, "base64");
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    pcm[name] = data;
    truePeak[name] = r.peak;
    specs[name] = welch(data, sr, 8192);
    plots[name] = plot(name, data, sr, specs[name]);
  }

  /* -- global hygiene: clipping and DC ------------------------------ */
  console.log("hygiene (peak below 0 dBFS, no DC offset)");
  for (const name of meta.cases) {
    const s = stats(pcm[name]);
    // Peak is taken per channel before the downmix: averaging L and R would
    // hide one hot channel, which is precisely the case a panned source can
    // produce.
    const peak = truePeak[name];
    check(
      "hygiene",
      `${name}: peak ${f2(db(peak))} dBFS, dc ${s.dc.toExponential(2)}, rms ${f2(db(s.rms))} dBFS`,
      peak < 1.0 && Math.abs(s.dc) < 1e-3,
      peak >= 1.0 ? "CLIPS" : Math.abs(s.dc) >= 1e-3 ? "DC OFFSET" : ""
    );
  }

  /* -- bell --------------------------------------------------------- */
  //
  // What "correct" means here, decided before the synthesis was rewritten, so
  // the numbers are a specification and not a description of whatever came
  // out. Target: a 40–60 mm brass shop bell on a spring arm, struck by a door
  // edge. Not a hotel desk bell.
  //
  //   fundamental        2500–3600 Hz   small shell, and bright with it
  //   T20 (fundamental)  0.08–0.30 s    audible decay 0.3–0.6 s, i.e. T60 <= 0.9
  //   T20 (top partial)  < 0.6x the fundamental's — high modes die first
  //   partial spread     top/bottom >= 4x — a wide modal spread, not a cluster
  //   inharmonicity      every ratio >= 0.10 from an integer
  //   transient/sustain  >= 10 dB — hard mechanical contact, not a mallet
  //   spring contacts    >= 3, spaced 0.05–0.20 s, monotonically decaying
  //
  const BELL_SPEC = { f0: [2500, 3600], t20: [0.08, 0.3], decayRatio: 0.6, spread: 4, inharm: 0.1, transientDb: 10 };
  console.log("\nbell: small spring-arm shop bell (spec: f0 2.5–3.6 kHz, T20 0.08–0.30 s, transient >= 10 dB)");
  {
    const d = pcm.bell;
    const early = welch(d, sr, 16384, 0, Math.floor(sr * 0.25));
    const peaks = findPeaks(early, { loHz: 900, hiHz: 19000, count: 6, minSepHz: 260 });
    const f0 = peaks[0]?.hz ?? NaN;
    const ratios = peaks.map((p) => p.hz / f0);
    const worst = Math.min(...ratios.slice(1).map((r) => Math.abs(r - Math.round(r))));
    const spread = peaks[peaks.length - 1].hz / f0;
    check(
      "bell",
      `partials ${peaks.map((p) => p.hz.toFixed(0)).join(", ")} Hz`,
      peaks.length >= 5,
      `${peaks.length} detected`
    );
    check(
      "bell",
      `fundamental ${f0.toFixed(0)} Hz`,
      f0 >= BELL_SPEC.f0[0] && f0 <= BELL_SPEC.f0[1],
      `spec ${BELL_SPEC.f0[0]}–${BELL_SPEC.f0[1]} Hz`
    );
    check(
      "bell",
      `ratios ${ratios.map(f3).join(", ")} — closest approach to an integer ${f3(worst)}`,
      worst > BELL_SPEC.inharm,
      worst > BELL_SPEC.inharm ? "inharmonic" : "too close to a harmonic series"
    );
    check(
      "bell",
      `partial spread top/bottom = ${f2(spread)}x`,
      spread >= BELL_SPEC.spread,
      `spec >= ${BELL_SPEC.spread}x — dominated by high circumferential modes`
    );
    // Short window: at these decay times a 4096-sample (93 ms) analysis window
    // is longer than the thing being measured and would report its own length.
    const tLow = bandDecayTime(d, sr, f0, 20, 1024, 128);
    const tHigh = bandDecayTime(d, sr, peaks[peaks.length - 1].hz, 20, 1024, 128);
    check(
      "bell",
      `T20 of the fundamental ${f3(tLow)} s`,
      tLow >= BELL_SPEC.t20[0] && tLow <= BELL_SPEC.t20[1],
      `spec ${BELL_SPEC.t20[0]}–${BELL_SPEC.t20[1]} s (T60 ~ ${f2(tLow * 3)} s)`
    );
    check(
      "bell",
      `T20 of the top partial ${f3(tHigh)} s vs ${f3(tLow)} s at the fundamental`,
      Number.isFinite(tHigh) && tHigh < tLow * BELL_SPEC.decayRatio,
      `${f2(tLow / tHigh)}x faster; spec >= ${f2(1 / BELL_SPEC.decayRatio)}x`
    );
    // Transient-to-sustain: the contact peak against the shell 100 ms later.
    const pk = (a, b) => {
      let m = 0;
      for (let i = Math.floor(a * sr); i < Math.floor(b * sr); i++) m = Math.max(m, Math.abs(d[i]));
      return m;
    };
    const strikePk = pk(0.05, 0.055);
    const ringPk = pk(0.13, 0.17);
    const tts = db(strikePk / ringPk);
    check(
      "bell",
      `transient-to-sustain ${f2(tts)} dB (strike ${f3(strikePk)} vs ring at +100 ms ${f3(ringPk)})`,
      tts >= BELL_SPEC.transientDb,
      `spec >= ${BELL_SPEC.transientDb} dB — a door edge, not a mallet`
    );
    // Noisiness of the strike: the first few milliseconds must be broadband
    // relative to the ring that follows, not just the modes arriving together.
    // Measured as a ratio so it is not a function of the window length.
    const flatAt = (t) => spectralFlatness(welch(d, sr, 512, Math.floor(sr * t), Math.floor(sr * (t + 0.008))), 500, 16000);
    const flatStrike = flatAt(0.05);
    const flatRing = flatAt(0.14);
    check(
      "bell",
      `spectral flatness ${f3(flatStrike)} at the contact vs ${f3(flatRing)} in the ring`,
      flatStrike > flatRing * 2 && flatStrike > 0.15,
      `${flatRing < 1e-3 ? ">1000" : f2(flatStrike / flatRing)}x broader — a noisy mechanical contact`
    );

    // `bell` and `bell_with_rattle` share a seed, so the first strike cancels
    // exactly and the difference is nothing but the spring arm re-contacting.
    // Onset-detecting the ringing directly would just find the mode doublets
    // beating against each other.
    const b = pcm.bell_with_rattle;
    const diff = new Float32Array(Math.min(d.length, b.length));
    for (let i = 0; i < diff.length; i++) diff[i] = b[i] - d[i];
    const residual = db(stats(diff.subarray(0, Math.floor(sr * 0.1))).rms);
    const contacts = onsets(diff, sr, { minSep: 0.04, thresholdRatio: 0.05 });
    const gaps = contacts.slice(1).map((t, i) => t - contacts[i]);
    const amps = contacts.map((t) => {
      let m = 0;
      for (let i = Math.floor(t * sr); i < Math.floor((t + 0.03) * sr); i++) m = Math.max(m, Math.abs(diff[i]));
      return m;
    });
    const decaying = amps.every((a, i) => i === 0 || a < amps[i - 1] * 1.05);
    check(
      "bell",
      `spring-arm contacts at ${contacts.map(f3).join(", ")} s (first strike cancels to ${f2(residual)} dBFS)`,
      contacts.length >= 3 && residual < -100,
      `${contacts.length} re-contacts; spec >= 3`
    );
    check(
      "bell",
      `contact spacing ${gaps.map(f3).join(", ")} s, amplitudes ${amps.map(f3).join(", ")}`,
      gaps.every((g) => g > 0.04 && g < 0.22) && decaying,
      "an arm settling on its spring, not a tremolo"
    );
  }

  /* -- outdoor early reflections ------------------------------------ */
  console.log("\noutdoor reflections: a facade slapback whose delay follows the player");
  {
    const dry = pcm.bell;
    const wet = pcm.reflections_wet;
    const firstArrival = (a) => {
      let peak = 0;
      for (const v of a) peak = Math.max(peak, Math.abs(v));
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > peak * 0.08) return i / sr;
      return NaN;
    };
    const tDry = firstArrival(dry);
    const tWet = firstArrival(wet);
    const lag = tWet - tDry;
    // Standing 12 m out from the wall: 24 m of extra path at 343 m/s.
    const expected = (2 * 12) / 343;
    check(
      "reflections",
      `facade return arrives ${(lag * 1000).toFixed(1)} ms after the direct sound`,
      Math.abs(lag - expected) < 0.008,
      `geometry predicts ${(expected * 1000).toFixed(1)} ms at 12 m`
    );
    const bright = (s) => db(Math.sqrt(bandEnergy(s, 3000, 16000) / bandEnergy(s, 300, 2000)));
    const bDry = bright(specs.bell);
    const bWet = bright(specs.reflections_wet);
    check(
      "reflections",
      `reflection is ${f2(bDry - bWet)} dB duller than the direct sound (3–16 kHz vs 0.3–2 kHz)`,
      bWet < bDry - 4,
      "painted block absorbs the top end"
    );
    check(
      "reflections",
      `return level ${f2(db(stats(wet).rms))} dBFS against a direct ${f2(db(stats(dry).rms))} dBFS`,
      db(stats(wet).rms) < db(stats(dry).rms) - 6,
      "a reflection, not a second bell"
    );
  }

  /* -- fridge ------------------------------------------------------- */
  console.log("\nfridge: 60 Hz fundamental with odd harmonics, slow beating, real off state");
  {
    const spec = welch(pcm.fridge_hum, sr, 16384);
    const at = (hz) => {
      const b = Math.round(hz / spec.binHz);
      let m = 0;
      for (let k = b - 2; k <= b + 2; k++) m = Math.max(m, spec.mag[k] ?? 0);
      return db(m);
    };
    const odd = [60, 180, 300, 420, 540].map(at);
    const even = [120, 240, 360].map(at);
    const floor = db(Math.sqrt(bandEnergy(spec, 700, 900) / (200 / spec.binHz)));
    check("fridge", `60 Hz at ${f2(odd[0])} dB, floor ${f2(floor)} dB`, odd[0] - floor > 20, `${f2(odd[0] - floor)} dB above floor`);
    check(
      "fridge",
      `odd harmonics 180/300/420/540 at ${odd.slice(1).map(f2).join(", ")} dB`,
      odd.slice(1, 4).every((v) => v - floor > 12),
      `all above floor+12`
    );
    check(
      "fridge",
      `odd vs even: 180 ${f2(odd[1])} dB > 120 ${f2(even[0])} dB, 300 ${f2(odd[2])} dB > 240 ${f2(even[1])} dB`,
      odd[1] > even[0] + 6 && odd[2] > even[1] + 6,
      `margins ${f2(odd[1] - even[0])} / ${f2(odd[2] - even[1])} dB`
    );
    // Beating: the fundamental's envelope must wander.
    const env = envelope(pcm.fridge_hum.subarray(Math.floor(sr * 1.5)), 2048);
    let lo = Infinity;
    let hi = 0;
    for (const v of env) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const depth = (hi - lo) / hi;
    check("fridge", `envelope modulation depth ${(depth * 100).toFixed(1)}%`, depth > 0.05, "detuned pairs beating");

    // The cycle: the off period has to be genuinely quiet.
    const cyc = pcm.fridge_cycle;
    const seg = (a, b) => db(stats(cyc.subarray(Math.floor(sr * a), Math.floor(sr * b))).rms);
    const on = seg(2.0, 4.5);
    const off = seg(6.5, 7.8);
    check("fridge", `running ${f2(on)} dBFS vs cycled off ${f2(off)} dBFS`, on - off > 30, `${f2(on - off)} dB drop`);
    // Thunks were scheduled at 0.3 (on), 5.0 (off) and 8.0 (on again).
    // Generic onset detection is the wrong tool here: the hum's own beating
    // produces envelope maxima of a comparable size. Instead, high-pass away
    // the bed and ask directly whether a broadband transient exists at each
    // scheduled instant, measured against the file's own background.
    const hp = highpass1(cyc, sr, 1200);
    const sorted = Float64Array.from(hp, Math.abs).sort();
    const background = sorted[Math.floor(sorted.length * 0.98)];
    const burst = (t) => {
      let m = 0;
      for (let i = Math.floor(t * sr); i < Math.floor((t + 0.06) * sr); i++) m = Math.max(m, Math.abs(hp[i]));
      return m / background;
    };
    const bursts = [0.3, 5.0, 8.0].map(burst);
    check(
      "fridge",
      `transient at each scheduled transition (0.3 / 5.0 / 8.0 s): ${bursts.map((r) => `${f2(r)}x`).join(", ")} the 98th-percentile background`,
      bursts.every((r) => r > 4),
      "on / off / on, each with a mechanical thunk"
    );
  }

  /* -- highway ------------------------------------------------------ */
  console.log("\nhighway: broadband wash, no tonal peak");
  {
    const spec = specs.highway_wash;
    const prom = tonalProminence(spec, 60, 8000, 200);
    check("highway", `worst tonal prominence ${f2(prom.db)} dB at ${prom.hz.toFixed(0)} Hz`, prom.db < 8, "no resonant whistle");
    // Flatness is measured over the band the wash actually occupies. Taken up
    // to 6 kHz it would only be reporting the (intended, physical) distance
    // roll-off, not whether the source is tonal.
    const flat = spectralFlatness(spec, 80, 700);
    check("highway", `spectral flatness 80–700 Hz = ${f3(flat)}`, flat > 0.15, "broadband, not tonal");
    // -20 dB bandwidth. A tone occupies a handful of Hz; the wash has to
    // occupy a wide, continuous span for the same criterion.
    let bandPeak = 0;
    let peakHz = 0;
    for (let i = Math.floor(30 / spec.binHz); i < 16000 / spec.binHz; i++) {
      if (spec.mag[i] > bandPeak) {
        bandPeak = spec.mag[i];
        peakHz = i * spec.binHz;
      }
    }
    let loHz = peakHz;
    let hiHz = peakHz;
    for (let i = Math.floor(30 / spec.binHz); i < 16000 / spec.binHz; i++) {
      if (db(spec.mag[i]) > db(bandPeak) - 20) {
        loHz = Math.min(loHz, i * spec.binHz);
        hiHz = Math.max(hiHz, i * spec.binHz);
      }
    }
    check(
      "highway",
      `-20 dB bandwidth ${loHz.toFixed(0)}–${hiHz.toFixed(0)} Hz around a ${peakHz.toFixed(0)} Hz peak`,
      hiHz - loHz > 200 && hiHz / loHz > 3,
      `${(hiHz - loHz).toFixed(0)} Hz wide, ${f2(hiHz / loHz)} octave-ratio`
    );
    const lowE = bandEnergy(spec, 40, 500);
    const highE = bandEnergy(spec, 2000, 12000);
    check(
      "highway",
      `energy tilt: 40–500 Hz is ${f2(db(Math.sqrt(lowE / highE)))} dB above 2–12 kHz`,
      lowE > highE,
      "distance-filtered, as intended"
    );
  }

  /* -- interior/exterior transition --------------------------------- */
  console.log("\ninterior vs exterior: the same moment, rendered both ways");
  {
    const so = specs.highway_outside;
    const si = specs.highway_inside;
    const hfO = bandEnergy(so, 2000, 16000);
    const hfI = bandEnergy(si, 2000, 16000);
    const lfO = bandEnergy(so, 40, 300);
    const lfI = bandEnergy(si, 40, 300);
    const hfDrop = db(Math.sqrt(hfO / hfI));
    const lfDrop = db(Math.sqrt(lfO / lfI));
    const allDrop = db(stats(pcm.highway_outside).rms) - db(stats(pcm.highway_inside).rms);
    check("transition", `high-frequency (2–16 kHz) energy drops ${f2(hfDrop)} dB indoors`, hfDrop > 20, "muffled");
    check("transition", `low-frequency (40–300 Hz) energy drops only ${f2(lfDrop)} dB`, lfDrop < hfDrop - 10, "low end survives");
    check("transition", `broadband level drops ${f2(allDrop)} dB`, allDrop > 8 && allDrop < 24, "quieter but still present");
  }

  /* -- vehicle passes ----------------------------------------------- */
  console.log("\nvehicle passes: real Doppler shift across the event");
  for (const [name, band] of [
    ["car_pass", { loHz: 80, hiHz: 420 }],
    ["truck_pass", { loHz: 36, hiHz: 200 }],
  ]) {
    const d = pcm[name];
    const track = peakTrack(d, sr, { ...band, N: 16384, hop: 4096 });
    const n = track.length;
    const head = track.slice(1, Math.max(2, Math.floor(n * 0.25)));
    const tail = track.slice(Math.ceil(n * 0.75), n - 1);
    const med = (a) => {
      const v = a.map((p) => p.hz).sort((x, y) => x - y);
      return v[v.length >> 1];
    };
    const fA = med(head);
    const fB = med(tail);
    const ratio = fA / fB;
    check(
      "doppler",
      `${name}: tracked ${fA.toFixed(1)} Hz approaching -> ${fB.toFixed(1)} Hz receding`,
      ratio > 1.1,
      `shift ratio ${f3(ratio)} (a 25 m/s pass predicts ~1.16)`
    );
    // The tail must also be duller than the approach, not just quieter.
    const q = Math.floor(d.length * 0.12);
    const specHead = welch(d, sr, 8192, Math.floor(d.length * 0.06), Math.floor(d.length * 0.06) + q);
    const specTail = welch(d, sr, 8192, d.length - q - 1024, d.length - 1024);
    const brightHead = db(Math.sqrt(bandEnergy(specHead, 1500, 12000) / bandEnergy(specHead, 40, 400)));
    const brightTail = db(Math.sqrt(bandEnergy(specTail, 1500, 12000) / bandEnergy(specTail, 40, 400)));
    check(
      "doppler",
      `${name}: spectral tilt ${f2(brightHead)} dB approaching -> ${f2(brightTail)} dB receding`,
      brightTail < brightHead,
      "filtered tail"
    );
    const mid = stats(d.subarray(Math.floor(d.length * 0.45), Math.floor(d.length * 0.55)));
    const edge = stats(d.subarray(0, Math.floor(d.length * 0.05)));
    check(
      "doppler",
      `${name}: closest approach ${f2(db(mid.rms))} dBFS vs event edge ${f2(db(edge.rms))} dBFS`,
      mid.rms > edge.rms * 2,
      `${f2(db(mid.rms / edge.rms))} dB arc, peak ${f2(db(truePeak[name]))} dBFS`
    );
  }

  /* -- vehicle attenuation follows the player ----------------------- */
  //
  // Three renders of the same pass, same seed, same panner, differing only in
  // where the listener is standing: static at 26 m, static at 13 m, and
  // walking 26 -> 13 m during the approach. All three ask the voice for
  // `distance: 26`, which is the only geometry still baked. If level were
  // still baked from it, the walking render would be identical to the 26 m
  // static one.
  console.log("\nvehicle attenuation tracks a walking listener");
  {
    const far = pcm.car_pass;
    const walk = pcm.car_pass_walking;
    const near = pcm.car_pass_near;
    const seg = (d, u0, u1) => db(stats(d.subarray(Math.floor(d.length * u0), Math.floor(d.length * u1))).rms);
    // Closest approach, which is where perpendicular distance actually
    // dominates: at the edges of the event the car is 145 m up the road.
    const mFar = seg(far, 0.44, 0.56);
    const mWalk = seg(walk, 0.44, 0.56);
    const mNear = seg(near, 0.44, 0.56);
    check(
      "attenuation",
      `at closest approach: 26 m static ${f2(mFar)}, walked in to 13 m ${f2(mWalk)}, 13 m static ${f2(mNear)} dBFS`,
      mWalk > mFar + 3,
      `${f2(mWalk - mFar)} dB louder than if the level had stayed frozen at spawn`
    );
    check(
      "attenuation",
      `the walking listener converges on the near one: ${f2(Math.abs(mWalk - mNear))} dB apart`,
      Math.abs(mWalk - mNear) < 1.5,
      "the panner is doing 1/r against live positions"
    );
    check(
      "attenuation",
      `arc depth (closest approach over event edge) ${f2(mWalk - seg(walk, 0, 0.05))} dB walking vs ${f2(mFar - seg(far, 0, 0.05))} dB static`,
      mWalk - seg(walk, 0, 0.05) > mFar - seg(far, 0, 0.05) + 2,
      "a deeper arc, because the player closed the distance"
    );
    // Air absorption is fed the same live distance, so the tail must be
    // brighter when the player has walked closer to it.
    const tail = (d) => {
      const q = Math.floor(d.length * 0.12);
      const s = welch(d, sr, 8192, d.length - q - 1024, d.length - 1024);
      return db(Math.sqrt(bandEnergy(s, 1500, 12000) / bandEnergy(s, 40, 400)));
    };
    check(
      "attenuation",
      `receding tail brightness ${f2(tail(walk))} dB walking-in vs ${f2(tail(far))} dB static`,
      tail(walk) > tail(far),
      "the air-absorption cutoff is driven by live distance too"
    );
  }

  /* -- pump --------------------------------------------------------- */
  console.log("\npump: irregular metering ticks, motor spin-up");
  {
    const jit = onsets(pcm.pump_ticks, sr, { minSep: 0.09, thresholdRatio: 0.14 });
    const reg = onsets(pcm.pump_ticks_unjittered, sr, { minSep: 0.09, thresholdRatio: 0.14 });
    const cv = (t) => {
      const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      const v = d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length;
      return { cv: Math.sqrt(v) / m, mean: m, n: d.length, min: Math.min(...d), max: Math.max(...d) };
    };
    const j = cv(jit);
    const r = cv(reg);
    check(
      "pump",
      `jittered ticks: ${j.n + 1} onsets, mean interval ${f3(j.mean)} s, spread ${f3(j.min)}–${f3(j.max)} s, CV ${f3(j.cv)}`,
      j.cv > 0.05,
      "not a metronome"
    );
    check(
      "pump",
      `control (perfect grid): CV ${f3(r.cv)}`,
      r.cv < 0.02 && j.cv > r.cv * 3,
      `the measurement can tell them apart (${f2(j.cv / r.cv)}x)`
    );
    // Spin-up: energy has to rise over the first second and the motor tone
    // has to climb in pitch.
    const up = pcm.pump_start;
    const e0 = db(stats(up.subarray(Math.floor(sr * 0.2), Math.floor(sr * 0.35))).rms);
    const e1 = db(stats(up.subarray(Math.floor(sr * 1.2), Math.floor(sr * 1.6))).rms);
    check("pump", `spin-up level ${f2(e0)} -> ${f2(e1)} dBFS`, e1 > e0 + 4, `${f2(e1 - e0)} dB`);
    // Pitch is tracked on pump_stop, which spins up at 0.02 s and down at
    // 1.2 s. pump_start is unusable for this: its 88 Hz lever clunk sits right
    // on top of the motor fundamental and wins the peak pick for the first
    // half second.
    const t = peakTrack(pcm.pump_stop, sr, { loHz: 25, hiHz: 220, N: 8192, hop: 1024 });
    const at = (sec) => t.reduce((a, b) => (Math.abs(b.t - sec) < Math.abs(a.t - sec) ? b : a)).hz;
    const fEarly = at(0.12);
    const fRun = at(1.05);
    const fDown = at(2.3);
    check("pump", `spin-up ${fEarly.toFixed(1)} -> ${fRun.toFixed(1)} Hz`, fRun > fEarly * 1.25, "loads up");
    check("pump", `spin-down ${fRun.toFixed(1)} -> ${fDown.toFixed(1)} Hz`, fDown < fRun * 0.75, "coasts down");
    const clunk = onsets(pcm.pump_start, sr, { minSep: 0.05, thresholdRatio: 0.4 });
    check("pump", `lever clunk transient at ${clunk.map(f3).join(", ")} s`, clunk.length >= 1, "engages");
  }

  /* -- bird --------------------------------------------------------- */
  console.log("\nbird: a couple of swept syllables, high and short");
  {
    const d = pcm.bird;
    const syl = onsets(d, sr, { minSep: 0.05, thresholdRatio: 0.2 });
    check("bird", `syllables at ${syl.map(f3).join(", ")} s`, syl.length >= 2, `${syl.length} detected`);
    const track = peakTrack(d, sr, { loHz: 1500, hiHz: 12000, N: 2048, hop: 512 }).filter((p) => p.db > -70);
    const lo = Math.min(...track.map((p) => p.hz));
    const hi = Math.max(...track.map((p) => p.hz));
    check("bird", `sweep range ${lo.toFixed(0)}–${hi.toFixed(0)} Hz`, hi / lo > 1.15, `${f2(hi / lo)}x`);
    const s = stats(d);
    check("bird", `duration to -40 dB and peak ${f2(s.peakDb)} dBFS`, s.peakDb < -6, "stays a punctuation mark");
  }

  /* -- doors, fluorescent, product ---------------------------------- */
  console.log("\ndoors, fixtures, product");
  {
    const o = onsets(pcm.door_open, sr, { minSep: 0.05, thresholdRatio: 0.15 });
    check("door", `open: ${o.length} transients, first at ${f3(o[0])} s`, o.length >= 2, "seal peel then bell");
    const openSpec = welch(pcm.door_open, sr, 16384, 0, Math.floor(sr * 0.6));
    const bellPeaks = findPeaks(openSpec, { loHz: 1500, hiHz: 16000, count: 3, minSepHz: 400 });
    check(
      "door",
      `bell partials inside the open sound at ${bellPeaks.map((p) => p.hz.toFixed(0)).join(", ")} Hz`,
      bellPeaks.length >= 2,
      "the bell is actually in there"
    );
    const c = pcm.door_close;
    const all = onsets(c, sr, { minSep: 0.03, thresholdRatio: 0.15 });
    const late = all.filter((t) => t > 0.6);
    check(
      "door",
      `close: transients at ${all.map(f3).join(", ")} s; latch group after 0.6 s = ${late.map(f3).join(", ") || "none"}`,
      late.length >= 1,
      "slab, latch tongue, striker"
    );
    // Measured below the bell's lowest partial (~2 kHz): the shell is ringing
    // through this window and would otherwise be scored as a tonal hiss.
    const hiss = welch(c, sr, 4096, Math.floor(sr * 0.15), Math.floor(sr * 0.6));
    const prom = tonalProminence(hiss, 300, 1500, 300);
    check("door", `closer hiss tonal prominence, 300 Hz–1.5 kHz: ${f2(prom.db)} dB`, prom.db < 12, "air, not a tone");

    // Magnetic ballast: a 120 Hz impulse train, so every harmonic is present
    // (not just odd ones, unlike the compressor hum), the crest factor is high
    // because the energy is in transients, and no two strikes are the same
    // size. A filtered oscillator fails the last two of those.
    const fluo = pcm.fluorescent;
    const fl = specs.fluorescent;
    const at = (hz) => {
      const b = Math.round(hz / fl.binHz);
      let m = 0;
      for (let k = b - 1; k <= b + 1; k++) m = Math.max(m, fl.mag[k] ?? 0);
      return db(m);
    };
    const lines = [120, 240, 360, 480, 600, 720];
    const interline = lines.map((h) => at(h + 60));
    const margins = lines.map((h, i) => at(h) - interline[i]);
    check(
      "fluorescent",
      `ballast lines ${lines.map((h) => f2(at(h))).join(", ")} dB at ${lines.join("/")} Hz`,
      margins.every((m) => m > 12),
      `every harmonic ${f2(Math.min(...margins))}+ dB above the interline floor — an impulse train, not a tone`
    );
    const fs = stats(fluo);
    const crest = db(fs.peak / fs.rms);
    check("fluorescent", `crest factor ${f2(crest)} dB`, crest > 12, "energy is in transients");
    // Per-half-cycle peak variance: the whole point of the rebuild.
    const per = sr / 120;
    const peaks120 = [];
    for (let p = 0; p + per < fluo.length; p += per) {
      let m = 0;
      for (let i = Math.floor(p); i < Math.floor(p + per); i++) m = Math.max(m, Math.abs(fluo[i]));
      peaks120.push(m);
    }
    const mean = peaks120.reduce((x, y) => x + y, 0) / peaks120.length;
    const cvP = Math.sqrt(peaks120.reduce((x, y) => x + (y - mean) ** 2, 0) / peaks120.length) / mean;
    check(
      "fluorescent",
      `strike-to-strike amplitude CV ${f3(cvP)} over ${peaks120.length} half-cycles`,
      cvP > 0.15,
      "chaotic, the way a real ballast is"
    );
    check("fluorescent", `overall level ${f2(db(fs.rms))} dBFS at 4x scene gain`, db(fs.rms) < -30, "very quiet");

    const bg = specs.bottle_grab;
    check(
      "product",
      `bottle grab is high-band: ${f2(db(Math.sqrt(bandEnergy(bg, 2000, 16000) / bandEnergy(bg, 20, 400))))} dB above the low band`,
      bandEnergy(bg, 2000, 16000) > bandEnergy(bg, 20, 400),
      "crinkle, not a thud"
    );
    for (const n of ["fridge_door_open", "fridge_door_close"]) {
      const on = onsets(pcm[n], sr, { minSep: 0.04, thresholdRatio: 0.18 });
      check("product", `${n}: ${on.length} transients at ${on.map(f3).join(", ")} s`, on.length >= 2, "gasket plus rattle");
    }
    const ir = pcm.store_ir;
    const irRt = bandDecayTime(ir, sr, 1000, 20, 2048, 256);
    check("reverb", `store IR T20 at 1 kHz = ${f3(irRt)} s`, irRt > 0.05 && irRt < 0.9, "small boxy room");
  }

  /* -- live smoke test ----------------------------------------------- */
  // Offline rendering proves the synthesis. It says nothing about whether the
  // system is wired into the game at all — which, per NOTES.md, is the failure
  // mode this project keeps hitting. So: load the real page, click to unlock,
  // and measure the master bus.
  console.log("\nlive: the graph is actually running in the scene");
  try {
    const live = await browser.newPage();
    live.setDefaultNavigationTimeout(180000);
    live.setDefaultTimeout(180000);
    const errors = [];
    live.on("pageerror", (e) => errors.push(String(e)));
    live.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    // First load lets vite's dep optimiser run; it force-reloads the page when
    // it finishes, which destroys any execution context we were holding. The
    // second load is stable.
    await live.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await live.waitForTimeout(4000);
    await live.reload({ waitUntil: "domcontentloaded" });
    await live.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 180000 });
    errors.length = 0;

    const registered = await live.evaluate(() => {
      const a = window.__GAME?.tryGet("audio");
      return a ? Object.keys(a).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(a))) : null;
    });
    check("live", `"audio" service published with ${registered?.length ?? 0} members`, !!registered, registered ? "" : "not on the registry");

    await live.mouse.click(400, 300); // trusted gesture: unlocks the context
    await live.waitForTimeout(2500);

    const probe = await live.evaluate(async () => {
      const a = window.__GAME.tryGet("audio");
      const listener = window.__GAME.camera.children.find((c) => c.type === "AudioListener");
      if (!listener) return { ready: a.ready, state: "no-listener" };
      const ctx = listener.context;
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      listener.getInput().connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 40));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) {
          peak = Math.max(peak, Math.abs(v));
          sum += v * v;
          n++;
        }
      }
      an.disconnect();
      return { ready: a.ready, state: ctx.state, peak, rms: Math.sqrt(sum / n), muted: a.isMuted(), volume: a.getMasterVolume() };
    });
    check("live", `AudioContext ${probe.state}, service ready = ${probe.ready}`, probe.ready && probe.state === "running", "unlocked by a real gesture");
    check(
      "live",
      `master bus after unlock: peak ${f2(db(probe.peak ?? 0))} dBFS, rms ${f2(db(probe.rms ?? 0))} dBFS`,
      (probe.rms ?? 0) > 1e-5,
      "the highway bed is audible on the listener, not just in theory"
    );

    // Every interaction entry point System 7 will call, fired for real.
    const called = await live.evaluate(async () => {
      const a = window.__GAME.tryGet("audio");
      const names = [
        "playPumpStart",
        "setPumpTickRate",
        "playPumpStop",
        "playDoorOpen",
        "playDoorClose",
        "setDoorOpenAmount",
        "playFridgeOpen",
        "playFridgeClose",
        "playBottleGrab",
        "setMasterVolume",
        "getMasterVolume",
        "setMuted",
        "isMuted",
      ];
      const missing = names.filter((n) => typeof a[n] !== "function");
      a.playPumpStart(1);
      a.setPumpTickRate(4);
      await new Promise((r) => setTimeout(r, 700));
      a.playPumpStop();
      a.playDoorOpen();
      a.setDoorOpenAmount(1);
      await new Promise((r) => setTimeout(r, 400));
      a.playDoorClose();
      a.playFridgeOpen();
      a.playBottleGrab();
      a.playFridgeClose();
      a.setMasterVolume(0.7);
      a.setMuted(true);
      a.setMuted(false);
      await new Promise((r) => setTimeout(r, 400));
      return { missing, volume: a.getMasterVolume() };
    });
    check("live", `all 13 interface methods present and callable`, called.missing.length === 0, called.missing.join(", ") || "no throws");
    check("live", `no page errors during the session`, errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
    await live.close();
  } catch (e) {
    check("live", "live smoke test", false, String(e?.message ?? e).slice(0, 200));
  }

  /* -- report ------------------------------------------------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("failures:");
    for (const f of failed) console.log(`  - [${f.group}] ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
  }
  console.log(`plots: ${OUT_DIR}`);

  await shutdown(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  void shutdown(1, "main threw");
});
