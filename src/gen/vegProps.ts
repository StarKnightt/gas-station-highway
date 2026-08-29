/**
 * Property-line fence and highway utility poles for System 6.
 *
 * Both exist for the same reason the treeline does: scale. A 1.2 m fence post
 * and a 10 m pole are objects whose size everyone already knows, so putting
 * them at the edge of the lot tells the eye how big the lot is. They also give
 * the scrub something to grow against, which is where roadside weeds actually
 * are.
 *
 * The wires hang in a real catenary. `a * cosh(x / a)` with `a` solved for the
 * requested sag, not a parabola and emphatically not a straight line — a
 * straight wire between two poles is one of those details that nobody can name
 * but everybody can see.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { lerp, seededRng } from "./noise";
import { sweepTube } from "./vegPine";

export interface PropBuild {
  /** Posts, poles, crossarms — takes the weathered timber material. */
  timber: THREE.BufferGeometry;
  /** Insulator caps, steel T-posts, staples — dark weathered metal. */
  metal: THREE.BufferGeometry | null;
  /**
   * Wire runs as polylines rather than as baked tubes. They are drawn by
   * `vegWire`, which gives them a screen-space width floor and coverage-based
   * alpha; a physically-sized conductor is well under a pixel wide at these
   * distances and a tube renders it as a dashed line. See vegWire.ts for the
   * arithmetic.
   */
  wires: THREE.Vector3[][];
  /**
   * Where the uprights are and how thick they are, for collision blockers.
   *
   * Not derivable by a consumer: the timber is merged into one geometry whose
   * bounding box is the whole fence line, which is precisely the reason the
   * player currently walks through it.
   */
  posts?: { x: number; z: number; radius: number }[];
  /** True conductor radius for those runs, metres. */
  wireRadius: number;
}

type Ground = (x: number, z: number) => number;

/* ------------------------------------------------------------------ */
/* catenary                                                            */
/* ------------------------------------------------------------------ */

/**
 * Points along a hanging wire between two suspension points.
 *
 * For a span of half-length `b`, the catenary parameter `a` satisfies
 * `sag = a * (cosh(b / a) - 1)`. That has no closed form, so it is bisected;
 * twenty-eight iterations is exact to well under a millimetre over any span
 * here. Unequal end heights are handled by adding the linear term back on,
 * which is not the exact asymmetric solution but is indistinguishable at the
 * few-degree tilts a fence or a pole line actually has.
 */
export function catenary(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  sag: number,
  segments: number
): THREE.Vector3[] {
  const span = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const out: THREE.Vector3[] = [];
  if (span < 1e-4 || sag <= 1e-5) {
    for (let i = 0; i <= segments; i++) out.push(p0.clone().lerp(p1, i / segments));
    return out;
  }

  const b = span / 2;
  let lo = 1e-3;
  let hi = 1e5;
  for (let i = 0; i < 28; i++) {
    const a = (lo + hi) / 2;
    // sag(a) is monotonically decreasing in a.
    if (a * (Math.cosh(b / a) - 1) > sag) lo = a;
    else hi = a;
  }
  const a = (lo + hi) / 2;
  const top = a * Math.cosh(b / a);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -b + span * t;
    const drop = top - a * Math.cosh(x / a);
    const p = p0.clone().lerp(p1, t);
    p.y -= drop;
    out.push(p);
  }
  return out;
}

/* Wires are no longer swept as tubes: see `PropBuild.wires` and vegWire.ts. */

/* ------------------------------------------------------------------ */
/* fence                                                               */
/* ------------------------------------------------------------------ */

export interface FenceSpec {
  /** Corner points of the fence line in XZ. */
  path: [number, number][];
  spacing: number;
  /** Post height above grade, metres. */
  postHeight: number;
  /** Strand heights as fractions of the post height. */
  strands: number[];
  seed: number;
  ground: Ground;
}

