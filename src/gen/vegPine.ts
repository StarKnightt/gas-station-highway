/**
 * Procedural roadside pine for System 6.
 *
 * The target is not a Christmas tree. A pine that has spent forty years on the
 * edge of a US highway lot is scrappy: the lower third has self-pruned to bare
 * grey stubs, the live crown is lopsided because one side got the light and the
 * other got the building, whorls are irregularly spaced, and the leader has
 * been knocked over at least once. A perfect cone is the single loudest "this
 * is CG" signal a tree can give, so every symmetry here is deliberately broken.
 *
 * Output is in local space with the butt at the origin and +Y up. The woody
 * parts come back as one merged geometry (trunk + branches + stubs) so a whole
 * stand of trees can be a single draw call; the foliage comes back as a list of
 * instance transforms for a shared cross-card geometry.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, lerp, seededRng, type Rng } from "./noise";

export interface PineSpec {
  seed: number;
  /** Total height in metres, butt to leader. */
  height: number;
  /** Radius at the butt, metres. Defaults to a plausible taper for the height. */
  buttRadius?: number;
  /** Overall lean of the stem, radians off vertical. */
  lean?: number;
  /** Compass direction of the lean, radians. */
  leanDir?: number;
  /** Fraction of the height below which branches are dead. */
  deadBelow?: number;
  /** 0..1. Low values thin the crown out and shorten the branches. */
  vigour?: number;
  /**
   * Foliage cards per branch, scaled. Distant trees get fewer, larger cards:
   * the crown silhouette is all that survives at 100 m, so paying for interior
   * cards there is pure waste.
   */
  cardDensity?: number;
  /**
   * Linear scale on shoot-card size. Count rises as 1/this, so the crown holds
   * its coverage and only the granularity changes. 1 restores the size that a
   * critic measured as cardboard; see the note at the card loop.
   */
  cardSize?: number;
}

export interface FoliageCard {
  /** Local-space placement. +X runs along the branch, card is unit sized. */
  matrix: THREE.Matrix4;
  /** Multiplied into the card albedo, so no two sprays are the same green. */
  tint: THREE.Color;
  /** Dead sprays use the browned-out card texture. */
  dead: boolean;
}

export interface PineBuild {
  wood: THREE.BufferGeometry;
  cards: FoliageCard[];
  /** Widest live-crown radius, for placement spacing and bounding spheres. */
  crownRadius: number;
  height: number;
  /**
   * Trunk radius at breast height (1.3 m), in metres.
   *
   * Published so a collision blocker can be a bole rather than a guess, and
   * returned rather than left for the consumer to recompute: the taper here is
   * a root flare times a fractional-power curve, and a second copy of that
   * arithmetic elsewhere is a second thing to keep in step with this one.
   */
  trunkRadius: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ */
/* generic swept tube                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sweep a circular section of varying radius along a polyline. Written here
 * rather than using `TubeGeometry` because we need world-metre UVs (so one
 * bark texture serves a 0.4 m branch and a 0.5 m trunk at the same scale) and
 * a per-ring radius wobble.
 */
export function sweepTube(
  pts: THREE.Vector3[],
  radii: number[],
  radial: number,
  uvMetres: number,
  wobble: (station: number, angle: number) => number,
  capTop: boolean
): THREE.BufferGeometry {
  const n = pts.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const tangent = new THREE.Vector3();
  const nx = new THREE.Vector3();
  const nz = new THREE.Vector3();
  let arc = 0;

  for (let i = 0; i < n; i++) {
    if (i === 0) tangent.subVectors(pts[1], pts[0]);
    else if (i === n - 1) tangent.subVectors(pts[n - 1], pts[n - 2]);
    else tangent.subVectors(pts[i + 1], pts[i - 1]);
    tangent.normalize();
    if (i > 0) arc += pts[i].distanceTo(pts[i - 1]);

    // Any stable frame will do; the section is circular.
    const ref = Math.abs(tangent.y) > 0.94 ? new THREE.Vector3(1, 0, 0) : UP;
    nx.crossVectors(ref, tangent).normalize();
    nz.crossVectors(tangent, nx).normalize();

    const circ = 2 * Math.PI * radii[i];
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r = radii[i] * (1 + wobble(i, a));
      pos.push(
        pts[i].x + nx.x * ca * r + nz.x * sa * r,
        pts[i].y + nx.y * ca * r + nz.y * sa * r,
        pts[i].z + nx.z * ca * r + nz.z * sa * r
      );
      nor.push(nx.x * ca + nz.x * sa, nx.y * ca + nz.y * sa, nx.z * ca + nz.z * sa);
      uv.push(((k / radial) * Math.max(circ, 0.05)) / uvMetres, arc / uvMetres);
    }
  }

