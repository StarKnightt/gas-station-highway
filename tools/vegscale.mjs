#!/usr/bin/env node
/**
 * vegscale — how big is every plant, in pixels, in a given capture pose?
 *
 *   node tools/vegscale.mjs wires
 *   node tools/vegscale.mjs --all
 *
 * ---------------------------------------------------------------------------
 * SHARED TOOLING. The vegetation half is one page; the rest generalises.
 * ---------------------------------------------------------------------------
 *
 * Every system here has instanced or merged content and none of them can
 * currently answer "which of my instances is the one in that corner of the
 * frame". Merged geometry cannot: one `veg-mid-wood` mesh holds 218 plants and
 * its bounding box is the whole lot, exactly as one `veg-pine-wood` mesh spans
 * 3.5 km of treeline. That is why the collision agent could not bridge
 * vegetation either — it is the same missing information.
 *
 * To adopt this for another system, two things are needed and only the second
 * is work:
 *
 *  1. **Publish a manifest.** `game.provide("<system>.sites", [...])` with a
 *     kind, a position and a size per instance. Vegetation publishes
 *     `vegetation.sites`. Ten lines, and it is independently useful — the
 *     collision contract wants the same data.
 *  2. **Swap the entry.** `tools/_vegscale-entry.ts` stands the system up on
 *     the CPU and hands back the manifest. Copy it, change which system it
 *     inits, and the projection and ranking below are unchanged.
 *
 * The poses come from `tools/vegposes.mjs`, which `shoot6` also imports. A probe
 * with its own copy of the camera confidently answers a question nobody asked.
 *
 * ---------------------------------------------------------------------------
 * WHY IT TAKES A SHOT NAME AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * A critic logged, from frames only: "the foreground plant at left is enormous
 * relative to the building behind it, roughly the height of the store." The
 * first response was a guess — a near-forecourt conifer — and a change made on
 * the strength of it. The change landed, the plant was pixel-for-pixel
 * unchanged, and a seven-minute capture had been spent disproving one
 * hypothesis out of several.
 *
 * The two probes in this tree that have actually settled arguments share one
 * property: `probe-zeroscan` and `probe-unseen` **take no coordinates**. They
 * enumerate everything the system owns and rank it, so the answer cannot be a
 * property of where the operator chose to look, and they surface regressions
 * nobody went looking for — `probe-unseen` caught three wheel caps falling to
 * 0 px tonight while it was being run for something else entirely.
 *
 * So this does not ask "what is at (180, 400)". It projects **every plant the
 * system placed** into the capture camera and ranks them by apparent height.
 * The tall thing in the corner is then simply the top of the list, named, with
 * its distance and its true height beside it — and the ranking is the same
 * ranking whether or not anyone had noticed the plant.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES
 * ---------------------------------------------------------------------------
 *
 * Apparent height in pixels, and — the number the complaint was actually about
 * — apparent height as a fraction of the frame, next to the same figure for the
 * building. "Enormous relative to the building" is a ratio, so the tool reports
 * the ratio rather than leaving it to be eyeballed from two absolute numbers.
 *
 * Frustum rejection is deliberately generous: a plant whose centre is off-screen
 * but which still covers a third of the frame is exactly the case of interest,
 * so anything within a margin of the frustum is kept and marked.
 *
 * Pure computation against the real scene graph and the real capture pose,
 * which is imported from `tools/vegposes.mjs` rather than copied — a probe that
 * disagrees with the capture about where the camera stands answers a question
 * nobody asked.
 *
 * Nothing is spawned. Nothing to tear down.
 */
import { rmSync } from "node:fs";
import { build } from "vite";
import * as THREE from "three";
import { POSES, WIDTH, HEIGHT } from "./vegposes.mjs";

const argv = process.argv.slice(2);
const shots = argv.includes("--all") ? Object.keys(POSES) : argv.filter((a) => !a.startsWith("-"));
const usage = `usage: vegscale.mjs <shot|--all>   shots: ${Object.keys(POSES).join(", ")}`;
if (!shots.length) {
  console.error(usage);
  process.exit(2);
}
for (const s of shots) {
  if (POSES[s]) continue;
  console.error(`vegscale: no such pose "${s}"\n${usage}`);
  process.exit(2);
}

