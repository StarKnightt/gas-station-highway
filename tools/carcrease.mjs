/**
 * Measures the angular discontinuity across every crease row of the car body.
 *
 * The reason this exists: a forced-value diff proved the patch partition
 * changes 47,000 pixels, and an independent reviewer simultaneously reported
 * that no feature line on the car makes a highlight terminate. Both were true.
 * A pixel diff only proves the normals *changed*; it says nothing about
 * whether the change is large enough to move the reflection vector across a
 * bright/dark boundary in the environment. That needs an angle, in degrees.
 *
 * Bundles carBody.ts with esbuild and walks the real section, so this measures
 * the shipping geometry rather than a reimplementation that could drift.
 *
 *   node --experimental-strip-types tools/carcrease.mjs [z ...]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

// Node 22 strips the types itself, so this measures src/gen/carBody.ts
// directly with no bundle step and no second copy of the maths to drift.
// Run via `node --experimental-strip-types`, which tools/carcrease.sh does.
const ROOT = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const { section, HALF, ROW_TABLE } = mod;

/** Outward normal of the section polyline between points i and i+1, in degrees above horizontal. */
function segAngle(pts, i) {
  const a = pts[i];
  const b = pts[i + 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Outward normal on the +X flank is (dy, -dx).
  return (Math.atan2(-dx, dy) * 180) / Math.PI;
}

const zs = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
const stations = zs.length ? zs : [1.6, 0.5, 0.0, -0.6, -1.6];

const boundaries = ROW_TABLE.filter((b) => b.name !== "under" && b.name !== "end");

console.log("Crease normal delta, degrees. This is the angle between the mean");
console.log("outward normal of the panel below the crease and the panel above.");
console.log("Under about 12 deg a crease cannot terminate a highlight no matter");
console.log("how wide it is, because both panels still face the same part of");
console.log("the sky.\n");

const head = ["crease", ...stations.map((z) => `z=${z.toFixed(2)}`)];
const rows = [];
for (const b of boundaries) {
  const cells = [];
  for (const z of stations) {
    const pts = section(z).pts;
    const r = b.row;
    if (r < 1 || r > HALF - 2) {
      cells.push("  -  ");
      continue;
    }
    // Mean over two segments either side, so a single tiny fillet segment does
    // not dominate the reading.
    const below = (segAngle(pts, r - 1) + segAngle(pts, Math.max(0, r - 2))) / 2;
    const above = (segAngle(pts, r) + segAngle(pts, Math.min(HALF - 2, r + 1))) / 2;
    cells.push((above - below).toFixed(1).padStart(5));
  }
  rows.push([b.name.padEnd(11), ...cells]);
}
console.log(head.map((h, i) => (i === 0 ? h.padEnd(11) : h.padStart(8))).join(" "));
for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c : c.padStart(8))).join(" "));

// Width of each fillet band, to check it against the sampling rate.
console.log("\nFillet band width at z=0, mm (and screen px at 7 mm/px in wheel_close):");
const pts0 = section(0).pts;
for (const b of ROW_TABLE) {
  if (!/Step|Turn/.test(b.name)) continue;
  const a = pts0[b.row];
  const c = pts0[b.row + b.n];
  const mm = Math.hypot(c.x - a.x, c.y - a.y) * 1000;
  console.log(`  ${b.name.padEnd(11)} ${mm.toFixed(1).padStart(6)} mm   ${(mm / 7).toFixed(1)} px`);
}
