/**
 * Single source of truth for the site plan. Every later system (pumps, canopy,
 * building, signage, vegetation) reads these numbers so nothing drifts.
 * All units are metres; +Z points away from the highway into the site.
 */

export const ROAD = {
  /** US standard 12 ft travel lane. */
  laneWidth: 3.66,
  /** Half width of paved surface: one travel lane + 1.5 m paved shoulder. */
  halfPaved: 5.16,
  /** Crown height at the centreline. */
  centreY: 0.15,
  /** 2% cross slope on the travel lanes. */
  crossSlope: 0.028,
  /** 5% on the shoulder. */
  shoulderSlope: 0.05,
  length: 700,
  /** Painted edge line and centre line widths (4 in). */
  paintWidth: 0.102,
};

/** The paved station pad (asphalt). */
export const PAD = { minX: -24, maxX: 26, minZ: 8.4, maxZ: 40.5, y: 0.155 };

/** Gaps in the front curb where vehicles enter. */
export const DRIVEWAYS = [
  { minX: -19.5, maxX: -7.5 },
  { minX: 5.5, maxX: 17.5 },
];

/** Concrete forecourt slab under the (future) canopy and pumps. */
export const FORECOURT = { minX: -11.6, maxX: 11.6, minZ: 12.4, maxZ: 27.2 };

/** Raised pump islands: 9.0 m x 1.2 m, 0.15 m curb reveal. */
export const ISLAND = { length: 9.0, width: 1.2, reveal: 0.15 };
export const ISLANDS = [
  { cx: 0, cz: 16.6 },
  { cx: 0, cz: 23.2 },
];

/** Parking stalls, standard 2.75 m x 5.5 m. */
export const PARKING = {
  originX: 9.6,
  z0: 32.0,
  depth: 5.5,
  stallWidth: 2.75,
  count: 6,
};

/** Reserved footprint for the store building (built by a later system). */
export const BUILDING = { minX: -17, maxX: 3.5, minZ: 31.5, maxZ: 40.0 };

/** World-space region covered by the non-repeating site overlay map. */
export const OVERLAY_REGION = { minX: -46, maxX: 46, minZ: -16, maxZ: 50 };

/**
 * Prevailing wind. Single source of truth, because at least four systems have
 * to agree about it or the scene contradicts itself: tree lean, litter drift,
 * the lee side of every obstacle and any smoke or dust all point the same way
 * in a photograph, and a viewer reads a disagreement as fake long before
 * being able to say why.
 *
 * The bearing is VegetationSystem's existing local constant, adopted verbatim
 * rather than re-authored, so the trees that were already leaning keep leaning
 * the way they lean. Convention is its convention: radians, the direction the
 * wind blows *toward*, in the XZ plane.
 */
/**
 * The ragged asphalt edge, as one place. Published through the `pavementEdge`
 * service so consumers read the function and not the number — Vegetation was
 * reasoning against a hardcoded 190 mm, and a shared constant is a number two
 * systems can disagree about while a published function is not.
 *
 * 400 mm on Vegetation's answer: what limits it is not the excursion but how
 * far a tuft's *centre* lands on asphalt, and its inset is a fraction of the
 * declared excursion so its worst case holds as this grows. At 400 mm over the
 * ~1 m wavelength of a scallop the edge line is already at a 40% slope, so the
 * geometry runs out before that tolerance does; that, and not the mask, is the
 * ceiling now.
 */
export const ROAD_EDGE = {
  excursion: 0.4,
  sag: 0.011,
  seedMinus: 811,
  seedPlus: 977,
};

export const WIND = {
  bearing: 2.9,
  /** 0..1. Light. Dawn is usually the stillest part of the day. */
  strength: 0.35,
};

/** Sun: ~11 degrees elevation, low in the west-south-west. Direction *to* the sun. */
export const SUN = {
  azimuth: Math.PI * 1.13,
  elevation: (11.0 * Math.PI) / 180,
};

/* ------------------------------------------------------------------ */
/* height field                                                        */
/* ------------------------------------------------------------------ */

