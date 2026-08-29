/**
 * Dry scrub, weeds and grass clumps for System 6.
 *
 * A clump is a handful of alpha-cut cards arranged around a common root. They
 * are built as unit-sized merged geometries (about 1 m across, 1 m tall) so a
 * single `InstancedMesh` per variant can scatter them at any size, and the base
 * of every card is darkened in the vertex colours so a tuft reads as growing
 * out of the ground rather than resting on it.
 *
 * Three variants exist rather than one because a single repeated clump is
 * instantly recognisable once there are more than about thirty of them on
 * screen, and per-instance colour alone does not hide a repeated silhouette.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, lerp, seededRng } from "./noise";

export type ClumpKind = "grass" | "weed" | "tuft" | "sprawl" | "seed" | "dead" | "grazed";

/** Which card texture a form is drawn with. */
export const CLUMP_CARD: Record<ClumpKind, "grass" | "weed" | "tuft"> = {
  grass: "grass",
  weed: "weed",
  tuft: "tuft",
  sprawl: "grass",
  seed: "weed",
  dead: "tuft",
  grazed: "grass",
};

interface ClumpShape {
  cards: [number, number];
  /** Card width and height as a fraction of the unit clump. */
  size: [number, number];
  /** How far cards are pushed off the common root. */
  spread: number;
  /** Maximum tilt off vertical, radians. */
  tilt: number;
  /**
   * Tilt bias. 0 tilts cards evenly in all directions from vertical, which
   * makes a symmetric bunch; 1 tilts every card the same way, which is what a
   * plant that has been lodged flat by wind or run over actually looks like.
   */
  lodge?: number;
  /** How much the whole form is squashed vertically before instancing. */
  squash?: number;
  /** A few cards standing clear of the mass — a seed head on a bolted stem. */
  emergent?: { count: [number, number]; rise: number; size: number };
  /**
   * Multiplies the vertex tone. A form that has been dead and weathering since
   * midsummer is *brighter* than a live one, not darker — bleached straw sits
   * around 0.4 reflectance. Getting this backwards is what made the flattened
   * forms render as black plates in the first capture: they were authored dark
   * and then, lying nearly horizontal under a 6 degree sun, received about a
   * tenth of the irradiance a vertical blade does.
   */
  bleach?: number;
}

/**
 * Seven forms, because three was not enough and scale variation is not variety.
 *
 * The critic's note was specific: "the same tuft mesh is recognisable four times
 * in the right half of edge.png. Varying uniform scale is not variety." It was
 * right, and worse than it knew — there were only *three* clump geometries in the
 * scene, one per kind, instanced sixteen hundred times. A silhouette repeated
 * that often is recognisable no matter what you do to its size or its tint,
 * because the eye matches shape long before it matches either.
 *
 * So: more forms, and forms that differ in *structure* rather than in dimension.
 * `sprawl` radiates almost flat, `dead` has every card lodged the same way,
 * `seed` throws a couple of bare stems clear of its own mass, `grazed` is cropped
 * short and dense. On top of that the system builds four random variants of each
 * form and scatters instances across them, so there are twenty-eight distinct
 * meshes rather than three.
 */
const SHAPES: Record<ClumpKind, ClumpShape> = {
  // A spreading bunch of dry grass at the foot of something.
  grass: { cards: [7, 11], size: [0.86, 0.8], spread: 0.24, tilt: 0.4 },
  // Tall thin ruderal weed — the sort that comes up through a crack.
  weed: { cards: [4, 7], size: [0.58, 1.05], spread: 0.13, tilt: 0.26 },
  // Low flat tuft; the filler that keeps a verge from being bare dirt.
  tuft: { cards: [5, 9], size: [0.95, 0.5], spread: 0.28, tilt: 0.54 },
  // Sprawling: radiating outward almost horizontally from one crown, the way a
  // prostrate annual covers ground. Wide, and much lower than it is broad.
  sprawl: { cards: [6, 9], size: [0.98, 0.5], spread: 0.34, tilt: 0.6, squash: 0.9, bleach: 1.18 },
  // Gone to seed: a modest basal clump with two or three bare stems bolted well
  // clear of it. The stems are what make it read as a specific plant at a
  // specific time of year rather than as generic vegetation.
  seed: {
    cards: [4, 6],
    size: [0.5, 0.86],
    spread: 0.14,
    tilt: 0.3,
    emergent: { count: [2, 4], rise: 0.85, size: 0.3 },
  },
  // Flattened dead: lodged by wind or by a wheel, every blade going the same
  // way, bleached out. `lodge: 1` is the whole point of the form.
  dead: { cards: [5, 8], size: [0.92, 0.56], spread: 0.28, tilt: 0.6, lodge: 1, squash: 0.8, bleach: 1.5 },
  // Grazed or mown off: dense, stubby, blunt. Common at a fence line where
  // something has been reaching over it.
  grazed: { cards: [9, 14], size: [0.72, 0.34], spread: 0.2, tilt: 0.42, squash: 0.92, bleach: 1.15 },
};

