#!/usr/bin/env node
/**
 * CPU-side measurement of System 3 geometry. No bundler, no browser, no GPU.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpprobe.mjs
 *
 * Everything here answers a dimensional question that a screenshot answers
 * slowly and badly: how far apart are the three dispensers actually varied,
 * where does each hose's belly fall, and are the six bollards dented in the
 * same two places. NOTES.md case 16 is the reason the first two exist; the
 * bollard lobes are the defect the RNG audit found and left for this system.
 */

import * as THREE from "three";
import { BOLLARD_H, BOLLARD_R, buildBollard, buildPump, NOZZLE, PUMP, pumpVariation } from "../src/gen/pumpParts.ts";
import { hangingHose } from "../src/gen/hardsurface.ts";
import { seededRng } from "../src/gen/noise.ts";

const f = (v, n = 3) => v.toFixed(n);
const tris = (g) => Math.round(g.index ? g.index.count / 3 : g.attributes.position.count / 3);
const deg = (r) => (r * 180) / Math.PI;
const spread = (a) => Math.max(...a) - Math.min(...a);

/** Circular spread of a set of angles, in degrees: the smallest arc holding them. */
function circSpreadDeg(angles) {
  const a = angles.map((x) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((p, q) => p - q);
  let best = Math.PI * 2;
  for (let i = 0; i < a.length; i++) {
    const gap = (a[(i + 1) % a.length] - a[i] + Math.PI * 2) % (Math.PI * 2);
    best = Math.min(best, Math.PI * 2 - gap);
  }
  return deg(best);
}

/**
 * Build all three dispensers first, on the CPU.
 *
 * `mergeChecked` throws on a mismatched merge list, and NOTES.md case 8 is a
 * merge failure inside `buildPump` that went unnoticed for an hour because
 * nobody loaded the page. Catching it here costs under a second; catching it
 * in a capture costs a four-minute build first.
 */
console.log("=== build ===");
for (const seed of [1, 2, 3]) {
  const b = buildPump(seed);
  const slots = ["steel", "steelDark", "trim", "accent", "plastic", "keys", "chrome", "glass", "topper"];
  const parts = slots.map((s) => `${s}=${tris(b[s])}`);
  const hose = b.hoses.reduce((a, h) => a + tris(h.geo), 0);
  const nz = b.nozzles.reduce((a, n) => a + tris(n.body) + tris(n.metal) + tris(n.rubber), 0);
  // The printed faces are the only thing carrying 0..1 UVs; if a refactor ever
  // routes them through `metreUv` with the merged body they silently vanish
  // into a single tiled texel, so count them here as well as the box behind.
  const tf = b.topperFaces.reduce((a, t) => a + tris(t.geo), 0);
  console.log(`  pump-${seed} ${parts.join(" ")} topperFaces=${tf} hoses=${hose} nozzles=${nz}`);
}

{
  const b = buildPump(1);
  const ranges = b.topperFaces.map((t) => {
    const uv = t.geo.getAttribute("uv");
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < uv.count * uv.itemSize; i++) {
      lo = Math.min(lo, uv.array[i]);
      hi = Math.max(hi, uv.array[i]);
    }
    return `${t.side > 0 ? "+Z" : "-Z"} uv ${f(lo, 2)}..${f(hi, 2)}`;
  });
  const bad = ranges.some((r) => !r.endsWith("0.00..1.00"));
  console.log(`  topper face UVs: ${ranges.join("   ")}${bad ? "   <-- NOT 0..1, the sign will not read" : ""}`);
}

console.log("\n=== per-unit variation (pumpVariation, seeds 1..3) ===");
const varies = [1, 2, 3].map((s) => ({ seed: s, ...pumpVariation(s) }));
for (const v of varies) {
  console.log(
    `  pump-${v.seed}  hoseLen=${f(v.hoseLen)} m  hoseSeed=${String(v.hoseSeed).padStart(4)}  ` +
      `rake=${f(deg(v.nozzleRake), 2)} deg  wear=${f(v.wear, 2)}  scuff=${f(v.scuff, 2)}  ` +
      `tint=${f(v.tint, 2)}  streakY=${f(v.streakY)}`
  );
}
{
  const lens = varies.map((v) => v.hoseLen);
  const rakes = varies.map((v) => v.nozzleRake);
  console.log(
    `  hoseLen spread ${f(spread(lens) * 1000, 1)} mm of 260 mm authored ` +
      `(${f((spread(lens) / 0.26) * 100, 1)}%)   rake spread ${f(deg(spread(rakes)), 2)} deg of ` +
      `${f(deg(0.14), 2)} deg (${f((spread(rakes) / 0.14) * 100, 1)}%)`
  );
}

