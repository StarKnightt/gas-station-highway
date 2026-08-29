import * as THREE from "three";

/**
 * Dawn sky dome and the image-based lighting derived from it.
 *
 * The dome is the single source of truth for the whole ambient response: the
 * same material is rendered into a PMREM cube, so if the sky is warm near the
 * horizon then the ground picks up warm bounce, and if it is deep blue overhead
 * then upward-facing surfaces go cool. Authoring these separately is the
 * classic way to end up with an orange key light over a scene that is still
 * lit like an overcast afternoon.
 */

export interface SkyParams {
  sunDirection: THREE.Vector3;
  /** Angular radius of the sun disc in radians, before horizon flattening. */
  sunAngularRadius: number;
  turbidity: number;
}

export interface SkyBuild {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
}

export function buildSkyDome(p: SkyParams): SkyBuild {
  const uniforms: Record<string, THREE.IUniform> = {
    uSunDir: { value: p.sunDirection.clone().normalize() },
    // Working (linear) space radiances. The ratios between these four are what
    // decide whether the sky reads as dawn or as a colour ramp: a real dawn
    // zenith is roughly 1/8 the luminance of the horizon band and much more
    // saturated, and the warm band is narrow.
    uZenith: { value: new THREE.Color(0.020, 0.046, 0.132) },
    uMid: { value: new THREE.Color(0.068, 0.128, 0.252) },
    uHorizon: { value: new THREE.Color(0.325, 0.280, 0.250) },
    uWarmBand: { value: new THREE.Color(0.98, 0.475, 0.190) },
    uSunAureole: { value: new THREE.Color(1.55, 0.66, 0.235) },
    // The disc has to beat the sky it sits in by roughly two orders of
    // magnitude, not by one. At 3.7 against a horizon of ~0.29 the ratio was
    // 13x, and ACES at exposure 1.25 maps 13x into 157 -> 253 of 255: the disc
    // was drawn, was in frame, and peaked 3 levels short of white, which is why
    // it read as "the sun is not drawn at all". A real 6-degree sun still runs
    // ~100x its own sky band even after ten air masses of extinction.
    //
    // Safe to raise, and the reason is worth keeping: the disc subtends
    // pi*0.0185^2 / 4pi = 8.5e-5 of the sphere, so an 8x lift adds ~2% to the
    // mean env radiance - it cannot move the ambient that was just rebalanced.
    // It is also one of the two terms `evaluateSky` deliberately omits, so the
    // `skyRadiance` service contract does not change either.
    uSunDisc: { value: new THREE.Color(29.6, 13.0, 4.4) },
    uGround: { value: new THREE.Color(0.055, 0.045, 0.036) },
    uSunRadius: { value: p.sunAngularRadius },
    uTurbidity: { value: p.turbidity },
    uCloudGain: { value: 1.0 },
  };

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uSunDir, uZenith, uMid, uHorizon, uWarmBand, uSunAureole, uSunDisc, uGround;
      uniform float uSunRadius, uTurbidity, uCloudGain;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float a = hash(i), b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p){
        // Non-harmonic octave steps, for the reason recorded in NOTES.md #5:
        // doubling every octave lines every lattice up and produces plaid.
        float v = 0.0, a = 0.5;
        v += vnoise(p) * a;            p = p * 2.17 + vec2(11.3, 4.7);  a *= 0.52;
        v += vnoise(p) * a;            p = p * 2.41 - vec2(3.9, 17.1);  a *= 0.5;
        v += vnoise(p) * a;            p = p * 1.93 + vec2(7.7, 23.3);  a *= 0.48;
        v += vnoise(p) * a;            p = p * 2.63 - vec2(19.1, 6.1);  a *= 0.5;
        v += vnoise(p) * a;
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        vec3 s = normalize(uSunDir);
        float h = d.y;

        /* ---- vertical luminance falloff ---- */
        // Real skies fall off far faster than a linear ramp. Two stacked
        // power curves give a bright, compressed horizon and a dark zenith
        // without a visible banding edge between them.
        float up = clamp(h, 0.0, 1.0);
        vec3 col = mix(uHorizon, uMid, pow(up, 0.30));
        col = mix(col, uZenith, pow(up, 0.72));

        /* ---- sun-facing tangent frame ---- */
        vec3 wUp = vec3(0.0, 1.0, 0.0);
        vec3 sRight = normalize(cross(s, wUp));
        vec3 sUp = cross(sRight, s);
        float px = dot(d, sRight);
        float py = dot(d, sUp);
        float pz = max(dot(d, s), 1e-4);
        float angle = length(vec2(px, py)) / pz;

        /* ---- warm scatter band ---- */
        // Anisotropic: the glow spreads much further along the horizon than it
        // does vertically, which is what makes a low sun look low.
        float horizonBand = exp(-abs(h) * 5.6);
        float aureole = exp(-angle * 6.5) + 0.30 * exp(-angle * 1.6);
        col += uSunAureole * aureole * (0.24 + horizonBand * 1.15) * uTurbidity;
        // The band round the rest of the horizon is much weaker than the part
        // near the sun. Making it uniform is what turns a sunrise into a dome
        // of flat cream, which is the first thing a critic notices.
        float azimuthal = pow(max(dot(normalize(vec3(d.x, 1e-5, d.z)), normalize(vec3(s.x, 1e-5, s.z))) * 0.5 + 0.5, 0.0), 3.5);
        col += uWarmBand * horizonBand * (0.055 + 0.62 * azimuthal);

        /* ---- the disc ---- */
        // Flattened vertically by refraction, softened by haze, and reddened
        // toward the limb. A hard white circle at 6 degrees of elevation is
        // the single most common tell in a CG sunrise.
        float ax = px / pz;
        float ay = (py / pz) / 0.68;
        float r = length(vec2(ax, ay)) / uSunRadius;
        // A wide soft shoulder rather than a crisp edge: at 6 degrees the light
        // is crossing 10 air masses and the limb genuinely dissolves.
        float disc = 1.0 - smoothstep(0.22, 1.08, r);
        // Limb darkening plus extinction: the top of a horizon sun is yellower
        // than its base, so tint by absolute elevation as well as by radius.
        float limb = pow(clamp(1.0 - r * r * 0.82, 0.0, 1.0), 0.45);
        vec3 discCol = uSunDisc * mix(vec3(0.72, 0.34, 0.14), vec3(1.0), limb);
        discCol *= mix(1.0, 0.55, clamp((s.y - h) * 26.0 + 0.5, 0.0, 1.0));
        col += discCol * disc;
        // A short smear either side, the way a telephoto sunrise pulls out.
        // The coefficient drops as the disc rises so the streak stays a streak
        // rather than becoming a hot bar; it is widened instead, which is what
        // actually reads as glare.
        col += uSunDisc * 0.022 * exp(-abs(ay) * 22.0) * exp(-abs(ax) / (uSunRadius * 6.0));
        // Veiling glare: the wide, weak bleed a very bright source puts into the
        // air (and into a lens) around itself. This is the cue whose absence
        // makes a blown disc look like a white sticker pasted on a gradient.
        // Deliberately tied to uSunDisc, not uSunAureole, for two reasons: the
        // disc terms are omitted from the evaluateSky CPU port so this cannot
        // desync the skyRadiance service, and it keeps the ambient fixed.
        // Budget: peak 0.074 over an e-folding of 0.2 rad is 2*pi/25 = 0.25 sr,
        // so ~1.5% of mean env radiance - inside the noise of the rebalance.
        col += uSunDisc * 0.0025 * exp(-angle * 5.0);

        /* ---- thin stratus, lit from underneath ---- */
        vec2 cuv = d.xz / max(abs(h) + 0.10, 0.10);
        float cl = fbm(cuv * 0.48 + vec2(3.1, 1.7));
        cl = smoothstep(0.50, 0.87, cl) * smoothstep(0.015, 0.26, h) * smoothstep(1.0, 0.40, h);
        float underlit = pow(clamp(dot(d, s) * 0.5 + 0.5, 0.0, 1.0), 3.0);
        vec3 cloudCol = mix(vec3(0.20, 0.20, 0.245), uWarmBand * 0.92, underlit);
        col = mix(col, cloudCol, clamp(cl * 0.70 * uCloudGain, 0.0, 1.0));

        /* ---- below the horizon ---- */
        // Warm dust rather than a hard seam. This half of the dome is what the
        // PMREM samples for downward-facing surfaces, so it doubles as the
        // ground-bounce term of the IBL and must not be black.
        col = mix(col, uGround, smoothstep(0.0, -0.10, h));

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1400, 64, 40), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = "sky-dome";
  return { mesh, material, uniforms };
}

