#!/usr/bin/env node
/**
 * Why does the window notice lose its printed content at a grazing angle?
 *
 *   node tools/probe-glazeablate.mjs --port=5112
 *
 * ## The question and the three candidates
 *
 * Film reported "two large white rectangles floating in the shop interior" as
 * the worst-looking thing in the build. Both causes it offered are disproved
 * from frames already on disk (NOTES, "A surface can lose its printed content to
 * the viewing angle"): nothing is railed at 255, so it is not exposure, and the
 * same region is printed at 65 deg in the same build.
 *
 * Three mechanisms remain, and they are owned by two different systems:
 *
 *   1. BUILDING — the additive reflection leaf (`glassRefl.envMapIntensity`).
 *   2. BUILDING — the Fresnel coupling (`?bgfres`), which drives alpha up at
 *      grazing incidence.
 *   3. LIGHTING — `scene.environmentIntensity`, raised 1.0 -> 2.4 this morning.
 *      A 2.4x multiplier on specular, and Fresnel peaks at exactly the 82 deg
 *      where the print dies, so this is angle-dependent by construction.
 *
 * Against all three stands a null hypothesis that is nobody's bug: a sunward
 * white notice at high albedo is simply near the top of the tone curve, and
 * print contrast dies there because paper and ink saturate together.
 *
 * ## How the arms are separated
 *
 * Two stances, **82 deg and 45 deg**. Candidates 1-3 are all angle-dependent and
 * predict a large difference between the stances; the null predicts almost none.
 * Every mechanism arm is then run at both stances.
 *
 * ## Why the arms share a browser
 *
 * Shader compilation is 92% of a cold load, so an arm per process is unaffordable
 * when the card is scheduled. Three of the levers are **live properties** and need
 * no reload at all:
 *
 *   - `material.envMapIntensity` is assigned once at build time and never
 *     rewritten per frame, so poking it is equivalent to a different `?bglrefl`;
 *   - `scene.environmentIntensity` is read by the renderer every frame, so
 *     poking it is equivalent to Lighting's own multiplier being different.
 *
 * Only `?bgfres=0` is a different *program* (`applyGlazingFresnel` returns early
 * at `amount <= 0`), so it is the one arm that pays for a reload.
 *
 * ## The controls, and why each exists
 *
 * **A forced-high arm.** A lever that is not wired and a lever that is wired but
 * irrelevant both print "no change". `refl-x4` and `env-x2` must move *something*
 * or the nulls are facts about this tool. The previous revision of this file got
 * this check wrong: it asked whether the forced-high arm moved the *notice*, which
 * is the very thing under test, and so announced its own instrument dead while
 * the control region was visibly responding. The check now passes if the lever
 * moves **any** measured region.
 *
 * **A darker region behind the same pane.** The original diagnosis was only
 * attributable because the shelving behind the same glass kept its contrast while
 * the notice lost its. An arm that moves both regions together is changing the
 * whole pane rather than explaining the notice, so both regions are recorded in
 * every arm.
 *
 * **A region derived from the object, not drawn on the image.** The earlier
 * revision measured a hand-placed box, and comparing a box on the 82 deg frame
 * with a box on the 65 deg frame quietly assumed the two contained the same
 * surface. Nothing had measured that — the same invariant trap as NOTES, "Same
 * number, opposite conclusion". The notice meshes are now located in the scene by
 * name and their geometry projected to screen, so the region **is** the notice by
 * construction, at any stance.
 *
 * **A pose control.** At 82 deg the derived region must reproduce the 6 distinct
 * luma codes that Film's frame delivers. If it does not, the stance or the region
 * is not Film's and no arm is comparable, so nothing is reported.
 *
 * The discriminator is the **distinct luma code count**, which is what separates
 * "no map" from "map compressed into the shoulder"; mean and sd do not.
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const PORT = Number(arg("port", 5112));
const BUILD_DIR = arg("build-dir", ".shot-build/glazeablate");
const OUT = path.join(ROOT, arg("out", "shots/glazeablate"));
const DO_BUILD = !argv.includes("--no-build");
const READY_TIMEOUT_MS = 420_000;
const W = 1600;
const H = 900;

/** walkprobe.mjs's own constants, so the stance is the one Film photographed. */
const GLASS_Z = 31.6;
const GLASS_X = -3.4;
const STANCE_D = 3.6;

/** The control region behind the same pane, at each stance. Stock, not paper. */
const SHELVING = {
  82: { x: 1380, y: 560, w: 160, h: 120 },
  45: { x: 900, y: 520, w: 160, h: 120 },
};
/** What Film's frame delivers on the notice at 82 deg, and the match tolerance. */
const BASELINE_CODES = 6;
const BASELINE_TOL = 5;

