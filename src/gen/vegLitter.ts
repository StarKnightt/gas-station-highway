/**
 * The scattered half of the debris skirt: discrete needle and leaf litter lying
 * on the ground under and around plants.
 *
 * `vegGround.ts` already draws the *tint* half — flat unlit decal discs that
 * darken and redden the dirt under a crown. That is the right primitive for
 * "this ground is covered in duff" and it is the wrong primitive for "there are
 * needles on it": a disc has no grain, no silhouette against the soil and no
 * response to a 6 degree sun, so at ankle height it reads as a painted circle
 * whatever its colour is. This module supplies the grain. The two are meant to
 * be seen together, and the disc is what keeps this one cheap — the scatter
 * only has to break the disc's edge and catch some light, not to cover the
 * ground on its own.
 *
 * ## Composition: a field for WHERE, a profile for HOW
 *
 * `groundAccum` publishes two kinds of thing and they are not interchangeable.
 * The *fields* (`shelter`, `swept`, ...) are properties of the site and vary at
 * the scale of the site; the *profiles* (`underCrown`, `lee`, `wallBase`) are
 * pure functions of the caller's own geometry and therefore always have range.
 * Terrain's own note is explicit that a field which is flat where you sample it
 * cannot supply a pattern, and that the profile is what carries the structure
 * when that happens.
 *
 * Both halves are needed here and they answer different questions:
 *
 *  - `underCrown(x, z, cx, cz, r)` — the profile — says how litter is arranged
 *    beneath one crown. It peaks at 0.72 of the drip radius rather than at the
 *    trunk, because that is where a canopy actually sheds, and the whole pattern
 *    is displaced downwind. It reaches zero past 1.35 r, which is what bounds
 *    the scatter loop.
 *  - `gain(x, z)` — built by the caller from the bimodal `shelter` and `swept`
 *    fields, through smoothsteps and bounded — says whether this patch of the
 *    site keeps what falls on it at all. Ground on a traffic path does not.
 *
 * The product is the deposition. Neither alone is: the field alone puts an even
 * wash under everything in a sheltered corner and nothing under an identical
 * plant ten metres away, and the profile alone puts the same ring under a plant
 * standing in a wheel rut as under one in a ditch.
 *
 * ## The unit, which is the thing that bites
 *
 * `DRAWN_ITEMS_PER_M2` is a **density**, items per square metre, and it is
 * converted to a count by multiplying by cell area. It is deliberately in the
 * same units as `groundAccum.litter` even though that field is not consumed
 * here, because the failure that field's contract warns about is exactly the
 * one available in this file: treating a per-square-metre density as a
 * per-cell probability. At the 0.19 m cell below that is a **28x**
 * over-scatter, and it would look like a tuning problem rather than a unit
 * error, because the picture it produces is "too much litter" and not "wrong".
 *
 * The conversion is `floor(n) + Bernoulli(frac(n))`, not `Bernoulli(n)`. A
 * plain Bernoulli saturates the moment `n` exceeds 1 and then silently
 * *under*-scatters however far the density is raised — the mirror of the same
 * error, and the more dangerous one, because raising the constant stops
 * changing the picture and the natural reading of that is "the term is not
 * reaching the geometry" rather than "the term is capped".
 *
 * What the unit stands in for, stated plainly so nobody re-derives it wrongly:
 * **a drawn item is a visible tuft of litter a few centimetres across, not one
 * needle.** A real pine drops needles in the thousands per square metre and
 * this draws tens. The density is a drawing budget wearing physical units; the
 * units are kept because they are what makes the cell size safe to change.
 *
 * ## Scope, and what is deliberately left to Terrain
 *
 * Terrain scatters gravel spill from `fines` and paper litter from `litter`
 * over the whole lot, and is separately raising near-field debris density from
 * the geometry side. This module is bounded to `underCrown > 0`, i.e. inside
 * 1.35 drip radii of a crown this system placed, and it consumes neither of
 * Terrain's two scattering fields. So the two never decide the same square
 * metre from the same input: Terrain owns the open ground, this owns under the
 * plants, and `VegetationSystem` publishes the footprint through
 * `vegetationDebris` so Terrain can subtract it.
 */

import * as THREE from "three";
import { lerp, seededRng } from "./noise";

export type Ground = (x: number, z: number) => number;

/** One crown to scatter beneath, in the terms `underCrown` takes. */
export interface LitterCrown {
  x: number;
  z: number;
  /** Plan radius of the crown, metres. `underCrown`'s `radius` argument. */
  radius: number;
  /** 0 = pale dry broadleaf litter, 1 = dark conifer needle duff. */
  duff: number;
}

