#!/usr/bin/env node
/**
 * Crop and nearest-neighbour magnify a PNG, for looking at a handful of pixels.
 *
 *   node tools/pngcrop.mjs in.png out.png x y w h [scale]
 *
 * Nearest neighbour on purpose: this exists to look at individual pixels that a
 * bounding box has already located, and any smoothing averages the pixel in
 * question together with its neighbours - which is the whole failure mode this
 * project keeps re-learning.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [, , inFile, outFile, xs, ys, ws, hs, ss] = process.argv;
if (!inFile || !outFile) {
  console.error("usage: node tools/pngcrop.mjs in.png out.png x y w h [scale]");
  process.exit(2);
}
const x0 = Number(xs) | 0;
const y0 = Number(ys) | 0;
const w = Number(ws) | 0;
const h = Number(hs) | 0;
const scale = Math.max(1, Number(ss ?? 4) | 0);

const src = PNG.sync.read(fs.readFileSync(inFile));
const out = new PNG({ width: w * scale, height: h * scale });
for (let y = 0; y < h * scale; y++) {
  for (let x = 0; x < w * scale; x++) {
    const sx = Math.min(src.width - 1, Math.max(0, x0 + ((x / scale) | 0)));
    const sy = Math.min(src.height - 1, Math.max(0, y0 + ((y / scale) | 0)));
    const si = (sy * src.width + sx) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = src.data[si];
    out.data[di + 1] = src.data[si + 1];
    out.data[di + 2] = src.data[si + 2];
    out.data[di + 3] = 255;
  }
}
fs.writeFileSync(outFile, PNG.sync.write(out));
console.log(`${inFile} [${x0},${y0} ${w}x${h}] x${scale} -> ${outFile}`);
