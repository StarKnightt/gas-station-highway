import * as THREE from "three";

/**
 * Geometry helpers for the store building (System 2).
 *
 * The important one is `buildingBox`. Stock `BoxGeometry` gives every face a
 * 0..1 UV, which stretches a 16 in block to whatever the face happens to be.
 * These boxes derive UVs from position instead, so a wall, a pier and a
 * parapet return cleanly coursed masonry that lines up across corners without
 * anyone hand-placing a UV.
 */

export interface BuildingBoxOptions {
  /** World metres per texture tile, horizontally and vertically. */
  uvMetres?: THREE.Vector2;
  /**
   * Added to the local position before the UV divide. Pass the mesh's world
   * position and every separate wall piece shares one continuous coursing.
   */
  uvOrigin?: THREE.Vector3;
  /** Drop faces that are never seen; `-y` on a plinth, `+z` on a buried pier. */
  skip?: Array<"+x" | "-x" | "+y" | "-y" | "+z" | "-z">;
  /** Uniform vertex colour, for merging with parts that carry baked contact AO. */
  color?: number;
  /**
   * Baked contact occlusion as a function of local Y (in the box's own frame,
   * -sy/2 .. +sy/2). Without a dark line where a pier meets the pavement the
   * building reads as pasted onto the lot.
   */
  ao?: (localY: number) => number;
}

type Axis = 0 | 1 | 2;
interface FaceDef {
  key: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  n: [number, number, number];
  /** Which local axes map to U and V on this face. */
  u: Axis;
  v: Axis;
  /** Sign applied to the U axis so the winding stays counter-clockwise. */
  us: number;
}

const FACES: FaceDef[] = [
  { key: "+x", n: [1, 0, 0], u: 2, v: 1, us: -1 },
  { key: "-x", n: [-1, 0, 0], u: 2, v: 1, us: 1 },
  { key: "+y", n: [0, 1, 0], u: 0, v: 2, us: -1 },
  { key: "-y", n: [0, -1, 0], u: 0, v: 2, us: 1 },
  { key: "+z", n: [0, 0, 1], u: 0, v: 1, us: 1 },
  { key: "-z", n: [0, 0, -1], u: 0, v: 1, us: -1 },
];

/**
 * An axis-aligned box centred on the origin with world-metre UVs.
 *
 * Winding is emitted explicitly and verified against the face normal rather
 * than copied from a template: reversed indices are one of the documented ways
 * geometry has silently vanished in this project.
 */
