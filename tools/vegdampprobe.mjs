#!/usr/bin/env node
/**
 * P1: is the minification damping mis-ranged, and does re-ranging it cost the
 * mid distance? One bundle, six loads, predictions registered before any pixel
 * is read.
 *
 *   node tools/vegdampprobe.mjs                # build, capture, write capture-vegdamp-0829/
 *   node tools/vegdampprobe.mjs --no-build     # reuse .shot-build/vegdamp
 *
 * ## What is being separated
 *
 * The damping was landed this afternoon against mid-distance scrub breaking
 * into sky-speckle, and it fixed that: 5.00% of the frame moved. It was landed
 * on the claim that it is "the identity at mip 0, so the foreground provably
 * cannot move", which is true of the expression and false of this scene. A
 * 512-texel texture on a 0.30 m pine shoot is 1707 texels per metre, so a crown
 * eight metres away samples at 23 texels per pixel and a ramp saturating at 9.2
 * is at full strength on every pine card at every playable distance. Identity
 * needs a card projecting to 294 px, which is a camera half a metre from it.
 *
 * The claim was verified on the `ground` pose's bottom rows, which are *grass*
 * cards at a completely different sampling rate. A constant fitted on one
 * population and checked against that same population is not a constant, it is
 * an untested assumption wearing one.
 *
 * Tabulating the sampling rate per layer (tmp/ramprate.mjs) says something
 * sharper than "saturated in the near field": **the ramp never ramps.** Under
 * (0.8, 2.4) every foliage layer is at vegFar 1.000 from eight metres out, and
 * even scrub at 8 m is 0.829. The mip-driven design is inert and what shipped is
 * an unconditional alpha dilation with a distance term that never engages. The
 * one place it is genuinely zero is scrub within about two metres of the camera
 * — which is exactly the band the original verification looked at.
 *
 * It also says a single global ramp cannot be fixed. Pine carries 512 texels on
 * a 0.30 m shoot, 1707 per metre; scrub carries 256 on a 0.35 m card, 731 per
 * metre. So a pine crown at 14 m samples at 4.82 stops and scrub at 40 m at
 * 5.11 — the near thing and the far thing are 0.29 stops apart, and no onset and
 * width can put one at zero and the other at one. The layers need their own
 * constants.
 *
 * Hence the arms: `?vegramp=` re-ranges **pine only**, to (5.2, 2.0), which is
 * zero below 36.8 texels per pixel — zero at the crown and at the pose the user
 * complained from, engaging beyond about 18 m and full by 90 m. Mid-storey and
 * scrub are untouched, so the guard measures what the pine change alone costs
 * the mid distance.
 *
 * ## The statistic, and why not coverage
 *
 * Coverage is the quantity that did not fail. Reducing the authored card to the
 * rate the screen samples it at moves coverage 34.2% -> 39.3% while boundary
 * falls to 12% of authored: the card keeps its green and loses its shape. Every
 * foliage metric this project has used was a coverage metric, which is why none
 * of them ever objected.
 *
 * So the crown statistic here is **fragmentation**: the boundary of the
 * sky/foliage mask, placed on a scale whose ends are fixed at the same coverage
 * and the same grid — a single compact lump at one end, independently scattered
 * cells at the other. It needs no threshold beyond the alpha test already
 * shipped, and it is the quantitative form of "discrete chunky blobs".
 *
 * Teardown contract (repo-wide rule): server and browser are registered with
 * one shutdown routine wired to every exit path before either is started.
 * `taskkill /T` runs FIRST, while the process tree still exists — `server.kill()`
 * orphans the vite process under the shell.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { assertHardwareGpu, assertSceneGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1600;
const HEIGHT = 900;
const PORT = 5171;
const BUILD_DIR = ".shot-build/vegdamp";
const OUT_DIR = path.join(ROOT, "capture-vegdamp-0829");
const READY_TIMEOUT_MS = 180_000;
const TICKS = 8;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");

/**
 * (5.2, 2.0) has since landed as `DAMP_RAMP_PINE`, so the *default* arms below
 * are now the re-ranged ones and `?vegramp=0.8,2.4` is the arm that restores
 * the old scrub-fitted behaviour. The labels are written that way round. Left
 * as an explicit constant so the pair can be swept again without editing three
 * strings, and so re-running this tool measures against what actually ships.
 */
