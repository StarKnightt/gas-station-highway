import * as THREE from "three";

/**
 * The scene-wide solid-geometry contract.
 *
 * ## For a system that owns something you cannot walk through
 *
 * Publish an array of axis-aligned XZ rectangles under a key ending in
 * `.blockers`, and you are done:
 *
 * ```ts
 * game.provide("pumps.blockers", [{ minX, maxX, minZ, maxZ }, ...]);
 * ```
 *
 * `PlayerSystem` picks up **every** service whose key ends in `.blockers` on
 * its first frame. There is no list to add yourself to and no consumer to edit,
 * which is the whole point: the previous arrangement had exactly one hard-coded
 * producer and everything else in the scene was walk-through.
 *
 * Rules, all of them load-bearing:
 *
 * - Rectangles are in **world XZ metres** and describe the *solid* footprint.
 *   Do not pre-inflate by a body radius; the consumer adds its own.
 * - Publish the array **once** and mutate it in place if it changes, or
 *   re-`provide` the same key. The consumer re-reads the array contents every
 *   frame but caches the group's bounding rectangle.
 * - A blocker that moves may carry `refresh`, called before it is tested. It
 *   must **never grow beyond the extent it had when it was published** — the
 *   cached rectangle is the broad phase, and a blocker that outgrows it stops
 *   being tested at all, silently. `CollisionField` checks this and throws.
 * - Keep each group's rectangles clustered. The broad phase is per group, so
 *   one group spanning the whole site defeats it for everything in that group.
 *
 * ## Portals
 *
 * A producer that owns a **tight opening** may also publish `<name>.portals`:
 * rectangles inside which the player is allowed a smaller body radius, because
 * a person squares up and turns slightly to get through a door and does not
 * walk at it as a 0.64 m cylinder.
 *
 * This started life as a rule instead of a place — "shrink whenever the full
 * radius is blocked and the narrow one is clear" — which is wrong in a way
 * worth recording, because it *looks* like it only fires in gaps. It fires
 * everywhere: being 0.25 m from a flat wall is also "clear at the narrow
 * radius", so the player simply crept 120 mm closer to every surface in the
 * scene and the invariant "held exactly one body radius off the wall" quietly
 * stopped holding. A relief that is meant to apply in specific places has to be
 * addressed to those places.
 *
 * ## Why the algorithm lives here rather than in `BuildingSystem`
 *
 * `building.collide` predates this and stays where it is — `VegetationSystem`
 * and others read `building.blockers` directly and should not have to care. But
 * resolution has to happen once against the *union* of every producer, or a
 * player pushed out of a pump lands inside a bollard, so the push-out lives
 * here and `building.blockers` is simply one group among several.
 *
 * ## And a warning that cost a debugging round
 *
 * `resolve()` **mutates the vector it is given**, exactly as `building.collide`
 * does. It is a command, not a predicate. A probe that wants to ask "is this
 * point solid" must pass a clone, or it performs the very resolution it is
 * testing for. See NOTES.md case 36.
 */

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Blocker extends Rect {
  /**
   * Recompute this rectangle from live state before it is tested. Must stay
   * inside the extent the blocker had when the group was collected.
   */
  refresh?: (self: Blocker) => void;
}

export interface BlockerGroup {
  /** Registry key, or a `derived:` label for a bridge adapter. */
  readonly key: string;
  readonly blockers: Blocker[];
  /** Union of every blocker, cached. The broad phase for this group. */
  readonly rect: Rect;
  readonly dynamic: boolean;
}

/** The registry surface this module needs. `Game` satisfies it. */
export interface BlockerRegistry {
  tryGet<T>(key: string): T | undefined;
  serviceKeys(): string[];
}

const SUFFIX = ".blockers";
const PORTAL_SUFFIX = ".portals";

function unionOf(blockers: readonly Rect[]): Rect {
  const r: Rect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of blockers) {
    if (b.minX < r.minX) r.minX = b.minX;
    if (b.maxX > r.maxX) r.maxX = b.maxX;
    if (b.minZ < r.minZ) r.minZ = b.minZ;
    if (b.maxZ > r.maxZ) r.maxZ = b.maxZ;
  }
  return r;
}

function isRectArray(v: unknown): v is Blocker[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (b) =>
        b &&
        typeof b === "object" &&
        Number.isFinite((b as Rect).minX) &&
        Number.isFinite((b as Rect).maxX) &&
        Number.isFinite((b as Rect).minZ) &&
        Number.isFinite((b as Rect).maxZ)
    )
  );
}

