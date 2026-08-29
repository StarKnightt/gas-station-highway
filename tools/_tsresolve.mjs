/**
 * Resolve hook: let extensionless relative imports in `src/` load under Node.
 *
 * `src/` is written for the bundler, which resolves `../site` to `../site.ts`.
 * Node does not, so importing any module that uses an extensionless relative
 * specifier fails with ERR_MODULE_NOT_FOUND naming a path that looks wrong but
 * is not. This appends `.ts` on that failure and nothing else — it does not
 * search, does not guess a directory index, and does not touch bare specifiers,
 * so a genuinely missing module still fails as a missing module.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
      return await nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
