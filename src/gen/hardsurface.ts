/**
 * System 3 support kit: procedural maps and shader injection for hard-surface
 * props (fuel dispensers, bollards, the parked car).
 *
 * Deliberately kept separate from `gen/textures.ts`, which owns the ground
 * materials. Everything here is prefixed `hs`/`Hs` or lives behind a name that
 * cannot collide with the ground kit.
 *
 * Two rules learned the hard way in this project and honoured here:
 *  - No canvas round-trips for mask data. Canvas backing stores are
 *    premultiplied, so writing low alpha and reading it back corrupts RGB.
 *    Every map below is assembled straight into a `DataTexture`.
 *  - Every uniform used in an injected shader is declared in the same injected
 *    string. A missing declaration links fine on a software rasteriser and
 *    fails silently on the NVIDIA driver.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp01, fbm, lerp, makeRng, seededRng, smoothstep, valueNoise, worley } from "./noise";

/* ------------------------------------------------------------------ */
/* texture plumbing                                                     */
/* ------------------------------------------------------------------ */

let hsAniso = 8;
export function setHsAnisotropy(v: number) {
  hsAniso = v;
}

function hsTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = hsAniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Encode a **linear reflectance** for storage in an sRGB-tagged colour map.
 *
 * Only for palettes taken from physical reference. A palette arrived at by
 * looking at renders is already display-referred — it was tuned through this
 * same decode — and putting it through here would brighten a surface that was
 * correct. The two cases are indistinguishable in the source, which is why
 * `tools/albedoaudit.mjs` measures delivered reflectance instead of reading
 * the code, and why the bollard palette below is deliberately *not* encoded.
 */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hsGray(buf: Float32Array, size: number): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return hsTexture(d, size, false);
}

/** Sobel of a wrapped height field into a tangent-space normal map. */
function hsNormal(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
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
  return hsTexture(out, size, false);
}

/* ------------------------------------------------------------------ */
/* the shared grime field                                               */
/* ------------------------------------------------------------------ */

/**
 * One RGBA field reused by every weathered prop, sampled triplanar in object
 * space by `applyGrime`:
 *   R  general road film / soot, medium scale
 *   G  streak source; the shader squashes its UVs so it reads as run-off
 *   B  droplet + dust speckle
 *   A  large-scale blotching, used to break up the other three
 */
export function makeGrimeField(size = 512, seed = 9091): THREE.DataTexture {
  const rng = makeRng(seed);
  const blotch = fbm(size, 3, rng, { octaves: 5 });
  const mid = fbm(size, 11, rng, { octaves: 5 });
  const fine = fbm(size, 37, rng, { octaves: 4 });
  const streak = fbm(size, 23, rng, { octaves: 5, gain: 0.6 });
  const streakFine = fbm(size, 71, rng, { octaves: 3 });
  const drops = worley(size, 52, rng);
  const dropPick = valueNoise(size, 52, rng);
  const dust = fbm(size, 59, rng, { octaves: 3 });

  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const film = clamp01((blotch[i] * 0.5 + mid[i] * 0.38 + fine[i] * 0.24 - 0.24) * 1.7);
    // Runs are narrow and hard-edged where they start, feathering as they go.
    const run = clamp01(smoothstep(0.40, 0.80, streak[i]) * (0.5 + streakFine[i] * 0.9));
    // Only about a third of the Worley cells become an actual water spot.
    const spot = (1 - smoothstep(0.02, 0.26, drops[i])) * smoothstep(0.55, 0.75, dropPick[i]);
    const speck = clamp01(spot * 1.1 + dust[i] * 0.4);
    d[i * 4] = Math.round(film * 255);
    d[i * 4 + 1] = Math.round(run * 255);
    d[i * 4 + 2] = Math.round(speck * 255);
    d[i * 4 + 3] = Math.round(clamp01(blotch[i]) * 255);
  }
  return hsTexture(d, size, false);
}

/* ------------------------------------------------------------------ */
/* grime shader injection                                               */
/* ------------------------------------------------------------------ */

export interface GrimeOptions {
  /** Unique per distinct configuration; feeds customProgramCacheKey. */
  key: string;
  field: THREE.Texture;
  /** Metres covered by one tile of the grime field. */
  scale?: number;
  /** General road film. */
  film?: number;
  /** Downward run-off streaking. */
  streak?: number;
  /** Object-space Y that streaks start from and run down out of. */
  streakY?: number;
  /** How many metres the streaks take to fade out below `streakY`. */
  streakFade?: number;
  /** Dust settling on up-facing surfaces. */
  dust?: number;
  /** Water spots / droplet speckle, raises roughness without darkening much. */
  spots?: number;
  filmColor?: THREE.Color;
  dustColor?: THREE.Color;
  /** Contact darkening: everything below `baseY` fades toward black. */
  baseY?: number;
  baseFade?: number;
  baseDark?: number;
  /** How strongly grime pushes roughness up. */
  roughGain?: number;
  /** UV-space anisotropy of the streaks: higher = narrower, longer runs. */
  streakStretch?: number;

  /**
   * Confines run-off to a vertical band at |x| = focus, so a stain has a
   * visible physical source instead of washing evenly down the whole object.
   * On the dispensers this puts the fuel run directly under the nozzle boot.
   * Omit for the old behaviour of streaking everything.
   */
  streakFocusX?: number;
  /** Half width of that band, in metres. */
  streakFocusHalf?: number;

  /**
   * Bare-metal scuff annulus, in object space: where the nozzle has been
   * knocking the same patch of panel for years. Polishes rather than dirties,
   * so it drops roughness and lifts the albedo toward raw steel.
   */
  scuffCentre?: THREE.Vector3;
  scuffRadius?: number;
  scuffAmount?: number;
  scuffColor?: THREE.Color;

  /**
   * Per-instance phase into the grime field, in **tile units** — see the block
   * comment on `applyGrime` for why this exists and why it is the single most
   * important option here when weathering more than one copy of an object.
   *
   * Deliberately not in metres. The offset is added *after* the division by
   * `scale`, so 0.37 means "just over a third of a tile" regardless of whether
   * this material tiles at 0.55 m or 1.9 m. Applied in metres it would have to
   * be chosen against each material's own scale to guarantee a different phase,
   * and any material later re-tuned would silently drift back into alignment
   * with its neighbours.
   */
  fieldOffset?: THREE.Vector2;
  /**
   * Mirrors the field in object X. A pure translation slides the same pattern
   * along; a mirror changes which way the trails lean, which is what stops two
   * units reading as one asset shifted.
   */
  fieldFlip?: boolean;
}

/**
 * Weathers any MeshStandard/MeshPhysical material using object-space triplanar
 * lookups, so it works on merged geometry with mixed UV layouts.
 *
 * Only valid for objects whose world transform is a translation plus a Y
 * rotation, which is true of every prop in this system: object Y is then world
 * up, and "down" really is down.
 *
 * ## If you are weathering more than one copy of an object, set `fieldOffset`
 *
 * Every lookup here is a function of **object-space position**. Two instances
 * of the same mesh therefore receive byte-identical grime at every point, no
 * matter what else differs between them. That is not a subtlety; it is the
 * whole reason a set of props reads as instanced.
 *
 * It cost a full critic round to learn. The three dispensers each got their own
 * material with its own per-unit strengths — `film: 0.46 * wear`, albedo
 * lightness offsets, per-unit streak heights — and the builder measured a 43%
 * spread in the underlying variation and reported the units as distinct. The
 * critic, seeing only pixels, called them "three copies of one asset,
 * unambiguously", and singled out the tell: *the same streak falls in the same
 * place relative to the panel edge*. Both reads were correct. Amplitude was
 * varying; **position was not**, and position is what the eye uses to decide
 * whether two things are the same object. Measured afterwards on two units
 * photographed from an identical relative pose, the structural difference over
 * the cabinet was 2.3/255 — under 1%, i.e. noise.
 *
 * So: vary the phase, not just the gain. A per-unit `fieldOffset` (plus
 * `fieldFlip`) is a two-line change that does more than any amount of tuning
 * the strengths, and no strength tuning can substitute for it.
 */
