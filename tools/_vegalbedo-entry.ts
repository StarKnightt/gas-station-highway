/**
 * Effective albedo of every textured vegetation layer, measured rather than read.
 *
 * WHY THIS EXISTS, and it is a specific trap rather than a general tidiness urge.
 *
 * Three times in one session this system has had a colour constant above 1.0 —
 * a surface reflecting more light than reaches it. `DRY` at (1.05, 0.98, 0.78)
 * on the thatch sprigs was a real defect worth two captures. `STRAW` at
 * (1.06, 0.99, 0.83) on the scrub clumps looks like the same defect and **is
 * not one**, because the two constants do different jobs:
 *
 *   sprigs:  material.color = 0xffffff, no map        -> tint IS the albedo
 *   clumps:  material.map = makeScrubCard(...)        -> tint MODULATES the card
 *
 * The card is authored at 0.30-0.45, which is physical, so a tint near 1.0 is a
 * modulation and the product is fine. Reading the constant alone cannot tell
 * those apart, and I nearly "fixed" the second one on the strength of having
 * correctly fixed the first. A constant carried between call sites is only
 * meaningful together with everything it multiplies, so this measures the
 * product and never the constant.
 *
 * Alpha-weighted, because only pixels that survive `alphaTest` are ever seen and
 * an average over the transparent border is an average over nothing.
 */
import * as THREE from "three";
import { makeScrubCard } from "../src/gen/vegTextures";

/** Matches the `alphaTest` the clump and sprig materials ship with. */
const ALPHA_TEST = 0.3;

export interface LayerAlbedo {
  layer: string;
  /** Mean of the map over pixels above `alphaTest`, or null for an untextured layer. */
  cardMean: [number, number, number] | null;
  cardMax: [number, number, number] | null;
  /** Pixels above alphaTest, and the fraction of the card they are. */
  opaquePx: number;
  opaqueFrac: number;
  /** The per-instance tint range this layer applies on top of the map. */
  tintMin: [number, number, number];
  tintMax: [number, number, number];
  /** cardMax * tintMax, i.e. the brightest albedo any pixel of this layer can have. */
  worstAlbedo: [number, number, number];
  /** True if any channel of `worstAlbedo` exceeds 1: a surface that cannot exist. */
  unphysical: boolean;
  /** Whether the tint is the whole albedo (no map) or a modulation of one. */
  tintIs: "the albedo" | "a modulation";
}

function statsOf(tex: THREE.DataTexture): {
  mean: [number, number, number];
  max: [number, number, number];
  px: number;
  frac: number;
} {
  const d = tex.image.data as Uint8Array | Float32Array;
  const n = tex.image.width * tex.image.height;
  const float = d instanceof Float32Array;
  const to01 = (v: number) => (float ? v : v / 255);
  let r = 0, g = 0, b = 0, px = 0;
  const mx: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = to01(d[i * 4 + 3]);
    if (a < ALPHA_TEST) continue;
    const cr = to01(d[i * 4]);
    const cg = to01(d[i * 4 + 1]);
    const cb = to01(d[i * 4 + 2]);
    r += cr; g += cg; b += cb;
    if (cr > mx[0]) mx[0] = cr;
    if (cg > mx[1]) mx[1] = cg;
    if (cb > mx[2]) mx[2] = cb;
    px++;
  }
  const k = px || 1;
  return { mean: [r / k, g / k, b / k], max: mx, px, frac: px / n };
}

