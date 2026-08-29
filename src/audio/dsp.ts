/**
 * Web Audio primitives shared by every voice in the soundscape.
 *
 * Everything here takes a `BaseAudioContext` rather than an `AudioContext` so
 * the exact same synthesis code runs under `OfflineAudioContext` in the
 * verification harness. No voice in this project is allowed to reach for a
 * realtime-only API.
 */

/** Deterministic PRNG. Offline renders must be byte-reproducible to assert on. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number) => clamp(x, 0, 1);

/**
 * Cross-fades the tail of a noise buffer back over its head so a looping
 * player has no seam. Valid only because the two halves are uncorrelated:
 * equal-power gains then preserve RMS instead of dipping.
 */
function seamlessLoop(data: Float32Array, fadeSamples: number): void {
  const n = data.length;
  const f = Math.min(fadeSamples, Math.floor(n / 4));
  for (let i = 0; i < f; i++) {
    const t = i / f;
    const gHead = Math.sqrt(t);
    const gTail = Math.sqrt(1 - t);
    data[i] = data[i] * gHead + data[n - f + i] * gTail;
  }
  // The tail region is now folded into the head, so it is no longer played.
  return;
}

export function whiteNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 1): AudioBuffer {
  const rnd = makeRng(seed);
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  seamlessLoop(d, Math.floor(ctx.sampleRate * 0.05));
  return buf;
}

/** Paul Kellet's economical pink filter. -3 dB/octave to well under 20 Hz. */
export function pinkNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 2): AudioBuffer {
  const rnd = makeRng(seed);
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    d[i] = v;
    dc += v;
  }
  // Pink generators drift; a residual DC offset would be inherited by every
  // bed that plays them, and shows up immediately in the harness assertions.
  dc /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    d[i] -= dc;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  seamlessLoop(d, Math.floor(ctx.sampleRate * 0.05));
  return buf;
}

/** -6 dB/octave. Used for the low rumble bed under the highway. */
export function brownNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 3): AudioBuffer {
  const rnd = makeRng(seed);
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02;
    d[i] = last;
    dc += last;
  }
  dc /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    d[i] -= dc;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  seamlessLoop(d, Math.floor(ctx.sampleRate * 0.05));
  return buf;
}

/**
 * A magnetic-ballast current waveform: an impulse train at twice mains.
 *
 * A fluorescent tube is not driven by a sine. The ballast lets the arc strike
 * once per mains half-cycle and the current collapses again, so the acoustic
 * output is a train of sharp mechanical impulses at 120 Hz whose amplitudes
 * wander from strike to strike and whose timing wobbles by a fraction of a
 * millisecond. That irregularity is the entire character; a filtered sawtooth
 * gets the spectrum roughly right and sounds nothing like it.
 *
 * `seconds` must be a whole number so the buffer contains an exact number of
 * 120 Hz periods and loops without a seam — no cross-fade, which would smear
 * the impulses.
 */
export function ballastBuffer(ctx: BaseAudioContext, seconds: number, rate = 120, seed = 5): AudioBuffer {
  const rnd = makeRng(seed);
  const sr = ctx.sampleRate;
  const n = Math.round(sr * Math.round(seconds));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const period = sr / rate;
  const decaySamples = Math.max(2, sr / 12000);

  const spike = (centre: number, amp: number) => {
    const i0 = Math.round(centre);
    for (let k = -1; k < 26; k++) {
      const i = i0 + k;
      if (i < 0 || i >= n) continue;
      // Sharp asymmetric transient: one sample of rise, then a fast collapse
      // with a slight undershoot as the arc extinguishes.
      const t = k / decaySamples;
      const v = k < 0 ? -0.25 : Math.exp(-t) * (1 - 0.55 * Math.min(1, t * 0.6));
      d[i] += amp * v;
    }
  };

  const periods = Math.round((n / sr) * rate);
  for (let p = 0; p < periods; p++) {
    // +/- 0.11 ms. Enough to keep the train from sounding machined, small
    // enough that the harmonic ladder survives it: phase error scales with
    // harmonic number, so a jitter of even a quarter-period at 700 Hz would
    // smear the upper lines into the noise floor.
    const jitter = (rnd() - 0.5) * 0.00022 * sr;
    // Heavily skewed: most strikes are middling, a few are hard.
    let amp = 0.3 + 0.7 * Math.pow(rnd(), 1.8);
    if (rnd() < 0.05) amp *= 0.15; // a half-cycle that barely strikes
    spike(p * period + jitter, amp);
    // Restrikes: the arc sometimes stutters before it settles.
    if (rnd() < 0.14) spike(p * period + jitter + (0.6 + rnd() * 1.4) * 0.001 * sr, amp * (0.2 + rnd() * 0.3));
  }

  // A whisper of continuous hiss so the gaps between strikes are not dead.
  let dc = 0;
  for (let i = 0; i < n; i++) {
    d[i] += (rnd() * 2 - 1) * 0.006;
    dc += d[i];
  }
  dc /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    d[i] -= dc;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  return buf;
}

export interface RoomIrOptions {
  seconds: number;
  /** RT60-ish; larger = longer tail. */
  decay: number;
  /** Silence before the first reflection, seconds. */
  predelay: number;
  /** 0 = dark and absorbent, 1 = bright and tiled. */
  brightness: number;
  /** Discrete early reflections, in seconds from the direct sound. */
  earlyTimes?: number[];
  seed?: number;
}