export function applyGrime(mat: THREE.MeshStandardMaterial, o: GrimeOptions): void {
  const u = {
    uGField: { value: o.field },
    uGScale: { value: o.scale ?? 1.0 },
    uGOff: { value: (o.fieldOffset ?? new THREE.Vector2(0, 0)).clone() },
    uGFlip: { value: o.fieldFlip ? -1 : 1 },
    uGFilm: { value: o.film ?? 0.35 },
    uGStreak: { value: o.streak ?? 0.0 },
    uGStreakY: { value: o.streakY ?? 0.0 },
    uGStreakFade: { value: o.streakFade ?? 1.0 },
    uGStreakStretch: { value: o.streakStretch ?? 7.0 },
    uGDust: { value: o.dust ?? 0.25 },
    uGSpots: { value: o.spots ?? 0.0 },
    uGFilmCol: { value: (o.filmColor ?? new THREE.Color(0x2a251f)).clone() },
    uGDustCol: { value: (o.dustColor ?? new THREE.Color(0x8d8271)).clone() },
    uGBaseY: { value: o.baseY ?? -1e6 },
    uGBaseFade: { value: o.baseFade ?? 0.25 },
    uGBaseDark: { value: o.baseDark ?? 0.45 },
    uGRough: { value: o.roughGain ?? 1.0 },
    // -1 disables the focus band, which is the default for everything that
    // does not have a single identifiable source of run-off.
    uGFocusX: { value: o.streakFocusX ?? -1 },
    uGFocusHalf: { value: o.streakFocusHalf ?? 0.2 },
    uGScuffC: { value: (o.scuffCentre ?? new THREE.Vector3(0, -1e6, 0)).clone() },
    uGScuffR: { value: o.scuffRadius ?? 0.1 },
    uGScuffA: { value: o.scuffAmount ?? 0.0 },
    uGScuffCol: { value: (o.scuffColor ?? new THREE.Color(0x8e9095)).clone() },
  };
  (mat as unknown as { userData: Record<string, unknown> }).userData.grime = u;

  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vGObj;
        varying vec3 vGNrm;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vGObj = position;
        vGNrm = normal;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uGField;
        uniform float uGScale;
        uniform vec2  uGOff;
        uniform float uGFlip;
        uniform float uGFilm;
        uniform float uGStreak;
        uniform float uGStreakY;
        uniform float uGStreakFade;
        uniform float uGStreakStretch;
        uniform float uGDust;
        uniform float uGSpots;
        uniform vec3  uGFilmCol;
        uniform vec3  uGDustCol;
        uniform float uGBaseY;
        uniform float uGBaseFade;
        uniform float uGBaseDark;
        uniform float uGRough;
        uniform float uGFocusX;
        uniform float uGFocusHalf;
        uniform vec3  uGScuffC;
        uniform float uGScuffR;
        uniform float uGScuffA;
        uniform vec3  uGScuffCol;
        varying vec3 vGObj;
        varying vec3 vGNrm;`
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 gN = normalize(vGNrm);
        vec3 gA = abs(gN);
        // Sampling position. uGFlip mirrors the field in object X and uGOff
        // phases it, so two instances of the same mesh get different dirt
        // rather than identical dirt at different strengths. Only the *field
        // lookups* use this: the height gates below (streakY, baseY) and the
        // scuff centre are real positions on the object and keep using vGObj,
        // or the run-off would start above the nozzle on one unit.
        vec3 gP = vec3(vGObj.x * uGFlip, vGObj.y, vGObj.z);
        // Triplanar pick. One dominant axis rather than a blend: these are
        // hard-surface props, so the seam lands on an actual edge.
        vec2 gUv = (gA.y > max(gA.x, gA.z)) ? gP.xz
                 : ((gA.x > gA.z) ? gP.zy : gP.xy);
        // Offset after the divide, so it is in tile units and independent of
        // whatever this material's scale happens to be.
        vec4 gT = texture2D(uGField, gUv / max(uGScale, 1e-4) + uGOff);

        // Run-off: same field, but squashed vertically so the features become
        // long thin trails instead of blobs.
        float gTan = (gA.x > gA.z) ? gP.z : gP.x;
        vec2 gSUv = vec2(gTan * uGStreakStretch, gP.y) / max(uGScale, 1e-4) + uGOff.yx;
        float gRun = texture2D(uGField, gSUv).g;
        float gBelow = clamp((uGStreakY - vGObj.y) / max(uGStreakFade, 1e-4), 0.0, 1.0);
        // Fades in just under the source and thins out toward the bottom.
        gBelow *= 1.0 - 0.55 * gBelow;
        float gStreak = smoothstep(0.10, 0.62, gRun) * gBelow * uGStreak * (1.0 - gA.y * 0.7);

        // Give the run-off a source. Without this the stain covers the whole
        // cabinet evenly, which reads as a dirty texture rather than as fuel
        // that has run down from one identifiable point.
        if (uGFocusX >= 0.0) {
          float gd = abs(abs(vGObj.x) - uGFocusX);
          gStreak *= 1.0 - smoothstep(uGFocusHalf * 0.45, uGFocusHalf, gd);
        }

        // Contrast the film before scaling it. Multiplying the raw field by a
        // gain only ever produces an even wash: what makes a surface look dirty
        // is that some of it is clean.
        float gFilmRaw = gT.r * (0.55 + gT.a * 0.9);
        float gFilm = smoothstep(0.16, 0.80, gFilmRaw) * uGFilm;
        float gDirt = clamp(gFilm + gStreak, 0.0, 1.0);

        float gUp = clamp(gN.y, 0.0, 1.0);
        float gDust = pow(gUp, 2.2) * clamp(gT.b * 0.7 + gT.r * 0.6, 0.0, 1.0) * uGDust;

        float gSpot = gT.b * uGSpots;

        diffuseColor.rgb = mix(diffuseColor.rgb, uGFilmCol, gDirt);
        diffuseColor.rgb = mix(diffuseColor.rgb, uGDustCol, clamp(gDust, 0.0, 1.0));

        float gBase = clamp((uGBaseY - vGObj.y) / max(uGBaseFade, 1e-4), 0.0, 1.0);
        diffuseColor.rgb *= 1.0 - gBase * gBase * uGBaseDark;

        // Nozzle scuff: an annulus centred on the nozzle's swing, mirrored in X
        // so one uniform serves both faces of the dispenser. Paint is knocked
        // back to bright metal, so this *cleans* rather than dirties.
        vec3 gSc = vec3(abs(vGObj.x), vGObj.y, abs(vGObj.z)) - uGScuffC;
        float gScD = length(gSc);
        float gScuff = uGScuffA
          * (1.0 - smoothstep(uGScuffR * 0.55, uGScuffR, gScD))
          * (0.45 + 0.75 * gT.r);
        gScuff = clamp(gScuff, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, uGScuffCol, gScuff);`
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(
          roughnessFactor + (gDirt * 0.34 + gDust * 0.42 + gSpot * 0.30) * uGRough
            - gScuff * 0.22,
          0.035, 1.0);`
      );
  };

  const base = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${base ? base() : ""}|grime:${o.key}`;
  mat.needsUpdate = true;
}

/**
 * `?force=grime` cranks every grime channel to an absurd value. If the frame
 * does not change, the injection is not reaching the screen and no amount of
 * tuning will help - see NOTES.md.
 */
export function forceGrime(mat: THREE.MeshStandardMaterial): void {
  const u = (mat as unknown as { userData: { grime?: Record<string, { value: unknown }> } }).userData.grime;
  if (!u) return;
  u.uGFilm.value = 1.0;
  u.uGStreak.value = 3.0;
  u.uGDust.value = 2.0;
  u.uGSpots.value = 2.0;
  (u.uGFilmCol.value as THREE.Color).setHex(0xff00ff);
  (u.uGDustCol.value as THREE.Color).setHex(0x00ff00);
  if (u.uGScuffA && (u.uGScuffA.value as number) > 0) {
    u.uGScuffA.value = 1.0;
    (u.uGScuffCol.value as THREE.Color).setHex(0x00ffff);
  }
}

/**
 * `?force=scuff` drives *only* the bare-metal scuff annulus to cyan and leaves
 * every other grime channel where it was.
 *
 * `forceGrime` cranks all of them at once, which proves the injection compiled
 * and is running but says nothing about any individual term: against a frame
 * that is uniformly magenta, an annulus that is doing nothing looks exactly
 * like an annulus that is working. Isolating one channel makes the difference
 * a region diff can see — the point being to compare the panel beside the boot
 * against an untouched control area of the same cabinet in the same frame.
 */
export function forceScuff(mat: THREE.MeshStandardMaterial): void {
  const u = (mat as unknown as { userData: { grime?: Record<string, { value: unknown }> } }).userData.grime;
  if (!u || !u.uGScuffA) return;
  // Deliberately does not force a material that never asked for a scuff: the
  // test is whether the configured annulus reaches the screen, not whether the
  // shader can paint one anywhere.
  if ((u.uGScuffA.value as number) <= 0) return;
  u.uGScuffA.value = 1.0;
  (u.uGScuffCol.value as THREE.Color).setHex(0x00ffff);
}

/* ------------------------------------------------------------------ */
/* surface detail maps                                                  */
/* ------------------------------------------------------------------ */

export interface DetailMaps {
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  tileMetres: number;
}

