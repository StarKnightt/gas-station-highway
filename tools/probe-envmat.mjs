/**
 * Material-sharing audit for the name-keyed interior IBL pass. CPU-only.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-envmat.mjs
 *
 * ## What this catches
 *
 * `tuneInteriorMaterials` (src/systems/lightInterior.ts) knocks
 * `envMapIntensity` down on the store interior by walking the building's scene
 * graph and matching **mesh names**. A mesh, though, does not own its material:
 * `BuildingSystem` batches by material, and several of those materials are used
 * both inside and outside. Naming one interior mesh therefore dims every
 * exterior mesh that happens to share its material.
 *
 * That was harmless for as long as `envMapIntensity` was inert (NOTES.md case
 * 21). The day the binder made it live, it stopped being harmless: measured on
 * the `corner` pose, the ice machine's front went 67.2 -> 98.1 of 255 between
 * `?ienv=0.07` and `?ienv=1.0`, i.e. it had lost 46% of its brightness, against
 * a CMU wall control that moved 1.1 and an asphalt control that moved 0.00.
 *
 * This is the static form of that finding, so it cannot regress silently: it
 * builds the real building headless, resolves the real name set against the
 * real material graph, and fails if any material reached by the interior pass
 * is also drawn by a mesh outside the building envelope.
 *
 * ## Inside vs outside
 *
 * Decided from world-space geometry, not from names: a mesh is "outside" if its
 * bounding box centre falls beyond the building footprint, or above the roof
 * deck. Names are what the bug is made of, so they cannot also be the test.
 *
 * Exit code 1 on any cross-boundary material.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ---------------- minimal headless browser surface ---------------- */
// Same stub shape as tools/probe-instancing.mjs. This audit is about material
// topology, so the 2D canvas is a no-op and the textures it would draw are
// irrelevant - do not reuse it for anything that inspects texture content.
globalThis.location ??= { search: "", href: "http://localhost/" };
const noop = () => {};
const stubCtx2d = () => ({
  canvas: null,
  fillStyle: "",
  strokeStyle: "",
  font: "",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  textBaseline: "alphabetic",
  textAlign: "start",
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  save: noop,
  restore: noop,
  translate: noop,
  rotate: noop,
  scale: noop,
  beginPath: noop,
  closePath: noop,
  moveTo: noop,
  lineTo: noop,
  arc: noop,
  ellipse: noop,
  rect: noop,
  roundRect: noop,
  arcTo: noop,
  quadraticCurveTo: noop,
  bezierCurveTo: noop,
  fill: noop,
  stroke: noop,
  clip: noop,
  fillRect: noop,
  strokeRect: noop,
  clearRect: noop,
  fillText: noop,
  strokeText: noop,
  drawImage: noop,
  setTransform: noop,
  setLineDash: noop,
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null,
  getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: noop,
});
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
  require: (k) => {
    if (!services.has(k)) throw new Error(`stub game: no service "${k}"`);
    return services.get(k);
  },
  tryGet: (k) => services.get(k),
};
game.provide("groundHeight", () => 0);

const scene = new THREE.Scene();
const ctx = {
  game,
  scene,
  camera: new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500),
  renderer: {
    capabilities: { getMaxAnisotropy: () => 8, isWebGL2: true },
    getPixelRatio: () => 1,
    outputColorSpace: "srgb",
    properties: { get: () => ({}) },
  },
  shot: null,
};

const { BuildingSystem } = await load("src/systems/BuildingSystem.ts");
const building = new BuildingSystem();
await building.init(ctx);

const root = game.tryGet("building.root");
const fp = game.tryGet("building.footprint");
if (!root || !fp) {
  console.error("building did not publish building.root / building.footprint");
  process.exit(2);
}

