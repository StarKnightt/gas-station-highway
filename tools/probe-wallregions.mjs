#!/usr/bin/env node
/**
 * Find masonry-only measurement regions in a capture, by ray-casting rather
 * than by choosing coordinates.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *        tools/probe-wallregions.mjs wall
 *
 * WHY THIS EXISTS
 *
 * The two-light-angle test for the mortar joints needs two rectangles: one on
 * the lit front elevation and one on the shaded east elevation, both containing
 * nothing but block. The one previous attempt at that test placed them by eye
 * and caught the access ladder, a conduit run, the runoff streaks and the
 * storefront glazing, and the periods it autodetected (39-61 px) correspond to
 * nothing in the coursing. Inconclusive, and inconclusive in the expensive
 * direction: it looked like a measurement.
 *
 * So this places them from the scene instead. It casts a ray through the real
 * capture camera at every point of a coarse grid, records which mesh was hit
 * and which way its surface faces, and reports the largest axis-aligned
 * rectangles that are *entirely* one elevation of exterior masonry. It then
 * projects the real unit size at each region's own depth, so the bed and head
 * periods handed to `probe-joints.mjs --bed/--head` come from geometry and not
 * from the image.
 *
 * Pure computation. No GPU, no server, nothing to tear down.
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

const argv = process.argv.slice(2);
const SHOT = argv.find((a) => !a.startsWith("--")) ?? "wall";
const argOf = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? Number(h.slice(n.length + 3)) : d;
};
/** Grid step in pixels. 8 px over 1600x900 is 22k casts and takes a few seconds. */
const STEP = argOf("step", 8);

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
applyBuildingShot(camera, SHOT, fp.floorY, groundHeight);
camera.aspect = W / H;
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
root.updateMatrixWorld(true);

/**
 * The masonry materials carry a coursing injection and record their key on
 * `userData`, so "is this pixel block" is answered by the material that will
 * actually draw it rather than by a mesh-name guess. `applyBuildingCoursing`
 * is the only thing that sets `customProgramCacheKey` with a `bc:` term, and it
 * also stashes the shader; the key is read back off the closure below.
 */
const coursed = new Map(); // material -> key
root.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m || coursed.has(m)) continue;
    const key = m.customProgramCacheKey?.call(m) ?? "";
    const hit = /\|bc:([a-z-]+)/.exec(key);
    if (hit) coursed.set(m, hit[1]);
  }
});
if (!coursed.size) {
  console.error("no coursed materials found - applyBuildingCoursing is not reaching any material");
  process.exit(1);
}
console.log(`coursed materials: ${[...new Set(coursed.values())].join(", ")}`);

const gw = Math.floor(W / STEP);
const gh = Math.floor(H / STEP);
/** 0 = not masonry, 1 = front elevation (-Z), 2 = east elevation (+X), 3 = other masonry face */
const cls = new Uint8Array(gw * gh);
const depth = new Float32Array(gw * gh);
const ray = new THREE.Raycaster();
ray.camera = camera;
const ndc = new THREE.Vector2();
const other = new Map();

for (let gy = 0; gy < gh; gy++) {
  for (let gx = 0; gx < gw; gx++) {
    const px = gx * STEP + STEP / 2;
    const py = gy * STEP + STEP / 2;
    ndc.set((px / W) * 2 - 1, 1 - (py / H) * 2);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(root, true);
    if (!hits.length) continue;
    const h = hits[0];
    const mat = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    const key = coursed.get(mat);
    const i = gy * gw + gx;
    depth[i] = h.distance;
    if (!key || key === "cmu-int") {
      const nm = h.object.name || "(unnamed)";
      other.set(nm, (other.get(nm) ?? 0) + 1);
      continue;
    }
    const n = h.face?.normal?.clone().transformDirection(h.object.matrixWorld);
    if (!n) continue;
    if (n.z < -0.7) cls[i] = 1;
    else if (n.x > 0.7) cls[i] = 2;
    else cls[i] = 3;
  }
}

