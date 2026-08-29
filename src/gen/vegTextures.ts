/**
 * Procedural textures for System 6 (vegetation, distant landscape, edges).
 *
 * Everything here is rasterised into typed arrays and handed to a
 * `THREE.DataTexture`. Deliberately no `CanvasTexture` anywhere: NOTES.md case
 * 1 is a canvas backing store premultiplying low-alpha pixels and corrupting
 * the RGB channels on readback, and every map in this file is an alpha-tested
 * cutout, i.e. exactly the case that goes wrong.
 *
 * The other alpha-cutout trap this file guards against is the *fringe*. A
 * transparent pixel still has a colour, and the mip chain averages it in with
 * its opaque neighbours, so foliage cut out against black background pixels
 * grows a dark halo two mip levels down. `dilate()` floods the nearest opaque
 * colour outward across the transparent region before packing, which is the
 * standard fix and costs nothing at runtime.
 */

import * as THREE from "three";
import { clamp01, fbm, lerp, sampleWrapped, seededRng, worley, type Rng } from "./noise";
import { getMaxAnisotropy, heightToNormal } from "./textures";

/* ------------------------------------------------------------------ */
/* raster                                                              */
/* ------------------------------------------------------------------ */

type RGB = [number, number, number];

/**
 * A tiny software rasteriser with y pointing *up*, which matches the UV space
 * of a `DataTexture` (flipY is false by default, so data row 0 is v = 0).
 * Colours are authored in sRGB 0..1 because the packed texture is tagged
 * `SRGBColorSpace`.
 */
