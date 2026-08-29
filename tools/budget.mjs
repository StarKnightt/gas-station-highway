/**
 * Standing cost budget for the scene.
 *
 * Why this exists: nobody measured anything for a full day, and the scene
 * reached ~950 MB of GPU memory and 2.8 M triangles without a single person
 * noticing, because cost was only ever visible to somebody who went looking for
 * it. This makes it visible by default. Any harness can add two lines and get a
 * loud failure when a round takes the scene over budget.
 *
 * ## Usage from another harness
 *
 * ```js
 * import { budgetInitScript, checkBudget, reportBudget } from "./budget.mjs";
 *
 * await context.addInitScript({ content: await budgetInitScript() });  // before any page loads
 * // ... load the page with ?shot=<name>, wait for __SCENE_READY ...
 * const result = await checkBudget(page, { shot: "pumps" });
 * reportBudget(result, { tag: "shoot6" });
 * if (result.failed) process.exitCode = 1;     // or throw, your call
 * ```
 *
 * `tools/budget.json` holds the accepted numbers. Update it deliberately, with
 * the reason in the commit, not to silence a failure.
 *
 * ## What it measures, and why not the obvious things
 *
 * **Draw calls and triangles are counted at the GL layer, per animation frame,
 * not read from `renderer.info`.** `renderer.info.render` is reset at the top of
 * every `render()` call, so reading it afterwards reports the last pass only —
 * in this scene, that silently omits the shadow pass, which is 39% of the
 * frame's draw calls. A budget built on that number would have shown the scene
 * getting cheaper as the shadow got more expensive.
 *
 * **Texture memory is counted in bytes from the upload calls, not from
 * `renderer.info.memory.textures`,** which is a count of texture objects and is
 * equally consistent with 40 MB of icons and 900 MB of 4K maps. Counting bytes
 * at `texImage2D`/`texStorage2D` also catches the allocations three makes on
 * your behalf — shadow maps, PMREM targets — which are the largest in the scene
 * and appear nowhere in the scene graph. In this scene the scene-graph estimate
 * was 377 MB against 710 MB actually resident.
 *
 * **Nothing here trusts a system's own report of what it built.** Several
 * systems publish a registry line with their object and triangle counts, and at
 * least one of them silently excludes some of its own meshes, so a budget
 * assembled from those lines would under-count by an unknown amount that
 * changes whenever somebody adds a mesh through a different code path. Every
 * number below comes from the renderer or from the GL calls it made. The
 * per-system attribution is a convenience for finding an owner; the *budget* is
 * enforced on the totals, which cannot be under-reported by a system that
 * forgot to register something.
 *
 * ## Fixed poses are not optional
 *
 * Draw calls and triangles depend on where the camera is. A budget measured at
 * wherever the player happened to spawn is noise, and it will drift as other
 * systems change the spawn. Always pass a `?shot=` pose; the per-shot budgets
 * in `budget.json` are keyed on it. Texture bytes, geometry bytes and program
 * count are pose-independent and are checked against a single global entry.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = path.join(HERE, "budget.json");

/**
 * The instrumentation that must be installed before the page's own scripts run.
 * Shared with tools/perf.mjs — one implementation, so a budget failure and a
 * perf report can never disagree about what a megabyte is.
 */
export async function budgetInitScript() {
  return fs.readFile(path.join(HERE, "perf-instrument.js"), "utf8");
}

