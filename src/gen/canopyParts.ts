import * as THREE from "three";
import { ensureAttrs, metreUv, mergeChecked, place, roundedBox } from "./hardsurface";
import { gridSurface, solidColors, sweepProfile } from "./geo";
import { clamp01, fbm, makeRng, smoothstep, valueNoise, worley } from "./noise";
import { ISLAND, ISLANDS, padY } from "../site";

/**
 * Geometry for the forecourt canopy: deck, fascia, soffit, columns, fixtures.
 *
 * Everything here is authored in **world coordinates** except the column
 * assembly, which is authored about its own base so it can be instanced. That
 * split is deliberate: `applyGrime` samples object space, so a mesh built in
 * world coordinates gets a field that is continuous across the whole deck
 * (which is what a real painted surface does), while the four columns share one
 * object space and are phased apart by instance yaw and instance colour
 * instead.
 *
 * ## Where the proportions come from
 *
 * The site plan owns the island (`ISLAND`, `ISLANDS`) and the concrete
 * forecourt (`FORECOURT`, 23.2 x 14.8 m). The canopy is sized outward from
 * those and inward from the slab, so the slab edge stays visible outside the
 * drip line rather than the canopy overhanging bare asphalt:
 *
 *  - **Clear height 4.72 m** over the slab at the datum. US canopies run
 *    4.3-4.9 m clear; below 4.3 a box truck clips it and above 4.9 the deck
 *    stops reading as shelter.
 *  - **Deck depth 0.80 m** from the bottom of the drip lip to the top of the
 *    coping, of which 0.70 m is the fascia band. Inside the 0.6-1.0 m range a
 *    real deck occupies, and thick enough that the band is the silhouette at
 *    distance.
 *  - **13.2 x 13.6 m deck.** The islands are 9.0 m long, so 2.44 m of overhang
 *    past the end bollards; 3.5 m of cantilever past each island in Z, which
 *    puts the drip line 2.9 m clear of the island face — a sedan parked at the
 *    pump is fully under cover, which is the entire functional claim a canopy
 *    makes.
 *  - **Columns on the islands.** This is how small US stations are built: the
 *    island curb *is* the plinth and the bollards *are* the impact protection,
 *    so nothing has to be cut into the paving. It also means this system needs
 *    nothing from Terrain.
 */

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

export const CANOPY = {
  /** Outer face of the fascia, world XZ. Inside FORECOURT on all four sides. */
  minX: -6.6,
  maxX: 6.6,
  minZ: 13.1,
  maxZ: 26.7,

  /** Clear height under the soffit, measured above the slab at the datum. */
  clear: 4.72,
  /** Where the level deck takes its height from. */
  datum: { x: 0, z: 19.9 },

  /** Fascia band height above the soffit plane. */
  fasciaH: 0.7,
  /** Top of the coping above the soffit plane. */
  copingH: 0.752,
  /** How far the drip lip hangs below the soffit plane. */
  dripDrop: 0.05,
  /** How far the soffit is set in from the outer face, i.e. fascia thickness. */
  fasciaT: 0.075,
  /** Inward batter of the outer face over the height of the band. */
  batter: 0.024,

  /** Square clad column, across the flats. */
  colW: 0.46,
  /** Base plinth pad, across the flats. */
  colBaseW: 0.64,
  colBaseH: 0.11,

  /**
   * Column axes. Two per island, inboard of the end bollards at |x| = 4.08.
   *
   * Yaw is restricted to 0 and 180 degrees, which is a correction. It was
   * 0/90/180/270 to get four different object-space grime faces out of one
   * instanced geometry, and that worked — but it also rotated the details that
   * are *keyed to a direction*. A bumper scuff belongs on a face a car can
   * reach and a downpipe boot belongs on one it cannot, and at 90 degrees the
   * scuff ends up looking down the island at the bollards while the boot faces
   * the lane. Two orientations still give two grime faces, which is what the
   * variation was for; four gave two of them to the wrong physics.
   */
  columns: [
    { x: -3.5, z: ISLANDS[0].cz, yaw: 0 },
    { x: 3.5, z: ISLANDS[0].cz, yaw: Math.PI },
    { x: -3.5, z: ISLANDS[1].cz, yaw: Math.PI },
    { x: 3.5, z: ISLANDS[1].cz, yaw: 0 },
  ],

  /** Surface-mounted soffit fixtures: two rows of four, over the islands. */
  fixtureX: [-4.9, -1.65, 1.65, 4.9],
  fixtureZ: [ISLANDS[0].cz, ISLANDS[1].cz],
  /** Housing footprint and how far it hangs below the soffit. */
  fixtureW: 0.64,
  fixtureDrop: 0.115,

  /** Soffit panel module. Battens land on these lines. ~1.65 m bays. */
  panelsX: 8,
  panelsZ: 8,

  /**
   * Resolution of the baked soffit lightmap. 384 over 13.6 m is 35 mm a texel,
   * and everything in the bake — lamp pools, soot plumes, column occlusion — is
   * inherently soft, so there is nothing here that wants more. 576 KB.
   */
  lightmapSize: 384,

  /**
   * UV set the soffit lamp map samples: `uv1`, the same normalised deck
   * coordinates the lightMap uses. Named here rather than written as a literal
   * because two places need to agree about it — the factory that binds it and
   * the probe that asserts it — and a literal in both is not agreement, it is
   * two literals that happen to match today.
   */
  lampMapChannel: 1,
} as const;

/** Top of the finished island cap, matching TerrainSystem and PumpSystem. */
export const islandTop = (x: number, z: number) => padY(x, z) + 0.021 + 0.162;
/** Top of the concrete forecourt slab. */
export const slabTop = (x: number, z: number) => padY(x, z) + 0.021;

export interface CanopyLevels {
  /** World Y of the soffit plane. The deck is level; the ground is not. */
  soffitY: number;
  /** World Y of the top of the coping. */
  copingY: number;
  /** World Y of the roof membrane inside the coping. */
  roofY: number;
  /** World Y of the bottom of the drip lip — the lowest point of the deck. */
  dripY: number;
  /** Authored length of the instanced column shaft. */
  shaftLen: number;
  /** World Y each column shaft starts at. Common to all four. */
  shaftBaseY: number;
  /** Island cap height under each column, in `CANOPY.columns` order. */
  capY: number[];
}

/**
 * Resolve the level deck against the undulating ground once, up front.
 *
 * The deck is a single level plane and the four island caps are not: they span
 * 20 mm here. Rather than give each column its own shaft length — which would
 * cost the instancing — every shaft is authored to one length and starts at the
 * *highest* cap plus a margin, and each column's own base plinth grows to meet
 * it. The assertion below is the part that matters: if the ground is ever
 * retuned far enough that a plinth can no longer reach its shaft, that is a
 * column visibly floating, and it must fail loudly at build time rather than
 * appear in somebody's capture three rounds later.
 */
