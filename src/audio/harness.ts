import { CoolerUnit, FluorescentBuzz, HighwayWash, PumpMotor } from "./beds";
import { biquad, gainNode, makeRng } from "./dsp";
import { AudioKit } from "./kit";
import {
  playBell,
  playBird,
  playBottleGrab,
  playCarPass,
  playDoorClose,
  playDoorOpen,
  playFridgeClose,
  playFridgeOpen,
  playPumpClunk,
  playPumpTick,
  playTruckPass,
  type VehicleVoice,
} from "./oneshots";
import { OutdoorReflections } from "./reflections";

/**
 * Offline render harness.
 *
 * Nothing in this module is used by the game. It exists so `tools/audio.mjs`
 * can render every voice through `OfflineAudioContext` — the same synthesis
 * code the game runs, no stubs — pull the PCM back into node, and assert on
 * measured properties of the waveform rather than on the author's confidence.
 */

export const SAMPLE_RATE = 44100;

type Build = (ctx: OfflineAudioContext, kit: AudioKit, out: AudioNode) => void;

interface Case {
  seconds: number;
  build: Build;
  /** Stereo for anything that goes through a panner. Downmixed for analysis. */
  channels?: number;
}

/**
 * Renders a vehicle pass through the real spatial path: the same PannerNode
 * settings `AudioSystem` gives its vehicle emitters, a listener that moves the
 * way the player does, and `setDistance` called on the same schedule the game
 * calls it on.
 *
 * This is the only honest way to test the change from a baked amplitude arc to
 * panner-driven attenuation, because the thing under test *is* the panner.
 *
 * @param listenerZ perpendicular metres from the road at t=0 and at the end
 */
function spatialPass(
  ctx: OfflineAudioContext,
  kit: AudioKit,
  out: AudioNode,
  play: typeof playCarPass,
  seed: number,
  o: { speed: number; half: number; gain: number; listenerZ: [number, number] }
): VehicleVoice {
  const dur = o.half * 2;
  const t0 = 0.05;
  const N = 512;
  // The walk finishes before closest approach and the player then stands
  // still. Perpendicular distance only dominates within a few tens of metres
  // of the pass — at the edges of the event the vehicle is 145 m up the road
  // and where the listener is standing barely registers — so a walk spread
  // evenly across the whole ten seconds would put them at the *average* of
  // the two distances exactly when it mattered, and measure nothing.
  const zAt = (u: number) =>
    o.listenerZ[0] + (o.listenerZ[1] - o.listenerZ[0]) * Math.min(1, u / 0.4);
  const xAt = (u: number) => o.speed * (u - 0.5) * dur;

  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 16;
  panner.rolloffFactor = 1;
  panner.maxDistance = 1200;
  panner.connect(out);

  const px = new Float32Array(N);
  const pz = new Float32Array(N);
  const lz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    px[i] = xAt(u);
    pz[i] = 0;
    lz[i] = zAt(u);
  }
  panner.positionX.setValueCurveAtTime(px, t0, dur);
  panner.positionY.value = 0.55;
  panner.positionZ.setValueCurveAtTime(pz, t0, dur);
  ctx.listener.positionX.value = 0;
  ctx.listener.positionY.value = 1.65;
  ctx.listener.positionZ.setValueCurveAtTime(lz, t0, dur);

  const voice = play(kit, panner, t0, makeRng(seed), {
    distance: Math.abs(o.listenerZ[0]),
    speed: o.speed,
    half: o.half,
    gain: o.gain,
  });

  // 20 Hz, the rate `AudioSystem` reaches with its half-metre movement gate.
  for (let t = 0; t < dur; t += 0.05) {
    const u = t / dur;
    voice.setDistance(Math.hypot(xAt(u), 0.55 - 1.65, zAt(u)), t0 + t);
  }
  return voice;
}

/**
 * Occlusion settings copied from `AudioSystem.updateOcclusion`, so the two
 * interior/exterior cases measure the filter the game actually applies rather
 * than one invented for the test.
 */
export const OCCLUSION = {
  outside: { cutoff: 20000, gain: 1 },
  inside: { cutoff: 480, gain: 0.26 },
};

function occluded(ctx: OfflineAudioContext, out: AudioNode, cutoff: number, gain: number): AudioNode {
  const lp = biquad(ctx, "lowpass", cutoff, 0.6);
  const g = gainNode(ctx, gain);
  lp.connect(g).connect(out);
  return lp;
}

