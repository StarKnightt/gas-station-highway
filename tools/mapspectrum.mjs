#!/usr/bin/env node
/**
 * Periodicity and band width of a generated surface map, measured in the buffer
 * rather than in a frame.
 *
 * Finding an artefact in the source is much stronger evidence than finding it in
 * a render, because a render adds perspective, mip selection, anisotropic
 * filtering, the anti-tile blend and the shading model on top — any of which can
 * create or hide a pattern. If a periodic peak is present in the buffer, nothing
 * downstream invented it.
 *
 * The high-pass is not optional here. These maps are dominated by their
 * long-wavelength content, so a faint fine lattice riding on it contributes
 * almost nothing to the raw autocorrelation, and the honest-looking answer is
 * "no peak" no matter what the fine structure does. That is how the same
 * question got answered wrongly from a rendered crop earlier tonight.
 *
 * Usage: node tools/mapspectrum.mjs [dirt|asphalt|all]
 */
import { fileURLToPath } from "node:url";

/** Separable box high-pass: removes everything coarser than `w` texels. */
export function highpass(f, size, w) {
  const tmp = new Float64Array(size * size);
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      let n = 0;
      for (let k = -w; k <= w; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= size) continue;
        s += f[y * size + xx];
        n++;
      }
      tmp[y * size + x] = s / n;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      let s = 0;
      let n = 0;
      for (let k = -w; k <= w; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= size) continue;
        s += tmp[yy * size + x];
        n++;
      }
      out[y * size + x] = f[y * size + x] - s / n;
    }
  }
  return out;
}

/**
 * Autocorrelation at a horizontal lag, on a strided subsample. These maps are
 * 2048 square and correlating every texel at every lag is minutes; every fourth
 * row is the same answer to three decimals and is seconds.
 */
export function acorr(f, size, lag, rowStep = 4) {
  let num = 0;
  let d0 = 0;
  let d1 = 0;
  for (let y = 0; y < size; y += rowStep) {
    for (let x = 0; x + lag < size; x++) {
      const a = f[y * size + x];
      const b = f[y * size + x + lag];
      num += a * b;
      d0 += a * a;
      d1 += b * b;
    }
  }
  const den = Math.sqrt(d0 * d1);
  return den === 0 ? 0 : num / den;
}

export function report(label, heightField, size, tileMetres, hp) {
  const mmPerTexel = (tileMetres * 1000) / size;
  const f = highpass(heightField, size, hp);
  const r = [];
  for (let lag = 1; lag <= 96; lag++) r.push(acorr(f, size, lag));
  if (!r.every(Number.isFinite)) throw new Error(`${label}: non-finite correlation`);

  const peaks = [];
  for (let i = 2; i < r.length - 2; i++) {
    if (r[i] > r[i - 1] + 0.004 && r[i] > r[i + 1] + 0.004 && r[i] > 0.03) peaks.push([i + 1, r[i]]);
  }
  let corrLen = 96;
  for (let i = 0; i < r.length; i++) {
    if (r[i] < 0.2) {
      corrLen = i + 1;
      break;
    }
  }

  console.log(`${label}: ${size}px over ${tileMetres} m = ${mmPerTexel.toFixed(2)} mm/texel, high-pass ${hp} px`);
  console.log(`  r at lag 1/2/4/8/16/32/64: ${[1, 2, 4, 8, 16, 32, 64].map((l) => r[l - 1].toFixed(3)).join("  ")}`);
  console.log(`  correlation length ${corrLen} texels = ${(corrLen * mmPerTexel).toFixed(1)} mm`);
  if (!peaks.length) {
    console.log("  no periodic peak -> band width, not periodicity, is the question");
  } else {
    console.log(
      `  PERIODIC: ${peaks
        .slice(0, 4)
        .map(([l, v]) => `${l} texels (${(l * mmPerTexel).toFixed(0)} mm) r=${v.toFixed(3)}`)
        .join(", ")}`
    );
  }
  console.log("");
}

export function grab(maps, size) {
  const d = maps.heightMap.image.data;
  const stride = d.length / (size * size);
  const f = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) f[i] = d[i * stride] / 255;
  if (!f.every(Number.isFinite)) throw new Error("non-finite height buffer");
  return f;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { register } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  register("./tsresolve.mjs", pathToFileURL(`${import.meta.dirname}/`));
  const { makeDirt, makeAsphalt } = await import("../src/gen/textures.ts");
  const which = process.argv[2] || "all";

    if (which === "asphalt" || which === "all") {
    const size = 2048;
    const tile = 8;
    try {
      const m = makeAsphalt(size, tile, 1337);
      report("asphalt height", grab(m, size), size, tile, 24);
      for (const k of ["map", "normalMap", "roughnessMap", "heightMap"]) m[k]?.dispose?.();
    } catch (e) {
      // `makeAsphalt` draws its cracks through a DOM canvas, so unlike `makeDirt`
      // it cannot be generated headless. Reported rather than swallowed: the
      // asphalt arm is the one with a measured lattice in the render, and knowing
      // that the buffer CANNOT be checked here is part of the result. Measuring it
      // needs the browser, or the crack pass lifting out behind a flag.
      console.log(`asphalt height: NOT MEASURABLE headless — ${String(e).split(/\r?\n/)[0]}`);
      console.log("  makeAsphalt needs a DOM canvas for its crack pass. Measure in-page or");
      console.log("  factor the canvas step behind a flag before trusting a null from here.");
      console.log("");
    }
  }
    if (which === "dirt" || which === "all") {
    const size = 1024;
    const tile = 17;
    const m = makeDirt(size, tile, 404);
    report("dirt height", grab(m, size), size, tile, 24);
    for (const k of ["map", "normalMap", "roughnessMap", "heightMap"]) m[k]?.dispose?.();
  }
}
