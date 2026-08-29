#!/usr/bin/env node
/**
 * dirtjudge.mjs — judge the open-dirt scatter against a prediction made first.
 *
 *   node tools/dirtjudge.mjs <default.png> <noopendirt.png>
 *   node tools/dirtjudge.mjs --selftest
 *
 * WHY THIS TOOL EXISTS AND `vergejudge.mjs` IS NOT REUSED. Round 1 predicted a
 * spread rise in this same band, measured no rise, and exited 1. The cause was
 * not the palette and not the tone: **zero stones were in the band.** Every
 * measurement was correct and the object being measured was not there. So the
 * ordering of the checks is the whole design here — presence is asked first and
 * appearance second, because a correct finding about an absent object is
 * indistinguishable from a finding about a present one until you ask.
 *
 * THE PREDICTION, recorded before the pixels existed:
 *
 *   PRIMARY (presence). Changed pixels between `default` and `?tforce=noopendirt`
 *   inside the band rise from an observed 0.00% to **at least 2.0%**. The two
 *   arms place an identical number of stones and differ only in where, so any
 *   changed pixel in the band is a stone that the floor put there.
 *
 *   SECONDARY (appearance). The band's p10-p90 luma spread rises from 13.7 to
 *   **15.5-19.0**.
 *
 *   That range is calibrated, not guessed, and the calibration is the reason it
 *   is so much lower than round 1's "high 20s". Injecting synthetic stone pixels
 *   into the real archived band at known coverage gives:
 *
 *     coverage    1%    2%    3%    4%    6%    8%   10%   14%   20%
 *     spread    14.3  14.6  15.0  15.6  16.9  18.4  19.6  21.8  24.8
 *
 *   CPU simulation over 8 seeds puts 5.9 stones in the 3.71 m2 band against 1.6
 *   today. At 4.2-5.7 m a mean stone is ~25 px wide and ~10 px tall with a ~20 px
 *   shadow at a 6.2 deg sun, so ~550 px each, or 6.5% of the band's 50,000 px.
 *   Call it 4-9% for the spread of the size distribution: spread 15.6-18.4.
 *
 *   **So the honest prediction is that this is a small number.** Round 1
 *   predicted 25-34 with no arithmetic behind it and would have been wrong about
 *   the magnitude even if the stones had landed. A prediction that cannot be
 *   derived is a hope.
 *
 * FAILURE BRANCH, fixed in advance. If the spread does not move, read the
 * PRIMARY line before touching anything. Changed pixels near zero means nothing
 * landed and the gate is the thing to look at — not the palette, not the tone,
 * not the size distribution.
 *
 * WHAT THE BAND ACTUALLY IS, since the brief and I both had it wrong. It
 * unprojects to world z 5.55-7.5 against a road edge at z 5.16, so it is a road
 * verge 0.4-2.3 m out from pavement, not open ground. 5.25 of its 5.88 stones
 * come from the road-edge branch. Scoping the floor to open ground only — the
 * literal reading of the instruction — measured 0.37 stones/m2, below the 0.44
 * it was meant to improve on.
 *
 * THE ARMS. Both place 12,000 stones; the loop runs to a fixed count and the
 * gate sets only where they land.
 *
 *   default              acceptance = max(fines * 0.9, 0.30)
 *   ?tforce=noopendirt   acceptance = fines * 0.9          (as shipped before)
 *
 * AND EVERY ARM MUST STAY IN ITS LANE. The floor redistributes site-wide, so
 * this one genuinely can move regions it has no business in. The reference
 * boxes below contain no ground at all, or ground the scatter never reaches.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

/** FIXED pixel boxes, identical in every arm. The band is the one Film named,
 *  unprojected to world x -14.25..-12.35, z 5.55..7.5 — the strip between the
 *  road edge at z 5.16 and the forecourt pad at z 8.4, 4.2-5.7 m from the eye. */
const REGIONS = [
  { name: "BAND (spawn foreground)", box: [1100, 800, 500, 100], role: "target" },
  { name: "band, mid depth", box: [1150, 660, 450, 100], role: "target" },
  { name: "asphalt road, bottom left", box: [60, 780, 380, 110], role: "reference" },
  { name: "asphalt forecourt", box: [700, 520, 400, 60], role: "reference" },
  { name: "canopy soffit", box: [500, 150, 300, 40], role: "reference" },
];

