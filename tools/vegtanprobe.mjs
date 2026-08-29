#!/usr/bin/env node
/**
 * Judge P2 — the warm-patch constants — on a frame, which is the only way it
 * could be judged.
 *
 * The user's complaint was "saturated orange patches scattered through the
 * green ... patches of a different colour, not light passing through needles".
 * Off-card analysis of their screenshot split that into two populations:
 * fine-grained warm variation inside a shoot, sub-card at a 6.8 px
 * autocorrelation half-length, and **22 card-scale regions carrying 52% of all
 * tan area**, which are whole dead cards standing inside a live whorl. The eye
 * took the salient large patches; the autocorrelation took the dominant fine
 * variation. Both readings were right about different things.
 *
 * So P2 cuts one constant per population: the dead-card rate inside a live
 * whorl (0.07 -> 0.03) and the browned-needle rate inside a live shoot
 * (0.08 -> 0.05). Neither goes to zero, because some dead needles low in a live
 * crown are correct and a crown with none reads as plastic.
 *
 * Both constants ship, so the control arm is the one that has to be built:
 * this patches the two literals back to their old values, builds a second
 * bundle, and restores the source. **The restore runs in the shutdown handler**,
 * so a crash or a Ctrl-C does not leave the tree modified — check `git status`
 * anyway.
 *
 *   node tools/vegtanprobe.mjs
 *   node tools/vegtanprobe.mjs --no-build     reuse both bundles
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { assertHardwareGpu, assertSceneGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "capture-vegtan-0829");
const PORT = 5233;
const WIDTH = 1600;
const HEIGHT = 900;
const TICKS = 30;
/**
 * 90 s was not enough. The page sits on "compiling shaders for your graphics
 * card" with no error and no progress in the console, because this harness
 * builds a fresh bundle per arm and a cold browser has no shader cache to hit.
 * The sibling probe got away with 90 s only because it paid the compile once
 * across six arms on one browser; both fixes are applied here.
 */
const READY_TIMEOUT_MS = 300_000;
const DO_BUILD = !process.argv.includes("--no-build");

/**
 * The control: the two literals as they shipped this afternoon. Patched in,
 * built, and reverted. Written as exact single-occurrence strings so a failed
 * match throws rather than silently building the wrong arm — a control that
 * quietly equals its own treatment is the worst outcome available here.
 */
const PATCHES = [
  {
    file: "src/gen/vegPine.ts",
    now: "dead: !live || rng() < 0.03 });",
    was: "dead: !live || rng() < 0.07 });",
  },
  {
    file: "src/gen/vegTextures.ts",
    now: "const browning = dead ? 0.92 : 0.05;",
    was: "const browning = dead ? 0.92 : 0.08;",
  },
];

const ARMS = [
  { id: "A-p2", dir: ".vegtan-p2", label: "P2 landed (0.03 / 0.05)", patch: false },
  { id: "B-old", dir: ".vegtan-old", label: "control, as shipped (0.07 / 0.08)", patch: true },
];

/**
 * Registered before a pixel is read.
 *
 * The first three are the effect and the fourth is the guard. P2 is a colour
 * change, but the dead shoot texture is not the live one — it draws three
 * sub-shoots where the live card draws four — so moving cards between the two
 * populations does move the silhouette slightly. The guard is therefore a bound
 * rather than an identity, and it is stated as one.
 */
const PREDICTIONS = [
  {
    id: "T1",
    why: "total tan area in the crown must fall — both constants only ever add warm pixels",
    test: (m) => m["A-p2"].tanFrac < m["B-old"].tanFrac,
  },
  {
    id: "T2",
    why: "card-scale tan regions must fall by more than a third: the dead-card rate drops 0.07 -> 0.03",
    test: (m) => m["A-p2"].bigCount < m["B-old"].bigCount * 0.67,
  },
  {
    id: "T3",
    why: "the card-scale share of tan area must fall — that population is cut harder than the sub-card one",
    test: (m) => m["A-p2"].bigShare < m["B-old"].bigShare,
  },
  {
    id: "T4",
    why: "the guard: crown coverage must move less than 1 point, or this stopped being a colour change",
    test: (m) => Math.abs(m["A-p2"].cov - m["B-old"].cov) < 0.01,
  },
];

