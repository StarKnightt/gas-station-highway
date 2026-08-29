/**
 * CPU-only: audit `sweepTube` output in isolation, by path direction.
 *
 * The scene-wide audit found props 80% reversed and pine wood 0% reversed from
 * the same builder, which means one of the two is being transformed. Auditing
 * the builder with no transform at all says which.
 */
import * as THREE from "three";
import { sweepTube } from "../src/gen/vegPine";

export function auditGeometry(g: THREE.BufferGeometry): { reversed: number; total: number } {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const idx = g.getIndex();
  if (!idx) return { reversed: 0, total: 0 };
  let reversed = 0;
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const f = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const i0 = idx.getX(t);
    const i1 = idx.getX(t + 1);
    const i2 = idx.getX(t + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    f.crossVectors(b.sub(a), c.sub(a));
    if (f.length() < 1e-12) continue;
    f.normalize();
    s.set(0, 0, 0);
    for (const i of [i0, i1, i2]) {
      s.x += nor.getX(i);
      s.y += nor.getY(i);
      s.z += nor.getZ(i);
    }
    if (s.length() < 1e-9) continue;
    s.normalize();
    total++;
    if (f.dot(s) < 0) reversed++;
  }
  return { reversed, total };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function cases(): { label: string; reversed: number; total: number }[] {
  const mk = (pts: THREE.Vector3[]) => sweepTube(pts, [0.1, 0.09, 0.08], 6, 0.5, () => 0, true);
  const set: [string, THREE.Vector3[]][] = [
    ["vertical, upward (post / trunk)", [V(0, 0, 0), V(0, 1, 0), V(0, 2, 0)]],
    ["vertical, downward", [V(0, 2, 0), V(0, 1, 0), V(0, 0, 0)]],
    ["horizontal +X (crossarm / branch)", [V(0, 1, 0), V(1, 1, 0), V(2, 1, 0)]],
    ["horizontal -X", [V(2, 1, 0), V(1, 1, 0), V(0, 1, 0)]],
    ["diagonal up-out (pine branch)", [V(0, 1, 0), V(0.7, 1.4, 0.3), V(1.4, 1.7, 0.7)]],
    ["diagonal down (fence brace)", [V(0, 2, 0), V(0.4, 1.5, 0.2), V(0.8, 1.0, 0.4)]],
  ];
  return set.map(([label, pts]) => ({ label, ...auditGeometry(mk(pts)) }));
}

/**
 * Paths that **cross** the reference-axis switch inside a single sweep.
 *
 * `sweepTube` picks its frame reference per station:
 * `Math.abs(tangent.y) > 0.94 ? X : UP`. That is a discontinuous choice, so a
 * path which passes through near-vertical mid-sweep gets one frame before the
 * crossing and a different, abruptly rotated frame after it. The straight-path
 * cases above cannot see this, because every station on a straight path picks
 * the same reference.
 *
 * Written because the scene-wide audit found six pump hoses and one vegetation
 * ground mat all sitting at 0.3-0.4% reversed — a handful of triangles out of
 * thousands, in the same place in every instance. A builder-wide contract error
 * gives 80%; a localised handful says "something specific about a few stations",
 * and a curved path crossing a hard threshold is the obvious candidate. A hose
 * is precisely the geometry that hangs through vertical.
 */
export function crossingCases(): { label: string; reversed: number; total: number }[] {
  const radii = (n: number) => new Array(n).fill(0.04);
  const mk = (pts: THREE.Vector3[]) => sweepTube(pts, radii(pts.length), 6, 0.5, () => 0, true);
  // An arc from horizontal, up through vertical, and back down: a hose hanging
  // off a nozzle boot, or a mat blade curling over.
  const arc = (turns: number, n: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * turns * Math.PI;
      pts.push(V(Math.sin(t) * 0.5, 0.5 - Math.cos(t) * 0.5, 0));
    }
    return pts;
  };
  const set: [string, THREE.Vector3[]][] = [
    ["arc through vertical, 8 stations", arc(1, 8)],
    ["arc through vertical, 24 stations", arc(1, 24)],
    ["full loop, crosses twice", arc(2, 24)],
    ["shallow S, never near vertical", [V(0, 1, 0), V(0.5, 1.1, 0.1), V(1, 1.0, 0.3), V(1.5, 1.1, 0.5)]],
    ["hose: down off a boot then out", [V(0, 1.2, 0), V(0.02, 0.8, 0.05), V(0.05, 0.45, 0.2), V(0.3, 0.3, 0.5), V(0.8, 0.28, 0.7)]],
  ];
  return set.map(([label, pts]) => ({ label, ...auditGeometry(mk(pts)) }));
}