class Raster {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n);
  }

  /** Source-over composite of a single pixel. */
  private blend(i: number, c: RGB, cov: number) {
    if (cov <= 0.002) return;
    const k = cov > 1 ? 1 : cov;
    this.r[i] = this.r[i] * (1 - k) + c[0] * k;
    this.g[i] = this.g[i] * (1 - k) + c[1] * k;
    this.b[i] = this.b[i] * (1 - k) + c[2] * k;
    this.a[i] = this.a[i] + (1 - this.a[i]) * k;
  }

  /**
   * Anti-aliased tapered capsule from (x0,y0) to (x1,y1). `colour` is called
   * per pixel with the parameter along the stroke and the normalised distance
   * across it, so a blade can darken at its base and at its edges in one pass.
   */
  stroke(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    hw0: number,
    hw1: number,
    colour: (t: number, across: number) => RGB,
    alpha = 1
  ) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const pad = Math.max(hw0, hw1) + 1.5;
    const xa = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const xb = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + pad));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const yb = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + pad));

    for (let py = ya; py <= yb; py++) {
      const fy = py + 0.5;
      for (let px = xa; px <= xb; px++) {
        const fx = px + 0.5;
        let t = len2 > 1e-9 ? ((fx - x0) * dx + (fy - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = x0 + dx * t;
        const cy = y0 + dy * t;
        const d = Math.hypot(fx - cx, fy - cy);
        const hw = lerp(hw0, hw1, t);
        const cov = clamp01(hw + 0.5 - d) * alpha;
        if (cov <= 0.002) continue;
        this.blend(py * this.w + px, colour(t, hw > 1e-4 ? d / hw : 0), cov);
      }
    }
  }

  /** Soft filled ellipse; used for seed heads and berry clusters. */
  blob(cx: number, cy: number, rx: number, ry: number, colour: (t: number) => RGB, alpha = 1) {
    const xa = Math.max(0, Math.floor(cx - rx - 1));
    const xb = Math.min(this.w - 1, Math.ceil(cx + rx + 1));
    const ya = Math.max(0, Math.floor(cy - ry - 1));
    const yb = Math.min(this.h - 1, Math.ceil(cy + ry + 1));
    for (let py = ya; py <= yb; py++) {
      for (let px = xa; px <= xb; px++) {
        const u = (px + 0.5 - cx) / rx;
        const v = (py + 0.5 - cy) / ry;
        const d = Math.hypot(u, v);
        const cov = clamp01((1 - d) * Math.min(rx, ry) + 0.5) * alpha;
        if (cov <= 0.002) continue;
        this.blend(py * this.w + px, colour(clamp01(d)), cov);
      }
    }
  }

  /**
   * Flood the nearest opaque colour into the transparent region. Without this
   * the mip chain averages foliage against the black it was cut out of and the
   * canopy grows a dark rim at distance.
   */
  dilate(passes = 12) {
    const filled = new Uint8Array(this.w * this.h);
    for (let i = 0; i < filled.length; i++) filled[i] = this.a[i] > 0.004 ? 1 : 0;
    const nbr = [-1, 1, -this.w, this.w, -this.w - 1, -this.w + 1, this.w - 1, this.w + 1];
    for (let p = 0; p < passes; p++) {
      const next = filled.slice();
      let touched = 0;
      for (let y = 1; y < this.h - 1; y++) {
        for (let x = 1; x < this.w - 1; x++) {
          const i = y * this.w + x;
          if (filled[i]) continue;
          let n = 0;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          for (const o of nbr) {
            const j = i + o;
            if (!filled[j]) continue;
            n++;
            sr += this.r[j];
            sg += this.g[j];
            sb += this.b[j];
          }
          if (!n) continue;
          this.r[i] = sr / n;
          this.g[i] = sg / n;
          this.b[i] = sb / n;
          next[i] = 1;
          touched++;
        }
      }
      filled.set(next);
      if (!touched) break;
    }
  }

  /**
   * Highest alpha found on the outermost `inset` rings of the given sides.
   *
   * This exists because of a real bug that survived three rounds of review. An
   * alpha cutout whose drawing runs off the edge of its own canvas does not
   * fade out at the border — it is *clipped*, so the card's rectangle becomes a
   * razor-straight cut through fully opaque foliage, and where two such edges
   * meet you get a right-angle corner. It is invisible in the texture (nothing
   * looks wrong; the needles are all correct) and unmistakable in the render.
   * Measured on the first version: outermost ring max alpha 1.000 on all four
   * borders of every card.
   */
  borderMaxAlpha(inset = 2, sides: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean } = {}): number {
    const { left = true, right = true, top = true, bottom = true } = sides;
    let m = 0;
    for (let r = 0; r < inset; r++) {
      for (let x = 0; x < this.w; x++) {
        if (bottom) m = Math.max(m, this.a[r * this.w + x]);
        if (top) m = Math.max(m, this.a[(this.h - 1 - r) * this.w + x]);
      }
      for (let y = 0; y < this.h; y++) {
        if (left) m = Math.max(m, this.a[y * this.w + r]);
        if (right) m = Math.max(m, this.a[y * this.w + (this.w - 1 - r)]);
      }
    }
    return m;
  }

  /**
   * Shorten a stroke so it terminates inside the safe box. Returns the usable
   * length, which may be 0. Shortening rather than clipping matters: a stroke
   * that ends early still tapers to nothing, so alpha reaches zero naturally,
   * whereas a clipped one ends in a hard straight edge.
   */
  fitLength(x: number, y: number, dx: number, dy: number, len: number, margin: number): number {
    let t = len;
    const lo = margin;
    const hiX = this.w - 1 - margin;
    const hiY = this.h - 1 - margin;
    if (dx > 1e-6) t = Math.min(t, (hiX - x) / dx);
    else if (dx < -1e-6) t = Math.min(t, (lo - x) / dx);
    if (dy > 1e-6) t = Math.min(t, (hiY - y) / dy);
    else if (dy < -1e-6) t = Math.min(t, (lo - y) / dy);
    return t > 0 ? t : 0;
  }

  /** Pack to a `DataTexture`. `opaque` drops the alpha channel to solid. */
  texture(opts: { opaque?: boolean; wrap?: boolean; srgb?: boolean } = {}): THREE.DataTexture {
    const { opaque = false, wrap = false, srgb = true } = opts;
    const data = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      data[i * 4] = Math.round(clamp01(this.r[i]) * 255);
      data[i * 4 + 1] = Math.round(clamp01(this.g[i]) * 255);
      data[i * 4 + 2] = Math.round(clamp01(this.b[i]) * 255);
      data[i * 4 + 3] = opaque ? 255 : Math.round(clamp01(this.a[i]) * 255);
    }
    return finishTexture(new THREE.DataTexture(data, this.w, this.h, THREE.RGBAFormat), wrap, srgb);
  }
}

