import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GameSystem, SystemContext } from "../core/types";
import { initPhases } from "../core/initPhase";
import { gridSurface, gridSurfaceGraded, ragEdge, ragOffset, solidColors, stripeGeometry, sweepProfile } from "../gen/geo";
import { makeSiteOverlay } from "../gen/siteOverlay";
import { makeAsphalt, makeConcrete, makeDirt, makeMacroNoise, makePaint, SurfaceMaps } from "../gen/textures";
import { applyWorldDetail } from "../gen/worldDetail";
import { makeSoilField } from "../gen/groundSoil";
import { makeAccumField, type GroundAccum } from "../gen/groundAccum";
import { makeRng } from "../gen/noise";
import {
  DRIVEWAYS,
  FORECOURT,
  groundHeight,
  ISLAND,
  ISLANDS,
  FORCE,
  PAD,
  PARKING,
  ROAD,
  ROAD_EDGE,
  dirtY,
  pavedDistance,
  drivewayY,
  padY,
  roadSurface,
} from "../site";

const V2 = (x: number, y: number) => new THREE.Vector2(x, y);

/**
 * Terrain-only diagnostic switches, `?tforce=a,b`.
 *
 * Separate from `?force=` in site.ts, which drives the height field and the
 * baked overlay, because these switch *materials* and need to be legible next
 * to each other in a capture log.
 *
 * Every token is validated. NOTES.md case 25: a hook that selects behaviour by
 * string and ignores what it does not recognise returns a byte-identical
 * capture for a typo, and a clean negative from a forced-value test is the most
 * persuasive artefact this project has. Resolved lazily so the throw lands
 * inside `init()`, where Game records it on `__SYSTEM_ERRORS`, rather than at
 * module evaluation where it would take the whole page down.
 */
const TFORCE_TOKENS = [
  /** antiTile off everywhere: the control for the tiling measurement. */
  "notile",
  /** Flat albedo and flat roughness, so only the normal map draws. */
  "bumponly",
  /** normalScale 0, so only albedo and roughness draw. */
  "albedoonly",
  /** Hold the normal map at full strength regardless of distance. */
  "nofade",
  /** Soil variation off: the control that must move pixels. */
  "nosoil",
  /** Soil field rendered straight to albedo. */
  "soilviz",
  /** Wetness off entirely: no puddles, no damp, no darkening. */
  "nowet",
  /** Wetness mask rendered straight to albedo. */
  "wetviz",
  /** Wetness mask forced to 1 over the whole site. */
  "wetmax",
  /**
   * The ground plane casts into the shadow map. Off by default; this is the arm
   * that made that a decision rather than a default. See the comment at the
   * `ground` mesh.
   */
  "terraincast",
  /**
   * Gravel back to the 9000-stone arm, for the triangle-cost comparison and as
   * the control for whether the near-field debris is doing anything. Named for
   * what it does rather than "nodebris", because zero gravel is a different
   * question from thin gravel and Perf wants the second one.
   */
  "thindebris",
] as const;
type TForce = Record<(typeof TFORCE_TOKENS)[number], boolean>;

function readTForce(): TForce {
  const raw = new URLSearchParams(location.search).get("tforce") ?? "";
  const on = new Set(raw.split(",").filter(Boolean));
  const unknown = [...on].filter((k) => !(TFORCE_TOKENS as readonly string[]).includes(k));
  if (unknown.length) {
    throw new Error(
      `[terrain] unknown ?tforce= token(s): ${unknown.join(", ")}. Known: ${TFORCE_TOKENS.join(", ")}`
    );
  }
  return Object.fromEntries(TFORCE_TOKENS.map((k) => [k, on.has(k)])) as TForce;
}

/** `?force=` is parsed at module load, where a throw would blank the page. */
function assertSiteForceRecognised() {
  if (FORCE.unknown.length) {
    throw new Error(
      `[terrain] unknown ?force= token(s): ${FORCE.unknown.join(", ")}. A silently-ignored force token ` +
        `produces an unchanged capture, which reads as proof the feature belongs to another system.`
    );
  }
}

/**
 * System 1: everything you walk on.
 *
 * Terrain, the two-lane highway, the driveway aprons, the asphalt lot, the
 * concrete forecourt with real jointed slabs, the raised pump islands, the
 * curbs and every painted marking. Nothing above ankle height belongs here.
 *
 * TODO(System 4 - lighting): the sun disc is a hard-edged white circle with no
 * bloom and no atmospheric reddening, and distant surfaces fade to a flat
 * grey-blue instead of warm aerial perspective. Both are lighting/atmosphere
 * problems, not surface problems - fix them with the real sky + aerial
 * perspective pass rather than by touching these materials.
 * TODO(System 9 - post): the sun needs bloom and a little lens dirt/veil.
 */
export class TerrainSystem implements GameSystem {
  readonly name = "terrain";

  private group = new THREE.Group();
  private surfaces: SurfaceMaps[] = [];
  private materials: THREE.Material[] = [];

  /**
   * Every texture this system allocated, found by walking the material slots
   * and the injection's uniform table at the end of init. Held so that
   * `dispose` can release all of them.
   *
   * `dispose` used to free the four `SurfaceMaps` and nothing else, which left
   * the macro noise, the site overlay and the soil field allocated on every
   * teardown - the three largest single textures the system owns, and the three
   * that are bound through the world-detail uniform table rather than through a
   * `material.map` slot, so nothing that walks materials can see them. That is
   * invisible in a single session and unbounded across navigations.
   */
  private ownedTextures = new Set<THREE.Texture>();
  /** Field textures bound through the injection, not through a material slot. */
  private fieldTextures: THREE.Texture[] = [];
  /** The rendered ground surface, not the height field. See `geo.ts`. */
  private groundSurfaceAt: (x: number, z: number) => number = () => 0;
  private groundSpacing: Record<string, number> | null = null;
  private debrisCounts: Record<string, number> | null = null;

