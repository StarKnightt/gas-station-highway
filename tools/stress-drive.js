/**
 * In-page autopilot for the sustained walk stress test.
 *
 * Injected before the page scripts by tools/stress.mjs.
 *
 * The point of this file is that it drives the *real* interactive path and
 * nothing else. Every movement is a real `KeyboardEvent` that `PlayerSystem`
 * picks up, so the walk goes through collision resolution, the doorway portal
 * radius, `floorHeight`, the interior step and the head bob. Every interaction
 * is a real `pointerdown` on the renderer's canvas, so it goes through
 * `InteractionSystem.onPointerDown`, arms the audio graph on the first press
 * exactly as a player's first click does, and picks by raycast from the screen
 * centre at the 2.2 m reach.
 *
 * Deliberately NOT used:
 *
 *   window.__INTERACT.look()   teleports the camera and skips the walk.
 *   window.__INTERACT.click()  skips the DOM event, so it never arms audio
 *                              and never proves the pointer path works.
 *   camera.position.set()      skips collision entirely, which is the one
 *                              thing a stress test of a walkable scene must
 *                              not skip.
 *
 * Yaw is written straight onto the camera. That is not a shortcut: it is what
 * `PointerLockControls` does on `mousemove`, and pointer lock cannot be
 * acquired in a headless context without a user gesture. `PlayerSystem.update`
 * writes only roll, so nothing fights us for it.
 */