// The system reads `?vforce=` and friends off `location.search` and builds
// textures through a canvas. Neither exists in Node, and neither matters to a
// question about geometry in pixels, so both are stood up as empty rather than
// worked around inside the system — a `typeof window` branch in shipping code
// is a branch the capture never takes.
globalThis.location ??= { search: "", href: "http://localhost/" };
globalThis.window ??= globalThis;
const noop = () => {};
const ctx2d = () =>
  new Proxy(
    {
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      // Returned explicitly rather than falling through to the Proxy's `noop`,
      // which yields `undefined` and fails inside whichever generator called it
      // with a stack that names the generator and not the stub. Building added a
      // `createImageData` caller tonight and that is exactly how it presented.
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      canvas: null,
    },
    { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? noop : undefined), set: () => true }
  );
const canvas = (w = 256, h = 256) => ({
  width: w,
  height: h,
  style: {},
  setAttribute: noop,
  appendChild: noop,
  getContext: () => ctx2d(),
  toDataURL: () => "",
});
globalThis.document ??= {
  body: { appendChild: noop },
  createElement: (tag) => (tag === "canvas" ? canvas() : { style: {}, setAttribute: noop, appendChild: noop }),
};
globalThis.OffscreenCanvas ??= class {
  constructor(w, h) {
    Object.assign(this, canvas(w, h));
  }
};

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { collectSites } = await import("../.shot-build/cpu/vegscale.mjs");
const { sites, ground: groundHeight } = await collectSites();
rmSync(".shot-build/cpu", { recursive: true, force: true });

// Hard failure rather than an empty table. A probe that reports nothing when it
// was unable to look is a probe that reads as "no plant is oversized", which is
// the comfortable answer and the one this tree keeps being burned by.
if (!sites.length) {
  console.error("vegscale: VegetationSystem published no `vegetation.sites`; cannot identify plants in merged geometry.");
  process.exit(1);
}

const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.05, 3000);

// The store, as the reference the complaint was phrased against. Its footprint
// is not published to a CPU probe, so this is the surveyed centre and eaves
// height: a denominator for a ratio, not a claim about the building.
const BUILDING = { x: 0, z: 30, height: 4.6 };

/**
 * Apparent height of a vertical stick of `h` metres standing at (x, z).
 *
 * Projects the base and the tip rather than using the small-angle
 * `h / distance` shortcut: a plant three metres from a 30 degree lens is nowhere
 * near the small-angle regime, and that shortcut is what would make an
 * oversized foreground object look reasonable in the report.
 */
function apparent(x, z, h, ground) {
  const y = ground(x, z);
  const base = new THREE.Vector3(x, y, z).project(camera);
  const tip = new THREE.Vector3(x, y + h, z).project(camera);
  const behind = new THREE.Vector3(x, y + h / 2, z).applyMatrix4(camera.matrixWorldInverse).z > 0;
  const px = (Math.abs(tip.y - base.y) / 2) * HEIGHT;
  const cx = ((tip.x + 1) / 2) * WIDTH;
  const cy = ((1 - tip.y) / 2) * HEIGHT;
  return { px, cx, cy, behind, ndcX: tip.x, ndcY: tip.y };
}

