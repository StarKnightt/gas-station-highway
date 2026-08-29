import * as THREE from "three";
import type { GameSystem, SystemContext } from "./types";
import { setMaxAnisotropy, auditSceneMapChannels } from "../gen/textures";
import { preallocateShadowMaps, reclaimShadowColourAttachments } from "./shadowMemory";
import {
  AdaptiveQuality,
  mulberry32,
  permuteInstanceAttribute,
  resolveQuality,
  type HostCapability,
  type QualitySettings,
} from "./capability";

declare global {
  interface Window {
    __SCENE_READY?: boolean;
    __GAME?: Game;
    /**
     * The active quality tier, why it was chosen, and the host facts behind it.
     *
     * Exposed because a tier system that cannot be inspected will be debugged by
     * guesswork. `steps` accumulates every runtime demotion or promotion with
     * its trigger, so "it looked blurry after a while" becomes a readable trace
     * rather than a report nobody can reproduce.
     */
    __QUALITY?: {
      tier: string;
      forced: boolean;
      reasons: string[];
      settings: QualitySettings;
      capability: HostCapability;
      steps: string[];
    };
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
  /** Resolved before the renderer; see the constructor and `capability.ts`. */
  readonly quality: QualitySettings;
  private adaptive?: AdaptiveQuality;
  /** Instanced scatter meshes and their authored counts, for the density lever. */
  private scatterBaseline: { mesh: THREE.InstancedMesh; authored: number }[] = [];
  private scatterShuffled = false;
  /**
   * Frames whose real delta exceeded the 100 ms simulation clamp, and how much
   * simulation time was discarded. Exposed at `window.__CLAMP`; see `frame()`.
   */
  private clampStats = {
    frames: 0,
    lostSimMs: 0,
    worstRawMs: 0,
    /** Deltas so long the loop was not being driven at all; never priced. */
    stalls: 0,
    worstStallMs: 0,
    magnitudesMs: [] as number[],
  };
  /** Instance-matrix versions right after the shuffle, for the mutation check. */
  private scatterVersions = new Map<THREE.InstancedMesh, number>();
  private lastFrameAt = 0;
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

    // Resolved before the renderer exists, because `antialias` is a context
    // creation attribute and cannot be changed afterwards. `resolveQuality` uses
    // its own throwaway 1x1 context for exactly this reason.
    const resolved = resolveQuality(location.search);
    this.quality = resolved.settings;
    window.__QUALITY = {
      tier: this.quality.tier,
      forced: resolved.forced,
      reasons: resolved.reasons,
      settings: this.quality,
      capability: resolved.capability,
      steps: [],
    };
    // Logged unconditionally, and on one line a user can paste into a bug
    // report. A tier chosen silently is indistinguishable from a tier chosen
    // wrongly, and this scene has no other way to tell us which one ran.
    console.log(
      `[quality] tier=${this.quality.tier}${resolved.forced ? " (forced)" : ""} — ${resolved.reasons.join("; ")}\n` +
        `[quality] ${resolved.capability.renderer} | maxTex ${resolved.capability.maxTextureSize} | ` +
        `parallelCompile ${resolved.capability.parallelShaderCompile} | threads ${resolved.capability.cpuThreads} | ` +
        `deviceMemory ${resolved.capability.deviceMemoryGb || "n/a"} GB\n` +
        `[quality] shadow ${this.quality.shadowMapSize}^2/${this.quality.shadowFilter}, ` +
        `dprCap ${this.quality.dprCap}, msaa ${this.quality.antialias}, scatter ${this.quality.scatterDensity}, ` +
        `transmission ${this.quality.transmission}, worldCapture ${this.quality.worldCapture}`
    );
    // Also on the root element, so a screenshot of the DOM or a page inspection
    // carries the tier without needing the console.
    document.documentElement.dataset.qualityTier = this.quality.tier;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dprCap));
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
    // Tier-selected. `basic` is a single tap and, more importantly for a weak
    // host, the cheapest shadow chunk three has — this is a compile-time lever
    // as much as a fill-rate one. Never `enabled = false` at any tier: a scene
    // with no shadows at dawn does not read as plainer, it reads as broken.
    this.renderer.shadowMap.type =
      this.quality.shadowFilter === "basic" ? THREE.BasicShadowMap : THREE.PCFShadowMap;
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
      quality: this.quality,
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
    /* Three events and one yield, for the boot overlay in
     * `src/core/loadingScreen.ts`. `__INIT_TIMINGS` is only published after
     * the whole loop, which is too late to drive a progress bar; these say the
     * same thing as it happens. Names come from the *filtered* list, so
     * `?solo=` / `?skip=` are handled without the consumer knowing about them.
     *
     * The yield is not cosmetic. A system's `init()` is synchronous procedural
     * generation — `terrain` holds the main thread for about eleven seconds —
     * and `await` on a synchronous function only drains microtasks, so without
     * a real task boundary the browser never paints the label naming the
     * system it is about to block on. rAF is raced against a timeout because
     * rAF does not fire in a backgrounded tab, and a loading screen must not
     * be able to stall the load it is reporting on. */
    const paintYield = () =>
      new Promise<void>((resolve) => {
        let done = false;
        const go = () => {
          if (done) return;
          done = true;
          resolve();
        };
        requestAnimationFrame(() => setTimeout(go, 0));
        setTimeout(go, 60);
      });
    window.dispatchEvent(new CustomEvent("systems-active", { detail: { names: active.map((s) => s.name) } }));
    for (const s of active) {
      window.dispatchEvent(new CustomEvent("system-init-start", { detail: { name: s.name } }));
      await paintYield();
      const t0 = performance.now();
      try {
        await s.init(this.ctx);
      } catch (err) {
        this.recordFailure(s, "init", err);
      }
      initTimings[s.name] = performance.now() - t0;
      window.dispatchEvent(new CustomEvent("system-init-done", { detail: { name: s.name, ms: initTimings[s.name] } }));
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
    /* The most important of the four yields, and the one whose absence was
     * caught in pixels rather than in review. Everything below — shadow-map
     * preallocation and then the first frame, where the driver compiles every
     * program in the scene — is one unbroken block, and on a cold load it was
     * measured at 190 s of a 218 s load. Without a paint here the overlay's
     * switch into its shader-compile stage is written to the DOM and never
     * shown, so the last thing on screen for three minutes is the label and
     * percentage of the final `init()`. That is indistinguishable from a hang,
     * which is the exact failure the overlay exists to rule out. */
    await paintYield();

    this.clampShadowMapsToTier();

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

    this.captureScatterBaseline();
    this.applyScatterDensity(1, `tier ${this.quality.tier}`);
    this.adaptive = new AdaptiveQuality((dprScale, scatter, why) => {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dprCap) * dprScale);
      this.applyScatterDensity(scatter, why);
      window.__QUALITY?.steps.push(why);
    });

    // Read by `stress.mjs`. A getter rather than a snapshot so a harness always
    // sees live counters without the game having to push them.
    Object.defineProperty(window, "__CLAMP", {
      configurable: true,
      get: () => ({
        frames: this.clampStats.frames,
        lostSimMs: +this.clampStats.lostSimMs.toFixed(1),
        worstRawMs: +this.clampStats.worstRawMs.toFixed(1),
        stalls: this.clampStats.stalls,
        worstStallMs: +this.clampStats.worstStallMs.toFixed(1),
        magnitudesMs: this.clampStats.magnitudesMs.slice(),
        framesRendered: this.framesRendered,
        /**
         * Zeroes the counters. A harness calls this at the start of the phase it
         * cares about, so init and any pre-walk main-thread work are excluded
         * rather than averaged in.
         */
        reset: () => {
          this.clampStats.frames = 0;
          this.clampStats.lostSimMs = 0;
          this.clampStats.worstRawMs = 0;
          this.clampStats.stalls = 0;
          this.clampStats.worstStallMs = 0;
          this.clampStats.magnitudesMs.length = 0;
        },
      }),
    });

    this.running = true;
    this.clock.start();
    this.lastFrameAt = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  /**
   * Clamps every shadow map to the tier's ceiling, before anything allocates.
   *
   * This runs between `init()` and `preallocateShadowMaps`, which is the only
   * window where it is both possible and free: the lights exist, and no shadow
   * texture has been created yet, so lowering `mapSize` here means the large
   * allocation never happens rather than happening and being freed. The earlier
   * peak-versus-steady-state inversion in this file is the same lesson —
   * creating 8192² and reclaiming it costs the peak, which is where the crash
   * lives.
   *
   * It is worth being explicit that this **overrides a value another system
   * authored**, which the comment below the call site says is theirs to choose.
   * Two things make that acceptable rather than a land-grab:
   *
   *   - At `high` it is a no-op. The tier ceiling is 8192, the authored value is
   *     8192, nothing changes, and the default experience is byte-identical.
   *   - It is loud. Any clamp logs the light, the authored size and the new one,
   *     so a system whose shadows look coarser can see why in one line instead
   *     of suspecting its own bias values.
   *
   * The alternative — having `LightingSystem` read `ctx.quality.shadowMapSize`
   * — is better, and is the recommended hook. This is the version that works
   * without editing another owner's file while they are converging.
   */
  private clampShadowMapsToTier(): void {
    const ceiling = this.quality.shadowMapSize;
    this.scene.traverse((o) => {
      const light = o as THREE.Light & { shadow?: THREE.LightShadow };
      const shadow = light.shadow;
      if (!shadow) return;
      const authored = Math.max(shadow.mapSize.x, shadow.mapSize.y);
      if (authored <= ceiling) return;
      const before = `${shadow.mapSize.x}x${shadow.mapSize.y}`;
      shadow.mapSize.set(Math.min(shadow.mapSize.x, ceiling), Math.min(shadow.mapSize.y, ceiling));
      // If three already built a map for this light, drop it so the next render
      // rebuilds at the new size. Normally null at this point.
      shadow.map?.dispose();
      shadow.map = null;
      const savedMb = ((authored ** 2 - ceiling ** 2) * 4) / 1048576;
      console.log(
        `[quality] shadow map for ${light.name || light.type} clamped ${before} -> ` +
          `${shadow.mapSize.x}x${shadow.mapSize.y} by tier ${this.quality.tier} (~${savedMb.toFixed(0)} MB)`
      );
    });
  }

  /**
   * Records every instanced scatter mesh's authored instance count, once, after
   * init.
   *
   * The density lever works by lowering `InstancedMesh.count`, which three
   * honours per draw without touching the buffers. That matters for two reasons
   * beyond cheapness: it is reversible, so the adaptive stepper can put density
   * back; and it needs no edit to the systems that build the scatter layers,
   * which belong to other owners who are converging right now.
   *
   * The authored count has to be captured before anything scales it, or a second
   * demotion would scale an already-scaled number and the density would decay
   * geometrically instead of landing where the tier asked.
   *
   * Only *scatter* layers qualify. The test is instance count, not name: a mesh
   * with thousands of instances is a scatter layer whatever it is called, and
   * one with a handful is structural — the canopy's six columns are an
   * `InstancedMesh` too, and thinning those would delete the building.
   */
  private captureScatterBaseline(): void {
    const SCATTER_MIN_INSTANCES = 64;
    this.scatterBaseline = [];
    this.scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && m.count >= SCATTER_MIN_INSTANCES) {
        this.scatterBaseline.push({ mesh: m, authored: m.count });
      }
    });
  }

  /**
   * Scales every scatter layer's drawn instance count.
   *
   * `adaptiveFactor` is the runtime stepper's own multiplier, kept separate from
   * the tier's `scatterDensity` so the two compose once rather than twice.
   *
   * COMPOSITION WITH SYSTEMS THAT HONOUR THE TIER AT GENERATION
   * ----------------------------------------------------------
   * A system that builds fewer instances saves generation time and memory as
   * well as frametime, which is strictly better than thinning at draw time. But
   * if it does that *and* this lever also applies the tier factor, the two
   * multiply: 0.25 x 0.25 is 6% of the instances at `low`, not 25%.
   *
   * So the contract is: **a system that has already applied
   * `ctx.quality.scatterDensity` at generation sets
   * `mesh.userData.tierScatterApplied = true`**, and this lever then applies only
   * the adaptive factor to that mesh. One line on the system's side, and it
   * composes correctly whether or not the system opts in.
   *
   * Clamped to at least one instance: a layer at count 0 has visibly vanished,
   * and the tier contract is "plainer, not broken".
   */
  private applyScatterDensity(adaptiveFactor: number, why: string): void {
    if (this.scatterBaseline.length === 0) return;
    const adaptive = Math.max(0, Math.min(1, adaptiveFactor));
    let before = 0;
    let after = 0;
    let thinned = false;

    for (const { mesh, authored } of this.scatterBaseline) {
      const alreadyTiered = mesh.userData?.tierScatterApplied === true;
      const d = Math.max(0, Math.min(1, (alreadyTiered ? 1 : this.quality.scatterDensity) * adaptive));
      if (d < 1) thinned = true;
      before += mesh.count;
      mesh.count = Math.max(1, Math.round(authored * d));
      after += mesh.count;
    }

    // Only shuffle once anything is actually being thinned, so the high tier
    // with no adaptive demotion never touches an instance buffer and the default
    // experience stays byte-identical.
    if (thinned) this.ensureScatterShuffled();

    if (before !== after) {
      console.log(
        `[quality] scatter: ${before} -> ${after} instances across ${this.scatterBaseline.length} layers ` +
          `(tier ${this.quality.scatterDensity}, adaptive ${adaptive.toFixed(2)}; ${why})`
      );
    }
  }

  /**
   * Randomises instance order once, so that lowering `count` samples the layer
   * instead of amputating part of it.
   *
   * THE BUG THIS FIXES
   * ------------------
   * `count = authored * d` draws instances `0..n-1`, which is uniform thinning
   * **only if instance order is spatially uncorrelated.** A scatter built group
   * by group is maximally correlated: one layer here fills as annulus, then gap
   * ring, then road corridor in contiguous blocks, so `d = 0.25` did not thin
   * the far scrub — **it deleted the gap ring and the road corridor entirely and
   * kept the annulus whole.** Another fills in grid-scan order, where truncation
   * removes a contiguous band of z. Both read as a hole in the world rather than
   * as a sparser world, and both were invisible in the aggregate instance count
   * my own harness was checking.
   *
   * A fixed seed, so a tier renders identically run to run and a pixel diff
   * between two runs of the same tier stays a valid comparison.
   *
   * `instanceMatrix` and `instanceColor` are the only per-instance stores to
   * permute: nothing in this scene uses a custom `InstancedBufferAttribute`, and
   * that is asserted below rather than assumed.
   */
  private ensureScatterShuffled(): void {
    if (this.scatterShuffled) return;
    this.scatterShuffled = true;

    // A geometry shared by two instanced meshes would be permuted twice, and the
    // second permutation would not match the first mesh's matrices. Nothing here
    // does that today; skip rather than corrupt if it ever starts.
    const geomUse = new Map<string, number>();
    for (const { mesh } of this.scatterBaseline) {
      geomUse.set(mesh.geometry.uuid, (geomUse.get(mesh.geometry.uuid) ?? 0) + 1);
    }

    let shuffled = 0;
    let skipped = 0;
    for (const { mesh, authored } of this.scatterBaseline) {
      if ((geomUse.get(mesh.geometry.uuid) ?? 0) > 1) {
        skipped++;
        console.warn(
          `[quality] not shuffling ${mesh.name || "instanced mesh"}: its geometry is shared by ` +
            `another instanced layer, so thinning it will still truncate in generation order`
        );
        continue;
      }
      if (mesh.geometry.attributes && Object.values(mesh.geometry.attributes).some((a) => "meshPerAttribute" in a)) {
        skipped++;
        console.warn(
          `[quality] not shuffling ${mesh.name || "instanced mesh"}: it has a custom instanced ` +
            `attribute this lever does not know how to permute`
        );
        continue;
      }

      const rng = mulberry32(0x5ca77e2 ^ authored);
      const order = new Uint32Array(authored);
      for (let i = 0; i < authored; i++) order[i] = i;
      for (let i = authored - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }

      permuteInstanceAttribute(mesh.instanceMatrix, order, 16);
      if (mesh.instanceColor) permuteInstanceAttribute(mesh.instanceColor, order, 3);
      // Recorded so a mesh that is rewritten per frame can be detected rather
      // than silently desynchronised; checked in `frame()`.
      this.scatterVersions.set(mesh, mesh.instanceMatrix.version);
      shuffled++;
    }
    console.log(
      `[quality] shuffled instance order in ${shuffled} scatter layer(s)` +
        (skipped ? `, skipped ${skipped}` : "") +
        ` so thinning samples rather than truncates`
    );
  }

  /**
   * Reports any scatter layer whose instance matrix was rewritten after the
   * shuffle.
   *
   * Every `setMatrixAt` call in this scene is in a build loop rather than an
   * `update()`, so nothing should trip this. That is exactly why it is worth
   * checking: the shuffle is only safe while that stays true, and a system that
   * starts animating instances by index would otherwise find its objects
   * silently swapped with no error anywhere. Runs once, so it costs nothing.
   */
  private checkScatterMutation(): void {
    for (const [mesh, version] of this.scatterVersions) {
      if (mesh.instanceMatrix.version !== version) {
        console.warn(
          `[quality] ${mesh.name || "instanced mesh"} rewrote its instance matrix after the tier ` +
            `shuffle. Instance indices no longer mean what the owning system thinks they mean — ` +
            `either exclude it from the scatter lever or have it re-read its own order.`
        );
      }
    }
    this.scatterVersions.clear();
  }

  /** Debug only: ?sample=1 mirrors the frame into a 2D canvas so tools can read pixels. */
  private sampler: CanvasRenderingContext2D | null = null;

  private frame = () => {
    if (!this.running) return;
    // Wall-clock frame duration, sampled before any work so it measures the
    // whole previous frame including the driver's own wait. `clock.getDelta()`
    // would do for the simulation but is reset below and consumed by systems.
    const frameStart = performance.now();
    if (this.lastFrameAt > 0) this.adaptive?.sample(frameStart - this.lastFrameAt, frameStart);
    this.lastFrameAt = frameStart;
    /*
     * THE CLAMP, AND WHY IT IS INSTRUMENTED RATHER THAN TUNED
     * ------------------------------------------------------
     * A long frame is not merely ugly here, it takes ground away from the
     * player. `dt` is clamped at 100 ms, so a 300 ms frame advances the
     * simulation 100 ms and the body covers 200 ms less ground than wall clock.
     * The loss is `v` times the excess, so **the same stall costs a sprinting
     * player 1.7x what it costs a walking one** — which is the whole of the
     * sprint shortfall measured elsewhere, from a single long frame.
     *
     * The clamp stays. Unclamped, that frame moves the body 0.71 m against a
     * 0.32 m collision radius, i.e. straight through a wall. So the fix is not
     * to raise the ceiling but to not produce frames that hit it, and that means
     * the count has to be visible. A mean frame time can be excellent while this
     * happens several times a minute.
     *
     * `lostSimMs` is therefore a gameplay metric wearing a performance metric's
     * clothing: it is simulation time the world was never advanced through.
     */
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    if (rawDt > 0.1) {
      /*
       * A raw delta above `STALL_S` is not a slow frame — it is the frame loop
       * not having been driven at all: init, a background tab, or a harness
       * blocking the main thread with a long `evaluate`. Counting those as lost
       * player motion is how the first version of this metric reported **278
       * metres** of ground lost from five frames, off a "worst frame" of 148
       * seconds. The absurd magnitude is the only reason it was caught, which is
       * an argument for reporting a derived physical quantity rather than a bare
       * millisecond count: nobody would have blinked at 198,992 ms.
       *
       * So stalls are counted separately and never priced as lost ground.
       */
      const STALL_S = 1.0;
      if (rawDt > STALL_S) {
        this.clampStats.stalls++;
        if (rawDt * 1000 > this.clampStats.worstStallMs) this.clampStats.worstStallMs = rawDt * 1000;
      } else {
        this.clampStats.frames++;
        this.clampStats.lostSimMs += (rawDt - 0.1) * 1000;
        if (rawDt * 1000 > this.clampStats.worstRawMs) this.clampStats.worstRawMs = rawDt * 1000;
        // Bounded: the distribution matters and an unbounded array in a metric
        // is its own leak.
        if (this.clampStats.magnitudesMs.length < 200) {
          this.clampStats.magnitudesMs.push(+(rawDt * 1000).toFixed(1));
        }
      }
    }
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
    if (this.framesRendered === 120) this.checkScatterMutation();

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
