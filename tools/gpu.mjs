/**
 * Shared GPU configuration and verification for the headless harnesses.
 *
 * Playwright's default `headless: true` launches `chrome-headless-shell`, the
 * old headless binary, which has no GPU stack at all and silently falls back to
 * SwiftShader. Requesting `channel: "chromium"` launches the full Chromium
 * build in new-headless mode, which does have one. Getting this wrong is
 * invisible - the render still succeeds, it is just rasterised on the CPU with
 * a much lower anisotropy cap and different derivative precision - so
 * `assertHardwareGpu` treats a software renderer as a hard failure.
 *
 * ## Use `assertSceneGpu`, not `assertHardwareGpu`, once the scene exists
 *
 * `assertHardwareGpu` answers "could this browser reach the GPU at launch?" on
 * a throwaway canvas. That is a weaker claim than every harness here assumes it
 * is, for two reasons:
 *
 * 1. **Playwright injects `--enable-unsafe-swiftshader` into every Chromium it
 *    launches, whether or not you pass it.** Verified by reading the command
 *    line of a running browser, not from documentation. It survives every flag
 *    in `launchOptions` below. So the guarantee that flag exists to remove is
 *    not available to any Playwright harness in this repo; the fallback path
 *    stays open no matter what we do here.
 * 2. A throwaway canvas is a *different context* from the one three renders
 *    into, checked at a *different time* - before the scene has allocated
 *    ~750 MB of GPU memory, and before whatever else is running on the card has
 *    had a chance to force a context loss and a fallback.
 *
 * `assertSceneGpu` reads the renderer string out of `renderer.getContext()` -
 * the live context the frame was actually drawn with - after the scene is
 * ready. That is the only check that says anything about the pixels you are
 * about to measure. Call it after `__SCENE_READY`, and ideally again after the
 * last frame of a long run.
 */

/** Anything here means we are on a CPU rasteriser, not the discrete GPU. */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software\s*rasteriz|microsoft basic render|basic render driver/i;

export function launchOptions({ allowSoftware = false } = {}) {
  const args = [
    // ANGLE over D3D11 is the path that actually reaches an NVIDIA adapter on
    // Windows; "default" can silently resolve to the software backend.
    "--use-angle=d3d11",
    "--use-gl=angle",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--enable-zero-copy",
    // Ask the platform for the discrete adapter rather than whatever is
    // attached to the (non-existent) headless display.
    "--force_high_performance_gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--hide-scrollbars",
    "--mute-audio",
  ];
  if (allowSoftware) args.push("--enable-unsafe-swiftshader");

  return {
    // Not the default `headless: true`: that picks chrome-headless-shell.
    channel: "chromium",
    headless: true,
    args,
  };
}

/**
 * Launches Chromium against a **persistent, reused** profile directory, so the
 * driver's on-disk shader cache survives between runs.
 *
 * WHY THIS IS NOT A MICRO-OPTIMISATION
 * ------------------------------------
 * A cold load of this scene is 192-349 s, of which ~92% is the driver compiling
 * and linking shaders. A warm one is ~21 s. **The warmth is a property of the
 * profile directory, not of the machine and not of the driver**: every fresh
 * `mkdtemp` profile measures cold even on a host that has compiled these exact
 * shaders many times over.
 *
 * `chromium.launch()` creates a throwaway profile and discards it, so **every
 * run pays the full cold cost regardless of what ran before it.** Within one
 * browser process, later contexts do inherit warmth from earlier ones, which is
 * why a pre-warm page works — but only within that process, and only if the
 * pre-warm actually waits for compilation rather than for `domcontentloaded`.
 *
 * WHEN NOT TO USE THIS
 * --------------------
 * **Never for anything measuring load time.** `firstload.mjs` and `coldload.mjs`
 * exist to measure the cold path, and a warm profile would silently delete the
 * phenomenon — the most expensive possible outcome, because the run would
 * succeed and report a healthy 21 s. Use this only where load time is setup cost
 * rather than the measurement: frametime runs, capture rounds, audits.
 *
 * Returns a `BrowserContext` (not a `Browser`), because that is what
 * `launchPersistentContext` gives. `context.browser()` provides the `Browser`
 * for a `disconnected` handler and for teardown.
 */
