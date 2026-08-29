#!/usr/bin/env node
/**
 * vergescan.mjs — why the gravel verge reads as a repeating stipple at spawn.
 *
 *   node tools/vergescan.mjs
 *
 * Film's playtest called the immediate-foreground verge "high-frequency,
 * visibly repetitive" and the largest ugly thing in the first frame anyone
 * records. `tools/probe-period.mjs` says the region is NOT periodic — max
 * r 0.235 with the peak lag disagreeing between every band, against a selftest
 * that reports a planted repeat at r 1.000 in all nine bands. So "repetitive"
 * is a percept with some other cause, and this is the arithmetic that finds it.
 *
 * It is deliberately all CPU. Every quantity below is a consequence of constants
 * already in `TerrainSystem.scatterDebris`, the spawn camera state archived in
 * `shots/walkprobe-film-0637/run.log`, and the sun elevation — so none of it
 * needs the card, and a wrong answer here is a wrong answer about numbers rather
 * than about pixels.
 *
 * THE QUESTION IT ASKS
 * --------------------
 * Not "how big are the stones" but **"how big is a stone on screen compared with
 * the mark it draws on the ground"**. At a grazing sun those two are not the same
 * size and not even the same order, and if the mark wins then the scatter reads
 * as its shadows rather than as gravel — a field of same-size dark smudges,
 * which is exactly the percept reported.
 */

const D2R = Math.PI / 180;

/* ---- the scene, as shipped ------------------------------------------------ */

/** `LightingSystem.SUN_ELEVATION_DEG`. NOT site.SUN's stale value; see NOTES 77. */
const SUN_ELEV_DEG = 6.2;
const sunTan = Math.tan(SUN_ELEV_DEG * D2R);

/** `Game.ts`: PerspectiveCamera(52, ...). Vertical FOV, degrees. */
const VFOV_DEG = 52;
const FRAME_W = 1600;
const FRAME_H = 900;
const ASPECT = FRAME_W / FRAME_H;

/** Archived spawn state, `shots/walkprobe-film-0637/run.log`. */
const EYE_Y = 1.8674;
const PITCH_DEG = -0.559;
/** Ground height under the spawn point, from `site.groundHeight(-14, 2)`. */
const site = await import("../src/site.ts").catch(() => null);
const groundY = site?.groundHeight?.(-14, 2) ?? 0;
const eyeAbove = EYE_Y - groundY;

/** `scatterDebris` stone radius, metres. Both arms, so the change is visible. */
const sizeOld = (u) => 0.014 + u * u * 0.062;
const sizeNew = (u) => 0.024 + Math.pow(u, 1.7) * 0.098;
const ARM = process.argv.includes("--old") ? "old (?tforce=finegravel)" : "new (default)";
const sizeAt = process.argv.includes("--old") ? sizeOld : sizeNew;
/** Sunk 0.18 of the radius; y scale 0.45..0.8 of it. Protrusion above ground. */
const protrusionAt = (u, yf) => sizeAt(u) * (yf - 0.18);

/* ---- 1. where the verge band actually is, in metres ----------------------- */

const halfV = (VFOV_DEG / 2) * D2R;
const halfH = Math.atan(Math.tan(halfV) * ASPECT);
const pxPerRadV = FRAME_H / (2 * halfV);

console.log("=== 1. the spawn frame's ground, row by row ===");
console.log(`camera: vfov ${VFOV_DEG} deg, hfov ${(2 * halfH) / D2R} deg (aspect ${ASPECT.toFixed(3)})`);
console.log(`eye ${eyeAbove.toFixed(3)} m above local ground, pitch ${PITCH_DEG} deg (level)`);
console.log("");
console.log("  row      depression   ground distance   m per screen px (radial)");

/** Depression angle of a screen row below the frame centre, allowing for pitch. */
function depressionOf(row) {
  const dyPx = row - FRAME_H / 2;
  return dyPx / pxPerRadV - PITCH_DEG * D2R;
}
const ROWS = [900, 850, 800, 750, 700, 660, 620];
const rowInfo = [];
for (const row of ROWS) {
  const dep = depressionOf(row);
  if (dep <= 0) continue;
  const dist = eyeAbove / Math.tan(dep);
  // How much ground one vertical screen pixel spans at this row. This is the
  // radial (into-the-screen) scale and it is the compressed axis.
  const distNext = eyeAbove / Math.tan(depressionOf(row - 1));
  const mPerPx = Math.abs(distNext - dist);
  rowInfo.push({ row, dep, dist, mPerPx });
  console.log(
    `  ${String(row).padStart(4)}    ${(dep / D2R).toFixed(2).padStart(6)} deg    ` +
      `${dist.toFixed(2).padStart(7)} m       ${(mPerPx * 1000).toFixed(1).padStart(6)} mm`
  );
}