/** Every renderable case. Names are what appear in the report and the plots. */
export const CASES: Record<string, Case> = {
  bell: {
    seconds: 1.6,
    build: (_c, kit, out) => {
      playBell(kit, out, 0.05, makeRng(11), { gain: 0.7, strength: 0.9, rattle: false });
    },
  },
  bell_with_rattle: {
    seconds: 1.6,
    build: (_c, kit, out) => {
      // Same seed as `bell` on purpose: the first strike is then bit-identical,
      // so subtracting the two isolates the return-swing contacts exactly.
      playBell(kit, out, 0.05, makeRng(11), { gain: 0.7, strength: 0.9 });
    },
  },
  door_open: {
    seconds: 2.8,
    build: (_c, kit, out) => {
      playDoorOpen(kit, out, 0.05, makeRng(21), 0.7);
    },
  },
  door_close: {
    seconds: 2.8,
    build: (_c, kit, out) => {
      playDoorClose(kit, out, 0.05, makeRng(22), 0.7);
    },
  },
  fridge_hum: {
    seconds: 6.0,
    build: (_c, kit, out) => {
      const u = new CoolerUnit(kit, 60, 1.6);
      u.out.connect(out);
      u.start(0);
      u.setRunning(true, 0.02, makeRng(31));
    },
  },
  fridge_cycle: {
    seconds: 10.0,
    build: (_c, kit, out) => {
      const u = new CoolerUnit(kit, 60, 1.6);
      u.out.connect(out);
      u.start(0);
      u.setRunning(true, 0.3, makeRng(32));
      u.setRunning(false, 5.0, makeRng(33));
      u.setRunning(true, 8.0, makeRng(34));
    },
  },
  fluorescent: {
    seconds: 3.0,
    build: (_c, kit, out) => {
      const f = new FluorescentBuzz(kit, 0, 4);
      f.out.connect(out);
      f.start(0);
    },
  },
  highway_wash: {
    seconds: 12.0,
    build: (_c, kit, out) => {
      for (let i = 0; i < 3; i++) {
        const h = new HighwayWash(kit, i, 0.9);
        h.out.connect(out);
        h.start(0);
      }
    },
  },
  highway_outside: {
    seconds: 4.0,
    build: (c, kit, out) => {
      const dst = occluded(c, out, OCCLUSION.outside.cutoff, OCCLUSION.outside.gain);
      for (let i = 0; i < 3; i++) {
        const h = new HighwayWash(kit, i, 0.9);
        h.out.connect(dst);
        h.start(0);
      }
    },
  },
  highway_inside: {
    seconds: 4.0,
    build: (c, kit, out) => {
      const dst = occluded(c, out, OCCLUSION.inside.cutoff, OCCLUSION.inside.gain);
      for (let i = 0; i < 3; i++) {
        const h = new HighwayWash(kit, i, 0.9);
        h.out.connect(dst);
        h.start(0);
      }
    },
  },
  car_pass: {
    seconds: 11.0,
    channels: 2,
    build: (c, kit, out) => {
      spatialPass(c, kit, out, playCarPass, 41, { speed: 29, half: 5.0, gain: 0.85, listenerZ: [26, 26] });
    },
  },
  car_pass_walking: {
    seconds: 11.0,
    channels: 2,
    build: (c, kit, out) => {
      // Identical pass, identical seed, but the player walks in from 26 m to
      // 13 m during the approach and then stands. `distance` — the only thing
      // still baked, and only for the Doppler geometry — is left at 26, so if
      // level were still baked from it this render would be indistinguishable
      // from `car_pass`.
      spatialPass(c, kit, out, playCarPass, 41, { speed: 29, half: 5.0, gain: 0.85, listenerZ: [26, 13] });
    },
  },
  car_pass_near: {
    seconds: 11.0,
    channels: 2,
    build: (c, kit, out) => {
      // Reference: the same pass heard from a listener who was already
      // standing at 13 m. `car_pass_walking` should converge on this.
      spatialPass(c, kit, out, playCarPass, 41, { speed: 29, half: 5.0, gain: 0.85, listenerZ: [13, 13] });
    },
  },
  truck_pass: {
    seconds: 17.5,
    channels: 2,
    build: (c, kit, out) => {
      spatialPass(c, kit, out, playTruckPass, 42, { speed: 24, half: 8.5, gain: 0.85, listenerZ: [30, 30] });
    },
  },
  pump_start: {
    seconds: 3.5,
    build: (_c, kit, out) => {
      const m = new PumpMotor(kit, 1.4);
      m.out.connect(out);
      m.start(0);
      playPumpClunk(kit, out, 0.05, makeRng(51), 0.7);
      m.spinUp(0.14);
    },
  },
  pump_stop: {
    seconds: 3.5,
    build: (_c, kit, out) => {
      const m = new PumpMotor(kit, 1.4);
      m.out.connect(out);
      m.start(0);
      m.spinUp(0.02);
      m.spinDown(1.2);
      playPumpClunk(kit, out, 1.36, makeRng(52), 0.5);
    },
  },
  pump_ticks: {
    seconds: 6.0,
    build: (_c, kit, out) => {
      // Exactly the scheduler in AudioSystem.updateTicks, at 4 ticks/second.
      const rnd = makeRng(53);
      const period = 1 / 4;
      let t = 0.05;
      while (t < 5.9) {
        playPumpTick(kit, out, t, rnd, 0.9);
        t += period * (0.86 + rnd() * 0.28);
      }
    },
  },
  pump_ticks_unjittered: {
    seconds: 6.0,
    build: (_c, kit, out) => {
      // Control case: the same ticks on a perfect grid. The onset analysis has
      // to be able to tell these two apart, otherwise it proves nothing.
      const rnd = makeRng(53);
      for (let t = 0.05; t < 5.9; t += 0.25) playPumpTick(kit, out, t, rnd, 0.9);
    },
  },
  bird: {
    seconds: 1.6,
    build: (_c, kit, out) => {
      playBird(kit, out, 0.05, makeRng(61), 0.9);
    },
  },
  fridge_door_open: {
    seconds: 1.4,
    build: (_c, kit, out) => {
      playFridgeOpen(kit, out, 0.05, makeRng(71), 0.8);
    },
  },
  fridge_door_close: {
    seconds: 1.4,
    build: (_c, kit, out) => {
      playFridgeClose(kit, out, 0.05, makeRng(72), 0.8);
    },
  },
  bottle_grab: {
    seconds: 1.0,
    build: (_c, kit, out) => {
      playBottleGrab(kit, out, 0.05, makeRng(81), 0.9);
    },
  },
  reflections_wet: {
    seconds: 1.6,
    channels: 2,
    build: (c, kit, out) => {
      // Bell into the outdoor reflection bus only, no dry path, standing 12 m
      // out from the storefront wall. The first arrival is then the facade
      // reflection itself, and its lateness against the dry `bell` case is the
      // measurement.
      const r = new OutdoorReflections(c, out);
      r.setGeometry(12, 1, 0, 0, 0);
      playBell(kit, r.input, 0.05, makeRng(11), { gain: 0.7, strength: 0.9, rattle: false });
    },
  },
  store_ir: {
    seconds: 1.0,
    build: (c, kit, out) => {
      // The interior convolver's own impulse response, played dry.
      const imp = c.createBuffer(1, 2, SAMPLE_RATE);
      imp.getChannelData(0)[0] = 1;
      const src = c.createBufferSource();
      src.buffer = imp;
      const conv = c.createConvolver();
      conv.normalize = true;
      conv.buffer = kit.storeIr;
      src.connect(conv).connect(out);
      src.start(0.01);
    },
  },
};

