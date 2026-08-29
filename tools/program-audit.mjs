#!/usr/bin/env node
/**
 * `node tools/program-audit.mjs`
 *
 * A census of every linked shader program: who owns it, what distinguishes it
 * from its near-twins, and how much of init is spent stalled on the compiler.
 *
 * ## Why
 *
 * Program count went 70 -> 144 overnight, and init is the phase in which the
 * user's browser died. A count on its own cannot tell 144 cheap variants from
 * 70 expensive ones, and it cannot tell a *necessary* variant from one that
 * differs only in a constant that was never substituted into the source. Both
 * questions need the cache keys, not the count.
 *
 * Three keys programs on `getProgramCacheKey(parameters)`, a comma-joined list
 * of every material parameter that changes the generated GLSL, plus
 * `customProgramCacheKey()`. Two programs whose keys differ in exactly one
 * token are near-duplicates, and the token names the reason. That is a
 * mechanical question with a mechanical answer, which is the opposite of the
 * mistake made last round — an `onBeforeCompile` was written up as a cache-key
 * defect from pattern recognition, without checking whether the generated
 * source actually differed. It did not. So this reads three's own key rather
 * than inferring anything.
 *
 * Reports:
 *  - programs, and the split between those used once and those shared
 *  - clusters of keys differing in exactly one token, with the differing values
 *  - per-owner attribution, via the renderer's own material->program map
 *  - `blockedMs`: wall time stalled on `LINK_STATUS`, which is the init cost
 *
 * Port 5152. Builds into `tmp/programaudit/`. Node built-ins plus vite and
 * playwright, same teardown contract as every harness here.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import { launchOptions, assertHardwareGpu, isSoftwareRenderer, assertSceneGpu } from "./gpu.mjs";
import { assertBuildIntact, assertPrivateBuildDir, scratchDir } from "./scratch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const OUT_DIR = path.join(ROOT, "tools/perf-out");
const BUILD_DIR = scratchDir(ROOT, "programaudit");
const WIDTH = 1920;
const HEIGHT = 1080;
const DO_BUILD = !process.argv.includes("--no-build");
const SHOT = (process.argv.find((a) => a.startsWith("--shot=")) ?? "--shot=lot").slice(7);
const QUERY = (process.argv.find((a) => a.startsWith("--query=")) ?? "--query=").slice(8);

const resources = { server: null, browser: null };
let down = false;
async function shutdown(code, reason) {
  if (down) return;
  down = true;
  if (reason) console.error(`[progaudit] ${reason}`);
  for (const [label, fn] of [
    ["browser", async () => resources.browser && (await resources.browser.close())],
    [
      "preview server",
      async () => {
        const s = resources.server;
        if (!s) return;
        if (typeof s.close === "function") await s.close();
        else if (s.httpServer) await new Promise((r) => s.httpServer.close(r));
      },
    ],
  ]) {
    try {
      await fn();
    } catch (err) {
      console.error(`[progaudit] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  const held = await portInUse(PORT);
  console.log(held ? `[progaudit] !! port ${PORT} still has a listener` : `[progaudit] port ${PORT} clear`);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? e));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? e));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    setTimeout(() => done(false), 700);
  });
}

/**
 * Runs in the page. Reads the renderer's own program cache rather than
 * reconstructing anything.
 */
