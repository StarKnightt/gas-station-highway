import * as THREE from "three";

/**
 * Diegetic graphics for the store: the illuminated fascia sign, window vinyl,
 * the cooler valance price rail, shelf price strips and the small statutory
 * signs.
 *
 * ## Why this is a whole module
 *
 * The building carried no typography anywhere, and an independent critic called
 * that the single largest gap in the set. It is not a decoration problem. A
 * real retail elevation is *mostly* type and colour blocking above eye level,
 * and a blank fascia band is one of the few things a viewer can name as wrong
 * without knowing anything about rendering. The same is true inside: a shelf
 * edge with no price strip and a cooler valance with no rail read as furniture,
 * not as a shop.
 *
 * All wording is invented. No real brands or marks anywhere in this project.
 *
 * ## Two rules carried in from elsewhere in this codebase
 *
 * **Premultiplied canvases (NOTES.md case 1).** A canvas backing store is
 * premultiplied, so writing partially transparent pixels and reading them back
 * corrupts the RGB channels — the defect that put white blooms across the
 * forecourt. Anything opaque is therefore drawn on a canvas created with
 * `alpha: false` and filled before use, exactly as `pumpDecals.ts` does; and
 * anything that genuinely needs transparency is assembled by `alphaTexture()`
 * below from **two** opaque canvases, one carrying colour and one carrying
 * coverage, into a `DataTexture`. Never read RGBA back out of one canvas.
 *
 * **Size the type to survive the mip chain.** The fascia is about 40 px tall
 * from the forecourt camera and the shelf strips are two or three. Type that
 * averages to grey does not read as small type, it reads as dirt (the same
 * failure that cost the masonry joints a round). So the fascia carries one
 * large word at a heavy weight, the strips carry value blocks rather than
 * glyphs, and nothing here relies on a stroke thinner than about a fiftieth of
 * the panel height.
 */

/* ------------------------------------------------------------------ */
/* canvas plumbing                                                      */
/* ------------------------------------------------------------------ */

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function opaqueCanvas(w: number, h: number, fill: string): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

