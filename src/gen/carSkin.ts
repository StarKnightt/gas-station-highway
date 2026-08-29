/**
 * System 3: procedural surface maps specific to the parked car.
 *
 * Split out of `hardsurface.ts` so the pump kit and the car kit can be tuned
 * without disturbing each other. Same two rules apply: `DataTexture` only, no
 * canvas round-trips for mask data, and no undeclared uniforms.
 */

import * as THREE from "three";
import { clamp01, fbm, makeRng, smoothstep, valueNoise, worley } from "./noise.ts";

let carAniso = 8;
export function setCarAnisotropy(v: number) {
  carAniso = v;
}

function tex(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = carAniso;
  t.needsUpdate = true;
  return t;
}

function gray(buf: Float32Array, size: number): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return tex(d, size, false);
}

function normalOf(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy = at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return tex(out, size, false);
}

export interface CarMaps {
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  /** Metres covered by one tile, so callers can set `repeat` correctly. */
  tileMetres: number;
}

/**
 * Clearcoat orange peel. Every real painted panel has it; without it a car body
 * reflects like polished glass and reads as CGI at any distance. The amplitude
 * is deliberately tiny - it only ever shows up in the shape of a reflection,
 * never as visible bumps.
 */
export function makeCarPaint(size = 512, tileMetres = 0.42, seed = 3301): CarMaps {
  const rng = makeRng(seed);
  const peel = fbm(size, 34, rng, { octaves: 4, gain: 0.55 });
  const fine = fbm(size, 96, rng, { octaves: 3 });
  const swirl = fbm(size, 150, rng, { octaves: 2 });

  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    h[i] = peel[i] * 0.7 + fine[i] * 0.3;
    // Fine polishing swirls: a hair of roughness variation, nothing more.
    rough[i] = 0.14 + swirl[i] * 0.05 + fine[i] * 0.03;
  }
  return { normalMap: normalOf(h, size, 0.55), roughnessMap: gray(rough, size), tileMetres };
}

/**
 * Water spots and drip trails left by overnight rain drying on a dusty car.
 * Returned as a standalone alpha-free field the car shader mixes in on top of
 * the shared grime field, because the pattern is specific: rings and vertical
 * runs, concentrated on up-facing panels.
 *
 *   R  dried spot rings
 *   G  drip trails (squashed vertically by the shader)
 *   B  dust
 *   A  large blotching
 */
export function makeRainField(size = 512, seed = 3307): THREE.DataTexture {
  const rng = makeRng(seed);
  const cells = worley(size, 30, rng);
  const pick = valueNoise(size, 30, rng);
  const smallCells = worley(size, 74, rng);
  const smallPick = valueNoise(size, 74, rng);
  const runs = fbm(size, 19, rng, { octaves: 5, gain: 0.62 });
  const runFine = fbm(size, 88, rng, { octaves: 3 });
  const dust = fbm(size, 44, rng, { octaves: 4 });
  const blotch = fbm(size, 5, rng, { octaves: 4 });

  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // A dried droplet leaves a ring, not a disc: the mineral edge is what you
    // actually see. Bright at the rim, near clean in the middle.
    const ringBig = (1 - smoothstep(0.0, 0.05, Math.abs(cells[i] - 0.055))) * smoothstep(0.5, 0.72, pick[i]);
    const ringSml = (1 - smoothstep(0.0, 0.03, Math.abs(smallCells[i] - 0.03))) * smoothstep(0.42, 0.70, smallPick[i]);
    const spot = clamp01(ringBig * 0.9 + ringSml * 0.7);
    const trail = clamp01(smoothstep(0.44, 0.82, runs[i]) * (0.45 + runFine[i] * 0.95));
    d[i * 4] = Math.round(spot * 255);
    d[i * 4 + 1] = Math.round(trail * 255);
    d[i * 4 + 2] = Math.round(clamp01(dust[i] * 0.85 + 0.1) * 255);
    d[i * 4 + 3] = Math.round(clamp01(blotch[i]) * 255);
  }
  return tex(d, size, false);
}

/**
 * Alloy wheel face: cast texture plus the brake dust that collects on any wheel
 * that has done a few thousand miles. Heavier toward the centre, because that
 * is where it lands.
 */
export function makeAlloySkin(size = 512, seed = 3313): CarMaps & { map: THREE.DataTexture } {
  const rng = makeRng(seed);
  const cast = fbm(size, 60, rng, { octaves: 4 });
  const fine = fbm(size, 170, rng, { octaves: 2 });
  const dust = fbm(size, 14, rng, { octaves: 5 });
  const grit = worley(size, 90, rng);

  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const col = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      h[i] = cast[i] * 0.55 + fine[i] * 0.45;

      // Radial falloff in UV space: the wheel maps roughly centre-out.
      const u = x / size - 0.5;
      const v = y / size - 0.5;
      const r = Math.min(1, Math.hypot(u, v) * 2);
      const inner = 1 - smoothstep(0.15, 0.95, r);
      const dirt = clamp01(dust[i] * 0.8 + grit[i] * 0.3) * (0.35 + inner * 0.75);

      rough[i] = 0.33 + cast[i] * 0.12 + dirt * 0.44;

      // Machined silver, dulled toward warm brown-grey where the dust sits.
      // Kept well below white: a bright alloy blows straight out under a low
      // sun and the wheel turns into a featureless disc.
      // Lifted from 96: cast aluminium reads far brighter than 0.45 albedo,
      // and a dark metal leans harder on the environment for its colour.
      const base = 118 + cast[i] * 26 + fine[i] * 14;
      // The dirt tint used to spread R/G/B 58/47/39, a 19-point warm bias on a
      // 0.92-metal whose albedo also tints its sky reflection. Combined with
      // two warm grime layers and a low warm sun it made the rim read brass.
      // Cast aluminium that has been rained on is near-neutral.
      const rr = base * (1 - dirt * 0.48) + dirt * 52;
      const gg = base * (1 - dirt * 0.50) + dirt * 48;
      const bb = base * (1 - dirt * 0.53) + dirt * 44;
      col[i * 4] = Math.round(Math.min(255, rr));
      col[i * 4 + 1] = Math.round(Math.min(255, gg));
      col[i * 4 + 2] = Math.round(Math.min(255, bb));
      col[i * 4 + 3] = 255;
    }
  }
  return {
    map: tex(col, size, true),
    normalMap: normalOf(h, size, 0.9),
    roughnessMap: gray(rough, size),
    tileMetres: 0.5,
  };
}

