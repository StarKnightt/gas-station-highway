#!/usr/bin/env node
/**
 * Ad-hoc single-frame probe used while tuning: renders one preset with an
 * arbitrary extra query string and reports the average canvas colour.
 * Same teardown contract as tools/shoot.mjs.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5112;
const shot = process.argv[2] ?? "lot";
const extra = process.argv[3] ?? "";
const out = process.argv[4] ?? path.join(ROOT, "shots", "_probe.png");

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`[probe] ${reason}`);
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

const { build, preview } = await import("vite");
const { chromium } = await import("playwright");
const { assertHardwareGpu, launchOptions } = await import("./gpu.mjs");

await build({ root: ROOT, logLevel: "silent" });
resources.server = await preview({
  root: ROOT,
  logLevel: "silent",
  preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
});
resources.browser = await chromium.launch(
  launchOptions({ allowSoftware: process.argv.includes("--allow-software") })
);
const page = await resources.browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await assertHardwareGpu(page, { tag: "probe", allowSoftware: process.argv.includes("--allow-software") });
page.on("pageerror", (e) => console.error("[probe] pageerror", e.message));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || t.startsWith("TEXSTAT")) console.log(`[probe] ${t}`);
});
await page.goto(`http://127.0.0.1:${PORT}/?shot=${shot}${extra}`, { waitUntil: "load" });
await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 120000 });
await page.screenshot({ path: out });
if (process.env.PROBE_SAMPLE) {
  const pts = process.env.PROBE_SAMPLE.split(";").map((s) => {
    const [label, u, v] = s.split(",");
    return [label, Number(u), Number(v)];
  });
  for (const [label, u, v] of pts) {
    const c = await page.evaluate(([uu, vv]) => window.__sample?.(uu, vv), [u, v]);
    console.log(`[probe] SAMPLE ${label.padEnd(12)} ${c}`);
  }
}
if (process.env.PROBE_CAM) {
  const info = await page.evaluate(() => {
    const g = window.__GAME;
    if (!g) return "no __game";
    const c = g.camera;
    const out = [];
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      out.push(
        `${o.name || o.type} vis=${o.visible} tris=${(o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3} bb=[${b.min.toArray().map((n) => n.toFixed(1))}]..[${b.max.toArray().map((n) => n.toFixed(1))}]`
      );
    });
    return JSON.stringify({ pos: c.position.toArray(), fov: c.fov }) + "\n  " + out.join("\n  ");
  });
  console.log("[probe] CAM " + info);
}
console.log(`[probe] wrote ${out}`);
await shutdown(0);
