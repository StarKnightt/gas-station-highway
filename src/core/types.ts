import type * as THREE from "three";
import type { Game } from "./Game";

export interface SystemContext {
  game: Game;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Shot preset name when running under the screenshot harness, else null. */
  shot: string | null;
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