export function canopyLevels(): CanopyLevels {
  const soffitY = slabTop(CANOPY.datum.x, CANOPY.datum.z) + CANOPY.clear;
  const capY = CANOPY.columns.map((c) => islandTop(c.x, c.z));
  const highest = Math.max(...capY);
  const lowest = Math.min(...capY);
  const shaftBaseY = highest + 0.05;
  const gap = shaftBaseY - (lowest + CANOPY.colBaseH);
  if (gap > 0) {
    throw new Error(
      `canopy: the island caps under the columns span ${((highest - lowest) * 1000).toFixed(0)} mm, ` +
        `which leaves a ${(gap * 1000).toFixed(0)} mm gap between the lowest plinth top and the shaft foot. ` +
        `A shaft that does not reach its plinth is a floating column. Raise CANOPY.colBaseH or give the ` +
        `shafts per-column lengths (and give up the instancing).`
    );
  }
  return {
    soffitY,
    copingY: soffitY + CANOPY.copingH,
    roofY: soffitY + CANOPY.fasciaH,
    dripY: soffitY - CANOPY.dripDrop,
    shaftLen: soffitY - shaftBaseY,
    shaftBaseY,
    capY,
  };
}

/** Lateral inset of the fascia's outer face at height `y` above the soffit. */
function faceLat(y: number): number {
  const t = clamp01(y / CANOPY.fasciaH);
  return CANOPY.batter * t;
}

/* ------------------------------------------------------------------ */
/* the deck: fascia ring, accent band, soffit, roof                     */
/* ------------------------------------------------------------------ */

/**
 * The deck outline as a polyline for `sweepProfile`, in (x, z).
 *
 * Wound the same way TerrainSystem winds its island so that, with `flip: true`,
 * a **positive** profile lateral points *inward*. Getting that backwards turns
 * the fascia inside out, and an inside-out sweep is back-face culled — i.e. it
 * disappears completely rather than looking wrong, which is exactly the class
 * `tools/probe-unseen.mjs` exists to catch.
 */
function deckPath(step = 0.55): THREE.Vector2[] {
  const { minX, maxX, minZ, maxZ } = CANOPY;
  const path: THREE.Vector2[] = [];
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
    for (let i = 0; i < n; i++) path.push(new THREE.Vector2(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n));
  };
  edge(minX, minZ, maxX, minZ);
  edge(maxX, minZ, maxX, maxZ);
  edge(maxX, maxZ, minX, maxZ);
  edge(minX, maxZ, minX, minZ);
  return path;
}

/**
 * The fascia ring: drip lip, battered outer face, coping return.
 *
 * The three details that make a fascia read as sheet metal on a frame rather
 * than as a coloured box:
 *
 *  - **The drip lip.** The band returns under itself 50 mm below the soffit, so
 *    there is a hard shadow line all the way round the deck at the one height a
 *    person standing under it looks at. Water leaves the deck here, which is
 *    why the staining below it is the single most recognisable weathering mark
 *    on a canopy.
 *  - **The batter.** 24 mm of inward lean over 0.70 m. Nothing reads it as
 *    lean; it reads as the band having a consistent falling highlight instead
 *    of one flat value, because the surface normal is no longer exactly
 *    horizontal and this sun is 11 degrees up.
 *  - **The coping return.** The top rolls inward rather than ending on an
 *    arris, so the silhouette against the sky has a soft top edge and a hard
 *    bottom one, which is the asymmetry a photograph shows.
 */
export function buildFascia(lv: CanopyLevels): THREE.BufferGeometry {
  const T = CANOPY.fasciaT;
  const H = CANOPY.fasciaH;
  // Written bottom-to-top, then reversed. `sweepProfile` winds its quads in the
  // direction the profile is traversed, so the natural reading order here comes
  // out inside out — measured, not guessed: `tools/probe-canopy.mjs` reported a
  // geometric normal of +0.999 in Z on the -Z run, i.e. pointing into the deck.
  // An inverted sweep is back-face culled, so it does not look wrong, it simply
  // is not there (NOTES case 33), which is why this is asserted every run
  // rather than left to a capture to reveal.
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(T, 0.0), // inner top of the drip return; the soffit meets here
    new THREE.Vector2(T, -CANOPY.dripDrop), // down the inside of the lip
    new THREE.Vector2(0.014, -CANOPY.dripDrop), // the lip underside, outward
    new THREE.Vector2(0.0, -0.008), // bottom arris of the outer face
    new THREE.Vector2(faceLat(H * 0.72), H * 0.72),
    new THREE.Vector2(faceLat(H), H),
    new THREE.Vector2(faceLat(H) + 0.018, H + 0.028), // coping roll
    new THREE.Vector2(T + 0.004, CANOPY.copingH), // coping top, falling inward
    new THREE.Vector2(T + 0.004, H), // back down inside to roof level
  ].reverse();
  return ensureAttrs(
    sweepProfile(deckPath(), profile, {
      closed: true,
      flip: true,
      baseY: lv.soffitY,
      uvMetres: 1,
    })
  );
}

/**
 * The painted accent stripe on the fascia, standing 6 mm proud.
 *
 * Geometry rather than a decal on the band, for two reasons that both come out
 * of this project's history: a stripe drawn into the fascia map would need a
 * unique 13-metre texture, and a stripe with no relief has no edge highlight,
 * so at the distance this is actually judged from it collapses into the band
 * (the "fine procedural detail does not survive to the screen" note). 6 mm of
 * relief under an 11-degree sun throws a 31 mm shadow along the whole run.
 */
export function buildFasciaStripe(lv: CanopyLevels): THREE.BufferGeometry {
  const y0 = 0.3;
  const y1 = 0.452;
  const proud = 0.006;
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(faceLat(y0), y0),
    new THREE.Vector2(faceLat(y0) - proud, y0 + 0.012),
    new THREE.Vector2(faceLat(y1) - proud, y1 - 0.012),
    new THREE.Vector2(faceLat(y1), y1),
  ].reverse(); // see buildFascia: sweepProfile winds along the profile direction
  return ensureAttrs(
    sweepProfile(deckPath(), profile, {
      closed: true,
      flip: true,
      baseY: lv.soffitY,
      uvMetres: 1,
    })
  );
}

export interface SoffitFieldInput {
  /** Column axes in world XZ. */
  columns: { x: number; z: number }[];
  /** Fixture centres in world XZ. */
  fixtures: { x: number; z: number }[];
}

/**
 * Baked occlusion for the soffit, as a vertex-colour multiplier.
 *
 * There is no ambient occlusion anywhere in this scene and the environment's
 * lower hemisphere is a single constant colour, so a flat soffit lit only by
 * that hemisphere comes out as one value across 178 square metres — the exact
 * "flat band" `tools/framescan.mjs` was written to catch. This supplies the
 * structure the lighting cannot:
 *
 *  - **Columns.** A column standing under the deck blocks most of the ground
 *    bounce for a metre or so around its head. This is the strongest term and
 *    it is the one that tells you the deck is being *held up*.
 *  - **The islands and the dispensers.** A 1.7 m dispenser blocks the sunlit
 *    slab from the soffit above it, so there is a soft dark aisle over each
 *    island.
 *  - **The perimeter, slightly the other way.** Near the drip line the soffit
 *    can see sky at a grazing angle as well as ground, so it is a few percent
 *    brighter, not darker. Getting this backwards is the classic mistake:
 *    an open canopy is not a room, and its edges are its brightest part.
 *  - **Fixture soot.** A ring of heat-baked grime around each fixture.
 *
 * All of it is view-independent geometry-derived occlusion, so it stays correct
 * whatever Lighting does next. Nothing here fakes a *light*.
 */
