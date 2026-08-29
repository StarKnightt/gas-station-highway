#!/usr/bin/env node
/**
 * Is there an environment map at capture time, and is it black?
 *
 * This exists because a critic reported the car as "matte plastic... no
 * environment reflection whatsoever", and every other thing it got wrong in the
 * same pass fails in the direction you would expect from a missing IBL: lamp
 * lenses flatten to coloured shapes, a metalness-0.72 wheel goes dark, and a
 * grime gradient has no reflection variation left to modulate. Meanwhile the
 * geometry underneath all of it measures correct on the CPU. That combination
 * is either a black environment or a genuine surfacing failure, and those have
 * nothing in common as fixes.
 *
 * NOTES.md case 1 is exactly this bug: `PMREMGenerator.fromScene()` on a default
 * 0.1-100 m camera against a 1200 m sky dome captured nothing and reported
 * nothing. A black environment is not a shader error, so it never reaches
 * `__SYSTEM_ERRORS` and a green manifest does not rule it out.
 *
 * Two independent measurements, because either alone has an excuse:
 *
 *   1. Raw GL readback of the PMREM texels. Definitive about the texture, but
 *      says nothing about whether the car's materials are wired to it.
 *   2. A forced mirror: the car's own paint material is set to a perfect
 *      chrome in place and re-rendered. If the environment is live the car
 *      becomes a bright picture of the sky. This is the project's own
 *      forced-value technique, and it tests the whole path - texture, binding,
 *      material, and the onBeforeCompile patches - in one shot.
 *
 * Both are run on the capture query string AND on the app's normal entry path,
 * because "black only in the harness" and "black everywhere" are different bugs.
 *
 *   node tools/carenv.mjs [--no-build]
 *
 * Teardown contract as tools/shootcar.mjs: every exit path closes the browser
 * and the preview server, nothing is detached, and the process always ends in
 * an explicit process.exit().
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5116;
const BUILD_DIR = ".shot-build/car";
const OUT = path.join(ROOT, "shots", "car", "env");
const DO_BUILD = !process.argv.includes("--no-build");

const resources = { server: null, browser: null };
let shuttingDown = false;

async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[carenv] shutting down: ${reason}`);
  try {
    if (resources.browser) await resources.browser.close();
  } catch (e) {
    console.error(`[carenv] browser close failed: ${e?.message ?? e}`);
  }
  try {
    const s = resources.server;
    if (s?.httpServer) await new Promise((res) => s.httpServer.close(res));
  } catch (e) {
    console.error(`[carenv] server close failed: ${e?.message ?? e}`);
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void shutdown(1, sig));
process.on("uncaughtException", (e) => void shutdown(1, e?.stack ?? String(e)));
process.on("unhandledRejection", (e) => void shutdown(1, e?.stack ?? String(e)));

/* ------------------------------------------------------------------ */
/* page-side probes. Self-contained: they are serialised across.       */
/* ------------------------------------------------------------------ */

