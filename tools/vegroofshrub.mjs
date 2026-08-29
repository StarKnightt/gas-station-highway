#!/usr/bin/env node
/**
 * Which pines read as growing out of the building, in every preset at once.
 *
 * Three critics have reported "a shrub is on the roof". The placement has been
 * corrected once already, on the evidence of one pose, and the capture taken
 * this session shows the defect still there — the move relocated the
 * coincidence rather than removing it. That is the predictable outcome of
 * fixing a *composition* problem against a single camera, so this checks all
 * seven at once and does it on the CPU, where a candidate position costs
 * milliseconds instead of a two-minute capture.
 *
 * The read is not "the tree is inside the footprint". Every pine is correctly
 * outside it and always has been, which is why two rounds spent on the
 * exclusion mask found nothing. The read is:
 *
 *   the building hides the trunk and the lower crown, and what is left
 *   visible is a detached lump of foliage whose bottom edge sits at or just
 *   above the parapet line.
 *
 * So the quantity is the **lowest point of the tree that the camera can still
 * see**, compared against the parapet's own screen row at the same screen
 * column. If the lowest visible foliage is above the parapet and the tree
 * overlaps the building on screen, the eye has nothing connecting the crown to
 * the ground and it will put it on the roof.
 *
 *   node tools/vegroofshrub.mjs [--x=N --z=N --pine=I]
 *
 * `--pine=I --x --z` re-tests one pine at a trial position without editing the
 * source, so a candidate can be cleared against every preset before it is
 * committed. Pure computation, no GPU, nothing to tear down.
 */

const W = 1600;
const H = 900;

/** Kept in step with tools/shoot6.mjs POSES by hand; both are short lists. */
const POSES = {
  approach: { pos: [-30.0, 1.65, -7.6], look: [-1.0, 1.6, 20.0], fov: 46 },
  edge: { pos: [-27.0, 0.5, 6.15], look: [8.0, 0.3, 7.2], fov: 44 },
  pines: { pos: [14.0, 2.01, 34.0], look: [-32.0, 6.0, 19.0], fov: 55 },
  horizon: { pos: [34.0, 1.67, 20.0], look: [122.0, 3.0, 46.0], fov: 36 },
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },
  sunlit: { pos: [-32.0, 1.39, 9.0], look: [18.0, 5.0, 30.0], fov: 42 },
  wires: { pos: [-21.0, 1.79, -18.0], look: [-16.0, 6.2, 52.0], fov: 30 },
};

/** VegetationSystem.PINES. */
const PINES = [
  { x: -33.0, z: 10.0, h: 13.0 },
  { x: -38.5, z: 19.5, h: 9.8 },
  { x: -30.0, z: 23.5, h: 15.2 },
  { x: -27.0, z: 52.0, h: 11.4 },
  { x: 29.5, z: 61.5, h: 8.6 },
  { x: 34.0, z: 48.5, h: 14.1 },
  { x: 40.5, z: 24.0, h: 8.0 },
  { x: -63.0, z: 60.0, h: 16.2 },
  { x: 74.0, z: 38.0, h: 12.4 },
  { x: -52.0, z: -24.0, h: 13.2 },
];

/** building.footprint as the system publishes it, plus PLAN.parapet + floor. */
const BOX = { x0: -9.1, x1: 3.5, z0: 31.5, z1: 40.0, y0: -1, y1: 4.5 };
/** Foliage starts about a third of the way up a pine; below that is bare stem. */
const CROWN_BASE = 0.34;

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.slice(n.length + 3)) : d;
};
const trialPine = arg("pine", NaN);
if (Number.isFinite(trialPine)) {
  PINES[trialPine] = { ...PINES[trialPine], x: arg("x", PINES[trialPine].x), z: arg("z", PINES[trialPine].z) };
  console.log(`trial: pine ${trialPine} moved to (${PINES[trialPine].x}, ${PINES[trialPine].z})`);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Does the segment from `a` to `b` pass through the axis-aligned box? */
function segmentHitsBox(a, b) {
  const d = sub(b, a);
  let t0 = 0;
  let t1 = 1;
  const lo = [BOX.x0, BOX.y0, BOX.z0];
  const hi = [BOX.x1, BOX.y1, BOX.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (a[i] < lo[i] || a[i] > hi[i]) return false;
      continue;
    }
    let n0 = (lo[i] - a[i]) / d[i];
    let n1 = (hi[i] - a[i]) / d[i];
    if (n0 > n1) [n0, n1] = [n1, n0];
    t0 = Math.max(t0, n0);
    t1 = Math.min(t1, n1);
    if (t0 > t1) return false;
  }
  return true;
}

