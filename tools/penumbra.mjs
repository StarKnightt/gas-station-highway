#!/usr/bin/env node
/**
 * How wide is a shadow edge, and does its width grow with distance from contact?
 *
 * This exists because "the shadows look softer" and "the shadows are physically
 * soft" are different claims and only one of them is worth anything. A constant
 * filter radius and a contact-hardening one both produce soft shadows; they
 * differ in whether the softness is a *function of occluder separation*. That is
 * a two-point measurement, and it is not fakeable by changing a kernel width,
 * because a kernel change moves every point in the same direction.
 *
 * Method. Along a horizontal scan line, find the steepest luma step, then report
 * the distance over which the signal goes from 10% to 90% of that step. That is
 * the penumbra width in pixels.
 *
 * The trap this is built to avoid: penumbra width in *pixels* depends on
 * perspective as well as on the penumbra, and in a frame looking down a
 * forecourt the two vary together, so a raw pixel width is uninterpretable. The
 * fix is to divide - run the same scan lines on two frames that differ only in
 * the filter, and report the ratio. For a constant filter the width is
 * `penumbraWorld * pxPerMetre(row)`, so the ratio between the two frames is
 * `penumbraWorld_a / penumbraWorld_b` with the perspective term cancelled
 * exactly. A ratio that varies with row is growth; a ratio that is flat is a
 * kernel change wearing a physical name.
 *
 * usage:
 *   penumbra.mjs <png> [png2] --rows=520,600,680,760 [--x0=N] [--x1=N]
 */

import fs from "node:fs";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

if (!files.length) {
  console.error("usage: penumbra.mjs <png> [png2] --rows=520,600,680 [--x0=N --x1=N]");
  process.exit(2);
}

/* ---------------- minimal PNG reader (8-bit RGB/RGBA, no interlace) -------- */

