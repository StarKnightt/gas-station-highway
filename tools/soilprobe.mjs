#!/usr/bin/env node
/**
 * Does the `groundSoil` service describe the same ground the shader shades?
 *
 * The service hands other systems three scalars as CPU functions of world XZ.
 * Vegetation is going to scatter its inter-plant mat against them. If the
 * shader's lookup and the CPU accessor disagree about *where* a wet patch is —
 * a flipped V, an origin off by half the field, a size that is the half-extent
 * where the other expects the full span — then the mat is scattered onto dry
 * ground next to a wet patch, and nothing about that failure looks like a
 * coordinate bug. It looks like the mat is badly tuned. That class of failure
 * is exactly why `skyRadiance` had to prove agreement before it was consumed,
 * and this is the same gate.
 *
 * The measurement. A nadir camera at a known altitude makes image pixels and
 * world metres linearly related over the whole frame, so every pixel has an
 * exact world XZ. Render with `?tforce=soilviz`, which writes the field's own
 * channels to albedo, and ask the page for the CPU service's value at the same
 * XZ for the same pixels. Then correlate, over the whole frame.
 *
 * Two properties are load-bearing:
 *
 *   - It takes no region. The correlation is over every sampled pixel in the
 *     frame, so there is no coordinate for an author to place favourably
 *     (NOTES.md case 28).
 *   - It scores the flipped and transposed predictions too, and *requires the
 *     correct one to win*. A high correlation on its own is weak evidence:
 *     these fields are smooth, so a wrong mapping can still score well. The
 *     discriminator is the margin over the wrong mappings, which is what
 *     actually catches a V-flip.
 *
 * The rendered pixel is lit, tone-mapped and sRGB-encoded, so it is NOT the
 * field's value and this deliberately does not compare magnitudes. Every one
 * of those transforms is monotonic per channel and smooth in space, which
 * preserves rank correlation of a spatial pattern but cannot manufacture one.
 *
 *   node tools/soilprobe.mjs
 *   node tools/soilprobe.mjs --no-build
 *
 * Own port (5132, shared with tilescan — never run both) and own build dir.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "terrain");
const PORT = 5132;
const WIDTH = 1600;
const HEIGHT = 900;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
const KEEP_PNG = argv.includes("--keep-png");

/**
 * Stations over ground that actually has something to see. `lot` is over the
 * paved pad, where all four LOW_SPOTS are and therefore where the wetness
 * channel has any structure at all; a probe taken only over open soil would
 * score the wetness channel against a field that is nearly constant, and a
 * correlation against a constant is meaningless.
 */
const STATIONS = [
  { name: "lot", x: 4, z: 24, alt: 46, fov: 46 },
  { name: "verge", x: -60, z: 6, alt: 46, fov: 46 },
];

/**
 * Channels: rendered RGB carries (disturbance, wetness, material).
 *
 * `tol` is the r below which the channel is treated as a genuine disagreement.
 * It is not uniform across channels, and the reason is worth reading before
 * anyone quotes a number out of this tool.
 *
 * Standing water is no longer baked into the soil field. The shader clips it
 * per pixel against the fragment's own world Y (`wdPool`), and it jitters the
 * water level by up to +/-4 mm so the margin is ragged instead of a smooth
 * contour. On these slopes that is +/-0.26 m of shoreline. The CPU accessor
 * runs the identical analytic test against `groundHeight` but *without* the
 * jitter, because the jitter is a shading detail and scattering vegetation
 * against a wobbling waterline would be worse than scattering against the mean
 * one.
 *
 * So the two are exact in the interior of a pool and on dry ground, and
 * disagree in a band roughly half a metre wide around each waterline. That band
 * is a small fraction of the sampled pixels but it is a *total* disagreement
 * where it occurs — 0 against 1 — so it costs real correlation.
 *
 * This is a probe that is known to be wrong in a specific place, and it says so
 * rather than quietly failing or, worse, quietly passing with a degraded number
 * nobody notices. If wetness ever drops materially below this floor the cause is
 * a real divergence, not the fringe.
 */
const CHANNELS = [
  { name: "disturbance", rgb: 0, fn: "disturbance", tol: 0.55 },
  { name: "wetness", rgb: 1, fn: "wetness", tol: 0.42, fringe: true },
  { name: "material", rgb: 2, fn: "material", tol: 0.55 },
];

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const stdev = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
};

