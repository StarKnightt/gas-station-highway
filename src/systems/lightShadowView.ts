import * as THREE from "three";

/**
 * Displays the *actual allocated* sun shadow map as a screen overlay, under
 * `?shadowview=1`.
 *
 * ## Why this exists rather than another parameter sweep
 *
 * A pale rectangular artefact on the car door survived six ablations: shadow
 * `normalBias`, caster frustum depth, shadow distance, my PCF shader patch
 * (stock three reproduced it to 0.1 of a luma level), contact hardening (reduced
 * 23%, not removed), and a 4x sweep of shadow map resolution (block size flat
 * within 6%). It vanishes completely when `sun.castShadow` is turned off.
 *
 * Immune to bias, frustum, filter *and* resolution, while still requiring
 * shadows to exist, is not a weak signal. **Sampling parameters cannot all be
 * irrelevant to a feature produced by sampling.** The one thing that behaves
 * that way is a region of the map that was never written to: depth cleared to
 * far returns "lit" for every tap regardless of bias, tap pattern, filter width,
 * frustum extent or texel size, and its boundary is axis-aligned in shadow-map
 * space, which projects to axis-aligned on a vertical car panel.
 *
 * So the question stopped being "which occluder is missing" and became "why is
 * part of the shadow map blank", and the instrument for that is the map itself.
 * Sweeping a seventh parameter could only produce a seventh null.
 *
 * ## What it draws
 *
 * The frame is split, with the whole shadow map squeezed into each half:
 *
 * - **Left, green** — the control, at comparison reference 0.0. Every possible
 *   stored depth passes, so this half must be solid green. It exists so that a
 *   dark right half means something.
 * - **Right, magenta** — the measurement, at reference `FAR_EPS`. Bright only
 *   where the stored depth sits at the far plane, i.e. texels no caster ever
 *   wrote to. Magenta because this project already uses it for non-finite
 *   environment texels.
 *
 * So: green half solid and right half black means the map is fully written and
 * this hypothesis is dead. Green half solid and a magenta *rectangle* on the
 * right is the artefact's source located.
 *
 * ## Read the map through the sampler three already bound, and never mutate it
 *
 * Three binds the shadow depth texture in **comparison mode**, so it must be
 * read as a `sampler2DShadow`. The first version instead cleared
 * `compareFunction` and set `needsUpdate = true` so it could read a plain
 * `sampler2D`, and got a uniformly black frame — depth 0 everywhere, which no
 * real shadow map contains. Two mechanisms could produce that and both are
 * traps worth naming:
 *
 * 1. `needsUpdate = true` on a texture whose storage belongs to a render target
 *    asks three to re-upload it from `texture.image`, which does not exist for
 *    a render-target attachment. **Marking a render-target texture dirty can
 *    destroy the contents you were trying to inspect.**
 * 2. Sampling a comparison-mode texture through a plain `sampler2D` is
 *    undefined in WebGL2. It does not error; it returns something.
 *
 * Either way the instrument had corrupted its own subject. So this version
 * mutates nothing and reads through the comparison sampler, which needs no
 * state change and cannot disturb the shadow the rest of the frame is using.
 *
 * The cost is that a comparison sampler returns a 0/1 test rather than a depth,
 * which turns out to be exactly enough: "is this texel at the far plane" *is*
 * the question, and it is one comparison. See the split-screen control in the
 * fragment shader — a measurement that cannot distinguish "nothing found" from
 * "read failed" is not a measurement, and that is precisely how the first
 * version's black frame wasted a round.
 */

const FAR_EPS = 0.9999;


export interface ShadowViewResult {
  /** Parented to the camera, so it needs no per-frame update. */
  readonly mesh: THREE.Mesh;
  /** Reported into `__LIGHTING` so a capture can assert the view was live. */
  readonly info: Record<string, unknown>;
}

/**
 * @param light the shadow-casting sun
 * @param scene the render scene; the quad must join *this* graph to be drawn
 * @param camera unused, kept so callers do not have to know why
 */
