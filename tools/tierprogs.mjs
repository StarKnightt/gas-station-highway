#!/usr/bin/env node
/**
 * tierprogs.mjs — does the program count actually fall at a lower tier?
 *
 *   node tools/tierprogs.mjs [high,low]
 *
 * WHY THIS EXISTS AS A SEPARATE INSTRUMENT
 * ----------------------------------------
 * The tier system's whole justification is the compile-time cost family: 92% of
 * a four-minute cold load is the driver linking programs. So the pass criterion
 * for any tier hook is `renderer.info.programs.length`, and the failure mode to
 * guard against is a hook that parses its flag, threads it through, reads
 * correctly at every layer, and changes no programs — which looks exactly like
 * a hook that works, because the flag is observable and the count was not.
 *
 * Perf's first tier run printed `?` for that column and reported PASS. That is
 * the shape of thing this project has now hit seven times in a day: a check
 * validating the layer above the one that matters. This tool exists so the
 * number is read from inside GL, per tier, in one run, with the two tiers
 * compared against each other rather than against a remembered figure.
 *
 * WHAT IT READS, AND WHY THE CACHE KEYS MATTER MORE THAN THE COUNT
 * ---------------------------------------------------------------
 * `renderer.info.programs` is three's live program cache. Each entry carries the
 * `cacheKey` it was keyed on, and that key is the only thing that says *who*
 * asked for the program. A bare count tells you a tier moved something; the keys
 * tell you whether it moved YOUR something, which is the difference between
 * taking credit and having a result. `applyWorldDetail` keys its programs
 * `wd:<name>:<flags>`, so Terrain's contribution is greppable.
 *
 * Programs are created lazily on first render of a material, so this waits for
 * `__SCENE_READY` and then for several drawn frames. Reading the count before
 * anything is drawn returns a small honest number that looks like a huge win.
 *
 * Ports: 5132, Terrain's second. Renders, so the GPU is asserted per tier.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import net from "node:net";
import { launchOptions, assertSceneGpu } from "./gpu.mjs";

const PORT = 5132;

/**
 * Arms are `tier` or `tier+tforceToken`. The second form is the isolated arm:
 * `high+lodetail` changes exactly one lever, so a program-count delta against
 * plain `high` is attributable to that lever. `low` changes the shadow filter,
 * the shadow map, world capture and the detail patches together, which is
 * enough to prove the tier does something and not enough to prove which part.
 */
const ARMS = (process.argv[2] ?? "high,high+lodetail,low")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [tier, force] = s.split("+");
    if (!["high", "medium", "low"].includes(tier)) {
      console.error(`[tierprogs] unknown tier "${tier}" in arm "${s}"; expected high, medium or low`);
      process.exit(2);
    }
    return { label: s, tier, force: force ?? null };
  });

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    setTimeout(() => (s.destroy(), resolve(false)), 800);
  });
}

/** Pulled out of the page so the grouping rule is reviewable here, not inline. */
function summarise(programs) {
  const groups = new Map();
  for (const key of programs) {
    // three's `getProgramCacheKey` puts `shaderID` FIRST and appends
    // `customProgramCacheKey` LAST, so every key here begins "physical" and an
    // owner tag can only ever be found by substring. Matching on the prefix
    // returned 0 for applyWorldDetail on the first run of this tool, which is
    // the same defect it was built to catch: a confident zero from an instrument
    // pointed at the wrong end of the string.
    const m = /^([a-z0-9_]+)/i.exec(key);
    const g = key.includes("wd:") ? "wd (applyWorldDetail)" : (m?.[1] ?? "?");
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1]);
}

