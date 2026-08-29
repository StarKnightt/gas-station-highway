/**
 * gainjudge.mjs — choose the near-field detail gain on both ends of the trade.
 *
 * WHY THIS EXISTS. `mix(baseNormal, detailNormal, w)` does not add detail, it
 * trades base for detail. The base normal at 4-8 m carries the large-scale clod
 * and blob structure; the detail sample carries pixel-scale relief. Raising the
 * gain buys the second by spending the first. mean|Laplacian| — the statistic
 * that defined the defect and that nearjudge.mjs uses — rises monotonically as
 * the blobs are destroyed, so judging the gain on it alone recommends w = 1.0
 * and a band of uniform crunch. It is a one-sided instrument on a two-sided
 * question.
 *
 * So this reports two numbers per arm over the same pixels:
 *
 *   FINE   mean|Laplacian| at full resolution. Pixel-scale relief. Higher is
 *          the thing the feature is for.
 *   COARSE standard deviation of the band after a box blur wide enough to erase
 *          everything the detail layer adds. Blob-scale tonal variation. This is
 *          what the gain spends, and it must not collapse.
 *
 * The blur radius is chosen against the texel arithmetic rather than by eye: at
 * the measured 3.67 screen pixels per dirt texel, the base map's own features
 * start around 4 px and the detail layer runs at 3x that frequency, so a 13 px
 * box (r=6) is past both and leaves only structure the base normal owns.
 *
 * CALIBRATION, so COARSE can be read. The gain-0 arm is the full large-scale
 * endpoint: whatever COARSE reads with the layer forced off is 100% of the blob
 * structure available. A gain is acceptable if it keeps most of that while
 * moving FINE.
 *
 * SELFTEST. `node tools/gainjudge.mjs --selftest` plants two synthetic bands:
 * one with blobs and no grain, one with grain and no blobs. A working instrument
 * reports high COARSE / low FINE on the first and the reverse on the second. An
 * instrument whose two metrics both track the same thing fails this.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const BAND = [1100, 800, 500, 99];       // Film's band, same pixels as nearjudge
const BAND_TALL = [1100, 690, 500, 210]; // more rows, for blob structure (ends exactly at row 900)
const BLUR_R = 6;

const load = (p) => PNG.sync.read(readFileSync(p));

/** Luma plane of a region, as a flat Float64Array plus its dimensions. */
function plane(png, [x, y, w, h]) {
  // A region running off the edge yields undefined samples, and undefined
  // propagates to NaN through every mean below. Reject it here rather than
  // reporting a statistic computed from pixels that do not exist.
  if (x < 0 || y < 0 || x + w > png.width || y + h > png.height)
    throw new Error(`region ${[x, y, w, h]} is outside ${png.width}x${png.height}`);
  const out = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = ((y + j) * png.width + (x + i)) << 2;
      out[j * w + i] =
        0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
    }
  }
  return { d: out, w, h };
}

/** FINE: mean |Laplacian|, interior only so the border contributes no edge. */
function fine(p) {
  let s = 0, n = 0;
  for (let j = 1; j < p.h - 1; j++) {
    for (let i = 1; i < p.w - 1; i++) {
      const c = p.d[j * p.w + i];
      s += Math.abs(
        4 * c -
          p.d[(j - 1) * p.w + i] - p.d[(j + 1) * p.w + i] -
          p.d[j * p.w + i - 1] - p.d[j * p.w + i + 1],
      );
      n++;
    }
  }
  return s / n;
}

/** Separable box blur, edge-clamped. */
function blur(p, r) {
  const t = new Float64Array(p.w * p.h), o = new Float64Array(p.w * p.h);
  for (let j = 0; j < p.h; j++)
    for (let i = 0; i < p.w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const ii = Math.min(p.w - 1, Math.max(0, i + k));
        s += p.d[j * p.w + ii]; n++;
      }
      t[j * p.w + i] = s / n;
    }
  for (let j = 0; j < p.h; j++)
    for (let i = 0; i < p.w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const jj = Math.min(p.h - 1, Math.max(0, j + k));
        s += t[jj * p.w + i]; n++;
      }
      o[j * p.w + i] = s / n;
    }
  return { d: o, w: p.w, h: p.h };
}

/** COARSE: sd of the blurred plane. Guarded against a non-finite result. */
function coarse(p, r) {
  const b = blur(p, r);
  let m = 0;
  for (const v of b.d) m += v;
  m /= b.d.length;
  let s = 0;
  for (const v of b.d) s += (v - m) * (v - m);
  const sd = Math.sqrt(s / b.d.length);
  if (!Number.isFinite(sd)) throw new Error("COARSE is not finite");
  return sd;
}

