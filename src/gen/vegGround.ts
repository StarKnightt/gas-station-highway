/**
 * Ground contact: the darkening and litter where a plant or a post meets the
 * dirt.
 *
 * A critic's note, and it applied to every object in the system: "no ground
 * contact anywhere — hard geometric intersection at every trunk and tuft, no
 * contact darkening, no root flare, no needle duff ring under the pines, no
 * litter skirt." This is the cheapest large improvement available, because it is
 * the thing the eye uses to decide whether an object is *in* a scene or *on* it,
 * and a decal costs a handful of triangles.
 *
 * Three effects, all from the same primitive:
 *
 *  - **Duff mat.** A pine drops a continuous mat of dead needles out to roughly
 *    its drip line. It is much darker than the dirt around it, slightly redder,
 *    and it has a soft irregular edge. It is also the reason nothing grows
 *    directly under a pine, so it has to be there for the ring of scrub at the
 *    drip line to make sense.
 *  - **Contact darkening.** A small, tight, dark patch right at the base of a
 *    post or a trunk: soil that stays damp in the shelter of the object, plus
 *    the ambient occlusion of the join itself, which a 2 cm shadow texel cannot
 *    resolve. Without it every upright looks pushed into the ground like a pin.
 *  - **Litter skirt.** Fallen twigs, bark and cones scattered through the duff,
 *    as a slightly lighter mottling — otherwise the mat reads as a painted
 *    circle.
 *
 * Drawn as transparent decals with `depthWrite` off and a polygon offset, rather
 * than by displacing the terrain, because the terrain belongs to another system.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, lerp, seededRng } from "./noise";

export type Ground = (x: number, z: number) => number;

export interface MatSpec {
  x: number;
  z: number;
  /** Outer radius of the mat, metres. */
  radius: number;
  /** Opacity at the centre, 0..1. */
  strength: number;
  /** 0 = neutral soil darkening, 1 = full needle-duff colour. */
  duff: number;
  seed: number;
}

/**
 * A disc with a noisy rim and a radial opacity falloff. Vertex colour carries
 * RGB and alpha, so the whole set is one draw call whatever the mixture of
 * radii and strengths.
 */
