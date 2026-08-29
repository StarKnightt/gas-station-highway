#!/usr/bin/env node
/**
 * Does `envMapIntensity` actually reach the screen, per system?
 *
 * NOTES.md case 21: three 0.185.1 only refreshes the `envMapIntensity` uniform
 * from the material when the material owns an `envMap`. Everything in this
 * project inherits `scene.environment`, so every authored intensity was being
 * overwritten by the scene-wide `scene.environmentIntensity` and the object was
 * still lit, which is why nobody noticed for twenty cases.
 * `src/systems/lightEnvBinding.ts` binds the environment onto every standard
 * material and folds the scene intensity in.
 *
 * The failure mode is silence, so "it should work now" is not evidence. For
 * each system this runs four staged captures against one pose:
 *
 *   control    nothing changed, captured twice          must be ~0% (noise floor)
 *   bound x4   every intensity in the system x4         must move pixels
 *   unbound x4 the same x4 with the binder suspended    must NOT move pixels
 *              and material.envMap nulled - i.e. the      (this is the bug,
 *              exact pre-fix state, reproduced live)      reproduced on demand)
 *   restored   authored values put back                 must be ~0% again
 *
 * The `unbound` row is the part that makes a green run mean something: it is a
 * control that has to fail. A probe that cannot fail is not evidence.
 *
 *   node tools/envbind.mjs [--no-build] [--systems car,building,pumps]
 *
 * Teardown contract as tools/carenv.mjs: every exit path closes the browser and
 * the preview server, nothing is detached, and the process always ends in an
 * explicit process.exit(). Uses its own port and build directory so it can run
 * alongside other agents' harnesses.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5127;
const BUILD_DIR = ".shot-build/envbind";
const OUT = path.join(ROOT, "shots", "envbind");
const DO_BUILD = !process.argv.includes("--no-build");
const FACTOR = 4;

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SYSTEMS = argOf("--systems", "car,building,pumps,terrain,vegetation").split(",").filter(Boolean);

const resources = { server: null, browser: null };
let shuttingDown = false;

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[envbind] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[envbind] browser close failed: ${e?.message ?? e}`);
  }
  try {
    const s = resources.server;
    if (s?.httpServer) await new Promise((res) => s.httpServer.close(res));
  } catch (e) {
    console.error(`[envbind] server close failed: ${e?.message ?? e}`);
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void shutdown(1, sig));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? String(e)));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? String(e)));

/* ------------------------------------------------------------------ */
/* page-side. Self-contained: these are serialised across.             */
/* ------------------------------------------------------------------ */

const SETTLE = () =>
  new Promise((res) => {
    let n = 0;
    const t = () => (++n < 10 ? requestAnimationFrame(t) : res());
    requestAnimationFrame(t);
  });

/** Build the per-system material registry once, on `window.__ENVTEST`. */
const SETUP = () => {
  const g = window.__GAME;
  if (!g) return { error: "window.__GAME missing" };
  const scene = g.scene;

  const roots = {};
  const car = g.tryGet("car.parked");
  if (car?.root) roots.car = [car.root];
  const building = g.tryGet("building.root");
  if (building) roots.building = [building];
  const pumps = g.tryGet("pumps");
  if (pumps?.length) roots.pumps = pumps.map((p) => p.root).filter(Boolean);

  // Terrain and vegetation publish no root object, so find their scene-level
  // group by a mesh name only they create.
  const byDescendant = (name) => {
    for (const child of scene.children) {
      let found = false;
      child.traverse((o) => {
        if (o.name === name) found = true;
      });
      if (found) return [child];
    }
    return null;
  };
  const terrain = byDescendant("forecourt-slabs");
  if (terrain) roots.terrain = terrain;
  const veg = byDescendant("veg-pine-wood");
  if (veg) roots.vegetation = veg;

  const collect = (system) => {
    const seen = new Set();
    const out = [];
    for (const r of roots[system] ?? []) {
      r.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const one of Array.isArray(m) ? m : [m]) {
          if (one?.isMeshStandardMaterial && !seen.has(one)) {
            seen.add(one);
            out.push(one);
          }
        }
      });
    }
    return out;
  };

  window.__ENVTEST = { roots, collect, saved: null };

  const summary = {};
  for (const k of Object.keys(roots)) {
    const mats = collect(k);
    const spread = mats.map((m) => m.envMapIntensity);
    summary[k] = {
      materials: mats.length,
      bound: mats.filter((m) => !!m.envMap).length,
      min: spread.length ? Math.min(...spread) : null,
      max: spread.length ? Math.max(...spread) : null,
    };
  }
  return { summary, envBind: window.__LIGHTING?.envBinding ?? null, sceneEnv: !!scene.environment };
};

