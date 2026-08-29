/**
 * pumpscale — how big is every pump part, in pixels, in a given capture pose?
 *
 * LIMITATION, and it is a large one: this projects an axis-aligned bounding box
 * and cannot see occlusion, so every number is an UPPER BOUND. It ranked the
 * pumps' `shut line floor` at 870 px, second largest on the model; measured by
 * removing the mesh in a same-build A/B, its real visible area is 6,729 px —
 * **1.8% of the box**. It is a flat slab spanning the whole cabinet face behind
 * lapped plates that stand proud of it, so all but the gap-width slivers is
 * covered, and a box knows nothing about that.
 *
 * So read the output as a LIST OF PARTS TO ASK ABOUT, not a list of areas. A
 * large number means "this could be large, go and measure it"; a small number is
 * trustworthy in the one direction that matters, because a part cannot be bigger
 * than its box. Acting on a large number without confirming it is how a slot
 * came to be treated as the second largest object in a system.
 *
 * The confirmation that costs nothing extra: give the part a visibility flag,
 * capture both arms from one build with `shoot3.mjs --ab=`, and count the pixels
 * that change. That includes occlusion for free, picks no regions, and gives the
 * part's contribution in the same currency as every other measurement.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpscale.mjs pump_close
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpscale.mjs --all
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpscale.mjs --selftest
 *
 * Why this exists, and why it is not `partscale.mjs`
 * -------------------------------------------------
 * Car derived its whole fittings backlog from a size ranking: nothing under 6 px
 * exists on its model, and 56 px demonstrably reads, so anything larger that
 * does not read is a structural or contrast fault and **must not be enlarged**.
 * This system has been choosing what to work on without that instrument, and the
 * cost is visible in its history — three rounds spent on shut lines that were
 * legible all along, and a nozzle trigger buried inside its own casting.
 *
 * `partscale.mjs` cannot be pointed at this model. It hard-imports
 * `src/gen/carParts.ts` and `src/gen/carBody.ts`, and it parses its poses out of
 * `tools/shootcar.mjs` with a regex that requires `local: true`, which is a
 * property of car poses only. Generalising a 523-line tool that a sibling is
 * actively depending on, in order to gain a ranking, is the wrong trade; the
 * method is about forty lines and the rest of that file is car-specific relief
 * and winding work that `tools/pumprelief.mjs` already covers here.
 *
 * What it does, and the two things it cannot do
 * --------------------------------------------
 * Projects each part's world-space bounding box through the real capture camera
 * and reports the diagonal of its screen-space extent in pixels. So:
 *
 * - **It does not rasterise, so it cannot see occlusion.** A part hidden inside
 *   the casting still gets a size. That failure has already happened on this
 *   model — `nozzleread` found the trigger at 0 visible pixels while it was a
 *   perfectly reasonable size — so a high rank means "worth looking at", never
 *   "fine". `tools/nozzleread.mjs` is the tool for occlusion.
 * - **A bounding box overstates a thin diagonal part.** A hose that sweeps
 *   across the frame gets a box the size of its sweep. Sizes here are upper
 *   bounds.
 *
 * Poses come out of `tools/shoot3.mjs` and the layout out of
 * `src/systems/PumpSystem.ts`, both parsed from source rather than restated,
 * because a tool that keeps its own copy of the camera measures a scene nobody
 * photographed. Both parses fail loudly if the shape they expect is gone.
 *
 * Pure computation. No renderer, no server, nothing to tear down.
 */
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { buildPump, pumpVariation } from "../src/gen/pumpParts.ts";
import { islandTop } from "../src/gen/canopyParts.ts";
import { ISLANDS } from "../src/site.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WIDTH = 1600;
const HEIGHT = 900;

/**
 * Car's two calibration numbers, quoted rather than re-derived, and treated as
 * the reference points they are: 56 px is demonstrated to read on that model at
 * that framing, and 6 px is below the floor of what exists there. They are not
 * laws of this scene — a pump is a different size at a different distance under
 * a canopy — but a part far above 56 px that cannot be seen is the interesting
 * case either way, and that is all these thresholds are used for.
 */
const READS_PX = 56;
const FLOOR_PX = 6;

/* ------------------------------ poses ---------------------------------- */

