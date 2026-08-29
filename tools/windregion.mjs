/**
 * MEASURES THE REVERSED *REGION*, WHERE THE PER-TRIANGLE DETECTOR ONLY FINDS ITS
 * PERIMETER.
 *
 * The problem this exists to solve, and why every winding count in the project is
 * a floor rather than a total:
 *
 * `carwind.mjs` compares each triangle's geometric normal against the mean of its
 * own shading normals. That is exact where it fires, but `computeVertexNormals()`
 * derives shading normals FROM the winding - so inside a *contiguous* reversed
 * region the shading normals are reversed too, they agree with the geometry, and
 * the interior certifies clean. Only the boundary, where reversed faces average
 * against correct ones, disagrees. Measured on `car-body`: **125 detected against
 * 5,884 actually reversed, a factor of 47.**
 *
 * So a small non-zero count is a perimeter with something behind it, and the
 * question "how many triangles are wrong" cannot be answered by that detector at
 * all. This tool answers it.
 *
 * HOW, AND WHY IT NEEDS NO DIRECTION
 *
 * Purely topological. Two triangles sharing an edge are consistently wound iff
 * they traverse that shared edge in OPPOSITE directions - that is the definition
 * of consistent orientation on a surface, and it appeals to no normal, no
 * centroid, no outward radial and no camera. Flood-filling across
 * consistently-wound adjacencies partitions the mesh into maximal patches of
 * mutually-agreeing winding.
 *
 * Reading the result:
 *
 *   - ONE patch covering everything: the winding is globally consistent. Whatever
 *     the per-triangle detector reported is NOT a reversed region - it is slivers,
 *     authored normals that disagree with the faces, or a crease. Refuted.
 *   - TWO OR MORE patches: the boundary between them is a real winding
 *     discontinuity, and the smaller patch is the reversed region. Its size is the
 *     number the perimeter count was standing in for. Confirmed.
 *
 * The patch sizes are the deliverable, because they are what the perimeter count
 * cannot tell you.
 *
 * VERTICES MUST BE WELDED FIRST. Procedural geometry routinely splits vertices for
 * hard normals or UV seams, and split vertices make every edge look unshared, so
 * an unwelded mesh reports one patch per triangle and the tool would confidently
 * report nothing wrong. Positions are therefore quantised and merged, and the tool
 * REFUSES to draw a conclusion when welding leaves the surface too disconnected to
 * carry an orientation - see the `boundary` figure. A tool that cannot fail is not
 * a measurement.
 *
 * Usage: node --import ./tools/extresolve.mjs tools/windregion.mjs [--only=name]
 */
const body = await import("../src/gen/carBody.ts");
const parts = await import("../src/gen/carParts.ts");

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);

/** 1e-5 m. Tighter than any real vertex spacing here, looser than float noise. */
const WELD = 1e5;

