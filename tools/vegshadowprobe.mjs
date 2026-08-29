#!/usr/bin/env node
/**
 * Isolated foliage-shadow probe.
 *
 *   node tools/vegshadowprobe.mjs
 *   node tools/vegshadowprobe.mjs --no-build --shots=pines
 *
 * WHY THIS EXISTS, AND WHY THE OLD PROBE WAS WORSE THAN USELESS
 *
 * Last round I "verified" foliage shadows by loading with `?vshadow=0`, which
 * turns off `castShadow` for every vegetation mesh at once, and diffing a
 * forecourt region. It reported 14.3% of that region changing and I called the
 * feature working. It was broken. The region contained pine *trunks* and scrub,
 * both opaque geometry with no alpha test, which cast correctly and always had.
 * The probe measured trunk shadows and credited them to the crowns.
 *
 * A whole-system toggle cannot attribute a change to a part of the system. So
 * this probe toggles exactly one thing:
 *
 *   A  baseline
 *   B  `castShadow = false` on the two foliage InstancedMeshes ONLY —
 *      `veg-pine-foliage` and `veg-pine-deadfoliage`. Trunks, scrub, fence,
 *      poles and everything else keep casting.
 *   C  baseline geometry, but `alphaToCoverage = true` on the foliage materials,
 *      which is the bug being tested: three.js then forces the depth material's
 *      alphaTest to 0.5 while the beauty pass still cuts at 0.3.
 *
 * `A xor B` is therefore, by construction, the foliage crowns' own shadow and
 * nothing else. Every number below is computed inside that mask.
 *
 * B and C are runtime material and flag mutations, so all three frames come from
 * one page at one camera pose with one shadow refit. No rebuild, no reload, and
 * no chance of the cascade fitting differently between variants.
 *
 * The interesting metric is not "is there a shadow" — the old probe answered
 * that and got it wrong. It is the mask's **perimeter-to-area ratio**. A crown
 * shadow is a spray of needle-scale holes and spikes and has a large perimeter
 * for its area; the shrunken hard core the bug produced is a blob, with a small
 * one. If the fix landed, A's mask is both larger and more convoluted than C's.
 *
 * Teardown: handlers installed before anything starts, everything closed on
 * every path, always ends in process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { PNG } from "pngjs";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "system6");
const PORT = 5119;
const WIDTH = 1600;
const HEIGHT = 900;

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DO_BUILD = !argv.includes("--no-build");
const KEEP = argv.includes("--keep-frames");
const ONLY = arg("shots", "").split(",").filter(Boolean);

/** The poses where the critic said the pines threw nothing, plus the one where it said they did. */
const POSES = {
  approach: { pos: [-30.0, 0, -7.6], eye: 1.65, look: [-1.0, 1.6, 20.0], fov: 46 },
  pines: { pos: [14.0, 0, 34.0], eye: 1.62, look: [-32.0, 6.0, 19.0], fov: 55 },
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },
};
const SHOTS = ONLY.length ? Object.keys(POSES).filter((s) => ONLY.includes(s)) : Object.keys(POSES);

const FOLIAGE = ["veg-pine-foliage", "veg-pine-deadfoliage"];

/* ---------------------------------------------------------------- */

const resources = { server: null, browser: null };
let shuttingDown = false;
const withTimeout = (p, ms) =>
  Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[vegshadow] shutting down: ${reason}`);
  for (const [label, fn] of [
    ["browser", async () => resources.browser && (await resources.browser.close())],
    [
      "preview server",
      async () => {
        const s = resources.server;
        if (!s) return;
        if (typeof s.close === "function") await s.close();
        else if (s.httpServer) await new Promise((r) => s.httpServer.close(r));
      },
    ],
  ]) {
    try {
      await withTimeout(fn(), 10_000);
    } catch (err) {
      console.error(`[vegshadow] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

/* ---------------------------------------------------------------- */

const luma = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

/** Per-pixel luma of a decoded PNG, as a Float32Array. */
function lumaField(png) {
  const out = new Float32Array(png.width * png.height);
  for (let p = 0; p < out.length; p++) out[p] = luma(png.data, p * 4);
  return out;
}

