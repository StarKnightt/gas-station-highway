#!/usr/bin/env node
/**
 * How wide is the band in the dirt normal map, and did modulating it help?
 *
 * `tools/scalescan.mjs` answers this from a rendered frame, which is the
 * measurement that counts — but a capture is seven minutes and this is two
 * seconds, so this runs first and decides whether the capture is worth taking.
 * It measures the generated height field directly, before the Sobel, on the
 * CPU, with nothing rendered.
 *
 * Two quantities, and the second is the point:
 *
 *   1. THE AUTOCORRELATION of the height field against texel lag. The lag at
 *      which r falls under 0.2 is the characteristic feature size, and a field
 *      with structure at many scales has a long tail.
 *
 *   2. THE VARIANCE OF LOCAL AMPLITUDE across the map, measured as the spread
 *      of per-tile standard deviations. This is what "scale uniformity" is,
 *      numerically: a field whose local roughness is the same everywhere reads
 *      as a texture applied to a surface, and one whose roughness varies over
 *      long distances reads as the surface itself. Autocorrelation alone will
 *      barely move under amplitude modulation, which is exactly why the
 *      rendered-frame measurement of the previous fix looked like a null.
 *
 * The `friability: 0` arm is a real option on `makeDirt`, not a probe hack, so
 * the control and the shipped path are the same code (NOTES.md 43).
 *
 * Usage: node tools/dirtspectrum.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsresolve.mjs", pathToFileURL(`${import.meta.dirname}/`));

const { makeDirt } = await import("../src/gen/textures.ts");

/**
 * The SHIPPED size, not a faster one. An earlier run of this probe used 512 to
 * halve the cost and reported the height field as very nearly pure noise — true
 * of the map it generated and false of the map that ships, because halving the
 * resolution over a fixed 17 m tile doubles every feature's size in texels and
 * pushes three more octaves under the grid. The probe's own speed parameter was
 * the dominant term in its result. Anything sampling-limited has to be measured
 * at the resolution it runs at.
 */
const SIZE = 1024;
const TILE = 17;

/** Normalised autocorrelation of a square field at a pure horizontal lag. */
function acorr(f, size, lag) {
  let num = 0;
  let d0 = 0;
  let d1 = 0;
  let mean = 0;
  for (let i = 0; i < size * size; i++) mean += f[i];
  mean /= size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + lag < size; x++) {
      const a = f[y * size + x] - mean;
      const b = f[y * size + x + lag] - mean;
      num += a * b;
      d0 += a * a;
      d1 += b * b;
    }
  }
  const den = Math.sqrt(d0 * d1);
  return den === 0 ? 0 : num / den;
}

/**
 * Spread of local roughness. Slope rather than height, because slope is what a
 * normal map delivers and what shading responds to: a tile can have a large
 * height range and be perfectly smooth.
 */
function localSlopeSpread(f, size, tile) {
  const sds = [];
  for (let ty = 0; ty + tile <= size; ty += tile) {
    for (let tx = 0; tx + tile <= size; tx += tile) {
      let s = 0;
      let ss = 0;
      let n = 0;
      for (let y = ty; y < ty + tile; y++) {
        for (let x = tx; x < tx + tile - 1; x++) {
          const g = Math.abs(f[y * size + x + 1] - f[y * size + x]);
          s += g;
          ss += g * g;
          n++;
        }
      }
      sds.push(Math.sqrt(Math.max(0, ss / n - (s / n) ** 2)));
    }
  }
  const mean = sds.reduce((a, b) => a + b, 0) / sds.length;
  const sd = Math.sqrt(sds.reduce((a, b) => a + (b - mean) ** 2, 0) / sds.length);
  sds.sort((a, b) => a - b);
  return { mean, sd, cv: sd / mean, p05: sds[Math.floor(sds.length * 0.05)], p95: sds[Math.floor(sds.length * 0.95)] };
}

const metresPerTexel = TILE / SIZE;
const arms = [
  ["friability 0 (control)", makeDirt(SIZE, TILE, 404, { friability: 0 })],
  ["friability 1 (shipped)", makeDirt(SIZE, TILE, 404, { friability: 1 })],
];

console.log("");
console.log(`dirt height field, ${SIZE}px over ${TILE} m = ${(metresPerTexel * 1000).toFixed(1)} mm per texel`);
console.log("");
for (const [label, maps] of arms) {
  const h = maps.heightMap.image.data;
  // heightMap is a gray DataTexture; pull one channel back out as a float field.
  const stride = h.length / (SIZE * SIZE);
  const f = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) f[i] = h[i * stride] / 255;
  if (!f.every(Number.isFinite)) throw new Error(`${label}: non-finite height`);

  const lags = [1, 2, 4, 8, 16, 32, 64];
  let corrLen = 128;
  for (let l = 1; l <= 128; l++) {
    if (acorr(f, SIZE, l) < 0.2) {
      corrLen = l;
      break;
    }
  }
  // 48 texels is 1.6 m at this scale: the envelope wavelength being tested.
  const spread = localSlopeSpread(f, SIZE, 48);
  console.log(`${label}`);
  console.log(`  r at lag ${lags.join("/")} texels: ${lags.map((l) => acorr(f, SIZE, l).toFixed(3)).join("  ")}`);
  console.log(`  correlation length: ${corrLen} texels = ${(corrLen * metresPerTexel * 1000).toFixed(0)} mm`);
  console.log(
    `  local slope over 1.6 m tiles: mean ${spread.mean.toFixed(5)}  ` +
      `p05 ${spread.p05.toFixed(5)}  p95 ${spread.p95.toFixed(5)}  ` +
      `spread/mean ${spread.cv.toFixed(3)}`
  );
  console.log("");
  maps.map.dispose();
  maps.normalMap.dispose();
  maps.roughnessMap.dispose();
  maps.heightMap.dispose();
}
console.log("spread/mean is the number to watch: it is how much the local grain");
console.log("varies from place to place, which is what scale uniformity means.");
console.log("");
