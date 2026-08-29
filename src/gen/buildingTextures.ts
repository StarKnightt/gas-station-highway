import * as THREE from "three";
import { clamp01, fbm, lerp, makeRng, smoothstep, valueNoise, worley } from "./noise";
import { getMaxAnisotropy, heightToNormal } from "./textures";

/**
 * Procedural surfaces for the store building (System 2).
 *
 * Kept separate from `textures.ts` (owned by System 1) and prefixed `building`
 * so nothing collides. The one structural difference from the ground surfaces
 * is that these maps are allowed to cover a *rectangular* patch of world
 * rather than a square one: CMU coursing is 16 in x 8 in, and forcing that
 * into a square tile either stretches the block or wastes half the texture.
 */
export interface BuildingMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  /** World metres covered by one tile horizontally / vertically. */
  tileX: number;
  tileY: number;
}

/* ------------------------------------------------------------------ */
/* local low level helpers                                              */
/* ------------------------------------------------------------------ */

function buildingRgba(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

function buildingGray(buf: Float32Array, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return buildingRgba(data, size, false);
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}
const rgb = (hex: number): Rgb => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: lerp(a.r, b.r, t),
  g: lerp(a.g, b.g, t),
  b: lerp(a.b, b.b, t),
});
const shadeRgb = (c: Rgb, k: number): Rgb => ({ r: c.r * k, g: c.g * k, b: c.b * k });

function put(data: Uint8Array, i: number, c: Rgb, a = 255) {
  data[i] = Math.round(clamp01(c.r) * 255);
  data[i + 1] = Math.round(clamp01(c.g) * 255);
  data[i + 2] = Math.round(clamp01(c.b) * 255);
  data[i + 3] = a;
}

/** Deterministic 0..1 hash of two integers; used for per-block variation. */
const hash2 = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/* ------------------------------------------------------------------ */
/* painted CMU block                                                    */
/* ------------------------------------------------------------------ */

/** Nominal US concrete masonry unit: 16 in x 8 in including a 3/8 in joint. */
export const CMU = {
  unitX: 0.4064,
  unitY: 0.2032,
  joint: 0.0095,
};
/** One texture tile spans this many blocks; even row count keeps running bond periodic. */
const CMU_COLS = 4;
const CMU_ROWS = 8;
export const CMU_TILE_X = CMU_COLS * CMU.unitX;
export const CMU_TILE_Y = CMU_ROWS * CMU.unitY;

/**
 * The *surface* of painted CMU: paint film, orange peel from the roller, the
 * open pores of the block underneath, chips through to bare aggregate, and
 * metre-scale soiling. No coursing.
 *
 * The joints used to be baked in here on a real 406 x 203 mm running bond, and
 * the scale was measurably right - bed joints 23 px apart where 1 m projected
 * to 110 px, i.e. 0.203 m per course. It still read as roughly double that,
 * because a 9.5 mm joint is 6 texels in this tile and about one screen pixel in
 * frame, so the mip chain averaged it out: bed joints degraded to a pale
 * lattice, head joints vanished, and the eye inferred a taller unit from the
 * surviving banding. Coursing now comes from `applyBuildingCoursing`, which
 * evaluates it per pixel and filters it against the actual pixel footprint.
 *
 * Generalise that before authoring anything else fine: detail at or below the
 * sampling rate does not get subtler, it gets *wrong*. Baking it is only safe
 * when the feature stays several pixels wide everywhere it is seen.
 */