/* ==========================================================================
 * The sky radiance service
 * ========================================================================== */

/**
 * Scene-referred **linear sRGB primaries**, not display sRGB, and not tone
 * mapped. These are the same numbers the sky dome writes to `gl_FragColor`
 * before `<tonemapping_fragment>`, so a consumer that wants a display value
 * must apply ACES and the sRGB transfer function itself.
 *
 * Stated explicitly because three separate defects today came from display
 * values being handed to code that expected linear ones, two of them in
 * vegetation's own files (NOTES cases 24 and 27). An ambiguous colour contract
 * between two systems is a guaranteed lost round for one of them.
 */
export const SKY_RADIANCE_COLOUR_SPACE = "linear-srgb-scene-referred" as const;

/**
 * Elevation at which `atHorizon` samples the dome, in radians (1.0 degrees).
 *
 * Not zero. Distant geometry sits *at* the skyline, but the value it should
 * dissolve into is the air immediately above it, and h = 0 is exactly where the
 * dome starts mixing toward `uGround` for the lower hemisphere. Sampling the
 * seam would hand consumers a value contaminated by the ground-bounce term.
 */
export const SKY_HORIZON_ELEVATION = 0.01745;

export interface SkyRadianceService {
  readonly colourSpace: typeof SKY_RADIANCE_COLOUR_SPACE;
  /** Radiance arriving from `dir` (need not be normalised, +Y up). */
  at(dir: THREE.Vector3, out?: THREE.Color): THREE.Color;
  /** Radiance just above the skyline at compass azimuth `az` in radians. */
  atHorizon(az: number, out?: THREE.Color): THREE.Color;
  /** Radiance just above the skyline on `dir`'s azimuth, ignoring its pitch. */
  horizonToward(dir: THREE.Vector3, out?: THREE.Color): THREE.Color;
  readonly horizonElevation: number;
  /**
   * Worst relative disagreement between this function and a GPU readback of
   * the actual dome, over the probe set. Above ~0.02 the service is lying and
   * the consumer should be told rather than quietly given a wrong colour.
   */
  gpuAgreement: number;
  /** True once the GPU cross-check has run and passed. */
  verified: boolean;
}