function discGeometry(spec: MatSpec, ground: Ground): THREE.BufferGeometry {
  const rng = seededRng(spec.seed);
  // Segment count from radius: a 0.3 m contact patch does not need the same
  // tessellation as a 3 m duff mat, and there are hundreds of the former.
  const N = Math.max(9, Math.min(40, Math.round(spec.radius * 13)));
  // Rings rather than a fan: the falloff needs at least one intermediate ring
  // or the centre opacity is smeared linearly all the way to the rim.
  const RINGS = 3;

  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  // Irregular rim: a real duff mat follows the crown above it, which is
  // lopsided, and it gets scuffed away on whichever side gets walked on.
  const rim: number[] = [];
  const lobeA = rng() * Math.PI * 2;
  const lobeB = rng() * Math.PI * 2;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    rim.push(
      0.62 + 0.26 * Math.sin(a * 2 + lobeA) + 0.16 * Math.sin(a * 3 - lobeB) + 0.1 * Math.sin(a * 7 + lobeA * 2)
    );
  }

  // Needle duff: much darker than dry dirt and distinctly red-brown.
  //
  // Linear, and NOT `setRGB(..., SRGBColorSpace)`. These are the same bug as the
  // horizon bands (NOTES.md case 24): authored as display tones and then
  // transfer-encoded on the way in, landing 12.8x and 12.2x too dark — at
  // **0/255 and 1/255** through the project's ACES fit at 1.25 exposure. The
  // material is `MeshBasicMaterial` with vertex colours, so the value written is
  // the pixel and there was no shading to hide behind.
  //
  // These mats are at alpha 0.5-0.85, so they were never faint: every pine has
  // been sitting in a black hole rather than on a litter mat. Three critics in a
  // row reported "no needle litter, no contact darkening" under the pines. It
  // was not missing. It was black, which looks identical to a hole and nothing
  // like an absent feature, which is why nobody suspected the colour.
  const DUFF = new THREE.Color(0.052, 0.036, 0.024);
  const DAMP = new THREE.Color(0.070, 0.058, 0.044);
  const c = new THREE.Color();

  const y0 = ground(spec.x, spec.z);
  const vert = (a: number, rFrac: number, i: number) => {
    const r = spec.radius * rFrac * rim[i % N];
    const x = spec.x + Math.cos(a) * r;
    const z = spec.z + Math.sin(a) * r;
    // Follow the terrain, and sit a few millimetres above it. Lower and the
    // decal z-fights on a slope; higher and it visibly floats at grazing view
    // angles, which is exactly how these presets look at the ground.
    pos.push(x, ground(x, z) + 0.006, z);
    c.copy(DAMP).lerp(DUFF, spec.duff);
    // Litter mottling: lighter flecks of twig and bark through the mat.
    const fleck = 1 + 0.5 * spec.duff * (rng() < 0.22 ? 1 : 0) * rng();
    // Quadratic falloff, and never quite opaque even at the centre: duff is a
    // layer on the dirt, not a hole in it.
    const a01 = spec.strength * Math.pow(clamp01(1 - rFrac), 1.6);
    col.push(c.r * fleck, c.g * fleck, c.b * fleck, a01);
  };

  // Centre vertex.
  pos.push(spec.x, y0 + 0.006, spec.z);
  c.copy(DAMP).lerp(DUFF, spec.duff);
  col.push(c.r, c.g, c.b, spec.strength);

  for (let ring = 1; ring <= RINGS; ring++) {
    const rFrac = ring / RINGS;
    for (let i = 0; i < N; i++) vert((i / N) * Math.PI * 2, rFrac, i);
  }

  const ringStart = (ring: number) => 1 + (ring - 1) * N;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(0, ringStart(1) + i, ringStart(1) + j);
  }
  for (let ring = 1; ring < RINGS; ring++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a0 = ringStart(ring) + i;
      const a1 = ringStart(ring) + j;
      const b0 = ringStart(ring + 1) + i;
      const b1 = ringStart(ring + 1) + j;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

export function buildGroundMats(specs: MatSpec[], ground: Ground): THREE.BufferGeometry | null {
  if (!specs.length) return null;
  const parts = specs.map((s) => discGeometry(s, ground));
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * Unlit, additive-free, plain alpha blend. Unlit on purpose: this is standing in
 * for occlusion and for a change of material on the ground, and running it
 * through the PBR path at a 6 degree sun would light the mat differently from
 * the dirt it sits on, which is the one thing that would give it away.
 */
export function groundMatMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // Behind everything that stands on it, in front of the ground.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.FrontSide,
    fog: true,
  });
}

/** Duff mats under a set of pines, plus the litter that spills past the rim. */
/**
 * Where the debris actually lies, as opposed to where a plant is.
 *
 * `wind` is the real site wind, and `gain` is a bounded multiplier on mat
 * strength that a caller builds out of Terrain's `groundAccum`. Both are
 * optional so the generator still stands alone, but both should be supplied:
 * the downwind pile offset used to be a hardcoded bearing of 2.9 rad, which is
 * exactly the kind of number two systems can disagree about silently. Terrain
 * publishes `wind.bearing`; there is no reason to keep a second copy of it.
 */
export interface DebrisContext {
  /** Unit vector the wind blows towards. */
  wind?: { dirX: number; dirZ: number; strength?: number };
  /**
   * Bounded multiplier on mat strength at a point, from the accumulation
   * fields. Bounded rather than free because the fields it comes from are
   * bimodal: an unbounded gradient off a bimodal field is a hard cut with a
   * fringe, which is a defect, and the caller is the one holding the contract
   * that says so.
   */
  gain?: (x: number, z: number) => number;
}

/** Opacity is opacity: never negative, never fully opaque. */
const matStrength = (base: number, gain: number): number =>
  Math.max(0.04, Math.min(0.95, base * gain));

