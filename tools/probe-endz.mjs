/**
 * Read-only probe (no source files modified).
 *
 * `endZ`'s failure and rim-clamp branches both return exactly `cap.zEnd`, the
 * flat plane. That constant is recoverable from outside the module by sampling
 * a point far outside the outline, so the flat-plane hit rate can be measured
 * without exporting the cap.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-endz.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const { buildCarShell, endZ } = body;

buildCarShell();

const FLAT = { true: endZ(40, 40, true), false: endZ(40, 40, false) };
console.log(`flat-plane constant: nose zEnd = ${FLAT.true.toFixed(5)}   tail zEnd = ${FLAT.false.toFixed(5)}\n`);

const outlineK = (v) => Math.max(0.06, Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * v - 1), 5)), 0.2));

function endGrid(name, xc, halfW, yc, halfH, front, nx, ny) {
  const rows = [];
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const k = outlineK(v);
    const y = yc - halfH + v * halfH * 2;
    const row = [];
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const x = xc + (u - 0.5) * 2 * halfW * k;
      const z = endZ(x, y, front);
      row.push({ x, y, z, flat: Math.abs(z - FLAT[String(front)]) < 1e-9 });
    }
    rows.push(row);
  }
  const flat = rows.flat();
  const nf = flat.filter((s) => s.flat).length;
  // Worst step between grid neighbours, both directions.
  let worst = 0;
  let at = null;
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      for (const [dj, di] of [[0, 1], [1, 0]]) {
        const o = rows[j + dj]?.[i + di];
        if (!o) continue;
        const d = Math.abs(o.z - rows[j][i].z) * 1000;
        if (d > worst) {
          worst = d;
          at = rows[j][i];
        }
      }
    }
  }
  console.log(
    `  ${name.padEnd(26)} n=${String(flat.length).padStart(4)}  on flat plane ${((nf / flat.length) * 100)
      .toFixed(1)
      .padStart(5)}%  worst neighbour step ${worst.toFixed(2).padStart(7)} mm` +
      (at ? `  at x=${at.x.toFixed(3)} y=${at.y.toFixed(3)}` : "")
  );
  return { nf, n: flat.length, worst };
}

console.log("=== endZ over the real shipping footprints (carParts.ts) ===\n");
// Headlamp, carParts.ts:519-531.
endGrid("headlamp housing outer", 0.515, 0.200, 0.828, 0.083, true, 16, 6);
endGrid("headlamp housing", 0.515, 0.185, 0.828, 0.068, true, 14, 8);
endGrid("headlamp reflector", 0.515, 0.1776, 0.828, 0.06256, true, 14, 8);
endGrid("headlamp lens", 0.515, 0.185, 0.828, 0.068, true, 14, 8);
endGrid("amber repeater", 0.515 + 0.118, 0.044, 0.822, 0.046, true, 8, 6);
// Tail lamp, carParts.ts:592-622.
endGrid("tail housing outer", 0.47, 0.216, 0.885, 0.091, false, 16, 8);
endGrid("tail housing back", 0.47, 0.2, 0.885, 0.075, false, 16, 8);
for (const ch of [
  { c: 0.12, w: 0.068 },
  { c: -0.004, w: 0.042 },
  { c: -0.126, w: 0.058 },
]) {
  endGrid(`tail chamber c=${ch.c}`, 0.47 + ch.c, ch.w, 0.885, 0.062, false, 10, 6);
}
// Grille / intake / plate, carParts.ts:673-727.
endGrid("upper grille", 0, 0.360, 0.818, 0.090, true, 18, 6);
endGrid("lower intake", 0, 0.522, 0.556, 0.092, true, 22, 6);
endGrid("front plate recess", 0, 0.152, 0.672, 0.058, true, 12, 4);
endGrid("rear valance", 0, 0.62, 0.455, 0.075, false, 24, 4);
endGrid("rear chrome bar", 0, 0.430, 0.845, 0.011, false, 20, 2);
endGrid("rear plate recess", 0, 0.152, 0.66, 0.058, false, 12, 4);
endGrid("reversing lamp", 0, 0.046, 0.9, 0.028, false, 12, 6);

console.log("\n=== endZ: where is the usable envelope edge on each cap? ===\n");
for (const front of [true, false]) {
  const lbl = front ? "nose" : "tail";
  for (const y of [0.45, 0.55, 0.65, 0.75, 0.85, 0.9, 0.95, 1.0, 1.05]) {
    let usable = 0;
    for (let x = 0; x < 1.2; x += 0.005) {
      if (Math.abs(endZ(x, y, front) - FLAT[String(front)]) < 1e-9) break;
      usable = x;
    }
    console.log(`  ${lbl} y=${y.toFixed(2)}  usable to |x| = ${usable.toFixed(3)} m`);
  }
  console.log("");
}
