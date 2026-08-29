#!/usr/bin/env node
/**
 * pumprelief — does each pump part have sides, or is it a surface stuck on the
 * cabinet?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumprelief.mjs
 *   ... --selftest
 *
 * The test from NOTES, "An offset surface cannot read as a separate object": for
 * each part, the fraction of surface area whose face normal points more than 60
 * degrees away from the part's area-weighted mean normal. Near zero means the
 * part has no faces at a different orientation to the panel it sits on, so it
 * takes the same light, resolves to the same value, and reads as a line drawn on
 * the cabinet rather than as a feature of it. Car found 34 of 67 trim parts in
 * that state, and the split predicted its critic's "absent" list exactly.
 *
 * An independent critic called this system's seams and fastener lines "drawn
 * outlines... too uniformly dark and graphically clean". That is the same word,
 * so the structural question comes before any material change.
 *
 * **Side area is necessary and not sufficient**, and this tool reports the
 * second half too. A return only produces the highlight-and-shadow pair that
 * reads as a section if it is deep enough to resolve: Car's beltline returns
 * were authored at 3 mm, about 1.5 px on the flank, which is an invisible fix
 * for an invisible part. So the side depth is printed in millimetres and in
 * pixels at the pose that shows the part, and a part with sides too thin to
 * rasterise is flagged separately from one with no sides at all.
 */

import * as THREE from "three";
import { buildPump } from "../src/gen/pumpParts.ts";

/** Millimetres per pixel at the `panels` eye — see the note in `facePlate`. */
const MM_PER_PX = 0.763;
/** Below this, a return cannot produce two distinguishable lines. */
const MIN_PX = 1.5;

/**
 * Two reference frames, because "has sides" and "shades differently from the
 * panel" are different questions and the seams fail the second one.
 *
 * The first version of this tool used the **area-weighted mean** normal as the
 * reference, which is what the note describes, and it failed its own selftest:
 * for any closed solid the opposite faces cancel, the mean is the zero vector,
 * `normalize()` returns zero, every dot product is zero, and the tool reports
 * 100% side area and 0 mm depth for a cube. It called every section on the pump
 * "solid" while measuring nothing at all — a probe that cannot fail, on the
 * evening three others in this system were caught doing the same. The modal
 * normal — the heaviest bin of face directions — is well defined for a plane, a
 * ribbon and a box alike.
 */
const OFF_AXIS = Math.cos((60 * Math.PI) / 180);
/** A face this far off the cabinet plane shades measurably differently. */
const OFF_PANEL = Math.cos((15 * Math.PI) / 180);

/** Direction bin key, ~7 degree buckets, sign-folded. */
function binKey(n) {
  const x = Math.abs(n.x), y = Math.abs(n.y), z = Math.abs(n.z);
  return `${Math.round(x * 8)},${Math.round(y * 8)},${Math.round(z * 8)}`;
}

export function relief(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const tri = idx ? idx.count / 3 : pos.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const faces = [];
  const bins = new Map();
  let total = 0;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area = n.length() / 2;
    if (area <= 1e-12) continue;
    n.normalize();
    const f = { n: n.clone(), area };
    faces.push(f);
    total += area;
    const k = binKey(n);
    const e = bins.get(k) ?? { area: 0, n: n.clone() };
    e.area += area;
    bins.set(k, e);
  }
  if (!total) return { side: 0, offPanel: 0, depth: 0, area: 0 };

  // Modal normal: the single heaviest direction bin.
  let modal = null;
  for (const e of bins.values()) if (!modal || e.area > modal.area) modal = e;
  const m = modal.n;

  // Anti-parallel counts as the same orientation, not as a side: a back face is
  // never visible at the same time as the front and produces no second line.
  let side = 0;
  let offPanel = 0;
  for (const f of faces) {
    if (Math.abs(f.n.dot(m)) < OFF_AXIS) side += f.area;
    // The cabinet faces are axis-aligned +-X and +-Z, so anything whose normal
    // is not close to one of those shades differently from the flat panel.
    const align = Math.max(Math.abs(f.n.x), Math.abs(f.n.z));
    if (align < OFF_PANEL) offPanel += f.area;
  }

  // Extent along the modal normal is the depth any return can present.
  let lo = Infinity, hi = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const d = v.fromBufferAttribute(pos, i).dot(m);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { side: side / total, offPanel: offPanel / total, depth: hi - lo, area: total };
}

