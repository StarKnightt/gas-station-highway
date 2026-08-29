#!/usr/bin/env node
/**
 * What does each pixel of the `panels` pose actually hit?
 *
 * Written after a forced-value capture failed to answer the question. Forcing
 * the panel relief from 3 mm to 20 mm moved 8.4% of the pixels in the region
 * where the shut lines run, by a mean of 2.5/255 — which is indistinguishable
 * from the drift caused by *other agents' systems* changing between my two
 * builds. In a shared repo that is being edited live, a cross-build A/B has no
 * clean control: my `ground_control` rectangle moved by a mean of 25.6.
 *
 * So the presence test moves off the GPU. This casts rays from the exact camera
 * `shoot3.mjs` builds for a `localTo` pose, into the exact geometry `buildPump`
 * returns, and reports which material slot each ray lands on and how far out it
 * sits. A shut line is visible on screen if and only if a vertical scan across
 * one crosses from plate to backing and back — and that is a statement about
 * screen space, which is the thing the last measurement did not make.
 *
 * Not a substitute for a capture: it knows nothing about shading, and a gap
 * that is geometrically present can still be invisible if nothing darkens it.
 * It answers presence and position only. Pure computation, nothing to tear down.
 */

import * as THREE from "three";
import { buildPump, PUMP } from "../src/gen/pumpParts.ts";

const WIDTH = 1600;
const HEIGHT = 900;

// Must match tools/shoot3.mjs POSES.panels exactly, or this probe is measuring
// a frame nobody captured.
const POSE = { eyeLocal: [0.95, 1.05, -1.05], at: [-0.1, 0.8, -0.36], fov: 30 };

const build = buildPump(1);
// Every slot buildPump returns. Keep this list complete: when the shut-line
// backing moved out of `steelDark` into its own `seam` slot, this probe silently
// stopped being able to see the very feature it exists to measure, and reported
// the cabinet prism *behind* the backing as the gap floor - "GAP runs found: 0"
// on geometry that was entirely correct. A probe that omits a slot does not fail,
// it lies about what is in front.
const SLOTS = ["steel", "steelDark", "seam", "trim", "accent", "plastic", "keys", "chrome", "glass", "topper"];

const scene = new THREE.Scene();
for (const slot of SLOTS) {
  const g = build[slot];
  if (!g || !g.getAttribute("position")?.count) continue;
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.name = slot;
  scene.add(m);
}
scene.updateMatrixWorld(true);

const cam = new THREE.PerspectiveCamera(POSE.fov, WIDTH / HEIGHT, 0.05, 200);
cam.position.set(...POSE.eyeLocal);
cam.lookAt(new THREE.Vector3(...POSE.at));
cam.updateMatrixWorld(true);

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** What the pixel at (px, py) sees: slot name, hit point, distance. */
function shoot(px, py) {
  ndc.set((px / WIDTH) * 2 - 1, -((py / HEIGHT) * 2 - 1));
  ray.setFromCamera(ndc, cam);
  const hits = ray.intersectObjects(scene.children, false);
  if (!hits.length) return null;
  return { slot: hits[0].object.name, p: hits[0].point, dist: hits[0].distance };
}

/* ------------------------------------------------------------------ */

console.log("=== panels pose: vertical scans across the cabinet face ===");
console.log("Looking for plate -> backing -> plate transitions, i.e. a shut line.");
console.log("`out` is metres outboard of the nominal cabinet skin at |z| = " + (PUMP.cabD / 2).toFixed(3) + ".");
console.log();

/**
 * Classify a hit by how far out it sits, which is what distinguishes the three
 * things this probe is trying to tell apart: the face of a proud panel plate,
 * the floor of the gap between two of them, and the payment furniture that is
 * mounted 30 mm further out again on the head's Z plane.
 */
function classify(h) {
  if (!h) return "sky";
  const out = (-h.p.z - PUMP.cabD / 2) * 1000;
  if (out > 10) return "furniture";
  if ((h.slot === "seam" || h.slot === "steelDark") && out < 1.2) return "GAP";
  if (h.slot === "seam") return "GAP";
  if (h.slot === "steel" && out > 1.2) return "plate";
  if (h.slot === "accent") return "band";
  return `other(${h.slot},${out.toFixed(1)})`;
}

