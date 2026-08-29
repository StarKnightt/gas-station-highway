/**
 * The mid-storey: the layer between grass height and tree height.
 *
 * A critic's note, and it is the kind of absence that is hard to see until it is
 * pointed out: "no vertical layering — grass height and tree height with nothing
 * between. No shrubs, no 1-2 m sagebrush, no dead thistle stalks, no saplings."
 *
 * This matters more than any individual plant's quality, because the mid-storey
 * is what the eye uses to interpolate distance. Between a 40 cm tuft and a 13 m
 * pine there is no intermediate cue, so the pine's apparent size has nothing to
 * be checked against and the site reads as a tabletop with two scales of model on
 * it. Three or four shrubs at chest height fix that for the cost of a few hundred
 * triangles.
 *
 * Two forms here, and a third handled elsewhere:
 *
 *  - **sagebrush** — a woody multi-stemmed base with a grey-green crown of
 *    foliage cards. 0.6-1.5 m. The workhorse: it is the right height, the right
 *    colour for late summer, and it is characteristic of exactly this country.
 *  - **dead thistle** — a bare bolted stalk with a few side branches and a
 *    seed head, 0.9-1.8 m. Almost pure geometry and very cheap. Reads
 *    unmistakably as late season, and being nearly leafless it gives a hard
 *    vertical against the sky at a height nothing else occupies.
 *  - **saplings** are built by `buildPine` at 1.2-2.6 m rather than here, since a
 *    small pine is a small pine and duplicating the generator to make one would
 *    be worse than reusing it.
 *
 * Both forms return their woody geometry and their foliage cards separately, so
 * the system can batch all the wood into one draw call and all the cards into
 * the existing instanced foliage pass.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, lerp, seededRng } from "./noise";

/** Forecourt centre. Tall open-ground planting is kept back from it. */
const FORECOURT: [number, number] = [0, 10];

/**
 * A smooth 0..1 field with a wavelength of tens of metres, used to make species
 * mix and stature properties of the *place* rather than of each plant.
 *
 * Deterministic and stateless on purpose: a plant must not move or change kind
 * between builds, and two different consumers sampling the same point have to
 * agree. Three incommensurate periods so there is no visible repeat across the
 * ~90 m of site.
 */
function patchField(x: number, z: number, phase: number): number {
  return clamp01(
    0.5 +
      0.30 * Math.sin(x * 0.058 + z * 0.031 + phase) +
      0.14 * Math.sin(x * 0.037 - z * 0.091 + phase * 1.7) +
      0.09 * Math.sin(x * 0.153 + z * 0.121 + phase * 0.4)
  );
}

export interface MidCard {
  matrix: THREE.Matrix4;
  tint: THREE.Color;
}

export interface MidBuild {
  wood: THREE.BufferGeometry;
  cards: MidCard[];
  /** Widest radius of the crown, for spacing and for the ground contact decal. */
  radius: number;
}

/**
 * A tapered tube through a polyline. A local copy rather than an import from
 * `vegPine`: that one bakes in bark relief tuned for a 40 cm trunk, and a 12 mm
 * thistle stem does not want any.
 */
