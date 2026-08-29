#!/usr/bin/env node
/**
 * Which nozzle parts actually reach the frame, per part, in pixels.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *        tools/nozzleread.mjs [--seed=1] [--face=-1] [--pose=nozzle] [--png=out.png]
 *   ... --selftest
 *
 * Why this exists, and why it is not `nozzleprobe.mjs`.
 *
 * `nozzleprobe` answers "is the tool seated in the boot", and it is right: the
 * spout is tens of millimetres down the cup and the body is canted. A critic
 * looking at the same frame reports a nozzle with no trigger, no guard, no
 * latch and no bellows. Both readings survived three rounds because they are
 * about different things, and nothing in the toolchain could measure the
 * second one: after `buildPump` merges the assembly into three material slots
 * there is no trigger guard any more, only 4000 triangles of `metal`.
 *
 * NOTES case 11 is the shape of it — "a detail that is present but enclosed
 * looks identical to a detail that was never authored" — and case 19's rule is
 * the method: measure what is *present* and what is *missing* separately. So
 * this rasterises the real pump from the real capture camera and reports the
 * visible pixel count of each labelled nozzle primitive. A part with 0 visible
 * pixels is authored, correct, and worth nothing, and no amount of reshaping
 * it will change that.
 *
 * It is a z-buffer rasteriser rather than a raycaster for a boring reason:
 * 94k triangles against a 1600x900 grid of rays is a few billion intersection
 * tests, and projecting 94k triangles is a few million. Same answer.
 *
 * CPU only. No GPU, no browser, no capture. It cannot tell you whether a
 * visible part is *legible* — that is a question about tone and contrast and
 * it needs pixels off a real render. It can only tell you whether the part is
 * in the frame at all, which is the question that was being guessed at.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { PNG } from "pngjs";
import { buildPump, pumpVariation, nozzlePartsStowed } from "../src/gen/pumpParts.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};

const WIDTH = 1600;
const HEIGHT = 900;

/**
 * The poses that frame the nozzle, copied from `tools/shoot3.mjs`.
 *
 * `nozzle` is anchored: the camera sits `offset` from the centre of the
 * nozzle's *rendered extent*, which is what `shoot3` computes by walking the
 * mesh bounding boxes. Reproduced here rather than approximated, because a
 * pose that is nearly the capture's pose answers a question nobody asked.
 */
const POSES = {
  nozzle: { anchor: "nozzle", offset: [-0.62, 0.06, -0.78], fov: 34 },
  pump_close: { world: [-2.66, null, 14.42], eye: 1.62, look: [-2.36, 1.62, 16.36], fov: 44 },
};

/* ------------------------------------------------------------------ */
/* a very small z-buffer                                               */
/* ------------------------------------------------------------------ */

function rasterise(entries, camera, w, h) {
  const depth = new Float32Array(w * h).fill(Infinity);
  const id = new Int32Array(w * h).fill(-1);
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  const a = new THREE.Vector4();
  const b = new THREE.Vector4();
  const c = new THREE.Vector4();
  const sx = new Float32Array(3);
  const sy = new Float32Array(3);
  const sw = new Float32Array(3);

  for (let e = 0; e < entries.length; e++) {
    const geo = entries[e].geo;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0), 1).applyMatrix4(vp);
      b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1), 1).applyMatrix4(vp);
      c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2), 1).applyMatrix4(vp);
      // Near-plane reject rather than clip. A triangle straddling the near
      // plane is dropped; at these framings nothing that matters does.
      if (a.w <= 1e-6 || b.w <= 1e-6 || c.w <= 1e-6) continue;
      const v = [a, b, c];
      for (let k = 0; k < 3; k++) {
        sx[k] = ((v[k].x / v[k].w) * 0.5 + 0.5) * w;
        sy[k] = (1 - ((v[k].y / v[k].w) * 0.5 + 0.5)) * h;
        sw[k] = v[k].w;
      }
      let x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
      let x1 = Math.min(w - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
      let y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
      let y1 = Math.min(h - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
      if (x1 < x0 || y1 < y0) continue;
      const ax = sx[0], ay = sy[0], bx = sx[1], by = sy[1], cx = sx[2], cy = sy[2];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const inv = 1 / area;
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          let l0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
          let l1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
          let l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          // Perspective-correct depth as view-space w, which is monotonic in
          // distance and is all a depth test needs.
          const iw = l0 / sw[0] + l1 / sw[1] + l2 / sw[2];
          const zz = 1 / iw;
          const o = y * w + x;
          if (zz < depth[o]) {
            depth[o] = zz;
            id[o] = e;
          }
        }
      }
    }
  }
  return { depth, id };
}

