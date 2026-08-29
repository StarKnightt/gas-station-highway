#!/usr/bin/env node
/**
 * The ground beyond the lot, as numbers: slope census, forced-off controls, and
 * the measured range of every field `groundAccum` publishes.
 *
 * Why this exists and why it lives in `tools/`. The three probes that produced
 * these numbers over the last few rounds were written into `.shot-build/`,
 * which is the capture harness's private build directory — and the harness
 * deletes it. Every diagnostic was destroyed by the next capture, so each round
 * re-derived the same census from scratch. A measurement you cannot re-run is
 * an anecdote, and a tool stored in a build directory is deleted by the build.
 *
 * What it measures, and why these three things together:
 *
 *   1. SLOPE AGAINST THE SOLAR TANGENT. Shading responds to slope, so the
 *      question "does this ground take relief lighting" is answered by the
 *      fraction of it steeper than tan(sun elevation) and not by any amplitude.
 *      Sampled at the mesh's own vertex spacing, because slope finer than the
 *      mesh is slope the render never sees.
 *
 *   2. A FORCED-OFF ARM IN THE SAME RUN. `--force=noruts` / `nochurn` re-runs
 *      the identical census with one feature disabled. A feature that does
 *      nothing and a feature that is subtle produce the same screenshot, and
 *      the only thing that separates them is the control.
 *
 *   3. THE PUBLISHED RANGE, as percentiles rather than extremes. "0..1" is true
 *      of four of the five accumulation fields and distinguishes none of them;
 *      two are bimodal and will read as hard masks if a consumer treats them as
 *      gradients. Percentiles are what makes a declared range usable.
 *
 * CPU only by construction: it imports the height field and the services
 * directly and renders nothing, so it needs no GPU, no port and no teardown.
 * It answers "is the feature in the height field", never "is it in the frame".
 *
 * Usage:
 *   node tools/dirtscan.mjs
 *   node tools/dirtscan.mjs --force=noruts
 *   node tools/dirtscan.mjs --force=nochurn
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsresolve.mjs", pathToFileURL(`${import.meta.dirname}/`));

const FORCE = (process.argv.find((a) => a.startsWith("--force=")) || "").split("=")[1] || process.env.TFORCE || "";
if (FORCE) process.env.TFORCE = FORCE;

const site = await import("../src/site.ts");
const { makeSoilField } = await import("../src/gen/groundSoil.ts");
const { makeAccumField } = await import("../src/gen/groundAccum.ts");

const { ROAD, PAD, DRIVEWAYS, SUN, groundHeight } = site;

/**
 * The mesh's near-field vertex spacing. Slope has to be measured at the step
 * the renderer actually tessellates at: a 0.05 m finite difference reports the
 * slope of a wave the mesh cannot represent, which is how a height field passes
 * a slope census and renders flat.
 */
const STEP = 0.63;

/**
 * The solar tangent, from the shared constant, with NO fallback.
 *
 * This line previously read `SUN?.elevationDeg ?? 11.2`. The field is
 * `SUN.elevation` and it is in RADIANS, so `elevationDeg` was always
 * `undefined` and the fallback fired on every run this tool has ever made.
 * The tool therefore never read the shared constant it appeared to read, and
 * the 0.194 solar tangent circulated to four other systems is tan(11 deg)
 * from a default, not tan of anything the scene lights with. The correct
 * figure is tan(6.2 deg) = 0.109, and every slope-versus-sun conclusion
 * drawn from this tool was comparing against a sun 1.8x steeper than the
 * one the renderer ships.
 *
 * An optional chain followed by `??` is not a defensive read, it is a
 * silent one: it converts a misspelt field name into a plausible number.
 * So this now throws. A tool that cannot find the sun must not guess it.
 */
if (!Number.isFinite(SUN?.elevation)) {
  throw new Error(
    `[dirtscan] site.SUN.elevation is ${SUN?.elevation} (expected radians). ` +
      `Refusing to substitute a default: every slope conclusion below is a ` +
      `comparison against this number.`
  );
}
const sunTan = Math.tan(SUN.elevation);

/** Steepest slope at a point, from a central difference on both axes. */
function slopeAt(x, z) {
  const dx = (groundHeight(x + STEP, z) - groundHeight(x - STEP, z)) / (2 * STEP);
  const dz = (groundHeight(x, z + STEP) - groundHeight(x, z - STEP)) / (2 * STEP);
  return Math.hypot(dx, dz);
}

/**
 * The TRACK FOOTPRINT, not the entrance region. An earlier version of this
 * predicate took +-5.5 m either side of each driveway flank across the whole
 * band, inside which the grooves occupy under a fifth of the area, and it
 * diluted a real effect below its own noise floor. A census over a region much
 * larger than the feature is a census of the region.
 */
