#!/usr/bin/env node
/**
 * Asks what the site overlay actually says about a named patch of ground.
 *
 * Written because "the forecourt reads clean" has two completely different
 * causes with the same appearance, and guessing between them is how a round gets
 * spent painting detail that was already there:
 *
 *   upstream   - the overlay never authored anything on the forecourt, so the
 *                shader is faithfully rendering an absence
 *   downstream - the overlay authored it and the material is dropping it, in
 *                which case painting more of it changes nothing
 *
 * One byte-level look at the map settles it, with no rendering involved. This is
 * the same discipline that caught the empty-uniforms texture loop: check the
 * input before auditing the consumer.
 *
 * Channel meanings, from `siteOverlay.ts`:
 *   R = albedo multiplier, x2, so 128 is neutral and lower is darker
 *   G = roughness offset,  x1.15, 128 neutral
 *   B = blend toward the dark oil / tar tint, 0 is none
 *   A = dirt-wash coverage
 *
 * Ports: 5132, Terrain's second. Nothing renders, so no GPU assertion.
 *
 * Usage: node tools/overlayscan.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const PORT = 5132;

/**
 * Regions to compare, in world XZ.
 *
 * The point of listing several is that a single region has no scale. "Mean B is
 * 12" means nothing; "mean B is 12 on the forecourt and 41 on the fuelling lane
 * two metres away" is a finding. Bounds come from `site.ts`: FORECOURT is
 * x +/-11.6 by z 12.4..27.2 and the islands are at z 16.6 and 23.2.
 */
const REGIONS = [
  ["forecourt, whole", { minX: -11.6, maxX: 11.6, minZ: 12.4, maxZ: 27.2 }],
  ["forecourt, walk_store foreground", { minX: 0, maxX: 8, minZ: 18, maxZ: 26 }],
  ["island 1 stance, south side", { minX: -4.5, maxX: 4.5, minZ: 14.2, maxZ: 15.1 }],
  ["island 2 stance, south side", { minX: -4.5, maxX: 4.5, minZ: 20.8, maxZ: 21.7 }],
  ["between the islands", { minX: -4.5, maxX: 4.5, minZ: 18.4, maxZ: 21.0 }],
  ["kerb line, forecourt east edge", { minX: 10.4, maxX: 11.6, minZ: 13.0, maxZ: 26.5 }],
  ["asphalt lot, parking row", { minX: -8, maxX: 8, minZ: 28.5, maxZ: 32.0 }],
  ["asphalt lot, open middle", { minX: 16, maxX: 30, minZ: 20, maxZ: 34 }],
  ["highway carriageway", { minX: -30, maxX: 30, minZ: 2.0, maxZ: 6.0 }],
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
  console.log(`[overlayscan] dev server on :${PORT}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    throw new Error(`page error: ${e.message}`);
  });
  await page.goto(`http://localhost:${PORT}/tools/overlayprobe.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__probeReady === true", null, { timeout: 120000 });

  const res = await page.evaluate(() => window.__probe());
  const { width, height, originX, originZ, sizeX, sizeZ } = res;
  const data = res.data;
  if (data.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes, got ${data.length}`);
  }
  const mmX = (1000 * sizeX) / width;
  console.log(
    `[overlayscan] ${width}x${height} over ${sizeX}x${sizeZ} m from (${originX}, ${originZ})` +
      `  = ${mmX.toFixed(1)} mm/texel`,
  );
  console.log("[overlayscan] R albedo x2 (128 neutral), G rough (128 neutral), B oil tint (0 none), A wash\n");

  const toPx = (x, z) => [
    Math.round(((x - originX) / sizeX) * width),
    Math.round(((z - originZ) / sizeZ) * height),
  ];

  const head = "region                            texels    R mean  R p05    B mean  B p95  B>16%    A mean";
  console.log(head);
  console.log("-".repeat(head.length));

  for (const [label, r] of REGIONS) {
    const [x0, z0] = toPx(r.minX, r.minZ);
    const [x1, z1] = toPx(r.maxX, r.maxZ);
    const R = [];
    const B = [];
    let aSum = 0;
    let n = 0;
    let bOver = 0;
    for (let y = Math.min(z0, z1); y < Math.max(z0, z1); y++) {
      for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        R.push(data[i]);
        B.push(data[i + 2]);
        aSum += data[i + 3];
        if (data[i + 2] > 16) bOver++;
        n++;
      }
    }
    // A region entirely outside the map would give a NaN mean and every
    // comparison against it would be false, which is how a zero-pixel result
    // passes for a clean one. Reject it explicitly.
    if (!n) {
      console.log(`${label.padEnd(33)} EMPTY - region outside the overlay, not measured`);
      continue;
    }
    R.sort((a, b) => a - b);
    B.sort((a, b) => a - b);
    const mean = (v) => v.reduce((s, q) => s + q, 0) / v.length;
    const pct = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    console.log(
      `${label.padEnd(33)} ${String(n).padStart(6)}  ` +
        `${mean(R).toFixed(1).padStart(6)}  ${String(pct(R, 0.05)).padStart(5)}   ` +
        `${mean(B).toFixed(1).padStart(6)}  ${String(pct(B, 0.95)).padStart(5)}  ` +
        `${((100 * bOver) / n).toFixed(1).padStart(5)}%  ` +
        `${(aSum / n).toFixed(1).padStart(6)}`,
    );
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  console.log("\n[overlayscan] torn down");
}
