#!/usr/bin/env node
/**
 * Whole-frame hunt for the exactly-black shading failure, with no region
 * supplied by the caller.
 *
 *   node tools/probe-zeroscan.mjs shots/system2/rounds/<id>/*.png
 *   node tools/probe-zeroscan.mjs --selftest
 *
 * `tools/probe-band.mjs` answers "is this rectangle a shading failure or a dark
 * object", and it answers it well - but the rectangle comes from the caller,
 * and per NOTES.md's standing complaint an agent who picks the coordinates
 * picks them where it already believes the defect is. The transmission-target
 * artefact was found that way and could just as easily have been missed that
 * way.
 *
 * The signature this looks for is a *distribution*, not a location, which is
 * why it needs no coordinates:
 *
 *  - exactly rgb(0,0,0) pixels, counted over the whole frame; and
 *  - the population of luma 1..15 immediately above them.
 *
 * A genuinely unlit object still carries fog, haze and a little sky, so it
 * bottoms out in the low teens and *fills* that band. A clamped shading failure
 * writes exact zero and leaves the band empty. So the diagnostic is the ratio:
 * many exact zeros with an empty 1..15 tail is bimodal-with-a-gap, which no
 * unlit object can produce. Few exact zeros, or exact zeros with a populated
 * tail, is ordinary dark geometry.
 *
 * Connected components of the exactly-black set are reported with their
 * bounding boxes and rectangularity (fill fraction of the bbox), because the
 * transmission artefact was specifically blocky and axis-aligned - a compact
 * component that fills its own bounding box is a rectangle somebody drew, and a
 * straggly one is a genuine dark crevice.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const SELFTEST = args.includes("--selftest");
const files = args.filter((a) => !a.startsWith("--"));

/** A component this small is a crevice or an antialiasing artefact, not a rectangle. */
const MIN_COMPONENT = 24;
/** Report at most this many components per frame, largest first. */
const TOP_N = 6;

function analyse(png, label) {
  const { width: W, height: H, data } = png;
  const N = W * H;
  const zero = new Uint8Array(N);
  let zeroCount = 0;
  const tail = new Array(16).fill(0);

  for (let i = 0; i < N; i++) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    if (r === 0 && g === 0 && b === 0) {
      zero[i] = 1;
      zeroCount++;
      continue;
    }
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l < 16) tail[Math.floor(l)]++;
  }

  const tailCount = tail.reduce((a, b) => a + b, 0);

  // Connected components (4-neighbour) over the exactly-black set.
  const seen = new Uint8Array(N);
  const comps = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!zero[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    let count = 0;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    let y1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W;
      const y = (i - x) / W;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && zero[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[sp++] = i - 1);
      if (x < W - 1 && zero[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[sp++] = i + 1);
      if (y > 0 && zero[i - W] && !seen[i - W]) (seen[i - W] = 1), (stack[sp++] = i - W);
      if (y < H - 1 && zero[i + W] && !seen[i + W]) (seen[i + W] = 1), (stack[sp++] = i + W);
    }
    if (count >= MIN_COMPONENT) {
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      comps.push({ count, x0, y0, bw, bh, fill: count / (bw * bh) });
    }
  }
  comps.sort((a, b) => b.count - a.count);

  const zeroPct = (zeroCount / N) * 100;
  // Bimodal-with-a-gap: a lot of exact zero and almost nothing just above it.
  const gap = zeroCount >= 200 && tailCount < zeroCount * 0.25;
  const blocky = comps.filter((c) => c.count >= 400 && c.fill > 0.75);

  console.log(`\n${label}  (${W}x${H})`);
  console.log(`  exactly rgb(0,0,0)     ${zeroCount}  (${zeroPct.toFixed(3)}% of frame)`);
  console.log(`  luma 1..15 population  ${tailCount}   histogram ${tail.slice(1).join(" ")}`);
  console.log(
    `  ratio tail/zero        ${zeroCount ? (tailCount / zeroCount).toFixed(2) : "n/a"}` +
      `   (an unlit object fills the tail; a clamped shading failure leaves it empty)`
  );
  console.log(`  black components >=${MIN_COMPONENT} px  ${comps.length}`);
  for (const c of comps.slice(0, TOP_N)) {
    console.log(
      `    ${String(c.count).padStart(7)} px  bbox ${c.x0},${c.y0} ${c.bw}x${c.bh}  fill ${c.fill.toFixed(2)}` +
        (c.count >= 400 && c.fill > 0.75 ? "   <-- compact rectangular black block" : "")
    );
  }
  const verdict = gap
    ? "SHADING FAILURE: exact-zero population with an empty 1..15 tail"
    : blocky.length
      ? "SUSPECT: compact rectangular black blocks present"
      : "clean: no bimodal gap, no rectangular black blocks";
  console.log(`  => ${verdict}`);
  return { zeroCount, zeroPct, tailCount, comps, gap, blocky: blocky.length, verdict };
}

function synth(W, H, fn) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  return png;
}

if (SELFTEST) {
  // A probe that cannot fail is not evidence (NOTES.md, repeatedly). Two
  // controls: a planted clamped-black rectangle that must be reported, and a
  // genuinely dark but fogged object that must not be.
  const bad = synth(400, 300, (x, y) => {
    const inBlock = x >= 100 && x < 260 && y >= 80 && y < 200;
    return inBlock ? [0, 0, 0] : [120, 130, 150];
  });
  const good = synth(400, 300, (x, y) => {
    const inObj = x >= 100 && x < 260 && y >= 80 && y < 200;
    // An unlit object under fog: low but never zero, and soft at its edge.
    if (!inObj) return [120, 130, 150];
    const e = Math.min(x - 100, 259 - x, y - 80, 199 - y);
    const t = Math.min(1, e / 3);
    const v = Math.round(6 + (1 - t) * 90);
    return [v, v, Math.round(v * 1.15)];
  });
  const a = analyse(bad, "--selftest  planted clamped-black rectangle (MUST report)");
  const b = analyse(good, "--selftest  fogged unlit object, no clamp (MUST NOT report)");
  const ok = (a.gap || a.blocky > 0) && !b.gap && b.blocky === 0;
  console.log(`\nselftest ${ok ? "PASS" : "FAIL"}\n`);
  process.exit(ok ? 0 : 1);
}

if (!files.length) {
  console.error("usage: probe-zeroscan.mjs <png>...   |   probe-zeroscan.mjs --selftest");
  process.exit(2);
}

let worst = 0;
for (const f of files) {
  const r = analyse(PNG.sync.read(fs.readFileSync(f)), f);
  if (r.gap) worst = Math.max(worst, 2);
  else if (r.blocky) worst = Math.max(worst, 1);
}
console.log("");
process.exit(worst === 2 ? 1 : 0);