export function measure(): LayerAlbedo[] {
  const out: LayerAlbedo[] = [];

  /*
   * The scrub clumps. Tint is `SAGE.lerp(STRAW, m) * lerp(0.78, 1.22, k)`, so
   * the extreme is the brighter of the two endpoints times the brightest
   * multiplier. Mirrored from VegetationSystem rather than imported because
   * those constants are locals inside the scatter closure; if they move, this
   * reports a stale tint and the assertion in the runner says so by comparing
   * the worst albedo against the card it actually measured.
   */
  const STRAW: [number, number, number] = [1.06, 0.99, 0.83];
  const SAGE: [number, number, number] = [0.8, 0.88, 0.76];
  const BRIGHT_MAX = 1.22;
  const BRIGHT_MIN = 0.78;
  const tintHi: [number, number, number] = [
    Math.max(STRAW[0], SAGE[0]) * BRIGHT_MAX,
    Math.max(STRAW[1], SAGE[1]) * BRIGHT_MAX,
    Math.max(STRAW[2], SAGE[2]) * BRIGHT_MAX,
  ];
  const tintLo: [number, number, number] = [
    Math.min(STRAW[0], SAGE[0]) * BRIGHT_MIN,
    Math.min(STRAW[1], SAGE[1]) * BRIGHT_MIN,
    Math.min(STRAW[2], SAGE[2]) * BRIGHT_MIN,
  ];

  for (const kind of ["grass", "weed", "tuft"] as const) {
    const tex = makeScrubCard(256, kind === "grass" ? 6001 : kind === "weed" ? 6113 : 6229, kind);
    const s = statsOf(tex);
    const worst: [number, number, number] = [
      s.max[0] * tintHi[0],
      s.max[1] * tintHi[1],
      s.max[2] * tintHi[2],
    ];
    out.push({
      layer: `scrub-card-${kind}`,
      cardMean: s.mean,
      cardMax: s.max,
      opaquePx: s.px,
      opaqueFrac: s.frac,
      tintMin: tintLo,
      tintMax: tintHi,
      worstAlbedo: worst,
      unphysical: worst.some((v) => v > 1),
      tintIs: "a modulation",
    });
    tex.dispose();
  }

  /*
   * The thatch sprigs. No map at all: `MeshStandardMaterial({ color: 0xffffff })`
   * with a per-instance tint, so the tint is the entire albedo and the same
   * numeric range that is harmless above is a hard defect here. This is the
   * asymmetry the file exists to make visible.
   */
  const SPRIG_DRY: [number, number, number] = [0.44, 0.38, 0.24];
  const SPRIG_GREEN: [number, number, number] = [0.26, 0.36, 0.18];
  const SPRIG_BRIGHT_MAX = 1.15;
  const sprigWorst: [number, number, number] = [
    Math.max(SPRIG_DRY[0], SPRIG_GREEN[0]) * SPRIG_BRIGHT_MAX,
    Math.max(SPRIG_DRY[1], SPRIG_GREEN[1]) * SPRIG_BRIGHT_MAX,
    Math.max(SPRIG_DRY[2], SPRIG_GREEN[2]) * SPRIG_BRIGHT_MAX,
  ];
  out.push({
    layer: "thatch-sprig",
    cardMean: null,
    cardMax: null,
    opaquePx: 0,
    opaqueFrac: 1,
    tintMin: [
      Math.min(SPRIG_DRY[0], SPRIG_GREEN[0]) * 0.7,
      Math.min(SPRIG_DRY[1], SPRIG_GREEN[1]) * 0.7,
      Math.min(SPRIG_DRY[2], SPRIG_GREEN[2]) * 0.7,
    ],
    tintMax: sprigWorst,
    worstAlbedo: sprigWorst,
    unphysical: sprigWorst.some((v) => v > 1),
    tintIs: "the albedo",
  });

  return out;
}

/**
 * Irradiance on a vertical blade versus flat ground, at the scene's sun.
 *
 * Included here because it is the other half of any "why is that plant so much
 * brighter than the dirt" question, and it is a one-line calculation nobody was
 * doing. At a 6.2 degree sun a horizontal surface receives sin(6.2) = 0.108 of
 * the beam and a vertical one facing it receives cos(6.2) = 0.994 — a ratio of
 * about 9.2. So vertical vegetation is an order of magnitude brighter than the
 * ground it stands on, with identical albedo and no defect anywhere. Any fix
 * aimed at "the tufts are too bright" has to get past this number first.
 */
export function sunGeometry(elevationDeg = 6.2): {
  elevationDeg: number;
  groundCos: number;
  verticalCos: number;
  verticalOverGround: number;
} {
  const e = (elevationDeg * Math.PI) / 180;
  const groundCos = Math.sin(e);
  const verticalCos = Math.cos(e);
  return { elevationDeg, groundCos, verticalCos, verticalOverGround: verticalCos / groundCos };
}
