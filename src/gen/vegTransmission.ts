import * as THREE from "three";

/**
 * Wrap-diffuse plus forward transmission for alpha-tested foliage.
 *
 * Written because the reviewer's sharpest single observation was that "nowhere
 * in the set does a leaf glow with transmitted light, which under a low sun
 * directly behind the foliage is the thing you would expect to dominate", and
 * every camera preset in this scene is back-lit. A 6.2 degree sun behind a pine
 * means almost every visible needle is lit from the far side, so the standard
 * Lambert term evaluates to zero on exactly the geometry the eye is looking at.
 * That is why the crowns measured as "near-black desaturated olive-brown, so
 * dark they lose all hue": not a wrong albedo, a missing light path. I chased
 * the albedo for two rounds instead.
 *
 * Two terms, and they do different jobs:
 *
 *  - **Wrap** softens the terminator by remapping N.L from [-w, 1] to [0, 1], so
 *    a needle whose normal is turned slightly away from the sun still receives
 *    something. This is what stops the crown reading as a hard-edged cutout.
 *  - **Transmission** is the one that matters here: energy coming *through* the
 *    leaf, strongest when the view direction is close to the light direction, so
 *    it peaks precisely in the back-lit poses and vanishes when the sun is
 *    behind the camera. It is tinted separately because light that has passed
 *    through a leaf is more saturated than light that bounced off it.
 *
 * Applied as an additive contribution to outgoing radiance rather than by
 * touching diffuseColor, so it does not lift the shadowed side of trunks or
 * change how the material responds to the environment map.
 */
export interface TransmissionOptions {
  /** Unit vector *toward* the sun, world space. */
  sun: THREE.Vector3;
  /** Scene-referred linear radiance of the sun, for scaling the two terms. */
  sunColour: THREE.Color;
  /** Tint of light that has passed through the leaf. Scene-referred linear. */
  tint: THREE.Color;
  /** Terminator softening, 0 = Lambert. */
  wrap?: number;
  /** Strength of the through-leaf term. */
  strength?: number;
  /** Sharpness of the forward lobe; higher is a tighter halo around the sun. */
  falloff?: number;
  /**
   * Weight of the broad transmission lobe relative to the tight one. The tight
   * lobe is the halo you see looking almost straight into the sun; the broad
   * one is the fact that a crown 40 degrees off the sun axis is still lit
   * through, just less.
   */
  broad?: number;
  /**
   * Intra-canopy multiple scattering, as a fraction of sun radiance. See the
   * long note below; this is the term that answers the self-shadow measurement
   * and it is deliberately not multiplied by the shadow map.
   */
  fill?: number;
}

/**
 * Vertex-stage wind.
 *
 * Studied from `c:\Code\jungle-trail` (`src/world/vegetation.js`), which is the
 * user's own earlier project and the bar they have twice held this one against.
 * Three of its decisions are carried over because each of them is the answer to
 * a way this can look wrong rather than a matter of taste:
 *
 *  - **Displace in world space, not object space.** Every card here is randomly
 *    yawed by its instance matrix, so an object-space push sends each one a
 *    different way and the crown shimmers instead of leaning. One world
 *    direction, and the whole crown moves as air moving through it.
 *  - **Phase from world position.** That is what buys variation across
 *    instances for free. Identical motion on 12,269 cards would look worse than
 *    stillness, and the alternative — a per-instance attribute — is not
 *    available: Perf's quality lever asserts that no vegetation mesh carries a
 *    custom instanced attribute, and it thins meshes by permuting
 *    `instanceMatrix`.
 *  - **Amplitude as the square of a cantilever coordinate.** A real shoot bends
 *    with its base fixed; a linear ramp slides the whole card and reads as a
 *    texture scrolling.
 *
 * The gust is a slow wave travelling across the site rather than a global
 * multiplier, so a gust arrives, crosses the frame and passes. That is the part
 * that reads as air rather than as vertex animation, and it costs one more
 * `sin`.
 *
 * Deliberately *not* carried over: jungle-trail's third harmonic at 4.6 rad/s,
 * and most of its amplitude. Its understory is a rainforest in a breeze; this
 * is a wet pine lot at 6.2 degrees of sun after a night of rain, and a visible
 * sway would contradict the standing water, the long shadows and the silence.
 */
