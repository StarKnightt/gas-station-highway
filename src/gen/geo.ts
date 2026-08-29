import * as THREE from "three";

/**
 * A subdivided horizontal surface built directly in world coordinates, so the
 * mesh can sit at the origin and its UVs are true world-space metres. That is
 * what lets several separate meshes share one seamless material.
 */
export function gridSurface(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  segX: number,
  segZ: number,
  heightAt: (x: number, z: number) => number,
  uvMetres: number
): THREE.BufferGeometry {
  const nx = segX + 1;
  const nz = segZ + 1;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const idx: number[] = [];

  for (let j = 0; j < nz; j++) {
    const z = minZ + ((maxZ - minZ) * j) / segZ;
    for (let i = 0; i < nx; i++) {
      const x = minX + ((maxX - minX) * i) / segX;
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = heightAt(x, z);
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / uvMetres;
      uv[k * 2 + 1] = z / uvMetres;
    }
  }
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Vertex positions along one axis, packed toward a region of interest.
 *
 * A uniform grid over a large plane spends its vertices where nobody is. The
 * native ground is 840 m square: at 2.47 m per quad it cannot represent a
 * wheel rut anywhere, including the twelve metres in front of the camera,
 * while spending the same density on ground 400 m away that is four pixels
 * tall. Subdividing uniformly to fix the near field multiplies the whole
 * plane, and most of that goes to the horizon.
 *
 * This returns a monotone, smoothly graded set of coordinates: `ratio` times
 * finer inside the focus than outside it, with the change spread over a wide
 * enough band that no row of quads is a visible discontinuity. Built by
 * integrating a density function and inverting the result numerically, which
 * is longer than a closed-form warp and has the advantage of letting the
 * density be described in the terms the problem is actually posed in.
 *
 * One mesh, so there is no seam, no T-junction and no z-fighting. Two meshes
 * at different tessellations sampling the same height field disagree by the
 * chord error of the coarser one - on this terrain about 59 mm - so an
 * overlaid detail patch would interpenetrate the plane it sits on. That is
 * the failure the height field's "continuous terms only" rule exists to
 * prevent, arriving through tessellation instead of through hashing.
 */
function gradedAxis(lo: number, hi: number, seg: number, focus: number, half: number, ratio: number): Float64Array {
  const M = 2048;
  const span = hi - lo;
  const cum = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) {
    const x = lo + (span * (i + 0.5)) / M;
    const d = Math.abs(x - focus);
    // Fine inside `half`, coarse beyond `half * 2.6`, smooth in between.
    const t = Math.min(1, Math.max(0, (d - half) / (half * 1.6)));
    const s = t * t * (3 - 2 * t);
    const density = 1 / (1 + (ratio - 1) * s);
    cum[i + 1] = cum[i] + density;
  }
  const total = cum[M];
  const out = new Float64Array(seg + 1);
  out[0] = lo;
  out[seg] = hi;
  let k = 0;
  for (let n = 1; n < seg; n++) {
    const target = (total * n) / seg;
    while (k < M && cum[k + 1] < target) k++;
    const f = (target - cum[k]) / (cum[k + 1] - cum[k]);
    out[n] = lo + (span * (k + f)) / M;
  }
  return out;
}

/**
 * `gridSurface` with the vertices packed toward a point of interest on each
 * axis. `focusRatio` of 1 reproduces a uniform grid exactly.
 */
