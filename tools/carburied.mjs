/**
 * Is each bolt-on part actually outside the body, or sealed inside it?
 *
 * This is the third time this project has produced correct geometry that never
 * reached the screen: the pump bollards, the grille sealed inside a closed
 * fascia, and now a set of parts that a reviewer says vanished between two
 * rounds. Reading the code proves a part was built. It does not prove the part
 * is proud of the hull it is bolted to, and when the hull's shape changes
 * underneath it, every hard point placed against the old surface is suspect.
 *
 * For every vertex of every part, tests whether it sits inside the body's
 * lofted section, and reports how far the most-proud vertex stands out.
 *
 *   node --experimental-strip-types tools/carburied.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);

const { buildCarShell, flankX, endZ, topAt, CAR, resetProjectionStats, projectionStats } = body;

// endZ now throws if the caps are not built, so the old warning that used to
// sit here is obsolete: getting this order wrong is a hard error, not a quietly
// wrong number.
resetProjectionStats();
buildCarShell();

const NOSE = CAR.length / 2 - CAR.frontOverhang + CAR.wheelbase / 2;

/**
 * Signed clearance of a point from the body skin, in metres. Positive is
 * proud of the surface, negative is inside it.
 */
function clearance(x, y, z) {
  const halfLen = 2.5;
  if (z > 1.9 || z < -1.9) {
    // Near a cap the governing surface is the fascia, not the flank.
    const front = z > 0;
    const face = endZ(Math.abs(x), y, front);
    const dz = front ? z - face : face - z;
    const dx = Math.abs(x) - flankX(front ? 1.9 : -1.9, y);
    return Math.max(dz, dx);
  }
  if (Math.abs(z) > halfLen) return 1;
  const fx = flankX(z, y);
  const top = topAt(z);
  if (y > top) return y - top;
  return Math.abs(x) - fx;
}

function report(name, geo) {
  if (!geo || !geo.getAttribute || !geo.getAttribute("position")) {
    console.log(`  ${name.padEnd(22)} MISSING GEOMETRY`);
    return;
  }
  const p = geo.getAttribute("position");
  let maxOut = -Infinity;
  let buried = 0;
  let at = null;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const c = clearance(x, y, z);
    if (c < 0) buried++;
    if (c > maxOut) {
      maxOut = c;
      at = [x, y, z];
    }
  }
  const pct = ((buried / p.count) * 100).toFixed(0);
  const flag = maxOut < 0.0015 ? "  <-- SEALED INSIDE THE BODY" : "";
  console.log(
    `  ${name.padEnd(22)} verts ${String(p.count).padStart(6)}   buried ${pct.padStart(3)}%   ` +
      `most proud ${(maxOut * 1000).toFixed(1).padStart(7)} mm at (${at.map((v) => v.toFixed(2)).join(", ")})${flag}`
  );
}

/* ------------------------------------------------------------------ */
/* build everything first, then snapshot the fallback counters          */
/* ------------------------------------------------------------------ */
//
// The counters must be read before anything below runs, because `clearance()`
// queries endZ and flankX itself, at arbitrary part vertices that are nowhere
// near a fascia - interior trim at y = 1.21, for instance. Those are legitimate
// off-surface probes by the harness and counting them would swamp the signal:
// interleaving the two put 202 hits on the report when the car build was
// responsible for 1.
const built = {
  trim: parts.buildTrim(),
  lamps: parts.buildLamps(),
  interior: parts.buildInterior(),
};
parts.buildArchLips();
parts.buildSills();
const stats = projectionStats();

console.log("Body surface reference points:");
for (const [lbl, z, y] of [
  ["front door handle", 0.505, 1.02],
  ["rear door handle", -0.585, 1.02],
  ["mirror station", 0.885, 1.15],
  ["shoulder line", 0.0, 0.956],
]) {
  console.log(`  ${lbl.padEnd(22)} flankX(z=${z}, y=${y}) = ${flankX(z, y).toFixed(4)} m`);
}
console.log(`  rear fascia at (0.505, 0.968) z = ${endZ(0.505, 0.968, false).toFixed(4)}`);
console.log(`  nose fascia at (0.545, 0.828) z = ${endZ(0.545, 0.828, true).toFixed(4)}`);
console.log(`  roof top at z=0.930          y = ${topAt(0.93).toFixed(4)}   (NOSE ref ${NOSE.toFixed(2)})`);

console.log("\nTrim:");
// `debugFront` is an array of named geometries, empty unless the throwaway
// grille diagnostic is on, and is not a bucket. `parts` is the per-part manifest
// that `partscale` consumes - also an array of named geometries rather than a
// merged bucket. Both are skipped rather than reported as MISSING GEOMETRY: a
// tool that cries wolf on correct output gets ignored.
for (const k of Object.keys(built.trim)) {
  if (k === "debugFront" || k === "parts") continue;
  report(`trim.${k}`, built.trim[k]);
}

console.log("\nLamps:");
for (const k of Object.keys(built.lamps)) report(`lamps.${k}`, built.lamps[k]);

console.log("\nInterior (expected to be almost entirely buried - it is inside the cabin):");
for (const k of Object.keys(built.interior)) report(`interior.${k}`, built.interior[k]);

/* ------------------------------------------------------------------ */
/* surface-projection fallbacks                                        */
/* ------------------------------------------------------------------ */
//
// Every endZ and flankX query the shipping code makes has now been made, and
// the counts were snapshotted above before this harness added its own. Case 14
// was a helper quietly substituting a plausible flat plane for 39% of the
// tail-lamp samples; the only signal was two critic passes calling the lamps
// "noise painted on a flat panel", and two rounds went into rebuilding lamp
// internals that were fine. A count that fails a run in seconds is the cheap
// version of that.
const SITES = [
  [
    "endZ: point outside the cap outline",
    stats.endZOutsideOutline,
    "a part is authored off the end of the nose or tail fascia; run\n" +
      "      tools/probe-fallbacks.mjs, which names the placement and how far to move it",
  ],
  [
    "flankX: no crossing at this station",
    stats.flankXNoCrossing,
    "a part is authored off the end of the section; it fell back to hipX(z),\n" +
      "      roughly 100 mm from the true half width. tools/probe-shape.mjs prints\n" +
      "      the per-station cliff margins",
  ],
];

console.log("\nSurface-projection fallbacks (must all be zero):");
let total = 0;
for (const [name, count, hint] of SITES) {
  total += count;
  console.log(`  ${name.padEnd(38)} ${String(count).padStart(6)}${count ? "   <-- NON-ZERO" : ""}`);
  if (count) console.log(`      ${hint}`);
}

if (total > 0) {
  console.error(
    `\nFAIL: ${total} surface-projection fallback(s) fired while building the car.\n` +
      "Parts are being laid on a substituted plane instead of the real surface, which\n" +
      "reads as noise or tearing on the panel rather than as a missing part. See\n" +
      "NOTES.md case 15."
  );
  process.exitCode = 1;
} else {
  console.log("\nOK: every part was placed against a real surface.");
}
