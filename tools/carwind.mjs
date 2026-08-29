/**
 * Per-triangle winding audit of every geometry the car builds, on the CPU.
 *
 * Compares each triangle's GEOMETRIC normal, which comes from its winding,
 * against the mean of its own SHADING normals. Needs no region, no camera and no
 * render, and is exact by construction.
 *
 * WHY THE MEAN-NORMAL METHOD THIS REPLACES WAS USELESS ON SOLIDS
 *
 * `partscale --winding` compares a part's area-weighted mean normal against an
 * outward radial. That is well defined for a strip and **undefined for a closed
 * solid**, because the area-weighted mean normal of a cube is zero - so every
 * mean-normal method certifies every solid. It reported the car clean while 5,828
 * reversed triangles sat in eight meshes.
 *
 * WHY THE BUG SURVIVES EVERY OTHER CHECK
 *
 * `computeVertexNormals()` derives normals from the winding, so it certifies
 * whatever it is handed. Calling it converts a winding bug into a shading bug and
 * destroys the evidence in the same statement. This tool therefore only works on
 * geometry whose normals came from somewhere other than its current index - which
 * is the common case, because the defects are folds and reversals introduced
 * *around* an otherwise consistent sweep, and the averaged vertex normals at a
 * fold still disagree with the individual faces.
 *
 * ALSO REPORTS LATENT DEFECTS. A mesh drawn `DoubleSide` hides its reversed
 * triangles: nothing is culled, so nothing looks wrong, and the whole set
 * surfaces the moment anyone sets `side` correctly for a performance pass - a
 * change that looks free. Those are counted separately and must not be dismissed.
 *
 * Usage: node --import ./tools/extresolve.mjs tools/carwind.mjs [--max=N]
 */