const INSPECT = () => {
  const g = window.__GAME;
  if (!g) return { error: "window.__GAME missing" };
  const scene = g.scene;
  const renderer = g.renderer;
  const env = scene.environment;

  const out = {
    hasEnvironment: !!env,
    background: scene.background ? scene.background.constructor.name : null,
    lighting: window.__LIGHTING ?? null,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
  };

  if (env) {
    out.env = {
      type: env.constructor.name,
      mapping: env.mapping,
      width: env.image?.width ?? null,
      height: env.image?.height ?? null,
    };

    // Raw GL readback. The PMREM result is a plain 2D texture in CubeUV layout
    // living in a render target, so binding its GL handle to a framebuffer and
    // reading pixels is the shortest honest path to "is it black" - and it
    // needs no THREE classes, which the built bundle does not expose.
    try {
      const gl = renderer.getContext();
      const props = renderer.properties.get(env);
      const tex = props?.__webglTexture;
      if (!tex) {
        out.texelError = "texture has no __webglTexture yet (never uploaded/bound)";
      } else {
        const fb = gl.createFramebuffer();
        const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          out.texelError = `framebuffer incomplete (0x${status.toString(16)})`;
        } else {
          const W = Math.min(64, env.image?.width ?? 64);
          const H = Math.min(64, env.image?.height ?? 64);
          const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
          let lum = [];
          if (readType === gl.FLOAT) {
            const buf = new Float32Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
            for (let i = 0; i < W * H; i++)
              lum.push(0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2]);
            out.readAs = "FLOAT";
          } else if (readType === gl.HALF_FLOAT || readType === 0x8d61) {
            const buf = new Uint16Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, readType, buf);
            const h2f = (h) => {
              const s = (h & 0x8000) >> 15;
              const e = (h & 0x7c00) >> 10;
              const f = h & 0x03ff;
              if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
              if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
              return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
            };
            for (let i = 0; i < W * H; i++)
              lum.push(0.2126 * h2f(buf[i * 4]) + 0.7152 * h2f(buf[i * 4 + 1]) + 0.0722 * h2f(buf[i * 4 + 2]));
            out.readAs = "HALF_FLOAT";
          } else {
            const buf = new Uint8Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            for (let i = 0; i < W * H; i++)
              lum.push((0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2]) / 255);
            out.readAs = "UNSIGNED_BYTE";
          }
          const err = gl.getError();
          if (err) out.glError = `0x${err.toString(16)}`;
          lum = lum.filter((v) => Number.isFinite(v));
          out.texels = {
            n: lum.length,
            mean: lum.reduce((a, b) => a + b, 0) / Math.max(1, lum.length),
            max: lum.reduce((a, b) => Math.max(a, b), 0),
            nonZeroPct: (100 * lum.filter((v) => v > 1e-5).length) / Math.max(1, lum.length),
          };
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
        gl.deleteFramebuffer(fb);
      }
    } catch (e) {
      out.texelError = e?.message ?? String(e);
    }
  }

  // What the car's materials would do with an environment if they had one.
  const car = g.tryGet ? g.tryGet("car.parked") : null;
  if (car) {
    const seen = new Set();
    const mats = [];
    car.root.traverse((o) => {
      if (!o.isMesh || !o.material || seen.has(o.material.uuid)) return;
      seen.add(o.material.uuid);
      const m = o.material;
      mats.push({
        name: (m.name || o.name || m.type).slice(0, 22),
        type: m.type,
        envMapIntensity: m.envMapIntensity ?? null,
        ownEnvMap: !!m.envMap,
        clearcoat: m.clearcoat ?? null,
        roughness: m.roughness ?? null,
        metalness: m.metalness ?? null,
      });
    });
    out.carMaterials = mats;
  }
  return out;
};

/**
 * Read the whole PMREM back and tone-map it to 8-bit, so the environment can be
 * *looked at* rather than inferred from the car.
 *
 * This is the measurement that separates "the paint ignores the environment"
 * from "the environment has nothing in it to reflect". A material can take a
 * large mean-luminance change from an environment while showing no structured
 * reflection at all, if what it samples is a smooth low-order gradient - so
 * flank mean 24.5 -> 119.0 and "no horizon band" are perfectly compatible.
 *
 * The CubeUV layout stacks the roughness mips: the top band is the sharpest,
 * each band below is blurrier. If the sharp band has a horizon and the blurry
 * ones do not, the fix is roughness. If none of them do, the capture is missing
 * the world and that is a Lighting problem, not a paint one.
 */
