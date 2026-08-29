/**
 * Bundle entry for tools/vegprofile.mjs. Exposes the horizon band top-edge
 * profile so its period, amplitude and flat runs can be measured numerically
 * rather than judged from a screenshot.
 */
import { envelope, type BandSpec } from "../src/gen/vegDistant";
import { HORIZON_BANDS } from "../src/gen/vegHorizonBands";
import { buildPine } from "../src/gen/vegPine";

/**
 * Foliage card positions for one tree, in tree-local space, so the crown's
 * vertical periodicity and radial symmetry can be measured. The critic's
 * complaint — "regular horizontal whorls at even vertical intervals, radially
 * symmetric" — is a statement about exactly these two numbers.
 */
export function pineCards(seed: number, height: number) {
  const b = buildPine({ seed, height, lean: 0.05, leanDir: 1.0, deadBelow: 0.3, vigour: 0.85 });
  const out = b.cards.map((c) => {
    const p = new Float64Array(3);
    const e = c.matrix.elements;
    p[0] = e[12];
    p[1] = e[13];
    p[2] = e[14];
    return { x: p[0], y: p[1], z: p[2], dead: c.dead };
  });
  const tris = b.wood.index ? b.wood.index.count / 3 : 0;
  b.wood.dispose();
  return { cards: out, height: b.height, crownRadius: b.crownRadius, woodTriangles: tris };
}

export const bands: BandSpec[] = HORIZON_BANDS;

export function profile(spec: BandSpec): { h: number[]; samples: number } {
  const samples = spec.samples ?? 4096;
  const arr = envelope(spec, samples);
  return { h: Array.from(arr), samples };
}

/**
 * The world-space top-edge vertices of a band, exactly as `buildBand` places
 * them — including the radial wander, which changes each sample's distance from
 * the camera and therefore its apparent height. Judging the silhouette from the
 * height array alone misses that entirely.
 */
export function topEdge(spec: BandSpec): { x: number; y: number; z: number }[] {
  const samples = spec.samples ?? 4096;
  const h = envelope(spec, samples);
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r =
      spec.radius +
      spec.radiusVary * (Math.sin(a * 2.3 + spec.seed) * 0.6 + Math.sin(a * 5.9 - spec.seed * 0.7) * 0.4);
    out.push({ x: Math.cos(a) * r, y: h[i], z: Math.sin(a) * r });
  }
  return out;
}
