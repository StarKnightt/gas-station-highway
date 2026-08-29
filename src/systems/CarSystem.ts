import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types.ts";
import {
  ARCH_BASE_Y,
  ARCH_CENTRE_Y,
  ARCH_R,
  buildArchLiner,
  buildCarShell,
  buildTyre,
  CAR,
  projectionStats,
  resetProjectionStats,
  wheelPositions,
} from "../gen/carBody.ts";
import { buildArchLips, buildInterior, buildLamps, buildSills, buildTrim, buildWheel } from "../gen/carParts.ts";
import {
  makeAlloySkin,
  makeCarPaint,
  makePlate,
  makeRainField,
  makeReflector,
  makeSeatCloth,
  setCarAnisotropy,
} from "../gen/carSkin.ts";
import { applyGrime, forceGrime, makeGrimeField, makeTyreSkin } from "../gen/hardsurface.ts";
import { applyCarWeather, bakeCarWeather, bakeWheelWeather, type CarWeatherUniforms } from "../gen/carGrime.ts";
import { varyColour, wheelVariation, type WheelVariation } from "../gen/carWheelVary.ts";
import { PARKING } from "../site.ts";
import type { GroundAccum } from "../gen/groundAccum.ts";
import { makeContactShadow } from "../gen/contactShadow.ts";

/* ------------------------------------------------------------------ */
/* public handle                                                        */
/* ------------------------------------------------------------------ */

export interface ParkedCarHandle {
  readonly name: string;
  readonly root: THREE.Group;
  /** Centre of the car on the ground, world space. */
  readonly position: THREE.Vector3;
  /** Heading in radians; 0 points down +Z. */
  readonly heading: number;
  /** Overall bounds in car-local metres. */
  readonly size: { length: number; width: number; height: number };
  /** Body, glass and wheel meshes, for raycasts and reflection probes. */
  readonly pickables: THREE.Object3D[];
  /** Repaint at runtime; System 7 may want a different car per session. */
  setPaint(hex: number): void;
}

/* ------------------------------------------------------------------ */
/* placement                                                            */
/* ------------------------------------------------------------------ */

/**
 * Second stall from the west end of the parking row, backed in so the nose
 * faces the forecourt. Sat 0.14 m off the stall centreline and yawed three
 * degrees, because a car left exactly square in the middle of a stall is
 * another small tell.
 */
const STALL = 1;
const PLACE = {
  x: PARKING.originX + (STALL + 0.5) * PARKING.stallWidth - 0.14,
  z: PARKING.z0 + PARKING.depth / 2 + 0.22,
  yaw: Math.PI + 0.052,
  /**
   * Which sign of car-local X faces the kerb in this stall, for the road-film
   * asymmetry on the wheels. The car is backed in, so its local +X is the side
   * away from the forecourt; a car nosed in would want the other sign, which is
   * why this is stated here rather than inferred from `w.x` at the wheel.
   */
  kerbside: 1 as 1 | -1,
};

/** Dusty mid-blue. Reads as a real fleet colour rather than a saturated toy. */
/**
 * Was 0x364b62, whose luminance is 0.0653 linear and which delivered about
 * 0.034 after grime and clearcoat. Measured against a 0.18 grey card
 * substituted into this same body shell in the same pose (`?cardebug=refdiel`),
 * that is 19% of the card — an effective reflectance of 0.034 on a car that is
 * supposed to be a mid slate blue.
 *
 * The absurdity that named it: **the paint was darker than the tyres.** In
 * `side_sun` the masked tyre reads a median of 78.0 and the masked body 45.6,
 * and the tyre's effective reflectance works out at 0.047 against the paint's
 * 0.034. No car is darker than its own rubber, and no tyre is brighter than
 * the asphalt under it. Chasing the pale-looking tyre would have been chasing
 * the wrong half of that pair; the tyre is roughly right and the body was not.
 *
 * This value is the old one scaled 2.2x in *linear luminance* with its hue and
 * saturation held, not a colour picked by eye: (0.0369, 0.0684, 0.1181) becomes
 * (0.0819, 0.1518, 0.2622), luminance 0.0653 to 0.145, which should deliver
 * about 0.075 through the same grime and clearcoat and put the paint back above
 * the rubber where it belongs.
 */
/**
 * CORRECTED AGAIN, AND THE REASON IS THAT I INVALIDATED MY OWN CERTIFICATION.
 *
 * 0x516d8c was derived by the grey-card method above and certified correct. Then,
 * later and separately, `metalness` on this same material went from 0.36 to 0.0 -
 * a correct fix, because an intermediate metalness is a category error - and the
 * measured effect was **1.41x more delivered diffuse.** The grey-card derivation
 * predates that, so from the moment metalness was fixed the paint was 41% lighter
 * than the value that had been certified. Nothing re-checked it.
 *
 * This is the stale-compensation pattern running the other way. The usual form is
 * a compensation left behind after its bug is fixed at source; this is a *derived
 * value* left behind after a downstream term it was derived through changed. Both
 * are invisible in the source, and both need someone to go looking after a fix
 * lands. The rule generalises: **a value certified through a pipeline is certified
 * against that pipeline, and any later change to it retires the certificate.**
 *
 * WITHDRAWN, AND RECORDED RATHER THAN QUIETLY DELETED: the number that first
 * prompted this change was measured on the wrong pixels. I read region
 * coordinates off a 1024-wide view of a 1600x900 capture, so every rectangle was
 * off by a factor of 1.5625, and "the flank reads 1.48x brighter than lit
 * asphalt" was actually sampling sky and tree line. The tell was that the flank
 * and roof came back **identical to four decimal places** across a round that had
 * changed the paint - a region that does not move when the thing it is measuring
 * changes was never on that thing. The same trap as the tyre patches, in the same
 * file, caught by the same check.
 *
 * There is also no valid reference available in that pose: a sweep of the lower
 * frame puts the brightest unchanged ground at 0.0086-0.0137 linear, so the whole
 * foreground is in the car's own long shadow. Comparing a sunlit vertical flank
 * against shaded horizontal road differs in orientation, illumination AND
 * material - three confounds in a comparison that would be presented as one.
 *
 * SO THIS CHANGE DOES NOT REST ON THAT MEASUREMENT, and does not need to. The
 * metalness argument above is a source-level one: a value derived through a
 * pipeline was certified before a 1.41x change to that pipeline. It needs no
 * reference surface and no pose. The pixel check confirms only that the intended
 * correction was applied - flank 0.2058 -> 0.1431, a measured **0.695x against
 * 0.709x predicted**, on a region verified to have moved for 99% of its pixels.
 *
 * Corrected by the same method as the 2.2x that produced the old value: linear
 * luminance divided by 1.41 with hue and saturation held, not a colour picked by
 * eye. (0.0819, 0.1518, 0.2622) becomes (0.0581, 0.1077, 0.1859), luminance 0.145
 * to 0.1028. Predicted flank 0.2487 -> about 0.176, i.e. parity with the lit
 * asphalt rather than half a stop above it.
 */
const PAINT = 0x445c77;

export class CarSystem implements GameSystem {
  readonly name = "car";

  private group = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private paintMat!: THREE.MeshPhysicalMaterial;
  private weather?: CarWeatherUniforms;
  /**
   * One per corner. `bakeWheelWeather` writes an `aWeather` attribute onto each
   * rim, and until now nothing consumed it: `applyCarWeather` only ever ran on
   * the paint, so the bake was dead weight and `__CAR.weather.wheelDust` always
   * reported null. An array rather than a single entry because the four wheels
   * now have four materials (case 22).
   */
  private wheelWeather: CarWeatherUniforms[] = [];
  /** One entry per corner, published on `__CAR` so the phase fix is checkable. */
  private wheelVary: WheelVariation[] = [];
  /**
   * What the contact decal borrowed from the scene and what it derived from it,
   * published on `__CAR.contactShadow`. Null until the decal is built, so a
   * missing decal reads as absent rather than as a zeroed borrowing.
   */
  /**
   * Whether the contact decal got the exact rendered surface or fell back to the
   * analytic height field. Published, because a fallback that nobody can see is
   * the defect rather than the fallback.
   */
  private contactSurfaceExact = false;
  /** Which published key the exact surface came from, or null if none matched. */
  private contactSurfaceKey: string | null = null;
  private contactShadowReport: ReturnType<typeof makeContactShadow> extends null
    ? never
    : NonNullable<ReturnType<typeof makeContactShadow>>["report"] | null = null;

