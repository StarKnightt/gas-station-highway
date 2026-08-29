import * as THREE from "three";
import type { Rng } from "./noise";
import { buildingBox, buildingTube, mergeLocal } from "./buildingGeo";
import { applyBottleLabel, applyPackaging, PACK_CARTON_CELLS } from "./buildingSignage";

/**
 * Interior fittings for the store: gondola shelving, the product that goes on
 * it, cooler wire shelves and the bottles.
 *
 * Everything here is vertex-coloured and merged, so a whole aisle of product
 * is one draw call with one material. Nothing carries readable branding - the
 * shapes and the colour rhythm are what make a shelf read as stocked, and
 * legible labels at this distance would only look like a texture atlas anyway.
 */

/** Attach a flat vertex colour so a geometry can be merged with the batch. */
export function tintGeo(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  if (!geo.getIndex()) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i);
    geo.setIndex(idx);
  }
  if (!geo.getAttribute("uv")) {
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

/**
 * Product palette. A real shelf is mostly white, kraft, and dark packaging with
 * a minority of saturated accents - the eye reads the *rhythm* of a few bright
 * facings against a neutral mass. An evenly-distributed rainbow is the single
 * loudest tell that a shelf was filled by a random generator, so the neutrals
 * are weighted heavily here and everything gets pulled toward a warm grey.
 */
const PRODUCT_HUES = [
  0xcfc8bb, 0xd8d4cb, 0xb9ae99, 0xa89c86, 0x8e857a, 0x33302c, 0x25231f, 0x5d564c,
  0x9c3a2f, 0xb8651f, 0xc2a02c, 0x3d6b3a, 0x2d5580, 0x5f4070, 0x1f7274, 0xa8506e,
];
const NEUTRAL_COUNT = 8;
const PRODUCT_BASE = new THREE.Color(0.34, 0.32, 0.29);

function productColor(rng: Rng): THREE.Color {
  // Two thirds neutral, one third accent.
  const i = rng() < 0.64 ? Math.floor(rng() * NEUTRAL_COUNT) : NEUTRAL_COUNT + Math.floor(rng() * (PRODUCT_HUES.length - NEUTRAL_COUNT));
  const c = new THREE.Color(PRODUCT_HUES[Math.min(i, PRODUCT_HUES.length - 1)]);
  // Store lighting and dust knock everything back.
  c.lerp(PRODUCT_BASE, 0.2 + rng() * 0.18);
  // Lifted since the packaging atlas landed: `color` multiplies the map, whose
  // mean is about 0.78, so the palette that was authored against a bare
  // material now has to carry that factor back or every facing gets a fifth
  // darker for no reason anyone would be able to name from the picture.
  c.multiplyScalar(0.88 + rng() * 0.34);
  return c;
}

export interface ShelfRun {
  /**
   * Range the shelf covers along its run axis: world X for the default `"x"`
   * runs, world Z for a `"z"` run such as a gondola end cap.
   */
  x0: number;
  x1: number;
  /** Position of the front lip on the *other* horizontal axis. */
  zFront: number;
  /** Depth back from the front lip. */
  depth: number;
  /** World Y of the shelf deck. */
  y: number;
  /** Which way the products face: +1 means the front lip is at larger Z. */
  facing: 1 | -1;
  /**
   * Strength of the baked slot-access shading, 0..1. `?bgao=0` sets it to 0 for
   * the A/B; a term that cannot be turned off cannot be measured.
   */
  shade?: number;
  /** 0 = neatly faced, 1 = ransacked. */
  untidy: number;
  maxHeight: number;
}

/**
 * Product archetypes.
 *
 * The shelf used to hold two forms — an extruded box and a can — with every
 * dimension drawn from one continuous range, and a critic reading only pixels
 * called the result "game props". That verdict survives correct texturing,
 * because the tell is not the surface: **a real shelf is a collection of
 * discrete manufactured formats, and a continuous distribution of proportions
 * is not one.** Two cartons on a real shelf are either the same size or
 * obviously different sizes; they are never 7% different.
 *
 * So proportions are drawn *within* an archetype and the archetype is drawn
 * from a weighted list. `w` is the facing width, `ar` the height as a multiple
 * of that width, and `dr` the depth as a multiple of it — a format's aspect
 * ratio is what identifies it, so height and depth are keyed to width rather
 * than rolled separately (the independent draw this replaces produced 200 mm
 * wide by 300 mm tall boxes, which no manufacturer makes).
 */
type Archetype = {
  form: "carton" | "box" | "bag" | "can" | "jar";
  /** Relative frequency on the shelf. */
  weight: number;
  w: [number, number];
  ar: [number, number];
  dr: [number, number];
  /** Chance a facing of this format is stacked two high. */
  stack?: number;
  /** How many units of this format a facing typically runs to. */
  facings: [number, number];
};

const ARCHETYPES: Archetype[] = [
  // Cereal and cracker cartons: tall, narrow, and shallow enough to fall over.
  { form: "carton", weight: 1.0, w: [0.078, 0.135], ar: [1.75, 2.9], dr: [0.42, 0.62], facings: [1, 3] },
  // Wide flat boxes — bars, tea, sachets. Often stacked rather than stood up.
  { form: "box", weight: 0.85, w: [0.115, 0.2], ar: [0.6, 1.05], dr: [0.28, 0.45], stack: 0.45, facings: [1, 2] },
  // Snack bags: the widest silhouette on the shelf and the only one that is
  // not a straight prism.
  { form: "bag", weight: 0.7, w: [0.105, 0.175], ar: [1.15, 1.7], dr: [0.4, 0.62], facings: [1, 2] },
  // Cans: the deepest run, because canned goods are faced many wide.
  { form: "can", weight: 1.05, w: [0.062, 0.092], ar: [1.2, 1.75], dr: [1, 1], stack: 0.16, facings: [2, 6] },
  // Jars and shelf bottles — dressings, oil, sauce.
  { form: "jar", weight: 0.55, w: [0.066, 0.098], ar: [1.6, 2.5], dr: [1, 1], facings: [1, 3] },
];
const ARCH_TOTAL = ARCHETYPES.reduce((s, a) => s + a.weight, 0);

function pickArchetype(rng: Rng): Archetype {
  let t = rng() * ARCH_TOTAL;
  for (const a of ARCHETYPES) {
    t -= a.weight;
    if (t <= 0) return a;
  }
  return ARCHETYPES[ARCHETYPES.length - 1];
}

/**
 * A snack bag: a box pinched to a seal at the top and slightly bellied at the
 * bottom, where the contents sit.
 *
 * Worth its five lines because it is the only silhouette on the shelf whose
 * top edge is not a horizontal straight line, and a run of flat-topped prisms
 * is the specific thing that reads as blocking-out. `BoxGeometry` duplicates
 * its vertices per face, so recomputing normals after the pinch keeps the
 * corners hard rather than smoothing the whole thing into a pillow.
 */
function bagGeo(sx: number, h: number, sz: number, depthAxis: "x" | "z", uvMetres: THREE.Vector2): THREE.BufferGeometry {
  const g = buildingBox(sx, h, sz, { uvMetres });
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  /**
   * The seal is pinched across the bag's *depth*, never its width — a bag
   * viewed from the front is a rectangle with a crimped top, not a wedge.
   *
   * Which local axis that is depends on the run: an aisle shelf lays product
   * out along world X and faces it along Z, and a gondola end cap is the same
   * shelf turned a quarter turn. Pinching Z unconditionally squeezed the *end
   * cap* bags across their faces, and eight triangular slabs on the nearest
   * fitting in the `interior` pose read as low-poly rocks.
   */
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + h / 2) / h;
    const seal = t > 0.82 ? (t - 0.82) / 0.18 : -1;
    // Squeezed flat at the seal, fullest a third of the way up.
    const squeeze = seal >= 0 ? THREE.MathUtils.lerp(1, 0.22, seal) : 1 + 0.16 * Math.sin(t * Math.PI);
    // The crimp spreads a little wider than the bag as it flattens.
    const spread = seal >= 0 ? THREE.MathUtils.lerp(1, 1.06, seal) : 1;
    if (depthAxis === "z") {
      pos.setX(i, pos.getX(i) * spread);
      pos.setZ(i, pos.getZ(i) * squeeze);
    } else {
      pos.setX(i, pos.getX(i) * squeeze);
      pos.setZ(i, pos.getZ(i) * spread);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Fill one shelf with product. Real facings are pushed to the front lip
 * and lined up; the untidiness is in the gaps where stock has sold through,
 * the odd item pulled back, and a few knocked askew.
 */
export function buildingShelfProducts(run: ShelfRun, rng: Rng, axis: "x" | "z" = "x"): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  let x = run.x0 + 0.02;
  const lip = run.zFront - run.facing * 0.015;
  /**
   * The run is authored in a local frame — `u` along the shelf, `v` out toward
   * the shopper — and mapped to world here. A `"z"` run is the same shelf
   * turned a quarter turn, which is what a gondola end cap is; without this the
   * end-cap stock would be laid out along the aisle and stand inside the
   * fitting. Only the placement is mirrored, never a rotation applied
   * afterwards: baking a layout and then rotating the result is NOTES.md case
   * 10.
   */
  const place = (g: THREE.BufferGeometry, u: number, y: number, v: number) =>
    axis === "x" ? g.translate(u, y, v) : g.translate(v, y, u);

  const uvM = new THREE.Vector2(0.3, 0.3);

  while (x < run.x1 - 0.05) {
    // A "facing" is several identical units side by side, which is what makes
    // a shelf read as merchandised rather than as random clutter.
    const arch = pickArchetype(rng);
    const lerp = (r: [number, number]) => THREE.MathUtils.lerp(r[0], r[1], rng());
    const round = arch.form === "can" || arch.form === "jar";
    const w = lerp(arch.w);
    const h0 = w * lerp(arch.ar);
    const d = w * lerp(arch.dr);
    // Two-high stacking, where the format allows it. Doubling the height of a
    // short format is the cheapest large change to a shelf's skyline, and it
    // is what real stock control does with anything that will not topple.
    const stacked = arch.stack !== undefined && rng() < arch.stack && h0 * 2 + 0.01 < run.maxHeight;
    const h = Math.min(run.maxHeight, h0);
    if (h < h0 * 0.72) {
      // Will not fit under the shelf above without being squashed out of its
      // own proportions. Skip rather than distort: a format is its aspect.
      x += w + 0.01;
      continue;
    }
    const facings = arch.facings[0] + Math.floor(rng() * (arch.facings[1] - arch.facings[0] + 1));
    const col = productColor(rng);
    const cell = Math.floor(rng() * PACK_CARTON_CELLS);
    const bottleCell = Math.floor(rng() * 4);
    const labelCol = new THREE.Color(LABEL_COLORS[Math.floor(rng() * LABEL_COLORS.length) % LABEL_COLORS.length]);
    /**
     * A per-facing yaw, applied to every unit in the block.
     *
     * The old code jittered 16% of units individually, which reads as a few
     * knocked-over items on an otherwise perfectly square shelf. What actually
     * happens is that a whole facing gets pushed back crooked by the person
     * restocking behind it, so the block is off-square and its units are
     * parallel to each other.
     */
    const blockYaw = (rng() - 0.5) * 0.16 * (0.4 + run.untidy);

    // A sold-out slot: leave the gap and move on.
    if (rng() < 0.1 * (0.4 + run.untidy)) {
      x += w * facings + 0.02 + rng() * 0.1;
      continue;
    }

    for (let f = 0; f < facings && x < run.x1 - w; f++) {
      const pulled = rng() < 0.22 * (0.3 + run.untidy) ? 0.03 + rng() * 0.09 : 0;
      const cz = lip - run.facing * (d / 2 + pulled);
      const cx = x + w / 2;
      const tiers = stacked ? 2 : 1;

      for (let t = 0; t < tiers; t++) {
        let g: THREE.BufferGeometry;
        if (arch.form === "can") {
          // uvMetres set so the tube's own u comes out as a clean 0..1 wrap,
          // which is what `applyPackaging`'s radial branch needs to keep the
          // seam. See the note there.
          g = buildingTube(w / 2, h, "y", 12, Math.PI * w);
        } else if (arch.form === "jar") {
          g = buildingBottle("squat", h, w / 2);
        } else if (arch.form === "bag") {
          g = bagGeo(axis === "x" ? w : d, h, axis === "x" ? d : w, axis === "x" ? "z" : "x", uvM);
        } else {
          g = buildingBox(axis === "x" ? w : d, h, axis === "x" ? d : w, { uvMetres: uvM });
        }
        // Printed artwork. Every facing of one product shares a cell, because
        // a facing is several of the *same* packet — giving each unit its own
        // cell is the thing that makes a generated shelf look generated.
        if (arch.form === "jar") {
          const [j0, j1] = BOTTLE_LABEL.squat;
          applyBottleLabel(g, bottleCell, h * j0, h * j1);
        } else {
          applyPackaging(g, cell, round);
        }
        // The block's own angle plus a little per-unit slop. The rotation
        // happens at the origin, before the item is placed, so it can never
        // lift it off the shelf.
        const yaw = blockYaw + (rng() < 0.16 * (0.3 + run.untidy) ? (rng() - 0.5) * 0.5 : (rng() - 0.5) * 0.05);
        if (yaw !== 0) g.rotateY(yaw);
        // A lathe stands on its own y = 0; a box and a cylinder are centred.
        // Translating both by the centre height floats the jars 40 mm above
        // the shelf, which is the sort of thing that is invisible in a wide
        // shot and unmissable in the `interior` pose.
        const base = run.y + t * (h + 0.002);
        place(g, cx, arch.form === "jar" ? base : base + h / 2, cz);
        const tinted = arch.form === "jar" ? tintBottle(g, col, labelCol) : tintGeo(g, col);
        out.push(
          shadeBySlotAccess(tinted, {
            deckY: run.y,
            headroom: run.maxHeight,
            lip,
            facing: run.facing,
            outAxis: axis === "x" ? "z" : "x",
            strength: run.shade,
          })
        );
      }
      x += w + 0.002;
    }
    x += 0.008 + rng() * 0.03 * (1 + run.untidy);
  }
  return out;
}

/**
 * A double-sided gondola: kick plate, back panel, and stepped shelves either
 * side that get shallower as they go up, which is how real gondola brackets
 * work and why the top shelf never lines up with the bottom one.
 */
export function buildingGondola(opts: {
  x0: number;
  x1: number;
  cz: number;
  baseY: number;
  height: number;
  rng: Rng;
  untidy: number;
  /** `?bgret=0` turns the up-facing returns off, for the A/B. Default on. */
  returns?: boolean;
  /** `?bgao=0` turns the baked slot-access shading off, for the A/B. */
  shade?: number;
}): { frame: THREE.BufferGeometry; products: THREE.BufferGeometry[]; strips: THREE.BufferGeometry[] } {
  const { x0, x1, cz, baseY, height, rng, untidy } = opts;
  const upReturns = opts.returns !== false;
  const shade = opts.shade ?? 1;
  const uv = new THREE.Vector2(0.6, 0.6);
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  const parts: THREE.BufferGeometry[] = [];
  const products: THREE.BufferGeometry[] = [];
  const strips: THREE.BufferGeometry[] = [];

  /**
   * The printed price strip clipped into a shelf front. Its own quad rather
   * than part of the merged frame, because it needs the strip texture tiled at
   * a fixed real-world pitch: a shelf label is about 60 mm wide whatever the
   * shelf is, so the u range is set from the run length, not from 0..1.
   */
  const STRIP_TILE = 0.62;
  const priceStrip = (sx: number, sy: number, sz: number, runLen: number, faceZ: 1 | -1) => {
    const q = new THREE.PlaneGeometry(runLen, 0.026, 1, 1);
    if (faceZ < 0) q.rotateY(Math.PI);
    const a = q.getAttribute("uv") as THREE.BufferAttribute;
    const reps = Math.max(1, Math.round(runLen / STRIP_TILE));
    for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * reps, a.getY(i));
    a.needsUpdate = true;
    q.translate(sx, sy, sz);
    strips.push(q);
  };

  const box = (px: number, py: number, pz: number, sx: number, sy: number, sz: number) => {
    const g = buildingBox(sx, sy, sz, { uvMetres: uv, uvOrigin: new THREE.Vector3(px, py, pz) });
    g.translate(px, py, pz);
    parts.push(g);
  };

  /**
   * The spine. Not the single slab it used to be.
   *
   * Measured off the `interior` capture, the back panel was 5.2 m by 1.5 m of
   * one flat value — the largest untextured area anywhere in the store and the
   * thing that made the aisle read as blocking-out rather than as a shop. A
   * real gondola run is not a wall; it is slotted uprights at 3 ft centres with
   * the panel hung *between* and behind them, so an aisle reads as a rhythm of
   * verticals.
   *
   * The relief is 16 mm and it is in the mesh rather than in a map on purpose.
   * The upright's side faces point along X while the panel points along Z, so
   * the two genuinely disagree about where the light is coming from. A
   * displaced but *parallel* face would not: NOTES.md case 9 is a crease that
   * moved 47,093 pixels and read as nothing because the surfaces either side
   * of it were 3.3 degrees apart. Which is also why there are no slot
   * punchings modelled here — with no ambient occlusion in this scene, a 2 mm
   * recess whose floor is parallel to the face around it is exactly that
   * invisible crease, and 200 boxes per run of it would cost geometry to
   * render nothing.
   */
  const STANDARD_PITCH = 0.914;
  const bays = Math.max(1, Math.round(len / STANDARD_PITCH));
  box(cx, baseY + height / 2, cz, len, height, 0.024);
  for (let i = 0; i <= bays; i++) {
    const ux = THREE.MathUtils.lerp(x0 + 0.03, x1 - 0.03, i / bays);
    box(ux, baseY + height / 2, cz, 0.048, height, 0.056);
  }
  // Base deck: deeper than the shelves above and boxed in with a kick.
  const baseDepth = 0.58;
  box(cx, baseY + 0.09, cz, len, 0.18, baseDepth * 2);

  /**
   * ### Horizontal rails across the back panel. This is the whole fix, and the
   * ### reason it is horizontal is the only interesting part.
   *
   * The uprights above are 16 mm proud at 914 mm centres: characteristic slope
   * 0.035 against a solar tangent of 0.109, which the outdoor form of Terrain's
   * relief test calls far too shallow and tells you to deepen. **Deepening it
   * would have bought nothing.** Every face that relief creates is vertical —
   * the uprights' sides face along X, the panel faces along Z, both plumb — and
   * this room is lit from the ceiling. Under a near-vertical source those faces
   * differ in *azimuth only* and all of them receive the same near-zero cosine.
   * It was relief oriented for a horizontal light and lit by a vertical one, and
   * more of it does not change the orientation. The critic's "plain grey slabs"
   * was accurate and the albedo was never the problem: `fixture` is 0xa9a69c,
   * pale putty grey, and it renders dark because it is vertical.
   *
   * So the indoor test is not depth over spacing, it is **does this relief
   * create faces that differ along the light's dominant axis** — and indoors
   * that axis is vertical, so what differentiates is an **up-facing return**.
   * The cooler end return found the same thing from pixels on its own evidence:
   * its single horizontal return facing up into the troffers is what broke a
   * 380 x 520 px flat slab, "because of the direction the face points, not
   * because of any shading trick".
   *
   * A real gondola back is panel sections joined at horizontal rails, so this
   * is also simply what the object has. 22 mm proud gives roughly 10 px of lit
   * top face at aisle distance; the underside of each rail above eye height
   * reads as the complementary dark line, which is a value break either way.
   */
  if (upReturns) {
    for (const ry of [0.30, 0.62, 0.94, 1.26]) {
      if (ry > height - 0.12) break;
      box(cx, baseY + ry, cz, len - 0.04, 0.026, 0.056 + 0.044);
    }
    /**
     * ### And the return that actually gets any light, which is a second
     * ### correction on top of the first.
     *
     * The rails above are correctly *oriented* — measured against a same-bundle
     * control they lift their own rows by **+2.3 luma on a mean of 108**, right
     * sign, right place, and completely negligible. Orientation was necessary
     * and is not sufficient, because **an up-facing face still needs something
     * above it to face**. Each of those rails sits 320 mm under the next shelf,
     * which projects 500 mm out over it: the unobstructed wedge from the rail's
     * top face runs from the horizon up to only `atan(320/500)` = 32.6 degrees
     * and forward only, which cosine-weighted is about **7% of a hemisphere**.
     * A return with 7% sky access returns 7% of the effect.
     *
     * This is Canopy's finding in miniature — it measured its soffit darker than
     * the highway underneath it and found that raising the light twice did not
     * help, because a fitting bolted to a panel is a downlight and never lights
     * the panel it is bolted to. Same geometry here: a shelf is a downlight for
     * everything under it, and the returns are under it.
     *
     * So the return that matters is the one with an open view of the ceiling,
     * and on a gondola there is exactly one: the **top capping edge**, standing
     * proud above the highest shelf with nothing over it at all. 100% sky access
     * against 7%. This is also why the cooler end return worked on its own
     * evidence — an end panel has nothing overhanging it either.
     *
     * The check is arithmetic and needed no render: **before adding an up-facing
     * face, work out what fraction of the sky it can see.** Had that been done
     * first, four rails would not have been built to buy 2%.
     */
    const capY = baseY + height - 0.055;
    box(cx, capY, cz, len, 0.03, 0.30 * 2);
    // A small upstand at each edge of the cap, so the cap reads as a pressed
    // steel section catching light on three horizontal faces rather than as one
    // flat lid, and so the top of the unit has a hard bright line on it.
    for (const side of [1, -1] as const) {
      box(cx, capY + 0.028, cz + side * 0.29, len, 0.026, 0.018);
    }
  }

  /**
   * The end of a gondola run, which is a much more important object than its
   * area suggests: down an aisle it is the one face of the whole fitting the
   * camera sees square on, and it used to be a single 24 mm board — 1.16 m by
   * 1.55 m of nothing. A critic read it as unfinished geometry, and it was
   * measured at a mean of 80/255 against 180 for the block wall behind it, so
   * it was not only blank but the darkest large shape in the frame.
   *
   * Real gondola ends are a frame, not a board: two slotted uprights, an infill
   * panel set back between them so the uprights catch a highlight and the panel
   * does not, a plinth under it with the kick recessed, a header, and — nearly
   * always — a cantilevered end-cap shelf or two with promotional stock on it.
   * Every one of those is a horizontal or vertical value break across the slab,
   * which is what the eye was missing. None of it is a texture: at this
   * distance the only thing that separates two surfaces is the angle between
   * them (NOTES.md case 9), so the relief is in the mesh.
   */
  const endShelfDepth = 0.30;
  for (const [ex, out] of [
    [x0 + 0.012, -1],
    [x1 - 0.012, 1],
  ] as const) {
    const post = 0.052;
    const face = ex + out * 0.012;
    // Slotted uprights front and back, standing 12 mm proud of the infill.
    for (const pz of [cz - baseDepth + post / 2, cz + baseDepth - post / 2]) {
      box(face, baseY + height / 2, pz, 0.03, height, post);
      // The slot punchings: shallow, but they run the full height and break up
      // what is otherwise the brightest edge on the fitting.
      for (let sy = 0.14; sy < height - 0.08; sy += 0.0762) {
        box(face + out * 0.016, baseY + sy, pz, 0.004, 0.022, post * 0.42);
      }
    }
    // Infill panel between the uprights, sitting on the base deck and stopping
    // short of the header. Set back 12 mm, so the uprights and the header take
    // the light and the panel stays in their shadow.
    const infill0 = baseY + 0.18;
    const infill1 = baseY + height - 0.09;
    box(ex, (infill0 + infill1) / 2, cz, 0.024, infill1 - infill0, (baseDepth - post) * 2);
    // Base rail over the deck, and the header across the top.
    box(face, infill0 + 0.014, cz, 0.034, 0.028, baseDepth * 2);
    box(face, baseY + height - 0.045, cz, 0.034, 0.09, baseDepth * 2);
    /**
     * Mid-rails across the infill, for the reason set out at the back panel: the
     * end is the one face of the fitting an aisle camera sees square on, it is
     * plumb, and the light is overhead, so the two uprights either side of it
     * cannot separate it from itself. A horizontal return can. The header and
     * the base rail above were already doing this at the two extremes and are
     * the reason the end reads better than the spine did.
     */
    if (upReturns) {
      for (const ry of [0.46, 0.86, 1.24]) {
        if (baseY + ry > infill1 - 0.1) break;
        box(face, baseY + ry, cz, 0.03, 0.024, (baseDepth - post) * 2);
      }
    }

    // Cantilevered end-cap shelves. These are what stop the end reading as a
    // panel: they put stock, and the shadow under a shelf, out in front of it.
    for (const sy of [0.52, 0.98]) {
      const y = baseY + sy;
      box(ex + out * (endShelfDepth / 2 + 0.012), y, cz, endShelfDepth, 0.022, (baseDepth - post) * 2 - 0.03);
      box(ex + out * (endShelfDepth + 0.004), y + 0.024, cz, 0.014, 0.03, (baseDepth - post) * 2 - 0.03);
      products.push(
        ...buildingShelfProducts(
          {
            x0: cz - baseDepth + post + 0.03,
            x1: cz + baseDepth - post - 0.03,
            zFront: ex + out * (endShelfDepth - 0.02),
            depth: endShelfDepth - 0.05,
            y: y + 0.012,
            facing: out,
            untidy,
            maxHeight: 0.3,
            shade,
          },
          rng,
          "z"
        )
      );
    }
  }

  const levels = [0.42, 0.74, 1.04, 1.32];
  for (const side of [1, -1] as const) {
    // The base deck itself is merchandised.
    products.push(
      ...buildingShelfProducts(
        { x0: x0 + 0.05, x1: x1 - 0.05, zFront: cz + side * baseDepth, depth: baseDepth, y: baseY + 0.18, facing: side, untidy, maxHeight: 0.22, shade },
        rng
      )
    );
    for (let i = 0; i < levels.length; i++) {
      const y = baseY + levels[i];
      if (y + 0.1 > baseY + height) break;
      const depth = 0.5 - i * 0.05;
      box(cx, y - 0.011, cz + side * depth * 0.5, len - 0.05, 0.022, depth);
      // Front price rail: a 25 mm lip, and the reason a shelf edge catches light.
      box(cx, y + 0.012, cz + side * (depth - 0.008), len - 0.05, 0.026, 0.016);
      priceStrip(cx, y + 0.012, cz + side * (depth - 0.0005), len - 0.06, side);
      const headroom = i + 1 < levels.length ? levels[i + 1] - levels[i] - 0.05 : 0.3;
      products.push(
        ...buildingShelfProducts(
          { x0: x0 + 0.05, x1: x1 - 0.05, zFront: cz + side * depth, depth, y: y + 0.012, facing: side, untidy, maxHeight: headroom, shade },
          rng
        )
      );
    }
  }

  return { frame: mergeLocal(parts), products, strips };
}

