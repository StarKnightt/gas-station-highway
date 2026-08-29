import * as THREE from "three";

/**
 * Couples a pane's transmission to Fresnel, so glass stops transmitting as the
 * view grazes it.
 *
 * ## Why this is not a parameter
 *
 * The glazing is two coincident leaves: an alpha-blended one carrying
 * transmission, and an additively-blended one carrying the environment
 * reflection. Separating them fixed a reflection that was being scaled by
 * `opacity` — see the long note at the `glass` material in `BuildingSystem`,
 * and NOTES case 39 — and it is what makes the reflection now measure +18.5
 * luma at grazing incidence against +4.0 head-on.
 *
 * But it left the transmission leaf transmitting its full `1 - opacity` at
 * every angle. A real pane does not: the light that reflects is light that did
 * not get through, and at grazing incidence essentially none of it gets
 * through. So the separated pane was double-counting — full transmission *and*
 * full reflection — and grazing panes were brighter than the truth.
 *
 * The correction cannot be an opacity value, because it is a function of the
 * viewing angle and `opacity` is a constant. Nor is it just alpha. Under alpha
 * blending the frame gets
 *
 *     out = bg * (1 - a) + tint * a
 *
 * and the physics wants the background coefficient to be `(1 - F)(1 - a0)`,
 * which gives `a = 1 - (1 - F)(1 - a0)`. Driving alpha alone would make a
 * grazing pane show its own bright body tint at full weight — a milky white
 * panel where a mirror belongs — because the tint term is multiplied by the
 * alpha that just went to 1. The body colour is *also* seen through the glass
 * and has to fall with `1 - F` as well, so `tint` is rescaled to keep
 * `tint * a` equal to `tint0 * (1 - F) * a0`. Both halves, or the fix looks
 * worse than the bug.
 *
 * At normal incidence `F = 0.043` and almost nothing changes. At grazing, alpha
 * goes to 1 and the diffuse goes to zero, so the pane occludes the background
 * completely and contributes nothing of its own — and the additive reflection
 * leaf, which this does not touch, is the entire image. That is a mirror, and
 * it is the behaviour the door interaction needs: the panes either side of the
 * door should close up and go reflective as you walk in on them.
 *
 * ## Injection point
 *
 * `normal_fragment_maps`, which is the first place in the physical shader where
 * a shading normal exists, and long before `lights_fragment_begin` consumes
 * `diffuseColor` or `opaque_fragment` consumes its alpha. It is also, note,
 * before `tonemapping_fragment` and the sRGB encode — this modifies a
 * scene-referred quantity on the way in, not a display-referred one on the way
 * out, which is the mistake Vegetation found at `dithering_fragment`.
 *
 * Apply to transmission leaves only, and only after every clone of them has
 * been taken. On a reflection leaf it would be nearly harmless — alpha is
 * already 1 and the diffuse is already black — but it would cost a second
 * program for no reason.
 */
export function applyGlazingFresnel(
  material: THREE.MeshPhysicalMaterial,
  opts: { key: string; amount?: number }
): THREE.MeshPhysicalMaterial {
  const amount = opts.amount ?? 1;
  if (amount <= 0) return material;

  /**
   * F0 for the air/glass interface at `ior` 1.52: `((n-1)/(n+1))^2`. Taken from
   * the material rather than authored, so it cannot drift away from the `ior`
   * the reflection leaf's BRDF is using — the two have to agree or the pane
   * reflects one amount and stops transmitting a different one.
   */
  const n = material.ior ?? 1.5;
  const f0 = ((n - 1) / (n + 1)) ** 2;

  const prior = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    prior?.(shader, renderer);
    shader.uniforms.uBgF0 = { value: f0 };
    shader.uniforms.uBgAmount = { value: amount };

    const needle = "#include <normal_fragment_maps>";
    if (!shader.fragmentShader.includes(needle)) {
      throw new Error(`applyGlazingFresnel(${opts.key}): shader has no '${needle}' to inject into`);
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      needle,
      `${needle}
      {
        float bgCos = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
        float bgF = uBgF0 + (1.0 - uBgF0) * pow(1.0 - bgCos, 5.0);
        bgF *= uBgAmount;
        float bgA0 = diffuseColor.a;
        float bgA = 1.0 - (1.0 - bgF) * (1.0 - bgA0);
        // Keep tint * a invariant to what alpha just did, so the body colour
        // falls with (1 - F) instead of being amplified by the alpha rise.
        diffuseColor.rgb *= (1.0 - bgF) * bgA0 / max(bgA, 1e-4);
        diffuseColor.a = bgA;
      }`
    );

    shader.fragmentShader = `uniform float uBgF0;\nuniform float uBgAmount;\n${shader.fragmentShader}`;
  };

  material.customProgramCacheKey = () => `bgfres:${opts.key}`;
  material.needsUpdate = true;
  return material;
}
