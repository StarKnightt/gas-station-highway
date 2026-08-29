#!/usr/bin/env node
/**
 * Compile-adjacent validation of `applyWorldDetail` with no GPU.
 *
 * `onBeforeCompile` is ordinary JavaScript. The renderer is what calls it, but
 * nothing about it needs a context - so it can be invoked directly against
 * three's own stock `physical` shader source and the result inspected. That gets
 * the two failures this file has actually shipped, both of which cost the project
 * hours and both of which are invisible until a link:
 *
 *  - an undeclared uniform, which the injection-time assertion catches but only
 *    once something renders;
 *  - unbalanced braces or a stray backtick surviving into GLSL.
 *
 * It cannot catch a driver-specific compile error, and it does not claim to. It
 * exists so that authoring under a GPU hold is not authoring blind.
 *
 * Usage: node tools/shaderlint.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsresolve.mjs", pathToFileURL(`${import.meta.dirname}/`));

const THREE = await import("three");
const { applyWorldDetail } = await import("../src/gen/worldDetail.ts");

const tex = () => {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

/** The concrete forecourt's shape: soil, shelter, pools, stain, alt material. */
const cases = [
  {
    name: "concrete forecourt (pools + stain + shelter)",
    opts: {
      key: "concrete",
      macro: tex(),
      macroMetres: 21,
      macroAlbedo: 0.32,
      macroRoughness: 0.12,
      antiTile: 0.4,
      normalFade: true,
      soil: {
        texture: tex(),
        origin: new THREE.Vector2(-140, -140),
        size: new THREE.Vector2(280, 280),
        gain: 0.2,
        wetBase: 0.42,
        mirrorDepth: 0.005,
        stain: 1,
        shelter: { minX: -6.6, maxX: 6.6, minZ: 13.1, maxZ: 26.7, softness: 2.4, floor: 0.3 },
        pools: [
          { x: 1.95, z: 24.6, rx: 1.84, rz: 1.21, level: 0.4873 },
          { x: -2.3, z: 24.32, rx: 1.44, rz: 0.76, level: 0.5064 },
        ],
      },
    },
  },
  {
    name: "asphalt (soil, no stain, default mirrorDepth)",
    opts: {
      key: "asphalt",
      macro: tex(),
      macroMetres: 21,
      soil: {
        texture: tex(),
        origin: new THREE.Vector2(-140, -140),
        size: new THREE.Vector2(280, 280),
        gain: 0.28,
        wetBase: 0.34,
        pools: [{ x: 22.6, z: 38.2, rx: 5.4, rz: 2.6, level: 0.1 }],
      },
    },
  },
  {
    name: "no soil at all (the arms must vanish, not misfire)",
    opts: { key: "bare", macro: tex(), macroMetres: 21 },
  },
];

const stock = THREE.ShaderLib.physical;
let fail = 0;

