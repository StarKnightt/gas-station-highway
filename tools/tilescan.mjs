#!/usr/bin/env node
/**
 * Measures the *period* of a repeat in the rendered ground, in metres.
 *
 * "The pebble bump repeats on a visible cell" is a claim about a length, and
 * the three candidate causes have different lengths, so the length is the
 * measurement that separates them:
 *
 *   - a detail map tiling at its own `tileMetres`      -> 17.0 m for the dirt
 *   - the anti-tile alternate sample at 0.63x          -> 27.0 m
 *   - the macro breakup texture at `macroMetres`       -> 78.0 m for the dirt
 *   - a noise *lattice* artefact inside one tile       -> a sub-tile length
 *     that is 17/f for some small integer f, and which does NOT move when the
 *     UV scale of the map is changed
 *
 * The last row is the reason this exists rather than a code reading. A lattice
 * artefact and a UV repeat look identical in a render and have opposite fixes:
 * one is fixed in `noise.ts`, the other in the material. The discriminator is
 * that a UV repeat scales exactly with `tileMetres` and a lattice artefact
 * scales with it too but sits at a fraction of it — so the tool reports the
 * measured period as a *ratio* to the tile, not just as a number.
 *
 * Method. A nadir camera at a known height over open ground makes world metres
 * and image pixels linearly related across the whole frame, which no oblique
 * pose does. The frame is high-passed to kill the lighting gradient, then a
 * normalised autocorrelation is taken along image X (world X) and image Y
 * (world Z), averaged over every row and every column respectively. Peaks in
 * that curve are periods.
 *
 * Two properties are load-bearing:
 *
 *   - It does not take a region. The correlation is over the whole frame; there
 *     is no coordinate for an author to choose (NOTES.md case 28).
 *   - It reports both axes separately and it reports the *whole* peak table,
 *     not the largest one. A repeat that is strong on one axis and absent on
 *     the other is a different defect from one that is square, and a tool that
 *     printed only the winner would hide that.
 *
 *   node tools/tilescan.mjs                       # full material
 *   node tools/tilescan.mjs --variants=base,bumponly,albedoonly,notile
 *   node tools/tilescan.mjs --selftest            # synthetic controls only
 *
 * Own port (5132) and own build directory. Teardown on every path.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "terrain");
const PORT = 5132;
const WIDTH = 1600;
const HEIGHT = 900;

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SELFTEST = argv.includes("--selftest");
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
const KEEP_PNG = argv.includes("--keep-png");

/**
 * Each variant is a `?tforce=` token plus what it leaves standing. `base` is
 * the shipping material; the rest exist so "which map carries the repeat" is a
 * measurement rather than an inference. Forcing one map at a time is the whole
 * point — NOTES.md case 23 is a forced-value test that moved two coupled
 * quantities together and reported a buried feature as healthy.
 */
const VARIANTS = {
  base: "",
  bumponly: "bumponly", // flat albedo + flat roughness: only the normal map draws
  albedoonly: "albedoonly", // normalScale 0: only albedo and roughness draw
  notile: "notile", // antiTile disabled everywhere: the control
  bumponly_notile: "bumponly,notile",
  albedoonly_notile: "albedoonly,notile",
};

const WANT = (arg("variants", "base,bumponly,albedoonly,notile") || "")
  .split(",")
  .filter(Boolean);
