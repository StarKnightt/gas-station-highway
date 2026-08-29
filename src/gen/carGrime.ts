/**
 * Car weathering: the part that has to know where the wheels and the bumpers
 * are.
 *
 * `applyGrime` in hardsurface.ts already does the things that need a texture -
 * a triplanar noise field, water spots, downward run-off streaks, a general
 * road film and a low-body darkening ramp - and it does them for the pumps and
 * the building too. What it cannot express is anything keyed to a *location on
 * this particular body*, because its masks are all functions of object-space Y
 * and surface normal. A car's dirt is not: the loudest weathering on a real
 * parked car is the spray fan thrown rearward out of each wheel arch, and after
 * that it is the road film wrapped around the bumper corners. Both are about
 * where the wheels are, and neither is a function of height.
 *
 * So this bakes the spatial masks per vertex on the CPU, where they can be
 * measured, and leaves the fine detail to `applyGrime`. Two channels:
 *
 * - **dust**  settles on up-facing panels. Lightens and desaturates.
 * - **film**  road spray and grime. Darkens, and is where the arch fans, the
 *             sills and the bumper corners live.
 *
 * The shapes are fixed at bake time. The strengths are two uniforms, so the
 * intensity pass on the GPU is `uWDust` and `uWFilm` and nothing else - the
 * last attempt at this overshot to matte olive primer and had to be re-authored
 * from scratch, which is the thing worth not repeating.
 */
import * as THREE from "three";
import { ARCH_BASE_Y, ARCH_R, AXLES, CAR } from "./carBody.ts";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export interface CarWeatherOptions {
  /** Overall dryness. 0 = showroom, 1 = a fortnight of commuting. */
  amount?: number;
  /** Metres the arch spray fan trails before it dies out. */
  fanReach?: number;
}

/**
 * Per-vertex weathering weights, as a `vec2` attribute named `aWeather`.
 *
 * Pure CPU. `tools/carweather.mjs` prints the resulting distribution and probes
 * named places on the body, so the masks can be checked without rendering.
 */
export function bakeCarWeather(geo: THREE.BufferGeometry, o: CarWeatherOptions = {}): THREE.BufferGeometry {
  const amount = o.amount ?? 1.0;
  const reach = o.fanReach ?? 0.62;
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  if (!pos || !nrm) return geo;

  const out = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);

    // Outward-facing weight: how much this vertex is flank rather than floor or
    // roof. Keeps the fans and the sill grime off the underbody, which is never
    // seen and would otherwise soak up most of the budget.
    const flank = clamp01(Math.abs(nx));
    const up = clamp01(ny);

    /* ---------------- dust: settles on what faces the sky ---------------- */
    // Bonnet, roof and boot collect a dry film overnight; vertical panels shed
    // it. Squared-ish so the falloff off horizontal is quick, and a small
    // constant so nothing is perfectly clean.
    const dust = 0.1 + 0.9 * Math.pow(up, 1.5);

    /* ---------------- film: road spray, sills, arch fans ---------------- */
    // Sill and lower door.
    //
    // This used to be `smoothstep(0.68, 0.28, y)` - a pure latitude band. It
    // measured well (a 19% upper-to-sill falloff) and read as a bug: a critic
    // called it "an abrupt light-over-dark two-tone split... horizontal,
    // arbitrary, and it ignores the wheel arches and the door bottoms
    // entirely", i.e. a shading error rather than dirt. It was right. Road film
    // does not arrive at a height, it arrives from the tyres, so the band's top
    // edge has to be a function of where the wheels are.
    //
    // Each axle throws a plume that decays slowly rearward and quickly forward,
    // so the film climbs highest just behind an arch and sags toward mid-door
    // and toward the ends. The wobble stops the remaining boundary from reading
    // as an authored curve; without it a scalloped line is still a *drawn* line.
    let plume = 0;
    for (const za of AXLES) {
      const dz = z - za;
      plume = Math.max(plume, Math.exp(-Math.abs(dz) / (dz < 0 ? 1.15 : 0.42)));
    }
    const wobble = 0.028 * Math.sin(z * 4.3 + 1.7) + 0.018 * Math.sin(z * 9.1 - 0.6);
    const yTop = 0.4 + 0.34 * plume + wobble;
    const sill = smoothstep(yTop, yTop - 0.34, y) * flank;

    // Spray fans around each wheel.
    //
    // Measured from the arch *rim*, not from the axle. Keying it to the axle
    // put the peak of the fan at the station where the wheel is - which is a
    // hole, not bodywork, so the strongest part of the mask landed on nothing
    // and the panels either side of the arch came out cleaner than the bumper.
    // Spray leaves the contact patch and radiates outward, so the right model
    // is distance from the arch opening, biased rearward because that is the
    // direction a rotating tyre throws it. That naturally wraps the mask onto
    // the rocker, the panel above the arch and the quarter behind it.
    let fan = 0;
    for (const za of AXLES) {
      const dz = z - za;
      const dy = y - ARCH_BASE_Y;
      const rr = Math.hypot(dz, dy);
      if (rr > ARCH_R + reach * 2.4) continue;
      const radial = Math.exp(-Math.max(0, rr - ARCH_R) / reach);
      // Rearward bias: -1 is directly behind the wheel, +1 directly ahead.
      const dir = rr > 1e-4 ? dz / rr : 0;
      const rear = 0.28 + 0.72 * smoothstep(0.45, -0.85, dir);
      // Spray does not climb past the shoulder; keep it off the upper door.
      const ceiling = smoothstep(ARCH_BASE_Y + 0.92, ARCH_BASE_Y + 0.2, y);
      fan = Math.max(fan, radial * rear * ceiling);
    }
    fan *= flank;

    // Road film wrapping the bumper corners, where the airflow dumps whatever
    // the wheels threw forward. Strongest low and outboard at both ends.
    const endness = smoothstep(1.86, 2.36, Math.abs(z));
    const outboard = 0.35 + 0.65 * smoothstep(0.3, 0.78, Math.abs(x));
    const lowEnd = smoothstep(0.98, 0.42, y);
    const corner = endness * outboard * lowEnd;

    // These are all the same dirt arriving by different routes, so take the
    // strongest rather than summing - summing is how the last attempt reached
    // 0.66 dust over a third of the car.
    const film = Math.max(sill * 0.85, fan, corner * 0.8);

    out[i * 2] = clamp01(dust * amount);
    out[i * 2 + 1] = clamp01(film * amount);
  }
  geo.setAttribute("aWeather", new THREE.BufferAttribute(out, 2));
  return geo;
}

