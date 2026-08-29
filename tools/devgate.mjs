#!/usr/bin/env node
/**
 * `node tools/devgate.mjs`
 *
 * Loads the scene through a **vite dev server** and asserts the dev-only gates
 * pass.
 *
 * ## Why this has to exist
 *
 * `Game.start()` now ends with:
 *
 *     if (import.meta.env.DEV) auditSceneMapChannels(this.scene);
 *
 * and `auditSceneMapChannels` **throws** on the first texture slot whose format
 * or contents cannot supply the channel three's shader samples from it. That is
 * the right design — a `RedFormat` texture in an `alphaMap` slot fails by
 * producing a plausible frame, so a warning would be read past — but it means a
 * false positive takes the dev server down for every agent working in this repo.
 *
 * Every other harness here runs `vite build` + `preview`, where
 * `import.meta.env.DEV` is false. **So without this file, the gate is never
 * executed by anything except a human's browser**, and the first time anyone
 * finds out whether it passes is when it does not.
 *
 * That is the same shape as the fault this project keeps paying for: a check
 * that is present, correct, and never run. A gate nobody exercises is a landmine
 * with a comment on it.
 *
 * Exits non-zero if the scene fails to reach `__SCENE_READY`, if the gate
 * throws, or if the expected pass line is absent — because a silent pass is
 * indistinguishable from a gate that was compiled out.
 */

import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`[devgate] ${reason}`);
  for (const [label, fn] of [
    ["browser", async () => resources.browser && (await resources.browser.close())],
    ["dev server", async () => resources.server && (await resources.server.close())],
  ]) {
    try {
      await fn();
    } catch (err) {
      console.error(`[devgate] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  console.log((await portInUse(PORT)) ? `[devgate] !! port ${PORT} still held` : `[devgate] port ${PORT} clear`);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? e));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? e));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    setTimeout(() => done(false), 700);
  });
}

async function run() {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);

  // A dev server, not a preview of a build: that is the entire point, since the
  // gate is compiled out of a production bundle.
  resources.server = await createServer({
    root: ROOT,
    logLevel: "warn",
    server: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  await resources.server.listen();
  const base = `http://127.0.0.1:${PORT}/`;
  console.log(`[devgate] dev server on :${PORT}`);

  resources.browser = await chromium.launch(launchOptions({}));
  const page = await resources.browser.newPage({ viewport: { width: 1280, height: 720 } });

  const logs = [];
  const errors = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const gpu = await assertHardwareGpu(page, { tag: "devgate" });
  if (isSoftwareRenderer(gpu?.renderer)) throw new Error(`software renderer: ${gpu?.renderer}`);

  let ready = true;
  try {
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 300_000 });
  } catch {
    ready = false;
  }

  const gateLine = logs.find((l) => l.includes("[game] map-channel audit passed"));
  const gateThrow = [...errors, ...logs].find((l) => l.includes("[map-channel]"));

  console.log(`\n====== dev gate ======`);
  console.log(`  scene ready            ${ready}`);
  console.log(`  map-channel gate ran   ${gateLine ? "yes" : "NO"}`);
  if (gateLine) console.log(`  ${gateLine}`);
  if (gateThrow) console.log(`  !! gate reported: ${gateThrow.slice(0, 400)}`);
  const otherErrors = errors.filter((e) => !e.includes("[map-channel]"));
  if (otherErrors.length) {
    console.log(`  other page errors      ${otherErrors.length}`);
    for (const e of otherErrors.slice(0, 5)) console.log(`    ${e.slice(0, 180)}`);
  }
  console.log(`======================`);

  if (gateThrow) throw new Error("the map-channel gate found a broken slot; see above");
  if (!ready) throw new Error("the scene never reached __SCENE_READY under a dev server");
  // A silent pass and a gate that was compiled out look identical, so the pass
  // line is required rather than merely welcome.
  if (!gateLine) throw new Error("the map-channel gate did not run: its pass line is absent from the console");

  await page.close();
}

await run().then(
  () => shutdown(0),
  (err) => shutdown(1, err?.stack ?? String(err))
);