function opaqueTexture(canvas: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * Assemble a transparent texture from two opaque canvases.
 *
 * `drawColour` paints the artwork on an opaque field; `drawCoverage` paints the
 * alpha channel in white-on-black. Both are read back separately, so no pixel
 * is ever read out of a premultiplied buffer — see the module note.
 *
 * A `DataTexture` needs its rows bottom-up, because row 0 is v = 0, which is
 * the bottom of the quad. The flip happens here so callers can draw in the
 * ordinary top-left canvas convention.
 */
function alphaTexture(
  w: number,
  h: number,
  drawColour: (c: CanvasRenderingContext2D) => void,
  drawCoverage: (c: CanvasRenderingContext2D) => void
): THREE.DataTexture {
  const colour = opaqueCanvas(w, h, "#000000");
  drawColour(colour.ctx);
  const cover = opaqueCanvas(w, h, "#000000");
  drawCoverage(cover.ctx);

  const cRgb = colour.ctx.getImageData(0, 0, w, h).data;
  const cA = cover.ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      data[dst + x] = cRgb[src + x];
      data[dst + x + 1] = cRgb[src + x + 1];
      data[dst + x + 2] = cRgb[src + x + 2];
      data[dst + x + 3] = cA[src + x];
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Letter-spaced text, which no canvas API offers portably. */
function tracked(c: CanvasRenderingContext2D, text: string, x: number, y: number, track: number): number {
  let cx = x;
  for (const ch of text) {
    c.fillText(ch, cx, y);
    cx += c.measureText(ch).width + track;
  }
  return cx - track - x;
}

function trackedWidth(c: CanvasRenderingContext2D, text: string, track: number): number {
  let w = 0;
  for (const ch of text) w += c.measureText(ch).width + track;
  return w - track;
}

/** Centre letter-spaced text on `cx`. */
function trackedCentred(c: CanvasRenderingContext2D, text: string, cx: number, y: number, track: number): void {
  tracked(c, text, cx - trackedWidth(c, text, track) / 2, y, track);
}

/**
 * Centred, tracked, and **backed off until it fits**.
 *
 * Canvas will draw a string straight past the edge of whatever you meant to
 * keep it inside and report nothing, so any headline whose text or box might
 * change wants measuring rather than a size chosen by eye. The weight is
 * assumed to be already set on the context; only the size is varied.
 */
function fitCentred(
  c: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxW: number,
  size: number,
  track: number
): void {
  let s = size;
  for (; s > 12; s -= 2) {
    c.font = `700 ${s}px Arial, Helvetica, sans-serif`;
    if (trackedWidth(c, text, track) <= maxW) break;
  }
  trackedCentred(c, text, cx, y, track);
}

/* ------------------------------------------------------------------ */
/* exterior                                                             */
/* ------------------------------------------------------------------ */

/** Real size of the fascia sign box, in metres. The texture matches it exactly.
 *  Getting the aspect wrong stretches the type, which is the kind of thing that
 *  reads as "CG" without a viewer being able to name it — the pump price head
 *  lost a round to precisely that. */
export const FASCIA_SIGN = { width: 7.6, height: 0.5, depth: 0.085 };

/**
 * The illuminated fascia sign box, hung on the four bracket stubs already
 * modelled on the storefront header.
 *
 * Designed for the roughly thirty pixels of height it measures from the
 * forecourt camera. That rules out a mark with internal detail and rules out a
 * third line of copy: one word at a heavy weight, one hard vertical value break
 * at the left, one horizontal rule, and colours that separate from both the
 * dark fascia band behind it and the dawn sky above it.
 */
export function makeFasciaSign(): THREE.CanvasTexture {
  const W = 2048;
  const H = Math.round((W * FASCIA_SIGN.height) / FASCIA_SIGN.width); // 135
  const { canvas, ctx: c } = opaqueCanvas(W, H, "#f4efe2");

  // Acrylic face, lit from behind by tubes: brighter across the middle, and
  // falling off into the retainer top and bottom.
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#e6e0d1");
  g.addColorStop(0.42, "#fbf8ef");
  g.addColorStop(1, "#dcd5c4");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // Deep field at the left carrying the mark; the type sits on the white. A
  // hard vertical break inside the panel is what survives the mip chain.
  const markW = W * 0.108;
  c.fillStyle = "#1d4f5e";
  c.fillRect(0, 0, markW, H);

  // Mark: a filled chevron over a bar. Big, flat, no interior detail.
  const mc = markW * 0.5;
  c.fillStyle = "#e8b433";
  c.beginPath();
  c.moveTo(mc, H * 0.16);
  c.lineTo(mc + markW * 0.34, H * 0.62);
  c.lineTo(mc + markW * 0.16, H * 0.62);
  c.lineTo(mc, H * 0.4);
  c.lineTo(mc - markW * 0.16, H * 0.62);
  c.lineTo(mc - markW * 0.34, H * 0.62);
  c.closePath();
  c.fill();
  c.fillRect(mc - markW * 0.34, H * 0.72, markW * 0.68, H * 0.13);

  c.textBaseline = "alphabetic";
  c.textAlign = "left";

  // The word itself. Everything else on this panel is subordinate to it.
  c.fillStyle = "#17323c";
  c.font = `700 ${Math.round(H * 0.44)}px Arial, Helvetica, sans-serif`;
  const nameW = tracked(c, "WAYPOINT", W * 0.145, H * 0.52, H * 0.05);

  c.fillStyle = "#9a3225";
  c.fillRect(W * 0.145, H * 0.6, nameW, H * 0.055);

  c.fillStyle = "#415056";
  c.font = `600 ${Math.round(H * 0.17)}px Arial, Helvetica, sans-serif`;
  tracked(c, "MARKET   FUEL   OPEN 24 HOURS", W * 0.147, H * 0.87, H * 0.03);

  // Age: the acrylic has chalked unevenly and there is a crack across one
  // corner. Without this the panel is the only spotless thing on the building.
  c.globalAlpha = 0.15;
  c.fillStyle = "#8a8172";
  for (let i = 0; i < 40; i++) {
    c.beginPath();
    c.ellipse((i * 617) % W, (i * 331) % H, 40 + ((i * 37) % 130), 8 + ((i * 19) % 26), 0, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
  c.strokeStyle = "rgba(60,58,52,0.45)";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(W * 0.955, 0);
  c.lineTo(W * 0.982, H * 0.55);
  c.lineTo(W * 0.962, H);
  c.stroke();

  return opaqueTexture(canvas);
}

/**
 * Window vinyl for the storefront: the hours panel, a payment/ATM block and a
 * couple of small statutory notices. One texture, applied to one quad per
 * decal via a sub-rectangle of the UV range.
 *
 * Transparent, so it goes through `alphaTexture`.
 */
export interface VinylSheet {
  /** `DataTexture` for cut vinyl, `CanvasTexture` for opaque printed paper. */
  texture: THREE.Texture;
  /** Named sub-rectangles in UV space: [u0, v0, u1, v1]. */
  cells: Record<string, [number, number, number, number]>;
  /** Real-world aspect (width / height) of each cell, for sizing the quad. */
  aspect: Record<string, number>;
}

export function makeWindowVinyl(): VinylSheet {
  const W = 1024;
  const H = 1024;

  // Four cells on a 2 x 2 grid. Laid out with a margin inside each cell so the
  // mip chain cannot bleed one decal into its neighbour.
  const cells: VinylSheet["cells"] = {
    hours: [0.0, 0.5, 0.5, 1.0],
    payment: [0.5, 0.5, 1.0, 1.0],
    open: [0.0, 0.0, 0.5, 0.5],
    notice: [0.5, 0.0, 1.0, 0.5],
  };
  const aspect: VinylSheet["aspect"] = { hours: 1, payment: 1, open: 1, notice: 1 };

  const draw = (c: CanvasRenderingContext2D, mono: boolean) => {
    const ink = (light: string) => (mono ? "#ffffff" : light);
    c.textBaseline = "alphabetic";
    c.textAlign = "left";

    /* --- hours, top left cell: white cut vinyl --- */
    const hx = 40;
    const hy = 40;
    c.fillStyle = ink("#f2f0e8");
    c.font = "700 62px Arial, Helvetica, sans-serif";
    trackedCentred(c, "STORE HOURS", hx + 216, hy + 92, 3);
    c.fillRect(hx + 40, hy + 118, 372, 5);
    const rows: Array<[string, string]> = [
      ["MON - FRI", "5:00 - 23:00"],
      ["SATURDAY", "5:30 - 23:00"],
      ["SUNDAY", "6:00 - 22:00"],
      ["HOLIDAYS", "7:00 - 21:00"],
    ];
    /**
     * The two columns are measured and fitted rather than assumed. At 46 px in
     * a 352 px column, "SATURDAY" and "5:30 - 23:00" together need about 400
     * and the `door` capture duly read "SATURDAYA0 - 23:00". A canvas will
     * happily draw text over other text and report nothing, so the width is
     * checked here and the size backed off until both columns fit with a gap.
     */
    const colL = hx + 40;
    const colR = hx + 412;
    let size = 44;
    const widest = (fs: number) => {
      c.font = `600 ${fs}px Arial, Helvetica, sans-serif`;
      return Math.max(...rows.map(([a, b]) => c.measureText(a).width + c.measureText(b).width));
    };
    while (size > 24 && widest(size) > colR - colL - 34) size -= 2;
    c.font = `600 ${size}px Arial, Helvetica, sans-serif`;
    rows.forEach(([a, b], i) => {
      const y = hy + 192 + i * 62;
      c.textAlign = "left";
      c.fillText(a, colL, y);
      c.textAlign = "right";
      c.fillText(b, colR, y);
    });
    c.textAlign = "left";

    /* --- payment block, top right --- */
    const px = 552;
    const py = 40;
    c.fillStyle = ink("#e9e6dc");
    c.font = "700 54px Arial, Helvetica, sans-serif";
    trackedCentred(c, "WE ACCEPT", px + 216, py + 82, 4);
    // Card shapes rather than marks: flat rounded rectangles with a stripe.
    for (let i = 0; i < 4; i++) {
      const bx = px + 34 + (i % 2) * 200;
      const by = py + 128 + Math.floor(i / 2) * 132;
      c.fillStyle = ink(["#c8ccd2", "#d6c8a8", "#bcd0c4", "#d2c0c4"][i]);
      c.beginPath();
      c.roundRect(bx, by, 168, 106, 12);
      c.fill();
      c.fillStyle = mono ? "#ffffff" : "rgba(30,32,36,0.55)";
      c.fillRect(bx, by + 26, 168, 22);
    }
    c.fillStyle = ink("#e9e6dc");
    c.font = "600 34px Arial, Helvetica, sans-serif";
    trackedCentred(c, "ATM INSIDE", px + 216, py + 424, 6);

    /* --- open block, bottom left: a red-and-white banner --- */
    const ox = 40;
    const oy = 552;
    c.fillStyle = ink("#a8352a");
    c.beginPath();
    c.roundRect(ox + 16, oy + 96, 400, 232, 16);
    c.fill();
    c.fillStyle = mono ? "#ffffff" : "#f6f1e4";
    c.font = "700 128px Arial, Helvetica, sans-serif";
    trackedCentred(c, "OPEN", ox + 216, oy + 226, 10);
    c.font = "700 46px Arial, Helvetica, sans-serif";
    trackedCentred(c, "24 HOURS", ox + 216, oy + 292, 8);

    /* --- notice, bottom right: a small dense paragraph block --- */
    const nx = 552;
    const ny = 552;
    c.fillStyle = ink("#dedbd0");
    c.font = "700 40px Arial, Helvetica, sans-serif";
    trackedCentred(c, "NOTICE", nx + 216, ny + 78, 6);
    // Deliberately not letterforms: at the size this is ever seen, real words
    // average to a grey smear. Ruled lines of the right value read as a block
    // of small print and cost nothing.
    for (let i = 0; i < 9; i++) {
      const y = ny + 118 + i * 30;
      const w = 320 - ((i * 71) % 110);
      c.fillRect(nx + 48, y, w, 9);
    }
    c.fillRect(nx + 48, ny + 400, 180, 12);
  };

  return {
    texture: alphaTexture(
      W,
      H,
      (c) => draw(c, false),
      (c) => draw(c, true)
    ),
    cells,
    aspect,
  };
}

/* ------------------------------------------------------------------ */
/* interior                                                             */
/* ------------------------------------------------------------------ */

/**
 * The cooler valance: the lit strip above the doors that carries the category
 * headings and the promotional price. Long and thin — 7.04 x 0.17 m, i.e. 41:1
 * — so it is drawn as one wide strip and tiled once across the run.
 */
export function makeCoolerValance(doors: number): THREE.CanvasTexture {
  const W = 4096;
  const H = 104;
  const { canvas, ctx: c } = opaqueCanvas(W, H, "#1a2b33");

  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#24404b");
  g.addColorStop(1, "#12222a");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  const bay = W / doors;
  const headings = ["SODA", "WATER", "ENERGY", "JUICE", "TEA", "SPORTS", "DAIRY", "BEER"];
  c.textBaseline = "middle";
  for (let i = 0; i < doors; i++) {
    // Mullion shadow between bays, so the strip reads as segmented like the
    // cabinet under it rather than as one continuous banner.
    c.fillStyle = "rgba(0,0,0,0.45)";
    c.fillRect(i * bay - 3, 0, 6, H);
    c.fillStyle = "#eef3f4";
    c.font = `700 ${Math.round(H * 0.44)}px Arial, Helvetica, sans-serif`;
    trackedCentred(c, headings[i % headings.length], (i + 0.5) * bay, H * 0.5, H * 0.06);
  }
  // A promotional flash taped over two bays, slightly out of square.
  c.save();
  c.translate(bay * 2.05, H * 0.06);
  c.rotate(-0.014);
  c.fillStyle = "#c8b23a";
  c.fillRect(0, 0, bay * 1.9, H * 0.88);
  c.fillStyle = "#22201a";
  c.font = `700 ${Math.round(H * 0.46)}px Arial, Helvetica, sans-serif`;
  c.textAlign = "center";
  c.fillText("2 FOR $4", bay * 0.95, H * 0.46);
  c.restore();
  c.textAlign = "left";

  return opaqueTexture(canvas);
}

/**
 * Shelf-edge price strips, as one horizontal tile.
 *
 * These are two or three pixels tall in frame, so this is not typography — it
 * is a value rhythm. A white ground, a repeating dark tick where each label's
 * price sits, and an occasional yellow promotional tag. That reads as "priced
 * shelf" at a distance where actual numerals would read as noise, which is the
 * lesson from the masonry joints applied to something much smaller.
 */
export function makeShelfStrip(seed = 17): THREE.CanvasTexture {
  const W = 1024;
  const H = 32;
  const { canvas, ctx: c } = opaqueCanvas(W, H, "#efece2");

  c.fillStyle = "rgba(0,0,0,0.22)";
  c.fillRect(0, 0, W, 4);
  c.fillStyle = "rgba(0,0,0,0.13)";
  c.fillRect(0, H - 3, W, 3);

  let x = 6;
  let n = seed;
  const next = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff), n / 0x7fffffff);
  while (x < W - 20) {
    const w = 34 + Math.floor(next() * 40);
    const promo = next() < 0.14;
    if (promo) {
      c.fillStyle = "#d8c243";
      c.fillRect(x, 4, w, H - 8);
      c.fillStyle = "#332f22";
    } else {
      c.fillStyle = "#2c2c2c";
    }
    // The price block, and a shorter description line above it.
    c.fillRect(x + 4, H * 0.5, w * 0.52, H * 0.3);
    c.globalAlpha = 0.55;
    c.fillRect(x + 4, H * 0.22, w * 0.78, H * 0.16);
    c.globalAlpha = 1;
    // Card divider.
    c.fillStyle = "rgba(120,116,106,0.6)";
    c.fillRect(x + w + 1, 3, 1.5, H - 6);
    x += w + 4;
  }

  const t = opaqueTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/**
 * Small statutory and wayfinding signs, on one sheet: EXIT over the door,
 * RESTROOM on the back wall, an employees-only door plate, and a no-smoking
 * roundel for the forecourt side of the glass.
 */
export function makeSignPlates(): VinylSheet {
  const W = 1024;
  const H = 512;
  const cells: VinylSheet["cells"] = {
    exit: [0.0, 0.5, 0.5, 1.0],
    restroom: [0.5, 0.5, 1.0, 1.0],
    employees: [0.0, 0.0, 0.5, 0.5],
    nosmoking: [0.5, 0.0, 1.0, 0.5],
  };
  const aspect: VinylSheet["aspect"] = { exit: 2, restroom: 2, employees: 2, nosmoking: 2 };

  const draw = (c: CanvasRenderingContext2D, mono: boolean) => {
    c.textBaseline = "middle";
    c.textAlign = "center";

    /* exit: white on green, the one sign in a store that is always lit */
    c.fillStyle = mono ? "#ffffff" : "#1c6b3a";
    c.fillRect(16, 16, 480, 224);
    c.fillStyle = mono ? "#ffffff" : "#f0f6f0";
    c.font = "700 128px Arial, Helvetica, sans-serif";
    c.fillText("EXIT", 256, 132);

    /* restroom */
    c.fillStyle = mono ? "#ffffff" : "#d9d5c8";
    c.fillRect(528, 16, 480, 224);
    c.fillStyle = mono ? "#ffffff" : "#2a2823";
    c.font = "700 74px Arial, Helvetica, sans-serif";
    c.fillText("RESTROOM", 768, 116);
    c.font = "600 40px Arial, Helvetica, sans-serif";
    c.fillText("ASK FOR KEY", 768, 182);

    /* employees only door plate */
    c.fillStyle = mono ? "#ffffff" : "#b9b4a6";
    c.fillRect(16, 272, 480, 224);
    c.fillStyle = mono ? "#ffffff" : "#26241f";
    c.font = "700 62px Arial, Helvetica, sans-serif";
    c.fillText("EMPLOYEES", 256, 356);
    c.fillText("ONLY", 256, 424);

    /* no smoking roundel */
    if (mono) {
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(768, 384, 108, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillStyle = "#f4f1e8";
      c.beginPath();
      c.arc(768, 384, 108, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "#b0322a";
      c.lineWidth = 20;
      c.beginPath();
      c.arc(768, 384, 92, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#3a3833";
      c.fillRect(716, 374, 96, 16);
      c.beginPath();
      c.arc(768, 384, 92, Math.PI * 0.75, Math.PI * 0.95);
      c.stroke();
    }
  };

  return {
    texture: alphaTexture(
      W,
      H,
      (c) => draw(c, false),
      (c) => draw(c, true)
    ),
    cells,
    aspect,
  };
}

/**
 * The taped paper notices on the inside of the glass.
 *
 * These existed as geometry with a flat colour and an explicit note that they
 * carried no content, on the reasoning that a label you can nearly read is
 * worse than none. That is the right instinct and it produced the wrong
 * object: `tools/probe-pixel.mjs` identified the 0.30 x 0.42 m one as the
 * blank cream rectangle dominating the west half of the `door` capture, at
 * about 130 x 190 px of absolutely nothing. A blank sheet of paper is not the
 * neutral choice — it is a conspicuous one.
 *
 * The resolution is to print value structure and no letterforms at all: a
 * heading band, a dark photograph block, ruled body lines, and — on one of
 * them — the row of tear-off tabs along the bottom that is the single most
 * recognisable silhouette a taped notice has. Every one of those survives the
 * mip chain because each is a large block of clearly separated value, and none
 * of them can be "nearly read" because there is nothing there to read.
 *
 * Opaque, because paper is: this goes through `opaqueTexture`, not
 * `alphaTexture`.
 */
export function makeWindowNotices(): VinylSheet {
  const W = 1024;
  const H = 1024;
  const cells: VinylSheet["cells"] = {
    hiring: [0.0, 0.5, 0.5, 1.0],
    tabs: [0.5, 0.5, 1.0, 1.0],
    card: [0.0, 0.0, 0.5, 0.5],
    community: [0.5, 0.0, 1.0, 0.5],
  };
  const aspect: VinylSheet["aspect"] = { hiring: 0.72, tabs: 0.72, card: 1.4, community: 0.78 };

  const { canvas, ctx: c } = opaqueCanvas(W, H, "#cdc6b4");
  const C = 512;
  const paper = ["#e4dfd0", "#dcd6c6", "#e8e3d6", "#d9d3c2"];

  for (let i = 0; i < 4; i++) {
    const ox = (i % 2) * C;
    const oy = Math.floor(i / 2) * C;
    c.save();
    c.beginPath();
    c.rect(ox, oy, C, C);
    c.clip();
    c.translate(ox, oy);

    // The sheet, inset so no cell runs to its own boundary.
    const m = 26;
    c.fillStyle = paper[i];
    c.fillRect(m, m, C - m * 2, C - m * 2);

    const ink = "#3a3730";
    const soft = "rgba(58,55,48,0.5)";

    if (i === 0) {
      /**
       * Hiring notice. The masthead and the call to action are **set in real
       * letterforms**; only the body copy stays as ruled lines.
       *
       * The previous version was ruled lines throughout, on the stated
       * reasoning that "at the size this is ever seen, real words average to a
       * grey smear". That reasoning is correct for the body and wrong for the
       * masthead, and the difference is arithmetic rather than taste. This cell
       * is 512 px square and the `door` pose renders it 133 px wide, so a
       * 74 px masthead lands on 19 px of screen — several times what a capital
       * needs — while a 15 px body line lands on 3.9 px, which is a smear
       * whatever is drawn in it. An independent critic reviewing frames with no
       * source called this "grey placeholder bars where content should be",
       * and in a photorealism target placeholder content reads as an
       * unfinished asset rather than as a shabby poster.
       *
       * Same shape as the packaging-resolution finding: work out the on-screen
       * size of the mark, then decide what can live there. It is not one answer
       * per texture — it is one answer per element.
       */
      c.fillStyle = ink;
      // Fit to the sheet rather than trusting a chosen size. The first attempt
      // set 86 px flat and the `door` capture read "NOW HIRING" with the N and
      // the G cut off by the paper edge - the same failure the store-hours
      // block above already guards against, one function away.
      fitCentred(c, "NOW HIRING", C / 2, m + 118, C - m * 2 - 40, 86, 3);
      c.fillStyle = ink;
      c.fillRect(m + 46, m + 140, C - m * 2 - 92, 6);
      c.fillStyle = soft;
      for (let r = 0; r < 7; r++) c.fillRect(m + 46, m + 190 + r * 34, C - m * 2 - 92 - ((r * 53) % 120), 15);
      // Reversed-out call to action, which is what an application line always is.
      c.fillStyle = ink;
      c.fillRect(m + 46, C - m - 104, C - m * 2 - 92, 62);
      c.fillStyle = paper[i];
      fitCentred(c, "APPLY WITHIN", C / 2, C - m - 60, C - m * 2 - 116, 40, 4);
    } else if (i === 1) {
      // Lost-pet flyer: a heading, a dark photo block, and tear-off tabs. The
      // heading is 56 px in a cell rendered around 115 px wide, i.e. 13 px on
      // screen - short enough for two heavy words and nothing more.
      c.fillStyle = ink;
      fitCentred(c, "LOST DOG", C / 2, m + 90, C - m * 2 - 40, 62, 2);
      c.fillStyle = "#4e4a41";
      c.fillRect(m + 62, m + 122, C - m * 2 - 124, 190);
      c.fillStyle = soft;
      for (let r = 0; r < 3; r++) c.fillRect(m + 62, m + 336 + r * 30, C - m * 2 - 124 - r * 40, 13);
      // Tabs: the cuts between them are what makes the silhouette read.
      const tabTop = C - m - 106;
      c.fillStyle = "#0000001a";
      c.fillRect(m, tabTop - 6, C - m * 2, 6);
      for (let t = 0; t < 7; t++) {
        const tw = (C - m * 2) / 7;
        c.fillStyle = "rgba(90,86,76,0.85)";
        c.fillRect(m + t * tw + tw - 3, tabTop, 3, 100);
        c.fillStyle = soft;
        c.fillRect(m + t * tw + 7, tabTop + 30, tw - 20, 11);
      }
    } else if (i === 2) {
      // Landscape card: ATM surcharge. One number, large, which is the only
      // thing anybody reads off one of these.
      c.fillStyle = ink;
      fitCentred(c, "ATM", C / 2, m + 132, C - m * 2 - 60, 82, 6);
      fitCentred(c, "$2.50", C / 2, m + 240, C - m * 2 - 60, 104, 2);
      c.fillStyle = soft;
      c.fillRect(m + 34, m + 288, C - m * 2 - 190, 22);
      c.fillRect(m + 34, m + 324, C - m * 2 - 280, 22);
    } else {
      // Community card: bordered, a block of small print, a stamp corner.
      c.strokeStyle = ink;
      c.lineWidth = 9;
      c.strokeRect(m + 34, m + 34, C - m * 2 - 68, C - m * 2 - 68);
      c.fillStyle = soft;
      for (let r = 0; r < 10; r++) c.fillRect(m + 66, m + 108 + r * 32, C - m * 2 - 132 - ((r * 67) % 130), 13);
      c.fillStyle = ink;
      c.fillRect(C - m - 130, C - m - 118, 88, 66);
    }

    /**
     * Tape at the top corners.
     *
     * This existed already, as two 40%-white rectangles on cream paper — a
     * contrast of about four values, which is invisible at any distance, and a
     * critic reading the frames said the notice hung "with no visible mount".
     * A mount that cannot be seen is not a mount; it is a comment.
     *
     * What makes tape read is not brightness but **edges**: a strip of matt
     * tape is a hard-edged rectangle slightly lighter than paper and slightly
     * darker than glass, set at an angle to everything around it, with a
     * definite boundary at each end. So it is now angled, given a darker edge
     * line where it crosses the paper margin, and run past the sheet edge on
     * to the glass, which is where the top half of a taped corner actually is.
     */
    for (const [tx, rot] of [
      [m + 30, -0.22],
      [C - m - 122, 0.19],
    ] as const) {
      c.save();
      c.translate(tx + 46, m + 2);
      c.rotate(rot);
      c.fillStyle = "rgba(246,244,236,0.62)";
      c.fillRect(-58, -22, 116, 40);
      c.strokeStyle = "rgba(70,66,58,0.30)";
      c.lineWidth = 2.5;
      c.strokeRect(-58, -22, 116, 40);
      // The stretched, slightly milkier core a strip of tape has down its middle.
      c.fillStyle = "rgba(255,255,255,0.22)";
      c.fillRect(-58, -12, 116, 12);
      c.restore();
    }
    const sh = c.createLinearGradient(0, C - m - 60, 0, C - m);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.14)");
    c.fillStyle = sh;
    c.fillRect(m, C - m - 60, C - m * 2, 60);

    c.restore();
  }

  return { texture: opaqueTexture(canvas), cells, aspect };
}

/**
 * The face of a 2 x 4 prismatic lens, as an emissive modulation map.
 *
 * The lens was a single flat value and clipped: 1.30% of the upper half of the
 * `interior` frame was within one code of pure white, in hard-edged rectangles.
 * A critic called the panels "blown to flat pure white with no falloff onto the
 * tile around them" and named it one of the strongest game tells in the set.
 *
 * Two separate faults are bundled in that sentence and only one of them is
 * Building's. **The falloff onto the tile is light**, and belongs to whoever
 * owns the fittings; a fitting that emits nothing onto the ceiling it is set
 * into cannot be fixed from the material. **The flat clipped face is
 * appearance**, and is this. A real prismatic lens is never one value: it is
 * brightest over each tube, dips in the gap between them, and falls off hard
 * into the pan on all four sides, and the prisms put a faint grid over the lot.
 *
 * Deliberately a *modulation* map rather than a level. three multiplies the
 * emissive map into `totalEmissiveRadiance`, so Lighting keeps ownership of
 * `emissiveIntensity` — the one number that decides whether these clip — and
 * this only decides the shape of what is inside them. Peak sits at 1.0 so the
 * change cannot brighten anything; every other texel can only come down.
 */
export function makeTrofferLens(): THREE.Texture {
  const W = 96;
  const H = 192;
  const { canvas, ctx: c } = opaqueCanvas(W, H, "#000000");
  const img = c.createImageData(W, H);
  // Two T8 tubes, at a quarter and three quarters across the short axis.
  const tubes = [0.27, 0.73];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / H;
      let lamp = 0;
      for (const t of tubes) {
        const d = (u - t) / 0.2;
        lamp = Math.max(lamp, Math.exp(-d * d));
      }
      /**
       * Depth chosen against the **tone curve**, not against the texture.
       *
       * The first version ran 0.60 to 1.00 with a perimeter floor of 0.45, and
       * the capture was indistinguishable from the flat lens it replaced. It
       * had not failed to bind: Lighting drives these at `emissiveIntensity`
       * 2.4, so a 0.45 floor is still 1.08 in scene-referred linear, and
       * everything from about 1.0 upward tone-maps into the top couple of
       * codes. A modulation map is only visible where the product lands on a
       * part of the curve that still has slope in it, which for this fitting
       * means **below roughly 0.4 of full** — and 0.45 was just above the line.
       * Generalises: authoring a subtle map for an emitter whose intensity you
       * do not own is authoring against a curve you have to go and read.
       *
       * The values are not a compromise with physics. A prismatic lens really
       * is strongly striped over a two-tube pan, and it really does tuck under
       * the flange and go dark at the perimeter; the flat panel was the
       * unphysical one.
       */
      let g = 0.42 + 0.58 * lamp;
      // Fall into the pan on all four edges. The short axis falls harder
      // because the frame is closer to the tubes there.
      const eu = Math.min(u, 1 - u);
      const ev = Math.min(v, 1 - v);
      g *= 0.1 + 0.9 * Math.min(1, Math.pow(Math.min(1, eu / 0.22), 0.7));
      g *= 0.1 + 0.9 * Math.min(1, Math.pow(Math.min(1, ev / 0.12), 0.7));
      // Prism grid: shallow, and finer along the tube than across it.
      g *= 1 - 0.05 * (0.5 - 0.5 * Math.cos(u * Math.PI * 2 * 9));
      g *= 1 - 0.04 * (0.5 - 0.5 * Math.cos(v * Math.PI * 2 * 26));
      // sRGB, because this multiplies a colour the renderer decodes as sRGB.
      const s = Math.round(255 * Math.pow(Math.min(1, Math.max(0, g)), 1 / 2.2));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = s;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return opaqueTexture(canvas);
}

/* ------------------------------------------------------------------ */
/* packaging                                                            */
/* ------------------------------------------------------------------ */

/** Cells across and down the packaging atlas. */
export const PACK_GRID = 4;
const PACK_CELLS = PACK_GRID * PACK_GRID;

/**
 * The sheet is split rather than grown. Cells 0..11 are shelf packaging —
 * cartons, bags, boxed goods — and cells 12..15 are drinks wrap labels, which
 * need a completely different layout: artwork in a band with plain margins
 * above and below it, because a bottle's neck and base are not printed.
 *
 * Splitting an existing 1024 sheet rather than authoring a second one is
 * deliberate. The store interior is the project's largest texture consumer and
 * a second atlas here would have cost 5.6 MB with mips for four designs.
 */
export const PACK_CARTON_CELLS = 12;
export const PACK_BOTTLE_CELL0 = 12;
export const PACK_BOTTLE_CELLS = PACK_CELLS - PACK_BOTTLE_CELL0;

/**
 * The plain margin at the top and bottom of a bottle cell, as a fraction of
 * the cell. `applyBottleLabel` clamps the neck and the base into these, so they
 * have to be flat: anything drawn here would be smeared up the neck of every
 * bottle in the cooler.
 */
const BOTTLE_MARGIN = 0.1;

/**
 * Smallest feature allowed on this sheet, as a fraction of a cell.
 *
 * Measured, not guessed. `tools/probe-facings.mjs` ray-casts the visible
 * product pixels and reports **23 px per facing in the `interior` pose** at
 * about 11 atlas texels per screen pixel — mip level 3 to 4, where a 256 px
 * cell is resolved as roughly 16 x 16. An element thinner than a sixteenth of
 * the cell is therefore *sub-texel at the mip actually sampled* and averages
 * into its neighbour; a 1/28 highlight (which this sheet used to carry) does
 * not become subtle at that distance, it becomes nothing.
 *
 * A twelfth is the working figure — 1.3 texels at that mip, so it survives as
 * a value step even after the box filter — and the budget is about **seven
 * distinguishable marks** per facing, which is what 16 rows of resolved texels
 * can hold with a light and a dark either side of each edge.
 */
const MIN_MARK = 1 / 12;

/**
 * Printed packaging, as a 4 x 4 atlas of generic package fronts.
 *
 * ## Greyscale on purpose
 *
 * The product on these shelves is vertex-coloured from a palette that was
 * carefully weighted toward neutrals, and that palette is worth keeping. So
 * this sheet carries **structure and value only** — bands, a light logo block,
 * a rule, a window panel — on a near-white ground, and the existing vertex
 * colour multiplies through it. Nothing here decides what colour a packet is;
 * it decides that a packet has a top, a bottom and something printed between
 * them. A flat facing and a printed facing differ by exactly that, and it is
 * the single largest thing separating this interior from a photograph: a shelf
 * of solid colour blocks is the oldest tell in real-time rendering.
 *
 * ## Sized for four pixels, not forty
 *
 * A facing is 20 to 60 px tall in the poses that matter and often much less, so
 * every cell is built from three or four bands of clearly separated value with
 * no element below about a twelfth of the cell. Type would be dishonest here —
 * it would average to grey and read as dirt, which is the mistake the masonry
 * joints already paid for. There are no letterforms on this sheet at all.
 *
 * Cell means are deliberately kept within a narrow band of each other. Four
 * mip levels down an atlas cell bleeds into its neighbours no matter how it is
 * padded, and if the cells disagree about value that bleed shows up as facings
 * that change brightness with distance.
 */
/**
 * ### The hero bottle's label, and why it is not a cell of the packaging atlas
 *
 * Every other label in this building is a 256 px cell of a shared 1024 sheet,
 * because every other label is delivered at 23 to 40 px and a cell is already
 * more resolution than that can use. The handheld bottle is the one object in
 * this project that is **inspected** rather than seen: it rides at 0.44 m from
 * the camera in `InteractionSystem`'s hand pose, and it is going into a
 * 15-second video where it fills a large part of the frame.
 *
 * The budget, worked out in delivered pixels the way the poster taught:
 *
 * | element | canvas px | delivered px |
 * | --- | --- | --- |
 * | label band, full height | 384 | ~410 |
 * | brand masthead | 118 | ~126 |
 * | descriptor line | 46 | ~49 |
 * | volume mark | 34 | ~36 |
 * | nutrition body line | 15 | ~16 |
 *
 * So the masthead and the descriptor get **real letterforms**, and the fine
 * print gets **ruled lines**, at exactly the boundary where letterforms stop
 * being resolvable. That split is the per-element rule: legibility belongs to
 * the individual element measured in delivered pixels, not to the texture.
 *
 * 768 x 384 wraps a 0.22 m circumference at 0.1 m tall, so the readable central
 * third carries about 1.4 texels per delivered pixel — slightly oversampled,
 * which is the right side to err on for a surface that will be moving. 1.5 MB
 * with mips, spent on the single most-looked-at object in the scene.
 */
export function makeHeroBottleLabel(): THREE.CanvasTexture {
  const W = 768;
  const H = 384;
  const { canvas, ctx: c } = opaqueCanvas(W, H, "#f2efe6");

  // The wrap is two halves: the front face (u 0..0.5) carries the brand, the
  // back (u 0.5..1) carries the panel you would read if you turned it round.
  // A sleeve printed identically all the way round is a tell — it means the
  // object has no front.
  const FRONT = W * 0.5;

  /* --- front --- */
  // A colour field across the upper half, held off the edges so the PET shows
  // above and below it: a label is a band on a bottle, not a paint job.
  const grad = c.createLinearGradient(0, 40, 0, 214);
  grad.addColorStop(0, "#1f5f8f");
  grad.addColorStop(1, "#14486e");
  c.fillStyle = grad;
  c.fillRect(0, 40, FRONT, 174);

  // A wave, which is what every water brand puts on a bottle, and which also
  // breaks the two hard horizontals the field would otherwise have.
  c.fillStyle = "#5fa9cf";
  c.beginPath();
  c.moveTo(0, 196);
  for (let x = 0; x <= FRONT; x += 8) {
    c.lineTo(x, 196 + Math.sin((x / FRONT) * Math.PI * 3.1) * 13);
  }
  c.lineTo(FRONT, 214);
  c.lineTo(0, 214);
  c.closePath();
  c.fill();

  c.fillStyle = "#ffffff";
  c.textBaseline = "alphabetic";
  /**
   * 0.56 of the panel, not 0.86, and the reason is curvature rather than taste.
   * A cylinder shows about 180 degrees, but only the middle 120 or so is
   * legible — beyond that the texels compress toward the silhouette faster than
   * any anisotropy setting recovers. So the readable width of a wrap is roughly
   * a third of its circumference, and a masthead authored to the panel's full
   * width puts its first and last letters exactly where they cannot be read.
   * This is the per-element resolution rule with a second term: legibility is
   * per element measured in delivered pixels, **and on a curved surface the
   * delivered pixels are not evenly distributed across the artwork.**
   */
  fitCentred(c, "CLEARSPRING", FRONT * 0.5, 152, FRONT * 0.56, 112, 1);
  c.fillStyle = "#cfe6f4";
  fitCentred(c, "STILL MINERAL WATER", FRONT * 0.5, 194, FRONT * 0.5, 46, 2);

  // Volume, on the PET below the field.
  c.fillStyle = "#1f5f8f";
  c.font = "700 34px Arial, Helvetica, sans-serif";
  trackedCentred(c, "500 mL", FRONT * 0.5, 258, 2);

  /* --- back panel --- */
  c.fillStyle = "#ffffff";
  c.fillRect(FRONT + 18, 46, FRONT - 60, 300);
  c.strokeStyle = "#c9c3b4";
  c.lineWidth = 2;
  c.strokeRect(FRONT + 18, 46, FRONT - 60, 300);

  c.fillStyle = "#20303a";
  c.font = "700 30px Arial, Helvetica, sans-serif";
  c.fillText("NUTRITION", FRONT + 40, 84);
  // Ruled lines from here down: at 15 canvas px a glyph delivers about 16 px
  // and would be a grey smear, which is worse than an honest rule because a
  // smear reads as a texture bug while a rule reads as small print.
  c.fillStyle = "#5c6a72";
  for (let i = 0; i < 11; i++) {
    const y = 104 + i * 18;
    const w = (FRONT - 96) * (0.42 + ((i * 37) % 11) / 22);
    c.fillRect(FRONT + 40, y, w, 6);
    // A right-aligned value column, so the block reads as a table.
    c.fillRect(FRONT + FRONT - 108, y, 44, 6);
  }
  c.fillStyle = "#20303a";
  c.fillRect(FRONT + 40, 100, FRONT - 96, 3);
  c.fillRect(FRONT + 40, 302, FRONT - 96, 3);

  // Barcode. Real bar widths, because an even comb is the thing that makes a
  // fake barcode obvious even at 20 px.
  let bx = FRONT + 44;
  c.fillStyle = "#101418";
  for (let i = 0; bx < FRONT + FRONT - 150; i++) {
    const w = 3 + ((i * 7919) % 4) * 2;
    c.fillRect(bx, 314, w, 26);
    bx += w + 3 + ((i * 104729) % 3);
  }
  // Recycling mark: a triangle and a resin code, both of which every PET
  // bottle carries and neither of which needs to be readable to be right.
  c.strokeStyle = "#3a4a52";
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(FRONT + FRONT - 96, 314);
  c.lineTo(FRONT + FRONT - 62, 314);
  c.lineTo(FRONT + FRONT - 79, 342);
  c.closePath();
  c.stroke();

  // Print registration is never perfect on a wrap: a hair of misalignment at
  // the seam is one of the quieter reasons a real label looks real.
  c.fillStyle = "rgba(0,0,0,0.10)";
  c.fillRect(FRONT - 3, 40, 3, 174);

  return opaqueTexture(canvas);
}

export function makeProductLabels(debugCheck = false): THREE.CanvasTexture {
  const S = 1024;
  const C = S / PACK_GRID;
  const { canvas, ctx: c } = opaqueCanvas(S, S, "#e9e5dc");

  if (debugCheck) {
    // Forced-value build for the region diff that proves this map is sampled
    // at all. Deliberately violent: if a shelf does not change under this, the
    // map is not reaching the product shader and no amount of art will help.
    for (let i = 0; i < PACK_CELLS; i++) {
      c.fillStyle = i % 2 ? "#ff00ff" : "#003c00";
      c.fillRect((i % PACK_GRID) * C, Math.floor(i / PACK_GRID) * C, C, C);
    }
    return opaqueTexture(canvas);
  }

  let n = 20260828;
  const rnd = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff), n / 0x7fffffff);
  /**
   * Values are clamped to a floor of 0.42 rather than allowed to run to black.
   * The vertex palette already contains genuinely dark packaging (0x25231f is
   * in it), and a 0.3 map under a 0.14 albedo is a facing at 4/255 — measured
   * on the first build of this sheet, which put the minimum of the whole
   * foreground shelf region at 0. A dark packet should be dark; it should not
   * be the absence of a packet. The map's job is the printing, and the palette
   * decides how dark the print is.
   */
  const grey = (v: number) => {
    const k = Math.max(0.42, Math.min(1, v));
    return `rgb(${Math.round(k * 255)},${Math.round(k * 250)},${Math.round(k * 242)})`;
  };

  for (let i = 0; i < PACK_CELLS; i++) {
    const ox = (i % PACK_GRID) * C;
    const oy = Math.floor(i / PACK_GRID) * C;
    c.save();
    c.beginPath();
    c.rect(ox, oy, C, C);
    c.clip();
    c.translate(ox, oy);

    // Ground. Varies a little cell to cell so a run of facings is not one wash.
    const ground = 0.82 + rnd() * 0.16;
    c.fillStyle = grey(ground);
    c.fillRect(0, 0, C, C);

    if (i >= PACK_BOTTLE_CELL0) {
      /**
       * Drinks wrap label. Canvas y runs down and UV v runs up, so the top of
       * the cell is the top of the bottle: the margins here become the neck
       * and the base, and they stay flat on purpose.
       *
       * These read at 360 degrees round the bottle, of which the camera sees
       * about 40%, so the artwork is horizontal banding — a vertical element
       * would be visible on one bottle and hidden on the next standing 30
       * degrees round.
       */
      const m = BOTTLE_MARGIN * C;
      const lh = C - m * 2;
      c.fillStyle = grey(1);
      c.fillRect(0, 0, C, C);
      const design = i - PACK_BOTTLE_CELL0;
      if (design === 0) {
        // Banded soda label: dark masthead, light field, roundel, dark footer.
        c.fillStyle = grey(ground * 0.4);
        c.fillRect(0, m, C, lh * 0.26);
        c.fillStyle = grey(Math.min(1, ground * 1.16));
        c.fillRect(0, m + lh * 0.26, C, lh * 0.5);
        c.fillStyle = grey(ground * 0.36);
        c.beginPath();
        c.ellipse(C * 0.5, m + lh * 0.51, C * 0.2, lh * 0.17, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = grey(ground * 0.5);
        c.fillRect(0, m + lh * 0.76, C, lh * 0.24);
      } else if (design === 1) {
        // Sweep label: a dark field with a light diagonal across it. The sweep
        // is the one non-horizontal element on the sheet and it survives the
        // wrap because it crosses the whole cell.
        c.fillStyle = grey(ground * 0.34);
        c.fillRect(0, m, C, lh);
        c.fillStyle = grey(1);
        c.beginPath();
        c.moveTo(0, m + lh * 0.72);
        c.lineTo(C, m + lh * 0.3);
        c.lineTo(C, m + lh * 0.62);
        c.lineTo(0, m + lh);
        c.closePath();
        c.fill();
        c.fillStyle = grey(ground * 0.62);
        c.fillRect(0, m, C, lh * 0.16);
      } else if (design === 2) {
        // Water: a narrow waist band on an otherwise clear bottle, so most of
        // the height stays white and the drink colour reads straight through.
        c.fillStyle = grey(Math.min(1, ground * 1.1));
        c.fillRect(0, m + lh * 0.3, C, lh * 0.44);
        c.fillStyle = grey(ground * 0.42);
        c.fillRect(0, m + lh * 0.3, C, lh * 0.12);
        c.fillStyle = grey(ground * 0.55);
        c.fillRect(0, m + lh * 0.62, C, lh * 0.12);
      } else {
        // Energy drink: dark full-bleed label with a light panel low on it.
        c.fillStyle = grey(ground * 0.3);
        c.fillRect(0, m, C, lh);
        c.fillStyle = grey(1);
        c.fillRect(C * 0.06, m + lh * 0.46, C * 0.88, lh * 0.3);
        c.fillStyle = grey(ground * 0.66);
        c.fillRect(0, m + lh * 0.14, C, lh * 0.13);
      }
      /**
       * No baked cylinder shading here, deliberately. The obvious move is a
       * left-to-right darkening so the label looks wrapped, and it is wrong
       * twice over: the lathe already has real normals doing exactly that, and
       * this cell's u = 0 edge is the *back* seam of the bottle rather than
       * its silhouette, so the gradient would darken whichever side happened
       * to be facing the camera.
       */
      c.restore();
      continue;
    }

    switch (i % 6) {
      case 0: {
        // Banded carton: dark header, light field, footer rule.
        c.fillStyle = grey(ground * 0.42);
        c.fillRect(0, 0, C, C * 0.3);
        c.fillStyle = grey(Math.min(1, ground * 1.14));
        c.fillRect(C * 0.12, C * 0.4, C * 0.76, C * 0.3);
        c.fillStyle = grey(ground * 0.55);
        c.fillRect(0, C * 0.8, C, C * MIN_MARK);
        break;
      }
      case 1: {
        // Bagged snack: dark ground, big light lozenge, clear top seal.
        c.fillStyle = grey(ground * 0.36);
        c.fillRect(0, 0, C, C);
        c.fillStyle = grey(Math.min(1, ground * 1.2));
        c.beginPath();
        c.ellipse(C * 0.5, C * 0.54, C * 0.34, C * 0.24, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = grey(ground * 0.72);
        c.fillRect(0, 0, C, C * 0.13);
        break;
      }
      case 2: {
        // Boxed goods with a die-cut window showing dark contents.
        c.fillStyle = grey(ground * 0.3);
        c.fillRect(C * 0.18, C * 0.34, C * 0.64, C * 0.44);
        c.fillStyle = grey(ground * 0.6);
        c.fillRect(0, C * 0.14, C, C * 0.1);
        break;
      }
      case 3: {
        // Vertical stripe pack. Three stripes, not the five this used to
        // carry: at 23 px per facing five stripes are 4.6 px each before the
        // mip filter and about 1.5 texels after it, which averages to a flat
        // mid grey — a design that is invisible at the distance it is seen at
        // costs the same to render as one that is not.
        for (let s = 0; s < 3; s++) {
          c.fillStyle = grey(ground * (s % 2 ? 0.42 : 1.0));
          c.fillRect((s / 3) * C, C * 0.16, C / 3, C * 0.68);
        }
        c.fillStyle = grey(ground * 0.34);
        c.fillRect(0, C * 0.84, C, C * MIN_MARK);
        break;
      }
      case 4: {
        // Roundel over a split field — the shape of half the drinks made.
        c.fillStyle = grey(ground * 0.38);
        c.fillRect(0, C * 0.52, C, C * 0.48);
        c.fillStyle = grey(Math.min(1, ground * 1.18));
        c.beginPath();
        c.arc(C * 0.5, C * 0.5, C * 0.26, 0, Math.PI * 2);
        c.fill();
        break;
      }
      default: {
        // Quiet kraft carton: a masthead band, a block of copy and a footer
        // rule. This is the restrained cell, not the empty one — every shelf
        // has understated packaging and without it the run looks
        // over-designed. It was genuinely empty in the first build, and a
        // 0.20 x 0.30 m carton with the plain cell rendered as a 133 x 197 px
        // sheet of blank cream standing on the back-bar shelf: the largest
        // single object in the `door` capture and the only one with nothing on
        // it. A restrained package still has ink on it.
        c.fillStyle = grey(ground * 0.55);
        c.fillRect(0, C * 0.1, C, C * 0.15);
        c.fillStyle = grey(ground * 0.44);
        c.fillRect(C * 0.14, C * 0.42, C * 0.5, C * 0.2);
        c.fillStyle = grey(ground * 0.66);
        c.fillRect(C * 0.14, C * 0.68, C * 0.72, C * MIN_MARK);
        break;
      }
    }

    // Every package is a folded or sealed object: a shadow where the front face
    // turns under at the bottom, and a slight sheen along the top fold.
    const shade = c.createLinearGradient(0, C * 0.86, 0, C);
    shade.addColorStop(0, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.34)");
    c.fillStyle = shade;
    c.fillRect(0, C * 0.86, C, C * 0.14);
    // The top fold. Was 1/28 of the cell, which is a third of a texel at the
    // mip the `interior` pose actually samples — it was paying for a mark
    // nobody could ever have seen. At MIN_MARK it survives as a value step.
    c.fillStyle = "rgba(255,255,255,0.22)";
    c.fillRect(0, 0, C, C * MIN_MARK);

    c.restore();
  }

  return opaqueTexture(canvas);
}

/** UV rectangle of packaging cell `i`, wrapped into range. */
export function packCell(i: number): [number, number, number, number] {
  const k = ((i % PACK_CELLS) + PACK_CELLS) % PACK_CELLS;
  const u = (k % PACK_GRID) / PACK_GRID;
  const v = 1 - (Math.floor(k / PACK_GRID) + 1) / PACK_GRID;
  return [u, v, u + 1 / PACK_GRID, v + 1 / PACK_GRID];
}

/**
 * Map a product's own faces onto one packaging cell.
 *
 * The geometry arrives with world-metre UVs, which are right for masonry and
 * useless here: a packet needs its artwork to fit the packet. So the UV is
 * rebuilt from position and normal — upright faces get the cell, and the top
 * and bottom get a small patch of the cell's plainest corner, because a carton
 * seen from above shows a closed flap, not the front of the box.
 *
 * Must be called before the geometry is translated into place: everything here
 * is in the local frame where the box is centred on the origin.
 */
export function applyPackaging(geo: THREE.BufferGeometry, cellIndex: number, radial = false): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
  let uv = geo.getAttribute("uv") as THREE.BufferAttribute | undefined;
  if (!uv) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute("uv", uv);
  }

  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  const [u0, v0, u1, v1] = packCell(cellIndex);
  // Half a texel of the 1024 sheet, as elsewhere in this file.
  const pad = 0.5 / 1024;
  const span = (a: number, b: number, t: number) => THREE.MathUtils.lerp(a + pad, b - pad, THREE.MathUtils.clamp(t, 0, 1));

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = nor.getY(i);
    let fu: number;
    let fv: number;
    if (Math.abs(ny) > 0.5) {
      // Closed flap or can lid: a small, quiet patch rather than the artwork.
      fu = 0.06 + 0.1 * ((x - bb.min.x) / (size.x || 1));
      fv = 0.06 + 0.1 * ((z - bb.min.z) / (size.z || 1));
    } else if (radial) {
      /**
       * The incoming u, not `atan2(z, x)`.
       *
       * A lathe and a cylinder both duplicate the vertices on the wrap seam so
       * that the last column can carry u = 1 while the first carries u = 0.
       * Recomputing the angle from position throws that away — both columns
       * are at the same angle, so the closing quad gets u running from 1 back
       * to 0 and the *entire* atlas cell is squeezed into it, mirrored. It is
       * one strip out of fourteen on a can, which is why it survived: at can
       * size it reads as a slightly odd highlight.
       *
       * Callers must therefore hand this a 0..1 wrap in u. `buildingTube`
       * scales its u by circumference / uvMetres, so a can wants
       * `uvMetres = 2 * PI * r`.
       */
      fu = uv.getX(i);
      fv = (y - bb.min.y) / (size.y || 1);
    } else {
      // Whichever horizontal axis this face runs along.
      const alongX = Math.abs(nor.getZ(i)) > Math.abs(nor.getX(i));
      fu = alongX ? (x - bb.min.x) / (size.x || 1) : (z - bb.min.z) / (size.z || 1);
      fv = (y - bb.min.y) / (size.y || 1);
    }
    uv.setXY(i, span(u0, u1, fu), span(v0, v1, fv));
  }
  uv.needsUpdate = true;
}

/**
 * Wrap one bottle-cell of the packaging atlas round a drinks lathe.
 *
 * Separate from `applyPackaging` because a bottle is not a packet: the print
 * covers a *band* of the height and the neck, shoulder and base are bare
 * container. So the label's own world-local Y range maps onto the printed part
 * of the cell and everything outside it clamps into the cell's plain margins,
 * where the map is flat white and the vertex colour — the liquid — comes
 * through unaltered.
 *
 * `cellIndex` is an index into the bottle cells, not into the sheet.
 *
 * Must be called before the geometry is translated: `y0`/`y1` are in the local
 * frame where the bottle stands on y = 0.
 */
export function applyBottleLabel(geo: THREE.BufferGeometry, cellIndex: number, y0: number, y1: number): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const n = ((cellIndex % PACK_BOTTLE_CELLS) + PACK_BOTTLE_CELLS) % PACK_BOTTLE_CELLS;
  const [u0, v0, u1, v1] = packCell(PACK_BOTTLE_CELL0 + n);
  const pad = 0.5 / 1024;
  const span = (a: number, b: number, t: number) => THREE.MathUtils.lerp(a + pad, b - pad, THREE.MathUtils.clamp(t, 0, 1));
  const printed = (t: number) => BOTTLE_MARGIN + THREE.MathUtils.clamp(t, 0, 1) * (1 - BOTTLE_MARGIN * 2);

  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    // Cap and base discs: hold them well inside the top margin. Clamping them
    // to the margin's own edge would put them on the boundary texel, which the
    // mip chain then mixes with the masthead.
    const fv = Math.abs(ny) > 0.5 ? 1 - BOTTLE_MARGIN * 0.35 : printed((pos.getY(i) - y0) / Math.max(y1 - y0, 1e-6));
    // As in `applyPackaging`: the lathe's own u, so the wrap seam survives.
    uv.setXY(i, span(u0, u1, uv.getX(i)), span(v0, v1, fv));
  }
  uv.needsUpdate = true;
}

/**
 * Rewrite a quad's UVs onto one cell of a sheet. The quads produced by
 * `buildingQuad` carry a plain 0..1 UV, so this is a straight remap.
 */
export function applySheetCell(geo: THREE.BufferGeometry, cell: [number, number, number, number]): void {
  const attr = geo.getAttribute("uv") as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = cell;
  // Inset by half a texel of the 1024 sheet: a cell that runs exactly to its
  // boundary picks up its neighbour once the mip chain starts averaging, which
  // is how an atlas develops coloured fringes nobody can find the source of.
  const pad = 0.5 / 1024;
  for (let i = 0; i < attr.count; i++) {
    attr.setXY(
      i,
      THREE.MathUtils.lerp(u0 + pad, u1 - pad, attr.getX(i)),
      THREE.MathUtils.lerp(v0 + pad, v1 - pad, attr.getY(i))
    );
  }
  attr.needsUpdate = true;
}