const _sRight = new THREE.Vector3();
const _sUp = new THREE.Vector3();
const _dh = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _dn = new THREE.Vector3();
const _sn = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU evaluation of the sky dome's radiance for one direction.
 *
 * **A port, and ports drift**, which is why `verifySkyRadiance` exists and why
 * the service refuses to claim it is verified without it. Deliberately omits
 * three terms of the fragment shader, and the omissions are the interesting
 * part of the contract:
 *
 * - **The sun disc.** A 1-degree feature now reaching radiance 29.6. Including
 *   it would make the value near the sun's azimuth swing by more than an order
 *   of magnitude across a few degrees, which is useless as a convergence
 *   target for distant geometry - haze does not carry the disc, it carries the
 *   scatter around it. The aureole, the veiling glare and the horizontal smear
 *   *are* all included, because those are the parts that genuinely tint the
 *   air. The dividing line is angular width, not which uniform scales the
 *   term: the veil and the smear are scaled by `uSunDisc` but are 11.5 and 6.4
 *   degrees wide respectively, so they are air, not disc. Getting that line
 *   wrong is what made the service diverge 2.3% when the glare was added.
 * - **The stratus layer.** Stochastic `fbm`, and porting a noise function is
 *   the single most likely place for a CPU/GPU port to diverge invisibly. It
 *   modulates by at most 0.70 and only above h = 0.015, so excluding it costs
 *   accuracy well inside the tolerance the cross-check enforces.
 */
