#!/usr/bin/env node
/**
 * vergejudge.mjs — judge the spawn verge bundle against a prediction made first.
 *
 *   node tools/vergejudge.mjs <default.png> <flatgravel.png> <finegravel.png>
 *   node tools/vergejudge.mjs --selftest
 *
 * THE PREDICTION, recorded before the pixels existed (see `tools/vergescan.mjs`
 * and `HANDOVER-terrain.md`):
 *
 *   The verge p10-p90 luma spread should rise **from 14 into the high 20s or low
 *   30s** — between the forecourt's 34 and the gravel-free dirt beyond the lot at
 *   42. If it does NOT move, the tone is not reaching the instances and
 *   `setColorAt` is the thing to check, not the palette.
 *
 * WHY THIS IS A TOOL AND NOT AN EYE. A 500 x 100 px band of low-amplitude
 * speckle is exactly the kind of region where a change of 14 -> 30 in p10-p90
 * spread is obvious to a measurement and nearly invisible in a wide crop. This
 * project's dominant defect class is absence, and "a feature that does nothing
 * and a feature that is subtle are the same screenshot".
 *
 * WHAT THE THREE ARMS SEPARATE. Two changes landed together, so each has its own
 * forced-off token and the arms form a factorial:
 *
 *                     stone tone          stone size/count
 *   default           per-instance        24-122 mm / 12000
 *   ?tforce=flatgravel  SHARED (old)      24-122 mm / 12000
 *   ?tforce=finegravel  per-instance      14-76 mm / 24000  (old)
 *
 * So `default` vs `flatgravel` isolates the TONE and `default` vs `finegravel`
 * isolates the SIZE, both within one bundle. The archived pre-change frame
 * (old tone AND old size) would complete the square, but it is from a bundle
 * five agents have edited since, and a cross-bundle comparison cannot attribute
 * a difference — it is quoted for orientation and never as a control.
 *
 * AND EVERY ARM MUST STAY IN ITS LANE. A feature arm that moves regions it has
 * no business in has not been isolated, whatever its own region says. The
 * reference regions below contain no gravel; if they move, the finding is not
 * about gravel.
 */

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

/** Regions are FIXED pixel boxes, identical in every arm. Comparing the same
 *  pixels rather than a neighbourhood is the correction that turned a 1.05x
 *  non-result into a measured 1.88x on the pools. */
const REGIONS = [
  { name: "verge, immediate fg", box: [1100, 800, 500, 100], role: "target" },
  { name: "verge, mid band", box: [1150, 660, 450, 100], role: "target" },
  { name: "asphalt road, bottom left", box: [60, 780, 380, 110], role: "reference" },
  { name: "asphalt forecourt", box: [700, 520, 400, 60], role: "reference" },
  { name: "canopy soffit", box: [500, 150, 300, 40], role: "reference" },
];

/** Measured on the archived pre-change frame. Orientation only — different bundle. */
const ARCHIVE = {
  "verge, immediate fg": { p10: 23, p50: 29, p90: 37, spread: 14, sd: 6.5 },
  "verge, mid band": { p10: 18, p50: 27, p90: 39, spread: 20, sd: 9.1 },
  "asphalt road, bottom left": { spread: 16, sd: 14.2 },
  "asphalt forecourt": { spread: 34, sd: 14.7 },
  "canopy soffit": { spread: 9, sd: 13.0 },
};

const PREDICT_LO = 25;
const PREDICT_HI = 34;
const BASELINE_SPREAD = 14;

function statsOf(img, [x, y, w, h]) {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) {
    throw new Error(
      `region [${x},${y},${w},${h}] does not fit a ${img.width}x${img.height} frame. ` +
        `The regions are authored against 1600x900; a different viewport invalidates every box.`
    );
  }
  const v = [];
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      v.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]);
    }
  }
  v.sort((a, b) => a - b);
  const q = (f) => v[Math.floor(f * (v.length - 1))];
  const mean = v.reduce((s, t) => s + t, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, t) => s + (t - mean) ** 2, 0) / v.length);
  // Non-finite guard. Every check here is a comparison against a mean, the mean
  // of no pixels is NaN, and every comparison against NaN is false — which is
  // how a zero-dimension frame passed every health assertion in this project
  // once already.
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || v.length === 0) {
    throw new Error(`region [${x},${y},${w},${h}] produced non-finite statistics over ${v.length} px`);
  }
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), spread: q(0.9) - q(0.1), sd, n: v.length };
}

if (process.argv.includes("--selftest")) {
  /**
   * The selftest plants a known spread change and requires the tool to see it,
   * because a judge that cannot fail is not a judge. Builds two 1600x900 frames
   * differing only inside the verge boxes: one flat, one with a wide bimodal
   * speckle, and asserts the reported spread moves the way it must.
   */
  const make = (speckle) => {
    const p = new PNG({ width: 1600, height: 900 });
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < p.data.length; i += 4) {
      const px = (i / 4) % 1600;
      const py = Math.floor(i / 4 / 1600);
      const inVerge = px >= 1100 && px < 1600 && py >= 660 && py < 900;
      let g = 29;
      if (inVerge && speckle) g = rnd() < 0.4 ? 12 : 45;
      p.data[i] = p.data[i + 1] = p.data[i + 2] = g;
      p.data[i + 3] = 255;
    }
    return p;
  };
  const flat = statsOf(make(false), REGIONS[0].box);
  const spk = statsOf(make(true), REGIONS[0].box);
  console.log(`  flat frame    spread ${flat.spread.toFixed(1)} (expect ~0)`);
  console.log(`  speckled      spread ${spk.spread.toFixed(1)} (expect ~33)`);
  const pass = flat.spread < 1 && spk.spread > 25;
  console.log(pass ? "  selftest PASS" : "  selftest FAIL — the judge cannot see a planted spread change");
  process.exit(pass ? 0 : 1);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length !== 3) {
  console.error("usage: node tools/vergejudge.mjs <default.png> <flatgravel.png> <finegravel.png>");
  process.exit(2);
}
const ARMS = ["default", "flatgravel (tone off)", "finegravel (old size/count)"];

