#!/usr/bin/env node
/**
 * Does a rendered surface look like a pattern because it REPEATS, or because
 * everything on it is the same SIZE?
 *
 * Those two faults produce the same complaint and need opposite fixes — a
 * repeat is cured by decorrelating, uniform scale by widening the spectrum —
 * and guessing between them costs a round each time (NOTES.md case 41). This
 * tells them apart from a captured frame in about two seconds.
 *
 * The measurement is a 2-D autocorrelation of a screen-space crop:
 *
 *   - A REPEAT shows a secondary peak at the lag of its period. The stipple
 *     that prompted this had none anywhere in a 2..90 px sweep, which is what
 *     stopped a fourth pointless de-latticing pass.
 *   - A RANDOM FIELD decays monotonically to zero, and the lag at which it
 *     reaches r = 0.2 is its correlation length: the characteristic size of
 *     its features in pixels. One number, and if it is the same at every
 *     distance in the frame the field is narrow-band.
 *
 * What it cannot do. Screen lag is not world wavelength: the ground recedes and
 * the mapping is projective, so a real repeat smears vertically and only
 * horizontal lag within a scanline band means anything. Reporting a world
 * wavelength here would be an invention. The question it answers is the one
 * that decides the fix, which is whether a peak exists at all.
 *
 * `tools/tilescan.mjs` is the other half of this and does not overlap: it
 * correlates whole frames from its own asphalt pose to find texture tiling
 * periods, and explicitly takes no region. This takes a region, because the
 * subject is a patch of dirt in the corner of one shot.
 *
 * Usage:
 *   node tools/scalescan.mjs frame.png [more.png ...]
 *   node tools/scalescan.mjs --crop=0.52,0.66,1,1 frame.png     # x0,y0,x1,y1 fractions
 *   node tools/scalescan.mjs --highpass=24 frame.png            # isolate detail finer than 24 px
 *
 * `--highpass` exists because the first version of this tool could not see the
 * thing it was pointed at. A faint fine pattern riding on strong smooth shading
 * — which is every ground plane with a shadow on it — contributes almost nothing
 * to the raw autocorrelation, so the result describes the shading and reports
 * "no peak" regardless of what the fine structure is doing. Subtracting a
 * running box mean removes everything coarser than the window and leaves the
 * detail alone. A per-row linear fit, which is all the tool did before, only
 * removes a straight ramp and cannot touch a curved gradient.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const cropArg = (args.find((a) => a.startsWith("--crop=")) || "").split("=")[1];
const HP = Number((args.find((a) => a.startsWith("--highpass=")) || "").split("=")[1] || 0);
const CROP = cropArg ? cropArg.split(",").map(Number) : [0.52, 0.66, 1, 1];
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) throw new Error("usage: node tools/scalescan.mjs [--crop=x0,y0,x1,y1] frame.png ...");

function scan(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: W, height: H } = png;
  // Case 39: every content check is a mean, and the mean of no pixels is NaN,
  // which satisfies every comparison. Dimensions get checked before statistics.
  if (!W || !H) throw new Error(`${file}: zero-dimension PNG`);

  const x0 = Math.floor(W * CROP[0]);
  const y0 = Math.floor(H * CROP[1]);
  const cw = Math.floor(W * CROP[2]) - x0;
  const ch = Math.floor(H * CROP[3]) - y0;
  if (cw < 64 || ch < 32) throw new Error(`${file}: crop ${cw}x${ch} too small to correlate`);

  const lum = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((y + y0) * W + (x + x0)) * 4;
      lum[y * cw + x] = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    }
  }
  // Subtract a per-row linear fit. Without this the recession gradient — ground
  // getting darker with distance — dominates the correlation at every lag and
  // buries the signal being looked for.
  for (let y = 0; y < ch; y++) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let x = 0; x < cw; x++) {
      const v = lum[y * cw + x];
      sx += x;
      sy += v;
      sxx += x * x;
      sxy += x * v;
    }
    const den = cw * sxx - sx * sx;
    const b = den === 0 ? 0 : (cw * sxy - sx * sy) / den;
    const a = sy / cw - (b * sx) / cw;
    for (let x = 0; x < cw; x++) lum[y * cw + x] -= a + b * x;
  }

  // High-pass by subtracting a separable box mean. Everything coarser than the
  // window goes, including curved gradients the linear fit above cannot reach.
  if (HP > 1) {
    const w = Math.round(HP);
    const tmp = new Float64Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let s2 = 0;
        let n = 0;
        for (let k = -w; k <= w; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= cw) continue;
          s2 += lum[y * cw + xx];
          n++;
        }
        tmp[y * cw + x] = s2 / n;
      }
    }
    for (let x = 0; x < cw; x++) {
      for (let y = 0; y < ch; y++) {
        let s2 = 0;
        let n = 0;
        for (let k = -w; k <= w; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= ch) continue;
          s2 += tmp[yy * cw + x];
          n++;
        }
        lum[y * cw + x] -= s2 / n;
      }
    }
  }

  const acorr = (lag) => {
    let num = 0;
    let d0 = 0;
    let d1 = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x + lag < cw; x++) {
        const a = lum[y * cw + x];
        const b = lum[y * cw + x + lag];
        num += a * b;
        d0 += a * a;
        d1 += b * b;
      }
    }
    const den = Math.sqrt(d0 * d1);
    return den === 0 ? 0 : num / den;
  };

  const r = [];
  for (let lag = 1; lag <= 90; lag++) r.push(acorr(lag));
  if (!r.every(Number.isFinite)) throw new Error(`${file}: non-finite correlation`);

  // Correlation length: first lag under r = 0.2. The characteristic feature
  // size. A field with structure at many scales has a long tail and a large
  // value here; a narrow-band one drops off a cliff.
  let corrLen = 90;
  for (let i = 0; i < r.length; i++) {
    if (r[i] < 0.2) {
      corrLen = i + 1;
      break;
    }
  }
  // A peak has to clear both neighbours by a real margin, or lag 1 wins every
  // time because adjacent pixels always correlate.
  const peaks = [];
  for (let i = 2; i < r.length - 2; i++) {
    if (r[i] > r[i - 1] + 0.01 && r[i] > r[i + 1] + 0.01 && r[i] > 0.06) peaks.push([i + 1, r[i]]);
  }

  /**
   * Is the image I was handed a resample?
   *
   * This is checked before any periodicity is reported, because an upscaled crop
   * has a periodic structure at the upscale ratio that belongs to the image file
   * and not to the scene, and it is indistinguishable from a material defect
   * once it is in a PNG. That mistake cost two agents a round: a magnified
   * evidence crop showed a regular hatch, the hatch was identical with shadows
   * on and off, and the correct conclusion "not shadowing" was followed by the
   * wrong one "therefore the material".
   *
   * Nearest-neighbour upscaling replicates each source pixel into a run of
   * identical values, so the mean horizontal run length is the upscale factor. A
   * rendered frame with any texture detail in it sits near 1. Bilinear does not
   * replicate, but a bilinear upscale of factor N still leaves every Nth column
   * exactly on a source sample, which the peak finder below sees as a period of
   * N with harmonics at 2N, 3N and 4N — the signature to distrust.
   */
  let runTotal = 0;
  let runCount = 0;
  for (let y = 0; y < ch; y += 3) {
    let run = 1;
    for (let x = 1; x < cw; x++) {
      const a = ((y + y0) * png.width + (x + x0)) * 4;
      const b = ((y + y0) * png.width + (x + x0 - 1)) * 4;
      const same =
        png.data[a] === png.data[b] && png.data[a + 1] === png.data[b + 1] && png.data[a + 2] === png.data[b + 2];
      if (same) run++;
      else {
        runTotal += run;
        runCount++;
        run = 1;
      }
    }
  }
  const meanRun = runCount ? runTotal / runCount : 0;

  console.log(`${file}`);
  console.log(`  crop ${cw}x${ch} at (${x0},${y0})${HP > 1 ? `, high-passed at ${Math.round(HP)} px` : ""}`);
  console.log(
    `  mean run of identical pixels: ${meanRun.toFixed(2)} px` +
      (meanRun > 1.6
        ? `  <-- LIKELY A RESAMPLE. Any period near ${Math.round(meanRun)} px below belongs to the image file, not the scene.`
        : "")
  );
  console.log(`  r at lag 2/5/10/20/40/80: ${[2, 5, 10, 20, 40, 80].map((l) => r[l - 1].toFixed(3)).join("  ")}`);
  console.log(`  correlation length (first lag under r=0.2): ${corrLen} px`);
  if (!peaks.length) {
    console.log("  no secondary peak -> RANDOM FIELD. If it still reads as a pattern the");
    console.log("     band is too narrow; widen the spectrum, do not decorrelate further.");
  } else {
    console.log(`  secondary peaks -> REPEAT at lag(s): ${peaks.map(([l, v]) => `${l}px r=${v.toFixed(3)}`).join(", ")}`);
  }
}

for (const f of files) {
  scan(f);
  console.log("");
}
