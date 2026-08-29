/**
 * Private Vite config for Lighting's CPU-only analysis builds.
 *
 * Deliberately not shared with `tools/vegcpu.vite.config.mjs`: that one belongs
 * to another agent working the same tree, and two owners editing one entry list
 * is how a build starts failing for a reason neither of them changed. Separate
 * file, separate `outDir`.
 */
import { defineConfig } from "vite";

export default defineConfig({
  logLevel: "warn",
  build: {
    ssr: true,
    outDir: ".shot-build/lightcpu",
    emptyOutDir: true,
    minify: false,
    target: "node22",
    rollupOptions: {
      input: { clumpcolor: "tools/_clumpcolor-entry.ts" },
      output: { entryFileNames: "[name].mjs", format: "esm" },
      external: ["three", /^three\//, "pngjs", "node:fs", "node:path"],
    },
  },
});