export function soffitShade(x: number, z: number, input: SoffitFieldInput): number {
  let v = 1.0;

  for (const c of input.columns) {
    // Chebyshev, because the occluder is a square section.
    const d = Math.max(Math.abs(x - c.x), Math.abs(z - c.z));
    v *= 1 - 0.36 * (1 - smoothstep(CANOPY.colW * 0.5, 1.55, d));
  }

  for (const isl of ISLANDS) {
    const dx = Math.max(0, Math.abs(x - isl.cx) - ISLAND.length / 2);
    const dz = Math.max(0, Math.abs(z - isl.cz) - ISLAND.width / 2 - 0.35);
    v *= 1 - 0.15 * (1 - smoothstep(0, 1.7, Math.hypot(dx, dz)));
  }

  for (const f of input.fixtures) {
    const d = Math.hypot(x - f.x, z - f.z);
    // Soot plume: strongest just outside the housing, gone by 0.9 m.
    v *= 1 - 0.16 * smoothstep(CANOPY.fixtureW * 0.5, 0.52, d) * (1 - smoothstep(0.55, 0.95, d));
  }

  const edge = Math.min(x - CANOPY.minX, CANOPY.maxX - x, z - CANOPY.minZ, CANOPY.maxZ - z);
  v *= 1 + 0.06 * (1 - smoothstep(0, 1.3, edge));

  // Low-frequency fading and patched panels, so no two bays are the same value.
  v *= 0.955 + 0.045 * (0.5 + 0.5 * Math.sin(x * 0.44 + 1.3) * Math.cos(z * 0.37 - 0.7));

  return THREE.MathUtils.clamp(v, 0.3, 1.15);
}

/**
 * The soffit: a level panelled plane plus the batten grid that joints it.
 *
 * The battens are real geometry standing 30 mm proud rather than lines in a
 * map. Under a canopy nothing casts a shadow — the sun cannot reach a
 * downward-facing surface at any elevation — so a painted joint line has
 * nothing to make it visible, whereas 30 mm of relief changes the normal and
 * therefore what the surface samples out of the environment. This is the
 * "is there enough angular difference between the surfaces it separates"
 * question from NOTES, answered in geometry.
 */
export function buildSoffit(lv: CanopyLevels, input: SoffitFieldInput): THREE.BufferGeometry {
  const T = CANOPY.fasciaT;
  const x0 = CANOPY.minX + T;
  const x1 = CANOPY.maxX - T;
  const z0 = CANOPY.minZ + T;
  const z1 = CANOPY.maxZ - T;

  // ~0.25 m quads: fine enough to resolve the 1.55 m column falloff and the
  // 0.5 m soot rings without turning a flat plane into a vertex budget.
  const segX = Math.round((x1 - x0) / 0.25);
  const segZ = Math.round((z1 - z0) / 0.25);
  const plane = gridSurface(x0, x1, z0, z1, segX, segZ, () => lv.soffitY, 1);
  const pos = plane.getAttribute("position") as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = soffitShade(pos.getX(i), pos.getZ(i), input);
    col[i * 3] = v;
    col[i * 3 + 1] = v;
    col[i * 3 + 2] = v;
  }
  plane.setAttribute("color", new THREE.BufferAttribute(col, 3));
  ensureAttrs(plane);

  // gridSurface builds an up-facing plane. The soffit is seen from below, so
  // flip the winding and the normals rather than relying on DoubleSide, which
  // would double the shading cost of the largest surface this system owns.
  flipFaces(plane);

  const parts: THREE.BufferGeometry[] = [plane];

  const bw = 0.048;
  const bh = 0.03;
  const by = lv.soffitY - bh / 2;
  for (let i = 0; i <= CANOPY.panelsX; i++) {
    const x = x0 + ((x1 - x0) * i) / CANOPY.panelsX;
    parts.push(solidColors(metreUv(place(new THREE.BoxGeometry(bw, bh, z1 - z0), x, by, (z0 + z1) / 2)), 0.9));
  }
  for (let j = 0; j <= CANOPY.panelsZ; j++) {
    const z = z0 + ((z1 - z0) * j) / CANOPY.panelsZ;
    parts.push(solidColors(metreUv(place(new THREE.BoxGeometry(x1 - x0, bh, bw), (x0 + x1) / 2, by, z)), 0.9));
  }

  const merged = mergeChecked("canopy soffit", parts.map(ensureAttrs));
  setDeckUv1(merged);
  return merged;
}

/**
 * Baked irradiance on the soffit: the lamp pools, and what shades them.
 *
 * WHY THIS EXISTS, measured rather than assumed. Round 2026-08-28T222715Z put
 * the soffit at 40.4% of the frame with a mean luma of 27.9 and a p10..p90 of
 * 13..22 — darker than the highway it stands over, and almost perfectly flat.
 * That is not a material bug. A downward-facing surface cannot be reached by
 * the sun at any elevation, and the lower hemisphere of the environment map is
 * nearly black, so the soffit receives essentially nothing. The critic's note
 * that the scene was missing "the underside bounce that would sit over the
 * island" is the same observation from the other end.
 *
 * The honest fix is light from the fixtures, which at dawn are on. Eight real
 * lights is not available: the scene is already carrying 21, ten of them
 * RectAreaLight, and Lighting owns that decision anyway. So the fixture
 * contribution is baked here and fed in as a `lightMap`, which three adds to
 * irradiance before the BRDF — meaning the grime, the albedo and the batten
 * normals all still read through it, exactly as they would under a real lamp.
 *
 * This is a bake, not an emissive cheat: the values are irradiance, they are
 * keyed to the published fixture positions, and if Lighting later decides to
 * put real lamps up here, `setLightmapIntensity(0)` turns it off in one call
 * with no geometry change.
 *
 * Linear, not sRGB. A lightmap carries irradiance, and tagging it sRGB would
 * put a 2.2 curve on a quantity that has no perceptual encoding — the colour
 * space convention in NOTES, in its less obvious direction.
 */
