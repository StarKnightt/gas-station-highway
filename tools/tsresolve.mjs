/**
 * Lets Node's type-stripping loader follow this project's extensionless
 * relative imports, so any module under `src/` can be loaded and measured from
 * a CPU-only script with no bundler, no browser and no GPU.
 *
 * Why this exists rather than a source edit: `src/` imports like `./noise`
 * without a file extension throughout. Vite resolves that happily; Node's ESM
 * resolver does not, and refuses with ERR_MODULE_NOT_FOUND. Adding extensions
 * everywhere would mean editing files owned by four other agents working in
 * this repo concurrently. A resolve hook fixes every module at once, cannot
 * affect the production bundle, and is a capability the whole project gets -
 * not just the car.
 *
 * Usage:
 *   node --import ./tools/tsregister.mjs --experimental-strip-types script.mjs
 */
const CANDIDATES = [".ts", ".tsx", "/index.ts", ".js"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only rescue relative specifiers. A bare specifier that fails to resolve
    // is a genuinely missing dependency and should still be reported as one.
    if (!/^\.{1,2}\//.test(specifier)) throw err;
    for (const ext of CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        /* try the next candidate */
      }
    }
    throw err;
  }
}
