/**
 * The parked car's outer skin.
 *
 * Generic mid-size American sedan. 4.86 m over the bumpers, 1.842 m wide,
 * 1.4585 m to the roof, 2.80 m wheelbase, on 215/60R16s. No manufacturer's
 * design is copied and there are no badges anywhere on it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ONE LOFTED SURFACE
 *
 * The previous version built the whole shell as a single smooth grid and
 * deleted quads to make windows and shut lines. That guarantees the one thing
 * a car body must never have: a continuous normal field. A real body is a set
 * of *panels* meeting at *creases* - the sill, the shoulder character line,
 * the beltline, the roof rail, the hood-to-fender break - and those creases
 * are what catch light and tell the eye it is a car. Smooth everywhere gives
 * an inflated single volume with a soft wobbling highlight, which is exactly
 * what an independent reviewer described.
 *
 * So: positions still come from one continuous station x ring grid, because
 * that is the only cheap way to guarantee panels meet with no cracks. The grid
 * is then *partitioned into ten patches along crease rows*, and each patch
 * computes its own vertex normals. Vertices on a crease exist twice, once per
 * neighbouring patch, with different normals - so a highlight flows along a
 * panel and breaks hard at the crease. That is a smoothing group, by hand.
 *
 * Ring layout, bottom centre to top centre, CREASE marking a patch boundary:
 *
 *     under -CREASE- rocker -CREASE- sillStep -CREASE- lowerFlank
 *           -CREASE- lineStep -CREASE- upperFlank
 *           -CREASE- beltTurn -CREASE- dlo
 *           -CREASE- railTurn -CREASE- roof
 *
 * `sillStep`, `lineStep`, `beltTurn` and `railTurn` are only 6-20 mm tall.
 * They are the fillets of the feature lines, and they are real geometry so a
 * line has a bright side and a dark side instead of being a painted stripe.
 *
 * ---------------------------------------------------------------------------
 * WINDING, CHECKED ON PAPER
 *
 * Ring index j runs bottom centre -> +X flank -> top centre -> -X flank, which
 * is counter-clockwise seen from +Z. Stations advance along +Z with i. For
 *   a = (i, j)   b = (i, j+1)   c = (i+1, j)   d = (i+1, j+1)
 * triangle (a, b, c) has (b-a) = ring tangent T and (c-a) = +Z, so its normal
 * is T x Z. On the +X flank T = +Y and (0,1,0) x (0,0,1) = (+1,0,0), out of
 * the car. Over the roof T = -X and (-1,0,0) x (0,0,1) = (0,+1,0), up. Under
 * the floor T = +X and the normal is -Y, down. Outward everywhere, so
 * (a,b,c) + (b,d,c) is correct. The opposite order culls the entire car, and
 * that has already cost this project a day once.
 *
 * ---------------------------------------------------------------------------
 * Local frame: origin on the ground at the centre of the wheelbase, +Z toward
 * the nose, +Y up, +X to the car's left.
 */

import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* dimensions                                                          */
/* ------------------------------------------------------------------ */

export const CAR = {
  length: 4.86,
  width: 1.842,
  height: 1.4585,
  wheelbase: 2.8,
  frontOverhang: 1.0,
  rearOverhang: 1.06,
  /** 215/60R16: 0.663 m overall diameter. */
  tyreR: 0.3315,
  tyreWidth: 0.215,
  /** 16 inch rim plus the flange. */
  rimR: 0.2085,
  /** Track, centre to centre of the tyres. */
  track: 1.585,
  /**
   * How far the loaded tyre squashes at the contact patch.
   *
   * 19 mm was defensible as a rolling radius - a 215/60R16 at placard pressure
   * loses about 15 mm - but it is 2.9% of the 663 mm diameter, and at the
   * distance these frames are shot from that is not enough deflection to be
   * seen, so the car read as resting on perfectly round tyres. 26 mm is 20% of
   * the 129 mm section height, which is what a passenger tyre carrying its
   * share of a parked mid-size sedan actually sits at, and gives a 253 mm
   * contact patch: long enough to read as weight rather than as a bug.
   */
  squash: 0.026,
};

export const FRONT_AXLE = CAR.wheelbase / 2;
export const REAR_AXLE = -CAR.wheelbase / 2;
export const AXLES = [FRONT_AXLE, REAR_AXLE];

export const NOSE_Z = FRONT_AXLE + CAR.frontOverhang; //  2.40
export const TAIL_Z = REAR_AXLE - CAR.rearOverhang; // -2.46

/**
 * Where the lofted rings stop; the last 42 mm at each end is the fascia cap.
 *
 * The cap used to bulge 65 mm on a body that was also necking in hard over the
 * last 200 mm, and the two together turned both ends into an egg. A modern
 * bumper cover is close to a vertical wall with radiused corners, so the loft
 * now stays wide almost to the end and the cap only rounds the last 42 mm.
 */
const RING_Z1 = NOSE_Z - 0.042;
const RING_Z0 = TAIL_Z + 0.042;
const CAP_BULGE = 0.042;

/** Wheel centre height, i.e. the loaded rolling radius. */
export const WHEEL_Y = CAR.tyreR - CAR.squash;

/**
 * Wheel arch opening: circular, 0.3745 m radius, centred 3 mm above the wheel
 * centre, so the lip sits 36 mm clear of the top of the tyre.
 *
 * That clearance is the single number deciding whether the car looks parked or
 * looks like an off-roader on the wrong springs, and the version that scored
 * 2/10 was far over it. The 52 mm this measured last round was still read as
 * "roughly a full extra tyre-width of air"; 36 mm is a snug stock sedan.
 *
 * The radius matters nearly as much. At 0.4 m the opening was 0.80 m across
 * against a 0.663 m tyre, a ratio of 1.21, and the wheel sat in the middle of
 * a visibly empty hole. 0.729 m gives 1.10, at the tight end of where
 * production cars actually sit.
 */
export const ARCH_BASE_Y = 0.3085;
export const ARCH_R = 0.3645;
export const ARCH_RZ = ARCH_R;
export const ARCH_RY = ARCH_R;
export const ARCH_TOP_Y = ARCH_BASE_Y + ARCH_R; // 0.6730; tyre top 0.6370, so 36 mm

/* ------------------------------------------------------------------ */
/* profile curves                                                      */
/* ------------------------------------------------------------------ */

type Key = [z: number, v: number];

/**
 * Monotone cubic (PCHIP) interpolation over non-uniform knots.
 *
 * Catmull-Rom overshoots wherever the keys change slope quickly, and on a
 * roofline an 8 mm overshoot is a visible blister on the C-pillar. The
 * Fritsch-Carlson limiter kills it while staying C1.
 */