/**
 * Convert a physical feature size into a noise frequency, and refuse to return
 * one that cannot be represented.
 *
 * `fbm` and `worley` take a frequency in *cycles across the texture*, not per
 * metre, and both will accept more cycles than there are texels. Past that point
 * the lattice is finer than one cell per texel, the result is white noise, and
 * `hsNormal` differentiates white noise into a per-texel stipple. Three of the
 * pump's detail maps shipped like that for several rounds; a critic called the
 * whole cabinet "troweled stucco or sprayed concrete" and ranked it the single
 * worst defect on the unit, and every one of those maps had an expression that
 * *read* like a physical scale — `tileMetres * 700` — while behaving like a
 * lattice size. Raising a tile to cover a bigger panel silently pushed the
 * noise out of band.
 *
 * Four texels per cycle is the floor. That means a 512 map buys 128 cycles, so
 * the finest feature a tile can hold is `tileMetres / 128`: 1.6 mm orange peel
 * needs a tile of 200 mm or less, and 300 mm oil-canning therefore cannot share
 * a map with it. Verified by tools/bandprobe.mjs, which reports the fraction of
 * each field's energy sitting at the top of the spectrum.
 */
function featureFreq(size: number, tileMetres: number, featureMetres: number, what: string): number {
  const f = Math.round(tileMetres / featureMetres);
  const max = Math.floor(size / 4);
  if (f > max) {
    throw new Error(
      `${what}: ${featureMetres * 1000} mm features in a ${tileMetres * 1000} mm tile need ` +
        `${f} cycles, but ${size}px can only carry ${max} (4 texels per cycle). ` +
        `Shrink the tile to ${((max * featureMetres) * 1000).toFixed(0)} mm or coarsen the feature.`
    );
  }
  return Math.max(1, f);
}

/**
 * Powder-coated sheet steel: orange peel from the coating, a scatter of small
 * pits and a few directional scratches. Without the orange peel a painted panel
 * reads as a rendered box no matter what the albedo does.
 *
 * Tile is 0.20 m and not negotiable upward without coarsening the peel — see
 * `featureFreq`. The oil-canning that used to be in here is gone: 300 mm dishing
 * cannot be represented in a tile this small, and it was aliasing rather than
 * appearing.
 */
export function makePaintedSteel(size = 512, tileMetres = 0.20, seed = 4242): DetailMaps {
  const rng = makeRng(seed);
  const ff = (m: number, what: string) => featureFreq(size, tileMetres, m, `makePaintedSteel ${what}`);
  const peel = fbm(size, ff(0.0024, "orange peel"), rng, { octaves: 2, gain: 0.4 });
  const pit = worley(size, ff(0.0035, "pits"), rng);
  const pitGate = fbm(size, ff(0.045, "pit gate"), rng, { octaves: 2 });
  const scratch = fbm(size, ff(0.006, "scratches"), rng, { octaves: 2, ridged: true });
  const scratchGate = fbm(size, ff(0.09, "scratch gate"), rng, { octaves: 2 });
  const grain = fbm(size, ff(0.004, "roll grain"), rng, { octaves: 2 });

  const h = new Float32Array(size * size);
  const r = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const pits = (1 - smoothstep(0.0, 0.30, pit[i])) * smoothstep(0.62, 0.84, pitGate[i]);
    const scr = smoothstep(0.80, 0.97, scratch[i]) * smoothstep(0.52, 0.74, scratchGate[i]);
    h[i] = clamp01(0.5 + (peel[i] - 0.5) * 0.42 - pits * 0.26 + scr * 0.16);
    r[i] = clamp01(0.46 + peel[i] * 0.16 + grain[i] * 0.08 + pits * 0.2 - scr * 0.16);
  }
  // Was 0.85, which on an out-of-band height field was the harshest stipple on
  // the unit. Paint this fine only needs a hint of relief.
  return { normalMap: hsNormal(h, size, 0.30), roughnessMap: hsGray(r, size), tileMetres };
}

/**
 * Semi-gloss painted sheet steel for the dispenser cabinet.
 *
 * Distinct from `makePaintedSteel`, which packs its detail into a 320 mm tile
 * and comes out as uniform high-frequency speckle - stucco, not paint. Three
 * things separate a painted panel from a noisy one:
 *
 *  - the dominant feature is *low* frequency. Oil-canning across a whole panel,
 *    not stipple. Hence the big tile: at 0.9 m one tile spans a cabinet face.
 *  - the roughness sits low and in a narrow band. Semi-gloss is around 0.3;
 *    scattering it from 0.4 to 0.8 destroys the specular response entirely and
 *    that is what makes painted metal read as plaster.
 *  - there is faint directional structure. Sheet steel is rolled and the paint
 *    is sprayed in passes, so there is a horizontal grain you cannot name but
 *    do notice when it is missing.
 */
export function makeCabinetSteel(size = 512, tileMetres = 0.20, seed = 4243): DetailMaps {
  const rng = makeRng(seed);

  // Everything in this map is band-limited, and that is the whole fix.
  //
  // The previous version asked for orange peel at `tileMetres * 640` cycles,
  // which at the old 0.9 m tile was **576 cycles across 512 pixels** — past
  // Nyquist by more than a factor of two, so `gradientNoise` was handing back a
  // lattice finer than one cell per texel. That is not a 1.5 mm ripple, it is
  // white noise, and `hsNormal` differentiates it into a harsh per-texel
  // stipple. A critic reading the render called the cabinet "troweled stucco or
  // sprayed concrete", ranked it the single worst defect on the unit, and was
  // describing aliasing rather than any authored surface.
  //
  // Two consequences worth carrying forward:
  //
  //  - **Orange peel and oil-canning cannot share a tile.** 1.5 mm ripple needs
  //    at least four texels per cycle, so 512 texels buys 512/4 * 1.5 mm = 192
  //    mm of tile. 300 mm dishing does not fit in 192 mm. The tile is now 0.20 m
  //    and carries only the fine paint surface; the oil-canning is gone rather
  //    than aliased, and getting it back needs a second map on a second UV set.
  //  - **`freq` is in cycles per texture, not per metre.** The old expression
  //    read like a physical scale and behaved like a lattice size, so raising
  //    the tile to cover a bigger panel silently pushed the noise past Nyquist.
  const nyq = (freq: number, what: string) => {
    const f = Math.round(freq);
    if (f > size / 4) {
      throw new Error(
        `makeCabinetSteel: ${what} at ${f} cycles needs ${size / 4} or fewer at ${size}px ` +
          `(4 texels per cycle minimum). Past Nyquist this returns white noise, not detail.`
      );
    }
    return f;
  };

  // Orange peel: ~1.6 mm ripple, which at a 0.20 m tile is 125 cycles and sits
  // just inside the limit. Two octaves only — a third would be past it.
  const peel = fbm(size, nyq(tileMetres / 0.0024, "orange peel"), rng, { octaves: 2, gain: 0.4 });
  // Roll marks left in the sheet, ~8 mm, stretched along the panel below.
  const brushSeed = fbm(size, nyq(tileMetres / 0.008, "roll marks"), rng, { octaves: 2 });
  // Which parts of this panel have been rubbed, ~65 mm.
  const wearGate = fbm(size, nyq(tileMetres / 0.065, "wear gate"), rng, { octaves: 2 });
  const scratch = fbm(size, nyq(tileMetres / 0.005, "scratches"), rng, { octaves: 2, ridged: true });

  const h = new Float32Array(size * size);
  const r = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;

      // Directional brushing: features should be *long* in U, so U has to be
      // sampled more slowly than V, not faster. This read `(x * 9) % size`,
      // which samples nine times faster and therefore makes them nine times
      // shorter — the opposite of the stated intent, and it pushed the U
      // direction out of band on its own regardless of the base frequency. It
      // is why bandprobe showed the normal map's X channel aliased while Y was
      // fine: an anisotropy in the *sampling* rather than in the noise.
      const bx = Math.floor(x / 9) % size;
      const brush = brushSeed[y * size + bx];

      h[i] = clamp01(
        0.5 + (peel[i] - 0.5) * 0.34 + (brush - 0.5) * 0.10 + smoothstep(0.88, 0.99, scratch[i]) * 0.12
      );

      // Narrow band around semi-gloss. The only things allowed to lift it are
      // the polishing grain and the odd scuff. Note the *strength* of the
      // resulting specular is not tunable yet — the environment's lower
      // hemisphere is a single constant colour, so there is nothing for it to
      // skate across. This authors the variation and leaves the level alone.
      r[i] = clamp01(
        0.30 + (brush - 0.5) * 0.075 + (peel[i] - 0.5) * 0.05 + smoothstep(0.55, 0.85, wearGate[i]) * 0.06
      );
    }
  }
  // Low normal strength: a strong normal map on a flat painted panel is another
  // way to lose the specular, and peel this fine only needs a hint.
  return { normalMap: hsNormal(h, size, 0.22), roughnessMap: hsGray(r, size), tileMetres };
}

/**
 * Injection-moulded ABS: fine stipple plus mould-flow lines. Used for bezels.
 *
 * 512 rather than 256, because 0.9 mm stipple in a 100 mm tile needs 111 cycles
 * and a 256 map can only carry 64. At 256 this returned hash, which is part of
 * why the bezels and the card reader housing were reported as wearing the same
 * sprayed-concrete surface as the cabinet.
 */
