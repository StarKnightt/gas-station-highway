/**
 * CPU-side half of `tools/vegscale.mjs`: stand the real VegetationSystem up
 * without a GPU and hand back the plant manifest it publishes.
 *
 * Everything about *where the camera is* and *how big things look* stays in the
 * `.mjs`, so this file has no opinion about the question being asked. It exists
 * only because the generators are TypeScript with parameter properties, which
 * Node's strip-only loader cannot parse.
 */
import * as THREE from "three";
import { VegetationSystem } from "../src/systems/VegetationSystem";
import { groundHeight } from "../src/site";
import { makeSoilField } from "../src/gen/groundSoil";
import { makeAccumField } from "../src/gen/groundAccum";

export interface PlantSite {
  kind: string;
  x: number;
  z: number;
  height: number;
}

/**
 * A scrub clump, as published by `vegetation.clumps`.
 *
 * Structurally the system's `ScrubSite` minus the tint, restated here rather
 * than imported so a tool can consume the service without pulling the system's
 * THREE types in. `size` and `tall` are carried because they are what decides
 * whether a clump at 90 m subtends a pixel, and a count without them cannot
 * tell a fringe from a row of specks.
 */
export interface ClumpSite {
  x: number;
  z: number;
  kind: string;
  size: number;
  tall: number;
  wide: number;
}

export async function collectSites(): Promise<{
  sites: PlantSite[];
  clumps: ClumpSite[];
  ground: (x: number, z: number) => number;
  scene: THREE.Scene;
  buildingWas: "real" | "layout-only";
}> {
  const services = new Map<string, unknown>();
  const game = {
    provide: <T>(k: string, v: T) => (services.set(k, v), v),
    require: <T>(k: string): T => {
      const v = services.get(k);
      if (v === undefined) throw new Error(`vegscale: missing service ${k}`);
      return v as T;
    },
    tryGet: <T>(k: string): T | undefined => services.get(k) as T | undefined,
  };

  game.provide("groundHeight", groundHeight);
  game.provide("sunDirection", new THREE.Vector3(-0.92, 0.11, -0.39).normalize());

  // Vegetation throws when `skyRadiance` is absent, by design: a plausible
  // constant standing in for it is the exact bug that rule was written to stop.
  // So this provides one explicitly rather than letting the system fall back.
  // Nothing measured here depends on the sky being the right colour — this tool
  // reports geometry in pixels, not radiance.
  const dawn = new THREE.Color(0.42, 0.46, 0.62);
  const same = (out?: THREE.Color) => (out ?? new THREE.Color()).copy(dawn);
  game.provide("skyRadiance", {
    colourSpace: "linear-srgb-scene-referred",
    atHorizon: (_az: number, out?: THREE.Color) => same(out),
    horizonToward: (_v: THREE.Vector3, out?: THREE.Color) => same(out),
    at: (_v: THREE.Vector3, out?: THREE.Color) => same(out),
    hazeAt: (_az: number, _d: number, out?: THREE.Color) => same(out),
  });

  // `groundSoil` is Terrain's, and Vegetation refuses to default it — a second
  // disagreeing ground mask is the whole reason it consumes the service. Standing
  // TerrainSystem up here would be the faithful thing, and it is not worth it for
  // this question: `soil` is read in exactly one place, `addGroundMat`, and it
  // affects no plant's position or height. Checked, not assumed — `this.soil` has
  // two references in the system and both are inside the mat. If that ever stops
  // being true this stub becomes a lie, so it is marked as one.
  game.provide("groundSoil", {
    colourSpace: "linear-srgb-scene-referred",
    stub: "vegscale — mat only, does not affect plant placement",
    disturbance: () => 0.35,
    wetness: () => 0.2,
    drainage: () => 0.5,
    material: () => "soil",
  });

  // `groundAccum`, built the same way TerrainSystem builds it — from the real
  // `makeSoilField()` and not from the stub above, because the stub returns
  // three constants and an accumulation field derived from constants is flat,
  // which would silently turn every debris measurement taken through this
  // harness into a measurement of nothing.
  //
  // This is NOT a convenience. Without it `tryGet("groundAccum")` returns
  // undefined, `debrisContext` takes its no-service branch, and the skirt runs
  // at gain 1 everywhere while the report says `debrisAccum: null` — which is
  // the state this harness was actually in, and it is why `vegaccum` had to
  // carry its own copy of the gain expression to have anything to print. A
  // probe that recomputes the formula it is checking agrees with the source by
  // construction and would not notice the shipped path being dead. Now the
  // shipped path runs and the probe reads its echo.
  game.provide("groundAccum", makeAccumField(makeSoilField()));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 3000);
  const ctx = {
    game,
    scene,
    camera,
    renderer: {
      capabilities: { getMaxAnisotropy: () => 8, isWebGL2: true },
      getPixelRatio: () => 1,
      outputColorSpace: "srgb",
      properties: { get: () => ({}) },
    },
    shot: null,
  } as never;

  // The building is always stood up for real, because its footprint and its
  // blocker rectangles are exclusion masks for plant placement: a wrong
  // rectangle here moves plants, and moving plants is the thing being measured.
  // `probe-pixel` stands the same system up the same way.
  //
  // There used to be a `stubBuilding` option here that supplied the footprint
  // from a constant and an **empty** blocker list, because `BuildingSystem.init`
  // rasterised textures through `document.createElement("canvas")` and so could
  // not be constructed in Node at all. It no longer needs one: `init` takes a
  // layout-only branch when there is no `document`, which publishes the real
  // blockers out of `gen/buildingLayout` (pure arithmetic) and marks itself with
  // `building.headless`. The stub is deleted rather than left switched off —
  // an empty blocker list does not fail loudly, it quietly plants through the
  // shelving, and every figure derived from it was wrong in the near field.
  const { BuildingSystem } = await import("../src/systems/BuildingSystem");
  new BuildingSystem().init(ctx);
  const headless = game.tryGet<boolean>("building.headless") === true;

  const sys = new VegetationSystem();
  await sys.init(ctx);

  const sites = game.tryGet<PlantSite[]>("vegetation.sites") ?? [];
  /*
   * The scrub clumps, which are a different and much larger population than
   * `sites`. Every density figure this harness has produced was over the 228
   * mid-storey plants, while the layer a frame actually reads as at 60 m and out
   * is the 2429 clumps. Returned separately, and empty rather than absent if the
   * service is missing, so a caller that forgets to check gets zero rather than
   * silently falling back to the wrong population.
   */
  const clumps = game.tryGet<ClumpSite[]>("vegetation.clumps") ?? [];
  return {
    sites,
    clumps,
    ground: groundHeight,
    scene,
    buildingWas: headless ? "layout-only" : "real",
  };
}