export function gridSurfaceGraded(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  segX: number,
  segZ: number,
  heightAt: (x: number, z: number) => number,
  uvMetres: number,
  focus: { x: number; z: number; halfX: number; halfZ: number; ratio: number }
): THREE.BufferGeometry {
  const xs = gradedAxis(minX, maxX, segX, focus.x, focus.halfX, focus.ratio);
  const zs = gradedAxis(minZ, maxZ, segZ, focus.z, focus.halfZ, focus.ratio);
  const nx = segX + 1;
  const nz = segZ + 1;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const idx: number[] = [];

  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = heightAt(x, z);
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / uvMetres;
      uv[k * 2 + 1] = z / uvMetres;
    }
  }
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  /**
   * The height of the surface this mesh actually renders, as opposed to the
   * height field it was built from. Exact, not approximate: it finds the cell,
   * picks the same triangle the index buffer made, and interpolates that plane.
   *
   * Published because sampling `heightAt` to place something ON this mesh is
   * wrong, and wrong by an amount that is largest exactly where the height field
   * is most interesting. A mesh is a chord across the function, so wherever the
   * function is concave the rendered ground sits ABOVE it, and anything placed
   * at the function's own value is buried. Measured here: 6.7 mm at p90 and
   * 23.6 mm at p99 inside the near field where the short-wavelength churn term
   * is enabled, against 1.1 mm at p90 outside it where churn is gated off by
   * Nyquist. Gravel protruding a median of 8 mm therefore vanished in the near
   * field and read perfectly in the far field, which looked like a distance cull
   * and was really two descriptions of one surface disagreeing.
   *
   * This is the third instance of that shape tonight — entrance ruts authored
   * against `dirtY` and rendered from `groundHeight`, then this — so the fix is
   * to publish the rendered surface rather than to add a margin at each call
   * site. A margin would have to be the p99, and a 24 mm lift on a 20 mm stone
   * is a floating stone.
   */
  g.userData.surfaceAt = (x: number, z: number): number => {
    const cell = (arr: Float64Array, v: number) => {
      let lo = 0;
      let hi = arr.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= v) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const i = cell(xs, x);
    const j = cell(zs, z);
    const u = (x - xs[i]) / (xs[i + 1] - xs[i]);
    const v = (z - zs[j]) / (zs[j + 1] - zs[j]);
    const h = (ii: number, jj: number) => pos[(jj * nx + ii) * 3 + 1];
    const ha = h(i, j);
    const hb = h(i + 1, j);
    const hc = h(i, j + 1);
    // Triangles are (a, c, b) and (b, c, d), so the shared edge is u + v = 1.
    if (u + v <= 1) return ha + u * (hb - ha) + v * (hc - ha);
    const hd = h(i + 1, j + 1);
    return hd + (1 - u) * (hc - hd) + (1 - v) * (hb - hd);
  };
  g.userData.spacing = {
    fineX: xs[Math.floor(segX / 2)] - xs[Math.floor(segX / 2) - 1],
    fineZ: zs[Math.floor(segZ / 2)] - zs[Math.floor(segZ / 2) - 1],
    coarseX: xs[1] - xs[0],
    coarseZ: zs[1] - zs[0],
  };
  return g;
}

const fract = (v: number) => v - Math.floor(v);
const hash1 = (n: number) => fract(Math.sin(n * 12.9898) * 43758.5453);

/**
 * One-dimensional value noise with a real wavelength, in metres.
 *
 * `hash1` is a bare hash — `fract(sin(n * k) * K)` — with no interpolation, so
 * it decorrelates on *any* change of input. That means `hash1(t * 0.055)` is
 * not an 18 m wave and `hash1(t * 5.3)` is not a 0.19 m wave: they are the same
 * white noise with different seeds. A frequency multiplier inside a hash is not
 * a frequency. Getting a wavelength requires hashing the *integer* lattice and
 * interpolating, which is what this does.
 */
function vnoise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const w = f * f * (3 - 2 * f);
  const a = hash1(i + seed);
  const b = hash1(i + 1 + seed);
  return a + (b - a) * w;
}

/**
 * The normalised excursion of a ragged pavement edge at distance `t` metres
 * along it, in -1..1. Extracted from `ragEdge` so the published `pavementEdge`
 * service returns the line the geometry actually uses rather than a model of
 * it: one function, called by the vertex displacement and by every consumer, so
 * agreement is exact by construction instead of by maintenance.
 *
 * Three octaves at 18 m, 6.5 m and 2.2 m, and those numbers are now true. The
 * previous set was written as four octaves from 18 m down to 0.19 m and was
 * none of those things, because it fed a frequency multiplier into a bare hash
 * — see `vnoise1`. The consequences were both invisible and exactly what a
 * reviewer working from frames complained about:
 *
 * - The edge had no long-wavelength wander at all, so it read as a ruled line
 *   with a fuzzy margin from anything past about fifteen metres. The fix that
 *   was supposed to address that — "add an octave at 18 m and give it most of
 *   the weight" — did nothing structural, and looked as though it had worked
 *   because the amplitude claim was checkable and the wavelength claim was not.
 * - Raising the excursion from 190 mm to 400 mm turned it into a sawtooth. The
 *   edge was measured moving **649 mm between adjacent vertices** at the road
 *   mesh's 0.5 m pitch — more than the whole declared excursion, a 130% slope
 *   across a single quad — because white noise has no wavelength to be limited
 *   by, so every vertex was an independent draw from the full envelope.
 *
 * The longest octave carries most of the weight on purpose: a paving train
 * wanders over tens of metres, and a shoulder is overrun and repaired in runs
 * of that order. Nothing is placed below 2.2 m, comfortably above the 1.0 m
 * Nyquist limit of a 0.5 m vertex pitch, because a term the geometry cannot
 * sample does not become correct by being quieter. The total is renormalised,
 * so maximum excursion is exactly the caller's `amp` and a consumer reasoning
 * about where the pavement can reach stays correct as the octaves change.
 */