const COLUMNS = [470, 560, 620, 680];
const found = {};
for (const px of COLUMNS) {
  const seq = [];
  for (let py = 0; py < HEIGHT; py += 1) {
    const c = classify(shoot(px, py));
    if (!seq.length || seq[seq.length - 1].c !== c) seq.push({ py, c, n: 1 });
    else seq[seq.length - 1].n++;
  }
  const gaps = seq.filter((r) => r.c === "GAP");
  found[px] = gaps;
  console.log(`-- column x=${px}px   GAP runs found: ${gaps.length}`);
  for (const r of seq) {
    if (r.c === "sky") continue;
    console.log(`   py ${String(r.py).padStart(3)}..${String(r.py + r.n - 1).padStart(3)}  ${r.c}`);
  }
  console.log();
}

/* ------------------------------------------------------------------ */
/* Does the gap READ as a recess? Presence is not the same question.   */
/* ------------------------------------------------------------------ */

/*
 * Pass a captured panels.png as argv[2] and this measures, in frame, what the
 * shut line actually does to the image. That extra step is not ceremony: the
 * first version of these plates was geometrically perfect and present in every
 * column, and the slot floor still came out *brighter* than the plate beside
 * it, because two 2.5 mm fillets had eaten a 6 mm gap down to 1 mm of visible
 * floor. Presence was true and the feature was inverted.
 *
 * Windows are taken from this probe's own gap rows rather than hardcoded, which
 * matters — hand-picked windows straddled the dark and bright bands and
 * averaged them into a number that meant nothing.
 */
const shotPath = process.argv[2];
if (shotPath) {
  const { PNG } = await import("pngjs");
  const fsMod = await import("node:fs");
  const png = PNG.sync.read(fsMod.readFileSync(shotPath));
  const lum = (x, y) => {
    const i = (png.width * y + x) * 4;
    return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  };
  // Average across a band of columns so a single grime speckle cannot carry it.
  const band = (px, py) => {
    let s = 0;
    let n = 0;
    for (let x = px - 12; x <= px + 12; x++, n++) s += lum(x, py);
    return s / n;
  };
  console.log("=== in-frame read of each shut line, from " + shotPath + " ===");
  console.log("Reference is the plate 12..20 px either side of the gap rows.");
  console.log();
  for (const px of COLUMNS) {
    for (const g of found[px]) {
      const lo = g.py;
      const hi = g.py + g.n - 1;
      const ref = [];
      for (let y = lo - 20; y < lo - 11; y++) ref.push(band(px, y));
      for (let y = hi + 12; y <= hi + 20; y++) ref.push(band(px, y));
      if (ref.some((v) => !isFinite(v))) continue;
      const plate = ref.reduce((a, b) => a + b, 0) / ref.length;
      const inGap = [];
      for (let y = lo - 3; y <= hi + 3; y++) inGap.push(band(px, y));
      const darkest = Math.min(...inGap);
      const brightest = Math.max(...inGap);
      console.log(
        `  x=${px} py ${lo}..${hi}  plate ${plate.toFixed(1)}  ` +
          `darkest ${darkest.toFixed(1)} (${(darkest - plate).toFixed(1)})  ` +
          `brightest ${brightest.toFixed(1)} (+${(brightest - plate).toFixed(1)})  ` +
          `swing ${(brightest - darkest).toFixed(1)}`
      );
    }
  }
  console.log();
  console.log("A shut line that works is darker than the plate somewhere in the slot");
  console.log("and brighter on the lit lip. A negative 'darkest' delta is the test.");
}

/* ------------------------------------------------------------------ */
/* Where SHOULD the seams be on screen? Project the authored joint      */
/* heights and see which pixel rows they land on.                       */
/* ------------------------------------------------------------------ */

console.log("=== authored joint heights, projected to pixel rows ===");
const v = new THREE.Vector3();
for (const y of [PUMP.baseH + 0.008, 0.545, 0.905, PUMP.cabTop - 0.055, PUMP.cabTop]) {
  // Sample on the -Z face at a couple of X positions clear of the furniture.
  for (const x of [-0.1, 0.1]) {
    v.set(x, y, -PUMP.cabD / 2).project(cam);
    const px = ((v.x + 1) / 2) * WIDTH;
    const py = ((1 - v.y) / 2) * HEIGHT;
    const on = px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT;
    console.log(
      `  y=${y.toFixed(3)} x=${x.toFixed(2)}  ->  px=${px.toFixed(0)}, py=${py.toFixed(0)}  ${on ? "IN FRAME" : "off frame"}`
    );
  }
}