function stem(
  pts: THREE.Vector3[],
  radii: number[],
  radial: number,
  rough: number,
  rng: () => number
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    t.copy(pts[Math.min(pts.length - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
    if (t.lengthSq() < 1e-8) t.set(0, 1, 0);
    a.crossVectors(t, up);
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0);
    a.normalize();
    b.crossVectors(t, a).normalize();
    const r = radii[i];
    for (let j = 0; j < radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const rr = r * (1 + rough * (rng() - 0.5));
      pos.push(
        p.x + a.x * Math.cos(ang) * rr + b.x * Math.sin(ang) * rr,
        p.y + a.y * Math.cos(ang) * rr + b.y * Math.sin(ang) * rr,
        p.z + a.z * Math.cos(ang) * rr + b.z * Math.sin(ang) * rr
      );
      // A UV attribute is required even though nothing here needs one: a
      // sapling's wood comes from buildPine, which has UVs, and mergeGeometries
      // refuses a set where some members have the attribute and some do not. It
      // logs and returns null, so the whole mid-storey's wood silently vanished
      // while the foliage cards kept drawing — the geometry existed, the merge
      // dropped it. Exactly the NOTES.md failure mode, and it survived a smoke
      // test that built each plant separately instead of merging them the way
      // the system does. The smoke test now merges.
      uv.push(j / radial, (i / (pts.length - 1)) * 2);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const r0 = i * radial;
      const r1 = (i + 1) * radial;
      idx.push(r0 + j, r1 + j, r1 + j2, r0 + j, r1 + j2, r0 + j2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Sagebrush. Several stems leaving the ground at once and dividing twice, with
 * foliage only on the outer ends — the interior of a real sagebrush is open grey
 * wood, and hiding that under a solid ball of foliage is what makes a procedural
 * shrub read as a green blob.
 */
export function buildSage(seed: number, height = 1.1): MidBuild {
  const rng = seededRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const cards: MidCard[] = [];
  let radius = 0;

  // Old sagebrush is many-stemmed from the base, not single-trunked, and the
  // stems lean out rather than up.
  const nStems = 3 + Math.floor(rng() * 4);
  const baseAz = rng() * Math.PI * 2;

  for (let s = 0; s < nStems; s++) {
    const az = baseAz + (s / nStems) * Math.PI * 2 + (rng() - 0.5) * 0.9;
    const lean = 0.28 + rng() * 0.5;
    const len = height * lerp(0.62, 1.0, rng());
    const r0 = height * lerp(0.016, 0.03, rng());

    const N = 5;
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      // Sagebrush stems curve: out hard at the base, then turning back up.
      const outward = Math.sin(u * 1.25) * lean * len;
      pts.push(new THREE.Vector3(Math.cos(az) * outward, u * len * 0.92, Math.sin(az) * outward));
      radii.push(Math.max(0.004, r0 * Math.pow(1 - u, 0.7) + 0.003));
    }
    parts.push(stem(pts, radii, 4, 0.22, rng));

    const tip = pts[N];
    radius = Math.max(radius, Math.hypot(tip.x, tip.z));

    // Foliage roughly doubled in count and half again in size, and no longer
    // confined to the outer third.
    //
    // The numbers in my own report said this before any reviewer did:
    // 177,690 wood triangles against 23,585 foliage cards across 124 plants.
    // That is an expensive skeleton wearing almost nothing, and a reviewer
    // described the result in the only way it could look — "a handful of thin
    // bare vertical sticks... transparent verticals, not volumetric bushes". A
    // 3 m shrub you can see through is invisible at 40 m no matter how correct
    // its height is, which is why "nothing at 1-4 m" and "124 sites at
    // 0.75-4.1 m" were both true statements about different things.
    // Card size was `height * lerp(0.30, 0.54)`, i.e. **a fraction of the whole
    // plant**, which is the bug. On the 1.92 m sage that `tools/vegscale.mjs`
    // identified as the critic's B8 — 4.6 m from the lens, drawing 87% of the
    // frame and five times the store's apparent height — that is a leaf cluster
    // 58 to 104 cm across. A sagebrush leaf cluster is 5 to 15 cm, so at close
    // range the plant resolved into a handful of enormous smooth blades and read
    // as a palm. This is the same defect the pines had and the same one the
    // critic named twice ("flat quadrilateral patches", "cardboard"): a foliage
    // primitive sized as a fraction of the plant instead of as itself.
    //
    // Now absolute, with a mild size-with-vigour trend, and the count raised to
    // keep the mass the silhouette needs. On a 1.9 m plant this is roughly four
    // times the cards at a third of the size.
    const CARD_M = lerp(0.075, 0.16, Math.min(1, height / 2.2));
    const nCards = 15 + Math.floor(rng() * 13);
    for (let c = 0; c < nCards; c++) {
      const u = lerp(0.34, 1.06, rng());
      const p = new THREE.Vector3(
        Math.cos(az) * Math.sin(u * 1.25) * lean * len,
        u * len * 0.92,
        Math.sin(az) * Math.sin(u * 1.25) * lean * len
      );
      const size = CARD_M * lerp(0.7, 1.45, rng());
      const dir = new THREE.Vector3(
        Math.cos(az) + (rng() - 0.5) * 0.9,
        0.35 + rng() * 0.7,
        Math.sin(az) + (rng() - 0.5) * 0.9
      ).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rng() * Math.PI * 2));
      // Sage is a pale grey-green — much lighter and much less saturated than
      // pine. Reusing the pine shoot texture would read as a small conifer, so
      // the tint has to do the species work.
      const k = lerp(0.9, 1.25, rng());
      cards.push({
        matrix: new THREE.Matrix4().compose(p, q, new THREE.Vector3(size, size, size)),
        tint: new THREE.Color(k * 1.16, k * 1.1, k * 0.86),
      });
      radius = Math.max(radius, Math.hypot(p.x, p.z) + size * 0.4);
    }
  }

  const wood = mergeGeometries(parts, false);
  if (!wood) throw new Error(`buildSage(${seed}): merge failed`);
  parts.forEach((p) => p.dispose());
  return { wood, cards, radius };
}

/**
 * A dead thistle or mullein stalk. One woody stem, a few side branches turning
 * up, and a knot of seed heads. No foliage cards at all: it has been dead since
 * July, which is exactly why it is useful — a leafless vertical at chest to head
 * height is the clearest possible scale cue and costs almost nothing.
 */
export function buildThistle(seed: number, height = 1.3): MidBuild {
  const rng = seededRng(seed);
  const parts: THREE.BufferGeometry[] = [];

  const leanDir = rng() * Math.PI * 2;
  // Dead stalks are rarely plumb; they have had a winter of wind.
  const leanAmt = (0.05 + rng() * 0.22) * height;
  const kink = rng() < 0.35 ? 0.5 + rng() * 0.3 : -1;

  const N = 9;
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  const r0 = height * lerp(0.008, 0.014, rng());
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let bend = Math.pow(u, 1.8) * leanAmt;
    // Some have snapped part way and hang over from the break.
    if (kink > 0 && u > kink) bend += Math.pow((u - kink) / (1 - kink), 1.6) * height * 0.42;
    pts.push(
      new THREE.Vector3(
        Math.cos(leanDir) * bend,
        u * height * (kink > 0 && u > kink ? lerp(1, 0.72, (u - kink) / (1 - kink)) : 1),
        Math.sin(leanDir) * bend
      )
    );
    radii.push(Math.max(0.0025, r0 * Math.pow(1 - u * 0.85, 0.8) + 0.0018));
  }
  parts.push(stem(pts, radii, 5, 0.16, rng));

  // Side branches, alternating up the top half, each turning toward vertical.
  const nBr = 2 + Math.floor(rng() * 4);
  for (let b = 0; b < nBr; b++) {
    const u = lerp(0.42, 0.9, rng());
    const at = pts[Math.min(N, Math.round(u * N))];
    const az = rng() * Math.PI * 2;
    const len = height * lerp(0.12, 0.3, rng());
    const M = 4;
    const bp: THREE.Vector3[] = [];
    const br: number[] = [];
    for (let i = 0; i <= M; i++) {
      const v = i / M;
      bp.push(
        new THREE.Vector3(
          at.x + Math.cos(az) * len * v * (1 - v * 0.35),
          at.y + len * v * (0.4 + v * 0.55),
          at.z + Math.sin(az) * len * v * (1 - v * 0.35)
        )
      );
      br.push(Math.max(0.0018, r0 * 0.5 * Math.pow(1 - v, 0.7) + 0.0014));
    }
    parts.push(stem(bp, br, 4, 0.16, rng));

    // Seed head: a stubby swelling on the end. A sphere would be too tidy, so
    // it is a short very fat taper, which at this size is all that reads.
    const tipP = bp[M];
    const hd = height * lerp(0.022, 0.04, rng());
    parts.push(
      stem(
        [tipP.clone(), tipP.clone().add(new THREE.Vector3(0, hd * 1.6, 0))],
        [hd, hd * 0.35],
        5,
        0.3,
        rng
      )
    );
  }

  const wood = mergeGeometries(parts, false);
  if (!wood) throw new Error(`buildThistle(${seed}): merge failed`);
  parts.forEach((p) => p.dispose());
  return { wood, cards: [], radius: height * 0.2 };
}

/**
 * Where the mid-storey goes.
 *
 * Not scattered: a shrub is a thing you can point at individually, and at three
 * to eight of them across a site the placement of each one is a composition
 * decision rather than a statistical one. The rule is the same as for the scrub —
 * shelter and neglect. Along the fence where nothing mows, in the lee of a pole,
 * in the strip between the pavement edge and the fence that a mower cannot
 * reach, and never on the forecourt.
 */
export interface MidSite {
  x: number;
  z: number;
  kind: "sage" | "thistle" | "sapling";
  height: number;
  seed: number;
}

export function midStoreySites(
  blocked: (x: number, z: number) => boolean,
  seed = 7701,
  /**
   * The fence path, so the mid-storey can run a ribbon along its base.
   *
   * Twelve hand-placed anchors was the previous total, and an independent critic
   * reported flatly that "nothing occupies the 0.5-3 m band". Both were true:
   * the sites existed and reached the screen, and twelve plants scattered around
   * the edge of a 150 x 120 m site is nothing. The lesson is the same one as the
   * scrub's: the count that matters is how many are *in shot*, and the places
   * they belong are the places nobody has been able to reach a mower — which for
   * a mid-storey is overwhelmingly the fence line.
   */
  ribbons: { path: [number, number][]; step: number; off: [number, number] }[] = []
): MidSite[] {
  const rng = seededRng(seed);
  const out: MidSite[] = [];

  // Hand-placed anchors, then jittered. Each is a spot where something would
  // genuinely have been left alone: fence line, lee of a pole, the back corner
  // of the lot, the far shoulder.
  const anchors: [number, number, MidSite["kind"], number][] = [
    [-24.5, 41.0, "sage", patchField(-24.5, 41.0, 41.3)],
    [-11.0, 43.5, "thistle", patchField(-11.0, 43.5, 41.3)],
    [4.0, 44.5, "sage", patchField(4.0, 44.5, 41.3)],
    [19.5, 42.0, "sapling", patchField(19.5, 42.0, 41.3)],
    [30.0, 39.0, "thistle", patchField(30.0, 39.0, 41.3)],
    [-36.5, 24.0, "sage", patchField(-36.5, 24.0, 41.3)],
    [-34.0, -2.5, "thistle", patchField(-34.0, -2.5, 41.3)],
    [42.0, 12.0, "sage", patchField(42.0, 12.0, 41.3)],
    [46.0, 30.0, "sapling", patchField(46.0, 30.0, 41.3)],
    [-19.0, -13.5, "sage", patchField(-19.0, -13.5, 41.3)],
    [8.5, -14.5, "thistle", patchField(8.5, -14.5, 41.3)],
    [26.0, -12.0, "sage", patchField(26.0, -12.0, 41.3)],
  ];

  // A ribbon along the fence. Nothing mows within reach of a wire fence, so
  // this is where a real site grows its waist-high stuff, and it doubles as the
  // scale cue that makes the fence itself readable.
  const HAND_ANCHORS = anchors.length;

  // 35 sites was the previous total and a reviewer still reported, of every
  // frame, that "the planting jumps directly from ankle height to full tree with
  // nothing between". That was not a visibility bug and I should not have gone
  // looking for one: 35 plants under two metres, spread around the rim of a
  // 150 x 120 m site, is a handful of objects each a few pixels tall. The count
  // that reads is the count per metre of the edges the eye actually follows, so
  // the step here is metres apart, not car-lengths apart.
  for (const ribbon of ribbons) {
    for (let seg = 0; seg + 1 < ribbon.path.length; seg++) {
      const [x0, z0] = ribbon.path[seg];
      const [x1, z1] = ribbon.path[seg + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-3) continue;
      const nx = -(z1 - z0) / len;
      const nz = (x1 - x0) / len;
      // Gap-weighted rather than even: a run of three close together and then a
      // clear stretch is what an unmown edge looks like, and a fixed step is the
      // "evenly spaced at a fixed interval" signature that got called out.
      for (let d = ribbon.step * 0.4; d < len; d += ribbon.step * lerp(0.3, 2.1, rng())) {
        const t = d / len;
        const off = lerp(ribbon.off[0], ribbon.off[1], rng()) * (rng() < 0.78 ? 1 : -0.35);
        const x = x0 + (x1 - x0) * t + nx * off + (rng() - 0.5) * 0.7;
        const z = z0 + (z1 - z0) * t + nz * off + (rng() - 0.5) * 0.7;
        if (blocked(x, z)) continue;
        const r = rng();
        // Two low-frequency fields, sampled at the plant, so the *mix* and the
        // *stature* are properties of the place rather than global constants.
        //
        // The complaint was "every shrub is the same species and roughly the
        // same size, spaced at similar intervals, giving a planted-hedge
        // regularity". The spacing was already gap-weighted, so the spacing was
        // not it. The other two were: a fixed 72/23/5 split re-rolled per plant
        // is, by construction, the same mix everywhere at any scale you look —
        // it makes a *statistically uniform* verge, which is precisely what a
        // planting scheme is and what a real verge is not. Real scrub is patchy
        // because the ground is: sage owns one stretch, thistle the next, and a
        // hard year leaves a whole run of stunted plants that stays visible.
        const mixField = patchField(x, z, 0);
        const statureField = patchField(x, z, 41.3);
        // Saplings down from 14% to 5%. `buildPine` costs about 7000 triangles
        // whatever height you ask it for, so ~19 saplings were most of the
        // mid-storey's 177k wood triangles while contributing the thinnest,
        // most see-through silhouettes of the three kinds. Sage and thistle are
        // an order of magnitude cheaper and, with the foliage fix, denser.
        // Sage-dominant, because sage is the only one of the three that is
        // volumetric. A dead thistle stalk is *correctly* a thin vertical, so
        // raising thistle's share while chasing "transparent verticals, not
        // volumetric bushes" would have pushed the wrong way — the mix has to
        // favour the kind that occludes sky, with stalks as an accent on top.
        // Sage-dominant on average, but the share swings from about 0.50 to
        // 0.90 across the site instead of sitting on 0.72 everywhere.
        // Sage and thistle trade against each other; the sapling share stays
        // pinned at 5%. My first version let all three float, which sounds
        // harmless and is not: `buildPine` costs about 7,000 triangles whatever
        // height it is asked for, so drifting saplings from 5% to a mean 9%
        // added 40,695 wood triangles — 40% of a cost regression I spent a
        // measurement chasing through the height distribution, where it was not.
        // When one member of a mix is two orders of magnitude more expensive
        // than the others, its share is a budget line and not a style choice.
        const sageShare = lerp(0.5, 0.9, mixField);
        const kind: MidSite["kind"] = r < sageShare ? "sage" : r < 0.95 ? "thistle" : "sapling";
        anchors.push([x, z, kind, statureField]);
      }
    }
  }

  for (let i = 0; i < anchors.length; i++) {
    const [ax, az, kind, stature] = anchors[i];
    const jit = i < HAND_ANCHORS ? 3.4 : 0.9;
    const x = ax + (rng() - 0.5) * jit;
    const z = az + (rng() - 0.5) * jit;
    if (blocked(x, z)) continue;
    // The reported gap is 0.5-4 m. The old ranges topped out at 2.6 m and mostly
    // sat near 1 m, so even the tall end of the "mid-storey" was arguably still
    // ground cover — a second reason it read as absent rather than as sparse.
    // Saplings now reach into the bottom of the tree range so the two layers
    // overlap instead of leaving a seam.
    // Skewed, not uniform, and shifted by the local stature field.
    //
    // `lerp(a, b, rng())` produces a *flat* histogram of heights, which is a
    // shape no population of anything has. A stand of shrubs is many small ones
    // and a few that got away: squaring the variate gives that, and biasing it
    // by the patch field means one stretch of the verge is uniformly stunted
    // and another carries the tall ones — which is what breaks the hedge read,
    // because a hedge's defining property is that its variation has no
    // wavelength longer than one plant.
    // The patch field *shifts* the skewed variate rather than adding to it.
    // First attempt was `skew * 0.72 + stature * 0.5`, whose sum exceeds 1 for a
    // large slice of the population and is then clamped — so instead of a skewed
    // distribution it produced a spike piled against the ceiling, and the
    // mid-storey grew 39,555 wood triangles of plants that were all at the top
    // of their range. A clamp catching a substantial fraction of a distribution
    // is not a guard, it is a mode; the same shape as the branch-length cap in
    // vegPine two files over.
    const skew = Math.pow(rng(), 1.35);
    const t = clamp01(skew * 0.82 + (stature - 0.5) * 0.42);
    const height =
      kind === "sage"
        ? lerp(0.7, 2.35, t)
        : kind === "thistle"
          ? lerp(1.2, 2.75, t)
          : lerp(1.6, 4.1, t);
    out.push({ x, z, kind, height, seed: seed + i * 131 });
  }
  return out;
}

/**
 * Open-ground planting, for the two bands a census of the built scene actually
 * found empty — and it is a different answer from the one the queue item and
 * three critics gave.
 *
 * The instruction was "no mid-storey, plant 1-3 m shrubs". Measured over 946
 * plantable 2 m cells of near field, recording the tallest thing standing in
 * each, the 1.5-3 m band was already the **best-covered** non-ankle layer at
 * 16.7%. Planting into it would have strengthened the one band that did not
 * need it and the complaint would have survived. The real troughs:
 *
 * | band | coverage |
 * | --- | --- |
 * | nothing at all | 12.0% |
 * | 0-0.15 m (the mat) | 40.7% |
 * | 0.15-0.4 m | 12.2% |
 * | **0.4-0.8 m** | **4.8%** |
 * | **0.8-1.5 m** | **6.3%** |
 * | 1.5-3 m | 16.7% |
 * | **3-6 m** | **1.9%** |
 * | 6 m+ | 5.4% |
 *
 * 52.7% of the near field has nothing above ankle height. That is the "bare
 * soil with props scattered on it" read, and it survived the ground mat because
 * the mat is by construction under 15 cm.
 *
 * **Why the gap is structural, not a count.** Every site `midStoreySites`
 * produces is anchored to one of three paths — the fence, the building base,
 * the pad edge. All three are edges. So 142 plants exist and are all hugging a
 * boundary, and the open ground between the lot and the treeline — which is
 * most of what a walking player looks at — has grass and then trees. No number
 * of additional edge-anchored plants fixes that.
 *
 * So this scatters in the open, and it deliberately does not use the height
 * ranges above: sage there starts at 0.75 m and thistle at 1.25 m, which is why
 * the layer lands in 1.5-3 m. Here sage runs 0.45-1.15 m to sit in the trough,
 * with a few conifers at 3.4-5.6 m to break the jump to the pines.
 *
 * Drifts, not a field. The candidates are a jittered grid gated by a
 * low-frequency mask, so the plants group into patches with clear ground
 * between them. An evenly-spaced scatter at this density would read as a
 * planting scheme, which is the signature this file already warns about two
 * screens up, and it would be a worse defect than the absence it fixes.
 */
export function openGroundSites(
  blocked: (x: number, z: number) => boolean,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  opts: { seed?: number; budget?: number; conifers?: number; spacing?: number } = {}
): MidSite[] {
  const seed = opts.seed ?? 9311;
  const budget = opts.budget ?? 70;
  const conifers = opts.conifers ?? 6;
  const spacing = opts.spacing ?? 3.1;
  const rng = seededRng(seed);
  const out: MidSite[] = [];
  const taken: [number, number][] = [];

  // Two incommensurate periods so the drifts have no visible repeat over the
  // ~90 m of the site, and no random state, so a plant does not move between
  // builds.
  const drift = (x: number, z: number) =>
    0.5 +
    0.34 * Math.sin(x * 0.081 + z * 0.043 + 1.7) +
    0.16 * Math.sin(x * 0.052 - z * 0.119 - 0.6) +
    0.12 * Math.sin(x * 0.201 + z * 0.164 + 2.9);

  const far = (x: number, z: number, r: number) => {
    for (const [tx, tz] of taken) if ((tx - x) * (tx - x) + (tz - z) * (tz - z) < r * r) return false;
    return true;
  };

  // Conifers first, so the largest objects get the pick of the open ground
  // rather than being squeezed into whatever the shrubs left. They also hold a
  // much wider exclusion, because two 5 m trees 3 m apart is a hedge.
  // Conifers get a height that depends on where they are, and the reason is a
  // defect an independent critic logged from frames as B8: "the foreground plant
  // at left is enormous relative to the building behind it, roughly the height
  // of the store". It was. One of these landed a few metres from the forecourt
  // at close to the 5.6 m ceiling, and at that range it filled two thirds of the
  // frame height while the store, twenty metres back, filled a quarter.
  //
  // The diagnosis to resist is "5.6 m is too tall", because it is not — it is a
  // small tree, and the treeline behind it is thirty. What is wrong is that it
  // is 5.6 m *there*. A forecourt is a place where sightlines are worth money
  // and anything that grows across them gets cut, so the tall end of this
  // distribution belongs at the back of the lot. Near the pumps you get seedlings
  // that came up since the last cut, which is also the honest way to keep the
  // scale cue: a 1.2 m sapling beside a 5 m one twenty metres back reads as depth.
  const forecourtRange = (x: number, z: number) =>
    Math.hypot(x - FORECOURT[0], z - FORECOURT[1]);

  let placed = 0;
  for (let attempt = 0; attempt < 4000 && placed < conifers; attempt++) {
    const x = lerp(bounds.minX, bounds.maxX, rng());
    const z = lerp(bounds.minZ, bounds.maxZ, rng());
    if (blocked(x, z) || !far(x, z, 13)) continue;
    // Full height only past 34 m; linear down to a seedling at the pumps.
    const reach = clamp01((forecourtRange(x, z) - 7) / 27);
    taken.push([x, z]);
    out.push({
      x,
      z,
      kind: "sapling",
      height: lerp(0.9, lerp(3.4, 5.6, rng()), reach),
      seed: seed + placed * 421 + 7,
    });
    placed++;
  }

  const step = spacing * 0.8;
  const cells: [number, number][] = [];
  for (let z = bounds.minZ; z < bounds.maxZ; z += step)
    for (let x = bounds.minX; x < bounds.maxX; x += step) cells.push([x, z]);
  // Shuffled so the budget is not spent on whichever corner is iterated first.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  let shrubs = 0;
  for (const [cx, cz] of cells) {
    if (shrubs >= budget) break;
    const x = cx + (rng() - 0.5) * step * 1.3;
    const z = cz + (rng() - 0.5) * step * 1.3;
    if (blocked(x, z)) continue;
    const d = drift(x, z);
    if (rng() > d * d * 1.35) continue;
    // Denser inside a drift than at its edge, so a patch has a soft margin.
    if (!far(x, z, spacing * lerp(0.55, 1.15, 1 - d))) continue;
    taken.push([x, z]);
    const r = rng();
    const kind: MidSite["kind"] = r < 0.82 ? "sage" : "thistle";
    out.push({
      x,
      z,
      kind,
      // The trough, precisely. Sage carries it because it is the only one of
      // the three kinds with volume; thistle is correctly a thin vertical and
      // is an accent here, not the substance.
      height: kind === "sage" ? lerp(0.45, 1.15, rng()) : lerp(0.7, 1.4, rng()),
      seed: seed + 1013 + shrubs * 197,
    });
    shrubs++;
  }
  return out;
}

/** Clamp helper kept local so this module has no dependency on the system. */
export const midClamp = clamp01;