  const ring = radial + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k;
      const b = a + 1;
      const c = a + ring;
      const d = c + 1;
      // WINDING. This was `(a, c, b), (b, c, d)` and that is inside out, for
      // every path direction, since the tube was written. The frame is
      // right-handed with `nx x nz = tangent`, and the ring is parametrised by
      // increasing angle, so `(c - a)` is along `+tangent` and `(b - a)` is
      // along `+angle`. The geometric normal of `(a, c, b)` is therefore
      // `tangent x nz`, which expands to `-nx` — exactly opposite the outward
      // radial this loop writes into the `normal` attribute two blocks up.
      //
      // Measured, not derived: 24 of every 30 triangles reversed — the walls,
      // with the end cap correct — in all six path directions tested.
      //
      // **Why it survived, and this is the part worth keeping.** Two separate
      // maskings, which is why neither the renderer nor a critic ever named it:
      //
      //  - `buildPine` calls `wood.computeVertexNormals()` after assembly, which
      //    overwrites the outward normals with ones derived from this winding.
      //    That makes geometry and shading *agree*, so every consistency check
      //    passes and the scene-wide audit reported `veg-pine-wood` at 0.0%
      //    reversed. It agreed on the wrong value: the normals came out pointing
      //    into the trunk, so every trunk and branch was lit inside out, and
      //    front-face culling drew the far wall of each tube rather than the
      //    near one.
      //  - The props do not recompute, so they carried the raw disagreement, and
      //    `timberMat` is FrontSide. Car's `probe-unseen` caught one of the four
      //    as WINDING and could only recover 1 px of 540 triangles, because
      //    framed to fit a six-pole line every insulator is sub-pixel — so the
      //    strongest available pixel evidence for a scene-wide geometry bug was
      //    a single pixel.
      //
      // A per-triangle CPU audit has none of that trouble and is exact:
      // `tools/_vegwind-entry.ts` for the builder, `auditWinding()` in
      // `tools/_vegscale-entry.ts` for the assembled scene.
      idx.push(a, b, c, b, d, c);
    }
  }

  if (capTop) {
    const base = pos.length / 3;
    const p = pts[n - 1];
    pos.push(p.x, p.y, p.z);
    nor.push(tangent.x, tangent.y, tangent.z);
    uv.push(0.5, arc / uvMetres);
    const first = (n - 1) * ring;
    for (let k = 0; k < radial; k++) idx.push(base, first + k, first + k + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ------------------------------------------------------------------ */
/* the tree                                                            */
/* ------------------------------------------------------------------ */

export function buildPine(spec: PineSpec): PineBuild {
  const {
    seed,
    height: H,
    buttRadius = H * 0.0108 + 0.028,
    lean = 0.03,
    leanDir = 0,
    deadBelow = 0.34,
    vigour = 0.85,
    cardDensity = 1,
    cardSize = 0.72,
  } = spec;

  const rng = seededRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const cards: FoliageCard[] = [];
  let crownRadius = 0;

  // Some of these trees have lost their leader — snapped out by wind or ice, or
  // killed by a beetle — and the crown above the break is a bare stub with a
  // couple of laterals turning up to replace it. A perfectly intact leader
  // tapering to a single fine point on every tree is the other half of the
  // monkey-puzzle read: real stands have a mixture.
  const brokenTop = rng() < 0.45;
  const topT = brokenTop ? 0.86 + rng() * 0.08 : 1.0;

  const leanX = Math.cos(leanDir);
  const leanZ = Math.sin(leanDir);
  // A second, weaker bend at right angles, so the stem is not planar. Trees
  // bent in exactly one plane read as extruded rather than grown.
  const swayDir = leanDir + Math.PI / 2 + (rng() - 0.5);
  const swayAmp = (rng() - 0.5) * 0.035;

  /** Centre of the stem at height fraction t. */
  const axis = (t: number): THREE.Vector3 => {
    const o = Math.tan(lean) * H * Math.pow(t, 1.55);
    const s = swayAmp * H * Math.sin(t * 2.4 + 0.6);
    return new THREE.Vector3(
      leanX * o + Math.cos(swayDir) * s,
      t * H,
      leanZ * o + Math.sin(swayDir) * s
    );
  };

  /* ---------------- trunk ---------------- */
  const NS = 22;
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= NS; i++) {
    const t = (i / NS) * topT;
    pts.push(axis(t));
    // Root flare in the first 40 cm, then a normal conifer taper that runs out
    // to a fine leader. Pow 0.62 rather than a straight line: a linear taper
    // makes the mid-trunk read too thin and the whole tree look like a mast.
    const flare = 1 + 0.8 * Math.exp((-t * H) / 0.4);
    const taper = Math.pow(Math.max(0, 1 - t), 0.62);
    // A broken leader ends in a blunt snapped stub, not a needle point.
    const blunt = brokenTop && i === NS ? Math.max(0.018, buttRadius * 0.22) : 0;
    radii.push(Math.max(0.008, buttRadius * taper * flare + 0.006, blunt));
  }
  parts.push(
    sweepTube(
      pts,
      radii,
      9,
      0.42,
      (station, angle) =>
        0.055 * Math.sin(angle * 3 + station * 0.7 + seed) +
        0.035 * Math.sin(angle * 7 - station * 1.3) +
        (station < 3 ? 0.12 * Math.sin(angle * 5 + 1.1) * (3 - station) * 0.33 : 0),
      true
    )
  );

  /* ---------------- whorls ---------------- */
  // Irregular vertical spacing: real internodes vary with the season that grew
  // them, and evenly stacked whorls are the second loudest CG tell after a
  // symmetric crown.
  const whorls: number[] = [];
  {
    let t = 0.11 + rng() * 0.04;
    while (t < topT - 0.015) {
      whorls.push(t);
      t += (0.026 + rng() * 0.028) * lerp(1.4, 0.6, t);
    }
  }

  // One azimuth gets the light and grows long; the opposite side is suppressed.
  //
  // This was `0.3 + rng() * 0.45`, which is a light bias running 0.25 to 1.75 —
  // a **7:1** ratio between the favoured and the starved side of the same tree.
  // An independent critic, working from frames only, logged the result as "the
  // tall right-hand pine's foliage sits only on one side of the trunk, with a
  // hard vertical cut down the trunk line". It read as a culling bug. It was
  // this constant: at 7:1 the starved side's branches fall through to the 14 cm
  // floor below, so half the crown is stubs and the trunk is naked down one
  // face. Real crown asymmetry from one-sided light is perhaps 1.2:1 to 1.7:1
  // and shows as a lean in the crown's centre of mass, not as a bare hemisphere.
  const bestAz = rng() * Math.PI * 2;
  const asymmetry = 0.1 + rng() * 0.16;

  // A band of the crown that has thinned out. Every roadside pine has one:
  // limbs shaded out by the whorls above, or torn off by something tall going
  // past. Without it the crown is a continuous cone of foliage from bottom to
  // top, which — with regular whorls — is the Norfolk Island pine silhouette a
  // critic correctly identified. The band is placed in the lower-middle crown,
  // where suppression actually happens.
  const thinLo = lerp(deadBelow + 0.04, 0.55, rng());
  const thinHi = thinLo + 0.10 + rng() * 0.16;
  const thinDepth = 0.35 + rng() * 0.28;
  const inThin = (t: number) => t > thinLo && t < thinHi;

  // Azimuth by golden angle rather than by even division of the circle.
  // Dividing 2*pi by the branch count put every whorl's limbs on a regular
  // radial star, and since successive whorls are only a few centimetres apart
  // the stars stack into the horizontal rings that read as a monkey puzzle.
  // The golden angle never repeats, so no two whorls line up.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  let azWalk = rng() * Math.PI * 2;

  for (const t of whorls) {
    const live = t > deadBelow + (rng() - 0.5) * 0.1;
    // Per-whorl vigour. The crown profile is a smooth function of height, so
    // without this every whorl at a given height gets the same nominal size and
    // the tree stacks into equal discs — the "radially symmetric whorls at
    // regular vertical intervals, each roughly the same size" read. A tree grows
    // one whorl per year and the years are not equal: a drought year leaves a
    // short internode carrying short branches, and it stays visible for decades.
    const whorlVigour = 0.62 + rng() * 0.66;
    let count = live ? 5 + Math.floor(rng() * 4.0) : 2 + Math.floor(rng() * 2.4);
    if (inThin(t)) count = Math.max(1, Math.round(count * (1 - thinDepth)));

    for (let b = 0; b < count; b++) {
      azWalk += GOLDEN * (0.8 + rng() * 0.4);
      const az = azWalk;
      // Scatter each limb vertically off its nominal whorl, by +-35 cm. A real
      // whorl is not a plane — it occupies a good fraction of an internode, and
      // there are interwhorl branches between them. Measured with
      // tools/vegpine.mjs: at +-11 cm the detrended vertical autocorrelation of
      // the crown still peaked at 0.30 with the peak pinned at the 20 cm lag,
      // i.e. the limbs were still clustering into planes.
      const tb = clamp01(t + ((rng() - 0.5) * 0.7) / H);
      const base = axis(tb);
      // Crown profile: widest around a third of the way up, tapering to the
      // leader. Not a straight-sided cone.
      const profile = Math.sin(Math.pow(clamp01((1 - t) / 0.92), 0.72) * Math.PI * 0.62);
      const lightBias = 1 + asymmetry * Math.cos(az - bestAz);
      // Crown radius on a real pine runs 15-25% of the height. The first pass
      // used 30% as the *coefficient* before the light bias and the random
      // spread, which let branches reach two thirds of the tree's height and
      // turned the crown into a set of fronds.
      // Crown radius on a real pine runs 15-25% of the height. 0.155 as the
      // coefficient *before* the profile, the light bias and the random spread
      // meant the average branch came out at about 12%, and a 13 m tree with a
      // 1.6 m crown starting halfway up is a stick with tufts on it — which is
      // exactly what the captures showed. 0.20 puts the widest part of the crown
      // at a bit over a fifth of the height, which is a pine.
      // A hard `Math.min` here was a flat spot in the silhouette, not a safety
      // rail. Measured over the ten site pines it bound on only 1.0% of all
      // branches — but on **9.0% of the long branches that actually define the
      // outline**, and every one of those came out at exactly 0.340 H. A clamp
      // that binds on the tail is a ruler laid along the edge of the crown,
      // which is part of what reads as "flat quadrilateral patches with
      // straight edges". Saturate smoothly instead: the cap is still a cap, but
      // it is approached rather than hit, so no two branches share a length.
      const CAP = H * 0.36;
      const raw = H * 0.2 * profile * whorlVigour * lightBias * (0.6 + rng() * 0.7) * lerp(0.6, 1, vigour);
      let len = CAP * (1 - Math.exp(-raw / CAP));
      // Dead lower branches are still branches. Cutting them to 40% and then
      // turning 42% of what was left into stubs removed the entire lower crown,
      // and the bare trunk that left behind was most of the "stick" read.
      if (!live) len *= 0.58 + rng() * 0.36;
      if (inThin(t)) len *= 1 - thinDepth * 0.7;
      // A proportion of branches are snapped-off stubs, whatever their height.
      // In the thinned band most of what is left is a stub, which is what gives
      // the crown the bare dead spikes the silhouette needs.
      const stub = rng() < (inThin(t) ? 0.55 : live ? 0.1 : 0.24);
      if (stub) len *= 0.14 + rng() * 0.16;
      len = Math.max(0.14, len);
      if (live && !stub) crownRadius = Math.max(crownRadius, len * 0.92);

      // Lower branches droop under years of snow; upper ones sweep up toward
      // the leader.
      const rise = lerp(-0.3, 0.6, Math.pow(t, 1.25)) + (rng() - 0.5) * 0.28;
      const droop = live && !stub ? lerp(0.38, 0.04, t) : 0.1;

      const NB = stub ? 3 : 6;
      const bp: THREE.Vector3[] = [];
      const br: number[] = [];
      const r0 = Math.max(0.011, len * 0.052 + 0.008);
      const dirX = Math.cos(az);
      const dirZ = Math.sin(az);
      // Slight sideways curl so branches are not radial spokes.
      const curl = (rng() - 0.5) * 0.55;
      for (let i = 0; i <= NB; i++) {
        const s = i / NB;
        const out = len * s;
        const ang = az + curl * s * s;
        bp.push(
          new THREE.Vector3(
            base.x + Math.cos(ang) * out,
            base.y + rise * out - droop * out * s * s,
            base.z + Math.sin(ang) * out
          )
        );
        br.push(Math.max(0.005, r0 * Math.pow(1 - s, 0.75) + 0.004));
      }
      void dirX;
      void dirZ;
      parts.push(
        sweepTube(bp, br, 5, 0.24, (st, a) => 0.09 * Math.sin(a * 3 + st * 1.7 + seed * 0.3), true)
      );

      if (stub) continue;

      /* -------- foliage cards along the outer two thirds -------- */
      // A card is one *shoot*, 25-45 cm long, not a whole branch's worth of
      // foliage. The first version scaled the card by the branch length, which
      // produced metre-and-a-half fronds: the needles in the texture then read
      // at 20 cm each and the tree came out as a palm. Card size is therefore
      // an absolute range now, and the branch length only decides how many.
      // Card size scales with the tree, which the first version did not do, and
      // the mid-storey saplings exposed it immediately. 0.26-0.55 m is right for
      // a 13 m pine's shoots; on a 2.6 m sapling it makes every card a fifth of
      // the whole tree, and the crown magnified as a stack of flat tan shingles
      // — a thatched roof, not foliage. The exponent is below one so an 8 m tree
      // is not scaled down as hard as the ratio alone would suggest: shoot length
      // varies much less between trees than height does.
      //
      // Reduced from 0.26-0.55 by `cardSize`, default 0.72. A critic measured
      // the crowns as "40-60 px hard-edged wood-brown quads reading as
      // cardboard", and that measurement is arithmetically consistent with
      // these numbers: a 0.55 m card on a pine 30 m from a 1600 px camera at
      // 46 degrees is 35 px, and the nearer pines are larger. At that size the
      // needle detail in the texture is one to two pixels and filters away to a
      // slab, so what the eye is given is the card's own rectangle with a
      // feathered rim — which is the definition of the complaint.
      //
      // The fix is more cards, smaller, not a better texture: the texture is
      // already needle-shaped and border-clean (`makePineShoot`), it is simply
      // not being resolved. `step` follows card size, so the count rises
      // automatically as 1/cardSize and the crown stays as full as it was; the
      // silhouette complexity then comes from the gaps *between* cards, which
      // are real geometry, rather than from alpha inside one.
      //
      // Not free, and the cost is reported: at 0.72 the count rises ~1.39x, so
      // roughly 8972 -> 12500 cards at 6 triangles each.
      const cardScale = Math.min(1.25, Math.max(0.3, Math.pow(H / 13, 0.7))) * cardSize;
      const CARD_MIN = 0.26 * cardScale;
      const CARD_MAX = 0.55 * cardScale;
      const spanFrom = 0.12;
      // Spacing follows card size, so a small tree gets many small shoots rather
      // than a few small ones with gaps between.
      const step = Math.max(0.03, (CARD_MIN + CARD_MAX) * 0.5 * 0.28);
      const nCards = Math.max(
        3,
        Math.round(((len * (1 - spanFrom)) / step) * cardDensity * lerp(0.6, 1.2, vigour))
      );
      for (let c = 0; c < nCards; c++) {
        const s = lerp(spanFrom, 1.0, (c + 0.25 + rng() * 0.5) / nCards);
        const i0 = Math.min(NB - 1, Math.floor(s * NB));
        const p = bp[i0].clone().lerp(bp[i0 + 1], s * NB - i0);
        const fwd = new THREE.Vector3().subVectors(bp[Math.min(NB, i0 + 1)], bp[i0]).normalize();
        // Sprays fan out sideways and hang a little below the branch, so give
        // each card its own direction rather than pinning it to the axis.
        fwd.y -= 0.1 + rng() * 0.3;
        const sideAxis = new THREE.Vector3(-fwd.z, 0, fwd.x).normalize();
        fwd.addScaledVector(sideAxis, (rng() - 0.5) * 1.1).normalize();

        const size = lerp(CARD_MIN, CARD_MAX, rng() * rng() + 0.15) * (live ? 1 : 0.72) * lerp(0.8, 1.15, vigour);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), fwd);
        // Roll about the shoot so successive cards in a cluster do not line up.
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rng() * Math.PI * 2));

        const m = new THREE.Matrix4().compose(
          // Offset off the branch axis, and pulled back so the card's root is
          // buried in the wood instead of hanging off the end of it.
          p
            .clone()
            .addScaledVector(fwd, -size * 0.3)
            .addScaledVector(sideAxis, (rng() - 0.5) * size * 0.95)
            .setY(p.y + (rng() - 0.5) * size * 0.75),
          q,
          new THREE.Vector3(size, size, size)
        );

        // Older foliage low in the crown is duller and yellower; new growth at
        // the top is bluer and darker.
        const age = clamp01(1 - t) * 0.8 + rng() * 0.3;
        // Baked crown occlusion. A card tucked in against the trunk, or low in
        // the crown under everything above it, sees almost no sky; without
        // this the whole crown lights uniformly and reads as one flat khaki
        // mass instead of as a volume. There is no cheaper way to get it —
        // the shadow map cannot resolve inside a 2 m crown.
        const ao = lerp(0.34, 1.0, Math.pow(s, 0.8)) * lerp(0.6, 1.0, Math.pow(t, 0.7));
        const tint = new THREE.Color().setRGB(
          lerp(0.86, 1.14, age) * lerp(0.9, 1.06, rng()) * ao,
          lerp(0.94, 1.02, age) * ao,
          lerp(1.06, 0.82, age) * ao
        );
        cards.push({ matrix: m, tint, dead: !live || rng() < 0.07 });
      }
    }
  }

  /* ---------------- the leader ---------------- */
  // The top 12% of the stem is this season's growth and carries foliage right
  // on the trunk. Without it the tree ends in a bare spike, which is the read
  // a radio mast gives and no pine does.
  {
    // A broken top carries far less: a bare snag with a thin collar of foliage
    // under the break, which is what makes the break read as a break.
    const nTip = Math.max(brokenTop ? 3 : 6, Math.round((brokenTop ? 8 : 22) * cardDensity));
    const tipLo = topT - 0.12;
    for (let i = 0; i < nTip; i++) {
      const t = lerp(tipLo, brokenTop ? topT - 0.03 : topT, rng());
      const p = axis(t);
      const az = rng() * Math.PI * 2;
      const size = lerp(0.16, 0.32, rng()) * lerp(1, 1.25, vigour) * (1 - (t - tipLo) * 3.5);
      const fwd = new THREE.Vector3(Math.cos(az) * 0.85, 0.42 + rng() * 0.4, Math.sin(az) * 0.85).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), fwd);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rng() * Math.PI * 2));
      cards.push({
        matrix: new THREE.Matrix4().compose(p, q, new THREE.Vector3(size, size, size)),
        tint: new THREE.Color().setRGB(0.88, 0.98, 1.08),
        dead: false,
      });
    }
  }

  const wood = mergeGeometries(parts, false);
  if (!wood) throw new Error(`buildPine(seed ${seed}): merge failed for ${parts.length} woody parts`);
  parts.forEach((p) => p.dispose());
  wood.computeVertexNormals();

  const bhT = Math.min(0.9, 1.3 / H);
  const trunkRadius =
    buttRadius * Math.pow(Math.max(0, 1 - bhT), 0.62) * (1 + 0.8 * Math.exp(-1.3 / 0.4));

  return { wood, cards, crownRadius: Math.max(crownRadius, H * 0.08), height: H, trunkRadius };
}

