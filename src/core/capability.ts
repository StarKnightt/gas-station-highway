/**
 * Host capability detection and quality tiers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every number this project has ever measured was measured on one card, an RTX
 * 4060. The user's requirement is that the build "auto detect specifications and
 * work accordingly" so it runs on weak hardware. A build that crashes on the
 * machine someone tries it on is worse than a plainer one that runs.
 *
 * TWO COST FAMILIES, AND THEY ARE NOT THE SAME AXIS
 * -------------------------------------------------
 * This is the single most important thing to understand before editing a tier.
 * Measured on this project:
 *
 *   COMPILE-TIME  A cold load is ~284 s, of which init is ~22 s. The other
 *                 ~262 s sits between the last `init()` and frame 6, and is the
 *                 driver compiling shaders. Two independent measurements agree:
 *                 8.3% shader share when *warm* (populated program cache) and
 *                 ~92% when *cold*. Same pipeline, either side of a cache.
 *                 Governed by: program count, `onBeforeCompile` permutations,
 *                 material variants, transmission, whether PCSS is patched in.
 *                 This is the number the user feels most — a four-minute wait
 *                 before anything appears — and on weak hardware the compiler
 *                 is slower still.
 *
 *   RUN-TIME      Whether it holds 60 once running. Governed by draw calls,
 *                 triangles, shadow resolution, instance counts, fill rate.
 *
 * **A tier that cuts triangles while leaving the program count intact misses
 * the thing that hurts most.** Both families must be pulled. Program count is
 * also the better pass criterion: cheap to count, hard to fake, and it directly
 * predicts the worst part of the experience.
 *
 * ON CLASSIFYING FROM A RENDERER STRING
 * -------------------------------------
 * A renderer string is a weak classifier and there is no device database here
 * on purpose. Names are unstable across drivers, ANGLE rewrites them, and the
 * same name spans a 10x power range. So detection is capability-led — limits and
 * extensions, which are what the driver will actually honour — and the string is
 * used only for the one thing it is reliable for: recognising a *software*
 * rasteriser, which is a categorical fact rather than a magnitude.
 *
 * And because any boot-time guess is still a guess, the tier is a starting
 * point, not a verdict: `AdaptiveQuality` watches real frametime and steps down.
 * Detection chooses where to start so the first seconds are not a disaster;
 * measurement decides where to stay.
 */

/** Coarse tier. Three is enough; a fourth would need evidence to justify it. */
export type Tier = "low" | "medium" | "high";

/**
 * Raw facts about the host, all cheap to obtain. Recorded verbatim in
 * `window.__CAPABILITY` so a bug report carries them, because the alternative
 * is asking a user to describe their GPU.
 */
export interface HostCapability {
  /** Unmasked renderer string, or the masked one if the extension is absent. */
  renderer: string;
  vendor: string;
  /** True when the string names a known software rasteriser. Categorical. */
  software: boolean;
  /** WebGL2 or bust — this scene assumes it. */
  webgl2: boolean;
  maxTextureSize: number;
  maxRenderBufferSize: number;
  maxTextureUnits: number;
  /** Driver's MSAA ceiling. 0 when unavailable. */
  maxSamples: number;
  maxAnisotropy: number;
  /**
   * `KHR_parallel_shader_compile`. Load-bearing for the compile-time family:
   * without it three links programs serially on the main thread, which is
   * exactly the ~262 s stall. Its absence is a strong argument for a lower tier
   * regardless of how fast the card is at drawing.
   */
  parallelShaderCompile: boolean;
  /** `navigator.deviceMemory` in GB, coarsened by the browser. 0 if absent. */
  deviceMemoryGb: number;
  cpuThreads: number;
  devicePixelRatio: number;
  /** Backbuffer cost scales with this, and it is free to make it worse. */
  screenPx: number;
}

/** The resolved knobs. Every field is read by somebody; nothing here is decorative. */
export interface QualitySettings {
  tier: Tier;

