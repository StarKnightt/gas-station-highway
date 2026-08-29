#!/usr/bin/env node
/**
 * pumpsoil — what range of `groundAccum` does the pump island actually sample?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpsoil.mjs
 *
 * Building's finding, which is a contract problem rather than a bug: **the range
 * of a published field is part of its contract, and nothing at a call site
 * reveals it.** It multiplied `fines(x,z)` in as a bare factor and its wall came
 * out cleaner, because `fines` reads 0.013 to 0.21 across the site — the field
 * correctly reporting that a forecourt is swept. Bare-multiplied, a correct
 * field becomes a 3% tint and the author concludes the mechanism is too weak.
 *
 * The island is the most swept ground on the site, so this system meets it
 * hardest. This prints, for the ground the three cabinets actually stand on and
 * for the site as a whole, the range and the mean of every field, so a
 * composition can be a floor plus a gain normalised to the range that is
 * *reachable here* rather than to 0..1.
 *
 * Pure CPU. No renderer, no server, nothing to tear down.
 */

import { makeAccumField } from "../src/gen/groundAccum.ts";
import { makeSoilField } from "../src/gen/groundSoil.ts";
import { ISLANDS } from "../src/site.ts";

const accum = makeAccumField(makeSoilField());

/** Every point on a cabinet's four faces that a weep could be asked about. */
function cabinetSamples() {
  const out = [];
  for (const isl of ISLANDS) {
    for (const dx of [-1.9, 0, 1.9]) {
      const cx = isl.cx + dx;
      const cz = isl.cz;
      for (let a = 0; a < 16; a++) {
        const th = (a / 16) * Math.PI * 2;
        // 0.55 m out is the cabinet skin; sample right at it.
        out.push({ x: cx + Math.cos(th) * 0.55, z: cz + Math.sin(th) * 0.55, cx, cz });
      }
    }
  }
  return out;
}

function stats(name, values) {
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
  }
  const mean = sum / values.length;
  return { name, lo, hi, mean, span: hi - lo };
}

function show(rows, title) {
  console.log(`\n${title}`);
  console.log("field         min      max     mean     span   bare-multiply verdict");
  for (const r of rows) {
    // The number that matters: multiplied in raw, this is the strongest effect
    // the field can have. Under about 0.25 it cannot carry a visible change on
    // its own and has to be composed as floor + normalised gain.
    const verdict =
      r.hi < 0.08
        ? "INERT as a bare factor — floor+gain required"
        : r.hi < 0.3
          ? "weak as a bare factor — normalise to span"
          : "usable directly";
    console.log(
      `${r.name.padEnd(11)} ${r.lo.toFixed(4).padStart(7)} ${r.hi.toFixed(4).padStart(8)} ` +
        `${r.mean.toFixed(4).padStart(8)} ${r.span.toFixed(4).padStart(8)}   ${verdict}`
    );
  }
}

const cab = cabinetSamples();
show(
  [
    stats("fines", cab.map((p) => accum.fines(p.x, p.z))),
    stats("grime", cab.map((p) => accum.grime(p.x, p.z))),
    stats("swept", cab.map((p) => accum.swept(p.x, p.z))),
    stats("shelter", cab.map((p) => accum.shelter(p.x, p.z))),
    stats("lee", cab.map((p) => accum.lee(p.x, p.z, p.cx, p.cz, 0.6))),
  ],
  `at the cabinet skins, ${cab.length} samples across ${ISLANDS.length} island(s)`
);

// The wall profile, which is a function of height rather than of place.
const heights = [0.02, 0.1, 0.2, 0.35, 0.5, 0.8, 1.2, 1.8];
console.log(`\nwallBase profile up a +Z face (distOut 0)`);
console.log("up (m)   splash    drift");
for (const up of heights) {
  const w = accum.wallBase(0, up, 0, 1);
  console.log(`${up.toFixed(2).padStart(6)}  ${w.splash.toFixed(4).padStart(7)}  ${w.drift.toFixed(4).padStart(7)}`);
}

// Site-wide, for comparison: if the island's range is a small slice of the
// site's, that is the field telling this system something true.
const site = [];
for (let x = -60; x <= 60; x += 3) for (let z = -60; z <= 60; z += 3) site.push({ x, z });
show(
  [
    stats("fines", site.map((p) => accum.fines(p.x, p.z))),
    stats("grime", site.map((p) => accum.grime(p.x, p.z))),
    stats("swept", site.map((p) => accum.swept(p.x, p.z))),
  ],
  `across the whole site, ${site.length} samples, for comparison`
);
