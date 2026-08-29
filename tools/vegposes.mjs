#!/usr/bin/env node
/**
 * The capture poses, and the capture viewport, as data.
 *
 * Extracted from shoot6 so that a CPU-only tool can reason about what a shot
 * will contain without launching a browser, and — more importantly — without
 * a second copy of the numbers. A probe that disagrees with the capture about
 * where the camera is will confidently answer the wrong question.
 */

export const WIDTH = 1600;
export const HEIGHT = 900;

/**
 * `eye` is metres above the walkable surface at the camera's XZ.
 *
 * The sun sits at 6.2 degrees on azimuth 203 degrees, so it lies toward -X-Z
 * and every shadow is thrown toward +X, slightly +Z. The `pines` pose stands
 * downwind of that and looks back up the shadows.
 */
export const POSES = {
  // From the far shoulder of the highway: the framing shot. Shows the site
  // against the horizon band, the pole line, and the pine across the road.
  approach: { pos: [-30.0, 0, -7.6], eye: 1.65, look: [-1.0, 1.6, 20.0], fov: 46 },
  // Knee height at the pavement-to-dirt boundary in front of the lot, where
  // weeds should be coming through the seam and up the back of the curb.
  // Looking *along* the asphalt-to-dirt seam rather than across it, so the
  // run of weeds in the crack recedes through the frame. Across it, the seam
  // is a single line eight pixels tall and the shot proves nothing.
  edge: { pos: [-27.0, 0, 6.15], eye: 0.5, look: [8.0, 0.3, 7.2], fov: 44 },
  // Standing where the pines' shadows land, looking back along them.
  pines: { pos: [14.0, 0, 34.0], eye: 1.62, look: [-32.0, 6.0, 19.0], fov: 55 },
  // Out over the open country: the scale question, nothing else in frame.
  // Out over the open country: the scale question, nothing else in frame.
  // Swung south of the previous heading, which put a 2.6 m sapling twelve metres
  // from the lens directly across the treeline this shot exists to show. A
  // foreground plant is a good scale cue but not when it is the subject.
  horizon: { pos: [34.0, 0, 20.0], eye: 1.65, look: [122.0, 3.0, 46.0], fov: 36 },
  // Three-quarter of the whole site in context.
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },
  // Sun BEHIND the camera, which no other preset in this file has.
  //
  // Added because "sunlit crowns do not separate from shadowed ones" has now
  // appeared in three reviews and not one of the six poses could answer it:
  // sunDirection is (-0.92, 0.11, -0.39), every preset looks roughly along it,
  // so every crown in every capture has been lit from the far side. That is a
  // property of my pose selection, not necessarily of the foliage, and until one
  // frame shows a lit crown neither I nor a critic can tell which. Looking the
  // other way down the same axis puts the 6.2 degree sun over the camera's
  // shoulder and onto the near faces.
  // Checked with the dot product rather than by eye, because my first attempt at
  // this pose scored forward.sunDirection = +0.48 — still back-lit, which is the
  // very thing the preset exists to escape. This one is -0.97.
  sunlit: { pos: [-32.0, 0, 9.0], eye: 1.65, look: [18.0, 5.0, 30.0], fov: 42 },
  // Long lens up the pole line, wires against open sky. This is the pose that
  // answers the wire question — the critic saw the span "dash in and out of
  // existence" and the fix is a screen-space width floor, which can only be
  // judged where the wire is far enough away to be sub-pixel geometrically and
  // against a background bright enough to show any hole in it. Crop and probe
  // this one per-pixel along the span; a whole-image diff will not see a wire.
  wires: { pos: [-21.0, 0, -18.0], eye: 1.7, look: [-16.0, 6.2, 52.0], fov: 30 },
  /*
   * Eye height inside the west pine grove, looking at the ground under a crown.
   *
   * Added because the debris skirt could not be judged from any of the eight
   * poses above, and the reason was a property of the pose set rather than of
   * the skirt: litter exists only under crowns, and not one camera stands under
   * one. The skirt moved 294 px in `edge` and 546 in `pines`, entirely in the
   * mid-distance band, and nothing at all in the near foreground — which is not
   * "too small to see", it is "not in frame". A sub-pixel scatter and an absent
   * one are the same screenshot, so a pose that resolves it is the only way to
   * tell whether the item shapes are any good.
   *
   * It is also the distance the deliverable uses. The take is a first-person
   * walk, so a player passes under these crowns at 1.6 m with the ground two to
   * five metres from the lens, and that is the only distance at which litter is
   * geometry rather than a tint.
   *
   * Aimed at published geometry, not at a guess: `debrisScatter.widestCrowns`
   * lists the five widest crown discs, and the look point sits 1.4 m from the
   * centre of the 9.8 m pine at (-38.5, 19.5), inside its 2.6 m litter radius.
   * The camera stands 3.9 m off that trunk, outside the radius, so the trunk is
   * behind the lens and the frame is ground rather than bark. A pose aimed at a
   * coordinate that happened to miss would look identical to a broken skirt,
   * which is the confusion this pose exists to end.
   *
   * Cross-lit rather than back- or front-lit: the sun is on azimuth 203 degrees
   * and this looks -X +Z, so light rakes across the litter at 6.2 degrees. Flat
   * scatter and scatter with relief differ most under raking light and are hard
   * to separate under either of the other two.
   */
  underpine: { pos: [-36.0, 0, 16.5], eye: 1.6, look: [-39.5, 0.2, 20.5], fov: 50 },
  /*
   * The three standing positions, looking along the highway.
   *
   * Added because the far scrub is judged from where a person stops, and the
   * eight poses above are framing choices — the two that see the far fringe at
   * all (`horizon`, `approach`) do it from the shoulder or across the country,
   * not from the forecourt. The user walks freely, so the places to check are
   * the places there is a reason to stand: the middle of the forecourt, the
   * pump island, the store door. Those are also the exact coordinates every
   * density figure in `tools/vegfringe.mjs` is computed at, so a frame and a
   * table can be put beside each other without a coordinate change in between.
   *
   * All three look **along** the road rather than across it, for the same reason
   * `edge` looks along the seam: the layers under test are a ribbon, and a
   * ribbon seen end-on recedes through the frame at every distance at once. One
   * frame then contains the 55-70 m handover band, the 100-190 m stretch of the
   * fringe sheet, and the 230 m end of the corridor — the three questions on the
   * capture list are the same pixels at different depths.
   *
   * `forecourt` and `storedoor` look -X, `pumpisland` looks +X, so the pair
   * covers both ends of a scatter that is symmetric in x and neither end is
   * taken on trust from the other. The sun is on azimuth 203 degrees, toward
   * -X-Z, so the -X pair is back-lit — which is the harder case for a ground
   * sheet, since a grazing sun behind the subject is what makes a flat layer
   * read as paint.
   */
  forecourt: { pos: [0.0, 0, 10.0], eye: 1.65, look: [-150.0, 2.0, -6.0], fov: 48 },
  pumpisland: { pos: [0.0, 0, 18.0], eye: 1.65, look: [150.0, 2.0, -4.0], fov: 48 },
  storedoor: { pos: [0.0, 0, 30.0], eye: 1.65, look: [-140.0, 3.0, -8.0], fov: 48 },
};