export interface FoliageWindOptions {
  /**
   * Peak excursion of a tip vertex, metres, in world space.
   *
   * Authored against `WIND.strength`; see `WIND_AUTHORED_AT` at the call site.
   * These are small on purpose: 25 mm at a pine tip 13 m up is about one pixel
   * of travel at 20 m, which is the "barely perceptible" the brief asks for.
   */
  amplitude: number;
  /**
   * Object-space distance from the instance origin at which a vertex counts as
   * a tip. Everything at the origin is anchored and does not move at all.
   *
   * Object space rather than world, because the instance matrices carry
   * non-uniform scale and a world-space reach would make a large clump limp and
   * a small one stiff. The geometry's own bounding radius is the right number
   * and it is known on the CPU.
   */
  reach: number;
  /** Shared clock, seconds. Shared *by reference* so one write drives every material. */
  time: { value: number };
  /**
   * Shared `?vegwind=` scale, shared by reference.
   *
   * A scale rather than a toggle, and that is what makes the term verifiable.
   * At shipping amplitude a working wind and a dead wind are indistinguishable
   * in a still frame, so `?vegwind=8` is the only arm that can prove the
   * displacement is wired and that the shadows follow it. At 0 every product
   * below contains an exact zero, so the null arm is bit-identical to no wind —
   * which is what makes the first registered prediction meaningful.
   */
  gain: { value: number };
  /** Unit XZ. The direction the wind blows *toward*, in the sense `site.WIND` documents. */
  direction: THREE.Vector2;
}

export interface FoliageExtras {
  wind?: FoliageWindOptions;
  /**
   * Mip-driven minification damping. Beauty pass only — see the note where it
   * is injected for why the depth pass deliberately does not get it.
   *
   * The number is the atlas width in pixels, which is what turns a UV
   * derivative into a texel footprint.
   */
  dampAtlasPx?: number;
  /**
   * `?vegdamp=` scale, shared by reference. Same argument as the wind gain: a
   * uniform rather than a compile branch, so the control arm and the shipping
   * build run the same program and a diff between them is a diff of pixels.
   * 0 is an exact identity — `vegFar` becomes zero everywhere, which is the
   * state the near field is already in.
   */
  dampGain?: { value: number };
  /**
   * Onset and width of the minification ramp, in stops of texels-per-pixel.
   *
   * These were literals — 0.8 and 2.4, fitted on scrub — until a measurement of
   * the near pine crowns showed the ramp saturating at 9.2 texels per pixel
   * against a crown that samples at 23. A 512-texel texture on a 0.30 m shoot is
   * 1707 texels per metre, so a pine card is minified at every playable
   * distance and the ramp reaches identity only when a card projects to 294 px.
   * "Identity in the near field" was true of the population it was fitted on and
   * false of the one it was applied to.
   *
   * Baked into the shader source rather than passed as a uniform, so sweeping
   * them costs nothing at run time; `customProgramCacheKey` carries them because
   * changing them changes the GLSL.
   */
  dampRamp?: { onset: number; width: number };
}

/** The ramp the scrub was fitted with, and the default for everything but pine. */
export const DAMP_RAMP_DEFAULT = { onset: 0.8, width: 2.4 };

/**
 * The pine crown's own ramp, and a correctness fix rather than an enhancement.
 *
 * `DAMP_RAMP_DEFAULT` was fitted on scrub and applied to pine without
 * rechecking, and the two populations sample at rates an order of magnitude
 * apart. The result was that every pine card at every playable distance sat at
 * full damping, so the near crown got the far crown's alpha dilation and
 * roughness clamp — a distance term that never engaged.
 *
 * 5.2 is measured, not fitted by eye. Rasterising a 13 m pine through a
 * ground-level pose and taking the area-weighted texel footprint over its 6528
 * card triangles gives p5 4.58, median 5.23, p95 6.05 stops. An onset of 5.2
 * therefore leaves about half the near crown at zero damping while a
 * mid-distance crown, three times further out and so 1.6 stops higher, still
 * runs at ~80%. Both ends were then measured on the frame: 0.6% of crown
 * fragmentation recovered in the near field against 0.001 points of
 * mid-distance sky gap, which is the far-field protection this was landed for.
 *
 * The near-field gain is small, and that is the honest finding rather than a
 * disappointing one — the blob is the card's outline, not the alpha inside it,
 * so unsaturating the damping was never going to fix it. This lands because the
 * expression was wrong, not because it makes the crowns better.
 */