export interface WindingReport {
  name: string;
  triangles: number;
  /** Triangles whose geometric winding disagrees with their shading normals. */
  reversed: number;
  /** Triangles with zero area, which have no winding to disagree with. */
  degenerate: number;
  /** Mean |cos| between face normal and vertex-normal mean, over sound faces. */
  meanAgreement: number;
}

/**
 * Per-triangle winding audit, on the CPU, over every mesh the system builds.
 *
 * Car's `probe-unseen` flagged `veg-pole-insulators` as WINDING, which it
 * defines as "0 px normally, >0 px with side = DoubleSide". That is the right
 * test for a large flat panel and it is ambiguous for 18 barrels 5.8 cm across
 * merged into one mesh spanning a 6-pole line: framed to fit the whole mesh
 * every insulator is sub-pixel, and DoubleSide roughly doubles the chance a
 * sub-pixel fragment survives, so "0 px -> 1 px" is what *both* a reversed
 * winding and a correctly wound sub-pixel mesh look like. The probe said as much
 * in its own output — it had to judge that mesh from six axes because it is a
 * closed shell with no mean normal.
 *
 * This resolves it without pixels. Winding is a property of the index buffer, so
 * compare the two things that must agree: the geometric normal from the vertex
 * order, `(b - a) x (c - a)`, and the mean of the three shading normals the
 * generator wrote. If a triangle's geometric normal points opposite its own
 * shading normals then back-face culling removes a surface the generator
 * believed was front-facing, and that is unambiguous and exact — no threshold,
 * no framing, no chosen region, and it sees inside a merge, which matters here
 * because 218 plants share one mesh.
 *
 * Degenerate triangles are counted separately rather than folded in, because a
 * zero-area face has no winding and averaging it into an agreement score dilutes
 * a real failure toward the pass mark.
 */
export async function auditWinding(): Promise<WindingReport[]> {
  const { scene } = await collectSites();
  const out: WindingReport[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const face = new THREE.Vector3();
  const shade = new THREE.Vector3();

  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m as { isMesh?: boolean }).isMesh) return;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    const pos = g?.getAttribute("position");
    const nor = g?.getAttribute("normal");
    if (!g || !pos || !nor) return;
    const index = g.getIndex();
    const count = index ? index.count : pos.count;
    let reversed = 0;
    let degenerate = 0;
    let agree = 0;
    let sound = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = index ? index.getX(t) : t;
      const i1 = index ? index.getX(t + 1) : t + 1;
      const i2 = index ? index.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      face.crossVectors(ab, ac);
      const area = face.length();
      if (area < 1e-12) {
        degenerate++;
        continue;
      }
      face.multiplyScalar(1 / area);
      shade.set(0, 0, 0);
      for (const i of [i0, i1, i2]) {
        shade.x += nor.getX(i);
        shade.y += nor.getY(i);
        shade.z += nor.getZ(i);
      }
      const sl = shade.length();
      if (sl < 1e-9) {
        degenerate++;
        continue;
      }
      shade.multiplyScalar(1 / sl);
      const d = face.dot(shade);
      sound++;
      agree += Math.abs(d);
      if (d < 0) reversed++;
    }
    out.push({
      name: m.name || "<unnamed>",
      triangles: Math.floor(count / 3),
      reversed,
      degenerate,
      meanAgreement: sound ? agree / sound : 0,
    });
  });
  return out;
}
