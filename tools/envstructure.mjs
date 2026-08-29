// Quantify how much structure the environment actually contains.
//
// The question this answers: can a car in this scene reflect anything at all?
// A horizon band only exists on a flank if the lower hemisphere differs from
// the upper one AND carries some detail. If the ground half of the environment
// is one constant colour, no material setting can produce a horizon band.
import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");

async function load(p) {
  return PNG.sync.read(await fs.readFile(path.join(ROOT, p)));
}

/** mean / population std / range of luminance over a pixel box. */
function stats(png, x0, y0, x1, y1) {
  const l = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      l.push(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]);
    }
  }
  const mean = l.reduce((a, b) => a + b, 0) / l.length;
  const sd = Math.sqrt(l.reduce((a, b) => a + (b - mean) ** 2, 0) / l.length);
  return { mean, sd, range: Math.max(...l) - Math.min(...l) };
}

const f = (n, w = 6) => n.toFixed(1).padStart(w);

const pmrem = await load("shots/car/env/pmrem.png");
// Largest mip, bottom of the CubeUV atlas. Each face is 256 square; the +X face
// sits bottom-left and straddles the horizon, the -Y (down) face is the ground.
console.log(`\nPMREM atlas ${pmrem.width}x${pmrem.height}, sharpest mip`);
const sky = stats(pmrem, 8, 776, 248, 888);
const grd = stats(pmrem, 8, 904, 248, 1016);
console.log(`  upper hemisphere (sky)     mean ${f(sky.mean)}   sd ${f(sky.sd)}   range ${f(sky.range)}`);
console.log(`  lower hemisphere (ground)  mean ${f(grd.mean)}   sd ${f(grd.sd)}   range ${f(grd.range)}`);
console.log(`  horizon step               ${f(Math.abs(sky.mean - grd.mean))}`);

// A perfect chrome car, and the real scene rendered behind it in the same frame.
const m = await load("shots/car/env/mirror_r0.png");
const W = m.width;
const H = m.height;
console.log(`\nPerfect chrome (roughness 0), three-quarter front ${W}x${H}`);
const door = stats(m, (W * 0.56) | 0, (H * 0.42) | 0, (W * 0.7) | 0, (H * 0.58) | 0);
const bonnet = stats(m, (W * 0.26) | 0, (H * 0.42) | 0, (W * 0.4) | 0, (H * 0.5) | 0);
console.log(`  reflected in the door      mean ${f(door.mean)}   sd ${f(door.sd)}   range ${f(door.range)}`);
console.log(`  reflected in the bonnet    mean ${f(bonnet.mean)}   sd ${f(bonnet.sd)}   range ${f(bonnet.range)}`);
const bg = stats(m, (W * 0.78) | 0, (H * 0.22) | 0, (W * 0.98) | 0, (H * 0.46) | 0);
console.log(`  real scene, same frame     mean ${f(bg.mean)}   sd ${f(bg.sd)}   range ${f(bg.range)}`);
console.log(
  `\n  the scene the car stands in carries ${(bg.sd / Math.max(door.sd, 0.01)).toFixed(1)}x the detail of the scene it reflects`
);
