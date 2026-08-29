/**
 * Tiny deterministic noise kit. Everything here is seedable and periodic so the
 * generated tiles wrap seamlessly.
 */

export type Rng = () => number;

/**
 * Bare xorshift32, seeded directly with the caller's integer.
 *
 * SAFE for a single fixed seed, which is what every texture builder here does:
 * one `makeRng(3301)` feeding hundreds of draws into a noise lattice. The bias
 * described below lands on one lattice cell out of thousands and is not
 * measurable in the output.
 *
 * WRONG for a *set* of things seeded from adjacent integers. The first draw is
 * very nearly a linear function of the seed — for seeds 1..10 it is exactly
 * `seed * 0.000063` — so `for (i) makeRng(base + i)` followed by a branch on an
 * early draw makes the *same* decision for every member of the set. Measured
 * correlation of draw 1 against seed: 1.0000 over seeds 1..10, 0.9988 over
 * 1..200, 0.7746 over 4000..4599. Draws 2 and 3 are also correlated when the
 * seeds are below about 10^4. The cause is that `s ^= s >> 17` is a no-op while
 * `s < 2^17`, which kills the middle of the three shift stages for small seeds.
 *
 * Use `seededRng` for that case. This is not a theoretical risk: it shipped
 * ten pines of one species and six fuel hoses sharing a kink phase. See
 * NOTES.md case 16, and `tools/probe-rngsets.mjs` which asserts against it.
 *
 * Known deviation, deliberately not fixed: Marsaglia's xorshift32 specifies a
 * logical shift here, `s >>> 17`. This uses an arithmetic `s >> 17`, so once
 * `s >= 2^31` the sign bit is extended back into bits 31..15 and the recurrence
 * is not the standard one — its period is not the verified 2^32-1. Correcting
 * the shift would reroll every texture in the project, which is exactly the
 * churn case 16 decided not to take, and there is no observed defect from it:
 * adjacent-seed noise fields measure uncorrelated (worst 0.17 against a
 * distant-seed control of 0.06) and no short cycle has shown up in streams of
 * 4096 draws. If evidence of visible structure or a short cycle ever appears,
 * that changes the trade and this should be corrected as part of a reroll.
 */
export function makeRng(seed: number): Rng {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Finalising mix from murmur3, which decorrelates the low bits from the high. */
function hashSeed(seed: number): number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  return s || 1;
}

/**
 * The RNG to use when seeding a *set* of things — trees, pumps, hoses, posts,
 * tiles, stalls — from consecutive or closely-spaced integers.
 *
 * Hashes the seed so that adjacent inputs land far apart in state space, which
 * is what fixes the correlation, then discards a short prefix as belt and
 * braces so the guarantee does not depend on what `makeRng` does on its first
 * iterations. Measured over 200 consecutive seeds, draw 1 correlates with the
 * seed at -0.007 against `makeRng`'s 0.9988.
 *
 * Prefer this by default. `makeRng` is only the better choice when you have a
 * single fixed seed and want to keep an existing generated result identical.
 */
export function seededRng(seed: number): Rng {
  const r = makeRng(hashSeed(seed));
  for (let i = 0; i < 8; i++) r();
  return r;
}

// Quintic fade. Cubic smoothstep has a discontinuous second derivative at the
// lattice lines, which shows up as a faint but strictly axis-aligned crease
// grid once the noise drives a normal map.
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** The eight symmetries of a square. All of them map the tile onto itself, so
 *  applying a different one per octave breaks up directional reinforcement
 *  without breaking periodicity. */
function dihedral(x: number, y: number, size: number, k: number): [number, number] {
  let a = x;
  let b = y;
  if (k & 1) [a, b] = [b, a];
  // Reflect modulo `size`, not about `size - 1`: on a torus the isometry is
  // x -> (size - x) mod size, and getting that off by one leaves a seam.
  if (k & 2) a = (size - a) % size;
  if (k & 4) b = (size - b) % size;
  return [a, b];
}