  // ---- compile-time family: buys first-load seconds, costs subtlety --------
  /**
   * Shadow filter. `pcss` is patched in via `onBeforeCompile` and multiplies
   * permutations across every shadow-receiving material; `pcf` is three's stock
   * hardware path with no patch; `basic` is a single tap.
   *
   * Never `none`. Losing a soft shadow edge is acceptable; losing all shadows
   * is not — a low tier should look deliberately plainer, not broken.
   */
  shadowFilter: "pcss" | "pcf" | "basic";
  /** Transmission is a large shader and an extra pass. */
  transmission: boolean;
  /** Whether the world is captured into the environment map, or a cheap sky is. */
  worldCapture: boolean;
  /**
   * Per-material detail patches (`applyWorldDetail` and friends). These are the
   * `onBeforeCompile` sites that multiply variants across materials.
   */
  detailPatches: boolean;
  /** Screen-space post chain. */
  post: boolean;

  // ---- run-time family: buys frametime -------------------------------------
  /** Square shadow map edge. 8192 is 320 MB of the VRAM budget on its own. */
  shadowMapSize: number;
  /** Multiplier on scatter-layer instance counts. 1 = ship everything. */
  scatterDensity: number;
  /** Hard cap on device pixel ratio. Backbuffer cost is quadratic in this. */
  dprCap: number;
  /** MSAA on the default framebuffer. Context attribute — fixed at creation. */
  antialias: boolean;
  /** Anisotropic filtering cap. Cheap to lower, and barely visible. */
  anisotropy: number;
}

/** Software rasterisers, by the substrings their renderer strings actually contain. */
const SOFTWARE_MARKERS = [
  "swiftshader",
  "llvmpipe",
  "softpipe",
  "basic render",
  "microsoft basic",
  "software rasterizer",
  "google, vulkan 1.3.0 (swiftshader",
];

/**
 * Reads host capability from a *throwaway* 1x1 context.
 *
 * Deliberately not the scene's context. `antialias` is a context creation
 * attribute and cannot be changed afterwards, so the tier has to be known
 * before the real renderer is constructed. A 1x1 probe costs a millisecond and
 * is discarded immediately — see the `loseContext` call, which matters because
 * browsers cap live WebGL contexts per page and a leaked probe would eventually
 * cost the scene its own.
 */
export function detectCapability(): HostCapability {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const gl =
    (canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null) ?? null;

  if (!gl) {
    // No WebGL2 at all. Report it honestly rather than inventing numbers; the
    // caller will pick `low`, and the scene will very likely fail regardless.
    return {
      renderer: "unavailable",
      vendor: "unavailable",
      software: true,
      webgl2: false,
      maxTextureSize: 0,
      maxRenderBufferSize: 0,
      maxTextureUnits: 0,
      maxSamples: 0,
      maxAnisotropy: 1,
      parallelShaderCompile: false,
      deviceMemoryGb: 0,
      cpuThreads: navigator.hardwareConcurrency || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      screenPx: window.screen.width * window.screen.height,
    };
  }

  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || "");
  const vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) || "");
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");

  const cap: HostCapability = {
    renderer,
    vendor,
    software: SOFTWARE_MARKERS.some((m) => renderer.toLowerCase().includes(m)),
    webgl2: true,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderBufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
    maxSamples: (gl.getParameter(gl.MAX_SAMPLES) as number) || 0,
    maxAnisotropy: aniso ? (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1,
    parallelShaderCompile: !!gl.getExtension("KHR_parallel_shader_compile"),
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0,
    cpuThreads: navigator.hardwareConcurrency || 0,
    devicePixelRatio: window.devicePixelRatio || 1,
    screenPx: window.screen.width * window.screen.height,
  };

  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return cap;
}

/**
 * Picks a starting tier, and returns the reasons alongside it.
 *
 * The reasons are not decoration. A tier chosen silently is indistinguishable
 * from a tier chosen wrongly, and this project has lost hours to exactly that
 * shape of thing. Anything that demotes must say why, in a string a user can
 * paste into a bug report.
 *
 * Bias: **demote on any single strong signal.** A false `low` costs some visual
 * subtlety; a false `high` costs a crash or a four-minute load on a machine
 * that was never going to manage it. Those are not symmetric, so this does not
 * try to be balanced.
 */
