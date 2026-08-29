#!/usr/bin/env node
/**
 * Minimal console/error probe for System 4. Serves the private System 4 build
 * on port 5116, opens one page, prints everything the page says, and exits.
 *
 *   node tools/lightProbe.mjs [querystring]
 *
 * Same teardown contract as the capture harness: handlers installed before
 * anything is launched, browser and server closed on every path, explicit exit.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot4-build");
const PORT = 5116;
const QUERY = process.argv[2] ?? "";

const resources = { server: null, browser: null };
let shuttingDown = false;

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`[probe] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[probe] browser close failed: ${e?.message ?? e}`);
  }
  try {
    const s = resources.server;
    if (s?.close) await s.close();
    else if (s?.httpServer) await new Promise((r) => s.httpServer.close(r));
  } catch (e) {
    console.error(`[probe] server close failed: ${e?.message ?? e}`);
  }
  resources.browser = null;
  resources.server = null;
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

async function main() {
  const { preview } = await import("vite");
  const { chromium } = await import("playwright");

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  resources.browser = await chromium.launch(launchOptions({}));
  const page = await resources.browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[page:error] ${e.stack ?? e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/?gpu=1${QUERY ? `&${QUERY}` : ""}`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  let ready = true;
  try {
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 90_000 });
  } catch {
    ready = false;
  }
  console.log(`[probe] scene ready: ${ready}`);
  console.log(`[probe] __LIGHTING: ${JSON.stringify(await page.evaluate(() => window.__LIGHTING ?? null))}`);
  console.log(
    `[probe] loading text: ${JSON.stringify(await page.evaluate(() => document.getElementById("loading")?.textContent ?? null))}`
  );
  await shutdown(ready ? 0 : 1, null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
