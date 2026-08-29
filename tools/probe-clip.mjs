#!/usr/bin/env node
/**
 * Where are the clipped pixels, and what are they attached to?
 *
 *   node tools/probe-clip.mjs <png> [png...]
 *
 * `tmp/hotpx.mjs` answers "is anything clipped and how much", which is the
 * question that separates a real radiance bound from an eyeball verdict of
 * "blown out". It does not answer "which object", and that is the question a
 * fix needs: 721 pixels at (255,255,255) is one number that could be one lamp
 * or forty specks.
 *
 * So group them. Connected clusters of fully-clipped pixels, each with its
 * bounding box, area and fill — because the shape discriminates the mechanism
 * more sharply than the count does:
 *
 *   - a compact blob with high fill is a **source**: a lamp, a lit sign face
 *   - a thin high-aspect run is a **specular highlight** on an edge — door
 *     hardware, a mullion, a rail
 *   - scattered single pixels are **aliasing** on a bright edge, and are a
 *     resolution artefact rather than a radiance one
 *
 * Also reports the mean colour of the ring just outside each cluster, since a
 * neutral clip surrounded by neutral pixels is something white or emissive,
 * while a neutral clip surrounded by warm ones is a warm surface that railed all
 * three channels and had its hue destroyed on the way.
 */

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node tools/probe-clip.mjs <png> [png...]");
  process.exit(2);
}

for (const file of files) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width: w, height: h, data } = png;
  const clipped = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4] === 255 && data[i * 4 + 1] === 255 && data[i * 4 + 2] === 255) {
      clipped[i] = 1;
      total++;
    }
  }

  console.log(`\n${path.basename(file)}  ${w}x${h}  ${total} px at exactly (255,255,255)`);
  if (!total) {
    console.log("  nothing clipped");
    continue;
  }

  // Flood fill, 8-connected, iterative so a large blob cannot blow the stack.
  const seen = new Uint8Array(w * h);
  const clusters = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!clipped[s] || seen[s]) continue;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let n = 0;
    const border = [];
    while (stack.length) {
      const k = stack.pop();
      const x = k % w;
      const y = (k - x) / w;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const m = ny * w + nx;
          if (clipped[m]) {
            if (!seen[m]) {
              seen[m] = 1;
              stack.push(m);
            }
          } else {
            border.push(m);
          }
        }
      }
    }
    let br = 0;
    let bg = 0;
    let bb = 0;
    for (const m of border) {
      br += data[m * 4];
      bg += data[m * 4 + 1];
      bb += data[m * 4 + 2];
    }
    const bn = Math.max(1, border.length);
    clusters.push({
      n,
      minX,
      maxX,
      minY,
      maxY,
      surround: [Math.round(br / bn), Math.round(bg / bn), Math.round(bb / bn)],
    });
  }

  clusters.sort((a, b) => b.n - a.n);
  const singles = clusters.filter((c) => c.n <= 2).reduce((a, c) => a + c.n, 0);
  console.log(
    `  ${clusters.length} clusters; ${singles} px in clusters of 1–2 (aliasing on a bright edge)\n`
  );
  console.log("     px   bbox x        bbox y       w   h  aspect  fill   surrounding rgb   shape");
  for (const c of clusters.slice(0, 12)) {
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    const aspect = Math.max(cw, ch) / Math.min(cw, ch);
    const fill = c.n / (cw * ch);
    const shape =
      c.n <= 2 ? "speck" : aspect > 4 ? "edge highlight" : fill > 0.55 ? "SOURCE" : "irregular";
    const [r, g, b] = c.surround;
    const warm = r - b;
    console.log(
      `  ${String(c.n).padStart(5)}  ${String(c.minX).padStart(4)}-${String(c.maxX).padEnd(4)}  ` +
        `${String(c.minY).padStart(4)}-${String(c.maxY).padEnd(4)}  ${String(cw).padStart(3)} ${String(ch).padStart(3)}  ` +
        `${aspect.toFixed(1).padStart(5)}  ${fill.toFixed(2)}   ${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)}` +
        `  ${warm > 12 ? "warm" : warm < -6 ? "cool" : "neutral"}  ${shape}`
    );
  }
}