/**
 * Is anything else authored-but-inert for the same structural reason?
 *
 * `envMapIntensity` was uniquely exposed because its gate (`material.envMap`)
 * is not what enables the feature (`scene.environment` is), so the gate could
 * be false while the effect was plainly visible. Every other conditionally
 * refreshed property in `WebGLMaterials` gates on its own enabler - no aoMap
 * means there is no ambient occlusion to scale - so authoring the dependent
 * without the gate is inert but also meaningless. This measures rather than
 * assumes it: it reports every material in the live scene that authors a
 * dependent away from its default while the gate is unsatisfied.
 */
const AUDIT = () => {
  const scene = window.__GAME.scene;
  const seen = new Set();
  const findings = [];
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  scene.traverse((o) => {
    const mm = o.material;
    if (!mm) return;
    for (const m of Array.isArray(mm) ? mm : [mm]) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const id = `${m.name || o.name || m.type}`;
      const flag = (prop, gate, value) => findings.push({ id, prop, gate, value });

      // gate: the field three tests before refreshing the dependent uniform
      if (m.envMapIntensity !== undefined && !near(m.envMapIntensity, 1) && !m.envMap)
        flag("envMapIntensity", "material.envMap", m.envMapIntensity);
      if (m.aoMapIntensity !== undefined && !near(m.aoMapIntensity, 1) && !m.aoMap)
        flag("aoMapIntensity", "material.aoMap", m.aoMapIntensity);
      if (m.lightMapIntensity !== undefined && !near(m.lightMapIntensity, 1) && !m.lightMap)
        flag("lightMapIntensity", "material.lightMap", m.lightMapIntensity);
      if (m.bumpScale !== undefined && !near(m.bumpScale, 1) && !m.bumpMap)
        flag("bumpScale", "material.bumpMap", m.bumpScale);
      if (m.displacementScale !== undefined && !near(m.displacementScale, 1) && !m.displacementMap)
        flag("displacementScale", "material.displacementMap", m.displacementScale);
      if (m.normalScale && !m.normalMap && !(near(m.normalScale.x, 1) && near(m.normalScale.y, 1)))
        flag("normalScale", "material.normalMap", `${m.normalScale.x},${m.normalScale.y}`);
      if (m.isMeshPhysicalMaterial) {
        if (m.sheen === 0 && !near(m.sheenRoughness, 1)) flag("sheenRoughness", "material.sheen > 0", m.sheenRoughness);
        if (m.clearcoat === 0 && !near(m.clearcoatRoughness, 0))
          flag("clearcoatRoughness", "material.clearcoat > 0", m.clearcoatRoughness);
        if (m.iridescence === 0 && !near(m.iridescenceIOR, 1.3))
          flag("iridescenceIOR", "material.iridescence > 0", m.iridescenceIOR);
        if (m.transmission === 0 && !near(m.thickness, 0)) flag("thickness", "material.transmission > 0", m.thickness);
        if (m.transmission === 0 && Number.isFinite(m.attenuationDistance))
          flag("attenuationDistance", "material.transmission > 0", m.attenuationDistance);
        if (m.anisotropy === 0 && !near(m.anisotropyRotation, 0))
          flag("anisotropyRotation", "material.anisotropy > 0", m.anisotropyRotation);
      }
    }
  });
  return { materials: seen.size, findings };
};

