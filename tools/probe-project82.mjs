#!/usr/bin/env node
/**
 * Which object occupies a screen box, computed on CPU with no browser?
 *
 *   node tools/probe-project82.mjs
 *   node tools/probe-project82.mjs --box=1240,300,70,180 --deg=82
 *
 * ## Why this exists
 *
 * The box `1240,300,70,180` was drawn when the white rectangle was believed to
 * be a window notice. That pairing was withdrawn and **the box was kept**, so
 * every number since has described a region whose contents nobody had
 * established. Vegetation asked the right question: what is actually in it.
 *
 * That question does not need the card. The stance is deterministic
 * (`walkprobe.mjs`'s own constants), the camera is `PerspectiveCamera(52, 16/9,
 * 0.08, 2500)` from `Game.ts`, and the candidate geometry is pure arithmetic
 * over plan dimensions that already live in `src/gen/buildingLayout.ts` because
 * this system was made headless-constructible this morning. So the projection is
 * done here, in Node, with the matrices written out by hand.
 *
 * This is the instrument that should have produced the region in the first
 * place. Deriving a measurement region from the object rather than drawing it on
 * the picture is the rule from NOTES, "A surface invariant to every lighting
 * lever is not lit" — and doing it on CPU means it costs nothing to redo.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Extensionless relative imports inside src/ need the resolver hook; re-exec
// with it rather than making the caller remember. NOTES, "ERR_MODULE_NOT_FOUND
// on a file that exists is Node's resolver".
if (!process.env.DS_TS_RESOLVE) {
  const { spawnSync } = await import("node:child_process");
  const hook = path.join(ROOT, "tools", "ts-resolve.mjs");
  if (!existsSync(hook)) {
    console.error("tools/ts-resolve.mjs is missing; cannot import from src/");
    process.exit(1);
  }
  const r = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(hook).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, DS_TS_RESOLVE: "1" } }
  );
  process.exit(r.status ?? 1);
}

const { PLAN, IN, COOLER, buildingFloorHeight } = await import("../src/gen/buildingLayout.ts");

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const BOX = arg("box", "1240,300,70,180").split(",").map(Number);
const DEG = Number(arg("deg", 82));
const W = 1600;
const H = 900;

/* ---- the camera, exactly as the app and walkprobe build it ---- */
const FOV = 52;
const NEAR = 0.08;
const FAR = 2500;
const GLASS_Z = 31.6;
const GLASS_X = -3.4;
const STANCE_D = 3.6;
const EYE = 1.65;

const F = buildingFloorHeight();
const a = (DEG * Math.PI) / 180;
const eye = { x: GLASS_X - Math.sin(a) * STANCE_D, y: F + EYE, z: GLASS_Z - Math.cos(a) * STANCE_D };
const look = { x: GLASS_X, y: F + EYE, z: GLASS_Z };

/**
 * View matrix by hand. three's `lookAt` builds a right-handed basis with -Z
 * forward, then `matrixWorldInverse` is its transpose-plus-translation for a
 * pure rotation. Written out rather than imported so this file never needs
 * three, and so the arithmetic is auditable next to the numbers it produces.
 */
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const norm = (v) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (p, q) => ({
  x: p.y * q.z - p.z * q.y,
  y: p.z * q.x - p.x * q.z,
  z: p.x * q.y - p.y * q.x,
});
const dot = (p, q) => p.x * q.x + p.y * q.y + p.z * q.z;

const zAxis = norm(sub(eye, look)); // three's lookAt: +Z points back at the eye
const xAxis = norm(cross({ x: 0, y: 1, z: 0 }, zAxis));
const yAxis = cross(zAxis, xAxis);

/** World point -> screen pixel, plus the view-space depth. */
function project(p) {
  const d = sub(p, eye);
  const vx = dot(d, xAxis);
  const vy = dot(d, yAxis);
  const vz = dot(d, zAxis); // negative in front of the camera
  const depth = -vz;
  if (depth <= NEAR) return null;
  const f = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const aspect = W / H;
  const ndcX = (f / aspect) * vx / depth;
  const ndcY = f * vy / depth;
  return { x: (ndcX * 0.5 + 0.5) * W, y: (1 - (ndcY * 0.5 + 0.5)) * H, depth };
}