const PAGE_AUDIT = () => {
  const g = window.__GAME;
  const renderer = g.renderer;
  const S = window.__GLSTAT;

  /* ## The program list
   *
   * `renderer.info.programs` is three's live `WebGLProgramCache` array. Each
   * entry carries the `cacheKey` the program was keyed on and `usedTimes`, the
   * number of materials sharing it. `usedTimes === 1` on a large fraction is
   * the signature of variant explosion. */
  const programs = (renderer.info.programs ?? []).map((p) => ({
    key: String(p.cacheKey ?? ""),
    usedTimes: p.usedTimes ?? 0,
    id: p.id ?? null,
  }));

  /* ## Owner attribution
   *
   * `renderer.properties` is the WeakMap three uses for per-material state, and
   * `currentProgram` on it is the program that material last rendered with. It
   * is not a documented API, so this is guarded: if it is unavailable the
   * report says so rather than silently attributing nothing. */
  const props = renderer.properties;
  const canAttribute = !!(props && typeof props.get === "function");

  /** Nearest named ancestor, which in this scene is the system's group. */
  const ownerOf = (obj) => {
    for (let o = obj; o; o = o.parent) if (o.name) return o.name;
    return "(unnamed)";
  };

  const byKey = new Map();
  const materials = [];
  const seen = new Set();
  g.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      let key = null;
      if (canAttribute) {
        try {
          key = props.get(m)?.currentProgram?.cacheKey ?? null;
        } catch {
          key = null;
        }
      }
      let custom = null;
      try {
        custom = typeof m.customProgramCacheKey === "function" ? m.customProgramCacheKey() : null;
      } catch {
        custom = "(threw)";
      }
      const rec = {
        owner: ownerOf(o),
        name: m.name || "(unnamed)",
        type: m.type,
        hasHook: typeof m.onBeforeCompile === "function" && m.onBeforeCompile !== Object.getPrototypeOf(m).onBeforeCompile,
        customKeyLen: custom ? String(custom).length : 0,
        defines: m.defines ? Object.keys(m.defines).length : 0,
        programKey: key,
      };
      materials.push(rec);
      if (key) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(rec);
      }
    }
  });

  /* ## Near-duplicate clustering
   *
   * Two keys with the same token count that differ at exactly one position are
   * the same shader parameterised one way apart. Grouping by "everything except
   * position i" finds every such family in one pass, and the differing values
   * name what the family is parameterised on — which is the difference between
   * "seven materials legitimately need seven normal maps" and "seven programs
   * exist because a uniform was put in the cache key". */
  const families = new Map();
  for (const p of programs) {
    const tok = p.key.split(",");
    for (let i = 0; i < tok.length; i++) {
      const masked = `${tok.length}|${i}|${tok.slice(0, i).join(",")}\u0000${tok.slice(i + 1).join(",")}`;
      if (!families.has(masked)) families.set(masked, { at: i, members: [] });
      families.get(masked).members.push({ value: tok[i], usedTimes: p.usedTimes, key: p.key });
    }
  }
  const nearDuplicates = [];
  const claimed = new Set();
  for (const [, fam] of [...families].sort((a, b) => b[1].members.length - a[1].members.length)) {
    if (fam.members.length < 2) continue;
    // A program may sit in several families; report it once, in the largest.
    if (fam.members.some((m) => claimed.has(m.key))) continue;
    for (const m of fam.members) claimed.add(m.key);
    const owners = new Set();
    for (const m of fam.members) for (const r of byKey.get(m.key) ?? []) owners.add(r.owner);
    nearDuplicates.push({
      tokenIndex: fam.at,
      count: fam.members.length,
      values: fam.members.map((m) => m.value),
      usedTimes: fam.members.map((m) => m.usedTimes),
      owners: [...owners].slice(0, 8),
      sharedKeyPrefix: fam.members[0].key.split(",").slice(0, fam.at).join(",").slice(-90),
    });
  }

  /* ## The inverse of last round's question
   *
   * `texture-audit.mjs` asks whether two materials sharing a cache key generate
   * *different* source — a correctness bug, and the answer is no, 0 across 51
   * groups. That leaves the question that actually costs init: do two materials
   * with *different* keys generate **identical** source? Each such pair is a
   * program compiled twice for nothing.
   *
   * The hook is run against a mock shader and the result hashed, exactly as in
   * texture-audit, because the only thing that matters is the text handed to
   * `compile`. What this cannot see is a difference three itself introduces
   * from material parameters — a material with a `map` and one without
   * legitimately differ — so a family is only reported as wasteful when the
   * *program* keys differ in one token and that token is the custom key. The
   * hook hash and the token clustering have to agree before anything is
   * claimed. */
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  /* The mock has to contain every `#include` token the hooks in this codebase
   * actually target, or a hook's `.replace()` finds nothing, no-ops, and two
   * genuinely different hooks produce byte-identical output — a false positive
   * with the same shape as the finding.
   *
   * The first version of this mock had `#include <common>` and nothing else. It
   * reported 51 materials with 21 distinct keys as one shader, and 91 materials
   * as another, including `sky-dome`, which has no hook at all. Both were
   * artefacts of the mock, not near-duplicates.
   *
   * These 15 tokens are grepped from the hooks in `src/gen` and `src/systems`.
   * The residual limitation is real and stated in the output: a hook matching
   * on the *body* of a chunk rather than its include directive still no-ops
   * here, so a family whose members all use three's default key — the hook's
   * own source text — cannot be established by this method and is reported
   * separately as unestablished rather than as a saving. */
  /* The union of the tokens grepped from this codebase's hooks and the list
   * already in `texture-audit.mjs`.
   *
   * That file had the thorough mock from the start. This one was written from
   * scratch on the same night by the same author and shipped with a single
   * token, which is the whole defect: **the mechanism was already solved
   * correctly in a sibling file and reimplemented rather than shared.** Neither
   * copy is wrong now, but there are two of them, and the next person to add a
   * hook targeting a new chunk has to remember to update both. */
  const CHUNKS = [
    "common", "begin_vertex", "roughnessmap_fragment", "map_fragment", "normal_fragment_maps",
    "beginnormal_vertex", "worldpos_vertex", "tonemapping_fragment", "opaque_fragment",
    "normal_fragment_begin", "lights_physical_fragment", "lights_fragment_maps",
    "colorspace_fragment", "color_fragment", "alphamap_fragment",
    "project_vertex", "fog_vertex", "defaultnormal_vertex", "uv_vertex", "emissivemap_fragment",
    "transmission_fragment", "dithering_fragment", "alphatest_fragment", "metalnessmap_fragment",
    "aomap_fragment", "clipping_planes_fragment", "output_fragment", "fog_fragment",
  ];
  const mockShader = () => ({
    uniforms: {},
    vertexShader: `${CHUNKS.map((c) => `#include <${c}>`).join("\n")}\nvoid main(){\n${CHUNKS.map((c) => `#include <${c}>`).join("\n")}\ngl_Position = vec4(0.0); }`,
    fragmentShader: `${CHUNKS.map((c) => `#include <${c}>`).join("\n")}\nvoid main(){\n${CHUNKS.map((c) => `#include <${c}>`).join("\n")}\ngl_FragColor = vec4(1.0); }`,
    defines: {},
  });
  // Three's default key is the hook's own source text, so a key that looks like
  // a function is a material that never set one. Families made only of those
  // depend entirely on the mock and are not claimed as savings.
  const isDefaultKey = (k) => /^\s*(\(|function|onBeforeCompile\s*\()/.test(k) || k.includes("=>");

  const byGenerated = new Map();
  for (const o of []) void o; // keep the shape obvious; the loop is below
  {
    const seenMat2 = new Set();
    g.scene.traverse((obj) => {
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) {
        if (!m || seenMat2.has(m.uuid)) continue;
        seenMat2.add(m.uuid);
        if (typeof m.onBeforeCompile !== "function") continue;
        let custom = null;
        try {
          custom = typeof m.customProgramCacheKey === "function" ? m.customProgramCacheKey() : null;
        } catch {
          continue;
        }
        if (!custom) continue;
        let hash;
        try {
          const sh = mockShader();
          m.onBeforeCompile(sh, renderer);
          hash = fnv(`${sh.vertexShader}\u0000${sh.fragmentShader}\u0000${Object.keys(sh.defines ?? {}).sort().join(",")}`);
        } catch (e) {
          hash = `threw:${e.message.slice(0, 30)}`;
        }
        if (!byGenerated.has(hash)) byGenerated.set(hash, []);
        byGenerated.get(hash).push({ owner: ownerOf(obj), key: String(custom), type: m.type });
      }
    });
  }

  const wasted = [];
  const unestablished = [];
  for (const [hash, group] of byGenerated) {
    const keys = new Set(group.map((e) => e.key));
    if (group.length < 2 || keys.size < 2) continue;
    const rec = {
      generated: hash,
      materials: group.length,
      distinctKeys: keys.size,
      owners: [...new Set(group.map((e) => e.owner))].slice(0, 8),
      keys: [...keys].slice(0, 8).map((k) => (k.length > 60 ? `${k.slice(0, 60)}…` : k)),
    };
    // Claimed only when every key in the family is a deliberate, readable key.
    // A family containing a default key is a family whose members may differ in
    // ways the mock cannot see.
    ([...keys].every((k) => !isDefaultKey(k)) ? wasted : unestablished).push(rec);
  }
  wasted.sort((a, b) => b.distinctKeys - a.distinctKeys);
  unestablished.sort((a, b) => b.distinctKeys - a.distinctKeys);

  const byOwner = {};
  for (const [key, recs] of byKey) {
    for (const owner of new Set(recs.map((r) => r.owner))) {
      byOwner[owner] ??= { programs: 0, materials: 0, withHook: 0 };
      byOwner[owner].programs++;
    }
  }
  for (const r of materials) {
    byOwner[r.owner] ??= { programs: 0, materials: 0, withHook: 0 };
    byOwner[r.owner].materials++;
    if (r.hasHook) byOwner[r.owner].withHook++;
  }

  return {
    linkedByGl: S.programs.linked,
    createdByGl: S.programs.created,
    deletedByGl: S.programs.deleted,
    inRendererCache: programs.length,
    usedOnce: programs.filter((p) => p.usedTimes === 1).length,
    shaderTime: S.shaderTime,
    linkWindow: { firstLinkMs: S.programs.firstLinkMs, lastLinkMs: S.programs.lastLinkMs },
    materials: materials.length,
    materialsWithHook: materials.filter((m) => m.hasHook).length,
    attributed: canAttribute ? materials.filter((m) => m.programKey).length : null,
    byOwner: Object.fromEntries(Object.entries(byOwner).sort((a, b) => b[1].programs - a[1].programs)),
    nearDuplicates: nearDuplicates.slice(0, 20),
    nearDuplicateTotal: nearDuplicates.reduce((a, f) => a + f.count, 0),
    hookGroups: byGenerated.size,
    wasted,
    unestablished,
    wastedPrograms: wasted.reduce((a, w) => a + (w.distinctKeys - 1), 0),
    keyLengths: {
      min: Math.min(...programs.map((p) => p.key.length)),
      max: Math.max(...programs.map((p) => p.key.length)),
      tokens: [...new Set(programs.map((p) => p.key.split(",").length))].sort((a, b) => a - b),
    },
  };
};

