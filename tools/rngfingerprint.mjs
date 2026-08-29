/**
 * Determinism fingerprint for the shared RNG. Read-only, CPU-only.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/rngfingerprint.mjs > after.txt
 *   diff before.txt after.txt
 *
 * Hashes the draw stream for every fixed seed that reaches `makeRng` anywhere in
 * the project, plus the noise fields built from them. Any line that moves means
 * a generated result was rerolled — every texture downstream of that seed will
 * differ, and per NOTES.md case 13 every archived reference capture becomes
 * incomparable at once.
 *
 * Run it before and after touching `noise.ts`. NOTES.md case 16 turned down a
 * whole-project reroll deliberately, and this is the cheap way to confirm a
 * later change has not quietly taken one anyway. It is a fingerprint, not a
 * quality test: identical output means "nothing moved", not "the RNG is good".
 * For that, see `tools/probe-rngsets.mjs`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const noise = await import(pathToFileURL(path.join(ROOT, "src/gen/noise.ts")).href);
const { makeRng, fbm, valueNoise, worley } = noise;

/** FNV-1a over the byte view of a float sequence. */
function fnv(values) {
  let h = 0x811c9dc5;
  const buf = new DataView(new ArrayBuffer(8));
  for (const v of values) {
    buf.setFloat64(0, v);
    for (let b = 0; b < 8; b++) {
      h ^= buf.getUint8(b);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

const stream = (factory, seed, n = 4096) => {
  const r = factory(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(r());
  return out;
};

console.log("--- makeRng streams for every fixed seed used in the project ---");
// Every literal seed reaching makeRng: car skins, building textures, hard
// surfaces, site overlay, building props, ground textures.
const FIXED = [
  1, 3, 1337, 3301, 3313, 3319, 3323, 7171, 9091, 20802, 20240117,
  // textures.ts derives a second stream per texture.
  1337 * 7 + 11, 1337 * 13 + 5, 3301 * 7 + 11, 3301 * 13 + 5,
];
for (const s of FIXED) {
  console.log(`  makeRng(${String(s).padStart(9)})  ${fnv(stream(makeRng, s))}`);
}

console.log("--- noise fields built from those streams ---");
for (const s of [1337, 3301, 7171, 20802]) {
  console.log(
    `  seed ${String(s).padStart(6)}  fbm ${fnv(fbm(96, 9, makeRng(s), { octaves: 5, gain: 0.52 }))}` +
      `  value ${fnv(valueNoise(96, 16, makeRng(s)))}  worley ${fnv(worley(96, 12, makeRng(s)))}`
  );
}

console.log("--- seededRng streams for the vegetation seeds ---");
const { seededRng } = noise;
for (const s of [2718, 4401, 4703, 5000, 5037, 900, 913]) {
  console.log(`  veg(${String(s).padStart(6)})  ${fnv(stream(seededRng, s))}`);
}
for (let i = 0; i < 10; i++) {
  const s = 3100 + i * 977;
  console.log(`  pine(${String(s).padStart(5)})  ${fnv(stream(seededRng, s))}`);
}