const DUMP_ENV = () => {
  const g = window.__GAME;
  const renderer = g.renderer;
  const env = g.scene.environment;
  if (!env) return { error: "no scene.environment" };
  const gl = renderer.getContext();
  const tex = renderer.properties.get(env)?.__webglTexture;
  if (!tex) return { error: "no __webglTexture" };

  const W = env.image?.width ?? 768;
  const H = env.image?.height ?? 1024;
  const fb = gl.createFramebuffer();
  const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    return { error: "framebuffer incomplete" };
  }
  const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  const buf = readType === gl.FLOAT ? new Float32Array(W * H * 4) : new Uint16Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, readType, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
  gl.deleteFramebuffer(fb);

  const h2f = (h) => {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const val = readType === gl.FLOAT ? (i) => buf[i] : (i) => h2f(buf[i]);

  // Reinhard plus gamma, and flipped: readPixels is bottom-up.
  const out = new Uint8Array(W * H * 3);
  let maxL = 0;
  for (let i = 0; i < W * H; i++) {
    const l = 0.2126 * val(i * 4) + 0.7152 * val(i * 4 + 1) + 0.0722 * val(i * 4 + 2);
    if (Number.isFinite(l) && l > maxL) maxL = l;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((H - 1 - y) * W + x) * 4;
      const dst = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = Math.max(0, val(src + c));
        out[dst + c] = Math.round(255 * Math.pow(v / (1 + v), 1 / 2.2));
      }
    }
  }
  let bin = "";
  for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode(...out.subarray(i, i + 8192));
  return { w: W, h: H, maxLuminance: maxL, b64: btoa(bin) };
};

/** Turn the car's paint into a perfect mirror, in place. */
const FORCE_MIRROR = () => {
  const g = window.__GAME;
  const car = g?.tryGet ? g.tryGet("car.parked") : null;
  if (!car) return { ok: false, why: "no car.parked" };
  let n = 0;
  const seen = new Set();
  car.root.traverse((o) => {
    if (!o.isMesh || !o.material || seen.has(o.material.uuid)) return;
    seen.add(o.material.uuid);
    const m = o.material;
    if (m.metalness === undefined) return;
    m.color?.set(0xffffff);
    m.metalness = 1;
    m.roughness = 0;
    m.envMapIntensity = 1;
    if (m.clearcoat !== undefined) m.clearcoat = 0;
    if (m.map) m.map = null;
    if (m.roughnessMap) m.roughnessMap = null;
    if (m.normalMap) m.normalMap = null;
    m.needsUpdate = true;
    n++;
  });
  return { ok: true, materials: n };
};

const POSE = (p) => {
  const g = window.__GAME;
  const car = g?.tryGet ? g.tryGet("car.parked") : null;
  if (!car) return { ok: false };
  const THREEVec = car.root.position.constructor;
  const local = new THREEVec(p.pos[0], p.pos[1], p.pos[2]);
  const look = new THREEVec(p.look[0], p.look[1], p.look[2]);
  car.root.updateMatrixWorld(true);
  const world = local.clone().applyMatrix4(car.root.matrixWorld);
  const target = look.clone().applyMatrix4(car.root.matrixWorld);
  const cam = g.camera;
  cam.position.copy(world);
  cam.lookAt(target);
  cam.fov = p.fov;
  cam.updateProjectionMatrix();
  return { ok: true, pos: [world.x, world.y, world.z] };
};

const SETTLE = () =>
  new Promise((res) => {
    let n = 0;
    const t = () => (++n < 12 ? requestAnimationFrame(t) : res());
    requestAnimationFrame(t);
  });

/**
 * Set one named variant of the paint material. Returns the resulting state so
 * the report can show what was actually in effect rather than what was asked
 * for - a value that silently fails to apply is the failure mode this whole
 * tool exists to catch.
 */