const counts = [0, 0, 0, 0];
for (const c of cls) counts[c]++;
console.log(
  `\n${SHOT}: grid ${gw}x${gh} at ${STEP}px  ` +
    `front(-Z) ${counts[1]}  east(+X) ${counts[2]}  other-masonry-face ${counts[3]}  non-masonry ${counts[0]}`
);
console.log("  top occluders / non-masonry meshes in frame:");
for (const [n, c] of [...other].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(c).padStart(5)} cells  ${n}`);
}

/**
 * Largest all-one-class axis-aligned rectangle, by the standard
 * largest-rectangle-in-histogram sweep. "Largest" is deliberately not "the one
 * I like the look of".
 */
function largestRect(want, minW = 0, minH = 0) {
  const heights = new Int32Array(gw);
  let best = null;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) heights[gx] = cls[gy * gw + gx] === want ? heights[gx] + 1 : 0;
    const stack = [];
    for (let gx = 0; gx <= gw; gx++) {
      const h = gx === gw ? 0 : heights[gx];
      let start = gx;
      while (stack.length && stack[stack.length - 1].h >= h) {
        const top = stack.pop();
        const w = gx - top.i;
        const area = top.h * w;
        // A fold needs at least three whole periods along the axis it folds,
        // so the *largest* rectangle is often the wrong one: on this pose it is
        // a full-height strip 1.2 head periods wide, which cannot measure head
        // joints at all. Constrain the shape, then maximise area inside it.
        if (w * STEP >= minW && top.h * STEP >= minH && (!best || area > best.area)) {
          best = { area, x0: top.i, y1: gy, w, h: top.h };
        }
        start = top.i;
      }
      stack.push({ i: start, h });
    }
  }
  if (!best) return null;
  return {
    x: best.x0 * STEP,
    y: (best.y1 - best.h + 1) * STEP,
    w: best.w * STEP,
    h: best.h * STEP,
    cells: best.area,
  };
}

/** Pixels subtended by a world-space offset `d` at a point on the wall. */
function projectPeriod(worldPoint, dir, metres) {
  const a = worldPoint.clone().project(camera);
  const b = worldPoint.clone().addScaledVector(dir, metres).project(camera);
  const ax = ((a.x + 1) / 2) * W;
  const ay = ((1 - a.y) / 2) * H;
  const bx = ((b.x + 1) / 2) * W;
  const by = ((1 - b.y) / 2) * H;
  return Math.hypot(bx - ax, by - ay);
}

/** World point under a pixel, for period projection at the region's own depth. */
function pointAt(px, py) {
  ndc.set((px / W) * 2 - 1, 1 - (py / H) * 2);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(root, true);
  return hits.length ? hits[0].point.clone() : null;
}

const CMU = (await load("src/gen/buildingTextures.ts")).CMU;
const NAMES = { 1: "LIT front elevation (-Z)", 2: "SHADED east elevation (+X)" };
const sun = game.tryGet("sunDirection");

console.log(
  `\nunit ${CMU.unitX} x ${CMU.unitY} m, joint ${(CMU.joint * 1000).toFixed(1)} mm` +
    (sun ? `   sun dir (${sun.x.toFixed(3)}, ${sun.y.toFixed(3)}, ${sun.z.toFixed(3)})` : "")
);

/** Whole periods required along each axis before a fold means anything. */
const MIN_PERIODS = 3.5;

const measure = (r, want) => {
  const p = pointAt(r.x + r.w / 2, r.y + r.h / 2);
  if (!p) return null;
  const horiz = want === 1 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  return {
    p,
    headPx: projectPeriod(p, horiz, CMU.unitX),
    bedPx: projectPeriod(p, up, CMU.unitY),
    headJointPx: projectPeriod(p, horiz, CMU.joint),
    bedJointPx: projectPeriod(p, up, CMU.joint),
  };
};

for (const want of [1, 2]) {
  const seed = largestRect(want);
  if (!seed) {
    console.log(`\n  ${NAMES[want]}: no clean rectangle found`);
    continue;
  }
  // Two passes: the unconstrained rectangle only supplies a period estimate,
  // then the shape constraint is applied in the units that estimate gives.
  const est = measure(seed, want);
  const r = est
    ? (largestRect(want, MIN_PERIODS * est.headPx, MIN_PERIODS * est.bedPx) ?? seed)
    : seed;
  const m = measure(r, want) ?? est;
  console.log(`\n  ${NAMES[want]}`);
  console.log(`    region            ${r.x},${r.y},${r.w},${r.h}   (${r.cells} grid cells, all one class)`);
  if (!m) continue;
  console.log(
    `    centre world      (${m.p.x.toFixed(2)}, ${m.p.y.toFixed(2)}, ${m.p.z.toFixed(2)})  ` +
      `${m.p.distanceTo(camera.position).toFixed(2)} m from camera`
  );
  console.log(`    bed  period ${m.bedPx.toFixed(2)} px   joint ${m.bedJointPx.toFixed(2)} px wide on screen`);
  console.log(`    head period ${m.headPx.toFixed(2)} px   joint ${m.headJointPx.toFixed(2)} px wide on screen`);
  console.log(`    whole periods in region:  bed ${(r.h / m.bedPx).toFixed(1)}   head ${(r.w / m.headPx).toFixed(1)}`);
  console.log(
    `    probe-joints.mjs <png> ${r.x},${r.y},${r.w},${r.h} --bed ${Math.round(m.bedPx)} --head ${Math.round(m.headPx)}`
  );
}
console.log("");
