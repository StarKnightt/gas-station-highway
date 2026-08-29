#!/usr/bin/env node
/**
 * The deliverable: a 15-20 second video of a person walking the station and
 * performing the three interactions from the brief.
 *
 *   node tools/filmwalk.mjs                 # full run, video + audio
 *   node tools/filmwalk.mjs --no-build      # reuse the last build
 *   node tools/filmwalk.mjs --duration 8    # short take while iterating
 *   node tools/filmwalk.mjs --no-audio      # video only
 *   node tools/filmwalk.mjs --fps 30 --width 1600
 *
 * Three properties matter more than the picture, because they are what make the
 * thing re-runnable as the scene changes under it:
 *
 * **1. Simulation time is not wall-clock time.** `Game.frame` takes its `dt`
 * from a `THREE.Clock`, so at 60 fps it advances 16 ms and during a hitch it
 * advances 280 ms — which is right for a game and useless for a film. Here the
 * clock is replaced by a counter that advances exactly `1/fps` per frame and
 * the render loop is driven by hand. A slow frame then makes the *capture*
 * slower and the *film* identical, so a frame that takes two seconds to
 * screenshot still lands 33 ms after its predecessor. Nothing in the output
 * depends on how loaded this machine was.
 *
 * **2. The walk is the real walk.** The camera is not a dolly on a spline. It
 * holds `KeyW` and steers, so it is moved by `PlayerSystem` at the 1.400 m/s
 * this project measured, with the head bob tuned to that gait, and it is
 * stopped by the same collision field as a player. The route is a list of
 * waypoints and the aim is smoothed toward them, which is what makes it read as
 * a person rather than a crane: real footsteps, real head bob, real stop when
 * it meets a bollard.
 *
 * **3. The interactions are the real interactions.** Each is `__INTERACT
 * .click()`, the same centre-screen raycast a player's mouse performs. If the
 * pump is out of reach the film shows it failing, which is the point.
 *
 * Audio is rendered through an `OfflineAudioContext` substituted for the
 * realtime one before `AudioSystem` arms, and stepped in lock with the
 * simulation via `suspend()`/`resume()`. See `renderAudio` below for why the
 * sample rate is 46080 rather than 48000.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchOptions, assertHardwareGpu, assertSceneGpu } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "shots", "film");
const FRAME_DIR = path.join(OUT_DIR, "frames");
const PORT = 5151;
// Under this tool's own output directory, not the shared `.shot-build/`, which
// another agent cleared out from under a --no-build run tonight and turned into
// a 404 on the page load. Same lesson as the survey file that kept vanishing
// from `.work/`: a scratch directory with more than one owner has no owner.
const BUILD_DIR = "shots/film/.build";
const REQUIRED_GPU = /RTX\s*4060/i;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const FPS = opt("fps", 30);
const WIDTH = opt("width", 1600);
const HEIGHT = Math.round((WIDTH * 9) / 16);
const MAX_SECONDS = opt("duration", 0);
const WANT_AUDIO = !flag("no-audio");
/**
 * Screenshotting is ~95% of the wall time, and none of it is needed while
 * working on where the route goes. `--no-capture` runs the identical simulation
 * and reports the identical route in forty seconds instead of nine minutes.
 *
 * Module scope rather than local to `main()`, because the frame directory is
 * cleared at the top of `main()` and has to know whether this run intends to
 * refill it.
 */
const CAPTURE = !flag("no-capture");

/**
 * The route, as a person would describe it.
 *
 * `hold` beats stand still and look at something. `walk` beats hold KeyW and
 * steer at the waypoint, ending when they arrive or when the collision field
 * stops them — so a leg has a *budget* rather than a duration, and the film
 * absorbs a leg that runs long instead of teleporting to stay on schedule.
 *
 * Coordinates come from the walk probe's own survey of the scene: the north
 * pump island is `x[-0.82, 0.82] z[22.70, 23.70]`, the door opening admits a
 * body centred between x = -6.45 and -5.65 at the wall plane z = 31.5, the
 * first gondola run stops a walker at z = 33.68, and the cooler doors face the
 * aisle at z ~ 38.7.
 */
const ROUTE = [
  // The pump is worked from the *north* face, standing between the island and
  // the building. The first version of this route stood south of the island and
  // aimed at `display:north`, which is on the far side — so the beat that was
  // supposed to show the meter ticking showed the pump's flank and its keypad,
  // and the walk to the door then had to detour the whole island, overran its
  // budget, arrived 2.15 m short, and missed the door click. Standing on the
  // side the display faces fixes the shot and the route in one move.
  { kind: "hold", secs: 0.4, find: "pump-3:display:north", note: "under the canopy, facing the north pump" },
  { kind: "walk", stand: 1.35, find: "pump-3:display:north", budget: 3.4, note: "step up to the dispenser" },
  { kind: "click", expect: "pump", find: "pump-3:display:north", note: "lift the nozzle — the meter starts ticking" },
  { kind: "hold", secs: 1.4, find: "pump-3:display:north", note: "watch the gallons climb" },
  { kind: "walk", stand: 1.15, find: "entry-door-glass$", budget: 8.0, note: "cross the forecourt to the shop door" },
  { kind: "click", expect: "door", find: "entry-door-glass$", note: "the bell, and the leaf swings" },
  { kind: "hold", secs: 0.5, aim: [-6.05, 1.7, 34.5], note: "let it open" },
  { kind: "walk", to: [-6.05, 33.2], find: "cooler-door-glass-3", budget: 2.8, note: "over the threshold, into the light change" },
  // Look down the shop at the cooler bank over the shelving. Whether the next
  // beat walks or cuts, this shot is what makes it legible: the destination is
  // on screen before the film either goes to it or arrives there.
  //
  // Aimed at the bank's illuminated sign band rather than at the bottle, and the
  // one wide interior shot in the film. The interior is its weakest register —
  // Building measures p50 181 inside against 82 outside, so the brief's
  // door-opening contrast is currently inverted — so this points at the one thing
  // in the room with contrast and legible type, and does not linger.
  { kind: "hold", secs: 1.1, find: "grab-bottle", offset: [0, 0.85, 0], note: "the lit cooler bank, down the shop" },
  // Walk to the cooler if walking is worth watching, and cut if it is not. 8 m is
  // about 5.7 s at 1.400 m/s, which is as much of an 18 s film as an aisle can
  // earn; the route to the cooler is currently ~18 m to cover ~5 m, so this will
  // cut and say why until Building pulls gondola run B back. The budget is much
  // larger than the threshold on purpose: a walk that is going to happen should
  // be allowed to finish, and it is the measurement — not the budget expiring —
  // that decides whether it happens.
  //
  // `face` keeps the stance on the aisle side of the bank. Without it the search
  // took the roomiest spot on the ring, 66 deg round to the west, from where
  // opening a leaf swung it across the line to the bottle.
  {
    kind: "walk",
    stand: 1.05,
    find: "grab-bottle",
    face: [0, -1],
    budget: 14.0,
    cutIfOver: 8.0,
    fovOnCut: 36,
    note: "through the shop to the drinks cooler",
  },
  // The holds aim above the bottle; only the clicks aim at it. The aisle in
  // front of the cooler bank is 1.09 m wide (gondola run B ends at z 37.55, the
  // bank starts at 38.64), so the camera can only be 0.6 m off a bottle sitting
  // at y 1.22 — a 37 deg downward pitch, which photographs the shelf edges
  // converging and reads as a rolled frame rather than as looking into a fridge.
  // Raising the aim 320 mm costs the shot nothing and the clicks nothing.
  { kind: "hold", secs: 0.7, find: "grab-bottle", offset: [0, 0.32, 0], note: "pick a door" },
  // Aimed at the bottle rather than at the nearest cooler door, because those are
  // not the same door: the nearest was two along, and opening it swung a leaf
  // across the line to the bottle so the grab clicked the leaf. Clicking toward
  // the bottle hits the closed pane in front of it, which is the one to open.
  { kind: "click", expect: "cooler", find: "grab-bottle", note: "open the fridge door" },
  { kind: "hold", secs: 0.9, find: "grab-bottle", offset: [0, 0.32, 0], note: "the door swings, cold air" },
  { kind: "click", expect: "bottle", find: "grab-bottle", note: "take a bottle" },
  { kind: "hold", secs: 1.0, find: "grab-bottle", offset: [0, 0.32, 0], note: "bottle in hand" },
  // This click is expected to miss and is left in deliberately, because the miss
  // is the report. Opening a leaf that swings out 0.55 m into a 1.09 m aisle puts
  // it through the space the player is standing in, so from the only stance the
  // aisle allows there is nothing left to aim at to close it again. Removing the
  // beat would remove the only place that says so.
  { kind: "click", expect: "cooler", closest: "cooler-door-glass-\\d+$", note: "close it" },
  { kind: "hold", secs: 1.2, find: "grab-bottle", offset: [0, 0.32, 0], note: "settle" },
];