const VARIANT = (name) => {
  const g = window.__GAME;
  const car = g?.tryGet ? g.tryGet("car.parked") : null;
  if (!car) return { ok: false };
  let paint = null;
  car.root.traverse((o) => {
    if (o.isMesh && o.name === "car-body") paint = o.material;
  });
  if (!paint) return { ok: false, why: "car-body mesh not found" };

  const d = (paint.userData.carEnvBaseline ??= {
    color: paint.color.clone(),
    roughness: paint.roughness,
    metalness: paint.metalness,
    clearcoatRoughness: paint.clearcoatRoughness,
    envMapIntensity: paint.envMapIntensity,
    envMap: paint.envMap,
    roughnessMap: paint.roughnessMap,
    normalMap: paint.normalMap,
  });
  const w = paint.userData.carWeather;
  const wBase = (paint.userData.carEnvWeatherBaseline ??= w
    ? { dust: w.uWDust.value, film: w.uWFilm.value, rough: w.uWRough.value }
    : null);

  // Reset to authored values first, so variants never stack.
  paint.color.copy(d.color);
  paint.roughness = d.roughness;
  paint.metalness = d.metalness;
  paint.clearcoatRoughness = d.clearcoatRoughness;
  paint.envMapIntensity = d.envMapIntensity;
  paint.envMap = d.envMap;
  paint.roughnessMap = d.roughnessMap;
  paint.normalMap = d.normalMap;
  if (w && wBase) {
    w.uWDust.value = wBase.dust;
    w.uWFilm.value = wBase.film;
    w.uWRough.value = wBase.rough;
  }

  if (name === "rough_low") paint.roughness = 0.12;
  else if (name === "metal_zero") paint.metalness = 0.0;
  else if (name === "weather_rough_off" && w) w.uWRough.value = 0;
  else if (name === "weather_all_off" && w) {
    w.uWDust.value = 0;
    w.uWFilm.value = 0;
    w.uWRough.value = 0;
  } else if (name === "no_roughmap") paint.roughnessMap = null;
  else if (name === "combo") {
    paint.roughness = 0.14;
    paint.metalness = 0.0;
    paint.clearcoatRoughness = 0.04;
    if (w) w.uWRough.value = 0.1;
  }   // Paint candidates. The flank-mean metric favours metalness 0 - brighter and
  // a larger single-row step - but the frame it produces is a near-white car
  // with the blue washed out of it, so these exist to be looked at rather than
  // scored. Brighter is not better once the pigment stops reading.
  else if (name.startsWith("paint_")) {
    const [, m, e] = name.split("_");
    paint.metalness = Number(m) / 100;
    paint.envMapIntensity = Number(e) / 100;
  }
  // A perfect chrome at a ladder of roughnesses. Chrome because it shows the
  // environment undiluted by any base colour, so whatever structure survives at
  // the paint's own roughness is visible rather than inferred from the car.
  else if (name.startsWith("mirror_r")) {
    paint.color.set(0xffffff);
    paint.metalness = 1;
    paint.roughness = Number(name.slice(8)) / 100;
    paint.roughnessMap = null;
    paint.normalMap = null;
    paint.clearcoat = 0;
    if (w) {
      w.uWDust.value = 0;
      w.uWFilm.value = 0;
      w.uWRough.value = 0;
    }
  } else if (name === "env_off") paint.envMapIntensity = 0;
  else if (name === "env_x4") paint.envMapIntensity = 4;
  // Same two settings, but with the environment assigned to the material
  // rather than inherited from the scene. If these move and the two above do
  // not, `envMapIntensity` is only refreshed for materials that own an envMap.
  else if (name === "own_env_x1" || name === "own_env_x4") {
    paint.envMap = g.scene.environment;
    paint.envMapIntensity = name === "own_env_x4" ? 4 : 1;
  }
  else if (name === "MIRROR-control" || name === "MIRROR_env_off") {
    paint.color.set(0xffffff);
    if (name === "MIRROR_env_off") paint.envMapIntensity = 0;
    // Not a candidate setting - the control. If the metric cannot separate this
    // from the authored paint then the metric is wrong, not the paint.
    paint.roughness = 0;
    paint.metalness = 1;
    paint.roughnessMap = null;
    paint.normalMap = null;
    paint.clearcoatRoughness = 0;
    if (w) {
      w.uWDust.value = 0;
      w.uWFilm.value = 0;
      w.uWRough.value = 0;
    }
  }
  // `envMapIntensity` is a uniform and could in principle fail to refresh
  // without the environment itself being absent, so pull the environment out of
  // the scene as well. Nothing survives that if IBL is reaching the paint.
  const scene = g.scene;
  scene.userData.carEnvSaved ??= scene.environment;
  scene.environment = name === "SCENE_ENV_NULL" ? null : scene.userData.carEnvSaved;

  paint.needsUpdate = true;

  const props = g.renderer.properties.get(paint);
  return {
    ok: true,
    name,
    boundEnvMap: !!props?.envMap,
    boundEnvMapType: props?.envMap ? props.envMap.constructor.name : null,
    sceneEnv: !!scene.environment,
    roughness: paint.roughness,
    metalness: paint.metalness,
    clearcoatRoughness: paint.clearcoatRoughness,
    envMapIntensity: paint.envMapIntensity,
    roughnessMap: !!paint.roughnessMap,
    weather: w ? { dust: w.uWDust.value, film: w.uWFilm.value, rough: w.uWRough.value } : null,
  };
};

