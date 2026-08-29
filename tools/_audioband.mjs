/**
 * Band-split envelope of the film's rendered audio.
 *
 * The first pass at verifying the film's audio measured broadband RMS in
 * quarter-second windows and found a smooth ramp with no transients, which read
 * as "the one-shots are not in the render". But the bell and the pump ticks are
 * narrow and bright and the beds they compete with — a distant highway wash and a
 * fridge hum — are broad and low, so a broadband window is the one measurement
 * guaranteed to hide them. This splits the signal and asks each band separately.
 */
import fs from "node:fs";
import path from "node:path";

const RAW = process.argv[2] ?? path.join("shots", "film", "audio.raw");
const RATE = Number(process.argv[3] ?? 46080);
const MARKS = (process.argv[4] ?? "2.467,9.533,19.433,20.1,20.767")
  .split(",")
  .filter(Boolean)
  .map(Number);

const buf = fs.readFileSync(RAW);
const n = Math.floor(buf.length / 4);
const mono = new Float32Array(n);
for (let i = 0; i < n; i++) {
  mono[i] = (buf.readInt16LE(i * 4) + buf.readInt16LE(i * 4 + 2)) / 65536;
}
console.log(`${RAW}: ${n} frames = ${(n / RATE).toFixed(2)} s at ${RATE} Hz`);

/** One biquad section, Butterworth Q, applied in place into a fresh array. */
function biquad(x, kind, f0, q) {
  const w = (2 * Math.PI * f0) / RATE;
  const c = Math.cos(w);
  const a = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (kind === "hp") {
    b0 = (1 + c) / 2;
    b1 = -(1 + c);
    b2 = (1 + c) / 2;
  } else {
    b0 = (1 - c) / 2;
    b1 = 1 - c;
    b2 = (1 - c) / 2;
  }
  const a0 = 1 + a;
  const a1 = -2 * c;
  const a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Two cascaded sections, so the skirt is steep enough to be worth trusting. */
const hp = (x, f) => biquad(biquad(x, "hp", f, 0.5412), "hp", f, 1.3066);
const lp = (x, f) => biquad(biquad(x, "lp", f, 0.5412), "lp", f, 1.3066);

const BANDS = [
  ["low  <200 Hz  (highway)", lp(mono, 200)],
  ["mid  200-1500 (hum/room)", lp(hp(mono, 200), 1500)],
  ["high >2500 Hz (bell/tick)", hp(mono, 2500)],
];

/** Peak envelope in short hops — short enough that a 40 ms tick survives. */
const HOP = Math.round(RATE * 0.02);
for (const [name, sig] of BANDS) {
  const env = [];
  for (let i = 0; i + HOP <= sig.length; i += HOP) {
    let p = 0;
    for (let j = i; j < i + HOP; j++) p = Math.max(p, Math.abs(sig[j]));
    env.push(p);
  }
  const sorted = [...env].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log(`\n${name}`);
  console.log(`  median hop peak ${med.toFixed(5)}   p95 ${p95.toFixed(5)}   max ${sorted[sorted.length - 1].toFixed(5)}`);

  // Anything standing well clear of the band's own median is a transient. A
  // steady bed sits at its median by definition, so the ratio is the question.
  const TR = 4;
  const spikes = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > med * TR && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
      spikes.push({ t: (i * HOP) / RATE, x: env[i] / med });
    }
  }
  // Collapse runs, so one ring is reported once.
  const merged = [];
  for (const s of spikes) {
    const last = merged[merged.length - 1];
    if (last && s.t - last.t < 0.15) { if (s.x > last.x) { last.t = s.t; last.x = s.x; } }
    else merged.push({ ...s });
  }
  console.log(`  transients >${TR}x median: ${merged.length}`);
  for (const s of merged.slice(0, 24)) {
    const near = MARKS.reduce((b, m) => (Math.abs(m - s.t) < Math.abs(b - s.t) ? m : b), Infinity);
    const tag = Math.abs(near - s.t) < 0.4 ? `  <= event ${near}s` : "";
    console.log(`    ${s.t.toFixed(2)}s  ${s.x.toFixed(1)}x${tag}`);
  }

  // And the other direction: at each event, what did this band actually do?
  const at = (t, w) => {
    let p = 0;
    const a = Math.max(0, Math.floor((t * RATE) / HOP));
    const b = Math.min(env.length - 1, Math.floor(((t + w) * RATE) / HOP));
    for (let i = a; i <= b; i++) p = Math.max(p, env[i]);
    return p;
  };
  console.log(
    `  at each event (peak in the 0.3 s after, as a multiple of band median): ` +
      MARKS.map((m) => `${m}s ${(at(m, 0.3) / med).toFixed(1)}x`).join("  ")
  );
}

/**
 * Optional window dump, because "2.5x at the pump" could be one weak tick or a
 * train of them, and only the shape of the envelope tells them apart.
 */
if (process.env.WINDOW) {
  const [w0, w1] = process.env.WINDOW.split(",").map(Number);
  const sig = hp(mono, 2500);
  console.log(`\nhigh-band envelope, ${w0}-${w1}s, 20 ms hops`);
  let line = "";
  for (let t = w0; t < w1; t += 0.02) {
    let p = 0;
    const a = Math.floor(t * RATE);
    for (let j = a; j < a + HOP && j < sig.length; j++) p = Math.max(p, Math.abs(sig[j]));
    const bars = Math.min(40, Math.round((p / 0.00364) * 2));
    line += `  ${t.toFixed(2)} ${p.toFixed(5)} ${"#".repeat(bars)}\n`;
  }
  console.log(line);
}
