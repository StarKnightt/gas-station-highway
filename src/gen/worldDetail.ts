import * as THREE from "three";

/**
 * How a surface consumes the soil field. The field itself is built once in
 * `gen/groundSoil.ts`; this is only the per-material half of the contract.
 */
export interface SoilDetail {
  /** RGBA world-space field: R drainage, G disturbance, B wetness, A material. */
  field: THREE.Texture;
  /** World-space min corner (x, z) of the field. */
  origin: THREE.Vector2;
  /** World-space span (x, z) of the field. */
  size: THREE.Vector2;

  /**
   * The second soil material, blended in by the field's A channel. Supplying a
   * different `altMetres` from the base tile is deliberate: two incommensurate
   * periods break a repeat far better than a rotated copy of one period does.
   */
  altMap?: THREE.Texture;
  altNormalMap?: THREE.Texture;
  altRoughnessMap?: THREE.Texture;
  /** World metres per tile of the alternate soil maps. */
  altMetres?: number;

  /**
   * Standing water, clipped per pixel against the fragment's world Y rather
   * than baked into the field. At most four; see `wdPool`. Omit on a surface
   * that cannot hold water and no pool uniforms are emitted.
   */
  pools?: { x: number; z: number; rx: number; rz: number; level: number }[];

  /** Strength of the drainage / disturbance colour organisation. */
  gain?: number;
  /** Strength of the wet arm. 0 disables it entirely (`?tforce=nowet`). */
  wet?: number;
  /**
   * Floor under the wetness, so `?tforce=wetmax` can flood the whole site. A
   * multiplier cannot do this: the field is zero over most of the ground and
   * anything times zero is zero, so a "force it on" switch built from `wet`
   * alone would return a byte-identical capture and be read as "the feature is
   * not mine" (NOTES.md case 25).
   */
  wetFloor?: number;
  /**
   * Residual dampness left over the whole surface by rain that has stopped,
   * before drainage is taken into account. The field's wet channel answers
   * "where does water collect"; this answers "what did the rain land on", which
   * for a lot that was rained on last night is all of it. Modulated in the
   * shader by drainage and by a slow patchy dry-off, so it is not a flat tint.
   */
  wetBase?: number;
  /** Debug: render the field's own channels to albedo (`?tforce=soilviz`). */
  viz?: boolean;
}

export interface WorldDetailOptions {
  key: string;

  /** Very low frequency tiling noise, sampled in world XZ. */
  macro: THREE.Texture;
  /** World metres per macro tile. */
  macroMetres: number;
  /** How strongly macro noise multiplies albedo (0..1). */
  macroAlbedo?: number;
  /** How strongly macro noise offsets roughness (0..1). */
  macroRoughness?: number;

  /** Non-repeating RGBA overlay covering the whole site, sampled in world XZ. */
  overlay?: THREE.Texture;
  /** World-space min corner (x, z) of the overlay. */
  overlayOrigin?: THREE.Vector2;
  /** World-space size (x, z) of the overlay. */
  overlaySize?: THREE.Vector2;
  /** Colour the overlay's B channel tints toward (oil / tar). */
  overlayTint?: THREE.Color;
  /** Scales how strongly the site overlay reads on this material. */
  overlayGain?: number;

  /**
   * The overlay's A channel is shoulder material washed over the pavement.
   * Supplying the dirt maps here makes that wash real gravel rather than a flat
   * brown tint, which is what stops the paved footprint reading as a sticker.
   */
  washMap?: THREE.Texture;
  /** World metres per tile of `washMap`. */
  washMetres?: number;
  /** Scales the wash (0 disables it). */
  washGain?: number;

  /**
   * Wheel-path polish applied analytically in world Z, so it covers the whole
   * 680 m of highway rather than only the part the baked overlay reaches.
   * Values are lane wheel-path centres in world Z.
   */
  wheelPaths?: number[];
  /** Only apply wheel paths where |world z| is below this. */
  /** Z range the wheel term applies over, e.g. the carriageway or a drive aisle. */
  wheelBand?: [number, number];
  /** A second, independent set of tracks: the site's drive aisle. */
  wheelPathsB?: number[];
  wheelBandB?: [number, number];
  /** Strength of the analytic wheel-path polish. */
  wheelStrength?: number;
  /** Albedo multiplier at the centre of a wheel path. */
  wheelDark?: number;
  /** Debug: render the raw wheel-path mask instead of the surface. */
  wheelViz?: boolean;
  /** Relief of the surface underneath, so paint can pool in the voids. */
  voidMap?: THREE.Texture;
  /** Metres covered by one tile of voidMap. */
  voidMetres?: number;

  /**
   * Erodes the alpha of a painted marking with world-space grain, so the edge
   * of a stripe follows the aggregate instead of being a straight vector cut.
   */
  erodeAlpha?: number;

  /**
   * Breaks the readable repeat of the detail tile by cross-fading a second,
   * rotated and rescaled sample of the same albedo/roughness maps. Without it
   * a 17 m dirt tile reads as a grid of identical blobs from 40 m up.
   */
  antiTile?: number;

  /**
   * Fades the normal map out with distance so aggregate stops being gravel by
   * the far field. Diagnostic only: `false` holds it at full strength, which is
   * what a nadir tiling scan needs — at 60 m the fade has removed most of the
   * bump, so a scan taken with it on measures the albedo while claiming to
   * measure the bump.
   */
  normalFade?: boolean;

  /**
   * The world-space soil field (see `gen/groundSoil.ts`), which organises the
   * ground by drainage, disturbance, wetness and material instead of by free
   * noise. Absent on every material that does not pass it, so no uniform and
   * no GLSL is emitted and those programs are unchanged.
   */
  soil?: SoilDetail;

  /**
   * Scales ONLY the specular image-based lighting. Large near-horizontal
   * surfaces reflect the whole bright dawn horizon at grazing angles, which
   * turns dark asphalt into a mirror.
   */
  specularEnv?: number;
  /**
   * Scales the direct specular response (both F0 and the grazing F90 ramp).
   * GGX over-predicts grazing reflectance on very rough natural surfaces.
   */
  directSpec?: number;
}

/**
 * Injects the world-space detail layers into a stock MeshStandardMaterial.
 * Keeping this as an injection (rather than a custom ShaderMaterial) means we
 * keep three's PBR lighting, shadows, fog and tone mapping for free.
 */
