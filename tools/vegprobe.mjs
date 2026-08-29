#!/usr/bin/env node
/**
 * Region and per-pixel probes for System 6.
 *
 * `tools/diff.mjs` reports a whole-image changed-pixel percentage, and the
 * terrain agent has already been bitten once by that number: a completely
 * missing feature showed as 1.53% changed, because thin objects occupy a tiny
 * fraction of a 1600x900 frame. Grass blades, fence wire, pine needles and a
 * treeline on the horizon are all in that category, so this tool asks the
 * question the right way round: *inside this box, where the thing should be,
 * did anything move?*
 *
 *   node tools/vegprobe.mjs a.png b.png --box=horizon:0,470,1600,560 [--thr=3]
 *   node tools/vegprobe.mjs a.png            --px=800,520 --px=400,700
 *   node tools/vegprobe.mjs a.png            --column=800     # vertical profile
 *
 * Pure computation. No server, no browser, nothing to tear down.
 */

import fs from "node:fs";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const opt = (name) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const thr = Number(opt("thr")[0] ?? 3);

if (!files.length) {
  console.error("usage: vegprobe.mjs a.png [b.png] --box=name:x0,y0,x1,y1 | --px=x,y | --column=x");
  process.exit(2);
}

const read = (p) => PNG.sync.read(fs.readFileSync(p));
const A = read(files[0]);
const B = files[1] ? read(files[1]) : null;
if (B && (A.width !== B.width || A.height !== B.height)) {
  console.error("size mismatch");
  process.exit(2);
}

const at = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/* ---------------- boxed diff ---------------- */

const boxes = opt("box");
if (boxes.length) {
  if (!B) {
    console.error("--box needs two images");
    process.exit(2);
  }
  console.log(`${files[0]}  vs  ${files[1]}   (threshold ${thr})`);
  console.log("box                   px      changed      %      max   meanA   meanB");
  for (const spec of boxes) {
    const [name, coords] = spec.includes(":") ? spec.split(":") : ["box", spec];
    const [x0, y0, x1, y1] = coords.split(",").map(Number);
    let n = 0;
    let changed = 0;
    let max = 0;
    let sa = 0;
    let sb = 0;
    for (let y = Math.max(0, y0); y < Math.min(A.height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(A.width, x1); x++) {
        const ca = at(A, x, y);
        const cb = at(B, x, y);
        const d = Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2]));
        n++;
        sa += lum(ca);
        sb += lum(cb);
        if (d > max) max = d;
        if (d > thr) changed++;
      }
    }
    const pct = n ? ((changed / n) * 100).toFixed(2) : "0";
    console.log(
      `${name.padEnd(18)} ${String(n).padStart(7)} ${String(changed).padStart(10)} ${pct.padStart(7)} ` +
        `${String(max).padStart(6)} ${(sa / Math.max(1, n)).toFixed(1).padStart(7)} ${(sb / Math.max(1, n)).toFixed(1).padStart(7)}`
    );
  }
}

/* ---------------- single pixels ---------------- */

for (const spec of opt("px")) {
  const [x, y] = spec.split(",").map(Number);
  const ca = at(A, x, y);
  const line = [`(${x},${y})  A=${ca.join(",")}`];
  if (B) {
    const cb = at(B, x, y);
    const d = Math.max(...ca.map((v, i) => Math.abs(v - cb[i])));
    line.push(`B=${cb.join(",")}  delta=${d}`);
  }
  console.log(line.join("   "));
}

/* ---------------- vertical profile ---------------- */

// Finds the strongest luminance steps down a single column, which is how you
// locate a horizon line, a treeline top edge or a pavement seam by number
// rather than by squinting at the image.
for (const spec of opt("column")) {
  const x = Number(spec);
  console.log(`\ncolumn x=${x}: strongest luminance steps (top of image first)`);
  const steps = [];
  for (let y = 1; y < A.height; y++) {
    const d = lum(at(A, x, y)) - lum(at(A, x, y - 1));
    steps.push({ y, d });
  }
  steps.sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
  for (const s of steps.slice(0, 10)) {
    console.log(`  y=${String(s.y).padStart(4)}  step=${s.d.toFixed(1).padStart(7)}  rgb=${at(A, x, s.y).join(",")}`);
  }
}
