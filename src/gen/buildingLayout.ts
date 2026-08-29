/**
 * Where the building's things are, with no way to draw any of them.
 *
 * ## Why this file exists
 *
 * `BuildingSystem.init` could not be constructed outside a browser. It reads
 * `location.search`, then rasterises every texture it owns, and
 * `document.createElement("canvas")` is not shimmable the way `location` is. So
 * every CPU-side tool that needed anything from this system was dead — including
 * other systems' harnesses, one of which had to substitute an **empty blocker
 * list** and consequently over-planted the lot interior.
 *
 * The published things siblings actually consume are the footprint and the
 * blockers, and neither of them needs a rasteriser to exist. They are pure
 * arithmetic over plan dimensions. So they live here, importable on their own,
 * and `BuildingSystem` consumes this module rather than owning a second copy.
 *
 * ## The rule this is built to keep
 *
 * One source of truth, always. The last time this system held a dimension in two
 * places — the impulse island's geometry and its collision rect as two
 * hand-copied literals — the two could have desynchronised the first time either
 * moved, and the consequence would have been an invisible one: a shop that looks
 * right and cannot be walked. Nothing here may be duplicated in the system.
 *
 * Anything in this file must stay free of `document`, `window`, `location` and
 * THREE materials. Geometry helpers are fine; rasterisers are not.
 */

import { BUILDING, padY } from "../site.ts";

/**
 * The store occupies the eastern 12.6 m of the footprint reserved in `site.ts`.
 *
 * Every number is a real building dimension. A 3.6 m roof deck, a 0.75 m
 * parapet, a 2.78 m ceiling, a 2.13 m door and 16 × 8 in block are what an
 * actual single-storey highway store measures; getting any of them wrong is the
 * fastest way to turn a photoreal render into a dollhouse.
 */
export const PLAN = {
  x0: -9.1,
  x1: 3.5,
  z0: BUILDING.minZ, // 31.5 - the front elevation, facing the forecourt
  z1: BUILDING.maxZ, // 40.0 - the back
  wall: 0.2,

  roofDeck: 3.6,
  parapet: 4.35,
  ceiling: 2.78,

  /** Storefront glazing runs between the two CMU piers. */
  sfX0: -8.3,
  sfX1: 1.5,
  sillTop: 0.2, // CMU curb under the glazing
  kickTop: 0.5,
  glassTop: 2.6,
  headTop: 2.72,
  fasciaTop: 3.45,

  doorX0: -6.575,
  doorX1: -5.425,
  doorHeight: 2.13,
  transomBottom: 2.24,

  /** Centre of the storefront system within the wall thickness. */
  sfZ: 0.1,

  /** Height of the darker painted base band. */
  baseCourse: 0.62,
};

/** Inside face of the walls. */
export const IN = {
  x0: PLAN.x0 + PLAN.wall,
  x1: PLAN.x1 - PLAN.wall,
  z0: PLAN.z0 + PLAN.wall,
  z1: PLAN.z1 - PLAN.wall,
};

/**
 * Reach-in cooler along the back wall.
 *
 * `doors: 10` over 6.88 m of inner width, so a leaf is 668 mm rather than the
 * 848 mm it was. The reason is accuracy, not clearance: a reach-in door in a
 * forecourt store of this size is 24–30 inches, 610–760 mm, and 848 mm was 33
 * inches and read wide.
 *
 * Deliberately *not* justified by the aisle. The 220 mm standable band once
 * reported for the grab stance was wrong — it assumed an open leaf bounds where a
 * body may stand, and the leaf is neither a collision blocker nor on the sight
 * line to the bottle. Measured by sweeping the stance in 50 mm steps, the
 * crosshair named the bottle from z 37.85 to 38.30, a 450 mm contiguous band,
 * with the leaf fully open — and that band was **identical at both leaf widths**,
 * which is the control proving the leaf never bounded it.
 */
export const COOLER = { x0: -8.5, x1: -1.5, depth: 1.16, height: 2.12, doors: 10, kick: 0.09 };

/**
 * Where the handheld bottle sits before it is picked up. Fixed and published,
 * not rng-placed: a video is aimed at this object and this system needs a shot
 * pose on it, and two agents cannot both point at a random spot. Height is above
 * finished floor — cooler shelf 2 plus the 26 mm the stock stands off.
 */
export const GRAB_BOTTLE = { x: -6.6, z: 38.72, aboveFloor: 0.646 };

/** Where `?bgheld=1` stands it for inspection: open floor, hand height. */
export const HELD_BOTTLE = { x: -4.2, z: 35.4, aboveFloor: 1.16 };

/** Checkout counter, to the right as you come in. */
export const COUNTER = { x0: 0.5, x1: 3.15, z0: 34.55, z1: 35.45, height: 0.98 };

/** Gondola spine positions. 2.35 m apart gives a real 1.19 m shopping aisle. */
export const GONDOLA_Z = [34.6, 36.95];

