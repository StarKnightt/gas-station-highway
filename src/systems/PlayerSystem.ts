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

/**
 * Shift. **1.7x, and the restraint is the decision, not the number.**
 *
 * 1.4 -> 2.38 m/s is a person walking briskly because they want to get on with
 * it — the top of a normal human walk, which is about 2.5 m/s before gait
 * breaks into a run. The obvious 3x would be 4.2 m/s, and that is not a fast
 * walk, it is a jog: it changes the register of the whole scene from a quiet
 * dawn forecourt to a shooter, and it does so in the first second of holding
 * the key. The brief specifies walking pace and the scene is a photograph, so
 * the sprint has to stay inside "in a hurry".
 *
 * It also has to stay inside the head-bob's authored range and inside the
 * collision resolver's per-frame step: at 2.38 m/s a 60 Hz frame advances
 * 40 mm against a 0.32 m body radius, so nothing can tunnel a blocker. At 3x
 * it would be 70 mm, still safe, but the margin is worth having on a machine
 * that drops frames under six agents.
 */
const RUN_MULTIPLIER = 1.7;

/**
 * Ceiling on the head-bob amplitude multiplier. Below walking pace nothing
 * changes — `amount` is speed/WALK_SPEED, so this only engages above 1.0.
 *
 * Bob *cadence* already follows speed correctly and for free, because
 * `bobPhase` advances with distance rather than with time. Amplitude is the
 * part that needed a decision: real vertical displacement of the head does grow
 * with gait speed but markedly sub-linearly, so letting `amount` reach 1.7
 * would put a 36 mm bob on a brisk walk where 21 mm reads as an ordinary one.
 * 1.3 gives 27 mm — the walk visibly firms up under Shift without the camera
 * starting to pump.
 */
const MAX_BOB_AMOUNT = 1.3;

/**
 * Space. A hop, deliberately, and both numbers come from one target.
 *
 * 2.5 m/s against 9.81 m/s^2 is a 319 mm apex over 0.51 s of air — clearing a
 * kerb, not clearing a fence. Real gravity rather than the inflated constant an
 * action game would use, because there is nothing here to platform over and an
 * 18 m/s^2 hop reads as twitchy in a scene whose whole subject is stillness.
 *
 * The apex matters for a reason beyond feel: it is under the 0.7 m the shortest
 * blocker would need to be cleared, and every blocker in this scene is an XZ
 * rectangle with no height at all (see `src/core/collision.ts`), so a jump
 * cannot get over one at any apex. That is checked rather than assumed — a hop
 * that put the player somewhere the walk cannot reach would be a worse bug than
 * having no jump.
 */
const JUMP_SPEED = 2.5;
const GRAVITY = 9.81;
/**
 * How close to standing height the eye must be before Space will fire.
 *
 * `!airborne` alone is not a grounded test. The eye follows the surface through
 * an exponential lag with a rate clamp, so while mounting the shop's 185 mm
 * threshold the camera is genuinely below where it belongs and the player is
 * mid-stride up a step — jumping from there would launch off a height the walk
 * never occupied. 120 mm is comfortably inside ordinary bob and grade lag
 * (bob peaks at 21 mm, a 1-in-20 grade at walking pace lags about 6 mm) and
 * comfortably outside the threshold step.
 */
const GROUNDED_EPS = 0.12;

/** Live controller state. See `PlayerSystem.report` for why this exists. */
export interface PlayerReport {
  eyeY: number;
  standY: number;
  offStanding: number;
  airborne: boolean;
  vy: number;
  grounded: boolean;
  running: boolean;
  speed: number;
  bobAmount: number;
  jumps: number;
  costUs: number;
  samples: number;
  /** Frames `update()` has run. **Zero means every field above is a default.** */
  frames: number;

  /* ---- the observable-effect trio ---------------------------------------
   *
   * `speed` above is the controller's *intention*: the magnitude of the
   * velocity vector it is about to integrate. It can read exactly 1.700x the
   * walk while the body covers 1.541x the ground, which is precisely what a
   * playtest measured, and it is the internal-value-versus-observable-effect
   * trap this project keeps falling into. So the three numbers that make the
   * outcome measurable ship alongside it.
   */
  /** Cumulative horizontal distance the body has actually moved, metres. */
  travelled: number;
  /** Simulated time accumulated, seconds. Diverges from wall clock if dt is clamped. */
  simTime: number;
  /** Frames on which collision had to push the body out of something. */
  resolves: number;
}

