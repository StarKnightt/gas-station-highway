/**
 * Where loose matter comes to rest, as continuous functions of world XZ.
 *
 * ## Why this is one service and not four
 *
 * Litter, leaf fall, blown dust and gravel spill are not properties of the
 * things they collect against. They are properties of *where wind and water
 * stop*, and those places are continuous across a site and completely
 * indifferent to which system owns the object standing in them. Four systems
 * each scattering their own debris would ring every object neatly and leave
 * every corner bare, which is exactly backwards: the corner between a wall and
 * a curb collects more than the middle of a wall does, and the middle of an
 * open lot collects nothing at all no matter how many objects are near it.
 *
 * So the shape mirrors `groundSoil`: pure functions of world XZ, owned by
 * whoever owns the ground, sampled by everyone. No renderer state behind any
 * of it, so a scatter pass can call these a hundred thousand times before the
 * first frame.
 *
 * ## Two kinds of entry point, and the reason for the split
 *
 * **Fields** — `shelter`, `fines`, `litter`, `grime`, `swept` — answer "what
 * is on the ground here", and they cannot know about any caller's geometry
 * because Vegetation places its crowns and Building places its walls long
 * after this is built. They are made out of the ground: drainage, slope,
 * traffic and one prevailing wind.
 *
 * **Profiles** — `lee`, `wallBase`, `underCrown` — are pure functions the
 * caller evaluates against geometry only it knows. They take positions as
 * arguments and hold no state, so calling them is free and there is no
 * registration step, no ordering constraint between systems, and nothing to
 * get stale when a caller moves something.
 *
 * The intended use is a product: sample the field for how much matter this
 * patch of ground gets at all, multiply by the profile for how the caller's
 * own object concentrates it. A crown over swept pavement should drop less
 * than the same crown over a sheltered corner, and only the caller knows there
 * is a crown while only this knows the pavement is swept.
 *
 * ## What is deliberately not here
 *
 * No texture and no shader path. Everything above is CPU-side, because the
 * consumers are scatter passes that place objects. The ground's own shading
 * derives its dust and grime from drainage, wetness and slope directly - the
 * same inputs these functions are built from - rather than from a fifth field
 * channel, because the soil field's four channels are full and a second
 * 2048-square field would cost 22 MB to say something the shader can compute.
 */

import { DRIVEWAYS, FORECOURT, PAD, ROAD, WIND, groundHeight, rectDist, smooth01 } from "../site";
import type { SoilField } from "./groundSoil";

/** Prevailing wind, resolved to a unit vector in the sense site.WIND documents. */
export interface WindModel {
  /** Radians. The direction the wind blows *toward*, in the XZ plane. */
  bearing: number;
  dirX: number;
  dirZ: number;
  /** 0..1. Light, as dawn usually is; this is not a storm. */
  strength: number;
}

/** 0..1 pair describing the two distinct things that happen at a wall base. */
export interface WallBase {
  /**
   * Rain that hit the ground and bounced back onto the wall. Dirties the
   * bottom few hundred millimetres, strongest at grade, and stronger on the
   * face the weather is driven against.
   */
  splash: number;
  /**
   * Matter that blew or washed against the base and stayed: grit, leaves,
   * paper. Sits in a narrow band *out* from the wall rather than on it, and
   * favours the sheltered face, which is the opposite of splash.
   */
  drift: number;
}

/**
 * The measured distribution of a published field. **This is part of the
 * contract, not documentation.**
 *
 * "0..1" is true of every field here and tells a consumer almost nothing, and
 * the specific way it misleads has already cost this project twice. A field
 * whose max is 1.0 and whose p95 is 0.02 behaves nothing like one whose max is
 * 1.0 and whose p95 is 0.97, and a consumer that reaches for a bare multiplier
 * against a field whose neutral value is not zero gets the *sign* of its effect
 * wrong rather than the magnitude — which renders as the feature being absent,
 * this project's dominant defect class.
 *
 * So: percentiles rather than extremes, because a threshold has to be chosen
 * against where the mass actually is; a shape word, because two of these five
 * fields are bimodal and will read as hard masks if used as gradients; and an
 * explicit statement of whether zero means "no effect", because that is the
 * only property that makes `value * strength` safe.
 */
export interface FieldRange {
  units: string;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  /**
   * How the mass is distributed, measured on an 11,468-sample 1 m grid over the
   * lot. `bimodal` is the one to read carefully: the field spends its time near
   * one end or the other and almost none in between, so it behaves as a mask
   * with soft edges and NOT as a gradient.
   */
  shape: "unimodal" | "skewed" | "bimodal";
  /**
   * True when 0 means "no effect", so `x * strength` is safe and `strength = 0`
   * is a valid forced-off control. False when the neutral value is elsewhere,
   * in which case recentre first — and read the note.
   */
  safeAsMultiplier: boolean;
  note?: string;
}