const unknown = WANT.filter((v) => !(v in VARIANTS));
if (unknown.length) {
  console.error(`[tilescan] unknown variant(s): ${unknown.join(", ")}. Known: ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(2);
}

/**
 * Nadir stations over open, unpaved, unbuilt ground.
 *
 * Two of them, well apart, because one station cannot distinguish "the texture
 * repeats" from "this particular patch happens to be periodic". `alt` is above
 * the local ground; the tile of interest is 17 m, and the frame has to hold
 * several periods on the long axis for an autocorrelation to mean anything.
 */
const STATIONS = [
  { name: "openA", x: -150, z: -150, alt: 62, fov: 40 },
  { name: "openB", x: 170, z: 120, alt: 62, fov: 40 },
];

/** Reference lengths, in metres, that a measured period is matched against. */
const KNOWN = [
  { m: 17.0, what: "dirt detail tile (makeDirt tileMetres)" },
  { m: 17.0 / 0.63, what: "antiTile alternate sample (tile / 0.63)" },
  { m: 78.0, what: "dirt macro breakup (macroMetres)" },
  { m: 78.0 / 1.7, what: "antiTile selection mask (macroMetres / 1.7)" },
];

/* ---------------------------- analysis ---------------------------- */

/** Luminance plane from a PNG, 0..255. */
function luma(png) {
  const out = new Float64Array(png.width * png.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * png.data[p] + 0.7152 * png.data[p + 1] + 0.0722 * png.data[p + 2];
  }
  return out;
}

/**
 * Separable box high-pass. Removes anything slower than `r` pixels, which is
 * the vignette, the aerial gradient and any large soft stain — none of which
 * are repeats and all of which would otherwise dominate the correlation at
 * long lags and manufacture a peak wherever the window happened to end.
 */
function highPass(src, w, h, r) {
  const tmp = new Float64Array(w * h);
  const blur = new Float64Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      const add = src[y * w + Math.min(w - 1, x + r + 1)];
      const sub = src[y * w + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      blur[y * w + x] = acc / n;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = src[i] - blur[i];
  return out;
}

/**
 * Normalised autocorrelation along one axis, averaged over the other.
 *
 * The normalisation is per lag against the overlapping window's own variance,
 * so the curve does not simply decay because fewer samples overlap — a decay
 * that a naive implementation reports as "no repeat" for exactly the periods
 * that matter most.
 */
function autocorr(field, w, h, axis, maxLag) {
  const out = new Float64Array(maxLag + 1);
  const len = axis === "x" ? w : h;
  const lines = axis === "x" ? h : w;
  const at = axis === "x" ? (line, i) => field[line * w + i] : (line, i) => field[i * w + line];
  for (let lag = 0; lag <= maxLag; lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let line = 0; line < lines; line++) {
      let sa = 0;
      let sb = 0;
      const n = len - lag;
      if (n <= 8) continue;
      for (let i = 0; i < n; i++) {
        sa += at(line, i);
        sb += at(line, i + lag);
      }
      const ma = sa / n;
      const mb = sb / n;
      for (let i = 0; i < n; i++) {
        const a = at(line, i) - ma;
        const b = at(line, i + lag) - mb;
        num += a * b;
        da += a * a;
        db += b * b;
      }
    }
    out[lag] = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }
  return out;
}

/**
 * Local maxima of the correlation curve, above a floor, ignoring the trivial
 * zero-lag peak and the shoulder that hangs off it.
 */
function peaks(curve, minLagPx, floor) {
  const found = [];
  for (let i = minLagPx + 1; i < curve.length - 1; i++) {
    if (curve[i] <= floor) continue;
    if (curve[i] < curve[i - 1] || curve[i] < curve[i + 1]) continue;
    // Parabolic refinement: the period is rarely an integer number of pixels
    // and rounding it costs more precision than the whole measurement has.
    const d = curve[i - 1] - 2 * curve[i] + curve[i + 1];
    const sub = d !== 0 ? (0.5 * (curve[i - 1] - curve[i + 1])) / d : 0;
    found.push({ lag: i + sub, r: curve[i] });
  }
  found.sort((a, b) => b.r - a.r);
  return found;
}

function describe(metres) {
  let best = null;
  for (const k of KNOWN) {
    const err = Math.abs(metres - k.m) / k.m;
    if (err < 0.08 && (!best || err < best.err)) best = { ...k, err };
  }
  if (best) return `${best.what} (${best.m.toFixed(1)} m, ${(best.err * 100).toFixed(1)}% off)`;
  const frac = 17.0 / metres;
  if (Math.abs(frac - Math.round(frac)) < 0.06 && Math.round(frac) >= 2 && Math.round(frac) <= 32)
    return `tile / ${Math.round(frac)} — a sub-tile length, i.e. a lattice or feature-size artefact, not a UV repeat`;
  return "no known length matches";
}

function analyse(png, metresPerPixel, label, lines) {
  const w = png.width;
  const h = png.height;
  const f = highPass(luma(png), w, h, 64);
  const maxLagX = Math.floor(w * 0.45);
  const maxLagY = Math.floor(h * 0.45);
  const results = {};
  for (const [axis, maxLag, world] of [
    ["x", maxLagX, "world X"],
    ["y", maxLagY, "world Z"],
  ]) {
    const curve = autocorr(f, w, h, axis, maxLag);
    // 1.2 m: below this we are inside the aggregate itself, which correlates
    // for reasons that have nothing to do with tiling.
    const minLag = Math.max(4, Math.round(1.2 / metresPerPixel));
    const top = peaks(curve, minLag, 0.02).slice(0, 4);
    results[axis] = top.map((p) => ({ metres: p.lag * metresPerPixel, r: p.r }));
    if (!top.length) {
      lines.push(`  ${label} ${world}: no periodic peak above r=0.02`);
      continue;
    }
    for (const p of top) {
      const m = p.lag * metresPerPixel;
      lines.push(`  ${label} ${world}: period ${m.toFixed(2)} m  r=${p.r.toFixed(3)}  -> ${describe(m)}`);
    }
  }
  return results;
}

/* ---------------------------- self test ---------------------------- */

function selftest() {
  const w = 1600;
  const h = 900;
  const mpp = 0.0485; // roughly the real capture scale
  const mk = (fn) => {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = Math.max(0, Math.min(255, fn(x, y)));
        const i = (y * w + x) << 2;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
        png.data[i + 3] = 255;
      }
    return png;
  };
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // Control that MUST report a 17 m period: a random field repeated on a
  // 17 m grid, which is exactly what a tiling detail map is.
  const period = Math.round(17 / mpp);
  const planted = mk((x, y) => 128 + 60 * (hash(Math.floor((x % period) / 3), Math.floor((y % period) / 3)) - 0.5));
  // Control that MUST NOT: the same statistics with no repeat.
  const clean = mk((x, y) => 128 + 60 * (hash(Math.floor(x / 3), Math.floor(y / 3)) - 0.5));

  const out = [];
  console.log("[tilescan] selftest: planted 17.0 m repeat");
  const a = analyse(planted, mpp, "planted", out);
  console.log("[tilescan] selftest: no repeat");
  const b = analyse(clean, mpp, "clean", out);
  console.log(out.join("\n"));

  const hit = (r) => (r.x[0] ? Math.abs(r.x[0].metres - 17) / 17 < 0.08 && r.x[0].r > 0.2 : false);
  const problems = [];
  if (!hit(a)) problems.push("the planted 17 m repeat was NOT reported — the tool cannot see the defect it exists for");
  if (b.x[0] && b.x[0].r > 0.2) problems.push(`a non-repeating field reported r=${b.x[0].r.toFixed(3)} — false positive`);
  if (problems.length) {
    console.error(`[tilescan] SELFTEST FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("[tilescan] selftest OK: sees the planted repeat, does not invent one");
  process.exit(0);
}

/* ---------------------------- capture ---------------------------- */

const resources = { server: null, browser: null };
let shuttingDown = false;
async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[tilescan] shutting down: ${reason}`);
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

async function bundleStamp() {
  const files = [];
  const walk = async (d) => {
    let e;
    try {
      e = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of e) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) await walk(p);
      else files.push(p);
    }
  };
  await walk(OUT_DIR);
  if (!files.length) return "missing";
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.relative(ROOT, f));
    h.update(await fs.readFile(f));
  }
  return h.digest("hex").slice(0, 12);
}

async function main() {
  if (SELFTEST) selftest();

  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[tilescan] building into .shot-build/terrain ...");
    try {
      if (os.platform() === "win32") process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
      else process.setpriority?.(0, 10);
    } catch {
      /* best effort */
    }
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }
  const hash = await bundleStamp();
  console.log(`[tilescan] bundle ${hash}`);

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
  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "tilescan", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const scratch = path.join(ROOT, ".shot-build", "tilescan");
  await fs.mkdir(scratch, { recursive: true });
  const lines = [];

  for (const variant of WANT) {
    const token = VARIANTS[variant];
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));

    // Only lighting and terrain: a pine crown in a nadir frame is a strong
    // aperiodic feature that dilutes the correlation, and the question here is
    // exclusively about the ground material.
    const q = ["shot=system1", "solo=lighting,terrain"];
    // `nofade` holds the normal map at full strength at this altitude. Without
    // it the distance fade has taken most of the bump out by 62 m and the scan
    // would measure the albedo while claiming to measure the bump.
    const t = [token, "nofade"].filter(Boolean).join(",");
    if (t) q.push(`tforce=${t}`);
    await page.goto(`${base}?${q.join("&")}`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });

    const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
    if (!Array.isArray(sysErrors) || sysErrors.length)
      throw new Error(`variant ${variant}: __SYSTEM_ERRORS = ${JSON.stringify(sysErrors)}`);

    for (const st of STATIONS) {
      const applied = await page.evaluate((s) => {
        const g = window.__GAME;
        const gh = g?.tryGet?.("groundHeight");
        if (typeof gh !== "function") return null;
        const y = gh(s.x, s.z) + s.alt;
        const cam = g.camera;
        // Straight down. `up` cannot be +Y for a nadir lookAt or the basis is
        // degenerate; -Z puts world +X along image +X and world +Z down the
        // image, which is what the analysis below assumes.
        cam.position.set(s.x, y, s.z);
        cam.up.set(0, 0, -1);
        cam.rotation.set(0, 0, 0);
        cam.lookAt(s.x, y - 10, s.z);
        cam.fov = s.fov;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        return { y, alt: s.alt };
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

      const file = path.join(scratch, `${variant}_${st.name}.png`);
      await page.screenshot({ path: file, type: "png" });
      const png = PNG.sync.read(await fs.readFile(file));
      // Nadir: the visible height is 2 * altitude * tan(fov/2), exactly, and
      // the same metres-per-pixel holds on both axes for a square pixel.
      const mpp = (2 * st.alt * Math.tan(((st.fov * Math.PI) / 180) / 2)) / png.height;
      lines.push(`[${variant} @ ${st.name}]  ${mpp.toFixed(4)} m/px  frame ${(mpp * png.width).toFixed(1)} x ${(mpp * png.height).toFixed(1)} m`);
      analyse(png, mpp, variant, lines);
      if (!KEEP_PNG) await fs.rm(file, { force: true });
    }
    if (problems.length) console.warn(`[tilescan] ${variant} page problems: ${problems.slice(0, 3).join(" | ")}`);
    await page.close();
  }

  await context.close();
  console.log(`\n${lines.join("\n")}\n`);
  await shutdown(0, null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