/** Periodic value noise sampled onto a `size x size` grid at `freq` lattice cells. */
export function valueNoise(size: number, freq: number, rng: Rng): Float32Array {
  const f = Math.max(1, Math.floor(freq));
  const lat = new Float32Array(f * f);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();

  const out = new Float32Array(size * size);
  const scale = f / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = fade(fy - y0);
    const y0i = ((y0 % f) + f) % f;
    const y1i = (y0i + 1) % f;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = fade(fx - x0);
      const x0i = ((x0 % f) + f) % f;
      const x1i = (x0i + 1) % f;
      const a = lat[y0i * f + x0i];
      const b = lat[y0i * f + x1i];
      const c = lat[y1i * f + x0i];
      const d = lat[y1i * f + x1i];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[y * size + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/**
 * Periodic gradient (Perlin) noise, normalised to 0..1.
 *
 * Value noise interpolates scalars stored at lattice corners, so every extremum
 * is pinned to a lattice point and the result carries a visible axis-aligned
 * grid. Gradient noise instead forces the field to zero at each corner and
 * derives the value from a random direction there, which puts the extrema
 * *between* lattice points and largely removes the grid signature. This is the
 * difference between the shoulder reading as a roadside verge and reading as
 * corduroy.
 */
export function gradientNoise(size: number, freq: number, rng: Rng): Float32Array {
  const f = Math.max(1, Math.floor(freq));
  const gx = new Float32Array(f * f);
  const gy = new Float32Array(f * f);
  for (let i = 0; i < f * f; i++) {
    const a = rng() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }

  const out = new Float32Array(size * size);
  const scale = f / size;
  // Perlin in 2D spans roughly +/- sqrt(2)/2; normalise with that so callers
  // keep getting a 0..1 field.
  const norm = Math.SQRT1_2;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const dy0 = fy - y0;
    const dy1 = dy0 - 1;
    const ty = fade(dy0);
    const y0i = ((y0 % f) + f) % f;
    const y1i = (y0i + 1) % f;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const dx0 = fx - x0;
      const dx1 = dx0 - 1;
      const tx = fade(dx0);
      const x0i = ((x0 % f) + f) % f;
      const x1i = (x0i + 1) % f;

      const i00 = y0i * f + x0i;
      const i10 = y0i * f + x1i;
      const i01 = y1i * f + x0i;
      const i11 = y1i * f + x1i;
      const n00 = gx[i00] * dx0 + gy[i00] * dy0;
      const n10 = gx[i10] * dx1 + gy[i10] * dy0;
      const n01 = gx[i01] * dx0 + gy[i01] * dy1;
      const n11 = gx[i11] * dx1 + gy[i11] * dy1;

      const top = n00 + (n10 - n00) * tx;
      const bot = n01 + (n11 - n01) * tx;
      out[y * size + x] = clamp01((top + (bot - top) * ty) * norm * 0.5 + 0.5);
    }
  }
  return out;
}

export interface FbmOptions {
  octaves?: number;
  gain?: number;
  lacunarity?: number;
  ridged?: boolean;
}

/**
 * Fractal sum of periodic gradient noise, normalised to 0..1.
 *
 * Two things here exist purely to kill directional banding, and both matter:
 *
 * - The frequency ladder is deliberately non-harmonic. With `lacunarity = 2`
 *   every octave's lattice lines land on exactly the same rows and columns as
 *   the octave below, so the (already axis-aligned) grid artifacts reinforce
 *   instead of cancelling, and the sum reads as regular plaid or corduroy. The
 *   default is nudged off 2 so successive integer frequencies share as few
 *   factors as possible.
 * - Each octave is sampled through a different symmetry of the square. All
 *   eight map the tile onto itself, so periodicity survives, but the residual
 *   grid of each octave points a different way and they no longer stack.
 */
export function fbm(size: number, baseFreq: number, rng: Rng, opts: FbmOptions = {}): Float32Array {
  const { octaves = 5, gain = 0.5, lacunarity = 2.17, ridged = false } = opts;
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let freq = baseFreq;
  let lastF = -1;
  for (let o = 0; o < octaves; o++) {
    // Integer frequencies keep each octave periodic; make sure rounding never
    // hands two octaves the same lattice.
    let f = Math.max(1, Math.round(freq));
    if (f <= lastF) f = lastF + 1;
    lastF = f;

    const layer = gradientNoise(size, f, rng);
    const k = (o * 3 + 1) & 7;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [sx, sy] = dihedral(x, y, size, k);
        const v0 = layer[sy * size + sx];
        const v = ridged ? 1 - Math.abs(v0 * 2 - 1) : v0;
        out[y * size + x] += v * amp;
      }
    }
    total += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Periodic Worley / cellular noise. Returns distance-to-nearest-feature in 0..1,
 * which is what sells the crushed-stone look of asphalt aggregate.
 */
export function worley(size: number, cells: number, rng: Rng): Float32Array {
  const c = Math.max(1, Math.floor(cells));
  const px = new Float32Array(c * c);
  const py = new Float32Array(c * c);
  for (let i = 0; i < c * c; i++) {
    px[i] = rng();
    py[i] = rng();
  }
  const out = new Float32Array(size * size);
  const cellPx = size / c;
  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cellPx);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cellPx);
      let best = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % c + c) % c;
          const gy = ((cy + oy) % c + c) % c;
          const i = gy * c + gx;
          const fx = (cx + ox + px[i]) * cellPx;
          const fy = (cy + oy + py[i]) * cellPx;
          const dx = fx - x;
          const dy = fy - y;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      out[y * size + x] = Math.min(1, Math.sqrt(best) / cellPx);
    }
  }
  return out;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Multiply-blend two buffers in place. */
export function mulBuf(dst: Float32Array, src: Float32Array, amount = 1): Float32Array {
  for (let i = 0; i < dst.length; i++) dst[i] *= 1 - amount + src[i] * amount;
  return dst;
}

export function remap(buf: Float32Array, lo: number, hi: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = lo + buf[i] * (hi - lo);
  return buf;
}

/** Sample a square Float32 buffer with wrapping + bilinear filtering. */
export function sampleWrapped(buf: Float32Array, size: number, u: number, v: number): number {
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xi = (x: number) => ((x % size) + size) % size;
  const a = buf[xi(y0) * size + xi(x0)];
  const b = buf[xi(y0) * size + xi(x0 + 1)];
  const c = buf[xi(y0 + 1) * size + xi(x0)];
  const d = buf[xi(y0 + 1) * size + xi(x0 + 1)];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}
