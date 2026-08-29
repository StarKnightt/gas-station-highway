import type * as THREE from "three";
import type { Game } from "./Game";
import type { QualitySettings } from "./capability";

export interface SystemContext {
  game: Game;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Shot preset name when running under the screenshot harness, else null. */
  shot: string | null;
  /**
   * Resolved quality settings for this host, decided before any system inits.
   *
   * Systems should read this rather than assuming a 4060: every figure this
   * project has published was measured on one card, and the user's requirement
   * is that the build detect the host and configure itself accordingly.
   *
   * The two families are not interchangeable — see the header of
   * `capability.ts`. `shadowFilter`, `transmission`, `detailPatches` and
   * `worldCapture` are **compile-time** levers that govern program count, which
   * is ~92% of a cold load; `shadowMapSize`, `scatterDensity`, `dprCap` and
   * `anisotropy` are **run-time** levers that govern frametime. A tier that
   * pulls only the second family misses what the user actually waits for.
   *
   * Read it at `init()` time. Only `scatterDensity` and `dprCap` change during
   * a session (the adaptive stepper cannot recompile materials without causing
   * the stall it exists to avoid), and both are applied from `Game` without a
   * system needing to observe them.
   */
  quality: QualitySettings;
}

/**
 * Every feature of the world is a GameSystem. Systems are registered on the
 * Game, initialised in registration order, then updated every frame. A system
 * may publish shared objects through `game.provide()` / `game.require()` so
 * later systems (pumps, canopy, vegetation) can query the ground height or the
 * shared material library without importing each other.
 */
export interface GameSystem {
  readonly name: string;
  init(ctx: SystemContext): void | Promise<void>;
  update?(dt: number, elapsed: number, ctx: SystemContext): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}
