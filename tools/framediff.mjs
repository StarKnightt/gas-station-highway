#!/usr/bin/env node
/**
 * Where do two frames differ, and by how much? Swept, not hand-picked.
 *
 * Written after a round in which two changes each measured as "no effect" in a
 * region chosen before the capture. A null result from a hand-picked region is
 * the weakest evidence in this project: it cannot distinguish "the change did
 * nothing" from "the change did something somewhere else". This tiles the whole
 * frame, ranks the tiles by mean luma difference, and prints the top ones, so
 * the answer to "did it do anything" is a location as well as a number.
 *
 * Also reports the fraction of pixels that changed at all, which separates
 * "a small change everywhere" from "a large change in one place" — those have
 * the same mean and completely different causes.
 *
 *   node tools/framediff.mjs a.png b.png [--tile=100] [--top=12]
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const opt = (n, d) => {
  const h = args.find((a) => a.startsWith(`--${n}=`));
  return h ? Number(h.slice(n.length + 3)) : d;
};
if (files.length !== 2) {
  console.error("usage: framediff.mjs a.png b.png [--tile=100] [--top=12]");
  process.exit(2);
}
const TILE = opt("tile", 100);
const TOP = opt("top", 12);

const read = (p) => PNG.sync.read(fs.readFileSync(p));
const A = read(files[0]);
const B = read(files[1]);
if (A.width !== B.width || A.height !== B.height) {
  console.error(`size mismatch: ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  process.exit(2);
}
const W = A.width;
const H = A.height;
const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

let changed = 0;
let sumAbs = 0;
let maxAbs = 0;
const tiles = [];
for (let ty = 0; ty < Math.ceil(H / TILE); ty++) {
  for (let tx = 0; tx < Math.ceil(W / TILE); tx++) {
    let n = 0;
    let dL = 0;
    let dR = 0;
    let dB = 0;
    let hit = 0;
    for (let y = ty * TILE; y < Math.min(H, (ty + 1) * TILE); y++) {
      for (let x = tx * TILE; x < Math.min(W, (tx + 1) * TILE); x++) {
        const i = (y * W + x) * 4;
        const la = luma(A.data, i);
        const lb = luma(B.data, i);
        const d = la - lb;
        dL += d;
        dR += A.data[i] - B.data[i];
        dB += A.data[i + 2] - B.data[i + 2];
        if (Math.abs(d) >= 1) hit++;
        sumAbs += Math.abs(d);
        maxAbs = Math.max(maxAbs, Math.abs(d));
        n++;
      }
    }
    changed += hit;
    tiles.push({
      x: tx * TILE,
      y: ty * TILE,
      n,
      mean: dL / n,
      frac: hit / n,
      warm: dR / n - dB / n,
    });
  }
}

const total = W * H;
console.log(`\n${files[0]}\n  vs ${files[1]}\n`);
console.log(
  `whole frame: mean |dLuma| ${(sumAbs / total).toFixed(3)}   max ${maxAbs.toFixed(0)}   ` +
    `pixels changed >=1 luma: ${((changed / total) * 100).toFixed(1)}%`
);
if (maxAbs === 0) {
  console.log("\nframes are byte-identical in luma — the change had no effect on this preset at all\n");
  process.exit(0);
}

tiles.sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
console.log(`\ntop ${TOP} tiles of ${TILE}px by signed mean luma change (a - b), with the warm shift:`);
console.log("    x     y     dLuma   d(R-B)   %px changed");
for (const t of tiles.slice(0, TOP)) {
  console.log(
    `  ${String(t.x).padStart(4)}  ${String(t.y).padStart(4)}   ` +
      `${t.mean >= 0 ? "+" : ""}${t.mean.toFixed(2).padStart(6)}   ` +
      `${t.warm >= 0 ? "+" : ""}${t.warm.toFixed(2).padStart(6)}   ${(t.frac * 100).toFixed(1)}%`
  );
}
console.log("");