/**
 * Smooth low-frequency undulation; keeps the ground from being mathematically
 * flat. Deliberately built only from continuous terms: any hash/step component
 * makes the height field disagree between two meshes that sample it at
 * different tessellations, which shows up as one surface punching through
 * another.
 */
export function undulation(x: number, z: number, amp: number): number {
  return (
    (Math.sin(x * 0.081 + 1.7) * Math.cos(z * 0.063 - 0.4) * 0.55 +
      Math.sin(x * 0.031 - z * 0.027) * 0.3 +
      Math.sin(x * 0.21 + z * 0.17) * 0.09 +
      Math.sin(x * 0.47 - z * 0.53 + 2.3) * 0.05 +
      Math.cos(x * 0.71 + z * 0.61 - 1.1) * 0.03) *
    amp
  );
}

/**
 * Debug amplifiers, driven by `?force=crown,ruts,fall`. The harness renders with
 * these on and pixel-diffs against the normal render: if forcing a feature to an
 * absurd value does not move pixels, the feature is not wired up and no amount
 * of aesthetic tuning will ever show it.
 */
export const FORCE = (() => {
  /**
   * One switch for the browser and for CPU probes, and the reason matters.
   *
   * This used to read `location.search` alone, so in Node `raw` was always ""
   * and every forced-off token was silently ignored. CPU probes therefore had
   * to re-implement the gating themselves through their own env var — two
   * mechanisms for one concept, and the probe's copy no-oped the moment the
   * names drifted apart. It did drift: a control arm asking for `nochurn` ran
   * the census with churn fully on and reported the arms identical to 0.001,
   * which reads exactly like "the feature does nothing". A control that does
   * nothing and a feature that does nothing are indistinguishable, and the
   * control is the thing that was supposed to tell them apart.
   *
   * So the env var is read by the same table that reads the query string, and
   * `TFORCE=nochurn node tools/x.mjs` and `?force=nochurn` are now the same
   * switch with the same validation.
   */
  const fromQuery = typeof location !== "undefined" ? new URLSearchParams(location.search).get("force") ?? "" : "";
  // Reached through `globalThis` rather than the bare name: this file is
  // bundled for the browser, where `process` is not declared, so naming it
  // directly breaks the typecheck for the five agents who share this tree.
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const fromEnv = g.process?.env?.TFORCE ?? "";
  const raw = [fromQuery, fromEnv].filter(Boolean).join(",");
  const on = new Set(raw.split(",").filter(Boolean));
  // An unrecognised token used to be ignored in silence, which returns a
  // byte-identical capture for a typo and is read as "the feature is not mine"
  // (NOTES.md case 25). Reported rather than thrown because this runs at module
  // evaluation, where a throw takes the whole page down instead of one system;
  // `TerrainSystem.init` re-checks and throws, so it lands in __SYSTEM_ERRORS.
  const KNOWN = [
    "crown", "ruts", "fall", "ao", "wheel", "wheelviz", "driven", "patch",
    "paintviz", "noerode", "bleed", "aggro", "lotmat", "aisle", "noruts",
    "nochurn", "nohum",
  ];
  const unknown = [...on].filter((k) => !KNOWN.includes(k));
  if (unknown.length) {
    console.error(`[site] unknown ?force= token(s): ${unknown.join(", ")}. Known: ${KNOWN.join(", ")}`);
  }
  return {
    /** Non-empty when the query carried a token nothing consumes. */
    unknown,
    crown: on.has("crown") ? 5 : 1,
    // `noruts` is the forced-off arm the entrance tracks needed. Their slope
    // census beats the surrounding frontage two to one, but "beats" is only a
    // claim until something has run with the term at zero: a feature that does
    // nothing and a feature that is subtle produce the same number.
    ruts: on.has("noruts") ? 0 : on.has("ruts") ? 14 : 1,
    /**
     * Forced-off arms for the two far-ground relief terms. Both were added
     * against the critic note that the ground "takes no relief lighting at
     * all", both are meant to be felt rather than seen, and that is exactly
     * the class of feature that cannot be confirmed from a frame.
     */
    churn: on.has("nochurn") ? 0 : 1,
    hum: on.has("nohum") ? 0 : 1,
    fall: on.has("fall") ? 12 : 1,
    ao: on.has("ao"),
    wheel: on.has("wheel") || on.has("wheelviz"),
    wheelViz: on.has("wheelviz"),
    driven: on.has("driven"),
    patch: on.has("patch"),
    paintViz: on.has("paintviz"),
    noErode: on.has("noerode"),
    bleed: on.has("bleed"),
    aggro: on.has("aggro"),
    lotMat: on.has("lotmat"),
    aisle: on.has("aisle"),
  };
})();

