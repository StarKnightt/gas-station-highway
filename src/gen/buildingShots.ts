import * as THREE from "three";

/** Y values are relative to a reference surface, never absolute world metres. */
export type YRef = "floor" | "ground";

export interface BuildingShot {
  x: number;
  z: number;
  /** Eye height above `ref`. */
  y: number;
  ref: YRef;
  lookAt: [number, number, number];
  /** The look-at Y is relative to the same reference. */
  lookRef: YRef;
  fov: number;
}

/**
 * Camera poses for System 2's own capture harness (`tools/shoot2.mjs`).
 *
 * Deliberately kept out of `core/shots.ts`: that file and `tools/shoot.mjs`
 * are shared with the systems being built in parallel, and adding entries
 * there would have meant editing files another agent owns. These are applied
 * by BuildingSystem when it sees a matching `?shot=` value, which works
 * because BuildingSystem initialises after PlayerSystem and PlayerSystem
 * already disables free-look for any shot name it is given.
 *
 * Heights are stored relative to the lot surface or to the finished floor
 * because the lot drains and the floor is set 140 mm above the high point of
 * the pad - hard-coding world Y here would put the camera in the ceiling on
 * one shot and in the slab on the next.
 */
export const BUILDING_SHOTS: Record<string, BuildingShot> = {
  // From the forecourt between the pump islands, looking at the storefront.
  front: { x: -3.6, z: 22.6, y: 1.66, ref: "ground", lookAt: [-4.6, 1.9, 31.6], lookRef: "ground", fov: 50 },

  // Standing on the entry stoop, looking in through the open door.
  door: { x: -6.0, z: 29.9, y: 1.62, ref: "ground", lookAt: [-5.4, 1.3, 36.5], lookRef: "floor", fov: 56 },

  // Inside, by the counter end, looking back down the front of the store at
  // the door and the sunlit forecourt beyond it. The aisles run east-west, so
  // this is the only pose in the plan with a clear diagonal to the doorway.
  interior: { x: 2.9, z: 34.0, y: 1.62, ref: "floor", lookAt: [-6.3, 1.35, 31.85], lookRef: "floor", fov: 64 },

  // The aisle in front of the cooler is only 1.1 m, so a square-on view of the
  // doors cannot fit the 2.12 m cabinet in frame without a fisheye. This backs
  // into the cross aisle instead and takes the run at three quarters.
  cooler: { x: 0.1, z: 37.4, y: 1.6, ref: "floor", lookAt: [-4.0, 1.1, 39.2], lookRef: "floor", fov: 55 },

  // Three-quarter exterior: the storefront, the east elevation and the parapet.
  corner: { x: 12.4, z: 26.0, y: 1.68, ref: "ground", lookAt: [-2.2, 2.7, 34.8], lookRef: "ground", fov: 46 },

  /**
   * Masonry at reading distance, framed on the **corner** at x 3.5 so the lit
   * front elevation and the shaded east elevation are both in one frame.
   *
   * This pose used to sit square on the east elevation, and a critic returned
   * it as unusable: "the bottom fifth of that frame is crushed to near-black. I
   * can't judge the skirt, the base flashing, or the ground junction, and that
   * under-exposure is itself a defect in a shot whose job is to prove the wall
   * material." That was not a framing accident. The sun is at azimuth 203 and
   * elevation 6.2, so the east elevation has a negative N dot L - it is in full
   * shade, all day, by construction. No reframing of a shaded wall can prove a
   * material, and relighting it would mean asking Lighting to move the sun for
   * one capture.
   *
   * Straddling the corner fixes that and buys something better. The front
   * elevation is lit with the sun 67 degrees off its normal in azimuth, which
   * is the single best angle in the scene for reading relief, and the east
   * elevation beside it is in shade. Same distance, same material, same texture
   * tile, two light angles - which is exactly the critic's test for whether the
   * coursing carries height information, with every confound removed and inside
   * a single frame instead of across two. `tools/probe-joints.mjs` reads it.
   *
   * Framed above y = 1.9 on the left because the ice machine occupies x
   * 1.75..2.95 up to 1.86 m; that obstruction is what left the piers
   * uncaptured before and is why a forced-value coursing diff once came back at
   * zero changed pixels while the feature worked perfectly well off-camera.
   */
  wall: { x: 5.6, z: 28.4, y: 1.6, ref: "ground", lookAt: [3.4, 2.4, 31.5], lookRef: "ground", fov: 40 },

  /**
   * The wall-to-paving junction at the same corner, close and angled down.
   *
   * "The building is placed on the ground, not joined to it" - and the frame
   * that should have shown the join was the crushed band at the bottom of the
   * old `wall` pose. A junction is its own subject and needs its own pose,
   * on an elevation the sun actually reaches.
   */
  base: { x: 4.6, z: 29.9, y: 0.95, ref: "ground", lookAt: [3.35, 0.25, 31.4], lookRef: "ground", fov: 42 },

  /**
   * The handheld bottle, at exactly the distance it is actually held.
   *
   * `InteractionSystem` carries the grabbable at `HAND_OFFSET`, 0.44 m in front
   * of the camera, and no pose in this list came within two metres of it — which
   * is why the one object in this project that gets *inspected* was also the one
   * nobody here had ever looked at. The critic found it in Player's frames
   * instead.
   *
   * So this stands at 0.44 m, the same distance, with a 34 degree vertical
   * field. At 1600 x 900 that puts a 245 x 70 mm bottle at **824 x 253 delivered
   * pixels**, which is the real budget the label has to be authored against and
   * the reason it is not an atlas cell. Matching the interaction's own distance
   * rather than picking a comfortable one is the point: a pose that flatters the
   * object is worse than no pose.
   */
  bottle: {
    x: -4.2,
    z: 34.96,
    y: 1.2825,
    ref: "floor",
    lookAt: [-4.2, 1.2825, 35.4],
    lookRef: "floor",
    fov: 34,
  },
};

export const BUILDING_SHOT_NAMES = Object.keys(BUILDING_SHOTS);

export function applyBuildingShot(
  camera: THREE.PerspectiveCamera,
  name: string,
  floorY: number,
  groundHeight: (x: number, z: number) => number
): boolean {
  const s = BUILDING_SHOTS[name];
  if (!s) return false;
  const base = (ref: YRef, x: number, z: number) => (ref === "floor" ? floorY : groundHeight(x, z));
  camera.position.set(s.x, base(s.ref, s.x, s.z) + s.y, s.z);
  const [lx, ly, lz] = s.lookAt;
  camera.lookAt(new THREE.Vector3(lx, base(s.lookRef, lx, lz) + ly, lz));
  camera.fov = s.fov;
  camera.near = 0.05;
  camera.updateProjectionMatrix();
  return true;
}
