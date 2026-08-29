#!/usr/bin/env node
/**
 * Reticle verification.
 *
 *   node tools/reticleprobe.mjs              # build, assert, capture
 *   node tools/reticleprobe.mjs --no-build   # reuse .shot-build/reticle/
 *
 * Port 5137. Builds into `.shot-build/reticle/` — never into `.shot-build/`
 * itself, which is the parent of every system's private bundle and has twice
 * been emptied by a stray default `outDir`. Frames go to `tmp/reticle/`.
 *
 * ## Why it measures the way it does
 *
 * This project's signature failure is correct code that never reaches the
 * screen, so "the class is applied" is not evidence. But a diff between two
 * builds is not evidence either — six agents commit between captures, and a
 * control rectangle of tarmac has been measured moving 25.6/255 between two
 * rounds of a system that could not touch it.
 *
 * So every measurement here is **within one frame of one page load**. For each
 * pose the harness screenshots twice back to back: once with an inline
 * `display:none` on the reticle node, once without. Nothing else changes — not
 * the build, not the camera, not the tick. Every pixel that differs between
 * those two frames is the reticle and can be nothing else, and a control box
 * in the corner of the same pair proves the rest of the frame held still.
 *
 * The reach-boundary test is the other half. It sweeps the camera through
 * 2.2 m of standoff in 50 mm steps and, at every single step, compares what
 * the reticle is showing against what `__INTERACT.click()` actually does. A
 * reticle that lights up over something a click then misses is worse than no
 * reticle, and that is the one bug this file exists to rule out.
 *
 * Teardown is wired to every exit path before the server or the browser is
 * started, per the user's global rule.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { PNG } from "pngjs";
import { assertHardwareGpu, assertSceneGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot-build", "reticle");
const SHOT_DIR = path.join(ROOT, "tmp", "reticle");
const PORT = 5137;
const WIDTH = 1280;
const HEIGHT = 720;
/**
 * 420 s, and the 90 s it replaces is worth recording because it failed in the
 * most misleading way available.
 *
 * A run on a freshly emptied build directory is a **cold shader compile**:
 * Playwright launches a throwaway browser profile every time, so Chromium's
 * on-disk program cache is always empty, and the driver compiles every program
 * from scratch. Measured on this machine that is ~284 s of wall clock, of which
 * scene init is only ~22 s — so the page had finished building the entire world
 * and was waiting on the driver when the old timeout fired.
 *
 * What that looked like was a harness reporting that the scene "never reached
 * __SCENE_READY" directly beneath its own log lines showing terrain, canopy,
 * vegetation, lighting and the collision field all completing successfully.
 * Nothing was wrong with the scene at all. Only the *first* load pays this —
 * the later loads reuse the same browser and hit its in-memory program cache —
 * but the first one has to be allowed to finish or nothing downstream runs.
 */
const READY_TIMEOUT_MS = 420_000;

/**
 * Boxes measured, and they do not overlap on purpose.
 *
 * CENTRE is the dot alone: 64 px square, and the prompt starts 19 px below
 * centre so it would fall inside it — hence CENTRE is measured as the top half
 * only would not work either, because the dot is at the exact centre. The dot's
 * bbox has measured 12x13 at its largest, so a 28 px half-height box holds the
 * dot and stops 5 px short of the prompt's cap height. PROMPT then starts below
 * that. Keeping them disjoint is what lets each be asserted on independently:
 * one box going to zero has exactly one cause.
 */
const CENTRE = { x: WIDTH / 2 - 32, y: HEIGHT / 2 - 11, w: 64, h: 22 };
const PROMPT = { x: WIDTH / 2 - 180, y: HEIGHT / 2 + 13, w: 360, h: 28 };
const CONTROL = { x: 40, y: 40, w: 64, h: 64 };

const argv = process.argv.slice(2);
for (const a of argv) {
  // An unrecognised flag is an error, not a default: see RESUME-PLAN, "an
  // unrecognised harness flag must be an error".
  if (!["--no-build", "--allow-software"].includes(a)) {
    console.error(`[reticle] unrecognised argument: ${a}`);
    process.exit(2);
  }
}
const DO_BUILD = !argv.includes("--no-build");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

const withTimeout = (p, ms) =>
  Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);