const PRIMARY_MIN_CHANGED = 2.0; // per cent of band pixels
const SPREAD_LO = 15.5;
const SPREAD_HI = 19.0;
const BASELINE_SPREAD = 13.7;
/** A pixel counts as changed if any channel moves by more than this. Above
 *  sensor-free renderer noise (which is zero here — the same seed renders the
 *  same bytes) but low enough to catch a stone's penumbra. */
const CHANGE_EPS = 6;

const luma = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

function statsOf(img, [x, y, w, h]) {
  const v = [];
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) v.push(luma(img.data, (j * img.width + i) * 4));
  v.sort((a, b) => a - b);
  const q = (f) => v[Math.min(v.length - 1, Math.floor(v.length * f))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), spread: q(0.9) - q(0.1), mean, n: v.length };
}

/** Fraction of pixels in the box that differ between two arms, and how far. */
function changedIn(a, b, [x, y, w, h]) {
  let n = 0, changed = 0, sumAbs = 0, darker = 0, brighter = 0;
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      const o = (j * a.width + i) * 4;
      const d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2])
      );
      n++;
      if (d > CHANGE_EPS) {
        changed++;
        sumAbs += d;
        if (luma(a.data, o) < luma(b.data, o)) darker++;
        else brighter++;
      }
    }
  return { pct: (changed * 100) / n, changed, n, meanDelta: changed ? sumAbs / changed : 0, darker, brighter };
}

if (process.argv.includes("--selftest")) {
  /**
   * Two halves, because a gate that cannot fail is not a gate. The tool must
   * SEE planted stones and must REJECT a band where nothing was planted — the
   * second half is the round-1 failure, and a judge that passes it is useless.
   */
  const W = 1600, H = 900;
  const make = (withStones) => {
    const png = new PNG({ width: W, height: H });
    let s = 7;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    // Base matched to the real band (p10 23, p50 29, p90 37, spread 13.7)
    // rather than a tight uniform. A selftest standing in for a distribution
    // has to have that distribution's shape, or it calibrates nothing: a
    // uniform 40-50 base moves its percentiles quite differently under the
    // same planted coverage, and the tool would fail on a correct frame.
    for (let i = 0; i < W * H * 4; i += 4) {
      const g = 12 + (rnd() + rnd() + rnd()) * 12;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = g;
      png.data[i + 3] = 255;
    }
    // 20 stones is ~9.6% of the band, the coverage at which the calibration
    // table says the spread should move. Six was 2.9%, where it provably does
    // not — planting an amount the prediction says is invisible and demanding
    // the tool see it is a selftest that fails for the wrong reason.
    if (withStones)
      for (let k = 0; k < 20; k++) {
        const cx = 1120 + rnd() * 460, cy = 810 + rnd() * 80;
        for (let j = -5; j < 5; j++)
          for (let i = -12; i < 12; i++) {
            const o = (((cy + j) | 0) * W + ((cx + i) | 0)) * 4;
            // 60% shadow, 40% lit face — the same mix the calibration table used.
            const v = rnd() < 0.6 ? 8 + rnd() * 10 : 18 + rnd() * 77;
            png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
          }
      }
    return png;
  };
  const withS = make(true), without = make(false);
  const pos = changedIn(withS, without, REGIONS[0].box);
  const neg = changedIn(without, without, REGIONS[0].box);
  const spreadRose = statsOf(withS, REGIONS[0].box).spread > statsOf(without, REGIONS[0].box).spread + 2;
  console.log(`  planted stones   -> changed ${pos.pct.toFixed(2)}%  (need >= ${PRIMARY_MIN_CHANGED})`);
  console.log(`  identical frames -> changed ${neg.pct.toFixed(2)}%  (need 0.00)`);
  console.log(`  planted stones   -> spread rose: ${spreadRose}`);
  const pass = pos.pct >= PRIMARY_MIN_CHANGED && neg.pct === 0 && spreadRose;
  console.log(pass ? "  selftest PASS" : "  selftest FAIL — this judge cannot be trusted");
  process.exit(pass ? 0 : 1);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("usage: node tools/dirtjudge.mjs <default.png> <noopendirt.png>");
  process.exit(2);
}
const imgs = files.map((f) => {
  const p = PNG.sync.read(fs.readFileSync(f));
  if (!p.width || !p.height) throw new Error(`${f} is ${p.width}x${p.height} — zero-pixel capture`);
  return p;
});
const [dflt, ctrl] = imgs;
if (dflt.width !== ctrl.width || dflt.height !== ctrl.height) throw new Error("arms differ in size");
console.log(`arms: ${files[0]}  vs  ${files[1]}   (${dflt.width}x${dflt.height})\n`);

