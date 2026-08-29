#!/usr/bin/env node
/**
 * Where the scrub fringe breaks, measured on the CPU from where a person stands.
 *
 * The complaint this exists to quantify: the far scrub reads as small isolated
 * tufts with long bare stretches between them, stopping abruptly at the road
 * edge, where real roadside scrub forms a broken but roughly continuous fringe,
 * densest along the road. Three separable claims — continuity, isolation, and
 * the edge — and a verdict cannot tell them apart.
 *
 * Two things this measures that a plant count does not:
 *
 * 1. **Both populations, side by side.** `vegetation.sites` is 228 mid-storey
 *    plants; `vegetation.clumps` is ~2400 scrub clumps. The clumps are what the
 *    frame reads as past 40 m, and until they were published every density
 *    figure taken through this harness — including my own, which located a
 *    "cliff" at 50-60 m — was over the mid-storey and then discussed as if it
 *    described the scrub. Printing both makes that mistake impossible to repeat
 *    silently: if the two disagree, the number you want is the second one.
 *
 * 2. **Angular gaps in silhouette, not density per m².** "Long bare stretches"
 *    is a statement about the picture, and the picture is angular. A ring at
 *    100 m holds nine times the area of the same width at 33 m, so a constant
 *    per-m² density is a *thinning* fringe on screen, and an area density can
 *    look healthy while the frame has a 20 degree hole in it. So this bins by
 *    bearing and accumulates each clump's subtended width in pixels, which is
 *    the quantity the eye is integrating.
 *
 *   node tools/vegfringe.mjs
 */
import { build } from "vite";

/*
 * `BuildingSystem.init` reads `location.search` unguarded, so it still wants a
 * `location` under Node. The canvas half of that problem is gone: `init` now
 * takes a layout-only branch when `document` is undefined and publishes the
 * real blockers, so the `stubBuilding: true` empty-blocker path this tool used
 * to run under has been deleted and the near bands below are trustworthy again.
 */
globalThis.location ??= { search: "", href: "http://localhost/", pathname: "/" };
// VegetationSystem publishes its report to `window`, so the CPU harness needs one.
globalThis.window ??= globalThis;

process.env.VEGCPU_ONLY = "vegscale";
await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { collectSites } = await import("../.shot-build/cpu/vegscale.mjs");

const { sites, clumps, buildingWas } = await collectSites();
console.log(`\n[vegfringe] ${sites.length} mid-storey sites, ${clumps.length} scrub clumps, building ${buildingWas}`);
if (!clumps.length) {
  console.log(`[vegfringe] !! no clumps — 'vegetation.clumps' is missing, every figure below is the wrong population`);
}
// The blocker count is the thing that used to be silently zero, so print it
// rather than the path name alone: "layout-only" is fine and "0 blockers" is
// not, and only one of those two is visible in the label.
const blockerCount = globalThis.__VEGETATION?.blockers;
console.log(`[vegfringe] exclusion mask: ${blockerCount ?? "?"} blockers from the ${buildingWas} building path`);
if (blockerCount === 0) {
  console.log(
    `[vegfringe] !! DEGRADED: the blocker list is empty, so the lot interior is over-planted here.\n` +
      `[vegfringe]    Rings and bearings clear of the lot (40 m and out) are trustworthy; the near\n` +
      `[vegfringe]    bands are not, and the near bands are not what this tool is for.`
  );
}
console.log(
  `[vegfringe] !! the report line above shows matCellsKept and fringeCellsKept at 0 under this\n` +
    `[vegfringe]    harness's constant groundSoil stub. Both sheets do build against the real soil\n` +
    `[vegfringe]    field — 11413/21316 and 2179/5200 cells — see 'node tools/vegmat.mjs'. No mat\n` +
    `[vegfringe]    number from this harness is usable; the clump numbers below are unaffected.`
);

/** Where a person stands. The user walks freely; these are the three obvious stops. */
const EYES = {
  "forecourt-mid": [0, 10],
  "pump-island": [0, 18],
  "store-door": [0, 30],
};

/* --- 1. area density, both populations, so the sub-population is never implicit --- */

const RING = 10;
const MAX = 160;

const ringTable = (pop, ex, ez) => {
  const rings = new Array(Math.ceil(MAX / RING)).fill(0);
  for (const s of pop) {
    const d = Math.hypot(s.x - ex, s.z - ez);
    if (d < MAX) rings[Math.floor(d / RING)]++;
  }
  return rings;
};