/* ---------------- the name set under audit ---------------- */
// Read from the source rather than duplicated, so this probe cannot drift out
// of step with the pass it is auditing - which is how an instrument starts
// reporting on a rule nobody applies any more (NOTES.md case 18).
const fs = await import("node:fs/promises");
const src = await fs.readFile(path.join(ROOT, "src/systems/lightInterior.ts"), "utf8");
const block = src.match(/const INTERIOR = new Set\(\[([\s\S]*?)\]\)/);
if (!block) {
  console.error("could not find the INTERIOR name set in src/systems/lightInterior.ts");
  process.exit(2);
}
const INTERIOR = new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
console.log(`INTERIOR name set (${INTERIOR.size}): ${[...INTERIOR].join(", ")}\n`);

/* ---------------- walk ---------------- */
const box = new THREE.Box3();

/**
 * How far a mesh reaches beyond the heated envelope, in metres.
 *
 * **Extent, not centre, and the first cut of this probe got it wrong in the
 * flattering direction.** `BuildingSystem` merges by material, so the ice
 * machine, the propane bottles and the cooler cabinet are one `enamel` mesh —
 * whose bounding-box centre sits comfortably inside the store. The probe duly
 * reported "OK: no material reached by the interior pass is also drawn
 * outdoors" while a staged capture measured the ice machine 46% down. NOTES.md
 * case 18: a plausible number in the direction the author was hoping for.
 *
 * The margin is generous (0.25 m) because the outer wall face, the coping
 * overhang and the buried skirt all legitimately sit on or just past the
 * footprint line, and a probe that cries wolf gets ignored.
 */
const PAD = 0.25;
function outsideBy(mesh) {
  box.setFromObject(mesh);
  if (box.isEmpty()) return null;
  return Math.max(
    fp.minX - box.min.x,
    box.max.x - fp.maxX,
    fp.minZ - box.min.z,
    box.max.z - fp.maxZ,
    box.max.y - fp.parapetY
  );
}
const outside = (mesh) => {
  const by = outsideBy(mesh);
  return by === null ? null : by > PAD;
};

const byMaterial = new Map();
root.updateMatrixWorld(true);
root.traverse((o) => {
  if (!o.isMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (!byMaterial.has(m)) byMaterial.set(m, []);
    byMaterial.get(m).push({ name: o.name, outside: outside(o), by: outsideBy(o) });
  }
});

console.log(`${"material".padEnd(26)} ${"envI".padStart(5)}  dimmed  meshes`);
const offenders = [];
for (const [mat, meshes] of byMaterial) {
  const dimmed = meshes.some((m) => INTERIOR.has(m.name));
  const label = `${mat.type}#${mat.id}`;
  const names = meshes.map((m) => `${m.name}${m.outside ? "*" : ""}`).join(" ");
  console.log(
    `${label.padEnd(26)} ${String(mat.envMapIntensity ?? "-").padStart(5)}  ${dimmed ? "YES   " : "no    "}  ${names}`
  );
  if (!dimmed) continue;
  const outdoors = meshes.filter((m) => m.outside === true);
  if (outdoors.length) offenders.push({ label, mat, outdoors, meshes });
}

console.log(`\n(* = mesh reaches more than ${PAD} m beyond the building envelope)\n`);

if (!offenders.length) {
  console.log("OK: no material reached by the interior IBL pass is also drawn outdoors.");
  process.exit(0);
}

console.log(`##### FAIL ##### ${offenders.length} material(s) dimmed indoors and also drawn outdoors:\n`);
for (const o of offenders) {
  const named = o.meshes.filter((m) => INTERIOR.has(m.name)).map((m) => m.name);
  console.log(`  ${o.label}  envMapIntensity ${o.mat.envMapIntensity}`);
  console.log(`    reached via interior mesh name(s): ${named.join(", ")}`);
    console.log(
      `    also drawn outdoors by:            ${o.outdoors
        .map((m) => `${m.name} (reaches ${m.by.toFixed(2)} m past the envelope)`)
        .join(", ")}`
    );
}
console.log(
  "\nSplit the material so no single instance spans inside and outside. A" +
    "\nname-keyed pass cannot do better: the mesh names are right, the sharing" +
    "\nis what makes them mean the wrong thing."
);
process.exit(1);
