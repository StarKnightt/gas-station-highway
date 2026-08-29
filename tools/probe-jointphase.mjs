#!/usr/bin/env node
/**
 * Mortar joint contrast, measured by binning rendered luma against the
 * coursing's own world-space phase rather than by folding a rectangle of
 * pixels at a guessed period.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *        tools/probe-jointphase.mjs wall shots/system2/rounds/<id>/wall.png
 *
 * WHY NOT probe-joints.mjs
 *
 * That tool folds a caller-supplied rectangle at its dominant period, and on
 * this pose it cannot work, for a reason worth writing down rather than
 * working around. Ray-casting the `wall` frame says the largest rectangle
 * containing nothing but lit front-elevation masonry is 128 x 896 px - **1.2
 * head-joint periods wide**. There is no rectangle in the frame that is three
 * whole head periods across and three bed courses tall on either elevation,
 * because the storefront glazing, the ice machine, the conduit and the ladder
 * cut every wide band of block. So the one previous attempt at this test was
 * not unlucky in its coordinates: any rectangle large enough to fold contains
 * something that is not masonry, and the 39-61 px periods it autodetected were
 * partly the mullions and partly - as it happens - the real 58.8-61.4 px bed
 * course, indistinguishably.
 *
 * WHAT THIS DOES INSTEAD
 *
 * The joint position is not a mystery to be recovered from the image. The
 * shader computes it from world position, so this recomputes the identical
 * expression per pixel and bins the rendered luma by phase within the unit:
 *
 *   - the coarse ray-cast grid establishes which pixels are exterior masonry
 *     and which elevation they belong to, and is then eroded by one cell so no
 *     sampled pixel is within 8 px of anything that is not block;
 *   - inside a surviving cell the wall is planar, so each pixel's world point
 *     comes from an exact ray-plane intersection - no interpolation, no period
 *     in pixels, and no perspective error;
 *   - `horiz`, `vert`, the running bond and both phases are copied line for
 *     line out of `bcJoints`.
 *
 * The output is the mean luma per phase bin. A joint that carries height
 * information shows a dip at phase 0 whose depth depends on the light; a joint
 * painted into the albedo shows the same dip on both elevations.
 *
 * HOW IT CAN FAIL
 *
 * Binning by a phase the shader also uses could manufacture structure, so every
 * run also bins the identical pixels against a **decoy period** at 0.63 of the
 * unit - non-harmonic, so a real joint signal cannot leak into it. The decoy
 * amplitude is the noise floor for that region, printed next to the real one.
 * A signal that is not several times its own decoy is not a measurement.
 *
 * Pure computation apart from reading the PNG. No GPU, no server.
 */
import fs from "node:fs";
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
const { PNG } = await import("pngjs");

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const SHOT = positional[0];
const PNGS = positional.slice(1);
if (!SHOT || !PNGS.length) {
  console.error("usage: probe-jointphase.mjs <shot> <png> [<png>...]");
  process.exit(2);
}
const argOf = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? Number(h.slice(n.length + 3)) : d;
};
const STEP = argOf("step", 8);
const BINS = argOf("bins", 24);
/** Non-harmonic with the unit, so a real joint cannot leak into the decoy. */
const DECOY = 0.63;

/* ---------- build the scene and the capture camera ---------- */

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
const sunDir = game.tryGet("sunDirection") ?? new THREE.Vector3(-0.9, 0.19, -0.38).normalize();
const { applyBuildingShot } = await load("src/gen/buildingShots.ts");
const { groundHeight } = await load("src/site.ts");
const { CMU } = await load("src/gen/buildingTextures.ts");

const W = 1600;
const H = 900;
applyBuildingShot(camera, SHOT, fp.floorY, groundHeight);
camera.aspect = W / H;
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
root.updateMatrixWorld(true);

const coursed = new Map();
root.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m || coursed.has(m)) continue;
    const hit = /\|bc:([a-z-]+)/.exec(m.customProgramCacheKey?.call(m) ?? "");
    if (hit) coursed.set(m, hit[1]);
  }
});

/* ---------- coarse mask ---------- */

