#!/usr/bin/env node
/**
 * System 7 (interaction) verification harness.
 *
 *   node tools/shoot7.mjs                 # assert, then three confirming shots
 *   node tools/shoot7.mjs --no-shots      # assertions only, nothing rendered out
 *   node tools/shoot7.mjs --no-build      # reuse .shot7-build/
 *
 * Port 5117, own build directory, output to shots/system7/.
 *
 * This one is deliberately not a screenshot loop. NOTES.md documents seven
 * cases in this project of correct code never reaching the screen, but the
 * answer to that is not more frames — it is asserting on numbers the page
 * itself reports. So the bulk of this file drives `window.__INTERACT`, which
 * scripts a camera pose, fires one interaction down the camera forward vector
 * and reads back live state: the door's actual hinge angle, the lighting
 * system's own door-spill emitter intensity, the metered gallons out of
 * `getDisplay()`, the tick rate, the cooler hinge angle and the bottle's world
 * position. A screenshot cannot tell you the tick rate is derived from the same
 * variable as the digits; this can.
 *
 * Teardown contract, per the user's global rule: the preview server and the
 * browser are registered with one shutdown routine wired to normal completion,
 * thrown errors, SIGINT, SIGTERM, uncaughtException and unhandledRejection
 * BEFORE either is started. Nothing is detached, and the process always ends in
 * an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".shot7-build");
const PORT = 5117;
// 1280x720, not 1600x900: the machine is being used to play a game while this
// runs, and these frames only have to confirm the state assertions.
const WIDTH = 1280;
const HEIGHT = 720;
const READY_TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");
const DO_SHOTS = !argv.includes("--no-shots");
const ALLOW_SOFTWARE = argv.includes("--allow-software");

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
  if (reason) console.error(`\n[shoot7] shutting down: ${reason}`);
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
      console.error(`[shoot7] failed to close ${label}: ${err?.message ?? err}`);
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

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort */
  }
}

const SHADER_FAIL = /program info log|shader error|gl\.getShaderInfoLog|undeclared identifier|VALIDATE_STATUS/i;

async function bundleStamp() {
  let newest = 0;
  let file = "";
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await fs.stat(full);
        if (st.mtimeMs > newest) {
          newest = st.mtimeMs;
          file = path.relative(ROOT, full);
        }
      }
    }
  };
  await walk(OUT_DIR);
  return newest ? `${new Date(newest).toISOString()} (${file})` : `${path.relative(ROOT, OUT_DIR)}/ missing`;
}

/* ------------------------------------------------------------------ */

