import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types";
import type { StationAudio } from "../audio/api";
import type { PumpFaceHandle } from "./PumpSystem";
import { COOLER_CLOSER, DOOR_CLOSER, InteractHinge } from "./interactHinge";

/**
 * System 7 — the three things you can do here.
 *
 * Fuel a pump, work the storefront door, open the cooler and take a bottle.
 * That is the whole list. There is no HUD, no crosshair, no prompt and no
 * inventory: the only affordance is that you are stood in front of something
 * real, close enough to touch it, and the world responds when you press the
 * button. Everything this system publishes to the player is diegetic.
 *
 * It owns no geometry. Every object it drives belongs to another system and is
 * reached through the service registry, so every lookup is optional and every
 * failure is local: a missing pump handle must not stop the door working.
 * `window.__INTERACT` reports which services resolved and which did not.
 *
 * Verification note, per NOTES.md: this project has a long history of correct
 * code never reaching the screen. Everything here is observable in numbers —
 * `window.__INTERACT.state()` returns the live door angle, the metered gallons,
 * the tick rate and the bottle's position, and `window.__INTERACT.calls` is the
 * log of every call made out to audio and lighting. The headless harness
 * asserts on those rather than on pixels.
 */

/** How far you can reach. Past this you are looking at it, not touching it. */
const REACH_M = 2.2;

/** US retail dispensers run around 9 gpm on the regular grade. */
const FLOW_GPM = 9.2;
const FLOW_GPS = FLOW_GPM / 60;
/** Motor and meter take a moment to come up to rate. */
const SPINUP_S = 1.15;
/** Metering clicks per gallon delivered. 45 gives ~6.9 Hz at full flow. */
const TICKS_PER_GALLON = 45;
/** A sedan's tank. The nozzle clicks off here rather than running forever. */
const TANK_GALLONS = 13.6;
/** The last of the fill, where the flow tapers before the auto shut-off. */
const TAPER_GALLONS = 0.45;
/** Walk this far from the face you are fuelling and the handle drops out. */
const ABANDON_M = 3.2;

/** Nozzle travel, and the step it is quantised to. Each change rebuilds the hose. */
const NOZZLE_LIFT = 0.8;
const NOZZLE_RATE = 1.6;
const NOZZLE_STEP = 1 / 24;

/** Canvas redraw ceiling for the price head. The cents digit spins faster than this. */
const DISPLAY_HZ = 18;

/** Where a carried bottle sits, in camera space. Low and to the right, half out of frame. */
const HAND_OFFSET = new THREE.Vector3(0.235, -0.235, -0.44);
const CARRY_LIFT_S = 0.55;
/** Exponential follow constant for the carried bottle, 1/s. Lower lags more. */
const CARRY_LAG = 9.0;

type Target =
  | { kind: "pump"; face: PumpFaceHandle; pumpIndex: number }
  | { kind: "door" }
  | { kind: "cooler"; index: number }
  | { kind: "bottle"; mesh: THREE.Object3D };

interface FuelSession {
  face: PumpFaceHandle;
  pumpIndex: number;
  gallons: number;
  dollars: number;
  price: number;
  /** Current delivery rate, gal/s. The single source for digits AND ticks. */
  flow: number;
  elapsed: number;
  tickRate: number;
  lastDraw: number;
  stopping: boolean;
}

interface CarryState {
  mesh: THREE.Object3D;
  /** 0 at the shelf, 1 once it is in hand. */
  t: number;
  from: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

interface CallRecord {
  name: string;
  value: number;
  t: number;
}

declare global {
  interface Window {
    __INTERACT?: InteractReport;
  }
}

export interface InteractReport {
  /** Which registry services resolved, and how many objects came out of each. */
  services: Record<string, number | boolean>;
  /** Everything this system has sent to audio and lighting, newest last. */
  calls: CallRecord[];
  state(): unknown;
  /** Point the camera. Test hook — the player uses the mouse. */
  look(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
  /** Fire one interaction down the camera forward vector. Returns what it hit. */
  click(): { kind: string; name: string; distance: number } | null;
  /** What the ray is on right now, without acting on it. */
  probe(): { kind: string; name: string; distance: number } | null;
}

export class InteractionSystem implements GameSystem {
  readonly name = "interaction";