export type BottleKind = "tall" | "squat" | "can";

/**
 * Where the wrap label sits on each family, as a fraction of the height.
 *
 * Exported because three separate things have to agree on it: the lathe
 * profile puts real vertices on these two lines, `applyBottleLabel` maps the
 * atlas cell between them, and `tintBottle` changes vertex colour across them.
 * If any of the three drifted the label would print onto the shoulder or the
 * liquid colour would stop somewhere other than the label edge.
 */
export const BOTTLE_LABEL: Record<BottleKind, [number, number]> = {
  tall: [0.11, 0.52],
  squat: [0.1, 0.42],
  can: [0.07, 0.93],
};

/**
 * A drinks bottle as a lathe. Three families - a tall thin water/soda bottle,
 * a squat juice bottle and a can - cover everything a cooler holds without any
 * of them looking like a copy of the next.
 *
 * The profile carries an explicit vertex pair on each edge of the label, and
 * the label stands 0.4 mm proud between them. That is not decoration: it puts
 * a *ring perpendicular to the surface* at each edge, which is the only kind
 * of relief that shows without ambient occlusion (NOTES.md case 9), and it
 * gives `tintBottle` a real crease to change colour across instead of a
 * gradient smeared over whichever profile points happened to be nearby.
 */
export function buildingBottle(kind: BottleKind, height: number, radius: number): THREE.BufferGeometry {
  const [l0, l1] = BOTTLE_LABEL[kind];
  const wrap = radius + 0.0004;
  if (kind === "can") {
    const pts = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(radius * 0.88, 0),
      new THREE.Vector2(radius, height * 0.06),
      new THREE.Vector2(radius, height * l0),
      new THREE.Vector2(wrap, height * l0),
      new THREE.Vector2(wrap, height * l1),
      new THREE.Vector2(radius, height * l1),
      new THREE.Vector2(radius, height * 0.94),
      new THREE.Vector2(radius * 0.86, height * 0.98),
      new THREE.Vector2(radius * 0.8, height),
      new THREE.Vector2(0, height),
    ];
    return new THREE.LatheGeometry(pts, 14);
  }
  const shoulder = kind === "tall" ? 0.66 : 0.52;
  const neckR = radius * (kind === "tall" ? 0.34 : 0.42);
  /**
   * The belly, which has to sit *above* the top of the label.
   *
   * A lathe profile is a polyline swept round Y, and nothing stops it doubling
   * back: with the belly at 0.7 of the shoulder and the label ending at 0.56,
   * the profile ran up to 0.56, back down to 0.46 and up again, so every
   * bottle in the cooler carried an inverted cone above its label. It renders
   * without complaint and it is invisible in a wide shot, which is why it took
   * the `cooler` pose at 40 px a bottle to see it.
   */
  const belly = Math.max(shoulder * 0.7, l1 + 0.05);
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(radius * 0.9, 0),
    new THREE.Vector2(radius, height * 0.035),
    new THREE.Vector2(radius * 0.97, height * l0),
    new THREE.Vector2(wrap, height * l0),
    new THREE.Vector2(wrap, height * l1),
    new THREE.Vector2(radius, height * l1),
    new THREE.Vector2(radius, height * belly),
    new THREE.Vector2(radius * 0.99, height * shoulder),
    new THREE.Vector2(neckR * 1.5, height * (shoulder + 0.16)),
    new THREE.Vector2(neckR, height * (shoulder + 0.24)),
    new THREE.Vector2(neckR, height * 0.9),
    new THREE.Vector2(neckR * 1.12, height * 0.92),
    new THREE.Vector2(neckR * 1.12, height),
    new THREE.Vector2(0, height),
  ];
  return new THREE.LatheGeometry(pts, 16);
}

