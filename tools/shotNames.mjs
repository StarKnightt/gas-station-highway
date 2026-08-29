/**
 * The shot names from `src/core/shots.ts`, read from the source rather than
 * duplicated here.
 *
 * Node cannot import the TypeScript directly and building it just to read five
 * strings is not worth it, so this parses the object literal's keys. That is a
 * fragile technique in general, which is why it throws instead of returning a
 * short list: a harness that silently measured three of five poses because the
 * regex stopped matching would report an improvement that is really a smaller
 * sample.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHOTS_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/core/shots.ts");

function read() {
  const src = fs.readFileSync(SHOTS_TS, "utf8");
  const body = src.match(/export const SHOTS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!body) throw new Error(`shotNames: could not find the SHOTS object literal in ${SHOTS_TS}`);

  const names = [];
  // Keys at one level of indentation, skipping anything nested inside a preset.
  for (const line of body[1].split("\n")) {
    const m = line.match(/^\s{2}([A-Za-z_][\w-]*)\s*:\s*\{/);
    if (m) names.push(m[1]);
  }
  if (names.length === 0) throw new Error(`shotNames: matched the SHOTS literal but found no keys — the format in ${SHOTS_TS} has changed`);
  return names;
}

export const SHOT_NAMES = read();
