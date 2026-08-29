#!/usr/bin/env node
/**
 * nearjudge.mjs — judge the near-field detail layer against a prediction made first.
 *
 *   node tools/nearjudge.mjs <default.png> <nonear.png>
 *   node tools/nearjudge.mjs --selftest
 *
 * THE PREDICTION, recorded before the pixels existed.
 *
 *   PRIMARY A, presence. Changed pixels between `default` and `?tforce=nonear`
 *   inside Film's band rise from 0.00% to **at least 15%**. Presence first,
 *   because the last two rounds both failed on presence while every appearance
 *   number was internally consistent.
 *
 *   PRIMARY B, identity. Changed pixels in rows 0-599 are **exactly 0.00%**.
 *   The branch is guarded by `nd < 8.5`, and row 600 is the first row whose
 *   closest ground anywhere across the frame width is beyond 8.5 m (8.52 m,
 *   swept at 25 px intervals). So this is not "approximately unchanged" — it is
 *   a claim that the far field is bit-identical, measured on the quantity being
 *   changed rather than asserted.
 *
 *   PRIMARY B AS WRITTEN WAS UNTESTABLE, AND THE PREDICTION IS THE THING THAT
 *   WAS WRONG. It reported 0.208% and read as a leaking guard. Then a
 *   default-against-default bundle measured the floor, and the floor is not
 *   zero: two captures of the *same build* differ over rows 0-599 by 0.025% to
 *   0.082% depending on the pair, with peak deltas of 159-164 against the
 *   feature run's 165. On the strictest any-delta form the identical-build pair
 *   reaches 0.92%. The frame is not reproducible run to run, because the wind
 *   landed an hour before this work and foliage is grabbed at whatever phase the
 *   frame arrives on; the sky moves too, behind moving crowns.
 *
 *   A zero threshold was set without ever measuring whether zero was
 *   achievable. That is the mirror image of a control that cannot fail: a gate
 *   that cannot pass. So the whole-frame pixel count is retired here as a
 *   pass/fail and kept only as context printed beside its measured floor.
 *
 *   Identity is now claimed on the two things that can actually carry it:
 *   the fixed reference surfaces, which are deterministic and must be exactly
 *   0.00%, and Film's band itself, which measures 0.00% between two identical
 *   builds and so proves the ground is bit-reproducible even though the frame
 *   is not. Vegetation hit this same wall this afternoon from the plant side and
 *   settled on peak-delta over pixel-count for the same reason; these are one
 *   finding, not two.
 *
 *   SECONDARY, appearance. Band mean|Laplacian| rises from **1.47 to at least
 *   3.0**, target 3.0-8.0.
 *
 * WHY mean|LAPLACIAN| AND NOT SPREAD. The feature adds relief at the pixel
 * scale; it does not widen the tonal range. p10-p90 spread is nearly blind to
 * that, and it is the metric the previous two rounds used. Measured on the
 * archived spawn frame, at the same depth and near-identical brightness:
 *
 *   Film's band          1.47   (mean luma 30.0)   <- the defect
 *   canopy soffit        1.07   (painted metal)    <- the floor
 *   road asphalt near    8.01   (mean luma 28.8)   <- the ceiling, same depth
 *   forecourt asphalt    5.55
 *   gravel region       15.77   (real geometry)
 *
 * The band is 5.4x softer than the pavement beside it at equal brightness, and
 * only a third of the way from painted metal to that pavement. Brightness is
 * controlled for, so this is a statement about detail and not about exposure.
 *
 * WHAT WOULD FALSIFY THE WHOLE APPROACH. If PRIMARY A passes and SECONDARY does
 * not, the layer is moving pixels without adding high-frequency content, which
 * would mean the detail sample is being smoothed away — check `nearScale`
 * against the texel arithmetic before touching the gain.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const BAND = [1100, 800, 500, 99];
const IDENTITY = [0, 0, 1600, 600];
const REFS = [
  { name: "road asphalt near (no feature)", box: [60, 780, 380, 110] },
  { name: "forecourt asphalt", box: [700, 520, 400, 60] },
];

const PRESENCE_MIN = 15.0;
const HP_BASELINE = 1.47;
const HP_MIN = 3.0;
const HP_MAX = 8.0;
const CHANGE_EPS = 6;
/**
 * The measured cross-run floor for the far-field pixel count, from a bundle in
 * which two arms were byte-identical builds. Printed as context so nobody reads
 * the feature run's number as instability. Range across three pairs in that
 * bundle where a far-field ground change was impossible by construction.
 */