/**
 * Two-tone vertex colour for a bottle: the drink below and behind the label,
 * the printed label across it.
 *
 * A single tint is what made these read as coloured plastic bullets. The
 * packaging atlas is greyscale by design — it carries structure and the vertex
 * colour carries hue — so a cola bottle tinted 0x231610 end to end multiplies
 * a white label down to 14/255 and the print disappears into the liquid. Real
 * drinks packaging is exactly the opposite: the darkest thing in the cooler is
 * the liquid and the brightest is the label wrapped round it, and that
 * contrast is most of what makes a cooler shelf legible from across a store.
 */
/**
 * Multiply a shelf item's vertex colour by how much of its own slot mouth the
 * vertex can see.
 *
 * ## Why this and not more light
 *
 * The critic has called interior products "solid-colour boxes" and shelves
 * "plain grey slabs" twice, and both times the obvious reading was a texture
 * problem. It is not: the packaging maps bind, the albedo is right, and two
 * rounds of artwork work did not move the verdict. What the frames are missing
 * is *shading*. Measured on the `door` pose — the pose for the interaction the
 * brief specifies — the vertical local-contrast asymmetry is **0.99x**, against
 * 1.05–1.24x on every pose the sun reaches, and the interior's 1st percentile
 * sits at luma 56. An interior with no dark side is an interior lit by a
 * constant, and no amount of print on the boxes can stand in for that.
 *
 * The part of it that is geometry rather than light transport is this: a product
 * on a shelf is inside a slot, open on one side, and **the back corners of that
 * slot can see almost nothing**. That is computable here, from numbers the
 * caller already has, without modelling any bounce.
 *
 * The quantity is the angular extent of the slot mouth as seen from the vertex:
 * `atan(headroom / depth) + atan(riser / depth)`, over the π that a vertex at
 * the mouth itself would see. It falls with depth into the slot and peaks at
 * mid-height, which puts the darkest values in the back corners and the
 * brightest on the front lip — where a real shelf's highlight is.
 *
 * Deliberately *not* "how much ceiling can it see", which was the first
 * formulation. The honest answer to that is nearly zero everywhere inside a
 * gondola slot, because the mouth faces sideways and the troffers are overhead —
 * which is a true statement about the scene and would render every shelf black.
 * The missing energy is aisle bounce, and that is Lighting's term, not a number
 * to bake in here. This bakes the geometric factor that composes with it.
 *
 * Floors rather than a bare multiply, per `NOTES.md` case 44: the range of this
 * field is 0..1 by construction, but a product that goes to zero is a product
 * that has stopped being merchandise.
 *
 * ## What it is measured to be worth, which is not much
 *
 * A/B'd with `?bgao=0` against the identical bundle: the `door` pose moved the
 * fraction under luma 32 from 0.01% to 0.03% and its asymmetry from 0.99x to
 * 0.98x; `interior` 5.88% → 6.16%; `cooler` 1.39% → 1.56%. Bound and correct and
 * **visually indistinguishable.**
 *
 * The reason is worth more than the term: an occlusion factor baked into an
 * object darkens the faces that point away from the opening, and those are the
 * faces the camera cannot see. The back corners of a slot are dark and hidden by
 * the same geometry. What a viewer reads as shading on a shelf is the shadow
 * cast **on the deck, on the underside of the shelf above, and on the
 * neighbouring units** — surfaces that belong to the fitting, which is merged
 * into a material carrying no vertex colours. That is where the next attempt
 * goes. Kept because it is free at runtime and physically right, not because it
 * fixed anything.
 */
