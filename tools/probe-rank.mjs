#!/usr/bin/env node
/**
 * Ranks named surfaces by their brightness in the rendered frame, choosing the
 * measurement region for each one automatically.
 *
 *   node tools/probe-rank.mjs --port=5153 --pose=column_full
 *   node tools/probe-rank.mjs --port=5153 --pose=soffit --names=canopy-soffit,canopy-fascia
 *
 * SHARED TOOLING. Nothing here is canopy-specific; pass your own --port,
 * --build-dir and --names.
 *
 * Why not just measure a rectangle
 * --------------------------------
 * Because the agent picks the rectangle, and it picks it where it believes the
 * surface is. This finds each surface's pixels by the only definition that
 * cannot be argued with: render twice with nothing changed but that one
 * object's `visible` flag, and take the set of pixels that differ. Those are
 * its pixels, wherever they turned out to be, including the ones the agent
 * would not have thought to look at.
 *
 * It reports, per object:
 *   px      how many pixels it actually paints. Zero means it draws nothing
 *           anywhere in this frame, which is `probe-unseen`'s question answered
 *           for free.
 *   luma    mean of those pixels, 0..255, sRGB as displayed.
 *   p10/p90 so a surface with a bright specular streak is not confused with a
 *           uniformly bright one.
 *
 * Then it ranks them. Ranking is the point: it needs no exposure reference and
 * no agreed target, and "the soffit is darker than the asphalt it is standing
 * over" is a defect statement that survives any later change to the tone
 * mapping, which an absolute luma threshold does not.
 *
 * The determinism control runs first: two renders with nothing changed must be
 * bit-identical, or every "changed pixel" set below is noise and the tool
 * refuses to report.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const PORT = Number(arg("port", "5153"));
const BUILD_DIR = arg("build-dir", ".shot-build/canopy");
const WIDTH = Number(arg("width", "1600"));
const HEIGHT = Number(arg("height", "900"));
const QUERY = arg("query", "");
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/** Poses, duplicated from shoot5 so this tool stands alone. */
const POSES = {
  soffit: { pos: [-1.2, 0, 19.9], eye: 1.62, look: [0.4, 5.4, 20.6], fov: 62 },
  column_full: { pos: [-6.9, 0, 14.6], eye: 1.6, look: [-3.6, 3.2, 16.6], fov: 66 },
  at_pump: { pos: [-2.66, 0, 14.42], eye: 1.62, look: [-2.2, 3.4, 16.6], fov: 58 },
  approach: { pos: [-13.0, 0, 6.0], eye: 1.66, look: [1.5, 3.6, 20.0], fov: 58 },
  sign: { pos: [0.4, 0, 2.4], eye: 1.62, look: [0.6, 5.45, 13.1], fov: 46 },
};
const POSE = arg("pose", "column_full");
const TOLERATE = arg("tolerate", "").split(",");

/**
 * Default subject list: the canopy's own parts, plus surfaces owned by other
 * systems that appear in the same frame. The foreign ones are the reference —
 * that is the whole method. Names that are absent from the scene are reported
 * as absent rather than skipped silently.
 */
const NAMES = arg(
  "names",
  [
    "canopy-soffit",
    "canopy-fascia",
    "canopy-fascia-stripe",
    "canopy-columns",
    "canopy-column-bases",
    "canopy-fixture-lenses",
    "canopy-fixture-housings",
    "canopy-signs",
    "canopy-overflow-stains",
    "canopy-roof",
    // Reference surfaces owned by other systems. These are the ranking, not
    // decoration: "the soffit is darker than the asphalt it shades" is a
    // defect statement that no exposure change can overturn.
    "forecourt-slabs",
    "pump-islands",
    "highway",
    "curbs",
  ].join(",")
).split(",").filter(Boolean);

