#!/usr/bin/env node
/**
 * Where on the forecourt can a puddle actually be seen?
 *
 * A puddle is a specular feature, so unlike every albedo feature it is not
 * bounded by the light falling on it — it is bounded by the light falling on
 * whatever it reflects. That is the one mechanism available on a surface whose
 * measured tonal spread is 7% of range, and it is why this item is worth doing.
 *
 * But it cuts both ways. Under a canopy the mirror direction may land on the
 * *soffit*, which is dark, in which case the pool renders as a dark patch on a
 * dark surface and achieves nothing. Whether it does is pure geometry and can be
 * settled before any code is written, which is what this tool is for. No GPU.
 *
 * The geometry, for a horizontal pool:
 *
 *   A camera at height `h` above the water, looking at a pool point P at
 *   horizontal distance `d`, sees the mirror ray leave P *away from the camera*,
 *   rising at the same angle the view descended: theta = atan(h/d).
 *
 *   That ray reaches soffit height H after horizontal travel L = H*d/h. If it
 *   leaves the deck footprint before travelling L, it escapes under the deck
 *   edge and reflects sky or distant ground. If not, it reflects soffit.
 *
 *   So: bright iff escapeDistance < H*d/h. Note the consequence, which is the
 *   opposite of the intuition — *near* pools reflect soffit and *far* pools
 *   reflect sky, because a near pool is viewed steeply and its mirror ray climbs
 *   into the roof within a few metres.
 *
 * Also reported, because a claim in my own handover from the previous round
 * needs checking rather than inheriting: whether the deck actually shadows the
 * forecourt at all.
 *
 * Usage: node tools/poolsite.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsresolve.mjs", pathToFileURL(`${import.meta.dirname}/`));

const site = await import("../src/site.ts");
const { CANOPY } = await import("../src/gen/canopyParts.ts");
const { SUN, FORECOURT, ISLANDS, ISLAND, PAD, groundHeight } = site;

const el = SUN.elevation;
const az = SUN.azimuth;
/** Unit vector pointing *toward* the sun. */
const sun = {
  x: Math.sin(az) * Math.cos(el),
  y: Math.sin(el),
  z: Math.cos(az) * Math.cos(el),
};

console.log("=".repeat(78));
console.log("1. Does the canopy deck shadow the forecourt?");
console.log("=".repeat(78));
console.log(
  `sun: azimuth ${((az * 180) / Math.PI).toFixed(1)} deg, elevation ${((el * 180) / Math.PI).toFixed(1)} deg`,
);
console.log(`unit vector toward sun: (${sun.x.toFixed(3)}, ${sun.y.toFixed(3)}, ${sun.z.toFixed(3)})`);

// A ground point is shadowed by the deck if the ray from it toward the sun
// crosses the deck plane inside the deck footprint. The deck is a thin slab, so
// there is exactly one crossing height to test.
const deckH = CANOPY.clear;
const t = deckH / sun.y;
// Displacement along the ray toward the sun, at deck height. A ground point is
// shadowed when THIS offset lands it inside the footprint, so the shadow region
// on the ground is the footprint translated by the negation.
const rx = t * sun.x;
const rz = t * sun.z;
console.log(
  `\na ray toward the sun rises ${deckH} m after travelling ${t.toFixed(1)} m,` +
    ` displaced (${rx.toFixed(2)}, ${rz.toFixed(2)}) in XZ`,
);
console.log(
  `so the shadow on the ground is the footprint translated by (${(-rx).toFixed(1)}, ${(-rz).toFixed(1)}):`,
);
console.log(
  `  deck   x ${CANOPY.minX}..${CANOPY.maxX}   z ${CANOPY.minZ}..${CANOPY.maxZ}`,
);
console.log(
  `  shadow x ${(CANOPY.minX - rx).toFixed(1)}..${(CANOPY.maxX - rx).toFixed(1)}` +
    `   z ${(CANOPY.minZ - rz).toFixed(1)}..${(CANOPY.maxZ - rz).toFixed(1)}`,
);
console.log(`  forecourt x ${FORECOURT.minX}..${FORECOURT.maxX}   z ${FORECOURT.minZ}..${FORECOURT.maxZ}`);

const shadowed = (x, z) =>
  x + rx >= CANOPY.minX && x + rx <= CANOPY.maxX && z + rz >= CANOPY.minZ && z + rz <= CANOPY.maxZ;
