import * as THREE from "three";

export interface ShotPreset {
  position: [number, number, number];
  lookAt: [number, number, number];
  fov?: number;
  /** When set, Y is taken from the ground surface plus this offset. */
  eyeAbove?: number;
}

/**
 * Deterministic camera poses used by tools/shoot.mjs. Requested with
 * `?shot=<name>`; when present the free-look controller stays disabled so the
 * frame is byte-for-byte repeatable between runs.
 */
export const SHOTS: Record<string, ShotPreset> = {
  // Standing on the gravel shoulder across the highway, looking at the station.
  approach: { position: [-30, 0, -7.6], eyeAbove: 1.65, lookAt: [-1, 1.6, 20], fov: 46 },

  // Middle of the parking lot looking back toward the fuel island.
  lot: { position: [19.0, 0, 36.4], eyeAbove: 1.65, lookAt: [-2.0, 1.2, 18.0], fov: 52 },

  // Walking up to the fuel island.
  pumps: { position: [-10.4, 0, 11.4], eyeAbove: 1.64, lookAt: [1.0, 0.4, 17.4], fov: 48 },

  // Knee height, raking down the damp asphalt straight into the low sun.
  ground: { position: [21.5, 0, 38.6], eyeAbove: 0.42, lookAt: [-9.0, 3.4, 13.0], fov: 56 },

  // Three-quarter establishing view of the whole site.
  wide: { position: [-46, 12.5, -24], lookAt: [3, 0.4, 25], fov: 46 },
};

export const SHOT_NAMES = Object.keys(SHOTS);

export function applyShot(
  camera: THREE.PerspectiveCamera,
  name: string,
  groundHeight?: (x: number, z: number) => number
): boolean {
  const s = SHOTS[name];
  if (!s) return false;
  camera.position.set(...s.position);
  if (s.eyeAbove !== undefined && groundHeight) {
    camera.position.y = groundHeight(s.position[0], s.position[2]) + s.eyeAbove;
  }
  camera.lookAt(new THREE.Vector3(...s.lookAt));
  if (s.fov) {
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
  }
  return true;
}