const resources = { server: null, browser: null };
let shuttingDown = false;
async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[soilprobe] shutting down: ${reason}`);
  try {
    await resources.browser?.close();
  } catch {
    /* already gone */
  }
  try {
    const s = resources.server;
    if (s?.close) await s.close();
    else if (s?.httpServer) await new Promise((r) => s.httpServer.close(r));
  } catch {
    /* already gone */
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[soilprobe] building into .shot-build/terrain ...");
    try {
      if (os.platform() === "win32") process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
      else process.setpriority?.(0, 10);
    } catch {
      /* best effort */
    }
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const page = await context.newPage();
  const problems = [];
  // Registered before the first navigation, not after: a listener attached
  // post-goto misses everything the page said while it was loading, which is
  // precisely the window in which a material fails to compile.
  const allConsole = [];
  page.on("console", (m) => {
    allConsole.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => {
    allConsole.push(`pageerror: ${e.message}`);
    problems.push(e.message);
  });

  await page.goto(`${base}?shot=system1&solo=lighting,terrain&tforce=soilviz,nofade`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await assertHardwareGpu(page, { tag: "soilprobe", allowSoftware: ALLOW_SOFTWARE });
  try {
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 120_000 });
  } catch (e) {
    // A ready timeout with no explanation costs a whole capture to diagnose.
    // The page almost always already said what went wrong.
    const errs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null).catch(() => null);
    console.error(`[soilprobe] never reached __SCENE_READY.`);
    console.error(`  __SYSTEM_ERRORS: ${JSON.stringify(errs)}`);
    console.error(`  page console (last 30):\n    ${allConsole.slice(-30).join("\n    ")}`);
    throw e;
  }

  const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
  if (!Array.isArray(sysErrors) || sysErrors.length)
    throw new Error(`__SYSTEM_ERRORS = ${JSON.stringify(sysErrors)}`);

  const hasService = await page.evaluate(() => {
    const s = window.__GAME?.tryGet?.("groundSoil");
    return s ? Object.keys(s) : null;
  });
  if (!hasService) throw new Error("no `groundSoil` service is published — nothing to verify");
  console.log(`[soilprobe] service published: ${hasService.join(", ")}`);

  const scratch = path.join(ROOT, ".shot-build", "soilprobe");
  await fs.mkdir(scratch, { recursive: true });

  // Sample every STRIDE-th pixel. Dense enough that a half-field origin error
  // cannot hide between samples, sparse enough to stay cheap.
  const STRIDE = 8;
  const results = [];
  let worst = null;

  for (const st of STATIONS) {
    const applied = await page.evaluate((s) => {
      const g = window.__GAME;
      const gh = g?.tryGet?.("groundHeight");
      if (typeof gh !== "function") return null;
      const y = gh(s.x, s.z) + s.alt;
      const cam = g.camera;
      cam.position.set(s.x, y, s.z);
      cam.up.set(0, 0, -1);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(s.x, y - 10, s.z);
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return { y };
    }, st);
    if (!applied) throw new Error("no groundHeight service");

    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 14 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    const file = path.join(scratch, `soilviz_${st.name}.png`);
    await page.screenshot({ path: file, type: "png" });
    const png = PNG.sync.read(await fs.readFile(file));
    const mpp = (2 * st.alt * Math.tan(((st.fov * Math.PI) / 180) / 2)) / png.height;

    // The CPU side, asked for exactly the pixels that were rendered. `up` is
    // -Z for the nadir pose, which puts world +X along image +X and world +Z
    // down the image.
    const cpu = await page.evaluate(
      ({ s, mpp, w, h, stride }) => {
        const soil = window.__GAME.tryGet("groundSoil");
        const out = { disturbance: [], wetness: [], material: [], drainage: [] };
        for (let py = 0; py < h; py += stride) {
          for (let px = 0; px < w; px += stride) {
            const x = s.x + (px - w / 2 + 0.5) * mpp;
            const z = s.z + (py - h / 2 + 0.5) * mpp;
            out.disturbance.push(soil.disturbance(x, z));
            out.wetness.push(soil.wetness(x, z));
            out.material.push(soil.material(x, z));
            out.drainage.push(soil.drainage(x, z));
          }
        }
        return out;
      },
      { s: st, mpp, w: png.width, h: png.height, stride: STRIDE }
    );

    const cols = Math.ceil(png.width / STRIDE);
    const rows = Math.ceil(png.height / STRIDE);
    const rendered = { 0: [], 1: [], 2: [] };
    for (let py = 0; py < png.height; py += STRIDE) {
      for (let px = 0; px < png.width; px += STRIDE) {
        const i = (png.width * py + px) << 2;
        rendered[0].push(png.data[i]);
        rendered[1].push(png.data[i + 1]);
        rendered[2].push(png.data[i + 2]);
      }
    }

    // Wrong mappings the correct one has to beat. Each is a real bug that has
    // bitten this kind of code: a flipped texture V, a flipped U, and the two
    // world axes swapped.
    const flipV = (a) => {
      const o = new Array(a.length);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o[r * cols + c] = a[(rows - 1 - r) * cols + c];
      return o;
    };
    const flipU = (a) => {
      const o = new Array(a.length);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o[r * cols + c] = a[r * cols + (cols - 1 - c)];
      return o;
    };
    const transpose = (a) => {
      const o = new Array(a.length);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const sr = Math.min(rows - 1, c);
          const sc = Math.min(cols - 1, r);
          o[r * cols + c] = a[sr * cols + sc];
        }
      return o;
    };

    for (const ch of CHANNELS) {
      const pred = cpu[ch.fn];
      const got = rendered[ch.rgb];
      const sd = stdev(pred);
      if (sd < 0.004) {
        console.log(`  ${st.name} ${ch.name.padEnd(11)}: CPU field is flat here (sd ${sd.toFixed(4)}) — not scored`);
        continue;
      }
      const r = pearson(pred, got);

      /**
       * A wrong mapping is only evidence if it actually looks different from
       * the right one. `disturbance` at the verge is a band running parallel
       * to the highway, i.e. very nearly invariant in world X, so mirroring in
       * U reproduces almost the same picture and scores almost the same
       * correlation. Counting that as a near-miss would be reporting a
       * property of the field's symmetry as a failure of the mapping.
       *
       * So each candidate is first checked against the truth itself. If it is
       * not separable here it is excluded and said so, rather than being
       * allowed to drag the margin down — and rather than the threshold being
       * quietly lowered until everything passes, which would make the test
       * agree with whatever it was pointed at.
       */
      const candidates = [
        ["flipV", flipV(pred)],
        ["flipU", flipU(pred)],
        ["transpose", transpose(pred)],
      ];
      const scored = [];
      const indistinct = [];
      for (const [name, alt] of candidates) {
        const selfR = pearson(pred, alt);
        if (selfR > 0.9) indistinct.push(`${name} (${selfR.toFixed(2)} like the truth here)`);
        else scored.push([name, pearson(alt, got)]);
      }
      const rv = pearson(flipV(pred), got);
      const ru = pearson(flipU(pred), got);
      const rt = pearson(transpose(pred), got);
      const best = scored.length ? Math.max(...scored.map(([, v]) => v)) : -1;
      const margin = r - best;
      const line = {
        station: st.name,
        channel: ch.name,
        r,
        flipV: rv,
        flipU: ru,
        transpose: rt,
        margin,
        scoredCount: scored.length,
        tol: ch.tol,
        fringe: !!ch.fringe,
      };
      results.push(line);
      if (!worst || margin < worst.margin) worst = line;
      console.log(
        `  ${st.name} ${ch.name.padEnd(11)}: r=${r.toFixed(3)}  (flipV ${rv.toFixed(3)}, flipU ${ru.toFixed(
          3
        )}, transpose ${rt.toFixed(3)})  margin ${margin >= 0 ? "+" : ""}${margin.toFixed(
          3
        )}  sd ${sd.toFixed(3)}  [floor ${ch.tol.toFixed(2)}${ch.fringe ? ", waterline excluded by design" : ""}]` +
          (indistinct.length ? `  [not separable here: ${indistinct.join(", ")}]` : "")
      );
    }
    if (!KEEP_PNG) await fs.rm(file, { force: true });
  }

  // GLSL has no static checking anywhere in this project, so the driver is the
  // only checker and a link error must be fatal rather than a warning: a failed
  // program renders the material without the injection, which looks like a
  // tuning mistake rather than a build one.
  const shaderFail = problems.filter((p) =>
    /program info log|shader error|getShaderInfoLog|undeclared identifier|VALIDATE_STATUS|THREE\.WebGLProgram/i.test(p)
  );
  if (shaderFail.length) throw new Error(`shader compile/link failure: ${shaderFail[0]}`);
  if (problems.length) console.warn(`[soilprobe] page problems: ${problems.slice(0, 3).join(" | ")}`);
  await page.close();
  await context.close();

  const failures = [];
  if (!results.length) failures.push("nothing was scored — every channel was flat, so this proves nothing");
  for (const r of results) {
    if (r.r < r.tol)
      failures.push(`${r.station}/${r.channel}: r=${r.r.toFixed(3)} < ${r.tol.toFixed(2)} — CPU and GPU do not describe the same ground`);
    if (r.scoredCount && r.margin < 0.15)
      failures.push(
        `${r.station}/${r.channel}: correct mapping beats the best wrong one by only ${r.margin.toFixed(3)} — ` +
          `the field is too smooth here for this to be evidence of anything`
      );
  }

  console.log("");
  if (failures.length) {
    console.error(`[soilprobe] FAILED:\n  ${failures.join("\n  ")}`);
    await shutdown(1, "agreement not established");
  }
  console.log(
    `[soilprobe] OK: ${results.length} channel/station pairs, worst r=${Math.min(
      ...results.map((r) => r.r)
    ).toFixed(3)}, smallest margin over a wrong mapping +${worst.margin.toFixed(3)}`
  );
  if (results.some((r) => r.fringe)) {
    console.log(
      "[soilprobe] NOTE: the wetness figure is not a shoreline accuracy figure. The shader jitters " +
        "the water level by +/-4 mm (about +/-0.26 m of margin on these slopes) and the CPU accessor " +
        "does not. CPU and GPU are exact inside a pool and on dry ground and disagree in a band " +
        "roughly 0.5 m wide at each waterline, which is why the wetness floor is lower than the " +
        "others. Do not quote this r as agreement at the margin; there is none, by design."
    );
  }
  await shutdown(0, null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