function boundsOf(geos) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const g of geos) {
    g.computeBoundingBox();
    tmp.copy(g.boundingBox);
    box.union(tmp);
  }
  return box;
}

/* ------------------------------------------------------------------ */

function run(seed, face, poseName, pngOut) {
  const vary = pumpVariation(seed);
  const build = buildPump(seed);
  const parts = nozzlePartsStowed(face, vary);

  // Everything that is not this nozzle is a potential occluder, including the
  // *other* face's nozzle. Merging them into one entry is deliberate: the
  // question is "what hides the trigger", and the answer is only interesting
  // at part granularity on the near side.
  const occluders = [];
  for (const k of ["steel", "steelDark", "seam", "lip", "trim", "accent", "plastic", "keys", "chrome", "glass", "topper"]) {
    if (build[k]) occluders.push(build[k]);
  }
  for (const d of build.displays) occluders.push(d.geo);
  for (const d of build.topperFaces) occluders.push(d.geo);
  for (const d of build.keypadFaces) occluders.push(d.geo);
  for (const d of build.hoses) occluders.push(d.geo);
  for (const n of build.nozzles) {
    if (n.side === face) continue;
    occluders.push(n.body, n.metal, n.rubber);
  }

  const entries = parts.map((p) => ({ label: p.label, geo: p.geo, mine: true }));
  const firstOccluder = entries.length;
  for (const g of occluders) entries.push({ label: "pump (occluder)", geo: g, mine: false });

  const camera = new THREE.PerspectiveCamera(POSES[poseName].fov, WIDTH / HEIGHT, 0.05, 200);
  const pose = POSES[poseName];
  let look;
  if (pose.anchor === "nozzle") {
    const box = boundsOf(parts.map((p) => p.geo));
    const centre = box.getCenter(new THREE.Vector3());
    look = centre;
    camera.position.set(centre.x + pose.offset[0], centre.y + pose.offset[1], centre.z + pose.offset[2]);
  } else {
    // Absolute world poses need the pump's own placement undone. Only the
    // anchored pose is supported for now; anything else would be guessing at
    // the island height field, which is exactly what anchoring exists to avoid.
    throw new Error(`pose "${poseName}" is not anchored and this tool has no world transform`);
  }
  camera.up.set(0, 1, 0);
  camera.lookAt(look);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  const { id } = rasterise(entries, camera, WIDTH, HEIGHT);

  const counts = new Int32Array(entries.length);
  for (let i = 0; i < id.length; i++) if (id[i] >= 0) counts[id[i]]++;

  // Roll the labelled parts up by name, and separately count how many pixels
  // each part would win with nothing else in the scene. The pair is the whole
  // point: "0 visible of 4180 unoccluded" is a different defect from
  // "0 visible of 3", and they need opposite fixes.
  const alone = rasterise(entries.slice(0, firstOccluder), camera, WIDTH, HEIGHT);
  const aloneCounts = new Int32Array(firstOccluder);
  for (let i = 0; i < alone.id.length; i++) if (alone.id[i] >= 0) aloneCounts[alone.id[i]]++;

  const byLabel = new Map();
  for (let e = 0; e < firstOccluder; e++) {
    const L = entries[e].label;
    const rec = byLabel.get(L) ?? { visible: 0, alone: 0 };
    rec.visible += counts[e];
    rec.alone += aloneCounts[e];
    byLabel.set(L, rec);
  }

  const totalMine = [...byLabel.values()].reduce((s, r) => s + r.visible, 0);
  console.log(
    `\nseed ${seed}  face ${face > 0 ? "+Z north" : "-Z south"}  pose ${poseName}  ${WIDTH}x${HEIGHT} fov ${pose.fov}`
  );
  console.log(`nozzle occupies ${totalMine} px of the frame (${((100 * totalMine) / (WIDTH * HEIGHT)).toFixed(2)}%)\n`);
  console.log("part               visible   unoccluded   hidden");
  const rows = [...byLabel.entries()].sort((p, q) => q[1].alone - p[1].alone);
  const dead = [];
  for (const [L, r] of rows) {
    const hidden = r.alone > 0 ? (100 * (1 - r.visible / r.alone)).toFixed(0) + "%" : "-";
    console.log(`${L.padEnd(17)} ${String(r.visible).padStart(7)}   ${String(r.alone).padStart(10)}   ${hidden.padStart(6)}`);
    if (r.alone >= 60 && r.visible === 0) dead.push(L);
  }
  if (dead.length) {
    console.log(
      `\n!! ${dead.length} part(s) authored, sized to be seen, and completely hidden: ${dead.join(", ")}` +
        `\n   These are not missing geometry. Reshaping them cannot help; only moving what is in front of them can.`
    );
  }

  if (pngOut) {
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    const hue = (n) => {
      const h = ((n * 0.61803398875) % 1) * 6;
      const i = Math.floor(h);
      const f = h - i;
      const q = [
        [1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f],
      ][i % 6];
      return q;
    };
    for (let i = 0; i < id.length; i++) {
      const e = id[i];
      let r = 18, g = 18, b = 22;
      if (e >= firstOccluder) { r = 60; g = 60; b = 60; }
      else if (e >= 0) {
        const key = rows.findIndex(([L]) => L === entries[e].label);
        const c = hue(key + 1);
        r = 40 + c[0] * 205; g = 40 + c[1] * 205; b = 40 + c[2] * 205;
      }
      png.data[i * 4] = r;
      png.data[i * 4 + 1] = g;
      png.data[i * 4 + 2] = b;
      png.data[i * 4 + 3] = 255;
    }
    const dest = path.isAbsolute(pngOut) ? pngOut : path.join(ROOT, pngOut);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, PNG.sync.write(png));
    console.log(`\nid map -> ${path.relative(ROOT, dest)}  (grey = rest of pump, coloured = nozzle parts in table order)`);
  }
  return { byLabel, dead };
}