export function classify(cap: HostCapability): { tier: Tier; reasons: string[] } {
  const reasons: string[] = [];
  let tier: Tier = "high";

  const demote = (to: Tier, why: string) => {
    reasons.push(why);
    // Only ever move downward, so the order of checks cannot accidentally
    // promote past an earlier veto.
    if (to === "low" || tier === "low") tier = "low";
    else tier = to;
  };

  if (!cap.webgl2) demote("low", "no WebGL2 context available");
  if (cap.software) demote("low", `software rasteriser: ${cap.renderer}`);

  // A driver that links serially is the ~262 s cold-load stall. This is a
  // compile-time signal, and it is the one most likely to decide whether a weak
  // machine ever reaches frame 1.
  if (!cap.parallelShaderCompile) {
    demote("medium", "no KHR_parallel_shader_compile: programs link serially on the main thread");
  }

  // 8192 shadow maps and 2048 source textures need real headroom. A 4096 cap is
  // the signature of an older integrated part.
  if (cap.maxTextureSize > 0 && cap.maxTextureSize < 8192) {
    demote("low", `MAX_TEXTURE_SIZE ${cap.maxTextureSize} cannot hold an 8192 shadow map`);
  } else if (cap.maxTextureSize === 8192) {
    demote("medium", "MAX_TEXTURE_SIZE is exactly 8192, leaving no headroom above the shadow map");
  }

  if (cap.maxSamples > 0 && cap.maxSamples < 4) {
    demote("medium", `MAX_SAMPLES ${cap.maxSamples}: driver cannot give the 4x MSAA this was tuned with`);
  }

  // deviceMemory is coarse (browsers round it, and cap it at 8) and absent in
  // several browsers, so it only ever demotes on a clearly low value and is
  // never read as a positive signal.
  if (cap.deviceMemoryGb > 0 && cap.deviceMemoryGb <= 4) {
    demote("low", `navigator.deviceMemory ${cap.deviceMemoryGb} GB`);
  }

  if (cap.cpuThreads > 0 && cap.cpuThreads <= 4) {
    demote("medium", `${cap.cpuThreads} CPU threads: procedural generation is single-threaded here`);
  }

  // A high-DPI panel in front of a weak GPU is the worst combination there is,
  // and it is the one case where a *display* property predicts GPU cost: the
  // backbuffer is quadratic in pixel ratio and nothing in-page can measure it.
  if (cap.screenPx >= 3840 * 2160 && cap.devicePixelRatio > 1) {
    demote("medium", `4K-class panel at DPR ${cap.devicePixelRatio}: backbuffer cost is quadratic here`);
  }

  if (reasons.length === 0) reasons.push("all capability signals clear");
  return { tier, reasons };
}

/**
 * Tier definitions.
 *
 * Ordered by cost-per-unit-of-visible-quality rather than by ease of
 * implementation, which is why `anisotropy` and `dprCap` move early (nearly
 * invisible, immediately effective) and `shadowFilter` degrades in two steps
 * rather than switching off (a soft edge is a luxury, a shadow is not).
 *
 * Figures in the comments are this project's own measurements on a 4060. They
 * are what makes the ordering defensible; without them this would be taste.
 */