/**
 * The two `groundAccum` entry points this needs, plus the shared hash.
 *
 * Structural, not a copy of the service: passing the whole `GroundAccum` would
 * let a later edit reach for `litter` or `fines` from in here without the call
 * site — which holds the contract and the reasoning about which fields are
 * whose — having any say in it.
 */
export interface LitterFields {
  underCrown(x: number, z: number, cx: number, cz: number, radius: number): number;
  /** Bounded site gain the caller composed from the bimodal fields. */
  gain(x: number, z: number): number;
  /** `groundAccum.jitter`, so this shares a hash with the rest of the site. */
  jitter(x: number, z: number, salt: number): number;
}

export interface LitterOptions {
  /** Scatter cell, metres. The count conversion is a function of this. */
  cellMetres: number;
  /** Drawn items per square metre at full deposition (profile 1, gain 1). */
  itemsPerSquareMetre: number;
  /**
   * Hard ceiling on placed instances. Exceeding it is reported, never silently
   * absorbed by thinning the density — thinning would break the stated units
   * and leave a tool that checks them agreeing with a lie.
   */
  budget: number;
  /** Salt for the placement hash. */
  salt?: number;
}

export interface LitterInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tilt: number;
  tiltDir: number;
  /** Metres, long axis. */
  size: number;
  /** Aspect: >1 is a broad flake, <1 a narrow needle sliver. */
  broad: number;
  duff: number;
  shade: number;
}

export interface LitterStats {
  crowns: number;
  cells: number;
  /**
   * `sum(cellArea * profile * gain)` over every cell visited, in square metres:
   * the deposition-weighted area the skirt covers.
   *
   * Purely geometric. It is accumulated WITHOUT reference to the count
   * conversion, which is the entire point of it — see `expected`.
   */
  effectiveAreaM2: number;
  /**
   * `itemsPerSquareMetre * effectiveAreaM2`: the count the physical model asks
   * for, derived from the declared density and an area, and never from the
   * per-cell number the placement loop actually used.
   *
   * The first version of this accumulated the loop's own `n` and compared the
   * placed count against that. It passed at exactly 1.000 with the cell-area
   * term deleted from the conversion — a 28x over-scatter — because both sides
   * of the comparison were the same wrong quantity. A consistency check that
   * sources both arms from the code under test agrees on the wrong value and
   * then certifies it. Only the budget ceiling caught that arm, and a ceiling
   * is not a unit check: raise the budget and the bug is clean again.
   */
  expected: number;
  placed: number;
  cellMetres: number;
  cellAreaM2: number;
  itemsPerSquareMetre: number;
  /** Largest per-cell `n`. Over 1 is what makes the Bernoulli form unsafe. */
  maxPerCell: number;
  /** Cells whose `n` exceeded 1, i.e. that a plain Bernoulli would have capped. */
  cellsOverOne: number;
  /**
   * `sum(min(n, 1))` — what the obvious `if (hash < n)` form would have placed.
   *
   * Carried so the choice of conversion is a measured difference rather than an
   * argument in a comment. If this equals `expected` then no cell ever exceeds
   * one item, the two forms agree, and the reasoning in the header is correct
   * but inert; the gap is what makes it load-bearing.
   */
  bernoulliWouldPlace: number;
  budget: number;
  overBudget: boolean;
  /** Distribution of the site gain as this scatter sampled it. */
  gainMin: number;
  gainP50: number;
  gainMax: number;
  /** Distribution of the crown profile over cells where it was non-zero. */
  profileP50: number;
  profileMax: number;
}

/**
 * A litter flake: four vertices, two triangles, folded along its long axis.
 *
 * The fold is the entire reason this is not a flat quad. A flat quad lying on
 * the ground has the ground's normal, takes the ground's shading, and at a 6
 * degree sun is the same value as the dirt under it — present in the depth
 * buffer, invisible in the frame, which is this project's dominant defect
 * class. Folding it by ~25 degrees gives the two halves different normals, so
 * one catches the low sun and the other does not, and the item reads as an
 * object rather than as a patch of slightly different dirt.
 *
 * Unit length along X, unit width along Z, so the caller's scale is in metres.
 */
