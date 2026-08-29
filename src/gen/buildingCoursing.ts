import * as THREE from "three";
import { CMU } from "./buildingTextures";

export interface BuildingCoursingOptions {
  key: string;
  /** Nominal unit face size in metres, joint included. */
  unitX?: number;
  unitY?: number;
  /** Mortar joint width in metres. */
  joint?: number;
  /** Depth of the tooled concave recess, in metres. Drives the self-shadow. */
  depth?: number;
  /** World-space direction *towards* the sun. Required for the self-shadow. */
  sunDir?: THREE.Vector3;
  /** Ambient the recess loses to its own occlusion, light-independent. */
  occlusion?: number;
  /** How much of the surface's brightness the direct sun accounts for. */
  shadow?: number;
  /**
   * Multiplier on `shadow` alone, for the staged two-region control.
   *
   * `amount` cannot answer the question this feature exists for. Zeroing it
   * removes the joints entirely, so *both* elevations move and the diff says
   * only "there is coursing here" - which was never in doubt. Zeroing the
   * groove self-shadow and nothing else predicts opposite outcomes in the two
   * halves of one frame: the lit front elevation must move, and the shaded east
   * elevation must not move at all, because `bcGrooveShadow` already returns
   * zero wherever N dot L <= 0. A control whose two arms disagree inside a
   * single capture is the only kind this project has found trustworthy.
   */
  shadowScale?: number;
  /** Extra dirt tint washed into the bed joints only. */
  soil?: THREE.Color;
  soilStrength?: number;
  /** Per-unit tonal spread, as a fraction. */
  unitVariation?: number;
  /** Per-unit roughness spread. Differential paint absorption, unit to unit. */
  unitRoughness?: number;
  /** Strength of the normal tilt on the joint flanks. */
  bump?: number;
  /** Extra roughness in the joint. */
  roughen?: number;
  /** Master scale, and the forced-value channel: >= 5 paints joints red. */
  amount?: number;
}

/**
 * Masonry coursing computed analytically in world space, with screen-space
 * filtering, rather than baked into the albedo tile.
 *
 * WHY THIS IS NOT A TEXTURE
 *
 * A 9.5 mm mortar joint is about one screen pixel wide at normal viewing
 * distance. Baked into a 1024 tile it survives at 6 texels, so the mip chain
 * averages it into the block face: bed joints degrade to a pale lattice, head
 * joints disappear entirely, and an observer counting courses infers a unit
 * roughly twice the real height. That was defects 1 and 2 - the coursing scale
 * was measurably correct (0.2032 m per course, 23 px where 1 m was 110 px) and
 * still read as double, because the sub-pixel detail that identified the
 * shorter unit had been filtered away.
 *
 * The fix is to evaluate the joint per pixel and filter it deliberately:
 *
 *   near   crisp joint, correct width, both axes present
 *   mid    partial coverage, still both axes, no aliasing
 *   far    converges on the joint's *mean* coverage over a unit, i.e. a flat
 *          slight darkening, which is what a real wall does at range
 *
 * That last step is the part a mip chain gets wrong by accident and this gets
 * right on purpose. `mix(cov, avg, t)` where `t` tracks the pixel footprint
 * against the unit size means the wall never shimmers and never loses the
 * joints to a pale ghost lattice.
 *
 * WHY THE UNIFORMS COME FROM A TABLE
 *
 * Three earlier attempts at this failed silently or fatally. Two produced a
 * forced-value diff of exactly zero changed pixels; the third linked with
 * `vBwPos`/`vBwNormal` undeclared and took `__SCENE_READY` down on every page
 * load. The cause both times was the same: this module reused varyings that
 * `applyBuildingWeather` declares, and injection order decided whether the
 * declaration existed by the time this code referenced it.
 *
 * Two rules come out of that, both structural rather than careful:
 *
 *  1. Declare every varying and uniform this module uses, and never reference
 *     one another module owns. Injection order then cannot matter.
 *  2. Generate the GLSL declarations from the same table that supplies the
 *     values, and assert at injection time that no chunk names a `uXxx` the
 *     table does not define. Borrowed from `gen/worldDetail.ts`, which hit this
 *     class of bug twice before solving it this way.
 */