/* ------------------------------------------------------------------ */
/* teardown, including the source restore                              */
/* ------------------------------------------------------------------ */

let server = null;
let browser = null;
let shuttingDown = false;
let patched = false;

function applyPatch(on) {
  for (const p of PATCHES) {
    const f = path.join(ROOT, p.file);
    const src = fsSync.readFileSync(f, "utf8");
    const from = on ? p.now : p.was;
    const to = on ? p.was : p.now;
    if (!src.includes(from)) {
      if (src.includes(to)) continue;
      throw new Error(`vegtan: ${p.file} contains neither literal — refusing to guess`);
    }
    if (src.split(from).length > 2) throw new Error(`vegtan: ${p.file} literal is not unique`);
    fsSync.writeFileSync(f, src.replace(from, to));
  }
  patched = on;
}

function shutdown(code, message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (message) console.error(`[vegtan] ${message}`);
  // Source first: a modified working tree outlives this process and everything
  // else here is disposable.
  if (patched) {
    try {
      applyPatch(false);
      console.error("[vegtan] source restored");
    } catch (e) {
      console.error(`[vegtan] SOURCE NOT RESTORED — fix by hand: ${e?.message ?? e}`);
    }
  }
  try {
    if (browser) browser.close();
  } catch {
    /* already gone */
  }
  // /T first, while the tree still exists: server.kill() reaps the shell and
  // orphans the vite process under it.
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

/** The near crown, projected from the pine's own cylinder. See vegdampprobe. */
const CROWN = { x0: 644, y0: 232, x1: 966, y1: 900 };
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const at = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const isSky = (p) => p[2] >= p[1] - 4 && lum(...p) > 90;
/**
 * Tan: warm enough that red leads green and green leads blue by a clear margin.
 * Deliberately strict — a loose warm test picks up every sunlit needle tip and
 * then measures the backlight, which is the thing that is supposed to be there.
 */
const isTan = (p) => p[0] > p[1] + 10 && p[1] > p[2] + 12 && lum(...p) > 55;

/** One card is ~22 px across, so ~200 px of area is the card-scale threshold. */
const CARD_AREA = 200;

function tanStats(img) {
  const w = CROWN.x1 - CROWN.x0;
  const h = CROWN.y1 - CROWN.y0;
  const fol = new Uint8Array(w * h);
  const tan = new Uint8Array(w * h);
  let nFol = 0;
  let nTan = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = at(img, CROWN.x0 + x, CROWN.y0 + y);
      if (isSky(p)) continue;
      fol[y * w + x] = 1;
      nFol++;
      if (isTan(p)) {
        tan[y * w + x] = 1;
        nTan++;
      }
    }
  // Connected components over the tan mask, so "22 card-scale regions carrying
  // 52% of tan area" is measured the same way here as it was on the user's crop.
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !tan[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % w;
      for (const d of [1, -1, w, -w]) {
        const j = i + d;
        if (j < 0 || j >= w * h || seen[j] || !tan[j]) continue;
        if (Math.abs(d) === 1 && (j % w) - x !== d) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    comps.push(n);
  }
  comps.sort((a, b) => b - a);
  const big = comps.filter((n) => n >= CARD_AREA);
  return {
    cov: nFol / (w * h),
    tanFrac: nFol ? nTan / nFol : 0,
    regions: comps.length,
    bigCount: big.length,
    bigShare: nTan ? big.reduce((a, b) => a + b, 0) / nTan : 0,
    largest: comps[0] ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    for (const arm of ARMS) {
      if (arm.patch) applyPatch(true);
      console.log(`[vegtan] building ${arm.id} (${arm.label})`);
      const r = spawnSync("npx", ["vite", "build", "--outDir", arm.dir, "--emptyOutDir"], {
        cwd: ROOT,
        stdio: "inherit",
        shell: true,
      });
      if (arm.patch) applyPatch(false);
      if (r.status !== 0) shutdown(1, `build failed for ${arm.id}`);
    }
  }

  const frames = new Map();
  const problems = [];

  // One browser for both arms, so the second pays a warm shader cache.
  browser = await chromium.launch(launchOptions());
  {
    const probe = await browser.newPage();
    await assertHardwareGpu(probe, { tag: "vegtan" });
    await probe.close();
  }

  for (const arm of ARMS) {
    server = spawn("npx", ["vite", "preview", "--outDir", arm.dir, "--port", String(PORT), "--strictPort"], {
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

    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on("pageerror", (e) => problems.push(`${arm.id}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${arm.id}: ${m.text()}`);
    });
    const url = `${base}?shot=crown`;
    await page.goto(url, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch {
      const said = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []).catch(() => []);
      const flag = await page
        .evaluate(() => ({
          ready: window.__SCENE_READY ?? null,
          veg: window.__VEGETATION ? "present" : "absent",
          canvases: document.querySelectorAll("canvas").length,
          body: (document.body?.innerText ?? "").slice(0, 300),
        }))
        .catch((e) => ({ evalFailed: String(e) }));
      shutdown(
        1,
        `${arm.id} never became ready.\n  state: ${JSON.stringify(flag)}\n  __SYSTEM_ERRORS: ${said.join(
          " | "
        )}\n  console/pageerror:\n    ${problems.join("\n    ") || "(none)"}`
      );
    }
    await assertSceneGpu(page, { tag: `vegtan/${arm.id}` });
    await page.evaluate(
      (n) =>
        new Promise((res) => {
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
    console.log(`[vegtan] ${arm.id.padEnd(7)} ${arm.label.padEnd(34)} ${url}`);
    await page.close();
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", shell: false });
    try {
      server.kill();
    } catch {
      /* already gone */
    }
    server = null;
  }

  await browser.close();
  browser = null;

  const M = {};
  for (const arm of ARMS) M[arm.id] = tanStats(await readPng(frames.get(arm.id).file));

  console.log(`\ncrown region ${CROWN.x1 - CROWN.x0}x${CROWN.y1 - CROWN.y0} px, card-scale threshold ${CARD_AREA} px\n`);
  console.log("                              control (0.07/0.08)   P2 (0.03/0.05)      delta");
  const row = (label, k, fmt) =>
    console.log(
      `  ${label.padEnd(28)} ${fmt(M["B-old"][k]).padStart(17)}   ${fmt(M["A-p2"][k]).padStart(14)}   ${fmt(
        M["A-p2"][k] - M["B-old"][k]
      ).padStart(8)}`
    );
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const num = (v) => String(Math.round(v));
  row("crown coverage", "cov", pct);
  row("tan share of foliage", "tanFrac", pct);
  row("tan regions", "regions", num);
  row("card-scale regions", "bigCount", num);
  row("their share of tan area", "bigShare", pct);
  row("largest region, px", "largest", num);

  console.log("");
  let failed = 0;
  for (const p of PREDICTIONS) {
    const ok = p.test(M);
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${p.id}  ${p.why}`);
  }
  for (const arm of ARMS) {
    const r = frames.get(arm.id).report;
    if (r) console.log(`\n  ${arm.id}: ${r.foliageCards} pine cards, ${r.drawCalls} draw calls, ${r.triangles} triangles`);
  }
  if (problems.length) {
    console.log("\npage problems:");
    for (const p of problems) console.log(`  ${p}`);
  }
  console.log(`\nframes in ${path.relative(ROOT, OUT_DIR)}/`);
  shutdown(failed ? 1 : 0, failed ? `${failed} prediction(s) failed` : null);
}

main().catch((e) => shutdown(1, `${e?.stack ?? e}`));
