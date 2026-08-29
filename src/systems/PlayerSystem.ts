import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import type { GameSystem, SystemContext } from "../core/types";
import { applyShot } from "../core/shots";
import { CollisionField, collectSolids } from "../core/collision";

const EYE_HEIGHT = 1.65;
const WALK_SPEED = 1.4; // m/s, an ordinary adult walking pace
/**
 * Rate at which velocity approaches its target, 1/s. The same 11 the old
 * damping term used, so the controller feels as it did; see `update()` for why
 * the acceleration constant that sat beside it is gone.
 */
const RESPONSE = 11;
/** Player's collision radius. Matches `building.collide`'s own default. */
const BODY_RADIUS = 0.32;
/**
 * Body radius inside a portal — a doorway or other tight opening that has
 * declared itself under the collision contract. A person squares up and turns
 * slightly to get through a door rather than walking at it as a 0.64 m
 * cylinder, and the shop's 1.15 m opening left only 0.51 m of aim at the full
 * radius. 0.20 m is a 0.40 m shoulder and still keeps the 0.08 m near plane
 * 0.12 m clear of a jamb.
 *
 * Deliberately keyed to *where the player is* rather than to "the wide radius
 * was blocked and this one is not". The latter reads like it only fires in
 * gaps and in fact fires against every flat wall in the scene — see the note
 * in `collision.ts`.
 */
const PORTAL_RADIUS = 0.2;
/** Head-bob phase per metre walked. See the derivation in `update()`. */
const BOB_RATE = 4.15;
/** Ceiling on how fast the eye may rise or fall, m/s. See `update()`. */
const MAX_CLIMB_RATE = 0.9;

// Frame-local scratch. This runs every frame and a performance agent is
// measuring the scene, so nothing in `update()` allocates.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

/**
 * First person walker. An unhurried 1.4 m/s, which keeps the ground on screen
 * for a long time — exactly the surface this project has to sell.
 *
 * Three services drive it, all pulled off the registry rather than imported:
 * `groundHeight` from the terrain system, so the player follows the crown of
 * the road and the pad drainage; `building.floorHeight`, so the eye rides the
 * raised interior slab once inside the shop; and `building.collide`, so walls
 * are solid.
 */
export class PlayerSystem implements GameSystem {
  readonly name = "player";

  private controls!: PointerLockControls;
  private camera!: THREE.PerspectiveCamera;
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private bobPhase = 0;
  private groundHeight!: (x: number, z: number) => number;
  /** Ground outside, finished floor level inside. Resolved on the first frame. */
  private surfaceHeight!: (x: number, z: number) => number;
  /** Every solid thing in the scene. See `src/core/collision.ts`. */
  private solids: CollisionField | null = null;
  private resolved = false;
  private enabled = true;
  private hud: HTMLElement | null = null;
  private game!: SystemContext["game"];
  private scene!: THREE.Object3D;

