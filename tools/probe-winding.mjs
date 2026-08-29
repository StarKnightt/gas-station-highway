#!/usr/bin/env node
/**
 * Per-triangle winding audit over the **whole assembled scene**, every system.
 *
 *   node tools/probe-winding.mjs --port=5119
 *   node tools/probe-winding.mjs --port=5119 --filter=canopy
 *
 * WHY THIS EXISTS
 *
 * A triangle's winding and its shading normals are two independent statements
 * about which way a surface faces, and they must agree. If they disagree,
 * back-face culling removes a surface the generator believed was front-facing,
 * and what you get is not an error but a plausible-looking render of the *far*
 * wall of a solid — a defect that survives every count, every registry line and
 * every capture.
 *
 * The test is one line of vector algebra and it is exact: for each triangle,
 * compare the geometric normal implied by the vertex order, `(b - a) x (c - a)`,
 * against the mean of the three shading normals the generator wrote. Sign
 * disagreement is a reversed triangle. That is all.
 *
 * WHAT MAKES IT WORTH HAVING RATHER THAN OBVIOUS
 *
 * Every other winding instrument in this project needs something the caller has
 * to choose or the geometry has to provide, and each of those has now failed:
 *
 *  - **Pixels.** Car's `probe-unseen` renders each mesh alone and re-renders it
 *    with `side = DoubleSide`; recovery means reversed. Correct in principle, and
 *    on `veg-pole-insulators` it recovered **1 px out of 540 triangles**, because
 *    framed to fit a six-pole line every insulator is 5.8 cm and sub-pixel, and
 *    DoubleSide roughly doubles the chance a sub-pixel fragment survives. The
 *    strongest available pixel evidence for a scene-wide geometry bug was one
 *    pixel.
 *  - **Mean normal against the outward radial.** Undefined on a closed shell,
 *    where the mean normal is zero by construction. Canopy and Pumps both hit
 *    that independently.
 *  - **Eyes.** `computeVertexNormals()` derives normals *from* the winding, so it
 *    certifies whatever it is given. It cannot fail. Any builder that calls it
 *    converts a winding bug into a shading bug and destroys the evidence in the
 *    same statement — which is exactly how `sweepTube` shipped inside out from
 *    the day it was written, with `veg-pine-wood` measuring 0.0% reversed while
 *    props from the same function measured 80%.
 *
 * This test needs no region, no framing, no threshold and no pixels, is defined
 * on closed shells, and sees **inside a merge** — which is the only reason the
 * vegetation instance was findable at all, since 218 plants share one mesh there.
 *
 * READ THE AGREEMENT COLUMN BEFORE BELIEVING A REVERSED COUNT
 *
 * `agreement` is the mean |cos| between each face normal and its own vertices'
 * mean normal. Near 1.0 the mesh is faceted or smoothly curved and a reversed
 * count means what it says. Low agreement means the normals are not
 * face-derived at all — fanned outward on a crossed card, or splayed for a
 * fake-volume trick — and for those a "reversed" triangle is intentional. The
 * known benign case here is `veg-thatch-sprigs`: 4 of 8 triangles reversed at
 * agreement 0.096, which is a two-sided crossed card and correct.
 *
 * Degenerate triangles are counted separately, never folded into the agreement
 * average, because a zero-area face has no winding and averaging it in dilutes a
 * real failure toward the pass mark.
 *
 * Read-only. Builds, serves, opens one page, traverses, prints, exits. It never
 * writes to the scene and never captures.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(arg("port", process.env.DAWN_PORT ?? 5119));
const BUILD_DIR = arg("build-dir", ".shot-build/winding");
const FILTER = arg("filter", "");
const QUERY = arg("query", "");
const DO_BUILD = !argv.includes("--no-build");

/**
 * Which system a mesh belongs to.
 *
 * Named after the *evidence*, not after a guess: the top-level group under the
 * scene is added by exactly one system, so walking up to it attributes a mesh
 * without relying on anybody's naming convention. Name prefixes are used only as
 * a fallback and only when they are unambiguous, because at least one system
 * names meshes after the real-world part rather than after itself.
 */
