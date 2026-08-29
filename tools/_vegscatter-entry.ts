/**
 * Bundle entry for tools/vegscatter.mjs. Runs the real scrub placement with the
 * real site exclusions, in a plain Node process, so the distribution can be
 * measured rather than eyeballed.
 */
import { scatterScrub } from "../src/systems/VegetationSystem";
import { DRIVEWAYS, PAD, ROAD, BUILDING } from "../src/site";

export const site = { ROAD, PAD, DRIVEWAYS, BUILDING };

export function sites(densityScale = 1, seed = 2718) {
  // Mirrors the `blocked` predicate built in VegetationSystem.init, with the
  // building footprint the BuildingSystem publishes at runtime.
  const structures = [
    { minX: BUILDING.minX - 0.55, maxX: BUILDING.maxX + 0.55, minZ: BUILDING.minZ - 0.55, maxZ: BUILDING.maxZ + 0.55 },
  ];
  const blocked = (x: number, z: number) => {
    if (Math.abs(z) <= ROAD.halfPaved - 0.13) return true;
    if (x >= PAD.minX - 0.02 && x <= PAD.maxX + 0.02 && z >= PAD.minZ - 0.02 && z <= PAD.maxZ + 0.02) return true;
    if (z > ROAD.halfPaved && z < PAD.minZ) {
      for (const d of DRIVEWAYS) if (x > d.minX - 0.1 && x < d.maxX + 0.1) return true;
    }
    for (const r of structures) if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return true;
    return false;
  };
  const ground = () => 0;
  const anchors: [number, number][] = [
    [-46, -9.6],
    [12, -9.6],
    [64, -9.6],
  ];
  return scatterScrub(ground as never, blocked, anchors, densityScale, seed).map((s) => ({
    x: s.x,
    z: s.z,
    kind: s.kind,
    size: s.size,
    tall: s.tall,
    wide: s.wide,
  }));
}
