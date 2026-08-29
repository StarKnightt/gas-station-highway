import * as THREE from "three";

export interface BuildingWeatherOptions {
  /** Distinct per material: three caches compiled programs by this key. */
  key: string;
  /** Low frequency tiling noise, sampled in world space to break up the bands. */
  macro: THREE.Texture;
  /** World metres per macro tile. */
  macroMetres?: number;

  /** World Y that "the ground" sits at for this surface. */
  baseY: number;
  /** How far up the wall the ground-up dirt gradient reaches, in metres. */
  grimeRise?: number;
  /** Colour the grime tints toward. */
  grimeColor?: THREE.Color;
  /** Peak strength of the grime at the very bottom. */
  grimeStrength?: number;

  /**
   * A second, tighter dirty band: rain splashback outside (0 - 0.35 m) or the
   * mop-and-shoe line inside (0.05 - 0.30 m). Given as [y0, y1] above `baseY`.
   */
  band?: [number, number];
  bandStrength?: number;

  /** Direction *to* the sun. Faces pointing at it chalk and fade. */
  sunDir?: THREE.Vector3;
  /** How much the sun-facing side bleaches (0 = off). */
  fade?: number;

  /** Extra darkening on downward-facing surfaces (soffits, undersides). */
  soffit?: number;

  /**
   * Rain washing off a horizontal top edge and streaking down the face below
   * it: `[worldY of the edge, metres it runs before it dries out]`. This is the
   * dirt pattern under a coping cap or a sign fascia, and it is the difference
   * between a painted band and a band that has stood outside for ten years.
   */
  drip?: [number, number];
  dripStrength?: number;

  /**
   * Metres between the *sources* the runoff comes out of, along the elevation.
   *
   * Without this the drip is a continuous curtain hanging off the whole top
   * edge, which is the thing that makes a weathered wall read as a dirty
   * texture rather than as a wall that water has run down. Real staining under
   * a parapet comes out of discrete points — the joints between coping cap
   * sections, the fixings through them, the ends of a sill — and the wall in
   * between them stays comparatively clean. A 3.05 m pitch is a ten-foot cap
   * section, which is what this parapet is capped with.
   *
   * Leave undefined for the old continuous behaviour. Sources are placed on a
   * real along-wall metre coordinate, so each elevation gets its own run of
   * cap sections rather than one comb wrapping the corner.
   */
  dripPitch?: number;

  /**
   * Metre-scale blotchiness in the paint itself, independent of the dirt:
   * roller laps, repaint patches over old damage, rain shadow. Without it a
   * 12 m elevation photographs as one flat swatch.
   */
  patchiness?: number;
  /**
   * How far the paint colour drifts between elevations, 0..1. Two walls
   * painted at different times never match, and a corner where they do match
   * exactly is one of the quieter CG tells.
   */
  elevationDrift?: number;

  /**
   * ### Terrain's published accumulation field, baked to a top-down lookup.
   *
   * R channel is `groundAccum.fines(x, z)` sampled over `accumRect`. When this
   * is supplied the splash zone stops being locally authored and becomes *the
   * site's own* — the height profile below is `groundAccum.wallBase()`'s to the
   * digit, the wind term is the shared `site.WIND`, and the magnitude is scaled
   * by how dirty this particular patch of ground is.
   *
   * The reason to consume a service rather than keep a good local model: five
   * systems each with their own plausible dirt distribution puts the dirt in
   * five disagreeing sets of places, and disagreement between neighbouring
   * objects is far more visible than any one of them being slightly wrong. A
   * wall whose base is filthy where the pavement beside it is swept clean is a
   * tell that no amount of tuning inside either object can fix.
   */
  accumField?: THREE.Texture;
  /** `[minX, minZ, maxX, maxZ]` world rect the field covers. */
  accumRect?: [number, number, number, number];
  /** Prevailing wind as `(dirX, dirZ)`, the direction it blows *toward*. */
  windDir?: THREE.Vector2;
  /** Peak coverage of the debris line in the bottom 90 mm. */
  driftStrength?: number;

  /** Master multiplier. The debug harness drives this to an absurd value. */
  amount?: number;
}