/** Every check applied to one shader stage, factored out so it is self-testable. */
function problemsIn(label, src) {
  const problems = [];
  // Strip comments before counting, so a brace inside a comment does not report
  // a false imbalance.
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const opens = (bare.match(/\{/g) ?? []).length;
  const closes = (bare.match(/\}/g) ?? []).length;
  if (opens !== closes) problems.push(`${label}: ${opens} '{' vs ${closes} '}'`);
  if (src.includes("`")) problems.push(`${label}: a backtick survived into GLSL`);
  if (/\$\{/.test(src)) problems.push(`${label}: an unexpanded \${} survived into GLSL`);

  const declared = new Set();
  for (const m of bare.matchAll(/\buniform\s+\w+\s+(\w+)/g)) declared.add(m[1]);
  // Locals and struct fields also match /u[A-Z]/, so a reference only counts as
  // a uniform reference if nothing in the source assigns to it.
  for (const m of bare.matchAll(/\bu[A-Z]\w*/g)) {
    const r = m[0];
    if (declared.has(r)) continue;
    if (new RegExp(`\\b(float|vec[234]|mat[234]|int|bool)\\s+${r}\\b`).test(bare)) continue;
    if (new RegExp(`\\b${r}\\s*=`).test(bare)) continue;
    if (/^(uv|uvTransform)/.test(r)) continue;
    problems.push(`${label}: '${r}' referenced but never declared`);
  }
  return [...new Set(problems)];
}

/**
 * Self-test, because three instruments in this project have now returned a
 * confident pass that was predetermined by construction. A check that has never
 * been shown to fail is not a check.
 */
{
  const planted = [
    ["undeclared uniform", `void main() { float x = uNotDeclared; }`, "never declared"],
    ["unbalanced braces", `void main() { if (true) { float x = 1.0; }`, "'{' vs"],
    ["surviving backtick", "uniform float uA;\nvoid main() { float x = uA; } // `oops", "backtick"],
    ["unexpanded template", "uniform float uA;\nvoid main() { float x = ${bad}; }", "${} survived"],
  ];
  let selfFail = 0;
  for (const [name, src, expect] of planted) {
    const got = problemsIn("planted", src);
    const caught = got.some((p) => p.includes(expect));
    if (!caught) {
      selfFail++;
      console.log(`SELFTEST FAIL  ${name}: not caught (got ${JSON.stringify(got)})`);
    }
  }
  // And a clean sample must produce nothing, or the checks are just noisy.
  const clean = problemsIn("planted", `uniform float uA;\nvoid main() { float t = uA * 2.0; }`);
  if (clean.length) {
    selfFail++;
    console.log(`SELFTEST FAIL  clean source reported ${JSON.stringify(clean)}`);
  }
  console.log(
    selfFail
      ? `SELFTEST: ${selfFail} failure(s) — the linter below cannot be trusted`
      : `selftest: 4 planted defects caught, clean sample silent`,
  );
  fail += selfFail;
}
console.log("");

for (const c of cases) {
  const mat = new THREE.MeshStandardMaterial();
  applyWorldDetail(mat, c.opts);
  const shader = {
    vertexShader: stock.vertexShader,
    fragmentShader: stock.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(stock.uniforms),
    defines: {},
  };
  const problems = [];
  try {
    mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } });
  } catch (e) {
    problems.push(`threw: ${e.message}`);
  }

  if (!problems.length) {
    problems.push(...problemsIn("vertex", shader.vertexShader));
    problems.push(...problemsIn("fragment", shader.fragmentShader));
  }

  const injected = shader.fragmentShader.length - stock.fragmentShader.length;
  if (problems.length) {
    fail++;
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        ${p}`);
  } else {
    console.log(`ok    ${c.name}  (+${injected} chars of fragment source)`);
  }
}

// The regression that matters most: asphalt must be untouched by the mirrorDepth
// parameterisation. Its three ramps were literals and are now uWaterThick
// expressions, so the *value* has to come out at the old numbers.
console.log("");
for (const [name, opts, want] of [
  ["asphalt (unset, must keep the old literal)", cases[1].opts, 0.02],
  ["concrete (set)", cases[0].opts, 0.005],
]) {
  const m = new THREE.MeshStandardMaterial();
  applyWorldDetail(m, opts);
  const sh = {
    vertexShader: stock.vertexShader,
    fragmentShader: stock.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(stock.uniforms),
    defines: {},
  };
  m.onBeforeCompile(sh, { capabilities: { isWebGL2: true } });
  const v = sh.uniforms.uWaterThick?.value;
  const ok = typeof v === "number" && Math.abs(v - want) < 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? "ok   " : "FAIL "} uWaterThick ${name}: ${v} (want ${want})`);
}
// And the stain must be inert on every surface that did not ask for it, or the
// parameterisation has changed asphalt while claiming not to.
{
  const m = new THREE.MeshStandardMaterial();
  applyWorldDetail(m, cases[1].opts);
  const sh = {
    vertexShader: stock.vertexShader,
    fragmentShader: stock.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(stock.uniforms),
    defines: {},
  };
  m.onBeforeCompile(sh, { capabilities: { isWebGL2: true } });
  const v = sh.uniforms.uSoilStain?.value;
  const ok = v === 0;
  if (!ok) fail++;
  console.log(`${ok ? "ok   " : "FAIL "} uSoilStain on asphalt: ${v} (want 0 — inert)`);
}

/**
 * REDUCED MODE, and the one assertion that makes its shared program key safe.
 *
 * In reduced mode `customProgramCacheKey` drops the material's name so that
 * materials whose GLSL is identical share one compiled program instead of one
 * each. That is only correct if the source really is identical — and the failure
 * mode if it is not is the worst kind available here: three would hand the
 * second material the FIRST material's compiled shader, silently, with no link
 * error and no warning, and the ground would render with another surface's
 * arms. Nothing downstream could attribute that.
 *
 * So this does not inspect the claim, it asserts it: take two materials whose
 * options differ substantially — different maps, tile sizes, gains, specular
 * dampers, and one with a full `soil` block including pools that the other
 * lacks entirely — put both in reduced mode, and require the injected fragment
 * source to be byte-identical AND the cache keys to match. If a future option is
 * ever interpolated into the GLSL as a literal rather than passed as a uniform,
 * this is what catches it, because that is precisely the change that would make
 * sharing unsafe while leaving every other check green.
 */
