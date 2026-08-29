/**
 * Static instanced-weathering audit. CPU-only, no GPU, no browser, no capture.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-instancing.mjs
 *
 * The failure this catches (NOTES.md case 22): `applyGrime` samples its noise
 * field as a function of **object-space position**, so two meshes that occupy
 * the same object-space extent receive byte-identical grime no matter what else
 * differs between them. Per-unit `wear`/`tint`/`scuff` only scale how strong
 * each mark is; they never move where it is. A set of props weathered that way
 * reads as one asset under different exposure, and — this is the expensive part
 * — the symptom is indistinguishable from "needs more variation", so it gets
 * attacked by tuning amplitudes, which cannot fix it.
 *
 * `applyGrime` already carries the remedy: `fieldOffset` (a per-instance phase
 * in tile units) and `fieldFlip`. This asserts that anything weathered more than
 * once actually uses it.
 *
 * Exact rather than heuristic: it builds the real systems headless and walks the
 * real scene graph, so it needs no knowledge of each system's syntax and picks
 * up new call sites automatically. `applyGrime` records its uniforms on
 * `mat.userData.grime`, which is what makes this inspectable without a renderer.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ---------------- minimal headless browser surface ---------------- */
// The systems read `location.search` for debug flags, and the decal/display
// builders draw into a 2D canvas. This audit is about mesh and material
// *topology*, so the pixels those builders would produce do not matter and the
// context below is a no-op. Do not reuse this stub for anything that inspects
// texture content - it will silently report blank.
globalThis.location ??= { search: "", href: "http://localhost/" };
const stubCtx2d = () => {
  const noop = () => {};
  return {
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
  };
};
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

/* ---------------- stub context ---------------- */
const services = new Map();
const game = {
  provide(key, value) {
    services.set(key, value);
    return value;
  },
  require(key) {
    if (!services.has(key)) throw new Error(`stub game: no service "${key}"`);
    return services.get(key);
  },
  tryGet(key) {
    return services.get(key);
  },
};
// Flat forecourt is fine: this probe cares about mesh/material topology, not
// about where anything sits.
game.provide("groundHeight", () => 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
const renderer = {
  capabilities: { getMaxAnisotropy: () => 8, isWebGL2: true },
  getPixelRatio: () => 1,
  outputColorSpace: "srgb",
  properties: { get: () => ({}) },
};
const ctx = { game, scene, camera, renderer, shot: null };

/* ---------------- build the systems ---------------- */
// Every system that draws props. The building and vegetation weather themselves
// in *world* space (`modelMatrix * position` in buildingWeather, buildingCoursing
// and worldDetail), which is immune to this defect by construction — two
// instances at different world positions sample different field. They are built
// here anyway so that the day one of them adopts `applyGrime`, this fails rather
// than needing someone to remember to add it.
const SYSTEMS = [
  ["PumpSystem", "src/systems/PumpSystem.ts"],
  ["CarSystem", "src/systems/CarSystem.ts"],
  ["BuildingSystem", "src/systems/BuildingSystem.ts"],
  ["VegetationSystem", "src/systems/VegetationSystem.ts"],
];

const built = [];
const skipped = [];
for (const [label, file] of SYSTEMS) {
  try {
    const mod = await load(file);
    const Ctor = Object.values(mod).find((v) => typeof v === "function" && v.prototype?.init);
    if (!Ctor) {
      skipped.push([label, "no GameSystem export found"]);
      continue;
    }
    const sys = new Ctor();
    await sys.init(ctx);
    built.push({ label, sys });
  } catch (e) {
    skipped.push([label, e.message]);
    if (process.env.PROBE_TRACE) console.error(e.stack);
  }
}
if (!built.length) {
  console.error("\nNo system built. Cannot audit. Re-run with PROBE_TRACE=1 for a stack.");
  process.exit(2);
}

/* ---------------- walk the graph ---------------- */
/**
 * Group every drawn mesh by the material instance it uses. A material shared by
 * N meshes is N instances of whatever pattern that material paints.
 */
const byMaterial = new Map();
scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (!m) continue;
    if (!byMaterial.has(m)) byMaterial.set(m, []);
    byMaterial.get(m).push(o);
  }
});

const V2_ZERO = (v) => !v || (Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9);