for (const shot of shots) {
  const pose = POSES[shot];
  const eye = pose.eye ?? 0;
  const camY = pose.pos[1] || groundHeight(pose.pos[0], pose.pos[2]) + eye;
  camera.fov = pose.fov;
  camera.aspect = WIDTH / HEIGHT;
  camera.position.set(pose.pos[0], camY, pose.pos[2]);
  camera.lookAt(pose.look[0], pose.look[1], pose.look[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const bh = apparent(BUILDING.x, BUILDING.z, BUILDING.height, groundHeight);

  const rows = [];
  for (const s of sites) {
    const a = apparent(s.x, s.z, s.height, groundHeight);
    if (a.behind) continue;
    // Generous margin: a plant whose centre is off frame while it covers a
    // third of the image is precisely the case this exists to find.
    if (Math.abs(a.ndcX) > 2.2 || Math.abs(a.ndcY) > 2.6) continue;
    rows.push({
      ...s,
      px: a.px,
      cx: a.cx,
      cy: a.cy,
      dist: Math.hypot(s.x - camera.position.x, s.z - camera.position.z),
      offscreen: Math.abs(a.ndcX) > 1 || Math.abs(a.ndcY) > 1,
    });
  }
  rows.sort((p, q) => q.px - p.px);

  console.log(`\n=== ${shot} ===  ${WIDTH}x${HEIGHT}, fov ${pose.fov}`);
  console.log(
    `  building reference: ${BUILDING.height.toFixed(1)} m at ${Math.hypot(
      BUILDING.x - camera.position.x,
      BUILDING.z - camera.position.z
    ).toFixed(1)} m  ->  ${bh.px.toFixed(0)} px = ${((bh.px / HEIGHT) * 100).toFixed(0)}% of frame height`
  );
  console.log(`  ${rows.length} plants in or near frame, tallest first:\n`);
  console.log("    apparent   frame%   vs bldg   true h    dist    kind      at");
  for (const r of rows.slice(0, 12)) {
    console.log(
      `    ${r.px.toFixed(0).padStart(6)} px ${((r.px / HEIGHT) * 100).toFixed(0).padStart(6)}% ` +
        `${(r.px / bh.px).toFixed(2).padStart(8)}x ${r.height.toFixed(2).padStart(7)} m ` +
        `${r.dist.toFixed(1).padStart(7)} m   ${r.kind.padEnd(9)} ` +
        `(${r.x.toFixed(1)}, ${r.z.toFixed(1)})  screen (${r.cx.toFixed(0)}, ${r.cy.toFixed(0)})` +
        (r.offscreen ? "  [centre off frame]" : "")
    );
  }

  // The verdict, so the tool has an opinion rather than a table. A plant that
  // out-measures the building it stands in front of is the complaint, stated.
  const worst = rows[0];
  if (worst && worst.px > bh.px) {
    console.log(
      `\n  OVERSIZED: a ${worst.height.toFixed(2)} m ${worst.kind} at ${worst.dist.toFixed(1)} m draws ` +
        `${(worst.px / bh.px).toFixed(1)}x the building's apparent height.`
    );
  }

  // How large the foliage *primitive* draws, which is a different question from
  // how large the plant draws and is the one the "cardboard" and "flat
  // quadrilateral patches" complaints are actually about.
  //
  // The thresholds are borrowed rather than invented, which is the point. The
  // car agent measured its own parts and established two numbers from parts that
  // demonstrably read: nothing on the car falls below 6 px, so its failures are
  // contrast rather than scale; and 56 px is legible, so a part above roughly
  // 50 px that does not read is a contrast or orientation fault and must not be
  // enlarged. Foliage is a different regime, but the *discipline* transfers
  // directly — derive the threshold from something that demonstrably reads
  // instead of from judgement.
  //
  // Applied to a foliage card the 56 px figure says something specific and
  // uncomfortable: above it, the viewer is inspecting the primitive's silhouette
  // rather than integrating a mass of them, and a flat alpha-tested quad has no
  // silhouette to inspect. So above 56 px the fix is never a smaller card — that
  // is the absolute-sizing fix, and it is already done — it is a different
  // primitive. Below about 6 px the card is sub-pixel and its shape is
  // irrelevant; cards are the right answer there and always were.
  //
  // Card sizes are the absolute figures the generators now use: pine needle
  // fascicles and sage leaf clusters, in metres, not fractions of the plant.
  const CARD_M = { pine: 0.11, sage: 0.12, sapling: 0.14, thistle: 0.09 };
  const pxPerRad = HEIGHT / (2 * Math.tan(((pose.fov / 2) * Math.PI) / 180));
  const LEGIBLE = 56;
  const SUBPIXEL = 6;
  let inspected = 0;
  let integrated = 0;
  let subpixel = 0;
  let biggest = null;
  for (const r of rows) {
    const m = CARD_M[r.kind] ?? 0.11;
    const cardPx = (m / r.dist) * pxPerRad;
    if (!biggest || cardPx > biggest.cardPx) biggest = { ...r, cardPx };
    if (cardPx >= LEGIBLE) inspected++;
    else if (cardPx >= SUBPIXEL) integrated++;
    else subpixel++;
  }
  console.log(
    `\n  foliage primitive, against the car's measured thresholds (>=${LEGIBLE} px inspected as a shape, ` +
      `<${SUBPIXEL} px sub-pixel):`
  );
  console.log(
    `    ${inspected} plant(s) with cards at or above ${LEGIBLE} px, ${integrated} between ` +
      `${SUBPIXEL} and ${LEGIBLE} px, ${subpixel} below ${SUBPIXEL} px`
  );
  if (biggest) {
    console.log(
      `    largest card: ${biggest.cardPx.toFixed(0)} px on a ${biggest.kind} at ${biggest.dist.toFixed(1)} m ` +
        `(${((CARD_M[biggest.kind] ?? 0.11) * 100).toFixed(0)} cm)`
    );
  }
  if (inspected > 0) {
    console.log(
      `    -> ${inspected} plant(s) are close enough that the card's silhouette is being read directly.\n` +
        `       A flat quad cannot pass at that size at any card dimension; this wants a different\n` +
        `       primitive at close range, not a smaller one.`
    );
  }
}