/**
 * Cloth seat trim. Coarse weave so the interior does not read as flat plastic
 * through the glass.
 */
export function makeSeatCloth(size = 256, tileMetres = 0.20, seed = 3319): CarMaps {
  const rng = makeRng(seed);
  const noise = fbm(size, 90, rng, { octaves: 3 });
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const weave = Math.sin((x / size) * Math.PI * 2 * 26) * Math.sin((y / size) * Math.PI * 2 * 26);
      h[i] = 0.5 + weave * 0.28 + noise[i] * 0.3;
      rough[i] = 0.86 + noise[i] * 0.1;
    }
  }
  return { normalMap: normalOf(h, size, 1.4), roughnessMap: gray(rough, size), tileMetres };
}

/**
 * Licence plate: an embossed blank. Deliberately no glyphs - a plate that reads
 * as a plate at three metres and as nothing in particular up close, which is
 * what the brief asks for.
 */
export function makePlate(w = 512, h = 256, seed = 3323): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const rng = makeRng(seed);
  const grime = fbm(w, 24, rng, { octaves: 4 });

  const col = new Uint8Array(w * h * 4);
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = x / w;
      const v = y / h;

      // Rolled border bead.
      const edge = Math.min(Math.min(u, 1 - u) * (w / h), Math.min(v, 1 - v)) * 3.4;
      const bead = (1 - smoothstep(0.10, 0.24, edge)) * smoothstep(0.03, 0.10, edge);

      // Embossed character band: blocks of relief with no legible shape.
      let chars = 0;
      if (v > 0.34 && v < 0.74) {
        const slot = (u - 0.10) / 0.135;
        if (slot > 0 && slot < 5.6) {
          const f = slot % 1;
          if (f > 0.13 && f < 0.82) chars = 1;
        }
      }

      height[i] = 0.5 + bead * 0.4 + chars * 0.28;

      // Faded white with a colour band across the top, as US plates tend to
      // have, and road film in the lower corners.
      const band = 1 - smoothstep(0.0, 0.20, v);
      let r = 214 - chars * 92;
      let g = 214 - chars * 86;
      let b = 208 - chars * 42;
      r = r * (1 - band * 0.45) + band * 44;
      g = g * (1 - band * 0.35) + band * 68;
      b = b * (1 - band * 0.12) + band * 118;
      const dirty = clamp01(grime[i % (w * w)] * 0.6) * smoothstep(0.55, 1.0, v);
      const k = (y * w + x) * 4;
      col[k] = Math.round(r * (1 - dirty * 0.35));
      col[k + 1] = Math.round(g * (1 - dirty * 0.35));
      col[k + 2] = Math.round(b * (1 - dirty * 0.32));
      col[k + 3] = 255;
    }
  }

  const map = new THREE.DataTexture(col, w, h, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = carAniso;
  map.needsUpdate = true;

  const nOut = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) =>
    height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = at(x - 1, y) - at(x + 1, y);
      const dy = at(x, y - 1) - at(x, y + 1);
      let nx = dx * 3.0;
      let ny = dy * 3.0;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * w + x) * 4;
      nOut[i] = Math.round((nx * 0.5 + 0.5) * 255);
      nOut[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nOut[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nOut[i + 3] = 255;
    }
  }
  const normalMap = new THREE.DataTexture(nOut, w, h, THREE.RGBAFormat);
  normalMap.magFilter = THREE.LinearFilter;
  normalMap.minFilter = THREE.LinearMipmapLinearFilter;
  normalMap.generateMipmaps = true;
  normalMap.anisotropy = carAniso;
  normalMap.needsUpdate = true;

  return { map, normalMap };
}

/**
 * Headlamp reflector: concentric facets. Sampled by a chrome material inside
 * the lens, it gives the lamp the broken-up sparkle that a plain mirrored bowl
 * never produces.
 */
export function makeReflector(size = 256, seed = 3329): THREE.DataTexture {
  const rng = makeRng(seed);
  const jitter = valueNoise(size, 40, rng);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size - 0.5;
      const v = y / size - 0.5;
      const r = Math.hypot(u, v);
      const rings = Math.abs(((r * 26 + jitter[i] * 0.4) % 1) - 0.5) * 2;
      h[i] = rings;
    }
  }
  return normalOf(h, size, 1.8);
}
