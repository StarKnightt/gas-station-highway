/**
 * finitecheck — assert that procedurally built geometry contains no NaN or Inf.
 *
 * SHARED TOOLING. Not vegetation-specific. Every system in this project builds
 * its geometry from arithmetic, every system now feeds the world capture, and
 * one non-finite vertex anywhere blacks out the entire scene for every agent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY READING THE CODE IS NOT AN ALTERNATIVE
 * ---------------------------------------------------------------------------
 *
 * An evening was lost to a NaN that reached the PMREM environment cube. It came
 * from `Math.pow(t, 0.55)` where `t` was about −1e-8 — algebraically zero, but
 * `PlaneGeometry(w, h, 1, 2).translate(0, h / 2, 0)` does not put the bottom row
 * at exactly zero, because −h/2 + h/2 does not cancel in float32.
 *
 * Three properties make this class undetectable by inspection:
 *
 *  1. **It has no local symptom.** A NaN fragment is discarded, so the geometry
 *     that produces it looks perfect. The defect only appears somewhere else
 *     entirely — here, through the GGX filter of the environment cube, where a
 *     single bad texel spreads across a neighbourhood of every mip and every
 *     `MeshStandardMaterial` in the scene renders black. It was tracked through
 *     four unrelated systems before it was found.
 *  2. **Whether it fires is a property of float32 rounding, not of the source.**
 *     Swept over 2,000 plausible heights, that `translate` leaves the bottom row
 *     negative for **50.1%** of them. It is a coin flip per geometry. Nothing in
 *     the source distinguishes a safe height from an unsafe one.
 *  3. **So source review returns false clearances.** The vegetation owner read
 *     all nineteen fractional-power and `sqrt` sites in its generators and would
 *     have cleared several of the risky ones, for exactly the reason above.
 *
 * The conclusion, which is recorded in NOTES.md as a rule: **source review is
 * not a valid clearing method for this defect class. Only the assertion is.**
 * Run it; do not reason about it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COVERS
 * ---------------------------------------------------------------------------
 *
 * Geometry attributes are the obvious route into the environment cube, and the
 * only one most checks look at. They are not the only one:
 *
 *  - every `BufferAttribute` of every geometry, including `color`, `uv`,
 *    `normal` and any custom attribute;
 *  - `morphAttributes`, which are separate arrays and easy to forget;
 *  - `InstancedMesh.instanceMatrix` and `instanceColor`, which are how a bad
 *    tint or a bad placement reaches the screen without touching a geometry;
 *  - loose card lists — `{ matrix, tint }` records — checked before they are
 *    ever written into an `InstancedMesh`, so the failure names the generator
 *    rather than the consumer;
 *  - `Object3D` transforms, since a NaN in a parent's position moves every
 *    child somewhere undefined.
 *
 * ---------------------------------------------------------------------------
 * USE
 * ---------------------------------------------------------------------------
 *
 *   import { assertFinite, checkObject } from "./finitecheck.mjs";
 *
 *   assertFinite(geometry, "pine 3 wood");         // throws, with the index
 *   assertFinite(scene, "whole scene");            // traverses
 *   assertFinite(cards, "pine 3 cards");           // array of {matrix,tint}
 *
 *   const problems = checkObject(root, "scene");   // non-throwing form
 *
 * Selftest, which must pass before the check is worth anything:
 *
 *   node tools/finitecheck.mjs --selftest
 */

/** A single non-finite value, located precisely enough to fix. */
export class FiniteProblem {
  constructor(where, kind, index, value, detail = "") {
    this.where = where;
    this.kind = kind;
    this.index = index;
    this.value = value;
    this.detail = detail;
  }
  toString() {
    return (
      `${this.where}: non-finite in ${this.kind} at index ${this.index} = ${this.value}` +
      (this.detail ? ` (${this.detail})` : "")
    );
  }
}

function scanArray(arr, where, kind, itemSize, out, limit) {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) continue;
    const detail = itemSize > 1 ? `element ${Math.floor(i / itemSize)}, component ${i % itemSize}` : "";
    out.push(new FiniteProblem(where, kind, i, v, detail));
    if (out.length >= limit) return;
  }
}

