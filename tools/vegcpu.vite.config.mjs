/**
 * Private Vite config for CPU-only (no GPU, no browser) analysis builds of the
 * System 6 generators. Bundles a TypeScript entry under `tools/` for Node so a
 * plain `node` process can call the procedural texture and geometry builders
 * and measure them numerically.
 *
 * Separate from the project's vite.config.ts on purpose: that file is shared
 * and belongs to nobody in particular, and this build has entirely different
 * requirements (SSR target, no HTML, no dev server).
 */
import { defineConfig } from "vite";

const ALL = {
  vegalpha: "tools/_vegalpha-entry.ts",
  vegprofile: "tools/_vegprofile-entry.ts",
  vegscatter: "tools/_vegscatter-entry.ts",
  vegsmoke: "tools/_vegsmoke-entry.ts",
  vegcolour: "tools/_vegcolour-entry.ts",
  vegmat: "tools/_vegmat-entry.ts",
  vegscale: "tools/_vegscale-entry.ts",
  vegfacet: "tools/_vegfacet-entry.ts",
  vegwind: "tools/_vegwind-entry.ts",
  vegclump: "tools/_vegclump-entry.ts",
  vegaccum: "tools/_vegaccum-entry.ts",
};

// `VEGCPU_ONLY=vegfacet,vegmat` builds a subset.
//
// Not a convenience. Rolldown fails the whole build if any entry's import graph
// fails to parse, and these entries do not share a graph: `vegscale` reaches
// `BuildingSystem` (for the real footprint) and therefore every generator
// Building owns. Five agents edit concurrently, so a sibling half-way through an
// edit to a file none of the other tools touch takes all of them offline —
// which it did, at 05:35, via an unterminated GLSL template literal in
// `buildingWeather.ts`. A tool that cannot be run when a neighbour is mid-edit
// is a tool that cannot be run when it is most needed.
const only = (process.env.VEGCPU_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const k of only) if (!ALL[k]) throw new Error(`VEGCPU_ONLY: no entry "${k}" (have ${Object.keys(ALL).join(", ")})`);
const input = only.length ? Object.fromEntries(only.map((k) => [k, ALL[k]])) : ALL;

export default defineConfig({
  logLevel: "warn",
  build: {
    ssr: true,
    outDir: ".shot-build/cpu",
    emptyOutDir: true,
    minify: false,
    target: "node22",
    rollupOptions: {
      input,
      output: { entryFileNames: "[name].mjs", format: "esm" },
      external: ["three", /^three\//, "pngjs", "node:fs", "node:path"],
    },
  },
});
