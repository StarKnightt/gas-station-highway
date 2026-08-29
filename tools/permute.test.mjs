/**
 * Unit tests for the scatter-shuffle helpers in `src/core/capability.ts`.
 *
 * These exist because the failure mode of a wrong permutation is **a frame that
 * still renders.** Splitting a matrix's sixteen components across two instances
 * produces sheared or displaced objects, which looks like a placement bug in
 * whichever system owns the layer rather than like a bug in the quality lever.
 * So the component-integrity assertion is the load-bearing one here, not the
 * ordering assertion.
 *
 * Run: node tools/permute.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, "tmp", "t");

// Vite 8 transforms TypeScript with oxc rather than esbuild.
const { transformWithOxc } = await import("vite");
const src = fs.readFileSync(path.join(ROOT, "src/core/capability.ts"), "utf8");
const js = (await transformWithOxc(src, "capability.ts", { lang: "ts" })).code;
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, "capability.mjs"), js);
const { mulberry32, permuteInstanceAttribute, tierSettings, classify } = await import(
  pathToFileURL(path.join(TMP, "capability.mjs")).href
);

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// ---- the PRNG ------------------------------------------------------------
// A fixed seed is what keeps a tier's frame reproducible between runs, which is
// what makes a pixel diff of the same tier a valid comparison.
{
  const a = mulberry32(123);
  const b = mulberry32(123);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  check("same seed gives the same sequence", seqA.every((v, i) => v === seqB[i]));

  const c = mulberry32(124);
  const seqC = Array.from({ length: 8 }, () => c());
  check("different seed gives a different sequence", seqA.some((v, i) => v !== seqC[i]));
  check(
    "values stay in [0,1)",
    seqA.every((v) => v >= 0 && v < 1),
    `min ${Math.min(...seqA).toFixed(4)} max ${Math.max(...seqA).toFixed(4)}`
  );
}

// ---- the permutation -----------------------------------------------------
{
  const n = 6;
  const stride = 3;
  const arr = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) for (let c = 0; c < stride; c++) arr[i * stride + c] = i * 10 + c;

  const order = new Uint32Array([3, 0, 5, 1, 4, 2]);
  const attr = { array: arr, needsUpdate: false };
  permuteInstanceAttribute(attr, order, stride);

  const firsts = [];
  for (let i = 0; i < n; i++) firsts.push(arr[i * stride] / 10);
  check("instances land in the requested order", firsts.join(",") === "3,0,5,1,4,2", firsts.join(","));

  let intact = true;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < stride; c++) {
      if (arr[i * stride + c] !== order[i] * 10 + c) intact = false;
    }
  }
  check("all components of an instance move together", intact);
  check("needsUpdate is set so the buffer re-uploads", attr.needsUpdate === true);
}

// ---- stride 16, the case that actually ships ------------------------------
// An instance matrix is sixteen floats. A stride bug here shears geometry rather
// than throwing, so it is worth testing at the real width.
{
  const n = 4;
  const stride = 16;
  const arr = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) for (let c = 0; c < stride; c++) arr[i * stride + c] = i * 100 + c;
  const order = new Uint32Array([2, 3, 0, 1]);
  permuteInstanceAttribute({ array: arr, needsUpdate: false }, order, stride);

  let ok = true;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < stride; c++) {
      if (arr[i * stride + c] !== order[i] * 100 + c) ok = false;
    }
  }
  check("a 16-float instance matrix permutes intact", ok);
}

// ---- a full shuffle is a permutation, not a resample ---------------------
// Fisher-Yates as used in `ensureScatterShuffled`. If this ever degraded into
// sampling with replacement, some instances would be drawn twice and others
// dropped, and the frame would still render.
{
  const n = 500;
  const rng = mulberry32(0x5ca77e2 ^ n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const seen = new Set(order);
  check("shuffle keeps every instance exactly once", seen.size === n, `${seen.size} distinct of ${n}`);
  check("shuffle actually reorders", order.some((v, i) => v !== i));

  // The point of the shuffle: a prefix of the shuffled order must be spread
  // across the original range, not clustered at the front. This is the assertion
  // that would have caught the truncation bug.
  const prefix = Array.from(order.slice(0, Math.round(n * 0.25)));
  const mean = prefix.reduce((a, b) => a + b, 0) / prefix.length;
  const expected = (n - 1) / 2;
  check(
    "a 25% prefix samples the whole range rather than its head",
    Math.abs(mean - expected) < n * 0.08,
    `mean index ${mean.toFixed(1)}, expected ~${expected}`
  );
}

// ---- tier definitions ----------------------------------------------------
{
  const high = tierSettings("high");
  const low = tierSettings("low");
  check("low is cheaper than high on the run-time family", low.shadowMapSize < high.shadowMapSize && low.scatterDensity < high.scatterDensity);
  check("low pulls compile-time levers too", low.shadowFilter !== high.shadowFilter && low.transmission === false);
  check("no tier disables shadows entirely", high.shadowFilter !== "none" && low.shadowFilter !== "none");

  // Demotion must be one-way: a later clear signal cannot promote past an
  // earlier veto, or the order of checks silently decides the tier.
  const soft = classify({
    renderer: "Google SwiftShader",
    vendor: "Google",
    software: true,
    webgl2: true,
    maxTextureSize: 16384,
    maxRenderBufferSize: 16384,
    maxTextureUnits: 16,
    maxSamples: 8,
    maxAnisotropy: 16,
    parallelShaderCompile: true,
    deviceMemoryGb: 8,
    cpuThreads: 16,
    devicePixelRatio: 1,
    screenPx: 1920 * 1080,
  });
  check("a software rasteriser forces low regardless of other clear signals", soft.tier === "low", soft.reasons.join("; "));
}

console.log("");
if (failures.length) {
  console.error(`FAIL — ${failures.length} assertion(s): ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("PASS — all assertions held.");
}