export function makeBuildingCmu(size = 1024, seed = 2101): BuildingMaps {
  const rng = makeRng(seed);

  const grain = fbm(size, 190, rng, { octaves: 4 });
  const orangePeel = fbm(size, 70, rng, { octaves: 3 });
  const meso = fbm(size, 5, rng, { octaves: 4 });
  const pores = worley(size, 150, rng);
  const chipField = fbm(size, 26, rng, { octaves: 3 });
  const lapField = fbm(size, 11, rng, { octaves: 3 });

  const paint = rgb(0xc7bda6);
  const paintDrift = rgb(0xbcb29a);
  const bareBlock = rgb(0x8e8a80);
  const soil = rgb(0x6a6154);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;

      // Roller lap marks: a sprayed-and-back-rolled wall dries in overlapping
      // passes, and the seams between them never quite match in sheen.
      const lap = lapField[i];
      let c = mix(paint, paintDrift, smoothstep(0.4, 0.6, lap));

      // Roller texture and the coarse aggregate of the block reading through.
      const peel = orangePeel[i];
      const g = grain[i];
      c = shadeRgb(c, 0.93 + peel * 0.1 + g * 0.05);
      c = mix(c, soil, clamp01(meso[i] - 0.62) * 0.45);

      // Open pores in the block face: paint bridges the small ones and sinks
      // into the big ones, so they read as dark specks not as bumps.
      const pore = 1 - smoothstep(0.03, 0.13, pores[i]);
      c = shadeRgb(c, 1 - pore * 0.4);

      // Chipped paint at random spots, exposing grey block underneath.
      const chip = smoothstep(0.78, 0.87, chipField[i] * 0.7 + g * 0.3);
      c = mix(c, bareBlock, chip * 0.6);

      put(albedo, i * 4, c);

      rough[i] = clamp01(0.76 + peel * 0.08 + pore * 0.12 + chip * 0.16 + (lap - 0.5) * 0.1);
      height[i] = clamp01(0.72 + peel * 0.16 + g * 0.1 - pore * 0.5 - chip * 0.12);
    }
  }

  return {
    map: buildingRgba(albedo, size, true),
    normalMap: buildingRgba(heightToNormal(height, size, 2.2), size, false),
    roughnessMap: buildingGray(rough, size),
    tileX: CMU_TILE_X,
    tileY: CMU_TILE_Y,
  };
}

/* ------------------------------------------------------------------ */
/* interior floor: vinyl composition tile                               */
/* ------------------------------------------------------------------ */

/** 12 in VCT, four tiles to a texture tile. */
export const VCT_TILE = 0.3048;
const VCT_N = 4;

/**
 * Worn VCT. The chips are the signature: a speckled aggregate suspended in a
 * lighter binder, cut by hairline seams every 12 inches. Buffed floors are
 * only glossy in the middle of a tile - the seams stay dull because the buffer
 * never reaches into them.
 */
export function makeBuildingVct(size = 1024, seed = 3307): BuildingMaps {
  const rng = makeRng(seed);
  const chips = worley(size, 300, rng);
  const chipPick = valueNoise(size, 300, rng);
  const binder = fbm(size, 120, rng, { octaves: 3 });
  const wax = fbm(size, 9, rng, { octaves: 4 });
  const scratches = fbm(size, 420, rng, { octaves: 2, ridged: true });

  const base = rgb(0xb8b3a6);
  const chipDark = rgb(0x6f6a60);
  const chipWarm = rgb(0x9c8d72);
  const chipPale = rgb(0xd8d3c6);
  const seam = rgb(0x6a655c);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const tilePx = size / VCT_N;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const tx = Math.floor(px / tilePx);
      const ty = Math.floor(py / tilePx);
      const fx = px - tx * tilePx;
      const fy = py - ty * tilePx;
      const edge = Math.min(fx, tilePx - fx, fy, tilePx - fy);
      const seamT = 1 - smoothstep(0.6, 2.2, edge);

      const uid = hash2(tx, ty);
      let c = shadeRgb(base, 0.95 + uid * 0.1);
      c = shadeRgb(c, 0.92 + binder[i] * 0.18);

      // Chips: three families so the speckle has a size range.
      const chip = 1 - smoothstep(0.1, 0.42, chips[i]);
      const pick = chipPick[i];
      const chipCol = pick < 0.4 ? chipDark : pick < 0.75 ? chipWarm : chipPale;
      c = mix(c, chipCol, chip * 0.8);

      // Buffer swirl: fine circular scratching that only shows in the sheen.
      const scr = scratches[i];
      c = shadeRgb(c, 0.97 + scr * 0.05);

      c = mix(c, seam, seamT * 0.75);
      put(albedo, i * 4, c);

      // Gloss lives in the wax, is broken by scratches, and dies in the seams.
      const gloss = 0.28 + wax[i] * 0.2 + scr * 0.18 + seamT * 0.5;
      rough[i] = clamp01(gloss);
      height[i] = clamp01(0.7 + chip * 0.12 + binder[i] * 0.08 - seamT * 0.6);
    }
  }

  return {
    map: buildingRgba(albedo, size, true),
    normalMap: buildingRgba(heightToNormal(height, size, 0.9), size, false),
    roughnessMap: buildingGray(rough, size),
    tileX: VCT_TILE * VCT_N,
    tileY: VCT_TILE * VCT_N,
  };
}

