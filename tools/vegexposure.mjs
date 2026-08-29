#!/usr/bin/env node
/**
 * Whole-frame mean luma, for comparing two rounds without choosing a region.
 *
 * Written because the ground went near-black between two of my own rounds and I
 * need to know whether that is my change or somebody else's before I spend a
 * round chasing it. A global drop with an unchanged sky is a lighting change; a
 * local drop is mine.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

for (const file of process.argv.slice(2)) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let all = 0;
  let sky = 0,
    skyN = 0;
  let low = 0,
    lowN = 0;
  let dark = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      all += l;
      if (l < 24) dark++;
      // Top eighth is sky in every preset; bottom third is ground in every preset.
      if (y < png.height / 8) {
        sky += l;
        skyN++;
      } else if (y > (png.height * 2) / 3) {
        low += l;
        lowN++;
      }
    }
  }
  const n = png.width * png.height;
  console.log(
    `${file.split(/[\\/]/).pop().padEnd(14)} frame ${(all / n).toFixed(1).padStart(6)}   ` +
      `sky ${(sky / skyN).toFixed(1).padStart(6)}   lower-third ${(low / lowN).toFixed(1).padStart(6)}   ` +
      `near-black ${((dark / n) * 100).toFixed(1).padStart(5)}%`
  );
}