const OWNER_SOURCE = `(() => {
  const g = window.__GAME;
  const scene = g.scene;
  const PREFIX = [
    ["veg-", "vegetation"], ["horizon-", "vegetation"],
    ["building-", "building"], ["store-", "building"], ["cooler", "building"], ["product", "building"], ["shelf", "building"],
    ["pump-", "pumps"], ["nozzle", "pumps"], ["hose", "pumps"], ["dispenser", "pumps"],
    ["car-", "car"], ["wheel", "car"], ["tyre", "car"], ["tire", "car"],
    ["canopy-", "canopy"], ["fascia", "canopy"], ["soffit", "canopy"],
    ["terrain-", "terrain"], ["ground", "terrain"], ["road", "terrain"], ["kerb", "terrain"], ["apron", "terrain"], ["pavement", "terrain"],
    ["sky", "sky"], ["light", "lighting"], ["lamp", "lighting"], ["troffer", "lighting"],
  ];
  const ownerOf = (obj) => {
    // Walk to the top-level child of the scene; that node is owned by one system.
    let top = obj, parent = obj.parent;
    while (parent && parent !== scene) { top = parent; parent = parent.parent; }
    const names = [];
    for (let o = obj; o && o !== scene; o = o.parent) if (o.name) names.push(o.name.toLowerCase());
    for (const n of names) for (const [pre, sys] of PREFIX) if (n.startsWith(pre) || n.includes(pre)) return sys;
    return top && top.name ? "group:" + top.name : "unattributed";
  };
  return ownerOf;
})()`;