const gw = Math.floor(W / STEP);
const gh = Math.floor(H / STEP);
const cls = new Uint8Array(gw * gh); // 0 none, 1 lit front (-Z), 2 shaded east (+X)
const planeP = new Float64Array(gw * gh * 3);
const planeN = new Float64Array(gw * gh * 3);
const ray = new THREE.Raycaster();
ray.camera = camera;
const ndc = new THREE.Vector2();

for (let gy = 0; gy < gh; gy++) {
  for (let gx = 0; gx < gw; gx++) {
    ndc.set(((gx * STEP + STEP / 2) / W) * 2 - 1, 1 - ((gy * STEP + STEP / 2) / H) * 2);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(root, true);
    if (!hits.length) continue;
    const h = hits[0];
    const mat = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    const key = coursed.get(mat);
    if (!key || key === "cmu-int") continue;
    const n = h.face?.normal?.clone().transformDirection(h.object.matrixWorld);
    if (!n) continue;
    const c = n.z < -0.7 ? 1 : n.x > 0.7 ? 2 : 0;
    if (!c) continue;
    const i = gy * gw + gx;
    cls[i] = c;
    planeP[i * 3] = h.point.x;
    planeP[i * 3 + 1] = h.point.y;
    planeP[i * 3 + 2] = h.point.z;
    planeN[i * 3] = n.x;
    planeN[i * 3 + 1] = n.y;
    planeN[i * 3 + 2] = n.z;
  }
}

/**
 * Erode by one cell. A pixel is only sampled if every 8-neighbour of its cell
 * is the same elevation of masonry, so nothing within 8 px of a mullion, the
 * corner arris, the ladder or the ice machine can enter a bin. This is the
 * whole defence against the previous attempt's failure and it is cheap.
 */
const keep = new Uint8Array(gw * gh);
for (let gy = 1; gy < gh - 1; gy++) {
  for (let gx = 1; gx < gw - 1; gx++) {
    const i = gy * gw + gx;
    const c = cls[i];
    if (!c) continue;
    let ok = 1;
    for (let dy = -1; dy <= 1 && ok; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (cls[i + dy * gw + dx] !== c) {
          ok = 0;
          break;
        }
    keep[i] = ok ? c : 0;
  }
}
const kept = [0, 0, 0];
for (const k of keep) kept[k]++;

/* ---------- per-pixel phase ---------- */

const camPos = camera.position;
const dirCache = new THREE.Vector3();
const world = new THREE.Vector3();

function worldAt(px, py, i) {
  ndc.set((px / W) * 2 - 1, 1 - (py / H) * 2);
  dirCache.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camPos).normalize();
  const nx = planeN[i * 3];
  const ny = planeN[i * 3 + 1];
  const nz = planeN[i * 3 + 2];
  const den = dirCache.x * nx + dirCache.y * ny + dirCache.z * nz;
  if (Math.abs(den) < 1e-6) return null;
  const t =
    ((planeP[i * 3] - camPos.x) * nx + (planeP[i * 3 + 1] - camPos.y) * ny + (planeP[i * 3 + 2] - camPos.z) * nz) / den;
  if (t <= 0) return null;
  return world.copy(camPos).addScaledVector(dirCache, t);
}

/** Copied from bcJoints in src/gen/buildingCoursing.ts. */
function phases(p, klass) {
  const horiz = klass === 1 ? p.x : p.z; // |n.x| > |n.z| picks Z, else X
  const vert = p.y;
  const course = Math.floor(vert / CMU.unitY);
  const bond = (((course % 2) + 2) % 2) * 0.5 * CMU.unitX;
  const fu = (((horiz + bond) / CMU.unitX) % 1 + 1) % 1;
  const fv = ((vert / CMU.unitY) % 1 + 1) % 1;
  return [fu, fv];
}

