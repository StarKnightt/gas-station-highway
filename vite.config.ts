import { defineConfig } from "vite";

export default defineConfig({
  // Must stay relative. A GitHub Pages project site serves from
  // /gas-station-highway/, and "./" makes the emitted asset URLs work there and
  // at the root without a build-time switch, so `pnpm dev` and `pnpm play` keep
  // serving from / unchanged. Changing this to "/" 404s every asset on Pages.
  base: "./",
  server: { port: 5173 },
  preview: { port: 5111 },
  build: { target: "es2022", sourcemap: false },
});