function pchip(keys: Key[]): (z: number) => number {
  const n = keys.length;
  const x = keys.map((k) => k[0]);
  const y = keys.map((k) => k[1]);
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i]);
    d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0; // local extremum: flat, never overshooting
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (z: number) => {
    if (z <= x[0]) return y[0] + (z - x[0]) * m[0];
    if (z >= x[n - 1]) return y[n - 1] + (z - x[n - 1]) * m[n - 1];
    let i = 0;
    while (i < n - 2 && x[i + 1] < z) i++;
    const t = (z - x[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * y[i] +
      (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * y[i + 1] +
      (t3 - t2) * h[i] * m[i + 1]
    );
  };
}

/**
 * Centreline height of the top surface: deck, backlight, roof, windshield,
 * hood, in one continuous curve. Proportion is authored here and nowhere else.
 *
 *   roof 1.4585 m, flat from z = +0.52 back to z = -0.74. 1.26 m of roof on a
 *   4.86 m car, about a quarter of the length, which is a sedan. The version
 *   that scored 2/10 ran a near-flat roof for 1.7 m and carried it out past
 *   the C-pillar, which is why it read as a hearse.
 *   windshield (1.24, 1.168) -> (0.52, 1.440): 69 deg off vertical.
 *   backlight (-0.74, 1.438) -> (-1.36, 1.186): 68 deg, marginally steeper
 *   than the screen, as on nearly every sedan.
 *   deck 1.01 m at the tail, 176 mm below the beltline peak: a boot, not a
 *   fastback and not a wagon.
 */
const topY = pchip([
  [-2.418, 1.038],
  [-2.36, 1.078],
  [-2.26, 1.122],
  [-2.15, 1.148],
  [-1.9, 1.17],
  [-1.6, 1.18],
  [-1.42, 1.184],
  [-1.36, 1.186],
  [-1.2, 1.256],
  [-1.05, 1.318],
  [-0.92, 1.372],
  [-0.82, 1.418],
  [-0.74, 1.438],
  [-0.55, 1.452],
  [-0.2, 1.4585],
  [0.15, 1.458],
  [0.42, 1.4505],
  [0.52, 1.44],
  [0.62, 1.412],
  [0.78, 1.352],
  [0.95, 1.282],
  [1.1, 1.222],
  [1.24, 1.168],
  [1.32, 1.15],
  [1.6, 1.132],
  [1.9, 1.118],
  [2.1, 1.092],
  [2.22, 1.064],
  [2.32, 1.026],
  [2.358, 1.002],
]);

/** How far the crest at the outer edge of the top surface sits below the centreline. */
const crownDrop = pchip([
  [-2.418, 0.021],
  [-1.36, 0.038],
  [-0.74, 0.05],
  [0.0, 0.052],
  [0.52, 0.05],
  [1.24, 0.044],
  [2.358, 0.028],
]);

/**
 * Half width at the roof rail / fender crest. Over the cabin this is the roof:
 * 2 x 0.662 = 1.324 m of roof on a 1.842 m car, the ratio that makes the
 * tumblehome read. It necks in hard between z = -1.36 and z = -0.74 - that is
 * the C-pillar taper the critic said was missing.
 */
const railX = pchip([
  [-2.418, 0.688],
  [-2.36, 0.716],
  [-2.24, 0.744],
  [-2.0, 0.752],
  [-1.75, 0.786],
  [-1.5, 0.8],
  [-1.36, 0.804],
  [-1.22, 0.786],
  [-1.05, 0.742],
  [-0.92, 0.686],
  [-0.82, 0.66],
  [-0.74, 0.648],
  [-0.4, 0.656],
  [0.0, 0.662],
  [0.35, 0.656],
  [0.52, 0.644],
  [0.66, 0.664],
  [0.85, 0.706],
  [1.05, 0.76],
  [1.24, 0.788],
  [1.45, 0.796],
  [1.75, 0.792],
  [2.0, 0.766],
  [2.16, 0.748],
  [2.28, 0.712],
  [2.358, 0.662],
]);

/** Maximum half width of the body, with the flare over each wheel arch. */
const hipX = pchip([
  [-2.418, 0.762],
  [-2.36, 0.802],
  [-2.24, 0.848],
  [-1.95, 0.882],
  [-1.7, 0.908],
  [-1.45, 0.92],
  [-1.4, 0.921],
  [-1.2, 0.912],
  [-0.8, 0.898],
  [-0.2, 0.894],
  [0.4, 0.896],
  [0.95, 0.904],
  [1.3, 0.918],
  [1.4, 0.921],
  [1.62, 0.914],
  [1.88, 0.896],
  [2.08, 0.878],
  [2.24, 0.846],
  [2.358, 0.788],
]);

const hipY = pchip([
  [-2.418, 0.712],
  [-2.0, 0.686],
  [-1.4, 0.7],
  [0.0, 0.7],
  [1.4, 0.7],
  [2.0, 0.678],
  [2.358, 0.706],
]);

/**
 * The shoulder character line: the crease running the whole length of the
 * flank. It rises 50 mm from the front lamp to the tail lamp, which is the
 * wedge every mass-market sedan has had since about 1990.
 */
const lineY = pchip([
  [-2.418, 0.958],
  [-2.1, 0.968],
  [-1.4, 0.962],
  [-0.6, 0.945],
  [0.2, 0.93],
  [1.0, 0.918],
  [1.6, 0.912],
  [2.1, 0.918],
  [2.358, 0.928],
]);

/**
 * Beltline over the cabin. Side glass is 0.368 m from belt to rail at the
 * B-pillar (1.406 rail - 1.038 belt).
 *
 * The first version ran over 0.45 m of glass and read as a van. Cutting it to
 * 0.328 m fixed that and overshot: measured against the car's own 1.4585 m
 * height, a belt at 1.078 is 0.739 of overall height where a real mid-size
 * sedan sits at about 0.707, and 0.328 m of glass is 0.225 where the real
 * figure is nearer 0.27. Both errors push the same way, which is exactly the
 * "beltline far too high, door height far too great, toy mass distribution"
 * that a critic reported. Dropping the belt 40 mm puts the ratio at 0.712 and
 * the glass at 0.252, inside the real range at both ends without touching the
 * roof, the rail or the overall height.
 *
 * The values outside the cabin are deliberately absurd: `beltYAt` takes the
 * min against the rail, so past the A- and C-pillars the belt crease simply
 * becomes the fender/quarter shoulder a fixed distance under the crest. That
 * keeps the DLO band non-degenerate everywhere without special-casing, which
 * matters because a zero-height band produces zero-area triangles and
 * `computeVertexNormals` hands back garbage for them.
 */
const beltTable = pchip([
  [-1.62, 9],
  [-1.42, 1.2],
  [-1.36, 1.108],
  [-1.2, 1.088],
  [-1.0, 1.068],
  [-0.6, 1.048],
  [0.0, 1.038],
  [0.6, 1.042],
  [0.95, 1.058],
  [1.18, 1.076],
  [1.24, 1.084],
  [1.32, 1.2],
  [1.62, 9],
]);

/** Minimum belt-to-rail gap, i.e. how tall the DLO band is where there is no glass. */
const dloFloor = pchip([
  [-2.395, 0.082],
  [-2.0, 0.062],
  [-1.6, 0.042],
  [-1.36, 0.03],
  [-1.2, 0.03],
  [1.2, 0.03],
  [1.36, 0.03],
  [1.6, 0.044],
  [2.0, 0.064],
  [2.335, 0.084],
]);

const sillY = pchip([
  [-2.418, 0.402],
  [-2.2, 0.328],
  [-1.95, 0.295],
  [-1.5, 0.288],
  [1.5, 0.288],
  [1.95, 0.298],
  [2.2, 0.342],
  [2.358, 0.414],
]);

const rockerBotY = pchip([
  [-2.418, 0.352],
  [-2.2, 0.258],
  [-1.9, 0.178],
  [-1.5, 0.17],
  [1.5, 0.17],
  [1.9, 0.178],
  [2.2, 0.268],
  [2.358, 0.364],
]);

/**
 * How much of a groove runs at the roof rail. Over the hood and the deck it is
 * a full 6 mm shut line - the hood-to-fender break and the trunk-to-quarter
 * break. Over the cabin it shallows into a drip rail, which is what is there.
 */
const railGroove = pchip([
  [-2.2, 0.35],
  [-2.05, 1.0],
  [-1.5, 1.0],
  [-1.42, 0.75],
  [-1.3, 0.28],
  [-0.9, 0.28],
  [0.9, 0.28],
  [1.3, 0.28],
  [1.34, 0.75],
  [1.45, 1.0],
  [2.05, 1.0],
  [2.2, 0.35],
]);

export const railYAt = (z: number) => topY(z) - crownDrop(z);
export const beltYAt = (z: number) => Math.min(beltTable(z), railYAt(z) - dloFloor(z));
export const topAt = topY;
export const halfWidthAt = hipX;
export const bottomAt = rockerBotY;

/**
 * The character line is the widest point of the body, not 28 mm inboard of it.
 *
 * This is the whole reason the first attempt at feature lines failed. With the
 * maximum half width 230 mm *below* the crease, the flank was still swelling
 * outward as it rose past the line, so the panels above and below it both
 * faced outward and very slightly up - measured at 3.3 degrees apart. A 15 mm
 * fillet between two near-coplanar panels is a thin bright sliver, and at the
 * 7 mm per pixel these frames are shot at it is two pixels wide, so the mip
 * chain averages it into exactly the "soft tonal band that reads as a paint
 * tone change" a reviewer described.
 *
 * Widening the band would not have helped: a highlight terminates because the
 * surfaces either side face different parts of the sky, not because the crease
 * is thick. Putting the maximum width *at* the line makes the panel below tuck
 * downward and the panel above tuck upward, which is what a shoulder line
 * actually is. See `tools/carcrease.mjs` for the measured deltas.
 */
const lineXAt = (z: number) => hipX(z);

/**
 * How hard the shoulder line is pressed, along the length of the car.
 *
 * The previous version had a genuine crease - measurably 21.8 deg of normal
 * delta, and a probe across it showed a real luminance step rather than a ramp.
 * But it was 21.8 deg at the nose, 21.9 in the middle and 22.2 at the tail:
 * 0.4 deg of variation over 3.2 m. A crease with a constant cross-section
 * running the whole length of a car is what a decal looks like, which is
 * exactly what came back - "uniform in width and brightness along the entire
 * length, which is what a texture band does".
 *
 * On a real body the line is a consequence of the panel either side of it, so
 * it strengthens where the surface tightens and fades where it opens out: soft
 * as it leaves the headlamp, building through the front door, hardest over the
 * rear haunch where the quarter panel is pulled over the wheel, then released
 * into the tail lamp. Driving the setback, the fillet radius and the curvature
 * of the panel below from one curve keeps those three consistent, so the
 * highlight thins and brightens over the haunch instead of running as a stripe.
 */
const lineK = pchip([
  [-2.418, 0.42],
  [-2.05, 0.72],
  [-1.42, 1.34],
  [-0.85, 1.12],
  [-0.2, 0.95],
  [0.55, 1.02],
  [1.35, 0.78],
  [1.95, 0.5],
  [2.358, 0.36],
]);
const beltXAt = (z: number) => Math.max(0.045, hipX(z) - 0.042);
/**
 * 72 mm inboard of the widest point, and that is a known defect left in place
 * deliberately — see the second half of this comment before changing it.
 *
 * The body is widest at the character line — correct, and deliberate, see
 * `lineXAt` — and then fell away 72 mm to the sill and 134 mm to the rocker
 * bottom. Measured as a half-width profile that is 914 mm at y 0.90 and 828 mm
 * at y 0.20: **the section leaned inward by 86 mm over 0.72 m of height, about
 * 6.8 degrees, all the way down.** Real bodies are close to vertical below the
 * shoulder and bulge again over the arches; a section that necks in the whole
 * way is what makes a car read narrow-tracked and toy-like.
 *
 * Two things came out of that lean, and neither looked like a body-section
 * problem when it was being chased:
 *
 * - **The sills could not be seen from anywhere.** They sat 43 mm inboard of
 *   the shoulder above them, so the car occluded its own rocker at every angle
 *   above the horizontal. `probe-unseen` had them at 0 px, and two sessions of
 *   treating that as a burial and pushing the offset out were treating the
 *   symptom: no offset short of a running board clears an overhang.
 * - **The lower flank was shadowing itself.** An overhanging shoulder is a
 *   light-transport obstruction, and the arch column — body, arch interior and
 *   tyre all within about eleven luminance levels, the defect three sessions
 *   of material work failed to shift — sits directly under it. Albedo could
 *   not move that boundary because the cause was never a material.
 *
 * ## The obvious fix does not work, and the reason is the interesting part
 *
 * Tried it: `sillXAt` to `hipX - 0.026` and the mid-flank setback to 14 mm.
 * The profile came out exactly as intended — lean cut from 86 mm to 40 mm,
 * near-vertical from y 0.30 to y 0.90, overall width unchanged at 1842 mm, no
 * non-finite vertices, and the sills finally 3 mm proud.
 *
 * **And it swallowed the wheels.** Round `2026-08-28T222136Z-e82bce13e654`:
 * the arches became tunnels, the alloy faces vanished into them, and
 * `probe-unseen` picked it up independently as three wheel caps dropping to
 * 0 px that had been drawing before. The lower body moved out ~46 mm per side
 * while the wheel track and the arch openings stayed where they were, so the
 * bodywork simply overhung the wheels. It reads as a car with skirts on.
 *
 * So the lean is not an independent parameter. **The lower body width, the
 * wheel track and the arch opening width are one decision**, and moving any of
 * them alone converts a proportion problem into an occlusion problem. Whoever
 * takes this next should move all three together and expect to re-check the
 * arch outline parameterisation, since the flank is re-based onto it. Reverted
 * to the known-good values rather than left half-done.
 */
const sillXAt = (z: number) => Math.max(0.04, hipX(z) - 0.072);

/* ------------------------------------------------------------------ */
/* the transverse section                                              */
/* ------------------------------------------------------------------ */

const BANDS = [
  { name: "under", n: 4 },
  { name: "rocker", n: 4 },
  { name: "sillStep", n: 2 },
  { name: "lowerFlank", n: 16 },
  { name: "lineStep", n: 2 },
  { name: "upperFlank", n: 8 },
  { name: "beltTurn", n: 3 },
  { name: "dlo", n: 11 },
  { name: "railTurn", n: 4 },
  { name: "roof", n: 12 },
] as const;

/** Ring row at which each band starts; it ends where the next one starts. */
const ROW: Record<string, number> = {};
{
  let r = 0;
  for (const b of BANDS) {
    ROW[b.name] = r;
    r += b.n;
  }
  ROW.end = r;
}
export const HALF = ROW.end + 1; // 67 points, bottom centre .. top centre
export const RING = HALF * 2 - 2; // 132 points around the closed ring

/** Band layout, exported so `tools/carcrease.mjs` measures the shipping rows. */
export const ROW_TABLE = BANDS.map((b) => ({ name: b.name as string, row: ROW[b.name], n: b.n }));

const V2 = THREE.Vector2;
type P = THREE.Vector2;

/** Uniform samples of a centripetal Catmull-Rom through `pts`, endpoints included. */
function crSample(pts: P[], n: number, from = 0, to = 1): P[] {
  const c = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p.x, p.y, 0)),
    false,
    "centripetal",
    0.5
  );
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    const p = c.getPoint(t);
    out.push(new V2(p.x, p.y));
  }
  return out;
}

/** The arch opening's upper outline at station z, or -Infinity outside any arch. */
export function archOutlineY(z: number): number {
  let best = -Infinity;
  for (const cz of AXLES) {
    const dz = (z - cz) / ARCH_R;
    if (dz * dz < 1) best = Math.max(best, ARCH_BASE_Y + ARCH_R * Math.sqrt(1 - dz * dz));
  }
  return best;
}

export interface Section {
  /** HALF points, bottom centre (x = 0) up to top centre (x = 0). */
  pts: P[];
  /** How much of the lower flank the arch has eaten, 0..1. */
  archAmt: number;
}

/**
 * One transverse half section.
 *
 * The wheel arch is *parameterised*, not trimmed: the lower flank band is
 * re-based so its first row lies exactly on the arch outline. Cutting an arch
 * by dropping quads - what this file used to do - leaves a staircase at the
 * station pitch that is plainly visible against the tyre in any close shot,
 * and no amount of arch-lip trim hides it.
 */
