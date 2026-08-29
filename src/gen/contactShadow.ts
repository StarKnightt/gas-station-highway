/**
 * Contact occlusion decals - the ambient darkening where an object meets the
 * ground.
 *
 * WHY THIS IS NOT THE SHADOW MAP'S JOB
 *
 * A shadow map answers "does the sun reach this pixel". At a 6.2 degree sun
 * elevation almost the entire footprint of anything in this scene is already
 * inside its own long shadow, so the sun term carries no information about
 * contact at all - it is saturated. What is missing is the *ambient* term: the
 * sky is a hemisphere, and a surface 20 mm from a car sill can see almost none
 * of it. That occlusion is what the eye reads as weight, and nothing in a
 * standard forward renderer computes it.
 *
 * This is why a reviewer can look at a correctly shadowed scene and still say
 * every object is "placed rather than weighted". It is not a shadow bug and no
 * amount of shadow tuning fixes it.
 *
 * WHAT MAKES ONE OF THESE READ AS CONTACT RATHER THAN AS A SMUDGE
 *
 * The falloff length has to come from the gap, not from the object's size. Sky
 * occlusion at distance d from an occluder standing h off the ground falls off
 * over a length of roughly h - close to the contact line it is nearly total, and
 * a few gap-heights away it is negligible. So a wheel that touches the ground
 * gets a small, near-black core, and a body panel floating 150 mm up gets a
 * wide, weak wash. Giving both the same radius is what produces the airbrushed
 * grey oval that reads as a decal rather than as contact.
 *
 * Shared deliberately: `PumpSystem` has a TODO for the cabinet skid, and the
 * bollards and canopy column bases want the same treatment. Pass your own
 * primitives rather than copying this file.
 */
import * as THREE from "three";

/**
 * One occluding element, in the same world XZ frame the caller will place the
 * mesh in.
 *
 * `gap` is the load-bearing number: the height the occluder floats above the
 * ground, in metres. Zero means it touches. It sets both how dark the core gets
 * and how far the darkening reaches, because both of those are consequences of
 * how much sky the ground can still see.
 */
export type Occluder = {
  x: number;
  z: number;
  /** Half extent along X. Use equal half extents for a disc. */
  hx: number;
  /** Half extent along Z. */
  hz: number;
  /** Metres this element floats above grade. 0 = touching. */
  gap: number;
  /** Multiplier on the darkening, for elements that occlude less than a solid. */
  weight?: number;
};

export type ContactShadowOpts = {
  occluders: Occluder[];
  /** Ground height at a world XZ. Sample the real surface; do not assume flat. */
  groundY: (x: number, z: number) => number;
  /** Metres above grade to float the decal, to stay out of the road's z-fight. */
  lift?: number;
  /** Grid cells across the longer axis. */
  res?: number;
  /**
   * Peak occlusion at a hard contact line, as a FRACTION OF THE HEMISPHERE the
   * ground can no longer see. Geometric, so it does not depend on how bright the
   * sky is - a 10 mm gap hides the same solid angle at any exposure.
   */
  strength?: number;
  /**
   * `scene.environmentIntensity`, live, read from the scene by the caller.
   *
   * REQUIRED, AND DELIBERATELY NOT DEFAULTED. This decal removes ambient light,
   * so how dark it must be drawn depends on how much ambient there is - see the
   * derivation at STRENGTH_ENV_REFERENCE. A default here would let two adopting
   * systems inherit a hidden borrowing, which is the whole defect this parameter
   * exists to prevent. Pass `scene.environmentIntensity` rather than a copy of
   * whatever Lighting's default is today, because a copy goes stale the next time
   * that default moves and nothing says so.
   */
  environmentIntensity: number;
};

