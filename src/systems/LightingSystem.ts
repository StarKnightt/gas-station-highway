import * as THREE from "three";
import type { GameSystem, SystemContext } from "../core/types";
import { SUN } from "../site";
import { installLightShaderPatches, LIGHT_FOG_UNIFORMS } from "./lightShaderPatches";
import {
  buildSkyDome,
  buildEnvironment,
  buildWorldEnvironment,
  makeSkyRadianceService,
  verifySkyRadiance,
  type WorldEnvBuild,
  type SkyRadianceService,
} from "./lightSky";
import { fitSunShadow, fitSunShadowSphere } from "./lightShadows";
import {
  buildInteriorLighting,
  tuneInteriorMaterials,
  captureInteriorIrradiance,
  applyInteriorIrradiance,
  type InteriorBuild,
  type InteriorIrradiance,
} from "./lightInterior";
import { EnvironmentBinding } from "./lightEnvBinding";
import { findEnvCulprit } from "./lightEnvCulprit";
import { createShadowMapView } from "./lightShadowView";
import { createPostRig } from "./lightPostRig";

/**
 * System 4: lighting and atmosphere. Owns the sun, the sky dome, the image
 * based lighting derived from it, the aerial perspective, and every electric
 * light in the building. Supersedes the placeholder SkySystem and keeps its
 * published services ("sunDirection", "sunLight") working.
 *
 * ## The ratio is the whole job
 *
 * At 6 degrees of elevation the sun's cosine on flat ground is about 0.10, so
 * the pavement receives roughly a tenth of the sun's irradiance while a wall
 * facing it receives nearly all of it. That single fact is what golden hour
 * *is*: near-parity between sun and sky on horizontal surfaces, and a ten to
 * one ratio on vertical ones. Get it right and long shadows appear on the lot
 * without the sunlit walls blowing out; get it wrong in either direction and
 * you have either a flat ambient render or an orange light bulb.
 *
 * That paragraph was aspiration, not description, until round
 * `2026-08-28T223812Z`. The shipped numbers were sun 5.6 and environment 1.0,
 * which at 6.2 degrees is 5.6*sin(6.2) = 0.48 of direct against roughly 0.23 of
 * sky on a horizontal surface - the sun beating the sky better than two to one,
 * where a real 6-degree sun is passing through about ten air masses and loses.
 * Nothing caught it because the missing sky fill had been paid for out of a
 * different account: `buildEnvironment` floored the environment with a flat
 * ground disc of radiance 0.115/0.062/0.030, luminance 0.0710, against the
 * 0.0094 that the real ground measures when photographed. A 7.6x over-bright,
 * 12x over-warm lower hemisphere sitting at almost exactly the sky's own
 * radiance, which is to say a uniform warm studio sphere. It filled shadows
 * convincingly and it made the sun-to-sky ratio unfalsifiable, so promoting the
 * real world capture did not create a darkness bug, it uncovered one that had
 * been paid for in counterfeit since the beginning. Fix the ratio, not the
 * ground: a 9%-albedo surface cannot return as much radiance as the sky
 * lighting it, and no amount of wanting warm shadows makes it able to.
 *
 * ## Verification hooks
 *
 * Per NOTES.md nothing here is trusted to be wired up just because it compiled.
 * `?lforce=<flags>` drives each contribution to an extreme so the harness can
 * pixel-diff it:
 *
 *   noshadow  sun stops casting            shadowonly  kill env, fill and bounce
 *   nosun     sun intensity 0              nofog       aerial perspective off
 *   noenv     environment intensity 0      env8        environment intensity 8
 *   nofluoro  interior lamps off           fluoro6     interior lamps 6x
 *   nobounce  ground bounce off            flatsky     sky replaced by grey
 *   clearglass  storefront stops blocking the sun (see lightInterior)
 *   flatenv   ship the sky-only environment instead of the world capture
 *
 * `?lmirror=1` adds a chrome sphere and a vertical chrome plate at the
 * environment capture point, and `?envdump` publishes the captured cube on
 * `window.__ENV_DUMP`. Both exist because the environment's *content* cannot be
 * judged from a scalar: a lower hemisphere of one constant colour has a
 * perfectly healthy mean luminance, and that is how it shipped for a day.
 *
 * `?ldoor=0..1` forces the entry door's contribution to the interior spill, and
 * `window.__LIGHTING` carries the measured environment luminance and the
 * shader-patch report so the harness can assert on them rather than eyeball
 * them.
 */

/** Elevation in degrees. The brief asks for 4-8; 6.2 puts the shadow of the
 *  1.9 m dispensers about 17 m across the lot, which reaches the parking bays. */
const SUN_ELEVATION_DEG = 6.2;

/** Sun colour at ~6 degrees through a clean continental atmosphere, ~2400 K. */
const SUN_COLOR = new THREE.Color(1.0, 0.535, 0.243);

/**
 * Where the shipped environment is photographed from, and the eye height.
 *
 * A single capture point is inherently a compromise for a site this size, so
 * the choice is stated rather than defaulted: this is out in the open lot,
 * roughly 10 m east of the pump islands, 12 m south-east of the store's
 * near corner and 8 m from the parking bays. From here the cube sees open sky
 * overhead, the pump islands and the store mass low in the west and north-west,
 * the treeline and the ridge round the rest of the horizon, and painted tarmac
 * below - which is the set of things a reflective object in this scene should
 * be showing. It is deliberately *not* the geometric centre of the forecourt,
 * which sits 3 m from a dispenser and would put one cabinet across a large part
 * of the lower sky for every material in the project.
 *
 * `?envpos=x,z` and `?enveye=` stage it; `?envsize=` changes the cube
 * resolution.
 */
const ENV_CAPTURE_XZ: [number, number] = [14.0, 26.0];
const ENV_CAPTURE_EYE = 1.55;
const ENV_CUBE_SIZE = 256;

const SHADOW_MAP_SIZE = 8192;
const SHADOW_DISTANCE = 80;
const SHADOW_CASTER_DEPTH = 95;

interface Force {
  noshadow: boolean;
  shadowonly: boolean;
  nosun: boolean;
  nofog: boolean;
  noenv: boolean;
  env8: boolean;
  nofluoro: boolean;
  fluoro6: boolean;
  nobounce: boolean;
  flatsky: boolean;
  clearglass: boolean;
  /** Do not install the aerial-perspective chunk patch at all. Diagnostic
   *  only, and distinct from `nofog`: see the note on `installLightShaderPatches`. */
  nohazepatch: boolean;
  /** Do not install the sixteen-tap PCF chunk patch at all. */
  nopcfpatch: boolean;
  /** Skip the world capture and ship the sky-only environment - i.e. reproduce
   *  the state this scene shipped in for a day. This is the forced diff for the
   *  environment's *content*, and it moves nothing else: same intensity, same
   *  exposure, same sun, same materials. */
  flatenv: boolean;
}