/**
 * A probe that cannot fail is not evidence (NOTES, seed-set assertion).
 *
 * Two planted cases through the same rasteriser: a quad that must be fully
 * visible, and the same quad with a larger one in front of it, which must
 * report zero visible and non-zero unoccluded. If the second one ever reports
 * visible pixels the occlusion test is broken and every "hidden" verdict above
 * is worthless.
 */
function selftest() {
  const quad = (z, s) => {
    const g = new THREE.PlaneGeometry(s, s);
    g.translate(0, 0, z);
    return g;
  };
  const cam = new THREE.PerspectiveCamera(34, WIDTH / HEIGHT, 0.05, 200);
  cam.position.set(0, 0, 2);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

  const back = [{ geo: quad(0, 0.2) }];
  const withFront = [{ geo: quad(0, 0.2) }, { geo: quad(1.0, 0.6) }];
  const r1 = rasterise(back, cam, WIDTH, HEIGHT);
  let aloneN = 0;
  for (const v of r1.id) if (v === 0) aloneN++;
  const r2 = rasterise(withFront, cam, WIDTH, HEIGHT);
  let occN = 0;
  for (const v of r2.id) if (v === 0) occN++;
  const ok = aloneN > 1000 && occN === 0;
  console.log(`selftest: unoccluded quad ${aloneN} px (want > 1000), same quad behind a larger one ${occN} px (want 0)`);
  console.log(ok ? "selftest PASS" : "selftest FAIL — occlusion or projection is broken; ignore every result above");
  process.exit(ok ? 0 : 1);
}

if (argv.includes("--selftest")) selftest();
else {
  const seeds = (arg("seed", "1,2,3")).split(",").map(Number);
  const face = Number(arg("face", "-1"));
  const pose = arg("pose", "nozzle");
  const png = arg("png", "");
  for (const s of seeds) run(s, face, pose, seeds.length === 1 ? png : png ? png.replace(/\.png$/, `_${s}.png`) : "");
}