export function pineDuffSpecs(
  pines: { x: number; z: number; h: number }[],
  seed = 5501,
  ctx: DebrisContext = {}
): MatSpec[] {
  const rng = seededRng(seed);
  const out: MatSpec[] = [];
  const wx = ctx.wind?.dirX ?? Math.cos(2.9);
  const wz = ctx.wind?.dirZ ?? Math.sin(2.9);
  const wl = Math.hypot(wx, wz) || 1;
  const gainAt = ctx.gain ?? (() => 1);
  for (let i = 0; i < pines.length; i++) {
    const p = pines[i];
    const drip = Math.max(1.5, p.h * 0.2);
    const cx = p.x + (rng() - 0.5) * 0.5;
    const cz = p.z + (rng() - 0.5) * 0.5;
    out.push({
      x: cx,
      z: cz,
      // Slightly outside the drip line: needles drift.
      radius: drip * lerp(1.0, 1.35, rng()),
      strength: matStrength(lerp(0.5, 0.78, rng()), gainAt(cx, cz)),
      duff: 1,
      seed: seed + i * 37,
    });
    // A second, smaller and denser mat offset downwind, where the needles pile.
    // The offset scales with wind strength, so a still site does not get a
    // displaced pile it has no mechanism for.
    const reach = drip * 0.45 * (0.4 + 0.6 * Math.min(1, ctx.wind?.strength ?? 1));
    const px = p.x + (wx / wl) * reach;
    const pz = p.z + (wz / wl) * reach;
    out.push({
      x: px,
      z: pz,
      radius: drip * lerp(0.45, 0.7, rng()),
      strength: matStrength(lerp(0.6, 0.85, rng()), gainAt(px, pz)),
      duff: 1,
      seed: seed + i * 37 + 5000,
    });
  }
  return out;
}

/**
 * Leaf and twig fall under a broadleaf or sapling crown: wider than a contact
 * patch, much weaker, and pushed downwind.
 *
 * Separate from `pineDuffSpecs` because the material is different — `duff` runs
 * lower, since dry leaf litter over pale soil is not the near-black needle mat
 * under a conifer — and separate from `contactSpecs` because a contact patch is
 * about damp and occlusion at the stem while this is about what fell.
 *
 * Deliberately NOT driven by Terrain's `litter` field. That field is Terrain's
 * own paper-and-trash scatter, in items per square metre, and it renders its own
 * items; multiplying my leaf fall by it would put my debris where Terrain's
 * debris already is and read as one doubled pile rather than two kinds of mess.
 */
export function crownLitterSpecs(
  crowns: { x: number; z: number; height: number }[],
  seed = 6301,
  ctx: DebrisContext = {}
): MatSpec[] {
  const rng = seededRng(seed);
  const out: MatSpec[] = [];
  const wx = ctx.wind?.dirX ?? 0;
  const wz = ctx.wind?.dirZ ?? 0;
  const wl = Math.hypot(wx, wz) || 1;
  const gainAt = ctx.gain ?? (() => 1);
  for (let i = 0; i < crowns.length; i++) {
    const c = crowns[i];
    // A shrub or sapling's crown is a fraction of its height across, and litter
    // lands a little beyond it.
    const drip = Math.max(0.34, c.height * 0.3);
    const reach = drip * 0.3 * Math.min(1, ctx.wind?.strength ?? 1);
    const x = c.x + (wx / wl) * reach + (rng() - 0.5) * 0.18;
    const z = c.z + (wz / wl) * reach + (rng() - 0.5) * 0.18;
    out.push({
      x,
      z,
      radius: drip * lerp(1.05, 1.5, rng()),
      strength: matStrength(lerp(0.16, 0.34, rng()), gainAt(x, z)),
      duff: lerp(0.35, 0.62, rng()),
      seed: seed + i * 41,
    });
  }
  return out;
}

/** Tight damp-soil patches at the base of posts, poles and clumps. */
export function contactSpecs(
  points: [number, number][],
  radius: number,
  strength: number,
  seed = 5701
): MatSpec[] {
  const rng = seededRng(seed);
  return points.map((p, i) => ({
    x: p[0],
    z: p[1],
    radius: radius * lerp(0.7, 1.4, rng()),
    strength: strength * lerp(0.6, 1.15, rng()),
    duff: 0.35,
    seed: seed + i * 13,
  }));
}