/**
 * Longitudinal grade of the whole site: settlement and heave over tens of
 * metres. Cross-crown is only ~100 mm over a lane and, with nothing casting a
 * shadow yet, it barely registers; what actually kills the "flat cut-out on a
 * flat plane" read at a grazing camera is that the edge stripes and pavement
 * boundaries otherwise run dead straight to the horizon. Every surface adds
 * this same term so they all stay welded together where they meet.
 */
export function grade(x: number): number {
  return (
    Math.sin(x * 0.0197 + 0.7) * 0.115 + Math.sin(x * 0.0561 + 2.3) * 0.048 + Math.sin(x * 0.1103 + 4.1) * 0.019
  );
}

/** Highway surface: crowned centreline, parabolic lanes, 5% shoulders. */
export function roadY(z: number): number {
  const a = Math.abs(z);
  const cross = ROAD.crossSlope * FORCE.crown;
  const shoulder = ROAD.shoulderSlope * FORCE.crown;
  // Parabolic crown rather than a straight tent: the slope increases toward the
  // edge, which gives a continuous shading gradient across the lane instead of
  // a single crease that hides under the centreline paint.
  if (a <= ROAD.laneWidth) return ROAD.centreY - cross * ROAD.laneWidth * Math.pow(a / ROAD.laneWidth, 1.5);
  const edge = ROAD.centreY - ROAD.laneWidth * cross;
  if (a <= ROAD.halfPaved) {
    // Pavement edges settle away from the travelled way as the base course
    // loses support, so the last metre drops faster than the shoulder slope.
    const sag = smoothEdge((a - (ROAD.halfPaved - 1.1)) / 1.1) * 0.032 * FORCE.crown;
    return edge - (a - ROAD.laneWidth) * shoulder - sag;
  }
  return edge - (ROAD.halfPaved - ROAD.laneWidth) * shoulder - 0.032 * FORCE.crown;
}

