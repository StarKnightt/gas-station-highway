import * as THREE from "three";

/**
 * Reclaims the write-only colour attachment three allocates alongside every
 * directional shadow map.
 *
 * ## What three does
 *
 * `WebGLShadowMap` builds a non-VSM directional shadow as, in r185
 * (`src/renderers/webgl/WebGLShadowMap.js`, the `else` branch at line 251):
 *
 * ```js
 * shadow.map = new WebGLRenderTarget( _shadowMapSize.x, _shadowMapSize.y );
 * shadow.map.depthTexture = new DepthTexture( _shadowMapSize.x, _shadowMapSize.y, UnsignedIntType );
 * ```
 *
 * The first line is a render target with three's default colour texture, which
 * is RGBA8. The second attaches the depth texture that the shadow lookup
 * actually samples — `WebGLLights.js` line 255 binds
 *
 * ```js
 * shadowMap = light.shadow.map.depthTexture || light.shadow.map.texture;
 * ```
 *
 * so with a depth texture present, **nothing ever reads the colour
 * attachment.** The depth pass rasterises into it every frame and the result is
 * discarded. At this project's 8192 map that is a 256 MB write-only allocation,
 * on top of the 256 MB depth texture that does the work.
 *
 * ## What this does
 *
 * A framebuffer's attachments must agree on dimensions, so the 8192 x 8192 has
 * to stay. The *format* does not: `R8` is colour-renderable in WebGL2, the
 * depth material's `vec4` output simply drops its unused components, and the
 * texture is never sampled so its contents are irrelevant. 8192 x 8192 goes
 * from 256 MB to 64 MB.
 *
 * Three only allocates a shadow map when `shadow.map === null`, so an
 * already-built one can be swapped underneath it after the first render.
 *
 * ## The depth texture is moved, not rebuilt, and that is the whole design
 *
 * The obvious implementation builds a fresh `DepthTexture` for the new target.
 * It works, it is pixel-identical, and it is **wrong for this scene**, because
 * it makes three upload a second 256 MB depth texture while the original is
 * still resident. Peak GPU memory during the swap goes from 512 MB to 832 MB,
 * and the swap happens during scene generation — the exact moment VRAM is
 * tightest and the moment this project's crash is best explained by. Trading a
 * 320 MB transient spike for a 192 MB steady-state saving is a bad trade when
 * the failure mode is a peak, not an average. It also cost 512 MB of the
 * "518 MB of init transients" that the first version of `PERF.md` reported as a
 * generator problem; almost all of it was this function.
 *
 * So the existing depth texture is moved across instead. Order matters, because
 * `RenderTarget`'s `depthTexture` setter maintains a `renderTarget` back-pointer
 * on the texture and clears it when set to null:
 *
 * 1. `old.depthTexture = null` — detaches, and stops `dispose()` from taking
 *    the depth texture with it (`WebGLTextures.deallocateRenderTarget` disposes
 *    `renderTarget.depthTexture` unconditionally when one is present).
 * 2. `next.depthTexture = depth` — re-points the back-pointer at the new target.
 * 3. `old.dispose()` — frees the 256 MB colour attachment and the framebuffer,
 *    and nothing else.
 *
 * Three then re-attaches the surviving GPU texture without re-uploading it:
 * `setupDepthTexture` only allocates when `__webglTexture` is absent or the
 * dimensions disagree, and neither is true here. Peak becomes 576 MB for one
 * frame (the new 64 MB alongside the old 512) rather than 832 MB, and steady
 * state is 320 MB.
 *
 * ## Measured
 *
 * Same bundle, A/B against `?noshadowopt=1`, RTX 4060, two fixed poses:
 *
 * | | live GL texture memory | transient during init | draws | triangles | programs |
 * |---|---|---|---|---|---|
 * | as shipped | 909.13 MB | 15.84 MB | 395 / 517 | 2,841,734 / 3,065,110 | 141 / 144 |
 * | with this  | **717.13 MB** | **15.84 MB** | 395 / 517 | 2,841,734 / 3,065,110 | 141 / 144 |
 *
 * Exactly 192.00 MB at both poses, which is 256 - 64 as predicted, with no
 * transient cost at all: the "as shipped" and "with this" columns of uploaded-
 * minus-resident are identical, meaning the oversized attachment is now never
 * allocated rather than allocated and freed. Every count is unchanged.
 *
 * Pixel diff of the two frames: **41 of 6,220,800 colour channels at `pumps`
 * and 291 at `ground`, every one of them by 1/255**. That is dither noise. An
 * inverted depth comparison — the failure this code is most exposed to, since
 * it now configures the depth texture itself — would flip whole regions of the
 * image, not one bit in five thousand pixels. Shadow resolution, filtering,
 * bias and range are untouched; this is not a quality trade.
 *
 * `?noshadowopt=1` disables both halves so the comparison can be re-run at any
 * time against the same bundle.
 *
 * ## Failure mode it is written against
 *
 * This depends on three's internals, so it verifies them instead of assuming
 * them: if the shadow map has no depth texture, the colour attachment *is* the
 * shadow and converting it would silently destroy every shadow in the scene
 * while still rendering a perfectly plausible frame. That case is skipped and
 * logged rather than guessed at.
 */