export const DAMP_RAMP_PINE = { onset: 5.2, width: 2.0 };

/**
 * Everything that gets injected into a foliage material, installed through one
 * `onBeforeCompile`.
 *
 * The single assignment is the load-bearing part. `onBeforeCompile` is a plain
 * property, so a second `mat.onBeforeCompile = ...` anywhere would silently
 * delete whatever was there before — the material still compiles, still renders
 * and quietly loses the largest visual feature in the vegetation. Composition
 * has to be structural rather than remembered, so there is exactly one place in
 * this file that assigns it and every term is a branch inside it.
 */
function installFoliagePatch<T extends THREE.Material>(
  mat: T,
  parts: { transmission?: TransmissionOptions; extras?: FoliageExtras }
): T {
  const opts = parts.transmission;
  const wind = parts.extras?.wind;
  const atlasPx = parts.extras?.dampAtlasPx;
  const ramp = parts.extras?.dampRamp ?? DAMP_RAMP_DEFAULT;

  const windUniforms = wind
    ? {
      uVegWindTime: wind.time,
      uVegWindGain: wind.gain,
      uVegWindAmp: { value: wind.amplitude },
      uVegWindReach: { value: Math.max(1e-4, wind.reach) },
      uVegWindDir: { value: wind.direction.clone().normalize() },
    }
    : {};
  const dampUniforms = atlasPx
    ? {
      uVegAtlasPx: { value: atlasPx },
      uVegDampGain: parts.extras?.dampGain ?? { value: 1 },
    }
    : {};
  // Built once per material rather than per compile: `onBeforeCompile` can run
  // again after a `needsUpdate`, and a fresh uniform object each time would
  // orphan any handle another system had taken on the old one.
  const transUniforms = opts ? transmissionUniforms(opts) : {};

  /* Chunk order is the whole argument for where this lands, and getting it
   * wrong is silent in both directions.
   *
   * three's vertex order is
   *   begin_vertex -> morphtarget -> skinning -> displacementmap
   *   -> project_vertex -> logdepthbuf -> ... -> worldpos_vertex
   *
   * `project_vertex` is where `instanceMatrix` and `modelMatrix` are applied
   * and where `gl_Position` is written, so it is the LAST point at which a
   * displacement still reaches the rasteriser and the FIRST at which a world
   * position exists for an instanced card. Anything injected after it moves
   * nothing — the vertex-stage twin of the mistake recorded below, where a
   * scene-referred radiance was added after tone mapping and four rounds of
   * raising its strength did nothing.
   *
   * `worldpos_vertex` is then fed the displaced position rather than
   * recomputing from `transformed`, because `worldPosition` is what the shadow
   * lookup and the environment map read. Leaving it undisplaced is how a leaf
   * ends up lit through a shadow of where it used to be.
   */
  const WIND_FN = /* glsl */ `
    uniform float uVegWindTime;
    uniform float uVegWindGain;
    uniform float uVegWindAmp;
    uniform float uVegWindReach;
    uniform vec2  uVegWindDir;

    vec3 vegWindOffset( vec3 wp, vec3 objPos ) {
      // Cantilever coordinate: 0 where the shoot leaves the twig or the blade
      // leaves the ground, 1 at the tip. Squared, because a fixed-base beam
      // deflects roughly as the square of the distance along it.
      float tip = clamp( length( objPos ) / uVegWindReach, 0.0, 1.0 );
      tip *= tip;

      float amp = uVegWindAmp * uVegWindGain * tip;

      // Phase from world position. Two nearby cards are a fraction of a cycle
      // apart, two crowns are unrelated, and none of it costs a byte of
      // per-instance data.
      float ph = wp.x * 0.24 + wp.z * 0.31;

      // A gust that travels. Squared to spend most of its time near zero, so
      // the still air between gusts is the default state and not the mean.
      float gust = 0.5 + 0.5 * sin( uVegWindTime * 0.13 - wp.x * 0.030 - wp.z * 0.024 );
      gust *= gust;

      // 11.4 s and 4.8 s. jungle-trail runs a third harmonic at 1.4 s as well;
      // it is dropped here because it is the one that reads as flutter, and
      // flutter is weather.
      float sway = sin( uVegWindTime * 0.55 + ph ) * 0.62
                 + sin( uVegWindTime * 1.30 + ph * 1.7 ) * 0.28;

      float d = sway * amp * ( 0.30 + 0.70 * gust );
      vec3 o = vec3( uVegWindDir.x, 0.0, uVegWindDir.y ) * d;
      // A shoot that bends also gets shorter. Skipping this is what makes cheap
      // foliage wind look like it is sliding rather than flexing — but it is
      // also the term that costs the most in shadow, because at 6.2 degrees a
      // vertical displacement moves its shadow 9.21x further than a horizontal
      // one does. Kept, at half jungle-trail's weight, and affordable only
      // because the depth pass is displaced too.
      o.y -= abs( d ) * 0.15;
      return o;
    }
  `;

  const PROJECT_WIND = /* glsl */ `
    vec4 vegWindObj = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      vegWindObj = batchingMatrix * vegWindObj;
    #endif
    #ifdef USE_INSTANCING
      vegWindObj = instanceMatrix * vegWindObj;
    #endif
    vec4 vegWindWorld = modelMatrix * vegWindObj;
    vegWindWorld.xyz += vegWindOffset( vegWindWorld.xyz, transformed );
    vec4 mvPosition = viewMatrix * vegWindWorld;
    gl_Position = projectionMatrix * mvPosition;
  `;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, dampUniforms);

    if (wind) {
      // A `String.replace` whose needle is absent is a silent no-op, and this
      // project's dominant defect class is a lever that did nothing. The
      // projection chunk is mandatory in every material this can be installed
      // on, so its absence is a three.js upgrade breaking the patch and must
      // stop the build rather than ship a still crown.
      if (!shader.vertexShader.includes("#include <project_vertex>")) {
        throw new Error(
          "vegTransmission: no <project_vertex> in the vertex shader — the wind " +
            "displacement has nowhere to land that still reaches gl_Position."
        );
      }
      shader.vertexShader = WIND_FN + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", PROJECT_WIND);
      // Absent from `depth_vert`, which is correct and not a failure: the depth
      // pass has no environment map and no shadow lookup of its own, so there
      // is no second consumer of the world position to keep in step.
      shader.vertexShader = shader.vertexShader.replace(
        "#include <worldpos_vertex>",
        "vec4 worldPosition = vegWindWorld;"
      );
    }

    if (atlasPx) installMinificationDamp(shader, ramp);

    if (!opts) return;

    Object.assign(shader.uniforms, transUniforms);

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
         varying vec3 vFoliageWorldPos;`
    );
    // Composed with the wind rather than assigned over it. With wind installed
    // the world position has already been displaced and the `<worldpos_vertex>`
    // needle is gone, so the varying is written from `vegWindWorld` — which is
    // also the more correct value, because the view vector for the transmission
    // lobe should be measured to where the leaf actually is.
    shader.vertexShader = wind
      ? shader.vertexShader.replace(
        "vec4 worldPosition = vegWindWorld;",
        `vec4 worldPosition = vegWindWorld;
         vFoliageWorldPos = vegWindWorld.xyz;`
      )
      : shader.vertexShader.replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         // worldPosition only exists when some other chunk asked for it, so this
         // recomputes rather than depending on a define being set.
         vFoliageWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`
      );

    installTransmissionFragment(shader);
  };

  /* Changing `onBeforeCompile` after a program exists needs this, and
   * forgetting it is a silent no-op that looks exactly like the term being too
   * weak. Bumped v2 -> v3 with the wind and the damping: the injected text
   * changed, and three would otherwise hand back the old program.
   *
   * The key must name what varies **in the GLSL**, and nothing else. `wrap`,
   * `strength`, `falloff`, `broad`, `fill`, the wind amplitude, the reach, the
   * direction and the atlas size are all passed as uniforms and read as
   * uniforms; not one of them is substituted into the source. Keying on them
   * meant every distinct tuple compiled a byte-identical program under a
   * different key — found by the performance agent, and a real cost: this is
   * called once per foliage material with different strengths by design, so the
   * shader cache was being defeated by exactly the parameters it was supposed to
   * be indifferent to.
   *
   * The general test, worth remembering next time a cache key is written: a
   * value belongs in `customProgramCacheKey` if and only if changing it changes
   * the *text* handed to `compile`. A uniform never does. Which of the three
   * terms is *present* does change the text, so each gets a letter.
   *
   * A leak between call sites was suspected here on 2026-08-29 and it is NOT
   * real. Retracted rather than deleted, because the way it was nearly believed
   * is the useful part:
   *
   * Editing only the thatch-sprig call site appeared to change 306622 pixels,
   * 21% of the frame, including the pine crowns and the sky — which no sprig can
   * reach, and which reads as damning evidence of shared uniforms. Another agent
   * committed to `src/systems/LightingSystem.ts` between the two captures. The
   * diff was measuring their change, not mine. Isolating properly — comparing
   * two of my own rounds that straddle only my edit — puts the true effect at
   * 2562 pixels, entirely in the ground rows, with no crown involvement at all.
   *
   * So the rule above stands, and the general hazard is a cross-round pixel diff
   * in a shared tree: it silently attributes every concurrent edit to the last
   * thing you touched, and it is most convincing when the frame moves in a way
   * your change could not possibly cause. Diff rounds that straddle one edit, and
   * check the mtimes of files you do not own before believing a whole-frame move.
   */
  const key =
    "foliage-v3" +
    (opts ? "-t" : "") +
    (wind ? "-w" : "") +
    // The ramp constants are substituted into the source, so by the rule stated
    // above they belong here — unlike every uniform, which does not.
    (atlasPx ? `-d${ramp.onset.toFixed(3)},${ramp.width.toFixed(3)}` : "");
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Wind only, for the custom depth materials.
 *
 * The depth pass does not run the beauty material's `onBeforeCompile`, so
 * without this the crown is displaced on screen and static in the shadow map,
 * and every pine is lit through a shadow of its resting position. At 6.2
 * degrees the arithmetic is not close: 25 mm of horizontal tip travel plus its
 * vertical component puts the worst-case mismatch at about 90 mm on the ground.
 */
