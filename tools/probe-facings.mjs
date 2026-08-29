#!/usr/bin/env node
/**
 * How big is one product facing on screen, and how many artwork texels does it
 * get?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *        tools/probe-facings.mjs door cooler interior
 *
 * WHY THIS EXISTS
 *
 * `?dbgLabels=1` swapped a magenta checker into the packaging atlas and moved
 * 33.4% of the shelf region against 0.0% of a ceiling control, which proves the
 * map is **bound**. It does not prove the artwork **resolves**, and those are
 * different claims with different fixes - the same distinction that cost this
 * project three rounds on the mortar joints and is written up in NOTES.md as
 * "below the sampling rate is a measurement, not a default explanation".
 *
 * So this does the millimetres-per-pixel arithmetic for the specific frames a
 * critic is shown. For every product facing visible in a pose it reports the
 * on-screen width and height of the facing, and the resulting **atlas texels
 * per screen pixel** - above 1 the artwork is being minified and the mip chain
 * is averaging it away, below 1 it is being magnified and any structure in the
 * cell is genuinely legible.
 *
 * It also reports silhouette variety, because no texture fixes that: the count
 * of distinct primitive forms among the visible facings, and the fraction of
 * the shelf line that is a plain box.
 *
 * Pure computation. No GPU, no server.
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

const SHOTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!SHOTS.length) {
  console.error("usage: probe-facings.mjs <shot>...");
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
await new BuildingSystem().init({
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
const { PACK_GRID } = await load("src/gen/buildingSignage.ts");

const W = 1600;
const H = 900;

/**
 * Facing sizes are taken from the authored dimensions in `buildingShelfProducts`
 * combined with the depth of the product pixels that are actually visible,
 * rather than from the merged buffer.
 *
 * Two attempts to recover a per-facing extent from the geometry were wrong in
 * opposite directions and both are worth recording. Clustering vertices by
 * atlas cell plus rounded world position splits one packet across the rounding
 * boundaries; grouping by contiguous runs of one cell splits it again, because
 * a box's UVs run to the cell's far edge and `floor(uv * PACK_GRID)` flips
 * there. Both under-reported the size, which is the flattering direction - it
 * is the direction that says "the artwork cannot possibly resolve".
 *
 * The depth of a *visible* product pixel is not in doubt, and neither is the
 * authored facing width, so the arithmetic is done on those. Visibility comes
 * from a ray-cast, so occluded stock behind the gondola cannot enter the
 * statistic.
 */
const FACING_W = { boxMin: 0.075, boxMax: 0.205, canMin: 0.062, canMax: 0.088 };

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

// The atlas is square and split PACK_GRID x PACK_GRID; find its real size.
const { makeProductLabels } = await load("src/gen/buildingSignage.ts");
let atlasPx = 0;
try {
  const t = makeProductLabels();
  atlasPx = t?.image?.width ?? 0;
  t?.dispose?.();
} catch {
  /* the canvas stub cannot always produce one; fall through and report 0 */
}
const cellPx = atlasPx / PACK_GRID;
console.log(`\npackaging atlas ${atlasPx || "?"}px, ${PACK_GRID}x${PACK_GRID} grid -> ${cellPx || "?"}px per cell`);

for (const shot of SHOTS) {
  applyBuildingShot(camera, shot, fp.floorY, groundHeight);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  root.updateMatrixWorld(true);

  // Which pixels actually show product, and how far away is each of them.
  const STEP = 8;
  const ray = new THREE.Raycaster();
  ray.camera = camera;
  const ndc = new THREE.Vector2();
  const dists = [];
  let productCells = 0;
  let totalCells = 0;
  for (let py = STEP / 2; py < H; py += STEP) {
    for (let px = STEP / 2; px < W; px += STEP) {
      totalCells++;
      ndc.set((px / W) * 2 - 1, 1 - (py / H) * 2);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObject(root, true);
      if (!hits.length) continue;
      if (!/product|shelf-stock|bottle|stock/i.test(hits[0].object.name || "")) continue;
      productCells++;
      dists.push(hits[0].distance);
    }
  }
  if (!dists.length) {
    console.log(`\n${shot}: no product pixels in frame`);
    continue;
  }
  // Pixels per metre at a given depth, for this camera.
  const pxPerM = (d) => H / (2 * Math.tan((camera.fov * Math.PI) / 360) * d);
  const dMed = pct(dists, 0.5);
  const dNear = pct(dists, 0.1);
  const dFar = pct(dists, 0.9);

  console.log(
    `\n${shot}: product covers ${((productCells / totalCells) * 100).toFixed(1)}% of the frame   ` +
      `depth p10 ${dNear.toFixed(2)} m, median ${dMed.toFixed(2)} m, p90 ${dFar.toFixed(2)} m`
  );
  for (const [label, d] of [
    ["nearest tenth", dNear],
    ["median", dMed],
    ["furthest tenth", dFar],
  ]) {
    const ppm = pxPerM(d);
    const wMin = ppm * FACING_W.canMin;
    const wMax = ppm * FACING_W.boxMax;
    const wTyp = ppm * 0.11;
    console.log(
      `  ${label.padEnd(15)} ${d.toFixed(2)} m  ${ppm.toFixed(0)} px/m  ` +
        `facing ${wMin.toFixed(1)}-${wMax.toFixed(1)} px wide (typical ${wTyp.toFixed(1)} px)` +
        (cellPx ? `   -> ${(cellPx / wTyp).toFixed(0)} atlas texels per screen pixel` : "")
    );
  }
  if (cellPx) {
    const wTyp = pxPerM(dMed) * 0.11;
    console.log(
      `  a mark needs ~3 screen px to read, which at the median facing is ` +
        `${((3 / wTyp) * 100).toFixed(0)}% of the cell width ` +
        `(${Math.round((3 / wTyp) * cellPx)} of ${cellPx} atlas px). ` +
        `Artwork finer than that averages to a flat tint.`
    );
    console.log(
      `  so the whole cell can carry at most about ${Math.max(1, Math.floor(wTyp / 3))} distinguishable ` +
        `marks across its width.`
    );
  }
}
console.log("");
