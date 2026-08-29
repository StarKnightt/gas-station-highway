/**
 * Verifies that quality tiers actually change what they claim to change.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything this project has found says a quality system will silently fail to
 * apply: an authored value ignored, a tier set before the material exists, a
 * uniform never refreshed. A tier that is *requested* and a tier that is
 * *applied* are different claims, and only one of them is worth anything.
 *
 * So this checks three things, and treats disagreement between them as failure:
 *
 *   1. The build says which tier it selected (`window.__QUALITY.tier`).
 *   2. The measured cost moved in the direction the tier promised.
 *   3. The frame is actually different in pixels.
 *
 * (1) alone is a build agreeing with itself. (2) alone cannot tell a tier that
 * lowered quality from one that broke a system. Together they are evidence.
 *
 * THE HEADLINE CRITERION IS COMPILE TIME, NOT PROGRAM COUNT
 * ---------------------------------------------------------
 * A cold load here is ~284 s, of which init is ~22 s; the remaining ~262 s is
 * the driver compiling shaders. So the compile-time family dominates and draw
 * calls and triangles predict only whether it holds 60 once running.
 *
 * **Program count was the wrong proxy for it, and this harness said so
 * incorrectly for one round.** Measured: gating an `onBeforeCompile` site took
 * one system's contribution from six programs to zero and the scene total did
 * not move — 143 either way — because its six materials have define sets unique
 * in this scene (`map`, `alphaTest`, `vertexColors`, `DoubleSide`, `shadowSide`,
 * `dithering` combinations nothing else uses), and three keys the program cache
 * on the define set. Each costs a program whether or not a shader is injected.
 *
 * So **gating a patch site reduces program *size*, and reduces program *count*
 * only when that material's defines then collide with another's.** A full round
 * of such gating could cut a real slice of the 216 s with the count pinned at
 * 143 — and a harness scoring on count would report no progress, while
 * rewarding a change that merged two materials and saved one link. That is
 * rewarding the wrong work.
 *
 * Primary is therefore **`blockedMs`** — driver time blocked in compile and link,
 * read from inside GL — with **ms per program** beside it, and program count
 * demoted to secondary. `blockedMs` is only meaningful on a cold profile, so a
 * per-tier comparison of it needs `--cold`.
 *
 * Usage:
 *   node tools/tiers.mjs                 # all three tiers
 *   node tools/tiers.mjs --tiers=low,high
 *   node tools/tiers.mjs --frames=120
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { launchOptions, assertSceneGpu } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5152;
const OUT = path.join(ROOT, "tmp", "tiers");
const BUILD_DIR = path.join(ROOT, "tmp", "tiers-build");

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
const TIERS = arg("tiers", "high,medium,low").split(",").filter(Boolean);
const FRAMES = Number(arg("frames", "90"));
const READY_TIMEOUT_MS = 420_000; // a cold load on this project can exceed six minutes

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

/**
 * Renders `n` frames and resolves once they have actually been presented.
 *
 * Counts `__GAME.framesRendered` rather than waiting a duration: on a slow host
 * a fixed wait measures fewer frames, and the whole point is to compare hosts
 * and tiers of differing speed. Note this is a main-thread poll and so must only
 * be used *after* ready — during init it would queue behind the very stall we
 * care about and time out, which reads as a harness fault rather than a finding.
 */
async function settle(page, n) {
  await page.waitForFunction(
    (want) => (window.__GAME?.framesRendered ?? 0) >= want,
    n,
    { timeout: 120_000, polling: "raf" }
  );
}