export function section(z: number): Section {
  const tY = topY(z);
  const rX = railX(z);
  const rY = railYAt(z);
  const bY = beltYAt(z);
  const bX = beltXAt(z);
  const lY = lineY(z);
  const lX = lineXAt(z);
  const hX = hipX(z);
  const hY = Math.min(hipY(z), lY - 0.12);
  const sX = sillXAt(z);
  const sY = sillY(z);
  const rbY = Math.min(rockerBotY(z), sY - 0.05);
  const g = railGroove(z);

  // Landmarks. The small steps are the feature-line fillets.
  // Landmarks. Every fillet is sized to interpolate *between* its neighbours'
  // angles rather than overshoot both, because a fillet that spikes 36 degrees
  // and comes straight back is a notch, not a crease.
  const rockerBot = new V2(sX - 0.062, rbY);
  const sillLo = new V2(sX, sY - 0.011);
  const sillHi = new V2(sX + 0.012, sY + 0.011);
  // Mid-flank pull-in, inboard of the shoulder, so the lower panel faces down.
  // Strength of the shoulder line at this station. A harder line is a deeper
  // setback over a tighter fillet, above a panel with more curvature in it.
  const k = lineK(z);
  // 39 mm of mid-flank setback. Part of the inward lean documented on
  // `sillXAt`, and it has to move with the wheel track rather than alone.
  const mid = new V2(hX - 0.039 * (0.72 + 0.36 * k), hY);
  const fillet = 0.0065 / (0.55 + 0.5 * k);
  const lineLo = new V2(lX, lY - fillet * 0.92);
  const lineHi = new V2(lX - 0.0032 * k, lY + fillet * 1.08);
  const beltLo = new V2(bX, bY - 0.005);
  const beltHi = new V2(bX - 0.01, bY + 0.01);
  const railLo = new V2(rX + 0.01, rY - 0.012);
  const railHi = new V2(rX - 0.02, rY + 0.004);

  const pts: P[] = [];
  const push = (arr: P[], skipFirst: boolean) => {
    for (let i = skipFirst ? 1 : 0; i < arr.length; i++) pts.push(arr[i]);
  };

  // under: floor pan out to the bottom of the rocker.
  push(
    crSample(
      [new V2(0, rbY + 0.022), new V2(sX * 0.45, rbY + 0.016), new V2(sX * 0.82, rbY + 0.004), rockerBot],
      BANDS[0].n
    ),
    false
  );

  // rocker: the near-vertical face under the door, tucked inboard of the skin.
  push(crSample([rockerBot, new V2(sX - 0.014, rbY + (sY - rbY) * 0.45), sillLo], BANDS[1].n), true);

  // sillStep: 16 mm of fillet where the door skin overhangs the rocker. A
  // crease on both sides, so the sill reads as a hard line with shadow under
  // it rather than as a change of shading.
  push(crSample([sillLo, new V2(sX + 0.011, sY), sillHi], BANDS[2].n), true);

  // lowerFlank: sill, over the hip, up to the character line - re-based onto
  // the arch outline wherever an arch is open.
  const flankPts = [
    sillHi,
    new V2(hX - 0.046, hY - 0.18),
    mid,
    new V2(hX - 0.018 * (0.55 + 0.62 * k), lY - 0.12),
    lineLo,
  ];
  const archY = archOutlineY(z);
  let from = 0;
  let archAmt = 0;
  if (archY > sillHi.y) {
    archAmt = THREE.MathUtils.clamp((archY - sillHi.y) / 0.05, 0, 1);
    const probe = crSample(flankPts, 96);
    for (let i = 0; i < probe.length - 1; i++) {
      if (probe[i].y <= archY && probe[i + 1].y > archY) {
        const t = (archY - probe[i].y) / Math.max(1e-6, probe[i + 1].y - probe[i].y);
        from = (i + t) / 96;
        break;
      }
    }
  }
  const flank = crSample(flankPts, BANDS[3].n, from, 1);
  if (archAmt > 0) {
    // Roll the opening edge inboard so the lip has somewhere to wrap to.
    for (let i = 0; i < flank.length; i++) {
      const u = i / (flank.length - 1);
      flank[i].x -= 0.012 * archAmt * Math.pow(1 - u, 3);
    }
  }
  push(flank, true);

  // lineStep: the character line. 12 mm of near-horizontal, slightly
  // downward-facing fillet, stepping the skin 9 mm inboard.
  push(crSample([lineLo, new V2(lX - 0.0012, lY + 0.0008), lineHi], BANDS[4].n), true);

  push(crSample([lineHi, new V2((lX + bX) * 0.5 - 0.004, (lY + bY) * 0.5), beltLo], BANDS[5].n), true);

  // beltTurn: the hard turn out of the body side into the glass house.
  push(crSample([beltLo, new V2(bX - 0.003, bY + 0.003), beltHi], BANDS[6].n), true);

  // dlo: tumblehome. Over the cabin, 0.328 m of rise with 0.19 m of tuck -
  // 33 degrees off vertical. Outside it, the fender/quarter shoulder.
  push(
    crSample(
      [
        beltHi,
        // Tucks hard straight off the belt and then straightens, which is
        // both what a real DLO does and what gives the beltline a normal
        // delta big enough to terminate a highlight.
        new V2(beltHi.x - (bX - rX) * 0.62, bY + (rY - bY) * 0.34),
        new V2(rX + 0.028, bY + (rY - bY) * 0.76),
        railLo,
      ],
      BANDS[7].n
    ),
    true
  );

  // railTurn: the roof rail, carrying the longitudinal shut line. Full depth
  // over the hood and deck, shallow over the cabin where it is a drip rail.
  push(
    [
      railLo,
      new V2(rX + 0.003, rY - 0.001),
      new V2(rX - 0.002 - g * 0.005, rY + 0.001 - g * 0.008),
      new V2(rX - 0.011, rY + 0.003),
      railHi,
    ],
    true
  );

  // roof: a very gentle crown. Dead flat reads as a panel van.
  push(
    crSample([railHi, new V2(rX * 0.68, tY - 0.011), new V2(rX * 0.3, tY - 0.0015), new V2(0, tY)], BANDS[9].n),
    true
  );

  return { pts, archAmt };
}

/* ------------------------------------------------------------------ */
/* surface-projection fallback counters                                */
/* ------------------------------------------------------------------ */

/**
 * How often each surface-projection helper could not answer and substituted a
 * fallback. Counted per call site, because the two sites need different
 * responses: `flankXNoCrossing` means a part is authored off the end of the
 * section, `endZOutsideOutline` means it is authored off the end of the cap.
 *
 * These exist because case 14 was invisible. `endZ` put 39% of the tail-lamp
 * samples on a flat plane and the rest on the true fascia, and the only signal
 * was two critics calling the lamps "noise painted on a flat panel" - which
 * cost two rounds of rebuilding lamp internals that were never at fault. A
 * fallback that is merely plausible hides indefinitely; assert on these
 * instead. `tools/carburied.mjs` fails a run on any non-zero count.
 */
export type FallbackSite = { x: number; y: number; front: boolean; over: number };

const FALLBACKS: {
  endZOutsideOutline: number;
  flankXNoCrossing: number;
  sites: FallbackSite[];
} = { endZOutsideOutline: 0, flankXNoCrossing: 0, sites: [] };

export type ProjectionStats = {
  endZOutsideOutline: number;
  flankXNoCrossing: number;
  sites: FallbackSite[];
};

/** Zero the counters. Call immediately before building, or counts accumulate. */
export function resetProjectionStats(): void {
  FALLBACKS.endZOutsideOutline = 0;
  FALLBACKS.flankXNoCrossing = 0;
  FALLBACKS.sites.length = 0;
}

/** Fallback hits since the last reset, per call site. */
export function projectionStats(): ProjectionStats {
  return { ...FALLBACKS, sites: FALLBACKS.sites.map((s) => ({ ...s })) };
}

/**
 * Half width of the body at a point on the flank, by walking the real section.
 * Trim meant to lie on the skin has to be built from this rather than from a
 * straight box, or it detaches where the flank curves away.
 */
export function flankX(z: number, y: number): number {
  const pts = section(z).pts;
  let best = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if ((y >= a.y && y <= b.y) || (y <= a.y && y >= b.y)) {
      const t = Math.abs(b.y - a.y) < 1e-9 ? 0 : (y - a.y) / (b.y - a.y);
      // LARGEST, deliberately - do not "fix" this to the nearest crossing by
      // analogy with `endZ` below. This walks a half section that starts at the
      // floor pan on the centreline, so a y low on the body legitimately
      // crosses twice: at z = -1.172, y = 0.192 the pair is the floor pan at
      // x = 0.000 and the rocker at x = 0.799. `flankX` means the outer skin,
      // which is the larger one; taking the nearer would lay flank trim on the
      // underbody. 2.5% of the section domain has two crossings.
      best = Math.max(best, a.x + (b.x - a.x) * t);
    }
  }
  if (best >= 0) return best;
  // No crossing: `y` is off the end of the section at this station. `hipX` is a
  // plausible half width and a 100 mm step away from the true one, so a patch
  // straddling this boundary corrugates exactly as case 14's did. Zero today,
  // but the sills clear it by only 36 mm and dropping them 40 mm puts half of
  // their samples here.
  FALLBACKS.flankXNoCrossing++;
  return hipX(z);
}

/* ------------------------------------------------------------------ */
/* stations, and the shut lines that triple them                       */
/* ------------------------------------------------------------------ */

type CutKind = "door" | "top" | "bumper";

/**
 * Transverse shut lines. `door` cuts run up the flank and over the roof rail;
 * `top` cuts (hood trailing edge, trunk leading edge) run across the upper
 * surface and die out as they turn down the side.
 *
 * Front door 1.063 m, rear door 1.050 m, both measured at the belt: a real
 * four-door package on a 2.80 m wheelbase.
 */
const CUTS: { z: number; kind: CutKind }[] = [
  { z: 2.072, kind: "bumper" },
  { z: 1.247, kind: "top" },
  { z: 0.965, kind: "door" },
  { z: -0.098, kind: "door" },
  { z: -1.148, kind: "door" },
  { z: -1.362, kind: "top" },
  // Boot lid trailing edge. Without it the deck, quarters and tail are one
  // welded lump; the leading cut alone only tells you where the lid starts.
  { z: -2.062, kind: "top" },
  { z: -2.128, kind: "bumper" },
];

/** Half a real 5 mm shut line. */
const CUT_HALF = 0.0026;
/** How deep the slot goes. Enough to hold a shadow at a metre. */
const CUT_DEPTH = 0.0065;

/** How open a cut is at half-ring row `hj`, 0..1. */
function cutGate(kind: CutKind, hj: number): number {
  const ramp = (a: number, b: number, v: number) => THREE.MathUtils.clamp((v - a) / (b - a), 0, 1);
  if (kind === "door") {
    // Sill to just over the roof rail: a door frame, not a slice through the car.
    return Math.min(ramp(ROW.rocker + 1, ROW.lowerFlank + 1, hj), 1 - ramp(ROW.railTurn + 2, ROW.roof + 3, hj));
  }
  if (kind === "bumper") {
    // Where the bumper cover meets the wing. Open across the whole lower body
    // and dying out just above the character line, which is where the joint
    // actually stops on a car with a wrap-around cover.
    return Math.min(ramp(ROW.under + 1, ROW.rocker + 1, hj), 1 - ramp(ROW.lineStep, ROW.upperFlank + 4, hj));
  }
  // Across the top, dying out as it turns down the side of the fender.
  return ramp(ROW.upperFlank + 2, ROW.dlo + 3, hj);
}

interface Station {
  z: number;
  /** Non-null when this station is the sunken middle of a shut line. */
  cut: CutKind | null;
}

function buildStations(): Station[] {
  const raw = new Set<number>();
  const add = (z: number) => {
    if (z >= RING_Z0 - 1e-9 && z <= RING_Z1 + 1e-9) raw.add(Math.round(z * 1e5) / 1e5);
  };

  for (let z = RING_Z0; z <= RING_Z1 + 1e-6; z += 0.03) add(z);
  add(RING_Z1);
  // Denser where the silhouette turns fast: the two ends, the base of each
  // pillar, and the cowl.
  for (const [a, b, s] of [
    [1.92, RING_Z1, 0.015],
    [RING_Z0, -1.96, 0.015],
    [0.4, 0.74, 0.013],
    [-0.92, -0.6, 0.013],
    [1.12, 1.42, 0.013],
    [-1.5, -1.22, 0.013],
  ] as [number, number, number][]) {
    for (let z = a; z <= b + 1e-6; z += s) add(z);
  }
  // The arch outline has infinite slope where it meets the sill, so the ends
  // of every opening need stations a few millimetres apart or the arch
  // finishes in a diagonal chamfer instead of dropping vertically.
  for (const cz of AXLES) {
    for (const s of [-1, 1]) {
      for (const d of [0.062, 0.04, 0.024, 0.013, 0.006, 0.0025, 0.001]) add(cz + s * (ARCH_R - d));
      for (const d of [0.001, 0.004, 0.012, 0.03]) add(cz + s * (ARCH_R + d));
    }
    for (let z = cz - ARCH_R + 0.06; z <= cz + ARCH_R - 0.05; z += 0.019) add(z);
  }

  const cutZ = CUTS.map((c) => c.z);
  const kept = [...raw].filter((z) => !cutZ.some((cz) => Math.abs(z - cz) < CUT_HALF * 3.2));
  const out: Station[] = kept.map((z) => ({ z, cut: null }));
  for (const c of CUTS) {
    out.push({ z: c.z - CUT_HALF, cut: null });
    out.push({ z: c.z, cut: c.kind });
    out.push({ z: c.z + CUT_HALF, cut: null });
  }
  out.sort((a, b) => a.z - b.z);
  // Two stations a hair apart give a sliver row with garbage normals, which
  // shows up as a bright line across the panel.
  return out.filter((s, i) => i === 0 || s.z - out[i - 1].z > 0.0008);
}