export function makeMouldedPlastic(size = 512, tileMetres = 0.10, seed = 5151): DetailMaps {
  const rng = makeRng(seed);
  const ff = (m: number, what: string) => featureFreq(size, tileMetres, m, `makeMouldedPlastic ${what}`);
  const stipple = worley(size, ff(0.0014, "stipple"), rng);
  const flow = fbm(size, ff(0.016, "mould flow"), rng, { octaves: 2 });
  const scuff = fbm(size, ff(0.0014, "scuff"), rng, { octaves: 2, ridged: true });

  const h = new Float32Array(size * size);
  const r = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    h[i] = clamp01(0.5 + (1 - stipple[i]) * 0.28 + (flow[i] - 0.5) * 0.3);
    r[i] = clamp01(0.62 + (1 - stipple[i]) * 0.16 + flow[i] * 0.08 - smoothstep(0.85, 0.99, scuff[i]) * 0.2);
  }
  // ABS is duller and *finer* than the enamel it sits next to, so its relief
  // stays low even though its roughness is higher.
  return { normalMap: hsNormal(h, size, 0.38), roughnessMap: hsGray(r, size), tileMetres };
}

/* ------------------------------------------------------------------ */
/* bollard: a full albedo set, mapped in cylinder UVs                   */
/* ------------------------------------------------------------------ */

export interface BollardMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  metalnessMap: THREE.DataTexture;
}

/**
 * Safety-yellow bollard sleeve. V runs bottom (0) to top (1) over `heightM`,
 * which lets the paint loss be placed at real heights: rust and splash at the
 * foot, the paint knocked back to bare primer at bumper height, sun-chalked
 * yellow above that.
 */
/**
 * @param impactU Where round the post the traffic-facing arc sits, in UV U.
 *
 * Damage has a direction because cars come from a direction. The previous
 * version had none, and the report was unambiguous: "wrapped uniformly around
 * the full circumference at exactly the same elevation on every bollard in every
 * shot... it reads unmistakably as a printed rust texture applied as a band".
 * Circumferential uniformity is the giveaway on its own, independent of how
 * discrete the chips are.
 */