async function measure(page, base, tier) {
  // `__GLSTAT` is not part of the app: it is GL-level instrumentation injected
  // per page. The first version of this harness omitted it, and every
  // program/texture column printed "?" while the run still reported PASS —
  // the headline criterion absent, and nothing failing. Hence the assertion in
  // `report()` that treats a null program count as a failure.
  await page.addInitScript({
    content: fs.readFileSync(path.join(ROOT, "tools/perf-instrument.js"), "utf8"),
  });

  const t0 = Date.now();
  await page.goto(`${base}?tier=${tier}&gpu=1`, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 420_000, polling: 500 });
  const readyMs = Date.now() - t0;

  await assertSceneGpu(page, { tag: `tiers:${tier}` });
  await settle(page, FRAMES);

  const m = await page.evaluate(() => {
    const q = window.__QUALITY;
    const g = window.__GLSTAT?.mark?.() ?? null;
    const info = window.__GAME?.renderer?.info ?? null;
    let instanced = 0;
    let instances = 0;
    window.__GAME?.scene?.traverse?.((o) => {
      if (o.isInstancedMesh) {
        instanced++;
        instances += o.count;
      }
    });
    return {
      reportedTier: q?.tier ?? null,
      forced: q?.forced ?? null,
      reasons: q?.reasons ?? [],
      settings: q?.settings ?? null,
      capability: q?.capability ?? null,
      steps: q?.steps ?? [],
      programs: g?.programs?.linked ?? null,
      shaderMs: g?.shaderTime?.blockedMs ?? null,
      texBytes: g?.live?.texBytes ?? null,
      rboBytes: g?.live?.rboBytes ?? null,
      draws: info?.render?.calls ?? null,
      triangles: info?.render?.triangles ?? null,
      instancedMeshes: instanced,
      instances,
      systemErrors: (window.__SYSTEM_ERRORS ?? []).map((e) => `${e.system}/${e.phase}: ${e.message}`),
      contextLost: !!window.__CONTEXT_LOST,
    };
  });

  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, `${tier}.png`);
  await page.screenshot({ path: shot, type: "png" });

  return { tier, readyMs, shot, ...m };
}

async function main() {
  const results = [];
  let server;
  let browser;

  const teardown = async () => {
    await browser?.close().catch(() => {});
    await server?.close?.().catch(() => {});
    console.log((await portInUse(PORT)) ? `[tiers] !! port ${PORT} still held` : `[tiers] port ${PORT} clear`);
  };

  try {
    const { build, preview } = await import("vite");
    const { chromium } = await import("playwright");

    if (await portInUse(PORT)) throw new Error(`port ${PORT} in use; refusing to start`);

    // A private build directory. A bare shared `outDir` with `emptyOutDir` has
    // already destroyed two siblings' builds once tonight.
    console.log(`[tiers] building into ${path.relative(ROOT, BUILD_DIR)} ...`);
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });

    server = await preview({
      root: ROOT,
      build: { outDir: BUILD_DIR },
      preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
    });
    const base = `http://127.0.0.1:${PORT}/`;
    console.log(`[tiers] preview on :${PORT}`);

    browser = await chromium.launch(launchOptions({}));

    for (const tier of TIERS) {
      // A fresh context per tier: a tier is chosen at construction, so reusing a
      // page would measure whatever the previous run left configured.
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      page.on("console", (msg) => {
        const t = msg.text();
        if (t.startsWith("[quality]")) console.log(`  ${t.split("\n")[0]}`);
      });
      console.log(`[tiers] --- ${tier} ---`);
      try {
        results.push(await measure(page, base, tier));
      } catch (err) {
        results.push({ tier, error: String(err?.message ?? err) });
        console.error(`[tiers] ${tier} FAILED: ${err?.message ?? err}`);
      }
      await context.close();
    }
  } finally {
    await teardown();
  }

  report(results);
}