export function makeSoffitLightmap(input: SoffitFieldInput): THREE.DataTexture {
  const N = CANOPY.lightmapSize;
  const data = new Uint8Array(N * N * 4);
  // Two noise fields over the whole deck: one to make the soot plumes ragged
  // rather than eight identical annuli, one for the fine speckle that keeps a
  // 13 m flat surface from banding where the pools overlap.
  const rng = makeRng(3517);
  const blot = fbm(N, 9, rng, { octaves: 5 });
  const fine = fbm(N, 34, rng, { octaves: 3 });
  const x0 = CANOPY.minX;
  const x1 = CANOPY.maxX;
  const z0 = CANOPY.minZ;
  const z1 = CANOPY.maxZ;

  // Dawn sky bounced off warm sunlit concrete. The lamps' own contribution used
  // to be summed in here and now lives in `makeSoffitLampMap`; see that function
  // for why the two cannot share a map.
  const skyC = [1.0, 0.968, 0.912];

  for (let j = 0; j < N; j++) {
    // +Z runs down the image, so the V axis is flipped relative to the array
    // order. Getting this backwards mirrors the bake about the deck centre,
    // which on a near-symmetric layout looks entirely plausible and is why it
    // is written once, here, rather than at the call site.
    const z = z0 + ((z1 - z0) * (j + 0.5)) / N;
    for (let i = 0; i < N; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / N;

      /*
       * The dominant term, and it is not the lamps.
       *
       * Round 2026-08-28T225430Z raised the bake to 2.2 and the soffit got
       * brighter without getting any more legible: still a flat grey field with
       * eight bright rectangles stuck on it. Turning the knob twice in the same
       * direction was the signal to question the premise. A surface-mounted
       * fitting is a downlight — it throws at the cars, not at the panel it is
       * bolted to — so there was never going to be a pool there to find.
       *
       * What actually lights a canopy underside at dawn is the sky and the
       * sunlit slab, entering under the fascia at a grazing angle. That gives a
       * strong gradient from a bright perimeter to a dim centre, over a couple
       * of metres, on all four sides. It is the structure every photograph of a
       * canopy underside has, and it is the one this bake was missing.
       */
      const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      // Scaled so the brightest texel on the deck lands just under 1.0. The map
      // is 8-bit: anything that clips at the perimeter throws away the top of
      // the gradient that is the whole point of this term. Overall level is
      // `lightMapIntensity`'s job, not this function's.
      //
      // The decay length is long (2.55 m) and the peak modest on purpose. A
      // short, tall falloff put the outer metre of the deck at luma 181 in
      // round 2026-08-28T230003Z and took the batten lines and the grime with
      // it — a blown perimeter carries no more information than a black one.
      const sky = 0.15 + 0.7 * Math.exp(-edge / 2.55);

      /*
       * The lamps' own contribution to the panel, which is small and short. A
       * reflector is not a perfect cutoff, so there is a tight bright collar
       * where the housing meets the soffit and very little beyond it — the
       * thing that reads as "bolted on" rather than "printed on".
       */
      /*
       * Soot. Baked here rather than drawn as an alpha decal on top: a decal
       * is a separate unlit mesh over a lit one, so it would have needed its
       * own copy of this bake to avoid reading as a black blob, and it cost a
       * draw call and 23 000 pixels of transparency to do it.
       *
       * The plume is an annulus — clean directly under the housing where the
       * fitting seals to the panel, dirtiest in the convection ring just
       * outside it, gone by a metre.
       */
      const k = j * N + i;
      let soot = 1;
      for (const f of input.fixtures) {
        // The radius is perturbed by the noise field, so the plume is ragged
        // and each fixture sits on a different part of it. A clean annulus
        // reads as a decal; this reads as a stain.
        const d = Math.hypot(x - f.x, z - f.z) * (0.86 + blot[k] * 0.34);
        const ring = smoothstep(CANOPY.fixtureW * 0.52, 0.62, d) * (1 - smoothstep(0.66, 1.2, d));
        soot *= 1 - 0.38 * ring * (0.55 + fine[k] * 0.75);
      }

      /*
       * What blocks that grazing light: the columns, and the pump islands with
       * their dispensers, which stand between the open edge and the middle of
       * the deck and throw a real soft shadow up onto it.
       */
      let occ = 1;
      for (const c of input.columns) {
        const d = Math.max(Math.abs(x - c.x), Math.abs(z - c.z));
        occ *= 1 - 0.45 * (1 - smoothstep(CANOPY.colW * 0.5, 1.9, d));
      }
      for (const isl of ISLANDS) {
        const dx = Math.max(0, Math.abs(x - isl.cx) - ISLAND.length / 2);
        const dz = Math.max(0, Math.abs(z - isl.cz) - ISLAND.width / 2 - 0.4);
        occ *= 1 - 0.2 * (1 - smoothstep(0, 2.2, Math.hypot(dx, dz)));
      }

      // Ageing: panels do not all reflect the same after fifteen years.
      const patch = 0.955 + 0.045 * Math.sin(x * 0.51 + 2.1) * Math.cos(z * 0.43 - 1.1);

      const shared = occ * soot * patch * (0.97 + fine[k] * 0.06);
      const p = k * 4;
      for (let c = 0; c < 3; c++) {
        data[p + c] = Math.min(255, Math.round(sky * skyC[c] * shared * 255));
      }
      data[p + 3] = 255;
    }
  }

  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  // Clamped, emphatically. The default is repeat, and a lightmap that wraps
  // puts the -X edge's lamp pool on the +X edge.
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The lamps' own contribution to the panel they are bolted to, as an
 * **emissive** map over the same UV set as the sky bake.
 *
 * ## Why this is a second map and not a second term in one map
 *
 * It was one map. Both terms rode `lightMapIntensity`, and that scalar is now
 * proportional to `scene.environmentIntensity`, because the sky bake stands in
 * for a quantity Lighting owns and has to move when Lighting moves it. The lamp
 * term does not: **a lamp does not dim when the sky brightens.** One texture
 * times one scalar cannot express two quantities that scale differently, and
 * the alternative — baking the lamp term pre-divided by the environment so the
 * multiply cancels — is a compensation, which this document already records as
 * a thing that outlives the bug it compensated for and becomes the bug.
 *
 * Two consequences, and both are the point rather than side effects:
 *
 *  - **`setFixtures(false)` now actually turns the lamps off.** Before, it
 *    killed the lens emissive and left eight baked collars glowing on the
 *    soffit. The switch was wired to the thing you look at and not to the light
 *    it makes — a control that half applied, which is the most expensive kind
 *    this project has met.
 *  - **The night-to-dawn transition is now free, and correct.** Nothing has to
 *    animate. As the sky comes up, Lighting raises the environment, the sky bake
 *    rises with it, and the lamp term stays exactly where it is, so the lamps'
 *    *relative* contribution falls on its own. Fixtures still on at dawn is the
 *    characteristic look, and here it is a consequence of two terms scaling
 *    differently rather than of a curve somebody authored.
 *
 * ## What it is and is not
 *
 * Emissive on a lit surface is an approximation: the panel reflects lamp light,
 * it does not emit it, so this misses the albedo multiply and will not darken
 * where the paint is dirtier. The soffit's albedo is near-white and the collar
 * covers about 200 mm around each of eight housings on a 13 x 13 m deck, so the
 * error is small — and it is written down here rather than found later.
 *
 * Soot multiplies this, because a sooty panel beside a lamp does reflect less.
 * Column and island occlusion deliberately does **not**: those block the grazing
 * light coming in from the open edge, and they are nowhere near a collar that
 * sits at the housing itself. Same geometry, different light, different
 * occluders — which is the argument for the split restated at the level of one
 * term.
 *
 * 256 square over 13.6 m is 53 mm a texel against a collar whose half-value
 * radius is 196 mm, so the feature spans roughly seven texels of an inherently
 * soft gradient. 256 KB.
 */
export function makeSoffitLampMap(input: SoffitFieldInput, size = 256): THREE.DataTexture {
  const N = size;
  const data = new Uint8Array(N * N * 4);
  const rng = makeRng(3517);
  const blot = fbm(N, 9, rng, { octaves: 5 });
  const fine = fbm(N, 34, rng, { octaves: 3 });
  const x0 = CANOPY.minX;
  const x1 = CANOPY.maxX;
  const z0 = CANOPY.minZ;
  const z1 = CANOPY.maxZ;
  // Metal halide gone yellow with age, and warmer than the sky term on purpose.
  const lampC = [1.0, 0.9, 0.735];

  for (let j = 0; j < N; j++) {
    // +Z runs down the image. Same convention as the sky bake, and it has to be
    // the same one or the two maps disagree about which end of the deck is which
    // — a mirroring that on a near-symmetric layout looks entirely plausible.
    const z = z0 + ((z1 - z0) * (j + 0.5)) / N;
    for (let i = 0; i < N; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / N;
      const k = j * N + i;

      /*
       * A reflector is not a perfect cutoff, so there is a halo on the panel
       * around each fitting.
       *
       * The falloff was `0.5 / (1 + d2 * 26)`, a half-value radius of 196 mm,
       * and it was measured as contributing +3.4 luma over 23 000 pixels — a
       * change no viewer would find. The reason is geometric and it is worth
       * stating: **the housing is 310 mm to its edge, so a 196 mm collar puts
       * its entire bright core underneath the object that occludes it.** The
       * only part of it that could ever be seen was the far tail.
       *
       * That is the same error as authoring detail below the delivered-pixel
       * floor, in a different currency: energy placed where nothing can look at
       * it. So the half-value radius is now 559 mm, comfortably outside the
       * fitting, and the peak is unchanged because the peak was never visible.
       */
      let collar = 0;
      for (const f of input.fixtures) {
        const d2 = (x - f.x) * (x - f.x) + (z - f.z) * (z - f.z);
        collar += 0.55 / (1 + d2 * 3.2);
      }

      let soot = 1;
      for (const f of input.fixtures) {
        const d = Math.hypot(x - f.x, z - f.z) * (0.86 + blot[k] * 0.34);
        const ring = smoothstep(CANOPY.fixtureW * 0.52, 0.62, d) * (1 - smoothstep(0.66, 1.2, d));
        soot *= 1 - 0.38 * ring * (0.55 + fine[k] * 0.75);
      }

      const p = k * 4;
      for (let c = 0; c < 3; c++) {
        data[p + c] = Math.min(255, Math.round(collar * lampC[c] * soot * 255));
      }
      data[p + 3] = 255;
    }
  }

  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // sRGB, unlike the sky bake next to it. An emissive map is a *colour* that
  // three converts to linear before adding; a lightMap is irradiance and has no
  // perceptual encoding, so it must stay `NoColorSpace`. Two maps, same UVs,
  // same material, opposite correct answers — which is exactly why the
  // convention is to write this line explicitly on every generated texture
  // instead of relying on a default that is right for one of them.
  t.colorSpace = THREE.SRGBColorSpace;
  // Bound here and not at the call site. `emissiveMap` defaults to `uv`, which
  // on the soffit is a *per-metre tiling* set, so the default would repeat eight
  // lamp collars inside every square metre of a 13 m deck — a channel error that
  // presents as a texture error. Setting it in the factory means the texture
  // arrives correctly bound and there is no line a caller can forget.
  t.channel = CANOPY.lampMapChannel;
  t.needsUpdate = true;
  return t;
}

/**
 * Normalised deck coordinates as `uv1`, which is the channel three samples a
 * lightMap with. Computed from world XZ after the merge so the battens — which
 * are boxes and have no natural planar UV — pick up the same bake as the panel
 * they sit on, instead of sampling one texel of it.
 */
function setDeckUv1(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const sx = 1 / (CANOPY.maxX - CANOPY.minX);
  const sz = 1 / (CANOPY.maxZ - CANOPY.minZ);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - CANOPY.minX) * sx;
    uv[i * 2 + 1] = (pos.getZ(i) - CANOPY.minZ) * sz;
  }
  g.setAttribute("uv1", new THREE.BufferAttribute(uv, 2));
}