export function litterGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Tail, one lifted flank, tip, one flatter flank. Asymmetric on purpose: two
  // equal flanks fold into a tent, which reads as a manufactured shape at the
  // few dozen pixels these ever occupy.
  const pos = new Float32Array([
    -0.5, 0.0, 0.0,
    0.06, 0.17, -0.5,
    0.5, 0.02, 0.0,
    0.02, 0.09, 0.5,
  ]);
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/**
 * Unlit-adjacent but real PBR, so the litter responds to the same sun and sky
 * the plant above it does.
 *
 * Not `MeshBasicMaterial` like the decal discs: those stand in for a change of
 * material on the ground and must not be lit differently from it, whereas this
 * is geometry standing proud of the ground and its whole job is to be shaded
 * differently. Fully rough and non-metallic — dry plant matter has no specular
 * lobe worth the name, and `metalness` between 0 and 1 is a category error.
 */
export function litterMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: false,
    roughness: 0.96,
    metalness: 0,
    // Both faces: these are 4 cm objects at arbitrary yaw and a viewer sees the
    // underside of about half of them. Culling them would remove roughly half
    // the scatter for no saving worth measuring at two triangles apiece.
    side: THREE.DoubleSide,
    flatShading: true,
    fog: true,
  });
}

/**
 * Linear scene-referred albedos, NOT display tones.
 *
 * Authored linear and passed to `THREE.Color(r, g, b)`, which writes the
 * working space directly. `setRGB(..., SRGBColorSpace)` would transfer-encode
 * these on the way in and land them 12x too dark, which is the bug that had
 * every pine on this site sitting in a black hole for three rounds — and it is
 * invisible in review, because a black decal looks exactly like a hole and
 * nothing like a wrong colour.
 *
 * Needle duff is dark and red-brown; dry broadleaf litter over pale soil is
 * much lighter and yellower. Both are lit here, so these are albedos and run
 * higher than the unlit disc tones in `vegGround.ts`, which are pixel values.
 */
const NEEDLE = new THREE.Color(0.105, 0.068, 0.040);
const LEAF = new THREE.Color(0.228, 0.176, 0.098);

export function litterColour(duff: number, shade: number, out = new THREE.Color()): THREE.Color {
  out.copy(LEAF).lerp(NEEDLE, Math.max(0, Math.min(1, duff)));
  return out.multiplyScalar(shade);
}

/**
 * Scatter litter under a set of crowns.
 *
 * Pure, and takes no THREE type on the way in, so `tools/veglitter.mjs` can run
 * the real placement on the CPU and check the unit conversion without a GPU and
 * without standing up a renderer.
 */