function readPoses() {
  const src = fs.readFileSync(path.join(ROOT, "tools/shoot3.mjs"), "utf8");
  const out = {};
  // World poses: pos + eye + look + fov. Anchored poses (`anchor: {...}`) are
  // resolved inside the browser against live geometry and cannot be recovered
  // here, so they are skipped by name rather than approximated.
  for (const m of src.matchAll(
    /^\s{2}([a-z_0-9]+):\s*\{\s*pos:\s*\[([^\]]+)\],\s*eye:\s*([\d.]+),\s*look:\s*\[([^\]]+)\],\s*fov:\s*([\d.]+)\s*\}/gm
  )) {
    const pos = m[2].split(",").map(Number);
    const look = m[4].split(",").map(Number);
    out[m[1]] = {
      pos: [pos[0], Number(m[3]), pos[2]],
      look,
      fov: Number(m[5]),
    };
  }
  const skipped = [...src.matchAll(/^\s{2}([a-z_0-9]+):\s*\{\s*anchor:/gm)].map((m) => m[1]);
  return { poses: out, skipped };
}

function readLayout() {
  const src = fs.readFileSync(path.join(ROOT, "src/systems/PumpSystem.ts"), "utf8");
  const block = /const LAYOUT: PumpLayout\[\] = \[([\s\S]*?)\];/.exec(src);
  if (!block) return null;
  const out = [];
  for (const m of block[1].matchAll(
    /\{\s*island:\s*(\d+),\s*x:\s*(-?[\d.]+),\s*yaw:\s*(-?[\d.]+)\s*\}/g
  )) {
    out.push({ island: Number(m[1]), x: Number(m[2]), yaw: Number(m[3]) });
  }
  return out.length ? out : null;
}

/* ------------------------------ projection ------------------------------ */

/**
 * Screen extent of a world-space box, in pixels.
 *
 * All eight corners, because projecting only min and max is wrong for any box
 * that is not axis-aligned to the view. Returns null when the box is entirely
 * behind the camera; a box that straddles the near plane is clamped rather than
 * dropped, since a part at the frame edge is still a part.
 */
function boxPx(box, camera) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let anyFront = false;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    v.applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -1e-4) continue;
    anyFront = true;
    v.applyMatrix4(camera.projectionMatrix);
    const sx = ((v.x / -v.z) * 0.5 + 0.5) * WIDTH;
    const sy = ((v.y / -v.z) * -0.5 + 0.5) * HEIGHT;
    x0 = Math.min(x0, sx);
    y0 = Math.min(y0, sy);
    x1 = Math.max(x1, sx);
    y1 = Math.max(y1, sy);
  }
  if (!anyFront) return null;
  return { w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function makeCamera(pose) {
  const cam = new THREE.PerspectiveCamera(pose.fov, WIDTH / HEIGHT, 0.05, 400);
  cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  cam.lookAt(pose.look[0], pose.look[1], pose.look[2]);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  cam.matrixWorldInverse = cam.matrixWorld.clone().invert();
  return cam;
}

/* ------------------------------ selftest ------------------------------- */

/**
 * The check that matters is that the metric can *fail*, since four instruments
 * tonight returned results that were predetermined by construction. A 1 m box at
 * 10 m must be smaller on screen than the same box at 2 m, and a box behind the
 * camera must return null rather than a number.
 */
function selftest() {
  const pose = { pos: [0, 0, 0], look: [0, 0, -1], fov: 45 };
  const cam = makeCamera(pose);
  const at = (z) =>
    boxPx(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, z - 0.5), new THREE.Vector3(0.5, 0.5, z + 0.5)), cam);
  const near = at(-2);
  const far = at(-10);
  const behind = at(6);
  const fails = [];
  if (!near || !far) fails.push("a box in front of the camera measured null");
  if (near && far && !(near.diag > far.diag * 2)) {
    fails.push(`distance does not shrink parts: 2 m ${near?.diag.toFixed(0)} px vs 10 m ${far?.diag.toFixed(0)} px`);
  }
  if (behind !== null) fails.push(`a box wholly behind the camera measured ${behind.diag.toFixed(0)} px instead of null`);
  const poses = readPoses();
  if (!Object.keys(poses.poses).length) fails.push("parsed no world poses out of tools/shoot3.mjs");
  if (!readLayout()) fails.push("parsed no LAYOUT out of src/systems/PumpSystem.ts");
  const b = buildPump(pumpVariation(1));
  const unnamed = (b.parts ?? []).filter((p) => !p.label || !p.region).length;
  if (!b.parts?.length) fails.push("buildPump published no parts manifest");
  if (unnamed) fails.push(`${unnamed} parts have no label or region`);
  if (fails.length) {
    for (const f of fails) console.error(`pumpscale selftest FAIL: ${f}`);
    process.exit(1);
  }
  console.log(
    `pumpscale selftest OK — 1 m box: ${near.diag.toFixed(0)} px at 2 m, ${far.diag.toFixed(0)} px at 10 m, ` +
      `null behind. ${Object.keys(poses.poses).length} poses, ${readLayout().length} units, ${b.parts.length} parts named.`
  );
}