const converted = new WeakSet<THREE.WebGLRenderTarget>();

/**
 * Disarms three's shadow-map-type-change rebuild without letting it allocate.
 *
 * `WebGLShadowMap` captures `_previousType = this.type` when the renderer is
 * constructed, and `this.type` is `PCFShadowMap` at that moment
 * (`WebGLShadowMap.js:89-90`). Any system that later selects a different type —
 * `LightingSystem` does, for contact hardening under `?pcss=1` — leaves
 * `typeChanged` true for the first render, and line 203 then reads
 *
 * ```js
 * if ( shadow.map === null || typeChanged === true ) { ...dispose and rebuild... }
 * ```
 *
 * so a map pre-built here would be **thrown away on the first frame** and
 * replaced by three's RGBA8 default. Preallocating without handling that is
 * worse than not preallocating: it pays 64 MB for a target that is immediately
 * discarded, and the 256 MB it was meant to prevent is allocated anyway.
 *
 * The escape is `WebGLShadowMap.js:170`:
 *
 * ```js
 * if ( shadow.autoUpdate === false && shadow.needsUpdate === false ) continue;
 * ```
 *
 * With every shadow suppressed, one `render()` call reaches the tail
 * (`_previousType = this.type`, line 367) having allocated nothing, and does
 * the material-recompilation traversal that a type change requires — which has
 * to happen regardless, and is cheaper here at init than mid-play. It restores
 * the render target itself on the way out (line 371), and the four pieces of GL
 * state it touches are re-set by every subsequent frame.
 *
 * Returns false if the call could not be made, in which case the caller must
 * not preallocate.
 */
function consumeShadowTypeChange(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera?: THREE.Camera): boolean {
  if (!camera) {
    console.warn(
      `[shadow-memory] shadow type is not PCFShadowMap and no camera was supplied, so three's type-change ` +
        `rebuild cannot be disarmed. Skipping preallocation; the colour attachment is still reclaimed afterwards.`
    );
    return false;
  }

  type ShadowLight = THREE.Light & { shadow?: THREE.LightShadow };
  const lights: ShadowLight[] = [];
  scene.traverse((object) => {
    const light = object as ShadowLight;
    if (light.isLight && light.castShadow && light.shadow) lights.push(light);
  });
  // With no lights, `render()` returns at line 97 before reaching the tail, so
  // the type change would survive and the rebuild would still happen.
  if (lights.length === 0) return false;

  const previous = lights.map((l) => ({
    shadow: l.shadow!,
    autoUpdate: l.shadow!.autoUpdate,
    needsUpdate: l.shadow!.needsUpdate,
  }));

  try {
    for (const p of previous) {
      p.shadow.autoUpdate = false;
      p.shadow.needsUpdate = false;
    }
    (renderer.shadowMap as unknown as { render: (l: THREE.Light[], s: THREE.Scene, c: THREE.Camera) => void }).render(
      lights,
      scene,
      camera
    );
  } catch (err) {
    console.warn(`[shadow-memory] could not disarm three's shadow type-change rebuild; skipping preallocation`, err);
    return false;
  } finally {
    for (const p of previous) {
      p.shadow.autoUpdate = p.autoUpdate;
      p.shadow.needsUpdate = p.needsUpdate;
    }
  }

  // Verify rather than assume: if three did allocate despite the suppression,
  // preallocating on top would leak the target it just built.
  for (const p of previous) {
    if (p.shadow.map) {
      console.warn(
        `[shadow-memory] three allocated a shadow map during the type-change disarm, which contradicts ` +
          `WebGLShadowMap.js:170. Skipping preallocation and leaving it to the reclaim path.`
      );
      return false;
    }
  }
  return true;
}

