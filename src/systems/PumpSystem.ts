import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types";
import {
  applyGrime,
  ensureAttrs,
  forceGrime,
  forceScuff,
  hangingHose,
  makeBollardSkin,
  makeGrimeField,
  makeCabinetSteel,
  makeMouldedPlastic,
  makePaintedSteel,
  makeWeepMask,
  setHsAnisotropy,
  weatherHose,
} from "../gen/hardsurface";
import { makeKeypadFace, makeTopperFace } from "../gen/pumpDecals";
import { PumpDisplay, type PumpDisplayValues } from "../gen/pumpDisplay";
import {
  BOLLARD_H,
  BOLLARD_IMPACT_U,
  buildBollard,
  buildPump,
  HOSE_SPOKES,
  hoseSwivel,
  nozzleStowed,
  PUMP,
  pumpVariation,
  type PumpVariation,
  type SoilAt,
} from "../gen/pumpParts";
import type { GroundAccum } from "../gen/groundAccum";
import { ISLAND, ISLANDS, padY } from "../site";

/** Height of the finished island cap, matching the terrain system's build. */
const islandTop = (x: number, z: number) => padY(x, z) + 0.021 + 0.162;

/* ------------------------------------------------------------------ */
/* public handles - System 7 drives the pumps through these            */
/* ------------------------------------------------------------------ */

export type PumpFaceName = "north" | "south";

export interface PumpFaceHandle {
  /** e.g. "pump-2:south". Stable across runs. */
  readonly name: string;
  /** +1 for the +Z face, -1 for the -Z face. */
  readonly side: 1 | -1;
  /** Unit outward normal of this face in world space. */
  readonly facing: THREE.Vector3;
  /** Where a player should stand to operate this face, on the ground. */
  readonly standPosition: THREE.Vector3;
  /** Centre of the price/volume panel in world space; aim point for a click. */
  readonly displayCentre: THREE.Vector3;
  /** Meshes that count as a hit on this face when raycasting. */
  readonly pickables: THREE.Object3D[];

  /** Redraws the numeric panel. Partial: only pass what changed. */
  setDisplay(v: Partial<PumpDisplayValues>): void;
  getDisplay(): PumpDisplayValues;
  /** Zeroes the sale and stops the pump; leaves the posted price alone. */
  resetDisplay(): void;
  /** Authorises/deauthorises: brightens the panel and lights the grade lamp. */
  setActive(on: boolean): void;
  isActive(): boolean;

  /** The nozzle, free for System 7 to transform. */
  readonly nozzle: THREE.Group;
  /** 0 = stowed in the boot, 1 = lifted out to filler height. Rebuilds the hose. */
  setNozzleLift(t: number): void;
  getNozzleLift(): number;
}

export interface PumpHandle {
  /** e.g. "pump-2". */
  readonly name: string;
  readonly index: number;
  readonly island: number;
  readonly root: THREE.Group;
  /** Centre of the dispenser footprint, on the island cap. */
  readonly position: THREE.Vector3;
  readonly faces: PumpFaceHandle[];
  readonly face: Record<PumpFaceName, PumpFaceHandle>;
  /** Applies to both faces. */
  setDisplay(v: Partial<PumpDisplayValues>): void;
  setActive(on: boolean): void;
  resetDisplay(): void;
}

interface PumpLayout {
  island: number;
  x: number;
  /** Small install rotation so no two dispensers are perfectly square. */
  yaw: number;
}

const LAYOUT: PumpLayout[] = [
  { island: 0, x: -2.4, yaw: 0.012 },
  { island: 0, x: 2.4, yaw: -0.009 },
  { island: 1, x: 0.0, yaw: 0.006 },
];

/**
 * What each dispenser's price head is showing, per unit.
 *
 * Hand-authored rather than seeded, because none of it is noise: a station
 * posts one price per grade, so the three heads differ because they are set to
 * different grades, not because a generator said so. Dollars and gallons are
 * the residue of the last sale — dispensers idle with the previous customer's
 * total on the board until the next authorisation clears it, and three heads
 * all reading 0.00 / 0.00 is the one state that cannot happen naturally on a
 * forecourt that has been open since dawn.
 *
 * The dead segment on unit 3 is the cheapest per-unit tell available: the head
 * is the brightest thing on the dispenser, so a single unlit bar in the gallons
 * row is noticed immediately and cannot be mistaken for a lighting difference.
 * Row 1 is GALLONS, cell 2 counts from the right, segment 5 is the upper-left
 * bar — so a 6 there is missing its top-left stroke.
 */
const DISPLAY_STATE = [
  { price: 3.499, grade: 0, dollars: 41.86, gallons: 11.96, faults: [] },
  { price: 3.899, grade: 1, dollars: 0, gallons: 0, faults: [] },
  { price: 4.259, grade: 2, dollars: 26.4, gallons: 6.19, faults: [{ row: 1, cell: 2, seg: 5 }] },
];

/* ------------------------------------------------------------------ */

/**
 * System 3a: the fuel dispensers and the bollards protecting the islands.
 *
 * Every mesh and every map is generated in code. Nothing here tunes lighting.
 *
 * TODO(System 4 - lighting): the topper panel and the price head are emissive
 * placeholders at a flat intensity. Once the real dawn key and the exposure
 * curve exist they need re-balancing against it, and the dispensers want a
 * short-range fill so the recessed keypad area is not solid black.
 * TODO(System 4 - lighting): contact shadow under the cabinet skid is coming
 * from the shadow map only, which at this sun elevation is very soft. A small
 * baked/AO contribution at the island cap would sell the weight.
 */
/**
 * Visibility controls for the parts a same-build A/B needs to isolate.
 *
 * `?pweep=0` drops the stain mesh, `?pseam=0` the shut-line backing, `?plip=0`
 * the panel lips. Each removes a mesh outright rather than weakening it, so the
 * harness can prove the control applied by naming the meshes that exist in the
 * live scene — proof of effect rather than of parsing.
 *
 * `pseam` and `plip` exist because `tools/pumpscale.mjs` ranks the shut line
 * floor at 870 px and the panel lip at 54 px, and both numbers are bounding-box
 * upper bounds on partly or wholly occluded geometry. The ranking says which
 * parts to ask about; only the frame can say what they contribute.
 */
const partOn = (flag: string) =>
  (new URLSearchParams(location.search).get(flag) ?? "1") !== "0";
const wantWeep = () => partOn("pweep");

export class PumpSystem implements GameSystem {
  readonly name = "pumps";

  private group = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private handles: PumpHandle[] = [];
  private displays: PumpDisplay[] = [];