const POSE = (p) => {
  const g = window.__GAME;
  const ground = g.tryGet("groundHeight");
  const cam = g.camera;
  const Vec = cam.position.constructor;

  if (p.local) {
    const car = g.tryGet("car.parked");
    if (!car) return { ok: false, why: "no car.parked" };
    car.root.updateMatrixWorld(true);
    const world = new Vec(p.pos[0], p.pos[1], p.pos[2]).applyMatrix4(car.root.matrixWorld);
    const target = new Vec(p.look[0], p.look[1], p.look[2]).applyMatrix4(car.root.matrixWorld);
    cam.position.copy(world);
    cam.lookAt(target);
  } else {
    const y0 = p.posGround && ground ? ground(p.pos[0], p.pos[2]) : 0;
    const y1 = p.lookGround && ground ? ground(p.look[0], p.look[2]) : 0;
    cam.position.set(p.pos[0], y0 + p.pos[1], p.pos[2]);
    cam.lookAt(new Vec(p.look[0], y1 + p.look[1], p.look[2]));
  }
  cam.fov = p.fov;
  cam.updateProjectionMatrix();
  return { ok: true, pos: [cam.position.x, cam.position.y, cam.position.z] };
};

/**
 * Stage one variant. `unbind` reproduces the pre-fix state exactly: suspend the
 * binder so it cannot put the environment back, then null each material's own
 * envMap, which is what sends three down the `scene.environmentIntensity`
 * branch and discards the authored number.
 */
const FORCE = ({ system, factor, unbind }) => {
  const t = window.__ENVTEST;
  const binding = window.__GAME.tryGet("environmentBinding");
  if (!binding) return { ok: false, why: "no environmentBinding service" };
  const mats = t.collect(system);
  if (!mats.length) return { ok: false, why: `no standard materials under ${system}` };

  // Exact snapshot, restored byte for byte. The binder treats any value it did
  // not itself write as a new authored value, so an approximate restore would
  // permanently retune the system.
  t.saved = mats.map((m) => ({ m, intensity: m.envMapIntensity, envMap: m.envMap }));
  if (unbind) binding.dispose();
  for (const m of mats) {
    m.envMapIntensity = m.envMapIntensity * factor;
    if (unbind) m.envMap = null;
  }
  return {
    ok: true,
    n: mats.length,
    unbind: !!unbind,
    ownEnvMap: mats.filter((m) => !!m.envMap).length,
    sample: mats.slice(0, 4).map((m) => Number(m.envMapIntensity.toFixed(3))),
  };
};

/** Scale in place without disturbing FORCE's snapshot. */
const SCALE = ({ system, factor }) => {
  const mats = window.__ENVTEST.collect(system);
  for (const m of mats) m.envMapIntensity = m.envMapIntensity * factor;
  return { ok: true, n: mats.length, sample: mats.slice(0, 4).map((m) => Number(m.envMapIntensity.toFixed(3))) };
};

const RESTORE = () => {
  const t = window.__ENVTEST;
  const binding = window.__GAME.tryGet("environmentBinding");
  for (const s of t.saved ?? []) {
    s.m.envMapIntensity = s.intensity;
    s.m.envMap = s.envMap;
  }
  const n = t.saved?.length ?? 0;
  t.saved = null;
  binding.install(); // no-op unless FORCE suspended it
  return { ok: true, n };
};

/* ------------------------------------------------------------------ */

async function diff(a, b) {
  const { PNG } = await import("pngjs");
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) throw new Error("frame size changed mid-run");
  let changed = 0;
  let sum = 0;
  let max = 0;
  const n = pa.width * pa.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(pa.data[o] - pb.data[o]),
      Math.abs(pa.data[o + 1] - pb.data[o + 1]),
      Math.abs(pa.data[o + 2] - pb.data[o + 2])
    );
    // >2 rather than >0: temporal dither and tone-map rounding put a handful of
    // 1-2 LSB pixels between two captures of an unchanged frame.
    if (d > 2) changed++;
    sum += d;
    if (d > max) max = d;
  }
  return { pct: (100 * changed) / n, mean: sum / n, max };
}

