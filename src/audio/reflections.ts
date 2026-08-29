import { biquad, clamp, gainNode } from "./dsp";

const SPEED_OF_SOUND = 343;

/**
 * Outdoor early reflections.
 *
 * A forecourt at dawn is not anechoic, but it is also not a room: there is no
 * reverberant tail worth modelling, because there are no opposing surfaces to
 * make one. What there *is* — and what a dry synthesised exterior conspicuously
 * lacks — is a handful of discrete early reflections: a slapback off the flat
 * block wall of the store, and a much shorter one off the underside of the fuel
 * canopy when you are standing beneath it.
 *
 * So this is two delay taps rather than a convolver. Cheaper (eleven nodes for
 * the whole scene against a partitioned FFT convolution), and *more* correct,
 * because the facade tap's delay is derived from the player's actual
 * perpendicular distance to the wall and therefore tracks as they walk, which
 * a fixed impulse response cannot do.
 *
 * The facade tap is split into two slightly different delays panned apart. A
 * real reflection off a twenty-metre wall arrives over a spread of angles, and
 * a single mono tap sounds like a guitar pedal.
 */
export class OutdoorReflections {
  readonly input: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly facade: { delay: DelayNode; gain: GainNode; skew: number }[] = [];
  private readonly canopyGain: GainNode;
  private lastDelay = -1;
  private lastFacade = -1;
  private lastCanopy = -1;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.input = gainNode(ctx, 1);

    for (const [skew, pan] of [
      [1.0, -0.65],
      [1.07, 0.65],
    ] as const) {
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.06 * skew;
      // Painted CMU is reflective but not bright, and the return path is long.
      const lp = biquad(ctx, "lowpass", 2400, 0.5);
      const hp = biquad(ctx, "highpass", 130, 0.5);
      const g = gainNode(ctx, 0);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      this.input.connect(delay);
      delay.connect(lp).connect(hp).connect(g).connect(p).connect(out);
      this.nodes.push(delay, lp, hp, g, p);
      this.facade.push({ delay, gain: g, skew });
    }

    // Canopy deck: about 3 m above head height, so a 6 m extra path. Short
    // enough to read as a tightening of the sound rather than an echo, which
    // is exactly what walking under a canopy does.
    const cd = ctx.createDelay(0.1);
    cd.delayTime.value = 0.0175;
    const clp = biquad(ctx, "lowpass", 3600, 0.6);
    this.canopyGain = gainNode(ctx, 0);
    this.input.connect(cd);
    cd.connect(clp).connect(this.canopyGain).connect(out);
    this.nodes.push(cd, clp, this.canopyGain);
  }

  /**
   * @param facadeDistance perpendicular metres from the player to the wall
   * @param facadeLevel    0..1, folds in lateral fall-off and interior mute
   * @param canopyLevel    0..1, how far under the canopy the player is
   */
  setGeometry(
    facadeDistance: number,
    facadeLevel: number,
    canopyLevel: number,
    now: number,
    /** 0 to jump. The offline harness needs the geometry exact at t=0. */
    smooth = 0.32
  ): void {
    const set = (p: AudioParam, v: number) => {
      if (smooth <= 0) p.setValueAtTime(v, now);
      else p.setTargetAtTime(v, now, smooth);
    };
    const t = clamp((2 * facadeDistance) / SPEED_OF_SOUND, 0.02, 0.24);
    if (Math.abs(t - this.lastDelay) > 0.0015) {
      // Slow enough that the resulting pitch shift on the reflection — the
      // player walks at 1.4 m/s, so the delay changes by under 1% per second —
      // stays well below audibility.
      for (const f of this.facade) set(f.delay.delayTime, t * f.skew);
      this.lastDelay = t;
    }
    // Inverse-square-ish on the extra path length, on top of the caller's own
    // geometric fall-off.
    const fg = facadeLevel * 0.5 * (9 / (9 + facadeDistance));
    if (Math.abs(fg - this.lastFacade) > 0.002) {
      for (const f of this.facade) set(f.gain.gain, fg);
      this.lastFacade = fg;
    }
    const cg = canopyLevel * 0.3;
    if (Math.abs(cg - this.lastCanopy) > 0.002) {
      set(this.canopyGain.gain, cg);
      this.lastCanopy = cg;
    }
  }

  dispose(): void {
    for (const n of [this.input, ...this.nodes]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
}