  init(ctx: SystemContext): void {
    const { scene, game } = ctx;
    /**
     * Phase boundaries sit on the section comments that were already here, so
     * the instrumentation adds no structure of its own and cannot drift from the
     * code it describes. `phase.end()` reports what no phase claimed, which is
     * the number that matters: three cheap sections summing to 400 ms would
     * otherwise read as a fast init with the rest hidden in the gaps.
     */
    const phase = initPhases("terrain");
    const TF = readTForce();
    assertSiteForceRecognised();
    game.provide("groundHeight", groundHeight);

    /* ---------------- procedural material library ---------------- */
    const asphaltMaps = phase.of("asphalt 2048", () => makeAsphalt(2048, 8, 1337));
    const concreteMaps = phase.of("concrete 1024", () => makeConcrete(1024, 4, 99));
    const dirtMaps = phase.of("dirt 1024", () => makeDirt(1024, 17, 404));
    // The second soil: a fine pale clay crust with the gravel and the dead
    // grass largely absent and a tighter clod structure. Deliberately NOT the
    // same maps at another brightness - that reads as an exposure change, not
    // as a different substance. Its tile is 11.3 m against the base 17 m, two
    // lengths with no small common multiple, so where the two materials meet
    // there is no shared period for the eye to lock onto.
    const dirtFineMaps = phase.of("dirt fine 1024", () => makeDirt(1024, 11.3, 909, {
      gravel: 0.22,
      rocks: 0.3,
      grass: 0.35,
      clodFreq: 1.9,
      relief: 0.62,
      palette: { dustLight: 0x8a7c64, dirtMid: 0x6a5c49, dirtDark: 0x453a2c, gravelCol: 0x7d7468 },
    }));
    const paintWhite = phase.of("paint white", () => makePaint(1024, 77, false));
    const paintYellow = phase.of("paint yellow", () => makePaint(1024, 178, true));
    const macro = phase.of("macro noise 512", () => makeMacroNoise(512, 5150));
    const site = phase.of("site overlay", () => makeSiteOverlay());
    /**
     * The world-space field textures, held explicitly.
     *
     * They used to be discovered by walking `material.userData.shader.uniforms`,
     * which counted none of them: that userData is populated by
     * `onBeforeCompile`, which runs at the first render, and `__TERRAIN` is
     * written at the end of `init()`. So the byte count silently omitted the
     * overlay, the macro noise, the soil field, the wash, the void mask and the
     * alternate soil — every texture bound through the injection rather than
     * through a material slot.
     *
     * It was invisible because the loop was correct and its input was empty, and
     * an empty loop contributes zero without erroring. It only surfaced because
     * shrinking the overlay by 2.25x left the reported total **unchanged to one
     * decimal place**, which is not a plausible result of a real change. The
     * figure previously reported as a correction, 138.7 MB, was itself short by
     * everything in this list.
     */
    this.fieldTextures.push(macro, site.texture);
    this.surfaces.push(asphaltMaps, concreteMaps, dirtMaps, dirtFineMaps);

    /* ---------------- the soil field, and its published service ---------------- */
    phase("soil field + service");

    const soilField = makeSoilField();
    this.fieldTextures.push(soilField.texture);
    // `nosoil` is the control that must move pixels: if a capture with it on is
    // identical to one without, the field is not wired up and no amount of
    // tuning will ever show it (NOTES.md case 25 / the ?force= precedent).
    const soilCommon = {
      field: soilField.texture,
      origin: soilField.origin,
      size: soilField.size,
      gain: TF.nosoil ? 0 : 1,
      wet: TF.nowet ? 0 : 1,
      wetFloor: TF.nowet ? 0 : TF.wetmax ? 1 : 0,
      viz: TF.soilviz,
      pools: soilField.pools,
    };

    /**
     * Published only now that it exists, and only after `soilProbe` has agreed
     * with the bytes the sampler reads. Per the `skyRadiance` precedent nobody
     * should have been coding against the shape while it was still a plan.
     *
     * All three scalars are pure functions of world XZ with no renderer state
     * behind them, so a scatter pass can call them a hundred thousand times
     * before the first frame.
     */
    game.provide("groundSoil", {
      colourSpace: "linear-srgb-scene-referred" as const,
      /** 0 = undisturbed crust, 1 = trafficked/compacted. World XZ, metres. */
      disturbance: soilField.disturbance,
      /**
       * 0 = dry, 1 = standing water. Same field the wet mask uses.
       *
       * One documented divergence, and it is deliberate: the shader dithers
       * this value inside the shoreline band with a sub-metre world noise so
       * the margin is ragged instead of a smooth contour, and the CPU side
       * does not reproduce that. Agreement is exact in the interior of a pool
       * and on dry ground, and approximate within roughly 0.3 m of the
       * waterline. Scatter against this and you are scattering against the
       * field, which is the right thing; do not use it to place something that
       * has to sit exactly on the visible edge.
       */
      wetness: soilField.wetness,
      /** Metres above/below the local drainage datum; negative is a low spot. */
      drainage: soilField.drainage,
      /** 0 = coarse gravelly crust, 1 = fine pale clay. Which soil is underfoot. */
      material: soilField.material,
      /** World Y of the standing water in each of site.LOW_SPOTS. */
      waterLevels: soilField.waterLevels,
      /**
       * Range and units, because "0..1" is true of three of these four and
       * says nothing useful about any of them, and because ONE OF THEM IS NOT
       * 0..1 AT ALL. `drainage` is signed metres about the local datum: a
       * consumer reaching for it as a bare multiplier gets a negative factor
       * over every low spot, which inverts its own effect exactly where the
       * effect was wanted. That is the failure mode this block exists to stop,
       * and it is one I hit myself earlier tonight from the shader side.
       */
      range: {
        disturbance: { units: "dimensionless", min: 0, max: 1, neutral: 0, safeAsMultiplier: true },
        wetness: { units: "dimensionless", min: 0, max: 1, neutral: 0, safeAsMultiplier: true },
        drainage: {
          units: "metres, signed",
          min: -soilField.drainRange,
          max: soilField.drainRange,
          neutral: 0,
          safeAsMultiplier: false,
          note:
            "Signed and in metres. Negative is a low spot. Not a 0..1 field and " +
            "not a multiplier: scale it by your own reciprocal of drainRange " +
            "first, and decide explicitly what you want the sign to do.",
        },
        material: { units: "dimensionless", min: 0, max: 1, neutral: 0, safeAsMultiplier: true },
        drainRange: soilField.drainRange,
      },
    });

    /* ---------------- accumulation, and its published service ---------------- */
    phase("accumulation service");

    /**
     * Published in the same breath as the debris this system scatters with it,
     * on purpose. A service that nobody renders is indistinguishable from a
     * service that does not work, and this file has been on the wrong side of
     * that twice tonight; the gravel spill and the litter below are the proof
     * that the numbers coming out of these functions land somewhere.
     */
    const accum = makeAccumField(soilField);
    game.provide("groundAccum", accum);

    /* ---------------- the pavement edge, as a function rather than a number ---------------- */

    /**
     * Requested by Vegetation, which was reasoning against a hardcoded 190 mm
     * and had correctly declared it as a constant so raising it was one edit.
     * A published function is better than a shared constant for the same reason
     * `groundSoil` is: there is then no number for two systems to disagree
     * about, and no ceiling — the excursion can grow and callers follow for
     * free.
     *
     * `edgeZ` returns the line the geometry actually uses, not a model of it:
     * it calls the same `ragOffset` with the same per-side seeds that `ragEdge`
     * passes when it displaces the vertices, so agreement is exact by
     * construction rather than by maintenance.
     *
     * Raised to 400 mm on Vegetation's answer. Its limit is how far a tuft's
     * centre lands on asphalt, and it has made its inset a fraction of the
     * declared excursion so its worst case holds as the excursion grows. Note
     * for the record that at 400 mm over a ~1 m scallop the edge line is at a
     * 40% slope, so this geometry runs out before that tolerance does.
     */
    game.provide("pavementEdge", {
      /**
       * Range and units. The distinction that matters here is **envelope
       * against observed**: `excursion` is the envelope the noise is
       * normalised to, and the largest offset actually reached over the 680 m
       * of highway is 354 mm, not 400. A consumer sizing a margin off
       * `excursion` is correctly conservative; one asserting that the edge
       * reaches 400 mm somewhere will fail its own test.
       */
      range: {
        units: "metres, world Z",
        excursionEnvelope: ROAD_EDGE.excursion,
        observedMaxOffset: 0.354,
        /** Steepest edge-line slope, and the largest jump between adjacent mesh vertices. */
        maxSlope: 0.10,
        maxJumpPerVertex: 0.052,
        vertexPitch: 0.5,
        /**
         * Real wavelengths, above the 1.0 m Nyquist limit of the 0.5 m vertex
         * pitch. Stated because the previous version claimed 18 m down to
         * 0.19 m and delivered white noise, and anyone reasoning about how far
         * the edge travels between two of their own samples needs the longest
         * one to be true.
         */
        wavelengths: [18.0, 6.5, 2.2],
      },
      /** Metres of maximum excursion either side of nominal. Read this, do not hardcode it. */
      excursion: ROAD_EDGE.excursion,
      /** World Z of the straight nominal edge, so a caller can recover the offset. */
      nominalZ: (side: number) => (side < 0 ? -ROAD.halfPaved : ROAD.halfPaved),
      /** World Z of the ragged asphalt edge at this X. `side` is -1 or +1. */
      edgeZ: (x: number, side: number) => {
        const at = side < 0 ? -ROAD.halfPaved : ROAD.halfPaved;
        const seed = side < 0 ? ROAD_EDGE.seedMinus : ROAD_EDGE.seedPlus;
        return at + ragOffset(x, seed) * ROAD_EDGE.excursion * (Math.sign(at) || 1);
      },
    });

    // Debug hook: lets a harness read the overlay's own bytes at a world
    // position, which separates "the overlay was never painted" from "the
    // overlay is painted but the shader is not using it".
    (window as unknown as { __OVERLAY?: unknown }).__OVERLAY = {
      sampleWorld(x: number, z: number) {
        const img = site.texture.image as { data: Uint8Array; width: number; height: number };
        const u = (x - site.origin.x) / site.size.x;
        const v = (z - site.origin.y) / site.size.y;
        const ix = Math.round(u * (img.width - 1));
        const iy = Math.round(v * (img.height - 1));
        const i = (iy * img.width + ix) * 4;
        return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
      },
    };

    const overlayCommon = {
      overlay: site.texture,
      overlayOrigin: site.origin,
      overlaySize: site.size,
    };
    // Everything paved shares the same wash source so grit blown off the
    // shoulder looks like the same material wherever it lands.
    const washCommon = { washMap: dirtMaps.map, washMetres: dirtMaps.tileMetres };
    // Wheel-path centres for the two travel lanes, 1.8 m gauge.
    const WHEELS = [
      -ROAD.laneWidth / 2 - 0.9,
      -ROAD.laneWidth / 2 + 0.9,
      ROAD.laneWidth / 2 - 0.9,
      ROAD.laneWidth / 2 + 0.9,
    ];

    // Drive aisle in front of the stalls: two-way, 1.8 m gauge per direction.
    const AISLE = [27.8, 29.6, 29.9, 31.7];

    const asphalt = new THREE.MeshStandardMaterial({
      map: asphaltMaps.map,
      normalMap: asphaltMaps.normalMap,
      roughnessMap: asphaltMaps.roughnessMap,
      normalScale: V2(0.2, 0.2),
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.85,
      dithering: true,
    });
    const asphaltDetail = {
      macro,
      macroMetres: 41,
      macroAlbedo: 0.26,
      macroRoughness: 0.16,
      specularEnv: 0.75,
      directSpec: 0.5,
      antiTile: TF.notile ? 0 : 0.5,
      normalFade: !TF.nofade,
      // The brief asks for wet asphalt from last night's rain, and all four
      // LOW_SPOTS are inside PAD, so the standing water in this scene is on
      // pavement rather than on soil. No alternate material: asphalt does not
      // turn into clay, it just gets wet. `gain` is held well down because the
      // drainage and disturbance arms are authored for soil, and at full
      // strength they read as staining rather than as grade.
      // `wetBase` is the "it rained last night" term and it is deliberately
      // only on pavement. Asphalt is close to impermeable, so it holds a film
      // for hours after a shower; the soil next to it drank the same rain and
      // was touch-dry by first light, which is why a wet lot beside dry ground
      // is the normal look rather than an inconsistency.
      soil: { ...soilCommon, gain: TF.nosoil ? 0 : 0.28, wetBase: TF.nowet ? 0 : 0.34 },
      ...overlayCommon,
      ...washCommon,
      washGain: 0.62,
      overlayTint: new THREE.Color(0x120f0e),
      wheelPaths: WHEELS,
      wheelBand: [-ROAD.halfPaved, ROAD.halfPaved] as [number, number],
      // The site's own circulation lane. Without this the drive aisle and the
      // empty stalls sat at exactly the same value, which is what makes a lot
      // look manufactured rather than used.
      wheelPathsB: AISLE,
      wheelBandB: [26.4, 32.6] as [number, number],
      // ?force=aisle isolates the aisle band: the carriageway tracks are pushed
      // out of the world so only band B can be responsible for what changes.
      ...(FORCE.aisle ? { wheelPaths: [1e6, 1e6, 1e6, 1e6], wheelStrength: 1, wheelDark: 0 } : {}),
      wheelStrength: FORCE.wheel ? 1 : 0.42,
      wheelDark: FORCE.wheel ? 0 : 0.58,
      wheelViz: FORCE.wheelViz,
    };
    applyWorldDetail(asphalt, { ...asphaltDetail, key: "asphalt" });

    // The highway and the station's own paving were laid years apart by
    // different contractors, so they are not the same mix: the lot is an older,
    // finer, more sun-bleached surface. Sharing one aggregate grade across the
    // whole site was reading as a single poured slab from horizon to horizon.
    const lotMaps = Object.fromEntries(
      (["map", "normalMap", "roughnessMap"] as const).map((k) => {
        const t = asphaltMaps[k].clone();
        t.needsUpdate = true;
        t.repeat.set(asphaltMaps[k].repeat.x * 1.42, asphaltMaps[k].repeat.y * 1.42);
        t.offset.set(0.37, 0.61);
        return [k, t];
      })
    ) as unknown as Record<"map" | "normalMap" | "roughnessMap", THREE.Texture>;

    const asphaltLot = new THREE.MeshStandardMaterial({
      ...lotMaps,
      normalScale: V2(0.165, 0.165),
      color: 0xb6b0a8,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.78,
      dithering: true,
    });
    if (FORCE.lotMat) {
      asphaltLot.color.set(0xff00ff);
      for (const t of Object.values(lotMaps)) t.repeat.multiplyScalar(3);
    }
    applyWorldDetail(asphaltLot, { ...asphaltDetail, key: "asphalt-lot" });

    const concrete = new THREE.MeshStandardMaterial({
      map: concreteMaps.map,
      normalMap: concreteMaps.normalMap,
      roughnessMap: concreteMaps.roughnessMap,
      normalScale: V2(0.3, 0.3),
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.72,
      dithering: true,
    });
    const concreteDetail = {
      macro,
      macroMetres: 21,
      macroAlbedo: 0.32,
      macroRoughness: 0.12,
      specularEnv: 0.46,
      directSpec: 0.38,
      antiTile: TF.notile ? 0 : 0.4,
      normalFade: !TF.nofade,
      ...overlayCommon,
      ...washCommon,
      washGain: 0.8,
      overlayGain: 1.0,
      overlayTint: new THREE.Color(0x15120f),
    };
    applyWorldDetail(concrete, { key: "concrete", ...concreteDetail });

    // Curbs and islands carry baked contact occlusion in their vertex colours,
    // which needs its own program.
    const concreteAo = concrete.clone();
    concreteAo.vertexColors = true;
    applyWorldDetail(concreteAo, { key: "concrete-ao", ...concreteDetail });

    const dirt = new THREE.MeshStandardMaterial({
      map: dirtMaps.map,
      normalMap: dirtMaps.normalMap,
      roughnessMap: dirtMaps.roughnessMap,
      normalScale: V2(0.26, 0.26),
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.75,
      dithering: true,
    });
    // Diagnostic isolation. Each of these switches exactly one channel off, so
    // "which map carries the repeat" is a measurement instead of a reading of
    // the source. Forcing two coupled things at once is NOTES.md case 23.
    if (TF.bumponly) {
      dirt.map = null;
      dirt.roughnessMap = null;
      dirt.color.setHex(0x808080);
      dirt.roughness = 0.95;
      dirt.needsUpdate = true;
    }
    if (TF.albedoonly) dirt.normalScale.set(0, 0);

    applyWorldDetail(dirt, {
      key: "dirt",
      macro,
      macroMetres: 78,
      // Under bumponly the macro albedo/roughness terms are the only other
      // world-space periodicity on this material, and leaving them in would
      // let a 78 m macro peak be read as a bump repeat.
      macroAlbedo: TF.bumponly ? 0 : 0.34,
      macroRoughness: TF.bumponly ? 0 : 0.1,
      specularEnv: 0.6,
      directSpec: 0.4,
      antiTile: TF.notile ? 0 : 0.85,
      normalFade: !TF.nofade,
      soil: {
        ...soilCommon,
        altMap: dirtFineMaps.map,
        altNormalMap: dirtFineMaps.normalMap,
        altRoughnessMap: dirtFineMaps.roughnessMap,
        altMetres: dirtFineMaps.tileMetres,
      },
    });

    const makePaintMaterial = (maps: ReturnType<typeof makePaint>, key: string) => {
      const m = new THREE.MeshStandardMaterial({
        map: maps.map,
        alphaMap: maps.alphaMap,
        roughnessMap: maps.roughnessMap,
        normalMap: maps.normalMap,
        normalScale: V2(0.5, 0.5),
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.55,
        transparent: true,
        alphaTest: 0.1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      });
      applyWorldDetail(m, {
        key,
        macro,
        macroMetres: 17,
        macroAlbedo: 0.3,
        macroRoughness: 0.1,
        specularEnv: 0.5,
        directSpec: 0.55,
        ...overlayCommon,
        ...washCommon,
        // The stripe sits on the asphalt it was rolled onto, so give it that
        // surface's relief: paint floods the voids and skips the proud stones.
        voidMap: asphaltMaps.heightMap,
        voidMetres: asphaltMaps.tileMetres,
        // Grit blown over a stripe hides it as effectively as wear does.
        washGain: 0.45,
        overlayGain: 0.55,
        overlayTint: new THREE.Color(0x191512),
        erodeAlpha: FORCE.noErode ? 0 : 1.0,
        wheelPaths: WHEELS,
        wheelBand: [-ROAD.halfPaved, ROAD.halfPaved],
        wheelStrength: 0.35,
      });
      return m;
    };
    const whitePaint = makePaintMaterial(paintWhite, "paint-white");
    const yellowPaint = makePaintMaterial(paintYellow, "paint-yellow");

    if (FORCE.paintViz) {
      // Visibility probe: unmissable self-lit slabs with every alpha path
      // disabled, so "not drawing at all" and "eroded to nothing" look different.
      for (const [mm, hex] of [
        [whitePaint, 0xff00ff],
        [yellowPaint, 0x00ffff],
      ] as const) {
        mm.color.set(0x000000);
        mm.emissive = new THREE.Color(hex);
        mm.emissiveIntensity = 4;
        mm.alphaMap = null;
        mm.alphaTest = 0;
        mm.transparent = false;
        mm.depthWrite = true;
        mm.needsUpdate = true;
      }
    }

    // Sits at the bottom of the saw cuts: never swept, packed with grit. It is
    // deliberately not black - a saw cut full of years of dust and grit reads
    // grey-brown, and painting it black made every joint a hard vector line
    // that stayed just as black at the horizon as at the camera.
    const jointFiller = new THREE.MeshStandardMaterial({
      map: concreteMaps.map,
      roughnessMap: concreteMaps.roughnessMap,
      color: 0x6b6156,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.42,
    });
    applyWorldDetail(jointFiller, {
      key: "joint-filler",
      macro,
      macroMetres: 13,
      macroAlbedo: 0.34,
      macroRoughness: 0.1,
      specularEnv: 0.4,
      directSpec: 0.35,
      ...overlayCommon,
      overlayGain: 0.8,
      overlayTint: new THREE.Color(0x15120f),
    });

    this.materials.push(asphalt, asphaltLot, concrete, concreteAo, dirt, whitePaint, yellowPaint, jointFiller);

    const dbg = new URLSearchParams(location.search);
    // ?flat=ov,nm,rg strips a detail layer at a time; ?hide=<mesh names> drops
    // whole meshes. Between them you can tell a texture problem from a geometry
    // problem in one screenshot instead of guessing.
    if (dbg.has("flat")) {
      const which = dbg.get("flat") ?? "";
      for (const mm of [asphalt, asphaltLot, concrete, concreteAo, whitePaint, yellowPaint, dirt]) {
        const orig = mm.onBeforeCompile.bind(mm);
        mm.onBeforeCompile = (shader, renderer) => {
          orig(shader, renderer);
          if (which.includes("ov") && shader.uniforms.uOverlayGain) shader.uniforms.uOverlayGain.value = 0;
          if (which.includes("nm")) mm.normalScale.set(0, 0);
          if (which.includes("rg")) shader.uniforms.uMacroRough.value = 0;
        };
        mm.needsUpdate = true;
      }
    }
    if (dbg.has("debugmat")) {
      asphalt.color.setHex(0xff0000);
      concrete.color.setHex(0x00ff00);
      concreteAo.color.setHex(0x00ffff);
      dirt.color.setHex(0x0000ff);
    }
    if (dbg.has("tex")) {
      const pick: Record<string, THREE.Texture> = {
        aa: asphaltMaps.map,
        an: asphaltMaps.normalMap,
        ar: asphaltMaps.roughnessMap,
        ca: concreteMaps.map,
        cn: concreteMaps.normalMap,
        da: dirtMaps.map,
        dn: dirtMaps.normalMap,
        ov: site.texture,
      };
      const t = pick[dbg.get("tex") ?? "aa"];
      const src = (t as THREE.DataTexture).image as { data?: Uint8Array; width: number; height: number };
      const cv = document.createElement("canvas");
      cv.width = src.width;
      cv.height = src.height;
      const c2 = cv.getContext("2d")!;
      if (src.data) {
        c2.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);
      } else {
        c2.drawImage(src as unknown as CanvasImageSource, 0, 0);
      }
      Object.assign(cv.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "900px",
        height: "900px",
        zIndex: "9999",
        imageRendering: "pixelated",
      });
      document.body.appendChild(cv);
    }

    const A = asphaltMaps.tileMetres;
    const C = concreteMaps.tileMetres;
    const D = dirtMaps.tileMetres;

    /* ---------------- native ground ---------------- */
    phase("ground mesh");
    // Graded rather than uniform. The player never leaves the lot and its
    // frontage, so a uniform 840 m grid was spending as many vertices on ground
    // 400 m away - four pixels tall, behind a haze - as on the twelve metres in
    // front of the camera. Packing them toward the site buys near-field relief
    // that can cast a shadow without giving up the far-field hummocks, which
    // need about five samples per 16 m cycle to survive.
    //
    // The focus is the pad centre. `halfX/halfZ` bound the region every
    // authored pose stands in or looks across; the density then ramps out over
    // 2.6x that distance, so there is no row of quads where the resolution
    // changes and nothing to see at the transition.
    const groundGeo = gridSurfaceGraded(-420, 420, -420, 420, 420, 420, dirtY, D, {
      x: 1,
      z: 20,
      halfX: 50,
      halfZ: 45,
      ratio: 5.5,
    });
    this.groundSpacing = groundGeo.userData.spacing as Record<string, number>;
    this.groundSurfaceAt = groundGeo.userData.surfaceAt as (x: number, z: number) => number;

    /**
     * `groundSurface(x, z) -> metres` — the height of the surface actually
     * rendered, as opposed to `groundHeight`, which is the field it was built
     * from. Anything sitting ON the ground wants this one.
     *
     * Published here rather than beside the other four services because those
     * run before any geometry exists and this cannot: the sampler is a closure
     * over the mesh's own vertex positions, which is the entire point of it. A
     * field can be published early; a fact about a mesh cannot.
     *
     * Units metres, absolute world Y, finite everywhere. Differs from
     * `groundHeight` by the mesh's chord error: 6.7 mm at p90 and 23.6 mm at p99
     * inside the near field, 1.1 mm at p90 outside 62 m where the shortest
     * height octave is gated off. Always greater than or equal to the field
     * where the field is concave, which is why placing on the field buries
     * things — and buries them only near the camera, which reads as a distance
     * cull rather than as a bug.
     *
     * The key contains "surface" deliberately: Car discovers it by pattern over
     * `serviceKeys()` rather than hard-coding a guess, and a hard-coded guess
     * that is wrong returns undefined forever while looking wired up.
     */
    game.provide("groundSurface", this.groundSurfaceAt);

    const ground = new THREE.Mesh(groundGeo, dirt);
    ground.receiveShadow = true;
    /**
     * The ground does not cast. That is now a decision, with a number behind it,
     * rather than the default it had been.
     *
     * Lighting's shadow-map viewer found that no terrain surface writes depth —
     * only vegetation, poles and structures — and asked whether that was
     * intended. The argument for casting is that the relief added this session is
     * real: a slope census at the mesh step puts 8.1% of the entrance tracks and
     * 12.1% of the frontage steeper than the solar tangent of 0.198, so there is
     * genuinely occluding geometry, and at this sun a crest throws a shadow five
     * times its own height.
     *
     * It stays off for two reasons that outweigh it.
     *
     * The relief that clears the tangent is 1.6% of the far field and clears it
     * by very little, so what it occludes is ground that Lambert has already
     * darkened — the same mechanism, measured earlier, that makes the far-field
     * banding falloff rather than cast shadow. The gain is largely double
     * counting.
     *
     * And the cost is not small: this is a single mesh of 352,800 triangles by
     * design, so it cannot be bounded to the near field without splitting it,
     * and splitting reintroduces the chord disagreement that grading it avoided.
     * Casting means rasterising all of it into every cascade at a moment when
     * the deliverable is a continuous run on an 8 GB card that has already
     * crashed a browser during generation.
     *
     * `?force=terraincast` turns it on for anyone who wants to price it. If the
     * near field ever gets a bounded caster, the honest way is a shadow-only
     * proxy sampling `userData.surfaceAt` so the shadow matches the surface that
     * is actually drawn.
     */
    ground.castShadow = TF.terraincast;
    ground.name = "ground";
    this.group.add(ground);

    /* ---------------- highway ---------------- */
    phase("paved surfaces");
    // The outermost row of vertices is pushed in and out along Z so the
    // pavement edge is not a ruled line. Combined with the dirt wash painted
    // into the overlay's alpha channel this is what kills the "cut-out sticker
    // lying on the desert" read.
    const roadGeo = gridSurface(-340, 340, -ROAD.halfPaved, ROAD.halfPaved, 1360, 26, roadSurface, A);
    ragEdge(roadGeo, "z", -ROAD.halfPaved, ROAD_EDGE.excursion, ROAD_EDGE.sag, ROAD_EDGE.seedMinus);
    ragEdge(roadGeo, "z", ROAD.halfPaved, ROAD_EDGE.excursion, ROAD_EDGE.sag, ROAD_EDGE.seedPlus);
    const road = new THREE.Mesh(roadGeo, asphalt);
    road.receiveShadow = true;
    road.name = "highway";
    this.group.add(road);

    /* ---------------- driveway aprons ---------------- */
    for (const d of DRIVEWAYS) {
      const g = gridSurface(d.minX, d.maxX, ROAD.halfPaved, PAD.minZ, 48, 20, drivewayY, A);
      ragEdge(g, "x", d.minX, 0.16, 0.009, 121);
      ragEdge(g, "x", d.maxX, 0.16, 0.009, 313);
      const apron = new THREE.Mesh(g, asphaltLot);
      apron.receiveShadow = true;
      this.group.add(apron);
    }

    /* ---------------- station pad ---------------- */
    const pad = new THREE.Mesh(
      gridSurface(PAD.minX, PAD.maxX, PAD.minZ, PAD.maxZ, 200, 130, padY, A),
      asphaltLot
    );
    pad.receiveShadow = true;
    pad.name = "lot";
    this.group.add(pad);

    /* ---------------- concrete forecourt: real jointed slabs ---------------- */
    phase("forecourt slabs");
    // 20 mm proud of the asphalt, with 55 mm saw cuts that read as actual
    // grooves rather than single-pixel hairlines.
    const slabTop = (x: number, z: number) => padY(x, z) + 0.021;
    const joint = 0.055;
    const cols = 6;
    const rows = 4;
    const slabW = (FORECOURT.maxX - FORECOURT.minX) / cols;
    const slabD = (FORECOURT.maxZ - FORECOURT.minZ) / rows;
    const slabGeos: THREE.BufferGeometry[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = FORECOURT.minX + c * slabW + joint * 0.5;
        const x1 = x0 + slabW - joint;
        const z0 = FORECOURT.minZ + r * slabD + joint * 0.5;
        const z1 = z0 + slabD - joint;
        slabGeos.push(gridSurface(x0, x1, z0, z1, 16, 16, slabTop, C));
      }
    }
    const slabs = new THREE.Mesh(mergeGeometries(slabGeos, false)!, concrete);
    slabs.receiveShadow = true;
    slabs.castShadow = true;
    slabs.name = "forecourt-slabs";
    this.group.add(slabs);
    slabGeos.forEach((g) => g.dispose());

    // Dirty fill sitting well down inside every joint. 14 mm below the slab
    // face, which at a 1.6 m eye height is enough to self-shadow.
    // Derived from slabTop, not from padY, and tessellated finer than the slabs
    // so it can never bulge through them between samples of the height field.
    const jointBed = new THREE.Mesh(
      gridSurface(
        FORECOURT.minX,
        FORECOURT.maxX,
        FORECOURT.minZ,
        FORECOURT.maxZ,
        150,
        96,
        (x, z) => slabTop(x, z) - 0.016,
        C
      ),
      jointFiller
    );
    jointBed.receiveShadow = true;
    jointBed.name = "joint-bed";
    this.group.add(jointBed);

    /* ---------------- pump islands ---------------- */
    phase("islands + curbs");
    const islandGeos: THREE.BufferGeometry[] = [];
    // Reversed, and the reversal is the fix for a real defect. `sweepProfile`
    // winds along the profile direction while `flip: true` negates the lateral
    // direction, and a mirror reverses handedness — so this sweep shipped with
    // 0 of 64 flank faces wound outward. Measured, not guessed: reversing the
    // profile takes it to 64 of 64 (`.shot-build/windcheck.mjs`). Back-face
    // culling made it invisible rather than wrong, which is why eight rounds of
    // captures never showed it. See the WINDING HAZARD note in `geo.ts`; the
    // shared fix is blocked on Canopy, which compensates the same way.
    const islandProfile = [V2(0, -0.09), V2(0, 0.128), V2(0.028, 0.158), V2(0.17, 0.162)].reverse();
    for (const isl of ISLANDS) {
      const hx = ISLAND.length / 2;
      const hz = ISLAND.width / 2;
      const path: THREE.Vector2[] = [];
      const step = 0.5;
      const pushEdge = (ax: number, az: number, bx: number, bz: number) => {
        const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
        for (let i = 0; i < n; i++) path.push(V2(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n));
      };
      pushEdge(isl.cx - hx, isl.cz - hz, isl.cx + hx, isl.cz - hz);
      pushEdge(isl.cx + hx, isl.cz - hz, isl.cx + hx, isl.cz + hz);
      pushEdge(isl.cx + hx, isl.cz + hz, isl.cx - hx, isl.cz + hz);
      pushEdge(isl.cx - hx, isl.cz + hz, isl.cx - hx, isl.cz - hz);

      islandGeos.push(
        sweepProfile(path, islandProfile, {
          closed: true,
          flip: true,
          heightAt: slabTop,
          uvMetres: C * 0.45,
          // Dark at the foot, dirty up the face, clean on the cap.
          ao: (h) => (FORCE.ao ? 0 : 0.52 + 0.33 * Math.min(1, Math.max(0, (h + 0.02) / 0.19))),
          chip: 1.4,
          seed: 4001 + isl.cz,
        })
      );
      islandGeos.push(
        solidColors(
          gridSurface(
            isl.cx - hx + 0.16,
            isl.cx + hx - 0.16,
            isl.cz - hz + 0.16,
            isl.cz + hz - 0.16,
            26,
            5,
            (x, z) => slabTop(x, z) + 0.162,
            C
          ),
          1
        )
      );
    }
    const islands = new THREE.Mesh(mergeGeometries(islandGeos, false)!, concreteAo);
    islands.castShadow = true;
    islands.receiveShadow = true;
    islands.name = "pump-islands";
    this.group.add(islands);
    islandGeos.forEach((g) => g.dispose());

    /* ---------------- curbs ---------------- */
    // Lateral is measured outward from the pavement edge.
    const curbProfile = [V2(0, -0.3), V2(0, 0.115), V2(0.026, 0.15), V2(0.165, 0.15), V2(0.165, -0.3)];
    const curbGeos: THREE.BufferGeometry[] = [];
    const curbRun = (x1: number, z1: number, x2: number, z2: number, flip = false) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.4) return;
      const n = Math.max(2, Math.round(len / 0.35));
      const path: THREE.Vector2[] = [];
      for (let i = 0; i <= n; i++) path.push(V2(x1 + ((x2 - x1) * i) / n, z1 + ((z2 - z1) * i) / n));
      // A curb run cannot just stop in mid-air. Where one ends at a driveway
      // opening the real detail is a transition: the section ramps down to
      // grade over about a metre so vehicles can cross it. Sinking the height
      // field at the ends gives exactly that, and removes the sliced-off block
      // faces that read as unfinished geometry.
      const TAPER = 1.1;
      const endDrop = (x: number, z: number) => {
        const d = Math.min(Math.hypot(x - x1, z - z1), Math.hypot(x - x2, z - z2));
        if (d >= TAPER) return 0;
        const t = d / TAPER;
        return -0.185 * (1 - t * t * (3 - 2 * t));
      };
      curbGeos.push(
        sweepProfile(path, curbProfile, {
          flip,
          heightAt: (x, z) =>
            padY(THREE.MathUtils.clamp(x, PAD.minX, PAD.maxX), THREE.MathUtils.clamp(z, PAD.minZ, PAD.maxZ)) +
            endDrop(x, z),
          uvMetres: C * 0.4,
          // Buried skirt and the first few centimetres above grade are almost
          // black; the gutter face stays dirty; only the top is clean-ish.
          ao: (h) => (FORCE.ao ? 0 : h < -0.02 ? 0.28 : 0.4 + 0.26 * Math.min(1, (h + 0.02) / 0.2)),
          chip: 2.2,
          seed: 7331 + x1 * 3 + z1 * 7,
        })
      );
    };

    // Front curb, broken by the two driveway openings.
    const gaps = [...DRIVEWAYS].sort((a, b) => a.minX - b.minX);
    let cursor = PAD.minX;
    for (const g of gaps) {
      curbRun(cursor, PAD.minZ, g.minX, PAD.minZ);
      cursor = g.maxX;
    }
    curbRun(cursor, PAD.minZ, PAD.maxX, PAD.minZ);
    // Sides and back, wound so the profile always points away from the pavement.
    curbRun(PAD.maxX, PAD.minZ, PAD.maxX, PAD.maxZ);
    curbRun(PAD.minX, PAD.maxZ, PAD.minX, PAD.minZ);
    curbRun(PAD.maxX, PAD.maxZ, PAD.minX, PAD.maxZ);

    const curbs = new THREE.Mesh(mergeGeometries(curbGeos, false)!, concreteAo);
    curbs.castShadow = true;
    curbs.receiveShadow = true;
    curbs.name = "curbs";
    this.group.add(curbs);
    curbGeos.forEach((g) => g.dispose());

    /* ---------------- debris, placed by the accumulation service ---------------- */
    phase("debris scatter");
    this.scatterDebris(accum, this.groundSurfaceAt);

    /* ---------------- painted markings ---------------- */
    phase("painted markings");
    const LIFT = 0.0045;
    const whiteGeos: THREE.BufferGeometry[] = [];
    const yellowGeos: THREE.BufferGeometry[] = [];

    // MUTCD double yellow: two 4 in lines with a 4 in gap, i.e. 8 in between
    // centres. Anything tighter merges into one stroke by 30 m out.
    const halfGap = 0.104;
    for (const off of [-halfGap, halfGap]) {
      yellowGeos.push(stripeGeometry(-300, off, 300, off, ROAD.paintWidth, roadSurface, LIFT, 0.5));
    }
    const edgeZ = ROAD.laneWidth - ROAD.paintWidth / 2;
    for (const off of [-edgeZ, edgeZ]) {
      whiteGeos.push(stripeGeometry(-300, off, 300, off, ROAD.paintWidth, roadSurface, LIFT, 0.5));
    }

    // Stop bar at the head of each driveway.
    for (const d of DRIVEWAYS) {
      const z = PAD.minZ - 1.1;
      whiteGeos.push(
        stripeGeometry(d.minX + 0.9, z, d.maxX - 0.9, z, 0.4, (x, zz) => drivewayY(x, zz), LIFT, 0.5)
      );
    }

    // Parking stalls.
    for (let i = 0; i <= PARKING.count; i++) {
      const x = PARKING.originX + i * PARKING.stallWidth;
      whiteGeos.push(stripeGeometry(x, PARKING.z0, x, PARKING.z0 + PARKING.depth, 0.1, padY, LIFT, 0.55));
    }
    whiteGeos.push(
      stripeGeometry(
        PARKING.originX,
        PARKING.z0 + PARKING.depth,
        PARKING.originX + PARKING.count * PARKING.stallWidth,
        PARKING.z0 + PARKING.depth,
        0.1,
        padY,
        LIFT,
        0.55
      )
    );

    // Hatched no-parking zone at the ends of the islands.
    for (const isl of ISLANDS) {
      for (const side of [-1, 1]) {
        const bx = isl.cx + side * (ISLAND.length / 2 + 0.35);
        for (let i = 0; i < 4; i++) {
          const t = i * 0.55;
          yellowGeos.push(
            stripeGeometry(
              bx + side * t,
              isl.cz - 1.0,
              bx + side * (t + 0.9),
              isl.cz + 1.0,
              0.09,
              (x, z) => padY(x, z) + 0.021,
              LIFT,
              0.6
            )
          );
        }
      }
    }

    const whiteMesh = new THREE.Mesh(mergeGeometries(whiteGeos, false)!, whitePaint);
    whiteMesh.receiveShadow = true;
    whiteMesh.name = "paint-white";
    this.group.add(whiteMesh);
    whiteGeos.forEach((g) => g.dispose());

    const yellowMesh = new THREE.Mesh(mergeGeometries(yellowGeos, false)!, yellowPaint);
    yellowMesh.receiveShadow = true;
    yellowMesh.name = "paint-yellow";
    this.group.add(yellowMesh);
    yellowGeos.forEach((g) => g.dispose());

    if (dbg.has("hide")) {
      const names = (dbg.get("hide") ?? "").split(",");
      this.group.traverse((o) => {
        if (names.includes(o.name)) o.visible = false;
      });
    }

    // A harness cannot tell "the terrain built nothing" from "the terrain is
    // there and looks wrong" without this. Counts, not booleans: a system that
    // reports `ok: true` having merged zero geometries is case 8 again.
    let meshes = 0;
    let tris = 0;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      meshes++;
      const idx = m.geometry.getIndex();
      tris += (idx ? idx.count : m.geometry.getAttribute("position").count) / 3;
    });
    // Texture bytes, not texture count. A count says nothing about footprint
    // (NOTES.md "A count is not a size, and `renderer.info` reports counts"),
    // and the ground covers the whole scene so this system is a plausible
    // suspect whenever memory grows. Every texture is walked from the material
    // slots and de-duplicated by identity, because the same map is bound to
    // several materials and counting it per-material would treble the answer.
    // Mipmaps add a third; a texture with `generateMipmaps` off does not pay it.
    // Two sets, because "how many objects" and "how much memory" are different
    // questions here and answering both with one set gave the wrong number.
    // `ownedTextures` must hold every Texture, because dispose() walks it. The
    // byte count must key on `texture.source`, because that is what the
    // renderer keys its GPU upload on: the lot's asphalt maps are `clone()`s of
    // the highway's, which makes them distinct Textures sharing one image, one
    // upload and one allocation. Keying the bytes on the Texture counted that
    // upload twice and reported ~67 MB of asphalt that does not exist. A
    // measurement handed to another agent as grounds for a change has to be
    // right or it is worse than no measurement.
    const seen = this.ownedTextures;
    const sources = new Set<string>();
    let texBytes = 0;
    const SLOTS = ["map", "normalMap", "roughnessMap", "alphaMap", "aoMap", "bumpMap"] as const;
    for (const m of this.materials) {
      const mm = m as unknown as Record<string, THREE.Texture | null>;
      for (const slot of SLOTS) {
        const t = mm[slot];
        if (!t) continue;
        seen.add(t);
        const img = t.image as { width?: number; height?: number } | undefined;
        if (!img?.width || !img?.height) continue;
        if (sources.has(t.source.uuid)) continue;
        sources.add(t.source.uuid);
        texBytes += img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
      }
    }

    // The injected fields, from references held at creation rather than from
    // `userData.shader`, which does not exist until the first render.
    for (const t of this.fieldTextures) {
      if (!t?.image) continue;
      seen.add(t);
      const img = t.image as { width?: number; height?: number };
      if (!img.width || !img.height) continue;
      if (sources.has(t.source.uuid)) continue;
      sources.add(t.source.uuid);
      texBytes += img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
    }

    (window as unknown as { __TERRAIN?: unknown }).__TERRAIN = {
      meshes,
      triangles: Math.round(tris),
      materials: this.materials.length,
      textures: seen.size,
      uploads: sources.size,
      groundSpacing: this.groundSpacing,
      debris: this.debrisCounts,
      textureMB: Math.round((texBytes / 1048576) * 10) / 10,
      renderTargets: 0,
      tforce: Object.entries(TF)
        .filter(([, v]) => v)
        .map(([k]) => k),
    };

    scene.add(this.group);
    phase.end();
  }

  /**
   * Gravel spill and wind-blown litter, positioned entirely by `groundAccum`.
   *
   * This exists as much to prove the service as to fill the frame. Four
   * systems are about to code against those functions, and the only honest way
   * to hand them over is to have consumed them here first: every rejection
   * test below is a call a consumer will make, and if the distribution came out
   * wrong it comes out wrong in this system's own pixels before it comes out
   * wrong in anybody else's.
   *
   * Rejection sampling rather than an authored list, because the whole point of
   * the service is that placement follows a field. Candidates are drawn along
   * the pavement edges - which is where a real lot's gravel is, since the spill
   * comes off the pavement and the wind rolls it to the first thing that stops
   * it - and over the open ground at a much lower rate.
   */
  private scatterDebris(accum: GroundAccum, surfaceAt: (x: number, z: number) => number): void {
    const rng = makeRng(20260829);
    const TF = readTForce();

    /* ---- gravel: half-buried stones, densest at the edges ---- */
    // Icosahedron at subdivision 0 is 20 triangles, which for something 40 mm
    // across seen from 1.6 m is already more than it needs. Non-uniform scale
    // per instance does the shape variation that geometry would otherwise buy.
    const stoneGeo = new THREE.IcosahedronGeometry(1, 0);
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x8a7f70,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
      dithering: true,
    });
    this.materials.push(stoneMat);
    // Per-vertex tone so a field of stones is not one colour at two sizes.
    const sc = new Float32Array(stoneGeo.getAttribute("position").count * 3);
    for (let i = 0; i < sc.length; i += 3) {
      const v = 0.72 + rng() * 0.5;
      sc[i] = v;
      sc[i + 1] = v * (0.96 + rng() * 0.07);
      sc[i + 2] = v * (0.88 + rng() * 0.08);
    }
    stoneGeo.setAttribute("color", new THREE.BufferAttribute(sc, 3));

    /**
     * 1500 -> 9000, and the count is not the point; the DISTRIBUTION was.
     *
     * The old scatter spread a third of its candidates over 145 x 105 m of open
     * ground and two thirds along 600 m of road edge, which works out at about
     * 0.03 stones per square metre in the open. At three metres from the eye a
     * whole square metre of ground held one stone three per cent of the time,
     * so the near field had no geometric detail in it at all and the ground
     * read as a texture on a plane.
     *
     * This matters more than any further work on the dirt normal map. A tiling
     * normal map viewed at two to four metres, on a surface that is flat
     * between vertices 0.63 m apart, has no parallax and no silhouette — it
     * cannot read as ground whatever its spectrum. The 0.2-1.3 m band it would
     * need is also below the graded mesh's Nyquist limit there. Scattered
     * geometry is the only thing that works in that band, and at a 6.4 degree
     * sun each 40 mm stone throws a shadow several times its own length, so the
     * read per triangle is unusually good.
     *
     * Cost is reported by `__TERRAIN.triangles` rather than estimated here.
     */
    const STONES = TF.thindebris ? 9000 : 24000;
    const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, STONES);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let placed = 0;
    let tries = 0;
    let clumpX = 0;
    let clumpZ = 0;
    let clumpLeft = 0;
    while (placed < STONES && tries < STONES * 40) {
      tries++;
      // Two thirds of the candidates hug a pavement edge, a third are open
      // ground. Both go through the same acceptance test.
      let x: number;
      let z: number;
      const roll = rng();
      if (roll < 0.55 && clumpLeft > 0) {
        /**
         * CLUMPED. Once a clump centre is accepted, the next several stones go
         * within half a metre of it.
         *
         * This is worth more than raising the count, and the arithmetic is why.
         * Spread evenly, 4000 stones over the 6500 m2 of dirt inside the near
         * disc is 0.6 per square metre: at three metres from the eye that is
         * two or three stones in frame, which reads as a sprinkle of debris
         * rather than as ground made of gravel. The same 4000 in clumps of a
         * dozen gives 330 patches that each read clearly, with bare compacted
         * soil between them — which is also what gravel spill looks like,
         * since it arrives from somewhere and stays where it lands.
         */
        clumpLeft--;
        x = clumpX + (rng() - 0.5) * 0.62;
        z = clumpZ + (rng() - 0.5) * 0.62;
      } else if (roll < 0.55) {
        /**
         * NEAR FIELD clump centre. A disc about the site centre, square-root
         * biased so it spreads by area rather than piling up at the middle.
         *
         * Radius 80, arrived at by getting it wrong twice in opposite
         * directions, which is worth recording because the second mistake is
         * the less obvious one.
         *
         * At 52 the disc covered the lot and its immediate surround, which was
         * the stated intent — scope it to what the camera can reach — and it
         * was wrong, because `verge` stands at x = -74 and is one of the eight
         * poses. Its whole foreground fell outside. **The reachable area is
         * defined by where the cameras are, not by where the buildings are**,
         * and I had quietly substituted the second for the first.
         *
         * Then widening to 88 tripled the area and so **divided the density by
         * three, cancelling the count increase that was the entire point.** A
         * scatter has a count and an extent and only their ratio is visible;
         * raising one while raising the other is a change that measures as
         * progress and renders as nothing. The number that decides this is
         * clumps per square metre of near view, not stones.
         *
         * At 80 with 24000 stones that is about 0.9 per square metre and one
         * clump per 10 m2, so roughly three clumps in the 30 m2 a walking
         * camera has in front of it. `?force=thindebris` returns the 9000 arm.
         */
        const a = rng() * Math.PI * 2;
        const r = 3 + Math.sqrt(rng()) * 80;
        x = 1 + Math.cos(a) * r;
        z = 20 + Math.sin(a) * r * 0.86;
        clumpX = x;
        clumpZ = z;
        clumpLeft = 6 + Math.floor(rng() * 12);
      } else if (roll < 0.82) {
        const edge = rng();
        const out = 0.05 + Math.pow(rng(), 1.7) * 1.5;
        if (edge < 0.5) {
          x = -300 + rng() * 600;
          z = (rng() < 0.5 ? -1 : 1) * (ROAD.halfPaved + out);
        } else if (edge < 0.78) {
          x = PAD.minX + rng() * (PAD.maxX - PAD.minX);
          z = rng() < 0.5 ? PAD.minZ - out : PAD.maxZ + out;
        } else {
          x = rng() < 0.5 ? PAD.minX - out : PAD.maxX + out;
          z = PAD.minZ + rng() * (PAD.maxZ - PAD.minZ);
        }
      } else {
        x = -70 + rng() * 145;
        z = -30 + rng() * 105;
      }

      /**
       * Two rejections, and the order matters for cost: the cheap geometric one
       * first, the field lookup second.
       *
       * Loose gravel does not sit on a swept forecourt, so anything within
       * 120 mm of a hard surface is out. `pavedDistance` is conservative on the
       * highway verge by up to the edge excursion, which is the right direction
       * to be wrong: a stone floating on asphalt is a visible defect and a
       * 200 mm bare strip is not.
       */
      if (pavedDistance(x, z) < 0.12) continue;

      // The service decides the rest. `fines` already folds in shelter, traffic
      // and scour, so this is one call and no local rules. Its p50 is 0.147 and
      // its p95 0.68, so a bare comparison against a uniform deviate keeps the
      // clumping the field already carries rather than flattening it.
      if (rng() > accum.fines(x, z) * 0.9) continue;

      const size = 0.014 + Math.pow(rng(), 2.0) * 0.062;
      /**
       * Sunk by 0.18 of the radius, not 0.42.
       *
       * This, and not the count, is why raising 1500 to 24000 stones put nothing
       * in the near foreground. The flattened y scale below is 0.45 to 0.8 of
       * the radius, so at a sink of 0.42 a stone stood 0.03 to 0.38 radii proud
       * — a median of about 4 mm for a 20 mm stone, which at a metre and a half
       * from the eye is two pixels. Every stone was present, correctly placed,
       * correctly lit, and buried. The only ones that read were the largest few
       * per cent, which is exactly the sparse-sprinkle look the density work was
       * meant to remove.
       *
       * **A scatter has a count, an extent and a protrusion, and only the last
       * one is what the eye receives.** Two rounds went into the first two.
       */
      p.set(x, surfaceAt(x, z) - size * 0.18, z);
      e.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      q.setFromEuler(e);
      // Flattened, because a stone that has been rolled and settled lies down.
      s.set(size * (0.8 + rng() * 0.5), size * (0.45 + rng() * 0.35), size * (0.8 + rng() * 0.5));
      stones.setMatrixAt(placed, m.compose(p, q, s));
      placed++;
    }
    stones.count = placed;
    stones.instanceMatrix.needsUpdate = true;
    stones.castShadow = true;
    stones.receiveShadow = true;
    stones.name = "gravel-spill";
    this.group.add(stones);

    /* ---- litter: paper, in drifts, from the density the service reports ---- */
    // A bent card rather than a flat one: flat paper on the ground is invisible
    // at a low sun because it has no face turned toward the light, which is the
    // slope-versus-solar-tangent argument again at 100 mm.
    const litterGeo = new THREE.BufferGeometry();
    litterGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        // prettier-ignore
        new Float32Array([
          -0.5, 0.0, -0.5,   0.5, 0.0, -0.42,   0.5, 0.30, 0.1,   -0.5, 0.26, 0.06,
          -0.5, 0.26, 0.06,  0.5, 0.30, 0.1,    0.44, 0.02, 0.5,  -0.46, 0.0, 0.46,
        ]),
        3
      )
    );
    litterGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    litterGeo.computeVertexNormals();
    const litterMat = new THREE.MeshStandardMaterial({
      color: 0xb9b2a4,
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      dithering: true,
    });
    this.materials.push(litterMat);

    // Sampled as a density on a grid rather than by rejection, because
    // `litter` returns items per square metre and the honest way to consume
    // that is to multiply by a cell area. A consumer doing the same thing at a
    // different cell size gets the same expected count, which is the property
    // that makes the units worth having.
    const CELL = 1.5;
    const area = CELL * CELL;
    const items: { x: number; z: number }[] = [];
    for (let z = -34; z < 60; z += CELL) {
      for (let x = -60; x < 62; x += CELL) {
        const jx = x + accum.jitter(x, z, 11) * CELL;
        const jz = z + accum.jitter(x, z, 27) * CELL;
        if (accum.jitter(jx, jz, 3) < accum.litter(jx, jz) * area) items.push({ x: jx, z: jz });
      }
    }
    const litter = new THREE.InstancedMesh(litterGeo, litterMat, Math.max(1, items.length));
    items.forEach((it, i) => {
      const size = 0.09 + accum.jitter(it.x, it.z, 5) * 0.13;
      p.set(it.x, surfaceAt(it.x, it.z) + 0.002, it.z);
      e.set(
        (accum.jitter(it.x, it.z, 7) - 0.5) * 0.5,
        accum.jitter(it.x, it.z, 9) * Math.PI * 2,
        (accum.jitter(it.x, it.z, 13) - 0.5) * 0.5
      );
      q.setFromEuler(e);
      s.set(size, size * (0.6 + accum.jitter(it.x, it.z, 17) * 0.7), size);
      litter.setMatrixAt(i, m.compose(p, q, s));
    });
    litter.count = items.length;
    litter.instanceMatrix.needsUpdate = true;
    litter.castShadow = true;
    litter.receiveShadow = true;
    litter.name = "litter";
    this.group.add(litter);

    this.debrisCounts = { gravel: placed, gravelTries: tries, litter: items.length };
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.surfaces.forEach((s) => {
      s.map.dispose();
      s.normalMap.dispose();
      s.roughnessMap.dispose();
    });
    // Catches the world-space fields the loop above cannot reach; disposing a
    // texture twice is a no-op in three, so the overlap with `surfaces` is
    // harmless and keeping both is deliberate - `surfaces` is the contract,
    // this is the safety net for anything bound through the uniform table.
    this.ownedTextures.forEach((t) => t.dispose());
    this.ownedTextures.clear();
  }
}
