#!/usr/bin/env node
/**
 * Crop and nearest-neighbour magnify a region of a capture, so a card of pine
 * foliage two hundred pixels across can actually be inspected for whether the
 * needles resolved or the alpha cut merged them into a blob.
 *
 *   node tools/vegcrop.mjs shots/system6/horizon.png 240 40 320 240 3 out.png
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [, , src, xs, ys, ws, hs, zs, dst] = process.argv;
if (!src || !dst) {
  console.error("usage: vegcrop.mjs <src> <x> <y> <w> <h> <zoom> <dst>");
  process.exit(2);
}
const x0 = +xs;
const y0 = +ys;
const w = +ws;
const h = +hs;
const z = Math.max(1, +zs | 0);

const img = PNG.sync.read(fs.readFileSync(src));
const out = new PNG({ width: w * z, height: h * z });
for (let y = 0; y < h * z; y++) {
  for (let x = 0; x < w * z; x++) {
    const sx = Math.min(img.width - 1, x0 + ((x / z) | 0));
    const sy = Math.min(img.height - 1, y0 + ((y / z) | 0));
    const si = (sy * img.width + sx) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = img.data[si];
    out.data[di + 1] = img.data[si + 1];
    out.data[di + 2] = img.data[si + 2];
    out.data[di + 3] = 255;
  }
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log(`${dst}  ${w}x${h} @${z}x  from ${src}`);
