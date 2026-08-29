#!/usr/bin/env node
/**
 * The building's plan, with no browser.
 *
 *   node tools/buildinglayout.mjs           # human-readable
 *   node tools/buildinglayout.mjs --json    # for another tool to consume
 *
 * ## Why this exists
 *
 * `BuildingSystem.init` cannot run under Node: it rasterises its textures, and
 * `document.createElement("canvas")` is not shimmable the way `location` is. So
 * every CPU-side harness that needed the building's blockers was stuck, and at
 * least one worked around it by assuming an **empty blocker list** — which does
 * not fail loudly, it quietly plants shrubs through the shelving.
 *
 * The plan is pure arithmetic and now lives in `src/gen/buildingLayout.ts`, free
 * of `document`, `window`, `location` and THREE materials. This tool is both the
 * documented way to read it from Node and the regression test that it stayed
 * importable: if someone adds a rasteriser to that module, this stops running.
 *
 * Consume `--json` rather than copying numbers. A second copy of a dimension is
 * how the impulse island nearly desynchronised its geometry from its collision
 * rect, and that failure is invisible — a shop that looks right and cannot be
 * walked.
 */

import {
  buildingBlockers,
  buildingFloorHeight,
  buildingFootprint,
  COOLER,
  COUNTER,
  GONDOLA_X,
  GONDOLA_Z,
  GRAB_BOTTLE,
  ISLAND,
  PLAN,
} from "../src/gen/buildingLayout.ts";

const floorY = buildingFloorHeight();
const blockers = buildingBlockers();
const footprint = buildingFootprint(floorY);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ floorY, footprint, blockers, PLAN, COOLER, COUNTER, GONDOLA_X, GONDOLA_Z, ISLAND, GRAB_BOTTLE }, null, 2));
  process.exit(0);
}

const f = (n) => n.toFixed(3).padStart(8);
console.log(`\nbuilding layout, no browser involved (node ${process.version})\n`);
console.log(`  finished floor level   ${floorY.toFixed(4)} m`);
console.log(
  `  footprint              x ${footprint.minX} .. ${footprint.maxX}   ` +
    `z ${footprint.minZ} .. ${footprint.maxZ}   wall ${footprint.wallThickness} m`
);
console.log(`  roof / parapet         ${footprint.roofY.toFixed(3)} / ${footprint.parapetY.toFixed(3)} m`);
console.log(`  grab bottle            (${GRAB_BOTTLE.x}, ${GRAB_BOTTLE.z}) at ${GRAB_BOTTLE.aboveFloor} m AFF`);
console.log(`  cooler                 ${COOLER.doors} doors over ${(COOLER.x1 - COOLER.x0).toFixed(2)} m, depth ${COOLER.depth} m`);
console.log(`\n  ${blockers.length} blockers:\n`);
console.log("        minX     maxX     minZ     maxZ    width    depth");
for (const b of blockers) {
  console.log(
    `    ${f(b.minX)} ${f(b.maxX)} ${f(b.minZ)} ${f(b.maxZ)} ` +
      `${f(b.maxX - b.minX)} ${f(b.maxZ - b.minZ)}`
  );
}

/*
 * The other half of the proof: construct the *system* under Node.
 *
 * The module above needs no browser by construction. `BuildingSystem` is the
 * thing siblings actually build, and it now takes a layout-only path when there
 * is no `document`, so a harness that registers the real system gets real
 * blockers instead of having to stub an empty list. Exercised here so the path
 * cannot rot unnoticed.
 */
if (process.argv.includes("--system")) {
  // Importing the system pulls in the whole `src/` graph, which is written for
  // Vite and so uses extensionless specifiers. Re-exec with the resolver hook
  // rather than asking the caller to remember a flag.
  if (!process.env.DS_TS_RESOLVE) {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      process.execPath,
      ["--import", "./tools/ts-resolve.mjs", ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, DS_TS_RESOLVE: "1" } }
    );
    process.exit(r.status ?? 1);
  }
  const THREE = await import("three");
  const { BuildingSystem } = await import("../src/systems/BuildingSystem.ts");

  const services = new Map();
  const game = {
    provide: (k, v) => services.set(k, v),
    tryGet: (k) => services.get(k) ?? null,
    require: (k) => {
      if (!services.has(k)) throw new Error(`missing service ${k}`);
      return services.get(k);
    },
    serviceKeys: () => [...services.keys()],
  };
  const sys = new BuildingSystem();
  sys.init({ game, scene: new THREE.Scene(), camera: null, renderer: null, shot: null });

  const got = game.tryGet("building.blockers");
  const collide = game.tryGet("building.collide");
  console.log(`  BuildingSystem constructed under Node`);
  console.log(`    headless marker        ${game.tryGet("building.headless")}`);
  console.log(`    services              ${game.serviceKeys().join(", ")}`);
  console.log(`    blockers from system   ${got.length}  (module says ${blockers.length})`);
  if (got.length !== blockers.length) {
    console.error("!! the system and the module disagree about the blocker count");
    process.exit(1);
  }
  // Positive control on collision: a point inside the west wall must be pushed
  // out, and a point in the middle of the clear corridor must not move.
  const inWall = new THREE.Vector3(PLAN.x0 + 0.05, floorY, 35);
  const inAisle = new THREE.Vector3(-0.4, floorY, 35);
  const before = inAisle.clone();
  const hitWall = collide(inWall);
  const hitAisle = collide(inAisle);
  console.log(`    collide inside wall    ${hitWall ? "pushed out" : "NOT PUSHED - wrong"}`);
  console.log(
    `    collide in corridor    ${hitAisle || !inAisle.equals(before) ? "MOVED - wrong" : "left alone"}`
  );
  if (!hitWall || hitAisle) {
    console.error("!! collision service is not behaving headlessly");
    process.exit(1);
  }
}

// Cheap invariants, so a bad edit to the plan fails here rather than in a frame.
const bad = blockers.filter((b) => !(b.maxX > b.minX && b.maxZ > b.minZ));
if (bad.length) {
  console.error(`\n!! ${bad.length} blocker(s) are inverted or degenerate:`, bad);
  process.exit(1);
}
console.log(`\n  all ${blockers.length} rectangles non-degenerate\n`);
