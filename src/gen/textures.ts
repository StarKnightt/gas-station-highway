import * as THREE from "three";
// `type Rng`, not a bare `Rng`: it is a type-only export, and importing it as a
// value makes this module unloadable under Node's strip-only TypeScript mode,
// which is how every tool under tools/ measures geometry on the CPU.
import { clamp01, fbm, lerp, makeRng, type Rng, smoothstep, valueNoise, worley } from "./noise";

export interface SurfaceMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  /** Surface relief, used by paint so it can pool in voids and skip high stones. */
  heightMap?: THREE.DataTexture;
  /** Physical size in metres that one tile of these maps covers. */
  tileMetres: number;
}

let maxAnisotropy = 8;
export function setMaxAnisotropy(v: number) {
  maxAnisotropy = v;
}
export function getMaxAnisotropy() {
  return maxAnisotropy;
}

/* ------------------------------------------------------------------ */
/* low level helpers                                                    */
/* ------------------------------------------------------------------ */

function rgbaTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Rasterise a seamless mask by drawing the callback 9 times on a wrapped grid. */
export function drawWrappedMask(size: number, draw: (ctx: CanvasRenderingContext2D) => void): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * size, oy * size);
      draw(ctx);
      ctx.restore();
    }
  }
  const img = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = img[i * 4] / 255;
  return out;
}

/** Sobel height -> tangent space normal map. */
export function heightToNormal(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

function grayTexture(buf: Float32Array, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return rgbaTexture(data, size, false);
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
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: lerp(a.r, b.r, t),
  g: lerp(a.g, b.g, t),
  b: lerp(a.b, b.b, t),
});

/** sRGB encode a linear-ish authored value so DataTextures read correctly. */
function writeSrgb(data: Uint8Array, i: number, c: Rgb) {
  data[i] = Math.round(clamp01(c.r) * 255);
  data[i + 1] = Math.round(clamp01(c.g) * 255);
  data[i + 2] = Math.round(clamp01(c.b) * 255);
  data[i + 3] = 255;
}

/* ------------------------------------------------------------------ */
/* asphalt                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hot-mix asphalt. The look comes from four stacked ideas:
 *  - crushed aggregate (worley) that protrudes through the binder
 *  - binder-level fine grain and micro pitting
 *  - meso-scale tone drift so the sheet is never one grey
 *  - crack-sealant snakes: darker, glossier, slightly raised
 */
/**
 * Control weights on the height contribution of the two sub-Nyquist terms.
 *
 * Separate from their albedo contribution on purpose. Albedo tolerates content
 * finer than a texel — it filters to a plausible mean and reads as grain — while
 * a height field does not, because the normal map derived from it turns
 * sub-texel content into per-texel slope noise, and a jittered cell grid sampled
 * at about two texels per cell beats against the texel grid and produces a
 * periodic pattern out of aperiodic content.
 *
 * These exist so "the grain that reads comes from `aggBig` and `aggDist`, and
 * `aggFine` contributes the artefact rather than the grain" is a claim that can
 * be measured with the terms forced off rather than asserted.
 */
export interface AsphaltOptions {
  /** Height weight of the ~7.5 mm aggregate, which is 1.92 texels per cell. */
  fineHeight?: number;
  /** Height weight of the micro fbm, whose octaves are 3.7 and 1.7 texels. */
  microHeight?: number;
}