export const CLUMP_KINDS = Object.keys(SHAPES) as ClumpKind[];

/**
 * Which of the seven forms a plant at a given spot actually takes.
 *
 * The scatter asks for a broad type — grass, weed or low filler — because that is
 * what the *place* determines: a crack in the asphalt grows a ruderal, the lee of
 * a post grows a bunch. What the plant then looks like depends on how it has got
 * on, and the scatter already knows that as `vigour`. So the mapping lives here
 * rather than at ten call sites, and it means adding a form does not require
 * touching the placement code at all.
 *
 * Low vigour resolves to the beaten-up forms — flattened, grazed off — which is
 * both true and useful, because those are the spots where the eye most expects
 * damage: right at the pavement edge, and under the pines where the duff is.
 */
export function clumpForm(base: "grass" | "weed" | "tuft", vigour: number, r: number): ClumpKind {
  if (vigour < 0.3) {
    if (r < 0.42) return "dead";
    if (r < 0.72) return "grazed";
    return base === "weed" ? "weed" : "tuft";
  }
  if (base === "weed") {
    // A vigorous ruderal in late summer has usually bolted and set seed.
    return r < 0.42 * clamp01(vigour * 1.4) ? "seed" : "weed";
  }
  if (base === "grass") {
    if (r < 0.16) return "sprawl";
    if (r < 0.28) return "grazed";
    return "grass";
  }
  if (r < 0.2) return "sprawl";
  if (r < 0.32) return "dead";
  return "tuft";
}

/**
 * One clump, merged. Cards span x in -0.5..0.5 and y in 0..1 before the shape's
 * size is applied, and the geometry is left with its root at the origin so an
 * instance can be dropped straight onto the ground height.
 */