export function buildingBox(sx: number, sy: number, sz: number, opts: BuildingBoxOptions = {}): THREE.BufferGeometry {
  const { uvMetres = new THREE.Vector2(1, 1), uvOrigin = new THREE.Vector3(), skip = [], color, ao } = opts;
  const half = [sx / 2, sy / 2, sz / 2];
  const org = [uvOrigin.x, uvOrigin.y, uvOrigin.z];

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  for (const f of FACES) {
    if (skip.includes(f.key)) continue;
    const axis = (f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2) as Axis;
    const sign = f.n[axis];
    const base = pos.length / 3;

    for (let vi = 0; vi < 2; vi++) {
      for (let ui = 0; ui < 2; ui++) {
        const p: [number, number, number] = [0, 0, 0];
        p[axis] = sign * half[axis];
        const uLocal = (ui * 2 - 1) * half[f.u] * f.us;
        const vLocal = (vi * 2 - 1) * half[f.v];
        p[f.u] = uLocal;
        p[f.v] = vLocal;
        pos.push(p[0], p[1], p[2]);
        nor.push(f.n[0], f.n[1], f.n[2]);
        // UV in world metres. Top/bottom faces use XZ, the rest use the
        // horizontal axis and Y, which is what keeps coursing level.
        uv.push((p[f.u] * f.us + org[f.u]) / uvMetres.x, (p[f.v] + org[f.v]) / uvMetres.y);
        if (color !== undefined || ao) {
          const k = ao ? ao(p[1]) : 1;
          const c = new THREE.Color(color ?? 0xffffff).multiplyScalar(k);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    // (u0,v0) (u1,v0) (u0,v1) (u1,v1) -> two CCW triangles seen from +n.
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (col.length) g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/**
 * A box positioned by its world-space min/max corners, with UVs already in
 * world metres. Returns geometry in world coordinates, so several of these can
 * be merged into one static mesh at the origin.
 */
export function buildingWorldBox(
  min: THREE.Vector3,
  max: THREE.Vector3,
  opts: Omit<BuildingBoxOptions, "uvOrigin"> = {}
): THREE.BufferGeometry {
  const size = new THREE.Vector3().subVectors(max, min);
  const centre = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const g = buildingBox(size.x, size.y, size.z, {
    ...opts,
    uvOrigin: centre,
    ao: opts.ao ? (y) => opts.ao!(y + centre.y) : undefined,
  });
  g.translate(centre.x, centre.y, centre.z);
  return g;
}

/**
 * A flat quad facing a cardinal direction, for decals and glass. `w` runs
 * along the face's horizontal axis, `h` vertically (or along Z for a floor).
 */
export function buildingQuad(w: number, h: number, facing: "+x" | "-x" | "+y" | "-y" | "+z" | "-z"): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  switch (facing) {
    case "+z":
      break;
    case "-z":
      g.rotateY(Math.PI);
      break;
    case "+x":
      g.rotateY(Math.PI / 2);
      break;
    case "-x":
      g.rotateY(-Math.PI / 2);
      break;
    case "+y":
      g.rotateX(-Math.PI / 2);
      break;
    case "-y":
      g.rotateX(Math.PI / 2);
      break;
  }
  return g;
}

/**
 * A rectangular frame (four bars) lying in a plane, used for storefront
 * mullions, door frames and cooler door stiles. Returned in local XY with the
 * given depth along Z, centred on the origin.
 */
export function buildingFrame(w: number, h: number, bar: number, depth: number, uvMetres = 0.5): THREE.BufferGeometry {
  const uv = new THREE.Vector2(uvMetres, uvMetres);
  const parts: THREE.BufferGeometry[] = [];
  const push = (cx: number, cy: number, sx: number, sy: number) => {
    const g = buildingBox(sx, sy, depth, { uvMetres: uv, uvOrigin: new THREE.Vector3(cx, cy, 0) });
    g.translate(cx, cy, 0);
    parts.push(g);
  };
  push(0, h / 2 - bar / 2, w, bar); // head
  push(0, -h / 2 + bar / 2, w, bar); // sill
  push(-w / 2 + bar / 2, 0, bar, h - bar * 2); // left jamb
  push(w / 2 - bar / 2, 0, bar, h - bar * 2); // right jamb
  return mergeLocal(parts);
}

/** Merge a list of geometries that all share the same attribute set. */
export function mergeLocal(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Kept local rather than pulling in BufferGeometryUtils for the frame case,
  // because these are all non-indexed-compatible boxes with identical layouts.
  const total = list.reduce((n, g) => n + g.getAttribute("position").count, 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const hasColor = list.every((g) => g.getAttribute("color"));
  const col = hasColor ? new Float32Array(total * 3) : null;
  const idx: number[] = [];

  let vOff = 0;
  for (const g of list) {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const t = g.getAttribute("uv");
    pos.set(p.array as Float32Array, vOff * 3);
    nor.set(n.array as Float32Array, vOff * 3);
    uv.set(t.array as Float32Array, vOff * 2);
    if (col) col.set(g.getAttribute("color").array as Float32Array, vOff * 3);
    const gi = g.getIndex()!;
    for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + vOff);
    vOff += p.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

/**
 * A cylinder aligned to an arbitrary axis, for conduit, handrails, push bars,
 * hose bibs and bottle bodies. UVs are metre-based along the length.
 */
export function buildingTube(
  radius: number,
  length: number,
  axis: "x" | "y" | "z",
  radial = 10,
  uvMetres = 0.5
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, radial, 1, false);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const circumference = Math.PI * 2 * radius;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * circumference) / uvMetres, (uv.getY(i) * length) / uvMetres);
  }
  uv.needsUpdate = true;
  if (axis === "x") g.rotateZ(Math.PI / 2);
  if (axis === "z") g.rotateX(Math.PI / 2);
  return g;
}