export function ragOffset(t: number, seed: number): number {
  const n =
    (vnoise1(t / 18.0, seed * 0.7) - 0.5) * 1.5 +
    (vnoise1(t / 6.5, seed * 1.7 + 11) - 0.5) * 0.7 +
    (vnoise1(t / 2.2, seed * 2.3 + 29) - 0.5) * 0.3;
  return n / 1.25;
}

/**
 * Perturb the outermost row of a `gridSurface` along one axis so the boundary
 * of a paved area is ragged rather than ruled. Real asphalt ravels: the edge
 * wanders by a couple of hundred millimetres and sags as the binder loses the
 * aggregate. A perfectly straight polygon boundary is the single loudest CG
 * tell on a large flat surface.
 *
 * @param axis   which coordinate the edge lies on
 * @param at     the coordinate value of the edge to move
 * @param amp    how far, in metres, the edge may wander
 * @param sag    how far the edge drops as it crumbles
 */
export function ragEdge(
  geo: THREE.BufferGeometry,
  axis: "x" | "z",
  at: number,
  amp: number,
  sag: number,
  seed = 0
): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const comp = axis === "x" ? 0 : 2;
  const along = axis === "x" ? 2 : 0;
  const sign = Math.sign(at) || 1;

  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(arr[i * 3 + comp] - at) > 1e-4) continue;
    const t = arr[i * 3 + along];
    // Four octaves. The longest one carries most of the weight and that is the
    // point: the previous set topped out at 0.37 per metre, i.e. a scallop
    // every 2.7 m, which is per-metre nibbling and nothing else. Nibbling is
    // invisible past about fifteen metres, so from any normal standing position
    // the edge went back to being a ruled line - which is what a reviewer
    // working from frames reported. A paving train wanders over tens of metres,
    // and the shoulder is overrun and repaired in runs of that order, so the
    // dominant term belongs at ~18 m. Total weight is renormalised, so the
    // maximum excursion is unchanged at `amp` and callers that reason about
    // where the pavement can reach (VegetationSystem does) stay correct.
    const bite = ragOffset(t, seed);
    arr[i * 3 + comp] = at + bite * amp * sign;
    arr[i * 3 + 1] -= (0.35 + Math.abs(bite)) * sag;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Give a geometry a flat vertex colour so it can be merged with AO-shaded parts. */