export function createShadowMapView(
  light: THREE.DirectionalLight,
  scene: THREE.Scene,
  camera: THREE.Camera
): ShadowViewResult {
  const target = light.shadow.map as THREE.WebGLRenderTarget | null;
  if (!target) {
    // The map is allocated on the first shadow render, or by Perf's
    // preallocation. Absent here means the caller ran too early, and returning
    // a black quad would look like an all-near map.
    throw new Error(
      `[lighting] ?shadowview=1 ran before light.shadow.map existed, so there is nothing to display. ` +
        `Call createShadowMapView after the first render or after preallocateShadowMaps.`
    );
  }

  const depth = target.depthTexture as THREE.DepthTexture | null;
  const tex = depth ?? target.texture;
  if (!tex) {
    throw new Error(`[lighting] ?shadowview=1 found a shadow render target with neither depthTexture nor texture.`);
  }

  const hadCompare = (depth?.compareFunction ?? null) !== null;

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tMap: { value: tex },
      uFarEps: { value: FAR_EPS },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Already in clip space: the quad is fixed to the viewport rather than
        // placed in the world, so no view or projection transform applies.
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform highp sampler2DShadow tMap;
      uniform float uFarEps;
      varying vec2 vUv;
      // Under glslVersion GLSL3, three does NOT define gl_FragColor for a
      // ShaderMaterial, and the compiler's complaint is the confusing
      // "'gl_FragColor' : undeclared identifier" followed by three type errors
      // that are all consequences of it. Declaring the output explicitly is the
      // whole fix. GLSL3 is required here because a comparison sampler cannot be
      // read from GLSL1 in a user shader.
      //
      // No backticks in this comment, deliberately: it lives inside a JS
      // template literal, and a backtick here ends the string. That is NOTES 41,
      // which I wrote up after Pumps hit it, and then hit myself one file later.
      layout(location = 0) out vec4 fragColor;
      void main() {
        // LEFT HALF: reference 0.0. GL_LEQUAL means the comparison returns
        // (ref <= stored), and every possible stored depth is >= 0.0, so this
        // half MUST come out pure white. If it does not, the sampler is not
        // reading the map and no conclusion may be drawn from the right half.
        // Without this the previous version's all-black frame was ambiguous
        // between "nothing is unwritten" and "the read is broken", and it was
        // the latter.
        //
        // RIGHT HALF: reference uFarEps. White only where stored depth is at the
        // far plane, i.e. texels no caster ever wrote. This is the measurement.
        float ref = vUv.x < 0.5 ? 0.0 : uFarEps;
        vec2 uv = vec2(fract(vUv.x * 2.0), vUv.y);
        float lit = texture(tMap, vec3(uv, ref));
        // Tint the halves so a crop cannot be mistaken for the wrong one:
        // control is green, measurement is magenta.
        vec3 tint = vUv.x < 0.5 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 1.0);
        fragColor = vec4(tint * lit, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    // `transparent: true` on a fully opaque overlay looks wrong and is the
    // point. Three renders the whole transparent group after the whole opaque
    // group, and `renderOrder` only sorts *within* a group — so an opaque
    // overlay at renderOrder 9999 is still painted over by every transparent
    // material in the scene. The first version read the car region as a shadow
    // map result when it was actually car glass and canopy fascia composited on
    // top, and the split-screen control caught it: the control half must be
    // saturated green by construction, and over the car it was 216 of 255.
    //
    // A control that only checks the easy part of the frame would have passed.
    transparent: true,
  });

  // A clip-space quad, added to the **scene** and not to the camera.
  //
  // The first version did `camera.add(mesh)`, which is a well-known three trap
  // and cost a round: `WebGLRenderer.render` traverses the *scene* graph, so a
  // child of a camera that was never itself added to the scene is silently not
  // drawn. Nothing errors. The frame renders normally, and the overlay's own
  // "installed" report is entirely truthful about the code having run — which is
  // exactly why it was misleading. An instrument reporting its own installation
  // proves the constructor ran, not that a pixel changed.
  //
  // The vertex shader writes clip space directly and ignores the model, view and
  // projection matrices, so the quad's position in the scene is irrelevant; only
  // its presence in the traversal matters. `frustumCulled = false` is therefore
  // load-bearing rather than defensive.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9999;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = "lighting-shadowview";
  void camera;
  scene.add(mesh);

  return {
    mesh,
    info: {
      // Enough for a capture to prove the overlay was actually live and looking
      // at the real allocation, rather than trusting the flag was parsed.
      width: target.width,
      height: target.height,
      source: depth ? "depthTexture" : "colorAttachment",
      depthType: depth ? depth.type : null,
      compareModeCleared: hadCompare,
      farEps: FAR_EPS,

    },
  };
}
