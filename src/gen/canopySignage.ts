/**
 * Brand identity on the canopy fascia: the logo panels, the price panel, the
 * column plates, and the overflow stain that goes under a scupper.
 *
 * ## Why this is the highest-value thing left on the canopy
 *
 * A bare deck on four columns is a carport. What makes a forecourt canopy
 * identifiable is the band round its edge, and the band is the element a viewer
 * uses to work out what they are looking at before they have looked at anything
 * else. It is also the only part of this system visible from outside the site.
 *
 * ## Sizing: absolute type, derived panel
 *
 * Two findings from other systems tonight set the whole method here.
 *
 * Building's: **the resolution budget is per element, not per texture.** Its
 * masthead was authored at 74 texture pixels and delivered 19 screen pixels,
 * which read; a body line in the same texture delivered 3.9, which did not.
 * Nothing about the texture's size predicted either number. Car's companion
 * result: above roughly 50 delivered pixels, an element that does not read has
 * a contrast fault, not a size fault.
 *
 * And the caution about small elements: **a detail sized as a fraction of its
 * parent is wrong wherever the parent varies**, because real detail has an
 * absolute size set by physics. Sign lettering is a textbook case — a sign
 * shop cuts 15-inch letters, it does not cut letters that are 68% of whatever
 * band it is given.
 *
 * So the dependency runs the other way round from the obvious one. Every
 * dimension in `TYPE` below is an absolute millimetre size, the artwork is
 * drawn in a millimetre coordinate system, and the **panel width is measured
 * from the content it has to hold** rather than the type being scaled to fit a
 * panel. `tools/probe-canopy.mjs` then projects those millimetre sizes through
 * each capture camera and reports delivered pixels per pose, so the question
 * "is this legible" is answered before a capture rather than after.
 *
 * ## Why one atlas
 *
 * Four logo panels, one price panel and four column plates are nine quads
 * carrying three distinct pieces of artwork. Three textures would be three
 * materials and three draw calls for 18 triangles. One 1024x512 atlas is one
 * material and one draw call, and the regions are chosen so no part of it is
 * wasted. 2 MB, against a scene at 710 MB.
 *
 * Texel density is deliberately anisotropic — 320/m across a panel and 512/m
 * up it — because horizontal resolution is the cheap axis here: what has to
 * survive the mip chain is the *height* of a capital and the horizontal
 * thickness of its stroke, and the second of those is set by the stroke, not by
 * the glyph's width. The quad's aspect matches the millimetre space exactly, so
 * nothing is stretched on screen.
 *
 * Canvases are opaque (`alpha: false`, filled before anything is drawn), per
 * NOTES case 1: a canvas backing store is premultiplied, so writing partial
 * alpha and reading it back corrupts RGB. The one element that genuinely needs
 * an alpha channel — the overflow stain — is built as a DataTexture instead and
 * never goes near a canvas.
 *
 * Wording and marks are invented. No real brands anywhere in this project.
 */

import * as THREE from "three";
import { fbm, makeRng } from "./noise";

/* ------------------------------------------------------------------ */
/* the brand                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lifted from `pumpDecals.ts` so the canopy and the dispensers carry the same
 * identity. A station whose canopy and pumps disagree about their own brand is
 * a specific and quite noticeable kind of wrong, and it is the sort of thing
 * that survives review because each element is individually fine.
 */
export const BRAND = {
  cream: "#f2ead6",
  red: "#7d2128",
  gold: "#c8a24a",
  ink: "#2b2a28",
  name: "MERIDIAN",
  sub: "F U E L   C O .",
} as const;

/**
 * Absolute type and detail sizes, in millimetres. Not one of these is a
 * fraction of anything.
 *
 * `wordCap` at 380 mm is a 15-inch letter, which is what a sign shop cuts for a
 * fascia this size. `plateCap` is small on purpose: the column plate is read
 * from two metres away by somebody putting fuel in a car, and sizing it for the
 * highway would make it absurd up close.
 */
export const TYPE = {
  /** Cap height of the wordmark on the fascia panels. */
  wordCap: 380,
  /** Cap height of the secondary line under it. */
  subCap: 130,
  /** Height of the three-chevron mark. */
  markH: 430,
  /** Cap height of the price numerals. */
  priceCap: 300,
  /** Cap height of the grade label above them. */
  gradeCap: 95,
  /** Cap height of the wordmark on the column plates. */
  plateCap: 58,

  /** Panel heights. Chosen to leave a margin inside a 700 mm fascia band. */
  logoPanelH: 560,
  pricePanelH: 500,
  platePanelH: 360,

  /** Deep band across the foot of the logo panel. */
  footBand: 104,
  /** Gold pinstripe over it. */
  pinstripe: 13,
  /** Quiet margin inside a panel edge. */
  margin: 175,
  /** Dark return visible round the sign face, i.e. the cabinet's border. */
  cabinetBorder: 40,
  /** How far the sign face stands off the nominal fascia plane. */
  standoff: 35,
  /** Depth of the cabinet behind the face. */
  cabinetDepth: 53,
} as const;

