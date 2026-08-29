/**
 * Bundle entry for tools/vegsmoke.mjs. Builds every piece of System 6 geometry
 * and every texture, headlessly, and reports triangle counts.
 *
 * This is the cheap test that should have existed from the start. None of these
 * generators need a GPU — they are arithmetic that produces typed arrays — so
 * "does it build at all, and how big is it" is answerable in a second on the
 * CPU, and a merge failure or a failed invariant no longer needs a browser to
 * discover.
 */
import * as THREE from "three";
import { assertFinite } from "./finitecheck.mjs";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildDistantLandscape } from "../src/gen/vegDistant";
import { HORIZON_BANDS } from "../src/gen/vegHorizonBands";
import { buildPine, foliageCardGeometry } from "../src/gen/vegPine";
import { buildClump, CLUMP_KINDS } from "../src/gen/vegScrub";
import { buildSage, buildThistle, midStoreySites } from "../src/gen/vegMidstorey";
import { buildFence, buildPoleLine } from "../src/gen/vegProps";
import { wireRibbonGeometry } from "../src/gen/vegWire";
import { buildGroundMats, contactSpecs, pineDuffSpecs } from "../src/gen/vegGround";
import { makePineBark, makePineShoot, makeScrubCard, makeTimber } from "../src/gen/vegTextures";

/**
 * Finiteness is asserted through the shared `tools/finitecheck.mjs`, not a copy
 * of it kept here.
 *
 * This system found the defect — `buildClump` wrote NaN into the base row of 55
 * of 56 clump geometries on every run — but the defect is not this system's to
 * own. Every system builds geometry from arithmetic, every system now feeds the
 * world-capture PMREM, and one non-finite vertex anywhere blacks out the scene
 * for all of them. So the check is shared and this file is one of its callers;
 * see the long note at the top of that module for the reasoning, including why
 * source review cannot clear this class.
 */
const tris = (g: THREE.BufferGeometry | null, label = "geometry") => {
  if (!g) return 0;
  assertFinite(g, label);
  return g.index ? g.index.count / 3 : g.getAttribute("position").count / 3;
};

const PINES = [
  { x: -33.0, z: 10.0, h: 13.0 },
  { x: -38.5, z: 19.5, h: 9.8 },
  { x: -30.5, z: 30.5, h: 15.2 },
  { x: -27.0, z: 52.0, h: 11.4 },
  { x: 9.0, z: 51.0, h: 8.6 },
  { x: 34.0, z: 48.5, h: 14.1 },
  { x: 40.5, z: 24.0, h: 8.0 },
  { x: -63.0, z: 60.0, h: 16.2 },
  { x: 74.0, z: 38.0, h: 12.4 },
  { x: -52.0, z: -24.0, h: 13.2 },
];
const FENCE_PATH: [number, number][] = [
  [-42, 14],
  [-42, 47],
  [44, 47],
  [44, 20],
];
const POLE_XS = [-128, -83, -38, 7, 52, 97];
const ground = () => 0;