/** Reverse triangle winding and negate normals, in place. */
function flipFaces(g: THREE.BufferGeometry): void {
  const idx = g.getIndex();
  if (!idx) throw new Error("canopy: flipFaces needs an indexed geometry");
  const a = idx.array as Uint16Array | Uint32Array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  idx.needsUpdate = true;
  const n = g.getAttribute("normal") as THREE.BufferAttribute;
  const na = n.array as Float32Array;
  for (let i = 0; i < na.length; i++) na[i] = -na[i];
  n.needsUpdate = true;
}

/**
 * The roof membrane inside the coping, dished toward each column.
 *
 * A canopy drains through its columns, and this is the half of that story you
 * can see from anywhere high: the deck is not a flat lid, it falls about 55 mm
 * into a sump over each column head. The other half — the stain where the
 * downpipe discharges — is on the column material.
 */
export function buildRoof(lv: CanopyLevels): THREE.BufferGeometry {
  const T = CANOPY.fasciaT + 0.004;
  const x0 = CANOPY.minX + T;
  const x1 = CANOPY.maxX - T;
  const z0 = CANOPY.minZ + T;
  const z1 = CANOPY.maxZ - T;
  const fall = 0.055;
  const h = (x: number, z: number) => {
    let sump = 0;
    for (const c of CANOPY.columns) {
      const d2 = (x - c.x) ** 2 + (z - c.z) ** 2;
      sump = Math.max(sump, Math.exp(-d2 / (2 * 2.3 * 2.3)));
    }
    return lv.roofY + fall * (1 - sump);
  };
  return ensureAttrs(gridSurface(x0, x1, z0, z1, 22, 22, h, 1));
}

/* ------------------------------------------------------------------ */
/* drainage                                                            */
/* ------------------------------------------------------------------ */

export interface Scupper {
  name: string;
  /** Mouth centre, world. */
  x: number;
  y: number;
  z: number;
  /** Outward normal of the fascia run it sits in. */
  nx: number;
  nz: number;
}

/**
 * Overflow scuppers: where the water goes when the primary drain does not take
 * it.
 *
 * A deck this size — 13.2 by 13.6 m, 180 square metres — sheds a great deal of
 * water, and the primary route is internal: a gutter behind the fascia falls to
 * a sump over each column and drops down a pipe inside the column to a boot at
 * the foot. None of that is visible, which is exactly why a canopy needs the
 * *secondary* route modelled instead. Every real deck has overflow scuppers
 * through the fascia at gutter level, because a blocked internal drain would
 * otherwise pond water on the deck until the deck came down, and code requires
 * a path that cannot block.
 *
 * They are worth building for a reason that has nothing to do with drainage:
 * the scupper is the **origin of the single most recognisable weathering mark on
 * a canopy**. Streaks below a fascia are not evenly distributed — they start
 * somewhere, and where they start is here. A uniform streak field is the
 * giveaway that the dirt was authored rather than deposited.
 *
 * Mouth height is set from the roof down, not from the soffit up, because a
 * scupper is at gutter level by definition and the gutter is at the roof. Every
 * dimension below is absolute: a 100 mm pipe and a 140 by 75 mm mouth are what
 * the fittings come in, and they do not change if the band gets deeper.
 */
