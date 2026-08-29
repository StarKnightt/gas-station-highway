/**
 * shadow-type-ab.mjs — does the shadow preallocation survive a type change?
 *
 * `LightingSystem` selects `BasicShadowMap` for contact hardening under
 * `?pcss=1`, and that is gated shut with a comment pointing at
 * `core/shadowMemory.ts`: `preallocateShadowMaps` used to return early for any
 * type other than `PCFShadowMap`, so turning the filter on silently handed back
 * the 192 MB peak saving.
 *
 * Four configurations, one build, reporting live and peak GL texture bytes:
 *
 *   pcf-opt      default                    preallocation on,  PCFShadowMap
 *   pcf-base     ?noshadowopt=1             preallocation off, PCFShadowMap
 *   pcss-opt     ?pcss=1                    preallocation on,  BasicShadowMap
 *   pcss-base    ?pcss=1&noshadowopt=1      preallocation off, BasicShadowMap
 *
 * Peak is the number that matters. Steady state can be recovered after the fact
 * by `reclaimShadowColourAttachments`, so a fix that only moves the steady state
 * has not addressed the failure the user actually hit.
 *
 * No timing here: the host is saturated (PERF.md section 5) and bytes are the
 * contention-robust quantity.
 *
 *   node tools/shadow-type-ab.mjs
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
// tools/scratch.mjs for why this is not a top-level directory.
const BUILD_DIR = scratchDir(ROOT, "shadowab");
const DO_BUILD = !process.argv.includes("--no-build");
/* A fixed pose with the low sun's long shadows across the forecourt: the frame
 * most exposed to getting the depth comparison or the filter wrong. */
const SHOT = (process.argv.find((a) => a.startsWith("--shot=")) ?? "--shot=ground").slice(7);

const CASES = [
  ["pcf-opt", ""],
  ["pcf-base", "noshadowopt=1"],
  ["pcss-opt", "pcss=1"],
  ["pcss-base", "pcss=1&noshadowopt=1"],
];

const resources = { server: null, browser: null, startedServer: false };

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

