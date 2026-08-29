// Resolve extensionless relative imports the way Vite does.
//
// Most of `src/` imports siblings as `./noise` rather than `./noise.ts`. Vite
// resolves that happily; Node's ESM resolver does not, so every CPU-side
// diagnostic dies at the first import with ERR_MODULE_NOT_FOUND. Fixing the
// sources would mean editing files owned by four other agents, and the pattern
// keeps coming back as they add modules.
//
// This is the smaller and more durable fix: a resolver hook that retries a
// failed relative specifier with the extensions Vite would have tried. It lives
// in tools/, changes no source, and cannot affect the shipped bundle.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const TRY = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err;
    if (!context.parentURL) throw err;
    const base = new URL(specifier, context.parentURL);
    for (const ext of TRY) {
      const candidate = new URL(base.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        return next(pathToFileURL(fileURLToPath(candidate)).href, context);
      }
    }
    throw err;
  }
}