function camera(p) {
  const fwd = norm(sub(p.look, p.pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const tanHalf = Math.tan((p.fov * 0.5 * Math.PI) / 180);
  const aspect = W / H;
  return (w) => {
    const d = sub(w, p.pos);
    const z = dot(d, fwd);
    if (z <= 0.05) return null;
    return {
      sx: ((dot(d, right) / (z * tanHalf * aspect)) * 0.5 + 0.5) * W,
      sy: (0.5 - (dot(d, up) / (z * tanHalf)) * 0.5) * H,
      z,
    };
  };
}

/**
 * Worst hidden-fraction over every preset, for one pine at a trial position.
 * Returned rather than printed so the sweep below can call it thousands of
 * times; the reporting loop uses the same predicate so the two cannot drift.
 */
function scorePine(t) {
  let bad = 0;
  for (const pose of Object.values(POSES)) {
    const proj = camera(pose);
    const corners = [
      [BOX.x0, BOX.y1, BOX.z0],
      [BOX.x1, BOX.y1, BOX.z0],
      [BOX.x0, BOX.y1, BOX.z1],
      [BOX.x1, BOX.y1, BOX.z1],
    ]
      .map(proj)
      .filter(Boolean);
    if (!corners.length) continue;
    const bx0 = Math.min(...corners.map((c) => c.sx));
    const bx1 = Math.max(...corners.map((c) => c.sx));
    const parapetSy = Math.max(...corners.map((c) => c.sy));
    const top = proj([t.x, t.h, t.z]);
    if (!top || top.sx < -80 || top.sx > W + 80 || top.sy > H) continue;
    let visFrom = null;
    for (let k = 0; k <= 100; k++) {
      const y = (k / 100) * t.h;
      if (!segmentHitsBox(pose.pos, [t.x, y, t.z])) {
        visFrom = y;
        break;
      }
    }
    if (visFrom === null || visFrom <= CROWN_BASE * t.h + 0.01) continue;
    const cut = proj([t.x, visFrom, t.z]);
    if (!cut) continue;
    if (!(top.sx > bx0 - 30 && top.sx < bx1 + 30)) continue;
    if (!(cut.sy < parapetSy + 8)) continue;
    bad = Math.max(bad, visFrom / t.h);
  }
  return bad;
}

const sweep = arg("sweep", NaN);
if (Number.isFinite(sweep)) {
  const base = PINES[sweep];
  const ok = [];
  for (let dx = -14; dx <= 14; dx += 0.5) {
    for (let dz = -14; dz <= 14; dz += 0.5) {
      const t = { ...base, x: base.x + dx, z: base.z + dz };
      // Keep it away from the other pines and off the paving, or a clean score
      // is bought by putting the tree somewhere it must not be.
      let near = false;
      for (let j = 0; j < PINES.length; j++)
        if (j !== sweep && Math.hypot(PINES[j].x - t.x, PINES[j].z - t.z) < 7) near = true;
      if (near) continue;
      if (t.x > -14 && t.x < 8 && t.z > 26 && t.z < 45) continue; // hard by the building
      if (scorePine(t) === 0) ok.push({ ...t, move: Math.hypot(dx, dz) });
    }
  }
  ok.sort((a, b) => a.move - b.move);
  console.log(
    `pine ${sweep} at (${base.x}, ${base.z}) scores ${(scorePine(base) * 100).toFixed(0)}% hidden.\n` +
      `${ok.length} clean positions within 14 m. Nearest ten:`
  );
  for (const c of ok.slice(0, 10))
    console.log(`  (${c.x.toFixed(1)}, ${c.z.toFixed(1)})  ${c.move.toFixed(1)} m away`);
  process.exit(0);
}

let worst = 0;
for (const [name, pose] of Object.entries(POSES)) {
  const proj = camera(pose);
  // The parapet's own screen extent, from its four top corners.
  const corners = [
    [BOX.x0, BOX.y1, BOX.z0],
    [BOX.x1, BOX.y1, BOX.z0],
    [BOX.x0, BOX.y1, BOX.z1],
    [BOX.x1, BOX.y1, BOX.z1],
  ]
    .map(proj)
    .filter(Boolean);
  if (!corners.length) continue;
  const bx0 = Math.min(...corners.map((c) => c.sx));
  const bx1 = Math.max(...corners.map((c) => c.sx));
  const parapetSy = Math.max(...corners.map((c) => c.sy)); // lowest edge of the coping

  const lines = [];
  for (let i = 0; i < PINES.length; i++) {
    const t = PINES[i];
    const top = proj([t.x, t.h, t.z]);
    if (!top || top.sx < -80 || top.sx > W + 80 || top.sy > H) continue;
    // Lowest point on the trunk axis the camera can still see.
    let visFrom = null;
    for (let k = 0; k <= 100; k++) {
      const y = (k / 100) * t.h;
      if (!segmentHitsBox(pose.pos, [t.x, y, t.z])) {
        visFrom = y;
        break;
      }
    }
    if (visFrom === null) continue; // wholly hidden: no read at all
    if (visFrom <= CROWN_BASE * t.h + 0.01) continue; // stem visible, reads as a tree
    const cut = proj([t.x, visFrom, t.z]);
    if (!cut) continue;
    // On screen, is the severed bottom of the tree sitting on the coping, and
    // is the tree over the building at all?
    const overlaps = top.sx > bx0 - 30 && top.sx < bx1 + 30;
    const aboveCoping = cut.sy < parapetSy + 8;
    if (!overlaps || !aboveCoping) continue;
    const hidden = visFrom / t.h;
    const px = Math.max(0, cut.sy - top.sy);
    worst = Math.max(worst, hidden);
    lines.push(
      `    pine ${i} (${t.x}, ${t.z}) h=${t.h}: ${(hidden * 100).toFixed(0)}% of its height hidden, ` +
        `${px.toFixed(0)} px of detached crown at x=${top.sx.toFixed(0)}, ` +
        `its cut bottom y=${cut.sy.toFixed(0)} against coping y=${parapetSy.toFixed(0)}`
    );
  }
  if (lines.length) {
    console.log(`\n${name}: building spans x ${bx0.toFixed(0)}..${bx1.toFixed(0)}, coping bottom y ${parapetSy.toFixed(0)}`);
    for (const l of lines) console.log(l);
  }
}

if (!worst) console.log("\nno pine reads as growing on the building in any preset");
else console.log(`\nworst case: ${(worst * 100).toFixed(0)}% of a pine's height hidden behind the building`);
process.exit(worst ? 1 : 0);