export interface GroundAccum {
  wind: WindModel;

  /**
   * Measured range and distribution of every field above. Read this before
   * choosing a threshold or a multiplier. Measured by
   * `.shot-build/accumprobe.mjs` on a 1 m grid over the lot, n=11,468.
   */
  range: Record<"shelter" | "fines" | "litter" | "grime" | "swept", FieldRange>;

  /**
   * 0..1. How still the air is, from the ground alone - hollows, the highway
   * swale, and the wind shadow of the berm and the curb line. Does not include
   * any caller's own obstacle; multiply by `lee` for that.
   */
  shelter(x: number, z: number): number;

  /**
   * 0..1. Loose fine matter resting on the surface: blown dust, washed silt,
   * the grit that collects where nothing sweeps it. This is the general
   * "dirtiness of this patch of ground" term and the right thing to multiply a
   * dirt overlay or a decal opacity by.
   */
  fines(x: number, z: number): number;

  /**
   * Items per square metre of wind-blown litter - paper, cups, wrappers, the
   * things a station generates. Peaks near 0.11/m2 in a sheltered corner close
   * to a source and is essentially zero over five sixths of the site, which is
   * the correct distribution: litter is not sprinkled, it is swept into places,
   * and the first version of this integrated to ten items across a hundred
   * metres of frontage, which is a tidier lot than any real one.
   *
   * A density rather than a probability, so a scatter pass can multiply by its
   * own cell area and get a count without knowing anything about this file.
   */
  litter(x: number, z: number): number;

  /**
   * 0..1. Dark organic film - the black stuff on concrete that has been wet
   * and undisturbed. Needs standing water *and* a slope shallow enough that
   * the water does not move, so it is not the same shape as wetness.
   */
  grime(x: number, z: number): number;

  /** 0..1. Swept clean by wheels and feet. The soil field's disturbance. */
  swept(x: number, z: number): number;

  /**
   * 0..1 wake weight for a round obstacle the caller owns. 1 immediately
   * downwind of it, falling off over roughly five radii along the wind and
   * one and a third across.
   *
   * @param radius plan radius of the obstacle, metres
   */
  lee(x: number, z: number, ox: number, oz: number, radius: number): number;

  /**
   * The two things that happen where a vertical surface meets the ground.
   *
   * @param distOut metres out from the wall face, along its outward normal
   * @param up      metres above grade
   * @param faceX   outward normal of the wall, X (need not be normalised)
   * @param faceZ   outward normal of the wall, Z
   */
  wallBase(distOut: number, up: number, faceX: number, faceZ: number): WallBase;

  /**
   * 0..1 fall accumulation under a crown the caller owns. Peaks just inside
   * the drip line rather than at the trunk, because that is where a canopy
   * actually sheds, and the whole pattern is displaced downwind.
   *
   * @param radius crown radius in plan, metres
   */
  underCrown(x: number, z: number, cx: number, cz: number, radius: number): number;

  /**
   * Deterministic 0..1 hash of a world position and a salt. Here so consumers
   * can break up a field without seeding an RNG and without two systems
   * accidentally sharing a sequence: pass a different salt and the patterns
   * are independent, pass the same one and they agree.
   */
  jitter(x: number, z: number, salt: number): number;
}

const fract = (v: number) => v - Math.floor(v);

