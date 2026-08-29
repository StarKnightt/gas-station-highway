import { biquad, chain, clamp, clamp01, curve, gainNode, loopSource, makeRng, strike, Voice } from "./dsp";
import type { AudioKit } from "./kit";

/**
 * Every one-shot in the soundscape. Each takes the shared kit, a destination
 * node, an absolute start time and a seeded random source, builds a
 * self-freeing subgraph, and returns the time it finishes.
 *
 * They are deliberately free functions over `BaseAudioContext` so the offline
 * verification harness renders exactly the graph the game plays.
 */

export type Rand = () => number;

const SPEED_OF_SOUND = 343;

/* ------------------------------------------------------------------ */
/* bell                                                                */
/* ------------------------------------------------------------------ */

/**
 * Modal ratios of a 50 mm brass shop bell — the kind screwed to a spring arm
 * above a storefront door and struck by the door itself.
 *
 * Three things distinguish this from a hotel desk bell. The ratios are not
 * integers, because a struck shell vibrates in modes set by its geometry
 * rather than in a harmonic series. The energy is not in the fundamental: a
 * small shell struck hard on its rim is dominated by the higher
 * circumferential modes, which is where the brightness comes from. And it is
 * small, so it is heavily damped and gone inside about half a second.
 *
 * `m` is the circumferential mode number, used to weight each mode by where
 * on the rim the door happened to hit it.
 */
const BELL_MODES: { ratio: number; amp: number; decayScale: number; m: number }[] = [
  { ratio: 1.0, amp: 0.42, decayScale: 1.0, m: 2 },
  { ratio: 1.68, amp: 1.0, decayScale: 0.66, m: 3 },
  { ratio: 2.66, amp: 0.85, decayScale: 0.46, m: 4 },
  { ratio: 3.42, amp: 0.62, decayScale: 0.34, m: 5 },
  { ratio: 4.51, amp: 0.44, decayScale: 0.25, m: 6 },
  { ratio: 5.78, amp: 0.3, decayScale: 0.17, m: 7 },
];

/**
 * Base decay of the fundamental, seconds. `strike` runs an exponential with
 * a time constant of `decay / 3`, so the -20 dB time works out at about
 * `0.77 * decay` — 0.22 s here, and the envelope is ramped out entirely by
 * 0.45 s. That is the size of bell this is meant to be; the previous 1.78 s
 * measured a T20 of 1.17 s, which is a brass service bell, not a shop bell.
 */
const BELL_DECAY = 0.285;

export interface BellOptions {
  /** Fundamental of the shell, Hz. */
  f0?: number;
  /** 0..1 how hard the door swung it. */
  strength?: number;
  gain?: number;
  /** Play the spring arm swinging back and re-contacting. */
  rattle?: boolean;
}

/**
 * The modes plus a two-band contact transient all peak within a millisecond
 * or two of each other, so the raw sum runs about 6x the nominal level.
 * Normalised here rather than by turning every caller down, so `gain` means
 * roughly peak amplitude.
 */
const BELL_NORM = 0.14;

/**
 * One contact with the shell. Shared by the door strike and by every
 * subsequent tap as the spring arm oscillates.
 *
 * `strikePos` is where on the rim the contact lands, 0..1 around the
 * circumference. A circumferential mode `m` has `2m` nodes around the rim,
 * so a strike at a node barely excites it and a strike at an antinode
 * excites it fully. That is why the same bell sounds slightly different every
 * time the door swings it, and why the re-contacts are not just quieter
 * copies of the first.
 */
