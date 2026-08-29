/**
 * Measures the baked weathering masks without rendering anything.
 *
 * The masks are the part that is expensive to get wrong: an intensity is one
 * number to change on the GPU, but a fan pointing the wrong way down the car is
 * a re-author. So check here that the film lands where road film lands - low,
 * outboard, and trailing behind each arch - and that the roof and bonnet get
 * dust rather than film.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/carweather.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const grime = await import(pathToFileURL(path.join(ROOT, "src/gen/carGrime.ts")).href);

const shell = body.buildCarShell();
grime.bakeCarWeather(shell.body);

const pos = shell.body.getAttribute("position");
const w = shell.body.getAttribute("aWeather");

/** Mean of both channels over vertices matching a predicate. */
function probe(pred) {
  let d = 0;
  let f = 0;
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (!pred(x, y, z)) continue;
    d += w.getX(i);
    f += w.getY(i);
    n++;
  }
  return n ? { d: d / n, f: f / n, n } : { d: 0, f: 0, n: 0 };
}

const outer = (x, y) => Math.abs(x) > 0.6 && y > 0.3;
const PLACES = [
  ["roof", (x, y, z) => y > 1.38 && Math.abs(z) < 0.9],
  ["bonnet", (x, y, z) => y > 1.02 && y < 1.2 && z > 1.35],
  ["boot lid", (x, y, z) => y > 1.0 && y < 1.16 && z < -1.5],
  ["upper door", (x, y, z) => outer(x, y) && y > 1.0 && y < 1.24 && Math.abs(z) < 1.0],
  ["lower door", (x, y, z) => outer(x, y) && y > 0.42 && y < 0.62 && Math.abs(z) < 1.0],
  ["rocker / sill", (x, y, z) => outer(x, y) && y < 0.42 && Math.abs(z) < 1.2],
  ["behind front arch", (x, y, z) => outer(x, y) && y < 0.7 && z > 0.55 && z < 1.0],
  ["ahead of front arch", (x, y, z) => outer(x, y) && y < 0.7 && z > 1.78 && z < 2.05],
  ["behind rear arch", (x, y, z) => outer(x, y) && y < 0.7 && z > -2.1 && z < -1.6],
  ["rear bumper corner", (x, y, z) => Math.abs(x) > 0.55 && y < 0.8 && z < -2.15],
  ["front bumper corner", (x, y, z) => Math.abs(x) > 0.55 && y < 0.8 && z > 2.15],
  ["mid flank at belt", (x, y, z) => outer(x, y) && y > 1.05 && y < 1.2 && Math.abs(z) < 0.5],
];

console.log("Baked weathering, mean per region. dust settles on up-facing panels,");
console.log("film is road spray: sills, arch fans and bumper corners.\n");
console.log("  region                     verts    dust     film");
for (const [name, pred] of PLACES) {
  const r = probe(pred);
  console.log(`  ${name.padEnd(22)} ${String(r.n).padStart(7)}   ${r.d.toFixed(3)}    ${r.f.toFixed(3)}`);
}

// Distribution, to catch the failure mode that actually happened last time:
// a mask so broad that most of the car is dirty.
let hi = 0;
let mid = 0;
for (let i = 0; i < w.count; i++) {
  const f = w.getY(i);
  if (f > 0.5) hi++;
  else if (f > 0.2) mid++;
}
console.log(
  `\n  film coverage: ${((100 * hi) / w.count).toFixed(1)}% heavy (>0.5), ` +
    `${((100 * mid) / w.count).toFixed(1)}% light (0.2-0.5), ` +
    `${((100 * (w.count - hi - mid)) / w.count).toFixed(1)}% clean`
);

// Fan direction check: film must fall off going forward from an axle, not back.
const fanAt = (z) => probe((x, y, zz) => outer(x, y) && y < 0.66 && Math.abs(zz - z) < 0.09).f;
console.log("\n  spray fan profile behind the REAR axle (z = -1.40), film by station:");
let line = "   ";
for (let z = -1.3; z >= -2.15; z -= 0.15) line += `z=${z.toFixed(2)}:${fanAt(z).toFixed(2)}  `;
console.log(line);
console.log("  and AHEAD of the rear axle, which should be cleaner:");
line = "   ";
for (let z = -1.25; z <= -0.4; z += 0.15) line += `z=${z.toFixed(2)}:${fanAt(z).toFixed(2)}  `;
console.log(line);
