import { biquad, chain, gainNode, holdAt, loopSource, Voice } from "./dsp";
import type { AudioKit } from "./kit";
import { click, thump, type Rand } from "./oneshots";

/**
 * Continuous sources. Unlike the one-shots these live for the whole session,
 * so each owns its nodes explicitly and tears them down in `dispose()`.
 */
export interface Bed {
  readonly out: GainNode;
  start(when: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* highway                                                             */
/* ------------------------------------------------------------------ */

/**
 * The distant wash. Filtered pink noise with a very slow amplitude drift and
 * no resonant peak anywhere in the chain: every filter runs at Q <= 0.7, so
 * the spectrum stays broadband. The harness asserts spectral flatness,
 * because a single lazy Q=4 bandpass here would put a whistle in the one
 * sound the player hears continuously for the entire session.
 *
 * The drift is what stops it reading as a loop. Two LFOs at incommensurate
 * periods (about 32 s and 59 s) never repeat within a plausible visit.
 */
export class HighwayWash implements Bed {
  readonly out: GainNode;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];

  constructor(kit: AudioKit, variant: number, level = 1) {
    const ctx = kit.ctx;
    this.out = gainNode(ctx, level);

    const buf = variant % 2 === 0 ? kit.pink : kit.pinkB;

    // Main body: everything above a few hundred Hz has been eaten by ground
    // absorption over 300 m, so this is mostly a low shelf of noise.
    const nz = loopSource(ctx, buf, 0.97 + variant * 0.031);
    const lp = biquad(ctx, "lowpass", 700 + variant * 90, 0.62);
    const hp = biquad(ctx, "highpass", 42, 0.7);
    const drift = gainNode(ctx, 0.5);
    chain(nz, hp, lp, drift, this.out);

    // Tyre-on-chipseal band, a little more present than the body.
    const nz2 = loopSource(ctx, variant % 2 === 0 ? kit.pinkB : kit.pink, 1.03 - variant * 0.017);
    const bp = biquad(ctx, "bandpass", 300 + variant * 40, 0.55);
    const g2 = gainNode(ctx, 0.28);
    chain(nz2, bp, g2, this.out);

    // Subsonic-ish rumble that only really arrives when the air is still.
    const nz3 = loopSource(ctx, kit.brown, 1 + variant * 0.02);
    const lp3 = biquad(ctx, "lowpass", 120, 0.6);
    const g3 = gainNode(ctx, 0.22);
    chain(nz3, lp3, g3, this.out);

    const lfoA = ctx.createOscillator();
    lfoA.frequency.value = 1 / 31.7;
    lfoA.type = "sine";
    const lfoAg = gainNode(ctx, 0.22);
    const lfoB = ctx.createOscillator();
    lfoB.frequency.value = 1 / 58.9;
    lfoB.type = "triangle";
    const lfoBg = gainNode(ctx, 0.16);
    lfoA.connect(lfoAg).connect(drift.gain);
    lfoB.connect(lfoBg).connect(drift.gain);

    // Very slow filter breathing, phase-offset from the amplitude drift.
    const lfoC = ctx.createOscillator();
    lfoC.frequency.value = 1 / 43.3;
    lfoC.type = "sine";
    const lfoCg = gainNode(ctx, 130);
    lfoC.connect(lfoCg).connect(lp.frequency);

    this.nodes.push(hp, lp, drift, bp, g2, lp3, g3, lfoAg, lfoBg, lfoCg);
    this.sources.push(nz, nz2, nz3, lfoA, lfoB, lfoC);
  }

  start(when: number): void {
    for (const s of this.sources) s.start(when);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of [...this.nodes, ...this.sources, this.out]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* cooler                                                              */
/* ------------------------------------------------------------------ */

/**
 * The walk-in cooler compressor.
 *
 * Three layers. A mains hum built from 60 Hz and its odd harmonics, which is
 * what makes it read as American rather than European; a compressor whine an
 * octave and a half above; and a broadband motor rumble. Every tonal
 * component is doubled by a partner a fraction of a Hz away, so the whole
 * thing beats slowly and never settles into a static drone.
 *
 * The gain node is externally switched: the compressor cycles on and off, and
 * the silence when it stops is the single most evocative moment available in
 * this scene.
 */
export class CoolerUnit implements Bed {
  readonly out: GainNode;
  /** Everything that is silenced when the compressor cycles off. */
  private run: GainNode;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private kit: AudioKit;

  /** 60 Hz plus odd harmonics; the even ones are deliberately absent. */
  static readonly HARMONICS: { mult: number; amp: number }[] = [
    { mult: 1, amp: 1.0 },
    { mult: 3, amp: 0.42 },
    { mult: 5, amp: 0.2 },
    { mult: 7, amp: 0.1 },
    { mult: 9, amp: 0.05 },
  ];

  constructor(kit: AudioKit, readonly mains = 60, level = 1) {
    this.kit = kit;
    const ctx = kit.ctx;
    this.out = gainNode(ctx, level);
    this.run = gainNode(ctx, 0);
    this.run.connect(this.out);

    for (const h of CoolerUnit.HARMONICS) {
      // Detuned pair. 0.17 Hz apart gives a ~6 s beat at the fundamental.
      for (const [off, amp] of [
        [0, 1],
        [0.17 * h.mult * 0.34, 0.85],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = mains * h.mult + off;
        const g = gainNode(ctx, 0.055 * h.amp * amp);
        osc.connect(g).connect(this.run);
        this.nodes.push(g);
        this.sources.push(osc);
      }
    }

    // Compressor whine: a reedy tone about an octave and three quarters above
    // the hum. The 3.37 ratio is deliberately not a harmonic of the mains —
    // parking it on 4x would bury it in the 240 Hz line and make the hum read
    // as an ordinary harmonic stack rather than a motor.
    const whine = ctx.createOscillator();
    whine.type = "sawtooth";
    whine.frequency.value = mains * 3.37;
    const wbp = biquad(ctx, "bandpass", mains * 3.37, 6);
    const wg = gainNode(ctx, 0.02);
    chain(whine, wbp, wg, this.run);
    const wLfo = ctx.createOscillator();
    wLfo.frequency.value = 1 / 11.3;
    const wLfoG = gainNode(ctx, 3.2);
    wLfo.connect(wLfoG).connect(whine.frequency);

    // Motor and fan: low broadband under everything. Two poles rather than
    // one, because a single 330 Hz low-pass still leaves enough noise at
    // 1–2 kHz to bury the switching clicks, which are the whole point of the
    // cooler cycling at all.
    const nz = loopSource(ctx, kit.pink);
    const lp = biquad(ctx, "lowpass", 330, 0.7);
    const lp2 = biquad(ctx, "lowpass", 430, 0.6);
    const hp = biquad(ctx, "highpass", 70, 0.7);
    const ng = gainNode(ctx, 0.13);
    chain(nz, hp, lp, lp2, ng, this.run);

    this.nodes.push(wbp, wg, wLfoG, hp, lp, lp2, ng);
    this.sources.push(whine, wLfo, nz);
  }

  start(when: number): void {
    for (const s of this.sources) s.start(when);
  }

  /**
   * Cycles the compressor. Starting is a mechanical thunk and a quick surge
   * as the motor loads up; stopping is a click and a fast, slightly ragged
   * spin-down into real silence.
   */
  setRunning(on: boolean, when: number, rnd: Rand): void {
    const p = this.run.gain;
    holdAt(p, when);
    if (on) {
      p.setValueAtTime(0, when);
      p.linearRampToValueAtTime(1.25, when + 0.55);
      p.setTargetAtTime(1, when + 0.55, 0.9);
      // The contactor closing: a hard clack plus the cabinet taking the load.
      const v = new Voice(this.kit.ctx);
      thump(this.kit, this.out, when, 0.24, 46, 0.12, v);
      click(this.kit, this.out, when + 0.003, 0.2, 1180, 1.1, 0.028, v);
      click(this.kit, this.out, when + 0.006, 0.11, 2900, 1.6, 0.012, v);
      v.run();
    } else {
      p.setTargetAtTime(0, when, 0.16);
      p.linearRampToValueAtTime(0, when + 1.1);
      const v = new Voice(this.kit.ctx);
      click(this.kit, this.out, when, 0.22, 1050, 1.3, 0.03, v);
      click(this.kit, this.out, when + 0.002, 0.1, 2500, 1.8, 0.011, v);
      thump(this.kit, this.out, when + 0.02, 0.13, 52, 0.1, v);
      v.run();
      void rnd;
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of [...this.nodes, ...this.sources, this.run, this.out]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* fluorescent fixtures                                                */
/* ------------------------------------------------------------------ */

/**
 * Magnetic ballast buzz.
 *
 * The source is a procedurally generated impulse train at 120 Hz with
 * irregular per-strike amplitude and sub-millisecond timing jitter (see
 * `ballastBuffer`), not an oscillator: the arc strikes once per mains
 * half-cycle and the acoustic result is a stutter of hard transients, which
 * is why a real fixture sounds gritty and alive rather than like a tone
 * generator. Three resonances shape it into the metal troffer it is bolted
 * into.
 *
 * Kept very quiet. Its whole job is to make the inside of the store feel
 * electrically different from the forecourt, not to be noticed on its own.
 */
export class FluorescentBuzz implements Bed {
  readonly out: GainNode;
  private nodes: AudioNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  /** Where in the shared ballast buffer this fixture starts, seconds. */
  private readonly offset: number;

  constructor(kit: AudioKit, seed = 0, level = 1) {
    const ctx = kit.ctx;
    this.out = gainNode(ctx, level);
    // Fixtures share one buffer and are started at different points in it.
    // They are on the same mains, so they run at the same 120 Hz and differ
    // only in phase and in which strikes happen to be hard ones.
    this.offset = (seed * 2.71 + 0.4) % kit.ballast.duration;

    const src = loopSource(ctx, kit.ballast, 1, false);
    // Low enough to keep the 120 Hz line itself, which is the frequency the
    // whole thing is named after; the troffer radiates it weakly but it is
    // there.
    const hp = biquad(ctx, "highpass", 95, 0.7);
    const body = gainNode(ctx, 1);
    chain(src, hp, body);

    // Troffer resonances: the sheet-steel pan, the lamp itself, and the
    // ballast can. Parallel so the impulse keeps its edge instead of being
    // smeared by a chain of series filters.
    for (const [freq, q, amp] of [
      [245, 1.8, 0.06],
      [610, 2.4, 0.05],
      [1320, 3.4, 0.045],
      [3450, 4.5, 0.018],
    ] as const) {
      const bp = biquad(ctx, "bandpass", freq, q);
      const g = gainNode(ctx, amp);
      chain(body, bp, g, this.out);
      this.nodes.push(bp, g);
    }
    // A little of the raw train, dulled, so the transients stay sharp.
    const dull = biquad(ctx, "lowpass", 5200, 0.7);
    const dullG = gainNode(ctx, 0.012);
    chain(body, dull, dullG, this.out);

    this.nodes.push(hp, body, dull, dullG);
    this.sources.push(src);
  }

  start(when: number): void {
    for (const s of this.sources) s.start(when, this.offset);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of [...this.nodes, ...this.sources, this.out]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* pump motor                                                          */
/* ------------------------------------------------------------------ */

/**
 * The submersible pump and the dispenser's own motor. Spins up with a little
 * overshoot, settles, and spins down when the lever drops. Held as a
 * long-lived bed with a gate rather than rebuilt per transaction, because
 * System 7 can start and stop it repeatedly.
 */
export class PumpMotor implements Bed {
  readonly out: GainNode;
  private gate: GainNode;
  private rate: AudioParam[] = [];
  private baseRate: number[] = [];
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];

  constructor(kit: AudioKit, level = 1) {
    const ctx = kit.ctx;
    this.out = gainNode(ctx, level);
    this.gate = gainNode(ctx, 0);
    // Sweeping a biquad's centre frequency does not renormalise its state, so
    // the spin-down leaves a small step of DC behind on the way out. One
    // high-pass on the bus removes it; measured at -8e-3 without this.
    const dcBlock = biquad(ctx, "highpass", 18, 0.7);
    this.gate.connect(dcBlock).connect(this.out);
    this.nodes.push(dcBlock);

    // Motor body.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 87;
    const lp = biquad(ctx, "lowpass", 420, 1.1);
    const g = gainNode(ctx, 0.09);
    chain(osc, lp, g, this.gate);

    // Gear whine, two octaves and a fifth up.
    const whine = ctx.createOscillator();
    whine.type = "triangle";
    whine.frequency.value = 87 * 6;
    const wbp = biquad(ctx, "bandpass", 87 * 6, 5);
    const wg = gainNode(ctx, 0.022);
    chain(whine, wbp, wg, this.gate);

    // Fuel rushing through the hose.
    const nz = loopSource(ctx, kit.pink);
    const nbp = biquad(ctx, "bandpass", 780, 0.8);
    const ng = gainNode(ctx, 0.05);
    chain(nz, nbp, ng, this.gate);

    this.rate = [osc.frequency, whine.frequency, wbp.frequency, nbp.frequency];
    this.baseRate = [87, 87 * 6, 87 * 6, 780];
    this.nodes.push(lp, g, wbp, wg, nbp, ng);
    this.sources.push(osc, whine, nz);
  }

  start(when: number): void {
    for (const s of this.sources) s.start(when);
  }

  spinUp(when: number): void {
    const p = this.gate.gain;
    holdAt(p, when);
    p.linearRampToValueAtTime(1.18, when + 0.62);
    p.setTargetAtTime(1, when + 0.62, 0.4);
    for (let i = 0; i < this.rate.length; i++) {
      const base = this.baseRate[i];
      const q = this.rate[i];
      holdAt(q, when);
      q.setValueAtTime(base * 0.52, when);
      q.exponentialRampToValueAtTime(base * 1.07, when + 0.7);
      q.setTargetAtTime(base, when + 0.7, 0.5);
    }
  }

  spinDown(when: number): void {
    const p = this.gate.gain;
    holdAt(p, when);
    p.setTargetAtTime(0, when, 0.22);
    p.linearRampToValueAtTime(0, when + 1.4);
    for (let i = 0; i < this.rate.length; i++) {
      const base = this.baseRate[i];
      const q = this.rate[i];
      holdAt(q, when);
      q.exponentialRampToValueAtTime(base * 0.42, when + 0.9);
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of [...this.nodes, ...this.sources, this.gate, this.out]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}
