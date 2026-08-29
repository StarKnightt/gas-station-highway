/**
 * System 3: the hard parts bolted onto the lofted car shell - wheels, lamps,
 * trim and a crude but present interior.
 *
 * Everything is built in car-local space: +Z forward, +X to the car's left,
 * y = 0 on the ground under the tyres.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ARCH_BASE_Y, ARCH_RY, ARCH_RZ, AXLES, beltYAt, CAR, capLowerEdgeY, endZ, flankX, topAt } from "./carBody.ts";
import { roundedBox } from "./hardsurface.ts";

/**
 * Builds a strip that lies on the car's flank, by querying the real
 * cross-section for every sample rather than assuming the side is flat.
 *
 * `edge(t)` returns the (z, y) of the strip's two long edges and how far each
 * stands proud of the skin. Mirrored to both sides.
 */
function flankStrip(
  samples: number,
  edge: (t: number) => { z: number; yIn: number; yOut: number; offIn: number; offOut: number },
  side: 1 | -1
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const e = edge(t);
    const xi = (flankX(e.z, e.yIn) + e.offIn) * side;
    const xo = (flankX(e.z, e.yOut) + e.offOut) * side;
    pos.push(xi, e.yIn, e.z, xo, e.yOut, e.z);
    uv.push(t * 3, 0, t * 3, 1);
  }
  for (let i = 0; i < samples; i++) {
    const a = i * 2;
    // Winding flips with the side, or one flank ends up inside out.
    if (side === 1) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  orientOutward(g, side);
  g.computeVertexNormals();
  return g;
}

/**
 * Turn a flank strip the right way round, by measuring it rather than by
 * trusting the caller.
 *
 * The `side` flip above is necessary and **not sufficient**, which took three
 * sessions to notice because the failure is silent: work the winding out by hand
 * and a strip's face normal comes to `(-dz * dy, 0, 0)`, so it depends on the
 * direction the *caller* sweeps `z` as much as on the side. `buildArchLips`
 * sweeps its path with `z` decreasing and comes out facing outward.
 * `buildSills` and the beltline trim sweep `z` increasing and come out facing
 * **inward**, so they were back-face culled, so they drew nothing at all.
 *
 * That is the whole reason the beltline trim was invisible, and it was not the
 * reason I gave: I had diagnosed it as a ribbon shading identically to the door,
 * which is also true and would also have made it illegible, but it never got as
 * far as being shaded. Two sufficient causes, one of them fatal, and the
 * measurement I ran only tested for the second.
 *
 * A caller cannot reasonably be asked to track this - the sign is a product of
 * two independent conventions, one of which lives in a lambda - so the builder
 * settles it. An exterior strip's face must point away from the body's core, so
 * take the area-weighted mean normal against the horizontal radial and flip the
 * index buffer if it points inward.
 *
 * Strips whose face is near-tangential to the radial are left exactly as the
 * caller wound them. The sill's underside return faces mostly downward and its
 * radial component is legitimately near zero; guessing for those would trade a
 * known bug for an unpredictable one. `partscale --winding` reports the whole
 * set, so an ambiguous strip is visible rather than silently decided.
 */
function orientOutward(g: THREE.BufferGeometry, side: 1 | -1): void {
  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  if (!idx) return;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cr = new THREE.Vector3();
  const mean = new THREE.Vector3();
  const centre = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    cr.copy(b).sub(a).cross(c.clone().sub(a));
    const w = cr.length() * 0.5;
    if (!(w > 0) || !Number.isFinite(w)) continue;
    mean.addScaledVector(cr.normalize(), w);
    centre.addScaledVector(a.add(b).add(c).divideScalar(3), w);
    area += w;
  }
  if (!(area > 0)) return;
  mean.divideScalar(area);
  centre.divideScalar(area);
  const outward = new THREE.Vector3(centre.x, 0, centre.z);
  if (outward.lengthSq() < 1e-8 || mean.lengthSq() < 1e-12) return;
  const dot = mean.normalize().dot(outward.normalize());
  // Near-tangential: the caller's intent is unknowable from the radial. Leave it.
  if (dot > -0.3) return;
  const arr = idx.array as unknown as number[] & { [n: number]: number };
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const t = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = t;
  }
  idx.needsUpdate = true;
  void side;
}

/**
 * The rolled lip around each wheel arch: a narrow band that flares 12 mm proud
 * at the opening and rolls back flush into the flank.
 *
 * It also does structural work. The arch openings are cut by dropping quads
 * from the loft, so the opening edge is a staircase at the station pitch; the
 * lip is placed to straddle that edge and hide it, which is what the equivalent
 * pressing does on a real body anyway.
 */
export function buildArchLips(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // The opening is a circle of ARCH_R about (cz, ARCH_BASE_Y). This used to be
  // centred on the *wheel* instead, 22 mm higher and 18 mm smaller, so the lip
  // hung inside the opening as a detached hoop with daylight behind it. It has
  // to be concentric with the hole it is edging.
  for (const cz of AXLES) {
    for (const side of [1, -1] as const) {
      // Outer flare: from just outside the opening edge, rolling back flush.
      parts.push(
        flankStrip(
          76,
          (t) => {
            // -13 deg round to 193 deg, so both ends run past the sill.
            const th = -0.23 + t * (Math.PI + 0.46);
            const s = Math.sin(th);
            const c = Math.cos(th);
            return {
              z: cz + c * ARCH_RZ,
              yIn: ARCH_BASE_Y + s * ARCH_RY * 1.002,
              yOut: ARCH_BASE_Y + s * ARCH_RY * 1.075,
              // 18 mm of flare at the opening edge, not 9. Masked and measured
              // in the render, the lip separated from the arch interior behind
              // it by a median of **2.0 of 255** and from the body panel above
              // it by 7.5 — i.e. it had no outline at all, which is why the
              // whole quarter-panel-to-tyre span reads as one dark mass. Case 9
              // again: what makes a pressing read is the angle it turns
              // through, and half a lip's worth of flare turns through half the
              // angle. Doubling the proud edge also gives it an overhang that
              // throws a mark *down into* the arch, which under a 6-degree sun
              // is worth more than any amount of self-shading.
              offIn: 0.018,
              offOut: -0.002,
            };
          },
          side
        )
      );
      // Return face: the thickness of the pressing, turning back into the
      // arch so the lip casts a line rather than being a zero-width edge.
      parts.push(
        flankStrip(
          76,
          (t) => {
            const th = -0.23 + t * (Math.PI + 0.46);
            const s = Math.sin(th);
            const c = Math.cos(th);
            return {
              z: cz + c * ARCH_RZ * 0.994,
              yIn: ARCH_BASE_Y + s * ARCH_RY * 0.955,
              yOut: ARCH_BASE_Y + s * ARCH_RY * 1.002,
              offIn: -0.022,
              // Must track the flare above, or the pressing has a step in it.
              offOut: 0.018,
            };
          },
          side
        )
      );
    }
  }
  return merge(parts);
}

/**
 * A rounded-rectangle patch laid on the nose or tail fascia, offset along the
 * car's axis by `off`.
 *
 * Lamps and grilles were boxes to begin with, and boxes do not work here: the
 * nose sheds 300 mm of half width over its last 90 mm, so a box wide enough to
 * read as a headlamp has its outboard end hanging in mid air while its inboard
 * end is buried. Sampling the real surface per vertex fixes both, and stacking
 * three patches at different offsets - lens, reflector, housing - gives the
 * lamp genuine parallax instead of a flat sticker.
 */
/**
 * A panel lying on the flank, sampling `flankX` at every vertex.
 *
 * The flank counterpart of `endPatch`. A flat box laid on the quarter cannot be
 * flush, because the surface curves in two directions at once: correcting the
 * fuel filler door for plan taper alone left it 45 mm proud at one corner, and
 * adding tumblehome still left 16 mm. A conforming patch is flush by
 * construction at any size, anywhere on the body, and stays flush if the flank
 * is reshaped again.
 */