function evaluateSky(
  d: THREE.Vector3,
  s: THREE.Vector3,
  u: Record<string, THREE.IUniform>,
  out: THREE.Color
): THREE.Color {
  _dn.copy(d).normalize();
  _sn.copy(s).normalize();
  const h = _dn.y;

  const horizon = u.uHorizon.value as THREE.Color;
  const mid = u.uMid.value as THREE.Color;
  const zenith = u.uZenith.value as THREE.Color;
  const aur = u.uSunAureole.value as THREE.Color;
  const warm = u.uWarmBand.value as THREE.Color;
  const ground = u.uGround.value as THREE.Color;
  const turbidity = u.uTurbidity.value as number;

  const up = Math.min(1, Math.max(0, h));
  const t1 = Math.pow(up, 0.3);
  const t2 = Math.pow(up, 0.72);
  let r = horizon.r + (mid.r - horizon.r) * t1;
  let g = horizon.g + (mid.g - horizon.g) * t1;
  let b = horizon.b + (mid.b - horizon.b) * t1;
  r += (zenith.r - r) * t2;
  g += (zenith.g - g) * t2;
  b += (zenith.b - b) * t2;

  _sRight.copy(_sn).cross(WORLD_UP).normalize();
  _sUp.copy(_sRight).cross(_sn);
  const px = _dn.dot(_sRight);
  const py = _dn.dot(_sUp);
  const pz = Math.max(_dn.dot(_sn), 1e-4);
  const angle = Math.hypot(px, py) / pz;

  const horizonBand = Math.exp(-Math.abs(h) * 5.6);
  const aureole = Math.exp(-angle * 6.5) + 0.3 * Math.exp(-angle * 1.6);
  const aScale = aureole * (0.24 + horizonBand * 1.15) * turbidity;
  r += aur.r * aScale;
  g += aur.g * aScale;
  b += aur.b * aScale;

  // Veiling glare and the horizontal smear. Both are scaled by uSunDisc, and
  // the disc proper is still omitted - but these two are not the disc. The
  // veil e-folds over 0.2 rad (11.5 deg) and the smear now runs 6.4 deg wide,
  // so by this function's own stated test - does the term genuinely tint the
  // air, as the aureole does - they belong here. Omitting them is what made
  // the service diverge 2.3% at az 210, 8.7 deg off the sun: 1.7% veil plus
  // 0.6% smear, which is the whole of the error.
  const disc = u.uSunDisc.value as THREE.Color;
  const sunRadius = u.uSunRadius.value as number;
  const veil = 0.0025 * Math.exp(-angle * 5.0);
  const ay = py / pz / 0.68;
  const ax = px / pz;
  const smear = 0.022 * Math.exp(-Math.abs(ay) * 22.0) * Math.exp(-Math.abs(ax) / (sunRadius * 6.0));
  const dScale = veil + smear;
  r += disc.r * dScale;
  g += disc.g * dScale;
  b += disc.b * dScale;

  _dh.set(_dn.x, 1e-5, _dn.z).normalize();
  _sh.set(_sn.x, 1e-5, _sn.z).normalize();
  const azimuthal = Math.pow(Math.max(_dh.dot(_sh) * 0.5 + 0.5, 0), 3.5);
  const wScale = horizonBand * (0.055 + 0.62 * azimuthal);
  r += warm.r * wScale;
  g += warm.g * wScale;
  b += warm.b * wScale;

  const below = smoothstep(0.0, -0.1, h);
  if (below > 0) {
    r += (ground.r - r) * below;
    g += (ground.g - g) * below;
    b += (ground.b - b) * below;
  }
  return out.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

export function makeSkyRadianceService(
  uniforms: Record<string, THREE.IUniform>,
  sunDirection: THREE.Vector3
): SkyRadianceService {
  const scratch = new THREE.Color();
  const dir = new THREE.Vector3();
  const svc: SkyRadianceService = {
    colourSpace: SKY_RADIANCE_COLOUR_SPACE,
    horizonElevation: SKY_HORIZON_ELEVATION,
    gpuAgreement: NaN,
    verified: false,
    at(d, out) {
      return evaluateSky(d, sunDirection, uniforms, out ?? scratch);
    },
    atHorizon(az, out) {
      const c = Math.cos(SKY_HORIZON_ELEVATION);
      dir.set(c * Math.cos(az), Math.sin(SKY_HORIZON_ELEVATION), c * Math.sin(az));
      return evaluateSky(dir, sunDirection, uniforms, out ?? scratch);
    },
    horizonToward(d, out) {
      return svc.atHorizon(Math.atan2(d.z, d.x), out);
    },
  };
  return svc;
}

/**
 * Render the real dome from a set of directions and compare against the CPU
 * port, so a drifted port is a loud failure rather than a subtly wrong colour
 * handed to another system.
 *
 * This is the specific defence against the failure family that has cost this
 * project the most rounds - a CPU probe and the GPU render answering different
 * questions and both looking right (NOTES 21, 22, 29). The service is the CPU
 * side; the dome is the truth; nothing else in the project would ever compare
 * them.
 *
 * Costs 18 renders of one sphere into an 8x8 target, once, at init.
 */
export function verifySkyRadiance(
  renderer: THREE.WebGLRenderer,
  skyMesh: THREE.Mesh,
  svc: SkyRadianceService,
  tolerance = 0.02
): { agreement: number; worst: string; probes: number } {
  const rt = new THREE.WebGLRenderTarget(8, 8, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
  });
  const cam = new THREE.PerspectiveCamera(3, 1, 0.1, 4000);
  const scene = new THREE.Scene();
  const parent = skyMesh.parent;
  scene.add(skyMesh);

  const dirs: { d: THREE.Vector3; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const az = (i / 12) * Math.PI * 2;
    const c = Math.cos(SKY_HORIZON_ELEVATION);
    dirs.push({
      d: new THREE.Vector3(c * Math.cos(az), Math.sin(SKY_HORIZON_ELEVATION), c * Math.sin(az)),
      label: `horizon az ${((az * 180) / Math.PI) | 0}`,
    });
  }
  for (const el of [0.1, 0.25, 0.5, 0.8, -0.05, -0.2]) {
    const c = Math.sqrt(Math.max(0, 1 - el * el));
    dirs.push({ d: new THREE.Vector3(c * 0.6, el, c * -0.8), label: `elev ${el}` });
  }

  const buf = new Uint16Array(8 * 8 * 4);
  const prev = renderer.getRenderTarget();
  const cpu = new THREE.Color();
  let agreement = 0;
  let worst = "none";
  try {
    for (const { d, label } of dirs) {
      cam.position.set(0, 0, 0);
      cam.lookAt(d.x * 100, d.y * 100, d.z * 100);
      cam.updateMatrixWorld(true);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, buf);
      // Centre 4x4 only: the 3-degree frustum edge picks up a slightly
      // different direction, and averaging the whole tile would blur the very
      // gradient being checked.
      let gr = 0;
      let gg = 0;
      let gb = 0;
      let n = 0;
      for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
          const i = (y * 8 + x) * 4;
          gr += halfToFloat(buf[i]);
          gg += halfToFloat(buf[i + 1]);
          gb += halfToFloat(buf[i + 2]);
          n++;
        }
      }
      gr /= n;
      gg /= n;
      gb /= n;
      svc.at(d, cpu);
      // Relative to the channel magnitude, with a floor so a near-black
      // channel cannot report a huge relative error from rounding alone.
      const err = Math.max(
        Math.abs(cpu.r - gr) / Math.max(gr, 0.02),
        Math.abs(cpu.g - gg) / Math.max(gg, 0.02),
        Math.abs(cpu.b - gb) / Math.max(gb, 0.02)
      );
      if (err > agreement) {
        agreement = err;
        worst = `${label}: cpu ${cpu.r.toFixed(4)},${cpu.g.toFixed(4)},${cpu.b.toFixed(4)} vs gpu ${gr.toFixed(4)},${gg.toFixed(4)},${gb.toFixed(4)}`;
      }
    }
  } finally {
    renderer.setRenderTarget(prev);
    rt.dispose();
    if (parent) parent.add(skyMesh);
    else scene.remove(skyMesh);
  }

  svc.gpuAgreement = agreement;
  svc.verified = agreement <= tolerance;
  return { agreement, worst, probes: dirs.length };
}

