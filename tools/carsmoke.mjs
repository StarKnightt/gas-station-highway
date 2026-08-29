/**
 * Builds every piece of car geometry on the CPU and checks it is finite and
 * non-degenerate. No renderer, no GPU, no page.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/carsmoke.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const body = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);
const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);

let bad = 0;
function check(label, geo) {
  const p = geo?.getAttribute?.("position");
  if (!p || p.count === 0) {
    console.log(`  FAIL ${label}: no positions`);
    bad++;
    return;
  }
  let nan = 0;
  for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i])) nan++;
  const n = geo.getAttribute("normal");
  // Only vertices the index actually references. Cutting the grille and intake
  // out of the front cap orphans every ring vertex inside the openings, and
  // `computeVertexNormals` leaves an untouched vertex at zero - so 6136 of them
  // showed up here as degenerate normals on a body that draws none of them.
  // A tool that cries wolf on correct geometry gets ignored on wrong geometry.
  const used = new Uint8Array(n ? n.count : 0);
  const idx = geo.getIndex();
  if (idx) for (let i = 0; i < idx.count; i++) used[idx.getX(i)] = 1;
  else used.fill(1);

  let degenerate = 0;
  let live = 0;
  if (n) {
    for (let i = 0; i < n.count; i++) {
      if (!used[i]) continue;
      live++;
      if (Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) < 0.5) degenerate++;
    }
  }
  const flag = nan || degenerate > live * 0.02 ? "FAIL" : "ok  ";
  if (flag === "FAIL") bad++;
  console.log(
    `  ${flag} ${label.padEnd(22)} verts ${String(p.count).padStart(6)}` +
      `  nan ${String(nan).padStart(4)}  zero-normals ${String(degenerate).padStart(5)}`
  );
}

const shell = buildAll();
function buildAll() {
  const s = body.buildCarShell();
  for (const [k, v] of Object.entries(s)) if (v?.getAttribute) check(`shell.${k}`, v);
  return s;
}
void shell;

for (const [k, v] of Object.entries(parts.buildTrim())) check(`trim.${k}`, v);
for (const [k, v] of Object.entries(parts.buildLamps())) check(`lamps.${k}`, v);
for (const [k, v] of Object.entries(parts.buildInterior())) check(`interior.${k}`, v);
for (const [k, v] of Object.entries(parts.buildWheel())) check(`wheel.${k}`, v);
check("archLips", parts.buildArchLips());
check("sills", parts.buildSills());
const { CAR } = body;
for (const phase of [0, 0.37])
  check(`tyre(phase ${phase})`, body.buildTyre(CAR.tyreR, CAR.tyreWidth, CAR.rimR, CAR.squash, phase));

console.log(bad ? `\n  ${bad} FAILURE(S)` : "\n  all car geometry built clean");
process.exit(bad ? 1 : 0);
