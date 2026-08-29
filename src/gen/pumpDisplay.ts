/**
 * The dispenser's price/volume head, as a redrawable canvas texture.
 *
 * System 7 animates the digits while the player is fuelling, so the pixels have
 * to be updatable at runtime rather than baked. Each dispenser face owns one of
 * these and exposes `set()` through the service registry.
 *
 * The canvas is always filled opaque before anything else is drawn. A canvas
 * backing store is premultiplied, and this project has already lost a day to
 * partially transparent canvas data corrupting its own RGB channels.
 */

import * as THREE from "three";

export interface PumpDisplayValues {
  /** Total sale in dollars. */
  dollars: number;
  /** Volume dispensed, US gallons. */
  gallons: number;
  /** Posted price per gallon. */
  price: number;
  /** Selected grade, 0..2. Lights the corresponding grade lamp. */
  grade: number;
  /** Whether the dispenser is authorised and running. */
  active: boolean;
}

/**
 * A burnt-out LED segment. `row` is 0 SALE / 1 GALLONS / 2 PRICE, `cell` counts
 * digits from the right so it does not move as a value grows, and `seg` is an
 * index into the a..g order used by `SEG_ON`.
 */
export interface SegmentFault {
  row: number;
  cell: number;
  seg: number;
}

// 2:1, matching the physical panel. An earlier pass used 1.6:1 and every digit
// came out stretched, which is exactly the kind of thing that reads as "CG"
// without anyone being able to say why.
const W = 1024;
const H = 512;

