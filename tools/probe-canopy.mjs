#!/usr/bin/env node
/**
 * CPU assertions over the canopy geometry. No GPU, no browser, no capture.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-canopy.mjs
 *
 * Four things, in order of how much they have cost this project:
 *
 *  1. **Finiteness.** Mandatory. A single NaN vertex anywhere poisons the
 *     shared PMREM and blacks out the scene for every agent, with no local
 *     symptom, and NOTES is explicit that source review is not a valid clearing
 *     method for this class. `tools/finitecheck.mjs`.
 *
 *  2. **Fascia winding.** The fascia is a swept ring, and whether a positive
 *     profile lateral points inward or outward depends on the path winding and
 *     the `flip` flag together. Get it wrong and the ring is inside out, which
 *     back-face culling turns into *nothing at all* rather than into something
 *     that looks wrong (NOTES case 33). Checked here by measuring the actual
 *     face normals on the -Z outer run.
 *
 *  3. **Interference.** The columns stand on the pump islands between the
 *     dispensers and the end bollards, and both of those belong to another
 *     system. Clearances are asserted rather than eyeballed.
 *
 *  4. **The proportions the brief specifies**, restated as numbers so a later
 *     change to the ground or the site plan that pushes the clear height out of
 *     range fails here instead of in a critic's frame.
 */

import * as THREE from "three";
import { assertFinite } from "./finitecheck.mjs";
import {
  CANOPY,
  buildColumn,
  buildFascia,
  buildFasciaStripe,
  buildFixtures,
  buildRoof,
  buildSoffit,
  canopyLevels,
  fixturePlan,
  islandTop,
  makeLensMap,
  makeSoffitLampMap,
  makeSoffitLightmap,
  slabTop,
} from "../src/gen/canopyParts.ts";
import {
  buildOverflowStains,
  buildScuppers,
  buildSignCabinets,
  buildSignFaces,
  scupperPlan,
  signPlan,
} from "../src/gen/canopyParts.ts";
import { TYPE, makeOverflowStain } from "../src/gen/canopySignage.ts";
import { makeContactShadow } from "../src/gen/contactShadow.ts";
import { FORECOURT, ISLAND, ISLANDS, groundHeight } from "../src/site.ts";

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

console.log("probe-canopy\n");

const lv = canopyLevels();
const plan = fixturePlan();
const shade = {
  columns: CANOPY.columns.map((c) => ({ x: c.x, z: c.z })),
  fixtures: plan.map((f) => ({ x: f.x, z: f.z })),
};

const parts = {
  soffit: buildSoffit(lv, shade),
  fascia: buildFascia(lv),
  stripe: buildFasciaStripe(lv),
  roof: buildRoof(lv),
};
const fx = buildFixtures(lv, plan);
const col = buildColumn(lv);
const scuppersG = scupperPlan(lv);
// Panel sizes declared here rather than built, because `makeCanopySignAtlas`
// needs a real `measureText` to derive the logo width and this process has no
// canvas. The generator refuses to run against a stub rather than silently
// producing a panel the artwork does not fit, so the numbers below are the
// probe's own and the sizing section checks them against `TYPE`.
const signPanels = { logo: { w: 3.87, h: 0.56 }, price: { w: 2.4, h: 0.5 }, plate: { w: 0.36, h: 0.36 } };
const signsG = signPlan(lv, signPanels);
Object.assign(parts, {
  housings: fx.housings,
  lenses: fx.lenses,
  shaft: col.shaft,
  base: col.base,
  scuppers: buildScuppers(scuppersG),
  stains: buildOverflowStains(lv, scuppersG),
  signFaces: buildSignFaces(signsG, () => [0, 0, 1, 1]),
  signCabs: buildSignCabinets(signsG),
});

/* ---------------- 1. finiteness ---------------- */
console.log("finiteness (mandatory — a NaN here blacks out the scene for every agent):");
for (const [name, g] of Object.entries(parts)) {
  let caught = null;
  try {
    assertFinite(g, `canopy ${name}`);
  } catch (e) {
    caught = e;
  }
  ok(`${name} is finite`, !caught, caught ? caught.message.split("\n")[1] ?? "" : "");
}
// The two maps too: a NaN reaching a Uint8Array becomes 0, not NaN, so the real
// check is that no texel came out of a bad expression as NaN before rounding.
for (const [name, t] of [
  ["lens map", makeLensMap()],
  ["soffit lightmap", makeSoffitLightmap(shade)],
  ["soffit lamp map", makeSoffitLampMap(shade)],
  ["overflow stain", makeOverflowStain(128)],
]) {
  const a = t.image.data;
  let bad = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++;
  ok(`${name} has no non-finite texel`, bad === 0, `${bad} bad of ${a.length}`);
}

