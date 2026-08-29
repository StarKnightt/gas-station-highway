/**
 * The continuous inter-plant mat.
 *
 * The standing critique of this scene's ground is "bare soil with props
 * scattered on it". That is an accurate description of what the system built:
 * discrete clumps at discrete sites, discrete decals under each one, and
 * between them the terrain's own dirt with nothing organic on it at all. Real
 * ground outside a maintained surface is never bare. There is a low continuous
 * layer — cured thatch, last year's stems flattened by winter, fine litter,
 * moss and crust in the damp parts — and the discrete plants stand *in* it. The
 * mat is what makes the plants look planted instead of placed.
 *
 * Two pieces, because one of them alone is a known failure:
 *
 *  - **The sheet.** A continuous alpha-blended layer following the terrain,
 *    with cover and colour varying by world position. This carries the tonal
 *    half: the ground stops being one material.
 *  - **The sprigs.** Tiny instanced thatch stars, 6-16 cm, at high density
 *    where the sheet is dense. These carry the *silhouette* half, and without
 *    them the sheet is a stain. This project has already recorded (NOTES, the
 *    "convex disc" case) that relief with no silhouette reads as a texture
 *    painted on a flat surface, which is precisely what it would be.
 *
 * ## Cover is keyed off `groundSoil`, not off a second invented mask
 *
 * Terrain publishes `disturbance`, `wetness`, `drainage` and `material` as pure
 * CPU functions of world XZ. Inventing a parallel mask here would produce a mat
 * that disagrees with the soil it is growing out of — thatch over a wheel rut,
 * bare crust in a damp hollow — and the disagreement would be visible long
 * before anyone thought to look for it, because the eye reads "plants grow
 * where it is wet" without being told. So every term below is a function of
 * that field, and the only thing added locally is the patchiness noise, which
 * is a property of the plants and not of the soil.
 *
 * ## The sheet is lit, and that is a deliberate departure from `vegGround`
 *
 * `vegGround`'s contact decals are `MeshBasicMaterial` on the argument that a
 * PBR path at a 6.2 degree sun would light them differently from the dirt they
 * sit on. That argument is right for a 30 cm dark patch and wrong for this,
 * because this covers the whole near field: an unlit constant over that area
 * does not blend with the ground, it *replaces* the ground's response to the
 * sun with a flat tone, and the result is a scene where the dirt has shading
 * and the vegetation on it does not. So the sheet is `MeshStandardMaterial`,
 * receives shadow, and gets a tilted normal field — a mat of stems is not a
 * plane, and at a grazing sun the unevenness of its normals is most of what
 * makes it read as a material rather than a colour.
 *
 * All colours here are **linear scene-referred**, written directly as linear
 * triples. Not `setRGB(..., SRGBColorSpace)`: see NOTES case 24 and the note in
 * `vegGround.ts`, where exactly this layer's sibling landed 12.8x too dark and
 * three review rounds read it as an absent feature rather than a black one.
 */

import * as THREE from "three";
import { clamp01, fbm, lerp, makeRng, remap, sampleWrapped, seededRng, smoothstep } from "./noise";

export type Ground = (x: number, z: number) => number;

/**
 * The half of `groundSoil` this module consumes. Declared structurally rather
 * than imported from `gen/groundSoil`, so the mat can be built and measured in
 * a plain Node process against a stub, and so a change to the provider's
 * internals cannot silently change what the mat is keyed to.
 */
export interface SoilQuery {
  /** 0 = undisturbed crust, 1 = trafficked / compacted. */
  disturbance(x: number, z: number): number;
  /** 0 = dry, 1 = standing water. */
  wetness(x: number, z: number): number;
  /** Metres above/below the local drainage datum; negative is a low spot. */
  drainage(x: number, z: number): number;
  /** 0 = coarse gravelly crust, 1 = fine pale clay. */
  material(x: number, z: number): number;
}

export interface MatFieldOptions {
  soil: SoilQuery;
  /** True where nothing may grow: paving, aprons, building footprints. */
  blocked(x: number, z: number): boolean;
  seed?: number;
}

/**
 * Cover fraction, 0..1, at a world position: how much of the ground here is
 * under the mat.
 *
 * Exported so `tools/vegmat.mjs` can sweep it over the site and report the
 * histogram without a GPU. A cover field that is 0.9 everywhere is a green
 * carpet and a cover field that is 0.1 everywhere is the bare soil we started
 * with; neither shows up in a render as obviously as it does in a histogram.
 */
