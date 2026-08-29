/**
 * The horizon band specs, extracted so that the runtime and the CPU-only
 * analysis harness (`tools/vegsilhouette.mjs`) read *the same numbers*. Keeping
 * a second copy in the tool would let the two drift apart, and a measurement of
 * a stale copy is worse than no measurement.
 */

import type { BandSpec } from "./vegDistant";

/**
 * Four layers, front to back.
 *
 * ## Colour: derived, not authored, and the reason why
 *
 * The previous version authored four RGB triples directly and asserted they
 * were ordered lighter-and-bluer with distance. That assertion passed on every
 * build while the critic was looking at "a continuous dark brown-to-black
 * silhouette... the furthest element in frame is the darkest and most saturated
 * thing in the scene". Both were true at once, because the assertion checked
 * the ordering of the numbers I typed and the numbers I typed were being
 * converted from display to linear on the way to the GPU. Measured in the
 * rendered pixels with `tools/vegband.mjs`, the four bands came out at display
 * luma 30-57 against a sky of 140-166: correctly ordered, and all four sitting
 * in the bottom fifth of the range where ordering cannot be seen.
 *
 * So the colours are no longer free parameters. Aerial perspective is one
 * mechanism — distance blends an object toward the colour of the air in front
 * of it — and the only honest way to express it is as that blend. Each band
 * declares how far toward the sky it has gone, and the RGB falls out. It is not
 * possible for a further band to come out darker than a nearer one, because a
 * larger haze fraction is by construction closer to the sky.
 *
 * `SKY_LINEAR` is the near-horizon sky measured off an actual capture rather
 * than guessed, and `CONIFER_LINEAR` is the intrinsic albedo of a dark backlit
 * stand. Both are linear scene-referred and go through `MeshBasicMaterial`
 * unchanged, so what is written here is what tone mapping receives.
 *
 * The haze fractions went 0.42/0.58/0.74/0.88 on the first attempt and that
 * overcorrected into a different wrong picture: measured band luma 105 against
 * a sky of 165, which read as a lake. 240 m of clear dawn air is not much air.
 * These are calibrated so the near band lands around display luma 75-80 —
 * clearly darker than the sky, clearly lighter than the 42-luma foreground
 * dirt, which is the ordering that makes it read as distance rather than as
 * either a cutout or water.
 *
 * Final calibration, predicted from the linear values through ACES and then
 * confirmed against tools/vegband.mjs: display luma 64 / 86 / 108 / 134 against
 * a sky of 145-165 and foreground dirt at 42. That is a monotonic ramp with the
 * near band sitting between the dirt and the sky rather than below both.
 */

/**
 * Near-horizon sky, linear, taken from the pixels rather than from an idea of
 * what a sky is.
 *
 * The previous value was [0.40, 0.42, 0.53] — blue/red 1.325. The actual sky
 * immediately above the skyline in these captures measures rgb(165, 159, 162),
 * **blue/red 0.98**: neutral, very slightly magenta, which is what a 2400 K sun
 * a few degrees up does to the air near the horizon. Blending the bands toward a
 * blue that is not in the sky is what made them a cold strip under a warm sky,
 * and cold-under-warm at the horizon is the single strongest cue for water.
 *
 * The lesson is small and repeatable: aerial perspective interpolates toward the
 * colour of the air *in this scene*, so that colour has to be sampled from this
 * scene. I had reasoned "distance makes things bluer" from general knowledge and
 * never checked it against a dawn sky, where it is not true near the horizon.
 */
const SKY_LINEAR: [number, number, number] = [0.330, 0.305, 0.315];
/**
 * The same air, exported, so that nothing else in the system can invent a second
 * one. A separate `hazeColour` for the band bases is what produced the water
 * read that survived three rounds of fixes aimed at other mechanisms.
 */
export const SKY_HAZE: [number, number, number] = SKY_LINEAR;
/** A dark backlit conifer stand with no air in front of it, linear. */
const CONIFER_LINEAR: [number, number, number] = [0.030, 0.032, 0.030];

/** Blend an unhazed stand toward the sky. `f` is how much air is in the way. */
function hazed(f: number): [number, number, number] {
  return [
    CONIFER_LINEAR[0] + (SKY_LINEAR[0] - CONIFER_LINEAR[0]) * f,
    CONIFER_LINEAR[1] + (SKY_LINEAR[1] - CONIFER_LINEAR[1]) * f,
    CONIFER_LINEAR[2] + (SKY_LINEAR[2] - CONIFER_LINEAR[2]) * f,
  ];
}

/**
 * ## Height ranges, which is a separate thing I had wrong
 *
 * A `vforce=noline` capture proved these bands are the *only* thing on the
 * horizon — there is no terrain landform out here — so the "flat black landform
 * band" three critics described was always this file, and the brief rules
 * mountains out explicitly.
 *
 * A real treeline on flat country is one tree tall everywhere: adjacent crowns
 * differ by about a third, so the range is about +/-20% around the mean and the
 * "the wood stops here" work belongs to `gaps`, which opens sky. Every band is
 * under 1.5x.
 *
 * Note that narrowing these was necessary but *not sufficient*, and it took a
 * pixel measurement to find out why: `radiusVary` was contributing a larger
 * swing to *apparent* height than the height field was, at ridge scale. See the
 * note in vegDistant.buildBand. Height and radius both have to be right.
 *
 * `samples` is set from `recommendedSamples`, which keeps the on-screen sample
 * pitch above 4 px at the widest preset. Finer is not more detail; it is a
 * per-pixel sawtooth.
 */
