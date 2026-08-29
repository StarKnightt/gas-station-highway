import * as THREE from "three";
import { makeRng } from "./noise";
import { getMaxAnisotropy } from "./textures";
import {
  DRIVEWAYS,
  FORECOURT,
  ISLAND,
  ISLANDS,
  LOW_SPOTS,
  FORCE,
  OVERLAY_REGION,
  PAD,
  PARKING,
  ROAD,
} from "../site";

/**
 * The part of `GroundAccum` this file consumes.
 *
 * Structural typing rather than the full interface, so the overlay states its
 * two dependencies instead of importing a service with nine members and letting
 * a reader guess which are load-bearing.
 */
export interface AccumSource {
  /** Where water stands and does not move. Bimodal 0..1, p50 near zero. */
  grime(x: number, z: number): number;
  /** Where wind and traffic keep the ground clean. Bimodal 0..1, p50 near zero. */
  swept(x: number, z: number): number;
}

export interface SiteOverlay {
  texture: THREE.DataTexture;
  /** World-space min corner (x, z). */
  origin: THREE.Vector2;
  /** World-space size (x, z). */
  size: THREE.Vector2;
}

/**
 * A single non-repeating, world-space map painted over the whole station site.
 *
 *   R = albedo multiplier   (x2, so 128 is neutral)
 *   G = roughness offset    (x1.15, so 128 is neutral)
 *   B = blend toward the dark oil / tar tint
 *   A = dirt-wash coverage: how much shoulder material has crept over the
 *       pavement here. Drives a blend toward the dirt colour, and is the thing
 *       that stops the paved footprint reading as a sticker on the desert.
 *
 * Everything that must live at a *specific place* goes here: tyre polish in the
 * wheel paths, oil under the pumps, tar crack sealant, repair patches, contact
 * grime at the foot of every curb, and the ragged raveled edges. Baking any of
 * this into the tiling detail maps would make it repeat, which is the loudest
 * "this is a game" tell on a large flat surface.
 *
 * The R/G/B layer and the A layer are painted on two separate canvases because
 * a 2D context uses alpha for compositing, so it cannot also carry data.
 */
