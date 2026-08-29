import * as THREE from "three";

/**
 * One isolated post on open asphalt, under `?lpost=1`. A measurement rig, not
 * scene content.
 *
 * ## Why a purpose-built pose was necessary
 *
 * Contact hardening is a claim about a *mechanism*: penumbra width grows with
 * the distance between occluder and receiver. Every attempt to measure that in
 * the existing poses failed for the same reason — there was nothing in frame
 * whose occluder-to-receiver distance varied along a single measurable edge
 * while everything else stayed fixed. Measuring across two frames gave n=2
 * matched edges and a sign flip, which is suggestive and not evidence, and it is
 * why PCSS is still behind a flag despite improving every number it touches.
 *
 * A single vertical post fixes that completely. At a 6.2 degree sun a post of
 * height h lays a shadow h/tan(6.2) = 9.2h long, and the point on the ground at
 * distance d from the base is shadowed by the point on the post at height
 * d*tan(6.2), whose light-path length to the ground is d/cos(6.2). So the
 * occluder-to-receiver distance is very nearly d itself, sweeping continuously
 * from zero at the base to the full shadow length at the tip. **One edge, one
 * frame, one varying quantity.**
 *
 * The predicted penumbra half-width perpendicular to the edge is
 * `d * tan(sunAngularRadius)`, which at the project's 0.0185 rad sun is 1.85 cm
 * per metre of distance from the base. Over an 11 m shadow that is a 20 cm
 * penumbra at the tip against essentially zero at the base — far larger than any
 * filter kernel could imitate, and *monotonic*, which is the part a kernel
 * cannot fake.
 *
 * ## Why the comparison is PCSS-against-PCF row by row
 *
 * Perspective makes image-space width shrink with distance, so raw widths down
 * the frame are not comparable to each other. Taking the ratio of the two
 * treatments **at the same row** cancels perspective exactly, because both arms
 * see identical geometry through an identical camera.
 *
 * That turns the test into a sign flip along one edge: near the base PCSS should
 * be *sharper* than the constant kernel (ratio < 1) and near the tip it should
 * be *softer* (ratio > 1). A uniformly wider or narrower kernel moves every row
 * the same way and cannot produce a crossing, so the crossing is the signature
 * of contact hardening specifically rather than of softness generally.
 */

/** Height in metres. Short on purpose: 9.2x is a long shadow. */
const POST_HEIGHT = 1.5;
// Radius is set by physics, not by looks. A post of radius R at sun half-angle
// theta has NO umbra beyond R/tan(theta), because past that the penumbrae from
// opposite limbs overlap and the shadow fades to nothing. At the project's
// 0.0185 rad sun the first rig's 6 cm radius gave an umbra only 3.2 m down an
// 11 m shadow, and the far rows duly came back as "faint" - the measurement was
// being defeated by the effect it was measuring. 25 cm buys an umbra to 13.5 m,
// which covers the whole shadow.
const POST_RADIUS = 0.25;
/** Low platform, so the rig never depends on unknown terrain height. */
const PAD_Y = 0.6;
const PAD_SIZE = 18.0;

function shadowLengthFor(height: number, sunDirection: THREE.Vector3): number {
  const elevation = Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1));
  return height / Math.tan(elevation);
}

export interface PostRigResult {
  readonly group: THREE.Group;
  readonly info: Record<string, unknown>;
}

export function createPostRig(
  scene: THREE.Scene,
  sunDirection: THREE.Vector3,
  at: { x: number; z: number }
): PostRigResult {
  const group = new THREE.Group();
  group.name = "lighting-postrig";

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.32, 0.32, 0.33),
    roughness: 0.72,
    metalness: 0.0,
  });

  const post = new THREE.Mesh(new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, POST_HEIGHT, 20), mat);
  post.position.set(at.x, PAD_Y + POST_HEIGHT * 0.5, at.z);
  post.castShadow = true;
  // Receiving is pointless on a 12 cm cylinder and only invites self-shadow
  // acne that would be mistaken for the thing being measured.
  post.receiveShadow = false;
  post.name = "lighting-postrig-post";
  group.add(post);

  // A high-albedo receiver target under the shadow.
  //
  // The first version measured the shadow on bare asphalt and the edge contrast
  // came out at 33 luma levels falling to 6 — far too faint to fit an edge to,
  // and the ratio it produced was meaningless. The cause is the same low-sun
  // geometry that this project has now met three times: at 6.2 degrees a
  // horizontal surface receives sin(6.2) = 10.8% of the beam, so on flat ground
  // the ambient dominates and lit-versus-shadow is a small absolute difference
  // on top of a dark asphalt albedo. **Horizontal ground is the worst available
  // penumbra receiver at this sun elevation.**
  //
  // Raising the receiver's albedo multiplies the absolute difference without
  // touching the shadow's geometry, and penumbra width is purely geometric, so
  // this buys contrast for free and biases nothing. It is a measurement target
  // in the sense a grey card is: present because it is being measured against.
  // Deliberately a large SQUARE pad, and deliberately lifted well clear of the
  // ground, because both of the clever versions failed:
  //
  // - Sizing it to the shadow required rotating it to the sun's bearing, and
  //   `rotation.x = -PI/2` followed by `rotation.z` does not compose into "flat,
  //   turned about the vertical axis" under three's default XYZ Euler order. A
  //   square needs no bearing at all, so the whole problem is deleted rather
  //   than fixed.
  // - At 1 cm it was invisible: Terrain has real relief now, so local ground
  //   height is not 0 and the pad was buried. Guessing a smaller offset just
  //   re-runs the same gamble against a number I do not know.
  //
  // PAD_Y is therefore a low platform, and the post stands ON the pad, so the
  // rig's internal geometry is exact regardless of what the terrain is doing
  // underneath. Absolute height is irrelevant to a penumbra, which depends only
  // on the occluder-to-receiver distance the rig defines itself.
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(PAD_SIZE, PAD_SIZE),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(0.68, 0.67, 0.65), roughness: 0.9, metalness: 0.0 })
  );
  pad.rotation.x = -Math.PI / 2;
  const azimuth = Math.atan2(-sunDirection.z, -sunDirection.x);
  const half = shadowLengthFor(POST_HEIGHT, sunDirection) * 0.5;
  pad.position.set(at.x + Math.cos(azimuth) * half, PAD_Y, at.z + Math.sin(azimuth) * half);
  pad.receiveShadow = true;
  pad.castShadow = false;
  pad.name = "lighting-postrig-pad";
  group.add(pad);

  scene.add(group);

  // Predicted geometry, published so a capture can be checked against the
  // physics rather than against an expectation typed in by hand. The elevation
  // is recovered from the sun direction instead of re-reading the constant, so
  // that `?sunel=` sweeps stay consistent with the rig.
  const elevation = Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1));
  const shadowLength = POST_HEIGHT / Math.tan(elevation);
  const groundAzimuth = Math.atan2(-sunDirection.z, -sunDirection.x);

  return {
    group,
    info: {
      height: POST_HEIGHT,
      radius: POST_RADIUS,
      base: [at.x, at.z],
      elevationDeg: THREE.MathUtils.radToDeg(elevation),
      shadowLength,
      // Where the tip lands, so a pose can be aimed without guessing.
      tip: [at.x + Math.cos(groundAzimuth) * shadowLength, at.z + Math.sin(groundAzimuth) * shadowLength],
      penumbraHalfWidthPerMetre: Math.tan(0.0185),
    },
  };
}