function bySection(parts) {
  const out = new Map();
  for (const p of parts) {
    const r = relief(p.geo);
    const e =
      out.get(p.label) ??
      { label: p.label, n: 0, area: 0, sideArea: 0, offArea: 0, dmin: Infinity, dmax: 0 };
    e.n++;
    e.area += r.area;
    e.sideArea += r.side * r.area;
    e.offArea += r.offPanel * r.area;
    if (r.depth < e.dmin) e.dmin = r.depth;
    if (r.depth > e.dmax) e.dmax = r.depth;
    out.set(p.label, e);
  }
  return [...out.values()].map((e) => ({
    ...e,
    side: e.area ? e.sideArea / e.area : 0,
    offPanel: e.area ? e.offArea / e.area : 0,
  }));
}

function main() {
  const build = buildPump(1);
  const rows = bySection(build.parts).sort((a, b) => a.offPanel - b.offPanel);
  console.log(`one pump, ${build.parts.length} primitives in ${rows.length} sections`);
  console.log(`side area: fraction facing >60 deg off the part's own modal normal — 0 means no sides.`);
  console.log(`off-panel: fraction facing >15 deg off the cabinet's own +-X/+-Z plane — 0 means it shades exactly as the flat face does.`);
  console.log(`thinnest: the shallowest return in the section, in mm and in px at the panels eye.
`);
  console.log("section                 parts   side   off-panel   thinnest return   verdict");
  let bad = 0;
  for (const r of rows) {
    const px = (r.dmin * 1000) / MM_PER_PX;
    // Only one of these is fatal, and the first version had the wrong one.
    //
    // It flagged every part whose own extent along its modal normal was thin —
    // which condemned the 110 plate returns, whose entire job is to *be* the
    // side. A wall does not need a wall. The question that decides whether a
    // part can read is whether it presents any area at a different orientation
    // to the panel, so `off-panel` is the fatal column and `side` is context.
    let verdict = "reads as a section";
    if (r.offPanel < 0.02) {
      verdict = "SHADES AS THE PANEL — can only be a drawn line";
      bad++;
    } else if (r.offPanel < 0.10 && px < MIN_PX) {
      verdict = `leans on a ${px.toFixed(1)} px return — too thin to resolve`;
      bad++;
    } else if (r.side < 0.02) {
      verdict = "wall or floor, no sides of its own (fine if intended)";
    }
    console.log(
      `${r.label.padEnd(22)} ${String(r.n).padStart(6)} ${(r.side * 100).toFixed(0).padStart(5)}% ` +
        `${(r.offPanel * 100).toFixed(0).padStart(9)}%   ${(r.dmin * 1000).toFixed(2).padStart(7)} mm ` +
        `${px.toFixed(1).padStart(5)} px   ${verdict}`
    );
  }
  console.log(
    bad
      ? `
${bad} section(s) cannot produce the highlight-and-shadow pair that reads as a section.`
      : `
Every section has resolvable sides that shade differently from the panel.`
  );
  process.exit(bad ? 1 : 0);
}

/**
 * The control. A plane must be caught and a box must not, or the tool is
 * measuring nothing — and a plane is exactly what a "dark line in a texture"
 * or a ribbon with no return reduces to.
 */
function selftest() {
  const plane = relief(new THREE.PlaneGeometry(0.4, 0.006));
  const thin = relief(new THREE.BoxGeometry(0.4, 0.006, 0.0004));
  const box = relief(new THREE.BoxGeometry(0.4, 0.006, 0.008));
  const show = (t, r) =>
    console.log(
      `selftest: ${t.padEnd(20)} side ${(r.side * 100).toFixed(0).padStart(3)}%  ` +
        `depth ${(r.depth * 1000).toFixed(2).padStart(5)} mm  ${((r.depth * 1000) / MM_PER_PX).toFixed(1)} px`
    );
  show("flat plane", plane);
  show("0.4 mm deep box", thin);
  show("8 mm deep box", box);
  const okPlane = plane.side < 0.02 && plane.depth < 1e-6;
  const okThin = thin.side > 0.02 && (thin.depth * 1000) / MM_PER_PX < MIN_PX;
  const okBox = box.side > 0.02 && (box.depth * 1000) / MM_PER_PX > MIN_PX;
  console.log(`  want: plane no sides | 0.4 mm has sides but unresolvable | 8 mm has sides and resolves`);
  const ok = okPlane && okThin && okBox;
  console.log(ok ? "selftest PASS" : "selftest FAIL");
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