/* ---------------- 2. fascia winding ---------------- */
console.log("\nfascia winding (an inside-out sweep draws nothing, it does not look wrong):");
{
  const g = parts.fascia;
  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  // Triangles on the -Z outer run, at band mid height. Their geometric normal
  // must point away from the deck centre, i.e. -Z.
  let sum = 0;
  let count = 0;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(pos, idx.getX(t));
    b.fromBufferAttribute(pos, idx.getX(t + 1));
    c.fromBufferAttribute(pos, idx.getX(t + 2));
    const cy = (a.y + b.y + c.y) / 3 - lv.soffitY;
    const cz = (a.z + b.z + c.z) / 3;
    const cx = (a.x + b.x + c.x) / 3;
    if (cy < 0.15 || cy > 0.6) continue;
    if (cz > CANOPY.minZ + 0.08 || Math.abs(cx) > 3) continue;
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    sum += n.z;
    count++;
  }
  ok("outer face of the -Z run has triangles", count > 8, `${count} triangles sampled`);
  ok("their geometric normal points away from the deck", count > 8 && sum / count < -0.9, `mean n.z = ${(sum / Math.max(count, 1)).toFixed(3)}`);

  // And the shipped vertex normals agree with the winding, since that is what
  // the shader actually uses.
  const nrm = g.getAttribute("normal");
  let vsum = 0;
  let vcount = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) - lv.soffitY;
    if (y < 0.2 || y > 0.55) continue;
    if (pos.getZ(i) > CANOPY.minZ + 0.05 || Math.abs(pos.getX(i)) > 3) continue;
    vsum += nrm.getZ(i);
    vcount++;
  }
  ok("shipped vertex normals agree", vcount > 4 && vsum / vcount < -0.9, `mean normal.z = ${(vsum / Math.max(vcount, 1)).toFixed(3)}`);
}

/* ---------------- the soffit bake ---------------- */
console.log("\nsoffit lightmap (the fix for a soffit measured at luma 27.9 over 40% of the frame):");
{
  const g = parts.soffit;
  const uv1 = g.getAttribute("uv1");
  // Without uv1, three falls back to `uv` for the lightMap. The soffit's uv is
  // in world metres, so the bake would tile thirteen times across the deck and
  // still look like a plausible panelled ceiling. Silent, and expensive.
  ok("the soffit carries a uv1 channel for the lightMap", !!uv1, uv1 ? `${uv1.count} verts` : "MISSING");
  if (uv1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < uv1.count * 2; i++) {
      lo = Math.min(lo, uv1.array[i]);
      hi = Math.max(hi, uv1.array[i]);
    }
    ok("uv1 spans 0..1 and does not wrap", lo >= -1e-6 && hi <= 1 + 1e-6, `${lo.toFixed(4)} .. ${hi.toFixed(4)}`);
  }

  const lm = makeSoffitLightmap(shade);
  const d = lm.image.data;
  let sum = 0;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += d[i];
    lo = Math.min(lo, d[i]);
    hi = Math.max(hi, d[i]);
  }
  const mean = sum / (d.length / 4);
  ok("the bake is not uniformly dark", mean > 40, `mean R = ${mean.toFixed(1)}`);
  // A bake with no range is a flat fill, which is what the soffit already had.
  ok("the bake has real range — pools and shadow, not a flat fill", hi - lo > 90, `R spans ${lo}..${hi}`);
  ok("the bake does not clip to white across the deck", mean < 200, `mean R = ${mean.toFixed(1)}`);
  // The map is 8-bit. A texel at 255 is a texel whose real value was thrown
  // away, and the perimeter gradient is exactly where that would happen.
  let clipped = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] >= 255) clipped++;
  const clipPct = (clipped / (d.length / 4)) * 100;
  ok("under 0.1% of the bake clips at 255", clipPct < 0.1, `${clipPct.toFixed(3)}% clipped`);
  ok("the lightmap is clamped, not wrapped", lm.wrapS === THREE.ClampToEdgeWrapping && lm.wrapT === THREE.ClampToEdgeWrapping);
  // Irradiance has no perceptual encoding. Tagging it sRGB puts a 2.2 curve on
  // a linear quantity, which is the colour-space convention in NOTES read
  // backwards.
  ok("the lightmap is linear, not tagged sRGB", lm.colorSpace === THREE.NoColorSpace, lm.colorSpace);

  /*
   * The split, and the assertion that would have caught the original defect.
   *
   * The lamp collar used to be summed into this bake. Both terms then rode
   * `lightMapIntensity`, which is proportional to `scene.environmentIntensity`
   * — so the lamps brightened when the sky did, and `setFixtures(false)` left
   * eight of them glowing. Neither symptom is visible in a single frame, and
   * neither is findable by grep, because the defect was two quantities sharing
   * one scalar rather than anything written down wrong.
   *
   * What makes it testable is that the two terms have different *shapes*. The
   * sky term depends only on distance to the deck edge; the lamp term only on
   * distance to a fixture. So sample the sky bake at a fixture and at a point
   * with the same edge distance that is far from every fixture: if the collar
   * is still in there, the fixture sample is brighter. This is the ranking
   * discipline applied to a texture — no absolute target, just two samples that
   * must agree.
   */
  const N = CANOPY.lightmapSize;
  const sampleR = (tex, size, x, z) => {
    const i = Math.min(size - 1, Math.max(0, Math.floor(((x - CANOPY.minX) / (CANOPY.maxX - CANOPY.minX)) * size)));
    const j = Math.min(size - 1, Math.max(0, Math.floor(((z - CANOPY.minZ) / (CANOPY.maxZ - CANOPY.minZ)) * size)));
    return tex.image.data[(j * size + i) * 4];
  };
  const edgeOf = (x, z) => Math.min(x - CANOPY.minX, CANOPY.maxX - x, z - CANOPY.minZ, CANOPY.maxZ - z);
  const nearestFixture = (x, z) => Math.min(...shade.fixtures.map((f) => Math.hypot(x - f.x, z - f.z)));

  const f0 = shade.fixtures[0];
  // Walk the iso-edge-distance contour of that fixture for the point furthest
  // from any fixture. Sweeping for the comparison point rather than naming one
  // keeps this honest if the fixture plan changes.
  let best = null;
  for (let t = 0; t < 2000; t++) {
    const x = CANOPY.minX + ((CANOPY.maxX - CANOPY.minX) * (t + 0.5)) / 2000;
    for (const z of [f0.z, CANOPY.minZ + edgeOf(f0.x, f0.z), CANOPY.maxZ - edgeOf(f0.x, f0.z)]) {
      if (Math.abs(edgeOf(x, z) - edgeOf(f0.x, f0.z)) > 0.05) continue;
      const dF = nearestFixture(x, z);
      if (!best || dF > best.dF) best = { x, z, dF };
    }
  }
  if (best && best.dF > 1.6) {
    const atLamp = sampleR(lm, N, f0.x, f0.z);
    const away = sampleR(lm, N, best.x, best.z);
    const ratio = atLamp / Math.max(1, away);
    ok(
      "the sky bake carries no lamp signal — same edge distance reads the same",
      ratio < 1.12,
      `at a fixture ${atLamp} vs ${away} ${best.dF.toFixed(2)} m away at equal edge distance, ratio ${ratio.toFixed(3)}`
    );
  } else {
    ok("a comparison point far from every fixture exists on the contour", false, `best separation ${best ? best.dF.toFixed(2) : "none"} m`);
  }

  const lampMap = makeSoffitLampMap(shade);
  const L = lampMap.image.width;
  {
    const atLamp = sampleR(lampMap, L, f0.x, f0.z);
    // Deck centre is the furthest a point on this layout gets from a housing.
    const cx = (CANOPY.minX + CANOPY.maxX) / 2;
    const cz = (CANOPY.minZ + CANOPY.maxZ) / 2;
    const atMid = sampleR(lampMap, L, cx, cz);
    ok("the lamp map is bright at a housing", atLamp > 90, `R = ${atLamp}`);
    // A lamp map that is bright everywhere is a fill, and would brighten the
    // whole soffit when the lamps came on rather than pooling at the fittings.
    ok("the lamp map falls away between housings", atMid < atLamp * 0.45, `${atMid} at deck centre vs ${atLamp} at a housing`);
    // Opposite answer to the lightMap beside it, on the same UVs, and that is
    // correct: emissive is a colour, irradiance is not.
    ok("the lamp map is tagged sRGB, unlike the bake", lampMap.colorSpace === THREE.SRGBColorSpace, lampMap.colorSpace);
    ok("the lamp map is clamped, not wrapped", lampMap.wrapS === THREE.ClampToEdgeWrapping);
    // `emissiveMap` defaults to `uv`, which on the soffit is a per-metre tiling
    // set. Sampling the lamp map with it would repeat eight collars in every
    // square metre of a 13 m deck.
    ok("the lamp map is bound to uv1, not the tiling uv set", CANOPY.lampMapChannel === 1, `channel ${CANOPY.lampMapChannel}`);

    /*
     * The collar has to be bright where it can be *seen*, which is outside the
     * fitting that occludes it.
     *
     * The first version had a 196 mm half-value radius under a housing whose
     * edge is at 310 mm, so its entire bright core was behind the object
     * casting it and only the tail ever reached a pixel. Measured contribution:
     * +3.4 luma over 23 000 pixels, which is authored-and-invisible.
     *
     * This is the delivered-pixel discipline in a different currency — energy
     * placed where nothing can look at it, rather than detail placed below the
     * resolution that could resolve it — and it needs its own assertion for the
     * reason case 43 gives: the rule existed, for type, and a rule written for
     * one thing does not cover the next thing.
     */
    const housingEdge = CANOPY.fixtureW / 2;
    const peak = sampleR(lampMap, L, f0.x, f0.z);
    const atEdge = sampleR(lampMap, L, f0.x + housingEdge + 0.05, f0.z);
    const atHalfMetreOut = sampleR(lampMap, L, f0.x + housingEdge + 0.5, f0.z);
    ok(
      "the collar is still strong just outside the housing that hides its core",
      atEdge > peak * 0.5,
      `${atEdge} at ${((housingEdge + 0.05) * 1000).toFixed(0)} mm vs peak ${peak} — ${((atEdge / peak) * 100).toFixed(0)}% of peak survives the occluder`
    );
    ok(
      "and it reaches out far enough to read as a halo rather than a rim",
      atHalfMetreOut > peak * 0.2,
      `${atHalfMetreOut} at ${((housingEdge + 0.5) * 1000).toFixed(0)} mm — ${((atHalfMetreOut / peak) * 100).toFixed(0)}% of peak`
    );
  }
}