const OLD_RAMP = "0.8,2.4";

const ARMS = [
  // The crown pose: ground level under the west pines, backlit, which is where
  // the complaint was made and where no previous foliage measurement was taken.
  { id: "C-ship", shot: "crown", query: "", label: "crown, shipping (pine re-ranged)" },
  { id: "C-off", shot: "crown", query: "vegdamp=0", label: "crown, damping off" },
  { id: "C-ramp", shot: "crown", query: `vegramp=${OLD_RAMP}`, label: "crown, old scrub ramp" },
  // The guard. `ground` rather than `approach` because the 5.00% the damping was
  // landed on was measured on `ground`, and a guard against a different pose
  // than the one that produced the number is not a guard.
  { id: "G-ship", shot: "ground", query: "", label: "ground, shipping (pine re-ranged)" },
  { id: "G-off", shot: "ground", query: "vegdamp=0", label: "ground, damping off" },
  { id: "G-ramp", shot: "ground", query: `vegramp=${OLD_RAMP}`, label: "ground, old scrub ramp" },
];

/**
 * Registered before a pixel is read.
 *
 * Written as directions and bounds rather than as point values, because the
 * CPU model predicts the card's own alpha and the frame carries overlap between
 * cards, self-shadowing and the tone curve on top of it. A prediction that only
 * survives if the frame matches a texture measurement to two figures is a
 * prediction about the model, not about the scene.
 */
const PREDICTIONS = [
  {
    id: "P1",
    why: "damping off must raise crown fragmentation — the CPU model says 2% -> 6% on the card's own alpha",
    test: (m) => m["C-off"].frag > m["C-ship"].frag,
  },
  {
    id: "P2",
    why: "damping off must lower crown coverage — dilation adds solidity, 43.6% -> 39.3% on the card",
    test: (m) => m["C-off"].cov < m["C-ship"].cov,
  },
  {
    id: "P3",
    why: "the re-ranged ramp must land on the off side of shipping in the crown: it is designed to be zero at 23 texels/px",
    test: (m) => m["C-ramp"].frag > m["C-ship"].frag,
  },
  {
    id: "P4",
    why: "the guard: the re-ranged ramp must NOT move the mid-distance sky-gap fraction as far as switching the damping off does",
    test: (m) => Math.abs(m["G-ramp"].gap - m["G-ship"].gap) < Math.abs(m["G-off"].gap - m["G-ship"].gap),
  },
  {
    id: "P5",
    why: "switching the damping off must cost the mid distance — otherwise the change it was landed for was never doing anything",
    test: (m) => m["G-off"].gap > m["G-ship"].gap,
  },
];

/* ------------------------------------------------------------------ */
/* teardown                                                            */
/* ------------------------------------------------------------------ */

let server = null;
let browser = null;
let shuttingDown = false;