export function makeAsphalt(
  size = 2048,
  tileMetres = 8,
  seed = 1337,
  options: AsphaltOptions = {}
): SurfaceMaps {
  const fineHeightW = options.fineHeight ?? 1;
  const microHeightW = options.microHeight ?? 1;
  const rng = makeRng(seed);
  const px = size / tileMetres;

  // Hot-mix is a graded blend: a few big stones, more mid, a lot of fines.
  // One worley cell size is what makes procedural asphalt read as evenly
  // peppered carpet, because every bump ends up the same size and height.
  const aggBig = worley(size, Math.round(tileMetres / 0.034), rng); // ~34 mm
  const aggDist = worley(size, Math.round(tileMetres / 0.016), rng); // ~16 mm
  const aggFine = worley(size, Math.round(tileMetres / 0.0075), rng); // ~7 mm
  const coarse = worley(size, Math.round(tileMetres / 0.045), rng); // ~45 mm clusters
  const grain = fbm(size, Math.round(tileMetres * 24), rng, { octaves: 4 });
  const micro = fbm(size, Math.round(tileMetres * 70), rng, { octaves: 2 });
  const meso = fbm(size, 5, rng, { octaves: 4 });
  const patchNoise = fbm(size, 3, rng, { octaves: 3 });
  const stoneHue = valueNoise(size, Math.round(tileMetres / 0.016), rng);

  // Hairline (unsealed) micro-cracking, kept faint. The big tar crack-sealant
  // snakes live in the world-space site overlay instead, so they never tile.
  const hairline = drawWrappedMask(size, (ctx) => {
    const crng = makeRng(seed * 7 + 11);
    ctx.strokeStyle = "#fff";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, px * 0.006);
    for (let i = 0; i < 26; i++) {
      let x = crng() * size;
      let y = crng() * size;
      let d = crng() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 12 + crng() * 40;
      for (let s = 0; s < steps; s++) {
        d += (crng() - 0.5) * 0.8;
        x += Math.cos(d) * px * 0.03;
        y += Math.sin(d) * px * 0.03;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const binderDark = rgb(0x272628);
  const binderBrown = rgb(0x3d3833);
  const binderGrey = rgb(0x5c5a58);
  const stoneLight = rgb(0x938e85);
  const stoneWarm = rgb(0x796b58);
  const stoneCool = rgb(0x646870);
  const sealant = rgb(0x1e1b1c);

  for (let i = 0; i < size * size; i++) {
    // worley returns distance-to-nearest-seed, so stones live where it is SMALL.
    // Take the strongest of the three gradings rather than adding them, so a big
    // stone reads as one big stone instead of a mound of overlapping fines.
    const stoneB = (1 - smoothstep(0.12, 0.34, aggBig[i])) * 0.95;
    const stoneM = (1 - smoothstep(0.16, 0.44, aggDist[i])) * 0.68;
    const stoneF = (1 - smoothstep(0.21, 0.55, aggFine[i])) * 0.4;
    const stone = Math.max(stoneB, stoneM, stoneF);
    const cluster = 1 - smoothstep(0.22, 0.62, coarse[i]);
    const g = grain[i];
    const m = meso[i];
    const mi = micro[i];

    // Repair patches: whole regions of slightly different, fresher mix.
    const patch = smoothstep(0.56, 0.62, patchNoise[i]);

    // Base binder colour drifts warm-brown to cool-grey across the sheet.
    let c = mixRgb(binderDark, binderBrown, clamp01(m * 1.5 - 0.15));
    c = mixRgb(c, binderGrey, clamp01((m - 0.45) * 1.9) * 0.65);
    c = mixRgb(c, binderDark, patch * 0.45); // patches read darker / newer

    // Exposed aggregate: this is what makes it asphalt and not tarmac soup.
    const stoneMask = stone * (0.4 + cluster * 0.6);
    const hueT = stoneHue[i];
    const sc = hueT < 0.55 ? mixRgb(stoneCool, stoneLight, hueT / 0.55) : mixRgb(stoneLight, stoneWarm, (hueT - 0.55) / 0.45);
    c = mixRgb(c, sc, stoneMask * (0.42 + g * 0.55) * (1 - patch * 0.5));

    // Grain / micro dirt.
    const shade = 0.8 + g * 0.3 + mi * 0.14;
    c = { r: c.r * shade, g: c.g * shade, b: c.b * shade };

    // Hairline cracking: a dark line, not a glossy one.
    const cr = clamp01(hairline[i]);
    c = mixRgb(c, sealant, cr * 0.55);

    writeSrgb(albedo, i * 4, c);

    // Dry hot-mix is genuinely rough. Anything shinier than ~0.9 turns the whole
    // lot into a mirror of the dawn sky at grazing angles.
    let r = 0.955 - stoneMask * 0.075 - m * 0.03 + mi * 0.025;
    r = lerp(r, r + 0.02, cr);
    r = lerp(r, r - 0.03, patch);
    rough[i] = clamp01(r);

    // Proud stones drive the height, so the relief inherits the same grading
    // as the albedo and the surface gets a real range of stone sizes.
    height[i] = clamp01(
      stoneB * 0.78 +
        stoneM * 0.34 +
        stoneF * 0.14 * fineHeightW +
        g * 0.16 +
        mi * 0.12 * microHeightW -
        cr * 0.18 -
        patch * 0.05
    );
  }

  return {
    map: rgbaTexture(albedo, size, true),
    normalMap: rgbaTexture(heightToNormal(height, size, 1.25), size, false),
    roughnessMap: grayTexture(rough, size),
    heightMap: grayTexture(height, size),
    tileMetres,
  };
}

/* ------------------------------------------------------------------ */
/* concrete                                                             */
/* ------------------------------------------------------------------ */

/** Broom-finished sidewalk/forecourt concrete with saw-cut control joints. */
export function makeConcrete(size = 1024, tileMetres = 4, seed = 99): SurfaceMaps {
  const rng = makeRng(seed);
  const px = size / tileMetres;

  const paste = fbm(size, Math.round(tileMetres * 18), rng, { octaves: 4 });
  const meso = fbm(size, 4, rng, { octaves: 4 });
  const stains = fbm(size, 2, rng, { octaves: 3 });
  const aggDist = worley(size, Math.round(tileMetres / 0.02), rng);
  const pits = worley(size, Math.round(tileMetres / 0.09), rng);
  const wearNoise = fbm(size, 6, rng, { octaves: 3 });
  const spallField = fbm(size, 3, rng, { octaves: 3 });

  const spatter = drawWrappedMask(size, (ctx) => {
    const crng = makeRng(seed * 13 + 5);
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 900; i++) {
      const r = (0.2 + crng() * crng() * 3.2) * (px / 100);
      ctx.globalAlpha = 0.25 + crng() * 0.6;
      ctx.beginPath();
      ctx.arc(crng() * size, crng() * size, Math.max(0.6, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  const broomPeriodPx = Math.max(6, (size / tileMetres) * 0.03);
  const broomWobble = broomPeriodPx * 0.55;

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  // Forecourt concrete is a warm grey-brown, never the blue-grey of fresh mix:
  // years of fuel, rubber and road dust push it toward drab khaki. Anything
  // with more blue than red in it reads as pink-mauve once the dawn key light
  // and ACES get hold of it.
  const pale = rgb(0x918a7d);
  const mid = rgb(0x746d61);
  const dark = rgb(0x4e483e);
  const warm = rgb(0x857761);
  const agg = rgb(0x6a655c);
  const rust = rgb(0x6b5138);

  for (let i = 0; i < size * size; i++) {
    // Broom finish: parallel corduroy in the normal only, with a slight wobble.
    // Kept at ~30 mm spacing: any finer and it aliases into moire on screen.
    const y = Math.floor(i / size);
    const wob = paste[i] * broomWobble;
    const broom = Math.sin(((y + wob) / broomPeriodPx) * Math.PI * 2) * 0.5 + 0.5;

    const m = meso[i];
    let c = mixRgb(mid, pale, clamp01(m * 1.4 - 0.1));
    c = mixRgb(c, warm, clamp01(stains[i] - 0.45) * 1.3);
    c = mixRgb(c, dark, clamp01(0.5 - stains[i]) * 0.75);

    // Worn spots expose aggregate.
    const wear = smoothstep(0.6, 0.78, wearNoise[i]);
    const stone = 1 - smoothstep(0.14, 0.4, aggDist[i]);
    c = mixRgb(c, agg, wear * stone * 0.55);

    const grime = spatter[i];
    c = mixRgb(c, dark, grime * 0.45);

    // Rust bleed from rebar chairs and the odd dropped tool, plus the brown
    // halo fuel leaves behind on a slab it has soaked into.
    const rusty = smoothstep(0.66, 0.86, stains[i]) * smoothstep(0.4, 0.7, wearNoise[i]);
    c = mixRgb(c, rust, rusty * 0.4);

    // Spalls: shallow craters where the surface paste has popped off. Gated by
    // a large blotch field so they cluster in a few places instead of forming a
    // regular grid out of the pit cells.
    const spall =
      smoothstep(0.70, 0.88, spallField[i]) * (1 - smoothstep(0.06, 0.22, pits[i]));
    c = mixRgb(c, agg, spall * 0.75);

    const shade = 0.85 + paste[i] * 0.2;
    c = { r: c.r * shade, g: c.g * shade, b: c.b * shade };
    writeSrgb(albedo, i * 4, c);

    rough[i] = clamp01(0.88 + paste[i] * 0.1 - wear * 0.07 - grime * 0.04 + spall * 0.05);
    height[i] = clamp01(
      broom * 0.07 + paste[i] * 0.4 + (1 - pits[i]) * 0.18 + wear * stone * 0.3 - spall * 0.35
    );
  }

  return {
    map: rgbaTexture(albedo, size, true),
    normalMap: rgbaTexture(heightToNormal(height, size, 0.8), size, false),
    roughnessMap: grayTexture(rough, size),
    tileMetres,
  };
}

/* ------------------------------------------------------------------ */
/* dirt / gravel shoulder                                               */
/* ------------------------------------------------------------------ */

/**
 * Knobs that turn the one dirt generator into two genuinely different soils.
 *
 * The lesson from cases 21/22 applied to terrain: a second "material" that is
 * the first one at another brightness reads as an exposure change, not as a
 * different substance. What separates a gravelly crust from a fine clay in a
 * photograph is the *feature size and the feature census* — how much gravel,
 * how big the stones are, whether there is dead grass in it — far more than
 * the hue. So these scale the features, and the palette comes second.
 *
 * Every default reproduces the original single soil exactly.
 */
export interface DirtOptions {
  /** Multiplies how much gravel shows. 0 removes it. */
  gravel?: number;
  /** Multiplies the sparse larger stones. */
  rocks?: number;
  /** Multiplies dead grass clumps. */
  grass?: number;
  /** Scales the clod feature size; >1 is a finer, tighter crust. */
  clodFreq?: number;
  /** Overall relief multiplier fed to the normal map. */
  relief?: number;
  /**
   * How strongly the fine relief is modulated by the 1.3-1.9 m soil variation.
   * 1 is the default; **0 restores the unmodulated, uniform-grain relief** and
   * exists as a forced-off control arm, because a modulation is exactly the
   * kind of change that cannot be confirmed from a frame on its own.
   */
  friability?: number;
  palette?: Partial<{
    dustLight: number;
    dirtMid: number;
    dirtDark: number;
    gravelCol: number;
  }>;
}

/** Dry compacted dirt with gravel, dead grass tufts and dust. */
/**
 * How many octaves of `fbm` at this base frequency still land on more than one
 * texel, and why asking matters.
 *
 * `fbm`'s `baseFreq` is lattice cells across the whole map, so an octave's
 * feature size in texels is `size / freq` and each octave divides that by the
 * lacunarity. Past `size / freq < 2` an octave is finer than the grid storing
 * it, and it does not politely vanish: it aliases into **uncorrelated
 * per-texel values**, which is white noise, which renders as a uniform fine
 * grain over everything. That is the same defect as sampling a texture far
 * above its design frequency, one step earlier in the pipeline — authored,
 * present in the buffer, and not the thing that was authored.
 *
 * The dirt height field was built with five clod octaves at a base of six
 * texels, so three of the five were sub-texel, plus a second grass octave at
 * 0.9 texels. Its measured autocorrelation at a one-texel lag was 0.07, which
 * is to say it was very nearly pure noise, and it rendered exactly as that
 * describes: an evenly dappled carpet with no structure at any size.
 *
 * Capped at the call site rather than inside `fbm`, deliberately. `fbm` is
 * shared by six systems and silently changing how many octaves it returns
 * would move everyone's pixels at once; the finding is worth broadcasting, the
 * change is not worth making on other people's behalf.
 */
function resolvableOctaves(size: number, baseFreq: number, want: number, minTexels = 2.4, lacunarity = 2.17): number {
  let n = 0;
  while (n < want && size / (baseFreq * lacunarity ** n) >= minTexels) n++;
  return Math.max(1, n);
}

export function makeDirt(size = 1024, tileMetres = 17, seed = 404, opts: DirtOptions = {}): SurfaceMaps {
  const {
    gravel: gravelAmt = 1,
    rocks: rockAmt = 1,
    grass: grassAmt = 1,
    clodFreq = 1,
    relief = 1,
    friability = 1,
    palette = {},
  } = opts;
  const rng = makeRng(seed);

  const clodFreqCells = Math.round(tileMetres * 10 * clodFreq);
  const clods = fbm(size, clodFreqCells, rng, { octaves: resolvableOctaves(size, clodFreqCells, 5) });
  const meso = fbm(size, 9, rng, { octaves: 4 });
  /**
   * Lumps at ~0.55 m, filling the gap between the finest relief this map
   * carries and the coarsest the ground mesh can represent.
   *
   * Kept modest deliberately, and the reason is a hard limit rather than
   * taste. `heightToNormal` is a fixed one-texel Sobel and `height` is clamped
   * to 0..1, so the slope a baked normal map reports for a feature goes as
   * amplitude over wavelength with the amplitude bounded above by 1. **A
   * normal map is therefore structurally narrow-band: its longest wavelength
   * is always its weakest, and no amount of added octaves changes that.** At
   * 0.55 m against the clods' 0.1 m this term carries about a fifth of their
   * slope at equal amplitude, so on its own it would be one more feature that
   * does nothing. It is here to fill the band, not to be seen; the modulation
   * below is what actually widens the perceived spectrum.
   */
  const lumps = fbm(size, Math.round(tileMetres / 0.55), rng, { octaves: 3 });
  const gravelDist = worley(size, Math.round(tileMetres / 0.035), rng);
  const grassCells = Math.round(tileMetres * 30);
  const grassNoise = fbm(size, grassCells, rng, {
    octaves: resolvableOctaves(size, grassCells, 2),
    ridged: true,
  });
  const patchy = fbm(size, 13, rng, { octaves: 3 });

  const albedo = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  // Scattered larger stones: a shoulder is never uniform soil, and a few
  // readable rocks per square metre give the eye something to measure against.
  const rocks = worley(size, Math.round(tileMetres / 0.19), rng);
  const rockPick = valueNoise(size, Math.round(tileMetres / 0.19), rng);

  // Flat-open americana, not Mojave. A roadside verge is compacted mineral soil
  // and gravel with dead grass in it - dark, brown, slightly grey from the road
  // grit worked into it. The previous palette was pale tan and read as dune
  // sand, which set entirely the wrong location for the piece.
  const dustLight = rgb(palette.dustLight ?? 0x685a44);
  const dirtMid = rgb(palette.dirtMid ?? 0x463b2d);
  const dirtDark = rgb(palette.dirtDark ?? 0x27211a);
  const deadGrass = rgb(0x6d5f3c);
  const strawLight = rgb(0x8b7c52);
  const gravelCol = rgb(palette.gravelCol ?? 0x6e675d);
  const rockPale = rgb(0x7b756a);
  const rockDark = rgb(0x433d35);

  for (let i = 0; i < size * size; i++) {
    const m = meso[i];
    let c = mixRgb(dirtMid, dustLight, clamp01(m * 0.95));
    c = mixRgb(c, dirtDark, clamp01(0.45 - m) * 0.8);

    const gravel = (1 - smoothstep(0.15, 0.46, gravelDist[i])) * gravelAmt;
    c = mixRgb(c, gravelCol, gravel * 0.5 * (0.3 + clods[i]));

    // Dead grass only in the patchier areas, so it reads as clumps not carpet.
    const grassMask = smoothstep(0.55, 0.86, patchy[i]) * smoothstep(0.38, 0.8, grassNoise[i]) * grassAmt;
    c = mixRgb(c, mixRgb(deadGrass, strawLight, clods[i]), grassMask * 0.5);

    // Only the deepest cells of the coarse Worley become actual stones, so they
    // read as a sparse scatter instead of a cobble pavement.
    const rock = (1 - smoothstep(0.06, 0.2, rocks[i])) * rockAmt;
    c = mixRgb(c, mixRgb(rockDark, rockPale, rockPick[i]), rock * 0.85);

    const shade = 0.9 + clods[i] * 0.18;
    c = { r: c.r * shade, g: c.g * shade, b: c.b * shade };
    writeSrgb(albedo, i * 4, c);

    /**
     * Friability: how broken up the soil is here, over 1.3 to 1.9 m.
     *
     * This is the actual fix for the near ground reading as an evenly dappled
     * carpet, and it works differently from the height-field fix that preceded
     * it. There the band was widened by adding octaves; here the clamp forbids
     * that, because a longer wavelength at bounded amplitude carries less
     * slope and simply is not seen.
     *
     * So instead the *amplitude* of the fine relief is made long-wavelength.
     * Modulating a 0.1 m carrier by a 1.6 m envelope puts energy at the sum
     * and difference of the two, which widens the spectrum the eye integrates
     * without needing any long-wavelength slope at all — patches of ground
     * that are smooth next to patches that are broken, rather than one
     * uniform grain everywhere. Uniform grain is what "carpet" means:
     * NOTES.md 41 is about scale uniformity, and an unmodulated fine relief
     * is scale uniformity in its purest form.
     *
     * `meso` and `patchy` are reused rather than newly generated, so this
     * costs nothing, and it ties relief to the colour variation that was
     * already keyed off them — which is also how soil works. The patches that
     * look different are the patches that are different.
     */
    const friable = 1 + friability * (clamp01(0.3 + 1.35 * (m * 0.62 + patchy[i] * 0.38 - 0.22)) - 1);

    rough[i] = clamp01(0.93 + clods[i] * 0.06 - gravel * 0.1 - grassMask * 0.03 - rock * 0.12);
    // Fine terms scaled up by roughly the reciprocal of the mean friability, so
    // the relief budget is unchanged on average and redistributed rather than
    // reduced: cloddier where the soil is broken, smoother where it is packed.
    // Rocks are not modulated, because a stone is a stone wherever it sits.
    /**
     * Gravel's weight in the HEIGHT channel is a fifth of what it was, and this
     * is the change that actually removes the carpet.
     *
     * `gravelDist` is a Worley field at 35 mm cells, which on a 1024 px map
     * over 17 m is 2.1 texels per stone, and the threshold makes it very nearly
     * binary. Its variance was therefore about three and a half times the
     * clods' — so the dominant term in the relief was two-texel binary noise,
     * and the measured autocorrelation was 0.41 at one texel and zero by four.
     * The map read as an even fine grain because that is very nearly all it
     * contained.
     *
     * 35 mm gravel in a verge is real; the point is that at 16.6 mm per texel
     * it cannot be *shaped*, only speckled. So it keeps its full weight in
     * albedo, where aliasing reads as speckle and speckle is what gravel looks
     * like, and gives up most of its weight in height, where aliasing reads as
     * a uniform crust over the entire lot. Relief is carried by the terms that
     * can be resolved: clods at 6 texels, lumps at 33, stones at 12.
     *
     * Dead grass gets the same treatment for the same reason: `grassNoise` is
     * 2.0 texels and near-binary after its smoothstep, so once gravel stopped
     * dominating the relief, grass simply inherited the role. Its weight went
     * 0.28 to 0.10 and it keeps full strength in albedo, where a fine straw
     * speckle is correct.
     *
     * The general form: **a feature below the resolution of the channel it is
     * written to should be moved to a channel that can hold it, not scaled
     * down until it is quiet.** Albedo tolerates what a normal map cannot. And
     * removing the loudest sub-texel term only promotes the next one, so this
     * is a sweep rather than a fix: the check is the autocorrelation, not the
     * absence of the term you happened to look at first.
     */
    height[i] = clamp01(
      (clods[i] * 0.6 + gravel * 0.08 + grassMask * 0.1) * friable + (lumps[i] - 0.5) * 0.44 + rock * 0.55
    );
  }

  return {
    map: rgbaTexture(albedo, size, true),
    /**
     * Strength 1.4 -> 2.5 -> 1.55, and the round trip is worth recording.
     *
     * Removing the sub-texel terms halved the height field's mean local slope,
     * 0.147 to 0.073, because two-texel binary noise carries enormous slope for
     * its size — that is exactly why it dominated. Restoring the budget with
     * amplitude looked legitimate at that point, and would have been the wrong
     * knob before, since turning it up beforehand would only have made a crust
     * of aliased grain louder (NOTES.md 33).
     *
     * At 2.5 it was still wrong, in the other direction. **Slope conserved
     * across a wavelength change is not appearance conserved.** The same mean
     * slope carried by 100 mm clods instead of 33 mm noise is no longer a
     * grain: each feature is individually resolved, so the ground rendered as
     * deep round pits — a golf ball rather than soil. The eye reads a fine
     * texture at that slope as roughness and a coarse one as holes. So the
     * budget is deliberately NOT restored; strength settles a little above the
     * original, with the weight moved into the 0.55 m lumps where relief reads
     * as ground shape rather than as pocking.
     */
    normalMap: rgbaTexture(heightToNormal(height, size, 1.55 * relief), size, false),
    roughnessMap: grayTexture(rough, size),
    heightMap: grayTexture(height, size),
    tileMetres,
  };
}

/* ------------------------------------------------------------------ */
/* road paint                                                           */
/* ------------------------------------------------------------------ */

export interface PaintMaps {
  map: THREE.DataTexture;
  alphaMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  normalMap: THREE.DataTexture;
}

/**
 * A worn traffic-paint strip. UV.x runs along the stripe, UV.y across it.
 * The alpha channel does the chipping so the stripe never reads as a decal.
 */
export function makePaint(size = 1024, seed = 77, warm = false): PaintMaps {
  const rng = makeRng(seed);
  const chip = fbm(size, 46, rng, { octaves: 5 });
  const fine = fbm(size, 190, rng, { octaves: 3 });
  const wearBand = fbm(size, 9, rng, { octaves: 4 });
  const dirt = fbm(size, 22, rng, { octaves: 4 });
  const grit = worley(size, 130, rng);

  const albedo = new Uint8Array(size * size * 4);
  const alpha = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);

  const white = rgb(0xb4b1a7);
  const whiteDirty = rgb(0xc0baab);
  const yellow = rgb(0xa8873f);
  const yellowDirty = rgb(0x9a8447);
  const base = warm ? yellow : white;
  const baseDirty = warm ? yellowDirty : whiteDirty;

  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const u = x / size;
    const v = y / size;

    // Edges of the stripe are always the first thing to go.
    const edge = Math.min(v, 1 - v) * 2; // 0 at edges, 1 at centre
    const edgeWear = smoothstep(0.0, 0.42, edge);

    // Traffic wears the stripe unevenly along its length.
    const band = smoothstep(0.22, 0.72, wearBand[i]);
    let a = clamp01(edgeWear * (0.62 + band * 0.6) + chip[i] * 0.4 - 0.08);
    a = clamp01(a * (1 - smoothstep(0.60, 0.9, fine[i]) * 0.45));
    // Hard chips.
    a *= 1 - smoothstep(0.66, 0.80, chip[i] * 0.5 + fine[i] * 0.5) * 0.85;
    alpha[i] = clamp01(a * 1.25);

    const grime = clamp01(dirt[i] * 0.8 + (1 - edgeWear) * 0.5);
    let c = mixRgb(base, baseDirty, clamp01(grime * 1.15));
    const shade = 0.86 + fine[i] * 0.26;
    c = { r: c.r * shade, g: c.g * shade, b: c.b * shade };
    writeSrgb(albedo, i * 4, c);

    rough[i] = clamp01(0.72 + fine[i] * 0.2 - band * 0.05);
    height[i] = clamp01(alpha[i] * 0.5 + (1 - grit[i]) * 0.3 + fine[i] * 0.2);
    void u;
  }

  return {
    map: rgbaTexture(albedo, size, true),
    alphaMap: grayTexture(alpha, size),
    roughnessMap: grayTexture(rough, size),
    normalMap: rgbaTexture(heightToNormal(height, size, 1.1), size, false),
  };
}

/* ------------------------------------------------------------------ */
/* macro breakup noise                                                  */
/* ------------------------------------------------------------------ */

/**
 * Very low frequency world-space noise. Multiplied over albedo and added to
 * roughness so the tiling of the detail maps stops being readable.
 */
export function makeMacroNoise(size = 512, seed = 5150): THREE.DataTexture {
  const rng = makeRng(seed);
  const a = fbm(size, 3, rng, { octaves: 5, gain: 0.55 });
  const b = fbm(size, 7, rng, { octaves: 4 });
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (a[i] - 0.5) * 1.15 + (b[i] - 0.5) * 0.45);
  return grayTexture(out, size);
}

export function disposeSurface(s: SurfaceMaps) {
  s.map.dispose();
  s.normalMap.dispose();
  s.roughnessMap.dispose();
}

/* ------------------------------------------------------------------ */
/* map/channel agreement guard                                          */
/* ------------------------------------------------------------------ */

/**
 * A map slot has a channel convention, and the convention is not always the
 * channel the slot is named after.
 *
 * `MeshStandardMaterial`'s alpha map chunk is, verbatim in three 0.185:
 *
 *     diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
 *
 * It samples **green**. Sampling an `R8` texture yields `(r, 0, 0, 1)`, so a
 * `THREE.RedFormat` texture in that slot multiplies alpha by zero everywhere.
 * It compiles, it binds, it costs texture memory, it passes any check that
 * inspects the data that was written, and it renders nothing. That is what the
 * pump weep stain did for four rounds.
 *
 * The same trap exists on every slot below, because each samples one fixed
 * channel rather than a luminance:
 *
 * | slot              | chunk                     | channel |
 * | ----------------- | ------------------------- | ------- |
 * | `alphaMap`        | `alphamap_fragment`       | `.g`    |
 * | `aoMap`           | `aomap_fragment`          | `.r`    |
 * | `roughnessMap`    | `roughnessmap_fragment`   | `.g`    |
 * | `metalnessMap`    | `metalnessmap_fragment`   | `.b`    |
 * | `specularMap`     | `specularmap_fragment`    | `.r`    |
 * | `bumpMap`         | `bumpmap_pars_fragment`   | `.x`    |
 * | `displacementMap` | `displacementmap_vertex`  | `.x`    |
 * | `lightMap`        | `lights_fragment_maps`    | `.rgb`  |
 *
 * An ORM-style packed texture feeding only one of these is correct and this
 * guard says nothing about it: the question is never "does the texture carry
 * other data", it is only "does the channel this slot reads carry the data the
 * author meant".
 */
const SLOT_CHANNELS: ReadonlyArray<readonly [slot: string, channels: string]> = [
  ["alphaMap", "g"],
  ["aoMap", "r"],
  ["roughnessMap", "g"],
  ["metalnessMap", "b"],
  ["specularMap", "r"],
  ["bumpMap", "r"],
  ["displacementMap", "r"],
  ["lightMap", "rgb"],
];

/**
 * Which channels a sampler returns as something other than a constant, per
 * texture format. `undefined` means "not a format this guard models" — those
 * are reported as unestablished rather than guessed at.
 */
function channelsPresent(format: THREE.AnyPixelFormat): string | undefined {
  switch (format) {
    case THREE.RGBAFormat:
      return "rgba";
    case THREE.RGFormat:
      return "rg";
    case THREE.RedFormat:
    case THREE.DepthFormat:
    case THREE.DepthStencilFormat:
      return "r";
    case THREE.AlphaFormat:
      return "a";
    // `LuminanceFormat` and `LuminanceAlphaFormat` are deliberately absent:
    // three 0.185 no longer exports either, so the one format that would have
    // been safe here by replication cannot occur in this tree.
    default:
      return undefined;
  }
}

const CHANNEL_INDEX: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

/**
 * Second half of the check, and the half that catches the cases `format` alone
 * cannot see: an `RGBAFormat` texture whose green bytes were never written is
 * exactly as broken in an `alphaMap` as an R8 one, and it looks correct in
 * every audit that reads the format.
 *
 * Returns `true` only when the data is readable **and** the channel is
 * identically zero across every texel sampled. Anything it cannot read returns
 * `false`, so an unreadable texture is never reported as broken.
 */
function channelIsAllZero(texture: THREE.Texture, channel: string): boolean {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  const data = image?.data;
  if (!data || typeof data.length !== "number" || data.length < 4) return false;
  const texels = Math.floor(data.length / 4);
  if (!image?.width || !image?.height || texels !== image.width * image.height) return false;
  const offset = CHANNEL_INDEX[channel];
  if (offset === undefined) return false;
  // Every texel of a 2048² map is 4 M reads per slot per material; a stride
  // keeps this affordable at init. A channel that is zero everywhere it is
  // written is zero on any stride, and a channel with content is overwhelmingly
  // likely to show it within 4096 samples.
  const stride = Math.max(1, Math.floor(texels / 4096));
  for (let i = 0; i < texels; i += stride) {
    if (data[i * 4 + offset] !== 0) return false;
  }
  return true;
}

export interface MapChannelFinding {
  slot: string;
  channel: string;
  /** `broken` throws; `unestablished` is reported and never thrown on. */
  verdict: "broken" | "unestablished";
  detail: string;
}

/**
 * Dev-time assertion that every channel-sampling map slot on `material` is fed
 * a texture whose sampled channel actually carries data.
 *
 * **Throws** on anything it can establish is broken. It deliberately does not
 * warn-and-continue: silent degradation is the entire defect class this exists
 * for, and a guard that reports without rejecting is worth less than no guard,
 * because the console line scrolls past while the artefact ships (NOTES, the
 * poisoned-PMREM case).
 *
 * Things it cannot establish — a texture whose image data is not readable from
 * the CPU, a render target, a compressed or externally sourced format — are
 * returned as `unestablished` and never thrown on. Naming what it could not
 * check is the point; a guard that flags a correct surface costs more trust
 * than it saves.
 *
 * @returns every finding, including the ones it did not throw on.
 */
export function assertMapChannels(material: THREE.Material, label: string): MapChannelFinding[] {
  const findings: MapChannelFinding[] = [];
  const slots = material as unknown as Record<string, THREE.Texture | null | undefined>;

  for (const [slot, wanted] of SLOT_CHANNELS) {
    const texture = slots[slot];
    if (!texture) continue;

    const present = channelsPresent(texture.format);
    if (present === undefined) {
      findings.push({
        slot,
        channel: wanted,
        verdict: "unestablished",
        detail: `format ${String(texture.format)} is not one this guard models`,
      });
      continue;
    }

    for (const channel of wanted) {
      if (!present.includes(channel)) {
        throw new Error(
          `[map-channel] ${label}: '${slot}' is fed "${texture.name || "an unnamed texture"}", whose format ` +
            `carries only (${present}) — but three's shader samples '.${channel}' from that slot, so it reads a ` +
            `constant and the map does nothing. Write all four channels (see grayTexture in gen/textures.ts) ` +
            `or move the data into '.${channel}'.`
        );
      }
      if (channelIsAllZero(texture, channel)) {
        throw new Error(
          `[map-channel] ${label}: '${slot}' is fed "${texture.name || "an unnamed texture"}", whose '.${channel}' ` +
            `channel is zero at every texel sampled — but that is the channel three's shader reads from this slot. ` +
            `The format is wide enough; the data was written to a different channel.`
        );
      }
    }
  }

  return findings;
}

/**
 * `assertMapChannels` over a whole scene graph, for a harness or a dev build
 * that wants one call rather than one per material.
 *
 * Throws on the first broken slot, for the same reason the singular form does.
 * There is deliberately **no call site for either of these in `src/`**: wiring
 * one means editing `Game.ts` or a system file, and this was written during a
 * pass where six agents were live in those files. The intended installation is
 * one line at the end of `Game.start()`, behind whatever dev gate that file
 * already uses:
 *
 *     if (import.meta.env.DEV) auditSceneMapChannels(this.scene);
 *
 * Until that lands this is a tool, not a gate, and should not be counted as
 * protection.
 */
export function auditSceneMapChannels(scene: THREE.Object3D): MapChannelFinding[] {
  const findings: MapChannelFinding[] = [];
  const seen = new Set<THREE.Material>();

  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const m of list) {
      if (seen.has(m)) continue;
      seen.add(m);
      findings.push(...assertMapChannels(m, m.name || object.name || m.type));
    }
  });

  return findings;
}

export type { Rng };
