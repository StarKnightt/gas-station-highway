#!/usr/bin/env node
import { build } from "vite";
await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { dump } = await import("../.shot-build/cpu/vegcolour.mjs");
const r = dump();
console.log(`horizon geometry: ${r.vertices} vertices`);
const f = (a) => a.map((v) => v.toFixed(4)).join(",");
const luma = (a) => (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]).toFixed(4);
for (const b of r.bands) {
  console.log(
    `  band ${b.band}: authored ${f(b.authored)} (luma ${luma(b.authored)})\n` +
      `           top vtx  ${f(b.topMean)} (luma ${luma(b.topMean)})  crown tonal spread ${b.topLumaSpread.toFixed(2)}x\n` +
      `           base vtx ${f(b.baseMean)} (luma ${luma(b.baseMean)})`
  );
}
