/**
 * Diegetic graphics printed on the dispenser: the illuminated topper panel and
 * the grade strip beside the keypad.
 *
 * Why this exists. At forecourt distance the dispenser reduced to a beige
 * rectangle with a red line across it and a plain white slab on top. Surface
 * detail — seams, fasteners, orange peel, grime — is all gone by twenty metres,
 * and what is left of an object at that range is its outline and its large
 * value blocks. The topper is the single largest uninterrupted area on the
 * whole unit and it was empty, so the top third of the silhouette carried no
 * information at all.
 *
 * Wording is invented. No real brands or marks anywhere in this project.
 *
 * Canvases are created with `alpha: false` and filled opaque before anything
 * is drawn, exactly as `pumpDisplay.ts` does. A canvas backing store is
 * premultiplied, so writing partially transparent pixels and reading them back
 * corrupts the RGB channels — NOTES.md case 1, which cost a day.
 */

import * as THREE from "three";

/**
 * Matches `TOPPER_FACE` in pumpParts: 0.94 x 0.245 m, so 3.84:1. Getting this
 * wrong stretches the type, which is the sort of thing that reads as "CG"
 * without anyone being able to name it — the price head lost a round to
 * exactly that at 1.6:1.
 */
const TOPPER_W = 1024;
const TOPPER_H = 267;

function opaqueCanvas(w: number, h: number, fill: string): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * The backlit acrylic topper face.
 *
 * Built to survive being twelve pixels tall, which is what it is from the far
 * side of the forecourt. That rules the design more than taste does: one
 * strong horizontal value break, one large mark, and type at a weight that
 * still reads as *something written* after the mip chain has had it. Fine
 * print and thin strokes are wasted here — they average to grey and make the
 * panel look dirty rather than printed.
 *
 * `seed` shifts nothing about the layout: all three dispensers on a forecourt
 * carry the same brand, and varying it would be a worse error than repeating
 * it. Per-unit difference belongs in the weathering, not the signage.
 */
export function makeTopperFace(): THREE.CanvasTexture {
  const { canvas, ctx } = opaqueCanvas(TOPPER_W, TOPPER_H, "#e9e4d8");

  // Warm field with a slight vertical gradient, so the panel reads as lit from
  // behind by a tube rather than as flat paint.
  const g = ctx.createLinearGradient(0, 0, 0, TOPPER_H);
  g.addColorStop(0, "#fbf6e8");
  g.addColorStop(0.55, "#efe8d6");
  g.addColorStop(1, "#ddd4bf");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TOPPER_W, TOPPER_H);

  // Deep band across the lower third. This is the element that does the work
  // at distance: a hard horizontal value break inside the white slab.
  ctx.fillStyle = "#7d2128";
  ctx.fillRect(0, TOPPER_H * 0.665, TOPPER_W, TOPPER_H * 0.335);
  ctx.fillStyle = "#c8a24a";
  ctx.fillRect(0, TOPPER_H * 0.638, TOPPER_W, TOPPER_H * 0.028);

  // Mark: three stacked chevrons, of a size that is still a shape at 12 px.
  const cx = 132;
  const cy = TOPPER_H * 0.36;
  ctx.strokeStyle = "#7d2128";
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = 19 - i * 3;
    ctx.beginPath();
    ctx.moveTo(cx - 66, cy + 34 - i * 29);
    ctx.lineTo(cx, cy - 14 - i * 29);
    ctx.lineTo(cx + 66, cy + 34 - i * 29);
    ctx.stroke();
  }

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#2b2a28";
  ctx.font = "700 108px Arial, Helvetica, sans-serif";
  ctx.fillText("MERIDIAN", 246, TOPPER_H * 0.50);

  ctx.fillStyle = "#7d2128";
  ctx.font = "600 44px Arial, Helvetica, sans-serif";
  ctx.fillText("F U E L   C O .", 250, TOPPER_H * 0.615);

  ctx.fillStyle = "#f2ead6";
  ctx.font = "700 50px Arial, Helvetica, sans-serif";
  ctx.fillText("DETERGENT GASOLINE", 36, TOPPER_H * 0.935);

  // Age: the acrylic has been in the sun for years and the print has gone
  // chalky in patches. Drawn opaque over the top rather than as low-alpha
  // strokes, for the premultiplied reason in the file header.
  const img = ctx.getImageData(0, 0, TOPPER_W, TOPPER_H);
  const d = img.data;
  for (let y = 0; y < TOPPER_H; y++) {
    for (let x = 0; x < TOPPER_W; x++) {
      const i = (y * TOPPER_W + x) * 4;
      // Cheap smooth fade, strongest at the top where the sun hits hardest.
      const bleach =
        0.06 +
        0.10 * (1 - y / TOPPER_H) +
        0.05 * Math.sin(x * 0.011 + 1.3) * Math.cos(y * 0.017 - 0.6);
      d[i] = Math.min(255, d[i] + (238 - d[i]) * bleach);
      d[i + 1] = Math.min(255, d[i + 1] + (233 - d[i + 1]) * bleach);
      d[i + 2] = Math.min(255, d[i + 2] + (219 - d[i + 2]) * bleach);
    }
  }
  ctx.putImageData(img, 0, 0);

  return toTexture(canvas);
}

/* ------------------------------------------------------------------ */
/* keypad                                                              */
/* ------------------------------------------------------------------ */

/** Matches KEYPAD_FACE in pumpParts: 0.140 x 0.166 m. */
const KEYPAD_W = 448;
const KEYPAD_H = 531;