/* the horizontal surfaces, by the same method rather than by inspection */
{
  const meanFaceNormalY = (g) => {
    const pos = g.getAttribute("position");
    const idx = g.getIndex();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();
    let s = 0;
    let k = 0;
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const len = n.length();
      if (len < 1e-9) continue;
      s += n.y / len;
      k++;
    }
    return s / k;
  };
  const sy = meanFaceNormalY(parts.soffit);
  const ry = meanFaceNormalY(parts.roof);
  ok("the soffit faces down, toward the player", sy < -0.85, `mean normal.y = ${sy.toFixed(3)}`);
  ok("the roof faces up, toward the sky", ry > 0.85, `mean normal.y = ${ry.toFixed(3)}`);
  // The lens is a closed box, so its mean face normal is 0 by construction and
  // means nothing. What matters is the one face the player sees: the bottom.
  // Selected by centroid within the lowest slice of the part's own height, so
  // it works for a bevelled box (which has no triangle sitting exactly at minY)
  // as well as for a flat plane.
  const bottomFaceNormalY = (g, name) => {
    const pos = g.getAttribute("position");
    const idx = g.getIndex();
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    const band = Math.max((maxY - minY) * 0.12, 1e-4);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();
    let s = 0;
    let k = 0;
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      if ((a.y + b.y + c.y) / 3 > minY + band) continue;
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const len = n.length();
      if (len < 1e-12) continue;
      // Area weighted: a bevel contributes many small triangles that should not
      // outvote the flat face they surround.
      s += n.y;
      k += len;
    }
    ok(`the ${name} bottom face points down at the player`, k > 0 && s / k < -0.9, `mean normal.y = ${(s / Math.max(k, 1)).toFixed(3)} over ${(k / 2).toFixed(2)} m2 of face`);
  };
  bottomFaceNormalY(parts.lenses, "lens");
  bottomFaceNormalY(parts.housings, "housing");
}