export interface ShadowMemorySaving {
  light: string;
  size: string;
  savedBytes: number;
}

/**
 * Builds the shadow map before three does, so the 256 MB RGBA8 attachment is
 * never allocated in the first place.
 *
 * `reclaimShadowColourAttachments` fixes the steady state but not the peak: it
 * cannot run until three has already allocated, which means the oversized
 * attachment exists for the ~1.4 s between the first render and the swap.
 * That window sits at the end of scene generation, which measurement puts at
 * the highest-VRAM moment of the whole page lifetime and which is the best
 * explanation available for this project's crash. Peak is the number that
 * decides whether the page survives; average is the number that decides whether
 * it is fast. This one is about peak.
 *
 * Three allocates only when `shadow.map === null` (`WebGLShadowMap.render`), so
 * handing it a ready-made target skips its branch entirely. The properties set
 * here mirror that branch exactly for the `PCFShadowMap` / non-VSM /
 * non-point-light case; **anything else is left for three to build**, and the
 * post-hoc reclaim still covers it. In particular this bails out rather than
 * guessing when it cannot determine the depth comparison direction, because
 * getting that wrong inverts every shadow in the scene while still producing a
 * frame that looks deliberate.
 *
 * Call once, after the lights exist and before the first render.
 */
export function preallocateShadowMaps(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  camera?: THREE.Camera
): ShadowMemorySaving[] {
  const saved: ShadowMemorySaving[] = [];

  const shadowType = renderer.shadowMap.type;
  if (shadowType !== THREE.PCFShadowMap && shadowType !== THREE.BasicShadowMap) {
    // VSM allocates a different set of targets (RG half-float plus a blur pass)
    // and point lights allocate a cube. Neither is what is mirrored below, and
    // the reclaim path handles whatever three builds instead.
    return saved;
  }

  // Three's own choice, from `WebGLShadowMap.js:261-272`: `PCFShadowMap` puts
  // the depth texture into hardware comparison mode and filters it linearly so
  // the sampler does the PCF tap; every other type binds it as a plain
  // `sampler2D` with no comparison and nearest filtering, because the shader
  // does its own comparison. Contact hardening needs the raw depth, which is
  // why `LightingSystem` selects `BasicShadowMap` when `?pcss=1`.
  let compareFunction: THREE.TextureComparisonFunction | null = null;
  let shadowFilter: THREE.MinificationTextureFilter = THREE.NearestFilter;

  if (shadowType === THREE.PCFShadowMap) {
    // Read the direction from three's own depth-buffer state rather than
    // re-deriving it: `WebGLRenderer` only calls `setReversed(true)` when both
    // the `EXT_clip_control` capability and the constructor option are present,
    // and reproducing that test here would be a second place to get it wrong.
    // `renderer.reversedDepthBuffer` is documented but not actually exposed as
    // an instance property in r185, which is why this reaches into `state`.
    const depthState = (renderer as unknown as { state?: { buffers?: { depth?: { getReversed?: () => boolean } } } }).state;
    const getReversed = depthState?.buffers?.depth?.getReversed;
    const reversed = typeof getReversed === "function" ? getReversed.call(depthState!.buffers!.depth) : undefined;
    if (typeof reversed !== "boolean") {
      // Bail rather than assume. Guessing this wrong inverts every shadow in
      // the scene, and the result still looks like a deliberate lighting
      // choice. `reclaimShadowColourAttachments` still recovers the
      // steady-state saving after three has built the map; only the peak is
      // given up here.
      console.warn(
        `[shadow-memory] cannot read three's reversed-depth state, so the shadow comparison direction is unknown. ` +
          `Letting three allocate the shadow map; the colour attachment is still reclaimed afterwards.`
      );
      return saved;
    }
    compareFunction = reversed ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    shadowFilter = THREE.LinearFilter;
  } else if (!consumeShadowTypeChange(scene, renderer, camera)) {
    // Could not disarm three's type-change rebuild, so anything pre-built here
    // would be disposed on the first frame and replaced by three's oversized
    // default — costing a wasted allocation on top of the one this exists to
    // avoid. Do nothing and let the reclaim path take the steady state.
    return saved;
  }

  const maxSize = renderer.capabilities.maxTextureSize;

  scene.traverse((object) => {
    const light = object as THREE.DirectionalLight;
    if (!light.isDirectionalLight || !light.castShadow) return;
    if (light.shadow.map) return;

    // A frame extent other than 1x1 means three tiles several viewports into
    // one texture (point lights), and the size arithmetic below is wrong.
    const extents = light.shadow.getFrameExtents();
    if (extents.x !== 1 || extents.y !== 1) return;

    const w = Math.min(light.shadow.mapSize.x, maxSize);
    const h = Math.min(light.shadow.mapSize.y, maxSize);

    try {
      const target = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: false,
      });
      target.texture.name = `${light.name}.shadowMap.colour`;

      const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      depth.name = `${light.name}.shadowMap`;
      depth.format = THREE.DepthFormat;
      depth.compareFunction = compareFunction;
      depth.minFilter = shadowFilter;
      depth.magFilter = shadowFilter as THREE.MagnificationTextureFilter;
      target.depthTexture = depth;

      light.shadow.map = target;
      converted.add(target);
      saved.push({ light: light.name || "directional light", size: `${w}x${h}`, savedBytes: w * h * 3 });
    } catch (err) {
      console.warn(`[shadow-memory] could not pre-build the shadow map; three will allocate it as usual`, err);
    }
  });

  return saved;
}