function finishTexture(t: THREE.DataTexture, wrap: boolean, srgb: boolean): THREE.DataTexture {
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = getMaxAnisotropy();
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function greyTexture(buf: Float32Array, size: number, wrap: boolean): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(clamp01(buf[i]) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), wrap, false);
}

function normalTexture(height: Float32Array, size: number, strength: number, wrap: boolean): THREE.DataTexture {
  const rgb = heightToNormal(height, size, strength);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), wrap, false);
}

/* ------------------------------------------------------------------ */
/* pine foliage cards                                                  */
/* ------------------------------------------------------------------ */

const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * One pine shoot: a woody stem running left to right across the card with
 * fascicles of needles radiating from it, shorter toward the tip. The card is
 * placed with its +X along the branch, so a cluster of three of these crossed
 * about the branch axis reads as a spray of foliage from any angle.
 *
 * Roadside pines are scrappy, so a fraction of the needles are already brown
 * and the fascicle density falls off unevenly rather than smoothly.
 */
export function makePineShoot(size = 256, seed = 5001, dead = false): THREE.DataTexture {
  const rng = seededRng(seed);
  const R = new Raster(size, size);
  const S = size / 256;

  // Pine foliage is much darker than intuition suggests: a spruce or a pine
  // canopy sits around 6-10% reflectance, roughly the same as fresh asphalt.
  // The first pass authored it two stops brighter and, under a 2400 K sun,
  // that came out as olive-brown and read as a dead broadleaf.
  // Re-derived rather than nudged again, because the relationship between these
  // two was inverted and that explains the reported colour exactly.
  //
  // Live needles were linear luma 0.055-0.110 and dry needles 0.190 — dry was
  // **1.7-3.5x brighter than live**. So the only foliage bright enough to read
  // was the dry brown fraction, and a reviewer described the crowns in one word
  // that gives it away: "wood-brown". It also explains "no colour separation and
  // no green", since the green needles were sitting near black through ACES
  // while the brown ones carried all the visible signal.
  //
  // Sunlit conifer needles are not a near-black material; the green channel sits
  // around 0.10-0.20 linear. Dry needles are now slightly *darker* than the
  // brightest live ones, which is the correct ordering, so green carries the
  // crown and brown reads as the dead fraction it is meant to be.
  // The bottom of this ramp was the only part still outside the band the
  // comment above states: G 0.100 against a stated floor of 0.10-0.20, and a
  // *luma* of 0.081, which is a near-black material. The two brighter tiers are
  // already right, so this lifts the darkest tier and leaves them alone.
  //
  // Deliberately a small correction and not the large one that was authorised.
  // The crowns do read too dark in the captures, but the measurement that
  // matters is `?vshadow=0`: with foliage self-shadowing off the same crowns go
  // 78.7 -> 84.2 luma and R-B goes -1.8 -> +4.0, so what is missing from them is
  // direct sun, not reflectance. Raising albedo until the crowns looked right
  // would put a wrong number into `scene.environment` — which is now a PMREM of
  // the real scene, so every other system would then be lit by vegetation's
  // compensation for a shadow cascade it does not own. Fix the cause there.
  const NEEDLE_LIVE: RGB[] = [
    [0.062, 0.124, 0.070],
    [0.082, 0.152, 0.084],
    [0.118, 0.212, 0.112],
  ];
  const NEEDLE_DRY: RGB = [0.180, 0.132, 0.068];
  const NEEDLE_DUST: RGB = [0.220, 0.208, 0.174];
  const WOOD: RGB = [0.104, 0.084, 0.062];

  // Keep every mark this far from the border. The needles have to be able to
  // taper to nothing *inside* the canvas; if they run off the edge the card's
  // own rectangle becomes visible in the render. See `borderMaxAlpha`.
  const MARGIN = 4 * S;
  // Longest needle drawn anywhere on the card, used to reserve room ahead of
  // the shoot tip. Needles sweep forward, so the tip end is the binding case.
  const NEEDLE_MAX = 48 * S;

  // Gentle S-curve stem so the shoot is not a ruler.
  const bend = (rng() - 0.5) * 26 * S;
  // The stem stops well short of the right edge: at t = 1 the tip fascicle is
  // still ~0.45 of a full needle long and points forward, so ending the stem at
  // 0.985 pushed those needles ~30 px past the border and they were clipped.
  const xEnd = (size - MARGIN - NEEDLE_MAX * 0.5) / size;
  const stemAt = (t: number) => {
    const x = lerp(0.035, xEnd, t) * size;
    const y = size * 0.5 + Math.sin(t * Math.PI) * bend + Math.sin(t * 5.1 + seed) * 3 * S;
    return [x, y] as const;
  };

  const drawShoot = (t0: number, t1: number, off: number, scale: number, browning: number) => {
    const steps = 74;
    let prev = stemAt(t0);
    for (let i = 1; i <= steps; i++) {
      const t = lerp(t0, t1, i / steps);
      const p = stemAt(t);
      const py = p[1] + off;
      R.stroke(prev[0], prev[1] + off, p[0], py, (1.3 - 0.95 * t) * S * scale, (1.3 - 0.95 * (t + 0.01)) * S * scale, () => WOOD);
      prev = p;
    }

    // Needle fascicles. Density is modulated by a low-frequency wobble so the
    // shoot has thin patches, which is what stops it reading as a hairbrush.
    //
    // Getting this number right took two rounds in opposite directions. The
    // first pass was twice as dense as this *and* rasterised needles four times
    // too wide, and every shoot came out an opaque slab with a feathered rim —
    // the "brown leaf" read. Cutting it produced a card measuring only 20%
    // coverage above the alpha cut (tools/vegalpha.mjs), and three crossed cards
    // at 20% leave a crown 51% transparent, which is the "see-through dying tree
    // fern" the critic saw. The needles were never the problem in either
    // direction; the coverage was.
    //
    // ~40% is the target: dense enough that a three-card cluster is around 3/4
    // opaque and reads as a mass, sparse enough that sky still shows through the
    // interior of a shoot rather than only past its edge. Measured, not guessed.
    const N = Math.round(86 * scale);
    for (let i = 0; i < N; i++) {
      const t = lerp(t0, t1, i / N);
      const density = 0.55 + 0.45 * Math.sin(t * 9.3 + seed * 0.7) * Math.cos(t * 3.1 + 1.4);
      if (rng() > clamp01(density + 0.62)) continue;
      const [sx, sy0] = stemAt(t);
      const sy = sy0 + off;
      // Needles shorten toward the tip and are longest a third of the way out.
      const lenT = Math.sin(Math.min(1, (1 - t) * 1.35) * Math.PI * 0.5);
      for (const side of [-1, 1]) {
        const fascicle = 3 + (rng() < 0.55 ? 1 : 0);
        // Angle measured from +X (the direction the shoot points). Always in
        // the forward half-plane, so needles sweep toward the tip the way a
        // real fascicle does, never backward down the stem.
        const baseAng = side * lerp(0.46, 1.42, rng() * 0.8 + 0.1);
        for (let k = 0; k < fascicle; k++) {
          const phi = baseAng + side * (k - (fascicle - 1) / 2) * 0.16 + (rng() - 0.5) * 0.09;
          const wanted = (26 + rng() * 22) * S * scale * (0.45 + 0.55 * lenT);
          // Bow the outer half a little further from the stem: needles droop
          // under their own weight rather than radiating dead straight.
          const phi2 = phi + side * (0.1 + rng() * 0.2);
          // Truncate rather than clip. A needle cut off by the canvas edge ends
          // in a hard straight line at full alpha; one shortened to fit still
          // tapers to a point and its alpha reaches zero on its own. Fitted on
          // the chord of the bow, which is where the tip actually lands.
          const chord = (phi + phi2) * 0.5;
          const len = R.fitLength(sx, sy, Math.cos(chord), Math.sin(chord), wanted, MARGIN);
          if (len < wanted * 0.25) continue;
          const brown = rng() < browning;
          const dusty = rng() < 0.05;
          const c0 = brown ? NEEDLE_DRY : NEEDLE_LIVE[0];
          const c1 = brown ? mix3(NEEDLE_DRY, [0.44, 0.36, 0.19], 0.5) : NEEDLE_LIVE[1 + (rng() < 0.5 ? 0 : 1)];
          const mx = sx + Math.cos(phi) * len * 0.5;
          const my = sy + Math.sin(phi) * len * 0.5;
          const ex = mx + Math.cos(phi2) * len * 0.5;
          const ey = my + Math.sin(phi2) * len * 0.5;
          // Half-width. A pine needle is a bit over a millimetre across and the
          // card rasterises at ~1 mm/texel, so this is close to the physical
          // width with just enough margin to survive the alpha cut.
          const w = (0.88 + rng() * 0.40) * S;
          const paint = (tt: number, across: number): RGB => {
            let c = mix3(c0, c1, tt * 0.85 + 0.1);
            if (dusty) c = mix3(c, NEEDLE_DUST, 0.16);
            // Darken the very edge of the needle: a cylinder seen in section.
            return mix3(c, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.62], across * across * 0.65);
          };
          R.stroke(sx, sy, mx, my, w, w * 0.85, paint);
          R.stroke(mx, my, ex, ey, w * 0.85, w * 0.28, paint);
        }
      }
    }
  };

  const browning = dead ? 0.92 : 0.08;
  drawShoot(0, 1, 0, 1, browning);
  // Two side shoots forking off, which is what gives the card a silhouette
  // rather than a single straight line of needles.
  drawShoot(0.34, 0.86, -0.19 * size, 0.72, browning);
  drawShoot(0.46, 0.94, 0.16 * size, 0.66, browning);
  if (!dead) drawShoot(0.15, 0.55, 0.24 * size, 0.5, browning);

  R.dilate(14);
  assertBorderClean(R, `makePineShoot(${size}, ${seed}, ${dead})`);
  return R.texture();
}

