#!/usr/bin/env node
/**
 * Hotfix verification harness for the pump-merge crash and the system
 * isolation added to `Game.start()`.
 *
 *   node tools/hotfix.mjs              # build, load once, assert
 *   node tools/hotfix.mjs --no-build   # reuse .shot-build/hotfix
 *
 * Port 5118 and a private build directory, because four other agents rebuild
 * the shared dist/ concurrently and 5115/5117 are in use.
 *
 * This is deliberately not a capture loop: it loads the page once, asserts on
 * numbers the page reports about itself (scene ready, per-system failures,
 * pump mesh count and triangle count, live console) and takes exactly one
 * confirming frame.
 *
 * Teardown contract: the preview server and the browser are registered with a
 * single shutdown routine wired to normal completion, thrown errors, SIGINT,
 * SIGTERM, uncaughtException and unhandledRejection BEFORE either is started.
 * Nothing is detached and the process always ends in an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "hotfix");
const PORT = 5118;
const WIDTH = 1280;
const HEIGHT = 720;
const READY_TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
const EXPECT_FAIL = (argv.find((a) => a.startsWith("--expect-fail=")) ?? "").split("=")[1] ?? "";

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[hotfix] shutting down: ${reason}`);
  const closers = [
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
  ];
  for (const [label, fn] of closers) {
    try {
      await withTimeout(fn(), 10_000);
    } catch (err) {
      console.error(`[hotfix] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (err) => void shutdown(1, `uncaughtException: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => void shutdown(1, `unhandledRejection: ${err?.stack ?? err}`));

/* ------------------------------------------------------------------ */

const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;

const results = [];
const failures = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[hotfix] building into .shot-build/hotfix ...");
    await build({
      root: ROOT,
      logLevel: "warn",
      build: { outDir: OUT_DIR, emptyOutDir: true },
    });
  }

  console.log(`[hotfix] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[hotfix] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "hotfix", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const page = await context.newPage();
  const problems = [];
  const transcript = [];
  page.on("console", (m) => {
    if (transcript.length < 200) transcript.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error" || SHADER_FAIL.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`${base}index.html?gpu=1`, { waitUntil: "load", timeout: 60_000 });
  let ready = true;
  try {
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
  } catch {
    ready = false;
    console.error("\n[hotfix] index.html never reached __SCENE_READY. Page console:");
    for (const t of transcript) console.error(`    ${t}`);
  }
  check("page: index.html reached __SCENE_READY", ready, ready ? "" : "scene never came up");
  if (!ready) await shutdown(1, "index.html is dead");

  const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null);
  console.log(`  __SYSTEM_ERRORS = ${JSON.stringify(sysErrors)}`);

  if (EXPECT_FAIL) {
    // Isolation proof: one system was deliberately made to throw. The scene
    // must still come up, the failure must be reported, and every other
    // system must have initialised.
    check(
      `isolation: "${EXPECT_FAIL}" reported as failed`,
      Array.isArray(sysErrors) && sysErrors.some((e) => e.system === EXPECT_FAIL && e.phase === "init"),
      JSON.stringify(sysErrors)
    );
    check(
      "isolation: only the injected system failed",
      Array.isArray(sysErrors) && sysErrors.length === 1,
      `${sysErrors?.length} failures`
    );
  } else {
    check("page: no system failed to initialise", Array.isArray(sysErrors) && sysErrors.length === 0, JSON.stringify(sysErrors));
  }

  const scene = await page.evaluate(() => {
    const g = window.__GAME;
    const out = { pumpMeshes: 0, pumpTris: 0, nonIndexed: 0, services: [], objects: 0 };
    g.scene.traverse((o) => {
      out.objects++;
      if (!o.isMesh || !o.geometry) return;
      if (!/^pump-\d/.test(o.name)) return;
      out.pumpMeshes++;
      const idx = o.geometry.getIndex();
      if (!idx) out.nonIndexed++;
      out.pumpTris += (idx ? idx.count : o.geometry.getAttribute("position").count) / 3;
    });
    const faces = g.tryGet("pumpFaces");
    out.pumpFaces = Array.isArray(faces) ? faces.length : 0;
    out.pumps = (g.tryGet("pumps") ?? []).length;
    return out;
  });
  console.log(
    `  scene: ${scene.objects} objects, ${scene.pumpMeshes} pump meshes, ` +
      `${Math.round(scene.pumpTris)} pump triangles, ${scene.pumps} pumps, ${scene.pumpFaces} faces`
  );

  if (!EXPECT_FAIL) {
    check("pumps: real dispensers built", scene.pumps >= 3 && scene.pumpFaces >= 6, `pumps=${scene.pumps} faces=${scene.pumpFaces}`);
    check("pumps: meshes present in the scene graph", scene.pumpMeshes >= 20, `${scene.pumpMeshes} meshes named pump-N:*`);
    check("pumps: geometry is substantial, not a stub", scene.pumpTris > 20000, `${Math.round(scene.pumpTris)} triangles`);
    check("pumps: every merged geometry is indexed", scene.nonIndexed === 0, `${scene.nonIndexed} non-indexed pump meshes`);

    // The pumps must actually be drawn, not merely present in the graph.
    const drawn = await page.evaluate(() => window.__GAME.renderer.info.render);
    console.log(`  renderer.info.render = ${JSON.stringify(drawn)}`);
    check("render: draw calls issued", drawn.calls > 0 && drawn.triangles > 0, `${drawn.calls} calls, ${drawn.triangles} triangles`);
  }

  const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
  const pageErrors = problems.filter((p) => p.startsWith("pageerror"));
  // The injected-throw run logs its own failure on purpose.
  const expected = EXPECT_FAIL ? problems.filter((p) => p.includes("SYSTEM FAILED") || p.includes(EXPECT_FAIL)) : [];
  const unexpected = problems.filter((p) => !expected.includes(p));
  console.log(`  ${problems.length} console/page errors (${expected.length} expected), ${shaderProblems.length} shader-related`);
  for (const p of unexpected.slice(0, 12)) console.log(`    ${p}`);
  check("page: no shader link failures", shaderProblems.length === 0, shaderProblems[0] ?? "");
  check("page: no unexpected console errors", unexpected.length === 0, unexpected[0] ?? "");
  check("page: no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  // Aim at the first dispenser so the frame itself shows the merged geometry,
  // not just the counters above.
  if (!EXPECT_FAIL) {
    await page.evaluate(() => {
      const g = window.__GAME;
      const root = g.scene.getObjectByName("pump-1");
      if (!root) return;
      root.updateWorldMatrix(true, true);
      const p = root.getWorldPosition(new g.camera.position.constructor());
      g.camera.position.set(p.x + 2.6, p.y + 1.75, p.z + 2.4);
      g.camera.lookAt(p.x, p.y + 1.05, p.z);
      g.camera.updateProjectionMatrix();
    });
    await page.waitForTimeout(400);
  }

  const outDir = path.join(ROOT, "shots", "hotfix");
  await fs.mkdir(outDir, { recursive: true });
  const shot = path.join(outDir, EXPECT_FAIL ? `isolation_${EXPECT_FAIL}.png` : "pumps_alive.png");
  await page.screenshot({ path: shot, type: "png" });
  console.log(`  wrote ${path.relative(ROOT, shot)}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[hotfix] ${passed}/${results.length} assertions passed`);

  await page.close();
  await context.close();
  await shutdown(failures.length ? 1 : 0, failures.length ? `${failures.length} assertion(s) failed` : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
