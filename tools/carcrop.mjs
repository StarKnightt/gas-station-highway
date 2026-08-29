/**
 * Crops and upscales a region of a capture, so a detail can be inspected
 * without spending three minutes on another headless run.
 *
 *   node tools/carcrop.mjs shots/car/side.png 300 200 420 260 out.png [scale]
 *
 * Coordinates are left, top, width, height in source pixels. Nearest-neighbour
 * upscale on purpose: it keeps a 5 mm shut line a hard edge instead of
 * smearing it into the exact soft gradient this rebuild is trying to disprove.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [, , src, sx, sy, sw, sh, dst, scaleArg] = process.argv;
if (!src || !dst) {
  console.error("usage: carcrop.mjs <src> <x> <y> <w> <h> <dst> [scale]");
  process.exit(2);
}
const x = +sx;
const y = +sy;
const w = +sw;
const h = +sh;
const scale = Math.max(1, Math.round(+(scaleArg ?? 2)));

const png = PNG.sync.read(fs.readFileSync(src));
if (x < 0 || y < 0 || x + w > png.width || y + h > png.height) {
  console.error(`region ${x},${y} ${w}x${h} is outside ${png.width}x${png.height}`);
  process.exit(2);
}

const out = new PNG({ width: w * scale, height: h * scale });
for (let j = 0; j < h * scale; j++) {
  for (let i = 0; i < w * scale; i++) {
    const s = ((y + Math.floor(j / scale)) * png.width + (x + Math.floor(i / scale))) * 4;
    const d = (j * out.width + i) * 4;
    out.data[d] = png.data[s];
    out.data[d + 1] = png.data[s + 1];
    out.data[d + 2] = png.data[s + 2];
    out.data[d + 3] = 255;
  }
}
fs.writeFileSync(dst, PNG.sync.write(out));
console.log(`[carcrop] ${src} ${x},${y} ${w}x${h} x${scale} -> ${dst} (${out.width}x${out.height})`);