/** IEEE 754 half -> float, so we can read a HalfFloat render target back. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + f / 1024);
}

export interface EnvBuild {
  texture: THREE.Texture;
  /** Mean linear luminance of the captured environment. Zero means it failed. */
  meanLuminance: number;
  minLuminance: number;
  maxLuminance: number;
  /** Non-finite pixels in the filtered result. Must be 0. */
  badPixels: number;
}

/** Luminance statistics over one cube face, in linear radiance. */
export interface FaceStat {
  face: string;
  mean: number;
  std: number;
  min: number;
  max: number;
  /**
   * Pixels with a non-finite channel. **This is not a diagnostic afterthought.**
   * The cube is a half-float target, so any radiance above 65504 - which one
   * mirror-smooth surface catching a 5.6-intensity sun reaches easily - stores
   * as `Inf`, and the PMREM's GGX filter turns a single `Inf` into `NaN` across
   * a whole neighbourhood of every mip. A statistics pass that skips non-finite
   * samples, which is the obvious way to write one, reports a completely healthy
   * mean and standard deviation for a poisoned cube.
   */
  bad: number;
  /**
   * How the `bad` pixels split. The two have completely different causes and
   * completely different fixes: `inf` is a finite shader result too large for
   * a half-float, which is a range problem solved by clamping the capture,
   * while `nan` is arithmetic that has no answer at all — a zero-length
   * `normalize`, a `0/0`, `pow` of a negative base — which is a correctness
   * problem in whichever shader produced it. Counting them together lets an
   * overflow masquerade as a maths bug for as long as it takes to notice.
   */
  nan: number;
  inf: number;
  /**
   * Per-channel means over the finite samples.
   *
   * Ground bounce at dawn is warm because the ground is sunlit, and skylight is
   * blue. A probe that happens to see only shadowed ground is therefore both
   * darker *and* bluer than one that sees sunlit ground — and a luminance-only
   * statistic reports the first half and hides the second. Building lost a
   * shaded elevation's warm cast (R-B 18.8 to 3.1) when this capture went
   * default, with the mean moving far less than the colour did.
   */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Largest single channel, which is what overflows - not the luminance. */
  maxChannel: number;
  /** `[x0,y0,x1,y1]` covering the non-finite pixels, to identify the culprit. */
  badBox: [number, number, number, number] | null;
}

