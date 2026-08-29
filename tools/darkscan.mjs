#!/usr/bin/env node
/**
 * Whole-frame luminance distribution, and an A/B that can tell "I added bounce"
 * apart from "I added ambient".
 *
 * The interior complaint this exists for is "every downward and rearward face
 * clamps to black". That is a statement about the *dark tail* of the frame, and
 * it has a specific falsifiable signature that a mean cannot express:
 *
 *   - A real indirect term lifts the tail and leaves the lit end alone. A face
 *     that already sees a troffer is near its own albedo ceiling and cannot get
 *     much brighter; a face that sees nothing goes from nothing to something.
 *     So p05 and p10 should move a lot and p90 should barely move.
 *   - A flat ambient lift moves the whole distribution together. It looks like
 *     a fix in a thumbnail and it is not one: it washes the room out, kills the
 *     contrast the storefront depends on, and is the exact mistake this project
 *     has recorded twice as "compensating in the wrong place".
 *
 * So the pass condition is a *ratio* between what happened at the two ends, not
 * a brightness. `--before` prints that comparison. Reporting one number for the
 * whole frame is what let both previous versions of this defect through.
 *
 * Takes no coordinates, on purpose — see NOTES.md case 34. An agent who picks
 * the rectangle picks it where it already believes the answer is.
 *
 *   node tools/darkscan.mjs frame.png
 *   node tools/darkscan.mjs after.png --before=before.png
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const arg = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

/** Rec.709 luma on the stored (display-referred) bytes, which is what a viewer sees. */
function lumaOf(png) {
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = Math.round(
      0.2126 * png.data[j] + 0.7152 * png.data[j + 1] + 0.0722 * png.data[j + 2]
    );
  }
  return out;
}

function stats(path) {
  const png = PNG.sync.read(readFileSync(path));
  const l = lumaOf(png);
  const hist = new Float64Array(256);
  for (const v of l) hist[v]++;
  const n = l.length;
  const pct = (p) => {
    let acc = 0;
    const want = (p / 100) * n;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= want) return v;
    }
    return 255;
  };
  const under = (t) => {
    let acc = 0;
    for (let v = 0; v < t; v++) acc += hist[v];
    return (acc / n) * 100;
  };
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  return {
    path,
    n,
    mean: sum / n,
    p01: pct(1), p05: pct(5), p10: pct(10), p25: pct(25),
    p50: pct(50), p75: pct(75), p90: pct(90), p99: pct(99),
    u8: under(8), u16: under(16), u24: under(24), u32: under(32),
    hist,
  };
}

const show = (s) => {
  console.log(`\n${s.path}  ${s.n} px`);
  console.log(`  mean ${s.mean.toFixed(1)}`);
  console.log(
    `  percentiles  p01 ${s.p01}  p05 ${s.p05}  p10 ${s.p10}  p25 ${s.p25}` +
    `  p50 ${s.p50}  p75 ${s.p75}  p90 ${s.p90}  p99 ${s.p99}`
  );
  console.log(
    `  unreadably dark  <8 ${s.u8.toFixed(2)}%   <16 ${s.u16.toFixed(2)}%` +
    `   <24 ${s.u24.toFixed(2)}%   <32 ${s.u32.toFixed(2)}%`
  );
};

/**
 * Colour as a function of brightness, in deciles, with no region picked.
 *
 * This exists for "are these frames all at the same time of day". A whole-frame
 * mean cannot answer that, because two poses at one instant legitimately differ
 * enormously in *sky* colour — this dawn's horizon runs blue/red 0.889 facing
 * away from the sun to 0.340 facing into it, a factor of 2.6, and that is the
 * sky being correct rather than the clock moving.
 *
 * What must agree between poses at one instant is the **key light**, and the
 * brightest deciles of a sunlit frame are mostly things the key is falling on.
 * So: bin every pixel by luma decile and report R-B per bin. A consistent sun
 * shows the same warm signature in the top deciles of every pose regardless of
 * which way the camera faces; a genuinely different time of day, or a per-pose
 * exposure or tone-mapping difference, moves the top deciles too.
 */
function chromaByDecile(path) {
  const png = PNG.sync.read(readFileSync(path));
  const l = lumaOf(png);
  const idx = Array.from(l.keys()).sort((a, b) => l[a] - l[b]);
  const per = Math.floor(idx.length / 10);
  const rows = [];
  for (let d = 0; d < 10; d++) {
    let r = 0, g = 0, b = 0;
    const lo = d * per;
    const hi = d === 9 ? idx.length : (d + 1) * per;
    for (let k = lo; k < hi; k++) {
      const j = idx[k] * 4;
      r += png.data[j]; g += png.data[j + 1]; b += png.data[j + 2];
    }
    const n = hi - lo;
    rows.push({ d, r: r / n, g: g / n, b: b / n, n });
  }
  return rows;
}

if (argv.includes("--chroma")) {
  console.log("decile   luma      R      G      B     R-B");
  for (const f of files) {
    console.log(`\n${f}`);
    for (const row of chromaByDecile(f)) {
      const lum = 0.2126 * row.r + 0.7152 * row.g + 0.0722 * row.b;
      console.log(
        `  d${row.d}   ${lum.toFixed(1).padStart(6)}  ${row.r.toFixed(1).padStart(6)}` +
        ` ${row.g.toFixed(1).padStart(6)} ${row.b.toFixed(1).padStart(6)}` +
        ` ${(row.r - row.b).toFixed(1).padStart(7)}`
      );
    }
  }
  process.exit(0);
}

const after = stats(files[0]);
const beforePath = arg("before");

if (!beforePath) {
  show(after);
  process.exit(0);
}

const before = stats(beforePath);
show(before);
show(after);

const d = (a, b) => b - a;
console.log(`\ncomparison  (before -> after)`);
for (const k of ["p01", "p05", "p10", "p25", "p50", "p75", "p90", "p99"]) {
  const delta = d(before[k], after[k]);
  console.log(`  ${k}  ${String(before[k]).padStart(3)} -> ${String(after[k]).padStart(3)}   ${delta >= 0 ? "+" : ""}${delta}`);
}
for (const k of ["u8", "u16", "u24", "u32"]) {
  console.log(`  ${k.padEnd(3)}  ${before[k].toFixed(2)}% -> ${after[k].toFixed(2)}%`);
}

// The verdict. A bounce lifts the floor of the image and leaves its ceiling
// alone; an ambient lift moves both. Expressed as a ratio so it does not depend
// on how strong the change was, only on its shape.
const tail = d(before.p05, after.p05) + d(before.p10, after.p10);
const head = Math.abs(d(before.p90, after.p90)) + Math.abs(d(before.p99, after.p99));
console.log(`\n  tail lift (p05+p10) ${tail >= 0 ? "+" : ""}${tail}   head movement (|p90|+|p99|) ${head}`);
if (tail <= 0) {
  console.log(`  => NO TAIL LIFT. The dark faces did not change; this is not the fix you think it is.`);
} else if (head === 0 || tail / head >= 3) {
  console.log(`  => BOUNCE-SHAPED: the dark end lifted ${head === 0 ? "with no" : `${(tail / head).toFixed(1)}x the`} movement at the lit end.`);
} else {
  console.log(`  => AMBIENT-SHAPED (ratio ${(tail / head).toFixed(1)}x, want >=3x): the whole frame moved together, which washes the room out rather than lighting its shadowed faces.`);
}