function analyse(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  if (png.width !== W || png.height !== H) throw new Error(`${file}: expected ${W}x${H}`);
  const acc = {};
  for (const k of [1, 2])
    acc[k] = {
      head: new Float64Array(BINS),
      headN: new Float64Array(BINS),
      bed: new Float64Array(BINS),
      bedN: new Float64Array(BINS),
      decoy: new Float64Array(BINS),
      decoyN: new Float64Array(BINS),
      cells: new Map(),
      n: 0,
      sum: 0,
    };

  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const i = gy * gw + gx;
      const c = keep[i];
      if (!c) continue;
      const a = acc[c];
      for (let dy = 0; dy < STEP; dy++) {
        const py = gy * STEP + dy;
        for (let dx = 0; dx < STEP; dx++) {
          const px = gx * STEP + dx;
          const p = worldAt(px + 0.5, py + 0.5, i);
          if (!p) continue;
          const o = (py * W + px) * 4;
          const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
          const [fu, fv] = phases(p, c);
          const horiz = c === 1 ? p.x : p.z;
          const fd = (((horiz / (CMU.unitX * DECOY)) % 1) + 1) % 1;
          const bu = Math.min(BINS - 1, Math.floor(fu * BINS));
          const bv = Math.min(BINS - 1, Math.floor(fv * BINS));
          const bd = Math.min(BINS - 1, Math.floor(fd * BINS));
          a.head[bu] += l;
          a.headN[bu]++;
          a.bed[bv] += l;
          a.bedN[bv]++;
          a.decoy[bd] += l;
          a.decoyN[bd]++;
          a.n++;
          a.sum += l;

          // Per-unit tone, block face only. The arris runs to 2.4x the joint
          // half-width, so 0.2..0.8 of the cell is clear of both the joint and
          // its shoulder and carries only the unit's own colour.
          if (fu > 0.2 && fu < 0.8 && fv > 0.2 && fv < 0.8) {
            const course = Math.floor(p.y / CMU.unitY);
            const bond = (((course % 2) + 2) % 2) * 0.5 * CMU.unitX;
            const ui = Math.floor((horiz + bond) / CMU.unitX);
            const cellKey = `${course}|${ui}`;
            const cur = a.cells.get(cellKey);
            if (cur) {
              cur[0] += l;
              cur[1]++;
            } else a.cells.set(cellKey, [l, 1]);
          }
        }
      }
    }
  }
  return acc;
}

const profile = (sum, n) => {
  const out = new Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = n[i] ? sum[i] / n[i] : NaN;
  return out;
};
const amp = (p) => {
  const v = p.filter(Number.isFinite);
  return v.length ? Math.max(...v) - Math.min(...v) : NaN;
};
/** Where the minimum sits, in phase units. A real joint minimum sits near 0. */
const argmin = (p) => {
  let bi = 0;
  let bv = Infinity;
  for (let i = 0; i < p.length; i++)
    if (Number.isFinite(p[i]) && p[i] < bv) {
      bv = p[i];
      bi = i;
    }
  return bi / p.length;
};

const NAMES = { 1: "LIT   front elevation (-Z)", 2: "SHADED east elevation (+X)" };

/**
 * Does the wall still repeat at the albedo tile period?
 *
 * `unitVariation` is keyed on the world block index, so raising it was claimed
 * to break the 1.6256 m (4-unit) texture tile as a side effect. Phase-binning
 * cannot test that - a per-block random offset averages out over many blocks
 * and leaves the tile-phase profile flat whether the tile repeats or not.
 *
 * The test that can is a lag correlation over the per-unit tone map. Each
 * course is de-meaned first, so a lighting gradient along the wall cannot
 * masquerade as periodicity. If the albedo tile is intact, two blocks exactly
 * 4 units apart draw the same texels and must correlate far better than blocks
 * 3 or 5 apart. If the per-block hash dominates, lag 4 is unremarkable.
 */
function tilePeriod(cells) {
  const byCourse = new Map();
  for (const [k, [sum, n]] of cells) {
    if (n < 12) continue; // too few pixels for a stable per-unit tone
    const [c, u] = k.split("|").map(Number);
    if (!byCourse.has(c)) byCourse.set(c, new Map());
    byCourse.get(c).set(u, sum / n);
  }
  // De-mean per course: removes the vertical lighting gradient and the
  // per-course dirt band, neither of which is a horizontal period.
  for (const row of byCourse.values()) {
    const vals = [...row.values()];
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    for (const [u, v] of row) row.set(u, v - m);
  }
  let units = 0;
  let ss = 0;
  for (const row of byCourse.values())
    for (const v of row.values()) {
      units++;
      ss += v * v;
    }
  const sd = units ? Math.sqrt(ss / units) : 0;
  const out = [];
  for (let lag = 1; lag <= 8; lag++) {
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    let n = 0;
    for (const row of byCourse.values())
      for (const [u, a] of row) {
        const b = row.get(u + lag);
        if (b === undefined) continue;
        sxy += a * b;
        sxx += a * a;
        syy += b * b;
        n++;
      }
    out.push({ lag, n, r: n > 8 && sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN });
  }
  return { courses: byCourse.size, units, sd, lags: out };
}

