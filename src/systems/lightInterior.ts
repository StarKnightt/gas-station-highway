import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";

/**
 * Interior electric light: lay-in fluorescent troffers, the reach-in cooler
 * tubes, and the warm sun spill through the entry door.
 *
 * The point of this module is a *contrast*, not an illumination level. Outside
 * is a 6 degree sun at roughly 2700 K; inside is 4100 K lamp phosphor with the
 * faint green spike that every real convenience store has and that nobody ever
 * puts in a render. If the interior comes out the same colour as the forecourt
 * the whole storefront collapses into a hole in the wall.
 */

/** T8 4100 K "cool white", including the mercury green spike. Linear space. */
export const FLUORESCENT = new THREE.Color(0.72, 0.90, 0.94);
/** Cooler lamps run colder still, and the white liner exaggerates it. */
export const COOLER_LAMP = new THREE.Color(0.66, 0.90, 1.0);

/**
 * One-bounce indirect light for the room, as a PMREM captured from inside it.
 *
 * ## Why the room is black without this, and why it is a lighting bug
 *
 * Every emitter in here is a `RectAreaLight`. Three evaluates those with a
 * linearly-transformed-cosine fit, which is an excellent model of *direct*
 * light from an area source and models **no** indirect light whatever. So a
 * surface that cannot see a troffer receives exactly the ambient term and
 * nothing else — and the ambient term is `scene.environment`, which is the
 * outdoor sky, deliberately dimmed to a few percent on interior materials
 * because an unoccluded sky would otherwise light the inside of a sealed room
 * as brightly as the forecourt.
 *
 * The result is that the ceiling and the floor look right, because they face
 * the fixtures, and every vertical face in the room clamps to black: the aisle
 * side of a gondola, the underside of a shelf, the sides of the packets, the
 * cooler surround. Building has been asked to fix this twice and cannot — no
 * albedo it can choose changes a surface receiving zero light, and raising
 * albedo to compensate would wreck the same surfaces where they *are* lit.
 *
 * ## Why a captured probe rather than an ambient light
 *
 * The tempting fix is a dim `HemisphereLight` or a raised ambient. Both are
 * wrong here in a way that a thumbnail hides:
 *
 * - A hemisphere light is sky-above / ground-below, which is a statement about
 *   being outdoors. In a room the brightest thing is usually the *ceiling*.
 * - Flat ambient adds the same radiance to every face regardless of what is
 *   actually near it, so it lifts the dark faces and the lit ones together,
 *   washes the room out, and destroys the interior-to-exterior contrast that
 *   the storefront and the whole door interaction depend on.
 *
 * Capturing the room instead gives the real thing for one bounce: the cube sees
 * the troffer-lit ceiling tiles, the lit floor, the white cooler liner and the
 * daylight coming through the glazing, each in its true direction and its true
 * colour. The underside of a shelf then receives light from the lit floor
 * beneath it, tinted by that floor, which is what actually happens in a shop.
 * It costs one cube capture at startup and nothing per frame.
 *
 * `tools/darkscan.mjs` exists to keep this honest: it reports the shape of the
 * change, and an ambient-shaped result fails it even when the frame looks
 * better.
 */
export interface InteriorIrradianceOptions {
  /** Where to stand the probe. Room centre, at about shelf height. */
  position: THREE.Vector3;
  /** Cube resolution. Irradiance is low-frequency; 64 is plenty and is cheap. */
  size?: number;
  /**
   * Objects to hide for the capture. The lamp *lenses* are emissive surfaces
   * sitting exactly where the `RectAreaLight`s are, so leaving them in counts
   * the fixtures twice — once as direct light and once as a very bright patch
   * in the probe — and the ceiling ends up glowing.
   */
  hide?: THREE.Object3D[];
}

export interface InteriorIrradiance {
  texture: THREE.Texture;
  /** Mean linear luminance of the captured room. Zero means the capture failed. */
  meanLuminance: number;
  /** Non-finite texels in the filtered result. Must be 0 or it is not installed. */
  badPixels: number;
  dispose(): void;
}

