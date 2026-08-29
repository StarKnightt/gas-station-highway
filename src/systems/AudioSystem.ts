import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types";
import { BUILDING, FORECOURT, ISLANDS, ROAD } from "../site";
import type { BuildingAudioInfo, BuildingFootprint, StationAudio } from "../audio/api";
import { CoolerUnit, FluorescentBuzz, HighwayWash, PumpMotor } from "../audio/beds";
import { clamp, clamp01, gainNode, lerp, makeRng } from "../audio/dsp";
import { Emitter } from "../audio/emitter";
import { AudioKit } from "../audio/kit";
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
  type Rand,
  type VehicleVoice,
} from "../audio/oneshots";
import { OutdoorReflections } from "../audio/reflections";

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Used only if BuildingSystem is absent or has not published its services. */
const DEFAULT_DOOR = { x: -6.0, y: 1.15, z: BUILDING.minZ };
const DEFAULT_COOLER = { x: -5.0, y: 1.2, z: BUILDING.maxZ - 0.9 };
const DEFAULT_LIGHTS = [
  { x: -6.0, y: 2.7, z: 34.5 },
  { x: -1.0, y: 2.7, z: 37.0 },
];

interface VehicleEvent {
  emitter: Emitter;
  voice: VehicleVoice | null;
  active: boolean;
  /** Context time at which the vehicle is at closest approach. */
  tPass: number;
  tEnd: number;
  xAtPass: number;
  lane: number;
  speed: number;
  dir: 1 | -1;
  /** Last distance fed to the voice, so we only re-automate when it moves. */
  lastDistance: number;
}

/**
 * System 8: the entire soundscape, synthesised.
 *
 * There are no sample files anywhere in this project. Every sound is built
 * from oscillators, procedurally generated noise buffers, biquads and a
 * procedurally generated impulse response, which is why the whole thing costs
 * a few kilobytes of code and no download.
 *
 * The design target is quiet. Six sources total, most of them silent most of
 * the time: the defining sound is the distant highway, and the second most
 * important thing in the mix is the gap when the cooler compressor cycles off.
 */
export class AudioSystem implements GameSystem {
  readonly name = "audio";

  private sys!: SystemContext;
  private group = new THREE.Group();
  private building: BuildingAudioInfo = {};
  private footprint: BuildingFootprint | null = null;
  private entryDoor: THREE.Object3D | null = null;
  private entryDoorOpenAngle = 1;

  private listener: THREE.AudioListener | null = null;
  private kit: AudioKit | null = null;
  private ready = false;
  private armed = false;

  private convolver: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private reflections: OutdoorReflections | null = null;

  private highway: HighwayWash[] = [];
  private highwayEmitters: Emitter[] = [];
  private cooler: CoolerUnit | null = null;
  private coolerEmitter: Emitter | null = null;
  private fluorescents: FluorescentBuzz[] = [];
  private pumpMotor: PumpMotor | null = null;
  private pumpEmitters: Emitter[] = [];
  private doorEmitter: Emitter | null = null;
  private birdEmitter: Emitter | null = null;
  private vehicles: VehicleEvent[] = [];
  private allEmitters: Emitter[] = [];

  private rnd: Rand = makeRng(0xa11d10);
  private masterVolume = 0.85;
  private muted = false;
  private doorOpenAmount = 0;

  /* scheduling state */
  private nextVehicle = 0;
  private nextBird = 0;
  private coolerRunning = true;
  private coolerUntil = 0;
  private tickRate = 0;
  private nextTick = 0;
  private pumpBay = 0;
  private occlusionAccum = 0;

  init(sysCtx: SystemContext): void {
    this.sys = sysCtx;
    this.group.name = "audio-emitters";
    sysCtx.scene.add(this.group);

    // BuildingSystem publishes flat, dotted services rather than one object,
    // so read those directly; `buildingAudio` stays available as an override
    // for anything that wants to place emitters itself.
    const g = sysCtx.game;
    this.building = g.tryGet<BuildingAudioInfo>("buildingAudio") ?? {};
    this.footprint = g.tryGet<BuildingFootprint>("building.footprint") ?? null;
    this.entryDoor = g.tryGet<THREE.Object3D>("building.entryDoor") ?? null;
    if (this.entryDoor) {
      const a = (this.entryDoor.userData as { openAngle?: number }).openAngle;
      this.entryDoorOpenAngle = typeof a === "number" && Math.abs(a) > 1e-3 ? a : 1;
    }

    g.provide<StationAudio>("audio", this.api());

    // A screenshot run must not start an audio graph: it would only add jitter
    // to the frame budget the capture harness is timing against.
    if (sysCtx.shot) return;

    window.addEventListener("pointerdown", this.onGesture, { passive: true });
    window.addEventListener("keydown", this.onGesture);
    document.addEventListener("pointerlockchange", this.onGesture);
  }