/* ------------------------------------------------------------------ */

console.log("\n=== hose catenary, all six faces ===");
/**
 * Rebuilds the same curve `buildPump` builds, then measures it. Kept in step
 * with pumpParts by construction: any change to the swivel or inlet placement
 * there has to be mirrored here, and the sanity check is that the endpoints
 * come out where the hardware is.
 */
function faceHose(seed, face) {
  const vary = pumpVariation(seed);
  const bx = face * PUMP.bootX;
  const sx = Math.sign(bx) || 1;
  const swivel = new THREE.Vector3(sx * (PUMP.cabW / 2 + 0.196), PUMP.hoseY - 0.02, face * 0.13);
  const swivelDir = new THREE.Vector3(sx * 0.92, -0.3, face * 0.24).normalize();

  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(vary.nozzleRake, face === 1 ? 0 : Math.PI, 0, "YXZ")
  );
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(bx, PUMP.bootY + 0.075, (face * PUMP.headD) / 2 + face * 0.07 + face * 0.004),
    q,
    new THREE.Vector3(1, 1, 1)
  );
  const inlet = new THREE.Vector3(0, 0.32, -0.1).applyMatrix4(m);
  const inletDir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

  const curve = hangingHose(swivel, swivelDir, inlet, inletDir, vary.hoseLen, {
    seed: vary.hoseSeed + (face === 1 ? 7 : 19),
    nozzleLoad: 0.085,
    stiffness: 0.15,
  });
  return { curve, swivel, inlet, vary };
}

const kinkPhases = [];
for (const seed of [1, 2, 3]) {
  for (const face of [1, -1]) {
    const { curve, swivel, inlet } = faceHose(seed, face);
    const N = 400;
    const pts = [];
    for (let i = 0; i <= N; i++) pts.push(curve.getPoint(i / N));

    // Arc length as built, versus the slack length asked for.
    let arc = 0;
    for (let i = 1; i <= N; i++) arc += pts[i].distanceTo(pts[i - 1]);

    // Where the belly falls, as a fraction of the run from swivel to inlet.
    let lowI = 0;
    for (let i = 1; i <= N; i++) if (pts[i].y < pts[lowI].y) lowI = i;
    const low = pts[lowI];
    const chord = swivel.distanceTo(inlet);
    // Fraction along the horizontal run, so 0.5 means "symmetric loop".
    const runV = new THREE.Vector3(inlet.x - swivel.x, 0, inlet.z - swivel.z);
    const runLen = runV.length();
    const along = runLen > 1e-6
      ? new THREE.Vector3(low.x - swivel.x, 0, low.z - swivel.z).dot(runV) / (runLen * runLen)
      : 0.5;
    const sag = Math.min(swivel.y, inlet.y) - low.y;

    // Out-of-plane wander: how far the curve leaves the vertical plane through
    // the two fittings. This is the kink term, and it is what stops the hose
    // reading as a flat bent conduit.
    const nrm = new THREE.Vector3(-runV.z, 0, runV.x).normalize();
    let maxLat = 0;
    for (const p of pts) {
      const d = Math.abs(new THREE.Vector3().subVectors(p, swivel).dot(nrm));
      if (d > maxLat) maxLat = d;
    }

    kinkPhases.push(seededKinkPhase(seed, face));
    console.log(
      `  pump-${seed} face ${face > 0 ? "+Z" : "-Z"}  slack=${f(faceHose(seed, face).vary.hoseLen)} ` +
        `arc=${f(arc)} chord=${f(chord)}  low at ${f(along, 2)} of run  sag=${f(sag * 1000, 0)} mm  ` +
        `lateral=${f(maxLat * 1000, 0)} mm`
    );
  }
}
console.log(`  kink phase circular spread across all six: ${f(circSpreadDeg(kinkPhases), 1)} deg of 360`);

/**
 * The first draw `hangingHose` takes, which sets the primary kink phase. Uses
 * the same `seededRng` the real code does rather than reimplementing it, so
 * the probe cannot pass while the shipping path is on the biased generator.
 */
function seededKinkPhase(seed, face) {
  const vary = pumpVariation(seed);
  return seededRng(vary.hoseSeed + (face === 1 ? 7 : 19))() * Math.PI * 2;
}

/* ------------------------------------------------------------------ */