export function makeBollardSkin(size = 512, heightM = 1.05, seed = 6161, impactU = 0.5): BollardMaps {
  const rng = makeRng(seed);
  const chip = fbm(size, 17, rng, { octaves: 5 });
  const fine = fbm(size, 70, rng, { octaves: 4 });
  const rustField = fbm(size, 9, rng, { octaves: 5 });
  const rustFine = fbm(size, 44, rng, { octaves: 4 });
  // More, smaller cells: real impact damage is a scatter of many small chips,
  // and at 11 cells around the whole circumference only about three of them
  // landed on the struck arc at all.
  const dentCell = worley(size, 26, rng);
  const dentPick = valueNoise(size, 11, rng);
  const drip = fbm(size, 31, rng, { octaves: 4 });
  const grime = fbm(size, 6, rng, { octaves: 4 });

  // Chalked safety yellow, not amber.
  //
  // The previous pair was [0.62, 0.47, 0.06] fresh and [0.55, 0.47, 0.22] faded
  // — 90% saturated and *dark*, and both wrong in the same two ways. A critic
  // reading the render described "a light, warm, semi-translucent amber that
  // appears to be lit from inside — beeswax, honeycomb candle, or amber
  // acrylic", which is what a dark saturated orange does when a warm low sun
  // puts a specular over it: the diffuse is too dark to anchor the highlight, so
  // the highlight looks like emission from within.
  //
  // Two corrections. Value goes up, because chalking is a powder and a powder is
  // a *brighter* diffuser than the gloss it came from — the old faded colour was
  // darker than the fresh one, which is backwards. And saturation comes right
  // down, toward the pale greenish cream that weathered highway yellow actually
  // goes. Fresh paint survives only where the sun does not reach.
  const yellow = [0.70, 0.57, 0.13];
  // Chalked, but still yellow. The previous value went to 0.48 in blue and the
  // read came back "a pale butter/cream, closer to old margarine than to safety
  // yellow", with a good in-frame control attached: the red band on the
  // neighbouring pump shows the dawn light is not shifting hues that far, so the
  // paleness was in the albedo and not in the lighting. Chroma restored; value
  // stays high, because chalking is still a powder.
  const yellowFaded = [0.79, 0.71, 0.35];
  /** Another vehicle's paint, wiped on at bumper height. */
  const transferA = [0.62, 0.63, 0.66];
  const transferB = [0.16, 0.21, 0.34];
  const primer = [0.32, 0.28, 0.26];
  /** Old exposed steel, oxide-grey. */
  const steel = [0.34, 0.335, 0.33];
  /** A chip taken this week: bare rolled steel, bright and slightly blue. */
  const steelFresh = [0.60, 0.61, 0.63];
  const rustA = [0.31, 0.15, 0.07];
  const rustB = [0.47, 0.25, 0.09];
  /** Scab rust standing proud of an old chip, more orange than the bleed. */
  const rustScab = [0.52, 0.28, 0.11];
  const dirt = [0.16, 0.14, 0.11];

  const map = new Uint8Array(size * size * 4);
  const met = new Float32Array(size * size);
  const rgh = new Float32Array(size * size);
  const hgt = new Float32Array(size * size);

  for (let i = 0; i < size * size; i++) {
    const yPix = Math.floor(i / size);
    const xPix = i % size;
    // DataTexture row 0 is V=0, which is the bottom of the cylinder.
    const v = yPix / (size - 1);
    const u = xPix / (size - 1);
    const metres = v * heightM;

    // The traffic-facing arc, wrapping correctly at the UV seam. Falls to zero
    // over roughly 100 degrees either side of `impactU`, so a bit more than half
    // the post can be struck at all and the back is untouched.
    let du = Math.abs(u - impactU);
    if (du > 0.5) du = 1 - du;
    // Tightened, and the exponent flipped from concave to convex. `du / 0.30`
    // reaches zero 108 degrees either side, so 216 degrees of the post could be
    // struck, and `pow(x, 0.75)` then held that arc near full strength almost
    // all the way out — the two together are a soft wash dressed as a
    // direction. Counted in the render of round 195251Z the marks ran 1, 6, 8,
    // 14, 13, 15, 27, 11 across the visible width: a bias, but nothing a viewer
    // would call a struck side.
    const facing = Math.pow(clamp01(1 - du / 0.19), 1.5);

    // Bumper rub band: where a fender or a door actually reaches.
    const bumper = Math.exp(-Math.pow((metres - 0.50) / 0.10, 2)) * facing;
    const kick = Math.exp(-Math.pow((metres - 0.19) / 0.08, 2)) * facing;
    // Kept, but out of the chip decision. It is a smooth field, so it now only
    // drives roughness: a rubbed area is burnished slightly smoother than the
    // chalked paint around it, which is true of the whole contact zone whether or
    // not the topcoat actually failed there.
    const rub = clamp01(bumper * (0.45 + chip[i] * 1.15) + kick * (0.2 + fine[i] * 0.6));
    // How long ago it let go, so fresh chips can show bright steel and old ones
    // an orange scab. Uncorrelated with `wear` on purpose: age of damage and
    // amount of damage are independent, and tying them made the whole band read
    // as one event.
    const chipAge = smoothstep(0.34, 0.66, rustFine[i]);

    // Worley cells, used as *paint chips* only — see the height map below for
    // why they are no longer relief. `1 - smoothstep(0, 0.3, cellDistance)`
    // peaks at each cell centre, so this is a scatter of small round marks.
    // The cell distance is perturbed before it is thresholded, not after.
    //
    // Thresholding the raw Worley distance gives a disc, because that is what a
    // level set of a distance field is, and rendered they came out as a scatter
    // of round dots that read as drilled holes rather than as chipped paint. A
    // chip has a scalloped edge because the coating lets go along whatever line
    // is weakest, so the irregularity has to be in the boundary itself: adding
    // noise to the distance moves the level set in and out, while adding noise to
    // the result afterwards would only fade the disc.
    const edgeBreak = (fine[i] - 0.5) * 0.16 + (rustFine[i] - 0.5) * 0.10;
    const chipSpot =
      (1 - smoothstep(0.0, 0.34, dentCell[i] + edgeBreak)) * smoothstep(0.32, 0.64, dentPick[i]);

    // Where the paint has actually let go, and this has now been wrong twice in
    // opposite directions, which is the useful part.
    //
    // First it was `smoothstep(0.42, 0.78, wear)` — a 0.36-wide ramp on a smooth
    // Gaussian in height — and it airbrushed, exactly as described: "a soft
    // brown band... reads as a scorch mark or a bruise on fruit". So the ramp
    // was narrowed to 0.04 to get a crisp edge. That fixed the softness and
    // introduced something worse: thresholding a *continuous* field hard does
    // not produce chips, it produces a speckle belt at constant height with a
    // hard top and bottom edge, and in render it read as a printed camouflage
    // stripe wrapped round the post.
    //
    // The edge was never the problem on its own. Damage has to be *discrete*
    // before a hard edge helps, so the threshold now runs on the Worley cell
    // field, which is already a scatter of separated round marks, with the
    // bumper and kick heights only biasing *which* cells fire. Hard edge, but on
    // something that comes in lumps.
    // No smooth term in here at all. The `wear * 0.16` that used to be added is
    // the belt: it is a Gaussian in height times low-frequency noise, so it
    // crosses any threshold as a continuous ring, and adding even a small
    // amount of it back reinstates exactly the artefact this is trying to
    // remove. Chips come only from the cell field, biased by height and by which
    // way the post has been hit.
    //
    // The height weights are the other half of the polka-dot fix and they were
    // the larger half. `kick` entered at 1.9 against `bumper`'s 3.0, and with
    // sigmas of 0.11 and 0.13 on a 0.92 m post the two Gaussians overlap into
    // one continuous field from the grout to about 0.75 m. Counted by height
    // band in round 195251Z the marks came out 16, 13, 16, 10, 19, 8, 7, 4, 2,
    // 0 from the foot up: essentially flat across the bottom six bands. That is
    // not damage concentrated at bumper height, it is damage everywhere below
    // the shoulder, which is what makes it read as a speckle pattern rather
    // than as impacts. `kick` is a real thing — bollards do get scuffed at the
    // foot — but it is a minority of the damage, not half of it.
    const paintGone = smoothstep(0.20, 0.27, chipSpot * (0.10 + bumper * 3.0 + kick * 0.45));

    // Rust climbs out of the concrete and follows the paint failures.
    const fromFoot = 1 - smoothstep(0.0, 0.26, metres);
    const rust = clamp01(
      fromFoot * smoothstep(0.32, 0.72, rustField[i]) * 1.25 + paintGone * chipAge * 0.85
    );
    // Rust bleeds *downward out of the chips*, which is the part that was
    // missing: the streak field was previously independent of where the paint
    // had actually failed, so stains appeared under intact paint and chips sat
    // in clean yellow. Gating on the chip field at this pixel's own height band
    // ties every streak to a source above it.
    // The gate has to sample the damage band *above* this pixel, not at it.
    // It sampled `bumper` at the pixel's own height, which worked by accident
    // while the bumper band was wide enough to reach down to where the streaks
    // were; narrowing the band above would have deleted the bleed entirely, a
    // fix in one place silently undoing a feature in another. What a streak
    // needs to know is whether there is a chip source somewhere over it and how
    // far below it now is, so the height term carries the distance and
    // `facing` carries the arc.
    const chipAbove = smoothstep(0.34, 0.62, clamp01(facing * 0.85 + chip[i] * 0.55));
    const below = metres < 0.52 ? smoothstep(0.52, 0.12, metres) : 0;
    const bleed = clamp01(smoothstep(0.55, 0.88, drip[i]) * below * chipAbove * 0.9);

    // Sun bleaches the top third; road film darkens the bottom.
    const sun = smoothstep(0.35, 1.0, v);
    const filth = clamp01((1 - smoothstep(0.0, 0.45, metres)) * (0.4 + grime[i] * 0.9));

    let c = [
      lerp(yellow[0], yellowFaded[0], sun * 0.72),
      lerp(yellow[1], yellowFaded[1], sun * 0.72),
      lerp(yellow[2], yellowFaded[2], sun * 0.72),
    ];
    // What is under the paint depends on how long it has been uncovered: a
    // fresh chip is bright bare steel, an old one has scabbed over, and the
    // deepest ones went through to primer first.
    const under =
      chip[i] > 0.62
        ? primer
        : chipAge < 0.35
          ? steelFresh
          : chipAge > 0.72
            ? rustScab
            : steel;
    c = c.map((x, k) => lerp(x, under[k], paintGone));
    const rc = rustFine[i] > 0.5 ? rustA : rustB;
    c = c.map((x, k) => lerp(x, rc[k], clamp01(rust * 0.85 + bleed * 0.8)));
    // Paint transfer: another vehicle's colour wiped on horizontally at bumper
    // height, on the struck arc only. Sampled with V compressed so the marks
    // stretch *around* the post the way a sliding contact leaves them, which is
    // also the one cue in this map that has an unmistakable direction.
    const smearRow = Math.floor(yPix / 14) * 14;
    const smear =
      smoothstep(0.62, 0.93, drip[smearRow * size + xPix]) * bumper * (0.35 + chip[i] * 0.5);
    const tc = drip[smearRow * size + ((xPix * 3) % size)] > 0.5 ? transferA : transferB;
    c = c.map((x, k) => lerp(x, tc[k], clamp01(smear) * 0.75 * (1 - paintGone)));
    c = c.map((x, k) => lerp(x, dirt[k], filth * 0.6));
    const shade = 0.92 + fine[i] * 0.16 - chipSpot * 0.10;

    const j = i * 4;
    map[j] = Math.round(clamp01(c[0] * shade) * 255);
    map[j + 1] = Math.round(clamp01(c[1] * shade) * 255);
    map[j + 2] = Math.round(clamp01(c[2] * shade) * 255);
    map[j + 3] = 255;

    // Bare steel and rust are the only conductive parts; paint is a dielectric.
    met[i] = clamp01(paintGone * 0.75 * (1 - rust) + rust * 0.18);
    // Chalked paint is powder, and powder is the matte end of the scale. The
    // sun-bleached top of the post therefore has to be *rougher* than the
    // sheltered bottom, not just lighter — without that the two read as one
    // material under a tint, and a chalked surface with a gloss response is
    // half of why the old one looked like acrylic rather than paint.
    rgh[i] = clamp01(
      0.46 + sun * 0.34 + fine[i] * 0.12 + rust * 0.42 + filth * 0.2 - rub * 0.13 * (1 - paintGone)
    );
    // No relief from the Worley cells.
    //
    // They used to drive a 0.55 height drop, which through `hsNormal` at 1.35
    // came out as a scatter of small round craters roughly 40 mm across. In a
    // render they read unmistakably as *blisters pushed out of the paint* —
    // the eye resolves an isolated circular normal disturbance as convex
    // unless something else disambiguates it, and nothing here did. They also
    // now duplicate `pumpParts.bollardDents`, which puts real bumper strikes
    // into the mesh where they cast real occlusion and break the silhouette.
    // A texture cannot do either of those things, so this field keeps only its
    // albedo contribution above and stays out of the relief.
    hgt[i] = clamp01(0.5 + rust * 0.22 + paintGone * 0.08 + fine[i] * 0.1);
  }

  return {
    map: hsTexture(map, size, true),
    normalMap: hsNormal(hgt, size, 1.35),
    roughnessMap: hsGray(rgh, size),
    metalnessMap: hsGray(met, size),
  };
}

/* ------------------------------------------------------------------ */
/* tyre                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tread + sidewall relief for a passenger tyre. U wraps the circumference,
 * V runs across the tread from one sidewall to the other.
 */