/**
 * A procedurally generated impulse response for the store interior.
 *
 * Two parts: a handful of discrete early reflections, which are what actually
 * tells the ear "small boxy room with hard parallel walls", and an
 * exponentially decaying noise tail that is progressively low-passed so the
 * highs die before the lows the way they do in a room full of soft product.
 */
export function roomImpulse(ctx: BaseAudioContext, o: RoomIrOptions): AudioBuffer {
  const rnd = makeRng(o.seed ?? 7);
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * o.seconds));
  const buf = ctx.createBuffer(2, n, sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // One-pole low-pass state, per channel, swept over the tail.
    let lp = 0;
    const pre = Math.floor(o.predelay * sr);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-t / Math.max(0.02, o.decay / 6.9));
      const w = rnd() * 2 - 1;
      // Cutoff coefficient falls with time: bright at the front, dull at the back.
      const a = clamp01(0.06 + o.brightness * 0.55 * Math.exp(-t / (o.decay * 0.5)));
      lp += a * (w - lp);
      d[i] = lp * env;
    }
    // Early reflections. Slightly different per channel so the room is wide.
    const early = o.earlyTimes ?? [0.0071, 0.0113, 0.0169, 0.0231, 0.0298, 0.0407, 0.0561];
    for (let k = 0; k < early.length; k++) {
      const jitter = 1 + (rnd() - 0.5) * 0.18;
      const idx = Math.floor((o.predelay + early[k] * jitter) * sr);
      if (idx < n) d[idx] += (k % 2 ? -1 : 1) * (0.62 / (1 + k * 0.85)) * (0.8 + rnd() * 0.4);
    }
    // Direct-path spike omitted deliberately: this convolver is a send, the
    // dry signal is already carried by the source's own panner.
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  }
  return buf;
}

/**
 * Collects every node of a one-shot so the whole subgraph can be torn down
 * when its last source ends. Without this, a scene that fires a few hundred
 * pump ticks a minute leaks a few hundred dead nodes a minute.
 */
export class Voice {
  private nodes: AudioNode[] = [];
  private sources: { n: AudioScheduledSourceNode; start: number; stop: number }[] = [];

  constructor(readonly ctx: BaseAudioContext) {}

  node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Registers a scheduled source with its own absolute start/stop times. */
  source<T extends AudioScheduledSourceNode>(n: T, start: number, stop: number): T {
    this.nodes.push(n);
    this.sources.push({ n, start, stop });
    return n;
  }

  /** Schedules everything and frees the whole subgraph once the last one ends. */
  run(): number {
    let latest = 0;
    for (const s of this.sources) {
      s.n.start(s.start);
      s.n.stop(s.stop);
      latest = Math.max(latest, s.stop);
    }
    let tail: AudioScheduledSourceNode | null = null;
    for (const s of this.sources) if (s.stop >= latest) tail = s.n;
    if (tail) {
      tail.onended = () => {
        for (const n of this.nodes) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
        this.nodes.length = 0;
        this.sources.length = 0;
      };
    }
    return latest;
  }
}

/**
 * A looping player over a shared noise buffer. `loopEnd` stops short of the
 * cross-faded tail region, which `seamlessLoop` has already folded into the
 * head, so the seam is continuous.
 */
export function loopSource(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  playbackRate = 1,
  /** False for buffers that are already periodic and must not be trimmed. */
  trimCrossfadedTail = true
): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.loopStart = 0;
  s.loopEnd = trimCrossfadedTail ? Math.max(0.1, buffer.duration - 0.05) : buffer.duration;
  s.playbackRate.value = playbackRate;
  return s;
}

export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.707,
  gainDb = 0
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/**
 * Percussive envelope on a gain: instant-ish attack, exponential decay.
 * `setTargetAtTime` never reaches zero, so an explicit ramp to a floor value
 * is appended, otherwise the node keeps a DC-ish trickle alive forever.
 */
export function strike(g: GainNode, t0: number, peak: number, attack: number, decay: number): number {
  const p = g.gain;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setTargetAtTime(0.0001, t0 + attack, decay / 3);
  const end = t0 + attack + decay * 1.6;
  p.linearRampToValueAtTime(0, end);
  return end;
}

/**
 * Cancels pending automation while keeping the value the param has right now.
 * Plain `cancelScheduledValues` plus `setValueAtTime(p.value, ...)` reads the
 * *current* value, which under `OfflineAudioContext` is whatever it was before
 * rendering started rather than what it will be at `when` — so a spin-down
 * scheduled ahead of time would jump to zero instead of gliding.
 */
export function holdAt(p: AudioParam, when: number): void {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof q.cancelAndHoldAtTime === "function") q.cancelAndHoldAtTime(when);
  else p.cancelScheduledValues(when);
}

/** Sample a function into a Float32Array for `setValueCurveAtTime`. */
export function curve(steps: number, fn: (t01: number) => number): Float32Array {
  const a = new Float32Array(steps);
  for (let i = 0; i < steps; i++) a[i] = fn(i / (steps - 1));
  return a;
}

/** Connects a chain in order and returns the first node. */
export function chain<T extends AudioNode>(first: T, ...rest: AudioNode[]): T {
  let prev: AudioNode = first;
  for (const n of rest) {
    prev.connect(n);
    prev = n;
  }
  return first;
}