/** Screen bbox of a set of world corners, with the nearest depth. */
function bbox(corners) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, near = Infinity, seen = 0;
  for (const c of corners) {
    const s = project(c);
    if (!s) continue;
    seen++;
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    near = Math.min(near, s.depth);
  }
  if (!seen) return null;
  return { minX, minY, maxX, maxY, near, w: maxX - minX, h: maxY - minY };
}

const rectXZ = (x0, x1, z0, z1, y) => [
  { x: x0, y, z: z0 }, { x: x1, y, z: z0 }, { x: x1, y, z: z1 }, { x: x0, y, z: z1 },
];
const rectXY = (x0, x1, y0, y1, z) => [
  { x: x0, y: y0, z }, { x: x1, y: y0, z }, { x: x1, y: y1, z }, { x: x0, y: y1, z },
];
const rectZY = (z0, z1, y0, y1, x) => [
  { x, y: y0, z: z0 }, { x, y: y0, z: z1 }, { x, y: y1, z: z1 }, { x, y: y1, z: z0 },
];

/* ---- the candidates ---- */
const candidates = [];

// Ceiling troffers, from buildCeiling's own grid arithmetic.
{
  const TILE_W = 0.6096;
  const TILE_L = 1.2192;
  const x0 = IN.x0, x1 = IN.x1, z0 = PLAN.z0 + 0.02, z1 = IN.z1;
  const nx = Math.ceil((x1 - x0) / TILE_W);
  const nz = Math.ceil((z1 - z0) / TILE_L);
  const y = F + PLAN.ceiling;
  const fixtureCells = [
    [2, 0], [Math.max(3, nx - 5), 0], [4, 2],
    [Math.max(3, nx - 6), 2], [Math.floor(nx / 2) - 3, 4], [Math.max(3, nx - 4), 4],
  ];
  console.log(`ceiling grid: ${nx} x ${nz} tiles, y = ${y.toFixed(3)} m, floor F = ${F.toFixed(3)} m`);
  fixtureCells.forEach(([i, j], n) => {
    const ax0 = x0 + i * TILE_W + 0.012;
    const ax1 = Math.min(x0 + (i + 1) * TILE_W - 0.012, x1);
    const az0 = z0 + j * TILE_L + 0.012;
    const az1 = Math.min(z0 + (j + 1) * TILE_L - 0.012, z1);
    // The lens is a quad facing -y, inset 0.02 and 0.026 below the pan top.
    candidates.push({
      name: `troffer-diffuser[${n}] cell(${i},${j})`,
      corners: rectXZ(ax0 + 0.01, ax1 - 0.01, az0 + 0.01, az1 - 0.01, y + 0.026),
      size: `${(ax1 - ax0).toFixed(2)} x ${(az1 - az0).toFixed(2)} m, horizontal, faces down`,
    });
  });
}

// Window notices, taped inside the glass, facing out.
{
  const sfZ = PLAN.z0 + PLAN.sfZ;
  for (const s of [
    { cell: "hiring", x: -4.9, y: 1.55, w: 0.3 },
    { cell: "card", x: -4.52, y: 1.2, w: 0.22 },
    { cell: "tabs", x: -7.4, y: 1.62, w: 0.26 },
    { cell: "community", x: 0.9, y: 1.72, w: 0.24 },
  ]) {
    // Aspect is in the sheet and not exported; 1.4 portrait is representative
    // and the width is what the oblique view compresses anyway.
    const h = s.w * 1.4;
    candidates.push({
      name: `window-notice[${s.cell}]`,
      corners: rectXY(s.x - s.w / 2, s.x + s.w / 2, F + s.y - h / 2, F + s.y + h / 2, sfZ + 0.012),
      size: `${s.w.toFixed(2)} x ${h.toFixed(2)} m, vertical, faces -z`,
    });
  }
}