export async function loadBudgets() {
  try {
    return JSON.parse(await fs.readFile(BUDGET_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Samples the live scene. `frames` animation frames are observed so the draw
 * counts come from real frames rather than from a single render whose passes
 * may not all have run yet.
 */
export async function measureBudget(page, { frames = 30 } = {}) {
  return page.evaluate(async (n) => {
    const g = window.__GLSTAT;
    if (!g) {
      throw new Error(
        "budget: window.__GLSTAT is missing. The instrumentation must be installed with " +
          "addInitScript BEFORE the page loads — see budgetInitScript() in tools/budget.mjs."
      );
    }
    const game = window.__GAME;
    if (!game) throw new Error("budget: window.__GAME is missing; this page does not boot Game.");

    const gl = game.renderer.getContext();
    if (gl.isContextLost()) throw new Error("budget: the WebGL context is lost; every number would be stale.");

    // Watch whole animation frames and take the *maximum*, not the mean: a
    // frame that skips the shadow pass is cheaper and is not the frame the
    // budget is about.
    const perFrame = [];
    await new Promise((resolve) => {
      let seen = 0;
      let lastDraws = g.draws;
      let lastTris = g.drawTris;
      const tick = () => {
        perFrame.push({ draws: g.draws - lastDraws, tris: g.drawTris - lastTris });
        lastDraws = g.draws;
        lastTris = g.drawTris;
        if (++seen >= n) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Drop the first: it spans whatever happened between the call and the first
    // callback, which is not a frame.
    const fr = perFrame.slice(1);
    const max = (sel) => fr.reduce((a, r) => Math.max(a, sel(r)), 0);
    const median = (sel) => {
      const v = fr.map(sel).sort((a, b) => a - b);
      return v.length ? v[v.length >> 1] : 0;
    };

    let scene = { objects: 0, triangles: 0, lights: 0, shadowCasters: 0, biggestShadowMap: 0 };
    game.scene.traverse((o) => {
      if (o.isMesh || o.isPoints || o.isLine) {
        scene.objects++;
        const geo = o.geometry;
        const count = geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0;
        scene.triangles += (count / 3) * (o.isInstancedMesh ? o.count : 1);
      }
      if (o.isLight) {
        scene.lights++;
        if (o.castShadow) {
          scene.shadowCasters++;
          const s = o.shadow?.mapSize;
          if (s) scene.biggestShadowMap = Math.max(scene.biggestShadowMap, s.x, s.y);
        }
      }
    });
    scene.triangles = Math.round(scene.triangles);

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");

    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      drawCallsPerFrame: max((r) => r.draws),
      drawCallsMedian: median((r) => r.draws),
      trianglesPerFrame: Math.round(max((r) => r.tris)),
      programs: game.renderer.info.programs?.length ?? 0,
      textureBytes: g.live.texBytes,
      textureCount: g.live.texCount,
      bufferBytes: g.live.bufBytes,
      peakTextureBytes: g.peak.texBytes,
      uploadedTextureBytes: g.tex.bytes,
      scene,
      drawingBuffer: { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight },
      systemErrors: (window.__SYSTEM_ERRORS ?? []).length,
    };
  }, frames);
}

const MB = (b) => +(b / 1048576).toFixed(2);

/**
 * Measures and compares against `budget.json`. Returns the measurement plus a
 * list of violations; it does not throw, so a caller can report several
 * failures at once rather than one per run.
 */
export async function checkBudget(page, { shot = null, frames = 30, tolerancePct = null } = {}) {
  const measured = await measureBudget(page, { frames });
  const budgets = await loadBudgets();
  return compareBudget(measured, budgets, { shot, tolerancePct });
}

/**
 * The comparison, split out from the measurement so the failure path can be
 * tested without a browser. An enforcement mechanism that has never been seen
 * to fail is not an enforcement mechanism.
 */
export function compareBudget(measured, budgets, { shot = null, tolerancePct = null } = {}) {
  const violations = [];
  const notes = [];

  if (!budgets) {
    notes.push("no tools/budget.json yet — run `node tools/budget.mjs --write` to record the current scene as the accepted baseline");
    return { measured, violations, notes, failed: false, shot };
  }
  tolerancePct = tolerancePct ?? budgets.tolerancePct ?? 5;

  const over = (label, value, limit, fmt = (v) => v) => {
    if (limit == null) return;
    const ceiling = limit * (1 + tolerancePct / 100);
    if (value > ceiling) {
      violations.push({
        label,
        value: fmt(value),
        budget: fmt(limit),
        overBy: fmt(value - limit),
        pct: +(((value / limit - 1) * 100)).toFixed(1),
      });
    }
  };

  const g = budgets.global ?? {};
  over("texture memory", measured.textureBytes, g.textureBytes, MB);
  over("buffer memory", measured.bufferBytes, g.bufferBytes, MB);
  over("shader programs", measured.programs, g.programs);
  over("scene triangles", measured.scene.triangles, g.sceneTriangles);
  over("shadow map size", measured.scene.biggestShadowMap, g.biggestShadowMap);

  if (shot) {
    const s = budgets.shots?.[shot];
    if (!s) {
      notes.push(`no budget recorded for shot "${shot}" — draw calls and triangles were measured but not checked`);
    } else {
      over(`draw calls @${shot}`, measured.drawCallsPerFrame, s.drawCalls);
      over(`triangles/frame @${shot}`, measured.trianglesPerFrame, s.triangles);
    }
  } else {
    notes.push("no shot given: draw calls and triangles depend on the camera pose and were not checked");
  }

  if (measured.systemErrors > 0) {
    violations.push({ label: "__SYSTEM_ERRORS", value: measured.systemErrors, budget: 0, overBy: measured.systemErrors, pct: Infinity });
  }

  return { measured, violations, notes, failed: violations.length > 0, shot, budgets };
}

export function reportBudget(result, { tag = "budget" } = {}) {
  const m = result.measured;
  console.log(
    `[${tag}] budget: ${MB(m.textureBytes)} MB textures (${m.textureCount}), ${MB(m.bufferBytes)} MB buffers, ` +
      `${m.programs} programs, ${m.scene.triangles.toLocaleString()} scene triangles, ` +
      `${m.drawCallsPerFrame} draws/frame${result.shot ? ` @${result.shot}` : ""}, ` +
      `${m.trianglesPerFrame.toLocaleString()} tris/frame, shadow ${m.scene.biggestShadowMap}`
  );
  for (const n of result.notes) console.log(`[${tag}] note: ${n}`);
  if (result.failed) {
    console.error(`[${tag}] !! OVER BUDGET on ${result.violations.length} metric(s):`);
    for (const v of result.violations) {
      console.error(`[${tag}]    ${v.label}: ${v.value} against a budget of ${v.budget} (+${v.overBy}, ${v.pct}%)`);
    }
    console.error(
      `[${tag}]    If this increase is intended, update tools/budget.json in the same change ` +
        `and say what bought it. Do not raise it to make the check pass.`
    );
  }
  return result;
}

/**
 * `node tools/budget.mjs [--write] [--port=5152]` — measures every shot against
 * a fresh build and prints the table, or records it as the new accepted
 * baseline. Run on a quiet machine; the counts are contention-proof but the
 * build is not instant.
 */
/**
 * `--selftest` proves the failure path actually fails, offline. Worth the
 * twenty lines: a guard that silently passes is worse than no guard, because
 * everyone stops looking.
 */
function selftest() {
  const budgets = {
    tolerancePct: 5,
    global: { textureBytes: 100 * 1048576, bufferBytes: 10 * 1048576, programs: 100, sceneTriangles: 1000, biggestShadowMap: 4096 },
    shots: { pumps: { drawCalls: 100, triangles: 1000 } },
  };
  const base = {
    textureBytes: 100 * 1048576,
    bufferBytes: 10 * 1048576,
    programs: 100,
    scene: { triangles: 1000, biggestShadowMap: 4096 },
    drawCallsPerFrame: 100,
    trianglesPerFrame: 1000,
    systemErrors: 0,
  };
  const cases = [
    ["exactly at budget passes", base, 0],
    ["4% over is inside tolerance", { ...base, programs: 104 }, 0],
    ["6% over fails", { ...base, programs: 106 }, 1],
    ["a doubled texture budget fails", { ...base, textureBytes: 200 * 1048576 }, 1],
    ["a bigger shadow map fails", { ...base, scene: { triangles: 1000, biggestShadowMap: 8192 } }, 1],
    ["more draw calls at a shot fails", { ...base, drawCallsPerFrame: 200 }, 1],
    ["a system error always fails", { ...base, systemErrors: 1 }, 1],
    ["going under budget passes", { ...base, textureBytes: 1048576, drawCallsPerFrame: 1 }, 0],
  ];
  let bad = 0;
  for (const [name, measured, expected] of cases) {
    const r = compareBudget(measured, budgets, { shot: "pumps" });
    const got = r.violations.length ? 1 : 0;
    const ok = got === expected;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : ` — expected ${expected ? "a violation" : "no violation"}, got ${r.violations.map((v) => v.label).join(", ") || "none"}`}`);
  }
  console.log(bad === 0 ? "[budget] selftest passed" : `[budget] selftest FAILED on ${bad} case(s)`);
  return bad === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exit(selftest() ? 0 : 1);
  }
  const write = argv.includes("--write");
  const PORT = Number((argv.find((a) => a.startsWith("--port=")) || "").slice(7) || 5152);

  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  const { launchOptions, assertHardwareGpu, assertSceneGpu } = await import("./gpu.mjs");
  const { SHOT_NAMES } = await import("./shotNames.mjs");

  const ROOT = path.resolve(HERE, "..");
  const OUT = ".shot-build/budget";
  let server;
  let browser;
  const shutdown = async () => {
    try {
      await browser?.close();
    } catch {
      /* already gone */
    }
    try {
      await new Promise((r) => server?.httpServer?.close(r));
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(130);
  });

  try {
    console.log("[budget] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT, emptyOutDir: true } });
    server = await preview({
      root: ROOT,
      logLevel: "warn",
      build: { outDir: OUT },
      preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
    });

    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.addInitScript({ content: await budgetInitScript() });

    const rows = {};
    let global = null;
    for (const shot of SHOT_NAMES) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/?shot=${shot}`, { waitUntil: "load", timeout: 60_000 });
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
      if (!global) await assertHardwareGpu(page, { tag: "budget" });
      await assertSceneGpu(page, { tag: "budget", when: `at shot=${shot}` });

      const r = await checkBudget(page, { shot });
      reportBudget(r, { tag: `budget/${shot}` });
      rows[shot] = { drawCalls: r.measured.drawCallsPerFrame, triangles: r.measured.trianglesPerFrame };
      // Pose-independent figures: take them from the most expensive pose so the
      // recorded ceiling is never below something a real frame does.
      global = {
        textureBytes: Math.max(global?.textureBytes ?? 0, r.measured.textureBytes),
        bufferBytes: Math.max(global?.bufferBytes ?? 0, r.measured.bufferBytes),
        programs: Math.max(global?.programs ?? 0, r.measured.programs),
        sceneTriangles: Math.max(global?.sceneTriangles ?? 0, r.measured.scene.triangles),
        biggestShadowMap: Math.max(global?.biggestShadowMap ?? 0, r.measured.scene.biggestShadowMap),
      };
      await page.close();
    }

    if (write) {
      const doc = {
        _comment:
          "Accepted cost ceilings, enforced by tools/budget.mjs. Measured from the renderer and the GL " +
          "calls it makes, never from a system's own report. Raise a number only with a reason.",
        recorded: new Date().toISOString(),
        tolerancePct: 5,
        global,
        shots: rows,
      };
      await fs.writeFile(BUDGET_FILE, JSON.stringify(doc, null, 2) + "\n");
      console.log(`[budget] wrote ${BUDGET_FILE}`);
    } else {
      console.log("\n[budget] not written. Re-run with --write to accept these as the baseline.");
      console.log(JSON.stringify({ global, shots: rows }, null, 2));
    }
  } finally {
    await shutdown();
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`[budget] ${err?.stack ?? err}`);
    process.exit(1);
  });
}