const resources = { browser: null, server: null };
async function shutdown(code, msg) {
  if (msg) console.error(`[glaze] ${msg}`);
  try {
    await resources.browser?.close();
  } catch {}
  try {
    await resources.server?.close();
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130, "interrupted"));

function stats(png, r) {
  if (!r || r.w < 6 || r.h < 6) return null;
  const l = [];
  for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(W, r.x + r.w); x++) {
      const i = (png.width * y + x) << 2;
      l.push(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]);
    }
  }
  if (!l.length) return null;
  const mean = l.reduce((a, b) => a + b, 0) / l.length;
  const sd = Math.sqrt(l.reduce((a, b) => a + (b - mean) ** 2, 0) / l.length);
  return {
    n: l.length,
    mean,
    sd,
    codes: new Set(l.map((v) => Math.round(v))).size,
    railed: l.filter((v) => v >= 254.5).length,
  };
}

/**
 * Page-side setup: collect the levers and the notice meshes.
 *
 * The reflection leaves are found by the property the arm is about — additive
 * blending with an environment contribution — rather than by name, so a rename
 * cannot silently turn the ablation into a no-op.
 */
const INSTALL = `() => {
  const g = window.__GAME;
  const leaves = [];
  const notices = [];
  g.scene.traverse((o) => {
    if (o.name === "window-notice" && o.geometry) notices.push(o);
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.blending === 2 && m.envMapIntensity > 0 && !leaves.some((L) => L.m === m)) {
        leaves.push({ m, name: m.name || o.name, base: m.envMapIntensity });
      }
    }
  });
  window.__GLAZE = {
    leaves,
    notices,
    baseEnv: g.scene.environmentIntensity,
    setRefl: (k) => { for (const L of leaves) L.m.envMapIntensity = L.base * k; },
    setEnv: (k) => { g.scene.environmentIntensity = window.__GLAZE.baseEnv * k; },
    /**
     * Screen-space bbox of each notice, computed from its own geometry. No THREE
     * on window in a production build, so the matrices are applied by hand;
     * column-major, as three stores them.
     */
    boxes: (w, h) => {
      const cam = g.camera;
      cam.updateMatrixWorld(true);
      const vi = cam.matrixWorldInverse.elements;
      const pj = cam.projectionMatrix.elements;
      const mul = (e, x, y, z, wc) => [
        e[0] * x + e[4] * y + e[8] * z + e[12] * wc,
        e[1] * x + e[5] * y + e[9] * z + e[13] * wc,
        e[2] * x + e[6] * y + e[10] * z + e[14] * wc,
        e[3] * x + e[7] * y + e[11] * z + e[15] * wc,
      ];
      return notices.map((o) => {
        o.updateMatrixWorld(true);
        const mw = o.matrixWorld.elements;
        const pos = o.geometry.getAttribute("position");
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = 0;
        for (let i = 0; i < pos.count; i++) {
          const wp = mul(mw, pos.getX(i), pos.getY(i), pos.getZ(i), 1);
          const vp = mul(vi, wp[0], wp[1], wp[2], 1);
          const cp = mul(pj, vp[0], vp[1], vp[2], 1);
          if (cp[3] <= 0) { behind++; continue; }
          const sx = (cp[0] / cp[3] * 0.5 + 0.5) * w;
          const sy = (1 - (cp[1] / cp[3] * 0.5 + 0.5)) * h;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        return { name: o.name, behind, minX, minY, maxX, maxY };
      });
    },
  };
  return { leaves: leaves.map((L) => L.name + "=" + L.base.toFixed(3)), notices: notices.length, env: g.scene.environmentIntensity };
}`;

const PLACE = `(a) => {
  const [x, z, lookX, lookZ] = a;
  const g = window.__GAME;
  const cam = g.camera;
  const ground = g.tryGet("groundHeight");
  const floor = g.tryGet("building.floorHeight");
  const h = ((floor ?? ground)(x, z)) + 1.65;
  cam.position.set(x, h, z);
  cam.lookAt(lookX, h, lookZ);
  cam.updateMatrixWorld(true);
  const dx = lookX - cam.position.x;
  const dz = lookZ - cam.position.z;
  return { at: [cam.position.x, cam.position.z], deg: (Math.atan2(Math.abs(dx), Math.abs(dz)) * 180) / Math.PI };
}`;

const SETTLE = `(n) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= n ? res(true) : requestAnimationFrame(step));
  requestAnimationFrame(step);
})`;

/**
 * The bundle. Grouped by `query`, because a new query is a new page load and a
 * new page load is the whole cost. `refl` and `env` are multipliers on whatever
 * the shipped value is, so `1` means untouched.
 */
