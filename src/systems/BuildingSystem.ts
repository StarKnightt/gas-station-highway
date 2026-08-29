import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GameSystem, SystemContext } from "../core/types";
import type { Game } from "../core/Game";
import type { GroundAccum } from "../gen/groundAccum";
import { buildingBox, buildingQuad, buildingTube, buildingWorldBox, mergeLocal } from "../gen/buildingGeo";
import {
  BOTTLE_LABEL,
  buildingBottle,
  buildingGondola,
  buildingShelfProducts,
  DRINK_COLORS,
  LABEL_COLORS,
  shadeBySlotAccess,
  tintBottle,
} from "../gen/buildingProps";
import { applyBuildingShot, BUILDING_SHOTS } from "../gen/buildingShots";
import {
  type BuildingMaps,
  CMU_TILE_X,
  CMU_TILE_Y,
  disposeBuildingMaps,
  makeBuildingCeilingTile,
  makeBuildingCmu,
  makeBuildingCondensation,
  makeBuildingGlassGrime,
  makeBuildingMetal,
  makeBuildingRustStreak,
  makeBuildingScuff,
  makeBuildingVct,
} from "../gen/buildingTextures";
import { applyBuildingCoursing } from "../gen/buildingCoursing";
import {
  applyBottleLabel,
  applySheetCell,
  FASCIA_SIGN,
  makeCoolerValance,
  makeFasciaSign,
  makeProductLabels,
  makeHeroBottleLabel,
  makeShelfStrip,
  makeSignPlates,
  makeWindowNotices,
  makeTrofferLens,
  makeWindowVinyl,
  type VinylSheet,
} from "../gen/buildingSignage";
import { applyBuildingWeather } from "../gen/buildingWeather";
import { applyGlazingFresnel } from "../gen/buildingGlazing";
import { buildingHeroBottle } from "../gen/buildingHeroBottle";
import { makeConcrete, makeMacroNoise } from "../gen/textures";
import { makeRng, type Rng } from "../gen/noise";
import { gridSurface } from "../gen/geo";
import { BUILDING, groundHeight, padY } from "../site";

const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------------ */
/* plan                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The store occupies the eastern 12.6 m of the footprint reserved in
 * `site.ts`; the rest of that reservation stays clear for the propane cage and
 * whatever System 3 wants to put beside it.
 *
 * Every number is a real building dimension. A 3.6 m roof deck, a 0.75 m
 * parapet, a 2.78 m ceiling, a 2.13 m door and 16 x 8 in block are what an
 * actual single-storey highway store measures; getting any of them wrong is
 * the fastest way to turn a photoreal render into a dollhouse.
 */
/** Terrain's `groundAccum` field, resolved to something a shader can sample. */
interface AccumLookup {
  field: THREE.DataTexture;
  rect: [number, number, number, number];
  wind: THREE.Vector2;
}

const PLAN = {
  x0: -9.1,
  x1: 3.5,
  z0: BUILDING.minZ, // 31.5 - the front elevation, facing the forecourt
  z1: BUILDING.maxZ, // 40.0 - the back
  wall: 0.2,

  roofDeck: 3.6,
  parapet: 4.35,
  ceiling: 2.78,

  /** Storefront glazing runs between the two CMU piers. */
  sfX0: -8.3,
  sfX1: 1.5,
  sillTop: 0.2, // CMU curb under the glazing
  kickTop: 0.5,
  glassTop: 2.6,
  headTop: 2.72,
  fasciaTop: 3.45,

  doorX0: -6.575,
  doorX1: -5.425,
  doorHeight: 2.13,
  transomBottom: 2.24,

  /** Centre of the storefront system within the wall thickness. */
  sfZ: 0.1,

  /** Height of the darker painted base band. */
  baseCourse: 0.62,
};

const IN = {
  x0: PLAN.x0 + PLAN.wall,
  x1: PLAN.x1 - PLAN.wall,
  z0: PLAN.z0 + PLAN.wall,
  z1: PLAN.z1 - PLAN.wall,
};

/** Reach-in cooler along the back wall. */
const COOLER = { x0: -8.5, x1: -1.5, depth: 1.16, height: 2.12, doors: 8, kick: 0.09 };

/**
 * Where the handheld bottle sits before it is picked up. Fixed and published,
 * not rng-placed: Player is aiming a video at this object and this system needs
 * a shot pose on it, and two agents cannot both point at a random spot. Height
 * is above finished floor — cooler shelf 2 plus the 26 mm the stock stands off.
 */
const GRAB_BOTTLE = { x: -6.6, z: 38.72, aboveFloor: 0.646 };

/** Where `?bgheld=1` stands it for inspection: open floor, hand height. */
const HELD_BOTTLE = { x: -4.2, z: 35.4, aboveFloor: 1.16 };

/** Checkout counter, to the right as you come in. */
const COUNTER = { x0: 0.5, x1: 3.15, z0: 34.55, z1: 35.45, height: 0.98 };

/** Gondola spine positions. 2.35 m apart gives a real 1.19 m shopping aisle. */
const GONDOLA_Z = [34.6, 36.95];
/**
 * The runs stop 0.65 m short of where they used to at the west end, and the
 * reason is a route rather than a look.
 *
 * At `x0: -8.2` both runs left 0.70 m to the west wall. That is wider than a
 * 0.64 m body, so every reachability test passed it, and it is 30 mm of margin —
 * which is not a corridor, it is a scrape. Measured with a clearance-constrained
 * shortest path, the only interior route to the cooler threaded that gap and the
 * doorway corner at 13 mm, and the walked controller stuck at the jamb rather
 * than follow it. The shop was passable and not crossable, and those are
 * different properties.
 *
 * `x0: -7.55` opens the west corridor to 1.35 m. It costs 0.65 m of the 7.2 m
 * run; the critic asked that the *density* of shelving read through the glass be
 * protected, not its length, and the stocking is unchanged.
 */
const GONDOLA_X = { x0: -7.55, x1: -1.0, halfDepth: 0.6 };

/**
 * The impulse island in front of the counter. One constant because the geometry
 * and the collision blocker were two hand-copied literals, and the first time
 * one of them moved the other would not have followed: the island is the single
 * obstruction that decided whether the store interior was walkable at all.
 *
 * It starts east of the gondola line so that x −1.0…0.15 is a clear 1.15 m
 * corridor from the door to the back of the store. Before that it began at
 * −0.4, which left only a route round its east end through 0.80 m and 0.82 m
 * gaps — 0.40 m of clearance against `PlayerSystem`'s 0.32 m body radius, so
 * both the cooler and the grab bottle were unreachable on foot.
 */
const ISLAND = { x0: 0.15, x1: 1.95, cz: 33.1, halfDepth: 0.6, height: 1.05 };

/**
 * Debug query parameters, for the forced-value diffs `NOTES.md` mandates
 * before believing any of this reached the framebuffer. `?dbgFixture=1` paints
 * every shop fitting magenta, which is how the "large grey slab" in the
 * interior view was identified; `?bweather=8` drives the weathering shader to
 * an absurd value.
 */
const dbg = (name: string, fallback = 0): number => {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? fallback : Number(v);
};

interface Blocker {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface MaterialKit {
  cmuExt: THREE.MeshStandardMaterial;
  cmuBase: THREE.MeshStandardMaterial;
  cmuInt: THREE.MeshStandardMaterial;
  vct: THREE.MeshStandardMaterial;
  ceilTile: THREE.MeshStandardMaterial;
  alu: THREE.MeshStandardMaterial;
  galv: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  steelInt: THREE.MeshStandardMaterial;
  darkMetal: THREE.MeshStandardMaterial;
  enamel: THREE.MeshStandardMaterial;
  enamelInt: THREE.MeshStandardMaterial;
  fixture: THREE.MeshStandardMaterial;
  bollard: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  /** Inner leaf of the storefront IGU — see the note at `addPane`. */
  glassInner: THREE.MeshPhysicalMaterial;
  coolerGlass: THREE.MeshPhysicalMaterial;
  /**
   * Additive reflection leaves. One per pane material; `addGlazing` pairs
   * them. Null when `?bglsep=0` puts the conflated single material back.
   */
  glassRefl: THREE.MeshPhysicalMaterial | null;
  glassInnerRefl: THREE.MeshPhysicalMaterial | null;
  coolerGlassRefl: THREE.MeshPhysicalMaterial | null;
  diffuser: THREE.MeshStandardMaterial;
  trofferLens: THREE.MeshStandardMaterial;
  coolerLiner: THREE.MeshStandardMaterial;
  product: THREE.MeshStandardMaterial;
  bottle: THREE.MeshPhysicalMaterial;
  /** The four leaves of the handheld bottle. See buildingHeroBottle.ts. */
  heroShell: THREE.MeshPhysicalMaterial;
  heroLiquid: THREE.MeshPhysicalMaterial;
  heroLabel: THREE.MeshStandardMaterial;
  heroCap: THREE.MeshStandardMaterial;
  rust: THREE.MeshStandardMaterial;
  scuff: THREE.MeshStandardMaterial;
  traffic: THREE.MeshStandardMaterial;
  condensation: THREE.MeshStandardMaterial;
  grime: THREE.MeshStandardMaterial;
  /** Signage. `sign*` are opaque printed panels, `vinyl`/`plate` are cut decals. */
  signFascia: THREE.MeshStandardMaterial;
  signValance: THREE.MeshStandardMaterial;
  signStrip: THREE.MeshStandardMaterial;
  vinyl: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  notice: THREE.MeshStandardMaterial;
}

interface UvKit {
  cmu: THREE.Vector2;
  alu: THREE.Vector2;
  galv: THREE.Vector2;
  steel: THREE.Vector2;
  dark: THREE.Vector2;
  vct: THREE.Vector2;
}

interface GeoKit {
  cmuExt: THREE.BufferGeometry[];
  cmuBase: THREE.BufferGeometry[];
  cmuInt: THREE.BufferGeometry[];
  alu: THREE.BufferGeometry[];
  galv: THREE.BufferGeometry[];
  steel: THREE.BufferGeometry[];
  steelInt: THREE.BufferGeometry[];
  dark: THREE.BufferGeometry[];
  enamel: THREE.BufferGeometry[];
  enamelInt: THREE.BufferGeometry[];
  fixture: THREE.BufferGeometry[];
  product: THREE.BufferGeometry[];
}

/**
 * System 2: the store building and its interior.
 *
 * The exterior is painted CMU on a real 16 x 8 in course with an aluminium
 * storefront system; the interior is a fully enclosed room with a suspended
 * ceiling, so the contrast between the low sun through the door and the cold
 * fluorescents overhead can actually happen once System 4 lands.
 *
 * TODO(System 4 - lighting): every light here is geometry only. The lay-in
 * troffer diffusers, the cooler interior and the wall pack carry a placeholder
 * emissive so they are not black holes in the meantime. The fixture transforms
 * are published as "building.fluorescents", "building.coolerLightSlots" and
 * "building.exteriorLight" so the lighting pass can put real emitters in them
 * and turn the emissive stubs down.
 * TODO(System 7 - interaction): "building.entryDoor" and
 * "building.coolerDoors" are hinge pivots carrying their open/closed angles in
 * userData; "building.grabBottle" is a standalone mesh, detached from the
 * merged shelf batch, so it can be reparented to a hand without rebuilding
 * anything.
 */
export class BuildingSystem implements GameSystem {
  readonly name = "building";

  // Named so that anything walking the scene graph — the cost accounting in
  // tools/shoot2.mjs, the performance harness — can attribute what it finds to
  // a system instead of reporting one anonymous total.
  private group = Object.assign(new THREE.Group(), { name: "building" });
  private maps: BuildingMaps[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private blockers: Blocker[] = [];
  private floorY = 0;

  private mat!: MaterialKit;
  private uv!: UvKit;
  private geo!: GeoKit;
  private fluorescents: THREE.Object3D[] = [];
  private coolerLightSlots: THREE.Object3D[] = [];
  private coolerDoors: THREE.Object3D[] = [];
  private grabbables: THREE.Object3D[] = [];
  private exteriorLight: THREE.Object3D | null = null;
  private signCache = new Map<number, THREE.Material>();
  private vinylSheet!: VinylSheet;
  private plateSheet!: VinylSheet;
  private noticeSheet!: VinylSheet;

  init(ctx: SystemContext): void {
    const { scene, game } = ctx;
    const q = new URLSearchParams(location.search);
    /** ?bweather=8 drives the weathering to an absurd value for a pixel diff. */
    const weather = q.has("bweather") ? Number(q.get("bweather")) : 1;
    /** ?bcourse=6 paints the masonry joints red for a forced-value diff. */
    const course = q.has("bcourse") ? Number(q.get("bcourse")) : 1;
    /**
     * ?bcshadow=0 disables the mortar groove self-shadow and nothing else, so
     * the two-light-angle test gets a control with opposite predictions in the
     * two halves of one frame. See `shadowScale` in buildingCoursing.ts.
     *
     * Rejected rather than coerced when it is not a number: NOTES.md case 25
     * cost a capture round to a silently-ignored debug token, and a control
     * that quietly did nothing would produce the most persuasive wrong result
     * available here - a clean null on the arm that was supposed to move.
     */
    const grooveShadow = q.has("bcshadow") ? Number(q.get("bcshadow")) : 1;
    if (!Number.isFinite(grooveShadow)) {
      throw new Error(`BuildingSystem: ?bcshadow=${q.get("bcshadow")} is not a number`);
    }
    const rng = makeRng(20802);

    const F = this.finishedFloorLevel();
    this.floorY = F;
    const sun = game.tryGet<THREE.Vector3>("sunDirection") ?? V3(-0.9, 0.19, -0.38).normalize();

    this.buildMaterials(F, sun, weather, course, grooveShadow, this.bakeAccumField(game));
    this.geo = {
      cmuExt: [],
      cmuBase: [],
      cmuInt: [],
      alu: [],
      galv: [],
      steel: [],
      steelInt: [],
      dark: [],
      enamel: [],
      enamelInt: [],
      fixture: [],
      product: [],
    };

    const entryDoor = this.buildShell(F);
    this.buildRoofKit(F);
    this.buildDrainage(F);
    this.buildExteriorFittings(F);
    this.buildStoop(F);

    this.buildInteriorShell(F);
    this.buildCeiling(F);
    this.buildCooler(F, rng);
    this.buildShelving(F, rng);
    this.buildCounter(F, rng);
    this.buildTrafficPath(F);
    this.buildSignage(F);

    this.commitBatches();
    this.assertNoDoubleSidedTransmission();
    this.buildBlockers();
    this.publish(game, F, entryDoor);

    if (q.has("bopen")) entryDoor.rotation.y = entryDoor.userData.openAngle;

    scene.add(this.group);

    // Own camera presets. `core/shots.ts` and `tools/shoot.mjs` belong to other
    // systems, so System 2 resolves its own shot names here instead. This runs
    // after PlayerSystem's init, which has already disabled free-look for any
    // `?shot=` value it was given.
    if (ctx.shot && BUILDING_SHOTS[ctx.shot]) {
      applyBuildingShot(ctx.camera, ctx.shot, F, groundHeight);
      // The two shots that look through the doorway want it standing open,
      // which is also the state System 7 will animate to.
      if (ctx.shot === "door" || ctx.shot === "interior") entryDoor.rotation.y = 1.35;
    }
  }

  /* ---------------------------------------------------------------- */
  /* setup                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Finished floor level: 140 mm above the high point of the pad anywhere
   * around the building, so water drains away from the door on every
   * elevation instead of into it.
   */
  private finishedFloorLevel(): number {
    let high = -Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      high = Math.max(
        high,
        padY(PLAN.x0 + (PLAN.x1 - PLAN.x0) * t, PLAN.z0),
        padY(PLAN.x0 + (PLAN.x1 - PLAN.x0) * t, PLAN.z1),
        padY(PLAN.x0, PLAN.z0 + (PLAN.z1 - PLAN.z0) * t),
        padY(PLAN.x1, PLAN.z0 + (PLAN.z1 - PLAN.z0) * t)
      );
    }
    return high + 0.14;
  }