/* ---- 2. the stone, and the mark it draws ---------------------------------- */

console.log("");
console.log("=== 2. a stone against its own shadow, on screen ===");
console.log(`sun ${SUN_ELEV_DEG} deg, so shadow length = protrusion / ${sunTan.toFixed(4)} = ${(1 / sunTan).toFixed(1)}x protrusion`);
console.log("");
console.log("  percentile   radius    protrusion   shadow    at 4 m: stone px   shadow px   ratio");

/** Percentiles of the size distribution, which is u^2 and therefore small-biased. */
const PCT = [
  ["p10", 0.1, 0.5],
  ["p50", 0.5, 0.625],
  ["p90", 0.9, 0.75],
];
const refRow = rowInfo.find((r) => Math.abs(r.dist - 4) < 1.5) ?? rowInfo[0];
for (const [name, u, yf] of PCT) {
  const prot = protrusionAt(u, yf);
  const shadow = prot / sunTan;
  // A stone's protrusion is vertical, so it is NOT foreshortened: it subtends
  // its own angle. Its shadow lies along the ground and IS foreshortened, by
  // roughly sin(depression).
  const stonePx = (Math.atan(prot / refRow.dist) * pxPerRadV);
  const shadowPx = (shadow * Math.sin(refRow.dep)) / refRow.mPerPx;
  console.log(
    `  ${name}       ${(sizeAt(u) * 1000).toFixed(0).padStart(4)} mm   ` +
      `${(prot * 1000).toFixed(0).padStart(6)} mm    ${(shadow * 1000).toFixed(0).padStart(5)} mm   ` +
      `${stonePx.toFixed(1).padStart(9)} px   ${shadowPx.toFixed(1).padStart(8)} px   ` +
      `${(shadowPx / stonePx).toFixed(1).padStart(5)}x`
  );
}

console.log("");
console.log("  The ratio is 1.6x and CONSTANT, which refutes the obvious hypothesis. A 9.2x");
console.log("  shadow stretch does not become a 9.2x screen feature: the protrusion is");
console.log("  vertical and unforeshortened while the shadow lies along the ground and is");
console.log("  compressed by sin(depression), about 0.45 here, and the two nearly cancel.");
console.log("  So the verge does NOT read as its shadows. What the numbers do say is that");
console.log("  the stone itself is small: a 20-facet icosahedron a few pixels tall shows");
console.log("  three or four facets at about a pixel each, so it has no room for the lit");
console.log("  facet that makes a lump read as a lump.");

/* ---- 3. is the size distribution narrow enough to read as one scale? ------ */

console.log("");
console.log("=== 3. the spread of the marks, which is what 'repetitive' means here ===");
const N = 40000;
let seed = 12345;
const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const marks = [];
for (let i = 0; i < N; i++) {
  const prot = protrusionAt(rng(), 0.45 + rng() * 0.35);
  if (prot > 0) marks.push(prot / sunTan);
}
marks.sort((a, b) => a - b);
const q = (f) => marks[Math.floor(f * (marks.length - 1))];
console.log(`  shadow length  p10 ${(q(0.1) * 1000).toFixed(0)} mm   p50 ${(q(0.5) * 1000).toFixed(0)} mm   p90 ${(q(0.9) * 1000).toFixed(0)} mm`);
console.log(`  p90/p10 = ${(q(0.9) / q(0.1)).toFixed(1)}x`);
console.log("");
console.log("  A scatter whose marks span less than about a decade reads as one scale, and");
console.log("  the eye calls one scale a pattern whether or not it repeats — the same");
console.log("  narrow-band result as the churn stipple (NOTES: a narrow-band random field");
console.log("  is still random and still looks like a pattern).");

/* ---- 4. what the base underneath them is doing --------------------------- */

console.log("");
console.log("=== 4. the base texture, at the row that produced the complaint ===");
/** `makeDirt(1024, 17, 404)`: a 1024 map over a 17 m tile. */
const DIRT_PX = 1024;
const DIRT_TILE_M = 17;
const mmPerTexel = (DIRT_TILE_M / DIRT_PX) * 1000;
console.log(`  dirt map 1024 over ${DIRT_TILE_M} m  ->  ${mmPerTexel.toFixed(1)} mm per texel`);
console.log("");
console.log("  row      mm per screen px   texels per screen px   regime");
for (const r of rowInfo) {
  const texelsPerPx = (r.mPerPx * 1000) / mmPerTexel;
  const regime =
    texelsPerPx < 0.8
      ? `MAGNIFIED ${(1 / texelsPerPx).toFixed(1)}x — blurred, no detail to compete`
      : texelsPerPx > 2
        ? `minified ${texelsPerPx.toFixed(1)}x — mip territory`
        : "about 1:1";
  console.log(
    `  ${String(r.row).padStart(4)}    ${(r.mPerPx * 1000).toFixed(1).padStart(8)} mm       ` +
      `${texelsPerPx.toFixed(2).padStart(8)}           ${regime}`
  );
}

