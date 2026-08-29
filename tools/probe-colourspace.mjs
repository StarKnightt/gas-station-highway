/**
 * Colour-space audit for authored constants. CPU-only, no GPU, no capture.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-colourspace.mjs
 *
 * The failure this catches (NOTES.md case 23): a colour literal authored while
 * thinking in one space and interpreted by three in the other. The error is
 * **negligible for bright values and catastrophic for dark ones**, because the
 * sRGB transfer function is steep near zero — so this ranks by darkness rather
 * than treating all mismatches alike.
 *
 * Verified against three 0.185.1, because the defaults are not symmetric and that
 * asymmetry is the whole trap:
 *
 *   setHex(hex, colorSpace = SRGBColorSpace)      <- hex literals: sRGB -> linear
 *   new THREE.Color(0x...)                        <- same, via setHex
 *   setStyle(str, colorSpace = SRGBColorSpace)    <- same
 *   setRGB(r, g, b, colorSpace = workingColorSpace)   <- LINEAR by default
 *   setHSL(h, s, l, colorSpace = workingColorSpace)   <- LINEAR by default
 *   new THREE.Color(r, g, b)                      <- LINEAR, via setRGB
 *
 * So a hex literal always means what a person picking it in an editor expects,
 * and a numeric triple never does. `Game.ts` sets ColorManagement.enabled = true
 * and outputColorSpace = SRGBColorSpace, so all of this is live.
 *
 * Two checks:
 *   1. a mechanical screen over src/ for dark literals tagged SRGBColorSpace,
 *      which needs no knowledge of intent; and
 *   2. a curated table of every numeric colour site, classified by how the value
 *      is *consumed*, because that is what decides which space is correct.
 */
import fs from "node:fs";
import path from "node:path";
import { SRGBToLinear, LinearToSRGB } from "three/src/math/ColorManagement.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const REC709 = [0.2126, 0.7152, 0.0722];
const lum = (rgb) => rgb[0] * REC709[0] + rgb[1] * REC709[1] + rgb[2] * REC709[2];
const toLinear = (rgb) => rgb.map(SRGBToLinear);
const toDisplay = (rgb) => rgb.map(LinearToSRGB);
const d255 = (x) => (x * 255).toFixed(0);

/**
 * three's ACESFilmicToneMapping (RRTAndODTFit with the ACES input/output
 * matrices), matching src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.
 * Included because Game.ts renders with it at exposure 1.25, so it is what
 * decides the number a critic actually sees.
 */
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
const mul3 = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function acesFilmic(rgbLinear, exposure = 1.25) {
  let v = rgbLinear.map((c) => c * exposure);
  v = mul3(ACES_IN, v);
  v = v.map((c) => {
    const a = c * (c + 0.0245786) - 0.000090537;
    const b = c * (0.983729 * c + 0.4329510) + 0.238081;
    return a / b;
  });
  v = mul3(ACES_OUT, v);
  return v.map((c) => Math.min(1, Math.max(0, c)));
}
/** What a screenshot pixel reads, 0..255, for a given scene-referred linear colour. */
const screen = (rgbLinear) => d255(LinearToSRGB(lum(acesFilmic(rgbLinear))));

/* ------------------------------------------------------------------ */
/* 1. mechanical screen: dark literals tagged SRGBColorSpace           */
/* ------------------------------------------------------------------ */
/**
 * This is the part that needs no intent. A value tagged SRGBColorSpace is
 * divided by up to 12.9 on its way to linear; if the authored number is already
 * small, the result is below any physically real material and almost certainly
 * not what was meant. Bright values are left alone: sRGB 0.9 -> linear 0.79 is a
 * 14% difference nobody should spend a round on.
 */
const DARK = 0.12; // authored components at or below this are in the danger zone

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const screened = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const m = /set(RGB|HSL)\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*THREE\.SRGBColorSpace\s*\)/.exec(line);
    if (!m) return;
    const rgb = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (Math.max(...rgb) > DARK) return;
    screened.push({
      site: `${path.relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}`,
      rgb,
    });
  });
}

console.log("=".repeat(96));
console.log("Colour-space audit of authored constants");
console.log("=".repeat(96));
console.log("\n1. MECHANICAL SCREEN - dark literals tagged SRGBColorSpace");
console.log("   No knowledge of intent needed: these are divided by up to 12.9 on the way to");
console.log("   linear, and were already dark. Bright literals are deliberately not flagged.\n");
console.log("   site                          authored (as written)     lands at (linear)        ratio");
if (!screened.length) console.log("   none");
for (const s of screened) {
  const lin = toLinear(s.rgb);
  const ratio = lum(s.rgb) / lum(lin);
  console.log(
    `   ${s.site.padEnd(29)} ${s.rgb.map((v) => v.toFixed(3)).join(" ").padEnd(25)} ` +
      `${lin.map((v) => v.toFixed(5)).join(" ").padEnd(24)} ${ratio.toFixed(1)}x darker`
  );
}