function bellStrike(
  kit: AudioKit,
  out: AudioNode,
  t0: number,
  f0: number,
  level: number,
  decay: number,
  strikePos: number,
  rnd: Rand,
  v: Voice
): number {
  const ctx = kit.ctx;
  const lvl = level * BELL_NORM;
  const theta = strikePos * Math.PI;
  let end = t0;

  for (const mode of BELL_MODES) {
    const excite = 0.35 + 0.65 * Math.abs(Math.cos(mode.m * theta));
    // A real casting is never perfectly axisymmetric: each mode splits into a
    // close doublet, and the pair beats. That warble is most of what makes a
    // synthesised bell sound struck rather than played.
    const split = 1 + (rnd() - 0.5) * 0.008;
    for (let k = 0; k < 2; k++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f0 * mode.ratio * (k === 0 ? 1 : split);
      const g = gainNode(ctx, 0);
      const e = strike(g, t0, lvl * mode.amp * excite * 0.5, 0.0012, decay * mode.decayScale);
      end = Math.max(end, e);
      osc.connect(g).connect(out);
      v.node(g);
      v.source(osc, t0, e + 0.01);
    }
  }

  // Contact transient, in three bands. This is a door edge hitting brass, not
  // a felt mallet: there is a hard bright click at the instant of contact and
  // a short scrape of noise behind it, and the pair carries a lot of the
  // character. The levels look enormous next to the modes, but band-limited
  // noise has a far lower peak for a given envelope value than a sine does —
  // the measured transient-to-sustain ratio is what these are tuned against.
  for (const [freq, q, amp, dec] of [
    [7200 + rnd() * 2200, 0.7, 9.0, 0.0022],
    [3400 + rnd() * 900, 1.0, 6.0, 0.006],
    [1500 + rnd() * 400, 1.3, 3.0, 0.02],
  ] as const) {
    const nz = loopSource(ctx, kit.white);
    const bp = biquad(ctx, "bandpass", freq, q);
    const ng = gainNode(ctx, 0);
    const ne = strike(ng, t0, lvl * amp, 0.0005, dec);
    chain(nz, bp, ng, out);
    v.node(bp);
    v.node(ng);
    v.source(nz, t0, ne + 0.01);
    end = Math.max(end, ne);
  }

  return end;
}

export function playBell(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, o: BellOptions = {}): number {
  const ctx = kit.ctx;
  const v = new Voice(ctx);
  const f0 = o.f0 ?? 2980 * (0.96 + rnd() * 0.08);
  const strength = clamp01(o.strength ?? 0.85);
  const level = (o.gain ?? 0.5) * (0.45 + strength * 0.55);
  const pos = rnd();
  let end = bellStrike(kit, out, t0, f0, level, BELL_DECAY, pos, rnd, v);

  // The spring arm itself: a strip of steel that twangs low and dies fast.
  // Almost subliminal, but it is the difference between a bell floating in
  // space and a bell bolted to something.
  {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(168 * (0.9 + rnd() * 0.2), t0);
    osc.frequency.exponentialRampToValueAtTime(139, t0 + 0.11);
    const g = gainNode(ctx, 0);
    const e = strike(g, t0, level * BELL_NORM * 0.5, 0.003, 0.075);
    osc.connect(g).connect(out);
    v.node(g);
    v.source(osc, t0, e + 0.01);
    end = Math.max(end, e);
  }

  if (o.rattle !== false) {
    // Spring-arm motion. The arm is displaced by the door and oscillates at
    // roughly 9 Hz, tapping the shell again on each swing with rapidly
    // decaying energy and a slightly shortening period as it settles. Three
    // or four contacts, each landing at a different point on the rim.
    let t = t0;
    let gap = 0.098 + rnd() * 0.028;
    let amp = 0.34 + rnd() * 0.1;
    const contacts = 3 + (rnd() < 0.45 ? 1 : 0);
    for (let i = 0; i < contacts; i++) {
      t += gap;
      end = Math.max(
        end,
        bellStrike(kit, out, t, f0 * (1 + (rnd() - 0.5) * 0.004), level * amp, BELL_DECAY * 0.55, rnd(), rnd, v)
      );
      gap *= 0.9 + rnd() * 0.06;
      amp *= 0.44 + rnd() * 0.1;
    }
  }

  v.run();
  return end;
}

/* ------------------------------------------------------------------ */
/* door                                                                */
/* ------------------------------------------------------------------ */