console.log("region                        arm            p10   p50   p90  spread |  changed%  mean|d|  dark/bright");
for (const r of REGIONS) {
  const a = statsOf(dflt, r.box), b = statsOf(ctrl, r.box), c = changedIn(dflt, ctrl, r.box);
  const fmt = (s) => `${s.p10.toFixed(0).padStart(5)}${s.p50.toFixed(0).padStart(6)}${s.p90.toFixed(0).padStart(6)}${s.spread.toFixed(1).padStart(8)}`;
  console.log(`${r.name.padEnd(28)}  default    ${fmt(a)} | ${c.pct.toFixed(2).padStart(8)}  ${c.meanDelta.toFixed(1).padStart(7)}  ${c.darker}/${c.brighter}`);
  console.log(`${"".padEnd(28)}  noopendirt ${fmt(b)} |`);
}

const band = REGIONS[0];
const bandChanged = changedIn(dflt, ctrl, band.box);
const bandDflt = statsOf(dflt, band.box);

console.log(`\n${"=".repeat(78)}`);
console.log("PRIMARY — did anything land in the band?");
console.log(`  changed pixels ${bandChanged.pct.toFixed(2)}%   predicted >= ${PRIMARY_MIN_CHANGED}%   (round 1 measured 0.00%)`);
const present = bandChanged.pct >= PRIMARY_MIN_CHANGED;
console.log(present ? "  PRESENT — stones landed in the band." : "  ABSENT — nothing landed. The gate is the thing to look at.");

console.log("\nSECONDARY — does it read?");
console.log(`  band spread ${bandDflt.spread.toFixed(1)}   predicted ${SPREAD_LO}-${SPREAD_HI}   baseline ${BASELINE_SPREAD}`);
let appearance;
if (bandDflt.spread >= SPREAD_LO && bandDflt.spread <= SPREAD_HI) appearance = "AS PREDICTED";
else if (bandDflt.spread > SPREAD_HI) appearance = "OVERSHOT — more than predicted, say so rather than claiming the prediction";
else if (bandDflt.spread > BASELINE_SPREAD + 1) appearance = "PARTIAL — moved, but under prediction";
else appearance = "NULL — did not move";
console.log(`  ${appearance}`);
if (!present && appearance.startsWith("NULL"))
  console.log("  -> This is round 1 again. Do NOT touch the palette, tone or size. Check the gate.");

console.log("\nLANE — reference regions must not move");
let lane = true;
for (const r of REGIONS.filter((x) => x.role === "reference")) {
  const c = changedIn(dflt, ctrl, r.box), a = statsOf(dflt, r.box), b = statsOf(ctrl, r.box);
  const dp50 = Math.abs(a.p50 - b.p50);
  const ok = c.pct < 0.5 && dp50 <= 1.5;
  if (!ok) lane = false;
  console.log(`  ${r.name.padEnd(28)} changed ${c.pct.toFixed(2).padStart(5)}%  p50 move ${dp50.toFixed(1)}  ${ok ? "ok" : "OUT OF LANE"}`);
}

console.log(`\ncrops to look at (feature is small; judge it at its own scale, not in an 800 px view):`);
console.log(`  node tools/pngcrop.mjs ${files[0]} /tmp/band-default.png ${band.box.join(" ")} 3`);
console.log(`  node tools/pngcrop.mjs ${files[1]} /tmp/band-control.png ${band.box.join(" ")} 3`);

const verdict = present && lane;
console.log(`\nVERDICT: ${verdict ? "PASS" : "FAIL"}  (presence ${present ? "ok" : "FAILED"}, lane ${lane ? "ok" : "FAILED"})`);
console.log("Presence is the gate. A good-looking spread on a band with no stones in it is round 1.");
process.exit(verdict ? 0 : 1);