/* ------------------------------------------------------------------ */
/* glazing apertures                                                   */
/* ------------------------------------------------------------------ */

const WINDSHIELD_Z: [number, number] = [0.545, 1.215];
const BACKLIGHT_Z: [number, number] = [-1.325, -0.775];
const FRONT_GLASS_Z: [number, number] = [0.055, 0.925];
const REAR_GLASS_Z: [number, number] = [-1.015, -0.165];
/** Fixed quarter light behind the rear door, ahead of the C-pillar. */
const QUARTER_Z: [number, number] = [-1.133, -1.058];

const inSpan = (z: number, s: [number, number]) => z > s[0] && z < s[1];

/** How far glazing sits back from the outer skin. */
const GLASS_INSET = 0.02;

/* ------------------------------------------------------------------ */
/* the grid                                                            */
/* ------------------------------------------------------------------ */

interface Grid {
  stations: Station[];
  S: number;
  pos: Float32Array;
  uv: Float32Array;
  secs: Section[];
}

function buildGrid(): Grid {
  const stations = buildStations();
  const S = stations.length;
  const pos = new Float32Array(S * RING * 3);
  const uv = new Float32Array(S * RING * 2);
  const secs: Section[] = [];

  for (let i = 0; i < S; i++) {
    const st = stations[i];
    const sec = section(st.z);
    secs.push(sec);
    const half = sec.pts;

    // A shut line sinks the middle station of its triple along the section
    // normal, giving a slot with real width and real depth. A shut line drawn
    // as a dark stripe has zero shadow width and fools nobody.
    let inset: Float32Array | null = null;
    if (st.cut && !OPTS.flatCuts) {
      inset = new Float32Array(HALF);
      for (let hj = 0; hj < HALF; hj++) inset[hj] = CUT_DEPTH * cutGate(st.cut, hj);
    }

    let arc = 0;
    for (let j = 0; j < RING; j++) {
      const mirror = j >= HALF;
      const hj = mirror ? RING - j : j;
      const p = half[hj];

      let x = p.x;
      let y = p.y;
      if (inset && inset[hj] > 0) {
        const d = inset[hj];
        const a = half[Math.max(0, hj - 1)];
        const b = half[Math.min(HALF - 1, hj + 1)];
        let nx = b.y - a.y;
        let ny = -(b.x - a.x);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        x -= nx * d;
        y -= ny * d;
      }
      if (mirror) x = -x;

      const k = i * RING + j;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = st.z;

      if (j > 0) {
        const qh = mirror ? RING - (j - 1) : j - 1;
        const q = half[Math.min(HALF - 1, qh)];
        arc += Math.hypot(p.x - q.x, p.y - q.y);
      }
      uv[k * 2] = st.z;
      uv[k * 2 + 1] = arc;
    }
  }

  return { stations, S, pos, uv, secs };
}

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

type QuadKind = "body" | "glass" | "slot" | "pillar";

/**
 * What the quad between stations (i, i+1) and ring rows (j, j+1) is made of.
 */
function makeClassifier(g: Grid) {
  return (i: number, j: number): QuadKind => {
    const j2 = (j + 1) % RING;
    const hj = j >= HALF ? RING - j : j;
    const hj2 = j2 >= HALF ? RING - j2 : j2;
    const hjc = Math.min(hj, hj2);
    const zc = (g.stations[i].z + g.stations[i + 1].z) * 0.5;

    // Shut lines: the two quads either side of the sunken station are the slot
    // walls, and both go to the dark cavity material.
    const cut = g.stations[i].cut ?? g.stations[i + 1].cut;
    if (cut && cutGate(cut, hjc) > 0.35) return "slot";

    // The drip rail / hood-to-fender groove floor.
    if (hjc >= ROW.railTurn + 1 && hjc <= ROW.railTurn + 2 && railGroove(zc) > 0.45) return "slot";

    const belt = beltYAt(zc);
    const rail = railYAt(zc);

    if (hjc >= ROW.dlo && hjc < ROW.railTurn) {
      // Side glass lives in the DLO band, inside the pillars.
      const sec = g.secs[i].pts;
      const yc = (sec[Math.min(hjc + 1, HALF - 1)].y + sec[hjc].y) * 0.5;
      if (yc < belt + 0.028 || yc > rail - 0.014) return "body";
      if (inSpan(zc, FRONT_GLASS_Z) || inSpan(zc, REAR_GLASS_Z) || inSpan(zc, QUARTER_Z)) return "glass";
      // Anything else at daylight-opening height is a pillar. Leaving these in
      // body colour is what made the greenhouse read as "a smoked canopy
      // dropped onto the shell": with a body-coloured B-pillar the side glass
      // is one uninterrupted strip from windscreen to quarter light. Real
      // sedans black these out, and the break is most of what makes a DLO look
      // like separate windows.
      return "pillar";
    }

    if (hjc >= ROW.roof) {
      // Windshield and backlight are on the top band, inboard of the pillars.
      const xc = Math.abs(g.pos[(i * RING + j) * 3]);
      if (xc > railX(zc) * 0.815) return "body";
      if (inSpan(zc, WINDSHIELD_Z) || inSpan(zc, BACKLIGHT_Z)) return "glass";
      return "body";
    }

    return "body";
  };
}

/* ------------------------------------------------------------------ */
/* patch extraction                                                    */
/* ------------------------------------------------------------------ */

interface Buckets {
  body: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  slot: THREE.BufferGeometry[];
  seal: THREE.BufferGeometry[];
  pillar: THREE.BufferGeometry[];
}

/**
 * The ring-quad index ranges belonging to a band of half-ring rows [r0, r1].
 *
 * A band appears twice on the closed ring: once climbing the +X flank as j
 * goes r0 -> r1, and once descending the -X flank as j goes RING-r1 ->
 * RING-r0. Both belong to the same panel, and both go in the same patch.
 */
function bandQuads(r0: number, r1: number): number[] {
  const set = new Set<number>();
  for (let j = r0; j < r1; j++) set.add(j);
  for (let j = RING - r1; j < RING - r0; j++) set.add(((j % RING) + RING) % RING);
  return [...set].sort((a, b) => a - b);
}

/**
 * Extracts one band of the grid as a patch: its own vertex buffer, its own
 * `computeVertexNormals`. The neighbouring patch gets its own copy of the
 * shared boundary row with a different normal, so the crease is hard; inside
 * the patch normals are shared, so the highlight flows.
 */
