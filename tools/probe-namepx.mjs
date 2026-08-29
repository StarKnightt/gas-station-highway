#!/usr/bin/env node
/**
 * What object is under this pixel, from this stance?
 *
 *   node tools/probe-namepx.mjs --port=5112 --no-build
 *
 * ## Why this had to be written after the ablation rather than before it
 *
 * The glazing ablation (`probe-glazeablate.mjs`) returned the notice region
 * **bit-identical** across a 0x, 1x and 4x reflection gain and a Fresnel-off
 * reload, while the shelving control behind the same pane moved by 13 mean and
 * 30 distinct codes under the 4x arm. So the lever is live, reaches the frame,
 * and does not touch that rectangle at all.
 *
 * That refuses both remaining candidates — and it also exposes an assumption in
 * the diagnosis it was testing. The claim "the map is bound, because the same
 * object is printed at 65 deg" compared a box on the 82 deg frame with a box on
 * the 65 deg frame and **assumed the two boxes contain the same object.** Nothing
 * measured that. It is the invariant trap from NOTES case 53 again: four numbers
 * were collected and the thing the assertion was actually about — the identity
 * of the surface — was never among them.
 *
 * So this asks the only question that settles it, and asks it of the scene
 * rather than of the image: raycast through the pixel and report what is there.
 * Same camera, same stances, one load.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const PORT = Number(arg("port", 5112));
const BUILD_DIR = arg("build-dir", ".shot-build/glazeablate");
const DO_BUILD = !argv.includes("--no-build");
const READY_TIMEOUT_MS = 420_000;

const GLASS_Z = 31.6;
const GLASS_X = -3.4;
const STANCE_D = 3.6;
/** Half-width of the box vertex samples must land in to count, in pixels. */
const HALF_BOX = Number(arg("halfbox", 24));
/** Cap on samples per mesh, so a 200k-vertex batch does not dominate the load. */
const MAX_SAMPLES = Number(arg("samples", 4000));
/** Height of the rectangle under investigation, for the implied-size column. */
const RECT_PX = Number(arg("rectpx", 340));

/** Pixel centres of the regions the diagnosis was built on, per stance. */
const ASKS = [
  { deg: 82, label: "rect A core (the white rectangle)", px: [1275, 390] },
  { deg: 82, label: "rect B core", px: [1085, 570] },
  { deg: 82, label: "shelving control", px: [1460, 620] },
  { deg: 65, label: "the printed notice at 65 deg", px: [1075, 430] },
  { deg: 65, label: "shelving control at 65 deg", px: [1300, 580] },
];

const resources = { browser: null, server: null };
async function shutdown(code, msg) {
  if (msg) console.error(`[namepx] ${msg}`);
  try {
    await resources.browser?.close();
  } catch {}
  try {
    await resources.server?.close();
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130, "interrupted"));

/**
 * Which meshes cover this pixel, and which of them is actually *at* it?
 *
 * **Deliberately not a `Raycaster`.** `THREE` is not on `window` in a production
 * build — the first revision of this file died on exactly that, having spent a
 * page load to find out. Everything here uses only `matrixWorld`,
 * `matrixWorldInverse` and `projectionMatrix`, which are on the objects in any
 * build, with the sixteen multiplies written out.
 *
 * ## Two columns, because the cheap one is wrong in this tree
 *
 * **`bbox`** projects the geometry's bounding box and asks whether it contains
 * the pixel. It is one transform per mesh and it over-reports by construction —
 * and `BuildingSystem` batches by material, so `ceiling-tiles`, `cmu-interior`
 * and `product` are each a *single mesh whose box covers most of the frame*.
 * Ranking those by `near` gives the nearest corner of a room-sized box, which is
 * an artefact of the batching rather than a fact about the pixel. On this scene
 * that artefact would dominate the answer.
 *
 * **`samples`** walks the `position` attribute on a stride, transforms each
 * vertex to screen, and counts how many land inside a small box around the
 * pixel, recording the nearest depth **among those that land inside**. That is a
 * statement about the surface at the pixel rather than about the mesh's extent.
 *
 * It **under-reports thin and sparse geometry** — a large quad has four vertices
 * and may contribute none inside a 24 px box even though it covers it. That is
 * the safe direction here: a thin surface wrongly demoted is recoverable from the
 * `bbox` column, whereas a room-sized box wrongly promoted sends the next person
 * after the wrong object. So both columns are reported and neither is hidden.
 *
 * ## The size constraint, as a test of the answer rather than a candidate
 *
 * A box of `bh` pixels in a viewport of `H` at vertical fov `f` subtends
 * `bh / H * 2 * range * tan(f / 2)` metres. At fov 52 over 900 px, a 340 px
 * rectangle is 1.33 m at 3.6 m and 3.83 m at 10.4 m — and the shop is 2.78 m
 * floor to ceiling, so **anything that fits in the room and fills that box must
 * be nearer than about 7.5 m.** The implied height is printed beside every
 * candidate. A winner beyond 7.5 m is not an object standing in the room, and
 * that is a finding rather than a failure.
 *
 * `mapUploaded` is the field to read for a dead-map hypothesis: a `CanvasTexture`
 * whose `needsUpdate` was never set samples white and is indistinguishable from
 * a flat face.
 */