function inTracks(x, z) {
  if (z < ROAD.halfPaved - 1.5 || z > PAD.minZ + 4) return false;
  for (const d of DRIVEWAYS) {
    for (const side of [-1, 1]) {
      const edge = side < 0 ? d.minX : d.maxX;
      const lo = edge + side * 1.6;
      const hi = edge + side * 4.9;
      if (side < 0 ? x < lo && x > hi : x > lo && x < hi) return true;
    }
  }
  return false;
}

/** Frontage dirt away from the entrances: the control region, unchanged by ruts. */
function inFrontage(x, z) {
  if (z < ROAD.halfPaved || z > PAD.minZ + 4) return false;
  return !inTracks(x, z);
}

function census(pred, label) {
  const s = [];
  for (let z = ROAD.halfPaved - 2; z < PAD.minZ + 5; z += 0.5) {
    for (let x = -60; x < 62; x += 0.5) {
      if (!pred(x, z)) continue;
      const v = slopeAt(x, z);
      if (!Number.isFinite(v)) throw new Error(`non-finite slope at ${x},${z}`);
      s.push(v);
    }
  }
  s.sort((a, b) => a - b);
  const mean = s.reduce((t, v) => t + v, 0) / s.length;
  const over = s.filter((v) => v > sunTan).length / s.length;
  console.log(
    `  ${label.padEnd(18)} n=${String(s.length).padStart(5)}  mean ${mean.toFixed(3)}  ` +
      `p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)}  max ${s[s.length - 1].toFixed(3)}  ` +
      `${(over * 100).toFixed(1)}% steeper than sun`
  );
  return { mean, max: s[s.length - 1], over };
}

/** Wide-field census on a coarse walk, to show a local change stayed local. */
function farCensus() {
  const s = [];
  for (let z = -160; z < 260; z += 3) {
    for (let x = -260; x < 260; x += 3) {
      if (x > ROAD.minX - 40 && x < PAD.maxX + 40 && z > -20 && z < PAD.maxZ + 40) continue;
      s.push(slopeAt(x, z));
    }
  }
  const mean = s.reduce((t, v) => t + v, 0) / s.length;
  const over = s.filter((v) => v > sunTan).length / s.length;
  console.log(
    `  ${"far field".padEnd(18)} n=${String(s.length).padStart(5)}  mean ${mean.toFixed(3)}  ` +
      `${(over * 100).toFixed(1)}% steeper than sun`
  );
}

console.log("");
console.log(
  `slope census: sun tan ${sunTan.toFixed(3)}, finite difference at the mesh step ${STEP} m` +
    (FORCE ? `, FORCED OFF: ${FORCE}` : ", all features on")
);
census(inTracks, "entrance tracks");
census(inFrontage, "frontage control");
farCensus();

/* ---- the published range, which is part of the contract ---- */

const soil = makeSoilField();
const accum = makeAccumField(soil);
const fields = ["shelter", "fines", "litter", "grime", "swept"];
const samples = Object.fromEntries(fields.map((f) => [f, []]));
let bad = 0;
for (let z = -34; z < 60; z += 1) {
  for (let x = -60; x < 62; x += 1) {
    for (const f of fields) {
      const v = accum[f](x, z);
      if (!Number.isFinite(v)) bad++;
      else samples[f].push(v);
    }
  }
}
if (bad) throw new Error(`${bad} non-finite values in the accumulation field`);

const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
console.log("");
console.log(`groundAccum over the lot, 1 m grid, n=${samples.shelter.length} per field:`);
console.log("  field     min      p50      p95      p99      max      mean    declared");
for (const f of fields) {
  const a = samples[f].slice().sort((p, q) => p - q);
  const mean = a.reduce((t, v) => t + v, 0) / a.length;
  const d = accum.range[f];
  // The declared range is checked, not printed. A published contract that
  // drifts from the field it describes is the stale-warning failure again.
  const ok =
    Math.abs(d.p50 - pct(a, 0.5)) < 0.02 && Math.abs(d.max - a[a.length - 1]) < 0.02 && Math.abs(d.mean - mean) < 0.02;
  console.log(
    `  ${f.padEnd(8)} ${a[0].toFixed(4)}  ${pct(a, 0.5).toFixed(4)}  ${pct(a, 0.95).toFixed(4)}  ` +
      `${pct(a, 0.99).toFixed(4)}  ${a[a.length - 1].toFixed(4)}  ${mean.toFixed(4)}  ` +
      `${ok ? "matches" : "STALE"}  (${d.shape}, ${d.units})`
  );
}
console.log("");
