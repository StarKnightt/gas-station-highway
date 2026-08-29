#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 *   pnpm shoot                      # all presets -> shots/system1/
 *   pnpm shoot --system=system2     # different output folder
 *   pnpm shoot --shots=ground,wide  # subset
 *   pnpm shoot --no-build           # reuse the existing dist/
 *   pnpm shoot --query=force=wheel  # append debug params to the page URL
 *   pnpm shoot --allow-software     # opt out of the hardware-GPU requirement
 *
 * The run renders on the discrete GPU and hard-fails if Chromium falls back to
 * a software rasteriser; see tools/gpu.mjs for why that failure has to be loud.
 *
 * Teardown contract (repo-wide rule): the vite preview server and the Playwright
 * browser are registered with a single shutdown routine that is wired to every
 * exit path - normal completion, thrown errors, SIGINT, SIGTERM,
 * uncaughtException and unhandledRejection - BEFORE either of them is started.
 * Nothing is ever detached and the process always ends with an explicit
 * process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";
import { assertPrivateBuildDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SYSTEM = arg("system", "system1");
// Extra URL query (no leading &) so a debug build can be captured for diffing.
const QUERY = arg("query", "");
const ONLY = arg("shots", "").split(",").filter(Boolean);
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

const ALL_SHOTS = ["approach", "lot", "pumps", "ground", "wide"];
const SHOTS = ONLY.length ? ALL_SHOTS.filter((s) => ONLY.includes(s)) : ALL_SHOTS;

// Build into a directory owned by this run rather than the shared `dist/`.
// Several agents build this repo concurrently, so a capture pointed at `dist/`
// can photograph a bundle that another process replaced halfway through - which
// is exactly how a full review round got spent critiquing stale frames. Port is
// derived from the system name for the same reason.
const BUILD_DIR = `.shot-build/${SYSTEM}`;
const PORT = 5100 + ([...SYSTEM].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 300, 7) || 11);

/** Identity of the bundle actually being served: hash and mtime of the entry chunk. */
async function bundleStamp() {
  const dir = path.join(ROOT, BUILD_DIR, "assets");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js")).sort();
  const h = crypto.createHash("sha256");
  let newest = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    h.update(await fs.readFile(p));
    newest = Math.max(newest, (await fs.stat(p)).mtimeMs);
  }
  // Local time, so it can be compared directly against file mtimes on disk.
  return { hash: h.digest("hex").slice(0, 12), mtime: new Date(newest).toLocaleString("sv-SE") };
}

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[shoot] shutting down: ${reason}`);

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
      console.error(`[shoot] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  // Explicit exit: never leave a stray listener holding the event loop open.
  process.exit(code);
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (err) => void shutdown(1, `uncaughtException: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => void shutdown(1, `unhandledRejection: ${err?.stack ?? err}`));

/* ------------------------------------------------------------------ */

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    // `--system=` with an empty value makes SYSTEM the empty string, which makes
    // BUILD_DIR the shared `.shot-build/` root, which `emptyOutDir: true` then
    // deletes along with every other agent's private bundle. That has happened:
    // `.shot-build/` still holds the orphaned `index.html` and `assets/` the
    // destructive build left behind, and it cost one agent two rounds. See
    // tools/scratch.mjs.
    assertPrivateBuildDir(ROOT, BUILD_DIR, "shoot");
    console.log("[shoot] building...");
    // Long CPU-bound work runs below normal priority so the machine stays usable.
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  const stamp = await bundleStamp();
  console.log(`[shoot] bundle ${stamp.hash}  built ${stamp.mtime}  (${BUILD_DIR})`);

  console.log(`[shoot] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));

  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  // Verify the adapter before spending four minutes rendering on the CPU.
  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "shoot", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const outDir = path.join(ROOT, "shots", SYSTEM);
  await fs.mkdir(outDir, { recursive: true });

  const written = [];
  const shaderFailures = [];
  const tAll = Date.now();
  for (const shot of SHOTS) {
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const url = `${base}?shot=${encodeURIComponent(shot)}${QUERY ? `&${QUERY}` : ""}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch (err) {
      // The scene never signalled ready. Almost always the page threw during
      // setup, so print what it said - a bare timeout tells you nothing and
      // sends you looking in the wrong place.
      if (problems.length) console.error(`[shoot] ${shot} never became ready. Page said:\n    ${problems.join("\n    ")}`);
      throw err;
    }
    // A couple of extra rAF ticks so any lazily compiled program has drawn.
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n < 8 ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        })
    );

    const file = path.join(outDir, `${shot}.png`);
    await page.screenshot({ path: file, type: "png" });
    written.push(file);
    console.log(`[shoot] ${shot.padEnd(9)} -> ${path.relative(ROOT, file)}  bundle ${stamp.hash}  (${Date.now() - t0} ms)`);
    if (problems.length) {
      console.error(`[shoot]   page problems:\n    ${problems.slice(0, 4).join("\n    ")}`);
      // A shader that fails to link still "renders" - the material just quietly
      // stops doing what it was written to do. That is how three features
      // shipped broken, so it is fatal here.
      if (problems.some((p) => /Shader Error|not compiled|VALIDATE_STATUS/i.test(p))) {
        shaderFailures.push(`${shot}: shader link failure`);
      }
    }
    await page.close();
  }

  await context.close();

  // Prove nothing swapped the bundle under us while we were shooting.
  const after = await bundleStamp();
  const raced = after.hash !== stamp.hash ? [`bundle changed mid-capture: ${stamp.hash} -> ${after.hash}`] : [];

  console.log(
    `\n[shoot] ${written.length}/${SHOTS.length} screenshots written to ${path.join("shots", SYSTEM)}` +
      ` in ${((Date.now() - tAll) / 1000).toFixed(1)}s from bundle ${stamp.hash} (${stamp.mtime})`
  );
  const missing = SHOTS.filter((s) => !written.some((w) => w.endsWith(`${s}.png`)));
  const bad = [...missing.map((m) => `missing: ${m}`), ...shaderFailures, ...raced];
  await shutdown(bad.length ? 1 : 0, bad.length ? bad.join("; ") : null);
}

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort only */
  }
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