/** Brief broadband click: latch tongue, switch, magnetic catch. */
export function click(
  kit: AudioKit,
  out: AudioNode,
  t0: number,
  level: number,
  freq: number,
  q: number,
  decay: number,
  v: Voice
): number {
  const ctx = kit.ctx;
  const nz = loopSource(ctx, kit.white);
  const bp = biquad(ctx, "bandpass", freq, q);
  const g = gainNode(ctx, 0);
  const end = strike(g, t0, level, 0.0004, decay);
  chain(nz, bp, g, out);
  v.node(bp);
  v.node(g);
  v.source(nz, t0, end + 0.01);
  return end;
}

/** Low body thump: a door slab, a gasket, a lever seating in its detent. */
export function thump(
  kit: AudioKit,
  out: AudioNode,
  t0: number,
  level: number,
  freq: number,
  decay: number,
  v: Voice
): number {
  const ctx = kit.ctx;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * 1.9, t0);
  osc.frequency.exponentialRampToValueAtTime(freq, t0 + decay * 0.5);
  const g = gainNode(ctx, 0);
  const end = strike(g, t0, level, 0.002, decay);
  osc.connect(g).connect(out);
  v.node(g);
  v.source(osc, t0, end + 0.01);
  return end;
}

/**
 * The rubber weatherstrip letting go as the door is pulled. Stick-slip: the
 * seal releases in a rapid irregular stutter rather than smoothly, which is
 * why the envelope is a jittered curve rather than a ramp.
 */
function sealPeel(
  kit: AudioKit,
  out: AudioNode,
  t0: number,
  dur: number,
  level: number,
  fLo: number,
  fHi: number,
  rnd: Rand,
  v: Voice
): number {
  const ctx = kit.ctx;
  const nz = loopSource(ctx, kit.pink);
  const bp = biquad(ctx, "bandpass", fLo, 2.6);
  bp.frequency.setValueCurveAtTime(
    curve(48, (t) => fLo + (fHi - fLo) * Math.pow(t, 0.7)),
    t0,
    dur
  );
  const g = gainNode(ctx, 0);
  let stick = 0;
  g.gain.setValueCurveAtTime(
    curve(96, (t) => {
      const body = Math.sin(Math.PI * t) ** 1.3;
      if (rnd() < 0.22) stick = 0.35 + rnd() * 0.65;
      stick *= 0.86;
      return level * body * (0.35 + stick);
    }),
    t0,
    dur
  );
  chain(nz, bp, g, out);
  v.node(bp);
  v.node(g);
  v.source(nz, t0, t0 + dur + 0.02);
  return t0 + dur;
}

export function playDoorOpen(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  let end = sealPeel(kit, out, t0, 0.34, gain * 0.3, 620, 2300, rnd, v);
  end = Math.max(end, thump(kit, out, t0 + 0.02, gain * 0.16, 74, 0.1, v));
  // Hinge pin, dry and creaky in the cold.
  end = Math.max(end, click(kit, out, t0 + 0.13, gain * 0.07, 1450, 4.5, 0.05, v));
  v.run();
  // The shell is above the door and is struck a moment after it starts to move.
  end = Math.max(end, playBell(kit, out, t0 + 0.11 + rnd() * 0.04, rnd, { gain, strength: 0.6 + rnd() * 0.35 }));
  return end;
}

export function playDoorClose(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;

  // Hydraulic closer: a long, dark hiss of air being metered through the
  // check valve as the arm pulls the door back.
  const nz = loopSource(ctx, kit.pink);
  const lp = biquad(ctx, "lowpass", 1500, 0.8);
  lp.frequency.setValueCurveAtTime(
    curve(32, (t) => 1500 - 780 * t),
    t0,
    0.78
  );
  const hp = biquad(ctx, "highpass", 240, 0.7);
  const g = gainNode(ctx, 0);
  g.gain.setValueCurveAtTime(
    curve(64, (t) => gain * 0.2 * Math.sin(Math.PI * Math.pow(t, 0.62)) ** 1.4),
    t0,
    0.78
  );
  chain(nz, lp, hp, g, out);
  v.node(lp);
  v.node(hp);
  v.node(g);
  v.source(nz, t0, t0 + 0.8);

  let end = t0 + 0.8;
  // Slab meeting the jamb, then the latch tongue dropping into the striker.
  end = Math.max(end, thump(kit, out, t0 + 0.74, gain * 0.34, 62, 0.14, v));
  end = Math.max(end, click(kit, out, t0 + 0.755, gain * 0.2, 2600, 3.0, 0.02, v));
  end = Math.max(end, click(kit, out, t0 + 0.79, gain * 0.11, 4100, 2.2, 0.012, v));
  v.run();

  end = Math.max(end, playBell(kit, out, t0 + 0.06, rnd, { gain: gain * 0.7, strength: 0.35 + rnd() * 0.25 }));
  return end;
}