const FLOOR_PCT = "0.025-0.082%";
const FLOOR_PEAK = "159-164";
/**
 * Tolerance for the reference surfaces, set to their MEASURED same-build floor
 * rather than to zero. Between two byte-identical builds, `road asphalt near`
 * came out at peak 0 but `forecourt asphalt` at peak 2 — that box sits high
 * enough in frame to catch a little of what moves behind it. Setting this to 0
 * because 0 is the tidy number is the same error PRIMARY B made.
 *
 * 2 is not a permissive gate here: a guard actually reaching past the fade
 * produces the effect the band shows, mean|d| 12.6, which is six times this.
 */
const REF_PEAK_TOL = 2;

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Mean |Laplacian|: energy at the pixel scale, insensitive to broad shading. */
function hipass(img, [x, y, w, h]) {
  let s = 0, n = 0;
  for (let j = y + 1; j < y + h - 1; j++)
    for (let i = x + 1; i < x + w - 1; i++) {
      const o = (j * img.width + i) * 4;
      s += Math.abs(4 * lum(img.data, o) - lum(img.data, o - 4) - lum(img.data, o + 4) -
        lum(img.data, o - img.width * 4) - lum(img.data, o + img.width * 4));
      n++;
    }
  return s / n;
}

function changed(a, b, [x, y, w, h]) {
  let n = 0, c = 0, sum = 0, worst = 0;
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      const o = (j * a.width + i) * 4;
      const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]));
      n++;
      if (d > 0) { if (d > worst) worst = d; }
      if (d > CHANGE_EPS) { c++; sum += d; }
    }
  return { pct: (c * 100) / n, n, meanDelta: c ? sum / c : 0, worstAnyDelta: worst };
}

if (process.argv.includes("--selftest")) {
  const W = 1600, H = 900;
  let s = 3;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  // The reference boxes stand for surfaces the feature does not touch — asphalt,
  // not dirt — so the synthetic frame must leave them alone too. A selftest that
  // planted grain across them would model a leak and then fail on it.
  const inRef = (i, j) =>
    REFS.some(({ box: [x, y, w, h] }) => i >= x && i < x + w && j >= y && j < y + h);
  const make = (withDetail) => {
    const p = new PNG({ width: W, height: H });
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 4;
        // smooth base everywhere; fine grain added only below row 600 when on
        let v = 26 + Math.sin(i * 0.01) * 4 + Math.cos(j * 0.013) * 3;
        if (withDetail && j >= 600 && !inRef(i, j)) v += (rnd() - 0.5) * 26;
        p.data[o] = p.data[o + 1] = p.data[o + 2] = Math.max(0, Math.min(255, v));
        p.data[o + 3] = 255;
      }
    return p;
  };
  const on = make(true), off = make(false);
  // A gate is not known to work until it has been made to fail on purpose:
  // plant a change on a reference surface and confirm identity rejects it.
  const leaked = make(true);
  {
    const [x, y, w, h] = REFS[0].box;
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) {
        const o = (j * W + i) * 4;
        leaked.data[o] = Math.min(255, leaked.data[o] + REF_PEAK_TOL + 1);
      }
  }
  const leakSeen = REFS.some((r) => changed(leaked, off, r.box).worstAnyDelta > REF_PEAK_TOL);
  const pres = changed(on, off, BAND);
  const iden = changed(on, off, IDENTITY);
  const hpOn = hipass(on, BAND), hpOff = hipass(off, BAND);
  const refClean = REFS.every((r) => changed(on, off, r.box).worstAnyDelta <= REF_PEAK_TOL);
  console.log(`  presence in band      ${pres.pct.toFixed(2)}%  (need >= ${PRESENCE_MIN})`);
  console.log(`  far-field context     ${iden.pct.toFixed(2)}%  worst any-delta ${iden.worstAnyDelta}  (reported, not gated)`);
  console.log(`  identity on refs      ${refClean ? "clean" : "moved"}  (need clean)`);
  console.log(`  planted ref leak seen ${leakSeen ? "yes" : "NO"}  (need yes — the gate must be able to fail)`);
  console.log(`  hipass ${hpOff.toFixed(2)} -> ${hpOn.toFixed(2)}  (must rise)`);
  const pass = pres.pct >= PRESENCE_MIN && refClean && leakSeen && hpOn > hpOff + 1;
  console.log(pass ? "  selftest PASS" : "  selftest FAIL — this judge cannot be trusted");
  process.exit(pass ? 0 : 1);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length !== 2) { console.error("usage: node tools/nearjudge.mjs <default.png> <nonear.png>"); process.exit(2); }