function analyse(geo) {
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const at = (i) => (idx ? idx.getX(i) : i);

  // Weld by quantised position, so shared edges are actually shared.
  const key = new Map();
  const weld = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * WELD)},${Math.round(pos.getY(i) * WELD)},${Math.round(
      pos.getZ(i) * WELD
    )}`;
    let w = key.get(k);
    if (w === undefined) {
      w = key.size;
      key.set(k, w);
    }
    weld[i] = w;
  }

  /**
   * Directed edge -> triangle. An edge appearing twice in the SAME direction is
   * the signature of two triangles disagreeing about which way is out.
   */
  const dir = new Map();
  const tris = [];
  for (let t = 0; t < triCount; t++) {
    const a = weld[at(t * 3)];
    const b = weld[at(t * 3 + 1)];
    const c = weld[at(t * 3 + 2)];
    if (a === b || b === c || a === c) {
      tris.push(null); // Degenerate after welding; carries no orientation.
      continue;
    }
    tris.push([a, b, c]);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = `${u}_${v}`;
      if (!dir.has(k)) dir.set(k, []);
      dir.get(k).push(t);
    }
  }

  // Adjacency across consistently-wound shared edges only.
  const adj = new Map();
  let agree = 0;
  let clash = 0;
  let boundary = 0;
  for (let t = 0; t < triCount; t++) {
    const tri = tris[t];
    if (!tri) continue;
    const [a, b, c] = tri;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const opposed = dir.get(`${v}_${u}`) ?? [];
      const same = (dir.get(`${u}_${v}`) ?? []).filter((o) => o !== t);
      if (opposed.length) {
        agree++;
        if (!adj.has(t)) adj.set(t, []);
        for (const o of opposed) adj.get(t).push(o);
      } else if (same.length) {
        clash++;
      } else {
        boundary++;
      }
    }
  }

  // Flood fill maximal consistently-wound patches.
  const patch = new Int32Array(triCount).fill(-1);
  const sizes = [];
  for (let s = 0; s < triCount; s++) {
    if (!tris[s] || patch[s] !== -1) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [s];
    patch[s] = id;
    while (stack.length) {
      const t = stack.pop();
      n++;
      for (const o of adj.get(t) ?? []) {
        if (patch[o] === -1 && tris[o]) {
          patch[o] = id;
          stack.push(o);
        }
      }
    }
    sizes.push(n);
  }
  /**
   * THE HOLE THE TOPOLOGICAL TEST CANNOT SEE, CLOSED.
   *
   * Consistency within a patch says nothing about whether that patch faces the
   * right way. A disconnected pane reversed *as a whole unit* has zero clash
   * edges and forms one perfectly consistent patch - and `computeVertexNormals`
   * reverses its shading normals too, so the per-triangle detector also reports it
   * clean. It would be invisible to both tests, while being culled entirely.
   *
   * So each patch also gets an orientation check. This is the one place a
   * direction is needed, and the mean normal is legitimate HERE precisely because
   * a patch is a sheet rather than a closed solid - the objection that sinks
   * `partscale --winding` on a whole body does not apply to a single pane.
   */
  const bb = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (let i = 0; i < pos.count; i++) {
    bb.x[0] = Math.min(bb.x[0], pos.getX(i));
    bb.x[1] = Math.max(bb.x[1], pos.getX(i));
    bb.y[0] = Math.min(bb.y[0], pos.getY(i));
    bb.y[1] = Math.max(bb.y[1], pos.getY(i));
    bb.z[0] = Math.min(bb.z[0], pos.getZ(i));
    bb.z[1] = Math.max(bb.z[1], pos.getZ(i));
  }
  const core = [
    (bb.x[0] + bb.x[1]) / 2,
    (bb.y[0] + bb.y[1]) / 2,
    (bb.z[0] + bb.z[1]) / 2,
  ];

  const acc = sizes.map(() => ({ n: [0, 0, 0], c: [0, 0, 0], a: 0 }));
  const order = new Map();
  {
    // Re-derive patch ids in size order so reporting matches `sizes`.
    const bySize = [...sizes.keys()].sort((p, q) => sizes[q] - sizes[p]);
    bySize.forEach((id, rank) => order.set(id, rank));
  }
  for (let t = 0; t < triCount; t++) {
    const tri = tris[t];
    if (!tri || patch[t] === -1) continue;
    const rank = order.get(patch[t]);
    const p = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)].map((i) => [
      pos.getX(i),
      pos.getY(i),
      pos.getZ(i),
    ]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    const e = acc[rank];
    e.a += area;
    for (let k = 0; k < 3; k++) {
      e.n[k] += n[k] / 2;
      e.c[k] += ((p[0][k] + p[1][k] + p[2][k]) / 3) * area;
    }
  }
  const inward = [];
  const outward = [];
  acc.forEach((e, rank) => {
    if (e.a <= 0) return;
    const c = e.c.map((s) => s / e.a);
    const out = [c[0] - core[0], c[1] - core[1], c[2] - core[2]];
    const lo = Math.hypot(...out);
    const ln = Math.hypot(...e.n);
    if (lo < 1e-6 || ln < 1e-9) return;
    const dot = (e.n[0] * out[0] + e.n[1] * out[1] + e.n[2] * out[2]) / (ln * lo);
    // Only a clearly inward-facing sheet counts. Near-tangential patches carry
    // no outward information and must not be flagged.
    if (dot < -0.25) inward.push({ rank, tris: sizes[rank], dot: +dot.toFixed(2) });
    if (dot > 0.25) outward.push({ rank, tris: sizes[rank], dot: +dot.toFixed(2) });
  });

  sizes.sort((p, q) => q - p);

  return {
    inward,
    outward,
    triCount,
    degenerate: tris.filter((t) => !t).length,
    agree,
    /** Shared edges traversed the SAME way by both triangles: a real reversal. */
    clash: clash / 2,
    /** Unshared edges. High means welding failed and the verdict is void. */
    boundary,
    patches: sizes.length,
    sizes,
  };
}

// buildCarShell populates module state the placers need, so it runs first.
const shell = body.buildCarShell();
const lamps = parts.buildLamps();

/**
 * EXPECTED FACING, AND WHY THE TOOL CANNOT INFER IT.
 *
 * The orientation check has to know which way the surface is SUPPOSED to face, and
 * it cannot work that out for itself. An interior surface legitimately faces
 * inward: the headliner is a cabin ceiling seen from below, so a normal pointing
 * back toward the body core is correct - and the first run of this tool duly
 * reported 627 of its triangles as reversed. They are not.
 *
 * This is the fourth time this system has produced the same shape: a check
 * deriving orientation from an assumption the caller actually owns. It is the same
 * trap as `pushIfNotFolded` needing a `sign`, where testing the headliner against
 * the inner skin's convention would have deleted every one of its triangles. So
 * the expectation is DECLARED per target rather than guessed, and "in" is a real
 * answer that gets checked in its own direction rather than a suppression.
 *
 * "none" means the surface has no facing expectation to check, for either of two
 * reasons: it has no consistent outward direction at all - cavity walls face every
 * way by construction - or it is drawn `DoubleSide`, where orientation has no
 * rendering consequence whatsoever.
 *
 * AND THE RULE THAT FALLS OUT, WHICH I GOT WRONG TWICE BEFORE ARRIVING AT IT:
 * **only declare a facing expectation where the renderer enforces one.** I first
 * guessed "out" for everything and the tool reported the headliner's 627. I then
 * declared the headliner and inner skin "in", and it reported 40,277 the other
 * way. Both were my invention: both meshes are `DoubleSide`, so neither has a
 * correct facing to be wrong about, and any expectation I write down manufactures
 * a defect in whichever direction I happened to choose. `FrontSide` is what makes
 * an orientation checkable, so `FrontSide` is what earns an expectation.
 */
const targets = [
  ["car-body", shell.body, "out"],
  // DoubleSide, so no facing to be wrong about. Clash count is the only signal.
  ["car-glass", shell.glass, "none"],
  ["car-slots", shell.slots, "none"],
  ["car-inner-skin", shell.inner, "none"],
  ["car-headliner", shell.headliner, "none"],
  ["car-seals", shell.seals, "none"],
  ["car-pillars", shell.pillars, "out"],
  ["car-lamp-lens", lamps.lens, "out"],
];

console.log("name                tris  degen  clashEdges  openEdges  patches  sizes");
for (const [name, geo, facing] of targets) {
  if (!geo || (only && !name.includes(only))) continue;
  const r = analyse(geo);
  const openFrac = r.boundary / (r.triCount * 3);
  const verdict =
    openFrac > 0.25
      ? "VOID: welding left the surface too open to orient"
      : r.patches <= 1
        ? "one patch - winding globally consistent, no region"
        : `${r.patches} patches - smallest ${r.sizes[r.sizes.length - 1]}`;
  console.log(
    name.padEnd(18) +
      String(r.triCount).padStart(6) +
      String(r.degenerate).padStart(7) +
      String(r.clash).padStart(12) +
      String(r.boundary).padStart(11) +
      String(r.patches).padStart(9) +
      "  " +
      r.sizes.slice(0, 6).join(",") +
      (r.sizes.length > 6 ? ",..." : "")
  );
  console.log("".padEnd(18) + verdict);
  const wrong = facing === "none" ? [] : facing === "in" ? r.outward : r.inward;
  if (wrong.length) {
    const tot = wrong.reduce((k, i) => k + i.tris, 0);
    console.log(
      "".padEnd(18) +
        "REVERSED PATCHES: " +
        wrong.length +
        (facing === "in" ? " facing outward, " : " facing inward, ") +
        tot +
        " triangles - " +
        wrong.map((i) => i.tris + "@" + i.dot).join(" ")
    );
  }
}