/* ------------------------------ main ----------------------------------- */

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const { poses, skipped } = readPoses();
if (!Object.keys(poses).length) {
  console.error("pumpscale: parsed no poses out of tools/shoot3.mjs — has its POSES table changed shape?");
  process.exit(2);
}
const LAYOUT = readLayout();
if (!LAYOUT) {
  console.error("pumpscale: parsed no LAYOUT out of src/systems/PumpSystem.ts — has it changed shape?");
  process.exit(2);
}

const ALL = argv.includes("--all");
const BY_PART = argv.includes("--parts");
const wanted = ALL ? Object.keys(poses) : argv.filter((a) => !a.startsWith("--"));
if (!wanted.length) {
  console.error("usage: pumpscale.mjs <pose|--all> [--parts] | --selftest");
  console.error(`poses: ${Object.keys(poses).join(", ")}`);
  if (skipped.length) console.error(`anchored, not measurable here: ${skipped.join(", ")}`);
  process.exit(2);
}
for (const w of wanted) {
  if (!poses[w]) {
    console.error(`pumpscale: unknown pose "${w}". known: ${Object.keys(poses).join(", ")}`);
    process.exit(2);
  }
}

// Every part of every unit, placed exactly as PumpSystem places its roots.
const placed = [];
LAYOUT.forEach((lay, i) => {
  const isl = ISLANDS[lay.island];
  const wx = isl.cx + lay.x;
  const wz = isl.cz;
  const wy = islandTop(wx, wz);
  const m = new THREE.Matrix4()
    .makeRotationY(lay.yaw)
    .premultiply(new THREE.Matrix4().makeTranslation(wx, wy, wz));
  const build = buildPump(pumpVariation(i + 1));
  for (const p of build.parts ?? []) {
    p.geo.computeBoundingBox();
    placed.push({
      unit: i + 1,
      label: p.label,
      region: p.region,
      box: p.geo.boundingBox.clone().applyMatrix4(m),
    });
  }
});

for (const name of wanted) {
  const cam = makeCamera(poses[name]);
  const rows = [];
  for (const p of placed) {
    const px = boxPx(p.box, cam);
    if (!px) continue;
    // Off-frame by more than its own size is not in this photograph.
    if (px.cx < -px.w || px.cx > WIDTH + px.w || px.cy < -px.h || px.cy > HEIGHT + px.h) continue;
    rows.push({ ...p, px });
  }

  const key = BY_PART ? (r) => `${r.label} [u${r.unit}]` : (r) => r.label;
  const agg = new Map();
  for (const r of rows) {
    const k = key(r);
    const e = agg.get(k) ?? { region: r.region, n: 0, max: 0, sum: 0, min: Infinity };
    e.n++;
    e.max = Math.max(e.max, r.px.diag);
    e.min = Math.min(e.min, r.px.diag);
    e.sum += r.px.diag;
    agg.set(k, e);
  }

  console.log(`\n=== ${name}  fov ${poses[name].fov}  ${WIDTH}x${HEIGHT}  ${rows.length} parts in frame ===`);
  console.log(`  ${"largest".padStart(8)} ${"median".padStart(7)} ${"n".padStart(4)}  part`);
  const sorted = [...agg].sort((a, b) => b[1].max - a[1].max);
  for (const [k, e] of sorted) {
    const mark = e.max < FLOOR_PX ? "  (under Car's 6 px floor)" : e.max < READS_PX ? "  (under 56 px)" : "";
    console.log(
      `  ${e.max.toFixed(0).padStart(8)} ${(e.sum / e.n).toFixed(0).padStart(7)} ${String(e.n).padStart(4)}  ${k}${mark}`
    );
  }
  const big = sorted.filter(([, e]) => e.max >= READS_PX).length;
  console.log(
    `  ${big} of ${sorted.length} labels reach 56 px, the size Car demonstrated reads. ` +
      `A part above that which cannot be seen is a structural or contrast fault, not a size one.`
  );
}
if (skipped.length) console.log(`\nanchored poses resolved in-browser, not measurable here: ${skipped.join(", ")}`);