const PICK = `(a) => {
  const [px, py, w, h, halfBox, maxSamples] = a;
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
  /** World point -> { sx, sy, depth } or null if behind the camera. */
  const toScreen = (mw, x, y, z) => {
    const wp = mul(mw, x, y, z, 1);
    const vp = mul(vi, wp[0], wp[1], wp[2], 1);
    const cp = mul(pj, vp[0], vp[1], vp[2], 1);
    if (cp[3] <= 0) return null;
    return {
      sx: (cp[0]/cp[3]*0.5 + 0.5) * w,
      sy: (1 - (cp[1]/cp[3]*0.5 + 0.5)) * h,
      depth: -vp[2],
    };
  };
  const out = [];
  let meshes = 0;
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    meshes++;
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    o.updateMatrixWorld(true);
    const mw = o.matrixWorld.elements;

    /* ---- column 1: projected bounding box, cheap and over-reporting ---- */
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity, bNear = Infinity, corners = 0;
    if (bb) {
      for (let i = 0; i < 8; i++) {
        const s = toScreen(mw, (i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z);
        if (!s) continue;
        corners++;
        bMinX = Math.min(bMinX, s.sx); bMaxX = Math.max(bMaxX, s.sx);
        bMinY = Math.min(bMinY, s.sy); bMaxY = Math.max(bMaxY, s.sy);
        bNear = Math.min(bNear, s.depth);
      }
    }
    const bboxHit = corners === 8 && px >= bMinX && px <= bMaxX && py >= bMinY && py <= bMaxY;

    /* ---- column 2: strided vertex samples landing inside the box ---- */
    const stride = Math.max(1, Math.ceil(pos.count / maxSamples));
    let inBox = 0, taken = 0, sNear = Infinity, sFar = -Infinity;
    for (let i = 0; i < pos.count; i += stride) {
      taken++;
      const s = toScreen(mw, pos.getX(i), pos.getY(i), pos.getZ(i));
      if (!s) continue;
      if (Math.abs(s.sx - px) <= halfBox && Math.abs(s.sy - py) <= halfBox) {
        inBox++;
        sNear = Math.min(sNear, s.depth);
        sFar = Math.max(sFar, s.depth);
      }
    }
    if (!bboxHit && inBox === 0) return;

    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    out.push({
      obj: o.name || "(unnamed)",
      mat: (m && m.name) || "(unnamed material)",
      type: m ? m.type : "none",
      verts: pos.count,
      bboxHit,
      bboxNear: corners === 8 ? bNear : null,
      bboxScreen: corners === 8 ? [Math.round(bMaxX-bMinX), Math.round(bMaxY-bMinY)] : null,
      inBox,
      taken,
      stride,
      sampleNear: inBox ? sNear : null,
      sampleFar: inBox ? sFar : null,
      hasMap: !!(m && m.map),
      mapImage: m && m.map && m.map.image ? (m.map.image.width + "x" + m.map.image.height) : "none",
      mapUploaded: m && m.map ? !m.map.needsUpdate : null,
      hasEmissiveMap: !!(m && m.emissiveMap),
      color: m && m.color ? "#" + m.color.getHexString() : "none",
      emissive: m && m.emissive ? "#" + m.emissive.getHexString() : "none",
      emissiveIntensity: m && m.emissiveIntensity !== undefined ? m.emissiveIntensity : null,
      opacity: m ? m.opacity : null,
      transparent: m ? !!m.transparent : null,
      renderOrder: o.renderOrder,
    });
  });
  // Samples first, because that column is about the pixel; bbox as a tiebreak.
  out.sort((p, q) => (q.inBox - p.inBox) || ((p.sampleNear ?? p.bboxNear ?? 1e9) - (q.sampleNear ?? q.bboxNear ?? 1e9)));
  return { meshes, hits: out.slice(0, 14) };
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

  if (DO_BUILD) {
    console.log(`[namepx] building into ${BUILD_DIR} ...`);
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  console.log(`[namepx] preview on :${PORT}`);

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[namepx] pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/?gpu=1&reticle=1`, { waitUntil: "load", timeout: 120_000 });
  const gpu = await assertHardwareGpu(page, { tag: "namepx" });
  if (!/RTX\s*4060/i.test(gpu.renderer ?? "")) await shutdown(1, `wrong adapter: ${gpu.renderer}`);
  await page.waitForFunction(() => window.__SCENE_READY === true, null, {
    timeout: READY_TIMEOUT_MS,
    polling: 500,
  });

  // No THREE check: this probe deliberately does not need it. See PICK.

  /**
   * What height does the reported rectangle imply, if the winner sits at this
   * range? The shop is 2.78 m floor to ceiling, so a plausible interior object
   * filling a 340 px box has to be nearer than about 7.5 m. Printed per
   * candidate so the answer can be tested rather than trusted.
   */
  const CEILING = 2.78;
  const impliedH = (range) => (RECT_PX / 900) * 2 * range * Math.tan(((52 / 2) * Math.PI) / 180);

  for (const ask of ASKS) {
    const a = (ask.deg * Math.PI) / 180;
    const stance = [GLASS_X - Math.sin(a) * STANCE_D, GLASS_Z - Math.cos(a) * STANCE_D];
    const eye = await page.evaluate(`(${PLACE})(${JSON.stringify([...stance, GLASS_X, GLASS_Z])})`);
    await page.evaluate(`(${SETTLE})(4)`);
    const { meshes, hits } = await page.evaluate(
      `(${PICK})(${JSON.stringify([...ask.px, 1600, 900, HALF_BOX, MAX_SAMPLES])})`
    );
    console.log(
      `\n[namepx] ${ask.deg} deg, pixel (${ask.px[0]}, ${ask.px[1]}) — ${ask.label}\n` +
        `  eye (${eye.map((v) => v.toFixed(2)).join(", ")}), ${meshes} visible meshes, ` +
        `sample box +/-${HALF_BOX} px, <=${MAX_SAMPLES} samples/mesh`
    );
    if (!hits.length) {
      console.log(`  nothing covers this pixel by either measure`);
      continue;
    }
    console.log(
      `  ${"samples".padEnd(14)} ${"bbox".padEnd(20)} ${"object".padEnd(24)} ${"material".padEnd(20)} ` +
        `implied h @ sample depth`
    );
    for (const t of hits) {
      const near = t.sampleNear ?? t.bboxNear;
      const h = near == null ? null : impliedH(near);
      const sampleCol =
        t.inBox > 0
          ? `${t.inBox}/${t.taken} @${t.sampleNear.toFixed(2)}m`.padEnd(14)
          : "-".padEnd(14);
      const bboxCol = t.bboxHit
        ? `hit ${t.bboxScreen[0]}x${t.bboxScreen[1]} @${t.bboxNear.toFixed(2)}m`.padEnd(20)
        : "-".padEnd(20);
      console.log(
        `  ${sampleCol} ${bboxCol} ${t.obj.padEnd(24)} ${t.mat.padEnd(20)} ` +
          (h == null
            ? ""
            : `${h.toFixed(2)} m${h > CEILING ? "  <-- taller than the room: cannot be standing in it" : ""}`)
      );
      console.log(
        `  ${"".padEnd(14)} ${"".padEnd(20)} ${t.type}, ${t.verts} verts, map ${
          t.hasMap ? t.mapImage + (t.mapUploaded === false ? " NEVER UPLOADED" : "") : "NONE"
        }, emissiveMap ${t.hasEmissiveMap ? "yes" : "no"}, col ${t.color}, em ${t.emissive}@${
          t.emissiveIntensity
        }, op ${t.opacity}${t.transparent ? " transparent" : ""}, order ${t.renderOrder}`
      );
    }
    const best = hits[0];
    if (best.inBox === 0) {
      console.log(
        `  NOTE: no mesh contributed a vertex sample inside the box, so this is a bbox-only\n` +
          `  answer and bbox over-reports — BuildingSystem batches by material, so a\n` +
          `  room-sized box can win on a corner. Treat the name as a shortlist, not a result.`
      );
    }
  }

  await shutdown(0);
}

main().catch((e) => shutdown(1, e?.stack ?? String(e)));