let nShadow = 0;
let nTot = 0;
for (let z = FORECOURT.minZ; z <= FORECOURT.maxZ; z += 0.4) {
  for (let x = FORECOURT.minX; x <= FORECOURT.maxX; x += 0.4) {
    if (shadowed(x, z)) nShadow++;
    nTot++;
  }
}
console.log(
  `\nfraction of the forecourt inside the deck's shadow: ${((100 * nShadow) / nTot).toFixed(1)}%`,
);
console.log(
  `Lambert factor on a horizontal surface at this sun: sin(el) = ${Math.sin(el).toFixed(3)}` +
    ` — a horizontal plane receives ${(100 * Math.sin(el)).toFixed(0)}% of the beam`,
);

console.log("\n" + "=".repeat(78));
console.log("2. Natural low points of the forecourt height field");
console.log("=".repeat(78));
// Where water would actually stand. Uses groundHeight, which is what the mesh is
// built from - authoring against padY and rendering from groundHeight is the
// disagreement that silently erased the entrance ruts.
let lo = { y: 1e9 };
let hi = { y: -1e9 };
const col = [];
for (let z = FORECOURT.minZ + 0.4; z <= FORECOURT.maxZ - 0.4; z += 0.3) {
  for (let x = FORECOURT.minX + 0.4; x <= FORECOURT.maxX - 0.4; x += 0.3) {
    // Skip the island footprints: they are raised and cannot hold water.
    let onIsland = false;
    for (const isl of ISLANDS) {
      if (Math.abs(x - isl.cx) < ISLAND.length / 2 + 0.3 && Math.abs(z - isl.cz) < ISLAND.width / 2 + 0.3) {
        onIsland = true;
      }
    }
    if (onIsland) continue;
    const y = groundHeight(x, z);
    col.push({ x, z, y });
    if (y < lo.y) lo = { x, z, y };
    if (y > hi.y) hi = { x, z, y };
  }
}
col.sort((a, b) => a.y - b.y);
console.log(`forecourt relief: ${((hi.y - lo.y) * 1000).toFixed(0)} mm between highest and lowest`);
console.log(`highest: (${hi.x.toFixed(1)}, ${hi.z.toFixed(1)}) at ${hi.y.toFixed(3)}`);
console.log(`lowest 8 samples, which is where standing water belongs:`);
for (const c of col.slice(0, 8)) {
  console.log(`  (${c.x.toFixed(1).padStart(6)}, ${c.z.toFixed(1).padStart(5)})  y ${c.y.toFixed(4)}`);
}

console.log("\n" + "=".repeat(78));
console.log("3. What would a pool at each candidate site reflect?");
console.log("=".repeat(78));

/** Cameras. `walk_pump` is the pose that can actually see the stances. */
const CAMERAS = [
  ["walk_pump", -8.5, 19.9, 7.5, 22.0],
  ["walk_store", 5.0, 20.0, -5.0, 31.0],
  ["walk_sun", -4.0, 26.0, -11.0, 8.0],
];
const EYE = 1.62;

const CANDIDATES = [
  ["A: column 2 downpipe, off island NE", 3.9, 24.4],
  ["B: east apron, outside the deck", 8.8, 21.0],
  ["C: west apron, outside the deck", -8.8, 21.6],
  ["D: mid-forecourt between islands", 0.0, 19.9],
  ["E: forecourt low point (from part 2)", col[0].x, col[0].z],
];

const inDeck = (x, z) =>
  x >= CANOPY.minX && x <= CANOPY.maxX && z >= CANOPY.minZ && z <= CANOPY.maxZ;

/** Horizontal distance from P along direction v until leaving the deck rect. */
const escapeDist = (x, z, vx, vz) => {
  if (!inDeck(x, z)) return 0;
  let best = Infinity;
  const test = (num, den) => {
    if (Math.abs(den) < 1e-9) return;
    const s = num / den;
    if (s > 0 && s < best) best = s;
  };
  test(CANOPY.minX - x, vx);
  test(CANOPY.maxX - x, vx);
  test(CANOPY.minZ - z, vz);
  test(CANOPY.maxZ - z, vz);
  return best;
};

console.log(
  "\ncandidate                              camera      dist   theta  escape  needed   reflects",
);
console.log("-".repeat(100));
for (const [label, px, pz] of CANDIDATES) {
  for (const [cname, cx, cz] of CAMERAS) {
    const ddx = px - cx;
    const ddz = pz - cz;
    const d = Math.hypot(ddx, ddz);
    const vx = ddx / d;
    const vz = ddz / d;
    const theta = (Math.atan(EYE / d) * 180) / Math.PI;
    const E = escapeDist(px, pz, vx, vz);
    const needed = (deckH * d) / EYE;
    const bright = E < needed;
    // Fresnel for water at this incidence, Schlick with F0 = 0.02.
    const cosI = Math.sin((theta * Math.PI) / 180);
    const F = 0.02 + 0.98 * Math.pow(1 - cosI, 5);
    console.log(
      `${label.padEnd(38)} ${cname.padEnd(11)} ${d.toFixed(1).padStart(5)}  ${theta.toFixed(1).padStart(5)}  ` +
        `${(E === 0 ? "—" : E.toFixed(1)).padStart(6)}  ${needed.toFixed(1).padStart(6)}   ` +
        `${bright ? "SKY" : "soffit"}  F=${(100 * F).toFixed(0)}%`,
    );
  }
  console.log("-".repeat(100));
}