  private ctx!: SystemContext;
  private raycaster = new THREE.Raycaster();
  private centre = new THREE.Vector2(0, 0);

  private audio: StationAudio | null = null;
  private lightingDoor: ((a: number) => void) | null = null;

  /** Pickable roots, and the target each one belongs to. */
  private roots: THREE.Object3D[] = [];
  private byRoot = new Map<THREE.Object3D, Target>();

  private door: InteractHinge | null = null;
  private coolers: InteractHinge[] = [];
  private session: FuelSession | null = null;
  private carry: CarryState | null = null;
  private nozzleTarget = 0;
  private nozzleNow = 0;

  /** Last values pushed out, so a no-op frame does not spam the log. */
  private sentDoorAmount = -1;
  private sentTickRate = -1;

  private calls: CallRecord[] = [];
  private services: Record<string, number | boolean> = {};
  private pending: { fn: () => void; t: number }[] = [];
  private elapsed = 0;
  private resolved = false;

  /* ------------------------------------------------------------------ */

  init(ctx: SystemContext): void {
    this.ctx = ctx;
    this.raycaster.far = REACH_M + 0.4;

    // Pointer, not click: the audio system arms on the same `pointerdown`, and
    // acting here rather than on `click` means the very first press both
    // unlocks the context and performs the interaction. The one-shots fired
    // before the graph exists are queued and flushed below, so nothing is lost.
    ctx.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);

    window.__INTERACT = {
      services: this.services,
      calls: this.calls,
      state: () => this.snapshot(),
      look: (px, py, pz, tx, ty, tz) => {
        const cam = this.ctx.camera;
        cam.position.set(px, py, pz);
        cam.up.set(0, 1, 0);
        cam.rotation.set(0, 0, 0);
        cam.lookAt(tx, ty, tz);
        cam.updateMatrixWorld(true);
      },
      click: () => {
        this.resolveTargets();
        const hit = this.pick();
        if (hit) this.act(hit.target);
        return hit ? { kind: hit.target.kind, name: hit.name, distance: hit.distance } : null;
      },
      probe: () => {
        this.resolveTargets();
        const hit = this.pick();
        return hit ? { kind: hit.target.kind, name: hit.name, distance: hit.distance } : null;
      },
    };
  }

  /**
   * Pull the other systems' handles off the registry. Deferred to the first
   * frame rather than done in `init`, and every single lookup is optional:
   * several of these systems are mid-iteration, and one of them failing to
   * initialise must cost us that one interaction and nothing else.
   */
  private resolveTargets(): void {
    if (this.resolved) return;
    this.resolved = true;
    const game = this.ctx.game;

    this.audio = game.tryGet<StationAudio>("audio") ?? null;
    this.services.audio = !!this.audio;

    this.lightingDoor =
      game.tryGet<(a: number) => void>("lighting.setDoorOpenAmount") ??
      game.tryGet<{ setDoorOpenAmount?: (a: number) => void }>("lighting")?.setDoorOpenAmount ??
      null;
    this.services.lightingDoorHook = !!this.lightingDoor;

    /* ---- pumps ---- */
    const faces = game.tryGet<PumpFaceHandle[]>("pumpFaces");
    let pumpRoots = 0;
    if (Array.isArray(faces)) {
      for (const face of faces) {
        if (!face || typeof face.setActive !== "function" || !Array.isArray(face.pickables)) continue;
        const m = /pump-(\d+)/.exec(face.name ?? "");
        const pumpIndex = m ? Math.max(0, Number(m[1]) - 1) : 0;
        for (const p of face.pickables) {
          if (!p) continue;
          this.addRoot(p, { kind: "pump", face, pumpIndex });
          pumpRoots++;
        }
      }
    }
    this.services.pumpFaces = Array.isArray(faces) ? faces.length : 0;
    this.services.pumpPickables = pumpRoots;

    /* ---- storefront door ---- */
    const entry = game.tryGet<THREE.Object3D>("building.entryDoor");
    if (entry && typeof entry.rotation?.y === "number") {
      this.door = new InteractHinge(entry, DOOR_CLOSER);
      this.addRoot(entry, { kind: "door" });
    }
    this.services.entryDoor = !!this.door;

    /* ---- cooler doors ---- */
    const cooler = game.tryGet<THREE.Object3D[]>("building.coolerDoors");
    if (Array.isArray(cooler)) {
      cooler.forEach((pivot) => {
        if (!pivot) return;
        this.coolers.push(new InteractHinge(pivot, COOLER_CLOSER));
        this.addRoot(pivot, { kind: "cooler", index: this.coolers.length - 1 });
      });
    }
    this.services.coolerDoors = this.coolers.length;

    /* ---- the bottle ---- */
    const grabbables = game.tryGet<THREE.Object3D[]>("building.grabbables");
    const single = game.tryGet<THREE.Object3D | null>("building.grabBottle");
    const list = Array.isArray(grabbables) && grabbables.length ? grabbables : single ? [single] : [];
    for (const mesh of list) {
      if (!mesh) continue;
      this.addRoot(mesh, { kind: "bottle", mesh });
    }
    this.services.grabbables = list.length;

    // Push the door state we adopted out to audio and lighting straight away,
    // so nobody is left believing a door that BuildingSystem parked open is shut.
    if (this.door) this.publishDoorAmount(this.door.amount, true);
  }