/**
 * Every property a beat is allowed to carry.
 *
 * Checked before the browser starts, because a beat key the executor does not
 * read is silently ignored, and this route has now lost the same argument twice
 * that way: `face` survived a revert on the beat but not in `stance()`'s
 * signature, so the constraint that keeps the camera on the aisle side of the
 * cooler bank was being dropped on the floor while the route still said it was
 * there. Nothing failed — it just quietly stood somewhere else. That is the same
 * shape as the filename that named a pose it was not at and the duplicate object
 * key that hashed every grid cell to `undefined`: an assertion made by naming,
 * checked nowhere. Two authors and a revert have edited this file, so the route
 * now states its own vocabulary and refuses anything outside it.
 */
const BEAT_KEYS = new Set([
  "kind", "note", "secs", "budget", "find", "offset", "aim", "to", "stand",
  "face", "expect", "closest", "cutIfOver", "fovOnCut", "fov",
]);
for (const [i, beat] of ROUTE.entries()) {
  const bad = Object.keys(beat).filter((k) => !BEAT_KEYS.has(k));
  if (bad.length) {
    throw new Error(`filmwalk: beat ${i} ("${beat.note}") has ${bad.map((b) => `"${b}"`).join(", ")}, which nothing reads`);
  }
  if (!["hold", "walk", "click", "cut"].includes(beat.kind)) {
    throw new Error(`filmwalk: beat ${i} ("${beat.note}") has kind "${beat.kind}", which nothing executes`);
  }
  if (beat.face && !beat.stand) {
    throw new Error(`filmwalk: beat ${i} ("${beat.note}") sets face but not stand, and face is only consulted while choosing a stance`);
  }
}