export function makeTyreSkin(size = 512, seed = 7171): DetailMaps & { map: THREE.DataTexture } {
  const rng = makeRng(seed);
  const rubber = fbm(size, 150, rng, { octaves: 3 });
  const scuff = fbm(size, 40, rng, { octaves: 4 });
  const dust = fbm(size, 7, rng, { octaves: 4 });

  const h = new Float32Array(size * size);
  const r = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    const u = (i % size) / size; // around the circumference
    const v = Math.floor(i / size) / size; // across the tread

    // Tread band occupies the middle ~62%, sidewalls the rest.
    const acrossTread = clamp01((v - 0.19) / 0.62);
    const onTread = v > 0.19 && v < 0.81;

    let relief = 0.5;
    if (onTread) {
      // Four circumferential grooves, the two outer ones wider.
      const grooveV = [0.06, 0.34, 0.66, 0.94];
      let groove = 0;
      for (let g = 0; g < 4; g++) {
        const w = g === 0 || g === 3 ? 0.045 : 0.032;
        groove = Math.max(groove, 1 - smoothstep(0.0, w, Math.abs(acrossTread - grooveV[g])));
      }
      // Lateral sipes, pitched at three different spacings so the tread does
      // not hum as a single frequency - real tyres randomise the pitch for
      // exactly this reason, and it kills the moire too.
      const pitch = 46 + Math.round(Math.sin(acrossTread * 3.1) * 5);
      const lat = Math.abs(((u * pitch) % 1) - 0.5) * 2;
      const shoulder = smoothstep(0.0, 0.35, Math.min(acrossTread, 1 - acrossTread));
      const sipe = (1 - smoothstep(0.72, 0.92, lat)) * (0.35 + 0.65 * (1 - shoulder));
      relief = 0.78 - groove * 0.62 - sipe * 0.22 + rubber[i] * 0.06;
    } else {
      // Sidewall: the raised lettering ring and the moulding flash line.
      const side = v < 0.19 ? v / 0.19 : (1 - v) / 0.19;
      const ring = Math.exp(-Math.pow((side - 0.58) / 0.09, 2)) * 0.16;
      const flash = Math.exp(-Math.pow((side - 0.12) / 0.03, 2)) * 0.1;
      relief = 0.46 + ring + flash + rubber[i] * 0.05;
    }
    h[i] = clamp01(relief);

    const sc = smoothstep(0.55, 0.85, scuff[i]);
    // SHARED WITH THE PUMPS: the bollards read from this same skin, so a
    // change here moves them too. The sidewall dust used to run to 0.85 over a
    // strongly warm ramp, which took carbon black up to a tan almost exactly
    // matching the dispenser cabinets. Rubber is near-black with a *grey*
    // cast, so the load is halved and the ramp below is neutral.
    const dusty = clamp01(dust[i] * 0.8) * (onTread ? 0.25 : 0.45);
    // Sidewalls are matte and browned by road dust; the tread crown is polished
    // by the road and picks up a faint sheen.
    r[i] = clamp01(0.93 - (onTread ? acrossTread * (1 - acrossTread) * 0.5 : 0.0) - sc * 0.05 + dusty * 0.04);

    const base = 0.055 + rubber[i] * 0.02;
    const c = [
      base + dusty * 0.1 + sc * 0.02,
      base + dusty * 0.1 + sc * 0.02,
      base + dusty * 0.105 + sc * 0.02,
    ];
    // These are reflectances, and the map is tagged sRGB, so they have to be
    // encoded on the way in.
    //
    // They were written straight to bytes, which meant the renderer decoded
    // 0.055 as sRGB and handed the shader **0.0043 linear** — six times under
    // carbon black. The car measured the consequence rather than the cause:
    // its tyres rendered at a median of 0 out of 255 over 105416 px, IQR 0.1.
    // Not dark, clipped. Every piece of sidewall relief, bead ring and
    // lettering added over several rounds had been added to a hole, and no
    // lighting or roughness work on top of it could ever have shown.
    //
    // `CarSystem` carries a 5.4x compensation on `color` for this, added when
    // the fault was known but this file was not the car's to edit. **That
    // multiplier is now a double correction and must be removed.**
    const j = i * 4;
    alb[j] = Math.round(clamp01(linearToSrgb(c[0])) * 255);
    alb[j + 1] = Math.round(clamp01(linearToSrgb(c[1])) * 255);
    alb[j + 2] = Math.round(clamp01(linearToSrgb(c[2])) * 255);
    alb[j + 3] = 255;
  }

  return {
    map: hsTexture(alb, size, true),
    normalMap: hsNormal(h, size, 2.2),
    roughnessMap: hsGray(r, size),
    tileMetres: 1,
  };
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Axis-aligned box with rounded arrises, built as a subdivided cube projected
 * onto a superellipsoid. Sharper than `RoundedBoxGeometry` about which edges
 * stay crisp, and it comes out with usable box UVs.
 *
 * A dispenser cabinet with mathematically sharp corners is one of the loudest
 * CG tells there is: pressed sheet steel always carries a few millimetres of
 * radius that catches the sun as a bright line.
 */
export function roundedBox(w: number, h: number, d: number, r: number, seg = 3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const rad = Math.min(r, hx * 0.9, hy * 0.9, hz * 0.9);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Pull each coordinate in by the radius, clamp to the inner box, then push
    // back out along the normalised offset: an exact rounded box.
    const cx = THREE.MathUtils.clamp(v.x, -(hx - rad), hx - rad);
    const cy = THREE.MathUtils.clamp(v.y, -(hy - rad), hy - rad);
    const cz = THREE.MathUtils.clamp(v.z, -(hz - rad), hz - rad);
    const ox = v.x - cx;
    const oy = v.y - cy;
    const oz = v.z - cz;
    const len = Math.hypot(ox, oy, oz);
    if (len > 1e-6) {
      const s = rad / len;
      pos.setXYZ(i, cx + ox * s, cy + oy * s, cz + oz * s);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Box with sharp edges but a real UV set, for panels and small parts. */
export function panelBox(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/**
 * A hose of a given slack length hanging between two fittings with a heavy
 * nozzle on one end.
 *
 * This solves the actual catenary rather than drooping a lerp, because the
 * previous approach - offset the chord by a symmetric cosh - produces a shape
 * whose low point always sits at the midpoint. On a real dispenser the two ends
 * are at different heights and there is a 1.5 kg nozzle on one of them, so the
 * low point sits well off centre, toward the nozzle. That asymmetry is the
 * whole tell: a symmetric loop reads as bent conduit no matter how good the
 * material is.
 *
 * Given horizontal run `h`, height difference `v` and arc length `L`, the
 * catenary parameter `a` satisfies  sqrt(L^2 - v^2) = 2a sinh(h / 2a), which is
 * solved below by bisection. The nozzle's point load is then added as an extra
 * sag term skewed toward the loaded end.
 */
export function hangingHose(
  from: THREE.Vector3,
  fromDir: THREE.Vector3,
  to: THREE.Vector3,
  toDir: THREE.Vector3,
  length: number,
  opts: { seed?: number; samples?: number; nozzleLoad?: number; stiffness?: number } = {}
): THREE.CatmullRomCurve3 {
  const seed = opts.seed ?? 1;
  const samples = opts.samples ?? 56;
  const load = opts.nozzleLoad ?? 0.10;
  const stiff = opts.stiffness ?? 0.14;

  // Stiff lead-outs. Fuel hose is reinforced, so it leaves a fitting along the
  // fitting's own axis for a decent distance before gravity wins.
  const a3 = from.clone().addScaledVector(fromDir.clone().normalize(), stiff);
  const b3 = to.clone().addScaledVector(toDir.clone().normalize(), stiff * 0.85);

  const dx = b3.x - a3.x;
  const dz = b3.z - a3.z;
  const h = Math.hypot(dx, dz);
  const v = b3.y - a3.y;

  // Slack available between the lead-out points.
  const span = Math.max(0.05, length - stiff * 1.85);
  const chord = Math.hypot(h, v);
  const L = Math.max(chord * 1.03, span);

  // Bisect for the catenary parameter. f(a) = 2a sinh(h/2a) is monotonically
  // decreasing in a, from +inf down to h.
  const target = Math.sqrt(Math.max(1e-6, L * L - v * v));
  let lo = 1e-4;
  let hi = 60;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (2 * mid * Math.sinh(h / (2 * mid)) > target) lo = mid;
    else hi = mid;
  }
  const aPar = (lo + hi) / 2;

  // Horizontal offset of the vertex, i.e. where the low point actually falls.
  const x0 = h / 2 - aPar * Math.atanh(THREE.MathUtils.clamp(v / L, -0.999, 0.999));

  // seededRng, not makeRng: callers seed sibling hoses from adjacent integers
  // (`hoseSeed + 7` and `hoseSeed + 19` for the two faces of one dispenser) and
  // the first three draws are all shape-determining. Under makeRng the whole
  // forecourt shared a kink phase — see NOTES.md case 16.
  const rng = seededRng(seed);
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const kink = 0.016 + rng() * 0.014;
  // One real kink, as distinct from the two sine waves below.
  //
  // A critic asked for "small kinks" and the sines are not kinks: they are a
  // smooth undulation over the whole run, which is why the hose read as an
  // extruded tube however the amplitude was set. A kink is *local* — a hose that
  // has been folded once keeps a tight bend a few centimetres wide for the rest
  // of its life. So: a narrow Gaussian, placed away from both ferrules, with
  // several times the sines' amplitude over a twentieth of their extent.
  const kAt = 0.30 + rng() * 0.40;
  const kAmp = (0.028 + rng() * 0.022) * (rng() < 0.5 ? -1 : 1);
  const kWide = 0.055 + rng() * 0.030;

  const side = new THREE.Vector3(-dz, 0, dx).normalize();
  if (!isFinite(side.x) || side.lengthSq() < 0.5) side.set(1, 0, 0);

  const y0 = aPar * Math.cosh(-x0 / aPar);

  const pts: THREE.Vector3[] = [from.clone(), a3.clone()];
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const s = t * h;
    const p = new THREE.Vector3(
      a3.x + (dx * s) / (h || 1),
      a3.y + aPar * Math.cosh((s - x0) / aPar) - y0,
      a3.z + (dz * s) / (h || 1)
    );

    // Point load at the nozzle: peaks about two thirds along, which drags the
    // belly of the loop toward the loaded end.
    p.y -= load * Math.pow(t, 1.7) * (1 - t) * 4.4;

    // A couple of lazy kinks left by whoever hung it up last. Damped at the
    // ends so they never fight the lead-outs.
    const env = Math.sin(Math.PI * t);
    p.addScaledVector(side, Math.sin(t * 4.3 + p1) * kink * env);
    p.y += Math.sin(t * 7.1 + p2) * kink * 0.35 * env;
    // The kink. Displaced across the run and slightly up, because a fold leaves
    // the hose shorter through the bend and it rides.
    const kg = Math.exp(-(((t - kAt) / kWide) ** 2));
    p.addScaledVector(side, kAmp * kg * env);
    p.y += Math.abs(kAmp) * kg * env * 0.45;
    pts.push(p);
  }
  pts.push(b3.clone(), to.clone());

  return new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.4);
}