/* ------------------------------------------------------------------ */
/* cooler door and product                                             */
/* ------------------------------------------------------------------ */

export function playFridgeOpen(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  // Magnetic gasket letting go, lower and wetter than the storefront seal.
  let end = sealPeel(kit, out, t0, 0.26, gain * 0.34, 190, 780, rnd, v);
  end = Math.max(end, thump(kit, out, t0, gain * 0.2, 58, 0.09, v));
  // Bottles shifting on the shelf as the door swings.
  for (let i = 0; i < 3; i++) {
    const t = t0 + 0.16 + rnd() * 0.26;
    end = Math.max(end, click(kit, out, t, gain * (0.03 + rnd() * 0.05), 1700 + rnd() * 1800, 7 + rnd() * 5, 0.03 + rnd() * 0.05, v));
  }
  v.run();
  return end;
}

export function playFridgeClose(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;
  // Swing: a short whoosh, then the gasket slapping shut and the magnet grabbing.
  const nz = loopSource(ctx, kit.pink);
  const lp = biquad(ctx, "lowpass", 900, 0.7);
  const g = gainNode(ctx, 0);
  g.gain.setValueCurveAtTime(
    curve(48, (t) => gain * 0.1 * Math.pow(t, 2.2)),
    t0,
    0.22
  );
  chain(nz, lp, g, out);
  v.node(lp);
  v.node(g);
  v.source(nz, t0, t0 + 0.23);

  let end = t0 + 0.23;
  end = Math.max(end, thump(kit, out, t0 + 0.21, gain * 0.4, 54, 0.13, v));
  end = Math.max(end, click(kit, out, t0 + 0.215, gain * 0.13, 900, 1.6, 0.03, v));
  for (let i = 0; i < 2; i++) {
    end = Math.max(end, click(kit, out, t0 + 0.25 + rnd() * 0.2, gain * 0.04, 2200 + rnd() * 1600, 8, 0.03, v));
  }
  v.run();
  return end;
}

/** A cold PET bottle lifted off a wire shelf: crinkle, scrape, small clink. */
export function playBottleGrab(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;

  const nz = loopSource(ctx, kit.white);
  const hp = biquad(ctx, "highpass", 1600, 0.7);
  const bp = biquad(ctx, "bandpass", 3400, 1.2);
  const g = gainNode(ctx, 0);
  // Crinkle is a dense burst of micro-transients, so the envelope is noise in
  // its own right rather than a smooth shape.
  let e = 0;
  g.gain.setValueCurveAtTime(
    curve(128, (t) => {
      if (rnd() < 0.3) e = rnd();
      e *= 0.8;
      return gain * 0.09 * e * Math.sin(Math.PI * t) ** 0.8;
    }),
    t0,
    0.33
  );
  chain(nz, hp, bp, g, out);
  v.node(hp);
  v.node(bp);
  v.node(g);
  v.source(nz, t0, t0 + 0.34);

  let end = t0 + 0.34;
  end = Math.max(end, click(kit, out, t0 + 0.02, gain * 0.05, 780, 3, 0.04, v));
  end = Math.max(end, click(kit, out, t0 + 0.27 + rnd() * 0.06, gain * 0.06, 2600 + rnd() * 900, 9, 0.05, v));
  v.run();
  return end;
}

/* ------------------------------------------------------------------ */
/* pump                                                                */
/* ------------------------------------------------------------------ */