/**
 * Every solid thing in the scene, grouped by producer so the broad phase can
 * reject a whole group with four comparisons.
 */
export class CollisionField {
  readonly groups: BlockerGroup[];
  /** Union of every group. One test rejects the whole field. */
  readonly bounds: Rect;
  /** Where the body is allowed to be narrower. See "Portals" above. */
  readonly portals: Rect[];
  private readonly portalBounds: Rect;

  constructor(groups: BlockerGroup[], portals: Rect[] = []) {
    this.groups = groups;
    this.bounds = unionOf(groups.map((g) => g.rect));
    this.portals = portals;
    this.portalBounds = portals.length
      ? unionOf(portals)
      : { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  }

  /**
   * The body radius to use at this point: `narrow` inside a portal, `wide`
   * everywhere else. Two comparisons in the common case.
   */
  radiusAt(x: number, z: number, wide: number, narrow: number): number {
    if (x < this.portalBounds.minX || x > this.portalBounds.maxX) return wide;
    if (z < this.portalBounds.minZ || z > this.portalBounds.maxZ) return wide;
    for (const p of this.portals) {
      if (x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ) return narrow;
    }
    return wide;
  }

  get blockerCount(): number {
    return this.groups.reduce((n, g) => n + g.blockers.length, 0);
  }

  /**
   * Push `p` out of anything solid, in place, along whichever axis needs the
   * least movement so that walking into a wall slides along it. Returns whether
   * anything had to move.
   */
  resolve(p: THREE.Vector3, radius: number): boolean {
    const x = p.x;
    const z = p.z;
    if (
      x <= this.bounds.minX - radius ||
      x >= this.bounds.maxX + radius ||
      z <= this.bounds.minZ - radius ||
      z >= this.bounds.maxZ + radius
    ) {
      return false;
    }

    let hit = false;
    for (const g of this.groups) {
      const gr = g.rect;
      if (p.x <= gr.minX - radius || p.x >= gr.maxX + radius || p.z <= gr.minZ - radius || p.z >= gr.maxZ + radius) {
        continue;
      }
      for (const b of g.blockers) {
        if (b.refresh) {
          b.refresh(b);
          if (b.minX < gr.minX || b.maxX > gr.maxX || b.minZ < gr.minZ || b.maxZ > gr.maxZ) {
            throw new Error(
              `collision: "${g.key}" grew a blocker past the extent it registered ` +
                `(${b.minX.toFixed(2)}..${b.maxX.toFixed(2)} x, ${b.minZ.toFixed(2)}..${b.maxZ.toFixed(2)} z ` +
                `outside ${gr.minX.toFixed(2)}..${gr.maxX.toFixed(2)} x, ${gr.minZ.toFixed(2)}..${gr.maxZ.toFixed(2)} z). ` +
                `A blocker outside its group rect is silently never tested.`
            );
          }
        }
        const minX = b.minX - radius;
        const maxX = b.maxX + radius;
        const minZ = b.minZ - radius;
        const maxZ = b.maxZ + radius;
        if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
        const dxL = p.x - minX;
        const dxR = maxX - p.x;
        const dzL = p.z - minZ;
        const dzR = maxZ - p.z;
        const least = Math.min(dxL, dxR, dzL, dzR);
        if (least === dxL) p.x = minX;
        else if (least === dxR) p.x = maxX;
        else if (least === dzL) p.z = minZ;
        else p.z = maxZ;
        hit = true;
      }
    }
    return hit;
  }

  describe(): string {
    return this.groups
      .map(
        (g) =>
          `${g.key}: ${g.blockers.length}${g.dynamic ? " (dynamic)" : ""} ` +
          `x[${g.rect.minX.toFixed(2)},${g.rect.maxX.toFixed(2)}] z[${g.rect.minZ.toFixed(2)},${g.rect.maxZ.toFixed(2)}]`
      )
      .join("; ");
  }
}

/* ------------------------------------------------------------------ */
/* bridge adapters                                                     */
/* ------------------------------------------------------------------ */

/**
 * Derived blockers for systems that have not adopted the contract yet.
 *
 * These exist so the whole scene could be made solid in one round without
 * editing five actively-worked files, and every one of them is meant to be
 * deleted the day its owner publishes `<system>.blockers`. Each adapter is
 * skipped if the owner's key already exists, so adoption is a one-line change
 * with nothing to remove here first — and each one **throws if it derives
 * nothing**, because an adapter that silently finds no geometry is a scene full
 * of walk-through props that still reports success.
 *
 * See RESUME-PLAN.md for what is still missing and who owns it.
 */
interface Derived {
  group?: BlockerGroup;
  portal?: Rect;
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

function boxRect(o: THREE.Object3D, shrink = 0): Rect | null {
  _box.setFromObject(o);
  if (_box.isEmpty()) return null;
  return {
    minX: _box.min.x + shrink,
    maxX: _box.max.x - shrink,
    minZ: _box.min.z + shrink,
    maxZ: _box.max.z - shrink,
  };
}

interface PumpLike {
  root: THREE.Object3D;
}
interface CarLike {
  root: THREE.Object3D;
}

/** Fuel dispensers, from the `pumps` handles' own roots. */
function derivePumps(reg: BlockerRegistry): Derived | null {
  const pumps = reg.tryGet<PumpLike[]>("pumps");
  if (!pumps?.length) return null;
  const blockers: Blocker[] = [];
  for (const h of pumps) {
    // The root box takes in the hose loops and nozzle boots as well as the
    // cabinet, which is right: they are at shin height and you would walk into
    // them. Shrunk 40 mm so the footprint is the cabinet rather than its
    // shadow-casting outline.
    const r = boxRect(h.root, 0.04);
    if (r) blockers.push(r);
  }
  if (!blockers.length) {
    throw new Error('collision: "pumps" is published but no dispenser produced a bounding box');
  }
  return { group: { key: "derived:pumps", blockers, rect: unionOf(blockers), dynamic: false } };
}

/**
 * The island bollards, by name. PumpSystem builds them as siblings of the
 * dispensers rather than children, so they are not reachable through any
 * published handle — this is the one adapter that has to read the scene graph.
 */
function deriveBollards(scene: THREE.Object3D): Derived | null {
  const blockers: Blocker[] = [];
  scene.traverse((o) => {
    if (!/^bollard-/.test(o.name)) return;
    const r = boxRect(o);
    if (r) blockers.push(r);
  });
  if (!blockers.length) {
    throw new Error(
      'collision: found no object named "bollard-*" in the scene. Either PumpSystem ' +
        "renamed them or it failed to build — either way the islands are unprotected " +
        "and this adapter would otherwise report success having done nothing."
    );
  }
  return { group: { key: "derived:bollards", blockers, rect: unionOf(blockers), dynamic: false } };
}

/** The parked car, from its own handle. */
function deriveCar(reg: BlockerRegistry): Derived | null {
  const car = reg.tryGet<CarLike>("car.parked");
  if (!car?.root) return null;
  // World AABB of a car yawed 3.19 rad is 2.11 m across a 1.84 m body, so this
  // is 0.13 m generous on each flank. Not worth an oriented box for a parked
  // car you are only ever going to walk around.
  const r = boxRect(car.root, 0.05);
  if (!r) throw new Error('collision: "car.parked" is published but its root has no bounding box');
  return { group: { key: "derived:car", blockers: [r], rect: r, dynamic: false } };
}

/**
 * The entry door leaf, which is solid when shut and not when open.
 *
 * Driven off the hinge angle rather than a boolean, because a door that snaps
 * solid the instant it starts closing feels like a trap. The leaf's projection
 * onto the wall plane is `leafW * cos(theta)`, so the blocked span shrinks
 * continuously from the full opening to nothing as it swings.
 *
 * `building.entryDoor` is the pivot itself, so this needs nothing from
 * `InteractionSystem` — the angle it writes is on the object BuildingSystem
 * already publishes. What this deliberately does *not* model is the open leaf
 * sticking out into the walkway; it is a swept rectangle, the contract is
 * axis-aligned, and you can walk around a held-open door in real life too.
 */
function deriveDoor(reg: BlockerRegistry): Derived | null {
  const pivot = reg.tryGet<THREE.Object3D>("building.entryDoor");
  if (!pivot) return null;

  const ud = (pivot.userData ?? {}) as { closedAngle?: number };
  const closedAngle = typeof ud.closedAngle === "number" ? ud.closedAngle : 0;

  const live = pivot.rotation.y;
  pivot.rotation.y = closedAngle;
  pivot.updateMatrixWorld(true);
  const closed = boxRect(pivot);
  pivot.getWorldPosition(_v);
  const hingeX = _v.x;
  pivot.rotation.y = live;
  pivot.updateMatrixWorld(true);

  if (!closed) throw new Error('collision: "building.entryDoor" has no bounding box, so the doorway cannot be closed');

  const right = closed.maxX - hingeX;
  const left = hingeX - closed.minX;
  const sign = right >= left ? 1 : -1;
  const leafW = Math.max(right, left);
  if (leafW < 0.3) {
    throw new Error(`collision: entry door leaf measured ${leafW.toFixed(3)} m from its hinge — too narrow to be a door`);
  }

  // A door leaf is ~40 mm thick. At 1.4 m/s a frame advances 23 mm, and the
  // body radius adds 0.6 m of effective depth on top, so there is no tunnelling
  // risk; the floor here is only to survive a degenerate zero-depth box.
  const zMid = (closed.minZ + closed.maxZ) / 2;
  const zHalf = Math.max(0.03, (closed.maxZ - closed.minZ) / 2);

  const blocker: Blocker = {
    minX: sign > 0 ? hingeX : hingeX - leafW,
    maxX: sign > 0 ? hingeX + leafW : hingeX,
    minZ: zMid - zHalf,
    maxZ: zMid + zHalf,
    refresh: (self) => {
      const w = leafW * Math.max(0, Math.cos(pivot.rotation.y - closedAngle));
      if (sign > 0) {
        self.minX = hingeX;
        self.maxX = hingeX + w;
      } else {
        self.minX = hingeX - w;
        self.maxX = hingeX;
      }
    },
  };
  // The registered rect is the closed extent, which is the widest it ever gets.
  const group: BlockerGroup = { key: "derived:entryDoor", blockers: [blocker], rect: { ...blocker }, dynamic: true };

  // The threshold, as a portal. Deep enough in z to have taken effect before
  // the jamb stops anyone — the wall is 0.2 m thick and the body is 0.32 m, so
  // 0.75 m either side of the leaf covers the whole approach. Widened 0.1 m in
  // x past the leaf so the jamb reveals themselves are inside it too.
  const portal: Rect = {
    minX: Math.min(hingeX, hingeX + sign * leafW) - 0.1,
    maxX: Math.max(hingeX, hingeX + sign * leafW) + 0.1,
    minZ: zMid - zHalf - 0.75,
    maxZ: zMid + zHalf + 0.75,
  };
  return { group, portal };
}

/**
 * Collect every published `*.blockers` group and `*.portals` rect, then fill
 * the gaps with the bridge adapters above for owners who have not adopted the
 * contract.
 */
export function collectSolids(
  reg: BlockerRegistry,
  scene: THREE.Object3D
): { groups: BlockerGroup[]; portals: Rect[] } {
  const groups: BlockerGroup[] = [];
  const portals: Rect[] = [];
  const claimed = new Set<string>();

  for (const key of reg.serviceKeys()) {
    const portal = key.endsWith(PORTAL_SUFFIX);
    if (!portal && !key.endsWith(SUFFIX)) continue;
    const value = reg.tryGet<unknown>(key);
    if (!isRectArray(value)) {
      throw new Error(
        `collision: "${key}" ends in "${portal ? PORTAL_SUFFIX : SUFFIX}" but is not a non-empty ` +
          `array of {minX,maxX,minZ,maxZ}. Publish the contract shape or pick another key — ` +
          `an unrecognised value here would otherwise be a whole system silently not solid.`
      );
    }
    if (portal) {
      portals.push(...value);
      continue;
    }
    groups.push({ key, blockers: value, rect: unionOf(value), dynamic: false });
    claimed.add(key.slice(0, -SUFFIX.length));
  }

  const bridges: Array<[string, () => Derived | null]> = [
    ["pumps", () => derivePumps(reg)],
    ["bollards", () => deriveBollards(scene)],
    ["car", () => deriveCar(reg)],
    ["entryDoor", () => deriveDoor(reg)],
  ];
  for (const [owner, make] of bridges) {
    if (claimed.has(owner)) continue;
    const d = make();
    if (!d) continue;
    if (d.group) groups.push(d.group);
    if (d.portal) portals.push(d.portal);
  }

  return { groups, portals };
}