export const HORIZON_BANDS: BandSpec[] = [
  {
    // Hedgerows, field boundaries and scrub on the near fields. Close enough
    // that individual crowns are a couple of pixels and genuinely resolve, so
    // this is the layer that has to carry "trees" rather than "landform".
    radius: 520,
    radiusVary: 78,
    height: [9.0, 13.5],
    spacing: 1.9,
    gaps: 0.34,
    colour: hazed(0.14),
    topWarm: 0.12,
    baseHaze: 0.02,
    seed: 9101,
    // 2560 put a polyline vertex every 4.9 px at the widest preset, and between
    // vertices the top edge is a straight line — so the skyline could not be
    // ragged at any amplitude. The old note here said finer sampling "is not more
    // detail; it is a per-pixel sawtooth", which was the wrong call: this is the
    // band with the greatest apparent height (13.5/520 against 16/780 for the
    // next), so it is the one that draws the skyline, and its crowns are 16 px
    // wide. Sampling a 16 px feature every 4.9 px is what ruled the horizon.
    samples: 5632,
  },
  {
    // The treeline proper: the dominant edge, and the one that closes the
    // horizon. Tall enough that its masses read as shape, not as a line.
    radius: 780,
    radiusVary: 105,
    height: [11.0, 16.0],
    spacing: 2.6,
    gaps: 0.10,
    colour: hazed(0.34),
    topWarm: 0.10,
    baseHaze: 0.04,
    seed: 9203,
    samples: 3072,
  },
  {
    // A second stand well behind the first. At 620 m the air has visibly lifted
    // it; two layers of silhouette at different tones is what produces depth,
    // and one band alone reads as a painted backdrop however good its edge is.
    radius: 1150,
    radiusVary: 150,
    height: [12.0, 17.5],
    spacing: 3.2,
    gaps: 0.22,
    colour: hazed(0.72),
    topWarm: 0.05,
    baseHaze: 0.06,
    seed: 9307,
    samples: 3072,
  },
  {
    // The furthest layer, nearly sky-valued. Deliberately low contrast: its
    // job is to stop the horizon being a single hard line, not to be seen.
    radius: 1800,
    radiusVary: 230,
    height: [13.0, 19.0],
    spacing: 4.5,
    gaps: 0.26,
    colour: hazed(0.88),
    topWarm: 0.02,
    baseHaze: 0.08,
    seed: 9419,
    samples: 3072,
  },
];

/*
 * Aerial perspective is monotonic in distance, or the layering does nothing.
 *
 * Kept, but demoted: because `hazed()` interpolates toward a single sky colour,
 * monotonic haze fractions make this true by construction and it can no longer
 * fail. That is the point — the invariant is now structural rather than
 * checked. What it does still catch is somebody reintroducing a hand-authored
 * triple.
 *
 * The check that actually matters is not here and cannot be: it is whether the
 * bands are separable *in the rendered pixels*, which is what
 * `tools/vegband.mjs` measures and what the previous version of this assertion
 * gave false confidence about for three rounds.
 */
for (let i = 1; i < HORIZON_BANDS.length; i++) {
  const a = HORIZON_BANDS[i - 1];
  const b = HORIZON_BANDS[i];
  const luma = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (b.radius <= a.radius)
    throw new Error(`vegHorizonBands: band ${i} is not further away than band ${i - 1}`);
  if (luma(b.colour) <= luma(a.colour))
    throw new Error(
      `vegHorizonBands: band ${i} (r=${b.radius}) is not lighter than band ${i - 1} (r=${a.radius}): ` +
        `${luma(b.colour).toFixed(4)} vs ${luma(a.colour).toFixed(4)}`
    );
  // This used to assert each band was *bluer* than the one in front, and that
  // assertion was wrong in the same way, and for the same reason, as the bug it
  // failed to catch: both came from assuming distance shifts things blue. It does
  // when the air is blue. This sky measures blue/red 0.98 at the horizon, so
  // blending toward it moves the bands *away* from blue, and an assertion
  // demanding otherwise would have forced the cold cast back in.
  //
  // The physical statement is convergence: air in front of a thing replaces its
  // colour with the air's colour, so every band must sit closer to the sky in
  // every channel than the band in front of it. That holds whatever colour the
  // sky happens to be, which is the point — it cannot be satisfied by a value I
  // guessed, only by one that interpolates toward a measured sky.
  const gap = (c: [number, number, number]) =>
    Math.hypot(c[0] - SKY_LINEAR[0], c[1] - SKY_LINEAR[1], c[2] - SKY_LINEAR[2]);
  if (gap(b.colour) >= gap(a.colour))
    throw new Error(
      `vegHorizonBands: band ${i} (r=${b.radius}) is not closer to the sky than band ${i - 1} ` +
        `(r=${a.radius}): distance ${gap(b.colour).toFixed(4)} vs ${gap(a.colour).toFixed(4)}`
    );
  // The near band must be well clear of black in linear terms. 0.05 linear is
  // roughly display 60 after tone mapping, which is the floor below which the
  // stack stops being separable at all.
  if (luma(HORIZON_BANDS[0].colour) < 0.05)
    throw new Error(
      `vegHorizonBands: near band luma ${luma(HORIZON_BANDS[0].colour).toFixed(4)} linear will render as` +
        ` a black cutout; these are linear scene-referred values, not display values`
    );
}