/**
 * The runs stop 0.65 m short of the west wall of where they used to, and the
 * reason is a route rather than a look.
 *
 * At `x0: -8.2` both runs left 0.70 m to the west wall. That is wider than a
 * 0.64 m body, so every reachability test passed it, and it is 30 mm of margin —
 * which is not a corridor, it is a scrape. Measured with a clearance-constrained
 * shortest path, the only interior route to the cooler threaded that gap and the
 * doorway corner at 13 mm, and the walked controller stuck at the jamb rather
 * than follow it. The shop was passable and not crossable, and those are
 * different properties.
 *
 * `x0: -7.55` opens the west corridor to 1.35 m. It costs 0.65 m of the 7.2 m
 * run; the ask was to protect the *density* of shelving read through the glass,
 * not its length, and the stocking is unchanged.
 */
export const GONDOLA_X = { x0: -7.55, x1: -1.0, halfDepth: 0.6 };

/**
 * The impulse island in front of the counter. One constant because the geometry
 * and the collision blocker were two hand-copied literals, and the first time
 * one of them moved the other would not have followed: the island is the single
 * obstruction that decided whether the store interior was walkable at all.
 *
 * It starts east of the gondola line so that x −1.0…0.15 is a clear 1.15 m
 * corridor from the door to the back of the store. Before that it began at −0.4,
 * which left only a route round its east end through 0.80 m and 0.82 m gaps —
 * 0.40 m of clearance against `PlayerSystem`'s 0.32 m body radius, so both the
 * cooler and the grab bottle were unreachable on foot.
 */
export const ISLAND = { x0: 0.15, x1: 1.95, cz: 33.1, halfDepth: 0.6, height: 1.05 };

/** An axis-aligned rectangle in plan, which is all collision here needs. */
export interface Blocker {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Top of the slab, taken as the high point around the perimeter plus 140 mm.
 *
 * Sampled rather than solved because the pad is a continuous surface owned by
 * another system: a building sits on its own high corner, not on the average of
 * the ground under it.
 */
export function buildingFloorHeight(): number {
  let high = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    high = Math.max(
      high,
      padY(PLAN.x0 + (PLAN.x1 - PLAN.x0) * t, PLAN.z0),
      padY(PLAN.x0 + (PLAN.x1 - PLAN.x0) * t, PLAN.z1),
      padY(PLAN.x0, PLAN.z0 + (PLAN.z1 - PLAN.z0) * t),
      padY(PLAN.x1, PLAN.z0 + (PLAN.z1 - PLAN.z0) * t)
    );
  }
  return high + 0.14;
}

/**
 * Every solid thing in and around the store, in plan.
 *
 * The single most consumed thing this system publishes, and the reason this
 * module exists: a sibling that cannot get this list has to assume the building
 * is hollow, and an empty blocker list does not fail loudly — it quietly plants
 * shrubs through the shelving.
 */
export function buildingBlockers(): Blocker[] {
  const w = PLAN.wall;
  const out: Blocker[] = [
    { minX: PLAN.x0, maxX: PLAN.x0 + w, minZ: PLAN.z0, maxZ: PLAN.z1 },
    { minX: PLAN.x1 - w, maxX: PLAN.x1, minZ: PLAN.z0, maxZ: PLAN.z1 },
    { minX: PLAN.x0, maxX: PLAN.x1, minZ: PLAN.z1 - w, maxZ: PLAN.z1 },
    // Front wall, broken by the door opening.
    { minX: PLAN.x0, maxX: PLAN.doorX0, minZ: PLAN.z0, maxZ: PLAN.z0 + w },
    { minX: PLAN.doorX1, maxX: PLAN.x1, minZ: PLAN.z0, maxZ: PLAN.z0 + w },
    { minX: COOLER.x0, maxX: COOLER.x1, minZ: IN.z1 - COOLER.depth, maxZ: IN.z1 },
    { minX: COUNTER.x0 - 0.03, maxX: COUNTER.x1 + 0.03, minZ: COUNTER.z0 - 0.03, maxZ: COUNTER.z1 + 0.7 },
    { minX: ISLAND.x0, maxX: ISLAND.x1, minZ: ISLAND.cz - ISLAND.halfDepth, maxZ: ISLAND.cz + ISLAND.halfDepth },
    // Ice machine and propane cage, outside the front wall.
    { minX: 1.75, maxX: 2.95, minZ: PLAN.z0 - 0.86, maxZ: PLAN.z0 },
    { minX: -9.78, maxX: -8.62, minZ: PLAN.z0 - 0.94, maxZ: PLAN.z0 + 0.02 },
  ];
  for (const cz of GONDOLA_Z) {
    out.push({
      minX: GONDOLA_X.x0,
      maxX: GONDOLA_X.x1,
      minZ: cz - GONDOLA_X.halfDepth,
      maxZ: cz + GONDOLA_X.halfDepth,
    });
  }
  return out;
}

/** The footprint as published on the service registry, without the registry. */
export function buildingFootprint(floorY = buildingFloorHeight()) {
  return {
    minX: PLAN.x0,
    maxX: PLAN.x1,
    minZ: PLAN.z0,
    maxZ: PLAN.z1,
    floorY,
    roofY: floorY + PLAN.roofDeck,
    parapetY: floorY + PLAN.parapet + 0.052,
    wallThickness: PLAN.wall,
  };
}