export function scatterCrownLitter(
  crowns: LitterCrown[],
  fields: LitterFields,
  ground: Ground,
  opts: LitterOptions
): { items: LitterInstance[]; stats: LitterStats } {
  const CELL = opts.cellMetres;
  const AREA = CELL * CELL;
  const DENSITY = opts.itemsPerSquareMetre;
  const salt = opts.salt ?? 91;
  const rng = seededRng(4409);

  const items: LitterInstance[] = [];
  const gains: number[] = [];
  const profiles: number[] = [];
  let cells = 0;
  let effectiveArea = 0;
  let maxPerCell = 0;
  let cellsOverOne = 0;
  let bernoulli = 0;

  for (const c of crowns) {
    // `underCrown` is identically zero past 1.35 radii, so that is the loop
    // bound rather than a chosen margin. Reading the reach out of the profile
    // means a change to the profile moves the loop with it; a literal here
    // would go stale silently and clip the outer ring of every skirt.
    const reach = c.radius * 1.35;
    const x0 = c.x - reach;
    const x1 = c.x + reach;
    const z0 = c.z - reach;
    const z1 = c.z + reach;
    for (let gx = Math.floor(x0 / CELL); gx <= Math.ceil(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.ceil(z1 / CELL); gz++) {
        // Jitter the sample off the lattice before anything is evaluated at it.
        // A regular grid of sample points under a radially symmetric profile
        // produces concentric rings of items, which is a lattice artefact that
        // survives every amount of per-item randomisation applied afterwards,
        // because it is in *where the decisions were made* and not in what was
        // placed.
        const jx = (gx + fields.jitter(gx, gz, salt)) * CELL;
        const jz = (gz + fields.jitter(gx, gz, salt + 1)) * CELL;

        const profile = fields.underCrown(jx, jz, c.x, c.z, c.radius);
        if (profile <= 0) continue;
        cells++;
        const gain = fields.gain(jx, jz);
        gains.push(gain);
        profiles.push(profile);

        // Density -> count. The whole unit argument in the file header is these
        // four lines, and the `floor + frac` rather than a Bernoulli is the half
        // that has no visible symptom when it is wrong.
        // The deposition-weighted area of this cell. Accumulated here from the
        // geometry alone, so the expected count is not a restatement of
        // whatever the next line decides.
        effectiveArea += AREA * profile * gain;

        const n = DENSITY * AREA * profile * gain;
        bernoulli += Math.min(n, 1);
        if (n > maxPerCell) maxPerCell = n;
        if (n > 1) cellsOverOne++;
        let k = Math.floor(n);
        if (fields.jitter(jx, jz, salt + 2) < n - k) k++;

        for (let i = 0; i < k; i++) {
          // Spread the k items across the cell rather than stacking them at the
          // sample point, or a cell that wins two items draws them coincident
          // and the second is free of charge and invisible.
          const px = jx + (rng() - 0.5) * CELL;
          const pz = jz + (rng() - 0.5) * CELL;
          const broad = lerp(0.22, 1.0, Math.pow(rng(), 1.6) * (1 - c.duff * 0.55));
          items.push({
            x: px,
            // Sits on top of the decal mat, which is at +6 mm with a negative
            // polygon offset pulling it further toward the camera. 12-19 mm
            // clears both, and a leaf lying on a centimetre of duff is where a
            // leaf lying on a centimetre of duff is.
            y: ground(px, pz) + 0.012 + rng() * 0.007,
            z: pz,
            yaw: rng() * Math.PI * 2,
            // Nearly flat. Litter lies down; a tilt large enough to notice
            // reads as debris standing on end, which is a different material.
            tilt: rng() * 0.34,
            tiltDir: rng() * Math.PI * 2,
            size: lerp(0.045, 0.105, Math.pow(rng(), 1.4)),
            broad,
            duff: c.duff,
            // Litter is not one tone: some of it is this year's and some has
            // been weathering for two. Multiplicative on the albedo.
            shade: lerp(0.62, 1.25, rng()),
          });
        }
      }
    }
  }

  const q = (v: number[], f: number) => {
    if (!v.length) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(f * s.length))];
  };

  return {
    items,
    stats: {
      crowns: crowns.length,
      cells,
      effectiveAreaM2: effectiveArea,
      expected: DENSITY * effectiveArea,
      placed: items.length,
      cellMetres: CELL,
      cellAreaM2: AREA,
      itemsPerSquareMetre: DENSITY,
      maxPerCell,
      cellsOverOne,
      bernoulliWouldPlace: bernoulli,
      budget: opts.budget,
      overBudget: items.length > opts.budget,
      gainMin: gains.length ? Math.min(...gains) : 0,
      gainP50: q(gains, 0.5),
      gainMax: gains.length ? Math.max(...gains) : 0,
      profileP50: q(profiles, 0.5),
      profileMax: profiles.length ? Math.max(...profiles) : 0,
    },
  };
}

/**
 * Build the one instanced draw call the scatter turns into.
 *
 * `sizeScale` multiplies item size and nothing else — not the count, not the
 * placement, not the colour. That separation is the point of it: it is a
 * substitution control for "is this invisible because it is small, or because
 * it is not here", and a knob that also moved the count would answer neither.
 */
export function buildLitterMesh(items: LitterInstance[], sizeScale = 1): THREE.InstancedMesh | null {
  if (!items.length) return null;
  const geo = litterGeometry();
  const mat = litterMaterial();
  const im = new THREE.InstancedMesh(geo, mat, items.length);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const yawQ = new THREE.Quaternion();
  const tiltQ = new THREE.Quaternion();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    p.set(it.x, it.y, it.z);
    yawQ.setFromAxisAngle(up, it.yaw);
    axis.set(Math.cos(it.tiltDir), 0, Math.sin(it.tiltDir));
    tiltQ.setFromAxisAngle(axis, it.tilt);
    q.copy(tiltQ).multiply(yawQ);
    // Y is not scaled with the long axis: the fold's height is a property of
    // how a leaf curls, not of how long the leaf is, and scaling it uniformly
    // makes the big ones read as folded card.
    const sz = it.size * sizeScale;
    s.set(sz, sz * 0.45, sz * it.broad);
    im.setMatrixAt(i, m.compose(p, q, s));
    im.setColorAt(i, litterColour(it.duff, it.shade, c));
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.name = "veg-litter";
  // Does not cast. Nine thousand 6 cm flakes in the shadow pass, for an
  // occlusion whose largest dimension is well under one shadow texel — the same
  // trade the thatch sprigs and the ground mats already took, and the same
  // reasoning: the shadow cost is real and the shadow is not.
  im.castShadow = false;
  im.receiveShadow = true;
  // Accounts for `instanceMatrix`, unlike the geometry's own sphere. Without
  // this the cull volume is one unscaled flake at the origin and the whole
  // scatter vanishes the moment the camera looks away from world zero.
  im.computeBoundingSphere();
  return im;
}
