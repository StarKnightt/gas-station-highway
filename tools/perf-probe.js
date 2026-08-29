/**
 * In-page measurement helpers, injected once the scene is ready.
 *
 * Two rules this file exists to obey, both from NOTES:
 *
 *  - Measure per unit, not as an aggregate. Every table below is per mesh, per
 *    texture, per geometry, per scene root — the totals are summed from those,
 *    never sampled as a whole. A "mean triangle count" would hide the one
 *    object with 400k of them, which is exactly the object worth finding.
 *  - A flattering number deserves more suspicion. So the same quantity is
 *    measured two ways wherever it is cheap to do so: triangles from the scene
 *    graph *and* from counted GL draws; texture count from `renderer.info` *and*
 *    from GL uploads. Disagreement is reported, not smoothed over.
 */
(() => {
  if (window.__PERF) return;

  const P = {};
  window.__PERF = P;

  const fmtSize = (t) => {
    const im = t.image;
    if (!im) return { w: 0, h: 0 };
    if (Array.isArray(im)) return { w: im[0]?.width ?? 0, h: im[0]?.height ?? 0, faces: im.length };
    return { w: im.width ?? 0, h: im.height ?? 0 };
  };

  const TYPE_BYTES = { 1009: 1, 1010: 1, 1011: 2, 1012: 2, 1013: 4, 1014: 4, 1015: 4, 1016: 2 };
  const FMT_COMP = { 1023: 4, 1022: 3, 1028: 1, 1029: 2, 1026: 1, 1027: 2, 1021: 1 };

  function texBytes(t) {
    const { w, h, faces } = fmtSize(t);
    if (!w || !h) return 0;
    const comp = FMT_COMP[t.format] ?? 4;
    const tb = TYPE_BYTES[t.type] ?? 1;
    let b = w * h * comp * tb * (faces || 1);
    if (t.generateMipmaps !== false || (t.mipmaps && t.mipmaps.length > 1)) b = Math.round(b * 4 / 3);
    return b;
  }

  /**
   * Cheap content fingerprint of a texture's pixels. Strided so a 21 MB map
   * costs microseconds, and includes the length and dimensions so two
   * different-sized images cannot collide. Only DataTextures (a typed array
   * image) can be hashed; canvas-backed ones return null and are simply
   * excluded from the duplicate report rather than assumed unique.
   */
  function contentHash(t) {
    const im = t.image;
    const d = im && im.data;
    if (!d || typeof d.length !== "number") return null;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const stride = Math.max(1, Math.floor(d.length / 8192));
    for (let i = 0; i < d.length; i += stride) {
      h1 = ((h1 ^ d[i]) * 16777619) >>> 0;
      h2 = ((h2 + d[i]) * 2654435761) >>> 0;
    }
    return `${d.length}:${im.width}x${im.height}:${h1.toString(36)}${h2.toString(36)}`;
  }

  function geomBytes(g) {
    let b = 0;
    for (const k in g.attributes) b += g.attributes[k].array?.byteLength ?? 0;
    for (const k in g.morphAttributes || {}) for (const a of g.morphAttributes[k]) b += a.array?.byteLength ?? 0;
    if (g.index) b += g.index.array?.byteLength ?? 0;
    return b;
  }

  function geomTris(g) {
    if (g.index) return g.index.count / 3;
    const p = g.attributes.position;
    return p ? p.count / 3 : 0;
  }

  /**
   * Owning label for an object.
   *
   * Not simply the top-level child of the scene: most systems park everything
   * under one anonymous `Group`, so that put 284 of 340 drawables in a bucket
   * called "Group" and attributed nothing. The highest *named* ancestor below
   * the scene is the label the owning system actually chose ("car-system",
   * "veg-pine-wood", "building-entry-door"), falling back to the object's own
   * name and only then to the anonymous root.
   */
  function rootOf(obj, scene) {
    let o = obj;
    let named = null;
    while (o.parent && o.parent !== scene) {
      if (o.name) named = o;
      o = o.parent;
    }
    if (o.name) named = o;
    return named || obj;
  }

  P.sceneStats = function () {
    const g = window.__GAME;
    const scene = g.scene;
    const renderer = g.renderer;

    const geoms = new Map();
    const texs = new Map();
    const mats = new Map();
    const objects = [];
    const roots = new Map();
    const lights = [];

    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (o.isLight) {
        lights.push({
          type: o.type,
          name: o.name,
          castShadow: !!o.castShadow,
          mapSize: o.shadow ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
          intensity: o.intensity,
          visible: o.visible,
        });
      }
      if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
      const root = rootOf(o, scene);
      const rootName = root.name || root.type || "(unnamed)";
      const geo = o.geometry;
      const inst = o.isInstancedMesh ? o.count : 1;
      const tris = geo ? geomTris(geo) * inst : 0;

      if (geo && !geoms.has(geo.uuid)) geoms.set(geo.uuid, { bytes: geomBytes(geo), tris: geomTris(geo), name: geo.name || geo.type, users: 0 });
      if (geo) geoms.get(geo.uuid).users++;

      const matList = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      const texNames = [];
      for (const m of matList) {
        if (!mats.has(m.uuid)) mats.set(m.uuid, { type: m.type, name: m.name, transparent: !!m.transparent, users: 0, roots: new Set() });
        mats.get(m.uuid).users++;
        mats.get(m.uuid).roots.add(rootName);
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) {
            texNames.push(k);
            if (!texs.has(v.uuid)) {
              const s = fmtSize(v);
              texs.set(v.uuid, {
                w: s.w, h: s.h, faces: s.faces || 1,
                bytes: texBytes(v),
                name: v.name || "",
                slot: k,
                type: v.type, format: v.format,
                mips: v.generateMipmaps !== false,
                aniso: v.anisotropy,
                users: 0,
                roots: new Set(),
                src: v.source?.uuid ?? null,
                hash: contentHash(v),
              });
            }
            const e = texs.get(v.uuid);
            e.users++;
            e.roots.add(rootName);
          }
        }
      }

      objects.push({
        name: o.name || o.type,
        root: rootName,
        tris,
        inst: o.isInstancedMesh ? o.count : 0,
        visible: o.visible && o.parent?.visible !== false,
        frustumCulled: o.frustumCulled,
        castShadow: !!o.castShadow,
        receiveShadow: !!o.receiveShadow,
        mats: matList.length,
        tex: texNames.length,
      });

      if (!roots.has(rootName)) roots.set(rootName, { objects: 0, tris: 0, instanced: 0, shadowCasters: 0, texUuids: new Set(), geoUuids: new Set() });
      const r = roots.get(rootName);
      r.objects++;
      r.tris += tris;
      if (o.isInstancedMesh) r.instanced++;
      if (o.castShadow) r.shadowCasters++;
      if (geo) r.geoUuids.add(geo.uuid);
      for (const m of matList) for (const k in m) if (m[k] && m[k].isTexture) r.texUuids.add(m[k].uuid);
    });

    // Two different kinds of "duplicate", and only the second one costs VRAM.
    //
    //  - Same `source` under two THREE.Texture objects: free. Three keys its
    //    GPU allocation on the source, so this uploads once. Counted only so a
    //    reader does not mistake it for waste.
    //  - Two *distinct* sources holding byte-identical pixels: a genuine
    //    duplicate upload, and a pure win to deduplicate. Found by content
    //    hash, because nothing else can see it.
    const bySource = new Map();
    for (const [uuid, t] of texs) {
      const key = t.src || uuid;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(t);
    }
    const sharedSources = [...bySource.values()].filter((a) => a.length > 1).length;

    const byContent = new Map();
    for (const [uuid, t] of texs) {
      const h = t.hash;
      if (!h) continue;
      if (!byContent.has(h)) byContent.set(h, []);
      byContent.get(h).push({ uuid, ...t, roots: [...t.roots] });
    }
    const contentDupes = [...byContent.entries()]
      .filter(([, a]) => new Set(a.map((x) => x.src)).size > 1)
      .map(([h, a]) => ({ hash: h, count: a.length, w: a[0].w, h_: a[0].h, wastedMB: +((a[0].bytes * (a.length - 1)) / 1048576).toFixed(2), slots: a.map((x) => x.slot), roots: [...new Set(a.flatMap((x) => x.roots))] }))
      .sort((a, b) => b.wastedMB - a.wastedMB);

    const texArr = [...texs.values()].map((t) => ({ ...t, roots: [...t.roots] }));
    texArr.sort((a, b) => b.bytes - a.bytes);
    const geomArr = [...geoms.values()].sort((a, b) => b.bytes - a.bytes);

    // The adapter of the context three is actually drawing with, not of a
    // throwaway probe canvas. Playwright injects `--enable-unsafe-swiftshader`
    // into every Chromium it launches, so a software fallback is permitted at
    // any time — including part-way through a run, if the GPU process dies.
    // Checking once at startup on a different canvas cannot see that.
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");

    return {
      renderer: {
        unmasked: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        contextLost: gl.isContextLost(),
        info: JSON.parse(JSON.stringify(renderer.info)),
        programs: renderer.info.programs?.length ?? 0,
        pixelRatio: renderer.getPixelRatio(),
        drawingBufferPx: [renderer.domElement.width, renderer.domElement.height],
        shadowType: renderer.shadowMap.type,
        shadowEnabled: renderer.shadowMap.enabled,
      },
      counts: {
        objects: objects.length,
        sceneChildren: scene.children.length,
        geometries: geoms.size,
        materials: mats.size,
        textures: texs.size,
        lights: lights.length,
        shadowLights: lights.filter((l) => l.castShadow).length,
        sharedTextureSources: sharedSources,
        contentDuplicateGroups: contentDupes.length,
        contentDuplicateWastedMB: +contentDupes.reduce((a, d) => a + d.wastedMB, 0).toFixed(2),
      },
      totals: {
        tris: objects.reduce((a, o) => a + o.tris, 0),
        visibleTris: objects.filter((o) => o.visible).reduce((a, o) => a + o.tris, 0),
        geomBytes: geomArr.reduce((a, g) => a + g.bytes, 0),
        texBytes: texArr.reduce((a, t) => a + t.bytes, 0),
      },
      lights,
      // Texture and geometry bytes per owner. Shared assets are counted against
      // every owner that references them and the sum therefore exceeds the
      // total — deliberately, because "what would go away if this root went
      // away" and "what does this root cost on its own" are different
      // questions and only the second is answerable per root. `sharedTexMB`
      // says how much of each row is shared with another owner.
      roots: [...roots.entries()]
        .map(([name, v]) => {
          let tb = 0;
          let shared = 0;
          for (const u of v.texUuids) {
            const t = texs.get(u);
            if (!t) continue;
            tb += t.bytes;
            if (t.roots.size > 1) shared += t.bytes;
          }
          let gb = 0;
          for (const u of v.geoUuids) gb += geoms.get(u)?.bytes ?? 0;
          return {
            name,
            objects: v.objects,
            tris: v.tris,
            instanced: v.instanced,
            shadowCasters: v.shadowCasters,
            textures: v.texUuids.size,
            texMB: +(tb / 1048576).toFixed(2),
            sharedTexMB: +(shared / 1048576).toFixed(2),
            geomMB: +(gb / 1048576).toFixed(2),
          };
        })
        .sort((a, b) => b.texMB + b.tris / 1e5 - (a.texMB + a.tris / 1e5)),
      topTextures: texArr.slice(0, 40),
      texHistogram: texArr.reduce((h, t) => {
        const k = `${t.w}x${t.h}`;
        h[k] = (h[k] || 0) + 1;
        return h;
      }, {}),
      contentDupes: contentDupes.slice(0, 15),
      topGeoms: geomArr.slice(0, 25),
      topObjects: objects.sort((a, b) => b.tris - a.tris).slice(0, 30),
      systemErrors: window.__SYSTEM_ERRORS ?? [],
      // The per-render scene traverse LightingSystem installs. Cheap in
      // principle; worth having the measured number rather than assuming.
      envBind: window.__LIGHTING?.envBind ?? window.__LIGHTING?.binding ?? null,
      lightingReport: window.__LIGHTING ? { shadow: window.__LIGHTING.shadow, worldEnv: window.__LIGHTING.worldEnv } : null,
      gl: JSON.parse(JSON.stringify(window.__GLSTAT ? window.__GLSTAT.mark() : {})),
      glBiggest: [...(window.__GLSTAT?.biggest ?? [])].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
      glExtras: {
        contextLost: window.__GLSTAT?.contextLost ?? [],
        drawingBuffer: window.__GLSTAT?.drawingBuffer ?? null,
        contextAttrs: window.__GLSTAT?.contextAttrs ?? null,
      },
    };
  };

  /**
   * Per-frame sampler. Runs its own rAF *after* three's animation loop has been
   * registered, so each tick observes the frame three has just submitted.
   */
  P.startSampling = function () {
    if (P._sampling) return;
    P._sampling = true;
    P.samples = [];
    const G = window.__GLSTAT;
    let last = performance.now();
    let prevDraws = G.draws;
    let prevTris = G.drawTris;
    let prevTexCalls = G.tex.calls;
    let prevTexBytes = G.tex.bytes;
    let prevBufCalls = G.buf.calls;
    let prevProg = G.programs.linked;
    let prevRead = G.readPixels;

    const tick = () => {
      if (!P._sampling) return;
      const now = performance.now();
      const info = window.__GAME.renderer.info;
      P.samples.push({
        t: now,
        dt: now - last,
        draws: G.draws - prevDraws,
        tris: G.drawTris - prevTris,
        texCalls: G.tex.calls - prevTexCalls,
        texBytes: G.tex.bytes - prevTexBytes,
        bufCalls: G.buf.calls - prevBufCalls,
        progLinked: G.programs.linked - prevProg,
        reads: G.readPixels - prevRead,
        liveTexMB: +(G.live.texBytes / 1048576).toFixed(2),
        liveBufMB: +(G.live.bufBytes / 1048576).toFixed(2),
        infoCalls: info.render.calls,
        infoTris: info.render.triangles,
        geoms: info.memory.geometries,
        texs: info.memory.textures,
        programs: info.programs?.length ?? 0,
        heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
      });
      last = now;
      prevDraws = G.draws;
      prevTris = G.drawTris;
      prevTexCalls = G.tex.calls;
      prevTexBytes = G.tex.bytes;
      prevBufCalls = G.buf.calls;
      prevProg = G.programs.linked;
      prevRead = G.readPixels;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  P.stopSampling = function () {
    P._sampling = false;
    return P.samples;
  };

  /**
   * Toggle classes of light off at runtime and let the materials recompile.
   *
   * Three has no per-object light culling: every visible light in the scene is
   * evaluated by every lit fragment, so the ten interior RectAreaLights are
   * shading the asphalt outside the building as well as the shelves. `visible
   * = false` removes a light from `WebGLLights` and changes the program's
   * light counts, so this is a genuine A/B of the shader cost and not just of
   * the pixels the light happened to brighten.
   *
   * Returns what it actually changed, because "the experiment did nothing"
   * and "the experiment changed nothing measurable" look identical in a
   * frame-time table and only one of them is a result.
   */
  P.setLights = function (spec) {
    const changed = [];
    window.__GAME.scene.traverse((o) => {
      if (!o.isLight) return;
      const kind = o.isRectAreaLight ? "rect" : o.isPointLight ? "point" : o.isSpotLight ? "spot" : o.isDirectionalLight ? "dir" : o.isHemisphereLight ? "hemi" : "other";
      if (spec[kind] === undefined) return;
      if (o.visible !== spec[kind]) {
        o.visible = spec[kind];
        changed.push(`${kind}:${o.name || "(unnamed)"}`);
      }
    });
    return changed;
  };

  /**
   * Replace the sun's shadow render target with one whose *colour* attachment
   * is R8 instead of RGBA8, keeping the depth texture bit-identical.
   *
   * three r185 builds a directional shadow as
   *   `shadow.map = new WebGLRenderTarget(w, h)`            // RGBA8 colour
   *   `shadow.map.depthTexture = new DepthTexture(w, h, …)` // the real thing
   * and `WebGLLights` binds `shadow.map.depthTexture || shadow.map.texture`,
   * so with a depth texture present the colour attachment is written by the
   * depth pass every frame and never sampled by anything. At 8192 that is
   * 256 MB of write-only VRAM. A framebuffer needs its attachments to share
   * dimensions, so the width and height have to stay — but the format does
   * not, and R8 is colour-renderable in WebGL2.
   *
   * Done here, from the harness, rather than as an edit to LightingSystem.ts:
   * this proves the saving and the visual identity without touching a file
   * another agent is live in. Three only allocates a shadow map when
   * `shadow.map === null`, so an already-built one can be swapped underneath it.
   */
  P.shrinkShadowColour = function () {
    const RedFormat = 1028;
    const UnsignedByteType = 1009;
    const DepthFormat = 1026;
    const UnsignedIntType = 1014;
    const out = [];
    window.__GAME.scene.traverse((o) => {
      if (!o.isDirectionalLight || !o.castShadow) return;
      const old = o.shadow && o.shadow.map;
      if (!old || !old.depthTexture) return;
      const RT = old.constructor;
      const DT = old.depthTexture.constructor;
      const w = old.width;
      const h = old.height;

      const rt = new RT(w, h, { format: RedFormat, type: UnsignedByteType, generateMipmaps: false });
      rt.texture.name = `${o.name}.shadowMap.colour(R8)`;
      const dt = new DT(w, h, UnsignedIntType);
      dt.format = DepthFormat;
      dt.compareFunction = old.depthTexture.compareFunction;
      dt.minFilter = old.depthTexture.minFilter;
      dt.magFilter = old.depthTexture.magFilter;
      dt.name = old.depthTexture.name;
      rt.depthTexture = dt;

      o.shadow.map = rt;
      old.depthTexture.dispose();
      old.dispose();
      out.push({ light: o.name || "(unnamed)", size: `${w}x${h}` });
    });
    return out;
  };

  /** Turn the sun's shadow pass off without touching its contribution. */
  P.setSunShadow = function (on) {
    let hit = 0;
    window.__GAME.scene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow !== on) {
        o.castShadow = on;
        hit++;
      }
    });
    // Materials cache whether they sample a shadow map in their program key.
    window.__GAME.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const one of Array.isArray(m) ? m : [m]) one.needsUpdate = true;
    });
    return hit;
  };

  /**
   * Drives the real PlayerSystem: sets yaw directly (PointerLockControls only
   * writes it on mousemove, and `update()` only writes roll) and holds the
   * forward key, so the walk goes through the same groundHeight sampling and
   * head-bob path the user's session did.
   */
  P.startWalk = function (opts) {
    const cam = window.__GAME.camera;
    const o = Object.assign({ turnRate: 0.22, sweep: 2.6 }, opts || {});
    P._walkT0 = performance.now();
    P._walk = setInterval(() => {
      const t = (performance.now() - P._walkT0) / 1000;
      cam.rotation.y = Math.sin(t * o.turnRate) * o.sweep;
      cam.rotation.x = Math.sin(t * 0.13) * 0.22;
    }, 16);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
  };

  P.stopWalk = function () {
    clearInterval(P._walk);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
    const c = window.__GAME.camera.position;
    return [c.x, c.y, c.z];
  };
})();