export function solidColors(geo: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const c = new Float32Array(n * 3).fill(v);
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * Sweep a 2D profile (lateral offset, height) along a polyline in the XZ plane.
 * Used for concrete curbs and the raised pump island, which are the same
 * extrusion with different paths.
 */
export function sweepProfile(
  path: THREE.Vector2[],
  profile: THREE.Vector2[],
  opts: {
    closed?: boolean;
    flip?: boolean;
    baseY?: number;
    heightAt?: (x: number, z: number) => number;
    uvMetres?: number;
    capEnds?: boolean;
    /**
     * Vertex-colour multiplier as a function of profile height. Cheap baked
     * contact occlusion: without a dark line where a curb meets the pavement
     * it reads as an object resting near the ground, not cast into it.
     */
    ao?: (profileHeight: number) => number;
    /** Nibbles the top arris in and out so the edge is chipped, not machined. */
    chip?: number;
    seed?: number;
  } = {}
): THREE.BufferGeometry {
  const {
    closed = false,
    flip = false,
    baseY = 0,
    heightAt,
    uvMetres = 4,
    capEnds = true,
    ao,
    chip = 0,
    seed = 0,
  } = opts;
  const n = path.length;
  const stations = closed ? n : n;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const topY = Math.max(...profile.map((p) => p.y));

  // Cumulative profile arc-length for the V coordinate.
  const vArc: number[] = [0];
  for (let p = 1; p < profile.length; p++) vArc.push(vArc[p - 1] + profile[p].distanceTo(profile[p - 1]));

  let along = 0;
  const dir = new THREE.Vector2();
  const prevDir = new THREE.Vector2();
  const nrm = new THREE.Vector2();

  for (let s = 0; s < stations; s++) {
    const cur = path[s];
    const next = path[(s + 1) % n];
    const prev = path[(s - 1 + n) % n];

    if (s < n - 1 || closed) dir.subVectors(next, cur).normalize();
    else dir.subVectors(cur, prev).normalize();
    if (s > 0 || closed) prevDir.subVectors(cur, prev).normalize();
    else prevDir.copy(dir);

    // Miter: average of the two segment normals, scaled so the offset is exact.
    const na = new THREE.Vector2(dir.y, -dir.x);
    const nb = new THREE.Vector2(prevDir.y, -prevDir.x);
    nrm.copy(na).add(nb);
    if (nrm.lengthSq() < 1e-8) nrm.copy(na);
    nrm.normalize();
    const miter = Math.max(0.4, nrm.dot(na));
    nrm.multiplyScalar((flip ? -1 : 1) / miter);

    if (s > 0) along += cur.distanceTo(prev);

    const groundY = heightAt ? heightAt(cur.x, cur.y) : baseY;
    // Chipping is a per-station wobble applied only to the profile points at
    // (or just below) the top arris, which is the only part that gets knocked.
    const chipN =
      chip > 0
        ? (hash1(along * 2.9 + seed) - 0.5) * 1.0 + (hash1(along * 11.3 + seed * 3.1) - 0.5) * 0.6
        : 0;

    for (let p = 0; p < profile.length; p++) {
      const near = chip > 0 ? Math.max(0, 1 - Math.abs(profile[p].y - topY) / 0.06) : 0;
      const lat = profile[p].x + chipN * 0.016 * chip * near;
      pos.push(cur.x + nrm.x * lat, groundY + profile[p].y - Math.abs(chipN) * 0.009 * chip * near, cur.y + nrm.y * lat);
      uv.push(along / uvMetres, vArc[p] / uvMetres);
      if (ao) {
        const v = ao(profile[p].y);
        col.push(v, v, v);
      }
    }
  }

  const pc = profile.length;
  const segCount = closed ? stations : stations - 1;

  /**
   * WINDING HAZARD, diagnosed and deliberately NOT fixed here.
   *
   * `flip` negates the lateral direction, which **mirrors** the surface, and a
   * mirror reverses handedness — so every sweep passing `flip: true` comes out
   * with its winding inverted while every unflipped one is correct. Measured on
   * the shipped `pump-islands`: 0 of 64 flank faces outward. Reversing the
   * profile array at the call site restores it to 64 of 64.
   *
   * Reversing the index order *here* would be the better fix and it is a
   * three-line change, but it is not being made: `canopyParts.ts` has already
   * compensated locally, reversing two profiles with a comment explaining why,
   * so changing the shared function now would double-invert Canopy's fascia and
   * coping and turn two correct surfaces inside out. Both callers should be
   * migrated in one commit by whoever owns both, and until then the convention
   * is **`flip: true` requires a reversed profile.**
   *
   * Why this hid for eight rounds of captures: back-face culling makes a
   * reversed surface **invisible rather than wrong**. The defect renders as
   * seeing through to whatever is behind, which on a 162 mm kerb against dark
   * asphalt looks like a kerb.
   */
  for (let s = 0; s < segCount; s++) {
    const a0 = s * pc;
    const b0 = ((s + 1) % stations) * pc;
    for (let p = 0; p < pc - 1; p++) {
      idx.push(a0 + p, b0 + p, a0 + p + 1, a0 + p + 1, b0 + p, b0 + p + 1);
    }
  }

  if (capEnds && !closed) {
    // Simple triangle fan caps so the curb ends read as solid concrete.
    const first = 0;
    const last = (stations - 1) * pc;
    for (let p = 1; p < pc - 1; p++) {
      idx.push(first, first + p, first + p + 1);
      idx.push(last, last + p + 1, last + p);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (col.length) g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat quad in world space at a fixed height, with world-metre UVs. */
export function quadXZ(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  heightAt: (x: number, z: number) => number,
  uvMetres: number,
  segs = 1
): THREE.BufferGeometry {
  return gridSurface(minX, maxX, minZ, maxZ, segs, segs, heightAt, uvMetres);
}

/**
 * A painted stripe laid on the pavement. UV.x runs along the stripe (scaled by
 * length so the wear pattern never stretches) and UV.y runs across it.
 */
export function stripeGeometry(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  width: number,
  heightAt: (x: number, z: number) => number,
  lift: number,
  uvPerMetre = 0.42
): THREE.BufferGeometry {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz * width * 0.5;
  const pz = ux * width * 0.5;

  const segs = Math.max(2, Math.ceil(len / 0.5));
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const cx = x1 + dx * t;
    const cz = z1 + dz * t;
    for (let side = 0; side < 2; side++) {
      const sx = cx + (side === 0 ? -px : px);
      const sz = cz + (side === 0 ? -pz : pz);
      pos.push(sx, heightAt(sx, sz) + lift, sz);
      uv.push(t * len * uvPerMetre, side);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