/**
 * The `strength` above was authored and pixel-verified against this environment
 * intensity, and it is the reference the live value is scaled against.
 *
 * WHY THIS COUPLING EXISTS - the constant stood in for a quantity it did not own
 *
 * The decal is an unlit black quad under normal alpha blending, so it resolves to
 * `background * (1 - alpha)`: **it darkens the TOTAL of sun plus ambient, while
 * the quantity it stands in for is occluded AMBIENT alone.** Those two agree only
 * at a fixed ambient share, and the ambient share is not fixed - Lighting moved
 * `scene.environmentIntensity` 1.0 -> 2.4 and sun 5.6 -> 4.4 in one change, so
 * ambient went from a small fraction of the frame to a large one and this decal
 * did not move. It was authored against the old share and silently mismeasured
 * the new one.
 *
 * This is Canopy's soffit bug in a second system, and the rule that finds it is
 * **ask what physical quantity your constant stands in for.** The control built
 * into that rule is worth stating, because it stops the rule being applied
 * everywhere: a lamp emissive is CORRECTLY constant, because a lamp does not dim
 * when the sky brightens. An occlusion term is not, because occlusion is a
 * fraction OF something, and this decal's blending makes it a fraction of a total
 * that the environment sets.
 *
 * Note carefully what is and is not environment-dependent here. `strength` is
 * geometric and stays fixed. The *level it is drawn at* is not, and that is the
 * derived value. Coupling the geometric term itself would have been the same
 * error in the opposite direction.
 */
const STRENGTH_ENV_REFERENCE = 1.0;

/**
 * CEILING ON THE DERIVED ALPHA, AND IT IS DERIVED RATHER THAN CHOSEN.
 *
 * This was 0.94, an aesthetic number, and it sat above the bound its own
 * derivation implies. The reasoning that fixes it is in the note above: the linear
 * environment scaling is a first-order approximation to **the ambient share of the
 * light incident at that point**. Occlusion removes sky, not sun. So
 *
 *     alpha = occlusion * ambientShare,   ambientShare <= 1
 *
 * and therefore **alpha can never exceed the occlusion itself**. A fraction cannot
 * be larger than the thing it is a fraction of. At environment 2.4 the raw
 * derivation reached 1.872 and was being clamped to 0.94 - still above the 0.78
 * the geometry actually blocks, so the decal was removing more light than the
 * underbody obstructs.
 *
 * Taking the ceiling from `strength` gives the clamp a meaning it did not have:
 * `clamped: true` now says "the ambient share has saturated, and raising the
 * environment further cannot deepen contact, because the geometry only blocks so
 * much sky." That is a statement about the scene rather than about a constant, and
 * it answers the question of what happens if Lighting raises the environment -
 * nothing, correctly.
 *
 * The raw value is still reported, or the saturation would be invisible.
 */
const levelCeiling = (occlusion: number) => occlusion;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Sky occlusion from a single element, as a function of horizontal distance.
 *
 * `d` is distance outside the element's footprint, so 0 is directly beneath its
 * edge. The falloff length is the gap plus a floor, because an element that
 * genuinely touches would otherwise give a zero-width shadow - a tyre's contact
 * patch is finite because the tyre deforms and because the ground is not a
 * plane.
 */
function occlusionAt(d: number, gap: number): number {
  const reach = Math.max(0.045, gap * 1.6);
  const t = clamp01(1 - d / reach);
  // Squared, not linear. Sky occlusion is an integral over a solid angle that
  // shrinks faster than distance; a linear ramp gives the flat-edged oval that
  // reads as an airbrushed blob.
  const shaped = t * t;
  // A gap wide enough to see sky through cannot be dark at its core either, so
  // the peak falls off with the gap as well as the reach growing.
  const core = 1 / (1 + gap / 0.10);
  return shaped * core;
}

/**
 * Build the decal. Returns null when there is nothing to draw, so a caller with
 * no occluders does not add an empty mesh to the scene - `probe-unseen` would
 * correctly flag that as a mesh drawing zero pixels.
 */
