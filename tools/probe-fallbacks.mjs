/**
 * Routine surface-projection fallback audit. Read-only, CPU-only, no GPU.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-fallbacks.mjs
 *
 * `tools/carburied.mjs` asserts the fallback counters are zero and fails a run
 * if they are not. This is the diagnostic that goes with it: it says *which*
 * builder, and *which* placement, so a non-zero count is actionable rather than
 * just red. Run it whenever carburied fails, or whenever the body is reshaped.
 *
 * Companion probes:
 *   probe-endz.mjs   - flat-plane rate per footprint, and the usable cap envelope
 *   probe-shape.mjs  - sawtooth detector, flankX cliff margins, reshape sensitivity
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const { buildCarShell, endZ, flankX, section, resetProjectionStats, projectionStats } = body;

let fails = 0;

/* ------------------------------------------------------------------ */
/* 0. the cap-uninitialised branch must be loud                        */
/* ------------------------------------------------------------------ */
console.log("=== 0. endZ before buildCarShell() must throw, not return a flat plane ===\n");
{
  let threw = null;
  try {
    endZ(0.47, 0.885, false);
  } catch (e) {
    threw = e;
  }
  if (threw) {
    console.log("  OK: throws.");
    console.log(`  ${threw.message.replace(/\s+/g, " ").slice(0, 150)}...`);
  } else {
    console.log("  FAIL: returned a value. The silent flat-plane fallback is back.");
    fails++;
  }
}

const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);
buildCarShell();

/* ------------------------------------------------------------------ */
/* 1. attribution by builder                                           */
/* ------------------------------------------------------------------ */
console.log("\n=== 1. fallback hits per builder ===\n");
const BUILDERS = [
  ["buildCarShell", () => buildCarShell()],
  ["buildTrim", () => parts.buildTrim()],
  ["buildLamps", () => parts.buildLamps()],
  ["buildInterior", () => parts.buildInterior()],
  ["buildArchLips", () => parts.buildArchLips()],
  ["buildSills", () => parts.buildSills()],
];
const dirty = [];
for (const [label, fn] of BUILDERS) {
  resetProjectionStats();
  fn();
  const s = projectionStats();
  const n = s.endZOutsideOutline + s.flankXNoCrossing;
  if (n) dirty.push(label);
  console.log(
    `  ${label.padEnd(16)} endZ-outside-outline ${String(s.endZOutsideOutline).padStart(4)}   ` +
      `flankX-no-crossing ${String(s.flankXNoCrossing).padStart(4)}${n ? "   <-- NON-ZERO" : ""}`
  );
  // The builder now reports WHERE it fell back, so read that rather than
  // guessing from the copied literals in END_POINTS below. Grouped by rounded
  // position because a patch samples per vertex and one bad footprint produces
  // a cluster, not a single hit.
  if (s.sites && s.sites.length) {
    const groups = new Map();
    for (const p of s.sites) {
      const k = `${p.front ? "front" : "rear"} x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}`;
      const g = groups.get(k) || { n: 0, over: 0 };
      g.n++;
      g.over = Math.max(g.over, Number.isFinite(p.over) ? p.over : 0);
      groups.set(k, g);
    }
    for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].over - a[1].over)) {
      console.log(
        `      ${k}  x${String(g.n).padStart(2)}  over the outline by ` +
          `${(g.over * 1000).toFixed(1)} mm`
      );
    }
  }
}
if (dirty.length) fails++;

/* ------------------------------------------------------------------ */
/* 2. pinpoint the offending placements                                */
/* ------------------------------------------------------------------ */
console.log("\n=== 2. which placements land off the surface? ===\n");

const outlineK = (v) => Math.max(0.06, Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * v - 1), 5)), 0.2));