/* ---------------- 3. interference ---------------- */
console.log("\nclearance against systems this one does not own:");
{
  const half = CANOPY.colW / 2;
  // Dispensers: PumpSystem LAYOUT, cabinet 1.02 wide about each x.
  const pumps = [
    { x: -2.4, z: ISLANDS[0].cz },
    { x: 2.4, z: ISLANDS[0].cz },
    { x: 0.0, z: ISLANDS[1].cz },
  ];
  let worstPump = Infinity;
  for (const c of CANOPY.columns) {
    for (const p of pumps) {
      if (Math.abs(c.z - p.z) > 0.01) continue;
      worstPump = Math.min(worstPump, Math.abs(c.x - p.x) - half - 1.02 / 2);
    }
  }
  ok("columns clear the dispenser cabinets", worstPump > 0.15, `worst gap ${(worstPump * 1000).toFixed(0)} mm`);

  // Bollards: PumpSystem puts them at |x| = ISLAND.length/2 - 0.42, r ~= 0.084.
  const bx = ISLAND.length / 2 - 0.42;
  let worstBoll = Infinity;
  for (const c of CANOPY.columns) worstBoll = Math.min(worstBoll, Math.abs(bx - Math.abs(c.x)) - half - 0.084);
  ok("columns clear the end bollards", worstBoll > 0.1, `worst gap ${(worstBoll * 1000).toFixed(0)} mm`);

  // The base plinth must sit wholly on the island cap, or it needs Terrain.
  const pHalf = CANOPY.colBaseW / 2;
  let worstIsland = Infinity;
  for (const c of CANOPY.columns) {
    worstIsland = Math.min(worstIsland, ISLAND.width / 2 - (Math.abs(c.z - c.z) + pHalf));
    worstIsland = Math.min(worstIsland, ISLAND.length / 2 - (Math.abs(c.x) + pHalf));
  }
  ok(
    "every plinth sits wholly on the island cap (so Terrain is not involved)",
    worstIsland > 0,
    `worst margin ${(worstIsland * 1000).toFixed(0)} mm`
  );

  // The drip line must stay inside the concrete slab.
  const inset = Math.min(
    CANOPY.minX - FORECOURT.minX,
    FORECOURT.maxX - CANOPY.maxX,
    CANOPY.minZ - FORECOURT.minZ,
    FORECOURT.maxZ - CANOPY.maxZ
  );
  ok("the drip line falls on the concrete forecourt, not on asphalt", inset > 0.3, `worst inset ${inset.toFixed(2)} m`);
}

/* ---------------- 4. proportions ---------------- */
console.log("\nproportions the brief specifies:");
{
  const capMax = Math.max(...lv.capY);
  const clearOverSlab = [];
  for (const x of [CANOPY.minX, 0, CANOPY.maxX]) {
    for (const z of [CANOPY.minZ, 19.9, CANOPY.maxZ]) clearOverSlab.push(lv.soffitY - slabTop(x, z));
  }
  const lo = Math.min(...clearOverSlab);
  const hi = Math.max(...clearOverSlab);
  ok("clear height over the slab is 4.3-4.9 m everywhere", lo >= 4.3 && hi <= 4.9, `${lo.toFixed(2)} to ${hi.toFixed(2)} m`);
  ok(
    "clear height over the island cap stays over 4.3 m",
    lv.soffitY - capMax >= 4.3,
    `${(lv.soffitY - capMax).toFixed(2)} m`
  );

  const depth = CANOPY.copingH + CANOPY.dripDrop;
  ok("deck depth including fascia is 0.6-1.0 m", depth >= 0.6 && depth <= 1.0, `${depth.toFixed(3)} m`);

  // Overhang: does it actually shelter a vehicle? A sedan is ~1.84 m wide and
  // parks alongside the island, so the drip line has to clear the island face
  // by more than that plus a door.
  const shelter = Math.min(ISLANDS[0].cz - ISLAND.width / 2 - CANOPY.minZ, CANOPY.maxZ - ISLANDS[1].cz - ISLAND.width / 2);
  ok("the overhang shelters a parked vehicle", shelter > 2.4, `${shelter.toFixed(2)} m clear of the island face`);

  const endOverhang = CANOPY.maxX - ISLAND.length / 2;
  ok("the deck overhangs the island ends", endOverhang > 1.5, `${endOverhang.toFixed(2)} m`);
}

/* ---------------- 5. signage, in delivered pixels ---------------- */

/**
 * The type sizes are **declared here** rather than imported from the generator,
 * for the reason `tools/probe-signage.mjs` states: a probe that takes its
 * expectations from the thing it is checking cannot disagree with it. What is
 * imported is `TYPE`, and only so the two can be compared — if the artwork's
 * sizes and the probe's sizes drift apart, that fails loudly below and a person
 * decides which one is right, rather than the check quietly following the code.
 *
 * The thresholds come from two other systems' measurements tonight, not from
 * taste. Building: a 74-texel masthead delivered 19 screen pixels and read; a
 * body line delivered 3.9 and did not. Car: above roughly 50 delivered pixels,
 * an element that does not read has a contrast fault rather than a size fault.
 * So the bands used here are: **under 6 px, gone**; 6 to 14, a shape;
 * 14 to 50, reads as words; over 50, any failure is contrast.
 */