/* ------------------------------------------------------------------ */
/* 2. curated table: what decides correctness is how it is consumed    */
/* ------------------------------------------------------------------ */
/**
 * `kind` is the whole argument, so it is stated per site rather than inferred:
 *
 *   albedo    a surface reflectance, multiplied by incoming light. Must be linear.
 *             Physically bounded: real materials sit between about 0.02 (soot,
 *             fresh asphalt) and 0.9 (fresh snow).
 *   unlit     written straight to the framebuffer with no lighting term, on a
 *             MeshBasicMaterial or a ShaderMaterial. The worst case, because
 *             nothing downstream can rescue it and no reflectance change touches
 *             it - which also means it is independent of the envMapIntensity
 *             retune happening elsewhere, so it can be fixed on its own.
 *   radiance  a scene-referred emitted/additive value, may exceed 1. Linear.
 *   multiplier a ratio applied to another colour. Must be linear, and must NOT
 *             be transfer-encoded: a transfer function is not linear, so pushing
 *             a ratio through it changes hue balance as well as level.
 *   light     a THREE.Light colour, used raw as a linear multiplier.
 */
const SITES = [
  // vegetation
  { site: "vegGround.ts:80", name: "DUFF", rgb: [0.052, 0.036, 0.024], tag: "srgb", kind: "unlit",
    consumed: "vertex colour on an unlit MeshBasicMaterial, alpha 0.5-0.85" },
  { site: "vegGround.ts:81", name: "DAMP", rgb: [0.070, 0.058, 0.044], tag: "srgb", kind: "unlit",
    consumed: "vertex colour on an unlit MeshBasicMaterial, alpha 0.5-0.85" },
  { site: "vegWire.ts:120", name: "uBase", rgb: [0.055, 0.052, 0.05], tag: "srgb", kind: "unlit",
    consumed: "gl_FragColor = uBase + uGlint*... ; summed with a Linear-tagged term" },
  { site: "vegWire.ts:123", name: "uGlint", rgb: [3.4, 2.05, 1.05], tag: "linear", kind: "unlit",
    consumed: "same sum, explicitly LinearSRGBColorSpace - the correct one" },
  { site: "VegetationSystem.ts:779", name: "STRAW", rgb: [1.06, 0.99, 0.83], tag: "srgb", kind: "multiplier",
    consumed: "lerped with SAGE into a per-instance tint" },
  { site: "VegetationSystem.ts:780", name: "SAGE", rgb: [0.8, 0.88, 0.76], tag: "srgb", kind: "multiplier",
    consumed: "lerped with STRAW into a per-instance tint" },
  { site: "vegPine.ts:432", name: "pine tint", rgb: [0.88, 0.98, 1.08], tag: "linear", kind: "multiplier",
    consumed: "per-card tint, no colorSpace argument" },
  { site: "vegDistant.ts:338", name: "rim", rgb: [0.86, 0.58, 0.34], tag: "linear", kind: "radiance",
    consumed: "band vertex colour, fixed in the case-22 round" },
  // sky and lights
  { site: "lightSky.ts:34", name: "uZenith", rgb: [0.020, 0.046, 0.132], tag: "linear", kind: "radiance",
    consumed: "sky shader, same set as uSunDisc 3.7" },
  { site: "lightSky.ts:40", name: "uGround", rgb: [0.055, 0.045, 0.036], tag: "linear", kind: "radiance",
    consumed: "sky shader below the horizon" },
  { site: "LightingSystem.ts:50", name: "SUN_COLOR", rgb: [1.0, 0.535, 0.243], tag: "linear", kind: "light",
    consumed: "DirectionalLight.color" },
  { site: "LightingSystem.ts:149", name: "bounce", rgb: [0.115, 0.062, 0.030], tag: "linear", kind: "light",
    consumed: "bounce light colour" },
  { site: "LightingSystem.ts:223", name: "fog", rgb: [0.30, 0.34, 0.44], tag: "linear", kind: "radiance",
    consumed: "FogExp2, mixed in linear in the shader" },
  { site: "buildingProps.ts:48", name: "PRODUCT_BASE", rgb: [0.34, 0.32, 0.29], tag: "linear", kind: "albedo",
    consumed: "shop product base colour" },
];

const ALBEDO_FLOOR = 0.01; // below this, no real material
/**
 * Nominal irradiance for turning an albedo into a screen number, so that column
 * means something for reflective surfaces. Roughly this scene's sunlit level.
 * Unlit values need no such factor, which is exactly why they are the worst case.
 */
const IRRADIANCE = 3.0;

console.log("\n" + "=".repeat(96));
console.log("2. EVERY NUMERIC COLOUR SITE, classified by how the value is consumed");
console.log("=".repeat(96));
console.log("\n   The tag is only wrong relative to the use. A multiplier or an albedo must be");
console.log("   linear; a transfer-encoded ratio is wrong twice over, in level and in hue.\n");
console.log("   site                      kind        lands at (linear)      screen  verdict");

