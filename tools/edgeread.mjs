#!/usr/bin/env node
/**
 * Does an edge or a groove actually READ, in a given capture?
 *
 * Written because two instruments have now told me a feature was fine when it
 * was not, and the second one was mine and it flattered me. `seamprobe` proved
 * the shut lines exist in screen space, which was true, and then scored their
 * contrast with min-over-a-window - a statistic that cannot tell a 4 mm groove
 * from the edge of a shadow, and duly reported -55 and -66 where the honest
 * figure was -10.
 *
 * So this measures two things and nothing else, both against the LOCAL
 * surround rather than a region average:
 *
 *   groove  - for a horizontal feature at row y, the darkest and brightest row
 *             within +-4 px, each expressed against the mean of the plate 6..12
 *             px above AND below. A real shut line is darker in the slot and
 *             brighter on one lip *relative to the panel touching it*. A
 *             shadow edge, by contrast, moves the whole surround, so both
 *             references shift with it and the score collapses - which is
 *             exactly the discrimination the old metric lacked.
 *
 *   arris   - for a vertical corner, the number of intermediate pixel columns
 *             between the lit face level and the shaded face level. This is the
 *             thing a viewer calls a chamfer: not its width in millimetres but
 *             how many columns carry a value that belongs to neither face. Zero
 *             transition columns is a razor edge no matter what the geometry says.
 *
 * Usage:
 *   node tools/edgeread.mjs groove <png> <x> <y>...
 *   node tools/edgeread.mjs arris  <png> <y> <xFrom> <xTo>
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const mode = process.argv[2];
const png = PNG.sync.read(fs.readFileSync(process.argv[3]));
const lum = (x, y) => {
  const i = (png.width * y + x) * 4;
  return 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
};
/** Row luminance averaged across a +-10 px column band, to beat grime speckle. */
const rowAt = (x, y) => {
  let s = 0;
  let n = 0;
  for (let d = -10; d <= 10; d++, n++) s += lum(x + d, y);
  return s / n;
};
const colAt = (x, y, half = 8) => {
  let s = 0;
  let n = 0;
  for (let d = -half; d <= half; d++, n++) s += lum(x, y + d);
  return s / n;
};

if (mode === "groove") {
  const x = +process.argv[4];
  console.log(`groove read at column band x=${x}+-10`);
  console.log("  ref = mean of plate 6..12 px above and below, measured separately");
  console.log();
  for (const arg of process.argv.slice(5)) {
    const y = +arg;
    const above = [];
    const below = [];
    for (let d = 6; d <= 12; d++) above.push(rowAt(x, y - d));
    for (let d = 6; d <= 12; d++) below.push(rowAt(x, y + d));
    const mA = above.reduce((a, b) => a + b, 0) / above.length;
    const mB = below.reduce((a, b) => a + b, 0) / below.length;
    const local = [];
    for (let d = -4; d <= 4; d++) local.push({ y: y + d, v: rowAt(x, y + d) });
    const dark = local.reduce((a, b) => (b.v < a.v ? b : a));
    const brite = local.reduce((a, b) => (b.v > a.v ? b : a));
    // Score against the NEARER reference, which is the conservative choice: it
    // refuses to credit a groove for darkness that is really a shadow gradient.
    const ref = Math.min(mA, mB);
    console.log(`  y=${y}  plate above ${mA.toFixed(1)}  below ${mB.toFixed(1)}  (tilt ${(mB - mA).toFixed(1)})`);
    console.log(
      `        slot  ${dark.v.toFixed(1)} at y=${dark.y}   vs nearer plate ${ref.toFixed(1)}  ->  ${(dark.v - ref).toFixed(1)}`
    );
    console.log(
      `        lip   ${brite.v.toFixed(1)} at y=${brite.y}   vs brighter plate ${Math.max(mA, mB).toFixed(1)}  ->  +${(brite.v - Math.max(mA, mB)).toFixed(1)}`
    );
    console.log(`        profile ${local.map((l) => l.v.toFixed(0)).join(" ")}`);
    console.log();
  }
}

if (mode === "arris") {
  const y = +process.argv[4];
  const x0 = +process.argv[5];
  const x1 = +process.argv[6];
  const vals = [];
  for (let x = x0; x <= x1; x++) vals.push({ x, v: colAt(x, y) });
  // Steepest single-column step is taken as the corner.
  let best = { d: 0, x: x0 };
  for (let i = 1; i < vals.length; i++) {
    const d = Math.abs(vals[i].v - vals[i - 1].v);
    if (d > best.d) best = { d, x: vals[i].x };
  }
  const cx = best.x;
  const left = vals.filter((v) => v.x >= cx - 14 && v.x <= cx - 6).map((v) => v.v);
  const right = vals.filter((v) => v.x >= cx + 6 && v.x <= cx + 14).map((v) => v.v);
  const mL = left.reduce((a, b) => a + b, 0) / left.length;
  const mR = right.reduce((a, b) => a + b, 0) / right.length;
  const lo = Math.min(mL, mR);
  const hi = Math.max(mL, mR);
  // A column is "transitional" if it sits clear of both face plateaus.
  const pad = Math.max(3, (hi - lo) * 0.12);
  const trans = vals.filter((v) => v.x > cx - 6 && v.x < cx + 6 && v.v > lo + pad && v.v < hi - pad);
  // And "a rim line" only if some column exceeds the brighter face.
  const over = vals.filter((v) => v.x > cx - 6 && v.x < cx + 6 && v.v > hi + 2);
  console.log(`arris read at row y=${y}, searched x ${x0}..${x1}`);
  console.log(`  corner at x=${cx}, step ${best.d.toFixed(1)}`);
  console.log(`  face levels: ${mL.toFixed(1)} | ${mR.toFixed(1)}   (span ${(hi - lo).toFixed(1)})`);
  console.log(`  transition columns clear of both faces: ${trans.length}  ${trans.map((t) => t.x + ":" + t.v.toFixed(0)).join(" ")}`);
  console.log(`  columns BRIGHTER than the lit face (a rim line): ${over.length}  ${over.map((t) => t.x + ":" + t.v.toFixed(0)).join(" ")}`);
  console.log(`  profile ${vals.filter((v) => Math.abs(v.x - cx) <= 10).map((v) => v.v.toFixed(0)).join(" ")}`);
}