console.log("\nsignage, sized in delivered pixels rather than texels:");
{
  const DECLARED_MM = { wordmark: 380, "sub-line": 130, "price-numerals": 300, "plate-wordmark": 58 };
  const fromCode = { wordmark: TYPE.wordCap, "sub-line": TYPE.subCap, "price-numerals": TYPE.priceCap, "plate-wordmark": TYPE.plateCap };
  const drift = Object.keys(DECLARED_MM).filter((k) => DECLARED_MM[k] !== fromCode[k]);
  ok(
    "the artwork's type sizes still match the sizes this probe was written against",
    drift.length === 0,
    drift.length ? `drifted: ${drift.map((k) => `${k} ${DECLARED_MM[k]}->${fromCode[k]}mm`).join(", ")}` : ""
  );

  // Poses that matter for a fascia: the two where it is the subject. `soffit`
  // and `column_full` stand under the deck and see no fascia at all, so sizing
  // against them would be sizing against a pose that cannot fail.
  const H = 900;
  const POSES = [
    { name: "at_pump (fuelling, 1 m)", pos: [-2.66, 14.42], eye: 1.62, fov: 58 },
    { name: "sign (on the apron, 11 m)", pos: [-1.0, 2.2], eye: 1.62, fov: 50 },
    { name: "approach (crossing the lot, 15 m)", pos: [-13.0, 6.0], eye: 1.66, fov: 58 },
    { name: "road (from the highway, 34 m)", pos: [-2.0, -20.0], eye: 1.66, fov: 55 },
  ];

  const panels = {
    logo: { x: -1.55, y: lv.soffitY + CANOPY.fasciaH / 2, z: CANOPY.minZ },
    price: { x: 3.35, y: lv.soffitY + CANOPY.fasciaH / 2, z: CANOPY.minZ },
    plate: { x: CANOPY.columns[0].x - CANOPY.colW / 2, y: lv.capY[0] + 1.55, z: CANOPY.columns[0].z },
  };
  const of = { wordmark: "logo", "sub-line": "logo", "price-numerals": "price", "plate-wordmark": "plate" };

  const rows = [];
  for (const p of POSES) {
    const eyeY = groundHeight(p.pos[0], p.pos[1]) + p.eye;
    // Vertical pixels per metre at distance d, which is the axis a cap height
    // lives on. Horizontal foreshortening squashes glyph *widths* on an oblique
    // view and leaves cap height alone, so it is reported separately rather
    // than folded in — conflating the two is how a legible sign gets reported
    // as illegible when it is merely seen at an angle.
    const pxPerM = (d) => H / (2 * d * Math.tan((p.fov * Math.PI) / 360));
    for (const [el, mm] of Object.entries(DECLARED_MM)) {
      const t = panels[of[el]];
      const d = Math.hypot(t.x - p.pos[0], t.y - eyeY, t.z - p.pos[1]);
      const px = (mm / 1000) * pxPerM(d);
      // Obliquity of this fascia run, which faces -Z.
      const dx = t.x - p.pos[0];
      const dz = t.z - p.pos[1];
      const cos = of[el] === "plate" ? Math.abs(dx) / Math.hypot(dx, dz) : Math.abs(dz) / Math.hypot(dx, dz);
      const verdict = px < 6 ? "GONE" : px < 14 ? "shape only" : px < 50 ? "reads" : "reads; any fault is contrast";
      rows.push(
        `  ${p.name.padEnd(34)} ${el.padEnd(15)} ${d.toFixed(1).padStart(5)} m  ${px.toFixed(1).padStart(6)} px  ` +
          `width x${cos.toFixed(2)}  ${verdict}`
      );
    }
  }
  console.log(rows.join("\n"));

  // The gates. The wordmark is the element that carries identification, so it
  // has to read from the lot; the mark carries the brand from the road, where
  // the wordmark is only a shape; and the plate is read from arm's length and
  // would be absurd if it were sized for the road.
  const pxAt = (mm, target, p) => {
    const eyeY = groundHeight(p.pos[0], p.pos[1]) + p.eye;
    const d = Math.hypot(target.x - p.pos[0], target.y - eyeY, target.z - p.pos[1]);
    return (mm / 1000) * (H / (2 * d * Math.tan((p.fov * Math.PI) / 360)));
  };
  const wordAtApproach = pxAt(DECLARED_MM.wordmark, panels.logo, POSES[2]);
  ok("the wordmark reads from across the lot (>= 14 px)", wordAtApproach >= 14, `${wordAtApproach.toFixed(1)} px`);
  const markAtRoad = pxAt(TYPE.markH, panels.logo, POSES[3]);
  ok("the mark is still a shape from the road (>= 6 px)", markAtRoad >= 6, `${markAtRoad.toFixed(1)} px`);
  // Gated from `at_pump` and not from a fascia pose. The first version of this
  // check measured the plate from the apron 15 m away, reported 3.8 px and
  // failed — a true number about a pose from which nobody reads a 360 mm plate
  // screwed to a column. **An element has to be sized against the pose it is
  // actually read from, and different elements on one system have different
  // ones**; a single pose list applied to every element silently imports the
  // fascia's viewing distance into a decision about a hand-height plate.
  const plateAtPump = pxAt(DECLARED_MM["plate-wordmark"], panels.plate, POSES[0]);
  ok("the column plate reads where it is actually read (>= 14 px)", plateAtPump >= 14, `${plateAtPump.toFixed(1)} px`);

  // Texel supply, which is the other half: delivered pixels above the texels
  // backing them is magnification, and magnification of type is mush no matter
  // how large the delivered figure looks.
  const logoTexPerM = 256 / (TYPE.logoPanelH / 1000);
  const wordTexels = (DECLARED_MM.wordmark / 1000) * logoTexPerM;
  const worstDelivered = pxAt(DECLARED_MM.wordmark, panels.logo, POSES[1]);
  ok(
    "the wordmark has more texels than it ever delivers pixels",
    wordTexels >= worstDelivered,
    `${wordTexels.toFixed(0)} texels vs ${worstDelivered.toFixed(0)} px at the closest pose`
  );
}

