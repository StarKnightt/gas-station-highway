import * as THREE from "three";
import { LOW_SPOTS, PAD, ROAD, DRIVEWAYS, groundHeight } from "../site";
import { clamp01, fbm, makeRng, smoothstep } from "./noise";

/**
 * The soil field: the one place that decides, for any world XZ, how the ground
 * drains, how disturbed it is, how wet it is and which of the two soil
 * materials it is made of.
 *
 * Why this is a baked world-space field and not four analytic GLSL functions.
 *
 * Vegetation wants to scatter its inter-plant mat against the same field the
 * ground shades against, and the wet mask has to agree with the puddle
 * geometry to the pixel or the shoreline stops being a contour and becomes a
 * shape. Two independent implementations of "the same" field — one in TS and
 * one in GLSL — drift the moment either is edited, and the drift is invisible
 * until a critic names it. Baking once and having the CPU accessors read back
 * the *same bytes the sampler reads* makes disagreement impossible by
 * construction rather than by discipline, and `soilProbe()` measures what is
 * left (texture filtering and 8-bit quantisation) instead of assuming it.
 *
 * It also buys the thing an analytic field cannot give cheaply: `drainage` is
 * a height *relative to a local datum*, which is a neighbourhood operation. On
 * the CPU that is a blur over a grid; in a fragment shader it would be dozens
 * of taps per pixel.
 */

/** Metres of relief either side of the local datum that the R channel spans. */
const DRAIN_RANGE = 0.45;

/**
 * Half-width, in metres, of the neighbourhood that defines "the local datum".
 * Set from the drainage swale, which is the feature this has to see: the swale
 * is ~2.4 m wide and ~340 mm deep, so a datum window several times that reads
 * it as a hollow. A window much larger starts calling the whole site a hollow.
 */
const DATUM_METRES = 9.0;

/** One dish of standing water: an elliptical gate plus a water-surface height. */
export interface PoolDisc {
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** World Y of the water surface. */
  level: number;
}

export interface SoilField {
  /** RGBA world-space field. R drainage, G disturbance, B wetness, A material. */
  texture: THREE.DataTexture;
  /** World-space min corner (x, z). */
  origin: THREE.Vector2;
  /** World-space span (x, z). */
  size: THREE.Vector2;
  /** Metres of relief the R channel spans either side of the datum. */
  drainRange: number;
  /** Water surface height, in world Y, for each entry of `LOW_SPOTS`. */
  waterLevels: number[];
  /** The standing water, as the shader clips it: gate ellipse plus level. */
  pools: PoolDisc[];

  /** Metres above/below the local drainage datum; negative is a low spot. */
  drainage(x: number, z: number): number;
  /** 0 = undisturbed crust, 1 = trafficked / compacted. */
  disturbance(x: number, z: number): number;
  /** 0 = dry, 1 = standing water. */
  wetness(x: number, z: number): number;
  /** 0 = coarse gravelly crust, 1 = fine pale clay. */
  material(x: number, z: number): number;
}

/** Separable box blur with per-sample weights, so masked-out cells cost nothing. */
function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * radius + 1;
  for (let y = 0; y < n; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * n + Math.min(n - 1, Math.max(0, x))];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc / w;
      acc += src[y * n + Math.min(n - 1, x + radius + 1)] - src[y * n + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(n - 1, Math.max(0, y)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc / w;
      acc += tmp[Math.min(n - 1, y + radius + 1) * n + x] - tmp[Math.max(0, y - radius) * n + x];
    }
  }
  return out;
}

/** How far inside a driveway opening a point is, 0..1. */
function drivewayNear(x: number, z: number): number {
  if (z < -1 || z > PAD.minZ + 3) return 0;
  let best = 0;
  for (const d of DRIVEWAYS) {
    const half = (d.maxX - d.minX) / 2;
    const c = (d.minX + d.maxX) / 2;
    best = Math.max(best, 1 - smoothstep(half - 1.0, half + 4.0, Math.abs(x - c)));
  }
  return best;
}

/**
 * Builds the field.
 *
 * `metresHalf` is the half-extent covered. The native ground mesh runs to
 * +-420 m but nothing beyond about 150 m resolves as anything but a tone, and
 * the texture is clamped rather than wrapped so the far field simply inherits
 * the edge value instead of repeating — a repeat here would be a new
 * world-periodic signal, which is the defect this system is trying to remove.
 */