const body = await import("../src/gen/carBody.ts");
const parts = await import("../src/gen/carParts.ts");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const raw = hit.slice(name.length + 3);
  const v = Number(raw);
  if (raw === "" || !Number.isFinite(v)) {
    console.error(`--${name} needs a finite number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return v;
};
/** Fail the run above this many reversed triangles in any single mesh. */
const MAX = flag("max", 0);

const sub = (a, b, o) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const at = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];

/**
 * @returns {{tris:number,reversed:number,agree:number,degenerate:number}|null}
 */
function audit(geo) {
  if (!geo) return null;
  const pos = geo.getAttribute?.("position");
  const nrm = geo.getAttribute?.("normal");
  if (!pos || !nrm) return null;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const ix = (t) => (index ? index.array[t] : t);

  let tris = 0;
  let reversed = 0;
  let agree = 0;
  let degenerate = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = ix(t);
    const i1 = ix(t + 1);
    const i2 = ix(t + 2);
    const p0 = at(pos.array, i0);
    const gn = unit(cross3(sub(at(pos.array, i1), p0), sub(at(pos.array, i2), p0)));
    if (!gn) {
      degenerate++;
      continue;
    }
    const sn = unit([
      (nrm.array[i0 * 3] + nrm.array[i1 * 3] + nrm.array[i2 * 3]) / 3,
      (nrm.array[i0 * 3 + 1] + nrm.array[i1 * 3 + 1] + nrm.array[i2 * 3 + 1]) / 3,
      (nrm.array[i0 * 3 + 2] + nrm.array[i1 * 3 + 2] + nrm.array[i2 * 3 + 2]) / 3,
    ]);
    if (!sn) {
      degenerate++;
      continue;
    }
    tris++;
    const d = dot3(gn, sn);
    agree += d;
    if (d < 0) reversed++;
  }
  return { tris, reversed, agree: tris ? agree / tris : NaN, degenerate };
}

/* Every geometry the car builds, with the `side` it is drawn with, because a
 * DoubleSide mesh hides its reversals rather than not having them. */
// Order matters and the builder says so: `endZ` reads the caps that
// buildCarShell populates, so the shell has to exist before anything places a
// part against the nose or tail.
const shell = body.buildCarShell();
const lamps = parts.buildLamps();
const trim = parts.buildTrim ? parts.buildTrim() : null;
const interior = parts.buildInterior ? parts.buildInterior() : null;

const targets = [];
const push = (name, geo, doubleSided = false) => geo && targets.push({ name, geo, doubleSided });

push("car-tyre", body.buildTyre());
if (shell) {
  push("car-body", shell.body);
  push("car-glass", shell.glass, true);
  push("car-inner-skin", shell.inner, true);
  push("car-slots", shell.slots, true);
  push("car-headliner", shell.headliner, true);
  push("car-seals", shell.seals);
  push("car-pillars", shell.pillars);
}
if (interior) {
  for (const [k, v] of Object.entries(interior)) {
    if (v && typeof v === "object" && v.getAttribute) push(`car-${k}`, v);
  }
}
push("car-lamp-lens", lamps.lens);
push("car-lamp-housing", lamps.housing);
push("car-lamp-reflector", lamps.reflector);
push("car-lamp-bezel", lamps.bezel);
if (trim) {
  for (const [k, v] of Object.entries(trim)) {
    if (k === "parts" || k === "debugFront") continue;
    if (v && typeof v === "object" && v.getAttribute) push(`car-trim-${k}`, v);
  }
}

console.log("\n=== per-triangle winding audit (geometric vs shading normal) ===\n");
console.log("  mesh                     tris   reversed   agree   note");
let worst = 0;
let latent = 0;
let culling = 0;
for (const t of targets) {
  const r = audit(t.geo);
  if (!r) {
    console.log(`  ${t.name.padEnd(22)}  no position/normal attribute`);
    continue;
  }
  const note = r.reversed === 0 ? "" : t.doubleSided ? "LATENT - masked by DoubleSide" : "CULLED TODAY";
  if (r.reversed) {
    if (t.doubleSided) latent += r.reversed;
    else culling += r.reversed;
    worst = Math.max(worst, t.doubleSided ? 0 : r.reversed);
  }
  console.log(
    `  ${t.name.padEnd(22)} ${String(r.tris).padStart(6)} ${String(r.reversed).padStart(10)}` +
      `   ${r.agree.toFixed(3)}   ${note}`
  );
}
console.log(`\n  reversed and culled today: ${culling}`);
console.log(`  reversed but masked by DoubleSide (latent): ${latent}`);
if (latent) {
  console.log(
    `\n  LATENT IS NOT SAFE. Those surface the moment anyone sets \`side\` correctly\n` +
      `  for a performance pass, which is a change that looks free.`
  );
}
if (worst > MAX) {
  console.error(`\nFAIL: ${worst} reversed triangles in a single culled mesh (limit ${MAX}).`);
  process.exit(1);
}
console.log("\nPASS");

/*
 * KNOWN LIMITATION, AND IT MAKES EVERY COUNT THIS TOOL PRINTS A LOWER BOUND.
 *
 * This detector compares a triangle's geometric normal against the mean of its
 * own shading normals - and those shading normals came from `computeVertexNormals`,
 * which derives them from the winding. So inside a CONTIGUOUS reversed region the
 * shading normals are reversed too, they agree with the geometry, and the tool
 * reports the region clean. **What it actually detects is the PERIMETER of a
 * reversed region, not its interior.**
 *
 * Measured on this car: the fan in `makeCap` had 4,540 consistently reversed
 * triangles at the nose and 1,344 at the tail, all being culled against a
 * FrontSide material - and this tool reported 125, which was the boundary where
 * the reversed band met correctly wound bodywork. A factor of 47.
 *
 * So a small non-zero count is not a small defect. It is a boundary, and the
 * region behind it has to be measured some other way - by orienting against a
 * direction the builder knows, as `makeCap` now does, and reporting how many
 * triangles that correction had to move.
 *
 * The corollary for the scene-wide audit: 5,828 reversed triangles across 370
 * meshes is a floor, not a total.
 */