for (const [name, [ex, ez]] of Object.entries(EYES)) {
  const mid = ringTable(sites, ex, ez);
  const clump = ringTable(clumps, ex, ez);
  console.log(`\n=== standing at (${ex}, ${ez}) — ${name} ===`);
  console.log(`   ring       mid-storey        clumps    clump/m2   spacing m   bar (clumps)`);
  let prev = null;
  for (let i = 0; i < clump.length; i++) {
    const r0 = i * RING;
    const r1 = r0 + RING;
    const area = Math.PI * (r1 * r1 - r0 * r0);
    const density = clump[i] / area;
    const spacing = density > 0 ? 1 / Math.sqrt(density) : Infinity;
    const bar = "#".repeat(Math.min(34, Math.round(density * 240)));
    let step = "";
    if (prev !== null && prev > 0 && density > 0) {
      const ratio = prev / density;
      if (ratio >= 3) step = `  <-- falls ${ratio.toFixed(1)}x`;
      else if (ratio <= 1 / 3) step = `  <-- rises ${(1 / ratio).toFixed(1)}x`;
    }
    console.log(
      `  ${String(r0).padStart(3)}-${String(r1).padStart(3)}m ` +
        `${String(mid[i]).padStart(11)} ${String(clump[i]).padStart(13)} ` +
        `${density.toFixed(4).padStart(11)} ${(spacing === Infinity ? "—" : spacing.toFixed(1)).padStart(11)}   ${bar}${step}`
    );
    prev = density;
  }
}

/* --- 2. angular continuity: the actual complaint, in the units of the picture --- */

// 1920 px across a 50 degree horizontal field. Both are what `vegposes` uses.
const PX_PER_DEG = 1920 / 50;
const BIN_DEG = 2;
const BINS = Math.round(360 / BIN_DEG);

/**
 * Silhouette width in pixels per bearing bin, from clumps beyond `from` metres.
 *
 * Width, not count: a clump 0.5 m wide at 120 m subtends 0.24 degrees, about 9
 * px, and one at 300 m subtends 4 px. Summing widths rather than instances is
 * what separates "there are plants out there" from "the eye sees cover".
 * Overlap is not resolved — two clumps on the same bearing add — so this is an
 * upper bound on coverage and a *sound* test for the thing being looked for,
 * which is bins that are empty.
 */
const bearingProfile = (pop, ex, ez, from, to) => {
  const bins = new Float64Array(BINS);
  for (const s of pop) {
    const dx = s.x - ex;
    const dz = s.z - ez;
    const d = Math.hypot(dx, dz);
    if (d < from || d > to) continue;
    const width = s.size * s.wide;
    const deg = (2 * Math.atan(width / 2 / d) * 180) / Math.PI;
    let b = Math.atan2(dz, dx) * (180 / Math.PI);
    if (b < 0) b += 360;
    bins[Math.floor(b / BIN_DEG) % BINS] += deg * PX_PER_DEG;
  }
  return bins;
};

/** Longest run of bins below `floor` px, in degrees, within a bearing window. */
const longestGap = (bins, floor, fromDeg, toDeg) => {
  let run = 0;
  let worst = 0;
  let at = 0;
  for (let b = Math.floor(fromDeg / BIN_DEG); b < Math.ceil(toDeg / BIN_DEG); b++) {
    if (bins[((b % BINS) + BINS) % BINS] < floor) {
      run++;
      if (run > worst) {
        worst = run;
        at = (b - run + 1) * BIN_DEG;
      }
    } else run = 0;
  }
  return { deg: worst * BIN_DEG, at };
};

/*
 * The windows, in world bearings, and the first version of this had them wrong
 * in a way worth recording: I measured 140-220 degrees and called it "across the
 * highway". The highway runs along x, and every standing position is at positive
 * z, so the road side of the view is 180-360 degrees and *along* the highway is
 * 180 and 0. The window I used was one along-road cone and half the road side —
 * so a change that moved clusters symmetrically in +/-x showed up as a loss,
 * because the half it added to was outside the window. The number was real, the
 * window was wrong, and the verdict it produced was backwards.
 */