declare global {
  interface Window {
    /** Absent when PlayerSystem never initialised. See `frames` for the rest. */
    __PLAYER?: () => PlayerReport;
  }
}

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
  /** Vertical velocity while airborne, m/s. Zero and unused when grounded. */
  private vy = 0;
  private airborne = false;
  /**
   * A Space press that arrived since the last frame, latched on the event and
   * consumed by `update()`.
   *
   * **This exists because polling alone silently drops taps.** WASD is a held
   * state and reading `keys.has()` once per frame is exactly right for it, but a
   * jump is an *edge*, and a press whose keydown and keyup both land between two
   * frames is added to and removed from the set without `update()` ever
   * observing it. Measured: the harness firing a zero-hold press landed **five
   * out of five in the gap and produced no jump at all**, while the same key
   * held for three seconds hopped seven times — so the feature looked entirely
   * functional under every test that held the key down.
   *
   * A human tap is 50-100 ms and survives at 60 fps, which is what makes this
   * the bad kind of bug: it appears only on long frames, i.e. exactly when this
   * scene is under load, and it reads as an unresponsive control rather than as
   * a dropped event.
   *
   * The latch is `||`-ed with the poll rather than replacing it, so holding Space
   * still re-hops once the feet are back down.
   */
  private jumpTapped = false;
  /** Rolling cost of the whole of `update()`, so the added work has a number. */
  private costUs = 0;
  private costSamples = 0;
  private jumps = 0;
  /**
   * Ground actually covered and time actually simulated, accumulated post
   * collision so they describe the body rather than the intent. See the
   * observable-effect note on `PlayerReport`.
   */
  private travelled = 0;
  private simTime = 0;
  private resolves = 0;
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
    // Published before the early return below, so a `?shot=` page still has the
    // hook and reports `frames: 0` through it. "The controller is disabled by a
    // preset" and "PlayerSystem never initialised" are different failures, and
    // installing this after the return would make them the same absent hook.
    window.__PLAYER = () => this.report;

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

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === "Space") {
      // Latched here so a tap shorter than a frame is not lost. See jumpTapped.
      if (!e.repeat) this.jumpTapped = true;
      // Space is also the browser's "scroll down" and "activate the focused
      // button". The body cannot scroll, but the pre-lock HUD card is
      // focusable, so without this a press aimed at jumping could re-trigger
      // whatever the player last clicked. Only swallowed while live.
      if (this.enabled) e.preventDefault();
    }
  };
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
    const t0 = performance.now();

    const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const running = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");

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
    //
    // Shift raises the *target* and leaves the smoothing alone, which is the
    // whole reason it reads as a person deciding to hurry rather than as a
    // speed multiplier being switched on: the same exponential that gets the
    // walk up to 1.4 m/s in ~0.25 s carries it on to 2.38, and letting go
    // decelerates on the identical curve. Nothing snaps and there is no second
    // acceleration constant to keep in step with the first.
    _target.copy(_dir).multiplyScalar(running ? WALK_SPEED * RUN_MULTIPLIER : WALK_SPEED);
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
      this.resolves++;
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

    // Accumulated *here*, after resolution, so it is the distance the body
    // covered and not the distance the controller asked for. The gap between
    // this and `speed * simTime` is exactly what collision and integration took
    // out, which is the difference a playtest can feel and an internal reading
    // cannot see.
    this.travelled += Math.hypot(p.x - prevX, p.z - prevZ);
    this.simTime += dt;

    // Head bob: two vertical cycles per stride, plus a small lateral sway.
    // Phase advances with distance, so cadence follows speed: 2 * v * BOB_RATE
    // rad/s vertical, i.e. v * BOB_RATE / pi Hz, and a stride of 2*pi/BOB_RATE
    // metres. 4.15 puts a 1.4 m/s walk at 1.85 Hz over a 1.51 m stride, which
    // is an ordinary adult gait. The 5.4 this replaces was tuned against the
    // 1.07 m/s the controller actually achieved before the speed fix above —
    // correct at 1.07 (1.84 Hz) and a 2.41 Hz trot once the speed was right.
    //
    // Cadence needs nothing for Shift: phase advances with distance, so a 1.7x
    // speed is a 1.7x step rate automatically and the stride length is
    // unchanged, which is what a brisk walk is. Amplitude is capped — see
    // MAX_BOB_AMOUNT — because the linear term would put a 36 mm bob on it.
    //
    // Airborne there is no gait at all, so the phase is frozen rather than
    // advanced: a jump straight up has zero horizontal speed and would freeze
    // anyway, but jumping while walking must not keep bobbing the head as
    // though the feet were still on the ground.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.airborne) this.bobPhase += dt * speed * BOB_RATE;
    const amount = this.airborne ? 0 : Math.min(MAX_BOB_AMOUNT, speed / WALK_SPEED);
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
    const standY = surface + EYE_HEIGHT;

    /* ---- jump ------------------------------------------------------------
     *
     * Deliberately the smallest honest version. Ballistic while airborne,
     * unchanged floor-follow while grounded, and one shared definition of where
     * the ground is — `surfaceHeight`, the same service the walk uses, which is
     * `building.floorHeight` inside the shell and `groundHeight` outside. So
     * jumping across the shop threshold lands on the interior slab and jumping
     * back out lands on the forecourt, without this code knowing either exists.
     *
     * Two guards, and each one is a bug this would otherwise have:
     *
     *   `!airborne`  stops the double jump. Set on the frame the hop starts and
     *                cleared only on touchdown, so a second press mid-air does
     *                nothing and a *held* key cannot fly — it can only re-hop
     *                once the feet are back down, which is a walk with a hop in
     *                it and not flight.
     *   GROUNDED_EPS stops a jump from a height the walk never occupied, e.g.
     *                partway up the 185 mm threshold while the eye is still
     *                lagging the step.
     *
     * Horizontal motion and collision are untouched above: `resolve()` runs on
     * XZ every frame regardless of altitude and every blocker is a height-less
     * rectangle, so there is no altitude at which the player can pass over one
     * or land inside one. That is the property that makes a jump safe here, and
     * it is asserted rather than assumed.
     */
    // Consumed unconditionally, whether or not it fires. A latch that survived
    // a refused press would queue the jump and spend it the instant the player
    // landed or finished mounting a step, which is a jump firing on its own
    // half a second after the key was let go.
    const jumpWanted = this.jumpTapped || this.keys.has("Space");
    this.jumpTapped = false;
    if (!this.airborne && jumpWanted && Math.abs(p.y - standY) < GROUNDED_EPS) {
      this.airborne = true;
      this.vy = JUMP_SPEED;
      this.jumps++;
    }

    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      p.y += this.vy * dt;
      // No `vy <= 0` guard on purpose. It cannot fire spuriously — the
      // integration above always puts the eye strictly above `standY` on the
      // first airborne frame — and leaving it out covers the case it would
      // otherwise break: a low hop that crosses *into* the shop, where the
      // floor rises 185 mm under a player who is still ascending. With the sign
      // guard they would pass up through the slab and land on it from above;
      // without it they meet the floor the moment they reach it, which is what
      // hitting a step is.
      if (p.y <= standY) {
        // Snapped to the exact standing height rather than eased down to it.
        // The lag below would approach it asymptotically and never arrive, so
        // repeated jumps would each leave a little residue and the eye would
        // creep — which is precisely the drift this has to not have.
        p.y = standY;
        this.vy = 0;
        this.airborne = false;
      }
    } else {
      const dy = (standY + bobY - p.y) * (1 - Math.exp(-12 * dt));
      const maxDy = MAX_CLIMB_RATE * dt;
      p.y += Math.max(-maxDy, Math.min(maxDy, dy));
    }
    this.camera.rotation.z = bobX * 0.35;

    this.costUs += (performance.now() - t0) * 1000;
    this.costSamples++;
    // Mutated, not rebuilt. The invariant at the top of this file is that
    // `update()` does not allocate, because a performance agent is measuring
    // this scene and a per-frame object literal is a per-frame allocation.
    const r = this.report;
    r.eyeY = p.y;
    r.standY = standY;
    r.offStanding = p.y - standY;
    r.airborne = this.airborne;
    r.vy = this.vy;
    r.grounded = !this.airborne && Math.abs(p.y - standY) < GROUNDED_EPS;
    r.running = running;
    r.speed = speed;
    r.bobAmount = amount;
    r.jumps = this.jumps;
    r.costUs = this.costUs / this.costSamples;
    r.samples = this.costSamples;
    r.travelled = this.travelled;
    r.simTime = this.simTime;
    r.resolves = this.resolves;
    r.frames++;
  }

  /**
   * Live controller state, updated in place every frame.
   *
   * Here for the same reason `window.__INTERACT.state()` is: a screenshot
   * cannot tell you the eye came back to exactly standing height after a hop,
   * or that a jump did not put the player 40 mm inside a wall. Those are
   * numbers, so they are asserted as numbers.
   *
   * `frames` is the guard that has to be read before anything else here is
   * believed. It is 0 until `update()` has actually run, which distinguishes
   * "the controller is disabled by a `?shot=` preset" from "the controller ran
   * and the player is standing still" — two states whose every other field is
   * identical, and one of which makes every number below meaningless.
   */
  private report: PlayerReport = {
    eyeY: 0,
    standY: 0,
    offStanding: 0,
    airborne: false,
    vy: 0,
    grounded: false,
    running: false,
    speed: 0,
    bobAmount: 0,
    jumps: 0,
    costUs: 0,
    samples: 0,
    frames: 0,
    travelled: 0,
    simTime: 0,
    resolves: 0,
  };

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (window.__PLAYER) delete window.__PLAYER;
    this.controls?.dispose();
  }
}
