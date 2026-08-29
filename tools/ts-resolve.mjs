/**
 * Let Node import this repo's TypeScript the way the bundler does.
 *
 *   node --import ./tools/ts-resolve.mjs tools/whatever.mjs
 *
 * Node 22 strips types on its own, so `import "../src/gen/foo.ts"` already
 * works. What it will not do is resolve an *extensionless* relative specifier —
 * and `src/` is written for Vite, where `./noise` means `./noise.ts`. So the
 * first tool to import anything with its own dependencies dies on the second
 * hop rather than the first, which reads like the module being broken instead of
 * the resolver being stricter.
 *
 * This adds the extension Vite would have added, and nothing else. It does not
 * transpile, shim a DOM, or touch the browser path; there is no way for it to
 * change what ships. Directory imports get `/index.ts` for the same reason.
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts", ".js"];

export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !/\.[a-z]+$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of CANDIDATES) {
      const guess = new URL(base.href + ext);
      if (existsSync(fileURLToPath(guess))) {
        return next(base.href + ext, context);
      }
    }
  }
  return next(specifier, context);
}

register(pathToFileURL(import.meta.filename));