function shutdown(code, message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (message) console.error(`[vegdamp] ${message}`);
  try {
    if (browser) browser.close();
  } catch {
    /* already gone */
  }
  // /T first, while the tree still exists. `server.kill()` reaps the shell and
  // orphans the vite process under it, which is how this harness lost a port to
  // TIME_WAIT twice before the ordering was written down.
  if (server?.pid) {
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", shell: false });
    try {
      server.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(130, `signal ${sig}`));
process.on("uncaughtException", (e) => shutdown(1, `uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => shutdown(1, `unhandled rejection: ${e?.stack ?? e}`));

/* ------------------------------------------------------------------ */
/* measurement                                                         */
/* ------------------------------------------------------------------ */

const readPng = async (p) => PNG.sync.read(await fs.readFile(p));

/**
 * The near crown, in the `crown` pose.
 *
 * Derived from the plant's own geometry by projecting its crown cylinder
 * through the pose's camera (tmp/crownbox.mjs), not drawn round where the green
 * appears. The arms change how much green there is, so a region that follows
 * the foliage cannot measure the foliage — and three false conclusions on this
 * project have come from boxes placed by eye. The 13 m pine at (-33, 10),
 * 14 m away, projects to x 644..966, y 232..1016; clipped to the frame bottom.
 */
const CROWN = { x0: 644, y0: 232, x1: 966, y1: 900 };
/** Mid-distance band in the `ground` pose — the rows the 5.00% was measured in. */
const MID = { x0: 0, y0: 300, x1: WIDTH, y1: 520 };

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Sky is B-heavy relative to G and bright; foliage is neither. */
const isSky = (p) => p[2] >= p[1] - 4 && lum(...p) > 90;

function perim(m, w, h) {
  let p = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !m[ny * w + nx]) p++;
      }
    }
  return p;
}

/**
 * Crown fragmentation, on a scale with both ends fixed at this arm's own
 * coverage and grid: 0% is one compact lump, 100% is independently scattered.
 */
function crownStats(img) {
  const w = CROWN.x1 - CROWN.x0;
  const h = CROWN.y1 - CROWN.y0;
  const m = new Uint8Array(w * h);
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!isSky(px(img, CROWN.x0 + x, CROWN.y0 + y))) {
        m[y * w + x] = 1;
        n++;
      }
    }
  const p = perim(m, w, h);

  // compact: the n cells nearest the region's centroid.
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push([(x - w / 2) ** 2 + (y - h / 2) ** 2, y * w + x]);
  cells.sort((a, b) => a[0] - b[0]);
  const cm = new Uint8Array(w * h);
  for (let i = 0; i < n; i++) cm[cells[i][1]] = 1;
  const cp = perim(cm, w, h);

  // random: same count, independently placed, one trial is enough at this size.
  const rm = new Uint8Array(w * h);
  let placed = 0;
  let s = 20260829;
  while (placed < n) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const i = s % (w * h);
    if (!rm[i]) {
      rm[i] = 1;
      placed++;
    }
  }
  const rp = perim(rm, w, h);

  return { cov: n / (w * h), frag: (p - cp) / (rp - cp), perim: p, compact: cp, random: rp };
}

/**
 * Mid-distance sky-gap fraction: how much of the treeline band is bright sky
 * showing between cards rather than foliage. This is the quantity the damping
 * was landed to reduce, stated directly rather than as a pixel-diff count.
 */
function midStats(img) {
  let sky = 0;
  let total = 0;
  for (let y = MID.y0; y < MID.y1; y++)
    for (let x = MID.x0; x < MID.x1; x++) {
      total++;
      if (isSky(px(img, x, y))) sky++;
    }
  return { gap: sky / total };
}

function diff(a, b) {
  let n = 0;
  let peak = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d) n++;
    if (d > peak) peak = d;
  }
  return { pixels: n, peak };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    console.log("[vegdamp] building");
    const r = spawnSync("npx", ["vite", "build", "--outDir", BUILD_DIR, "--emptyOutDir"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    if (r.status !== 0) shutdown(1, "build failed");
  }

  server = spawn("npx", ["vite", "preview", "--outDir", BUILD_DIR, "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    shell: true,
  });
  let serverErr = "";
  server.stderr?.on("data", (d) => {
    serverErr += d.toString();
    if (/EADDRINUSE|Port .* is already in use/i.test(serverErr)) shutdown(1, `port ${PORT} busy:\n${serverErr}`);
  });
  const base = `http://localhost:${PORT}/`;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(base);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) shutdown(1, `preview server never came up on ${PORT}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  browser = await chromium.launch(launchOptions());
  const probe = await browser.newPage();
  await assertHardwareGpu(probe, { tag: "vegdamp" });
  await probe.close();

  const frames = new Map();
  const problems = [];

  for (const arm of ARMS) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on("pageerror", (e) => problems.push(`${arm.id}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${arm.id}: ${m.text()}`);
    });

    const url = `${base}?shot=${arm.shot}${arm.query ? "&" + arm.query : ""}`;
    await page.goto(url, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch {
      const said = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []).catch(() => []);
      shutdown(1, `${arm.id} never became ready. Page said:\n    ${said.join("\n    ")}`);
    }
    await assertSceneGpu(page, { tag: `vegdamp/${arm.id}` });
    await page.evaluate(
      (n) => new Promise((res) => {
        let i = 0;
        const step = () => (++i >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
      TICKS
    );

    const report = await page.evaluate(() => window.__VEGETATION ?? null);
    const file = path.join(OUT_DIR, `${arm.id}.png`);
    await page.screenshot({ path: file, type: "png" });
    frames.set(arm.id, { file, report });
    console.log(`[vegdamp] ${arm.id.padEnd(8)} ${arm.label.padEnd(24)} ${url}`);
    await page.close();
  }

  /* -------- measure -------- */
  const M = {};
  for (const arm of ARMS) {
    const img = await readPng(frames.get(arm.id).file);
    M[arm.id] = arm.shot === "crown" ? crownStats(img) : midStats(img);
    M[arm.id].img = img;
  }

  console.log("\n[vegdamp] crown pose — the complaint frame");
  console.log("  arm       coverage   boundary   compact   random   fragmentation");
  for (const id of ["C-ship", "C-off", "C-ramp"]) {
    const m = M[id];
    console.log(
      `  ${id.padEnd(9)} ${(m.cov * 100).toFixed(1).padStart(7)}%   ${String(m.perim).padStart(7)}   ` +
        `${String(m.compact).padStart(7)}  ${String(m.random).padStart(7)}   ${(m.frag * 100).toFixed(1).padStart(6)}%`
    );
  }

  console.log("\n[vegdamp] ground pose — the mid-distance guard (sky showing between cards)");
  console.log("  arm       sky-gap fraction   delta vs shipping");
  for (const id of ["G-ship", "G-off", "G-ramp"]) {
    const m = M[id];
    const d = ((m.gap - M["G-ship"].gap) * 100).toFixed(3);
    console.log(`  ${id.padEnd(9)} ${(m.gap * 100).toFixed(3).padStart(14)}%   ${d.padStart(10)} pts`);
  }

  console.log("\n[vegdamp] whole-frame differences");
  for (const [a, b] of [
    ["C-ship", "C-off"],
    ["C-ship", "C-ramp"],
    ["G-ship", "G-off"],
    ["G-ship", "G-ramp"],
  ]) {
    const d = diff(M[a].img, M[b].img);
    console.log(
      `  ${a} vs ${b.padEnd(8)} ${String(d.pixels).padStart(8)} px ` +
        `(${((d.pixels / (WIDTH * HEIGHT)) * 100).toFixed(2)}% of frame), peak ${d.peak}`
    );
  }

  console.log("\n[vegdamp] registered predictions");
  let failed = 0;
  for (const p of PREDICTIONS) {
    let ok = false;
    try {
      ok = p.test(M);
    } catch (e) {
      ok = false;
    }
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${p.id}  ${p.why}`);
  }

  const r = frames.get("C-ramp").report;
  if (r) console.log(`\n[vegdamp] re-ranged arm reported dampRampPine=${JSON.stringify(r.dampRampPine)} dampGain=${r.dampGain}`);

  if (problems.length) console.error(`\n[vegdamp] page problems:\n  ${problems.join("\n  ")}`);
  console.log(`\n[vegdamp] ${OUT_DIR}`);
  shutdown(failed ? 1 : 0);
}

main().catch((e) => shutdown(1, e?.stack ?? String(e)));