declare global {
  interface Window {
    __LIGHTING?: Record<string, unknown>;
    /** `?envdump` — the captured cube as a 3x2 face grid, PNG data URL. Looking
     *  at the environment beats any statistic computed from it. */
    __ENV_DUMP?: string;
  }
}

export class LightingSystem implements GameSystem {
  readonly name = "lighting";

  readonly sunDirection = new THREE.Vector3();
  private sun!: THREE.DirectionalLight;
  private sunTarget = new THREE.Object3D();
  private hemi!: THREE.HemisphereLight;
  private skyMesh!: THREE.Mesh;
  private interior: InteriorBuild | null = null;
  private envBinding: EnvironmentBinding | null = null;
  private interiorTried = false;
  private envIntensity = 1;
  private skyOnlyEnv: THREE.Texture | null = null;
  private worldEnv: WorldEnvBuild | null = null;
  private worldEnvFrame = -1;
  private envCapture = { x: ENV_CAPTURE_XZ[0], z: ENV_CAPTURE_XZ[1], eye: ENV_CAPTURE_EYE, size: ENV_CUBE_SIZE };
  private frame = 0;
  private mirrors = false;
  private envInstall = true;
  private worldEnvEnabled = false;
  private skyService: SkyRadianceService | null = null;
  private doorOpen = 0;
  /** `?ienv=` — interior IBL response, see the call in `ensureInterior`. */
  private ienv = 0.07;
  private interiorMaterials: THREE.MeshStandardMaterial[] = [];
  private interiorLensMeshes: THREE.Mesh[] = [];
  private interiorProbe: InteriorIrradiance | null = null;
  private interiorProbeTried = false;
  /** `?ibounce=` — strength of the room's own irradiance probe. See the default. */
  private ibounce = 0.35;
  /** `?iprobe=` — probe cube resolution. Irradiance is low-frequency. */
  private iprobeSize = 64;
  private force!: Force;
  /** Contact-hardening shadows are on, and `shadowMap.type` is `BasicShadowMap`. */
  private pcss = false;
  /** `?shadowview=1`. Installed lazily; see `lightShadowView.ts`. */
  private shadowView = false;
  private shadowViewInstalled = false;
  /** Sun angular radius, radians. Sets the penumbra growth rate with distance. */
  private sunAngularRadius = 0.0185;
  /** `?sradius=` — constant PCF width, used only when contact hardening is off. */
  private constantFilterTexels = 3.2;
  private report: Record<string, unknown> = {};
  /** Shadow-frustum fit, staged by `?sdist=` / `?sdepth=` / `?smap=`. See the
   *  note on `fitSunShadow` below for why these are knobs and not constants. */
  private shadowFit = { distance: SHADOW_DISTANCE, casterDepth: SHADOW_CASTER_DEPTH, mapSize: SHADOW_MAP_SIZE };

  init(ctx: SystemContext): void {
    const { scene, renderer, game, camera } = ctx;
    const q = new URLSearchParams(location.search);
    const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
    const flags = new Set((q.get("lforce") ?? "").split(",").filter(Boolean));
    const f = (k: keyof Force) => flags.has(k);
    this.force = {
      noshadow: f("noshadow"),
      shadowonly: f("shadowonly"),
      nosun: f("nosun"),
      nofog: f("nofog"),
      noenv: f("noenv"),
      env8: f("env8"),
      nofluoro: f("nofluoro"),
      fluoro6: f("fluoro6"),
      nobounce: f("nobounce"),
      flatsky: f("flatsky"),
      clearglass: f("clearglass"),
      nohazepatch: f("nohazepatch"),
      nopcfpatch: f("nopcfpatch"),
      flatenv: f("flatenv"),
    };
    // Per NOTES.md case 25: an unrecognised token must be rejected, not
    // ignored. A silently-dropped flag returns a clean negative from a forced
    // diff, which is the most persuasive artefact in this project and, when it
    // comes from a typo, entirely fictional.
    const known = new Set(Object.keys(this.force));
    const unknown = [...flags].filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`[lighting] unknown ?lforce= token(s): ${unknown.join(", ")}`);

    // `?pcss=0` opts back out. Contact hardening needs raw shadow depth, and
    // only `BasicShadowMap` binds the map as a sampler three has not put into
    // comparison mode, so the type has to change with the patch. Both are set
    // here, before any other system builds a material, because the shadow type
    // is a shader define and a material compiled under the old one keeps it.
    // Contact hardening is now the DEFAULT. `?pcss=0` opts out.
    //
    // Both reasons it was opt-in are discharged:
    //
    // 1. Memory. Perf has landed the `BasicShadowMap` branch in
    //    `core/shadowMemory.ts`, so selecting this type no longer skips
    //    preallocation and no longer hands back the 256 MB mid-frame spike.
    // 2. Mechanism. It is now *measured* to be contact hardening rather than a
    //    softer kernel, on the isolated-post rig (`?lpost=1`, pose
    //    `post_penumbra`, round 2026-08-29T040752Z-f7600160bab5). Seven matched
    //    edges per side, both edges of the shadow measured independently, same
    //    build and same browser for both arms:
    //
    //      PCF  image-space penumbra: 8.7 -> 6.7 px with distance (shrinks)
    //      PCSS image-space penumbra: 8.8 -> 12.6 px with distance (grows)
    //
    //    PCF shrinking is what a constant world-space kernel MUST do as it
    //    recedes, so its own trend is the perspective control. The width ratio
    //    spans 1.89x on one edge and 2.19x on the other and crosses 1.0, which
    //    means some edges sharpened while others softened. **A change of kernel
    //    width moves every edge the same way; this did not.** Contrast was flat
    //    at 19-25 luma levels across the span, so it is not a contrast artefact.
    this.shadowView = q.get("shadowview") === "1";
    this.pcss = q.get("pcss") !== "0" && !this.force.nopcfpatch;
    if (this.pcss) renderer.shadowMap.type = THREE.BasicShadowMap;
    const patches = installLightShaderPatches(
      {
        fog: this.force.nohazepatch,
        pcf: this.force.nopcfpatch,
      },
      { pcss: this.pcss }
    );
    this.report.patches = patches;
    if (this.pcss && !patches.pcss) {
      // Throw. The first version of this reverted to PCF and pushed a
      // `__SYSTEM_ERRORS` entry, which is worse than useless: the frame still
      // renders, it renders *plausibly*, and it renders with the exact treatment
      // the round is trying to measure against. One agent spent a round
      // comparing PCF to PCF and reading the difference as a result, and another
      // had to carry the error line over from its own capture to stop it.
      //
      // A graceful degradation is only graceful when the caller can tell. This
      // one is a silent substitution of the control for the experiment, so the
      // round must not start. `?pcss=0` is the supported way to render without
      // it, and it takes the PCF patch with it.
      throw new Error(
        `[lighting] contact hardening could not be installed: ${patches.problems.join("; ")}. ` +
          `Refusing to fall back to PCF, because a PCF frame is indistinguishable from a working ` +
          `one at a glance and would be measured as if it were contact hardening. ` +
          `Pass ?pcss=0 to render with the constant-radius filter deliberately.`
      );
    }