export function makeSoilField(n = 768, metresHalf = 180, seed = 7717): SoilField {
  const rng = makeRng(seed);
  const span = metresHalf * 2;
  const origin = new THREE.Vector2(-metresHalf, -metresHalf);
  const size = new THREE.Vector2(span, span);
  const mpp = span / n;

  // Low-frequency fields that decide *material* and roughen every hard edge.
  // Two scales, because a single one gives every patch the same size and the
  // eye reads equal-sized blobs as a pattern however irregular each one is.
  const matCoarse = fbm(n, 5, rng, { octaves: 4 });
  const matFine = fbm(n, 17, rng, { octaves: 3 });
  const edgeNoise = fbm(n, 29, rng, { octaves: 3 });
  const dampNoise = fbm(n, 11, rng, { octaves: 3 });

  // 1. The surface itself. `groundHeight` and not `dirtY`, because water and
  //    drainage are properties of whatever surface is actually there — the
  //    four LOW_SPOTS are all inside PAD, so the puddles are on asphalt.
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = origin.y + (j + 0.5) * mpp;
    for (let i = 0; i < n; i++) {
      h[j * n + i] = groundHeight(origin.x + (i + 0.5) * mpp, z);
    }
  }

  // 2. Local datum, and drainage as the departure from it. Blurred twice: one
  //    box pass leaves axis-aligned ringing that shows up as a faint square
  //    grid in the damp mask, which is exactly the kind of artefact this
  //    system exists to remove.
  const r = Math.max(1, Math.round(DATUM_METRES / mpp));
  const datum = boxBlur(boxBlur(h, n, r), n, r);

  const data = new Uint8Array(n * n * 4);

  // 3. Water levels, one per low spot: the lowest point inside the ellipse
  //    plus a fill fraction of its authored depth. Sampled from the same grid
  //    the shoreline will be clipped against, so the level cannot disagree
  //    with the surface it is standing on.
  const waterLevels = LOW_SPOTS.map((s) => {
    let lo = Infinity;
    const i0 = Math.max(0, Math.floor((s.x - s.rx - origin.x) / mpp));
    const i1 = Math.min(n - 1, Math.ceil((s.x + s.rx - origin.x) / mpp));
    const j0 = Math.max(0, Math.floor((s.z - s.rz - origin.y) / mpp));
    const j1 = Math.min(n - 1, Math.ceil((s.z + s.rz - origin.y) / mpp));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = origin.x + (i + 0.5) * mpp;
        const z = origin.y + (j + 0.5) * mpp;
        if (Math.hypot((x - s.x) / s.rx, (z - s.z) / s.rz) > 1) continue;
        lo = Math.min(lo, h[j * n + i]);
      }
    }
    if (!Number.isFinite(lo)) lo = PAD.y;
    // Rain that fell overnight and has been draining and evaporating since:
    // part-full, so the shoreline sits up the side of the dish where the
    // contour is closely spaced and the fringe has somewhere to live.
    return lo + s.depth * 0.62;
  });

  for (let j = 0; j < n; j++) {
    const z = origin.y + (j + 0.5) * mpp;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = origin.x + (i + 0.5) * mpp;

      const rel = h[k] - datum[k];

      /* ---- disturbance: where people and vehicles actually go ---- */
      // The verge either side of the pavement is walked, parked on and graded;
      // ten metres out nothing has touched it in years.
      const offRoad = Math.abs(z) - ROAD.halfPaved;
      const vergeRoad = offRoad > 0 ? 1 - smoothstep(1.0, 7.0, offRoad) : 0;
      const offPad = Math.max(
        Math.max(PAD.minX - x, x - PAD.maxX),
        Math.max(PAD.minZ - z, z - PAD.maxZ)
      );
      const vergePad = offPad > 0 ? 1 - smoothstep(0.6, 5.5, offPad) : 0;
      const turnIn = drivewayNear(x, z);
      let dist = Math.max(Math.max(vergeRoad, vergePad), turnIn * 0.9);
      // Nothing in the world has a smooth analytic edge. Chew the boundary with
      // the same grain the ground is made of, or the compacted band reads as an
      // airbrushed gradient parallel to the kerb.
      dist = clamp01(dist * (0.72 + edgeNoise[k] * 0.62) - (0.5 - matFine[k]) * 0.22);

      /* ---- wetness ---- */
      // Hollows hold what fell last night; crests have already given it up to
      // the sun and the wind. Keyed off drainage so the damp agrees with the
      // silhouette instead of being an unrelated stain.
      let wet = clamp01(-rel / 0.34) * (0.30 + dampNoise[k] * 0.62);
      // Compacted ground sheds rather than absorbs, so a trafficked hollow
      // stays wet longer than an undisturbed one.
      wet = clamp01(wet * (0.8 + dist * 0.5));
      // A swale drains; it does not hold. Capped below the pooling threshold so
      // the 700 m of highway ditch reads as damp ground - darker, a little
      // smoother - and never as a continuous ribbon of standing water down the
      // whole frontage, which is what an uncapped drainage term produced. Only
      // the four authored LOW_SPOTS below are allowed to pool.
      wet = Math.min(wet, 0.46);
      // Standing water is deliberately NOT baked here. It used to be, and the
      // result was the airbrushed blob this system exists to avoid, for two
      // compounding reasons that are both invisible in the source.
      //
      // First, the grid: 0.47 m per texel, bilinear. No shoreline drawn in it
      // can be sharper than half a metre no matter what the threshold is.
      //
      // Second, and much worse, the slope. These dishes are 60-90 mm deep and
      // 5 m across, so the pavement falls about 20 mm per metre near the
      // waterline. A threshold band of even 55 mm of height - which reads as a
      // tight tolerance - is therefore nearly three metres of ground, i.e. the
      // whole puddle is edge. Multiplying that by a smoothstep on the ellipse
      // radius, which is what the previous version did, added a second and
      // larger radial gradient on top of the first.
      //
      // The water level is a plane. The right test is the fragment's own world
      // Y against that plane, per pixel, which `wdPool` in worldDetail.ts now
      // does; the field keeps only the damp, which genuinely is diffuse and
      // genuinely does live at this resolution.

      /* ---- material ---- */
      // Fines wash downhill and settle out in the hollows; the crests keep the
      // gravel and the pale dust. Traffic grinds gravel to the surface, so a
      // compacted turn-in goes the other way. This is what makes the two
      // materials read as geology rather than as two brightnesses.
      let mat = matCoarse[k] * 0.62 + matFine[k] * 0.38;
      mat = clamp01(mat + clamp01(-rel / 0.3) * 0.42 - dist * 0.34 - 0.08);

      const o = k * 4;
      data[o] = Math.round(clamp01(0.5 + Math.max(-1, Math.min(1, rel / DRAIN_RANGE)) * 0.5) * 255);
      data[o + 1] = Math.round(dist * 255);
      data[o + 2] = Math.round(wet * 255);
      data[o + 3] = Math.round(mat * 255);
    }
  }

  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  // Clamped, never wrapped: see makeSoilField's doc comment.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  /**
   * Bilinear read of the same bytes the sampler reads, with the same
   * clamp-to-edge and the same half-texel convention as `texture2D`. This is
   * the whole point of the module: the CPU answer and the GPU answer are the
   * same number, not two numbers that ought to agree.
   */
  const sample = (x: number, z: number, ch: number): number => {
    const u = (x - origin.x) / size.x;
    const v = (z - origin.y) / size.y;
    const fx = Math.min(n - 1, Math.max(0, u * n - 0.5));
    const fy = Math.min(n - 1, Math.max(0, v * n - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (px: number, py: number) => data[(py * n + px) * 4 + ch] / 255;
    return (
      at(x0, y0) * (1 - tx) * (1 - ty) +
      at(x1, y0) * tx * (1 - ty) +
      at(x0, y1) * (1 - tx) * ty +
      at(x1, y1) * tx * ty
    );
  };

  /**
   * The pool descriptors the shader clips against, and the CPU's copy of the
   * same test. Analytic, off the grid entirely: `groundHeight` is the function
   * the pavement mesh was built from, so this asks the identical question the
   * fragment shader asks of `vWDetailPos.y`.
   *
   * The one thing it does not reproduce is the shader's sub-centimetre jitter
   * of the water level, which is what makes the visible margin ragged. Inside
   * a pool and on dry ground the two agree exactly; within about 0.2 m of the
   * waterline the CPU answer is the un-jittered contour.
   */
  const pools: PoolDisc[] = LOW_SPOTS.map((s, i) => ({
    x: s.x,
    z: s.z,
    rx: s.rx,
    rz: s.rz,
    level: waterLevels[i],
  }));

  const poolAt = (x: number, z: number): number => {
    let p = 0;
    for (const d of pools) {
      const gate = 1 - smoothstep(0.94, 1.06, Math.hypot((x - d.x) / d.rx, (z - d.z) / d.rz));
      if (gate <= 0) continue;
      p = Math.max(p, gate * smoothstep(-0.0016, 0.0016, d.level - groundHeight(x, z)));
    }
    return p;
  };

  return {
    texture,
    origin,
    size,
    drainRange: DRAIN_RANGE,
    waterLevels,
    pools,
    drainage: (x, z) => (sample(x, z, 0) - 0.5) * 2 * DRAIN_RANGE,
    disturbance: (x, z) => sample(x, z, 1),
    wetness: (x, z) => Math.max(sample(x, z, 2), poolAt(x, z)),
    material: (x, z) => sample(x, z, 3),
  };
}