console.log("\n" + "=".repeat(78));
console.log("4. Pool extent from the existing height field, per water level");
console.log("=".repeat(78));
console.log(`
A pool is clipped per-pixel against the rendered surface, so a water LEVEL on an
already-uneven slab produces a shoreline for free — depth goes to zero where the
ground rises through the level, which is the edge the critic said was missing.
The question is whether the existing 130 mm of forecourt relief is enough to hold
a pool of usable size without authoring a dip.
`);
for (const [label, px, pz] of CANDIDATES) {
  const y0 = groundHeight(px, pz);
  console.log(`${label}  centre (${px.toFixed(1)}, ${pz.toFixed(1)}) ground y ${y0.toFixed(4)}`);
  for (const rise of [0.004, 0.008, 0.015, 0.025]) {
    const level = y0 + rise;
    // Flood fill from the centre at 6 cm resolution, so an unconnected low spot
    // elsewhere does not get counted as part of this pool.
    const step = 0.06;
    const seen = new Set();
    const key = (i, j) => `${i},${j}`;
    const stack = [[0, 0]];
    seen.add(key(0, 0));
    let cells = 0;
    let maxDepth = 0;
    let minI = 0;
    let maxI = 0;
    let minJ = 0;
    let maxJ = 0;
    while (stack.length && cells < 60000) {
      const [i, j] = stack.pop();
      const y = groundHeight(px + i * step, pz + j * step);
      if (y >= level) continue;
      cells++;
      maxDepth = Math.max(maxDepth, level - y);
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
      for (const [ni, nj] of [
        [i + 1, j],
        [i - 1, j],
        [i, j + 1],
        [i, j - 1],
      ]) {
        if (!seen.has(key(ni, nj))) {
          seen.add(key(ni, nj));
          stack.push([ni, nj]);
        }
      }
    }
    const area = cells * step * step;
    console.log(
      `   level +${(rise * 1000).toFixed(0).padStart(2)} mm:` +
        ` area ${area.toFixed(1).padStart(6)} m2,` +
        ` extent ${((maxI - minI) * step).toFixed(1)} x ${((maxJ - minJ) * step).toFixed(1)} m,` +
        ` max depth ${(maxDepth * 1000).toFixed(0).padStart(2)} mm` +
        (cells >= 60000 ? "  (unbounded - level is above the local rim)" : ""),
    );
  }
}