/** Atlas regions, in texels of a 1024 x 512 sheet. Every texel is used. */
const ATLAS = { w: 1024, h: 512 } as const;
const REGION = {
  logo: { x: 0, y: 0, w: 1024, h: 256 },
  price: { x: 0, y: 256, w: 768, h: 256 },
  plate: { x: 768, y: 256, w: 256, h: 256 },
} as const;

export interface SignPanel {
  /** Real-world panel size, metres. */
  w: number;
  h: number;
  /** UV rectangle of this panel's artwork in the atlas: u0, v0, u1, v1. */
  uv: [number, number, number, number];
}

export interface SignAtlas {
  texture: THREE.CanvasTexture;
  logo: SignPanel;
  price: SignPanel;
  plate: SignPanel;
  /** Delivered-pixel bookkeeping, for the probe and the self-report. */
  type: {
    /** Cap height in metres of every element the probe should size. */
    elements: { name: string; panel: "logo" | "price" | "plate"; capM: number }[];
  };
}

function opaqueCanvas(w: number, h: number, fill: string) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

/**
 * Cap height to em size for Arial/Helvetica Bold. Measured rather than assumed
 * would be better, but `measureText` reports no vertical metrics that are
 * portable across the browser and the type-stripped node environment the probe
 * runs in, and a constant that is wrong by a few percent moves a 380 mm capital
 * by 10 mm. The number below is the standard Arial cap-height ratio.
 */
const CAP_PER_EM = 0.716;
const em = (capMm: number) => capMm / CAP_PER_EM;

/**
 * Three stacked chevrons, drawn in millimetres.
 *
 * Stroke widths are absolute and taper upward, which is the detail that keeps
 * the mark from reading as a stack of identical Vs. At the distance where the
 * wordmark has stopped being letters this is the only thing still carrying the
 * brand, so it is drawn with three heavy strokes and nothing else — the same
 * design point `pumpDecals` states as "still a shape at 12 px".
 */
function drawMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number, colour: string) {
  const halfW = h * 0.56;
  const pitch = h * 0.3;
  const rise = h * 0.34;
  ctx.strokeStyle = colour;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = 62 - i * 11;
    const y = cy + pitch - i * pitch;
    ctx.beginPath();
    ctx.moveTo(cx - halfW, y);
    ctx.lineTo(cx, y - rise);
    ctx.lineTo(cx + halfW, y);
    ctx.stroke();
  }
}

/**
 * Years of ultraviolet, applied as opaque pixels over the finished artwork.
 *
 * Opaque rather than a low-alpha overlay for the premultiplied-canvas reason in
 * the file header, and strongest at the top because that is where the sun
 * actually lands on a vertical panel under a horizontal deck.
 */
function bleach(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }) {
  const img = ctx.getImageData(r.x, r.y, r.w, r.h);
  const d = img.data;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const i = (y * r.w + x) * 4;
      const f =
        0.05 + 0.11 * (1 - y / r.h) + 0.05 * Math.sin(x * 0.009 + 0.7) * Math.cos(y * 0.021 - 1.1);
      d[i] += (238 - d[i]) * f;
      d[i + 1] += (233 - d[i + 1]) * f;
      d[i + 2] += (219 - d[i + 2]) * f;
    }
  }
  ctx.putImageData(img, r.x, r.y);
}

/**
 * The atlas, and the real-world panel sizes that fall out of it.
 *
 * The logo panel's *width* is the one dimension here that is measured rather
 * than declared: the wordmark is set at its absolute cap height, the mark and
 * the margins are absolute, and the panel comes out as wide as it needs to be.
 * That is the correct direction of dependency and it is the whole point — if
 * the fascia band is ever made deeper or shallower the letters do not change
 * size, because a sign shop's letters do not care how big the band is.
 */