export function makeSiteOverlay(accum?: AccumSource): SiteOverlay {
  const { minX, maxX, minZ, maxZ } = OVERLAY_REGION;
  const worldW = maxX - minX;
  const worldH = maxZ - minZ;
  /**
   * 3072 -> 2048, which is 45 mm/texel over the 92 m region rather than 30 mm.
   *
   * This was the single largest item in the project's startup: 7.52 s of a
   * 14.4 s terrain init, itself 63.6% of total load. The cost is not the pixel
   * count directly but the `blur()` filter calls, of which there are dozens and
   * two at radii of 70 and 110 px — full-canvas convolutions on two canvases of
   * 6.8 M pixels each. Blur cost falls with both the area and the radius in
   * pixels, so a 1.5x linear reduction is roughly 3.4x off the dominant term.
   *
   * 45 mm/texel is the figure already agreed with the performance agent as safe
   * here, on the reasoning that matters for any resolution decision: name the
   * feature size being protected. This layer carries tyre paths, oil, wash and
   * staining, which live between 0.3 and 3 m, so the smallest real feature is
   * about 7 texels. That is a very different case from the asphalt set, where
   * 3.9 mm/texel against a 7 mm aggregate feature is 1.8 texels and halving
   * would delete the foreground grain a critic explicitly protected.
   *
   * Worth noting for anyone editing this file: several authored blur radii —
   * `m(0.012)`, `m(0.02)`, `m(0.03)` — were already below one pixel at 3072 and
   * so were doing nothing at all. They are sub-texel content in a channel that
   * cannot hold them, which is the same defect found in the dirt height map, and
   * they should be either removed or raised rather than quietly scaled again.
   */
  const W = 2048;
  const H = Math.round((W * worldH) / worldW / 2) * 2;
  const ppm = W / worldW;

  const mkCanvas = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  };

  const rgbCanvas = mkCanvas();
  const gritCanvas = mkCanvas();
  const ctx = rgbCanvas.getContext("2d")!;
  const gctx = gritCanvas.getContext("2d")!;

  const px = (x: number) => (x - minX) * ppm;
  const py = (z: number) => (z - minZ) * ppm;
  const m = (v: number) => v * ppm;

  /** mult: albedo multiplier, dr: roughness delta, tint: 0..1 oil tint. */
  const ov = (mult: number, dr: number, tint: number, alpha = 1) => {
    const r = Math.round(Math.min(255, Math.max(0, (mult / 2) * 255)));
    const g = Math.round(Math.min(255, Math.max(0, (0.5 + dr / 1.15) * 255)));
    const b = Math.round(Math.min(255, Math.max(0, tint * 255)));
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const rng = makeRng(20240117);

  for (const c of [ctx, gctx]) {
    c.lineCap = "round";
    c.lineJoin = "round";
  }
  ctx.fillStyle = ov(1, 0, 0);
  ctx.fillRect(0, 0, W, H);
  gctx.fillStyle = "#000";
  gctx.fillRect(0, 0, W, H);

  const blur = (c: CanvasRenderingContext2D, n: number) => {
    c.filter = n > 0 ? `blur(${n}px)` : "none";
  };

  /* ------------------------------------------------------------------ */
  /* 1. broad tonal drift + sun bleaching                                */
  /* ------------------------------------------------------------------ */

  blur(ctx, 70);
  for (let i = 0; i < 40; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const r = m(4 + rng() * 16);
    const light = rng() < 0.5;
    ctx.fillStyle = ov(light ? 1.2 : 0.8, light ? 0.05 : -0.03, 0, 0.55);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + rng()), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sun bleaching: the open middle of the lot has been baked pale grey for
  // years, while the edges under the (future) canopy and along the curb line
  // stay darker. This is the single largest-scale value break on the asphalt.
  blur(ctx, 110);
  const bleachCx = px((PAD.minX + PAD.maxX) / 2 + 3);
  const bleachCy = py((PAD.minZ + PAD.maxZ) / 2);
  const bleach = ctx.createRadialGradient(bleachCx, bleachCy, m(2), bleachCx, bleachCy, m(26));
  bleach.addColorStop(0, ov(1.42, 0.12, 0, 0.9));
  bleach.addColorStop(0.55, ov(1.22, 0.07, 0, 0.6));
  bleach.addColorStop(1, ov(1, 0, 0, 0));
  ctx.fillStyle = bleach;
  ctx.fillRect(0, 0, W, H);

  /* ------------------------------------------------------------------ */
  /* 2. tyre wheel paths                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * A driven path: two polished ribbons 1.7 m apart with a dustier, lighter
   * strip between them and dark rubber build-up right in the tyre line. The
   * critic was right that this does more than any texture upgrade, so it is
   * deliberately painted at high contrast.
   */
  const drivenPath = (pts: [number, number][], gauge: number, strength: number) => {
    const curve = (c: CanvasRenderingContext2D, offset: number) => {
      c.beginPath();
      // Offset each point along its local normal so the pair stays parallel.
      const out: [number, number][] = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        return [p[0] - (dz / l) * offset, p[1] + (dx / l) * offset];
      });
      c.moveTo(px(out[0][0]), py(out[0][1]));
      for (let i = 1; i < out.length - 1; i++) {
        const xc = (out[i][0] + out[i + 1][0]) / 2;
        const zc = (out[i][1] + out[i + 1][1]) / 2;
        c.quadraticCurveTo(px(out[i][0]), py(out[i][1]), px(xc), py(zc));
      }
      c.lineTo(px(out[out.length - 1][0]), py(out[out.length - 1][1]));
      c.stroke();
    };

    if (FORCE.driven) {
      // Visibility probe: one unmissable black ribbon per wheel, no blur.
      for (const side of [-1, 1]) {
        blur(ctx, 0);
        ctx.strokeStyle = ov(0, -0.5, 1, 1);
        ctx.lineWidth = m(0.55);
        curve(ctx, (side * gauge) / 2);
      }
      return;
    }

    // Dusty, sun-bleached strip between and just outside the wheels.
    blur(ctx, m(0.5));
    ctx.strokeStyle = ov(1.22, 0.1, 0, 0.5 * strength);
    ctx.lineWidth = m(gauge + 1.5);
    curve(ctx, 0);

    for (const side of [-1, 1]) {
      // Wide polished halo.
      blur(ctx, m(0.3));
      ctx.strokeStyle = ov(0.75, -0.16, 0.2, 0.78 * strength);
      ctx.lineWidth = m(0.66);
      curve(ctx, (side * gauge) / 2);
      // Dark rubber core, noticeably smoother than the surrounding aggregate.
      blur(ctx, m(0.08));
      ctx.strokeStyle = ov(0.57, -0.32, 0.4, 0.88 * strength);
      ctx.lineWidth = m(0.3);
      curve(ctx, (side * gauge) / 2);
    }
  };

  // Highway: both lanes, running the full width of the overlay. (The rest of
  // the 680 m road is handled analytically in the shader, see wheelPaths.)
  for (const lc of [-ROAD.laneWidth / 2, ROAD.laneWidth / 2]) {
    drivenPath(
      [
        [minX - 4, lc],
        [-20, lc + 0.05],
        [10, lc - 0.04],
        [maxX + 4, lc],
      ],
      1.8,
      0.55
    );
  }

  const islandZ = ISLANDS.map((i) => i.cz);
  const laneZ = (islandZ[0] + islandZ[1]) / 2;

  // Turn-ins from the highway through both driveways, on to the fuel lanes.
  for (let d = 0; d < DRIVEWAYS.length; d++) {
    const dw = DRIVEWAYS[d];
    const cx = (dw.minX + dw.maxX) / 2;
    const inbound = d === 0 ? -1 : 1;
    drivenPath(
      [
        [cx - inbound * 9, 1.6],
        [cx - inbound * 3.4, 4.4],
        [cx, 8.6],
        [cx + inbound * 1.6, 12.4],
        [cx + inbound * 6, laneZ - 2.4],
        [cx + inbound * 11, laneZ],
      ],
      1.75,
      0.85
    );
  }

  // Fuelling lanes either side of each island, and the through lane between.
  for (const z of [islandZ[0] - 1.95, islandZ[0] + 1.95, islandZ[1] - 1.95, islandZ[1] + 1.95]) {
    drivenPath(
      [
        [-21, z],
        [-8, z + 0.06],
        [8, z - 0.05],
        [23, z],
      ],
      1.75,
      0.95
    );
  }
  drivenPath(
    [
      [-22, laneZ],
      [0, laneZ + 0.1],
      [23, laneZ],
    ],
    1.8,
    0.7
  );

  // Route round to the parking row.
  drivenPath(
    [
      [16, 13.5],
      [20.5, 20],
      [21.5, 27],
      [19.5, 31],
    ],
    1.75,
    0.6
  );

  // Each parking stall has been reversed out of a few thousand times.
  for (let i = 0; i < PARKING.count; i++) {
    const x = PARKING.originX + (i + 0.5) * PARKING.stallWidth;
    drivenPath(
      [
        [x, PARKING.z0 - 2.2],
        [x, PARKING.z0 + 1.6],
        [x + (rng() - 0.5) * 0.3, PARKING.z0 + PARKING.depth - 0.7],
      ],
      1.7,
      0.45 + rng() * 0.2
    );
  }

  /* ------------------------------------------------------------------ */
  /* 3. asphalt repair patches and utility cuts                           */
  /* ------------------------------------------------------------------ */

  // Hard rectangular seams. The shader also uses the tone deviation here to
  // swap to a rotated/rescaled sample of the aggregate map, so a patch reads as
  // a different mix, not just a different tone.
  const patch = (
    x: number,
    z: number,
    w: number,
    h: number,
    rot: number,
    mult: number,
    dr: number
  ) => {
    ctx.save();
    ctx.translate(px(x), py(z));
    ctx.rotate(rot);
    if (FORCE.patch) {
      // Visibility probe: flat black rectangle, no seam, no blur.
      blur(ctx, 0);
      ctx.fillStyle = ov(0, -0.5, 1, 1);
      ctx.fillRect(-m(w) / 2, -m(h) / 2, m(w), m(h));
      ctx.restore();
      return;
    }
    blur(ctx, m(0.03));
    ctx.fillStyle = ov(mult, dr, mult < 1 ? 0.18 : 0.02, 0.92);
    ctx.fillRect(-m(w) / 2, -m(h) / 2, m(w), m(h));
    // A skin patch is a different mix laid years apart from the mat around it,
    // so the stone in it reads at a different size and contrast. Without that
    // change of grain a patch is just a soft tonal blob, which is exactly how
    // these were being read. Clipped to the cut so the edge stays hard.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-m(w) / 2, -m(h) / 2, m(w), m(h));
    ctx.clip();
    blur(ctx, m(0.012));
    const coarse = mult < 1; // dark patches are the coarser, newer mix
    for (let i = 0, n = Math.round(w * h * 45); i < n; i++) {
      const sx = (rng() - 0.5) * m(w);
      const sz = (rng() - 0.5) * m(h);
      const lit = rng() < 0.45;
      const g = coarse ? 1 : 0.62;
      ctx.fillStyle = FORCE.aggro
        ? ov(lit ? 3 : 0, 0, 0, 1)
        : ov(lit ? 1 + 0.34 * g + rng() * 0.2 : 1 - 0.3 * g - rng() * 0.12, lit ? 0.05 : -0.04, 0, 0.3 + rng() * 0.4);
      ctx.beginPath();
      ctx.ellipse(sx, sz, m((0.016 + rng() * 0.05) * g), m((0.013 + rng() * 0.038) * g), rng() * 3.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // The seam: tar-filled, darker and glossier than either side.
    blur(ctx, m(0.02));
    ctx.strokeStyle = ov(0.34, -0.12, 0.7, 0.98);
    ctx.lineWidth = Math.max(2, m(0.1));
    ctx.strokeRect(-m(w) / 2, -m(h) / 2, m(w), m(h));
    // Bleed of sealant that squeezed out of the seam.
    blur(ctx, m(0.1));
    ctx.strokeStyle = ov(0.72, -0.08, 0.3, 0.55);
    ctx.lineWidth = m(0.22);
    ctx.strokeRect(-m(w) / 2, -m(h) / 2, m(w), m(h));
    ctx.restore();
  };

  patch(-16.5, 11.2, 5.4, 3.1, 0.03, 0.66, 0.14);
  patch(8.0, 29.5, 6.8, 4.2, -0.02, 1.34, -0.06);
  patch(-4.0, 34.0, 3.6, 2.4, 0.05, 0.7, 0.1);
  patch(20.0, 12.5, 4.2, 5.0, 0.01, 1.26, 0.08);
  patch(-9.5, 21.0, 2.2, 2.2, -0.04, 0.62, 0.16);
  patch(13.0, 35.6, 3.0, 5.4, 0.02, 1.3, -0.04);
  // A long utility cut trench, backfilled darker and settled.
  patch(2.0, 9.6, 34.0, 1.05, 0.004, 0.6, 0.12);
  patch(24.2, 24.0, 1.0, 22.0, 0.0, 0.68, 0.1);
  // And one across the highway, the classic water-main scar.
  patch(-31.0, 0, 1.15, 11.5, 0.01, 0.64, 0.13);

  /**
   * Cold-patch: a shovelled-in pothole repair. Unlike a machine-laid skin patch
   * these have no straight edges at all - an irregular blob of coarse, dark,
   * under-compacted mix sitting proud of the surrounding surface, usually with
   * a ring of loose stones that never bonded.
   */
  const coldPatch = (cx: number, cz: number, r: number, mult: number) => {
    const lobes = 7 + Math.floor(rng() * 5);
    const edge: [number, number][] = [];
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const rr = r * (0.6 + rng() * 0.75);
      edge.push([cx + Math.cos(a) * rr, cz + Math.sin(a) * rr * 0.8]);
    }
    const trace = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.moveTo(px(edge[0][0]), py(edge[0][1]));
      for (let i = 1; i <= edge.length; i++) {
        const p = edge[i % edge.length];
        const q = edge[(i + 1) % edge.length];
        c.quadraticCurveTo(px(p[0]), py(p[1]), px((p[0] + q[0]) / 2), py((p[1] + q[1]) / 2));
      }
      c.closePath();
    };
    blur(ctx, m(0.04));
    ctx.fillStyle = ov(mult, 0.12, 0.1, 0.94);
    trace(ctx);
    ctx.fill();
    // Loose aggregate thrown clear of the repair by traffic.
    blur(ctx, m(0.02));
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2;
      const d = r * (1.0 + rng() * 1.5);
      ctx.fillStyle = ov(1.3 + rng() * 0.3, 0.06, 0, 0.3 + rng() * 0.4);
      ctx.beginPath();
      ctx.arc(px(cx + Math.cos(a) * d), py(cz + Math.sin(a) * d * 0.8), m(0.02 + rng() * 0.035), 0, Math.PI * 2);
      ctx.fill();
    }
    blur(ctx, 0);
  };

  // The highway itself was carrying one crack-seal line and nothing else, which
  // is why `approach` read as a single poured slab. A road this age is a quilt:
  // skin patches over rutted wheel paths, shovelled pothole fills, and utility
  // cuts that have each settled by a different amount.
  patch(-14.0, -1.9, 15.0, 3.3, 0.002, 0.72, 0.1); // lane-width skin patch
  patch(26.0, 1.85, 11.0, 3.4, -0.003, 1.22, -0.05); // older, sun-bleached one
  patch(4.0, -3.6, 6.5, 1.5, 0.004, 0.68, 0.12); // shoulder edge repair
  patch(-46.0, 0.4, 1.0, 9.0, 0.0, 0.66, 0.11); // second utility cut
  patch(38.0, -0.6, 1.3, 8.2, 0.008, 1.18, 0.06);
  for (const [cx, cz, r, mult] of [
    [-6.5, -0.95, 0.62, 0.56],
    [-5.2, -1.15, 0.4, 0.6],
    [17.0, 1.05, 0.75, 0.54],
    [31.5, -1.9, 0.5, 0.58],
    [-24.0, 2.6, 0.55, 0.62],
    [9.5, 22.4, 0.68, 0.58],
    [-18.0, 30.2, 0.5, 0.6],
  ] as const) {
    coldPatch(cx, cz, r, mult);
  }

  /* ------------------------------------------------------------------ */
  /* 4. tar crack sealant                                                 */
  /* ------------------------------------------------------------------ */

  const inForecourt = (x: number, z: number) =>
    x > FORECOURT.minX - 0.4 && x < FORECOURT.maxX + 0.4 && z > FORECOURT.minZ - 0.4 && z < FORECOURT.maxZ + 0.4;

  /**
   * Glossy black sealant worms. Drawn as a dull bleed halo, then a very dark
   * low-roughness bead, then a fine highlight along one side so the bead reads
   * as raised rather than as a painted line.
   */
  const sealantWalk = (
    sx: number,
    sz: number,
    dir0: number,
    steps: number,
    wander: number,
    widthM: number,
    depth: number
  ) => {
    let x = sx;
    let z = sz;
    let d = dir0;
    const pts: [number, number][] = [[x, z]];
    for (let s = 0; s < steps; s++) {
      d += (rng() - 0.5) * wander;
      x += Math.cos(d) * 0.55;
      z += Math.sin(d) * 0.55;
      pts.push([x, z]);
      if (depth < 2 && rng() < 0.045) {
        sealantWalk(x, z, d + (rng() < 0.5 ? 1 : -1) * (0.7 + rng()), steps * 0.35, wander * 1.4, widthM * 0.65, depth + 1);
      }
    }
    // Concrete does not get tar worms: it cracks at its joints instead.
    if (pts.some((p) => inForecourt(p[0], p[1]))) return;

    const stroke = (w: number, style: string, dx = 0, dy = 0) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = Math.max(1, m(w));
      ctx.beginPath();
      ctx.moveTo(px(pts[0][0]) + dx, py(pts[0][1]) + dy);
      for (const p of pts) ctx.lineTo(px(p[0]) + dx, py(p[1]) + dy);
      ctx.stroke();
    };
    blur(ctx, m(0.12));
    stroke(widthM * 2.4, ov(0.84, 0.05, 0.16, 0.4));
    blur(ctx, m(0.018));
    stroke(widthM, ov(0.26, -0.18, 0.92, 0.96));
    // Sunlit shoulder of the bead. The sun is low in the WSW, so the lit side
    // faces -x / -z; a one-sided sliver sells the 3 mm of relief for free.
    blur(ctx, m(0.012));
    stroke(widthM * 0.26, ov(0.95, -0.1, 0.2, 0.28), -m(widthM * 0.4), -m(widthM * 0.4));
  };

  for (let i = 0; i < 22; i++) {
    const onRoad = rng() < 0.45;
    const sx = onRoad ? minX + rng() * worldW : PAD.minX + rng() * (PAD.maxX - PAD.minX);
    const sz = onRoad ? (rng() < 0.5 ? -1 : 1) * rng() * ROAD.halfPaved : PAD.minZ + rng() * (PAD.maxZ - PAD.minZ);
    sealantWalk(sx, sz, rng() * Math.PI * 2, 16 + rng() * 40, 0.5, 0.042 + rng() * 0.035, 0);
  }
  // Long transverse thermal cracks across the highway, sealed years apart.
  for (let i = 0; i < 12; i++) {
    const sx = minX + rng() * worldW;
    sealantWalk(sx, -ROAD.halfPaved, Math.PI / 2 + (rng() - 0.5) * 0.35, 20, 0.16, 0.045 + rng() * 0.03, 2);
  }
  // Longitudinal joint crack down the highway centreline: always the first to go.
  for (let i = 0; i < 4; i++) {
    sealantWalk(minX + (i * worldW) / 4, (rng() - 0.5) * 0.25, 0.02, 70, 0.09, 0.05, 2);
  }
  // Map cracking around the oldest corner of the lot.
  for (let i = 0; i < 9; i++) {
    sealantWalk(PAD.minX + 1.5 + rng() * 7, PAD.maxZ - 1.5 - rng() * 7, rng() * 6.28, 10 + rng() * 12, 0.9, 0.035, 1);
  }

  /* ------------------------------------------------------------------ */
  /* 5. fuel and oil staining at the islands                              */
  /* ------------------------------------------------------------------ */

  blur(ctx, m(0.09));
  for (const isl of ISLANDS) {
    for (const side of [-1, 1]) {
      const z = isl.cz + side * (ISLAND.width / 2 + 1.35);
      for (let s = 0; s < 4; s++) {
        const x = isl.cx - ISLAND.length / 2 + 1.1 + (s / 3) * (ISLAND.length - 2.2) + (rng() - 0.5) * 0.5;
        const strength = 0.45 + rng() * 0.5;
        ctx.fillStyle = ov(0.28, -0.26, 0.95, strength);
        ctx.beginPath();
        ctx.ellipse(px(x), py(z), m(0.3 + rng() * 0.26), m(0.22 + rng() * 0.2), rng() * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = ov(0.55, -0.14, 0.5, strength * 0.6);
        ctx.beginPath();
        ctx.ellipse(px(x), py(z), m(1.0 + rng() * 0.9), m(0.8 + rng() * 0.6), rng() * 3, 0, Math.PI * 2);
        ctx.fill();
        for (let k = 0; k < 20; k++) {
          ctx.fillStyle = ov(0.36, -0.3, 0.75, 0.25 + rng() * 0.45);
          ctx.beginPath();
          ctx.arc(px(x + (rng() - 0.5) * 2.6), py(z + (rng() - 0.5) * 2.0), m(0.015 + rng() * 0.06), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 5b. tyre scrub at the stances, and the kerb grime band               */
  /* ------------------------------------------------------------------ */

  /**
   * Added after a walking-height capture showed the forecourt reading as
   * near-uniform mid-grey at frame scale while a 1:1 crop of the same frame
   * clearly carried stain detail.
   *
   * The diagnosis is worth keeping, because the obvious reading was wrong. A
   * byte-level scan of this map (`tools/overlayscan.mjs`) found the forecourt is
   * already the *dirtiest* surface on the site — oil-tint channel averaging 33
   * against the asphalt lot's 11, and 100% coverage at the island stances — so
   * the forecourt was never undirtied and painting more grime of the same kind
   * would have changed nothing visible.
   *
   * What it lacks is **structure at the scale the eye reads**. Four stances per
   * island side, each with a 1.0-1.9 m soft halo at 2.6 m spacing, means the
   * halos overlap and sum to a continuous wash: hence 100% coverage and no
   * local contrast. A wash of any depth reads as "slightly different concrete".
   * The fix is features at 1-4 m with hard edges, not more area at low contrast.
   *
   * So: tyre scrub. A car on a forecourt does not drive straight through, which
   * is what the fuelling-lane paths above depict. It swings in off the lane,
   * stops with its wheels turned, and swings out — and rubber laid down by a
   * tyre scrubbing sideways under load is the highest-contrast mark on any
   * forecourt. Curved, short, and dark, which is exactly the missing scale.
   */
  const stanceScrub = () => {
    for (const isl of ISLANDS) {
      for (const side of [-1, 1]) {
        const z = isl.cz + side * (ISLAND.width / 2 + 1.35);
        for (let s = 0; s < 4; s++) {
          const x = isl.cx - ISLAND.length / 2 + 1.1 + (s / 3) * (ISLAND.length - 2.2);
          // Which way this driver came from. Both happen; alternating rather
          // than randomising keeps the marks from clumping on one side.
          const from = s % 2 === 0 ? -1 : 1;

          // The swing-in: off the through lane, curving to the stance and
          // stopping. Short, so it reads as an arc and not as a lane.
          //
          // Deliberately NOT `drivenPath`. That helper paints a dusty, sun
          // bleached strip at 1.22x albedo across `gauge + 1.5` m, which is
          // correct for an open lane where the ground between the wheel tracks
          // really is paler. Sixteen of them layered over the stances flooded
          // the area with light wash instead: measured, it *lowered* stance oil
          // tint from 63 to 50 and raised the 5th-percentile albedo from 88 to
          // 94, so the first version of this section reduced the very contrast
          // it was added to create. Two dark ribbons and no centre strip.
          const swing: [number, number][] = [
            [x + from * 7.4, isl.cz + side * 0.4],
            [x + from * 4.2, z - side * 0.55],
            [x + from * 1.6, z + 0.05],
            [x - from * 0.9, z],
          ];
          for (const wheel of [-1, 1]) {
            for (const [w, tone, tint, alpha, bl] of [
              [0.6, 0.86, 0.2, 0.34, 0.2],
              [0.26, 0.62, 0.42, 0.66, 0.05],
            ] as const) {
              blur(ctx, m(bl));
              ctx.strokeStyle = ov(tone, -0.18, tint, alpha * (0.7 + rng() * 0.4));
              ctx.lineWidth = m(w);
              ctx.beginPath();
              const off = (wheel * 1.72) / 2;
              // Offset along the local normal, same construction as
              // `drivenPath`'s `curve`, so the pair stays parallel round the bend.
              const out = swing.map((p, i) => {
                const a = swing[Math.max(0, i - 1)];
                const b = swing[Math.min(swing.length - 1, i + 1)];
                const dx = b[0] - a[0];
                const dz = b[1] - a[1];
                const l = Math.hypot(dx, dz) || 1;
                return [p[0] - (dz / l) * off, p[1] + (dx / l) * off] as [number, number];
              });
              ctx.moveTo(px(out[0][0]), py(out[0][1]));
              for (let i = 1; i < out.length - 1; i++) {
                const xc = (out[i][0] + out[i + 1][0]) / 2;
                const zc = (out[i][1] + out[i + 1][1]) / 2;
                ctx.quadraticCurveTo(px(out[i][0]), py(out[i][1]), px(xc), py(zc));
              }
              ctx.lineTo(px(out[out.length - 1][0]), py(out[out.length - 1][1]));
              ctx.stroke();
            }
          }

          // The scrub proper: a tight arc where the wheels were turned at
          // walking pace. Painted directly rather than through `drivenPath`
          // because there is no dusty centre strip to a scrub mark - it is one
          // tyre, sideways, and the whole point is that it is a hard dark line.
          const arcs = 2 + Math.floor(rng() * 3);
          for (let a = 0; a < arcs; a++) {
            const r = 2.2 + rng() * 3.4;
            const cx = x - from * (0.6 + rng() * 1.8);
            const cz = z + side * (r - 0.15 - rng() * 0.3);
            const a0 = -Math.PI / 2 - side * 0.5 + (rng() - 0.5) * 0.5;
            const sweep = (0.34 + rng() * 0.42) * -side * from;
            for (const [w, tone, tint, alpha, bl] of [
              [0.42, 0.82, 0.16, 0.4, 0.22],
              [0.17, 0.58, 0.44, 0.72, 0.05],
            ] as const) {
              blur(ctx, m(bl));
              ctx.strokeStyle = ov(tone, -0.2, tint, alpha * (0.6 + rng() * 0.5));
              ctx.lineWidth = m(w);
              ctx.beginPath();
              ctx.arc(px(cx), py(cz), m(r), a0, a0 + sweep, sweep < 0);
              ctx.stroke();
            }
          }
        }
      }
    }
  };
  if (!FORCE.noscrub) stanceScrub();

  /**
   * The grime band along the kerb line, where a sweeper never reaches.
   *
   * The scan said the kerb is *cleaner* than the forecourt it borders — oil tint
   * 22 against 33 — which is backwards. Grit, leaf litter and washed fines pile
   * against a vertical face and stay there.
   *
   * `grime` and `swept` are consumed here rather than assumed, and they are
   * consumed as **normalised lerp weights, not as bare multipliers**. Both are
   * bimodal 0..1 with a p50 near zero and a p95 near one, so a bare multiply
   * would leave most of the band untouched and then saturate a few metres of it
   * — and Building found the same mistake with `fines` making a wall *cleaner*.
   * Normalising against p95 rather than the max keeps a single outlier from
   * setting the scale for the whole band.
   */
  const P95 = 0.95;
  const bandWeight = (x: number, z: number) => {
    if (!accum) return 0.55;
    const g = Math.min(1, accum.grime(x, z) / P95);
    const s = Math.min(1, accum.swept(x, z) / P95);
    // Standing water deposits, sweeping and traffic remove. Floored rather than
    // allowed to reach zero: a band that vanishes in places reads as a dashed
    // line, and the physical claim is "less here", not "none here".
    return Math.max(0.18, 0.3 + 0.7 * g - 0.45 * s);
  };

  if (!FORCE.nokerb) {
    // The forecourt's two long kerb lines, plus the pad edge behind the pumps.
    const runs: [number, number, number, number][] = [
      [FORECOURT.minX + 0.1, FORECOURT.minZ + 0.6, FORECOURT.minX + 0.1, FORECOURT.maxZ - 0.6],
      [FORECOURT.maxX - 0.1, FORECOURT.minZ + 0.6, FORECOURT.maxX - 0.1, FORECOURT.maxZ - 0.6],
    ];
    for (const [x1, z1, x2, z2] of runs) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      // Stepped rather than stroked, so the weight can vary along the run. A
      // single stroke could only carry one value and would be a stripe.
      const steps = Math.max(8, Math.round(len / 0.55));
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const x = x1 + (x2 - x1) * t;
        const z = z1 + (z2 - z1) * t;
        const w = bandWeight(x, z);
        // Inward from the kerb face: fines pile up against it and thin out.
        const inward = x < 0 ? 1 : -1;
        for (const [off, wide, tone, alpha] of [
          [0.62, 1.15, 0.88, 0.34],
          [0.2, 0.44, 0.72, 0.6],
        ] as const) {
          blur(ctx, m(0.16));
          ctx.fillStyle = ov(tone, 0.06, 0.22, alpha * w);
          ctx.beginPath();
          ctx.ellipse(
            px(x + inward * off),
            py(z),
            m(wide * 0.5),
            m(0.42 + rng() * 0.3),
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 6. contact grime at the foot of every vertical edge                  */
  /* ------------------------------------------------------------------ */

  // Cheap ambient occlusion. Anything standing on the pavement has a dark,
  // dusty, never-swept line where it meets the ground; without it, curbs and
  // islands read as objects hovering near the surface rather than cast into it.
  const contact = (x1: number, z1: number, x2: number, z2: number, reach = 0.42) => {
    for (const [w, a, mult] of FORCE.ao
      ? ([[2.0, 1, 0]] as [number, number, number][])
      : [
      [reach * 2.6, 0.3, 0.86],
      [reach, 0.55, 0.7],
      [reach * 0.4, 0.7, 0.58],
    ]) {
      blur(ctx, FORCE.ao ? 0 : m(w * 0.45));
      ctx.strokeStyle = ov(mult, 0.06, 0.12, a);
      ctx.lineWidth = m(w);
      ctx.beginPath();
      ctx.moveTo(px(x1), py(z1));
      ctx.lineTo(px(x2), py(z2));
      ctx.stroke();
    }
  };

  const contactRect = (r: { minX: number; maxX: number; minZ: number; maxZ: number }, reach: number) => {
    contact(r.minX, r.minZ, r.maxX, r.minZ, reach);
    contact(r.minX, r.maxZ, r.maxX, r.maxZ, reach);
    contact(r.minX, r.minZ, r.minX, r.maxZ, reach);
    contact(r.maxX, r.minZ, r.maxX, r.maxZ, reach);
  };

  for (const isl of ISLANDS) {
    contactRect(
      {
        minX: isl.cx - ISLAND.length / 2,
        maxX: isl.cx + ISLAND.length / 2,
        minZ: isl.cz - ISLAND.width / 2,
        maxZ: isl.cz + ISLAND.width / 2,
      },
      0.34
    );
  }
  // Inside face of the perimeter curbs, minus the driveway openings.
  {
    const gaps = [...DRIVEWAYS].sort((a, b) => a.minX - b.minX);
    let cursor = PAD.minX;
    for (const g of gaps) {
      contact(cursor, PAD.minZ, g.minX, PAD.minZ, 0.5);
      cursor = g.maxX;
    }
    contact(cursor, PAD.minZ, PAD.maxX, PAD.minZ, 0.5);
    contact(PAD.minX, PAD.maxZ, PAD.maxX, PAD.maxZ, 0.5);
    contact(PAD.minX, PAD.minZ, PAD.minX, PAD.maxZ, 0.5);
    contact(PAD.maxX, PAD.minZ, PAD.maxX, PAD.maxZ, 0.5);
  }
  // Where two pours meet there is a construction joint, not a value step: a
  // dirt-packed gap a finger wide, a bruised band of ravelled asphalt butted up
  // against it, and a paler lip on the concrete side where the edge has spalled.
  const coldJoint = (x1: number, z1: number, x2: number, z2: number) => {
    const wobble = (t: number, k: number) =>
      (Math.sin(t * k) * 0.5 + Math.sin(t * k * 2.7 + 1.3) * 0.3 + Math.sin(t * k * 6.1 + 4.2) * 0.2) * 0.075;
    const steps = Math.max(8, Math.round(Math.hypot(x2 - x1, z2 - z1) * 2));
    for (const [w, mult, alpha, bl] of [
      [0.9, 0.9, 0.5, 0.3],
      [0.34, 0.74, 0.66, 0.1],
      [0.055, 0.44, 0.92, 0.012],
    ] as const) {
      blur(ctx, m(bl));
      ctx.strokeStyle = ov(mult, 0.1, 0.16, alpha);
      ctx.lineWidth = m(w);
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const wob = wobble(x1 + (x2 - x1) * t + z1 + (z2 - z1) * t, 0.7);
        const nx = x1 + (x2 - x1) * t + (z1 === z2 ? 0 : wob);
        const nz = z1 + (z2 - z1) * t + (z1 === z2 ? wob : 0);
        if (i === 0) ctx.moveTo(px(nx), py(nz));
        else ctx.lineTo(px(nx), py(nz));
      }
      ctx.stroke();
    }
    blur(ctx, 0);
  };

  /**
   * Grime apron either side of a slab edge, `n` pointing into the concrete.
   *
   * The concrete/asphalt boundary was the loudest remaining value step on the
   * site: two polygons of very different brightness meeting on a mathematically
   * straight line. A recessed joint line alone does not fix that, because the
   * eye reads the tonal step, not the groove. Real traffic drags asphalt grit
   * and rubber a metre or two onto the slab and grinds pale concrete dust back
   * the other way, so the step becomes a gradient with a ragged edge.
   */
  const jointBleed = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number) => {
    const steps = Math.max(24, Math.round(Math.hypot(x2 - x1, z2 - z1) * 3));
    const ragged = (s: number, k: number) =>
      0.55 + 0.55 * (0.5 + 0.28 * Math.sin(s * 0.31 + k) + 0.14 * Math.sin(s * 0.83 + k * 2.3) + 0.08 * Math.sin(s * 1.9 + k));

    // dir: +1 grit onto the concrete (wide, darkening), -1 dust onto the
    // asphalt (short, lightening).
    // Filled gradient inside a ragged clip, NOT a stack of blurred strokes. The
    // stroke version applied at about 15% of its nominal strength: a 0.3 m
    // stroke blurred by 0.2 m and jittered across a 2.3 m apron spreads its ink
    // so thin that forcing the peak to 95% moved the overlay by 12/255. A
    // gradient controls opacity directly and is far cheaper.
    const bleedPeak = FORCE.bleed ? 0.95 : 0.4;
    for (const [dir, reach, peak] of [
      [1, 2.3, bleedPeak],
      [-1, 0.85, FORCE.bleed ? -0.9 : -0.16],
    ] as const) {
      blur(ctx, m(0.09));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(px(x1), py(z1));
      ctx.lineTo(px(x2), py(z2));
      for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        const bx = x1 + (x2 - x1) * t;
        const bz = z1 + (z2 - z1) * t;
        const d = reach * ragged(bx + bz, dir > 0 ? 3.1 : 11.7);
        ctx.lineTo(px(bx + nx * d * dir), py(bz + nz * d * dir));
      }
      ctx.closePath();
      ctx.clip();

      const gx = (x1 + x2) / 2;
      const gz = (z1 + z2) / 2;
      const g = ctx.createLinearGradient(px(gx), py(gz), px(gx + nx * reach * dir), py(gz + nz * reach * dir));
      g.addColorStop(0, ov(1 - peak, 0.06 * dir, 0.1, 0.95));
      g.addColorStop(0.35, ov(1 - peak * 0.45, 0.03 * dir, 0.05, 0.75));
      g.addColorStop(1, ov(1, 0, 0, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    blur(ctx, 0);
  };

  // Slab perimeter, where the concrete meets the asphalt.
  contactRect(FORECOURT, 0.62);
  jointBleed(FORECOURT.minX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.minZ, 0, 1);
  jointBleed(FORECOURT.minX, FORECOURT.maxZ, FORECOURT.maxX, FORECOURT.maxZ, 0, -1);
  jointBleed(FORECOURT.minX, FORECOURT.minZ, FORECOURT.minX, FORECOURT.maxZ, 1, 0);
  jointBleed(FORECOURT.maxX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.maxZ, -1, 0);
  coldJoint(FORECOURT.minX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.minZ);
  coldJoint(FORECOURT.minX, FORECOURT.maxZ, FORECOURT.maxX, FORECOURT.maxZ);
  coldJoint(FORECOURT.minX, FORECOURT.minZ, FORECOURT.minX, FORECOURT.maxZ);
  coldJoint(FORECOURT.maxX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.maxZ);

  // Pavement meeting dirt. Shoulder material washes over the edge and traffic
  // grinds it in, so this is the grubbiest line on the whole site - and until
  // now it was the only junction with nothing on it at all.
  contact(PAD.minX, ROAD.halfPaved, PAD.maxX, ROAD.halfPaved, 0.9);
  contact(PAD.minX, -ROAD.halfPaved, PAD.maxX, -ROAD.halfPaved, 0.9);
  for (const d of DRIVEWAYS) {
    contact(d.minX, ROAD.halfPaved, d.minX, PAD.minZ, 0.55);
    contact(d.maxX, ROAD.halfPaved, d.maxX, PAD.minZ, 0.55);
  }

  // Fuel-spill and rubber staining that concentrates in the fuelling positions,
  // plus a general grubbiness gradient toward the slab edges.
  blur(ctx, m(1.1));
  for (const isl of ISLANDS) {
    for (const side of [-1, 1]) {
      ctx.fillStyle = ov(0.74, -0.12, 0.3, 0.55);
      ctx.beginPath();
      ctx.ellipse(px(isl.cx), py(isl.cz + side * 2.3), m(5.2), m(1.5), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Concrete gets used harder than anything else on the site and until now it
  // was the one surface with no history painted on it at all. Four things read
  // at standing height: the drip cluster under each nozzle, tyre rubber laid
  // down where cars stop and pull away, rust bleeding out of the island, and a
  // broad darkening along the lanes the traffic actually uses.
  for (const isl of ISLANDS) {
    for (const side of [-1, 1]) {
      const stopZ = isl.cz + side * 2.4;
      // Two fuelling positions per side, one per pump.
      for (const dx of [-2.4, 2.4]) {
        const fx = isl.cx + dx;
        // The drip cluster: dozens of small overlapping spots, darkest where
        // the nozzle hangs, thinning outward. Not one soft blob.
        for (let i = 0; i < 120; i++) {
          const t = rng();
          const rr = t * t * 1.5;
          const a = rng() * Math.PI * 2;
          blur(ctx, m(0.015 + rng() * 0.05));
          ctx.fillStyle = ov(0.5 + rng() * 0.22, -0.26, 0.62, 0.2 + rng() * 0.5);
          ctx.beginPath();
          ctx.ellipse(
            px(fx + Math.cos(a) * rr),
            py(stopZ + Math.sin(a) * rr * 0.75),
            m(0.03 + rng() * 0.13),
            m(0.025 + rng() * 0.1),
            rng() * 3,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        // Rubber laid down pulling away from the pump: short, dense, and
        // aligned with the lane rather than radial like the drips.
        blur(ctx, m(0.09));
        ctx.strokeStyle = ov(0.7, -0.2, 0.4, 0.5);
        ctx.lineWidth = m(0.22);
        for (const w of [-0.85, 0.85]) {
          ctx.beginPath();
          ctx.moveTo(px(fx - 1.1), py(stopZ + w));
          ctx.lineTo(px(fx + 2.4), py(stopZ + w + (rng() - 0.5) * 0.1));
          ctx.stroke();
        }
      }
    }
    // Rust bleeding down from the island kerb: dowels and the bollard bases
    // weep iron oxide, and it always runs the same warm orange-brown.
    for (let i = 0; i < 16; i++) {
      const ex = isl.cx + (rng() - 0.5) * (ISLAND.length - 0.6);
      const side = rng() < 0.5 ? -1 : 1;
      const ez = isl.cz + side * (ISLAND.width / 2 + 0.04);
      blur(ctx, m(0.1));
      ctx.fillStyle = ov(0.82, 0.06, 0.0, 0.34 + rng() * 0.24);
      ctx.beginPath();
      ctx.ellipse(px(ex), py(ez + side * (0.16 + rng() * 0.3)), m(0.1 + rng() * 0.16), m(0.2 + rng() * 0.45), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Broad darkening down the lanes the traffic uses across the slab.
  blur(ctx, m(0.9));
  for (const isl of ISLANDS) {
    for (const side of [-1, 1]) {
      ctx.fillStyle = ov(0.84, -0.07, 0.1, 0.5);
      ctx.beginPath();
      ctx.ellipse(px(isl.cx), py(isl.cz + side * 2.45), m(9.0), m(1.05), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  blur(ctx, 0);

  /* ------------------------------------------------------------------ */
  /* 7. damp low spots, authored on the actual low points of the mesh     */
  /* ------------------------------------------------------------------ */

  blur(ctx, m(0.5));
  const damp = (x: number, z: number, rx: number, rz: number, a: number) => {
    ctx.fillStyle = ov(0.78, -0.3, 0.14, a);
    ctx.beginPath();
    ctx.ellipse(px(x), py(z), m(rx), m(rz), 0, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const s of LOW_SPOTS) damp(s.x, s.z, s.rx * 0.95, s.rz * 0.95, 0.7);
  for (let i = 0; i < 26; i++) {
    const x = PAD.minX + rng() * (PAD.maxX - PAD.minX);
    const edge = rng() < 0.5 ? PAD.minZ + 0.7 + rng() * 1.6 : PAD.maxZ - 0.7 - rng() * 1.8;
    damp(x, edge, 1.4 + rng() * 3.2, 0.5 + rng() * 0.9, 0.4 + rng() * 0.3);
  }
  for (let i = 0; i < 34; i++) {
    const x = minX + rng() * worldW;
    const z = (rng() < 0.5 ? -1 : 1) * (ROAD.halfPaved - 0.5 - rng() * 0.8);
    damp(x, z, 1.8 + rng() * 4, 0.35 + rng() * 0.5, 0.35 + rng() * 0.35);
  }

  /* ------------------------------------------------------------------ */
  /* 8. edge ravelling — dark crumbled pavement at every boundary         */
  /* ------------------------------------------------------------------ */

  // The pavement itself falls apart at the edge before the dirt gets there:
  // aggregate pops out, the binder goes matte and pale, and the surface loses
  // its shape. Painted as a ragged, deliberately non-straight band.
  const ravel = (x1: number, z1: number, x2: number, z2: number, inward: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const n = Math.max(8, Math.round(len / 0.5));
    const ux = (x2 - x1) / len;
    const uz = (z2 - z1) / len;
    const nx = -uz;
    const nz = ux;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * len;
      const bite = (0.25 + rng() * rng() * 1.5) * inward;
      const cx = x1 + ux * t + nx * bite * 0.35;
      const cz = z1 + uz * t + nz * bite * 0.35;
      blur(ctx, m(0.12));
      ctx.fillStyle = ov(0.95, 0.22, 0.03, 0.3 + rng() * 0.35);
      ctx.beginPath();
      ctx.ellipse(px(cx), py(cz), m(0.2 + rng() * 0.55), m(0.15 + rng() * 0.4), rng() * 3, 0, Math.PI * 2);
      ctx.fill();
      // Individual popped-out stones and the dark sockets they left.
      for (let k = 0; k < 4; k++) {
        const sx = cx + (rng() - 0.5) * 1.1 + nx * rng() * bite;
        const sz = cz + (rng() - 0.5) * 1.1 + nz * rng() * bite;
        blur(ctx, 0);
        ctx.fillStyle = rng() < 0.45 ? ov(0.55, -0.05, 0.2, 0.6) : ov(1.6, 0.16, 0, 0.65);
        ctx.beginPath();
        ctx.arc(px(sx), py(sz), Math.max(1, m(0.012 + rng() * 0.03)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  ravel(minX, -ROAD.halfPaved, maxX, -ROAD.halfPaved, 1.5);
  ravel(minX, ROAD.halfPaved, maxX, ROAD.halfPaved, 1.5);
  for (const d of DRIVEWAYS) {
    ravel(d.minX, ROAD.halfPaved, d.minX, PAD.minZ, 1.1);
    ravel(d.maxX, ROAD.halfPaved, d.maxX, PAD.minZ, 1.1);
  }

  /* ------------------------------------------------------------------ */
  /* A-channel: dirt and grit washed over the pavement                    */
  /* ------------------------------------------------------------------ */

  // Painted as a mass of overlapping blobs rather than a stroked band, so the
  // inner boundary of the wash is never a straight line anywhere.
  const wash = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    reach: number,
    density: number,
    bias: number
  ) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const ux = (x2 - x1) / len;
    const uz = (z2 - z1) / len;
    const nx = -uz * bias;
    const nz = ux * bias;
    const n = Math.round((len / 0.35) * density);
    for (let i = 0; i < n; i++) {
      const t = rng() * len;
      // Squared bias keeps most of the material tight to the edge, with the
      // occasional tongue of grit reaching well out into the lane.
      const d = Math.pow(rng(), 2.4) * reach;
      const cx = x1 + ux * t + nx * d;
      const cz = z1 + uz * t + nz * d;
      const a = Math.pow(1 - d / reach, 1.6) * (0.12 + rng() * 0.3);
      gctx.filter = `blur(${m(0.04 + rng() * 0.12)}px)`;
      gctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      gctx.beginPath();
      gctx.ellipse(
        px(cx),
        py(cz),
        m(0.08 + rng() * 0.32),
        m(0.06 + rng() * 0.22),
        rng() * 3,
        0,
        Math.PI * 2
      );
      gctx.fill();
    }
  };

  // Shoulder material washing in over both highway edges.
  wash(minX, -ROAD.halfPaved, maxX, -ROAD.halfPaved, 1.25, 1.5, 1);
  wash(minX, ROAD.halfPaved, maxX, ROAD.halfPaved, 1.25, 1.5, -1);
  // Grit tracked out of the driveways and piled against the curb lines.
  for (const d of DRIVEWAYS) {
    wash(d.minX, ROAD.halfPaved, d.minX, PAD.minZ + 0.5, 1.0, 1.2, 1);
    wash(d.maxX, ROAD.halfPaved, d.maxX, PAD.minZ + 0.5, 1.0, 1.2, -1);
    wash(d.minX, PAD.minZ + 0.2, d.maxX, PAD.minZ + 0.2, 1.4, 0.6, 1);
  }
  wash(PAD.minX, PAD.minZ, PAD.minX, PAD.maxZ, 0.95, 1.1, 1);
  wash(PAD.maxX, PAD.minZ, PAD.maxX, PAD.maxZ, 0.95, 1.1, -1);
  wash(PAD.minX, PAD.maxZ, PAD.maxX, PAD.maxZ, 1.1, 1.1, -1);
  wash(PAD.minX, PAD.minZ, PAD.maxX, PAD.minZ, 0.8, 0.9, 1);
  // The concrete slab is the one place a straight edge is genuine, so it needs
  // grit banked against it on both sides or it reads as a card laid on the lot.
  for (const [ax, az, bx, bz, bias] of [
    [FORECOURT.minX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.minZ, 1],
    [FORECOURT.minX, FORECOURT.maxZ, FORECOURT.maxX, FORECOURT.maxZ, -1],
    [FORECOURT.minX, FORECOURT.minZ, FORECOURT.minX, FORECOURT.maxZ, 1],
    [FORECOURT.maxX, FORECOURT.minZ, FORECOURT.maxX, FORECOURT.maxZ, -1],
  ] as const) {
    wash(ax, az, bx, bz, 0.75, 0.8, bias);
    wash(ax, az, bx, bz, 0.6, 0.8, -bias);
  }

  // Dust drifts that have collected in the dead corners nobody drives over.
  gctx.filter = `blur(${m(0.35)}px)`;
  for (let i = 0; i < 70; i++) {
    const x = PAD.minX + rng() * (PAD.maxX - PAD.minX);
    const z = PAD.minZ + rng() * (PAD.maxZ - PAD.minZ);
    // Only in the dead corners: traffic sweeps the middle of the lot clean, and
    // grit that stays put is a thin film, never a drift.
    const dead = Math.min(
      1,
      Math.min(x - PAD.minX, PAD.maxX - x, z - PAD.minZ, PAD.maxZ - z) / 5.0
    );
    const a = (0.06 + rng() * 0.16) * (1 - dead);
    if (a < 0.02) continue;
    gctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    gctx.beginPath();
    gctx.ellipse(px(x), py(z), m(0.3 + rng() * 1.3), m(0.2 + rng() * 0.7), rng() * 3, 0, Math.PI * 2);
    gctx.fill();
  }

  ctx.filter = "none";
  gctx.filter = "none";

  /* ------------------------------------------------------------------ */
  /* pack the two layers into one RGBA texture                            */
  /* ------------------------------------------------------------------ */

  // Both source canvases are opaque, so reading them back is lossless. The
  // combined map must NOT go back through a canvas: canvas backing stores are
  // premultiplied, so any pixel with a low alpha would have its RGB crushed on
  // the round trip, which shows up as bright and dark blooms wherever the grit
  // channel happens to be thin. Upload it as raw data instead.
  const out = new Uint8Array(ctx.getImageData(0, 0, W, H).data);
  const gritData = gctx.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) out[i * 4 + 3] = gritData[i * 4];

  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = getMaxAnisotropy();
  tex.premultiplyAlpha = false;
  tex.flipY = false;
  tex.needsUpdate = true;

  return {
    texture: tex,
    origin: new THREE.Vector2(minX, minZ),
    size: new THREE.Vector2(worldW, worldH),
  };
}