console.log("\n=== bollards ===");
console.log(
  `  stock: r=${f(BOLLARD_R)} -> dia ${f(BOLLARD_R * 2 * 1000, 0)} mm, heights ` +
    `${f(BOLLARD_H, 2)}/${f(BOLLARD_H + 0.02, 2)}/${f(BOLLARD_H + 0.04, 2)} m  ` +
    `slenderness h/d = ${f((BOLLARD_H + 0.02) / (BOLLARD_R * 2), 2)}  (target 4.5-5, a pole is 6+)`
);

/**
 * Recovers where each post is actually dented by measuring the built mesh, not
 * by reading the source: radial deviation from nominal per angle, plus — the
 * number that decides whether anyone will see it — the largest change in
 * surface normal between neighbouring columns.
 *
 * NOTES.md case 9 is the reason the second number exists. The car's creases
 * moved 47,093 pixels in a forced diff and a critic still reported no feature
 * lines, because the panels either side of them differed by 3.3 degrees. Depth
 * is not the quantity that makes a dent read; the angle between the metal on
 * each side of it is.
 */
function dentProfile(seed, height) {
  const { skin, lean: trueLean } = buildBollard(height, seed);
  const pos = skin.getAttribute("position");
  const nrm = skin.getAttribute("normal");
  const bins = 96;
  const depth = new Float64Array(bins).fill(0);
  // Mean outward normal per angular column, taken over the dented height band.
  const nx = new Float64Array(bins);
  const nz = new Float64Array(bins);
  const cnt = new Float64Array(bins);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  // Undo the post's lean before measuring anything radial.
  //
  // `buildBollard` tilts the whole sleeve 1.2-2.6 degrees off plumb. Radius
  // taken about the world Y axis then picks up the lean as a sinusoid worth up
  // to `height * tilt` — about 40 mm on a 0.94 m post, which is twice the depth
  // of the dents this function exists to measure. The first run after the lean
  // landed reported 60 mm dents that are authored at 24 mm, i.e. the instrument
  // was reading the feature it was supposed to be blind to.
  //
  // The lean is now undone with the exact rotation the builder reports. The
  // centroid fit below is computed only so its error can be printed: it was the
  // first attempt, and it is biased by the dents themselves — an inward dent
  // drags its band's centroid across, tilting the fit — so it came out 2.4 to
  // 4.7 degrees wrong on a 1.3 to 2.6 degree lean. Worse than useless: it
  // reported dent depths of 57-74 mm where the outline measurement, using the
  // exact inverse, reads 26 mm. Two instruments disagreeing by 2.5x is how you
  // find out one of them is estimating something it was told.
  const bands = 24;
  const bcx = new Float64Array(bands);
  const bcz = new Float64Array(bands);
  const bcy = new Float64Array(bands);
  const bcn = new Float64Array(bands);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.y > height - 0.01 || v.y < 0.01) continue;
    const b = Math.min(bands - 1, Math.floor((v.y / height) * bands));
    bcx[b] += v.x;
    bcz[b] += v.z;
    bcy[b] += v.y;
    bcn[b]++;
  }
  let sy = 0, sx = 0, sz = 0, syy = 0, syx = 0, syz = 0, sn = 0;
  for (let b = 0; b < bands; b++) {
    if (!bcn[b]) continue;
    const y = bcy[b] / bcn[b];
    const x = bcx[b] / bcn[b];
    const z = bcz[b] / bcn[b];
    sn++; sy += y; sx += x; sz += z; syy += y * y; syx += y * x; syz += y * z;
  }
  const den = sn * syy - sy * sy;
  const fitX = den ? (sn * syx - sy * sx) / den : 0;
  const fitZ = den ? (sn * syz - sy * sz) / den : 0;
  const offX = (sx - fitX * sy) / sn;
  const offZ = (sz - fitZ * sy) / sn;
  const leanDeg = (Math.hypot(trueLean.x, trueLean.z) * 180) / Math.PI;
  const fitErrDeg =
    (Math.hypot(fitX - Math.tan(trueLean.z), fitZ + Math.tan(trueLean.x)) * 180) / Math.PI;
  // Exact inverse of rotateX(lean.x) then rotateZ(lean.z). Applied to positions
  // and normals alike, which a shear approximation cannot do correctly.
  const inv = new THREE.Matrix4()
    .makeRotationZ(-trueLean.z)
    .multiply(new THREE.Matrix4().makeRotationX(-trueLean.x));
  void offX;
  void offZ;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(inv);
    // Cap vertices sit above the sleeve and are not dented; skip them.
    if (v.y > height - 0.01) continue;
    const r = Math.hypot(v.x, v.z);
    const a = (Math.atan2(v.z, v.x) + Math.PI * 2) % (Math.PI * 2);
    const b = Math.min(bins - 1, Math.floor((a / (Math.PI * 2)) * bins));
    const d = BOLLARD_R - r;
    if (d > depth[b]) depth[b] = d;
    // Same rotation on the normals. The lean turns every one of them by the
    // tilt, which is a sinusoid in angle and so inflates a max-minus-min swing
    // by twice the tilt — 5 degrees of free credit this number must not get.
    n.fromBufferAttribute(nrm, i).applyMatrix4(inv).normalize();
    // Only the struck band. `bollardDents` puts every impact between 0.18 and
    // 0.60 of the height; averaging a column's normal over the full post mixes
    // one dent's flank with 80% plain pipe, which drags the mean back to
    // radial and under-reports the swing by roughly the duty cycle. That is
    // the same dilution that would let a real feature look like a failing one.
    const ty = v.y / height;
    if (ty < 0.10 || ty > 0.70) continue;
    nx[b] += n.x;
    nz[b] += n.z;
    cnt[b]++;
  }

  let peak = 0;
  for (let i = 1; i < bins; i++) if (depth[i] > depth[peak]) peak = i;
  let peak2 = -1;
  for (let i = 0; i < bins; i++) {
    const sep = Math.abs(((i - peak + bins / 2 + bins) % bins) - bins / 2) * (360 / bins);
    if (sep < 40) continue;
    if (peak2 < 0 || depth[i] > depth[peak2]) peak2 = i;
  }

  // How far the surface turns away from where an undented pipe would face.
  //
  // Deliberately not the difference between neighbouring columns: that is a
  // curvature measure, and a smooth dish has low curvature everywhere while
  // still swinging the normal a long way in total. Case 9's measurement was
  // the mean normal of the panel on one side of the feature against the panel
  // on the other, across a finite separation, and that is what is reproduced
  // here — deviation from radial per column, then the swing from the most
  // inward-facing flank to the most outward-facing one.
  let maxDev = 0;
  let minDev = 0;
  for (let i = 0; i < bins; i++) {
    if (!cnt[i]) continue;
    const radial = ((i + 0.5) / bins) * Math.PI * 2;
    const face = Math.atan2(nz[i] / cnt[i], nx[i] / cnt[i]);
    const d = deg(Math.atan2(Math.sin(face - radial), Math.cos(face - radial)));
    if (d > maxDev) maxDev = d;
    if (d < minDev) minDev = d;
  }

  return {
    a1: (peak / bins) * 360,
    d1: depth[peak] * 1000,
    a2: (peak2 / bins) * 360,
    d2: depth[peak2] * 1000,
    breakDeg: maxDev - minDev,
    leanDeg,
    fitErrDeg,
  };
}