/**
 * Fail loudly if any mark reaches the canvas border. A clipped alpha cutout is
 * the exact failure mode NOTES.md is about: the texture is correct, the
 * geometry is correct, the material is correct, and the render shows a
 * rectangle. Nothing downstream can detect it, so it is checked here, at the
 * only place that has the alpha channel in hand.
 */
function assertBorderClean(
  R: Raster,
  what: string,
  sides?: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }
) {
  const m = R.borderMaxAlpha(2, sides);
  if (m > 0.02) {
    throw new Error(
      `${what}: alpha ${m.toFixed(3)} on the outermost 2 texels. The drawing is being clipped by ` +
        `the canvas, so the card quad's own edge will render as a straight cut through opaque foliage.`
    );
  }
}

/* ------------------------------------------------------------------ */
/* dry grass / weed cards                                              */
/* ------------------------------------------------------------------ */

export type ScrubKind = "grass" | "weed" | "tuft";

/**
 * Late-summer roadside growth: bleached straw with grey-green still in the
 * base, seed heads gone over, and a proportion of the stems already dead. The
 * palette is deliberately desaturated — the single loudest tell of CG
 * vegetation is a saturated green, and none of these are green above the first
 * third of the blade.
 */
export function makeScrubCard(size = 256, seed = 6001, kind: ScrubKind = "grass"): THREE.DataTexture {
  const rng = seededRng(seed);
  const R = new Raster(size, size);
  const S = size / 256;

  // Deliberately desaturated. Late-summer roadside grass photographs as a
  // warm grey with a straw cast, not as yellow; the first pass authored it at
  // a saturation that read as painted-on cartoon wheat as soon as fifty of
  // them were on screen together.
  const BASE: RGB = [0.300, 0.298, 0.232];
  const MID: RGB = [0.330, 0.318, 0.238];
  const TIP: RGB = [0.452, 0.430, 0.342];
  const DEAD: RGB = [0.298, 0.262, 0.196];
  const GREY_GREEN: RGB = [0.286, 0.312, 0.248];

  const cfg = {
    grass: { blades: 64, len: [0.4, 0.9], arch: 0.6, spread: 1.15, seeds: 0 },
    weed: { blades: 28, len: [0.58, 1.0], arch: 0.22, spread: 0.5, seeds: 14 },
    tuft: { blades: 72, len: [0.2, 0.52], arch: 0.8, spread: 1.4, seeds: 0 },
  }[kind];

  // As for the pine shoot: nothing may reach the border, or the card's own
  // rectangle shows as a straight cut.
  //
  // The bottom edge used to be exempt, on the reasoning that a gap where the
  // clump meets the ground would float every tuft on the site. That was wrong
  // twice over. It is wrong in principle — the base of a real tuft is dark and
  // dense but you can see between the blades, and what hides the join is the
  // ground contact decal, which now exists and did not when the exemption was
  // written. And it was wrong in fact: 104 blades all rooting on one line at
  // 1.5-2 px each is 190 px of blade crammed into 128 px of width, which
  // saturates, and after a 12 px dilate the bottom sixth of the card was a
  // solid opaque slab. Magnified, every tuft on the site stood on a black
  // rectangle with a hard straight bottom edge. It is the same failure as the
  // pine card border, and I had whitelisted it.
  //
  // So the roots are now scattered vertically as well as across, the blade
  // count is down, the dilate is smaller, and the bottom is asserted like every
  // other edge.
  const MARGIN = 3 * S;
  const SEED_HEAD_RISE = 15 * S + 3 * S;

  for (let i = 0; i < cfg.blades; i++) {
    const rootX = size * (0.5 + (rng() - 0.5) * 0.62);
    // Scattered up the first twentieth of the card. A tuft's blades do not all
    // emerge from one point at one height, and pretending they do is what
    // produced the solid base.
    // Clear of the margin *and* of the dilate radius: dilate(8) spreads alpha
    // eight texels in every direction, so a root at the margin still reaches the
    // border. The assertion caught exactly this on the first attempt.
    const rootY = MARGIN + 9 * S + size * rng() * rng() * 0.05;
    const dead = rng() < (kind === "weed" ? 0.4 : 0.26);
    const greyish = rng() < 0.3;
    const headroom = size - MARGIN - rootY - (cfg.seeds && i < cfg.seeds ? SEED_HEAD_RISE : 0);
    const len = Math.min(size * lerp(cfg.len[0], cfg.len[1], clamp01(rng() * rng() + 0.15)), headroom);
    // Cap the lean so the tip lands inside the canvas. A blade that would have
    // leaned further is simply a blade that leans as far as there is room for;
    // letting it run off the edge cut it in half at full alpha.
    const leanWant = (rng() - 0.5) * 2 * cfg.spread;
    const reach = Math.max(1e-3, len * 0.62);
    const leanMax = (size - MARGIN - rootX) / reach;
    const leanMin = (MARGIN - rootX) / reach;
    const lean = Math.max(leanMin, Math.min(leanMax, leanWant));
    // Quadratic bow: the tip falls over further than the middle, which is what
    // separates dry grass from a bundle of wire.
    const tipX = rootX + lean * len * 0.62;
    const tipY = rootY + len * (1 - cfg.arch * Math.abs(lean) * 0.42);
    const ctlX = rootX + lean * len * 0.2;
    const ctlY = rootY + len * 0.72;

    const w0 = (kind === "weed" ? 1.9 : 1.5) * S * (0.7 + rng() * 0.7);
    const segs = 12;
    let px = rootX;
    let py = rootY;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const it = 1 - t;
      const x = it * it * rootX + 2 * it * t * ctlX + t * t * tipX;
      const y = it * it * rootY + 2 * it * t * ctlY + t * t * tipY;
      const t0 = (s - 1) / segs;
      const paint = (tt: number, across: number): RGB => {
        const g = lerp(t0, t, tt);
        let c = g < 0.2 ? mix3(BASE, MID, g / 0.2) : mix3(MID, TIP, (g - 0.2) / 0.8);
        if (dead) c = mix3(c, DEAD, 0.7);
        if (greyish) c = mix3(c, GREY_GREEN, 0.45 * (1 - g * 0.6));
        return mix3(c, [c[0] * 0.62, c[1] * 0.62, c[2] * 0.6], across * across * 0.55);
      };
      R.stroke(px, py, x, y, w0 * (1 - t0 * 0.82), w0 * (1 - t * 0.82), paint);
      px = x;
      py = y;
    }

    if (cfg.seeds && i < cfg.seeds) {
      // Gone-over seed head: a loose spike, not a lollipop.
      const n = 7 + Math.floor(rng() * 6);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const hx = px + (rng() - 0.5) * 5 * S + lean * 5 * S * t;
        const hy = py + t * 15 * S;
        R.blob(hx, hy, 1.7 * S, 2.9 * S, () => mix3(DEAD, TIP, rng() * 0.6), 0.95);
      }
    }
  }

  R.dilate(8);
  assertBorderClean(R, `makeScrubCard(${size}, ${seed}, ${kind})`);
  return R.texture();
}

