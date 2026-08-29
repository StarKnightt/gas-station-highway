#!/usr/bin/env node
/**
 * Which occluder shadows a region, by ray casting toward the real sun vector.
 * CPU only, no browser, no GPU, well under a second.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types \
 *     tools/probe-shadowsource.mjs [--rect=minX,maxX,minZ,maxZ] [--step=0.2]
 *
 * ## Why this exists
 *
 * Three systems tonight attributed a region's darkness to a named occluder by
 * arithmetic on the shadow's *reach*, and at least one of them was wrong in a
 * way that cost a full authoring cycle: the canopy deck is 4.72 m up, and its
 * shadow reach was applied along +Z. The sun's azimuth is 203.4 degrees, so
 * 91.8% of the displacement is in X and the deck's shadow misses the forecourt
 * entirely — at the true 6.2 degree elevation it lands at x 33.3..46.5 against a
 * forecourt ending at 11.6. Both the reach and the region were real; only the
 * composition was wrong, which is what made it credible.
 *
 * > A shadow's reach is one number and its direction is two. A reach applied to
 * > the wrong axis lands somewhere real-looking and wrong.
 *
 * So: cast the ray. It is cheaper than the arithmetic and it names the occluder
 * per sample rather than per region, which also tells you the *fraction*
 * shadowed — the number that decides whether an occluder matters at all.
 *
 * ## Adoption
 *
 * Add a box to `OCCLUDERS` for your own geometry and pass `--rect` for the
 * region you are about to author onto. Boxes are conservative AABBs, which is
 * the right error direction: a box that is too big over-reports shadow, so a
 * `shadows NOTHING` result is trustworthy while a positive one is an upper
 * bound. Anything needing better than that should test the real triangles.
 *
 * Pair it with the tonal-spread measurement in NOTES 63 and NOTES 70: this tool
 * tells you whether a region is shadowed, that pair tells you whether albedo
 * work can read there, and the two failure modes are different. A region can be
 * fully sunlit and still flat, if the term that dominates it is constant.
 */
import { readFileSync } from "node:fs";
import { CANOPY, canopyLevels, islandTop } from "../src/gen/canopyParts.ts";
import { BUILDING, FORECOURT, PARKING, SUN, groundHeight } from "../src/site.ts";

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const step = Number(arg("step", "0.2"));
const rect = (() => {
  const raw = arg("rect", null);
  if (!raw) return { name: "FORECOURT", ...FORECOURT };
  const [minX, maxX, minZ, maxZ] = raw.split(",").map(Number);
  if ([minX, maxX, minZ, maxZ].some((v) => !Number.isFinite(v))) {
    throw new Error(`--rect wants four finite numbers, got "${raw}"`);
  }
  return { name: raw, minX, maxX, minZ, maxZ };
})();

/*
 * Resolve the elevation from one place and say which place, because this tool
 * exists downstream of a two-round detour caused by not doing that.
 *
 * `site.SUN.elevation` held 11 degrees while `LightingSystem` shipped 6.2 from a
 * private `SUN_ELEVATION_DEG`. Nothing in `src` imported the shared field — only
 * `azimuth` — so **the renderer never disagreed with it, because the renderer
 * never consulted it.** An unused constant cannot be wrong, so nothing corrects
 * it, and it looks authoritative precisely because it lives in `site.ts`. Three
 * CPU tools were misled or worked around it before anyone noticed.
 *
 * The structural conclusion is that a constant exercised only by tools has to be
 * *validated* by a tool, since nothing else can see it. So this one cross-checks
 * the shared field against the shipping value it stands for and fails loudly on
 * disagreement rather than silently picking a winner.
 */
const LIGHTING_SRC = "src/systems/LightingSystem.ts";
const shippedElevationDeg = (() => {
  const src = readFileSync(new URL(`../${LIGHTING_SRC}`, import.meta.url), "utf8");
  const m = src.match(/SUN_ELEVATION_DEG\s*=\s*([0-9.]+)/);
  return m ? Number(m[1]) : null;
})();
const siteElevationDeg = (SUN.elevation * 180) / Math.PI;
const override = arg("elevation", null);

let elevationDeg;
let source;
if (override !== null) {
  elevationDeg = Number(override);
  source = `--elevation=${override} (override, for what-if only)`;
} else if (shippedElevationDeg === null) {
  elevationDeg = siteElevationDeg;
  source = `site.SUN.elevation (could not find SUN_ELEVATION_DEG in ${LIGHTING_SRC})`;
} else {
  elevationDeg = shippedElevationDeg;
  source = `${LIGHTING_SRC} SUN_ELEVATION_DEG, cross-checked against site.SUN.elevation`;
}

/**
 * Returns a complaint string when the two homes of the elevation disagree, and
 * null when they agree. Split out so `--selftest` can fire it, because a guard
 * that has never been seen to trigger is not known to work — and this one
 * currently sits on a reconciled pair, so the passing case proves nothing.
 */
const elevationComplaint = (shippedDeg, siteDeg) => {
  if (shippedDeg === null || Math.abs(shippedDeg - siteDeg) <= 0.05) return null;
  const ratio = Math.tan((shippedDeg * Math.PI) / 180) / Math.tan((siteDeg * Math.PI) / 180);
  return (
    `SUN ELEVATION DISAGREES BETWEEN ITS TWO HOMES\n` +
    `  ${LIGHTING_SRC}  ${shippedDeg} deg   <- what the renderer ships\n` +
    `  src/site.ts SUN     ${siteDeg.toFixed(2)} deg   <- what every CPU tool reads\n` +
    `  every shadow length computed from site.ts is out by ${(1 / ratio).toFixed(2)}x.\n` +
    `  Reconcile before trusting any shadow result. Lighting owns the sun.`
  );
};