const verdicts = [];
for (const s of SITES) {
  const linear = s.tag === "srgb" ? toLinear(s.rgb) : s.rgb;
  const intended = s.rgb; // what the number says, read as linear
  // Symmetric: sRGB decoding darkens values below 1 and brightens those above it.
  const raw = lum(intended) / lum(linear);
  const ratio = Math.max(raw, 1 / raw);
  const gain = s.kind === "albedo" ? IRRADIANCE : 1;
  let verdict = "ok";
  let severity = 0;
  if (s.tag === "srgb") {
    if (ratio > 1.5) {
      verdict = `WRONG - ${ratio.toFixed(1)}x`;
      severity = ratio;
      if (s.kind === "albedo" && lum(linear) < ALBEDO_FLOOR) {
        verdict += `, and albedo ${lum(linear).toFixed(4)} is below any real material`;
      }
    } else {
      verdict = `minor - ${ratio.toFixed(2)}x, below the threshold worth a round`;
    }
  }
  verdicts.push({ ...s, linear, ratio, verdict, severity, gain });
  console.log(
    `   ${s.site.padEnd(25)} ${s.kind.padEnd(11)} ${linear.map((v) => v.toFixed(4)).join(" ").padEnd(22)} ` +
      `${screen(linear.map((c) => c * gain)).padStart(6)}  ${verdict}`
  );
}

/* ------------------------------------------------------------------ */
/* 3. ranked findings                                                  */
/* ------------------------------------------------------------------ */
console.log("\n" + "=".repeat(96));
console.log("3. RANKED BY VISIBLE WRONGNESS");
console.log("=".repeat(96));
const ranked = verdicts.filter((v) => v.severity > 1.5).sort((a, b) => b.severity - a.severity);
if (!ranked.length) console.log("\n   nothing above the 1.5x threshold.");
for (const v of ranked) {
  const asIs = screen(v.linear.map((c) => c * v.gain));
  const asIntended = screen(v.rgb.map((c) => c * v.gain));
  console.log(`\n   ${v.name}  (${v.site})  ${v.kind}`);
  console.log(`     consumed as: ${v.consumed}`);
  console.log(`     authored     ${v.rgb.map((x) => x.toFixed(3)).join(", ")}`);
  console.log(`     lands at     ${v.linear.map((x) => x.toFixed(5)).join(", ")}   (${v.ratio.toFixed(1)}x darker in linear)`);
  console.log(`     on screen    ${asIs}/255 as written vs ${asIntended}/255 if tagged linear`);
  if (v.kind === "multiplier") {
    const rbIn = v.rgb[0] / v.rgb[2];
    const rbOut = v.linear[0] / v.linear[2];
    console.log(
      `     hue shift    R:B ${rbIn.toFixed(2)} -> ${rbOut.toFixed(2)}  ` +
        `(${(((rbOut / rbIn) - 1) * 100).toFixed(0)}% more saturated; a ratio must not be transfer-encoded)`
    );
  }
}

/* ------------------------------------------------------------------ */
/* 4. transfer-encoded multipliers                                     */
/* ------------------------------------------------------------------ */
/**
 * A separate check, because for a *ratio* the luminance change is not the tell.
 * sRGB decoding is a power curve, so it does not scale the components of a
 * multiplier equally - it distorts the hue balance even when the overall level
 * happens to come out about the same. STRAW's luminance moves by 0% and its
 * warmth by 36%, which a ratio-based check on brightness alone would miss.
 */
console.log("\n" + "=".repeat(96));
console.log("4. MULTIPLIERS TAGGED sRGB - hue distortion regardless of level");
console.log("=".repeat(96));
const mults = verdicts.filter((v) => v.kind === "multiplier" && v.tag === "srgb");
if (!mults.length) console.log("\n   none");
for (const v of mults) {
  const rbIn = v.rgb[0] / v.rgb[2];
  const rbOut = v.linear[0] / v.linear[2];
  const shift = ((rbOut / rbIn - 1) * 100).toFixed(0);
  console.log(
    `\n   ${v.name} (${v.site}): luminance ${v.ratio.toFixed(2)}x, ` +
      `but R:B ${rbIn.toFixed(2)} -> ${rbOut.toFixed(2)} = ${shift}% warmer`
  );
  console.log(`     a ratio must not be transfer-encoded; drop the SRGBColorSpace argument.`);
}

console.log("\n" + "=".repeat(96));
if (screened.length || ranked.length) {
  console.log(
    `FAIL: ${ranked.length} site(s) land more than 1.5x from the authored number in a way\n` +
      "the consumption makes wrong. Do not fix these piecemeal - see NOTES.md case 23,\n" +
      "and note that envMapIntensity going live is shifting reflectance at the same time."
  );
  process.exitCode = 1;
} else {
  console.log("OK: every authored colour lands in the space its consumer needs.");
}
