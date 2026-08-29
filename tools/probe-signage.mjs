#!/usr/bin/env node
/**
 * Is any of the signage large enough on screen to be *read* rather than merely
 * present?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-signage.mjs
 *
 * The front capture came back with two sign plates rendering as featureless
 * cream rectangles. "The artwork is wrong" and "the artwork is fine and is
 * three pixels tall" produce the identical screenshot, and they have opposite
 * fixes, so guessing between them costs a four-minute round either way.
 *
 * This settles it arithmetically. For each signage mesh: project its corners
 * through each capture camera to get its size in pixels, then multiply by the
 * fraction of the panel height its *smallest* type occupies to get that type's
 * cap height in screen pixels. Below about 4 px a capital averages to a flat
 * tint - which is precisely what a blank cream rectangle looks like.
 *
 * The type fractions are declared here rather than exported from the generator
 * because they are a property of the drawing, and a probe that imports its
 * expectations from the thing it is checking cannot disagree with it.
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
    { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? noop : undefined), set: () => true }
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
const THREE = await import("three");

const services = new Map();
const game = {
  provide: (k, v) => (services.set(k, v), v),
  require: (k) => services.get(k),
  tryGet: (k) => services.get(k),
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 500);
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

const root = game.tryGet("building.root");
root.updateMatrixWorld(true);

/**
 * Cap height of the smallest type that matters on each sign, as a fraction of
 * the drawn panel's height. Read off the generator's own font sizes by hand.
 */
const TYPE = {
  "fascia-sign": { label: "subline MARKET FUEL", frac: 0.17 * 0.72 },
  "decal-hours": { label: "hours rows 46px", frac: (46 * 0.72) / 512 },
  "decal-payment": { label: "ATM INSIDE 34px", frac: (34 * 0.72) / 512 },
  "decal-open": { label: "24 HOURS 46px", frac: (46 * 0.72) / 512 },
  "decal-notice": { label: "small-print rules 9px", frac: 9 / 512 },
  "decal-exit": { label: "EXIT 128px", frac: (128 * 0.72) / 256 },
  "decal-restroom": { label: "ASK FOR KEY 40px", frac: (40 * 0.72) / 256 },
  "decal-employees": { label: "EMPLOYEES 62px", frac: (62 * 0.72) / 256 },
  "decal-nosmoking": { label: "roundel bar", frac: 16 / 256 },
  "cooler-valance-sign": { label: "SODA WATER 46px", frac: 0.44 * 0.72 },
  "shelf-price-strips": { label: "price block", frac: 0.3 },
};

const W = 1600;
const H = 900;
const { BUILDING_SHOTS, applyBuildingShot } = await load("src/gen/buildingShots.ts");
const shots = Object.keys(BUILDING_SHOTS ?? {});
const fp = game.tryGet("building.footprint");
const { groundHeight } = await load("src/site.ts");

const box = new THREE.Box3();
const p = new THREE.Vector3();

for (const shot of shots) {
  applyBuildingShot(camera, shot, fp.floorY, groundHeight);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const rows = [];
  root.traverse((o) => {
    if (!o.isMesh || !TYPE[o.name]) return;
    box.setFromObject(o);
    if (box.isEmpty()) return;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      p.applyMatrix4(camera.matrixWorldInverse);
      if (p.z > -0.05) {
        behind = true;
        continue;
      }
      p.applyMatrix4(camera.projectionMatrix);
      const sx = ((p.x + 1) / 2) * W;
      const sy = ((1 - p.y) / 2) * H;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    if (!Number.isFinite(x0)) return;
    const pxH = y1 - y0;
    const cap = pxH * TYPE[o.name].frac;
    const onScreen = x1 > 0 && x0 < W && y1 > 0 && y0 < H;
    rows.push({ name: o.name, x0, y0, w: x1 - x0, h: pxH, cap, onScreen, behind });
  });

  if (!rows.length) continue;
  console.log(`\n=== ${shot} ===`);
  rows.sort((a, b) => b.cap - a.cap);
  for (const r of rows) {
    const verdict = !r.onScreen
      ? "OFF CAMERA"
      : r.cap >= 7
        ? "reads"
        : r.cap >= 4
          ? "marginal"
          : "TOO SMALL - averages to a flat tint";
    console.log(
      `  ${r.name.padEnd(22)} ${r.w.toFixed(0).padStart(4)} x ${r.h.toFixed(0).padStart(3)} px at ` +
        `(${r.x0.toFixed(0)}, ${r.y0.toFixed(0)})   cap ${r.cap.toFixed(1)} px  ${verdict}`
    );
    console.log(`  ${"".padEnd(22)}   smallest type: ${TYPE[r.name].label}`);
  }
}
