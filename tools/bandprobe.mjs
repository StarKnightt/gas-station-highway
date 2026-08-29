#!/usr/bin/env node
/**
 * Is a detail map band-limited, or is it white noise wearing a physical name?
 *
 * `fbm(size, freq)` takes a frequency in *cycles across the texture*, and it
 * will happily accept more cycles than there are texels. Past Nyquist
 * `gradientNoise` returns a lattice finer than one cell per texel, i.e. white
 * noise, and `hsNormal` differentiates that into a per-texel stipple. The
 * cabinet skin shipped like that for several rounds and read as sprayed
 * concrete; nothing in the source said "concrete", and the frequency expression
 * `tileMetres * 640` looked like a physical scale.
 *
 * The statistic is the mean absolute difference between horizontally adjacent
 * texels, divided by the field's own standard deviation. It measures how much
 * of the field's energy sits at the very top of the spectrum:
 *
 *   ~1.10-1.15  uncorrelated noise. Every texel independent. Aliased.
 *   ~0.30-0.60  detail resolved at a few texels per cycle. Usable.
 *   <0.15       very smooth relative to texel size, probably wasting resolution.
 *
 * Reported per channel of the normal map, because the aliasing shows up hardest
 * there — a height field can look tolerable and still differentiate into hash.
 */

import * as THREE from "three";
import { makeCabinetSteel, makePaintedSteel, makeMouldedPlastic } from "../src/gen/hardsurface.ts";

/** Mean |adjacent delta| / standard deviation, per channel. */
function roughnessOfField(data, size, stride, offset) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sum += data[(y * size + x) * stride + offset];
      n++;
    }
  }
  const mean = sum / n;
  let varSum = 0;
  let adj = 0;
  let adjN = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = data[(y * size + x) * stride + offset];
      varSum += (v - mean) * (v - mean);
      if (x + 1 < size) {
        adj += Math.abs(data[(y * size + x + 1) * stride + offset] - v);
        adjN++;
      }
    }
  }
  const sd = Math.sqrt(varSum / n);
  return { sd, ratio: sd > 1e-6 ? adj / adjN / sd : 0 };
}

function report(name, maps) {
  for (const key of ["normalMap", "roughnessMap"]) {
    const tex = maps[key];
    if (!tex?.image?.data) continue;
    const size = tex.image.width;
    const stride = tex.image.data.length / (size * size);
    const chans = key === "normalMap" ? [0, 1] : [0];
    for (const c of chans) {
      const { sd, ratio } = roughnessOfField(tex.image.data, size, stride, c);
      const verdict =
        ratio > 0.95 ? "ALIASED (white noise)" : ratio > 0.7 ? "near Nyquist" : ratio > 0.12 ? "resolved" : "very smooth";
      console.log(
        `  ${name} ${key}[${c}]  sd ${sd.toFixed(1).padStart(6)}  adj/sd ${ratio.toFixed(3)}   ${verdict}`
      );
    }
  }
}

console.log("Top-of-spectrum energy in the pump detail maps.");
console.log("adj/sd near 1.1 means every texel is independent, i.e. the noise was");
console.log("requested above Nyquist and is not the feature its name claims.\n");
report("cabinet ", makeCabinetSteel(512, 0.20, 4243));
report("painted ", makePaintedSteel(512, 0.20, 8677));
report("plastic ", makeMouldedPlastic(512, 0.10, 5151));
console.log("\nControl: the same generator asked for the old out-of-band frequency.");
try {
  report("cabinet@0.9 ", makeCabinetSteel(512, 0.9, 4243));
} catch (e) {
  console.log(`  refused, which is the point: ${e.message}`);
}