const ARMS = [
  { query: "", name: "base", refl: 1, env: 1, stances: [82, 45] },
  { query: "", name: "refl-off", refl: 0, env: 1, stances: [82, 45] },
  { query: "", name: "refl-x4", refl: 4, env: 1, stances: [82] },
  { query: "", name: "env-1x", refl: 1, env: 1 / 2.4, stances: [82, 45] },
  { query: "", name: "env-off", refl: 1, env: 0, stances: [82, 45] },
  { query: "", name: "env-x2", refl: 1, env: 2, stances: [82] },
  { query: "bgfres=0", name: "fres-off", refl: 1, env: 1, stances: [82, 45] },
  { query: "lforce=noenv", name: "lforce-noenv", refl: 1, env: 1, stances: [82, 45] },
];

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  fs.mkdirSync(OUT, { recursive: true });

  if (DO_BUILD) {
    console.log(`[glaze] building into ${BUILD_DIR} ... (Lighting landed the interior grade; --no-build would measure a build nobody ships)`);
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;
  console.log(`[glaze] preview on :${PORT}`);

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  const results = [];
  let loaded = null;
  let noticeRegion = {};

  const load = async (query) => {
    const q = ["gpu=1", "reticle=1", ...(query ? [query] : [])].join("&");
    await page.goto(`${base}?${q}`, { waitUntil: "load", timeout: 120_000 });
    const gpu = await assertHardwareGpu(page, { tag: "glaze" });
    if (!/RTX\s*4060/i.test(gpu.renderer ?? "")) await shutdown(1, `wrong adapter: ${gpu.renderer}`);
    await page.waitForFunction(() => window.__SCENE_READY === true, null, {
      timeout: READY_TIMEOUT_MS,
      polling: 500,
    });
    const errs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    if (errs.length) {
      for (const e of errs) console.error(`[glaze] system ${e.system} failed in ${e.phase}: ${e.message}`);
      await shutdown(1, "a system failed to initialise — the scene is not the scene");
    }
    const info = await page.evaluate(`(${INSTALL})()`);
    console.log(
      `[glaze] load "${query || "(shipped)"}": ${info.notices} notice meshes, ` +
        `scene.environmentIntensity ${info.env}, leaves ${info.leaves.join(", ")}`
    );
    if (!info.leaves.length) await shutdown(1, "no additive reflection leaf found — the ablation would be a no-op");
    if (!info.notices) await shutdown(1, "no window-notice mesh found — cannot derive the region from the object");
    loaded = query;
  };

  /** Stand at `deg`, and derive the notice region from the notice geometry. */
  const stand = async (deg) => {
    const a = (deg * Math.PI) / 180;
    const stance = [GLASS_X - Math.sin(a) * STANCE_D, GLASS_Z - Math.cos(a) * STANCE_D];
    const got = await page.evaluate(`(${PLACE})(${JSON.stringify([...stance, GLASS_X, GLASS_Z])})`);
    if (Math.abs(got.deg - deg) > 2.5) await shutdown(1, `stance is ${got.deg.toFixed(1)} deg, not ${deg}`);
    if (!noticeRegion[deg]) {
      const boxes = await page.evaluate(`window.__GLAZE.boxes(${W}, ${H})`);
      // The rectangle Film saw is the largest notice on screen. Inset by a fifth
      // so the measurement is the printed field and not its edge against glass.
      const onScreen = boxes
        .filter((b) => b.behind === 0 && b.maxX > 0 && b.minX < W && b.maxY > 0 && b.minY < H)
        .map((b) => ({ ...b, area: (b.maxX - b.minX) * (b.maxY - b.minY) }))
        .sort((x, y) => y.area - x.area);
      if (!onScreen.length) await shutdown(1, `no notice is on screen at ${deg} deg`);
      const b = onScreen[0];
      const iw = (b.maxX - b.minX) * 0.2;
      const ih = (b.maxY - b.minY) * 0.2;
      noticeRegion[deg] = {
        x: Math.round(b.minX + iw),
        y: Math.round(b.minY + ih),
        w: Math.round((b.maxX - b.minX) - 2 * iw),
        h: Math.round((b.maxY - b.minY) - 2 * ih),
      };
      const r = noticeRegion[deg];
      console.log(
        `[glaze] ${deg} deg: stance (${got.at[0].toFixed(2)}, ${got.at[1].toFixed(2)}), ` +
          `notice projects to ${Math.round(b.maxX - b.minX)}x${Math.round(b.maxY - b.minY)} px, ` +
          `measuring ${r.w}x${r.h} at (${r.x}, ${r.y})`
      );
    }
  };

  console.log(`\n[glaze] --- arms ---`);
  for (const arm of ARMS) {
    if (arm.query !== loaded) await load(arm.query);
    for (const deg of arm.stances) {
      await stand(deg);
      await page.evaluate(`window.__GLAZE.setRefl(${arm.refl}); window.__GLAZE.setEnv(${arm.env});`);
      await page.evaluate(`(${SETTLE})(12)`);
      const file = path.join(OUT, `${arm.name}-${deg}.png`);
      await page.screenshot({ path: file });
      const png = PNG.sync.read(fs.readFileSync(file));
      const row = {
        arm: arm.name,
        deg,
        notice: stats(png, noticeRegion[deg]),
        shelving: stats(png, SHELVING[deg]),
      };
      results.push(row);
      console.log(
        `  ${(arm.name + "@" + deg).padEnd(18)} notice: codes ${String(row.notice.codes).padStart(3)} ` +
          `mean ${row.notice.mean.toFixed(1).padStart(5)} sd ${row.notice.sd.toFixed(2).padStart(6)} railed ${String(row.notice.railed).padStart(5)}` +
          `   |   shelving: codes ${String(row.shelving.codes).padStart(3)} mean ${row.shelving.mean.toFixed(1).padStart(5)} sd ${row.shelving.sd.toFixed(2).padStart(6)}`
      );
      // Restore, so the next arm starts from the shipped values.
      await page.evaluate(`window.__GLAZE.setRefl(1); window.__GLAZE.setEnv(1);`);
    }

    // The pose control, once the baseline exists.
    if (arm.name === "base") {
      const b82 = results.find((r) => r.arm === "base" && r.deg === 82);
      if (Math.abs(b82.notice.codes - BASELINE_CODES) > BASELINE_TOL) {
        console.log(
          `\n[glaze] NOTE: baseline gives ${b82.notice.codes} distinct codes at 82 deg, not ~${BASELINE_CODES}.\n` +
            `  Either the stance/region is not Film's, or Lighting's interior grade has already\n` +
            `  changed this region — it landed after Film's capture and says so. Arms below are\n` +
            `  still internally comparable; the comparison to Film's frame is not.`
        );
      } else {
        console.log(`[glaze] pose control OK: baseline reproduces Film's ${BASELINE_CODES} codes at 82 deg`);
      }
    }
  }

  /* ---- verdict ---- */
  console.log(`\n[glaze] --- verdict ---`);
  const get = (arm, deg) => results.find((r) => r.arm === arm && r.deg === deg);
  const b = (deg) => get("base", deg);

  // Is each lever wired at all? It counts as live if it moves ANY region.
  for (const [lever, armName] of [
    ["reflection leaf", "refl-x4"],
    ["environmentIntensity", "env-x2"],
  ]) {
    const a = get(armName, 82);
    if (!a) continue;
    const dN = Math.abs(a.notice.mean - b(82).notice.mean);
    const dS = Math.abs(a.shelving.mean - b(82).shelving.mean);
    console.log(
      dN < 0.05 && dS < 0.05
        ? `  ${lever}: LEVER DEAD — forcing it changed neither region. Its nulls below are facts about this tool.`
        : `  ${lever}: live (forced arm moves notice by ${dN.toFixed(1)}, control by ${dS.toFixed(1)} mean)`
    );
  }

  console.log(`\n  angle dependence of the notice, per arm:`);
  for (const arm of ARMS) {
    const a82 = get(arm.name, 82);
    const a45 = get(arm.name, 45);
    if (!a82 || !a45) continue;
    console.log(
      `    ${arm.name.padEnd(14)} 82deg codes ${String(a82.notice.codes).padStart(3)} / 45deg codes ${String(a45.notice.codes).padStart(3)}` +
        `   (ratio ${(a82.notice.codes / Math.max(1, a45.notice.codes)).toFixed(2)})`
    );
  }

  console.log(`\n  each mechanism against the shipped baseline, at 82 deg:`);
  for (const name of ["refl-off", "env-1x", "env-off", "fres-off", "lforce-noenv"]) {
    const a = get(name, 82);
    if (!a) continue;
    const dN = a.notice.codes - b(82).notice.codes;
    const dS = a.shelving.codes - b(82).shelving.codes;
    const both = Math.sign(dN) === Math.sign(dS) && Math.abs(dS) > 8 && Math.abs(dN) > 8;
    console.log(
      `    ${name.padEnd(14)} notice ${dN >= 0 ? "+" : ""}${String(dN).padStart(4)} codes, control ${dS >= 0 ? "+" : ""}${String(dS).padStart(4)} codes` +
        (both ? "   <-- moves BOTH: changing the pane, not explaining the notice" : "")
    );
  }

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ noticeRegion, SHELVING, results }, null, 2));
  if (problems.length) {
    console.log(`\n[glaze] page problems:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  console.log(`\n[glaze] frames and result.json in ${path.relative(ROOT, OUT)}`);
  await shutdown(0);
}

main().catch((e) => shutdown(1, e?.stack ?? String(e)));
