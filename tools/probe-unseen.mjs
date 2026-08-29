#!/usr/bin/env node
/**
 * Scene-wide hunt for meshes that are in the scene graph and draw nothing.
 *
 *   node tools/probe-unseen.mjs --port=5116
 *   node tools/probe-unseen.mjs --port=5116 --filter=car --no-build
 *   node tools/probe-unseen.mjs --port=5116 --selftest
 *
 * SHARED TOOLING. Any agent may run this against the whole scene; nothing in it
 * is car-specific. Pass your own `--port` and `--build-dir`.
 *
 * Why this exists
 * ---------------
 * NOTES case 33. A part can be present, merged, in spec, proud of the surface,
 * built with zero fallbacks and green under `tsc`, and still draw not one
 * pixel, because its triangles are wound backwards and back-face culling
 * removes it. Nothing in this project checks winding. Worse, "drew nothing" and
 * "drew something subtle" are the same capture, so the defect survives review
 * indefinitely: four rounds went into one of these, three of them spent on
 * hypotheses that were each correctly ruled out by a correct measurement of
 * something that was not the problem. Five parts in one fascia turned out to be
 * invisible, for three different reasons.
 *
 * Nothing here needs authored debug colours, and nothing needs coordinates from
 * the caller (NOTES case 28).
 *
 * How it decides, and why it is not an ID pass
 * -------------------------------------------
 * The obvious implementation renders every mesh in a unique flat colour and
 * counts. That measures a *substitute* scene: a flat unlit material has none of
 * the real material's alpha discard, none of its vertex displacement and none
 * of its blending, so it can report a mesh as visible that in truth contributes
 * nothing, and vice versa. It also silently answers "is my replacement material
 * visible" rather than "is this mesh visible".
 *
 * Instead this renders the real scene with the real materials, twice, toggling
 * only `mesh.visible`, and asks whether the frame changed:
 *
 *     does removing this mesh alter a single pixel?
 *
 * That is the definition of visible, not a proxy for it, and it is exactly as
 * true of an alpha-cut leaf card or a vertex-displaced billboard as of a solid
 * panel.
 *
 * Two renders with nothing changed between them must be bit-identical or the
 * comparison means nothing, so that control is run first and the tool refuses
 * to report anything if the scene is not deterministic (an animated material
 * with a clock uniform would otherwise show up as every mesh being visible).
 *
 * Each mesh is judged from its OWN best-case camera, not from a preset list.
 * Presets cannot be complete, and "not in any preset" is not the same finding
 * as "cannot be seen from anywhere". The camera is placed along the mesh's own
 * mean shading normal at a distance that makes its bounding sphere fill the
 * frame, so a part that draws nothing here draws nothing anywhere. Poses may
 * still be supplied with `--pose` when the question is coverage of a judged
 * view rather than existence.
 *
 * Naming the cause
 * ----------------
 * An alarm that says only "invisible" sends the reader back to inference, which
 * is the failure this tool exists to end. So each silent mesh is re-rendered
 * with one property forced at a time, and the property that brings it back is
 * the diagnosis:
 *
 *   HIDDEN      `visible` is false on it or on an ancestor.
 *   WINDING     appears with `side = DoubleSide`. Its triangles face away from
 *               its own shading normals. Never legitimate; always a bug.
 *   OCCLUDED    appears with `depthTest = false`. It is inside or behind other
 *               geometry. Legitimate for true internals, a bug for anything
 *               authored as a recess (a negative offset from a surface is only
 *               a recess if something has cut a hole in front of it).
 *   CULLED      appears with `frustumCulled = false`. Its bounding volume
 *               disagrees with where its vertices actually are.
 *   DEGENERATE  nothing brings it back: no area, zero scale, an instance count
 *               of zero, a fully discarded material.
 *
 * WINDING is the only one that is never defensible, so it alone fails the run
 * unless `--strict` is passed.
 *
 * !! FIXED 2026-08-29: EVERY `DEGENERATE` ON AN INSTANCED MESH BEFORE THIS DATE
 * !! IS SUSPECT. `aim()` framed the geometry bounding sphere under
 * !! `matrixWorld` and never applied `instanceMatrix`, so for an
 * !! `InstancedMesh` it pointed the camera at one copy's worth of empty space
 * !! near the group origin instead of at any instance. Nothing was in frame, so
 * !! nothing could be recovered by forcing, and the verdict came out DEGENERATE
 * !! with "nothing forced brings it back". It now aims at up to
 * !! `INSTANCE_SPOTS` real instances, each with its own direction.
 * !!
 * !! Vegetation caught it by auditing all 42 of its clump geometries on the CPU
 * !! after this tool accused eleven of them: zero no-area, zero null-normal,
 * !! zero reversed, minimum triangle area 1.1e-2 against a 1e-12 threshold. The
 * !! geometry was sound and the probe was not.
 * !!
 * !! The failure also masqueraded as an LOD bug, because instances scattered
 * !! near the origin landed in frame and read SEEN while ones 70-200 m out never
 * !! did, which correlates with distance without being about distance.
 * !!
 * !! Two ways to recognise it in an old report: a DEGENERATE on anything
 * !! instanced, and a "recovered" count of a handful of pixels, which is an
 * !! instance clipping the corner of frame by luck rather than a real recovery.
 * !! Car and Building both use this as a regression gate; re-run those gates.
 * !!
 * !! The general form is in NOTES.md: a probe that aims at a bounding volume
 * !! cannot isolate a mesh whose copies live in a transform the probe ignores.
 *
 * WHAT THIS CANNOT SEE
 * --------------------
 * Read this before filing anything it reports as a bug. Every item here was
 * found by the tool being wrong about the real scene, not by speculation.
 *
 * 1. A mesh pixel-for-pixel identical to whatever is behind it. By
 *    construction the frame is the same whether it draws or not, so it reports
 *    as silent. This is a property of the question, not of the implementation.
 *    Found the hard way: the selftest's own planted OCCLUDED quad came back
 *    DEGENERATE because the occluder in front of it was the same white
 *    material, so forcing the hidden quad in front changed nothing. The
 *    planted pair are now deliberately different colours, and the case is left
 *    in the selftest rather than removed, so the limit stays visible.
 *
 * 2. Shaders that key off apparent screen size. The first run reported
 *    twenty-five vegetation meshes as drawing nothing at all - foliage that is
 *    plainly present in every capture - because those shaders fade with
 *    on-screen scale and the camera had been placed right against them. Three
 *    distances are now tried, which cut it to thirteen, and the residue is
 *    still very probably the same interaction rather than a real defect.
 *    Anything vegetation-like in a DEGENERATE list deserves a human look
 *    before it is filed.
 *
 * 3. The difference between "buried by mistake" and "an internal part doing
 *    its job". An inner roof skin, a reflector behind a lens and a floor decal
 *    under another decal all report OCCLUDED and all are correct as authored.
 *    OCCLUDED is a prompt to check the intent, not a defect on its own. Only
 *    WINDING is never legitimate, which is why only WINDING fails the run.
 *
 * 4. Anything at all, if the scene does not render deterministically. That is
 *    why the determinism control runs first and refuses rather than warns.
 *
 * 5. Whether a mesh appears in the shots a critic will actually judge. This
 *    answers "can it be seen from anywhere", which is a strictly weaker
 *    question than "is it in frame in the poses that matter".
 *
 * Sibling coordinate-free probes: `tools/probe-zeroscan.mjs` (clamped-black
 * shading failures, whole frame) and `tools/carmask.mjs` (per-surface luminance
 * and boundary contrast from a debug-colour mask).
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(arg("port", process.env.DAWN_PORT ?? 5116));
const BUILD_DIR = arg("build-dir", ".shot-build/unseen");
const FILTER = arg("filter", "");
const QUERY = arg("query", "");
const RES = Number(arg("res", 220));
const LIMIT = Number(arg("limit", 0));
const DO_BUILD = !argv.includes("--no-build");
const STRICT = argv.includes("--strict");
/**
 * Regression gate. `--baseline=<file>` compares this run against a recorded
 * one and fails on any mesh that **was drawing and now is not**; `--record`
 * writes the file instead of checking it.
 *
 * This exists because the probe caught a regression nobody asked it to look
 * for. A body-section change hit every number it was designed to hit - the
 * lean halved, the profile straightened, the width held, no non-finite
 * vertices - and made the render worse, because the lower body moved out over
 * the wheels. The signal was three wheel caps that had been drawing going to
 * 0 px in the same pass.
 *
 * A drawing-to-zero transition is a good gate for the same reason a ranking
 * beats an absolute measurement: it needs no target and no threshold, so
 * there is nothing to argue about and nothing to tune. It does not ask whether
 * a mesh looks right, only whether it is still there, and absence is this
 * project's dominant defect class. Verdict changes among the already-silent
 * meshes are reported but do not fail - only the transition out of SEEN does.
 */