/* ------------------------------------------------------------------ */

async function meanLuminance(png) {
  const { PNG } = await import("pngjs");
  const p = PNG.sync.read(png);
  let sum = 0;
  let max = 0;
  let n = 0;
  // Centre band only: the sky and ground fill the edges of every frame and
  // would drown the car in the average.
  for (let y = Math.floor(p.height * 0.3); y < p.height * 0.75; y++) {
    for (let x = Math.floor(p.width * 0.25); x < p.width * 0.8; x++) {
      const i = (p.width * y + x) * 4;
      const l = 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
      sum += l;
      if (l > max) max = l;
      n++;
    }
  }
  return { mean: sum / n, max };
}

/**
 * Vertical luminance profile down the flank. A live reflection in smooth paint
 * puts a bright sky band on the upper third, a hard transition at the horizon,
 * and a dark ground reflection below - so the useful numbers are the top-to-
 * bottom range and the sharpest row-to-row step. Matte paint has neither: it is
 * a flat field whatever the environment is doing.
 */
async function flankProfile(png) {
  const { PNG } = await import("pngjs");
  const p = PNG.sync.read(png);
  // Rear door and quarter panel in the three-quarter front pose, from the
  // beltline down to the sill. Checked against shots/car/env/capture_normal.png
  // - the first cut of this window sat on the asphalt below the car, which is
  // why every variant returned an identical profile.
  const x0 = Math.floor(p.width * 0.56);
  const x1 = Math.floor(p.width * 0.7);
  const y0 = Math.floor(p.height * 0.4);
  const y1 = Math.floor(p.height * 0.58);
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) {
      const i = (p.width * y + x) * 4;
      s += 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
    }
    rows.push(s / (x1 - x0));
  }
  // Chroma as well as luminance. Metalness 0 scores best on every luminance
  // measure here and produces a near-white car, so a metric that cannot see the
  // pigment draining out of the paint is the wrong metric to tune against.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sat = 0;
  let np = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (p.width * y + x) * 4;
      const r = p.data[i];
      const g = p.data[i + 1];
      const b = p.data[i + 2];
      sr += r;
      sg += g;
      sb += b;
      const hi = Math.max(r, g, b);
      sat += hi > 0 ? (hi - Math.min(r, g, b)) / hi : 0;
      np++;
    }
  }
  let maxStep = 0;
  for (let i = 1; i < rows.length; i++) maxStep = Math.max(maxStep, Math.abs(rows[i] - rows[i - 1]));
  const min = Math.min(...rows);
  const max = Math.max(...rows);
  return {
    min,
    max,
    range: max - min,
    maxStep,
    mean: rows.reduce((a, b) => a + b, 0) / rows.length,
    sat: sat / np,
    bMinusR: (sb - sr) / np,
  };
}

