#!/usr/bin/env node
/**
 * Vertical scanline dump through a capture, in the critic's coordinate space.
 *
 * Exists because I verified a tonal artefact by cropping the region I expected
 * it in, after changing the geometry I believed caused it, and reported it gone.
 * An independent reviewer looking at the whole frame with no expectation found it
 * immediately, in three presets. A crop of one frame chosen by the person who
 * made the change is not a control.
 *
 * Critic coordinates are quoted against a 1024-wide view; captures are 1600 wide.
 * This takes 1024-space coordinates and does the scaling, so numbers can be
 * pasted straight from a review without arithmetic in between — the arithmetic is
 * where I would otherwise look at the wrong rows and conclude the wrong thing.
 *
 *   node tools/vegstrip.mjs <png> --x=0,580 --y=140,320
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const pick = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3).split(",").map(Number) : d;
};
const png = PNG.sync.read(fs.readFileSync(file));
const S = png.width / 1024;
const [x0, x1] = pick("x", [0, 1024]);
const [y0, y1] = pick("y", [0, 576]);

const at = (x, y) => {
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const nx0 = Math.max(0, Math.round(x0 * S));
const nx1 = Math.min(png.width, Math.round(x1 * S));
console.log(`${file}  ${png.width}x${png.height}  scale ${S.toFixed(4)}x from 1024-space`);
console.log(`columns ${x0}-${x1} (native ${nx0}-${nx1})`);
console.log(" y1024  yNative   mean rgb           luma   b/r    across-row spread (max-min luma)");

for (let y = y0; y <= y1; y++) {
  const ny = Math.round(y * S);
  if (ny < 0 || ny >= png.height) continue;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  let lo = Infinity,
    hi = -Infinity;
  for (let x = nx0; x < nx1; x++) {
    const c = at(x, ny);
    r += c[0];
    g += c[1];
    b += c[2];
    n++;
    const l = luma(c);
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  const c = [r / n, g / n, b / n];
  const l = luma(c);
  // A strip of "uniform value across all 1024 px" is the specific complaint, so
  // the across-row spread is the number that confirms or refutes it directly.
  const flat = hi - lo < 12 ? "  FLAT" : "";
  console.log(
    `  ${String(y).padStart(4)}   ${String(ny).padStart(5)}   ` +
      `rgb(${c.map((v) => v.toFixed(0).padStart(3)).join(",")})  ${l.toFixed(1).padStart(5)}  ` +
      `${(c[2] / Math.max(c[0], 1)).toFixed(3)}  ${(hi - lo).toFixed(1).padStart(6)}${flat}`
  );
}