/**
 * The post's outline, band by band, which is what a viewer actually judges.
 *
 * A critic reported the bollards as "narrow at the base, swells outward through
 * the middle third, pinches at roughly two-thirds height, then flares again to
 * the dome — the profile of something that has inflated or slumped", and
 * crucially "no straight reference section anywhere". None of the dent numbers
 * above can detect that: they measure local features against the nominal
 * radius, and a post can pass every one of them while its overall outline
 * wanders. A real bollard is dead-straight cylindrical everywhere except at
 * localised concavities, so what has to be measured is the *envelope* — the
 * widest and narrowest the post gets at each height — and specifically whether
 * anywhere on it is straight.
 */
function silhouette(seed, height) {
  const { skin, lean } = buildBollard(height, seed);
  const pos = skin.getAttribute("position");
  const bands = 20;
  const hi = new Float64Array(bands).fill(-Infinity);
  const lo = new Float64Array(bands).fill(Infinity);
  const v = new THREE.Vector3();

  // Undo the exact lean the builder reports, rather than fitting it.
  //
  // The first version of this fitted an axis through per-band centroids. That
  // is biased by the very feature being measured: an inward dent removes
  // material from one side, dragging the centroid across, so the fitted axis
  // tilts and radii about it exceed nominal. It reported up to 10 mm of
  // outward bulge on a post clamped to 1.2 mm — i.e. it reported a defect that
  // had already been fixed, which is the same failure as NOTES.md case 18 one
  // level up. Inverse of rotateX(lean.x) then rotateZ(lean.z).
  const inv = new THREE.Matrix4()
    .makeRotationZ(-lean.z)
    .multiply(new THREE.Matrix4().makeRotationX(-lean.x));

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(inv);
    if (v.y > height - 0.01 || v.y < 0.01) continue;
    const b = Math.min(bands - 1, Math.floor((v.y / height) * bands));
    const r = Math.hypot(v.x, v.z);
    if (r > hi[b]) hi[b] = r;
    if (r < lo[b]) lo[b] = r;
  }
  return { hi, lo, bands };
}