/* 7-segment layout, in a 0..1 box per digit. Segment order a,b,c,d,e,f,g. */
const SEG_ON: Record<string, number[]> = {
  "0": [1, 1, 1, 1, 1, 1, 0],
  "1": [0, 1, 1, 0, 0, 0, 0],
  "2": [1, 1, 0, 1, 1, 0, 1],
  "3": [1, 1, 1, 1, 0, 0, 1],
  "4": [0, 1, 1, 0, 0, 1, 1],
  "5": [1, 0, 1, 1, 0, 1, 1],
  "6": [1, 0, 1, 1, 1, 1, 1],
  "7": [1, 1, 1, 0, 0, 0, 0],
  "8": [1, 1, 1, 1, 1, 1, 1],
  "9": [1, 1, 1, 1, 0, 1, 1],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

export class PumpDisplay {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private values: PumpDisplayValues;
  /** Burnt-out segments, as {row, cell, seg}. Cell 0 is the rightmost digit. */
  private faults: SegmentFault[];
  /** Which run and which digit `digit()` is currently drawing, for `faults`. */
  private row = 0;
  private cell = 0;

  constructor(initial: Partial<PumpDisplayValues> = {}, faults: SegmentFault[] = []) {
    this.faults = faults;
    this.values = {
      dollars: 0,
      gallons: 0,
      price: 3.499,
      grade: 0,
      active: false,
      ...initial,
    };

    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.redraw();
  }

  get(): PumpDisplayValues {
    return { ...this.values };
  }

  /** Partial update; only redraws when something actually changed. */
  set(next: Partial<PumpDisplayValues>): void {
    let dirty = false;
    for (const k of Object.keys(next) as (keyof PumpDisplayValues)[]) {
      const v = next[k];
      if (v !== undefined && this.values[k] !== v) {
        (this.values as unknown as Record<string, unknown>)[k] = v;
        dirty = true;
      }
    }
    if (dirty) this.redraw();
  }

  reset(): void {
    this.set({ dollars: 0, gallons: 0, active: false });
  }

  dispose(): void {
    this.texture.dispose();
  }

  /* ---------------------------------------------------------------- */

  private redraw(): void {
    const c = this.ctx;
    const on = this.values.active;

    // Opaque fill first, always.
    c.fillStyle = "#0a0c0b";
    c.fillRect(0, 0, W, H);

    // The LCD glass itself: a very slightly green-black with an uneven
    // backlight that is brighter toward the middle.
    const g = c.createRadialGradient(W * 0.5, H * 0.42, 20, W * 0.5, H * 0.5, W * 0.72);
    g.addColorStop(0, on ? "#16211c" : "#101512");
    g.addColorStop(1, "#080a09");
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    const amber = on ? "#ffab3c" : "#e08424";
    const dim = "#241a0f";

    this.label(c, "SALE  $", 26, 20, 34);
    this.row = 0;
    this.digits(c, this.money(this.values.dollars, 6), 1002, 12, 104, 150, amber, dim);

    this.label(c, "GALLONS", 26, 188, 34);
    this.row = 1;
    this.digits(c, this.money(this.values.gallons, 6), 1002, 180, 98, 140, amber, dim);

    this.label(c, "PRICE / GAL  $", 26, 356, 28);
    this.row = 2;
    this.digits(c, this.price(this.values.price), 1002, 344, 66, 96, on ? "#ffc267" : "#d99341", dim);

    // Grade lamps along the bottom, only one lit.
    const grades = ["87", "89", "93"];
    for (let i = 0; i < 3; i++) {
      const lit = i === this.values.grade;
      c.fillStyle = lit ? "#432d0c" : "#141715";
      c.beginPath();
      c.roundRect(26 + i * 132, 452, 118, 46, 7);
      c.fill();
      c.strokeStyle = lit ? "#ffb04a" : "#2e332f";
      c.lineWidth = 3;
      c.stroke();
      c.fillStyle = lit ? "#ffce80" : "#454b46";
      c.font = "bold 32px 'Arial Narrow', Arial, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(grades[i], 85 + i * 132, 476);
    }

    // A faint pixel grille. Deliberately 4 px with low contrast: at 2 px it
    // beat against the screen sampling and the whole panel turned to moire.
    c.globalAlpha = 0.07;
    c.fillStyle = "#000";
    for (let y = 0; y < H; y += 4) c.fillRect(0, y, W, 1);
    c.globalAlpha = 1;

    this.texture.needsUpdate = true;
  }

  private label(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number): void {
    c.fillStyle = "#7d8880";
    c.font = `bold ${size}px 'Arial Narrow', Arial, sans-serif`;
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(text, x, y);
  }

  /** Right-aligned fixed-point string with a decimal point in the last 2. */
  private money(v: number, width: number): string {
    const s = Math.max(0, v).toFixed(2);
    return s.padStart(width, " ");
  }

  private price(v: number): string {
    return Math.max(0, v).toFixed(3);
  }

  /**
   * Draws a right-aligned 7-segment run. The decimal point consumes no cell of
   * its own, exactly as on a real pump head.
   */
  private digits(
    c: CanvasRenderingContext2D,
    text: string,
    right: number,
    top: number,
    cw: number,
    ch: number,
    lit: string,
    off: string
  ): void {
    const chars = text.split("");
    // Lay out from the right so the columns never jitter as the value grows.
    let x = right;
    for (let i = chars.length - 1; i >= 0; i--) {
      const ch2 = chars[i];
      if (ch2 === ".") {
        x -= cw * 0.34;
        c.fillStyle = lit;
        c.beginPath();
        c.arc(x + cw * 0.17, top + ch * 0.92, cw * 0.09, 0, Math.PI * 2);
        c.fill();
        continue;
      }
      x -= cw;
      this.cell = chars.length - 1 - i;
      this.digit(c, ch2, x, top, cw * 0.86, ch, lit, off);
    }
  }

  private digit(
    c: CanvasRenderingContext2D,
    ch: string,
    x: number,
    y: number,
    w: number,
    h: number,
    lit: string,
    off: string
  ): void {
    const segs = SEG_ON[ch] ?? SEG_ON[" "];
    const t = Math.max(4, w * 0.17); // stroke thickness
    const skew = w * 0.1; // italic lean, as on real pump heads
    const mid = y + h / 2;

    /** Horizontal segment as a flattened hexagon, leaning with the italic. */
    const hbar = (bx: number, by: number, bw: number, bh: number) => {
      const lean = ((y + h - by - bh / 2) / h) * skew;
      c.beginPath();
      c.moveTo(bx + bh * 0.5 + lean, by);
      c.lineTo(bx + bw - bh * 0.5 + lean, by);
      c.lineTo(bx + bw + lean, by + bh * 0.5);
      c.lineTo(bx + bw - bh * 0.5 + lean, by + bh);
      c.lineTo(bx + bh * 0.5 + lean, by + bh);
      c.lineTo(bx + lean, by + bh * 0.5);
      c.closePath();
      c.fill();
    };

    // Vertical bars are drawn as their own hexagons rather than reusing `bar`,
    // which keeps the mitre at the corners readable at this size.
    const vbar = (bx: number, by: number, bh: number) => {
      const lean0 = ((y + h - by) / h) * skew;
      const lean1 = ((y + h - by - bh) / h) * skew;
      c.beginPath();
      c.moveTo(bx + lean0 - t * 0.5, by + t * 0.5);
      c.lineTo(bx + lean0, by);
      c.lineTo(bx + lean0 + t * 0.5, by + t * 0.5);
      c.lineTo(bx + lean1 + t * 0.5, by + bh - t * 0.5);
      c.lineTo(bx + lean1, by + bh);
      c.lineTo(bx + lean1 - t * 0.5, by + bh - t * 0.5);
      c.closePath();
      c.fill();
    };

    const half = (h - t) / 2;
    // A failed segment stays at the unlit colour no matter what the value is.
    // One dead segment somewhere on a forecourt is close to certain, and it is
    // the cheapest possible way to make one dispenser not be a copy of the one
    // beside it — the price head is the brightest thing on the unit and the
    // first place an eye lands.
    const pick = (i: number) =>
      segs[i] && !this.faults.some((q) => q.row === this.row && q.cell === this.cell && q.seg === i)
        ? lit
        : off;

    c.fillStyle = pick(0);
    hbar(x, y, w, t); // a
    c.fillStyle = pick(3);
    hbar(x, y + h - t, w, t); // d
    c.fillStyle = pick(6);
    hbar(x, mid - t / 2, w, t); // g

    c.fillStyle = pick(5);
    vbar(x + t * 0.5, y + t * 0.5, half); // f
    c.fillStyle = pick(1);
    vbar(x + w - t * 0.5, y + t * 0.5, half); // b
    c.fillStyle = pick(4);
    vbar(x + t * 0.5, mid, half); // e
    c.fillStyle = pick(2);
    vbar(x + w - t * 0.5, mid, half); // c
  }
}