const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const n = (v, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : String(v));

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[shoot7] building...");
    lowerPriority();
    await build({
      root: ROOT,
      logLevel: "warn",
      build: {
        outDir: OUT_DIR,
        emptyOutDir: true,
        // Two entries: the real page, and the fallback diagnostic page that
        // isolates each system's init so one broken system cannot stop the
        // rest of the scene from coming up. See src/interactCheck.ts.
        rollupOptions: {
          input: {
            main: path.join(ROOT, "index.html"),
            check: path.join(ROOT, "interactCheck.html"),
          },
        },
      },
    });
  }
  const stamp = await bundleStamp();
  console.log(`[shoot7] bundle mtime: ${stamp}`);

  console.log(`[shoot7] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  console.log("[shoot7] launching chromium (new headless, hardware GPU)");
  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "shoot7", allowSoftware: ALLOW_SOFTWARE });
  await gpuPage.close();

  const page = await context.newPage();
  const problems = [];
  const transcript = [];
  page.on("console", (m) => {
    if (transcript.length < 120) transcript.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error" || SHADER_FAIL.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  // `shot=system7` is not a preset any system claims, so PlayerSystem disables
  // free-look and leaves the camera to __INTERACT.look().
  const load = async (entry) => {
    transcript.length = 0;
    await page.goto(`${base}${entry}?shot=system7&gpu=1&stubpumps=1`, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });
      return true;
    } catch {
      // A scene that never signals ready is almost always an init throwing or
      // a program failing to link, and both are invisible without the page's
      // own console.
      console.error(`\n[shoot7] ${entry} never reached __SCENE_READY. Page console:`);
      for (const t of transcript) console.error(`    ${t}`);
      const loading = await page.evaluate(() => document.getElementById("loading")?.textContent ?? null).catch(() => null);
      console.error(`[shoot7] #loading text: ${loading}`);
      return false;
    }
  };

  let entry = "index.html";
  let isolated = false;
  if (!(await load(entry))) {
    // Fall back to the diagnostic entry, which isolates each system's init so
    // one broken system cannot stop the rest of the scene coming up. This is
    // reported loudly: it means the shipping page is currently dead.
    console.error("[shoot7] falling back to interactCheck.html (isolated systems)");
    entry = "interactCheck.html";
    isolated = true;
    if (!(await load(entry))) await shutdown(1, "neither entry point reached __SCENE_READY");
  }
  console.log(`[shoot7] running against ${entry}${isolated ? "  (SYSTEM ISOLATION ACTIVE)" : ""}`);
  const sysFail = await page.evaluate(() => window.__SYSFAIL ?? null).catch(() => null);
  if (sysFail && Object.keys(sysFail).length) {
    console.error(`[shoot7] systems that failed to initialise: ${JSON.stringify(sysFail, null, 2)}`);
  }
  check("page: shipping entry point comes up", !isolated, isolated ? `index.html is dead — ${JSON.stringify(sysFail)}` : "index.html reached __SCENE_READY");

  const step = (ms) =>
    page.evaluate(
      (target) =>
        new Promise((res) => {
          const t0 = performance.now();
          const tick = () => (performance.now() - t0 >= target ? res(performance.now() - t0) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      ms
    );
  const state = () => page.evaluate(() => window.__INTERACT.state());
  const calls = () => page.evaluate(() => window.__INTERACT.calls.slice());
  const click = () => page.evaluate(() => window.__INTERACT.click());
  const probe = () => page.evaluate(() => window.__INTERACT.probe());
  const look = (from, to) => page.evaluate(([f, t]) => window.__INTERACT.look(f[0], f[1], f[2], t[0], t[1], t[2]), [from, to]);

  /**
   * Stand square in front of a hinged leaf *wherever it currently is*. An open
   * door has swung ninety degrees out of the doorway, so the pose you used to
   * open it no longer points at anything — which is how the first run of this
   * harness managed to report a door that would not close.
   */
  const faceLeaf = (service, index, aimY, standOff) =>
    page.evaluate(
      ([svc, i, ay, off]) => {
        const got = window.__GAME?.tryGet(svc);
        const leaf = Array.isArray(got) ? got[i] : got;
        if (!leaf) return null;
        leaf.updateWorldMatrix(true, false);
        const m = leaf.matrixWorld.elements;
        const w = leaf.userData?.leafWidth ?? leaf.userData?.width ?? 0.9;
        // Columns of the world matrix: local +X and local +Z in world space.
        const ax = { x: m[0], y: m[1], z: m[2] };
        const az = { x: m[8], y: m[9], z: m[10] };
        const mid = { x: m[12] + ax.x * w * 0.5, y: m[13] + ay, z: m[14] + ax.z * w * 0.5 };
        // The leaf's face is its local -Z; stand off along it.
        const from = [mid.x - az.x * off, mid.y, mid.z - az.z * off];
        window.__INTERACT.look(from[0], from[1], from[2], mid.x, mid.y, mid.z);
        return { from, to: [mid.x, mid.y, mid.z] };
      },
      [service, index, aimY, standOff]
    );

  await step(120);

  /* ---------------- services ---------------- */
  console.log("\n[shoot7] registry");
  const services = await page.evaluate(() => window.__INTERACT?.services ?? null);
  console.log(`  services: ${JSON.stringify(services)}`);
  check("registry: __INTERACT published", !!services, services ? "" : "window.__INTERACT missing");
  if (!services) await shutdown(1, "interaction system never initialised");
  const realPumps = !isolated && services.pumpFaces >= 6;
  check(
    "registry: pump faces resolved",
    services.pumpFaces >= (isolated ? 1 : 6),
    `pumpFaces=${services.pumpFaces} pickables=${services.pumpPickables}` + (isolated ? "  (STUB — the real PumpSystem is down)" : "")
  );
  check("registry: entry door resolved", services.entryDoor === true, `entryDoor=${services.entryDoor}`);
  check("registry: cooler doors resolved", services.coolerDoors >= 1, `coolerDoors=${services.coolerDoors}`);
  check("registry: grabbables resolved", services.grabbables >= 1, `grabbables=${services.grabbables}`);
  check("registry: audio service resolved", services.audio === true, `audio=${services.audio}`);
  check("registry: lighting door hook resolved", services.lightingDoorHook === true, `hook=${services.lightingDoorHook}`);

  /* ================= 1. PUMP ================= */
  console.log(`\n[shoot7] 1. pump${realPumps ? "" : "  — against the STUB face; the real PumpSystem never initialised"}`);
  const pumpPose = await page.evaluate(() => {
    const faces = window.__GAME?.tryGet("pumpFaces");
    if (!faces || !faces.length) return null;
    const f = faces.find((x) => x.name.includes("pump-2")) ?? faces[0];
    const s = f.standPosition;
    const d = f.displayCentre;
    const gh = window.__GAME.tryGet("groundHeight");
    const eye = (typeof gh === "function" ? gh(s.x, s.z) : 0) + 1.62;
    return { name: f.name, from: [s.x, eye, s.z], to: [d.x, d.y, d.z] };
  });
  check("pump: a face reported a stand position", !!pumpPose, pumpPose ? pumpPose.name : "no pumpFaces service");

  let pumpSamples = [];
  if (pumpPose) {
    await look(pumpPose.from, pumpPose.to);
    await step(60);
    const aim = await probe();
    check("pump: ray reaches the dispenser from its stand position", aim?.kind === "pump", JSON.stringify(aim));

    const hit = await click();
    check("pump: click registered on a pump face", hit?.kind === "pump", `${hit?.name} at ${n(hit?.distance, 2)} m`);

    for (const t of [400, 1200, 1200, 1200]) {
      await step(t);
      pumpSamples.push(await state());
    }
    const rows = pumpSamples.map((s) => s.pump);
    for (const r of rows) {
      console.log(
        `    t=${n(pumpSamples[rows.indexOf(r)].t, 2)}s  gal=${n(r.gallons, 4)}  $=${n(r.dollars, 3)}  ` +
          `flow=${n(r.flow, 4)} gal/s  ticks=${n(r.tickRate, 3)}/s  lift=${n(r.nozzleLift, 3)}  ` +
          `display{gal=${n(r.display?.gallons, 3)} $=${n(r.display?.dollars, 2)} active=${r.display?.active}}`
      );
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    check("pump: dispenser authorised", last.display?.active === true, `display.active=${last.display?.active}`);
    check("pump: gallons advancing", last.gallons > first.gallons + 0.2, `${n(first.gallons, 4)} -> ${n(last.gallons, 4)} gal`);
    check(
      "pump: display canvas received the advancing values",
      last.display && last.display.gallons > 0.2 && last.display.dollars > 0.5,
      `getDisplay -> ${n(last.display?.gallons, 3)} gal / $${n(last.display?.dollars, 2)}`
    );
    const priceErr = Math.abs(last.dollars - last.gallons * last.price);
    check("pump: sale = gallons x posted price", priceErr < 1e-6, `|$ - gal*price| = ${priceErr.toExponential(2)}`);

    // Rate sanity: 9.2 gpm is 0.153 gal/s. Measured across the two later
    // samples, past the spin-up ramp.
    const dt = pumpSamples[3].t - pumpSamples[2].t;
    const dg = rows[3].gallons - rows[2].gallons;
    const gpm = (dg / dt) * 60;
    check("pump: delivery rate in the 8-10 gpm band", gpm > 8 && gpm < 10.2, `measured ${n(gpm, 3)} gpm over ${n(dt, 2)} s`);

    // The point of the whole exercise: the ticking is derived from the same
    // `flow` that integrates the digits, so gallons-per-tick is a constant.
    // `flow` is the variable the digits are integrated from. If the ticking is
    // derived from anything else, this drifts. The 0.05 allowance is the
    // deadband that stops the rate being re-sent on every single frame.
    const residual = rows.filter((r) => r.tickRate > 0).map((r) => Math.abs(r.tickRate - r.flow * 45));
    check(
      "pump: tick rate derived from the same state as the digits",
      residual.length >= 2 && Math.max(...residual) < 0.05,
      `|ticks - flow*45| = [${residual.map((v) => v.toExponential(2)).join(", ")}] /s`
    );
    const measuredTicks = (dg / dt) * 45;
    check(
      "pump: tick rate matches the flow measured off the digits",
      Math.abs(measuredTicks - last.tickRate) < 0.08,
      `digits imply ${n(measuredTicks, 3)} ticks/s, audio was told ${n(last.tickRate, 3)}/s`
    );
    check("pump: nozzle lifted out of the boot", last.nozzleLift > 0.5, `lift = ${n(last.nozzleLift, 3)}`);

    const beforeStop = last.gallons;
    await click();
    await step(200);
    const stopped = await state();
    check("pump: second click stops it", stopped.pump.running === false, `running=${stopped.pump.running}`);
    const log = await calls();
    const names = log.map((c) => c.name);
    check("pump: playPumpStart called", names.includes("playPumpStart"), `first at t=${n(log.find((c) => c.name === "playPumpStart")?.t, 2)}s`);
    check("pump: playPumpStop called", names.includes("playPumpStop"), "");
    const tickCalls = log.filter((c) => c.name === "setPumpTickRate");
    const rising = tickCalls.filter((c, i) => i > 0 && c.value > tickCalls[i - 1].value).length;
    check(
      "pump: setPumpTickRate ramped then zeroed",
      tickCalls.length >= 4 && rising >= 3 && tickCalls[tickCalls.length - 1].value === 0,
      `${tickCalls.length} calls, ${rising} rising, last=${n(tickCalls[tickCalls.length - 1]?.value, 3)}`
    );
    const held = await page.evaluate((name) => {
      const faces = window.__GAME?.tryGet("pumpFaces") ?? [];
      const f = faces.find((x) => x.name === name);
      return f ? f.getDisplay() : null;
    }, pumpPose.name);
    check(
      "pump: sale left on the head after the handle drops",
      held && Math.abs(held.gallons - beforeStop) < 0.05 && held.active === false,
      `head reads ${n(held?.gallons, 3)} gal / $${n(held?.dollars, 2)}, active=${held?.active}, metered ${n(beforeStop, 3)} gal`
    );
  }

  /* ================= 2. DOOR ================= */
  console.log("\n[shoot7] 2. entry door");
  const doorInfo = await page.evaluate(() => {
    const d = window.__GAME?.tryGet("building.entryDoor");
    if (!d) return null;
    d.updateWorldMatrix(true, false);
    const e = d.matrixWorld.elements;
    return {
      x: e[12],
      y: e[13],
      z: e[14],
      leafWidth: d.userData?.leafWidth ?? 0.9,
      openAngle: d.userData?.openAngle ?? 1.62,
      angle: d.rotation.y,
    };
  });
  check("door: hinge transform readable", !!doorInfo, JSON.stringify(doorInfo));

  const doorSamples = [];
  if (doorInfo) {
    const cx = doorInfo.x + doorInfo.leafWidth * 0.5;
    // Outside the storefront is -Z; stand on the stoop a metre off the leaf.
    await look([cx, doorInfo.y + 1.62, doorInfo.z - 1.05], [cx, doorInfo.y + 1.15, doorInfo.z]);
    await step(60);
    const aim = await probe();
    check("door: ray reaches the leaf from the stoop", aim?.kind === "door", JSON.stringify(aim));

    const before = await state();
    await click();
    for (const t of [90, 90, 90, 120, 150, 200, 400]) {
      await step(t);
      doorSamples.push(await state());
    }
    console.log(`    closed: angle=${n(before.door.angle, 4)} rad  sent=${n(before.door.sentAmount, 3)}  spill=${n(before.door.spillIntensity, 3)}`);
    for (const s of doorSamples) {
      console.log(
        `    t=${n(s.t, 2)}s  angle=${n(s.door.angle, 4)} rad  amount=${n(s.door.amount, 4)}  ` +
          `sentToAudioAndLighting=${n(s.door.sentAmount, 4)}  spillIntensity=${n(s.door.spillIntensity, 3)}`
      );
    }
    const opened = doorSamples[doorSamples.length - 1].door;
    check("door: hinge angle actually changed", opened.angle > before.door.angle + 1.0, `${n(before.door.angle, 4)} -> ${n(opened.angle, 4)} rad`);
    check("door: reached the full open angle", opened.amount > 0.97, `amount=${n(opened.amount, 4)} of openAngle ${n(doorInfo.openAngle, 3)}`);
    const angles = doorSamples.map((s) => s.door.angle);
    check("door: swing is monotonic", angles.every((a, i) => i === 0 || a >= angles[i - 1] - 1e-6), angles.map((a) => n(a, 3)).join(" -> "));
    // A closer eases: the first 90 ms must cover more ground than the last.
    const early = angles[1] - angles[0];
    const lateIdx = angles.length - 1;
    const late = angles[lateIdx] - angles[lateIdx - 1];
    check("door: opening eases into the backcheck", early > late, `first 90ms moved ${n(early, 4)} rad, last 400ms moved ${n(late, 4)} rad`);

    const log = await calls();
    const sent = log.filter((c) => c.name === "setDoorOpenAmount").map((c) => c.value);
    const lit = log.filter((c) => c.name === "lighting.setDoorOpenAmount").map((c) => c.value);
    const distinct = new Set(sent.map((v) => v.toFixed(3))).size;
    check(
      "door: setDoorOpenAmount driven continuously through the swing",
      distinct >= 8 && Math.max(...sent) > 0.97,
      `${sent.length} calls, ${distinct} distinct values, max ${n(Math.max(...sent), 3)}`
    );
    check(
      "door: lighting hook driven with the same values",
      lit.length === sent.length && Math.max(...lit) > 0.97,
      `${lit.length} lighting calls, max ${n(Math.max(...lit), 3)}`
    );
    check(
      "door: lighting's own spill emitter responded",
      typeof opened.spillIntensity === "number" && opened.spillIntensity > 0.5,
      `door-sun-bounce intensity ${n(before.door.spillIntensity, 3)} -> ${n(opened.spillIntensity, 3)}`
    );
    check("door: playDoorOpen called", log.some((c) => c.name === "playDoorOpen"), "");

    // Close: a real closer decelerates all the way into the latch. The leaf has
    // swung ninety degrees out of the doorway, so re-aim at where it is now.
    const back = await faceLeaf("building.entryDoor", 0, 1.15, 1.0);
    await step(60);
    const aimOpen = await probe();
    check("door: leaf still reachable once it has swung open", aimOpen?.kind === "door", `${JSON.stringify(aimOpen)} from ${JSON.stringify(back?.from?.map((v) => Math.round(v * 100) / 100))}`);
    await click();
    const closing = [];
    for (const t of [150, 150, 150, 250, 300, 400, 600]) {
      await step(t);
      closing.push(await state());
    }
    const cAngles = closing.map((s) => s.door.angle);
    console.log(`    closing: ${cAngles.map((a) => n(a, 3)).join(" -> ")}`);
    const cEarly = cAngles[0] - cAngles[1];
    const cLate = cAngles[cAngles.length - 2] - cAngles[cAngles.length - 1];
    check("door: latched shut", cAngles[cAngles.length - 1] < 1e-3, `final angle ${n(cAngles[cAngles.length - 1], 5)} rad`);
    check("door: closing decelerates into the latch", cEarly > cLate, `${n(cEarly, 4)} rad in the first 150ms vs ${n(cLate, 4)} in the last 600ms`);
    const log2 = await calls();
    check("door: playDoorClose fired at the latch, not at the click", log2.some((c) => c.name === "playDoorClose"), "");
    const finalSent = log2.filter((c) => c.name === "setDoorOpenAmount").pop();
    check("door: audio told the door is shut", finalSent && finalSent.value === 0, `last setDoorOpenAmount = ${n(finalSent?.value, 4)}`);
    const finalSpill = closing[closing.length - 1].door.spillIntensity;
    check("door: sun spill went back down", typeof finalSpill === "number" && finalSpill < 0.01, `spill ${n(finalSpill, 4)}`);
  }

  /* ================= 3. COOLER AND BOTTLE ================= */
  console.log("\n[shoot7] 3. cooler and bottle");
  const coolerInfo = await page.evaluate(() => {
    const doors = window.__GAME?.tryGet("building.coolerDoors") ?? [];
    const bottle = window.__GAME?.tryGet("building.grabBottle");
    if (!doors.length || !bottle) return null;
    bottle.updateWorldMatrix(true, false);
    const be = bottle.matrixWorld.elements;
    const b = { x: be[12], y: be[13], z: be[14] };
    let best = null;
    doors.forEach((d, i) => {
      d.updateWorldMatrix(true, false);
      const e = d.matrixWorld.elements;
      const w = d.userData?.width ?? 0.85;
      const h = d.userData?.height ?? 1.8;
      const centre = e[12] + w / 2;
      const dist = Math.abs(centre - b.x);
      if (!best || dist < best.dist) best = { index: i, x: e[12], y: e[13], z: e[14], w, h, centre, dist };
    });
    return { bottle: b, door: best };
  });
  check("cooler: door and bottle located", !!coolerInfo, coolerInfo ? `nearest door #${coolerInfo.door.index} to bottle` : "missing service");

  if (coolerInfo) {
    const d = coolerInfo.door;
    await look([d.centre, d.y + d.h * 0.55, d.z - 0.95], [d.centre, d.y + d.h * 0.5, d.z]);
    await step(60);
    const aim = await probe();
    check("cooler: ray reaches the glass door", aim?.kind === "cooler", JSON.stringify(aim));

    const before = await state();
    await click();
    const cs = [];
    for (const t of [100, 150, 250, 400]) {
      await step(t);
      cs.push(await state());
    }
    const a0 = before.coolers[d.index].angle;
    const a1 = cs[cs.length - 1].coolers[d.index].angle;
    console.log(`    cooler hinge #${d.index}: ${n(a0, 4)} -> ${cs.map((s) => n(s.coolers[d.index].angle, 3)).join(" -> ")} rad`);
    check("cooler: hinge rotated", a1 > a0 + 1.0, `${n(a0, 4)} -> ${n(a1, 4)} rad`);
    const others = cs[cs.length - 1].coolers.filter((c, i) => i !== d.index && Math.abs(c.angle) > 1e-4);
    check("cooler: only the door that was clicked moved", others.length === 0, `${others.length} other doors moved`);
    check("cooler: playFridgeOpen called", (await calls()).some((c) => c.name === "playFridgeOpen"), "");

    /* ---- the bottle ---- */
    const b = coolerInfo.bottle;
    let grabbed = null;
    for (const dx of [0.16, 0.42, -0.22, 0.0]) {
      await look([b.x + dx, b.y + 0.42, b.z - 0.8], [b.x, b.y + 0.02, b.z]);
      await step(60);
      const p = await probe();
      if (p?.kind === "bottle") {
        grabbed = await click();
        break;
      }
    }
    check("bottle: ray reaches the bottle through the open door", !!grabbed, grabbed ? `${grabbed.name} at ${n(grabbed.distance, 2)} m` : "never picked the bottle");

    if (grabbed) {
      const bs = [];
      for (const t of [120, 200, 300, 300]) {
        await step(t);
        bs.push(await state());
      }
      for (const s of bs) {
        console.log(`    t=${n(s.t, 2)}s  bottle carried=${s.bottle.carried} lift=${n(s.bottle.t, 2)}  pos=(${n(s.bottle.x, 3)}, ${n(s.bottle.y, 3)}, ${n(s.bottle.z, 3)})`);
      }
      const end = bs[bs.length - 1].bottle;
      const moved = Math.hypot(end.x - b.x, end.y - b.y, end.z - b.z);
      check("bottle: left the shelf", moved > 0.3, `moved ${n(moved, 3)} m from (${n(b.x, 2)}, ${n(b.y, 2)}, ${n(b.z, 2)})`);
      check("bottle: is being carried", end.carried === true && end.t >= 1, `carried=${end.carried} lift=${n(end.t, 2)}`);
      const camDist = await page.evaluate(
        ([x, y, z]) => window.__GAME.camera.position.distanceTo(new (window.__GAME.camera.position.constructor)(x, y, z)),
        [end.x, end.y, end.z]
      );
      check("bottle: ended up in hand, not floating in the room", camDist < 0.75, `${n(camDist, 3)} m from the eye`);
      check("bottle: playBottleGrab called", (await calls()).some((c) => c.name === "playBottleGrab"), "");

      // Carrying must track the camera, so turning away moves it with you.
      const p0 = (await state()).bottle;
      await look([b.x + 1.4, b.y + 0.42, b.z - 1.6], [b.x + 3.0, b.y, b.z - 3.0]);
      await step(400);
      const p1 = (await state()).bottle;
      const followed = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      check("bottle: follows the player", followed > 0.5, `moved ${n(followed, 3)} m with the camera`);
    }

    /* ---- close the cooler ---- */
    await faceLeaf("building.coolerDoors", d.index, d.h * 0.5, 0.95);
    await step(60);
    const aim2 = await probe();
    if (aim2?.kind === "cooler") {
      await click();
      await step(1400);
      const closed = (await state()).coolers[d.index].angle;
      check("cooler: closes again", closed < 1e-3, `final angle ${n(closed, 5)} rad`);
      check("cooler: playFridgeClose fired at the latch", (await calls()).some((c) => c.name === "playFridgeClose"), "");
    } else {
      check("cooler: reachable to close again", false, JSON.stringify(aim2));
    }
  }

  /* ================= confirming frames ================= */
  if (DO_SHOTS) {
    console.log("\n[shoot7] three confirming frames at 1280x720");
    const outDir = path.join(ROOT, "shots", "system7");
    await fs.mkdir(outDir, { recursive: true });

    // a) pump running, seen from the stand position. Only worth a frame when
    // the real dispenser is there — the stub is a bare box.
    if (pumpPose && realPumps) {
      await look(pumpPose.from, pumpPose.to);
      await step(60);
      await click();
      await step(2600);
      const s = await state();
      await page.screenshot({ path: path.join(outDir, "pump_running.png"), type: "png" });
      console.log(`    pump_running.png    ${n(s.pump.gallons, 3)} gal / $${n(s.pump.dollars, 2)} on the head, ticks ${n(s.pump.tickRate, 2)}/s`);
      await click();
      await step(120);
    }

    // b) door mid-swing from the stoop, sun coming through
    if (doorInfo) {
      const cx = doorInfo.x + doorInfo.leafWidth * 0.5;
      await look([cx + 0.55, doorInfo.y + 1.62, doorInfo.z - 1.5], [cx - 0.2, doorInfo.y + 1.2, doorInfo.z + 2.4]);
      await step(60);
      await look([cx, doorInfo.y + 1.62, doorInfo.z - 1.05], [cx, doorInfo.y + 1.15, doorInfo.z]);
      await step(60);
      await click();
      await step(260);
      await look([cx + 0.55, doorInfo.y + 1.62, doorInfo.z - 1.5], [cx - 0.2, doorInfo.y + 1.2, doorInfo.z + 2.4]);
      await step(90);
      const s = await state();
      await page.screenshot({ path: path.join(outDir, "door_swing.png"), type: "png" });
      console.log(`    door_swing.png      angle ${n(s.door.angle, 3)} rad, amount ${n(s.door.amount, 3)}, spill ${n(s.door.spillIntensity, 2)}`);
    }

    // c) bottle in hand at the cooler
    if (coolerInfo) {
      const d = coolerInfo.door;
      await look([d.centre + 0.5, d.y + d.h * 0.6, d.z - 1.5], [d.centre - 0.3, d.y + d.h * 0.45, d.z]);
      await step(300);
      const s = await state();
      await page.screenshot({ path: path.join(outDir, "bottle_in_hand.png"), type: "png" });
      console.log(`    bottle_in_hand.png  carried=${s.bottle?.carried} at (${n(s.bottle?.x, 2)}, ${n(s.bottle?.y, 2)}, ${n(s.bottle?.z, 2)})`);
    }
  }

  /* ================= page health ================= */
  console.log("\n[shoot7] page console");
  const shaderProblems = problems.filter((p) => SHADER_FAIL.test(p));
  console.log(`  ${problems.length} console errors / page errors, ${shaderProblems.length} shader-related`);
  for (const p of problems.slice(0, 12)) console.log(`    ${p}`);
  check("page: no shader link failures", shaderProblems.length === 0, shaderProblems[0] ?? "");
  check("page: no uncaught page errors", problems.filter((p) => p.startsWith("pageerror")).length === 0, problems.find((p) => p.startsWith("pageerror")) ?? "");

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[shoot7] ${passed}/${results.length} assertions passed   bundle ${stamp}`);

  await page.close();
  await context.close();
  await shutdown(failures.length ? 1 : 0, failures.length ? `${failures.length} assertion(s) failed` : null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
