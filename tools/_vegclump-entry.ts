/**
 * CPU-only: why are eight far scrub meshes flagged, and is it one cause?
 *
 * The scene-wide audit reported seven far scrub meshes with DEGENERATE
 * triangles and `veg-scrub-grazed-far-0` with reversed ones. Eight findings in
 * meshes that differ from their sound near-field siblings by exactly one
 * argument — `buildClump(kind, seed, far ? 0.45 : 1)` — is the distribution
 * shape that says one cause, not eight accidents.
 *
 * The audit's `degenerate` bucket conflates two predicates: a triangle with no
 * area, and a triangle whose three shading normals sum to nothing. Those are
 * different questions and only the first is a geometry defect, so this counts
 * them separately, for both LODs of every kind.
 */
import * as THREE from "three";
import { buildClump, CLUMP_KINDS } from "../src/gen/vegScrub";

type Tally = {
  mesh: string;
  tris: number;
  zeroArea: number;
  nullNormal: number;
  reversed: number;
  minArea: number;
  cards: number;
};

function tally(mesh: string, g: THREE.BufferGeometry): Tally {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const idx = g.getIndex();
  const t: Tally = { mesh, tris: 0, zeroArea: 0, nullNormal: 0, reversed: 0, minArea: Infinity, cards: 0 };
  if (!idx) return t;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const f = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    const ia = idx.getX(i);
    const ib = idx.getX(i + 1);
    const ic = idx.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    f.copy(b).sub(a).cross(tmp.copy(c).sub(a));
    const area = f.length() * 0.5;
    t.tris++;
    if (area < t.minArea) t.minArea = area;
    // The same thresholds the scene-wide probe applies, so the two agree by
    // construction rather than by my reading of them.
    if (!(f.lengthSq() > 1e-12)) {
      t.zeroArea++;
      continue;
    }
    s.set(0, 0, 0);
    s.add(tmp.fromBufferAttribute(nor, ia));
    s.add(tmp.fromBufferAttribute(nor, ib));
    s.add(tmp.fromBufferAttribute(nor, ic));
    if (!(s.length() > 1e-9)) {
      t.nullNormal++;
      continue;
    }
    if (f.dot(s) < 0) t.reversed++;
  }
  return t;
}

export function run(): void {
  console.log("scrub clump geometry, both LODs, per kind\n");
  console.log("  mesh                      tris   zeroArea  nullNormal  reversed     minArea");
  const rows: Tally[] = [];
  for (const kind of CLUMP_KINDS) {
    for (const far of [false, true]) {
      const variants = far ? 2 : 4;
      for (let v = 0; v < variants; v++) {
        const seed = 8101 + CLUMP_KINDS.indexOf(kind) * 613 + v * 97;
        const g = buildClump(kind, seed, far ? 0.45 : 1);
        const t = tally(`veg-scrub-${kind}-${far ? "far" : "near"}-${v}`, g);
        rows.push(t);
        g.dispose();
      }
    }
  }
  for (const r of rows) {
    const flag = r.zeroArea || r.nullNormal || r.reversed ? "  <<<" : "";
    console.log(
      "  " +
        r.mesh.padEnd(26) +
        String(r.tris).padStart(5) +
        String(r.zeroArea).padStart(11) +
        String(r.nullNormal).padStart(12) +
        String(r.reversed).padStart(10) +
        r.minArea.toExponential(2).padStart(12) +
        flag
    );
  }
  const far = rows.filter((r) => r.mesh.includes("-far-"));
  const near = rows.filter((r) => r.mesh.includes("-near-"));
  const sum = (a: Tally[], k: "zeroArea" | "nullNormal" | "reversed") =>
    a.reduce((n, r) => n + r[k], 0);
  console.log("");
  console.log(
    `  far  (${far.length} meshes): zeroArea ${sum(far, "zeroArea")}  nullNormal ${sum(far, "nullNormal")}  reversed ${sum(far, "reversed")}`
  );
  console.log(
    `  near (${near.length} meshes): zeroArea ${sum(near, "zeroArea")}  nullNormal ${sum(near, "nullNormal")}  reversed ${sum(near, "reversed")}`
  );
}

run();