export function makeMatField(opts: MatFieldOptions) {
  const seed = opts.seed ?? 8821;
  const rng = makeRng(seed);
  // Two patch scales. One decides which parts of a field have a sward at all
  // (tens of metres), the other breaks that into the metre-scale mottling of
  // thicker and thinner thatch. A single scale gives either a uniform carpet or
  // a noise texture, and the eye reads both as artificial.
  const N = 256;
  //
  // `fbm` divides by its total amplitude, so its output is a sum of independent
  // layers concentrated hard on 0.5 — NOTES case 3, the horizon band's height
  // field, which cost three rounds of re-weighting an average that cannot be
  // fixed by re-weighting. The first version of this field walked straight into
  // it: `tools/vegmat.mjs` measured **50% of the site inside cover 0.2..0.3**,
  // a uniform 25% wash over everything, which is precisely the "green carpet"
  // failure this layer exists to avoid.
  //
  // So the raw fbm is stretched to its own full range and then pushed through a
  // contrast curve, which converts a bell into masses and gaps. Growth is
  // patchy; the distribution has to be bimodal, not central.
  const broad = remap(fbm(N, 4, rng, { octaves: 3, gain: 0.5 }), 0, 1);
  const fine = remap(fbm(N, 20, makeRng(seed + 101), { octaves: 3, gain: 0.5 }), 0, 1);
  // Metres per wrap of each noise buffer.
  const BROAD_M = 155;
  const FINE_M = 27;

  const noiseAt = (x: number, z: number) => {
    // Where there is a sward at all, at the scale of a field.
    const b = smoothstep(0.33, 0.70, sampleWrapped(broad, N, x / BROAD_M, z / BROAD_M));
    // How thick it is inside a patch, at the scale of a few metres.
    const f = smoothstep(0.22, 0.82, sampleWrapped(fine, N, x / FINE_M, z / FINE_M));
    // Multiplied: the broad term decides where, the fine term modulates. Added,
    // the two would average and re-concentrate, which is the bug above.
    return clamp01(b * lerp(0.30, 1.35, f));
  };

  /**
   * The soil-driven part, separated so a harness can attribute a low cover
   * reading to the soil or to the noise.
   */
  const suitability = (x: number, z: number) => {
    const dist = opts.soil.disturbance(x, z);
    const wet = opts.soil.wetness(x, z);
    const drain = opts.soil.drainage(x, z);
    const matl = opts.soil.material(x, z);

    // Traffic is the strongest single term and it is nearly absolute: a mat is
    // the one thing that does not survive being driven or walked on, which is
    // why a trail through scrub is visible from the air.
    const traffic = Math.pow(1 - clamp01(dist), 1.5);

    // Damp is best. Bone dry supports a thin cured thatch and nothing green;
    // standing water supports nothing at all, and putting a sward across a
    // puddle is the sort of disagreement keying off the shared field is meant
    // to prevent.
    const damp = smoothstep(0.0, 0.34, wet) * (1 - smoothstep(0.62, 0.92, wet));
    const moisture = lerp(0.34, 1.0, damp);

    // Hollows collect water, silt and blown litter, so they carry more cover
    // than the rises either side even at equal wetness. `drainage` is in
    // metres; 200 mm below datum is already a distinctly greener strip.
    const hollow = 1 - smoothstep(-0.24, 0.30, drain);
    const relief = lerp(0.72, 1.24, hollow);

    // Gravelly crust roots badly, fine clay holds moisture. A mild term; it
    // separates the shoulder wash from the field behind it.
    const soilKind = lerp(0.78, 1.1, clamp01(matl));

    return clamp01(traffic * moisture * relief * soilKind);
  };

  const cover = (x: number, z: number) => {
    if (opts.blocked(x, z)) return 0;
    // Multiplied, not averaged. An average of the two would concentrate on its
    // mean and produce a mat that is everywhere half there — the same defect
    // recorded in NOTES for the horizon band's height field, which cost three
    // rounds. The product keeps the gaps.
    return clamp01(suitability(x, z) * noiseAt(x, z) * 1.55);
  };

  return { cover, suitability, noiseAt };
}