/**
 * ...AND IN THE DEFAULT CONFIGURATION TOO, which is now the arm that needs it.
 *
 * This block used to build only with `reduced: true`, which was right while the
 * collapsed key was reduced-only: the non-reduced key contained `opts.key`, so
 * the high path could not share a program by accident and needed no assertion.
 *
 * Collapsing the key at every tier inverts that. The **default** path becomes
 * the one relying on byte-identity, and it was the path with no assertion on it
 * — so the gate would have guarded the arm that no longer needed guarding and
 * left the shipping arm bare. Both modes are now asserted, and `MODES` exists so
 * that adding a third tier cannot quietly go untested.
 *
 * Perf's asymmetry is the rule this is built against: over-splitting wastes
 * seconds, under-splitting produces a plausible wrong frame with no link error
 * and nothing able to attribute it. **Collapsing is only ever safe behind a
 * standing assertion, never behind a one-time measurement.**
 */
const MODES = [
  ["default (shipping path)", false],
  ["reduced (low tier)", true],
];
console.log("");
for (const [modeLabel, modeReduced] of MODES) {
  console.log(`--- program-sharing identity, ${modeLabel} ---`);
  const build = (opts) => {
    const m = new THREE.MeshStandardMaterial();
    applyWorldDetail(m, { ...opts, reduced: modeReduced });
    const sh = {
      vertexShader: stock.vertexShader,
      fragmentShader: stock.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(stock.uniforms),
      defines: {},
    };
    m.onBeforeCompile(sh, { capabilities: { isWebGL2: true } });
    return { src: sh.fragmentShader, key: m.customProgramCacheKey(), uniforms: sh.uniforms };
  };

  const a = build(cases[0].opts); // concrete: soil, pools, stain, shelter
  const b = build(cases[1].opts); // asphalt: soil, no stain, other maps and gains

  const problems = problemsIn(`${modeLabel} fragment`, a.src);
  for (const p of problems) {
    fail++;
    console.log(`FAIL  ${modeLabel} fragment: ${p}`);
  }

  /**
   * THE INVARIANT, which is one-sided and it matters which side.
   *
   *   same key + different source  -> UNSAFE. three hands the second material
   *                                   the first's compiled program. Must fail.
   *   different key + same source  -> merely wasteful. One extra program that
   *                                   is a byte-for-byte duplicate. Report it.
   *
   * A key may always be finer than the source requires; it may never be coarser.
   * Testing for key EQUALITY, which is what this block did first, fails on the
   * harmless side and passes nothing extra — and a check that flags a correct
   * state costs more trust than it saves.
   */
  const pairs = [
    ["concrete vs asphalt", a, b],
    ["asphalt vs paint-like (no anti, no overlay)", b, build({ ...cases[1].opts, antiTile: 0, overlay: undefined })],
  ];
  let wasted = 0;
  for (const [label, p, q] of pairs) {
    const sameSrc = p.src === q.src;
    const sameKey = p.key === q.key;
    if (sameKey && !sameSrc) {
      fail++;
      let i = 0;
      while (i < p.src.length && i < q.src.length && p.src[i] === q.src[i]) i++;
      console.log(`FAIL  ${label}: SHARED KEY, DIFFERENT SOURCE — unsafe`);
      console.log(`        diverges at char ${i}: ${JSON.stringify(p.src.slice(i, i + 80))}`);
      console.log(`                     versus  ${JSON.stringify(q.src.slice(i, i + 80))}`);
      console.log(`        one material would render with the other's arms, silently.`);
    } else if (!sameKey && sameSrc) {
      wasted++;
      console.log(`note  ${label}: identical source, different key — one wasted program`);
      console.log(`        ${p.key.split(":").slice(0, 3).join(":")}`);
      console.log(`        ${q.key.split(":").slice(0, 3).join(":")}`);
    } else {
      console.log(`ok    ${label}: ${sameSrc ? "shares a program" : "genuinely differs, keyed apart"}`);
    }
  }

  if (wasted) {
    console.log(`note  ${wasted} of ${pairs.length} pairs waste a program on an identical shader.`);
  }

  if (!modeReduced) {
    console.log("");
    continue;
  }

  const injected = a.src.length - stock.fragmentShader.length;
  const full = 39070; // what these same materials inject at high tier
  console.log(
    `ok    reduced injects +${injected} chars against +${full} at high ` +
      `(${(100 * (1 - injected / full)).toFixed(0)}% smaller)`
  );

  // The kept arms have to still be there, or "plainer" has become "off". A
  // reduced tier that drops the anti-tiling is the one outcome that reads as a
  // bug rather than as a lower setting.
  for (const [u, want] of [["uAntiTile", 0], ["uMacroAlbedo", 0], ["uMacroScale", 0]]) {
    const v = a.uniforms[u]?.value;
    const ok = typeof v === "number" && v > want;
    if (!ok) fail++;
    console.log(`${ok ? "ok   " : "FAIL "} reduced keeps ${u} = ${v} (must be > ${want})`);
  }
  // And the dropped arms must be gone from the uniform set entirely, not merely
  // set to zero: a declared-but-unread uniform still forces a distinct program
  // through uniformDecls, which is the thing being collapsed.
  for (const u of ["uSoilField", "uWashMap", "uWheelStrength"]) {
    const gone = a.uniforms[u] === undefined;
    if (!gone) fail++;
    console.log(`${gone ? "ok   " : "FAIL "} reduced drops ${u} from the declarations`);
  }
  console.log("");
}

