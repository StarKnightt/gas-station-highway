/**
 * bloom-cost.mjs — what would adding bloom cost, in bytes?
 *
 * Lighting wants the render-pass cost of a bloom pass before it decides whether
 * to bloom the sun disc. There is no post-processing in this project at all
 * today, so this is a pricing exercise for something that does not exist yet.
 *
 * Two ways to answer it. Read `UnrealBloomPass.js` and add up what its
 * constructor allocates, or allocate the same thing against the live renderer at
 * the live drawing-buffer size and read the GL byte counters. The first is
 * arithmetic about a version of three I am remembering; the second is a
 * measurement. This does the second.
 *
 * It does NOT import the pass. Importing `three/addons` into an injected script
 * would either fail to resolve a bare specifier or bundle a second copy of
 * three, and a second three means render targets from a different module
 * instance than the renderer — which mostly works, and "mostly works" is not a
 * measurement. Instead it allocates the exact render-target set the pass would
 * create, taking the `WebGLRenderTarget` class off a live shadow map so the
 * class is the app's own, and forces real allocation by binding each target.
 * Sizes and formats are read off the installed source, quoted in ALLOC below.
 *
 * Deliberately prices bytes and counts only. The host is saturated by six
 * sibling agents tonight and every wall-clock number taken on it is untrustable
 * (see PERF.md section 5), so there is no ms figure here. Bytes, render-target
 * counts and program counts are robust to contention; frame time is not.
 *
 *   node tools/bloom-cost.mjs
 *   node tools/bloom-cost.mjs --no-build
 */