export interface MatSheetOptions extends MatFieldOptions {
  ground: Ground;
  /** Centre of the built region, world XZ. */
  centre: [number, number];
  /** Nominal radius of the built region, metres. Perturbed, see below. */
  radius: number;
  /** Grid pitch, metres. */
  pitch?: number;
}

export interface MatSheetResult {
  geometry: THREE.BufferGeometry | null;
  /** Cells considered, cells kept — the yield, for the budget report. */
  cells: number;
  kept: number;
  triangles: number;
  /** Mean cover over unblocked cells, for the histogram sanity check. */
  meanCover: number;
}

/**
 * The continuous sheet.
 *
 * A shared-vertex indexed grid, not one quad per cell: shared vertices make the
 * cover field interpolate continuously across the sheet instead of stopping at
 * every cell boundary, and they cost a quarter of the vertices.
 *
 * Every vertex is jittered in XZ by up to 40% of the pitch. This is not
 * decoration. A regular grid under an alpha ramp produces axis-aligned
 * structure at the edge of the mat wherever cover crosses the drop threshold,
 * and this project has a standing item about straight-line mask boundaries; a
 * grid is the largest straight-line mask in the system and it would have been
 * added by this change.
 */
export function buildMatSheet(opts: MatSheetOptions): MatSheetResult {
  const pitch = opts.pitch ?? 0.85;
  const field = makeMatField(opts);
  const rng = seededRng((opts.seed ?? 8821) + 7);
  const [cx, cz] = opts.centre;

  const half = Math.ceil(opts.radius / pitch);
  const n = half * 2 + 1;

  // Perturbed boundary. A hard circular cull edge is visible as an arc of
  // vanishing detail whenever the camera can see across it; the radius is
  // modulated by a low-frequency function of bearing so the edge is a ragged
  // coastline instead. Cover also fades to zero over the last 8 m, so nothing
  // pops off at full opacity.
  const radiusAt = (bearing: number) =>
    opts.radius *
    (1 + 0.13 * Math.sin(bearing * 2.3 + 1.7) + 0.08 * Math.sin(bearing * 5.1 - 0.6) + 0.05 * Math.sin(bearing * 9.7 + 2.9));

  // Cured thatch: a dark material. Dead grass is 12-18% reflectance and this
  // sits under a dawn sun, so authored bright it becomes a pale carpet, which
  // is the single most common way a ground-cover layer ruins a photograph.
  const THATCH = new THREE.Color(0.108, 0.092, 0.055);
  const SWARD = new THREE.Color(0.055, 0.072, 0.040);
  const SILT = new THREE.Color(0.078, 0.070, 0.058);
  const c = new THREE.Color();

  interface V {
    x: number;
    z: number;
    y: number;
    cov: number;
    ok: boolean;
  }
  const verts: V[] = new Array(n * n);
  let coverSum = 0;
  let coverN = 0;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = cx + (i - half) * pitch;
      const gz = cz + (j - half) * pitch;
      const jx = gx + (rng() - 0.5) * pitch * 0.8;
      const jz = gz + (rng() - 0.5) * pitch * 0.8;
      const dx = jx - cx;
      const dz = jz - cz;
      const r = Math.hypot(dx, dz);
      const rEdge = radiusAt(Math.atan2(dz, dx));
      const edge = 1 - smoothstep(rEdge - 8, rEdge, r);
      const cov = edge <= 0 ? 0 : clamp01(field.cover(jx, jz) * edge);
      if (edge > 0 && !opts.blocked(jx, jz)) {
        coverSum += cov;
        coverN++;
      }
      verts[j * n + i] = { x: jx, z: jz, y: opts.ground(jx, jz), cov, ok: cov > 0.02 };
    }
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vmap = new Int32Array(n * n).fill(-1);

  const emit = (k: number): number => {
    if (vmap[k] >= 0) return vmap[k];
    const v = verts[k];
    const id = pos.length / 3;
    vmap[k] = id;

    // Micro-relief. A mat of stems is 20-60 mm deep and its surface is not the
    // terrain's surface; it also must not be coplanar with it, or the whole
    // sheet z-fights on the flat parts of the site.
    const lift = 0.012 + v.cov * 0.045 * (0.6 + 0.8 * fract(v.x * 0.71 + v.z * 1.13));
    pos.push(v.x, v.y + lift, v.z);

    // Tilted normals. At a 6.2 degree sun a flat-up normal receives
    // sin(6.2) = 0.108 of the sun everywhere, uniformly, which is a grey card.
    // Real thatch presents stems at every angle and therefore has bright and
    // dark patches under exactly this light; tilting the normals is the
    // cheapest available version of that and it is the term that stops the
    // sheet reading as paint.
    const a = fract(v.x * 0.317 + v.z * 0.211) * Math.PI * 2;
    const t = 0.18 + 0.34 * fract(v.x * 0.129 - v.z * 0.283) * v.cov;
    const nx = Math.cos(a) * Math.sin(t);
    const nz = Math.sin(a) * Math.sin(t);
    nrm.push(nx, Math.cos(t), nz);

    // Colour by what the soil said, so a damp hollow is green and a dry rise is
    // straw without a second opinion being formed here.
    const wet = opts.soil.wetness(v.x, v.z);
    const drain = opts.soil.drainage(v.x, v.z);
    const green = clamp01(smoothstep(0.12, 0.55, wet) * 0.8 + (1 - smoothstep(-0.2, 0.25, drain)) * 0.45);
    c.copy(THATCH).lerp(SWARD, green);
    // Silt film where water stands and then leaves: pale, and it is what makes
    // a dry watercourse read as one.
    c.lerp(SILT, clamp01(smoothstep(0.55, 0.95, wet)) * 0.6);
    const fleck = 0.82 + 0.42 * fract(v.x * 2.71 + v.z * 3.37);
    // Alpha is the cover fraction, softened: a mat thins at its edges rather
    // than ending. Capped below 1 because even dense thatch shows soil through
    // it and a mat that fully hides the terrain is a new ground plane, not a
    // layer on the old one.
    const alpha = Math.min(0.88, Math.pow(v.cov, 0.85) * 0.95);
    col.push(c.r * fleck, c.g * fleck, c.b * fleck, alpha);
    return id;
  };

  let cells = 0;
  /**
   * Emit a triangle with the winding that makes it face up, whatever order the
   * grid handed it in.
   *
   * The grid indices imply a winding, and here that implication is false. Each
   * vertex is jittered by up to +/-0.4 of the pitch in *both* axes before the
   * cells are triangulated, so a triangle's three corners can end up in the
   * opposite rotational order from the one their `(i, j)` positions suggest —
   * more easily on the near-collinear ones. Its `normal` attribute is built from
   * a tilt about +Y and so always points up; the geometry then disagrees with it,
   * `matSheetMaterial` is FrontSide, and the triangle is culled. That is a hole
   * in the mat rather than a visible error.
   *
   * Found by `tools/probe-winding.mjs` at 92 of 22,882 triangles, 0.4%. Small
   * enough to never be noticed and exactly the wrong size to look for.
   *
   * The test is against the triangle's **own mean shading normal**, not against
   * +Y. Testing against +Y was tried first and left 1 triangle of 22,882 still
   * disagreeing, which is instructive rather than annoying: the shading normals
   * here are tilted by up to 30 degrees off vertical on purpose, so on a sliver
   * whose geometric normal is nearly horizontal, "faces up" and "agrees with its
   * own normals" are different questions and only the second one is the one the
   * renderer asks. Testing the quantity that back-face culling actually consumes
   * makes this exact by construction, at the same cost.
   */
  const pushUpward = (p: number, q: number, r: number): void => {
    const ax = pos[p * 3];
    const ay = pos[p * 3 + 1];
    const az = pos[p * 3 + 2];
    const ux = pos[q * 3] - ax;
    const uy = pos[q * 3 + 1] - ay;
    const uz = pos[q * 3 + 2] - az;
    const vx = pos[r * 3] - ax;
    const vy = pos[r * 3 + 1] - ay;
    const vz = pos[r * 3 + 2] - az;
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const sx = nrm[p * 3] + nrm[q * 3] + nrm[r * 3];
    const sy = nrm[p * 3 + 1] + nrm[q * 3 + 1] + nrm[r * 3 + 1];
    const sz = nrm[p * 3 + 2] + nrm[q * 3 + 2] + nrm[r * 3 + 2];
    if (fx * sx + fy * sy + fz * sz >= 0) idx.push(p, q, r);
    else idx.push(p, r, q);
  };

  let kept = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = j * n + i + 1;
      const d = (j + 1) * n + i;
      const e = (j + 1) * n + i + 1;
      cells++;
      // A cell survives if any corner has cover. Dropping only all-zero cells
      // keeps the fade-out continuous; dropping cells whose *mean* is low would
      // cut into the ramp and put a hard edge back.
      if (!verts[a].ok && !verts[b].ok && !verts[d].ok && !verts[e].ok) continue;
      kept++;
      const ia = emit(a);
      const ib = emit(b);
      const id = emit(d);
      const ie = emit(e);
      // Alternate the diagonal on a checker so the triangulation itself does
      // not lay a 45 degree grain across the whole sheet.
      if ((i + j) & 1) {
        pushUpward(ia, id, ie);
        pushUpward(ia, ie, ib);
      } else {
        pushUpward(ia, id, ib);
        pushUpward(ib, id, ie);
      }
    }
  }

  if (!idx.length) {
    return { geometry: null, cells, kept, triangles: 0, meanCover: coverN ? coverSum / coverN : 0 };
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return {
    geometry: g,
    cells,
    kept,
    triangles: idx.length / 3,
    meanCover: coverN ? coverSum / coverN : 0,
  };
}