export function applyFoliageWind<T extends THREE.Material>(mat: T, wind: FoliageWindOptions): T {
  return installFoliagePatch(mat, { extras: { wind } });
}

/**
 * Installs the terms on a material and returns it. Safe to call on a material
 * that is shared between meshes; the uniforms are per-material.
 */
export function applyFoliageTransmission<T extends THREE.Material>(
  mat: T,
  opts: TransmissionOptions,
  extras: FoliageExtras = {}
): T {
  return installFoliagePatch(mat, { transmission: opts, extras });
}

/**
 * Beauty terms only, for a material whose tier has dropped the transmission
 * program. Wind and minification damping are not tier-gated: one is the
 * difference between a place and a photograph, the other is a correctness fix
 * that matters *more* at low tier, and neither costs a program of its own.
 */
export function applyFoliageBeautyOnly<T extends THREE.Material>(mat: T, extras: FoliageExtras): T {
  return installFoliagePatch(mat, { extras });
}

/**
 * Mip-driven minification damping.
 *
 * **The speckled grey mid-distance is not the leaves, it is the sky between
 * them.** That reframing is the whole of this function and it came from reading
 * `c:\Code\jungle-trail`, which fought the same thing across a whole forest.
 *
 * A foliage card five pixels tall is sampling a mip level where its atlas cell
 * has collapsed to a handful of texels, so the needle gaps, the chewed margin
 * and the alpha-zero corners are all averaged into mid-range alpha. Every one
 * of those values is below `alphaTest`, so the card is eroded from *every edge
 * at once* — and at 6.2 degrees the thing directly behind a mid-distance crown
 * is bright dawn sky, which then shows through the gap between each card and
 * the card it should be touching. Repeated across a few thousand cards that is
 * the pale speckle, and it is a coverage failure rather than a colour one:
 * turning the crowns darker or greener cannot close a hole.
 *
 * So alpha is *dilated* with the footprint rather than merely sharpened, which
 * lets many small cards merge into one larger silhouette — which is what real
 * foliage does at that distance anyway.
 *
 * Two properties make this safe to land on a shipped build:
 *
 *  - **It is the identity at mip 0.** `vFar` is zero until the footprint
 *    exceeds about 1.7 texels per pixel, so the foreground provably cannot
 *    move; a near-field difference would be a bug in this function, not a
 *    judgement call.
 *  - **It reverts by deleting one replace.** No geometry, no placement, no new
 *    material and no new program — the six foliage programs get bigger, they do
 *    not multiply.
 *
 * Deliberately **not** installed on the custom depth materials, and the reason
 * is worth stating because the opposite looks tidier. This project has a
 * recorded case where the beauty pass cut at 0.3 and the shadow pass at 0.5 and
 * 6.9% of drawn pixels cast nothing, concentrated on needle edges — so
 * "silhouette parity between the two passes" is a rule here. Parity is
 * preserved where it can be checked: the ramp is the identity in the near
 * field, which is the only place a crown's own shadow is resolvable. Injecting
 * it into the depth pass would *break* parity rather than keep it, because
 * `fwidth` there measures the shadow map's footprint from the light's
 * viewpoint, not the screen's from the camera's — the two passes would dilate
 * by different amounts on the same texel and the silhouettes would diverge in
 * a way that depends on where the sun is.
 *
 * The normal-flattening half of jungle-trail's version is omitted: it mixes
 * toward `nonPerturbedNormal`, and no foliage material here carries a normal
 * map, so the mix would be an exact no-op. The roughness clamp is kept, because
 * the geometric normals *are* varied — `foliageCardGeometry` fans them outward
 * from the shoot axis — and randomly oriented sub-pixel cards each holding a
 * full-strength specular lobe is aliasing rather than noise, so it does not
 * average away between frames. It sparkles.
 */