const WINDOWS = {
  // The whole road side of the view: the near shoulder, the far shoulder, and
  // the country past it. This is the fringe.
  "road side": [185, 355],
  // Along the highway, where the fringe is deepest in the picture and where a
  // step in density reads as a line across it.
  "along road -x": [155, 205],
  "along road +x": [-25, 25],
  // Straight across the highway: the far shoulder and the country behind it.
  // Separated from the along-road cones because moving clusters between the two
  // is exactly what the far scatter's shape decides, and a single window that
  // spans both cannot see the trade.
  "across road": [230, 310],
  // Behind the lot, for contrast. Nobody claims a fringe here.
  "behind lot": [25, 155],
};

console.log(`\n\n=== angular continuity of the fringe (clumps only) ===`);
console.log(`   Silhouette width summed per ${BIN_DEG} degree bin, at ${PX_PER_DEG.toFixed(1)} px/deg (1920 px / 50 deg fov).`);
console.log(`   "bare" = under 4 px of clump in a ${BIN_DEG} degree bin, i.e. under half a percent of the bin filled.`);
console.log(`   Bearing 270 deg looks straight across the highway; 180 and 0 look along it.`);
for (const [name, [ex, ez]] of Object.entries(EYES)) {
  console.log(`\n  --- ${name} at (${ex}, ${ez}) ---`);
  for (const [wname, [lo, hi]] of Object.entries(WINDOWS)) {
    console.log(`   ${wname}`);
    console.log(`     band         filled bins   mean px/bin   median px   worst bare run`);
    for (const [from, to] of [
      [20, 40],
      [40, 60],
      [60, 90],
      [90, 130],
      [130, 200],
    ]) {
      const bins = bearingProfile(clumps, ex, ez, from, to);
      const win = [];
      for (let b = Math.floor(lo / BIN_DEG); b < Math.ceil(hi / BIN_DEG); b++) win.push(bins[((b % BINS) + BINS) % BINS]);
      const filled = win.filter((v) => v >= 4).length;
      const mean = win.reduce((a, v) => a + v, 0) / win.length;
      const sorted = [...win].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const gap = longestGap(bins, 4, lo, hi);
      console.log(
        `    ${String(from).padStart(3)}-${String(to).padStart(3)}m ` +
          `${String(`${filled}/${win.length}`).padStart(14)} ` +
          `${mean.toFixed(1).padStart(13)} ${med.toFixed(1).padStart(11)} ` +
          `${`${gap.deg} deg at ${gap.at}`.padStart(17)}`
      );
    }
  }
}

/* --- 2b. the same figures over an ensemble of seeds, with the spread --- */

/*
 * Why this exists, and it is the most important part of the tool.
 *
 * Every filled-bin count above is one realization. The far scatter has 58
 * clusters over 170 degrees of bearing and 300 m of depth, and changing the
 * *structure* of the scatter reorders the shared rng stream, so two arms of a
 * comparison are two different random draws of every plant on the site. I read
 * three consecutive rounds of that as evidence — "the road corridor helped",
 * "it hurt", "it hurt differently" — for what was substantially one change. The
 * draw-to-draw spread printed below is the reason: it is comparable to the
 * effect, so a single-realization A/B here is not measurement.
 *
 * The shipped seed is quoted too, because what ships is one draw and the
 * photograph is judged on that one. Mean says whether the shape is better;
 * shipped says whether this particular frame got lucky.
 */
const SEEDS = 16;
process.env.VEGCPU_ONLY = "vegscatter";
await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { sites: scatterAt } = await import("../.shot-build/cpu/vegscatter.mjs");

const ensembleBand = (pop, ex, ez, from, to, lo, hi) => {
  const bins = bearingProfile(pop, ex, ez, from, to);
  const win = [];
  for (let b = Math.floor(lo / BIN_DEG); b < Math.ceil(hi / BIN_DEG); b++) win.push(bins[((b % BINS) + BINS) % BINS]);
  return {
    filled: win.filter((v) => v >= 4).length,
    mean: win.reduce((a, v) => a + v, 0) / win.length,
    gap: longestGap(bins, 4, lo, hi).deg,
    of: win.length,
  };
};

const draws = [];
for (let s = 0; s < SEEDS; s++) draws.push(scatterAt(0.74, 2718 + s * 7919));
const shipped = scatterAt(0.74, 2718);

