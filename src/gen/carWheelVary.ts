import * as THREE from "three";
import { seededRng } from "./noise.ts";

/**
 * Per-corner weathering variation for the four road wheels.
 *
 * NOTES.md case 22: `applyGrime` samples its noise field as a function of
 * **object-space position**, so any two instances of the same mesh receive
 * byte-identical marks in identical places however much their strengths differ.
 * The four wheels are the worst instance of that in this project - one geometry,
 * one material, four corners - and the instancing probe measured the difference
 * between them at exactly 0.00/255 on `car-alloy`, `car-chrome` and `car-tyre`.
 *
 * Two things that looked like mitigations were not, and both are worth naming so
 * they are not re-attempted:
 *
 * - `hub.rotation.y` does nothing at all here. Rotating the instance does not
 *   change any vertex's object-space position, which is what the field is a
 *   function of, so the grime rotates with the wheel and stays exactly where it
 *   was on the rim.
 * - The two tread phases in `buildTyre` move the field by 3.23/255. They are
 *   different geometry, so this is a real difference rather than a nominal one,
 *   but it is an order of magnitude below the 33-53 that correctly phased
 *   instances measure and sits right on the figure a critic already called
 *   "one asset".
 *
 * So the phase has to be injected, per the one pattern in NOTES.md: a
 * `fieldOffset` in tile units drawn from the corner's own seed via `seededRng`,
 * and an alternating `fieldFlip`.
 *
 * The amplitudes here are the second half of that case. Once marks move, the
 * strengths usually turn out never to have been enough either - the pumps found
 * per-unit tint at +/-3.5% lightness invisible across a 40 cm gap. Four wheels
 * are a harder case still, because they appear in the same frame rather than
 * across a gap, so these are keyed to real asymmetries rather than to noise:
 * fronts carry most of the braking and therefore most of the brake dust, and the
 * kerbside wheels sit in the gutter and collect more road film.
 */
export interface WheelVariation {
  readonly corner: string;
  /** Phase into the grime field, in tile units. Case 22's core fix. */
  readonly fieldOffset: THREE.Vector2;
  /** Mirrors the field in object X, so trails do not all lean the same way. */
  readonly fieldFlip: boolean;
  /** 0..1, heaviest on the front wheels. */
  readonly brakeDust: number;
  /** 0..1, heaviest on the kerbside. */
  readonly roadFilm: number;
  /** Hue rotation in radians, and a lightness multiplier, for the rim albedo. */
  readonly hueShift: number;
  readonly lightness: number;
}

/**
 * `kerbside` is which side of the car faces the kerb in this stall. Reversed
 * for a car backed in, which is why it is a parameter rather than a sign test.
 */
export function wheelVariation(
  w: { front: boolean; x: number; z: number },
  index: number,
  kerbside: 1 | -1 = 1
): WheelVariation {
  // Seeded from the corner's own identity, not from `index` alone: case 16.
  // `seededRng` hashes so that adjacent seeds land far apart, which is the
  // whole point - drawing from consecutive integers with `makeRng` would give
  // four near-identical phases and the fix would appear present and do nothing.
  const r = seededRng(0x0caac0 + index * 977 + (w.front ? 31 : 67));

  // Tile units, so the phase is independent of each material's own `scale` and
  // does not need re-choosing if a material is later re-tuned. Kept clear of
  // whole numbers: the field tiles, so an offset near an integer is no offset.
  //
  // Stratified, not just random: each corner gets its own quadrant of the tile
  // and jitters inside it. A plain seeded draw across the whole tile lets two
  // corners land next to each other by chance, and the first cut of this did -
  // the centre caps measured 27.2/255 on their closest pair against a 33-53
  // band, because a 0.66-wide jitter on a 0.5 quadrant stride overlaps. With a
  // 0.30 jitter on that stride any two corners differ by at least 0.20 tile on
  // at least one axis, whatever the seed does.
  const fieldOffset = new THREE.Vector2(
    (index & 1 ? 0.5 : 0) + 0.1 + r() * 0.3,
    (index & 2 ? 0.5 : 0) + 0.1 + r() * 0.3
  );

  // Front wheels do roughly 70% of the braking on a front-biased road car and
  // the pads throw dust straight at the rim behind them, so the fronts are
  // visibly dirtier than the rears on almost any car in a car park. This is the
  // single most legible asymmetry available in a frame that shows all four.
  const brakeDust = (w.front ? 0.86 : 0.34) * (0.88 + r() * 0.24);

  // The kerbside runs in the gutter, where the standing water and the silt are.
  const kerb = Math.sign(w.x) === kerbside;
  const roadFilm = (kerb ? 0.92 : 0.58) * (0.9 + r() * 0.2);

  // Hue as well as lightness. A set that differs only in value reads as one
  // object under different exposure, which is the same trap one level down -
  // the pumps hit it immediately after fixing their phase.
  const hueShift = (r() - 0.5) * 0.13;
  const lightness = 0.91 + r() * 0.18;

  return {
    corner: `${w.front ? "front" : "rear"}-${w.x < 0 ? "left" : "right"}`,
    fieldOffset,
    fieldFlip: (index & 1) === 1,
    brakeDust,
    roadFilm,
    hueShift,
    lightness,
  };
}

/** Rotate a colour's hue and scale its lightness, in HSL. */
export function varyColour(base: THREE.Color, v: WheelVariation): THREE.Color {
  const c = base.clone();
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + v.hueShift + 1) % 1, hsl.s, THREE.MathUtils.clamp(hsl.l * v.lightness, 0, 1));
  return c;
}