export interface WorldEnvBuild extends EnvBuild {
  /** Per-face statistics of the *captured cube*, before any PMREM filtering. */
  faces: FaceStat[];
  /** The face pointing straight down. Its `std` is the acceptance test. */
  down: FaceStat;
  /** The face pointing straight up, for the contrast the horizon step needs. */
  up: FaceStat;
  cubeSize: number;
  position: [number, number, number];
  /** Display-referred 3x2 face grid, as a PNG data URL, for the eyeball test. */
  dump: string | null;
}

/**
 * WebGL cube face order. `readRenderTargetPixels`'s sixth argument indexes this
 * list, so face 3 is unambiguously the one looking straight down whatever the
 * row order of the returned buffer is — which is why the statistics below are
 * reported per face rather than per hemisphere. Deriving a world direction from
 * a (face, row, column) triple needs three separate conventions to be right at
 * once, and a hemisphere split that silently has its sign inverted would report
 * the sky's healthy variance as the ground's. Per face, there is nothing to get
 * wrong: a constant lower hemisphere shows up as `std === 0` on face 3.
 */
const FACE_NAMES = ["+X", "-X", "+Y (up)", "-Y (down)", "+Z", "-Z"];

/** IEEE 754 float -> half is not needed; this is the display transform for the
 *  dump only. Narkowicz's ACES fit, which is what three's ACESFilmicToneMapping
 *  approximates, so the dump is roughly comparable to a capture. */