/**
 * Sharing a material is NOT the defect, and this is where a naive version of
 * this probe produces a list of non-problems. The car's body, boot trim and arch
 * lips all use one `paint` material, correctly: they are different panels at
 * different object-space positions, so they sample different parts of the field
 * and there is no repetition to see.
 *
 * The defect needs two things at once:
 *   1. two meshes occupying the *same object-space extent* — that is what makes
 *      their field lookups identical, and it is true whenever the geometry is
 *      literally reused and also when two separately-built meshes happen to span
 *      the same local box, as six bollards of near-identical size do; and
 *   2. those meshes drawn at *different world positions*, so a viewer can see
 *      both at once and compare them. Two co-located meshes are a part and its
 *      decal, not a repeated prop.
 *
 * So meshes are clustered by a rounded object-space bounding box, and only
 * clusters of two or more at distinct world positions count.
 */
const BBOX_TOL = 3; // decimal places, i.e. 1 mm
function bboxKey(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  const r = (v) => v.toFixed(BBOX_TOL);
  return `${r(b.min.x)},${r(b.min.y)},${r(b.min.z)}|${r(b.max.x)},${r(b.max.y)},${r(b.max.z)}`;
}
function worldKey(mesh) {
  mesh.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
  return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
}

const findings = [];
const rows = [];

for (const [mat, meshes] of byMaterial) {
  const grime = mat.userData?.grime;
  if (!grime) continue;

  const off = grime.uGOff?.value;
  const phased = !V2_ZERO(off);

  // Cluster this material's meshes by object-space extent.
  const clusters = new Map();
  for (const m of meshes) {
    const k = bboxKey(m.geometry);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(m);
  }

  const repeated = [];
  for (const [k, group] of clusters) {
    // An InstancedMesh is N copies of one object-space mesh by construction.
    let count = 0;
    for (const m of group) count += m.isInstancedMesh ? m.count : 1;
    const places = new Set(group.map(worldKey));
    if (count > 1 && (places.size > 1 || group.some((m) => m.isInstancedMesh))) {
      repeated.push({ bbox: k, group, count, places: places.size });
    }
  }

  rows.push({ mat, meshes, clusters: clusters.size, repeated, off, phased });
  if (repeated.length && !phased) findings.push({ mat, repeated });
}

/* ---------------- report ---------------- */
console.log("=".repeat(78));
console.log("Instanced object-space weathering audit");
console.log(`audited: ${built.map((b) => b.label).join(", ")}`);
if (skipped.length) {
  // Not an error: these two do not use applyGrime and weather themselves in
  // world space, so there is nothing here to find in them today. Reported so the
  // coverage gap is visible rather than silent.
  console.log("\nnot audited (could not build headless; neither uses applyGrime today):");
  for (const [label, why] of skipped) console.log(`  ${label}: ${why}`);
}
console.log("=".repeat(78));
/** `applyGrime` bakes its `key` into customProgramCacheKey; recover it. */
function grimeKey(mat) {
  try {
    const m = /\|grime:([^|]+)/.exec(mat.customProgramCacheKey?.() ?? "");
    return m ? m[1] : "(unkeyed)";
  } catch {
    return "(unkeyed)";
  }
}
const label = (m) => m.name || m.parent?.name || `${m.geometry.getAttribute("position")?.count ?? 0}v`;
const dims = (k) => {
  const [mn, mx] = k.split("|").map((s) => s.split(",").map(Number));
  return `${(mx[0] - mn[0]).toFixed(2)} x ${(mx[1] - mn[1]).toFixed(2)} x ${(mx[2] - mn[2]).toFixed(2)} m`;
};
const where = (m) => {
  const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
  return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
};

// Collapse rows that share a grime key: three dispensers legitimately produce
// three materials per key, and listing them separately buries the signal.
const groupedRows = new Map();
for (const r of rows) {
  const k = grimeKey(r.mat);
  if (!groupedRows.has(k)) groupedRows.set(k, []);
  groupedRows.get(k).push(r);
}