  private addRoot(o: THREE.Object3D, t: Target): void {
    if (this.byRoot.has(o)) return;
    this.byRoot.set(o, t);
    this.roots.push(o);
  }

  /* ------------------------------------------------------------------ */
  /* picking                                                             */
  /* ------------------------------------------------------------------ */

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.resolveTargets();
    const hit = this.pick();
    if (hit) this.act(hit.target);
  };

  /**
   * One ray, straight down the camera's forward vector — the player is pointer
   * locked, so the screen centre and the look direction are the same thing.
   */
  private pick(): { target: Target; name: string; distance: number } | null {
    if (!this.roots.length) return null;
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this.raycaster.setFromCamera(this.centre, cam);
    this.raycaster.far = REACH_M;

    const hits = this.raycaster.intersectObjects(this.roots, true);
    for (const h of hits) {
      if (h.distance > REACH_M) break;
      const target = this.resolve(h.object);
      if (!target) continue;
      // A bottle already in hand is not something you can pick up again.
      if (target.kind === "bottle" && this.carry?.mesh === target.mesh) continue;
      return { target, name: this.label(target), distance: h.distance };
    }
    return null;
  }

  private resolve(o: THREE.Object3D | null): Target | null {
    let node: THREE.Object3D | null = o;
    while (node) {
      const t = this.byRoot.get(node);
      if (t) return t;
      node = node.parent;
    }
    return null;
  }

  private label(t: Target): string {
    switch (t.kind) {
      case "pump":
        return t.face.name ?? "pump";
      case "door":
        return "entry-door";
      case "cooler":
        return `cooler-door-${t.index}`;
      case "bottle":
        return t.mesh.name || "bottle";
    }
  }