console.log("\n" + "=".repeat(78));
console.log("5. The authored forecourt basins: does the water stay in them?");
console.log("=".repeat(78));
const { FORECOURT_POOLS, forecourtPoolLevel, FORECOURT_MIRROR_DEPTH } = site;
const SLAB_TOP = (x, z) => site.padY(x, z) + 0.021;
if (!FORECOURT_POOLS?.length) {
  console.log("no forecourt pools authored (or forced off)");
} else {
  for (const p of FORECOURT_POOLS) {
    const level = forecourtPoolLevel(p, SLAB_TOP);
    // Flood outward from the centre over the slab surface, exactly as the shader
    // does per fragment: covered where the level is above the surface.
    const step = 0.03;
    const seen = new Set([`0,0`]);
    const stack = [[0, 0]];
    let cells = 0;
    let maxDepth = 0;
    let sumDepth = 0;
    let minI = 0;
    let maxI = 0;
    let minJ = 0;
    let maxJ = 0;
    let escaped = false;
    let deepCells = 0;
    while (stack.length && cells < 200000) {
      const [i, j] = stack.pop();
      const wx = p.x + i * step;
      const wz = p.z + j * step;
      const d = level - SLAB_TOP(wx, wz);
      if (d <= 0) continue;
      cells++;
      maxDepth = Math.max(maxDepth, d);
      sumDepth += d;
      if (d >= FORECOURT_MIRROR_DEPTH) deepCells++;
      minI = Math.min(minI, i);
      maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j);
      maxJ = Math.max(maxJ, j);
      // Escape test: the gate radius. Water reaching it would be cut by the
      // ellipse instead of by the ground, which is the hard-edge failure.
      const gr = Math.hypot((wx - p.x) / (p.rx * 1.15), (wz - p.z) / (p.rz * 1.15));
      if (gr > 0.94) escaped = true;
      for (const [ni, nj] of [
        [i + 1, j],
        [i - 1, j],
        [i, j + 1],
        [i, j - 1],
      ]) {
        const k = `${ni},${nj}`;
        if (!seen.has(k)) {
          seen.add(k);
          stack.push([ni, nj]);
        }
      }
    }
    const area = cells * step * step;
    console.log(
      `\npool at (${p.x}, ${p.z})  dish ${(p.depth * 1000).toFixed(0)} mm,` +
        ` water +${(p.water * 1000).toFixed(0)} mm  ->  level ${level.toFixed(4)}`,
    );
    console.log(
      `  wetted area   ${area.toFixed(2)} m2 over ${((maxI - minI) * step).toFixed(2)} x ${((maxJ - minJ) * step).toFixed(2)} m`,
    );
    console.log(
      `  depth         max ${(maxDepth * 1000).toFixed(1)} mm, mean ${((1000 * sumDepth) / Math.max(1, cells)).toFixed(1)} mm`,
    );
    console.log(
      `  mirror zone   ${((100 * deepCells) / Math.max(1, cells)).toFixed(0)}% of the pool is over ${(FORECOURT_MIRROR_DEPTH * 1000).toFixed(0)} mm,` +
        ` i.e. past the roughness ramp and reflecting`,
    );
    console.log(
      `  gate clear    ${escaped ? "NO - water reaches the ellipse, the edge will be a hard cut" : "yes - the shoreline is the terrain contour everywhere"}`,
    );
    // The drying stain. Its outer radius is 1.05 +- 0.22 in gate units and the
    // gate is 1.15x the dish, so it lands on the dish rim by construction; this
    // reports where that falls in metres, because "coincides with the rim" is a
    // claim about two numbers multiplied together and is worth printing.
    const stainOuter = 1.27;
    console.log(
      `  drying stain  reaches ${(p.rx * 1.15 * stainOuter).toFixed(2)} x ${(p.rz * 1.15 * stainOuter).toFixed(2)} m from centre` +
        `, against a dish rim at ${p.rx.toFixed(2)} x ${p.rz.toFixed(2)} m` +
        ` (${((100 * p.rx * 1.15 * stainOuter) / p.rx - 100).toFixed(0)}% beyond)`,
    );
    // Screen footprint from the stance that sees it best, because a feature's
    // size in the frame is what decides whether it is a feature.
    for (const [cname, cx, cz, lx, lz] of CAMERAS) {
      const d = Math.hypot(p.x - cx, p.z - cz);
      const theta = Math.atan(EYE / d);
      const wide = 2 * Math.hypot(p.rx, p.rz) * 0.62;
      const pxW = (((wide / d) * 180) / Math.PI) * (1080 / 50);
      const pxH = ((((wide * Math.sin(theta)) / d) * 180) / Math.PI) * (1080 / 50);
      const cosI = Math.sin(theta);
      const F = 0.02 + 0.98 * Math.pow(1 - cosI, 5);
      // In frame at all? A pixel count for something behind the camera is the
      // error that cost a whole round: marks measured from poses that could not
      // contain them. 50 degrees vertical on 16:9 is 79.6 horizontal.
      const hl = Math.hypot(lx - cx, lz - cz);
      const dot = ((p.x - cx) * (lx - cx) + (p.z - cz) * (lz - cz)) / (d * hl);
      const off = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
      const inFrame = off < 39.8;
      console.log(
        `    ${cname.padEnd(11)} ${d.toFixed(1).padStart(5)} m,` +
          ` ${off.toFixed(0).padStart(2)} deg off axis` +
          (inFrame
            ? `, about ${Math.round(pxW).toString().padStart(4)} x ${Math.round(pxH).toString().padStart(3)} px at 1080p,` +
              ` Fresnel ${(100 * F).toFixed(0)}%`
            : "  — OUT OF FRAME, no pixel count is meaningful"),
      );
    }
  }
}

console.log(`
Reading the table: 'escape' is how far the mirror ray travels before leaving the
deck footprint, 'needed' is how far it would have to travel to reach soffit
height. escape < needed means it gets out and reflects sky. A dash means the pool
is outside the deck footprint entirely, so nothing is above it.

F is the Fresnel reflectance of water at that grazing angle. It is the reason
this works at all: a pool seen at 4 degrees returns most of what it reflects,
against a 41-luma surface that returns 19% of a low sun.
`);