/**
 * `antiTile` MUST NOT REACH THE EMITTED SOURCE. Fatal, and the polarity matters.
 *
 * `useAnti` was in the flag bits but gates no emission — the anti-tile arm is
 * always injected and switched by the `uAntiTile` uniform VALUE. That is why it
 * could be dropped from the key: it was splitting programs whose source is
 * byte-identical, and had been doing so since it was written.
 *
 * This block printed that as a `note` and printed the DANGEROUS state as `ok`,
 * which is exactly backwards. Perf's table:
 *
 *   antiTile changes source?   before collapse        after collapse
 *   ------------------------   --------------------   -----------------------
 *   no                         safe                   safe
 *   yes                        safe, key distinguishes  **UNSAFE**
 *
 * The one state that becomes dangerous was the one labelled `ok`. Once `useAnti`
 * leaves the key, two materials differing only in `antiTile` share a program, so
 * if `antiTile` ever begins to gate emission one of them silently renders with
 * the other's shader — no link error, nothing able to attribute it. The docblock
 * in `worldDetail.ts` predicted this hazard word for word and then did not gate
 * it, so:
 *
 *   antiOn === antiOff  ->  ok    (source-free, safe to collapse)
 *   antiOn !== antiOff  ->  FAIL  (the collapse is now unsound)
 *
 * Worth having whether or not the collapse lands, because the note it replaces
 * described the invariant without enforcing it.
 */
{
  const hi = (opts) => {
    const m = new THREE.MeshStandardMaterial();
    applyWorldDetail(m, opts);
    const sh = {
      vertexShader: stock.vertexShader,
      fragmentShader: stock.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(stock.uniforms),
      defines: {},
    };
    m.onBeforeCompile(sh, { capabilities: { isWebGL2: true } });
    return sh.fragmentShader;
  };
  for (const [label, base] of [["default", {}], ["reduced", { reduced: true }]]) {
    const antiOn = hi({ ...cases[1].opts, ...base, antiTile: 0.85 });
    const antiOff = hi({ ...cases[1].opts, ...base, antiTile: 0 });
    const sourceFree = antiOn === antiOff;
    if (!sourceFree) {
      fail++;
      let i = 0;
      while (i < antiOn.length && i < antiOff.length && antiOn[i] === antiOff[i]) i++;
      console.log(`FAIL  antiTile CHANGES the emitted source in ${label} mode — the collapsed key is unsound`);
      console.log(`        diverges at char ${i}: ${JSON.stringify(antiOn.slice(i, i + 80))}`);
      console.log(`                     versus  ${JSON.stringify(antiOff.slice(i, i + 80))}`);
      console.log(`        put useAnti back in the cache key, or make the arm unconditional again.`);
    } else {
      console.log(`ok    antiTile does not reach the emitted source in ${label} mode (uniform value only)`);
    }
  }
}

process.exit(fail ? 1 : 0);