const read = (f) => {
  const img = PNG.sync.read(fs.readFileSync(f));
  if (!img.width || !img.height) throw new Error(`${f} is ${img.width}x${img.height} — a zero-dimension capture`);
  return img;
};
const imgs = files.map(read);
console.log("");
for (let i = 0; i < 3; i++) {
  console.log(`  ${ARMS[i].padEnd(28)} ${path.basename(files[i])}  ${imgs[i].width}x${imgs[i].height}`);
}

const table = new Map();
console.log("");
console.log("region                        arm                            p10  p50  p90  spread   sd");
for (const r of REGIONS) {
  for (let i = 0; i < 3; i++) {
    const s = statsOf(imgs[i], r.box);
    table.set(`${r.name}|${i}`, s);
    console.log(
      `${(i === 0 ? r.name : "").padEnd(29)} ${ARMS[i].padEnd(28)} ` +
        `${s.p10.toFixed(0).padStart(3)}  ${s.p50.toFixed(0).padStart(3)}  ${s.p90.toFixed(0).padStart(3)}  ` +
        `${s.spread.toFixed(1).padStart(6)}  ${s.sd.toFixed(1).padStart(5)}`
    );
  }
  const a = ARCHIVE[r.name];
  if (a) console.log(`${"".padEnd(29)} ${"archive (other bundle, orientation)".padEnd(28)} ${(a.spread ?? 0).toFixed(1).padStart(24)}`);
  console.log("");
}

/* ---- the verdict, against the prediction as written ---------------------- */

let fail = 0;
const fg = (i) => table.get(`verge, immediate fg|${i}`);
const dflt = fg(0);
const flat = fg(1);
const fine = fg(2);

console.log("=== against the prediction ===");
console.log(`prediction: verge immediate-fg spread rises from ${BASELINE_SPREAD} into ${PREDICT_LO}-${PREDICT_HI}`);
console.log(`measured:   default ${dflt.spread.toFixed(1)}   flatgravel ${flat.spread.toFixed(1)}   finegravel ${fine.spread.toFixed(1)}`);
console.log("");

const toneDelta = dflt.spread - flat.spread;
if (dflt.spread >= PREDICT_LO && dflt.spread <= PREDICT_HI) {
  console.log(`CONFIRMED  default spread ${dflt.spread.toFixed(1)} lands in the predicted band.`);
} else if (dflt.spread > PREDICT_HI) {
  console.log(`OVERSHOT   default spread ${dflt.spread.toFixed(1)} is above the predicted band.`);
  console.log("           The model underestimated. Report the number, do not retune to fit it.");
} else if (Math.abs(toneDelta) < 2) {
  fail++;
  console.log(`NULL       default ${dflt.spread.toFixed(1)} vs flatgravel ${flat.spread.toFixed(1)} — the tone arm moved nothing.`);
  console.log("           THE FAILURE BRANCH AS WRITTEN: check `setColorAt` is reaching the");
  console.log("           instances, not the palette. Confirm `stones.instanceColor` is non-null");
  console.log("           and that `flatgravel` is actually the arm that suppresses it.");
} else {
  console.log(`UNDERSHOT  default spread ${dflt.spread.toFixed(1)} is below the predicted band, but the tone`);
  console.log(`           arm did move it by ${toneDelta.toFixed(1)}. The mechanism works and the size is wrong.`);
}

console.log("");
console.log(`attribution:  tone (default - flatgravel) ${toneDelta >= 0 ? "+" : ""}${toneDelta.toFixed(1)} spread`);
console.log(`              size (default - finegravel) ${dflt.spread - fine.spread >= 0 ? "+" : ""}${(dflt.spread - fine.spread).toFixed(1)} spread`);

/* ---- each arm must stay in its lane -------------------------------------- */

console.log("");
console.log("=== did the arms stay in their lane? ===");
for (const r of REGIONS.filter((x) => x.role === "reference")) {
  const s0 = table.get(`${r.name}|0`);
  const s1 = table.get(`${r.name}|1`);
  const s2 = table.get(`${r.name}|2`);
  const worst = Math.max(Math.abs(s0.p50 - s1.p50), Math.abs(s0.p50 - s2.p50));
  const ok = worst < 1.5;
  if (!ok) fail++;
  console.log(
    `${ok ? "ok   " : "FAIL "} ${r.name.padEnd(28)} p50 moves at most ${worst.toFixed(2)} between arms` +
      `${ok ? "" : " — a gravel arm is moving a region with no gravel in it"}`
  );
}

/* ---- crops, so the number is looked at as well as read ------------------- */

console.log("");
console.log("=== crops for the eye, at 2x — a 500 px band judged inside a 1600 px frame reads as flat ===");
for (let i = 0; i < 3; i++) {
  console.log(`  node tools/pngcrop.mjs ${files[i]} .shot-build/judge_${i}_verge.png 1150 700 400 170 2`);
}
console.log("");
console.log("=== and re-run the arbiter: the fix must not have INTRODUCED a period ===");
console.log(`  node tools/pngcrop.mjs ${files[0]} .shot-build/judge_period.png 1100 660 500 215 1`);
console.log("  node tools/probe-period.mjs .shot-build/judge_period.png");
console.log("  (was max r 0.235 with disagreeing lags; a peak at a consistent lag would be new)");

process.exit(fail ? 1 : 0);