(() => {
  const S = {
    /** Route steps still to run. */
    queue: [],
    /** Human-readable label for whatever is happening right now. */
    phase: "idle",
    /** Lap counter, for growth-across-cycles attribution. */
    lap: 0,
    /** Timestamped events: interactions, stalls, threshold crossings. */
    log: [],
    /** Per-frame samples, each labelled with the phase that produced it. */
    samples: [],
    running: false,
    finished: false,
    heldKeys: new Set(),
  };
  window.__STRESS = S;

  const cam = () => window.__GAME.camera;
  const canvas = () => window.__GAME.renderer.domElement;
  const now = () => performance.now();

  /* ------------------------------------------------------------------ *
   * input                                                               *
   * ------------------------------------------------------------------ */

  function hold(code) {
    if (S.heldKeys.has(code)) return;
    S.heldKeys.add(code);
    window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
  }

  function release(code) {
    if (!S.heldKeys.has(code)) return;
    S.heldKeys.delete(code);
    window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
  }

  function releaseAll() {
    for (const c of [...S.heldKeys]) release(c);
  }

  /**
   * A real left press on the canvas. `pointerdown` is what InteractionSystem
   * listens for and what AudioSystem arms on, so this single event exercises
   * both. `isPrimary` and `pointerId` are set because PointerEvent defaults
   * make it a non-primary pointer, which some handlers filter out.
   */
  function press() {
    const el = canvas();
    const r = el.getBoundingClientRect();
    const ev = new PointerEvent("pointerdown", {
      button: 0,
      buttons: 1,
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    });
    el.dispatchEvent(ev);
    el.dispatchEvent(new PointerEvent("pointerup", { button: 0, buttons: 0, bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  }

  /* ------------------------------------------------------------------ *
   * aiming                                                              *
   * ------------------------------------------------------------------ */

  /**
   * Yaw that points the camera's forward vector at (x, z).
   *
   * With rotation order YXZ, a yaw of t sends local +Z to (sin t, 0, cos t),
   * and a camera looks down local -Z. So forward is (-sin t, 0, -cos t) and
   * the yaw that faces a delta of (dx, dz) is atan2(-dx, -dz) — note both
   * signs. Getting this wrong yields a camera facing exactly backwards, which
   * still produces a plausible frame and a walk that goes the wrong way.
   */
  function yawTo(x, z) {
    const p = cam().position;
    return Math.atan2(-(x - p.x), -(z - p.z));
  }

  function pitchTo(x, y, z) {
    const p = cam().position;
    return Math.atan2(y - p.y, Math.hypot(x - p.x, z - p.z));
  }

  /** Shortest signed angular difference, so steering never takes the long way. */
  function angleDelta(to, from) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /* ------------------------------------------------------------------ *
   * routing over the real collision field                               *
   *                                                                     *
   * The first version of this walked straight at each waypoint and let  *
   * the wall-slide sort it out. Over two minutes it needed 67 strafe    *
   * recoveries and spent 48 of 125 seconds wedged among the store       *
   * shelving — so the "sustained walk" was mostly a sustained stand.    *
   * A stress test that stops walking measures an idle scene, and it     *
   * does it without any symptom you would notice in the numbers.        *
   *                                                                     *
   * So: sample the collision field the game itself publishes, and       *
   * route over the free cells. Nothing here changes how movement        *
   * happens — it still goes out as key events through PlayerSystem and  *
   * still gets resolved by the same collider. It only changes which     *
   * direction is chosen, which is the part a player does with their     *
   * eyes.                                                               *
   * ------------------------------------------------------------------ */

  const GRID = { x0: -24, x1: 26, z0: -2, z1: 41, cell: 0.4 };
  GRID.nx = Math.ceil((GRID.x1 - GRID.x0) / GRID.cell);
  GRID.nz = Math.ceil((GRID.z1 - GRID.z0) / GRID.cell);
  let free = null;
  let reachable = null;

  const cx = (x) => Math.round((x - GRID.x0) / GRID.cell);
  const cz = (z) => Math.round((z - GRID.z0) / GRID.cell);
  const wx = (i) => GRID.x0 + i * GRID.cell;
  const wz = (k) => GRID.z0 + k * GRID.cell;
  const idx = (i, k) => k * GRID.nx + i;

  S.buildGrid = function (bodyRadius = 0.34, portalRadius = 0.22) {
    const field = window.__GAME.tryGet("collision.field");
    if (!field || typeof field.resolve !== "function") {
      note("no-collision-field", {});
      return { cells: 0, free: 0 };
    }
    free = new Uint8Array(GRID.nx * GRID.nz);
    const probe = { x: 0, y: 0, z: 0 };
    let n = 0;
    for (let k = 0; k < GRID.nz; k++) {
      for (let i = 0; i < GRID.nx; i++) {
        probe.x = wx(i);
        probe.z = wz(k);
        probe.y = 0;
        let blocked = false;
        try {
          const r = typeof field.radiusAt === "function" ? field.radiusAt(probe.x, probe.z, bodyRadius, portalRadius) : bodyRadius;
          blocked = field.resolve(probe, r);
        } catch {
          blocked = true; // a collider that throws is not somewhere to walk
        }
        if (!blocked) {
          free[idx(i, k)] = 1;
          n++;
        }
      }
    }
    // The entry door is shut when this grid is sampled, so it reads as a wall
    // and the flood below would declare the entire store unreachable — which
    // is false, because the route opens it. Punch the opening through, sized
    // off the hinge the building actually published rather than a constant.
    const entry = window.__GAME.tryGet("building.entryDoor");
    let opened = 0;
    if (entry) {
      entry.updateMatrixWorld(true);
      const e = entry.matrixWorld.elements;
      const hx = e[12];
      const hz = e[14];
      for (let k = cz(hz - 0.9); k <= cz(hz + 0.9); k++) {
        for (let i = cx(hx - 0.1); i <= cx(hx + 1.2); i++) {
          if (i < 0 || k < 0 || i >= GRID.nx || k >= GRID.nz) continue;
          if (!free[idx(i, k)]) {
            free[idx(i, k)] = 1;
            n++;
            opened++;
          }
        }
      }
    }

    // Free is not the same as reachable, and the difference is the whole
    // problem. The first routed run walked the store to z = 33.68 and then
    // ground against something for 33 seconds while every cell beyond it read
    // as free, because "no blocker at this point" says nothing about whether a
    // body can get to the point. Flood from where the player actually stands.
    const p = cam().position;
    const start = nearestFree(cx(p.x), cz(p.z));
    let reach = 0;
    if (start) {
      reachable = new Uint8Array(free.length);
      const q = new Int32Array(free.length);
      let head = 0;
      let tail = 0;
      const s0 = idx(start[0], start[1]);
      reachable[s0] = 1;
      q[tail++] = s0;
      while (head < tail) {
        const cur = q[head++];
        reach++;
        const i = cur % GRID.nx;
        const k = (cur - i) / GRID.nx;
        for (let dk = -1; dk <= 1; dk++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dk) continue;
            const ni = i + di;
            const nk = k + dk;
            if (ni < 0 || nk < 0 || ni >= GRID.nx || nk >= GRID.nz) continue;
            const nidx = idx(ni, nk);
            if (reachable[nidx] || !free[nidx]) continue;
            if (di && dk && (!free[idx(i + di, k)] || !free[idx(i, k + dk)])) continue;
            reachable[nidx] = 1;
            q[tail++] = nidx;
          }
        }
      }
    }
    return {
      cells: free.length,
      free: n,
      pct: +((n / free.length) * 100).toFixed(1),
      reachable: reach,
      strandedFreeCells: n - reach,
      doorwayCellsOpened: opened,
      from: [+p.x.toFixed(2), +p.z.toFixed(2)],
    };
  };

  /**
   * Can the player actually get to this point from where the walk started?
   *
   * Deliberately does NOT go through `nearestFree`, which snaps to the nearest
   * *reachable* cell and would therefore answer yes for a point on the far
   * side of a wall by quietly answering about somewhere else. Search a small
   * neighbourhood of free cells and report whether any of them is reachable.
   */
  S.canReach = function (x, z, tolerance = 1.2) {
    if (!reachable) return null;
    const i0 = cx(x);
    const k0 = cz(z);
    const r = Math.ceil(tolerance / GRID.cell);
    let sawFree = false;
    for (let di = -r; di <= r; di++) {
      for (let dk = -r; dk <= r; dk++) {
        const i = i0 + di;
        const k = k0 + dk;
        if (i < 0 || k < 0 || i >= GRID.nx || k >= GRID.nz) continue;
        const c = idx(i, k);
        if (!free[c]) continue;
        sawFree = true;
        if (reachable[c]) return true;
      }
    }
    return sawFree ? false : null; // null: solid all round, the point is inside geometry
  };

  /** A line of free/blocked/stranded readings, for seeing where a wall is. */
  S.transect = function (x0, z0, x1, z1, n = 24) {
    const out = [];
    for (let s = 0; s <= n; s++) {
      const x = x0 + ((x1 - x0) * s) / n;
      const z = z0 + ((z1 - z0) * s) / n;
      const i = cx(x);
      const k = cz(z);
      const inb = i >= 0 && k >= 0 && i < GRID.nx && k < GRID.nz;
      out.push({
        x: +x.toFixed(1),
        z: +z.toFixed(1),
        state: !inb ? "off" : !free[idx(i, k)] ? "solid" : reachable && !reachable[idx(i, k)] ? "stranded" : "walkable",
      });
    }
    return out;
  };

  S.describeCollision = function () {
    const f = window.__GAME.tryGet("collision.field");
    return f && typeof f.describe === "function" ? f.describe() : null;
  };

  /**
   * Which way out is there from here, right now, against the live collider.
   *
   * The routing grid is sampled once at start, so it knows nothing about a
   * cooler door that has since swung open. When the walk wedges, the useful
   * question is not "where did it stop" but "what was solid at that moment" —
   * otherwise a stall gets written up as a guess about a door.
   */
  S.probeAround = function (r = 0.6) {
    const field = window.__GAME.tryGet("collision.field");
    if (!field) return null;
    const p = cam().position;
    const out = {};
    for (const [name, dx, dz] of [
      ["N", 0, -1], ["NE", 0.7, -0.7], ["E", 1, 0], ["SE", 0.7, 0.7],
      ["S", 0, 1], ["SW", -0.7, 0.7], ["W", -1, 0], ["NW", -0.7, -0.7],
    ]) {
      const q = { x: p.x + dx * r, y: p.y, z: p.z + dz * r };
      try {
        out[name] = field.resolve(q, field.radiusAt(q.x, q.z, 0.34, 0.22)) ? "solid" : "free";
      } catch (e) {
        out[name] = "throw";
      }
    }
    try {
      const here = { x: p.x, y: p.y, z: p.z };
      out.here = field.resolve(here, 0.34) ? `pushed to ${here.x.toFixed(2)},${here.z.toFixed(2)}` : "clear";
    } catch (e) {
      out.here = "throw";
    }
    return out;
  };

  /**
   * Nearest usable cell to a point, for goals that sit inside a blocker.
   * Once the reachability flood has run, "usable" means reachable — snapping a
   * goal to a free-but-stranded cell is how a route ends up aimed at the far
   * side of a wall.
   */
  function nearestFree(i0, k0) {
    const ok = (i, k) => {
      if (i < 0 || k < 0 || i >= GRID.nx || k >= GRID.nz) return false;
      const c = idx(i, k);
      return !!free[c] && (!reachable || !!reachable[c]);
    };
    if (ok(i0, k0)) return [i0, k0];
    for (let r = 1; r <= 20; r++) {
      for (let di = -r; di <= r; di++) {
        for (let dk = -r; dk <= r; dk++) {
          if (Math.max(Math.abs(di), Math.abs(dk)) !== r) continue;
          if (ok(i0 + di, k0 + dk)) return [i0 + di, k0 + dk];
        }
      }
    }
    return null;
  }

  /** Straight line between two cells with every cell on it free. */
  function clear(i0, k0, i1, k1) {
    const steps = Math.max(Math.abs(i1 - i0), Math.abs(k1 - k0));
    for (let s = 1; s < steps; s++) {
      const i = Math.round(i0 + ((i1 - i0) * s) / steps);
      const k = Math.round(k0 + ((k1 - k0) * s) / steps);
      if (!free[idx(i, k)]) return false;
    }
    return true;
  }

  /**
   * Breadth-first over the free cells, then string-pulled so the result is a
   * handful of waypoints rather than a staircase. Uniform cost is fine here:
   * every cell is the same size and the scene is flat enough that the shortest
   * route is also the one a person would take.
   */
  S.path = function (from, to) {
    if (!free) return [to];
    const si = cx(from[0]);
    const sk = cz(from[1]);
    const g = nearestFree(cx(to[0]), cz(to[1]));
    if (!g) return [to];
    const start = nearestFree(si, sk);
    if (!start) return [to];

    const prev = new Int32Array(free.length).fill(-1);
    const seen = new Uint8Array(free.length);
    const q = new Int32Array(free.length);
    let head = 0;
    let tail = 0;
    const s0 = idx(start[0], start[1]);
    const gi = idx(g[0], g[1]);
    q[tail++] = s0;
    seen[s0] = 1;
    let found = false;
    while (head < tail) {
      const cur = q[head++];
      if (cur === gi) {
        found = true;
        break;
      }
      const i = cur % GRID.nx;
      const k = (cur - i) / GRID.nx;
      for (let dk = -1; dk <= 1; dk++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dk) continue;
          const ni = i + di;
          const nk = k + dk;
          if (ni < 0 || nk < 0 || ni >= GRID.nx || nk >= GRID.nz) continue;
          const nidx = idx(ni, nk);
          if (seen[nidx] || !free[nidx]) continue;
          if (reachable && !reachable[nidx]) continue;
          // Do not cut a diagonal through a corner the body cannot fit past.
          if (di && dk && (!free[idx(i + di, k)] || !free[idx(i, k + dk)])) continue;
          seen[nidx] = 1;
          prev[nidx] = cur;
          q[tail++] = nidx;
        }
      }
    }
    if (!found) return [to];

    const cells = [];
    for (let c = gi; c !== -1; c = prev[c]) {
      const i = c % GRID.nx;
      cells.push([i, (c - i) / GRID.nx]);
      if (c === s0) break;
    }
    cells.reverse();

    const pulled = [];
    let a = 0;
    while (a < cells.length - 1) {
      let b = cells.length - 1;
      while (b > a + 1 && !clear(cells[a][0], cells[a][1], cells[b][0], cells[b][1])) b--;
      pulled.push(cells[b]);
      a = b;
    }
    const pts = pulled.map(([i, k]) => [+wx(i).toFixed(2), +wz(k).toFixed(2)]);
    // Land on the caller's actual target, not on the cell centre nearest it.
    if (pts.length) pts[pts.length - 1] = to;
    return pts.length ? pts : [to];
  };

  /* ------------------------------------------------------------------ *
   * the step interpreter                                                *
   * ------------------------------------------------------------------ */

  let step = null;
  let stepT0 = 0;
  let lastProgressAt = 0;
  let lastDist = Infinity;
  let unstickUntil = 0;
  let unstickKey = "KeyA";

  function note(kind, detail) {
    S.log.push({ t: +(now() - S.t0).toFixed(0), lap: S.lap, phase: S.phase, kind, ...detail });
  }

  function nextStep() {
    releaseAll();
    step = S.queue.shift() ?? null;
    stepT0 = now();
    lastProgressAt = stepT0;
    lastDist = Infinity;
    unstickUntil = 0;
    if (!step) {
      S.finished = true;
      S.running = false;
      S.phase = "done";
      return;
    }
    if (step.phase) S.phase = step.phase;
    if (step.lap !== undefined) S.lap = step.lap;
    if (step.mark) note("mark", { name: step.mark });
  }

  function tickStep() {
    if (!step) return;
    const t = now() - stepT0;

    switch (step.op) {
      /* ---- walk to a point, steering as we go ---- */
      case "go": {
        const p = cam().position;

        // Plan once on arrival at the step, then follow the legs. Replanning
        // every frame would chase the dynamic car blocker around.
        if (!step._legs) {
          step._legs = S.path([p.x, p.z], step.to);
          step._leg = 0;
          if (step._legs.length > 1) note("route", { to: step.to, legs: step._legs.length });
        }
        const finalLeg = step._leg >= step._legs.length - 1;
        const [tx, tz] = step._legs[step._leg];
        const dist = Math.hypot(tx - p.x, tz - p.z);

        if (dist < (finalLeg ? step.tol ?? 0.45 : 0.55)) {
          if (!finalLeg) {
            step._leg++;
            lastDist = Infinity;
            lastProgressAt = now();
            return;
          }
          note("reach", { to: step.to, ms: +t.toFixed(0), legs: step._legs.length });
          return nextStep();
        }

        // Steer at a rate a hand could produce rather than snapping: an
        // instant yaw change would skip the frames where the renderer has to
        // cull and draw a completely different set of objects, and those are
        // exactly the frames a stress test is looking for.
        const want = yawTo(tx, tz);
        const c = cam();
        const d = angleDelta(want, c.rotation.y);
        const maxStep = (step.turn ?? 2.2) * (1 / 60);
        c.rotation.y += Math.abs(d) < maxStep ? d : Math.sign(d) * maxStep;
        c.rotation.x += (0 - c.rotation.x) * 0.08;

        // Only walk forward once roughly facing the target, or we describe a
        // wide arc through whatever is beside us.
        if (Math.abs(d) < 0.6) hold("KeyW");
        else release("KeyW");

        if (dist < lastDist - 0.08) {
          lastDist = dist;
          lastProgressAt = now();
          if (unstickUntil === 0) {
            release("KeyA");
            release("KeyD");
          }
        }

        // Collision can wedge the body on a kerb, a doorframe, or a cooler
        // door that has swung into the aisle. Cycle strafe-left, strafe-right,
        // reverse rather than pretending the waypoint was reached: a stress
        // test that silently stops walking measures an idle scene, and it does
        // so without any symptom in the numbers.
        if (now() - lastProgressAt > 1500 && now() > unstickUntil) {
          unstickKey = unstickKey === "KeyA" ? "KeyD" : unstickKey === "KeyD" ? "KeyS" : "KeyA";
          unstickUntil = now() + 800;
          note("unstick", {
            to: step.to,
            dist: +dist.toFixed(2),
            key: unstickKey,
            at: [+p.x.toFixed(2), +p.z.toFixed(2)],
            around: S.probeAround(),
          });
        }
        for (const k of ["KeyA", "KeyD", "KeyS"]) {
          if (now() < unstickUntil && k === unstickKey) hold(k);
          else release(k);
        }
        if (now() < unstickUntil && unstickKey === "KeyS") release("KeyW");

        // A leg that will not yield after two strafe attempts is abandoned for
        // the next one; the route is a suggestion, and standing still is the
        // one outcome this test must never quietly produce.
        if (now() - lastProgressAt > 5000 && !finalLeg) {
          note("skip-leg", { leg: step._leg, of: step._legs.length, dist: +dist.toFixed(2) });
          step._leg++;
          lastDist = Infinity;
          lastProgressAt = now();
          return;
        }

        const budget = (step.timeout ?? 20000) + 6000 * Math.max(0, step._legs.length - 1);
        if (t > budget) {
          note("stuck", {
            to: step.to,
            dist: +dist.toFixed(2),
            ms: +t.toFixed(0),
            legs: step._legs.length,
            at: [+p.x.toFixed(2), +p.z.toFixed(2)],
            around: S.probeAround(),
            coolers: window.__INTERACT ? window.__INTERACT.state().coolers.filter((c) => c.amount > 0.02) : null,
          });
          return nextStep();
        }
        return;
      }

      /* ---- turn to face a world point, without moving ---- */
      case "aim": {
        const [ax, ay, az] = step.at;
        const c = cam();
        release("KeyW");
        const wantY = yawTo(ax, az);
        const wantX = pitchTo(ax, ay, az);
        const dy = angleDelta(wantY, c.rotation.y);
        const dx = wantX - c.rotation.x;
        const maxStep = 3.0 * (1 / 60);
        c.rotation.y += Math.abs(dy) < maxStep ? dy : Math.sign(dy) * maxStep;
        c.rotation.x += Math.abs(dx) < maxStep ? dx : Math.sign(dx) * maxStep;
        if ((Math.abs(dy) < 0.02 && Math.abs(dx) < 0.02) || t > 4000) {
          return nextStep();
        }
        return;
      }

      /* ---- aim at an estimate, then find the target by probing ---- */
      case "seek": {
        const [ax, ay, az] = step.at;
        const c = cam();
        release("KeyW");
        const wantY = yawTo(ax, az);
        const wantX = pitchTo(ax, ay, az);
        const dy = angleDelta(wantY, c.rotation.y);
        const dx = wantX - c.rotation.x;
        const maxStep = 3.0 * (1 / 60);
        c.rotation.y += Math.abs(dy) < maxStep ? dy : Math.sign(dy) * maxStep;
        c.rotation.x += Math.abs(dx) < maxStep ? dx : Math.sign(dx) * maxStep;
        if (!(Math.abs(dy) < 0.02 && Math.abs(dx) < 0.02) && t < 4000) return;

        // Arrived at the estimate. The estimate came from a coordinate read out
        // of the source, and the object it names has a size — so rather than
        // trust the aim, sweep a small grid and ask the interaction system's
        // own picker what is under the crosshair. `probe()` is read-only; the
        // click that follows is still a real pointer event.
        const baseY = c.rotation.y;
        const baseX = c.rotation.x;
        let found = null;
        outer: for (const r of [0, 0.04, 0.09, 0.15, 0.22, 0.3]) {
          for (const [sy, sx] of r === 0
            ? [[0, 0]]
            : [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
            c.rotation.y = baseY + sy * r;
            c.rotation.x = baseX + sx * r;
            c.updateMatrixWorld();
            const hit = window.__INTERACT?.probe?.();
            if (hit && (!step.want || hit.kind === step.want)) {
              found = { hit, y: c.rotation.y, x: c.rotation.x, r };
              break outer;
            }
          }
        }
        if (found) {
          c.rotation.y = found.y;
          c.rotation.x = found.x;
          note("seek", { want: step.want ?? null, got: `${found.hit.kind}:${found.hit.name}`, offRad: +found.r.toFixed(2) });
        } else {
          c.rotation.y = baseY;
          c.rotation.x = baseX;
          note("seek-miss", { want: step.want ?? null, at: step.at, pos: [+cam().position.x.toFixed(2), +cam().position.z.toFixed(2)] });
        }
        c.updateMatrixWorld();
        return nextStep();
      }

      /* ---- a real left click down the crosshair ---- */
      case "click": {
        const before = window.__INTERACT?.probe?.() ?? null;
        press();
        note("click", {
          hit: before ? `${before.kind}:${before.name}` : null,
          dist: before ? +before.distance.toFixed(2) : null,
          want: step.want ?? null,
          missed: step.want ? !before || before.kind !== step.want : !before,
        });
        return nextStep();
      }

      case "wait": {
        releaseAll();
        if (t >= step.ms) return nextStep();
        return;
      }

      /* ---- walk backwards, for leaving the store without turning ---- */
      case "back": {
        hold("KeyS");
        const [tx, tz] = step.to;
        const p = cam().position;
        if (Math.hypot(tx - p.x, tz - p.z) < (step.tol ?? 0.6) || t > (step.timeout ?? 12000)) {
          return nextStep();
        }
        return;
      }

      default:
        return nextStep();
    }
  }

  /* ------------------------------------------------------------------ *
   * sampling                                                            *
   * ------------------------------------------------------------------ */

  const IN = { x0: -8.9, x1: 3.3, z0: 31.5, z1: 39.8 };
  const isInside = (p) => p.x > IN.x0 && p.x < IN.x1 && p.z > IN.z0 && p.z < IN.z1;
  let wasInside = false;

  let last = now();
  let prev = null;

  function tick() {
    if (!S.running && S.finished) {
      releaseAll();
      return;
    }
    const t = now();
    const dt = t - last;
    last = t;

    try {
      tickStep();
    } catch (err) {
      note("driver-error", { message: String(err && err.message ? err.message : err) });
    }

    const G = window.__GLSTAT;
    const info = window.__GAME.renderer.info;
    const p = cam().position;

    // Threshold crossings are logged rather than inferred afterwards from the
    // position track, because the interesting frame is the one *during* the
    // crossing and a 3 s poll would miss it entirely.
    const inside = isInside(p);
    if (inside !== wasInside) {
      wasInside = inside;
      note(inside ? "enter-store" : "exit-store", { at: [+p.x.toFixed(2), +p.z.toFixed(2)] });
      S.samples.push({ t, dt, cross: inside ? 1 : -1, phase: S.phase, lap: S.lap });
    }

    const s = {
      t,
      dt,
      phase: S.phase,
      lap: S.lap,
      draws: prev ? G.draws - prev.draws : 0,
      tris: prev ? G.drawTris - prev.tris : 0,
      texBytes: prev ? G.tex.bytes - prev.texBytes : 0,
      bufBytes: prev ? G.buf.bytes - prev.bufBytes : 0,
      progLinked: prev ? G.programs.linked - prev.prog : 0,
      x: +p.x.toFixed(2),
      z: +p.z.toFixed(2),
      inside: inside ? 1 : 0,
    };
    prev = { draws: G.draws, tris: G.drawTris, texBytes: G.tex.bytes, bufBytes: G.buf.bytes, prog: G.programs.linked };
    S.samples.push(s);

    // Unbounded sample arrays are themselves a leak, and this runs for twenty
    // minutes. Keep every slow frame and thin the rest: the distribution is
    // reconstructed from the summary the harness pulls each poll.
    if (S.samples.length > 60000) {
      S.samples = S.samples.filter((r, i) => r.dt > 20 || r.cross || i % 4 === 0);
    }

    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ */

  S.begin = function (route) {
    S.queue = route.slice();
    S.t0 = now();
    // Rebase the frame clock. `last` was set when this script parsed, which is
    // before the scene existed, so without this the first sample reports a
    // "frame" tens of seconds long — the whole of init, wearing the costume of
    // a dropped frame, at the top of the worst-frames table.
    last = now();
    S.running = true;
    S.finished = false;
    nextStep();
    requestAnimationFrame(tick);
  };

  S.stop = function () {
    S.running = false;
    S.finished = true;
    releaseAll();
  };

  /**
   * Everything worth watching, in one round trip. Called on a poll by the
   * harness; keep it cheap and allocation-free enough not to be the thing it
   * is measuring.
   */
  S.stats = function () {
    const G = window.__GLSTAT;
    const info = window.__GAME.renderer.info;
    const p = cam().position;
    const ctxs = S.audioContexts();
    return {
      phase: S.phase,
      lap: S.lap,
      pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      inside: isInside(p) ? 1 : 0,
      queued: S.queue.length,
      finished: S.finished,
      liveTexMB: +(G.live.texBytes / 1048576).toFixed(2),
      liveBufMB: +(G.live.bufBytes / 1048576).toFixed(2),
      liveRboMB: +(G.live.rboBytes / 1048576).toFixed(2),
      liveTexCount: G.live.texCount,
      peakTexMB: +(G.peak.texBytes / 1048576).toFixed(2),
      framebuffers: G.framebuffers ? G.framebuffers.created - G.framebuffers.deleted : 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      progLinked: G.programs.linked,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      listenerRegistrations: G.listeners ? G.listeners.total : 0,
      audioNodes: ctxs,
      sceneChildren: window.__GAME.scene.children.length,
      systemErrors: (window.__SYSTEM_ERRORS || []).length,
      contextLost: window.__CONTEXT_LOST ? 1 : 0,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
    };
  };

  /**
   * Audio graph size. The interaction path arms an oscillator or buffer source
   * per event and relies on `onended` to disconnect the subgraph; if that ever
   * stops firing the node count is where it shows first, well before the heap
   * notices, because Web Audio nodes are mostly native memory.
   */
  S.audioContexts = function () {
    const c = window.__AUDIO_CTX_CENSUS;
    if (!c) return null;
    return { created: c.created, ended: c.ended, live: c.created - c.ended, state: c.state() };
  };

  S.drain = function () {
    const out = { samples: S.samples, log: S.log };
    S.samples = [];
    S.log = [];
    return out;
  };
})();

/**
 * Census of the scheduled audio sources.
 *
 * `AudioBufferSourceNode` and `OscillatorNode` are one-shot: each `start()`
 * arms a node that can never be restarted, and the graph relies on `onended`
 * to disconnect it. Counting starts against ends is the only way to tell a
 * graph that is cycling correctly from one that is accumulating — the JS heap
 * cannot, because the node's cost is native, and a listener count cannot,
 * because a handler that is registered and fires looks the same as one that is
 * registered and does not until you compare the two totals.
 */
(() => {
  const C = { created: 0, ended: 0, byKind: Object.create(null), contexts: [] };
  window.__AUDIO_CTX_CENSUS = C;
  C.state = () => C.contexts.map((c) => c.state).join(",") || "none";

  const wrapStart = (proto, kind) => {
    if (!proto || !proto.start) return;
    const orig = proto.start;
    proto.start = function (...args) {
      C.created++;
      C.byKind[kind] = (C.byKind[kind] || 0) + 1;
      let counted = false;
      const done = () => {
        if (counted) return;
        counted = true;
        C.ended++;
      };
      this.addEventListener("ended", done);
      return orig.apply(this, args);
    };
  };

  for (const [ctor, kind] of [
    [window.AudioBufferSourceNode, "buffer"],
    [window.OscillatorNode, "oscillator"],
    [window.ConstantSourceNode, "constant"],
  ]) {
    if (ctor) wrapStart(ctor.prototype, kind);
  }

  for (const Ctor of [window.AudioContext, window.webkitAudioContext]) {
    if (!Ctor) continue;
    const orig = Ctor.prototype.constructor;
    // Track instances so the harness can report whether the graph is actually
    // running: a suspended context produces no sound and no cost, and a stress
    // test that never armed audio would otherwise look like a clean result.
    const wrapped = new Proxy(Ctor, {
      construct(target, args) {
        const inst = Reflect.construct(target, args);
        C.contexts.push(inst);
        return inst;
      },
    });
    if (Ctor === window.AudioContext) window.AudioContext = wrapped;
    else window.webkitAudioContext = wrapped;
    void orig;
  }
})();