/* ---------------- 6. drainage ---------------- */
console.log("\ndrainage (a route, or a decoration):");
{
  const sc = scupperPlan(lv);
  ok("there are overflow scuppers at all", sc.length > 0, `${sc.length}`);
  // At gutter level, which is the roof, not somewhere convenient on the band.
  const belowRoof = sc.map((s) => lv.roofY - s.y);
  ok(
    "scupper mouths sit within 150 mm below the roof surface",
    Math.min(...belowRoof) > 0 && Math.max(...belowRoof) <= 0.15,
    `${(Math.min(...belowRoof) * 1000).toFixed(0)}-${(Math.max(...belowRoof) * 1000).toFixed(0)} mm`
  );
  ok(
    "the mouths are above the accent stripe, so the streak crosses it",
    sc.every((s) => s.y > lv.soffitY + 0.452),
    ""
  );
  // The stain has to reach the drip line or it reads as a mark that stops in
  // mid air, which is the one thing a real streak never does.
  const stains = buildOverflowStains(lv, sc);
  const sp = stains.getAttribute("position").array;
  let stainLow = Infinity;
  for (let i = 1; i < sp.length; i += 3) stainLow = Math.min(stainLow, sp[i]);
  ok("the stains run past the drip lip", stainLow <= lv.dripY, `lowest ${stainLow.toFixed(3)} vs drip ${lv.dripY.toFixed(3)}`);

  // The scuppers and the stains must clear the fascia's battered face, or they
  // are buried behind the surface they are supposed to be marking (case 33).
  let minStandoff = Infinity;
  for (let i = 0; i < sp.length; i += 3) {
    const y = sp[i + 1];
    const t = Math.max(0, Math.min(1, (y - lv.soffitY) / CANOPY.fasciaH));
    const faceZ = CANOPY.minZ + CANOPY.batter * t;
    if (Math.abs(sp[i + 2] - CANOPY.minZ) < 1.0) minStandoff = Math.min(minStandoff, faceZ - sp[i + 2]);
  }
  ok("every stain vertex stands proud of the battered face", minStandoff > 0, `worst ${(minStandoff * 1000).toFixed(1)} mm`);

  const disch = CANOPY.columns.length;
  ok("every column takes a downpipe", disch === 4, `${disch}`);

  /*
   * Contact occlusion at the column feet, adopted from Car's shared builder.
   *
   * Checked here at all because `probe-rank` structurally cannot see this
   * defect: it ranks *surfaces*, and a missing contact shadow is not a surface.
   * The column bases read 57.1 with p10 25 in a correctly ordered table, which
   * says the base is toned right and says nothing about whether it is standing
   * on anything.
   */
  console.log("\ncontact occlusion (a missing one is not a surface, so probe-rank cannot see it):");
  const cHalf = CANOPY.colBaseW / 2;
  const cReach = 0.045;
  const cSpan = CANOPY.colBaseW + 2 * cReach;
  const cRes = Math.round(cSpan / (cReach / 2));
  const c0 = CANOPY.columns[0];
  const built = makeContactShadow({
    occluders: [{ x: c0.x, z: c0.z, hx: cHalf, hz: cHalf, gap: 0 }],
    groundY: (x, z) => islandTop(x, z),
    res: cRes,
    // The module requires this and does not default it, so that a borrowing of
    // Lighting's environment cannot be inherited silently. The probe passes
    // Lighting's current value explicitly; the geometry checks below are all
    // shape checks and are unaffected by it, but leaving it out would not
    // compile and that is the point of the parameter.
    environmentIntensity: 2.4,
  });
  ok("the builder returned geometry", !!built);
  const cGeo = built.geometry;
  const cPos = cGeo.attributes.position.array;
  const cCol = cGeo.attributes.color;
  ok(
    "the decal carries a 4-wide colour attribute, which is where the falloff lives",
    cCol.itemSize === 4,
    `itemSize ${cCol.itemSize}`
  );
  let cBad = 0;
  for (let i = 0; i < cPos.length; i++) if (!Number.isFinite(cPos[i])) cBad++;
  for (let i = 0; i < cCol.array.length; i++) if (!Number.isFinite(cCol.array[i])) cBad++;
  ok("no non-finite vertex or alpha", cBad === 0, `${cBad} bad`);

  /*
   * The assertion this block exists for.
   *
   * The falloff is 45 mm and the pad is 640 mm, so a uniform grid spends most
   * of its cells under the plinth, and the temptation is to coarsen it. The
   * trap is *where* the coarsening lands: at 30 mm cells the nearest sample to
   * the contact line is 15 mm outside the pad, so the darkest value the eye ever
   * receives is 0.45 of the peak and **the near-black core ends up beneath the
   * object casting it.** That is this round's lamp-collar defect in a second
   * currency, one hour later, and the general rule is that a peak is worth
   * nothing unless a sample lands where it can be seen.
   *
   * So find the darkest sample that is genuinely outside the pad and require it
   * near the peak. This fails on any grid too coarse to put a vertex at the
   * contact line, whatever the reason for the coarsening was.
   */
  const dOut = (i) => {
    const dx = Math.max(0, Math.abs(cPos[i * 3] - c0.x) - cHalf);
    const dz = Math.max(0, Math.abs(cPos[i * 3 + 2] - c0.z) - cHalf);
    return Math.hypot(dx, dz);
  };
  let peakAny = 0;
  for (let i = 0; i < cCol.count; i++) peakAny = Math.max(peakAny, cCol.array[i * 4 + 3]);

  /*
   * Sampled through the interpolant, not off the vertices, and the first
   * version of this check got that wrong in a way worth leaving recorded.
   *
   * It asked for the darkest *vertex* outside the pad and failed at 0.200
   * against a peak of 0.780. That reading was true and the conclusion drawn
   * from it was false. With a 22.8 mm cell the vertex nearest the contact line
   * lands 0.6 mm *inside* the pad, so the darkest visible vertex is a whole cell
   * out — but the quad between them straddles the pad edge, and the renderer
   * interpolates across it, so the ground immediately outside the plinth does
   * receive very nearly the peak. Nothing was buried.
   *
   * **A grid's rendered value at a point is a property of the interpolant, not
   * of the nearest sample**, and an assertion written against the samples
   * measures something the viewer never sees. Reaching for a much finer grid on
   * the strength of the first number would have cost 32 000 triangles to fix a
   * defect that was not there — which is the expensive direction of the same
   * mistake this probe exists to prevent.
   */
  let gx0 = Infinity;
  let gx1 = -Infinity;
  let gz0 = Infinity;
  let gz1 = -Infinity;
  for (let i = 0; i < cCol.count; i++) {
    gx0 = Math.min(gx0, cPos[i * 3]);
    gx1 = Math.max(gx1, cPos[i * 3]);
    gz0 = Math.min(gz0, cPos[i * 3 + 2]);
    gz1 = Math.max(gz1, cPos[i * 3 + 2]);
  }
  const gN = Math.round(Math.sqrt(cCol.count)) - 1;
  const alphaAt = (x, z) => {
    const u = ((x - gx0) / (gx1 - gx0)) * gN;
    const v = ((z - gz0) / (gz1 - gz0)) * gN;
    const i0 = Math.max(0, Math.min(gN - 1, Math.floor(u)));
    const j0 = Math.max(0, Math.min(gN - 1, Math.floor(v)));
    const fu = u - i0;
    const fv = v - j0;
    const at = (i, j) => cCol.array[(j * (gN + 1) + i) * 4 + 3];
    return (
      at(i0, j0) * (1 - fu) * (1 - fv) +
      at(i0 + 1, j0) * fu * (1 - fv) +
      at(i0, j0 + 1) * (1 - fu) * fv +
      at(i0 + 1, j0 + 1) * fu * fv
    );
  };
  ok(
    "the grid is square, so the sample above is addressing it correctly",
    (gN + 1) * (gN + 1) === cCol.count,
    `${gN + 1}^2 against ${cCol.count} vertices`
  );
  // 1 mm outside the pad, on the mid-edge: the first ground a viewer sees.
  const atContact = alphaAt(c0.x - cHalf - 0.001, c0.z);
  const atMid = alphaAt(c0.x - cHalf - cReach / 2, c0.z);
  ok(
    "the ground immediately outside the plinth renders near the peak, so the core is not buried",
    atContact > peakAny * 0.9,
    `${atContact.toFixed(3)} at 1 mm out against a peak of ${peakAny.toFixed(3)} — res ${cRes}, cell ${((cSpan / cRes) * 1000).toFixed(1)} mm`
  );
  ok(
    "and it is already well down by half the reach, so it is a contact line rather than a wash",
    atMid < atContact * 0.6,
    `${atMid.toFixed(3)} at ${((cReach / 2) * 1000).toFixed(0)} mm out against ${atContact.toFixed(3)} at the line`
  );
  let cFar = 0;
  for (let i = 0; i < cCol.count; i++) if (dOut(i) > cReach * 0.98) cFar = Math.max(cFar, cCol.array[i * 4 + 3]);
  ok("it decays to nothing by the end of its reach", cFar < 0.02, `${cFar.toFixed(4)} at ${(cReach * 1000).toFixed(0)} mm out`);

  // Up, not down. A decal wound downward is back-face culled into nothing.
  const cIdx = cGeo.index.array;
  let cNy = 0;
  for (let t = 0; t < cIdx.length; t += 3) {
    const a = cIdx[t];
    const b = cIdx[t + 1];
    const d = cIdx[t + 2];
    const e1x = cPos[b * 3] - cPos[a * 3];
    const e1z = cPos[b * 3 + 2] - cPos[a * 3 + 2];
    const e2x = cPos[d * 3] - cPos[a * 3];
    const e2z = cPos[d * 3 + 2] - cPos[a * 3 + 2];
    cNy += e2x * e1z - e2z * e1x;
  }
  ok("the decal faces up, not down", cNy > 0, `summed cross ${cNy > 0 ? "+" : "-"}`);

  // On the cap the pad is cast onto, not on grade 183 mm below it.
  let cMinY = Infinity;
  for (let i = 0; i < cCol.count; i++) cMinY = Math.min(cMinY, cPos[i * 3 + 1]);
  const capY0 = islandTop(c0.x, c0.z);
  ok(
    "it sits on the island cap, not on the grade below it",
    cMinY > capY0 && cMinY < capY0 + 0.02,
    `lowest vertex ${cMinY.toFixed(4)} against cap ${capY0.toFixed(4)}`
  );
  const perDecal = cGeo.index.count / 3;
  console.log(
    `  cost: ${perDecal} triangles x ${CANOPY.columns.length} = ${perDecal * CANOPY.columns.length}, one merged draw, no texture`
  );

  /**
   * The winding of every new outward-facing part, which this probe did not
   * check when the parts were added — and that omission is the finding.
   *
   * The case-43 entry in NOTES was written on the strength of the fascia sweep,
   * and it says plainly that the defence against an inverted surface is an
   * assertion at build time rather than a capture afterwards. Three new
   * outward-facing parts then went in — the overflow stains, the sign faces and
   * the scupper sleeves — and only their *positions* were asserted. The stains
   * are hand-wound from explicit corners, which is the single most likely place
   * in this system for a winding to be backwards, and a backwards one is
   * invisible rather than wrong.
   *
   * **A rule written down is not a check.** The general form: after adding a
   * part, ask which existing assertion covers it, and if the honest answer is
   * "the one I wrote for a different part", it is not covered.
   */
  const outwardOk = (geo, want, label) => {
    const p = geo.getAttribute("position").array;
    const idx = geo.index ? geo.index.array : null;
    const n = idx ? idx.length : p.length / 3;
    let sx = 0;
    let sz = 0;
    let area = 0;
    for (let t = 0; t < n; t += 3) {
      const i0 = (idx ? idx[t] : t) * 3;
      const i1 = (idx ? idx[t + 1] : t + 1) * 3;
      const i2 = (idx ? idx[t + 2] : t + 2) * 3;
      // Only triangles on the run we know the answer for.
      const cz = (p[i0 + 2] + p[i1 + 2] + p[i2 + 2]) / 3;
      if (Math.abs(cz - CANOPY.minZ) > 0.9) continue;
      const ux = p[i1] - p[i0];
      const uy = p[i1 + 1] - p[i0 + 1];
      const uz = p[i1 + 2] - p[i0 + 2];
      const vx = p[i2] - p[i0];
      const vy = p[i2 + 1] - p[i0 + 1];
      const vz = p[i2 + 2] - p[i0 + 2];
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      const a = Math.hypot(nx, uz * vx - ux * vz, nz);
      sx += nx;
      sz += nz;
      area += a;
    }
    const mz = area > 0 ? sz / area : 0;
    void sx;
    ok(
      `${label} faces outward on the -Z run`,
      Math.sign(mz) === Math.sign(want) && Math.abs(mz) > 0.5,
      `mean geometric normal z = ${mz.toFixed(3)} (want ${want})`
    );
  };
  // The two hand-wound parts. Both are open quads, which is what makes them
  // the candidates: a quad's winding is decided by the order three vertices
  // were written down, and nothing else in the file checks it.
  outwardOk(buildOverflowStains(lv, sc), -1, "the overflow stains");
  outwardOk(buildSignFaces(signsG, () => [0, 0, 1, 1]), -1, "the sign faces");
  // The scuppers and the cabinets are deliberately *not* tested this way. They
  // are closed `roundedBox` volumes, so their mean face normal is exactly zero
  // by construction and the test returns a failure that does not exist — the
  // same mistake the first version of the lens check made, and the reason the
  // case-43 note says to select the face you mean rather than averaging over a
  // solid. Their winding is carried by the shared `roundedBox` helper, which
  // every other part in the scene also depends on and which is therefore proven
  // by anything at all being visible.
}