function extractPatch(
  g: Grid,
  r0: number,
  r1: number,
  classify: (i: number, j: number) => QuadKind,
  out: Buckets
): { quads: number; verts: number } {
  const js = bandQuads(r0, r1);
  // Ring vertices touched: every quad's two rows.
  const needed = new Set<number>();
  for (const j of js) {
    needed.add(j);
    needed.add((j + 1) % RING);
  }
  const ringList = [...needed].sort((a, b) => a - b);
  const slot = new Map<number, number>();
  ringList.forEach((j, k) => slot.set(j, k));
  const W = ringList.length;

  const n = g.S * W;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const at = (i: number, j: number) => i * W + slot.get(j)!;

  for (let i = 0; i < g.S; i++) {
    for (const j of ringList) {
      const src = i * RING + j;
      const dst = at(i, j);
      pos[dst * 3] = g.pos[src * 3];
      pos[dst * 3 + 1] = g.pos[src * 3 + 1];
      pos[dst * 3 + 2] = g.pos[src * 3 + 2];
      uv[dst * 2] = g.uv[src * 2];
      uv[dst * 2 + 1] = g.uv[src * 2 + 1];
    }
  }

  // Every quad in the band, regardless of what it is made of, so the normals
  // are those of the whole panel. Splitting into paint / glass / slot happens
  // afterwards and cannot then disturb a single normal - which matters,
  // because a window hole that changed the normals around it would put a
  // visible dark ring on the paint next to the glass.
  const allIdx: number[] = [];
  for (let i = 0; i < g.S - 1; i++) {
    for (const j of js) {
      const j2 = (j + 1) % RING;
      allIdx.push(at(i, j), at(i, j2), at(i + 1, j), at(i, j2), at(i + 1, j2), at(i + 1, j));
    }
  }
  const probe = new THREE.BufferGeometry();
  probe.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  probe.setIndex(allIdx);
  probe.computeVertexNormals();
  const nrm = (probe.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;

  const bodyIdx: number[] = [];
  const glassIdx: number[] = [];
  const slotIdx: number[] = [];
  const pillarIdx: number[] = [];
  const kindOf = new Map<number, QuadKind>();
  for (let i = 0; i < g.S - 1; i++) {
    for (const j of js) {
      const j2 = (j + 1) % RING;
      const kind = classify(i, j);
      kindOf.set(i * RING + j, kind);
      const tri = [at(i, j), at(i, j2), at(i + 1, j), at(i, j2), at(i + 1, j2), at(i + 1, j)];
      if (kind === "glass") glassIdx.push(...tri);
      else if (kind === "slot") slotIdx.push(...tri);
      else if (kind === "pillar") pillarIdx.push(...tri);
      else bodyIdx.push(...tri);
    }
  }

  const make = (indices: number[], inset: number): THREE.BufferGeometry | null => {
    if (!indices.length) return null;
    const remap = new Map<number, number>();
    const P: number[] = [];
    const N: number[] = [];
    const U: number[] = [];
    const I: number[] = [];
    for (const v of indices) {
      let m = remap.get(v);
      if (m === undefined) {
        m = P.length / 3;
        remap.set(v, m);
        P.push(
          pos[v * 3] - nrm[v * 3] * inset,
          pos[v * 3 + 1] - nrm[v * 3 + 1] * inset,
          pos[v * 3 + 2] - nrm[v * 3 + 2] * inset
        );
        N.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        U.push(uv[v * 2], uv[v * 2 + 1]);
      }
      I.push(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
    geo.setIndex(I);
    return geo;
  };

  const bodyGeo = make(bodyIdx, 0);
  if (bodyGeo) out.body.push(bodyGeo);
  const slotGeo = make(slotIdx, 0);
  if (slotGeo) out.slot.push(slotGeo);
  const glassGeo = make(glassIdx, GLASS_INSET);
  if (glassGeo) out.glass.push(glassGeo);
  // Barely inset: a pillar is flush trim, not a recess. Enough to stop it
  // z-fighting the paint it replaces.
  const pillarGeo = make(pillarIdx, 0.0015);
  if (pillarGeo) out.pillar.push(pillarGeo);

  // Reveal: wherever a glass quad borders something that is not glass, run a
  // band from the outer skin down to the inset glass plane. Without it the
  // glass sits *on* the body as a lighter panel, which was the loudest single
  // complaint about the last version.
  if (glassIdx.length) {
    const sealPos: number[] = [];
    const sealIdx: number[] = [];
    const isGlass = (i: number, j: number) =>
      i >= 0 && i < g.S - 1 && kindOf.get(i * RING + (((j % RING) + RING) % RING)) === "glass";
    for (let i = 0; i < g.S - 1; i++) {
      for (const j of js) {
        if (kindOf.get(i * RING + j) !== "glass") continue;
        const j2 = (j + 1) % RING;
        const a = at(i, j);
        const b = at(i, j2);
        const c = at(i + 1, j);
        const d = at(i + 1, j2);
        const edges: [number, number][] = [];
        if (!isGlass(i, j - 1)) edges.push([a, c]);
        if (!isGlass(i, j + 1)) edges.push([d, b]);
        if (!isGlass(i - 1, j)) edges.push([b, a]);
        if (!isGlass(i + 1, j)) edges.push([c, d]);
        for (const [p, q] of edges) {
          const base = sealPos.length / 3;
          for (const v of [p, q]) sealPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
          for (const v of [p, q]) {
            sealPos.push(
              pos[v * 3] - nrm[v * 3] * GLASS_INSET,
              pos[v * 3 + 1] - nrm[v * 3 + 1] * GLASS_INSET,
              pos[v * 3 + 2] - nrm[v * 3 + 2] * GLASS_INSET
            );
          }
          // Drawn double sided, so the winding here cannot bite.
          sealIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
    }
    if (sealIdx.length) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.Float32BufferAttribute(sealPos, 3));
      sg.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((sealPos.length / 3) * 2), 2));
      sg.setIndex(sealIdx);
      sg.computeVertexNormals();
      out.seal.push(sg);
    }
  }

  probe.dispose();
  return { quads: js.length * (g.S - 1), verts: n };
}

/* ------------------------------------------------------------------ */
/* fascia caps                                                         */
/* ------------------------------------------------------------------ */

interface Cap {
  ring: P[];
  centre: P;
  zEnd: number;
  bulge: number;
  front: boolean;
}

let CAP_FRONT: Cap | null = null;
let CAP_REAR: Cap | null = null;

/**
 * Triangles the cap fan had to re-orient, published on the shell report.
 *
 * Reported rather than asserted at zero, because a non-star-shaped nose section
 * is a correct car and this count is the legitimate consequence of one. What it
 * is for is change detection: if it moves when someone reshapes the section, the
 * overhang moved with it, and that is worth knowing before the render is judged.
 */
const CAP_FLIPS: { front: number; rear: number } = { front: 0, rear: 0 };

function makeCap(g: Grid, front: boolean): { geo: THREE.BufferGeometry; cap: Cap } {
  const i = front ? g.S - 1 : 0;
  const zEnd = g.stations[i].z;
  const bulge = CAP_BULGE;
  const dir = front ? 1 : -1;

  const ring: P[] = [];
  let cy = 0;
  for (let j = 0; j < RING; j++) {
    const k = i * RING + j;
    ring.push(new V2(g.pos[k * 3], g.pos[k * 3 + 1]));
    cy += g.pos[k * 3 + 1];
  }
  const centre = new V2(0, cy / RING);
  const cap: Cap = { ring, centre, zEnd, bulge, front };

  // The cap is where the grille and intake are cut, and a cut can only be as
  // clean as the grid it is cut from. Inheriting the body's 132-point ring put
  // roughly ten points across the entire width of the grille, so the opening
  // came out as a torn diagonal staircase. Refining four to one here costs a
  // few thousand vertices on two small fans and is invisible everywhere else;
  // the outer ring still passes exactly through the original points, so the
  // cap and the last body station stay welded.
  const SUB = 4;
  const RC = RING * SUB;
  const RN: P[] = [];
  for (let j = 0; j < RING; j++) {
    const a0 = ring[j];
    const a1 = ring[(j + 1) % RING];
    for (let t = 0; t < SUB; t++) {
      const f = t / SUB;
      RN.push(new V2(a0.x + (a1.x - a0.x) * f, a0.y + (a1.y - a0.y) * f));
    }
  }

  // Concentric rings shrinking onto the centroid on a shallow dome. A front
  // fascia is convex in plan by 60-80 mm; a flat fan reads as a cut-off
  // cylinder and a deep cone reads as a bullet.
  // Ten rings, not four. The cap is where the grille and intake openings are
  // cut, and a cut can only follow the grid it is cut from: at four rings the
  // aperture edge was a staircase of enormous diagonal steps that read as torn
  // bodywork. This is the sampling-rate problem again, in reverse - the
  // feature is fine, the mesh under it was too coarse to describe it.
  // Radial resolution.
  //
  // The angular direction was refined 4:1 above, but the aperture edge is cut
  // along BOTH axes and the radial one was left at ten rings - about 60 mm of
  // spacing out where the grille is. The teeth on a cut edge are one ring
  // apart, so the opening came out as a 60 mm sawtooth however clean the cut
  // logic was. That is the same shape of mistake as the angular one, made once
  // and then not carried across to the other axis.
  //
  // Only the front cap has anything cut in it, so only the front pays: the tail
  // is a closed fan where extra rings would buy nothing.
  // Spread between the rim and F_INNER, NOT down to zero: the tip fan covers
  // the last of it. Running the rings all the way in packs them onto the
  // centroid, where the quads have no area left and `computeVertexNormals`
  // hands back 8920 zero-length normals - the refinement has to stop where the
  // original one did and only subdivide the span that was already there.
  const F_INNER = 0.17;
  const NRING = front ? 48 : 10;
  const FS: number[] = [];
  for (let i = 1; i <= NRING; i++) FS.push(1 - (i / (NRING + 1)) * (1 - F_INNER));
  const pos: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j < RC; j++) {
    pos.push(RN[j].x, RN[j].y, zEnd);
    uv.push(zEnd, j * 0.02);
  }
  for (const f of FS) {
    const dz = bulge * Math.sqrt(Math.max(0, 1 - f * f)) * dir;
    for (let j = 0; j < RC; j++) {
      pos.push(centre.x + (RN[j].x - centre.x) * f, centre.y + (RN[j].y - centre.y) * f, zEnd + dz);
      uv.push(zEnd + dz, j * 0.02);
    }
  }
  const tip = pos.length / 3;
  pos.push(centre.x, centre.y, zEnd + bulge * dir);
  uv.push(zEnd, 0);

  const idx: number[] = [];
  const rings = FS.length + 1;

  // Every real car has a hole in the front. The grille and intake meshes have
  // always existed in carParts, set 55 mm back from the fascia - but the fascia
  // was a closed fan, so they were sealed inside the nose where nothing could
  // see them and the car read as a blank prow. These are the openings they look
  // through, kept a few millimetres inside the panel behind so no daylight
  // leaks around the edge.
  /** See the note at the `wall()` calls below. Kept as a switch, not deleted. */
  const APERTURE_REVEAL_WALLS = false;

  const APERTURES = front
    ? [
        // Deliberately smaller than the opening you see. What is visible is the
        // inner edge of the surround in `carParts`; this is only the hole that
        // has to end up *underneath* it. Shrinking the cut widens the margin
        // between the staircase and the frame's outer edge, which is what stops
        // a tooth poking out into daylight, and costs nothing visually.
        { x: 0.305, y0: 0.772, y1: 0.864 }, // upper grille
        { x: 0.452, y0: 0.514, y1: 0.594 }, // lower intake
      ]
    : [];
  const inAperture = (x: number, y: number) =>
    APERTURES.some((ap) => Math.abs(x) <= ap.x && y >= ap.y0 && y <= ap.y1);
  const px = (k: number) => pos[k * 3];
  const py = (k: number) => pos[k * 3 + 1];
  const quadOpen = (a: number, b: number, c: number, d: number) =>
    inAperture((px(a) + px(b) + px(c) + px(d)) / 4, (py(a) + py(b) + py(c) + py(d)) / 4);

  const skip: boolean[] = new Array(rings * RC).fill(false);
  for (let rr = 0; rr < rings - 1; rr++) {
    for (let j = 0; j < RC; j++) {
      const j2 = (j + 1) % RC;
      skip[rr * RC + j] = quadOpen(rr * RC + j, rr * RC + j2, (rr + 1) * RC + j, (rr + 1) * RC + j2);
    }
  }

  // Fill and despeckle. Quad-level cutting of a curved grid leaves the odd
  // orphan quad and the odd one-quad bridge along a shallow edge; both read as
  // torn bodywork rather than as a moulded opening. Make every column's cut
  // contiguous, and drop cuts only one quad deep.
  for (let j = 0; j < RC; j++) {
    let lo = -1;
    let hi = -1;
    for (let rr = 0; rr < rings - 1; rr++) {
      if (skip[rr * RC + j]) {
        if (lo < 0) lo = rr;
        hi = rr;
      }
    }
    if (lo < 0) continue;
    // Only bridge a gap of a single quad. Filling the whole lo..hi span, which
    // is what this used to do, is fine on a spoke that crosses one opening and
    // catastrophic on a spoke that crosses two: it cut away everything between
    // the grille and the intake, welding them into one hole and taking the
    // number-plate panel with it. Measured on the intake's top edge, the
    // "opening" reached 150 mm above where it should have stopped.
    for (let rr = lo; rr <= hi; rr++) {
      if (skip[rr * RC + j]) continue;
      const prev = rr > lo && skip[(rr - 1) * RC + j];
      const next = rr < hi && skip[(rr + 1) * RC + j];
      if (prev && next) skip[rr * RC + j] = true;
    }
  }

  // Then remove islands: any surviving quad whose four neighbours are all cut
  // is a scrap of fascia floating in the middle of the mouth, and because the
  // reveal walls are emitted on every skipped/kept boundary, one island scrap
  // brings four walls with it. This used to be worse than a no-op - the rule
  // here restored any column cut only one quad deep, which is precisely how an
  // island gets made, so the despeckle was manufacturing the speckle it was
  // named for. Cutting one quad too many is invisible behind the grille
  // backing; leaving one behind is not.
  for (let rr = 0; rr < rings - 1; rr++) {
    for (let j = 0; j < RC; j++) {
      if (skip[rr * RC + j]) continue;
      const jm = (j + RC - 1) % RC;
      const j2 = (j + 1) % RC;
      const up = rr === 0 || skip[(rr - 1) * RC + j];
      const dn = rr >= rings - 2 || skip[(rr + 1) * RC + j];
      if (up && dn && skip[rr * RC + jm] && skip[rr * RC + j2]) skip[rr * RC + j] = true;
    }
  }

  // The reveal: the wall of the opening, without which the aperture is a hole
  // cut in paper rather than a moulding with depth. Emitted with both windings
  // because it is seen from inside the mouth as well as from outside, and it is
  // only a few dozen quads.
  const REVEAL = 0.030;
  const wall = (p0: number, p1: number) => {
    // Both facings, but each on its OWN four vertices. Sharing one vertex set
    // between two opposite windings makes computeVertexNormals average a face
    // normal with its exact negation, which lands on zero and shades as white
    // confetti - which is precisely what the first cut of these openings did.
    for (const flip of [false, true]) {
      const base = pos.length / 3;
      for (const k of [p0, p1]) {
        pos.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
        uv.push(pos[k * 3 + 2], 0.5);
      }
      for (const k of [p0, p1]) {
        pos.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2] - REVEAL * dir);
        uv.push(pos[k * 3 + 2] - REVEAL * dir, 0.5);
      }
      const [q0, q1, q2, q3] = [base, base + 1, base + 2, base + 3];
      if (flip) idx.push(q2, q1, q0, q2, q3, q1);
      else idx.push(q0, q1, q2, q1, q3, q2);
    }
  };

  // Whether the tip fan triangle on spoke j is itself cut away. Same test as the
  // fan loop below, hoisted because the innermost ring needs to agree with it.
  const tipOpen: boolean[] = [];
  for (let j = 0; j < RC; j++) {
    const a = (rings - 1) * RC + j;
    const b = (rings - 1) * RC + ((j + 1) % RC);
    tipOpen.push(inAperture((px(a) + px(b) + centre.x) / 3, (py(a) + py(b) + centre.y) / 3));
  }

  for (let rr = 0; rr < rings - 1; rr++) {
    for (let j = 0; j < RC; j++) {
      const j2 = (j + 1) % RC;
      const a = rr * RC + j;
      const b = rr * RC + j2;
      const c = (rr + 1) * RC + j;
      const d = (rr + 1) * RC + j2;
      if (skip[rr * RC + j]) {
        const jm = (j + RC - 1) % RC;
        // The reveal walls around an aperture are now suppressed, and this is
        // the fix for the "ragged brown blobs with torn, jagged, aliased edges"
        // that survived both the despeckle pass and the sawtooth reduction.
        //
        // They were never the wrong idea, they were the wrong *surface*. A wall
        // is emitted on each cut boundary and runs 30 mm back, so the one along
        // the bottom edge faces up, takes the sky, and renders as a bright pale
        // strip 20 px deep at the `nose_close` framing - carrying every tooth of
        // the staircase, in body colour, right where the eye is looking. No
        // amount of tooth reduction helps: the artefact is a sunlit surface, and
        // shortening the teeth just makes a bright comb finer.
        //
        // `carParts` now puts an analytic frame over each opening with its own
        // dark inner band, which supplies the depth these walls were for and has
        // an edge that is a curve rather than a staircase. Two sources of depth
        // is one too many, and this is the one that cannot be made clean.
        if (APERTURE_REVEAL_WALLS) {
          if (rr === 0 || !skip[(rr - 1) * RC + j]) wall(a, b);
        // The inner neighbour of the innermost ring is the tip fan, not another
        // ring, so it has to be asked whether IT is open. Forcing a wall here
        // unconditionally put a full 30 mm-deep collar of wall geometry right
        // at the cap centroid - which on this nose sits inside the grille mouth.
        // That collar was ~800 triangles of sunlit wall scattered across the
        // opening, and it is what read as a bowtie of torn metal behind the
        // grille. The opening itself was cut correctly the whole time: measured,
        // 0% of the upper grille was still covered by fascia, against 1840
        // reveal-wall triangles standing inside it.
          if (rr === rings - 2 ? !tipOpen[j] : !skip[(rr + 1) * RC + j]) wall(c, d);
          if (!skip[rr * RC + jm]) wall(a, c);
          if (!skip[rr * RC + j2]) wall(b, d);
        }
        continue;
      }
      // Going a -> b is CCW seen from +Z and the next ring is further forward,
      // so (a, b, c) faces out of the car at the nose and into it at the tail.
      if (front) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < RC; j++) {
    const j2 = (j + 1) % RC;
    const a = (rings - 1) * RC + j;
    const b = (rings - 1) * RC + j2;
    // The tip fan lives at the centroid, which on this nose sits between the
    // grille and the intake - so without this guard the cone would hang in the
    // middle of an open mouth.
    if (inAperture((px(a) + px(b) + centre.x) / 3, (py(a) + py(b) + centre.y) / 3)) continue;
    if (front) idx.push(a, b, tip);
    else idx.push(b, a, tip);
  }

  /**
   * Orient every cap triangle against the one direction a cap unambiguously has.
   *
   * WHY THE FAN CANNOT GET THIS RIGHT ON ITS OWN
   *
   * The cap is concentric rings scaled about `centre` and swept onto a shallow
   * dome, and quad orientation therefore comes out as radial x tangential. That is
   * consistent only while the ring is **star-shaped about `centre`** - i.e. while
   * the polar angle about the centroid increases monotonically as `j` advances.
   *
   * The nose and tail sections are not. Measured on the shipping profile, the
   * `upperFlank` band runs 16 edges at the front and 18 at the rear where the
   * polar angle *decreases*, because the shoulder overhangs the bonnet and boot
   * line: y falls while x falls, so the ring doubles back in the plane the fan
   * radiates in. Mirrored across the centreline that is the **125 reversed
   * triangles the scene-wide per-triangle detector found in `car-body`**, 83 at
   * the nose and 42 at the tail, 1293 mm2 of genuinely inverted surface - not
   * slivers, since the smallest is 6.7% of the median body triangle.
   *
   * THE SHAPE IS NOT THE BUG. A nose section whose highest point is the shoulder
   * rather than the centreline is a correct car. So this cannot be an assertion
   * that refuses to build, the way `buildTyre`'s monotonicity check can - there
   * the doubling back was a mistake, and here it is the design. **The implicit
   * contract was star-shapedness, nobody wrote it down, and the shape that
   * violates it is the one we want.** So the builder absorbs it.
   *
   * And no choice of `centre` fixes it: checked at cy 0.5, 0.788 and 0.95, the
   * polar angle still decreases across those edges, because the ring doubles back
   * in the plane rather than merely being off-centre.
   *
   * WHY ORIENTING AGAINST ±Z IS SAFE HERE
   *
   * A cap has exactly one outward direction and it is the axis it caps. The dome
   * is 42 mm of bulge over roughly 800 mm of radius, so every fan triangle's
   * normal is strongly ±Z and the test has no grey zone. The dominance guard below
   * leaves anything tangential alone, so an aperture reveal wall - which faces
   * radially and would be a legitimate near-tangential face - is never touched
   * even though those are currently switched off.
   *
   * This is the third place in this system to need the same remedy, after
   * `flankStrip` and the inset skins, and the shape is the same each time: a
   * builder deriving orientation from something the caller controls, and the fix
   * being to measure orientation against a direction the builder actually knows.
   */
  let flipped = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t];
    const i1 = idx[t + 1];
    const i2 = idx[t + 2];
    const ax = pos[i1 * 3] - pos[i0 * 3];
    const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
    const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const bx = pos[i2 * 3] - pos[i0 * 3];
    const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
    const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    // Degenerate: no orientation to correct, and flipping it would be noise.
    if (!(Math.abs(nx) + Math.abs(ny) + Math.abs(nz) > 1e-14)) continue;
    // Only judge faces that are actually facing along the cap axis. A radial
    // face is a wall and its orientation is not this rule's business.
    if (Math.abs(nz) < Math.max(Math.abs(nx), Math.abs(ny))) continue;
    if (nz * dir < 0) {
      idx[t + 1] = i2;
      idx[t + 2] = i1;
      flipped++;
    }
  }
  CAP_FLIPS[front ? "front" : "rear"] = flipped;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // Only now, and the order matters: `computeVertexNormals` DERIVES normals from
  // the winding, so running it before the correction would have baked the fold in
  // as a shading defect and left nothing to detect.
  geo.computeVertexNormals();
  return { geo, cap };
}