/**
 * The payment keypad fascia, printed rather than extruded.
 *
 * The previous keypad was twelve blank lozenges, which a critic called "an
 * instant tell that nothing here was finished", and they were right: a payment
 * keypad with no numbers on it is not a subtle failure. Real relief was the
 * reason - the keys were geometry, the merged pump carries metre-scale
 * triplanar UVs (see metreUv), and a 0..1 atlas map cannot ride on those, so
 * there was nowhere for a digit to live.
 *
 * So the keys become print. That trade is worth taking at this scale: at 1.84
 * mm/px in the closest pose a 14 mm key stands 7 px proud, whereas a legible
 * digit is the difference between a keypad and a lump. The key edges are shaded
 * into the canvas, lit from the upper left to agree with a low west-south-west
 * sun, so they still read as separate keys rather than as a decal.
 *
 * Opaque, and filled before anything is drawn. A canvas backing store is
 * premultiplied and reading back partial alpha corrupts RGB - NOTES case 1.
 */
export function makeKeypadFace(): THREE.CanvasTexture {
  const { canvas, ctx } = opaqueCanvas(KEYPAD_W, KEYPAD_H, "#2f2e2c");

  // Bezel field, slightly graded so the recess is not a flat swatch.
  const bg = ctx.createLinearGradient(0, 0, 0, KEYPAD_H);
  bg.addColorStop(0, "#3a3936");
  bg.addColorStop(1, "#26251f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, KEYPAD_W, KEYPAD_H);

  const cols = 3;
  const rowN = 4;
  const padX = 26;
  const padY = 30;
  const cw = (KEYPAD_W - padX * 2) / cols;
  const ch = (KEYPAD_H - padY * 2) / rowN;
  const keyW = cw - 14;
  const keyH = ch - 14;

  const legends = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["CANCEL", "0", "ENTER"],
  ];
  // The keys a customer actually hits get a polished halo. 1, 2 and 5 lead
  // because prices start with them, and ENTER is pressed every single time.
  const worn: Record<string, number> = { "1": 1, "2": 0.85, "5": 0.7, ENTER: 1, "0": 0.5 };

  const rounded = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  for (let r = 0; r < rowN; r++) {
    for (let c = 0; c < cols; c++) {
      const label = legends[r][c];
      const cx = padX + c * cw + (cw - keyW) / 2;
      const cy = padY + r * ch + (ch - keyH) / 2;

      // Shadow first, offset down-right away from the key, so the key sits in
      // the bezel rather than floating on it.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      rounded(cx + 4, cy + 5, keyW, keyH, 12);
      ctx.fill();

      let base = "#b9b3a6";
      let ink = "#1b1a18";
      if (label === "CANCEL") {
        base = "#8e3128";
        ink = "#f0e6df";
      } else if (label === "ENTER") {
        base = "#3d6b3a";
        ink = "#eef3ea";
      }
      const kg = ctx.createLinearGradient(cx, cy, cx + keyW * 0.4, cy + keyH);
      kg.addColorStop(0, base);
      kg.addColorStop(1, shade(base, -0.22));
      ctx.fillStyle = kg;
      rounded(cx, cy, keyW, keyH, 12);
      ctx.fill();

      // Lit top-left arris and dark lower-right one: the key's own relief,
      // baked to agree with the site's low WSW sun.
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,248,232,0.5)";
      ctx.beginPath();
      ctx.moveTo(cx + 3, cy + keyH - 12);
      ctx.lineTo(cx + 3, cy + 12);
      ctx.quadraticCurveTo(cx + 3, cy + 3, cx + 12, cy + 3);
      ctx.lineTo(cx + keyW - 12, cy + 3);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.42)";
      ctx.beginPath();
      ctx.moveTo(cx + keyW - 3, cy + 12);
      ctx.lineTo(cx + keyW - 3, cy + keyH - 12);
      ctx.quadraticCurveTo(cx + keyW - 3, cy + keyH - 3, cx + keyW - 12, cy + keyH - 3);
      ctx.lineTo(cx + 12, cy + keyH - 3);
      ctx.stroke();

      // Finger polish: a soft bright patch low and central, where a thumb lands.
      const w0 = worn[label] ?? 0.18;
      if (w0 > 0.2) {
        const gl = ctx.createRadialGradient(
          cx + keyW * 0.5,
          cy + keyH * 0.62,
          2,
          cx + keyW * 0.5,
          cy + keyH * 0.62,
          keyW * 0.5
        );
        gl.addColorStop(0, `rgba(255,252,244,${0.3 * w0})`);
        gl.addColorStop(1, "rgba(255,252,244,0)");
        ctx.fillStyle = gl;
        rounded(cx, cy, keyW, keyH, 12);
        ctx.fill();
      }

      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const small = label.length > 1;
      ctx.font = `${small ? 700 : 600} ${small ? 26 : 62}px "Arial Narrow", Arial, sans-serif`;
      ctx.fillText(label, cx + keyW / 2, cy + keyH / 2 + (small ? 1 : 3));
    }
  }

  // Braille-style raised dot on the 5 key, which every real pad carries.
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath();
  ctx.arc(padX + cw * 1.5, padY + ch * 2.5 - keyH * 0.5 + 8, 5, 0, Math.PI * 2);
  ctx.fill();

  return toTexture(canvas);
}

/** Darken or lighten a hex colour by a fraction. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = cl(((n >> 16) & 255) * (1 + amt));
  const g = cl(((n >> 8) & 255) * (1 + amt));
  const b = cl((n & 255) * (1 + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