/* ---- 5. the tone of the field, which is the thing being fixed ------------- */

console.log("");
console.log("=== 5. stone tone against the soil it lies on ===");
const srgbL = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const unhex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
/** The soil's lightest palette entry, `dustLight`. What the stones sit against. */
const SOIL_L = srgbL(unhex(0x8a7c64));
console.log(`  soil dustLight            luma ${SOIL_L.toFixed(1)}`);
console.log(`  OLD single stone tone     luma ${srgbL(unhex(0x8a7f70)).toFixed(1)}   ` +
  `-> ${(((srgbL(unhex(0x8a7f70)) / SOIL_L) - 1) * 100).toFixed(1)}% from the soil, one value for all 24000`);

const LITHO = [
  [0x6b6257, 0.34], [0x4a443d, 0.22], [0x8f8778, 0.18],
  [0xb5ac98, 0.12], [0x6e5544, 0.09], [0x322e29, 0.05],
];
const total = LITHO.reduce((s, l) => s + l[1], 0);
const tones = [];
for (let i = 0; i < 40000; i++) {
  let r = rng() * total;
  let hex = LITHO[0][0];
  for (const [h, sh] of LITHO) { r -= sh; hex = h; if (r <= 0) break; }
  tones.push(srgbL(unhex(hex)) * (0.78 + rng() * 0.44));
}
tones.sort((a, b) => a - b);
const tq = (f) => tones[Math.floor(f * (tones.length - 1))];
const tMean = tones.reduce((s, x) => s + x, 0) / tones.length;
console.log(`  NEW per-instance tone     luma p10 ${tq(0.1).toFixed(0)}  p50 ${tq(0.5).toFixed(0)}  ` +
  `p90 ${tq(0.9).toFixed(0)}  mean ${tMean.toFixed(0)}   spread ${(tq(0.9) - tq(0.1)).toFixed(0)}`);
console.log(`                            mean is ${(((tMean / SOIL_L) - 1) * 100).toFixed(0)}% from the soil, and the field now has a spread at all`);

/**
 * The prediction. The verge currently renders at p50 29 for an albedo near the
 * soil's 125, so the local transfer from albedo luma to rendered luma is about
 * 0.23 — that folds the 6.2 deg grazing cosine, the exposure and the tonemap
 * into one number and is only valid near this operating point, which is all it
 * is used for.
 */
const XFER = 29 / SOIL_L;
console.log("");
console.log("  PREDICTION for the capture, stated before it is taken:");
console.log(`    stone rendered luma should span about ${(tq(0.1) * XFER).toFixed(0)} to ${(tq(0.9) * XFER).toFixed(0)}`);
console.log("    against a base that stays near 29, so the verge p10-p90 spread should");
console.log("    rise from 14 toward the high 20s or low 30s — between the forecourt's 34");
console.log("    and the gravel-free dirt beyond the lot at 42.");
console.log("    If the spread does NOT move, the tone is not reaching the instances and");
console.log("    `setColorAt` is the thing to check, not the palette.");

console.log("");
console.log("=== verdict ===");
console.log("Three candidate mechanisms were tested and two were refuted by measurement:");
console.log("");
console.log("  NOT periodicity.  probe-period reports max r 0.235 with the peak lag");
console.log("    disagreeing between every band, against a selftest that finds a planted");
console.log("    repeat at r 1.000 in all nine. There is no spatial period here.");
console.log("  NOT contrast.  The verge is the FLATTEST region in the lower frame, not the");
console.log("    busiest — p10-p90 spread 14 and 20 against the forecourt's 34 and the");
console.log("    gravel-free dirt beyond the lot at 42.");
console.log("  NOT shadow dominance.  The shadow is 1.6x the stone's screen height, not the");
console.log("    order of magnitude the 9.2x sun stretch suggests.");
console.log("");
console.log("What is left, and what the fix addresses:");
console.log("  The field is one object at one tone repeated 24000 times. `stoneGeo` is a");
console.log("  single shared geometry, so the per-vertex colour array written onto it gave");
console.log("  every instance the identical twelve-vertex pattern, at luma 128.3 against a");
console.log("  soil of 125.2. **Repetitive and periodic are different claims** — a field of");
console.log("  identical instances repeats in identity with no spatial period at all, so the");
console.log("  percept is right and the periodicity probe is also right.");
console.log("");
console.log("Note what the size change does and does not buy: p50 stone height 3.9 -> 7.2 px");
console.log("is resolvability, but mark spread 4.9x -> 4.5x is unchanged, so scale uniformity");
console.log("is NOT fixed by it. That would need a second sparse coarse population, which is");
console.log("scoped and not taken.");