export function buildClump(
  kind: ClumpKind,
  seed: number,
  /**
   * Card-count multiplier, for a cheap distant variant.
   *
   * A clump past about 70 m subtends a few pixels of silhouette, so the cards
   * that give a near clump its blade separation are all landing inside the same
   * pixel out there — they cost triangles and buy nothing. The alpha texture
   * still does the fine detail, so halving the cards costs no readable
   * structure at that distance.
   *
   * Kept as a multiplier on the authored range rather than a separate card count
   * so the two LODs cannot drift apart when the shapes are retuned.
   */
  lod = 1
): THREE.BufferGeometry {
  const s = SHAPES[kind];
  const rng = seededRng(seed);
  const n = Math.max(2, Math.round((s.cards[0] + Math.floor(rng() * (s.cards[1] - s.cards[0] + 1))) * lod));
  const geos: THREE.BufferGeometry[] = [];
  // The direction a lodged form has been flattened in. One per clump, so a
  // flattened tuft is internally consistent even though the scatter gives each
  // instance its own yaw.
  const lodgeDir = rng() * Math.PI * 2;

  for (let i = 0; i < n; i++) {
    const w = s.size[0] * lerp(0.62, 1.18, rng());
    const h = s.size[1] * lerp(0.5, 1.15, rng());
    const g = new THREE.PlaneGeometry(w, h, 1, 2);
    g.translate(0, h / 2, 0);

    // Bow the top of the card over: a flat rectangle of grass reads as a decal
    // stuck in the ground, and two height segments is enough to break that.
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const bowDir = (rng() - 0.5) * 2;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      const t = y / h;
      pos.setX(v, pos.getX(v) + bowDir * 0.18 * h * t * t);
      pos.setY(v, y - Math.abs(bowDir) * 0.07 * h * t * t);
    }
    pos.needsUpdate = true;

    // A gentle base-to-tip tone ramp, and deliberately gentle now.
    //
    // This used to run 0.8 at the root to 1.04 at the tip as "contact
    // darkening", from before there was a ground contact decal. With the decal
    // in place the darkening was being counted four times over — dark base
    // albedo, this ramp, the clump self-shadowing in the cascade, and the decal
    // itself — and magnified, every tuft on the site stood on a black plinth.
    // The decal is the right place for contact, because it darkens the *ground*
    // rather than the plant.
    const col = new Float32Array(pos.count * 3);
    const tone = lerp(0.78, 1.16, rng()) * (s.bleach ?? 1);
    for (let v = 0; v < pos.count; v++) {
      // `clamp01`, not `Math.min(1, ...)`, and the missing lower bound was a
      // real defect rather than a tidiness point.
      //
      // `PlaneGeometry(w, h, 1, 2).translate(0, h / 2, 0)` does not put the
      // bottom row at exactly zero: -h/2 + h/2 cancels to about -1e-8 in
      // float32 for most h. So `t` was very slightly *negative* on the base row
      // of nearly every card, and `Math.pow(negative, 0.55)` is NaN. That NaN
      // went into the vertex colour buffer of 55 of the 56 clump geometries
      // this file can build, which made every clump's base row shade to NaN.
      //
      // On screen it was invisible: a NaN fragment is discarded, so a couple of
      // vertices at ground level behind a contact decal cost nothing anybody
      // could see. It was fatal one level up. When Lighting captures the world
      // into a PMREM cube those fragments land in the cube, one non-finite
      // texel spreads across a whole neighbourhood of every mip through the
      // GGX filter, and then every MeshStandardMaterial sampling the
      // environment renders black — direct sun included. See NOTES.md case 31;
      // that outage was tracked through four other systems before it got here.
      const t = clamp01(pos.getY(v) / h);
      const k = tone * lerp(0.94, 1.06, Math.pow(t, 0.55));
      col[v * 3] = k;
      col[v * 3 + 1] = k;
      col[v * 3 + 2] = k * lerp(1.0, 0.94, t);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));

    // A lodged form leans every card the same way about one axis; an upright one
    // spreads the lean evenly around the yaw, which averages to a symmetric
    // bunch. This one number is the difference between "tuft" and "flattened".
    const lodge = s.lodge ?? 0;
    const yaw = lodge > 0 ? lodgeDir + (rng() - 0.5) * 0.7 * (1 - lodge) : rng() * Math.PI * 2;
    const tilt = lodge > 0 ? s.tilt * lerp(0.55, 1, rng()) : (rng() - 0.5) * 2 * s.tilt;
    const q = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
    const off = new THREE.Vector3((rng() - 0.5) * s.spread, 0, (rng() - 0.5) * s.spread);
    g.applyMatrix4(new THREE.Matrix4().compose(off, q, new THREE.Vector3(1, 1, 1)));
    geos.push(g);
  }

  // Bolted stems standing clear of the basal mass.
  if (s.emergent) {
    const e = s.emergent;
    const n2 = e.count[0] + Math.floor(rng() * (e.count[1] - e.count[0] + 1));
    for (let i = 0; i < n2; i++) {
      const h = e.size * lerp(0.8, 1.3, rng());
      const g = new THREE.PlaneGeometry(e.size * lerp(0.5, 0.9, rng()), h, 1, 2);
      g.translate(0, h / 2, 0);
      const col = new Float32Array((g.getAttribute("position") as THREE.BufferAttribute).count * 3);
      // Bleached: a seed head has been dead since midsummer even where the
      // basal leaves are still half green.
      col.fill(lerp(1.02, 1.3, rng()));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const q = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rng() - 0.5) * 0.5));
      g.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3((rng() - 0.5) * 0.18, e.rise * lerp(0.7, 1.15, rng()), (rng() - 0.5) * 0.18),
          q,
          new THREE.Vector3(1, 1, 1)
        )
      );
      geos.push(g);
    }
  }

  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error(`buildClump(${kind}, ${seed}): merge failed`);
  geos.forEach((g) => g.dispose());
  if (s.squash && s.squash !== 1) merged.scale(1, s.squash, 1);
  return merged;
}
