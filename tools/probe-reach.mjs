#!/usr/bin/env node
/**
 * Can the player *walk* to a thing, and by how much?
 *
 *   node tools/probe-reach.mjs                 # build, probe, report
 *   node tools/probe-reach.mjs --no-build      # reuse .shot-reach-build
 *
 * ## Why this exists
 *
 * Perf measured that the cooler doors and the grab bottle cannot be reached on
 * foot, and that the back of the store opens at a body radius of 0.30 m against
 * the player's 0.32. That is a complete diagnosis of *whether*. It stops short
 * of *where*, and a binary flood fill cannot go further: it reports that a
 * region is unreachable, never which pair of rectangles closed the gate.
 *
 * A binary flood also has a grid artefact that matters at this scale. Whether a
 * cell is free is tested at its centre, so a corridor with 60 mm of freedom is
 * passable only if a centre happens to land inside that 60 mm window. Change
 * the pitch and the answer changes, in both directions — a real gap can be
 * missed and a real path can be broken.
 *
 * So this measures the continuous quantity instead. Clearance is computed per
 * cell as the distance to the nearest blocker, and the route is found by
 * widest-path search: of all the ways to get there, take the one whose
 * narrowest point is widest. The answer is one number per target — **the
 * tightest gap on the best route** — and the player passes when that number
 * exceeds their body radius. Radius sweeps fall out of it for free, and so does
 * margin, which a yes/no cannot express: a gap that opens at exactly 0.32 is
 * not fixed, it is balanced on another system's constant.
 *
 * It then walks the best path back to the cell where the bottleneck occurs and
 * names the two nearest blockers with the owning service key, which turns
 * "somewhere in the route to the cooler" into two rectangles.
 *
 * Coordinate-free in the sense of NOTES.md case 33: it takes no rectangle from
 * the operator, and its targets come from the service registry rather than
 * being typed in, so it cannot be accused of looking where the answer is.
 *
 * Reads the live `window.__GAME` registry, so it sees every `*.blockers`
 * producer and cannot disagree with the game about what is solid. The entry
 * doorway is open in that set, which is the state a player walks through.
 *
 * Teardown contract: preview server and browser registered with one shutdown
 * routine wired to every exit path before either starts.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertHardwareGpu, launchOptions } from "./gpu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5112;
/**
 * `.shot-reach-build/`, not a subdirectory of `.shot-build/`. Three runs died on
 * a page that loaded and never became ready, and one on a bare 404, because a
 * sibling builds into `.shot-build/` root with `emptyOutDir` and takes every
 * subdirectory with it. Matches `.shot*-build/` in `.gitignore`.
 */
const OUT_DIR = ".shot-reach-build";
const READY_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);
const DO_BUILD = !argv.includes("--no-build");
/** Run only the strafe control and stop, skipping the flood and the walk. */
const STRAFE_ONLY = argv.includes("--strafe");
const QUERY = (argv.find((a) => a.startsWith("--query=")) || "").slice(8);

/** Grid pitch for the clearance field. */
const CELL = 0.1;
/** InteractionSystem's pick range. A target is reachable if a walkable cell is inside it. */
const REACH = 2.2;

let shutdownDone = false;
const closers = [];
async function shutdown(reason) {
  if (shutdownDone) return;
  shutdownDone = true;
  if (reason) console.error(`\n[reach] shutting down: ${reason}`);
  for (const c of closers.reverse()) {
    try {
      await c();
    } catch (e) {
      console.error("[reach] closer failed", e);
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await shutdown(sig);
    process.exit(1);
  });
}
process.on("uncaughtException", async (e) => {
  await shutdown(`uncaughtException ${e?.stack || e}`);
  process.exit(1);
});
process.on("unhandledRejection", async (e) => {
  await shutdown(`unhandledRejection ${e?.stack || e}`);
  process.exit(1);
});