/**
 * Brake dust on a wheel face: heaviest at the rim edge, thinning toward the
 * centre cap. One geometry is shared by all four wheels, so `load` is a single
 * average rather than a front/rear split - splitting it would mean building the
 * rim twice for a difference nobody will resolve at these distances.
 */
export function bakeWheelWeather(geo: THREE.BufferGeometry, load = 0.85): THREE.BufferGeometry {
  const pos = geo.getAttribute("position");
  if (!pos) return geo;
  const out = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getY(i), pos.getZ(i)) / CAR.rimR;
    // Pad dust is flung outward and collects in the barrel and around the
    // spoke roots, so it rises toward the rim rather than the hub.
    const radial = smoothstep(0.25, 0.98, r);
    out[i * 2] = clamp01(0.12 + 0.5 * radial) * load;
    out[i * 2 + 1] = clamp01(0.2 + 0.8 * radial) * load;
  }
  geo.setAttribute("aWeather", new THREE.BufferAttribute(out, 2));
  return geo;
}

export interface CarWeatherUniforms {
  uWDust: { value: number };
  uWFilm: { value: number };
  uWRough: { value: number };
  uWDustCol: { value: THREE.Color };
  uWFilmCol: { value: THREE.Color };
}

/**
 * Consume the baked weights: tint toward dust and road film, and raise
 * roughness where either is heavy.
 *
 * Every replacement is guarded, because a chunk name that does not match would
 * otherwise emit GLSL referring to undeclared varyings - which is exactly the
 * failure in NOTES.md cases 4 and 6, and it link-errors rather than degrading.
 * If a hook is missing the patch simply does not apply and says so.
 */
export function applyCarWeather(
  mat: THREE.Material,
  o: { dust?: number; film?: number; rough?: number; dustColor?: THREE.Color; filmColor?: THREE.Color } = {}
): CarWeatherUniforms {
  const u: CarWeatherUniforms = {
    uWDust: { value: o.dust ?? 0.5 },
    uWFilm: { value: o.film ?? 0.5 },
    uWRough: { value: o.rough ?? 0.45 },
    uWDustCol: { value: (o.dustColor ?? new THREE.Color(0x9a927f)).clone() },
    uWFilmCol: { value: (o.filmColor ?? new THREE.Color(0x2f2a24)).clone() },
  };
  (mat as unknown as { userData: Record<string, unknown> }).userData.carWeather = u;

  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, u);

    const vs = (find: string, add: string) => {
      if (!shader.vertexShader.includes(find)) {
        console.warn(`carWeather: vertex hook "${find}" missing; weathering not applied`);
        return;
      }
      shader.vertexShader = shader.vertexShader.replace(find, add);
    };
    const fs = (find: string, add: string) => {
      if (!shader.fragmentShader.includes(find)) {
        console.warn(`carWeather: fragment hook "${find}" missing; weathering not applied`);
        return;
      }
      shader.fragmentShader = shader.fragmentShader.replace(find, add);
    };

    vs(
      "#include <common>",
      `#include <common>
      attribute vec2 aWeather;
      varying vec2 vWeather;`
    );
    vs(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vWeather = aWeather;`
    );
    fs(
      "#include <common>",
      `#include <common>
      uniform float uWDust;
      uniform float uWFilm;
      uniform float uWRough;
      uniform vec3 uWDustCol;
      uniform vec3 uWFilmCol;
      varying vec2 vWeather;`
    );
    // After the albedo is resolved, before lighting.
    fs(
      "#include <color_fragment>",
      `#include <color_fragment>
      float wDust = clamp(vWeather.x * uWDust, 0.0, 1.0);
      float wFilm = clamp(vWeather.y * uWFilm, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, uWDustCol, wDust);
      diffuseColor.rgb = mix(diffuseColor.rgb, uWFilmCol, wFilm);`
    );
    // Dirt is rough. This is most of what sells it on a clearcoated panel:
    // the grime does not have to be very dark if it kills the reflection.
    fs(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + (wDust * 0.55 + wFilm) * uWRough, 0.04, 1.0);`
    );
  };
  // Append rather than replace: `applyGrime` has already set a key on this
  // material and two materials sharing a key share a compiled program.
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}|car-weather`;
  mat.needsUpdate = true;
  return u;
}
