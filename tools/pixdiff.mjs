// Compares two PNGs channel by channel and prints how many differ and by how
// much. Written for one question: "did this optimisation change the image?" —
// where the honest answer needs a number, not a glance at two screenshots.
//
// Reports the *distribution* of the difference, not just a pass/fail count,
// because a handful of channels off by 1/255 is dither noise while the same
// count off by 40 is a real change hiding in a small area.
//
//   node tools/pixdiff.mjs a.png b.png [out-diff.png]
import fs from "node:fs";
import { PNG } from "pngjs";

const [, , aPath, bPath, outPath] = process.argv;
if (!aPath || !bPath) {
  console.error("usage: node tools/pixdiff.mjs a.png b.png [out-diff.png]");
  process.exit(2);
}

const a = PNG.sync.read(fs.readFileSync(aPath));
const b = PNG.sync.read(fs.readFileSync(bPath));
if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(2);
}

const diff = outPath ? new PNG({ width: a.width, height: a.height }) : null;
let channels = 0;
let pixels = 0;
let max = 0;
let sum = 0;
const hist = new Map();

for (let i = 0; i < a.data.length; i += 4) {
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(a.data[i + c] - b.data[i + c]);
    if (d > 0) {
      channels++;
      sum += d;
      hist.set(d, (hist.get(d) || 0) + 1);
      if (d > worst) worst = d;
    }
  }
  if (worst > 0) pixels++;
  if (worst > max) max = worst;
  if (diff) {
    diff.data[i] = worst > 0 ? 255 : 0;
    diff.data[i + 1] = worst > 0 ? Math.max(0, 255 - worst * 8) : 0;
    diff.data[i + 2] = 0;
    diff.data[i + 3] = 255;
  }
}

const totalChannels = (a.data.length / 4) * 3;
console.log(`${aPath}\n${bPath}`);
console.log(
  `  differing channels: ${channels} / ${totalChannels} (${((100 * channels) / totalChannels).toFixed(4)}%)  ` +
    `pixels: ${pixels} / ${a.width * a.height}`
);
console.log(`  max delta: ${max}/255   mean delta over differing channels: ${channels ? (sum / channels).toFixed(2) : "0"}`);
if (hist.size) {
  const top = [...hist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
  console.log(`  by magnitude: ${top.map(([d, n]) => `${d}:${n}`).join("  ")}`);
}
if (diff) {
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  console.log(`  -> ${outPath}`);
}