/** Deterministic 0..1 hash of a float, for per-vertex variation without an rng walk. */
function fract(v: number): number {
  const s = Math.sin(v * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Alpha-blended, lit, no depth write, offset behind everything standing on it.
 *
 * `receiveShadow` is set on the mesh, not here, but the material must be in the
 * standard path for that to mean anything — which is the whole reason this is
 * not `MeshBasicMaterial` like its sibling in `vegGround`.
 */
export function matSheetMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    roughness: 0.97,
    metalness: 0,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    fog: true,
  });
}

/**
 * A thatch sprig: four thin blades leaning out from a common base, as two
 * crossed quads' worth of triangles.
 *
 * Deliberately tiny — 60-160 mm — and deliberately not a smaller version of the
 * scrub clump card. What is missing between the clumps is not small clumps, it
 * is the stubble underneath them, and stubble has no crown shape at all.
 */
export function thatchSprigGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const BLADES = 4;
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + 0.4;
    // Blades lean out as well as up; a vertical tuft of four reads as a star
    // from above and as a single line from the side.
    const lean = 0.55;
    const tipX = Math.cos(a) * lean;
    const tipZ = Math.sin(a) * lean;
    const px = Math.cos(a + Math.PI / 2) * 0.055;
    const pz = Math.sin(a + Math.PI / 2) * 0.055;
    const base = pos.length / 3;
    pos.push(-px, 0, -pz, px, 0, pz, tipX * 0.55 + px * 0.5, 0.62, tipZ * 0.55 + pz * 0.5, tipX, 1.0, tipZ);
    // Normals face outward along the blade's own bearing, so the four blades of
    // one sprig catch the low sun differently and the sprig has an interior.
    for (let k = 0; k < 4; k++) nrm.push(Math.cos(a) * 0.55, 0.83, Math.sin(a) * 0.55);
    uv.push(0, 0, 1, 0, 0.5, 0.62, 0.5, 1);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export interface SprigScatterOptions extends MatFieldOptions {
  ground: Ground;
  centre: [number, number];
  /** Nominal cull radius. Beyond it a 100 mm sprig is under a pixel. */
  radius: number;
  /** Hard cap on instances. The budget, not a target. */
  budget: number;
}