function acesToByte(x: number, exposure: number): number {
  const v = Math.max(0, x * exposure * 0.6);
  const t = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  const c = Math.min(1, Math.max(0, t));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Capture the **real scene** into a PMREM cube for image-based lighting.
 *
 * ## Why this exists
 *
 * `buildEnvironment` below renders a two-object scene — the sky dome plus one
 * flat-coloured disc standing in for the ground. That produces a perfectly
 * plausible environment: it is not black, its mean luminance is healthy, and
 * every material in the project responds to it. What it does not contain is
 * *the world*. The lower hemisphere was measured at standard deviation exactly
 * **0.0** over its whole extent, so every downward-facing reflection vector in
 * the scene — which is every vertical surface, i.e. every car flank, cabinet
 * side, chamfer and window mullion — returned one constant colour. A perfect
 * chrome car rendered as a flat tan car, and four systems spent a day tuning
 * metalness, roughness and `envMapIntensity` against it.
 *
 * A chamfer, a crease or a rim highlight exists because it reflects *something
 * different* from the face beside it. Against a constant hemisphere a correct
 * chamfer on a vertical face reflects the same colour as the face, so the
 * feature is geometrically present and optically invisible. That is not a
 * material-tuning problem and no material value fixes it.
 *
 * ## The recursion, and how it is resolved
 *
 * The scene being captured contains materials that sample `scene.environment`,
 * which is the thing being built. This is resolved by ordering rather than by
 * iteration: the sky-only environment from `buildEnvironment` is installed
 * first and lights the world, then this captures the world lit by it. One
 * bounce. Capturing a second time would change the result again, and there is
 * no visible return on it.
 *
 * ## Cost
 *
 * Six renders of the full scene at `size`, once, plus the PMREM filter. Nothing
 * per frame. The sun does not move in this scene; if anything ever animates it,
 * this has to be re-run and the caller has to re-bind — `EnvironmentBinding
 * .setEnvironment` is the entry point for that and re-binds every material
 * before it returns.
 */
export function buildWorldEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: {
    position: THREE.Vector3;
    size?: number;
    near?: number;
    far?: number;
    /** Exposure used for the display-referred dump only. */
    exposure?: number;
    dump?: boolean;
  }
): WorldEnvBuild {
  const size = opts.size ?? 256;
  const near = opts.near ?? 0.3;
  const far = opts.far ?? 3000;

  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cam = new THREE.CubeCamera(near, far, cubeRT);
  cam.position.copy(opts.position);
  cam.updateMatrixWorld(true);

  // Tone mapping and the output colour transform are both skipped by three
  // automatically for a non-XR render target ('WebGLPrograms': 'toneMapping =
  // NoToneMapping' unless 'currentRenderTarget === null'), so the cube receives
  // linear scene radiance without this function touching renderer state. Do not
  // "fix" that by setting 'renderer.toneMapping' here: it would be a no-op on
  // the result and would recompile every material in the scene twice.
  const autoUpdate = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  // One depth pass for the whole capture rather than six identical ones: the
  // sun's shadow camera is only refit in LightingSystem.update, so all six
  // faces would rasterise the same 8192 map.
  renderer.shadowMap.needsUpdate = true;
  const prevTarget = renderer.getRenderTarget();
  try {
    cam.update(renderer, scene);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoUpdate;
    renderer.shadowMap.needsUpdate = true;
  }

  /* ---------------- measure the cube, per face ---------------- */
  const faces: FaceStat[] = [];
  let dump: string | null = null;
  const canvas = opts.dump ? document.createElement("canvas") : null;
  let ctx2d: CanvasRenderingContext2D | null = null;
  if (canvas) {
    canvas.width = size * 3;
    canvas.height = size * 2;
    ctx2d = canvas.getContext("2d");
  }

  const buf = new Uint16Array(size * size * 4);
  for (let f = 0; f < 6; f++) {
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = 0;
    let bad = 0;
    let nan = 0;
    let inf = 0;
    let maxChannel = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let bx0 = size;
    let by0 = size;
    let bx1 = -1;
    let by1 = -1;
    try {
      renderer.readRenderTargetPixels(cubeRT, 0, 0, size, size, buf, f);
    } catch (err) {
      console.warn(`[lighting] could not read cube face ${f}: ${String(err)}`);
      faces.push({
        face: FACE_NAMES[f], mean: NaN, std: NaN, min: NaN, max: NaN, bad: -1, nan: -1, inf: -1,
        meanR: NaN, meanG: NaN, meanB: NaN, maxChannel: NaN, badBox: null,
      });
      continue;
    }
    const img = ctx2d ? ctx2d.createImageData(size, size) : null;
    for (let i = 0; i < size * size; i++) {
      const r = halfToFloat(buf[i * 4]);
      const g = halfToFloat(buf[i * 4 + 1]);
      const b = halfToFloat(buf[i * 4 + 2]);
      const finite = Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b);
      if (img) {
        // No row flip. 'readRenderTargetPixels' on a *cube* face already comes
        // back in the face's own top-down order, unlike a 2D target, so the
        // bottom-up correction that looks obviously right here puts the sky at
        // the bottom of every face. Verified by eye against the first dump.
        const j = i * 4;
        const e = opts.exposure ?? 1.25;
        if (finite) {
          img.data[j] = acesToByte(r, e);
          img.data[j + 1] = acesToByte(g, e);
          img.data[j + 2] = acesToByte(b, e);
        } else {
          // Magenta, not black. 'acesToByte(NaN)' returns NaN, which a
          // Uint8ClampedArray silently stores as 0 - so the pixels the dump
          // exists to find were being painted the same colour as a shadow.
          // A bounding box says where; only the image says *what*.
          img.data[j] = 255;
          img.data[j + 1] = 0;
          img.data[j + 2] = 255;
        }
        img.data[j + 3] = 255;
      }
      if (!finite) {
        bad++;
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) nan++;
        else inf++;
        const px = i % size;
        const py = (i / size) | 0;
        if (px < bx0) bx0 = px;
        if (py < by0) by0 = py;
        if (px > bx1) bx1 = px;
        if (py > by1) by1 = py;
        continue;
      }
      if (r > maxChannel) maxChannel = r;
      if (g > maxChannel) maxChannel = g;
      if (b > maxChannel) maxChannel = b;
      sumR += r;
      sumG += g;
      sumB += b;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += y;
      sumSq += y * y;
      if (y < min) min = y;
      if (y > max) max = y;
      n++;
    }
    if (img && ctx2d) ctx2d.putImageData(img, (f % 3) * size, ((f / 3) | 0) * size);
    const mean = n ? sum / n : 0;
    faces.push({
      face: FACE_NAMES[f],
      mean,
      std: n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0,
      min: n ? min : 0,
      max,
      bad,
      nan,
      inf,
      meanR: n ? sumR / n : 0,
      meanG: n ? sumG / n : 0,
      meanB: n ? sumB / n : 0,
      maxChannel,
      badBox: bx1 >= 0 ? [bx0, by0, bx1, by1] : null,
    });
  }
  if (canvas) dump = canvas.toDataURL("image/png");

  /* ---------------- filter into the PMREM ---------------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const rt = pmrem.fromCubemap(cubeRT.texture);
  pmrem.dispose();
  cubeRT.dispose();

  const overall = readbackLuminance(renderer, rt);

  return {
    texture: rt.texture,
    ...overall,
    faces,
    up: faces[2],
    down: faces[3],
    cubeSize: size,
    position: [opts.position.x, opts.position.y, opts.position.z],
    dump,
  };
}

/** Mean/min/max linear luminance of a PMREM target, over the whole cubeUV
 *  layout. Not a corner of it: the layout puts the sharpest mip in one region
 *  and the blurriest in another, so a 64 px corner reads one uniform blur level
 *  and cannot tell a working environment from a constant one. */
