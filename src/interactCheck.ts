/**
 * Diagnostic entry point for System 7's verification harness. Not the game.
 *
 * `src/main.ts` registers every system on one `Game`, and `Game.start()` awaits
 * each `init()` in a bare loop — so a single system throwing during init
 * rejects the whole start and nothing after it in the list ever initialises. As
 * of this writing `PumpSystem.init` throws `pumpParts: merge failed (mismatched
 * attributes)`, which takes the player, the building, audio, lighting's
 * interior pass and this system down with it, and the real page never reaches
 * `__SCENE_READY`.
 *
 * That is somebody else's bug in a file System 7 must not edit, so this entry
 * exists purely so the door, cooler and bottle interactions can still be
 * asserted against the real BuildingSystem, LightingSystem and AudioSystem
 * while the pumps are down. It registers exactly the same systems in exactly
 * the same order as `main.ts`; the only difference is that each one is wrapped
 * so a failure is isolated to that system and recorded on `window.__SYSFAIL`.
 *
 * Delete this file once `Game` isolates system failures itself, or once
 * whatever broke the pumps is fixed — whichever comes first.
 */

import * as THREE from "three";
import { Game } from "./core/Game";
import type { GameSystem, SystemContext } from "./core/types";
import type { PumpFaceHandle } from "./systems/PumpSystem";
import { LightingSystem } from "./systems/LightingSystem";
import { TerrainSystem } from "./systems/TerrainSystem";
import { PlayerSystem } from "./systems/PlayerSystem";
import { PumpSystem } from "./systems/PumpSystem";
import { CarSystem } from "./systems/CarSystem";
import { BuildingSystem } from "./systems/BuildingSystem";
import { AudioSystem } from "./systems/AudioSystem";
import { InteractionSystem } from "./systems/InteractionSystem";

const failures: Record<string, string> = {};
(window as unknown as { __SYSFAIL: Record<string, string> }).__SYSFAIL = failures;

function isolate(sys: GameSystem): GameSystem {
  let dead = false;
  const kill = (phase: string, err: unknown) => {
    dead = true;
    failures[sys.name] = `${phase}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[check] ${sys.name}.${phase} failed`, err);
  };
  return {
    name: sys.name,
    async init(ctx: SystemContext) {
      try {
        await sys.init(ctx);
      } catch (err) {
        kill("init", err);
      }
    },
    update(dt, elapsed, ctx) {
      if (dead) return;
      try {
        sys.update?.(dt, elapsed, ctx);
      } catch (err) {
        kill("update", err);
      }
    },
    resize(w, h) {
      if (dead) return;
      try {
        sys.resize?.(w, h);
      } catch (err) {
        kill("resize", err);
      }
    },
    dispose() {
      try {
        sys.dispose?.();
      } catch (err) {
        console.error(`[check] ${sys.name}.dispose failed`, err);
      }
    },
  };
}

/**
 * `?stubpumps=1`: if — and only if — the real `PumpSystem` failed to publish
 * anything, stand up one object that satisfies the published `PumpFaceHandle`
 * contract exactly, so the fuelling logic can still be exercised end to end
 * against the interface it is written against. It proves System 7's half of the
 * contract: the raycast, the metering, that the tick rate is derived from the
 * same variable as the digits, the nozzle lift and the stop. It proves nothing
 * about the real dispenser, and the harness says so in its report.
 */
const stubPumps: GameSystem = {
  name: "stub-pumps",
  init(ctx: SystemContext) {
    if (!new URLSearchParams(location.search).has("stubpumps")) return;
    if (ctx.game.tryGet("pumpFaces")) return;

    // Same contract as PlayerSystem and VegetationSystem: loud, not a flat
    // y = 0. A stub pump floated at the wrong height would still satisfy the
    // interface and quietly invalidate the reach test it exists to run.
    const ground = ctx.game.tryGet<(x: number, z: number) => number>("groundHeight");
    if (!ground) {
      throw new Error(
        'stub-pumps: no "groundHeight" service — must init after TerrainSystem'
      );
    }
    const x = 9.5;
    const z = 21.0;
    const y = ground(x, z) + 1.35;

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.36, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.5 })
    );
    panel.name = "stub-pump-panel";
    panel.position.set(x, y, z);
    ctx.scene.add(panel);

    const values = { dollars: 0, gallons: 0, price: 3.499, grade: 0, active: false };
    let lift = 0;
    const nozzle = new THREE.Group();
    ctx.scene.add(nozzle);

    const face: PumpFaceHandle = {
      name: "pump-1:south",
      side: -1,
      facing: new THREE.Vector3(0, 0, -1),
      standPosition: new THREE.Vector3(x, ground(x, z - 1.15), z - 1.15),
      displayCentre: new THREE.Vector3(x, y, z - 0.03),
      pickables: [panel],
      nozzle,
      setDisplay: (v) => Object.assign(values, v),
      getDisplay: () => ({ ...values }),
      resetDisplay: () => {
        values.dollars = 0;
        values.gallons = 0;
        values.active = false;
      },
      setActive: (on) => {
        values.active = on;
      },
      isActive: () => values.active,
      setNozzleLift: (t) => {
        lift = Math.max(0, Math.min(1, t));
        nozzle.position.set(x, y - 0.6 + lift * 0.55, z - lift * 0.5);
      },
      getNozzleLift: () => lift,
    };

    ctx.game.provide("pumpFaces", [face]);
    ctx.game.provide("pumpPickables", [panel]);
    console.warn("[check] real pumps are down; a stub pump face is standing in at", x, z);
  },
};

const game = new Game();

game.register(
  isolate(new LightingSystem()),
  isolate(new TerrainSystem()),
  isolate(new PumpSystem()),
  isolate(new CarSystem()),
  isolate(new PlayerSystem()),
  isolate(new BuildingSystem())
);
game.register(isolate(new AudioSystem()));
game.register(isolate(stubPumps));
game.register(isolate(new InteractionSystem()));

game.start().catch((err) => {
  console.error(err);
  const el = document.getElementById("loading");
  if (el) el.textContent = String(err);
});