export function applyBuildingCoursing(material: THREE.MeshStandardMaterial, opts: BuildingCoursingOptions) {
  const {
    unitX = CMU.unitX,
    unitY = CMU.unitY,
    joint = CMU.joint,
    depth = 0.004,
    sunDir = new THREE.Vector3(0, 1, 0),
    occlusion = 0.22,
    shadow = 0.58,
    shadowScale = 1,
    soil = new THREE.Color(0x4b4437),
    soilStrength = 0.3,
    unitVariation = 0.085,
    unitRoughness = 0.12,
    bump = 0.85,
    roughen = 0.12,
    amount = 1,
  } = opts;

  /** Single source of truth: declarations, values and the assertion below. */
  const U: Record<string, { type: string; value: unknown }> = {
    uBcUnit: { type: "vec2", value: new THREE.Vector2(unitX, unitY) },
    uBcJoint: { type: "float", value: joint },
    uBcDepth: { type: "float", value: depth },
    uBcSun: { type: "vec3", value: sunDir.clone().normalize() },
    uBcAo: { type: "float", value: occlusion },
    uBcShadow: { type: "float", value: shadow * shadowScale },
    uBcSoil: { type: "vec3", value: soil.clone() },
    uBcSoilAmt: { type: "float", value: soilStrength },
    uBcVar: { type: "float", value: unitVariation },
    uBcVarRough: { type: "float", value: unitRoughness },
    uBcBump: { type: "float", value: bump },
    uBcRough: { type: "float", value: roughen },
    uBcAmount: { type: "float", value: amount },
  };

  const uniformDecls = Object.entries(U)
    .map(([name, u]) => `uniform ${u.type} ${name};`)
    .join("\n      ");

  const assertDeclared = (chunk: string, where: string) => {
    for (const ref of new Set(chunk.match(/\buBc[A-Za-z0-9_]*\b/g) ?? [])) {
      if (!(ref in U)) {
        throw new Error(
          `buildingCoursing(${opts.key}): ${where} references '${ref}', not declared for this material. ` +
            `Declared: ${Object.keys(U).join(", ")}`
        );
      }
    }
  };

  /**
   * A `.replace` that silently found no needle is the other way an injection
   * reaches the framebuffer as a no-op, so every substitution is checked.
   */
  const sub = (src: string, needle: string, body: string) => {
    if (!src.includes(needle)) {
      throw new Error(`buildingCoursing(${opts.key}): shader has no '${needle}' to inject into`);
    }
    return src.replace(needle, `${needle}\n${body}`);
  };

  const prior = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    prior?.(shader, renderer);

    for (const [name, u] of Object.entries(U)) shader.uniforms[name] = { value: u.value };
    material.userData.coursingShader = shader;

    // Own varyings, deliberately not shared with the weathering injection.
    shader.vertexShader =
      "varying vec3 vBcPos;\nvarying vec3 vBcNormal;\n" +
      shader.vertexShader
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
           vBcNormal = normalize(mat3(modelMatrix) * objectNormal);`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           vBcPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

    const decl = `
      ${uniformDecls}
      varying vec3 vBcPos;
      varying vec3 vBcNormal;

      float bcHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      /*
       * Fraction of a rectangular groove of width w and depth d that its own
       * upper lip shadows, for a light arriving along L on a wall facing N,
       * for a groove running along the in-plane axis A.
       *
       * This is the term that makes the coursing light-direction-dependent,
       * and it exists because the normal perturbation below CANNOT do that job
       * at these distances. A 9.5 mm joint is about 1.3 px wide in the front
       * elevation. The flank tilt is equal and opposite either side of the
       * centreline, so both flanks land inside one pixel, the tilts average to
       * zero, and the joint's *mean* tone comes out identical under any light.
       * That is why a critic found the joints looked the same in raking light
       * on the side wall as in flat light on the front, and concluded there was
       * no height information: there was, but it was cancelling.
       *
       * Sub-pixel geometry has to be expressed as a change in the mean, not as
       * a normal. Same lesson as baking the joints into the albedo tile, one
       * level down: the fix for detail below the sampling rate is never to
       * make the detail finer.
       *
       * The physics is a shadow cast across the groove floor, so it depends on
       * the light's angle from the wall normal measured in the plane
       * perpendicular to the groove. That makes the two joint families behave
       * completely differently, which is what real masonry does at dawn:
       *
       * For this site's sun - azimuth 203 degrees, elevation 6.2, so 67 degrees
       * off the front wall's normal in azimuth and barely up, the same geometry
       * pumpParts.ts works from - that predicts:
       *
       *   front elevation, N dot L = 0.39, sun raking across it horizontally
       *     bed joints  tan 0.27 -> 12% shadowed, faint
       *     head joints tan 2.31 -> 97% shadowed, hard dark verticals
       *   east elevation, N dot L < 0, wall in shade
       *     both families equally unlit, so only the occlusion term applies
       *
       * The asymmetry between the two families on one wall, and between the two
       * walls, is the whole point: it is a signal no colour map can carry.
       *
       * Returns the shadowed fraction, already weighted by how much direct
       * light the face gets. A wall in shade must return zero, not one: the
       * groove and the block face are then equally unlit, so there is no
       * *relative* darkening to apply beyond occlusion. Returning 1 there would
       * darken shaded joints as hard as raked ones and throw away exactly the
       * light-direction dependence this function exists to create.
       */
      float bcGrooveShadow(vec3 n, vec3 axis) {
        vec3 l = normalize(uBcSun);
        float ndl = dot(l, n);
        if (ndl <= 0.001) return 0.0;
        vec3 inPlane = l - n * ndl;
        vec3 perp = inPlane - axis * dot(inPlane, axis);
        float tanTheta = length(perp) / max(ndl, 0.001);
        float geo = clamp(uBcDepth * tanTheta / max(uBcJoint, 1e-5), 0.0, 1.0);
        // Ramp with the direct share of the face's brightness, so grazing walls
        // do not get a shadow the sun is not strong enough to cast.
        return geo * smoothstep(0.0, 0.3, ndl);
      }

      /**
       *  .x  head-joint coverage, filtered
       *  .y  bed-joint coverage, filtered
       *  .z  per-unit tone offset, -0.5..0.5
       *  .w  crispness: 1 near, 0 once a unit is pixel-sized
       *
       *  bright   joint brightness multiplier, light-direction-dependent
       *  unitR    per-unit roughness offset, -0.5..0.5
       *  chamfer  the arris: a wide, shallow shoulder outside the joint proper
       */
      vec4 bcJoints(out vec2 slope, out float bright, out float unitR, out float chamfer) {
        vec3 n = normalize(vBcNormal);
        // The wall's own horizontal axis, picked from the dominant normal, so
        // a north elevation courses in X and an east elevation in Z and the
        // two meet at the corner without a seam.
        float horiz = abs(n.x) > abs(n.z) ? vBcPos.z : vBcPos.x;
        float vert = vBcPos.y;

        float course = floor(vert / uBcUnit.y);
        float bond = mod(course, 2.0) * 0.5 * uBcUnit.x;   // running bond
        float fu = fract((horiz + bond) / uBcUnit.x);
        float fv = fract(vert / uBcUnit.y);

        // Signed offset from the nearest joint centreline, in units, then in
        // metres. Joints sit on the unit boundary, i.e. at fract() == 0.
        float su = fu < 0.5 ? fu : fu - 1.0;
        float sv = fv < 0.5 ? fv : fv - 1.0;
        float du = abs(su) * uBcUnit.x;
        float dv = abs(sv) * uBcUnit.y;

        // Pixel footprint in world metres along each axis.
        float au = fwidth(horiz) + 1e-6;
        float av = fwidth(vert) + 1e-6;
        float hw = uBcJoint * 0.5;

        float cu = 1.0 - smoothstep(hw - au, hw + au, du);
        float cv = 1.0 - smoothstep(hw - av, hw + av, dv);

        // The arris. A block is not a sharp-edged cuboid: the edge is knocked
        // off by a millimetre or two in the mould and again by handling, so the
        // face rolls into the joint over roughly twice the joint width instead
        // of meeting it at a corner. Modelled as a wide, shallow shoulder,
        // which also gives the joint a total footprint of ~25 mm - three or
        // four pixels at the distances that matter, instead of one - so the
        // whole feature stops living below the sampling rate.
        float shw = hw + uBcJoint * 1.4;
        float shu = 1.0 - smoothstep(shw - au, shw + au, du);
        float shv = 1.0 - smoothstep(shw - av, shw + av, dv);
        chamfer = max(shu - cu, shv - cv);

        // Mean coverage of a joint over one unit. Converging on this instead of
        // on either 0 or 1 is what stops the wall shimmering at range while
        // keeping the tone a real wall has.
        float avgU = clamp(uBcJoint / uBcUnit.x, 0.0, 1.0);
        float avgV = clamp(uBcJoint / uBcUnit.y, 0.0, 1.0);
        float tu = smoothstep(uBcUnit.x * 0.18, uBcUnit.x * 0.85, au);
        float tv = smoothstep(uBcUnit.y * 0.18, uBcUnit.y * 0.85, av);
        cu = mix(cu, avgU, tu);
        cv = mix(cv, avgV, tv);

        // Coursing is meaningless on the roof deck and the soffits.
        float wall = 1.0 - smoothstep(0.55, 0.9, abs(n.y));
        cu *= wall;
        cv *= wall;

        float crisp = (1.0 - max(tu, tv)) * wall;
        // The joint is a 10 mm concave trough: its lower flank tilts up into
        // the light and its upper flank tilts down into shadow. That gradient,
        // not the tone, is what a viewer reads as recessed.
        slope = vec2(cu * sign(su), cv * sign(sv)) * crisp;

        // Groove self-shadow, per joint family. Head joints run vertically, so
        // their axis is world up; bed joints run along the wall's horizontal.
        vec3 tang = abs(n.x) > abs(n.z) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        float sU = bcGrooveShadow(n, vec3(0.0, 1.0, 0.0));
        float sV = bcGrooveShadow(n, tang);
        // Weight by which family this pixel actually belongs to, so a head
        // joint is not darkened by the bed joints' shadow term.
        float wgt = cu + cv + 1e-5;
        float s = (cu * sU + cv * sV) / wgt;
        float ambient = 1.0 - uBcAo;
        bright = ambient * (1.0 - uBcShadow * s);

        vec2 cell = vec2(floor((horiz + bond) / uBcUnit.x), course);
        float unit = bcHash(cell);
        unitR = bcHash(cell + 17.3) - 0.5;
        return vec4(cu, cv, unit - 0.5, crisp);
      }
    `;

    const colorInject = `
      vec2 bcSlope;
      float bcBright, bcUnitR, bcCham;
      vec4 bcJ = bcJoints(bcSlope, bcBright, bcUnitR, bcCham);
      float bcCov = max(bcJ.x, bcJ.y) * uBcAmount;
      // Forced-value channel for tools/diff.mjs: 5 or above paints the joints
      // pure red, so a zero-pixel diff can only mean the injection never
      // reached the framebuffer rather than that it was too subtle to see.
      if (uBcAmount > 9.5) {
        // Bisection channel: paints the whole surface, ignoring coverage, so a
        // zero diff here separates "the injection never ran" from "the joint
        // maths returned nothing".
        diffuseColor.rgb = vec3(1.0, 0.0, 1.0);
      } else if (uBcAmount > 4.5) {
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.0, 0.0), max(bcJ.x, bcJ.y));
      } else {
        // Paint bridges the mortar, so the joint is not a different colour -
        // it is the same paint in shadow, plus whatever has washed into the
        // bed joints, which the head joints do not collect. How dark that
        // shadow is depends on where the sun is: see bcGrooveShadow.
        float bcJointDark = mix(1.0, bcBright, bcCov);
        // The arris catches a little of the same shadow at half strength, which
        // is what turns a drawn line into an edge with a roll on it.
        bcJointDark *= mix(1.0, mix(1.0, bcBright, 0.45), bcCham * uBcAmount);
        diffuseColor.rgb *= bcJointDark;
        diffuseColor.rgb = mix(diffuseColor.rgb, uBcSoil, bcJ.y * uBcSoilAmt * uBcAmount);

        /*
         * Per-unit variation. This was 3.5%, which is below the threshold of
         * noticing on a painted wall, and a critic read the elevation as having
         * no unit-to-unit variation at all and as repeating at the albedo
         * tile's period. Both complaints have the same answer, because this
         * hash is keyed on the *world* block index: give it real magnitude and
         * it breaks the 1.63 m tile as a side effect.
         *
         * Painted block still varies unit to unit - a denser block takes less
         * paint, so the film is thinner and the block underneath reads through
         * - and it varies in hue as well as tone, because the substrate is
         * cooler than the paint. A few units per elevation are well off the
         * mean rather than everything sitting inside a narrow band.
         */
        float bcTone = bcJ.z * 2.0;                          // -1..1
        float bcOut = smoothstep(0.55, 1.0, abs(bcTone));    // the odd stray unit
        float bcAmp = uBcVar * (1.0 + bcOut * 1.6) * uBcAmount;
        vec3 bcTint = mix(vec3(1.0, 0.985, 0.955), vec3(0.955, 0.975, 1.0), bcJ.z + 0.5);
        diffuseColor.rgb *= bcTint * (1.0 + bcTone * bcAmp);
      }
    `;

    const roughInject = `
      vec2 bcRSlope;
      float bcRBright, bcRUnitR, bcRCham;
      vec4 bcRJ = bcJoints(bcRSlope, bcRBright, bcRUnitR, bcRCham);
      // Per-unit roughness as well as per-unit tone. Differential paint
      // absorption is the strongest unit-to-unit cue on a painted wall under
      // raking light, and it costs one hash that is already computed.
      roughnessFactor = clamp(
        roughnessFactor
          + max(bcRJ.x, bcRJ.y) * uBcRough * uBcAmount
          + bcRUnitR * uBcVarRough * uBcAmount,
        0.04, 1.0);
    `;

    // Perturbing in view space adds to whatever the normal map already did,
    // rather than replacing it, so the block's own surface texture survives.
    // `bcJoints` is called for its `out` parameter only. Discarding the return
    // value of a call used as a statement is legal GLSL; wrapping it in
    // `void(...)` to say so is NOT - GLSL has no void cast, and the driver
    // reads it as constructing a void, which fails the whole program with
    // "'void' : cannot construct this type". That single line is what defeated
    // three attempts at this feature and produced forced-value diffs of
    // exactly zero changed pixels: the program never linked, so nothing that
    // was changed above it could move.
    const normalInject = `
      vec2 bcNSlope;
      float bcNBright, bcNUnitR, bcNCham;
      bcJoints(bcNSlope, bcNBright, bcNUnitR, bcNCham);
      {
        vec3 bcWn = normalize(vBcNormal);
        vec3 bcWt = abs(bcWn.x) > abs(bcWn.z) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        vec3 bcVu = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vec3 bcVt = (viewMatrix * vec4(bcWt, 0.0)).xyz;
        normal = normalize(normal - (bcVu * bcNSlope.y + bcVt * bcNSlope.x) * uBcBump * uBcAmount);
      }
    `;

    assertDeclared(colorInject, "colour injection");
    assertDeclared(roughInject, "roughness injection");
    assertDeclared(normalInject, "normal injection");
    assertDeclared(decl.slice(decl.indexOf("float bcHash")), "shared helpers");

    let frag = shader.fragmentShader;
    frag = sub(frag, "#include <map_fragment>", colorInject);
    frag = sub(frag, "#include <roughnessmap_fragment>", roughInject);
    frag = sub(frag, "#include <normal_fragment_maps>", normalInject);
    shader.fragmentShader = decl + frag;
  };

  const priorKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${priorKey ? priorKey.call(material) : ""}|bc:${opts.key}`;
  material.needsUpdate = true;
  return material;
}