export function buildFence(spec: FenceSpec): PropBuild {
  const rng = seededRng(spec.seed);
  const timber: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];

  interface Post {
    x: number;
    z: number;
    base: number;
    top: THREE.Vector3;
    lean: THREE.Vector3;
    height: number;
    /** A rotted-off post carries no wire above the break. */
    broken: boolean;
    /** Steel T-post, driven in as a repair. Thinner, plumber, no rot. */
    tpost: boolean;
    /** Part of the section that has been pushed over and never put back. */
    downed: boolean;
  }
  const posts: Post[] = [];
  const wires: THREE.Vector3[][] = [];

  // One bay somewhere along the line has been driven over or pushed down by a
  // fallen limb and never repaired. A fence with no such section anywhere on it
  // is a fence that somebody maintains, which is not this site.
  const downedStart = 0.34 + rng() * 0.4;
  const downedEnd = downedStart + 0.05 + rng() * 0.06;

  let walked = 0;
  let totalLen = 0;
  for (let seg = 0; seg < spec.path.length - 1; seg++) {
    totalLen += Math.hypot(spec.path[seg + 1][0] - spec.path[seg][0], spec.path[seg + 1][1] - spec.path[seg][1]);
  }

  for (let seg = 0; seg < spec.path.length - 1; seg++) {
    const [x0, z0] = spec.path[seg];
    const [x1, z1] = spec.path[seg + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / spec.spacing));
    // The last post of a run is the first of the next, so skip it except at
    // the very end; otherwise every corner gets a doubled post.
    const last = seg === spec.path.length - 2 ? n : n - 1;
    for (let i = 0; i <= last; i++) {
      // Spacing jitter of +-30% of a bay. Posts on a farm fence are paced out,
      // not measured, and the previous +-7 cm on a 2.85 m bay was 2.5% — far
      // too regular to read as anything but machine-set.
      const jitter = i === 0 || i === last ? 0 : (rng() - 0.5) * 0.6;
      const t = Math.max(0, Math.min(1, (i + jitter) / n));
      const x = lerp(x0, x1, t) + (rng() - 0.5) * 0.09;
      const z = lerp(z0, z1, t) + (rng() - 0.5) * 0.09;
      const s = (walked + len * t) / totalLen;
      const downed = s > downedStart && s < downedEnd;
      const base = spec.ground(x, z);
      const broken = !downed && rng() < 0.08;
      const tpost = !broken && !downed && rng() < 0.3;
      // Wider height spread. T-posts come in one length and are driven to a
      // consistent depth, so they are the *regular* ones; the timber varies.
      const height =
        spec.postHeight *
        (tpost ? lerp(0.98, 1.06, rng()) : lerp(0.78, 1.14, rng())) *
        (broken ? lerp(0.3, 0.55, rng()) : 1);
      // Old fences lean, and the lean is correlated along a run because the
      // whole line goes over together: a slow wave plus noise.
      const drift = Math.sin((seg * 7 + i) * 0.41) * 0.11 + Math.sin((seg * 3 + i) * 0.13) * 0.06;
      const wob = tpost ? 0.05 : 0.16;
      let lean = new THREE.Vector3(drift + (rng() - 0.5) * wob, 0, (rng() - 0.5) * wob);
      if (downed) {
        // Flat out, in a consistent direction, as if one thing knocked it all
        // the same way.
        const dir = downedStart * 11.3;
        lean = new THREE.Vector3(Math.cos(dir) * (1.3 + rng() * 0.9), 0, Math.sin(dir) * (1.3 + rng() * 0.9));
      }
      posts.push({
        x,
        z,
        base,
        height,
        broken,
        tpost,
        downed,
        lean,
        top: new THREE.Vector3(x + lean.x * height, base + height * (downed ? 0.42 : 1), z + lean.z * height),
      });
    }
    walked += len;
  }

  for (const p of posts) {
    const bot = new THREE.Vector3(p.x, p.base - 0.22, p.z);
    const pts = [bot, bot.clone().lerp(p.top, 0.5), p.top.clone()];
    if (p.tpost) {
      // A steel T-post is much slimmer than a timber one and is the thing that
      // makes a fence line read as repaired rather than as built.
      const r = 0.021 * lerp(0.9, 1.1, rng());
      metal.push(
        sweepTube(pts, [r * 1.5, r, r * 0.95], 5, 0.5, (st, a) => 0.22 * Math.sin(a * 2 + st * 0.3), true)
      );
      continue;
    }
    // Diameter spread of nearly 2:1. Cut posts off a farm woodlot are whatever
    // was to hand.
    const r = 0.052 * lerp(0.68, 1.34, rng());
    timber.push(
      sweepTube(
        pts,
        [r * 1.22, r * 1.02, r * (p.broken ? 1.1 : 0.92)],
        7,
        0.42,
        (st, a) => 0.08 * Math.sin(a * 3 + st * 2.1 + p.x),
        true
      )
    );
  }

  // Wire strands. A strand skips a broken post and spans the gap, which is
  // exactly what a sagging fence does and doubles the sag over that bay.
  for (let si = 0; si < spec.strands.length; si++) {
    const frac = spec.strands[si];
    // Tension history is per strand, not per span: a strand that was strained
    // up tight stays tight for its whole length, and a slack one stays slack.
    // Uniform sag on every span of every strand was one of the critic's notes.
    const strandTension = lerp(0.55, 1.9, rng());
    // One strand is snapped somewhere and hangs from both sides of the break.
    const snapped = si === Math.floor(rng() * spec.strands.length) && rng() < 0.55;
    const snapAt = 0.15 + rng() * 0.7;
    let anchor: Post | null = null;
    let idx = 0;
    for (const p of posts) {
      idx++;
      const h = p.base + p.height * frac;
      if (p.broken) {
        anchor = anchor ?? p;
        continue;
      }
      if (anchor) {
        const a = new THREE.Vector3(
          anchor.x + anchor.lean.x * anchor.height * frac,
          anchor.base + anchor.height * frac * (anchor.downed ? 0.3 : 1),
          anchor.z + anchor.lean.z * anchor.height * frac
        );
        const bpt = new THREE.Vector3(
          p.x + p.lean.x * p.height * frac,
          p.downed ? p.base + p.height * frac * 0.3 : h,
          p.z + p.lean.z * p.height * frac
        );
        const span = a.distanceTo(bpt);
        const frac2 = idx / posts.length;
        if (snapped && Math.abs(frac2 - snapAt) < 0.03) {
          // Broken: two short tails hanging almost vertically off each post
          // rather than a span between them.
          for (const [from, to] of [
            [a, a.clone().addScaledVector(new THREE.Vector3(bpt.x - a.x, 0, bpt.z - a.z).normalize(), 0.5)],
            [bpt, bpt.clone().addScaledVector(new THREE.Vector3(a.x - bpt.x, 0, a.z - bpt.z).normalize(), 0.6)],
          ] as const) {
            const end = to.clone();
            end.y = spec.ground(end.x, end.z) + 0.02;
            wires.push(catenary(from, end, 0.22, 7));
          }
        } else {
          // Slack rises with span and with height up the post: the top wire of
          // a neglected fence is always the loosest.
          const sag =
            span * lerp(0.012, 0.032, frac) * strandTension * lerp(0.85, 1.2, rng()) * (p.downed || anchor.downed ? 3.4 : 1);
          wires.push(catenary(a, bpt, sag, Math.max(5, Math.round(span * 2.6))));
        }
      }
      anchor = p;
    }
  }

  const t = mergeGeometries(timber, false);
  const m = metal.length ? mergeGeometries(metal, false) : null;
  if (!t) throw new Error("buildFence: timber merge failed");
  timber.forEach((g) => g.dispose());
  metal.forEach((g) => g.dispose());
  return {
    timber: t,
    metal: m,
    wires,
    wireRadius: 0.0016,
    // A downed post is lying on the ground and should not stop anyone; a broken
    // stub still can. T-posts are a steel tee about 35 mm across the flange.
    posts: posts
      .filter((p) => !p.downed)
      .map((p) => ({ x: p.x, z: p.z, radius: p.tpost ? 0.021 : 0.062 })),
  };
}