/**
 * Every attribute of one geometry, including morph targets.
 *
 * Does not use `computeBoundingBox` as a proxy. A bounding box over a NaN is
 * itself NaN, so that would work, but only for `position` — it says nothing
 * about a bad vertex colour, which is the case that actually caused the outage.
 */
export function checkGeometry(geometry, where = "geometry", { limit = 20 } = {}) {
  const out = [];
  if (!geometry || !geometry.attributes) return out;
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    scanArray(attr.array, where, `attribute "${name}"`, attr.itemSize ?? 1, out, limit);
    if (out.length >= limit) return out;
  }
  const morph = geometry.morphAttributes ?? {};
  for (const [name, list] of Object.entries(morph)) {
    for (let t = 0; t < list.length; t++) {
      scanArray(list[t].array, where, `morph "${name}" target ${t}`, list[t].itemSize ?? 1, out, limit);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * A list of `{ matrix, tint }` records, before they reach an `InstancedMesh`.
 *
 * Worth checking separately: once these are written into an instance buffer the
 * failure names the mesh, and a mesh can be fed by several generators. Checked
 * here, the failure names the generator and the index.
 */
export function checkCards(cards, where = "cards", { limit = 20 } = {}) {
  const out = [];
  if (!cards) return out;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const tint = c?.tint;
    if (tint) {
      for (const [ch, v] of [
        ["r", tint.r],
        ["g", tint.g],
        ["b", tint.b],
      ]) {
        if (!Number.isFinite(v)) out.push(new FiniteProblem(where, `tint.${ch}`, i, v, `card ${i}`));
      }
    }
    const m = c?.matrix;
    if (m && m.elements) scanArray(m.elements, where, `matrix of card ${i}`, 4, out, limit);
    if (out.length >= limit) return out;
  }
  return out;
}

/** One mesh: its geometry, its instance buffers, and its own transform. */
export function checkMesh(mesh, where = "mesh", { limit = 20 } = {}) {
  const out = [];
  if (!mesh) return out;
  const label = where || mesh.name || mesh.type || "mesh";
  if (mesh.geometry) out.push(...checkGeometry(mesh.geometry, `${label}.geometry`, { limit }));
  if (out.length >= limit) return out;
  if (mesh.instanceMatrix) {
    scanArray(mesh.instanceMatrix.array, label, "instanceMatrix", 16, out, limit);
    if (out.length >= limit) return out;
  }
  if (mesh.instanceColor) {
    scanArray(mesh.instanceColor.array, label, "instanceColor", 3, out, limit);
    if (out.length >= limit) return out;
  }
  for (const [kind, v] of [
    ["position", mesh.position],
    ["scale", mesh.scale],
  ]) {
    if (v && !(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)))
      out.push(new FiniteProblem(label, kind, -1, `(${v.x}, ${v.y}, ${v.z})`));
  }
  const q = mesh.quaternion;
  if (q && !(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)))
    out.push(new FiniteProblem(label, "quaternion", -1, `(${q.x}, ${q.y}, ${q.z}, ${q.w})`));
  return out;
}

/** A whole subtree. Names each problem by the object's own name where it has one. */
export function checkObject(root, where = "object", { limit = 20 } = {}) {
  const out = [];
  if (!root) return out;
  if (typeof root.traverse !== "function") return checkMesh(root, where, { limit });
  root.traverse((o) => {
    if (out.length >= limit) return;
    const label = `${where} / ${o.name || o.type}`;
    out.push(...checkMesh(o, label, { limit: limit - out.length }));
  });
  return out;
}

/** Dispatches on what it is given: geometry, mesh, subtree, or a card list. */
export function check(subject, where = "subject", opts = {}) {
  if (Array.isArray(subject)) return checkCards(subject, where, opts);
  if (subject && subject.isBufferGeometry) return checkGeometry(subject, where, opts);
  if (subject && subject.isObject3D) return checkObject(subject, where, opts);
  return checkMesh(subject, where, opts);
}

/**
 * The form to call in a smoke test. Throws on the first problems found, with
 * enough location to go straight to the generator.
 */
