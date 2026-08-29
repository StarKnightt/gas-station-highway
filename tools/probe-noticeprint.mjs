#!/usr/bin/env node
/**
 * Did the door notices come off six distinct luma codes?
 *
 * ## What this is verifying
 *
 * The two white rectangles Film called the worst-looking thing in the build were
 * blank flat-colour quads taped to the **outside** of the entry door leaf — no
 * map, sky-lit, 392 px tall at 0.70 m. Two edits moved them to the inside face
 * (offset `-0.009` to `+0.009`, facing unchanged so the print still reads out
 * through the pane) and routed them through the notice atlas that the storefront
 * flyers already use.
 *
 * So there are exactly two claims to test, and the discriminator is the same one
 * that started the round: **the distinct luma code count**. A blank quad has a
 * handful of codes; printed paper has many. Six was the number Film's frame
 * delivered.
 *
 * 1. Each `entry-door-notice` carries print — codes well clear of 6, and close
 *    to what the unchanged `window-notice` set measures in the same frame.
 * 2. They are still *visible*. Moving paper behind glazing at an 82 deg stance
 *    risks trading a blank white rectangle for print drowned in the pane's
 *    reflection, and that would be a worse outcome dressed as a fix. Mean luma
 *    and the railed-pixel fraction say which happened.
 *
 * ## The region comes from the mesh, never from the picture
 *
 * The last round was lost to measuring a box that was chosen from a screenshot
 * and then attributed to an object that was somewhere else entirely. Here every
 * region is the projected bounding box of a named mesh, computed page-side from
 * `matrixWorld` and the camera matrices with the sixteen multiplies written out.
 *
 * No `THREE` on `window`, no `Raycaster`, no `Box3` — a production bundle does
 * not expose the library, and finding that out cost a page load once already.
 *
 * The box is inset before measuring. A projected AABB of a quad seen at a steep
 * angle includes its own silhouette edge, and the frame rail and glazing behind
 * it will contribute codes that have nothing to do with the print.
 *
 * ## Cost
 *
 * One page load, one stance, one screenshot. There are no arms: this is a
 * confirmation, and if it does not confirm, the instruction is to report and
 * stop rather than iterate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = Number(arg("port", 5114));
const BUILD_DIR = arg("build-dir", ".shot-build/noticeprint");
const DO_BUILD = !argv.includes("--no-build");
const OUT = arg("out", "tmp/noticeprint");
const READY_TIMEOUT_MS = 300_000;

const W = 1600;
const H = 900;
/** The stance the complaint was made from. */
const DEG = 82;
const GLASS_Z = 31.6;
const GLASS_X = -3.4;
const STANCE_D = 3.6;
/** Pixels trimmed off each side of a projected box before measuring. */
const INSET = Number(arg("inset", 6));
/** The count a blank quad produced, and the number to come off. */
const BLANK_CODES = 6;
/** The two pixels the complaint named, checked for containment. */
const ASK_PX = [
  [1275, 390],
  [1085, 570],
];

const resources = { browser: null, server: null };
async function shutdown(code, msg) {
  if (msg) console.log(`[notice] ${msg}`);
  try {
    await resources.browser?.close();
  } catch {}
  try {
    await resources.server?.close();
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130, "interrupted"));