export function shadeBySlotAccess(
  geo: THREE.BufferGeometry,
  opts: {
    /** World y of the deck the item stands on. */
    deckY: number;
    /** Clear height from the deck to whatever is above it. */
    headroom: number;
    /** World coordinate of the slot mouth on the outward axis. */
    lip: number;
    /** +1 or −1: which way the outward axis points from the fitting. */
    facing: number;
    /** Which world axis is "out of the slot". */
    outAxis: "x" | "z";
    /** Lowest factor at the back of the slot. */
    floor?: number;
    /** Lowest factor where an item meets the deck. */
    contactFloor?: number;
    /** 0 disables the term entirely, for the A/B. Default 1. */
    strength?: number;
  }
): THREE.BufferGeometry {
  const strength = opts.strength ?? 1;
  if (strength <= 0) return geo;
  const col = geo.getAttribute("color");
  if (!col) return geo;
  const pos = geo.getAttribute("position");
  const floor = opts.floor ?? 0.4;
  const contactFloor = opts.contactFloor ?? 0.7;
  const topY = opts.deckY + Math.max(0.06, opts.headroom);

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const outward = opts.outAxis === "x" ? pos.getX(i) : pos.getZ(i);
    // Distance back from the mouth. A vertex pulled proud of the lip reads as
    // being at the mouth, not outside the slot.
    const depth = Math.max(0.006, opts.facing * (opts.lip - outward));
    const headroom = Math.max(0.004, topY - y);
    const riser = Math.max(0.004, y - opts.deckY);
    const open = (Math.atan(headroom / depth) + Math.atan(riser / depth)) / Math.PI;
    let k = floor + (1 - floor) * Math.pow(Math.min(1, open), 0.7);
    // The line where an object meets the shelf: a contact shadow, and the single
    // most missed cue in a rendered interior.
    k *= contactFloor + (1 - contactFloor) * Math.min(1, riser / 0.035);
    k = 1 + (k - 1) * strength;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
  return geo;
}

