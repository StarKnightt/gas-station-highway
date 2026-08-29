#!/usr/bin/env node
/**
 * CPU-only reproduction of `lightShadows.fitSunShadow` for each shoot6 preset,
 * to answer statically whether a given pine is inside the fitted shadow volume
 * at all.
 *
 * This exists because of a builder/critic contradiction: a `?vshadow=0` region
 * probe measured foliage shadows changing 14.3% of the forecourt in `pines`,
 * while the critic reports the pines throwing no shadow in `pines` and
 * `approach` but throwing correct raking shadows in `wide`. A per-preset
 * difference with the same materials points at the frustum fit, not at the
 * alpha-test tuning, and the fit is pure arithmetic — no GPU needed.
 *
 * The important subtlety in `fitSunShadow` is that `casterDepth` extends the
 * volume *along the light direction only*. Laterally the volume is exactly
 * ±radius about the frustum sphere centre. So a caster off to the side of the
 * fitted sphere is not "behind the near plane and still included" — it is
 * outside the box and contributes nothing, however tall its shadow.
 *
 *   node tools/vegshadowfit.mjs
 */

/* ---- mirrored from src/site.ts ---- */
const SUN = { azimuth: Math.PI * 1.13 };
const SUN_ELEVATION_DEG = 6.2; // LightingSystem overrides site's 11 degrees

/* ---- mirrored from src/systems/LightingSystem.ts ---- */
const SHADOW_MAP_SIZE = 8192;
const SHADOW_DISTANCE = 80;
const SHADOW_CASTER_DEPTH = 95;

/* ---- mirrored from src/core/Game.ts ---- */
const CAM_NEAR = 0.08;
const CAM_FAR = 2500;
const VIEW_W = 1600;
const VIEW_H = 900;

/* ---- mirrored from tools/shoot6.mjs POSES ---- */
const POSES = {
  approach: { pos: [-30.0, 1.65, -7.6], look: [-1.0, 1.6, 20.0], fov: 46 },
  edge: { pos: [-27.0, 0.5, 6.15], look: [8.0, 0.3, 7.2], fov: 44 },
  pines: { pos: [14.0, 1.62, 34.0], look: [-32.0, 6.0, 19.0], fov: 55 },
  horizon: { pos: [34.0, 1.65, 20.0], look: [110.0, 3.0, 90.0], fov: 36 },
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },
};

/* ---- mirrored from src/systems/VegetationSystem.ts PINES ---- */
const PINES = [
  { x: -33.0, z: 10.0, h: 13.0 },
  { x: -38.5, z: 19.5, h: 9.8 },
  { x: -30.5, z: 30.5, h: 15.2 },
  { x: -27.0, z: 52.0, h: 11.4 },
  { x: 9.0, z: 51.0, h: 8.6 },
  { x: 34.0, z: 48.5, h: 14.1 },
  { x: 40.5, z: 24.0, h: 8.0 },
  { x: -63.0, z: 60.0, h: 16.2 },
  { x: 74.0, z: 38.0, h: 12.4 },
  { x: -52.0, z: -24.0, h: 13.2 },
];
/** The store, for comparison: the critic says its shadow is present. */
const BUILDING = { minX: -17, maxX: 3.5, minZ: 31.5, maxZ: 40.0, h: 5.2 };

/* ------------------------------------------------------------------ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => mul(a, 1 / len(a));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
const az = SUN.azimuth;
const sunDir = norm([Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
/** Metres of ground shadow per metre of caster height. */
const shadowPerMetre = Math.cos(el) / Math.sin(el);
/** Unit ground direction the shadow runs in (away from the sun). */
const shadowDir = norm([-sunDir[0], 0, -sunDir[2]]);

/** Exactly `frustumSphere()` from lightShadows.ts. */
function frustumSphere(pos, look, fovDeg, aspect, distance) {
  const near = CAM_NEAR;
  const far = Math.min(CAM_FAR, distance);
  const tan = Math.tan((fovDeg * 0.5 * Math.PI) / 180);
  const hNear = tan * near;
  const hFar = tan * far;
  const a = hNear * hNear * (1 + aspect * aspect);
  const b = hFar * hFar * (1 + aspect * aspect);
  let cz = (b - a) / (2 * (far - near)) + (far + near) / 2;
  cz = Math.min(far, Math.max(near, cz));

  let radius = 0;
  for (const [z, h] of [
    [near, hNear],
    [far, hFar],
  ]) {
    const w = h * aspect;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const c = [sx * w, sy * h, -z];
        radius = Math.max(radius, len(sub(c, [0, 0, -cz])));
      }
  }

  // View basis, matching Object3D.lookAt with up = +Y.
  const fwd = norm(sub(look, pos)); // -Z of the camera
  const zAxis = mul(fwd, -1);
  let xAxis = cross([0, 1, 0], zAxis);
  if (len(xAxis) < 1e-6) xAxis = [1, 0, 0];
  xAxis = norm(xAxis);
  const yAxis = cross(zAxis, xAxis);
  // centre = pos + R * (0,0,-cz)
  const centre = add(pos, mul(zAxis, -cz));
  return { centre, radius, basis: { xAxis, yAxis, zAxis } };
}