  init(ctx: SystemContext): void {
    const { scene, game, renderer } = ctx;
    setCarAnisotropy(renderer.capabilities.getMaxAnisotropy());
    const dbg = new URLSearchParams(location.search);
    const force = (dbg.get("force") ?? "").split(",");
    const forced = force.includes("grime");
    // Throwaway diagnostic, off by default and never shipped in a judged round.
    // Per NOTES case 25 an unrecognised token must be fatal, not ignored: a
    // debug flag that silently does nothing returns a clean negative and that
    // is the most persuasive wrong artefact this project produces.
    const debugRaw = dbg.get("cardebug");
    if (
      debugRaw !== null &&
      !["front", "arch", "tyrelit", "refdiel", "refmetal", "reftyre", "slots"].includes(debugRaw)
    ) {
      throw new Error(`car: unknown ?cardebug=${debugRaw} (known: front, arch, tyrelit, refdiel, refmetal, reftyre, slots)`);
    }
    const debugFront = debugRaw === "front";
    /**
     * REGION MASK, not a look. Flat-colours `car-slots` so the shut lines can be
     * located in a frame rather than inferred from geometry.
     *
     * Why this exists: the bonnet shoulder reads as a black band at walking
     * distance, and I attributed it to the shut lines twice - first from a 3x
     * magnified crop, which is the portrait error, then from the slot quad widths.
     * The band measures 12-68 mm wide and a slot quad's short edge is 6.2 mm at
     * p10 and 11.6 mm median, so the band is too wide to BE the slots. Colouring
     * them settles which surface is dark instead of arguing about it, which is the
     * instrument that ended three rounds of inference on the grille edge.
     */
    const debugSlots = debugRaw === "slots";
    /**
     * Flat-colours the five meshes that make up the wheel-arch column. Not for
     * looking at: it is a **region mask**. The arch reads as a void because the
     * body panel, the arch interior and the tyre all sit within about eleven
     * luminance levels of each other, and measuring that honestly means
     * measuring per surface — which until now meant choosing rectangles by
     * hand, in a frame where the surfaces cannot be told apart by eye. That is
     * the exact circularity NOTES case 28 is about. Capturing the same pose
     * twice, once masked and once normally, gives every surface's own
     * statistics with no coordinates supplied by anyone.
     */
    const debugArch = debugRaw === "arch";
    /**
     * Forced-value control for the tyre, and unlike the two above it is **lit**:
     * an ordinary rough dielectric at albedo 0.5 with no map, no grime and no
     * texture, in the tyre's exact place. It exists to separate two
     * explanations of a tyre whose median display luminance is 1.1 while the
     * arch liner two centimetres behind it reads 29.9 on a *lower* albedo and a
     * *lower* `envMapIntensity`. If a half-white tyre also renders near black,
     * the light is not reaching it and nothing done to the material can help;
     * if it renders bright, the material is at fault and the liner comparison
     * is the honest one. Only one knob moves and it does not touch the surface
     * the result is compared against — NOTES case 23.
     */
    const debugTyreLit = debugRaw === "tyrelit";
    /**
     * The same forced-value control as `tyrelit`, moved to the body shell, and
     * the first thing to run against a new environment rather than the last.
     *
     * Paint is the most environment-dependent surface in the scene, and every
     * number in the paint material was authored against an environment that
     * did not exist: first while `envMapIntensity` was inert project-wide
     * (NOTES case 26), then against a PMREM whose lower hemisphere had a
     * standard deviation of exactly 0.0. Tuning paint against the new world
     * capture without first measuring what that capture *delivers* would be
     * authoring a third layer of compensation on top of two stale ones.
     *
     * So: two reference materials, both plain, both `envMapIntensity` 1.0,
     * both with no map, no clearcoat, no grime and no weather.
     *
     *   refdiel   a smooth dielectric at 0.18 albedo — a grey card. What it
     *             returns is diffuse irradiance plus a dielectric specular
     *             lobe, so it reads the environment's *brightness*.
     *   refmetal  a clean mirror-ish metal. A metal has no diffuse term at
     *             all, so every photon it shows came from the environment.
     *             It reads the environment's *structure*: against the old
     *             sky-only capture it can only show sky and a flat disc, and
     *             against the world capture it should show the canopy, the
     *             pumps and the building.
     *
     * Run each with and without `?worldenv=0` and the pair of differences
     * separates "the environment changed" from "my material is wrong" before
     * a single paint value is touched.
     */
    /**
     * `reftyre`: the substitution control for the tyre, answering one question
     * that no amount of reading the material can answer.
     *
     * The tyre renders warm - R-B +40 against asphalt at +3 - while every input
     * measures neutral: the albedo map is 0.0828 mean linear at R-B -0.0013, the
     * road film is cool at 0x24252a and the dust is a neutral 0x4a4b4e. So the
     * warmth is being delivered by the light rather than by the material, and the
     * mechanism is available: a roughness-1.0 sidewall facing sideways integrates
     * the lower hemisphere, which at environment 2.4 is warm sunlit desert, while
     * the asphalt faces up at the cool sky and the paint is too smooth to
     * integrate much of anything.
     *
     * That is a hypothesis and it is not testable by comparing the tyre against
     * the asphalt, because those two differ in orientation *and* roughness as
     * well as in material - the comparison I first reached for and had to
     * withdraw. A neutral 0.18 grey card in the tyre's own mesh, at the tyre's
     * own position and orientation, holds everything constant but the material.
     * If the card comes out warm, the warmth is the environment and correct. If
     * it comes out neutral, the warmth is somewhere in the tyre's shader path
     * and the grime unit is the place to look.
     */
    const debugRefTyre = debugRaw === "reftyre";
    const debugRefDiel = debugRaw === "refdiel";
    const debugRefMetal = debugRaw === "refmetal";
    const debugRefBody = debugRefDiel || debugRefMetal;

    /**
     * `?carglsep=0` restores the pre-separation single conflated glass material,
     * so the reflection separation has an A/B from one bundle rather than across
     * two builds. Copied from Building's `?bglsep`, and for the reason it exists:
     * a before/after captured across two builds in a tree several agents write to
     * is not an A/B, and the failure is silent.
     *
     * Parsed with an explicit non-finite rejection. A flag a typo can disable is
     * not a flag - `?carglsep=x` must throw, not quietly take the default and
     * report the arm it was not testing.
     */
    const glassSepRaw = dbg.get("carglsep");
    const glassSepNum = glassSepRaw === null ? 1 : Number(glassSepRaw);
    if (!Number.isFinite(glassSepNum)) {
      throw new Error(`CarSystem: ?carglsep must be a number, got ${JSON.stringify(glassSepRaw)}`);
    }
    const glassSeparate = glassSepNum !== 0;

    /* ---------------- the site's own dirt load ---------------- */
    /**
     * Terrain publishes `groundAccum` so every system agrees about where dirt
     * collects. Adopting it here rather than keeping the hand-picked literals
     * below, so the car's film level comes from the lot it is parked in.
     *
     * Composed as floor plus gain over a **measured** range, not as a bare
     * multiplier. Building found that the hard way: `fines` reads 0.11-0.21 on
     * the swept forecourt and 0.013-0.047 behind the building, so a multiplier
     * tuned on one made its wall cleaner on the other. The range of a published
     * field is part of its contract.
     *
     * The range this car actually samples was probed before anything was written
     * against it, and the result changed the design: over the 2.1 x 4.9 m
     * footprint of the stall, `fines` spans only 0.133-0.176. A site-scale field
     * is very nearly flat across an object this small, so it can supply a
     * LEVEL - how dirty this lot is - and it cannot supply a PATTERN. Driving
     * per-panel variation from it would have produced a uniform wash that merely
     * looked data-driven. `swept` is 0.000-0.005 here and `grime` is identically
     * zero over the whole footprint, so neither is wired up at all; a field that
     * does not vary where you sample it is not a signal.
     *
     * LOT_FINES_* is the range measured over the stall, and the normalisation is
     * clamped, so if Terrain reshapes the lot this degrades to an endpoint rather
     * than extrapolating off the end of a contract it no longer has.
     */
    const accum = game.tryGet<GroundAccum>("groundAccum");
    const LOT_FINES_LO = 0.133;
    const LOT_FINES_HI = 0.176;
    /** 0..1 position of this stall within the dirt load the lot actually offers. */
    const lotDirt = (() => {
      if (!accum) return 0.5;
      const v = accum.fines(PLACE.x, PLACE.z);
      // Non-finite input must be rejected rather than compared against: every
      // comparison with NaN is false, so a NaN here would silently take the
      // floor and look like a clean lot.
      if (!Number.isFinite(v)) return 0.5;
      const t = (v - LOT_FINES_LO) / (LOT_FINES_HI - LOT_FINES_LO);
      return Math.max(0, Math.min(1, t));
    })();
    /** Floor plus gain. At the clean end of the lot's range, not at zero. */
    const dirt = (floor: number, gain: number) => floor + gain * lotDirt;

    /* ---------------- maps ---------------- */
    const grime = makeGrimeField(512, 4409);
    const rain = makeRainField(512, 3307);
    const paintDetail = makeCarPaint(512, 0.42, 3301);
    const alloy = makeAlloySkin(512, 3313);
    const tyreSkin = makeTyreSkin(512, 7171);
    const cloth = makeSeatCloth(256, 0.20, 3319);
    const plate = makePlate(512, 256, 3323);
    const reflectorN = makeReflector(256, 3329);
    this.textures.push(
      grime,
      rain,
      paintDetail.normalMap,
      paintDetail.roughnessMap,
      alloy.map,
      alloy.normalMap,
      alloy.roughnessMap,
      tyreSkin.map,
      tyreSkin.normalMap,
      tyreSkin.roughnessMap,
      cloth.normalMap,
      cloth.roughnessMap,
      plate.map,
      plate.normalMap,
      reflectorN
    );

    // The shell carries metre-scale UVs, so a tile covering `tileMetres` has to
    // repeat 1/tileMetres times to land at real-world size.
    const perMetre = (t: THREE.Texture, tileMetres: number) => {
      const c = t.clone();
      c.needsUpdate = true;
      c.repeat.setScalar(1 / tileMetres);
      this.textures.push(c);
      return c;
    };

    /* ---------------- materials ---------------- */

    // Clearcoat over a metallic base. The base is quite rough and quite dark;
    // nearly all of the shine on a real car comes from the clear layer above
    // it, and skipping that split is what makes procedural cars look like
    // painted plastic.
    const paint = new THREE.MeshPhysicalMaterial({
      color: PAINT,
      roughness: 0.42,
      // A solid automotive colour coat is a pigmented dielectric, not a metal.
      // This was 0.72, which crushed the diffuse term until everything below
      // the shoulder read as black, then 0.36 as a compromise - but both were
      // chosen while `envMapIntensity` was inert, so the environment could not
      // participate in the trade at all and the only way to get brightness was
      // from the diffuse side.
      //
      // With the binding live it was re-measured, tried at 0, and put back. The
      // luminance metric preferred 0 - flank mean 61.2 to 70.9, largest
      // single-row step 4.1 to 4.9, brighter *and* better differentiated - and
      // the frame it produced was a near-white car with the blue gone out of it.
      // Mean flank saturation is the number that sees it: 0.326 here against
      // 0.282 at metalness 0, and lowering `envMapIntensity` to compensate does
      // not bring it back (0.325 at 0.85) because what saturates the reflection
      // is the base colour tinting it, which is exactly what metalness buys.
      //
      // Worth keeping as a caution: brighter and higher-contrast measured better
      // on every luminance statistic while being visibly worse, so a metric that
      // cannot see pigment draining out of paint is the wrong one to tune on.
      /**
       * ZERO. A pigmented colour coat is a dielectric, and `metalness` is not a
       * shininess dial.
       *
       * It is the **mixing weight between two different BRDFs** - the dielectric
       * one, which has a coloured diffuse term and a white specular at F0 0.04,
       * and the metallic one, which has NO diffuse term and takes its specular
       * colour from the base colour. Every value strictly between 0 and 1 asks the
       * renderer to average two mutually exclusive physical models, which is a
       * category error rather than a tuning choice: it describes a material that
       * does not exist.
       *
       * The concrete cost here is that at 0.36 the diffuse term is scaled by
       * (1 - metalness), so **a third of the paint's diffuse was being deleted** -
       * and it was deleted immediately after the albedo was certified correct by
       * grey card at a delivered 0.0766 luminance. A correct albedo behind an
       * intermediate metalness is a correct number with a third of it thrown away
       * downstream, which is the hardest kind of error to find because both halves
       * look right in isolation.
       *
       * The comment above records that raising metalness measured better on every
       * luminance statistic while looking visibly worse. That reading was right
       * about the metric and wrong about the cause: what it was seeing was pigment
       * draining out of the paint, which is not a side effect of metalness but the
       * definition of it. The specular richness it was reaching for belongs to
       * `clearcoat`, which is already at 1.0 and is the physically correct way for
       * a colour coat to be glossy.
       *
       * Canopy found the same shape at 0.35 on its fixture housings, crushed to
       * p10 = 1 by three stacked darkenings each defensible alone.
       */
      metalness: 0.0,
      normalMap: perMetre(paintDetail.normalMap, paintDetail.tileMetres),
      normalScale: new THREE.Vector2(0.20, 0.20),
      roughnessMap: perMetre(paintDetail.roughnessMap, paintDetail.tileMetres),
      clearcoat: 1.0,
      clearcoatRoughness: 0.085,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.1, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
      dithering: true,
    });
    this.paintMat = paint;
    // Dawn after overnight rain: dried spots on the up-facing panels, drip
    // trails from the beltline, road film gathering along the lower body.
    applyGrime(paint as unknown as THREE.MeshStandardMaterial, {
      key: "car-paint",
      field: rain,
      scale: 0.62,
      film: dirt(0.158, 0.105),
      streak: 0.46,
      // Runs start at the top of the DLO, not at the belt: overnight rain
      // drains off the roof and down the glass and shoulder, so the trails
      // have to begin above the highest thing they cross.
      streakY: 1.42,
      streakFade: 0.70,
      // Low, deliberately. High stretch turns run-off into hair-fine threads;
      // rain drying on a panel leaves broad soft trails.
      streakStretch: 4.0,
      // First pass at this ran dust 0.66 / baseDark 0.52 and turned a
      // clearcoated blue car into matte olive primer, with the bottom third so
      // dark it read as a two-tone paint job rather than as dirt. Grime is
      // supposed to sit *on* paint you can still see.
      // Was 0.26, and it was half of why the car came back olive. This is the
      // second dust layer on the same panels (carGrime adds the other), and two
      // warm greys mixed into blue at a quarter each is not a dusty blue car,
      // it is a sage one. It is also wrong for the brief: overnight rain washes
      // the horizontal panels, it does not powder them. The rain signature is
      // `spots` and `streak`, which stay up.
      dust: dirt(0.075, 0.050),
      spots: 0.62,
      filmColor: new THREE.Color(0x39332b),
      // Pulled toward neutral. 0x968a78 is 30 points warmer in R than B, and on
      // a metallic blue that shift is the whole distance from blue to olive.
      dustColor: new THREE.Color(0x8d8a84),
      // Rocker grime, still the cheapest realism win on the car - nothing that
      // has been driven is clean down to the sill - but as a gradient rather
      // than a stripe.
      baseY: 0.60,
      baseFade: 0.34,
      baseDark: 0.27,
      roughGain: 0.95,
    });
    // The half of the weathering that has to know where the wheels are: spray
    // fans radiating out of each arch, rocker grime and road film wrapped round
    // the bumper corners. `applyGrime`'s masks are functions of height and
    // normal, so none of those can be expressed there.
    //
    // The shapes are baked per vertex and verified by tools/carweather.mjs.
    // These two numbers are the only things that should need touching when this
    // is finally looked at on a GPU - which is the point, because the last
    // attempt at weathering was tuned as a shape and had to be re-authored.
    // Biased low on purpose: too subtle is a one-line fix, too strong cost a
    // round last time.
    this.weather = applyCarWeather(paint, {
      // Dust down hard from 0.30. See the note on applyGrime's `dust` above:
      // these two stack on exactly the same up-facing panels, and together they
      // turned a clearcoated blue car sage-grey. Rain-washed panels want very
      // little of this.
      dust: 0.12,
      // Film up from 0.42, then to 0.74 once reflectance went live. This is the
      // half of the weathering the brief actually asks for - road spray at the
      // sills, fans out of the arches, grime round the bumper corners - and it
      // lives low on the body where it cannot flatten the paint.
      //
      // 0.55 was authored against an inert `envMapIntensity`, and read as a
      // clean car in the first round after the binding landed: with nothing
      // reflecting off the lower body there was no reflection for the film to
      // interrupt, so it was doing almost nothing visible. Now there is.
      film: 0.95,
      // *Lowered*, against the received advice, because on this surface it
      // inverts. Killing a reflection reads as dirt without darkening the paint
      // when the panel is reflecting sky; a rocker is reflecting tarmac, so
      // raising roughness there replaces a dark ground reflection with blurred
      // sky and makes the sill *brighter* than the shoulder.
      //
      // Swept live through `__CAR_WEATHER`, measuring upper-flank to sill
      // falloff (positive means the sill is darker, which is what grime does):
      //
      //   film 0.55  rough 0.55  ->   2.8%
      //   film 0.74  rough 0.66  ->  -6.7%   the sill lit up
      //   film 0.74  rough 0.40  ->   8.9%
      //   film 0.95  rough 0.25  ->  19.3%
      //   film 1.20  rough 0.25  ->  22.6%
      //
      // 0.95/0.25 rather than the last row: past this the lower body starts
      // heading back toward the matte primer overshoot that cost a round.
      rough: 0.25,
      dustColor: new THREE.Color(0x8f8d88),
      filmColor: new THREE.Color(0x2e2a25),
    });

    // Tinted glass. Transparent rather than transmissive: transmission would
    // hide the interior behind a blur, and the interior is the whole point of
    // modelling it.
    const glass = new THREE.MeshPhysicalMaterial({
      /**
       * Black, not a dark blue-grey. Copied from Building's storefront glazing
       * result rather than rediscovered.
       *
       * Alpha blending computes `src * a + bg * (1 - a)`. With a tinted `color`
       * the `src` term carries a **lit diffuse veil**, and glass has no diffuse
       * term at all - it transmits and it reflects. That veil is the whole reason
       * a reviewer described these windows as "a uniform dark tint slab": at
       * a = 0.62 the surface was adding 62% of a lit 0x1c2226 over whatever was
       * behind it, which buries the cabin under a flat wash that does not vary
       * with what it is covering.
       *
       * Setting the diffuse to black collapses `src` to the specular and
       * clearcoat terms only, so the blend becomes `reflection + bg * 0.38` -
       * pure transmittance at 38%, which is what a mid-tinted automotive glazing
       * actually does, plus a reflection that is genuinely additive. The
       * interior geometry already exists and should now be visible through it.
       *
       * The other half of the fix is below: with reflection still inside `src` it
       * was multiplied by `a` along with everything else, so it was dimmed by the
       * same 38% and got *weaker* as the pane got more transparent - the
       * anti-correlation Building measured at +3.1 head-on and -0.7 at grazing.
       * `glassRefl` moves it to an additive leaf where its strength is
       * independent of the pane's transparency.
       */
      color: 0x000000,
      roughness: 0.055,
      metalness: 0.0,
      transparent: true,
      /**
       * RE-DERIVED, because the separation below changed what this number means.
       *
       * Building's warning is that keeping a value identical through a
       * separation is only the first of two steps, and skipping the second
       * leaves a number that was correct for a job it no longer does - which is
       * how a fixed architecture keeps a broken value. This one has to move,
       * because 0.62 was a *conflated* figure covering a lit veil, the
       * front-surface reflection and the bulk absorption all at once.
       *
       * In its new single meaning it is absorption through the pane only. A
       * mid-tinted automotive glazing absorbs roughly a third; the front-surface
       * reflection is now on `glassRefl` and must not be paid for twice. 0.34
       * gives a transmittance of 0.66.
       *
       * That is a much clearer pane than before, and it is the correct answer to
       * the "uniform dark tint slab" complaint rather than a contradiction of it:
       * a car's windows read dark in daylight because the *cabin* is dark, not
       * because the glass is. Modelling the darkness in the glass is what flattens
       * it, because a veil cannot vary with what is behind it and an interior can.
       */
      opacity: 0.34,
      depthWrite: false,
      /**
       * Clearcoat dropped, not moved. It was a second specular lobe standing in
       * for the reflection this material could not deliver, and it is not
       * physical here: clearcoat models a coating *over* a base layer, whereas
       * glass is itself the smooth surface. With `ior` at 1.52 the BRDF's own
       * F0 lands at 0.043 and the Fresnel curve does the rest, so the lobe was
       * both redundant and unaccountable.
       */
      ior: 1.52,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.6, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      //
      // Zeroed when separated, along with `specularIntensity`: EVERY reflective
      // term moves to the additive leaf, and `specularIntensity` is the one that
      // matters most because it zeroes F0 - so the direct sun glint moves across
      // too. A sun glint is as much a front-surface reflection as the sky is, and
      // leaving it here would have it dimmed by the pane's transparency exactly
      // as the sky reflection was.
      envMapIntensity: glassSeparate ? 0 : 1.0,
      specularIntensity: glassSeparate ? 0 : 1,
      side: THREE.DoubleSide,
    });
    /**
     * Cloned HERE, before `applyGrime`, and that ordering is load-bearing.
     *
     * `applyGrime` patches the shader to mix the diffuse toward a dust colour and
     * a film colour. On a normal material that is dirt. On a **black-diffuse
     * additive** leaf it is light: a non-black diffuse under `AdditiveBlending`
     * makes the pane glow the colour of its own dust, brightest where it is
     * dirtiest. Cloning after the patch would have inherited exactly that.
     *
     * Building takes its clones before applying its glazing Fresnel for the
     * mirror-image reason. The general shape is that a material transformation
     * written for one blending mode is not safe to inherit into another, and
     * clone order is the only thing that decides which side of it you land on.
     */
    const glassRefl = glassSeparate ? glass.clone() : null;
    if (glassRefl) {
      glassRefl.color = new THREE.Color(0x000000);
      glassRefl.specularIntensity = 1;
      /**
       * DERIVED, not held. 1.0 is the only value that is not a compensation.
       *
       * `envMapIntensity` multiplies the environment radiance a surface returns.
       * Physics fixes that at 1.0: above it the surface returns more of its
       * surroundings than it receives, below it the energy goes nowhere. How much
       * the pane *actually* reflects is set by F0 and roughness - here F0 0.043
       * from IOR 1.52, which is the whole point of separating the leaf - so this
       * multiplier has no job left to do. There is nothing to tune.
       *
       * It was held at 1.0 through the separation deliberately, so that if the
       * architecture change moved the reflection it would be the architecture that
       * moved it. That was method, not derivation, and this is the derivation:
       * having a physically correct F0 in place, 1.0 is what the multiplier must
       * be, and any other value would be masking the F0 rather than tuning gloss.
       *
       * SIX SUB-1.0 VALUES REMAIN IN THIS FILE and they are the same class. The
       * comment at the paint already retired every value ABOVE 1.0 on the ground
       * that a surface cannot return more than it receives - but values BELOW 1.0
       * are equally compensations, because roughness and F0 already encode how
       * much a dielectric returns. They are listed in the handover rather than
       * changed here: each needs its own capture, and seven metalness values in
       * one round is already as much material change as one round can verify.
       */
      glassRefl.envMapIntensity = 1.0;
      glassRefl.opacity = 1;
      glassRefl.transparent = true;
      glassRefl.blending = THREE.AdditiveBlending;
      glassRefl.depthWrite = false;
      glassRefl.side = THREE.FrontSide;
      this.materials.push(glassRefl);
    }
    applyGrime(glass as unknown as THREE.MeshStandardMaterial, {
      key: "car-glass",
      field: rain,
      scale: 0.45,
      film: dirt(0.075, 0.050),
      streak: 0.28,
      streakY: 1.42,
      streakFade: 0.55,
      streakStretch: 11.0,
      dust: dirt(0.150, 0.100),
      spots: 0.70,
      filmColor: new THREE.Color(0x40403a),
      dustColor: new THREE.Color(0x8f8c82),
      roughGain: 1.5,
    });

    // Everything you see through a shut line or an open arch.
    /**
     * THE TEST EVERY SUB-1.0 `envMapIntensity` IN THIS FILE MUST PASS: name the
     * geometry that does the occluding, or go to 1.0.
     *
     * 1.0 is the only physically correct value - it multiplies the environment
     * radiance a surface returns, so above it a surface returns more than it
     * receives and below it energy vanishes. This file already retired every value
     * above 1.0 on exactly that ground.
     *
     * But there is one legitimate reason to sit below it, and it is a real missing
     * physical term rather than a taste adjustment. `scene.environment` is a single
     * PMREM sampled with **no occlusion whatsoever**, so a surface sealed inside
     * the bodyshell receives the full outdoor sky in the shader. The reduced value
     * stands in for **occlusion of the environment**, and the honest fix is an AO
     * map rather than a number - this is the crude version, held deliberately.
     *
     * That gives the same rule-plus-control shape as the contact decal: ask what
     * quantity the constant stands in for, then ask whether anything owns it. Here
     * the answer is a fraction of the sky that geometry hides, which is
     * dimensionless and therefore CORRECTLY constant when the sky brightens - the
     * opposite conclusion to the decal, from the same question, because that one
     * was a fraction of a total the environment sets and this one is not.
     *
     * Applying the test swept two of eight: the alloy wheel face at 0.95 and the
     * exterior black trim at 0.65, neither of which has an enclosure to name. The
     * six that remain each name theirs, in their own comment, and a value that
     * cannot is a compensation wearing an occlusion costume.
     *
     * ENCLOSURE: the cavity behind every shut line and aperture, which is a closed
     * box open only through a 6 mm gap.
     */
    const cavity = new THREE.MeshStandardMaterial({
      color: 0x0d0e10,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.28,
      side: THREE.DoubleSide,
    });
    // Window rubber. Matte, black, and almost unlit - it is the dark line that
    // makes glass read as set into an aperture rather than painted onto one.
    const seal = new THREE.MeshStandardMaterial({
      color: 0x121314,
      roughness: 0.88,
      metalness: 0.0,
      // ENCLOSURE: the aperture reveal it sits in, which wraps it on three sides.
      envMapIntensity: 0.22,
      side: THREE.DoubleSide,
    });
    const headliner = new THREE.MeshStandardMaterial({
      color: 0x8b877e,
      roughness: 0.95,
      metalness: 0.0,
      // ENCLOSURE: the cabin. It sees sky only through the glazing.
      envMapIntensity: 0.5,
      side: THREE.DoubleSide,
    });

    /* ------------- per-corner wheel materials: NOTES.md case 22 -------------
     *
     * One material set per wheel, not one shared by four. `applyGrime` keys off
     * object-space position, so four instances of one rim mesh sharing one
     * material get byte-identical dirt in identical places - measured at exactly
     * 0.00/255 by `tools/probe-instancing.mjs`, against 33-53 for correctly
     * phased instances. Neither `hub.rotation.y` nor the two tread phases in
     * `buildTyre` addresses that; see the block comment in carWheelVary.ts for
     * why each of those looks like a mitigation and is not.
     *
     * Every grime call below goes through `unit`, which carries that corner's
     * phase. That indirection is the part that has to stick: a bare `applyGrime`
     * added here later would silently opt its material out and nothing would
     * complain, which is precisely how this defect survived three critic rounds
     * on the pumps.
     */
    const unitGrime =
      (v: WheelVariation) =>
      (mat: THREE.MeshStandardMaterial, o: Parameters<typeof applyGrime>[1]) =>
        applyGrime(mat, { ...o, fieldOffset: v.fieldOffset, fieldFlip: v.fieldFlip });

    const makeTyreMat = (v: WheelVariation) => {
      // Substitution control: a plain 0.18 grey card in the tyre's own mesh, with
      // no map, no grime and no tint, so the only variable left is the material.
      if (debugRefTyre) {
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.18, 0.18, 0.18),
          roughness: 1.0,
          metalness: 0,
          envMapIntensity: 1.0,
        });
      }
      const unit = unitGrime(v);
      const m = new THREE.MeshStandardMaterial({
        // No multiplier here, and it must stay that way.
        //
        // This material briefly carried `color: Color(5.4, 5.4, 5.4)`. That was
        // a compensation for a real defect measured off the texture on the CPU:
        // `makeTyreSkin`'s albedo was arriving at 0.0060-0.0086 linear, mean
        // 0.0070, about six times under carbon-black rubber, because the
        // authored display values were written to bytes and handed to an
        // sRGB-tagged DataTexture without being encoded, so 0.055 authored
        // decoded to 0.0043. The tyres measured a median display luminance of
        // 0.0 over 105416 px: not dark, clipped.
        //
        // Pumps fixed it at source in `hardsurface.ts`, which owns that
        // function, by routing the albedo through `linearToSrgb` on the way in.
        // Delivered reflectance is now 0.0704-0.0910, mean 0.0781 — the
        // 0.055-0.09 the call site always claimed. Stacking 5.4x on top of the
        // corrected map would land the tyre near 0.42 linear, a light grey
        // tyre, so the compensation came straight back out.
        //
        // The general rule, from that audit: a palette taken from physical
        // reference is linear and must be encoded, a palette tuned by eye
        // against renders is already display-referred and must not be. The two
        // are indistinguishable in source. Measure delivered reflectance before
        // "fixing" any colour in this file for consistency.
        map: tyreSkin.map,
        normalMap: tyreSkin.normalMap,
        normalScale: new THREE.Vector2(1.1, 1.1),
        roughnessMap: tyreSkin.roughnessMap,
        roughness: 1.0,
        metalness: 0.0,
        // The physical default, restored. This was 0.42, and 0.42 is not a
        // measurement of anything — a rough dielectric does not reflect less of
        // its surroundings than it reflects. The control that found it put a
        // plain 0.5-albedo material in this exact mesh, in this exact pose,
        // with the same shadow flags, and got a median of 68.1 against this
        // material's 3.1. Converted out of the transfer curve that is 63x the
        // radiance for 6.4x the albedo, so about 10x of the tyre's darkness was
        // the material throwing light away rather than the arch withholding it.
        // Not a value to tune against the current environment (NOTES: the
        // PMREM's lower hemisphere is flat), which is the point of choosing the
        // default rather than a number that looks right today.
        envMapIntensity: 1.0,
      });
      // Rubber is near-black with a dusty *grey* cast. The previous values put a
      // warm tan film (0x8a7f6c) over a tyre albedo that is itself warm, and two
      // additive warm ramps made the tyres the same colour as the fuel pumps.
      // Half of that fix is here; the other half is `makeTyreSkin`'s albedo in
      // hardsurface.ts, which belongs to another agent and is reported instead.
      unit(m, {
        key: "car-tyre",
        field: grime,
        scale: 0.30,
        // Road film is the kerbside/offside asymmetry: the gutter wheels run in
        // the silt. A 0.58-0.92 spread rather than a token one, because four
        // wheels are seen in a single frame and a subtle difference between two
        // objects side by side reads as shading, not as dirt.
        film: 0.20 + 0.26 * v.roadFilm,
        streak: 0.0,
        // Dust halved, and its colour brought down to roughly rubber's own
        // reflectance. Both numbers were authored against the broken albedo,
        // when the tyre delivered 0.0070 and *any* dust was the only thing
        // visible on it. On the corrected 0.0781 base they inverted the result:
        // 0x6e6f72 is 0.155 linear, twice the rubber under it, so a 0.30-0.50
        // coverage of it dominated the surface and the sunlit tyres came out
        // pale tan — lighter than the asphalt they stand on, which no tyre is.
        //
        // This is the third stale compensation found in two sessions and they
        // all have one shape: **a correction authored on top of a broken base
        // becomes a defect the moment the base is fixed, and it does not
        // announce itself.** The 5.4x colour multiplier was removed the same
        // hour the source landed because it was one line with a comment on it;
        // this one survived because it is a plausible-looking dust parameter
        // several layers away from the albedo it was compensating for.
        dust: 0.15 + 0.10 * v.roadFilm,
        // Cool, dark road film and a neutral grey dust. Slightly blue rather
        // than dead neutral: real tyre dust at dawn picks up sky, not sun.
        filmColor: new THREE.Color(0x24252a),
        dustColor: varyColour(new THREE.Color(0x4a4b4e), v),
        baseY: -0.20,
        baseFade: 0.14,
        baseDark: 0.24 + 0.12 * v.roadFilm,
        roughGain: 0.4,
      });
      return m;
    };

    const makeAlloyMat = (v: WheelVariation) => {
      const unit = unitGrime(v);
      const m = new THREE.MeshStandardMaterial({
      map: alloy.map,
      normalMap: alloy.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: alloy.roughnessMap,
      roughness: 1.0,
      // Was 0.92 with envMapIntensity 1.1, and the rim came out brass however
      // neutral the maps underneath it were made. At that metalness the wheel is
      // very nearly a mirror, and a mirror at dawn reflects an orange sky - for
      // a metal the albedo *tints* the reflection rather than replacing it, so
      // neutralising the texture could never have fixed this. An alloy wheel is
      // painted and clearcoated, not polished: lowering metalness puts a white
      // dielectric specular in front of the environment, which is what keeps a
      // real one reading silver-grey under a low warm sun.
      // An alloy wheel is PAINTED and clearcoated, not polished - the comment above
      // already said so while the value said otherwise. A painted surface is a
      // dielectric, so the white specular belongs to clearcoat and the colour to
      // diffuse; 0.72 tinted the reflection with the base colour and deleted 72% of
      // the diffuse to pay for it.
      metalness: 0.0,
      // SWEPT TO 1.0. A wheel face looks straight out at the sky - there is no
      // enclosure to name, so there is nothing for a reduced value to stand in for.
      // 0.95 was a residual nudge, and a nudge with no physical referent is exactly
      // the class being retired here.
      envMapIntensity: 1.0,
      // A slight cool cast, which is what cast aluminium actually has and what
      // stops it reading as brass.
      //
      // Measured rather than guessed, because the first two attempts at this
      // chased the wrong thing: in the same frame the tarmac is R-B 41, the
      // tyre 40 and the rim 54, so most of the "gold" is simply a 6-degree
      // orange sun and only about 13 points of it were ever the wheel's own.
      // Neutralising the maps could not fix a warm light source, and dropping
      // metalness alone made it brighter and therefore more obviously gold.
      // Hue as well as lightness. A set of four that differs only in value
      // reads as one object under four exposures - the trap one level down from
      // the phase bug, and the one the pumps fell into immediately after fixing
      // their phase.
      color: varyColour(new THREE.Color(0xdde4ee), v),
      dithering: true,
      });
      unit(m, {
        key: "car-alloy",
        field: grime,
        scale: 0.20,
        // Brake dust. Fronts do roughly 70% of the braking on a front-biased
        // road car and the pads throw it straight at the rim behind them, so
        // the fronts are visibly dirtier than the rears on almost any car in a
        // car park. 0.34 to 0.86 is a 2.5x spread, chosen to be legible in a
        // frame that shows all four rather than merely present.
        film: 0.14 + 0.30 * v.brakeDust,
        streak: 0.0,
        dust: 0.16 + 0.24 * v.brakeDust,
        spots: 0.30,
        // Brake dust is iron oxide, so it is a *hue* change, not a darkening.
        // The last round put 30 luminance points between the front and rear
        // rims and a critic still read "four copies... identical and clean":
        // value alone does not say dust to anyone.
        //
        // The earlier bronze-wheel overshoot came from warming every rim at
        // once. Keying the warmth to `brakeDust` instead ramps from a neutral
        // grey on the rears to a warm iron brown on the fronts, so the axles
        // differ chromatically and the rears cannot go bronze by construction.
        filmColor: new THREE.Color(0x343230).lerp(new THREE.Color(0x4a3529), v.brakeDust),
        dustColor: varyColour(new THREE.Color(0x555049).lerp(new THREE.Color(0x6d5340), v.brakeDust), v),
        roughGain: 0.6 + 0.8 * v.brakeDust,
      });
      // Consume the baked `aWeather` mask. Same per-corner brake-dust weighting
      // as the grime above, so the two layers reinforce rather than average out.
      this.wheelWeather.push(
        applyCarWeather(m, {
          dust: 0.06 + 0.14 * v.brakeDust,
          film: 0.18 + 0.20 * v.roadFilm,
          rough: 0.22 + 0.18 * v.brakeDust,
          dustColor: new THREE.Color(0x5c5b5a).lerp(new THREE.Color(0x6f5642), v.brakeDust),
          filmColor: new THREE.Color(0x2a2827),
        })
      );
      return m;
    };

    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x2a2b2d,
      roughness: 0.72,
      // A lamp housing is moulded dark plastic. Named `darkMetal`, which is what
      // carried the value: the name asserted a material class and nothing checked it
      // against the part. At roughness 0.72 this was a rough metal with no diffuse
      // at all, standing in for a dull black polymer that is almost all diffuse.
      metalness: 0.0,
      // ENCLOSURE: the lamp housing, sealed behind the lens.
      envMapIntensity: 0.5,
    });
    // Disc and caliper. Not grimed, so there is no field to phase, but a disc
    // rusts overnight in proportion to how little it was used - the rears on a
    // parked car are the ones with the orange bloom - so the corner's brake-dust
    // weight drives its colour in the opposite direction.
    const makeBrakeMat = (v: WheelVariation) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x4b423a).lerp(new THREE.Color(0x6d4a30), 1 - v.brakeDust),
        roughness: 0.55 + 0.16 * (1 - v.brakeDust),
        // A brake disc is bare ferrous metal, so this one resolves UPWARD. 0.85 was
        // reaching for metal and stopping short; the two ends are the only honest
        // values and this material sits at the metal end rather than between them.
        metalness: 1.0,
        // ENCLOSURE: the wheel, behind the arch liner.
        envMapIntensity: 0.7,
      });

    const chrome = new THREE.MeshStandardMaterial({
      color: 0xb9bcc0,
      roughness: 0.16,
      metalness: 1.0,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.45, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
    });
    applyGrime(chrome, {
      key: "car-chrome",
      field: rain,
      scale: 0.35,
      film: dirt(0.120, 0.080),
      streak: 0.10,
      streakY: 1.0,
      streakFade: 0.5,
      dust: dirt(0.188, 0.125),
      spots: 0.4,
      filmColor: new THREE.Color(0x4d4a44),
      dustColor: new THREE.Color(0x8e887c),
      roughGain: 1.2,
    });

    // The centre caps are the same recipe as the body brightwork above, but
    // they are four instances of one mesh and so need their own key and their
    // own phase. The body trim keeps `car-chrome`: it is a single instance, and
    // there is nothing repeated for the probe to compare it against.
    const makeCapMat = (v: WheelVariation) => {
      const m = new THREE.MeshStandardMaterial({
        color: varyColour(new THREE.Color(0xb9bcc0), v),
        roughness: 0.16,
        metalness: 1.0,
        // SWEPT TO THE PHYSICAL DEFAULT. Was 1.45, and every value above 1.0
        // in this file was one: it says a surface returns more of its
        // surroundings than its surroundings contain. All eight sat on the
        // shiniest materials in the car, which is exactly where a dim or flat
        // environment hurts most and so exactly where someone compensates.
        // They predate the world capture and two of them predate
        // envMapIntensity working at all (NOTES case 26). Now that
        // scene.environment is a PMREM of the real site, an invented
        // multiplier is visible error rather than a harmless lift.
        envMapIntensity: 1.0,
      });
      unitGrime(v)(m, {
        key: "car-wheel-cap",
        field: rain,
        // Tighter than the body brightwork's 0.35, which is a tile nearly four
        // times the width of the cap itself: at that scale the field is very
        // nearly constant across the part, so phasing it only swaps one flat
        // value for another and the four caps measured 22-29/255 against a
        // 33-53 band. Roughly one tile across the cap gives the phase something
        // to actually move.
        scale: 0.13,
        film: 0.12 + 0.14 * v.roadFilm,
        streak: 0.10,
        streakY: 1.0,
        streakFade: 0.5,
        dust: 0.16 + 0.20 * v.brakeDust,
        spots: 0.4,
        filmColor: new THREE.Color(0x4d4a44),
        dustColor: varyColour(new THREE.Color(0x8e887c), v),
        roughGain: 1.2,
      });
      return m;
    };

    const blackTrim = new THREE.MeshStandardMaterial({
      color: 0x191a1b,
      roughness: 0.66,
      // Black polymer trim. 0.15 is the most seductive form of this error - small
      // enough to read as a nudge, and it still deletes 15% of the diffuse from a
      // part whose entire appearance is diffuse.
      metalness: 0.0,
      // SWEPT TO 1.0. Exterior trim on the outside of the bodyshell, fully open to
      // the sky. 0.65 was deleting a third of its environment response with no
      // enclosure to justify it.
      envMapIntensity: 1.0,
    });
    applyGrime(blackTrim, {
      key: "car-black-trim",
      field: grime,
      scale: 0.34,
      film: dirt(0.255, 0.170),
      streak: 0.16,
      streakY: 0.85,
      streakFade: 0.5,
      // Was 0.33 dust over a 0x767573 grey. This material lines the grille and
      // intake, and a lit grey dust under a 6-degree orange sun turned the one
      // part of the car that must read as a void into "two rectangles of muddy
      // brown noise". The inside of an aperture is a shadow: it wants almost no
      // dust and what little there is wants to be cool, not warm.
      dust: dirt(0.090, 0.060),
      filmColor: new THREE.Color(0x232427),
      dustColor: new THREE.Color(0x4a4c50),
      baseY: 0.52,
      baseFade: 0.24,
      baseDark: 0.28,
    });

    const clearLens = new THREE.MeshPhysicalMaterial({
      // Near-clear, and deliberately dim. A bright lens under a wide sky
      // saturates and the whole lamp turns into a white sticker.
      color: 0xa8adb1,
      roughness: 0.045,
      metalness: 0.0,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.7, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
    const redLensMat = new THREE.MeshPhysicalMaterial({
      color: 0x8e1113,
      roughness: 0.10,
      metalness: 0.0,
      transparent: true,
      opacity: 0.80,
      depthWrite: false,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.5, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
    const amberLens = new THREE.MeshPhysicalMaterial({
      // Was 0xb4661a, which at this opacity read as a flat saturated orange
      // sticker on the bumper. An unlit indicator is a dull amber-brown that
      // mostly shows its reflector through the lens.
      color: 0x8a5620,
      roughness: 0.14,
      metalness: 0.0,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      clearcoat: 1.0,
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.4, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
    const reflectorMat = new THREE.MeshStandardMaterial({
      color: 0xd8dade,
      roughness: 0.10,
      metalness: 1.0,
      normalMap: reflectorN,
      normalScale: new THREE.Vector2(1.0, 1.0),
      // SWEPT TO THE PHYSICAL DEFAULT. Was 1.6, and every value above 1.0 in
      // this file was one: it says a surface returns more of its surroundings
      // than its surroundings contain. All eight sat on the shiniest materials
      // in the car, which is exactly where a dim or flat environment hurts
      // most and so exactly where someone compensates. They predate the world
      // capture and two of them predate envMapIntensity working at all (NOTES
      // case 26). Now that scene.environment is a PMREM of the real site, an
      // invented multiplier is visible error rather than a harmless lift.
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });

    const clothMat = new THREE.MeshStandardMaterial({
      color: 0x3c3a38,
      roughness: 1.0,
      metalness: 0.0,
      normalMap: perMetre(cloth.normalMap, cloth.tileMetres),
      roughnessMap: perMetre(cloth.roughnessMap, cloth.tileMetres),
      // ENCLOSURE: the cabin interior.
      envMapIntensity: 0.35,
    });
    const cabinPlastic = new THREE.MeshStandardMaterial({
      color: 0x2c2b2a,
      roughness: 0.78,
      metalness: 0.0,
      // ENCLOSURE: the cabin interior.
      envMapIntensity: 0.35,
    });
    const plateMat = new THREE.MeshStandardMaterial({
      map: plate.map,
      normalMap: plate.normalMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.58,
      // A number plate is painted aluminium under a retroreflective film. Both
      // layers are dielectric; the aluminium is never the visible surface.
      metalness: 0.0,
      // SWEPT TO 1.0. A number plate faces straight out of the rear panel. The plate
      // recess is 10 mm deep and hides almost none of the hemisphere, so there is no
      // enclosure worth naming.
      envMapIntensity: 1.0,
    });

    this.materials.push(
      paint,
      glass,
      cavity,
      seal,
      headliner,
      darkMetal,
      chrome,
      blackTrim,
      clearLens,
      redLensMat,
      amberLens,
      reflectorMat,
      clothMat,
      cabinPlastic,
      plateMat
    );

    if (forced) {
      // NOTES.md rule: prove the injection reaches the screen before believing
      // any of the tuning above.
      for (const m of this.materials) forceGrime(m as THREE.MeshStandardMaterial);
    }

    /* ---------------- assembly ---------------- */

    const car = new THREE.Group();
    car.name = "parked-car";

    // Zero the surface-projection counters before anything is built, so what
    // lands on `__CAR` is this car's tally and not an accumulation. A non-zero
    // count means a part is being laid on a substituted flat plane instead of
    // the real fascia - NOTES.md case 14, which cost two critic passes because
    // nothing anywhere said so. The capture harness fails a run on it.
    resetProjectionStats();
    const shell = buildCarShell({
      smooth: force.includes("smooth"),
      flatCuts: force.includes("flatcuts"),
    });
    /**
     * `name` is not optional, and that is deliberate. `tools/probe-unseen.mjs`
     * reports defects per mesh, and it found two unnamed 2-triangle meshes in
     * this car drawing nothing at all; an unnamed mesh cannot be routed to
     * anyone, including to me. Making the parameter required means tsc, not a
     * later reader, is what notices a new part with no name.
     */
    const add = (g: THREE.BufferGeometry, m: THREE.Material, name: string, castShadow = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.name = name;
      car.add(mesh);
      return mesh;
    };

    /**
     * Flat, unlit, un-tone-mapped identification colours for the throwaway
     * grille round. `toneMapped: false` is the load-bearing part: with ACES at
     * exposure 1.25 in the way, a pure hex would not survive to the PNG and the
     * read would be back to eyeballing hues. Off it, the pixel value in the
     * capture *is* the authored hex, so "which surface owns this pixel" becomes
     * an exact byte match rather than a judgement.
     */
    const DEBUG_COLOURS: Record<string, number> = {
      "car-fascia": 0xff0000,
      "grille-backing": 0xff00ff,
      "grille-slat": 0x00ffff,
      "grille-divider": 0x0000ff,
      "grille-frame": 0x00ff00,
      "grille-band": 0xffff00,
      "grille-caprail": 0xffffff,
      "nose-badge": 0xff8000,
      "intake-backing": 0x8000ff,
      "intake-slat": 0x00ff80,
      "intake-divider": 0x004080,
      "intake-frame": 0x80ff00,
      "intake-band": 0xff0080,
      "fog-bezel": 0x008080,
      "fog-lens": 0x808000,
      "plate-panel": 0x800040,
      "plate-rim": 0x40ff80,
      // arch mask
      "arch-body": 0xff0000,
      "arch-lip": 0x00ff00,
      "arch-liner": 0x0000ff,
      "arch-sill": 0xffff00,
      "arch-tyre": 0xff00ff,
      "arch-rim": 0x00ffff,
    };
    const debugMat = (name: string): THREE.MeshBasicMaterial => {
      const hex = DEBUG_COLOURS[name];
      if (hex === undefined) throw new Error(`car: no debug colour for surface "${name}"`);
      const m = new THREE.MeshBasicMaterial({ color: hex, toneMapped: false });
      this.materials.push(m);
      return m;
    };

    // 0.18 linear, written as a linear triple rather than a hex. A hex here
    // would be decoded from sRGB and land at 0.0275, and the whole point of a
    // grey card is that its reflectance is the number you think it is.
    const greyCard = new THREE.Color().setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace);
    const refBody = debugRefBody
      ? new THREE.MeshStandardMaterial(
          debugRefMetal
            ? { color: 0xffffff, roughness: 0.12, metalness: 1.0, envMapIntensity: 1.0 }
            : { color: greyCard, roughness: 0.25, metalness: 0.0, envMapIntensity: 1.0 }
        )
      : null;
    if (refBody) this.materials.push(refBody);
    const bodyMesh = add(
      bakeCarWeather(shell.body),
      refBody ?? (debugFront ? debugMat("car-fascia") : debugArch ? debugMat("arch-body") : paint),
      "car-body"
    );
    const glassMesh = add(shell.glass, glass, "car-glass", false);
    glassMesh.renderOrder = 3;

    /**
     * The reflection half of the glazing, on its own leaf over the same geometry.
     *
     * Black diffuse, so the only thing this material can emit is specular.
     * `metalness` 0 with `ior` 1.52 gives the physically correct F0 of 0.043, and
     * the BRDF's own Fresnel curve then does what a glancing reflection off glass
     * actually does - no rim term, nothing hand-tuned.
     *
     * `AdditiveBlending` at `opacity: 1` is the point of the whole exercise: it
     * makes the reflection's strength independent of the pane's transparency.
     * Inside the single conflated material the reflection was multiplied by
     * `opacity` along with the diffuse, so a *more* transparent pane reflected
     * *less* - backwards, and worst at grazing angles where glass reflects most.
     *
     * Rendered after the transmission leaf, which is not optional: alpha-over
     * then additive composites correctly, the reverse order does not.
     *
     * FrontSide although the transmission leaf is DoubleSide. The transmission
     * leaf needs both faces because you see the far window through the near one;
     * the reflection leaf must not, or the inside surface of the far glass adds a
     * second copy of the exterior environment.
     *
     * `envMapIntensity` is deliberately LEFT at the 1.0 the conflated material
     * carried. Separating a parameter and re-tuning it in the same change makes
     * the measurement worthless - you cannot tell the architecture from the
     * number. Unlike `opacity` above, this value's meaning did not change, so the
     * two-step rule says hold it and re-derive only after measuring.
     */
    if (glassRefl) {
      const reflMesh = add(shell.glass, glassRefl, "car-glass-reflection", false);
      reflMesh.renderOrder = 4;
    }
    // Slot walls, then the reveals around every aperture, then the inner skin
    // they look onto. Without the first two a shut line is a painted stripe
    // and the glass sits on the body instead of in it.
    add(
      shell.slots,
      debugSlots
        ? new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide })
        : cavity,
      "car-slots",
      false
    );
    // Blacked-out pillars. Semi-gloss, not dead matte: a B-pillar applique is
    // a glossy plastic panel and picks up a soft vertical smear of sky, which
    // is a large part of why it reads as trim rather than as a hole.
    add(
      shell.pillars,
      new THREE.MeshStandardMaterial({
        color: 0x0b0c0e,
        roughness: 0.34,
        metalness: 0.0,
        // SWEPT TO 1.0. The comment above says this panel exists to pick up a soft
        // vertical smear of sky - and 0.85 was damping by 15% the exact term that
        // smear comes from. Prose and value disagreeing again, as with the alloy.
        envMapIntensity: 1.0,
      }),
      "car-pillars",
      false
    );
    add(shell.seals, seal, "car-seals", false);
    add(shell.inner, cavity, "car-inner-skin", false);
    add(shell.headliner, headliner, "car-headliner", false);

    // Interior first, so it is in the depth buffer before the glass draws.
    const interior = buildInterior();
    add(interior.cloth, clothMat, "car-interior-cloth", false);
    add(interior.plastic, cabinPlastic, "car-interior-plastic", false);

    const trim = buildTrim({ debugFront });
    add(trim.chrome, chrome, "car-trim-chrome");
    add(trim.black, blackTrim, "car-trim-black");
    add(bakeCarWeather(trim.body), debugFront ? debugMat("car-fascia") : paint, "car-trim-body");
    add(trim.rubber, blackTrim, "car-trim-rubber");
    if (debugFront) {
      if (!trim.debugFront.length) throw new Error("car: ?cardebug=front produced no split surfaces");
      for (const part of trim.debugFront) add(part.geo, debugMat(part.name), `dbg-${part.name}`);
      console.log(`[car] cardebug=front: ${trim.debugFront.length} surfaces flat-coloured`);
    }
    // Arch lips are painted; the sills are the scuffed dark cladding that
    // catches everything the tyres throw forward.
    add(
      bakeCarWeather(buildArchLips()),
      debugFront ? debugMat("car-fascia") : debugArch ? debugMat("arch-lip") : paint,
      "car-arch-lips"
    );
    add(buildSills(), debugArch ? debugMat("arch-sill") : blackTrim, "car-sills");

    const lamps = buildLamps();
    add(lamps.housing, darkMetal, "car-lamp-housing", false);
    add(lamps.reflector, reflectorMat, "car-lamp-reflector", false);
    // Opaque chrome, drawn before the lens so it is depth-tested normally rather
    // than composited with the transparent leaves.
    add(lamps.bezel, chrome, "car-lamp-bezel");
    const lensMesh = add(lamps.lens, clearLens, "car-lamp-lens", false);
    lensMesh.renderOrder = 4;
    const redMesh = add(lamps.redLens, redLensMat, "car-lamp-redlens", false);
    redMesh.renderOrder = 4;
    const amberMesh = add(lamps.amber, amberLens, "car-lamp-amber", false);
    amberMesh.renderOrder = 4;

    // Licence plate on the rear bumper, slightly off square.
    //
    // Was at z -2.318, which is 139 mm *inside* the rear bumper: the shell's
    // rear surface at this height sits at -2.457. `probe-unseen` had it at 0 px
    // rendered against 8712 px when forced through the bodywork, so this was
    // never a subtle few-millimetre burial of the kind that has caught the
    // front parts twice - the entire plate was interior. It is the only one of
    // the three that a ray probe could settle cleanly, being two triangles with
    // a single unambiguous normal.
    const plateGeo = new THREE.PlaneGeometry(0.305, 0.152);
    plateGeo.rotateY(Math.PI);
    plateGeo.rotateX(0.06);
    plateGeo.translate(0, 0.700, -2.468);
    add(plateGeo, plateMat, "car-rear-plate");
    const plateFrame = new THREE.Mesh(new THREE.PlaneGeometry(0.335, 0.180), blackTrim);
    plateFrame.geometry.rotateY(Math.PI);
    // 6 mm behind the plate, so the frame reads as a surround rather than
    // z-fighting with it, and still 5 mm proud of the bumper.
    plateFrame.geometry.translate(0, 0.700, -2.462);
    plateFrame.name = "car-rear-plate-frame";
    car.add(plateFrame);

    /* ---------------- wheels ---------------- */

    const wheel = buildWheel();
    // Two phases so neighbouring wheels do not show an identical tread and
    // lettering registration, mirrored left/right for a third variation.
    const tyres = [buildTyre(undefined, undefined, undefined, undefined, 0), buildTyre(undefined, undefined, undefined, undefined, 0.41)];
    // Concentric with the opening, not with the wheel. Those centres are 3 mm
    // apart and the liner is what closes the gap fore and aft of the tyre, so
    // a mismatch shows as daylight under the front of the arch.
    // 24 segments put a countable straight edge on the arch lip at close
    // framing, which is half of what the critic meant by "you can count the
    // polygon segments"; the other half was the tyre shoulder.
    const liner = buildArchLiner(ARCH_R - 0.009, 0.325, 56);

    let corner = 0;
    for (const w of wheelPositions()) {
      // One variation, one material set, one corner. Built inside the loop so
      // there is no shared instance to fall back to by accident.
      const v = wheelVariation(w, corner++, PLACE.kerbside);
      const ci = corner - 1;
      const rubber = makeTyreMat(v);
      const alloyMat = makeAlloyMat(v);
      const brake = makeBrakeMat(v);
      const capMat = makeCapMat(v);
      this.materials.push(rubber, alloyMat, brake, capMat);
      this.wheelVary.push(v);

      const hub = new THREE.Group();
      hub.position.set(w.x, ARCH_CENTRE_Y, w.z);
      // The right-hand side is the same wheel turned around, which is how a
      // symmetric alloy design actually goes on a car.
      if (w.x < 0) hub.rotation.y = Math.PI;
      // A parked car's front wheels are almost never dead straight.
      if (w.front) hub.rotation.y += (w.x < 0 ? -1 : 1) * 0.075;

      // Tread phase varies per corner so the four wheels are not in lockstep.
      // It must NOT be done with rotation.x: that is rotation about the axle,
      // and it used to roll the flattened contact patch up to 2.1 rad away
      // from the road, leaving a perfectly round tyre where the ground is and
      // making a 1550 kg car look weightless. The hub's yaw is harmless; any
      // roll is not.
      const litTyre = debugTyreLit
        ? new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), roughness: 0.9, metalness: 0 })
        : null;
      if (litTyre) this.materials.push(litTyre);
      const t = new THREE.Mesh(
        tyres[w.front === w.x > 0 ? 0 : 1],
        debugArch ? debugMat("arch-tyre") : (litTyre ?? rubber)
      );
      t.castShadow = true;
      t.receiveShadow = true;
      t.name = `car-tyre-${ci}`;
      hub.add(t);

      const a = new THREE.Mesh(bakeWheelWeather(wheel.alloy), debugArch ? debugMat("arch-rim") : alloyMat);
      a.castShadow = true;
      a.name = `car-wheel-alloy-${ci}`;
      hub.add(a);
      const hubPart = (g: THREE.BufferGeometry, m: THREE.Material, what: string) => {
        const mesh = new THREE.Mesh(g, m);
        mesh.name = `car-wheel-${what}-${ci}`;
        hub.add(mesh);
        return mesh;
      };
      hubPart(wheel.dark, debugArch ? debugMat("arch-rim") : darkMetal, "dark");
      hubPart(wheel.brake, debugArch ? debugMat("arch-rim") : brake, "brake");
      hubPart(wheel.chrome, debugArch ? debugMat("arch-rim") : capMat, "cap");
      hub.name = `car-hub-${ci}`;
      car.add(hub);

      const l = new THREE.Mesh(liner, debugArch ? debugMat("arch-liner") : cavity);
      l.position.set(w.x * 0.94, ARCH_BASE_Y, w.z);
      l.name = `car-arch-liner-${ci}`;
      // The liner was added with a bare `new THREE.Mesh` rather than through
      // `add()`, so it inherited three's default of receiveShadow = false while
      // the tyre 40 mm away had it true. Masked and measured, the liner then
      // rendered at a median of 29.9 against the tyre's 3.1 and the body panel
      // it is recessed behind at 13.1 — a surface deep inside a wheel arch was
      // taking the direct sun term with nothing allowed to occlude it, and was
      // the brightest thing in the arch. It has a LOWER albedo than the tyre
      // (0x0d0e10) and a lower envMapIntensity (0.28 against 0.42), so no
      // material property could have produced that ordering; only an
      // unshadowed light term could.
      l.receiveShadow = true;
      car.add(l);
    }

    /* ---------------- sit it on the ground ---------------- */

    const groundHeight = game.require<(x: number, z: number) => number>("groundHeight");

    /**
     * The RENDERED ground surface, not the height field, for anything that draws
     * a line where an object meets the ground.
     *
     * `groundHeight` is the analytic field. The ground MESH is a triangulation of
     * it, and **a triangle is a chord across the curve it samples**, so the mesh
     * sits below the field almost everywhere: Terrain measured 6.7 mm at p90 and
     * **23.6 mm at p99 in the near field** where the short-wavelength churn term
     * is on, against 1.1 mm far away where Nyquist gates it off.
     *
     * That is fatal specifically for the contact decal, because the decal's whole
     * job is to draw the contact line. Buried by up to 24 mm it removes the thing
     * it exists to show - and it would fail ONLY close to the camera, which reads
     * as a distance cull or a LOD bug rather than as a placement error. The walked
     * path in the film capture is exactly where the near field applies.
     *
     * A margin will not do, and this is the reasoning worth keeping: a margin has
     * to be sized at the p99, and lifting everything by 24 mm to fix a 24 mm worst
     * case floats it by 23 mm in the median. The exact per-triangle surface is the
     * only answer, which is why Terrain publishes the surface rather than asking
     * call sites to pad.
     *
     * `tryGet`, not `require`, and the reason is deliberate. If Terrain has not
     * landed the publish yet the car must still build, because the film capture is
     * the deliverable - but the shortfall must be VISIBLE rather than absorbed.
     * So the fallback is recorded and reported, never silently substituted. A
     * silent fallback to `groundHeight` here would be indistinguishable from
     * working and would put the decal back under the mesh.
     */
    /*
     * DISCOVERED BY KEY PATTERN, not hard-coded, and that is deliberate.
     *
     * Terrain computes this surface but the publish has not landed under a settled
     * name. Hard-coding a guess gives the worst outcome available: a `tryGet` that
     * returns undefined forever, silently reverting to the buried height field
     * while looking like it is wired up. So this picks up the service by pattern -
     * the same "find a family of keys" approach `core/collision.ts` uses for
     * `*.blockers`, and the reason `serviceKeys()` exists.
     *
     * It cannot pick up the wrong thing quietly: the value must be a function, and
     * the key that matched is published in the report, so a wrong match is legible
     * rather than invisible.
     */
    let exactSurface: ((x: number, z: number) => number) | undefined;
    let exactSurfaceKey: string | null = null;
    for (const key of game.serviceKeys()) {
      if (!/surface/i.test(key)) continue;
      const v = game.tryGet<unknown>(key);
      if (typeof v !== "function") continue;
      const probe = (v as (x: number, z: number) => number)(PLACE.x, PLACE.z);
      // A surface that cannot return a finite height under the car is not the
      // service being looked for, whatever it is called.
      if (!Number.isFinite(probe)) continue;
      exactSurface = v as (x: number, z: number) => number;
      exactSurfaceKey = key;
      break;
    }
    const contactSurface = exactSurface ?? groundHeight;
    this.contactSurfaceExact = Boolean(exactSurface);
    this.contactSurfaceKey = exactSurfaceKey;

    car.rotation.order = "YXZ";
    car.rotation.y = PLACE.yaw;

    // Sample the real surface under each contact patch and fit the body to it.
    // Dropping the car to a single height would float one corner over the pad
    // crown, and the shadow under a floating car is the first thing that gives
    // a scene away.
    const cos = Math.cos(PLACE.yaw);
    const sin = Math.sin(PLACE.yaw);
    let front = 0;
    let rear = 0;
    let left = 0;
    let right = 0;
    let mean = 0;
    for (const w of wheelPositions()) {
      const wx = PLACE.x + w.x * cos + w.z * sin;
      const wz = PLACE.z - w.x * sin + w.z * cos;
      const h = groundHeight(wx, wz);
      mean += h * 0.25;
      if (w.z > 0) front += h * 0.5;
      else rear += h * 0.5;
      if (w.x > 0) left += h * 0.5;
      else right += h * 0.5;
    }
    car.rotation.x = -Math.atan2(front - rear, CAR.wheelbase);
    car.rotation.z = Math.atan2(left - right, CAR.track);
    car.position.set(PLACE.x, mean, PLACE.z);

    this.group.add(car);

    /* ---------------- contact occlusion ---------------- */
    /**
     * Added to `this.group` rather than to `car`, on purpose: the decal has to
     * lie on the real ground, and `car` carries the pitch and roll fitted above.
     * Parenting it to the body would tilt the shadow off the surface, which is
     * the same class of mistake as the baked tyre contact patch rotating off the
     * ground - a bug this system has already had once.
     *
     * The gaps are read from the geometry rather than chosen. A tyre touches, so
     * its gap is 0 and it gets a tight near-black core; the floorpan floats at
     * whatever `ARCH_BASE_Y` puts it, so it gets a wide weak wash. That contrast
     * between a hard core and a soft wash is the whole read - a single oval at
     * one radius is the airbrushed blob that looks like a decal.
     */
    {
      const cs = makeContactShadow({
        // The rendered surface, not the height field - see the note at
        // `exactSurface`. This is the one call site where the 24 mm near-field
        // chord error is fatal rather than cosmetic.
        groundY: contactSurface,
        occluders: [
          // Four tyres, in world XZ. Touching, so gap 0.
          ...wheelPositions().map((w) => ({
            x: PLACE.x + w.x * cos + w.z * sin,
            z: PLACE.z - w.x * sin + w.z * cos,
            hx: 0.075,
            hz: 0.075,
            gap: 0,
          })),
          // The underbody as one broad element. Weighted below 1 because a
          // floorpan is not a closed box and the sides are open to the sky.
          {
            x: PLACE.x,
            z: PLACE.z,
            hx: (CAR.width * 0.5 - 0.10) * Math.abs(cos) + (CAR.length * 0.5 - 0.30) * Math.abs(sin),
            hz: (CAR.width * 0.5 - 0.10) * Math.abs(sin) + (CAR.length * 0.5 - 0.30) * Math.abs(cos),
            gap: 0.155,
            weight: 0.85,
          },
        ],
        /*
         * The live value, read from the scene rather than copied from Lighting's
         * default. The decal removes ambient, so its alpha is derived from how
         * much ambient there is - and this file previously baked a level authored
         * against environment 1.0 while Lighting moved it to 2.4, which is the
         * same defect Canopy found in its soffit bake. A copy of the default here
         * would go stale the next time that default moves and nothing would say
         * so, which is exactly how the first version failed.
         */
        environmentIntensity: scene.environmentIntensity,
      });
      if (cs) {
        const mesh = new THREE.Mesh(cs.geometry, cs.material);
        mesh.name = "car-contact-shadow";
        mesh.renderOrder = 1;
        // Neither casts nor receives. It stands in for ambient that the renderer
        // does not compute; feeding it back through the shadow pass would make
        // it disappear in shade, which is where it is needed most.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        this.group.add(mesh);
        this.materials.push(cs.material);
        /*
         * Publish the borrowing. The point is not the number, it is that a
         * scene-wide quantity is being consumed here at all: the previous version
         * consumed it through a baked constant and disclosed it only in a
         * comment, so nothing downstream could tell that Lighting moving the
         * environment had invalidated it. `clamped` is the one to watch - it says
         * the linear scaling has saturated and the derivation is no longer
         * first-order.
         */
        this.contactShadowReport = cs.report;
      }
    }

    this.group.name = "car-system";
    scene.add(this.group);

    /* ---------------- registry ---------------- */

    car.updateMatrixWorld(true);
    const handle: ParkedCarHandle = {
      name: "parked-car",
      root: car,
      position: car.position.clone(),
      heading: PLACE.yaw,
      size: { length: CAR.length, width: CAR.width, height: CAR.height },
      pickables: [bodyMesh, glassMesh],
      setPaint: (hex: number) => paint.color.setHex(hex),
    };
    game.provide("car.parked", handle);
    game.provide("cars", [handle]);

    // What the build actually produced: patch partition, crease count, arch
    // gap, and the sign of the body's volume. NOTES.md is six entries of
    // "it looked plausible and was wrong", and every one of these is a number
    // no screenshot can confirm.
    (window as unknown as { __CAR?: unknown }).__CAR = {
      ...shell.report,
      paint: `#${PAINT.toString(16).padStart(6, "0")}`,
      worldY: +car.position.y.toFixed(3),
      pitchDeg: +THREE.MathUtils.radToDeg(car.rotation.x).toFixed(2),
      rollDeg: +THREE.MathUtils.radToDeg(car.rotation.z).toFixed(2),
      weather: this.weatherReport(),
      /*
       * The contact decal's borrowing, surfaced. See the note at the assignment:
       * a scene-wide quantity consumed through a constant and disclosed only in a
       * comment is invisible to everything downstream, which is how this went
       * stale when Lighting moved the environment 1.0 -> 2.4.
       */
      contactShadow: this.contactShadowReport
        ? {
            ...this.contactShadowReport,
            /*
             * False means the decal is sitting on the analytic height field while
             * the ground mesh renders as a chord below it - up to 24 mm in the
             * near field, which buries the contact line the decal exists to draw.
             * Reported rather than absorbed: the failure mode looks like a
             * distance cull, so nobody would attribute it to placement.
             */
            surfaceExact: this.contactSurfaceExact,
            surfaceKey: this.contactSurfaceKey,
          }
        : null,
      wheels: this.wheelVary.map((v) => ({
        corner: v.corner,
        fieldOffset: [+v.fieldOffset.x.toFixed(3), +v.fieldOffset.y.toFixed(3)],
        fieldFlip: v.fieldFlip,
        brakeDust: +v.brakeDust.toFixed(3),
        roadFilm: +v.roadFilm.toFixed(3),
      })),
      fallbacks: projectionStats(),
      // Reported, not asserted, because an unnamed mesh is not a rendering
      // fault and should not fail a capture. It is a diagnosis fault: every
      // per-mesh instrument in tools/ prints "<Mesh>" for it, so whatever it
      // is doing wrong lands on nobody's desk. Two of these were hiding in
      // this car when probe-unseen.mjs first ran. Keep it at zero.
      unnamedMeshes: (() => {
        const bad: string[] = [];
        car.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && !o.name) bad.push(o.parent?.name || "<car>");
        });
        return bad;
      })(),
    };
    // Live weathering tuning, so the intensity pass costs one page load rather
    // than a rebuild and a capture per value. The masks are baked and fixed;
    // these are the only two numbers that should move.
    //
    //   __CAR_WEATHER({ dust: 0.25, film: 0.5 })
    (window as unknown as { __CAR_WEATHER?: unknown }).__CAR_WEATHER = (o: {
      dust?: number;
      film?: number;
      rough?: number;
      wheelDust?: number;
      wheelFilm?: number;
    }) => {
      if (this.weather) {
        if (o.dust !== undefined) this.weather.uWDust.value = o.dust;
        if (o.film !== undefined) this.weather.uWFilm.value = o.film;
        if (o.rough !== undefined) this.weather.uWRough.value = o.rough;
      }
      // Fanned out across all four corners. The per-corner spread is preserved:
      // a scalar here scales every wheel to the same value, which is what you
      // want while dialling an intensity and not what you want to ship.
      for (const w of this.wheelWeather) {
        if (o.wheelDust !== undefined) w.uWDust.value = o.wheelDust;
        if (o.wheelFilm !== undefined) w.uWFilm.value = o.wheelFilm;
      }
      return this.weatherReport();
    };
  }

  private weatherReport() {
    return {
      dust: this.weather?.uWDust.value ?? null,
      film: this.weather?.uWFilm.value ?? null,
      rough: this.weather?.uWRough.value ?? null,
      wheelDust: this.wheelWeather.map((w) => +w.uWDust.value.toFixed(3)),
      wheelFilm: this.wheelWeather.map((w) => +w.uWFilm.value.toFixed(3)),
    };
  }

  /** Runtime repaint, used by the debug query and available to later systems. */
  setPaint(hex: number): void {
    this.paintMat.color.setHex(hex);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.group.removeFromParent();
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