async function portFree(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => (s.destroy(), res(false)));
    s.on("error", () => res(true));
    setTimeout(() => (s.destroy(), res(true)), 1500).unref?.();
  });
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[reticle] shutting down: ${reason}`);
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
      await withTimeout(fn(), 10_000);
    } catch (err) {
      console.error(`[reticle] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  // Prove it, rather than assuming close() evicted every keep-alive socket.
  const free = await portFree(PORT).catch(() => null);
  console.log(`[reticle] teardown: port ${PORT} ${free === null ? "unchecked" : free ? "has no listener" : "STILL LISTENING"}`);
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (e) => void shutdown(1, `uncaughtException: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => void shutdown(1, `unhandledRejection: ${e?.stack ?? e}`));

/* ------------------------------------------------------------------ */

const results = [];
const failures = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const n = (v, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : String(v));

function lowerPriority() {
  try {
    process.setpriority?.(0, os.platform() === "win32" ? (os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10) : 10);
  } catch {
    /* best effort */
  }
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Per-pixel difference between two identically posed frames, inside a box. */
function boxDiff(a, b, box) {
  let changed = 0;
  let maxDelta = 0;
  let sumA = 0;
  let count = 0;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * a.width + x) * 4;
      const la = luma(a.data[i], a.data[i + 1], a.data[i + 2]);
      const lb = luma(b.data[i], b.data[i + 1], b.data[i + 2]);
      const d = Math.abs(la - lb);
      if (d > maxDelta) maxDelta = d;
      if (d > 6) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      sumA += la;
      count++;
    }
  }
  return {
    changed,
    maxDelta,
    /** Mean luma of the *background* frame, i.e. what it has to be seen against. */
    background: sumA / count,
    bbox: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (!(await portFree(PORT))) await shutdown(1, `port ${PORT} already has a listener`);
  await fs.mkdir(SHOT_DIR, { recursive: true });

  if (DO_BUILD) {
    console.log("[reticle] building into .shot-build/reticle/ ...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }

  console.log(`[reticle] preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "reticle", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const page = await context.newPage();
  const problems = [];
  /**
   * A failed compile or link, as distinct from a *warning* on a successful one.
   *
   * The pattern this replaces included `program info log`, which three.js emits
   * whenever the driver returns a non-empty log at all — and the HLSL compiler
   * returns one for benign precision notes like "X4122: sum of 1 and
   * -1.49e-017 cannot be represented accurately". So every run of this harness
   * failed on a warning from a shader that had linked perfectly, which is the
   * inverse of the mistake it was written to catch: it turned a real signal into
   * noise that a reader learns to skip past.
   *
   * `Shader Error` and `VALIDATE_STATUS` are what three.js logs on an actual
   * failure and are unambiguous, so they stay. Warning-only logs are collected
   * separately and printed, because a shader warning is worth a human's
   * attention even when it is not this harness's business to fail on it.
   */
  const SHADER_FAIL = /shader error|undeclared identifier|VALIDATE_STATUS|\bERROR:/i;
  const SHADER_NOTE = /program info log/i;
  const shaderNotes = [];
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || SHADER_FAIL.test(t)) problems.push(`console: ${t}`);
    else if (SHADER_NOTE.test(t)) shaderNotes.push(t);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  const transcript = [];
  page.on("console", (m) => {
    if (transcript.length < 200) transcript.push(`${m.type()}: ${m.text()}`);
  });
  const ready = async (url) => {
    transcript.length = 0;
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
    } catch {
      // A scene that never signals ready is an init throwing or a program
      // failing to link, and both are invisible without the page's own console.
      console.error(`\n[reticle] ${url} never reached __SCENE_READY. Page console:`);
      for (const t of transcript) console.error(`    ${t}`);
      const loading = await page.evaluate(() => document.getElementById("loading")?.textContent ?? null).catch(() => null);
      const errs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? null).catch(() => null);
      console.error(`[reticle] #loading text: ${loading}`);
      console.error(`[reticle] __SYSTEM_ERRORS: ${JSON.stringify(errs)}`);
      throw new Error(`${url} never reached __SCENE_READY`);
    }
  };
  const step = (ms) =>
    page.evaluate(
      (t) =>
        new Promise((res) => {
          const t0 = performance.now();
          const tick = () => (performance.now() - t0 >= t ? res(0) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      ms
    );
  const look = (f, t) => page.evaluate(([a, b]) => window.__INTERACT.look(a[0], a[1], a[2], b[0], b[1], b[2]), [f, t]);
  const reticleState = () => page.evaluate(() => window.__RETICLE?.() ?? null);
  const hover = () => page.evaluate(() => window.__INTERACT.hover());

  /* ================================================================= */
  /* 1. hidden when pointer lock is not engaged — the real lock path    */
  /* ================================================================= */
  console.log("\n[reticle] 1. pointer-lock gating (no ?reticle flag, no ?shot preset)");
  await ready(`${base}index.html`);
  await assertSceneGpu(page, { tag: "reticle", when: "on the interactive page" });
  await step(200);

  const unlocked = await page.evaluate(() => ({
    report: window.__RETICLE?.() ?? null,
    display: getComputedStyle(document.getElementById("reticle")).display,
    lock: !!document.pointerLockElement,
    hudHidden: document.getElementById("hud")?.classList.contains("hidden"),
  }));
  console.log(`    unlocked: display=${unlocked.display} shown=${unlocked.report?.shown} why="${unlocked.report?.why}" hud hidden=${unlocked.hudHidden}`);
  check("reticle element exists", unlocked.report?.present === true, JSON.stringify(unlocked.report));
  check("hidden while pointer lock is not engaged", unlocked.display === "none" && unlocked.report?.shown === false, `display=${unlocked.display}`);
  check("pre-lock HUD card is the thing on screen instead", unlocked.hudHidden === false, `hud hidden=${unlocked.hudHidden}`);

  // A frame in the unlocked state must contain no reticle at all. Measured the
  // same way as everything else: identical pose, node forced off, diffed.
  const unlockedPair = await capturePair(page, "unlocked");
  const uCentre = boxDiff(unlockedPair.off, unlockedPair.on, CENTRE);
  check(
    "unlocked frame is pixel-identical with and without the node",
    uCentre.changed === 0,
    `${uCentre.changed} px differ in the centre box, max delta ${n(uCentre.maxDelta, 1)}`
  );

  // Take the lock for real first. Playwright's click is a trusted gesture,
  // which is what requestPointerLock needs — but headless Chromium has no
  // display to confine a cursor to and generally refuses outright, so this is
  // attempted and then reported rather than asserted.
  await page.evaluate(() => {
    window.__LOCKERR = null;
    document.addEventListener("pointerlockerror", () => (window.__LOCKERR = "pointerlockerror"), { once: true });
  });
  await page.mouse.click(WIDTH / 2, HEIGHT / 2);
  await step(400);
  let locked = await page.evaluate(() => ({
    report: window.__RETICLE?.() ?? null,
    display: getComputedStyle(document.getElementById("reticle")).display,
    lock: document.pointerLockElement ? document.pointerLockElement.tagName : null,
    err: window.__LOCKERR,
  }));
  const realLock = locked.lock !== null;
  console.log(`    real pointer lock: ${realLock ? `granted (${locked.lock})` : `refused by headless chromium (${locked.err ?? "no event"})`}`);

  if (!realLock) {
    // The browser will not grant a lock here, so drive the exact predicate the
    // shipping code reads instead. This stubs the *browser API*, not our code:
    // `reticleVisible()` runs unmodified, with the capture flag off, and the
    // only thing that changed is what `document.pointerLockElement` returns.
    // The false arm of the same branch was measured for real, above.
    console.log("    falling back to overriding document.pointerLockElement — the API is stubbed, the branch is not");
    await page.evaluate(() => {
      const canvas = window.__GAME.renderer.domElement;
      Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => canvas });
    });
    await step(250);
    locked = await page.evaluate(() => ({
      report: window.__RETICLE?.() ?? null,
      display: getComputedStyle(document.getElementById("reticle")).display,
      lock: document.pointerLockElement ? document.pointerLockElement.tagName : null,
      err: null,
    }));
  }
  console.log(`    locked:   lockElement=${locked.lock} display=${locked.display} shown=${locked.report?.shown} why="${locked.report?.why}"`);
  check(
    `reticle appears under pointer lock with no flag set${realLock ? "" : " (lock element stubbed)"}`,
    locked.display === "block" && locked.report?.shown === true,
    `display=${locked.display} shown=${locked.report?.shown}`
  );

  await page.evaluate(() => {
    if (Object.getOwnPropertyDescriptor(document, "pointerLockElement")) delete document.pointerLockElement;
  });
  await page.keyboard.press("Escape");
  await step(300);
  const released = await page.evaluate(() => ({
    report: window.__RETICLE?.() ?? null,
    display: getComputedStyle(document.getElementById("reticle")).display,
  }));
  check(
    "reticle hides again the moment the lock goes away",
    released.report?.shown === false && released.display === "none",
    `shown=${released.report?.shown} display=${released.display}`
  );

  /* ================================================================= */
  /* 2. pixel evidence for both states, at real stances                 */
  /* ================================================================= */
  console.log("\n[reticle] 2. both states in pixels — ?shot=system7&reticle=1");
  await ready(`${base}index.html?shot=system7&gpu=1&reticle=1`);
  await assertSceneGpu(page, { tag: "reticle", when: "on the capture page" });
  await step(250);

  /**
   * Shut every cooler leaf before the poses are derived, so the cooler capture
   * is of a cooler.
   *
   * Not tidiness. Since the reach priority landed, a leaf standing open is
   * reached *through* and the pick resolves to the bottle behind it — correct
   * behaviour, and it would turn this pose's pixel evidence into a photograph of
   * a different interaction depending on what a preset happened to park open.
   * The open-leaf case is covered properly in 5a, from every spot a player can
   * stand, which is where it belongs.
   */
  await page.evaluate(() => {
    const cs = window.__INTERACT.state().coolers ?? [];
    for (let i = 0; i < cs.length; i++) window.__INTERACT.setCooler(i, false);
  });
  await step(1200); // the closer takes ~0.9 s

  const poses = await page.evaluate(() => {
    const g = window.__GAME;
    const gh = g.tryGet("groundHeight");
    const out = {};

    /**
     * The wording each pose must show, derived here from the *live hinge and
     * session state* rather than hardcoded.
     *
     * Two reasons it is derived rather than written down. The preset may park
     * the entry door open — BuildingSystem does exactly that for two of its own
     * presets — so a hardcoded "open the door" would be a harness bug that
     * looked like a product bug. And a fixed string would pass for a prompt
     * whose ternary was inverted, as long as the initial state happened to
     * match; deriving the expectation from `target`/`session`, which is what
     * `isOpen` and `act()` read, means the check fails if the verb is wired to
     * the wrong side of the state.
     *
     * The stronger test of the same claim is the verb flip in section 4, which
     * needs no expectation at all: press the key and the verb must invert.
     */
    const st = window.__INTERACT.state();

    const faces = g.tryGet("pumpFaces") ?? [];
    const f = faces.find((x) => x.name.includes("pump-2")) ?? faces[0];
    if (f) {
      const s = f.standPosition;
      const d = f.displayCentre;
      const fuellingThis = !!st.pump?.running && st.pump.face === f.name;
      out.pump = {
        from: [s.x, (gh ? gh(s.x, s.z) : 0) + 1.62, s.z],
        to: [d.x, d.y, d.z],
        expect: "pump",
        expectPrompt: fuellingThis ? "press E to stop the pump" : "press E to start the pump",
      };
    }

    const door = g.tryGet("building.entryDoor");
    if (door) {
      door.updateWorldMatrix(true, false);
      const e = door.matrixWorld.elements;
      const cx = e[12] + (door.userData?.leafWidth ?? 0.9) * 0.5;
      out.door = {
        from: [cx, e[13] + 1.62, e[14] - 1.05],
        to: [cx, e[13] + 1.15, e[14]],
        expect: "door",
        expectPrompt: (st.door?.target ?? 0) > 0.5 ? "press E to close the door" : "press E to open the door",
      };
    }

    const cool = g.tryGet("building.coolerDoors") ?? [];
    if (cool.length) {
      const i = Math.min(1, cool.length - 1);
      const c = cool[i];
      c.updateWorldMatrix(true, false);
      const e = c.matrixWorld.elements;
      const w = c.userData?.width ?? 0.85;
      const h = c.userData?.height ?? 1.8;
      const cx = e[12] + w / 2;
      out.cooler = {
        from: [cx, e[13] + h * 0.55, e[14] - 0.95],
        to: [cx, e[13] + h * 0.5, e[14]],
        expect: "cooler",
        expectPrompt: (st.coolers?.[i]?.target ?? 0) > 0.5 ? "press E to close the cooler" : "press E to open the cooler",
      };
    }

    // Idle stances, chosen for the backgrounds the mark has to survive: empty
    // dawn sky overhead, the bright sky around the low sun, and the asphalt
    // underfoot. The sun heading is read off the scene's own key light rather
    // than copied from site constants, so it cannot go stale.
    const eye = [-2, (gh ? gh(-2, 6) : 0) + 1.62, 6];
    out.sky = { from: eye, to: [-2, 40, 26], expect: null, expectPrompt: "" };
    out.asphalt = { from: eye, to: [-2.2, -4, 12], expect: null, expectPrompt: "" };
    let sun = null;
    window.__GAME.scene.traverse((o) => {
      if (!sun && o.isDirectionalLight && o.intensity > 0.2) sun = o;
    });
    if (sun) {
      const p = sun.position;
      const L = Math.hypot(p.x, p.y, p.z) || 1;
      // Aim just above the horizon along the sun's bearing — the brightest
      // part of the sky, and the hardest background for a pale mark.
      out.sunsky = {
        from: eye,
        to: [eye[0] + (p.x / L) * 60, eye[1] + Math.max(4, (p.y / L) * 60 * 0.35), eye[2] + (p.z / L) * 60],
        expect: null,
        expectPrompt: "",
      };
    }
    return out;
  });

  const rows = [];
  for (const [name, pose] of Object.entries(poses)) {
    await look(pose.from, pose.to);
    await step(320); // clear of the 110 ms transition
    const h = await hover();
    const st = await reticleState();
    const pair = await capturePair(page, name);
    const c = boxDiff(pair.off, pair.on, CENTRE);
    const pr = boxDiff(pair.off, pair.on, PROMPT);
    const ctrl = boxDiff(pair.off, pair.on, CONTROL);
    rows.push({ name, pose, hover: h, st, c, pr, ctrl, pair });

    console.log(
      `    ${name.padEnd(8)} bg luma ${n(c.background, 1).padStart(5)}  reach=${String(st?.reach).padEnd(5)}  ` +
        `hit=${h.target ? `${h.target.kind}/${n(h.target.distance, 2)}m` : "none"}  ` +
        `dot=${String(c.changed).padStart(3)}px maxΔ=${n(c.maxDelta, 1).padStart(5)}  ` +
        `prompt=${String(pr.changed).padStart(4)}px maxΔ=${n(pr.maxDelta, 1).padStart(5)}  control=${ctrl.changed}px`
    );
    if (st?.prompt) console.log(`             wording: "${st.prompt}"`);

    check(`${name}: control box outside the reticle held still`, ctrl.changed === 0, `${ctrl.changed} px moved in the corner box`);
    check(`${name}: the dot is on screen in pixels`, c.changed > 0, `${c.changed} px differ`);
    check(
      `${name}: the dot is where it should be and no larger`,
      c.bbox && c.bbox.w <= 16 && c.bbox.h <= 16,
      `bbox ${c.bbox ? `${c.bbox.w}x${c.bbox.h}` : "none"}`
    );
    check(
      `${name}: state matches what the ray found`,
      !!st?.reach === (pose.expect !== null) && (h.target?.kind ?? null) === pose.expect,
      `reach=${st?.reach} kind=${h.target?.kind ?? null} expected ${pose.expect}`
    );

    /* ---- the prompt --------------------------------------------------
     *
     * Two directions, and the negative one is the one that matters. A prompt
     * that is always on screen would pass every "is it visible" test ever
     * written, and it is the failure this design is most exposed to: the text
     * is deliberately *not* cleared when the ray leaves an object, so the
     * wording can fade out intact — which means the node still holds a full
     * sentence while showing nothing. If opacity were not truly reaching 0, the
     * words would sit permanently across the middle of the frame, and every
     * reference screenshot this project takes would have them baked in.
     *
     * So on an idle pose the PROMPT box must be pixel-identical with the node
     * present and absent, and the node must still be holding wording at the
     * time for that to prove anything — which is asserted after the loop.
     */
    if (pose.expect === null) {
      check(
        `${name}: no prompt pixels while nothing is in reach`,
        pr.changed === 0,
        `${pr.changed} px of text visible over ${name}, max delta ${n(pr.maxDelta, 1)}`
      );
    } else {
      check(`${name}: the prompt is on screen in pixels`, pr.changed > 40, `${pr.changed} px of text differ`);
      /**
       * 80/255, up from the 40 this started at. 40 passed a prompt that was
       * measurably almost invisible over the storefront door frame and the
       * cooler glazing — 91 and 65 — which the magnified strip showed plainly
       * and the assertion waved through. A threshold that a barely-legible
       * result satisfies is not a legibility test, it is a presence test, and
       * the presence test is the assertion above.
       */
      check(
        `${name}: the prompt reads against this background`,
        pr.maxDelta > 80,
        `peak text contrast ${n(pr.maxDelta, 1)}/255 over background luma ${n(pr.background, 1)}`
      );
      check(
        `${name}: the prompt names the action this state will actually perform`,
        st?.prompt === pose.expectPrompt && h.prompt === pose.expectPrompt,
        `dom="${st?.prompt}" system="${h.prompt}" expected "${pose.expectPrompt}"`
      );
      check(
        `${name}: the prompt is one line and stays inside the frame`,
        pr.bbox && pr.bbox.h <= 24 && pr.bbox.w <= 340,
        `text bbox ${pr.bbox ? `${pr.bbox.w}x${pr.bbox.h}` : "none"}`
      );
    }
  }

  const heldPrompt = (await reticleState())?.prompt ?? "";
  check(
    "the idle prompt checks ran against a node that still held wording",
    heldPrompt.length > 0,
    heldPrompt.length
      ? `the node still reads "${heldPrompt}" while showing nothing, which is what those checks tested`
      : "the prompt node was EMPTY — the zero-pixel checks above proved nothing"
  );

  /* the whole point: in-reach must be unmistakably different from idle */
  const idle = rows.filter((r) => r.pose.expect === null);
  const reach = rows.filter((r) => r.pose.expect !== null);
  const idleMax = Math.max(...idle.map((r) => r.c.maxDelta));
  const idlePx = Math.max(...idle.map((r) => r.c.changed));
  const reachMin = Math.min(...reach.map((r) => r.c.maxDelta));
  const reachPx = Math.min(...reach.map((r) => r.c.changed));
  console.log(
    `\n    idle:     up to ${idlePx} px, peak contrast ${n(idleMax, 1)}/255 against backgrounds ${idle.map((r) => n(r.c.background, 0)).join(" and ")}`
  );
  console.log(`    in reach: at least ${reachPx} px, peak contrast ${n(reachMin, 1)}/255`);
  check("idle state is visible against both sky and asphalt", idle.every((r) => r.c.maxDelta > 20 && r.c.changed >= 8), `min peak ${n(Math.min(...idle.map((r) => r.c.maxDelta)), 1)}`);
  check("idle state stays restrained", idleMax < 150 && idlePx < 80, `peak ${n(idleMax, 1)}/255 over ${idlePx} px`);
  check("in-reach state is unmistakably brighter and bigger than idle", reachMin > idleMax * 1.4 && reachPx > idlePx, `reach ${n(reachMin, 1)}/255 over ${reachPx} px vs idle ${n(idleMax, 1)}/255 over ${idlePx} px`);

  /* ---- the prompt, measured across the same backgrounds ---- */
  const reachPr = reach.map((r) => r.pr);
  const idlePr = idle.map((r) => r.pr);
  console.log(
    `    prompt:   ${Math.min(...reachPr.map((p) => p.changed))}-${Math.max(...reachPr.map((p) => p.changed))} px of text, ` +
      `peak contrast ${n(Math.min(...reachPr.map((p) => p.maxDelta)), 1)}-${n(Math.max(...reachPr.map((p) => p.maxDelta)), 1)}/255, ` +
      `widest line ${Math.max(...reachPr.map((p) => (p.bbox ? p.bbox.w : 0)))} px`
  );
  console.log(`    prompt when idle: ${Math.max(...idlePr.map((p) => p.changed))} px — expected 0 against every background`);
  check(
    "the prompt reads against the worst background it has, not just the best",
    Math.min(...reachPr.map((p) => p.maxDelta)) > 80,
    `weakest peak text contrast ${n(Math.min(...reachPr.map((p) => p.maxDelta)), 1)}/255` +
      ` over background luma ${n(reachPr.reduce((w, p) => (p.maxDelta < w.maxDelta ? p : w)).background, 1)}`
  );
  check(
    "the prompt is restrained — text, not a panel",
    Math.max(...reachPr.map((p) => p.changed)) < 2200,
    `${Math.max(...reachPr.map((p) => p.changed))} px changed, which is more area than a line of 12.5 px type`
  );

  const dotStrip = path.join(SHOT_DIR, "evidence-dot.png");
  await writeStrip(dotStrip, rows, { cw: 48, ch: 48, zoom: 6 });
  const promptStrip = path.join(SHOT_DIR, "evidence-prompt.png");
  await writeStrip(promptStrip, rows, { cw: 320, ch: 52, dy: 22, zoom: 2 });
  console.log(`    magnified dot crops, 6x, in reading order:    ${path.relative(ROOT, dotStrip)}`);
  console.log(`    magnified prompt crops, 2x, in reading order: ${path.relative(ROOT, promptStrip)}`);

  /* ================================================================= */
  /* 3. the reach boundary — reticle against what a click actually does */
  /* ================================================================= */
  console.log("\n[reticle] 3. reach boundary: dot vs prompt vs E vs click, 50 mm steps");
  /**
   * Four things claim to know what is in reach, and this is the test that they
   * cannot disagree.
   *
   * The E key and the mouse are fired as **real browser events** — an actual
   * `keydown` from the input pipeline and an actual click on the canvas — not
   * through `__INTERACT.click()`. That matters here in a way it did not when
   * only the mouse existed: the whole risk of adding a key binding is that it
   * takes a different route to `act()` than the click does, and a test hook that
   * calls `pick()` directly would exercise neither route. So the only thing the
   * hook is used for is reading counters back.
   *
   * `activations` is counted per input inside the system, so "did E act" is
   * answered by E's own counter rather than by a side effect that the click a
   * moment later could equally have produced.
   */
  const sweepAxis = poses.pump
    ? await page.evaluate(([from, to]) => {
        const dx = from[0] - to[0], dy = from[1] - to[1], dz = from[2] - to[2];
        const len = Math.hypot(dx, dy, dz);
        return { u: [dx / len, dy / len, dz / len], to };
      }, [poses.pump.from, poses.pump.to])
    : null;

  const sweep = [];
  if (sweepAxis) {
    for (let d = 1.6; d <= 3.0001; d += 0.05) {
      const { u, to } = sweepAxis;
      await page.evaluate(
        ([p, t]) => window.__INTERACT.look(p[0], p[1], p[2], t[0], t[1], t[2]),
        [[to[0] + u[0] * d, to[1] + u[1] * d, to[2] + u[2] * d], to]
      );
      await step(40); // two frames at 60 Hz, enough for one hover update

      const before = await hover();
      const dom = await reticleState();

      // --- the E key, as a real keydown -------------------------------
      await page.keyboard.press("e");
      await step(40);
      const afterKey = await hover();
      const keyActed = afterKey.activations.key > before.activations.key;
      if (keyActed) {
        // Undo, so every stance is measured from the same world state. Every
        // action in this system is a toggle, so a second press restores it.
        await page.keyboard.press("e");
        await step(40);
      }

      // --- the mouse, as a real click on the canvas --------------------
      const beforeClick = await hover();
      await page.mouse.click(WIDTH / 2, HEIGHT / 2);
      await step(40);
      const afterClick = await hover();
      const clickActed = afterClick.activations.pointer > beforeClick.activations.pointer;
      if (clickActed) {
        await page.mouse.click(WIDTH / 2, HEIGHT / 2);
        await step(40);
      }

      sweep.push({
        d: Math.round(d * 1000) / 1000,
        reach: !!dom?.reach,
        prompt: dom?.prompt ?? "",
        promptShowing: !!dom?.reach && (dom?.prompt ?? "").length > 0,
        hoverDist: before.target ? before.target.distance : null,
        keyActed,
        clickActed,
      });
    }
  }

  let disagreements = 0;
  let transitions = 0;
  for (let i = 0; i < sweep.length; i++) {
    const s = sweep[i];
    if (!(s.reach === s.keyActed && s.reach === s.clickActed && s.reach === s.promptShowing)) disagreements++;
    if (i > 0 && sweep[i - 1].reach !== s.reach) transitions++;
  }
  const lastOn = sweep.filter((s) => s.reach).pop();
  const firstOff = sweep.find((s, i) => i > 0 && !s.reach && sweep[i - 1].reach);
  for (const s of sweep) {
    const agree = s.reach === s.keyActed && s.reach === s.clickActed && s.reach === s.promptShowing;
    console.log(
      `    standoff ${n(s.d, 2)} m  dot=${s.reach ? "BRIGHT" : "idle  "}  ` +
        `prompt=${s.promptShowing ? "shown" : "  -  "}  E=${s.keyActed ? "acts" : "no  "}  ` +
        `click=${s.clickActed ? "acts" : "no  "}  rayDist=${s.hoverDist === null ? "  -  " : n(s.hoverDist, 3)}` +
        `${agree ? "" : "   <-- DISAGREES"}`
    );
  }
  check(
    "dot, prompt, E key and mouse click all agree at every step across the boundary",
    sweep.length > 20 && disagreements === 0,
    `${disagreements} of ${sweep.length} stances disagree`
  );
  check("the boundary is a single clean transition, not a flicker band", transitions === 1, `${transitions} transitions`);
  check(
    "the E key acted at all — the sweep is not passing because nothing ever fired",
    sweep.some((s) => s.keyActed) && sweep.some((s) => !s.keyActed),
    `E acted at ${sweep.filter((s) => s.keyActed).length} of ${sweep.length} stances`
  );
  if (lastOn && firstOff) {
    console.log(
      `    boundary: last bright at standoff ${n(lastOn.d, 2)} m (ray ${n(lastOn.hoverDist, 3)} m), first idle at ${n(firstOff.d, 2)} m — REACH_M is 2.2 m`
    );
    check("the boundary sits at the system's own 2.2 m reach", lastOn.hoverDist > 2.1 && lastOn.hoverDist <= 2.2, `last bright ray distance ${n(lastOn.hoverDist, 4)} m`);
  }

  /* ================================================================= */
  /* 4. the verb flips with the state, and E is what flips it           */
  /* ================================================================= */
  /**
   * The check that needs no expected string at all, and so the one that cannot
   * be satisfied by a prompt wired to the wrong side of its own state: stand at
   * a thing, read the verb, press E, read it again. It must invert, and the
   * world must have moved in the direction the first verb promised.
   *
   * Run on the storefront door because its state is externally observable —
   * `state().door.target` is the same number `isOpen` reads, and the leaf angle
   * is a physical consequence — so "the prompt says close" can be checked
   * against "the door is in fact open" rather than against another string.
   */
  console.log("\n[reticle] 4. the verb flips with the state, driven by E");
  if (poses.door) {
    await look(poses.door.from, poses.door.to);
    await step(320);
    const first = await reticleState();
    const doorBefore = await page.evaluate(() => window.__INTERACT.state().door.target);
    await page.keyboard.press("e");
    await step(320);
    const doorAfter = await page.evaluate(() => window.__INTERACT.state().door.target);
    const second = await reticleState();
    console.log(`    "${first?.prompt}"  (door target ${n(doorBefore, 2)})`);
    console.log(`    -- real keydown E --`);
    console.log(`    "${second?.prompt}"  (door target ${n(doorAfter, 2)})`);

    const opened = doorAfter > doorBefore;
    check(
      "E moved the door — the key is the action, not a label",
      Math.abs(doorAfter - doorBefore) > 0.4,
      `door target ${n(doorBefore, 3)} -> ${n(doorAfter, 3)} after a real keydown`
    );
    check(
      "the first verb promised what E then did",
      first?.prompt === (opened ? "press E to open the door" : "press E to close the door"),
      `prompt said "${first?.prompt}" and the door ${opened ? "opened" : "closed"}`
    );
    check(
      "the verb inverted once the state changed",
      second?.prompt === (opened ? "press E to close the door" : "press E to open the door"),
      `prompt now says "${second?.prompt}" with the door ${opened ? "open" : "shut"}`
    );

    // Put it back, so a later phase or a reader of the frames is not looking at
    // a door this test left swinging.
    await page.keyboard.press("e");
    await step(400);
  } else {
    check("the door pose resolved for the verb-flip test", false, "no building.entryDoor service");
  }

  /**
   * Held E must not machine-gun a toggle. `keydown` repeats at the OS rate once
   * a key is held, every one of them reaching the same listener, and every
   * action here is a toggle — so without the `e.repeat` guard holding E would
   * start and stop the pump several times a second. Playwright's `keyboard.down`
   * does not synthesise repeats, so this asserts the guard directly *and*
   * measures the real held-key behaviour, which is that nothing further happens.
   */
  if (poses.pump) {
    await look(poses.pump.from, poses.pump.to);
    await step(320);
    const before = await hover();
    await page.keyboard.down("e");
    await step(900);
    const during = await hover();
    await page.keyboard.up("e");
    await step(120);
    const fired = during.activations.key - before.activations.key;
    console.log(`    holding E for 900 ms fired ${fired} activation(s)`);
    check("holding E fires exactly once, not once per key repeat", fired === 1, `${fired} activations while held`);
    const synthetic = await page.evaluate(() => {
      const a = window.__INTERACT.hover().activations.key;
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", repeat: true }));
      return window.__INTERACT.hover().activations.key - a;
    });
    check("a repeat keydown is ignored outright", synthetic === 0, `a repeat event fired ${synthetic} activations`);
    // Leave the pump as it was found.
    if ((await hover()).activations.key > before.activations.key) {
      await page.keyboard.press("e");
      await step(200);
    }
  }

  const hoverCostReport = await (async () => {
    await look(poses.pump.from, poses.pump.to);
    await step(2000);
    return hover();
  })();

  /* ================================================================= */
  /* 5. the controller: shift to hurry, space to hop                    */
  /* ================================================================= */
  /**
   * Needs the interactive page, because `?shot=` disables PlayerSystem
   * outright — so this is a second load rather than more work on the capture
   * page. `?reticle=1` comes along so the same page could answer an E question
   * if one arose, and so that `hover()` keeps sampling rather than reporting the
   * confident zero it reports when the hover ray is skipped.
   *
   * Everything here is asserted on numbers, not pixels, because every claim
   * being made is a number: the eye returned to standing to within a
   * millimetre, the hop apex matched its frame rate's prediction, nothing was
   * ever inside a blocker. A screenshot of a jump is a screenshot of a scene.
   */
  console.log("\n[reticle] 5. controller: shift and space");
  await ready(`${base}index.html?reticle=1`);
  await assertSceneGpu(page, { tag: "reticle", when: "on the controller page" });
  await step(400);

  /* ================================================================= */
  /* 5a. the bottle, from every spot a player can actually stand        */
  /* ================================================================= */
  /**
   * This section exists because a playtest found that **taking a bottle was
   * impossible**, and nothing in this harness noticed. One of the three
   * interactions in the brief, and from the only spot a player can stand at the
   * cooler the probe returned `cooler-door-2` before opening *and after* — the
   * open leaf swings across the sight line and sits 0.62 m from the eye, nearer
   * than the shelf. Reaching for a drink shut the door.
   *
   * The reason the old tests passed is the interesting part, and it is why this
   * one is built the way it is. Section 2's cooler pose is a *chosen* stance:
   * 0.95 m out from the leaf centre, aimed at the leaf. It is a fine test of
   * the cooler and it can never see this bug, because it was picked to look at
   * the door. **A stance chosen by the person writing the test tests the code
   * they were thinking about.** So the stances here are not chosen at all —
   * every position within reach where the body legally fits is enumerated from
   * the collision field and *all* of them are tested. If a player can stand
   * somewhere and fail to get a drink, one of these is that spot.
   *
   * The counter-test matters as much as the test: before the cooler is opened
   * the probe must **not** return the bottle. A priority rule that let the
   * grabbable win unconditionally would pass "can I take a bottle" while
   * letting the player reach through shut glass, which deletes the opening
   * interaction instead of fixing the taking one.
   *
   * Runs on the controller page rather than the capture page, and had to move
   * here to do it: **`collision.field` is published by `PlayerSystem.init()`
   * after its `if (ctx.shot) return`**, so on a `?shot=` page the service is
   * simply absent and every spot this section derives would have come from
   * nothing. The eye height is 1.65 to match `EYE_HEIGHT`, so the controller has
   * no standing-height correction to make and the ray leaves from where a real
   * player's eye would be.
   */
  console.log("\n[reticle] 5a. the bottle, from every standable spot within reach");
  /**
   * Re-derived per leaf state, not once up front. A cooler leaf is a blocker
   * that moves: the pocket in front of a shut door is somewhere a player can
   * stand, and the open leaf can sweep straight through it. Deriving once and
   * reusing the list for both sweeps would test the open door from positions a
   * player cannot occupy while it is open, and the question being asked is
   * always "from everywhere a player can stand *in this state*".
   */
  const deriveSpots = () =>
    page.evaluate(
      ([reach, bodyR, portalR, eyeH]) => {
        const g = window.__GAME;
        const field = g.tryGet("collision.field");
        const list = g.tryGet("building.grabbables");
        const one = g.tryGet("building.grabBottle");
        const b = (Array.isArray(list) && list.length ? list : one ? [one] : [])[0];
        if (!field || !b) return { field: !!field, bottle: !!b, spots: [] };

        b.updateWorldMatrix(true, false);
        const m = b.matrixWorld.elements;
        const bx = m[12];
        const by = m[13];
        const bz = m[14];
        const fh = g.tryGet("building.floorHeight") ?? g.tryGet("groundHeight");
        const probe = { x: 0, y: 0, z: 0 };
        const spots = [];

        // 10 cm lattice over the reach disc. Fine enough that a standable pocket
        // one body-width across cannot fall between samples.
        for (let dx = -reach; dx <= reach + 1e-9; dx += 0.1) {
          for (let dz = -reach; dz <= reach + 1e-9; dz += 0.1) {
            if (Math.hypot(dx, dz) > reach) continue;
            const x = bx + dx;
            const z = bz + dz;
            probe.x = x;
            probe.y = 0;
            probe.z = z;
            // Standable means the body fits here without collision having to
            // push it out — the same predicate, at the same radius, that
            // decides where walking can take the player.
            if (field.resolve(probe, field.radiusAt(x, z, bodyR, portalR))) continue;
            const y = (fh ? fh(x, z) : 0) + eyeH;
            // Reach is measured from the eye, which is where the ray starts.
            const eyeDist = Math.hypot(x - bx, y - by, z - bz);
            if (eyeDist > reach) continue;
            spots.push({
              from: [x, y, z],
              to: [bx, by, bz],
              eyeDist: Math.round(eyeDist * 1000) / 1000,
            });
          }
        }
        // Nearest first: if there is only one pocket these are all in it, and
        // the nearest is the one a player walking up to the cabinet stops at.
        spots.sort((p, q) => p.eyeDist - q.eyeDist);
        return { field: true, bottle: true, name: b.name || "bottle", at: [bx, by, bz], spots };
      },
      [2.2, 0.32, 0.2, 1.65]
    );

  /**
   * Drive every leaf to a known position and wait for the swing to *finish*.
   *
   * Set through the `setCooler` hook rather than by pressing E, because E
   * pointed at an open leaf with a bottle behind it is exactly the behaviour
   * under test — arranging the scene with it would make the test circular.
   * The hook calls the same `toggle()`, so the leaf still swings on its own
   * closer at its own rate.
   *
   * The wait is on `amount`, the leaf's physical position, not on `target`.
   * `target` flips on the frame of the press, and the reach priority reads
   * `amount` precisely so that a leaf which is still shut still blocks — so
   * sweeping before the swing completes would test the state the scene was
   * heading for rather than the one it is in.
   */
  const setCooler = async (open) => {
    const count = await page.evaluate(() => (window.__INTERACT.state().coolers ?? []).length);
    await page.evaluate(
      ([want, howMany]) => {
        for (let i = 0; i < howMany; i++) window.__INTERACT.setCooler(i, want);
      },
      [open, count]
    );
    await page
      .waitForFunction(
        (want) => {
          const cs = window.__INTERACT.state().coolers ?? [];
          return cs.length > 0 && cs.every((c) => (want ? c.amount > 0.98 : c.amount < 0.02));
        },
        open,
        { timeout: 5000 }
      )
      .catch(() => {});
    return page.evaluate(() => window.__INTERACT.state().coolers ?? []);
  };

  /**
   * Every spot in one page call. `probe()` re-runs the ray from wherever the
   * camera currently is, so nothing here has to wait for a frame — which is
   * what makes testing *all* the spots affordable rather than a chosen few.
   * Only the leaf swing costs real time, and it is paid once per state for the
   * whole set instead of once per spot.
   */
  const probeEverySpot = (spots) =>
    page.evaluate(([list]) => {
      const out = [];
      for (const s of list) {
        window.__INTERACT.look(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2]);
        const p = window.__INTERACT.probe();
        out.push({ eyeDist: s.eyeDist, kind: p?.kind ?? null, name: p?.name ?? null, distance: p?.distance ?? null });
      }
      return out;
    }, [spots]);

  const shutState = await setCooler(false);
  const whenShut = await deriveSpots();
  const shutSweep = await probeEverySpot(whenShut.spots);
  const openState = await setCooler(true);
  const whenOpen = await deriveSpots();
  const openSweep = await probeEverySpot(whenOpen.spots);

  check(
    "the collision field and a grabbable both resolved, so the spots are real",
    whenShut.field && whenShut.bottle,
    `collision.field ${whenShut.field ? "present" : "MISSING"}, grabbable ${whenShut.bottle ? "present" : "MISSING"}`
  );
  check(
    "there is somewhere a player can stand and reach the bottle from at all",
    whenOpen.spots.length > 0,
    `${whenOpen.spots.length} standable positions within 2.2 m of ${whenOpen.name ?? "the bottle"} with the cooler open — ` +
      `zero would mean the shelf is unreachable, which is a Building defect rather than a pick one`
  );

  if (whenOpen.spots.length) {
    const tally = (rows) => {
      const by = {};
      for (const r of rows) by[r.kind ?? "nothing"] = (by[r.kind ?? "nothing"] ?? 0) + 1;
      return (
        Object.entries(by)
          .map(([k, v]) => `${k} x${v}`)
          .join(", ") || "none"
      );
    };
    console.log(
      `    leaf amounts: shut ${shutState.map((c) => n(c.amount, 2)).join("/")}  ` +
        `open ${openState.map((c) => n(c.amount, 2)).join("/")}`
    );
    console.log(`    leaf shut, ${whenShut.spots.length} standable spot(s): ${tally(shutSweep)}`);
    console.log(
      `    leaf open, ${whenOpen.spots.length} standable spot(s) ` +
        `(${n(whenOpen.spots[0].eyeDist, 2)}-${n(whenOpen.spots[whenOpen.spots.length - 1].eyeDist, 2)} m): ${tally(openSweep)}`
    );

    const shutLeaks = shutSweep.filter((r) => r.kind === "bottle").length;
    const openBottle = openSweep.filter((r) => r.kind === "bottle").length;
    const leafWins = openSweep.filter((r) => r.kind === "cooler").length;

    check(
      "a shut cooler still wins, so nothing is grabbed through glass",
      shutLeaks === 0,
      `${shutLeaks} of ${whenShut.spots.length} spots offered the bottle with the leaf shut — that would delete the opening interaction`
    );
    check(
      "with the cooler open the bottle wins the pick from somewhere a player can stand",
      openBottle > 0,
      `${openBottle} of ${whenOpen.spots.length} standable spots resolve to the bottle — zero is the defect the playtest found`
    );
    check(
      "the open leaf never wins over the bottle behind it, from any standable spot",
      leafWins === 0,
      leafWins === 0
        ? `no spot of ${whenOpen.spots.length} resolves to the leaf once it is open`
        : `${leafWins} spots still resolve to the leaf — nearest-first is still in play and the drink is unreachable from them`
    );

    /**
     * Then one real interaction, at the nearest spot that resolves to the
     * bottle — the one a player walking up to the cabinet stops at. Real
     * keydown, DOM wording read off the element, and the leaf watched across
     * the press, because "E took the bottle" and "E shut the door" are
     * indistinguishable if you only check that E did *something*.
     */
    const firstIdx = Math.max(
      0,
      openSweep.findIndex((r) => r.kind === "bottle")
    );
    const first = whenOpen.spots[firstIdx];
    const bottleName = openSweep[firstIdx]?.name ?? whenOpen.name;
    await look(first.from, first.to);
    await step(320);
    const st = await reticleState();
    const hv = await hover();
    const before = await page.evaluate(() => window.__INTERACT.state());
    await page.keyboard.press("e");
    await step(450);
    const after = await page.evaluate(() => window.__INTERACT.state());
    const held = await page.evaluate(() => window.__INTERACT.probe());
    const leafMoved = Math.max(
      ...(after.coolers ?? []).map((c, i) => Math.abs(c.target - (before.coolers?.[i]?.target ?? 0)))
    );

    console.log(`    at ${n(first.eyeDist, 2)} m: "${st?.prompt}" -> real keydown E`);
    console.log(
      `           carried ${before.bottle?.carried} -> ${after.bottle?.carried}, ` +
        `leaf target moved ${n(leafMoved, 3)}, next probe ${held ? `${held.kind}/${held.name}` : "nothing"}`
    );

    check(
      "the wording names taking a bottle, not closing the cooler",
      st?.prompt === "press E to take a bottle",
      `the element read "${st?.prompt}"`
    );
    check(
      "the cached hover names the same thing the wording does",
      hv.target?.kind === "bottle" && hv.prompt === st?.prompt,
      `hover ${hv.target?.kind ?? "none"} / "${hv.prompt}"`
    );
    check(
      "E took the bottle — the brief requirement, from the spot a player stands at",
      after.bottle?.carried === true && before.bottle?.carried !== true,
      `carried ${before.bottle?.carried} -> ${after.bottle?.carried} after a real keydown at ${n(first.eyeDist, 2)} m`
    );
    check(
      "and the leaf did not move, so it took a drink rather than shutting the door",
      leafMoved < 0.4,
      `largest leaf target change across the press was ${n(leafMoved, 3)}`
    );
    check(
      "the bottle in hand is not offered a second time",
      !(held?.kind === "bottle" && held.name === bottleName),
      held ? `the next probe from the same spot returns ${held.kind}/${held.name}` : "the next probe returns nothing"
    );
  }

  /**
   * A per-frame recorder, and the penetration monitor is the important half.
   *
   * Each frame it clones the camera position and asks the collision field to
   * resolve the clone — `resolve` is a command that mutates, so the clone is
   * mandatory (NOTES case 36). If the clone moves, the player was inside
   * something solid on that frame. PlayerSystem resolves every frame *before*
   * the jump integration and every blocker is a height-less XZ rectangle, so
   * this should read a flat zero at every altitude; that is the claim, and
   * a jump that cleared a blocker would show up here as a non-zero depth on the
   * frames it was airborne.
   *
   * Registered as its own rAF chain after the scene is running, so it observes
   * each frame's *final* position rather than an intermediate one.
   */
  const startRecorder = () =>
    page.evaluate(
      ([bodyR, portalR]) => {
        const g = window.__GAME;
        const field = g.tryGet("collision.field");
        const probe = g.camera.position.clone();
        const rec = { on: true, samples: [], worstPen: 0, penFrames: 0, field: !!field };
        window.__REC = rec;
        const tick = () => {
          if (!rec.on) return;
          const p = g.camera.position;
          let pen = 0;
          if (field) {
            probe.copy(p);
            if (field.resolve(probe, field.radiusAt(p.x, p.z, bodyR, portalR))) {
              pen = Math.hypot(probe.x - p.x, probe.z - p.z);
            }
          }
          if (pen > 1e-6) rec.penFrames++;
          if (pen > rec.worstPen) rec.worstPen = pen;
          const r = window.__PLAYER?.();
          if (r && r.frames > 0) {
            rec.samples.push({
              eyeY: r.eyeY, standY: r.standY, off: r.offStanding, air: r.airborne,
              vy: r.vy, sp: r.speed, run: r.running, bob: r.bobAmount, jumps: r.jumps,
              x: p.x, z: p.z, pen,
            });
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return rec.field;
      },
      [0.32, 0.2]
    );
  const readRecorder = () => page.evaluate(() => ({ ...window.__REC, samples: window.__REC.samples.slice() }));
  const resetRecorder = () => page.evaluate(() => { window.__REC.samples.length = 0; });
  const stopRecorder = () => page.evaluate(() => { if (window.__REC) window.__REC.on = false; });

  const hasField = await startRecorder();
  check(
    "the collision field is published for the penetration monitor",
    hasField === true,
    hasField ? "collision.field resolved" : "NO collision.field service — the jump tests below would prove nothing about blockers"
  );

  const player0 = await page.evaluate(() => window.__PLAYER?.() ?? null);
  check(
    "the controller is live and reporting",
    player0 !== null && player0.frames > 0,
    player0 === null
      ? "window.__PLAYER is absent"
      : `update() has run ${player0.frames} frames` + (player0.frames > 0 ? "" : " — every number below is a default")
  );

  /**
   * A heading with eight clear metres in it, found rather than assumed.
   *
   * A blocked run does not fail loudly — it reports a low speed and reads as
   * "shift does not work" — so sixteen headings are probed against the collision
   * field and the first clear one wins, which survives someone moving a pump
   * island.
   *
   * Eight metres is not enough for the whole measurement, which now runs for
   * about ten seconds and would cover nearly twenty. `relane()` below solves
   * that instead of demanding a twenty-metre lane the forecourt does not have.
   */
  const heading = await page.evaluate(
    ([bodyR, portalR]) => {
      const g = window.__GAME;
      const field = g.tryGet("collision.field");
      const p = g.camera.position;
      const probe = p.clone();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const ux = Math.cos(a), uz = Math.sin(a);
        let clear = true;
        for (let d = 0.3; d <= 8.0001 && clear; d += 0.3) {
          probe.set(p.x + ux * d, p.y, p.z + uz * d);
          if (field.resolve(probe, field.radiusAt(probe.x, probe.z, bodyR, portalR))) clear = false;
        }
        if (clear) return { ux, uz, deg: Math.round((a * 180) / Math.PI), from: [p.x, p.y, p.z] };
      }
      return null;
    },
    [0.32, 0.2]
  );
  check(
    "found eight clear metres to walk down",
    heading !== null,
    heading ? `heading ${heading.deg}deg is clear for 8 m` : "every one of 16 headings from spawn is blocked within 8 m"
  );

  const walkTo = async (ux, uz) => {
    const from = heading.from;
    await page.evaluate(
      ([f, t]) => window.__INTERACT.look(f[0], f[1], f[2], t[0], t[1], t[2]),
      [from, [from[0] + ux * 10, from[1], from[2] + uz * 10]]
    );
    await step(80);
  };

  /* ---- shift ------------------------------------------------------- */
  /**
   * **Measured by ground covered, not by the speed the controller reports.**
   *
   * The version this replaces asserted on `__PLAYER().speed`, which is the
   * magnitude of the velocity vector about to be integrated — the controller's
   * *intention*. It reported the ratio as 1.7000x to four decimal places while a
   * playtest measuring displacement got 2.158 m/s and an effective 1.541x. Both
   * numbers were honestly obtained and the displacement one is the real one,
   * because displacement is what the player feels; a test that agrees exactly
   * with the code's own arithmetic is measuring the intent and cannot see
   * anything that happens between the intent and the body.
   *
   * `travelled` accumulates post-collision inside `update()`, so this reads the
   * distance the body went. `resolves` and `simTime` come along to say *why* if
   * it falls short, and there are exactly three things that can take it:
   *
   * **The ramp.** The exponential needs ~0.25 s, and a window that starts at the
   * key press contains motion the player asked for and has not got yet. Measured
   * separately below rather than mixed in.
   *
   * **Collision.** `resolves > 0` means the body was being pushed out of
   * something during the window, so the path grazed a blocker and the shortfall
   * is geometry rather than the controller.
   *
   * **The dt clamp, and this is the one that explains the playtest.** `Game.frame`
   * runs `Math.min(clock.getDelta(), 0.1)`, so a frame slower than 100 ms advances
   * the simulation by 100 ms and no more. The player genuinely covers less ground
   * during a hitch — and **the loss is proportional to speed**, so the same stall
   * costs a sprint 1.7x what it costs a walk. That is why a run can report the
   * walk at exactly 1.400 and the sprint 9.3% short in the same session: the
   * hitch landed in the sprint window. The clamp is deliberate and must stay —
   * unclamped, a 300 ms stall would advance the body 0.71 m in one step against a
   * 0.32 m collision radius, i.e. straight through a wall.
   *
   * So two denominators, and both are displacement:
   *   ground    metres per second of *wall clock* — what the player feels,
   *             hitches included.
   *   groundSim metres per second of *simulated* time — what the controller
   *             delivered. This is what the multiplier is asserted against,
   *             because a busy machine must not be able to report a working
   *             feature as broken (NOTES case 78).
   * Their difference is the clamp loss, reported explicitly.
   */
  console.log(`    walking on heading ${heading?.deg ?? "?"}deg`);
  let peakBob = 0;
  if (heading) {
    /** Ground covered over a window, plus the diagnostics for a shortfall. */
    const measure = async (ms) => {
      const a = await page.evaluate(() => {
        const r = window.__PLAYER();
        return { d: r.travelled, t: r.simTime, res: r.resolves, w: performance.now() };
      });
      await step(ms);
      const b = await page.evaluate(() => {
        const r = window.__PLAYER();
        return { d: r.travelled, t: r.simTime, res: r.resolves, w: performance.now() };
      });
      const dist = b.d - a.d;
      const sim = b.t - a.t;
      const wall = (b.w - a.w) / 1000;
      return {
        dist,
        sim,
        wall,
        resolves: b.res - a.res,
        /** The number that matters: metres per second of real time. */
        ground: dist / wall,
        /** Same distance over simulated time. Differs only if dt is clamped. */
        groundSim: dist / sim,
      };
    };

    /**
     * Back to the head of the clear lane, without letting go of anything.
     *
     * The measurement needs ~19 m of straight line and the forecourt has 8, so
     * the player is returned to the start before each phase instead. This works
     * because `look()` moves the camera and `velocity` is PlayerSystem's own
     * field — it survives the teleport, so a window that begins after a relane
     * begins at the steady speed rather than re-ramping.
     *
     * It also cannot forge distance: `travelled` accumulates inside `update()`
     * from a `prevX` captured in that same call, so a position change made
     * between frames contributes nothing to it.
     *
     * The alternative was a 20 m lane, which does not exist here, or a shorter
     * window — and a shorter window is worse, because the whole point is to
     * separate steady state from the ramp.
     */
    const relane = () => walkTo(heading.ux, heading.uz);

    await resetRecorder();
    await relane();
    await page.keyboard.down("KeyW");

    // Ramp-inclusive walk, straight from the key press.
    const walkBurst = await measure(700);
    // Then settle and measure the top of the walk.
    await relane();
    await step(900);
    await relane();
    const walkSteady = await measure(2000);

    await relane();
    await page.keyboard.down("ShiftLeft");
    const runBurst = await measure(700);
    await relane();
    await step(900);
    await relane();
    const runSteady = await measure(2000);
    const runRec = await readRecorder();
    peakBob = Math.max(...runRec.samples.map((s) => s.bob));

    await page.keyboard.up("ShiftLeft");
    await relane();
    await step(1000);
    await relane();
    const relaxed = await measure(1200);
    await page.keyboard.up("KeyW");
    await step(500);

    const line = (label, m) =>
      console.log(
        `    ${label.padEnd(22)} ${n(m.ground, 3)} m/s wall  ${n(m.groundSim, 3)} m/s simulated  ` +
          `(${n(m.dist, 3)} m in ${n(m.wall, 3)} s wall / ${n(m.sim, 3)} s sim, ` +
          `${m.resolves} collision resolve${m.resolves === 1 ? "" : "s"})`
      );
    line("walk, from key press", walkBurst);
    line("walk, steady", walkSteady);
    line("shift, from key press", runBurst);
    line("shift, steady", runSteady);
    line("after releasing shift", relaxed);
    const ratio = runSteady.groundSim / walkSteady.groundSim;
    const ratioWall = runSteady.ground / walkSteady.ground;
    const clampLoss = runSteady.wall - runSteady.sim;
    console.log(
      `    steady ratio ${n(ratio, 4)}x simulated, ${n(ratioWall, 4)}x wall clock, against the 1.700x the constant asks for`
    );
    console.log(
      `    dt clamp lost ${n(clampLoss * 1000, 0)} ms of the sprint window ` +
        `(~${n(clampLoss * 2.38 * 1000, 0)} mm of ground); ${n(peakBob, 3)} peak head-bob multiplier (capped at 1.3)`
    );

    check(
      "the walk covers 1.4 m of ground per simulated second",
      Math.abs(walkSteady.groundSim - 1.4) < 0.05,
      `${n(walkSteady.groundSim, 4)} m/s by displacement`
    );
    check(
      "shift covers the ground its multiplier promises",
      Math.abs(runSteady.groundSim - 2.38) < 0.08,
      `${n(runSteady.groundSim, 4)} m/s by displacement against 2.38 predicted — ` +
        `${n(runSteady.dist, 3)} m in ${n(runSteady.sim, 3)} s simulated, ${runSteady.resolves} resolves`
    );
    check(
      "the ratio holds over ground, not just in the controller's own numbers",
      Math.abs(ratio - 1.7) < 0.05,
      `${n(ratio, 4)}x by displacement`
    );
    check(
      "shift is a brisk walk, not a sprint",
      runSteady.groundSim < 2.5,
      `${n(runSteady.groundSim, 4)} m/s — anything over 2.5 stops being a walk`
    );
    check(
      "nothing was grazing a blocker during the measurement",
      walkSteady.resolves === 0 && runSteady.resolves === 0,
      `${walkSteady.resolves} resolves walking, ${runSteady.resolves} sprinting — a shortfall with resolves in it is collision, not the controller`
    );
    /**
     * Reported rather than merely tolerated. This is the whole explanation for a
     * sprint that measures short over the ground while the multiplier is exactly
     * right, so it gets its own line and its own threshold — and the threshold is
     * about the *machine*, which is why the message says so instead of blaming
     * the feature.
     */
    check(
      "the window was clean enough for the wall-clock figure to mean anything",
      clampLoss < 0.06,
      clampLoss < 0.06
        ? `wall clock ran ${n(clampLoss * 1000, 0)} ms ahead of simulated time over ${n(runSteady.wall, 2)} s`
        : `${n(clampLoss * 1000, 0)} ms of frame hitching inside the window, which the dt clamp turns into ` +
          `~${n(clampLoss * 2.38 * 1000, 0)} mm of ground the sprint did not cover — contention, not the controller`
    );
    check(
      "a short burst is slower than the steady speed, because it includes the ramp",
      runBurst.groundSim < runSteady.groundSim,
      `burst ${n(runBurst.groundSim, 3)} vs steady ${n(runSteady.groundSim, 3)} m/s — the exponential is real motion the player has not got yet`
    );
    check("releasing shift returns to walking pace", Math.abs(relaxed.groundSim - 1.4) < 0.06, `${n(relaxed.groundSim, 4)} m/s after release`);
    check(
      "head-bob amplitude follows the speed but stays capped",
      peakBob > 1.05 && peakBob <= 1.301,
      `peak amplitude multiplier ${n(peakBob, 4)} — uncapped it would reach 1.7`
    );
  }

  /* ---- space ------------------------------------------------------- */
  /**
   * Five hops from a standstill. The drift check is the point: `offStanding` is
   * the eye's height above where standing puts it, and it must come back to zero
   * after every single hop rather than accumulating a little residue each time —
   * which is exactly what easing down to the standing height would have done,
   * since an exponential approach never actually arrives.
   *
   * ## The apex is a function of frame rate, so it is asserted as one
   *
   * The analytic apex is `JUMP_SPEED^2 / 2G` = 319 mm, and a run will never
   * measure that. Semi-implicit Euler takes gravity off the velocity *before*
   * integrating position, which under-shoots the top of the arc by about
   * `JUMP_SPEED * dt / 2` — 21 mm at 60 Hz, giving 298 mm. Two independent runs
   * read 311 mm on a contended machine and 297 mm on a clean one, and the
   * difference between them is frame time, not behaviour.
   *
   * So the expectation is computed from the frame time actually observed during
   * each hop rather than from a fixed band. A fixed band has to be wide enough
   * for the worst frame rate it will ever see, and `dt` here is clamped at
   * 100 ms, where the discrete apex collapses to about 206 mm — so any band
   * loose enough to be safe would also pass a jump that had lost a third of its
   * height. This way the assertion tightens to +/- 12 mm and still cannot fail
   * because the machine was busy.
   */
  await step(300);
  await resetRecorder();
  const hops = [];
  for (let i = 0; i < 5; i++) {
    const before = await page.evaluate(() => window.__PLAYER());
    await resetRecorder();
    await page.keyboard.press("Space");
    await step(900); // airtime is 0.51 s at 2.5 m/s under 9.81
    const rec = await readRecorder();
    const after = await page.evaluate(() => window.__PLAYER());
    const apex = Math.max(...rec.samples.map((s) => s.eyeY - s.standY));
    const airFrames = rec.samples.filter((s) => s.air).length;
    // Mean simulated frame time across the hop, from the controller's own
    // accumulators — the same dt the integration used, so the prediction below
    // is made from the number the arc was actually built out of.
    const meanDt = after.frames > before.frames ? (after.simTime - before.simTime) / (after.frames - before.frames) : 0;
    hops.push({
      apex,
      airFrames,
      meanDt,
      // 2.5^2 / (2 * 9.81), less the half-step gravity takes off before the
      // first position update.
      predicted: (2.5 * 2.5) / (2 * 9.81) - (2.5 * meanDt) / 2,
      landedOff: after.offStanding,
      stillAir: after.airborne,
      jumps: after.jumps - before.jumps,
      pen: Math.max(...rec.samples.map((s) => s.pen)),
    });
    await step(200);
  }
  for (const [i, h] of hops.entries()) {
    console.log(
      `    hop ${i + 1}: apex ${n(h.apex * 1000, 0).padStart(4)} mm vs ${n(h.predicted * 1000, 0)} mm predicted at ` +
        `${n(h.meanDt * 1000, 1)} ms/frame, over ${String(h.airFrames).padStart(3)} airborne frames, ` +
        `landed ${n(h.landedOff * 1000, 3)} mm off standing, jumps +${h.jumps}`
    );
  }
  const worstLanding = Math.max(...hops.map((h) => Math.abs(h.landedOff)));
  const worstApexErr = Math.max(...hops.map((h) => Math.abs(h.apex - h.predicted)));
  check(
    "every hop reached the height its constants and its frame rate predict",
    worstApexErr < 0.012,
    `worst apex was ${n(worstApexErr * 1000, 1)} mm off prediction; measured ` +
      `${hops.map((h) => n(h.apex * 1000, 0)).join("/")} mm against ${hops.map((h) => n(h.predicted * 1000, 0)).join("/")} mm ` +
      `(analytic 319 mm, less the half-step Euler loses at ${n(hops[0].meanDt * 1000, 1)} ms/frame)`
  );
  check("every hop landed and cleared the airborne flag", hops.every((h) => !h.stillAir && h.airFrames > 10), `${hops.filter((h) => h.stillAir).length} hops still airborne after 900 ms`);
  check(
    "the eye returns exactly to standing height, with no drift over five hops",
    worstLanding < 0.001,
    `worst landing was ${n(worstLanding * 1000, 4)} mm off standing — a drift would grow hop by hop: ${hops.map((h) => n(h.landedOff * 1000, 3)).join(", ")} mm`
  );
  check("each press produced exactly one jump", hops.every((h) => h.jumps === 1), `jump counts ${hops.map((h) => h.jumps).join(", ")}`);

  /* ---- it cannot be held to fly, or double-jumped ------------------ */
  await resetRecorder();
  const beforeHold = await page.evaluate(() => window.__PLAYER());
  await page.keyboard.down("Space");
  await step(3000);
  const heldRec = await readRecorder();
  await page.keyboard.up("Space");
  await step(600);
  const afterHold = await page.evaluate(() => window.__PLAYER());
  const heldApex = Math.max(...heldRec.samples.map((s) => s.eyeY - s.standY));
  const heldJumps = afterHold.jumps - beforeHold.jumps;
  console.log(`    holding space for 3 s: ${heldJumps} hops, highest the eye ever got was ${n(heldApex * 1000, 0)} mm above standing`);
  check(
    "space cannot be held to fly — the eye never climbs past one hop's apex",
    heldApex < 0.36,
    `reached ${n(heldApex * 1000, 0)} mm above standing while held, against ~298 mm for a single hop at 60 Hz`
  );
  check("holding space re-hops from the ground rather than accumulating height", heldJumps >= 2 && heldJumps <= 8, `${heldJumps} hops in 3 s`);
  check("the eye is back at standing after the held run", Math.abs(afterHold.offStanding) < 0.001, `${n(afterHold.offStanding * 1000, 3)} mm off standing`);

  // Double jump: one press, then a second while unambiguously airborne.
  await resetRecorder();
  const beforeDouble = await page.evaluate(() => window.__PLAYER());
  await page.keyboard.press("Space");
  await step(180); // ~35% into a 510 ms airtime, well clear of the ground
  const midAir = await page.evaluate(() => window.__PLAYER());
  await page.keyboard.press("Space");
  await step(900);
  const afterDouble = await page.evaluate(() => window.__PLAYER());
  const dRec = await readRecorder();
  const dApex = Math.max(...dRec.samples.map((s) => s.eyeY - s.standY));
  console.log(`    second press ${n(midAir.eyeY - midAir.standY, 3)} m up (airborne=${midAir.airborne}): total hops ${afterDouble.jumps - beforeDouble.jumps}, apex ${n(dApex * 1000, 0)} mm`);
  check("the second press landed while genuinely airborne", midAir.airborne === true, `airborne=${midAir.airborne} at the second press — the test did not test anything`);
  check("a press in mid-air does nothing at all", afterDouble.jumps - beforeDouble.jumps === 1, `${afterDouble.jumps - beforeDouble.jumps} jumps from two presses`);
  check("and so gains no height", dApex < 0.35, `apex ${n(dApex * 1000, 0)} mm from a double press vs ~298 mm from one`);

  /* ---- the floor-height service, both sides of the threshold ------- */
  /**
   * The two heights differ by design — `building.floorHeight` inside the shell,
   * `groundHeight` outside — so a jump has to land on whichever one is under the
   * player at the moment they come down, not on the one that was under them when
   * they left the ground.
   *
   * Tested by moving the player in XZ *while airborne*, which is the strict
   * version of jumping across the threshold: the surface under them changes
   * mid-flight, and the landing must snap to the new one. Walking through the
   * doorway would test the same code path and would additionally depend on
   * threading a 1.15 m portal, so it would fail for reasons that are not this.
   */
  const spots = await page.evaluate(() => {
    const g = window.__GAME;
    const fh = g.tryGet("building.floorHeight");
    const gh = g.tryGet("groundHeight");
    const fp = g.tryGet("building.footprint");
    if (!fh || !gh || !fp) return null;
    const inside = [(fp.minX + fp.maxX) / 2, (fp.minZ + fp.maxZ) / 2];
    const outside = [(fp.minX + fp.maxX) / 2, fp.minZ - 4];
    return {
      inside: { xz: inside, floor: fh(inside[0], inside[1]), ground: gh(inside[0], inside[1]) },
      outside: { xz: outside, floor: fh(outside[0], outside[1]), ground: gh(outside[0], outside[1]) },
    };
  });
  if (spots) {
    const stepUp = spots.inside.floor - spots.outside.floor;
    console.log(`    floor inside ${n(spots.inside.floor, 3)} m, outside ${n(spots.outside.floor, 3)} m — a ${n(stepUp * 1000, 0)} mm step`);
    check("the two surfaces really do differ, so the test below is meaningful", Math.abs(stepUp) > 0.05, `only ${n(stepUp * 1000, 1)} mm apart`);

    const landAt = async (from, toXZ, label) => {
      await page.evaluate(([xz, y]) => {
        const c = window.__GAME.camera;
        c.position.set(xz[0], y, xz[1]);
      }, [from.xz, from.floor + 1.65]);
      await step(500); // settle onto the surface
      await resetRecorder();
      await page.keyboard.press("Space");
      await step(200); // airborne
      const mid = await page.evaluate(() => window.__PLAYER());
      // Teleport in XZ only, mid-flight. The surface under the player changes.
      await page.evaluate((xz) => {
        const c = window.__GAME.camera;
        c.position.x = xz[0];
        c.position.z = xz[1];
      }, toXZ);
      await step(1400);
      const after = await page.evaluate(() => window.__PLAYER());
      const rec = await readRecorder();
      console.log(
        `    ${label}: left a surface at ${n(mid.standY - 1.65, 3)} m, landed on one at ${n(after.standY - 1.65, 3)} m, ` +
          `${n(after.offStanding * 1000, 3)} mm off standing, worst penetration ${n(Math.max(...rec.samples.map((s) => s.pen)) * 1000, 3)} mm`
      );
      check(`${label}: landed on the surface that was underneath at touchdown`, Math.abs(after.offStanding) < 0.001 && !after.airborne, `${n(after.offStanding * 1000, 3)} mm off, airborne=${after.airborne}`);
      return after;
    };
    await landAt(spots.outside, spots.inside.xz, "hop outside -> inside");
    await landAt(spots.inside, spots.outside.xz, "hop inside -> outside");
  } else {
    check("the floor-height services resolved for the threshold test", false, "missing building.floorHeight, groundHeight or building.footprint");
  }

  /* ---- jumping at every blocker ------------------------------------ */
  /**
   * The bug that would be worse than having no jump: a hop that puts the player
   * somewhere the walk cannot reach. Walk hard into a blocker while hopping
   * continuously, at each of several blockers, and let the monitor watch every
   * frame for a position inside solid geometry.
   *
   * The mechanism says this is impossible — blockers are XZ rectangles with no
   * height and `resolve` runs before the vertical integration, so altitude is
   * not an input to collision at all — but "the mechanism says so" is how this
   * project's silent failures are usually introduced, so it is measured.
   */
  /**
   * Read off the collision field itself rather than from per-system services.
   *
   * `CollisionField` is the union of every producer's blockers, which is exactly
   * the set this test needs — asking PumpSystem and CarSystem separately would
   * mean guessing three service names and silently testing fewer things than
   * the log claims when one of them is wrong. The widest blockers are picked so
   * a charge cannot slip past the corner of the thing it is aimed at.
   */
  const targets = await page.evaluate(() => {
    const f = window.__GAME.tryGet("collision.field");
    if (!f) return [];
    const rects = [];
    for (const g of f.groups) {
      for (const r of g.blockers) {
        rects.push({
          name: g.key,
          area: (r.maxX - r.minX) * (r.maxZ - r.minZ),
          cx: (r.minX + r.maxX) / 2,
          cz: (r.minZ + r.maxZ) / 2,
        });
      }
    }
    // One target per producer, the widest each, so the four charges hit four
    // different kinds of thing rather than four bollards from the same group.
    const best = new Map();
    for (const r of rects) {
      const prev = best.get(r.name);
      if (!prev || r.area > prev.area) best.set(r.name, r);
    }
    return [...best.values()].sort((a, b) => b.area - a.area).slice(0, 5);
  });
  console.log(`    charging ${targets.length} blocker(s) while hopping: ${targets.map((t) => t.name).join(", ")}`);
  await resetRecorder();
  for (const t of targets) {
    // Stand 3.5 m out on the -Z side and run at it, hopping the whole way. The
    // eye is placed at the *correct* height for that spot rather than at
    // whatever height the previous target left it — otherwise the follow spends
    // the first second climbing, the grounded gate refuses every press, and the
    // charge would silently test walking into a wall instead of jumping at one.
    await page.evaluate(([t]) => {
      const g = window.__GAME;
      const fh = g.tryGet("building.floorHeight") ?? g.tryGet("groundHeight");
      const x = t.cx;
      const z = t.cz - 3.5;
      const y = (fh ? fh(x, z) : 0) + 1.65;
      window.__INTERACT.look(x, y, z, t.cx, y, t.cz);
    }, [t]);
    await step(500);
    await page.keyboard.down("KeyW");
    await page.keyboard.down("ShiftLeft");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Space");
      await step(420);
    }
    await page.keyboard.up("ShiftLeft");
    await page.keyboard.up("KeyW");
    await step(900);
  }
  const charge = await readRecorder();
  const worstPen = charge.worstPen;
  const airborneFrames = charge.samples.filter((s) => s.air).length;
  console.log(
    `    ${charge.samples.length} frames observed, ${airborneFrames} of them airborne; ` +
      `worst penetration into any blocker ${n(worstPen * 1000, 4)} mm over ${charge.penFrames} frame(s)`
  );
  check(
    "the charge actually left the ground — otherwise nothing about jumping was tested",
    airborneFrames > 100,
    `${airborneFrames} airborne frames of ${charge.samples.length}`
  );
  check(
    "jumping never puts the player inside a blocker",
    worstPen < 0.001,
    worstPen < 0.001
      ? `worst penetration ${n(worstPen * 1000, 4)} mm across ${airborneFrames} airborne frames`
      : `worst penetration ${n(worstPen * 1000, 4)} mm on ${charge.penFrames} frames — a hop reached somewhere the walk cannot`
  );
  const finalStand = await page.evaluate(() => window.__PLAYER());
  check("the eye is at standing height after all of that", Math.abs(finalStand.offStanding) < 0.002 && !finalStand.airborne, `${n(finalStand.offStanding * 1000, 3)} mm off standing, airborne=${finalStand.airborne}`);

  /* ================================================================= */
  /* 6. frame cost                                                      */
  /* ================================================================= */
  console.log("\n[reticle] 6. frame cost");
  console.log(`    hover ray (InteractionSystem):  ${n(hoverCostReport.costUs, 1)} us/frame mean over ${hoverCostReport.samples} frames`);
  check(
    "the hover cost was measured with the ray actually running",
    hoverCostReport.samples > 60,
    `${hoverCostReport.samples} samples — without ?reticle=1 the ray is skipped and this reads a confident 0 us`
  );
  check("hover ray costs well under a frame", hoverCostReport.costUs < 500, `${n(hoverCostReport.costUs, 1)} us`);

  // The controller: measured standing still, then while sprinting and hopping,
  // so the added input handling and grounded test are inside the busy number.
  // The recorder is itself a per-frame raycast-free but non-trivial cost, and it
  // must not be inside the number being reported.
  await stopRecorder();
  await step(300);
  /**
   * `costUs` is a running mean over every frame since load, which by now
   * includes the sprint and jump phases. Windowed means are backed out of two
   * readings of the running mean and its sample count, so "standing still" is
   * measured over frames where the player was in fact standing still.
   */
  const windowedCost = async (during) => {
    const a = await page.evaluate(() => ({ us: window.__PLAYER().costUs, n: window.__PLAYER().samples }));
    await during();
    const b = await page.evaluate(() => ({ us: window.__PLAYER().costUs, n: window.__PLAYER().samples }));
    return { us: (b.us * b.n - a.us * a.n) / (b.n - a.n), frames: b.n - a.n };
  };
  const costStill = await windowedCost(() => step(2000));
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ShiftLeft");
  const costBusy = await windowedCost(async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Space");
      await step(400);
    }
  });
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  console.log(`    PlayerSystem.update, standing still:      ${n(costStill.us, 1)} us/frame over ${costStill.frames} frames`);
  console.log(`    PlayerSystem.update, sprinting + hopping: ${n(costBusy.us, 1)} us/frame over ${costBusy.frames} frames`);
  console.log(`    (the whole of update(), not the delta — the added work is 3 Set lookups, a compare and 2 multiplies)`);
  check(
    "the controller costs a rounding error either way",
    costStill.us < 200 && costBusy.us < 200,
    `${n(costStill.us, 1)} us still, ${n(costBusy.us, 1)} us busy`
  );

  /* ================================================================= */
  console.log("\n[reticle] page health");
  const shader = problems.filter((p) => SHADER_FAIL.test(p));
  for (const p of problems.slice(0, 10)) console.log(`    ${p}`);
  if (shaderNotes.length) {
    // Not a failure, and not this harness's shader — printed so it is on the
    // record for whoever owns the material rather than swallowed.
    const first = shaderNotes[0].split("\n").find((l) => /warning/i.test(l)) ?? shaderNotes[0];
    console.log(`    ${shaderNotes.length} shader program(s) linked with warnings, e.g. ${first.trim()}`);
  }
  check("no shader compile/link failures", shader.length === 0, shader[0] ?? "none");
  check("no uncaught page errors", problems.filter((p) => p.startsWith("pageerror")).length === 0, problems.find((p) => p.startsWith("pageerror")) ?? "");
  const sysErrors = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
  check("window.__SYSTEM_ERRORS is empty", sysErrors.length === 0, JSON.stringify(sysErrors.slice(0, 2)));
  await assertSceneGpu(page, { tag: "reticle", when: "after the last frame" });

  console.log(`\n[reticle] ${results.filter((r) => r.ok).length}/${results.length} assertions passed`);
  console.log(`[reticle] frames in ${path.relative(ROOT, SHOT_DIR)}/`);
  await page.close();
  await context.close();
  await shutdown(failures.length ? 1 : 0, failures.length ? `${failures.length} assertion(s) failed:\n  - ${failures.join("\n  - ")}` : null);
}

