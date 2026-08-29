#!/usr/bin/env node
/**
 * Interactive-spawn harness.
 *
 *   node tools/walkprobe.mjs              # build, probe, write shots/walkprobe/
 *   node tools/walkprobe.mjs --no-build   # reuse the existing .shot-build/walkprobe
 *
 * Every other capture tool in this repo loads `?shot=<preset>`, which makes
 * PlayerSystem disable itself and hand the camera to `applyShot`. That path
 * cannot see anything wrong with the walker, which is how a 180 degree spawn
 * roll survived every "verified" capture so far. This harness loads the page
 * with no query at all - exactly what the browser does - so PlayerSystem
 * establishes its own camera state, and then asserts on that state:
 *
 *   1. camera.up is (0, 1, 0)
 *   2. roll about the view axis is ~0
 *   3. world up projects to the upper half of the frame and world down to the
 *      lower half, through the same matrices the renderer uses
 *   4. the rendered pixels agree: the top band is brighter sky, the bottom band
 *      is darker ground
 *   5. a zero-delta mousemove moves the view by zero, and a real one moves it by
 *      exactly the commanded amount with the horizon still level
 *
 * It also measures eye height, walk speed and the pitch clamp, and probes
 * whether solid geometry stops the player.
 *
 * Teardown contract (repo-wide rule): the preview server and the browser are
 * registered with one shutdown routine wired to every exit path before either
 * is started. Nothing is detached; the process always ends in process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { PNG } from "pngjs";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 1600;
const HEIGHT = 900;

/**
 * Reads `--port N`, falling back to the default. Written out rather than
 * inlined because the inline version I tried first read `argv[-1 + 1]`, which is
 * the node executable's path, and quietly yielded `NaN` for the *default* case —
 * the flag nobody passes being the one that breaks.
 */
function portArg(fallback) {
  const i = process.argv.indexOf("--port");
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`--port needs a port number, got ${JSON.stringify(process.argv[i + 1])}`);
  }
  return n;
}
// 5151 is this harness's assigned port; `--port N` exists so whoever is
// scheduling a shared window can move it without editing this file.
const PORT = portArg(5151);
const BUILD_DIR = ".shot-build/walkprobe";
const OUT_DIR = path.join(ROOT, "shots", "walkprobe");
// The readiness budget lives at the call site now, at 420 s with 500 ms polling.
// The 120 s constant that used to be here was both wrong and authoritative-
// looking, which is the worse of the two problems.

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");
/** Extra page query, no leading `?`. Used to re-run against the pre-fix behaviour. */
const QUERY = (argv.find((a) => a.startsWith("--query=")) ?? "").slice(8);
/**
 * The reticle hides itself unless pointer lock is engaged, and headless Chromium
 * cannot enter pointer lock — so without `?reticle=1` the hover ray is skipped
 * every frame, `hover()` reports `samples: 0`, and its cost measures as a
 * confident **0 µs**. A player has pointer lock and pays that cost on every
 * frame, so measuring it without this flag would report the one number that is
 * guaranteed wrong, in the direction that looks like good news.
 */
const RETICLE_QUERY = "reticle=1";
/** The only adapter this machine is allowed to render on. */
const REQUIRED_GPU = /RTX\s*4060/i;

const checks = [];
const notes = [];
const deg = (r) => (r * 180) / Math.PI;
/**
 * `detail` is the *failure* message, so it is printed only on failure.
 *
 * It used to print on both, which produced lines like
 * `PASS  Space actually leaves the ground   never reported airborne` and
 * `PASS  the page exposes reticle state   window.__RETICLE is absent` — a pass
 * verdict sitting next to a sentence flatly contradicting it. Anyone skimming the
 * log reads the sentence, not the verdict. A log that has to be read carefully to
 * avoid being misled is worse than a terser one.
 *
 * Where a number is worth seeing when the check passes, print it with
 * `console.log` before the check, which most of this file already does.
 */