console.log(
  `\nshot ${SHOT}   grid ${gw}x${gh} @ ${STEP}px   ` +
    `masonry cells after erosion: front ${kept[1]}, east ${kept[2]}`
);
console.log(`unit ${CMU.unitX} x ${CMU.unitY} m, joint ${(CMU.joint * 1000).toFixed(1)} mm`);
console.log(`sun dir (${sunDir.x.toFixed(3)}, ${sunDir.y.toFixed(3)}, ${sunDir.z.toFixed(3)})`);

const results = [];
for (const f of PNGS) {
  const acc = analyse(f);
  console.log(`\n=== ${f}`);
  const row = { file: f };
  for (const k of [1, 2]) {
    const a = acc[k];
    if (!a.n) {
      console.log(`  ${NAMES[k]}: no pixels`);
      continue;
    }
    const mean = a.sum / a.n;
    const hp = profile(a.head, a.headN);
    const bp = profile(a.bed, a.bedN);
    const dp = profile(a.decoy, a.decoyN);
    const hc = (amp(hp) / mean) * 100;
    const bc = (amp(bp) / mean) * 100;
    const dc = (amp(dp) / mean) * 100;
    row[k] = { mean, hc, bc, dc };
    console.log(`  ${NAMES[k]}   ${a.n} px   mean luma ${mean.toFixed(1)}`);
    console.log(
      `    head-joint contrast ${hc.toFixed(2)}%   min at phase ${argmin(hp).toFixed(2)}` +
        `      bed-joint contrast ${bc.toFixed(2)}%   min at phase ${argmin(bp).toFixed(2)}`
    );
    console.log(`    decoy @${DECOY}x unit  ${dc.toFixed(2)}%   <- noise floor for this region`);
    console.log(`    head profile ${hp.map((v) => (Number.isFinite(v) ? v.toFixed(0).padStart(4) : "   -")).join("")}`);
    console.log(`    bed  profile ${bp.map((v) => (Number.isFinite(v) ? v.toFixed(0).padStart(4) : "   -")).join("")}`);
    const tp = tilePeriod(a.cells);
    console.log(
      `    per-unit tone: ${tp.units} block faces over ${tp.courses} courses, ` +
        `sd ${tp.sd.toFixed(2)} luma (${((tp.sd / mean) * 100).toFixed(1)}% of mean)`
    );
    console.log(
      `    lag correlation along the course (4 = albedo tile period 1.6256 m):\n      ` +
        tp.lags
          .map((L) => `${L.lag}:${Number.isFinite(L.r) ? L.r.toFixed(2) : " n/a"}${L.lag === 4 ? "*" : " "}`)
          .join("  ")
    );
  }
  if (row[1] && row[2]) {
    console.log(
      `\n  TWO-LIGHT-ANGLE RATIO  head lit/shaded ${(row[1].hc / row[2].hc).toFixed(2)}` +
        `   bed lit/shaded ${(row[1].bc / row[2].bc).toFixed(2)}`
    );
    console.log(
      `  WITHIN-ELEVATION       head/bed lit ${(row[1].hc / row[1].bc).toFixed(2)}` +
        `   head/bed shaded ${(row[2].hc / row[2].bc).toFixed(2)}`
    );
  }
  results.push(row);
}

if (results.length > 1) {
  console.log(`\n=== ACROSS FILES (same build, one knob) ===`);
  for (const k of [1, 2]) {
    const line = results
      .map((r) => (r[k] ? `${path.basename(r.file)} head ${r[k].hc.toFixed(2)}% bed ${r[k].bc.toFixed(2)}%` : ""))
      .join("   |   ");
    console.log(`  ${NAMES[k]}:  ${line}`);
  }
}
console.log("");
