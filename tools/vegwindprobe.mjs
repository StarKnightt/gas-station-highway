#!/usr/bin/env node
/**
 * Leaf wind and minification damping: one bundle, ten loads, four registered
 * predictions.
 *
 *   node tools/vegwindprobe.mjs                # build, capture, write capture-vegwind-0829/
 *   node tools/vegwindprobe.mjs --no-build     # reuse the existing .shot-build/vegwind
 *
 * ## Why the arms are shaped like this
 *
 * At shipping amplitude a working wind and a dead wind are indistinguishable in
 * a still frame. Several of this project's shader levers have shipped invisible
 * and were only caught much later, so this harness is built around subtractions
 * that cannot come out right by accident:
 *
 *  - Two **null** frames at different scene times must be **bit-identical**. If
 *    they are not, something else in the scene animates and nothing else this
 *    tool measures can be attributed.
 *  - Two **shipping** frames at different scene times must differ, and only in
 *    foliage rows. That is the wind moving geometry rather than being inert.
 *  - `?vegwind=8` against the null must differ a great deal, and must include
 *    the ground rows where crown shadows land. That is the shadow following.
 *  - `?vegdepth=0` against shipping **at zero amplitude** must be bit-identical.
 *    A custom depth material that displaces nothing must also cut exactly the
 *    same silhouette; any difference is the recorded alphaTest divergence
 *    (beauty 0.3, shadow 0.5, 6.9% of drawn pixels casting nothing) coming back
 *    in a new dress, and no other check in the repo would see it.
 *
 * Scene time is advanced by counting rAF ticks rather than by sleeping, because
 * a headless page that is not compositing does not advance a wall clock the way
 * a visible one does. The exact time is never needed — only that two captures
 * sit at different ones.
 *
 * Teardown contract (repo-wide rule): the preview server and the browser are
 * registered with one shutdown routine wired to every exit path before either
 * is started. Nothing is detached; the process always ends in process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { assertHardwareGpu, assertSceneGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1600;
const HEIGHT = 900;
/**
 * This harness's assigned port.
 *
 * Moved off 5163 after two runs failed with EADDRINUSE against a port that
 * `netstat` showed as free: the listener was gone, but half a dozen sockets
 * were still in TIME_WAIT on `[::1]:5163`, and `--strictPort` will not step
 * around those. `--strictPort` stays, because a harness that silently moves to
 * another port is a harness whose captures came from somewhere you did not
 * check.
 */
const PORT = 5167;
const BUILD_DIR = ".shot-build/vegwind";
const OUT_DIR = path.join(ROOT, "capture-vegwind-0829");
const READY_TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");

/**
 * The arms. `ticks` is how many rAF frames to run past `__SCENE_READY` before
 * the screenshot, which is how two captures land at two scene times.
 *
 * `early` is 8, matching every other capture tool here so these frames are
 * comparable with the rest of the archive. `late` is 8 + 240, about four
 * seconds of scene time at 60 Hz — a third of the 11.4 s primary sway period,
 * which is where a sinusoid moves fastest and a diff is largest.
 */
const EARLY = 8;
const LATE = 248;

const ARMS = [
  { id: "A-null-early", shot: "approach", query: "vegwind=0", ticks: EARLY },
  /* The determinism floor, and it earns its load.
   *
   * The first run of this harness registered two "must be exactly zero"
   * predictions and both came back non-zero — at 43 and 74 pixels out of 1.44
   * million, with a peak difference of **1**. A one-code difference is not
   * motion and not a silhouette change; it is the quantiser. But "bit-identical"
   * was the prediction, and the honest response to a failed prediction is to
   * find out what the achievable floor actually is rather than to soften the
   * threshold, so this arm is byte-for-byte identical to A and exists only to
   * measure load-to-load reproducibility.
   *
   * Registered before the rerun: **whatever A vs A2 gives is the floor**, and a
   * claim of "no change" from here on means at or below that floor in both
   * pixel count and peak, not zero. If A vs A2 is itself zero then the two
   * failures above are real and have to be explained rather than excused.
   */
  { id: "A2-null-early", shot: "approach", query: "vegwind=0", ticks: EARLY },
  { id: "B-null-late", shot: "approach", query: "vegwind=0", ticks: LATE },
  { id: "C-ship-early", shot: "approach", query: "vegwind=1", ticks: EARLY },
  { id: "D-ship-late", shot: "approach", query: "vegwind=1", ticks: LATE },
  { id: "E-x8-early", shot: "approach", query: "vegwind=8", ticks: EARLY },
  { id: "F-nodamp-null", shot: "approach", query: "vegwind=0&vegdamp=0", ticks: EARLY },
  { id: "G-nodepth-null", shot: "approach", query: "vegwind=0&vegdepth=0", ticks: EARLY },
  { id: "H-nodepth-x8", shot: "approach", query: "vegwind=8&vegdepth=0", ticks: EARLY },
  // Knee height raking into the low sun: the pose where a cast shadow is most
  // of the frame, so the shadow arm has somewhere to show.
  { id: "I-ground-null", shot: "ground", query: "vegwind=0", ticks: EARLY },
  { id: "J-ground-x8", shot: "ground", query: "vegwind=8", ticks: EARLY },
  /* The near-field check on the minification damping.
   *
   * The ramp is the identity below about 1.74 texels per pixel, which is a
   * property of the expression rather than a measurement — but "the foreground
   * cannot move" is the claim the change was landed on, and the `ground` pose
   * has foliage at arm's length in its bottom rows. If the damping is doing
   * what it says, the difference against I is absent from the bottom of that
   * frame and present higher up where the same layers minify.
   */
  { id: "K-ground-nodamp", shot: "ground", query: "vegwind=0&vegdamp=0", ticks: EARLY },
];