  /* ------------------------------------------------------------------ */
  /* unlock                                                              */
  /* ------------------------------------------------------------------ */

  private onGesture = () => {
    // A failure in here is otherwise completely silent — the scene renders,
    // nothing throws where anyone can see it, and the soundscape is simply
    // absent, which is the exact failure mode NOTES.md is about.
    this.arm().catch((err) => console.error("[dawn-station] audio failed to start:", err));
  };

  /**
   * Builds the graph on the first user gesture. Creating an AudioContext
   * before one exists gets it in the `suspended` state and, in some browsers,
   * a console warning; there is nothing to be gained by building early, so
   * nothing is built until there is definitely a gesture to hang it on.
   */
  private async arm(): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    window.removeEventListener("pointerdown", this.onGesture);
    window.removeEventListener("keydown", this.onGesture);
    document.removeEventListener("pointerlockchange", this.onGesture);

    const listener = new THREE.AudioListener();
    this.listener = listener;
    this.sys.camera.add(listener);
    const ctx = listener.context;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Gesture was not accepted (some synthetic events are not). Leave the
        // graph built; the next real gesture resumes it.
      }
    }
    listener.setMasterVolume(this.muted ? 0 : this.masterVolume);

    const kit = new AudioKit(ctx);
    this.kit = kit;

    // Shared room reverb. Send-only: the dry path is each source's own panner.
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = kit.storeIr;
    const ret = gainNode(ctx, 0.9);
    conv.connect(ret).connect(listener.getInput());
    this.convolver = conv;
    this.reverbReturn = ret;
    this.reflections = new OutdoorReflections(ctx, listener.getInput());

    this.buildEmitters();

    const t0 = ctx.currentTime + 0.06;
    for (const h of this.highway) h.start(t0);
    for (const f of this.fluorescents) f.start(t0);
    this.cooler?.start(t0);
    this.pumpMotor?.start(t0);

    // Start the compressor already running, part-way through its cycle, so
    // the first thing the player hears is not a switch-on.
    this.cooler?.setRunning(true, t0, this.rnd);
    this.coolerRunning = true;
    this.coolerUntil = ctx.currentTime + 20 + this.rnd() * 60;

    this.nextVehicle = ctx.currentTime + 6 + this.rnd() * 14;
    this.nextBird = ctx.currentTime + 12 + this.rnd() * 40;

    this.ready = true;
  }

  private makeEmitter(
    zone: "interior" | "exterior",
    ref: number,
    rolloff: number,
    send: number,
    max = 400,
    reflect = 0
  ): Emitter {
    const e = new Emitter(
      this.listener!,
      this.convolver!,
      {
        zone,
        refDistance: ref,
        rolloffFactor: rolloff,
        maxDistance: max,
        reverbSend: send,
        reflectSend: reflect,
      },
      this.reflections?.input ?? null
    );
    this.group.add(e.object);
    this.allEmitters.push(e);
    return e;
  }

  private buildEmitters(): void {
    const kit = this.kit!;

    // Highway: three decorrelated points strung along the road so the wash
    // has width and turns with the player's head instead of sitting in one
    // spot. Slow rolloff — it is supposed to be everywhere.
    for (let i = 0; i < 3; i++) {
      // A distant diffuse wash is already spread out, so it gets only a token
      // reflection send; it is the discrete sources that sound anechoic.
      const e = this.makeEmitter("exterior", 26, 0.55, 0.12, 900, 0.1);
      e.setPosition((i - 1) * 95, 0.6, ROAD.laneWidth * 0.5);
      const bed = new HighwayWash(kit, i, 0.5);
      bed.out.connect(e.input);
      this.highway.push(bed);
      this.highwayEmitters.push(e);
    }

    // Cooler: tight rolloff so it is a presence inside and barely a hint from
    // the forecourt, which is exactly how a compressor behind glass behaves.
    const cp = this.building.coolerPosition ?? this.averagePosition("building.coolerDoors", 0.55) ?? DEFAULT_COOLER;
    this.coolerEmitter = this.makeEmitter("interior", 1.8, 1.7, 0.5, 60);
    this.coolerEmitter.setPosition(cp.x, cp.y, cp.z);
    this.cooler = new CoolerUnit(kit, 60, 1);
    this.cooler.out.connect(this.coolerEmitter.input);

    const lights = this.building.lightPositions ?? this.fixturePositions() ?? DEFAULT_LIGHTS;
    for (let i = 0; i < lights.length; i++) {
      const e = this.makeEmitter("interior", 1.4, 2.2, 0.3, 40);
      e.setPosition(lights[i].x, lights[i].y, lights[i].z);
      const bed = new FluorescentBuzz(kit, i, 1);
      bed.out.connect(e.input);
      this.fluorescents.push(bed);
    }

    // One motor bed, moved to whichever bay System 7 says is in use. Two
    // motors could never both run, so one is enough.
    this.pumpMotor = new PumpMotor(kit, 1);
    for (const island of ISLANDS) {
      for (const dx of [-2.7, 2.7]) {
        const e = this.makeEmitter("exterior", 2.2, 1.3, 0.4, 90, 0.4);
        e.setPosition(island.cx + dx, 1.15, island.cz);
        this.pumpEmitters.push(e);
      }
    }
    this.pumpMotor.out.connect(this.pumpEmitters[0].input);

    const dp = this.building.doorPosition ?? this.doorWorldPosition() ?? DEFAULT_DOOR;
    this.doorEmitter = this.makeEmitter("exterior", 1.6, 1.4, 0.75, 60, 0.45);
    this.doorEmitter.setPosition(dp.x, dp.y, dp.z);

    this.birdEmitter = this.makeEmitter("exterior", 8, 0.9, 0.1, 300, 0.35);
    this.birdEmitter.setPosition(30, 1.6, 40);

    for (let i = 0; i < 2; i++) {
      // Distance attenuation is the panner's job, not the voice's. An inverse
      // model with rolloff 1 is exactly 1/r past `refDistance`, and unlike a
      // gain curve baked from the geometry at spawn it keeps tracking while
      // the player walks — twenty metres over a ten-second pass, which is most
      // of the useful range of the curve. Air absorption is driven live from
      // the same distance in `updateVehicles`.
      const e = this.makeEmitter("exterior", 16, 1, 0.15, 1200, 0.15);
      e.setPosition(0, 0.6, ROAD.laneWidth * 0.5);
      this.vehicles.push({
        emitter: e,
        voice: null,
        active: false,
        tPass: 0,
        tEnd: 0,
        xAtPass: 0,
        lane: 0,
        speed: 25,
        dir: 1,
        lastDistance: -1,
      });
    }
  }

  /** Centroid of a published list of anchors, lifted by `yOffset`. */
  private averagePosition(key: string, yOffset = 0): { x: number; y: number; z: number } | null {
    const list = this.sys.game.tryGet<THREE.Object3D[]>(key);
    if (!list || list.length === 0) return null;
    const v = new THREE.Vector3();
    const acc = new THREE.Vector3();
    for (const o of list) acc.add(o.getWorldPosition(v));
    acc.divideScalar(list.length);
    return { x: acc.x, y: acc.y + yOffset, z: acc.z };
  }

  private fixturePositions(): { x: number; y: number; z: number }[] | null {
    const list = this.sys.game.tryGet<THREE.Object3D[]>("building.fluorescents");
    if (!list || list.length === 0) return null;
    // Two fixtures are plenty: the buzz is meant to be a property of the room,
    // not a set of point sources the player can walk between.
    const pick = [list[0], list[list.length - 1]];
    const v = new THREE.Vector3();
    return pick.map((o) => {
      o.getWorldPosition(v);
      return { x: v.x, y: v.y, z: v.z };
    });
  }

  private doorWorldPosition(): { x: number; y: number; z: number } | null {
    if (!this.entryDoor) return null;
    const v = this.entryDoor.getWorldPosition(new THREE.Vector3());
    // The hinge is at the jamb; the bell hangs over the middle of the leaf.
    return { x: v.x + 0.5, y: v.y + 2.0, z: v.z };
  }

  /* ------------------------------------------------------------------ */
  /* per frame                                                           */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (!this.ready || !this.listener) return;
    const ctx = this.listener.context;
    const now = ctx.currentTime;
    if (ctx.state !== "running") return;

    this.occlusionAccum += dt;
    if (this.occlusionAccum > 1 / 14) {
      this.updateOcclusion(now);
      this.occlusionAccum = 0;
    }

    this.updateVehicles(now);
    this.updateCooler(now);
    this.updateBirds(now);
    this.updateTicks(now);
  }

  /**
   * Interior / exterior crossfade.
   *
   * Two continuous scalars drive everything: `enclosure`, how sealed inside
   * the player is, and its complement for the sources that live indoors. The
   * open door reduces enclosure rather than bypassing it, so walking in with
   * the door swinging behind you is a slide rather than a switch — which is
   * the whole point of doing it as a filter and gain crossfade.
   */
  private updateOcclusion(now: number): void {
    const p = this.sys.camera.position;
    const inside = this.insideness(p.x, p.z);
    const door = clamp01(this.building.doorOpenAmount?.() ?? this.doorAngleAmount());

    const enclosure = inside * (1 - door * 0.72);
    const leak = (1 - inside) * (1 - door * 0.55);

    // Exterior sources, heard from indoors: low-passed hard and pulled back.
    const exCut = lerp(20000, 480, enclosure);
    const exGain = lerp(1, 0.26, enclosure);
    // Interior sources, heard from the forecourt: through glass, plus their
    // own tight distance rolloff.
    const inCut = lerp(20000, 820, leak);
    const inGain = lerp(1, 0.3, leak);

    for (const e of this.allEmitters) {
      if (e.zone === "exterior") e.applyOcclusion(exCut, exGain, enclosure, now, 0.18, 1 - inside);
      else e.applyOcclusion(inCut, inGain, inside, now, 0.18);
    }
    if (this.reverbReturn) {
      this.reverbReturn.gain.setTargetAtTime(lerp(0.15, 0.95, inside), now, 0.25);
    }
    this.updateReflections(p.x, p.z, inside, now);
  }

  /**
   * Geometry for the two outdoor reflection taps: perpendicular distance to
   * the storefront wall, how squarely the player is in front of it, and
   * whether they are under the canopy.
   */
  private updateReflections(x: number, z: number, inside: number, now: number): void {
    const r = this.reflections;
    if (!r) return;
    const f = this.footprint ?? BUILDING;

    // The wall only reflects at you if you are in front of it and not past
    // either end; beyond about forty metres the return is lost in the wash.
    const perp = f.minZ - z;
    const lateral = Math.max(f.minX - x, 0, x - f.maxX);
    const facade =
      perp > 1.0 && perp < 42
        ? (1 - smoothstep(30, 42, perp)) * (1 - smoothstep(5, 20, lateral)) * (1 - inside)
        : 0;

    const cx = Math.max(FORECOURT.minX - x, 0, x - FORECOURT.maxX);
    const cz = Math.max(FORECOURT.minZ - z, 0, z - FORECOURT.maxZ);
    const canopy = (1 - smoothstep(0, 2.5, Math.hypot(cx, cz))) * (1 - inside);

    r.setGeometry(Math.max(2, perp), facade, canopy, now);
  }

  /**
   * How open the storefront door is, taken from the leaf's own hinge rotation
   * so the crossfade tracks the animation rather than the event that started
   * it. Falls back to whatever `setDoorOpenAmount` was last told.
   */
  private doorAngleAmount(): number {
    if (!this.entryDoor) return this.doorOpenAmount;
    return clamp01(Math.abs(this.entryDoor.rotation.y / this.entryDoorOpenAngle));
  }

  /** 1 deep inside the sales floor, falling to 0 about a metre outside it. */
  private insideness(x: number, z: number): number {
    if (this.building.isInside) return this.building.isInside(x, z) ? 1 : 0;
    const f = this.footprint;
    const r = f
      ? { minX: f.minX + f.wallThickness, maxX: f.maxX - f.wallThickness, minZ: f.minZ + f.wallThickness, maxZ: f.maxZ - f.wallThickness }
      : BUILDING;
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    return 1 - smoothstep(0.0, 1.1, Math.hypot(dx, dz));
  }

  private updateVehicles(now: number): void {
    const cam = this.sys.camera.position;
    for (const v of this.vehicles) {
      if (!v.active) continue;
      if (now > v.tEnd) {
        v.active = false;
        v.voice = null;
        continue;
      }
      const x = v.xAtPass + v.speed * v.dir * (now - v.tPass);
      v.emitter.setPosition(x, 0.55, v.lane);

      // Air absorption from the real listener-to-vehicle distance, including
      // however far the player has walked since the pass began. Gated on a
      // half-metre of movement so a stationary player is not queueing
      // automation events sixty times a second.
      const d = Math.hypot(x - cam.x, 0.55 - cam.y, v.lane - cam.z);
      if (v.voice && Math.abs(d - v.lastDistance) > 0.5) {
        v.voice.setDistance(d, now);
        v.lastDistance = d;
      }
    }

    if (now < this.nextVehicle) return;
    const free = this.vehicles.find((v) => !v.active);
    // Intervals are re-rolled every time rather than drawn from a cycle: the
    // moment a listener can predict the next car, the road stops being real.
    this.nextVehicle = now + 20 + this.rnd() * 25;
    if (!free) return;

    const truck = this.rnd() < 0.22;
    const dir: 1 | -1 = this.rnd() < 0.5 ? 1 : -1;
    const lane = dir > 0 ? ROAD.laneWidth * 0.5 : -ROAD.laneWidth * 0.5;
    const p = this.sys.camera.position;
    const distance = Math.max(9, Math.abs(p.z - lane));
    const half = truck ? 8.5 : 5.5;
    const speed = truck ? 22 + this.rnd() * 4 : 25 + this.rnd() * 7;

    const t0 = now + 0.05;
    const play = truck ? playTruckPass : playCarPass;
    // Higher than the old baked levels because the panner now takes 1/r out of
    // the signal: at a typical 30 m the inverse model with refDistance 16 is
    // about -5.5 dB, which these compensate for.
    free.voice = play(this.kit!, free.emitter.input, t0, this.rnd, {
      distance,
      speed,
      half,
      gain: truck ? 0.95 : 0.75,
    });
    free.lastDistance = -1;

    free.active = true;
    free.tPass = t0 + half;
    free.tEnd = t0 + half * 2 + 0.3;
    free.xAtPass = p.x;
    free.lane = lane;
    free.speed = speed;
    free.dir = dir;
    free.emitter.setPosition(p.x - speed * dir * half, 0.55, lane);

    // A truck leaves a longer hole behind it.
    if (truck) this.nextVehicle += 12;
  }

  /**
   * The compressor duty cycle. Long runs, long silences, both randomised, and
   * a mechanical thunk at each transition.
   */
  private updateCooler(now: number): void {
    if (!this.cooler || now < this.coolerUntil) return;
    this.coolerRunning = !this.coolerRunning;
    this.cooler.setRunning(this.coolerRunning, now + 0.02, this.rnd);
    this.coolerUntil = this.coolerRunning ? now + 55 + this.rnd() * 65 : now + 28 + this.rnd() * 42;
  }

  private updateBirds(now: number): void {
    if (!this.birdEmitter || now < this.nextBird) return;
    this.nextBird = now + 34 + this.rnd() * 62;

    // Somewhere out in the scrub, never twice in the same place, and never so
    // close that it reads as a bird sitting on the player's shoulder.
    const p = this.sys.camera.position;
    const angle = this.rnd() * Math.PI * 2;
    const radius = 22 + this.rnd() * 40;
    const x = clamp(p.x + Math.cos(angle) * radius, -90, 90);
    const z = clamp(p.z + Math.sin(angle) * radius, -40, 90);
    this.birdEmitter.setPosition(x, 1.2 + this.rnd() * 3.5, z);
    playBird(this.kit!, this.birdEmitter.input, now + 0.03, this.rnd, 0.5);
  }

  private updateTicks(now: number): void {
    if (this.tickRate <= 0) return;
    const period = 1 / this.tickRate;
    // Schedule slightly ahead so the tick lands on a sample-accurate time
    // rather than on whenever the render loop happened to come round.
    while (this.nextTick < now + 0.12) {
      if (this.nextTick < now) this.nextTick = now + 0.02;
      playPumpTick(this.kit!, this.pumpEmitters[this.pumpBay].input, this.nextTick, this.rnd, 0.5);
      // Jitter both ways: a mechanical counter is driven by fuel flow, and
      // fuel flow is not a clock.
      this.nextTick += period * (0.86 + this.rnd() * 0.28);
    }
  }

  /* ------------------------------------------------------------------ */
  /* public interface                                                    */
  /* ------------------------------------------------------------------ */

  private api(): StationAudio {
    const self = this;
    return {
      get ready() {
        return self.ready;
      },

      playPumpStart(pumpIndex = 0) {
        if (!self.ready || !self.pumpMotor) return;
        const bay = clamp(Math.round(pumpIndex), 0, self.pumpEmitters.length - 1);
        if (bay !== self.pumpBay) {
          try {
            self.pumpMotor.out.disconnect();
          } catch {
            /* not connected */
          }
          self.pumpMotor.out.connect(self.pumpEmitters[bay].input);
          self.pumpBay = bay;
        }
        const now = self.listener!.context.currentTime + 0.02;
        playPumpClunk(self.kit!, self.pumpEmitters[bay].input, now, self.rnd, 0.5);
        self.pumpMotor.spinUp(now + 0.09);
      },

      setPumpTickRate(ticksPerSecond: number) {
        // Clamped: the scheduler fills a look-ahead window, so an accidental
        // rate of 10000 would build ten thousand voices in one frame.
        const r = clamp(ticksPerSecond, 0, 40);
        if (self.tickRate <= 0 && r > 0 && self.listener) {
          self.nextTick = self.listener.context.currentTime + 0.05;
        }
        self.tickRate = r;
      },

      playPumpStop() {
        if (!self.ready || !self.pumpMotor) return;
        self.tickRate = 0;
        const now = self.listener!.context.currentTime + 0.02;
        self.pumpMotor.spinDown(now);
        playPumpClunk(self.kit!, self.pumpEmitters[self.pumpBay].input, now + 0.16, self.rnd, 0.38);
      },

      playDoorOpen() {
        if (!self.ready) return;
        self.doorOpenAmount = 1;
        playDoorOpen(self.kit!, self.doorEmitter!.input, self.listener!.context.currentTime + 0.02, self.rnd, 0.5);
      },

      playDoorClose() {
        if (!self.ready) return;
        self.doorOpenAmount = 0;
        playDoorClose(self.kit!, self.doorEmitter!.input, self.listener!.context.currentTime + 0.02, self.rnd, 0.5);
      },

      setDoorOpenAmount(amount: number) {
        self.doorOpenAmount = clamp01(amount);
      },

      playFridgeOpen() {
        if (!self.ready) return;
        playFridgeOpen(self.kit!, self.coolerEmitter!.input, self.listener!.context.currentTime + 0.02, self.rnd, 0.5);
      },

      playFridgeClose() {
        if (!self.ready) return;
        playFridgeClose(self.kit!, self.coolerEmitter!.input, self.listener!.context.currentTime + 0.02, self.rnd, 0.5);
      },

      playBottleGrab() {
        if (!self.ready) return;
        playBottleGrab(self.kit!, self.coolerEmitter!.input, self.listener!.context.currentTime + 0.02, self.rnd, 0.5);
      },

      setMasterVolume(volume: number) {
        self.masterVolume = clamp01(volume);
        self.listener?.setMasterVolume(self.muted ? 0 : self.masterVolume);
      },
      getMasterVolume() {
        return self.masterVolume;
      },
      setMuted(muted: boolean) {
        self.muted = muted;
        self.listener?.setMasterVolume(muted ? 0 : self.masterVolume);
      },
      isMuted() {
        return self.muted;
      },
    };
  }

  /** Exposed for the door bell alone, so a future system can ring it directly. */
  ringBell(strength = 0.8): void {
    if (!this.ready) return;
    playBell(this.kit!, this.doorEmitter!.input, this.listener!.context.currentTime + 0.02, this.rnd, {
      gain: 0.5,
      strength,
    });
  }

  dispose(): void {
    window.removeEventListener("pointerdown", this.onGesture);
    window.removeEventListener("keydown", this.onGesture);
    document.removeEventListener("pointerlockchange", this.onGesture);

    this.ready = false;
    for (const h of this.highway) h.dispose();
    for (const f of this.fluorescents) f.dispose();
    this.cooler?.dispose();
    this.pumpMotor?.dispose();
    for (const e of this.allEmitters) e.dispose();
    this.allEmitters.length = 0;

    this.reflections?.dispose();
    try {
      this.convolver?.disconnect();
      this.reverbReturn?.disconnect();
    } catch {
      /* already gone */
    }
    if (this.listener) {
      this.listener.removeFromParent();
      // Suspended, not closed: `THREE.AudioContext` caches one context for the
      // whole page, so closing it would leave a second Game unable to ever
      // produce sound.
      const ctx = this.listener.context as AudioContext;
      if (typeof ctx.suspend === "function" && ctx.state === "running") void ctx.suspend();
    }
    this.group.removeFromParent();
  }
}
