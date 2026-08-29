#!/usr/bin/env node
/**
 * Which object puts NaN into the environment cube?
 *
 *   node tools/envnan.mjs
 *   node tools/envnan.mjs --no-build
 *   node tools/envnan.mjs --cases='all|;noveg|skip=vegetation'
 *
 * A capture round is four minutes and this question needs one page load per
 * hypothesis, so this is deliberately not a capture harness: it loads the page
 * with `?worldenv=1&envdump=1`, reads `window.__LIGHTING.worldEnv` back and
 * prints the per-face non-finite counts. No screenshots, no archive, no poses.
 *
 * It writes each case's cube dump to `shots/system4/nanhunt/` because the dump
 * paints non-finite pixels **magenta** (see `buildWorldEnvironment`), which
 * turns "116 pixels somewhere in a bounding box" into a picture of the object
 * responsible.
 *
 * Port 5125 and `.shot-build/system4`, the same private pair `shoot4.mjs` owns,
 * so it can never race a sibling agent's build - and it must never run at the
 * same time as `shoot4.mjs`.
 *
 * Same teardown contract as `shoot4.mjs`: server and browser are registered
 * with one shutdown routine wired to every exit path before either is started.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "system4");
const DUMP_DIR = path.join(ROOT, "shots", "system4", "nanhunt");
const PORT = 5125;
const READY_TIMEOUT_MS = 900_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DO_BUILD = !argv.includes("--no-build");

/**
 * `name|query` pairs. The default set bisects by system, one system removed at
 * a time, which is the cheapest form of the question: every system that is not
 * lighting draws something at the horizon on at least one face.
 */
const CASES = (arg("cases", null) ?? [
  "all|",
  "noterrain|skip=terrain",
  "noveg|skip=vegetation",
  "nobuilding|skip=building",
  "nopumps|skip=pumps",
  "nocar|skip=car",
].join("+"))
  // `+` and `;` both separate cases. `;` reads better and `+` is the one that
  // survives being typed into a shell without quoting going wrong, which has
  // already cost one orphaned preview server on this port.
  .split(/[;+]/)
  .filter(Boolean)
  .map((spec) => {
    const bar = spec.indexOf("|");
    return { name: bar < 0 ? spec : spec.slice(0, bar), query: bar < 0 ? "" : spec.slice(bar + 1) };
  });

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
  if (reason) console.error(`\n[envnan] shutting down: ${reason}`);
  // Hard backstop. A run that timed out on a page blocked inside a long GPU
  // task left this process alive holding port 5125, and the next run failed to
  // bind - which on a shared machine is indistinguishable from a sibling
  // agent's harness squatting on the port. Teardown that can hang is teardown
  // that does not exist.
  const hardExit = setTimeout(() => {
    console.error("[envnan] teardown did not complete in 30s - forcing exit");
    process.exit(code);
  }, 30_000);
  hardExit.unref?.();
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
      console.error(`[envnan] failed to close ${label}: ${err?.message ?? err}`);
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

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[envnan] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }
  await fs.mkdir(DUMP_DIR, { recursive: true });

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({
    viewport: { width: 900, height: 520 },
    deviceScaleFactor: 1,
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "envnan" });
  await gpuPage.close();

  const rows = [];
  for (const c of CASES) {
    const page = await context.newPage();
    const parts = ["shot=system4", "worldenv=1", "envdump=1", "envinstall=0"];
    if (c.query) parts.push(c.query);
    await page.goto(`${base}?${parts.join("&")}`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    const we = await page.evaluate(() => window.__LIGHTING?.worldEnv ?? null);
    const dump = await page.evaluate(() => window.__ENV_DUMP ?? null);
    // Every case here reports a *count*, and a system that threw contributes a
    // count of zero that is indistinguishable from a system that is innocent.
    // `skip=building` makes VegetationSystem throw for a missing footprint
    // service, so the first run of this probe read "removing the building
    // removes the NaN" - a conclusion about the wrong system, arrived at from a
    // number that was true. Anything other than lighting's own environment
    // rejection is reported next to the count.
    const errs = await page.evaluate(() =>
      (window.__SYSTEM_ERRORS ?? []).map((e) => `${e?.system}.${e?.phase}: ${String(e?.message ?? e)}`)
    );
    const foreign = errs.filter((e) => !/^lighting\.update: world environment REJECTED/.test(e));
    const culprit = await page.evaluate(() => window.__LIGHTING?.envCulprit ?? null);
    if (culprit) console.log(`[envnan]   culprit: ${JSON.stringify(culprit)}`);
    if (dump) {
      const png = Buffer.from(dump.slice(dump.indexOf(",") + 1), "base64");
      await fs.writeFile(path.join(DUMP_DIR, `${c.name}.png`), png);
    }
    const faces = we?.faces ?? [];
    const total = faces.reduce((a, f) => a + Math.max(0, f.bad), 0);
    rows.push({ name: c.name, total, faces, foreign });
    console.log(
      `[envnan] ${c.name.padEnd(14)} bad=${String(total).padStart(5)}  ` +
        faces
          .map(
            (f) =>
              `${f.face}:${f.bad}(nan${f.nan}/inf${f.inf},max${Number(f.maxChannel).toPrecision(3)})` +
              (f.badBox ? `[y${f.badBox[1]}-${f.badBox[3]}]` : "")
          )
          .join(" ")
    );
    if (foreign.length) console.log(`[envnan]   !! UNTRUSTWORTHY - a system threw: ${foreign.join(" | ")}`);
    await page.close();
  }

  console.log("\n[envnan] summary");
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.total).padStart(5)}${r.foreign.length ? "  UNTRUSTWORTHY" : ""}`);
  }
  console.log(`[envnan] dumps -> ${path.relative(ROOT, DUMP_DIR)} (non-finite pixels are magenta)`);

  await context.close();
  await shutdown(0, null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