    /* ---------------- sun geometry ---------------- */
    const el = THREE.MathUtils.degToRad(num("sunel", SUN_ELEVATION_DEG));
    const az = SUN.azimuth;
    this.sunDirection.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    game.provide("sunDirection", this.sunDirection);

    if (q.get("lpost") === "1") {
      const rig = createPostRig(scene, this.sunDirection, {
        // Open apron. The first attempt at (-18, 4) put the post on the highway
        // shoulder: kerb, lane markings, scrub, and a large soft shadow from the
        // distant treeline across the whole receiver. A penumbra measurement
        // needs a *uniform lit* receiver more than it needs anything else, so
        // the position is chosen for the ground it lays its shadow on.
        x: num("lpostx", -13),
        z: num("lpostz", 8),
      });
      this.report.postRig = rig.info;
    }

    /* ---------------- sky ---------------- */
    const sky = buildSkyDome({
      sunDirection: this.sunDirection,
      // ~0.75 degrees: half again the true 0.27, because at this elevation the
      // disc is smeared by refraction and haze and a geometrically correct one
      // reads as a hard pinprick.
      sunAngularRadius: (this.sunAngularRadius = num("sunrad", 0.0185)),
      turbidity: num("turb", 1.0),
    });
    if (this.force.flatsky) {
      for (const k of ["uZenith", "uMid", "uHorizon", "uWarmBand", "uSunAureole", "uSunDisc", "uGround"]) {
        (sky.uniforms[k].value as THREE.Color).setRGB(0.35, 0.35, 0.35);
      }
      sky.uniforms.uCloudGain.value = 0;
    }
    this.skyMesh = sky.mesh;
    scene.add(sky.mesh);

    /* ---------------- the sky radiance service ---------------- */
    // Published as a function of direction, not as a colour, and that is the
    // whole point. Vegetation's horizon bands were converging toward a colour
    // sampled from one pose, which is why they read neutral against this sky's
    // warm side: the azimuthal term in the dome swings the warm band from 0.055
    // away from the sun to 0.675 toward it, a factor of twelve, and the aureole
    // adds more on top. Any single published colour - including one I sampled -
    // is only correct on one bearing, so a snapshot of mine would have replaced
    // vegetation's bug with the same bug at a different azimuth.
    const skyService = makeSkyRadianceService(sky.uniforms, this.sunDirection);
    const check = verifySkyRadiance(renderer, sky.mesh, skyService);
    if (!skyService.verified) {
      const msg =
        `sky radiance service DIVERGES from the rendered dome: worst relative error ` +
        `${(check.agreement * 100).toFixed(1)}% over ${check.probes} probes (${check.worst}). ` +
        `Consumers would converge distant geometry toward a colour the sky does not have.`;
      console.error(`[lighting] ${msg}`);
      window.__SYSTEM_ERRORS?.push({ system: "lighting", phase: "init", message: msg });
    } else {
      console.log(
        `[lighting] sky radiance service verified against the dome: worst error ` +
          `${(check.agreement * 100).toFixed(2)}% over ${check.probes} probes`
      );
    }
    game.provide("skyRadiance", skyService);
    // Vegetation's distant treeline blends toward haze, and until now it had to
    // infer the tint from `skyRadiance` - which is the dome, not the air in
    // front of it. Those differ most exactly where its treeline sits. Published
    // as a live function rather than a snapshot for the reason in the note
    // above: one constant is only correct on one bearing.
    //
    // `hazeSun` here is the same quantity the fragment shader uses, so a
    // consumer that calls this with its own view direction gets the colour the
    // shader will actually mix toward on that bearing.
    game.provide("hazeTint", {
      /** Haze colour for a (normalised) view direction, linear working space. */
      forDirection: (dir: THREE.Vector3, out = new THREE.Color()): THREE.Color => {
        const cool = LIGHT_FOG_UNIFORMS.uHazeCool.value;
        const warm = LIGHT_FOG_UNIFORMS.uHazeWarm.value;
        const glow = LIGHT_FOG_UNIFORMS.uHazeGlow.value;
        const hazeSun = Math.max(dir.dot(this.sunDirection), 0);
        const t = Math.pow(hazeSun, 1.6) * 0.86 + hazeSun * 0.14;
        const g = Math.pow(hazeSun, 9.0) * 0.9;
        return out.setRGB(
          cool.r + (warm.r - cool.r) * t + glow.r * g,
          cool.g + (warm.g - cool.g) * t + glow.g * g,
          cool.b + (warm.b - cool.b) * t + glow.b * g
        );
      },
      /** e-folding height of the haze layer, metres. Density is unchanged. */
      height: LIGHT_FOG_UNIFORMS.uHazeHeight.value as number,
    });
    this.skyService = skyService;
    // The ring is published so a consumer can see the azimuthal swing rather
    // than take my word for it, and so the blue/red ratio vegetation measured
    // (0.97 neutral, 1.467 in its own constant) is directly comparable.
    const ring: { azDeg: number; r: number; g: number; b: number; blueOverRed: number }[] = [];
    const probe = new THREE.Color();
    for (let i = 0; i < 8; i++) {
      const az = (i / 8) * Math.PI * 2;
      skyService.atHorizon(az, probe);
      ring.push({
        azDeg: Math.round((az * 180) / Math.PI),
        r: +probe.r.toFixed(4),
        g: +probe.g.toFixed(4),
        b: +probe.b.toFixed(4),
        blueOverRed: +(probe.b / Math.max(probe.r, 1e-6)).toFixed(3),
      });
    }
    this.report.skyService = {
      colourSpace: skyService.colourSpace,
      horizonElevation: skyService.horizonElevation,
      gpuAgreement: skyService.gpuAgreement,
      verified: skyService.verified,
      probes: check.probes,
      worst: check.worst,
      sunAzimuthDeg: Math.round((Math.atan2(this.sunDirection.z, this.sunDirection.x) * 180) / Math.PI),
      horizonRing: ring,
    };

