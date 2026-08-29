import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types";
import type { Rect } from "../core/collision";
import {
  applyGrime,
  forceGrime,
  makeCabinetSteel,
  makeGrimeField,
  mergeChecked,
  setHsAnisotropy,
} from "../gen/hardsurface";
import {
  CANOPY,
  buildColumn,
  buildFascia,
  buildFasciaStripe,
  buildFixtures,
  buildOverflowStains,
  buildRoof,
  buildScuppers,
  buildSignCabinets,
  buildSignFaces,
  buildSoffit,
  canopyLevels,
  fixturePlan,
  islandTop,
  makeLensMap,
  makeSoffitLampMap,
  makeSoffitLightmap,
  scupperPlan,
  signPlan,
  type CanopyLevels,
  type Scupper,
} from "../gen/canopyParts";
import { makeContactShadow } from "../gen/contactShadow";
import { TYPE, makeCanopySignAtlas, makeOverflowStain } from "../gen/canopySignage";

/* ------------------------------------------------------------------ */
/* public contract                                                     */
/* ------------------------------------------------------------------ */

/** One soffit fixture, published so Lighting can put a real luminaire here. */
export interface CanopyFixtureHandle {
  readonly name: string;
  /** Centre of the lens, world space. Where a light should sit. */
  readonly position: THREE.Vector3;
  /** Unit outward normal of the lens. Straight down. */
  readonly normal: THREE.Vector3;
  /** Lens dimensions in metres, for a RectAreaLight that matches it. */
  readonly width: number;
  readonly depth: number;
  /** Colour the lens is emitting, so a light placed here can agree with it. */
  readonly colour: THREE.Color;
}

export interface CanopyService {
  readonly root: THREE.Group;
  /** Outer face of the fascia, world XZ. */
  readonly deck: Rect;
  /** World Y of the soffit plane, the top of the coping, and the drip lip. */
  readonly soffitY: number;
  readonly copingY: number;
  readonly dripY: number;
  /** Clear height under the soffit above the slab at the datum. */
  readonly clearHeight: number;
  /** Column axes and half-width, world XZ. */
  readonly columns: { x: number; z: number; half: number }[];
  readonly fixtures: CanopyFixtureHandle[];
  /** Are the canopy lights on? Lighting owns this decision. */
  fixturesOn(): boolean;
  /**
   * Turn the lens emission on or off, and optionally set its strength. Provided
   * so Lighting can match the lenses to whatever it decides about real
   * luminaires rather than having two systems assert different things about the
   * same fixture.
   */
  setFixtures(on: boolean, emissiveIntensity?: number): void;
  /** The lens material, if Lighting would rather drive it directly. */
  readonly lensMaterial: THREE.MeshStandardMaterial;
  /** Authored albedo of the soffit, for anyone reasoning about the bounce. */
  readonly soffitColour: THREE.Color;

  /**
   * Strength of the soffit's baked lamp irradiance.
   *
   * FOR LIGHTING. The soffit faces down, so no sun reaches it at any elevation
   * and the environment's lower hemisphere is nearly black; measured, it came
   * out at luma 27.9 over 40% of the frame, darker than the highway it stands
   * over. This bake is what stands in for the eight fixtures being on, and it
   * adds no lights to a scene that already has 21.
   *
   * If Lighting would rather hang real luminaires here, call this with 0 and
   * the bake disappears with no geometry change. Its occlusion and soot are
   * baked into the same map, so expect to lose those too and to want a little
   * ambient occlusion of your own.
   */
  setLightmapIntensity(v: number): void;
  lightmapIntensity(): number;
  /**
   * The lamps' baked bounce on the soffit, which is a separate control from the
   * sky bake above because the two scale differently — the bake tracks
   * `scene.environmentIntensity` and this does not. Zero this and keep the bake
   * if real luminaires go in here.
   */
  setLampBounce(v: number): void;
  lampBounce(): number;
}

/* ------------------------------------------------------------------ */

const KNOWN_FLAGS = ["nogrime", "lightsoff", "lightson", "noshade", "nolightmap"] as const;

