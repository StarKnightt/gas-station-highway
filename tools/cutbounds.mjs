// Where does the fascia hole actually end up?
//
// The grille surround is sized against the aperture rectangle in carBody. If
// the hole the mesh really has is bigger than that rectangle, the surround can
// never cover it and every widening is a guess. Measure the hole instead:
// build the shell, then find the boundary of the region the cap is missing.
import * as THREE from "three";
import { buildCarShell } from "../src/gen/carBody.ts";

const shell = buildCarShell();
const cap = shell.paint ?? shell.body;
if (!cap) {
  console.error(`no paint/body geometry; keys: ${Object.keys(shell).join(", ")}`);
  process.exit(1);
}

// Collect every triangle at the nose end, then find, for each of a set of
// vertical bands, the innermost X still covered by fascia. A hole shows up as a
// band with no coverage between the aperture's edges.
const pos = cap.getAttribute("position");
const idx = cap.getIndex();
const tri = idx ? idx.count / 3 : pos.count / 3;
const V = (i) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(i) : i);

const NOSE = 2.2;
let yMin = Infinity;
let yMax = -Infinity;
const covered = [];
for (let t = 0; t < tri; t++) {
  const a = V(t * 3);
  const b = V(t * 3 + 1);
  const c = V(t * 3 + 2);
  const z = (a.z + b.z + c.z) / 3;
  if (z < NOSE) continue;
  const y = (a.y + b.y + c.y) / 3;
  const x = (a.x + b.x + c.x) / 3;
  covered.push([x, y]);
  if (y < yMin) yMin = y;
  if (y > yMax) yMax = y;
}
console.log(`nose-cap triangles beyond z=${NOSE}: ${covered.length}, y range ${yMin.toFixed(3)}..${yMax.toFixed(3)}`);

// For each 4 mm band of height, the smallest |x| that still has fascia. Inside
// an aperture that number jumps outward, and how far it jumps is the hole.
console.log(`\n   y      min|x| with fascia   (aperture rows marked)`);
const APS = [
  { x: 0.305, y0: 0.772, y1: 0.864, name: "grille" },
  { x: 0.452, y0: 0.514, y1: 0.594, name: "intake" },
];
for (let y = 0.46; y <= 0.92; y += 0.008) {
  let best = Infinity;
  for (const [px, py] of covered) {
    if (Math.abs(py - y) > 0.004) continue;
    const ax = Math.abs(px);
    if (ax < best) best = ax;
  }
  const ap = APS.find((a) => y >= a.y0 && y <= a.y1);
  const mark = ap ? `  <- inside ${ap.name} cut (spec |x|<=${ap.x})` : "";
  console.log(`  ${y.toFixed(3)}   ${Number.isFinite(best) ? best.toFixed(3) : "  none"}${mark}`);
}