const resources = { server: null, browser: null };
async function shutdown() {
  if (resources.browser) await resources.browser.close().catch(() => {});
  resources.browser = null;
  if (resources.server) await resources.server.close().catch(() => {});
  resources.server = null;
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}\n${err.slice(-2500)}`))));
  });
}

/**
 * The page-side director. Installed once, then stepped from Node.
 *
 * Kept as a source string rather than a function reference because it runs in
 * the page and must not be transformed on the way in.
 */
const DIRECTOR = `(() => {
  const g = window.__GAME;
  const cam = g.camera;
  const surface = g.tryGet("building.floorHeight") ?? g.tryGet("groundHeight");

  // Take the loop. From here nothing advances unless step() says so, which is
  // what makes the output independent of this machine's frame rate.
  g.renderer.setAnimationLoop(null);

  const D = {
    dt: 0,
    simT: 0,
    /**
     * Planning grid pitch, and a cell id biased so negative indices survive.
     *
     * Named cellId rather than key because this object already has a "key"
     * method — the one that dispatches keyboard events — and an object literal
     * with the same property twice is not an error in JavaScript: the last
     * definition silently wins. So every grid cell was being "hashed" by the
     * keydown dispatcher, which returns undefined for any argument, so all cells
     * collided on undefined and the flood fill terminated after one cell while
     * reporting the site unwalkable.
     */
    STEP: 0.125,
    cellId: (i, j) => (i + 4096) * 65536 + (j + 4096),
    cellAt: (k) => [Math.floor(k / 65536) - 4096, (k % 65536) - 4096],
    _reach: null,
    /** Where the head is currently pointed, smoothed toward the requested aim. */
    aim: null,
    log: [],
    init(dt) {
      D.dt = dt;
      let t = 0;
      // Game.frame reads dt and elapsed from this clock. Replacing the two
      // accessors is less invasive than reimplementing frame(), and keeps every
      // system's own time handling exactly as it is in the browser.
      g.clock.getDelta = () => { t += dt; g.clock.elapsedTime = t; return dt; };
      g.clock.getElapsedTime = () => t;
    },
    key(type, code) { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true })); },
    /**
     * One simulation step at the fixed timestep, plus one render, plus one
     * frame of audio.
     *
     * The order matters. The game frame runs the systems, and any sound they
     * trigger is scheduled against the audio context's currentTime — so the
     * audio clock must be sitting at this frame's time while the systems run,
     * and is only then advanced to the next. That is what makes the bell land on
     * the frame the door starts moving rather than at the top of the file.
     */
    async step() {
      g.frame();
      D.simT += D.dt;
      const A = window.__FILM_AUDIO;
      if (A && A.rendering) await A.advanceTo(D.simT);
    },
    /** Ease the head toward a world point instead of snapping to it. */
    look(target, rate) {
      if (!D.aim) D.aim = target.slice();
      const k = 1 - Math.exp(-rate * D.dt);
      for (let i = 0; i < 3; i++) D.aim[i] += (target[i] - D.aim[i]) * k;
      cam.lookAt(D.aim[0], D.aim[1], D.aim[2]);
    },
    place(x, z, aim) {
      cam.position.set(x, surface(x, z) + 1.65, z);
      D.aim = aim.slice();
      cam.lookAt(aim[0], aim[1], aim[2]);
    },
    pos() { return [cam.position.x, cam.position.z]; },
    /**
     * The world centre of the first mesh whose name matches, so the head aims
     * at the actual object rather than at a coordinate somebody typed. The
     * first cut of this route was aimed at hand-picked heights and spent its
     * pump beat looking at the keypad while the meter it was supposed to be
     * showing sat above the top of frame.
     */
    find(re) {
      const rx = new RegExp(re, "i");
      let hit = null;
      g.scene.traverse((o) => {
        if (hit || !(o.isMesh || o.isInstancedMesh) || !rx.test(o.name)) return;
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new o.position.constructor());
        o.localToWorld(c);
        hit = { name: o.name, at: [c.x, c.y, c.z] };
      });
      return hit;
    },
    /**
     * Is a body of radius r free to stand at (x, z)?
     *
     * Asked of the live collision field by handing it a scratch point and
     * seeing whether it pushes it — the field resolves in place, so a point it
     * does not move is a point that was already clear.
     */
    free(x, z, r) {
      const field = g.tryGet("collision.field");
      if (!field) throw new Error("filmwalk: no collision.field to plan against");
      // Default to the radius the *player* is actually subject to at that spot,
      // which is narrower inside the doorway portal. The first version of this
      // planner padded to 0.36 "for margin", which made it refuse routes the
      // player could physically walk — the aisle past the first gondola run
      // among them, so the cooler came back unreachable. Padding a rectangle
      // the consumer already pads is the same mistake this project wrote into
      // the blocker contract for everyone else.
      const rr = r === undefined ? field.radiusAt(x, z, 0.32, 0.2) : r;
      const p = cam.position.clone();
      p.set(x, 1.6, z);
      // resolve() reports whether it had to move the point, which is the
      // question being asked, so take its word for it rather than re-deriving
      // the answer from the coordinates it wrote back.
      return !field.resolve(p, rr);
    },
    /**
     * A place to stand to look at something, chosen by asking the scene.
     *
     * Every stance in the first three cuts of this route was a coordinate typed
     * from a plan, and each one was wrong in its own way: the pump stance stood
     * on the blind side of the island so the meter beat photographed the pump's
     * flank, and the cooler stance sat behind a gondola. So the route now names
     * the thing to look at and how far back to stand, and this searches the
     * ring at that radius for a spot that is (a) clear for a body, (b) has an
     * unobstructed line to the target, and (c) has a path from where the camera
     * is now — then takes the nearest such spot, so the walk is the short way
     * round rather than whichever way the author pictured.
     */
    stance(target, distance, face) {
      const here = [cam.position.x, cam.position.z];
      /**
       * Is the view from a candidate stance to the target unobstructed?
       *
       * The ray has to stop *short* of the target, because every one of these
       * targets — a pump display, a door pane, a cooler door — sits inside its
       * own collision rectangle. The first version sampled the whole line and
       * so found the target itself in the way, which rejected all 36 candidates
       * at all three stances and cut the film from 18 s to 5 s. What this is
       * looking for is something *between* the two, like an island kerb or a
       * canopy column, so it tests the near half and leaves the object alone.
       */
      const sight = (from, d) => {
        // Against the candidate's own distance, not the requested one. The sweep
        // below grows the radius by up to 1.6 m, and a ray traced to the
        // requested length from a candidate half again as far away stops in open
        // air short of whatever is actually in the way.
        const stop = Math.min(0.7, d * 0.45);
        const span = Math.max(0, d - stop);
        const n = Math.ceil(span / 0.1);
        for (let i = 1; i <= n; i++) {
          const u = (i / n) * (span / d);
          if (!D.free(from[0] + (target[0] - from[0]) * u, from[1] + (target[2] - from[1]) * u, 0.05)) return false;
        }
        return true;
      };
      // The requested distance is a preference, not a constraint, so sweep
      // outward until there is somewhere to stand. Asking for exactly 1.25 m off
      // the cooler found nothing at all: the free aisle floor in front of it
      // starts nearer 1.9 m back, and a fixed ring radius that happens to land
      // inside the fixtures reports "unreachable" for a spot the walk probe has
      // stood on all night. The standoff the room allows is a property of the
      // room, so it is discovered rather than declared.
      const byNear = (p, q) => p.from - q.from;
      /**
       * Accept a candidate only if the walk to it is roughly as long as the
       * straight line, because a huge detour ratio means the spot is on the
       * other side of a wall from here.
       *
       * Straight-line distance alone is not enough to catch that. The stance
       * this replaces was 7.26 m away in a straight line — *shorter* than the
       * 7.83 m forecourt crossing that is perfectly sensible — but it was
       * behind the building, and the path to it left the shop, went round the
       * outside and came back, 24 m of walking to stand 7 m away. The detour
       * ratio separates the two; the distance does not.
       */
      const { dist } = D.reach();
      const gi = (v) => Math.round(v / D.STEP);
      const consider = (c) => {
        const len = dist.get(D.cellId(gi(c.at[0]), gi(c.at[1])));
        return len === undefined ? null : { ...c, len };
      };
      // Sight first, across every standoff distance, before any stance without
      // it is considered at all. Interleaving the two let an unsighted spot at
      // 3.1 m beat a sighted one further out — and the spot it picked for the
      // cooler was outside the building's west wall, aiming through it, with a
      // 14.7 m route to stand 5.5 m away. A stance that cannot see the thing it
      // is there to film is not a cheaper version of one that can.
      let fallback = null;
      for (const requireSight of [true, false]) {
        for (let grow = 0; grow <= 1.6; grow += 0.15) {
          for (const d of grow === 0 ? [distance] : [distance + grow, distance - grow]) {
            if (d < 0.5) continue;
            const list = [];
            for (let deg = 0; deg < 360; deg += 10) {
              const a = (deg * Math.PI) / 180;
              const c = [target[0] + Math.cos(a) * d, target[2] + Math.sin(a) * d];
              // Which side of the thing to stand on, when the route knows and the
              // geometry does not say. A clear view of a *closed* fridge is not a
              // clear view of an open one: standing 66 deg off the cooler bank's
              // normal put the leaf across the line to the bottle once it opened,
              // so the grab clicked the leaf. Sight-testing cannot catch that,
              // because at the moment it runs the door is still shut.
              if (face && Math.cos(a) * face[0] + Math.sin(a) * face[1] < 0.55) continue;
              if (!D.free(c[0], c[1])) continue;
              if (requireSight && !sight(c, d)) continue;
              list.push({ at: c, from: Math.hypot(c[0] - here[0], c[1] - here[1]), stood: +d.toFixed(2) });
            }
            list.sort(byNear);
            for (const c of list.slice(0, 8)) {
              const r = consider(c);
              if (!r) continue;
              const hit = {
                at: r.at, walk: +r.from.toFixed(2), route: +r.len.toFixed(2),
                stood: r.stood, tried: list.length, sighted: requireSight,
              };
              if (r.len <= Math.max(3, r.from * 2.0)) return hit;
              // Reachable, but only the long way round. Hold it in case nothing
              // better turns up, and say so if it is what we end up using.
              if (!fallback || r.len < fallback.route) fallback = { ...hit, detour: true };
            }
          }
        }
        if (fallback) return fallback;
      }
      return fallback;
    },
    /**
     * Waypoints from here to a goal, planned on the real collision field.
     *
     * The first cut of the route walked straight at the cooler and was stopped
     * dead by the first gondola run 3.8 m short of it, so all three fridge
     * interactions clicked on nothing. The player *can* reach the cooler — the
     * walk probe's flood fill says every obstacle-free cell in the building is
     * reachable — but not in a straight line, and picking the way round by hand
     * from a plan drawing is how the straight line got chosen in the first
     * place. So the route asks the collision field instead: breadth-first on a
     * 0.25 m grid, then keep only the corners, so a leg that has to round an
     * aisle end does that and a leg that is already clear stays one straight
     * walk.
     */
    /**
     * Flood the walkable floor from where the camera stands, once, and keep the
     * distance and predecessor for every cell.
     *
     * Everything that needs a route uses this one map. The version before it ran
     * a fresh breadth-first search per candidate stance, which was both slow and
     * why picking a target among eight cooler doors was never attempted: eight
     * doors times a sweep of standoff distances times a search each was too much
     * to contemplate. One flood answers all of them, so the route can ask "which
     * of these is nearest on foot" instead of being told which one to use.
     */
    reach() {
      const STEP = D.STEP;
      const here = [cam.position.x, cam.position.z];
      const door = g.tryGet("building.entryDoor");
      const stamp =
        Math.round(here[0] / STEP) + "," + Math.round(here[1] / STEP) +
        "," + (door ? Math.round((door.amount || 0) * 20) : 0);
      if (D._reach && D._reach.stamp === stamp) return D._reach;

      const gi = (v) => Math.round(v / STEP);
      const s = [gi(here[0]), gi(here[1])];
      // A NaN grid index is the one failure this search cannot survive quietly:
      // NaN passes every bounds comparison and Map.has(NaN) is true, so the
      // frontier discards all eight neighbours and the flood terminates with
      // exactly one cell — reported as "the whole site is unwalkable" rather
      // than as an arithmetic fault.
      if (!Number.isFinite(s[0]) || !Number.isFinite(s[1]) || !Number.isFinite(STEP)) {
        throw new Error(
          "filmwalk: planner origin is not a number (camera at " +
            cam.position.x + ", " + cam.position.z + ", grid pitch " + STEP + ")"
        );
      }
      const SLACK = Math.round(34 / STEP);
      const lo = [s[0] - SLACK, s[1] - SLACK];
      const hi = [s[0] + SLACK, s[1] + SLACK];
      const dist = new Map();
      const back = new Map();
      const k0 = D.cellId(s[0], s[1]);
      dist.set(k0, 0);
      let front = [s];
      const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (let depth = 1; front.length && depth < 20000; depth++) {
        const next = [];
        for (const [i, j] of front) {
          const from = D.cellId(i, j);
          const d0 = dist.get(from);
          for (const [di, dj] of MOVES) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < lo[0] || ni > hi[0] || nj < lo[1] || nj > hi[1]) continue;
            const k = D.cellId(ni, nj);
            if (dist.has(k)) continue;
            if (!D.free(ni * STEP, nj * STEP)) continue;
            // A diagonal may not squeeze between two blocked cells, or the route
            // cuts a corner the body cannot.
            if (di && dj && (!D.free(ni * STEP, j * STEP) || !D.free(i * STEP, nj * STEP))) continue;
            dist.set(k, d0 + (di && dj ? 1.4142 : 1) * STEP);
            back.set(k, from);
            next.push([ni, nj]);
          }
        }
        front = next;
      }
      D._reach = { stamp, dist, back, origin: here, cells: dist.size };
      return D._reach;
    },
    path(goal, r) {
      // 0.125 m, not 0.25 m, and eight-connected. At 0.25 m with only the four
      // axis moves the grid could not thread the shop aisle — every cell centre
      // in a 0.8 m gap failed the 0.32 m body test at that alignment — so the
      // planner declared the cooler unreachable, and the stance search then
      // "solved" it by finding a spot behind the building and routing the walk
      // out of the shop and round the outside. A planner coarser than the gaps
      // it plans through does not report that it cannot see them.
      const STEP = D.STEP;
      const { dist, back } = D.reach();
      const gi = (v) => Math.round(v / STEP);
      let t = D.cellId(gi(goal[0]), gi(goal[1]));
      if (!dist.has(t)) {
        // The exact cell may be a hair inside a blocker even when the spot is
        // usable, so accept the nearest flooded cell within a body's width.
        const span = Math.ceil(0.3 / STEP);
        let bestK = null;
        let bestD = Infinity;
        for (let di = -span; di <= span; di++) {
          for (let dj = -span; dj <= span; dj++) {
            const k = D.cellId(gi(goal[0]) + di, gi(goal[1]) + dj);
            if (!dist.has(k)) continue;
            const d = di * di + dj * dj;
            if (d < bestD) { bestD = d; bestK = k; }
          }
        }
        if (bestK == null) return null;
        t = bestK;
      }
      const cells = [];
      for (let k = t; k != null; k = back.get(k)) {
        const [ci, cj] = D.cellAt(k);
        cells.push([ci * STEP, cj * STEP]);
        if (!back.has(k)) break;
      }
      cells.reverse();
      // Keep only the turns: walk forward while the straight line stays clear.
      const clear = (a, b) => {
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (STEP * 0.6));
        for (let i = 1; i < n; i++) {
          const u = i / n;
          if (!D.free(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, r)) return false;
        }
        return true;
      };
      const out = [];
      let anchor = cells[0];
      for (let i = 2; i < cells.length; i++) {
        if (!clear(anchor, cells[i])) {
          out.push(cells[i - 1]);
          anchor = cells[i - 1];
        }
      }
      out.push([goal[0], goal[1]]);
      return out;
    },
    /**
     * Of every mesh matching the pattern, the one with the shortest walk to a
     * usable stance — and that stance.
     *
     * The route used to name a single cooler door, and that door turned out to
     * be on the far side of a gondola run: reaching it meant 17 m of walking to
     * cover 5 m, which is most of a 20 second film spent in an aisle. Which of
     * eight identical fridge doors a person uses is not a decision worth making
     * in advance — it is whichever one they are nearest — so the route names the
     * family and this picks the member.
     */
    nearest(re, distance) {
      const rx = new RegExp(re, "i");
      const found = [];
      g.scene.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh) || !rx.test(o.name)) return;
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new o.position.constructor());
        o.localToWorld(c);
        found.push({ name: o.name, at: [c.x, c.y, c.z] });
      });
      let best = null;
      for (const f of found) {
        const s = D.stance(f.at, distance);
        if (!s) continue;
        if (!best || (s.detour ? 1e6 : 0) + s.route < (best.stance.detour ? 1e6 : 0) + best.stance.route) {
          best = { target: f, stance: s };
        }
      }
      return best ? { ...best, among: found.length } : null;
    },
    /**
     * A place to stand to look at something, with no requirement that a walk can
     * get there — for a cut rather than a move.
     *
     * The shop cannot be crossed: both gondola runs span the door's line of
     * travel and close off at the west wall with 0.70 m to spare, so the only
     * route from the door to the drinks cooler is 18.8 m round the east end to
     * cover 5 m, which is 13 s of the 20 s film spent walking past shelving, and
     * in practice the body sticks in the 0.82 m gap by the till instead. That is
     * the shop's layout and it is Building's to change; it is not something this
     * harness should paper over by walking faster or shrinking the body.
     *
     * So the film cuts. A cut is what a person editing this footage would do
     * anyway, and it is honest in a way that a sped-up walk is not: it makes no
     * claim about the intervening ground. The one thing it must not do is cut to
     * a spot wedged between two shelves, so candidates are scored by how much
     * clear floor surrounds them rather than by how near they are.
     */
    spot(target, distance, face) {
      /** The largest body that fits here, which is what "room to stand" means. */
      const clearance = (c) => {
        let r = 0.32;
        for (const t of [0.45, 0.6, 0.75, 0.9]) { if (!D.free(c[0], c[1], t)) break; r = t; }
        return r;
      };
      // The ray must stop short of the target, which sits inside its own
      // collision rectangle, but *how* short has to be measured against the
      // candidate's actual distance rather than the one the route asked for.
      // Getting that wrong put the first cut 1.8 m outside the shop's back wall:
      // the sweep had grown the radius to 2.85 m while the ray was still only
      // being traced 0.8 m, so it stopped in open air short of the wall and
      // reported a clear view of a bottle on the other side of it.
      const sight = (from, d) => {
        const stop = Math.min(0.7, d * 0.45);
        const span = Math.max(0, d - stop);
        const n = Math.ceil(span / 0.1);
        for (let i = 1; i <= n; i++) {
          const u = (i / n) * (span / d);
          if (!D.free(from[0] + (target[0] - from[0]) * u, from[1] + (target[2] - from[1]) * u, 0.05)) return false;
        }
        return true;
      };
      let best = null;
      for (let grow = 0; grow <= 1.4; grow += 0.15) {
        for (const d of grow === 0 ? [distance] : [distance + grow, distance - grow]) {
          if (d < 0.6) continue;
          for (let deg = 0; deg < 360; deg += 6) {
            const a = (deg * Math.PI) / 180;
            const c = [target[0] + Math.cos(a) * d, target[2] + Math.sin(a) * d];
            // Which side of the thing to stand on, when the route knows and the
            // geometry does not say. Standing 66 deg off the cooler bank's normal
            // put the open door leaf across the line to the bottle, so the grab
            // clicked the leaf instead: a spot with a clear view of a *closed*
            // fridge is not necessarily a spot with a clear view of an open one,
            // and the only general answer is to face the thing you are opening.
            const align = face ? (Math.cos(a) * face[0] + Math.sin(a) * face[1]) : 1;
            if (align < 0.55) continue;
            if (!D.free(c[0], c[1])) continue;
            if (!sight(c, d)) continue;
            const room = clearance(c);
            // Squarely in front first, then room, then the distance asked for.
            const score = align * 200 + room * 100 - Math.abs(d - distance);
            if (!best || score > best.score) best = { at: c, room, stood: +d.toFixed(2), align: +align.toFixed(2), score };
          }
        }
        if (best && best.room >= 0.75) break;
      }
      return best;
    },
    /**
     * Change lens.
     *
     * Only ever at a cut, never within a shot — a mid-shot change is a zoom, and
     * nothing in this film is a zoom. The reason it exists is that the store
     * interior is the weakest thing in the scene: the packaged goods read as flat
     * coloured boxes, the floor and ceiling are near-uniform, and there is almost
     * no shadow indoors. A 52 deg lens 0.6 m off the cooler bank puts a band of
     * that room along the bottom and top of frame. A tighter one fills the frame
     * with the door glass and the cooler's own light, which are the two things in
     * there that do read. Framing away from a weakness is a shot-list decision,
     * not a fix, and the weakness is still logged for Building and Lighting.
     */
    lens(fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
      return cam.fov;
    },
    /** Put the camera somewhere and point it, for a cut. */
    cutTo(at, aim) {
      D.place(at[0], at[1], aim);
      // The flood fill is anchored on where the camera was; it is now somewhere
      // else, so anything the next beat plans has to be planned afresh.
      D._reach = null;
      return D.pos();
    },
    /**
     * The matching mesh nearest the camera right now.
     *
     * Which of eight identical fridge doors to click is a question best asked
     * from where the player is standing, not written into the route in advance.
     */
    closest(re) {
      const rx = new RegExp(re, "i");
      let best = null;
      g.scene.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh) || !rx.test(o.name)) return;
        o.updateWorldMatrix(true, false);
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new o.position.constructor());
        o.localToWorld(c);
        const d = Math.hypot(c.x - cam.position.x, c.z - cam.position.z);
        if (!best || d < best.d) best = { name: o.name, at: [c.x, c.y, c.z], d };
      });
      return best;
    },
    /** Solid rectangles near a point, to explain why a route has to detour. */
    blockersNear(x, z, radius) {
      const field = g.tryGet("collision.field");
      const out = [];
      for (const gr of field.groups || []) {
        for (const b of gr.blockers || []) {
          const cx = (b.minX + b.maxX) / 2;
          const cz = (b.minZ + b.maxZ) / 2;
          if (Math.hypot(cx - x, cz - z) > radius) continue;
          out.push({
            group: gr.key,
            x: [+b.minX.toFixed(2), +b.maxX.toFixed(2)],
            z: [+b.minZ.toFixed(2), +b.maxZ.toFixed(2)],
          });
        }
      }
      return out;
    },
    /** Every mesh name matching a pattern, for surveying what is available. */
    survey(re) {
      const rx = new RegExp(re, "i");
      const names = new Set();
      g.scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && rx.test(o.name)) names.add(o.name); });
      return [...names].slice(0, 40);
    },
    dist(to) { return Math.hypot(cam.position.x - to[0], cam.position.z - to[1]); },
    click() {
      const r = window.__INTERACT ? window.__INTERACT.click() : null;
      D.log.push({ t: +D.simT.toFixed(3), click: r });
      return r;
    },
    state() { return window.__INTERACT ? window.__INTERACT.state() : null; },
  };
  window.__FILM = D;
})()`;

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  // Only clear the frames if this run is going to write frames. `--no-capture`
  // exists to route and time the film in forty seconds instead of nine minutes,
  // and two of those runs deleted a completed PNG sequence while producing
  // nothing to replace it: the rm sat above the flag it should have been under,
  // so the cheap diagnostic mode was the destructive one. Nothing was lost
  // because the encode had already happened, which is the only reason this was
  // an inconvenience rather than the deliverable.
  if (CAPTURE) {
    await fs.rm(FRAME_DIR, { recursive: true, force: true });
    await fs.mkdir(FRAME_DIR, { recursive: true });
  }

  const haveBuild = await fs
    .access(path.join(ROOT, BUILD_DIR, "index.html"))
    .then(() => true)
    .catch(() => false);
  if (!haveBuild && flag("no-build")) console.log("[film] --no-build asked for, but there is no build to reuse — building anyway");
  if (!flag("no-build") || !haveBuild) {
    console.log("[film] building");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });

  resources.browser = await chromium.launch(launchOptions());
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "debug") return;
    if (/error|fail|shader|invalid|warn/i.test(t)) problems.push(t);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 60_000 });
  const gpu = await assertHardwareGpu(page, { tag: "film" });
  if (!REQUIRED_GPU.test(String(gpu.renderer))) throw new Error(`expected RTX 4060, got ${gpu.renderer}`);

  // Audio has to be substituted before anything constructs the listener, which
  // happens when AudioSystem arms on the first pointer event.
  const audioPlan = WANT_AUDIO ? await installOfflineAudio(page, FPS) : null;

  await page.waitForFunction(() => window.__SCENE_READY === true, { timeout: 240_000 });
  await page.evaluate(() => {
    for (const id of ["hud", "loading"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
  });
  await page.evaluate(DIRECTOR);
  await page.evaluate((fps) => window.__FILM.init(1 / fps), FPS);

  // Resolve every `find` aim against the scene graph before shooting, and say
  // what resolved to what. A route aimed at coordinates is a route that goes
  // subtly wrong the moment a system moves its geometry; a route aimed at named
  // meshes fails loudly instead.
  const survey = await page.evaluate(() => ({
    pumpDisplay: window.__FILM.survey("pump.*(display|meter|price|digit|lcd|screen)"),
    cooler: window.__FILM.survey("cooler-door"),
    bottle: window.__FILM.survey("bottle"),
    door: window.__FILM.survey("entry-door"),
  }));
  console.log("[film] scene survey:");
  for (const [k, v] of Object.entries(survey)) console.log(`    ${k}: ${v.slice(0, 6).join(", ") || "(none)"}`);

  for (const beat of ROUTE) {
    if (!beat.find) continue;
    const hit = await page.evaluate(([re]) => window.__FILM.find(re), [beat.find]);
    if (!hit) throw new Error(`route: no mesh matches /${beat.find}/ — the scene moved under the route`);
    beat.aim = [hit.at[0] + (beat.offset?.[0] ?? 0), hit.at[1] + (beat.offset?.[1] ?? 0), hit.at[2] + (beat.offset?.[2] ?? 0)];
    console.log(`    aim /${beat.find}/ -> ${hit.name} at (${beat.aim.map((v) => v.toFixed(2)).join(", ")})`);
  }


  // AudioSystem arms on pointerdown, and the same press is the gesture that
  // InteractionSystem treats as the first click, so it is dispatched on empty
  // sky rather than on a target.
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.up();
  if (audioPlan) {
    // AudioSystem's arm() is async, and the continuous beds — highway wash,
    // fridge compressor, fluorescent buzz, pump motor — are all started at the
    // context time it holds when it finishes. Let it finish before the clock
    // starts moving, or the beds begin partway into the take.
    await page.waitForFunction(() => window.__GAME.tryGet("audio")?.ready === true, { timeout: 30_000 });
    await page.evaluate(() => window.__FILM_AUDIO.begin());
    console.log("[film] audio: graph armed and render clock started at t=0");
  }
  await page.evaluate(async () => {
    const D = window.__FILM;
    for (let i = 0; i < 8; i++) await D.step();
  });

  await page.evaluate(([aim]) => window.__FILM.place(0.3, 27.5, aim), [ROUTE[0].aim]);

  // What is between the door and the cooler, said plainly, because a long
  // interior leg looks like a routing bug and is actually the shop's layout.
  const interior = await page.evaluate(() => window.__FILM.blockersNear(-3, 35.5, 15));
  console.log(`[film] solids inside and around the shop (within 15 m of (-3, 35.5)): ${interior.length}`);
  for (const b of interior.slice(0, 30)) {
    console.log(`    ${b.group.padEnd(22)} x[${b.x[0]}, ${b.x[1]}]  z[${b.z[0]}, ${b.z[1]}]`);
  }

  console.log(`\n[film] ${WIDTH}x${HEIGHT} at ${FPS} fps, fixed ${(1000 / FPS).toFixed(1)} ms timestep`);
  console.log("[film] route:");

  const clip = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  let frame = 0;
  const maxFrames = MAX_SECONDS ? Math.round(MAX_SECONDS * FPS) : Infinity;
  const beats = [];

  /**
   * One frame to disk, checked twice.
   *
   * A nine-minute take is a long time to be wrong about, and both of these
   * failures are ones this project has already shipped once.
   *
   * The **dimension check** is because a valid PNG is not a valid frame: the
   * harnesses here have written structurally perfect 0x0 PNGs and exited 0. The
   * width and height live in the IHDR at a fixed offset, so 33 bytes read back
   * per frame settles it, and a wrong size on frame 1 stops the run instead of
   * being discovered in the encode.
   *
   * The **GPU recheck** is because `assertHardwareGpu` at launch answers a
   * weaker question than it looks like it does. Playwright injects
   * `--enable-unsafe-swiftshader` into every Chromium it starts, so a fallback
   * to software rasterisation mid-take is possible and a startup-only check
   * cannot see it; a context loss is worse, because the loop keeps running and
   * every later frame is a stale copy of the last good one. Every 120 frames is
   * four seconds of film — cheap against nine minutes, and it bounds how much
   * of a take can be quietly counterfeit.
   */
  const capture = async () => {
    if (CAPTURE) {
      const file = path.join(FRAME_DIR, `f${String(frame).padStart(5, "0")}.png`);
      await page.screenshot({ path: file, clip });
      if (frame === 0 || frame % 120 === 119) {
        const head = await fs.readFile(file).then((b) => b.subarray(0, 33));
        const w = head.readUInt32BE(16);
        const h = head.readUInt32BE(20);
        if (w !== Math.round(clip.width) || h !== Math.round(clip.height)) {
          throw new Error(`filmwalk: frame ${frame} is ${w}x${h}, expected ${clip.width}x${clip.height}`);
        }
        await assertSceneGpu(page, { tag: "film", when: `at frame ${frame} (t=${(frame / FPS).toFixed(2)}s)` });
      }
    }
    frame++;
  };
  if (!CAPTURE) console.log("[film] --no-capture: simulating and routing only, no frames, no encode");
  const reachInfo = await page.evaluate(() => {
    const D = window.__FILM;
    const r = D.reach();
    const o = r.origin;
    return {
      cells: r.cells,
      origin: o,
      step: D.STEP,
      hereFree: D.free(o[0], o[1]),
      aStepNorth: D.free(o[0], o[1] + 0.5),
      furthest: [...r.dist.values()].sort((a, b) => b - a)[0],
    };
  });
  console.log(
    `[film] walkable floor from (${reachInfo.origin.map((v) => v.toFixed(2)).join(", ")}): ${reachInfo.cells} cells at ` +
      `${reachInfo.step} m pitch, furthest ${reachInfo.furthest?.toFixed?.(1) ?? "?"} m on foot ` +
      `(standing spot clear: ${reachInfo.hereFree}, half a metre north clear: ${reachInfo.aStepNorth})`
  );
  if (reachInfo.cells < 500) throw new Error(`filmwalk: the walkable floor came back as ${reachInfo.cells} cells — the planner cannot see the scene`);

  for (const beat of ROUTE) {
    if (frame >= maxFrames) break;
    const t0 = frame / FPS;
    let detail = "";

    if (beat.fov) {
      const got = await page.evaluate(([f]) => window.__FILM.lens(f), [beat.fov]);
      console.log(`      lens ${got}\u00b0`);
    }

    if (beat.kind === "click") {
      if (beat.closest) {
        const c = await page.evaluate(([re]) => window.__FILM.closest(re), [beat.closest]);
        if (!c) throw new Error(`route: no mesh matches /${beat.closest}/`);
        beat.aim = c.at;
        console.log(`      nearest /${beat.closest}/ from here is ${c.name}, ${c.d.toFixed(2)} m away`);
      }
      const r = await page.evaluate(([aim]) => {
        const D = window.__FILM;
        D.look(aim, 8);
        return D.click();
      }, [beat.aim]);
      detail = r ? `hit ${r.kind}/${r.name} at ${r.distance.toFixed(2)} m` : "MISSED — nothing under the crosshair";
      if (!r) problems.push(`route: click expecting ${beat.expect} hit nothing at t=${t0.toFixed(2)}s`);
      else if (beat.expect && r.kind !== beat.expect) problems.push(`route: expected ${beat.expect}, got ${r.kind}`);
      // A click is instantaneous in sim time; give it a couple of frames so the
      // consequence is on screen before the next beat.
      for (let i = 0; i < 2 && frame < maxFrames; i++) {
        await page.evaluate(async ([aim]) => { window.__FILM.look(aim, 8); await window.__FILM.step(); }, [beat.aim]);
        await capture();
      }
    } else if (beat.kind === "cut") {
      const s = await page.evaluate(([aim, d, f]) => window.__FILM.spot(aim, d, f), [beat.aim, beat.stand, beat.face ?? null]);
      if (!s) throw new Error(`route: nowhere to stand ${beat.stand} m off /${beat.find}/ for a cut`);
      const at = await page.evaluate(([to, aim]) => window.__FILM.cutTo(to, aim), [s.at, beat.aim]);
      detail =
        `cut to (${at[0].toFixed(2)}, ${at[1].toFixed(2)}), ${s.stood} m off /${beat.find}/, ` +
        `${s.room.toFixed(2)} m of clear floor, ${(Math.acos(Math.min(1, s.align)) * 57.3).toFixed(0)}\u00b0 off the face`;
      console.log(`      ${detail}`);
      // A cut is one frame of film, but the systems need a step to settle the
      // new pose before it is photographed — a frame captured before the step
      // shows the old camera with the new time.
      await page.evaluate(async ([aim]) => { window.__FILM.look(aim, 60); await window.__FILM.step(); }, [beat.aim]);
      await capture();
    } else if (beat.kind === "hold") {
      const n = Math.round(beat.secs * FPS);
      for (let i = 0; i < n && frame < maxFrames; i++) {
        await page.evaluate(async ([aim]) => { window.__FILM.look(aim, 4.5); await window.__FILM.step(); }, [beat.aim]);
        await capture();
      }
      detail = `${beat.secs.toFixed(1)} s`;
    } else if (beat.kind === "walk") {
      // Plan the leg on the collision field. A leg that is already a clear
      // straight line comes back as one waypoint, so planning costs nothing
      // where it is not needed and rounds the aisle where it is.
      // A `stand` beat picks its own destination from the scene: the ring at
      // that radius around the thing it is going to look at, nearest first.
      if (beat.stand) {
        const s = await page.evaluate(([aim, d, f]) => window.__FILM.stance(aim, d, f), [beat.aim, beat.stand, beat.face ?? null]);
        if (!s) {
          problems.push(`route: nowhere to stand ${beat.stand} m off ${beat.find} at t=${t0.toFixed(2)}s`);
          console.log(`  ${t0.toFixed(2)}s            ${beat.note.padEnd(46)} NO STANCE ${beat.stand} m off /${beat.find}/`);
          continue;
        }
        beat.to = s.at;
        console.log(
          `      stance ${s.stood} m off /${beat.find}/${s.stood === beat.stand ? "" : ` (asked ${beat.stand})`}` +
            ` -> (${s.at[0].toFixed(2)}, ${s.at[1].toFixed(2)}), ${s.walk} m away by ${s.route} m of walking, ` +
            `${s.tried} candidates${s.sighted ? "" : " — NO CLEAR SIGHT LINE, view unverified"}${s.detour ? " — DETOUR, no direct route" : ""}`
        );
        if (!s.sighted) problems.push(`route: stance for ${beat.find} has no clear sight line to it`);
        if (s.detour) problems.push(`route: stance for ${beat.find} is only reachable the long way round (${s.route} m to go ${s.walk} m)`);
      }
      const legs = await page.evaluate(([to]) => window.__FILM.path(to), [beat.to]);
      if (!legs) {
        problems.push(`route: no walkable path to (${beat.to.join(", ")}) at t=${t0.toFixed(2)}s`);
        // Distinguish "the destination is inside something solid" from "the
        // destination is clear but walled off", because the two have entirely
        // different causes and the bare word "unreachable" hides which.
        const why = await page.evaluate(([to]) => window.__FILM.free(to[0], to[1]), [beat.to]);
        const diag = why ? "destination is clear but walled off from here" : "destination is inside solid geometry";
        beats.push({ note: beat.note, t0, t1: t0, detail: `UNREACHABLE — ${diag}` });
        console.log(`  ${t0.toFixed(2)}s            ${beat.note.padEnd(46)} UNREACHABLE — ${diag}`);
        continue;
      }
      const startedAt = await page.evaluate(() => window.__FILM.pos());
      const planned = legs.reduce(
        (acc, leg) => ({ len: acc.len + Math.hypot(leg[0] - acc.at[0], leg[1] - acc.at[1]), at: leg }),
        { len: 0, at: startedAt }
      ).len;
      const direct = Math.hypot(beat.to[0] - startedAt[0], beat.to[1] - startedAt[1]);
      console.log(`      planned ${planned.toFixed(1)} m over ${legs.length} leg${legs.length === 1 ? "" : "s"} to cover ${direct.toFixed(1)} m direct`);

      /**
       * Walk it if it is a walk; cut if it is a hike.
       *
       * This leg has been a cut and a walk in turn, and each time the choice was
       * made by an author who believed something about the shop. The cut was
       * written because the only route to the cooler was 18.8 m to cover 5 m. It
       * was then changed to a walk on the strength of "Building aligned the aisle
       * with the door and the store is reachable on foot" — but reachable is not
       * the same claim. Building widened the *east detour* from 0.82 m to 1.15 m
       * (`ISLAND.x0` -0.4 -> 0.15); `GONDOLA_X` is unchanged, so the runs still
       * span x -8.2 to -1.0 across a door at x -6.0 and the route is still round
       * the east end. Both authors were reasoning from a remembered fact rather
       * than from the plan in front of them, and both would have been wrong again
       * the next time the shop changed.
       *
       * So the route no longer decides. It states the longest walk that is worth
       * watching, this measures the planned one on the live collision field, and
       * it cuts only when the measurement says to. The day run B is pulled back
       * this becomes a walk again with no edit, and if the aisle ever closes it
       * becomes a cut again the same way.
       */
      if (beat.cutIfOver && planned > beat.cutIfOver) {
        const at = await page.evaluate(([to, aim]) => window.__FILM.cutTo(to, aim), [beat.to, beat.aim]);
        detail =
          `CUT instead of walked — ${planned.toFixed(1)} m of route to cover ${direct.toFixed(1)} m, ` +
          `over the ${beat.cutIfOver} m this shot is worth; now at (${at[0].toFixed(2)}, ${at[1].toFixed(2)})`;
        problems.push(
          `route: "${beat.note}" cut rather than walked — the planner needs ${planned.toFixed(1)} m ` +
            `to cover ${direct.toFixed(1)} m, so the walk would be ${(planned / 1.4).toFixed(1)} s of film`
        );
        console.log(`      ${detail}`);
        // A lens change is legitimate at a cut and nowhere else, so it is applied
        // here rather than on the beat: if this leg walks, it keeps the lens the
        // walk was shot on.
        if (beat.fovOnCut) console.log(`      lens ${await page.evaluate(([f]) => window.__FILM.lens(f), [beat.fovOnCut])}\u00b0`);
        await page.evaluate(async ([aim]) => { window.__FILM.look(aim, 60); await window.__FILM.step(); }, [beat.aim]);
        await capture();
        beats.push({ note: beat.note, t0, t1: frame / FPS, detail });
        continue;
      }

      const budget = Math.round(beat.budget * FPS);
      await page.evaluate(() => window.__FILM.key("keydown", "KeyW"));
      let i = 0;
      let heldBy = false;
      for (const [li, leg] of legs.entries()) {
        const last = li === legs.length - 1;
        let stalled = 0;
        let best = Infinity;
        for (; i < budget && frame < maxFrames; i++) {
          const d = await page.evaluate(
            async ([to, aim, last]) => {
              const D = window.__FILM;
              // Steer at the waypoint while it is far, then hand the head over
              // to the beat's aim as it arrives, so the turn starts before the
              // stop. Intermediate waypoints never take the beat's aim — the
              // head should be looking where it is going round a corner.
              const dist = D.dist(to);
              const y = D.aim ? D.aim[1] : 1.6;
              const steer = last && dist < 1.4 ? aim : [to[0], y, to[1]];
              D.look(steer, dist > 1.4 ? 3.2 : 5.0);
              await D.step();
              return D.dist(to);
            },
            [leg, beat.aim, last]
          );
          await capture();
          stalled = d >= best - 1e-3 ? stalled + 1 : 0;
          best = Math.min(best, d);
          if (d < (last ? 0.2 : 0.36) || stalled > 20) break;
        }
        if (stalled > 20) { heldBy = true; break; }
      }
      await page.evaluate(() => window.__FILM.key("keyup", "KeyW"));
      const arrived = await page.evaluate(([to]) => ({ d: window.__FILM.dist(to), at: window.__FILM.pos() }), [beat.to]);
      detail =
        `${(i / FPS).toFixed(2)} s over ${legs.length} leg${legs.length === 1 ? "" : "s"}, ` +
        `${arrived.d < 0.3 ? "arrived" : `stopped ${arrived.d.toFixed(2)} m short`} at (${arrived.at[0].toFixed(2)}, ${arrived.at[1].toFixed(2)})`;
      if (heldBy) detail += " — HELD BY COLLISION";
      if (heldBy) problems.push(`route: "${beat.note}" was held by collision ${arrived.d.toFixed(2)} m short of its destination`);
      if (arrived.d >= 0.3 && !heldBy) problems.push(`route: "${beat.note}" ran out of its ${beat.budget} s budget ${arrived.d.toFixed(2)} m short`);
      if (legs.length > 1) detail += `  via ${legs.slice(0, -1).map((l) => `(${l[0].toFixed(1)}, ${l[1].toFixed(1)})`).join(" ")}`;
    }

    const t1 = frame / FPS;
    beats.push({ note: beat.note, t0, t1, detail });
    console.log(`  ${t0.toFixed(2)}s - ${t1.toFixed(2)}s  ${beat.note.padEnd(46)} ${detail}`);
  }

  const durationS = frame / FPS;
  console.log(`\n[film] ${frame} frames = ${durationS.toFixed(2)} s of film`);
  if (durationS < 15 || durationS > 20) {
    problems.push(`the take is ${durationS.toFixed(2)} s — the brief asks for 15 to 20`);
  }

  const meterState = await page.evaluate(() => window.__FILM.state());
  const clicks = await page.evaluate(() => window.__FILM.log);
  console.log(`[film] interactions fired: ${clicks.map((c) => (c.click ? `${c.click.kind}@${c.t}s` : `MISS@${c.t}s`)).join(", ")}`);
  if (meterState) console.log(`[film] final state: ${JSON.stringify(meterState)}`);

  if (!CAPTURE) {
    await shutdown();
    console.log(`\n[film] problems: ${problems.length ? "" : "none"}`);
    for (const p of new Set(problems)) console.log(`    ${p}`);
    return { videoPath: null, beats, durationS, problems };
  }

  let audioPath = null;
  if (audioPlan) audioPath = await audioPlan.finish(page, durationS);

  await shutdown();

  const videoPath = await encode(frame, durationS, audioPath);

  console.log(`\n[film] problems: ${problems.length ? "" : "none"}`);
  for (const p of new Set(problems)) console.log(`    ${p}`);
  console.log(`\n[film] wrote ${path.relative(ROOT, videoPath)}`);
  return { videoPath, beats, durationS, problems };
}

/**
 * Substitute an OfflineAudioContext for the realtime one.
 *
 * `AudioSystem` builds its graph against `THREE.AudioContext`, which caches
 * `new (window.AudioContext)()` on first use. `three` is not importable from the
 * page in a production bundle, so the cache is reached by replacing the
 * constructor it calls rather than the module that calls it — a constructor that
 * returns an object supplies that object, so THREE caches ours.
 *
 * The sample rate is **46080, not 48000**, and that is not arbitrary.
 * `suspend()` can only stop rendering on a 128-sample render quantum boundary,
 * so a frame period has to be a whole number of quanta or the audio clock and
 * the video clock drift apart by a fraction of a quantum every frame. At 30 fps
 * 48000 gives 1600 samples per frame, which is 12.5 quanta and unusable;
 * 46080 gives exactly 1536 samples, or 12 quanta. ffmpeg resamples to 48 kHz on
 * the way into the container, which is a resample of a correct signal rather
 * than an accumulating desync.
 */
async function installOfflineAudio(page, fps) {
  const QUANTUM = 128;
  const perFrame = Math.round((46080 / fps) / QUANTUM) * QUANTUM;
  const rate = perFrame * fps;
  if (perFrame % QUANTUM !== 0) throw new Error(`audio: ${rate} Hz at ${fps} fps is not a whole number of render quanta`);

  const ok = await page.evaluate(
    ([rate, seconds]) => {
      if (typeof OfflineAudioContext !== "function") return { ok: false, why: "no OfflineAudioContext" };
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, sampleRate: rate, length: Math.ceil(rate * seconds) });
      // AudioSystem awaits ctx.resume() while arming, which on an offline
      // context before startRendering() is not a meaningful call. Absorb it;
      // the real resume() used to step rendering is captured first.
      const stepResume = ctx.resume.bind(ctx);
      const stepSuspend = ctx.suspend.bind(ctx);
      ctx.resume = () => (window.__FILM_AUDIO.rendering ? stepResume() : Promise.resolve());
      window.__FILM_AUDIO = {
        ctx,
        rate,
        rendering: false,
        done: null,
        /** Arm the first stop, start rendering, and wait for it to halt at 0. */
        async begin() {
          const first = stepSuspend(0);
          this.done = ctx.startRendering();
          await first;
          this.rendering = true;
        },
        /**
         * Run the render forward to `t` and stop there. The next stop has to be
         * armed *before* resuming, or rendering runs past it and the clock is
         * lost for the rest of the take.
         */
        async advanceTo(t) {
          if (!this.rendering || t <= ctx.currentTime + 1e-9) return;
          const next = stepSuspend(t);
          await stepResume();
          await next;
        },
        async finish() {
          await stepResume();
          return await this.done;
        },
      };
      const Real = window.AudioContext;
      function Substitute() { return ctx; }
      Substitute.prototype = Real.prototype;
      window.AudioContext = Substitute;
      window.webkitAudioContext = Substitute;
      return { ok: true, rate, length: Math.ceil(rate * seconds) };
    },
    [rate, 40]
  );
  if (!ok.ok) throw new Error(`audio: ${ok.why}`);
  console.log(`[film] audio: OfflineAudioContext at ${rate} Hz, ${perFrame} samples (${perFrame / QUANTUM} quanta) per video frame`);

  return {
    async finish(page, durationS) {
      const res = await page.evaluate(async ([durationS]) => {
        const A = window.__FILM_AUDIO;
        const buf = await A.finish();
        const n = Math.min(buf.length, Math.ceil(durationS * buf.sampleRate));
        const L = buf.getChannelData(0);
        const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        // Interleaved 16-bit PCM, base64'd. A 20 s stereo take is ~3.7 MB of
        // samples, which crosses the bridge in one go without ceremony.
        const out = new Int16Array(n * 2);
        let peak = 0;
        for (let i = 0; i < n; i++) {
          const l = Math.max(-1, Math.min(1, L[i]));
          const r = Math.max(-1, Math.min(1, R[i]));
          peak = Math.max(peak, Math.abs(l), Math.abs(r));
          out[i * 2] = l * 32767;
          out[i * 2 + 1] = r * 32767;
        }
        let bin = "";
        const bytes = new Uint8Array(out.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { b64: btoa(bin), rate: buf.sampleRate, frames: n, peak };
      }, [durationS]);
      const raw = path.join(OUT_DIR, "audio.raw");
      await fs.writeFile(raw, Buffer.from(res.b64, "base64"));
      console.log(`[film] audio: rendered ${(res.frames / res.rate).toFixed(2)} s, peak ${res.peak.toFixed(3)}${res.peak < 1e-4 ? "  *** SILENT ***" : ""}`);
      return { raw, rate: res.rate, silent: res.peak < 1e-4 };
    },
  };
}

async function encode(frames, durationS, audio) {
  const out = path.join(OUT_DIR, "dawn-station.mp4");
  const args = ["-y", "-framerate", String(FPS), "-i", path.join(FRAME_DIR, "f%05d.png")];
  if (audio && !audio.silent) {
    args.push("-f", "s16le", "-ar", String(audio.rate), "-ac", "2", "-i", audio.raw);
  }
  args.push("-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(FPS));
  if (audio && !audio.silent) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest");
  args.push(out);
  console.log(`\n[film] encoding ${frames} frames${audio && !audio.silent ? " and audio" : " (silent)"}`);
  await run("ffmpeg", args, "ffmpeg");
  const st = await fs.stat(out);
  if (st.size < 20_000) throw new Error(`the encode produced ${st.size} bytes — that is not ${durationS.toFixed(1)} s of video`);
  console.log(`[film] ${(st.size / 1e6).toFixed(2)} MB, ${durationS.toFixed(2)} s`);
  return out;
}

main()
  .then((r) => {
    // A take with problems in it is not a take that succeeded. Piping this
    // through `grep` or `tail` throws the status away — redirect to a file and
    // read `$?` instead. See PERF.md section 10.4.
    if (r?.problems?.length) {
      console.error(`\n[film] ${new Set(r.problems).size} problem(s) — see the list above`);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error(`\n[film] FAILED: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => shutdown());