/* ------------------------------------------------------------------ */
/* suspended ceiling tile                                               */
/* ------------------------------------------------------------------ */

/** Fissured mineral-fibre lay-in tile. One texture tile covers 0.6096 m. */
export function makeBuildingCeilingTile(size = 512, seed = 5501): BuildingMaps {
  const rng = makeRng(seed);
  const fissure = fbm(size, 22, rng, { octaves: 5, ridged: true });
  const fine = fbm(size, 130, rng, { octaves: 3 });
  const pinholes = worley(size, 220, rng);
  const stain = fbm(size, 3, rng, { octaves: 4 });

  const white = rgb(0xe2e0d9);
  const shadow = rgb(0xa8a69d);
  const tea = rgb(0xb09a76);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  for (let i = 0; i < size * size; i++) {
    const f = smoothstep(0.52, 0.86, fissure[i]);
    const hole = 1 - smoothstep(0.05, 0.2, pinholes[i]);
    let c = shadeRgb(white, 0.94 + fine[i] * 0.1);
    c = mix(c, shadow, f * 0.45 + hole * 0.35);
    // Old water staining: brown-edged blooms, the universal cheap-ceiling tell.
    const wet = smoothstep(0.72, 0.9, stain[i]);
    c = mix(c, tea, wet * 0.3);
    put(albedo, i * 4, c);

    rough[i] = clamp01(0.93 + fine[i] * 0.06 - wet * 0.05);
    height[i] = clamp01(0.7 - f * 0.5 - hole * 0.45 + fine[i] * 0.12);
  }

  return {
    map: buildingRgba(albedo, size, true),
    normalMap: buildingRgba(heightToNormal(height, size, 1.5), size, false),
    roughnessMap: buildingGray(rough, size),
    tileX: 0.6096,
    tileY: 0.6096,
  };
}

/* ------------------------------------------------------------------ */
/* painted / galvanised metal                                           */
/* ------------------------------------------------------------------ */

/**
 * Generic weathered painted sheet metal, used for coping, the HVAC casing, the
 * downspout and the cooler cabinet. `tint` shifts the base colour; the
 * chalking, dents and rust bloom are shared.
 */
export function makeBuildingMetal(
  size = 512,
  tileMetres = 1.2,
  seed = 7703,
  tint = 0xb9bbb6,
  rustAmount = 0.35
): BuildingMaps {
  const rng = makeRng(seed);
  const brush = fbm(size, 300, rng, { octaves: 2 });
  const dents = fbm(size, 11, rng, { octaves: 4 });
  const rustField = fbm(size, 7, rng, { octaves: 4 });
  const rustFine = fbm(size, 90, rng, { octaves: 3 });
  const grime = fbm(size, 4, rng, { octaves: 3 });

  const base = rgb(tint);
  const chalk = shadeRgb(base, 1.14);
  const rust = rgb(0x7b4526);
  const rustPale = rgb(0xa9764a);
  const dirt = rgb(0x4f4a41);

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  for (let i = 0; i < size * size; i++) {
    let c = mix(base, chalk, clamp01(grime[i] * 1.3 - 0.2) * 0.5);
    c = shadeRgb(c, 0.94 + brush[i] * 0.12);
    c = mix(c, dirt, clamp01(0.42 - grime[i]) * 0.7);

    const r = smoothstep(0.6, 0.84, rustField[i] * 0.72 + rustFine[i] * 0.28) * rustAmount;
    c = mix(c, mix(rust, rustPale, rustFine[i]), r);
    put(albedo, i * 4, c);

    rough[i] = clamp01(0.42 + grime[i] * 0.18 + r * 0.45 + brush[i] * 0.08);
    height[i] = clamp01(0.6 + dents[i] * 0.3 + r * 0.22 - brush[i] * 0.05);
  }

  return {
    map: buildingRgba(albedo, size, true),
    normalMap: buildingRgba(heightToNormal(height, size, 0.6), size, false),
    roughnessMap: buildingGray(rough, size),
    tileX: tileMetres,
    tileY: tileMetres,
  };
}

/* ------------------------------------------------------------------ */
/* glass grime                                                          */
/* ------------------------------------------------------------------ */

