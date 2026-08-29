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
 * Installs the terms on a material and returns it. Safe to call on a material
 * that is shared between meshes; the uniforms are per-material.
 */
export function applyFoliageTransmission<T extends THREE.Material>(
  mat: T,
  opts: TransmissionOptions
): T {
  const wrap = opts.wrap ?? 0.55;
  const strength = opts.strength ?? 1.5;
  const falloff = opts.falloff ?? 3.5;
  const broad = opts.broad ?? 0.45;
  const fill = opts.fill ?? 0.5;

  const uniforms = {
    uSunDir: { value: opts.sun.clone().normalize() },
    uSunCol: { value: opts.sunColour.clone() },
    uTransTint: { value: opts.tint.clone() },
    uWrap: { value: wrap },
    uTransStrength: { value: strength },
    uTransFalloff: { value: falloff },
    uTransBroad: { value: broad },
    uCanopyFill: { value: fill },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vFoliageWorldPos;`
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
         // worldPosition only exists when some other chunk asked for it, so this
         // recomputes rather than depending on a define being set.
         vFoliageWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`
      );

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
  };
  // Changing onBeforeCompile after a program exists needs this, and forgetting
  // it is a silent no-op that looks exactly like the term being too weak.
  //
  // The key must name what varies **in the GLSL**, and nothing else. `wrap`,
  // `strength`, `falloff`, `broad` and `fill` are all passed as uniforms and
  // read as uniforms; not one of them is substituted into the source. Keying on
  // them meant every distinct tuple compiled a byte-identical program under a
  // different key — found by the performance agent, and a real cost: this is
  // called once per foliage material with different strengths by design, so the
  // shader cache was being defeated by exactly the parameters it was supposed to
  // be indifferent to.
  //
  // The general test, worth remembering next time a cache key is written: a
  // value belongs in `customProgramCacheKey` if and only if changing it changes
  // the *text* handed to `compile`. A uniform never does.
  //
  // A leak between call sites was suspected here on 2026-08-29 and it is NOT
  // real. Retracted rather than deleted, because the way it was nearly believed
  // is the useful part:
  //
  // Editing only the thatch-sprig call site appeared to change 306622 pixels,
  // 21% of the frame, including the pine crowns and the sky — which no sprig can
  // reach, and which reads as damning evidence of shared uniforms. Another agent
  // committed to `src/systems/LightingSystem.ts` between the two captures. The
  // diff was measuring their change, not mine. Isolating properly — comparing
  // two of my own rounds that straddle only my edit — puts the true effect at
  // 2562 pixels, entirely in the ground rows, with no crown involvement at all.
  //
  // So the rule above stands, and the general hazard is a cross-round pixel diff
  // in a shared tree: it silently attributes every concurrent edit to the last
  // thing you touched, and it is most convincing when the frame moves in a way
  // your change could not possibly cause. Diff rounds that straddle one edit, and
  // check the mtimes of files you do not own before believing a whole-frame move.
  mat.customProgramCacheKey = () => "foliage-transmission-v2";
  mat.needsUpdate = true;
  return mat;
}