console.log("\n  outline, per 5% height band. hi/lo = widest/narrowest radius, mm from nominal.");
console.log("  'straight' = both within +-1.5 mm, i.e. a section a viewer would call cylindrical.");
for (const seed of [3, 6]) {
  const height = BOLLARD_H + ((seed - 3) % 3) * 0.02;
  const s = silhouette(seed, height);
  const cells = [];
  let straight = 0;
  let maxOut = 0;
  for (let b = 0; b < s.bands; b++) {
    const dh = (s.hi[b] - BOLLARD_R) * 1000;
    const dl = (s.lo[b] - BOLLARD_R) * 1000;
    if (Math.abs(dh) <= 1.5 && Math.abs(dl) <= 1.5) straight++;
    maxOut = Math.max(maxOut, dh);
    cells.push(`${dh >= 0 ? "+" : ""}${dh.toFixed(0)}/${dl.toFixed(0)}`);
  }
  console.log(`  bollard seed=${seed}: ${cells.join(" ")}`);
  console.log(
    `    straight bands ${straight}/${s.bands} (${((straight / s.bands) * 100).toFixed(0)}%)   ` +
      `max bulge OUTSIDE nominal ${maxOut.toFixed(1)} mm  <- a real bollard's is 0`
  );
}

const lobes1 = [];
const lobes2 = [];
let worstBreak = Infinity;
for (let bi = 0; bi < 6; bi++) {
  const height = BOLLARD_H + (bi % 3) * 0.02;
  const p = dentProfile(3 + bi, height);
  lobes1.push((p.a1 * Math.PI) / 180);
  lobes2.push((p.a2 * Math.PI) / 180);
  worstBreak = Math.min(worstBreak, p.breakDeg);
  console.log(
    `  bollard-${bi + 1} seed=${3 + bi} h=${f(height, 2)}  lobe1 ${f(p.a1, 0).padStart(3)} deg / ` +
      `${f(p.d1, 1)} mm   lobe2 ${f(p.a2, 0).padStart(3)} deg / ${f(p.d2, 1)} mm   ` +
      `normal swing ${f(p.breakDeg, 1)} deg  lean ${f(p.leanDeg, 2)} deg ` +
      `(centroid fit would have been ${f(p.fitErrDeg, 2)} deg out)`
  );
}
console.log(
  `  lobe-1 circular spread ${f(circSpreadDeg(lobes1), 1)} deg   ` +
    `lobe-2 circular spread ${f(circSpreadDeg(lobes2), 1)} deg`
);
console.log("  (a spread near zero means every post on the forecourt is dented identically)");
console.log(
  `  weakest post's normal swing: ${f(worstBreak, 1)} deg  ` +
    `(case 9: a feature separating surfaces under ~10 deg apart reads as a tone change, not an edge)`
);

/* ------------------------------------------------------------------ */

console.log("\n=== nozzle ===");
console.log(
  `  scale ${f(NOZZLE.scale, 2)}  ->  overall ${f(0.6 * NOZZLE.scale * 1000, 0)} mm tip to butt ` +
    `(an OPW 11A-class unleaded nozzle is ~410 mm)`
);
console.log(
  `  handle dia ${f(0.032 * 2 * NOZZLE.scale * 1000, 0)} mm, spout dia ` +
    `${f(0.0102 * 2 * NOZZLE.scale * 1000, 0)} mm, guard rod dia ` +
    `${f(0.0095 * 2 * NOZZLE.scale * 1000, 0)} mm`
);
console.log(
  `  inlet at (0, ${f(NOZZLE.inlet.y)}, ${f(NOZZLE.inlet.z)}) in nozzle space, ` +
    `origin ${f(NOZZLE.originY)} m above PUMP.bootY`
);

/* ------------------------------------------------------------------ */

console.log("\n=== cabinet plan ===");
console.log(
  `  body ${f(PUMP.cabW)} x ${f(PUMP.cabD)} = ${f(PUMP.cabW / PUMP.cabD, 2)}:1   ` +
    `head ${f(PUMP.headW)} x ${f(PUMP.headD)} = ${f(PUMP.headW / PUMP.headD, 2)}:1   ` +
    `head oversail ${f((PUMP.headD - PUMP.cabD) * 500, 0)} mm per side`
);