/**
 * The two entry-door notices, after A0 and A1.
 *
 * Predicting these on CPU is what makes the next GPU load worth taking: a load
 * was already lost to a dropped homogeneous coordinate in the in-browser
 * projection, and the same arithmetic done here from the plan constants is free
 * and independent. If these do not land on (1275,390) and (1085,570), the fix is
 * in the wrong place and no screenshot is needed to know it.
 *
 * Door-local coordinates, hinge at `PLAN.doorX0 + jamb`, sill at `F`, leaf face
 * at `sfZ`. The quads are now at `+0.009` — the interior surface — with heights
 * from each cell's own aspect (`tabs` 0.72, `community` 0.78). The small Z
 * rotations are ignored: a few degrees of tape-skew moves a corner by under two
 * pixels at this range and cannot change which pixel the box contains.
 */
{
  const sfZ = PLAN.z0 + PLAN.sfZ;
  const hingeX = PLAN.doorX0 + 0.06;
  for (const s of [
    { cell: "tabs", x: 0.3, y: 1.55, w: 0.21, aspect: 0.72 },
    { cell: "community", x: 0.63, y: 1.36, w: 0.15, aspect: 0.78 },
  ]) {
    const h = s.w / s.aspect;
    const cx = hingeX + s.x;
    candidates.push({
      name: `entry-door-notice[${s.cell}]`,
      corners: rectXY(cx - s.w / 2, cx + s.w / 2, F + s.y - h / 2, F + s.y + h / 2, sfZ + 0.009),
      size: `${s.w.toFixed(2)} x ${h.toFixed(2)} m, vertical, faces -z, inside the leaf`,
    });
  }
}

// Interior sign plates. `exit` is hung from the ceiling short of the door and
// faces back into the room, so from outside the shop it is seen from behind —
// which is exactly the shape of "a large flat panel floating in the interior".
{
  const exitY = F + PLAN.ceiling - 0.24;
  for (const s of [
    { cell: "exit", w: 0.34, x: -6.0, y: exitY, z: 32.3, facing: "+z" },
    { cell: "restroom", w: 0.4, x: IN.x0 + 0.02, y: F + 2.05, z: 38.6, facing: "+x" },
    { cell: "employees", w: 0.3, x: IN.x0 + 0.02, y: F + 1.6, z: 39.2, facing: "+x" },
    { cell: "nosmoking", w: 0.2, x: -6.95, y: F + 1.62, z: PLAN.z0 + PLAN.sfZ - 0.022, facing: "-z" },
  ]) {
    const h = s.w * 1.4;
    candidates.push({
      name: `sign-plate[${s.cell}]`,
      corners:
        s.facing === "+x"
          ? rectZY(s.z - s.w / 2, s.z + s.w / 2, s.y - h / 2, s.y + h / 2, s.x)
          : rectXY(s.x - s.w / 2, s.x + s.w / 2, s.y - h / 2, s.y + h / 2, s.z),
      size: `${s.w.toFixed(2)} x ${h.toFixed(2)} m, vertical, faces ${s.facing}`,
    });
  }
}

// Window vinyl, on the OUTSIDE of the glass, so between camera and shop.
{
  const vz = PLAN.z0 + PLAN.sfZ - 0.022;
  for (const d of [
    { cell: "hours", x: -4.35, y: 1.72, w: 0.46 },
    { cell: "open", x: -3.0, y: 1.94, w: 0.78 },
    { cell: "payment", x: 0.62, y: 1.62, w: 0.44 },
    { cell: "notice", x: -7.75, y: 1.28, w: 0.34 },
  ]) {
    const h = d.w * 1.4;
    candidates.push({
      name: `window-vinyl[${d.cell}]`,
      corners: rectXY(d.x - d.w / 2, d.x + d.w / 2, F + d.y - h / 2, F + d.y + h / 2, vz),
      size: `${d.w.toFixed(2)} x ${h.toFixed(2)} m, vertical, faces -z (outside the glass)`,
    });
  }
}

// Cooler liner, at the back of the cabinet, facing the aisle.
candidates.push({
  name: "cooler-liner",
  corners: rectXY(COOLER.x0, COOLER.x1, F + COOLER.kick, F + COOLER.height, IN.z1 - 0.02),
  size: `${(COOLER.x1 - COOLER.x0).toFixed(2)} x ${COOLER.height.toFixed(2)} m, vertical, faces -z`,
});

// The interior side walls, as a sanity reference for anything large and pale.
candidates.push({
  name: "(reference) interior west wall",
  corners: rectZY(PLAN.z0, IN.z1, F, F + PLAN.ceiling, IN.x0),
  size: "vertical, faces +x",
});

