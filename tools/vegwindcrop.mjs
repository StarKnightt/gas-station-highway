#!/usr/bin/env node
/**
 * Crops for eyeballing, because "is the mid distance better" is not a question
 * a pixel count can answer.
 *
 * Writes 2x-magnified crops of one region from several arms so they can be put
 * side by side. Nearest-neighbour on purpose: a smooth upscale would put back
 * the soft edges the whole argument is about.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "capture-vegwind-0829");

const [, , x0s, y0s, ws, hs, ...ids] = process.argv;
const X = Number(x0s);
const Y = Number(y0s);
const W = Number(ws);
const H = Number(hs);
const Z = 2;

if (![X, Y, W, H].every(Number.isFinite) || !ids.length) {
  console.error("usage: node tools/vegwindcrop.mjs X Y W H arm [arm...]");
  process.exit(2);
}

for (const id of ids) {
  const src = PNG.sync.read(fs.readFileSync(path.join(DIR, `${id}.png`)));
  const out = new PNG({ width: W * Z, height: H * Z });
  for (let y = 0; y < H * Z; y++) {
    for (let x = 0; x < W * Z; x++) {
      const sx = X + Math.floor(x / Z);
      const sy = Y + Math.floor(y / Z);
      const s = (sy * src.width + sx) * 4;
      const d = (y * out.width + x) * 4;
      out.data[d] = src.data[s];
      out.data[d + 1] = src.data[s + 1];
      out.data[d + 2] = src.data[s + 2];
      out.data[d + 3] = 255;
    }
  }
  const file = path.join(DIR, `crop-${id}-${X}_${Y}.png`);
  fs.writeFileSync(file, PNG.sync.write(out));
  console.log(file);
}
