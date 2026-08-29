// Entry point for the extensionless-import resolver hook.
// Use as: node --import ./tools/extresolve.mjs tools/<whatever>.mjs
import { register } from "node:module";

register("./extresolve-hooks.mjs", import.meta.url);