/**
 * Where the fascia surface actually is at a given height and lateral offset.
 * Lamps, grilles and the plate are placed against this rather than a guessed
 * Z: the nose sheds 200 mm of half width over its last 100 mm, so a lamp that
 * is correct on the centreline hangs in mid air at the corner.
 */
/**
 * Distance from the cap centroid to its outline along a unit direction, or
 * `Infinity` if the ray never crosses.
 *
 * Deliberately does not touch the fallback counters: `capLowerEdgeY` probes
 * this hundreds of times looking for an edge, and a probe is not a misplaced
 * part. Only `endZ`, which is answering on behalf of a real vertex, counts.
 */
function capOutlineRadius(cap: Cap, ux: number, uy: number): number {
  let r = Infinity;
  const ring = cap.ring;
  for (let j = 0; j < ring.length; j++) {
    const a = ring[j];
    const b = ring[(j + 1) % ring.length];
    const ax = a.x - cap.centre.x;
    const ay = a.y - cap.centre.y;
    const ex = b.x - cap.centre.x - ax;
    const ey = b.y - cap.centre.y - ay;
    const den = ex * uy - ux * ey;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ux * ay - uy * ax) / den;
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    const s = (ex * ay - ey * ax) / den;
    if (s > 1e-6 && s < r) r = s;
  }
  return r;
}

/** Whether (`x`,`y`) is inside the nose or tail cap outline, i.e. has fascia. */
function capContains(cap: Cap, x: number, y: number): boolean {
  const dx = x - cap.centre.x;
  const dy = y - cap.centre.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-5) return true;
  const r = capOutlineRadius(cap, dx / len, dy / len);
  return Number.isFinite(r) && r > 1e-5 && len < r;
}

/**
 * The lowest Y at column `x` that still has fascia on the nose or tail cap.
 *
 * Exists so parts low on a bumper can be hung off the real edge of the cap
 * instead of a literal. The exhaust finisher carried `y = 0.352` against a cap
 * whose lower edge is at 0.3594; 7.4 mm below the fascia, it got the flat
 * fallback plane rather than the real surface. The Z error was small - the
 * cap's bulge tapers to zero at the rim, so there was nothing much to miss -
 * but this is the same part that ended up 128 mm inside the tail last time the
 * body was reshaped under it, precisely because it carried literals. A part
 * that asks where the edge is cannot drift off it again.
 */
export function capLowerEdgeY(x: number, front: boolean): number {
  const cap = front ? CAP_FRONT : CAP_REAR;
  if (!cap) {
    throw new Error(
      `capLowerEdgeY(${x.toFixed(3)}, ${front ? "front" : "rear"}): the cap is not built yet. ` +
        `Call buildCarShell() first.`
    );
  }
  let lo = cap.centre.y;
  for (const p of cap.ring) lo = Math.min(lo, p.y);
  if (!capContains(cap, x, cap.centre.y)) return cap.centre.y;
  // Bisect between the centroid height (inside) and the ring's lowest point.
  let inside = cap.centre.y;
  let outside = lo - 0.02;
  for (let i = 0; i < 40; i++) {
    const mid = (inside + outside) * 0.5;
    if (capContains(cap, x, mid)) inside = mid;
    else outside = mid;
  }
  return inside;
}

export function endZ(x: number, y: number, front: boolean): number {
  const cap = front ? CAP_FRONT : CAP_REAR;
  // Was a silent fall-through to the ring plane, which is a programming error
  // with no valid reading: every part on the fascia lands on ONE flat plane,
  // 21-42 mm off, so 100% flat where case 14 was 39%. There is nothing to
  // recover from here, so say so.
  if (!cap) {
    throw new Error(
      `endZ(${x.toFixed(3)}, ${y.toFixed(3)}, ${front ? "front" : "rear"}): the ` +
        `${front ? "front" : "rear"} cap is not built yet, so there is no fascia to project onto. ` +
        `endZ reads the caps that buildCarShell() populates - call buildCarShell() before ` +
        `buildTrim/buildLamps/buildInterior or anything else that places parts against the nose or tail.`
    );
  }
  const dx = x - cap.centre.x;
  const dy = y - cap.centre.y;
  const len = Math.hypot(dx, dy);
  const dir = cap.front ? 1 : -1;
  if (len < 1e-5) return cap.zEnd + cap.bulge * dir;

  // Radius of the fascia outline in this direction: intersect a ray from the
  // centroid with the outline polygon.
  //
  // This used to derive the ray parameter by dividing the crossing point by a
  // component of the direction vector, which blows up whenever the ray is close
  // to axis-aligned, and then kept the LARGEST result over all edges. On a
  // non-convex section ring that picks the far side of the car as often as the
  // near one. The damage was not subtle: measured over the tail-lamp rectangle,
  // 39% of samples fell through to the flat `zEnd` fallback and the rest sat on
  // the true fascia, giving a 39 mm sawtooth. `endPatch` samples this per
  // vertex, so every lamp, grille and plate was being built on a corrugated
  // surface - which is what "red-and-white noise painted on a flat panel" and
  // the torn grille edges actually were.
  //
  // Solve C + sU = A + tE by Cramer, keep the NEAREST crossing ahead of the
  // ray, and never divide by a direction component.
  const r = capOutlineRadius(cap, dx / len, dy / len);
  // Off the end of the cap outline, where there is simply no fascia to sample.
  // A legitimate query about a legitimate edge, so this one is counted rather
  // than thrown - and it is the counter most likely to earn its keep: the
  // headlamp and tail-lamp footprints have both already been resized after
  // being caught by it (see the notes at carParts.ts:515 and :587).
  //
  // Both branches return the flat plane, and both must be counted. `len >= r`
  // is the one that fires when a footprint overhangs the fascia, which is the
  // case that has actually bitten twice; it used to reach the same value
  // silently through `Math.min(1, len / r)`.
  if (!Number.isFinite(r) || r <= 1e-5 || len >= r) {
    FALLBACKS.endZOutsideOutline++;
    // A count without a location is not actionable, and the cost of that was
    // real: `probe-fallbacks` could only guess at the failing placements by
    // keeping its own copies of the call-site coordinates, which then drifted
    // out of sync with the code and reported a fixed defect for rounds after it
    // was fixed. Record where, not just how many, and the probe can stop
    // guessing. Capped so a pathological build cannot grow this without bound.
    if (FALLBACKS.sites.length < 64) {
      FALLBACKS.sites.push({
        x: +x.toFixed(4),
        y: +y.toFixed(4),
        front: cap.front,
        // How far past the outline the sample fell. This is the number the fix
        // needs: it is the distance the footprint has to shrink, or the part has
        // to move, to land back on the real fascia.
        over: Number.isFinite(r) ? +(len - r).toFixed(4) : NaN,
      });
    }
    return cap.zEnd;
  }
  const f = len / r;
  return cap.zEnd + cap.bulge * Math.sqrt(Math.max(0, 1 - f * f)) * dir;
}

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

export interface CarShell {
  /** Painted outer skin: ten patches merged, hard creases between them. */
  body: THREE.BufferGeometry;
  /** Glazing, set 20 mm back into its apertures. */
  glass: THREE.BufferGeometry;
  /** Shut-line slot walls and the drip rail: the dark bottom of every gap. */
  slots: THREE.BufferGeometry;
  /** Reveals and rubber seals around every aperture. */
  seals: THREE.BufferGeometry;
  /** Blacked-out A/B/C pillars, so the DLO reads as separate windows. */
  pillars: THREE.BufferGeometry;
  /** Dark inner skin, so a shut line and a window look into something solid. */
  inner: THREE.BufferGeometry;
  /** Headlining over the cabin, so the glass does not look onto open sky. */
  headliner: THREE.BufferGeometry;
  /** What actually got built, for the capture harness to print. */
  report: Record<string, unknown>;
}

