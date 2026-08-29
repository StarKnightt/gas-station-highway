#!/usr/bin/env node
/**
 * Does anything on the roof actually clear the parapet?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-roofline.mjs
 *
 * A flat-roofed store hides its plant behind the coping, which is correct and
 * is also why the skyline reads as CG. Fixing it means putting things on the
 * roof that are tall enough or close enough to the parapet to be seen — and
 * whether a given item qualifies is a projection question, not a taste one.
 * Answering it on the CPU costs a second; answering it with a capture costs
 * three and a half minutes, and the vegetation system already lost a round to a
 * feature that was built correctly and stood off camera.
 *
 * So: build the real building headless, walk the real scene graph, and for each
 * capture camera report every mesh whose world bounding box projects above the
 * silhouette of the parapet in front of it. Reported per mesh batch, with the
 * height of the tallest point above the parapet line in screen pixels.
 *
 * Pure computation. Nothing to tear down.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.location ??= { search: "", href: "http://localhost/" };
const noop = () => {};
const stubCtx2d = () =>
  new Proxy(
    {
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      canvas: null,
    },
    {
      get: (t, k) => (k in t ? t[k] : typeof k === "string" ? noop : undefined),
      set: () => true,
    }
  );
const stubCanvas = (w = 256, h = 256) => ({
  width: w,
  height: h,
  style: {},
  setAttribute() {},
  appendChild() {},
  getContext: () => stubCtx2d(),
  toDataURL: () => "",
});
globalThis.document ??= {
  body: { appendChild() {} },
  createElement: (tag) => (tag === "canvas" ? stubCanvas() : { style: {}, setAttribute() {}, appendChild() {} }),
};
globalThis.OffscreenCanvas ??= class {
  constructor(w, h) {
    Object.assign(this, stubCanvas(w, h));
  }
};
globalThis.window ??= globalThis;

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const THREE = await load("node_modules/three/build/three.module.js").catch(() => import("three"));

const services = new Map();
const game = {
  provide: (k, v) => (services.set(k, v), v),
  require: (k) => services.get(k),
  tryGet: (k) => services.get(k),
};
game.provide("groundHeight", () => 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1600 / 900, 0.05, 500);
const { BuildingSystem } = await load("src/systems/BuildingSystem.ts");
const sys = new BuildingSystem();
await sys.init({
  game,
  scene,
  camera,
  renderer: {
    capabilities: { getMaxAnisotropy: () => 8, isWebGL2: true },
    getPixelRatio: () => 1,
    outputColorSpace: "srgb",
    properties: { get: () => ({}) },
  },
  shot: null,
});

const { BUILDING_SHOTS, applyBuildingShot } = await load("src/gen/buildingShots.ts");
const { groundHeight } = await load("src/site.ts");
const fp = game.tryGet("building.footprint");
const root = game.tryGet("building.root");
root.updateMatrixWorld(true);

const W = 1600;
const H = 900;
const toScreenY = (v) => ((1 - v.y) / 2) * H;

/**
 * The parapet silhouette as a screen row per screen column.
 *
 * Per column, not one number: the coping runs away from the camera in
 * perspective, so a single "highest coping row" is only right at one end of the
 * building and is 200 px wrong at the other.
 *
 * And per *vertex*, not per bounding box, which is what the first cut of this
 * probe got wrong. Everything on this roof is merged into four batches spanning
 * the whole building, so a batch's bounding box has corners in mid-air where no
 * geometry exists — it duly reported the steelwork batch clearing the coping by
 * 234 px, which was a statement about an empty point above the west wall.
 * NOTES.md case 18: an instrument invalidated by the thing it measures does not
 * go quiet, it returns a plausible number in the direction you were hoping for.
 */
function parapetSilhouette(cam) {
  const rows = new Float64Array(W).fill(Infinity);
  const p = new THREE.Vector3();
  const N = 2000;
  const edges = [
    [fp.minX, fp.minZ, fp.maxX, fp.minZ],
    [fp.maxX, fp.minZ, fp.maxX, fp.maxZ],
    [fp.minX, fp.minZ, fp.minX, fp.maxZ],
    [fp.minX, fp.maxZ, fp.maxX, fp.maxZ],
  ];
  for (const [ax, az, bx, bz] of edges) {
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      p.set(ax + (bx - ax) * t, fp.parapetY, az + (bz - az) * t).project(cam);
      if (p.z > 1 || p.z < -1) continue;
      const col = Math.round(((p.x + 1) / 2) * W);
      if (col < 0 || col >= W) continue;
      const sy = toScreenY(p);
      if (sy < rows[col]) rows[col] = sy;
    }
  }
  return rows;
}

const v = new THREE.Vector3();

for (const name of ["front", "corner"]) {
  applyBuildingShot(camera, name, fp.floorY, groundHeight);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const sky = parapetSilhouette(camera);
  console.log(`\n=== ${name} ===`);

  const report = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    let best = null;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      // Only roof-mounted geometry can break the roof line.
      if (v.y < fp.roofY - 0.02) continue;
      const wy = v.y;
      const wx = v.x;
      const wz = v.z;
      v.project(camera);
      if (v.z > 1 || v.z < -1) continue;
      const col = Math.round(((v.x + 1) / 2) * W);
      if (col < 0 || col >= W) continue;
      const sy = toScreenY(v);
      const above = sky[col] - sy;
      if (!Number.isFinite(above)) continue;
      if (!best || above > best.above) best = { above, col, row: sy, wx, wy, wz };
    }
    if (best) report.push({ name: o.name, ...best });
  });

  report.sort((a, b) => b.above - a.above);
  for (const r of report) {
    const verdict =
      r.above > 3
        ? `CLEARS the coping by ${r.above.toFixed(0)} px at column ${r.col}`
        : `hidden (${(-r.above).toFixed(0)} px below the coping)`;
    console.log(
      `  ${r.name.padEnd(22)} ${verdict}\n` +
        `  ${"".padEnd(22)}   highest point (${r.wx.toFixed(2)}, ${r.wy.toFixed(2)}, ${r.wz.toFixed(2)})`
    );
  }
  const seen = report.filter((r) => r.above > 3);
  console.log(`  -> ${seen.length} of ${report.length} roof batches break the parapet line`);
}