  /**
   * Terrain's `groundAccum.fines(x, z)` baked to a top-down lookup over the
   * building footprint plus a two-metre skirt.
   *
   * The service is pure CPU and the consumer is a shader, so something has to
   * bridge them. 128 squared over ~26 m is 200 mm a texel, which is far finer
   * than `fines` varies — its clumping term runs at 0.21 rad/m, a 30 m period —
   * so this is a faithful sample rather than a lossy one, and it costs 65 kB.
   *
   * Returns null and pushes a loud error if the service is missing, rather than
   * falling back to the local model. A silent fallback here would look exactly
   * like the service not mattering, which is the single most repeated failure
   * mode in NOTES.md.
   */
  private bakeAccumField(game: Game): AccumLookup | null {
    const accum = game.tryGet<GroundAccum>("groundAccum");
    if (!accum) {
      (window as unknown as { __SYSTEM_ERRORS?: string[] }).__SYSTEM_ERRORS?.push(
        "building: groundAccum service missing - wall base fell back to the local model"
      );
      return null;
    }
    const skirt = 2.0;
    const rect: [number, number, number, number] = [
      PLAN.x0 - skirt,
      PLAN.z0 - skirt,
      PLAN.x1 + skirt,
      PLAN.z1 + skirt,
    ];
    const N = 128;
    const data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      const z = rect[1] + ((j + 0.5) / N) * (rect[3] - rect[1]);
      for (let i = 0; i < N; i++) {
        const x = rect[0] + ((i + 0.5) / N) * (rect[2] - rect[0]);
        const v = Math.round(Math.max(0, Math.min(1, accum.fines(x, z))) * 255);
        const o = (j * N + i) * 4;
        data[o] = v;
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    // A field, not a colour: no sRGB decode on the way in.
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.textures.push(tex);
    return { field: tex, rect, wind: new THREE.Vector2(accum.wind.dirX, accum.wind.dirZ) };
  }

  private buildMaterials(
    F: number,
    sun: THREE.Vector3,
    weather: number,
    course: number,
    grooveShadow: number,
    accum: AccumLookup | null
  ): void {
    const macro = makeMacroNoise(512, 2202);
    this.textures.push(macro);

    const cmuMaps = makeBuildingCmu(1024, 2101);
    const vctMaps = makeBuildingVct(1024, 3307);
    const ceilMaps = makeBuildingCeilingTile(512, 5501);
    const aluMaps = makeBuildingMetal(512, 0.9, 7703, 0xa8adb0, 0.04);
    const galvMaps = makeBuildingMetal(512, 1.4, 7717, 0xb2b6b2, 0.16);
    const steelMaps = makeBuildingMetal(512, 1.1, 7729, 0x8e9490, 0.42);
    const darkMaps = makeBuildingMetal(512, 1.0, 7741, 0x4a4f52, 0.22);
    this.maps.push(cmuMaps, vctMaps, ceilMaps, aluMaps, galvMaps, steelMaps, darkMaps);

    const concreteMaps = makeConcrete(1024, 4, 199);
    const glassMaps = makeBuildingGlassGrime(512, 2.2, 9109);
    const rustTex = makeBuildingRustStreak(512, 4211);
    const scuffTex = makeBuildingScuff(256, 6607);
    const trafficTex = makeBuildingScuff(256, 6608, 0x2c2822);
    const condTex = makeBuildingCondensation(512, 8803);
    this.textures.push(
      concreteMaps.map,
      concreteMaps.normalMap,
      concreteMaps.roughnessMap,
      glassMaps.roughnessMap,
      glassMaps.normalMap,
      glassMaps.grimeMap,
      rustTex,
      scuffTex,
      trafficTex,
      condTex
    );

    const std = (params: THREE.MeshStandardMaterialParameters) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, dithering: true, ...params });
      this.materials.push(m);
      return m;
    };
    const surfaced = (
      m: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture },
      extra: THREE.MeshStandardMaterialParameters = {}
    ) => std({ map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, ...extra });

    /**
     * Spread into the two masonry weather calls. Empty when the service is
     * absent, which `applyBuildingWeather` treats as "use the local model" and
     * `bakeAccumField` has already reported as an error, so the degradation is
     * loud in one place instead of invisible in two.
     *
     * `?bgaccum=0` forces the local model back for the A/B. The claim being
     * tested is that the base band moves *and* agrees with the ground beside
     * it, and only a same-bundle control can show the first half of that.
     */
    const useAccum = dbg("bgaccum", 1) !== 0;
    const accumOpts =
      accum && useAccum
        ? { accumField: accum.field, accumRect: accum.rect, windDir: accum.wind, driftStrength: 0.42 }
        : {};

    /* --- masonry --- */
    const cmuExt = surfaced(cmuMaps, { normalScale: V2(0.85, 0.85), envMapIntensity: 0.9 });
    applyBuildingWeather(cmuExt, {
      key: "cmu-ext",
      macro,
      macroMetres: 5.5,
      baseY: F - 0.14,
      grimeRise: 1.35,
      grimeStrength: 0.5,
      band: [0.0, 0.38],
      bandStrength: 0.4,
      ...accumOpts,
      sunDir: sun,
      fade: 0.34,
      soffit: 0.22,
      // Runoff off the coping cap. Sourced at the joints between cap sections
      // rather than hanging evenly off the whole edge — a 10 ft section, which
      // is what this parapet is capped with.
      drip: [F + PLAN.parapet - 0.03, 1.9],
      dripStrength: 0.44,
      dripPitch: 3.05,
      patchiness: 0.55,
      elevationDrift: 0.075,
      amount: weather,
    });
    // Coursing goes on *after* the weathering, and declares its own varyings,
    // so which of the two injects first cannot matter. See buildingCoursing.ts.
    applyBuildingCoursing(cmuExt, { key: "cmu-ext", sunDir: sun, amount: course, shadowScale: grooveShadow });

    /**
     * ### The temporary compensation that used to live here is gone.
     *
     * For one night this was 0x928b7c, lifted from 0x6a6659 because Lighting's
     * promotion of the PMREM world capture took the shaded elevations' fill
     * light away and pushed the `corner` pose's near-black fraction from 0.41%
     * to 2.67%, through a 2% gate. It was labelled as a compensation, reported
     * upward rather than absorbed, and reverted as soon as the cause was fixed:
     * Lighting has settled the ambient at sun 4.4 and environment 2.4, and
     * `corner` now measures **0.06%** near-black against that same 2% gate.
     *
     * It is recorded here rather than deleted because the useful part is the
     * shape, not the value. **A compensation for another system's defect is
     * only safe if it is labelled, reported, and cheap to remove** — the danger
     * is never the number, it is that the number stops being recognisable as a
     * compensation, and then the real fix lands underneath it and nothing
     * visibly breaks. Five systems each quietly compensating for the same
     * missing light is NOTES case 17, and the only reason this one came out
     * cleanly is that it never stopped announcing what it was.
     */
    const cmuBase = surfaced(cmuMaps, { color: 0x6a6659, normalScale: V2(0.9, 0.9), envMapIntensity: 0.75 });
    applyBuildingWeather(cmuBase, {
      key: "cmu-base",
      macro,
      macroMetres: 4.0,
      baseY: F - 0.14,
      grimeRise: 0.7,
      /**
       * Down from 0.62. At that strength the total coverage saturated at 1
       * over most of the base course, and a saturated term carries no
       * information: the `base` pose showed a 0.6 m black plinth with a ruled
       * top edge and none of the spatter or the tide line underneath it was
       * visible at all, because every pixel had already clipped. The splash
       * zone only reads if the wall it is on has somewhere left to go.
       */
      grimeStrength: 0.34,
      // Lifted from 0x2f2b24. Splash off wet paving is pale silt, not soot,
      // and the old value put the `base` pose's near-black fraction within a
      // whisker of its 2% gate before any of this touched it.
      grimeColor: new THREE.Color(0x4f4738),
      /**
       * The splash zone proper. The base course is the 0.6 m of block that
       * actually gets rained on off the paving, so its band reaches higher
       * than the wall above it — and because the two courses are separate
       * materials with separate bands, the dirt line lands where the base
       * course ends, which is exactly where a real one does.
       *
       * The strength is *below* the old 0.35 x 1.4 peak on purpose. Spatter is
       * a redistribution, not an addition: some of it darker, more of it
       * cleaner. Raising the peak instead doubled the near-black fraction in
       * the `base` pose, 1.32% to 2.55%, and failed the gate.
       */
      band: [0.0, 0.3],
      bandStrength: 0.34,
      /**
       * The band above is now an envelope Terrain owns rather than one authored
       * here: `groundAccum.wallBase()` replaces it, 180 mm e-folding off grade,
       * scaled by `fines(x, z)` and by which face the wind drives against. The
       * `band[0]` offset still matters — it is where grade is for *this*
       * course — but the height and the shape are the site's.
       *
       * This is the course the critic called "a solid black band with an abrupt
       * horizontal top edge and no dirt splash-zone transition into the
       * pavement", and the transition is now the same function the pavement
       * beside it uses. The drift term adds the tight line at grade itself,
       * which is the part no wall-only model can produce, because drift lives
       * *out* from the wall and prefers the sheltered face while splash lives
       * *on* it and prefers the windward one.
       */
      ...accumOpts,
      patchiness: 0.4,
      amount: weather,
    });
    // The base course is grubbier, so its beds hold noticeably more dirt.
    applyBuildingCoursing(cmuBase, {
      key: "cmu-base",
      sunDir: sun,
      // Splash and salt have eaten the base joints out deeper than the ones
      // above, so they self-shadow harder and hold far more dirt.
      depth: 0.006,
      occlusion: 0.3,
      soilStrength: 0.42,
      amount: course,
      shadowScale: grooveShadow,
    });

    const cmuInt = surfaced(cmuMaps, { color: 0xf0ece2, normalScale: V2(0.55, 0.55), envMapIntensity: 0.5 });
    applyBuildingWeather(cmuInt, {
      key: "cmu-int",
      macro,
      macroMetres: 3.4,
      baseY: F,
      grimeRise: 0.34,
      grimeStrength: 0.42,
      grimeColor: new THREE.Color(0x6e6656),
      band: [0.02, 0.16],
      bandStrength: 0.45,
      patchiness: 0.3,
      amount: weather,
    });
    // Inside, the block has had four or five coats over the years: the joints
    // are half filled and the recess is much shallower than outside.
    applyBuildingCoursing(cmuInt, {
      key: "cmu-int",
      sunDir: sun,
      // Four or five coats have half filled these, so the recess is a third of
      // the depth outside, and there is no sun indoors to rake across it.
      depth: 0.0015,
      occlusion: 0.14,
      shadow: 0.2,
      soilStrength: 0.12,
      bump: 0.5,
      unitVariation: 0.045,
      unitRoughness: 0.07,
      amount: course,
      shadowScale: grooveShadow,
    });

    /* --- metals --- */
    const alu = surfaced(aluMaps, { metalness: 0.82, roughness: 0.44, normalScale: V2(0.3, 0.3), envMapIntensity: 1.1 });
    const galv = surfaced(galvMaps, { metalness: 0.7, roughness: 0.58, normalScale: V2(0.4, 0.4), envMapIntensity: 1.0 });
    const steel = surfaced(steelMaps, { metalness: 0.6, roughness: 0.7, normalScale: V2(0.55, 0.55), envMapIntensity: 0.85 });
    applyBuildingWeather(steel, {
      key: "steel",
      macro,
      macroMetres: 3.0,
      baseY: F - 0.14,
      grimeRise: 0.85,
      grimeStrength: 0.45,
      soffit: 0.18,
      amount: weather,
    });
    // Indoor twin, see the note on `enamel` below. Weathered separately and
    // much less: nothing indoors has ever been rained on.
    const steelInt = surfaced(steelMaps, { metalness: 0.6, roughness: 0.7, normalScale: V2(0.55, 0.55), envMapIntensity: 0.85 });
    applyBuildingWeather(steelInt, {
      key: "steel-int",
      macro,
      macroMetres: 2.4,
      baseY: F,
      grimeRise: 0.3,
      grimeStrength: 0.28,
      grimeColor: new THREE.Color(0x6b6558),
      amount: weather,
    });
    const darkMetal = surfaced(darkMaps, { metalness: 0.55, roughness: 0.62, normalScale: V2(0.35, 0.35), envMapIntensity: 0.9 });
    // Also carries the storefront fascia, which is the one large flat panel on
    // the elevation and therefore the one that most obviously reads as "new"
    // if it is left clean. The drip is keyed to the top of the fascia; the
    // interior fittings on this material all sit well below the falloff.
    applyBuildingWeather(darkMetal, {
      key: "dark-metal",
      macro,
      macroMetres: 2.6,
      baseY: F,
      grimeRise: 0.3,
      grimeStrength: 0.34,
      grimeColor: new THREE.Color(0x24211c),
      drip: [F + PLAN.fasciaTop - 0.02, 0.78],
      dripStrength: 0.58,
      // Fascia panels join every 1.22 m and the runs come out of the joints.
      dripPitch: 1.22,
      soffit: 0.16,
      amount: weather,
    });
    /**
     * White appliance enamel and light structural steel each exist twice, once
     * for outdoors and once for indoors, and the split is load-bearing rather
     * than cosmetic.
     *
     * `tuneInteriorMaterials` in `lightInterior.ts` dims the store's IBL
     * response by matching **mesh names** — but a mesh does not own its
     * material, and this file batches by material. One enamel material carried
     * the ceiling grid and the troffer pans (indoors) together with the ice
     * machine and the propane bottles (outdoors); one steel material carried
     * the cooler shelves together with every downspout, the roof kit and the
     * propane cage. Naming an interior mesh therefore dimmed the exterior ones.
     *
     * That cost nothing while `envMapIntensity` was inert (NOTES.md case 21).
     * Once the binder made it live it cost the ice machine 46% of its
     * brightness — measured on the `corner` pose between `?ienv=0.07` and
     * `?ienv=1.0`, 67.2 -> 98.1 of 255 over 90.5% of its pixels, against a CMU
     * wall control that moved 1.1 and an asphalt control that moved 0.00.
     *
     * `tools/probe-envmat.mjs` is the standing assertion: it builds this system
     * headless and fails if any material the interior pass reaches is also
     * drawn beyond the building envelope. Keep the two families disjoint.
     */
    const enamel = surfaced(galvMaps, { color: 0xd8d8d2, metalness: 0.22, roughness: 0.48, normalScale: V2(0.22, 0.22) });
    const enamelInt = surfaced(galvMaps, { color: 0xd8d8d2, metalness: 0.22, roughness: 0.48, normalScale: V2(0.22, 0.22) });
    // Shop fittings. Gondolas and counters are painted steel in the pale
    // putty-grey every fixture catalogue sells; running them on `darkMetal`
    // turned every end panel into a flat black hole with no form in it.
    // Built on the light sheet maps, not the dark ones: `color` multiplies the
    // map, so tinting a near-black albedo "pale grey" only ever gets you a
    // slightly less black panel.
    const fixture = surfaced(galvMaps, {
      color: dbg("dbgFixture") ? 0xff00ff : 0xa9a69c,
      metalness: 0.16,
      roughness: 0.58,
      normalScale: V2(0.3, 0.3),
      envMapIntensity: 0.7,
    });
    applyBuildingWeather(fixture, {
      key: "fixture",
      macro,
      macroMetres: 2.2,
      baseY: F,
      grimeRise: 0.22,
      grimeStrength: 0.4,
      grimeColor: new THREE.Color(0x6b6558),
      band: [0.0, 0.13],
      bandStrength: 0.4,
      soffit: 0.14,
      amount: weather,
    });
    const bollard = surfaced(steelMaps, { color: 0xd6a92c, metalness: 0.3, roughness: 0.74, normalScale: V2(0.6, 0.6) });
    const concrete = surfaced(concreteMaps, { normalScale: V2(0.3, 0.3), envMapIntensity: 0.85 });

    /* --- glazing --- */
    /**
     * `?bglsep=0` puts the pre-separation single conflated material back, so
     * the architectural change can be A/B'd against itself on one pose.
     * `?bglrefl=<k>` scales every reflection leaf for a forced-value diff —
     * `?bglrefl=0` should black the leaves out entirely, which is the cheapest
     * proof that they are the surface being measured and not something behind
     * them. Both rejected rather than coerced when unparseable: NOTES case 25.
     */
    const glSeparate = dbg("bglsep", 1) !== 0;
    /** `?bglabs=0` — restore the tinted alpha veil the panes used to carry. */
    const absorbOnly = dbg("bglabs", 1) !== 0;
    if (!Number.isFinite(dbg("bglabs", 1))) throw new Error("BuildingSystem: ?bglabs must be a number");
    const reflGain = dbg("bglrefl", 1);
    if (!Number.isFinite(reflGain) || !Number.isFinite(dbg("bglsep", 1))) {
      throw new Error("BuildingSystem: ?bglsep / ?bglrefl must be numbers");
    }
    /**
     * A pane of glass does two independent things, and one alpha-blended
     * material cannot express both.
     *
     * It **transmits** what is behind it, attenuated by the glass, and it
     * **reflects** the environment in front of it. The reflection is *added*
     * to the transmitted image; it does not attenuate with how transparent the
     * glass is. But `gl_FragColor.rgb` is multiplied by `alpha` on the way into
     * the framebuffer, so with `opacity: 0.24` the environment reflection was
     * arriving at **24% of its true strength**, and every attempt to make the
     * glass show more of the interior made it reflect less of the sky. The two
     * were one number.
     *
     * So the pane is now two coincident leaves:
     *
     * - this material, **transmission only** — `specularIntensity: 0` removes
     *   F0 entirely, so it contributes the tint and nothing else, and its
     *   `opacity` now means one thing;
     * - `glassRefl` below, **reflection only** — black diffuse, additively
     *   blended at full alpha, so the environment lands unattenuated whatever
     *   the pane's opacity is.
     *
     * Rendered second, which is not optional. Alpha over additive gives
     * `(bg + refl) * (1 - a) + tint * a`, i.e. the reflection attenuated by the
     * pane in front of it — the bug, reintroduced. Additive over alpha gives
     * `bg * (1 - a) + tint * a + refl`, which is the physics.
     *
     * `?bglsep=0` restores the single conflated material for an A/B.
     */
    const glass = new THREE.MeshPhysicalMaterial({
      /**
       * ### Black. On purpose. This is the other half of the case-39 fix.
       *
       * Player traced a milky wash over the whole interior to this material by
       * suppressing one layer at a time from a fixed camera: with the glazing
       * present the frame read black point 70 and range 139, with it gone 13
       * and 238, against 22 and 232 for a camera genuinely inside the shop. The
       * additive reflection leaves cost **zero** in that test, which was
       * Player's leading hypothesis and it reported it as wrong by zero.
       *
       * Under alpha blending the result is `bg * (1 - a) + tint * a`. Those are
       * two different physical things: `1 - a` is **transmittance**, and
       * `tint * a` is a **veil added on top**. A pane of glass has the first
       * and does not have the second — glass attenuates what is behind it, it
       * does not add a flat lit surface to it. With a non-black diffuse the
       * veil term put a constant floor under every pixel seen through the
       * glazing, which is precisely a black point of 70 where the scene's own
       * is 13, and it could not be tuned away because reducing `opacity` to
       * shrink the veil also stopped the pane attenuating anything.
       *
       * Setting the diffuse to black collapses alpha blending to `bg * (1 - a)`
       * — pure transmittance, and a black point that is preserved exactly
       * because zero times anything is zero. **This is the same move as the
       * reflection leaf, in the other direction:** that one has black diffuse
       * so that *additive* blending can only carry reflection; this one has
       * black diffuse so that *alpha* blending can only carry transmission.
       * Each blend mode expresses exactly one physical process once the term it
       * cannot express is removed from it.
       *
       * `opacity` therefore now means `1 - transmittance` and nothing else, and
       * the Fresnel coupling in `buildingGlazing.ts` still works untouched —
       * it raises `a` towards grazing, which is more attenuation, which is
       * correct. The pane's colour, its green cast and its highlights all live
       * on the reflection leaf, where a front-surface effect belongs.
       *
       * `?bglabs=0` restores the tinted veil for an A/B.
       */
      color: absorbOnly ? 0x000000 : 0xd7e2dc,
      metalness: 0,
      roughness: 0.05,
      roughnessMap: glassMaps.roughnessMap,
      normalMap: glassMaps.normalMap,
      normalScale: V2(0.22, 0.22),
      /**
       * NO TRANSMISSION. `?bgt=1` puts it back for anyone re-investigating.
       *
       * The band of hard-edged pure-black rectangles across the lower glazing —
       * a critic's #1 defect, and an "outright rendering bug" — came from
       * three's transmission render target. Three measurements on the same
       * region of the same pose, each isolating one lever:
       *
       *   DoubleSide -> FrontSide        34.7% -> 22.7% exactly rgb(0,0,0)
       *   roughness map off, mip 0 only  22.7% -> 11.8%
       *   transmission off entirely      22.7% ->  0.0%
       *
       * The first two are partial because both only reduce how much this
       * material *leans on* that target: the self-sampling back-side pre-pass
       * (three.module.js:18054) is one route in, and the roughness map choosing
       * a high mip of a partly bad texture is another — which is why the
       * artefacts are blocky, axis-aligned and various power-of-two sizes, the
       * shape of bad texels averaged up a mip chain. Only not using the target
       * removes it.
       *
       * Giving it up costs nothing real. The attenuation it existed to provide
       * was exp(-0.008 / 0.6) = 98.7% transmitted, i.e. 1.3%, invisible. It
       * costs a full extra scene render every frame. And this was the only
       * transmissive material in the project — `CarSystem` had already reached
       * the same conclusion for its own glazing on its own evidence — so the
       * whole pass is now gone from the frame.
       *
       * Note the balance this changes: under alpha blending, `opacity` scales
       * the environment reflection as well as the transmitted image, so
       * reflection strength is no longer independent of show-through. That is
       * not reflectivity *tuning*, which is on hold until Lighting reports a
       * structured environment — right now the lower hemisphere is a constant
       * colour, so there is nothing to reflect at any strength. When it has
       * content, the reflection wants to be its own additive layer so the two
       * can be set separately.
       */
      transmission: dbg("bgt", 0),
      transparent: true,
      /**
       * `1 - transmittance`, now that it means only that.
       *
       * 0.24 was authored when the number was doing three jobs at once — veil
       * strength, reflection strength and attenuation. Case 39 says to keep the
       * number identical across an architectural separation so the architecture
       * can be told from the tuning, and that was right. **What it does not say,
       * and should, is that keeping it identical is the first of two steps: the
       * value then has to be re-derived in its new single meaning.** Skipping
       * the second step leaves a number that was correct for a job it no longer
       * does, which is how a fixed architecture keeps a broken value.
       *
       * Re-derived: clear float glass transmits about 0.90 per leaf and the
       * front-surface reflection is already accounted for separately on the
       * additive leaf, so what is left here is bulk absorption only — a few
       * percent. 0.055 outer over 0.035 inner gives a combined transmittance of
       * 0.912 against the previous 0.661.
       */
      opacity: absorbOnly ? 0.055 : 0.24,
      depthWrite: false,
      thickness: 0.008,
      ior: 1.52,
      attenuationColor: new THREE.Color(0x9fc3b4),
      attenuationDistance: 0.6,
      // Both zero when separated: every reflective term moves to the additive
      // leaf. `specularIntensity` is the one that matters — it zeroes F0, so
      // the *direct* sun highlight moves across too, and a sun glint is as
      // much a front-surface reflection as the sky is.
      envMapIntensity: glSeparate ? 0 : 1.25,
      specularIntensity: glSeparate ? 0 : 1,
      /**
       * **Never `DoubleSide` on a transmissive material.** See the long note at
       * `addPane` in `buildStorefront`: three 0.185.1 renders a `DoubleSide`
       * transmissive object into the transmission render target that the same
       * object samples, and on this driver the undefined read comes back as
       * exactly zero in blocky tiles. Each viewing direction gets its own
       * single-sided leaf instead.
       */
      side: THREE.FrontSide,
    });
    this.materials.push(glass);
    /**
     * The inner leaf of the IGU. Not a clone: the inside face of a shopfront
     * has a different life from the outside one. It never sees rain, so the
     * film on it is handprints and cleaner smear rather than weather, and it is
     * the surface the interior poses actually look at.
     */
    const glassInner = glass.clone();
    if (!absorbOnly) glassInner.color = new THREE.Color(0xdae4de);
    glassInner.roughness = 0.075;
    glassInner.thickness = 0.006;
    // Lower than the outer leaf: this is the one the interior poses look
    // *through* at the forecourt, and the exterior needs to read.
    glassInner.opacity = absorbOnly ? 0.035 : 0.13;
    this.materials.push(glassInner);
    // Cooler doors are only ever seen from the shop floor, so a single leaf
    // facing the shopper is both correct and one draw cheaper.
    const coolerGlass = glass.clone();
    if (!absorbOnly) coolerGlass.color = new THREE.Color(0xdfeaf0);
    coolerGlass.attenuationColor = new THREE.Color(0xa8c6d6);
    coolerGlass.thickness = 0.014;
    coolerGlass.roughness = 0.07;
    // A cooler door is a triple-glazed unit with a low-e coating, so it is
    // markedly less transparent than a shopfront and noticeably cooler in
    // colour. It also read as "a glowing white light panel", which a pane
    // carrying more of its own tint helps.
    // A low-e coated triple unit really does hold back a fifth of the light, and
    // unlike the shopfront that is a *transmittance* claim rather than a veil,
    // so it survives the change to absorption-only semantics at nearly its old
    // magnitude.
    coolerGlass.opacity = absorbOnly ? 0.2 : 0.3;
    this.materials.push(coolerGlass);

    /**
     * The reflection half of a pane.
     *
     * Black diffuse, so the only thing this material can emit is specular:
     * `metalness` is 0 and `ior` 1.52 gives the physically correct F0 of
     * 0.043, and the Fresnel curve in the BRDF then does what a glancing
     * reflection off glass actually does without anyone tuning a rim term.
     *
     * `AdditiveBlending` at `opacity: 1` is what makes the strength
     * independent of the pane's transparency, which was the whole point.
     *
     * The intensity is deliberately **left at the 1.25 the conflated material
     * carried**. Separating a parameter and re-tuning it in the same change
     * makes the measurement worthless — you cannot tell the architecture from
     * the number. Tune after measuring, and note that 1.25 is a value from the
     * period when this material had no `envMap` of its own and
     * `envMapIntensity` was inert (NOTES.md case 26), so it is a suspect
     * number twice over.
     */
    const reflLeaf = (base: THREE.MeshPhysicalMaterial, strength: number) => {
      if (!glSeparate) return null;
      const m = base.clone();
      m.color = new THREE.Color(0x000000);
      m.specularIntensity = 1;
      m.envMapIntensity = strength * reflGain;
      m.transmission = 0;
      m.opacity = 1;
      m.transparent = true;
      m.blending = THREE.AdditiveBlending;
      m.depthWrite = false;
      m.side = THREE.FrontSide;
      this.materials.push(m);
      return m;
    };
    /**
     * 1.0, not the 1.25 these three carried, and the reason the 1.25 survived is
     * worth keeping: **the pane that could measure it was not the pane anyone
     * measured.** Player suppressed the storefront's additive passes from a
     * fixed camera and reported their contribution as exactly zero, which
     * exonerated the architecture and left the constant unexamined — a shopfront
     * at dawn reflects a dim exterior, so a 25% boost on nearly nothing is
     * nearly nothing.
     *
     * A cooler door reflects the lit shop interior, and since Lighting promoted
     * the PMREM world capture that is now a bright, structured thing. Measured
     * in the `cooler` pose with `?bglrefl=0` against the default, the leaves are
     * worth **p75 191 → 163 and the fraction over 224 halved, 6.51% → 3.89%** —
     * the same constant, two orders of consequence apart, because the two panes
     * reflect different worlds.
     *
     * There was never a physical basis for 1.25: `ior` 1.52 already gives the
     * correct F0 of 0.043 and the BRDF's own Fresnel does the rest, so the boost
     * was compensation for a period when there was nothing structured to
     * reflect. `?bglrefl` still scales all three for the A/B.
     */
    const glassRefl = reflLeaf(glass, 1.0);
    const glassInnerRefl = reflLeaf(glassInner, 1.0);
    const coolerGlassRefl = reflLeaf(coolerGlass, 1.0);

    /**
     * The other half of the separation: light that reflects off a pane is light
     * that did not get through it, so the transmission leaves have to *stop*
     * transmitting as the view grazes. Applied here, after every clone above
     * has been taken, and only to the transmission leaves — see the long note
     * in `buildingGlazing.ts` for why this is a shader term rather than an
     * opacity value.
     *
     * `?bgfres=0` disables it, which is the A/B for the door interaction.
     */
    const fres = dbg("bgfres", 1);
    if (!Number.isFinite(fres)) throw new Error("BuildingSystem: ?bgfres must be a number");
    if (glSeparate) {
      applyGlazingFresnel(glass, { key: "glass", amount: fres });
      applyGlazingFresnel(glassInner, { key: "glass-inner", amount: fres });
      applyGlazingFresnel(coolerGlass, { key: "cooler-glass", amount: fres });
    }

    /* --- decals --- */
    const decal = (map: THREE.Texture, opacity: number, roughness: number, color = 0xffffff) =>
      std({
        map,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        roughness,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });

    /* --- placeholder emitters, replaced by System 4 --- */
    const diffuser = std({
      color: 0xf2f4f5,
      emissive: new THREE.Color(0xdfe9f2),
      emissiveIntensity: 2.4,
      roughness: 0.42,
    });
    /**
     * The lay-in troffer lens gets its own instance of the same material.
     *
     * It used to share `diffuser` with the exterior wall-pack lens, which was
     * harmless only by luck: `lightInterior` matches both mesh names in one
     * branch and dedupes by material, so a single write drove both. The
     * moment either wanted to differ, one of them would have silently
     * followed the other — the shape of NOTES case 40, one property, two
     * owners. It wants to differ now, because a fluorescent tube pattern
     * belongs on the interior fitting and not on the wall pack outside.
     *
     * Only the emissive *map* is added here. Lighting keeps `emissive` and
     * `emissiveIntensity`, so the level stays where it belongs and this
     * changes only the distribution inside the panel.
     */
    /**
     * `?blens=0` forces the map off, because a feature that does nothing and a
     * feature that is subtle are the same screenshot, and both controls have to
     * live in the same bundle to be worth anything.
     */
    const lensMap = dbg("blens", 1) !== 0;
    if (!Number.isFinite(dbg("blens", 1))) throw new Error("BuildingSystem: ?blens must be a number");
    const trofferLensTex = lensMap ? makeTrofferLens() : null;
    if (trofferLensTex) this.textures.push(trofferLensTex);
    const trofferLens = std({
      color: 0xf2f4f5,
      emissive: new THREE.Color(0xdfe9f2),
      emissiveIntensity: 2.4,
      emissiveMap: trofferLensTex,
      map: trofferLensTex,
      roughness: 0.42,
    });
    // TODO(System 4 - lighting): the emissive here is a stand-in for the tube
    // lights in the mullions. Kept low so the liner does not blow out to paper
    // white and swallow the silhouettes of the bottles standing against it.
    const coolerLiner = std({
      color: 0xbfc7cc,
      emissive: new THREE.Color(0xcfe0ea),
      emissiveIntensity: 0.22,
      roughness: 0.62,
    });

    /**
     * Product. The palette lives in the vertex colours and the printing lives
     * in the map, which is greyscale — see `makeProductLabels`. `?dbgLabels`
     * swaps the sheet for a magenta checker, which is the region diff that
     * proves the map is sampled at all rather than silently unbound.
     */
    const packTex = makeProductLabels(dbg("dbgLabels") > 0);
    this.textures.push(packTex);
    const product = std({ vertexColors: true, map: packTex, roughness: 0.52, envMapIntensity: 0.7 });
    /**
     * The cooler stock shares `packTex` rather than carrying a sheet of its
     * own — bottle labels live in cells 12..15 of the same atlas, so the
     * texture memory delta for putting print on every bottle in the cooler is
     * zero, and the draw-call delta is zero as well because the stock was
     * already one merged mesh on this one material.
     *
     * This material had no `map` at all until now, which is why every bottle
     * in the building was a flat extruded colour while the shelf packaging
     * beside it was printed: `applyPackaging` was never called on a lathe and
     * there was nothing for it to have sampled if it had been.
     */
    /**
     * ### The handheld bottle's four leaves
     *
     * One physical process each, and none of them carrying a term its own
     * arrangement cannot express — the rule the glazing produced, applied here
     * from the start rather than discovered afterwards. The old single material
     * had to be the container, the contents and the print at once, and the
     * arithmetic of that is why it read as a tinted solid: a drink colour
     * multiplied into the surface that was also supposed to be printing the
     * label took a white label to 14/255.
     */
    const heroLabelTex = makeHeroBottleLabel();
    this.textures.push(heroLabelTex);
    /**
     * The PET wall. **No diffuse colour and no map** — a transmissive leaf is
     * for transmission, and anything else on it is the veil term all over
     * again. What little colour PET has belongs in `attenuationColor` over an
     * `attenuationDistance`, because a medium's tint is a function of the path
     * length through it, which is the whole difference between a bottle and a
     * cylinder painted bottle-coloured.
     */
    const heroShell = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 1.0,
      ior: 1.5,
      thickness: 0.0045,
      roughness: 0.055,
      metalness: 0,
      attenuationColor: new THREE.Color(0xdff0ef),
      attenuationDistance: 0.35,
      clearcoat: 0.35,
      clearcoatRoughness: 0.1,
      transparent: true,
      side: THREE.FrontSide,
      dithering: true,
    });
    this.materials.push(heroShell);
    /**
     * The contents. Transmissive too, at water's `ior` rather than PET's, and
     * with the attenuation doing the work: still mineral water is nearly clear,
     * so the visible cues are the refraction offset through the fill and the
     * meniscus catching the ceiling, not a colour.
     *
     * Two transmissive leaves share three.js's one transmission target, so this
     * costs a draw call and no extra render pass. The failure mode to watch is
     * the one this system already had once — a transmissive leaf sampling an
     * uninitialised target and coming out exactly black — so the round that
     * lands this runs `probe-zeroscan` rather than trusting it.
     */
    const heroLiquid = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 0.94,
      ior: 1.333,
      thickness: 0.06,
      roughness: 0.02,
      metalness: 0,
      attenuationColor: new THREE.Color(0xd6ece9),
      attenuationDistance: 0.22,
      transparent: true,
      side: THREE.FrontSide,
      dithering: true,
    });
    this.materials.push(heroLiquid);
    /** The printed sleeve: opaque film, so the print is print and nothing else. */
    const heroLabel = std({
      map: heroLabelTex,
      roughness: 0.38,
      metalness: 0,
      envMapIntensity: 0.55,
    });
    /** The closure: its own colour, and rougher than the film beside it. */
    const heroCap = std({
      color: 0x2b6ea3,
      roughness: 0.33,
      metalness: 0,
      envMapIntensity: 0.7,
    });

    const bottle = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      map: packTex,
      roughness: 0.16,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
      /**
       * **This value is not used. Do not tune it.**
       *
       * It was authored at 0.5, down from 1.0, to stop clearcoated lathes
       * reflecting a flat wash off the emissive cooler liner and coming out
       * the same pale pastel whatever their albedo. It cannot do that, because
       * this material is drawn by the mesh named `cooler-stock`, which is in
       * `tuneInteriorMaterials`' INTERIOR set, and that function assigns
       * `envMapIntensity = interiorEnv` over whatever is authored here. The
       * binder then adopts Lighting's value as the authored one, so the
       * override is permanent rather than first-frame.
       *
       * This is NOTES case 26's shape with a different mechanism — not an
       * inert uniform, but a live one owned by another system — and it is
       * worth flagging that the wrong value was written *by me*, an hour after
       * reading case 26, and read as deliberate. Use `?ienv=` to move it; the
       * dial for the cooler's pastel drinks is Lighting's, and the finding
       * that the cooler `RectAreaLight`s were the real cause of the wash-out
       * has already gone to them.
       */
      envMapIntensity: 1.0,
    });
    this.materials.push(bottle);

    /* --- signage --- */
    const fasciaTex = makeFasciaSign();
    const valanceTex = makeCoolerValance(COOLER.doors);
    const stripTex = makeShelfStrip(17);
    this.vinylSheet = makeWindowVinyl();
    this.plateSheet = makeSignPlates();
    this.noticeSheet = makeWindowNotices();
    this.textures.push(fasciaTex, valanceTex, stripTex, this.vinylSheet.texture, this.plateSheet.texture, this.noticeSheet.texture);

    // The fascia box and the valance are internally lit acrylic, so they carry
    // their own emissive rather than relying on the sun. Modest: at dawn the
    // panel is brighter than the wall behind it but is not a light source in
    // the scene, and blowing it out would cost the only legible type on the
    // building. TODO(System 4): if the wall-pack photocell is ever animated,
    // these should switch with it.
    const signFascia = std({
      map: fasciaTex,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: fasciaTex,
      emissiveIntensity: 0.55,
      roughness: 0.34,
      envMapIntensity: 0.6,
    });
    const signValance = std({
      map: valanceTex,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: valanceTex,
      emissiveIntensity: 0.4,
      roughness: 0.4,
      envMapIntensity: 0.35,
    });
    const signStrip = std({ map: stripTex, roughness: 0.68, envMapIntensity: 0.3 });
    const cutVinyl = (map: THREE.Texture, roughness: number) =>
      std({
        map,
        transparent: true,
        // A cut vinyl edge is hard, so alpha-test rather than blend for the body
        // of it: that keeps the decals in the depth buffer and stops them
        // sorting badly against the glass they are stuck to.
        alphaTest: 0.35,
        depthWrite: true,
        roughness,
        envMapIntensity: 0.4,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
    const vinyl = cutVinyl(this.vinylSheet.texture, 0.52);
    const plate = cutVinyl(this.plateSheet.texture, 0.7);
    // Paper, not vinyl: opaque, and matt enough that it does not pick up the
    // sky the way the glass behind it does.
    const notice = std({ map: this.noticeSheet.texture, roughness: 0.88, envMapIntensity: 0.3 });

    this.mat = {
      cmuExt,
      cmuBase,
      cmuInt,
      vct: surfaced(vctMaps, { normalScale: V2(0.35, 0.35), envMapIntensity: 0.55 }),
      ceilTile: surfaced(ceilMaps, { normalScale: V2(0.6, 0.6), envMapIntensity: 0.35 }),
      alu,
      galv,
      steel,
      steelInt,
      darkMetal,
      enamel,
      enamelInt,
      fixture,
      bollard,
      concrete,
      glass,
      glassInner,
      coolerGlass,
      glassRefl,
      glassInnerRefl,
      coolerGlassRefl,
      diffuser,
      trofferLens,
      coolerLiner,
      product,
      bottle,
      heroShell,
      heroLiquid,
      heroLabel,
      heroCap,
      rust: decal(rustTex, 0.92, 0.9),
      scuff: decal(scuffTex, 0.7, 0.92),
      traffic: decal(trafficTex, 0.5, 0.3),
      condensation: decal(condTex, 0.85, 0.35, 0xd8e6ee),
      /**
       * Was 0.9. Player measured this layer alone lifting the black point from
       * 54 to 70 and removing 5.1% of the frame from above display 224 — it was
       * the specific thing killing the highlights seen through the glazing.
       *
       * The grime *map* is not the problem and has not changed: its alpha is
       * already sparse and edge-weighted, peaking around 0.2 mid-pane. 0.9 was
       * a near-unity scale on top of it, and unlike the pane's own opacity this
       * one legitimately is a veil — scattered dust does add light — so it
       * cannot be solved by making the diffuse black. It can only be smaller.
       */
      grime: decal(glassMaps.grimeMap, 0.45, 0.85),
      signFascia,
      signValance,
      signStrip,
      vinyl,
      plate,
      notice,
    };

    this.uv = {
      cmu: V2(CMU_TILE_X, CMU_TILE_Y),
      alu: V2(aluMaps.tileX, aluMaps.tileY),
      galv: V2(galvMaps.tileX, galvMaps.tileY),
      steel: V2(steelMaps.tileX, steelMaps.tileY),
      dark: V2(darkMaps.tileX, darkMaps.tileY),
      vct: V2(vctMaps.tileX, vctMaps.tileY),
    };
  }

  /* ---------------------------------------------------------------- */
  /* small builders                                                    */
  /* ---------------------------------------------------------------- */

  /** World-space box appended to one of the merge batches. */
  private wbox(
    list: THREE.BufferGeometry[],
    uv: THREE.Vector2,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number
  ): void {
    list.push(buildingWorldBox(V3(x0, y0, z0), V3(x1, y1, z1), { uvMetres: uv }));
  }

  private addMesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string, renderOrder = 0): THREE.Mesh {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.renderOrder = renderOrder;
    this.group.add(m);
    return m;
  }

  /**
   * A pane and its additive reflection leaf, sharing one geometry.
   *
   * The reflection mesh must draw *after* the transmission mesh — see the long
   * note at the `glass` material — so it takes `renderOrder + 1`. Both write no
   * depth, so nothing else in the frame is disturbed by the extra order.
   *
   * The geometry is shared, not cloned: this costs one draw call and one
   * shader, no vertex memory and no texture memory.
   */
  private addGlazing(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshPhysicalMaterial,
    refl: THREE.MeshPhysicalMaterial | null,
    name: string,
    renderOrder = 0
  ): THREE.Mesh {
    const m = this.addMesh(geometry, material, name, renderOrder);
    if (refl) this.addMesh(geometry, refl, `${name}-refl`, renderOrder + 1);
    return m;
  }

  /** Blank taped-up notice. Paper, not plastic: matt and slightly warm. */
  private signMaterial(color: number): THREE.Material {
    let m = this.signCache.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.94, metalness: 0, side: THREE.DoubleSide });
      this.materials.push(m);
      this.signCache.set(color, m);
    }
    return m;
  }

  /**
   * One decal from an atlas sheet, sized from the cell's real-world aspect so
   * nothing is ever stretched, and placed on a wall or a pane.
   */
  private addSheetDecal(
    sheet: VinylSheet,
    cell: string,
    material: THREE.Material,
    width: number,
    x: number,
    y: number,
    z: number,
    facing: "+x" | "-x" | "+y" | "-y" | "+z" | "-z",
    renderOrder = 4
  ): THREE.Mesh {
    const rect = sheet.cells[cell];
    if (!rect) throw new Error(`addSheetDecal: no cell "${cell}" on this sheet`);
    const q = buildingQuad(width, width / sheet.aspect[cell], facing);
    applySheetCell(q, rect);
    q.translate(x, y, z);
    return this.addMesh(q, material, `decal-${cell}`, renderOrder);
  }

  private addStreak(x: number, yTop: number, z: number, width: number, height: number, facing: "-z" | "+x"): void {
    const g = buildingQuad(width, height, facing);
    g.translate(x, yTop - height / 2, z);
    this.addMesh(g, this.mat.rust, "rust-streak", 2);
  }

  /* ---------------------------------------------------------------- */
  /* exterior shell                                                    */
  /* ---------------------------------------------------------------- */

  private buildShell(F: number): THREE.Group {
    const g = this.geo;
    const uv = this.uv;
    const wallBottom = F - 0.45; // buried skirt, so no daylight under the wall
    const parapetY = F + PLAN.parapet;

    /** A run of CMU, split into the dark painted base band and the field above. */
    const cmuWall = (minX: number, minZ: number, maxX: number, maxZ: number, top: number) => {
      const baseTop = Math.min(top, F + PLAN.baseCourse);
      if (baseTop > wallBottom) this.wbox(g.cmuBase, uv.cmu, minX, wallBottom, minZ, maxX, baseTop, maxZ);
      if (top > baseTop) this.wbox(g.cmuExt, uv.cmu, minX, baseTop, minZ, maxX, top, maxZ);
    };

    // Side walls run the full depth so the corners are solid masonry.
    cmuWall(PLAN.x0, PLAN.z0, PLAN.x0 + PLAN.wall, PLAN.z1, parapetY);
    cmuWall(PLAN.x1 - PLAN.wall, PLAN.z0, PLAN.x1, PLAN.z1, parapetY);
    cmuWall(IN.x0, PLAN.z1 - PLAN.wall, IN.x1, PLAN.z1, parapetY);
    // Front piers either side of the storefront.
    cmuWall(IN.x0, PLAN.z0, PLAN.sfX0, PLAN.z0 + PLAN.wall, parapetY);
    cmuWall(PLAN.sfX1, PLAN.z0, IN.x1, PLAN.z0 + PLAN.wall, parapetY);
    // Curb under the glazing, and the masonry header above the fascia.
    cmuWall(PLAN.sfX0, PLAN.z0, PLAN.doorX0, PLAN.z0 + PLAN.wall, F + PLAN.sillTop);
    cmuWall(PLAN.doorX1, PLAN.z0, PLAN.sfX1, PLAN.z0 + PLAN.wall, F + PLAN.sillTop);
    this.wbox(g.cmuExt, uv.cmu, PLAN.sfX0, F + PLAN.fasciaTop, PLAN.z0, PLAN.sfX1, parapetY, PLAN.z0 + PLAN.wall);

    /* ---- coping cap ---- */
    const o = 0.055; // overhang each side of the 200 mm wall
    const copingT = 0.052;
    const cope = (minX: number, minZ: number, maxX: number, maxZ: number) =>
      this.wbox(g.galv, uv.galv, minX, parapetY, minZ, maxX, parapetY + copingT, maxZ);
    cope(PLAN.x0 - o, PLAN.z0 - o, PLAN.x0 + PLAN.wall + o, PLAN.z1 + o);
    cope(PLAN.x1 - PLAN.wall - o, PLAN.z0 - o, PLAN.x1 + o, PLAN.z1 + o);
    cope(PLAN.x0 - o, PLAN.z0 - o, PLAN.x1 + o, PLAN.z0 + PLAN.wall + o);
    cope(PLAN.x0 - o, PLAN.z1 - PLAN.wall - o, PLAN.x1 + o, PLAN.z1 + o);
    // Drip edge: a 28 mm return under the front lip. This is the detail that
    // makes a coping read as folded sheet rather than as a painted stripe, and
    // it is where the shadow line under the parapet comes from.
    this.wbox(g.galv, uv.galv, PLAN.x0 - o, parapetY - 0.028, PLAN.z0 - o, PLAN.x1 + o, parapetY, PLAN.z0 - o + 0.016);
    this.wbox(g.galv, uv.galv, PLAN.x1 + o - 0.016, parapetY - 0.028, PLAN.z0 - o, PLAN.x1 + o, parapetY, PLAN.z1 + o);

    /* ---- roof deck ---- */
    // Inset inside the parapet. Flush with the wall face would make the deck's
    // side faces coplanar with the outer wall and z-fight along the whole roof
    // line - one of the exact failure modes this project has already hit.
    const di = PLAN.wall * 0.5;
    this.wbox(g.dark, uv.dark, PLAN.x0 + di, F + PLAN.roofDeck - 0.07, PLAN.z0 + di, PLAN.x1 - di, F + PLAN.roofDeck, PLAN.z1 - di);

    /* ---- storefront ---- */
    return this.buildStorefront(F);
  }

  private buildStorefront(F: number): THREE.Group {
    const g = this.geo;
    const uv = this.uv;
    const sfZ = PLAN.z0 + PLAN.sfZ;
    const frameD = 0.058;

    // One bay left of the door, five to the right: 1.4 m modules, which is
    // what an aluminium storefront actually comes in.
    const bays: Array<{ x0: number; x1: number; door: boolean }> = [
      { x0: PLAN.sfX0, x1: PLAN.doorX0, door: false },
      { x0: PLAN.doorX0, x1: PLAN.doorX1, door: true },
    ];
    const n = 5;
    const bw = (PLAN.sfX1 - PLAN.doorX1) / n;
    for (let i = 0; i < n; i++) bays.push({ x0: PLAN.doorX1 + i * bw, x1: PLAN.doorX1 + (i + 1) * bw, door: false });

    const panes: THREE.BufferGeometry[] = [];
    const inner: THREE.BufferGeometry[] = [];
    const grime: THREE.BufferGeometry[] = [];
    /**
     * The glazing is **two single-sided leaves 16 mm apart**, which is both a
     * bug fix and the correct object.
     *
     * The bug: this was one `DoubleSide` pane on a `transmission: 1` material,
     * and in three 0.185.1 `renderTransmissionPass` does this
     * (three.module.js:18054) —
     *
     *     if ( material.side === DoubleSide && ... ) {
     *         material.side = BackSide;
     *         renderObject( object, scene, camera, geometry, material, group );
     *     }
     *
     * — i.e. it draws the pane *into* the transmission render target while the
     * pane's own shader is sampling that same target. Reading an attachment you
     * are writing is undefined, and on ANGLE/D3D11 it returns zero in blocky
     * tiles: the band of hard-edged pure-black rectangles across the lower
     * glazing in the `interior` pose, which a critic correctly ranked as the
     * worst defect in the set. `tools/probe-band.mjs` measured 34.7% of that
     * region at *exactly* rgb(0,0,0) with nothing whatsoever in luma 1..15 —
     * a bimodal split with an empty gap, which no lit object can produce. three
     * knows about the hazard (`// to avoid feedback loops, the transmission
     * render target requires a resolve, see #26177`) and its mitigation is
     * skipped unless `WEBGL_multisampled_render_to_texture` is present, which
     * on this driver it is not.
     *
     * So: no transmissive material in this project may ever be `DoubleSide`.
     * A leaf per viewing direction is the fix, each `FrontSide`, so the
     * back-side pre-pass never runs for either.
     *
     * The object: a shopfront is a sealed double-glazed unit, and 16 mm is a
     * standard cavity. Two leaves at that spacing give the second-surface
     * offset a single plane cannot — a reflection doubled a few pixels apart,
     * and two slightly different grime states, outside weather and inside
     * fingerprints.
     */
    const CAVITY = 0.016;
    const addPane = (x0: number, x1: number, y0: number, y1: number) => {
      const p = buildingQuad(x1 - x0, y1 - y0, "-z");
      p.translate((x0 + x1) / 2, (y0 + y1) / 2, sfZ - 0.004);
      panes.push(p);
      // Inner leaf, facing back into the room. This is the one the `interior`
      // and `cooler` poses see.
      const r = buildingQuad(x1 - x0, y1 - y0, "+z");
      r.translate((x0 + x1) / 2, (y0 + y1) / 2, sfZ - 0.004 + CAVITY);
      inner.push(r);
      const q = buildingQuad(x1 - x0, y1 - y0, "-z");
      q.translate((x0 + x1) / 2, (y0 + y1) / 2, sfZ - 0.011);
      grime.push(q);
    };

    // Continuous sill and head rails.
    this.wbox(g.alu, uv.alu, PLAN.sfX0, F + PLAN.sillTop, sfZ - frameD / 2, PLAN.sfX1, F + PLAN.sillTop + 0.05, sfZ + frameD / 2);
    this.wbox(g.alu, uv.alu, PLAN.sfX0, F + PLAN.glassTop, sfZ - frameD / 2, PLAN.sfX1, F + PLAN.headTop, sfZ + frameD / 2);
    // Fascia band above the glass: a blank painted panel. Whatever was on it
    // has gone; only the bracket stubs and their ghost marks are left.
    this.wbox(g.dark, uv.dark, PLAN.sfX0, F + PLAN.headTop, PLAN.z0, PLAN.sfX1, F + PLAN.fasciaTop, PLAN.z0 + PLAN.wall);
    for (const bx of [-7.2, -4.1, -1.0, 0.7]) {
      this.wbox(g.steel, uv.steel, bx - 0.03, F + PLAN.headTop + 0.16, PLAN.z0 - 0.045, bx + 0.03, F + PLAN.fasciaTop - 0.14, PLAN.z0 - 0.004);
    }

    const mullion = (x: number) =>
      this.wbox(g.alu, uv.alu, x - 0.029, F + PLAN.sillTop, sfZ - frameD / 2, x + 0.029, F + PLAN.headTop, sfZ + frameD / 2);

    for (let i = 0; i < bays.length; i++) {
      const b = bays[i];
      if (i === 0) mullion(b.x0 + 0.029);
      mullion(i === bays.length - 1 ? b.x1 - 0.029 : b.x1);
      if (b.door) continue;
      // Kick panel below the vision glass, with its own head rail.
      this.wbox(g.alu, uv.alu, b.x0 + 0.029, F + PLAN.sillTop, sfZ - 0.02, b.x1 - 0.029, F + PLAN.kickTop, sfZ + 0.02);
      this.wbox(g.alu, uv.alu, b.x0 + 0.029, F + PLAN.kickTop - 0.03, sfZ - frameD / 2, b.x1 - 0.029, F + PLAN.kickTop, sfZ + frameD / 2);
      addPane(b.x0 + 0.029, b.x1 - 0.029, F + PLAN.kickTop, F + PLAN.glassTop);
    }

    /* ---- door frame and transom ---- */
    const jamb = 0.06;
    this.wbox(g.alu, uv.alu, PLAN.doorX0, F, sfZ - frameD / 2, PLAN.doorX0 + jamb, F + PLAN.transomBottom, sfZ + frameD / 2);
    this.wbox(g.alu, uv.alu, PLAN.doorX1 - jamb, F, sfZ - frameD / 2, PLAN.doorX1, F + PLAN.transomBottom, sfZ + frameD / 2);
    this.wbox(g.alu, uv.alu, PLAN.doorX0, F + PLAN.doorHeight, sfZ - frameD / 2, PLAN.doorX1, F + PLAN.transomBottom, sfZ + frameD / 2);
    addPane(PLAN.doorX0 + jamb, PLAN.doorX1 - jamb, F + PLAN.transomBottom, F + PLAN.glassTop);
    this.wbox(g.alu, uv.alu, PLAN.doorX0, F - 0.004, PLAN.z0 + 0.02, PLAN.doorX1, F + 0.012, PLAN.z0 + PLAN.wall - 0.02);

    this.addGlazing(mergeGeometries(panes, false)!, this.mat.glass, this.mat.glassRefl, "storefront-glass", 2);
    panes.forEach((p) => p.dispose());
    this.addGlazing(mergeGeometries(inner, false)!, this.mat.glassInner, this.mat.glassInnerRefl, "storefront-glass-inner", 2);
    inner.forEach((p) => p.dispose());
    // Grime sits on the outside of the outer leaf, so it draws after both.
    this.addMesh(mergeGeometries(grime, false)!, this.mat.grime, "storefront-grime", 4);
    grime.forEach((p) => p.dispose());

    /**
     * Taped notices on the inside of the glass. These used to be flat-coloured
     * quads with no content, on the reasoning that a label you can nearly read
     * is worse than none — but the biggest of them measured 130 x 190 px of
     * blank cream in the `door` capture and was the most conspicuous object in
     * that half of the frame. They now carry printed structure and still no
     * letterforms; see `makeWindowNotices`.
     *
     * Sized from each cell's own aspect rather than from a width and a height
     * chosen here, so a portrait flyer cannot end up square.
     */
    for (const s of [
      { cell: "hiring", x: -4.9, y: 1.55, w: 0.3, r: 0.03 },
      { cell: "card", x: -4.52, y: 1.2, w: 0.22, r: -0.05 },
      { cell: "tabs", x: -7.4, y: 1.62, w: 0.26, r: 0.02 },
      { cell: "community", x: 0.9, y: 1.72, w: 0.24, r: -0.02 },
    ]) {
      const p = buildingQuad(s.w, s.w / this.noticeSheet.aspect[s.cell], "-z");
      applySheetCell(p, this.noticeSheet.cells[s.cell]);
      p.rotateZ(s.r);
      p.translate(s.x, F + s.y, sfZ + 0.012);
      this.addMesh(p, this.mat.notice, "window-notice", 4);
    }

    return this.buildEntryDoor(F, sfZ, jamb);
  }

  private buildEntryDoor(F: number, sfZ: number, jamb: number): THREE.Group {
    const hingeX = PLAN.doorX0 + jamb;
    const leafW = PLAN.doorX1 - jamb - hingeX;
    const leafH = PLAN.doorHeight - 0.02;
    const uvAlu = this.uv.alu;

    const door = new THREE.Group();
    door.name = "building-entry-door";
    door.position.set(hingeX, F, sfZ);

    const stile = 0.055;
    const rail = 0.09;
    const bottomRail = 0.26;
    const parts: THREE.BufferGeometry[] = [];
    const bar = (x0: number, y0: number, x1: number, y1: number) => {
      const b = buildingBox(x1 - x0, y1 - y0, 0.05, {
        uvMetres: uvAlu,
        uvOrigin: V3((x0 + x1) / 2 + hingeX, (y0 + y1) / 2 + F, 0),
      });
      b.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
      parts.push(b);
    };
    bar(0, 0, stile, leafH);
    bar(leafW - stile, 0, leafW, leafH);
    bar(stile, leafH - rail, leafW - stile, leafH);
    bar(stile, 0, leafW - stile, bottomRail);
    const leaf = new THREE.Mesh(mergeLocal(parts), this.mat.alu);
    leaf.name = "entry-door-leaf";
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    door.add(leaf);

    const pane = buildingQuad(leafW - stile * 2, leafH - rail - bottomRail, "-z");
    pane.translate(leafW / 2, (bottomRail + leafH - rail) / 2, -0.004);
    const paneMesh = new THREE.Mesh(pane, this.mat.glass);
    paneMesh.name = "entry-door-glass";
    paneMesh.renderOrder = 2;
    door.add(paneMesh);
    // Reflection leaf, added to the door group rather than the building group
    // so it swings with the leaf. Putting it on `this.group` would leave a
    // reflection hanging in the doorway with the door open — and it would look
    // enough like a pane to survive a glance.
    if (this.mat.glassRefl) {
      const reflMesh = new THREE.Mesh(pane, this.mat.glassRefl);
      reflMesh.name = "entry-door-glass-refl";
      reflMesh.renderOrder = 3;
      door.add(reflMesh);
    }

    // Horizontal push bar inside, vertical pull outside: the two fittings that
    // say "commercial entrance" louder than anything else on the elevation.
    const push = buildingTube(0.019, leafW - 0.14, "x", 10, 0.3);
    push.translate(leafW / 2, 1.06, 0.055);
    const pushMesh = new THREE.Mesh(push, this.mat.alu);
    pushMesh.name = "entry-door-pushbar";
    door.add(pushMesh);
    for (const bx of [0.09, leafW - 0.09]) {
      const brk = buildingBox(0.03, 0.05, 0.075, { uvMetres: uvAlu });
      brk.translate(bx, 1.06, 0.03);
      door.add(new THREE.Mesh(brk, this.mat.alu));
    }
    const pull = buildingTube(0.016, 0.85, "y", 10, 0.3);
    pull.translate(leafW - 0.12, 1.05, -0.062);
    door.add(new THREE.Mesh(pull, this.mat.alu));
    for (const py of [0.66, 1.44]) {
      const brk = buildingBox(0.028, 0.028, 0.06, { uvMetres: uvAlu });
      brk.translate(leafW - 0.12, py, -0.032);
      door.add(new THREE.Mesh(brk, this.mat.alu));
    }
    for (const s of [
      { x: 0.3, y: 1.55, w: 0.21, h: 0.29, r: 0.04, c: 0xd9d4c4 },
      { x: 0.63, y: 1.36, w: 0.15, h: 0.2, r: -0.07, c: 0xcac2ae },
    ]) {
      const p = buildingQuad(s.w, s.h, "-z");
      p.rotateZ(s.r);
      p.translate(s.x, s.y, -0.009);
      door.add(new THREE.Mesh(p, this.signMaterial(s.c)));
    }

    door.userData = {
      kind: "hinge",
      axis: "y",
      closedAngle: 0,
      /** Positive rotation about Y swings the leaf out over the stoop. */
      openAngle: 1.62,
      swing: "outward",
      leafWidth: leafW,
      leafHeight: leafH,
    };
    this.group.add(door);
    return door;
  }

  /** Rooftop unit, its curb, the flue and the conduit that feeds it. */
  private buildRoofKit(F: number): void {
    const g = this.geo;
    const uv = this.uv;
    const deck = F + PLAN.roofDeck;
    const parapetTop = F + PLAN.parapet + 0.052;
    const cx = -1.6;
    const cz = 35.6;
    const w = 1.72;
    const d = 1.24;

    this.wbox(g.dark, uv.dark, cx - w / 2 - 0.06, deck, cz - d / 2 - 0.06, cx + w / 2 + 0.06, deck + 0.24, cz + d / 2 + 0.06);
    this.wbox(g.galv, uv.galv, cx - w / 2, deck + 0.22, cz - d / 2, cx + w / 2, deck + 1.02, cz + d / 2);
    this.wbox(g.galv, uv.galv, cx - w / 2 + 0.04, deck + 1.0, cz - d / 2 + 0.04, cx + w / 2 - 0.04, deck + 1.08, cz + d / 2 - 0.04);
    this.wbox(g.galv, uv.galv, cx + 0.1, deck + 1.06, cz - 0.42, cx + 0.78, deck + 1.2, cz + 0.42);

    const ring = buildingTube(0.34, 0.05, "y", 20, 0.4);
    ring.translate(cx + 0.44, deck + 1.22, cz);
    g.steel.push(ring);
    for (let i = 0; i < 6; i++) {
      const guard = buildingBox(0.66, 0.012, 0.012, { uvMetres: uv.steel });
      guard.rotateY((i / 6) * Math.PI);
      guard.translate(cx + 0.44, deck + 1.23, cz);
      g.steel.push(guard);
    }
    // Louvred condenser coil on the west face.
    for (let i = 0; i < 9; i++) {
      const y = deck + 0.32 + i * 0.072;
      this.wbox(g.dark, uv.dark, cx - w / 2 - 0.012, y, cz - d / 2 + 0.08, cx - w / 2 + 0.005, y + 0.05, cz + d / 2 - 0.08);
    }
    const flue = buildingTube(0.075, 0.55, "y", 12, 0.3);
    flue.translate(cx - 0.6, deck + 1.3, cz + 0.34);
    g.galv.push(flue);
    const cap = buildingTube(0.115, 0.06, "y", 12, 0.3);
    cap.translate(cx - 0.6, deck + 1.58, cz + 0.34);
    g.galv.push(cap);
    this.wbox(g.dark, uv.dark, cx + w / 2, deck + 0.5, cz - 0.12, cx + w / 2 + 0.09, deck + 0.78, cz + 0.16);

    // Toilet vent and a gooseneck exhaust, set close behind the front parapet.
    // The RTU itself sits far enough back that a standing eye never clears the
    // coping - which is true of the real thing, but leaves a dead-flat roof
    // line, and the vents are what actually break it on every real station.
    const ventX = 1.05;
    const ventZ = PLAN.z0 + 1.15;
    const vent = buildingTube(0.045, 1.5, "y", 10, 0.3);
    vent.translate(ventX, deck + 0.75, ventZ);
    g.steel.push(vent);
    const ventCap = buildingTube(0.062, 0.05, "y", 10, 0.3);
    ventCap.translate(ventX, deck + 1.52, ventZ);
    g.steel.push(ventCap);

    const gx = -0.35;
    const gz = PLAN.z0 + 1.0;
    this.wbox(g.galv, uv.galv, gx - 0.26, deck, gz - 0.26, gx + 0.26, deck + 0.18, gz + 0.26);
    const riser = buildingTube(0.14, 1.0, "y", 12, 0.35);
    riser.translate(gx, deck + 0.66, gz);
    g.galv.push(riser);
    // The hood: a box turned down toward the deck, which is the silhouette
    // that reads as a gooseneck rather than as another pipe.
    this.wbox(g.galv, uv.galv, gx - 0.19, deck + 1.12, gz - 0.19, gx + 0.19, deck + 1.34, gz + 0.42);
    this.wbox(g.galv, uv.galv, gx - 0.19, deck + 0.86, gz + 0.24, gx + 0.19, deck + 1.16, gz + 0.42);

    /* ---- things that actually break the parapet line ---- */
    // The geometric constraint, worked out rather than guessed: from the front
    // camera the sight line clears the coping at about 0.32 m of rise per metre
    // of depth, and the deck sits 0.75 m below the coping. So anything standing
    // `d` metres behind the parapet needs 0.75 + 0.32 d above the deck before a
    // standing eye sees any of it. The RTU is 4.1 m back and 1.08 m tall, which
    // needs 2.08 m - it is invisible from the forecourt and always will be.
    // That is true of the real thing too, and it is why a flat-roofed store has
    // such a dead skyline. What breaks it in life is the small tall stuff:
    // plumbing stacks, a mast, a dish, and the ladder rails over the coping.

    // Sanitary vent cluster, close behind the front parapet where it shows.
    for (const [vx, vz, vh, vr] of [
      [-7.35, PLAN.z0 + 0.62, 1.42, 0.05],
      [-7.02, PLAN.z0 + 0.95, 1.02, 0.038],
      [-6.72, PLAN.z0 + 0.7, 1.68, 0.042],
    ] as const) {
      const stack = buildingTube(vr, vh, "y", 10, 0.3);
      stack.translate(vx, deck + vh / 2, vz);
      g.steel.push(stack);
      // Lead flashing collar where it passes the deck: the detail that stops a
      // pipe reading as a cylinder dropped through a plane.
      const collar = buildingTube(vr * 2.1, 0.09, "y", 10, 0.3);
      collar.translate(vx, deck + 0.045, vz);
      g.galv.push(collar);
    }

    // Antenna mast on a ballasted foot, guyed to two deck anchors.
    const mx = -4.15;
    const mz = PLAN.z0 + 0.78;
    this.wbox(g.dark, uv.dark, mx - 0.21, deck, mz - 0.21, mx + 0.21, deck + 0.1, mz + 0.21);
    const mast = buildingTube(0.024, 2.35, "y", 8, 0.4);
    mast.translate(mx, deck + 1.28, mz);
    g.galv.push(mast);
    for (let i = 0; i < 3; i++) {
      const arm = buildingBox(0.44, 0.012, 0.012, { uvMetres: uv.steel });
      arm.translate(mx, deck + 1.85 + i * 0.17, mz);
      g.steel.push(arm);
    }

    // Dish on a short pole against the front parapet, tilted to the satellite.
    const dx = 2.05;
    const dz = PLAN.z0 + 0.5;
    const pole = buildingTube(0.026, 1.15, "y", 8, 0.4);
    pole.translate(dx, deck + 0.58, dz);
    g.galv.push(pole);
    const dish = buildingTube(0.29, 0.05, "z", 16, 0.45);
    dish.rotateX(-0.42);
    dish.translate(dx, deck + 1.06, dz - 0.14);
    g.enamel.push(dish);
    const feed = buildingTube(0.018, 0.34, "z", 6, 0.3);
    feed.rotateX(-0.42);
    feed.translate(dx, deck + 0.94, dz - 0.3);
    g.steel.push(feed);

    // Roof access ladder on the east elevation. The rails run 1.07 m past the
    // coping, which is both the code requirement and, from the corner pose, the
    // only vertical anything on that entire elevation.
    const lx = PLAN.x1 + 0.075;
    const lz0 = 32.42;
    const lz1 = 32.88;
    const railTop = F + PLAN.parapet + 1.07;
    for (const lz of [lz0, lz1]) {
      const rail = buildingTube(0.021, railTop - (F + 0.85), "y", 8, 0.4);
      rail.translate(lx, (F + 0.85 + railTop) / 2, lz);
      g.steel.push(rail);
    }
    for (let y = F + 1.0; y < railTop - 1.2; y += 0.305) {
      const rung = buildingTube(0.0125, lz1 - lz0, "z", 6, 0.3);
      rung.translate(lx, y, (lz0 + lz1) / 2);
      g.steel.push(rung);
    }
    // Wall standoffs, which is where the shadow on the block comes from.
    for (const y of [F + 1.3, F + 2.7, F + 4.0]) {
      this.wbox(g.steel, uv.steel, PLAN.x1, y - 0.014, lz0 - 0.02, lx, y + 0.014, lz1 + 0.02);
    }
    // The rails bend over the coping at the top.
    for (const lz of [lz0, lz1]) {
      const bend = buildingTube(0.021, 0.34, "x", 8, 0.4);
      bend.translate(PLAN.x1 - 0.09, railTop, lz);
      g.steel.push(bend);
    }

    // Coping splice plates. Sheet metal coping comes in 10 ft lengths, so a
    // real parapet has a joint every 3.05 m; without them the coping is one
    // impossibly long extrusion and the eye reads the whole roof line as CG.
    const spliceT = 0.0035;
    for (let x = PLAN.x0 + 1.4; x < PLAN.x1; x += 3.05) {
      this.wbox(
        g.galv,
        uv.galv,
        x - 0.05,
        parapetTop - spliceT,
        PLAN.z0 - 0.06,
        x + 0.05,
        parapetTop + spliceT * 2,
        PLAN.z0 + PLAN.wall + 0.06
      );
    }
    for (let z = PLAN.z0 + 2.2; z < PLAN.z1; z += 3.05) {
      this.wbox(
        g.galv,
        uv.galv,
        PLAN.x1 - PLAN.wall - 0.06,
        parapetTop - spliceT,
        z - 0.05,
        PLAN.x1 + 0.06,
        parapetTop + spliceT * 2,
        z + 0.05
      );
    }

    // Conduit from the unit toward the east parapet, on strut supports.
    const runY = deck + 0.12;
    const runX0 = cx + w / 2;
    const runX1 = PLAN.x1 - 0.35;
    const conduit = buildingTube(0.022, runX1 - runX0, "x", 8, 0.4);
    conduit.translate((runX0 + runX1) / 2, runY, cz + 0.5);
    g.galv.push(conduit);
    for (let x = runX0 + 0.4; x < runX1 - 0.1; x += 1.1) {
      this.wbox(g.steel, uv.steel, x - 0.04, deck, cz + 0.46, x + 0.04, runY, cz + 0.54);
    }
  }

  private buildDrainage(F: number): void {
    const g = this.geo;
    const uv = this.uv;
    const deck = F + PLAN.roofDeck;
    const parapetY = F + PLAN.parapet;
    const spoutX = 2.75;

    // Primary scupper through the front parapet, into a conductor head and a
    // downspout that has been reversed into at least once.
    this.wbox(g.galv, uv.galv, spoutX - 0.16, deck, PLAN.z0 - 0.07, spoutX + 0.16, deck + 0.13, PLAN.z0 + 0.02);
    this.wbox(g.galv, uv.galv, spoutX - 0.19, deck - 0.36, PLAN.z0 - 0.19, spoutX + 0.19, deck - 0.02, PLAN.z0);
    for (let i = 0; i < 6; i++) {
      const yTop = deck - 0.36 - i * 0.52;
      const yBot = Math.max(yTop - 0.52, F + 0.22);
      if (yBot >= yTop) break;
      const dent = i === 3 ? 0.013 : i === 4 ? 0.007 : 0;
      this.wbox(g.steel, uv.steel, spoutX - 0.05 + dent, yBot, PLAN.z0 - 0.1 + dent, spoutX + 0.05 - dent, yTop, PLAN.z0 - 0.006);
      if (i % 2 === 1) this.wbox(g.steel, uv.steel, spoutX - 0.08, yBot + 0.02, PLAN.z0 - 0.11, spoutX + 0.08, yBot + 0.06, PLAN.z0);
    }
    this.wbox(g.steel, uv.steel, spoutX - 0.05, F + 0.1, PLAN.z0 - 0.34, spoutX + 0.05, F + 0.22, PLAN.z0 - 0.006);
    const splash = gridSurface(spoutX - 0.24, spoutX + 0.24, PLAN.z0 - 0.98, PLAN.z0 - 0.3, 4, 6, (x, z) => padY(x, z) + 0.05, 4);
    this.addMesh(splash, this.mat.concrete, "splash-block").receiveShadow = true;

    // Overflow scupper on the west pier. It has no downspout, which is exactly
    // why the wall below it is stained: this streak is the single strongest
    // realism cue on an otherwise plain painted elevation.
    const ovX = -8.62;
    this.wbox(g.galv, uv.galv, ovX - 0.14, deck + 0.1, PLAN.z0 - 0.06, ovX + 0.14, deck + 0.21, PLAN.z0 + 0.02);
    this.addStreak(ovX, deck + 0.12, PLAN.z0 - 0.014, 0.62, 2.5, "-z");
    // An older, drier one on the east elevation. A stain needs a *source* or it
    // reads as a decal floating on the wall, so put a coping splice plate right
    // above it - failed sealant at a splice is exactly what causes this.
    const spliceZ = 34.4;
    this.wbox(g.galv, uv.galv, PLAN.x1 - PLAN.wall - 0.04, parapetY - 0.004, spliceZ - 0.09, PLAN.x1 + 0.04, parapetY + 0.008, spliceZ + 0.09);
    this.addStreak(PLAN.x1 + 0.014, parapetY - 0.05, spliceZ, 0.62, 2.3, "+x");
  }

  private buildExteriorFittings(F: number): void {
    const g = this.geo;
    const uv = this.uv;

    /* ---- wall pack over the door ---- */
    const wpX = (PLAN.doorX0 + PLAN.doorX1) / 2;
    const wpY = F + 2.95;
    this.wbox(g.dark, uv.dark, wpX - 0.19, wpY, PLAN.z0 - 0.06, wpX + 0.19, wpY + 0.2, PLAN.z0 + 0.01);
    this.wbox(g.dark, uv.dark, wpX - 0.24, wpY - 0.14, PLAN.z0 - 0.3, wpX + 0.24, wpY + 0.02, PLAN.z0 - 0.04);
    // TODO(System 4 - lighting): put the real emitter inside this housing and
    // drop the emissive stub on the lens.
    const lens = buildingQuad(0.4, 0.22, "-y");
    lens.translate(wpX, wpY - 0.145, PLAN.z0 - 0.17);
    this.addMesh(lens, this.mat.diffuser, "building-exterior-light-lens");
    const anchor = new THREE.Object3D();
    anchor.name = "building-exterior-light";
    anchor.position.set(wpX, wpY - 0.15, PLAN.z0 - 0.17);
    anchor.userData = { kind: "wall-pack", width: 0.4, length: 0.22, aim: "down" };
    this.group.add(anchor);
    this.exteriorLight = anchor;

    // Conduit from the wall pack up to a junction box on the header.
    const riserTop = F + PLAN.fasciaTop + 0.75;
    const riser = buildingTube(0.019, riserTop - (wpY + 0.2), "y", 8, 0.4);
    riser.translate(wpX + 0.26, (wpY + 0.2 + riserTop) / 2, PLAN.z0 - 0.03);
    g.galv.push(riser);
    for (const y of [wpY + 0.55, wpY + 1.05]) {
      this.wbox(g.steel, uv.steel, wpX + 0.22, y, PLAN.z0 - 0.045, wpX + 0.3, y + 0.025, PLAN.z0 + 0.005);
    }
    this.wbox(g.dark, uv.dark, wpX + 0.18, riserTop - 0.02, PLAN.z0 - 0.07, wpX + 0.34, riserTop + 0.16, PLAN.z0 + 0.005);
    const run = buildingTube(0.019, 3.2, "x", 8, 0.4);
    run.translate(wpX + 1.9, riserTop + 0.07, PLAN.z0 - 0.03);
    g.galv.push(run);

    /* ---- ice machine ---- */
    const ix0 = 1.75;
    const ix1 = 2.95;
    const iz0 = PLAN.z0 - 0.86;
    const iy = F - 0.14;
    this.wbox(g.enamel, uv.galv, ix0, iy + 0.06, iz0, ix1, iy + 1.86, PLAN.z0 - 0.01);
    this.wbox(g.dark, uv.dark, ix0 + 0.02, iy, iz0 + 0.02, ix1 - 0.02, iy + 0.08, PLAN.z0 - 0.03);
    for (const [dy0, dy1] of [
      [0.5, 1.14],
      [1.16, 1.78],
    ]) {
      this.wbox(g.enamel, uv.galv, ix0 + 0.05, iy + dy0, iz0 - 0.03, ix1 - 0.05, iy + dy1, iz0 + 0.01);
      const my = iy + (dy0 + dy1) / 2;
      this.wbox(g.dark, uv.dark, ix0 + 0.42, my - 0.03, iz0 - 0.05, ix0 + 0.78, my + 0.03, iz0 - 0.02);
    }
    for (let i = 0; i < 5; i++) {
      const y = iy + 0.16 + i * 0.055;
      this.wbox(g.dark, uv.dark, ix0 + 0.14, y, iz0 - 0.02, ix1 - 0.14, y + 0.032, iz0 + 0.01);
    }
    for (const bx of [1.6, 3.1]) {
      const b = buildingTube(0.058, 1.0, "y", 12, 0.5);
      b.translate(bx, padY(bx, PLAN.z0 - 0.55) + 0.42, PLAN.z0 - 0.55);
      this.addMesh(b, this.mat.bollard, "bollard").castShadow = true;
    }

    /* ---- propane exchange cage ---- */
    const cx0 = -9.78;
    const cx1 = -8.62;
    const cz0 = PLAN.z0 - 0.94;
    const cz1 = PLAN.z0 + 0.02;
    const cy = padY((cx0 + cx1) / 2, (cz0 + cz1) / 2);
    const ch = 1.52;
    for (const [ax, az] of [
      [cx0, cz0],
      [cx1, cz0],
      [cx0, cz1],
      [cx1, cz1],
    ]) {
      this.wbox(g.steel, uv.steel, ax - 0.022, cy, az - 0.022, ax + 0.022, cy + ch, az + 0.022);
    }
    for (const y of [cy + 0.03, cy + ch - 0.03, cy + ch * 0.55]) {
      this.wbox(g.steel, uv.steel, cx0, y - 0.018, cz0, cx1, y + 0.018, cz0 + 0.03);
      this.wbox(g.steel, uv.steel, cx0, y - 0.018, cz1 - 0.03, cx1, y + 0.018, cz1);
      this.wbox(g.steel, uv.steel, cx0, y - 0.018, cz0, cx0 + 0.03, y + 0.018, cz1);
      this.wbox(g.steel, uv.steel, cx1 - 0.03, y - 0.018, cz0, cx1, y + 0.018, cz1);
    }
    // Mesh as vertical wires only: reads correctly at this size on screen and
    // costs a tenth of a real welded grid.
    for (let i = 1; i < 11; i++) {
      const x = cx0 + ((cx1 - cx0) * i) / 11;
      const wire = buildingTube(0.005, ch, "y", 5, 0.4);
      wire.translate(x, cy + ch / 2, cz0 + 0.014);
      g.steel.push(wire);
    }
    for (const [sy, count] of [
      [0.06, 4],
      [0.78, 3],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const x = cx0 + 0.22 + i * 0.24;
        const body = buildingTube(0.098, 0.46, "y", 12, 0.4);
        body.translate(x, cy + sy + 0.23, (cz0 + cz1) / 2);
        g.enamel.push(body);
        const collar = buildingTube(0.06, 0.09, "y", 10, 0.4);
        collar.translate(x, cy + sy + 0.5, (cz0 + cz1) / 2);
        g.steel.push(collar);
      }
    }

    /* ---- east elevation service kit ---- */
    const ex = PLAN.x1;
    const bib = buildingTube(0.014, 0.16, "x", 8, 0.3);
    bib.translate(ex + 0.09, F + 0.42, 33.4);
    g.steel.push(bib);
    this.wbox(g.steel, uv.steel, ex, F + 0.38, 33.36, ex + 0.045, F + 0.46, 33.44);
    const tap = buildingTube(0.036, 0.014, "y", 10, 0.3);
    tap.translate(ex + 0.17, F + 0.42, 33.4);
    g.steel.push(tap);

    this.wbox(g.galv, uv.galv, ex, F + 1.15, 34.9, ex + 0.13, F + 1.62, 35.34);
    this.wbox(g.dark, uv.dark, ex, F + 0.72, 35.0, ex + 0.09, F + 1.1, 35.24);
    const drop = buildingTube(0.021, 1.5, "y", 8, 0.4);
    drop.translate(ex + 0.06, F + 2.3, 35.12);
    g.galv.push(drop);

    // Second downspout, on the back corner of this elevation.
    for (let i = 0; i < 6; i++) {
      const yTop = F + PLAN.roofDeck - 0.2 - i * 0.55;
      const yBot = Math.max(yTop - 0.55, F + 0.2);
      if (yBot >= yTop) break;
      this.wbox(g.steel, uv.steel, ex + 0.006, yBot, 38.9, ex + 0.1, yTop, 39.0);
    }
    this.wbox(g.galv, uv.galv, ex + 0.006, F + PLAN.roofDeck - 0.2, 38.82, ex + 0.19, F + PLAN.roofDeck + 0.12, 39.08);

    /* ---- ground level scuffs ---- */
    for (const s of [
      { x: -8.45, y: 0.3, z: PLAN.z0 - 0.012, w: 1.0, h: 0.85, f: "-z" as const },
      { x: -4.7, y: 0.22, z: PLAN.z0 - 0.012, w: 0.8, h: 0.6, f: "-z" as const },
      { x: 1.3, y: 0.36, z: PLAN.z0 - 0.012, w: 1.3, h: 1.0, f: "-z" as const },
      { x: PLAN.x1 + 0.012, y: 0.32, z: 33.2, w: 1.4, h: 0.9, f: "+x" as const },
      { x: PLAN.x1 + 0.012, y: 0.24, z: 37.4, w: 1.1, h: 0.7, f: "+x" as const },
    ]) {
      const quad = buildingQuad(s.w, s.h, s.f);
      quad.translate(s.x, F - 0.14 + s.y, s.z);
      this.addMesh(quad, this.mat.scuff, "wall-scuff", 2);
    }
  }

  /**
   * Everything with words on it. Kept in one place so the answer to "is there
   * any typography on this building" is a single method rather than a search.
   *
   * Placement is chosen against the six capture poses, not against a plan view:
   * a sign nobody's camera can see is the vegetation system's off-camera
   * treeline all over again. The fascia box reads in `front` and `corner`, the
   * window vinyl in `front` and `door`, the plates and the valance in
   * `interior`, `door` and `cooler`.
   */
  private buildSignage(F: number): void {
    const g = this.geo;
    const uv = this.uv;
    const sfZ = PLAN.z0 + PLAN.sfZ;
    const sign = FASCIA_SIGN;

    /* ---- illuminated fascia box, on the existing bracket stubs ---- */
    const sx = (PLAN.sfX0 + PLAN.sfX1) / 2;
    const sy = F + (PLAN.headTop + PLAN.fasciaTop) / 2;
    // The can: a shallow extrusion whose back lands exactly on the front of the
    // brackets at z0 - 0.045, so the sign is visibly hung off the wall and
    // throws a shadow line onto the fascia band behind it.
    const zFace = PLAN.z0 - 0.045 - sign.depth;
    this.wbox(
      g.dark,
      uv.dark,
      sx - sign.width / 2 - 0.03,
      sy - sign.height / 2 - 0.03,
      zFace,
      sx + sign.width / 2 + 0.03,
      sy + sign.height / 2 + 0.03,
      PLAN.z0 - 0.045
    );
    const face = buildingQuad(sign.width, sign.height, "-z");
    face.translate(sx, sy, zFace - 0.004);
    this.addMesh(face, this.mat.signFascia, "fascia-sign", 1).castShadow = true;

    /* ---- window vinyl, on the outside of the glass ---- */
    const vz = sfZ - 0.022;
    for (const d of [
      { cell: "hours", x: -4.35, y: 1.72, w: 0.46 },
      { cell: "open", x: -3.0, y: 1.94, w: 0.78 },
      { cell: "payment", x: 0.62, y: 1.62, w: 0.44 },
      { cell: "notice", x: -7.75, y: 1.28, w: 0.34 },
    ]) {
      this.addSheetDecal(this.vinylSheet, d.cell, this.mat.vinyl, d.w, d.x, F + d.y, vz, "-z");
    }
    // On the door leaf's own glass, the roundel and a small hours repeat: the
    // two decals that are on every commercial entrance ever built.
    this.addSheetDecal(this.plateSheet, "nosmoking", this.mat.plate, 0.2, -6.95, F + 1.62, vz, "-z");

    /* ---- interior plates ---- */
    // Hung from the ceiling short of the door, facing back into the room, which
    // is the only place a shopper standing at the till can read it - and the
    // pose that matters here looks along exactly that line.
    const exitY = F + PLAN.ceiling - 0.24;
    this.wbox(g.steelInt, uv.steel, -6.02, exitY + 0.11, 32.28, -5.98, F + PLAN.ceiling, 32.32);
    this.addSheetDecal(this.plateSheet, "exit", this.mat.plate, 0.34, -6.0, exitY, 32.3, "+z");
    this.addSheetDecal(this.plateSheet, "restroom", this.mat.plate, 0.4, IN.x0 + 0.02, F + 2.05, 38.6, "+x");
    this.addSheetDecal(this.plateSheet, "employees", this.mat.plate, 0.3, IN.x0 + 0.02, F + 1.6, 39.2, "+x");

    /* ---- cooler valance graphic ---- */
    const zFront = IN.z1 - COOLER.depth;
    const vy = F + COOLER.height;
    const strip = buildingQuad(COOLER.x1 - COOLER.x0 + 0.04, 0.14, "-z");
    strip.translate((COOLER.x0 + COOLER.x1) / 2, vy + 0.085, zFront - 0.035);
    this.addMesh(strip, this.mat.signValance, "cooler-valance-sign", 1);
  }

  private buildStoop(F: number): void {
    const sx0 = PLAN.doorX0 - 0.95;
    const sx1 = PLAN.doorX1 + 0.95;
    const sz0 = PLAN.z0 - 1.9;
    const cxm = (sx0 + sx1) / 2;
    const stoop = gridSurface(sx0, sx1, sz0, PLAN.z0, 26, 18, (x, z) => {
      const t = THREE.MathUtils.clamp((z - sz0) / (PLAN.z0 - sz0), 0, 1);
      const s = t * t * (3 - 2 * t);
      // Ramps from the lot up to 20 mm below the threshold, with the outer
      // 200 mm of each side falling away so it does not read as a plinth.
      const edge = THREE.MathUtils.clamp((Math.abs(x - cxm) - 1.35) / 0.45, 0, 1);
      return THREE.MathUtils.lerp(padY(x, sz0) + 0.02, F - 0.02, s) - edge * 0.035;
    }, 4);
    const mesh = this.addMesh(stoop, this.mat.concrete, "entry-stoop");
    mesh.receiveShadow = true;
  }

  /* ---------------------------------------------------------------- */
  /* interior                                                          */
  /* ---------------------------------------------------------------- */

  private buildInteriorShell(F: number): void {
    const g = this.geo;
    const uv = this.uv;

    // Slab. Runs under the storefront so there is no gap at the sill.
    this.wbox(g.cmuInt, uv.cmu, IN.x0, F - 0.24, PLAN.z0, IN.x1, F - 0.002, IN.z1);

    const floor = buildingQuad(IN.x1 - IN.x0, IN.z1 - PLAN.z0, "+y");
    {
      const attr = floor.getAttribute("uv") as THREE.BufferAttribute;
      const w = IN.x1 - IN.x0;
      const d = IN.z1 - PLAN.z0;
      // World-metre UVs, so the 12 in tile grid is really 12 inches and lines
      // up with the door instead of floating at an arbitrary phase.
      for (let i = 0; i < attr.count; i++) {
        attr.setXY(i, (IN.x0 + attr.getX(i) * w) / uv.vct.x, (PLAN.z0 + attr.getY(i) * d) / uv.vct.y);
      }
      attr.needsUpdate = true;
    }
    floor.translate((IN.x0 + IN.x1) / 2, F, (PLAN.z0 + IN.z1) / 2);
    this.addMesh(floor, this.mat.vct, "store-floor").receiveShadow = true;

    // Painted liner 15 mm proud of the block on every inside face. Separate
    // geometry rather than a second material on the wall boxes, because the
    // outside and the inside of this building are painted different colours
    // and weather completely differently.
    const L = 0.015;
    const top = F + PLAN.ceiling + 0.5;
    this.wbox(g.cmuInt, uv.cmu, IN.x0, F, IN.z1 - L, IN.x1, top, IN.z1);
    this.wbox(g.cmuInt, uv.cmu, IN.x0, F, PLAN.z0, IN.x0 + L, top, IN.z1);
    this.wbox(g.cmuInt, uv.cmu, IN.x1 - L, F, PLAN.z0, IN.x1, top, IN.z1);
    this.wbox(g.cmuInt, uv.cmu, IN.x0, F, IN.z0 - L, PLAN.sfX0, top, IN.z0);
    this.wbox(g.cmuInt, uv.cmu, PLAN.sfX1, F, IN.z0 - L, IN.x1, top, IN.z0);
    // Bulkhead over the storefront head, so the plenum is closed at the front.
    this.wbox(g.cmuInt, uv.cmu, PLAN.sfX0, F + PLAN.headTop, IN.z0 - L, PLAN.sfX1, top, IN.z0);
  }

  private buildCeiling(F: number): void {
    const y = F + PLAN.ceiling;
    const TILE_W = 0.6096; // 2 ft
    const TILE_L = 1.2192; // 4 ft
    const x0 = IN.x0;
    const x1 = IN.x1;
    const z0 = PLAN.z0 + 0.02;
    const z1 = IN.z1;
    const nx = Math.ceil((x1 - x0) / TILE_W);
    const nz = Math.ceil((z1 - z0) / TILE_L);

    // Grid tees: 24 mm exposed flange, 38 mm web. Modelled rather than painted
    // in, because at 2.78 m the grid sits in the top of frame and its shadow
    // line is most of what makes a suspended ceiling read as suspended.
    const tees: THREE.BufferGeometry[] = [];
    const tee = (ax0: number, az0: number, ax1: number, az1: number) =>
      tees.push(buildingWorldBox(V3(ax0, y, az0), V3(ax1, y + 0.038, az1), { uvMetres: this.uv.galv }));
    for (let i = 0; i <= nx; i++) {
      const x = Math.min(x0 + i * TILE_W, x1);
      tee(x - 0.012, z0, x + 0.012, z1);
    }
    for (let j = 0; j <= nz; j++) {
      const z = Math.min(z0 + j * TILE_L, z1);
      tee(x0, z - 0.012, x1, z + 0.012);
    }
    // White painted steel, not dark. A dark grid turns the ceiling into a
    // graphic checkerboard; the real thing is barely lighter than the tile and
    // only separates from it through the shadow under each flange.
    this.addMesh(mergeGeometries(tees, false)!, this.mat.enamelInt, "ceiling-grid").receiveShadow = true;
    tees.forEach((t) => t.dispose());

    const fixtureCells: Array<[number, number]> = [
      [2, 0],
      [Math.max(3, nx - 5), 0],
      [4, 2],
      [Math.max(3, nx - 6), 2],
      [Math.floor(nx / 2) - 3, 4],
      [Math.max(3, nx - 4), 4],
    ];
    const isFixture = (i: number, j: number) => fixtureCells.some(([a, b]) => a === i && b === j);

    const tiles: THREE.BufferGeometry[] = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const ax0 = x0 + i * TILE_W + 0.012;
        const ax1 = Math.min(x0 + (i + 1) * TILE_W - 0.012, x1);
        const az0 = z0 + j * TILE_L + 0.012;
        const az1 = Math.min(z0 + (j + 1) * TILE_L - 0.012, z1);
        if (ax1 - ax0 < 0.05 || az1 - az0 < 0.05) continue;

        if (isFixture(i, j)) {
          this.addTroffer(ax0, ax1, az0, az1, y);
          continue;
        }

        const t = buildingQuad(ax1 - ax0, az1 - az0, "-y");
        const attr = t.getAttribute("uv") as THREE.BufferAttribute;
        for (let k = 0; k < attr.count; k++) {
          attr.setXY(k, (ax0 + attr.getX(k) * (ax1 - ax0)) / 0.6096, (az0 + attr.getY(k) * (az1 - az0)) / 0.6096);
        }
        attr.needsUpdate = true;
        t.translate((ax0 + ax1) / 2, y + 0.008, (az0 + az1) / 2);
        tiles.push(t);
      }
    }
    this.addMesh(mergeGeometries(tiles, false)!, this.mat.ceilTile, "ceiling-tiles").receiveShadow = true;
    tiles.forEach((t) => t.dispose());
  }

  /** A 2 x 4 ft lay-in troffer: open-bottom steel pan plus a prismatic lens. */
  private addTroffer(ax0: number, ax1: number, az0: number, az1: number, y: number): void {
    const cx = (ax0 + ax1) / 2;
    const cz = (az0 + az1) / 2;
    const hw = ax1 - ax0;
    const hl = az1 - az0;
    const pan: THREE.BufferGeometry[] = [];
    const piece = (sx: number, sy: number, sz: number, px: number, py: number, pz: number) => {
      const b = buildingBox(sx, sy, sz, { uvMetres: this.uv.galv, uvOrigin: V3(px, py, pz) });
      b.translate(px, py, pz);
      pan.push(b);
    };
    piece(hw, 0.012, hl, cx, y + 0.135, cz);
    piece(0.012, 0.13, hl, ax0, y + 0.07, cz);
    piece(0.012, 0.13, hl, ax1, y + 0.07, cz);
    piece(hw, 0.13, 0.012, cx, y + 0.07, az0);
    piece(hw, 0.13, 0.012, cx, y + 0.07, az1);
    this.addMesh(mergeLocal(pan), this.mat.enamelInt, "troffer-housing");

    const lens = buildingQuad(hw - 0.02, hl - 0.02, "-y");
    lens.translate(cx, y + 0.026, cz);
    this.addMesh(lens, this.mat.trofferLens, "troffer-diffuser");

    const anchor = new THREE.Object3D();
    anchor.name = `building-fluorescent-${this.fluorescents.length}`;
    anchor.position.set(cx, y + 0.02, cz);
    anchor.userData = { kind: "lay-in-troffer", width: hw, length: hl, lamps: 2, aim: "down" };
    this.group.add(anchor);
    this.fluorescents.push(anchor);
  }

  private buildCooler(F: number, rng: Rng): void {
    const g = this.geo;
    const uv = this.uv;
    const zBack = IN.z1;
    const zFront = zBack - COOLER.depth;
    const y0 = F;
    const y1 = F + COOLER.height;

    /* ---- cabinet ---- */
    this.wbox(g.enamelInt, uv.galv, COOLER.x0, y0, zFront, COOLER.x1, y0 + COOLER.kick, zBack);
    /**
     * The two end returns.
     *
     * These were single 60 mm slabs, and the `cooler` pose sees the near one
     * square on at 1.16 x 2.03 m — about 380 x 520 px of one flat value, the
     * largest untextured object left in the set after the gondola ends were
     * rebuilt.
     *
     * The fix has to work under a room with no bounce in it, which rules out
     * anything that relies on ambient occlusion or on two parallel surfaces
     * reading differently (NOTES.md case 9). So the relief is a recessed
     * centre panel inside a proud perimeter frame: the recess has four
     * **returns**, and the one along the top faces upward straight into the
     * troffers. That single horizontal highlight is what breaks the slab, and
     * it exists because of the direction the face points, not because of any
     * shading trick. A cased return panel is also simply what a reach-in
     * cabinet has.
     */
    const endReturn = (outer: number, dir: 1 | -1) => {
      const inner = outer - dir * 0.06;
      const face = outer - dir * 0.028;
      const lo = Math.min(inner, face);
      const hi = Math.max(inner, face);
      // Recessed centre, full height and depth: the cabinet stays sealed.
      this.wbox(g.enamelInt, uv.galv, lo, y0, zFront, hi, y1, zBack);
      const rail = 0.085;
      const frame: Array<[number, number, number, number]> = [
        [y0, y0 + rail, zFront, zBack],
        [y1 - rail, y1, zFront, zBack],
        [y0, y1, zFront, zFront + rail],
        [y0, y1, zBack - rail, zBack],
      ];
      for (const [ya, yb, za, zb] of frame) {
        this.wbox(g.enamelInt, uv.galv, Math.min(face, outer), ya, za, Math.max(face, outer), yb, zb);
      }
      // Kick, in the brighter interior steel so the bottom of the cabinet is
      // not the same value as the rest of it.
      this.wbox(g.steelInt, uv.steel, Math.min(face, outer), y0, zFront, Math.max(face, outer), y0 + COOLER.kick, zBack);
    };
    endReturn(COOLER.x0, -1);
    endReturn(COOLER.x1, 1);
    this.wbox(g.enamelInt, uv.galv, COOLER.x0, y1 - 0.14, zFront, COOLER.x1, y1, zBack);
    // Valance over the doors, where the price rail lives.
    this.wbox(g.enamelInt, uv.galv, COOLER.x0 - 0.02, y1, zFront - 0.02, COOLER.x1 + 0.02, y1 + 0.17, zBack);
    this.wbox(g.dark, uv.dark, COOLER.x0 - 0.02, y1 + 0.02, zFront - 0.03, COOLER.x1 + 0.02, y1 + 0.09, zFront - 0.02);

    const inner0 = COOLER.x0 + 0.06;
    const inner1 = COOLER.x1 - 0.06;
    const doorW = (inner1 - inner0) / COOLER.doors;
    for (let i = 1; i < COOLER.doors; i++) {
      const x = inner0 + i * doorW;
      this.wbox(g.enamelInt, uv.galv, x - 0.022, y0 + COOLER.kick, zFront, x + 0.022, y1 - 0.14, zFront + 0.07);
    }

    // Lit white liner at the back and under the top.
    const liner: THREE.BufferGeometry[] = [
      buildingWorldBox(V3(inner0, y0, zBack - 0.03), V3(inner1, y1 - 0.14, zBack), { uvMetres: uv.galv }),
      buildingWorldBox(V3(inner0, y1 - 0.175, zFront + 0.06), V3(inner1, y1 - 0.14, zBack - 0.03), { uvMetres: uv.galv }),
    ];
    this.addMesh(mergeGeometries(liner, false)!, this.mat.coolerLiner, "cooler-liner");
    liner.forEach((l) => l.dispose());

    // TODO(System 4 - lighting): one vertical tube per mullion goes here.
    for (let i = 0; i <= COOLER.doors; i++) {
      const slot = new THREE.Object3D();
      slot.name = `building-cooler-light-${i}`;
      slot.position.set(inner0 + i * doorW, (y0 + y1) / 2, zFront + 0.11);
      slot.userData = { kind: "cooler-tube", axis: "y", length: COOLER.height - 0.34 };
      this.group.add(slot);
      this.coolerLightSlots.push(slot);
    }

    /* ---- wire shelves and stock ---- */
    const shelfY = [0.24, 0.62, 1.0, 1.38, 1.74];
    const wires: THREE.BufferGeometry[] = [];
    const stock: THREE.BufferGeometry[] = [];
    let grabPlaced = false;

    for (const sy of shelfY) {
      const y = y0 + sy;
      for (let k = 0; k < 9; k++) {
        const z = zFront + 0.13 + (k / 8) * (COOLER.depth - 0.22);
        const wire = buildingTube(0.0035, inner1 - inner0, "x", 6, 0.3);
        wire.translate((inner0 + inner1) / 2, y, z);
        wires.push(wire);
      }
      const lip = buildingTube(0.006, inner1 - inner0, "x", 6, 0.3);
      lip.translate((inner0 + inner1) / 2, y + 0.022, zFront + 0.12);
      wires.push(lip);

      const kinds: Array<"tall" | "squat" | "can"> = ["tall", "squat", "can"];
      let x = inner0 + 0.06;
      while (x < inner1 - 0.1) {
        /**
         * Leave the hero bottle its own facing. The stock loop walks x with a
         * random stride, so without this the one object that gets inspected ends
         * up behind whatever the loop happened to place in front of it — which
         * is exactly how the first capture of this came back with the bottle
         * invisible behind a green can, and a pose aimed at an object that is
         * not there is a measurement of nothing.
         */
        if (sy === shelfY[1] && Math.abs(x + 0.04 - GRAB_BOTTLE.x) < 0.075) {
          x += 0.09;
          continue;
        }
        const kind = kinds[Math.floor(rng() * 3) % 3];
        const h = kind === "can" ? 0.122 : kind === "tall" ? 0.235 + rng() * 0.05 : 0.19;
        const r = kind === "can" ? 0.033 : kind === "tall" ? 0.034 : 0.042;
        if (y + h > y1 - 0.22) break;
        const col = new THREE.Color(DRINK_COLORS[Math.floor(rng() * DRINK_COLORS.length) % DRINK_COLORS.length]);
        col.multiplyScalar(0.55 + rng() * 0.35);
        const lab = new THREE.Color(LABEL_COLORS[Math.floor(rng() * LABEL_COLORS.length) % LABEL_COLORS.length]);
        // The atlas ground averages about 0.78, so a label authored against a
        // bare material has to carry that factor back or every facing in the
        // cooler lands a fifth darker — the same correction `productColor`
        // makes for the shelf packaging.
        lab.multiplyScalar(1.06);
        // One design per product, not per unit: a cooler facing is a row of
        // the *same* drink, and giving each bottle its own label is the tell
        // that made the gondola shelves look generated.
        const cell = Math.floor(rng() * 4);
        const [lf0, lf1] = BOTTLE_LABEL[kind];
        // Gravity-fed shelves: the front row is always full and the rows
        // behind it thin out as the shelf sells down.
        const rows = 1 + Math.floor(rng() * 3);
        for (let ri = 0; ri < rows; ri++) {
          const z = zFront + 0.19 + ri * (r * 2.2);
          if (z > zBack - 0.12) break;
          const b = buildingBottle(kind, h, r);
          applyBottleLabel(b, cell, h * lf0, h * lf1);
          tintBottle(b, col, lab);
          b.translate(x + r, y + 0.026, z);
          // After the translate, not before: this reads world position. The
          // cooler's own lamps are vertical tubes on the front mullions, so the
          // back of a reach-in genuinely is the dark part, and the floor is
          // higher here than on an open gondola shelf for that reason.
          stock.push(
            shadeBySlotAccess(b, {
              deckY: y + 0.026,
              headroom: 0.35,
              lip: zFront + 0.12,
              facing: -1,
              outAxis: "z",
              floor: 0.52,
              contactFloor: 0.78,
              strength: dbg("bgao", 1),
            })
          );
        }
        if (!grabPlaced && sy === shelfY[1] && x > inner0 + 1.2) {
          /**
           * ### The handheld bottle, which is the one object here that gets
           * ### inspected rather than glanced at
           *
           * It rides 0.44 m from the camera in `InteractionSystem`'s hand pose
           * and it is one of the three interactions the brief specifies, so it
           * is built to its own budget in `buildingHeroBottle.ts`: 64 segments
           * against the shelf lathe's 16, a moulded closure with real flutes, a
           * neck finish with a support ring, and four leaves each carrying one
           * physical process. The critic read the old one as "a capped cylinder
           * with a flat top, no label, no material nuance", which is precisely
           * what a 16-segment lathe with a 256 px atlas cell looks like once you
           * are close enough to see it — the object was right for the cooler and
           * wrong for the hand, and one object cannot be both.
           *
           * Its position is fixed and published rather than left to the loop's
           * rng. Player needs to aim a video at it and this system needs a shot
           * pose on it, and two agents cannot both point at a random spot.
           */
          const hero = buildingHeroBottle(0.245, 0.035, 64);
          const grp = new THREE.Group();
          grp.name = "building-grab-bottle";
          const leaves: Array<[THREE.BufferGeometry, THREE.Material, string]> = [
            [hero.liquid, this.mat.heroLiquid, "grab-bottle-liquid"],
            [hero.label, this.mat.heroLabel, "grab-bottle-label"],
            [hero.cap, this.mat.heroCap, "grab-bottle-cap"],
            // The shell last, so a renderer sorting transparent by insertion
            // draws the container over its own contents.
            [hero.shell, this.mat.heroShell, "grab-bottle-shell"],
          ];
          for (const [g, m, nm] of leaves) {
            const leaf = new THREE.Mesh(g, m);
            leaf.name = nm;
            leaf.castShadow = true;
            grp.add(leaf);
          }
          /**
           * `?bgheld=1` stands the bottle in open air on the shop floor instead
           * of on its shelf.
           *
           * Not a convenience. Inspecting it where it sits means inspecting it
           * through a cooler door — glass, condensation and an emissive liner —
           * and the first capture from the shelf came back milky, with the sky
           * band at 202 and the whole frame washed toward white. **None of that
           * is present when the bottle is in your hand**, which is the only
           * state anyone will ever look at it in, so judging the object through
           * the glass would be judging the wrong picture. The cooler is 1.16 m
           * deep and the hand pose stands 0.44 m off, so there is no camera
           * position that is both the right distance and inside the cabinet;
           * the flag is the only way to make the inspection match delivery.
           */
          if (dbg("bgheld") > 0) {
            grp.position.set(HELD_BOTTLE.x, y0 + HELD_BOTTLE.aboveFloor, HELD_BOTTLE.z);
          } else {
            grp.position.set(GRAB_BOTTLE.x, y0 + GRAB_BOTTLE.aboveFloor, GRAB_BOTTLE.z);
          }
          grp.userData = { kind: "grabbable", label: "drink-bottle", height: 0.245 };
          this.group.add(grp);
          this.grabbables.push(grp);
          grabPlaced = true;
        }
        x += r * 2 + 0.004 + rng() * 0.02;
        if (rng() < 0.12) x += 0.05 + rng() * 0.1;
      }
    }
    this.addMesh(mergeGeometries(wires, false)!, this.mat.steelInt, "cooler-shelves");
    wires.forEach((w) => w.dispose());
    this.addMesh(mergeGeometries(stock, false)!, this.mat.bottle, "cooler-stock").castShadow = true;
    stock.forEach((s) => s.dispose());

    /* ---- glass doors, each on its own hinge ---- */
    for (let i = 0; i < COOLER.doors; i++) {
      const dx0 = inner0 + i * doorW;
      const w = doorW - 0.02;
      const h = y1 - 0.14 - (y0 + COOLER.kick) - 0.02;
      const pivot = new THREE.Group();
      pivot.name = `building-cooler-door-${i}`;
      pivot.position.set(dx0 + 0.012, y0 + COOLER.kick + 0.01, zFront + 0.03);
      pivot.userData = {
        kind: "hinge",
        axis: "y",
        closedAngle: 0,
        openAngle: 1.5,
        swing: "outward",
        index: i,
        width: w,
        height: h,
      };

      const stile = 0.038;
      const frame: THREE.BufferGeometry[] = [];
      const bar = (sx: number, sy: number, px: number, py: number) => {
        const b = buildingBox(sx, sy, 0.042, { uvMetres: this.uv.dark, uvOrigin: V3(px + dx0, py + y0, 0) });
        b.translate(px, py, 0);
        frame.push(b);
      };
      bar(stile, h, stile / 2, h / 2);
      bar(stile, h, w - stile / 2, h / 2);
      bar(w - stile * 2, stile, w / 2, stile / 2);
      bar(w - stile * 2, stile, w / 2, h - stile / 2);
      const frameMesh = new THREE.Mesh(mergeLocal(frame), this.mat.alu);
      frameMesh.name = `cooler-door-frame-${i}`;
      pivot.add(frameMesh);

      // Double glazing with a real 26 mm gap, so the edge of the unit catches
      // two highlights instead of one. That doubled reflection is most of what
      // separates a cooler door from a hole in a box.
      const coolerPanes: THREE.BufferGeometry[] = [];
      for (const dz of [-0.014, 0.012]) {
        const pane = buildingQuad(w - stile * 1.6, h - stile * 1.6, "-z");
        pane.translate(w / 2, h / 2, dz);
        const pm = new THREE.Mesh(pane, this.mat.coolerGlass);
        pm.name = `cooler-door-glass-${i}`;
        pm.renderOrder = 2;
        pivot.add(pm);
        coolerPanes.push(pane);
      }
      // Both leaves reflect, and the offset between the two highlights is the
      // point (see above) — but they can share one draw call, since the pair
      // is one additive layer with no depth interaction. Five doors would
      // otherwise cost ten extra draws instead of five.
      if (this.mat.coolerGlassRefl) {
        const rm = new THREE.Mesh(mergeGeometries(coolerPanes, false)!, this.mat.coolerGlassRefl);
        rm.name = `cooler-door-glass-refl-${i}`;
        rm.renderOrder = 3;
        pivot.add(rm);
      }
      const fog = buildingQuad(w - stile * 1.6, h - stile * 1.6, "-z");
      fog.translate(w / 2, h / 2, -0.022);
      const fogMesh = new THREE.Mesh(fog, this.mat.condensation);
      fogMesh.name = `cooler-door-condensation-${i}`;
      fogMesh.renderOrder = 5;
      pivot.add(fogMesh);

      const handle = buildingTube(0.014, h * 0.62, "y", 8, 0.3);
      handle.translate(w - stile - 0.03, h / 2, -0.06);
      pivot.add(new THREE.Mesh(handle, this.mat.alu));
      for (const hy of [h * 0.21, h * 0.79]) {
        const brk = buildingBox(0.022, 0.022, 0.05, { uvMetres: this.uv.alu });
        brk.translate(w - stile - 0.03, hy, -0.038);
        pivot.add(new THREE.Mesh(brk, this.mat.alu));
      }

      this.group.add(pivot);
      this.coolerDoors.push(pivot);
    }
  }

  private buildShelving(F: number, rng: Rng): void {
    /**
     * `?bgret=0` removes the shelving's horizontal up-facing returns. A control
     * in the same bundle is the only thing that separates a subtle feature from
     * an absent one, and this one is specifically a claim about the *direction*
     * a face points, so the A/B has to hold everything else — albedo, light,
     * pose — fixed while changing only that.
     */
    const upReturns = dbg("bgret", 1) !== 0;
    /**
     * `?bgao=0` removes the baked slot-access shading from every shelf product.
     * The claim this term makes is that the interior looks flat because it has
     * no *shading*, not because it has no detail, and the only way to test that
     * claim is to render the identical scene without it.
     */
    const shelfShade = dbg("bgao", 1);
    if (!Number.isFinite(dbg("bgret", 1))) throw new Error("BuildingSystem: ?bgret must be a number");
    if (!Number.isFinite(shelfShade)) throw new Error("BuildingSystem: ?bgao must be a number");
    const strips: THREE.BufferGeometry[] = [];
    for (const cz of GONDOLA_Z) {
      const run = buildingGondola({
        x0: GONDOLA_X.x0,
        x1: GONDOLA_X.x1,
        cz,
        baseY: F,
        height: 1.55,
        rng,
        // The back run is the one nobody faces up.
        untidy: cz > 36 ? 0.75 : 0.4,
        returns: upReturns,
        shade: shelfShade,
      });
      this.geo.fixture.push(run.frame);
      this.geo.product.push(...run.products);
      strips.push(...run.strips);
    }
    // A low island of impulse stock in front of the counter.
    const island = buildingGondola({
      x0: ISLAND.x0,
      x1: ISLAND.x1,
      cz: ISLAND.cz,
      baseY: F,
      height: ISLAND.height,
      rng,
      untidy: 0.85,
      returns: upReturns,
      shade: shelfShade,
    });
    this.geo.fixture.push(island.frame);
    this.geo.product.push(...island.products);
    strips.push(...island.strips);

    if (strips.length) {
      this.addMesh(mergeGeometries(strips, false)!, this.mat.signStrip, "shelf-price-strips", 1);
      strips.forEach((s) => s.dispose());
    }
  }

  private buildCounter(F: number, rng: Rng): void {
    const g = this.geo;
    const uv = this.uv;
    const { x0, x1, z0, z1, height } = COUNTER;
    const box = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number) =>
      this.wbox(g.fixture, uv.dark, bx0, by0, bz0, bx1, by1, bz1);
    /** Equipment - the register, the reader - stays dark against the fittings. */
    const dbox = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number) =>
      this.wbox(g.dark, uv.dark, bx0, by0, bz0, bx1, by1, bz1);

    // Carcass with a recessed toe kick and a 30 mm worktop overhang.
    box(x0, F + 0.11, z0, x1, F + height - 0.04, z1);
    box(x0 + 0.06, F, z0 + 0.06, x1 - 0.06, F + 0.11, z1);
    box(x0 - 0.03, F + height - 0.04, z0 - 0.03, x1 + 0.03, F + height, z1);

    // Low glass display front with a shelf of small goods behind it.
    const pane = buildingQuad(x1 - x0 - 0.2, 0.52, "-z");
    pane.translate((x0 + x1) / 2, F + 0.42, z0 - 0.008);
    this.addGlazing(pane, this.mat.glass, this.mat.glassRefl, "counter-display-glass", 2);
    g.product.push(
      ...buildingShelfProducts(
        { x0: x0 + 0.1, x1: x1 - 0.1, zFront: z0 + 0.06, depth: 0.2, y: F + 0.2, facing: -1, untidy: 0.9, maxHeight: 0.14 },
        rng
      )
    );

    // Register: base, angled screen on a stalk, and a card reader on the lip.
    const rx = x0 + 0.78;
    dbox(rx - 0.19, F + height, z0 + 0.34, rx + 0.19, F + height + 0.09, z0 + 0.66);
    const screen = buildingBox(0.34, 0.26, 0.03, { uvMetres: uv.dark });
    screen.rotateX(-0.28);
    screen.translate(rx, F + height + 0.29, z0 + 0.52);
    g.dark.push(screen);
    const stalk = buildingTube(0.022, 0.16, "y", 8, 0.3);
    stalk.translate(rx, F + height + 0.15, z0 + 0.56);
    g.steelInt.push(stalk);
    const reader = buildingBox(0.1, 0.15, 0.05, { uvMetres: uv.dark });
    reader.rotateX(-0.5);
    reader.translate(rx - 0.4, F + height + 0.09, z0 + 0.15);
    g.dark.push(reader);
    // Cup stack and a tip jar: the clutter that says the place is open.
    const cups = buildingTube(0.045, 0.42, "y", 12, 0.3);
    cups.translate(x1 - 0.3, F + height + 0.21, z0 + 0.5);
    g.enamelInt.push(cups);
    const jar = buildingTube(0.055, 0.13, "y", 12, 0.3);
    jar.translate(rx + 0.45, F + height + 0.065, z0 + 0.18);
    g.steelInt.push(jar);

    // Back bar: an overhead unit of small facings behind the till.
    const bz0 = z1 + 0.3;
    const bz1 = bz0 + 0.36;
    box(x0, F, bz0, x1, F + 0.06, bz1);
    box(x0, F, bz0, x0 + 0.03, F + 2.05, bz1);
    box(x1 - 0.03, F, bz0, x1, F + 2.05, bz1);
    box(x0, F + 2.02, bz0, x1, F + 2.05, bz1);
    box(x0, F, bz1 - 0.025, x1, F + 2.05, bz1);
    for (const sy of [0.42, 0.78, 1.14, 1.5, 1.84]) {
      box(x0 + 0.03, F + sy - 0.015, bz0, x1 - 0.03, F + sy, bz1 - 0.025);
      g.product.push(
        ...buildingShelfProducts(
          { x0: x0 + 0.07, x1: x1 - 0.07, zFront: bz0 + 0.02, depth: 0.28, y: F + sy, facing: -1, untidy: 0.3, maxHeight: 0.3 },
          rng
        )
      );
    }
  }

  /**
   * The vinyl is worn matt wherever feet go. The pattern spreads from the door
   * and splits toward the cooler and the register rather than washing the
   * whole floor evenly, which is the difference between "worn" and "dirty".
   */
  private buildTrafficPath(F: number): void {
    for (const p of [
      { x: -6.0, z: 32.6, w: 2.0, d: 1.9, r: 0 },
      { x: -5.7, z: 33.9, w: 2.4, d: 2.0, r: 0.3 },
      { x: -5.0, z: 35.9, w: 2.2, d: 2.0, r: -0.2 },
      { x: -4.4, z: 38.1, w: 3.2, d: 1.6, r: 0.1 },
      { x: -2.6, z: 33.3, w: 3.0, d: 1.8, r: 0.5 },
      { x: 0.4, z: 33.9, w: 2.6, d: 1.9, r: -0.4 },
      { x: -1.3, z: 35.9, w: 2.2, d: 1.6, r: 0.2 },
    ]) {
      const quad = buildingQuad(p.w, p.d, "+y");
      quad.rotateY(p.r);
      quad.translate(p.x, F + 0.004, p.z);
      this.addMesh(quad, this.mat.traffic, "floor-traffic", 2);
    }
  }

  /* ---------------------------------------------------------------- */
  /* commit, collision, services                                       */
  /* ---------------------------------------------------------------- */

  /**
   * A `DoubleSide` material with `transmission > 0` samples the render target
   * it is being drawn into, which is undefined behaviour and on this driver
   * paints large areas exactly black. It cost a round and a critic's #1 defect.
   * The failure is invisible in review — one property on one material — and
   * silent from the outside, so it gets the same treatment as a shader link
   * error: fatal at build time. `Game` routes this into
   * `window.__SYSTEM_ERRORS`, which every capture asserts is empty.
   */
  private assertNoDoubleSidedTransmission(): void {
    const bad = this.materials.filter(
      (m) => (m as THREE.MeshPhysicalMaterial).transmission > 0 && m.side === THREE.DoubleSide
    );
    if (bad.length) {
      throw new Error(
        `[building] ${bad.length} transmissive material(s) are DoubleSide, which feeds the ` +
          `transmission render target back into itself and renders black on ANGLE: ` +
          bad.map((m) => m.name || m.type).join(", ")
      );
    }
  }

  private commitBatches(): void {
    const pairs: Array<[THREE.BufferGeometry[], THREE.Material, string, boolean]> = [
      [this.geo.cmuExt, this.mat.cmuExt, "cmu-exterior", true],
      [this.geo.cmuBase, this.mat.cmuBase, "cmu-base-course", true],
      [this.geo.cmuInt, this.mat.cmuInt, "cmu-interior", true],
      [this.geo.alu, this.mat.alu, "aluminium", true],
      [this.geo.galv, this.mat.galv, "galvanised", true],
      [this.geo.steel, this.mat.steel, "steelwork", true],
      [this.geo.steelInt, this.mat.steelInt, "steelwork-interior", true],
      [this.geo.dark, this.mat.darkMetal, "dark-metal", true],
      [this.geo.enamel, this.mat.enamel, "enamel", true],
      [this.geo.enamelInt, this.mat.enamelInt, "enamel-interior", true],
      [this.geo.fixture, this.mat.fixture, "fixtures", true],
      [this.geo.product, this.mat.product, "product", false],
    ];
    for (const [list, material, name, shadow] of pairs) {
      if (!list.length) continue;
      const mesh = this.addMesh(mergeGeometries(list, false)!, material, name);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      list.forEach((geo) => geo.dispose());
      list.length = 0;
    }
  }

  private buildBlockers(): void {
    const w = PLAN.wall;
    this.blockers.push(
      { minX: PLAN.x0, maxX: PLAN.x0 + w, minZ: PLAN.z0, maxZ: PLAN.z1 },
      { minX: PLAN.x1 - w, maxX: PLAN.x1, minZ: PLAN.z0, maxZ: PLAN.z1 },
      { minX: PLAN.x0, maxX: PLAN.x1, minZ: PLAN.z1 - w, maxZ: PLAN.z1 },
      // Front wall, broken by the door opening.
      { minX: PLAN.x0, maxX: PLAN.doorX0, minZ: PLAN.z0, maxZ: PLAN.z0 + w },
      { minX: PLAN.doorX1, maxX: PLAN.x1, minZ: PLAN.z0, maxZ: PLAN.z0 + w },
      { minX: COOLER.x0, maxX: COOLER.x1, minZ: IN.z1 - COOLER.depth, maxZ: IN.z1 },
      { minX: COUNTER.x0 - 0.03, maxX: COUNTER.x1 + 0.03, minZ: COUNTER.z0 - 0.03, maxZ: COUNTER.z1 + 0.7 },
      { minX: ISLAND.x0, maxX: ISLAND.x1, minZ: ISLAND.cz - ISLAND.halfDepth, maxZ: ISLAND.cz + ISLAND.halfDepth },
      // Ice machine and propane cage, outside the front wall.
      { minX: 1.75, maxX: 2.95, minZ: PLAN.z0 - 0.86, maxZ: PLAN.z0 },
      { minX: -9.78, maxX: -8.62, minZ: PLAN.z0 - 0.94, maxZ: PLAN.z0 + 0.02 }
    );
    for (const cz of GONDOLA_Z) {
      this.blockers.push({
        minX: GONDOLA_X.x0,
        maxX: GONDOLA_X.x1,
        minZ: cz - GONDOLA_X.halfDepth,
        maxZ: cz + GONDOLA_X.halfDepth,
      });
    }
  }

  private publish(game: SystemContext["game"], F: number, entryDoor: THREE.Group): void {
    game.provide("building.root", this.group);
    game.provide("building.bounds", new THREE.Box3(V3(PLAN.x0, F - 0.5, PLAN.z0), V3(PLAN.x1, F + PLAN.parapet + 0.06, PLAN.z1)));
    game.provide("building.footprint", {
      minX: PLAN.x0,
      maxX: PLAN.x1,
      minZ: PLAN.z0,
      maxZ: PLAN.z1,
      floorY: F,
      roofY: F + PLAN.roofDeck,
      parapetY: F + PLAN.parapet + 0.052,
      wallThickness: PLAN.wall,
    });
    /**
     * Every material drawn only inside the sealed room, for the lighting
     * system's interior IBL pass.
     *
     * Published because that pass currently keys off **mesh names**, and a mesh
     * does not own its material — this file batches by material, so a name set
     * is a lossy way to name a material set. That is what let one enamel
     * material carry both the ceiling grid and the ice machine, and dimming the
     * first silently dimmed the second. The materials are now disjoint, and
     * this list is the contract that keeps them so: it is generated from the
     * same place the meshes are, so a new interior fitting cannot be added
     * without appearing here.
     */
    game.provide("building.interiorMaterials", [
      this.mat.cmuInt,
      this.mat.vct,
      this.mat.ceilTile,
      this.mat.enamelInt,
      this.mat.steelInt,
      this.mat.fixture,
      this.mat.coolerLiner,
      this.mat.product,
      this.mat.bottle,
      this.mat.traffic,
    ]);
    game.provide("building.entryDoor", entryDoor);
    game.provide("building.coolerDoors", this.coolerDoors);
    game.provide("building.coolerLightSlots", this.coolerLightSlots);
    game.provide("building.fluorescents", this.fluorescents);
    game.provide("building.exteriorLight", this.exteriorLight);
    game.provide("building.grabBottle", this.grabbables[0] ?? null);
    game.provide("building.grabbables", this.grabbables);
    game.provide("building.blockers", this.blockers);
    game.provide("building.collide", this.collide);
    game.provide("building.floorHeight", (x: number, z: number) =>
      x > IN.x0 && x < IN.x1 && z > PLAN.z0 && z < IN.z1 ? F : groundHeight(x, z)
    );
  }

  /**
   * Push a point out of any building blocker, mutating it in place. Published
   * on the registry the same way TerrainSystem publishes `groundHeight`: a
   * plain function, so PlayerSystem can pull it out with `tryGet` and needs no
   * import in either direction.
   */
  private collide = (p: THREE.Vector3, radius = 0.32): boolean => {
    let hit = false;
    for (const b of this.blockers) {
      const minX = b.minX - radius;
      const maxX = b.maxX + radius;
      const minZ = b.minZ - radius;
      const maxZ = b.maxZ + radius;
      if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
      // Push out along whichever axis needs the least movement, so walking
      // into a wall slides along it instead of stopping dead.
      const dxL = p.x - minX;
      const dxR = maxX - p.x;
      const dzL = p.z - minZ;
      const dzR = maxZ - p.z;
      const least = Math.min(dxL, dxR, dzL, dzR);
      if (least === dxL) p.x = minX;
      else if (least === dxR) p.x = maxX;
      else if (least === dzL) p.z = minZ;
      else p.z = maxZ;
      hit = true;
    }
    return hit;
  };

  dispose(): void {
    void this.floorY;
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.maps.forEach(disposeBuildingMaps);
    this.textures.forEach((t) => t.dispose());
  }
}