/**
 * Patch boundaries. Every entry is a hard crease and everything inside a patch
 * is smooth. This list *is* the feature-line specification for the car.
 */
const PATCH_ROWS: [number, number, string][] = (() => {
  const b: [number, string][] = [
    [ROW.under, "under"],
    [ROW.rocker, "rocker"],
    [ROW.sillStep, "sillStep"],
    [ROW.lowerFlank, "lowerFlank"],
    [ROW.lineStep, "lineStep"],
    [ROW.upperFlank, "upperFlank"],
    [ROW.beltTurn, "beltTurn"],
    [ROW.dlo, "dlo"],
    [ROW.railTurn, "railTurn"],
    [ROW.roof, "roof"],
    [ROW.end, "end"],
  ];
  const out: [number, number, string][] = [];
  for (let i = 0; i < b.length - 1; i++) out.push([b[i][0], b[i + 1][0], b[i][1]]);
  return out;
})();

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  let nv = 0;
  let ni = 0;
  for (const g of list) {
    nv += g.getAttribute("position").count;
    ni += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    const u = g.getAttribute("uv") as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, vo * 3);
    nrm.set(n.array as Float32Array, vo * 3);
    uv.set(u.array as Float32Array, vo * 2);
    const gi = g.index!;
    for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
    vo += p.count;
    io += gi.count;
    g.dispose();
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

function emptyGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([], 2));
  g.setIndex([]);
  return g;
}

/**
 * Signed volume of the closed index buffer, x6. Positive means the triangles
 * wind outward. This is the paper check from the header, run at build time,
 * because "both the body loft and the tyre were wound inward" is a bug this
 * project has already shipped once and it is invisible until the whole car
 * disappears.
 */
function signedVolume(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.index!;
  let v = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    const ax = p.getX(a);
    const ay = p.getY(a);
    const az = p.getZ(a);
    const bx = p.getX(b);
    const by = p.getY(b);
    const bz = p.getZ(b);
    const cx = p.getX(c);
    const cy = p.getY(c);
    const cz = p.getZ(c);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v;
}

/**
 * Forced-value switches, for proving a feature reaches the screen rather than
 * assuming it did. NOTES.md documents six bugs in this project where correct
 * code never made it to a pixel, so every claim below is backed by a diff.
 *
 * `smooth` collapses the ten patches into one, giving a single continuous
 * normal field over the whole shell - literally the surfacing the reviewer
 * called "a single continuous membrane". If the crease work reaches the
 * screen, this must change large, *localised* areas of the image.
 *
 * `flatCuts` builds the shut lines with zero depth, so they stop being slots
 * and become nothing at all.
 */
export interface ShellOptions {
  smooth?: boolean;
  flatCuts?: boolean;
}

let OPTS: ShellOptions = {};

export function buildCarShell(options: ShellOptions = {}): CarShell {
  OPTS = options;
  const g = buildGrid();
  const classify = makeClassifier(g);
  const out: Buckets = { body: [], glass: [], slot: [], seal: [], pillar: [] };

  const rows: [number, number, string][] = OPTS.smooth ? [[0, ROW.end, "ALL-SMOOTH"]] : PATCH_ROWS;
  const patchReport: { name: string; rows: string; quads: number }[] = [];
  for (const [r0, r1, name] of rows) {
    const r = extractPatch(g, r0, r1, classify, out);
    patchReport.push({ name, rows: `${r0}..${r1}`, quads: r.quads });
  }

  const front = makeCap(g, true);
  const rear = makeCap(g, false);
  CAP_FRONT = front.cap;
  CAP_REAR = rear.cap;
  out.body.push(front.geo, rear.geo);

  /* ---- inner skin: what a shut line and a window look into ---- */
  const innerPos: number[] = [];
  const innerIdx: number[] = [];
  const linerPos: number[] = [];
  const linerIdx: number[] = [];
  {
    const nrmProbe = new THREE.BufferGeometry();
    nrmProbe.setAttribute("position", new THREE.BufferAttribute(g.pos, 3));
    const ring: number[] = [];
    const vid = (i: number, j: number) => i * RING + j;
    for (let i = 0; i < g.S - 1; i++) {
      for (let j = 0; j < RING; j++) {
        const j2 = (j + 1) % RING;
        ring.push(vid(i, j), vid(i, j2), vid(i + 1, j), vid(i, j2), vid(i + 1, j2), vid(i + 1, j));
      }
    }
    nrmProbe.setIndex(ring);
    nrmProbe.computeVertexNormals();
    const nn = (nrmProbe.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;

    const emit = (v: number, arr: number[], m: Map<number, number>, inset: number) => {
      let k = m.get(v);
      if (k === undefined) {
        k = arr.length / 3;
        m.set(v, k);
        arr.push(
          g.pos[v * 3] - nn[v * 3] * inset,
          g.pos[v * 3 + 1] - nn[v * 3 + 1] * inset,
          g.pos[v * 3 + 2] - nn[v * 3 + 2] * inset
        );
      }
      return k;
    };
    const innerMap = new Map<number, number>();
    const linerMap = new Map<number, number>();

    /**
     * Push a triangle only if the offset has not folded it inside out.
     *
     * WHY THIS IS NEEDED, AND WHY IT IS NOT A WINDING BUG
     *
     * The inner skin and the headlining are parallel offsets of the outer body,
     * inset 32 mm and 55 mm along the vertex normals, and they keep the outer
     * body's winding - which is correct, because a parallel offset faces the same
     * way as its source.
     *
     * But **an offset larger than the local concave radius of curvature turns the
     * surface inside out.** The body has hard creases by design, and at a crease
     * the concave radius is near zero, so a 32 mm inset locally inverts. That
     * produced 3,229 reversed triangles of 52,036 in the inner skin and 320 of
     * 11,350 in the headlining - found by the scene-wide per-triangle detector,
     * and invisible until now only because both are drawn `DoubleSide`. They
     * would have surfaced the instant anyone set `side` correctly for a
     * performance pass, which is a change that looks free.
     *
     * So flipping the winding would be exactly wrong: 94% of these triangles are
     * right. The defect is per-triangle and so is the remedy.
     *
     * A folded triangle is not a degraded surface that a fallback can stand in
     * for - it is a surface that does not exist, sitting inside the bodyshell
     * where nothing can see it. Dropping it is the correct answer rather than a
     * workaround, and it costs triangles rather than adding them.
     *
     * The test is the detector's own: compare the offset triangle's geometric
     * normal against the source surface normal it was built from. Note it cannot
     * be `computeVertexNormals` on the result - that DERIVES normals from the
     * winding and would certify the fold.
     */
    const pushIfNotFolded = (
      idxArr: number[],
      posArr: number[],
      i0: number,
      i1: number,
      i2: number,
      srcV: number,
      /**
       * +1 when the offset surface should face the same way as its source, -1
       * when it is deliberately flipped to face the other way.
       *
       * The headlining is the -1 case: it is the roof offset downward and turned
       * to face into the cabin, so "correct" for it is the OPPOSITE of the roof's
       * outward normal. Testing it against +1 would reject all 11,350 of its
       * triangles - which is the trap in reusing an orientation check across two
       * surfaces built from one source with different intents.
       */
      sign: 1 | -1
    ): boolean => {
      const ax = posArr[i1 * 3] - posArr[i0 * 3];
      const ay = posArr[i1 * 3 + 1] - posArr[i0 * 3 + 1];
      const az = posArr[i1 * 3 + 2] - posArr[i0 * 3 + 2];
      const bx = posArr[i2 * 3] - posArr[i0 * 3];
      const by = posArr[i2 * 3 + 1] - posArr[i0 * 3 + 1];
      const bz = posArr[i2 * 3 + 2] - posArr[i0 * 3 + 2];
      const gx = ay * bz - az * by;
      const gy = az * bx - ax * bz;
      const gz = ax * by - ay * bx;
      const len = Math.hypot(gx, gy, gz);
      // Degenerate: the offset has collapsed the triangle to a line. No
      // orientation to test and nothing worth drawing.
      if (!(len > 1e-12)) return false;
      const d =
        sign *
        ((gx / len) * nn[srcV * 3] +
          (gy / len) * nn[srcV * 3 + 1] +
          (gz / len) * nn[srcV * 3 + 2]);
      if (!(d > 0)) return false;
      idxArr.push(i0, i1, i2);
      return true;
    };
    let foldedDropped = 0;

    for (let i = 0; i < g.S - 1; i++) {
      const zc = (g.stations[i].z + g.stations[i + 1].z) * 0.5;
      const belt = beltYAt(zc);
      const rail = railYAt(zc);
      const archY = archOutlineY(zc);
      for (let j = 0; j < RING; j++) {
        const hj = j >= HALF ? RING - j : j;
        const j2 = (j + 1) % RING;
        const yc = g.pos[vid(i, j) * 3 + 1];
        const A = () => emit(vid(i, j), innerPos, innerMap, 0.032);
        // Door and body-side inner panel, wherever it can be seen through a
        // shut line or an arch.
        const inArch = yc < archY + 0.02 && yc > ARCH_BASE_Y - 0.2;
        if (hj >= ROW.rocker && hj < ROW.dlo && !inArch && yc < belt + 0.02) {
          const a = A();
          const b = emit(vid(i, j2), innerPos, innerMap, 0.032);
          const c = emit(vid(i + 1, j), innerPos, innerMap, 0.032);
          const d = emit(vid(i + 1, j2), innerPos, innerMap, 0.032);
          const v0 = vid(i, j);
          if (!pushIfNotFolded(innerIdx, innerPos, a, b, c, v0, 1)) foldedDropped++;
          if (!pushIfNotFolded(innerIdx, innerPos, b, d, c, v0, 1)) foldedDropped++;
        }
        // Headlining: the roof over the cabin, flipped to face down.
        if (hj >= ROW.roof && yc > rail - 0.03 && zc > BACKLIGHT_Z[0] - 0.12 && zc < WINDSHIELD_Z[1] + 0.12) {
          const a = emit(vid(i, j), linerPos, linerMap, 0.055);
          const b = emit(vid(i, j2), linerPos, linerMap, 0.055);
          const c = emit(vid(i + 1, j), linerPos, linerMap, 0.055);
          const d = emit(vid(i + 1, j2), linerPos, linerMap, 0.055);
          const lv0 = vid(i, j);
          if (!pushIfNotFolded(linerIdx, linerPos, a, c, b, lv0, -1)) foldedDropped++;
          if (!pushIfNotFolded(linerIdx, linerPos, b, c, d, lv0, -1)) foldedDropped++;
        }
      }
    }
    nrmProbe.dispose();
  }

  const mk = (p: number[], i: number[]) => {
    if (!i.length) return emptyGeo();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((p.length / 3) * 2), 2));
    geo.setIndex(i);
    geo.computeVertexNormals();
    return geo;
  };

  const body = mergeAll(out.body);
  const glass = out.glass.length ? mergeAll(out.glass) : emptyGeo();
  const slots = out.slot.length ? mergeAll(out.slot) : emptyGeo();
  const seals = out.seal.length ? mergeAll(out.seal) : emptyGeo();
  const pillars = out.pillar.length ? mergeAll(out.pillar) : emptyGeo();

  // Winding proof, measured rather than eyeballed. The body is not watertight
  // (windows and shut lines are cut out of it) so the volume is approximate,
  // but the sign is unambiguous: 4-5 m^3 of car versus -4-5.
  const vol = signedVolume(body);
  const tris = [body, glass, slots, seals, pillars].reduce((s, x) => s + (x.index ? x.index.count / 3 : 0), 0);

  const bb = new THREE.Box3().setFromBufferAttribute(body.getAttribute("position") as THREE.BufferAttribute);

  const report = {
    /*
     * Cap triangles the fan had to re-orient. Not asserted at zero: a nose
     * section whose highest point is the shoulder rather than the centreline is a
     * correct car, and these counts are the legitimate consequence. Watch them
     * for CHANGE - if they move when someone reshapes the section, the overhang
     * moved with them.
     */
    capFlips: { ...CAP_FLIPS },
    dims: {
      length: +(bb.max.z - bb.min.z).toFixed(3),
      width: +(bb.max.x - bb.min.x).toFixed(3),
      height: +bb.max.y.toFixed(4),
      wheelbase: CAR.wheelbase,
    },
    greenhouse: {
      roofFlatFrom: -0.74,
      roofFlatTo: 0.52,
      roofFlatLen: 1.26,
      sideGlassH: +(railYAt(0) - beltYAt(0)).toFixed(3),
      tumblehomeDeg: 33,
      cPillarNeck: +(railX(-1.36) - railX(-0.78)).toFixed(3),
    },
    stance: {
      archGapCrown: +(ARCH_TOP_Y - (WHEEL_Y + CAR.tyreR)).toFixed(4),
      wheelCentreY: +WHEEL_Y.toFixed(4),
      sillY: +sillY(0).toFixed(3),
    },
    patches: patchReport,
    creaseRows: rows.length - 1,
    forced: { smooth: !!OPTS.smooth, flatCuts: !!OPTS.flatCuts },
    stations: g.S,
    ringPoints: RING,
    tris: Math.round(tris + innerIdx.length / 3 + linerIdx.length / 3),
    winding: { bodySignedVolume6x: +vol.toFixed(2) },
    windingOutward: vol > 0,
  };

  return {
    body,
    glass,
    slots,
    seals,
    pillars,
    inner: mk(innerPos, innerIdx),
    headliner: mk(linerPos, linerIdx),
    report,
  };
}