export function tintBottle(geo: THREE.BufferGeometry, liquid: THREE.Color, label: THREE.Color): THREE.BufferGeometry {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  /**
   * The label is identified by **radius, not height**, and the difference is
   * not a detail — the first version of this selected `y0 <= y <= y1` with a
   * half-millimetre inset and coloured *nothing*.
   *
   * A lathe only has vertices where the profile has points. The profile puts
   * two points on each edge of the label and none in between, so both of the
   * band's own boundary rows sat outside an inset test and every vertex on the
   * bottle came out liquid-coloured. It is a silent failure of the worst kind:
   * the geometry, the UVs and the map were all correct, the artwork was
   * visibly printing, and only the *colour* was dead — so it looked like a
   * palette that needed tuning rather than a selector that matched nothing.
   * What proved it was changing the palette wholesale and measuring: the new
   * colours moved **0.000% of the `cooler` frame, maximum delta 3**. A change
   * that moves no pixels is not a subtle change.
   *
   * The wrap stands 0.4 mm proud, so it is the greatest radial extent of every
   * family, and picking it out by radius cannot drift away from the profile
   * the way a pair of copied constants can.
   */
  let maxR2 = 0;
  for (let i = 0; i < n; i++) {
    const r2 = pos.getX(i) ** 2 + pos.getZ(i) ** 2;
    if (r2 > maxR2) maxR2 = r2;
  }
  const cut = maxR2 * 0.998;
  for (let i = 0; i < n; i++) {
    const c = pos.getX(i) ** 2 + pos.getZ(i) ** 2 >= cut ? label : liquid;
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Colours a cooler is actually full of: colas, waters, energy drinks, juice. */
export const DRINK_COLORS = [
  0x231610, 0x1c1310, 0x6d2b23, 0x9c5f1c, 0x2a5c33, 0x1c4270, 0x8fa8b0, 0xa8a63c, 0x4a2456, 0x93481f,
  0x8496a0, 0xb4b8b4, 0x2f2b28,
];

/**
 * Label colours: the brand colour, not the paper.
 *
 * The first cut of this list was mostly whites, on the reasoning that a label's
 * *ground* is paper and the atlas supplies the print on top of it. That is true
 * of the artwork and false of the render, because one vertex colour multiplies
 * the whole cell — ground and ink together — so a white entry produces a white
 * label with grey marks on it and no brand colour can ever appear. Measured in
 * the `cooler` pose the whole cabinet came out pastel.
 *
 * Saturated entries are the right way round: the cell's near-white ground
 * carries the colour and its dark marks carry the structure, which is what a
 * printed label actually looks like. A few genuine whites stay, because milk,
 * water and own-brand exist.
 */
export const LABEL_COLORS = [
  0xc0392b, 0xd0532a, 0xdca62a, 0x2b6cb0, 0x1f7a4d, 0x6b3fa0, 0x18324f, 0xb03a2e, 0x2f9e8f, 0xf2efe8,
  0xe8e6e0, 0xd8d4c8,
];