    /* ---------------- image based lighting ---------------- */
    // Warm bounce off the sunlit lot, carried by the lower hemisphere of the
    // environment. Asphalt is a ~9% reflector, so this is dark - but at this
    // sun angle it covers half the sky of every underside in the scene, which
    // is why flat black shadow interiors are such a giveaway without it.
    const bounceOff = this.force.nobounce || this.force.shadowonly;
    const groundRadiance = bounceOff
      ? new THREE.Color(0, 0, 0)
      : new THREE.Color(0.115, 0.062, 0.030).multiplyScalar(num("bounce", 1.0));
    const env = buildEnvironment(renderer, sky.material, sky.mesh.geometry, groundRadiance);
    scene.environment = env.texture;
    this.skyOnlyEnv = env.texture;
    // 1.0 until the sun-to-sky audit; see the header. This is the skylight that
    // the counterfeit ground disc was standing in for, now charged to the
    // account it actually belongs to. It is deliberately a scene-wide scalar
    // rather than a new light: the environment already carries the correct
    // *directional* distribution of dawn sky, blue overhead and warm toward the
    // sun, and only its magnitude was wrong.
    //
    // Note that this also applies during the frame-2 world capture, so the
    // photographed ground is lit by the corrected sky and the lower hemisphere
    // comes back brighter of its own accord, rather than needing its own lever.
    const envIntensity = this.force.noenv || this.force.shadowonly ? 0 : this.force.env8 ? 8 : num("env", 2.4);
    scene.environmentIntensity = envIntensity;
    this.envIntensity = envIntensity;
    const posArg = (q.get("envpos") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
    if (posArg.length === 2) {
      this.envCapture.x = posArg[0];
      this.envCapture.z = posArg[1];
    }
    this.envCapture.eye = num("enveye", ENV_CAPTURE_EYE);
    this.envCapture.size = num("envsize", ENV_CUBE_SIZE);
    this.mirrors = q.get("lmirror") === "1";
    // `?envinstall=0` captures and measures the world environment but does not
    // ship it. That separates "the capture broke the renderer" from "the
    // captured environment is bad", which are the only two ways this can fail
    // and which look identical in a frame.
    this.envInstall = q.get("envinstall") !== "0";
    // ON by default as of round 2026-08-28T205344Z. This was opt-in while the
    // capture was intermittently emitting NaN into the cube, and the reason it
    // is now the default is that the NaN has a named source that has been fixed
    // rather than a guard sitting on top of it: `buildClump` in gen/vegScrub.ts
    // was computing `Math.pow(t, 0.55)` with `t` a few times 1e-8 *negative* on
    // the base row of nearly every card, because `PlaneGeometry(w, h).translate
    // (0, h/2, 0)` does not cancel exactly in float32. 55 of the 56 clump
    // geometries carried NaN vertex colours. `tools/clumpcolor.mjs` is the
    // CPU-side regression check and takes about a second.
    //
    // `?worldenv=0` still forces the old sky-only path, because the guard below
    // rejecting a poisoned cube and a human being able to A/B the two
    // environments are different needs.
    this.worldEnvEnabled = q.get("worldenv") !== "0";
    // Nothing else in the scene reads its own `envMapIntensity` until this is
    // installed - three only refreshes that uniform for a material that owns an
    // `envMap`, and every material here inherits the environment instead. See
    // lightEnvBinding.ts; this system owns it because it owns the PMREM and has
    // to re-bind whenever the environment is rebuilt.
    this.envBinding = new EnvironmentBinding(scene);
    this.envBinding.install();
    this.envBinding.setEnvironment(env.texture, envIntensity);
    game.provide("environmentBinding", this.envBinding);
    this.report.envBinding = this.envBinding.counts;
    this.report.env = {
      mean: env.meanLuminance,
      min: env.minLuminance,
      max: env.maxLuminance,
      intensity: envIntensity,
    };
    if (!(env.meanLuminance > 1e-4)) {
      console.error(
        `[lighting] environment map is black (mean luminance ${env.meanLuminance}). ` +
          `Every material will lose its ambient response - check the PMREM far plane.`
      );
    } else {
      console.log(`[lighting] env mean luminance ${env.meanLuminance.toFixed(4)} (max ${env.maxLuminance.toFixed(2)})`);
    }

    /* ---------------- key light ---------------- */
    // 5.6 until the sun-to-sky audit; see the header. Lowered together with the
    // environment lift below so that sunlit surfaces hold still - the round that
    // set these measured p75/p90/p99 moving by 4/5/3 of 255 across two poses
    // while the shadow end moved by twenty. Albedo authored against the old
    // *lit* values is therefore still valid; albedo authored against the old
    // *shaded* values is not.
    const sunIntensity = this.force.nosun ? 0 : num("sun", 4.4);
    const sun = new THREE.DirectionalLight(SUN_COLOR, sunIntensity);
    sun.name = "sun";
    this.sunTarget.name = "sun-target";
    scene.add(this.sunTarget);
    sun.target = this.sunTarget;
    // `?sdist=` and `?smap=` exist so a suspected shadow-frustum artefact can
    // be staged two ways *without moving the camera or anything in the scene*.
    // That is the case-23 requirement: the reference surface must not move
    // with the knob, and resizing the light's frustum moves nothing a viewer
    // is measuring against.
    this.shadowFit = {
      distance: num("sdist", SHADOW_DISTANCE),
      casterDepth: num("sdepth", SHADOW_CASTER_DEPTH),
      mapSize: num("smap", SHADOW_MAP_SIZE),
    };
    sun.castShadow = !this.force.noshadow;
    sun.shadow.mapSize.set(this.shadowFit.mapSize, this.shadowFit.mapSize);
    // Bias at a grazing sun: normalBias does nearly all the work, because it
    // displaces the sample along the surface normal, which is close to
    // perpendicular to the light and therefore cheap in depth. A constant bias
    // large enough to fix acne on its own would detach every shadow from its
    // caster - the peter-panning the brief warns about.
    sun.shadow.bias = num("sbias", -0.00016);
    // 0.055 was not a bias, it was a subsidy for the constant filter. A 13 cm
    // kernel samples the map 6.5 cm away from the shaded point, and at 6 degrees
    // the receiver's own depth changes more over 6.5 cm than any sane constant
    // bias, so the normal offset had to grow until the acne stopped - at which
    // point it was displacing every contact shadow by 5.5 cm. Receiver-plane
    // bias in the shader makes the correction proportional to each tap's offset,
    // which is what the geometry actually asks for, so this drops to the value
    // needed for depth quantisation alone.
    sun.shadow.normalBias = num("snbias", this.pcss ? 0.012 : 0.055);
    this.constantFilterTexels = num("sradius", 3.2);
    sun.shadow.blurSamples = 16;
    scene.add(sun);
    this.sun = sun;
    game.provide("sunLight", sun);
    this.report.shadow = {
      ...this.shadowFit,
      bias: sun.shadow.bias,
      normalBias: sun.shadow.normalBias,
      texel: fitSunShadow(sun, camera, this.sunDirection, this.shadowFit),
      pcss: this.pcss,
      radius: this.setShadowFilterScale(),
      // Reported because it was misreported. Asked whether a 276 MB texture
      // group was Lighting's, this system answered "one 2048 depth map" from
      // memory; `SHADOWMAP_MAP_SIZE` is 8192, and 8192*8192*4 bytes is 268 MB,
      // which is the group. Three agents were reconciling a number that one of
      // them could have read off a constant. Publish it, do not recall it.
      mapBytes: this.shadowFit.mapSize * this.shadowFit.mapSize * 4,
      mapNote: `${this.shadowFit.mapSize}^2 depth32 = ${((this.shadowFit.mapSize ** 2 * 4) / 1048576).toFixed(0)} MB`,
    };

    /* ---------------- sky fill ---------------- */
    // Deliberately tiny. Every non-shadowing light in three shines straight
    // through the store's roof, so anything meaningful put here lands on the
    // interior as well and destroys the inside/outside contrast that the whole
    // piece is built around. The sky fill therefore lives almost entirely in
    // the environment map, whose strength is per material; this light is only
    // here to stop the very darkest cavities from crushing to black.
    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(0.34, 0.46, 0.70),
      new THREE.Color(0.26, 0.17, 0.11),
      this.force.shadowonly ? 0 : num("fill", 0.10)
    );
    this.hemi.name = "sky-fill";
    scene.add(this.hemi);