  init(ctx: SystemContext): void {
    const { scene, game, renderer } = ctx;
    // Terrain's shared accumulation fields. Optional on purpose: `?skip=terrain`
    // and `?solo=pumps` both have to keep building.
    const accum = game.tryGet<GroundAccum>("groundAccum");
    const weepMask = makeWeepMask();
    setHsAnisotropy(renderer.capabilities.getMaxAnisotropy());
    const dbg = new URLSearchParams(location.search);
    const forces = (dbg.get("force") ?? "").split(",");
    const forced = forces.includes("grime");
    const forcedScuff = forces.includes("scuff");

    /* ---------------- shared maps ---------------- */
    const grime = makeGrimeField(512, 9091);
    // Two steel authorings: a big-tile semi-gloss for the cabinet skin, and the
    // tighter powder-coat map for small hardware, where a 0.9 m tile would show
    // no detail at all.
    // Tiles are 0.20 m and 0.10 m because that is what a 512 map can hold at
    // this feature size. Raising them re-creates the aliasing that read as
    // sprayed concrete on every surface of the unit at once; `featureFreq` in
    // hardsurface now throws rather than let it happen quietly. If you need
    // large-scale relief back, it wants a second map on a second UV set, not a
    // bigger tile here.
    const cabinetDetail = makeCabinetSteel(512, 0.20, 4243);
    const steelDetail = makePaintedSteel(512, 0.20, 4242);
    const plasticDetail = makeMouldedPlastic(512, 0.10, 5151);
    // heightM has to track the real post height or the paint bands land in the
    // wrong place: makeBollardSkin puts the bumper rub at 0.50 m and the kick
    // scuff at 0.19 m in *metres*, converted through this number. It was 1.02
    // against posts that are now BOLLARD_H tall.
    const bollardSkin = makeBollardSkin(512, BOLLARD_H + 0.02, 6161, BOLLARD_IMPACT_U[0]);
    this.textures.push(
      grime,
      cabinetDetail.normalMap,
      cabinetDetail.roughnessMap,
      steelDetail.normalMap,
      steelDetail.roughnessMap,
      plasticDetail.normalMap,
      plasticDetail.roughnessMap,
      bollardSkin.map,
      bollardSkin.normalMap,
      bollardSkin.roughnessMap,
      bollardSkin.metalnessMap
    );

    // Pump geometry carries metre-scale UVs (see `metreUv`), so a detail map
    // whose tile covers `tileMetres` has to repeat 1/tileMetres times.
    const perMetre = (t: THREE.Texture, tileMetres: number, extra = 1) => {
      const c = t.clone();
      c.needsUpdate = true;
      c.repeat.setScalar(extra / tileMetres);
      this.textures.push(c);
      return c;
    };
    const cabN = perMetre(cabinetDetail.normalMap, cabinetDetail.tileMetres);
    const cabR = perMetre(cabinetDetail.roughnessMap, cabinetDetail.tileMetres);
    const steelN = perMetre(steelDetail.normalMap, steelDetail.tileMetres);
    const steelR = perMetre(steelDetail.roughnessMap, steelDetail.tileMetres);
    const plasticN = perMetre(plasticDetail.normalMap, plasticDetail.tileMetres);
    const plasticR = perMetre(plasticDetail.roughnessMap, plasticDetail.tileMetres);

    /* ---------------- materials ---------------- */

    /**
     * One weathered material set per dispenser.
     *
     * Built per unit rather than shared because the critic's complaint about
     * the row was not that the three cabinets are the same *shape* — they are,
     * and should be — but that they are the same *object*: identical dirt in
     * identical places, three times, forty centimetres apart. Geometry
     * variation (hose slack, nozzle rake, install yaw) does nothing about that
     * at forecourt distance, where the grain is invisible and only the value
     * pattern survives. So `wear`, `scuff`, `tint` and `streakY` come off
     * `pumpVariation` and move the uniforms.
     *
     * **That was necessary and, on its own, useless.** Every one of those
     * numbers scales how *strong* a mark is. None of them moves where it is,
     * because `applyGrime` samples its field in object space and the three
     * cabinets are the same mesh — so all three got the same streak in the same
     * place at three slightly different strengths, which is indistinguishable
     * from one asset under three slightly different exposures. A critic
     * reported "three copies of one asset, unambiguously" and named the tell:
     * the same streak in the same place relative to the panel edge. Diffing two
     * units photographed from an identical relative pose put the structural
     * difference across the cabinet at 2.3/255. The fix is `fieldOffset` and
     * `fieldFlip`, applied to every grime call below through `unitGrime`; see
     * the block comment on `applyGrime` for the whole story.
     *
     * Cost is three copies of a dozen materials. It is not three shader
     * compiles: `applyGrime` injects identical GLSL and returns the same
     * `customProgramCacheKey`, so the three units share one program per slot
     * and differ only in uniform values.
     */
    const makeUnitMaterials = (vary: PumpVariation) => {
    /**
     * `applyGrime` with this unit's field phase already attached.
     *
     * Every grime call in this factory goes through it. Calling `applyGrime`
     * directly here is the bug described above, so it is wrapped rather than
     * left to each of the dozen call sites to remember.
     */
    const unitGrime = (mat: THREE.MeshStandardMaterial, o: Parameters<typeof applyGrime>[1]) =>
      applyGrime(mat, { ...o, fieldOffset: vary.fieldOffset, fieldFlip: vary.fieldFlip });
    // Powder-coated cabinet. Deliberately not white: a dispenser that has been
    // outdoors for five years is a warm off-grey, and pure white blows out
    // instantly under a low sun through ACES.
    // Semi-gloss painted sheet metal. Roughness 0.34 with metalness 0.10 is the
    // key change: at 0.52 the cabinet had no specular lobe left and the surface
    // read as plaster no matter what the normal map did. TODO(System 4 -
    // lighting): once IBL lands this will want a real gloss check, but the
    // authoring is right - do not flatten it again to compensate for exposure.
    const steel = new THREE.MeshStandardMaterial({
      // Per-unit tint: a repaint or a different production batch, warm one way
      // and cool the other.
      //
      // The amplitude here was 3.5% of lightness, which is below what anyone
      // can see on a beige panel across a forty-centimetre gap, so the lever
      // existed and did nothing. 9% is roughly what a unit repainted a few
      // years after its neighbours looks like: clearly a sibling, clearly not
      // the same paint. Hue moves too, because a purely lighter-or-darker set
      // reads as one object under different exposure — which is exactly the
      // mistake this whole per-unit pass was diagnosed with.
      color: new THREE.Color(0x96938b).offsetHSL(vary.tint * 0.045, vary.tint * 0.05, vary.tint * 0.09),
      roughness: 0.34 + vary.tint * 0.07,
      metalness: 0.10,
      normalMap: cabN,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: cabR,
      envMapIntensity: 1.0,
      dithering: true,
    });
    unitGrime(steel, {
      key: "pump-steel",
      field: grime,
      // Big scale, low film: what the critic read as speckled stucco was a
      // mid-frequency grime field at high strength covering the whole face.
      // Dirt on a painted cabinet is blotchy and localised, not a wash.
      scale: 1.9,
      // Squared, not linear. `wear` spans 0.55-1.45, so a linear gain gave the
      // cleanest and dirtiest unit a 2.6x ratio on a term that starts at 0.30 —
      // a difference of about 0.17 in film strength, which on a beige panel is
      // nothing, and it is why three units with genuinely different `wear`
      // values still read as one asset. Squaring takes the ratio to 7x, so one
      // unit is visibly grubby and one visibly tidy.
      //
      // Cubed was tried first and went too far: at wear 1.42 the film term hit
      // 0.86 and the dirtiest unit read as scorched rather than dirty, with
      // black vertical smears. The lesson is that the top of the range is what
      // limits the exponent, not the bottom.
      film: 0.30 * Math.pow(vary.wear, 2),
      // Fuel runs down from the nozzle boot. Focusing the streaks on the boot
      // column is what turns "dirty texture" into "something spilled here".
      streak: 1.15 * Math.pow(vary.wear, 1.6),
      streakY: vary.streakY,
      streakFade: 0.95,
      streakStretch: 4.0,
      streakFocusX: PUMP.bootX,
      streakFocusHalf: 0.17,
      dust: 0.62 * vary.wear,
      spots: 0.16,
      filmColor: new THREE.Color(0x3a3025),
      dustColor: new THREE.Color(0x8a7f6c),
      baseY: 0.32,
      baseFade: 0.36,
      baseDark: 0.42,
      // Low: grime is allowed to dirty the albedo but not to erase the gloss.
      roughGain: 0.45,
      // Bare metal where the nozzle has been swung into the panel for years,
      // centred on the boot. Mirrored in X by the shader, so both faces get it.
      scuffCentre: new THREE.Vector3(PUMP.bootX, PUMP.bootY + 0.02, PUMP.cabD / 2),
      scuffRadius: 0.20,
      scuffAmount: vary.scuff,
      scuffColor: new THREE.Color(0x8a8c8e),
    });

    // The skid and every recessed seam: dark, and where the fuel actually sits.
    const steelDark = new THREE.MeshStandardMaterial({
      color: 0x4a4741,
      roughness: 0.68,
      metalness: 0.35,
      normalMap: steelN,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughnessMap: steelR,
      envMapIntensity: 0.8,
    });

    // Shut-line floors and the deposit band under each panel lap.
    //
    // Deliberately the least reflective material on the unit, and that is the
    // whole point of it existing separately. These strips began life in
    // `steelDark` above, where metalness 0.35 at envMapIntensity 0.8 meant a
    // third of what they returned was specular off the environment. On an albedo
    // half the panel's they should have measured about -50 of 255 against it;
    // in frame they measured -13, because a flat bright hemisphere lifted them
    // straight back up to panel value and the shut line vanished.
    //
    // Metalness 0 and a low envMap term make the contrast come from albedo, so
    // it holds whatever the environment turns out to contain. That matters right
    // now: the PMREM's lower hemisphere is a single constant colour, so anything
    // whose read depends on *what* it reflects cannot be judged yet.
    /**
     * The run-down stain under a fastener, and why it is not `seamMat`.
     *
     * It used to be: a hard-edged rectangle in the near-black slot colour, 0.6
     * mm proud of the panel. That is the single most literal instance of the
     * critic's "drawn outlines" on this model, and every bolt read as a black
     * tadpole. A weep is the panel's own paint with a film of iron oxide and
     * road dirt over it — warm, low in contrast, soft at every edge, and never
     * the darkest thing in the frame.
     *
     * Alpha comes from two places that do different jobs: the alpha map softens
     * it across its width, and a four-component vertex colour carries how strong
     * *this* stain is, which is what lets one mesh hold a hundred different
     * amounts without a hundred materials.
     */
    /**
     * Contrast direction, measured rather than assumed.
     *
     * Once the darts were no longer buried, the A/B said the stain made its
     * region **brighter** by 6.27 mean luma — the wrong sign for road grime. The
     * cause is in the values, not in the stain: `0x4a3d31` is 0.069 linear and
     * the panel above is 0.305, so over the *panel* it must darken. But the
     * darts start at 100 mm, and what is actually behind most of them is the
     * plinth: same 0.069 base colour, but `metalness: 0.35`, which suppresses
     * diffuse and leaves it materially darker than a metalness-0 layer of
     * identical albedo. A stain darker than the panel was still brighter than
     * the plinth.
     *
     * So the albedo goes down by ~2.8x, which is a contrast change and not an
     * alpha one — the ranking in `tools/pumpscale.mjs` puts `base splash` at
     * 180 px in `pump_close`, three times the size Car demonstrated reads, so
     * this cannot be a size problem and must not be answered by making it
     * bigger or more opaque.
     *
     * `envMapIntensity: 0.55` is deliberately left alone. Sub-1.0 values here
     * are on a list to be retired as non-physical in a dedicated round, and
     * tuning a value that is scheduled for removal is how that list stopped
     * being actionable last time.
     */
    const weepMat = new THREE.MeshStandardMaterial({
      color: 0x2b2318,
      roughness: 0.97,
      metalness: 0.0,
      envMapIntensity: 0.55,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      alphaMap: weepMask,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      dithering: true,
    });
    /*
     * There was a `roughnessFactor` injection here, driving roughness from
     * `vColor.a` toward 0.995. It is removed because it could not do anything:
     * the material's base roughness is already 0.97, so the injection spanned
     * 0.97 to 0.995 — a 2.5% range, inside the noise, an effect invisible by
     * construction rather than by accident.
     *
     * The reasoning behind it was sound and is already satisfied without it. A
     * stain is a roughness change as much as an albedo one, and each fragment
     * shades with its own material rather than a blend, so the cue that matters
     * is the *step* between this material at 0.97 and the panel at 0.34. That
     * step exists in the base values. The injection was a second copy of a
     * change already made, which is why measuring its range before writing the
     * shader would have been the cheaper order.
     */
    /**
     * `?pweep=0` drops the stain mesh entirely, which is the only way to tell
     * this pass apart from the `applyGrime` streaks that were always on these
     * panels. Without that A/B the weep cannot be claimed, and it was not
     * claimed. See NOTES on controls having to prove they were applied: the
     * assertion for this one is that no mesh named `:weep` exists in the scene,
     * which is proof of effect rather than of parsing.
     */

    const seamMat = new THREE.MeshStandardMaterial({
      color: 0x191713,
      roughness: 0.94,
      metalness: 0.0,
      // 0.3 was a reasonable number for a dark strip lying on the cabinet
      // front, which is what this material used to be drawn as. It is now the
      // floor of a real channel 8 mm wide and 5 to 17 mm deep, and a surface
      // down there sees a wedge of sky of order ten degrees, not a hemisphere.
      // There is no ambient occlusion in this scene to supply that, so the
      // material has to: this is the "reduced sky exposure" half of a shut
      // line, and it is the only half available on a face the sun never
      // reaches.
      envMapIntensity: 0.1,
      dithering: true,
    });

    // The returned top edge of each panel: the light half of the shut line.
    //
    // Lighter than the panel by design. The dark ribbon on its own read as
    // "applied trim strips, not gaps" — it is the light-against-dark pair that
    // says "cut", and under this sun a horizontal chamfer cannot supply the
    // light half (see the sun-vector note in pumpParts.facePlate: an up-facing
    // ledge gets half the flat face's direct light, and the +Z faces get none).
    //
    // So the lift is albedo plus sky exposure, and the envMap term is *raised*
    // rather than lowered because an up-tilted surface sees the whole dome where
    // the panel sees half of it. That is a structural fact about the sky, not a
    // guess about its contents, so it survives the environment being rebuilt.
    unitGrime(steelDark, {
      key: "pump-steel-dark",
      field: grime,
      // Seams and the skid are where the grime genuinely does collect, so this
      // one stays strong - the contrast against the now-cleaner cabinet skin is
      // what makes the seams read as recesses.
      scale: 0.55,
      film: 0.72,
      streak: 0.8,
      // vary.streakY, not PUMP.bootY. `pumpVariation` has produced a per-unit
      // run-off height since the RNG fix and this call site was still pinned to
      // the constant, so the skid and seam staining started at exactly the same
      // height on all three units while the cabinet skin above it did not.
      streakY: vary.streakY + 0.06,
      streakFade: 0.8,
      streakFocusX: PUMP.bootX,
      streakFocusHalf: 0.24,
      dust: 0.5,
      filmColor: new THREE.Color(0x1b1712),
      baseY: 0.24,
      baseFade: 0.26,
      baseDark: 0.55,
      roughGain: 0.9,
    });

    // Livery band. Sits at 0.34-0.46 m, which is squarely in the splash zone,
    // so it is the dirtiest painted surface on the pump - it was previously the
    // cleanest, and a factory-perfect stripe on a weathered cabinet is a
    // giveaway on its own.
    const accent = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x76242a).offsetHSL(0, 0, vary.tint * 0.03),
      roughness: 0.42,
      metalness: 0.05,
      normalMap: cabN,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: cabR,
      envMapIntensity: 1.0,
    });
    unitGrime(accent, {
      key: "pump-accent",
      field: grime,
      scale: 1.1,
      film: 0.46 * vary.wear,
      // Run-off crosses the band from everything above it, and road splash
      // comes up at it from below.
      streak: 0.85,
      streakY: 0.47,
      streakFade: 0.16,
      streakStretch: 3.4,
      dust: 0.42,
      spots: 0.20,
      filmColor: new THREE.Color(0x2a1d18),
      dustColor: new THREE.Color(0x8d8574),
      baseY: 0.40,
      baseFade: 0.20,
      baseDark: 0.34,
      roughGain: 0.8,
    });

    // Dark trim: the valance under the head, the crown moulding and the
    // topper surround.
    //
    // The whole dispenser was one value. At forecourt distance every panel,
    // the head, the valance and the topper all sat within a few percent of
    // each other, so the object reduced to a beige rectangle with a red line
    // across it and had no internal structure left to read — which is most of
    // what "no silhouette complexity at distance" actually was. Nearly every
    // real dispenser puts a dark band at the top of the body and around the
    // header for exactly this reason: it separates head from body at any
    // distance, and it survives being three pixels wide.
    const trim = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x39383a).offsetHSL(0, 0, vary.tint * 0.02),
      roughness: 0.46,
      metalness: 0.22,
      normalMap: cabN,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughnessMap: cabR,
      envMapIntensity: 1.05,
      dithering: true,
    });
    unitGrime(trim, {
      key: "pump-trim",
      field: grime,
      scale: 1.4,
      film: 0.34 * vary.wear,
      dust: 0.95 * vary.wear,
      spots: 0.20,
      streak: 0.45 * vary.wear,
      streakY: PUMP.headTop,
      streakFade: 0.55,
      filmColor: new THREE.Color(0x24211c),
      dustColor: new THREE.Color(0x9c9280),
      roughGain: 0.7,
    });

    // Bezels and boots: ABS that has been in the sun for years, so it is
    // chalked, slightly warped-looking and much lighter than it started.
    const plastic = new THREE.MeshStandardMaterial({
      color: 0x484a49,
      roughness: 0.74,
      metalness: 0.0,
      normalMap: plasticN,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: plasticR,
      envMapIntensity: 0.85,
    });
    unitGrime(plastic, {
      key: "pump-plastic",
      field: grime,
      scale: 0.35,
      film: 0.40,
      streak: 0.42,
      streakY: 1.18,
      streakFade: 0.7,
      dust: 0.62,
      spots: 0.25,
      filmColor: new THREE.Color(0x241f19),
      dustColor: new THREE.Color(0x9a917f),
      roughGain: 1.0,
    });

    // Keycaps: worn smooth and shiny exactly where thumbs land.
    const keys = new THREE.MeshStandardMaterial({
      color: 0x2b2d2e,
      roughness: 0.42,
      metalness: 0.0,
      envMapIntensity: 0.9,
    });
    unitGrime(keys, {
      key: "pump-keys",
      field: grime,
      scale: 0.12,
      film: 0.30,
      dust: 0.3,
      filmColor: new THREE.Color(0x14100c),
      roughGain: 0.6,
    });

    const chrome = new THREE.MeshStandardMaterial({
      color: 0x9d9a94,
      roughness: 0.31,
      metalness: 0.95,
      envMapIntensity: 1.15,
    });
    unitGrime(chrome, {
      key: "pump-chrome",
      field: grime,
      scale: 0.25,
      film: 0.38,
      dust: 0.4,
      filmColor: new THREE.Color(0x2a251d),
      roughGain: 0.8,
    });

    // Backlit acrylic topper. No brand marks anywhere on this dispenser.
    const topper = new THREE.MeshStandardMaterial({
      color: 0xcfcabf,
      roughness: 0.55,
      metalness: 0.0,
      emissive: new THREE.Color(0x6d5f4c),
      emissiveIntensity: 0.55,
      envMapIntensity: 1.0,
    });
    unitGrime(topper, {
      key: "pump-topper",
      field: grime,
      scale: 0.9,
      film: 0.22,
      dust: 0.75,
      streak: 0.5,
      streakY: PUMP.topperTop - 0.02,
      streakFade: 0.3,
      filmColor: new THREE.Color(0x33291f),
      dustColor: new THREE.Color(0x8b8172),
      roughGain: 1.0,
    });

    // Cover glass: never clean, and the haze is what makes the digits read as
    // being behind something rather than painted on.
    const cover = new THREE.MeshPhysicalMaterial({
      color: 0x8f948f,
      roughness: 0.26,
      metalness: 0.0,
      transparent: true,
      opacity: 0.13,
      clearcoat: 1.0,
      clearcoatRoughness: 0.20,
      depthWrite: false,
      envMapIntensity: 1.2,
      side: THREE.FrontSide,
    });
    unitGrime(cover as unknown as THREE.MeshStandardMaterial, {
      key: "pump-cover",
      field: grime,
      scale: 0.20,
      film: 0.40,
      streak: 0.55,
      streakY: 1.58,
      streakFade: 0.30,
      dust: 0.7,
      spots: 0.9,
      filmColor: new THREE.Color(0x62605a),
      dustColor: new THREE.Color(0xa39a89),
      roughGain: 1.2,
    });

    // Reinforced black rubber, and it was already authored as such.
    //
    // The read was "a constant-diameter matte tube in warm brown... reads as
    // extruded clay, not reinforced black rubber", and the base colour here has
    // been 0x18181a all along — very nearly black. The brown was applied on top:
    // a 0.42 film plus 0.5 dust in warm greys, over an albedo dark enough that
    // the overlay was doing essentially all of the work. On a light panel that
    // much grime is a tint; on near-black rubber it is a repaint.
    //
    // This is the same shape of failure as the buried lamp chambers and the
    // needles inside an opaque card: the value was right in the source and was
    // destroyed downstream, so reading the material definition confirmed a
    // colour that never reached a pixel. Grime cut to where it modulates rather
    // than replaces, and roughness dropped so the top of the curve can carry the
    // sheen an oily hose has.
    const hoseMat = new THREE.MeshStandardMaterial({
      color: 0x17171a,
      roughness: 0.52,
      metalness: 0.0,
      envMapIntensity: 0.9,
      // Without this the per-vertex scuff and bleach that `weatherHose` writes
      // are silently discarded, and the result is a screenshot identical to
      // having written nothing — which is the failure this system already shipped
      // once tonight with the weep stain. The attribute and the flag are two
      // halves of one change and neither is worth anything alone.
      vertexColors: true,
    });
    unitGrime(hoseMat, {
      key: "pump-hose",
      field: grime,
      scale: 0.30,
      film: 0.12,
      dust: 0.16,
      filmColor: new THREE.Color(0x2b271f),
      dustColor: new THREE.Color(0x7d7364),
      baseY: 0.22,
      baseFade: 0.22,
      baseDark: 0.35,
      roughGain: 0.55,
    });

    // Nozzle body: powder-coated aluminium casting, scuffed to bare metal on
    // every corner that has ever hit a filler flap.
    // vertexColors for the same reason as `hoseMat`: `scuffProminence` writes an
    // attribute and the attribute is discarded in silence without the flag.
    const nozzleBody = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x1d2422,
      roughness: 0.48,
      metalness: 0.3,
      normalMap: perMetre(steelDetail.normalMap, steelDetail.tileMetres, 3),
      normalScale: new THREE.Vector2(0.7, 0.7),
      envMapIntensity: 1.0,
    });
    unitGrime(nozzleBody, {
      key: "pump-nozzle",
      field: grime,
      scale: 0.14,
      film: 0.35,
      dust: 0.35,
      filmColor: new THREE.Color(0x2c2a24),
      roughGain: 0.8,
    });

    const nozzleMetal = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x76736e,
      roughness: 0.44,
      metalness: 0.88,
      envMapIntensity: 1.0,
    });
    unitGrime(nozzleMetal, {
      key: "pump-nozzle-metal",
      field: grime,
      scale: 0.10,
      film: 0.35,
      dust: 0.3,
      filmColor: new THREE.Color(0x33302a),
      roughGain: 0.7,
    });

    const rubber = new THREE.MeshStandardMaterial({
      color: 0x141416,
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.6,
    });

      const set = {
        steel, steelDark, seamMat, weepMat, accent, trim, plastic, keys, chrome, topper, cover,
        hoseMat, nozzleBody, nozzleMetal, rubber,
      };
      const list = Object.values(set) as THREE.Material[];
      this.materials.push(...list);
      if (forced) for (const m of list) forceGrime(m as THREE.MeshStandardMaterial);
      if (forcedScuff) for (const m of list) forceScuff(m as THREE.MeshStandardMaterial);
      return set;
    };

    /* ---------------- shared: the bollards are not per-dispenser ---------- */

    // Three skins, not one.
    //
    // A critic looking at three posts said "all three are identical", and they
    // were: one `makeBollardSkin` call fed one material shared by every bollard,
    // so the chips, the rust and the streaks landed on the same texel of every
    // post. This is the same defect as the object-space grime field from last
    // round, one level up — per-unit variation that was never authored, rather
    // than authored and then lost on the way to the screen.
    //
    // Cheaper than it looks: three 512s of noise at load. The round-robin at the
    // assembly site means no two posts on one island share a skin.
    // Each skin puts its struck arc at a different place in U, and the post
    // rotations below are chosen to bring all three arcs round to face the drive
    // lane. Cars come from a direction, so the damage has to, and the arcs must
    // *not* all sit at the same U or the three posts share a silhouette again.
    const bollardSkins = [
      bollardSkin,
      makeBollardSkin(512, BOLLARD_H + 0.02, 7307, BOLLARD_IMPACT_U[1]),
      makeBollardSkin(512, BOLLARD_H + 0.02, 9151, BOLLARD_IMPACT_U[2]),
    ];
    for (const s of bollardSkins.slice(1)) {
      this.textures.push(s.map, s.normalMap, s.roughnessMap, s.metalnessMap);
    }
    const bollardMats = bollardSkins.map((skin, si) => {
      const m = new THREE.MeshStandardMaterial({
        map: skin.map,
        normalMap: skin.normalMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughnessMap: skin.roughnessMap,
        metalnessMap: skin.metalnessMap,
        roughness: 1.0,
        metalness: 1.0,
        envMapIntensity: 1.0,
        dithering: true,
      });
      applyGrime(m, {
        key: `pump-bollard-${si}`,
        field: grime,
        scale: 0.42,
        film: 0.22,
        streak: 0.30,
        streakY: 0.55,
        streakFade: 0.5,
        dust: 0.55,
        filmColor: new THREE.Color(0x2b2117),
        dustColor: new THREE.Color(0x93876f),
        baseY: 0.14,
        baseFade: 0.16,
        baseDark: 0.4,
        roughGain: 0.8,
        // Phase the object-space field per skin too, so the grime does not
        // re-introduce the uniformity the three skins just removed. Case 19.
        fieldOffset: new THREE.Vector2(si * 3.7, si * 1.9),
        fieldFlip: si === 1,
      });
      return m;
    });

    const grout = new THREE.MeshStandardMaterial({
      color: 0x8b8478,
      roughness: 0.95,
      metalness: 0.0,
      envMapIntensity: 0.8,
    });
    applyGrime(grout, {
      key: "pump-grout",
      field: grime,
      scale: 0.3,
      film: 0.5,
      dust: 0.4,
      filmColor: new THREE.Color(0x2f2a22),
      roughGain: 0.7,
    });

    const sharedMats = [...bollardMats, grout];
    this.materials.push(...sharedMats);
    if (forced) for (const m of sharedMats) forceGrime(m as THREE.MeshStandardMaterial);

    /* ---------------- assemble the dispensers ---------------- */

    // One printed topper for the whole forecourt: three dispensers under one
    // canopy carry one brand, and varying it per unit would be a worse error
    // than repeating it. The per-unit difference lives in the weathering.
    const topperFaceTex = makeTopperFace();
    this.textures.push(topperFaceTex);
    // Printed keypad. Shared across all six faces: a keypad is a keypad, and
    // the per-unit difference the critique actually wants is a discrete
    // incident, not a differently-arranged set of digits.
    const keypadFaceTex = makeKeypadFace();
    this.textures.push(keypadFaceTex);
    const keypadFaceMat = new THREE.MeshStandardMaterial({
      map: keypadFaceTex,
      // Duller and finer than the enamel cabinet: this is moulded ABS, and the
      // critique's fifth item is that one material is currently doing every job.
      roughness: 0.58,
      metalness: 0.0,
      envMapIntensity: 0.55,
    });

    const topperFaceMat = new THREE.MeshStandardMaterial({
      map: topperFaceTex,
      // Backlit from inside the box, so the print is emissive at the same
      // colour it is diffuse — a lit sign is not a white sign with a picture
      // on it, the dark parts of the artwork stay dark when the tube is on.
      emissive: new THREE.Color(0xffffff),
      emissiveMap: topperFaceTex,
      emissiveIntensity: 0.62,
      roughness: 0.42,
      metalness: 0.0,
      envMapIntensity: 0.8,
    });
    this.materials.push(topperFaceMat);

    LAYOUT.forEach((lay, i) => {
      const isl = ISLANDS[lay.island];
      const wx = isl.cx + lay.x;
      const wz = isl.cz;
      const wy = islandTop(wx, wz);

      const root = new THREE.Group();
      root.position.set(wx, wy, wz);
      root.rotation.y = lay.yaw;
      root.name = `pump-${i + 1}`;

      // Where the dirt is, asked of the shared field rather than invented here —
      // and composed against the range the field actually reaches at this
      // geometry, which is a separate and larger piece of work than calling it.
      //
      // `tools/pumpsoil.mjs` samples all four cabinet skins on both islands.
      // What it found, and every number here is why a term below is or is not
      // present:
      //
      //   fines    0.1053 .. 0.1250   span 0.020   (site-wide: 0.006 .. 0.994)
      //   grime    0.0000 .. 0.0000   span 0
      //   swept    0.0000 .. 0.0000   span 0
      //   shelter  0.0000 .. 0.0001   span 0.0001
      //   lee      0.0000 .. 0.8963   span 0.896
      //
      // So `fines` is **constant to within 2%** here: bare-multiplied it is a
      // flat 12% tint carrying no variation whatsoever, which is Building's trap
      // exactly — the range of a published field is part of its contract and
      // nothing at a call site reveals it. Used as the dominant term it would
      // have left the per-bolt RNG doing all the real work, i.e. a private noise
      // function wearing the shared field's clothes. It is kept only as a mild
      // global level, and its *absolute* value is the honest reading: 0.116 on a
      // field that spans 0.006 to 0.994 across the site says the island is
      // genuinely clean ground, which it is, because it is swept.
      //
      // `grime`, `swept` and `shelter` are dropped entirely rather than kept at
      // a small weight. They measure exactly zero on the island and all three
      // are right to: a graded pad has no standing water, is not driven over,
      // and is not sheltered. A term that does nothing and a term that is subtle
      // are the same screenshot (NOTES), so a zero term is worse than no term —
      // it reads as though the field were consulted.
      //
      // That leaves `lee` and `wallBase`, which is what terrain predicted for
      // this system, and between them they are the two axes the critic asked
      // for: `lee` says *which side*, `wallBase.splash` says *how high*.
      const soilAt: SoilAt | undefined = accum
        ? (lx, ly, lz) => {
            // Local to world through the yaw the root carries, so the field is
            // asked about the place this piece of cabinet really stands.
            const c = Math.cos(lay.yaw);
            const sn = Math.sin(lay.yaw);
            const px = wx + lx * c + lz * sn;
            const pz = wz - lx * sn + lz * c;

            // Which side. Usable directly: 0 to 0.90 with a mean of 0.51, so it
            // is the only field here that needs no rescaling. The cabinet is its
            // own obstacle, ~0.6 m in plan.
            const lee = accum.lee(px, pz, wx, wz, 0.6);

            // How high. Rain off the pad, measured at 0.49 at 20 mm, 0.18 at
            // 200 mm and gone by 800 mm — a real profile, and the reason the
            // *base* of the cabinet should be dirty while the head is not.
            // `distOut` is zero because this is the wall itself.
            const splash = accum.wallBase(0, ly, px - wx, pz - wz).splash;

            // Level, not variation. Deliberately a narrow multiplier: at the
            // measured 0.116 this is 0.90, so it trims rather than drives.
            const level = 0.6 + accum.fines(px, pz) * 2.6;

            // A floor, because no forecourt is spotless, plus the two terms that
            // have range. Not normalised to 0..1 by dividing by the observed
            // span, which would amplify 2% of noise into a full-scale signal —
            // the fields that are flat here are flat because the place is.
            return Math.max(0, Math.min(1, (0.10 + 0.58 * lee + 1.5 * splash) * level));
          }
        : undefined;

      const build = buildPump(i + 1, soilAt);
      const vary = pumpVariation(i + 1);
      const {
        steel, steelDark, seamMat, weepMat, accent, trim, plastic, keys, chrome, topper, cover,
        hoseMat, nozzleBody, nozzleMetal, rubber,
      } = makeUnitMaterials(vary);

      const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, nm: string) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        m.receiveShadow = true;
        m.name = `${root.name}:${nm}`;
        root.add(m);
        return m;
      };

      const shell = addMesh(build.steel, steel, "shell");
      addMesh(build.steelDark, steelDark, "dark");
      if (partOn("pseam")) addMesh(build.seam, seamMat, "seam");
      // Stains do not cast shadows and must not write depth: two overlapping
      // runs would otherwise punch each other out.
      if (wantWeep()) {
        const weepMesh = addMesh(build.weep, weepMat, "weep");
        weepMesh.castShadow = false;
      }
      addMesh(build.trim, trim, "trim");
      addMesh(build.accent, accent, "accent");
      addMesh(build.plastic, plastic, "plastic");
      addMesh(build.keys, keys, "keys");
      addMesh(build.chrome, chrome, "chrome");
      addMesh(build.topper, topper, "topper");

      const coverMesh = new THREE.Mesh(build.glass, cover);
      coverMesh.renderOrder = 4;
      coverMesh.name = `${root.name}:cover`;
      root.add(coverMesh);

      const faces: PumpFaceHandle[] = [];
      for (const side of [1, -1] as const) {
        // Per-unit head state. Not RNG at all — it was three literals, so all
        // three dispensers posted the same price with the same grade selected
        // and the same zeroed totals, which a critic read (correctly) as three
        // copies of one asset. A forecourt posts one price per *grade*, and a
        // dispenser left mid-transaction or with the last sale still on the
        // board is the normal state of things, not the exception.
        const head = DISPLAY_STATE[i % DISPLAY_STATE.length];
        const disp = new PumpDisplay(
          { price: head.price, grade: head.grade, dollars: head.dollars, gallons: head.gallons },
          head.faults
        );
        this.displays.push(disp);

        const panelMat = new THREE.MeshStandardMaterial({
          map: disp.texture,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: disp.texture,
          emissiveIntensity: 0.85,
          roughness: 0.85,
          metalness: 0.0,
          envMapIntensity: 0.3,
        });
        this.materials.push(panelMat);

        panelMat.toneMapped = true;
        const geo = build.displays.find((d) => d.side === side)!.geo;
        const panel = new THREE.Mesh(geo, panelMat);
        panel.name = `${root.name}:display:${side === 1 ? "north" : "south"}`;
        root.add(panel);

        const face = build.topperFaces.find((t) => t.side === side)!.geo;
        const faceMesh = new THREE.Mesh(face, topperFaceMat);
        faceMesh.name = `${root.name}:topperface:${side === 1 ? "north" : "south"}`;
        root.add(faceMesh);

        const padGeo = build.keypadFaces.find((k) => k.side === side)!.geo;
        const padMesh = new THREE.Mesh(padGeo, keypadFaceMat);
        padMesh.name = `${root.name}:keypad:${side === 1 ? "north" : "south"}`;
        root.add(padMesh);

        const hoseGeo = build.hoses.find((h) => h.side === side)!.geo;
        const hoseMesh = new THREE.Mesh(hoseGeo, hoseMat);
        hoseMesh.castShadow = true;
        hoseMesh.name = `${root.name}:hose:${side === 1 ? "north" : "south"}`;
        root.add(hoseMesh);

        const nz = build.nozzles.find((n) => n.side === side)!;
        const nozzleGroup = new THREE.Group();
        nozzleGroup.name = `${root.name}:nozzle:${side === 1 ? "north" : "south"}`;
        for (const [g, m] of [
          [nz.body, nozzleBody],
          [nz.metal, nozzleMetal],
          [nz.rubber, rubber],
        ] as [THREE.BufferGeometry, THREE.Material][]) {
          const mesh = new THREE.Mesh(g, m);
          mesh.castShadow = true;
          // Named because the nozzle's three meshes were the only anonymous
          // meshes on the model, and a harness probe looking for them by name
          // silently matched none and reported a measurement of zero.
          mesh.name = `${nozzleGroup.name}:${m === rubber ? "rubber" : m === nozzleMetal ? "metal" : "body"}`;
          nozzleGroup.add(mesh);
        }
        root.add(nozzleGroup);

        faces.push(
          this.makeFaceHandle(
            root,
            side,
            disp,
            panelMat,
            nozzleGroup,
            hoseMesh,
            [shell, panel, coverMesh, nozzleGroup],
            vary
          )
        );
      }

      this.group.add(root);
      const handle: PumpHandle = {
        name: root.name,
        index: i,
        island: lay.island,
        root,
        position: new THREE.Vector3(wx, wy, wz),
        faces,
        face: { north: faces[0], south: faces[1] },
        setDisplay: (v) => faces.forEach((f) => f.setDisplay(v)),
        setActive: (on) => faces.forEach((f) => f.setActive(on)),
        resetDisplay: () => faces.forEach((f) => f.resetDisplay()),
      };
      this.handles.push(handle);
    });

    /* ---------------- bollards at the island ends ---------------- */
    let bi = 0;
    for (const isl of ISLANDS) {
      for (const sx of [-1, 1]) {
        const bx = isl.cx + sx * (ISLAND.length / 2 - 0.42);
        const bz = isl.cz + (bi % 2 === 0 ? 0.06 : -0.05);
        const by = islandTop(bx, bz);
        // Same `impactU` the skin for this post uses, so the dents in the mesh
        // and the chips in the paint are on the same arc.
        const b = buildBollard(
          BOLLARD_H + (bi % 3) * 0.02,
          3 + bi,
          BOLLARD_IMPACT_U[bi % BOLLARD_IMPACT_U.length]
        );

        const post = new THREE.Mesh(b.skin, bollardMats[bi % bollardMats.length]);
        post.castShadow = true;
        post.receiveShadow = true;
        post.position.set(bx, by, bz);
        // Y only. The lean lives in `buildBollard` now, baked into the mesh
        // about the grout line. Two independent out-of-plumb terms were adding
        // up to about three degrees, and worse, `tools/pumpprobe.mjs` measures
        // geometry and could only ever see one of them — so the instrument
        // would have reported half the tilt the critic was looking at.
        // Turn the struck arc round to face where the cars actually come from.
        //
        // The rotation used to be `bi * 1.3` — arbitrary, which was fine while
        // the damage was circumferentially uniform and is not fine now that it
        // has a direction. `CylinderGeometry` puts U=0 at +Z and advances
        // towards +X, so a texel at U faces `(sin 2piU, 0, cos 2piU)` in local
        // space, and a Y rotation simply adds to that angle. A bollard at an
        // island end is hit by a vehicle overshooting along the island axis, so
        // the target is outward along X.
        const si = bi % bollardMats.length;
        const aim = sx * (Math.PI / 2) - 2 * Math.PI * BOLLARD_IMPACT_U[si];
        // A few degrees of scatter: cars come from a direction, not from a line.
        post.rotation.set(0, aim + (bi % 2 === 0 ? 0.21 : -0.17), 0);
        post.name = `bollard-${bi + 1}`;
        this.group.add(post);

        const foot = new THREE.Mesh(b.foot, grout);
        foot.receiveShadow = true;
        foot.castShadow = true;
        foot.position.set(bx, by, bz);
        this.group.add(foot);
        bi++;
      }
    }

    // ?pumptex=1 pins the first display canvas over the frame at 1:1, which is
    // the only way to tell "the canvas is wrong" apart from "the canvas is
    // right and the mesh showing it is wrong" in a single screenshot. Note the
    // name: `tex` already belongs to the terrain system.
    if (dbg.has("pumptex") && this.displays.length) {
      const src = this.displays[0].texture.image as HTMLCanvasElement;
      Object.assign(src.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: `${src.width}px`,
        height: `${src.height}px`,
        zIndex: "9999",
        outline: "2px solid #0f0",
      });
      document.body.appendChild(src);
    }

    if (dbg.has("hide")) {
      const names = (dbg.get("hide") ?? "").split(",");
      this.group.traverse((o) => {
        if (names.some((n) => n && o.name.includes(n))) o.visible = false;
      });
    }

    scene.add(this.group);

    /* ---------------- service registry ---------------- */
    game.provide("pumps", this.handles);
    game.provide(
      "pumpsByName",
      Object.fromEntries(this.handles.map((h) => [h.name, h])) as Record<string, PumpHandle>
    );
    game.provide(
      "pumpFaces",
      this.handles.flatMap((h) => h.faces)
    );
    game.provide(
      "pumpPickables",
      this.handles.flatMap((h) => h.faces.flatMap((f) => f.pickables))
    );
  }

  /* ---------------------------------------------------------------- */

  private makeFaceHandle(
    root: THREE.Group,
    side: 1 | -1,
    disp: PumpDisplay,
    panelMat: THREE.MeshStandardMaterial,
    nozzle: THREE.Group,
    hose: THREE.Mesh,
    pickables: THREE.Object3D[],
    vary: PumpVariation
  ): PumpFaceHandle {
    const faceName: PumpFaceName = side === 1 ? "north" : "south";
    const name = `${root.name}:${faceName}`;

    root.updateMatrixWorld(true);
    const facing = new THREE.Vector3(0, 0, side).applyQuaternion(root.quaternion).normalize();
    const stand = root.position.clone().addScaledVector(facing, 1.15);
    const displayCentre = root.localToWorld(new THREE.Vector3(0, 1.42, (side * PUMP.headD) / 2 + side * 0.0025));

    // Stowed pose is the identity; the lift pose swings the nozzle out and up
    // to roughly a sedan's filler height, which is where System 7 wants it.
    const stowedPos = nozzle.position.clone();
    const stowedRot = nozzle.rotation.clone();
    let lift = 0;
    let active = false;

    // Both ends of the hose come from pumpParts rather than from constants
    // repeated here. The previous copy of the inlet was a hand-written
    // `bootY + 0.395` that agreed with the real stowed inlet to within 10 mm
    // by coincidence, and stopped agreeing by 115 mm the moment the nozzle was
    // rescaled — a disagreement that is invisible until something calls
    // setNozzleLift, at which point the hose changes shape.
    const sw = hoseSwivel(side);
    const stow = nozzleStowed(side, vary);

    const rebuildHose = (t: number) => {
      // Inlet follows the nozzle group, so the hose stays attached as it moves.
      const inlet = stow.inlet
        .clone()
        .add(new THREE.Vector3(nozzle.position.x, nozzle.position.y, nozzle.position.z).sub(stowedPos));
      const dir = stow.inletDir.clone().lerp(new THREE.Vector3(0, 1, side * 0.25).normalize(), t).normalize();
      // Slack length is conserved as the nozzle is lifted: pulling the nozzle
      // out takes up slack rather than magically shortening the hose, which is
      // what keeps the loop believable through the whole 0..1 travel.
      const curve = hangingHose(sw.point, sw.dir, inlet, dir, vary.hoseLen, {
        seed: vary.hoseSeed + (side === 1 ? 7 : 19),
        nozzleLoad: 0.085 * (1 - t * 0.5),
        stiffness: 0.15,
      });
      // 14 spokes rather than 10: at 29 mm across and 0.76 mm per pixel the
      // silhouette of a 10-sided tube is visibly faceted at the `hose` eye, and
      // a faceted silhouette reads as low-poly plastic before any material does.
      // ~1000 extra triangles per hose, in a mesh that already exists.
      const geo = weatherHose(
        ensureAttrs(new THREE.TubeGeometry(curve, 120, 0.0145, HOSE_SPOKES, false)),
        120,
        HOSE_SPOKES,
        0.0145,
        vary.hoseSeed + (side === 1 ? 7 : 19)
      );
      hose.geometry.dispose();
      hose.geometry = geo;
    };

    return {
      name,
      side,
      facing,
      standPosition: stand,
      displayCentre,
      pickables,
      nozzle,
      setDisplay: (v) => disp.set(v),
      getDisplay: () => disp.get(),
      resetDisplay: () => {
        disp.reset();
        active = false;
        panelMat.emissiveIntensity = 0.85;
      },
      setActive: (on) => {
        active = on;
        disp.set({ active: on });
        // TODO(System 4 - lighting): this is a stand-in for the panel actually
        // being lit; re-balance once the dawn exposure curve is fixed.
        panelMat.emissiveIntensity = on ? 1.35 : 0.85;
      },
      isActive: () => active,
      setNozzleLift: (t: number) => {
        const c = THREE.MathUtils.clamp(t, 0, 1);
        if (Math.abs(c - lift) < 1e-4) return;
        lift = c;
        nozzle.position.set(
          stowedPos.x + side * 0.0,
          stowedPos.y + c * 0.02,
          stowedPos.z + side * c * 0.55
        );
        nozzle.rotation.set(stowedRot.x - side * c * 0.5, stowedRot.y, stowedRot.z);
        rebuildHose(c);
      },
      getNozzleLift: () => lift,
    };
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
    this.displays.forEach((d) => d.dispose());
  }
}