/**
 * Registered before a pixel is read, so no threshold can be chosen to fit.
 *
 * `expect` is one of "zero" (must be exactly 0 differing pixels) or a minimum
 * count. Anything that fails is printed as a FAIL and sets the exit code.
 */
const PREDICTIONS = [
  {
    pair: ["A-null-early", "A2-null-early"],
    expect: "floor",
    why: "two identical loads: this is the determinism floor everything else is read against",
  },
  {
    pair: ["A-null-early", "B-null-late"],
    expect: "floor",
    why: "nothing else in the scene animates; if this exceeds the floor, no other number here is readable",
  },
  {
    pair: ["A-null-early", "G-nodepth-null"],
    expect: "floor",
    why: "a depth material that displaces nothing must cut exactly the silhouette the beauty pass does",
  },
  {
    pair: ["C-ship-early", "D-ship-late"],
    expect: "nonzero",
    why: "the wind moves geometry between two scene times",
  },
  {
    pair: ["A-null-early", "E-x8-early"],
    expect: "nonzero",
    why: "the 8x arm proves the displacement is wired at all",
  },
  {
    pair: ["E-x8-early", "H-nodepth-x8"],
    expect: "nonzero",
    why: "with the depth patch removed the shadows stop following; this difference IS the shadow displacement",
  },
  {
    pair: ["A-null-early", "F-nodamp-null"],
    expect: "nonzero",
    why: "the minification damping does something, measured with the wind held at zero",
  },
];

let shutdownCalled = false;
let server = null;
let browser = null;

async function shutdown(code, message) {
  if (shutdownCalled) return;
  shutdownCalled = true;
  if (message) console.error(`[vegwind] ${message}`);
  try {
    if (browser) await browser.close();
  } catch {
    /* closing a browser that already died is not an error worth reporting */
  }
  /* `server.kill()` alone is not enough here and the first run of this tool
   * proved it: the preview is spawned through a shell, so the signal reaches
   * the shell and the `vite preview` child under it survives, keeps port 5163
   * and makes the next run fail to start. That is the repo teardown contract
   * being broken by one level of indirection, which is exactly the way it
   * usually breaks. Kill the tree.
   */
  if (server && !server.killed) {
    /* Order matters, and getting it backwards is why this leaked twice.
     *
     * The chain is cmd.exe -> npx -> node(vite preview). `server.kill()`
     * signals the shell, the shell dies immediately, and the node under it is
     * **orphaned and reparented** — at which point `taskkill /T` on the shell's
     * pid walks a tree that no longer contains the thing holding the port. So
     * the tree kill goes first, while the tree still exists, and `kill()` is
     * only the fallback for a platform without taskkill.
     *
     * `spawnSync` rather than `spawn`: an async kill plus a sleep was tried and
     * still leaked, because `process.exit` can tear the group down before
     * taskkill has finished enumerating.
     */
    if (process.platform === "win32" && server.pid) {
      try {
        spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", shell: true });
      } catch {
        /* the tree is already gone, which is the outcome we wanted */
      }
    }
    server.kill();
  }
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void shutdown(130, `caught ${sig}`));
}
process.on("uncaughtException", (e) => void shutdown(1, `uncaught: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandled: ${e?.stack ?? e}`));

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: true, stdio: "inherit", ...opts });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
  });
}