/* ------------------------------------------------------------------ */
/* bark and timber                                                     */
/* ------------------------------------------------------------------ */

export interface BarkMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  dispose(): void;
}

/**
 * Pine bark: irregular plates separated by deep fissures. Built by stretching
 * a Worley cell field along the trunk axis (plates are much taller than they
 * are wide) and cutting it with an fbm so the fissures wander.
 *
 * V runs up the trunk, so the field is squashed in V rather than U.
 */
export function makePineBark(size = 512, seed = 7001): BarkMaps {
  const rng = seededRng(seed);
  const cells = worley(size, 21, rng);
  const detail = fbm(size, 9, seededRng(seed + 11), { octaves: 5, gain: 0.52 });
  const fine = fbm(size, 34, seededRng(seed + 23), { octaves: 3, gain: 0.55 });
  const stretch = 3.1; // plates this many times taller than wide

  const height = new Float32Array(size * size);
  const alb = new Raster(size, size);
  const rough = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      // Wander the lookup so the fissures are not vertically ruled.
      const wob = (sampleWrapped(detail, size, u * 0.6, v * 0.6) - 0.5) * 0.09;
      const cell = sampleWrapped(cells, size, u + wob, v / stretch + wob * 0.4);
      const d = sampleWrapped(detail, size, u, v);
      const f = sampleWrapped(fine, size, u, v);

      // cell is distance-to-feature: near 0 in a fissure, high on a plate.
      const plate = clamp01((cell - 0.13) / 0.5);
      const fissure = 1 - plate;
      const h = plate * 0.78 + d * 0.16 + f * 0.09 - fissure * 0.32;
      height[i] = clamp01(h * 0.9 + 0.15);

      // Scots/loblolly bark: grey-brown plates, red-brown deep in the cracks,
      // paler and drier where the plate face has weathered.
      const PLATE: RGB = [0.268, 0.226, 0.182];
      const PLATE_PALE: RGB = [0.386, 0.344, 0.290];
      const CRACK: RGB = [0.098, 0.070, 0.052];
      const RUST: RGB = [0.224, 0.130, 0.078];
      let c = mix3(CRACK, mix3(RUST, PLATE, clamp01(plate * 1.5 - 0.15)), clamp01(plate * 1.9));
      c = mix3(c, PLATE_PALE, clamp01((d - 0.5) * 1.5) * plate * 0.75);
      c = mix3(c, [c[0] * 0.8, c[1] * 0.84, c[2] * 0.8], f * 0.3);
      alb.r[i] = c[0];
      alb.g[i] = c[1];
      alb.b[i] = c[2];
      alb.a[i] = 1;

      rough[i] = clamp01(0.98 - plate * 0.14 + fissure * 0.02 - f * 0.06);
    }
  }

  return {
    map: alb.texture({ opaque: true, wrap: true }),
    normalMap: normalTexture(height, size, 2.6, true),
    roughnessMap: greyTexture(rough, size, true),
    dispose() {
      this.map.dispose();
      this.normalMap.dispose();
      this.roughnessMap.dispose();
    },
  };
}