export function scupperPlan(lv: CanopyLevels): Scupper[] {
  const out: Scupper[] = [];
  // Mouth sill 90 mm below the roof surface, which is where a gutter's overflow
  // sits: high enough that it only runs in a real event, low enough that the
  // water cannot reach the deck structure.
  const y = lv.roofY - 0.09;
  const runs: { nx: number; nz: number; along: "x" | "z"; at: number }[] = [
    { nx: 0, nz: -1, along: "x", at: CANOPY.minZ },
    { nx: 0, nz: 1, along: "x", at: CANOPY.maxZ },
  ];
  // One each side of each column bay, on the two long runs only. The end runs
  // (+-X) get none: the gutter falls toward the columns, which are inboard of
  // the ends, so there is nothing to overflow there. Drainage that is the same
  // on all four sides is drainage that was decorated rather than routed.
  for (const run of runs) {
    for (const c of CANOPY.columns) {
      if (Math.abs(c.z - run.at) > 6.9) continue;
      out.push({
        name: `canopy-scupper-${out.length + 1}`,
        x: c.x,
        y,
        z: run.at,
        nx: run.nx,
        nz: run.nz,
      });
    }
  }
  return out;
}

/**
 * The scupper mouths themselves: a short sleeve through the fascia with a
 * turned-down lip, so the water leaves clear of the band instead of running
 * back under it.
 *
 * Merged into the fixture-housing mesh by the system, since it is the same dark
 * painted metal — so this costs triangles and no draw call.
 */
export function buildScuppers(scuppers: Scupper[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of scuppers) {
    const out = 0.052; // how far the sleeve stands out of the band
    const cx = s.x + s.nx * out * 0.5;
    const cz = s.z + s.nz * out * 0.5;
    const alongX = s.nx === 0;
    const w = alongX ? 0.14 : out;
    const d = alongX ? out : 0.14;
    // The sleeve.
    parts.push(metreUv(place(roundedBox(w, 0.075, d, 0.008, 1), cx, s.y, cz)));
    // The drip lip under it, standing a little further out and wider, which is
    // the part that decides where the streak starts.
    const lipX = s.x + s.nx * (out + 0.014);
    const lipZ = s.z + s.nz * (out + 0.014);
    parts.push(
      metreUv(
        place(
          roundedBox(alongX ? 0.176 : 0.028, 0.02, alongX ? 0.028 : 0.176, 0.006, 1),
          lipX,
          s.y - 0.046,
          lipZ
        )
      )
    );
  }
  return mergeChecked("canopy scuppers", parts.map(ensureAttrs));
}

/**
 * The stain quads that hang below each scupper.
 *
 * Quads with an alpha texture rather than vertex colours on the fascia, and the
 * reason is a resolution argument rather than a preference: `deckPath` steps
 * every 550 mm, so the fascia carries one vertex ring every 550 mm and a stain
 * that fans from 80 to 350 mm cannot be represented in its vertices at all — it
 * would either vanish or land as a single-vertex spike. Raising the sweep's
 * density enough to hold it would triple the fascia's triangle count to carry a
 * mark that four small quads carry exactly.
 *
 * They stand 4 mm off the band, which is enough to lose the depth fight without
 * being enough to see as a separate object.
 */