const [A, B] = files.map((f) => {
  const p = PNG.sync.read(fs.readFileSync(f));
  if (!p.width || !p.height) throw new Error(`${f} is ${p.width}x${p.height} — zero-pixel capture`);
  return p;
});
if (A.width !== B.width || A.height !== B.height) throw new Error("arms differ in size");
console.log(`arms: ${files[0]}\n  vs  ${files[1]}   (${A.width}x${A.height})\n`);

const pres = changed(A, B, BAND);
const iden = changed(A, B, IDENTITY);
const hpA = hipass(A, BAND), hpB = hipass(B, BAND);

console.log("PRIMARY A — presence: did the layer act in Film's band?");
console.log(`  changed ${pres.pct.toFixed(2)}%  mean|d| ${pres.meanDelta.toFixed(1)}   predicted >= ${PRESENCE_MIN}%`);
const present = pres.pct >= PRESENCE_MIN;
console.log(`  ${present ? "PRESENT" : "ABSENT — check the gain and the fade range reach this depth"}`);

console.log("\nPRIMARY B — identity: did the layer reach anything past its fade?");
console.log(`  rows 0-599: changed ${iden.pct.toFixed(3)}%, largest delta of ANY size ${iden.worstAnyDelta}`);
console.log(`  context: two captures of the SAME build measure ${FLOOR_PCT} here, peak ${FLOOR_PEAK}.`);
console.log("  The frame is not reproducible run to run (wind-animated foliage, and sky behind it),");
console.log("  so this number cannot be a pass/fail. Identity is judged on the deterministic");
console.log("  surfaces below, which do reproduce exactly.");
const refResults = REFS.map((r) => ({ ...r, c: changed(A, B, r.box) }));
const identical = refResults.every((r) => r.c.worstAnyDelta <= REF_PEAK_TOL);

console.log("\nSECONDARY — appearance: did high-frequency content actually rise?");
console.log(`  band mean|Laplacian| ${hpB.toFixed(2)} -> ${hpA.toFixed(2)}   predicted >= ${HP_MIN} (baseline ${HP_BASELINE}, ceiling ${HP_MAX})`);
let verdictHP;
if (hpA >= HP_MIN && hpA <= HP_MAX) verdictHP = "AS PREDICTED";
else if (hpA > HP_MAX) verdictHP = "OVERSHOT — sharper than the pavement beside it, likely aliasing";
else if (hpA > hpB + 0.3) verdictHP = "PARTIAL — rose but under prediction";
else verdictHP = "NULL — did not rise";
console.log(`  ${verdictHP}`);
if (present && verdictHP.startsWith("NULL"))
  console.log("  -> moving pixels without adding detail. Check nearScale against the texel arithmetic, not the gain.");

console.log(`\nIDENTITY — surfaces past the fade, against their measured floor (peak <= ${REF_PEAK_TOL})`);
for (const r of refResults) {
  const ok = r.c.worstAnyDelta <= REF_PEAK_TOL;
  console.log(
    `  ${r.name.padEnd(32)} changed ${r.c.pct.toFixed(2)}%  peak ${String(r.c.worstAnyDelta).padStart(3)}  ` +
      `${ok ? "AT FLOOR" : "LEAK — the guard is reaching past 8.5 m"}`,
  );
}
console.log(`\ncrop to inspect (note the argument order: in out x y w h scale):`);
console.log(`  node tools/pngcrop.mjs ${files[0]} /tmp/near-on.png 1240 830 160 60 8`);
console.log(`  node tools/pngcrop.mjs ${files[1]} /tmp/near-off.png 1240 830 160 60 8`);

const pass = present && identical;
console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL"}  (presence ${present ? "ok" : "FAILED"}, identity ${identical ? "ok" : "FAILED"})`);
process.exit(pass ? 0 : 1);