export function captureInteriorIrradiance(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: InteriorIrradianceOptions
): InteriorIrradiance {
  const size = opts.size ?? 64;
  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  // Near plane tight: the probe stands in open floor but a 0.3 m near plane
  // would clip the very shelf faces this exists to light.
  const cam = new THREE.CubeCamera(0.05, 60, cubeRT);
  cam.position.copy(opts.position);
  cam.updateMatrixWorld(true);

  const hidden = (opts.hide ?? []).filter((o) => o.visible);
  for (const o of hidden) o.visible = false;

  const prevTarget = renderer.getRenderTarget();
  const autoUpdate = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  try {
    cam.update(renderer, scene);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoUpdate;
    for (const o of hidden) o.visible = true;
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const rt = pmrem.fromCubemap(cubeRT.texture);
  pmrem.dispose();
  cubeRT.dispose();

  // Same readback discipline as the world capture. A non-finite texel here
  // would poison every interior material exactly as case 31 poisoned the whole
  // scene, and for the same reason: the GGX filter spreads one bad sample
  // across a neighbourhood of every mip.
  let mean = 0;
  let bad = 0;
  try {
    const buf = new Uint16Array(rt.width * rt.height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    let n = 0;
    for (let i = 0; i < rt.width * rt.height; i++) {
      const r = halfToFloat(buf[i * 4]);
      const g = halfToFloat(buf[i * 4 + 1]);
      const b = halfToFloat(buf[i * 4 + 2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        bad++;
        continue;
      }
      mean += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
    mean = n ? mean / n : 0;
  } catch {
    bad = -1;
    mean = 0;
  }

  return { texture: rt.texture, meanLuminance: mean, badPixels: bad, dispose: () => rt.dispose() };
}

/** IEEE 754 half -> float, for the readback above. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + f / 1024);
}

export interface InteriorParams {
  buildingRoot: THREE.Object3D;
  fluorescents: THREE.Object3D[];
  coolerSlots: THREE.Object3D[];
  exteriorLight: THREE.Object3D | null;
  entryDoor: THREE.Object3D | null;
  footprint: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    floorY: number;
    roofY: number;
  };
  /**
   * Multiplier on the *daylight* terms: the doorway rect, the door bounce and
   * the door glow. Used by the forced-value diff (`?lforce=nofluoro` /
   * `fluoro6`).
   */
  gain: number;
  /**
   * Multiplier on the *lamp* terms only: the ceiling fluorescents, their up
   * light, and the cooler tubes with their emissive surfaces. `?lamp=<n>`.
   *
   * Split out from `gain` because one scalar over both made the brief's central
   * effect impossible to reach. The deliverable asks for "the sunlight contrast
   * as the door opens", and measurement says the room is currently the brighter
   * side of that contrast: interior p50 181 against exterior 82, with the lamps
   * supplying 71% of the interior frame (`?lforce=nofluoro` takes
   * `interior_cold` from 129.9 to 37.7 mean luma). Turning `gain` down took the
   * doorway down with the lamps, which is the one term that has to survive.
   */
  lampGain: number;
  /**
   * Share of each ceiling troffer's output re-delivered as a shadow-casting spot
   * (`?tcast=`). Zero by default: it adds one 512 shadow map and one shadow pass
   * per fixture, which has to be paid for by a measured improvement.
   */
  troffCast: number;
  /**
   * How many fixtures get one (`?tcastn=`), nearest the camera side first.
   *
   * Capped at 1 by default because every caster is another shadow map *and*
   * another shadowed light in every interior fragment shader, and WebGL2 gives a
   * fragment stage 16 texture units to share. At this fixture count `?tcast=` with
   * no cap took the page down. One caster is also the physically sensible first
   * try: several fixtures at once wash each other's shadows out, which is why a
   * real shop's shelving reads soft.
   */
  troffCastMax: number;
  /**
   * Share of the transmitted shopfront daylight delivered by the *unshadowed*
   * rect (`?drect=`), and by the *shadow-casting* spot (`?dspot=`). Held as two
   * independent multipliers rather than one crossfade so that a round can put
   * all the energy through one path, match the frame means, and then compare the
   * structure at equal exposure. Comparing structure at unequal brightness is
   * how a darker frame gets mistaken for a better-shaded one.
   */
  rectShare: number;
  spotShare: number;
  /** Spot intensity at `spotShare` 1, calibrated by sweep rather than guessed. */
  spotWatts: number;
  /**
   * Multiplier on the two unshadowed point lights that stand in for the sun
   * patch bouncing off the floor (`?dbounce=`).
   *
   * Measured at 44.8 of the 92.0 luma that the interior lighting contributes to
   * `interior_cold` - the largest single term in the room, larger than every
   * lamp put together. That is the ground-disc pattern again: a constant
   * standing in for a transport term nobody computed, sized by eye until the
   * frame looked full.
   *
   * The arithmetic says it cannot be this large. The floor patch is lit at
   * grazing incidence, so it receives sin(6.2 deg) = 10.8% of the beam, and at a
   * floor albedo near 0.2 it returns about 2% of it. A fill worth 2% of the beam
   * cannot legitimately be the brightest thing in the room, and the frame agrees:
   * interior p50 181 against exterior 82 inverts the brief's central contrast.
   */
  bounceGain: number;
  /**
   * `?dnoshadow=1` keeps the spot and switches off only its casting. The control
   * that matters: it separates "occlusion changed the room" from "a differently
   * shaped light changed the room", which a spot-versus-rect comparison alone
   * cannot, since the two differ in position, falloff and angular profile as well
   * as in whether anything can block them.
   */
  spotCasts: boolean;
  /** False (`?lforce=clearglass`) leaves the glazing perfectly transmissive. */
  glazingShadow: boolean;
}

export interface InteriorBuild {
  group: THREE.Group;
  troffers: THREE.RectAreaLight[];
  coolerLights: THREE.RectAreaLight[];
  /** Warm fill that stands in for sunlight bouncing off the lit floor patch. */
  doorBounce: THREE.PointLight;
  doorGlow: THREE.PointLight;
  /** Diffuse daylight transmitted through the tinted storefront. */
  daylight: THREE.RectAreaLight | null;
  /** The same daylight on an occludable path, so shelves shade each other. */
  daylightSpot: THREE.SpotLight | null;
  /** Shadow-casting twins of the ceiling troffers; empty unless `?tcast=`. */
  troffCasters: THREE.SpotLight[];
  glazing: { storefrontShadow: boolean; doorGlass: boolean };
  setDoorOpenAmount(amount: number): void;
}

/**
 * Make the storefront glazing behave like the tinted, low-transmittance glass
 * that is actually specified on these buildings, and hand back the door leaf's
 * pane so the caller can switch it with the door.
 *
 * Why this is necessary at all: three has no partial shadow. Left alone, the
 * glazing casts nothing, so the low sun pours through ten metres of shopfront
 * and floods the interior - the room ends up warmer and brighter than the
 * forecourt, the storefront reads as a hole, and the sun through the *door*,
 * which is the thing the brief actually asks for, contributes nothing you can
 * see. Making the fixed glazing an opaque caster and adding back the
 * transmitted component as a soft area source is a much better model of tinted
 * glass than "perfectly clear" is, and it is what makes the doorway the only
 * hard-edged aperture in the room.
 *
 * The door leaf's pane is the one exception, and it is a deliberate
 * approximation. Geometrically the leaf swings out to the west, straight into
 * a west-south-west sun, so an opaque leaf shadows its own doorway at every
 * opening angle below about 133 degrees - the aperture would be *darker* open
 * than shut. A real 50%-transmitting leaf would only halve the beam. Between
 * three's two available answers, "transmits once it has swung aside" is far
 * closer to the truth than "blocks completely", so the pane stops casting as
 * the door opens.
 */
function setupGlazing(
  buildingRoot: THREE.Object3D,
  enabled: boolean
): { doorGlass: THREE.Mesh | null; storefront: THREE.Mesh | null } {
  let doorGlass: THREE.Mesh | null = null;
  let storefront: THREE.Mesh | null = null;

  buildingRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === "storefront-glass") {
      storefront = mesh;
      mesh.castShadow = enabled;
    } else if (mesh.name === "entry-door-glass") {
      doorGlass = mesh;
    }
  });

  return { doorGlass, storefront };
}