const BASELINE = arg("baseline", "");
/**
 * A bare `--baseline` used to parse to the empty string and silently skip the
 * gate, so the round passed by not being checked. That is the same defect shape
 * Terrain found in the zero-dimension capture: the check did not fail, it failed
 * to run, and the two are indistinguishable in the exit code. A gate that can be
 * disabled by a typo is not a gate.
 */
if (argv.includes("--baseline") && !BASELINE) {
  console.error("probe-unseen: --baseline needs a path, as --baseline=<file>. Refusing to run a gate with no baseline.");
  process.exit(2);
}
const RECORD = argv.includes("--record");
if (RECORD && !BASELINE) {
  console.error("probe-unseen: --record needs --baseline=<file> to record into.");
  process.exit(2);
}
const SELFTEST = argv.includes("--selftest");
const ALLOW_SOFTWARE = argv.includes("--allow-software");
const VERBOSE = argv.includes("--verbose");
const POSES = argv.filter((a) => a.startsWith("--pose=")).map((a) => a.slice(7));

const READY_TIMEOUT_MS = 240_000;
/** Meshes per page.evaluate. Small enough to show progress and to keep any one
 *  call well inside the default timeout on a scene with thousands of meshes. */
const BATCH = 40;

/* ------------------------------------------------------------------ */
/* teardown, wired before anything starts                              */
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
  if (reason) console.error(`\n[unseen] shutting down: ${reason}`);
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
      console.error(`[unseen] failed to close ${label}: ${err?.message ?? err}`);
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