function flankPatch(
  zc: number,
  halfZ: number,
  yc: number,
  halfY: number,
  side: number,
  off: number,
  nz = 10,
  ny = 10
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ny; j++) {
    const v = outlineV(j, ny, "round");
    const kv = outlineK(v, "round", halfZ, halfY);
    const y = yc - halfY + v * halfY * 2;
    for (let i = 0; i <= nz; i++) {
      const u = i / nz;
      const z = zc + (u - 0.5) * 2 * halfZ * kv;
      pos.push(side * (flankX(z, y) + off), y, z);
      uv.push(u, v);
    }
  }
  const w = nz + 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nz; i++) {
      const a = j * w + i;
      const b = (j + 1) * w + i;
      const c = j * w + i + 1;
      const d = (j + 1) * w + i + 1;
      // (a,b,c) has edges +Y then +Z, whose cross product is +X: outward on the
      // +X flank. Mirror the winding on the other side.
      if (side > 0) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Row-width profile for `endPatch` and `endBand`.
 *
 * `round` is the squared-off ellipse a lamp or a grille aperture wants: full
 * width across the middle, radiused into the corners.
 *
 * `rect` exists because `round` is catastrophic on anything short. The taper is
 * a fraction of the patch *height*, so it does not care whether that height is
 * 180 mm or 11 mm - and the grille slats are 11 mm tall with `ny = 2`, which
 * puts rows at exactly v = 0, 0.5 and 1, i.e. widths of 6%, 100%, 6%. Every
 * slat was therefore a pointed lens 600 mm wide, and the grille rendered as a
 * bowtie of bright shards that read as torn geometry. The valance and the
 * number plate had milder versions of the same wedge.
 *
 * A bar is a rectangle. Only give it corners if it is tall enough to show them.
 */
type Outline = "round" | "rect";

/**
 * Corner radius: a fraction of the patch's smaller half-dimension, **capped at
 * an absolute radius**.
 *
 * The fraction alone is the defect that Vegetation found twice and a reviewer
 * has now described three times in different words: *a detail element sized as
 * a fraction of its parent is wrong whenever the parent's size varies*, because
 * real detail has an absolute size set by how metal and plastic are formed, not
 * by what it happens to be attached to.
 *
 * Here it meant the corner radius scaled with the part. An 11 mm grille slat
 * got 1.9 mm, which is right. A 180 mm headlamp got **30 mm**, which is not a
 * corner, it is a lozenge — and "headlights are flat rounded rectangles" is
 * exactly what came back. The same fraction produced a sharp-cornered slat and
 * a blobby lamp, and both were "correct" by the formula.
 *
 * A pressed or moulded corner on a car is a tool radius. Lamp lenses and trim
 * surrounds sit in single-digit to low-double-digit millimetres, so the cap is
 * 9 mm. Small parts keep the fraction, since a 9 mm radius on a 5 mm half-width
 * would consume the whole part; large parts now get a corner instead of a bend.
 */
const CORNER_F = 0.34;
const CORNER_MAX = 0.009;

/**
 * Row placement along the patch's height.
 *
 * A rounded rectangle spends all of its curvature in the last `R` of its
 * height and none at all in the middle, so evenly spaced rows put nearly every
 * row in the straight section and one or two in the arc. That is how the amber
 * repeater - `ny = 6`, `round` - came out as a literal hexagon. Push rows
 * toward the ends so the corners get the resolution and the straight flanks,
 * which need none, give theirs up.
 */
function outlineV(j: number, ny: number, profile: Outline): number {
  const v = j / ny;
  if (profile === "rect") return v;
  const s = 2 * v - 1;
  return 0.5 + 0.5 * Math.sign(s) * Math.pow(Math.abs(s), 0.62);
}

/**
 * Half-width at height `v`, as a fraction of the patch's half-width.
 *
 * This is a genuine rounded rectangle: straight sides, a circular quadrant into
 * each corner, and a flat end row (W - R) wide. What it replaces was a
 * squared-off ellipse expressed as a fraction of *height*, which is a step
 * function wearing a curve's clothing - 0.06 at the end rows and above 0.97
 * everywhere else, whatever the aspect ratio. Sampled at six rows that is not a
 * radiused rectangle, it is a hexagon, and the critic named it as one.
 *
 * Taking the radius from the smaller half-dimension also retires the 0.06 floor
 * that used to guard against the end row collapsing to a point: the end row is
 * now (1 - R/W) wide by construction and never degenerates.
 */
function outlineK(v: number, profile: Outline = "round", halfW = 1, halfH = 1): number {
  if (profile === "rect") return v <= 0 || v >= 1 ? 0.97 : 1;
  const r = Math.min(CORNER_F * Math.min(halfW, halfH), CORNER_MAX);
  const a = r / halfH;
  const b = r / halfW;
  const t = Math.abs(2 * v - 1);
  if (t <= 1 - a) return 1;
  const u = Math.min(1, (t - (1 - a)) / a);
  return 1 - b + b * Math.sqrt(Math.max(0, 1 - u * u));
}

function endPatch(
  xc: number,
  halfW: number,
  yc: number,
  halfH: number,
  front: boolean,
  off: number,
  nx = 14,
  ny = 8,
  profile: Outline = "round"
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const dir = front ? 1 : -1;
  for (let j = 0; j <= ny; j++) {
    const v = outlineV(j, ny, profile);
    const k = outlineK(v, profile, halfW, halfH);
    const y = yc - halfH + v * halfH * 2;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const x = xc + (u - 0.5) * 2 * halfW * k;
      pos.push(x, y, endZ(x, y, front) + dir * off);
      uv.push(u, v);
    }
  }
  const w = nx + 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w + i;
      const b = (j + 1) * w + i;
      const c = j * w + i + 1;
      const d = (j + 1) * w + i + 1;
      if (front) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Placement helpers, so parts ask the hull where its surface is instead of
 * being handed a number that was true when someone last looked at a render.
 *
 * Two parts have now been lost to the same mistake in two rounds: the interior
 * mirror punched through the windscreen header, and the exhaust tip and rear
 * valance ended up 128 mm and 150 mm inside the tail. In both cases the part
 * was positioned by copying a neighbour's coordinate. Everything routed through
 * `flankX` - the door handles, the mirrors, the sills - tracked a 256 mm change
 * to the flank automatically and needed no attention at all. These give the
 * same protection to the roof and the two fascias.
 *
 * `tools/carfeatures.mjs` re-checks every hard point against the hull without a
 * GPU and will flag any that go under.
 */
/** A Y just inside the roof at station `z`. */
function under(z: number, gap: number): number {
  return topAt(z) - gap;
}
/** A Z standing `proud` clear of the nose or tail fascia at (`x`,`y`). */
function offFascia(x: number, y: number, front: boolean, proud: number): number {
  const face = endZ(Math.abs(x), y, front);
  return front ? face + proud : face - proud;
}

/**
 * A conforming frame: the flat ring between two rounded-rect outlines.
 *
 * The grille and intake are cut out of the fascia at quad granularity, and the
 * fascia is a radial fan, so the cut edge is a staircase running diagonally
 * across the grid however the opening is specified. Despeckling made it
 * contiguous; nothing makes it straight. At the `nose_close` framing one pixel
 * is 1.48 mm, so a 4-10 mm tooth is 3-7 px - not the sub-pixel regime at all,
 * but squarely in the range where raggedness is unmissable, and the critic read
 * it exactly as it is: torn, jagged, a badly-alpha'd texture rather than an
 * opening.
 *
 * The fix is not a finer cut. It is a surround. This ring laps over the ragged
 * boundary from the front: the inner edge is an analytic curve sitting inside
 * the hole, the outer edge lands on solid fascia, and the staircase ends up
 * underneath it. Every real car has this part, and this is what it is for.
 */
function endFrame(
  xc: number,
  halfW: number,
  yc: number,
  halfH: number,
  front: boolean,
  off: number,
  inset: [number, number],
  grow: [number, number],
  steps = 64
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const dir = front ? 1 : -1;

  // One closed loop: down the +x edge, across the top, up the -x edge, across
  // the bottom. Both loops share this parameterisation so they stitch cleanly.
  const loop = (hw: number, hh: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let s = 0; s <= steps; s++) {
      const v = outlineV(s, steps, "round");
      pts.push([xc + hw * outlineK(v, "round", hw, hh), yc - hh + v * hh * 2]);
    }
    for (let s = steps; s >= 0; s--) {
      const v = outlineV(s, steps, "round");
      pts.push([xc - hw * outlineK(v, "round", hw, hh), yc - hh + v * hh * 2]);
    }
    return pts;
  };
  const inner = loop(halfW - inset[0], halfH - inset[1]);
  const outer = loop(halfW + grow[0], halfH + grow[1]);

  for (let i = 0; i < inner.length; i++) {
    for (const [p, u] of [
      [inner[i], 0],
      [outer[i], 1],
    ] as Array<[[number, number], number]>) {
      pos.push(p[0], p[1], endZ(p[0], p[1], front) + dir * off);
      uv.push(u, i / inner.length);
    }
  }
  for (let i = 0; i < inner.length; i++) {
    const a = (i % inner.length) * 2;
    const b = a + 1;
    const c = ((i + 1) % inner.length) * 2;
    const d = c + 1;
    // Both branches used to be one step out of phase with the loop's actual
    // orientation, so every triangle of both surrounds faced away from the
    // camera and the whole part was back-face culled. It was in the merged
    // geometry, it was 2.5-4.0 mm proud of the *rendered* fascia with not one
    // vertex buried, `tsc` was green, no fallback counter moved and no
    // arithmetic check could fail — and it had never drawn a pixel. The blocky
    // 22-33 mm edge at the grille is the raw staircase of the quad-level cut,
    // uncovered, because the part built to cover it has been invisible since it
    // was written. Found by flat-colouring every candidate surface and reading
    // the frame as labels (`?cardebug=front`, `tools/carlabel.mjs`): zero
    // pixels of frame anywhere, and the eye meeting fascia against backing
    // panel directly. `tools/carframez.mjs` asserts the area-weighted face
    // normal now, because winding is invisible to every other check here.
    if (front) idx.push(a, b, c, b, d, c);
    else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The wall around the edge of an `endPatch`, swept between two depths.
 *
 * This is the piece that was missing from the lamps. A lens drawn as a flat
 * patch 4 mm proud has no side, so nothing separates it from the panel behind
 * it and it reads as paint. Give it a perimeter wall a couple of centimetres
 * deep and the edge becomes a real silhouette event: it catches its own
 * specular and casts into the recess, and it survives being sampled at a couple
 * of pixels - unlike an 11 mm flute, which cannot.
 *
 * Follows the same squared-ellipse outline as `endPatch` at the same
 * `xc/halfW/yc/halfH`, so a band and a patch built with matching arguments
 * share an edge exactly.
 */
function endBand(
  xc: number,
  halfW: number,
  yc: number,
  halfH: number,
  front: boolean,
  offA: number,
  offB: number,
  steps = 48
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const dir = front ? 1 : -1;
  const outline: Array<[number, number]> = [];
  // Down the +x edge, then back up the -x edge, giving a closed loop.
  for (let s = 0; s <= steps; s++) {
    const v = outlineV(s, steps, "round");
    const k = outlineK(v, "round", halfW, halfH);
    outline.push([xc + halfW * k, yc - halfH + v * halfH * 2]);
  }
  for (let s = steps; s >= 0; s--) {
    const v = outlineV(s, steps, "round");
    const k = outlineK(v, "round", halfW, halfH);
    outline.push([xc - halfW * k, yc - halfH + v * halfH * 2]);
  }
  // The wall is seen from outside along the flank and from inside when looking
  // into the recess, so it needs both faces. They must be built from two
  // independent vertex copies, not from two windings over one copy: sharing the
  // vertices makes `computeVertexNormals` sum a face normal and its exact
  // negative at every vertex, they cancel to zero, and the whole band shades
  // black. Two copies, one winding each.
  for (let side = 0; side < 2; side++) {
    const v0 = side * outline.length * 2;
    for (let i = 0; i < outline.length; i++) {
      const [x, y] = outline[i];
      const base = endZ(x, y, front);
      pos.push(x, y, base + dir * offA, x, y, base + dir * offB);
      const u = i / (outline.length - 1);
      uv.push(u, 0, u, 1);
    }
    for (let i = 0; i < outline.length - 1; i++) {
      const a = v0 + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      if (side === 0) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Sill cladding along the rocker, conforming to the flank. */
export function buildSills(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const z0 = -1.42;
  const z1 = 1.42;
  for (const side of [1, -1] as const) {
    parts.push(
      flankStrip(64, (t) => {
        const z = z0 + t * (z1 - z0);
        // Tapers away at both ends where it runs into the arch lips.
        const fade = Math.min(1, Math.min(t, 1 - t) * 14);
        // Offsets were 0.001 and 0.001-0.005. One millimetre does not survive
        // this shell: the flank is a chorded section and its facets stand
        // forward of the analytic surface between rings by more than that, so
        // the sills were authored proud and rasterised inside. `probe-unseen`
        // had them at 0 px against 990 px when forced. This is the same class
        // that buried the grille caprail and the fog lamps, and the same
        // remedy - a real offset rather than a token one. Sill cladding on a
        // real car stands 10-25 mm off the bodywork, so 14-18 mm is both clear
        // of the tessellation error and closer to the truth than 1 mm was.
        return { z, yIn: 0.206, yOut: 0.290, offIn: 0.014, offOut: 0.014 + 0.004 * fade };
      }, side)
    );
    // Underside return, tucking back under the sill. Its inboard edge is meant
    // to sit inside the body; only the outboard edge has to clear it.
    parts.push(
      flankStrip(64, (t) => {
        const z = z0 + t * (z1 - z0);
        return { z, yIn: 0.206, yOut: 0.206, offIn: -0.03, offOut: 0.014 };
      }, side)
    );
  }
  return merge(parts);
}

function xf(
  g: THREE.BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0
): THREE.BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    // mergeGeometries is strict about matching attribute sets.
    if (!g.getAttribute("uv")) {
      const n = g.getAttribute("position").count;
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    g.deleteAttribute("uv1");
    g.deleteAttribute("uv2");
    return g.index ? g : g.toNonIndexed();
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error("carParts: merge failed");
  return out;
}

/* ------------------------------------------------------------------ */
/* wheel                                                                */
/* ------------------------------------------------------------------ */

export interface WheelBuild {
  /** Machined alloy face and spokes. */
  alloy: THREE.BufferGeometry;
  /** Dark inner barrel and hub, so the wheel is not see-through. */
  dark: THREE.BufferGeometry;
  /** Brake disc and caliper. */
  brake: THREE.BufferGeometry;
  /** Lug nuts and the centre cap ring. */
  chrome: THREE.BufferGeometry;
}

/**
 * A five-spoke alloy, built outer-face-out along +X. The right-hand wheels are
 * the same geometry yawed 180 degrees, which is also how a real symmetric wheel
 * design goes on the other side of the car.
 */
export function buildWheel(): WheelBuild {
  const rimR = CAR.rimR;
  const w = CAR.tyreWidth;
  const outer = w * 0.44; // outer face plane
  const inner = -w * 0.46;

  const alloy: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const brake: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];

  // Rim barrel. Open cylinder along X.
  dark.push(
    xf(new THREE.CylinderGeometry(rimR * 0.995, rimR * 0.995, w * 0.92, 40, 1, true), (outer + inner) / 2, 0, 0, 0, 0, Math.PI / 2)
  );
  // Backing plate: stops you seeing daylight through the spokes.
  dark.push(xf(new THREE.CircleGeometry(rimR * 0.99, 40), inner + 0.004, 0, 0, 0, Math.PI / 2, 0));

  // Outer lip: the polished flange that catches a hard rim highlight.
  alloy.push(xf(new THREE.TorusGeometry(rimR * 0.985, 0.014, 10, 44), outer, 0, 0, 0, Math.PI / 2, 0));
  // Dished face ring, sloping inboard from the lip.
  alloy.push(
    xf(new THREE.CylinderGeometry(rimR * 0.985, rimR * 0.80, 0.055, 40, 1, true), outer - 0.028, 0, 0, 0, 0, Math.PI / 2)
  );

  // Hub boss and centre cap. The cap was 104 mm across, which on a 16 inch
  // wheel is the size of a saucer and made the whole face read as a disc with
  // slots cut in it rather than as spokes.
  alloy.push(xf(new THREE.CylinderGeometry(0.050, 0.058, 0.062, 24), outer - 0.032, 0, 0, 0, 0, Math.PI / 2));
  chrome.push(xf(new THREE.CylinderGeometry(0.037, 0.037, 0.009, 24), outer - 0.0035, 0, 0, 0, 0, Math.PI / 2));

  // Five tapered spokes from the boss to the lip, each with a slight
  // Y-section so it is not a flat plank.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.31;
    const midR = (0.082 + rimR * 0.90) / 2;
    const len = rimR * 0.90 - 0.070;
    const spoke = new THREE.BoxGeometry(0.052, len, 0.062, 1, 3, 1);
    // Taper: narrow at the hub, wide at the rim.
    const p = spoke.getAttribute("position") as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k);
      const t = (y / len) * 0.5 + 0.5; // 0 at hub end, 1 at rim end
      p.setX(k, p.getX(k) * (0.72 + t * 0.55));
      p.setZ(k, p.getZ(k) * (0.58 + t * 0.78));
    }
    p.needsUpdate = true;
    spoke.computeVertexNormals();
    // Box local axes after this: X stays axial, Y is radial, Z is tangential.
    // The wheel axis is X, so no extra swing is needed - adding a rotateZ here
    // lays the spokes over sideways, which is easy to do and hard to spot.
    spoke.translate(0, midR, 0);
    spoke.rotateX(a);
    spoke.translate(outer - 0.052, 0, 0);
    alloy.push(spoke);

    // Lug nut, on the spoke rather than between them and on a 114 mm PCD so it
    // sits clear of the smaller cap instead of hiding under it.
    const la = a;
    chrome.push(
      xf(
        new THREE.CylinderGeometry(0.0125, 0.0135, 0.018, 6),
        outer - 0.026,
        Math.sin(la) * 0.057,
        Math.cos(la) * 0.057,
        0,
        0,
        Math.PI / 2
      )
    );
  }

  // Brake disc, sitting inboard behind the spokes, plus a caliper at the rear.
  brake.push(xf(new THREE.CylinderGeometry(rimR * 0.80, rimR * 0.80, 0.024, 32), inner + 0.075, 0, 0, 0, 0, Math.PI / 2));
  brake.push(xf(new THREE.CylinderGeometry(0.075, 0.075, 0.050, 20), inner + 0.055, 0, 0, 0, 0, Math.PI / 2));
  const caliper = roundedBox(0.052, 0.095, 0.155, 0.014, 2);
  brake.push(xf(caliper, inner + 0.075, 0.058, -rimR * 0.62, 0, 0, 0));

  return { alloy: merge(alloy), dark: merge(dark), brake: merge(brake), chrome: merge(chrome) };
}

/* ------------------------------------------------------------------ */
/* lamps                                                                */
/* ------------------------------------------------------------------ */

export interface LampBuild {
  lens: THREE.BufferGeometry;
  redLens: THREE.BufferGeometry;
  amber: THREE.BufferGeometry;
  reflector: THREE.BufferGeometry;
  housing: THREE.BufferGeometry;
  /**
   * Chrome bezel rings around the lenses. Its own group rather than folded into
   * `reflector`, which carries the same material: the reflector is inside the
   * cavity and the bezel is outside it, so they will want to diverge the moment
   * either is tuned, and a group that exists only because two things happen to
   * share a material today is a merge waiting to be un-picked.
   */
  bezel: THREE.BufferGeometry;
}

/**
 * Headlamps and tail lamps. Each is a housing box, a mirrored reflector bowl
 * and a clear or tinted outer lens standing 8 mm proud, so there is real
 * parallax between the lens and what is behind it.
 */
export function buildLamps(): LampBuild {
  const lens: THREE.BufferGeometry[] = [];
  const redLens: THREE.BufferGeometry[] = [];
  const amber: THREE.BufferGeometry[] = [];
  const reflector: THREE.BufferGeometry[] = [];
  const housing: THREE.BufferGeometry[] = [];
  const bezel: THREE.BufferGeometry[] = [];

  for (const s of [1, -1]) {
    /* ---- headlamp ---- */
    // Pulled inboard from 0.545/0.208. The front cap is usable to |x| ~ 0.775
    // at y = 0.85 but only 0.730 by y = 0.90, and the old footprint reached
    // 0.753 at its top corner - off the fascia, onto the flat fallback plane,
    // giving a 12 mm sawtooth across the lens. It now stays inside the cap.
    const hx = s * 0.515;
    const hy = 0.828;
    const HW = 0.185;
    const HH = 0.068;

    // Housing at the back of the cavity, reflector in the middle, lens on the
    // skin. 55 mm of depth between them is what you actually see when you look
    // into a lamp from an angle.
    // Shut line boxing the lamp out of the wing, same treatment as the tail.
    //
    // 8 mm, not 15. The comment above says the lamp footprint "now stays inside
    // the cap", and that was true of the lamp and false of everything derived
    // from it: a margin added around a footprint that was tuned to exactly reach
    // its limit overhangs by that margin. These two lines were the whole of the
    // 18 endZ fallbacks that gated captures - the corner landed 9.5 mm past the
    // outline, on the substituted flat plane, at the outer top of both lamps.
    //
    // The margin shrinks rather than the lamp, because the lamp's size is the
    // thing two reviewers were complaining about and a shut line at 8 mm still
    // reads as a line - real panel gaps are 3-5 mm. Shrinking the lens to make
    // room for its own gap would have been the fix that fought the brief.
    const SHUT = 0.008;
    housing.push(endBand(hx, HW + SHUT, hy, HH + SHUT, true, 0.002, -0.012));
    housing.push(endPatch(hx, HW + SHUT, hy, HH + SHUT, true, -0.012, 16, 6));
    housing.push(endPatch(hx, HW, hy, HH, true, -0.085));
    reflector.push(endPatch(hx, HW * 0.96, hy, HH * 0.92, true, -0.048));
    // A pair of shallow bowls in front of the reflector sheet, to break the
    // reflection into two beam units rather than one flat mirror.
    //
    // Depth matters: a 70 mm hemisphere sunk only 50 mm behind the skin pokes
    // 20 mm straight back out through the lens, which is what turned both
    // headlamps into orange blisters growing out of the nose. The bowl rim now
    // sits behind the lens plane by construction.
    const BOWL_R = 0.064;
    for (const o of [-0.086, 0.082]) {
      const bowl = new THREE.SphereGeometry(BOWL_R, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.46);
      bowl.rotateX(-Math.PI / 2);
      const bx = hx + o;
      bowl.translate(bx, hy, endZ(bx, hy, true) - 0.032 - BOWL_R);
      reflector.push(bowl);
      const cap = new THREE.SphereGeometry(0.016, 12, 8);
      cap.translate(bx, hy, endZ(bx, hy, true) - 0.046);
      housing.push(cap);
    }
    // Projector unit in the outboard bowl: a shroud ring and the glass ball
    // inside it. This is the one piece of a headlamp that catches a hard
    // specular from almost any angle, and without it the lens reads as a flat
    // pane with a grey smear behind.
    {
      const px2 = hx - s * 0.086;
      const pz = endZ(px2, hy, true);
      housing.push(
        xf(new THREE.CylinderGeometry(0.046, 0.038, 0.040, 20, 1, true), px2, hy, pz - 0.040, Math.PI / 2, 0, 0)
      );
      const ball = new THREE.SphereGeometry(0.036, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
      ball.rotateX(Math.PI / 2);
      ball.translate(px2, hy, pz - 0.030);
      lens.push(ball);
    }
    // Lens face plus its perimeter wall, so the glass has a visible edge
    // against the recess rather than lying on the panel like a decal.
    lens.push(endPatch(hx, HW, hy, HH, true, 0.009));
    lens.push(endBand(hx, HW, hy, HH, true, 0.009, -0.012));
    /**
     * Chrome bezel ring tracing the lens perimeter, standing 4 mm prouder than
     * the glass.
     *
     * This is the cheapest thing on the car that answers "flat rounded rectangles
     * with a uniform pale fill", which two independent reviewers wrote about these
     * lamps. The complaint is not that the lamp is the wrong size or the wrong
     * colour - at 180 mm it is well past the 56 mm that reads. It is that a pale
     * lens fills its whole outline with one value, so the outline itself is the
     * only edge in it and the eye has nothing to fix on.
     *
     * A bezel supplies a hard specular line all the way round, and because it is
     * a band rather than a patch it has faces at a different orientation to both
     * the lens and the wing - which is the only property that makes applied trim
     * legible at all. 4 mm of stand-off is a moulding flange, not a styling
     * choice: it is what a lens actually sits in.
     */
    bezel.push(endBand(hx, HW + 0.005, hy, HH + 0.005, true, 0.013, -0.005, 24));
    // Amber repeater, inboard of the lamp's outer edge. Placed outboard of it
    // the patch ran off the end of the fascia, where `endZ` has nothing to
    // sample, and hung in mid air beside the car.
    // Eight-by-six on the old step-function outline is what made this a literal
    // hexagon. It needs enough rows to resolve a corner arc, and a perimeter
    // wall so the repeater has thickness rather than being a coloured decal.
    const AX = hx + s * 0.118;
    amber.push(endPatch(AX, 0.044, hy - 0.006, 0.046, true, 0.004, 14, 16));
    amber.push(endBand(AX, 0.044, hy - 0.006, 0.046, true, 0.004, -0.010));
    housing.push(endBand(AX, 0.052, hy - 0.006, 0.054, true, 0.001, -0.014));

    /* ---- tail lamp ---- */
    //
    // Rebuilt around what the critic actually sees at this distance. The old
    // lamp had correct chambers, bowls and 11 mm flutes, all of them present
    // and unoccluded - and it still read as "red-and-white noise painted on a
    // flat panel", because a flat lens 4 mm proud covered the lot and the
    // flutes were below one pixel. Internal detail was never the problem.
    //
    // What can survive sampling is an edge. So: box the unit out of the body
    // with a shut line, sink the housing behind it, and give every lens its own
    // 22 mm perimeter wall. The lamp now reads by silhouette and by the way its
    // edges catch light, not by texture.
    //
    // Sized to the fascia rather than by eye. The rear cap is only usable out
    // to |x| ~ 0.70 and dies completely above y = 1.00; the old lamp was
    // centred at y = 0.968 with a half height of 0.098, so its top rows hung
    // off the fascia entirely and fell through to the flat fallback plane -
    // 22% of the red lens sat on it. This one fits inside the envelope.
    const tx = s * 0.47;
    const ty = 0.885;
    const TW = 0.2;
    const TH = 0.075;

    // Shut line boxing the lamp out of the bodywork: a slot wall dropping off
    // the body surface, and a dark floor for it to land on.
    housing.push(endBand(tx, TW + 0.016, ty, TH + 0.016, false, 0.002, -0.012));
    housing.push(endPatch(tx, TW + 0.016, ty, TH + 0.016, false, -0.012, 16, 8));
    // Back of the housing, 60 mm behind the lens face.
    housing.push(endPatch(tx, TW, ty, TH, false, -0.05, 16, 8));

    // Chambers, outboard to inboard: brake/tail, indicator, reverse.
    const CH = [
      { c: 0.12, w: 0.068, red: true },
      { c: -0.004, w: 0.042, red: true },
      { c: -0.126, w: 0.058, red: false },
    ];
    for (const ch of CH) {
      const cx = tx + s * ch.c;
      const ch_h = 0.062;
      // Chromed bowl, and the bulb boss inside it. Kept large and few: at these
      // distances a bowl reads as a bright blob behind glass, which is right,
      // and more subdivision would only add noise.
      reflector.push(endPatch(cx, ch.w * 0.9, ty, ch_h * 0.86, false, -0.032, 10, 6));
      reflector.push(endPatch(cx, ch.w * 0.32, ty, ch_h * 0.3, false, -0.02, 8, 4));
      // Lens: a face standing 10 mm proud of the body, plus the wall that
      // carries it down to the recess floor. That wall is the whole point.
      const target = ch.red ? redLens : lens;
      target.push(endPatch(cx, ch.w, ty, ch_h, false, 0.01, 10, 6));
      target.push(endBand(cx, ch.w, ty, ch_h, false, 0.01, -0.012));
    }
  }

  return {
    lens: merge(lens),
    redLens: merge(redLens),
    amber: merge(amber),
    reflector: merge(reflector),
    housing: merge(housing),
    bezel: merge(bezel),
  };
}

/* ------------------------------------------------------------------ */
/* trim                                                                 */
/* ------------------------------------------------------------------ */

export interface TrimBuild {
  chrome: THREE.BufferGeometry;
  black: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  rubber: THREE.BufferGeometry;
  /**
   * Only populated under `buildTrim({ debugFront: true })`. Each front-aperture
   * surface, kept out of the merged buckets so it can be given its own flat
   * unlit colour and identified by eye in one frame. Throwaway diagnostic.
   */
  debugFront: Array<{ name: string; geo: THREE.BufferGeometry }>;
  /**
   * Every trim part, named, alongside the merged meshes. Published as
   * `car.parts`; see `put` for why this exists.
   */
  parts: Array<{ name: string; geo: THREE.BufferGeometry }>;
}

export interface TrimOptions {
  /**
   * Split the grille and intake surfaces out of the merged buckets so each can
   * be flat-coloured. Three rounds were spent inferring which surface owns the
   * blocky 22-33 mm edge at the grille and each hypothesis was ruled out by
   * measurement without the culprit ever being named. Colouring the candidates
   * and looking answers it in one capture.
   */
  debugFront?: boolean;
}

/**
 * Grille, bumper valances, sills, mirrors, handles, wipers, exhaust. Small
 * parts, but their absence is exactly what makes an untrimmed body read as a
 * blocked-out placeholder.
 */
export function buildTrim(opts: TrimOptions = {}): TrimBuild {
  const chrome: THREE.BufferGeometry[] = [];
  const black: THREE.BufferGeometry[] = [];
  const body: THREE.BufferGeometry[] = [];
  const rubber: THREE.BufferGeometry[] = [];
  const debugFront: Array<{ name: string; geo: THREE.BufferGeometry }> = [];
  const parts: Array<{ name: string; geo: THREE.BufferGeometry }> = [];

  /**
   * Route a front-aperture surface either into its normal bucket or, under the
   * debug flag, out to its own named mesh. Returns nothing on purpose: every
   * call site must go through it, so a surface added later cannot silently
   * miss the split and be mistaken for innocent in the debug frame.
   */
  const front = (name: string, bucket: THREE.BufferGeometry[], geo: THREE.BufferGeometry): void => {
    parts.push({ name, geo });
    if (opts.debugFront) debugFront.push({ name, geo });
    else bucket.push(geo);
  };

  /**
   * The same, for everything that is not a front-aperture surface. Records the
   * part in the manifest and routes it to its material bucket.
   *
   * The manifest is the point. This function merges about thirty small parts
   * into four meshes by material, which is right for draw calls and is an
   * information barrier exactly where the small parts live: `probe-unseen` can
   * only ever report that `car-trim-black` draws pixels, so every individual
   * fitting is unauditable. A reviewer listed the mirrors, wipers, badge and
   * trim as absent when all of them existed and merely did not read, and
   * nothing in the toolchain could contradict it.
   *
   * `parts` is published as `car.parts` and consumed by `tools/partscale.mjs`,
   * which ranks every fitting by apparent size in a named capture pose. Same
   * contract as Vegetation's `vegetation.sites`, for the same reason.
   */
  const put = (name: string, bucket: THREE.BufferGeometry[], geo: THREE.BufferGeometry): void => {
    parts.push({ name, geo });
    bucket.push(geo);
  };

  /* ---- front ----
   * Heights here are set against the actual nose section, which runs from
   * yb ~= 0.47 to the hood leading edge at ~1.02 around z = 2.30. Trim above
   * that lands on top of the hood, floating; everything below is biased a few
   * centimetres *into* the body, because a part that is slightly buried reads
   * as recessed while a part that is slightly proud reads as broken.
   */
  // Upper grille, seen through the aperture now cut in the fascia.
  //
  // These parts always existed; until the opening was cut they were sealed
  // inside a closed nose. Two things had to change once they became visible.
  // The backing panel is bigger than the hole and sits just behind the reveal,
  // so the ragged edge of a quad-level cut is covered rather than silhouetted.
  // And the slats are dark: chrome bars 14 mm inside a 42 mm deep mouth caught
  // the low sun and blew out into bright confetti that read as torn metal. A
  // grille is a dark void with structure in it, plus at most one bright edge.
  // 18 x 6 over a 720 x 180 mm panel is a 40 x 30 mm quad, and this panel is
  // conformed to a curving fascia, so at that spacing its own silhouette is
  // visibly faceted - which is the blocky "torn" edge that survived fixing the
  // cut and the reveal walls. The staircase everyone kept attributing to the
  // aperture was partly this panel behind it.
  front("grille-backing", black, endPatch(0, 0.36, 0.818, 0.09, true, -0.052, 44, 16, "rect"));
  for (let i = 0; i < 3; i++) {
    // Slat plus the skirt that makes it a slat. Face at -0.030, backing at
    // -0.052, so the band is the 22 mm the slat stands out of the mouth. A slat
    // is a bar you can see the side of; without the side it is a stripe painted
    // on the backing, which is what these were, in the same black as the backing.
    front("grille-slat", black, endPatch(0, 0.300, 0.794 + i * 0.024, 0.009, true, -0.030, 16, 2, "rect"));
    front("grille-slat-skirt", black, endBand(0, 0.300, 0.794 + i * 0.024, 0.009, true, -0.030, -0.052, 12));
  }
  // Vertical dividers, so the void has depth cues rather than being flat black.
  //
  // Walled, like the intake vanes. A divider whose whole job is to give a black
  // cavity depth cannot do it as a flat patch floating in that cavity: with no
  // faces at a different orientation it shades identically to the backing and
  // contributes nothing, at any albedo, in any light. The band reaches back to
  // the backing panel at -0.052 so each divider is a real fin spanning the void
  // rather than a card suspended in it.
  //
  // Count held at 7 rather than widened. The intake dividers taught this: in the
  // side pose apparent width is set by viewing angle, so these stay 1-2 px at any
  // width - the wall is the fix in every pose and the width is the fix in none.
  for (let i = -3; i <= 3; i++) {
    const dx = i * 0.084;
    front("grille-divider", black, endPatch(dx, 0.006, 0.818, 0.034, true, -0.028, 3, 5, "rect"));
    front("grille-divider-wall", black, endBand(dx, 0.006, 0.818, 0.034, true, -0.028, -0.052, 14));
  }
  // The surround. Covers the staircase left by cutting a rectangle out of a
  // radial fan, and gives the opening a rim that catches its own light instead
  // of a torn edge. Wide across, thin top and bottom: there is only 152 mm
  // between the intake and the grille and the number plate needs 128 of it, so
  // the frame grows sideways where the fascia is empty.
  // Outer wall on the surround, so the opening has a rim with a visible side
  // rather than a flat bezel painted round the hole. This is the "grille depth"
  // complaint: a frame drawn as a band on the surface has no faces turned away
  // from the fascia, so it cannot cast the line that makes an aperture read as an
  // aperture. 14 mm of return is a pressing depth, not a styling choice.
  front("grille-frame", body, endFrame(0, 0.305, 0.818, 0.046, true, 0.004, [0.014, 0.01], [0.05, 0.026]));
  front("grille-frame-wall", body, endBand(0, 0.305, 0.818, 0.046, true, 0.004, -0.010, 20));
  front("grille-band", black, endBand(0, 0.291, 0.818, 0.036, true, 0.004, -0.034));
  // The one bright piece: the bar capping the top of the grille.
  //
  // Was authored at `off = -0.01`, i.e. 10 mm *into* the fascia, at y = 0.898 —
  // which is above the aperture, so there is solid bodywork there and all 57 of
  // its vertices measured exactly 10.0 mm buried. Case 11 again: a part that is
  // present and enclosed is indistinguishable from a part that was never
  // authored. It now sits 10 mm proud, which also clears the surround's 4 mm.
  // Narrower than the surround (0.300 against its 0.355) so it stops short of
  // the headlamp inner corners instead of crossing them, and thin: under the
  // current sky-only environment a chrome face blows out flat, so the only
  // thing that decides whether it reads as an accent or a slab is its size.
  front("grille-caprail", chrome, endPatch(0, 0.300, 0.884, 0.006, true, 0.006, 18, 2, "rect"));
  // The caprail is the brightest small part on the nose and stood 6 mm proud
  // with no side, so it read as a chrome stripe rather than a chrome bar. Its
  // skirt runs past the fascia so the step cannot show daylight.
  front("grille-caprail-skirt", chrome, endBand(0, 0.300, 0.884, 0.006, true, 0.006, -0.004, 14));
  // Nose badge, sat in the mouth of the grille and standing clear of the dark
  // backing behind it. Blank, for the same reason as the boot badge.
  // 100 x 48 mm rather than 100 x 62. At the taller size its top and bottom
  // rows sat behind the fascia teeth the quad-level cut leaves inside the
  // mouth — 14 of 91 vertices measured buried — so the badge's own silhouette
  // was being bitten by the staircase the surround exists to hide.
  //
  // Now PROUD, and a solid rather than a patch. It was a flat patch recessed 8 mm
  // into the grille mouth, which is the offset-surface defect in its purest form:
  // a badge with no sides, sunk into a dark cavity, sharing its shading with the
  // black backing behind it. Two independent reviewers listed "no badge" among
  // the car's missing fittings, and this is why - the geometry was present and
  // could not be seen.
  //
  // A badge is a cast boss stuck onto the panel: it stands off, and the read is
  // the pair of lines its walls make, not its own colour. 5 mm proud gives a lit
  // top edge and a shadowed lower one at this sun elevation; the band is what
  // makes those edges exist at all.
  front("nose-badge", chrome, endPatch(0, 0.05, 0.818, 0.024, true, 0.005, 12, 6));
  front("nose-badge-wall", chrome, endBand(0, 0.05, 0.818, 0.024, true, 0.005, -0.006, 16));

  // Lower intake in the bumper, and the valance under it.
  front("intake-backing", black, endPatch(0, 0.522, 0.556, 0.092, true, -0.055, 52, 16, "rect"));
  for (let i = 0; i < 2; i++) {
    front("intake-slat", black, endPatch(0, 0.470, 0.538 + i * 0.032, 0.008, true, -0.03, 20, 2, "rect"));
    front("intake-slat-skirt", black, endBand(0, 0.470, 0.538 + i * 0.032, 0.008, true, -0.03, -0.055, 12));
  }
  /**
   * Intake dividers: five walled vanes, not nine flat patches.
   *
   * Nine 12 mm vanes at a 98 mm pitch measured 2 px wide in `partscale`, and 2
   * px of black against a black backing is a shimmering comb the moment the
   * camera moves - which it does, the deliverable being video. This is the one
   * place in this system where the size finding cuts toward *bigger*: five 26 mm
   * vanes over the same span land near 4 px and survive resampling.
   *
   * The second half matters more. As nine `endPatch` calls these were ribbons -
   * flat faces floating 27 mm proud of the backing with no geometry joining them
   * to it, so they had no sides, shaded exactly as the backing shaded, and were
   * the same colour besides. They contributed nothing at any width. The
   * `endBand` skirt is what makes a vane a vane: it supplies the two side walls
   * whose normals differ from the face, and therefore the shadow-and-highlight
   * pair the eye actually reads. `intake-band` next door was already built this
   * way, which is why it scores as a solid in `partscale --relief`.
   */
  for (let i = -2; i <= 2; i++) {
    const dx = i * 0.196;
    front("intake-divider", black, endPatch(dx, 0.013, 0.556, 0.026, true, -0.028, 3, 4, "rect"));
    // 16 outline steps, not the default 48. A 26 mm vane does not need 384
    // triangles of skirt, and at the default the five walls alone cost 1,920 -
    // more than the entire rest of the trim's small parts put together.
    front("intake-divider-wall", black, endBand(dx, 0.013, 0.556, 0.026, true, -0.028, -0.055, 16));
  }
  front("intake-frame", body, endFrame(0, 0.452, 0.554, 0.04, true, 0.004, [0.014, 0.01], [0.05, 0.024]));
  front("intake-frame-wall", body, endBand(0, 0.452, 0.554, 0.04, true, 0.004, -0.010, 20));
  front("intake-band", black, endBand(0, 0.438, 0.554, 0.03, true, 0.004, -0.034));
  // Fog lamp bezels, outboard in the intake.
  for (const s of [1, -1]) {
    const fz = endZ(s * 0.545, 0.556, true);
    // Surface-mounted pods, not recessed lamps. Authored recessed, both of
    // these had all 100 vertices inside the bumper (bezel mouth 8.4 mm in,
    // tail 95.1 mm in; lens 3.0 to 24.7 mm in) and neither had ever drawn a
    // pixel: there is no aperture cut at |x| = 0.545, so a negative offset from
    // the fascia is not a recess, it is burial. The bezel now stands 26 mm
    // proud with its tail 6 mm inside the skin so no gap opens behind it, and
    // the lens sits 5 mm back from the bezel's lip, which is what gives the
    // pod a dark rim rather than a flat disc.
    front("fog-bezel", black, xf(new THREE.CylinderGeometry(0.054, 0.058, 0.032, 16), s * 0.545, 0.556, fz + 0.010, Math.PI / 2, 0, 0));
    front("fog-lens", chrome, xf(new THREE.CylinderGeometry(0.031, 0.031, 0.014, 16), s * 0.545, 0.556, fz + 0.014, Math.PI / 2, 0, 0));
  }
  // Front numberplate. No text: a blank recessed panel with a rim, which is
  // what you actually resolve at this distance anyway.
  // Raised 10 mm to 0.682: a US plate is 305 x 152 mm and the clear space
  // between the two new surrounds is 0.618..0.746, which it fills exactly.
  // A plinth, not a recess. Both of these were authored 22 mm and 6 mm *into*
  // the fascia and all 65 vertices of each measured buried, so the whole front
  // plate has been inside the bumper — which is why the fascia between the
  // grille and the intake renders as an empty panel. There is no aperture here
  // to be recessed into. Standing the rim 8 mm proud of the panel also suits
  // the light better than a recess would: at a 6-degree sun a lip throws a
  // projected mark down the face, where a groove is lit almost along its own
  // length and returns nothing.
  // Order matters and the first attempt had it backwards: the rim is the larger
  // patch, so standing it proud of the panel made it cover the panel completely
  // and the plate rendered as one blank tan slab 316 x 128 mm — the loudest
  // thing on the nose, and exactly the "a blank object is a conspicuous object"
  // failure. The dark panel is now the proud piece and the bright rim shows as
  // a border around it.
  front("plate-panel", black, endPatch(0, 0.152, 0.682, 0.058, true, 0.012, 12, 4, "rect"));
  front("plate-rim", chrome, endPatch(0, 0.158, 0.682, 0.064, true, 0.006, 12, 4, "rect"));
  /**
   * Skirts. Each of these patches stood proud of the piece behind it with
   * nothing joining the two, so it had no faces at an angle to that piece and
   * shaded identically to it - a chrome rim indistinguishable from the black
   * panel it framed, whatever either was made of. The band closes the step and
   * supplies the only thing that makes a stacked assembly read as stacked: an
   * edge with a light side and a dark side.
   *
   * 12 outline steps. These are 6 to 12 mm walls and the default 48 would cost
   * more than the parts they belong to.
   */
  front("plate-panel-skirt", black, endBand(0, 0.152, 0.682, 0.058, true, 0.012, 0.006, 12));
  front("plate-rim-skirt", chrome, endBand(0, 0.158, 0.682, 0.064, true, 0.006, -0.002, 12));

  // Air dam under the bumper.
  put("rear-valance", black, xf(new THREE.BoxGeometry(1.36, 0.075, 0.16), 0, 0.325, 2.180));

  /* ---- rear ---- */
  //
  // The valance and the exhaust used to be boxes at hard-coded Z. Measured with
  // tools/carfeatures.mjs, the exhaust tip was 128 mm INSIDE the tail and the
  // valance 150-310 mm inside it - which is why the critic reported no exhaust
  // tip after crediting one a round earlier. Nothing swallowed them; they were
  // placed by eye at a station that stopped being the back of the car when the
  // flank was reshaped, and unlike everything routed through `flankX` they had
  // no way to follow. Both now ask the fascia where it is.
  put("front-valance", black, endPatch(0, 0.62, 0.455, 0.075, false, 0.004, 24, 4, "rect"));
  put("lower-bright-bar", chrome, endPatch(0, 0.430, 0.845, 0.011, false, 0.006, 20, 2));
  // Rear numberplate, recessed into the bumper the same way as the front one.
  put("plate-recess", black, endPatch(0, 0.152, 0.66, 0.058, false, -0.02, 12, 4, "rect"));
  put("plate-surround", chrome, endPatch(0, 0.158, 0.66, 0.064, false, -0.005, 12, 4, "rect"));
  /**
   * Skirts again, and this group carries two specific critic complaints.
   *
   * "The bumper is body-coloured and continuous with the wing." A valance that
   * is a flat patch 4 mm off the fascia *is* continuous with the fascia as far
   * as shading is concerned: same normal, same light, no boundary. The skirt is
   * what makes the bumper a separate component, and it does it with geometry
   * rather than with a colour change, which is how a real bumper reads.
   *
   * "The plate recess is an empty black rectangle." It was empty because it was
   * not a recess - a patch sunk 20 mm with no wall around it is a dark rectangle
   * painted on the bumper. The band from -0.020 out to the surround at -0.005 is
   * the recess wall, and a recess wall is almost entirely what tells the eye
   * something is set into a surface rather than printed on it.
   *
   * The valance and bright bar skirts run past the fascia into the body so the
   * wall is closed at the far end and cannot show daylight through the step.
   */
  put("front-valance-skirt", black, endBand(0, 0.62, 0.455, 0.075, false, 0.004, -0.008, 16));
  put("lower-bright-bar-skirt", chrome, endBand(0, 0.430, 0.845, 0.011, false, 0.006, -0.004, 16));
  put("plate-recess-skirt", black, endBand(0, 0.152, 0.66, 0.058, false, -0.02, -0.005, 12));
  put("plate-surround-skirt", chrome, endBand(0, 0.158, 0.66, 0.064, false, -0.005, 0.005, 12));
  // Boot badge. Deliberately a plain oval with nothing written on it: this is a
  // generic sedan and must not carry any manufacturer's mark, and at the
  // distance these frames are shot from a badge is a bright chip of chrome
  // anyway. Between the lamps, which start at |x| = 0.27.
  // Already proud by 5 mm, but proud with no sides is still a ribbon: the offset
  // is invisible without faces at a different orientation to make an edge out of
  // it. Same one-line fix as the nose badge.
  put("boot-badge", chrome, endPatch(0, 0.046, 0.9, 0.028, false, 0.005, 12, 6));
  put("boot-badge-wall", chrome, endBand(0, 0.046, 0.9, 0.028, false, 0.005, -0.006, 16));
  // Exhaust finisher, tucked under the valance and standing 30 mm clear of it.
  {
    const ex = -0.42;
    // Hung 10 mm above the real lower edge of the tail cap rather than at a
    // literal. Authored at 0.352 it sat 7.4 mm under the fascia and took the
    // flat fallback plane; more to the point, a literal here is what put this
    // same part 128 mm inside the tail when the flank was last reshaped.
    // 22 mm of clearance above the cap's lower edge, not 10. `probe-fallbacks`
    // had this placement off the outline at y=0.352 against a cap edge of
    // 0.3594 and asked for 7.4 mm; 10 mm of margin was not enough because the
    // edge it has to clear is the *outline* at this x, not the lower edge the
    // helper reports. Under-margin here does not lose the part, it lays it on a
    // substituted flat plane, which reads as tearing rather than as absence.
    const ey = capLowerEdgeY(ex, false) + 0.022;
    const tip = offFascia(ex, ey, false, 0.024);
    // An open-ended chrome tube with nothing inside it and nothing behind it is
    // not a tailpipe, it is a shiny bead - and at the rear three-quarter it
    // caught the sun and read as "a small floating bright nub... a stray
    // primitive". What makes a pipe legible is the hole: a dark bore behind a
    // bright rim. The black sleeve starts just inside the chrome mouth so the
    // first thing the eye finds is the shadow, not the metal.
    put("exhaust-tip-bright", chrome, 
      xf(new THREE.CylinderGeometry(0.031, 0.031, 0.1, 20, 1, true), ex, ey, tip + 0.05, Math.PI / 2, 0, 0)
    );
    put("exhaust-tip", black, xf(new THREE.CylinderGeometry(0.026, 0.026, 0.16, 20), ex, ey, tip + 0.09, Math.PI / 2, 0, 0));
  }

  /* ---- fuel filler, left rear quarter only ---- */
  //
  // Laid on the panel rather than positioned at a guessed X: the door sits at
  // `flankX` for its own station, and its yaw comes from how fast the quarter
  // is drawing in there, so it stays flush if the flank is reshaped again.
  {
    const fs = -1;
    const fz = -1.78;
    // Below the shoulder line, which peaks at y = 0.96 here. Centred on the
    // crease, the door was spanning a feature line and could not sit flat
    // against it at any orientation.
    const fy = 0.86;
    // Dark recess, then the door 6 mm proud of its floor and 1.5 mm proud of
    // the body, so there is a shut line around it rather than a drawn outline.
    put("fuel-filler-recess", black, flankPatch(fz, 0.072, fy, 0.078, fs, -0.005, 12, 12));
    put("fuel-filler-door", body, flankPatch(fz, 0.062, fy, 0.068, fs, 0.0015, 12, 12));
  }

  /* ---- sides ---- */
  for (const s of [1, -1]) {
    const sx = (y: number, z: number, off: number) => s * (flankX(z, y) + off);

    // Mirror: stalk plus a shell, sat on the real door skin rather than at a
    // guessed half width.
    // A real door mirror is a big dark lump on a stalk and is one of the
    // strongest things in a car's side silhouette. Body-coloured and 85 mm
    // deep it disappeared into the door; black-housed, 100 mm deep and stood
    // 30 mm further off the skin, it reads.
    // Hung off the beltline rather than at absolute heights, for the reason
    // given on the door handles below: anything a fixed distance from a
    // feature must ask the hull where that feature is.
    //
    // It was at y 1.128 (stalk) and 1.155 (housing) against a belt at 1.038,
    // so the housing sat 117 mm above the belt and **overlapped the side
    // glass**. Cropped at 3x it read as a tan box taped to the window rather
    // than as a mirror, which is very likely why a reviewer listed mirrors
    // among the parts this car does not have. It has them; they did not read.
    //
    // A door mirror mounts on the sail panel at the front of the door and its
    // housing sits roughly level with the belt, not above it. 34 mm up puts
    // the whole housing clear of the DLO and against body colour, where a dark
    // lump is legible, and moving it 60 mm aft takes it off the A-pillar.
    const mz = 0.825;
    const mbelt = beltYAt(mz);
    const stalkY = mbelt + 0.006;
    const housingY = mbelt + 0.034;
    put("mirror-stalk", black, xf(roundedBox(0.11, 0.062, 0.10, 0.022, 2), sx(stalkY, mz, 0.006), stalkY, mz));
    put("mirror-housing", black, 
      xf(roundedBox(0.100, 0.132, 0.238, 0.050, 3), sx(housingY, mz, 0.112), housingY, mz - 0.02, 0, 0, -s * 0.16)
    );
    // The mirror glass belongs on the **rear** face of the pod, not the
    // outboard one. It was a 10 mm slab lying in the YZ plane at the housing's
    // outer edge, so its reflective face pointed straight out at the side
    // camera and returned a pale slab of sky - the brightest thing on the
    // door, and read as a beige sticker rather than as glass. The housing is
    // 238 mm long fore-and-aft, so its back face is where a mirror actually
    // looks, and from any angle forward of square you should see the shell.
    put("mirror-glass", chrome, 
      xf(
        new THREE.BoxGeometry(0.088, 0.106, 0.010),
        sx(housingY, mz, 0.112),
        housingY,
        mz - 0.02 - 0.114,
        0,
        0,
        -s * 0.16
      )
    );

    // Door handles.
    //
    // Hung 96 mm under the beltline rather than at a literal 1.020, which is
    // where the belt used to be. This is the third part to need that treatment
    // and the rule has earned itself: anything that sits a fixed distance from
    // a feature should ask the hull where that feature is, because the hull
    // moves. Dropping the belt 40 mm would otherwise have pushed the handles
    // up through the glass line.
    //
    // Bigger, too. At 40 x 48 x 158 mm they were read as "just small tan
    // slivers"; a real lift-up handle is deeper than it is tall and it throws a
    // shadow, so the recess behind it matters as much as the handle itself.
    for (const dz of [0.505, -0.585]) {
      const hy = beltYAt(dz) - 0.096;
      put("door-handle-recess", black, xf(new THREE.BoxGeometry(0.026, 0.062, 0.184), sx(hy, dz, -0.03), hy, dz));
      put("door-handle", body, xf(roundedBox(0.052, 0.056, 0.172, 0.018, 3), sx(hy, dz, -0.004), hy, dz));
    }

    /**
     * Bright trim along the beltline: three strips, not one.
     *
     * As a single `flankStrip` this was an 18 mm band offset 2 to 3 mm from the
     * door, and it was **732 px long, 47% of the car's width, and completely
     * invisible**. Not too small, not too dark, not occluded - `partscale` had
     * already ruled all three out. Invisible because a `flankStrip` is a
     * *surface offset from* the flank with no walls, so all of its normals were
     * the door's normals and it shaded exactly as the door shaded. Chrome on a
     * blue door, indistinguishable from the blue door.
     *
     * What makes a real trim strip visible is not its own albedo but **the pair
     * of lines it creates**: a highlight along its upper return where the sky
     * catches the up-facing surface, and a shadow along its lower return where
     * the down-facing surface sees only the ground. A coplanar band produces
     * neither, at any brightness, in any light. So the strip is now a face
     * standing 8 mm proud with the two returns that close it - and the returns
     * are the part that does the work, the face merely holds them apart.
     *
     * All three run in increasing `y` deliberately. `flankStrip` derives its
     * winding from the side and the vertex order, and reversing an edge pair to
     * make a return "read downward" flips the triangles; this system has lost
     * three separate rounds to inverted winding, most recently four dark parts
     * in the nose. Keeping the traversal uniform is what makes the returns safe
     * to add, and `probe-unseen` is what catches it if this reasoning is wrong.
     */
    /**
     * The returns are 8 mm tall, matching the 8 mm they stand proud, i.e. they
     * are 45-degree chamfers. That is not a styling choice, it is the same
     * pixel floor as everywhere else: a first attempt gave them 3 mm of height,
     * which is about 1.5 px on the flank in the side pose, below the 6 px floor
     * that `partscale` established for this car and therefore an invisible fix
     * for an invisible part. A return has to present its full proud depth to be
     * seen, so a strip standing 8 mm proud needs 8 mm of chamfer, and the face
     * gets what is left of the section rather than the other way round.
     */
    const BELT_PROUD = 0.008;
    const BELT_FLUSH = 0.001;
    const beltZ = (t: number) => -1.42 + t * 2.42;
    // Lower return: flank up to the proud face, so it faces down. Shadow line.
    put("beltline-return-lower", chrome,
      flankStrip(48, (t) => ({
        z: beltZ(t), yIn: 1.052, yOut: 1.060, offIn: BELT_FLUSH, offOut: BELT_PROUD,
      }), s as 1 | -1)
    );
    // The proud face itself.
    put("beltline-strip", chrome,
      flankStrip(48, (t) => ({
        z: beltZ(t), yIn: 1.060, yOut: 1.074, offIn: BELT_PROUD, offOut: BELT_PROUD,
      }), s as 1 | -1)
    );
    // Upper return: proud face back into the flank, so it faces up. Highlight.
    put("beltline-return-upper", chrome,
      flankStrip(48, (t) => ({
        z: beltZ(t), yIn: 1.074, yOut: 1.082, offIn: BELT_PROUD, offOut: BELT_FLUSH,
      }), s as 1 | -1)
    );

    // Wiper arm and blade, parked at the base of the screen.
    put("wiper-arm", rubber, xf(new THREE.BoxGeometry(0.014, 0.010, 0.42), s * 0.30, 1.152, 1.286, -0.26, s * 0.22, 0));
    put("wiper-blade", rubber, xf(new THREE.BoxGeometry(0.010, 0.024, 0.38), s * 0.30, 1.163, 1.300, -0.26, s * 0.22, 0));
  }

  // Antenna fin, on the roof rather than on the backlight, and sunk far
  // enough that its base is inside the panel at every station it spans.
  put("antenna-fin", body, xf(new THREE.SphereGeometry(0.055, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 2.4), 0, 1.432, -0.60));

  return { chrome: merge(chrome), black: merge(black), body: merge(body), rubber: merge(rubber), debugFront, parts };
}

/* ------------------------------------------------------------------ */
/* interior                                                             */
/* ------------------------------------------------------------------ */

export interface InteriorBuild {
  cloth: THREE.BufferGeometry;
  plastic: THREE.BufferGeometry;
}

/**
 * Seats, dash, wheel and console. Crude on purpose - it is only ever seen
 * dimly through tinted glass, and the brief is right that even crude interior
 * geometry beats black glass by a mile.
 */
export function buildInterior(): InteriorBuild {
  const cloth: THREE.BufferGeometry[] = [];
  const plastic: THREE.BufferGeometry[] = [];

  // Floor and rear parcel shelf.
  plastic.push(xf(new THREE.BoxGeometry(1.54, 0.03, 2.30), 0, 0.545, -0.10));
  plastic.push(xf(new THREE.BoxGeometry(1.46, 0.03, 0.46), 0, 1.075, -1.52));

  // Rear bench: cushion and squab. The rear headrests were floating above
  // nothing, which is why the cabin read as a hint rather than a room.
  cloth.push(xf(roundedBox(1.30, 0.16, 0.50, 0.06, 3), 0, 0.700, -0.760));
  cloth.push(xf(roundedBox(1.30, 0.52, 0.20, 0.06, 3), 0, 0.960, -1.020, 0.16, 0, 0));

  // Interior mirror, hung off the header rail.
  //
  // Placed at a guessed 1.318 it sat 65 mm proud of the roof at the body and
  // 113 mm at the stalk, and punched out through the windscreen header - the
  // "tan rectangular object clipping through the roof" in three_quarter_front.
  // That was the second part in two rounds positioned by copying a neighbour's
  // numbers instead of asking the hull where its surface is, so it now hangs
  // from `topAt` at its own station and cannot drift again.
  {
    const mz = 0.93;
    const stalkTop = under(mz, 0.026); // header rail, just inside the glass
    plastic.push(xf(new THREE.BoxGeometry(0.028, 0.07, 0.028), 0, stalkTop - 0.035, mz + 0.025));
    plastic.push(xf(roundedBox(0.26, 0.075, 0.045, 0.018, 2), 0, stalkTop - 0.082, mz, 0.1, 0, 0));
  }

  // Dash: a wide sweep with a raised cowl over the instruments.
  plastic.push(xf(roundedBox(1.56, 0.20, 0.44, 0.055, 3), 0, 1.045, 1.150));
  plastic.push(xf(roundedBox(0.50, 0.11, 0.26, 0.045, 3), 0.355, 1.135, 1.020));
  // Centre stack.
  plastic.push(xf(roundedBox(0.36, 0.30, 0.10, 0.025, 2), 0, 0.985, 0.985, 0.22, 0, 0));

  // Steering wheel: rim, hub and three spokes, tilted like a real column.
  const tilt = -0.42;
  const wx = 0.355;
  const wy = 1.075;
  const wz = 0.865;
  const rim = new THREE.TorusGeometry(0.178, 0.017, 10, 32);
  plastic.push(xf(rim, wx, wy, wz, Math.PI / 2 + tilt, 0, 0));
  plastic.push(xf(new THREE.CylinderGeometry(0.062, 0.062, 0.055, 16), wx, wy, wz, Math.PI / 2 + tilt, 0, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const sp = new THREE.BoxGeometry(0.030, 0.140, 0.016);
    sp.translate(0, 0.108, 0);
    sp.rotateZ(a);
    sp.rotateX(Math.PI / 2 + tilt);
    sp.translate(wx, wy, wz);
    plastic.push(sp);
  }
  plastic.push(xf(new THREE.CylinderGeometry(0.045, 0.055, 0.24, 12), wx, wy - 0.10, wz - 0.10, Math.PI / 2 + tilt, 0, 0));

  // Console between the front seats.
  plastic.push(xf(roundedBox(0.28, 0.22, 0.80, 0.04, 2), 0, 0.665, 0.480));

  // Seats.
  const seat = (x: number, z: number, backLean: number, headrest: boolean) => {
    cloth.push(xf(roundedBox(0.50, 0.16, 0.50, 0.06, 3), x, 0.645, z));
    const back = roundedBox(0.50, 0.66, 0.17, 0.06, 3);
    cloth.push(xf(back, x, 0.995, z - 0.32, backLean, 0, 0));
    if (headrest) cloth.push(xf(roundedBox(0.24, 0.155, 0.11, 0.045, 3), x, 1.335, z - 0.40, backLean, 0, 0));
  };
  seat(0.355, 0.415, 0.20, true);
  seat(-0.355, 0.415, 0.20, true);
  // Rear bench, one piece.
  cloth.push(xf(roundedBox(1.34, 0.16, 0.48, 0.06, 3), 0, 0.645, -0.660));
  cloth.push(xf(roundedBox(1.34, 0.58, 0.17, 0.06, 3), 0, 0.950, -0.960, 0.16, 0, 0));
  // Rear headrests. These used to sit at y=1.245 / z=-1.02, where the top of
  // a 0.14 box tilted back by 0.16 rad reached about 1.32 - and the backlight
  // glass at that station is at 1.31. They punched through the glass and read
  // from outside as two dark rounded rectangles floating on the rear roof,
  // which is exactly the stray geometry a reviewer flagged. Dropped 55 mm and
  // moved 40 mm aft so they clear it and sit where a rear bench actually is.
  for (const s of [1, -1]) cloth.push(xf(roundedBox(0.22, 0.13, 0.10, 0.04, 3), s * 0.355, 1.19, -1.06, 0.16, 0, 0));

  // Door cards, so the cabin is not open to the shell interior at the sides.
  for (const s of [1, -1]) plastic.push(xf(new THREE.BoxGeometry(0.03, 0.42, 2.05), s * 0.795, 0.815, 0.02));

  return { cloth: merge(cloth), plastic: merge(plastic) };
}