  private act(t: Target): void {
    switch (t.kind) {
      case "pump":
        if (this.session && this.session.face === t.face) this.stopFuelling();
        else this.startFuelling(t.face, t.pumpIndex);
        break;
      case "door":
        this.toggleDoor();
        break;
      case "cooler":
        this.toggleCooler(t.index);
        break;
      case "bottle":
        this.grab(t.mesh);
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 1. the pump                                                         */
  /* ------------------------------------------------------------------ */

  private startFuelling(face: PumpFaceHandle, pumpIndex: number): void {
    if (this.session) this.stopFuelling();

    let price = 3.499;
    try {
      const d = face.getDisplay?.();
      if (d && Number.isFinite(d.price) && d.price > 0) price = d.price;
    } catch {
      /* a face that cannot report its price still pumps at the default */
    }

    this.session = {
      face,
      pumpIndex,
      gallons: 0,
      dollars: 0,
      price,
      flow: 0,
      elapsed: 0,
      tickRate: 0,
      lastDraw: 0,
      stopping: false,
    };

    // Zero the sale, then authorise. `resetDisplay()` would also clear the
    // active flag, which is the opposite of what is wanted here.
    this.safely(() => face.setDisplay({ dollars: 0, gallons: 0 }));
    this.safely(() => face.setActive(true));
    this.lastFuelledFace = face;
    this.nozzleTarget = NOZZLE_LIFT;
    this.fire("playPumpStart", pumpIndex, (a) => a.playPumpStart(pumpIndex));
  }

  private stopFuelling(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.nozzleTarget = 0;
    this.setTickRate(0);
    this.safely(() => s.face.setActive(false));
    // The sale stays on the head after the handle goes back, the way it does
    // on a real forecourt until the next customer lifts the nozzle.
    this.drawDisplay(s);
    this.fire("playPumpStop", 0, (a) => a.playPumpStop());
  }

  private updateFuelling(dt: number): void {
    const s = this.session;
    if (!s) return;
    s.elapsed += dt;

    // Walking off mid-fill drops the handle, same as clicking again.
    const stand = s.face.standPosition;
    if (stand && this.ctx.camera.position.distanceTo(stand) > ABANDON_M) {
      this.stopFuelling();
      return;
    }

    // ONE state variable behind the digits and the ticking. The digits are
    // integrated from `flow` and the tick rate is derived from `flow` in the
    // same breath, so the counter and the sound physically cannot drift.
    const spinup = smoothstep(0, SPINUP_S, s.elapsed);
    const left = TANK_GALLONS - s.gallons;
    const taper = smoothstep(0, TAPER_GALLONS, left);
    s.flow = FLOW_GPS * spinup * taper;

    s.gallons = Math.min(TANK_GALLONS, s.gallons + s.flow * dt);
    s.dollars = s.gallons * s.price;
    this.setTickRate(s.flow * TICKS_PER_GALLON);

    if (s.elapsed - s.lastDraw >= 1 / DISPLAY_HZ) this.drawDisplay(s);

    // Auto shut-off: the nozzle clicks out when the tank fills.
    if (s.gallons >= TANK_GALLONS - 1e-4) this.stopFuelling();
  }

  /**
   * Repaint the price head. Capped at DISPLAY_HZ because each call redraws a
   * 1024x512 canvas and re-uploads it; the hundredths digit on a real pump
   * spins faster than the eye resolves anyway.
   */
  private drawDisplay(s: FuelSession): void {
    s.lastDraw = s.elapsed;
    this.safely(() =>
      s.face.setDisplay({
        gallons: Math.round(s.gallons * 1000) / 1000,
        dollars: Math.round(s.dollars * 100) / 100,
      })
    );
  }

  private setTickRate(rate: number): void {
    const r = Math.max(0, Math.min(40, rate));
    if (Math.abs(r - this.sentTickRate) < 0.05 && !(r === 0 && this.sentTickRate !== 0)) return;
    this.sentTickRate = r;
    if (this.session) this.session.tickRate = r;
    this.fire("setPumpTickRate", r, (a) => a.setPumpTickRate(r));
  }

  private updateNozzle(dt: number): void {
    if (Math.abs(this.nozzleNow - this.nozzleTarget) < 1e-3) return;
    const step = NOZZLE_RATE * dt;
    this.nozzleNow =
      this.nozzleNow < this.nozzleTarget
        ? Math.min(this.nozzleTarget, this.nozzleNow + step)
        : Math.max(this.nozzleTarget, this.nozzleNow - step);
    // Quantised: every distinct value re-solves the catenary and rebuilds a
    // 120-segment tube, so 24 steps across the travel rather than one a frame.
    const q = Math.round(this.nozzleNow / NOZZLE_STEP) * NOZZLE_STEP;
    const face = this.session?.face ?? this.lastFuelledFace;
    if (face) this.safely(() => face.setNozzleLift(q));
  }

  private lastFuelledFace: PumpFaceHandle | null = null;

  /* ------------------------------------------------------------------ */
  /* 2. the storefront door                                              */
  /* ------------------------------------------------------------------ */

  private toggleDoor(): void {
    if (!this.door) return;
    const opening = this.door.toggle();
    // The bell is on the way in. The latch clunk is fired from the swing, at
    // the moment the leaf actually reaches the strike, not when it was pushed.
    if (opening) this.fire("playDoorOpen", 1, (a) => a.playDoorOpen());
  }

  private updateDoor(dt: number): void {
    const d = this.door;
    if (!d) return;
    const step = d.update(dt);
    if (step.moved) this.publishDoorAmount(d.amount, false);
    if (step.latched) {
      this.publishDoorAmount(0, true);
      this.fire("playDoorClose", 0, (a) => a.playDoorClose());
    }
  }

  /**
   * The one place the door's openness leaves this system. Audio crossfades the
   * outside into the room on it, lighting scales the sun spill on it, and both
   * are driven from the same number on the same frame as the transform — so
   * the sound, the light and the leaf can never disagree.
   */
  private publishDoorAmount(amount: number, force: boolean): void {
    const a = Math.max(0, Math.min(1, amount));
    if (!force && Math.abs(a - this.sentDoorAmount) < 0.002) return;
    this.sentDoorAmount = a;
    this.record("setDoorOpenAmount", a);
    try {
      this.audio?.setDoorOpenAmount(a);
    } catch (err) {
      console.error("[interaction] audio.setDoorOpenAmount failed", err);
    }
    try {
      this.lightingDoor?.(a);
      this.record("lighting.setDoorOpenAmount", a);
    } catch (err) {
      console.error("[interaction] lighting.setDoorOpenAmount failed", err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3. the cooler and the bottle                                        */
  /* ------------------------------------------------------------------ */

  private toggleCooler(index: number): void {
    const h = this.coolers[index];
    if (!h) return;
    const opening = h.toggle();
    if (opening) this.fire("playFridgeOpen", index, (a) => a.playFridgeOpen());
  }

  private updateCoolers(dt: number): void {
    for (let i = 0; i < this.coolers.length; i++) {
      const step = this.coolers[i].update(dt);
      if (step.latched) this.fire("playFridgeClose", i, (a) => a.playFridgeClose());
    }
  }

  /**
   * No inventory, so "grabbed" means exactly what it says: the bottle leaves
   * the shelf and ends up in your hand, low and to the right of frame, riding
   * the walk cycle. It is the same mesh, still lit by the same lights, just
   * being carried. Nothing is added to a list and no icon appears anywhere.
   */
  private grab(mesh: THREE.Object3D): void {
    if (this.carry) return;
    mesh.updateWorldMatrix(true, false);
    this.carry = {
      mesh,
      t: 0,
      from: mesh.getWorldPosition(new THREE.Vector3()),
      fromQuat: mesh.getWorldQuaternion(new THREE.Quaternion()),
      pos: mesh.getWorldPosition(new THREE.Vector3()),
      quat: mesh.getWorldQuaternion(new THREE.Quaternion()),
    };
    this.fire("playBottleGrab", 0, (a) => a.playBottleGrab());
  }

  private updateCarry(dt: number): void {
    const c = this.carry;
    if (!c) return;
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();

    const handPos = HAND_OFFSET.clone().applyMatrix4(cam.matrixWorld);
    // Upright in the hand, yawed with the player and tipped a little, rather
    // than pinned rigidly to the camera's full orientation.
    const yaw = Math.atan2(
      -cam.matrixWorld.elements[8],
      -cam.matrixWorld.elements[10]
    );
    const handQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.13, yaw, -0.16, "YXZ"));

    if (c.t < 1) {
      c.t = Math.min(1, c.t + dt / CARRY_LIFT_S);
      const e = easeOutCubic(c.t);
      c.pos.lerpVectors(c.from, handPos, e);
      // A small hop clear of the shelf lip on the way out.
      c.pos.y += Math.sin(Math.PI * c.t) * 0.055;
      c.quat.slerpQuaternions(c.fromQuat, handQuat, e);
    } else {
      const k = 1 - Math.exp(-CARRY_LAG * dt);
      c.pos.lerp(handPos, k);
      c.quat.slerp(handQuat, k);
    }

    const parent = c.mesh.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      c.mesh.position.copy(parent.worldToLocal(c.pos.clone()));
      const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      c.mesh.quaternion.copy(pq.multiply(c.quat));
    } else {
      c.mesh.position.copy(c.pos);
      c.mesh.quaternion.copy(c.quat);
    }
    c.mesh.updateMatrixWorld(true);
  }

  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    this.resolveTargets();
    this.elapsed += dt;
    this.flushPending();
    this.updateFuelling(dt);
    this.updateNozzle(dt);
    this.updateDoor(dt);
    this.updateCoolers(dt);
    this.updateCarry(dt);
  }

  /* ------------------------------------------------------------------ */
  /* audio plumbing                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * One-shots fired before the audio graph exists are held for a moment and
   * replayed the instant it comes up. The context only unlocks on a gesture,
   * and the gesture that unlocks it is the same click that starts the pump —
   * without this, the first interaction of every session would be silent.
   */
  private fire(name: string, value: number, call: (a: StationAudio) => void): void {
    this.record(name, value);
    const audio = this.audio;
    if (!audio) return;
    if (audio.ready) {
      try {
        call(audio);
      } catch (err) {
        console.error(`[interaction] audio.${name} failed`, err);
      }
      return;
    }
    this.pending.push({ fn: () => call(audio), t: this.elapsed });
  }

  private flushPending(): void {
    if (!this.pending.length) return;
    const ready = !!this.audio?.ready;
    const cutoff = this.elapsed - 1.5;
    const keep: typeof this.pending = [];
    for (const p of this.pending) {
      if (p.t < cutoff) continue; // too stale to still be the right sound
      if (!ready) {
        keep.push(p);
        continue;
      }
      try {
        p.fn();
      } catch (err) {
        console.error("[interaction] deferred audio call failed", err);
      }
    }
    this.pending = keep;
    // The tick rate is a level, not an event: re-assert it once the graph is up.
    if (ready && this.session) {
      this.sentTickRate = -1;
      this.setTickRate(this.session.flow * TICKS_PER_GALLON);
    }
  }

  private record(name: string, value: number): void {
    this.calls.push({ name, value, t: Math.round(this.elapsed * 1000) / 1000 });
    if (this.calls.length > 2000) this.calls.splice(0, this.calls.length - 2000);
  }

  /** Any single handle throwing must not take the frame loop down with it. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error("[interaction] handle call failed", err);
    }
  }

  /* ------------------------------------------------------------------ */

  private snapshot() {
    const s = this.session;
    let display: unknown = null;
    if (s) {
      try {
        display = s.face.getDisplay();
      } catch {
        display = null;
      }
    }
    const bottle = this.carry?.mesh ?? this.ctx.game.tryGet<THREE.Object3D | null>("building.grabBottle") ?? null;
    const bp = bottle ? bottle.getWorldPosition(new THREE.Vector3()) : null;
    const spill = this.ctx.scene.getObjectByName("door-sun-bounce") as THREE.PointLight | undefined;

    return {
      t: Math.round(this.elapsed * 1000) / 1000,
      services: this.services,
      audioReady: !!this.audio?.ready,
      door: this.door
        ? {
            amount: this.door.amount,
            target: this.door.target,
            angle: this.door.pivot.rotation.y,
            openAngle: this.door.openAngle,
            sentAmount: this.sentDoorAmount,
            /** Read back off the lighting system's own emitter, not from us. */
            spillIntensity: spill ? spill.intensity : null,
          }
        : null,
      pump: s
        ? {
            face: s.face.name,
            pumpIndex: s.pumpIndex,
            running: true,
            gallons: s.gallons,
            dollars: s.dollars,
            price: s.price,
            flow: s.flow,
            tickRate: s.tickRate,
            gallonsPerTick: s.tickRate > 0 ? s.flow / s.tickRate : null,
            nozzleLift: this.lastFuelledFace?.getNozzleLift?.() ?? 0,
            display,
          }
        : { running: false, nozzleLift: this.lastFuelledFace?.getNozzleLift?.() ?? 0 },
      coolers: this.coolers.map((h, i) => ({ index: i, amount: h.amount, angle: h.pivot.rotation.y })),
      bottle: bp ? { carried: !!this.carry, t: this.carry?.t ?? 0, x: bp.x, y: bp.y, z: bp.z } : null,
    };
  }

  dispose(): void {
    this.ctx?.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    if (window.__INTERACT) delete window.__INTERACT;
  }
}

/* ------------------------------------------------------------------ */

function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function easeOutCubic(t: number): number {
  const u = 1 - Math.max(0, Math.min(1, t));
  return 1 - u * u * u;
}