async function isolate(context, base) {
  const page = await context.newPage();
  await page.goto(`${base}?shot=car&gpu=1`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await page.evaluate(SETTLE);
  // Three-quarter front, not the `side` preset: that one shoots the flank the
  // building shades, where nothing has an environment to reflect in the first
  // place and every variant would score the same for the wrong reason.
  await page.evaluate(POSE, { pos: [2.75, 1.32, 4.85], look: [0, 0.7, 0.3], fov: 40 });
  await page.evaluate(SETTLE);

  await fs.mkdir(OUT, { recursive: true });
  const names = process.argv.includes("--paint")
    ? ["paint_0_110", "paint_18_110", "paint_36_110", "paint_0_75", "paint_18_85", "paint_36_85"]
    : [
    "authored",
    "weather_rough_off",
    "weather_all_off",
    "no_roughmap",
    "metal_zero",
    "rough_low",
    "combo",
    "env_off",
    "env_x4",
    "MIRROR-control",
    "MIRROR_env_off",
    "SCENE_ENV_NULL",
    "own_env_x1",
    "own_env_x4",
      ];
  const rows = [];
  for (const n of names) {
    const state = await page.evaluate(VARIANT, n);
    await page.evaluate(SETTLE);
    const shot = await page.screenshot({ type: "png" });
    await fs.writeFile(path.join(OUT, `flank_${n}.png`), shot);
    rows.push({ n, state, prof: await flankProfile(shot) });
  }
  await page.close();

  console.log(`\n${"=".repeat(74)}\nWHICH KNOB KILLS THE REFLECTION   (side pose, flank luminance profile)\n${"=".repeat(74)}`);
  console.log(`  ${"variant".padEnd(19)} ${"rough".padEnd(6)} ${"metal".padEnd(6)} ${"wRough".padEnd(7)}  ${"range".padEnd(7)} ${"maxStep".padEnd(8)} mean`);
  for (const r of rows) {
    const s = r.state;
    console.log(
      `  ${r.n.padEnd(19)} ${String(s.roughness ?? "-").padEnd(6)} ${String(s.metalness ?? "-").padEnd(6)} ` +
        `${String(s.weather?.rough ?? "-").padEnd(7)}  ${r.prof.range.toFixed(1).padEnd(7)} ${r.prof.maxStep.toFixed(1).padEnd(8)} ${r.prof.mean.toFixed(1).padEnd(6)}` +
        ` envInt ${String(s.envMapIntensity).padEnd(4)} sat ${r.prof.sat.toFixed(3)} B-R ${r.prof.bMinusR.toFixed(1).padStart(6)}`
    );
  }
  console.log(`  PNGs: shots/car/env/flank_<variant>.png`);
  return rows;
}

/**
 * Sweep the live weathering hook. `__CAR_WEATHER` exists so intensity can be
 * dialled without a rebuild, and this is what it was built for: each capture
 * round costs about four minutes, and the question "does the sill read as
 * dirty" needs several values before it is answered.
 *
 * Reports the falloff from upper flank to sill. Grime should make that number
 * positive - the sill darker than the shoulder. The first raise made it
 * negative, i.e. brighter at the bottom, which is worth knowing: on a surface
 * low enough to be reflecting tarmac, raising roughness replaces a dark ground
 * reflection with blurred sky and lightens it. The received advice that
 * roughness reads as dirt without darkening holds for an upward-facing panel
 * and inverts for a rocker.
 */
async function weatherSweep(context, base) {
  const page = await context.newPage();
  await page.goto(`${base}?shot=car&gpu=1`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await page.evaluate(SETTLE);
  await page.evaluate(POSE, { pos: [5.4, 1.0, 1.65], look: [0, 0.74, -0.35], fov: 32 });
  await page.evaluate(SETTLE);
  await fs.mkdir(OUT, { recursive: true });

  const cases = [
    { film: 0.55, rough: 0.55, dust: 0.08 },
    { film: 0.74, rough: 0.66, dust: 0.08 },
    { film: 0.74, rough: 0.4, dust: 0.08 },
    { film: 0.95, rough: 0.4, dust: 0.08 },
    { film: 0.95, rough: 0.25, dust: 0.12 },
    { film: 1.2, rough: 0.25, dust: 0.12 },
  ];
  const { PNG } = await import("pngjs");
  console.log(`\n${"=".repeat(74)}\nWEATHERING SWEEP  (side_sun, live __CAR_WEATHER)\n${"=".repeat(74)}`);
  console.log(`  ${"film".padEnd(6)} ${"rough".padEnd(6)} ${"dust".padEnd(6)}  ${"upper".padEnd(7)} ${"sill".padEnd(7)} falloff`);
  for (const c of cases) {
    await page.evaluate((o) => window.__CAR_WEATHER(o), c);
    await page.evaluate(SETTLE);
    const shot = await page.screenshot({ type: "png" });
    await fs.writeFile(path.join(OUT, `weather_f${c.film}_r${c.rough}.png`), shot);
    const p = PNG.sync.read(shot);
    const band = (cy) => {
      let s = 0;
      let n = 0;
      for (let y = cy - 18; y <= cy + 18; y++)
        for (let x = 500; x <= 620; x++) {
          const i = (p.width * y + x) * 4;
          s += 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
          n++;
        }
      return s / n;
    };
    const upper = band(300);
    const sill = band(560);
    console.log(
      `  ${String(c.film).padEnd(6)} ${String(c.rough).padEnd(6)} ${String(c.dust).padEnd(6)}  ` +
        `${upper.toFixed(1).padEnd(7)} ${sill.toFixed(1).padEnd(7)} ${(100 * (1 - sill / upper)).toFixed(1)}%`
    );
  }
  await page.close();
}

async function probe(context, base, query, label) {
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => problems.push(String(e).slice(0, 160)));

  await page.goto(query ? `${base}?${query}` : base, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await page.evaluate(SETTLE);

  const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
  const inspect = await page.evaluate(INSPECT);

  // Mirror test, from the three-quarter front pose so the car fills the frame.
  let mirror = null;
  const posed = await page.evaluate(POSE, { pos: [2.75, 1.32, 4.85], look: [0, 0.7, 0.3], fov: 40 });
  if (posed.ok) {
    await page.evaluate(SETTLE);
    const before = await page.screenshot({ type: "png" });
    const forced = await page.evaluate(FORCE_MIRROR);
    await page.evaluate(SETTLE);
    const after = await page.screenshot({ type: "png" });
    const b = await meanLuminance(before);
    const a = await meanLuminance(after);
    mirror = { forced, before: b, after: a };
    await fs.mkdir(OUT, { recursive: true });
    const tag = query ? "capture" : "app";
    await fs.writeFile(path.join(OUT, `${tag}_normal.png`), before);
    await fs.writeFile(path.join(OUT, `${tag}_mirror.png`), after);
    mirror.files = [`shots/car/env/${tag}_normal.png`, `shots/car/env/${tag}_mirror.png`];
  }

  await page.close();
  return { label, query, inspect, sysErrs, problems, mirror };
}

function report({ label, query, inspect, sysErrs, problems, mirror }) {
  console.log(`\n${"=".repeat(74)}\n${label}\n${"=".repeat(74)}`);
  if (inspect.error) return void console.log(`  ERROR: ${inspect.error}`);

  console.log(`  scene.environment present : ${inspect.hasEnvironment}`);
  console.log(`  scene.background          : ${inspect.background}`);
  console.log(`  toneMapping / exposure    : ${inspect.toneMapping} / ${inspect.toneMappingExposure}`);
  if (inspect.env) console.log(`  env texture               : ${inspect.env.type} ${inspect.env.width}x${inspect.env.height}`);

  if (inspect.texels) {
    const t = inspect.texels;
    console.log(`\n  [1] PMREM TEXELS (read as ${inspect.readAs})`);
    console.log(`      mean ${t.mean.toFixed(5)}   max ${t.max.toFixed(4)}   non-zero ${t.nonZeroPct.toFixed(1)}%`);
    console.log(`      --> ${t.max < 1e-4 ? "*** ENVIRONMENT TEXTURE IS BLACK ***" : "texture carries light"}`);
  } else {
    console.log(`\n  [1] PMREM TEXELS  could not read: ${inspect.texelError ?? "n/a"}`);
  }

  if (mirror?.forced?.ok) {
    console.log(`\n  [2] FORCED MIRROR  (${mirror.forced.materials} materials -> metal 1, rough 0)`);
    console.log(`      before  mean ${mirror.before.mean.toFixed(1)}  max ${mirror.before.max.toFixed(0)}`);
    console.log(`      after   mean ${mirror.after.mean.toFixed(1)}  max ${mirror.after.max.toFixed(0)}`);
    const gain = mirror.after.mean / Math.max(0.01, mirror.before.mean);
    console.log(`      gain    ${gain.toFixed(2)}x`);
    console.log(
      `      --> ${
        mirror.after.max < 20
          ? "*** A PERFECT MIRROR RENDERS BLACK - no reflection reaches the paint ***"
          : "a mirror reflects something; the path to the paint is live"
      }`
    );
    console.log(`      ${mirror.files.join("   ")}`);
  }

  console.log(`\n  __LIGHTING: ${inspect.lighting ? JSON.stringify(inspect.lighting).slice(0, 400) : "ABSENT — lighting never published a report"}`);
  if (inspect.carMaterials) {
    console.log(`  car materials:`);
    for (const m of inspect.carMaterials)
      console.log(
        `    ${m.name.padEnd(24)} ${m.type.padEnd(21)} envInt ${String(m.envMapIntensity).padEnd(5)} own ${String(m.ownEnvMap).padEnd(5)}` +
          ` cc ${String(m.clearcoat).padEnd(5)} r ${String(m.roughness).padEnd(6)} m ${m.metalness}`
      );
  }
  console.log(`  __SYSTEM_ERRORS: ${sysErrs.length ? JSON.stringify(sysErrs).slice(0, 300) : "[]"}`);
  if (problems.length) console.log(`  console errors: ${problems.length}  first: ${problems[0]}`);
  void query;
}

async function envDump(context, base) {
  const page = await context.newPage();
  await page.goto(`${base}?shot=car&gpu=1`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 240_000 });
  await page.evaluate(SETTLE);
  await fs.mkdir(OUT, { recursive: true });

  const d = await page.evaluate(DUMP_ENV);
  console.log(`\n${"=".repeat(74)}\nWHAT IS ACTUALLY IN THE ENVIRONMENT\n${"=".repeat(74)}`);
  if (d.error) {
    console.log(`  could not read: ${d.error}`);
  } else {
    const { PNG } = await import("pngjs");
    const png = new PNG({ width: d.w, height: d.h });
    const raw = Buffer.from(d.b64, "base64");
    for (let i = 0; i < d.w * d.h; i++) {
      png.data[i * 4] = raw[i * 3];
      png.data[i * 4 + 1] = raw[i * 3 + 1];
      png.data[i * 4 + 2] = raw[i * 3 + 2];
      png.data[i * 4 + 3] = 255;
    }
    const dest = path.join(OUT, "pmrem.png");
    await fs.writeFile(dest, PNG.sync.write(png));
    console.log(`  PMREM ${d.w}x${d.h}  peak luminance ${d.maxLuminance.toFixed(2)}`);
    console.log(`  -> shots/car/env/pmrem.png   (CubeUV: sharpest mip at top, blurrier below)`);
  }

  // What survives at each roughness, on the car's own body.
  await page.evaluate(POSE, { pos: [2.75, 1.32, 4.85], look: [0, 0.7, 0.3], fov: 40 });
  await page.evaluate(SETTLE);
  console.log(`\n  chrome-at-roughness ladder, three-quarter front:`);
  for (const r of [0, 8, 16, 25, 42, 60]) {
    const n = `mirror_r${r}`;
    await page.evaluate(VARIANT, n);
    await page.evaluate(SETTLE);
    const shot = await page.screenshot({ type: "png" });
    await fs.writeFile(path.join(OUT, `${n}.png`), shot);
    const prof = await flankProfile(shot);
    console.log(
      `    roughness ${(r / 100).toFixed(2)}   flank range ${prof.range.toFixed(1).padStart(6)}` +
        `   largest single-row step ${prof.maxStep.toFixed(1).padStart(5)}`
    );
  }
  await page.close();
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[carenv] building...");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  console.log(`[carenv] starting preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({}));
  const context = await resources.browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

  const gpuPage = await context.newPage();
  await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertHardwareGpu(gpuPage, { tag: "carenv" });
  await gpuPage.close();

  if (!process.argv.includes("--isolate-only")) {
    report(await probe(context, base, "shot=car&gpu=1", "AS CAPTURED   shot=car&gpu=1   (what every round has shot)"));
    report(await probe(context, base, "", "AS THE APP RUNS   no query   (the real entry path)"));
  }
  if (process.argv.includes("--env-dump")) await envDump(context, base);
  else if (process.argv.includes("--weather")) await weatherSweep(context, base);
  else if (!process.argv.includes("--no-isolate")) await isolate(context, base);

  await context.close();
  await shutdown(0, null);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