/**
 * Strength of the baked soffit irradiance, and the environment intensity it was
 * calibrated against.
 *
 * THE BAKE IS COUPLED TO `scene.environmentIntensity` ON PURPOSE, and the
 * measurement that forced it is worth keeping. When Lighting moved the
 * environment from 1.0 to 2.4, `tools/probe-rank.mjs` reported:
 *
 *     forecourt slabs   30.8 -> 45.9   x1.49
 *     highway           28.2 -> 42.0   x1.49
 *     canopy columns   111.7 -> 135.6  x1.21
 *     canopy soffit    139.2 -> 148.3  x1.07   <-- barely moved
 *     fixture lenses   219.4 -> 220.6  x1.00   <-- emissive, correctly fixed
 *
 * A `lightMap` is added to irradiance directly and nothing scales it, so the
 * soffit was the only surface in the frame that did not respond to a global
 * lighting change. That is a defect even though every individual frame looked
 * right: the thing this bake *represents* is sky and sunlit-slab bounce, which
 * is an environment quantity Lighting owns, so it has to move when Lighting
 * moves it. Otherwise the soffit's rank drifts every time the environment is
 * retuned — it was 4.5x the slab at env 1.0 and 3.2x at env 2.4 — and somebody
 * eventually recalibrates a bake that was never wrong.
 *
 * This is the mirror of NOTES case 40. There, a value was silently overwritten
 * by the system that owned it; here, a value that *should* have been owned by
 * another system was silently independent of it. Both produce a plausible frame.
 *
 * One documented approximation: the lamp collar term is baked into the same map
 * and therefore also scales with the environment, which is wrong — lamps do not
 * dim when the sky brightens. It is accepted because the collar is confined to
 * roughly 200 mm around each of eight housings and is a negligible fraction of
 * a 13.2 x 13.6 m deck, while splitting it out would cost a second 384-square
 * map and a second UV-channel binding. The element that actually carries "the
 * lamps are on" is the lens emissive, which is correctly independent of this.
 *
 * `?clm=<n>` overrides the result absolutely, bypassing the coupling, so the
 * level can still be swept against a ranking run without a rebuild.
 */
const LIGHTMAP_AT_REFERENCE = 1.45;
const LIGHTMAP_ENV_REFERENCE = 2.4;

/**
 * The forecourt canopy.
 *
 * ## What this system does not own
 *
 * **No lights.** Not one `THREE.Light` is created here. The scene already
 * carries 21, ten of them `RectAreaLight`s, and at dawn whether a station's
 * canopy lights are still burning is a lighting decision, not a geometry one.
 * The fixtures are built, positioned and published as `canopy.fixtures` with
 * their lens size, normal and colour, so Lighting can drop a matching
 * luminaire on each one; the lens emission defaults on at a level that reads as
 * "still on at dawn" and can be turned off in one call.
 *
 * **No shadow or sun configuration.** `castShadow` is set on the three meshes
 * that should occlude the sun and nothing else is touched.
 *
 * ## What Lighting needs to know
 *
 * At this sun — 11 degrees elevation, azimuth 203 degrees — the deck's shadow
 * does **not** land under the deck. Light rakes in beneath the drip line from
 * the west-south-west and takes about 23 m of horizontal run to reach the
 * ground, so the whole forecourt under the canopy stays sunlit and the shadow
 * of a 5.99 m deck lands roughly 26 m downsun, across the parking stalls. Two
 * consequences:
 *
 *  - The soffit receives **no direct sun at any elevation**, because sunlight
 *    travels downward and the soffit faces down. Everything it shows comes from
 *    the environment's lower hemisphere and the hemisphere fill, and the lower
 *    hemisphere is currently one constant colour with standard deviation 0.0.
 *    This system therefore bakes its own occlusion into the soffit's vertex
 *    colours; when the world capture lands, that bake becomes a supplement to
 *    real structure rather than the only structure.
 *  - The scene gained a large new shadow caster whose shadow falls a long way
 *    from the caster. If the shadow frustum is ever fitted more tightly than
 *    `casterDepth` allows, this is the object that will lose its shadow first.
 */
export class CanopySystem implements GameSystem {
  readonly name = "canopy";

  private group = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private lensMat!: THREE.MeshStandardMaterial;
  private lensOn = true;
  private lensLevel = 1.35;
  private soffitMat!: THREE.MeshStandardMaterial;
  private lightmapLevel = LIGHTMAP_AT_REFERENCE;
  private envIntensity = LIGHTMAP_ENV_REFERENCE;
  /**
   * Strength of the lamps' bounce on the soffit. Deliberately **not** scaled by
   * the environment, unlike `lightmapLevel` — that difference is the whole
   * night-to-dawn mechanism, so it is a separate field rather than a factor.
   */
  private lampBounce = 0.9;