/* ------------------------------------------------------------------ */
/* the foliage card primitive                                          */
/* ------------------------------------------------------------------ */

/**
 * Three quads sharing the +X axis, at 0 / 60 / 120 degrees of roll. A single
 * quad disappears edge-on, and two crossed quads still show a hard X from
 * directly along the branch; three is the cheapest arrangement with no bad
 * viewing angle. Six triangles per foliage instance.
 *
 * The card spans x in 0..1 (root of the shoot to its tip, matching the
 * texture's U) and y in -0.5..0.5.
 */
export function foliageCardGeometry(planes = 3): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  //
  // The planes are tapered, twisted and outward-normalled rather than flat
  // rectangles, and all three cost nothing.
  //
  // The standing complaint is that the crowns read as cardboard. Shrinking the
  // cards (see `cardSize`) addresses how big the cardboard is; it does not
  // address why a card reads as card. Three reasons, in order of how much they
  // give the game away:
  //
  //  - **A flat quad has one normal, so it has one tone.** Whatever the texture
  //    does, the whole card shades as a single facet, and a cluster of them
  //    reads as a stack of shingles. This is the big one at any card size.
  //  - **A rectangle root.** Real shoots are narrow where they leave the twig
  //    and widest a third of the way out; the texture already draws that, so
  //    the quad was carrying alpha-zero corners at the root purely as a place
  //    for filtering to smear.
  //  - **Perfectly planar.** Two triangles from four coplanar corners have no
  //    crease, so there is no self-shading anywhere on the card.
  //
  // So: taper the root to 44% width, push the mid-run corners out of plane in
  // opposite directions to twist the quad (its two triangles then meet at a
  // crease and shade differently), and fan the corner normals outward from the
  // shoot axis instead of giving all four the plane normal. The last is what
  // makes a card shade like something round.
  //
  // Zero extra triangles: still four vertices and two triangles per plane, six
  // triangles per card. The alternative — a midline row to bend the card
  // properly — doubles that, which at 12,269 cards is 74k triangles for one
  // material property, and the twist buys most of the same read.
  const TWIST = 0.13;
  const ROOT_W = 0.44;
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const cy = Math.cos(a);
    const sy = Math.sin(a);
    // The plane's own normal, and the in-plane "up" the corners are offset
    // along. Twisting means displacing corners along the normal.
    const nx = 0;
    const ny = -sy;
    const nz = cy;
    const base = p * 4;
    const corner = (x: number, v: number, twist: number) => {
      pos.push(x + nx * twist, cy * v + ny * twist, sy * v + nz * twist);
      // Fan: at the edges of the card the normal leans away from the plane
      // normal toward the card's own width direction, so one card presents a
      // range of orientations to the sun the way a bundle of needles does.
      const lean = 0.55 * (v > 0 ? 1 : -1);
      const ox = 0;
      const oy = ny + cy * lean;
      const oz = nz + sy * lean;
      const l = Math.hypot(ox, oy, oz) || 1;
      nor.push(ox / l, oy / l, oz / l);
    };
    // Root narrow, tip full, and the two tip corners twisted opposite ways.
    corner(0, -0.5 * ROOT_W, 0);
    corner(1, -0.5, -TWIST);
    corner(1, 0.5, TWIST);
    corner(0, 0.5 * ROOT_W, 0);
    // V stays 0..1 across the full card width at both ends, so the taper crops
    // the texture's margin rather than squashing the needles into it.
    uv.push(0, 0.5 - 0.5 * ROOT_W, 1, 0, 1, 1, 0, 0.5 + 0.5 * ROOT_W);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export { type Rng };