async function run() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (DO_BUILD) {
    assertPrivateBuildDir(ROOT, BUILD_DIR, "progaudit");
    console.log("[progaudit] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true, minify: false } });
  }
  assertBuildIntact(ROOT, BUILD_DIR, "progaudit", "preview start");

  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({}));
  const page = await resources.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const instrument = await fs.readFile(path.join(ROOT, "tools/perf-instrument.js"), "utf8");
  await page.addInitScript({ content: instrument });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));

  /* 90 s, not playwright's default 30 s. The first navigation only exists to
   * give `assertHardwareGpu` a context to query, but it is also the moment the
   * preview server first has to answer, and on a host with six agents building
   * concurrently that took longer than 30 s once — producing a bare
   * "Timeout 30000ms exceeded" that looks exactly like the build-wipe failure
   * in NOTES case 43 and is nothing of the kind. A default that is too short on
   * a loaded machine manufactures the opaque failures this round is about. */
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const gpu = await assertHardwareGpu(page, { tag: "progaudit" });
  if (isSoftwareRenderer(gpu?.renderer)) throw new Error(`software renderer: ${gpu?.renderer}`);

  assertBuildIntact(ROOT, BUILD_DIR, "progaudit", `shot=${SHOT}`);
  const t0 = Date.now();
  await page.goto(`${base}?shot=${SHOT}${QUERY ? `&${QUERY}` : ""}`, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  const readyMs = Date.now() - t0;
  await assertSceneGpu(page, { tag: "progaudit" });

  // Programs are linked lazily on first render of each material, so a census
  // taken at __SCENE_READY undercounts. Render enough frames that every visible
  // material has been through the pipeline at least once.
  await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const tick = () => (++n < 90 ? requestAnimationFrame(tick) : res());
        requestAnimationFrame(tick);
      })
  );

  const result = await page.evaluate(PAGE_AUDIT);
  result.readyMs = readyMs;

  /* ## A second opinion on the compile share of init
   *
   * `blockedMs` times the synchronous driver queries three makes per program,
   * which is where a serial compile stalls. But ANGLE on D3D11 may defer real
   * compilation, and if `KHR_parallel_shader_compile` is present three polls
   * `COMPLETION_STATUS_KHR` instead of blocking — in which case the wait lands
   * in frames that draw nothing and `blockedMs` *under*-reports.
   *
   * So: reload the same URL in the same browser. The driver's shader cache is
   * warm, every program links from a binary, and all the procedural generation
   * runs again from scratch. The drop is an upper bound on the compile share.
   *
   * It is an upper bound and not a measurement, because a reload also warms V8
   * and the HTTP cache, so generation itself gets faster for reasons that have
   * nothing to do with shaders. Two bounds that agree are worth more than
   * either alone; two that disagree say the confound is doing the work. */
  result.initTimings = await page.evaluate(() => window.__INIT_TIMINGS ?? null);
  // Populated only for systems that have adopted `initPhases()` from
  // `src/core/initPhase.ts`. Absent is the normal state, not an error.
  result.initPhases = await page.evaluate(() => window.__INIT_PHASES ?? null);
  result.parallelCompile = await page.evaluate(() => {
    const gl = window.__GAME?.renderer?.getContext?.();
    if (!gl) return null;
    return {
      extension: !!gl.getExtension("KHR_parallel_shader_compile"),
      threeCapability: window.__GAME.renderer.capabilities?.parallelShaderCompile ?? null,
    };
  });

  assertBuildIntact(ROOT, BUILD_DIR, "progaudit", "reload control");
  const t1 = Date.now();
  await page.goto(`${base}?shot=${SHOT}${QUERY ? `&${QUERY}` : ""}&reload=1`, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  result.reloadReadyMs = Date.now() - t1;
  result.reloadShaderTime = await page.evaluate(() => window.__GLSTAT.shaderTime);
  result.reloadPrograms = await page.evaluate(() => window.__GLSTAT.programs.linked);
  result.shot = SHOT;
  result.query = QUERY || null;
  result.gpu = gpu?.renderer ?? null;
  result.pageErrors = errors;

  const pct = (n) => `${((100 * n) / Math.max(1, result.inRendererCache)).toFixed(0)}%`;
  console.log(`\n====== program census: shot=${SHOT}${QUERY ? ` ${QUERY}` : ""} ======`);
  console.log(`  gpu                 ${result.gpu}`);
  console.log(`  scene ready         ${(result.readyMs / 1000).toFixed(1)} s`);
  console.log(`  programs (three)    ${result.inRendererCache}`);
  console.log(`  programs (gl link)  ${result.linkedByGl}  created ${result.createdByGl}  deleted ${result.deletedByGl}`);
  console.log(`  used by 1 material  ${result.usedOnce}  (${pct(result.usedOnce)})`);
  console.log(`  materials           ${result.materials}, of which ${result.materialsWithHook} have an onBeforeCompile`);
  console.log(
    `  attributed          ${result.attributed ?? "unavailable (renderer.properties not exposed)"}` +
      `${result.attributed ? ` / ${result.materials} materials` : ""}`
  );
  console.log(
    `  compile stall       ${result.shaderTime.blockedMs.toFixed(0)} ms blocked on the driver ` +
      `(worst single ${result.shaderTime.worstBlockMs.toFixed(1)} ms), ${result.shaderTime.queuedMs.toFixed(0)} ms queueing`
  );
  console.log(
    `                      = ${((100 * result.shaderTime.blockedMs) / Math.max(1, result.readyMs)).toFixed(1)}% of init`
  );
  const fl = result.linkWindow.firstLinkMs;
  const ll = result.linkWindow.lastLinkMs;
  if (fl !== null) {
    console.log(
      `  link window         first link at ${(fl / 1000).toFixed(1)} s, last at ${(ll / 1000).toFixed(1)} s ` +
        `-> all ${result.linkedByGl} programs inside a ${((ll - fl) / 1000).toFixed(1)} s window`
    );
    console.log(
      `                      ${(fl / 1000).toFixed(1)} s of init happened before any shader was linked ` +
        `(= ${((100 * fl) / Math.max(1, result.readyMs)).toFixed(0)}% of init contains no shader work at all)`
    );
  }
  console.log(
    `  parallel compile    extension=${result.parallelCompile?.extension} three=${result.parallelCompile?.threeCapability}` +
      ` (if true, blockedMs under-reports and the reload bound matters more)`
  );
  console.log(
    `  reload control      ${(result.reloadReadyMs / 1000).toFixed(1)} s ready with a warm shader cache ` +
      `(${(((result.readyMs - result.reloadReadyMs) / 1000)).toFixed(1)} s faster; upper bound on compile, ` +
      `also warms V8), ${result.reloadShaderTime.blockedMs.toFixed(0)} ms blocked`
  );
  console.log(`  key length          ${result.keyLengths.min}..${result.keyLengths.max} chars, ${result.keyLengths.tokens.length} distinct token counts`);

  if (result.initTimings) {
    const ranked = Object.entries(result.initTimings).sort((a, b) => b[1] - a[1]);
    const sum = ranked.reduce((a, [, ms]) => a + ms, 0);
    console.log(`\n-- where init actually goes (${(sum / 1000).toFixed(1)} s in system init of a ${(result.readyMs / 1000).toFixed(1)} s load) --`);
    for (const [name, ms] of ranked) {
      const share = (100 * ms) / Math.max(1, sum);
      console.log(`  ${name.padEnd(14)} ${(ms / 1000).toFixed(2).padStart(6)} s  ${share.toFixed(1).padStart(5)}%  ${"#".repeat(Math.round(share / 2))}`);
    }
    console.log(
      `  ${"shader compile".padEnd(14)} ${(result.shaderTime.blockedMs / 1000).toFixed(2).padStart(6)} s  ` +
        `${((100 * result.shaderTime.blockedMs) / Math.max(1, sum)).toFixed(1).padStart(5)}%  (interleaved in the above, not additional)`
    );
  }

  if (result.initPhases && Object.keys(result.initPhases).length) {
    for (const [sys, rep] of Object.entries(result.initPhases)) {
      console.log(`\n-- ${sys} init sub-phases (${(rep.totalMs / 1000).toFixed(2)} s) --`);
      for (const p of rep.phases) {
        console.log(`  ${p.label.padEnd(28)} ${(p.ms / 1000).toFixed(2).padStart(6)} s  ${((100 * p.ms) / Math.max(1, rep.totalMs)).toFixed(1).padStart(5)}%`);
      }
      if (rep.unaccountedMs > 1) {
        console.log(`  ${"UNACCOUNTED".padEnd(28)} ${(rep.unaccountedMs / 1000).toFixed(2).padStart(6)} s  ${((100 * rep.unaccountedMs) / Math.max(1, rep.totalMs)).toFixed(1).padStart(5)}%`);
      }
    }
  }

  console.log(`\n-- programs and materials by owner --`);
  for (const [owner, v] of Object.entries(result.byOwner).slice(0, 18)) {
    console.log(`  ${String(owner).padEnd(24)} ${String(v.programs).padStart(3)} programs  ${String(v.materials).padStart(3)} materials  ${String(v.withHook).padStart(3)} hooked`);
  }

  console.log(
    `\n-- families of programs differing in exactly one cache-key token ` +
      `(${result.nearDuplicates.length} families, ${result.nearDuplicateTotal} programs) --`
  );
  if (!result.nearDuplicates.length) console.log("  none — every program differs from every other in more than one parameter");
  for (const f of result.nearDuplicates) {
    const vals = f.values.map((v) => (v.length > 14 ? `${v.slice(0, 14)}…` : v)).join(" | ");
    console.log(`  ${String(f.count).padStart(2)} programs differ only at token ${String(f.tokenIndex).padStart(3)}: ${vals}`);
    console.log(`     shared by: ${f.owners.join(", ")}   usedTimes: ${f.usedTimes.join(",")}`);
  }
  console.log(
    `\n-- distinct cache keys that generate IDENTICAL source ` +
      `(${result.wasted.length} families over ${result.hookGroups} hook groups, ` +
      `${result.wastedPrograms} program(s) compiled for nothing) --`
  );
  if (!result.wasted.length) {
    console.log("  none — every distinct cache key corresponds to distinct generated source");
  }
  for (const w of result.wasted) {
    console.log(`  ${w.materials} materials, ${w.distinctKeys} distinct keys, one generated shader (${w.generated})`);
    console.log(`     owners: ${w.owners.join(", ")}`);
    for (const k of w.keys) console.log(`     key: ${k}`);
  }
  console.log(
    `\n-- families that CANNOT be established this way (${result.unestablished.length}): every member uses three's\n` +
      `   default key, which is the hook's own source text, so identical output against a mock shader may only\n` +
      `   mean the hook's replace targets are absent from the mock. Not claimed as savings. --`
  );
  for (const w of result.unestablished) {
    console.log(`  ${w.materials} materials, ${w.distinctKeys} distinct keys, same mock output (${w.generated}) — owners: ${w.owners.slice(0, 5).join(", ")}`);
  }

  if (result.pageErrors.length) {
    console.log(`\n-- page errors (${result.pageErrors.length}) --`);
    for (const e of result.pageErrors.slice(0, 6)) console.log(`  ${e}`);
  }
  console.log("======================================================");

  const out = path.join(OUT_DIR, `program-audit-${SHOT}${QUERY ? `-${QUERY.replace(/[^a-z0-9]+/gi, "-")}` : ""}.json`);
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[progaudit] wrote ${path.relative(ROOT, out)}`);
  await page.close();
}

await run().then(
  () => shutdown(0),
  (err) => shutdown(1, err?.stack ?? String(err))
);
