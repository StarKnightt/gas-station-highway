import { ballastBuffer, brownNoiseBuffer, pinkNoiseBuffer, roomImpulse, whiteNoiseBuffer } from "./dsp";

/**
 * Per-context bag of shared, expensive-to-build assets.
 *
 * Noise buffers are several seconds of Float32 each; generating one per voice
 * would allocate megabytes per car pass. Every voice pulls from here instead,
 * and `AudioBufferSourceNode`s are cheap views onto the shared buffer.
 */
export class AudioKit {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly pinkB: AudioBuffer;
  readonly brown: AudioBuffer;
  /** 120 Hz ballast impulse train, shared by every ceiling fixture. */
  readonly ballast: AudioBuffer;
  /** Small hard interior: the store. */
  readonly storeIr: AudioBuffer;

  constructor(readonly ctx: BaseAudioContext) {
    this.white = whiteNoiseBuffer(ctx, 2.0, 0x1a2b);
    this.pink = pinkNoiseBuffer(ctx, 6.0, 0x51f3);
    // A second, decorrelated pink buffer: playing one buffer into two panners
    // gives a phantom centre image rather than a wide wash.
    this.pinkB = pinkNoiseBuffer(ctx, 6.0, 0x9d17);
    this.brown = brownNoiseBuffer(ctx, 4.0, 0x2c81);
    // Eight whole seconds: an exact number of 120 Hz periods, so it loops
    // without a seam, and long enough that the irregular strike pattern does
    // not audibly repeat.
    this.ballast = ballastBuffer(ctx, 8, 120, 0x7b1e);

    this.storeIr = roomImpulse(ctx, {
      seconds: 0.85,
      decay: 0.62,
      predelay: 0.006,
      brightness: 0.55,
      earlyTimes: [0.0068, 0.0104, 0.0151, 0.0212, 0.0277, 0.0361, 0.0498, 0.0662],
      seed: 0x5150,
    });
  }
}
