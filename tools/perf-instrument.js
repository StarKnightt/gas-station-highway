/**
 * GL-level instrumentation, injected with `addInitScript` so it wraps the
 * context prototypes *before* three ever creates one.
 *
 * Why at the GL layer rather than reading `renderer.info`:
 *
 *  - `renderer.info.memory.textures` is a *count*, not bytes. A 4096x4096 RGBA
 *    map and an 8x8 probe target are both "1". The number that decides whether
 *    a scene fits in VRAM is bytes, and only the upload calls know that.
 *  - `renderer.info.render` is reset at the top of every `render()`, so a frame
 *    containing shadow passes, a cube capture and a PMREM filter reports only
 *    the *last* render's counts. Counting `drawElements` ourselves per rAF
 *    catches every pass in the frame.
 *  - A texture allocated and thrown away every frame is invisible to a
 *    snapshot of either. It is glaring in a per-frame upload counter.
 *
 * Everything here is additive wrapping; no call is suppressed or reordered.
 */
(() => {
  if (window.__GLSTAT) return;

  const S = {
    /** Cumulative since page load. */
    tex: { calls: 0, bytes: 0, allocs: 0, frees: 0 },
    buf: { calls: 0, bytes: 0, allocs: 0, frees: 0 },
    rbo: { calls: 0, bytes: 0, frees: 0 },
    /** Live (allocated minus deleted) GPU bytes, and the peak of that. */
    live: { texBytes: 0, texCount: 0, bufBytes: 0, bufCount: 0, rboBytes: 0, rboCount: 0 },
    peak: { texBytes: 0, bufBytes: 0, total: 0 },
    draws: 0,
    drawTris: 0,
    programs: { created: 0, linked: 0, deleted: 0, firstLinkMs: null, lastLinkMs: null },
    /**
     * Wall time in the shader pipeline. `blockedMs` is the part that stalls the
     * thread waiting on the driver; `queuedMs` is submission and is not a cost.
     */
    shaderTime: { queuedMs: 0, blockedMs: 0, worstBlockMs: 0, calls: {} },
    framebuffers: { created: 0, deleted: 0 },
    readPixels: 0,
    /** Filled by the webglcontextlost handler. Non-empty is a hard failure. */
    contextLost: [],
    /** Largest single textures seen, for the "who is fat" table. */
    biggest: [],
    /** Per-frame samples pushed by the harness's rAF probe. */
    frames: [],
    /** Reset by the harness to mark the start of a measurement window. */
    mark() {
      return JSON.parse(JSON.stringify({ tex: S.tex, buf: S.buf, rbo: S.rbo, live: S.live, draws: S.draws, drawTris: S.drawTris, programs: S.programs, shaderTime: S.shaderTime, framebuffers: S.framebuffers, readPixels: S.readPixels }));
    },
  };
  window.__GLSTAT = S;

  const PACKED = new Set([0x8363, 0x8033, 0x8034, 0x84fa, 0x8368, 0x8c3b, 0x8c3e]);
  // UNSIGNED_SHORT_5_6_5, _4_4_4_4, _5_5_5_1, UNSIGNED_INT_24_8,
  // UNSIGNED_INT_2_10_10_10_REV, _10F_11F_11F_REV, _5_9_9_9_REV

  const TYPE_BYTES = {
    0x1400: 1, 0x1401: 1, // BYTE, UNSIGNED_BYTE
    0x1402: 2, 0x1403: 2, // SHORT, UNSIGNED_SHORT
    0x1404: 4, 0x1405: 4, // INT, UNSIGNED_INT
    0x1406: 4, 0x140b: 2, // FLOAT, HALF_FLOAT
    0x8d61: 2, // HALF_FLOAT_OES
    0x8363: 2, 0x8033: 2, 0x8034: 2,
    0x84fa: 4, 0x8368: 4, 0x8c3b: 4, 0x8c3e: 4,
  };

  const FORMAT_COMPONENTS = {
    0x1906: 1, // ALPHA
    0x1909: 1, // LUMINANCE
    0x190a: 2, // LUMINANCE_ALPHA
    0x1907: 3, // RGB
    0x1908: 4, // RGBA
    0x1902: 1, // DEPTH_COMPONENT
    0x84f9: 2, // DEPTH_STENCIL
    0x1903: 1, // RED
    0x8227: 2, // RG
    0x8228: 2, // RG_INTEGER
    0x8d94: 1, // RED_INTEGER
    0x8d98: 3, // RGB_INTEGER
    0x8d99: 4, // RGBA_INTEGER
  };

  /** Sized internal formats used by three's WebGL2 `texStorage2D` path. */
  const SIZED_BPP = {
    0x8058: 4, // RGBA8
    0x8c43: 4, // SRGB8_ALPHA8
    0x8051: 3, // RGB8
    0x8c41: 3, // SRGB8
    0x881a: 8, // RGBA16F
    0x881b: 6, // RGB16F
    0x8814: 16, // RGBA32F
    0x8815: 12, // RGB32F
    0x8229: 1, // R8
    0x822b: 2, // RG8
    0x822d: 2, // R16F
    0x822f: 4, // RG16F
    0x822e: 4, // R32F
    0x8230: 8, // RG32F
    0x8c3a: 4, // R11F_G11F_B10F
    0x8059: 4, // RGB10_A2
    0x81a5: 2, // DEPTH_COMPONENT16
    0x81a6: 4, // DEPTH_COMPONENT24
    0x8cac: 4, // DEPTH_COMPONENT32F
    0x88f0: 4, // DEPTH24_STENCIL8
    0x8cad: 8, // DEPTH32F_STENCIL8
    0x8d48: 1, // STENCIL_INDEX8
  };

  function pixelBytes(format, type, w, h, d = 1) {
    if (PACKED.has(type)) return w * h * d * (TYPE_BYTES[type] || 4);
    const c = FORMAT_COMPONENTS[format] ?? 4;
    const t = TYPE_BYTES[type] ?? 1;
    return w * h * d * c * t;
  }

  function storageBytes(internalformat, levels, w, h, d = 1) {
    const bpp = SIZED_BPP[internalformat] ?? 4;
    let total = 0;
    for (let i = 0; i < levels; i++) {
      total += Math.max(1, w >> i) * Math.max(1, h >> i) * Math.max(1, d >> i) * bpp;
    }
    return total;
  }

  function note(obj, bytes, label) {
    if (!obj) return;
    const prev = obj.__perfBytes || 0;
    obj.__perfBytes = prev + bytes;
    obj.__perfLabel = label || obj.__perfLabel;
  }

  function bump() {
    const total = S.live.texBytes + S.live.bufBytes + S.live.rboBytes;
    if (S.live.texBytes > S.peak.texBytes) S.peak.texBytes = S.live.texBytes;
    if (S.live.bufBytes > S.peak.bufBytes) S.peak.bufBytes = S.live.bufBytes;
    if (total > S.peak.total) S.peak.total = total;
  }

  function recordBig(obj, w, h, bytes, kind) {
    // A stack for anything sizeable: the whole point of this pass is to name
    // the call site that allocated the 268 MB, not just to know it exists.
    // Build with `minify: false` (tools/perf.mjs does) or these are mangled.
    const rec = { w, h, bytes, kind, t: Math.round(performance.now()) };
    if (bytes >= 2 * 1024 * 1024) {
      rec.stack = (new Error().stack || "")
        .split("\n")
        .slice(2, 10)
        .map((l) => l.trim())
        .join(" << ");
    }
    S.biggest.push(rec);
    if (S.biggest.length > 4000) S.biggest.shift();
    if (obj) obj.__perfDims = `${w}x${h}`;
  }

  function wrap(proto) {
    if (!proto || proto.__perfWrapped) return;
    proto.__perfWrapped = true;

    const bound = new WeakMap(); // context -> { target: texture }

    function curTex(ctx, target) {
      // Cube faces bind to TEXTURE_CUBE_MAP; array/3D to their own target.
      const t = target >= 0x8515 && target <= 0x851a ? 0x8513 : target;
      const m = bound.get(ctx);
      return m ? m[t] : null;
    }

    const origBindTexture = proto.bindTexture;
    proto.bindTexture = function (target, texture) {
      let m = bound.get(this);
      if (!m) bound.set(this, (m = {}));
      m[target] = texture;
      return origBindTexture.call(this, target, texture);
    };

    const origCreateTexture = proto.createTexture;
    proto.createTexture = function () {
      const t = origCreateTexture.call(this);
      S.tex.allocs++;
      S.live.texCount++;
      return t;
    };

    const origDeleteTexture = proto.deleteTexture;
    proto.deleteTexture = function (t) {
      if (t && t.__perfBytes) {
        S.live.texBytes -= t.__perfBytes;
        t.__perfBytes = 0;
      }
      if (t) {
        S.tex.frees++;
        S.live.texCount--;
      }
      return origDeleteTexture.call(this, t);
    };

    const origTexImage2D = proto.texImage2D;
    proto.texImage2D = function (target, level, internalformat, ...rest) {
      const r = origTexImage2D.call(this, target, level, internalformat, ...rest);
      S.tex.calls++;
      let w = 0, h = 0, bytes = 0;
      if (rest.length >= 5) {
        // (width, height, border, format, type, pixels)
        w = rest[0]; h = rest[1];
        bytes = pixelBytes(rest[3], rest[4], w, h);
      } else {
        // (format, type, source)
        const src = rest[2];
        w = src?.width ?? src?.videoWidth ?? 0;
        h = src?.height ?? src?.videoHeight ?? 0;
        bytes = pixelBytes(rest[0], rest[1], w, h);
      }
      S.tex.bytes += bytes;
      S.live.texBytes += bytes;
      const tex = curTex(this, target);
      note(tex, bytes, "texImage2D");
      if (tex) tex.__perfMipBase = (tex.__perfMipBase || 0) + (level === 0 ? bytes : 0);
      if (bytes > 0) recordBig(tex, w, h, bytes, level === 0 ? "texImage2D" : `mip${level}`);
      bump();
      return r;
    };

    const origTexStorage2D = proto.texStorage2D;
    if (origTexStorage2D) {
      proto.texStorage2D = function (target, levels, internalformat, w, h) {
        const r = origTexStorage2D.call(this, target, levels, internalformat, w, h);
        S.tex.calls++;
        let bytes = storageBytes(internalformat, levels, w, h);
        if (target === 0x8513) bytes *= 6; // TEXTURE_CUBE_MAP
        S.tex.bytes += bytes;
        S.live.texBytes += bytes;
        const tex = curTex(this, target);
        note(tex, bytes, "texStorage2D");
        if (tex) tex.__perfStorage = true;
        recordBig(tex, w, h, bytes, target === 0x8513 ? "cube" : "texStorage2D");
        bump();
        return r;
      };
    }

    const origTexStorage3D = proto.texStorage3D;
    if (origTexStorage3D) {
      proto.texStorage3D = function (target, levels, internalformat, w, h, d) {
        const r = origTexStorage3D.call(this, target, levels, internalformat, w, h, d);
        S.tex.calls++;
        const bytes = storageBytes(internalformat, levels, w, h, d);
        S.tex.bytes += bytes;
        S.live.texBytes += bytes;
        note(curTex(this, target), bytes, "texStorage3D");
        recordBig(curTex(this, target), w, h * d, bytes, "texStorage3D");
        bump();
        return r;
      };
    }

    const origTexImage3D = proto.texImage3D;
    if (origTexImage3D) {
      proto.texImage3D = function (target, level, internalformat, w, h, d, border, format, type, ...rest) {
        const r = origTexImage3D.call(this, target, level, internalformat, w, h, d, border, format, type, ...rest);
        S.tex.calls++;
        const bytes = pixelBytes(format, type, w, h, d);
        S.tex.bytes += bytes;
        S.live.texBytes += bytes;
        note(curTex(this, target), bytes, "texImage3D");
        bump();
        return r;
      };
    }

    const origCompressed = proto.compressedTexImage2D;
    if (origCompressed) {
      proto.compressedTexImage2D = function (target, level, internalformat, w, h, border, data) {
        const r = origCompressed.apply(this, arguments);
        S.tex.calls++;
        const bytes = data?.byteLength ?? 0;
        S.tex.bytes += bytes;
        S.live.texBytes += bytes;
        note(curTex(this, target), bytes, "compressed");
        bump();
        return r;
      };
    }

    const origGenerateMipmap = proto.generateMipmap;
    proto.generateMipmap = function (target) {
      const r = origGenerateMipmap.call(this, target);
      const tex = curTex(this, target);
      // texStorage2D already allocated the whole chain; only the texImage2D
      // path gains memory here (the classic 1/3 tail).
      if (tex && !tex.__perfStorage && !tex.__perfMipped && tex.__perfMipBase) {
        tex.__perfMipped = true;
        const extra = Math.round(tex.__perfMipBase / 3) * (target === 0x8513 ? 6 : 1);
        S.tex.bytes += extra;
        S.live.texBytes += extra;
        note(tex, extra, "mipchain");
        bump();
      }
      return r;
    };

    /* ---- buffers ---- */
    const boundBuf = new WeakMap();
    const origBindBuffer = proto.bindBuffer;
    proto.bindBuffer = function (target, buffer) {
      let m = boundBuf.get(this);
      if (!m) boundBuf.set(this, (m = {}));
      m[target] = buffer;
      return origBindBuffer.call(this, target, buffer);
    };
    const origCreateBuffer = proto.createBuffer;
    proto.createBuffer = function () {
      S.buf.allocs++;
      S.live.bufCount++;
      return origCreateBuffer.call(this);
    };
    const origDeleteBuffer = proto.deleteBuffer;
    proto.deleteBuffer = function (b) {
      if (b && b.__perfBytes) {
        S.live.bufBytes -= b.__perfBytes;
        b.__perfBytes = 0;
      }
      if (b) {
        S.buf.frees++;
        S.live.bufCount--;
      }
      return origDeleteBuffer.call(this, b);
    };
    const origBufferData = proto.bufferData;
    proto.bufferData = function (target, srcOrSize, usage, ...rest) {
      const r = origBufferData.apply(this, arguments);
      S.buf.calls++;
      const bytes = typeof srcOrSize === "number" ? srcOrSize : srcOrSize?.byteLength ?? 0;
      const b = boundBuf.get(this)?.[target];
      // bufferData replaces the store rather than adding to it.
      if (b) {
        S.live.bufBytes += bytes - (b.__perfBytes || 0);
        b.__perfBytes = bytes;
      } else {
        S.live.bufBytes += bytes;
      }
      S.buf.bytes += bytes;
      bump();
      return r;
    };

    /* ---- renderbuffers (MSAA colour/depth on render targets) ---- */
    const boundRbo = new WeakMap();
    const origBindRbo = proto.bindRenderbuffer;
    if (origBindRbo) {
      proto.bindRenderbuffer = function (target, rb) {
        boundRbo.set(this, rb);
        return origBindRbo.call(this, target, rb);
      };
    }
    for (const fn of ["renderbufferStorage", "renderbufferStorageMultisample"]) {
      const orig = proto[fn];
      if (!orig) continue;
      proto[fn] = function (...args) {
        const r = orig.apply(this, args);
        // (target, [samples,] internalformat, width, height)
        const off = fn.endsWith("Multisample") ? 1 : 0;
        const internalformat = args[1 + off];
        const w = args[2 + off];
        const h = args[3 + off];
        const samples = off ? args[1] : 1;
        const bytes = (SIZED_BPP[internalformat] ?? 4) * w * h * Math.max(1, samples);
        const rb = boundRbo.get(this);
        if (rb) {
          S.live.rboBytes += bytes - (rb.__perfBytes || 0);
          // Re-specifying an existing renderbuffer replaces its store rather
          // than adding one, so only a first specification is a new object.
          if (!rb.__perfBytes) S.live.rboCount++;
          rb.__perfBytes = bytes;
        } else {
          S.live.rboBytes += bytes;
          S.live.rboCount++;
        }
        S.rbo.bytes += bytes;
        bump();
        return r;
      };
    }

    /* Without this, `live.rboBytes` is a high-water mark wearing the name of a
     * live value: every other `live.*` counter here has a matching delete hook
     * and this one did not, so freed depth and MSAA attachments stayed on the
     * books forever. Render targets are created and destroyed routinely (the
     * shadow reclaim path alone does it at startup), so the error is not
     * hypothetical. Found when a disposal test reported bytes leaking and the
     * residual turned out to equal the renderbuffer total exactly — the tell
     * that the instrument, not the code under test, was at fault. */
    const origDeleteRbo = proto.deleteRenderbuffer;
    if (origDeleteRbo) {
      proto.deleteRenderbuffer = function (rb) {
        if (rb && rb.__perfBytes) {
          S.live.rboBytes -= rb.__perfBytes;
          S.rbo.frees = (S.rbo.frees || 0) + 1;
          rb.__perfBytes = 0;
          S.live.rboCount--;
        }
        return origDeleteRbo.call(this, rb);
      };
    }

    /* ---- draws ---- */
    const countTris = (mode, count, inst = 1) => {
      S.draws++;
      if (mode === 4) S.drawTris += (count / 3) * inst; // TRIANGLES
      else if (mode === 5 || mode === 6) S.drawTris += Math.max(0, count - 2) * inst;
    };
    for (const [fn, kind] of [
      ["drawElements", "e"],
      ["drawArrays", "a"],
      ["drawElementsInstanced", "ei"],
      ["drawArraysInstanced", "ai"],
      ["drawRangeElements", "re"],
    ]) {
      const orig = proto[fn];
      if (!orig) continue;
      proto[fn] = function (...a) {
        const r = orig.apply(this, a);
        if (kind === "e") countTris(a[0], a[1]);
        else if (kind === "a") countTris(a[0], a[2]);
        else if (kind === "ei") countTris(a[0], a[1], a[4]);
        else if (kind === "ai") countTris(a[0], a[2], a[3]);
        else countTris(a[0], a[3]);
        return r;
      };
    }

    for (const [fn, bucket] of [
      ["createProgram", "created"],
      ["linkProgram", "linked"],
      ["deleteProgram", "deleted"],
    ]) {
      const orig = proto[fn];
      if (!orig) continue;
      proto[fn] = function (...a) {
        S.programs[bucket]++;
        /* When in init the shaders are linked, which bounds their share of it
         * without depending on any timing being trustworthy. If the first link
         * happens at t=24 s of a 27 s init, then 24 s of init contains no
         * shader work at all and compilation cannot be what init is made of —
         * a claim that survives an arbitrarily noisy host, because it is about
         * ordering rather than duration. */
        if (bucket === "linked") {
          const t = performance.now();
          if (S.programs.firstLinkMs === null) S.programs.firstLinkMs = t;
          S.programs.lastLinkMs = t;
        }
        return orig.apply(this, a);
      };
    }

    /* Where shader compilation actually costs wall time.
     *
     * `compileShader` and `linkProgram` are asynchronous in every modern
     * driver: they queue work and return almost immediately, so timing them
     * measures the queueing, not the compile. The cost lands when something
     * *asks for the result* — `getProgramParameter(LINK_STATUS)`,
     * `getShaderParameter(COMPILE_STATUS)`, or an info log — because those
     * force a synchronous wait for the driver to finish.
     *
     * Three does exactly that, in `WebGLProgram`'s constructor path, once per
     * program. So `blockedMs` below is the part of init that is spent stalled
     * on the shader compiler, and it is separable from `queuedMs`, which is
     * not a cost. Reporting only a program *count* cannot distinguish 144
     * trivial variants from 70 expensive ones. */
    const timed = (fn, bucket, isSync) => {
      const orig = proto[fn];
      if (!orig) return;
      proto[fn] = function (...a) {
        const t0 = performance.now();
        const r = orig.apply(this, a);
        const dt = performance.now() - t0;
        S.shaderTime[bucket] += dt;
        S.shaderTime.calls[bucket] = (S.shaderTime.calls[bucket] || 0) + 1;
        if (isSync && dt > S.shaderTime.worstBlockMs) S.shaderTime.worstBlockMs = dt;
        return r;
      };
    };
    timed("compileShader", "queuedMs", false);
    timed("linkProgram", "queuedMs", false);
    // The synchronous ones. `getProgramParameter` is also used for uniform and
    // attribute counts, which are cheap; the LINK_STATUS query is the stall,
    // and it dominates the bucket by orders of magnitude.
    timed("getProgramParameter", "blockedMs", true);
    timed("getShaderParameter", "blockedMs", true);
    timed("getProgramInfoLog", "blockedMs", true);
    timed("getShaderInfoLog", "blockedMs", true);
    for (const [fn, bucket] of [
      ["createFramebuffer", "created"],
      ["deleteFramebuffer", "deleted"],
    ]) {
      const orig = proto[fn];
      if (!orig) continue;
      proto[fn] = function (...a) {
        S.framebuffers[bucket]++;
        return orig.apply(this, a);
      };
    }
    const origReadPixels = proto.readPixels;
    proto.readPixels = function (...a) {
      S.readPixels++;
      return origReadPixels.apply(this, a);
    };
  }

  wrap(window.WebGL2RenderingContext?.prototype);
  wrap(window.WebGLRenderingContext?.prototype);

  /* A silent context loss is indistinguishable from a browser crash from the
   * outside. Catch it on every canvas the page creates. */
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (/webgl/i.test(String(type)) && !this.__perfLossHooked) {
      this.__perfLossHooked = true;
      this.addEventListener("webglcontextlost", (e) => {
        S.contextLost.push({ t: performance.now(), statusMessage: e.statusMessage || "" });
        console.error("[perf] WEBGL CONTEXT LOST", e.statusMessage || "");
      });
      this.addEventListener("webglcontextrestored", () => {
        console.error("[perf] webgl context restored");
      });
      if (ctx) {
        S.contextAttrs = ctx.getContextAttributes?.() ?? null;
        S.drawingBuffer = { w: ctx.drawingBufferWidth, h: ctx.drawingBufferHeight };
      }
    }
    return ctx;
  };

  /* ------------------------------------------------------------------ *
   * Event listener census.
   *
   * CDP's `Performance.getMetrics` reports `JSEventListeners` as a single
   * number. A number that only goes up tells you there is a leak and nothing
   * whatsoever about where it is, and the usual suspects — `addEventListener`
   * calls in system init — are all one-shot and easy to exonerate by reading
   * the source, which leaves you with a real leak and no candidates.
   *
   * The reason those searches come up empty here is that `addEventListener` is
   * not the only way to register one: assigning to an `onfoo` property does it
   * too, that assignment is invisible to a grep for "addEventListener", and
   * Web Audio schedules a lot of `onended`. Both routes are counted below,
   * bucketed by target type and event, with a stack for the first few of each
   * so the answer is a source location rather than a suspicion.
   * ------------------------------------------------------------------ */
  const LIS = { total: 0, byKey: Object.create(null), stacks: Object.create(null) };
  S.listeners = LIS;

  const noteListener = (target, type, via) => {
    let name = "unknown";
    try {
      name = target?.constructor?.name || Object.prototype.toString.call(target);
    } catch {
      /* exotic proxies */
    }
    const key = `${name}.${type}${via === "prop" ? " (onprop)" : ""}`;
    LIS.total++;
    LIS.byKey[key] = (LIS.byKey[key] || 0) + 1;
    // Three stacks per key is enough to locate it and cheap enough to leave on.
    const seen = LIS.stacks[key];
    if (!seen || seen.length < 3) {
      (LIS.stacks[key] ||= []).push(
        (new Error().stack || "").split("\n").slice(3, 8).map((l) => l.trim()).join(" << ")
      );
    }
  };

  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      noteListener(this, type, "add");
    } catch {
      /* never let instrumentation break the page */
    }
    return origAdd.call(this, type, fn, opts);
  };

  // The `onfoo` route. Only the handful of interfaces that can plausibly be
  // created in a loop are wrapped; wrapping every `on*` accessor in the DOM
  // would be a lot of accessor churn for no extra information.
  for (const iface of [
    window.AudioScheduledSourceNode,
    window.AudioBufferSourceNode,
    window.OscillatorNode,
    window.AudioWorkletNode,
    window.HTMLMediaElement,
    window.XMLHttpRequest,
    window.Image,
  ]) {
    const proto = iface?.prototype;
    if (!proto) continue;
    for (const prop of Object.getOwnPropertyNames(proto)) {
      if (!prop.startsWith("on")) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc?.set || !desc.configurable) continue;
      const set = desc.set;
      Object.defineProperty(proto, prop, {
        ...desc,
        set(value) {
          try {
            if (value != null) noteListener(this, prop.slice(2), "prop");
          } catch {
            /* as above */
          }
          return set.call(this, value);
        },
      });
    }
  }
})();