  init(ctx: SystemContext): void {
    const { scene, game, renderer } = ctx;
    setHsAnisotropy(renderer.capabilities.getMaxAnisotropy());

    const q = new URLSearchParams(location.search);
    const raw = (q.get("cforce") ?? "").split(",").filter(Boolean);
    const unknown = raw.filter((k) => !(KNOWN_FLAGS as readonly string[]).includes(k));
    if (unknown.length) {
      // NOTES case 25: a token nothing consumes returns a byte-identical
      // capture, which reads as "the feature is not mine" and is fiction.
      throw new Error(`canopy: unknown ?cforce= token(s): ${unknown.join(", ")}. Known: ${KNOWN_FLAGS.join(", ")}`);
    }
    const force = {
      nogrime: raw.includes("nogrime"),
      lightsOff: raw.includes("lightsoff"),
      lightsOn: raw.includes("lightson"),
      noShade: raw.includes("noshade"),
      nolightmap: raw.includes("nolightmap"),
    };

    // Lighting is registered ahead of this system and has already written
    // `scene.environmentIntensity`, so this reads the live value rather than a
    // copy of Lighting's default — which is the point, since a copy would go
    // stale the next time that default moves and nothing would say so.
    const env = scene.environmentIntensity;
    if (!Number.isFinite(env) || env < 0) {
      throw new Error(`canopy: scene.environmentIntensity is ${env}; the soffit bake is scaled by it and cannot proceed`);
    }
    this.envIntensity = env;
    this.lightmapLevel = (LIGHTMAP_AT_REFERENCE * env) / LIGHTMAP_ENV_REFERENCE;

    const clm = q.get("clm");
    if (clm !== null) {
      const v = Number(clm);
      if (!Number.isFinite(v) || v < 0) throw new Error(`canopy: ?clm= must be a non-negative number, got "${clm}"`);
      this.lightmapLevel = v;
    }

    const lv = canopyLevels();
    this.group.name = "canopy";

    /* ---------------- shared maps ---------------- */
    const grime = makeGrimeField(512, 8807);
    // 0.20 m tile: `featureFreq` refuses anything larger at 512 because the
    // orange peel would alias into the per-texel stipple that a critic once
    // called "sprayed concrete" on the dispensers. The soffit displays it at a
    // coarser 0.46 m so a 13 m plane is not 65 visible repeats.
    const steel = makeCabinetSteel(512, 0.2, 8811);
    this.textures.push(grime, steel.normalMap, steel.roughnessMap);

    const perMetre = (t: THREE.Texture, tileMetres: number) => {
      const c = t.clone();
      c.needsUpdate = true;
      c.repeat.setScalar(1 / tileMetres);
      this.textures.push(c);
      return c;
    };
    const fineN = perMetre(steel.normalMap, 0.2);
    const fineR = perMetre(steel.roughnessMap, 0.2);
    const wideN = perMetre(steel.normalMap, 0.46);
    const wideR = perMetre(steel.roughnessMap, 0.46);

    const lensMap = makeLensMap();
    this.textures.push(lensMap);

    /*
     * The fixture plan is resolved here, before the materials, because the
     * soffit's baked irradiance is generated from it. The bake and the geometry
     * therefore cannot disagree about where the lamps are: there is one list.
     */
    const plan = fixturePlan();
    const shadeInput = {
      columns: CANOPY.columns.map((c) => ({ x: c.x, z: c.z })),
      fixtures: plan.map((f) => ({ x: f.x, z: f.z })),
    };
    const soffitLightmap = makeSoffitLightmap(shadeInput);
    this.textures.push(soffitLightmap);
    const soffitLampMap = makeSoffitLampMap(shadeInput);
    this.textures.push(soffitLampMap);

    const track = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };

    /* ---------------- materials ---------------- */

    /**
     * The soffit. High albedo on purpose: it is lit only by bounce off the
     * sunlit slab below it, so reflectance is the only lever this system has
     * over how much of that bounce comes back. A "realistically grubby" dark
     * soffit under a flat environment is a black ceiling, which is the failure
     * mode, not the goal — the grubbiness belongs in the pattern, not the level.
     */
    const soffitColour = new THREE.Color(0xdad6ca);
    const soffitMat = track(
      new THREE.MeshStandardMaterial({
        color: soffitColour.clone(),
        roughness: 0.62,
        metalness: 0.05,
        normalMap: wideN,
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: wideR,
        vertexColors: !force.noShade,
        envMapIntensity: 1.0,
        dithering: true,
        lightMap: force.nolightmap ? null : soffitLightmap,
        lightMapIntensity: this.lightmapLevel,
        // The lamps' contribution to this panel, kept out of the lightMap
        // because that one is scaled by the environment and this one must not
        // be. See `makeSoffitLampMap`. `channel = 1` puts it on `uv1`, the same
        // normalised deck coordinates the bake uses — the default is `uv`,
        // which on this mesh is a *per-metre tiling* set, so leaving it alone
        // would repeat eight lamp collars across every 1 m square of a 13 m
        // deck. That would look like a texture error and would in fact be a
        // channel error.
        emissive: new THREE.Color(0xffffff),
        emissiveMap: force.nolightmap ? null : soffitLampMap,
        emissiveIntensity: this.lensOn ? this.lampBounce : 0,
      })
    );
    applyGrime(soffitMat, {
      key: "canopy-soffit",
      field: grime,
      // Large tile: the soffit is 13 m across and grime on it is weather, not
      // texture. A small tile here is the "even wash" failure at scale.
      scale: 3.1,
      // Stronger than it first looked like it should be. Grime authored against
      // the unlit soffit read as nothing once the bake brought the panel up to
      // luma 170 — a film legible on a dark surface is invisible on a bright
      // one, and this surface is 40% of the frame, so a clean one is 40% of the
      // frame carrying no information.
      film: 0.4,
      // Nothing runs down a ceiling and nothing settles on one.
      streak: 0.0,
      dust: 0.0,
      spots: 0.34,
      filmColor: new THREE.Color(0x2f2921),
      roughGain: 0.5,
    });

