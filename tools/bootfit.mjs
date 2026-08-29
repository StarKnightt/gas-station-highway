#!/usr/bin/env node
/**
 * Does the stowed nozzle stay inside the boot it is stowed in?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/bootfit.mjs
 *   ... --selftest
 *
 * `nozzleprobe.mjs` measures whether the nozzle is *seated* — how far down the
 * cup the spout has dropped and whether the body bears on the rim. It is the
 * right question and it has a blind spot: it only ever looks down the mouth, so
 * a spout that has swung sideways and come out through the *wall* of the pocket
 * passes it cleanly. That is what was happening. In round 192457Z the spout tip
 * sat about 75 mm off the pocket axis against a 41 mm wall, emerged through the
 * lower front of the boot and hung visibly in mid air, and every existing probe
 * called the pose good.
 *
 * So this one tests containment instead of depth: for every vertex of every
 * stowed nozzle part below the mouth, how far is it outside the pocket's own
 * surface, or below its floor. Positive is a breach in millimetres.
 *
 * The pocket profile is duplicated here from `buildPump`, which is a real
 * hazard — NOTES case 17's double-authoring — so the constants are named and
 * the tool prints them, and `--selftest` plants a known breach so a silent
 * drift in either copy shows up as the selftest failing rather than as a green
 * run on a broken scene.
 */

import * as THREE from "three";
import { PUMP, pumpVariation, nozzlePartsStowed } from "../src/gen/pumpParts.ts";

/**
 * Must match the boot section in `buildPump`, expressed in the pocket's own
 * raked frame. Measuring this in world Y is what let the last containment pass
 * come back green on a boot whose sections were 10 mm out of line: the bore is
 * raked `face * 0.10` about X, so a vertical yardstick is not measuring the
 * cup's wall, it is measuring a slice through it.
 */
const BOOT = {
  oval: 0.66,
  rake: 0.10,
  /** Pocket centre relative to `PUMP.bootY`. Local +Y runs up the bore. */
  centreDY: -0.030,
  mouthR0: 0.058,
  mouthR1: 0.050,
  mouthHalf: 0.066,
  sheathR1: 0.050,
  sheathEnd: -0.132,
  floorY: -0.129,
};

/** Bore radius at a height along the raked axis, measured from the centre. */
function pocketRadius(ly) {
  if (ly > BOOT.mouthHalf) return BOOT.mouthR0;
  if (ly > -BOOT.mouthHalf)
    return THREE.MathUtils.lerp(BOOT.mouthR0, BOOT.mouthR1, (BOOT.mouthHalf - ly) / (BOOT.mouthHalf * 2));
  return BOOT.sheathR1;
}

/** Worst breach in metres, and which part produced it. */
export function worstBreach(parts, face) {
  const centre = new THREE.Vector3(
    face * PUMP.bootX,
    PUMP.bootY + BOOT.centreDY,
    (face * PUMP.headD) / 2 + face * 0.070
  );
  const unrake = new THREE.Matrix4().makeRotationX(-face * BOOT.rake);
  const v = new THREE.Vector3();
  let worst = { bad: -Infinity, label: "-", wall: 0, floor: 0 };
  for (const p of parts) {
    const pos = p.geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(centre).applyMatrix4(unrake);
      if (v.y > BOOT.mouthHalf) continue; // above the mouth, nothing to be inside of
      const wall = Math.hypot(v.x, v.z / BOOT.oval) - pocketRadius(v.y);
      const below = BOOT.floorY - v.y;
      const bad = Math.max(wall, below);
      if (bad > worst.bad) worst = { bad, label: p.label, wall, floor: below };
    }
  }
  return worst;
}

function main() {
  console.log(
    `bore: mouth ${(BOOT.mouthR0 * 2000).toFixed(0)}->${(BOOT.mouthR1 * 2000).toFixed(0)} mm over ` +
      `${(BOOT.mouthHalf * 2000).toFixed(0)} mm then straight to ${(BOOT.sheathEnd * 1000).toFixed(0)} mm, ` +
      `oval ${BOOT.oval} on Z, raked ${BOOT.rake} rad, floor at ${(BOOT.floorY * 1000).toFixed(0)} mm
`
  );
  let bad = 0;
  for (const face of [1, -1]) {
    for (const seed of [1, 2, 3]) {
      const w = worstBreach(nozzlePartsStowed(face, pumpVariation(seed)), face);
      const verdict = w.bad > 0.002 ? "  BREACH" : "";
      if (w.bad > 0.002) bad++;
      console.log(
        `face ${face > 0 ? "+Z" : "-Z"} seed ${seed}: worst ${(w.bad * 1000).toFixed(1).padStart(6)} mm ` +
          `by "${w.label}"  (through wall ${(w.wall * 1000).toFixed(1)}, below floor ${(w.floor * 1000).toFixed(1)})${verdict}`
      );
    }
  }
  console.log(
    bad
      ? `\n${bad} of 6 stowed nozzles leave the boot. A tube emerging through the side of a holster is visible from every pose that shows the boot.`
      : `\nAll six contained.`
  );
  process.exit(bad ? 1 : 0);
}

/**
 * The control that has to fail. A probe that cannot fail is not evidence, and
 * this one would go quiet the moment the pocket constants drifted apart from
 * `buildPump`'s: a pocket believed to be huge contains everything.
 */
function selftest() {
  const parts = nozzlePartsStowed(-1, pumpVariation(1));
  const clean = worstBreach(parts, -1);
  const planted = parts.map((p) => ({
    label: p.label,
    geo: p.geo.clone().translate(0.150, 0, 0),
  }));
  const moved = worstBreach(planted, -1);
  const ok = clean.bad <= 0.002 && moved.bad > 0.080;
  console.log(`selftest: as built ${(clean.bad * 1000).toFixed(1)} mm (want <= 2)`);
  console.log(`selftest: same nozzle shoved 150 mm sideways ${(moved.bad * 1000).toFixed(1)} mm (want > 80)`);
  console.log(ok ? "selftest PASS" : "selftest FAIL — the pocket profile here no longer matches buildPump");
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
