#!/usr/bin/env node
/**
 * What is the mesh under this pixel?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *        tools/probe-pixel.mjs door 320 350
 *
 * Reading a screenshot tells you there is a blank cream rectangle on the west
 * wall. It does not tell you which of four hundred merged batches drew it, and
 * the guesses are expensive: each wrong one costs a three-and-a-half minute
 * capture to disprove. Ray-casting the real scene graph through the real
 * capture camera costs two seconds and cannot be argued with.
 *
 * Reports every hit along the ray front to back, so "the thing in front of the
 * thing I meant" - which is most of this project's bugs - is visible directly.
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

const [shot, xRaw, yRaw] = process.argv.slice(2);
if (!shot || xRaw === undefined || yRaw === undefined) {
  console.error("usage: probe-pixel.mjs <shot> <x> <y>   (pixels in the 1600x900 capture)");
  process.exit(2);
}

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
const fp = game.tryGet("building.footprint");
const { applyBuildingShot } = await load("src/gen/buildingShots.ts");
const { groundHeight } = await load("src/site.ts");

const W = 1600;
const H = 900;
applyBuildingShot(camera, shot, fp.floorY, groundHeight);
camera.aspect = W / H;
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
root.updateMatrixWorld(true);

const ndc = new THREE.Vector2((Number(xRaw) / W) * 2 - 1, 1 - (Number(yRaw) / H) * 2);
const ray = new THREE.Raycaster();
ray.camera = camera;
ray.setFromCamera(ndc, camera);

/**
 * Force every material double-sided for the duration of the cast, then put it
 * back.
 *
 * `Raycaster` honours `material.side`, so with the materials left alone this
 * probe **silently skips the back face of every `FrontSide` material** — and a
 * quad seen from behind is one of the two or three most common ways geometry
 * goes wrong in this project. The first version of this file did exactly that
 * and reported "nothing here but the glazing" for a band of hard black
 * rectangles that turned out to be back faces, which is the third probe in two
 * days to return the comfortable answer (NOTES.md case 18). A probe hunting
 * for geometry must not use the renderer's visibility rules.
 *
 * Reported per hit, so "front" versus "back" is visible in the output rather
 * than inferred.
 */
const saved = [];
root.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m || saved.some((s) => s.m === m)) continue;
    saved.push({ m, side: m.side });
    m.side = THREE.DoubleSide;
  }
});
const hits = ray.intersectObject(root, true);
for (const s of saved) s.m.side = s.side;

const facing = (h) => {
  const n = h.face?.normal;
  if (!n) return "";
  const world = n.clone().transformDirection(h.object.matrixWorld);
  return world.dot(ray.ray.direction) > 0 ? "  <- BACK FACE" : "";
};

console.log(`\n${shot} pixel (${xRaw}, ${yRaw})  ->  ${hits.length} hit${hits.length === 1 ? "" : "s"}\n`);
for (const h of hits.slice(0, 12)) {
  const p = h.point;
  const orig = saved.find((s) => s.m === (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material));
  const hidden = orig && orig.side === THREE.FrontSide && facing(h) ? "  (culled at render time)" : "";
  console.log(
    `  ${h.distance.toFixed(2).padStart(7)} m   ${(h.object.name || "(unnamed)").padEnd(26)} ` +
      `at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})${facing(h)}${hidden}`
  );
}
