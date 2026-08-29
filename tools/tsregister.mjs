/**
 * Installs the extensionless-import resolver in tools/tsresolve.mjs.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types script.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(new URL("./tsresolve.mjs", pathToFileURL(import.meta.filename)));