/* ---- report ---- */
const [bx, by, bw, bh] = BOX;
const bcx = bx + bw / 2;
const bcy = by + bh / 2;
console.log(
  `\ncamera: eye (${eye.x.toFixed(2)}, ${eye.y.toFixed(2)}, ${eye.z.toFixed(2)}) ` +
    `-> look (${look.x.toFixed(2)}, ${look.y.toFixed(2)}, ${look.z.toFixed(2)}), ` +
    `fov ${FOV}, ${W}x${H}, incidence ${DEG} deg`
);
console.log(`query box: x ${bx}-${bx + bw}, y ${by}-${by + bh} (centre ${bcx}, ${bcy})\n`);

const rows = [];
for (const c of candidates) {
  const b = bbox(c.corners);
  if (!b) {
    rows.push({ name: c.name, verdict: "entirely behind the camera", b: null, c });
    continue;
  }
  const onScreen = b.maxX > 0 && b.minX < W && b.maxY > 0 && b.minY < H;
  const containsCentre = bcx >= b.minX && bcx <= b.maxX && bcy >= b.minY && bcy <= b.maxY;
  const ox = Math.max(0, Math.min(b.maxX, bx + bw) - Math.max(b.minX, bx));
  const oy = Math.max(0, Math.min(b.maxY, by + bh) - Math.max(b.minY, by));
  rows.push({
    name: c.name,
    b,
    c,
    onScreen,
    containsCentre,
    coverage: (ox * oy) / (bw * bh),
  });
}

/**
 * The inverse question, which is the one that actually names the object: send a
 * ray through the box centre and say where it is in world space at each depth.
 * A projection can only test candidates somebody thought of; a ray tells you
 * where to look.
 */
{
  const f = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const ndcX = (bcx / W) * 2 - 1;
  const ndcY = 1 - (bcy / H) * 2;
  const vx = (ndcX * (W / H)) / f;
  const vy = ndcY / f;
  // View space: (vx, vy, -1) per unit depth, then back to world.
  const dir = norm({
    x: xAxis.x * vx + yAxis.x * vy - zAxis.x,
    y: xAxis.y * vx + yAxis.y * vy - zAxis.y,
    z: xAxis.z * vx + yAxis.z * vy - zAxis.z,
  });
  console.log(`ray through the box centre, dir (${dir.x.toFixed(3)}, ${dir.y.toFixed(3)}, ${dir.z.toFixed(3)}):`);
  for (const d of [1, 2, 3, 4, 6, 8, 12]) {
    const p = { x: eye.x + dir.x * d, y: eye.y + dir.y * d, z: eye.z + dir.z * d };
    const inside =
      p.x > IN.x0 && p.x < IN.x1 && p.z > PLAN.z0 && p.z < IN.z1 && p.y > F && p.y < F + PLAN.ceiling;
    console.log(
      `   ${String(d).padStart(3)} m  (${p.x.toFixed(2).padStart(7)}, ${p.y.toFixed(2).padStart(5)}, ${p.z.toFixed(2).padStart(6)})` +
        `  ${inside ? "inside the shop" : "outside the shop volume"}`
    );
  }
  console.log("");
}

rows.sort((p, q) => (q.coverage ?? -1) - (p.coverage ?? -1));
for (const r of rows) {
  if (!r.b) {
    console.log(`  ${r.name.padEnd(34)} ${r.verdict}`);
    continue;
  }
  const b = r.b;
  console.log(
    `  ${r.name.padEnd(34)} screen ${String(Math.round(b.w)).padStart(5)}x${String(Math.round(b.h)).padEnd(5)} ` +
      `at (${String(Math.round(b.minX)).padStart(6)}, ${String(Math.round(b.minY)).padStart(5)})  ` +
      `${b.near.toFixed(2)} m  ` +
      `covers ${(r.coverage * 100).toFixed(0).padStart(3)}% of the box` +
      (r.containsCentre ? "  <-- CONTAINS THE BOX CENTRE" : r.onScreen ? "" : "  (off screen)")
  );
  console.log(`  ${"".padEnd(34)} ${r.c.size}`);
}