console.log(`\n\n=== ensemble over ${SEEDS} seeds of the same scatter ===`);
console.log(`   Standing at the forecourt centre. "sd" is the seed-to-seed standard deviation:`);
console.log(`   a change smaller than about two of those is not distinguishable from a reseed.`);
for (const [wname, [lo, hi]] of Object.entries(WINDOWS)) {
  console.log(`\n   ${wname}`);
  console.log(`     band        filled (sd)        mean px (sd)      worst gap deg (sd)     shipped`);
  for (const [from, to] of [
    [40, 60],
    [60, 90],
    [90, 130],
    [130, 200],
  ]) {
    const rs = draws.map((d) => ensembleBand(d, 0, 10, from, to, lo, hi));
    const sh = ensembleBand(shipped, 0, 10, from, to, lo, hi);
    const stat = (get) => {
      const v = rs.map(get);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
      return [m, sd];
    };
    const [fm, fsd] = stat((r) => r.filled);
    const [mm, msd] = stat((r) => r.mean);
    const [gm, gsd] = stat((r) => r.gap);
    console.log(
      `    ${String(from).padStart(3)}-${String(to).padStart(3)}m ` +
        `${`${fm.toFixed(1)} (${fsd.toFixed(1)})`.padStart(15)} of ${rs[0].of}` +
        `${`${mm.toFixed(1)} (${msd.toFixed(1)})`.padStart(18)}` +
        `${`${gm.toFixed(0)} (${gsd.toFixed(0)})`.padStart(20)}` +
        `${`${sh.filled}/${sh.of}, ${sh.mean.toFixed(0)} px, ${sh.gap} deg`.padStart(24)}`
    );
  }
}

/* --- 3. along the road, which is the shape the fringe is supposed to have --- */

console.log(`\n\n=== along-road profile: clumps within 4 m of the pavement edge ===`);
console.log(`   Per 10 m of highway. This is the shoulder ribbon, and the layer whose density`);
console.log(`   used to step 3x at exactly |x| = 90 m with no ramp.`);
// Read, not typed in: the first version of this hardcoded 7.4 m against a real
// 5.16 m, which puts the "shoulder band" 2 m out from the shoulder.
const { site } = await import("../.shot-build/cpu/vegscatter.mjs");
const HALF_PAVED = site.ROAD.halfPaved;
const band = clumps.filter((s) => Math.abs(Math.abs(s.z) - HALF_PAVED) < 4);
const perX = new Map();
for (const s of band) {
  const k = Math.floor(s.x / 10) * 10;
  perX.set(k, (perX.get(k) ?? 0) + 1);
}
const keys = [...perX.keys()].sort((a, b) => a - b);
console.log(`   ${band.length} clumps in the shoulder band, x from ${keys[0]} to ${keys[keys.length - 1]}`);
console.log(`      x band      count   per metre of road   bar`);
for (const k of keys) {
  const n = perX.get(k);
  console.log(
    `   ${String(k).padStart(5)}-${String(k + 10).padStart(4)}m ${String(n).padStart(8)} ` +
      `${(n / 10).toFixed(2).padStart(18)}   ${"#".repeat(Math.min(40, n))}`
  );
}

/* --- 4. where the continuous layers stop, which no discrete count can show --- */

console.log(`\n[vegfringe] continuous cover, from the constants:`);
console.log(`   ground mat sheet:   disc radius 62 m about (0, 24), edge faded over last 8 m`);
console.log(`   thatch sprigs:      disc radius 42 m about (0, 24), 60-170 mm tall`);
console.log(`   road fringe sheet:  ribbon along x in [-190, 190], 15 m out from the pavement,`);
console.log(`                       ridged so it peaks a few metres out; hands over to the disc inside 62 m`);
console.log(`   shoulder ribbon:    continuous along x in [-170, 170] at the pavement edge, ramped not stepped`);
console.log(`   open-dirt clusters: x in [-75, 75], z in [-34, 90]`);
console.log(`   far country:        radial 78-378 m, plus a 52-78 m ring and a road corridor to +/-230 m`);
console.log(
  `\n   The remaining hole is across the highway past 130 m: 2.3 of 40 bearing bins filled,\n` +
    `   and it does not close with clumps — a knee-high plant at 165 m is a few pixels, so\n` +
    `   filling 80 degrees of bearing out there is a tonal job for the ground, not an\n` +
    `   instancing job for the plants.`
);
