#!/usr/bin/env node
/**
 * Measures `makeAsphalt`'s generated buffer for periodicity, in a browser.
 *
 * `mapspectrum.mjs` cannot do this from Node, because `makeAsphalt` draws its
 * cracks through a DOM canvas. It refuses rather than returning a null, which is
 * the only reason that limitation was trustworthy instead of being mistaken for
 * a clean result. This tool removes the limitation the obvious way: the capture
 * harness is already a browser, so generate the map there and bring the buffer
 * back.
 *
 * The analysis is imported from `mapspectrum.mjs` rather than reimplemented. Two
 * implementations of one measurement is the defect this project keeps finding in
 * other guises, and it would be absurd to introduce it here.
 *
 * Ports: 5132, which is Terrain's second. Nothing is rendered, so there is no
 * GPU assertion — this measures a CPU-generated buffer and the browser is only
 * here for `document`.
 *
 * Usage: node tools/asphaltscan.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { report } from "./mapspectrum.mjs";

const PORT = 5132;
const SIZE = 2048;
const TILE = 8;
const SEED = 1337;

/** The arms. Each one forces a term off; the default must differ from them all. */
const ARMS = [
  ["default", {}],
  ["fineHeight=0 (aggFine out of height, kept in albedo)", { fineHeight: 0 }],
  ["microHeight=0 (micro fbm out of height)", { microHeight: 0 }],
  ["both=0", { fineHeight: 0, microHeight: 0 }],
];

let server;
let browser;
try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { port: PORT, strictPort: true },
    logLevel: "warn",
  });
  await server.listen();
  console.log(`[asphaltscan] dev server on :${PORT}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    throw new Error(`page error: ${e.message}`);
  });
  await page.goto(`http://localhost:${PORT}/tools/asphaltprobe.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__probeReady === true", null, { timeout: 60000 });

  for (const [label, options] of ARMS) {
    const res = await page.evaluate(
      (a) => window.__probe(a),
      { size: SIZE, tile: TILE, seed: SEED, options, channels: ["heightMap"] }
    );
    const bytes = res.heightMap;
    if (bytes.length !== SIZE * SIZE) throw new Error(`expected ${SIZE * SIZE} texels, got ${bytes.length}`);
    const f = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < f.length; i++) f[i] = bytes[i] / 255;

    let min = 1;
    let max = 0;
    let mean = 0;
    for (let i = 0; i < f.length; i++) {
      if (f[i] < min) min = f[i];
      if (f[i] > max) max = f[i];
      mean += f[i];
    }
    mean /= f.length;
    // An arm that does not move the buffer is a control that cannot fail, which
    // is worse than no control. Reported so a null result is attributable.
    console.log(`--- ${label}`);
    console.log(`  buffer: min ${min.toFixed(4)} max ${max.toFixed(4)} mean ${mean.toFixed(4)}`);
    report(`  asphalt height [${label}]`, f, SIZE, TILE, 24);
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  console.log("[asphaltscan] torn down");
}