let server;
let browser;
const results = [];
try {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} already has a listener; refusing to start`);
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { port: PORT, strictPort: true },
    logLevel: "warn",
  });
  await server.listen();
  console.log(`[tierprogs] dev server on :${PORT}`);

  browser = await chromium.launch(launchOptions());

  for (const arm of ARMS) {
    const { label, tier, force } = arm;
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      const t = m.text();
      if (/ERROR: |link error|failed to compile/i.test(t)) errors.push(t);
    });

    const url = `http://localhost:${PORT}/?tier=${tier}${force ? `&tforce=${force}` : ""}`;
    await page.goto(url, { waitUntil: "load", timeout: 180000 });
    await page.waitForFunction("window.__SCENE_READY === true", null, { timeout: 600000 });
    await assertSceneGpu(page, { tag: `tierprogs ${label}` });

    /**
     * Time to 30 frames. **DO NOT QUOTE THIS AS A COLD-LOAD SAVING.**
     *
     * It was added to report the thing the tier exists to cut — the unbroken
     * main-thread block that is the driver linking — and it cannot, because all
     * the arms in one run share a browser process and therefore share the
     * driver's program cache. Arm 1 pays the link cost and arms 2 and 3 are warm
     * by construction, so the numbers fall for a reason that has nothing to do
     * with the tier. The first measured run showed 0.7s, 0.7s, 0.3s, which would
     * have read as a 0.4 s win from the reduced path and was cache order.
     *
     * Left in, clearly labelled, because it is still useful as a sanity check
     * that frames are being drawn at all, and because deleting it would leave
     * the next person to re-derive why it cannot work. A cold measurement needs
     * one fresh browser per arm with the driver cache cleared between them,
     * which is a different tool.
     *
     * Waiting on frames rather than sleeping is load-bearing for the COUNT,
     * though: programs are created on first draw, so a count read early is a
     * flattering count.
     */
    const t0 = Date.now();
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => (++n >= 30 ? res() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        })
    );
    const stallMs = Date.now() - t0;

    const got = await page.evaluate(() => {
      const g = window.__GAME;
      const r = g?.renderer;
      const list = r?.info?.programs;
      return {
        settings: g?.quality ?? g?.settings ?? null,
        tier: document.location.search,
        programs: Array.isArray(list) ? list.map((p) => String(p.cacheKey ?? "")) : null,
        terrain: window.__TERRAIN ?? null,
      };
    });

    if (got.programs === null) {
      throw new Error(
        `[tierprogs] ${label}: renderer.info.programs is not an array. A frame was drawn, so this is ` +
          `the probe failing to reach the renderer, not a scene with no programs. Refusing to ` +
          `report a count of 0.`
      );
    }
    if (errors.length) throw new Error(`[tierprogs] ${label}: page reported\n  ${errors.slice(0, 4).join("\n  ")}`);

    results.push({ tier: label, programs: got.programs, terrain: got.terrain, stallMs });
    await page.close();
  }

  console.log("");
  for (const r of results) {
    const wd = r.programs.filter((k) => k.includes("wd:"));
    console.log(`=== arm ${r.tier}: ${r.programs.length} programs, ${(r.stallMs / 1000).toFixed(1)}s to 30 frames`);
    for (const [g, n] of summarise(r.programs)) console.log(`    ${String(n).padStart(4)}  ${g}`);
    if (wd.length) {
      console.log(`    applyWorldDetail keys:`);
      for (const k of [...new Set(wd)].sort()) console.log(`      ${k}`);
    }
    if (r.terrain) console.log(`    __TERRAIN tris ${r.terrain.triangles} textureMB ${r.terrain.textureMB}`);
    console.log("");
  }

  const base = results[0];
  const wdOf = (r) => r.programs.filter((k) => k.includes("wd:")).length;
  for (const r of results.slice(1)) {
    const d = r.programs.length - base.programs.length;
    const dwd = wdOf(r) - wdOf(base);
    const ds = r.stallMs - base.stallMs;
    console.log(`DELTA ${base.tier} -> ${r.tier}`);
    console.log(`  total programs  ${base.programs.length} -> ${r.programs.length}  (${d >= 0 ? "+" : ""}${d})`);
    console.log(`  of which wd:    ${wdOf(base)} -> ${wdOf(r)}  (${dwd >= 0 ? "+" : ""}${dwd})`);
    console.log(`  stall to 30 fr  ${(base.stallMs / 1000).toFixed(1)}s -> ${(r.stallMs / 1000).toFixed(1)}s  (${ds >= 0 ? "+" : ""}${(ds / 1000).toFixed(1)}s)`);
    if (d >= 0) {
      console.log("  FAIL for the compile-time family: the count did not fall. A tier that cuts");
      console.log("  triangles and leaves the program count intact does not shorten the cold load,");
      console.log("  which is the thing the tier exists to shorten.");
    }
    console.log("");
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  const held = await portInUse(PORT);
  console.log(held ? `[tierprogs] !! port ${PORT} still has a listener` : `[tierprogs] port ${PORT} clear`);
}