function installMinificationDamp(
  shader: { fragmentShader: string },
  ramp: { onset: number; width: number }
): void {
  if (!shader.fragmentShader.includes("#include <map_fragment>")) {
    throw new Error(
      "vegTransmission: no <map_fragment> — the alpha dilation must run while " +
        "there is still an alpha to dilate, i.e. before <alphatest_fragment>."
    );
  }
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       uniform float uVegAtlasPx;
       uniform float uVegDampGain;
       float vegFar = 0.0;`
    )
    // After `<map_fragment>` and therefore before `<alphatest_fragment>`: the
    // dilation has to happen while there is still an alpha to dilate.
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
       #ifdef USE_MAP
         vec2 vegFw = fwidth( vMapUv ) * uVegAtlasPx;
         vegFar = clamp( ( log2( max( max( vegFw.x, vegFw.y ), 1.0 ) ) - ${ramp.onset.toFixed(3)} ) / ${ramp.width.toFixed(3)}, 0.0, 1.0 ) * uVegDampGain;
         diffuseColor.a = mix( diffuseColor.a,
                               smoothstep( 0.06, 0.26, diffuseColor.a ), vegFar );
       #endif`
    )
    .replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
       roughnessFactor = mix( roughnessFactor, 0.97, vegFar );`
    );
}

function transmissionUniforms(opts: TransmissionOptions) {
  return {
    uSunDir: { value: opts.sun.clone().normalize() },
    uSunCol: { value: opts.sunColour.clone() },
    uTransTint: { value: opts.tint.clone() },
    uWrap: { value: opts.wrap ?? 0.55 },
    uTransStrength: { value: opts.strength ?? 1.5 },
    uTransFalloff: { value: opts.falloff ?? 3.5 },
    uTransBroad: { value: opts.broad ?? 0.45 },
    uCanopyFill: { value: opts.fill ?? 0.5 },
  };
}

function installTransmissionFragment(shader: { fragmentShader: string }): void {
  shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vFoliageWorldPos;
         uniform vec3 uSunDir;
         uniform vec3 uSunCol;
         uniform vec3 uTransTint;
         uniform float uWrap;
         uniform float uTransStrength;
         uniform float uTransFalloff;
         uniform float uTransBroad;
         uniform float uCanopyFill;`
      )
      .replace(
        "#include <opaque_fragment>",
        `{
           // Cards are double-sided, so the interpolated normal points whichever
           // way the quad was authored. Foliage has no meaningful inside, and
           // signing the normal toward the viewer is what lets one term serve
           // both faces instead of half the crown going black.
           vec3 fN = normalize( normal );
           vec3 fV = normalize( cameraPosition - vFoliageWorldPos );
           if ( dot( fN, fV ) < 0.0 ) fN = -fN;

           float ndl = dot( fN, uSunDir );
           // Wrapped diffuse: remap [-uWrap, 1] to [0, 1] and normalise so the
           // fully lit case is unchanged and only the terminator moves.
           float wrapped = max( 0.0, ( ndl + uWrap ) / ( 1.0 + uWrap ) );
           float lambert = max( 0.0, ndl );
           float wrapGain = max( 0.0, wrapped - lambert );

           // Through-leaf, in two lobes.
           //
           // The tight lobe is the halo when you look almost straight into the
           // sun. On its own it was the whole term, and pow(forward, 3.5)
           // is down to 0.09 at 60 degrees off axis, so a crown at the edge of
           // a frame got essentially nothing — the term was present in the
           // shader and absent from most of the pixels.
           float forward = max( 0.0, dot( -fV, uSunDir ) );
           float tight = pow( forward, uTransFalloff );
           // Half-angle lobe: 1 looking into the sun, 0.25 across it, 0 away.
           // Wide enough that side-lit foliage still transmits.
           float wide = 0.5 + 0.5 * dot( -fV, uSunDir );
           wide = wide * wide;
           float back = max( 0.0, -ndl + uWrap );
           float through = ( tight + uTransBroad * wide ) * back;

           // Intra-canopy multiple scattering.
           //
           // This is the answer to the measurement in HANDOVER-vegetation.md:
           // with foliage shadow casting on, the crowns lose 5.5 luma and, more
           // tellingly, go from R-B +4.0 to -1.8. They are not merely dark;
           // they have lost the *warm* component entirely and are left lit by
           // cool sky, while the building in the same frame takes hard direct
           // sun. The cause is a binary shadow test through 8972 alpha-tested
           // cards at a 6.2 degree sun: geometrically, almost every needle is
           // behind another needle, so the test says "occluded" almost
           // everywhere and delivers zero.
           //
           // Zero is the wrong answer. A real needle canopy is not opaque. Sun
           // enters at the lit edge and reaches the interior after one or more
           // transmissions and bounces between needles, and that light is still
           // sun-coloured — warmed and greened by what it passed through, not
           // replaced by skylight. A shadow map cannot produce it at any
           // resolution, because it is not a visibility question.
           //
           // So this term is deliberately NOT multiplied by the shadow. It is
           // weighted by ( 1 - wrapped ), i.e. it only appears where the direct
           // path has already given nothing, so it cannot double-count the lit
           // face, and it is weighted by the wide lobe so a crown lit from
           // behind fills more than one lit from the side.
           //
           // The honest limitation: it also fills foliage shadowed by the
           // *building* rather than by itself, which is over-lighting. There is
           // little such foliage in these presets and the alternative is
           // reading the shadow map, which would make this term inherit exactly
           // the over-occlusion it exists to correct.
           float fillW = uCanopyFill * ( 1.0 - clamp( wrapped, 0.0, 1.0 ) ) * ( 0.35 + 0.65 * wide );

           vec3 leaf = diffuseColor.rgb;
           vec3 gain = uSunCol * (
               leaf * wrapGain
             + leaf * uTransTint * through * uTransStrength
             + leaf * uTransTint * fillW
           );
           // Weighted by alpha so the contribution follows the needle mask and
           // does not halo across the transparent part of the card.
           //
           // Added to outgoingLight, i.e. BEFORE tone mapping and before the
           // transfer encode. This was the defect, and it is the reason four
           // rounds of raising \`strength\` never moved the backlit crowns:
           //
           //   three.js chunk order at the end of meshphysical_frag is
           //     opaque_fragment -> tonemapping_fragment -> colorspace_fragment
           //     -> fog_fragment -> premultiplied_alpha -> dithering_fragment
           //
           // and this block was injected at dithering_fragment, the LAST of
           // them. So a scene-referred linear radiance was being added to an
           // ACES-tone-mapped, sRGB-encoded value in roughly 0..1. It was not
           // light; it was paint, applied after the camera. Measured on the
           // sunlit preset, scaling it by EIGHT bought +1.6 luma and +2.5 R-B
           // against a deficit of +5.6 / +6.1 — a term that cannot reach its
           // target at 8x its authored strength is not weak, it is in the wrong
           // place, and turning the knob further would only have flattened the
           // highlights it was pasted over.
           //
           // This is NOTES case 24 running backwards. That case is
           // display-referred values entering a linear pipeline; this is a
           // linear value entering a display-referred one. Same class, opposite
           // direction, and neither is visible to a brightness check.
           outgoingLight += gain * diffuseColor.a;
         }
         #include <opaque_fragment>`
      );
}