/** Region bands, so a diff can be attributed to a layer rather than to the frame. */
function bandOf(y) {
  if (y < HEIGHT * 0.42) return "sky/crown";
  if (y < HEIGHT * 0.62) return "mid";
  return "ground";
}

function diff(a, b) {
  let n = 0;
  let peak = 0;
  const bands = { "sky/crown": 0, mid: 0, ground: 0 };
  let minX = WIDTH;
  let maxX = -1;
  let minY = HEIGHT;
  let maxY = -1;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      if (d === 0) continue;
      n++;
      if (d > peak) peak = d;
      bands[bandOf(y)]++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    pixels: n,
    percent: Number(((n / (WIDTH * HEIGHT)) * 100).toFixed(3)),
    peak,
    bands,
    box: n ? [minX, minY, maxX, maxY] : null,
  };
}

async function main() {
  if (DO_BUILD) {
    console.log("[vegwind] building");
    await run("npx", ["vite", "build", "--outDir", BUILD_DIR, "--emptyOutDir"]);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });

  server = spawn("npx", ["vite", "preview", "--outDir", BUILD_DIR, "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://localhost:${PORT}/`;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("preview server did not start")), 60_000);
    const fail = (msg) => {
      clearTimeout(t);
      rej(new Error(msg));
    };
    server.stdout.on("data", (d) => {
      if (String(d).includes("Local")) {
        clearTimeout(t);
        res();
      }
    });
    server.stderr.on("data", (d) => {
      const s = String(d);
      process.stderr.write(s);
      // Fail immediately rather than burning the full readiness budget waiting
      // for a server that has already given up. Sixty seconds of silence reads
      // as "slow" and sends you looking in the wrong place.
      if (/already in use|EADDRINUSE/i.test(s)) fail(`port ${PORT} is already in use`);
    });
  });

  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  {
    const probe = await context.newPage();
    await probe.goto("about:blank");
    await assertHardwareGpu(probe, { tag: "vegwind" });
    await probe.close();
  }

  const frames = new Map();
  const reports = new Map();
  const problems = [];

  for (const arm of ARMS) {
    const page = await context.newPage();
    const said = [];
    page.on("console", (m) => {
      if (m.type() === "error") said.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => said.push(`pageerror: ${e.message}`));

    const url = `${base}?shot=${arm.shot}&${arm.query}`;
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch (err) {
      if (said.length) console.error(`[vegwind] ${arm.id} never became ready. Page said:\n    ${said.join("\n    ")}`);
      throw err;
    }
    await assertSceneGpu(page, { tag: `vegwind/${arm.id}` });

    await page.evaluate(
      (n) =>
        new Promise((res) => {
          let i = 0;
          const tick = () => (++i < n ? requestAnimationFrame(tick) : res());
          requestAnimationFrame(tick);
        }),
      arm.ticks
    );

    // A shader that fails to link still renders; the material just quietly
    // stops doing what it was written to do. Fatal here, as everywhere else.
    const errs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
    if (errs.length) problems.push(`${arm.id}: __SYSTEM_ERRORS ${JSON.stringify(errs)}`);
    if (said.some((s) => /Shader Error|not compiled|VALIDATE_STATUS/i.test(s))) {
      problems.push(`${arm.id}: shader link failure`);
    }

    reports.set(
      arm.id,
      await page.evaluate(() => {
        const v = window.__VEGETATION ?? {};
        return {
          windGain: v.windGain,
          dampGain: v.dampGain,
          depthPatch: v.depthPatch,
          shadowPairs: (v.shadowPairs ?? []).length,
          windTipMetres: v.windTipMetres,
          drawCalls: v.drawCalls,
          triangles: v.triangles,
        };
      })
    );

    const file = path.join(OUT_DIR, `${arm.id}.png`);
    await page.screenshot({ path: file, type: "png" });
    frames.set(arm.id, PNG.sync.read(await fs.readFile(file)));
    console.log(`[vegwind] ${arm.id.padEnd(16)} ${arm.shot}?${arm.query}  ticks=${arm.ticks}`);
    await page.close();
  }

  await context.close();

  console.log("\n[vegwind] arm reports");
  for (const [id, r] of reports) console.log(`  ${id.padEnd(16)} ${JSON.stringify(r)}`);

  /* The floor is measured first and every "floor" prediction is read against
   * it, so the bar is a number this run produced rather than one chosen to make
   * the run pass.
   *
   * **The bar is the peak, not the count**, and that is a correction made after
   * seeing two runs rather than a threshold tuned to fit. The count is not
   * reproducible: two byte-identical loads gave 84 differing pixels on one run
   * and 19 on the next, so a count-based bar flaps and tells you nothing. The
   * peak is reproducible at exactly 1 code in every null pair measured.
   *
   * It is also the stricter statistic for the failure this is looking for. An
   * alphaTest divergence between the beauty and shadow passes moves needle-edge
   * pixels by tens of codes against a bright sky, not by one — so a peak bar
   * would catch a *single* mismatched pixel, where a count bar of 84 would
   * absorb dozens of them. The count is still printed, because a null pair that
   * suddenly changed ten thousand pixels at peak 1 would be worth knowing about
   * even though every one of them is invisible.
   */
  const floor = diff(frames.get("A-null-early"), frames.get("A2-null-early"));
  console.log(
    `\n[vegwind] determinism floor (A vs A2, identical loads): ${floor.pixels} px, peak ${floor.peak}` +
      `  — the bar is the peak; counts in this regime are not reproducible run to run`
  );

  const results = [];
  console.log("\n[vegwind] registered predictions");
  for (const p of PREDICTIONS) {
    const [a, b] = p.pair;
    const d = diff(frames.get(a), frames.get(b));
    const pass = p.expect === "floor" ? d.peak <= floor.peak : d.pixels > 0;
    results.push({ ...p, ...d, pass });
    console.log(
      `  ${pass ? "PASS" : "FAIL"}  ${a} vs ${b}\n` +
        `        expect ${p.expect}, got ${d.pixels} px (${d.percent}%), peak ${d.peak}, ` +
        `bands ${JSON.stringify(d.bands)}, box ${JSON.stringify(d.box)}\n` +
        `        ${p.why}`
    );
  }

  // Not predictions, just numbers worth having in the record.
  const extra = [
    ["I-ground-null", "J-ground-x8", "8x wind at knee height into the sun — shadow rows"],
    ["C-ship-early", "A-null-early", "shipping amplitude against the null, one instant"],
    ["I-ground-null", "K-ground-nodamp", "the damping at knee height, where the near field is"],
  ];
  console.log("\n[vegwind] supplementary");
  for (const [a, b, why] of extra) {
    const d = diff(frames.get(a), frames.get(b));
    results.push({ pair: [a, b], expect: "record", why, ...d, pass: true });
    console.log(`  ${a} vs ${b}: ${d.pixels} px (${d.percent}%), peak ${d.peak}, bands ${JSON.stringify(d.bands)}`);
  }

  /* The near-field claim, as a row profile rather than a summary.
   *
   * "Identity at mip 0" is a claim about where in the frame the effect is
   * allowed to appear, and a whole-frame pixel count cannot test it. In the
   * knee-height pose the bottom rows are foliage at arm's length and the middle
   * rows are the same layers at thirty metres, so the profile should climb away
   * from the bottom of the frame. A flat profile would mean the ramp is not
   * ramping and the change is touching the foreground.
   */
  {
    const a = frames.get("I-ground-null");
    const b = frames.get("K-ground-nodamp");
    const rows = 10;
    const per = [];
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor((r * HEIGHT) / rows);
      const y1 = Math.floor(((r + 1) * HEIGHT) / rows);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const i = (y * WIDTH + x) * 4;
          if (
            a.data[i] !== b.data[i] ||
            a.data[i + 1] !== b.data[i + 1] ||
            a.data[i + 2] !== b.data[i + 2]
          ) n++;
        }
      }
      per.push({ band: `${y0}-${y1}`, pixels: n, percent: Number(((n / ((y1 - y0) * WIDTH)) * 100).toFixed(2)) });
    }
    results.push({ pair: ["I-ground-null", "K-ground-nodamp"], expect: "record", why: "damping row profile", rowProfile: per, pass: true });
    console.log("\n[vegwind] damping row profile, ground pose (top of frame first)");
    for (const p of per) console.log(`  y ${p.band.padEnd(9)} ${String(p.pixels).padStart(7)} px  ${p.percent}%`);
  }

  await fs.writeFile(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify({ width: WIDTH, height: HEIGHT, arms: ARMS, reports: [...reports], results }, null, 2)
  );

  const failed = results.filter((r) => !r.pass);
  if (problems.length) console.error(`\n[vegwind] page problems:\n  ${problems.join("\n  ")}`);
  console.log(`\n[vegwind] ${OUT_DIR}`);
  await shutdown(failed.length || problems.length ? 1 : 0, failed.length ? `${failed.length} prediction(s) failed` : null);
}

main().catch((e) => void shutdown(1, e?.stack ?? String(e)));
