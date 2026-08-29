#!/usr/bin/env node
/**
 * Measure a normal capture using a `?cardebug=` capture of the same pose as a
 * region mask.
 *
 *   node tools/carmask.mjs <normal.png> <mask.png>
 *   node tools/carmask.mjs --selftest
 *
 * The arch reads as a void because the body panel, the arch interior and the
 * tyre all sit within about eleven luminance levels of one another. Measuring
 * that means measuring per surface — and in that frame the surfaces cannot be
 * told apart by eye, so any rectangle an agent draws is a guess about the
 * answer it is trying to find. NOTES case 28: whoever picks the coordinates
 * picks them where their own feature is.
 *
 * So the regions are not chosen at all. The same pose is captured twice from
 * one bundle: once normally, once with the five arch meshes flat-coloured and
 * un-tone-mapped. The debug frame is then a per-pixel ownership map, exact to
 * the byte, and every statistic below is taken over the pixels that surface
 * actually drew.
 *
 * What it reports, per surface and per *boundary between two surfaces*:
 *
 *  - mean, median and interquartile range of display luminance;
 *  - for every adjacent pair, the median luminance step **across their shared
 *    edge**, measured 3 px either side. That last number is the one the eye
 *    uses: an edge exists when the two sides differ, and a region's own mean
 *    says nothing about whether its outline can be found.
 *
 * The step is a median of per-contact-point differences, never a difference of
 * means. Two surfaces can have equal means and a strong edge everywhere (one
 * shaded at the top and lit at the bottom, the other the reverse), and the
 * difference of means would report zero.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Must match DEBUG_COLOURS in src/systems/CarSystem.ts. */
const LABELS = {
  "arch-body": [255, 0, 0],
  "arch-lip": [0, 255, 0],
  "arch-liner": [0, 0, 255],
  "arch-sill": [255, 255, 0],
  "arch-tyre": [255, 0, 255],
  "arch-rim": [0, 255, 255],
};
const NAMES = Object.keys(LABELS);
const TOL = 6;
/** Display luminance, Rec.709 on the sRGB values as stored. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function classify(r, g, b) {
  for (let i = 0; i < NAMES.length; i++) {
    const c = LABELS[NAMES[i]];
    if (Math.abs(r - c[0]) <= TOL && Math.abs(g - c[1]) <= TOL && Math.abs(b - c[2]) <= TOL) return i;
  }
  return -1;
}

function quant(a, q) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, r) => p - r);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/** How far to step away from a boundary before sampling either side. Three
 *  pixels clears the anti-aliased pair without reaching into a third surface
 *  in the thin places, which the lip and the tyre shoulder both are. */
const OFFSET = 3;

function analyse(normal, mask) {
  if (normal.width !== mask.width || normal.height !== mask.height) {
    throw new Error("normal and mask frames differ in size — not the same pose");
  }
  const W = normal.width;
  const H = normal.height;
  const lab = new Int16Array(W * H);
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lab[i] = classify(mask.data[i * 4], mask.data[i * 4 + 1], mask.data[i * 4 + 2]);
    lum[i] = luma(normal.data[i * 4], normal.data[i * 4 + 1], normal.data[i * 4 + 2]);
  }

  const per = NAMES.map(() => []);
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0) per[lab[i]].push(lum[i]);

  // Boundaries. For each 4-neighbour contact between two different labels,
  // step OFFSET px further along the same axis on each side and require both
  // samples still belong to their own label, so the reading is panel-to-panel
  // and not a pair of half-blended edge pixels.
  const edges = new Map();
  const bump = (a, b, va, vb) => {
    const key = a < b ? `${NAMES[a]}|${NAMES[b]}` : `${NAMES[b]}|${NAMES[a]}`;
    const flip = a < b ? 1 : -1;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(flip * (va - vb));
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = lab[i];
      if (a < 0) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const j = at(x + dx, y + dy);
        if (j < 0) continue;
        const b = lab[j];
        if (b < 0 || b === a) continue;
        const pa = at(x - dx * OFFSET, y - dy * OFFSET);
        const pb = at(x + dx * (OFFSET + 1), y + dy * (OFFSET + 1));
        if (pa < 0 || pb < 0 || lab[pa] !== a || lab[pb] !== b) continue;
        bump(a, b, lum[pa], lum[pb]);
      }
    }
  }
  return { W, H, per, edges };
}