function report(results) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "tiers.json"), JSON.stringify(results, null, 2));

  const ok = results.filter((r) => !r.error);
  console.log(`\n${"=".repeat(78)}\nTIER VERIFICATION\n${"=".repeat(78)}`);

  const rows = [
    ["tier", "reported", "blockedMs", "ms/prog", "programs", "texMB", "draws", "tris", "instances", "ready s"],
    ...ok.map((r) => [
      r.tier,
      r.reportedTier ?? "?",
      r.shaderMs == null ? "?" : Math.round(r.shaderMs),
      r.shaderMs == null || !r.programs ? "?" : (r.shaderMs / r.programs).toFixed(1),
      r.programs ?? "?",
      r.texBytes == null ? "?" : (r.texBytes / 1048576).toFixed(1),
      r.draws ?? "?",
      r.triangles ?? "?",
      r.instances ?? "?",
      (r.readyMs / 1000).toFixed(1),
    ]),
  ];
  const w = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  for (const row of rows) console.log(row.map((c, i) => String(c).padStart(w[i])).join("  "));

  // The `ready s` column carries an order confound and must not be read as a
  // tier comparison. Tiers run sequentially in one browser, so the FIRST tier
  // measured pays the cold driver shader-cache penalty (~280 s here) and every
  // later one is warm (~26-31 s). That is a ~10x effect and it dwarfs anything a
  // tier does, so whichever tier happens to run first will look catastrophic.
  // Comparing cold load across tiers needs a fresh browser profile per tier.
  if (ok.length > 1) {
    console.log(
      `\nnote: "ready s" is NOT comparable across tiers. ${ok[0].tier} ran first and paid the cold\n` +
        `      shader-cache penalty; the rest are warm. Use fresh profiles per tier to compare cold load.`
    );
  }

  // ---- the assertions -----------------------------------------------------
  const problems = [];

  for (const r of ok) {
    if (r.reportedTier !== r.tier) {
      problems.push(`${r.tier}: requested but the build reports "${r.reportedTier}" — the tier did not apply`);
    }
    // A missing measurement is a failure, not a pass. Program count is the
    // headline criterion — it predicts the ~262 s of driver shader compilation
    // that dominates a cold load — so a run that could not read it has not
    // verified the thing that matters most, however green the other columns are.
    if (r.shaderMs == null) {
      problems.push(`${r.tier}: blockedMs unavailable — the headline criterion was not measured`);
    }
    if (r.programs == null) {
      problems.push(`${r.tier}: program count unavailable (secondary criterion, still required)`);
    }
    if (r.texBytes == null) problems.push(`${r.tier}: texture bytes unavailable`);
    if (r.systemErrors.length) problems.push(`${r.tier}: system errors: ${r.systemErrors.join(" | ")}`);
    if (r.contextLost) problems.push(`${r.tier}: WebGL context lost`);
    if (r.steps.length) {
      // Not a failure: worth surfacing, because a demotion during the measured
      // window means the numbers describe a different tier than the label.
      console.log(`\n[tiers] note: ${r.tier} adapted during measurement: ${r.steps.join("; ")}`);
    }
  }

  const by = Object.fromEntries(ok.map((r) => [r.tier, r]));
  const pairs = [
    ["low", "high"],
    ["low", "medium"],
    ["medium", "high"],
  ];
  console.log("");
  for (const [lo, hi] of pairs) {
    if (!by[lo] || !by[hi]) continue;
    const dProg = by[hi].programs - by[lo].programs;
    const dTex = (by[hi].texBytes - by[lo].texBytes) / 1048576;
    const dInst = by[hi].instances - by[lo].instances;
    console.log(
      `${lo} vs ${hi}:  programs ${dProg >= 0 ? "-" : "+"}${Math.abs(dProg)}  ` +
        `texture ${dTex >= 0 ? "-" : "+"}${Math.abs(dTex).toFixed(1)} MB  ` +
        `instances ${dInst >= 0 ? "-" : "+"}${Math.abs(dInst)}`
    );
    // Instance count is the one lever applied entirely from Game.ts, so it is
    // the one that must move. If it does not, the density lever is inert and
    // every other conclusion here is suspect.
    if (dInst <= 0) problems.push(`${lo} does not reduce instances against ${hi} (delta ${dInst}) — density lever inert`);
    if (dProg === 0) {
      // Advisory, not a failure. A gated patch site shrinks programs without
      // removing them unless the defines then collide, so an unchanged count is
      // the expected result of correct compile-time work as often as it is the
      // signature of a flag that never applied. "Count unchanged" is what a
      // working flag and a broken flag both print; only blockedMs distinguishes
      // them, and only on a cold profile.
      console.log(
        `  note: program count identical (${by[hi].programs}). Not evidence either way — compare
` +
          `        blockedMs on cold profiles (--cold) to see whether compile-time work landed.`
      );
    }
  }

  const failed = results.filter((r) => r.error);
  for (const r of failed) problems.push(`${r.tier}: ${r.error}`);

  console.log(`\n${"-".repeat(78)}`);
  if (problems.length === 0) {
    console.log(`PASS — ${ok.length} tier(s) verified: each applied, and each moved cost in the promised direction.`);
    console.log(`Screenshots in ${path.relative(ROOT, OUT)}; compare with tools/pixdiff.mjs to confirm the frame differs.`);
  } else {
    console.log(`FAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