/* ---------------- cost ---------------- */
console.log("\ncost this system adds:");
{
  let tris = 0;
  const rows = [];
  for (const [name, g] of Object.entries(parts)) {
    const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const mult = name === "shaft" || name === "base" ? CANOPY.columns.length : 1;
    tris += n * mult;
    rows.push(`  ${name.padEnd(10)} ${String(Math.round(n)).padStart(6)}${mult > 1 ? ` x${mult}` : ""}`);
  }
  console.log(rows.join("\n"));
  console.log(`  ${"TOTAL".padEnd(10)} ${String(Math.round(tris)).padStart(6)} triangles`);
  console.log(`  draw calls: 7 opaque meshes + 1 blended + 2 instanced`);
  // Sources, not textures: the per-metre variants are `Texture.clone()`, which
  // shares the underlying Source, and three uploads once per source.
  const lampBytes = 256 * 256 * 4;
  const texBytes =
    512 * 512 * 4 * 4 +
    CANOPY.lightmapSize * CANOPY.lightmapSize * 4 +
    lampBytes +
    1024 * 512 * 4 +
    128 * 128 * 4;
  console.log(
    `  new texture sources: 4 x 512 RGBA (grime, steel normal, steel rough, lens) + ` +
      `1 x ${CANOPY.lightmapSize} RGBA (soffit bake)\n` +
      `                       + 1 x 256 RGBA (soffit lamp map) + 1 x 1024x512 RGBA (sign atlas)` +
      ` + 1 x 128 RGBA (overflow stain)\n` +
      `                       = ${(texBytes / 1048576).toFixed(2)} MB, ${((texBytes * 4) / 3 / 1048576).toFixed(2)} MB with mips`
  );
  ok("under a 20 000 triangle self-imposed ceiling", tris < 20000, `${Math.round(tris)}`);
}

console.log(`\n${failures ? `PROBE FAILED: ${failures} check(s)` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