/**
 * Light-space extents of the fitted box, and a containment test. Mirrors the
 * ortho camera set up in fitSunShadow: ±radius laterally (plus a sub-texel
 * snap offset that we ignore, it is under 2 cm), near 0.5, far back + radius.
 */
function lightVolume(centre, radius) {
  const back = radius + SHADOW_CASTER_DEPTH;
  const lightPos = add(centre, mul(sunDir, back));
  // The shadow camera looks from lightPos at centre, so its -Z is -sunDir.
  const zAxis = sunDir; // camera +Z points back toward the light
  let xAxis = cross([0, 1, 0], zAxis);
  if (len(xAxis) < 1e-6) xAxis = [1, 0, 0];
  xAxis = norm(xAxis);
  const yAxis = cross(zAxis, xAxis);
  const texel = (radius * 2) / SHADOW_MAP_SIZE;
  return {
    lightPos,
    texel,
    near: 0.5,
    far: back + radius + 2,
    /** Light-space (x, y, depth-from-light) of a world point. */
    project(p) {
      const d = sub(p, lightPos);
      return { x: dot(d, xAxis), y: dot(d, yAxis), depth: -dot(d, zAxis) };
    },
    halfExtent: radius,
  };
}

console.log(`sun azimuth ${((az * 180) / Math.PI).toFixed(1)} deg, elevation ${SUN_ELEVATION_DEG} deg`);
console.log(`sunDir  (${sunDir.map((v) => v.toFixed(4)).join(", ")})`);
console.log(`ground shadow ${shadowPerMetre.toFixed(2)} m per metre of height, running toward (${shadowDir[0].toFixed(3)}, ${shadowDir[2].toFixed(3)})`);
console.log(`shadow volume: +-radius laterally about the frustum sphere centre; casterDepth ${SHADOW_CASTER_DEPTH} m extends DEPTH ONLY\n`);

const aspect = VIEW_W / VIEW_H;
for (const [name, p] of Object.entries(POSES)) {
  const { centre, radius } = frustumSphere(p.pos, p.look, p.fov, aspect, SHADOW_DISTANCE);
  const vol = lightVolume(centre, radius);
  console.log(
    `${name.padEnd(9)} fov ${String(p.fov).padStart(2)}  sphere centre (${centre.map((v) => v.toFixed(1)).join(", ")})  radius ${radius.toFixed(1)} m  texel ${(vol.texel * 100).toFixed(2)} cm`
  );

  const rows = [];
  for (let i = 0; i < PINES.length; i++) {
    const t = PINES[i];
    // Test the crown centroid: that is what casts the shadow the critic wants.
    const crown = [t.x, t.h * 0.7, t.z];
    const q = vol.project(crown);
    const insideXY = Math.abs(q.x) <= vol.halfExtent && Math.abs(q.y) <= vol.halfExtent;
    const insideZ = q.depth >= vol.near && q.depth <= vol.far;
    // Where its shadow lands, and is that point inside the volume laterally?
    const tip = [t.x + shadowDir[0] * t.h * shadowPerMetre, 0, t.z + shadowDir[2] * t.h * shadowPerMetre];
    const qt = vol.project(tip);
    const tipInside = Math.abs(qt.x) <= vol.halfExtent && Math.abs(qt.y) <= vol.halfExtent;
    rows.push({
      i,
      pos: `(${t.x},${t.z})`,
      h: t.h,
      dist: len(sub([t.x, 0, t.z], p.pos)).toFixed(1),
      lx: q.x.toFixed(1),
      ly: q.y.toFixed(1),
      casts: insideXY && insideZ,
      tipInside,
    });
  }
  const bx = (BUILDING.minX + BUILDING.maxX) / 2;
  const bz = (BUILDING.minZ + BUILDING.maxZ) / 2;
  const qb = vol.project([bx, BUILDING.h * 0.7, bz]);
  const bIn = Math.abs(qb.x) <= vol.halfExtent && Math.abs(qb.y) <= vol.halfExtent;

  for (const r of rows) {
    console.log(
      `   pine${r.i} ${r.pos.padEnd(12)} h${String(r.h).padStart(5)}  cam dist ${r.dist.padStart(6)}  light xy (${r.lx.padStart(7)},${r.ly.padStart(7)})  ` +
        `caster ${r.casts ? "IN " : "OUT"}  shadow tip ${r.tipInside ? "in " : "out"}`
    );
  }
  console.log(
    `   store  (${bx},${bz})  light xy (${qb.x.toFixed(1)}, ${qb.y.toFixed(1)})  caster ${bIn ? "IN " : "OUT"}`
  );
  const nIn = rows.filter((r) => r.casts).length;
  console.log(`   -> ${nIn}/${rows.length} pines inside the shadow volume\n`);
}
