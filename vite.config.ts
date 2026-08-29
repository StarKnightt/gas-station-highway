import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5173 },
  preview: { port: 5111 },
  build: { target: "es2022", sourcemap: false },
});