import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer, assertSceneGpu } from "./gpu.mjs";
import { assertPrivateBuildDir, scratchDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const OUT_DIR = path.join(ROOT, "tools/perf-out");
// `tmp/` is the agreed home for harness scratch. See tools/scratch.mjs: a build
// left at a shared outDir with `emptyOutDir` has already destroyed two agents'
// private bundles once.
const BUILD_DIR = scratchDir(ROOT, "bloomcost");
const WIDTH = 1920;
const HEIGHT = 1080;
const DO_BUILD = !process.argv.includes("--no-build");

/** HalfFloatType, from node_modules/three/src/constants.js:698 (r185.1). */
const HALF_FLOAT = 1016;

const resources = { server: null, browser: null, startedServer: false };

async function shutdown(code, reason) {
  if (reason) console.error(`[bloom] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[bloom] browser close failed: ${e.message}`);
  }
  try {
    if (resources.server) await resources.server.close();
  } catch (e) {
    console.error(`[bloom] server close failed: ${e.message}`);
  }
  if (resources.startedServer && (await portInUse(PORT))) {
    console.error(
      `[bloom] !! port ${PORT} still has a listener after teardown. This harness started it, ` +
        `so this is a leak in this harness and not another process.`
    );
  } else {
    console.log(`[bloom] port ${PORT} clear`);
  }
  process.exit(code);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    assertPrivateBuildDir(ROOT, BUILD_DIR, "bloom");
    console.log("[bloom] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }

  console.log(`[bloom] preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  resources.startedServer = true;
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions());
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "bloom" });
  if (isSoftwareRenderer(gpu.renderer)) throw new Error("software renderer");
  await gpuPage.close();
  console.log(`[bloom] adapter: ${gpu.renderer}`);

  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.addInitScript({ content: instrument });

  console.log(`[bloom] loading ${base}`);
  await page.goto(base, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await assertSceneGpu(page, { tag: "bloom", when: "after ready" });
  await page.evaluate(
    () => new Promise((r) => { let n = 0; const t = () => (++n < 90 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); })
  );
  console.log("[bloom] scene ready");

  const result = await page.evaluate((HALF) => {
    const g = window.__GAME;
    const renderer = g.renderer;
    const S = window.__GLSTAT;

    /* The drawing buffer, not the CSS viewport. DPR is capped at 2 in Game.ts,
     * and every render-target size below is derived from this, so a report that
     * quoted the viewport would be wrong by the square of the ratio. */
    const gl = renderer.getContext();
    const DW = gl.drawingBufferWidth;
    const DH = gl.drawingBufferHeight;

    /* WebGLRenderTarget, taken off a live shadow map so it is the same module
     * instance the renderer uses. */
    let RT = null;
    g.scene.traverse((o) => {
      if (!RT && o.isLight && o.shadow && o.shadow.map) RT = o.shadow.map.constructor;
    });
    if (!RT) return { error: "no shadow map found; cannot obtain WebGLRenderTarget class" };

    const live = () => ({
      texBytes: S.live.texBytes,
      rboBytes: S.live.rboBytes,
      texCount: S.live.texCount,
      framebuffers: S.framebuffers.created - S.framebuffers.deleted,
    });

    /* Force the allocation. Constructing a WebGLRenderTarget allocates nothing;
     * three defers to the first bind. Binding and clearing runs
     * setupRenderTarget, which is where texImage2D/texStorage2D and
     * renderbufferStorage actually happen and where the instrument sees it. */
    const realise = (targets) => {
      const prev = renderer.getRenderTarget();
      for (const t of targets) {
        renderer.setRenderTarget(t);
        renderer.clear();
      }
      renderer.setRenderTarget(prev);
    };

    /* What UnrealBloomPass's constructor builds, from
     * node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js:99-127:
     * nMips = 5; resx/resy start at resolution/2 and halve each mip;
     * renderTargetBright at the starting size, plus a horizontal and a vertical
     * target per mip. All HalfFloatType. depthBuffer is not passed, so it
     * defaults to true. */
    const bloomTargets = (resX, resY, opts) => {
      let rx = Math.round(resX / 2);
      let ry = Math.round(resY / 2);
      const out = [new RT(rx, ry, { type: HALF, ...opts })];
      for (let i = 0; i < 5; i++) {
        out.push(new RT(rx, ry, { type: HALF, ...opts }));
        out.push(new RT(rx, ry, { type: HALF, ...opts }));
        rx = Math.round(rx / 2);
        ry = Math.round(ry / 2);
      }
      return out;
    };

    /* EffectComposer.js:69,80 — one full-res HalfFloat target plus a clone.
     * The clone is a second allocation: RenderTarget.copy() assigns a fresh
     * Source (see RenderTarget.js:368-371, three #20328), so unlike
     * Texture.clone() this does not share an upload. */
    const composerTargets = (opts) => [
      new RT(DW, DH, { type: HALF, ...opts }),
      new RT(DW, DH, { type: HALF, ...opts }),
    ];

    const cases = {};
    const measure = (name, make) => {
      const before = live();
      const targets = make();
      realise(targets);
      const after = live();
      const sizes = targets.map((t) => [t.width, t.height]);
      for (const t of targets) t.dispose();
      // Dispose is lazy too: three frees on the next render.
      renderer.render(g.scene, g.camera);
      const freed = live();
      cases[name] = {
        targets: targets.length,
        sizes,
        texMB: +((after.texBytes - before.texBytes) / 1048576).toFixed(2),
        rboMB: +((after.rboBytes - before.rboBytes) / 1048576).toFixed(2),
        totalMB: +((after.texBytes + after.rboBytes - before.texBytes - before.rboBytes) / 1048576).toFixed(2),
        framebuffers: after.framebuffers - before.framebuffers,
        // If this is not ~0 the disposal path is leaking and every figure
        // above is a lower bound on the real cost.
        residualMB: +((freed.texBytes + freed.rboBytes - before.texBytes - before.rboBytes) / 1048576).toFixed(2),
      };
    };

    measure("composer only (2 full-res, depth on)", () => composerTargets({}));
    /* The architecture Lighting probably wants: the sun disc is a small bright
     * object, so glow it in an isolated chain and additively composite. The
     * main scene never leaves the default framebuffer, so its MSAA survives. */
    measure("selective sun-disc glow: 512 chain, depth off", () => bloomTargets(512, 512, { depthBuffer: false }));
    measure("bloom full-res (11 targets, depth on = default)", () => bloomTargets(DW, DH, {}));
    measure("bloom full-res, depthBuffer:false", () => bloomTargets(DW, DH, { depthBuffer: false }));
    measure("bloom half-res, depthBuffer:false", () => bloomTargets(DW / 2, DH / 2, { depthBuffer: false }));
    measure("composer with samples:4 (MSAA restored)", () => composerTargets({ samples: 4 }));

    return {
      drawingBuffer: [DW, DH],
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
      pixelRatio: renderer.getPixelRatio(),
      rendererAntialias: gl.getContextAttributes().antialias,
      samplesOnDefaultFramebuffer: gl.getParameter(gl.SAMPLES),
      toneMapping: renderer.toneMapping,
      liveAtStart: live(),
      cases,
    };
  }, HALF_FLOAT);

  if (result.error) throw new Error(result.error);

  const lines = [];
  const line = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  line();
  line("=========== BLOOM VRAM PRICING ===========");
  line(`adapter                 ${gpu.renderer}`);
  line(`CSS viewport            ${result.viewport[0]}x${result.viewport[1]}  (devicePixelRatio ${result.dpr})`);
  line(`drawing buffer          ${result.drawingBuffer[0]}x${result.drawingBuffer[1]}  (renderer pixelRatio ${result.pixelRatio})`);
  line(`default framebuffer     antialias=${result.rendererAntialias}, SAMPLES=${result.samplesOnDefaultFramebuffer}`);
  {
    /* Arithmetic, not measurement: the browser allocates the default
     * framebuffer outside WebGL, so no instrument hook can see it. RGBA8
     * colour + 24/32-bit depth, both multisampled at the SAMPLES above. */
    const [w, h] = result.drawingBuffer;
    const s = Math.max(1, result.samplesOnDefaultFramebuffer);
    const mb = ((w * h * (4 + 4) * s) / 1048576).toFixed(1);
    line(`  (its own MSAA store is ~${mb} MB by arithmetic — invisible to the GL counters, and`);
    line(`   it stays allocated whether or not a composer is added, because the canvas keeps it)`);
  }
  line();
  for (const [name, c] of Object.entries(result.cases)) {
    line(`${name}`);
    line(`    targets ${c.targets}   colour ${c.texMB} MB   depth/rbo ${c.rboMB} MB   TOTAL ${c.totalMB} MB   +${c.framebuffers} fbo`);
    line(`    sizes   ${c.sizes.map((s) => s.join("x")).join(", ")}`);
    if (Math.abs(c.residualMB) > 0.5) line(`    !! ${c.residualMB} MB NOT freed on dispose`);
    line();
  }
  if (problems.length) {
    line(`page problems (${problems.length}):`);
    for (const p of problems.slice(0, 10)) line(`    ${p}`);
  }
  line("==========================================");

  await fs.writeFile(path.join(OUT_DIR, "bloom-cost.json"), JSON.stringify({ gpu, ...result, problems }, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "bloom-cost.log"), lines.join("\n"));
  console.log(`[bloom] wrote ${path.join(OUT_DIR, "bloom-cost.json")}`);
}

process.on("SIGINT", () => shutdown(130, "SIGINT"));
run().then(
  () => shutdown(0, null),
  (e) => {
    console.error(e);
    shutdown(1, e.message);
  }
);