export interface Sprig {
  matrix: THREE.Matrix4;
  tint: THREE.Color;
}

/**
 * Scatters sprigs by cover, with a hard instance budget.
 *
 * Candidates are drawn on a jittered lattice and accepted with probability
 * equal to the local cover, which gives a density that tracks the sheet exactly
 * — the sprigs and the sheet are then two views of one field rather than two
 * fields that agree approximately. If the acceptances exceed the budget the
 * whole set is thinned uniformly at the end rather than truncated, because
 * truncating a lattice-ordered list empties one side of the site.
 */
export function scatterSprigs(opts: SprigScatterOptions): Sprig[] {
  const field = makeMatField(opts);
  const rng = seededRng((opts.seed ?? 8821) + 313);
  const [cx, cz] = opts.centre;
  // 11 candidates per square metre before the cover test.
  //
  // The first figure was 2.6/m^2 and produced 599 sprigs against a 7000 budget,
  // because most of a 34 m circle centred on the lot is the forecourt and the
  // highway — the unblocked area is a fraction of the disc, and sizing the
  // lattice off the disc was sizing it off area that can never accept. The
  // budget is the control here, not the pitch, so the pitch is set to saturate
  // it in the dense parts and the thinning at the end does the rest.
  const PITCH = 0.30;
  const half = Math.ceil(opts.radius / PITCH);
  const out: Sprig[] = [];
  const c = new THREE.Color();
  /*
   * Albedos, and the previous values were not physical.
   *
   * These were (1.05, 0.98, 0.78) and (0.76, 0.94, 0.72) — the first reflects
   * 105% of the red it receives. They reach the shader as `instanceColor`,
   * which multiplies the material's diffuse, so they are reflectances and
   * nothing downstream renormalises them.
   *
   * That mattered far more than a 5% overshoot, because `applyFoliageTransmission`
   * multiplies its transmitted term by `diffuseColor.rgb`. The sprigs run
   * `strength: 6.8` and `fill: 1.8`, the strongest in the project, and those
   * figures were tuned on the pines, whose diffuse comes from a needle texture
   * around 0.1. Reusing them against an albedo of 1.0 put the additive term
   * several times sun radiance, and a 100 mm thatch star at ankle height
   * clipped to flat white — visible as a scatter of white sparklers in the
   * near foreground of `underpine`, in crown shade, which is where the term is
   * deliberately not shadow-multiplied and therefore strongest.
   *
   * Cured grass and dry straw measure about 0.30-0.40 in the visible, warmer
   * in red; a live blade is nearer 0.25-0.40 and peaks in green. The dawn glow
   * the strength was tuned for still scales with albedo, which is the correct
   * physics — if it now reads weak, that is a tuning question to settle with a
   * measurement rather than by putting the reflectance back above one.
   */
  const DRY = new THREE.Color(0.44, 0.38, 0.24);
  const GREEN = new THREE.Color(0.26, 0.36, 0.18);

  const radiusAt = (bearing: number) =>
    opts.radius * (1 + 0.15 * Math.sin(bearing * 1.9 - 0.4) + 0.09 * Math.sin(bearing * 4.7 + 2.2));

  for (let j = -half; j <= half; j++) {
    for (let i = -half; i <= half; i++) {
      const x = cx + i * PITCH + (rng() - 0.5) * PITCH * 1.6;
      const z = cz + j * PITCH + (rng() - 0.5) * PITCH * 1.6;
      const r = Math.hypot(x - cx, z - cz);
      if (r > radiusAt(Math.atan2(z - cz, x - cx))) continue;
      const cov = field.cover(x, z);
      if (cov < 0.05) continue;
      // Thin with distance as well as with cover: the sprigs exist to give the
      // near ground silhouette, and past ~25 m they are contributing sub-pixel
      // triangles to a tone the sheet already carries.
      const near = 1 - smoothstep(16, opts.radius, r);
      if (rng() > cov * (0.18 + 0.82 * near)) continue;

      const h = lerp(0.06, 0.17, rng() * rng() + 0.1) * lerp(0.8, 1.35, cov);
      const w = h * lerp(0.9, 1.6, rng());
      const yaw = rng() * Math.PI * 2;
      const tiltA = rng() * Math.PI * 2;
      const tilt = rng() * rng() * 0.5;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      q.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(tiltA), 0, Math.sin(tiltA)), tilt)
      );
      m.compose(
        new THREE.Vector3(x, opts.ground(x, z) - 0.01, z),
        q,
        new THREE.Vector3(w, h, w)
      );
      const wet = opts.soil.wetness(x, z);
      c.copy(DRY).lerp(GREEN, clamp01(smoothstep(0.15, 0.6, wet) + rng() * 0.25 - 0.12));
      c.multiplyScalar(lerp(0.7, 1.15, rng() * rng() + 0.15));
      out.push({ matrix: m, tint: c.clone() });
    }
  }

  if (out.length > opts.budget) {
    const keep = opts.budget / out.length;
    const thin = seededRng(9091);
    const thinned = out.filter(() => thin() < keep);
    return thinned;
  }
  return out;
}
