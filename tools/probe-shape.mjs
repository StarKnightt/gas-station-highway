/**
 * Read-only probe (no source files modified).
 *
 * Two questions the fallback-rate numbers cannot answer:
 *   1. Are endZ's residual 11-17 mm neighbour steps smooth curvature or a
 *      sawtooth? A sawtooth alternates sign; curvature does not.
 *   2. How much headroom does flankX have before its own silent fallback
 *      (`best >= 0 ? best : hipX(z)`) starts firing on shipping parts?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-shape.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const { buildCarShell, endZ, flankX, section, ARCH_BASE_Y, ARCH_RY, ARCH_RZ, AXLES } = body;
buildCarShell();

const outlineK = (v) => Math.max(0.06, Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * v - 1), 5)), 0.2));

console.log("=== 1. endZ: sign changes along each row (sawtooth detector) ===\n");
console.log("   a monotone or single-humped row has <= 1 sign change; the old bug gave many\n");
function rowShape(name, xc, halfW, yc, halfH, front, nx, ny) {
  let worstFlips = 0;
  let worstRow = null;
  let maxSecond = 0;
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const k = outlineK(v);
    const y = yc - halfH + v * halfH * 2;
    const zs = [];
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      zs.push(endZ(xc + (u - 0.5) * 2 * halfW * k, y, front));
    }
    let flips = 0;
    let prevSign = 0;
    for (let i = 0; i + 1 < zs.length; i++) {
      const d = zs[i + 1] - zs[i];
      if (Math.abs(d) < 1e-9) continue;
      const s = Math.sign(d);
      if (prevSign !== 0 && s !== prevSign) flips++;
      prevSign = s;
    }
    for (let i = 1; i + 1 < zs.length; i++) {
      maxSecond = Math.max(maxSecond, Math.abs(zs[i + 1] - 2 * zs[i] + zs[i - 1]) * 1000);
    }
    if (flips > worstFlips) {
      worstFlips = flips;
      worstRow = y;
    }
  }
  console.log(
    `  ${name.padEnd(24)} worst sign changes in a row: ${String(worstFlips).padStart(2)}` +
      `   max |2nd difference| ${maxSecond.toFixed(2).padStart(6)} mm` +
      (worstRow !== null ? `   (row y=${worstRow.toFixed(3)})` : "")
  );
}
rowShape("headlamp lens", 0.515, 0.185, 0.828, 0.068, true, 14, 8);
rowShape("tail housing outer", 0.47, 0.216, 0.885, 0.091, false, 16, 8);
rowShape("tail housing back", 0.47, 0.2, 0.885, 0.075, false, 16, 8);
rowShape("upper grille", 0, 0.360, 0.818, 0.090, true, 18, 6);
rowShape("lower intake", 0, 0.522, 0.556, 0.092, true, 22, 6);
rowShape("rear valance", 0, 0.62, 0.455, 0.075, false, 24, 4);

console.log("\n=== 2. flankX: the fallback cliff, per station ===\n");
console.log("   yLo/yHi are where flankX stops finding a crossing and returns hipX(z).\n");
function cliff(z) {
  const pts = section(z).pts;
  const ys = pts.map((p) => p.y);
  return { lo: Math.min(...ys), hi: Math.max(...ys) };
}
const SILL_Y = 0.206;
const BELT_Y = 1.080;
console.log("   z        yLo     yHi    sill 0.206 margin   belt 1.080 margin   jump if it fell back");
for (let z = -2.1; z <= 2.11; z += 0.3) {
  const c = cliff(z);
  const real = flankX(z, SILL_Y);
  // What the fallback would return at this station.
  const fb = flankX(z, c.lo - 0.05);
  console.log(
    `  ${z.toFixed(2).padStart(5)}   ${c.lo.toFixed(3)}  ${c.hi.toFixed(3)}` +
      `      ${((SILL_Y - c.lo) * 1000).toFixed(0).padStart(6)} mm` +
      `        ${((c.hi - BELT_Y) * 1000).toFixed(0).padStart(6)} mm` +
      `        ${((fb - real) * 1000).toFixed(0).padStart(6)} mm`
  );
}

console.log("\n=== 3. flankX: does keeping the LARGEST crossing ever disagree? ===\n");
{
  let multi = 0;
  let n = 0;
  let worst = 0;
  let at = null;
  for (let zi = 0; zi <= 400; zi++) {
    const z = -2.15 + (zi / 400) * 4.3;
    const pts = section(z).pts;
    const ys = pts.map((p) => p.y);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    for (let yi = 0; yi <= 300; yi++) {
      const y = lo + ((hi - lo) * yi) / 300;
      const hits = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if ((y >= a.y && y <= b.y) || (y <= a.y && y >= b.y)) {
          const t = Math.abs(b.y - a.y) < 1e-9 ? 0 : (y - a.y) / (b.y - a.y);
          hits.push(a.x + (b.x - a.x) * t);
        }
      }
      if (!hits.length) continue;
      n++;
      if (hits.length > 1) multi++;
      const spread = Math.max(...hits) - Math.min(...hits);
      if (spread > worst) {
        worst = spread;
        at = { z, y, hits: hits.length };
      }
    }
  }
  console.log(`  samples inside the section y-range: ${n}`);
  console.log(`  with more than one crossing:        ${multi} (${((multi / n) * 100).toFixed(2)}%)`);
  console.log(`  worst largest-vs-nearest disagreement: ${(worst * 1000).toFixed(1)} mm`);
  if (at) console.log(`    at z=${at.z.toFixed(3)} y=${at.y.toFixed(3)} crossings=${at.hits}`);
}

console.log("\n=== 4. flankX: fallback rate if the flank were reshaped down by N mm ===\n");
console.log("   (the sill/arch parts are authored at fixed Y; the section is not)\n");
for (const drop of [0, 10, 20, 30, 40, 60, 80]) {
  let fb = 0;
  let n = 0;
  for (let i = 0; i <= 64; i++) {
    const z = -1.42 + (i / 64) * 2.84;
    const c = cliff(z);
    for (const y of [0.206 - drop / 1000, 0.290 - drop / 1000]) {
      n++;
      if (y < c.lo || y > c.hi) fb++;
    }
  }
  let afb = 0;
  let an = 0;
  for (const cz of AXLES) {
    for (let i = 0; i <= 76; i++) {
      const th = -0.23 + (i / 76) * (Math.PI + 0.46);
      const z = cz + Math.cos(th) * ARCH_RZ;
      const c = cliff(z);
      for (const ry of [0.955, 1.002, 1.075]) {
        const y = ARCH_BASE_Y + Math.sin(th) * ARCH_RY * ry - drop / 1000;
        an++;
        if (y < c.lo || y > c.hi) afb++;
      }
    }
  }
  console.log(
    `  parts lowered ${String(drop).padStart(2)} mm:  sill fallback ${((fb / n) * 100).toFixed(1).padStart(5)}%   ` +
      `arch-lip fallback ${((afb / an) * 100).toFixed(1).padStart(5)}%`
  );
}