export function buildOverflowStains(lv: CanopyLevels, scuppers: Scupper[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const STANDOFF = 0.004;
  for (const s of scuppers) {
    // Top of the stain at the lip, bottom just past the drip so it reads as
    // leaving the deck rather than stopping short of it.
    const yTop = s.y - 0.052;
    const yBot = lv.dripY - 0.01;
    const hw = 0.23;

    /**
     * Corners in world space rather than a rotated and translated
     * `PlaneGeometry`, because the standoff has to be measured **per vertex**
     * against a face that leans.
     *
     * The first version offset the whole quad by 4 mm from the face at the
     * stain's own mid-height, which is a perfectly reasonable-looking line of
     * code and is wrong: the fascia batters 24 mm over its height, so a plane
     * parallel to the *nominal* plane cuts through the real one. It came out
     * 4.5 mm buried at the bottom, and `probe-canopy` caught it before a
     * capture existed — which matters, because a decal buried behind the
     * surface it is marking is invisible rather than misplaced (NOTES case 33),
     * and it is the identical failure to the car's fog lamps sitting 8 mm
     * inside solid bodywork.
     *
     * Resolved by giving the quad the same 1.96-degree lean as the band, so the
     * standoff is a constant 4 mm everywhere instead of an average.
     */
    const lat = (y: number) => STANDOFF - CANOPY.batter * clamp01((y - lv.soffitY) / CANOPY.fasciaH);
    // Along-run unit vector, perpendicular to the outward normal in XZ.
    const ax = -s.nz;
    const az = s.nx;
    const at = (u: number, y: number): [number, number, number] => [
      s.x + ax * u + s.nx * lat(y),
      y,
      s.z + az * u + s.nz * lat(y),
    ];

    const a = at(-hw, yBot);
    const b = at(hw, yBot);
    const c = at(hw, yTop);
    const d = at(-hw, yTop);
    const pos = new Float32Array([...a, ...c, ...b, ...a, ...d, ...c]);
    const uv = new Float32Array([0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1]);
    const nrm = new Float32Array(18);
    for (let i = 0; i < 6; i++) {
      nrm[i * 3] = s.nx;
      nrm[i * 3 + 1] = 0;
      nrm[i * 3 + 2] = s.nz;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    parts.push(ensureAttrs(g));
  }
  return mergeChecked("canopy overflow stains", parts);
}

/* ------------------------------------------------------------------ */
/* columns                                                             */
/* ------------------------------------------------------------------ */

export interface ColumnGeometry {
  /** Shaft, mid-height cladding joint, cap flashing and drainage boot. */
  shaft: THREE.BufferGeometry;
  /** Plinth pad and collar, authored from the island cap upward. */
  base: THREE.BufferGeometry;
}

/**
 * One column, authored about its own foot at the origin so it can be instanced.
 *
 * Four copies of one extrusion is what a real canopy has, so instancing is not
 * a compromise here — but `applyGrime` samples object space, which means four
 * instances of one mesh get byte-identical dirt in identical places, and NOTES
 * case 22 is unambiguous that this is what makes a set read as instanced.
 * Two things break it up without spending a second geometry:
 *
 *  - **Instance yaw at 0/90/180/270 degrees.** The section is four-fold
 *    symmetric, so the silhouette is unchanged, but object -Z now faces a
 *    different world direction on each column — so the streak that runs down
 *    one column's visible face is a different streak on its neighbour. This is
 *    the one case where rotating an instance *does* do something, precisely
 *    because the grime lookup is in object space and the viewer is not.
 *  - **`instanceColor`.** A few percent of hue and value between columns:
 *    touched-up paint, different batches. Value alone reads as one object under
 *    different exposure (NOTES), so the hue moves too.
 *
 * The drainage boot rides the yaw, which is honest — each column drains to its
 * own boot and an installer sets them where the run goes.
 */
export function buildColumn(lv: CanopyLevels): ColumnGeometry {
  const W = CANOPY.colW;
  const L = lv.shaftLen;

  const shaftParts: THREE.BufferGeometry[] = [
    // The clad shaft. Rounded arrises: a square column with mathematically
    // sharp corners has no highlight down its edge, and the edge is the only
    // part of a column a low sun ever lights brightly.
    metreUv(place(roundedBox(W, L, W, 0.016, 2), 0, L / 2, 0)),
    // Cladding sheets meet about 2/5 up, with a pressed cover strip.
    metreUv(place(roundedBox(W + 0.022, 0.05, W + 0.022, 0.008, 1), 0, L * 0.42, 0)),
    // Flashing collar where the shaft dies into the soffit.
    metreUv(place(roundedBox(W + 0.075, 0.055, W + 0.075, 0.01, 1), 0, L - 0.027, 0)),
    // Drainage boot: the internal downpipe's cleanout, on the +X face.
    //
    // On +X and not -Z, and that swap is the point. Object +-X faces run *along*
    // the island toward the pumps and the bollards, so nothing ever drives at
    // them; object +-Z faces a drive lane on both islands. A downpipe boot goes
    // where a car cannot hit it and the scuffs go where cars can, so the two
    // details want opposite faces, and with instance yaw restricted to 0 and
    // 180 degrees (see `CANOPY.columns`) both stay on the correct side of the
    // column for all four copies.
    metreUv(place(roundedBox(0.075, 0.34, 0.17, 0.012, 1), W / 2 + 0.034, 0.31, 0)),
    // Its cleanout cap, which is the bit that catches the light.
    metreUv(place(roundedBox(0.09, 0.032, 0.19, 0.008, 1), W / 2 + 0.034, 0.49, 0)),
    // The discharge shoe. The pipe has to end somewhere and where it ends is
    // the detail that makes the drainage a route rather than a decoration: a
    // turned-out spout 140 mm above the plinth, which is the clearance a fitter
    // leaves so the outlet cannot silt up. Absolute, like everything else here.
    metreUv(place(roundedBox(0.13, 0.115, 0.145, 0.01, 1), W / 2 + 0.062, 0.145, 0)),
  ];

  const baseParts: THREE.BufferGeometry[] = [
    // Plinth pad on the island cap.
    metreUv(place(roundedBox(CANOPY.colBaseW, 0.045, CANOPY.colBaseW, 0.008, 1), 0, 0.0225, 0)),
    // Cast collar, slightly narrower, taking the shaft.
    metreUv(place(roundedBox(W + 0.09, 0.07, W + 0.09, 0.012, 1), 0, 0.075, 0)),
  ];

  return {
    shaft: mergeChecked("canopy column shaft", shaftParts.map(ensureAttrs)),
    base: mergeChecked("canopy column base", baseParts.map(ensureAttrs)),
  };
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

export interface FixturePlan {
  name: string;
  x: number;
  z: number;
}

export function fixturePlan(): FixturePlan[] {
  const out: FixturePlan[] = [];
  CANOPY.fixtureZ.forEach((z, r) => {
    CANOPY.fixtureX.forEach((x, c) => {
      out.push({ name: `canopy-fixture-${r + 1}${c + 1}`, x, z });
    });
  });
  return out;
}

export interface FixtureGeometry {
  housings: THREE.BufferGeometry;
  lenses: THREE.BufferGeometry;
}

/**
 * Surface-mounted soffit fixtures. The soot they leave is baked into the soffit
 * lightmap rather than drawn here; see `makeSoffitLightmap`.
 *
 * Surface-mounted rather than recessed, on the argument that a recess is a hole
 * in the soffit and nothing in this project cuts holes — a "recessed" tray
 * drawn *above* an unbroken soffit plane is the exact defect
 * `tools/probe-unseen.mjs` reports as OCCLUDED, which is to say a part that is
 * present, in spec, and draws nothing.
 *
 * Each lens gets its own UV phase into the shared lens map, so the eight of
 * them do not carry the same eight dead insects in the same eight places.
 */
export function buildFixtures(lv: CanopyLevels, plan: FixturePlan[]): FixtureGeometry {
  const W = CANOPY.fixtureW;
  const D = CANOPY.fixtureDrop;
  const housings: THREE.BufferGeometry[] = [];
  const lenses: THREE.BufferGeometry[] = [];

  plan.forEach((f, i) => {
    housings.push(metreUv(place(roundedBox(W, D, W, 0.018, 2), f.x, lv.soffitY - D / 2, f.z)));

    // Drop lens, standing 6 mm below the housing rim so its edge catches light
    // from the side rather than being a flush rectangle.
    const lens = new THREE.BoxGeometry(W - 0.09, 0.02, W - 0.09);
    const uv = lens.getAttribute("uv") as THREE.BufferAttribute;
    const ua = uv.array as Float32Array;
    const ox = ((i * 0.37) % 1) * 4;
    const oz = ((i * 0.61) % 1) * 4;
    for (let k = 0; k < ua.length; k += 2) {
      ua[k] += ox;
      ua[k + 1] += oz;
    }
    uv.needsUpdate = true;
    lenses.push(ensureAttrs(place(lens, f.x, lv.soffitY - D - 0.004, f.z)));

  });

  return {
    housings: mergeChecked("canopy fixture housings", housings.map(ensureAttrs)),
    lenses: mergeChecked("canopy fixture lenses", lenses.map(ensureAttrs)),
  };
}

/* ------------------------------------------------------------------ */
/* signage geometry                                                    */
/* ------------------------------------------------------------------ */

export interface SignPlacement {
  name: string;
  /** Which artwork region. */
  kind: "logo" | "price" | "plate";
  /** Centre of the sign face, world. */
  x: number;
  y: number;
  z: number;
  /** Outward normal. */
  nx: number;
  nz: number;
  /** Face size, metres. */
  w: number;
  h: number;
}

/**
 * Where the signage goes, and — as much to the point — where it does not.
 *
 * The four fascia runs each carry a logo panel, because a branded canopy is
 * branded on every side; that is four quads and it costs nothing to be right
 * about. The price panel goes on the -Z run only, which is the run that faces
 * the highway. A price sign on the side of the canopy that faces the building
 * is advertising to the stockroom.
 *
 * The column plates go on the object -X face, i.e. the face opposite the
 * downpipe boot, looking along the island. That is the face somebody standing
 * at a dispenser is looking at, and it is the only signage in this system read
 * from two metres rather than twenty — which is why its type is sized
 * separately and much smaller.
 */
export function signPlan(
  lv: CanopyLevels,
  panels: { logo: { w: number; h: number }; price: { w: number; h: number }; plate: { w: number; h: number } }
): SignPlacement[] {
  const out: SignPlacement[] = [];
  // Vertical centre of the fascia band. The panel is 560 mm in a 700 mm band,
  // so it is centred with 70 mm of band showing above and below — a fixed
  // reveal in millimetres, not a fraction, so the band could be redrawn to
  // 800 mm and the sign would stay the size a sign shop made it.
  const yMid = lv.soffitY + CANOPY.fasciaH / 2;

  // Standoff, resolved against the battered face at the band's mid-height so
  // the panel clears the band rather than the nominal plane. See
  // `buildOverflowStains` for why that distinction matters.
  const lat = 0.035 - CANOPY.batter * 0.5;

  const runs: { nx: number; nz: number; at: number }[] = [
    { nx: 0, nz: -1, at: CANOPY.minZ },
    { nx: 0, nz: 1, at: CANOPY.maxZ },
  ];
  for (const r of runs) {
    // The logo sits off centre on the road-facing run to leave the price panel
    // its own space, and dead centre on the other three.
    const shift = r.nz < 0 ? -1.55 : 0;
    out.push({
      name: `canopy-sign-logo-z${r.nz < 0 ? "min" : "max"}`,
      kind: "logo",
      x: shift,
      y: yMid,
      z: r.at + r.nz * lat,
      nx: 0,
      nz: r.nz,
      w: panels.logo.w,
      h: panels.logo.h,
    });
  }
  for (const nx of [-1, 1]) {
    out.push({
      name: `canopy-sign-logo-x${nx < 0 ? "min" : "max"}`,
      kind: "logo",
      x: (nx < 0 ? CANOPY.minX : CANOPY.maxX) + nx * lat,
      y: yMid,
      z: (CANOPY.minZ + CANOPY.maxZ) / 2,
      nx,
      nz: 0,
      w: panels.logo.w,
      h: panels.logo.h,
    });
  }
  out.push({
    name: "canopy-sign-price",
    kind: "price",
    x: 3.35,
    y: yMid,
    z: CANOPY.minZ - lat,
    nx: 0,
    nz: -1,
    w: panels.price.w,
    h: panels.price.h,
  });

  CANOPY.columns.forEach((c, i) => {
    // Object -X after yaw. At yaw 0 that is world -X; at 180 it is world +X.
    const s = c.yaw === 0 ? -1 : 1;
    out.push({
      name: `canopy-sign-plate-${i + 1}`,
      kind: "plate",
      x: c.x + s * (CANOPY.colW / 2 + 0.012),
      // 1.55 m to the plate centre: eye height for somebody standing at a
      // dispenser, and set from the island cap under this column rather than
      // from the deck, because that is the surface the person is standing on.
      y: lv.capY[i] + 1.55,
      z: c.z,
      nx: s,
      nz: 0,
      w: panels.plate.w,
      h: panels.plate.h,
    });
  });
  return out;
}

/**
 * The sign faces: one quad each, UV-mapped into its region of the atlas.
 *
 * UVs are written explicitly rather than by scaling `PlaneGeometry`'s, because
 * a plane's default UVs run 0..1 with v increasing upward while an atlas is
 * indexed from the top, and getting that wrong flips the artwork — which reads
 * as a texture problem and is a UV problem.
 */
export function buildSignFaces(
  plan: SignPlacement[],
  uvOf: (kind: "logo" | "price" | "plate") => [number, number, number, number]
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const p of plan) {
    const g = new THREE.PlaneGeometry(p.w, p.h, 1, 1);
    const [u0, v0, u1, v1] = uvOf(p.kind);
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    const a = uv.array as Float32Array;
    for (let k = 0; k < a.length; k += 2) {
      a[k] = u0 + a[k] * (u1 - u0);
      a[k + 1] = v0 + a[k + 1] * (v1 - v0);
    }
    uv.needsUpdate = true;
    if (p.nz < 0) g.rotateY(Math.PI);
    else if (p.nx > 0) g.rotateY(Math.PI / 2);
    else if (p.nx < 0) g.rotateY(-Math.PI / 2);
    g.translate(p.x, p.y, p.z);
    parts.push(ensureAttrs(g));
  }
  return mergeChecked("canopy sign faces", parts);
}

/**
 * The cabinets behind the faces.
 *
 * A sign that is a printed rectangle on a wall reads as a printed rectangle on
 * a wall. What makes it an object is the return: a dark border all round and a
 * shadow under the top edge, which under an 11-degree sun a 53 mm deep box
 * throws across the band. The border is 40 mm on every side — absolute, so the
 * price panel and the much smaller column plate get the same physical extrusion
 * an aluminium tray section actually has.
 *
 * The column plates get no cabinet: a 360 mm plate is screwed flat to the
 * cladding, it is not a light box.
 */
export function buildSignCabinets(plan: SignPlacement[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const B = 0.04;
  const D = 0.053;
  for (const p of plan) {
    if (p.kind === "plate") continue;
    // Sits 2 mm behind the face and runs back D, so the face is proud of the
    // cabinet front rather than coplanar with it. Coplanar is a depth fight.
    const back = -0.002 - D / 2;
    const g = roundedBox(
      p.nx === 0 ? p.w + B * 2 : D,
      p.h + B * 2,
      p.nx === 0 ? D : p.w + B * 2,
      0.006,
      1
    );
    parts.push(metreUv(place(g, p.x + p.nx * back, p.y, p.z + p.nz * back)));
  }
  return mergeChecked("canopy sign cabinets", parts.map(ensureAttrs));
}

/* ------------------------------------------------------------------ */
/* two small maps                                                      */
/* ------------------------------------------------------------------ */

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // Explicit, always. The default is NoColorSpace, so a colour map that forgets
  // this renders too bright — the same mistake as tagging a linear value sRGB,
  // in the other direction. See the colour-space convention in NOTES.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The lens: prismatic acrylic, yellowed at the edges, with insect debris.
 *
 * Used as both `map` and `emissiveMap`, which is the point — a lit lens is not
 * a white rectangle with dirt drawn on it. The dead insects are opaque whether
 * the tube is on or off, so they read as silhouettes against the light, which
 * is how you actually see them.
 */
export function makeLensMap(size = 256, seed = 2411): THREE.DataTexture {
  const rng = makeRng(seed);
  const prism = valueNoise(size, 3, rng);
  const bugs = worley(size, 14, rng);
  const bugPick = valueNoise(size, 14, rng);
  const grime = fbm(size, 7, rng, { octaves: 4 });

  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const u = i / (size - 1);
      const v = j / (size - 1);
      // Prismatic ribs, 24 across the lens, running one way.
      const rib = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 24);
      // Yellowing and dust concentrate at the gasket line.
      const edge = 1 - smoothstep(0.0, 0.16, Math.min(u, v, 1 - u, 1 - v));

      let lum = 0.80 + rib * 0.16 + prism[k] * 0.06;
      lum *= 1 - edge * 0.32;
      lum *= 1 - clamp01(grime[k] - 0.45) * 0.5;

      // A dead insect is a small dark opaque blob, not a smudge.
      const bug = (1 - smoothstep(0.0, 0.06, bugs[k])) * smoothstep(0.72, 0.86, bugPick[k]);
      lum *= 1 - bug * 0.86;

      const warm = 1 - edge * 0.1;
      d[k * 4] = Math.round(clamp01(lum) * 255);
      d[k * 4 + 1] = Math.round(clamp01(lum * (0.985 - edge * 0.06)) * 255);
      d[k * 4 + 2] = Math.round(clamp01(lum * (0.94 - edge * 0.22) * warm) * 255);
      d[k * 4 + 3] = 255;
    }
  }
  return dataTexture(d, size, true);
}