function selftest() {
  // Two surfaces with identical means and a strong edge everywhere. A
  // difference-of-means test scores 0; the per-contact median must not.
  const W = 60;
  const H = 40;
  const mask = new PNG({ width: W, height: H });
  const norm = new PNG({ width: W, height: H });
  const put = (png, x, y, c) => {
    const i = (y * W + x) * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const left = x < 30;
      put(mask, x, y, LABELS[left ? "arch-body" : "arch-tyre"]);
      // left is dark at the top and bright at the bottom; right is the reverse.
      const v = left ? (y < 20 ? 40 : 160) : y < 20 ? 160 : 40;
      put(norm, x, y, [v, v, v]);
    }
  }
  const { per, edges } = analyse(norm, mask);
  const meanOf = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const mBody = meanOf(per[NAMES.indexOf("arch-body")]);
  const mTyre = meanOf(per[NAMES.indexOf("arch-tyre")]);
  const step = edges.get("arch-body|arch-tyre") ?? [];
  const absMed = quant(step.map(Math.abs), 0.5);
  const ok = Math.abs(mBody - mTyre) < 0.5 && absMed > 100;
  console.log(`[carmask] selftest means ${mBody.toFixed(1)} vs ${mTyre.toFixed(1)} (equal by construction),`);
  console.log(`[carmask] selftest edge |median step| ${absMed.toFixed(1)} (want > 100, difference-of-means would say 0)`);
  console.log(`[carmask] selftest ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();
const files = argv.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("usage: node tools/carmask.mjs <normal.png> <mask.png> | --selftest");
  process.exit(2);
}

const normal = PNG.sync.read(fs.readFileSync(files[0]));
const mask = PNG.sync.read(fs.readFileSync(files[1]));
const { per, edges } = analyse(normal, mask);

console.log(`\nnormal ${path.relative(ROOT, files[0])}\nmask   ${path.relative(ROOT, files[1])}\n`);
console.log("surface        px      mean   p25   p50   p75   IQR");
for (let i = 0; i < NAMES.length; i++) {
  const a = per[i];
  if (!a.length) {
    console.log(`${NAMES[i].padEnd(12)}      0   — surface drew nothing in this pose`);
    continue;
  }
  const mean = a.reduce((p, q) => p + q, 0) / a.length;
  const p25 = quant(a, 0.25);
  const p50 = quant(a, 0.5);
  const p75 = quant(a, 0.75);
  console.log(
    `${NAMES[i].padEnd(12)} ${String(a.length).padStart(6)}  ${mean.toFixed(1).padStart(6)} ` +
      `${p25.toFixed(1).padStart(5)} ${p50.toFixed(1).padStart(5)} ${p75.toFixed(1).padStart(5)} ${(p75 - p25).toFixed(1).padStart(5)}`
  );
}

console.log("\nboundary                        contacts   |median step|   p90");
const rows = [...edges.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [key, vals] of rows) {
  const abs = vals.map(Math.abs);
  console.log(
    `${key.padEnd(32)} ${String(vals.length).padStart(8)}   ${quant(abs, 0.5).toFixed(1).padStart(11)}   ${quant(abs, 0.9).toFixed(1).padStart(5)}`
  );
}
console.log(
  "\nAn edge the eye can find wants roughly 8+ levels of median step. Below about\n" +
    "4 the two surfaces merge into one mass whatever their own means are."
);