const TIERS: Record<Tier, Omit<QualitySettings, "tier">> = {
  // Ships what six agents built, on hardware that can hold it.
  high: {
    shadowFilter: "pcss",
    transmission: true,
    worldCapture: true,
    detailPatches: true,
    post: false, // never enabled at any tier; see PERF.md §on bloom (237 MB of MSAA)
    shadowMapSize: 8192, // 320 MB preallocated
    scatterDensity: 1,
    dprCap: 2,
    antialias: true, // ~71 MB at 1080p DPR1, ~284 MB at DPR2
    anisotropy: 16,
  },

  // The target for a mid or older discrete card, and for anything whose driver
  // links shaders serially. Halves the shadow map (240 MB back), drops the PCSS
  // patch family (compile-time), keeps world capture because ambient light is
  // the difference between "plainer" and "wrong".
  medium: {
    shadowFilter: "pcf",
    transmission: true,
    worldCapture: true,
    detailPatches: true,
    post: false,
    shadowMapSize: 4096, // 80 MB: -240 MB against high
    scatterDensity: 0.6,
    dprCap: 1.25,
    antialias: true,
    anisotropy: 8,
  },

  // Integrated graphics and software rasterisers. Every compile-time lever is
  // pulled, because on these machines the four-minute load is the failure — not
  // the framerate. Still has directional shadows, a captured horizon and full
  // material detail on the near surfaces; it should read as plainer, not broken.
  low: {
    shadowFilter: "basic",
    transmission: false,
    worldCapture: false,
    detailPatches: false,
    post: false,
    shadowMapSize: 2048, // 16 MB: -304 MB against high
    scatterDensity: 0.25,
    dprCap: 1,
    antialias: false, // the whole 71-284 MB backbuffer premium, and fill rate with it
    anisotropy: 2,
  },
};

/**
 * Resolves the tier for this run.
 *
 * `?tier=low|medium|high` forces one, which is how every tier gets tested on a
 * machine that would never select it — and testing them is the only way to know
 * they apply at all. `?tier=auto` or absence means classify.
 */
export function resolveQuality(search: string = location.search): {
  settings: QualitySettings;
  capability: HostCapability;
  reasons: string[];
  forced: boolean;
} {
  const capability = detectCapability();
  const requested = new URLSearchParams(search).get("tier");

  let tier: Tier;
  let reasons: string[];
  let forced = false;

  if (requested === "low" || requested === "medium" || requested === "high") {
    tier = requested;
    reasons = [`forced by ?tier=${requested}`];
    forced = true;
  } else {
    const c = classify(capability);
    tier = c.tier;
    reasons = c.reasons;
  }

  const settings: QualitySettings = { tier, ...TIERS[tier] };

  // Clamp against what the driver will actually honour, so a forced tier cannot
  // ask for something impossible and fail opaquely deep inside three.
  if (capability.maxTextureSize > 0) {
    settings.shadowMapSize = Math.min(settings.shadowMapSize, capability.maxTextureSize);
  }
  if (capability.maxAnisotropy > 0) {
    settings.anisotropy = Math.min(settings.anisotropy, capability.maxAnisotropy);
  }

  return { settings, capability, reasons, forced };
}

/** Named export for the harness, so tier definitions are testable without a GPU. */
export function tierSettings(tier: Tier): QualitySettings {
  return { tier, ...TIERS[tier] };
}

/**
 * Runtime adaptation.
 *
 * A tier chosen from capability signals is a guess; a build that watches its own
 * frametime and steps down when it cannot hold target is a measurement. This is
 * the same frametime machinery the perf harness uses, pointed at the running
 * build.
 *
 * ONE HONEST LIMIT, AND IT SHAPES THE WHOLE DESIGN
 * ------------------------------------------------
 * **Only the run-time family can be adapted at runtime.** The compile-time
 * family — shadow filter, transmission, detail patches — is baked into compiled
 * programs by the time frame 1 exists. Pulling those later would recompile every
 * affected material, which is a multi-second stall on the machine least able to
 * afford one: it would cause exactly the freeze it was trying to prevent.
 *
 * So this steps `dprCap` and `scatterDensity` only, and that is *why* boot
 * classification still matters. Detection is not a fallback for adaptation; each
 * covers what the other cannot.
 *
 * OSCILLATION
 * -----------
 * Stepping down is cheap and stepping up is not, so the two are deliberately
 * asymmetric: down after 2 s over budget, up only after 20 s clean, and at most
 * one promotion per session. An oscillating quality level is more objectionable
 * than a low one held steadily — the user sees the resolution pulse.
 */
