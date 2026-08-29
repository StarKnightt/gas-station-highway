// Crop and nearest-neighbour magnify a region, so an edge defect can be looked
// at at the scale it actually exists rather than inferred from a full frame.
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const [file, box, outName, zoomArg] = process.argv.slice(2);
if (!file || !box) {
  console.error("usage: node tools/crop.mjs <png> x,y,w,h [out.png] [zoom]");
  process.exit(2);
}
const [x0, y0, w, h] = box.split(",").map(Number);
const zoom = Number(zoomArg ?? 3);
const src = PNG.sync.read(await fs.readFile(path.resolve(file)));
const out = new PNG({ width: w * zoom, height: h * zoom });
for (let y = 0; y < h * zoom; y++) {
  for (let x = 0; x < w * zoom; x++) {
    const sx = Math.min(src.width - 1, x0 + Math.floor(x / zoom));
    const sy = Math.min(src.height - 1, y0 + Math.floor(y / zoom));
    const s = (sy * src.width + sx) * 4;
    const d = (y * out.width + x) * 4;
    for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
  }
}
const dest = path.resolve(outName ?? "shots/car/env/crop.png");
await fs.mkdir(path.dirname(dest), { recursive: true });
await fs.writeFile(dest, PNG.sync.write(out));
console.log(`${dest}  ${w}x${h} at ${zoom}x`);