    /* ---------------- aerial perspective ---------------- */
    const density = this.force.nofog ? 0 : num("fog", 0.0027);
    scene.fog = new THREE.FogExp2(new THREE.Color(0.30, 0.34, 0.44), density);
    (LIGHT_FOG_UNIFORMS.uHazeSunDir.value as THREE.Vector3).copy(this.sunDirection);
    LIGHT_FOG_UNIFORMS.uHazeGain.value = this.force.nofog ? 0 : num("haze", 1.0);
    LIGHT_FOG_UNIFORMS.uHazeHeight.value = num("hazeh", 46);

    /* ---------------- door hook ---------------- */
    this.ienv = num("ienv", 0.25);
    // 0.35, and the honest account of that number is that **1.0 is the
    // physically correct coefficient and 0.35 is a single-probe compensation**,
    // not a taste setting. The probe is a real radiance measurement, so applied
    // at the point it was taken it wants 1.0 — but one probe at room centre
    // stands in for the whole room, and a surface tucked under a shelf or
    // against a wall actually receives far less than the room centre does. With
    // no occlusion term, 1.0 over-lights exactly those pockets.
    //
    // Measured on the `interior` pose, round 2026-08-28T214609Z, sweeping
    // 0 / 0.35 / 0.6 / 1.0. Pixels under luma 32 go 10.96% -> 1.65% -> 1.21% ->
    // 0.84%, and p05 goes 26 -> 41 -> 42 -> 43. **Essentially the whole repair
    // has happened by 0.35**; from there to 1.0 the tail barely moves while the
    // midtones inflate (p25 56 -> 94, mean 130 -> 145), which is the room
    // getting brighter rather than its shadowed faces getting lit. The
    // storefront-from-outside pose moves 81.6 -> 81.9 across the entire sweep,
    // so this is not being traded against the exterior contrast either way.
    //
    // If a real occlusion term ever lands here — per-object probes, or a baked
    // AO factor multiplying this — the right move is to raise this back toward
    // 1.0 at the same time, because the two are compensating for each other.
    this.ibounce = num("ibounce", 0.35);
    this.iprobeSize = num("iprobe", 64);
    this.doorOpen = num("ldoor", 0);
    game.provide("lighting", {
      sunDirection: this.sunDirection,
      sunLight: sun,
      skyRadiance: this.skyService,
      sunIntensity,
      sunElevationDeg: THREE.MathUtils.radToDeg(el),
      setDoorOpenAmount: (a: number) => this.setDoorOpenAmount(a),
    });
    game.provide("lighting.setDoorOpenAmount", (a: number) => this.setDoorOpenAmount(a));