/**
 * Call after the renderer has drawn at least one frame, once per frame; it is
 * idempotent and costs one WeakSet lookup per shadow-casting light after the
 * first call. Returns what it changed, empty when there was nothing to do.
 */
export function reclaimShadowColourAttachments(scene: THREE.Scene): ShadowMemorySaving[] {
  const saved: ShadowMemorySaving[] = [];

  scene.traverse((object) => {
    const light = object as THREE.DirectionalLight;
    if (!light.isDirectionalLight || !light.castShadow) return;

    const old = light.shadow?.map as THREE.WebGLRenderTarget | null | undefined;
    if (!old || converted.has(old)) return;

    const depth = old.depthTexture;
    if (!depth) {
      // Without a depth texture three samples the colour attachment, so it is
      // load bearing. Loud, because arriving here means three's shadow path has
      // changed and this whole module needs re-reading against the new source.
      converted.add(old);
      console.warn(
        `[shadow-memory] "${light.name || "directional light"}" has a shadow map with no depthTexture, so its ` +
          `colour attachment IS the shadow. Leaving it alone — three's shadow path is not what this assumes.`
      );
      return;
    }

    const w = old.width;
    const h = old.height;
    // RGBA8 -> R8 on the colour attachment only.
    const savedBytes = w * h * 3;

    try {
      const next = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: false,
      });
      next.texture.name = `${light.name || "light"}.shadowMap.colour`;

      // Move the depth texture across rather than rebuilding it — see the note
      // on peak memory above. These three lines are order-sensitive.
      old.depthTexture = null;
      next.depthTexture = depth;

      light.shadow.map = next;
      converted.add(next);

      old.dispose();

      saved.push({ light: light.name || "directional light", size: `${w}x${h}`, savedBytes });
    } catch (err) {
      converted.add(old);
      console.warn(`[shadow-memory] could not convert the shadow colour attachment; leaving it as three built it`, err);
    }
  });

  return saved;
}