/**
 * A hose hanging under its own weight with a nozzle on the end.
 *
 * A perfect circular arc is the classic giveaway; so is a straight line. Real
 * fuel hose is stiff, so it leaves each fitting close to the fitting's own
 * axis, sags on a catenary in the middle, and carries a couple of lazy kinks
 * left over from the last person who hung it up.
 *
 * @deprecated Symmetric: the low point is always at the midpoint. Use
 * `hangingHose`, which solves the real catenary for a given slack length.
 */
export function hoseCurve(
  from: THREE.Vector3,
  fromDir: THREE.Vector3,
  to: THREE.Vector3,
  toDir: THREE.Vector3,
  sag: number,
  seed = 1,
  samples = 40
): THREE.CatmullRomCurve3 {
  // Stiff lead-outs: the hose holds the fitting's direction for ~120 mm.
  const a = from.clone().addScaledVector(fromDir.clone().normalize(), 0.13);
  const b = to.clone().addScaledVector(toDir.clone().normalize(), 0.16);

  const k = 1.9;
  const coshK = Math.cosh(k);
  const amp = sag / (1 - 1 / coshK);

  const rng = seededRng(seed);
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const kink = 0.028 + rng() * 0.02;

  // Perpendicular frame for the kinks, built off the chord.
  const chord = b.clone().sub(a);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(chord, up).normalize();
  if (!isFinite(side.x)) side.set(1, 0, 0);

  const pts: THREE.Vector3[] = [from.clone(), a.clone()];
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const p = a.clone().lerp(b, t);
    // Catenary droop, zero at both ends.
    p.y += (Math.cosh(k * (t * 2 - 1)) / coshK - 1) * amp;
    // Two out-of-plane wanders and a slight vertical stiffening near the ends,
    // which is what stops it reading as an extruded parabola.
    const env = Math.sin(Math.PI * t);
    p.addScaledVector(side, Math.sin(t * 5.1 + p1) * kink * env);
    p.y += Math.sin(t * 8.3 + p2) * kink * 0.45 * env;
    pts.push(p);
  }
  pts.push(b.clone(), to.clone());

  const c = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.4);
  return c;
}

/**
 * Replaces a geometry's UVs with a metre-scale triplanar projection in object
 * space, so a detail map keeps the same physical size on a 1.06 m cabinet
 * panel, a 30 mm keycap and a 9 mm bolt head.
 *
 * Primitive UVs are normalised per face, which means a shared detail map comes
 * out three times bigger on the big panel than on the small one - and the eye
 * reads that instantly as "these are separate objects with separate textures".
 * The material's map repeat then has to be 1 / tileMetres.
 */
export function metreUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else if (ax >= az) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Fill in any attribute a merge target needs but a primitive is missing, and
 * normalise the index buffer.
 *
 * `mergeGeometries` requires the whole list to agree on *three* things, not
 * two: the attribute set, the morph set, and whether the geometry is indexed.
 * The third was missed here, and it is the one that differs in practice:
 * `ExtrudeGeometry` (the chamfered cabinet prisms) is non-indexed, while every
 * `BoxGeometry` / `CylinderGeometry` / `TubeGeometry` primitive is indexed, so
 * any list mixing the two failed with nothing but "geometry at index N".
 *
 * Normalising *towards indexed* rather than de-indexing: adding an identity
 * index is exactly lossless — not one vertex, normal or UV is touched, and the
 * triangle order is unchanged — whereas `toNonIndexed()` rewrites and expands
 * every attribute buffer of the majority of these geometries. It is also the
 * cheaper direction in memory here, since most merge lists are dominated by
 * already-indexed primitives.
 */
export function ensureAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const n = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  g.deleteAttribute("uv1");
  g.deleteAttribute("uv2");
  if (!g.getIndex()) {
    const n = g.getAttribute("position").count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/** One-line description of what a geometry brings to a merge. */
function describeGeometry(g: THREE.BufferGeometry): string {
  const attrs = Object.keys(g.attributes).sort();
  const morphs = Object.keys(g.morphAttributes ?? {}).sort();
  return (
    `verts=${g.getAttribute("position")?.count ?? 0} ` +
    `${g.getIndex() ? `indexed(${g.getIndex()!.count})` : "NON-INDEXED"} ` +
    `attrs=[${attrs.join(",")}]` +
    (morphs.length ? ` morphs=[${morphs.join(",")}]` : "") +
    ` groups=${g.groups.length}`
  );
}

/**
 * `mergeGeometries` that says *why* it failed.
 *
 * three.js only ever logs "failed with geometry at index N" and returns null,
 * which cost this project a dead startup and several agent-hours. On failure
 * this dumps every geometry in the list against the first one so the odd
 * member — mismatched attribute set, morph set, or indexed-ness — is visible
 * in the first console line.
 */
export function mergeChecked(
  label: string,
  list: THREE.BufferGeometry[],
  useGroups = false
): THREE.BufferGeometry {
  if (list.length === 0) throw new Error(`${label}: merge failed (empty list)`);
  const out = mergeGeometries(list, useGroups);
  if (out) return out;

  const ref = list[0];
  const refAttrs = Object.keys(ref.attributes).sort().join(",");
  const refIndexed = !!ref.getIndex();
  const bad: number[] = [];
  const lines = list.map((g, i) => {
    const attrs = Object.keys(g.attributes).sort().join(",");
    const differs = attrs !== refAttrs || !!g.getIndex() !== refIndexed;
    if (differs) bad.push(i);
    return `  [${i}]${differs ? " <-- MISMATCH" : "        "} ${describeGeometry(g)}`;
  });
  console.error(
    `${label}: mergeGeometries failed over ${list.length} geometries.\n` +
      `  reference [0]: attrs=[${refAttrs}] ${refIndexed ? "indexed" : "NON-INDEXED"}\n` +
      lines.join("\n")
  );
  throw new Error(
    `${label}: merge failed (mismatched attributes) at ` +
      (bad.length ? `index ${bad.join(", ")}` : "an index three.js did not report") +
      ` of ${list.length}; see console for the per-geometry table`
  );
}

/** Transform a geometry in place and return it, for terse assembly code. */
export function place(
  g: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0
): THREE.BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return ensureAttrs(g);
}

/**
 * The alpha profile of a run-down stain, shared by every weep on every pump.
 *
 * One 32 x 64 single-channel texture for the whole system. Its only job is to
 * be soft: the defect it replaces was a hard-edged rectangle, and a rectangle
 * with correct values is still a rectangle (the same lesson as the shut-line
 * ribbon and the bright lip before it — see the notes in `pumpParts`).
 *
 * Across the width, a cosine bell so the run has no sides. Along the length,
 * left to the geometry's vertex alpha, because that is where the per-stain
 * strength lives. On top, a few vertical filaments at two frequencies, because
 * a real run separates into threads as it dries and a single smooth plume reads
 * as an airbrush.
 */
export function makeWeepMask(w = 32, h = 64, seed = 8317): THREE.DataTexture {
  const rng = seededRng(seed);
  // Per-column filament weight, so the threads run the length of the stain
  // instead of being resampled every row.
  const fil = new Float32Array(w);
  for (let x = 0; x < w; x++) fil[x] = 0.55 + rng() * 0.45;
  // RGBA with the value in every channel, not `RedFormat`.
  //
  // `MeshStandardMaterial`'s `alphamap_fragment` chunk is
  // `diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g`, and sampling an R8
  // texture yields `(r, 0, 0, 1)` — so a single-channel mask used as an
  // `alphaMap` multiplies alpha by **zero** and the material is fully
  // transparent everywhere. It compiles, it binds, it costs texture memory, and
  // it renders nothing.
  //
  // That is what the pump stain was doing for its entire life, underneath a
  // separate bug that had it buried behind its own panel. Two independent
  // reasons to be invisible in one small mesh is why "make the alpha stronger"
  // could never have worked, and why three rounds of A/B against it read as a
  // weak effect: a null result has no shape, so two causes look like one.
  //
  // `grayTexture` in `src/gen/textures.ts` already wrote all four channels for
  // terrain's alphaMap. The precedent existed and this file did not follow it.
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Bell across the width, raised to widen the shoulder as it descends: a
      // run spreads, so the edges must get softer rather than just wider.
      const bell = Math.pow(Math.max(0, Math.cos((u - 0.5) * Math.PI)), 1.25 + v * 0.9);
      // Filaments, fading in as the run breaks up further down.
      const thread = 1 - (1 - fil[x]) * (0.25 + v * 0.75);
      // Mottle, do not attenuate.
      //
      // This was `* 0.86` with a bell and a thread term that already sat well
      // below 1, giving the mask a mean of 0.40 and a peak of 0.80. Multiplied
      // into a vertex alpha whose own mean was a healthy 0.247, the effective
      // opacity was 0.09 — so the mask was spending most of the strength that
      // `groundAccum` had been carefully composed to provide. **A mask's job is
      // to vary a quantity, not to reduce it**; the physical profile belongs to
      // the vertex alpha, which is where it is measured and capped. Normalised
      // so the peak reaches 1 and the floor stays low enough to break up the
      // shape.
      const a = 0.30 + 0.70 * bell * thread;
      const b = Math.round(clamp01(a) * 255);
      const o = (y * w + x) * 4;
      data[o] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = b;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // No colour space tag: this is a mask, not a colour, and tagging it sRGB
  // would silently gamma-decode an alpha ramp. See `tools/albedoaudit.mjs`.
  return tex;
}

