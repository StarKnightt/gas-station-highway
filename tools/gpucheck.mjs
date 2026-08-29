#!/usr/bin/env node
/**
 * One-shot comparison of the old and new harness browser configurations.
 * Reports the renderer string, anisotropy cap and a measured frame time for
 * each, so "we are on the GPU now" is a measurement rather than a belief.
 *
 * Same teardown contract as the other tools: every launched browser is
 * registered before it is started and closed on every exit path.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchOptions, readGpuInfo } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5113;

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`[gpucheck] ${reason}`);
  try {
    await resources.browser?.close();
  } catch {}
  try {
    if (resources.server?.close) await resources.server.close();
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? e));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? e));

const { preview } = await import("vite");
const { chromium } = await import("playwright");

resources.server = await preview({
  root: ROOT,
  logLevel: "silent",
  preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
});
const base = `http://127.0.0.1:${PORT}/`;

const configs = {
  "OLD (headless shell + swiftshader allowed)": {
    headless: true,
    args: [
      "--use-angle=default",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      "--use-gl=angle",
      "--no-sandbox",
      "--hide-scrollbars",
    ],
  },
  "NEW (chromium channel + d3d11)": launchOptions(),
};

for (const [label, opts] of Object.entries(configs)) {
  resources.browser = await chromium.launch(opts);
  const page = await resources.browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const info = await readGpuInfo(page);

  // Median frame time of the running scene, once it has settled.
  await page.goto(`${base}?shot=ground`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 180_000 });
  const frameMs = await page.evaluate(
    () =>
      new Promise((res) => {
        const t = [];
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          t.push(now - last);
          last = now;
          if (t.length < 90) requestAnimationFrame(tick);
          else {
            t.sort((a, b) => a - b);
            res(t[Math.floor(t.length / 2)]);
          }
        };
        requestAnimationFrame(tick);
      })
  );

  console.log(`\n${label}`);
  console.log(`  renderer      ${info.renderer}`);
  console.log(`  vendor        ${info.vendor}`);
  console.log(`  maxAnisotropy ${info.maxAnisotropy}`);
  console.log(`  median frame  ${frameMs.toFixed(2)} ms`);

  await page.close();
  await resources.browser.close();
  resources.browser = null;
}

await shutdown(0);