/**
 * World-space weathering injected into a stock MeshStandardMaterial.
 *
 * Everything here is a function of world position and world normal rather than
 * UV, which is the whole point: the dirt gradient has to run round a corner
 * without a seam, and the sun-fade has to know which elevation it is on. Doing
 * it in the texture would need a unique unwrap per wall.
 *
 * The rust streaks and the heavy scuffs are deliberately NOT here - those are
 * placed decals, because they have to land exactly under the scupper and
 * exactly beside the door.
 */
export function applyBuildingWeather(material: THREE.MeshStandardMaterial, opts: BuildingWeatherOptions) {
  const {
    macro,
    macroMetres = 6.5,
    baseY,
    grimeRise = 1.5,
    grimeColor = new THREE.Color(0x5c5344),
    grimeStrength = 0.55,
    band,
    bandStrength = 0.35,
    sunDir,
    fade = 0,
    soffit = 0,
    drip,
    dripStrength = 0.4,
    dripPitch = 0,
    patchiness = 0,
    elevationDrift = 0,
    accumField,
    accumRect,
    windDir,
    driftStrength = 0.35,
    amount = 1,
  } = opts;

  const useAccum = !!accumField && !!accumRect && !!windDir;
  if (!!accumField !== (!!accumRect && !!windDir)) {
    // Half-supplied would silently fall back to the local model and look like
    // the service simply not mattering, which is the failure this project keeps
    // catching after the fact.
    throw new Error(`applyBuildingWeather(${opts.key}): accumField needs accumRect and windDir together`);
  }
  const useBand = !!band;
  const useFade = !!sunDir && fade > 0;
  const useDrip = !!drip;
  const usePatch = patchiness > 0 || elevationDrift > 0;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBwMacro = { value: macro };
    shader.uniforms.uBwMacroScale = { value: 1 / macroMetres };
    shader.uniforms.uBwBaseY = { value: baseY };
    shader.uniforms.uBwRise = { value: grimeRise };
    shader.uniforms.uBwGrime = { value: grimeColor };
    shader.uniforms.uBwGrimeK = { value: grimeStrength };
    shader.uniforms.uBwSoffit = { value: soffit };
    shader.uniforms.uBwAmount = { value: amount };
    if (useBand) {
      shader.uniforms.uBwBand = { value: new THREE.Vector2(band![0], band![1]) };
      shader.uniforms.uBwBandK = { value: bandStrength };
    }
    if (useFade) {
      shader.uniforms.uBwSun = { value: sunDir!.clone() };
      shader.uniforms.uBwFade = { value: fade };
    }
    if (useDrip) {
      shader.uniforms.uBwDrip = { value: new THREE.Vector2(drip![0], Math.max(drip![1], 0.05)) };
      shader.uniforms.uBwDripK = { value: dripStrength };
      shader.uniforms.uBwDripPitch = { value: dripPitch };
    }
    if (useAccum) {
      shader.uniforms.uBwAccum = { value: accumField };
      shader.uniforms.uBwAccumRect = {
        value: new THREE.Vector4(accumRect![0], accumRect![1], accumRect![2] - accumRect![0], accumRect![3] - accumRect![1]),
      };
      shader.uniforms.uBwWind = { value: windDir!.clone() };
      shader.uniforms.uBwDriftK = { value: driftStrength };
    }
    if (usePatch) {
      shader.uniforms.uBwPatch = { value: new THREE.Vector2(patchiness, elevationDrift) };
    }
    material.userData.weatherShader = shader;

    shader.vertexShader =
      "varying vec3 vBwPos;\nvarying vec3 vBwNormal;\n" +
      shader.vertexShader
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
           vBwNormal = normalize(mat3(modelMatrix) * objectNormal);`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           vBwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

    const decl = `
      uniform sampler2D uBwMacro;
      uniform float uBwMacroScale;
      uniform float uBwBaseY;
      uniform float uBwRise;
      uniform vec3 uBwGrime;
      uniform float uBwGrimeK;
      uniform float uBwSoffit;
      uniform float uBwAmount;
      ${useBand ? "uniform vec2 uBwBand;\n uniform float uBwBandK;" : ""}
      ${useFade ? "uniform vec3 uBwSun;\n uniform float uBwFade;" : ""}
      ${useDrip ? "uniform vec2 uBwDrip;\n uniform float uBwDripK;\n uniform float uBwDripPitch;" : ""}
      ${usePatch ? "uniform vec2 uBwPatch;" : ""}
      ${
        useAccum
          ? `uniform sampler2D uBwAccum;
             uniform vec4 uBwAccumRect;
             uniform vec2 uBwWind;
             uniform float uBwDriftK;`
          : ""
      }
      varying vec3 vBwPos;
      varying vec3 vBwNormal;

      // Wall-friendly noise coordinate: mixes the two horizontal axes so a
      // north wall and an east wall never sample the same column of noise.
      vec2 bwUv(float scale, vec2 off) {
        return vec2(vBwPos.x * 0.63 + vBwPos.z * 0.51, vBwPos.y) * scale + off;
      }

      // Metre coordinate *along* whichever elevation this fragment is on. Used
      // for anything that has to line up with real building components — cap
      // sections, fixings — as opposed to the noise lookups, which deliberately
      // mix the axes so two walls never sample the same column.
      float bwAlong() {
        return (abs(vBwNormal.x) > abs(vBwNormal.z)) ? vBwPos.z : vBwPos.x;
      }

      float bwHash(float n) {
        return fract(sin(n * 12.9898 + 4.1414) * 43758.5453);
      }

      // Total dirt coverage at this fragment, 0..1. Shared by the albedo and
      // roughness injections so they can never disagree.
      float bwGrime() {
        float h = vBwPos.y - uBwBaseY;
        float n1 = texture2D(uBwMacro, bwUv(uBwMacroScale, vec2(0.13, 0.41))).r;
        float n2 = texture2D(uBwMacro, bwUv(uBwMacroScale * 4.3, vec2(0.71, 0.19))).r;
        // How vertical this face is. Splash and runoff are both wall effects;
        // a soffit or a cap gets neither.
        float bwVert = 1.0 - clamp(abs(vBwNormal.y) * 2.0, 0.0, 1.0);
        // A ragged rise height, so the gradient is a tide line rather than a
        // ramp. A perfectly even gradient up a wall reads as a vignette.
        float rise = uBwRise * (0.45 + n1 * 1.25);
        float g = (1.0 - smoothstep(0.0, max(rise, 0.05), h)) * (0.55 + n2 * 0.8);
        g *= uBwGrimeK;
        ${
          useBand
            ? `// The splash zone, and the dirt line at the top of it.
               //
               // This was a smooth ramp, which is a gradient and not a splash
               // zone: what rain actually does to the bottom of a wall is
               // throw individual marks up off the paving, densest at the
               // ground and thinning to a fairly abrupt terminus at the height
               // the drops stop reaching. The line is what the eye reads —
               // every real building has one and no ramp implies one.
               float bTop = uBwBand.y * (0.72 + n1 * 0.62);
               float bIn = 1.0 - smoothstep(bTop * 0.84, bTop, max(h - uBwBand.x, 0.0));
               ${
                 useAccum
                   ? `// Terrain's profile replaces the locally authored envelope.
                      //
                      // \`groundAccum.wallBase(0, h, n.x, n.z).splash\`, to the
                      // digit: 180 mm e-folding off grade, and 0.55 + 0.45 on the
                      // face driven into the wind. The ragged multiplier stays,
                      // because the *height* is the site's business and the
                      // *texture* is this material's, and an exponential with no
                      // noise on it reads as a vignette (which is what the
                      // envelope this replaces was originally fixing).
                      //
                      // Scaled by fines(x, z), so the wall is filthy exactly
                      // where the pavement beside it is filthy. That is the
                      // entire point of consuming the service: not a better
                      // curve, an *agreeing* one.
                      /**
                       * ### The field is normalised and floored, and that is not
                       * ### a fudge — a bare multiply was measurably wrong.
                       *
                       * \`fines\` measures **0.11 to 0.21 along the front
                       * elevation and 0.013 to 0.047 behind the building**, not
                       * 0 to 1: the forecourt is swept by tyres and feet and the
                       * field's own \`(1 - swept * 0.85)\` term says so. Used as
                       * a bare multiplier on a 0.34 coverage it gave a peak of
                       * 0.033 — a 3% tint — and the first capture of this change
                       * measured a mean delta of 5.3 luma in the *cleaning*
                       * direction. Consuming a published field as a bare
                       * multiplier silently assumes its range is 0..1 and
                       * centred, and **the range of a field is part of its
                       * contract**; nothing about the call site reveals the
                       * assumption, and the symptom is a feature that quietly
                       * does not appear.
                       *
                       * Physically the floor is right too. Splash is rain
                       * bouncing off paving, and rain bounces off swept paving
                       * just as hard; what varies is how much loose matter it
                       * picks up. So the site's dirtiness should *modulate* the
                       * dirt line, not gate it. Normalised against the 0.22 the
                       * field actually reaches here, this runs the splash from
                       * 0.5x on the swept forecourt to 1.35x in the sheltered
                       * back corner — which is the agreement that matters, since
                       * what reads is the wall being dirtier where the ground
                       * beside it is dirtier, not any absolute value.
                       */
                      float aRaw = texture2D(uBwAccum, (vBwPos.xz - uBwAccumRect.xy) / uBwAccumRect.zw).r;
                      float aF = mix(0.5, 1.35, clamp(aRaw / 0.22, 0.0, 1.0));
                      float aFace = -(vBwNormal.x * uBwWind.x + vBwNormal.z * uBwWind.y);
                      float aUp = max(h - uBwBand.x, 0.0);
                      bIn = exp(-aUp / (0.18 * (0.6 + n1 * 0.9))) * (0.55 + 0.45 * max(aFace, 0.0)) * aF;
                      // The debris line: drift at distOut ~ 0, which wallBase
                      // puts in the bottom 90 mm only and on the *sheltered*
                      // face, deliberately opposite to splash. This is the
                      // horizontal dirt line the critic said was missing, and it
                      // is now in the same place as everyone else's.
                      float aDrift = (1.0 - smoothstep(0.0, 0.09, aUp)) * (0.5 + 0.5 * max(-aFace, 0.0));
                      g += aDrift * aF * uBwDriftK * bwVert;`
                   : ""
               }
               // Individual marks, not a wash. Gated hard so only the peaks of
               // the field land, and the gate opens as it approaches the
               // ground so the spatter closes up into continuous dirt there.
               float bSpat = texture2D(uBwMacro, bwUv(uBwMacroScale * 11.0, vec2(0.29, 0.62))).g;
               float bDens = 1.0 - clamp(max(h - uBwBand.x, 0.0) / max(bTop, 0.02), 0.0, 1.0);
               float bMark = smoothstep(0.60 - bDens * 0.44, 0.86 - bDens * 0.34, bSpat);
               g += bIn * uBwBandK * mix(0.30, 1.28, bMark) * mix(0.45, 1.0, bwVert);`
            : ""
        }
        ${
          useDrip
            ? `// Runoff off the edge above. Vertical: the noise is stretched
               // hard in Y so it resolves into threads rather than blotches,
               // and it only applies to near-vertical faces.
               float dFall = clamp((uBwDrip.x - vBwPos.y) / uBwDrip.y, 0.0, 1.0);
               float dTop = smoothstep(-0.06, 0.02, uBwDrip.x - vBwPos.y);
               // Stretched harder than it was (0.06 -> 0.035) and gated
               // tighter. At the old settings the runs resolved as soft
               // blotches hanging off the parapet rather than as threads, and
               // a blotch does not read as water having gone anywhere.
               float dThread = texture2D(uBwMacro, bwUv(uBwMacroScale * 5.0, vec2(0.37, 0.0)) * vec2(1.0, 0.035)).r;
               // Sources. Runoff leaves the cap at the joints between sections
               // and at the fixings, not evenly off the whole edge, so the
               // curtain is combed down to a few runs per elevation. Each run
               // widens as it falls, which is what a real stain does.
               float dSrc = 1.0;
               if (uBwDripPitch > 0.0) {
                 float dCell = bwAlong() / uBwDripPitch;
                 float dIdx = floor(dCell);
                 float dRa = bwHash(dIdx);
                 float dRb = bwHash(dIdx + 37.0);
                 float dPos = 0.5 + (dRa - 0.5) * 0.55;
                 float dW = (0.05 + dRb * 0.09) * (1.0 + dFall * 1.6);
                 float dNear = 1.0 - smoothstep(dW * 0.3, dW, abs((dCell - dIdx) - dPos));
                 // Most joints are dry. The ones that run, run hard.
                 dSrc = 0.16 + 0.84 * dNear * smoothstep(0.28, 0.66, dRb);
               }
               g += dTop * bwVert * (1.0 - dFall) * uBwDripK * dSrc * (0.28 + smoothstep(0.44, 0.74, dThread) * 1.25);`
            : ""
        }
        // Anything looking down collects dust and loses sky light.
        g += clamp(-vBwNormal.y, 0.0, 1.0) * uBwSoffit;
        return clamp(g * uBwAmount, 0.0, 1.0);
      }
    `;

    const colorInject = `
      float bwG = bwGrime();
      diffuseColor.rgb = mix(diffuseColor.rgb, uBwGrime * (0.5 + bwG * 0.5), bwG * 0.75);
      ${
        usePatch
          ? `// Paint, not dirt. Two bands of blotch at different scales, plus a
             // flat per-elevation offset keyed off the world normal so no two
             // walls are quite the same colour where they meet at a corner.
             float bwP1 = texture2D(uBwMacro, bwUv(uBwMacroScale * 0.30, vec2(0.55, 0.27))).r - 0.5;
             float bwP2 = texture2D(uBwMacro, bwUv(uBwMacroScale * 1.15, vec2(0.09, 0.83))).r - 0.5;
             float bwPatchV = (bwP1 * 1.0 + bwP2 * 0.55) * uBwPatch.x * uBwAmount;
             vec3 bwN2 = normalize(vBwNormal);
             float bwElev = (bwN2.x * 0.63 - bwN2.z * 0.41 + bwN2.y * 0.22);
             diffuseColor.rgb *= 1.0 + bwPatchV * 0.22;
             // Drift hue as well as value: repaints are never colour-matched.
             diffuseColor.rgb *= vec3(1.0 + bwElev * uBwPatch.y,
                                      1.0 + bwElev * uBwPatch.y * 0.55,
                                      1.0 - bwElev * uBwPatch.y * 0.65);`
          : ""
      }
      ${
        useFade
          ? `// Sun-facing paint chalks: it loses saturation and gains value,
             // which is the opposite of what dirt does and is why an elevation
             // that gets the afternoon sun never matches the one that does not.
             float bwSun = clamp(dot(normalize(vBwNormal), normalize(uBwSun)), 0.0, 1.0);
             float bwF = pow(bwSun, 0.65) * uBwFade * uBwAmount;
             float bwLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bwLum) * 1.06 + 0.03, bwF);`
          : ""
      }
    `;

    const roughInject = `
      float bwGR = bwGrime();
      roughnessFactor = clamp(roughnessFactor + bwGR * 0.3, 0.03, 1.0);
      ${useFade ? "roughnessFactor = clamp(roughnessFactor + pow(clamp(dot(normalize(vBwNormal), normalize(uBwSun)), 0.0, 1.0), 0.65) * uBwFade * 0.25, 0.03, 1.0);" : ""}
    `;

    shader.fragmentShader =
      decl +
      shader.fragmentShader
        .replace("#include <map_fragment>", `#include <map_fragment>\n${colorInject}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${roughInject}`);
  };

  material.customProgramCacheKey = () =>
    `bw:${opts.key}:${useBand ? 1 : 0}${useFade ? 1 : 0}${useDrip ? 1 : 0}${usePatch ? 1 : 0}${dripPitch > 0 ? 1 : 0}${
      useAccum ? 1 : 0
    }`;
  material.needsUpdate = true;
  return material;
}
