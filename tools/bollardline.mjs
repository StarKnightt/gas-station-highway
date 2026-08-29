#!/usr/bin/env node
/**
 * Is the bollard a straight post that has been hit, or a bent one?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/bollardline.mjs
 *   ... --selftest
 *
 * The critic has read this post as a "banana" across several rounds and the
 * silhouette work kept addressing the dents instead, because there was no
 * number separating the two failures. They are different: a *bow* is the whole
 * section wandering off the axis, and a *dent* is a local bite out of one side.
 * A struck bollard has the second and not the first, and the eye tells them
 * apart instantly, so the tool has to as well.
 *
 * The measurement is the outer envelope. Impacts are clustered on the
 * traffic-facing arc, so at every height there is undamaged pipe on the far
 * side, and the largest radius in a height band should be the nominal radius at
 * every band. If that number wanders, the post is bowed. The deepest inward
 * pull is reported beside it as the dent depth, which should be present and in
 * the 5-25 mm range real bollard damage occupies.
 *
 * **Undo the lean.** `buildBollard` bakes 1.2-2.6 degrees of out-of-plumb into
 * the mesh and returns it precisely so a probe can remove it. Measuring
 * `hypot(x, z)` on the leaned mesh reads the tilt as an outline defect: at the
 * cap a 0.045 rad lean displaces the far side by 41 mm, and the first version of
 * this tool duly reported a 16-33 mm envelope wander on posts whose true wander
 * is under 0.2 mm. That is the same wrong-axis error the boot containment probe
 * made the same evening; see NOTES.md, "A well-formed question about the wrong
 * axis". The lean is undone here from the returned value, never estimated.
 */

import * as THREE from "three";
import { buildBollard, BOLLARD_R, BOLLARD_H, BOLLARD_IMPACT_U } from "../src/gen/pumpParts.ts";

const BANDS = 12;

/** Envelope wander and deepest dent, in metres, for one built post. */
export function profile(b) {
  const pos = b.skin.attributes.position;
  const un = new THREE.Matrix4()
    .makeRotationZ(-b.lean.z)
    .multiply(new THREE.Matrix4().makeRotationX(-b.lean.x));
  const bands = Array.from({ length: BANDS }, () => ({ min: Infinity, max: 0 }));
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(un);
    // Skip the grout collar and the domed cap: neither is nominal radius.
    if (v.y < 0.02 || v.y > BOLLARD_H - 0.10) continue;
    const k = Math.min(BANDS - 1, Math.floor((v.y / BOLLARD_H) * BANDS));
    const r = Math.hypot(v.x, v.z);
    if (r < bands[k].min) bands[k].min = r;
    if (r > bands[k].max) bands[k].max = r;
  }
  const live = bands.filter((x) => x.max > 0);
  const maxes = live.map((x) => x.max);
  return {
    bow: Math.max(...maxes) - Math.min(...maxes),
    dent: BOLLARD_R - Math.min(...live.map((x) => x.min)),
    tris: (b.skin.index ? b.skin.index.count : pos.count) / 3,
  };
}

function build(bi) {
  return buildBollard(
    BOLLARD_H + (bi % 3) * 0.02,
    3 + bi,
    BOLLARD_IMPACT_U[bi % BOLLARD_IMPACT_U.length]
  );
}

function main() {
  let bad = 0;
  let tris = 0;
  for (let bi = 0; bi < 6; bi++) {
    const p = profile(build(bi));
    tris += p.tris;
    const bow = p.bow * 1000;
    const dent = p.dent * 1000;
    const verdict = bow > 2 ? "  BOWED" : dent < 5 ? "  UNDAMAGED" : dent > 25 ? "  CRUSHED" : "";
    if (verdict) bad++;
    console.log(
      `bollard ${bi + 1}: envelope wanders ${bow.toFixed(1).padStart(5)} mm (want < 2), ` +
        `deepest dent ${dent.toFixed(1).padStart(5)} mm (want 5-25)${verdict}`
    );
  }
  console.log(`\nbollard skin: ${tris / 6} triangles each, ${tris} for six.`);
  console.log(
    bad ? `\n${bad} of 6 posts fail.` : `\nAll six: straight pipe with local damage.`
  );
  process.exit(bad ? 1 : 0);
}

/**
 * Two controls. The first is the one that matters: a post bent into a real bow
 * must be caught, because the tool's whole purpose is to separate a bow from a
 * dent and it would be useless if it called everything straight. The second
 * checks that the lean is actually being undone — the failure this tool
 * shipped with.
 */
function selftest() {
  const clean = profile(build(0));

  const bent = build(0);
  const pos = bent.skin.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // A 20 mm bow: displace by a half-sine in height, which is a bend and not
    // a lean, so undoing the lean cannot remove it.
    pos.setX(i, v.x + Math.sin((v.y / BOLLARD_H) * Math.PI) * 0.020);
  }
  const bowed = profile(bent);

  const leaned = build(0);
  const asIf = { skin: leaned.skin, lean: { x: 0, z: 0 } }; // pretend there is no lean
  const unled = profile(asIf);

  const ok = clean.bow < 0.002 && bowed.bow > 0.010 && unled.bow > 0.010;
  console.log(`selftest: as built                     ${(clean.bow * 1000).toFixed(1)} mm bow (want < 2)`);
  console.log(`selftest: same post bent 20 mm         ${(bowed.bow * 1000).toFixed(1)} mm bow (want > 10)`);
  console.log(`selftest: lean deliberately not undone ${(unled.bow * 1000).toFixed(1)} mm bow (want > 10)`);
  console.log(
    ok
      ? "selftest PASS"
      : "selftest FAIL — a bow this tool cannot see, or a lean it is silently absorbing"
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
