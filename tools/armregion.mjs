/**
 * armregion.mjs — where did a feature move pixels, by how much, and which way?
 *
 *   node tools/armregion.mjs feature.png control.png [threshold]
 *
 * `tools/armdiff.mjs` answers "did the arm move anything" over horizontal
 * bands. This answers the next three questions, which are the ones that decide
 * whether a feature reads:
 *
 *   1. WHERE. Connected components of the moved pixels, as crop boxes you can
 *      hand straight to `tools/pngcrop.mjs`. A feature 67 px tall judged inside
 *      an 800 px crop reads as a flat blob no matter how good it is; you have to
 *      crop to the feature before you are allowed an opinion about it.
 *
 *   2. WHICH WAY. Brightened and darkened pixels reported separately. A feature
 *      that both lifts and drops tone — standing water plus the damp stain
 *      around it, a decal plus its ambient occlusion — has a mean near zero and
 *      measures as nothing while delivering its entire effect. Pooling the two
 *      directions is how a working feature reports as absent.
 *
 *   3. AGAINST WHAT. The comparison is the SAME PIXELS in the control arm, never
 *      neighbouring pixels in the feature arm. A ring drawn around a feature
 *      imports whatever else is nearby: measuring these pools against a 40 px
 *      ring gave 1.05x because the ring caught sunlit ground and a pump cabinet,
 *      while the same pixels in the forced-off arm gave 1.88x. The ring was
 *      measuring the scene; the control was measuring the feature. A ring is a
 *      neighbourhood, not a baseline.
 *
 * Requires the two frames to be the same pose from the same bundle, differing
 * only in the forced-off token. If they are not, this reports the difference
 * between two scenes and calls it a feature.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const [aPath, bPath, thrArg] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: node tools/armregion.mjs feature.png control.png [threshold]");
  console.error("  threshold defaults to 4 luma levels, roughly the JPEG-invisible floor");
  process.exit(2);
}
const THR = Number(thrArg ?? 4);
if (!Number.isFinite(THR) || THR <= 0) {
  console.error(`[armregion] threshold must be a positive number, got ${thrArg}`);
  process.exit(2);
}

const A = PNG.sync.read(fs.readFileSync(aPath));
const B = PNG.sync.read(fs.readFileSync(bPath));
if (A.width !== B.width || A.height !== B.height) {
  console.error(`[armregion] size mismatch ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  process.exit(1);
}
// A zero-area frame passes every mean-based check because the mean of no pixels
// is NaN and every comparison against NaN is false. Reject it by dimension.
if (A.width < 8 || A.height < 8) {
  console.error(`[armregion] refusing a ${A.width}x${A.height} frame`);
  process.exit(1);
}

const W = A.width;
const H = A.height;
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

const dir = new Int8Array(W * H); // +1 brightened, -1 darkened, 0 unmoved
const up = [];
const upC = [];
const dn = [];
const dnC = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const i = k * 4;
    const la = lum(A.data, i);
    const lb = lum(B.data, i);
    const d = la - lb;
    if (d > THR) {
      dir[k] = 1;
      up.push(la);
      upC.push(lb);
    } else if (d < -THR) {
      dir[k] = -1;
      dn.push(la);
      dnC.push(lb);
    }
  }
}

const pct = (n) => `${((100 * n) / (W * H)).toFixed(3)}%`;
const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
const stat = (v) => {
  if (!v.length) return "no pixels";
  const s = v.slice().sort((p, q) => p - q);
  const q = (f) => s[Math.floor(f * (s.length - 1))];
  return (
    `p10=${q(0.1).toFixed(0).padStart(3)} p50=${q(0.5).toFixed(0).padStart(3)} ` +
    `p90=${q(0.9).toFixed(0).padStart(3)} spread=${(q(0.9) - q(0.1)).toFixed(0).padStart(3)}`
  );
};

console.log(`${aPath}\n  vs ${bPath}\n  ${W}x${H}, threshold ${THR} luma levels\n`);

for (const [label, v, c] of [
  ["BRIGHTENED", up, upC],
  ["DARKENED  ", dn, dnC],
]) {
  console.log(`${label}  ${String(v.length).padStart(7)} px  ${pct(v.length)}`);
  if (v.length) {
    console.log(`               arm  ${stat(v)}`);
    console.log(`           control  ${stat(c)}`);
    console.log(`             ratio  ${(mean(v) / mean(c)).toFixed(2)}x  (arm / control, same pixels)`);
  }
  console.log("");
}

/** Connected components of one direction, largest first, as pngcrop arguments. */
function clusters(want, minPx) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k0 = y * W + x;
      if (dir[k0] !== want || seen[k0]) continue;
      const stack = [k0];
      seen[k0] = 1;
      let n = 0;
      let x0 = W;
      let x1 = 0;
      let y0 = H;
      let y1 = 0;
      while (stack.length) {
        const c = stack.pop();
        const cx = c % W;
        const cy = (c - cx) / W;
        n++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nk = ny * W + nx;
          if (dir[nk] === want && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
      if (n >= minPx) out.push({ n, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
  }
  return out.sort((p, q) => q.n - p.n);
}

for (const [label, want] of [["brightened", 1], ["darkened", -1]]) {
  const cs = clusters(want, 150);
  if (!cs.length) continue;
  console.log(`${label} clusters (>=150 px), crop boxes with a 20 px margin:`);
  for (const c of cs.slice(0, 8)) {
    const m = 20;
    const cx = Math.max(0, c.x0 - m);
    const cy = Math.max(0, c.y0 - m);
    const cw = Math.min(W - cx, c.w + 2 * m);
    const ch = Math.min(H - cy, c.h + 2 * m);
    console.log(
      `  ${String(c.n).padStart(6)} px  ${String(c.w).padStart(4)}x${String(c.h).padStart(3)}` +
        `  aspect ${(c.w / c.h).toFixed(1)}:1   node tools/pngcrop.mjs <in> <out> ${cx} ${cy} ${cw} ${ch} 3`
    );
  }
  console.log("");
}

if (!up.length && !dn.length) {
  console.log("NOTHING MOVED. Either the feature is off in both arms, or the token");
  console.log("does not reach the code, or the two frames are the same capture.");
  console.log("A control that cannot fail certifies a feature that may not exist.");
}