    window.__LIGHTING = this.report;
  }

  /**
   * How far the entry door is open, 0..1. System 7 drives this alongside
   * `AudioSystem.setDoorOpenAmount`. The shaped patch of sun on the floor comes
   * from the shadow map for free; this scales the bounce off that patch.
   */
  setDoorOpenAmount(amount: number): void {
    this.doorOpen = THREE.MathUtils.clamp(amount, 0, 1);
    this.interior?.setDoorOpenAmount(this.doorOpen);
  }

  /**
   * The building only exists after its own `init()`, which runs later than
   * ours, so the interior emitters are attached on the first frame instead.
   */
  private ensureInterior(ctx: SystemContext): void {
    if (this.interiorTried) return;
    this.interiorTried = true;
    const { game, scene } = ctx;

    const root = game.tryGet<THREE.Object3D>("building.root");
    const fluorescents = game.tryGet<THREE.Object3D[]>("building.fluorescents");
    const footprint = game.tryGet<{
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      floorY: number;
      roofY: number;
    }>("building.footprint");
    if (!root || !fluorescents || !footprint) {
      console.warn("[lighting] no building services; interior lighting skipped");
      this.report.interior = { built: false };
      return;
    }

    // `nofluoro` still zeroes everything interior, unchanged. But note what that
    // flag actually spans, because its name cost me two wrong attributions in one
    // hour: it multiplies the lamps, the storefront daylight rect *and* both door
    // bounce lights. It bounds the interior's total contribution and attributes
    // none of it. `?lamp=`, `?dbounce=` and `?drect=` are the levers that
    // attribute, and they exist because that flag does not (NOTES.md case 65).
    const gain = this.force.nofluoro ? 0 : this.force.fluoro6 ? 6 : 1;
    const lampQ = new URLSearchParams(location.search).get("lamp");
    // 0.3 is part of the landed grade documented at the `buildInteriorLighting`
    // call below. `?lamp=1` restores the value that shipped before it.
    let lampGain = 0.3;
    if (this.force.nofluoro) lampGain = 0;
    // Still "six times the lamps as shipped", i.e. relative to the current
    // default rather than to the authored constant, so the flag's name keeps
    // meaning what it says after the grade moved under it.
    else if (this.force.fluoro6) lampGain = 1.8;
    else if (lampQ !== null) {
      // Throw rather than let `Number("0.3 ")`-style junk become NaN. A NaN
      // light intensity does not error in three; it silently contributes
      // nothing, so a mistyped sweep value would read as "the lamps do not
      // matter" — which is precisely the wrong conclusion, and precisely the
      // conclusion this sweep exists to test.
      lampGain = Number(lampQ);
      if (!Number.isFinite(lampGain) || lampGain < 0) {
        throw new Error(`[lighting] ?lamp=${lampQ} is not a finite non-negative number.`);
      }
    }
    // Defaults leave the shipped path bit-identical: all the transmitted
    // daylight still goes through the unshadowed rect until the spot has been
    // calibrated to the same frame mean and shown to beat it on structure.
    // Promoting an unmeasured change is how the disc survived a day.
    const qnum = (key: string, dflt: number): number => {
      const raw = new URLSearchParams(location.search).get(key);
      if (raw === null) return dflt;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`[lighting] ?${key}=${raw} is not a finite non-negative number.`);
      }
      return v;
    };
    const build = buildInteriorLighting({
      // The landed interior grade. Each of these three multiplies an authored
      // constant in `lightInterior.ts`, and each is here rather than folded into
      // that constant so the size of the correction stays legible: `?dbounce=1`
      // restores exactly what shipped before, which is what an ablation against
      // this decision needs.
      //
      // What is derived, and what is not. The *direction* is derived and the old
      // values are ruled out: `doorBounce` plus `doorGlow` were 44.8 of the 92.0
      // luma of interior lighting on `interior_cold`, the largest term in the
      // room, while standing in for sun bouncing off a floor patch that receives
      // sin(6.2 deg) = 10.8% of the beam and returns about 2% of it at a floor
      // albedo near 0.2. A 2% mechanism cannot be a 49% term. The shipped result
      // was an interior p50 of 181 against an exterior 82 - the room brighter
      // than the dawn it opens onto, which inverts the brief's central contrast.
      //
      // The *exact* landing point is a grade, not a derivation. These three land
      // `interior_cold` at p50 76.9 against 91.6 outdoors in the same round, with
      // 12.67% of the frame below luma 32 where the old values gave 1.60%, so the
      // room is now the darker side of the doorway and has a black point.
      rectShare: qnum("drect", 0.2),
      spotShare: qnum("dspot", 0),
      spotWatts: qnum("dwatts", 40),
      bounceGain: qnum("dbounce", 0.1),
      troffCast: qnum("tcast", 0),
      troffCastMax: qnum("tcastn", 1),
      spotCasts: new URLSearchParams(location.search).get("dnoshadow") !== "1",
      buildingRoot: root,
      glazingShadow: !this.force.clearglass,
      fluorescents,
      coolerSlots: game.tryGet<THREE.Object3D[]>("building.coolerLightSlots") ?? [],
      exteriorLight: game.tryGet<THREE.Object3D>("building.exteriorLight") ?? null,
      entryDoor: game.tryGet<THREE.Object3D>("building.entryDoor") ?? null,
      footprint,
      gain,
      lampGain,
    });
    scene.add(build.group);
    this.interior = build;
    build.setDoorOpenAmount(this.doorOpen);

    const tuned = tuneInteriorMaterials(root, {
      // Not zero: a real room does get sky through its own glazing, and zero
      // makes the shaded side of every interior object pure black. But it has
      // to be small, because the environment is not occluded by the roof.
      //
      // `?ienv=` stages this two ways for a pixel diff. It is not a tuning
      // convenience: this number was authored while `envMapIntensity` was inert
      // (NOTES.md case 21), so it has never been seen applied, and the only
      // honest way to choose it is to capture two values and measure.
      //
      // Measured 2026-08-28 on the `interior` pose, now that it is live:
      // 0.07 -> 0.30 is a 4.3x change in the control and moves the mean of the
      // near gondola by 2.8/255, lifting its floor from 2 to 8. Extrapolating
      // the (linear) indirect term, even 1.0 would be worth about +11. **The
      // interior IBL is a weak channel and was never what made this room
      // black.** So 0.25 here is not a fix, it is just an honest value for a
      // room with a 15 m glass front: 0.07 was authored for a sealed box.
      //
      // The actual problem is that a store interior has no bounce at all in
      // this scene. The troffers are RectAreaLights, so every downward and
      // rearward face - the sides of the packets, the underside of a shelf,
      // the aisle face of a gondola - receives literally nothing and clamps to
      // black, which is why the product silhouettes against the window read as
      // cut-out holes. That belongs to whoever owns this file, not to
      // BuildingSystem, and compensating for it by brightening albedos in
      // BuildingSystem would be the wrong fix in the wrong place. A small
      // interior-only hemisphere or an irradiance probe sampled inside the
      // room is what this needs.
      interiorEnv: this.force.noenv ? 0 : this.ienv,
      lensGain: gain ? 2.4 : 0,
    });

    // Not `...tuned`: it now carries the material and mesh arrays the probe
    // needs, and those must not reach the report — `__LIGHTING` is serialised
    // to JSON by every harness, and a THREE.Material graph is both enormous and
    // cyclic.
    const { materials, lensMeshes, ...tunedCounts } = tuned;
    this.interiorMaterials = materials;
    this.interiorLensMeshes = lensMeshes;

    this.report.interior = {
      built: true,
      troffers: build.troffers.length,
      coolerLights: build.coolerLights.length,
      daylight: !!build.daylight,
      ...build.glazing,
      gain,
      ...tunedCounts,
    };
  }

  /**
   * Capture the room's own light into a probe and hand it to the interior
   * materials, one frame after the world environment lands.
   *
   * The frame ordering is load-bearing and each step depends on the one before:
   * frame 1 attaches the troffers, frame 2 captures the world (so the glazing
   * has a lit forecourt behind it), and only here on frame 3 is the room
   * actually in its final lit state — troffers on, daylight through the
   * storefront, exterior environment installed. A probe taken any earlier
   * photographs a room that is missing one of its own light sources and then
   * feeds that deficit back into every surface in it.
   */
  private ensureInteriorIrradiance(ctx: SystemContext): void {
    if (this.interiorProbeTried || this.frame < 3) return;
    if (!this.interiorMaterials.length) return;
    this.interiorProbeTried = true;
    const { scene, renderer, game } = ctx;

    if (this.force.nobounce || this.force.noenv) {
      this.report.interiorProbe = { built: false, why: "?lforce=nobounce" };
      return;
    }

    const fp = game.tryGet<{ minX: number; maxX: number; minZ: number; maxZ: number; floorY: number }>(
      "building.footprint"
    );
    if (!fp) {
      this.report.interiorProbe = { built: false, why: "no building.footprint" };
      return;
    }

    const probe = captureInteriorIrradiance(renderer, scene, {
      // Room centre at about shelf height. A probe on the floor sees mostly
      // floor and a probe at the ceiling sees mostly ceiling; the useful
      // height is the one the shelved goods occupy.
      position: new THREE.Vector3((fp.minX + fp.maxX) / 2, fp.floorY + 1.35, (fp.minZ + fp.maxZ) / 2),
      size: this.iprobeSize,
      hide: this.interiorLensMeshes,
    });

    // Same gate as the world capture, and for the same reason: a probe with a
    // non-finite texel does not degrade the room, it deletes it. Reject and
    // leave the materials on the dimmed sky, which is the state that shipped
    // for the last two weeks and is merely disappointing rather than broken.
    if (probe.badPixels !== 0 || !(probe.meanLuminance > 0)) {
      probe.dispose();
      const why = `interior probe rejected: badPixels ${probe.badPixels}, mean ${probe.meanLuminance}`;
      this.report.interiorProbe = { built: false, why };
      (window as unknown as { __SYSTEM_ERRORS?: string[] }).__SYSTEM_ERRORS?.push(`lighting: ${why}`);
      return;
    }

    this.interiorProbe = probe;
    // Before assigning, not after. `EnvironmentBinding.sync()` runs from a
    // scene `onBeforeRender` hook, so any frame between the assignment and the
    // exclusion would put these materials straight back on the outdoor sky.
    this.envBinding?.exclude(this.interiorMaterials);
    const applied = applyInteriorIrradiance(this.interiorMaterials, probe.texture, this.ibounce);
    this.report.interiorProbe = {
      built: true,
      applied,
      meanLuminance: probe.meanLuminance,
      intensity: this.ibounce,
      cubeSize: this.iprobeSize,
      hidden: this.interiorLensMeshes.length,
    };
  }

  /**
   * Load `sun.shadow.radius` with whatever the active filter wants, and return
   * it for the report.
   *
   * Under PCF that is a width in texels and a constant. Under contact hardening
   * it is `K = theta * depthRange / frustumWidth`, the scalar that turns a
   * shadow-map depth *difference* into a penumbra radius in UV — see the long
   * note in `lightShaderPatches.ts`. Reusing three's one per-light float for two
   * unrelated quantities is a genuine trap, so it is read off the shadow camera
   * that was just fitted rather than derived twice, and it is recomputed after
   * every refit because the frustum width changes with the camera's field of
   * view and `?sdist=`.
   */
  private setShadowFilterScale(): number {
    if (!this.pcss) {
      this.sun.shadow.radius = this.constantFilterTexels;
      return this.sun.shadow.radius;
    }
    const cam = this.sun.shadow.camera;
    const width = cam.right - cam.left;
    const k = width > 0 ? (this.sunAngularRadius * (cam.far - cam.near)) / width : 0;
    this.sun.shadow.radius = k;
    return k;
  }

  /**
   * Photograph the real scene into the shipped environment, once, after every
   * other system has built its geometry and the interior emitters are in.
   *
   * Ordering is the whole design here. `init()` runs before any other system,
   * so at that point the only things in the scene are the sky dome and this
   * system's lights - which is precisely how the environment came to contain no
   * world. The sky-only PMREM installed in `init()` is the bootstrap that lights
   * the world for this capture; this replaces it with the world.
   *
   * Frame 2 rather than frame 1: `ensureInterior` attaches the troffers, the
   * cooler lights and the storefront daylight on frame 1, and a capture taken
   * on the same frame would photograph an unlit shop through the glazing.
   */
  private ensureWorldEnvironment(ctx: SystemContext): void {
    if (this.worldEnvFrame >= 0 || this.frame < 2) return;
    this.worldEnvFrame = this.frame;
    const { scene, renderer, game } = ctx;
    const gh = game.tryGet<(x: number, z: number) => number>("groundHeight");
    const { x, z, eye, size } = this.envCapture;
    const y = (typeof gh === "function" ? gh(x, z) : 0.155) + eye;

    if (!this.worldEnvEnabled || this.force.flatenv || this.force.noenv || this.force.shadowonly) {
      this.report.worldEnv = {
        built: false,
        why: !this.worldEnvEnabled
          ? "?worldenv=0 — sky-only PMREM forced"
          : this.force.flatenv
            ? "?lforce=flatenv"
            : "environment disabled",
      };
      if (this.mirrors) this.addMirrors(scene, y);
      return;
    }

    // Fit the sun's shadow around the capture point rather than around the
    // player camera for the duration of the capture. `update()` refits against
    // the real camera on the very next frame, so this is not left behind.
    const capturePos = new THREE.Vector3(x, y, z);
    if (this.sun.castShadow) {
      fitSunShadowSphere(this.sun, capturePos, this.shadowFit.distance, this.sunDirection, this.shadowFit);
      this.setShadowFilterScale();
      this.sun.updateMatrixWorld(true);
      this.sun.shadow.camera.updateMatrixWorld(true);
    }

    const built = buildWorldEnvironment(renderer, scene, {
      position: capturePos,
      size,
      dump: new URLSearchParams(location.search).has("envdump"),
      exposure: renderer.toneMappingExposure,
    });

    // `?envscan=1` — is one probe at one point representative of this site?
    //
    // The environment is a single distant-radiance approximation for a scene
    // that is emphatically not distant: there is a canopy over part of it, a
    // building along one side, and a low sun throwing 40 m shadows. So the one
    // point this capture stands at decides how much *sunlit* ground every
    // shaded surface in the project sees, and nothing so far has checked that
    // the chosen point is typical rather than convenient. Capturing a ring of
    // alternatives in the same page load and reporting their lower-hemisphere
    // statistics answers that in one round instead of one round per position,
    // and costs nothing when the flag is absent.
    if (new URLSearchParams(location.search).get("envscan") === "1") {
      const gy = (px: number, pz: number) =>
        (typeof gh === "function" ? gh(px, pz) : 0.155) + eye;
      const spots: [string, number, number][] = [
        ["current", x, z],
        ["forecourt-open", 14, 18],
        ["under-canopy", 0, 20],
        ["pump-island", 3.5, 20],
        ["kerb-east", 20, 26],
        ["lot-north", 0, 32],
        ["lot-south", 0, 8],
        ["building-front", -6, 30],
      ];
      const scan = spots.map(([name, px, pz]) => {
        const b = buildWorldEnvironment(renderer, scene, {
          position: new THREE.Vector3(px, gy(px, pz), pz),
          // Coarse on purpose: this compares irradiance between positions, and
          // irradiance is the lowest-frequency thing the cube carries.
          size: 64,
          exposure: renderer.toneMappingExposure,
        });
        const d = b.down;
        const row = {
          name,
          xz: [px, pz],
          downMean: d.mean,
          downStd: d.std,
          downRB: d.meanR - d.meanB,
          downRGB: [d.meanR, d.meanG, d.meanB],
          // The warm cast Building lost lives here, not in the mean. Ground
          // bounce at dawn is warm because the ground is sunlit; if the probe
          // only sees shadowed ground it is both darker *and* bluer, and the
          // colour is the half that a brightness check cannot see.
          overall: b.meanLuminance,
        };
        b.texture.dispose();
        return row;
      });
      this.report.envScan = scan;
    }

    // The acceptance test, and the reason it is this and not the mean. The
    // sky-only environment's downward face measured a standard deviation of
    // exactly 0.0 - one constant colour over the entire lower hemisphere - and
    // passed the `meanLuminance > 0` check cleanly, because it was a perfectly
    // respectable non-black constant. A guard that tests the wrong property
    // does not merely fail to fire; it actively certifies the defect. NOTES.md
    // case 28.
    const flat = !(built.down.std > 1e-5);
    const badCube = built.faces.reduce((a, f) => a + Math.max(0, f.bad), 0);

    // Reject, do not merely complain. The first version of this guard logged the
    // NaN count and then installed the cube anyway, which turned a contained
    // capture bug into black rounds for four other agents: a poisoned PMREM
    // blacks out every MeshStandardMaterial in the project, direct sun included,
    // while the sky dome and the unlit backdrop keep rendering perfectly and
    // make it look like someone else's material bug. An environment that cannot
    // be trusted must not be published at any intensity.
    if (badCube > 0 || built.badPixels > 0) {
      const peak = Math.max(...built.faces.map((f) => f.maxChannel));
      const where = built.faces
        .filter((f) => f.bad > 0)
        .map((f) => `${f.face} ${f.bad}px ${f.badBox ? `[x${f.badBox[0]}-${f.badBox[2]} y${f.badBox[1]}-${f.badBox[3]}]` : ""}`)
        .join(", ");
      const msg =
        `world environment REJECTED: ${badCube} non-finite cube pixels -> ${built.badPixels} poisoned ` +
        `PMREM pixels. Peak finite channel ${peak.toFixed(1)}, so this is a NaN from a shader, not an ` +
        `HDR overflow. Faces: ${where}. Keeping the sky-only environment.`;
      console.error(`[lighting] ${msg}`);
      // Game only records throws from init/update. This is recoverable - the
      // sky-only environment is still installed and the scene renders - but it
      // must not be silent, because the whole point is that a harness asserting
      // __SYSTEM_ERRORS.length === 0 should refuse the round.
      window.__SYSTEM_ERRORS?.push({ system: "lighting", phase: "update", message: msg });
      built.texture.dispose();
      this.worldEnv = null;
      this.report.worldEnv = {
        built: false,
        why: "non-finite values in capture",
        badCube,
        badFiltered: built.badPixels,
        faces: built.faces,
      };
      // `?envculprit=1` — bisect the scene by visibility and name the object.
      // Expensive (one cube capture per probe) and therefore opt-in, but it is
      // the difference between "1814 non-finite pixels somewhere" and a mesh
      // name plus an instance transform.
      if (new URLSearchParams(location.search).get("envculprit") === "1") {
        const culprit = findEnvCulprit(renderer, scene, { position: capturePos, size });
        this.report.envCulprit = culprit;
        console.error(`[lighting] env culprit bisect: ${JSON.stringify(culprit)}`);
      }
      if (built.dump) window.__ENV_DUMP = built.dump;
      if (this.mirrors) this.addMirrors(scene, y);
      return;
    }
    if (flat) {
      console.error(
        `[lighting] world environment capture is FEATURELESS: downward face std ${built.down.std}. ` +
          `Every vertical surface in the scene will reflect one constant colour. ` +
          `Check that the capture ran after the other systems built their geometry.`
      );
    } else {
      console.log(
        `[lighting] world env @ (${x}, ${y.toFixed(2)}, ${z}) cube ${size}: ` +
          built.faces.map((f) => `${f.face} mean ${f.mean.toFixed(3)} std ${f.std.toFixed(3)}`).join("  |  ")
      );
    }

    this.worldEnv = built;
    this.report.worldEnv = {
      built: true,
      installed: this.envInstall,
      flat,
      badCube,
      badFiltered: built.badPixels,
      position: built.position,
      cubeSize: built.cubeSize,
      faces: built.faces,
      mean: built.meanLuminance,
      min: built.minLuminance,
      max: built.maxLuminance,
    };
    if (built.dump) window.__ENV_DUMP = built.dump;

    if (!this.envInstall) {
      built.texture.dispose();
      this.worldEnv = null;
      if (this.mirrors) this.addMirrors(scene, y);
      return;
    }

    // Swap it in. `setEnvironment` re-binds every material in the graph before
    // it returns, so the sky-only PMREM is safe to dispose immediately after -
    // no material still references it.
    scene.environment = built.texture;
    this.envBinding?.setEnvironment(built.texture, this.envIntensity);
    const old = this.skyOnlyEnv;
    this.skyOnlyEnv = null;
    old?.dispose();

    // After the capture, never before: a mirror in the environment reflects the
    // environment, and a probe that alters what it is measuring is worthless.
    if (this.mirrors) this.addMirrors(scene, y);
  }

  /**
   * `?lmirror=1` — a chrome sphere and a vertical chrome plate at the capture
   * point.
   *
   * The plate is the one that answers the question. A sphere reflects the whole
   * environment and always looks busy; a **vertical** flat mirror reflects a
   * single narrow cone of it, aimed horizontally, which is exactly what every
   * car flank, cabinet side and window mullion in this scene does. If the plate
   * comes back as one flat tone, the lower hemisphere is featureless no matter
   * what the sphere or any statistic says.
   */
  private addMirrors(scene: THREE.Scene, y: number): void {
    const chrome = () => new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0 });
    const { x, z } = this.envCapture;

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 64, 48), chrome());
    ball.position.set(x, y, z);
    ball.name = "lighting-mirror-ball";
    scene.add(ball);

    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7), chrome());
    plate.position.set(x - 2.6, y, z + 0.6);
    // Face roughly back at the camera the `mirror` pose stands at, which is
    // south-east of here, so the plate reflects the north-west quadrant: the
    // store mass, the pumps and the tarmac between them.
    plate.lookAt(x + 6, y, z - 6);
    plate.name = "lighting-mirror-plate";
    scene.add(plate);
  }

  update(_dt: number, _t: number, ctx: SystemContext): void {
    this.frame++;
    this.ensureInterior(ctx);
    this.ensureWorldEnvironment(ctx);
    this.ensureInteriorIrradiance(ctx);
    if (this.sun.castShadow) {
      const texel = fitSunShadow(this.sun, ctx.camera, this.sunDirection, this.shadowFit);
      (this.report.shadow as Record<string, unknown>).texel = texel;
      (this.report.shadow as Record<string, unknown>).radius = this.setShadowFilterScale();
    }
    this.ensureShadowView(ctx);
  }

  /**
   * `?shadowview=1` cannot be installed in `init()`, because `shadow.map` does
   * not exist until either the first shadow render or Perf's
   * `preallocateShadowMaps`, and a viewer built against a null map would draw a
   * black quad that reads as "the whole map is at the near plane" — a confident
   * wrong answer, which is worse than a missing overlay.
   */
  private ensureShadowView(ctx: SystemContext): void {
    if (!this.shadowView || this.shadowViewInstalled) return;
    if (!this.sun.shadow.map) return;
    const view = createShadowMapView(this.sun, ctx.scene, ctx.camera);
    this.shadowViewInstalled = true;
    this.report.shadowView = { ...view.info, installedOnFrame: this.frame };
  }

  dispose(): void {
    this.envBinding?.dispose();
    this.skyOnlyEnv?.dispose();
    this.worldEnv?.texture.dispose();
    // Drop the reference from the materials too. A disposed render target left
    // assigned as an `envMap` is a use-after-free the moment anything re-renders
    // during teardown, and it renders as black rather than throwing.
    for (const m of this.interiorMaterials) {
      if (m.envMap === this.interiorProbe?.texture) {
        m.envMap = null;
        m.needsUpdate = true;
      }
    }
    this.interiorProbe?.dispose();
    this.skyMesh.geometry.dispose();
    (this.skyMesh.material as THREE.Material).dispose();
  }
}