export interface GlassMaps {
  /** Modulates roughness: clean glass is near zero, filmed glass is not. */
  roughnessMap: THREE.DataTexture;
  /** Subtle relief so water spotting catches the sun. */
  normalMap: THREE.DataTexture;
  /** Dirt colour laid over the glass, alpha = coverage. */
  grimeMap: THREE.DataTexture;
  tileX: number;
  tileY: number;
}

/**
 * Storefront glass is never clean at 6 am. Three separate populations: a broad
 * haze film heaviest at the frame edges where the squeegee never reaches, hard
 * water spotting in the lower third from the sprinklers, and finger/hand smear
 * around door height.
 *
 * The grime is emitted as a straight `Uint8Array` DataTexture rather than a
 * CanvasTexture: canvas backing stores are premultiplied, and this project has
 * already lost days to low-alpha writes corrupting the RGB channels.
 */
export function makeBuildingGlassGrime(size = 512, tileMetres = 2.4, seed = 9109): GlassMaps {
  const rng = makeRng(seed);
  const haze = fbm(size, 5, rng, { octaves: 4 });
  const filmFine = fbm(size, 40, rng, { octaves: 3 });
  const spots = worley(size, 60, rng);
  const spotMask = fbm(size, 6, rng, { octaves: 3 });
  const smear = fbm(size, 12, rng, { octaves: 3, ridged: true });
  const dust = fbm(size, 200, rng, { octaves: 2 });

  const rough = new Float32Array(size * size);
  const grime = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const dustCol = rgb(0x9a917f);

  for (let py = 0; py < size; py++) {
    const v = py / size; // 0 at the bottom of the pane
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const u = px / size;
      // Distance to the nearest pane edge, 0..1 of half-pane.
      const edge = Math.min(u, 1 - u, v, 1 - v) * 2;
      const edgeFilm = 1 - smoothstep(0.0, 0.35, edge);

      const film = clamp01(haze[i] * 0.55 + filmFine[i] * 0.25 + edgeFilm * 0.6);
      // Hard water spotting concentrated low on the glass.
      const spot = (1 - smoothstep(0.06, 0.24, spots[i])) * smoothstep(0.45, 0.7, spotMask[i]) * (1 - smoothstep(0.0, 0.55, v));
      // Hand smear at roughly 0.9 - 1.4 m up a 2 m pane.
      const hand = smoothstep(0.35, 0.5, v) * (1 - smoothstep(0.62, 0.78, v)) * smoothstep(0.55, 0.8, smear[i]);

      const cover = clamp01(film * 0.5 + spot * 0.85 + hand * 0.45 + dust[i] * 0.1);
      put(grime, i * 4, shadeRgb(dustCol, 0.75 + dust[i] * 0.4), Math.round(clamp01(cover * 0.7) * 255));

      rough[i] = clamp01(0.02 + film * 0.16 + spot * 0.4 + hand * 0.2);
      height[i] = clamp01(0.5 + spot * 0.35 + hand * 0.1);
    }
  }

  return {
    roughnessMap: buildingGray(rough, size),
    normalMap: buildingRgba(heightToNormal(height, size, 0.35), size, false),
    grimeMap: buildingRgba(grime, size, true),
    tileX: tileMetres,
    tileY: tileMetres,
  };
}

/* ------------------------------------------------------------------ */
/* rust streak decal                                                    */
/* ------------------------------------------------------------------ */

/**
 * A vertical rust runnel, for the wall below a scupper or a roof drain. UV.y
 * runs down the wall from the source. This is the single strongest realism cue
 * on a plain painted wall, so it is a real alpha decal rather than a shader
 * term: it has to be positioned exactly under the outlet, not scattered.
 *
 * Emitted as a DataTexture for the premultiplied-alpha reason above.
 */
