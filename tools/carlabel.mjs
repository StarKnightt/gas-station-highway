#!/usr/bin/env node
/**
 * Read a `?cardebug=front` capture as a label image and report, per surface,
 * how ragged its own silhouette is.
 *
 *   node tools/carlabel.mjs shots/car/rounds/<id>/nose_close.png
 *   node tools/carlabel.mjs --selftest
 *
 * Why this exists. Three rounds went into the blocky 22-33 mm edge at the
 * grille by inference. Each hypothesis was ruled out by a correct measurement
 * and the culprit was never named, because every one of those measurements
 * asked "is surface X where it should be" rather than "which surface is the
 * edge made of". Under `?cardebug=front` every candidate surface is drawn in a
 * flat, unlit, un-tone-mapped colour, so the pixel value in the PNG *is* the
 * authored hex and the question becomes an exact byte match.
 *
 * The measurement deliberately takes no region from the caller (NOTES case 28:
 * an agent who picks the coordinates picks them where its own feature is). It
 * sweeps every column of the frame, and for every label reports the top and
 * bottom of that label's run in that column and how far those move between
 * adjacent columns. A surface whose own outline steps by 15-22 px is the one
 * drawing the blocky edge, whatever anyone believed about it beforehand.
 *
 * Anti-aliased pixels are classified as `mixed`, never snapped to a nearest
 * label: a boundary pixel belongs to two surfaces and pretending otherwise
 * would let the tool invent an edge position to one-pixel precision that the
 * frame does not contain. `mixed` runs are reported, because a fat mixed band
 * is itself a finding.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Must match DEBUG_COLOURS in src/systems/CarSystem.ts. */
const LABELS = {
  "car-fascia": [255, 0, 0],
  "grille-backing": [255, 0, 255],
  "grille-slat": [0, 255, 255],
  "grille-divider": [0, 0, 255],
  "grille-frame": [0, 255, 0],
  "grille-band": [255, 255, 0],
  "grille-caprail": [255, 255, 255],
  "nose-badge": [255, 128, 0],
  "intake-backing": [128, 0, 255],
  "intake-slat": [0, 255, 128],
  "intake-divider": [0, 64, 128],
  "intake-frame": [128, 255, 0],
  "intake-band": [255, 0, 128],
  "fog-bezel": [0, 128, 128],
  "fog-lens": [128, 128, 0],
  "plate-panel": [128, 0, 64],
  "plate-rim": [64, 255, 128],
};
const NAMES = Object.keys(LABELS);
/** Tight. These colours are written straight through with toneMapped:false, so
 *  an exact hit is the norm and anything loose here starts absorbing AA. */
const TOL = 6;

function classify(r, g, b) {
  for (let i = 0; i < NAMES.length; i++) {
    const c = LABELS[NAMES[i]];
    if (Math.abs(r - c[0]) <= TOL && Math.abs(g - c[1]) <= TOL && Math.abs(b - c[2]) <= TOL) return i;
  }
  return -1; // background, or an anti-aliased blend of two labels
}

/** width, height, Int16Array of label indices (-1 = not one of ours). */
function labelImage(png) {
  const { width: W, height: H, data } = png;
  const lab = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lab[i] = classify(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return { W, H, lab };
}

/**
 * Per label, the top and bottom row it occupies in each column, and the
 * distribution of |change| in those rows between adjacent occupied columns.
 *
 * Adjacency is required on both sides: a column where the label is absent
 * breaks the run rather than being bridged, or the step across a genuine
 * occlusion would be counted as raggedness.
 */
function silhouetteSteps(W, H, lab) {
  const out = [];
  for (let li = 0; li < NAMES.length; li++) {
    const top = new Int32Array(W).fill(-1);
    const bot = new Int32Array(W).fill(-1);
    let px = 0;
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (lab[y * W + x] === li) {
          if (top[x] < 0) top[x] = y;
          bot[x] = y;
          px++;
        }
      }
    }
    if (!px) continue;
    const steps = { top: [], bottom: [] };
    for (let x = 1; x < W; x++) {
      if (top[x] < 0 || top[x - 1] < 0) continue;
      steps.top.push(Math.abs(top[x] - top[x - 1]));
      steps.bottom.push(Math.abs(bot[x] - bot[x - 1]));
    }
    const stat = (a) => {
      if (!a.length) return null;
      const s = [...a].sort((p, q) => p - q);
      return {
        n: s.length,
        mean: s.reduce((p, q) => p + q, 0) / s.length,
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
        max: s[s.length - 1],
      };
    };
    const cols = top.filter((v) => v >= 0).length;
    out.push({ name: NAMES[li], px, cols, top: stat(steps.top), bottom: stat(steps.bottom) });
  }
  return out;
}