async function shutdown(code, reason) {
  if (reason) console.error(`[shadowab] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[shadowab] browser close failed: ${e.message}`);
  }
  try {
    if (resources.server) await resources.server.close();
  } catch (e) {
    console.error(`[shadowab] server close failed: ${e.message}`);
  }
  if (resources.startedServer && (await portInUse(PORT))) {
    console.error(`[shadowab] !! port ${PORT} still listening after teardown; this harness started it`);
  } else {
    console.log(`[shadowab] port ${PORT} clear`);
  }
  process.exit(code);
}

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    console.log("[shadowab] building...");
    assertPrivateBuildDir(ROOT, BUILD_DIR, "shadowab");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }

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
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "shadowab" });
  if (isSoftwareRenderer(gpu.renderer)) throw new Error("software renderer");
  await gpuPage.close();

  const results = {};
  for (const [name, query] of CASES) {
    const page = await context.newPage();
    const logs = [];
    page.on("console", (m) => {
      const t = m.text();
      if (t.includes("[shadow-memory]") || t.includes("[game] pre-built") || t.includes("[game] reclaimed")) logs.push(t);
      if (m.type() === "error") logs.push(`ERROR ${t}`);
    });
    page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));
    await page.addInitScript({ content: instrument });

    const url = `${base}?shot=${SHOT}${query ? `&${query}` : ""}`;
    console.log(`[shadowab] ${name}: ${url}`);
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
    await assertSceneGpu(page, { tag: "shadowab", when: `after ready (${name})` });
    await page.evaluate(
      () => new Promise((r) => { let n = 0; const t = () => (++n < 90 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); })
    );

    results[name] = await page.evaluate(() => {
      const S = window.__GLSTAT;
      const g = window.__GAME;
      const maps = [];
      g.scene.traverse((o) => {
        if (o.isLight && o.castShadow && o.shadow && o.shadow.map) {
          const m = o.shadow.map;
          maps.push({
            light: o.name || "(unnamed)",
            size: `${m.width}x${m.height}`,
            colourFormat: m.texture ? m.texture.format : null,
            colourName: m.texture ? m.texture.name : null,
            depthCompare: m.depthTexture ? m.depthTexture.compareFunction : "no depthTexture",
            depthFilter: m.depthTexture ? m.depthTexture.minFilter : null,
          });
        }
      });
      return {
        shadowType: g.renderer.shadowMap.type,
        liveTexMB: +(S.live.texBytes / 1048576).toFixed(2),
        peakTexMB: +(S.peak.texBytes / 1048576).toFixed(2),
        rboMB: +(S.live.rboBytes / 1048576).toFixed(2),
        texCount: S.live.texCount,
        programs: S.programs.linked,
        maps,
      };
    });
    results[name].logs = logs;
    /* The configuration matching three's is strong evidence but not proof. The
     * failure this is most exposed to — a wrong comparison direction or filter
     * on the depth texture — renders a perfectly plausible frame with every
     * shadow wrong, so compare the pixels. */
    results[name].shot = path.join(OUT_DIR, `shadowab-${SHOT}-${name}.png`);
    await page.screenshot({ path: results[name].shot });
    await page.close();
  }

  const lines = [];
  const line = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  /* `format` 1023 is RGBAFormat, 1028 is RedFormat (three constants.js). The
   * whole saving is visible in this one field: RedFormat means the pre-built or
   * reclaimed R8 attachment is in place, RGBAFormat means three's default is. */
  const FORMAT = { 1023: "RGBA8", 1028: "R8" };
  const TYPE = { 0: "BasicShadowMap", 1: "PCFShadowMap", 2: "PCFSoftShadowMap", 3: "VSMShadowMap" };

  line();
  line("=========== SHADOW TYPE A/B ===========");
  line(`adapter ${gpu.renderer}`);
  line();
  line("case         shadowType        live tex    PEAK tex    colour   compare");
  for (const [name] of CASES) {
    const r = results[name];
    const m = r.maps[0];
    line(
      `${name.padEnd(12)} ${(TYPE[r.shadowType] ?? r.shadowType).padEnd(16)} ` +
        `${String(r.liveTexMB).padStart(9)} ${String(r.peakTexMB).padStart(11)}    ` +
        `${(FORMAT[m?.colourFormat] ?? String(m?.colourFormat)).padEnd(8)} ${String(m?.depthCompare)}`
    );
  }
  line();
  const d = (a, b, k) => +(results[a][k] - results[b][k]).toFixed(2);
  line(`PCF   preallocation saving:  live ${d("pcf-base", "pcf-opt", "liveTexMB")} MB   peak ${d("pcf-base", "pcf-opt", "peakTexMB")} MB`);
  line(`PCSS  preallocation saving:  live ${d("pcss-base", "pcss-opt", "liveTexMB")} MB   peak ${d("pcss-base", "pcss-opt", "peakTexMB")} MB`);
  line();
  for (const [name] of CASES) {
    const r = results[name];
    line(`${name}:`);
    for (const m of r.maps) line(`    ${m.light} ${m.size} colour=${FORMAT[m.colourFormat] ?? m.colourFormat} (${m.colourName}) compare=${m.depthCompare} filter=${m.depthFilter}`);
    for (const l of r.logs.slice(0, 8)) line(`    log: ${l}`);
  }
  line("=======================================");

  await fs.writeFile(path.join(OUT_DIR, "shadow-type-ab.json"), JSON.stringify({ gpu, results }, null, 2));
  await fs.writeFile(path.join(OUT_DIR, "shadow-type-ab.log"), lines.join("\n"));
}

process.on("SIGINT", () => shutdown(130, "SIGINT"));
run().then(
  () => shutdown(0, null),
  (e) => {
    console.error(e);
    shutdown(1, e.message);
  }
);
