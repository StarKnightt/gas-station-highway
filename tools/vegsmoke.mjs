#!/usr/bin/env node
/**
 * CPU-only build of every System 6 generator. No GPU, no browser.
 *
 *   node tools/vegsmoke.mjs
 *
 * Reports triangle counts so the scene budget can be checked without a capture,
 * and exercises the texture generators' border invariant, which throws.
 */
import { rmSync } from "node:fs";
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { buildAll } = await import("../.shot-build/cpu/vegsmoke.mjs");

const t0 = Date.now();
const out = buildAll();
const ms = Date.now() - t0;

let total = 0;
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(9)}`);
  if (k.includes("triangles")) total += v;
}
console.log(`  ${"".padEnd(30)} ${"".padStart(9, "-")}`);
console.log(`  ${"TOTAL TRIANGLES".padEnd(30)} ${String(total).padStart(9)}`);
console.log(`\nbuilt in ${ms} ms on the CPU`);

// The scene had 2.2M triangles before this system existed.
const BUDGET = 2_200_000;
console.log(`= ${((total / BUDGET) * 100).toFixed(1)}% of the pre-existing ${(BUDGET / 1e6).toFixed(1)}M triangle scene`);

rmSync(".shot-build/cpu", { recursive: true, force: true });
