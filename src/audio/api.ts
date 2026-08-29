/**
 * The contract the audio system publishes on the service registry under the
 * key `"audio"`. Interaction (System 7) imports this type and calls it; the
 * audio system is the only thing that implements it.
 *
 * Every method is safe to call before the audio graph exists. The graph is
 * only built on the first user gesture (browsers refuse to start an
 * AudioContext without one), and until then these are no-ops rather than
 * throws, so callers never have to check.
 */
export interface StationAudio {
  /** True once a user gesture has unlocked the context and beds are running. */
  readonly ready: boolean;

  /* pump ------------------------------------------------------------ */
  /** Lever clunk, then the pump motor spinning up. `pumpIndex` picks a bay. */
  playPumpStart(pumpIndex?: number): void;
  /** Metering counter clicks per second. 0 stops the ticking, motor stays on. */
  setPumpTickRate(ticksPerSecond: number): void;
  /** Motor spin-down and the lever dropping back. */
  playPumpStop(): void;

  /* storefront door -------------------------------------------------- */
  playDoorOpen(): void;
  playDoorClose(): void;
  /**
   * 0 = shut, 1 = wide open. Drives how much of the outside bleeds into the
   * store. Optional: if BuildingSystem publishes `doorOpenAmount()` the audio
   * system reads it every frame instead.
   */
  setDoorOpenAmount(amount: number): void;

  /* cooler and product ----------------------------------------------- */
  playFridgeOpen(): void;
  playFridgeClose(): void;
  playBottleGrab(): void;

  /* mix -------------------------------------------------------------- */
  /** Single volume control point for the whole soundscape. 0..1. */
  setMasterVolume(volume: number): void;
  getMasterVolume(): number;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

/**
 * Optional override hook, read from the registry under `"buildingAudio"`.
 *
 * Normally the audio system derives all of this from what BuildingSystem
 * already publishes — `building.footprint` for the inside test,
 * `building.entryDoor` (its `rotation.y` against `userData.openAngle`) for the
 * door state, `building.coolerDoors` and `building.fluorescents` for emitter
 * placement. This interface exists for anything that wants to override those,
 * and as the documented fallback shape if those services ever disappear.
 */
export interface BuildingAudioInfo {
  /** Is this XZ point inside the sales floor? */
  isInside?(x: number, z: number): boolean;
  /** 0 shut .. 1 wide open. */
  doorOpenAmount?(): number;
  doorPosition?: { x: number; y: number; z: number };
  coolerPosition?: { x: number; y: number; z: number };
  lightPositions?: { x: number; y: number; z: number }[];
}

/** The shape of the `"building.footprint"` service. */
export interface BuildingFootprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorY: number;
  roofY: number;
  parapetY: number;
  wallThickness: number;
}