/**
 * Fraction of mask pixels that touch a non-mask pixel. A blob tends toward a
 * low value; a spray of needle-scale detail toward a high one. Scale-aware
 * enough for an A-vs-C comparison at one resolution, which is all it is for.
 */
function perimeterRatio(mask, w, h) {
  let area = 0;
  let edge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      area++;
      if (
        x === 0 ||
        x === w - 1 ||
        y === 0 ||
        y === h - 1 ||
        !mask[i - 1] ||
        !mask[i + 1] ||
        !mask[i - w] ||
        !mask[i + w]
      )
        edge++;
    }
  }
  return { area, edge, ratio: area ? edge / area : 0 };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[vegshadow] building into .shot-build/system6 ...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "vegshadow" });
  await gpuPage.close();

  const failures = [];
  const frameDir = path.join(ROOT, "shots", "system6", "probe");
  if (KEEP) await fs.mkdir(frameDir, { recursive: true });

  for (const shot of SHOTS) {
    const pose = POSES[shot];
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push(`${shot}: pageerror ${e.message}`));
    await page.goto(`${base}?shot=system6&gpu=1`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });

    const sysErr = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
    if (!Array.isArray(sysErr) || sysErr.length) failures.push(`${shot}: system errors ${JSON.stringify(sysErr)}`);

    const applied = await page.evaluate((p) => {
      const g = window.__GAME;
      const cam = g.camera;
      let y = p.pos[1];
      if (p.eye !== undefined) y = g.tryGet("groundHeight")(p.pos[0], p.pos[2]) + p.eye;
      cam.position.set(p.pos[0], y, p.pos[2]);
      cam.up.set(0, 1, 0);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(p.look[0], p.look[1], p.look[2]);
      cam.fov = p.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return { ok: true, y };
    }, pose);
    if (!applied.ok) {
      failures.push(`${shot}: pose failed`);
      await page.close();
      continue;
    }

    const settle = (n) =>
      page.evaluate(
        (k) =>
          new Promise((res) => {
            let i = 0;
            const tick = () => (++i < k ? requestAnimationFrame(tick) : res());
            requestAnimationFrame(tick);
          }),
        n
      );

    // Confirm the probe is actually holding the objects it thinks it is. A
    // silent no-op here is exactly how the previous probe passed on a broken
    // feature, so it is a hard failure rather than a warning.
    const found = await page.evaluate((names) => {
      const out = [];
      window.__GAME.scene.traverse((o) => {
        if (names.includes(o.name)) out.push({ name: o.name, count: o.count ?? null, cast: o.castShadow });
      });
      return out;
    }, FOLIAGE);
    if (!found.length) {
      failures.push(`${shot}: found none of ${FOLIAGE.join(", ")} in the scene — probe would be a no-op`);
      await page.close();
      continue;
    }

    await settle(20);
    const bufA = await page.screenshot({ type: "png" });

    const offB = await page.evaluate((names) => {
      let n = 0;
      window.__GAME.scene.traverse((o) => {
        if (names.includes(o.name)) {
          o.castShadow = false;
          n++;
        }
      });
      return n;
    }, FOLIAGE);
    await settle(8);
    const bufB = await page.screenshot({ type: "png" });

    const onC = await page.evaluate((names) => {
      let n = 0;
      window.__GAME.scene.traverse((o) => {
        if (names.includes(o.name)) {
          o.castShadow = true;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            m.alphaToCoverage = true;
            m.needsUpdate = true;
            n++;
          }
        }
      });
      return n;
    }, FOLIAGE);
    // Longer settle: the materials recompile, and a frame captured mid-compile
    // would be indistinguishable from a real result.
    await settle(20);
    const bufC = await page.screenshot({ type: "png" });

    await page.close();

    const A = PNG.sync.read(bufA);
    const B = PNG.sync.read(bufB);
    const C = PNG.sync.read(bufC);
    const w = A.width;
    const h = A.height;
    const la = lumaField(A);
    const lb = lumaField(B);
    const lc = lumaField(C);

    if (KEEP) {
      await fs.writeFile(path.join(frameDir, `${shot}_A_base.png`), bufA);
      await fs.writeFile(path.join(frameDir, `${shot}_B_nofoliagecast.png`), bufB);
      await fs.writeFile(path.join(frameDir, `${shot}_C_atc.png`), bufC);
    }

    // 3/255 is above the dither noise this renderer produces frame to frame and
    // well below any real shadow step at a 6 degree sun.
    const T = 3;
    const maskA = new Uint8Array(w * h); // foliage shadow, as fixed
    const maskC = new Uint8Array(w * h); // foliage shadow, with the bug restored
    let sumA = 0;
    let sumB = 0;
    let sumC = 0;
    for (let i = 0; i < maskA.length; i++) {
      if (lb[i] - la[i] > T) maskA[i] = 1;
      if (lb[i] - lc[i] > T) maskC[i] = 1;
    }
    const pa = perimeterRatio(maskA, w, h);
    const pc = perimeterRatio(maskC, w, h);

    // Luminance inside the fixed mask, for all three variants.
    let n = 0;
    for (let i = 0; i < maskA.length; i++) {
      if (!maskA[i]) continue;
      n++;
      sumA += la[i];
      sumB += lb[i];
      sumC += lc[i];
    }

    // How much of the crown's shadow the bug was throwing away.
    let lost = 0;
    for (let i = 0; i < maskA.length; i++) if (maskA[i] && !maskC[i]) lost++;

    // Control: the top 12% of the frame is sky in all three poses. Foliage
    // shadows cannot land there, so a non-zero count means the comparison is
    // picking up frame-to-frame noise and none of the above is trustworthy.
    let ctrl = 0;
    const ctrlRows = Math.floor(h * 0.12);
    for (let i = 0; i < ctrlRows * w; i++) if (Math.abs(lb[i] - la[i]) > T) ctrl++;

    const pct = (v) => ((v / (w * h)) * 100).toFixed(3);
    console.log(`\n#### ${shot}   eye y=${applied.y.toFixed(2)}`);
    console.log(`  toggled ${offB} foliage mesh(es), ${onC} material(s); instances: ` + found.map((f) => `${f.name}=${f.count}`).join(" "));
    console.log(`  isolated foliage shadow (A xor B): ${pa.area} px = ${pct(pa.area)}% of frame`);
    console.log(`    mean luma in mask: shadowed ${(sumA / Math.max(1, n)).toFixed(1)} -> unshadowed ${(sumB / Math.max(1, n)).toFixed(1)}  (delta ${((sumB - sumA) / Math.max(1, n)).toFixed(1)})`);
    console.log(`    perimeter/area ${pa.ratio.toFixed(3)}  (${pa.edge} edge px)`);
    console.log(`  same shadow with alphaToCoverage restored (the bug): ${pc.area} px = ${pct(pc.area)}%`);
    console.log(`    perimeter/area ${pc.ratio.toFixed(3)}`);
    console.log(`    mean luma in the fixed mask: ${(sumC / Math.max(1, n)).toFixed(1)}`);
    console.log(
      `  >> the fix recovers ${lost} px of crown shadow, ` +
        `${pa.area && pc.area ? (pa.area / pc.area).toFixed(2) : "n/a"}x the area and ` +
        `${pc.ratio ? (pa.ratio / pc.ratio).toFixed(2) : "n/a"}x the silhouette complexity`
    );
    console.log(`  control (sky, top ${ctrlRows} rows): ${ctrl} px changed  ${ctrl === 0 ? "OK" : "<-- NOISE, distrust the above"}`);

    if (pa.area === 0) failures.push(`${shot}: foliage casts NO isolated shadow at all`);
    if (ctrl > 0) failures.push(`${shot}: control region moved by ${ctrl} px`);
  }

  if (KEEP) console.log(`\n[vegshadow] frames kept in ${path.relative(ROOT, frameDir)}`);
  await shutdown(failures.length ? 1 : 0, failures.length ? failures.join("; ") : null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