export function makeContactShadow(opts: ContactShadowOpts): {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /**
   * What was borrowed and what was derived from it.
   *
   * Published rather than kept internal so the borrowing is visible in the
   * caller's own report. The failure this prevents is not a wrong number, it is
   * an invisible dependency: the previous version of this file consumed a
   * scene-wide quantity through a baked constant and said so only in a comment,
   * so nothing downstream could tell that Lighting moving the environment had
   * invalidated it. Print these in your system report.
   */
  report: {
    /** The live `scene.environmentIntensity` this build consumed. */
    environmentIntensity: number;
    /** What `strength` was authored against. */
    environmentReference: number;
    /** The geometric occlusion fraction, which is environment-independent. */
    occlusion: number;
    /** Derived peak alpha before clamping - watch this cross `levelCeiling`. */
    levelRaw: number;
    /** Derived peak alpha as drawn. */
    level: number;
    /** True when the clamp bound, i.e. the linear scaling has saturated. */
    clamped: boolean;
    /** Derived ceiling on the alpha, equal to the geometric occlusion. */
    levelCeiling: number;
    /** Resolution the caller asked for. */
    resRequested: number;
    /** Resolution a single uniform grid would have needed, for comparison. */
    uniformResNeeded: number;
    /**
     * Resolution actually used. Raised above the request when the falloff was
     * under-resolved, because at that point `res` is not a performance choice.
     */
    resUsed: number;
    /**
     * Cells across the tightest falloff. **Below about 4 the decal's quality is
     * governed by grid alignment rather than fineness, and is therefore not
     * monotone in `res`** - Canopy measured 0.96 at 16, 0.73 at 20, 0.70 at 24 and
     * 0.95 at 32. Watch this rather than `res`.
     */
    cellsPerReach: number;
    /**
     * True when the triangle budget bound before the falloff was resolved, i.e.
     * `cellsPerReach` is below target and the decal is alignment-sensitive near
     * its tightest occluder. Reported rather than hidden: see RES_MAX.
     */
    underResolved: boolean;
    /** Triangles in the merged decal. Watch this, not `res`. */
    triangles: number;
  };
} | null {
  const { occluders, groundY } = opts;
  const lift = opts.lift ?? 0.008;
  const res = Math.max(8, Math.floor(opts.res ?? 72));
  const strength = opts.strength ?? 0.78;

  /*
   * Reject rather than default. A silent fallback here would reproduce exactly
   * the defect this parameter was added to remove, in the two systems now
   * adopting this file - and it would look like it was working.
   */
  const env = opts.environmentIntensity;
  if (!Number.isFinite(env) || env < 0) {
    throw new Error(
      `makeContactShadow: environmentIntensity is ${env}. Pass the live ` +
        `scene.environmentIntensity; this decal's alpha is derived from it ` +
        `because the decal removes ambient and the ambient share is not fixed.`
    );
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error(`makeContactShadow: strength must be an occlusion fraction in 0..1, got ${strength}`);
  }
  const levelRaw = (strength * env) / STRENGTH_ENV_REFERENCE;
  const level = Math.min(levelCeiling(strength), levelRaw);

  if (!occluders.length) return null;

  // Region to cover: every occluder's footprint plus its own reach, so the grid
  // is derived from the falloff rather than from a guessed margin.
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const o of occluders) {
    if (![o.x, o.z, o.hx, o.hz, o.gap].every(Number.isFinite)) {
      throw new Error("makeContactShadow: non-finite occluder - refusing to build");
    }
    const reach = Math.max(0.045, o.gap * 1.6);
    x0 = Math.min(x0, o.x - o.hx - reach);
    x1 = Math.max(x1, o.x + o.hx + reach);
    z0 = Math.min(z0, o.z - o.hz - reach);
    z1 = Math.max(z1, o.z + o.hz + reach);
  }

  const spanX = x1 - x0;
  const spanZ = z1 - z0;

  /**
   * RAISE `res` UNTIL THE FALLOFF IS RESOLVED, RATHER THAN TRUSTING THE CALLER.
   *
   * Canopy adopted this file for its column feet and measured decal quality
   * against `res`: **0.96 at 16, 0.73 at 20, 0.70 at 24, 0.95 at 32.** Not
   * monotone, so the natural response to a soft decal - raise the resolution -
   * makes it worse about half the time.
   *
   * The mechanism: the occlusion peak sits exactly at the occluder's footprint
   * edge and decays over `reach`. Alpha is evaluated at VERTICES and linearly
   * interpolated across each cell, so whether the core reads at full strength
   * depends on whether a grid line happens to land near that edge. It is an
   * ALIGNMENT condition masquerading as a resolution one, and alignment is not
   * monotone in `res` - which is why the numbers look random.
   *
   * Aligning the grid to the edges cannot be the fix, because several occluders
   * with different edges cannot all be aligned to one grid. So remove the
   * sensitivity instead: make the cell small enough that the peak is always
   * captured wherever it falls. Sampling a squared ramp needs a handful of cells
   * across it, so the requirement is
   *
   *     cell <= min(reach) / CELLS_PER_REACH
   *
   * and at that point alignment stops mattering and quality IS monotone in `res`.
   *
   * The caller's `res` is treated as a floor, never a ceiling. A number that is
   * too coarse to describe the falloff is not a performance choice, it is a wrong
   * answer, and this is a handful of vertices on one decal.
   */
  const CELLS_PER_REACH = 4;
  let minReach = Infinity;
  for (const o of occluders) minReach = Math.min(minReach, Math.max(0.045, o.gap * 1.6));
  const longSpan = Math.max(spanX, spanZ);
  /**
   * Triangle budget, and it BINDS on the car - so the shortfall is reported.
   *
   * Measured: the car asks for `resNeeded` 430 against a requested 72, because
   * a touching tyre's reach is 45 mm while the grid has to span the whole 5.2 m
   * footprint. 430 is roughly **163,000 triangles, comparable to the entire
   * bodyshell**, for a ground decal. That is not a trade worth making, and a perf
   * pass is actively measuring this scene.
   *
   * So `cellsPerReach` will read below CELLS_PER_REACH and `underResolved` will be
   * true. Both are published rather than hidden.
   *
   * BUT THE CAP WAS THEN MEASURED, AND IT IS NOT COSTING ANYTHING VISIBLE.
   * Three captures of the same poses: 72 -> 430 moved **16,591 pixels**, and
   * 430 -> 160 moved **57**. So the cliff this constant exists to avoid sits
   * somewhere below `cellsPerReach` about 1.5, not at 4 - CELLS_PER_REACH = 4 is
   * over-specified, and 160 buys the whole visible benefit for a seventh of the
   * triangles.
   *
   * The target is left at 4 anyway, because for a small footprint - Canopy's
   * column feet, a bollard, a pump base - it is nearly free and it removes the
   * alignment sensitivity outright. `underResolved: true` on the car should
   * therefore be read as "over-specified target, not met, no visible cost", which
   * is what the numbers above are for.
   *
   * THE STRUCTURAL FIX IS NOT A BIGGER NUMBER. One uniform grid is the wrong
   * structure: the fine resolution is needed only within a few centimetres of the
   * four tyre contact patches, while the underbody occluder at gap 0.155 has a
   * 248 mm reach and is fully resolved at res 84. Per-occluder local grids would
   * give every element its own correct cell size at a fraction of the cost.
   * Whoever needs a sharper contact line should build that rather than raise this.
   */
  const RES_MAX = 160;
  /**
   * What ONE uniform grid would have needed, kept only as the comparison that
   * justifies the per-occluder structure below. On the car this is 430, i.e. about
   * 163,000 triangles, against the ~12,000 the local grids use at better quality.
   */
  const uniformResNeeded = Math.ceil((longSpan * CELLS_PER_REACH) / minReach);

  /**
   * ONE LOCAL GRID PER OCCLUDER, MERGED INTO ONE DRAW CALL.
   *
   * This is the structural fix the comment above used to defer. A single grid
   * spanning everything has to carry the FINEST occluder's cell size across the
   * WIDEST occluder's extent, and those two demands belong to different elements -
   * on the car, a 45 mm tyre reach and a 5.2 m footprint, which multiply out to
   * 163,000 triangles for a ground decal. Nothing needs that: the fine cells are
   * wanted within centimetres of the four contact patches, and the underbody at
   * gap 0.155 has a 248 mm reach that is fully resolved at res 84.
   *
   * So each occluder gets a grid covering its own footprint plus its own reach, at
   * its own correct cell size. Every element is resolved to target, and the total
   * is a fraction of the uniform cost.
   *
   * WHY THE PIECES MAY SAFELY OVERLAP, WHICH IS THE PART THAT MAKES THIS WORK.
   * The material is black at `transparent: true` under normal blending, so each
   * layer resolves to `dst * (1 - a)`. Two overlapping layers therefore give
   * `dst * (1 - a1) * (1 - a2)` - the SAME multiplicative composition the single
   * grid computed analytically in its `open` product, now performed by the
   * blender. Occlusion composes multiplicatively, so this is not an approximation
   * of the old behaviour, it is the identical quantity. Note this would be WRONG
   * under additive blending, where overlaps would saturate to black exactly under
   * the car where it shows most.
   *
   * And no seams: each patch is sized so its own occlusion has decayed to zero at
   * its border, so neighbouring patches meet at zero alpha rather than at an edge.
   *
   * `depthWrite` is already false, so the overlapping layers do not fight, and
   * order does not matter because multiplication commutes.
   */
  const posParts: number[] = [];
  const colParts: number[] = [];
  const idx: number[] = [];
  let vertexBase = 0;
  let resUsedMax = 0;
  let worstCells = Infinity;

  for (const o of occluders) {
    const reach = Math.max(0.045, o.gap * 1.6);
    const px0 = o.x - o.hx - reach;
    const px1 = o.x + o.hx + reach;
    const pz0 = o.z - o.hz - reach;
    const pz1 = o.z + o.hz + reach;
    const pSpanX = px1 - px0;
    const pSpanZ = pz1 - pz0;
    const pLong = Math.max(pSpanX, pSpanZ);

    // This occluder's own requirement, capped only by the global ceiling.
    const pRes = Math.min(RES_MAX, Math.max(2, Math.ceil((pLong * CELLS_PER_REACH) / reach)));
    const pnx = Math.max(2, Math.round((pRes * pSpanX) / pLong));
    const pnz = Math.max(2, Math.round((pRes * pSpanZ) / pLong));
    resUsedMax = Math.max(resUsedMax, pRes);
    worstCells = Math.min(worstCells, (reach * Math.max(pnx, pnz)) / pLong);

    for (let j = 0; j <= pnz; j++) {
      for (let i = 0; i <= pnx; i++) {
        const x = px0 + (pSpanX * i) / pnx;
        const z = pz0 + (pSpanZ * j) / pnz;
        posParts.push(x, groundY(x, z) + lift, z);

        const dx = Math.max(0, Math.abs(x - o.x) - o.hx);
        const dz = Math.max(0, Math.abs(z - o.z) - o.hz);
        const a = occlusionAt(Math.hypot(dx, dz), o.gap) * (o.weight ?? 1);
        // `level`, not `strength`: the geometric occlusion scaled to the live
        // environment. Using `strength` here is what made the decal stale.
        colParts.push(0, 0, 0, clamp01(clamp01(a) * level));
      }
    }

    for (let j = 0; j < pnz; j++) {
      for (let i = 0; i < pnx; i++) {
        const a = vertexBase + j * (pnx + 1) + i;
        const b = a + 1;
        const c = a + (pnx + 1);
        const d = c + 1;
        // Wound so the outward face points up (+Y). Back-face culling makes a
        // reversed decal invisible rather than wrong, which is the single most
        // expensive defect class in this project.
        idx.push(a, c, b, b, c, d);
      }
    }
    vertexBase += (pnx + 1) * (pnz + 1);
  }

  const resUsed = resUsedMax;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(posParts), 3));
  // Four components: three.js reads vertex alpha from a 4-wide colour attribute,
  // which is how the falloff gets into the blend without a texture or a shader.
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colParts), 4));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    vertexColors: true,
    transparent: true,
    // Never write depth. A decal that occludes the tyre it sits under is worse
    // than no decal, and this one is 8 mm off the ground.
    depthWrite: false,
    // Still tested against depth, so the decal cannot show through the car.
    depthTest: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    // Unlit on purpose. This term stands in for lost ambient, so multiplying it
    // by the lighting again would make it vanish in exactly the shaded places
    // where contact most needs reading.
    fog: true,
  });

  return {
    geometry,
    material,
    report: {
      environmentIntensity: env,
      environmentReference: STRENGTH_ENV_REFERENCE,
      occlusion: strength,
      levelRaw,
      level,
      clamped: levelRaw > levelCeiling(strength),
      /** The physical bound: alpha cannot exceed the occlusion it scales. */
      levelCeiling: levelCeiling(strength),
      resRequested: res,
      /** What a single uniform grid would have required. Comparison only. */
      uniformResNeeded,
      resUsed,
      cellsPerReach: +worstCells.toFixed(2),
      underResolved: worstCells < CELLS_PER_REACH - 0.01,
      triangles: idx.length / 3,
    },
  };
}