const AUDIT_SOURCE = `(() => {
  const ownerOf = ${OWNER_SOURCE};
  const g = window.__GAME;
  const scene = g.scene;
  const THREE = window.__THREE_FOR_PROBE;
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const geo = o.geometry;
    if (!geo) return;
    const pos = geo.getAttribute && geo.getAttribute("position");
    const nor = geo.getAttribute && geo.getAttribute("normal");
    if (!pos || !nor) return;
    const index = geo.getIndex ? geo.getIndex() : null;
    const count = index ? index.count : pos.count;
    let reversed = 0, degenerate = 0, sound = 0, agree = 0;
    const gi = (t) => (index ? index.getX(t) : t);
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = gi(t), i1 = gi(t + 1), i2 = gi(t + 2);
      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const bx = pos.getX(i1) - ax, by = pos.getY(i1) - ay, bz = pos.getZ(i1) - az;
      const cx = pos.getX(i2) - ax, cy = pos.getY(i2) - ay, cz = pos.getZ(i2) - az;
      let fx = by * cz - bz * cy, fy = bz * cx - bx * cz, fz = bx * cy - by * cx;
      const area = Math.hypot(fx, fy, fz);
      if (!(area > 1e-12)) { degenerate++; continue; }
      fx /= area; fy /= area; fz /= area;
      let sx = 0, sy = 0, sz = 0;
      for (const i of [i0, i1, i2]) { sx += nor.getX(i); sy += nor.getY(i); sz += nor.getZ(i); }
      const sl = Math.hypot(sx, sy, sz);
      if (!(sl > 1e-9)) { degenerate++; continue; }
      const d = (fx * sx + fy * sy + fz * sz) / sl;
      sound++; agree += Math.abs(d);
      if (d < 0) reversed++;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const sides = mats.filter(Boolean).map((m) => (m.side === 2 ? "double" : m.side === 1 ? "back" : "front"));
    out.push({
      name: o.name || "<unnamed>",
      owner: ownerOf(o),
      instanced: !!o.isInstancedMesh,
      triangles: Math.floor(count / 3),
      reversed, degenerate,
      agreement: sound ? agree / sound : 0,
      side: sides.length ? (sides.every((s) => s === sides[0]) ? sides[0] : "mixed") : "none",
      visible: o.visible,
    });
  });
  return out;
})()`;

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");
  let server, browser;
  const shutdown = async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.httpServer.close(r));
  };
  try {
    if (DO_BUILD) {
      console.log(`[winding] building into ${BUILD_DIR} ...`);
      await build({ root: ROOT, logLevel: "warn", build: { outDir: BUILD_DIR, emptyOutDir: true } });
    }
    server = await preview({
      root: ROOT,
      build: { outDir: BUILD_DIR },
      preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
    });
    console.log(`[winding] preview on :${PORT}`);
    browser = await chromium.launch(launchOptions());
    const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    // `domcontentloaded`, not `load`: generation runs for ~30 s on the main
    // thread and the default 30 s `load` timeout races it. Readiness is asserted
    // properly below against `__SCENE_READY`, which is the real signal.
    await page.goto(`http://127.0.0.1:${PORT}/${QUERY ? "?" + QUERY : ""}`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await assertHardwareGpu(page, { tag: "winding" });
    await page.waitForFunction(() => window.__SCENE_READY === true, null, { timeout: 180000 });
    const sysErrs = await page.evaluate(() => (window.__SYSTEM_ERRORS ?? []).map((e) => e.system ?? String(e)));
    if (sysErrs.length) console.log(`[winding] systems that failed to init: ${sysErrs.join(", ")}`);

    let rows = await page.evaluate(AUDIT_SOURCE);
    if (FILTER) rows = rows.filter((r) => r.name.includes(FILTER) || r.owner.includes(FILTER));

    const tri = rows.reduce((a, r) => a + r.triangles, 0);
    console.log(`\n[winding] ${rows.length} meshes, ${tri.toLocaleString()} triangles, audited per triangle\n`);

    // Per system first, because the routing question is "whose is it".
    const bySys = new Map();
    for (const r of rows) {
      const k = r.owner;
      const e = bySys.get(k) ?? { meshes: 0, tri: 0, revMeshes: 0, rev: 0, culled: 0 };
      e.meshes++;
      e.tri += r.triangles;
      e.rev += r.reversed;
      if (r.reversed > 0) {
        e.revMeshes++;
        if (r.side === "front") e.culled += r.reversed;
      }
      bySys.set(k, e);
    }
    console.log("  BY SYSTEM");
    console.log("    system                meshes      tri   meshes w/ reversed   reversed tri   of those, FrontSide");
    for (const [k, e] of [...bySys.entries()].sort((a, b) => b[1].rev - a[1].rev)) {
      console.log(
        `    ${k.padEnd(20)} ${String(e.meshes).padStart(6)} ${String(e.tri).padStart(8)}   ` +
          `${String(e.revMeshes).padStart(18)}   ${String(e.rev).padStart(12)}   ${String(e.culled).padStart(19)}`
      );
    }

    const bad = rows.filter((r) => r.reversed > 0).sort((a, b) => b.reversed - a.reversed);
    console.log(`\n  MESHES WITH REVERSED TRIANGLES (${bad.length})`);
    if (!bad.length) console.log("    none");
    else {
      console.log("    owner            mesh                                 reversed/tri     %   agreement  side");
      for (const r of bad) {
        const pct = ((100 * r.reversed) / r.triangles).toFixed(1);
        console.log(
          `    ${r.owner.padEnd(16)} ${r.name.slice(0, 34).padEnd(35)} ${String(r.reversed).padStart(6)}/${String(r.triangles).padEnd(7)} ` +
            `${pct.padStart(5)}   ${r.agreement.toFixed(3).padStart(9)}  ${r.side}`
        );
      }
      console.log(
        `\n    Read 'agreement' first. Above ~0.7 the normals are face-derived and a reversed\n` +
          `    count is a defect. Below ~0.3 the normals are fanned or splayed (crossed cards,\n` +
          `    fake-volume tricks) and two-sidedness is intentional. 'side' says whether the\n` +
          `    renderer is currently hiding it: FrontSide means the triangles are being culled.`
      );
    }

    if (errs.length) console.log(`\n[winding] page errors: ${errs.length} (first: ${errs[0].slice(0, 160)})`);
    // Reporting tool, not a gate: it does not own anyone else's geometry.
    console.log(`\n[winding] done. Reversed triangles are reported, not fixed; each owner fixes their own.`);
  } finally {
    await shutdown();
    console.log(`[winding] torn down, port ${PORT} released`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