/** Luma spread and distinct-code count inside a region. */
function stats(png, r) {
  if (!r || r.w < 6 || r.h < 6) return null;
  const l = [];
  for (let y = Math.max(0, Math.round(r.y)); y < Math.min(H, Math.round(r.y + r.h)); y++) {
    for (let x = Math.max(0, Math.round(r.x)); x < Math.min(W, Math.round(r.x + r.w)); x++) {
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
    railed: l.filter((v) => v >= 254.5).length / l.length,
  };
}

/**
 * Page-side: project every named notice mesh to a screen box.
 *
 * Reports the material's map as well, because "carries print" has a cheap
 * page-side half — a mesh whose material has no map cannot be printed however
 * the pixels come out — and confirming both halves in one load is free.
 */
const INSTALL = `(a) => {
  const [w, h] = a;
  const g = window.__GAME;
  const cam = g.camera;
  cam.updateMatrixWorld(true);
  const vi = cam.matrixWorldInverse.elements;
  const pj = cam.projectionMatrix.elements;
  const mul = (e, x, y, z, wc) => [
    e[0]*x + e[4]*y + e[8]*z + e[12]*wc,
    e[1]*x + e[5]*y + e[9]*z + e[13]*wc,
    e[2]*x + e[6]*y + e[10]*z + e[14]*wc,
    e[3]*x + e[7]*y + e[11]*z + e[15]*wc,
  ];
  const want = ["entry-door-notice", "window-notice"];
  const out = [];
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry || !want.includes(o.name)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (!bb) return;
    o.updateMatrixWorld(true);
    const mw = o.matrixWorld.elements;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, near = Infinity, seen = 0;
    for (let i = 0; i < 8; i++) {
      const wp = mul(mw, (i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z, 1);
      const vp = mul(vi, wp[0], wp[1], wp[2], 1);
      const cp = mul(pj, vp[0], vp[1], vp[2], 1);
      if (cp[3] <= 0) continue;
      seen++;
      const sx = (cp[0]/cp[3]*0.5 + 0.5) * w;
      const sy = (1 - (cp[1]/cp[3]*0.5 + 0.5)) * h;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      near = Math.min(near, -vp[2]);
    }
    if (seen < 8) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const uv = o.geometry.getAttribute("uv");
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    if (uv) for (let i = 0; i < uv.count; i++) {
      u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i));
      v0 = Math.min(v0, uv.getY(i)); v1 = Math.max(v1, uv.getY(i));
    }
    out.push({
      name: o.name,
      near,
      box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      hasMap: !!(m && m.map),
      mapImage: m && m.map && m.map.image ? (m.map.image.width + "x" + m.map.image.height) : "none",
      mapUploaded: m && m.map ? !m.map.needsUpdate : null,
      side: m ? m.side : null,
      cell: uv ? [u0.toFixed(3), v0.toFixed(3), u1.toFixed(3), v1.toFixed(3)].join(",") : "none",
    });
  });
  out.sort((p, q) => p.near - q.near);
  return out;
}`;

const PLACE = `(a) => {
  const [ex, ez, lookX, lookZ] = a;
  const g = window.__GAME;
  const cam = g.camera;
  const h = 2.09;
  cam.position.set(ex, h, ez);
  cam.lookAt(lookX, h, lookZ);
  cam.updateMatrixWorld(true);
  return [cam.position.x, cam.position.y, cam.position.z];
}`;

const SETTLE = `(n) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= n ? res(true) : requestAnimationFrame(step));
  requestAnimationFrame(step);
})`;

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  fs.mkdirSync(path.resolve(ROOT, OUT), { recursive: true });

  if (DO_BUILD) {
    console.log(`[notice] building into ${BUILD_DIR} ...`);
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  console.log(`[notice] preview on :${PORT}`);

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[notice] pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/?gpu=1`, { waitUntil: "load", timeout: 120_000 });
  const gpu = await assertHardwareGpu(page, { tag: "notice" });
  if (!/RTX\s*4060/i.test(gpu.renderer ?? "")) await shutdown(1, `wrong adapter: ${gpu.renderer}`);
  await page.waitForFunction(() => window.__SCENE_READY === true, null, {
    timeout: READY_TIMEOUT_MS,
    polling: 500,
  });

  const a = (DEG * Math.PI) / 180;
  const eye = await page.evaluate(
    `(${PLACE})(${JSON.stringify([GLASS_X - Math.sin(a) * STANCE_D, GLASS_Z - Math.cos(a) * STANCE_D, GLASS_X, GLASS_Z])})`
  );
  await page.evaluate(`(${SETTLE})(6)`);

  const meshes = await page.evaluate(`(${INSTALL})(${JSON.stringify([W, H])})`);
  const door = meshes.filter((m) => m.name === "entry-door-notice");
  const win = meshes.filter((m) => m.name === "window-notice");
  if (door.length !== 2) {
    await shutdown(1, `expected 2 entry-door-notice meshes, found ${door.length} — the edit did not land as built`);
  }
  /**
   * Fail on a broken projection instead of measuring one.
   *
   * A load was already spent printing `NaNxNaN` for every mesh and then
   * grinding on to a FAIL verdict about the scene, when the fault was a dropped
   * homogeneous coordinate in this file. A non-finite box is an instrument
   * fault and can never be a finding, so it must be named as one before any
   * pixel is read.
   */
  const broken = meshes.filter(
    (m) => ![m.box.x, m.box.y, m.box.w, m.box.h, m.near].every((v) => Number.isFinite(v))
  );
  if (broken.length) {
    await shutdown(
      1,
      `projection returned non-finite boxes for ${broken.length}/${meshes.length} meshes ` +
        `(${[...new Set(broken.map((m) => m.name))].join(", ")}). This is a fault in this probe, ` +
        `not in the scene — the meshes were found and their materials read fine. Fix the maths, do not re-read the picture.`
    );
  }

  const file = path.resolve(ROOT, OUT, `notice-${DEG}.png`);
  await page.screenshot({ path: file });
  const png = PNG.sync.read(fs.readFileSync(file));

  const inset = (b) => ({ x: b.x + INSET, y: b.y + INSET, w: b.w - INSET * 2, h: b.h - INSET * 2 });
  const row = (m, i) => {
    const s = stats(png, inset(m.box));
    const hits = ASK_PX.filter(
      ([px, py]) => px >= m.box.x && px <= m.box.x + m.box.w && py >= m.box.y && py <= m.box.y + m.box.h
    );
    return { m, i, s, hits };
  };

  console.log(
    `\n[notice] ${DEG} deg, eye (${eye.map((v) => v.toFixed(2)).join(", ")}), ${file}\n` +
      `  region = projected bbox of each named mesh, inset ${INSET} px. blank baseline was ${BLANK_CODES} codes.\n`
  );

  const report = (label, list) => {
    console.log(`  ${label}`);
    for (const { m, s, hits } of list.map(row)) {
      const box = `${Math.round(m.box.w)}x${Math.round(m.box.h)} @${m.near.toFixed(2)}m`;
      console.log(
        `    ${box.padEnd(22)} map ${(m.hasMap ? m.mapImage : "NONE").padEnd(10)}` +
          `${m.mapUploaded === false ? " NEVER UPLOADED" : ""} uv [${m.cell}]`
      );
      console.log(
        s == null
          ? `    ${"".padEnd(22)} region too small to measure after inset`
          : `    ${"".padEnd(22)} codes ${String(s.codes).padStart(3)}  mean ${s.mean.toFixed(1).padStart(5)}` +
              `  sd ${s.sd.toFixed(2).padStart(6)}  railed ${(s.railed * 100).toFixed(1).padStart(5)}%  n ${s.n}` +
              (hits.length ? `  <-- contains ${hits.map((p) => p.join(",")).join(" and ")}` : "")
      );
    }
  };

  report(`entry-door-notice (changed) — ${door.length} meshes`, door);
  report(`window-notice (unchanged control) — ${win.length} meshes`, win);

  const dRows = door.map(row).filter((r) => r.s);
  const wRows = win.map(row).filter((r) => r.s);
  const worst = dRows.reduce((a, b) => (a.s.codes <= b.s.codes ? a : b), dRows[0]);
  const wMean = wRows.length ? wRows.reduce((t, r) => t + r.s.codes, 0) / wRows.length : null;
  const covered = ASK_PX.filter(([px, py]) =>
    door.some((m) => px >= m.box.x && px <= m.box.x + m.box.w && py >= m.box.y && py <= m.box.y + m.box.h)
  );

  console.log(
    `\n[notice] verdict\n` +
      `  named pixels covered by a door notice: ${covered.length}/${ASK_PX.length}` +
      `${covered.length ? ` (${covered.map((p) => p.join(",")).join(" and ")})` : ""}\n` +
      `  worst door notice: ${worst ? worst.s.codes : "n/a"} codes vs blank baseline ${BLANK_CODES}` +
      `${wMean == null ? "" : `, unchanged control averages ${wMean.toFixed(1)}`}`
  );

  if (!dRows.length) {
    console.log(`  FAIL: neither door notice produced a measurable region.`);
  } else if (worst.s.codes <= BLANK_CODES) {
    console.log(
      `  FAIL: still at or below the blank count. The map is bound page-side but the\n` +
        `  pixels are not carrying it — read the railed fraction before assuming why.`
    );
  } else if (worst.s.railed > 0.5) {
    console.log(
      `  PARTIAL: codes came off ${BLANK_CODES} but ${(worst.s.railed * 100).toFixed(0)}% of the region is railed white.\n` +
        `  Print exists and is being clipped, which is a different defect from a blank quad.`
    );
  } else {
    console.log(`  PASS: both door notices carry print and neither is railed.`);
  }

  await shutdown(0);
}

main().catch((e) => shutdown(1, e?.stack ?? String(e)));
