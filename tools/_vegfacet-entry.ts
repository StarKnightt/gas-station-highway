/**
 * CPU-only entry exposing the distant-band height envelope so the facet-slope
 * term can be measured as a *term*, rather than inferred from pixels.
 *
 * Written because the first facet-scale slope fix reduced measured band
 * structure at every scale, and there were two candidate reasons — the term's
 * output range had collapsed, or the term was fine and the metric was measuring
 * high-frequency noise it had deliberately removed. Those are distinguishable in
 * one number, the distribution of `slopeLight`, and that number lives on the CPU
 * side of the build. Reading it needs no capture and no GPU.
 */
import { envelope, recommendedSamples, type BandSpec } from "../src/gen/vegDistant";
import { HORIZON_BANDS } from "../src/gen/vegHorizonBands";

export interface FacetStats {
  radius: number;
  samples: number;
  metresPerSample: number;
  /** Differencing half-window in samples, and the physical baseline it spans. */
  half: number;
  baselineM: number;
  /** Percentiles of `slopeLight`, the 0..1 lit-fraction the tone term consumes. */
  p: Record<string, number>;
  /** Standard deviation of slopeLight — the term's actual authority. */
  sd: number;
  /** Fraction of samples pinned at either clamp; high means saturation. */
  pinned: number;
}

/**
 * Full-lag autocorrelation of the band height field and of `shade`, in **metres
 * of frontage**, so a repeat can be attributed to a named noise ring rather
 * than to a pixel lag that means a different length on every band.
 *
 * Written after `probe-period.mjs` found a repeat at lag 293 px in the rendered
 * band fill and the obvious suspect — the slope term's differencing baseline —
 * was refuted by changing it and watching the peak not move. If the period is in
 * `h`, it is measurable here with no capture and no GPU, and it can be named:
 * `envelope` builds from rings at 420 / 130 / 34 m and two crown octaves, and a
 * period in metres points straight at one of them.
 */
export function ringPeaks(minM = 8, maxM = 600): {
  radius: number;
  metresPerSample: number;
  h: { metres: number; r: number }[];
  shade: { metres: number; r: number }[];
}[] {
  const out = [];
  for (const spec of HORIZON_BANDS as BandSpec[]) {
    const samples = spec.samples ?? recommendedSamples(spec.radius);
    const shade = new Float32Array(samples);
    const h = envelope(spec, samples, shade);
    const mps = (2 * Math.PI * spec.radius) / samples;

    const peaks = (src: Float32Array) => {
      const mean = src.reduce((a, b) => a + b, 0) / src.length;
      const c = Array.from(src, (v) => v - mean);
      const v0 = c.reduce((a, b) => a + b * b, 0) || 1;
      // The ring is closed, so the correlation wraps and every lag has the full
      // sample count. No windowing bias, unlike the rendered frame.
      const acf: { L: number; r: number }[] = [];
      const lo = Math.max(2, Math.round(minM / mps));
      const hi = Math.min(Math.floor(samples / 2), Math.round(maxM / mps));
      for (let L = lo; L <= hi; L++) {
        let s = 0;
        for (let i = 0; i < samples; i++) s += c[i] * c[(i + L) % samples];
        acf.push({ L, r: s / v0 });
      }
      return acf
        .filter((q, i) => i > 0 && i < acf.length - 1 && q.r > acf[i - 1].r && q.r > acf[i + 1].r)
        .sort((p, q) => q.r - p.r)
        .slice(0, 5)
        .map((q) => ({ metres: q.L * mps, r: q.r }));
    };

    out.push({ radius: spec.radius, metresPerSample: mps, h: peaks(h), shade: peaks(shade) });
  }
  return out;
}

export function facetStats(facetM: number, blurDiv: number, gain: number, sunElevDeg = 6.2): FacetStats[] {
  const SOLAR_TAN = Math.tan((sunElevDeg * Math.PI) / 180);
  const out: FacetStats[] = [];
  for (const spec of HORIZON_BANDS as BandSpec[]) {
    const samples = spec.samples ?? recommendedSamples(spec.radius);
    const shade = new Float32Array(samples);
    const h = envelope(spec, samples, shade);
    const mps = (2 * Math.PI * spec.radius) / samples;
    const half = Math.max(1, Math.round(facetM / 2 / mps));

    const hs = new Float32Array(samples);
    const rad = Math.max(1, Math.round(half / blurDiv));
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += h[(k + samples) % samples];
    const inv = 1 / (2 * rad + 1);
    for (let i = 0; i < samples; i++) {
      hs[i] = sum * inv;
      sum += h[(i + rad + 1) % samples] - h[(i - rad + samples) % samples];
    }

    // Sun direction is irrelevant to the *range* of the term: `sunAlong` scales
    // it by a value that sweeps the full [-1, 1] around the ring. Take the
    // best case, |sunAlong| = 1, so this reports the authority the term has
    // where it has any at all rather than diluting it with the azimuths where
    // the ring runs across the sun.
    const vals: number[] = [];
    let pinned = 0;
    for (let i = 0; i < samples; i++) {
      const dh = (hs[(i + half) % samples] - hs[(i - half + samples) % samples]) / (2 * half * mps);
      const v = Math.min(1, Math.max(0, 0.5 + (dh / SOLAR_TAN) * gain));
      if (v <= 1e-6 || v >= 1 - 1e-6) pinned++;
      vals.push(v);
    }
    vals.sort((a, b) => a - b);
    const q = (f: number) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    out.push({
      radius: spec.radius,
      samples,
      metresPerSample: mps,
      half,
      baselineM: 2 * half * mps,
      p: { p02: q(0.02), p10: q(0.1), p50: q(0.5), p90: q(0.9), p98: q(0.98) },
      sd: Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length),
      pinned: pinned / vals.length,
    });
  }
  return out;
}