async function main() {
  const { build, preview } = await import("vite");
  const { chromium } = await import("playwright");

  if (DO_BUILD) {
    console.log("[reach] building...");
    await build({ root: ROOT, logLevel: "error", build: { outDir: OUT_DIR, emptyOutDir: true } });
  }

  const server = await preview({
    root: ROOT,
    logLevel: "warn",
    build: { outDir: OUT_DIR },
    preview: { port: PORT, strictPort: true, host: "127.0.0.1", open: false },
  });
  closers.push(async () => {
    await new Promise((res) => server.httpServer.close(() => res()));
  });

  const browser = await chromium.launch(launchOptions());
  closers.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await assertHardwareGpu(page, "[reach]");

  page.on("pageerror", (e) => console.error("[reach] page error:", e.message));

  // No shot preset: PlayerSystem must be live, because a preset disables it and
  // this whole class of defect hides behind that (NOTES case 35).
  const url = QUERY ? `http://127.0.0.1:${PORT}/?${QUERY}` : `http://127.0.0.1:${PORT}/`;
  await page.goto(url, { waitUntil: "load", timeout: READY_TIMEOUT_MS });

  // A manual poll, not `page.waitForFunction`, and not `__SCENE_READY`. That
  // flag needs six rendered frames and the helper polls on
  // requestAnimationFrame; with no shot preset the tab is backgrounded and rAF
  // throttles to roughly nothing, so a page that had booted fine sat at frame 3
  // for two minutes and four runs timed out against services that had all
  // published. `page.evaluate` is unaffected. This probe renders nothing, so the
  // condition it depends on is publication, not frames.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate(
      () => (window.__GAME?.serviceKeys?.() ?? []).some((k) => k.endsWith(".blockers"))
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    const why = await page.evaluate(() => ({
      hasGame: !!window.__GAME,
      errors: (window.__SYSTEM_ERRORS || []).map((e) => `${e.system}: ${e.message}`).slice(0, 8),
      keys: window.__GAME?.serviceKeys?.() ?? null,
    }));
    throw new Error(`[reach] no blocker services after ${READY_TIMEOUT_MS} ms: ${JSON.stringify(why)}`);
  }

  // Does requestAnimationFrame tick at all here? If it does, the route can be
  // confirmed by walking it with the real controller; if it does not, this probe
  // can only report the collision field and the walk belongs to a harness that
  // gets frames.
  const rafRate = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 > 1000) res(n);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => res(n), 3000);
      })
  );
  console.log(`[reach] requestAnimationFrame ticked ${rafRate} times in ~1 s`);

  /*
   * Positive control: does `KeyD` move the player to their own right?
   *
   * This exists because I reported PlayerSystem's strafe as inverted on the
   * strength of one observation — facing what I called north, `KeyD` moved the
   * camera west — and then argued about which axis was north. That is the same
   * shape as the bottle probe aiming a metre over its target: a real measurement
   * whose interpretation names the wrong cause (NOTES case 53).
   *
   * The way out is to stop naming axes. Column 0 of `camera.matrixWorld` *is*
   * the camera's right in world space, so projecting the displacement onto it
   * answers the only question a player has, from any facing, with no convention
   * to get wrong. World-axis components are reported alongside purely so the
   * numbers can be checked by hand.
   */
  const strafe = await page.evaluate(async () => {
    const game = window.__GAME;
    const cam = game.camera;
    const floor = game.tryGet("building.floorHeight");
    const ground = game.tryGet("groundHeight");
    const surface = (x, z) => (floor ?? ground)(x, z);
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    const key = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));

    // Open ground well clear of anything solid, so nothing can slide the result.
    const HOME = { x: -14, z: 2 };
    const facings = [
      { name: "+Z", dx: 0, dz: 1 },
      { name: "-Z", dx: 0, dz: -1 },
      { name: "+X", dx: 1, dz: 0 },
      { name: "-X", dx: -1, dz: 0 },
    ];
    const out = [];
    for (const f of facings) {
      for (const k of ["KeyD", "KeyA"]) {
        const y = surface(HOME.x, HOME.z) + 1.65;
        cam.position.set(HOME.x, y, HOME.z);
        cam.lookAt(HOME.x + f.dx * 10, y, HOME.z + f.dz * 10);
        for (let i = 0; i < 20; i++) await frame();

        cam.updateMatrixWorld(true);
        const e = cam.matrixWorld.elements;
        // Column 0 of the world matrix: the camera's right, in world space.
        const rx = e[0];
        const rz = e[2];
        const from = { x: cam.position.x, z: cam.position.z };

        key("keydown", k);
        for (let i = 0; i < 45; i++) {
          cam.lookAt(HOME.x + f.dx * 10, cam.position.y, HOME.z + f.dz * 10);
          await frame();
        }
        key("keyup", k);
        for (let i = 0; i < 15; i++) await frame();

        const dx = cam.position.x - from.x;
        const dz = cam.position.z - from.z;
        out.push({
          facing: f.name,
          key: k,
          worldDelta: [Number(dx.toFixed(3)), Number(dz.toFixed(3))],
          cameraRight: [Number(rx.toFixed(3)), Number(rz.toFixed(3))],
          alongCameraRight: Number((dx * rx + dz * rz).toFixed(3)),
          distance: Number(Math.hypot(dx, dz).toFixed(3)),
        });
      }
    }
    return out;
  });

  console.log("");
  console.log("[reach] strafe control: does KeyD move the player to their own right?");
  console.log("        (projection onto column 0 of camera.matrixWorld, which is that right)");
  console.log("");
  for (const r of strafe) {
    const verdict =
      r.distance < 0.15
        ? "did not move"
        : (r.key === "KeyD") === r.alongCameraRight > 0
          ? "correct"
          : "INVERTED";
    console.log(
      `  facing ${r.facing.padEnd(3)} ${r.key}  moved (${r.worldDelta[0]}, ${r.worldDelta[1]})  ` +
        `camera right (${r.cameraRight[0]}, ${r.cameraRight[1]})  ` +
        `along right ${r.alongCameraRight > 0 ? "+" : ""}${r.alongCameraRight}  ${verdict}`
    );
  }
  console.log("");

  if (STRAFE_ONLY) {
    await shutdown(null);
    process.exit(0);
  }

  const report = await page.evaluate(
    ({ cell, reach }) => {
      const game = window.__GAME;

      // Every blocker, tagged with the service that published it, so a pinch is
      // reported as an owner rather than as an anonymous rectangle.
      const groups = [];
      for (const key of game.serviceKeys()) {
        if (!key.endsWith(".blockers")) continue;
        const list = game.tryGet(key);
        if (!Array.isArray(list)) continue;
        for (const b of list) {
          if (b && typeof b.minX === "number") groups.push({ key, b });
        }
      }

      const foot = game.tryGet("building.footprint");

      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const { b } of groups) {
        x0 = Math.min(x0, b.minX);
        x1 = Math.max(x1, b.maxX);
        z0 = Math.min(z0, b.minZ);
        z1 = Math.max(z1, b.maxZ);
      }
      x0 -= 4;
      x1 += 4;
      z0 -= 4;
      z1 += 4;

      const nx = Math.ceil((x1 - x0) / cell);
      const nz = Math.ceil((z1 - z0) / cell);
      const N = nx * nz;
      const cx = (i) => x0 + (i + 0.5) * cell;
      const cz = (j) => z0 + (j + 0.5) * cell;

      /** Clearance: distance from a point to the nearest blocker, 0 if inside one. */
      const clearanceAt = (px, pz) => {
        let best = Infinity;
        for (const { b } of groups) {
          if (px > b.minX && px < b.maxX && pz > b.minZ && pz < b.maxZ) return 0;
          const dx = Math.max(b.minX - px, 0, px - b.maxX);
          const dz = Math.max(b.minZ - pz, 0, pz - b.maxZ);
          const d = Math.hypot(dx, dz);
          if (d < best) best = d;
        }
        return best;
      };

      const C = new Float32Array(N);
      for (let j = 0; j < nz; j++) {
        const pz = cz(j);
        for (let i = 0; i < nx; i++) C[j * nx + i] = clearanceAt(cx(i), pz);
      }

      /**
       * Widest-path search from outside the world, which is always walkable.
       * `best[k]` is the widest bottleneck of any route reaching k. A max-heap
       * keyed on that value gives the exact answer in one pass, and the parent
       * array lets the bottleneck cell itself be recovered afterwards.
       */
      const best = new Float32Array(N);
      const parent = new Int32Array(N).fill(-1);
      const done = new Uint8Array(N);
      const heapV = [0];
      const heapK = [0];
      // Seeded at the player's actual spawn, not at a world corner, so the route
      // this returns is one a player could follow from where the game puts them.
      const spawn = game.camera.position;
      const si = Math.min(nx - 1, Math.max(0, Math.round((spawn.x - x0) / cell - 0.5)));
      const sj = Math.min(nz - 1, Math.max(0, Math.round((spawn.z - z0) / cell - 0.5)));
      const seed = sj * nx + si;
      best[seed] = C[seed];
      heapV[0] = C[seed];
      heapK[0] = seed;
      let hn = 1;
      const push = (v, k) => {
        let i = hn++;
        heapV[i] = v;
        heapK[i] = k;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapV[p] >= heapV[i]) break;
          const tv = heapV[p];
          const tk = heapK[p];
          heapV[p] = heapV[i];
          heapK[p] = heapK[i];
          heapV[i] = tv;
          heapK[i] = tk;
          i = p;
        }
      };
      const pop = () => {
        const rv = heapV[0];
        const rk = heapK[0];
        hn--;
        if (hn > 0) {
          heapV[0] = heapV[hn];
          heapK[0] = heapK[hn];
          let i = 0;
          for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < hn && heapV[l] > heapV[m]) m = l;
            if (r < hn && heapV[r] > heapV[m]) m = r;
            if (m === i) break;
            const tv = heapV[m];
            const tk = heapK[m];
            heapV[m] = heapV[i];
            heapK[m] = heapK[i];
            heapV[i] = tv;
            heapK[i] = tk;
            i = m;
          }
        }
        return [rv, rk];
      };

      while (hn > 0) {
        const [v, k] = pop();
        if (done[k]) continue;
        done[k] = 1;
        const i = k % nx;
        const j = (k - i) / nx;
        const nb = [
          i + 1 < nx ? k + 1 : -1,
          i > 0 ? k - 1 : -1,
          j + 1 < nz ? k + nx : -1,
          j > 0 ? k - nx : -1,
        ];
        for (const m of nb) {
          if (m < 0 || done[m]) continue;
          const w = Math.min(v, C[m]);
          if (w > best[m]) {
            best[m] = w;
            parent[m] = k;
            push(w, m);
          }
        }
      }

      /*
       * A second search, for a different question.
       *
       * The widest path answers "can the player get there and what is the
       * tightest gap", and it is the right instrument for that. It is the wrong
       * instrument for "what would a player walk", because maximising the
       * bottleneck makes it *prefer* a wide detour to a narrow shortcut — by
       * construction it returns the longest acceptable route, so a detour ratio
       * measured on it says more about the search than about the shop.
       *
       * A player walks the shortest route their body fits through. That is a
       * plain shortest path restricted to cells with clearance above the body
       * radius: same grid, same clearance field, Dijkstra on distance with a
       * hard admission test instead of max-min on width. Reporting both is the
       * point — the widest path says whether the shop is passable, the shortest
       * says whether it is crossable.
       */
      const RADIUS = 0.32;
      /** North of this is inside the shop; the entry threshold sits at z 31.5–31.7. */
      const DOORWAY_Z = 31.8;
      const dist = new Float64Array(N).fill(Infinity);
      const spar = new Int32Array(N).fill(-1);
      const sdone = new Uint8Array(N);
      const admits = (k) => C[k] > RADIUS + 0.005;
      {
        const hv = [0];
        const hk = [seed];
        let n2 = 1;
        const push2 = (v, k) => {
          let i = n2++;
          hv[i] = v;
          hk[i] = k;
          while (i > 0) {
            const p2 = (i - 1) >> 1;
            if (hv[p2] <= hv[i]) break;
            const tv = hv[p2];
            const tk = hk[p2];
            hv[p2] = hv[i];
            hk[p2] = hk[i];
            hv[i] = tv;
            hk[i] = tk;
            i = p2;
          }
        };
        const pop2 = () => {
          const rv = hv[0];
          const rk = hk[0];
          n2--;
          if (n2 > 0) {
            hv[0] = hv[n2];
            hk[0] = hk[n2];
            let i = 0;
            for (;;) {
              const l = 2 * i + 1;
              const r = l + 1;
              let m = i;
              if (l < n2 && hv[l] < hv[m]) m = l;
              if (r < n2 && hv[r] < hv[m]) m = r;
              if (m === i) break;
              const tv = hv[m];
              const tk = hk[m];
              hv[m] = hv[i];
              hk[m] = hk[i];
              hv[i] = tv;
              hk[i] = tk;
              i = m;
            }
          }
          return [rv, rk];
        };
        // The spawn is admitted unconditionally: the player is standing there, so
        // a clearance test that excluded it would report an empty world.
        dist[seed] = 0;
        hv[0] = 0;
        while (n2 > 0) {
          const [d, k] = pop2();
          if (sdone[k]) continue;
          sdone[k] = 1;
          const i = k % nx;
          const j = (k - i) / nx;
          const nb2 = [
            [i + 1 < nx ? k + 1 : -1, cell],
            [i > 0 ? k - 1 : -1, cell],
            [j + 1 < nz ? k + nx : -1, cell],
            [j > 0 ? k - nx : -1, cell],
            [i + 1 < nx && j + 1 < nz ? k + 1 + nx : -1, cell * Math.SQRT2],
            [i > 0 && j + 1 < nz ? k - 1 + nx : -1, cell * Math.SQRT2],
            [i + 1 < nx && j > 0 ? k + 1 - nx : -1, cell * Math.SQRT2],
            [i > 0 && j > 0 ? k - 1 - nx : -1, cell * Math.SQRT2],
          ];
          for (const [m, w] of nb2) {
            if (m < 0 || sdone[m] || !admits(m)) continue;
            const nd = d + w;
            if (nd < dist[m]) {
              dist[m] = nd;
              spar[m] = k;
              push2(nd, m);
            }
          }
        }
      }

      // Targets from the registry, not typed in, so they cannot drift from
      // where the objects actually are.
      const targets = [];
      const bottle = game.tryGet("building.grabBottle");
      if (bottle) {
        const w = bottle.getWorldPosition
          ? bottle.getWorldPosition(bottle.position.clone())
          : bottle.position;
        targets.push({ name: "grab bottle", x: w.x, y: w.y, z: w.z });
      }
      const doors = game.tryGet("building.coolerDoors");
      if (Array.isArray(doors) && doors.length) {
        const d = doors[Math.floor(doors.length / 2)];
        const w = d.getWorldPosition ? d.getWorldPosition(d.position.clone()) : d.position;
        targets.push({ name: "cooler door", x: w.x, y: w.y, z: w.z });
      }
      const eDoor = game.tryGet("building.entryDoor");
      if (eDoor) {
        const w = eDoor.getWorldPosition
          ? eDoor.getWorldPosition(eDoor.position.clone())
          : eDoor.position;
        targets.push({ name: "entry door", x: w.x, z: w.z });
      }
      if (foot) {
        const mx = (foot.minX + foot.maxX) / 2;
        targets.push({ name: "store back centre", x: mx, z: foot.maxZ - 1.4 });
        targets.push({ name: "store mid centre", x: mx, z: (foot.minZ + foot.maxZ) / 2 });
      }

      /** Does the segment a->b cross an axis-aligned rect? Slab test. */
      const segHitsRect = (ax, az, bx, bz, r) => {
        const dx = bx - ax;
        const dz = bz - az;
        let t0 = 0;
        let t1 = 1;
        for (const [p, d, lo, hi] of [
          [ax, dx, r.minX, r.maxX],
          [az, dz, r.minZ, r.maxZ],
        ]) {
          if (Math.abs(d) < 1e-9) {
            if (p < lo || p > hi) return false;
            continue;
          }
          let ta = (lo - p) / d;
          let tb = (hi - p) / d;
          if (ta > tb) {
            const s = ta;
            ta = tb;
            tb = s;
          }
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) return false;
        }
        return true;
      };

      /**
       * Widest bottleneck of any route that gets within `reach` of a target
       * *and can see it*.
       *
       * The first version omitted the sight line and every target passed with
       * half a metre of margin, because the widest route ran round the outside
       * of the building and stood 2.2 m from the bottle with the back wall in
       * between. A Euclidean reach with no occlusion test measures a distance,
       * not an interaction; `InteractionSystem` picks by raycast.
       *
       * Blockers that contain the target are skipped, since the cooler cabinet
       * is the thing the bottle sits in and is interacted with through its own
       * open front.
       */
      const solve = (t) => {
        const occluders = groups.filter(
          ({ b }) => !(t.x > b.minX && t.x < b.maxX && t.z > b.minZ && t.z < b.maxZ)
        );
        let bv = -1;
        let bk = -1;
        // Cells within reach of the target that the shortest search admitted and
        // that can actually see it. The same LOS test as the widest path uses.
        const admissible = [];
        const i0 = Math.max(0, Math.floor((t.x - reach - x0) / cell));
        const i1 = Math.min(nx - 1, Math.ceil((t.x + reach - x0) / cell));
        const j0 = Math.max(0, Math.floor((t.z - reach - z0) / cell));
        const j1 = Math.min(nz - 1, Math.ceil((t.z + reach - z0) / cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const px = cx(i);
            const pz = cz(j);
            if (Math.hypot(px - t.x, pz - t.z) > reach) continue;
            const k = j * nx + i;
            let blocked = false;
            for (const { b } of occluders) {
              if (segHitsRect(px, pz, t.x, t.z, b)) {
                blocked = true;
                break;
              }
            }
            if (blocked) continue;
            if (Number.isFinite(dist[k])) admissible.push(k);
            if (best[k] <= bv) continue;
            bv = best[k];
            bk = k;
          }
        }
        if (bk < 0) return null;

        // Walk the route back to the cell that set the bottleneck, and name the
        // two blockers nearest it. That is the gate, reported as owners.
        let at = bk;
        let pinchK = bk;
        while (at >= 0) {
          if (C[at] <= bv + 1e-4) pinchK = at;
          at = parent[at];
        }
        const pi = pinchK % nx;
        const pj = (pinchK - pi) / nx;
        const px = cx(pi);
        const pz = cz(pj);
        const near = [];
        for (const g of groups) {
          const b = g.b;
          const dx = Math.max(b.minX - px, 0, px - b.maxX);
          const dz = Math.max(b.minZ - pz, 0, pz - b.maxZ);
          near.push({ d: Math.hypot(dx, dz), g });
        }
        near.sort((a, b) => a.d - b.d);

        // The route itself, decimated to roughly 0.7 m, so the controller can be
        // driven along it. Every cell on a widest path has clearance at least
        // the bottleneck, so these waypoints are all further from a blocker than
        // the body radius.
        const cells = [];
        for (let c = bk; c >= 0; c = parent[c]) cells.push(c);
        cells.reverse();

        /*
         * How far a player actually walks, from the shortest admissible route
         * rather than the widest one, and split at the threshold.
         *
         * The whole-journey figure is dominated by crossing the forecourt, which
         * is not the number in question. The film's problem is the *interior*:
         * 4.99 m of straight line from the door to the cooler, walked as 18.8 m.
         * So the interior leg is measured on its own, from the first cell past
         * the doorway line to the target.
         */
        let shortestK = -1;
        let shortestD = Infinity;
        for (const k of admissible) {
          if (dist[k] < shortestD) {
            shortestD = dist[k];
            shortestK = k;
          }
        }
        let insideLen = 0;
        let insideFrom = null;
        /*
         * The tightest point on the *shortest* route, which is a different number
         * from the widest path's bottleneck and, for this question, the decisive
         * one. The widest path reports the gate on the safest route; this reports
         * how much room the route a player would actually take leaves them.
         *
         * A route can be admissible and still be unwalkable in practice: a gap
         * giving 30 mm of margin passes a grid test and stops a driven controller
         * dead, because no steering rule holds a line that well. That gap is what
         * has to be reported, not the fact that a path exists through it.
         */
        let sPinch = Infinity;
        let sPinchAt = null;
        let sRoute = [];
        if (shortestK >= 0 && Number.isFinite(shortestD)) {
          const scells = [];
          for (let c = shortestK; c >= 0; c = spar[c]) scells.push(c);
          scells.reverse();
          let lx = null;
          let lz = null;
          for (let n = 0; n < scells.length; n++) {
            const ci = scells[n] % nx;
            const pxs = cx(ci);
            const pzs = cz((scells[n] - ci) / nx);
            if (pzs > DOORWAY_Z - 1.5 && C[scells[n]] < sPinch) {
              sPinch = C[scells[n]];
              sPinchAt = [Number(pxs.toFixed(2)), Number(pzs.toFixed(2))];
            }
            const far = lx === null || Math.hypot(pxs - lx, pzs - lz) >= 0.7;
            if (far || n === scells.length - 1) {
              sRoute.push([Number(pxs.toFixed(2)), Number(pzs.toFixed(2))]);
              lx = pxs;
              lz = pzs;
            }
          }
          for (let n = 1; n < scells.length; n++) {
            const ai = scells[n - 1] % nx;
            const bi = scells[n] % nx;
            const az = cz((scells[n - 1] - ai) / nx);
            const bz = cz((scells[n] - bi) / nx);
            if (az < DOORWAY_Z && bz < DOORWAY_Z) continue;
            if (insideFrom === null) insideFrom = [Number(cx(ai).toFixed(2)), Number(az.toFixed(2))];
            insideLen += Math.hypot(cx(bi) - cx(ai), bz - az);
          }
        }
        const insideStraight =
          insideFrom === null ? null : Math.hypot(t.x - insideFrom[0], t.z - insideFrom[1]);

        const route = [];
        let lastX = null;
        let lastZ = null;
        for (let n = 0; n < cells.length; n++) {
          const ci = cells[n] % nx;
          const cj = (cells[n] - ci) / nx;
          const px2 = cx(ci);
          const pz2 = cz(cj);
          const far = lastX === null || Math.hypot(px2 - lastX, pz2 - lastZ) >= 0.7;
          if (far || n === cells.length - 1) {
            route.push([Number(px2.toFixed(2)), Number(pz2.toFixed(2))]);
            lastX = px2;
            lastZ = pz2;
          }
        }

        return {
          name: t.name,
          target: [Number(t.x.toFixed(2)), Number(t.z.toFixed(2))],
          targetY: t.y === undefined ? null : Number(t.y.toFixed(2)),
          route,
          walk: Number.isFinite(shortestD) ? Number(shortestD.toFixed(2)) : null,
          insideLen: Number(insideLen.toFixed(2)),
          insideStraight: insideStraight === null ? null : Number(insideStraight.toFixed(2)),
          insideFrom,
          insideDetour:
            insideStraight === null || insideStraight < 0.2
              ? null
              : Number((insideLen / insideStraight).toFixed(2)),
          sPinch: Number.isFinite(sPinch) ? Number(sPinch.toFixed(3)) : null,
          sPinchAt,
          sRoute,
          bottleneck: Number(bv.toFixed(3)),
          at: [Number(px.toFixed(2)), Number(pz.toFixed(2))],
          between: near.slice(0, 2).map((n) => ({
            key: n.g.key,
            d: Number(n.d.toFixed(3)),
            rect: {
              minX: n.g.b.minX,
              maxX: n.g.b.maxX,
              minZ: n.g.b.minZ,
              maxZ: n.g.b.maxZ,
            },
          })),
        };
      };

      return {
        cell,
        grid: [nx, nz],
        spawn: [Number(spawn.x.toFixed(2)), Number(spawn.z.toFixed(2))],
        keys: [...new Set(groups.map((g) => g.key))],
        blockers: groups.length,
        results: targets.map(solve).filter(Boolean),
      };
    },
    { cell: CELL, reach: REACH }
  );

  console.log(`\n[reach] grid ${report.grid[0]}x${report.grid[1]} @ ${report.cell} m`);
  console.log(`[reach] ${report.blockers} blockers from ${report.keys.join(", ")}`);
  console.log(`[reach] widest-path bottleneck per target; the player needs > BODY_RADIUS 0.32 m\n`);
  for (const r of report.results) {
    const pass = r.bottleneck > 0.32;
    const margin = ((r.bottleneck - 0.32) * 1000).toFixed(0);
    console.log(
      `  ${r.name.padEnd(18)} ${r.bottleneck.toFixed(3)} m  ${pass ? "PASS" : "FAIL"}  ` +
        `shortest walk ${r.walk ?? "unreachable"} m  ` +
        (r.insideDetour === null
          ? ""
          : `inside: ${r.insideLen} m for ${r.insideStraight} m straight (${r.insideDetour}x)  `) +
        (r.sPinch === null
          ? ""
          : `direct route tightest ${r.sPinch} m = ${((r.sPinch - 0.32) * 1000).toFixed(0)} mm margin ` +
            `at (${r.sPinchAt[0]}, ${r.sPinchAt[1]})  `) +
        `margin ${margin >= 0 ? "+" : ""}${margin} mm   pinch at (${r.at[0]}, ${r.at[1]})`
    );
    for (const b of r.between) {
      console.log(
        `        ${b.d.toFixed(3)} m from ${b.key}  x[${b.rect.minX}, ${b.rect.maxX}] z[${b.rect.minZ}, ${b.rect.maxZ}]`
      );
    }
  }
  console.log(`[reach] spawn (${report.spawn[0]}, ${report.spawn[1]})`);
  console.log("");

  /*
   * The walked confirmation.
   *
   * Everything above is a model of the collision field, and a model is how this
   * defect survived: Perf's grid said unreachable at the player's radius, mine
   * says reachable with margin, and they disagree because a binary flood tests
   * cell centres and its answer moves with the pitch. So drive the real
   * controller — PlayerSystem, its own body radius, its own portal narrowing,
   * its own least-movement slide — from the spawn the game chose, holding W
   * along the route, and ask InteractionSystem's own picker what the crosshair
   * is on at the end. A player either arrives or does not.
   */
  const walk = async (name, alsoProbe) => {
    const r = report.results.find((x) => x.name === name);
    if (!r) return null;
    const probeTargets = (alsoProbe || [])
      .map((n) => report.results.find((x) => x.name === n))
      .filter(Boolean)
      .map((x) => ({ name: x.name, target: x.target, targetY: x.targetY }));
    return page.evaluate(
      async ({ route, target, probeTargets }) => {
        const game = window.__GAME;
        const cam = game.camera;
        const floor = game.tryGet("building.floorHeight");
        const ground = game.tryGet("groundHeight");
        const surface = (x, z) => (floor ?? ground)(x, z);
        const frame = () => new Promise((res) => requestAnimationFrame(res));
        const key = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));

        const eyeAt = (x, z) => surface(x, z) + 1.65;
        const trace = [];
        const doorClicks = [];
        /** Doors already actuated: the interaction is a toggle, so never twice. */
        const actuated = new Set();

        key("keydown", "KeyW");
        let stalled = false;
        for (let w = 1; w < route.length; w++) {
          const [wx, wz] = route[w];
          let last = Infinity;
          let stuck = 0;
          let n = 0;
          while (n++ < 900) {
            cam.lookAt(wx, eyeAt(wx, wz), wz);
            await frame();
            const d = Math.hypot(cam.position.x - wx, cam.position.z - wz);
            if (d < 0.4) break;
            stuck = last - d < 1e-4 ? stuck + 1 : 0;
            last = d;
            if (stuck > 60) {
              stalled = true;
              break;
            }
            /*
             * A shut door is not a blocker, but a player would open it, and the
             * approach shot has to. Open whatever the crosshair finds on the way —
             * but **each door at most once**, because the interaction is a toggle.
             *
             * Without the guard this walked into its own second click: on a route
             * that lingers near the jamb it re-probed the entry door and shut it,
             * then stalled against a door it had opened itself. The report read
             * `opened: entry-door at 1.52 m, at 0.10 m, at 0.22 m` — three
             * openings of one door, which is one opening and two closings.
             *
             * It stayed hidden because the widest-path route passes the doorway
             * once and keeps going, so the only route that could expose it was the
             * direct one, which nothing walked until now.
             */
            if (n % 30 === 0 && window.__INTERACT) {
              const hit = window.__INTERACT.probe();
              /*
               * Only doors that stand *in the route*, which here means the entry
               * door. The first version opened anything named "door" and, once
               * the route was direct enough to pass close to the cooler bank, it
               * opened two merchandise doors in passing and left their leaves
               * across the aisle — so the grab then failed and the report read
               * like an aisle-clearance defect. A walk harness must not actuate
               * scenery it merely walks past; the cooler is opened deliberately,
               * later, as part of the interaction being tested.
               */
              if (
                hit &&
                /entry/i.test(hit.name) &&
                hit.distance < 2.0 &&
                !actuated.has(hit.name)
              ) {
                const did = window.__INTERACT.click();
                if (did) {
                  actuated.add(did.name);
                  doorClicks.push(`${did.kind}:${did.name} at ${did.distance.toFixed(2)} m`);
                }
              }
            }
          }
          trace.push({
            waypoint: [wx, wz],
            at: [Number(cam.position.x.toFixed(2)), Number(cam.position.z.toFixed(2))],
            stalled,
          });
          if (stalled) break;
        }
        key("keyup", "KeyW");
        for (let i = 0; i < 20; i++) await frame();

        const arrivedAt = [Number(cam.position.x.toFixed(2)), Number(cam.position.z.toFixed(2))];

        // Face the target and ask the game's own picker.
        const [tx, tz] = target;
        cam.lookAt(tx, eyeAt(tx, tz) + 0.15, tz);
        await frame();
        await frame();
        const probe = window.__INTERACT ? window.__INTERACT.probe() : null;

        // One arrival, then look at each interactable in turn. Walking a second
        // route from here would be walking back to the spawn: the route was
        // computed from the spawn cell and the player is no longer in it, which
        // is what the first version of this did.
        // Aim at the object's own height. The first version aimed at
        // eyeAt(x,z) + 0.15, which is 1.80 m — the bottle sits at 0.65 m, so
        // every "the crosshair is on the cooler door" reading was a ray passing
        // a metre above the bottle, and the door-swing conclusion it suggested
        // was an artefact of the probe.
        const aimY = (pt) => (pt.targetY === null || pt.targetY === undefined
          ? eyeAt(pt.target[0], pt.target[1]) + 0.15
          : pt.targetY);

        const picks = [];
        for (const pt of probeTargets) {
          cam.lookAt(pt.target[0], aimY(pt), pt.target[1]);
          await frame();
          await frame();
          const hit = window.__INTERACT ? window.__INTERACT.probe() : null;
          picks.push({
            name: pt.name,
            distance: Number(Math.hypot(cam.position.x - pt.target[0], cam.position.z - pt.target[1]).toFixed(2)),
            hit,
          });
        }

        /*
         * Then finish the specified interaction. Standing in front of the
         * cabinet the crosshair lands on the closed cooler door, not on the
         * bottle behind it, which is correct: the brief's interaction is open
         * the cooler *then* take the bottle. Reachable is not the same as
         * completable, so drive both steps.
         */
        let opened = null;
        let taken = null;
        const doors = game.tryGet("building.coolerDoors") || [];
        const bottle = probeTargets.find((p) => /bottle/.test(p.name));
        if (window.__INTERACT && bottle) {
          const face = async () => {
            cam.lookAt(bottle.target[0], aimY(bottle), bottle.target[1]);
            await frame();
            await frame();
          };
          // Click along the line to the bottle, not at a door chosen by name.
          // The cooler has several leaves and the first attempt opened the one
          // the crosshair happened to rest on after the walk, which was not the
          // one the bottle is behind.
          await face();
          opened = window.__INTERACT.click();
          // The leaf takes about a second to swing clear of the sight line, and
          // it swings toward the player: from 0.63 m the open door ended up at
          // 0.26 m, still on the crosshair. So step back while it opens, which
          // is what a player does, and take the bottle from a normal reach.
          key("keydown", "KeyS");
          for (let i = 0; i < 40; i++) await frame();
          key("keyup", "KeyS");
          for (let i = 0; i < 90; i++) await frame();
          await face();

          /*
           * Walk to the stance the geometry implies, rather than sidestepping
           * until something works.
           *
           * The previous version stepped left and right until the crosshair
           * found the bottle. That is a search, and searches of this shape are
           * what `NOTES` case 53 is about: it wandered five metres away, reported
           * a different number each time, and each report looked like a fresh
           * aisle-clearance defect. The invariant across all of them was that the
           * crosshair never named the bottle — which is a statement about where
           * the harness was standing, not about the shop.
           *
           * The stance is derivable. The bottle is at a known x; an open leaf
           * sweeps a slab in z in front of the cabinet; so stand square to the
           * bottle at the far side of that slab. From there the bottle is about
           * a metre away, inside the interaction range the same harness has
           * already demonstrated at 1.35 m, and the leaf is not on the ray.
           */
          const sidesteps = [];
          /*
           * The stance band, and it is 220 mm wide.
           *
           * Two constraints bracket it from opposite sides and neither is
           * negotiable. Gondola run B's north face is at z 37.55, so a 0.32 m
           * body cannot stand south of 37.87. An open cooler leaf sweeps the slab
           * z 38.09–38.64, so the same body cannot stand north of 38.09. The
           * intersection is **z 37.87 … 38.09**, and 37.98 is the middle of it.
           *
           * That is why no hand-chosen pose ever found it and why the close beat
           * looked geometrically impossible: a 220 mm target inside a 1.09 m
           * aisle is not something you land on by picking a round number. The
           * first version of this used 37.70, which reads as "clear of the leaf"
           * and is in fact inside the shelving.
           */
          const STANCE_Z = 37.98;
          const standX = bottle.target[0];
          /**
           * Drive the controller to the derived stance. A closure because it has
           * to happen twice: the diagnostic sweep below teleports the camera, and
           * a teleport does not move PlayerSystem's body — so the walk has to be
           * redone before the interaction, or the click fires from wherever the
           * body actually snapped back to.
           */
          const goToStance = async () => {
          for (let n = 0; n < 300; n++) {
              const dx = standX - cam.position.x;
              const dz = STANCE_Z - cam.position.z;
              const d = Math.hypot(dx, dz);
              if (d < 0.12) break;
              // Steer by looking where we are going, then hold W: the same
              // controller a player uses, not a teleport.
              cam.lookAt(cam.position.x + dx, cam.position.y, cam.position.z + dz);
              if (n === 0) key("keydown", "KeyW");
              await frame();
            }
            key("keyup", "KeyW");
            for (let i = 0; i < 12; i++) await frame();
            await face();
          };
          await goToStance();
          sidesteps.push(
            `walked to derived stance (${cam.position.x.toFixed(2)},${cam.position.z.toFixed(2)})->` +
              (window.__INTERACT.probe()?.name ?? "nothing")
          );
          /*
           * Sweep the stance and report what the crosshair names at each z,
           * rather than asserting a band from arithmetic.
           *
           * Two stances 10 mm apart gave opposite outcomes, which was read as the
           * open leaf grazing the sight line. But the leaf that was opened hinges
           * at x −6.72 and the bottle is at x −6.60, so a *fully* open leaf at
           * 1.5 rad lies in a thin slab about 110 mm west of the ray and cannot
           * be on it. Either the leaf is still swinging when the probe fires, or
           * something else is on that ray.
           *
           * So measure both: the door's actual rotation at probe time, and the
           * crosshair's answer across the whole aisle. A swept interval is the
           * band; a single pass/fail at one z is not.
           *
           * By teleport, because it is pure diagnostics, and therefore it has to
           * run *before* the take and be followed by a real walk back. Writing
           * `camera.position` does not move PlayerSystem's body, which snaps back
           * on the next tick — doing this immediately before a click made the take
           * fail from a stance whose crosshair had just named the bottle. Running
           * it after the take instead was worse: the bottle no longer exists, so
           * every sample reported "nothing" and the band read EMPTY. A diagnostic
           * that consumes the thing it measures is two faults, not one.
           */
          const sweep = [];
          for (let z = 37.85; z <= 38.45001; z += 0.05) {
            cam.position.set(standX, eyeAt(standX, z), z);
            cam.lookAt(bottle.target[0], aimY(bottle), bottle.target[1]);
            await frame();
            await frame();
            const h = window.__INTERACT.probe();
            sweep.push({
              z: Number(z.toFixed(2)),
              names: h ? h.name : "nothing",
              d: h ? Number(h.distance.toFixed(2)) : null,
            });
          }
          window.__REACH_SWEEP = sweep;
          window.__REACH_DOORS = doors.map((d) => ({
            name: d.name,
            rot: Number((d.rotation?.y ?? 0).toFixed(3)),
            target: d.userData?.openAngle ?? null,
          }));

          // Walked, not teleported, because the sweep above moved only the camera.
          await goToStance();
          await face();
          // Only click when the crosshair names the bottle. Clicking whatever is
          // under it is how the previous run "took" a cooler door — which is a
          // second toggle, so it closed the door it had just opened and reported
          // a success.
          const onBottle = window.__INTERACT.probe();
          taken =
            onBottle && /bottle/i.test(onBottle.kind + onBottle.name) ? window.__INTERACT.click() : null;
          window.__REACH_SIDESTEPS = sidesteps;

          /*
           * The close beat. The user's third interaction is open, grab, *close*,
           * and the close is the half nobody has ever confirmed — a still capture
           * cannot show it, and the walk stopped at the grab.
           *
           * It is a real geometric question, not a formality: the leaf swings
           * into the aisle, so the stance that can reach the bottle may be inside
           * the volume the leaf needs. Aim back at the door and ask the game's own
           * picker, then click. If the crosshair cannot find the door from here,
           * that is the finding.
           */
          if (taken) {
            for (let i = 0; i < 20; i++) await frame();
            let closeHit = null;
            for (const back of [0, 1, 2]) {
              if (back > 0) {
                key("keydown", "KeyS");
                for (let i = 0; i < 25; i++) await frame();
                key("keyup", "KeyS");
                for (let i = 0; i < 10; i++) await frame();
              }
              /*
               * Aim at the open leaf itself, computed from its own transform.
               *
               * Two wrong aims preceded this. Aiming at the cooler-door *target*
               * closed a leaf three bays away — which, the interaction being a
               * toggle, means it opened one and reported a success. Aiming down
               * the bottle's line worked only while the leaves were 848 mm wide
               * and the hinge happened to sit near that ray; narrowing them to
               * 668 mm moved the hinge 340 mm west and the crosshair found nothing
               * at all. Both are the same mistake: aiming at where the leaf was
               * assumed to be instead of where it is.
               *
               * A hinge knows where its own leaf is. `userData` carries the width
               * and height, the group carries the rotation, so the centre of the
               * leaf is one `localToWorld` away and is correct at any width and
               * any open angle.
               */
              const leaf = doors.find((d) => (d.rotation?.y ?? 0) > 0.05);
              if (!leaf) break;
              const lw = leaf.userData?.width ?? 0.6;
              const lh = leaf.userData?.height ?? 1.6;
              const lp = leaf.position.clone();
              lp.set(lw / 2, lh / 2, 0);
              leaf.localToWorld(lp);
              cam.lookAt(lp.x, lp.y, lp.z);
              for (let i = 0; i < 6; i++) await frame();
              const h = window.__INTERACT.probe();
              if (h && /cooler|door/i.test(h.kind + h.name)) {
                closeHit = {
                  name: h.name,
                  distance: Number(h.distance.toFixed(2)),
                  steppedBack: back,
                  from: [Number(cam.position.x.toFixed(2)), Number(cam.position.z.toFixed(2))],
                };
                break;
              }
            }
            window.__REACH_CLOSE = closeHit ? { ...closeHit, closed: window.__INTERACT.click() } : null;
          }
        }

        return {
          picks,
          opened,
          taken,
          sidesteps: window.__REACH_SIDESTEPS || [],
          sweep: window.__REACH_SWEEP || [],
          doorAngles: window.__REACH_DOORS || [],
          close: window.__REACH_CLOSE || null,
          finalStand: [Number(cam.position.x.toFixed(2)), Number(cam.position.z.toFixed(2))],
          stalled,
          waypoints: route.length,
          reached: trace.length,
          finalDistance: Number(Math.hypot(arrivedAt[0] - tx, arrivedAt[1] - tz).toFixed(2)),
          at: arrivedAt,
          probe,
          doorClicks,
          lastLegs: trace.slice(-3),
        };
      },
      { route: r.sRoute && r.sRoute.length > 2 ? r.sRoute : r.route, target: r.target, probeTargets }
    );
  };

  for (const name of ["cooler door"]) {
    const w = await walk(name, ["cooler door", "grab bottle"]);
    if (!w) continue;
    console.log(`[reach] walked to ${name}: ${w.stalled ? "STALLED" : "arrived"}`);
    console.log(
      `        ${w.reached}/${w.waypoints - 1} legs, ended at (${w.at[0]}, ${w.at[1]}), ` +
        `${w.finalDistance} m from the target`
    );
    if (w.doorClicks.length) console.log(`        opened on the way: ${w.doorClicks.join(", ")}`);
    if (w.sweep && w.sweep.length) {
      console.log("        stance sweep at x = bottle, crosshair target by z:");
      for (const r of w.sweep) {
        console.log(`          z ${r.z}  ${r.names}${r.d === null ? "" : ` at ${r.d} m`}`);
      }
      const good = w.sweep.filter((r) => /bottle/i.test(r.names)).map((r) => r.z);
      console.log(
        good.length
          ? `        band naming the bottle: ${good[0]} .. ${good[good.length - 1]} = ${(
              (good[good.length - 1] - good[0]) *
              1000
            ).toFixed(0)} mm over ${good.length} samples`
          : "        band naming the bottle: EMPTY"
      );
    }
    if (w.doorAngles && w.doorAngles.length) {
      console.log(
        `        door angles at probe time: ${w.doorAngles
          .filter((d) => d.rot > 0.01)
          .map((d) => `${d.name} ${d.rot} of ${d.target}`)
          .join(", ") || "all closed"}`
      );
    }
    if (w.close) {
      console.log(
        `        closed the cooler: ${w.close.closed ? w.close.closed.name : "CLICK FAILED"} ` +
          `at ${w.close.distance} m from (${w.close.from[0]}, ${w.close.from[1]})` +
          (w.close.steppedBack ? `, after ${w.close.steppedBack} step(s) back` : ", from the grab stance")
      );
    } else if (w.taken) {
      console.log("        close beat: NOT POSSIBLE — no stance reached could see the door");
    }
    console.log(
      `        crosshair: ${w.probe ? `${w.probe.kind} "${w.probe.name}" at ${w.probe.distance.toFixed(2)} m` : "nothing"}`
    );
    for (const p of w.picks || []) {
      console.log(
        `        ${p.name.padEnd(14)} ${p.distance} m away, crosshair on ` +
          `${p.hit ? `${p.hit.kind} "${p.hit.name}" at ${p.hit.distance.toFixed(2)} m` : "nothing"}`
      );
    }
    console.log(
      `        opened the cooler: ${w.opened ? `${w.opened.kind} "${w.opened.name}"` : "nothing"}`
    );
    console.log(
      `        then took: ${w.taken ? `${w.taken.kind} "${w.taken.name}" at ${w.taken.distance.toFixed(2)} m` : "nothing"}` +
        (w.sidesteps?.length ? `  (after sidestepping ${w.sidesteps.join(", ")})` : "") +
        `  standing (${w.finalStand?.[0]}, ${w.finalStand?.[1]})`
    );
    if (w.stalled) {
      for (const l of w.lastLegs) {
        console.log(`          leg to (${l.waypoint[0]}, ${l.waypoint[1]}) ended at (${l.at[0]}, ${l.at[1]})`);
      }
    }
  }
  console.log("");

  await shutdown(null);
  process.exit(0);
}

main().catch(async (e) => {
  await shutdown(e?.stack || String(e));
  process.exit(1);
});