export function buildAll() {
  const out: Record<string, number> = {};
  const sun = new THREE.Vector3(-0.9124, 0.108, -0.3948);

  const horizon = buildDistantLandscape({ sunDirection: sun, baseY: -12, bands: HORIZON_BANDS });
  out["horizon triangles"] = tris(horizon);
  out["horizon bands"] = HORIZON_BANDS.length;

  /**
   * Cards are the other route into the environment cube. They are not geometry
   * — a tint and a matrix per instance — but a NaN tint lands in
   * `instanceColor` and a NaN matrix puts an instance somewhere undefined, and
   * both reach the PMREM exactly the way the clump vertex colour did. The pine
   * card tint is built from `Math.pow(s, 0.8) * Math.pow(t, 0.7)`, the same
   * arithmetic shape that caused the outage, so it is checked, not trusted.
   */
  const checkCards = (list: { matrix: THREE.Matrix4; tint: THREE.Color }[], label: string) =>
    assertFinite(list, label);

  let woodTris = 0;
  let cards = 0;
  for (let i = 0; i < PINES.length; i++) {
    const b = buildPine({ seed: 4100 + i * 107, height: PINES[i].h, lean: 0.04, leanDir: i, vigour: 0.8 });
    woodTris += tris(b.wood, `pine ${i} wood`);
    checkCards(b.cards, `pine ${i} cards`);
    cards += b.cards.length;
    b.wood.dispose();
  }
  out["pine wood triangles"] = woodTris;
  out["pine foliage cards"] = cards;
  out["pine card triangles"] = cards * tris(foliageCardGeometry(3));

  // Every form, and every variant of every form, because the system builds all
  // 28 and a merge failure in any one of them would take the system down.
  let clumpTris = 0;
  let nearT = 0;
  let farT = 0;
  for (const kind of CLUMP_KINDS) {
    let t = 0;
    for (let v = 0; v < 4; v++) t += tris(buildClump(kind, 8101 + CLUMP_KINDS.indexOf(kind) * 613 + v * 97));
    // Both LODs measured, because the multiplier acts on a randomised card count
    // so the realised saving is not simply the multiplier.
    for (let v = 0; v < 2; v++) {
      nearT += tris(buildClump(kind, 8101 + CLUMP_KINDS.indexOf(kind) * 613 + v * 97, 1));
      farT += tris(buildClump(kind, 8101 + CLUMP_KINDS.indexOf(kind) * 613 + v * 97, 0.45));
    }
    out[`clump ${kind} triangles (4 variants)`] = t;
    clumpTris += t;
  }
  out["clump tris near LOD (2 var)"] = nearT;
  out["clump tris far LOD (2 var)"] = farT;
  out["clump far LOD saving %"] = Math.round((1 - farT / nearT) * 100);
  out["clump meshes"] = CLUMP_KINDS.length * 4;

  // Merged, not built-and-disposed one at a time. Building each plant on its own
  // passed while the system's merge of the same set returned null, because a
  // sapling's wood carries UVs and a sage stem's did not — mergeGeometries logs
  // and returns null on a mismatched attribute set, and the entire mid-storey's
  // wood was missing from the render. A smoke test that does not perform the
  // same merge as the system does not test the system.
  let midCards = 0;
  const midSites = midStoreySites(() => false);
  const midWood: THREE.BufferGeometry[] = [];
  for (const s of midSites) {
    const b =
      s.kind === "sapling"
        ? buildPine({ seed: s.seed, height: s.height, lean: 0.05, leanDir: 1, vigour: 0.9 })
        : s.kind === "sage"
          ? buildSage(s.seed, s.height)
          : buildThistle(s.seed, s.height);
    tris(b.wood, `mid-storey ${s.kind} seed ${s.seed} wood`);
    checkCards(b.cards, `mid-storey ${s.kind} seed ${s.seed} cards`);
    midWood.push(b.wood);
    midCards += b.cards.length;
  }
  const midMerged = mergeGeometries(midWood, false);
  if (!midMerged) throw new Error("mid-storey wood merge returned null — mismatched vertex attributes");
  out["mid-storey plants"] = midSites.length;
  out["mid-storey wood triangles"] = tris(midMerged);
  out["mid-storey cards"] = midCards;
  void clumpTris;

  const fence = buildFence({
    path: FENCE_PATH,
    spacing: 2.85,
    postHeight: 1.24,
    strands: [0.26, 0.5, 0.74, 0.95],
    seed: 4401,
    ground,
  });
  out["fence timber triangles"] = tris(fence.timber);
  out["fence tpost triangles"] = tris(fence.metal);
  out["fence wire runs"] = fence.wires.length;
  out["fence wire triangles"] = tris(wireRibbonGeometry(fence.wires));

  const poles = buildPoleLine({
    positions: POLE_XS.map((x) => [x, -9.6] as [number, number]),
    height: 10.2,
    seed: 4703,
    ground,
  });
  out["pole timber triangles"] = tris(poles.timber);
  out["pole insulator triangles"] = tris(poles.metal);
  out["pole wire runs"] = poles.wires.length;
  out["pole wire triangles"] = tris(wireRibbonGeometry(poles.wires));

  const mats = buildGroundMats(
    [
      ...pineDuffSpecs(PINES),
      ...contactSpecs(
        PINES.map((p) => [p.x, p.z] as [number, number]),
        0.62,
        0.62,
        5903
      ),
    ],
    ground
  );
  out["ground mat triangles"] = tris(mats);

  // Textures last: they carry the border invariant, which throws.
  makePineShoot(512, 5001, false);
  makePineShoot(512, 5157, true);
  makeScrubCard(256, 6001, "grass");
  makeScrubCard(256, 6113, "weed");
  makeScrubCard(256, 6229, "tuft");
  makePineBark(512, 7001).dispose();
  makeTimber(512, 7301).dispose();
  out["textures built"] = 7;

  return out;
}