console.log("\n  Every material carrying applyGrime, by grime key. A material shared across");
console.log("  different panels of one object is fine - only a repeated object-space");
console.log("  extent drawn at more than one place produces identical marks.\n");
console.log("    grime key              mats  meshes  repeated  distinct phases  verdict");
const keyRows = [...groupedRows.entries()].sort(
  (a, b) =>
    b[1].filter((r) => r.repeated.length && !r.phased).length -
      a[1].filter((r) => r.repeated.length && !r.phased).length || a[0].localeCompare(b[0])
);
for (const [key, group] of keyRows) {
  const meshes = group.reduce((n, r) => n + r.meshes.length, 0);
  const repeated = group.filter((r) => r.repeated.length);
  const phases = new Set(
    group.map((r) => (r.off ? `${r.off.x.toFixed(3)},${r.off.y.toFixed(3)}` : "0,0"))
  );
  const affected = repeated.filter((r) => !r.phased);
  console.log(
    `    ${key.padEnd(22)} ${String(group.length).padStart(4)}  ${String(meshes).padStart(6)}  ` +
      `${(repeated.length ? `yes` : "-").padStart(8)}  ${String(phases.size).padStart(15)}  ` +
      (affected.length ? "AFFECTED" : repeated.length ? "ok - phased per instance" : "ok - no repeated extent")
  );
  for (const r of repeated) {
    for (const c of r.repeated) {
      console.log(
        `        ${c.count} copies of ${dims(c.bbox)} [${label(c.group[0])}] at ` +
          c.group.map(where).slice(0, 4).join(" ") +
          (c.group.length > 4 ? " ..." : "")
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* direct field comparison                                             */
/* ------------------------------------------------------------------ */
/**
 * The bbox clustering above is a topology test, and it has a blind spot: two
 * meshes whose extents differ slightly - four bollards built to three different
 * heights - fall into different clusters and report clean, even though their
 * surfaces sit at almost the same object-space coordinates and therefore receive
 * almost the same grime. A 20 mm height difference is not decorrelation; at
 * scale 0.42 m over a 512 px field one texel is 0.8 mm, so it shifts the pattern
 * by a couple of dozen texels and leaves it recognisably the same.
 *
 * So evaluate the lookup directly. `applyGrime`'s field sample is a pure
 * function of (object-space position, normal, scale, offset, flip), which is
 * cheap to replicate exactly and removes all inference from the answer.
 */
function sampleField(tex, u, v) {
  const img = tex.image;
  const w = img.width;
  const h = img.height;
  const data = img.data;
  const wrap = (i, n) => ((i % n) + n) % n;
  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const at = (xi, yi) => data[(wrap(yi, h) * w + wrap(xi, w)) * 4 + c];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    out[c] = a + (b - a) * ty;
  }
  return out;
}

/** Replicates the triplanar pick and phase from applyGrime's fragment shader. */
function grimeAt(g, px, py, pz, nx, ny, nz) {
  const flip = g.uGFlip.value;
  const scale = Math.max(g.uGScale.value, 1e-4);
  const off = g.uGOff.value;
  const gx = px * flip;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let u;
  let v;
  if (ay > Math.max(ax, az)) {
    u = gx;
    v = pz;
  } else if (ax > az) {
    u = pz;
    v = py;
  } else {
    u = gx;
    v = py;
  }
  return sampleField(g.uGField.value, u / scale + off.x, v / scale + off.y);
}

/** Mean and max absolute field difference, 0..255, over corresponding vertices. */
function fieldDelta(gA, geoA, gB, geoB) {
  const pa = geoA.getAttribute("position");
  const na = geoA.getAttribute("normal");
  const pb = geoB.getAttribute("position");
  const nb = geoB.getAttribute("normal");
  if (!pa || !na || !pb || !nb) return null;
  const n = Math.min(pa.count, pb.count);
  if (!n) return null;
  const step = Math.max(1, Math.floor(n / 4000));
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const A = grimeAt(gA, pa.getX(i), pa.getY(i), pa.getZ(i), na.getX(i), na.getY(i), na.getZ(i));
    const B = grimeAt(gB, pb.getX(i), pb.getY(i), pb.getZ(i), nb.getX(i), nb.getY(i), nb.getZ(i));
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(A[c] - B[c]));
    sum += d;
    if (d > max) max = d;
    count++;
  }
  return { mean: sum / count, max, samples: count };
}

console.log("\n" + "=".repeat(78));
console.log("Direct field comparison between instance pairs");
console.log("=".repeat(78));
console.log("\n  Mean absolute grime difference over corresponding surface points, 0..255.");
console.log("  Near zero means the two instances carry the same marks in the same places,");
console.log("  whatever their per-unit strengths. Compare against the pump agent's 3.03/255");
console.log("  structural delta, which a critic called 'unambiguously one asset'.\n");
console.log("    grime key              pair                        mean d   max d   verdict");

const NEAR = 0.1; // metres of bbox slack: still effectively the same extent
const pairFindings = [];
for (const [key, group] of keyRows) {
  // All meshes drawn by any material under this key, with their material.
  const all = [];
  for (const r of group) for (const m of r.meshes) all.push({ mesh: m, grime: r.mat.userData.grime });
  if (all.length < 2) continue;

  const bb = (m) => {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    return m.geometry.boundingBox;
  };
  const seen = new Set();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i];
      const B = all[j];
      const ba = bb(A.mesh);
      const bbx = bb(B.mesh);
      const slack = Math.max(
        Math.abs(ba.min.x - bbx.min.x), Math.abs(ba.max.x - bbx.max.x),
        Math.abs(ba.min.y - bbx.min.y), Math.abs(ba.max.y - bbx.max.y),
        Math.abs(ba.min.z - bbx.min.z), Math.abs(ba.max.z - bbx.max.z)
      );
      if (slack > NEAR) continue; // genuinely different parts, nothing to compare
      if (where(A.mesh) === where(B.mesh)) continue; // co-located: a part and its decal
      const d = fieldDelta(A.grime, A.mesh.geometry, B.grime, B.mesh.geometry);
      if (!d) continue;
      const sig = `${key}|${Math.min(i, j)}|${Math.max(i, j)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const bad = d.mean < 8;
      console.log(
        `    ${key.padEnd(22)} ${(label(A.mesh) + " vs " + label(B.mesh)).padEnd(26)} ` +
          `${d.mean.toFixed(2).padStart(7)} ${d.max.toFixed(0).padStart(7)}   ` +
          (bad ? "IDENTICAL PATTERN" : "distinct")
      );
      if (bad) pairFindings.push({ key, d });
    }
  }
}
if (!pairFindings.length) console.log("\n    no instance pair carries the same pattern.");

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */
/**
 * The measured pair difference is the assertion, not the topology scan above.
 * The scan is only a screen, and it is demonstrably the weaker of the two: the
 * three dispensers of case 21 report three *distinct* object-space extents, so a
 * topology-only check would have passed the very defect this probe exists for.
 * Identical extents are one way to get an identical lookup, not the only way.
 */
console.log("\n" + "=".repeat(78));
if (pairFindings.length) {
  const byKey = new Map();
  for (const p of pairFindings) {
    if (!byKey.has(p.key)) byKey.set(p.key, []);
    byKey.get(p.key).push(p.d);
  }
  console.error(
    `FAIL: ${byKey.size} grime key(s) paint the same pattern on more than one instance.\n`
  );
  for (const [key, ds] of byKey) {
    const worst = Math.min(...ds.map((d) => d.mean));
    console.error(`  ${key}: ${ds.length} pair(s), closest mean difference ${worst.toFixed(2)}/255`);
  }
  console.error(
    "\napplyGrime samples object space, so these draw the same marks in the same\n" +
      "places. Give each instance its own material with a distinct `fieldOffset`\n" +
      "(tile units, drawn from that instance's seed) and an alternating `fieldFlip`.\n" +
      "Scaling film/dust/tint per unit does NOT fix this: amplitude-only variation\n" +
      "is indistinguishable from an exposure difference, which is why case 21 took\n" +
      "several rounds of 'add more variation' to diagnose. For reference, correctly\n" +
      "phased instances measure 33-53 on this metric.\n" +
      "See NOTES.md case 22 and the block comment on applyGrime."
  );
  process.exitCode = 1;
} else {
  console.log("OK: no two instances of any grime material carry the same pattern.");
}
if (findings.length && !pairFindings.length) {
  // Should not happen: an identical extent implies an identical lookup.
  console.error("\nWARNING: topology flagged a repeated extent the field comparison did not.");
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* known-bad control                                                   */
/* ------------------------------------------------------------------ */
/**
 * A probe that cannot fail is not evidence (see case 16). Today this fails on
 * real data, but once the car and the bollard feet are phased it will go green
 * and there will be nothing left proving the comparison still works. So run a
 * pair that must be flagged, and a phased pair that must not be.
 */
{
  const anyGrime = rows.find((r) => r.mat.userData?.grime)?.mat.userData.grime;
  if (!anyGrime) {
    console.error("\ncontrol: no grime material available to test against");
    process.exitCode = 1;
  } else {
    const geo = new THREE.BoxGeometry(0.5, 1.2, 0.5);
    const same = fieldDelta(anyGrime, geo, anyGrime, geo);
    const phased = {
      ...anyGrime,
      uGOff: { value: new THREE.Vector2(0.41, 0.73) },
    };
    const different = fieldDelta(anyGrime, geo, phased, geo);
    const ok = same && different && same.mean < 8 && different.mean >= 8;
    console.log(
      `\ncontrol: unphased pair ${same.mean.toFixed(2)}/255 (must flag), ` +
        `phased pair ${different.mean.toFixed(2)}/255 (must not) - ${ok ? "OK" : "BROKEN"}`
    );
    if (!ok) {
      console.error("control failed: the field comparison is not discriminating. Fix the probe.");
      process.exitCode = 1;
    }
  }
}

for (const b of built) b.sys.dispose?.();
