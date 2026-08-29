/**
 * Per-feature proud/buried report.
 *
 * `carburied.mjs` gives whole-group statistics, which hide the answer: a trim
 * group can be 50% buried and perfectly fine, because half of a door handle is
 * *supposed* to be inside the door. What matters is whether each individual
 * hard point still stands out of the hull after the flank was reshaped.
 *
 * Clusters vertices near a named anchor and reports the most-proud one.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/carfeatures.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);
const { buildCarShell, flankX, endZ, topAt } = body;
buildCarShell();

/** Signed clearance from the body skin. Positive is proud. */
function clearance(x, y, z) {
  if (Math.abs(z) > 2.0) {
    const front = z > 0;
    const face = endZ(Math.abs(x), y, front);
    return front ? z - face : face - z;
  }
  const top = topAt(z);
  if (y > top - 0.02) return y - top;
  return Math.abs(x) - flankX(z, y);
}

const groups = { ...parts.buildTrim(), ...parts.buildLamps(), ...parts.buildInterior() };

// anchor = roughly where the feature lives; r = cluster radius.
const FEATURES = [
  ["front door handle", 0.87, 1.02, 0.505, 0.12, "flank"],
  ["rear door handle", 0.87, 1.02, -0.585, 0.12, "flank"],
  ["door mirror", 0.95, 1.15, 0.885, 0.2, "flank"],
  ["wiper", 0.33, 1.22, 1.48, 0.25, "cowl"],
  ["antenna", 0.0, 1.45, -0.6, 0.2, "roof"],
  ["exhaust finisher", -0.5, 0.35, -2.39, 0.14, "tail"],
  ["rear valance", 0.0, 0.46, -2.42, 0.7, "tail"],
  ["rear chrome bar", 0.0, 0.845, -2.42, 0.15, "tail"],
  ["front plate", 0.0, 0.672, 2.36, 0.22, "nose"],
  ["tail lamp lens", 0.47, 0.885, -2.44, 0.24, "tail"],
  ["headlamp lens", 0.545, 0.828, 2.38, 0.2, "nose"],
  ["fuel filler", 0.9, 0.99, -1.78, 0.12, "quarter"],
  ["rear plate", 0.0, 0.66, -2.42, 0.2, "tail"],
  ["boot badge", 0.0, 0.9, -2.44, 0.08, "tail"],
  ["nose badge", 0.0, 0.818, 2.38, 0.08, "nose"],
  ["interior mirror", 0.0, 1.36, 0.95, 0.2, "roof"],
];

console.log("Per-feature clearance. Positive = proud of the body skin.\n");
console.log("  feature              group           verts   most proud     at");
for (const [name, ax, ay, az, r] of FEATURES) {
  let best = -Infinity;
  let bestAt = null;
  let bestGroup = "-";
  let count = 0;
  for (const [gname, geo] of Object.entries(groups)) {
    const p = geo?.getAttribute?.("position");
    if (!p) continue;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      if (Math.abs(Math.abs(x) - Math.abs(ax)) > r || Math.abs(y - ay) > r || Math.abs(z - az) > r) continue;
      count++;
      const c = clearance(x, y, z);
      if (c > best) {
        best = c;
        bestAt = [x, y, z];
        bestGroup = gname;
      }
    }
  }
  if (!count) {
    console.log(`  ${name.padEnd(20)} ${"-".padEnd(14)} ${"0".padStart(6)}   NOT BUILT`);
    continue;
  }
  const mm = best * 1000;
  const verdict = mm < 0 ? "  <-- BURIED" : mm < 2 ? "  <-- FLUSH, will not read" : "";
  console.log(
    `  ${name.padEnd(20)} ${bestGroup.padEnd(14)} ${String(count).padStart(6)}   ${mm.toFixed(1).padStart(8)} mm   ` +
      `(${bestAt.map((v) => v.toFixed(2)).join(", ")})${verdict}`
  );
}