    /**
     * The fascia band. Brightest painted surface on the site, which is the
     * point: this is the silhouette element, and the only thing that makes a
     * distant canopy say "gas station" rather than "carport".
     */
    const fasciaMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xe6e2d6,
        roughness: 0.46,
        metalness: 0.07,
        normalMap: fineN,
        normalScale: new THREE.Vector2(0.45, 0.45),
        roughnessMap: fineR,
        envMapIntensity: 1.0,
        dithering: true,
      })
    );
    applyGrime(fasciaMat, {
      key: "canopy-fascia",
      field: grime,
      scale: 1.5,
      film: 0.28,
      // Run-off from the coping. This is the mark everyone recognises on a
      // canopy and nobody can name: vertical grey trails down a white band,
      // starting under the top return and dying out before the drip lip.
      streak: 1.1,
      streakY: lv.copingY - 0.02,
      streakFade: 0.62,
      streakStretch: 5.5,
      dust: 0.55,
      spots: 0.22,
      filmColor: new THREE.Color(0x3b352b),
      dustColor: new THREE.Color(0x938a78),
      // Dirt caught in the drip return, all the way round.
      baseY: lv.soffitY + 0.075,
      baseFade: 0.11,
      baseDark: 0.34,
      roughGain: 0.72,
    });

    const stripeMat = track(
      new THREE.MeshStandardMaterial({
        // Chalked. A canopy stripe is the most sun-exposed paint on the site and
        // a saturated one is the giveaway; this is the pumps' livery red
        // (0x76242a) faded and lifted.
        color: 0x9a3a37,
        roughness: 0.58,
        metalness: 0.04,
        normalMap: fineN,
        normalScale: new THREE.Vector2(0.4, 0.4),
        envMapIntensity: 0.95,
      })
    );
    applyGrime(stripeMat, {
      key: "canopy-stripe",
      field: grime,
      scale: 1.2,
      film: 0.24,
      streak: 0.75,
      streakY: lv.soffitY + 0.452,
      streakFade: 0.16,
      streakStretch: 5.0,
      dust: 0.45,
      filmColor: new THREE.Color(0x38291f),
      roughGain: 0.8,
    });

    const roofMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x6f6a61,
        roughness: 0.92,
        metalness: 0.02,
        normalMap: perMetre(steel.normalMap, 0.5),
        normalScale: new THREE.Vector2(0.6, 0.6),
        envMapIntensity: 0.9,
      })
    );
    applyGrime(roofMat, {
      key: "canopy-roof",
      field: grime,
      scale: 2.4,
      film: 0.5,
      // The only up-facing surface this system owns, so the only one dust and
      // grit actually collect on.
      dust: 1.0,
      spots: 0.4,
      filmColor: new THREE.Color(0x2b271f),
      dustColor: new THREE.Color(0x8b8271),
      roughGain: 0.9,
    });

    /** Clad to match the building's CMU (`BuildingSystem` uses 0x928b7c). */
    const columnMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x9c9484,
        roughness: 0.56,
        metalness: 0.08,
        normalMap: fineN,
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap: fineR,
        envMapIntensity: 1.0,
        dithering: true,
      })
    );
    applyGrime(columnMat, {
      key: "canopy-column",
      field: grime,
      scale: 0.7,
      film: 0.3,
      // Down the centreline of the lane-facing flanks, which is where the deck
      // above actually sheds onto the column. Note this is no longer the face
      // carrying the drainage boot — the boot moved to +-X so cars cannot reach
      // it — and the streak was left here rather than followed, because the two
      // have different causes and only one of them is a leak.
      streak: 1.25,
      streakY: 0.5,
      streakFade: 1.7,
      streakStretch: 6.0,
      streakFocusX: 0.0,
      streakFocusHalf: 0.14,
      dust: 0.3,
      spots: 0.18,
      filmColor: new THREE.Color(0x2c2620),
      dustColor: new THREE.Color(0x8f8676),
      // The column foot is where the eye checks whether the thing is really
      // standing there, and a clean junction is what makes it look pasted on.
      baseY: 0.55,
      baseFade: 0.62,
      baseDark: 0.72,
      roughGain: 0.75,
      // Rubbed back to primer at trolley and hose height, both flanks.
      scuffCentre: new THREE.Vector3(0, 0.34, CANOPY.colW / 2),
      scuffRadius: 0.33,
      scuffAmount: 0.55,
      scuffColor: new THREE.Color(0x8c8880),
    });

    const baseMat = track(
      new THREE.MeshStandardMaterial({
        // Darker than the slab it stands on. Round 2026-08-28T232106Z showed the
        // plinth reading as a clean pale block dropped onto the paving — the
        // exact "is it really standing there" failure the brief warns about.
        // Weathered site concrete is not lighter than the deck around it.
        color: 0x7d776a,
        roughness: 0.93,
        metalness: 0.02,
        normalMap: fineN,
        normalScale: new THREE.Vector2(0.8, 0.8),
        envMapIntensity: 0.8,
      })
    );
    applyGrime(baseMat, {
      key: "canopy-colbase",
      field: grime,
      scale: 0.4,
      film: 0.7,
      dust: 0.75,
      spots: 0.45,
      filmColor: new THREE.Color(0x2a241c),
      dustColor: new THREE.Color(0x8d8471),
      // A 90 mm band was too tight to see at any distance the plinth is
      // actually viewed from. Dirt banks up against a kerb over a couple of
      // hundred millimetres, not a hand's width.
      baseY: 0.2,
      baseFade: 0.22,
      baseDark: 0.72,
      roughGain: 0.9,
    });

    const housingMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x4a4b4d,
        roughness: 0.5,
        /*
         * Zero, and it was 0.35.
         *
         * `probe-rank` put the housings at the bottom of the frame's tonal
         * order at luma 26.6 with p10 = 1 — crushed to pure black — under a
         * soffit at 149.6. The cause was this parameter, and it was not a
         * matter of degree: **a surface is a metal or it is a dielectric, and
         * 0.35 is neither.** A fractional metalness makes three discard 35% of
         * the diffuse response and replace it with a specular tinted by the base
         * colour, which on a dark colour is a dark specular that only appears
         * where the environment is already bright. On a fitting tucked under a
         * deck, that is nowhere.
         *
         * The housing is painted die-cast aluminium. Paint is a dielectric, so
         * the answer is 0 rather than a smaller fraction — same reasoning as
         * asking what physical quantity a term stands in for, applied to a
         * parameter that has only two physically meaningful values and a
         * continuous slider.
         */
        metalness: 0.0,
        normalMap: fineN,
        normalScale: new THREE.Vector2(0.5, 0.5),
        envMapIntensity: 0.95,
      })
    );
    applyGrime(housingMat, {
      key: "canopy-fixture",
      field: grime,
      scale: 0.22,
      // Eased from 0.42. The film was compounding with the metalness loss above
      // and with a near-black `filmColor`; three darkenings stacked on one dark
      // surface is how a housing reached p10 = 1.
      film: 0.32,
      dust: 0.2,
      spots: 0.25,
      filmColor: new THREE.Color(0x1d1a16),
      roughGain: 0.8,
    });

    this.lensOn = force.lightsOff ? false : true;
    this.lensMat = track(
      new THREE.MeshStandardMaterial({
        map: lensMap,
        color: 0xffffff,
        // A lit lens is not a white rectangle: the dark parts of the lens — the
        // gasket line, the yellowing, the dead insects — stay dark when the tube
        // is on, which is why the emissive map is the same map as the albedo.
        emissive: new THREE.Color(0xffffff),
        emissiveMap: lensMap,
        emissiveIntensity: this.lensOn ? this.lensLevel : 0,
        roughness: 0.34,
        metalness: 0.0,
        envMapIntensity: 0.9,
        dithering: true,
      })
    );

    if (force.nogrime) {
      for (const m of this.materials) forceGrime(m as THREE.MeshStandardMaterial);
    }

    /* ---------------- geometry ---------------- */

    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      name: string,
      cast: boolean,
      receive = true
    ) => {
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.castShadow = cast;
      m.receiveShadow = receive;
      this.group.add(m);
      return m;
    };

    this.soffitMat = soffitMat;
    add(buildSoffit(lv, shadeInput), soffitMat, "canopy-soffit", false);
    add(buildFascia(lv), fasciaMat, "canopy-fascia", true);
    add(buildFasciaStripe(lv), stripeMat, "canopy-fascia-stripe", false);
    add(buildRoof(lv), roofMat, "canopy-roof", true);

    /* ---------------- signage and drainage ---------------- */

    const atlas = makeCanopySignAtlas();
    this.textures.push(atlas.texture);
    const signMat = track(
      new THREE.MeshStandardMaterial({
        map: atlas.texture,
        // Sign faces are flat-printed acrylic or vinyl on aluminium, so they are
        // smoother and rather more reflective than the painted band behind them.
        // That difference is what stops the panel looking painted straight onto
        // the fascia — at this sun angle the face picks up a sheen the band does
        // not, which is the whole reason a sign reads as applied.
        roughness: 0.42,
        metalness: 0.0,
        envMapIntensity: 1.1,
        dithering: true,
      })
    );
    // Deliberately un-grimed. Signage is the one thing on a forecourt that gets
    // cleaned, and a uniformly filthy sign is the giveaway that the weathering
    // was applied per material rather than per surface.

    const signs = signPlan(lv, atlas);
    add(buildSignFaces(signs, (k) => atlas[k].uv), signMat, "canopy-signs", false);

    const scuppers = scupperPlan(lv);
    const stainTex = makeOverflowStain(128);
    this.textures.push(stainTex);
    const stainMat = track(
      new THREE.MeshStandardMaterial({
        map: stainTex,
        transparent: true,
        depthWrite: false,
        roughness: 0.95,
        metalness: 0.0,
        // Slightly rougher than the band under it and it must not pick up a
        // specular of its own, or the stain reads as wet rather than as dirt.
        envMapIntensity: 0.35,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    const stains = add(buildOverflowStains(lv, scuppers), stainMat, "canopy-overflow-stains", false, false);
    stains.renderOrder = 2;

    const fx = buildFixtures(lv, plan);
    add(
      mergeChecked("canopy dark metal", [fx.housings, buildScuppers(scuppers), buildSignCabinets(signs)]),
      housingMat,
      "canopy-fixture-housings",
      false
    );
    const lensMesh = add(fx.lenses, this.lensMat, "canopy-fixture-lenses", false);
    lensMesh.renderOrder = 1;

    /* ---------------- columns, instanced ---------------- */
    const col = buildColumn(lv);
    const shafts = new THREE.InstancedMesh(col.shaft, columnMat, CANOPY.columns.length);
    shafts.name = "canopy-columns";
    shafts.castShadow = true;
    shafts.receiveShadow = true;
    const bases = new THREE.InstancedMesh(col.base, baseMat, CANOPY.columns.length);
    bases.name = "canopy-column-bases";
    bases.castShadow = true;
    bases.receiveShadow = true;

    const m4 = new THREE.Matrix4();
    const e = new THREE.Euler();
    const tint = new THREE.Color();
    CANOPY.columns.forEach((c, i) => {
      e.set(0, c.yaw, 0);
      m4.makeRotationFromEuler(e);
      m4.setPosition(c.x, lv.shaftBaseY, c.z);
      shafts.setMatrixAt(i, m4);
      m4.makeRotationFromEuler(e);
      m4.setPosition(c.x, islandTop(c.x, c.z), c.z);
      bases.setMatrixAt(i, m4);

      // Hue as well as value. A set that differs only in lightness reads as one
      // object under four exposures, which is the trap one level down from the
      // instancing itself.
      const k = (i - 1.5) / 1.5;
      tint.setRGB(1, 1, 1).offsetHSL(k * 0.012, k * 0.05, k * 0.028);
      shafts.setColorAt(i, tint);
      bases.setColorAt(i, tint);
    });
    shafts.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    if (shafts.instanceColor) shafts.instanceColor.needsUpdate = true;
    if (bases.instanceColor) bases.instanceColor.needsUpdate = true;
    shafts.computeBoundingSphere();
    bases.computeBoundingSphere();
    this.group.add(shafts, bases);

    /* ---------------- contact occlusion at the column feet ---------------- */
    /*
     * Adopted from Car's `src/gen/contactShadow.ts` rather than rolled again.
     * Its argument is why this is not a shadow-map problem: at a 6.2 degree sun
     * the direct term is saturated across the whole footprint and carries no
     * contact information, and what is missing is *sky* occlusion, which a
     * forward renderer does not compute. `probe-rank` cannot see this defect at
     * all — it ranks surfaces, and a missing contact shadow is not a surface, so
     * `canopy-column-bases` reading 57.1 with p10 25 said the base was toned
     * correctly and said nothing about whether it was standing on anything.
     *
     * The occluder is the plinth pad and nothing else, which is worth stating
     * because there are three candidates at a column foot. The cast collar sits
     * 45 mm up but is 90 mm *narrower* than the pad, and the discharge shoe is
     * 292 mm out from the axis against a 320 mm half extent — both of their
     * rings fall inside the pad's own footprint and would be invisible. One
     * occluder, `gap: 0`, because the pad is cast onto the cap.
     */
    const contact = (() => {
      const half = CANOPY.colBaseW / 2;
      // The reach the module will use for a touching occluder. Read from its
      // documented floor rather than assumed, so this stays in step with it.
      const reach = 0.045;
      /*
       * `res` is derived, not chosen, and the derivation is not the obvious one.
       *
       * The grid spans the footprint plus the reach, so with a 640 mm pad and a
       * 45 mm falloff most cells lie under the plinth where nothing sees them,
       * and the intuition is that quality scales with fineness. Measured, it
       * does not — alpha delivered at the contact line, as a fraction of peak:
       *
       *     res  8   12    16     20    24    32
       *     frac 0.48 0.72  0.96   0.73  0.70  0.95
       *
       * **Non-monotone, and res 16 beats res 20 and 24 at a quarter of their
       * cost.** What governs the result is not the cell size but whether the
       * pad edge lands just *inside* a grid line: the quad straddling the edge
       * interpolates, so a vertex a fraction of a millimetre inside the pad
       * delivers its near-peak value to the ground immediately outside. Cells
       * that leave the edge mid-quad deliver a mid-quad value instead.
       *
       * So the condition is `cell = reach / k` for integer k, and k is 2 rather
       * than 1 because k = 1 leaves a single cell across the whole falloff,
       * which flattens it to the linear ramp `contactShadow.ts` explicitly warns
       * produces an airbrushed oval. k = 2 keeps the squared shape — the
       * midpoint measures 0.198 against 0.195 for a true t² — and costs 8192
       * triangles across four feet, 0.45% of the scene's total, with no texture.
       *
       * Writing it as an expression rather than a literal matters because the
       * alignment is a relationship between `colBaseW` and the module's falloff
       * floor, and either could move. `probe-canopy` gates the delivered value,
       * so a res that stops being aligned fails rather than quietly softening.
       */
      const span = CANOPY.colBaseW + 2 * reach;
      const res = Math.round(span / (reach / 2));
      const parts: THREE.BufferGeometry[] = [];
      let mat: THREE.Material | null = null;
      let borrowed: unknown = null;
      for (const c of CANOPY.columns) {
        const built = makeContactShadow({
          occluders: [{ x: c.x, z: c.z, hx: half, hz: half, gap: 0 }],
          // The cap the pad is cast onto, not grade. `groundHeight` would put
          // this 183 mm below the plinth, inside the island.
          groundY: (x, z) => islandTop(x, z),
          res,
          // Live from the scene, not a copy of Lighting's current default, and
          // not this system's own cached `envIntensity` either. The module makes
          // this required precisely so the borrowing cannot be inherited by
          // accident — which is this round's soffit finding, arriving back from
          // another system with the fix built into the signature.
          environmentIntensity: scene.environmentIntensity,
        });
        if (!built) continue;
        borrowed = built.report;
        parts.push(built.geometry);
        // One material for four decals; the module returns an equivalent one per
        // call and keeping the first is what lets these merge into one draw.
        if (!mat) mat = built.material;
        else built.material.dispose();
      }
      if (!parts.length || !mat) return null;
      this.materials.push(mat);
      const merged = mergeChecked("canopy contact shadow", parts);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = "canopy-contact-shadows";
      // Neither casts nor receives: it *is* a shading term, and letting it take
      // part in the shadow pass would darken the cap twice.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      return { mesh, res, triangles: merged.index ? merged.index.count / 3 : 0, borrowed };
    })();

    scene.add(this.group);

    /* ---------------- services ---------------- */

    const fixtures: CanopyFixtureHandle[] = plan.map((f) => ({
      name: f.name,
      position: new THREE.Vector3(f.x, lv.soffitY - CANOPY.fixtureDrop - 0.014, f.z),
      normal: new THREE.Vector3(0, -1, 0),
      width: CANOPY.fixtureW - 0.09,
      depth: CANOPY.fixtureW - 0.09,
      colour: new THREE.Color(0xfff0d8),
    }));

    /**
     * Solid footprints for the player. The plinths only: the deck is 4.7 m up
     * and a blocker there would be an invisible wall across the whole
     * forecourt. `PlayerSystem` picks this up because the key ends in
     * `.blockers` — there is no consumer to edit. See `src/core/collision.ts`.
     */
    const half = CANOPY.colBaseW / 2;
    const blockers: Rect[] = CANOPY.columns.map((c) => ({
      minX: c.x - half,
      maxX: c.x + half,
      minZ: c.z - half,
      maxZ: c.z + half,
    }));
    game.provide("canopy.blockers", blockers);

    const service: CanopyService = {
      root: this.group,
      deck: { minX: CANOPY.minX, maxX: CANOPY.maxX, minZ: CANOPY.minZ, maxZ: CANOPY.maxZ },
      soffitY: lv.soffitY,
      copingY: lv.copingY,
      dripY: lv.dripY,
      clearHeight: CANOPY.clear,
      columns: CANOPY.columns.map((c) => ({ x: c.x, z: c.z, half: CANOPY.colW / 2 })),
      fixtures,
      fixturesOn: () => this.lensOn,
      setFixtures: (on, level) => {
        this.lensOn = on;
        if (level !== undefined) this.lensLevel = level;
        this.lensMat.emissiveIntensity = on ? this.lensLevel : 0;
        this.lensMat.needsUpdate = true;
        // The light the lamps put on the panel they are bolted to, which until
        // this round stayed on when they were switched off — the switch was
        // wired to the object you look at and not to the light it makes. Both
        // now move together, so `setFixtures(false)` means the lamps are off
        // rather than merely dark.
        this.soffitMat.emissiveIntensity = on ? this.lampBounce : 0;
        this.soffitMat.needsUpdate = true;
      },
      lensMaterial: this.lensMat,
      soffitColour: soffitColour.clone(),
      setLightmapIntensity: (v) => {
        this.lightmapLevel = v;
        this.soffitMat.lightMapIntensity = v;
      },
      lightmapIntensity: () => this.lightmapLevel,
      /**
       * The lamps' bounce on the soffit, separately from the sky bake.
       *
       * Two setters and not one because the two terms scale differently: the
       * bake is a coefficient of `scene.environmentIntensity` and this is not.
       * If Lighting hangs real luminaires here it wants to zero *this* and keep
       * the bake, which a single combined control could not express.
       */
      setLampBounce: (v) => {
        this.lampBounce = v;
        this.soffitMat.emissiveIntensity = this.lensOn ? v : 0;
      },
      lampBounce: () => this.lampBounce,
    };
    game.provide("canopy", service);
    game.provide("canopy.fixtures", fixtures);

    /**
     * Where 180 square metres of deck puts its water on the ground.
     *
     * Published rather than acted on, for the same reason `canopy.fixtures` is:
     * the ground belongs to Terrain, and a stain painted on the paving by this
     * system would be a second system writing the forecourt's appearance. What
     * this system owns is the *route* — a gutter behind the fascia falling to a
     * sump over each column, a pipe inside the column, a shoe 140 mm above the
     * plinth, and four overflow scuppers through the fascia at gutter level for
     * when the primary route blocks.
     *
     * `groundAccum` is consumed rather than duplicated, per the decision that
     * what accumulates at a base is a property of where wind and water stop and
     * not of the object standing there. Each discharge reports the accumulation
     * already present where it lands, so a consumer can tell the difference
     * between a shoe discharging onto swept concrete and one discharging into a
     * hollow that never dries. This system deliberately does not scatter its
     * own debris off the back of those numbers.
     */
    const accum = game.tryGet?.("groundAccum") as
      | {
          fines(x: number, z: number): number;
          grime(x: number, z: number): number;
          swept(x: number, z: number): number;
        }
      | undefined;
    const discharges = CANOPY.columns.map((c, i) => {
      // The shoe throws clear of the plinth on the face the boot is on: object
      // +X, which yaw maps to world -X at yaw 0 and +X at 180.
      const s = c.yaw === 0 ? 1 : -1;
      const x = c.x + s * (CANOPY.colW / 2 + 0.13);
      const z = c.z;
      return {
        name: `canopy-discharge-${i + 1}`,
        x,
        z,
        y: lv.capY[i] + 0.145,
        /** Litres per second at a 25 mm/h event over this column's quarter deck. */
        peakFlow: +(((CANOPY.maxX - CANOPY.minX) * (CANOPY.maxZ - CANOPY.minZ) * 0.025) / 4 / 3600 * 1000).toFixed(3),
        ground: accum
          ? {
              fines: +accum.fines(x, z).toFixed(3),
              grime: +accum.grime(x, z).toFixed(3),
              swept: +accum.swept(x, z).toFixed(3),
            }
          : null,
      };
    });
    game.provide("canopy.drainage", {
      /** Overflow mouths through the fascia; water leaves here in a real event. */
      scuppers: scuppers.map((s: Scupper) => ({ name: s.name, x: s.x, y: s.y, z: s.z, nx: s.nx, nz: s.nz })),
      /** Downpipe outlets at the column feet, and what the ground is like there. */
      discharges,
    });

    if (force.lightsOn) service.setFixtures(true);

    /* ---------------- self report ---------------- */
    let tris = 0;
    let meshes = 0;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh & { count?: number };
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      const g = m.geometry;
      const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      tris += n * (m.count ?? 1);
    });
    (window as unknown as { __CANOPY?: unknown }).__CANOPY = {
      soffitY: +lv.soffitY.toFixed(4),
      copingY: +lv.copingY.toFixed(4),
      dripY: +lv.dripY.toFixed(4),
      clearAboveDatum: CANOPY.clear,
      clearAboveIslandCap: +(lv.soffitY - Math.max(...lv.capY)).toFixed(4),
      deckDepth: +(CANOPY.copingH + CANOPY.dripDrop).toFixed(4),
      deck: { minX: CANOPY.minX, maxX: CANOPY.maxX, minZ: CANOPY.minZ, maxZ: CANOPY.maxZ },
      shaftLen: +lv.shaftLen.toFixed(4),
      columns: CANOPY.columns.length,
      fixtures: fixtures.length,
      fixturesOn: this.lensOn,
      lensIntensity: this.lensMat.emissiveIntensity,
      meshes,
      triangles: Math.round(tris),
      blockers: blockers.length,
      lightsCreated: 0,
      // The soffit bake and the environment it is scaled by, together, because
      // either one alone is uninterpretable.
      envIntensity: +this.envIntensity.toFixed(3),
      lightmapIntensity: +this.lightmapLevel.toFixed(3),
      /**
       * The lamps' bounce on the soffit, which shares the surface with the bake
       * above and is reported beside it because the pair is the whole
       * night-to-dawn mechanism: `lightmapIntensity` is proportional to
       * `envIntensity` and `lampBounce` is not, so their ratio is what changes
       * as the sky comes up. A reader who sees only one of the three numbers
       * cannot tell a lamp from a bake.
       */
      lampBounce: +this.lampBounce.toFixed(3),
      lampBounceOn: this.lensOn,
      /**
       * Contact occlusion at the column feet, from Car's shared builder. `res`
       * is reported because it is derived from the pad width and the module's
       * falloff rather than chosen, so a reader can see the grid is aligned to
       * the contact line and check it against `colBaseW` if either changes.
       */
      contactShadow: contact
        ? {
            decals: CANOPY.columns.length,
            res: contact.res,
            triangles: contact.triangles,
            // The module's own account of what it borrowed and what it derived,
            // printed here because a borrowing has to be visible in the report
            // of the system that borrowed it — including when the borrowing is
            // made on that system's behalf by shared code.
            borrowed: contact.borrowed,
          }
        : null,
      signs: signs.length,
      scuppers: scuppers.length,
      discharges: discharges.length,
      /** Absolute cap heights, millimetres. The probe sizes these to screen px. */
      typeMm: { wordmark: TYPE.wordCap, sub: TYPE.subCap, price: TYPE.priceCap, plate: TYPE.plateCap },
      signPanelM: { logo: +atlas.logo.w.toFixed(3), price: +atlas.price.w.toFixed(3) },
    };
    console.log(`[canopy] ${JSON.stringify((window as unknown as { __CANOPY: unknown }).__CANOPY)}`);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}

/** Re-exported so tools can read the plan without importing the whole system. */
export type { CanopyLevels };