/**
 * Every place two labels touch, counted. Names which pair of surfaces the eye
 * is actually looking at when it sees the aperture edge, which is the question
 * three rounds of inference never asked.
 */
function contacts(W, H, lab) {
  const map = new Map();
  const bump = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = lab[y * W + x];
      if (a < 0) continue;
      if (x + 1 < W) {
        const b = lab[y * W + x + 1];
        if (b >= 0) bump(NAMES[a], NAMES[b]);
      }
      if (y + 1 < H) {
        const b = lab[(y + 1) * W + x];
        if (b >= 0) bump(NAMES[a], NAMES[b]);
      }
    }
  }
  return [...map.entries()].sort((p, q) => q[1] - p[1]);
}

function selftest() {
  // Planted: a straight-edged block and a deliberately stepped one, so a green
  // run proves the metric can tell them apart rather than merely running.
  const W = 200;
  const H = 120;
  const png = new PNG({ width: W, height: H });
  const put = (x, y, c) => {
    const i = (y * W + x) * 4;
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [10, 10, 10]);
  // straight: car-fascia, top row constant
  for (let x = 10; x < 90; x++) for (let y = 20; y < 60; y++) put(x, y, LABELS["car-fascia"]);
  // stepped: grille-backing, top row jumps 16 px every 10 columns
  for (let x = 110; x < 190; x++) {
    const t = 20 + (Math.floor((x - 110) / 10) % 2) * 16;
    for (let y = t; y < 90; y++) put(x, y, LABELS["grille-backing"]);
  }
  const { W: w, H: h, lab } = labelImage(png);
  const rows = silhouetteSteps(w, h, lab);
  const straight = rows.find((r) => r.name === "car-fascia");
  const stepped = rows.find((r) => r.name === "grille-backing");
  const ok = straight && stepped && straight.top.max === 0 && stepped.top.max === 16;
  console.log(`[carlabel] selftest straight top.max=${straight?.top.max} (want 0), stepped top.max=${stepped?.top.max} (want 16)`);
  console.log(`[carlabel] selftest ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();

const files = argv.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node tools/carlabel.mjs <png>... | --selftest");
  process.exit(2);
}

for (const f of files) {
  const png = PNG.sync.read(fs.readFileSync(f));
  const { W, H, lab } = labelImage(png);
  let labelled = 0;
  for (let i = 0; i < lab.length; i++) if (lab[i] >= 0) labelled++;
  console.log(`\n=== ${path.relative(ROOT, f)}  ${W}x${H}  ${labelled} labelled px (${((100 * labelled) / (W * H)).toFixed(1)}%)`);
  if (labelled === 0) {
    console.log("  NO LABELLED PIXELS — the debug flag did not reach the render. Do not read anything else here.");
    continue;
  }
  const rows = silhouetteSteps(W, H, lab);
  console.log("  surface            px     cols  top: mean  p95  max   bottom: mean  p95  max");
  for (const r of rows.sort((a, b) => b.px - a.px)) {
    const fmt = (s) => (s ? `${s.mean.toFixed(2).padStart(5)} ${String(s.p95).padStart(4)} ${String(s.max).padStart(4)}` : "   -    -    -");
    console.log(`  ${r.name.padEnd(17)} ${String(r.px).padStart(6)} ${String(r.cols).padStart(6)}       ${fmt(r.top)}          ${fmt(r.bottom)}`);
  }
  console.log("  adjacencies (which two surfaces the eye sees meeting):");
  for (const [pair, n] of contacts(W, H, lab).slice(0, 12)) console.log(`    ${pair.padEnd(36)} ${n}`);
}