function readPng(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colour = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (data[12] !== 0) throw new Error(`${path}: interlaced PNG unsupported`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`${path}: only 8-bit supported, got ${depth}`);
  const ch = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (!ch) throw new Error(`${path}: unsupported colour type ${colour}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * ch);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}

const luma = (img, x, y) => {
  const i = (y * img.w + x) * img.ch;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
};

/**
 * Steepest step on one row, and its 10-90 width.
 *
 * The row is smoothed first over a small window. Without it the asphalt's own
 * per-pixel detail wins the "steepest gradient" contest outright and the
 * measurement returns the noise floor - which reads as a very sharp shadow and
 * would have been a flattering, wrong answer.
 */
function edgeOnRow(img, y, x0, x1) {
  const n = x1 - x0;
  if (n < 24) return null;
  const s = new Float64Array(n);
  const K = 3;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let m = 0;
    for (let k = -K; k <= K; k++) {
      const x = x0 + i + k;
      if (x < 0 || x >= img.w) continue;
      acc += luma(img, x, y);
      m++;
    }
    s[i] = acc / m;
  }
  // Steepest slope over a short baseline, which is less noise-sensitive than a
  // one-pixel difference and still local enough to sit inside one penumbra.
  const B = 4;
  let best = 0;
  let bi = -1;
  for (let i = B; i < n - B; i++) {
    const d = Math.abs(s[i + B] - s[i - B]);
    if (d > best) {
      best = d;
      bi = i;
    }
  }
  if (bi < 0 || best < 4) return null;

  // Walk outward from the steepest point to the local plateaux either side.
  const dir = Math.sign(s[bi + B] - s[bi - B]);
  let lo = bi;
  let hi = bi;
  while (lo > 1 && dir * (s[lo - 1] - s[lo]) < 0.35) lo--;
  while (hi < n - 2 && dir * (s[hi + 1] - s[hi]) > -0.35) hi++;
  const a = s[lo];
  const b = s[hi];
  const span = Math.abs(b - a);
  if (span < 6) return null;
  const t10 = a + 0.1 * (b - a);
  const t90 = a + 0.9 * (b - a);
  const cross = (target) => {
    for (let i = lo; i < hi; i++) {
      const p = s[i];
      const q = s[i + 1];
      if ((p - target) * (q - target) <= 0 && p !== q) return i + (target - p) / (q - p);
    }
    return null;
  };
  const c10 = cross(t10);
  const c90 = cross(t90);
  if (c10 === null || c90 === null) return null;
  return { x: x0 + bi, width: Math.abs(c90 - c10), contrast: span, dark: Math.min(a, b) };
}

const rows = String(opt("rows", "")).split(",").filter(Boolean).map(Number);
const imgs = files.map((f) => ({ f, img: readPng(f) }));
const x0 = Number(opt("x0", 0));
const x1i = Number(opt("x1", imgs[0].img.w));

if (!rows.length) {
  console.error("give --rows=y1,y2,...");
  process.exit(2);
}

console.log("");
for (const { f, img } of imgs) console.log(`${f}  ${img.w}x${img.h}`);
console.log("");
const head = files.map((f) => f.replace(/\.png$/, "").slice(-22).padStart(24)).join("");
console.log(`   row${head}       ratio`);
const ratios = [];
for (const y of rows) {
  const cells = [];
  const widths = [];
  const xs = [];
  const cs = [];
  for (const { img } of imgs) {
    const e = edgeOnRow(img, y, x0, Math.min(x1i, img.w));
    if (!e) {
      cells.push("            no edge".padStart(24));
      widths.push(null);
      xs.push(NaN);
      cs.push(0);
      continue;
    }
    xs.push(e.x);
    cs.push(e.contrast);
    cells.push(`  x${String(e.x).padStart(4)} w${e.width.toFixed(1).padStart(5)} c${e.contrast.toFixed(0).padStart(3)}`.padStart(24));
    widths.push(e.width);
  }
  // Only compare an edge with itself.
  //
  // The first version of this divided whatever the detector found in frame A by
  // whatever it found in frame B, and on a cluttered frame those are frequently
  // two different edges metres apart - it reported a 3.8x spread that was really
  // "the steepest thing in this row moved". A ratio between unrelated edges is
  // not a measurement of anything, and it was a flattering one, which is the
  // combination this project has been caught by before. Require the two
  // detections to be at the same place and to be a real step, or print why not.
  let r = "";
  if (widths.length === 2 && widths[0] !== null && widths[1] !== null && widths[1] > 0) {
    const dx = Math.abs(xs[0] - xs[1]);
    if (dx > 3) r = `  unmatched dx=${dx}`.padStart(12);
    else if (Math.min(cs[0], cs[1]) < 12) r = `  faint c=${Math.min(cs[0], cs[1]).toFixed(0)}`.padStart(12);
    else {
      const v = widths[0] / widths[1];
      r = v.toFixed(3).padStart(12);
      ratios.push({ y, v });
    }
  }
  console.log(`${String(y).padStart(6)}${cells.join("")}${r}`);
}

if (ratios.length >= 2) {
  const first = ratios[0];
  const last = ratios[ratios.length - 1];
  const lo = Math.min(...ratios.map((r) => r.v));
  const hi = Math.max(...ratios.map((r) => r.v));
  console.log("");
  console.log(`  ratio range ${lo.toFixed(3)} .. ${hi.toFixed(3)}  (row ${first.y} -> ${last.y}: ${first.v.toFixed(3)} -> ${last.v.toFixed(3)})`);
  console.log(
    hi / lo > 1.6
      ? `  => on ${ratios.length} matched edges the width ratio spans ${(hi / lo).toFixed(2)}x after perspective\n     cancels, and crosses 1.0, so some edges got sharper while others got softer.\n     A change of kernel width moves every edge the same way; this did not.`
      : `  => ratio is close to flat (${(hi / lo).toFixed(2)}x) over ${ratios.length} matched edges; consistent with\n     one kernel width replacing another, NOT with contact hardening`
  );
}
console.log("");
