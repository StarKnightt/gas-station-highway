/**
 * The distant landscape for System 6.
 *
 * Three independent critics said the site "floats on a tabletop" and that the
 * horizon "reads as an infinite plane with nothing to scale against". This file
 * is the answer to that, and it is the cheapest thing in the system: rings of
 * silhouette geometry standing on the far ground, closing the horizon and
 * giving the eye a known object size to judge distance by.
 *
 * It is *silhouette geometry, not billboards with an alpha texture*. Three
 * reasons, and they all matter here:
 *
 *  - A tiled treeline texture repeats visibly around a 2 km circumference, and
 *    the repeat is exactly the kind of regularity the eye locks onto at the
 *    horizon. An upper envelope over a few hundred individually-sized trees
 *    never repeats.
 *  - No alpha test means no shadow-map interaction and no sorting, at a sun
 *    elevation where alpha-cut foliage is at its worst.
 *  - It is one draw call for the whole horizon.
 *
 * The bands are unlit (`MeshBasicMaterial`) with the colour authored directly.
 * At 300 m through the lighting system's aerial perspective, a distant treeline
 * is essentially pure atmosphere over a silhouette; running it through the PBR
 * path would only give the low sun a chance to make it black or blown out.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SECOND VERSION GOT WRONG, MEASURED
 *
 * `tools/vegprofile.mjs` measured the top edge in *world* space and reported it
 * healthy: peak pitch highly irregular, peak height varying 4.5x, essentially
 * no plateaux. A critic looking at the render nonetheless saw "a repeating
 * triangular sawtooth, near-constant pitch, near-constant amplitude". Both were
 * right, and `tools/vegsilhouette.mjs` — which projects the top edge through
 * the actual preset cameras — shows why:
 *
 *  - The band is 10-33 px tall on screen and the horizon line crops it near its
 *    top, so of that 4.5x world-space height variation only the last metre or so
 *    is visible. Measured visible peak prominence: 2.9-3.8 px, spread 1.7-3.3x.
 *    In world space it is a varied canopy; on screen it is a 3 px ripple.
 *  - Sample pitch was 1.3-2.9 px. Below about 2.5 px the profile aliases and any
 *    high-frequency content collapses into a regular per-pixel sawtooth. Most of
 *    the profile's energy was at 2-60 px, i.e. exactly there.
 *
 * So the profile has to be built for what survives projection: structure at
 * 100-400 px (60-250 m of frontage), a sample pitch that cannot alias, and
 * enough *visible* height range that the crop still leaves 3-4x. That is what
 * the layered spectrum below is for, and `tools/vegsilhouette.mjs` is the test
 * that says whether it worked.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, lerp, seededRng, smoothstep } from "./noise";

/**
 * Tangent of the sun elevation, 6.2 degrees.
 *
 * The reference a surface slope has to be compared against before anyone
 * reaches for amplitude. Terrain found its far ground sitting at a
 * characteristic slope of 0.006 against this 0.109 — fifteen times too flat to
 * shade at all — and no amount of tuning the shading would have shown it.
 */
const SOLAR_TAN = Math.tan((6.2 * Math.PI) / 180);

export interface BandSpec {
  /** Mean radius from the site centre, metres. */
  radius: number;
  /** Radial wander, metres, so the band is not a perfect circle. */
  radiusVary: number;
  /** Tree height range, metres. Also sets the vertical scale of the profile. */
  height: [number, number];
  /** Mean spacing along the band, metres. Only used for the finest detail. */
  spacing: number;
  /** Fraction of the ring left as open field. */
  gaps: number;
  /** Base colour in sRGB 0..1. */
  colour: [number, number, number];
  /** Extra warmth on the canopy tops facing away from the sun. */
  topWarm: number;
  seed: number;
  /**
   * Angular samples. Chosen so the on-screen sample pitch stays above the alias
   * limit at the widest preset — see `recommendedSamples`.
   */
  samples?: number;
  /**
   * Fraction of the band's height blended toward `hazeColour` at its base, to
   * stand in for the aerial perspective that a real stand has more of at its
   * feet than at its crown. Without it the band's bottom edge meets the plain
   * at a hard zero-haze line and reads as a cardboard cutout.
   */
  baseHaze?: number;
}