let rectLibReady = false;

/**
 * Emissive material for a diffuser or a lamp tube. Deliberately unlit
 * (`MeshBasicMaterial` would ignore the fluorescents' own colour bleed, and a
 * standard material with a high emissive keeps the surface responding to the
 * room) - so this is a standard material whose emissive does the work.
 */
function lampMaterial(color: THREE.Color, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.9, 0.94, 0.96),
    emissive: color.clone(),
    emissiveIntensity: intensity,
    roughness: 0.55,
    metalness: 0,
  });
}

export function buildInteriorLighting(p: InteriorParams): InteriorBuild {
  if (!rectLibReady) {
    RectAreaLightUniformsLib.init();
    rectLibReady = true;
  }

  const group = new THREE.Group();
  group.name = "lighting-interior";

  const troffers: THREE.RectAreaLight[] = [];
  const troffCasters: THREE.SpotLight[] = [];
  const coolerLights: THREE.RectAreaLight[] = [];

  /* ---------------- lay-in troffers ---------------- */
  for (const anchor of p.fluorescents) {
    const w = Number(anchor.userData?.width) || 0.61;
    const l = Number(anchor.userData?.length) || 1.22;
    const pos = anchor.getWorldPosition(new THREE.Vector3());

    // RectAreaLight emits from the face its local -Z points at, and
    // Object3D.lookAt aims -Z at the target for lights. So looking at a point
    // directly below the fixture makes it a downlight.
    const light = new THREE.RectAreaLight(FLUORESCENT, 13.0 * p.lampGain, w - 0.03, l - 0.03);
    light.position.copy(pos);
    light.lookAt(pos.x, pos.y - 1, pos.z);
    light.name = `${anchor.name}-rect`;
    group.add(light);
    troffers.push(light);

    // A lay-in troffer also throws a little light up into the plenum through
    // the gap round the pan; without it the ceiling grid reads as a flat print.
    const up = new THREE.PointLight(FLUORESCENT, 0.5 * p.lampGain, 2.6, 2);
    up.position.set(pos.x, pos.y + 0.18, pos.z);
    group.add(up);

    // Optionally, the same troffer again as a source that can be blocked
    // (`?tcast=`).
    //
    // This exists because of what Building's instrument actually measures. It
    // reports the asymmetry of *vertical* local contrast - dark bands under
    // horizontal edges - which is the signature of light arriving from above and
    // being interrupted. Every overhead light in this room is a RectAreaLight,
    // and three cannot shadow one at any intensity, so the statistic is pinned by
    // construction rather than by grading.
    //
    // That prediction is why the obvious fix failed. Putting the shopfront
    // daylight on an occludable path demonstrably occludes - 69.75% of channels
    // move when its casting is switched on at matched intensity - and moved the
    // asymmetry only from 1.02 to 1.03, because a side window darkens the faces
    // pointing away from it rather than the undersides of shelf lips. To move an
    // overhead statistic the overhead light has to be the one casting.
    if (p.troffCast > 0 && troffCasters.length < p.troffCastMax) {
      const cast = new THREE.SpotLight(FLUORESCENT, 13.0 * p.lampGain * p.troffCast, 6.0, 1.25, 0.7, 2);
      cast.position.set(pos.x, pos.y - 0.02, pos.z);
      cast.target.position.set(pos.x, pos.y - 3.0, pos.z);
      cast.name = `${anchor.name}-cast`;
      cast.castShadow = true;
      // 512 per fixture, not 1024. These are 2-3 m throws onto shelving inside
      // one room, so a 512 map spans about 6 m of cone and gives ~1 cm texels -
      // finer than the sun's 1.95 cm over the whole site. Four fixtures at 512
      // cost 4 MB together, against 16 MB at 1024 for detail no pixel resolves.
      cast.shadow.mapSize.set(512, 512);
      cast.shadow.camera.near = 0.15;
      cast.shadow.camera.far = 6.0;
      cast.shadow.bias = 0.0;
      cast.shadow.normalBias = 0.015;
      group.add(cast);
      group.add(cast.target);
      troffCasters.push(cast);
    }
  }

  /* ---------------- reach-in cooler ---------------- */
  // Nine mullion slots, but only three area lights: the tubes themselves are
  // modelled and emissive at every slot, and three wide sources reproduce the
  // even wash off the white liner for a third of the cost.
  const slots = p.coolerSlots;
  if (slots.length) {
    const world = slots.map((s) => s.getWorldPosition(new THREE.Vector3()));
    const tubeLen = Number(slots[0].userData?.length) || 1.78;

    for (const w of world) {
      const geo = new THREE.CylinderGeometry(0.017, 0.017, tubeLen, 10, 1);
      const tube = new THREE.Mesh(geo, lampMaterial(COOLER_LAMP, 5.5 * p.lampGain));
      tube.position.copy(w);
      tube.name = "cooler-lamp-tube";
      group.add(tube);
    }

    const x0 = Math.min(...world.map((w) => w.x));
    const x1 = Math.max(...world.map((w) => w.x));
    const zc = world[0].z;
    const yc = world[0].y;
    for (let i = 0; i < 3; i++) {
      const cx = THREE.MathUtils.lerp(x0, x1, (i + 0.5) / 3);
      const light = new THREE.RectAreaLight(COOLER_LAMP, 7.0 * p.lampGain, (x1 - x0) / 3, tubeLen);
      light.position.set(cx, yc, zc - 0.02);
      // Cooler tubes sit behind the mullions firing back into the cabinet, so
      // the light the customer sees is bounce off the liner, not the lamp.
      light.lookAt(cx, yc, zc + 1);
      group.add(light);
      coolerLights.push(light);
    }
  }

  /* ---------------- exterior wall pack ---------------- */
  // Still burning at dawn on its photocell, and much cooler than the sun. It is
  // what tells you the station is open.
  if (p.exteriorLight) {
    const w = p.exteriorLight.getWorldPosition(new THREE.Vector3());
    const pack = new THREE.SpotLight(new THREE.Color(0.95, 0.93, 0.82), 22, 9, Math.PI * 0.42, 0.72, 1.7);
    pack.position.copy(w);
    const t = new THREE.Object3D();
    t.position.set(w.x, w.y - 3, w.z - 0.6);
    group.add(t);
    pack.target = t;
    pack.castShadow = false;
    group.add(pack);
  }

  /* ---------------- sun spill through the door ---------------- */
  // The shaped patch of sun on the floor is real: it is the key light coming
  // through the door aperture in the shadow map. These two only add what a
  // shadow map cannot - the bounce off that patch back into the room, and the
  // glow on the jamb - and both scale with how far the door is open.
  const fp = p.footprint;
  const doorPos = p.entryDoor
    ? p.entryDoor.getWorldPosition(new THREE.Vector3())
    : new THREE.Vector3((fp.minX + fp.maxX) / 2, fp.floorY + 1.0, fp.minZ);

  const doorBounce = new THREE.PointLight(new THREE.Color(1.0, 0.63, 0.33), 0, 9, 2);
  doorBounce.position.set(doorPos.x + 0.9, fp.floorY + 0.35, doorPos.z + 2.4);
  doorBounce.name = "door-sun-bounce";
  group.add(doorBounce);

  const doorGlow = new THREE.PointLight(new THREE.Color(1.0, 0.71, 0.42), 0, 4.5, 2);
  doorGlow.position.set(doorPos.x, fp.floorY + 1.5, doorPos.z + 0.35);
  doorGlow.name = "door-jamb-glow";
  group.add(doorGlow);

  /* ---------------- tinted glazing and its transmitted daylight ---------------- */
  const glaze = setupGlazing(p.buildingRoot, p.glazingShadow);

  let daylight: THREE.RectAreaLight | null = null;
  let daylightSpot: THREE.SpotLight | null = null;
  if (glaze.storefront && p.glazingShadow) {
    const box = new THREE.Box3().setFromObject(glaze.storefront);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    // Everything the tinted glass lets through, as one soft source just inside
    // the glass line, facing into the room. A RectAreaLight emits from one face
    // only, so nothing of this leaks back out onto the forecourt.
    daylight = new THREE.RectAreaLight(
      new THREE.Color(1.0, 0.735, 0.475),
      2.6 * p.gain * p.rectShare,
      size.x,
      size.y
    );
    daylight.position.set(centre.x, centre.y, box.max.z + 0.06);
    daylight.lookAt(centre.x, centre.y, box.max.z + 2);
    daylight.name = "storefront-daylight";
    group.add(daylight);

    // The same transmitted daylight again, as a source that can be *blocked*.
    //
    // This is the aisle transport fix, and the defect it replaces is structural
    // rather than a wrong number: a `RectAreaLight` in three casts no shadow at
    // any intensity, so the rect above delivers the whole shopfront's daylight to
    // every surface whose normal faces it, with no regard for what stands in
    // between. The far gondola is lit as though the near gondola were not there,
    // a shelf deck gets the same light as the shelf lip above it, and the room
    // therefore reads as ambient-lit no matter how the intensity is graded.
    // Building measured that as 0.99x vertical-contrast asymmetry, the only frame
    // in its set below 1.0, and correctly concluded the remaining shading is
    // transport rather than anything bakeable into an object: an occlusion term
    // baked into a shelf darkens the faces pointing away from the window, which
    // are the faces the camera cannot see.
    //
    // A spot is a poor model of a wall-sized window in one respect - a real one
    // is an area source with a wide penumbra - and an exact one in the respect
    // that matters here, which is that its light stops at an occluder. The
    // penumbra objection is also weaker than it looks now that contact hardening
    // is the default shadow path: the shelf lip's shadow on the deck 30 cm below
    // it comes out near-sharp while the same lip's shadow on the floor 1.6 m down
    // comes out soft, which is what a window actually does.
    //
    // Placed just *inside* the glass line, deliberately. The storefront glazing
    // casts shadow (`glazingShadow`), so a source outside it would be blocked by
    // the very window it represents - and the failure would be silent, because a
    // fully-shadowed light looks exactly like a light with the intensity set too
    // low.
    daylightSpot = new THREE.SpotLight(
      new THREE.Color(1.0, 0.735, 0.475),
      p.spotWatts * p.gain * p.spotShare,
      // Reach past the back wall, so the falloff in view is the inverse-square of
      // an unclipped source rather than a hard cut at the range limit.
      Math.max(14, fp.maxZ - fp.minZ + 8),
      1.15,
      // A soft edge, because the aperture is metres wide. This is the cone edge,
      // not the shadow penumbra; the shadow softness comes from the filter.
      0.9,
      2
    );
    daylightSpot.position.set(centre.x, centre.y, box.max.z + 0.06);
    daylightSpot.target.position.set(centre.x, fp.floorY + 0.4, box.max.z + 6);
    daylightSpot.name = "storefront-daylight-cast";
    daylightSpot.castShadow = p.spotCasts;
    daylightSpot.shadow.mapSize.set(1024, 1024);
    // The room, and only the room. A tight far plane is the whole reason this
    // costs 4 MB rather than the sun map's 256: depth precision is spent on 12 m
    // of shop instead of 80 m of forecourt.
    daylightSpot.shadow.camera.near = 0.25;
    daylightSpot.shadow.camera.far = Math.max(14, fp.maxZ - fp.minZ + 8);
    daylightSpot.shadow.bias = 0.0;
    // Normal-offset rather than depth bias, for the same reason the sun uses it:
    // depth bias detaches contact shadows, which are the entire point here.
    daylightSpot.shadow.normalBias = 0.02;
    group.add(daylightSpot);
    group.add(daylightSpot.target);
  }

  const setDoorOpenAmount = (amount: number) => {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    // Slightly superlinear: a door cracked 10% lets in far less than 10% of the
    // light, because the leaf itself is still occluding the aperture.
    const t = a * a * (0.4 + 0.6 * a);
    doorBounce.intensity = 34 * t * p.gain * p.bounceGain;
    doorGlow.intensity = 12 * t * p.gain * p.bounceGain;
    // Shut, the leaf is part of the tinted screen; swung aside, it transmits.
    if (glaze.doorGlass) glaze.doorGlass.castShadow = p.glazingShadow && a < 0.12;
  };
  setDoorOpenAmount(0);

  return {
    group,
    troffers,
    coolerLights,
    doorBounce,
    doorGlow,
    daylight,
    daylightSpot,
    troffCasters,
    glazing: { storefrontShadow: !!glaze.storefront && p.glazingShadow, doorGlass: !!glaze.doorGlass },
    setDoorOpenAmount,
  };
}