export function applyWorldDetail(material: THREE.MeshStandardMaterial, opts: WorldDetailOptions) {
  const {
    macro,
    macroMetres,
    macroAlbedo = 0.35,
    macroRoughness = 0.18,
    overlay,
    overlayOrigin = new THREE.Vector2(0, 0),
    overlaySize = new THREE.Vector2(1, 1),
    overlayTint = new THREE.Color(0x1a1512),
    overlayGain = 1,
    washMap,
    washMetres = 12,
    washGain = 1,
    wheelPaths,
    wheelBand,
    wheelPathsB,
    wheelBandB,
    wheelStrength = 0,
    wheelDark = 0.58,
    wheelViz = false,
    voidMap,
    voidMetres = 8,
    erodeAlpha = 0,
    antiTile = 0,
    normalFade = true,
    soil,
    specularEnv = 1,
    directSpec = 1,
  } = opts;

  const useOverlay = !!overlay;
  const useWash = !!(overlay && washMap && washGain > 0);
  const useWheels = !!(wheelPaths && wheelPaths.length && wheelStrength > 0);
  const useErode = erodeAlpha > 0;
  const useVoid = !!voidMap;
  const useAnti = antiTile > 0;
  const useSoil = !!soil;
  const useSoilAlt = !!(soil && soil.altMap && soil.altNormalMap && soil.altRoughnessMap);

  const wheelVec = new THREE.Vector4(
    wheelPaths?.[0] ?? 1e6,
    wheelPaths?.[1] ?? 1e6,
    wheelPaths?.[2] ?? 1e6,
    wheelPaths?.[3] ?? 1e6
  );

  /**
   * The single source of truth for every uniform this module injects.
   *
   * Declarations, values and GLSL references used to live in three separate
   * lists that had to be kept in agreement by hand, and twice a rename updated
   * some of them but not all - `uWheelDark`, then `uWheelLimit` - producing a
   * link error that neither `tsc` nor `vite build` can see. Emitting the GLSL
   * declarations and the uniform values from one table, and then checking the
   * injected source against it (see assertDeclared below), makes the two halves
   * impossible to separate.
   *
   * Entries whose feature is disabled are simply absent, so a use that survives
   * a disabled branch is caught by the same check rather than by the driver.
   */
  const U: Record<string, { type: string; value: unknown }> = {
    uMacro: { type: "sampler2D", value: macro },
    uMacroScale: { type: "float", value: 1 / macroMetres },
    uMacroAlbedo: { type: "float", value: macroAlbedo },
    uMacroRough: { type: "float", value: macroRoughness },
    uSpecIBL: { type: "float", value: specularEnv },
    uSpecDirect: { type: "float", value: directSpec },
    uAntiTile: { type: "float", value: antiTile },
  };
  if (useOverlay) {
    U.uOverlay = { type: "sampler2D", value: overlay };
    U.uOverlayOrigin = { type: "vec2", value: overlayOrigin };
    U.uOverlayInvSize = { type: "vec2", value: new THREE.Vector2(1 / overlaySize.x, 1 / overlaySize.y) };
    U.uOverlayTint = { type: "vec3", value: overlayTint };
    U.uOverlayGain = { type: "float", value: overlayGain };
  }
  if (useWash) {
    U.uWashMap = { type: "sampler2D", value: washMap };
    U.uWashScale = { type: "float", value: 1 / washMetres };
    U.uWashGain = { type: "float", value: washGain };
  }
  if (useWheels) {
    U.uWheelZ = { type: "vec4", value: wheelVec };
    U.uWheelBand = { type: "vec2", value: new THREE.Vector2(wheelBand?.[0] ?? 0, wheelBand?.[1] ?? 0) };
    U.uWheelZ2 = {
      type: "vec4",
      value: new THREE.Vector4(
        wheelPathsB?.[0] ?? 1e6,
        wheelPathsB?.[1] ?? 1e6,
        wheelPathsB?.[2] ?? 1e6,
        wheelPathsB?.[3] ?? 1e6
      ),
    };
    U.uWheelBand2 = { type: "vec2", value: new THREE.Vector2(wheelBandB?.[0] ?? 0, wheelBandB?.[1] ?? 0) };
    U.uWheelStrength = { type: "float", value: wheelStrength };
    U.uWheelDark = { type: "float", value: wheelDark };
  }
  if (useSoil && soil) {
    U.uSoilField = { type: "sampler2D", value: soil.field };
    U.uSoilOrigin = { type: "vec2", value: soil.origin };
    U.uSoilInvSize = { type: "vec2", value: new THREE.Vector2(1 / soil.size.x, 1 / soil.size.y) };
    U.uSoilGain = { type: "float", value: soil.gain ?? 1 };
    U.uSoilWet = { type: "float", value: soil.wet ?? 1 };
    U.uSoilWetFloor = { type: "float", value: soil.wetFloor ?? 0 };
    U.uSoilWetBase = { type: "float", value: soil.wetBase ?? 0 };
    U.uSoilViz = { type: "float", value: soil.viz ? 1 : 0 };

    // Four fixed slots rather than a GLSL array: `uniform vec4 name[4];` puts
    // the size after the name, which this table's one-line declaration cannot
    // express, and the uniform-table assertion is worth more than the tidier
    // syntax. Unused slots get a water level far below any ground, so the
    // shoreline test is unconditionally false and the branch costs one compare.
    const pools = soil.pools ?? [];
    if (pools.length > 4) throw new Error(`worldDetail(${opts.key}): at most four pools, got ${pools.length}`);
    const slot = (i: number) => {
      const p = pools[i];
      return p
        ? new THREE.Vector4(p.x, p.z, 1 / p.rx, 1 / p.rz)
        : new THREE.Vector4(0, 0, 1, 1);
    };
    U.uPool0 = { type: "vec4", value: slot(0) };
    U.uPool1 = { type: "vec4", value: slot(1) };
    U.uPool2 = { type: "vec4", value: slot(2) };
    U.uPool3 = { type: "vec4", value: slot(3) };
    U.uPoolY = {
      type: "vec4",
      value: new THREE.Vector4(
        pools[0]?.level ?? -1e4,
        pools[1]?.level ?? -1e4,
        pools[2]?.level ?? -1e4,
        pools[3]?.level ?? -1e4
      ),
    };
  }
  if (useSoilAlt && soil) {
    U.uSoilAltMap = { type: "sampler2D", value: soil.altMap };
    U.uSoilAltNormal = { type: "sampler2D", value: soil.altNormalMap };
    U.uSoilAltRough = { type: "sampler2D", value: soil.altRoughnessMap };
    U.uSoilAltScale = { type: "float", value: 1 / (soil.altMetres ?? 11) };
  }
  if (useErode) U.uErode = { type: "float", value: erodeAlpha };
  if (useVoid) {
    U.uVoidMap = { type: "sampler2D", value: voidMap };
    U.uVoidScale = { type: "float", value: 1 / voidMetres };
  }

  const uniformDecls = Object.entries(U)
    .map(([name, u]) => `uniform ${u.type} ${name};`)
    .join("\n      ");

  /**
   * Fail at injection time on any `uXxx` the table does not define, naming the
   * chunk it came from. Reaching the driver for this is far too late: a link
   * error leaves the material silently rendering without the injection, which
   * looks like an authoring mistake rather than a build one, and has now cost
   * two review rounds.
   */
  const assertDeclared = (chunk: string, where: string) => {
    // Scan the code, not the prose. Naming a uniform in a comment used to trip
    // this, which is a false positive with a genuinely misleading message: it
    // reports an undeclared-uniform bug in a chunk whose GLSL is correct, and
    // it does so by throwing out of `onBeforeCompile` — i.e. out of
    // `renderer.render()`, every frame, so the page never reaches
    // `__SCENE_READY` while `__SYSTEM_ERRORS` stays empty because nothing
    // failed during init. Stripping comments first loses no real coverage: a
    // use that matters is code.
    const code = chunk.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const ref of new Set(code.match(/\bu[A-Z][A-Za-z0-9_]*\b/g) ?? [])) {
      if (!(ref in U)) {
        throw new Error(
          `worldDetail(${opts.key}): ${where} references '${ref}', which is not declared for this material. ` +
            `Declared: ${Object.keys(U).join(", ")}`
        );
      }
    }
  };

  material.onBeforeCompile = (shader) => {
    for (const [name, u] of Object.entries(U)) shader.uniforms[name] = { value: u.value };
    material.userData.shader = shader;

    shader.vertexShader =
      "varying vec3 vWDetailPos;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vWDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    const decl = `
      ${uniformDecls}
      varying vec3 vWDetailPos;

      // Wheel-path weight at a world position. Kept in a function because both
      // the albedo and the roughness injection need the identical value.
      float wdWheel(vec2 wxz) {
        ${
          useWheels
            ? `// A tyre polishes a band about its own width. Summing four broad
               // lobes saturated the whole carriageway to a single tone - the
               // exact opposite of the effect - so take the nearest track only
               // and keep the lobe at roughly tyre width.
               float wob = (texture2D(uMacro, vec2(wxz.x * 0.0045, 0.317)).r - 0.5) * 0.5;
               float w = 0.0;
               if (wxz.y >= uWheelBand.x && wxz.y <= uWheelBand.y) {
                 for (int i = 0; i < 4; i++) {
                   float dz = (wxz.y - uWheelZ[i] - wob) / 0.26;
                   w = max(w, exp(-dz * dz));
                 }
               }
               if (wxz.y >= uWheelBand2.x && wxz.y <= uWheelBand2.y) {
                 for (int i = 0; i < 4; i++) {
                   float dz = (wxz.y - uWheelZ2[i] - wob) / 0.3;
                   w = max(w, exp(-dz * dz));
                 }
               }
               // The polish comes and goes with the pavement condition.
               float v = 0.62 + 0.62 * texture2D(uMacro, vec2(wxz.x * 0.011, 0.317)).r;
               return clamp(w * v, 0.0, 1.0) * uWheelStrength;`
            : "return 0.0;"
        }
      }

      /**
       * Standing water, clipped by the height field.
       *
       * The water surface is a plane at a known world Y, and the only honest
       * test for "is this fragment under water" is the fragment's own world Y
       * against that plane. Doing it per pixel rather than through the baked
       * soil field is not a refinement, it is the difference between a puddle
       * and a decal: the field is 0.47 m per texel, and on a dish that falls
       * 20 mm per metre any height tolerance wide enough to survive bilinear
       * interpolation is metres of ground.
       *
       * The ellipse is a gate and nothing more - it says which dish may hold
       * water, at a hard 0.94..1.06 radius so it contributes no shape. All of
       * the outline comes from the pavement: its crown, its ruts, its
       * undulation and the trough itself, which is why the shoreline is not an
       * ellipse and wanders where the ruts cross it.
       *
       * The jitter is in METRES OF WATER LEVEL, not in wetness. That
       * distinction is the whole trick. Displacing a wetness value blurs a
       * gradient; displacing the level moves the intersection of a plane with
       * a slope, so the margin travels sideways - about +/- 0.2 m here, which
       * comfortably exceeds the 0.16 m the transition itself spans. Three
       * octaves so the edge is broken at the scale of the puddle, of a
       * flagstone and of the aggregate.
       */
      /**
       * Smooth analytic value noise for the waterline, in preference to
       * another uMacro tap.
       *
       * uMacro is a 512px tile mapped over tens of metres, so asking it for
       * metre-scale features means sampling it at fifty times its design
       * frequency. That works at nadir and dies at grazing incidence, which is
       * the only angle a puddle is ever seen from: the footprint of a pixel on
       * a near-horizontal surface is enormously elongated, the sampler walks
       * up the mip chain, and the result converges on the tile mean. A
       * displacement that quietly becomes a constant is worse than no
       * displacement, because the edge stays smooth and the code says it is
       * broken. Two domain-warped sine products have no mip chain to fall down
       * and cost no bandwidth.
       */
      float wdWobble(vec2 p) {
        return sin(p.x * 5.31 + sin(p.y * 3.77) * 1.7)
             * sin(p.y * 4.19 + sin(p.x * 2.93) * 1.3);
      }

      /**
       * The surface of the water, as a world-space normal.
       *
       * A pool with a geometrically perfect normal is a mirror, and a mirror is
       * the second way for a puddle to read as a decal: real standing water is
       * never flat, it is a slack membrane with a few millimetres of relief
       * from settlement, from air moving over it and from the grit under it.
       * The visible consequence is that the sun does not return as a disc, it
       * returns as a vertical streak - which is the single most recognisable
       * thing about wet ground at a low sun, and it is free here because the
       * streak is just a mirror direction wandering by a degree or two.
       *
       * Two scales, both tiny: the gradient is limited to about 0.03, i.e.
       * under two degrees of tilt. Finite differences rather than an analytic
       * derivative because the wobble is domain-warped and the closed form is
       * both long and easy to get subtly wrong; three extra evaluations of four
       * sines is cheaper than that risk.
       */
      /**
       * Height of the water surface at a point, as three octaves.
       *
       * The third is rotated 37 degrees. wdWobble is a product of two sines,
       * one per axis, and a product of two sines is a checkerboard: domain
       * warping bends the cells but leaves them aligned to X and Z, so
       * stacking axis-aligned octaves deepens a lattice rather than
       * destroying it. Rendered, that lattice reads as hammered metal - a
       * regular filigree of highlights - which is a specific and recognisable
       * wrong material rather than generic noise. One rotated octave costs
       * four sines and removes the alignment that made it a grid.
       */
      float wdWaveH(vec2 p) {
        mat2 rot = mat2(0.799, -0.602, 0.602, 0.799);
        return wdWobble(p * 1.70) * 0.55
             + wdWobble(p * 5.30 + vec2(7.1, 2.3)) * 0.20
             + wdWobble(rot * p * 2.90 + vec2(1.7, 9.4)) * 0.28;
      }

      vec3 wdRipple(vec2 p) {
        // Two changes here, one of which is a bug fix and one of which was
        // overshot on the first attempt and is recorded because the overshoot
        // is instructive.
        //
        // The bug: the finite-difference step was 0.03 m while the shortest
        // wave in wdWaveH has a period near 0.05 m, so the gradient was being
        // measured over most of a wavelength. A difference over a step
        // comparable to the wave it is sampling is a low-pass filter, and it
        // was flattening the shortest octave to almost nothing - a third of the
        // authored amplitude was producing no slope at all. 0.012 m fixes that,
        // and on its own it already multiplies the fine detail.
        //
        // The overshoot: the pools were reported by a critic as a clean bright
        // blob with weak reflection, and the diagnosis was right - at roughness
        // 0.055 the interior is a mirror, and a mirror of a smooth sky gradient
        // IS a clean bright blob however correct its edge is. What makes water
        // read as water is that the reflected world arrives broken. But going
        // to 0.0055 *and* fixing the step compounded to something like 5x the
        // effective slope, and the pool rendered as mercury: chrome folding
        // back on itself. Capillary ripple on a shallow puddle is a couple of
        // degrees of slope, not tens. 0.0020 with the corrected step is about
        // twice the original slope on the fine octaves and a quarter more
        // overall, which is structure rather than distortion.
        //
        // Worth keeping the shape of the mistake: when two changes both push
        // the same quantity and one of them is a filter being removed, they
        // multiply rather than add, and the sum of two individually reasonable
        // steps is not reasonable.
        float e = 0.012;
        float h0 = wdWaveH(p);
        float hx = wdWaveH(p + vec2(e, 0.0));
        float hz = wdWaveH(p + vec2(0.0, e));
        vec2 g = vec2(hx - h0, hz - h0) / e * 0.0020;
        return normalize(vec3(-g.x, 1.0, -g.y));
      }

      /**
       * How deep the water is, in metres, alongside whether there is any.
       *
       * A file-scope global rather than an out-parameter threaded through
       * wdSoil's vec4, because three separate injections - albedo, roughness
       * and normal - each call wdSoil independently and all three need the
       * depth. Widening the return type would mean widening it in all three and
       * keeping the packing in step by hand, which is the class of mistake the
       * uniform table exists to prevent.
       *
       * Depth matters because it is what stops a pool being one flat tone.
       * Water a millimetre deep over asphalt is asphalt with a sheen; the same
       * water 30 mm deep is a mirror. A real puddle therefore has a gritty dark
       * fringe grading into a bright reflective middle, and reproducing that
       * gradient is most of the difference between "a dish with water in it"
       * and "a shape someone pasted on the ground".
       */
      float wdDepth;

      /**
       * The waterline, as a band straddling zero depth rather than as a value
       * inside the pool.
       *
       * Every real puddle has a dark line where it meets its dish: ground that
       * is saturated but not submerged has no air in its pores, no subsurface
       * scattering and nothing on it to reflect, so it is the darkest thing in
       * the frame - darker than the water beside it and much darker than the
       * damp pavement outside. It is also the cue that says "this is water in a
       * dish" rather than "this is a shape on the ground", because a decal has
       * no reason to have a dark outline and a puddle cannot avoid one.
       *
       * Signed, so the band exists on both sides. wdDepth cannot carry this: it
       * is accumulated with max() from zero and would clamp the outside away.
       */
      float wdRim;

      float wdPoolOne(vec4 g, float level, vec3 wpos, float jit) {
        float r = length((wpos.xz - g.xy) * g.zw);
        float gate = 1.0 - smoothstep(0.94, 1.06, r);
        if (gate <= 0.0) return 0.0;
        float d = (level + jit) - wpos.y;
        // 3.2 mm of depth, i.e. a step. Whether there is water somewhere is a
        // genuinely binary fact and it belongs on a knife edge; how the water
        // *looks* is a function of depth and is graded downstream. Conflating
        // the two is what made this a feathered ellipse.
        float cover = gate * smoothstep(-0.0016, 0.0016, d);
        wdRim = max(wdRim, gate * (1.0 - smoothstep(0.0, 0.006, abs(d))));
        if (cover > 0.0) wdDepth = max(wdDepth, d * gate);
        return cover;
      }

      float wdPool(vec3 wpos) {
        ${
          useSoil
            ? `wdDepth = 0.0;
               wdRim = 0.0;
               float jit = wdWobble(wpos.xz * 0.21) * 0.0040
                        + wdWobble(wpos.xz * 0.73 + vec2(11.3, 4.7)) * 0.0022
                        + wdWobble(wpos.xz * 2.10 + vec2(3.1, 19.4)) * 0.0009;
               float p = wdPoolOne(uPool0, uPoolY.x, wpos, jit);
               p = max(p, wdPoolOne(uPool1, uPoolY.y, wpos, jit));
               p = max(p, wdPoolOne(uPool2, uPoolY.z, wpos, jit));
               p = max(p, wdPoolOne(uPool3, uPoolY.w, wpos, jit));
               return p * uSoilWet;`
            : "return 0.0;"
        }
      }

      // The soil field, read once per surface and shared by all three
      // injections. A function rather than three copies of the lookup because
      // the albedo, the roughness and the bump have to agree about where the
      // damp is to the pixel: a wet patch whose roughness edge is a texel off
      // its albedo edge reads as a printed decal, which is exactly the failure
      // the wet/dry fringe exists to avoid.
      // Neutral when the feature is absent: drainage 0, nothing disturbed,
      // nothing wet, material 0.
      // Set by wdSoil, read by the roughness, specular and environment arms.
      // A global rather than a fifth return channel because wdSoil's vec4 is
      // fully spoken for and because every arm that wants it calls wdSoil
      // first anyway.
      /**
       * Large-scale albedo variation, analytic rather than sampled.
       *
       * uMacro is a 512px tile mapped over 41 m on the asphalt, i.e. 80 mm
       * per texel, and the ground is seen at grazing incidence for most of the
       * frame. At 40 m out from a 1.6 m eye a screen pixel covers metres of
       * world, so the sampled mip is many levels down and the tile returns its
       * own mean: **the macro variation is present in the texture and absent
       * from the render exactly where the ground fills the frame.** A reviewer
       * working from frames reported the asphalt as uniform procedural
       * roughness with macro variation missing, and it was right - the term was
       * there, mipmapped into a constant.
       *
       * This is the third time tonight a texture sampled far above its design
       * frequency has silently become a constant at grazing incidence (see
       * NOTES.md). Analytic noise has no mip chain and cannot do it: three
       * waves on bases rotated so they share no period, at 34 m, 13 m and 5 m,
       * which is the band a mip pyramid destroys first and the band that reads
       * as patched, worn and re-laid pavement.
       */
      /**
       * Analytic macro variation, three octaves from 34 m to 5 m. Analytic and
       * not a texture because a mip chain destroys exactly the large-scale half
       * of this, returning the mean at grazing incidence.
       *
       * ATTEMPTED AND REVERTED, twice, and recorded so the next person does not
       * spend the same two rounds: adding octaves at 2.0 m and 1.1 m to fill the
       * band between this term and the 8 m texture tile measured as an exact
       * null both times, correlation length 45 px against 45 px in the rendered
       * frame, identical to three decimals.
       *
       * Two separate reasons, both instructive.
       *
       * First, an amplitude schedule is not portable between a height field and
       * a colour field. Equal slope per octave is right for height, because what
       * a light meets is the gradient, which is why the dirt turned into a golf
       * ball when the same height budget moved to a shorter wavelength. This
       * term modulates albedo, whose contrast the eye reads directly, so an
       * equal-slope schedule makes every octave below the first invisible.
       *
       * Second, and the reason the corrected schedule ALSO measured null: the
       * standard deviation of this function is set by the outer scale, so
       * raising the per-octave amplitudes while leaving the scale alone
       * redistributes the spectrum and adds no contrast at all — 0.209 before
       * against 0.207 after. **Adding octaves to a normalised sum is not adding
       * content, it is moving content to shorter wavelengths.** Whoever takes
       * this next must raise the outer scale, or raise uMacroAlbedo, and check
       * the total swing rather than the octave list.
       *
       * The measurement was also wrong in a way worth avoiding: it high-passed
       * at 48 px and then reported a correlation length of 45 px, which is the
       * window and not the content, so it could not have seen the band being
       * changed even if the change had been real. Pick the window from the
       * feature size you are testing, not from the previous run.
       */
      float wdMacroBig(vec2 p) {
        vec2 a = vec2(p.x * 0.799 - p.y * 0.602, p.x * 0.602 + p.y * 0.799);
        vec2 b = vec2(p.x * 0.485 + p.y * 0.875, -p.x * 0.875 + p.y * 0.485);
        float v = sin(p.x * 0.185 + sin(p.y * 0.121) * 1.7) * 0.42
                + sin(a.x * 0.483 + sin(a.y * 0.297) * 1.3) * 0.34
                + sin(b.x * 1.257 - sin(b.y * 0.731) * 0.9) * 0.24;
        return clamp(0.5 + v * 0.5, 0.0, 1.0);
      }

      float wdDamp = 0.0;

      vec4 wdSoil(vec2 wxz) {
        ${
          useSoil
            ? `vec4 s = texture2D(uSoilField, clamp((wxz - uSoilOrigin) * uSoilInvSize, 0.0, 1.0));
               float w = max(s.b * uSoilWet, uSoilWetFloor);

               // The damp margin, chewed. This is the diffuse arm only - it is
               // saturated ground, not a waterline - so a modest displacement
               // at two incommensurate world frequencies (1.11 m and 0.30 m)
               // is enough to stop it being a smooth analytic contour.
               // Confined to the transition band, or the noise becomes a
               // mottle over everything instead of an edge.
               float e = texture2D(uMacro, wxz * 0.9 + vec2(0.13, 0.77)).r * 0.55
                       + texture2D(uMacro, wxz * 3.3 + vec2(0.61, 0.29)).r * 0.45;
               float band = smoothstep(0.03, 0.42, w) * (1.0 - smoothstep(0.58, 0.99, w));
               w = clamp(w + (e - 0.5) * 0.62 * band, 0.0, 1.0);

               // Standing water is not in the field at all - see the long note
               // in gen/groundSoil.ts. It is clipped here, per pixel, against
               // the fragment's own world Y.
               s.b = max(w, wdPool(vWDetailPos));

               // Residual damp: the sheet of water that fell on everything last
               // night and has not finished leaving.
               //
               // The field's wet channel is drainage-keyed, so it only knows
               // where water *collects*. That is the right model for a puddle
               // and the wrong one for rain, which lands everywhere, and the
               // brief asks for wet asphalt rather than for four puddles on a
               // dry lot. Without this the pavement between the pools sits at
               // exactly the value of pavement that has been dry for a week -
               // which is what a reviewer working from frames reported, and it
               // is why the pools were reading as objects placed on the ground
               // instead of as the last of something that covered it.
               //
               // Kept out of s.b on purpose. s.b is the published groundSoil
               // wetness and soilprobe checks it against the CPU service; this
               // term is a property of one material (asphalt holds a film,
               // soil does not) and folding it into the service would make the
               // probe disagree about something the service never claimed.
               //
               // Drying is patchy, so this is modulated rather than added flat:
               // a uniform darkening is just a darker material. The macro tap
               // is at 34 m, comfortably inside the texture's design frequency,
               // unlike the waterline jitter that had to be replaced by an
               // analytic wobble for exactly that reason.
               float dpatch = texture2D(uMacro, wxz * uMacroScale * 2.3 + vec2(0.29, 0.61)).r;
               // s.r is drainage, 0.5 at the local datum. Low ground dries last,
               // so this leans the film toward the hollows - but it multiplies
               // around 1.0 rather than around 0.5. Centred on 0.5 it read as
               // "damp only in hollows", which on a crowned lot is nowhere,
               // and the first capture of this term was indistinguishable from
               // the control for exactly that reason. Rain lands on the crown
               // too; it just leaves it first.
               float dlow = clamp(1.0 + (0.5 - s.r) * 1.6, 0.4, 1.6);
               // Reads w, not s.b: the pool is deliberately excluded here. s.b
               // steps to 1.0 at the shoreline because coverage is a step, and
               // anything driven off it therefore steps too - which put a
               // discontinuity in albedo, in roughness and in the specular ramp
               // exactly at the waterline and is why the pools were reading as
               // pasted-on shapes. Water at zero depth is indistinguishable
               // from the saturated ground beside it, so at zero depth every
               // water arm must equal what the ground was already doing. The
               // pool's whole contribution is graded from wdDepth downstream.
               wdDamp = max(w, uSoilWetBase * uSoilWet * clamp((0.28 + 1.05 * dpatch) * dlow, 0.0, 1.0));
               return s;`
            : "wdDamp = 0.0; return vec4(0.5, 0.0, 0.0, 0.0);"
        }
      }
    `;

    const colorInject = `
      vec2 wxz = vWDetailPos.xz;
      // Set once here, read again at <lights_physical_fragment> and
      // <lights_fragment_maps>, which is where the reflection lives. Water is
      // not a darker asphalt with a lower roughness: it has its own Fresnel and
      // it reflects the environment at full strength, and both of those are
      // decided after the material is assembled, not in the albedo.
      float wdWetAmt = 0.0;
      // Everything a surface does at 3 m it should stop doing by 150 m. Without
      // this, joint lines and stains hold full contrast right to the horizon,
      // which is one of the loudest CG tells in a wide shot.
      float wdFade = 1.0 - smoothstep(28.0, 190.0, length(vWDetailPos - cameraPosition));
      // The fine tap keeps its texture: at that scale a mip chain is doing the
      // job it exists for, which is anti-aliasing. Only the large-scale half
      // moves to analytic, because that is the half a mip chain destroys.
      float macroA = texture2D(uMacro, wxz * uMacroScale).r;
      float macroB = wdMacroBig(wxz);
      float macroMix = macroA * 0.42 + macroB * 0.58;

      ${
        useOverlay
          ? `vec2 ouv = (wxz - uOverlayOrigin) * uOverlayInvSize;
             float inside = step(0.0, ouv.x) * step(ouv.x, 1.0) * step(0.0, ouv.y) * step(ouv.y, 1.0);
             vec4 ovRaw = texture2D(uOverlay, clamp(ouv, 0.0, 1.0));
             vec4 ov = mix(vec4(0.5, 0.5, 0.0, 0.0), ovRaw, inside);
             ov.r = 0.5 + (ov.r - 0.5) * uOverlayGain;
             ov.b *= uOverlayGain;
             ov.a *= uOverlayGain;`
          : "vec4 ov = vec4(0.5, 0.5, 0.0, 0.0);"
      }

      #ifdef USE_MAP
        if (uAntiTile > 0.0) {
          // Second sample, rotated 41 degrees and at 0.63x. Repair patches (which
          // show up as a strong tone deviation in the overlay) get pushed hard
          // toward it, so a patch reads as a different mix, not a tinted rectangle.
          mat2 rot = mat2(0.755, -0.656, 0.656, 0.755);
          vec4 alt = texture2D(map, rot * vMapUv * 0.63 + vec2(0.37, 0.19));
          float w = smoothstep(0.32, 0.68, texture2D(uMacro, wxz * uMacroScale * 1.7 + vec2(0.61, 0.23)).r);
          w = clamp(w * uAntiTile + smoothstep(0.08, 0.26, abs(ov.r - 0.5)) * 0.9, 0.0, 1.0);
          diffuseColor = mix(diffuseColor, alt, w);
        }
      #endif

      ${
        useSoil
          ? `vec4 wdS = wdSoil(wxz);
             // Signed, in units of the field's own range rather than in metres:
             // this drives a tint, and a tint wants "how high above the local
             // datum, relative to how much relief there is" and not an absolute
             // depth. The metre scaling stays on the CPU side, where callers of
             // the service actually need it.
             float sDrain = (wdS.r - 0.5) * 2.0;
             float sDist = wdS.g;
             float sMat = wdS.a;
             ${
               useSoilAlt
                 ? `#ifdef USE_MAP
                      // The second soil. Its tile is a different length from the
                      // base one on purpose, and it is sampled on a rotated frame
                      // as well, so the two materials share no period and no axis.
                      mat2 srot = mat2(0.878, -0.479, 0.479, 0.878);
                      vec4 soilAlt = texture2D(uSoilAltMap, srot * wxz * uSoilAltScale + vec2(0.53, 0.11));
                      diffuseColor = mix(diffuseColor, soilAlt, sMat * uSoilGain);
                    #endif`
                 : ""
             }`
          : ""
      }

      diffuseColor.rgb *= mix(1.0, 0.55 + macroMix * 0.95, uMacroAlbedo);

      float wheel = wdWheel(wxz);
      ${
        useWheels
          ? `diffuseColor.rgb *= mix(1.0, uWheelDark, wheel);
             ${wheelViz ? "diffuseColor.rgb = vec3(wheel);" : ""}
             // The strip a car straddles never gets polished: it collects the
             // dust and the fines that the tyres throw off, and bleaches pale in
             // the sun. That light band either side of a dark wheel path is what
             // makes a road read as driven rather than as one poured slab.
             if (wxz.y > uWheelBand.x && wxz.y < uWheelBand.y) {
               float l1 = (uWheelZ.x + uWheelZ.y) * 0.5;
               float l2 = (uWheelZ.z + uWheelZ.w) * 0.5;
               float dz1 = wxz.y - l1;
               float dz2 = wxz.y - l2;
               float dust = exp(-dz1 * dz1 * 2.6) + exp(-dz2 * dz2 * 2.6);
               float dv = 0.6 + 0.8 * texture2D(uMacro, vec2(wxz.x * 0.017, 0.673)).r;
               diffuseColor.rgb *= mix(1.0, 1.34, clamp(dust * dv, 0.0, 1.0) * uWheelStrength);
             }`
          : ""
      }

      ${
        useOverlay
          ? `diffuseColor.rgb *= mix(1.0, ov.r * 2.0, wdFade);
             diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uOverlayTint * 4.0, ov.b * wdFade);`
          : ""
      }

      ${
        useWash
          ? `// Shoulder material lying on top of the pavement. Sampled from the real
             // dirt albedo so it carries gravel and clods, not a flat brown wash.
             // Grain the coverage hard before using it, otherwise the painted
             // blobs read as smooth spills of milk rather than as dust.
             float wg = texture2D(uMacro, wxz * 0.47 + vec2(0.19, 0.71)).r * 0.45
                      + texture2D(uMacro, wxz * 1.9 + vec2(0.83, 0.27)).r * 0.35
                      + texture2D(uMacro, wxz * 7.1 + vec2(0.37, 0.59)).r * 0.20;
             float washAmt = clamp(ov.a * uWashGain * 1.9 - (0.55 - wg) * 1.15, 0.0, 1.0);
             if (washAmt > 0.002) {
               vec4 washCol = texture2D(uWashMap, wxz * uWashScale);
               vec4 washAlt = texture2D(uWashMap, wxz * uWashScale * 0.53 + vec2(0.29, 0.61));
               washCol = mix(washCol, washAlt, smoothstep(0.35, 0.65, macroA));
               // Thin films of dust stay translucent; only a real drift hides
               // the pavement, and even then it never goes fully opaque.
               diffuseColor.rgb = mix(diffuseColor.rgb, washCol.rgb * (0.42 + macroMix * 0.34), washAmt * 0.72);
             }`
          : ""
      }

      ${
        useSoil
          ? `// Drainage organises the colour. A crest has had the fines blown
             // and washed off it and is pale, dusty and slightly warm; a hollow
             // holds the fines, crusts over and sits darker and a shade cooler.
             // Keyed off the height field rather than off free noise so the
             // tone agrees with the silhouette instead of fighting it, which is
             // the whole difference between "varied" and "organised".
             float crest = clamp(sDrain, 0.0, 1.0);
             float hollow = clamp(-sDrain, 0.0, 1.0);
             diffuseColor.rgb *= mix(1.0, 1.0 + crest * 0.30 - hollow * 0.26, uSoilGain);
             diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(1.05, 1.01, 0.94), vec3(0.94, 0.96, 1.02),
                                                   clamp(hollow - crest, 0.0, 1.0)), uSoilGain);
             // Trafficked ground is compacted, swept of its loose dust and
             // stained by what drips on it, so it goes darker and flatter than
             // the crust beside it.
             diffuseColor.rgb *= mix(1.0, 1.0 - sDist * 0.20, uSoilGain);

             // Wet. Water fills the pores and kills the diffuse scattering that
             // makes dry soil pale, so a wet surface is close to half the albedo
             // of the same surface dry. The fringe is where the read lives: a
             // narrow band right at the margin is saturated but not flooded and
             // goes darker than the standing water itself.
             float sWet = wdS.b;
             // The reflective arm is depth-weighted for the reason given at the
             // roughness injection: a millimetre of water is a sheen, not a
             // mirror, and the shore has to keep some substrate or the pool has
             // no inside.
             float wdSheen = min(wdDamp, 0.55) / 0.55;
             // Depth alone. The old form multiplied by smoothstep on sWet,
             // which steps at the shoreline, so the reflective arm arrived at
             // 45% of full strength the instant coverage turned on and the pool
             // began with a cut. This is zero at zero depth by construction.
             float wdDeep = smoothstep(0.0, 0.018, wdDepth);
             wdWetAmt = clamp(wdSheen * 0.45 + wdDeep * 0.55, 0.0, 1.0);
             // The fringe is a shoreline, so it keys on standing water only.
             // The residual film has no shoreline - that is what makes it read
             // as damp rather than as a very large shallow puddle.
             float fringe = smoothstep(0.10, 0.34, sWet) * (1.0 - smoothstep(0.42, 0.72, sWet));
             diffuseColor.rgb *= mix(1.0, 0.52, wdDamp);
             diffuseColor.rgb *= 1.0 - fringe * 0.16;
             // The waterline. Saturated, unsubmerged, nothing to reflect: the
             // darkest band in the frame, and the thing that makes the pool sit
             // in the pavement instead of on it.
             diffuseColor.rgb *= 1.0 - wdRim * 0.30;
             // Under standing water the substrate goes further down again and
             // loses what little colour it had. This is the diffuse term only -
             // it is what you see looking straight down into the pool, where
             // Fresnel is weakest - so it must not be so dark that the shallow
             // near edge turns into a hole.
             // 0.74 was too timid. Standing water over a 9%-albedo surface
             // absorbs going in and coming out, and the light that does come
             // back competes with a specular that has moved somewhere else
             // entirely; a puddle at your feet is markedly darker than the dry
             // asphalt beside it and only becomes brighter looking toward the
             // sun. Too high a diffuse floor is what leaves a uniformly bright
             // lens instead of a dark pool with a bright far edge.
             diffuseColor.rgb *= mix(1.0, 0.58, wdDeep);

             if (uSoilViz > 0.5) diffuseColor.rgb = vec3(sDist, sWet, clamp(sMat, 0.0, 1.0));`
          : ""
      }
    `;

    // Runs after <alphamap_fragment>, so it sees the stripe's own wear mask and
    // can chew the edge back along the aggregate grain.
    const erodeInject = `
      float g1 = texture2D(uMacro, vWDetailPos.xz * 0.61 + vec2(0.11, 0.83)).r;
      float g2 = texture2D(uMacro, vWDetailPos.xz * 2.7 + vec2(0.53, 0.17)).r;
      float g3 = texture2D(uMacro, vWDetailPos.xz * 9.3 + vec2(0.77, 0.41)).r;
      float grain = g1 * 0.30 + g2 * 0.34 + g3 * 0.36;
      // Whole runs of a stripe are simply gone: repainting is done on a budget
      // and traffic takes the line off in metres, not in speckles.
      float run = texture2D(uMacro, vWDetailPos.xz * 0.075 + vec2(0.29, 0.47)).r;
      float bald = smoothstep(0.34, 0.22, run);
      // A stripe is laid by a machine walking at an uneven pace, so it runs
      // thick and thin along its length. Without this the line is one brightness
      // end to end, which is most of why it reads as a decal.
      float lay = texture2D(uMacro, vWDetailPos.xz * 0.21 + vec2(0.67, 0.13)).r;
      diffuseColor.a *= 0.78 + 0.34 * lay;
      diffuseColor.rgb *= 0.9 + 0.18 * lay;
      // Road film: everything gets a thin layer of the same grey dust, and
      // paint shows it far more than the asphalt around it does.
      float film = texture2D(uMacro, vWDetailPos.xz * 0.53 + vec2(0.31, 0.88)).r;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.77, 0.74), film * 0.4);
      // These wear terms stack multiplicatively with the relief, the lay and the
      // alphaTest below. Tuned individually they each looked reasonable and
      // together they erased the markings entirely, so keep the total gentle:
      // paint should read as worn from standing height, not as absent.
      diffuseColor.a = clamp(diffuseColor.a - clamp((grain - 0.46) * uErode * 1.5, 0.0, 1.0) - bald, 0.0, 1.0);
      ${
        useVoid
          ? `// Paint is rolled onto a rough surface: it floods the voids between
             // stones and is scrubbed off the proud aggregate first, so coverage
             // is the inverse of the relief underneath rather than a flat film.
             float relief = texture2D(uVoidMap, vWDetailPos.xz * uVoidScale).r;
             diffuseColor.a *= 1.0 - clamp((relief - 0.34) * 1.4, 0.0, 0.45);`
          : ""
      }
      // Where the paint has nearly gone it has abraded through to grey rather
      // than simply turning transparent.
      diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.58, 0.56, 0.53), diffuseColor.rgb,
                             smoothstep(0.16, 0.62, diffuseColor.a));
    `;

    const roughInject = `
      float macroR = texture2D(uMacro, vWDetailPos.xz * uMacroScale * 0.61 + vec2(0.13, 0.29)).r;
      #ifdef USE_ROUGHNESSMAP
        if (uAntiTile > 0.0) {
          mat2 rrot = mat2(0.755, -0.656, 0.656, 0.755);
          float altR = texture2D(roughnessMap, rrot * vRoughnessMapUv * 0.63 + vec2(0.37, 0.19)).g;
          float rw = smoothstep(0.32, 0.68, texture2D(uMacro, vWDetailPos.xz * uMacroScale * 1.7 + vec2(0.61, 0.23)).r);
          roughnessFactor = mix(roughnessFactor, altR, rw * uAntiTile);
        }
      #endif
      roughnessFactor = clamp(roughnessFactor + (macroR - 0.5) * uMacroRough, 0.04, 1.0);
      roughnessFactor -= wdWheel(vWDetailPos.xz) * 0.26;
      ${
        useOverlay
          ? `vec2 ruv = (vWDetailPos.xz - uOverlayOrigin) * uOverlayInvSize;
             float rIn = step(0.0, ruv.x) * step(ruv.x, 1.0) * step(0.0, ruv.y) * step(ruv.y, 1.0);
             vec4 ovR = texture2D(uOverlay, clamp(ruv, 0.0, 1.0));
             float og = mix(0.5, ovR.g, rIn);
             roughnessFactor += (og - 0.5) * 0.95 * uOverlayGain;
             ${useWash ? "roughnessFactor = mix(roughnessFactor, 0.99, clamp(ovR.a * rIn * uWashGain * 1.6, 0.0, 1.0) * 0.6);" : ""}`
          : ""
      }
      ${
        useSoil
          ? `vec4 wdSr = wdSoil(vWDetailPos.xz);
             ${
               useSoilAlt
                 ? `mat2 srrot = mat2(0.878, -0.479, 0.479, 0.878);
                    float soilAltR = texture2D(uSoilAltRough,
                      srrot * vWDetailPos.xz * uSoilAltScale + vec2(0.53, 0.11)).g;
                    roughnessFactor = mix(roughnessFactor, soilAltR, wdSr.a * uSoilGain);`
                 : ""
             }
             // Compaction polishes; standing water is a mirror. The wet ramp is
             // deliberately steep at the top end so the pool itself separates
             // from the merely damp ground around it - if the whole damp region
             // goes equally glossy the puddle has no edge.
             roughnessFactor -= wdSr.g * 0.10 * uSoilGain;
             // Damp includes the residual film, so this ramp is what makes the
             // pavement between the pools behave like wet pavement: darker in
             // shadow because the albedo arm took it down, and brighter toward
             // the sun because a lower roughness concentrates the highlight
             // instead of spreading it. Those two happening together is the
             // whole read of "it rained last night"; either alone is just a
             // different asphalt.
             roughnessFactor = mix(roughnessFactor, 0.42, smoothstep(0.05, 0.55, wdDamp) * 0.75);
             // Open water, now that there is a world to reflect. This was held
             // at 0.17 while scene.environment was sky plus a flat ground disc,
             // because a near-mirror with nothing in it but the sun returned one
             // blown white smear - a worse read than the dry ground it replaced.
             // The PMREM now carries canopy, pumps, building, car and tree line,
             // so the highlight has structure to break against and water can be
             // as smooth as water actually is. The remaining roughness is the
             // silt and the sub-millimetre disturbance on a shallow pool, not a
             // hedge against a bad environment.
             //
             // Keyed on depth, not on coverage. Coverage is binary a
             // centimetre either side of the shoreline, so keying the mirror on
             // it puts full glass right up against the grit and the pool
             // becomes one flat tone with a cut edge. Depth grades over the
             // first 18 mm, which on these slopes is the first half-metre or so
             // inside the margin: gritty and merely damp at the shore, glass in
             // the middle. That gradient is what a shallow puddle is.
             // Depth alone, with no constant term. The previous weight was
             // (0.35 + 0.65 * depth), so the first covered pixel jumped 35% of
             // the way to a mirror while its neighbour a millimetre away was
             // still damp asphalt - a roughness discontinuity of about 0.13 at
             // the shoreline, which is a visible hard rim and is most of why
             // the pools read as feathered decals rather than as water. Water
             // zero millimetres deep is wet ground; it has to start there.
             float rDeep = smoothstep(0.0, 0.020, wdDepth);
             roughnessFactor = mix(roughnessFactor, 0.055, rDeep);
             // The saturated rim is rougher than either side, not smoother:
             // it is grit with the air driven out of it, and it is the one
             // place around a puddle that does not shine.
             roughnessFactor = mix(roughnessFactor, 1.0, wdRim * 0.45);`
          : ""
      }
      roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);
    `;

    /**
     * The anti-tile arm for the bump.
     *
     * `antiTile` cross-faded a second rotated sample into the albedo and the
     * roughness only. The normal was sampled once by three's stock chunk, so on
     * the dirt - which has the highest `antiTile` in the project and no site
     * overlay to break it up - the bump kept the tile's full period while the
     * two channels either side of it were broken. That is the channel the
     * critic named, and it is why the complaint survived a feature that exists
     * to prevent it.
     *
     * Two things this has to get right.
     *
     * 1. **Counter-rotate the tangent-space XY.** `mapN.xy` is a slope measured
     *    along the texture's own U and V axes. The lookup rotates those axes,
     *    so the sampled slope is expressed in the rotated frame; feeding it to
     *    `tbn` unchanged lights the second sample from a direction 41 degrees
     *    away from the first and adds a second, wrong bump rather than hiding
     *    the first. The correction is the inverse (== transpose) of the same
     *    rotation, written out as a literal because `transpose()` is not in
     *    GLSL ES 1.00, which is what three compiles these chunks as.
     *
     * 2. **Use the same selection mask as the other two arms, on purpose.** The
     *    mask is world-periodic at macroMetres / 1.7 = 45.9 m and the alternate
     *    sample sits at 0.63x, i.e. 27 m, so the breakup layer contributes a
     *    visible cell of its own. That is a real defect and it is recorded, but
     *    it belongs to albedo and roughness equally and fixing it here alone
     *    would decorrelate the three channels: the bump would switch to the
     *    rotated sample somewhere the albedo had not, so a pebble's colour and
     *    its relief would stop agreeing. A mismatched albedo/normal pair is a
     *    worse read than a long-period mask. Decorrelating the periods is a
     *    separate change that must move all three arms together, and it must be
     *    measured on its own (NOTES case 23: two fixes at once tell you
     *    nothing).
     */
    const normalAntiInject = `
      #if defined( USE_NORMALMAP_TANGENTSPACE )
        if (uAntiTile > 0.0) {
          mat2 nrot = mat2(0.755, -0.656, 0.656, 0.755);
          vec3 altMapN = texture2D(normalMap, nrot * vNormalMapUv * 0.63 + vec2(0.37, 0.19)).xyz * 2.0 - 1.0;
          #if defined( USE_PACKED_NORMALMAP )
            altMapN = vec3(altMapN.xy, sqrt(saturate(1.0 - dot(altMapN.xy, altMapN.xy))));
          #endif
          altMapN.xy = mat2(0.755, 0.656, -0.656, 0.755) * altMapN.xy;
          altMapN.xy *= normalScale;
          float nw = smoothstep(0.32, 0.68,
            texture2D(uMacro, vWDetailPos.xz * uMacroScale * 1.7 + vec2(0.61, 0.23)).r) * uAntiTile;
          normal = normalize(mix(normal, normalize(tbn * altMapN), nw));
        }
      #endif`;

    /**
     * The soil arm for the bump: the second material's relief, and the water.
     *
     * Flattening the normal where the field says there is standing water is
     * what makes the puddle a puddle. The shoreline is not drawn anywhere - it
     * is wherever the fragment's own world Y passes under the water level (see
     * wdPool), so the margin *is* the terrain contour and cannot be a shape.
     * That is the reason this is a mask over the ground rather than a flat
     * quad: a quad has an authored outline, and an authored outline is the
     * thing a critic calls a decal.
     */
    const soilNormalInject = !useSoil
      ? ""
      : `
      #if defined( USE_NORMALMAP_TANGENTSPACE )
        {
          vec4 wdSn = wdSoil(vWDetailPos.xz);
          ${
            useSoilAlt
              ? `mat2 snrot = mat2(0.878, -0.479, 0.479, 0.878);
                 vec3 sAltN = texture2D(uSoilAltNormal,
                   snrot * vWDetailPos.xz * uSoilAltScale + vec2(0.53, 0.11)).xyz * 2.0 - 1.0;
                 #if defined( USE_PACKED_NORMALMAP )
                   sAltN = vec3(sAltN.xy, sqrt(saturate(1.0 - dot(sAltN.xy, sAltN.xy))));
                 #endif
                 // Counter-rotate, for the same reason the anti-tile arm above
                 // does: a slope sampled on a rotated frame is expressed in that
                 // frame, and handing it to tbn unrotated lights it from the
                 // wrong direction.
                 sAltN.xy = mat2(0.878, 0.479, -0.479, 0.878) * sAltN.xy;
                 sAltN.xy *= normalScale;
                 normal = normalize(mix(normal, normalize(tbn * sAltN), wdSn.a * uSoilGain));`
              : ""
          }
          // Standing water has none of the substrate's relief - it has its own,
          // which is about a degree of slack membrane (see wdRipple). Ramped
          // over the same window the roughness uses so the flat, glossy region
          // and the dark region share one edge.
          //
          // Built in world space and rotated into view space, because that is
          // the frame the ripple is defined in; going through tbn would inherit
          // the substrate's tangent frame, which on a curved pad is not level.
          vec3 wdWaterN = normalize((viewMatrix * vec4(wdRipple(vWDetailPos.xz), 0.0)).xyz);
          normal = normalize(mix(normal, mix(wdGeoNormal, wdWaterN, 0.85),
                                 smoothstep(0.0, 0.020, wdDepth)));
        }
      #endif`;

    /**
     * `uSpecDirect` and `uSpecIBL` exist because GGX over-predicts grazing
     * reflectance on very rough natural surfaces, and because a large
     * near-horizontal surface otherwise reflects the whole bright dawn horizon
     * and turns dark asphalt into a mirror. On dry asphalt they sit at 0.4 and
     * 0.6 respectively and are the right call.
     *
     * On water they are exactly wrong, and wrong in the direction that costs
     * the shot. Water is not a rough natural surface; it is a dielectric with a
     * hard Fresnel, F0 near 0.02 and F90 of 1.0, and a puddle is only ever seen
     * at a grazing angle - which is precisely where Fresnel takes it to near
     * total reflection. Damping F90 to 0.4 and the environment to 0.6 removes
     * the entire effect at the one incidence where it matters. So both are
     * ramped back to unity with the wet mask, over the full range rather than
     * only at the pools: damp pavement between the puddles gets its sheen from
     * the same term, and that sheen is most of what makes a lot read as "it
     * rained last night" rather than as "someone put water here".
     */
    const wetLerp = useSoil ? "mix(%d, 1.0, wdWetAmt)" : "%d";
    const spec = (u: string) => wetLerp.replace("%d", u);
    const specInject = `
      material.specularColor *= ${spec("uSpecDirect")};
      material.specularF90 *= ${spec("uSpecDirect")};`;
    const envInject = `
      #ifdef USE_ENVMAP
        radiance *= ${spec("uSpecIBL")};
        #ifdef USE_CLEARCOAT
          clearcoatRadiance *= ${spec("uSpecIBL")};
        #endif
      #endif`;

    // Every chunk that can name a uniform gets checked against the table. The
    // declaration block itself is generated from that table, so it is exempt.
    assertDeclared(colorInject, "colour injection");
    assertDeclared(roughInject, "roughness injection");
    assertDeclared(normalAntiInject, "normal-map anti-tile injection");
    assertDeclared(soilNormalInject, "soil normal injection");
    assertDeclared(specInject, "specular injection");
    assertDeclared(envInject, "environment injection");
    if (useErode) assertDeclared(erodeInject, "paint erosion injection");
    assertDeclared(decl.slice(decl.indexOf("varying vec3 vWDetailPos;")), "shared helper functions");

    shader.fragmentShader =
      decl +
      shader.fragmentShader
        .replace("#include <map_fragment>", `#include <map_fragment>\n${colorInject}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${roughInject}`)
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n vec3 wdGeoNormal = normal;")
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
           ${normalAntiInject}
           ${soilNormalInject}
           // Aggregate has to stop being gravel by the far field or the lot looks
           // like crumpled foil, but this was pulled in to 4.5-42 m to fix a
           // read that was really caused by having no sun. Under a raking sun
           // the bump is what carries the surface, so it now holds to 22 m and
           // fades out by 120 m rather than being gone by mid-ground.
           ${
             normalFade
               ? `normal = normalize(mix(normal, wdGeoNormal,
             smoothstep(22.0, 120.0, length(vWDetailPos - cameraPosition))));`
               : "// normalFade disabled by the caller (tiling scan)"
           }`
        )
        .replace(
          "#include <alphamap_fragment>",
          `#include <alphamap_fragment>\n${useErode ? erodeInject : ""}`
        )
        .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${specInject}`)
        .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>\n${envInject}`);

    // No feature #defines: whether a block is emitted is decided in JS from the
    // same flags that decide whether its uniforms exist, so the two cannot drift.
  };

  material.customProgramCacheKey = () =>
    `wd:${opts.key}:${useOverlay ? 1 : 0}${useWash ? 1 : 0}${useWheels ? 1 : 0}${useErode ? 1 : 0}${useAnti ? 1 : 0}${wheelViz ? 1 : 0}${useVoid ? 1 : 0}${normalFade ? 1 : 0}${useSoil ? 1 : 0}${useSoilAlt ? 1 : 0}`;
  material.needsUpdate = true;
  return material;
}