/* ------------------------------------------------------------------ */
/* utility poles                                                       */
/* ------------------------------------------------------------------ */

export interface PoleLineSpec {
  /** Pole positions in XZ, in order along the line. */
  positions: [number, number][];
  height: number;
  seed: number;
  ground: Ground;
}

export function buildPoleLine(spec: PoleLineSpec): PropBuild {
  const rng = seededRng(spec.seed);
  const wires: THREE.Vector3[][] = [];
  const timber: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];

  // Attachment points per pole: three phase conductors on the crossarm plus a
  // lower neutral, matching a plain rural distribution line.
  const attach: THREE.Vector3[][] = [];

  const posts: { x: number; z: number; radius: number }[] = [];

  for (let i = 0; i < spec.positions.length; i++) {
    const [x, z] = spec.positions[i];
    const base = spec.ground(x, z);
    const H = spec.height * lerp(0.94, 1.06, rng());
    // Poles are set by hand and then settle; a couple of degrees out of plumb.
    const tilt = new THREE.Vector3((rng() - 0.5) * 0.035, 0, (rng() - 0.5) * 0.03);

    const at = (h: number) => new THREE.Vector3(x + tilt.x * h, base + h, z + tilt.z * h);

    const shaft = [at(-0.4), at(H * 0.35), at(H * 0.75), at(H)];
    const rb = 0.135;
    // Radius near standing height, where a walker meets it, not at the butt.
    posts.push({ x: x + tilt.x * 1.3, z: z + tilt.z * 1.3, radius: rb * 0.96 });
    timber.push(
      sweepTube(
        shaft,
        [rb * 1.06, rb * 0.9, rb * 0.8, rb * 0.74],
        9,
        0.55,
        (st, a) => 0.035 * Math.sin(a * 4 + st * 1.9 + i),
        true
      )
    );

    // Crossarm, square section approximated with a four-sided sweep. The line
    // runs along X, so the arm runs along Z.
    const armY = H - 0.55;
    const armC = at(armY);
    const armHalf = 1.22;
    const a0 = new THREE.Vector3(armC.x, armC.y, armC.z - armHalf);
    const a1 = new THREE.Vector3(armC.x, armC.y - 0.02, armC.z + armHalf);
    timber.push(sweepTube([a0, armC.clone(), a1], [0.062, 0.062, 0.062], 4, 0.4, () => 0, true));

    // Diagonal braces from the arm back down to the pole.
    for (const s of [-1, 1]) {
      const p0 = new THREE.Vector3(armC.x, armC.y - 0.012, armC.z + s * 0.78);
      const p1 = at(armY - 0.62);
      timber.push(sweepTube([p0, p1], [0.026, 0.026], 4, 0.3, () => 0, true));
    }

    const pts: THREE.Vector3[] = [];
    for (const s of [-1, 0, 1]) {
      const ins = new THREE.Vector3(armC.x, armC.y + 0.075, armC.z + s * 0.86);
      // Pin insulator: a short fat cylinder on top of the arm.
      metal.push(
        sweepTube(
          [ins.clone().setY(armC.y + 0.055), ins.clone().setY(armC.y + 0.14), ins.clone().setY(armC.y + 0.19)],
          [0.028, 0.058, 0.036],
          6,
          0.2,
          () => 0,
          true
        )
      );
      pts.push(ins.clone().setY(armC.y + 0.17));
    }
    // Neutral / service conductor, bolted straight to the pole lower down.
    pts.push(at(H - 1.85).add(new THREE.Vector3(0, 0, 0.14)));
    attach.push(pts);
  }

  for (let i = 0; i < attach.length - 1; i++) {
    for (let w = 0; w < attach[i].length; w++) {
      const a = attach[i][w];
      const b = attach[i + 1][w];
      const span = a.distanceTo(b);
      // Distribution conductors run about 1.5-2.5% sag at this span; the
      // neutral is strung slacker than the phases. Multiplied by a per-span
      // factor: spans are strung at different times by different crews and
      // then creep for decades, so no two on a line match.
      const sag = span * (w === 3 ? 0.032 : 0.019) * lerp(0.75, 1.45, rng());
      // Segment count set from span, not from a constant, so a long span is not
      // a visibly faceted polyline. The ribbon shader widens the wire to a
      // pixel floor, which makes any facetting much easier to see than it was
      // on the old sub-pixel tube.
      wires.push(catenary(a, b, sag, Math.max(24, Math.round(span * 1.4))));
    }
  }

  const t = mergeGeometries(timber, false);
  const m = metal.length ? mergeGeometries(metal, false) : null;
  if (!t) throw new Error("buildPoleLine: timber merge failed");
  timber.forEach((g) => g.dispose());
  metal.forEach((g) => g.dispose());
  // 12 mm: a real 4/0 ACSR distribution conductor. The old geometry used 27 mm
  // to try to survive rasterisation, which is a rope; the width floor in
  // vegWire is the correct place to solve that.
  return { timber: t, metal: m, wires, wireRadius: 0.006, posts };
}