function readbackLuminance(
  renderer: THREE.WebGLRenderer,
  rt: THREE.WebGLRenderTarget
): { meanLuminance: number; minLuminance: number; maxLuminance: number; badPixels: number } {
  try {
    const w = rt.width;
    const h = rt.height;
    const buf = new Uint16Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    let mean = 0;
    let min = Infinity;
    let max = 0;
    let n = 0;
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      const r = halfToFloat(buf[i * 4]);
      const g = halfToFloat(buf[i * 4 + 1]);
      const b = halfToFloat(buf[i * 4 + 2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        bad++;
        continue;
      }
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      mean += y;
      if (y < min) min = y;
      if (y > max) max = y;
      n++;
    }
    // A single NaN in a PMREM is not a statistical blemish, it is a scene-wide
    // outage: every 'MeshStandardMaterial' that samples it goes black, direct
    // light included, while unlit materials carry on looking perfect.
    return { meanLuminance: n ? mean / n : 0, minLuminance: n ? min : 0, maxLuminance: max, badPixels: bad };
  } catch (err) {
    console.warn(`[lighting] could not read back the environment map: ${String(err)}`);
    return { meanLuminance: NaN, minLuminance: NaN, maxLuminance: NaN, badPixels: -1 };
  }
}

/**
 * Render the dome into a PMREM cube for image-based lighting, then read it back
 * and report its luminance.
 *
 * **This is the bootstrap pass and it deliberately does not contain the world.**
 * Its lower hemisphere is one constant colour by construction, which is exactly
 * the defect `buildWorldEnvironment` exists to fix; the sky-only capture is
 * still needed because the world has to be lit by *something* before it can be
 * photographed. Anything shipped as the scene's final environment must come
 * from `buildWorldEnvironment`, and `LightingSystem` asserts that it did.
 *
 * `fromScene()` defaults to a 0.1..100 m camera, which clipped the 1400 m dome
 * entirely and produced a black environment - NOTES.md territory, and the
 * reason this function measures the result instead of trusting it. A black
 * environment does not throw and does not look obviously wrong; it just makes
 * every material read flat.
 *
 * Note what that measurement could and could not catch: `meanLuminance > 0`
 * detects a *black* environment and is blind to a *featureless* one, and a
 * featureless one is what shipped for a day. See NOTES.md case 28.
 */
export function buildEnvironment(
  renderer: THREE.WebGLRenderer,
  skyMaterial: THREE.ShaderMaterial,
  skyGeometry: THREE.BufferGeometry,
  /**
   * Radiance of the ground seen from the middle of the forecourt: sunlit
   * asphalt at 6 degrees, so warm and not very bright. This is the entire
   * bounce term. Putting it in the environment rather than in a separate
   * up-facing light is deliberate - `envMapIntensity` is per material, so the
   * sealed interior can opt out of it, whereas an extra directional light
   * would shine straight through the roof and warm the ceiling tiles.
   */
  groundRadiance: THREE.Color
): EnvBuild {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(skyGeometry, skyMaterial);
  envSky.frustumCulled = false;
  envScene.add(envSky);

  const groundGeo = new THREE.CircleGeometry(900, 48);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshBasicMaterial({ color: groundRadiance, side: THREE.DoubleSide, fog: false });
  groundMat.toneMapped = false;
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.position.y = -1.4;
  groundMesh.frustumCulled = false;
  envScene.add(groundMesh);

  const rt = pmrem.fromScene(envScene, 0.0, 1, 4000);
  envScene.clear();
  groundGeo.dispose();
  groundMat.dispose();
  pmrem.dispose();

  return { texture: rt.texture, ...readbackLuminance(renderer, rt) };
}
