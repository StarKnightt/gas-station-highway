import * as THREE from "three";
import { biquad, gainNode } from "./dsp";

export interface EmitterOptions {
  refDistance?: number;
  rolloffFactor?: number;
  maxDistance?: number;
  /** Interior sources are muffled from outside; exterior ones from inside. */
  zone: "interior" | "exterior";
  /** How much of this source is fed to the room convolver when inside. */
  reverbSend?: number;
  /** How much is fed to the outdoor early-reflection taps when outside. */
  reflectSend?: number;
}

/**
 * One spatialised point source.
 *
 * The chain is `input -> occlusion low-pass -> gain -> panner -> listener`,
 * with a parallel tap into the shared room convolver. The occlusion filter
 * has to sit *before* the panner, which means one per emitter rather than one
 * shared bus, but there are only about a dozen of them and the parameters are
 * only touched when they actually move.
 *
 * `PositionalAudio.updateMatrixWorld` early-outs unless `hasPlaybackControl`
 * is false, so the panner would never follow the object if we simply
 * connected our graph to `getOutput()`. Handing our chain to `setNodeSource`
 * is what clears that flag; it is the supported way to drive a
 * `PositionalAudio` from a synthesised graph instead of a decoded buffer.
 */
export class Emitter {
  readonly object = new THREE.Object3D();
  readonly audio: THREE.PositionalAudio;
  readonly input: BiquadFilterNode;
  readonly gain: GainNode;
  readonly send: GainNode;
  /** Tap into the outdoor early-reflection bus. Null for interior sources. */
  readonly reflect: GainNode | null = null;
  readonly zone: "interior" | "exterior";

  private lastCutoff = -1;
  private lastGain = -1;
  private lastSend = -1;
  private lastReflect = -1;
  private readonly baseSend: number;
  private readonly baseReflect: number;

  constructor(listener: THREE.AudioListener, reverbBus: AudioNode, o: EmitterOptions, reflectBus?: AudioNode | null) {
    const ctx = listener.context;
    this.zone = o.zone;
    this.baseSend = o.reverbSend ?? 0.35;
    this.baseReflect = o.reflectSend ?? 0;

    this.input = biquad(ctx, "lowpass", 22050, 0.6);
    this.gain = gainNode(ctx, 1);
    this.send = gainNode(ctx, 0);
    this.input.connect(this.gain);
    this.gain.connect(this.send);
    this.send.connect(reverbBus);

    if (reflectBus && this.baseReflect > 0) {
      this.reflect = gainNode(ctx, 0);
      this.gain.connect(this.reflect);
      this.reflect.connect(reflectBus);
    }

    this.audio = new THREE.PositionalAudio(listener);
    this.audio.setDistanceModel("inverse");
    this.audio.setRefDistance(o.refDistance ?? 3);
    this.audio.setRolloffFactor(o.rolloffFactor ?? 1);
    this.audio.setMaxDistance(o.maxDistance ?? 400);
    this.audio.setNodeSource(this.gain);
    this.object.add(this.audio);
  }

  setPosition(x: number, y: number, z: number): void {
    this.object.position.set(x, y, z);
  }

  /**
   * Applies the occlusion state. `setTargetAtTime` rather than a hard set so
   * walking through the doorway is a slide, not a switch; the epsilon guards
   * keep this from queueing automation every frame for a stationary player.
   */
  applyOcclusion(
    cutoff: number,
    gain: number,
    sendScale: number,
    now: number,
    smooth: number,
    reflectScale = 0
  ): void {
    if (Math.abs(cutoff - this.lastCutoff) > 12) {
      this.input.frequency.setTargetAtTime(cutoff, now, smooth);
      this.lastCutoff = cutoff;
    }
    if (Math.abs(gain - this.lastGain) > 0.004) {
      this.gain.gain.setTargetAtTime(gain, now, smooth);
      this.lastGain = gain;
    }
    const send = this.baseSend * sendScale;
    if (Math.abs(send - this.lastSend) > 0.004) {
      this.send.gain.setTargetAtTime(send, now, smooth);
      this.lastSend = send;
    }
    if (this.reflect) {
      const r = this.baseReflect * reflectScale;
      if (Math.abs(r - this.lastReflect) > 0.004) {
        this.reflect.gain.setTargetAtTime(r, now, smooth);
        this.lastReflect = r;
      }
    }
  }

  dispose(): void {
    try {
      this.audio.disconnect();
    } catch {
      /* already gone */
    }
    for (const n of [this.input, this.gain, this.send, this.reflect]) {
      if (!n) continue;
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.object.removeFromParent();
  }
}