export function makeBuildingRustStreak(size = 512, seed = 4211): THREE.DataTexture {
  const rng = makeRng(seed);
  const runnels = fbm(size, 34, rng, { octaves: 4, ridged: true });
  const along = fbm(size, 9, rng, { octaves: 4 });
  const speck = fbm(size, 150, rng, { octaves: 2 });

  const data = new Uint8Array(size * size * 4);
  const rustDark = rgb(0x51301c);
  const rustMid = rgb(0x8a4f27);
  const rustPale = rgb(0xa8875e);

  for (let py = 0; py < size; py++) {
    // Row 0 of a DataTexture is UV v = 0, which is the BOTTOM of the quad, so
    // the source has to be generated at the last row. Getting this backwards
    // paints the wet stain at the pavement and the fade at the scupper.
    const v = 1 - py / size;
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const u = px / size;

      // The plume widens as it falls, then breaks up. Real runoff staining is
      // a thin, translucent tea-coloured wash with a few darker threads in it,
      // not a painted stripe - so the alpha ceiling here is deliberately low
      // and only the individual runnels get anywhere near opaque.
      const halfWidth = 0.1 + v * 0.42;
      const off = Math.abs(u - 0.5) / halfWidth;
      const lateral = 1 - smoothstep(0.2, 1.0, off);

      const streak = smoothstep(0.5, 0.9, runnels[i]);
      const fall = (1 - smoothstep(0.3, 1.0, v)) * (0.35 + along[i] * 1.0);
      const pool = 1 - smoothstep(0.0, 0.07, v); // the wet stain at the outlet

      const wash = lateral * fall * 0.34;
      const threads = streak * lateral * fall * 0.62;
      let a = clamp01(wash + threads + pool * lateral * 0.55 + speck[i] * 0.05 * lateral);
      a = clamp01(a - 0.04);

      let c = mix(rustMid, rustDark, clamp01(streak * 0.8 + pool * 0.5));
      c = mix(c, rustPale, clamp01(1 - streak) * 0.55 * (1 - pool));
      put(data, i * 4, c, Math.round(a * 255));
    }
  }

  const tex = buildingRgba(data, size, true);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A soft, irregular dirt/scuff blob decal. Used at the base of walls, at
 * corners where trolleys clip the block, and around the door where hands and
 * shoulders hit it.
 */
export function makeBuildingScuff(size = 256, seed = 6607, dark = 0x3b352c): THREE.DataTexture {
  const rng = makeRng(seed);
  const blob = fbm(size, 4, rng, { octaves: 4 });
  const detail = fbm(size, 30, rng, { octaves: 3 });
  const scratch = fbm(size, 110, rng, { octaves: 2, ridged: true });

  const data = new Uint8Array(size * size * 4);
  const c0 = rgb(dark);
  const c1 = rgb(0x6d6558);

  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const u = px / size;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      const falloff = 1 - smoothstep(0.35, 1.0, r);
      const a = clamp01((smoothstep(0.4, 0.72, blob[i]) * 0.9 + detail[i] * 0.35 + scratch[i] * 0.2 - 0.18) * falloff);
      put(data, i * 4, mix(c0, c1, detail[i]), Math.round(clamp01(a) * 255));
    }
  }

  const tex = buildingRgba(data, size, true);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Condensation / frost gradient for a drinks cooler door: heavy fog low and at
 * the edges of the pane where the gasket runs cold, clearing in the middle
 * where the anti-sweat heater does its job and customers wipe it.
 */
export function makeBuildingCondensation(size = 512, seed = 8803): THREE.DataTexture {
  const rng = makeRng(seed);
  const bloom = fbm(size, 6, rng, { octaves: 4 });
  const droplets = worley(size, 110, rng);
  const dropMask = fbm(size, 9, rng, { octaves: 3 });
  const fine = fbm(size, 180, rng, { octaves: 2 });

  const data = new Uint8Array(size * size * 4);
  const cold = rgb(0xdfe8ee);

  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const u = px / size;
      const edge = Math.min(u, 1 - u, v, 1 - v) * 2;
      const gasket = 1 - smoothstep(0.0, 0.4, edge);
      // Condensate always sits heaviest at the bottom of the pane.
      const low = 1 - smoothstep(0.0, 0.62, v);

      const drop = (1 - smoothstep(0.1, 0.34, droplets[i])) * smoothstep(0.42, 0.7, dropMask[i]);
      const fog = clamp01(gasket * 0.7 + low * 0.5 + bloom[i] * 0.3 - 0.15);
      const a = clamp01(fog * 0.7 + drop * 0.55 * (0.4 + low) + fine[i] * 0.06);
      put(data, i * 4, shadeRgb(cold, 0.9 + fine[i] * 0.2), Math.round(clamp01(a * 0.85) * 255));
    }
  }

  const tex = buildingRgba(data, size, true);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function disposeBuildingMaps(m: BuildingMaps) {
  m.map.dispose();
  m.normalMap.dispose();
  m.roughnessMap.dispose();
}