export function assertFinite(subject, where = "subject", opts = {}) {
  const problems = check(subject, where, opts);
  if (!problems.length) return;
  const head = problems.slice(0, 5).map((p) => `  - ${p}`).join("\n");
  const more = problems.length > 5 ? `\n  ... and ${problems.length - 5} more` : "";
  throw new Error(
    `finitecheck: ${problems.length} non-finite value(s) in ${where}.\n${head}${more}\n` +
      `A NaN here has no local symptom but poisons the world-capture PMREM and blacks out the whole scene. ` +
      `Look for a fractional power or sqrt of a value that is algebraically zero — it may be slightly negative in float32.`
  );
}

// ---------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------

async function selftest() {
  const THREE = await import("three");
  let failures = 0;
  const check1 = (name, fn) => {
    let caught = null;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    const ok = Boolean(caught);
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- the assertion did NOT fire"}`);
  };
  const clean = (name, fn) => {
    let caught = null;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    const ok = !caught;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- false positive: " + caught.message.split("\n")[0]}`);
  };

  console.log("finitecheck --selftest");
  console.log("\nplanted defects, each must be caught:");

  check1("NaN in a vertex colour (the shape that caused the outage)", () => {
    const g = new THREE.PlaneGeometry(1, 1, 1, 2);
    const c = new Float32Array(g.getAttribute("position").count * 3).fill(0.5);
    c[7] = Math.pow(-1e-8, 0.55);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    assertFinite(g, "planted vertex colour");
  });

  check1("NaN in a position", () => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.getAttribute("position").array[4] = NaN;
    assertFinite(g, "planted position");
  });

  check1("Infinity in a position (division by zero, not just NaN)", () => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.getAttribute("position").array[2] = 1 / 0;
    assertFinite(g, "planted infinity");
  });

  check1("NaN in a morph target", () => {
    const g = new THREE.PlaneGeometry(1, 1);
    const m = g.getAttribute("position").clone();
    m.array[0] = NaN;
    g.morphAttributes.position = [m];
    assertFinite(g, "planted morph");
  });

  check1("NaN in an instance matrix", () => {
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 4);
    mesh.instanceMatrix.array[3] = NaN;
    assertFinite(mesh, "planted instanceMatrix");
  });

  check1("NaN in an instance colour", () => {
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 4);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12).fill(1), 3);
    mesh.instanceColor.array[5] = NaN;
    assertFinite(mesh, "planted instanceColor");
  });

  check1("NaN in a card tint, before it reaches a mesh", () => {
    assertFinite(
      [{ matrix: new THREE.Matrix4(), tint: new THREE.Color(1, NaN, 1) }],
      "planted card tint"
    );
  });

  check1("NaN nested two levels down a subtree", () => {
    const root = new THREE.Group();
    const mid = new THREE.Group();
    const g = new THREE.PlaneGeometry(1, 1);
    g.getAttribute("position").array[1] = NaN;
    mid.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    root.add(mid);
    assertFinite(root, "planted subtree");
  });

  console.log("\nclean inputs, none may fire:");
  clean("a plain geometry", () => assertFinite(new THREE.BoxGeometry(1, 1, 1), "clean box"));
  clean("an instanced mesh with identity matrices", () =>
    assertFinite(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 8), "clean instanced")
  );
  clean("an empty card list", () => assertFinite([], "clean cards"));

  // The evidence for the rule this tool encodes. Not an assertion — a
  // demonstration, printed so nobody has to take the 50.1% on trust.
  console.log("\nwhy source review cannot clear this class:");
  let neg = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const h = 0.05 + i * 0.0012;
    const g = new THREE.PlaneGeometry(0.3, h, 1, 2);
    g.translate(0, h / 2, 0);
    const p = g.getAttribute("position");
    let min = Infinity;
    for (let v = 0; v < p.count; v++) min = Math.min(min, p.getY(v) / h);
    if (min < 0) neg++;
  }
  const pct = ((neg / N) * 100).toFixed(1);
  console.log(
    `  PlaneGeometry(w, h, 1, 2).translate(0, h/2, 0) leaves the base row NEGATIVE\n` +
      `  for ${neg} of ${N} plausible heights = ${pct}%. A fractional power of that value is NaN.\n` +
      `  Which side of zero any given height lands on is float32 rounding, not source.`
  );

  console.log(`\n${failures ? `SELFTEST FAILED: ${failures} case(s)` : "selftest passed"}`);
  return failures;
}

if (process.argv.includes("--selftest")) {
  selftest().then((f) => process.exit(f ? 1 : 0));
}