const resources = { server: null, browser: null };
let shuttingDown = false;
async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[rank] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[rank] browser close failed: ${e?.message ?? e}`);
  }
  try {
    const s = resources.server;
    if (s?.close) await s.close();
    else if (s?.httpServer) await new Promise((r) => s.httpServer.close(r));
  } catch (e) {
    console.error(`[rank] server close failed: ${e?.message ?? e}`);
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

async function waitForPort(port, budgetMs) {
  const net = await import("node:net");
  const free = () =>
    new Promise((res) => {
      const s = net.createConnection({ port, host: "127.0.0.1" });
      s.on("connect", () => {
        s.destroy();
        res(false);
      });
      s.on("error", () => res(true));
    });
  const t0 = Date.now();
  for (;;) {
    if (await free()) return;
    if (Date.now() - t0 > budgetMs) throw new Error(`port ${port} busy after ${budgetMs} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[rank] building...");
    try {
      if (os.platform() === "win32") process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
    } catch { /* best effort */ }
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  await waitForPort(PORT, 240_000);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
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
  page.on("pageerror", (e) => problems.push(e.message));

  const url = `${base}?shot=rank&gpu=1${QUERY ? `&${QUERY}` : ""}`;
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });

  const gpu = await assertHardwareGpu(page, { tag: "rank", allowSoftware: ALLOW_SOFTWARE });
  console.log(`[rank] gpu: ${gpu.renderer}`);

  /**
   * A system error aborts the run by default, because a ranking taken from a
   * half-built scene is worse than no ranking: the missing system's surfaces
   * simply are not in the tonal order and nothing in the output says so.
   *
   * `--tolerate=<systems>` is the deliberate exception, and it is a comma list
   * of names rather than a boolean so that tolerating one sibling's known
   * problem cannot silently tolerate a different one that appears later. Every
   * tolerated message is printed in full, because the whole hazard here is a
   * measurement taken through a fault the reader does not know about.
   */
  const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
  const tolerated = new Set(TOLERATE.filter(Boolean));
  const fatal = sysErrs.filter((e) => !tolerated.has(e.system));
  if (fatal.length) throw new Error(`systems failed: ${fatal.map((e) => e.system).join(", ")}`);
  for (const e of sysErrs) {
    console.log(`[rank] TOLERATED (--tolerate=${e.system}) ${e.system}/${e.phase}: ${e.message}`);
  }

  const pose = POSES[POSE];
  if (!pose) throw new Error(`unknown pose "${POSE}"; have ${Object.keys(POSES).join(", ")}`);
  const applied = await page.evaluate((p) => {
    const g = window.__GAME;
    const cam = g.camera;
    const pos = p.pos.slice();
    const gh = g.tryGet("groundHeight");
    if (typeof gh !== "function") return false;
    pos[1] = gh(pos[0], pos[2]) + p.eye;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.up.set(0, 1, 0);
    cam.rotation.set(0, 0, 0);
    cam.lookAt(p.look[0], p.look[1], p.look[2]);
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return true;
  }, pose);
  if (!applied) throw new Error("could not apply pose");

  const settle = () =>
    page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 20 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );
  await settle();

  const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
  const total = WIDTH * HEIGHT;

  /* determinism control */
  const a = await shoot();
  const b = await shoot();
  //
  // Something in the scene is not perfectly still — 7 pixels of a 1.44 M frame,
  // at time of writing. Rather than tolerate that as a threshold, the drifting
  // pixels are identified and then excluded from every object's set below, so
  // no object can be credited with a pixel that moves on its own. A large drift
  // still refuses, because then the exclusion mask itself is unreliable.
  //
  const drifting = new Uint8Array(WIDTH * HEIGHT);
  let drift = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      drifting[p] = 1;
      drift++;
    }
  }
  if (drift > total * 0.005) {
    console.error(
      `[rank] REFUSING TO REPORT: two renders with nothing changed differ in ${drift} pixels ` +
        `(${((drift / total) * 100).toFixed(2)}% of frame).\n` +
        `       Every "changed pixel" set below would be measuring that noise instead of the object.`
    );
    await shutdown(1, "scene is not deterministic");
    return;
  }
  console.log(`[rank] determinism control: ${drift} drifting pixels, excluded from every measurement below\n`);

  const rows = [];
  for (const name of NAMES) {
    const present = await page.evaluate((n) => {
      const o = window.__GAME.scene.getObjectByName(n);
      if (!o) return false;
      o.visible = false;
      return true;
    }, name);
    if (!present) {
      rows.push({ name, absent: true });
      continue;
    }
    await settle();
    const off = await shoot();
    await page.evaluate((n) => {
      window.__GAME.scene.getObjectByName(n).visible = true;
    }, name);
    await settle();

    // Pixels of this object = pixels that changed when it was hidden.
    const vals = [];
    let sum = 0;
    for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
      if (drifting[p]) continue;
      if (a.data[i] === off.data[i] && a.data[i + 1] === off.data[i + 1] && a.data[i + 2] === off.data[i + 2]) continue;
      const l = luma(a.data[i], a.data[i + 1], a.data[i + 2]);
      vals.push(l);
      sum += l;
    }
    if (!vals.length) {
      rows.push({ name, px: 0, luma: null });
      continue;
    }
    vals.sort((p, q) => p - q);
    rows.push({
      name,
      px: vals.length,
      pct: (vals.length / total) * 100,
      luma: sum / vals.length,
      p10: vals[Math.floor(vals.length * 0.1)],
      p90: vals[Math.floor(vals.length * 0.9)],
    });
  }

  /* control: restoring everything must return the original frame exactly */
  await settle();
  const restored = await shoot();
  let rdiff = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) if (!drifting[p] && a.data[i] !== restored.data[i]) rdiff++;

  console.log(`pose ${POSE}  ${WIDTH}x${HEIGHT}\n`);
  const sorted = rows.filter((r) => r.luma != null).sort((p, q) => q.luma - p.luma);
  console.log("  brightest to darkest, region chosen by the object itself:\n");
  console.log(`    ${"surface".padEnd(24)} ${"px".padStart(8)} ${"% frame".padStart(8)} ${"luma".padStart(7)} ${"p10".padStart(6)} ${"p90".padStart(6)}`);
  for (const r of sorted) {
    console.log(
      `    ${r.name.padEnd(24)} ${String(r.px).padStart(8)} ${r.pct.toFixed(2).padStart(8)} ` +
        `${r.luma.toFixed(1).padStart(7)} ${r.p10.toFixed(0).padStart(6)} ${r.p90.toFixed(0).padStart(6)}`
    );
  }
  for (const r of rows) {
    if (r.absent) console.log(`    ${r.name.padEnd(24)} ABSENT from the scene graph`);
    else if (r.px === 0) console.log(`    ${r.name.padEnd(24)} DRAWS NOTHING — 0 pixels changed when it was hidden`);
  }
  // Whatever drifts in this scene drifts on its own schedule, so a handful of
  // pixels here is the same nondeterminism the opening control found and not a
  // visibility flag left in the wrong state. A leak from a missed restore is a
  // whole object, which is thousands of pixels, so the two are not close.
  const leaked = rdiff > Math.max(64, drift * 8);
  console.log(
    `\n  restore control: ${rdiff} pixels differ from the original frame` +
      (leaked ? "  <-- STATE LEAKED" : rdiff ? "  (within the drift already measured)" : "")
  );
  if (problems.length) console.log(`  page errors: ${problems.length} (first: ${problems[0].slice(0, 160)})`);

  await context.close();
  await shutdown(leaked ? 1 : 0, leaked ? "state leaked between measurements" : null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