  init(ctx: SystemContext): void {
    this.camera = ctx.camera;
    this.game = ctx.game;
    this.scene = ctx.scene;
    // Throws rather than defaulting to a flat y = 0. The service is only
    // missing when TerrainSystem failed or was ordered after this one, and the
    // quiet version put the player 155 mm under a forecourt that sits at
    // PAD.y = 0.155, with the road crown gone - a subtly wrong scene that a
    // capture cannot distinguish from a correct one. `Game` catches per-system
    // failures, so this costs the player and records the cause in
    // `__SYSTEM_ERRORS` instead. VegetationSystem.ts already does the same.
    const ground = ctx.game.tryGet<(x: number, z: number) => number>("groundHeight");
    if (!ground) {
      throw new Error(
        'PlayerSystem: no "groundHeight" service — must init after TerrainSystem'
      );
    }
    this.groundHeight = ground;

    if (ctx.shot) {
      this.enabled = false;
      applyShot(this.camera, ctx.shot, this.groundHeight);
      return;
    }

    // YXZ before anything poses the camera, while the rotation is still
    // (0,0,0) so re-interpreting the angles in the new order is a no-op.
    //
    // This matters because `update()` writes `camera.rotation.z` every frame for
    // the head-bob sway. In the default XYZ order the `y` term is recovered
    // through an asin and so only spans +-90 degrees; the spawn yaw here is
    // about 140 degrees, which three can only express as x = -pi, y = -0.675,
    // z = -pi. Those two pi terms cancel and the pose is upright, but zeroing
    // `z` for the bob removed half of the cancelling pair and left the camera
    // rolled 180 degrees about X - the reported "head down, legs up". It
    // re-applied on every frame, including after a mouse move, so the view was
    // inverted permanently rather than only until first input.
    //
    // YXZ is the FPS convention (and what PointerLockControls composes with):
    // y is a full-range atan2 yaw, x is pitch, and z is genuine camera roll, so
    // assigning z touches roll and nothing else.
    this.camera.rotation.order = "YXZ";
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(-14, EYE_HEIGHT, 2);
    this.camera.lookAt(2, 1.4, 22);

    this.controls = new PointerLockControls(this.camera, ctx.renderer.domElement);
    this.hud = document.getElementById("hud");
    this.hud?.classList.remove("hidden");

    ctx.renderer.domElement.addEventListener("click", () => this.controls.lock());
    this.controls.addEventListener("lock", () => this.hud?.classList.add("hidden"));
    this.controls.addEventListener("unlock", () => this.hud?.classList.remove("hidden"));

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => this.keys.add(e.code);
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  /**
   * `main.ts` registers BuildingSystem *after* this one, so its services do not
   * exist at our init() and have to be picked up on the first frame instead.
   *
   * Missing is fatal, deliberately, and for exactly the reason `groundHeight`
   * is: the quiet version of this is a player who walks through the shop wall
   * and stands 155 mm below its floor, which is the defect this code exists to
   * fix and which no capture can tell apart from a correct one. Throwing costs
   * the player and records the cause in `__SYSTEM_ERRORS`, where every harness
   * here already treats it as a hard failure.
   */
  private resolveBuilding(): void {
    this.resolved = true;
    const floor = this.game.tryGet<(x: number, z: number) => number>("building.floorHeight");
    if (!floor) {
      throw new Error(
        'PlayerSystem: BuildingSystem published no "building.floorHeight" — the player would stand below the shop floor'
      );
    }
    // Already falls back to `groundHeight` outside the shell, so this is a
    // strict superset of the terrain service.
    this.surfaceHeight = floor;

    const { groups, portals } = collectSolids(this.game, this.scene);
    if (!groups.length) {
      throw new Error(
        "PlayerSystem: nothing in the scene published blockers — the player would walk " +
          "through every wall, dispenser and vehicle on the site. See src/core/collision.ts."
      );
    }
    this.solids = new CollisionField(groups, portals);
    // Published so probes and any later system can ask the same question the
    // controller asks, against the same union, rather than re-deriving it from
    // `building.blockers` and quietly missing four fifths of the scene. NB
    // `resolve` mutates its argument — query it with a clone.
    this.game.provide("collision.field", this.solids);
    console.info(`[player] solid geometry: ${this.solids.blockerCount} blockers — ${this.solids.describe()}`);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    if (!this.resolved) this.resolveBuilding();

    const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);

    _dir.set(0, 0, 0);
    if (forward || strafe) {
      this.camera.getWorldDirection(_fwd);
      _fwd.y = 0;
      _fwd.normalize();
      _right.crossVectors(_fwd, _UP).normalize();
      _dir.addScaledVector(_fwd, forward).addScaledVector(_right, strafe).normalize();
    }

    // Exponential approach to the target velocity. The previous form was
    // `v += dir * ACCEL * WALK_SPEED * dt` and then `v *= 1 - DAMPING * dt`,
    // whose steady state is ACCEL * WALK_SPEED / DAMPING = 1.15 m/s — so the
    // `setLength(WALK_SPEED)` clamp beneath it could never engage, and the
    // player walked at a measured 1.07 m/s while the constant beside it said
    // 1.4. This form is framerate independent and actually reaches the number
    // it is named after, which also restores head bob to its authored depth:
    // `amount` below is speed/WALK_SPEED and had been pinned near 0.77.
    _target.copy(_dir).multiplyScalar(WALK_SPEED);
    this.velocity.lerp(_target, 1 - Math.exp(-RESPONSE * dt));

    const p = this.camera.position;
    const prevX = p.x;
    const prevZ = p.z;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;
    // `resolve` is a command, not a predicate: it pushes `p` out of anything
    // solid, in place, and returns whether it had to. Its own broad phase
    // rejects the whole field, then each group, before any rectangle is tested.
    if (this.solids && this.solids.resolve(p, this.solids.radiusAt(p.x, p.z, BODY_RADIUS, PORTAL_RADIUS))) {
      if (dt > 1e-4) {
        // Re-derive velocity from the displacement that actually happened. The
        // blocked component falls to zero rather than winding up into a spring
        // that fires the player through the wall the moment they turn away,
        // and the tangential component survives, so walking into a wall slides
        // along it instead of sticking.
        this.velocity.x = (p.x - prevX) / dt;
        this.velocity.z = (p.z - prevZ) / dt;
      }
    }

    // Head bob: two vertical cycles per stride, plus a small lateral sway.
    // Phase advances with distance, so cadence follows speed: 2 * v * BOB_RATE
    // rad/s vertical, i.e. v * BOB_RATE / pi Hz, and a stride of 2*pi/BOB_RATE
    // metres. 4.15 puts a 1.4 m/s walk at 1.85 Hz over a 1.51 m stride, which
    // is an ordinary adult gait. The 5.4 this replaces was tuned against the
    // 1.07 m/s the controller actually achieved before the speed fix above —
    // correct at 1.07 (1.84 Hz) and a 2.41 Hz trot once the speed was right.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bobPhase += dt * speed * BOB_RATE;
    const amount = speed / WALK_SPEED;
    const bobY = Math.sin(this.bobPhase * 2) * 0.021 * amount;
    const bobX = Math.sin(this.bobPhase) * 0.014 * amount;

    // Interior floor inside the shell, terrain everywhere else. `floorHeight`
    // is a hard ternary, so the 185 mm shop threshold arrives as a step
    // discontinuity in the height field and the follow below is the only thing
    // that turns it into a stride.
    //
    // Two properties that the old `* Math.min(1, dt * 12)` did not have. The
    // exponential form is framerate independent, where the linear one reached
    // a factor of 1 — an instant snap — at any frame longer than 83 ms. And
    // the rate clamp bounds how fast the eye can climb no matter how long the
    // frame was, so a hitch cannot fire the view up a step: at 0.9 m/s the
    // threshold takes ~0.21 s to mount, which is what stepping up a kerb costs.
    // Ordinary motion never touches the clamp — the bob peaks at 0.24 m/s and
    // walking a 1-in-20 grade at 1.4 m/s is 0.07 m/s.
    const surface = this.surfaceHeight(p.x, p.z);
    const dy = (surface + EYE_HEIGHT + bobY - p.y) * (1 - Math.exp(-12 * dt));
    const maxDy = MAX_CLIMB_RATE * dt;
    p.y += Math.max(-maxDy, Math.min(maxDy, dy));
    this.camera.rotation.z = bobX * 0.35;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.controls?.dispose();
  }
}