if (process.argv.includes("--selftest")) {
  const cases = [
    ["the historical failure, 11 in site.ts against 6.2 shipped", 6.2, 11.0, true],
    ["the reconciled pair as it stands today", 6.2, 6.2, false],
    ["a rounding-level difference, which must not trip it", 6.2, 6.23, false],
    ["a missing shipped value falls back rather than complaining", null, 11.0, false],
  ];
  let bad = 0;
  console.log("probe-shadowsource --selftest\n");
  for (const [name, shipped, site, wantComplaint] of cases) {
    const got = elevationComplaint(shipped, site) !== null;
    if (got !== wantComplaint) bad++;
    console.log(`  ${got === wantComplaint ? "PASS" : "FAIL"}  ${name}`);
  }
  const demo = elevationComplaint(6.2, 11.0);
  console.log(`\n  what the historical case would have printed:\n${demo.split("\n").map((l) => `    ${l}`).join("\n")}`);
  console.log(`\n${bad ? `SELFTEST FAILED: ${bad}` : "selftest passed"}`);
  process.exit(bad ? 1 : 0);
}

if (override === null) {
  const complaint = elevationComplaint(shippedElevationDeg, siteElevationDeg);
  if (complaint) {
    console.error(`\n${complaint}\n`);
    process.exit(2);
  }
}

const el = (elevationDeg * Math.PI) / 180;
const az = SUN.azimuth;
// Built exactly as LightingSystem builds `sunDirection`.
const S = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
const hxz = Math.hypot(S[0], S[2]);
const lv = canopyLevels();

console.log("probe-shadowsource\n");
console.log(`sun            elevation ${elevationDeg.toFixed(2)} deg, azimuth ${((az * 180) / Math.PI).toFixed(1)} deg`);
console.log(`elevation from ${source}`);
console.log(`sunDirection   (${S.map((v) => v.toFixed(4)).join(", ")})`);
console.log(`shadows run    (${(-S[0] / hxz).toFixed(3)}, ${(-S[2] / hxz).toFixed(3)}) in XZ, ${(hxz / S[1]).toFixed(2)} m per metre of height`);
console.log(`region         ${rect.name}  x ${rect.minX}..${rect.maxX}  z ${rect.minZ}..${rect.maxZ}\n`);

/** Ray/AABB slab test, ray from `p` toward the sun, `t > 0` only. */
const hits = (p, b) => {
  let t0 = 1e-6;
  let t1 = 1e9;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(S[a]) < 1e-9) {
      if (p[a] < b[a * 2] || p[a] > b[a * 2 + 1]) return false;
      continue;
    }
    let ta = (b[a * 2] - p[a]) / S[a];
    let tb = (b[a * 2 + 1] - p[a]) / S[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
};

const OCCLUDERS = [
  {
    name: "canopy deck + fascia",
    owner: "canopy",
    box: [CANOPY.minX, CANOPY.maxX, lv.dripY, lv.roofY, CANOPY.minZ, CANOPY.maxZ],
  },
  ...CANOPY.columns.map((c, i) => ({
    name: `canopy column ${i + 1}`,
    owner: "canopy",
    box: [
      c.x - CANOPY.colBaseW / 2,
      c.x + CANOPY.colBaseW / 2,
      islandTop(c.x, c.z) - 0.2,
      lv.soffitY,
      c.z - CANOPY.colBaseW / 2,
      c.z + CANOPY.colBaseW / 2,
    ],
  })),
  // Reserved footprints from site.ts at nominal heights. Owners should replace
  // these with their real extents; a nominal height that is too tall
  // over-reports, which is the safe direction.
  { name: "store building (nominal 5.0 m)", owner: "building", box: [BUILDING.minX, BUILDING.maxX, 0, 5.0, BUILDING.minZ, BUILDING.maxZ] },
  {
    name: "parked cars (nominal 1.5 m)",
    owner: "car",
    box: [
      PARKING.originX - PARKING.stallWidth * PARKING.count,
      PARKING.originX,
      0,
      1.5,
      PARKING.z0,
      PARKING.z0 + PARKING.depth,
    ],
  },
];

let n = 0;
let any = 0;
const count = new Map(OCCLUDERS.map((o) => [o.name, 0]));
for (let z = rect.minZ; z <= rect.maxZ; z += step) {
  for (let x = rect.minX; x <= rect.maxX; x += step) {
    const p = [x, groundHeight(x, z) + 0.005, z];
    n++;
    let shaded = false;
    for (const o of OCCLUDERS) {
      if (hits(p, o.box)) {
        count.set(o.name, count.get(o.name) + 1);
        shaded = true;
      }
    }
    if (shaded) any++;
  }
}

console.log(`${n} samples at ${step} m spacing\n`);
const rows = [...count].sort((a, b) => b[1] - a[1]);
for (const [name, v] of rows) {
  const owner = OCCLUDERS.find((o) => o.name === name).owner;
  console.log(
    v === 0
      ? `  ${name.padEnd(32)} [${owner}]  shadows NOTHING here`
      : `  ${name.padEnd(32)} [${owner}]  ${((v / n) * 100).toFixed(2)}%`
  );
}
console.log(`\n  ${"ANY of the above".padEnd(32)}         ${((any / n) * 100).toFixed(2)}% shadowed, ${(100 - (any / n) * 100).toFixed(2)}% in direct sun`);
if (any / n < 0.5) {
  console.log(
    `\n  Most of this region is in direct sun. If it still measures dark or flat,\n` +
      `  the cause is not an occluder — see NOTES 70 for the ambient-dominance case.`
  );
}
