#!/usr/bin/env node
/**
 * CPU-only audit of the alpha channel of the procedural foliage cards, plus the
 * card quad geometry's UV coverage. No renderer, no GPU.
 *
 * Two questions this answers, both raised as builder/critic contradictions:
 *
 *  1. Does the needle texture actually reach zero alpha at its four borders, or
 *     is the card quad's own rectangle visible because border alpha survives
 *     the alpha test? (Critic: "straight cut edges and visible right-angle
 *     corners".)
 *  2. How much of the card's alpha sits in the band between the beauty-pass
 *     alphaTest and the 0.5 that three.js forces on the *shadow* pass whenever
 *     `alphaToCoverage` is true (three.module.js:9531)? Everything in that band
 *     draws but casts nothing.
 *
 *   node tools/vegalpha.mjs
 */
import { writeFileSync, rmSync } from "node:fs";
import { PNG } from "pngjs";
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { cards, cardUv } = await import("../.shot-build/cpu/vegalpha.mjs");

const BEAUTY_ALPHA_TEST = 0.3;
const SHADOW_ALPHA_TEST_WITH_A2C = 0.5;

function audit(name, tex) {
  const { width: w, height: h, data } = { width: tex.image.width, height: tex.image.height, data: tex.image.data };
  const A = (x, y) => data[(y * w + x) * 4 + 3] / 255;

  let above = 0;
  let inGap = 0;
  let total = w * h;
  const hist = new Array(10).fill(0);
  for (let i = 0; i < total; i++) {
    const a = data[i * 4 + 3] / 255;
    if (a >= BEAUTY_ALPHA_TEST) above++;
    if (a >= BEAUTY_ALPHA_TEST && a < SHADOW_ALPHA_TEST_WITH_A2C) inGap++;
    hist[Math.min(9, Math.floor(a * 10))]++;
  }

  // Border rings: how far in do you have to go before any pixel passes the cut?
  let firstLiveRing = -1;
  const ringMax = [];
  for (let r = 0; r < Math.min(24, w / 2); r++) {
    let m = 0;
    for (let x = r; x < w - r; x++) {
      m = Math.max(m, A(x, r), A(x, h - 1 - r));
    }
    for (let y = r; y < h - r; y++) {
      m = Math.max(m, A(r, y), A(w - 1 - r, y));
    }
    ringMax.push(m);
    if (firstLiveRing < 0 && m >= BEAUTY_ALPHA_TEST) firstLiveRing = r;
  }

  const corners = [A(0, 0), A(w - 1, 0), A(0, h - 1), A(w - 1, h - 1)];

  // Per side, because the bottom edge of a scrub card is *supposed* to be
  // opaque: that is where the clump meets the ground. Only left/right/top
  // being opaque indicates a clipped drawing.
  const side = { left: 0, right: 0, bottom: 0, top: 0 };
  for (let r = 0; r < 2; r++) {
    for (let x = 0; x < w; x++) {
      side.bottom = Math.max(side.bottom, A(x, r));
      side.top = Math.max(side.top, A(x, h - 1 - r));
    }
    for (let y = 0; y < h; y++) {
      side.left = Math.max(side.left, A(r, y));
      side.right = Math.max(side.right, A(w - 1 - r, y));
    }
  }

  console.log(`\n=== ${name}  ${w}x${h} ===`);
  console.log(`  coverage above beauty alphaTest ${BEAUTY_ALPHA_TEST}: ${((above / total) * 100).toFixed(2)}%`);
  console.log(
    `  alpha in the shadow gap [${BEAUTY_ALPHA_TEST}, ${SHADOW_ALPHA_TEST_WITH_A2C}): ${((inGap / total) * 100).toFixed(2)}% of the card, ` +
      `= ${((inGap / Math.max(1, above)) * 100).toFixed(1)}% of everything the beauty pass draws`
  );
  console.log(`  corner alpha: ${corners.map((c) => c.toFixed(3)).join("  ")}`);
  console.log(
    `  max alpha on outer 2 texels per side -- left ${side.left.toFixed(3)}  right ${side.right.toFixed(3)}  ` +
      `top ${side.top.toFixed(3)}  bottom ${side.bottom.toFixed(3)}` +
      (Math.max(side.left, side.right, side.top) > 0.02 ? "   <-- CLIPPED: card rectangle will be visible" : "")
  );
  console.log(`  outermost ring max alpha: ${ringMax.slice(0, 8).map((v) => v.toFixed(3)).join(" ")}`);
  console.log(`  first ring reaching the cut: ${firstLiveRing < 0 ? "none in 24 px (border is clean)" : `ring ${firstLiveRing}`}`);
  console.log(`  alpha histogram (deciles): ${hist.map((v) => ((v / total) * 100).toFixed(1)).join(" ")}`);

  // Write an alpha-only visualisation so the shape is inspectable without a GPU.
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < total; i++) {
    const a = data[i * 4 + 3];
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = a;
    png.data[i * 4 + 3] = 255;
  }
  writeFileSync(`shots/system6/_alpha-${name}.png`, PNG.sync.write(png));

  // And a hard-cut version at each threshold, to see what the shadow pass loses.
  for (const cut of [BEAUTY_ALPHA_TEST, SHADOW_ALPHA_TEST_WITH_A2C]) {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < total; i++) {
      const v = data[i * 4 + 3] / 255 >= cut ? 255 : 0;
      p.data[i * 4] = p.data[i * 4 + 1] = p.data[i * 4 + 2] = v;
      p.data[i * 4 + 3] = 255;
    }
    writeFileSync(`shots/system6/_cut-${name}-${cut}.png`, PNG.sync.write(p));
  }
  return { above, inGap, total };
}

for (const [name, tex] of Object.entries(cards)) audit(name, tex);

console.log(`\n=== foliage card quad UVs ===`);
console.log(cardUv);

rmSync(".shot-build/cpu", { recursive: true, force: true });