export interface RenderResult {
  /** Mono (channel-averaged) samples, base64 little-endian Float32. */
  b64: string;
  /**
   * Largest absolute sample across *any* channel, before the downmix. The
   * clipping check has to see this rather than the average, which can hide a
   * hot channel.
   */
  peak: number;
  channels: number;
}

export async function renderCase(name: string): Promise<{ data: Float32Array; peak: number; channels: number }> {
  const spec = CASES[name];
  if (!spec) throw new Error(`no such audio case: ${name}`);
  const channels = spec.channels ?? 1;
  const ctx = new OfflineAudioContext(channels, Math.ceil(SAMPLE_RATE * spec.seconds), SAMPLE_RATE);
  const kit = new AudioKit(ctx);
  const master = gainNode(ctx, 1);
  master.connect(ctx.destination);
  spec.build(ctx, kit, master);
  const buf = await ctx.startRendering();

  const n = buf.length;
  const data = new Float32Array(n);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      data[i] += ch[i] / buf.numberOfChannels;
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return { data, peak, channels: buf.numberOfChannels };
}

/** Raw little-endian Float32 samples plus the true peak, for transport to node. */
export async function renderCaseBase64(name: string): Promise<RenderResult> {
  const { data, peak, channels } = await renderCase(name);
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { b64: btoa(s), peak, channels };
}

declare global {
  interface Window {
    __AUDIO_HARNESS?: {
      cases: string[];
      sampleRate: number;
      render: (name: string) => Promise<RenderResult>;
    };
  }
}

window.__AUDIO_HARNESS = {
  cases: Object.keys(CASES),
  sampleRate: SAMPLE_RATE,
  render: renderCaseBase64,
};
