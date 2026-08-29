#!/usr/bin/env node
/**
 * What reflectance do `hardsurface.ts`'s colour maps actually deliver?
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/albedoaudit.mjs
 *   ... --selftest
 *
 * The bug this exists for: a map is authored as floats in 0..1, written to bytes
 * as `value * 255`, and handed to `DataTexture` with `colorSpace =
 * SRGBColorSpace`. The renderer then decodes those bytes *as sRGB*, so an
 * authored 0.055 arrives at the shader as 0.0043 linear. If the author meant
 * 0.055 to be a reflectance — and everyone writing a material from physical
 * reference does — the surface ships about six times too dark and no amount of
 * relief, roughness or lighting work on top of it will show, because it is
 * being added to a hole. That is exactly what happened to the car's tyres:
 * measured at a median of 0.0 out of 255 over 105416 px. See NOTES case 34 and
 * `HANDOVER-car.md`.
 *
 * The check has to be a measurement and not a code review, because the two
 * cases are indistinguishable in the source. A palette *tuned against renders*
 * is already display-referred and is correct however its comment describes it;
 * a palette *taken from reference* is linear and is wrong. Only the delivered
 * number tells them apart, so this tool decodes every colour map the file
 * produces and prints linear reflectance against what the material claims to
 * be.
 *
 * Non-colour maps are checked too, and for the opposite mistake: a roughness or
 * normal map tagged sRGB is the same bug with the sign flipped and would be
 * scene-wide. `hsGray` and `hsNormal` both pass `srgb: false`; this asserts it
 * rather than trusting it.
 */

import * as THREE from "three";
import { makeTyreSkin, makeBollardSkin, makeGrimeField, makePaintedSteel, makeCabinetSteel, makeMouldedPlastic } from "../src/gen/hardsurface.ts";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Mean linear reflectance of a colour texture, decoded the way the GPU will. */
function measure(tex) {
  const d = tex.image.data;
  const n = d.length / 4;
  let r = 0, g = 0, b = 0, lo = 1, hi = 0;
  for (let i = 0; i < n; i++) {
    const lr = srgbToLinear(d[i * 4] / 255);
    const lg = srgbToLinear(d[i * 4 + 1] / 255);
    const lb = srgbToLinear(d[i * 4 + 2] / 255);
    r += lr; g += lg; b += lb;
    const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return { r: r / n, g: g / n, b: b / n, lo, hi, y: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n };
}

/**
 * Plausible linear reflectance for each surface. Deliberately wide: this asks
 * "is it in the right decade", not "is it the right colour".
 *
 * The tyre band is the author's own stated intent — the comment in
 * `makeTyreSkin` says "0.055 (tread) to 0.09 (dusty sidewall)" — which is the
 * honest reference here, because the bug class is a map failing to deliver what
 * it was authored to deliver. It also matches carbon-black rubber, 0.04-0.05,
 * at the clean end.
 *
 * The bollard band is from reference only. Its palette was arrived at by
 * iterating on renders across several rounds, so it is display-referred by
 * construction and correct however its comments read; the band is here to
 * catch a future edit pushing it out of the decade, not to grade it.
 */
const EXPECT = {
  "tyre (carbon-black rubber)": [0.045, 0.095],
  "bollard (weathered safety yellow)": [0.12, 0.55],
};

function main() {
  const colour = [
    ["tyre (carbon-black rubber)", makeTyreSkin(256, 7171).map],
    ["bollard (weathered safety yellow)", makeBollardSkin(256, 0.94, 6161, 0.46).map],
  ];

  let bad = 0;
  console.log("colour maps — mean LINEAR reflectance as the shader will see it\n");
  for (const [name, tex] of colour) {
    const m = measure(tex);
    const [lo, hi] = EXPECT[name];
    const off = m.y < lo ? lo / m.y : m.y > hi ? m.y / hi : 0;
    if (off) bad++;
    console.log(
      `  ${name.padEnd(36)} luminance ${m.y.toFixed(4)}  ` +
        `rgb ${m.r.toFixed(3)}/${m.g.toFixed(3)}/${m.b.toFixed(3)}  range ${m.lo.toFixed(4)}-${m.hi.toFixed(4)}`
    );
    console.log(
      `  ${"".padEnd(36)} expected ${lo}-${hi}` +
        (off ? `   OFF BY ${off.toFixed(1)}x  ${m.y < lo ? "TOO DARK" : "TOO BRIGHT"}` : "   ok")
    );
    if (!tex.colorSpace || tex.colorSpace !== THREE.SRGBColorSpace) {
      console.log(`  ${"".padEnd(36)} !! not tagged sRGB — a colour map must be`);
      bad++;
    }
  }

  console.log("\nnon-colour maps — must NOT be tagged sRGB\n");
  const data = [
    ["grime field", makeGrimeField(128, 9091)],
    ["painted steel normal", makePaintedSteel(512, 0.2, 4242).normalMap],
    ["painted steel roughness", makePaintedSteel(512, 0.2, 4242).roughnessMap],
    ["cabinet steel normal", makeCabinetSteel(512, 0.2, 4243).normalMap],
    ["cabinet steel roughness", makeCabinetSteel(512, 0.2, 4243).roughnessMap],
    ["moulded plastic normal", makeMouldedPlastic(512, 0.1, 5151).normalMap],
    ["moulded plastic roughness", makeMouldedPlastic(512, 0.1, 5151).roughnessMap],
    ["tyre normal", makeTyreSkin(256, 7171).normalMap],
    ["tyre roughness", makeTyreSkin(256, 7171).roughnessMap],
    ["bollard normal", makeBollardSkin(256, 0.94, 6161, 0.46).normalMap],
    ["bollard roughness", makeBollardSkin(256, 0.94, 6161, 0.46).roughnessMap],
    ["bollard metalness", makeBollardSkin(256, 0.94, 6161, 0.46).metalnessMap],
  ];
  for (const [name, tex] of data) {
    const wrong = tex.colorSpace === THREE.SRGBColorSpace;
    if (wrong) bad++;
    console.log(`  ${name.padEnd(28)} ${wrong ? "!! TAGGED sRGB — data map decoded as colour" : "ok"}`);
  }

  console.log(bad ? `\n${bad} problem(s).` : "\nAll maps deliver reflectance in the expected decade and are tagged correctly.");
  process.exit(bad ? 1 : 0);
}

/**
 * The control. If `measure` did not actually apply the sRGB decode it would
 * report authored values back unchanged and every map would look fine, which is
 * precisely the failure being hunted — so plant a known 0.055-authored grey and
 * require the tool to report the 0.0043 the GPU would see.
 */
function selftest() {
  const size = 8;
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.round(0.055 * 255);
    d[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  const m = measure(tex);
  const ok = Math.abs(m.y - 0.0043) < 0.0006;
  console.log(`selftest: a map authored 0.055 delivers ${m.y.toFixed(4)} linear (want ~0.0043)`);
  console.log(`selftest: that is ${(0.055 / m.y).toFixed(1)}x darker than the authored number`);
  console.log(ok ? "selftest PASS" : "selftest FAIL — the sRGB decode is not being applied");
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