export interface DistantSpec {
  bands: BandSpec[];
  /** Unit vector toward the sun; only its XZ part is used. */
  sunDirection: THREE.Vector3;
  /** Y the bands are dropped to at their base — well under the ground. */
  baseY?: number;
  /**
   * Colour the base of each band fades into: the sky near the horizon. Supplied
   * by the caller so it can be kept consistent with whatever the lighting
   * system is actually putting there.
   */
  hazeColour?: [number, number, number];
  /**
   * The sky's horizon radiance in the direction of a given azimuth, in
   * **scene-referred linear sRGB** — the colour space `skyRadiance` declares as
   * a field, not display sRGB and not tone mapped.
   *
   * Takes precedence over `hazeColour`, which is a single value and therefore
   * cannot be right. Lighting's dome varies by a factor of 2.6 in blue/red
   * around the compass (0.889 away from the sun, 0.340 toward it), so a band
   * that converges toward one sampled colour is correct on one side of the ring
   * and wrong on the other. That is the bug I just spent four rounds on,
   * rotated: my own `hazeColour` at blue/red 1.467 was cooler than the *coolest*
   * part of the sky and four times cooler than the sun side.
   */
  hazeAt?: (azimuth: number) => [number, number, number];
}

/**
 * Angular samples that keep the on-screen pitch at or above `minPx` for the
 * widest field of view we shoot. Finer than this is not detail, it is aliasing:
 * the top edge gets a vertex per pixel and the profile turns into teeth.
 */
export function recommendedSamples(radius: number, minPx = 4, fovDeg = 55, viewW = 1600): number {
  const pxPerDeg = viewW / fovDeg;
  const degPerSample = minPx / pxPerDeg;
  void radius; // pitch in *degrees* is radius-independent; kept for call clarity
  return Math.max(256, Math.round(360 / degPerSample));
}

/** Smoothstep-interpolated value noise over a circular array. */
function ringNoise(arr: Float32Array, at: number): number {
  const n = arr.length;
  const f = at - Math.floor(at);
  const i0 = ((Math.floor(at) % n) + n) % n;
  const i1 = (i0 + 1) % n;
  return lerp(arr[i0], arr[i1], f * f * (3 - 2 * f));
}

/**
 * Top edge of one band, in metres of height above the far ground.
 *
 * WHAT THIS GOT WRONG TWICE, BECAUSE IT IS THE INTERESTING PART
 *
 * The critic reported a comb, then reported it again, then reported a row of
 * flat-topped mesas. All three were the same mistake seen from different
 * distances: **the spectrum was weighted toward the coarse end.**
 *
 * The previous version put 52% of the height range on a `mass` term with a 420 m
 * period and gave individual crowns a ±7% relative wobble. At 330 m, a 46°
 * frame spans about 265 m of frontage — *less than one period of the dominant
 * term.* So across any single frame `mass` was effectively a constant, the
 * canopy height was flat, the only vertical structure was the taper at the edge
 * of a gap, and a flat top between two ramps is a trapezoid. I had built hills
 * and then reasoned about their spectrum in world space, where it looked varied,
 * because in world space you see many periods and on screen you see one.
 *
 * The physical point I had backwards: **what makes a real treeline's top edge
 * ragged is that adjacent trees differ in height by a third, not that the wood
 * has hills in it.** Woodland on flat country is one tree tall everywhere. So
 * the energy belongs at crown scale, and it needs to be a real fraction of tree
 * height rather than a ripple.
 *
 * The four terms, and this time the weights say what matters:
 *
 *  - `crown`  individual trees, ~6 m of frontage, **the dominant term**. At
 *             330 m that is a 36 px bump carrying ±13 px of height, which is a
 *             ragged canopy. At ±3.8 px, which is what it had, it is nothing.
 *  - `clump`  groups of a few trees, 34 m. Second, and what gives the edge
 *             something between crown and stand.
 *  - `stand`  80-200 m. A gentle lift and fall along the line.
 *  - `mass`   420 m. Deliberately last and small: it is below one period per
 *             frame, so anything it carries is invisible variation that only
 *             shows up as a suspiciously constant height.
 *
 * Gaps are mostly partial. A hard hole gives the stand a vertical edge, and two
 * vertical edges with a flat top between them is the mesa again; a thinning is
 * both commoner in reality and much better behaved on screen. Only the deepest
 * fifth of the gap range opens into real sky.
 */
