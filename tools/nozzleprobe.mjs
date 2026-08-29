#!/usr/bin/env node
/**
 * Does the stowed nozzle touch the boot, or is it hovering?
 *
 * "A visible air gap between the nozzle body and the boot cup... it hovers
 * forward and above the cup rather than dropping into it, with no contact shadow
 * and no point of support." That is a claim about a distance, so it can be
 * measured without a capture — and it needs to be, because the previous fix for
 * the same complaint (a side lean plus a 19 mm offset) was authored, verified as
 * present in the transform, and still read as floating. A rotation is not a
 * contact.
 *
 * Reports the closest approach between the transformed nozzle and the boot's
 * lip ring, and where on the ring it happens. A resting tool should be within a
 * few millimetres of the tube surface somewhere on the *front* of the ring, and
 * should not be intersecting it by more than a hair.
 */

import * as THREE from "three";
import { PUMP, NOZZLE, buildPump, nozzleStowed, pumpVariation } from "../src/gen/pumpParts.ts";

const LIP_R = 0.058;
const LIP_TUBE = 0.0075;
/** Non-uniform scale the boot's oval uses; see `oval()` in pumpParts. */
const OVAL = 0.72;

for (const face of [1, -1]) {
  for (const seed of [1, 2, 3]) {
    const vary = pumpVariation(seed);
    const { matrix } = nozzleStowed(face, vary);
    const build = buildPump(seed);
    const n = build.nozzles.find((x) => x.side === face);

    const bx = face * PUMP.bootX;
    const bootZ = (face * PUMP.headD) / 2 + face * 0.070;
    const lipY = PUMP.bootY + 0.036;
    const lipTilt = face * 0.10;

    // Distance from a point to the lip ring's centre-line, in the ring's own
    // frame: undo the boot's translation and its X tilt, squash Z by the oval
    // factor, then it is a plain circle in the XZ plane.
    const inv = new THREE.Matrix4()
      .makeRotationX(-(Math.PI / 2 + lipTilt))
      .multiply(new THREE.Matrix4().makeTranslation(-bx, -lipY, -bootZ));

    // Per part, not one global minimum.
    //
    // The first working version of this probe reported the nozzle "intersecting"
    // the lip by 7 mm and I nearly took that as contact. It was measuring the
    // spout passing through the ring's aperture, which it has to do — that is
    // the hole it goes in. A global closest-approach over all the nozzle's
    // geometry can only ever find that one crossing, so it answers a question
    // nobody asked while looking like a pass.
    //
    // What "resting" means is that some part of the *body* comes down onto the
    // rim, so the useful numbers are how deep the spout has dropped into the cup
    // and how much clear air is left under the body above the rim.
    const lipTop = LIP_TUBE;
    const partY = {};
    for (const [nm, geo] of [["body", n.body], ["metal", n.metal], ["rubber", n.rubber]]) {
      const pos = geo.attributes.position;
      let lo = Infinity;
      const q = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        q.fromBufferAttribute(pos, i).applyMatrix4(inv);
        // Only count material actually over the cup's mouth.
        if (Math.hypot(q.x, q.z / OVAL) < LIP_R * 1.15) lo = Math.min(lo, q.y);
      }
      partY[nm] = lo;
    }

    // The shoulder, which is the part that can actually rest on anything.
    //
    // The measurement above says the nozzle is 37-59 mm *inside* the cup and the
    // critic says it hovers above it, and both are true: the spout drops through
    // the mouth while the body is wider than the mouth, so everything that could
    // bear on the rim was excluded by the `< LIP_R * 1.15` filter. The air gap
    // being described is between the body's outer shoulder and the rim, and it is
    // invisible to any probe that only looks down the hole.
    //
    // Split front from back, because a tool that has been dropped in rests on one
    // side. Equal clearance all round is the snap-to-grid read regardless of how
    // small the number is.
    let front = Infinity;
    let back = Infinity;
    const q2 = new THREE.Vector3();
    for (const geo of [n.body, n.metal, n.rubber]) {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        q2.fromBufferAttribute(pos, i).applyMatrix4(inv);
        const rad = Math.hypot(q2.x, q2.z / OVAL);
        if (rad < LIP_R * 1.1 || rad > LIP_R * 2.4) continue;
        if (q2.z > 0) front = Math.min(front, q2.y);
        else back = Math.min(back, q2.y);
      }
    }
    const fg = front - LIP_TUBE;
    const bg = back - LIP_TUBE;

    let best = Infinity;
    let bestAt = null;
    const p = new THREE.Vector3();
    for (const geo of [n.body, n.metal, n.rubber]) {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        // `build.nozzles` geometry is already baked into pump-local space by
        // `buildPump`, so applying the stowed matrix again lifted it a full
        // metre and the probe reported a 1192 mm gap. An absurd reading is a
        // cheaper tell than a flattering one, but it is the same class of error.
        p.fromBufferAttribute(pos, i).applyMatrix4(inv);
        const rx = p.x;
        const rz = p.z / OVAL;
        const radial = Math.hypot(rx, rz) - LIP_R;
        const d = Math.hypot(radial, p.y);
        if (d < best) {
          best = d;
          bestAt = { rx, rz, y: p.y, radial };
        }
      }
    }
    const side = bestAt.rz > 0 ? "front" : "back";
    const fmt = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1).padStart(7) : "      -");
    const bodyGap = Math.min(partY.body, partY.rubber) - lipTop;
    const cant = Math.abs(fg - bg);
    console.log(
      `face ${face > 0 ? "+Z" : "-Z"} seed ${seed}:  spout ${fmt(partY.metal)} in cup   ` +
        `shoulder gap front ${fmt(fg)} back ${fmt(bg)}   cant ${fmt(cant)}   ` +
        (Math.min(fg, bg) > 0.010 ? "HOVERING" : cant < 0.008 ? "flat, reads as placed" : "canted, bearing")
    );
  }
}
console.log(`\nNozzle origin sits ${(NOZZLE.originY * 1000).toFixed(0)} mm above PUMP.bootY before the -6 mm drop.`);
