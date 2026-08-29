#!/usr/bin/env node
/**
 * Per-row plant coverage against ground distance, read off a shipped capture.
 *
 * Answers one specific and checkable claim — "past about 30 m the tufts stop
 * dead" — which no triangle count or instance count in my own report can either
 * confirm or refute, because both of those measure what was built rather than
 * what subtends pixels.
 *
 * Plants are darker than sunlit dirt, so coverage per row is the fraction of
 * pixels below the row's own median by a margin. Using the row's median rather
 * than a fixed threshold keeps it honest as the ground darkens toward the
 * horizon.
 *
 * Rows map to ground distance by flat-plane projection: a row `dy` pixels below
 * the horizon row sees ground at d = eye / tan(dy * radiansPerPixel).
 *
 *   node tools/vegdensity.mjs <png> --eye=1.67 --horizon=452 --fov=38
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const num = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.slice(n.length + 3)) : d;
};
const png = PNG.sync.read(fs.readFileSync(file));
const eye = num("eye", 1.67);
const horizonRow = num("horizon", 452);
const fovDeg = num("fov", 38);
const radPerPx = (fovDeg * Math.PI) / 180 / png.height;

const luma = (i) => 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];

console.log(`${file}  ${png.width}x${png.height}  eye ${eye} m  horizon row ${horizonRow}  fov ${fovDeg}`);
console.log("  row   ground dist    dark%   median luma");
for (let y = horizonRow + 2; y < png.height; y += 6) {
  const row = [];
  for (let x = 0; x < png.width; x++) row.push(luma((png.width * y + x) << 2));
  const sorted = [...row].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  // 14 is above the dirt texture's own row-local variation and below the
  // contrast of a dry tuft, checked against rows known to contain foreground
  // plants versus rows known to be open apron.
  const dark = row.filter((v) => v < med - 14).length / row.length;
  const dy = y - horizonRow;
  const dist = eye / Math.tan(dy * radPerPx);
  const bar = "#".repeat(Math.round(dark * 120));
  console.log(
    `  ${String(y).padStart(4)}   ${dist.toFixed(0).padStart(7)} m   ${(dark * 100).toFixed(1).padStart(5)}%   ` +
      `${med.toFixed(0).padStart(4)}  ${bar}`
  );
}