const POSES = {
  car: { local: true, pos: [2.75, 1.32, 4.85], look: [0, 0.7, 0.3], fov: 40 },
  building: { pos: [12.4, 1.68, 26.0], posGround: true, look: [-2.2, 2.7, 34.8], lookGround: true, fov: 46 },
  pumps: { pos: [-10.4, 1.64, 11.4], posGround: true, look: [1.0, 0.4, 17.4], fov: 48 },
  terrain: { pos: [19.0, 1.65, 36.4], posGround: true, look: [-2.0, 1.2, 18.0], fov: 52 },
  vegetation: { pos: [-46, 12.5, -24], look: [3, 0.4, 25], fov: 46 },
};

async function runSystem(page, system) {
  const pose = POSES[system];
  if (!pose) return { system, skipped: "no pose" };
  await page.evaluate(POSE, pose);
  await page.evaluate(SETTLE);

  const shot = async (tag) => {
    await page.evaluate(SETTLE);
    const buf = await page.screenshot({ type: "png" });
    await fs.writeFile(path.join(OUT, `${system}_${tag}.png`), buf);
    return buf;
  };

  const base = await shot("base");
  const control = await shot("control");

  const boundState = await page.evaluate(FORCE, { system, factor: FACTOR, unbind: false });
  if (!boundState.ok) return { system, skipped: boundState.why };
  const bound = await shot(`bound_x${FACTOR}`);
  await page.evaluate(RESTORE);
  const restored = await shot("restored");

  // Reproduce the pre-fix state and stage the same x4 inside it. Both frames
  // are pre-fix, so the pair isolates the knob rather than the fix: if this
  // moves, the harness is measuring something other than envMapIntensity.
  await page.evaluate(FORCE, { system, factor: 1, unbind: true });
  const preFix = await shot("prefix_x1");
  await page.evaluate(SCALE, { system, factor: FACTOR });
  const preFixForced = await shot(`prefix_x${FACTOR}`);
  await page.evaluate(RESTORE);
  const restored2 = await shot("restored2");

  return {
    system,
    boundState,
    rows: [
      ["control (no change)", await diff(base, control), "~0"],
      [`bound x${FACTOR}`, await diff(base, bound), ">0"],
      [`pre-fix x1 vs x${FACTOR}`, await diff(preFix, preFixForced), "~0"],
      ["restored", await diff(base, restored), "~0"],
      ["restored after unbind", await diff(base, restored2), "~0"],
    ],
    // Not pass/fail: how much of the frame the fix itself moves, i.e. what
    // authored intensities do that a flat scene-wide 1.0 did not.
    impact: await diff(preFix, base),
  };
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[envbind] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  console.log(`[envbind] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "envbind" });
  await gpuPage.close();

  await fs.mkdir(OUT, { recursive: true });
  const sceneKnobFailures = [];

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
  // `?shot=` is what disables PlayerSystem. Without it the player keeps
  // re-seating the camera at eye height every frame and two captures of an
  // unchanged scene differ by tens of percent - the first run of this harness
  // failed its own no-change control that way, which is the only reason the
  // control is here.
  await page.goto(`${base}?shot=wide&gpu=1`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await page.evaluate(SETTLE);

  const setup = await page.evaluate(SETUP);
  const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);

  console.log(`\n${"=".repeat(78)}\nBINDING\n${"=".repeat(78)}`);
  console.log(`  scene.environment: ${setup.sceneEnv}   __SYSTEM_ERRORS: ${sysErrs.length}`);
  if (sysErrs.length) console.log(`  ${JSON.stringify(sysErrs).slice(0, 400)}`);
  console.log(`  envBinding: ${JSON.stringify(setup.envBind)}`);
  console.log(`  ${"system".padEnd(12)} ${"materials".padEnd(10)} ${"own envMap".padEnd(11)} authored range`);
  for (const [k, v] of Object.entries(setup.summary ?? {})) {
    console.log(
      `  ${k.padEnd(12)} ${String(v.materials).padEnd(10)} ${String(v.bound).padEnd(11)} ${v.min} .. ${v.max}`
    );
  }

  const audit = await page.evaluate(AUDIT);
  console.log(`\n${"=".repeat(78)}\nSAME-SHAPE AUDIT   (dependent authored, gate unsatisfied)\n${"=".repeat(78)}`);
  console.log(`  ${audit.materials} materials examined`);
  if (audit.findings.length === 0) {
    console.log(`  no other authored-but-inert property found`);
  } else {
    for (const f of audit.findings) console.log(`  ${f.id.padEnd(28)} ${f.prop.padEnd(20)} = ${f.value}   gate ${f.gate} is false`);
  }

  const results = [];
  for (const s of SYSTEMS) results.push(await runSystem(page, s));
  await page.close();

  // The fix takes `scene.environmentIntensity` out of the path for a bound
  // material and folds it in by hand instead, so the lighting system's own
  // scene-wide knobs have to be re-proved. Three loads of the same pose.
  const sceneKnob = [];
  for (const [label, query] of [
    ["env=1 (baseline)", "shot=wide&gpu=1"],
    ["env=2", "shot=wide&gpu=1&env=2"],
    ["lforce=noenv", "shot=wide&gpu=1&lforce=noenv"],
  ]) {
    const p = await context.newPage();
    await p.goto(`${base}?${query}`, { waitUntil: "load", timeout: 60_000 });
    await p.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
    await p.evaluate(SETTLE);
    const buf = await p.screenshot({ type: "png" });
    await fs.writeFile(path.join(OUT, `scene_${label.split(" ")[0].replace(/[^a-z0-9=]/gi, "")}.png`), buf);
    const intensity = await p.evaluate(() => window.__LIGHTING?.envBinding?.intensity ?? null);
    await p.close();
    sceneKnob.push({ label, buf, intensity });
  }
  console.log(`\n${"=".repeat(78)}\nSCENE-WIDE INTENSITY STILL APPLIES\n${"=".repeat(78)}`);
  for (const k of sceneKnob.slice(1)) {
    const d = await diff(sceneKnob[0].buf, k.buf);
    const ok = d.pct > 0.05;
    if (!ok) sceneKnobFailures.push(k.label);
    console.log(
      `  ${k.label.padEnd(18)} folded intensity ${String(k.intensity).padEnd(5)} ${d.pct
        .toFixed(2)
        .padStart(6)}% changed   mean ${d.mean.toFixed(2)}   ${ok ? "ok" : "*** FAIL - knob is dead ***"}`
    );
  }

  let bad = sceneKnobFailures.length;
  console.log(`\n${"=".repeat(78)}\nFORCED DIFF PER SYSTEM   (x${FACTOR} on every envMapIntensity in the system)\n${"=".repeat(78)}`);
  for (const r of results) {
    if (r.skipped) {
      console.log(`\n  ${r.system}: SKIPPED - ${r.skipped}`);
      continue;
    }
    console.log(
      `\n  ${r.system}  (${r.boundState.n} materials, e.g. ${JSON.stringify(r.boundState.sample)} after x${FACTOR})`
    );
    for (const [label, d, want] of r.rows) {
      const moved = d.pct > 0.05;
      const ok = want === ">0" ? moved : !moved;
      if (!ok) bad++;
      console.log(
        `    ${label.padEnd(26)} ${d.pct.toFixed(2).padStart(6)}% changed   mean ${d.mean
          .toFixed(2)
          .padStart(5)}  max ${String(d.max).padStart(3)}   want ${want.padEnd(3)} ${ok ? "ok" : "*** FAIL ***"}`
      );
    }
    console.log(
      `    ${"[fix impact vs pre-fix]".padEnd(26)} ${r.impact.pct.toFixed(2).padStart(6)}% changed   mean ${r.impact.mean
        .toFixed(2)
        .padStart(5)}  max ${String(r.impact.max).padStart(3)}   (informational)`
    );
  }

  console.log(`\n  PNGs: shots/envbind/<system>_<variant>.png`);
  if (consoleErrors.length) console.log(`  console errors: ${consoleErrors.length}  first: ${consoleErrors[0]}`);
  const fatal = bad > 0 || sysErrs.length > 0;
  console.log(`\n  ${fatal ? `*** ${bad} expectation(s) failed, ${sysErrs.length} system error(s) ***` : "all systems: envMapIntensity is live"}`);

  await context.close();
  await shutdown(fatal ? 1 : 0, null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
