#!/usr/bin/env node
/**
 * How big are the differences, not how many.
 *
 * `vegwindprobe.mjs` reports a changed-pixel count and a peak, and neither can
 * distinguish "the crowns are breathing" from "the crowns are shimmering". A
 * peak of 172 is what *any* sub-pixel motion produces at a needle/sky edge —
 * one pixel flipping between a dark needle and a bright dawn sky is a 170-code
 * change no matter how small the movement that caused it. So the count and the
 * peak together are consistent with both the effect we want and the effect we
 * were told would be worse than stillness.
 *
 * What separates them is the *distribution*. Motion that reads as air is almost
 * entirely small deltas on edge pixels with a thin tail; motion that reads as a
 * sway moves interior pixels too and has a fat middle.
 *
 * Reads the PNGs already on disk. No card, no browser, no rebuild.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "capture-vegwind-0829");

const PAIRS = [
  ["A-null-early", "A2-null-early", "determinism floor"],
  ["C-ship-early", "D-ship-late", "shipping wind, four seconds apart"],
  ["A-null-early", "E-x8-early", "8x wind against still"],
  ["A-null-early", "F-nodamp-null", "minification damping, wind held at zero"],
  ["I-ground-null", "K-ground-nodamp", "minification damping, knee height"],
];

const read = (id) => PNG.sync.read(fs.readFileSync(path.join(DIR, `${id}.png`)));

for (const [a, b, why] of PAIRS) {
  const A = read(a);
  const B = read(b);
  const n = A.width * A.height;
  const deltas = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const d = Math.max(
      Math.abs(A.data[j] - B.data[j]),
      Math.abs(A.data[j + 1] - B.data[j + 1]),
      Math.abs(A.data[j + 2] - B.data[j + 2])
    );
    if (d > 0) {
      deltas.push(d);
      sum += d;
    }
  }
  deltas.sort((x, y) => x - y);
  const q = (p) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))] : 0);
  // Fraction of the WHOLE frame that moved by more than a just-noticeable
  // amount. Three codes is about where a difference stops being invisible on a
  // mid-grey and starts being something a viewer could point at.
  const over3 = deltas.filter((d) => d > 3).length;
  const over12 = deltas.filter((d) => d > 12).length;
  console.log(
    `${a} vs ${b}  (${why})\n` +
      `  changed ${deltas.length} px (${((deltas.length / n) * 100).toFixed(2)}% of frame)\n` +
      `  delta over changed px: mean ${(sum / Math.max(1, deltas.length)).toFixed(1)}  ` +
      `median ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  max ${deltas.at(-1) ?? 0}\n` +
      `  >3 codes: ${over3} px (${((over3 / n) * 100).toFixed(2)}% of frame)   ` +
      `>12 codes: ${over12} px (${((over12 / n) * 100).toFixed(2)}% of frame)\n`
  );
}