function lowerPriority() {
  try {
    if (os.platform() !== "win32") process.setpriority?.(0, 10);
    else process.setpriority?.(0, os.constants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* best effort */
  }
}

async function waitForPort(port, budgetMs) {
  const net = await import("node:net");
  const free = () =>
    new Promise((resolve) => {
      const s = net.createConnection({ port, host: "127.0.0.1" });
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });
  const t0 = Date.now();
  for (;;) {
    if (await free()) return;
    if (Date.now() - t0 > budgetMs) throw new Error(`port ${port} still busy after ${budgetMs} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/* ------------------------------------------------------------------ */
/* the in-page probe                                                   */
/*                                                                     */
/* One self-contained source string, installed once. It deliberately   */
/* constructs nothing that needs the THREE namespace: every class it   */
/* needs for the selftest is reached through .constructor on an object */
/* already in the scene, and every enum it needs is a plain number or  */
/* string in three's public API (FrontSide 0 / DoubleSide 2,           */
/* NoToneMapping 0, 'srgb-linear'). Importing a second copy of three   */
/* into the page would be a different three than the app's.            */
/* ------------------------------------------------------------------ */

const INSTALL = /* js */ `
window.__PROBE_UNSEEN = (() => {
  const g = window.__GAME;
  if (!g) throw new Error("no window.__GAME");
  const scene = g.scene, renderer = g.renderer, camera = g.camera;
  if (!scene || !renderer || !camera) throw new Error("__GAME is missing scene/renderer/camera");
  const gl = renderer.getContext();

  let S = 220;
  let bufA = null, bufB = null;
  const saved = {};

  function enter(res) {
    /**
     * Reject a degenerate probe size rather than measure one.
     *
     * Terrain found a harness that wrote a 0x0 PNG and passed every health
     * assertion it had, because every check was a mean, the mean of no pixels
     * is NaN, and every comparison against NaN is false. This probe would have
     * failed *safely* at S = 0 - a zero-length buffer makes the diff loop never
     * run, every mesh reports 0 px and the gate fires - but failing safely by
     * accident is not the same as checking, and the next person to refactor the
     * diff has no way to know the property was ever relied on.
     */
    if (!Number.isFinite(res) || res < 8) {
      throw new Error("probe-unseen: probe resolution must be a finite size >= 8, got " + res);
    }
    S = res;
    bufA = new Uint8Array(S * S * 4);
    bufB = new Uint8Array(S * S * 4);
    if (bufA.length !== S * S * 4) {
      throw new Error("probe-unseen: pixel buffer is " + bufA.length + " bytes, expected " + S * S * 4);
    }
    // Read the canvas directly rather than renderer.getSize(), which wants a
    // Vector2 to write into and there is no THREE namespace in here.
    saved.ratio = renderer.getPixelRatio();
    saved.cssW = renderer.domElement.width / saved.ratio;
    saved.cssH = renderer.domElement.height / saved.ratio;
    saved.tone = renderer.toneMapping;
    saved.cs = renderer.outputColorSpace;
    saved.shadow = renderer.shadowMap.enabled;
    saved.cam = {
      p: camera.position.toArray(),
      q: camera.quaternion.toArray(),
      fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect,
    };
    renderer.setPixelRatio(1);
    renderer.setSize(S, S, false);
    // Shadow maps refit to the camera every frame. Leaving them on would make
    // the two renders of a pair disagree for reasons that have nothing to do
    // with the mesh under test, and the determinism control would fail.
    renderer.shadowMap.enabled = false;
  }

  function leave() {
    renderer.shadowMap.enabled = saved.shadow;
    renderer.setPixelRatio(saved.ratio);
    renderer.setSize(saved.cssW, saved.cssH, false);
    renderer.toneMapping = saved.tone;
    renderer.outputColorSpace = saved.cs;
    camera.position.fromArray(saved.cam.p);
    camera.quaternion.fromArray(saved.cam.q);
    camera.fov = saved.cam.fov; camera.near = saved.cam.near;
    camera.far = saved.cam.far; camera.aspect = saved.cam.aspect;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  }

  /** Render and read the backbuffer in the SAME synchronous task: the
   *  compositor cannot swap until this task yields, so the pixels are still
   *  there. Nothing here depends on preserveDrawingBuffer. */
  function shoot(buf) {
    renderer.render(scene, camera);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  const THRESH = 3;
  function diff(a, b) {
    // An empty comparison is not "no difference", it is "no measurement". A
    // count of 0 over 0 pixels is indistinguishable from a mesh that genuinely
    // drew nothing, and that ambiguity is the whole failure Terrain hit.
    if (!a.length || a.length !== b.length) {
      throw new Error("probe-unseen: comparing " + a.length + " bytes against " + b.length + " - nothing was captured");
    }
    let n = 0, worst = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > THRESH) n++;
      if (d > worst) worst = d;
    }
    return { px: n, worst };
  }

  /* ---------------- enumeration ---------------- */

  function pathOf(o) {
    const parts = [];
    for (let n = o; n && n !== scene; n = n.parent) parts.unshift(n.name || ("<" + n.type + ">"));
    return parts.join("/");
  }

  let items = null;

  function enumerate() {
    items = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      items.push({ obj: o, path: pathOf(o), name: o.name || "" });
    });
    // Stable order so a batch index means the same thing across calls.
    items.forEach((it, i) => { it.i = i; });
    return items.map((it) => ({
      i: it.i, path: it.path, name: it.name,
      type: it.obj.type,
      instances: it.obj.isInstancedMesh ? it.obj.count : null,
      tris: triCount(it.obj),
      unnamed: !it.name,
    }));
  }

  function triCount(o) {
    const geo = o.geometry;
    const n = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0);
    return Math.round((n / 3) * (o.isInstancedMesh ? o.count : 1));
  }

  /* ---------------- own-view camera ---------------- */

  /**
   * Mean shading normal in world space, and the world bounding sphere.
   *
   * The normal attribute says which way the surface is MEANT to face, and is
   * independent of the winding, which is the point: aim the camera where the
   * surface claims to face, and a mesh whose triangles disagree with its own
   * normals culls itself and is caught.
   *
   * A closed shell averages to nothing. That is reported rather than papered
   * over, and such a mesh is judged from whichever of six axis directions sees
   * most of it.
   */
  /**
   * SCATTERED INSTANCED MESHES: aim at an instance, not at the mesh bound.
   *
   * This function used to frame 'o.geometry.boundingSphere' transformed by
   * 'o.matrixWorld' and nothing else. For an 'InstancedMesh' that is the sphere
   * of ONE copy sitting at the geometry's local origin, because the per-instance
   * transforms live in 'instanceMatrix' and were never applied. So the camera
   * was placed to frame half a metre of empty space near the group origin, where
   * none of the instances are, the render came back empty, and forcing side, depth
   * and frustum could not recover it — because the object was never in frame at
   * all. The verdict printed was DEGENERATE, "nothing forced brings it back",
   * which is true and entirely about the probe.
   *
   * Vegetation measured this on eleven scrub meshes. A CPU audit of all 42 clump
   * geometries was clean — zero no-area, zero null-normal, zero reversed,
   * minimum triangle area 1.1e-2 against a 1e-12 threshold — so the meshes were
   * sound and the tool was not. The tell was three meshes "recovering" at 2 px
   * and 13 px: sub-pixel, i.e. an instance clipping the corner of frame by luck.
   *
   * It also explains why the failure looked like an LOD problem. Instances that
   * happen to be scattered near the local origin land in frame and read SEEN;
   * ones 70-200 m out never do. That correlates with distance without being
   * about distance, which is how it survived as "the far variants are broken".
   *
   * 'probe-unseen' is a regression gate for more than one system, so read this
   * before trusting a DEGENERATE on anything instanced from before this fix.
   *
   * Each candidate carries its own 'dir', derived from its own normal matrix.
   * Sharing one direction across instances would aim at the back of a rotated
   * copy and report WINDING — a false positive strictly worse than the false
   * DEGENERATE this replaces.
   */
  const INSTANCE_SPOTS = 6;

  function aim(o) {
    const geo = o.geometry;
    o.updateMatrixWorld(true);
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (!bs || !isFinite(bs.radius)) return null;

    let nx = 0, ny = 0, nz = 0, count = 0;
    const na = geo.attributes.normal;
    if (na) {
      const step = Math.max(1, Math.floor(na.count / 2048));
      for (let i = 0; i < na.count; i += step) {
        nx += na.getX(i); ny += na.getY(i); nz += na.getZ(i); count++;
      }
    }

    // Cloned from live objects rather than constructed, so this file stays free
    // of a THREE import the way it was written to be.
    const spotFor = (world) => {
      const c = bs.center.clone().applyMatrix4(world);
      const e = world.elements;
      const sx = Math.hypot(e[0], e[1], e[2]);
      const sy = Math.hypot(e[4], e[5], e[6]);
      const sz = Math.hypot(e[8], e[9], e[10]);
      const radius = Math.max(bs.radius * Math.max(sx, sy, sz), 1e-4);
      let dir = null;
      if (count) {
        const nm = o.normalMatrix.clone();
        nm.getNormalMatrix(world);
        const m = nm.elements;
        const vx = nx / count, vy = ny / count, vz = nz / count;
        const wx = m[0] * vx + m[3] * vy + m[6] * vz;
        const wy = m[1] * vx + m[4] * vy + m[7] * vz;
        const wz = m[2] * vx + m[5] * vy + m[8] * vz;
        const len = Math.hypot(wx, wy, wz);
        if (len > 0.15) dir = [wx / len, wy / len, wz / len];
      }
      return { center: [c.x, c.y, c.z], radius, dir };
    };

    const spots = [];
    if (o.isInstancedMesh && o.instanceMatrix && o.count > 0) {
      // Strided rather than the first N, because instances are usually written
      // in scatter order and the first few share a neighbourhood.
      const n = Math.min(INSTANCE_SPOTS, o.count);
      const stride = Math.max(1, Math.floor(o.count / n));
      const arr = o.instanceMatrix.array;
      for (let k = 0; k < n; k++) {
        const i = Math.min(o.count - 1, k * stride);
        const inst = o.matrixWorld.clone().fromArray(arr, i * 16);
        spots.push(spotFor(o.matrixWorld.clone().multiply(inst)));
      }
    }
    if (!spots.length) spots.push(spotFor(o.matrixWorld));

    const first = spots[0];
    return {
      center: first.center,
      radius: first.radius,
      dir: first.dir,
      ambiguous: !first.dir,
      spots,
      instanced: !!o.isInstancedMesh,
    };
  }

  const AXES = [[0,0,1],[0,0,-1],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0]];

  function place(center, radius, dir, mult) {
    const fov = 45;
    const dist = (radius / Math.tan((fov * Math.PI) / 360)) * mult;
    camera.fov = fov;
    camera.aspect = 1;
    camera.near = Math.max(1e-3, dist * 0.004);
    camera.far = dist + radius * 8 + 400;
    camera.up.set(0, 1, 0);
    // Straight down a world axis, camera.up is parallel to the view and lookAt
    // degenerates into an identity rotation pointing at the horizon, which
    // silently frames empty sky. Tilt up off-axis for those.
    if (Math.abs(dir[1]) > 0.999) camera.up.set(0, 0, 1);
    camera.position.set(center[0] + dir[0] * dist, center[1] + dir[1] * dist, center[2] + dir[2] * dist);
    camera.rotation.set(0, 0, 0);
    camera.lookAt(center[0], center[1], center[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /* ---------------- the test ---------------- */

  function hiddenBy(o) {
    for (let n = o; n && n !== scene; n = n.parent) if (!n.visible) return pathOf(n) || "<root>";
    return null;
  }

  /** Does toggling this mesh's visibility change the frame from here? */
  function contributes(o) {
    shoot(bufA);
    const was = o.visible;
    o.visible = false;
    shoot(bufB);
    o.visible = was;
    return diff(bufA, bufB);
  }

  /**
   * Distances, not just directions.
   *
   * The first version framed every mesh at 1.5 bounding-sphere radii and
   * reported twenty-five vegetation meshes as drawing nothing at all - foliage
   * that is plainly there in every capture. Those shaders scale and fade by
   * apparent screen size, so a camera shoved right up against them collapses
   * them to nothing. The probe was measuring its own camera placement.
   *
   * So a mesh is only silent if it is silent at every distance tried. Anything
   * that depends on camera distance - screen-size fades, LOD, fog - gets its
   * chance, and the run stops at the first sight of a pixel.
   */
  const MULTS = [1.5, 4, 12];

  /**
   * Spots are the innermost loop so the closest framing is tried against every
   * candidate instance before any of them is retried from further away. An
   * instance that is genuinely visible is visible at 'MULTS[0]', and the run
   * still stops at the first pixel, so the common case costs no more renders
   * than before the instanced fix.
   */
  function bestOf(o, a) {
    const spots = a.spots && a.spots.length ? a.spots : [{ center: a.center, radius: a.radius, dir: a.dir }];
    let best = { px: 0, worst: 0 }, bestDir = spots[0].dir || AXES[0], bestMult = MULTS[0], bestSpot = 0;
    for (const mult of MULTS) {
      for (let si = 0; si < spots.length; si++) {
        const s = spots[si];
        const dirs = s.dir ? [s.dir] : AXES;
        for (const d of dirs) {
          place(s.center, s.radius, d, mult);
          const r = contributes(o);
          if (r.px > best.px) { best = r; bestDir = d; bestMult = mult; bestSpot = si; }
          if (best.px > 0) break;
        }
        if (best.px > 0) break;
      }
      if (best.px > 0) break;
    }
    return { best, bestDir, bestMult, bestSpot, spots: spots.length };
  }

  function eachMaterial(o, fn) {
    const m = o.material;
    if (Array.isArray(m)) m.forEach(fn); else if (m) fn(m);
  }

  /**
   * One forced property at a time. Materials are shared between meshes in this
   * project, so every override is recorded and put back exactly, and the
   * material's needsUpdate is set on both the way in and the way out, because
   * changing side changes the compiled program.
   */
  function withForced(o, what, fn) {
    const undo = [];
    if (what === "side") {
      eachMaterial(o, (m) => {
        const prev = m.side;
        undo.push(() => { m.side = prev; m.needsUpdate = true; });
        m.side = 2; m.needsUpdate = true;
      });
    } else if (what === "depth") {
      eachMaterial(o, (m) => {
        const prev = m.depthTest;
        undo.push(() => { m.depthTest = prev; });
        m.depthTest = false;
      });
      const ro = o.renderOrder;
      undo.push(() => { o.renderOrder = ro; });
      o.renderOrder = 99999;
    } else if (what === "frustum") {
      const prev = o.frustumCulled;
      undo.push(() => { o.frustumCulled = prev; });
      o.frustumCulled = false;
    } else if (what === "all") {
      eachMaterial(o, (m) => {
        const s = m.side, d = m.depthTest;
        undo.push(() => { m.side = s; m.depthTest = d; m.needsUpdate = true; });
        m.side = 2; m.depthTest = false; m.needsUpdate = true;
      });
      const ro = o.renderOrder, fc = o.frustumCulled;
      undo.push(() => { o.renderOrder = ro; o.frustumCulled = fc; });
      o.renderOrder = 99999; o.frustumCulled = false;
    }
    try { return fn(); } finally { for (const u of undo.reverse()) u(); }
  }

  function judge(i) {
    const it = items[i];
    const o = it.obj;
    const out = { i, path: it.path, name: it.name, type: o.type, tris: triCount(o) };

    const hid = hiddenBy(o);
    const a = aim(o);
    if (!a) { out.verdict = "DEGENERATE"; out.why = "no finite bounding sphere"; return out; }
    out.radius = a.radius;
    out.ambiguous = a.ambiguous;

    if (hid !== null) {
      out.verdict = "HIDDEN";
      out.why = hid === pathOf(o) ? "visible=false on itself" : ("visible=false on ancestor " + hid);
      return out;
    }
    if (o.isInstancedMesh && o.count === 0) { out.verdict = "DEGENERATE"; out.why = "instance count is 0"; return out; }

    const { best, bestDir, bestMult, bestSpot, spots } = bestOf(o, a);
    out.px = best.px;
    out.dir = bestDir.map((v) => Math.round(v * 100) / 100);
    out.mult = bestMult;
    // Recorded so a DEGENERATE on an instanced mesh can be read against how
    // many of its instances were actually aimed at, which is the fault this
    // tool shipped with until it was measured.
    if (a.instanced) { out.spots = spots; out.spot = bestSpot; }
    if (best.px > 0) { out.verdict = "SEEN"; return out; }

    // Silent. Find the single property that brings it back.
    const trial = (what) => withForced(o, what, () => bestOf(o, a).best.px);
    const bySide = trial("side");
    if (bySide > 0) { out.verdict = "WINDING"; out.recovered = bySide; return out; }
    const byDepth = trial("depth");
    if (byDepth > 0) { out.verdict = "OCCLUDED"; out.recovered = byDepth; return out; }
    const byFrustum = trial("frustum");
    if (byFrustum > 0) { out.verdict = "CULLED"; out.recovered = byFrustum; return out; }
    const byAll = trial("all");
    if (byAll > 0) { out.verdict = "OCCLUDED"; out.why = "only with side+depth+frustum all forced"; out.recovered = byAll; return out; }
    out.verdict = "DEGENERATE";
    out.why = "nothing forced brings it back";
    return out;
  }

  /** Two renders, nothing changed. Must be identical or no comparison below
   *  means anything. Run against a mesh's own view, not an arbitrary one. */
  function determinism(i) {
    const it = items[i];
    const a = aim(it.obj);
    if (!a) return null;
    place(a.center, a.radius, a.dir || AXES[0], 1.5);
    shoot(bufA);
    shoot(bufB);
    return diff(bufA, bufB);
  }

  /* ---------------- selftest ---------------- */

  /**
   * Plant four quads high above the scene with known verdicts and require the
   * probe to return exactly those. A probe that cannot fail is not evidence.
   * The backwards one is the case this tool exists for: identical to the good
   * one in every respect except the order of its three indices.
   */
  function plant() {
    if (!items) enumerate();
    // Must be a lit, coloured material. The first version took whatever mesh
    // came first in traversal order, which was the sky dome on a raw
    // ShaderMaterial with no .color and no response to light, so the planted
    // controls were not controls at all.
    const proto = items.find((it) => {
      const m = it.obj.material;
      return it.obj.geometry.attributes.position && !it.obj.isInstancedMesh && !Array.isArray(m) && m && m.color && m.isMeshStandardMaterial;
    });
    if (!proto) throw new Error("selftest: no plain MeshStandardMaterial mesh to borrow constructors from");
    const P = proto.obj;
    const GEO = P.geometry.constructor;
    const ATTR = P.geometry.attributes.position.constructor;
    const MESH = P.constructor;
    const MAT = (Array.isArray(P.material) ? P.material[0] : P.material).constructor;

    const Y = 600; // far above anything the scene contains
    const quad = (flip) => {
      const geo = new GEO();
      // Facing +Z, 2 m square.
      geo.setAttribute("position", new ATTR(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]), 3));
      geo.setAttribute("normal", new ATTR(new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), 3));
      geo.setAttribute("uv", new ATTR(new Float32Array([0,0, 1,0, 1,1, 0,1]), 2));
      geo.setIndex(flip ? [0,2,1, 0,3,2] : [0,1,2, 0,2,3]);
      geo.computeBoundingSphere();
      return geo;
    };
    const mk = (name, flip, x, rgb) => {
      const m = new MESH(quad(flip), new MAT());
      m.material.side = 0;          // FrontSide: the whole point
      m.material.fog = false;
      // Distinct colours matter. The occlusion check works by forcing the mesh
      // in front of its occluder and asking whether the frame changed, so an
      // occluder that looks identical to the mesh it hides is indistinguishable
      // from the mesh not drawing at all. The first version of this selftest
      // planted both as plain white and duly reported the buried quad as
      // DEGENERATE. That is a real limit of the method, not just of the test.
      if (rgb) m.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
      m.name = name;
      m.position.set(x, Y, 0);
      m.castShadow = false; m.receiveShadow = false;
      scene.add(m);
      return m;
    };

    const made = [];
    made.push(mk("__unseen_selftest_good", false, 0));
    made.push(mk("__unseen_selftest_backwards", true, 10));
    const buried = mk("__unseen_selftest_buried", false, 20, [1, 0, 0]);
    const lid = mk("__unseen_selftest_lid", false, 20, [0, 0.4, 1]);
    lid.position.set(20, Y, 3);     // a bigger, nearer wall on the same axis
    lid.scale.set(3, 3, 1);
    made.push(buried, lid);
    const hidden = mk("__unseen_selftest_hidden", false, 30);
    hidden.visible = false;
    made.push(hidden);

    /*
     * THE INSTANCED ARMS, and the reason they are not optional.
     *
     * 'aim()' was fixed on 2026-08-29 to apply 'instanceMatrix', after it
     * accused eleven sound vegetation meshes of being DEGENERATE. That fix
     * shipped with no test: every planted control above is a single quad at a
     * known place, and a single quad exercises the 'if (!spots.length)'
     * fallback and never the instanced branch at all. So the selftest passed
     * before the bug, during the bug, and after the fix, and could not tell
     * the three apart - which is the same shape as the bug it was fixing, one
     * level up. A probe that cannot fail is not evidence, and neither is a
     * selftest that does not cover the path that was wrong.
     *
     * The geometry is a 2 m quad and the instances sit on a 300 m ring, so the
     * geometry's own bounding sphere (radius ~1.4 at the local origin) is
     * nowhere near any instance. That ratio is the defect, reproduced: the old
     * 'aim()' framed 1.4 m of empty space at the group origin, rendered
     * nothing, recovered nothing when forced, and printed DEGENERATE. Verified
     * by reverting 'aim()' to the pre-fix expression and re-running: the
     * scattered arm reports DEGENERATE and the run FAILs. Both arms are
     * present because a fix that made everything report SEEN would also pass a
     * one-armed version of this - the backwards ring must still be caught.
     */
    const protoInst = items.find((it) => it.obj.isInstancedMesh && it.obj.count > 0);
    if (!protoInst) {
      // Loud, not skipped. An arm that quietly disappears when the scene
      // changes leaves a green selftest covering strictly less than it says.
      throw new Error(
        "selftest: no InstancedMesh in the scene to borrow a constructor from, so the " +
          "instanced arms cannot be planted. Refusing to report a pass that does not " +
          "cover the branch this tool's last bug was in."
      );
    }
    const IMESH = protoInst.obj.constructor;
    const M4 = protoInst.obj.matrixWorld.constructor;
    const RING = 300;
    const ring = (name, flip, rgb) => {
      const im = new IMESH(quad(flip), new MAT(), 24);
      im.material.side = 0;
      im.material.fog = false;
      im.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
      const m = new M4();
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        // Identity rotation on every instance, so the mean shading normal
        // resolves to +Z for all of them and the aim direction is unambiguous.
        // A rotated ring would also be a fair test of 'spotFor', but it would
        // conflate "the probe aimed at an instance" with "the probe got the
        // instance's orientation right", and only the first is on trial here.
        m.makeTranslation(Math.cos(a) * RING, Y + 60 + k * 0.05, Math.sin(a) * RING);
        im.setMatrixAt(k, m);
      }
      im.instanceMatrix.needsUpdate = true;
      im.name = name;
      im.castShadow = false;
      im.receiveShadow = false;
      // Accounts for instanceMatrix. Without it the cull sphere is one quad at
      // the origin and the arm would report CULLED, which is a different bug
      // wearing the same symptom and would make the test ambiguous.
      im.computeBoundingSphere();
      scene.add(im);
      return im;
    };
    made.push(ring("__unseen_selftest_scattered", false, [0.15, 0.9, 0.35]));
    made.push(ring("__unseen_selftest_scattered_backwards", true, [0.9, 0.5, 0.1]));

    scene.updateMatrixWorld(true);
    return made.map((m) => m.name);
  }

  function unplant() {
    for (const m of scene.children.slice()) {
      if (m.name && m.name.startsWith("__unseen_selftest_")) {
        scene.remove(m);
        m.geometry.dispose();
        if (m.material.dispose) m.material.dispose();
      }
    }
  }

  return { enter, leave, enumerate, judge, determinism, plant, unplant };
})();
`;

/* ------------------------------------------------------------------ */

function fmtRow(r) {
  const px = r.px === undefined ? "" : String(r.px);
  return (
    `  ${String(r.verdict).padEnd(11)} ${(r.path || r.name).slice(0, 62).padEnd(62)} ` +
    `${String(r.tris).padStart(7)} tri  ${px.padStart(7)} px` +
    (r.recovered ? `  (${r.recovered} px when forced)` : "") +
    (r.why ? `  ${r.why}` : "")
  );
}

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log(`[unseen] building into ${BUILD_DIR} ...`);
    lowerPriority();
    await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
  }

  await waitForPort(PORT, 240_000);
  console.log(`[unseen] preview on :${PORT}`);
  resources.server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: BUILD_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  const base = `http://127.0.0.1:${PORT}/`;

  resources.browser = await chromium.launch(launchOptions({ allowSoftware: ALLOW_SOFTWARE }));
  const context = await resources.browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });

  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  const parts = ["shot=car", "gpu=1"];
  if (QUERY) parts.push(QUERY);
  await page.goto(`${base}?${parts.join("&")}`, { waitUntil: "load", timeout: 60_000 });
  const gpuInfo = await assertHardwareGpu(page, { tag: "unseen", allowSoftware: ALLOW_SOFTWARE });
  console.log(`[unseen] gpu: ${gpuInfo.renderer ?? JSON.stringify(gpuInfo)}`);
  await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: READY_TIMEOUT_MS });

  const sysErrs = await page.evaluate(() => window.__SYSTEM_ERRORS ?? []);
  if (sysErrs.length) {
    for (const e of sysErrs) console.error(`[unseen] system ${e.system} failed in ${e.phase}: ${e.message}`);
    await shutdown(1, `${sysErrs.length} system(s) failed to initialise — the scene is not the scene`);
  }

  await page.evaluate(INSTALL);
  await page.evaluate((res) => window.__PROBE_UNSEEN.enter(res), RES);

  let planted = [];
  if (SELFTEST) {
    planted = await page.evaluate(() => window.__PROBE_UNSEEN.plant());
    console.log(`[unseen] selftest planted ${planted.length}: ${planted.join(", ")}`);
  }

  let all = await page.evaluate(() => window.__PROBE_UNSEEN.enumerate());
  console.log(`[unseen] ${all.length} meshes in the scene, ${all.filter((m) => m.unnamed).length} of them unnamed`);

  // Determinism control. Without this the whole comparison is unfounded: an
  // animated uniform would make every mesh look visible and the run would come
  // back a flattering all-clear.
  const ctrl = [];
  for (const i of [0, Math.floor(all.length / 3), Math.floor((2 * all.length) / 3), all.length - 1]) {
    if (i >= 0 && i < all.length) ctrl.push(await page.evaluate((k) => window.__PROBE_UNSEEN.determinism(k), i));
  }
  const bad = ctrl.filter((c) => c && c.px > 0);
  console.log(
    `[unseen] determinism control: ${ctrl.length} views rendered twice unchanged, ` +
      `differing pixels ${ctrl.map((c) => (c ? c.px : "-")).join("/")}`
  );
  if (bad.length) {
    await shutdown(
      1,
      `the scene does not render deterministically (${bad[0].px} px differ between two identical renders, ` +
        `worst channel delta ${bad[0].worst}). Every result below would be noise. Find the animated uniform first.`
    );
  }

  let targets = all;
  if (FILTER) {
    const re = new RegExp(FILTER, "i");
    targets = all.filter((m) => re.test(m.path) || re.test(m.name));
  }
  if (SELFTEST) targets = all.filter((m) => m.name.startsWith("__unseen_selftest_"));
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  console.log(`[unseen] judging ${targets.length} mesh(es) at ${RES}x${RES}, each from its own view`);

  const results = [];
  const t0 = Date.now();
  for (let b = 0; b < targets.length; b += BATCH) {
    const idx = targets.slice(b, b + BATCH).map((m) => m.i);
    const got = await page.evaluate((ids) => ids.map((k) => window.__PROBE_UNSEEN.judge(k)), idx);
    results.push(...got);
    if (targets.length > BATCH) {
      const done = Math.min(b + BATCH, targets.length);
      process.stdout.write(`\r[unseen]   ${done}/${targets.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
    }
  }
  if (targets.length > BATCH) process.stdout.write("\n");

  if (SELFTEST) {
    await page.evaluate(() => window.__PROBE_UNSEEN.unplant());
  }
  await page.evaluate(() => window.__PROBE_UNSEEN.leave());

  /* ---------------- report ---------------- */

  const by = (v) => results.filter((r) => r.verdict === v);
  const order = ["WINDING", "DEGENERATE", "CULLED", "OCCLUDED", "HIDDEN"];

  console.log("");
  if (SELFTEST) {
    const want = {
      __unseen_selftest_good: "SEEN",
      __unseen_selftest_backwards: "WINDING",
      __unseen_selftest_buried: "OCCLUDED",
      __unseen_selftest_lid: "SEEN",
      __unseen_selftest_hidden: "HIDDEN",
      // Instances 300 m from the geometry's own bounding sphere. SEEN only if
      // `aim()` applies `instanceMatrix`; DEGENERATE if it frames the mesh
      // bound, which is what it did until 2026-08-29.
      __unseen_selftest_scattered: "SEEN",
      // And the other side of it: aiming at an instance must not turn a
      // reversed winding into a pass.
      __unseen_selftest_scattered_backwards: "WINDING",
    };
    let ok = true;
    for (const [name, expect] of Object.entries(want)) {
      const r = results.find((x) => x.name === name);
      const got = r ? r.verdict : "ABSENT";
      if (got !== expect) ok = false;
      console.log(`  ${name.padEnd(34)} want ${expect.padEnd(11)} got ${got.padEnd(11)} ${got === expect ? "ok" : "MISMATCH"}`);
    }
    console.log(`\n[unseen] selftest ${ok ? "PASS" : "FAIL"}`);
    await shutdown(ok ? 0 : 1, ok ? null : "selftest did not reproduce its planted verdicts");
    return;
  }

  const silent = results.filter((r) => r.verdict !== "SEEN");
  console.log(
    `[unseen] ${results.length - silent.length} of ${results.length} draw pixels from their own view; ` +
      `${silent.length} draw none`
  );
  for (const v of order) {
    const rows = by(v);
    if (!rows.length) continue;
    console.log(`\n  ${v}  (${rows.length})`);
    for (const r of rows.sort((a, c) => c.tris - a.tris)) console.log(fmtRow(r));
  }
  if (VERBOSE) {
    console.log(`\n  SEEN  (${by("SEEN").length})`);
    for (const r of by("SEEN").sort((a, c) => c.px - a.px)) console.log(fmtRow(r));
  }

  const winding = by("WINDING");
  console.log("");
  if (winding.length) {
    console.log(
      `[unseen] ${winding.length} mesh(es) are wound backwards. This is never legitimate: the\n` +
        `         triangles disagree with the mesh's own shading normals, so back-face culling\n` +
        `         removes it and the capture is indistinguishable from one where it drew\n` +
        `         something subtle. See NOTES case 33.`
    );
  } else {
    console.log("[unseen] no winding failures.");
  }
  const ambiguous = results.filter((r) => r.ambiguous && r.verdict !== "SEEN").length;
  if (ambiguous) {
    console.log(`[unseen] ${ambiguous} of the silent meshes are closed shells with no mean normal; judged from six axes.`);
  }
  if (problems.length) console.log(`[unseen] page problems: ${problems.length} (first: ${problems[0].slice(0, 200)})`);

  // ---- regression gate ----
  let gateFail = 0;
  if (BASELINE) {
    /**
     * Path plus an occurrence index, because paths are not unique. The scene
     * has 362 meshes and only 282 distinct paths - eight identical
     * `cooler-lamp-tube`s, repeated cooler doors, and so on. Keying on path
     * alone silently collapsed them, last-one-wins, and the first run of this
     * gate duly reported two building meshes as regressed that nobody had
     * touched. A gate with false positives is worse than no gate: it trains
     * whoever sees it to ignore the output, which is the failure mode that
     * loses the real regression later.
     */
    const seen = new Map();
    const key = (r) => {
      const p = r.path || r.name;
      const n = seen.get(p) ?? 0;
      seen.set(p, n + 1);
      return n ? `${p}#${n}` : p;
    };
    if (RECORD) {
      const snap = { when: new Date().toISOString(), meshes: {} };
      for (const r of results) snap.meshes[key(r)] = r.verdict;
      fs.mkdirSync(path.dirname(path.resolve(BASELINE)), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
      console.log(`[unseen] baseline written: ${BASELINE}  (${results.length} meshes)`);
    } else if (!fs.existsSync(BASELINE)) {
      console.log(`[unseen] no baseline at ${BASELINE} - run once with --record. Not failing the round.`);
    } else {
      const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
      const now = new Map(results.map((r) => [key(r), r.verdict]));
      const regressed = [];
      const recovered = [];
      const vanished = [];
      for (const [name, was] of Object.entries(base.meshes)) {
        const is = now.get(name);
        if (is === undefined) {
          // A mesh present at baseline and absent now is not necessarily a
          // fault - scenes are edited - but it is never nothing, so it is
          // reported and never silently dropped.
          if (was === "SEEN") vanished.push(name);
          continue;
        }
        if (was === "SEEN" && is !== "SEEN") regressed.push(`${name}  SEEN -> ${is}`);
        if (was !== "SEEN" && is === "SEEN") recovered.push(name);
      }
      console.log(
        `[unseen] gate vs ${path.basename(BASELINE)} (${base.when}): ` +
          `${regressed.length} regressed, ${recovered.length} recovered, ${vanished.length} no longer in scene`
      );
      for (const r of recovered) console.log(`         recovered  ${r}`);
      for (const r of vanished) console.log(`         gone       ${r}`);
      for (const r of regressed) console.log(`         REGRESSED  ${r}`);
      gateFail = regressed.length;
    }
  }

  const failed = (STRICT ? silent.length : winding.length) + gateFail;
  const why = gateFail
    ? `${gateFail} mesh(es) stopped drawing since the baseline`
    : failed
      ? `${failed} mesh(es) draw nothing`
      : null;
  await shutdown(failed ? 1 : 0, why);
}

main().catch((err) => void shutdown(1, err?.stack ?? String(err)));