/** Every endPatch/endBand footprint and point placement in carParts.ts. */
const END_PATCHES = [
  ["trim: upper grille backing", 0, 0.360, 0.818, 0.090, true, 18, 6],
  ["trim: grille cap bar", 0, 0.352, 0.898, 0.01, true, 18, 2],
  ["trim: nose badge", 0, 0.05, 0.818, 0.031, true, 12, 6],
  ["trim: lower intake", 0, 0.522, 0.556, 0.092, true, 22, 6],
  ["trim: front plate recess", 0, 0.152, 0.672, 0.058, true, 12, 4],
  ["trim: front plate rim", 0, 0.158, 0.672, 0.064, true, 12, 4],
  ["trim: rear valance", 0, 0.62, 0.455, 0.075, false, 24, 4],
  ["trim: rear chrome bar", 0, 0.430, 0.845, 0.011, false, 20, 2],
  ["trim: rear plate recess", 0, 0.152, 0.66, 0.058, false, 12, 4],
  ["trim: rear plate rim", 0, 0.158, 0.66, 0.064, false, 12, 4],
  ["trim: boot badge", 0, 0.046, 0.9, 0.028, false, 12, 6],
  ["lamps: headlamp shut", 0.515, 0.200, 0.828, 0.083, true, 16, 6],
  ["lamps: headlamp housing", 0.515, 0.185, 0.828, 0.068, true, 14, 8],
  ["lamps: headlamp lens", 0.515, 0.185, 0.828, 0.068, true, 14, 8],
  ["lamps: amber repeater", 0.633, 0.044, 0.822, 0.046, true, 8, 6],
  ["lamps: tail shut", 0.47, 0.216, 0.885, 0.091, false, 16, 8],
  ["lamps: tail housing", 0.47, 0.2, 0.885, 0.075, false, 16, 8],
  ["lamps: tail chamber +0.120", 0.590, 0.068, 0.885, 0.062, false, 10, 6],
  ["lamps: tail chamber -0.004", 0.466, 0.042, 0.885, 0.062, false, 10, 6],
  ["lamps: tail chamber -0.126", 0.344, 0.058, 0.885, 0.062, false, 10, 6],
];
/**
 * HAZARD: these are *copies* of call-site placements, not reads of them.
 *
 * `trim: exhaust finisher` sat at y=0.352 here for as long as the call site did,
 * and kept reporting the same 7.4 mm shortfall after the call site was raised to
 * 0.364 — because this list is a duplicate constant and duplicates drift. A
 * probe that hard-codes the value it checks will eventually either report a
 * fixed defect forever or, worse, pass a real one because the literal happens to
 * be clear when the code is not.
 *
 * Keep them in sync when a placement moves, and prefer exporting the placement
 * from the builder over copying it here whenever that is possible.
 */
const END_POINTS = [
  ["trim: fog lamp bezel", 0.545, 0.556, true],
  ["trim: exhaust finisher", -0.5, 0.364, false],
  ["lamps: headlamp bowl inner", 0.429, 0.828, true],
  ["lamps: headlamp bowl outer", 0.597, 0.828, true],
  ["lamps: projector unit", 0.429, 0.828, true],
];

let offCap = 0;
for (const [label, xc, halfW, yc, halfH, front, nx, ny] of END_PATCHES) {
  resetProjectionStats();
  let bad = null;
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const k = outlineK(v);
    const y = yc - halfH + v * halfH * 2;
    for (let i = 0; i <= nx; i++) {
      const before = projectionStats().endZOutsideOutline;
      const x = xc + (i / nx - 0.5) * 2 * halfW * k;
      endZ(x, y, front);
      if (projectionStats().endZOutsideOutline > before && !bad) bad = [x, y];
    }
  }
  const s = projectionStats().endZOutsideOutline;
  if (s) {
    offCap += s;
    console.log(`  ${label.padEnd(30)} ${String(s).padStart(3)} off-cap samples, first at x=${bad[0].toFixed(3)} y=${bad[1].toFixed(3)}`);
  }
}
for (const [label, x, y, front] of END_POINTS) {
  resetProjectionStats();
  const z = endZ(x, y, front);
  if (projectionStats().endZOutsideOutline) {
    offCap++;
    console.log(`  ${label.padEnd(30)} POINT off-cap at x=${x.toFixed(3)} y=${y.toFixed(3)} -> flat plane ${z.toFixed(4)}`);
    // How far would it have to move to get back onto the fascia?
    let lo = y;
    let hi = y + 0.2;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      resetProjectionStats();
      endZ(x, mid, front);
      if (projectionStats().endZOutsideOutline) lo = mid;
      else hi = mid;
    }
    console.log(`  ${"".padEnd(30)}   cap edge is at y = ${hi.toFixed(4)}; move the part up ${((hi - y) * 1000).toFixed(1)} mm`);
  }
}
if (!offCap) console.log("  none: every footprint is inside its cap outline.");

/* ------------------------------------------------------------------ */
/* 3. flankX: the largest-crossing rule, and why it is correct         */
/* ------------------------------------------------------------------ */
console.log("\n=== 3. flankX keeps the LARGEST crossing - confirm that is still right ===\n");
{
  const z = -1.172;
  const y = 0.192;
  const pts = section(z).pts;
  const hits = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if ((y >= a.y && y <= b.y) || (y <= a.y && y >= b.y)) {
      const t = Math.abs(b.y - a.y) < 1e-9 ? 0 : (y - a.y) / (b.y - a.y);
      hits.push([i, a.x + (b.x - a.x) * t]);
    }
  }
  console.log(`  at z=${z} y=${y} the half section crosses ${hits.length} times:`);
  for (const [i, x] of hits) console.log(`    segment ${String(i).padStart(3)}  x = ${x.toFixed(4)}`);
  console.log(`  flankX returns ${flankX(z, y).toFixed(4)} - the outer skin, which is what flank trim sits on.`);
  console.log("  Taking the nearest instead would lay it on the floor pan. Do not 'fix' this");
  console.log("  by analogy with endZ: endZ casts a ray and wants the nearest hit; flankX");
  console.log("  walks a profile and wants the outermost.");
}

console.log("\n" + (fails ? `INCOMPLETE: ${fails} check(s) failed above.` : "All structural checks passed."));
if (fails) process.exitCode = 1;