/** The lever swinging up and seating. Heavy, metallic, entirely mechanical. */
export function playPumpClunk(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;
  let end = thump(kit, out, t0, gain * 0.45, 88, 0.13, v);

  // Two inharmonic metal modes: the lever and the housing it strikes.
  for (const [f, a, d] of [
    [318, 0.2, 0.16],
    [521, 0.13, 0.1],
    [887, 0.07, 0.055],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f * (0.98 + rnd() * 0.04);
    const g = gainNode(ctx, 0);
    const e = strike(g, t0, gain * a, 0.001, d);
    osc.connect(g).connect(out);
    v.node(g);
    v.source(osc, t0, e + 0.01);
    end = Math.max(end, e);
  }
  end = Math.max(end, click(kit, out, t0 + 0.001, gain * 0.22, 1900, 1.4, 0.024, v));
  v.run();
  return end;
}

/**
 * One click of the mechanical litre counter.
 *
 * The jitter arguments matter more than the timbre: a counter driven at a
 * fixed period reads as a metronome, and a metronome reads as software. The
 * harness asserts the inter-onset intervals have a non-trivial coefficient of
 * variation.
 */
export function playPumpTick(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;
  const detune = 0.92 + rnd() * 0.16;
  let end = click(kit, out, t0, gain * 0.14 * (0.8 + rnd() * 0.4), 2650 * detune, 6, 0.008, v);

  // The little ringing of the numeral drum after the pawl releases it.
  for (const [r, a] of [
    [1.0, 0.09],
    [2.37, 0.04],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 3120 * detune * r;
    const g = gainNode(ctx, 0);
    const e = strike(g, t0 + 0.0008, gain * a, 0.0006, 0.021 / r);
    osc.connect(g).connect(out);
    v.node(g);
    v.source(osc, t0, e + 0.005);
    end = Math.max(end, e);
  }
  v.run();
  return end;
}

/* ------------------------------------------------------------------ */
/* bird                                                                */
/* ------------------------------------------------------------------ */

/**
 * A two or three syllable call from somewhere in the scrub. Each syllable is
 * a swept tone with a weak second harmonic; the sweep shape and the gaps are
 * re-rolled every call so the same bird is never heard twice.
 */
export function playBird(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, gain = 0.5): number {
  const v = new Voice(kit.ctx);
  const ctx = kit.ctx;
  const syllables = 2 + (rnd() < 0.4 ? 1 : 0);
  const base = 2900 + rnd() * 2200;
  let t = t0;
  let end = t0;

  for (let s = 0; s < syllables; s++) {
    const dur = 0.055 + rnd() * 0.07;
    const f0 = base * (0.88 + rnd() * 0.28);
    const f1 = f0 * (rnd() < 0.55 ? 1.28 + rnd() * 0.5 : 0.62 + rnd() * 0.22);
    const bend = 0.4 + rnd() * 1.6;

    for (const [mult, amp] of [
      [1, 1],
      [2, 0.16],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueCurveAtTime(
        curve(24, (u) => (f0 + (f1 - f0) * Math.pow(u, bend)) * mult),
        t,
        dur
      );
      const g = gainNode(ctx, 0);
      g.gain.setValueCurveAtTime(
        curve(32, (u) => gain * 0.22 * amp * Math.sin(Math.PI * u) ** 0.55),
        t,
        dur
      );
      osc.connect(g).connect(out);
      v.node(g);
      v.source(osc, t, t + dur + 0.005);
    }
    // A breath of noise on the attack keeps it from sounding like a test tone.
    const nz = loopSource(ctx, kit.white);
    const bp = biquad(ctx, "bandpass", f0, 5);
    const ng = gainNode(ctx, 0);
    const ne = strike(ng, t, gain * 0.05, 0.002, 0.014);
    chain(nz, bp, ng, out);
    v.node(bp);
    v.node(ng);
    v.source(nz, t, ne + 0.005);

    end = t + dur;
    t = end + 0.05 + rnd() * 0.1;
  }
  v.run();
  return end;
}

/* ------------------------------------------------------------------ */
/* vehicle passes                                                      */
/* ------------------------------------------------------------------ */

export interface PassOptions {
  /** Metres from the listener to the vehicle's path at closest approach. */
  distance?: number;
  /** Along-path speed, m/s. */
  speed?: number;
  gain?: number;
  /** Half-length of the rendered event, seconds either side of the pass. */
  half?: number;
}

interface PassShape {
  /** Doppler frequency multiplier over the event. */
  doppler: (t01: number) => number;
  duration: number;
}

/**
 * Air absorption plus ground effect, as a low-pass cutoff for a source
 * `metres` away. High frequencies are gone long before the low rumble is,
 * which is the entire character of a vehicle receding down a highway.
 *
 * Driven live from the true listener-to-vehicle distance rather than baked
 * from the geometry at spawn: the player walks throughout, and over a
 * ten-second pass they can cover twenty metres, which is most of the useful
 * dynamic range of this curve.
 */
export function airCutoff(metres: number): number {
  return clamp(340 + 9800 * Math.exp(-Math.max(0, metres - 8) / 46), 300, 18000);
}

/**
 * Handle on a vehicle in flight. Distance *gain* is deliberately not here:
 * that is the PannerNode's job, and letting it do the work is what makes the
 * level track the player continuously for free.
 */
export interface VehicleVoice {
  /** Absolute context time at which the event finishes. */
  readonly endTime: number;
  /** Feed the true listener-to-vehicle distance, in metres. */
  setDistance(metres: number, when: number): void;
}

/**
 * The physics shared by cars and trucks.
 *
 * `dr/dt = v*x/r` for a straight path, so the observed frequency is
 * `f * c / (c + dr/dt)`: above the source frequency while approaching, below
 * it after, with the whole transition compressed into the couple of seconds
 * around closest approach. Doing it analytically like this rather than
 * tweening a filter is what makes the pass sit in a physical space; the
 * harness measures the resulting shift ratio.
 */
function passShape(distance: number, speed: number, half: number): PassShape {
  const duration = half * 2;
  const d = Math.max(3, distance);
  return {
    duration,
    doppler: (t01) => {
      const t = (t01 - 0.5) * duration;
      const x = speed * t;
      const r = Math.hypot(x, d);
      const drdt = (speed * x) / r;
      return SPEED_OF_SOUND / (SPEED_OF_SOUND + drdt);
    },
  };
}

function vehiclePass(
  kit: AudioKit,
  out: AudioNode,
  t0: number,
  rnd: Rand,
  o: Required<PassOptions>,
  spec: {
    engineHz: number;
    harmonics: { mult: number; amp: number; type: OscillatorType }[];
    tyreHz: number;
    tyreQ: number;
    tyreAmp: number;
    rumbleAmp: number;
    /** Diesel clatter depth, 0 for cars. */
    clatter: number;
  }
): VehicleVoice {
  const ctx = kit.ctx;
  const v = new Voice(kit.ctx);
  const s = passShape(o.distance, o.speed, o.half);
  const dur = s.duration;
  const N = 240;

  // Shared air-absorption filter: one node for the whole vehicle, driven from
  // outside by the live distance.
  const air = biquad(ctx, "lowpass", airCutoff(o.distance), 0.6);
  const body = gainNode(ctx, o.gain);
  chain(air, body, out);
  v.node(air);
  v.node(body);

  // Engine: a few harmonics that all shift together under the Doppler curve.
  // Slight load-dependent wander keeps it from being a pure tone.
  const wander = 0.995 + rnd() * 0.01;
  for (const h of spec.harmonics) {
    const osc = ctx.createOscillator();
    osc.type = h.type;
    const f = spec.engineHz * wander * h.mult;
    osc.frequency.setValueCurveAtTime(
      curve(N, (t) => f * s.doppler(t)),
      t0,
      dur
    );
    const g = gainNode(ctx, h.amp);
    osc.connect(g).connect(air);
    v.node(g);
    v.source(osc, t0, t0 + dur + 0.02);
  }

  // Diesel clatter: an amplitude-modulated band that also rides the Doppler.
  if (spec.clatter > 0) {
    const nz = loopSource(ctx, kit.white);
    const bp = biquad(ctx, "bandpass", 1900, 1.4);
    bp.frequency.setValueCurveAtTime(
      curve(N, (t) => 1900 * s.doppler(t)),
      t0,
      dur
    );
    // Firing-order modulation, driven by an oscillator rather than a value
    // curve: at ~126 Hz no practical curve resolution could carry it.
    const g = gainNode(ctx, spec.clatter * 0.5);
    const lfo = ctx.createOscillator();
    lfo.type = "sawtooth";
    const firing = spec.engineHz * 3;
    lfo.frequency.setValueCurveAtTime(
      curve(N, (t) => firing * s.doppler(t)),
      t0,
      dur
    );
    const lfoAmt = gainNode(ctx, spec.clatter * 0.5);
    lfo.connect(lfoAmt).connect(g.gain);
    chain(nz, bp, g, air);
    v.node(bp);
    v.node(g);
    v.node(lfoAmt);
    v.source(lfo, t0, t0 + dur + 0.02);
    v.source(nz, t0, t0 + dur + 0.02);
  }

  // Tyre roar on the coarse chip seal. Broadband, and the loudest part of a
  // highway pass at speed; the engine is a detail underneath it.
  const tyre = loopSource(ctx, kit.pinkB);
  const tbp = biquad(ctx, "bandpass", spec.tyreHz, spec.tyreQ);
  tbp.frequency.setValueCurveAtTime(
    curve(N, (t) => spec.tyreHz * s.doppler(t)),
    t0,
    dur
  );
  const tg = gainNode(ctx, spec.tyreAmp);
  chain(tyre, tbp, tg, air);
  v.node(tbp);
  v.node(tg);
  v.source(tyre, t0, t0 + dur + 0.02);

  // Low body rumble, unfiltered by the air stage so it survives the tail.
  const rum = loopSource(ctx, kit.brown);
  const rlp = biquad(ctx, "lowpass", 190, 0.7);
  const rg = gainNode(ctx, o.gain * spec.rumbleAmp);
  chain(rum, rlp, rg, out);
  v.node(rlp);
  v.node(rg);
  v.source(rum, t0, t0 + dur + 0.02);

  v.run();
  return {
    endTime: t0 + dur,
    setDistance(metres, when) {
      air.frequency.setTargetAtTime(airCutoff(metres), Math.max(when, t0), 0.08);
    },
  };
}

export function playCarPass(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, o: PassOptions = {}): VehicleVoice {
  const speed = o.speed ?? 25 + rnd() * 6;
  return vehiclePass(
    kit,
    out,
    t0,
    rnd,
    {
      distance: o.distance ?? 30 + rnd() * 20,
      speed,
      gain: o.gain ?? 0.5,
      half: o.half ?? 5.0,
    },
    {
      engineHz: 96 + rnd() * 28,
      harmonics: [
        { mult: 1, amp: 0.1, type: "sine" },
        { mult: 2, amp: 0.07, type: "sine" },
        { mult: 3, amp: 0.05, type: "triangle" },
        { mult: 4.5, amp: 0.02, type: "sine" },
      ],
      tyreHz: 950,
      tyreQ: 0.55,
      tyreAmp: 0.42,
      rumbleAmp: 0.3,
      clatter: 0,
    }
  );
}

export function playTruckPass(kit: AudioKit, out: AudioNode, t0: number, rnd: Rand, o: PassOptions = {}): VehicleVoice {
  const speed = o.speed ?? 22 + rnd() * 4;
  return vehiclePass(
    kit,
    out,
    t0,
    rnd,
    {
      distance: o.distance ?? 32 + rnd() * 18,
      speed,
      gain: o.gain ?? 0.6,
      half: o.half ?? 7.5,
    },
    {
      engineHz: 42 + rnd() * 10,
      harmonics: [
        { mult: 1, amp: 0.16, type: "sine" },
        { mult: 2, amp: 0.11, type: "triangle" },
        { mult: 3, amp: 0.07, type: "sine" },
        { mult: 5, amp: 0.035, type: "sine" },
        { mult: 7, amp: 0.02, type: "sine" },
      ],
      tyreHz: 620,
      tyreQ: 0.5,
      tyreAmp: 0.5,
      rumbleAmp: 0.55,
      clatter: 0.028,
    }
  );
}

/* ------------------------------------------------------------------ */

/** Convenience for callers that want an independent stream per event. */
export function seededRand(seed: number): Rand {
  return makeRng(seed);
}
