/**
 * Is each front-aperture part proud of the *rendered* fascia, or buried in it?
 *
 *   node --import ./tools/extresolve.mjs tools/carframez.mjs
 *
 * `tools/carburied.mjs` already answers a question that sounds like this one,
 * and it passes every part here. It measures against `endZ`, the **analytic**
 * section — the same function the parts are built from. Any part authored as
 * `endZ(...) + off` is proud by `off` by construction, so that test can only
 * ever return the offset it was handed. It is a check on the arithmetic, not on
 * the geometry.
 *
 * What the camera sees is the **triangulated** cap: a radial fan of ten rings
 * chording a curved section. A chord always lies inside its arc, but the fan's
 * vertices lie *on* it, and between two rings the tessellated surface can stand
 * forward of where the analytic surface is at the sample point. A part offset
 * by a few millimetres from the analytic surface is then swallowed by the
 * polygonal one, silently, with every arithmetic check still green.
 *
 * So this casts a ray at the real merged shell along -Z and compares the hit
 * against the part's own vertex. No analytic surface is consulted anywhere.
 *
 * Winding is reported alongside because it is the other way a correct part
 * draws nothing, and the two are indistinguishable from a capture.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);

body.resetProjectionStats();
const shell = body.buildCarShell();
const trim = parts.buildTrim({ debugFront: true });

const shellMesh = new THREE.Mesh(shell.body, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
shellMesh.updateMatrixWorld(true);

const ray = new THREE.Raycaster();
ray.firstHitOnly = false;

/**
 * Signed clearance of a point from the nearest piece of shell on its own line
 * of sight, metres, + meaning the point stands in front of the shell.
 *
 * Hits further than `WINDOW` from the point are discarded and reported as
 * "open": inside a cut aperture there is no fascia on that line at all, and the
 * ray then travels the whole length of the car and strikes the tail. The first
 * cut of this had no window and duly reported 4.8 m of clearance on every
 * vertex inside the grille, which is a plausible-looking number that means
 * nothing — precisely the failure mode this file exists to avoid.
 */
const WINDOW = 0.25;
function proud(x, y, z) {
  ray.set(new THREE.Vector3(x, y, z + WINDOW), new THREE.Vector3(0, 0, -1));
  const hits = ray.intersectObject(shellMesh, false);
  for (const h of hits) {
    const clear = z - h.point.z;
    if (Math.abs(clear) <= WINDOW) return clear;
  }
  return null;
}

/** Fraction of triangles whose geometric normal points toward +Z. */
function facing(geo) {
  const p = geo.getAttribute("position");
  const idx = geo.getIndex();
  const n = idx ? idx.count / 3 : p.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let fwd = 0;
  let area = 0;
  let nz = 0;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1);
    c.fromBufferAttribute(p, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    ab.cross(ac);
    const l = ab.length();
    area += l;
    nz += ab.z;
    if (l > 0 && ab.z > 0) fwd++;
  }
  // Area-weighted, so a ring whose side walls cancel does not read as ambiguous
  // when its face is decisively one way or the other.
  return { tris: n, forward: fwd, frac: n ? fwd / n : 0, nz: area ? nz / area : 0, degenerate: area === 0 };
}

console.log("part               tris  +Zfrac    nz   verts  buried    open  min mm  mean mm  max mm");
let anyBuried = false;
for (const { name, geo } of trim.debugFront) {
  const p = geo.getAttribute("position");
  const f = facing(geo);
  let buried = 0;
  let open = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < p.count; i++) {
    const clear = proud(p.getX(i), p.getY(i), p.getZ(i));
    if (clear === null) {
      open++;
      continue;
    }
    if (clear < 0) buried++;
    min = Math.min(min, clear);
    max = Math.max(max, clear);
    sum += clear;
    n++;
  }
  if (buried) anyBuried = true;
  const mm = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1).padStart(7) : "      -");
  console.log(
    `${name.padEnd(17)} ${String(f.tris).padStart(5)} ${(100 * f.frac).toFixed(0).padStart(6)}% ${f.nz.toFixed(2).padStart(5)}  ` +
      `${String(p.count).padStart(6)} ${String(buried).padStart(7)} ${String(open).padStart(7)} ${mm(min)} ${mm(n ? sum / n : NaN)} ${mm(max)}`
  );
}

console.log(`\nprojection fallbacks during build: ${JSON.stringify(body.projectionStats())}`);
// Deliberately not a pass/fail: the backing panels, slats and dividers are
// *meant* to be 28-55 mm behind the fascia and seen through the hole, so a bare
// "something is buried" verdict would fire on correct geometry every run, which
// NOTES case 25 says is worse than no check. The two numbers to read are `nz`,
// which must be near +1 for anything meant to face the camera, and `buried` on
// the surrounds and the caprail, which must be 0.
void anyBuried;
const mustFaceForward = ["grille-frame", "intake-frame", "grille-caprail", "nose-badge", "plate-rim", "plate-panel"];
const bad = trim.debugFront.filter((p) => mustFaceForward.includes(p.name) && facing(p.geo).nz < 0.5);
console.log(
  bad.length
    ? `\nBACK-FACING: ${bad.map((p) => p.name).join(", ")} — culled, will draw nothing.`
    : "\nEvery forward-facing front part is wound toward the camera."
);