function smoothEdge(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** A soft depression centred on `d = 0`. Used for wheel ruts and birdbaths. */
function trough(d: number, halfWidth: number, depth: number): number {
  const t = Math.min(1, Math.abs(d) / halfWidth);
  return -depth * (1 - t * t) * (1 - t * t);
}

/**
 * Wheel paths of a two-lane road, 1.8 m apart about each lane centre. Loaded
 * trucks rut the outer wheel path more than the inner one, and the rutting
 * comes and goes along the length rather than running dead straight.
 */
function roadRuts(x: number, z: number): number {
  let d = 0;
  for (const lc of [-ROAD.laneWidth / 2, ROAD.laneWidth / 2]) {
    for (const off of [-0.9, 0.9]) {
      const wander = Math.sin(x * 0.037 + off * 2.1) * 0.09;
      const amount = 0.55 + 0.45 * Math.sin(x * 0.021 + lc);
      d += trough(z - (lc + off) - wander, 0.66, 0.031 * amount * FORCE.ruts);
    }
  }
  return d;
}

export function roadSurface(x: number, z: number): number {
  return roadY(z) + grade(x) + roadRuts(x, z) + undulation(x, z, 0.028);
}

/**
 * Station pad: drains from a soft crown near the pumps out to the curb lines,
 * so water pools along the edges. Also carries gentle construction waviness.
 */
/**
 * Low points the lot drains to. Authored explicitly (rather than falling out of
 * noise) because the wetness system will want to put standing water here, and
 * the overlay paints its damp patches at the same coordinates.
 */
export const LOW_SPOTS = [
  { x: 22.6, z: 38.2, rx: 5.4, rz: 2.6, depth: 0.092 },
  { x: -19.6, z: 10.6, rx: 4.4, rz: 1.8, depth: 0.07 },
  { x: -3.5, z: 31.6, rx: 3.4, rz: 3.0, depth: 0.052 },
  { x: 12.5, z: 10.4, rx: 5.6, rz: 1.7, depth: 0.062 },
];

/** Drive lanes across the forecourt, where the pavement has settled into ruts. */
const PAD_LANES = [14.7, 18.5, 21.3, 25.1];

export function padY(x: number, z: number): number {
  const t = (z - PAD.minZ) / (PAD.maxZ - PAD.minZ);
  const crown = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.145 * FORCE.crown;
  const lateral = Math.cos(((x - 2) / (PAD.maxX - PAD.minX)) * Math.PI) * 0.105 * FORCE.fall;

  // Settling under the fuelling lanes: two wheel paths per lane.
  let ruts = 0;
  for (const lz of PAD_LANES) {
    for (const off of [-0.85, 0.85]) {
      const amount = 0.5 + 0.5 * Math.sin(x * 0.13 + lz);
      ruts += trough(z - lz - off, 0.58, 0.026 * amount * FORCE.ruts);
    }
  }
  // The turn-in from each driveway is worn into a shallow swale of its own.
  for (const d of DRIVEWAYS) {
    const cx = (d.minX + d.maxX) / 2;
    ruts += trough(Math.hypot((x - cx) / 7.0, (z - 11.5) / 3.0) * 3.0, 3.0, 0.045 * FORCE.fall);
  }

  let dip = 0;
  for (const s of LOW_SPOTS) {
    const r = Math.hypot((x - s.x) / s.rx, (z - s.z) / s.rz);
    if (r < 1) dip += trough(r, 1, s.depth * FORCE.fall);
  }

  return PAD.y + grade(x) + crown + lateral + ruts + dip + undulation(x, z, 0.115);
}

/**
 * Driveway apron: exactly meets the road shoulder at one end and the pad at the
 * other, so the three surfaces share vertices without a seam or z-fight.
 */
export function drivewayY(x: number, z: number): number {
  const z0 = ROAD.halfPaved;
  const z1 = PAD.minZ;
  const t = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  const s = t * t * (3 - 2 * t);
  return roadSurface(x, z0) * (1 - s) + padY(x, z1) * s;
}

export const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Distance from a point to a rectangle in XZ; zero inside. */
export function rectDist(x: number, z: number, r: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Metres of clear ground between (x, z) and the nearest hard surface, 0 when the
 * point is on one.
 *
 * Published because Terrain, Vegetation and Car are all scattering into the same
 * near field and each needs the same question answered: is this spot dirt. Three
 * private answers to that produce the classic seam — one system's gravel on
 * another system's asphalt, and a bare ring where both decided to stay clear.
 * `pavementEdge(x)` already gives the highway edge line; this covers the pad,
 * the driveways and the carriageway too, which is what a scatter actually needs.
 *
 * Range and units, since that is part of the contract: **metres, 0 or positive,
 * saturating at 60.** Zero means "on pavement", which makes `pavedDistance > d`
 * a clearance test and NOT a multiplier — it is unbounded above in principle and
 * a consumer wanting a weight should divide by its own clearance and clamp.
 *
 * The ragged highway edge is included via `ROAD_EDGE.excursion` rather than the
 * exact `ragOffset`, so this is conservative by up to 400 mm on the highway
 * verge: it will call a strip of dirt "pavement" and never the reverse. That
 * asymmetry is deliberate — scattering a stone onto asphalt is a visible defect
 * and leaving a 200 mm strip bare is not.
 */
export function pavedDistance(x: number, z: number): number {
  // Carriageway, plus the shoulder, widened by the edge wander.
  const road = Math.abs(z) - (ROAD.halfPaved + ROAD_EDGE.excursion);
  let d = Math.max(0, road);

  d = Math.min(d, rectDist(x, z, PAD));

  // Driveway aprons run from the shoulder to the pad edge.
  for (const dr of DRIVEWAYS) {
    d = Math.min(d, rectDist(x, z, { minX: dr.minX, maxX: dr.maxX, minZ: ROAD.halfPaved, maxZ: PAD.minZ }));
  }
  return Math.min(60, d);
}

/** How much a point is inside a driveway opening (widened for the flare). */
function drivewayInfluence(x: number): number {
  let best = 0;
  for (const d of DRIVEWAYS) {
    const half = (d.maxX - d.minX) / 2;
    const c = (d.minX + d.maxX) / 2;
    best = Math.max(best, 1 - smooth01(half - 0.5, half + 2.6, Math.abs(x - c)));
  }
  return best;
}

/**
 * Native ground. Under anything paved it is pushed well down so it can never
 * poke through. Outside, it carries a drainage swale along the highway (very
 * typical of US rural frontage) and rises to roughly top-of-curb next to the
 * lot.
 */
export function dirtY(x: number, z: number): number {
  const insidePad = x > PAD.minX && x < PAD.maxX && z > PAD.minZ && z < PAD.maxZ;
  if (insidePad) return PAD.y - 0.35 + undulation(x, z, 0.03);
  if (Math.abs(z) < ROAD.halfPaved) return roadY(z) - 0.35 + undulation(x, z, 0.03);

  const outPad = rectDist(x, z, PAD);
  const outRoad = Math.abs(z) - ROAD.halfPaved;
  const padInfl = 1 - smooth01(0.0, 9.0, outPad);

  // Broad terrain relief, held flat over the site and ramped in beyond about
  // 70 m. Without it the horizon is a ruled line and the whole scene reads as a
  // CAD plane with a texture on it.
  const far = smooth01(70, 260, Math.max(Math.abs(x), Math.abs(z)));
  const swell =
    (Math.sin(x * 0.0092 + 0.7) * Math.cos(z * 0.0071 - 1.3) * 1.5 +
      Math.sin(x * 0.0037 - z * 0.0051 + 2.2) * 2.4 +
      Math.cos(x * 0.021 + z * 0.017) * 0.35) *
    far;

  let base = 0.04 + swell;
  base = base * (1 - padInfl) + (PAD.y + 0.03) * padInfl;

  // Drainage swale, deepest ~2 m off the pavement edge, and the berm behind it.
  //
  // The berm is the spoil from cutting the swale, pushed up and left there,
  // which is what actually happens on rural frontage and is why the shoulder of
  // a highway is a ditch-and-bank rather than a ditch. It earns its place here
  // for a second reason: its back slope is about 0.19, and the sun sits at 11
  // degrees, whose tangent is 0.194. A surface whose slope brackets the solar
  // elevation is the only kind that produces raking light - one face lit, the
  // next in shadow - so this single feature turns 700 m of frontage from a flat
  // brown field into a lit edge and a dark edge running to the horizon.
  const swale = Math.exp(-Math.pow((outRoad - 2.0) / 2.4, 2));
  base -= swale * 0.34 * (1 - padInfl * 0.45);
  const berm = Math.exp(-Math.pow((outRoad - 7.4) / 2.3, 2));
  base += berm * 0.44 * (1 - padInfl);

  // Meet the pavement edge cleanly.
  const lip = 1 - smooth01(0.0, 1.1, outRoad);
  base = base * (1 - lip) + (roadY(ROAD.halfPaved) - 0.05) * lip;

  // Driveways cut straight through the swale.
  if (z > 0 && z < PAD.minZ + 1.5) {
    const dw = drivewayInfluence(x);
    if (dw > 0) base = base * (1 - dw) + (drivewayY(x, Math.min(z, PAD.minZ)) - 0.05) * dw;
  }

  const flat = Math.max(padInfl, 1 - smooth01(0.0, 7.0, Math.max(0, outRoad)));

  /**
   * Hummocks: the mid-scale relief that lets the ground take relief lighting.
   *
   * The existing terms bracket this scale without covering it. `swell` runs at
   * wavelengths of 600 m and up, which moves the horizon and nothing else, and
   * `undulation`'s dominant terms sit at 78-100 m for an amplitude under half a
   * metre, i.e. slopes around 0.006. The sun is at 11 degrees. A slope of 0.006
   * under a light at 0.194 is, for shading purposes, a plane - which is exactly
   * what a reviewer working from frames alone reported, in those words, without
   * being able to see why.
   *
   * What produces raking light is slope, not amplitude, and slope is amplitude
   * times spatial frequency. So the band matters more than the height: these
   * sit at 16 to 31 m, where half a metre of rise is a slope of 0.10 to 0.20
   * and each crest throws two to three metres of shadow downsun. Total relief
   * is under a metre, which is nothing against a 700 m frontage, but it is the
   * difference between a brown plane and graded ground.
   *
   * The lower bound on wavelength is set by the mesh, not by taste. The native
   * ground is 840 m across 340 segments, i.e. 2.47 m per quad, so anything
   * under about 12 m has fewer than five samples per cycle and turns into
   * faceting that moves as the camera does. Buying finer relief means buying
   * vertices, and this system already covers the whole scene; the honest move
   * is to stay above the sampling limit rather than to quadruple the mesh.
   */
  const hum =
    Math.sin(x * 0.203 + z * 0.128 + 0.9) * Math.cos(z * 0.171 - x * 0.094 - 2.1) * 0.30 +
    Math.sin(x * 0.114 - z * 0.147 + 1.7) * 0.26 +
    Math.cos(x * 0.318 + z * 0.261 + 0.3) * 0.11;

  /**
   * Near-field churn: the 3-5 m unevenness of ground that was graded once and
   * then driven over. Same slope-versus-solar-tangent argument as `hum`, one
   * band down - 0.13 m of relief at 3-5 m wavelengths is a slope of 0.11 to
   * 0.24, which brackets the sun's 0.194 and therefore casts rather than just
   * shades.
   *
   * Gated to the region where the ground mesh is fine. The mesh is graded, so
   * vertices are ~0.55 m apart over the site and ~3 m apart beyond it, and a
   * 3 m wavelength outside the fine zone would be sampled once per cycle: it
   * would not read as relief, it would read as facets crawling as the camera
   * moves. A height field on a graded mesh has a position-dependent Nyquist
   * limit and has to respect it, which a uniform mesh let us ignore.
   */
  /**
   * Authored tracks at the entrances, where vehicles cut the corner.
   *
   * These are the one place on the site where a rut belongs, which is why they
   * are authored rather than falling out of a field: a truck turning off a
   * highway into a driveway does not follow the paving, it swings wide across
   * the dirt on the outside of the turn and comes back in, and it does that in
   * the same four places every time. Everywhere else the wheels are on asphalt.
   *
   * Sized to the mesh rather than to life. The ground is graded, so vertices
   * are ~0.65 m apart here; a real 0.3 m rut needs 0.15 m spacing and would be
   * a single spike of noise at this tessellation. A 1.3 m worn hollow per
   * wheel is what a track reads as from ten metres anyway, and the crown left
   * between the pair carries steeper local slope than either hollow does,
   * which is where the light actually catches.
   */
  let tracks = 0;
  {
    // The run, and its length was the thing holding these back. Shoulder to
    // pad edge is only 3.24 m here, so the first version was a 3 m track: too
    // short to read as a wheel path from any distance, whatever its depth.
    // Extended a metre back over the shoulder and three and a half past the
    // pad edge for a 7.7 m run, which is roughly one truck length and is what
    // a vehicle actually leaves when it swings wide off a highway.
    const z0 = ROAD.halfPaved - 1.0;
    const z1 = PAD.minZ + 3.5;
    const t = (z - z0) / (z1 - z0);
    if (t > -0.35 && t < 1.3) {
      // Swings widest at the road end and closes onto the driveway edge.
      //
      // The first version swung 3.4 m over the 3.24 m between the shoulder and
      // the pad, which is a 47 degree sweep: each wheel crossed several metres
      // of ground and left a smear rather than a track, and the slope census
      // over the entrance strips came back within 0.002 of the forced-off arm.
      // 1.2 m of swing over the same run is a track that a wheel could have
      // made, and it concentrates the same displaced volume into a groove.
      const swing = 1.2 * Math.pow(1 - Math.min(1, Math.max(0, t)), 1.4);
      const fade = smooth01(-0.3, 0.05, t) * (1 - smooth01(0.9, 1.25, t));
      for (const d of DRIVEWAYS) {
        for (const side of [-1, 1]) {
          // Stood off the driveway edge, not hugging it. On groundHeight the
          // entrance band is mostly apron blend - dirtY and groundHeight
          // disagree by up to 0.65 m there - so a groove authored against the
          // paving edge is smoothed away by the very blend that makes the
          // apron. 2.2 m out is where the dirt starts winning.
          const centre = (side < 0 ? d.minX : d.maxX) + side * (2.2 + swing);
          for (const wheel of [-0.9, 0.9]) {
            // Depth comes and goes along the run; a rut that is uniformly deep
            // for its whole length reads as a moulding, not as wear.
            const wear = 0.62 + 0.38 * Math.sin(z * 0.9 + centre * 0.7);
            // 0.62 m half-width is two samples across at the graded mesh's
            // 0.63 m near spacing, which is the narrowest a groove can be here
            // and still be a groove rather than one vertex of noise. The
            // quartic's steepest wall is 0.175 * 1.54 / 0.62 = 0.43, more than
            // twice the 0.194 solar tangent, so these cast rather than shade.
            // Depth went 0.13 -> 0.175 with the longer run: the apron blend
            // still damps them, and the measurable effect of the first version
            // was 0.071 mean slope against 0.064 forced off, which is real but
            // thin for something meant to be the one authored feature here.
            tracks += trough(x - (centre + wheel), 0.62, 0.175 * wear * FORCE.ruts) * fade;
          }
        }
      }
    }
  }

  const nearFade = 1 - smooth01(62, 145, Math.hypot(x - 1, z - 20));
  /**
   * Near-field unevenness, rewritten twice: once to stop being a lattice, then
   * again to stop being one octave wide.
   *
   * The second rewrite is the interesting one, because the first was not
   * enough and the reason is not obvious. After de-latticing, the ground still
   * rendered as an evenly dappled stipple, and the natural read was "still a
   * lattice, rotate more bases". A 2-D autocorrelation of the rendered dirt
   * refuted that: r decays monotonically from 0.92 at a 2 px lag to zero by 40
   * px with NO secondary peak anywhere, which is the signature of a random
   * field and not of a repeat. There was nothing left to de-correlate.
   *
   * What was actually wrong is that the three waves had k = 1.07, 1.31 and
   * 2.21, a spread of 2.07x — barely one octave. A narrow-band random field is
   * still a random field, and it still looks like a pattern, because the eye
   * reads *scale uniformity* and not only periodicity: blobs of one size in
   * random positions read as texture applied to a surface rather than as the
   * shape of the surface. Real ground has clods at every size.
   *
   * So the band was widened to about 3.2 octaves, 13.7 m down to 1.8 m.
   *
   * The previous form was `sin(x) * cos(z)` with each argument domain-warped,
   * and it rendered as an evenly dappled stipple — a pebbled carpet rather than
   * uneven ground. That is the third instance of one error tonight (water
   * ripples, specular filigree, now this): **a product of an x-wave and a
   * z-wave is a lattice, and domain warping bends the cells without unaligning
   * them.** Warping moves the peaks; it does not stop there being one peak per
   * cell of a rectangular grid, so the eye still finds the grid.
   *
   * What works is superposing *directional* waves whose wavevectors are neither
   * axis-aligned nor rationally related. Three of them, on bases rotated 37 and
   * -61 degrees, sharing no common period in any direction.
   *
   * Amplitudes set by census rather than by eye: the first pass at the same
   * nominal amplitude as the product form measured a near-field mean slope of
   * 0.087 against the old 0.096, because three summed waves partly cancel where
   * a product does not. Scaled 1.18x to restore it, so the pattern changed and
   * the relief budget did not.
   */
  let churn = 0;
  if (nearFade > 0) {
    const u = x * 0.799 - z * 0.602;
    const v = x * 0.602 + z * 0.799;
    const r = x * 0.485 + z * 0.875;
    const w = -x * 0.875 + z * 0.485;
    const p = x * 0.94 + z * 0.34;
    const q = -x * 0.34 + z * 0.94;

    /**
     * Amplitude per octave is set so that each octave contributes the SAME
     * SLOPE, a / k held near 0.055. That follows directly from the finding that
     * shading responds to slope rather than height: equal amplitude per octave
     * would make the long wavelengths shade almost nothing and the short ones
     * dominate, and equal slope makes every scale equally visible, which is
     * what "ground with structure at every size" actually means.
     *
     * Nyquist is checked per octave against the LOCAL mesh spacing, not once
     * for the whole term. `nearFade` reaches zero at 145 m where vertices are
     * ~3.5 m apart, which is fine for a 14 m wave and hopeless for a 1.8 m one,
     * so the short octave gets its own tighter gate. This is the graded-mesh
     * consequence applied one level down: a single distance gate for a
     * multi-octave field is wrong for every octave but one.
     */
    const shortFade = 1 - smooth01(34, 52, Math.hypot(x - 1, z - 20));
    churn =
      (Math.sin(p * 0.46 + Math.sin(q * 0.29) * 1.4) * 0.112 + // 13.7 m, slope 0.052
        Math.sin(x * 1.31 + Math.sin(z * 0.79) * 1.2) * 0.061 + //  4.8 m, slope 0.080
        Math.sin(u * 1.07 + Math.sin(v * 0.63) * 1.1) * 0.057 + //  5.9 m, slope 0.061
        Math.sin(r * 2.21 - Math.sin(w * 1.43) * 0.8) * 0.035) * //  2.8 m, slope 0.077
        nearFade +
      // 1.8 m, slope 0.057. At the 0.63 m fine spacing that is 2.8 samples per
      // cycle; by 52 m the spacing has grown past its Nyquist limit, hence the
      // separate fade rather than sharing nearFade.
      Math.sin(q * 3.55 - Math.sin(p * 2.11) * 0.7) * 0.016 * shortFade;
    churn *= FORCE.churn;
  }

  return (
    base +
    grade(x) +
    hum * (1 - flat) * FORCE.hum +
    churn * (1 - flat) +
    tracks +
    undulation(x, z, 0.42 * (1 - flat * 0.86) + 0.03)
  );
}

export function inDriveway(x: number): boolean {
  return DRIVEWAYS.some((d) => x >= d.minX && x <= d.maxX);
}

/** Walkable surface height used by the player controller. */
export function groundHeight(x: number, z: number): number {
  if (x >= PAD.minX && x <= PAD.maxX && z >= PAD.minZ && z <= PAD.maxZ) {
    const onSlab =
      x >= FORECOURT.minX && x <= FORECOURT.maxX && z >= FORECOURT.minZ && z <= FORECOURT.maxZ ? 0.012 : 0;
    return padY(x, z) + onSlab;
  }
  if (Math.abs(z) <= ROAD.halfPaved) return roadSurface(x, z);
  if (inDriveway(x) && z > ROAD.halfPaved && z < PAD.minZ) return drivewayY(x, z);
  return dirtY(x, z);
}