export async function launchWarmProfile({
  tag = "shared",
  viewport = { width: 1920, height: 1080 },
  deviceScaleFactor = 1,
  allowSoftware = false,
} = {}) {
  const { chromium } = await import("playwright");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Under tmp/, which is gitignored. Deliberately NOT cleaned up on exit: the
  // whole value is in it persisting to the next run.
  const dir = path.join(root, "tmp", "profiles", tag);
  fs.mkdirSync(dir, { recursive: true });
  const firstEver = !fs.existsSync(path.join(dir, "Default"));

  const opts = launchOptions({ allowSoftware });
  const context = await chromium.launchPersistentContext(dir, {
    ...opts,
    viewport,
    deviceScaleFactor,
  });

  console.log(
    `[gpu] persistent profile "${tag}" at ${path.relative(root, dir)}` +
      (firstEver
        ? ` — FIRST USE, so this run pays a cold shader compile (expect 3-6 min). Warm it\n` +
          `      outside any timed window if the timing of this run matters.`
        : ` — reused, so the shader cache should be warm`)
  );

  return context;
}

/**
 * Reads the real renderer string out of a live WebGL2 context, plus the
 * anisotropy cap and the WebGPU adapter description when one exists.
 */
export async function readGpuInfo(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2", { powerPreference: "high-performance" }) ??
      canvas.getContext("webgl", { powerPreference: "high-performance" });
    if (!gl) return { renderer: "no webgl context", vendor: "", maxAnisotropy: 0, adapter: null };

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const aniso =
      gl.getExtension("EXT_texture_filter_anisotropic") ??
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");

    let adapter = null;
    try {
      const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
      if (a) adapter = a.info?.description || a.info?.vendor || "webgpu adapter";
    } catch {
      /* WebGPU is a nice-to-have here, not a requirement */
    }

    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      maxAnisotropy: aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0,
      adapter,
    };
  });
}

export function isSoftwareRenderer(renderer) {
  return SOFTWARE_RENDERER.test(String(renderer ?? ""));
}

/**
 * Logs the adapter and throws if it is a software rasteriser. The caller is
 * responsible for running its teardown before exiting - see the `catch` in
 * each harness, which routes every failure through `shutdown()`.
 */
export async function assertHardwareGpu(page, { tag = "shoot", allowSoftware = false } = {}) {
  const info = await readGpuInfo(page);
  // Test hook: lets us exercise the hard-fail path (and its teardown) without
  // having to actually break the GPU.
  if (process.env.GPU_FAKE_SOFTWARE) info.renderer = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))";
  console.log(`[${tag}] GPU: ${info.renderer}`);
  console.log(`[${tag}] vendor: ${info.vendor}  maxAnisotropy: ${info.maxAnisotropy}${info.adapter ? `  webgpu: ${info.adapter}` : ""}`);

  if (isSoftwareRenderer(info.renderer)) {
    if (!allowSoftware) {
      throw new Error(
        `refusing to render on a software rasteriser (${info.renderer}). ` +
          `Pass --allow-software only if the GPU is genuinely unavailable.`
      );
    }
    console.warn(`[${tag}] WARNING: software rasteriser in use because --allow-software was passed`);
  }
  return info;
}

/**
 * The check that actually covers your measurement: reads the renderer string
 * from the live context three is drawing with, rather than from a throwaway
 * canvas created at launch. See the note at the top of this file for why the
 * difference matters. Call after `__SCENE_READY`, and again at the end of a
 * long run if the numbers matter.
 *
 * Returns the renderer string. Throws on a software rasteriser, and also when
 * the context has been lost, since a lost context renders nothing at all while
 * the animation loop keeps being called.
 */
export async function assertSceneGpu(page, { tag = "shoot", when = "after ready", allowSoftware = false } = {}) {
  const state = await page.evaluate(() => {
    const r = window.__GAME?.renderer;
    if (!r) return { error: "window.__GAME is not set — is this a page that boots Game?" };
    const gl = r.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      contextLost: gl.isContextLost(),
      lostAt: window.__CONTEXT_LOST ?? null,
    };
  });

  if (state.error) throw new Error(`[${tag}] cannot verify the rendering context ${when}: ${state.error}`);

  if (state.contextLost || state.lostAt) {
    throw new Error(
      `[${tag}] the WebGL context was lost ${when}` +
        `${state.lostAt ? ` (after ${state.lostAt.frames} frames: ${state.lostAt.statusMessage || "no status message"})` : ""}. ` +
        `Every frame captured since is stale. This is usually the GPU running out of memory — check what else is on the card.`
    );
  }

  if (isSoftwareRenderer(state.renderer) && !allowSoftware) {
    throw new Error(
      `[${tag}] the scene is being rendered by a software rasteriser ${when}: ${state.renderer}. ` +
        `Note this can differ from the launch-time check: Playwright injects --enable-unsafe-swiftshader ` +
        `into every Chromium, so a fallback mid-run is possible and is invisible apart from this check.`
    );
  }

  return state.renderer;
}