/**
 * Weathered sawn/round timber for fence posts and utility poles: silvered
 * grey with the grain still visible, longitudinal checks, and a creosote
 * darkening low down on the poles.
 */
export function makeTimber(size = 512, seed = 7301): BarkMaps {
  const grain = fbm(size, 4, seededRng(seed), { octaves: 5, gain: 0.55 });
  const fibre = fbm(size, 40, seededRng(seed + 7), { octaves: 3, gain: 0.5 });
  const rot = fbm(size, 6, seededRng(seed + 19), { octaves: 4, gain: 0.6 });
  const rng = seededRng(seed + 31);

  const height = new Float32Array(size * size);
  const alb = new Raster(size, size);
  const rough = new Float32Array(size * size);

  // Longitudinal checks: a handful of splits running with the grain.
  const checks: { u: number; v0: number; v1: number; w: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const v0 = rng();
    checks.push({ u: rng(), v0, v1: v0 + 0.18 + rng() * 0.5, w: 0.004 + rng() * 0.007 });
  }

  const GREY: RGB = [0.398, 0.382, 0.352];
  const GREY_DK: RGB = [0.238, 0.222, 0.202];
  const TAN: RGB = [0.352, 0.294, 0.216];
  const CHECK: RGB = [0.082, 0.070, 0.060];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      // Grain runs along V (up the post), so squash the lookup in V hard.
      const g = sampleWrapped(grain, size, u, v * 0.06);
      const f = sampleWrapped(fibre, size, u, v * 0.12);
      const r = sampleWrapped(rot, size, u, v);

      let h = 0.55 + (g - 0.5) * 0.5 + (f - 0.5) * 0.28;
      let c = mix3(GREY_DK, GREY, clamp01(g * 1.35 - 0.1));
      c = mix3(c, TAN, clamp01((r - 0.56) * 2.6) * 0.7);
      c = mix3(c, [c[0] * 0.86, c[1] * 0.88, c[2] * 0.9], f * 0.35);

      for (const ck of checks) {
        let du = Math.abs(u - ck.u);
        du = Math.min(du, 1 - du);
        const vv = (v - ck.v0) / (ck.v1 - ck.v0);
        if (vv < 0 || vv > 1) continue;
        const taper = Math.sin(vv * Math.PI);
        const inside = clamp01(1 - du / (ck.w * taper + 1e-5));
        if (inside <= 0) continue;
        c = mix3(c, CHECK, inside);
        h -= inside * 0.45;
      }

      height[i] = clamp01(h);
      alb.r[i] = c[0];
      alb.g[i] = c[1];
      alb.b[i] = c[2];
      alb.a[i] = 1;
      rough[i] = clamp01(0.94 - f * 0.08);
    }
  }

  return {
    map: alb.texture({ opaque: true, wrap: true }),
    normalMap: normalTexture(height, size, 1.9, true),
    roughnessMap: greyTexture(rough, size, true),
    dispose() {
      this.map.dispose();
      this.normalMap.dispose();
      this.roughnessMap.dispose();
    },
  };
}

export { type Rng };