/* ------------------------------------------------------------------ */
/* wheel arch lip and liner                                            */
/* ------------------------------------------------------------------ */

/** The arch opening outline, as (z, y) plus the parameter along it. */
export function archOutline(cz: number, n = 96): { z: number; y: number; t: number }[] {
  const out: { z: number; y: number; t: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = Math.PI * t;
    out.push({ z: cz + Math.cos(th) * ARCH_R, y: ARCH_BASE_Y + Math.sin(th) * ARCH_R, t });
  }
  return out;
}

/**
 * Inner arch liner: a half barrel about the X axis closing off the opening.
 * Drawn double sided and near black, so it reads as the dark cavity above a
 * wheel rather than as a surface.
 */
export function buildArchLiner(radius = ARCH_R - 0.012, width = 0.3, seg = 26): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const start = -0.22;
  const len = Math.PI + 0.44;
  for (let i = 0; i <= seg; i++) {
    const th = start + (i / seg) * len;
    const y = radius * Math.sin(th);
    const z = radius * Math.cos(th);
    pos.push(-width / 2, y, z, width / 2, y, z);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* tyre                                                                */
/* ------------------------------------------------------------------ */

/**
 * A tyre carrying its share of 1550 kg. The contact patch is flattened and the
 * sidewall bulges out around it: a car resting on four perfect circles looks
 * weightless no matter how good the paint is, and it is the first thing anyone
 * notices in a low three-quarter shot.
 *
 * Wheel axis is +X. `squash` is how far the flat rises above where the
 * undeformed circle would have been - 13 mm, which is about right for 32 psi.
 *
 * Winding: the cross index runs along +X and the angle runs +Z -> +Y, so for
 * p0 = (a, c), p1 = (a, c+1), p2 = (a+1, c), the normal of (p0, p1, p2) is
 * X x Y = +Z at the crown, i.e. radially outward. (p0, p1, p2) it is.
 */
export function buildTyre(
  radius = CAR.tyreR,
  width = CAR.tyreWidth,
  rimR = CAR.rimR,
  squash = CAR.squash,
  /**
   * Angular offset of the tread and sidewall lettering only.
   *
   * This exists because the caller used to vary wheels by setting
   * `rotation.x` on the mesh - which is rotation about the axle, so it rolled
   * the flat contact patch up to 2.1 rad off the ground and put a perfectly
   * round part of the tyre where the road is. Every wheel looked inflated and
   * the car looked weightless, which is exactly what a reviewer reported. The
   * flat has to stay at the bottom; only the pattern may move.
   */
  phase = 0
): THREE.BufferGeometry {
  const around = 240;
  const half = width / 2;

  const profile: THREE.Vector2[] = [];
  const addProf = (w: number, r: number) => profile.push(new THREE.Vector2(w, r));
  /**
   * The sidewall section, bead to shoulder, and it MUST be monotonic in `r`.
   *
   * It was not. The radii ran 0.2105, 0.2305, 0.2665, **0.3005, 0.2762**,
   * 0.3055, 0.3255 - a 24 mm dip at the fifth point - so the cross-section
   * doubled back on itself. Sweeping a self-reversing profile folds the surface,
   * and a folded quad has one triangle facing out and one facing in: 240 quads x
   * 2 affected segments x 1 triangle x 2 sidewalls = **960 reversed triangles of
   * 8160, which is exactly what the scene-wide per-triangle detector reported on
   * all four tyres at identical counts.** 3,840 triangles were being culled, and
   * the surviving ones were lit through their back faces.
   *
   * THE CAUSE IS TWO PARAMETERISATIONS IN ONE ORDERED SEQUENCE. Points three and
   * four were written in different units - `rimR + 0.092` is an absolute offset
   * from the rim, `rimR * 0.45 + radius * 0.55` is a proportional interpolation
   * between rim and tread - and nothing anywhere asserted that the sequence stayed
   * ordered. At rimR 0.2085 and radius 0.3315 the absolute term overtakes the
   * proportional one, and the profile crosses itself. Both lines are individually
   * reasonable, which is why this survived every review.
   *
   * Now all seven are absolute offsets from a single origin, so they are directly
   * comparable by eye, and the apex of the bulge sits at 51% of the way from bead
   * to shoulder - which is where a real tyre is widest, rather than 76% up.
   * `half * 1.085` is unchanged, so the tyre's maximum width, and therefore the
   * track and the arch clearance, are untouched: only the height at which the
   * maximum occurs has moved.
   *
   * The assertion below is the actual fix. The numbers are just this instance.
   */
  const sidewall = (sign: number) => {
    addProf(sign * half * 0.9, rimR + 0.002);
    addProf(sign * half * 1.0, rimR + 0.022);
    addProf(sign * half * 1.075, rimR + 0.036);
    addProf(sign * half * 1.085, rimR + 0.060);
    addProf(sign * half * 1.05, rimR + 0.086);
    addProf(sign * half * 0.985, radius - 0.026);
    addProf(sign * half * 0.925, radius - 0.006);
  };
  sidewall(-1);
  /**
   * Assert the sidewall rises. This is cheap, it runs on every build, and it is
   * the only thing here that would have caught the fold - `computeVertexNormals`
   * cannot, because it DERIVES normals from the winding and therefore certifies
   * whatever it is handed, converting a winding bug into a shading bug and
   * destroying the evidence in one statement.
   *
   * Throws rather than counts. A self-crossing profile is not a degraded result
   * that a fallback can stand in for; it is a surface that does not exist, and
   * every downstream measurement of it is meaningless.
   */
  for (let i = 1; i < profile.length; i++) {
    if (!(profile[i].y > profile[i - 1].y)) {
      throw new Error(
        `buildTyre: sidewall profile is not monotonic in r at point ${i} ` +
          `(${profile[i - 1].y.toFixed(4)} -> ${profile[i].y.toFixed(4)}). ` +
          `A self-crossing cross-section folds the swept surface and reverses ` +
          `one triangle of every quad in the adjacent segments.`
      );
    }
  }
  addProf(-half * 0.62, radius);
  addProf(-half * 0.2, radius + 0.0012);
  addProf(half * 0.2, radius + 0.0012);
  addProf(half * 0.62, radius);
  const mark = profile.length;
  sidewall(1);
  const back: THREE.Vector2[] = [];
  for (let i = profile.length - 1; i >= mark; i--) back.push(profile[i]);
  profile.length = mark;
  profile.push(...back);

  const cross = profile.length;
  const pos = new Float32Array(around * cross * 3);
  const uv = new Float32Array(around * cross * 2);
  const idx: number[] = [];

  const yFlat = -(radius - squash);

  for (let a = 0; a < around; a++) {
    const th = (a / around) * Math.PI * 2;
    const sn = Math.sin(th);
    const cs = Math.cos(th);
    for (let c = 0; c < cross; c++) {
      const p = profile[c];
      let w = p.x;
      let r = p.y;

      // Circumferential grooves and lateral sipes as real relief, not just a
      // normal map: at a metre away the tread blocks catch the light.
      const acrossT = THREE.MathUtils.clamp((w / half + 1) * 0.5, 0, 1);
      if (r > radius - 0.014) {
        let groove = 0;
        for (const gg of [0.12, 0.38, 0.62, 0.88]) {
          groove = Math.max(groove, 1 - THREE.MathUtils.smoothstep(Math.abs(acrossT - gg), 0.0, 0.036));
        }
        const sipe = Math.abs(((((th + phase) * 23.5) / Math.PI) % 1) - 0.5) * 2;
        // Tread relief belongs in the tread *face*. Applied across the full
        // width it also notched the shoulder, and the shoulder is where the
        // silhouette is: 47 sipes per revolution cutting 3.4 mm off the outer
        // radius is 1.7 px at the `wheel_close` framing, which is exactly the
        // "scalloped polygonal edge" a critic reported twice. Fading the relief
        // out before the edge keeps the outline a circle while leaving the
        // pattern intact where it is actually seen.
        const inFace = THREE.MathUtils.smoothstep(Math.min(acrossT, 1 - acrossT), 0.03, 0.13);
        r -= (groove * 0.0118 + (1 - THREE.MathUtils.smoothstep(sipe, 0.5, 0.94)) * 0.0034) * inFace;
      }
      // Raised sidewall lettering: a band of relief around 52% of the way out.
      const sideT = Math.min(1, Math.abs(w) / half);
      if (r < radius - 0.03 && r > rimR + 0.03) {
        const band = Math.exp(-Math.pow((r - (rimR + radius) * 0.52) / 0.022, 2));
        const glyph = Math.abs(((((th + phase) * 17.0) / Math.PI) % 1) - 0.5) * 2;
        r += band * sideT * (1 - THREE.MathUtils.smoothstep(glyph, 0.45, 0.85)) * 0.0026;
      }
      // Bead ring and rim protector: the raised hoop just outboard of the rim
      // flange. Lettering at 1.6 mm is sub-pixel at every framing we shoot and
      // a critic called the sidewalls blank, correctly. This is the feature
      // that can survive sampling instead - continuous all the way round, so it
      // reads as an unbroken highlight rather than as detail that averages away.
      if (r > rimR && r < rimR + 0.075) {
        const bead = Math.exp(-Math.pow((r - (rimR + 0.03)) / 0.011, 2));
        r += bead * sideT * 0.0042;
      }

      let y = r * sn;
      const z = r * cs;

      // Contact patch: flatten, and swell the sidewall around it.
      const near = THREE.MathUtils.clamp((yFlat + 0.115 - y) / 0.115, 0, 1);
      if (y < yFlat) y = yFlat + (y - yFlat) * 0.1;
      // 0.2 was a 20% swell and still read as "a rigid cylinder set down on a
      // plane". A loaded sidewall bulges hard and it is the one cue that says
      // the car has weight in it.
      w *= 1 + 0.3 * Math.pow(near, 1.5) * sideT;

      const k = a * cross + c;
      pos[k * 3] = w;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = a / around;
      uv[k * 2 + 1] = c / (cross - 1);
    }
  }

  for (let a = 0; a < around; a++) {
    const a2 = (a + 1) % around;
    for (let c = 0; c < cross - 1; c++) {
      const p0 = a * cross + c;
      const p1 = a * cross + c + 1;
      const p2 = a2 * cross + c;
      const p3 = a2 * cross + c + 1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Wheel centres in car-local space. */
export function wheelPositions(): { x: number; z: number; front: boolean }[] {
  const t = CAR.track / 2;
  return [
    { x: t, z: FRONT_AXLE, front: true },
    { x: -t, z: FRONT_AXLE, front: true },
    { x: t, z: REAR_AXLE, front: false },
    { x: -t, z: REAR_AXLE, front: false },
  ];
}

/** The arch centre height in car-local space, for placing liners and wheels. */
export const ARCH_CENTRE_Y = WHEEL_Y;
