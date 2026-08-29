#!/usr/bin/env node
/**
 * Where does `buildClump` put a NaN in its vertex colours?
 *
 * The environment-culprit bisect narrowed the poisoned PMREM cube down to one
 * mesh, then to one material feature (`vertexColors`), then to the geometry's
 * own `color` attribute: 48 of 198 floats non-finite, with position, normal, uv,
 * instanceMatrix and instanceColor all clean. That attribute is built entirely
 * on the CPU, so the rest of the hunt needs no GPU, no browser and no capture —
 * which also means it can be re-run in a second as a regression check.
 *
 *   node tools/clumpcolor.mjs
 *
 * Exits non-zero if any clump the scatter can actually ask for has a non-finite
 * vertex colour.
 */
import { build } from "vite";

await build({ configFile: "tools/lightcpu.vite.config.mjs" });
const { buildClump, CLUMP_KINDS: kinds } = await import("../.shot-build/lightcpu/clumpcolor.mjs");

let failures = 0;
let checked = 0;

for (const kind of kinds) {
  for (let v = 0; v < 4; v++) {
    // The two seeds and two LODs VegetationSystem actually builds.
    for (const lod of [1, 0.45]) {
      const g = buildClump(kind, 8101 + kinds.indexOf(kind) * 613 + v * 97, lod);
      checked++;
      const col = g.getAttribute("color");
      const pos = g.getAttribute("position");
      const bad = [];
      for (let i = 0; i < col.count; i++) {
        const c = [col.getX(i), col.getY(i), col.getZ(i)];
        if (c.some((x) => !Number.isFinite(x))) bad.push({ i, c, y: pos.getY(i) });
      }
      if (bad.length) {
        failures++;
        console.log(`FAIL ${kind} v${v} lod${lod}: ${bad.length}/${col.count} vertices non-finite`);
        for (const b of bad.slice(0, 8)) {
          console.log(`       vert ${b.i}  y=${b.y.toFixed(5)}  rgb=${b.c.map(String).join(", ")}`);
        }
      }
    }
  }
}

console.log(`\n${checked} clumps checked, ${failures} with non-finite vertex colour`);
process.exit(failures ? 1 : 0);
