#!/usr/bin/env node
/**
 * Fails if any vegetation layer can reflect more light than reaches it.
 *
 * CPU only, no GPU, no browser, about four seconds. Run it before theorising
 * about why something is too bright — it separates the two cases that look
 * identical in the source:
 *
 *   tint IS the albedo        -> a value near 1.0 is a defect
 *   tint MODULATES a map      -> a value near 1.0 is normal, check the product
 *
 * Reading the constant alone cannot tell those apart. This system fixed the
 * first case correctly and then came within one edit of "fixing" the second,
 * which was never broken.
 *
 *   node tools/vegalbedo.mjs
 */
import { build } from "vite";

process.env.VEGCPU_ONLY = "vegalbedo";
await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { measure, sunGeometry } = await import("../.shot-build/cpu/vegalbedo.mjs");

const f = (a) => (a ? a.map((v) => v.toFixed(3)).join(", ") : "—");
const rows = measure();
const failures = [];

console.log("\n[vegalbedo] effective albedo per layer, alpha-weighted above alphaTest 0.3\n");
for (const r of rows) {
  console.log(`  ${r.layer}`);
  console.log(`    tint is           ${r.tintIs}`);
  if (r.cardMean) {
    console.log(`    map mean          ${f(r.cardMean)}`);
    console.log(`    map max           ${f(r.cardMax)}   over ${r.opaquePx} px (${(r.opaqueFrac * 100).toFixed(1)}% of card)`);
  }
  console.log(`    tint range        ${f(r.tintMin)}  ..  ${f(r.tintMax)}`);
  console.log(`    worst albedo      ${f(r.worstAlbedo)}${r.unphysical ? "   !! ABOVE 1" : ""}`);
  if (r.unphysical) {
    failures.push(
      `${r.layer}: worst-case albedo (${f(r.worstAlbedo)}) exceeds 1, i.e. a surface reflecting ` +
        `more light than reaches it. Because the tint is ${r.tintIs}, ` +
        (r.tintIs === "the albedo"
          ? "the tint constant itself is the thing to lower."
          : "lower the map or the tint only after checking the product — the constant alone is not the bug.")
    );
  }
  console.log("");
}

const g = sunGeometry();
console.log(`[vegalbedo] sun at ${g.elevationDeg} degrees:`);
console.log(`    horizontal ground receives  ${g.groundCos.toFixed(3)} of the beam`);
console.log(`    a vertical blade receives   ${g.verticalCos.toFixed(3)}`);
console.log(`    ratio                       ${g.verticalOverGround.toFixed(1)}x`);
console.log(
  `    So vertical vegetation is legitimately about ${g.verticalOverGround.toFixed(0)}x brighter than the\n` +
    `    ground beside it at identical albedo. "The tufts are too bright against the dirt" has to\n` +
    `    clear this number before it is a defect rather than the sun being low.`
);

if (failures.length) {
  console.error(`\n[vegalbedo] FAIL (${failures.length})`);
  for (const m of failures) console.error(`  - ${m}`);
  process.exit(1);
}
console.log("\n[vegalbedo] PASS — every layer's worst-case albedo is physical.");