/** Local slope magnitude of the walkable surface, by central difference. */
function slopeAt(x: number, z: number): number {
  const e = 0.6;
  const gx = (groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e);
  const gz = (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
  return Math.hypot(gx, gz);
}

export function makeAccumField(soil: SoilField): GroundAccum {
  const wind: WindModel = {
    bearing: WIND.bearing,
    dirX: Math.cos(WIND.bearing),
    dirZ: Math.sin(WIND.bearing),
    strength: WIND.strength,
  };

  const jitter = (x: number, z: number, salt: number) =>
    fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 43.1) * 43758.5453);

  /**
   * Slowly varying analytic clumping, so accumulation is patchy at the scale
   * things actually pile at rather than smooth. Continuous, because a consumer
   * may difference this to find a gradient and a hash would give it noise.
   */
  const clump = (x: number, z: number, k: number, phase: number) =>
    0.5 +
    0.5 *
      (Math.sin(x * k + Math.sin(z * k * 0.63 + phase) * 1.4) * 0.6 +
        Math.sin(z * k * 0.81 - x * k * 0.37 + phase * 2.1) * 0.4);

  const shelter = (x: number, z: number): number => {
    // Hollows are still. drainage is metres below the local datum.
    const d = soil.drainage(x, z);
    let s = smooth01(0.05, -0.16, d);

    // The highway swale and the ditch behind the berm are the two strongest
    // wind traps on the site, and they are also the two places a real frontage
    // has visible drifts of paper in it.
    const outRoad = Math.abs(z) - ROAD.halfPaved;
    if (outRoad > 0) s = Math.max(s, Math.exp(-Math.pow((outRoad - 2.0) / 2.0, 2)) * 0.85);

    // The inside of the curb line: wind spilling over a 150 mm curb separates
    // and drops what it is carrying within a metre or so of it.
    const inPad = PAD.minX < x && x < PAD.maxX && PAD.minZ < z && z < PAD.maxZ;
    if (inPad) {
      const toEdge = Math.min(x - PAD.minX, PAD.maxX - x, z - PAD.minZ, PAD.maxZ - z);
      s = Math.max(s, (1 - smooth01(0.15, 1.6, toEdge)) * 0.75);
    }

    // Steep ground sheds rather than collects, whatever the air is doing.
    return Math.max(0, Math.min(1, s * (1 - smooth01(0.06, 0.22, slopeAt(x, z)))));
  };

  const swept = (x: number, z: number) => soil.disturbance(x, z);

  const fines = (x: number, z: number): number => {
    const sh = shelter(x, z);
    const sw = swept(x, z);
    // Scour: water moving fast enough to carry fines away. The same slope that
    // stops matter settling also washes off what did.
    const scour = smooth01(0.05, 0.20, slopeAt(x, z)) * Math.min(1, soil.wetness(x, z) * 2.2);
    const patch = 0.45 + 0.55 * clump(x, z, 0.21, 1.7);
    return Math.max(0, Math.min(1, (0.18 + 0.82 * sh) * (1 - sw * 0.85) * (1 - scour * 0.7) * patch));
  };

  const litter = (x: number, z: number): number => {
    // Sources. Litter does not appear where it rests, it arrives from
    // somewhere: the carriageway, and the forecourt where people stand.
    const fromRoad = 1 - smooth01(6, 34, Math.abs(z));
    const fromCourt =
      1 - smooth01(2, 26, rectDist(x, z, FORECOURT)) * 0.9;
    let source = Math.max(fromRoad * 0.8, fromCourt);
    for (const d of DRIVEWAYS) {
      const c = (d.minX + d.maxX) / 2;
      source = Math.max(source, (1 - smooth01(4, 22, Math.hypot(x - c, z - ROAD.halfPaved))) * 0.9);
    }

    const sh = shelter(x, z);
    // Clumped hard: a drift of paper is a few items in one metre and nothing
    // for twenty. Cubing the clump is what turns "varied" into "in places".
    const c = clump(x, z, 0.55, 4.3);
    const drift = c * c * c;
    return 0.22 * source * sh * drift * (1 - swept(x, z) * 0.9);
  };

  const grime = (x: number, z: number): number => {
    const wet = soil.wetness(x, z);
    // Standing, not running. Above about 0.05 the water is moving and the film
    // never gets established, which is why grime is not just dark wetness.
    const still = 1 - smooth01(0.02, 0.075, slopeAt(x, z));
    return Math.max(0, Math.min(1, wet * still * (1 - swept(x, z) * 0.55) * (0.6 + 0.4 * clump(x, z, 0.34, 0.9))));
  };

  const lee = (x: number, z: number, ox: number, oz: number, radius: number): number => {
    const rx = x - ox;
    const rz = z - oz;
    // Along the wind is downwind-positive; across is the lateral offset.
    const along = rx * wind.dirX + rz * wind.dirZ;
    const across = Math.abs(-rx * wind.dirZ + rz * wind.dirX);
    if (along < -radius * 0.4) return 0;
    const wake = Math.max(radius * 0.5, radius * 5);
    const halfWidth = radius * 1.35;
    const a = 1 - smooth01(-radius * 0.4, wake, along);
    const b = 1 - smooth01(halfWidth * 0.5, halfWidth, across);
    return Math.max(0, Math.min(1, a * b));
  };

  const wallBase = (distOut: number, up: number, faceX: number, faceZ: number): WallBase => {
    const n = Math.hypot(faceX, faceZ) || 1;
    // +1 when the face looks into the wind, -1 when it is in the lee.
    const facing = -((faceX / n) * wind.dirX + (faceZ / n) * wind.dirZ);
    // Splash is bounce, so it lives on the wall and dies with height. 180 mm
    // e-folding, i.e. essentially gone by half a metre, which is what the
    // dirt line on a real wall base measures.
    const splash =
      Math.exp(-Math.max(0, up) / 0.18) *
      (1 - smooth01(0.0, 0.22, Math.abs(distOut))) *
      (0.55 + 0.45 * Math.max(0, facing));
    // Drift is matter on the ground against the wall, so it lives *out* from
    // it and hardly at all above grade, and it prefers the sheltered face.
    const drift =
      (1 - smooth01(0.02, 0.30, Math.max(0, distOut))) *
      (1 - smooth01(0.0, 0.09, Math.max(0, up))) *
      (0.5 + 0.5 * Math.max(0, -facing));
    return { splash: Math.max(0, Math.min(1, splash)), drift: Math.max(0, Math.min(1, drift)) };
  };

  const underCrown = (x: number, z: number, cx: number, cz: number, radius: number): number => {
    // The whole pattern is displaced downwind, and a canopy sheds most heavily
    // just inside its drip line rather than at the trunk.
    const sx = cx + wind.dirX * radius * 0.3 * wind.strength;
    const sz = cz + wind.dirZ * radius * 0.3 * wind.strength;
    const r = Math.hypot(x - sx, z - sz) / Math.max(0.2, radius);
    // Peak at 0.72 of the radius, tailing to zero a third past the drip line.
    const ring = Math.exp(-Math.pow((r - 0.72) / 0.42, 2));
    const beyond = 1 - smooth01(1.0, 1.35, r);
    return Math.max(0, Math.min(1, ring * beyond * (0.55 + 0.45 * clump(x, z, 0.9, 2.6))));
  };

  /**
   * Measured, not asserted. Every number here came out of
   * `.shot-build/accumprobe.mjs` on a 1 m grid over the lot; if the fields are
   * retuned the probe is re-run and these move with them.
   */
  const range: GroundAccum["range"] = {
    shelter: {
      units: "dimensionless",
      min: 0.0,
      p50: 0.026,
      p95: 0.9998,
      max: 1.0,
      mean: 0.27,
      shape: "bimodal",
      safeAsMultiplier: true,
      note:
        "Half the lot is under 0.03 and a twentieth is over 0.999. Air is either " +
        "trapped or it is not. Use it as a mask with soft edges; using it as a " +
        "gradient will read as a hard cut with a fringe, because that is what it is.",
    },
    fines: {
      units: "dimensionless",
      min: 0.0057,
      p50: 0.147,
      p95: 0.682,
      max: 0.995,
      mean: 0.229,
      shape: "unimodal",
      safeAsMultiplier: true,
      note:
        "The well-behaved one, and the right default for a dirt overlay or a " +
        "decal opacity. Never reaches zero: no ground on this site is clean, " +
        "so do not rely on 0 to switch anything off — use your own gain for that.",
    },
    litter: {
      units: "items per square metre",
      min: 0.0,
      p50: 0.0,
      p95: 0.0168,
      max: 0.117,
      mean: 0.0031,
      shape: "skewed",
      safeAsMultiplier: true,
      note:
        "More than half the lot is exactly zero and the peak is 0.117/m2, so a " +
        "1 m cell at the worst spot has about a 12% chance of one item. This is " +
        "a DENSITY: multiply by your cell area to get a count. Treating it as a " +
        "probability at a 0.2 m cell scatters 25x too much litter.",
    },
    grime: {
      units: "dimensionless",
      min: 0.0,
      p50: 0.0,
      p95: 0.104,
      max: 0.881,
      mean: 0.015,
      shape: "skewed",
      safeAsMultiplier: true,
      note:
        "Deliberately rare: 10% of the lot is non-trivial and it reaches 0.88 " +
        "only where water both stands and does not move. If a consumer wants " +
        "'somewhere plausibly grimy' it should search for the maxima rather " +
        "than sample a point and hope.",
    },
    swept: {
      units: "dimensionless",
      min: 0.0,
      p50: 0.0039,
      p95: 0.967,
      max: 1.0,
      mean: 0.142,
      shape: "bimodal",
      safeAsMultiplier: true,
      note:
        "Bimodal for the same reason shelter is: ground is either on a traffic " +
        "path or it is not. Usually wanted as (1 - swept), which is then also " +
        "bimodal and near 1 over most of the site.",
    },
  };

  return { wind, range, shelter, fines, litter, grime, swept, lee, wallBase, underCrown, jitter };
}