export function makeCanopySignAtlas(): SignAtlas {
  const { canvas, ctx } = opaqueCanvas(ATLAS.w, ATLAS.h, BRAND.cream);

  /* ---------------- logo panel: measure the content, then size it ---------------- */

  // Measured in a plain 1:1 millimetre space before any transform is applied,
  // so the number is a physical width and not a texel count.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `700 ${em(TYPE.wordCap)}px Arial, Helvetica, sans-serif`;
  const wordW = ctx.measureText(BRAND.name).width;
  if (!Number.isFinite(wordW) || wordW < TYPE.wordCap) {
    throw new Error(
      `canopy signage: measureText returned ${wordW} mm for "${BRAND.name}" at a ${TYPE.wordCap} mm ` +
        `cap height, which cannot be right. The panel width is derived from this, so a stub ` +
        `measureText silently produces a panel the artwork does not fit.`
    );
  }
  const markW = TYPE.markH * 1.12;
  const logoW = Math.min(
    5100,
    Math.max(3200, TYPE.margin * 2 + markW + TYPE.margin * 0.9 + wordW)
  );

  const logo: SignPanel = {
    w: logoW / 1000,
    h: TYPE.logoPanelH / 1000,
    uv: [0, 1 - REGION.logo.h / ATLAS.h, 1, 1],
  };

  // Millimetre space for this region. Anisotropic on purpose; see the header.
  const lsx = REGION.logo.w / logoW;
  const lsy = REGION.logo.h / TYPE.logoPanelH;
  ctx.setTransform(lsx, 0, 0, lsy, REGION.logo.x, REGION.logo.y);

  ctx.fillStyle = BRAND.cream;
  ctx.fillRect(0, 0, logoW, TYPE.logoPanelH);

  // The hard horizontal value break that does the work once the type has gone.
  ctx.fillStyle = BRAND.red;
  ctx.fillRect(0, TYPE.logoPanelH - TYPE.footBand, logoW, TYPE.footBand);
  ctx.fillStyle = BRAND.gold;
  ctx.fillRect(0, TYPE.logoPanelH - TYPE.footBand - TYPE.pinstripe, logoW, TYPE.pinstripe);

  const upperH = TYPE.logoPanelH - TYPE.footBand - TYPE.pinstripe;
  drawMark(ctx, TYPE.margin + markW / 2, upperH * 0.52, TYPE.markH, BRAND.red);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = BRAND.ink;
  ctx.font = `700 ${em(TYPE.wordCap)}px Arial, Helvetica, sans-serif`;
  const wordX = TYPE.margin + markW + TYPE.margin * 0.9;
  ctx.fillText(BRAND.name, wordX, upperH * 0.5 + TYPE.wordCap / 2);

  ctx.fillStyle = BRAND.cream;
  ctx.font = `600 ${em(TYPE.subCap)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(BRAND.sub, wordX + 6, TYPE.logoPanelH - TYPE.footBand / 2 + TYPE.subCap / 2);

  /* ---------------- price panel ---------------- */

  // Declared, not derived from the atlas region: expressing a physical sign
  // width as a ratio of a texel layout is exactly the coupling this file exists
  // to avoid. 2.4 m puts the numerals at the same texel density as the wordmark.
  const priceWmm = 2400;
  const price: SignPanel = {
    w: priceWmm / 1000,
    h: TYPE.pricePanelH / 1000,
    uv: [
      REGION.price.x / ATLAS.w,
      1 - (REGION.price.y + REGION.price.h) / ATLAS.h,
      (REGION.price.x + REGION.price.w) / ATLAS.w,
      1 - REGION.price.y / ATLAS.h,
    ],
  };

  const psx = REGION.price.w / priceWmm;
  const psy = REGION.price.h / TYPE.pricePanelH;
  ctx.setTransform(psx, 0, 0, psy, REGION.price.x, REGION.price.y);

  ctx.fillStyle = BRAND.ink;
  ctx.fillRect(0, 0, priceWmm, TYPE.pricePanelH);
  ctx.fillStyle = BRAND.red;
  ctx.fillRect(0, 0, priceWmm, TYPE.gradeCap + 46);

  ctx.fillStyle = BRAND.cream;
  ctx.font = `700 ${em(TYPE.gradeCap)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("REGULAR   UNLEADED", 64, TYPE.gradeCap + 22);

  // Numerals in the amber of a real price head rather than white, and the
  // trailing nine set small and raised, which is the single detail that makes a
  // US price sign a US price sign.
  ctx.fillStyle = "#e8b53c";
  ctx.font = `700 ${em(TYPE.priceCap)}px Arial, Helvetica, sans-serif`;
  const priceY = TYPE.gradeCap + 46 + (TYPE.pricePanelH - TYPE.gradeCap - 46) * 0.5 + TYPE.priceCap / 2;
  ctx.fillText("3.29", 64, priceY);
  const mainW = ctx.measureText("3.29").width;
  ctx.font = `700 ${em(TYPE.priceCap * 0.52)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("9", 64 + mainW + 22, priceY - TYPE.priceCap * 0.44);

  ctx.fillStyle = "#8f8b82";
  ctx.font = `600 ${em(TYPE.gradeCap * 0.82)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("CASH  PRICE  PER  GALLON", 64 + mainW + 210, priceY - 12);

  /* ---------------- column plate ---------------- */

  const plate: SignPanel = {
    w: TYPE.platePanelH / 1000,
    h: TYPE.platePanelH / 1000,
    uv: [
      REGION.plate.x / ATLAS.w,
      1 - (REGION.plate.y + REGION.plate.h) / ATLAS.h,
      (REGION.plate.x + REGION.plate.w) / ATLAS.w,
      1 - REGION.plate.y / ATLAS.h,
    ],
  };

  const tsx = REGION.plate.w / TYPE.platePanelH;
  ctx.setTransform(tsx, 0, 0, tsx, REGION.plate.x, REGION.plate.y);
  ctx.fillStyle = BRAND.cream;
  ctx.fillRect(0, 0, TYPE.platePanelH, TYPE.platePanelH);
  ctx.fillStyle = BRAND.red;
  ctx.fillRect(0, TYPE.platePanelH - 96, TYPE.platePanelH, 96);
  drawMark(ctx, TYPE.platePanelH / 2, TYPE.platePanelH * 0.42, TYPE.platePanelH * 0.44, BRAND.red);
  ctx.fillStyle = BRAND.cream;
  ctx.font = `700 ${em(TYPE.plateCap)}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(BRAND.name, TYPE.platePanelH / 2, TYPE.platePanelH - 96 / 2 + TYPE.plateCap / 2);
  ctx.textAlign = "left";

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  bleach(ctx, REGION.logo);
  bleach(ctx, REGION.plate);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return {
    texture,
    logo,
    price,
    plate,
    type: {
      elements: [
        { name: "wordmark", panel: "logo", capM: TYPE.wordCap / 1000 },
        { name: "mark", panel: "logo", capM: TYPE.markH / 1000 },
        { name: "sub-line", panel: "logo", capM: TYPE.subCap / 1000 },
        { name: "price-numerals", panel: "price", capM: TYPE.priceCap / 1000 },
        { name: "grade-label", panel: "price", capM: TYPE.gradeCap / 1000 },
        { name: "plate-wordmark", panel: "plate", capM: TYPE.plateCap / 1000 },
      ],
    },
  };
}

/**
 * The overflow stain that runs down the fascia below a scupper.
 *
 * A DataTexture rather than a canvas because this is the one element that needs
 * a real alpha channel, and a premultiplied canvas backing store cannot carry
 * one back out intact (NOTES case 1).
 *
 * The shape is keyed to what the water does: narrow and dark at the mouth,
 * fanning as it spreads across the band, and fading rather than stopping at the
 * bottom because the drip lip carries it away. The horizontal profile is a
 * ragged pair of edges from `fbm`, since a stain with a smooth boundary reads as
 * an airbrushed decal.
 */
export function makeOverflowStain(size = 128, seed = 5311): THREE.DataTexture {
  const w = size;
  const h = size;
  const rng = makeRng(seed);
  // `fbm` here is the field generator the rest of this project uses, sampled by
  // index rather than a point-noise function, so the stain shares its character
  // with the soffit bake and the lens map instead of introducing a fourth kind
  // of noise nobody can compare against.
  const rag = fbm(size, 5, rng, { octaves: 3 });
  const grainF = fbm(size, 19, rng, { octaves: 4 });
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    // 0 at the scupper mouth, 1 at the drip lip.
    const t = j / (h - 1);
    // Fans from 26% of the panel width at the mouth to 92% at the bottom.
    const half = 0.13 + 0.33 * Math.pow(t, 0.62);
    // Strong just below the mouth, then thinning as the water spreads out.
    const strength = Math.min(1, t * 5.5) * (1 - 0.55 * t) * (1 - Math.pow(t, 6));
    for (let i = 0; i < w; i++) {
      const u = i / (w - 1) - 0.5;
      const k = j * size + i;
      const wobble = 0.055 * (rag[k] - 0.5) * 2;
      const edge = 1 - Math.min(1, Math.abs(u) / Math.max(1e-4, half + wobble));
      const grain = 0.62 + 0.38 * grainF[k];
      const a = Math.max(0, Math.min(1, Math.pow(edge, 1.5) * strength * grain));
      const o = (j * w + i) * 4;
      // Sooty brown-grey; a black stain reads as a hole, not as dirt.
      data[o] = 46;
      data[o + 1] = 41;
      data[o + 2] = 36;
      data[o + 3] = Math.round(a * 235);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