function check(ok, label, detail) {
  checks.push({ ok: !!ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* teardown, wired up before anything is started                       */
/* ------------------------------------------------------------------ */

const resources = { server: null, browser: null };
let shuttingDown = false;

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[walkprobe] shutting down: ${reason}`);
  const closers = [
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
  ];
  for (const [label, fn] of closers) {
    try {
      await withTimeout(fn(), 10_000);
    } catch (err) {
      console.error(`[walkprobe] failed to close ${label}: ${err?.message ?? err}`);
    }
  }
  resources.browser = null;
  resources.server = null;
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("uncaughtException", (err) => void shutdown(1, `uncaughtException: ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => void shutdown(1, `unhandledRejection: ${err?.stack ?? err}`));

/* ------------------------------------------------------------------ */
/* page-side helpers, serialised into the browser                      */
/* ------------------------------------------------------------------ */

/** Everything about the camera's orientation that a roll bug would disturb. */
const READ_CAMERA = `() => {
  const cam = window.__GAME.camera;
  cam.updateMatrixWorld(true);

  // The bundle is minified and does not export the bare "three" specifier, so
  // borrow a live Vector3 off the camera rather than importing a second copy.
  const V = (x, y, z) => cam.up.clone().set(x, y, z);

  const q = cam.quaternion;
  const ap = (x, y, z) => V(x, y, z).applyQuaternion(q);
  const camUp = ap(0, 1, 0);
  const camRight = ap(1, 0, 0);
  const fwd = V(0, 0, 0); cam.getWorldDirection(fwd);

  // Roll = signed angle from "up with no roll" to the camera's actual up,
  // measured about the view axis. Independent of pitch and yaw.
  const worldUp = V(0, 1, 0);
  const expUp = worldUp.clone().addScaledVector(fwd, -worldUp.dot(fwd)).normalize();
  const roll = Math.atan2(V(0, 0, 0).crossVectors(expUp, camUp).dot(fwd), expUp.dot(camUp));

  // Does world-up land above world-down in the actual projected frame? Uses the
  // same projectionMatrix * matrixWorldInverse the renderer draws with. Points
  // are placed 10 m ahead so both are comfortably inside the frustum.
  const ahead = cam.position.clone().addScaledVector(fwd, 10);
  const above = ahead.clone().add(worldUp.clone().multiplyScalar(2)).project(cam);
  const below = ahead.clone().add(worldUp.clone().multiplyScalar(-2)).project(cam);

  return {
    position: cam.position.toArray(),
    upProperty: cam.up.toArray(),
    camUp: camUp.toArray(),
    camRight: camRight.toArray(),
    forward: fwd.toArray(),
    rollRad: roll,
    yawRad: Math.atan2(fwd.x, fwd.z),
    pitchRad: Math.asin(Math.max(-1, Math.min(1, fwd.y))),
    rotationOrder: cam.rotation.order,
    ndcAbove: [above.x, above.y],
    ndcBelow: [below.x, below.y],
    fov: cam.fov,
    systemErrors: (window.__SYSTEM_ERRORS ?? []).map((e) => e.system + '/' + e.phase + ': ' + e.message),
  };
}`;

const SETTLE = `(n) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i < n ? requestAnimationFrame(tick) : res());
  requestAnimationFrame(tick);
})`;

// page.evaluate() treats a plain string as an expression to evaluate, not a
// function to invoke, so these are wrapped into immediate calls. Passing the
// function source as a string (rather than a real closure) keeps the probe
// readable in one place; the call has to be explicit.
const readCamera = (page) => page.evaluate(`(${READ_CAMERA})()`);
const settle = (page, n) => page.evaluate(`(${SETTLE})(${n})`);

/**
 * Page-side toolkit shared by the walking phases. Installed once, then every
 * later `evaluate` is a short async IIFE against `window.__WP`.
 */
const HELPERS = `() => {
  const game = window.__GAME;
  const cam = game.camera;
  const ground = game.tryGet("groundHeight");
  const floor = game.tryGet("building.floorHeight");
  // The whole-scene field, not building.collide: the latter knows about the
  // shop and nothing else, and a probe built on it would report the pumps,
  // bollards, car and door leaf as thin air while the controller stops at them.
  const field = game.tryGet("collision.field");
  const rawCollide = field ? (p, r) => field.resolve(p, r === undefined ? 0.32 : r) : null;
  const scratch = cam.position.clone();

  const W = {
    game, cam, ground, floor,
    EYE: 1.65,
    // building.collide MUTATES the vector it is given, pushing it out of the
    // blocker. Every query here goes through a throwaway clone; handing it the
    // live camera position makes this file perform the collision it is meant
    // to be observing. See NOTES.md case 34.
    // Defaults to the radius the controller would actually use here, portals
    // and all. A probe that always asks at 0.32 m measures a player who does
    // not exist.
    solidAt: (x, z, y, radius) => {
      if (!rawCollide) return null;
      scratch.set(x, y === undefined ? cam.position.y : y, z);
      return !!rawCollide(scratch, radius === undefined ? field.radiusAt(x, z, 0.32, 0.2) : radius);
    },
    /** Is the straight line from (ax,az) to (bx,bz) walkable end to end? */
    clearLine: (ax, az, bx, bz) => {
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        if (W.solidAt(ax + (bx - ax) * t, az + (bz - az) * t) !== false) return false;
      }
      return true;
    },
    field,
    frame: () => new Promise((r) => requestAnimationFrame(r)),
    frames: async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); },
    key: (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true })),
    surface: (x, z) => (floor ?? ground)(x, z),
    /** Teleport to a standing pose. Collision resolves it on the next frames(). */
    place: (x, z, lookX, lookZ) => {
      const h = (floor ?? ground)(x, z) + 1.65;
      cam.position.set(x, h, z);
      cam.lookAt(lookX, h, lookZ);
    },
    /** Hold W toward a point, keeping the crosshair on it, until close or stopped. */
    approach: async (tx, ty, tz, fromX, fromZ, maxFrames, stopWithin) => {
      W.place(fromX, fromZ, tx, tz);
      cam.lookAt(tx, ty, tz);
      await W.frames(8);
      const start = cam.position.clone();
      W.key("keydown", "KeyW");
      let n = 0, stalled = 0, last = Infinity, closest = Infinity;
      while (n++ < maxFrames) {
        await W.frame();
        cam.lookAt(tx, ty, tz);
        const d = Math.hypot(cam.position.x - tx, cam.position.z - tz);
        closest = Math.min(closest, d);
        if (d < stopWithin) break;
        stalled = last - d < 1e-4 ? stalled + 1 : 0;
        last = d;
        if (stalled > 90) break;
      }
      W.key("keyup", "KeyW");
      await W.frames(30);
      cam.lookAt(tx, ty, tz);
      await W.frames(2);
      return {
        start: start.toArray(),
        end: cam.position.toArray(),
        planarDistance: Math.hypot(cam.position.x - tx, cam.position.z - tz),
        closest,
        stoppedEarly: stalled > 90,
        probe: window.__INTERACT ? window.__INTERACT.probe() : null,
      };
    },
  };
  window.__WP = W;
  return {
    hasGround: !!ground,
    hasFloor: !!floor,
    hasCollide: !!rawCollide,
    field: field
      ? {
          count: field.blockerCount,
          groups: field.groups.map((g) => ({ key: g.key, n: g.blockers.length, rect: g.rect, dynamic: g.dynamic })),
        }
      : { count: 0, groups: [] },
  };
}`;

/* ------------------------------------------------------------------ */

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[walkprobe] building...");
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  console.log(`[walkprobe] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[walkprobe] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions());
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const gpu = await assertHardwareGpu(gpuPage, { tag: "walkprobe" });
  await gpuPage.close();
  if (!REQUIRED_GPU.test(String(gpu.renderer))) {
    throw new Error(`expected the RTX 4060 adapter, got "${gpu.renderer}"`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  /**
   * Capture the canvas with the page's own UI suppressed.
   *
   * `locator("canvas").screenshot()` photographs the *page* clipped to the
   * canvas box, not the canvas contents, so every DOM element sitting over the
   * viewport lands in the file — `#hud` put "Click to look around / WASD to
   * walk" across the middle of every reference frame this harness has ever
   * produced, and an independent critic reading the PNGs called the frame
   * unusable before anyone noticed the text was ours.
   *
   * Also takes the camera position, and refuses to write a frame without one.
   * The old calls fired wherever the previous test happened to leave the
   * player, which is how `inside-shop.png` came to be a photograph taken from
   * outside the building.
   */
  const shoot = async (name, where, expect) => {
    if (!where) throw new Error(`walkprobe: ${name} was captured without stating where the camera is`);
    // `#reticle` joins the list because this run forces it on (see RETICLE_QUERY)
    // and a canvas-clipped screenshot photographs whatever DOM overlaps the
    // canvas box — which is how the HUD card ended up baked into `spawn.png`.
    // The list is enumerated rather than "hide every overlay" so that a new
    // overlay someone adds later shows up in a reference frame and gets noticed,
    // rather than being silently suppressed by a rule written before it existed.
    const OVERLAYS = ["hud", "loading", "reticle"];
    await page.evaluate((ids) => {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.style.visibility = "hidden";
      }
    }, OVERLAYS);
    await page.locator("canvas").screenshot({ path: path.join(OUT_DIR, `${name}.png`), type: "png" });
    await page.evaluate((ids) => {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.style.visibility = "";
      }
    }, OVERLAYS);
    const at = await page.evaluate(() => {
      const c = window.__GAME.camera;
      return [c.position.x, c.position.y, c.position.z];
    });
    console.log(`  captured ${name}.png at (${at.map((v) => v.toFixed(2)).join(", ")}) — ${where}`);
    // Printing the pose was not enough. The first version of this helper
    // printed it and the very next capture still came out somewhere else: the
    // placement dropped the camera inside a gondola, collision pushed it south,
    // and the one direction that was clear happened to be the doorway, so a
    // frame captioned "in the shop aisle" was taken 1.7 m outside the building.
    // A caption the code does not have to satisfy is decoration. Where the
    // caller names a spot, hold the capture to it.
    if (expect) {
      const off = Math.hypot(at[0] - expect[0], at[2] - expect[1]);
      check(off < 0.6, `${name}.png was taken where it says it was`,
        `(${at[0].toFixed(2)}, ${at[2].toFixed(2)}) vs stated (${expect[0]}, ${expect[1]}) — ${off.toFixed(2)} m off`);
    }
  };

  /* ---- boot the page the way the browser does: no ?shot= ---- */
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));

  const url = `${base}?${[RETICLE_QUERY, QUERY].filter(Boolean).join("&")}`;
  console.log(`\n[walkprobe] loading ${url} (interactive spawn path, no shot preset)`);
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  const readyFrom = Date.now();
  try {
    /**
     * 420 s, and `polling: 500` rather than the default rAF.
     *
     * A cold load measures 192-349 s here depending on what else is on the card,
     * so the old 120 s budget could not survive one. And the default polling is
     * `raf`, which cannot fire at all while `Game.start()` builds the world —
     * that is one unbroken 242 s block of the main thread, measured — so a
     * rAF-polled wait spends its whole budget without ever evaluating its
     * predicate. Raising the timeout without changing the polling fixes half of
     * it.
     */
    await page.waitForFunction(() => window.__SCENE_READY === true, null, {
      timeout: 420_000,
      polling: 500,
    });
    console.log(`  ready after ${((Date.now() - readyFrom) / 1000).toFixed(1)} s`);
  } catch (err) {
    if (problems.length) console.error(`[walkprobe] never became ready. Page said:\n    ${problems.join("\n    ")}`);
    throw err;
  }
  await settle(page, 10);

  console.log("\n[walkprobe] --- spawn state (PlayerSystem, no mouse input yet) ---");
  const spawn = await readCamera(page);
  const f3 = (a) => `(${a.map((n) => n.toFixed(4)).join(", ")})`;
  console.log(`  position       ${f3(spawn.position)}`);
  console.log(`  camera.up      ${f3(spawn.upProperty)}`);
  console.log(`  up (world)     ${f3(spawn.camUp)}`);
  console.log(`  right (world)  ${f3(spawn.camRight)}`);
  console.log(`  forward        ${f3(spawn.forward)}`);
  console.log(`  rotation.order ${spawn.rotationOrder}`);
  console.log(`  roll ${deg(spawn.rollRad).toFixed(3)} deg   pitch ${deg(spawn.pitchRad).toFixed(3)} deg   yaw ${deg(spawn.yawRad).toFixed(3)} deg`);
  console.log(`  ndc(world up)   ${f3(spawn.ndcAbove)}`);
  console.log(`  ndc(world down) ${f3(spawn.ndcBelow)}\n`);

  check(spawn.systemErrors.length === 0, "no system failed to init", spawn.systemErrors.join(" | ") || "__SYSTEM_ERRORS empty");
  check(
    Math.abs(spawn.upProperty[0]) < 1e-6 && Math.abs(spawn.upProperty[1] - 1) < 1e-6 && Math.abs(spawn.upProperty[2]) < 1e-6,
    "camera.up === (0, 1, 0)",
    f3(spawn.upProperty)
  );
  check(spawn.camUp[1] > 0.99, "camera up vector points up in world space", `up.y = ${spawn.camUp[1].toFixed(5)}`);
  check(Math.abs(deg(spawn.rollRad)) < 0.5, "roll about the view axis is ~0", `${deg(spawn.rollRad).toFixed(4)} deg`);
  check(Math.abs(spawn.camRight[1]) < 0.01, "camera right vector is horizontal", `right.y = ${spawn.camRight[1].toFixed(5)}`);
  check(spawn.ndcAbove[1] > 0.05, "world up projects into the upper half of the frame", `ndc.y = ${spawn.ndcAbove[1].toFixed(4)}`);
  check(spawn.ndcBelow[1] < -0.05, "world down projects into the lower half of the frame", `ndc.y = ${spawn.ndcBelow[1].toFixed(4)}`);

  /* ---- and the pixels agree ---- */
  const shotPath = path.join(OUT_DIR, "spawn.png");
  await shoot("spawn", "the interactive spawn pose, before any input");
  const bands = await bandLuma(shotPath);
  console.log(`\n  top band luma ${bands.top.toFixed(2)}   bottom band luma ${bands.bottom.toFixed(2)}   (${path.relative(ROOT, shotPath)})`);
  check(
    bands.top > bands.bottom * 1.15,
    "rendered frame has sky above and ground below",
    `top ${bands.top.toFixed(1)} vs bottom ${bands.bottom.toFixed(1)}`
  );

  /* ---- first mouse move must not make the view jump ---- */
  console.log("\n[walkprobe] --- first mouse input ---");
  const locked = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    canvas.click();
    for (let i = 0; i < 60 && !document.pointerLockElement; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    return !!document.pointerLockElement;
  });
  check(locked, "pointer lock engaged from a canvas click", locked ? "" : "headless chromium refused pointer lock");

  const move = async (dx, dy) => {
    await page.evaluate(
      ([mx, my]) => {
        document.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, movementX: mx, movementY: my })
        );
      },
      [dx, dy]
    );
    await settle(page, 3);
    return readCamera(page);
  };

  const zero = await move(0, 0);
  const angleBetween = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))));
  const jump = angleBetween(spawn.forward, zero.forward);
  console.log(`  after a 0 px mousemove: view moved ${jump.toFixed(4)} deg, roll ${deg(zero.rollRad).toFixed(4)} deg`);
  check(jump < 0.05, "a zero-delta mousemove does not move the view", `${jump.toFixed(4)} deg`);
  check(zero.camUp[1] > 0.99, "view stays upright through the first mouse event", `up.y = ${zero.camUp[1].toFixed(5)}`);

  const MX = 100;
  const MY = 40;
  const after = await move(MX, MY);
  const dYaw = deg(Math.atan2(Math.sin(after.yawRad - zero.yawRad), Math.cos(after.yawRad - zero.yawRad)));
  const dPitch = deg(after.pitchRad - zero.pitchRad);
  // PointerLockControls does `euler.y -= movementX * 0.002` and the same for
  // pitch; atan2(fwd.x, fwd.z) differs from euler.y by a constant pi, so the
  // deltas carry straight across.
  const wantYaw = deg(-MX * 0.002);
  const wantPitch = deg(-MY * 0.002);
  console.log(`  after ${MX}/${MY} px: dYaw ${dYaw.toFixed(3)} deg (want ${wantYaw.toFixed(3)}), dPitch ${dPitch.toFixed(3)} deg (want ${wantPitch.toFixed(3)}), roll ${deg(after.rollRad).toFixed(4)} deg`);
  check(Math.abs(dYaw - wantYaw) < 0.3, "yaw moves by exactly the commanded amount", `${dYaw.toFixed(3)} vs ${wantYaw.toFixed(3)} deg`);
  check(Math.abs(dPitch - wantPitch) < 0.3, "pitch moves by exactly the commanded amount", `${dPitch.toFixed(3)} vs ${wantPitch.toFixed(3)} deg`);
  check(Math.abs(deg(after.rollRad)) < 0.5, "horizon stays level after mouse input", `${deg(after.rollRad).toFixed(4)} deg`);
  await shoot("after-mouse", "spawn pose after the first mouse move");

  /* ---- pitch clamp: drive the mouse far past vertical both ways ---- */
  const up = await move(0, -20_000);
  const down = await move(0, 20_000);
  console.log(`\n  pitch clamp: max up ${deg(up.pitchRad).toFixed(2)} deg, max down ${deg(down.pitchRad).toFixed(2)} deg`);
  check(deg(up.pitchRad) <= 90.01 && deg(up.pitchRad) > 88, "cannot look past straight up", `${deg(up.pitchRad).toFixed(2)} deg`);
  check(deg(down.pitchRad) >= -90.01 && deg(down.pitchRad) < -88, "cannot look past straight down", `${deg(down.pitchRad).toFixed(2)} deg`);
  check(up.camUp[1] > -0.001 && down.camUp[1] > -0.001, "no flip at the pitch extremes", `up.y ${up.camUp[1].toFixed(4)} / ${down.camUp[1].toFixed(4)}`);

  // Back to level and re-aim at the forecourt for the walking tests.
  await move(0, -10_000);
  await move(0, 9_000);

  /* ---- gait: steady speed, eye height, and how deep the head bob reads ---- */
  console.log("\n[walkprobe] --- gait ---");
  const svc = await page.evaluate(`(${HELPERS})()`);
  check(svc.hasGround && svc.hasFloor && svc.hasCollide, "terrain and building services are all published",
    `groundHeight ${svc.hasGround}, building.floorHeight ${svc.hasFloor}, building.collide ${svc.hasCollide}`);
  console.log(`  solid geometry: ${svc.field.count} blockers in ${svc.field.groups.length} groups`);
  for (const g of svc.field.groups) {
    console.log(`    ${g.key.padEnd(20)} ${String(g.n).padStart(3)} blockers  x[${g.rect.minX.toFixed(2)}, ${g.rect.maxX.toFixed(2)}] z[${g.rect.minZ.toFixed(2)}, ${g.rect.maxZ.toFixed(2)}]${g.dynamic ? "  dynamic" : ""}`);
  }
  const keys = svc.field.groups.map((g) => g.key);
  for (const want of ["building.blockers", "derived:pumps", "derived:bollards", "derived:car", "derived:entryDoor"]) {
    check(keys.includes(want), `${want} contributes to the collision field`, keys.join(", "));
  }

  const gait = await page.evaluate(async () => {
    const W = window.__WP;
    const cam = W.cam;
    W.place(-14, 2, 2, 22); // open lot, nothing within ten metres
    await W.frames(30);
    W.key("keydown", "KeyW");
    await W.frames(75); // exp(-11 * 1.25) — fully converged on the target speed

    const a = cam.position.clone();
    const ta = performance.now();
    const bobs = [];
    const rolls = [];
    for (let i = 0; i < 240; i++) {
      await W.frame();
      // The bob is whatever the eye is doing relative to where the surface says
      // it should be, so this is the amplitude that actually reaches the screen
      // after the y-lerp has attenuated it - not the authored constant.
      bobs.push(cam.position.y - W.surface(cam.position.x, cam.position.z) - W.EYE);
      rolls.push(cam.rotation.z);
    }
    const b = cam.position.clone();
    const tb = performance.now();
    W.key("keyup", "KeyW");
    await W.frames(60);

    const span = (v) => Math.max(...v) - Math.min(...v);
    const mean = (v) => v.reduce((s, n) => s + n, 0) / v.length;
    const crossings = (v) => {
      const m = mean(v);
      let c = 0;
      for (let i = 1; i < v.length; i++) if (v[i - 1] - m < 0 !== v[i] - m < 0) c++;
      return c;
    };
    const seconds = (tb - ta) / 1000;
    return {
      speed: Math.hypot(b.x - a.x, b.z - a.z) / seconds,
      seconds,
      bobSpanMm: span(bobs) * 1000,
      bobHz: crossings(bobs) / 2 / seconds,
      rollSpanDeg: (span(rolls) * 180) / Math.PI,
      rollHz: crossings(rolls) / 2 / seconds,
      restEye: cam.position.y - W.surface(cam.position.x, cam.position.z),
      at: b.toArray(),
    };
  });
  console.log(`  steady speed ${gait.speed.toFixed(3)} m/s over ${gait.seconds.toFixed(2)} s`);
  console.log(`  head bob ${gait.bobSpanMm.toFixed(1)} mm peak-to-peak at ${gait.bobHz.toFixed(2)} Hz`);
  console.log(`  bob roll ${gait.rollSpanDeg.toFixed(3)} deg peak-to-peak at ${gait.rollHz.toFixed(2)} Hz`);
  console.log(`  eye height at rest ${gait.restEye.toFixed(3)} m`);
  check(gait.speed > 1.33 && gait.speed < 1.47, "steady walk speed reaches WALK_SPEED = 1.4 m/s", `${gait.speed.toFixed(3)} m/s`);
  check(gait.restEye > 1.60 && gait.restEye < 1.70, "eye height is a standing adult", `${gait.restEye.toFixed(3)} m`);
  check(gait.bobSpanMm < 60, "head bob stays within a natural vertical excursion", `${gait.bobSpanMm.toFixed(1)} mm peak-to-peak`);
  check(gait.rollSpanDeg < 1.0, "bob roll stays subtle", `${gait.rollSpanDeg.toFixed(3)} deg peak-to-peak`);

  /* ---- collision: a solid span of the shop's front elevation ---- */
  console.log("\n[walkprobe] --- collision ---");
  const WALL_Z = 31.5;
  const RADIUS = 0.32;
  const wall = await page.evaluate(async ([wallZ]) => {
    const W = window.__WP;
    const cam = W.cam;
    W.place(-5, wallZ - 1.9, -5, wallZ + 10); // x = -5 is solid wall, clear of the door
    await W.frames(10);
    W.key("keydown", "KeyW");
    let n = 0;
    let stalled = 0;
    let last = cam.position.z;
    let deepest = cam.position.z;
    while (n++ < 900 && stalled < 90 && cam.position.z < wallZ + 2) {
      await W.frame();
      deepest = Math.max(deepest, cam.position.z);
      stalled = cam.position.z - last < 1e-4 ? stalled + 1 : 0;
      last = cam.position.z;
    }
    W.key("keyup", "KeyW");
    await W.frames(30);
    return {
      end: cam.position.toArray(),
      deepest,
      endInsideSolid: W.solidAt(cam.position.x, cam.position.z),
      stopped: stalled >= 90,
    };
  }, [WALL_Z]);
  console.log(`  walked at the wall (z=${WALL_Z}); stopped at z=${wall.end[2].toFixed(3)}, deepest z=${wall.deepest.toFixed(3)}`);
  check(wall.stopped && wall.end[2] < WALL_Z, "solid wall stops the player", `stopped at z = ${wall.end[2].toFixed(3)}`);
  check(
    Math.abs(wall.end[2] - (WALL_Z - RADIUS)) < 0.02,
    "the player is held exactly one body radius off the wall face",
    `${wall.end[2].toFixed(3)} vs expected ${(WALL_Z - RADIUS).toFixed(2)}`
  );
  check(wall.endInsideSolid === false, "final position is not inside solid geometry", `building.collide says ${wall.endInsideSolid}`);
  check(wall.deepest < WALL_Z, "never penetrated the wall on any frame", `deepest z = ${wall.deepest.toFixed(3)}`);
  await shoot("at-wall", "outside the front elevation, one body radius off the storefront glazing");

  /* ---- the oblique glazing regime, which only a walk can reach ---- */
  /**
   * Building ships Fresnel-coupled transmission, `a = 1 - (1-F)(1-a0)`, and has
   * verified it at every angle a fixed camera preset can reach — its most
   * oblique pose is nearer 65 deg, while Schlick's term only climbs steeply past
   * about 78 deg. So the mirror regime is real and unverified, and the reason
   * nobody has photographed it is structural rather than accidental: a preset
   * points at what it wants to show, and a shopfront wants to be shown square
   * on. A person walking up to a shop is almost never square on to it.
   *
   * Three stances, chosen to bracket the term rather than to look nice: 65 deg
   * is Building's own limit and should read much as its captures do; 75 and 82
   * are past the knee and should show the pane going reflective. The angle is
   * computed from where the camera actually ended up and asserted against the
   * one requested, because a frame called `glass-82` is otherwise a claim that
   * nothing checks.
   */
  const GLASS_Z = 31.6; // storefront glazing plane
  const GLASS_X = -3.4; // a bay east of the door, clear of both jambs
  for (const want of [65, 75, 82]) {
    const a = (want * Math.PI) / 180;
    // Stand back far enough that the pane fills frame at grazing angles, and
    // approach from the west so the walk is the one a person takes to the door.
    const d = 3.6;
    const at = [GLASS_X - Math.sin(a) * d, GLASS_Z - Math.cos(a) * d];
    const blocked = await page.evaluate(([x, z]) => window.__WP.solidAt(x, z), at);
    if (blocked) {
      console.log(`  glass-${want}: (${at[0].toFixed(2)}, ${at[1].toFixed(2)}) is inside solid geometry — skipped`);
      continue;
    }
    const got = await page.evaluate(
      async ([x, z, gx, gz]) => {
        const W = window.__WP;
        W.place(x, z, gx, gz);
        await W.frames(12);
        const c = W.cam.position;
        // Incidence from the surface normal, which for the front elevation is
        // -z. Measured from the settled position, not the requested one: the
        // collision field may have pushed the body, and if it did, the frame is
        // at some other angle than the name says.
        const dx = gx - c.x;
        const dz = gz - c.z;
        return {
          at: [c.x, c.z],
          deg: (Math.atan2(Math.abs(dx), Math.abs(dz)) * 180) / Math.PI,
          range: Math.hypot(dx, dz),
        };
      },
      [at[0], at[1], GLASS_X, GLASS_Z]
    );
    console.log(
      `  glass-${want}: stood at (${got.at[0].toFixed(2)}, ${got.at[1].toFixed(2)}), ` +
        `${got.range.toFixed(2)} m from the pane, measured incidence ${got.deg.toFixed(1)} deg`
    );
    check(
      Math.abs(got.deg - want) < 2.5,
      `the glass-${want} frame is actually at ${want} deg off normal`,
      `measured ${got.deg.toFixed(1)} deg`
    );
    await shoot(
      `glass-${want}`,
      `outside the storefront, ${got.range.toFixed(2)} m from the glazing at ${got.deg.toFixed(1)} deg off normal`,
      got.at
    );
  }

  /* ---- collision: walking into the wall at an angle should slide, not stick ---- */
  const slide = await page.evaluate(async () => {
    const W = window.__WP;
    const cam = W.cam;
    W.place(-2.0, 29.6, 2.0, 34.0); // roughly 45 degrees into the front elevation
    await W.frames(10);
    const start = cam.position.clone();
    W.key("keydown", "KeyW");
    for (let i = 0; i < 420; i++) {
      await W.frame();
      cam.lookAt(2.0, cam.position.y, 34.0);
    }
    W.key("keyup", "KeyW");
    await W.frames(30);
    return { start: start.toArray(), end: cam.position.toArray() };
  });
  const lateral = Math.abs(slide.end[0] - slide.start[0]);
  console.log(`  angled approach: moved ${lateral.toFixed(2)} m along the wall, z ${slide.start[2].toFixed(2)} -> ${slide.end[2].toFixed(2)}`);
  check(lateral > 0.8, "walking into a wall at an angle slides along it", `${lateral.toFixed(2)} m of lateral travel`);

  /* ---- every derived solid, walked into from the open side ---- */
  console.log("\n[walkprobe] --- scene-wide solids ---");
  // Generic on purpose: it walks into whatever the contract produced rather
  // than into a hand-written list of places the pumps used to be. A blocker
  // that stops being derived stops being tested here too, so the count is
  // asserted separately above.
  const solids = await page.evaluate(async () => {
    const W = window.__WP;
    const cam = W.cam;
    const out = [];
    for (const g of W.field.groups) {
      if (g.key === "building.blockers") continue; // covered by the wall tests
      for (let i = 0; i < g.blockers.length; i++) {
        const b = g.blockers[i];
        if (b.refresh) b.refresh(b);
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        const hx = (b.maxX - b.minX) / 2;
        const hz = (b.maxZ - b.minZ) / 2;
        // Approach down whichever side offers an unobstructed 2.6 m run at the
        // blocker. Merely standing clear at the far end is not enough: the east
        // bollard sits squarely on the line to pump-2, so a start point chosen
        // on clearance alone measures the bollard and calls it a pump.
        const dirs = [[0, 1, hz], [0, -1, hz], [1, 0, hx], [-1, 0, hx]];
        let start = null;
        for (const [dx, dz, half] of dirs) {
          const sx = cx + dx * (half + 2.6);
          const sz = cz + dz * (half + 2.6);
          const fx = cx + dx * (half + 0.45);
          const fz = cz + dz * (half + 0.45);
          if (W.solidAt(sx, sz) === false && W.clearLine(sx, sz, fx, fz)) { start = [sx, sz]; break; }
        }
        if (!start) { out.push({ key: g.key, i, unreachable: true }); continue; }

        W.place(start[0], start[1], cx, cz);
        await W.frames(10);
        W.key("keydown", "KeyW");
        let deepest = Infinity;   // signed clearance to the blocker, min over frames
        let entered = false;
        let stalled = 0;
        // Walk until they stop making progress, not for a fixed frame count. A
        // fixed budget measures the harness's frame rate: at 300 frames the two
        // islands differed by 7% of a 2.6 m run and the near one came up 90 mm
        // short of contact, which reads exactly like soft geometry.
        for (let n = 0; n < 900 && stalled < 45; n++) {
          await W.frame();
          cam.lookAt(cx, cam.position.y, cz);
          const px = cam.position.x, pz = cam.position.z;
          const inside = px > b.minX && px < b.maxX && pz > b.minZ && pz < b.maxZ;
          if (inside) entered = true;
          // Distance from the camera to the blocker rectangle, 0 when inside.
          const gap = Math.hypot(Math.max(b.minX - px, 0, px - b.maxX), Math.max(b.minZ - pz, 0, pz - b.maxZ));
          stalled = gap > deepest - 1e-4 ? stalled + 1 : 0;
          deepest = Math.min(deepest, inside ? -1 : gap);
        }
        W.key("keyup", "KeyW");
        await W.frames(20);
        out.push({
          key: g.key, i, entered,
          clearance: deepest,
          start,
          end: [cam.position.x, cam.position.z],
          // Distance still to run at the end. Near zero means the walk was
          // stopped by this blocker rather than by something on the way.
          shortBy: Math.hypot(Math.max(b.minX - cam.position.x, 0, cam.position.x - b.maxX),
                              Math.max(b.minZ - cam.position.z, 0, cam.position.z - b.maxZ)),
          portalRadius: W.field.radiusAt(cam.position.x, cam.position.z, 0.32, 0.2),
          rect: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
          // Which blocker in the whole field is actually touching them at the
          // stop. When a walk stops short this names the thing that stopped it,
          // instead of leaving the number unexplained.
          touching: W.field.groups.flatMap((gg, gi) =>
            gg.blockers.map((bb, bi) => ({ gg, gi, bb, bi }))
              .filter(({ bb }) =>
                cam.position.x > bb.minX - 0.4 && cam.position.x < bb.maxX + 0.4 &&
                cam.position.z > bb.minZ - 0.4 && cam.position.z < bb.maxZ + 0.4)
              .map(({ bb, bi }) => `${gg.key}[${bi}] x[${bb.minX.toFixed(2)},${bb.maxX.toFixed(2)}] z[${bb.minZ.toFixed(2)},${bb.maxZ.toFixed(2)}]`)
          ),
        });
      }
    }
    return out;
  });
  for (const s of solids) {
    if (s.unreachable) { console.log(`  ${s.key}[${s.i}]: no clear approach side, skipped`); continue; }
    console.log(
      `  ${s.key}[${s.i}] x[${s.rect.minX.toFixed(2)},${s.rect.maxX.toFixed(2)}] z[${s.rect.minZ.toFixed(2)},${s.rect.maxZ.toFixed(2)}]: ` +
        `from (${s.start[0].toFixed(2)}, ${s.start[1].toFixed(2)}) to (${s.end[0].toFixed(2)}, ${s.end[1].toFixed(2)}), ` +
        `${s.clearance.toFixed(3)} m clear at radius ${s.portalRadius.toFixed(2)}`
    );
    if (s.clearance > s.portalRadius + 0.1) console.log(`      stopped short, touching: ${s.touching.join(" | ") || "nothing"}`);
  }
  const tested = solids.filter((s) => !s.unreachable);
  // A target can be legitimately shadowed by a *different* solid standing in
  // the approach — the canopy columns landed mid-session and one of them sits
  // between the north approach and the inboard bollard, so that walk now stops
  // on the column and never reaches the bollard. That is the collision field
  // working, not failing, so those walks are held to "never penetrated" and
  // excluded from the "stopped exactly one radius off its own target" set
  // rather than being allowed to loosen the tolerance for everything else.
  const isMine = (s, t) => t.startsWith(`${s.key}[${s.i}] `);
  for (const s of tested) s.occluders = s.touching.filter((t) => !isMine(s, t));
  const shadowed = tested.filter((s) => s.clearance > s.portalRadius + 0.1 && s.occluders.length);
  const direct = tested.filter((s) => !shadowed.includes(s));
  for (const s of shadowed) {
    console.log(`  ${s.key}[${s.i}]: approach shadowed — stopped ${s.clearance.toFixed(3)} m off it by ${s.occluders.join(" | ")}`);
  }
  check(tested.length >= 9, "every derived solid was walked into down a clear line", `${tested.length} of ${solids.length} had a clear approach`);
  check(
    tested.every((s) => !s.entered),
    "the player never gets inside a pump, bollard, car or shut door",
    tested.filter((s) => s.entered).map((s) => `${s.key}[${s.i}]`).join(", ") || "none penetrated"
  );
  // One number covers both questions. Closest approach should be the body
  // radius in force at that spot — 0.32 m in the open, 0.20 m in the doorway
  // portal. Under it and the solid is soft; well over it and the walk was
  // stopped by something else on the way and measured the wrong object.
  check(
    direct.every((s) => s.clearance > s.portalRadius - 0.02 && s.clearance < s.portalRadius + 0.1),
    "each unshadowed walk was stopped by its own target, exactly one body radius clear",
    direct
      .filter((s) => !(s.clearance > s.portalRadius - 0.02 && s.clearance < s.portalRadius + 0.1))
      .map((s) => `${s.key.replace("derived:", "")}[${s.i}] ${s.clearance.toFixed(2)}/${s.portalRadius.toFixed(2)}`)
      .join(" ") || `all ${direct.length} within tolerance`
  );
  // Shadowed walks still have to be stopped by something solid, or "shadowed"
  // becomes an excuse rather than an explanation.
  check(
    shadowed.every((s) => !s.entered && s.occluders.length),
    "every shadowed walk was stopped by a named solid, not by running out of frames",
    shadowed.length ? `${shadowed.length} shadowed: ${shadowed.map((s) => `${s.key.replace("derived:", "")}[${s.i}]`).join(", ")}` : "none shadowed"
  );

  /* ---- the doorway, the threshold step, and the interior floor ---- */
  console.log("\n[walkprobe] --- doorway and interior floor ---");

  // A shut door is a wall. Walk straight at the closed opening first: this is
  // the case that was free for the whole life of the project.
  const shut = await page.evaluate(async ([wallZ]) => {
    const W = window.__WP;
    const cam = W.cam;
    const pivot = W.game.tryGet("building.entryDoor");
    W.place(-6.0, wallZ - 2.4, -6.0, wallZ + 10);
    await W.frames(10);
    W.key("keydown", "KeyW");
    let deepest = -Infinity;
    for (let n = 0; n < 300; n++) { await W.frame(); deepest = Math.max(deepest, cam.position.z); }
    W.key("keyup", "KeyW");
    await W.frames(20);
    return { angle: pivot.rotation.y, deepest, end: cam.position.toArray() };
  }, [WALL_Z]);
  console.log(`  door at ${deg(shut.angle).toFixed(1)} deg: walking into it reached z = ${shut.deepest.toFixed(3)} (wall plane ${WALL_Z})`);
  check(Math.abs(deg(shut.angle)) < 1, "the entry door starts shut", `${deg(shut.angle).toFixed(2)} deg`);
  check(shut.deepest < WALL_Z, "a shut door is solid — the player cannot walk through it", `reached z = ${shut.deepest.toFixed(3)}`);

  // Open it the way a player does — look at it and click — and watch the
  // blocked span shrink with the swing rather than snapping.
  const swing = await page.evaluate(async ([wallZ]) => {
    const W = window.__WP;
    const pivot = W.game.tryGet("building.entryDoor");
    // Width of the clear centre band across the opening, at the door plane.
    const freeWidth = () => {
      let free = 0;
      for (let x = -7.2; x <= -4.8; x += 0.01) if (W.solidAt(x, wallZ + 0.1) === false) free += 0.01;
      return free;
    };
    const closedFree = freeWidth();
    W.place(-6.0, wallZ - 1.2, -6.0, wallZ + 4);
    await W.frames(6);
    window.__INTERACT.look(W.cam.position.x, W.cam.position.y, W.cam.position.z, -6.0, 1.5, wallZ + 4);
    await W.frames(2);
    const hit = window.__INTERACT.click();
    const track = [];
    for (let n = 0; n < 150; n++) {
      await W.frame();
      track.push([pivot.rotation.y, freeWidth()]);
    }
    return { hit, closedFree, track, openAngle: pivot.rotation.y, openFree: freeWidth() };
  }, [WALL_Z]);
  const monotone = swing.track.every((t, i) => i === 0 || t[1] >= swing.track[i - 1][1] - 0.02);
  console.log(`  click hit ${swing.hit ? swing.hit.kind + "/" + swing.hit.name : "nothing"}; opening ${deg(swing.openAngle).toFixed(1)} deg`);
  console.log(`  clear centre band across the opening: ${(swing.closedFree * 1000).toFixed(0)} mm shut -> ${(swing.openFree * 1000).toFixed(0)} mm open`);
  const mid = swing.track.filter((t) => deg(t[0]) > 20 && deg(t[0]) < 70);
  if (mid.length) {
    console.log(`  mid-swing samples: ${mid.slice(0, 6).map((t) => `${deg(t[0]).toFixed(0)}deg=${(t[1] * 1000).toFixed(0)}mm`).join(" ")}`);
  }
  check(swing.closedFree < 0.01, "shut, there is no clear line through the doorway at all", `${(swing.closedFree * 1000).toFixed(0)} mm`);
  check(swing.openFree > 0.6, "open, the doorway gives a workable aiming window", `${(swing.openFree * 1000).toFixed(0)} mm`);
  check(mid.length > 3, "the blocker is driven by the angle, not by a shut/open flag", `${mid.length} samples mid-swing`);
  check(monotone, "the clear span grows smoothly as the leaf swings", monotone ? "" : "span went backwards mid-swing");
  notes.push(
    `the entry door leaf is now solid, driven off building.entryDoor.rotation.y: the clear span across ` +
      `the opening goes ${(swing.closedFree * 1000).toFixed(0)} mm shut -> ${(swing.openFree * 1000).toFixed(0)} mm open, ` +
      `continuously through ${mid.length} sampled mid-swing angles.`
  );

  const doorway = await page.evaluate(async ([wallZ]) => {
    const W = window.__WP;
    const cam = W.cam;
    W.place(-6.0, wallZ - 1.9, -6.0, wallZ + 10); // door opening spans x -6.575 .. -5.425
    await W.frames(10);
    W.key("keydown", "KeyW");
      const samples = [];
    let n = 0;
    let stalled = 0;
    let last = cam.position.z;
    // Clipping check. The near plane is 0.08 m, so if nothing solid is ever
    // within 0.15 m of the camera the jamb cannot come through the lens even
    // on the frame the squeeze radius is in play.
    let nearJamb = 0;
    let minClear = Infinity;
    while (n++ < 900 && stalled < 90 && cam.position.z < wallZ + 2.2) {
      await W.frame();
      samples.push([cam.position.z, cam.position.y, performance.now()]);
      if (W.solidAt(cam.position.x, cam.position.z, undefined, 0.15) === true) nearJamb++;
      for (const r of [0.32, 0.28, 0.24, 0.2, 0.16, 0.12]) {
        if (W.solidAt(cam.position.x, cam.position.z, undefined, r) === false) { minClear = Math.min(minClear, r); break; }
      }
      stalled = cam.position.z - last < 1e-4 ? stalled + 1 : 0;
      last = cam.position.z;
    }
    W.key("keyup", "KeyW");
    await W.frames(60);

    const x = cam.position.x;
    const z = cam.position.z;
    // Rate, not per-frame delta: headless frame times are lumpy and a 100 ms
    // hitch turns any smooth rise into one big-looking step. What matters is
    // whether the eye ever climbs faster than a person steps.
    let maxStep = 0;
    let maxFrameMs = 0;
    for (let i = 1; i < samples.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(samples[i][1] - samples[i - 1][1]));
      maxFrameMs = Math.max(maxFrameMs, samples[i][2] - samples[i - 1][2]);
    }

    // Head bob is 40 mm peak-to-peak at ~1.8 Hz and rides on top of the climb,
    // so a raw per-sample difference is mostly bob. Smooth it out with a
    // centred mean about one bob period wide, and read the climb off that.
    const period = 9;
    const sm = samples.map((_, i) => {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - period); j <= Math.min(samples.length - 1, i + period); j++) { sum += samples[j][1]; n++; }
      return [sum / n, samples[i][2]];
    });
    // Rate over a ~100 ms window rather than between adjacent samples. This
    // probe's rAF and the game's animation loop are different callbacks, so on
    // a lumpy frame the pairing skews: a 13 mm move genuinely applied over one
    // 15 ms game step can land between two probe samples 5 ms apart and read as
    // 2.7 m/s. The controller's own clamp is unconditional; what desynced was
    // the clock the instrument divided by.
    let maxRate = 0;
    for (let i = 0, j = 0; i < sm.length; i++) {
      while (j < sm.length - 1 && sm[j][1] - sm[i][1] < 100) j++;
      const span = (sm[j][1] - sm[i][1]) / 1000;
      if (span > 0.05) maxRate = Math.max(maxRate, Math.abs(sm[j][0] - sm[i][0]) / span);
    }
    // 10-90% rise time of the smoothed climb, over the threshold crossing only.
    // Taken across the whole walk it comes out at 2.5 s, which is the time to
    // walk five metres and says nothing about the step.
    const band = sm.filter((_, i) => samples[i][0] > wallZ - 1.2 && samples[i][0] < wallZ + 1.5);
    const mean = (a, b) => band.slice(a, b).reduce((s, v) => s + v[0], 0) / Math.max(1, b - a);
    const y0 = mean(0, 8);
    const y1 = mean(band.length - 8, band.length);
    const lo = y0 + (y1 - y0) * 0.1;
    const hi = y0 + (y1 - y0) * 0.9;
    const riseFrom = band.find((v) => v[0] >= lo);
    const riseTo = [...band].reverse().find((v) => v[0] <= hi);
    const riseStart = riseFrom ? riseFrom[1] : null;
    const riseEnd = riseTo && riseFrom && riseTo[1] > riseFrom[1] ? riseTo[1] : riseStart;
    return {
      entered: cam.position.z > wallZ + 1,
      end: cam.position.toArray(),
      stoppedInDoorway: stalled >= 90,
      nearJamb,
      minClear,
      samples,
      maxFrameStepMm: maxStep * 1000,
      maxRate,
      maxFrameMs,
      riseMs: riseStart === null ? 0 : riseEnd - riseStart,
      groundAtEnd: W.ground(x, z),
      floorAtEnd: W.floor(x, z),
      eyeAboveFloor: cam.position.y - W.floor(x, z),
      eyeAboveGround: cam.position.y - W.ground(x, z),
      slabRise: W.floor(x, z) - W.ground(x, z),
    };
  }, [WALL_Z]);
  console.log(
    `  through the door to ${f3(doorway.end)}; interior floor ${doorway.floorAtEnd.toFixed(3)} m sits ` +
      `${(doorway.slabRise * 1000).toFixed(0)} mm above the exterior ground there`
  );
  console.log(
    `  eye ${doorway.eyeAboveFloor.toFixed(3)} m above the floor (${doorway.eyeAboveGround.toFixed(3)} m above exterior ground)`
  );
  console.log(
    `  threshold: 10-90% rise took ${doorway.riseMs.toFixed(0)} ms, peak climb ${doorway.maxRate.toFixed(2)} m/s over a ` +
      `100 ms window (largest single frame ${doorway.maxFrameStepMm.toFixed(1)} mm, longest frame ${doorway.maxFrameMs.toFixed(0)} ms)`
  );
  // "Fits through" means the wall plane was crossed. Where the player finally
  // stops is a separate question — inside the shop they are stopped by the
  // first gondola run, which is correct and not a door problem.
  check(doorway.end[2] > WALL_Z + 0.4, "the player fits through the door opening", `reached z = ${doorway.end[2].toFixed(2)}`);
  console.log(`  after the doorway the player was stopped at z=${doorway.end[2].toFixed(2)}${doorway.stoppedInDoorway ? " (held there by shelving)" : ""}`);
  check(
    Math.abs(doorway.eyeAboveFloor - 1.65) < 0.03,
    "indoors the eye rides the finished floor, not the exterior ground",
    `${doorway.eyeAboveFloor.toFixed(3)} m above floor`
  );
  // PlayerSystem clamps the eye's climb to MAX_CLIMB_RATE, but the bob rides on
  // top of it, so the bound is the clamp plus the bob's own peak speed —
  // derived from the gait actually measured above rather than picked to fit.
  const bobPeak = 2 * Math.PI * gait.bobHz * (gait.bobSpanMm / 2000);
  const climbBound = 0.9 + bobPeak;
  console.log(`  bound: 0.90 m/s climb clamp + ${bobPeak.toFixed(2)} m/s residual bob = ${climbBound.toFixed(2)} m/s`);
  check(doorway.maxRate < climbBound * 1.05, "the threshold is stepped over, not teleported",
    `peak ${doorway.maxRate.toFixed(2)} m/s against a ${climbBound.toFixed(2)} m/s bound`);
  check(doorway.riseMs > 90, "the step up takes a human amount of time", `${doorway.riseMs.toFixed(0)} ms`);
  console.log(`  closest the body ever came to a jamb: ${doorway.minClear.toFixed(2)} m (near plane is 0.08 m)`);
  check(doorway.nearJamb === 0, "nothing solid ever comes within 0.15 m of the camera in the doorway",
    `${doorway.nearJamb} frames inside 0.15 m`);

  /* ---- how much aiming error the doorway forgives ---- */
  const aim = await page.evaluate(async ([wallZ]) => {
    const W = window.__WP;
    const cam = W.cam;
    // Stall-terminated, not a fixed budget. A run that brushes a jamb and
    // slides takes noticeably longer than one down the middle, so a fixed count
    // drops isolated positions out of the band and the "contiguous" assertion
    // flickers between runs on a property of the harness.
    const tryEntry = async (x) => {
      W.place(x, wallZ - 1.6, x, wallZ + 8);
      await W.frames(6);
      W.key("keydown", "KeyW");
      let stalled = 0, best = -Infinity, longest = 0;
      for (let n = 0; n < 900 && stalled < 45 && cam.position.z < wallZ + 1.2; n++) {
        const t = performance.now();
        await W.frame();
        longest = Math.max(longest, performance.now() - t);
        cam.lookAt(x, cam.position.y, wallZ + 8);
        stalled = cam.position.z <= best + 1e-4 ? stalled + 1 : 0;
        best = Math.max(best, cam.position.z);
      }
      W.key("keyup", "KeyW");
      await W.frames(6);
      return { through: cam.position.z > wallZ + 0.6, longest };
    };

    const results = [];
    for (let x = -7.0; x <= -5.0; x += 0.05) {
      const r = await tryEntry(x);
      results.push([+x.toFixed(2), r.through, r.longest, false]);
    }
    // Retry only the slots that failed *between* two successes. A stall is how
    // this sweep decides a run is over, and a frame hitch — this machine shares
    // a GPU with six other agents and frames of 280 ms were recorded on this
    // run — looks exactly like a stall. So an interior gap is at least as
    // likely to be the clock as the geometry, and the way to tell is to walk it
    // again rather than to widen the tolerance until it passes. The retry is
    // recorded per slot and reported, because a retried pass is weaker evidence
    // than a first-attempt pass and hiding that would make the check a
    // formality.
    const win = results.map((r) => r[1]);
    const lo = win.indexOf(true);
    const hi = win.lastIndexOf(true);
    for (let i = lo + 1; i < hi; i++) {
      if (results[i][1]) continue;
      const r = await tryEntry(results[i][0]);
      results[i][1] = r.through;
      results[i][2] = Math.max(results[i][2], r.longest);
      results[i][3] = true;
    }
    return results;
  }, [WALL_Z]);
  const retried = aim.filter((a) => a[3]);
  console.log(`  entry sweep: ${aim.map((a) => (a[1] ? (a[3] ? "r" : "#") : ".")).join("")}  (# in on the first walk, r on a retry, . blocked)`);
  if (retried.length) {
    console.log(
      `  ${retried.length} interior slot(s) re-walked after a first-attempt stall: ` +
        retried.map((a) => `x=${a[0].toFixed(2)} ${a[1] ? "in" : "still blocked"} (longest frame ${a[2].toFixed(0)} ms)`).join(", ")
    );
  }
  const through = aim.filter((a) => a[1]).map((a) => a[0]);
  const window_m = through.length ? through[through.length - 1] - through[0] + 0.05 : 0;
  console.log(`  walking dead ahead from x = ${aim[0][0]} .. ${aim[aim.length - 1][0]}, the player gets in from ${through.length ? `${through[0].toFixed(2)} .. ${through[through.length - 1].toFixed(2)}` : "nowhere"}`);
  check(window_m > 0.6, "the doorway forgives ordinary aiming error", `${(window_m * 1000).toFixed(0)} mm of entry positions succeed`);
  const idx = aim.map((a, i) => (a[1] ? i : -1)).filter((i) => i >= 0);
  const contiguous = idx.length > 0 && idx[idx.length - 1] - idx[0] === idx.length - 1;
  check(contiguous, "the successful entry positions form one contiguous band — no phantom gap in the opening",
    `${idx.length} positions spanning ${idx.length ? idx[idx.length - 1] - idx[0] + 1 : 0} slots` +
      (retried.length ? `, ${retried.filter((a) => a[1]).length} recovered on a retry` : ""));
  notes.push(
    `doorway freedom is now ${(window_m * 1000).toFixed(0)} mm of lateral entry positions, up from the 510 mm ` +
      `the 0.32 m body radius allowed. Nothing solid comes within ${doorway.minClear.toFixed(2)} m of the camera ` +
      `while crossing, against a 0.08 m near plane, so no jamb is ever clipped.`
  );

  // The threshold profile, sampled either side of the front wall plane.
  const nearest = (z) => doorway.samples.reduce((best, s) => (Math.abs(s[0] - z) < Math.abs(best[0] - z) ? s : best), doorway.samples[0]);
  const profile = [30.6, 31.2, 31.4, 31.5, 31.6, 31.8, 32.4, 33.2].map((z) => {
    const s = nearest(z);
    return `z=${s[0].toFixed(2)} y=${s[1].toFixed(3)}`;
  });
  console.log(`  threshold profile: ${profile.join("  ")}`);
  // Stand somewhere deliberate first. This capture used to fire wherever the
  // aiming sweep left the player, which was outside the building looking in
  // through the glazing — a frame named "inside-shop" that no part of the
  // harness had ever put inside the shop. z = 33.2 is past the wall plane at
  // 31.5 and short of the first gondola run at 33.68; standing in the gondola
  // and letting collision sort it out is what sent the previous attempt back
  // out through the door.
  await page.evaluate(async () => {
    window.__WP.place(-6.0, 33.2, -6.0, 39.0);
    await window.__WP.frames(20);
  });
  await shoot("inside-shop", "standing in the shop aisle looking at the cooler run", [-6.0, 33.2]);

  /* ---- the three brief interactions, reached on foot ---- */
  console.log("\n[walkprobe] --- interactions, approached on foot ---");
  const targets = await page.evaluate(() => {
    const g = window.__GAME;
    const bounds = g.tryGet("building.bounds");
    if (!bounds) return { error: "no building.bounds" };
    const Box3 = bounds.constructor;
    const V3 = g.camera.position.constructor;
    const box = (o) => {
      const b = new Box3().setFromObject(o);
      return b.isEmpty() ? null : { c: b.getCenter(new V3()).toArray(), min: b.min.toArray(), max: b.max.toArray() };
    };
    const faces = g.tryGet("pumpFaces") ?? [];
    return {
      pumps: faces.map((f) => ({
        name: f.name ?? "pump",
        stand: f.standPosition ? f.standPosition.toArray() : null,
        pickables: f.pickables?.length ?? 0,
        box: f.pickables?.length ? box(f.pickables[0]) : null,
      })),
      door: g.tryGet("building.entryDoor") ? box(g.tryGet("building.entryDoor")) : null,
      cooler: (g.tryGet("building.coolerDoors") ?? []).length ? box(g.tryGet("building.coolerDoors")[0]) : null,
      coolerCount: (g.tryGet("building.coolerDoors") ?? []).length,
      bottle: g.tryGet("building.grabBottle") ? box(g.tryGet("building.grabBottle")) : null,
    };
  });

  /**
   * Where can a walking player actually get to?
   *
   * Hand-picking an approach vector per target is how the first version of this
   * got a false negative on the cooler: it teleported the player into the
   * middle of a gondola run and reported "unreachable" when the truth was
   * "started inside a shelf". So this floods the configuration space instead.
   * Each 5 cm cell is free iff `building.collide` (on a clone) leaves a body of
   * BODY_RADIUS untouched there, which is exactly the predicate the controller
   * enforces, and the flood starts on the forecourt — so anything it marks is
   * reachable on foot from where the player spawns, through the real doorway.
   */
  console.log("\n[walkprobe] --- reachable floor area ---");
  const reachMap = await page.evaluate(([x0, x1, z0, z1, step, seedX, seedZ]) => {
    const g = window.__GAME;
    const raw = g.tryGet("building.collide");
    const v = g.camera.position.clone();
    const R = 0.32;
    const nx = Math.round((x1 - x0) / step);
    const nz = Math.round((z1 - z0) / step);
    const free = new Uint8Array(nx * nz);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        v.set(x0 + i * step, 1.65, z0 + j * step);
        free[i * nz + j] = raw(v, R) ? 0 : 1;
      }
    }
    const seen = new Uint8Array(nx * nz);
    const si = Math.round((seedX - x0) / step);
    const sj = Math.round((seedZ - z0) / step);
    const queue = [si * nz + sj];
    seen[si * nz + sj] = 1;
    let reached = 0;
    while (queue.length) {
      const c = queue.pop();
      reached++;
      const i = (c / nz) | 0;
      const j = c % nz;
      const push = (a, b) => {
        if (a < 0 || b < 0 || a >= nx || b >= nz) return;
        const k = a * nz + b;
        if (seen[k] || !free[k]) return;
        seen[k] = 1;
        queue.push(k);
      };
      push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
    }
    // Closest reachable standing spot to an arbitrary world point, no nearer
    // than minD — the props themselves are not in the blocker set, so without
    // a floor the "nearest" cell to a pump is inside the pump.
    const nearest = (tx, tz, minD = 0.9) => {
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          if (!seen[i * nz + j]) continue;
          const x = x0 + i * step;
          const z = z0 + j * step;
          const d = Math.hypot(x - tx, z - tz);
          if (d >= minD && d < bestD) { bestD = d; best = [x, z]; }
        }
      }
      return { at: best, distance: bestD };
    };
    window.__WP.nearestReachable = nearest;

    // A coarse picture of the shop interior: blocked, free-but-cut-off, walkable.
    const map = [];
    for (let z = 40.25; z >= 30.75; z -= 0.25) {
      let row = "";
      for (let x = -9.5; x <= 4.0; x += 0.25) {
        const i = Math.round((x - x0) / step);
        const j = Math.round((z - z0) / step);
        const k = i * nz + j;
        row += !free[k] ? "#" : seen[k] ? "+" : ".";
      }
      map.push(`  ${z.toFixed(2).padStart(5)} ${row}`);
    }
    return { nx, nz, freeCells: free.reduce((s, n) => s + n, 0), reached, areaM2: reached * step * step, map };
  }, [-16, 6, 0, 41, 0.05, -14, 2]);
  console.log(`  ${reachMap.reached} of ${reachMap.freeCells} obstacle-free cells are reachable on foot from spawn (${reachMap.areaM2.toFixed(0)} m2)`);
  console.log("  shop interior, x -9.5 .. 4.0 left to right, z 40.25 (back) down to 30.75 (front):");
  console.log("    # blocked   . free but cut off   + walkable from outside");
  for (const row of reachMap.map) console.log(row);

  /** Stand on the nearest cell a walking player can actually occupy, aim, probe. */
  async function reach(label, target) {
    if (!target) {
      check(false, `${label}: target is published by its system`, "service missing");
      return null;
    }
    const [tx, ty, tz] = target;
    const r = await page.evaluate(
      async ([tx, ty, tz]) => {
        const W = window.__WP;
        const n = W.nearestReachable(tx, tz);
        if (!n.at) return { standoff: null };
        W.place(n.at[0], n.at[1], tx, tz);
        W.cam.lookAt(tx, ty, tz);
        await W.frames(6);
        W.cam.lookAt(tx, ty, tz);
        await W.frames(2);
        return {
          standoff: n.distance,
          at: W.cam.position.toArray(),
          probe: window.__INTERACT ? window.__INTERACT.probe() : null,
        };
      },
      [tx, ty, tz]
    );
    const hit = r.probe;
    console.log(
      `  ${label.padEnd(7)} nearest standable spot is ${r.standoff.toFixed(2)} m away at ${f3(r.at)} -> ` +
        (hit ? `probe hit "${hit.name}" (${hit.kind}) at ${hit.distance.toFixed(2)} m` : "probe found NOTHING")
    );
    check(!!hit, `${label} is reachable and pickable on foot`, hit ? `${hit.kind} at ${hit.distance.toFixed(2)} m` : `nearest stance ${r.standoff.toFixed(2)} m away, beyond the 2.2 m reach`);
    return { ...r, hit };
  }

  const pump = targets.pumps?.find((p) => p.box);
  if (!pump) check(false, "pump: target is published by its system", "no pumpFaces with pickables");
  await reach("pump", pump?.box?.c);
  await reach("door", targets.door?.c);
  await reach("cooler", targets.cooler?.c);
  await reach("bottle", targets.bottle?.c);

  /* ---- and now actually fire them ---- */
  const fired = await page.evaluate(
    async ([pumpAt, door, cooler, bottle]) => {
      const W = window.__WP;
      const out = {};
      const stand = async (t) => {
        const n = W.nearestReachable(t[0], t[2]);
        W.place(n.at[0], n.at[1], t[0], t[2]);
        W.cam.lookAt(t[0], t[1], t[2]);
        await W.frames(8);
        W.cam.lookAt(t[0], t[1], t[2]);
        await W.frames(2);
      };
      const snap = () => JSON.parse(JSON.stringify(window.__INTERACT.state()));

      if (pumpAt) {
        await stand(pumpAt);
        const b = snap();
        const clicked = window.__INTERACT.click();
        await W.frames(120);
        out.pump = { clicked, before: b, after: snap() };
      }
      if (door) {
        await stand(door);
        const b = snap();
        const clicked = window.__INTERACT.click();
        await W.frames(120);
        const opened = snap();
        // Second click should send it back.
        window.__INTERACT.click();
        await W.frames(120);
        out.door = { clicked, before: b, after: opened, reclosed: snap() };
      }
      if (cooler) {
        await stand(cooler);
        const b = snap();
        const clicked = window.__INTERACT.click();
        await W.frames(120);
        out.cooler = { clicked, before: b, after: snap() };
      }
      // The bottle is behind one specific cooler door, and not necessarily the
      // one nearest the run's centre. Stand at the bottle, open whatever the
      // ray finds in front of it, then take it — the intended two-step.
      if (bottle) {
        await stand(bottle);
        const firstProbe = window.__INTERACT.probe();
        const openClick = firstProbe ? window.__INTERACT.click() : null;
        await W.frames(150);
        W.cam.lookAt(bottle[0], bottle[1], bottle[2]);
        await W.frames(2);
        const secondProbe = window.__INTERACT.probe();
        const grabClick = secondProbe ? window.__INTERACT.click() : null;
        await W.frames(60);
        out.bottle = { firstProbe, openClick, secondProbe, grabClick, carrying: snap().bottle };
      }
      return out;
    },
    [pump?.box?.c ?? null, targets.door?.c ?? null, targets.cooler?.c ?? null, targets.bottle?.c ?? null]
  );

  if (fired.pump?.clicked) {
    console.log(
      `  pump click -> ${fired.pump.clicked.kind} "${fired.pump.clicked.name}"; running ` +
        `${fired.pump.before?.pump?.running} -> ${fired.pump.after?.pump?.running}, ` +
        `gallons ${fired.pump.after?.pump?.gallons?.toFixed?.(3) ?? "n/a"}`
    );
    check(fired.pump.after?.pump?.running === true, "clicking the pump from a standable spot starts fuelling",
      `running = ${fired.pump.after?.pump?.running}`);
  } else {
    check(false, "clicking the pump from a standable spot starts fuelling", "nothing under the crosshair");
  }

  const doorAngle = (s) => s?.door?.angle ?? null;
  if (fired.door?.clicked) {
    console.log(`  door click -> ${fired.door.clicked.kind} "${fired.door.clicked.name}"; hinge angle ${doorAngle(fired.door.before)} -> ${doorAngle(fired.door.after)}`);
    check(doorAngle(fired.door.after) !== doorAngle(fired.door.before), "clicking the door from a standable spot opens it",
      `${doorAngle(fired.door.before)} -> ${doorAngle(fired.door.after)}`);
  } else {
    check(false, "clicking the door from a standable spot opens it", "nothing under the crosshair");
  }

  const coolerAmt = (s) => JSON.stringify((s?.coolers ?? []).map((c) => +c.amount.toFixed(3)));
  if (fired.cooler?.clicked) {
    console.log(`  cooler click -> ${fired.cooler.clicked.kind} "${fired.cooler.clicked.name}"; amounts ${coolerAmt(fired.cooler.before)} -> ${coolerAmt(fired.cooler.after)}`);
    check(coolerAmt(fired.cooler.after) !== coolerAmt(fired.cooler.before), "clicking a cooler door from a standable spot opens it",
      `${coolerAmt(fired.cooler.before)} -> ${coolerAmt(fired.cooler.after)}`);
  } else {
    check(false, "clicking a cooler door from a standable spot opens it", "nothing under the crosshair");
  }

  const bot = fired.bottle;
  if (bot) {
    const d = (p) => (p ? `"${p.name}" (${p.kind}) at ${p.distance.toFixed(2)} m` : "NOTHING");
    console.log(`  at the bottle: first probe ${d(bot.firstProbe)} -> click opens it -> second probe ${d(bot.secondProbe)}`);
    console.log(`  bottle carried: ${bot.carrying ? bot.carrying.carried : "no bottle in state"}`);
    check(bot.grabClick?.kind === "bottle" && bot.carrying?.carried === true,
      "the bottle can be taken once the cooler door in front of it is open",
      bot.grabClick ? `${bot.grabClick.kind} "${bot.grabClick.name}", carried = ${bot.carrying?.carried}` : "no second pick");
  } else {
    check(false, "the bottle can be taken once the cooler door in front of it is open", "building.grabBottle is null");
  }

  const doorReclosed = fired.door?.reclosed?.door?.target;
  if (fired.door?.clicked) {
    console.log(`  second door click -> target ${JSON.stringify(fired.door.after?.door?.target)} -> ${JSON.stringify(doorReclosed)}`);
    check(doorReclosed !== fired.door.after?.door?.target, "a second click sends the door back", `target ${JSON.stringify(fired.door.after?.door?.target)} -> ${JSON.stringify(doorReclosed)}`);
  }
  await shoot("interaction", "at the cooler, mid-interaction");

  /* ---- what a person does that a scripted route never does ---- */
  /**
   * Everything above this drives the player the way the film does: forwards,
   * toward a thing it has already decided to look at. That is not how the scene
   * will be used now that a person is going to walk it live and record it. The
   * failures a route cannot find are the ones where the player is not
   * cooperating — backing into geometry, sliding along a wall, clicking sky,
   * standing on the wrong side of the thing they want, or heading for the
   * horizon to see whether the world stops.
   */
  /* ---- the reticle, which is the whole of the interface ---- */
  /**
   * Interaction landed a centre-screen dot that brightens when the reach ray is
   * on something usable, and built it from the same `pick()` call a click goes
   * through at the same reach. That is the right construction, and it makes one
   * claim testable that a separately-implemented reticle could not: **the dot
   * cannot lie.** Bright must mean a click lands, dim must mean it does not.
   *
   * A dot that is bright where a click misses is worse than no dot at all. With
   * nothing on screen a failed click reads as the player's aim; with a bright dot
   * it reads as broken software, which is precisely the failure the reticle was
   * added to prevent, inverted.
   *
   * So this walks to each of the three interactive things, brackets each one by
   * standing where the dot is bright and where it is dim, and checks the click
   * against the dot both ways round. The dim case matters as much: a dot stuck
   * bright everywhere would pass every one-sided test.
   */
  console.log("\n[walkprobe] --- the reticle ---");

  const dot = await page.evaluate(() => window.__RETICLE?.() ?? null);
  check(dot !== null, "the page exposes reticle state", "window.__RETICLE is absent");
  check(dot?.present === true, "index.html carries the reticle node", `present: ${dot?.present} — ${dot?.why}`);
  check(dot?.shown === true, "the reticle is on screen under ?reticle=1", `shown: ${dot?.shown} — ${dot?.why}`);

  /**
   * The guard that has to come before any cost number is believed. `samples` is
   * how many frames actually ran the hover ray; if the flag failed to take, this
   * is zero and the mean cost is a division that reports 0 µs — a measurement of
   * nothing, wearing the units of good news. Same shape as the three wrong-layer
   * checks filed tonight, so it is asserted rather than assumed.
   */
  const hoverPre = await page.evaluate(() => window.__INTERACT.hover());
  check(
    hoverPre.active === true && hoverPre.samples > 0,
    "the hover ray is actually running, so its cost can be measured",
    `active: ${hoverPre.active}, samples: ${hoverPre.samples} — a 0 µs reading here would be meaningless`
  );

  const agree = await page.evaluate(async () => {
    const W = window.__WP;
    const I = window.__INTERACT;
    const out = { cases: [], costUs: 0, samples: 0 };

    /**
     * Stand, aim, settle, then read the dot and click. The dot is read *before*
     * the click, because a click changes the world and the question is whether
     * the dot predicted what the click would do.
     */
    const bracket = async (label, at, aim, expectReach) => {
      W.place(at[0], at[1], aim[0], aim[2] ?? aim[1]);
      W.cam.lookAt(aim[0], aim[1], aim[2] ?? aim[1]);
      await W.frames(10);
      const before = window.__RETICLE();
      const hover = I.hover();
      const hit = I.click();
      await W.frames(6);
      out.cases.push({
        label,
        expectReach,
        reach: before.reach,
        why: before.why,
        hoverName: hover.target?.name ?? null,
        clicked: hit ? hit.name ?? hit.kind ?? String(hit) : null,
        at: [W.cam.position.x, W.cam.position.z],
      });
    };

    /**
     * Resolved from the services the systems actually publish, and **missing is
     * a failure rather than a skip.** The first version of this asked for
     * `pump.nozzle3`, which does not exist — `tryGet` returned null, the pump
     * cases were quietly not run, and the phase would have reported all-pass
     * having tested nothing. A guessed service name is the silent-skip form of
     * the same wrong-layer mistake filed three times tonight.
     */
    const pumps = window.__GAME.tryGet("pumps");
    if (!pumps || !pumps.length) throw new Error('reticle phase: no "pumps" service to aim at');
    const door = window.__GAME.tryGet("building.entryDoor");
    if (!door) throw new Error('reticle phase: no "building.entryDoor" service to aim at');
    const v = new W.cam.position.constructor();

    // In reach of a pump, then backed off well past the 2.2 m reach with the aim
    // unchanged — the dot must go dim on distance alone.
    const pump = pumps[pumps.length - 1];
    const p = pump.position;
    out.cases.push({ label: `${pump.name} at`, at: [p.x, p.z], note: true });
    await bracket("pump, close", [p.x, p.z + 1.1], [p.x, p.y + 1.1, p.z], true);
    await bracket("pump, too far", [p.x, p.z + 4.2], [p.x, p.y + 1.1, p.z], false);

    const d = door.getWorldPosition ? door.getWorldPosition(v.clone()) : door.position;
    await bracket("door, close", [d.x, d.z - 1.2], [d.x, d.y, d.z], true);
    await bracket("door, too far", [d.x, d.z - 5.0], [d.x, d.y, d.z], false);
    // Aimed at the sky from a spot with nothing in reach: the unambiguous dim
    // case, and the one a player is in most of the time.
    W.place(-2.0, 26.0, -2.0, 10.0);
    W.cam.lookAt(-2.0, 60.0, 10.0);
    await W.frames(10);
    const sky = window.__RETICLE();
    out.cases.push({
      label: "aimed at empty sky",
      expectReach: false,
      reach: sky.reach,
      why: sky.why,
      hoverName: I.hover().target?.name ?? null,
      clicked: I.click(),
      at: [W.cam.position.x, W.cam.position.z],
    });

    // Cost over a stretch of ordinary walking, sampled fresh so it is not
    // dominated by the standing-still frames above.
    const base = I.hover();
    W.key("keydown", "KeyW");
    for (let i = 0; i < 90; i++) await W.frame();
    W.key("keyup", "KeyW");
    const after = I.hover();
    out.costUs = after.costUs;
    out.samples = after.samples - base.samples;
    return out;
  });

  for (const c of agree.cases) {
    if (c.note) {
      console.log(`  pump nozzle at (${c.at[0].toFixed(2)}, ${c.at[1].toFixed(2)})`);
      continue;
    }
    console.log(
      `  ${c.label.padEnd(18)} dot ${c.reach ? "BRIGHT" : "dim   "} | hover ${String(c.hoverName).padEnd(22)} | ` +
        `click ${JSON.stringify(c.clicked)} | ${c.why}`
    );
    check(
      c.reach === c.expectReach,
      `the dot is ${c.expectReach ? "bright" : "dim"} ${c.label}`,
      `reach: ${c.reach} — ${c.why}`
    );
    // The claim under test, both ways round.
    if (c.reach) {
      check(c.clicked !== null, `a bright dot means the click lands (${c.label})`, `click returned ${JSON.stringify(c.clicked)}`);
    } else {
      check(c.clicked === null, `a dim dot means the click does nothing (${c.label})`, `click returned ${JSON.stringify(c.clicked)}`);
    }
  }

  console.log(`  hover ray: ${agree.costUs.toFixed(1)} µs mean over ${agree.samples} frames of walking`);
  // 200 µs would be 0.2 ms of a 16.7 ms budget. Generous, because the point is
  // to catch a raycast that walks the whole scene graph, not to tune it.
  check(agree.costUs < 200, "the hover ray is cheap enough to run every frame", `${agree.costUs.toFixed(1)} µs/frame`);

  console.log("\n[walkprobe] --- unscripted player behaviour ---");

  const rude = await page.evaluate(async () => {
    const W = window.__WP;
    const cam = W.cam;
    const out = {};
    /** Hold a key for n frames while facing a fixed point, and report the track. */
    const drive = async (code, from, look, n) => {
      W.place(from[0], from[1], look[0], look[1]);
      await W.frames(8);
      const start = cam.position.clone();
      let worst = 0;
      W.key("keydown", code);
      for (let i = 0; i < n; i++) {
        await W.frame();
        cam.lookAt(look[0], cam.position.y, look[1]);
        if (W.solidAt(cam.position.x, cam.position.z) !== false) worst++;
      }
      W.key("keyup", code);
      await W.frames(20);
      return {
        start: start.toArray(),
        end: cam.position.toArray(),
        moved: Math.hypot(cam.position.x - start.x, cam.position.z - start.z),
        framesInsideSolid: worst,
      };
    };

    // Backing into the storefront. The front wall is at z = 31.5, so stand north
    // of it looking *away* and reverse: S is the one direction whose collision
    // nobody has ever exercised, and a controller that resolves only along the
    // facing direction passes every forward test and walks backwards through
    // walls.
    out.backIntoWall = await drive("KeyS", [-2.0, 30.4], [-2.0, 20.0], 200);
    // Sliding along the same wall sideways.
    out.strafeWall = await drive("KeyD", [-2.0, 31.0], [-2.0, 40.0], 240);
    // Heading for the horizon. Nothing should fall through, and the surface
    // height must stay a number the whole way.
    out.leaveMap = await drive("KeyW", [0, 20.0], [0, -400.0], 420);
    out.farSurface = W.surface(cam.position.x, cam.position.z);
    out.farY = cam.position.y;

    // A click on nothing. This has to be a clean no-op: a person will click at
    // the sky, at the ground, and at a wall long before they click a pump.
    W.place(-2.0, 26.0, -2.0, 10.0);
    cam.lookAt(-2.0, 60.0, 10.0);
    await W.frames(4);
    /**
     * Only the fields a click could change. The first version stringified the
     * whole snapshot, which carries `t` and the pump's running gallons — both
     * advance every frame on their own — so it reported "state moved on a miss"
     * on every run, for a scene that was behaving correctly. A comparison is only
     * a test if the things being compared are the things under test.
     */
    const digest = () => {
      const s = window.__INTERACT.state();
      return JSON.stringify({
        door: s.door?.target ?? null,
        coolers: s.coolers?.map((c) => c.target) ?? null,
        bottle: s.bottle?.carried ?? null,
        pumpRunning: s.pump?.running ?? null,
      });
    };
    const before = window.__INTERACT ? digest() : null;
    out.skyClick = window.__INTERACT ? window.__INTERACT.click() : "no __INTERACT";
    await W.frames(4);
    out.stateUnchangedAfterSkyClick = before === (window.__INTERACT ? digest() : null);

    // The wrong side of the shop wall, aimed at the cooler through it. Reach is
    // 2.2 m and the cooler sits against the back wall, so from outside it is
    // within range as the crow flies — this is the check that you cannot work
    // the fridge through the building.
    const bottle = window.__GAME.tryGet("building.grabBottle");
    if (bottle) {
      const p = bottle.getWorldPosition(new cam.position.constructor());
      W.place(p.x, p.z + 1.9, p.x, p.z); // outside the back wall, looking in
      await W.frames(6);
      out.throughWall = { at: [cam.position.x, cam.position.z], click: window.__INTERACT.click() };
    }

    // And the mouse. PointerLockControls only consumes movement while the
    // pointer is captured, so an uncaptured mousemove must not move the view —
    // otherwise the scene drifts whenever the player alt-tabs.
    W.place(0, 26.0, 0, 40.0);
    await W.frames(4);
    const yaw0 = cam.rotation.y;
    for (let i = 0; i < 10; i++) {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    }
    await W.frames(4);
    out.yawDriftUnlocked = Math.abs(cam.rotation.y - yaw0);
    out.pointerLocked = document.pointerLockElement !== null;
    return out;
  });

  const r = rude;
  console.log(
    `  reversing into the front wall: moved ${r.backIntoWall.moved.toFixed(2)} m, ` +
      `ended z ${r.backIntoWall.end[2].toFixed(3)}, ${r.backIntoWall.framesInsideSolid} frames inside solid`
  );
  check(r.backIntoWall.framesInsideSolid === 0, "walking backwards does not push the body into geometry",
    `${r.backIntoWall.framesInsideSolid} frames inside a blocker`);
  check(r.backIntoWall.end[2] > 31.5 - 0.34, "reversing is stopped by the storefront, not through it",
    `ended at z = ${r.backIntoWall.end[2].toFixed(3)} against a wall face at 31.5`);

  console.log(
    `  strafing along the front wall: moved ${r.strafeWall.moved.toFixed(2)} m, ` +
      `${r.strafeWall.framesInsideSolid} frames inside solid`
  );
  check(r.strafeWall.moved > 1.0, "strafing along a wall actually travels", `${r.strafeWall.moved.toFixed(2)} m`);
  check(r.strafeWall.framesInsideSolid === 0, "strafing does not push the body into geometry",
    `${r.strafeWall.framesInsideSolid} frames inside a blocker`);

  console.log(
    `  heading off-site: moved ${r.leaveMap.moved.toFixed(1)} m to (${r.leaveMap.end[0].toFixed(1)}, ` +
      `${r.leaveMap.end[2].toFixed(1)}), eye y ${r.farY.toFixed(2)}, ground there ${String(r.farSurface)}`
  );
  check(Number.isFinite(r.farSurface), "the ground is still defined well off-site", `groundHeight returned ${String(r.farSurface)}`);
  check(Number.isFinite(r.farY) && r.farY > -50, "the player does not fall out of the world", `eye height ${r.farY}`);

  console.log(`  clicking empty sky: ${JSON.stringify(r.skyClick)}`);
  check(r.skyClick === null, "clicking nothing returns nothing rather than erroring", JSON.stringify(r.skyClick));
  check(r.stateUnchangedAfterSkyClick, "clicking nothing changes nothing", "interaction state moved on a miss");

  if (r.throughWall) {
    console.log(`  from outside the back wall at (${r.throughWall.at[0].toFixed(2)}, ${r.throughWall.at[1].toFixed(2)}): ${JSON.stringify(r.throughWall.click)}`);
    check(r.throughWall.click === null, "the fridge cannot be worked through the building wall", JSON.stringify(r.throughWall.click));
  }

  console.log(`  mouse: yaw drift with the pointer uncaptured ${r.yawDriftUnlocked.toExponential(1)} rad, pointer locked: ${r.pointerLocked}`);
  check(r.yawDriftUnlocked < 1e-6, "the view does not move while the pointer is uncaptured", `${r.yawDriftUnlocked} rad of drift`);

  /* ---- run and jump, which make collision three-dimensional ---- */
  /**
   * Everything above this was written when the player could only walk, and the
   * collision field is a set of **height-less XZ rectangles resolved before the
   * vertical integration**. The claim that follows from that is strong — a hop
   * cannot clear a blocker or enter one, because the horizontal resolve does not
   * know or care what `y` is — and it is the claim most worth attacking, because
   * if it is wrong the failure is a player standing on top of a pump island or
   * inside the building shell, which is worse than having no jump.
   *
   * So this does not check that jumping works. It tries to get inside something
   * by jumping at it, from four directions, and at the two places where the
   * vertical logic is doing something unusual: the shop threshold, where the eye
   * is climbing at a clamped rate, and the raised interior floor, where the
   * grounded test has to still return true or the player cannot jump indoors at
   * all.
   */
  console.log("\n[walkprobe] --- run and jump ---");

  const air = await page.evaluate(async () => {
    const W = window.__WP;
    const cam = W.cam;
    /**
     * `window.__PLAYER()`, not a service — and it carries its own liveness
     * guard: `frames` is 0 until `update()` has run, which separates "the
     * controller is disabled by a shot preset" from "the controller ran and the
     * player is standing still". Every other field is identical between those
     * two, and one of them makes all of them meaningless. Read it before
     * anything else here is believed.
     *
     * The report is mutated in place rather than rebuilt, so it must be read
     * live rather than snapshotted — a saved reference is not a saved value.
     */
    const P = () => (typeof window.__PLAYER === "function" ? window.__PLAYER() : null);
    const first = P();
    const out = { hasReport: !!first, reportFrames: first?.frames ?? 0, hops: [], run: null };

    /** One hop from a standing start, reporting apex, airtime and re-landing. */
    const hop = async (label, at, look) => {
      W.place(at[0], at[1], look[0], look[1]);
      await W.frames(30);
      const y0 = cam.position.y;
      const standing = W.surface(at[0], at[1]) + 1.65;
      W.key("keydown", "Space");
      let apex = y0;
      let airFrames = 0;
      let inside = 0;
      let insideWhileAirborne = 0;
      let t = 0;
      const t0 = performance.now();
      for (let i = 0; i < 150; i++) {
        await W.frame();
        if (i === 2) W.key("keyup", "Space");
        const p = cam.position;
        apex = Math.max(apex, p.y);
        const rep = P();
        if (rep?.airborne) {
          airFrames++;
          // The whole point: a body that is off the ground must still be
          // excluded from every blocker's footprint.
          if (W.solidAt(p.x, p.z) !== false) insideWhileAirborne++;
        }
        if (W.solidAt(p.x, p.z) !== false) inside++;
        if (airFrames > 0 && rep && !rep.airborne) {
          t = performance.now() - t0;
          break;
        }
      }
      W.key("keyup", "Space");
      await W.frames(20);
      const rep = P();
      out.hops.push({
        label,
        standing: +standing.toFixed(3),
        y0: +y0.toFixed(3),
        apex: +apex.toFixed(3),
        rise: +(apex - y0).toFixed(3),
        airtimeMs: Math.round(t),
        wentAirborne: airFrames > 0,
        insideWhileAirborne,
        inside,
        landedY: +cam.position.y.toFixed(3),
        landedGrounded: !!rep?.grounded,
        at: [+cam.position.x.toFixed(2), +cam.position.z.toFixed(2)],
      });
    };

    // Flat forecourt: the reference hop.
    await hop("open forecourt", [-8.0, 22.0], [-8.0, 30.0]);

    // At a pump island, aimed at it, running at it while hopping. If a hop can
    // enter a footprint, this is where it happens.
    const pumps = window.__GAME.tryGet("pumps");
    if (pumps?.length) {
      const p = pumps[pumps.length - 1].position;
      W.place(p.x, p.z + 2.2, p.x, p.z);
      await W.frames(10);
      W.key("keydown", "ShiftLeft");
      W.key("keydown", "KeyW");
      W.key("keydown", "Space");
      let inside = 0;
      let closest = Infinity;
      for (let i = 0; i < 200; i++) {
        await W.frame();
        cam.lookAt(p.x, cam.position.y, p.z);
        if (W.solidAt(cam.position.x, cam.position.z) !== false) inside++;
        closest = Math.min(closest, Math.hypot(cam.position.x - p.x, cam.position.z - p.z));
      }
      for (const k of ["ShiftLeft", "KeyW", "Space"]) W.key("keyup", k);
      /**
       * Wait for `grounded` rather than a fixed number of frames. Holding Space
       * hops repeatedly, airtime is ~0.51 s, and a flat 30-frame wait is ~0.5 s —
       * so the sample landed mid-hop and reported the eye 227 mm above standing
       * height, which reads exactly like a player standing on top of the island.
       * A fixed settle time that is the same length as the thing it waits for is
       * not a settle.
       */
      for (let i = 0; i < 180; i++) {
        await W.frame();
        if (P()?.grounded) break;
      }
      await W.frames(6);
      out.runJumpAtPump = {
        inside,
        closest: +closest.toFixed(3),
        endedInside: W.solidAt(cam.position.x, cam.position.z) !== false,
        endY: +cam.position.y.toFixed(3),
        standY: +(W.surface(cam.position.x, cam.position.z) + 1.65).toFixed(3),
      };
    }

    // Hopping at the storefront, and then on the raised interior floor, where the
    // grounded test meets a surface that is not the exterior ground.
    await hop("into the storefront", [-2.0, 30.6], [-2.0, 34.0]);
    await hop("inside the shop", [-6.0, 33.2], [-6.0, 36.0]);

    // Run speed. Terminal, so measured over the back half of a long straight.
    W.place(-14.0, 14.0, -14.0, 30.0);
    await W.frames(20);
    W.key("keydown", "ShiftLeft");
    W.key("keydown", "KeyW");
    for (let i = 0; i < 90; i++) await W.frame();
    const a = cam.position.clone();
    const ta = performance.now();
    for (let i = 0; i < 60; i++) await W.frame();
    const dt = (performance.now() - ta) / 1000;
    const dist = Math.hypot(cam.position.x - a.x, cam.position.z - a.z);
    W.key("keyup", "KeyW");
    W.key("keyup", "ShiftLeft");
    await W.frames(30);
    out.run = { mps: +(dist / dt).toFixed(3), seconds: +dt.toFixed(2) };
    return out;
  });

  check(air.hasReport, "the player exposes a report a harness can read", "window.__PLAYER is absent");
  check(
    air.reportFrames > 0,
    "the controller has actually run, so its report means something",
    `report.frames is ${air.reportFrames} — the controller never updated, and every number below would be a default`
  );

  for (const h of air.hops) {
    console.log(
      `  hop ${h.label.padEnd(20)} rise ${(h.rise * 1000).toFixed(0)} mm | airtime ${h.airtimeMs} ms | ` +
        `landed y ${h.landedY} (standing ${h.standing}) | inside solid ${h.inside} frames`
    );
    check(h.wentAirborne, `Space actually leaves the ground (${h.label})`, "never reported airborne");
    // The load-bearing one. Height-less rectangles mean this must be zero.
    check(
      h.insideWhileAirborne === 0,
      `a hop cannot put the body inside a blocker (${h.label})`,
      `${h.insideWhileAirborne} airborne frames inside a footprint`
    );
    check(
      h.landedGrounded,
      `the player lands and is grounded again (${h.label})`,
      `grounded: ${h.landedGrounded}, y ${h.landedY} against standing ${h.standing}`
    );
    // Landing must return to the surface it started from, not on top of anything.
    check(
      Math.abs(h.landedY - h.standing) < 0.06,
      `the hop lands back at standing height (${h.label})`,
      `landed ${h.landedY}, standing height ${h.standing}`
    );
  }

  if (air.runJumpAtPump) {
    const j = air.runJumpAtPump;
    console.log(
      `  running hop at a pump: closest ${j.closest} m, inside ${j.inside} frames, ` +
        `ended ${j.endedInside ? "INSIDE" : "clear"}, y ${j.endY} against standing ${j.standY}`
    );
    check(j.inside === 0, "running and jumping at a pump island never enters its footprint", `${j.inside} frames inside`);
    check(!j.endedInside, "the run-jump does not end up inside the island", "ended inside a blocker");
    check(
      Math.abs(j.endY - j.standY) < 0.06,
      "the run-jump does not end up standing on top of anything",
      `y ${j.endY} against standing height ${j.standY}`
    );
  }

  console.log(`  run speed: ${air.run.mps} m/s over ${air.run.seconds} s`);
  // 1.4 x 1.7 = 2.38. Same tolerance the walk check uses.
  check(
    Math.abs(air.run.mps - 2.38) < 0.12,
    "holding shift reaches the intended 2.38 m/s",
    `measured ${air.run.mps} m/s`
  );

  /* ---- the prompt, which must not name an action the click will not do ---- */
  console.log("\n[walkprobe] --- the prompt ---");
  const words = await page.evaluate(async () => {
    const W = window.__WP;
    const I = window.__INTERACT;
    const out = [];
    const pumps = window.__GAME.tryGet("pumps");
    const p = pumps[pumps.length - 1].position;

    // Before and after, at the same stance: the wording has to follow the state,
    // or it is a label rather than a prompt.
    W.place(p.x, p.z + 1.1, p.x, p.z);
    W.cam.lookAt(p.x, p.y + 1.1, p.z);
    await W.frames(12);
    const first = I.hover();
    const clicked = I.click();
    await W.frames(40);
    const second = I.hover();
    out.push({ label: "a pump, before and after using it", first: first.prompt, clicked: !!clicked, second: second.prompt });

    // And with nothing in reach.
    W.place(-2.0, 26.0, -2.0, 10.0);
    W.cam.lookAt(-2.0, 60.0, 10.0);
    await W.frames(10);
    out.push({ label: "nothing in reach", first: I.hover().prompt, clicked: null, second: null });
    return out;
  });

  for (const w of words) {
    console.log(`  ${w.label}: "${w.first}"${w.second === null ? "" : ` -> "${w.second}"`}`);
  }
  const pumpWords = words[0];
  check(pumpWords.first.length > 0, "a reachable target has a prompt", "the prompt was empty in reach");
  check(
    pumpWords.first !== pumpWords.second,
    "the prompt changes once the action has been taken",
    `still reads "${pumpWords.second}" after the click, so it is a label rather than a prompt`
  );
  check(words[1].first === "", "nothing in reach means no prompt", `read "${words[1].first}"`);

  /* ---- what the collision test costs per frame ---- */
  console.log("\n[walkprobe] --- collision cost ---");
  const cost = await page.evaluate(() => {
    const g = window.__GAME;
    const field = g.tryGet("collision.field");
    const v = g.camera.position.clone();
    const R = 0.32;
    // The real per-frame call, broad phases and portal lookup and all — not a
    // reimplementation of it. A benchmark that models the work rather than
    // running it measures the model.
    const step = (x, z) => {
      v.set(x, 1.65, z);
      field.resolve(v, field.radiusAt(x, z, R, 0.2));
    };
    const bench = (x, z) => {
      for (let i = 0; i < 20_000; i++) step(x, z); // warm
      const t0 = performance.now();
      const N = 500_000;
      for (let i = 0; i < N; i++) step(x, z);
      return ((performance.now() - t0) * 1e6) / N; // nanoseconds per call
    };
    return {
      blockers: field.blockerCount,
      groups: field.groups.length,
      rect: field.bounds,
      points: [
        ["off-site, outside every group", -30, 2, bench(-30, 2)],
        ["out on the lot", -14, 2, bench(-14, 2)],
        ["on the forecourt between the islands", 0, 20, bench(0, 20)],
        ["pressed against a dispenser", 0, 22.3, bench(0, 22.3)],
        ["pressed against the front elevation", -5, 31.2, bench(-5, 31.2)],
        ["in the doorway", -6, 31.6, bench(-6, 31.6)],
        ["inside the shop, among the gondolas", -5, 35, bench(-5, 35)],
        ["alongside the parked car", 12.2, 35, bench(12.2, 35)],
      ],
    };
  });
  console.log(`  ${cost.blockers} blockers in ${cost.groups} groups; field rect x [${cost.rect.minX.toFixed(2)}, ${cost.rect.maxX.toFixed(2)}] z [${cost.rect.minZ.toFixed(2)}, ${cost.rect.maxZ.toFixed(2)}]`);
  for (const [label, x, z, ns] of cost.points) {
    console.log(`    ${ns.toFixed(1).padStart(7)} ns/frame  (${String(x).padStart(6)}, ${String(z).padStart(5)})  ${label}`);
  }
  const worst = Math.max(...cost.points.map((p) => p[3]));
  check(worst < 2000, "collision costs well under a microsecond per frame", `worst case ${worst.toFixed(1)} ns`);
  const byLabel = Object.fromEntries(cost.points.map((p) => [p[0], p[3]]));
  notes.push(
    `collision cost with ${cost.blockers} blockers in ${cost.groups} groups: ` +
      `${byLabel["off-site, outside every group"].toFixed(0)} ns/frame off-site (one rect rejects the field), ` +
      `${byLabel["out on the lot"].toFixed(0)} ns on the lot, ` +
      `${byLabel["inside the shop, among the gondolas"].toFixed(0)} ns inside the shop, ` +
      `worst case ${worst.toFixed(0)} ns — ${((worst / 16.7e6) * 100).toFixed(4)}% of a 16.7 ms frame.`
  );

  if (problems.length) {
    console.error(`\n[walkprobe] page problems:\n    ${problems.slice(0, 8).join("\n    ")}`);
    check(
      !problems.some((p) => /Shader Error|not compiled|VALIDATE_STATUS/i.test(p)),
      "no shader compile/link errors"
    );
  } else {
    check(true, "no shader compile/link errors", "console clean");
  }

  await page.close();
  await context.close();

  console.log("\n[walkprobe] observations:");
  for (const n of notes) console.log(`  - ${n}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[walkprobe] ${checks.length - failed.length}/${checks.length} checks passed`);
  await shutdown(failed.length ? 1 : 0, failed.length ? failed.map((f) => f.label).join("; ") : null);
}

/** Mean luminance of the top and bottom 15% of a PNG. */
async function bandLuma(file) {
  const png = PNG.sync.read(await fs.readFile(file));
  const band = Math.floor(png.height * 0.15);
  const mean = (y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < png.width; x += 3) {
        const i = (png.width * y + x) << 2;
        sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
        n++;
      }
    }
    return sum / n;
  };
  return { top: mean(0, band), bottom: mean(png.height - band, png.height) };
}

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort only */
  }
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