/**
 * Turn a `TubeGeometry` into a length of used fuel hose, in place.
 *
 * An independent critic's third complaint was that the hose and nozzle "look too
 * smooth and plastic, lacking small kinks, scuffs and material variation", and
 * the source agreed with it precisely: the hose was a perfectly circular tube of
 * constant radius, drawn in one material, with its only irregularity two smooth
 * sine waves along the centreline. Two sine waves at 16 to 30 mm are an
 * *undulation*, not a kink — a kink is local, and it flattens the section where
 * it happens.
 *
 * So three things, none of which needs a texture, a draw call or a new material:
 *
 * 1. **The section is no longer a circle.** A `cos(2 theta)` term ovalises it,
 *    with the oval's phase rotating slowly along the run, which is what a hose
 *    that has been coiled the same way for years actually does. Amplitude is
 *    modulated so it is strongest in the belly of the loop and vanishes into
 *    the ferrules, where the crimp holds the section round.
 * 2. **A helical rib**, because reinforced hose carries the impression of its
 *    braid. One turn every ~90 mm at 0.55 mm — small, but it is the cue that
 *    separates rubber from extruded tube, and it is the only thing here that
 *    survives to the `hose` pose at any exposure.
 * 3. **Scuff and bleach as vertex colour**, which is free. The underside of the
 *    belly is where a hose is dragged over concrete: it goes chalky and pale.
 *    The top face is where the sun hits it and it bleaches, less than the scuff
 *    and in a different direction. Both are mottled by a hash rather than being
 *    clean gradients, because a clean gradient is its own tell.
 *
 * Requires the caller's `radialSegments` and `tubularSegments` because
 * `TubeGeometry` does not keep them, and the (ring, spoke) indices are what make
 * this cheap: vertex `i * (radial + 1) + j`, so both coordinates are recoverable
 * without any geometric search.
 */
/**
 * Wear driven by shape, for parts that have no run to distribute it along.
 *
 * The hose got scuff because a tube has a natural coordinate system: ring index
 * is "along", spoke index is "around", and the underside of the belly is where a
 * hose is dragged. The nozzle has neither, and it was left smooth and evenly
 * tinted while the hose beside it gained variation — the critic's "smooth and
 * plastic" applies to both, and only half of it was answered.
 *
 * What replaces the missing coordinate is that **contact wear lands on convex
 * extremities**. Nothing rubs the inside of the trigger recess or the shadowed
 * face where the casting meets the swivel; everything rubs the spout tip, the
 * outer curve of the guard and the corner of the body that meets the boot lip.
 * Both halves of that are needed and neither is sufficient:
 *
 * - `reach`, how far the vertex is from the part's centroid, normalised to the
 *   furthest. Alone it would wear the inside of a deep pocket at the same rate
 *   as the boss beside it, since both are equally far out.
 * - `align`, how much the surface normal agrees with the outward direction from
 *   the centroid. This is a cheap local convexity: on a boss the normal points
 *   away from the centre, in a recess it points back toward it. Alone it would
 *   wear the whole outer shell evenly, which is the uniformity being escaped.
 *
 * The product concentrates on prominences, and the hash breaks it up so it does
 * not read as a clean radial gradient — a smooth falloff from a centroid is a
 * procedural tell as legible as no variation at all.
 *
 * Writes an itemSize-3 colour attribute, so **the material needs
 * `vertexColors: true` or this is discarded silently.** Returns `geo` for
 * chaining at the call site.
 */
export function scuffProminence(
  geo: THREE.BufferGeometry,
  seed = 1,
  amount = 1
): THREE.BufferGeometry {
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  const n = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!p || !n) return geo;
  const N = p.count;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < N; i++) {
    cx += p.getX(i);
    cy += p.getY(i);
    cz += p.getZ(i);
  }
  cx /= N;
  cy /= N;
  cz /= N;

  let maxR = 1e-6;
  const rs = new Float32Array(N);
  const al = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dx = p.getX(i) - cx;
    const dy = p.getY(i) - cy;
    const dz = p.getZ(i) - cz;
    const r = Math.hypot(dx, dy, dz);
    rs[i] = r;
    if (r > maxR) maxR = r;
    al[i] = r > 1e-6 ? (dx * n.getX(i) + dy * n.getY(i) + dz * n.getZ(i)) / r : 0;
  }

  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const reach = Math.pow(rs[i] / maxR, 1.7);
    const align = Math.max(0, al[i]);
    const frac = (v: number) => v - Math.floor(v);
    const mottle =
      0.55 +
      0.45 *
        frac(
          Math.sin(
            (p.getX(i) * 71.3 + p.getY(i) * 113.7 + p.getZ(i) * 47.9 + seed * 0.137) * 43758.5453
          ) * 1000
        );
    const prom = reach * align * mottle;
    // Rubbed coating goes pale and slightly desaturated toward the substrate
    // rather than simply brighter, so the blue channel lifts hardest.
    const g = 1 + prom * 0.30 * amount;
    col[i * 3] = g;
    col[i * 3 + 1] = g + prom * 0.012 * amount;
    col[i * 3 + 2] = g + prom * 0.030 * amount;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

export function weatherHose(
  geo: THREE.BufferGeometry,
  tubular: number,
  radial: number,
  radius: number,
  seed = 1
): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const expect = (tubular + 1) * (radial + 1);
  if (!nor || pos.count !== expect) {
    // Layout is not what this assumes, so do nothing rather than corrupt it.
    // Silence here would be the bug: a no-op that looks like a pass.
    console.warn(`[weatherHose] expected ${expect} vertices, got ${pos.count} — skipped`);
    return geo;
  }
  const fract01 = (v: number) => v - Math.floor(v);
  const rng = seededRng(seed);
  const ovalPhase = rng() * Math.PI * 2;
  const ovalTwist = 2.1 + rng() * 2.4;
  const ribPhase = rng() * Math.PI * 2;
  const scuffPhase = rng() * 10;

  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    // Zero at both ferrules, full in the belly. A crimped end is round.
    const env = Math.sin(Math.PI * t);
    const oval = 0.11 * radius * env;
    for (let j = 0; j <= radial; j++) {
      const vi = i * (radial + 1) + j;
      const th = (j / radial) * Math.PI * 2;
      p.fromBufferAttribute(pos, vi);
      n.fromBufferAttribute(nor, vi);

      // Ovalised section, phase rotating along the run.
      const d = oval * Math.cos(2 * (th + ovalPhase + t * ovalTwist));
      // Helical rib: one turn per ~90 mm of hose.
      const rib = 0.00055 * Math.cos(th + ribPhase + t * tubular * 0.52);
      p.addScaledVector(n, d + rib);
      pos.setXYZ(vi, p.x, p.y, p.z);

      // Mottle, so neither wear pattern is a clean ramp.
      const m = fract01(Math.sin((i * 12.9898 + j * 78.233 + scuffPhase) * 1.0) * 43758.5453);
      // Dragged on concrete: the underside of the belly, chalky and pale.
      const down = Math.max(0, -n.y);
      const scuff = clamp01(down * down * env * env * (0.55 + m * 0.9)) * 0.85;
      // Sun-bleached on top, weaker and in the other direction.
      const bleach = clamp01(Math.max(0, n.y) * (0.4 + m * 0.5)) * 0.30;
      // Vertex colour multiplies albedo, so these are gains on a near-black
      // rubber. Scuff also desaturates, which is why it lifts blue most.
      const g = 1 + scuff * 1.9 + bleach * 0.55;
      col[vi * 3] = g * (1 - scuff * 0.06);
      col[vi * 3 + 1] = g;
      col[vi * 3 + 2] = g * (1 + scuff * 0.10);
    }
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