export function envelope(
  spec: BandSpec,
  samples: number,
  /**
   * Optional per-sample crown-scale shading term, 0..1, written in place. The
   * band is a MeshBasicMaterial and therefore unlit, which is right for a
   * backdrop — but it means nothing varies the fill unless the vertex colours
   * do, and the critic's "flat fill of near-uniform value, no internal detail
   * of any kind" is the direct consequence. This gives `buildBand` a
   * crown-scale signal to modulate tone with, so sunlit crowns sit lighter
   * than the gaps between them.
   */
  shadeOut?: Float32Array
): Float32Array {
  const rng = seededRng(spec.seed);
  const h = new Float32Array(samples);
  const circumference = 2 * Math.PI * spec.radius;
  const metresPerSample = circumference / samples;
  const [hMin, hMax] = spec.height;

  // Independent noise rings, each at a period expressed in metres of frontage
  // so the spectrum is the same shape whatever radius the band sits at.
  const ring = (n: number) => {
    const a = new Float32Array(Math.max(4, n));
    for (let i = 0; i < a.length; i++) a[i] = rng();
    return a;
  };
  const period = (metres: number) => Math.max(2, metres / metresPerSample);

  const massN = ring(Math.ceil(circumference / 420));
  const standN = ring(Math.ceil(circumference / 130));
  const clumpN = ring(Math.ceil(circumference / 34));
  // Two crown octaves at an incommensurate period ratio, not one. Warping alone
  // only moved the peak-pitch CV from ~0.5 to ~0.6; a single-period noise wants
  // to put a peak every period and warping just jitters where. Two rings whose
  // periods do not divide each other put a peak where they happen to agree, and
  // 1.63 is far enough from any small rational that they never agree twice the
  // same distance apart.
  const crownSpace = Math.max(6, spec.spacing * 2.2);
  const crownAN = ring(Math.ceil(circumference / crownSpace));
  const crownBN = ring(Math.ceil(circumference / (crownSpace * 1.63)));
  // Domain warp. Value noise at a fixed period puts its peaks at a fixed pitch,
  // and a fixed pitch is a comb however varied the peak *heights* are —
  // measured, the crown-dominant edge came out at a peak-pitch CV of 0.42-0.60
  // where a natural profile wants > 0.7. Displacing the crown lookup by up to
  // 2.5 periods over a 30 m window makes the local period vary between about
  // half and one and a half of nominal, which breaks the pitch without ever
  // taking the local frequency high enough to alias against the sample rate.
  const warpN = ring(Math.ceil(circumference / 30));
  const pWarp = period(30);
  const WARP = 3.6;

  const pMass = period(420);
  const pStand = period(130);
  const pClump = period(34);
  const pCrownA = period(crownSpace);
  const pCrownB = period(crownSpace * 1.63);

  // Where the woodland gives way to open field.
  //
  // This period is the single most consequential number in the file and the
  // first version had it at 260 m, which is a bug. A 46 degree frame at 330 m
  // spans about 265 m of frontage, so with 260 m gap features whether the
  // treeline appeared *at all* in a given shot was a coin flip — and measured
  // with tools/vegsilhouette.mjs, the r=330 band had exactly zero samples on
  // screen in the `approach` preset. That leaves only the near dark hedgerow
  // band closing the horizon, which is precisely the "flat black landform band,
  // one dark tone, no internal variation" the critic described. The treeline was
  // not badly made; it was off-camera.
  //
  // At 95 m there are two to four stands and two to four gaps across any frame,
  // which is what a treeline across flat country actually looks like, and no
  // camera can land in a hole.
  const FIELD_METRES = 95;
  const fieldN = ring(Math.ceil(circumference / FIELD_METRES));
  const pField = period(FIELD_METRES);

  // Long undulation, hundreds of metres. A treeline is not a constant-height
  // canopy with texture on top; the whole stand rises and falls over distances
  // far larger than a frame. Separate from `massN` at 420 m so there is energy
  // at both scales.
  const swellN = ring(Math.ceil(circumference / 1400));
  const pSwell = period(1400);

  // Two passes, because the composed shape has to be standardised before it can
  // be turned into a height, and standardising needs the distribution.
  //
  // This is the ruled horizon, and it is the *same* mistake as the framescan
  // near-miss an hour ago: an average destroys the thing you are averaging over.
  // `shape` blends five independent uniform rings, and an average of independent
  // uniforms concentrates on its mean — measured, sd 0.121 and a p1..p99 span of
  // 0.19..0.75, so a nominal 11-16 m range only ever produced 11.97..14.77 m.
  // 2.8 m of the 5 m I wrote, at 780 m, is about 7 px of total edge movement
  // spread mostly over low frequencies, which is why the measured mean jump
  // between adjacent columns was 0.96 px and 76% of columns were identical.
  //
  // So I spent three rounds re-weighting a spectrum whose amplitude was the
  // problem. Re-weighting cannot fix it: any reweighted average of uniforms
  // still concentrates. It has to be standardised.
  const raw = new Float32Array(samples);
  const openA = new Float32Array(samples);
  const crownAA = new Float32Array(samples);
  const clumpA = new Float32Array(samples);
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < samples; i++) {
    const field = ringNoise(fieldN, i / pField);
    // Below a fifth of the gap threshold the wood really does stop and there is
    // sky. Above it, the gap only thins the stand, which is both commoner and
    // does not give the silhouette a vertical edge to be a mesa side.
    const hole = spec.gaps * 0.2;
    if (field < hole) continue;
    const open = field >= spec.gaps ? 1 : lerp(0.28, 1, smoothstep(hole, spec.gaps, field));

    const warp = (ringNoise(warpN, i / pWarp) - 0.5) * 2 * WARP;
    const mass = ringNoise(massN, i / pMass);
    const stand = ringNoise(standN, i / pStand);
    const clump = ringNoise(clumpN, i / pClump + warp * 0.35);
    const crownA = ringNoise(crownAN, i / pCrownA + warp);
    const crownB = ringNoise(crownBN, i / pCrownB - warp * 0.7);
    const crown = 0.62 * crownA + 0.38 * crownB;

    // Crown-dominant. See the note above: this is the whole fix.
    const swell = ringNoise(swellN, i / pSwell);
    const shape = 0.52 * crown + 0.18 * clump + 0.12 * stand + 0.09 * mass + 0.09 * swell;
    raw[i] = shape;
    openA[i] = open;
    crownAA[i] = crownA;
    clumpA[i] = clump;
    n++;
    sum += shape;
    sum2 += shape * shape;
  }
  if (!n) return h;
  const mean = sum / n;
  const sd = Math.max(1e-4, Math.sqrt(Math.max(0, sum2 / n - mean * mean)));

  for (let i = 0; i < samples; i++) {
    const open = openA[i];
    if (open === 0) continue;
    const crownA = crownAA[i];
    const clump = clumpA[i];
    // Standardise, then squash with tanh rather than clamping.
    //
    // tanh is the point, not a flourish. Every previous attempt at widening this
    // edge ended in a plateau at exactly hMax — a clamp, a saturating gap taper,
    // a dominant coarse term — and the file already records that any operation
    // which can saturate produces a flat top, which is the one silhouette this
    // scene cannot have. tanh approaches its limits without reaching them, so
    // the range is exercised and no two samples land on the same ceiling.
    const t = 0.5 + 0.5 * Math.tanh(((raw[i] - mean) / sd) * 0.82);
    // A few emergents. Real stands have the odd tree standing a good way clear
    // of the canopy, and it is most of what stops a treeline reading as a hedge
    // cut to height. Applied to the *crown* term only, so an emergent is one
    // tree wide rather than a hill, which is what went wrong when this existed
    // as its own coarse pass last round.
    //
    // Only on the bands where a single tree is more than a pixel or two wide. On
    // the far bands the same spike is a one-pixel tooth on a smooth ridge, which
    // is what made the 620 m and 1150 m layers read as a serrated mountain range
    // instead of as distant country — and the brief specifically rules mountains
    // out.
    //
    // Applied as a multiplier on the *height*, not as an addition to `shape`.
    // Added to shape it pushed the value past 1, clamp01 clipped it, and the
    // clipped samples formed a plateau at exactly hMax — measured with
    // tools/vegprofile.mjs, 22% of the 330 m band's top edge was dead level at
    // 14.56 m. That is the mesa mechanism again, arrived at from a third
    // direction: the first time it was a dominant coarse term, the second time a
    // gap taper with vertical sides, and this time a clamp. Any operation that
    // can saturate will produce a flat top, and a flat top is the one silhouette
    // this scene cannot have.
    let top = lerp(hMin, hMax, t);
    // Tested on the dominant octave, not on the blend. Averaging two uniform
    // rings concentrates the result near 0.5, so a blend almost never exceeded
    // 0.86 and the emergents effectively never fired — measured, peak height
    // spread stayed at 2.1x when the whole point of the term is to widen it.
    // Deliberately gentle. At 2.2 the emergents were the loudest feature on the
    // horizon and read as small volcanic cones — a crown-width base, a smooth
    // triangular flank because the ring lookup is smoothstep-interpolated, and
    // three times the height of the canopy either side. That is a mountain
    // range, which is the one thing the brief names twice. An emergent tree in
    // a real stand stands maybe 30% over the canopy, not 300%.
    if (crownA > 0.84) top *= 1 + (crownA - 0.84) * (spec.radius < 500 ? 0.8 : 0.25);
    h[i] = top * open;
    // Crown tops catch the light; the saddles between them and the thinned
    // sections of a gap do not. Deliberately built from the same crown octaves
    // as the profile so the tone and the silhouette agree, which is what makes
    // a lump read as a tree rather than as noise laid over a ridge.
    if (shadeOut) shadeOut[i] = clamp01(0.62 * crownA + 0.26 * clump + 0.12 * open);
    void t;
  }
  return h;
}