/**
 * Retune the emissive stubs BuildingSystem left on the diffuser lenses and the
 * wall-pack lens, now that there are real emitters behind them, and knock the
 * IBL response down on interior surfaces.
 *
 * The second half matters more than it sounds. `scene.environment` is not
 * occluded by anything, so without this the inside of a sealed room receives
 * the full dawn sky as ambient and comes out the same brightness as the
 * forecourt - which is precisely what makes storefront glass read as a hole
 * rather than as glass.
 */
export function tuneInteriorMaterials(
  buildingRoot: THREE.Object3D,
  opts: { interiorEnv: number; lensGain: number }
): {
  lenses: number;
  dimmed: number;
  /**
   * The interior materials this function actually touched, so the irradiance
   * probe can be applied to exactly the same set. Returned rather than
   * re-derived because the name list below is lossy (see the note in it) and
   * two traversals that are supposed to agree are two that can drift apart.
   */
  materials: THREE.MeshStandardMaterial[];
  /** The emissive lamp surfaces, which must be hidden while the probe captures. */
  lensMeshes: THREE.Mesh[];
} {
  const INTERIOR = new Set([
    "cmu-interior",
    "store-floor",
    "ceiling-tiles",
    "ceiling-grid",
    "cooler-liner",
    "cooler-shelves",
    "cooler-stock",
    "product",
    "troffer-housing",
    "floor-traffic",
    // The merged interior batches of the two materials that used to span
    // inside and outside - see below.
    "enamel-interior",
    "steelwork-interior",
  ]);
  // Not "counter-display-glass": it shares its material with the storefront
  // glazing, and dimming that would take the sky reflection off the one
  // surface whose whole job is reflecting the sky.
  //
  // **A mesh name is a lossy way to name a material.** `BuildingSystem` batches
  // its geometry by material, so one material is drawn by several meshes and
  // this set reaches all of them. Until 2026-08-28 one enamel material carried
  // the ceiling grid *and* the ice machine, and one steel material carried the
  // cooler shelves *and* every downspout, so naming an interior mesh dimmed
  // exterior ones. Inert while `envMapIntensity` was (NOTES.md case 21); the
  // moment it went live it took 46% off the ice machine. The materials are now
  // split, `tools/probe-envmat.mjs` asserts they stay split, and
  // `building.interiorMaterials` is published as the non-lossy version of this
  // set — prefer it over the names when this function is next open.

  let lenses = 0;
  let dimmed = 0;
  const seen = new Set<THREE.Material>();
  const materials: THREE.MeshStandardMaterial[] = [];
  const lensMeshes: THREE.Mesh[] = [];

  buildingRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    if (mesh.name === "troffer-diffuser" || mesh.name === "building-exterior-light-lens") {
      lensMeshes.push(mesh);
      for (const m of mats) {
        const s = m as THREE.MeshStandardMaterial;
        if (!s.isMeshStandardMaterial || seen.has(s)) continue;
        seen.add(s);
        s.emissive.copy(FLUORESCENT);
        s.emissiveIntensity = opts.lensGain;
        s.toneMapped = true;
        s.needsUpdate = true;
        lenses++;
      }
      return;
    }

    if (!INTERIOR.has(mesh.name)) return;
    for (const m of mats) {
      const s = m as THREE.MeshStandardMaterial;
      if (!s.isMeshStandardMaterial || seen.has(s)) continue;
      seen.add(s);
      s.envMapIntensity = opts.interiorEnv;
      s.needsUpdate = true;
      materials.push(s);
      dimmed++;
    }
  });

  return { lenses, dimmed, materials, lensMeshes };
}

/**
 * Point the interior materials at the room's own irradiance probe instead of at
 * the outdoor sky.
 *
 * Setting `envMap` on a material makes three use it **in place of**
 * `scene.environment` for that material, which is exactly the semantics wanted:
 * the inside of the building stops sampling an unoccluded dawn sky and starts
 * sampling the room. That also means `envMapIntensity` changes meaning here.
 * Against the sky it was a fudge factor standing in for the roof — a few
 * percent, because the sky is not actually visible from inside. Against the
 * room's own captured radiance it is a real coefficient and belongs near 1:
 * the probe already contains the correct magnitude, and scaling it down would
 * be re-introducing the same fudge on top of a measurement.
 *
 * Returns the count so the caller can assert it is non-zero. A silent zero here
 * would look exactly like the feature working and not being strong enough,
 * which is NOTES.md's most-repeated failure and cost three review cycles the
 * last time it happened.
 */
export function applyInteriorIrradiance(
  materials: THREE.MeshStandardMaterial[],
  texture: THREE.Texture,
  intensity: number
): number {
  let n = 0;
  for (const m of materials) {
    m.envMap = texture;
    m.envMapIntensity = intensity;
    m.needsUpdate = true;
    n++;
  }
  return n;
}