/**
 * Two screenshots of the same frame, differing only in whether the reticle
 * node is rendered. An inline `display:none` beats the stylesheet's
 * `.shown { display: block }`, and `Reticle.set()` only ever touches
 * classList, so this suppresses the mark without touching the state machine
 * that decides what it should be showing.
 */
async function capturePair(page, name) {
  const shot = async (suffix) => {
    const file = path.join(SHOT_DIR, `${name}-${suffix}.png`);
    await page.screenshot({ path: file, type: "png" });
    return PNG.sync.read(await fs.readFile(file));
  };
  await page.evaluate(() => {
    const el = document.getElementById("reticle");
    if (el) el.style.display = "none";
  });
  const off = await shot("off");
  await page.evaluate(() => {
    const el = document.getElementById("reticle");
    if (el) el.style.display = "";
  });
  const on = await shot("on");
  return { off, on };
}

/**
 * One image a person can look at: a crop from every pose, magnified with
 * nearest-neighbour so no resampling invents or softens a pixel, laid out in a
 * row over the real background each state has to survive.
 *
 * Two strips rather than one, because the two elements want different
 * magnifications to be judged. The dot is 8-12 px and needs 6x before the eye
 * can see what the antialiasing is doing to its dark ring; the prompt is over
 * 200 px wide and at 6x would be 1300 px per cell, so it gets 2x — enough to
 * read the letterforms and the shadow, which is what is being judged there.
 *
 * `cw`/`ch` are the crop in source pixels, `dy` offsets the crop centre down
 * from the frame centre so the prompt strip is centred on the text rather than
 * on the dot.
 */
async function writeStrip(file, rows, { cw = 48, ch = 48, dy = 0, zoom = 6 } = {}) {
  const GAP = 8;
  const cellW = cw * zoom;
  const cellH = ch * zoom;
  const w = rows.length * (cellW + GAP) + GAP;
  const h = cellH + GAP * 2;
  const out = new PNG({ width: w, height: h });
  out.data.fill(24);
  rows.forEach((r, k) => {
    const src = r.pair.on;
    const ox = GAP + k * (cellW + GAP);
    const oy = GAP;
    const sx = Math.round(src.width / 2 - cw / 2);
    const sy = Math.round(src.height / 2 - ch / 2 + dy);
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const si = ((sy + Math.floor(y / zoom)) * src.width + (sx + Math.floor(x / zoom))) * 4;
        const di = ((oy + y) * w + ox + x) * 4;
        out.data[di] = src.data[si];
        out.data[di + 1] = src.data[si + 1];
        out.data[di + 2] = src.data[si + 2];
        out.data[di + 3] = 255;
      }
    }
  });
  await fs.writeFile(file, PNG.sync.write(out));
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