function buildBand(
  spec: BandSpec,
  sunXZ: THREE.Vector2,
  baseY: number,
  haze: [number, number, number],
  hazeAt?: (azimuth: number) => [number, number, number]
): THREE.BufferGeometry {
  const samples = spec.samples ?? recommendedSamples(spec.radius);
  const shade = new Float32Array(samples);
  const h = envelope(spec, samples, shade);
  /** Ground distance between adjacent silhouette samples, for the slope term. */
  const metresPerBandSample = (2 * Math.PI * spec.radius) / samples;

  // The slope field that lights the facets, measured over a baseline fixed in
  // **metres of hillside**, not in samples.
  //
  // The first version of this differenced `h[i+1]` against `h[i-1]`, i.e. over a
  // baseline of two samples. That reads as a physical measurement and is not
  // one: `samples` is a rendering parameter chosen to keep the *silhouette*
  // above the alias threshold, so the same line of code meant 1.16 m of
  // frontage on the 520 m band at 5632 samples and 7.36 m on the outer bands at
  // 3072 — a factor of 6.3 difference in what was being measured, for identical
  // source. This is the same defect as sizing a leaf cluster as a fraction of
  // its plant (NOTES.md): a detail quantity given a size by the thing it is
  // attached to instead of by the physics.
  //
  // The consequence was visible and directional. A 5 m crown feature over a
  // 1.16 m baseline is a gradient of 4.3, which is 40x the 0.109 tangent of a
  // 6.2 degree sun, so `slopeLight` saturated hard to 0 or 1 on alternating
  // samples — and at the near band's 1.86 px sample pitch that is sub-pixel
  // dither, which resolves to a flat grey. The outer bands, whose accidental
  // 7.36 m baseline landed near facet scale, shaded correctly. So the band with
  // by far the largest area in frame was the one still reading as the
  // "constant-value cutout" the critic logged, while the ones behind it looked
  // fixed. Measured: 8x zoom on the near band showed no internal variation at
  // all, while the outer stack showed facets.
  //
  // A hillside facet that catches or misses a low sun is tens of metres across,
  // set by geology and not by anything in this file. `envelope` already keys its
  // noise periods to metres of frontage for exactly this reason ("the spectrum
  // is the same shape whatever radius the band sits at"); the slope term should
  // have been written the same way and was not.
  // REFUTED HYPOTHESIS, kept because the reasoning is sound and the next person
  // will have it too. A single fixed differencing baseline is a comb filter —
  // `h(x + B/2) - h(x - B/2)` has response `2 sin(pi f B)`, null at every period
  // B/n and maximal at 2B — so it does not measure "the slope", it measures the
  // slope band-passed around a preferred wavelength, and then paints that
  // wavelength across the hillside as light and shade. Since the fill was
  // measured to carry a repeat at lag 293 px which *rose* from r 0.444 to
  // r 0.711 when this term landed, the comb was the obvious suspect.
  //
  // It is not the cause. Replacing the single 46 m baseline with a weighted sum
  // over 21 / 46 / 98 m left the peak at **exactly** lag 293 px, r 0.699 against
  // 0.711 — and a different set of combs would have moved the peak, not merely
  // weakened it. So the period is in `h` itself, and this term did not create it;
  // it revealed it, by replacing a saturated two-level field that was masking it.
  // See the handover: the repeat is `envelope`'s, and it is the live half of the
  // critic's top-ranked complaint.
  //
  // Reverted to the single baseline rather than left in, on the principle that an
  // unmotivated change which happens to be harmless is still a change the next
  // reader has to understand.
  const FACET_M = 46;
  const half = Math.max(1, Math.round(FACET_M / 2 / metresPerBandSample));
  // Box-blurred height, radius half the differencing baseline, so a single noisy
  // sample at either endpoint cannot stand in for the facet. Running sum, O(n).
  const hs = new Float32Array(samples);
  {
    const rad = Math.max(1, Math.round(half / 2));
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += h[(k + samples) % samples];
    const inv = 1 / (2 * rad + 1);
    for (let i = 0; i < samples; i++) {
      hs[i] = sum * inv;
      sum += h[(i + rad + 1) % samples] - h[(i - rad + samples) % samples];
    }
  }
  /** Along-ring gradient of the skyline over `FACET_M` metres, dimensionless. */
  const facetSlope = (i: number): number =>
    (hs[(i + half) % samples] - hs[(i - half + samples) % samples]) / (2 * half * metresPerBandSample);

  // How far the facet term is allowed to swing the fill, mean-preserving about
  // `slopeLight = 0.5` so the band's mean luma — which is tuned against the sky
  // and against its neighbours in `vegHorizonBands` — does not move.
  //
  // This is where the term's authority belongs, and getting that wrong is the
  // interesting part. The obvious lever was the gain inside `slopeLight`, and
  // `tools/_vegfacet-entry.ts` measured what raising it does: at gain 0.9 the
  // term is clamped at 0 or 1 on 8-28% of samples, and at gain 2.2 that becomes
  // 50-64%. Past that point it is not a shading term any more, it is a binary
  // lit/unlit mask with a soft edge, and lighting a continuous surface off a
  // two-level field is a defect this project has now hit three times. The same
  // measurement is the post-mortem on the version this replaced: differencing
  // over two samples ran 66-79% pinned, so its apparently *higher* variance was
  // bimodality, not detail, and at a 1.86 px sample pitch it resolved to a flat
  // grey with vertical corduroy over it.
  //
  // Widening the response instead costs no quantisation at all: the same 0..1
  // input, mapped over a wider output interval.
  //
  // Tapered with distance, which is aerial perspective doing double duty — it
  // is physically right that haze compresses contrast with range, and it gives
  // the near and far ridges visibly different contrast, which is the "no depth
  // layering between near and far ridges" half of the same critic note.
  const slopeContrast = 0.76 - 0.42 * clamp01((spec.radius - 520) / 1280);

  const pos = new Float32Array(samples * 2 * 3);
  const col = new Float32Array(samples * 2 * 3);
  const idx: number[] = [];

  // NOT setRGB(..., SRGBColorSpace). This is the bug that made the whole
  // four-layer stack a black cutout, and it is worth being explicit about
  // because it is invisible in review.
  //
  // The band values were authored as *display* tones — the file above still
  // describes them as "0.043 luma" — and then handed to setRGB with
  // SRGBColorSpace, which converts display to linear. sRGB 0.046 is linear
  // 0.0036: thirteen times darker than the number I wrote, and after tone
  // mapping the four bands landed at display luma 30-57 against a sky of 140-166.
  // So the band was the darkest thing in the frame while being the furthest
  // away, which is aerial perspective exactly backwards.
  //
  // The monotonic assertion in vegHorizonBands.ts passed throughout, because
  // ordering survives any monotonic transform. It was a true statement about
  // the wrong quantity: the *relationship* was preserved and the entire range
  // had collapsed into the bottom fifth of the display scale, where no
  // relationship is visible. tools/vegband.mjs now measures the rendered
  // pixels instead, which is the only place the claim means anything.
  //
  // These are linear scene-referred values and go to the shader untouched.
  const base = new THREE.Color(spec.colour[0], spec.colour[1], spec.colour[2]);
  const hazeC = new THREE.Color(haze[0], haze[1], haze[2]);
  // A ring of sky samples rather than one, resolved once at build time. 96 steps
  // is 3.75 degrees apart, well under the scale on which the dome changes, and
  // interpolating between them costs nothing per vertex.
  const HAZE_STEPS = 96;
  const hazeRing: THREE.Color[] | null = hazeAt
    ? Array.from({ length: HAZE_STEPS }, (_, i) => {
        const c3 = hazeAt((i / HAZE_STEPS) * Math.PI * 2);
        return new THREE.Color(c3[0], c3[1], c3[2]);
      })
    : null;
  const hazeLerp = new THREE.Color();
  const hazeFor = (az: number) => {
    if (!hazeRing) return hazeC;
    const t = ((az / (Math.PI * 2)) % 1 + 1) % 1 * HAZE_STEPS;
    const i0 = Math.floor(t) % HAZE_STEPS;
    return hazeLerp.copy(hazeRing[i0]).lerp(hazeRing[(i0 + 1) % HAZE_STEPS], t - Math.floor(t));
  };
  // Warm rim on the canopy: at six degrees the sun only reaches the tops, and
  // only on the stands whose near face is turned toward it.
  // A warm lift on the sunlit crowns, not a highlight. 0.86 linear was brighter
  // than the sky, so once the bands stopped being black this term put a
  // near-white streak along the whole sun-facing side of the horizon. The sun is
  // 6 degrees up: it reaches the crowns, it does not blow them out.
  const rim = new THREE.Color(0.40, 0.28, 0.19);
  const c = new THREE.Color();
  const baseHaze = spec.baseHaze ?? 0;

  /**
   * Hold a crown vertex below the radiance of the haze in front of it.
   *
   * The critic's "white fringe" on the distant range, and the only part of that
   * note that turned out to be a hard defect rather than a matter of degree.
   * Measured on `wide.png`, sweeping every column and taking the sky value from
   * the `?vforce=noline` control so the comparison is against what is actually
   * behind the crown: **44.9% of unoccluded columns had a crown pixel brighter
   * than the sky above it**, mean excess 8.6 display luma, worst 23.4. The
   * previous round had already halved the rim colour for looking too bright and
   * left it at 37.5% of columns, which is the shape of a value being tuned when
   * it needed a bound.
   *
   * It needs a bound because it is not a preference. What reaches the eye from a
   * distant hillside is `L_surface * T + L_haze * (1 - T)`, a convex combination,
   * so it can only exceed `L_haze` if the surface itself does. A conifer stand
   * at 520-1800 m has an albedo around 0.08 and a sun 6.2 degrees up; the haze
   * near the horizon is integrating scattered light along the entire path. The
   * surface cannot win, at any hour, so there is no parameter setting in which
   * exceeding the sky is correct, and any term able to do so is misplaced rather
   * than mistuned.
   *
   * Applied as a smooth saturation, not a clamp. `min()` here would build a
   * plateau of vertices sitting at exactly the ceiling, which is the defect
   * already found twice in this system — a branch-length clamp binding 9% of
   * the silhouette-defining branches at exactly 0.340 H, and `envelope`'s height
   * ceiling collecting clipped samples into a flat run at `hMax`. Both read as
   * ruled lines. The saturation below is monotone and injective, so the ordering
   * of crowns survives and no two crowns land on the same value.
   *
   * **With a knee, and the first version did not have one.** `ceil * (1 -
   * exp(-v / ceil))` asymptotes correctly but begins compressing at v = 0: at
   * half the ceiling it already returns 79% of its input. Applied to the top
   * vertex — which the quad interpolates down through the whole visible band —
   * it took the band stack's mean display luma from 99.6 to 89.1 and the near
   * band from 85.8 to 79.6. That is a 10-luma darkening of every band, mean
   * values that `vegHorizonBands` tunes against the sky and against each other,
   * to correct an overshoot present on 45% of columns at a mean of 8.6. A
   * correction that costs more than the defect is not a fix, and the tell was
   * that the *mean* moved when only the *maximum* was wrong.
   *
   * Below the knee this is the identity. The two branches share a derivative of
   * 1 at the knee, so there is no visible seam where they meet.
   *
   * Luma-only, with RGB rescaled by the ratio, so the rim keeps its hue and only
   * loses the brightness it was never entitled to.
   */
  const holdUnderSky = (col3: THREE.Color, azimuth: number): void => {
    const sky = hazeFor(azimuth);
    // 0.97 rather than 1.0: the ceiling is the asymptote of the saturation, and
    // the last 3% is the acknowledgement that `T` is not 1 and the surface is
    // not a mirror.
    const ceil = (0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b) * 0.97;
    if (ceil <= 0) return;
    const v = 0.2126 * col3.r + 0.7152 * col3.g + 0.0722 * col3.b;
    const knee = ceil * 0.78;
    if (v <= knee || v <= 0) return;
    const span = ceil - knee;
    const out = knee + span * (1 - Math.exp(-(v - knee) / span));
    const k = out / v;
    col3.setRGB(col3.r * k, col3.g * k, col3.b * k);
  };

  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r =
      spec.radius +
      spec.radiusVary * (Math.sin(a * 2.3 + spec.seed) * 0.6 + Math.sin(a * 5.9 - spec.seed * 0.7) * 0.4);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Height compensated for the radius wobble, and this is the change that
    // finally puts the skyline under the control of `envelope`.
    //
    // Apparent angular height is height/distance. `radiusVary` moves this
    // sample's distance by up to +/-17% of the nominal radius, so on its own it
    // swings apparent height by 1.40x on the near band — *larger* than the 1.50x
    // that the entire height field contributes — and it does it with two
    // sinusoids at 2.3 and 5.9 cycles per revolution, which is roughly eight
    // extrema across a wide frame and a feature width far greater than a frame.
    // That is a smooth ridge-scale undulation, and it was the mountain range.
    //
    // Measured: wide.png stepped 0.89 px per column with only 16% of columns
    // changing at all. A crown-scale edge steps almost every column.
    //
    // I spent three rounds re-weighting the noise spectrum in `envelope` while
    // the skyline was mostly being drawn by this line. Scaling the height by
    // r/radius makes apparent height exactly independent of the wobble, so the
    // ring still is not a circle — which is what radiusVary is for, giving the
    // layers genuinely different distances — but it no longer touches the
    // silhouette.
    const top = h[i] * (r / spec.radius);

    // Positive when this stand's near face is turned away from the sun, i.e.
    // when we are looking at its lit side.
    //
    // On its own this was B5. `facing` is a function of `a`, the sample's
    // azimuth **around the whole 3.5 km ring**, so it turns over a period of one
    // revolution — and a 46 degree preset sees 13% of that. Across any single
    // frame it is very nearly a constant, which means the term that exists to
    // make some stands lit and others shadowed gave every stand in the frame the
    // same value. A critic logged the result as "a constant-value cutout with a
    // white fringe and no internal variation — no lit faces, no shadowed
    // valleys". Measured on wide.png before this change: inside the band the
    // mean absolute per-column luma step was 1.5-2.9, against 0.6-1.4 for the
    // empty sky above it. The range carried barely twice the structure of a
    // smooth gradient.
    //
    // The fix is Terrain's rule, which applies here exactly: **shading responds
    // to slope, so compare the surface's characteristic slope against the
    // tangent of the sun elevation.** At 6.2 degrees that tangent is 0.109, and
    // this height field runs several metres over a few samples of 0.6 m, so its
    // slopes are an order of magnitude steeper than the sun is shallow. There
    // was never a shortage of slope to light — nothing was reading it.
    //
    // So light the local facet. `dh` is the along-ring gradient of the skyline;
    // `sunAlong` is how much of the sun's direction lies along the ring here.
    // Where the ground rises toward the sun the facet faces it and is lit; where
    // it falls away it is shadowed. Both vary at crown scale, which is the scale
    // the missing detail was at.
    const dh = facetSlope(i);
    const sunAlong = -Math.sin(a) * sunXZ.x + Math.cos(a) * sunXZ.y;
    // Normalised by the solar tangent, so a facet steeper than the sun is fully
    // lit or fully shadowed and shallower ground grades between — which is what
    // makes a low sun read as low.
    const slopeLight = clamp01(0.5 + (dh / SOLAR_TAN) * sunAlong * 0.9);
    const facing = clamp01(-(Math.cos(a) * sunXZ.x + Math.sin(a) * sunXZ.y)) * (0.35 + 0.65 * slopeLight);

    for (let v = 0; v < 2; v++) {
      const k = (i * 2 + v) * 3;
      pos[k] = x;
      pos[k + 1] = v === 0 ? baseY : top;
      pos[k + 2] = z;
      c.copy(base);
      // Crown-scale tonal variation, so the fill is not flat. +/-16% on a band
      // that now sits around display luma 100-150 is a visible 20-30 levels,
      // which is enough to read as structure without turning into noise.
      // Both vertices, not just the top.
      //
      // First attempt put the new slope term into `facing` only, which feeds the
      // rim. Measured on wide.png that moved the band's mean absolute per-column
      // luma step from 2.197 to 2.432 against a 0.891 sky reference — a 10%
      // improvement on a defect that needs a multiple, because the rim is a thin
      // lift on the crown line and the *fill* is what reads as a cutout.
      //
      // Modulating only the top vertex has the same problem from the other side:
      // the quad interpolates from a flat base colour up to a varying top, so
      // whatever variation the top carries is washed out over the visible body
      // of the band. The base vertex gets a damped share of the same term, which
      // keeps the vertical haze gradient intact while letting the crown-scale
      // structure reach down into the band instead of living on its edge.
      const tone = (0.70 + 0.60 * shade[i]) * (1 - slopeContrast * 0.5 + slopeContrast * slopeLight);
      const t = v === 1 ? tone : 1 + (tone - 1) * 0.55;
      c.setRGB(c.r * t, c.g * t, c.b * t);
      if (v === 1 && top > 0.4) {
        c.lerp(rim, spec.topWarm * facing * (0.45 + 0.55 * shade[i]));
        holdUnderSky(c, a);
      }
      // The bottom vertex sits well below ground and is never seen, but the
      // interpolation across the quad is what lifts the *visible* base of the
      // band toward the haze. Pushing the bottom vertex further than the
      // intended amount compensates for the visible band being only the top
      // slice of the quad.
      // Nearly off, and the reasoning is worth keeping because the first two
      // attempts at this were both wrong in instructive ways.
      //
      // baseHaze lerps the *bottom* vertex toward the sky. It was written for an
      // eye-level preset, where a band's base sits right on the horizon line and
      // a hard meeting with the plain reads as a cutout edge. But haze is a
      // function of distance, and every point on a ring is the same distance
      // away, so making the base paler than the crown is not aerial perspective
      // — it is a gradient standing in for one.
      //
      // It became actively destructive once the colour-space bug was fixed:
      // `hazeColour` had been going through setRGB(SRGBColorSpace) too, so
      // treating it as linear made it four times brighter, and in the elevated
      // `wide` preset — camera at 12.5 m, which is *inside* the 13-19 m height
      // range of the bands, so several metres of the ring's front face is
      // visible — the whole face turned pale sky-blue and read unmistakably as a
      // lake. Two rounds of tuning the band colour barely moved those pixels,
      // because this term, not the band colour, was setting them.
      //
      // Distance haze now lives entirely in the per-band colour (see
      // `hazed()` in vegHorizonBands), which is where a distance-dependent
      // quantity belongs. This is left as a hair of softening on the base edge
      // for the eye-level presets and nothing more.
      if (v === 0 && baseHaze > 0) c.lerp(hazeFor(a), clamp01(baseHaze));
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }

  for (let i = 0; i < samples; i++) {
    const a = i * 2;
    const b = ((i + 1) % samples) * 2;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** All bands merged into a single geometry — one draw call for the horizon. */
export function buildDistantLandscape(spec: DistantSpec): THREE.BufferGeometry {
  const sun = new THREE.Vector2(spec.sunDirection.x, spec.sunDirection.z).normalize();
  const baseY = spec.baseY ?? -9;
  const haze = spec.hazeColour ?? [0.30, 0.34, 0.44];
  const parts = spec.bands.map((b) => buildBand(b, sun, baseY, haze, spec.hazeAt));
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("buildDistantLandscape: merge failed");
  parts.forEach((p) => p.dispose());
  return merged;
}
