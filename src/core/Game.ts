import * as THREE from "three";
import type { GameSystem, SystemContext } from "./types";
import { setMaxAnisotropy, auditSceneMapChannels } from "../gen/textures";
import { preallocateShadowMaps, reclaimShadowColourAttachments } from "./shadowMemory";

declare global {
  interface Window {
    __SCENE_READY?: boolean;
    __GAME?: Game;
    /**
     * Systems whose init() or update() threw. Empty array once start() has run
     * cleanly, so a capture harness can assert `__SYSTEM_ERRORS.length === 0`
     * and still treat a broken system as a hard error — the isolation below is
     * there so one failure cannot hide every other system, not to hide it.
     */
    __SYSTEM_ERRORS?: { system: string; phase: "init" | "update"; message: string; stack?: string }[];
    /**
     * Set the moment the WebGL context is lost. A harness can assert this is
     * undefined; see the handler in `Game` for why a silent loss is worth a
     * dedicated flag.
     */
    __CONTEXT_LOST?: { at: number; frames: number; statusMessage: string };
  }
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly clock = new THREE.Clock();

  private systems: GameSystem[] = [];
  /**
   * The subset `?solo=` / `?skip=` left running. The update loop iterates this
   * and not `systems`: filtering only `init()` meant a skipped system still had
   * `update()` called every frame with none of its own state built, which threw
   * on the first tick and pushed a fabricated entry onto `__SYSTEM_ERRORS`. Any
   * harness that (correctly) fails on a non-empty `__SYSTEM_ERRORS` could
   * therefore never use the isolation flag that exists to unblock it.
   */
  private active: GameSystem[] = [];
  private services = new Map<string, unknown>();
  private ctx!: SystemContext;
  private framesRendered = 0;
  private running = false;
  /** Names of systems that threw; skipped by the update loop from then on. */
  private failed = new Set<string>();
  private failures: NonNullable<Window["__SYSTEM_ERRORS"]> = [];

  /** Non-null when a deterministic camera pose was requested via ?shot=... */
  readonly shot: string | null;

  /** `?noshadowopt=1` puts the shadow map back on three's default RGBA8 colour
   *  attachment, so the 192 MB saving can be A/B'd against the same bundle. */
  private readonly shadowOptimise: boolean;

  constructor(canvas?: HTMLCanvasElement) {
    const params = new URLSearchParams(location.search);
    this.shot = params.get("shot");
    this.shadowOptimise = !params.has("noshadowopt");

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const expo = new URLSearchParams(location.search).get("expo");
    this.renderer.toneMappingExposure = expo ? Number(expo) : 1.25;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in r185 and silently downgrades to
    // PCFShadowMap, which is the hardware-PCF Vogel-disk path System 4 widens
    // to sixteen taps in `lightShaderPatches`. Naming it directly avoids the
    // warning and makes it obvious which filter the bias values were tuned for.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Physically correct falloff / units are the r155+ default; make it explicit.
    THREE.ColorManagement.enabled = true;
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    // ?gpu=1 prints the adapter actually in use. Worth checking whenever the
    // scene looks unexpectedly soft: a software rasteriser reports a much lower
    // anisotropy cap, which flattens every surface seen at a grazing angle.
    if (params.has("gpu")) {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      console.log(
        `[dawn-station] renderer: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}` +
          `  maxAnisotropy: ${this.renderer.capabilities.getMaxAnisotropy()}`
      );
    }

    this.watchContextLoss();
    this.reportBackbufferCost();

    if (!canvas) document.body.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.08, 2500);
    this.camera.position.set(0, 1.65, 6);

    window.addEventListener("resize", this.onResize);
    window.__GAME = this;
    window.__SYSTEM_ERRORS = this.failures;
  }

  /**
   * A lost WebGL context is indistinguishable, from where the user is sitting,
   * from the browser crashing: the canvas freezes on its last frame or goes
   * white, the animation loop keeps being called, and nothing is logged. This
   * scene holds close to a gigabyte of GPU memory (a single 8192 shadow map is
   * over half of it) on an 8 GB card that several headless capture runs share,
   * so driver-level eviction is a live possibility rather than a theoretical
   * one, and it must not be diagnosed by guesswork a second time.
   *
   * Deliberately does *not* call `preventDefault()`. Doing so asks the browser
   * to restore the context, which changes recovery behaviour and would need its
   * own testing against every system's GPU resources; the job here is to make
   * the failure legible, not to silently paper over it.
   */
  /**
   * Prints what the default framebuffer costs on *this* display.
   *
   * It is the one large GPU allocation that nothing can measure from inside the
   * page: it is not a `THREE.Texture`, it never passes through `texImage2D`, so
   * a GL-level instrumentation harness and `renderer.info` are both blind to it,
   * and every headless capture in this repo runs at 1920x1080 with
   * `devicePixelRatio` 1 — the cheapest case there is.
   *
   * It also scales with the square of the pixel ratio, so the number the user
   * pays is not the number anyone has ever measured. Measured at 71 MB for
   * 1920x1080 at DPR 1 with the 4x MSAA Chrome picks here; the same window at
   * DPR 2, or a 1440p one at 150% Windows scaling, is 284 MB; a 1440p window at
   * DPR 2 is 505 MB. On an 8 GB card, next to this scene's ~760 MB of textures
   * and buffers, that is the difference between comfortable and evicting.
   *
   * Logged rather than acted on: capping the pixel ratio or dropping `antialias`
   * are both visible changes and belong to whoever owns the look, not here.
   */
  private reportBackbufferCost(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = size.x * size.y;
    // Chrome asks the driver for 4x MSAA when `antialias: true` and the context
    // is WebGL2; colour and depth are both allocated at sample count, plus a
    // single-sample surface to resolve into. stencil is off, so depth is D24
    // occupying 4 bytes.
    const samples = this.renderer.getContext().getParameter(WebGL2RenderingContext.SAMPLES) || 1;
    const bytes = px * 4 * samples + px * 4 * samples + px * 4;
    console.log(
      `[dawn-station] drawing buffer ${size.x}x${size.y} (DPR ${this.renderer.getPixelRatio()}), ${samples}x MSAA ` +
        `-> ~${(bytes / 1048576).toFixed(0)} MB of GPU memory for the default framebuffer alone, ` +
        `which no in-page profiler can see. Scene textures are reported separately.`
    );
  }

  private watchContextLoss(): void {
    const canvas = this.renderer.domElement;

    canvas.addEventListener("webglcontextlost", (event) => {
      const e = event as WebGLContextEvent;
      const detail = { at: performance.now(), frames: this.framesRendered, statusMessage: e.statusMessage || "" };
      window.__CONTEXT_LOST = detail;
      this.running = false;
      this.renderer.setAnimationLoop(null);
      console.error(
        `[game] WEBGL CONTEXT LOST after ${detail.frames} frames (${(detail.at / 1000).toFixed(1)}s). ` +
          `The canvas is now frozen and this is NOT a crash in the page's JavaScript. ` +
          `The usual cause is the GPU running out of memory or the driver resetting (TDR) — ` +
          `check how many other GPU processes are running before blaming the scene. ` +
          `statusMessage: ${detail.statusMessage || "(none)"}`
      );
      // Also on the error channel a harness watches, so an automated run fails
      // rather than quietly capturing a frozen frame.
      window.__SYSTEM_ERRORS?.push({
        system: "renderer",
        phase: "update",
        message: `WebGL context lost after ${detail.frames} frames: ${detail.statusMessage || "no status message"}`,
      });
      const el = document.createElement("div");
      el.style.cssText =
        "position:fixed;inset:auto 0 0 0;z-index:99;padding:12px 16px;background:#3a1216ee;color:#ffd9d2;" +
        "font:600 13px/1.5 ui-sans-serif,system-ui,sans-serif;border-top:1px solid #ff6b5b55";
      el.textContent = "WebGL context lost — the GPU dropped this page. See the console; this is not a script error.";
      document.body.appendChild(el);
    });

    canvas.addEventListener("webglcontextrestored", () => {
      console.error("[game] webgl context restored. Nothing re-uploads it automatically; reload the page.");
    });

    canvas.addEventListener("webglcontextcreationerror", (event) => {
      console.error(`[game] WEBGL CONTEXT CREATION FAILED: ${(event as WebGLContextEvent).statusMessage || "(no status message)"}`);
    });
  }

  /**
   * A system that throws is disabled and skipped, never fatal to the rest of
   * the scene. Before this, one bad init() rejected out of start() and left
   * __SCENE_READY unset, so a single broken system blanked the page for every
   * other agent's captures. The failure is logged loudly and published on
   * `window.__SYSTEM_ERRORS` so a harness can still fail the run on it.
   */
  private recordFailure(s: GameSystem, phase: "init" | "update", err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    const first = !this.failed.has(s.name);
    this.failed.add(s.name);
    if (first) {
      this.failures.push({ system: s.name, phase, message: e.message, stack: e.stack });
      console.error(
        `[game] SYSTEM FAILED: "${s.name}" threw during ${phase}() and has been DISABLED. ` +
          `The rest of the scene will continue. window.__SYSTEM_ERRORS has the details.`,
        e
      );
    }
  }

  /** Publish a shared object for later systems. */
  provide<T>(key: string, value: T): T {
    this.services.set(key, value);
    return value;
  }

  require<T>(key: string): T {
    if (!this.services.has(key)) throw new Error(`Game: no service registered for "${key}"`);
    return this.services.get(key) as T;
  }

  tryGet<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  /**
   * Every key published so far, so a consumer can pick up a *family* of
   * services rather than a fixed list. `src/core/collision.ts` uses it to find
   * every `*.blockers` producer, which is what lets a system become solid by
   * publishing one key with nothing to edit on the consuming side.
   */
  serviceKeys(): string[] {
    return [...this.services.keys()];
  }

  register(...systems: GameSystem[]): this {
    this.systems.push(...systems);
    return this;
  }

  async start(): Promise<void> {
    this.ctx = {
      game: this,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      shot: this.shot,
    };
    // `?skip=pumps,building` / `?solo=terrain,sky` restrict which systems come
    // up. Several agents build this repo at once, and an exception thrown from
    // any one system's init() aborts start() and leaves __SCENE_READY unset, so
    // one system's in-progress code blocks every other system's captures. This
    // lets a capture isolate the system under review.
    const q = new URLSearchParams(location.search);
    const list = (k: string) => (q.get(k) ?? "").split(",").filter(Boolean);
    const skip = list("skip");
    const solo = list("solo");
    const unknown = [...skip, ...solo].filter((n) => !this.systems.some((s) => s.name === n));
    if (unknown.length) {
      // Case 25: a misspelt name that is silently ignored produces a capture of
      // a scene nobody asked for, and it looks exactly like a correct one.
      throw new Error(
        `Game: unknown system name(s) in ?skip=/?solo=: ${unknown.join(", ")}. ` +
          `Registered: ${this.systems.map((s) => s.name).join(", ")}`
      );
    }
    const active = this.systems.filter(
      (s) => !skip.includes(s.name) && (solo.length === 0 || solo.includes(s.name))
    );
    this.active = active;
    if (active.length !== this.systems.length) {
      console.warn(`[game] running ${active.length}/${this.systems.length} systems: ${active.map((s) => s.name).join(", ")}`);
    }
    /* Per-system init cost, published for any harness that wants it.
     *
     * Init is ~25 s and it is the phase in which the user's browser died, and
     * until now nobody could say where the time went. Measurement said shader
     * compilation is only 6.5% of it (1.6 s of 24.8 s, timed from the GL calls
     * that block on the driver), which leaves ~23 s of CPU-side procedural
     * generation attributed to nobody.
     *
     * A number per system beats seven agents guessing. This is instrumentation
     * only: it adds two `performance.now()` calls per system and changes no
     * behaviour. `?solo=`/`?skip=` already existed for the same question, but
     * they need one run per system and init wall time varies ±20% on this host,
     * so seven runs cannot be compared against each other. One run that reports
     * all seven can. */
    const initTimings: Record<string, number> = {};
    for (const s of active) {
      const t0 = performance.now();
      try {
        await s.init(this.ctx);
      } catch (err) {
        this.recordFailure(s, "init", err);
      }
      initTimings[s.name] = performance.now() - t0;
    }
    (window as unknown as { __INIT_TIMINGS?: Record<string, number> }).__INIT_TIMINGS = initTimings;
    const ranked = Object.entries(initTimings).sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((a, [, ms]) => a + ms, 0);
    console.log(
      `[game] init ${(total / 1000).toFixed(1)} s: ` +
        ranked.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)}s`).join(", ")
    );
    if (new URLSearchParams(location.search).has("sample")) {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 90;
      this.sampler = c.getContext("2d", { willReadFrequently: true });
      (window as unknown as { __sample: (u: number, v: number) => string }).__sample = (u, v) => {
        const d = this.sampler!.getImageData(Math.round(u * 159), Math.round(v * 89), 1, 1).data;
        return `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      };
    }
    // Before the first frame, so three never allocates the oversized shadow
    // colour attachment at all. Deliberately after init(): the lights do not
    // exist before it, and `mapSize` is a system's to choose.
    if (this.shadowOptimise) {
      for (const s of preallocateShadowMaps(this.scene, this.renderer, this.camera)) {
        console.log(`[game] pre-built ${s.light}'s ${s.size} shadow map, avoiding a ${(s.savedBytes / 1048576).toFixed(0)} MB allocation`);
      }
    }

    /* The call site `gen/textures.ts` asked for, so its map-channel guard stops
     * being a tool and becomes a gate. It throws on the first slot whose
     * texture cannot supply the channel three's shader samples from it — both
     * the declared format and, for RGBA textures, whether the sampled channel
     * is actually all-zero in the bytes.
     *
     * DEV only, and it throws rather than warning. That is the point: the
     * repo-wide audit found zero broken sites today, so anything it reports
     * tomorrow is new, and a `RedFormat` texture in an `alphaMap` slot fails by
     * producing a plausible frame — which is this project's signature failure
     * and the reason a warning would not do.
     *
     * The count is logged on success. A guard that passes in silence is
     * indistinguishable from a guard that never ran, and "the check did not
     * fail, it failed to run" has cost this project more rounds than any bug. */
    // Cast because this tsconfig does not pull in `vite/client`, so
    // `import.meta.env` is untyped. Adding a global `/// <reference>` would be
    // the tidier fix and is a shared-file change I am not making unilaterally
    // with six agents live in the tree.
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      const findings = auditSceneMapChannels(this.scene);
      console.log(`[game] map-channel audit passed: ${findings.length} advisory finding(s), 0 broken slots`);
    }

    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Debug only: ?sample=1 mirrors the frame into a 2D canvas so tools can read pixels. */
  private sampler: CanvasRenderingContext2D | null = null;

  private frame = () => {
    if (!this.running) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    for (const s of this.active) {
      if (this.failed.has(s.name)) continue;
      try {
        s.update?.(dt, t, this.ctx);
      } catch (err) {
        this.recordFailure(s, "update", err);
      }
    }
    this.renderer.render(this.scene, this.camera);

    // Fallback for any shadow map `preallocateShadowMaps` declined or three
    // rebuilt (it re-allocates when the shadow map *type* changes). Normally a
    // no-op: one WeakSet lookup per shadow-casting light.
    if (this.shadowOptimise) {
      for (const s of reclaimShadowColourAttachments(this.scene)) {
        console.log(`[game] reclaimed ${(s.savedBytes / 1048576).toFixed(0)} MB from ${s.light}'s ${s.size} shadow colour attachment`);
      }
    }

    if (this.sampler) {
      const c = this.sampler.canvas;
      this.sampler.drawImage(this.renderer.domElement, 0, 0, c.width, c.height);
    }

    this.framesRendered++;
    // A few frames of headroom so shader compiles and mipmaps have settled
    // before the screenshot harness grabs the canvas.
    if (this.framesRendered === 2) {
      document.getElementById("loading")?.remove();
      document.getElementById("hud")?.classList.toggle("hidden", !!this.shot);
    }
    if (this.framesRendered === 6) {
      window.__SCENE_READY = true;
      window.dispatchEvent(new CustomEvent("scene-ready"));
    }
  };

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    for (const s of this.active) s.resize?.(w, h);
  };

  dispose() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    for (const s of this.active) s.dispose?.();
    this.renderer.dispose();
  }
}