/**
 * OCTAVES: how the band's variance is distributed across spatial scales.
 *
 * COARSE and FINE together still cannot see the failure that actually decides
 * this gain. Raising the gain adds relief at exactly one scale — the base map at
 * 3x — so past some density the band stops reading as "dirt with clods" and
 * starts reading as an even stipple of same-sized marks. That is scale
 * uniformity, not tonal flatness and not periodicity, and it is a percept this
 * project has already been caught by once: a narrow-band random field looks like
 * a pattern because the eye reads scale uniformity, not only repetition.
 *
 * Tonal variance can stay high while all of it collects in one octave, so the
 * quantity to watch is the SHAPE of the distribution. Reported as the fraction
 * of total band-pass energy in each octave plus the peak share; a rising peak
 * share means the surface is converging on a single mark size.
 */
function octaves(p) {
  const radii = [1, 2, 4, 8, 16];
  const blurs = radii.map((r) => blur(p, r));
  const sd = (a, b) => {
    let m = 0;
    for (let i = 0; i < a.d.length; i++) m += a.d[i] - b.d[i];
    m /= a.d.length;
    let s = 0;
    for (let i = 0; i < a.d.length; i++) {
      const v = a.d[i] - b.d[i] - m;
      s += v * v;
    }
    return Math.sqrt(s / a.d.length);
  };
  // finest octave is (original - blur1), then successive blur differences
  const bands = [sd(p, blurs[0])];
  for (let i = 0; i < blurs.length - 1; i++) bands.push(sd(blurs[i], blurs[i + 1]));
  const tot = bands.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(tot) || tot <= 0) throw new Error("octave energy is not usable");
  const share = bands.map((b) => b / tot);
  return { share, peak: Math.max(...share) };
}

function measure(png, region) {
  const p = plane(png, region);
  const f = fine(p), c = coarse(p, BLUR_R), o = octaves(p);
  if (!Number.isFinite(f)) throw new Error("FINE is not finite");
  return { fine: f, coarse: c, oct: o, mean: p.d.reduce((a, b) => a + b, 0) / p.d.length };
}

if (process.argv.includes("--selftest")) {
  const mk = (fn) => {
    const png = new PNG({ width: 1700, height: 1000 });
    for (let y = 0; y < 1000; y++)
      for (let x = 0; x < 1700; x++) {
        const v = Math.max(0, Math.min(255, fn(x, y)));
        const o = (y * 1700 + x) << 2;
        png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
        png.data[o + 3] = 255;
      }
    return png;
  };
  // Blobs at ~60 px, no grain.
  const blobs = mk((x, y) => 30 + 12 * Math.sin(x / 19) * Math.sin(y / 19));
  // Grain at the pixel scale, no blobs.
  const grain = mk((x, y) => 30 + 12 * (((x * 7919 + y * 104729) % 97) / 96 - 0.5) * 2);
  const B = measure(blobs, BAND), G = measure(grain, BAND);
  console.log(`  blobs-only   FINE ${B.fine.toFixed(2)}  COARSE ${B.coarse.toFixed(2)}`);
  console.log(`  grain-only   FINE ${G.fine.toFixed(2)}  COARSE ${G.coarse.toFixed(2)}`);
  const ok = B.coarse > G.coarse * 3 && G.fine > B.fine * 3;
  console.log(ok
    ? "  SELFTEST PASS — the two metrics separate the two structures"
    : "  SELFTEST FAIL — the metrics do not discriminate; do not trust the run");
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: node tools/gainjudge.mjs <label=file.png> <label=file.png> ...");
  process.exit(2);
}

console.log(`band ${BAND.join(",")}  blur r=${BLUR_R}\n`);
const rows = [];
for (const a of args) {
  const [label, file] = a.split("=");
  const png = load(file);
  rows.push({ label, n: measure(png, BAND), t: measure(png, BAND_TALL) });
}
const base = rows[0];
console.log("arm            mean   FINE  (vs base)   COARSE  (kept)   COARSE tall  (kept)");
for (const r of rows) {
  const fk = (r.n.fine / base.n.fine).toFixed(2);
  const ck = ((r.n.coarse / base.n.coarse) * 100).toFixed(0);
  const tk = ((r.t.coarse / base.t.coarse) * 100).toFixed(0);
  console.log(
    `${r.label.padEnd(13)} ${r.n.mean.toFixed(1).padStart(5)}  ` +
      `${r.n.fine.toFixed(2).padStart(5)}  ${(fk + "x").padStart(7)}   ` +
      `${r.n.coarse.toFixed(2).padStart(5)}  ${(ck + "%").padStart(6)}   ` +
      `${r.t.coarse.toFixed(2).padStart(6)}  ${(tk + "%").padStart(6)}`,
  );
}
console.log(`\n(base for the ratios is "${base.label}")`);

console.log("\noctave share of band-pass energy — is the surface converging on one mark size?");
console.log("arm            ~2px   ~4px   ~8px  ~16px  ~32px    peak");
for (const r of rows) {
  console.log(
    `${r.label.padEnd(13)} ` +
      r.n.oct.share.map((s) => (s * 100).toFixed(1).padStart(5)).join("  ") +
      `   ${(r.n.oct.peak * 100).toFixed(1)}%`,
  );
}