export class AdaptiveQuality {
  private readonly budgetMs: number;
  /** Rolling frame durations, capped; a fixed window, not an all-time mean. */
  private readonly window: number[] = [];
  private overSinceMs = 0;
  private cleanSinceMs = 0;
  private promotionsLeft = 1;
  private level = 0;
  readonly log: string[] = [];

  /**
   * Reversible steps, worst-first. Index 0 is "as the tier asked for it"; each
   * subsequent step multiplies down. Values rather than ratios so the sequence
   * is auditable at a glance.
   */
  private static readonly STEPS = [
    { dpr: 1.0, scatter: 1.0 },
    { dpr: 0.85, scatter: 0.7 },
    { dpr: 0.7, scatter: 0.45 },
    { dpr: 0.6, scatter: 0.25 },
  ];

  constructor(
    private readonly apply: (dprScale: number, scatterScale: number, why: string) => void,
    targetFps = 60
  ) {
    // 1.35x the frame period: a frame that misses by a third is a stutter, but
    // holding a hard 16.7 ms would demote on ordinary jitter.
    this.budgetMs = (1000 / targetFps) * 1.35;
  }

  /** Call once per frame with the frame's duration. */
  sample(frameMs: number, nowMs: number): void {
    const w = this.window;
    w.push(frameMs);
    if (w.length > 120) w.shift();
    if (w.length < 60) return;

    // Median, not mean: one 400 ms hitch from a garbage collection or another
    // process should not demote a scene that is otherwise holding target. The
    // whole point of this project's tail analysis is that means and tails answer
    // different questions, and this one is about the sustained case.
    const sorted = [...w].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    if (median > this.budgetMs) {
      this.cleanSinceMs = 0;
      if (this.overSinceMs === 0) this.overSinceMs = nowMs;
      else if (nowMs - this.overSinceMs > 2000) this.step(1, median, nowMs);
    } else if (median < this.budgetMs * 0.6) {
      this.overSinceMs = 0;
      if (this.cleanSinceMs === 0) this.cleanSinceMs = nowMs;
      else if (nowMs - this.cleanSinceMs > 20000 && this.promotionsLeft > 0) {
        this.promotionsLeft--;
        this.step(-1, median, nowMs);
      }
    } else {
      this.overSinceMs = 0;
      this.cleanSinceMs = 0;
    }
  }

  private step(delta: number, median: number, nowMs: number): void {
    const next = Math.max(0, Math.min(AdaptiveQuality.STEPS.length - 1, this.level + delta));
    if (next === this.level) return;
    this.level = next;
    this.overSinceMs = 0;
    this.cleanSinceMs = 0;
    this.window.length = 0;

    const s = AdaptiveQuality.STEPS[next];
    const why =
      `${delta > 0 ? "down" : "up"} to step ${next} at ${(nowMs / 1000).toFixed(1)}s ` +
      `(median ${median.toFixed(1)} ms vs ${this.budgetMs.toFixed(1)} ms budget)`;
    this.log.push(why);
    console.log(`[quality] ${why}`);
    // Its own factor only. `Game` composes it with the tier's density, and with
    // whether a system already honoured the tier at generation time.
    this.apply(s.dpr, s.scatter, why);
  }

  get currentStep(): number {
    return this.level;
  }
}

/** Deterministic PRNG. Fixed seeds keep a tier's frame reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reorders an instanced attribute in place to `order`, `stride` components each.
 *
 * Copies to a scratch array first: permuting in place with swaps would need the
 * cycle decomposition and gets the multi-component case wrong in a way that
 * still renders — which is the failure mode this codebase keeps paying for.
 */
export function permuteInstanceAttribute(
  attr: { array: ArrayLike<number> & { set(a: ArrayLike<number>, o?: number): void }; needsUpdate: boolean },
  order: Uint32Array,
  stride: number
): void {
  const src = attr.array as unknown as Float32Array;
  const out = new Float32Array(src.length);
  for (let i = 0; i < order.length; i++) {
    const from = order[i] * stride;
    const to = i * stride;
    for (let c = 0; c < stride; c++) out[to + c] = src[from + c];
  }
  src.set(out);
  attr.needsUpdate = true;
}
