import * as THREE from "three";

/**
 * Global GLSL chunk patches owned by System 4.
 *
 * Two things the stock chunks cannot do are load-bearing for a dawn scene:
 *
 *  1. **Wider shadow filtering.** r185's PCF path takes five Vogel-disk taps.
 *     At a 6 degree sun the shadows are enormously long and their penumbrae are
 *     metres wide; five taps at a radius wide enough to cover that penumbra
 *     bands badly. Sixteen taps costs almost nothing on a 4060 and removes it.
 *
 *  2. **Aerial perspective.** `FogExp2` mixes toward one flat colour, so the
 *     far ground goes grey-blue no matter where the sun is. Real dawn haze is
 *     strongly forward-scattering: looking into the sun the haze is bright and
 *     orange, looking away it is cool, and it thins with altitude. That needs
 *     the world-space view ray in the fragment shader, which the stock fog
 *     chunks do not provide.
 *
 * Both are done by string-replacing `THREE.ShaderChunk`, which reaches every
 * material in the scene including the ones owned by other systems, without
 * editing a single line of their files. Every replacement asserts that its
 * anchor text was actually found: a chunk patch that silently no-ops is exactly
 * the class of bug NOTES.md is about, so a miss is reported loudly and the
 * stock chunk is left alone rather than half-applied.
 */

const applied = { pcf: false, fog: false, pcss: false };
const problems: string[] = [];

/**
 * Print the chunk that is actually loaded, and where the needle stopped matching.
 *
 * This exists because of how a miss is naturally debugged. `anchor not found` is
 * read, the source file the needle was copied from is opened, the needle is
 * confirmed to be there verbatim, and the conclusion is that three must be doing
 * something strange at runtime. That loop can be repeated indefinitely, because
 * the source file will confirm the needle *forever*: it is not the file that
 * runs. `node_modules/three/src/**` is not bundled; three's `exports` point at
 * `build/three.module.js`, and the build strips GLSL comments and blank lines and
 * can renest the preprocessor.
 *
 * So on a miss, do not report the needle. Report the haystack. Truncating the
 * needle until it does match locates the exact character where the assumption
 * broke, and dumping a window of the loaded text with whitespace escaped shows
 * why - usually a comment that no longer exists or one tab where two were
 * expected.
 */
function reportAnchorMiss(tag: string, src: string, find: string): void {
  let keep = find.length;
  while (keep > 8 && src.indexOf(find.slice(0, keep)) < 0) keep--;
  const at = keep > 8 ? src.indexOf(find.slice(0, keep)) : -1;
  problems.push(`${tag}: anchor not found`);
  console.error(
    `[lighting] ${tag}: anchor not found. This is almost certainly a needle copied from ` +
      `node_modules/three/src, which is NOT what the bundler loads. Author anchors against ` +
      `THREE.ShaderChunk at runtime instead:\n` +
      `  node --input-type=module -e "import * as THREE from 'three'; console.log(THREE.ShaderChunk.<name>)"\n` +
      `  loaded chunk length ${src.length}\n` +
      `  needle            ${JSON.stringify(find)}\n` +
      (at >= 0
        ? `  longest prefix that matches: ${keep}/${find.length} chars, at ${at}\n` +
          `  diverges at              ${JSON.stringify(find.slice(keep - 1, keep + 24))}\n` +
          `  loaded text there        ${JSON.stringify(src.slice(at + keep - 1, at + keep + 24))}`
        : `  no prefix of the needle appears at all; the anchor is in the wrong chunk`)
  );
}

/** Replace `find` in `src` exactly once, or record a failure and return null. */
function replaceOnce(src: string, find: string, into: string, tag: string): string | null {
  const first = src.indexOf(find);
  if (first < 0) {
    reportAnchorMiss(tag, src, find);
    return null;
  }
  if (src.indexOf(find, first + find.length) >= 0) {
    problems.push(`${tag}: anchor matched more than once`);
    return null;
  }
  return src.slice(0, first) + into + src.slice(first + find.length);
}

/* ------------------------------------------------------------------ */
/* 1. wider PCF                                                        */
/* ------------------------------------------------------------------ */

const PCF_TAPS = 16;

function pcfSum(): string {
  const lines: string[] = [];
  for (let i = 0; i < PCF_TAPS; i++) {
    lines.push(
      `\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( ${i}, ${PCF_TAPS}, phi ) * radius, shadowCoord.z ) )`
    );
  }
  return `\t\t\t\tshadow = (\n${lines.join(" +\n")}\n\t\t\t\t) * ${(1 / PCF_TAPS).toFixed(8)};`;
}

function patchPcf(): void {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  // The stock five-tap sum, matched by its first and last taps so the patch
  // fails loudly rather than quietly if three re-writes the block.
  const fiveTap = "shadow = (\n\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi )";
  const start = src.indexOf(fiveTap);
  if (start < 0) {
    reportAnchorMiss("pcf", src, fiveTap);
    return;
  }
  const endMark = ") * 0.2;";
  const end = src.indexOf(endMark, start);
  if (end < 0) {
    problems.push("pcf: end of five-tap sum not found");
    return;
  }
  const block = src.slice(start, end + endMark.length);
  const next = replaceOnce(src, block, pcfSum().trimStart(), "pcf");
  if (!next) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = next;
  applied.pcf = true;
}

/* ------------------------------------------------------------------ */
/* 1b. contact hardening                                               */
/* ------------------------------------------------------------------ */

/**
 * A constant filter radius is not a light.
 *
 * The penumbra cast by a source of angular radius `theta` is proportional to
 * the distance between occluder and receiver: zero where an object touches the
 * ground, `theta * d` at height `d`. Three's PCF filters with
 * `shadowRadius * texelSize`, which is constant, and constant is the one thing
 * a penumbra cannot be. It corresponds to a source whose angular size is
 * infinite at the contact point and shrinks to nothing with distance - exactly
 * inverted.
 *
 * Separation is measured **along the light ray, not vertically**, and at a 6.2
 * degree sun that is a factor of `1 / sin( 6.2 )` = 9.3. Getting this wrong is
 * easy and it inverts the conclusion for half the scene, so both columns below
 * are worth keeping. At this scene's fit - shadow sphere radius ~83 m, 8192 map,
 * ~1.9 cm per texel - and the old constant `sradius` 3.2, i.e. 13 cm drawn:
 *
 * | occluder                      | receiver | separation | true penumbra |
 * |-------------------------------|----------|------------|---------------|
 * | car door detail, 0.1 m away   | flank    | 0.1 m      | 0.4 cm        |
 * | car body, 1 m away            | flank    | 1 m        | 3.7 cm        |
 * | kerb lip 0.1 m up             | ground   | 0.93 m     | 3.4 cm        |
 * | car body 0.7 m up             | ground   | 6.5 m      | 24 cm         |
 * | canopy soffit 4.72 m up       | ground   | 43.7 m     | **1.62 m**    |
 *
 * So the constant kernel was wrong in *both* directions, which is why the
 * symptom reports did not agree with each other. On surfaces close to their own
 * occluders - car panels, building reveals, anything self-shadowing - 13 cm is 3
 * to 30 times too soft, and on the `car_side_sun` framing at 1.9 mm per pixel it
 * is 67 pixels, which erases every shadow feature finer than that and produced
 * the blocky "staircase" patches across the car's flank. On the ground under
 * tall occluders it is the opposite: the canopy's penumbra should be 1.6 m and
 * was drawn at 13 cm, a hard edge where there should be a metre and a half of
 * gradient. One number cannot be both, which is the whole argument.
 *
 * So: estimate the blocker depth, and set the radius from it. Two details make
 * this cheaper here than the usual PCSS.
 *
 *  - The light is **directional and orthographic**, so shadow-map depth is
 *    linear in world distance and the penumbra is `theta * (zRec - zBlk) * D`
 *    with no perspective term. One scalar `K = theta * D / W` converts a depth
 *    difference straight to a UV radius. It arrives in `shadowRadius`, which is
 *    the one per-light float three already plumbs through and which this path no
 *    longer has any use for. That overload is a trap, so it is asserted on the
 *    CPU side and named `contactScale` there rather than `radius`.
 *  - A blocker search needs *raw* depth, and the PCF path binds the map as
 *    `sampler2DShadow`, which can only answer comparisons. `SHADOWMAP_TYPE_BASIC`
 *    binds the same map as a plain `sampler2D` and three sets
 *    `depthTexture.compareFunction = null` for it, so switching type buys raw
 *    depth with no second render target and no extra pass.
 *
 * Bias is receiver-plane rather than scalar. A wide kernel samples the map far
 * from the shaded point, and at a 6 degree sun the receiver's own depth slope
 * across that distance dwarfs any constant bias - which is why the constant
 * kernel needed a 5.5 cm `normalBias` to stay free of acne, and why that
 * normalBias then detached contact shadows by 5.5 cm on its own. The two
 * defects were coupled and had to be fixed together. Predicting the receiver's
 * depth at each tap from its screen-space gradient removes the coupling: the
 * bias needed is then proportional to the tap offset automatically, and exact
 * for a planar receiver.
 */

const PCSS_SEARCH_TAPS = 12;
const PCSS_TAPS = 16;
/**
 * Blocker search half-width, texels, and the cap on the filter itself.
 *
 * These were 16 texels on the first attempt, which is 31 cm and was chosen
 * against the vertical-height version of the table above - i.e. against the
 * 9.3x-too-small separations. Measured, that clamp bound the filter almost
 * everywhere and the penumbra came out *narrower* than the constant kernel at
 * every sample, flat ratio, no growth: the measurement said "this is a kernel
 * change, not contact hardening" and it was right.
 *
 * 48 texels is 93 cm of radius, 1.86 m across, which covers the canopy's 1.62 m
 * with a little room. The search radius has to be at least the filter cap or
 * tall blockers are never found and the filter never widens - and that failure
 * looks exactly like success, because a too-small search returns "no blocker"
 * and the surface is drawn lit.
 */
const PCSS_SEARCH_TEXELS = 48.0;
const PCSS_MAX_TEXELS = 48.0;
/** Never narrower than this, so contact is one soft texel and not aliased. */
const PCSS_MIN_TEXELS = 0.6;

function pcssBlock(): string {
  return `	#else
		float dsIGN( vec2 p ) {
			return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
		}

		vec2 dsVogel( int i, int n, float phi ) {
			const float golden = 2.399963229728653;
			float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
			float theta = float( i ) * golden + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;
		}

		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

			float shadow = 1.0;

			shadowCoord.xyz /= shadowCoord.w;

			// Derivatives must be taken in uniform control flow, so they are
			// computed before the frustum branch rather than inside it.
			vec2 duvdx = dFdx( shadowCoord.xy );
			vec2 duvdy = dFdy( shadowCoord.xy );
			float dzdx = dFdx( shadowCoord.z );
			float dzdy = dFdy( shadowCoord.z );
			float det = duvdx.x * duvdy.y - duvdy.x * duvdx.y;
			// Depth gradient per unit of shadow UV, by inverting the 2x2 UV
			// Jacobian. Degenerate at silhouettes and on polygons edge-on to the
			// screen, where falling back to a flat receiver is the safe answer.
			vec2 dzduv = vec2( 0.0 );
			if ( abs( det ) > 1e-12 ) {
				dzduv = vec2(
					( dzdx * duvdy.y - dzdy * duvdx.y ),
					( dzdy * duvdx.x - dzdx * duvdy.x )
				) / det;
			}
			// A grazing receiver can produce an enormous gradient; clamping keeps
			// one bad pixel from bleeding a whole tap's worth of light.
			float gradLimit = 8.0 / shadowMapSize.x;
			dzduv = clamp( dzduv, vec2( -gradLimit ), vec2( gradLimit ) ) * shadowMapSize.x;

			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif

			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;

			if ( frustumTest ) {

				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float phi = dsIGN( gl_FragCoord.xy ) * PI2;

				// --- blocker search ---
				float searchR = ${PCSS_SEARCH_TEXELS.toFixed(1)} * texelSize.x;
				float blkSum = 0.0;
				float blkN = 0.0;
				for ( int i = 0; i < ${PCSS_SEARCH_TAPS}; i ++ ) {
					vec2 o = dsVogel( i, ${PCSS_SEARCH_TAPS}, phi ) * searchR;
					float d = texture2D( shadowMap, shadowCoord.xy + o ).r;
					float zAt = shadowCoord.z + dot( dzduv, o );
					#ifdef USE_REVERSED_DEPTH_BUFFER
						if ( d > zAt ) { blkSum += d; blkN += 1.0; }
					#else
						if ( d < zAt ) { blkSum += d; blkN += 1.0; }
					#endif
				}

				if ( blkN > 0.5 ) {

					float blocker = blkSum / blkN;
					float sep = abs( shadowCoord.z - blocker );
					// shadowRadius carries K = theta * depthRange / frustumWidth.
					float r = clamp(
						shadowRadius * sep,
						${PCSS_MIN_TEXELS.toFixed(1)} * texelSize.x,
						${PCSS_MAX_TEXELS.toFixed(1)} * texelSize.x
					);

					float sum = 0.0;
					for ( int i = 0; i < ${PCSS_TAPS}; i ++ ) {
						vec2 o = dsVogel( i, ${PCSS_TAPS}, phi ) * r;
						float d = texture2D( shadowMap, shadowCoord.xy + o ).r;
						float zAt = shadowCoord.z + dot( dzduv, o );
						#ifdef USE_REVERSED_DEPTH_BUFFER
							sum += step( d, zAt );
						#else
							sum += step( zAt, d );
						#endif
					}
					shadow = sum * ${(1 / PCSS_TAPS).toFixed(8)};

				}

			}

			return mix( 1.0, shadow, shadowIntensity );
		}
	#endif`;
}

/** Present in the installed chunk if and only if the patch took. */
const PCSS_MARKER = "float dsIGN( vec2 p )";

/**
 * The anchor is code only, and that is not a style preference.
 *
 * The first version of this needle was `"\t#else // SHADOWMAP_TYPE_BASIC"`, read
 * straight out of `node_modules/three/src/renderers/shaders/ShaderChunk/
 * shadowmap_pars_fragment.glsl.js`, where it appears verbatim. It could never
 * match, because that file is not the file that runs: three's package `exports`
 * point at `build/three.module.js`, which is what Vite bundles, and the build
 * step strips GLSL comments and blank lines. The branch marker survives as a
 * bare `\t#else`. So the needle was written against source that is real,
 * readable, correct, and never loaded — and it failed in the one way this
 * project has been burned by repeatedly, quietly, with a fallback that rendered.
 *
 * Two consequences, both enforced below. Never anchor on a comment or on blank
 * lines. And read `THREE.ShaderChunk` at runtime when authoring an anchor rather
 * than reading the source tree, because only the former is evidence.
 */
function patchPcss(): void {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  // The directional BASIC branch. VSM is `#elif defined( SHADOWMAP_TYPE_VSM )`
  // and the point-light ones take a samplerCube, so pinning both the `#else` and
  // the `sampler2D` signature identifies this one uniquely - asserted, not
  // assumed, by `replaceOnce`.
  const needle = "\t#else\n\t\tfloat getShadow( sampler2D shadowMap";
  const start = src.indexOf(needle);
  if (start < 0) {
    reportAnchorMiss("pcss", src, needle);
    return;
  }
  const endMark = "\n\t#endif";
  const end = src.indexOf(endMark, start);
  if (end < 0) {
    problems.push("pcss: end of BASIC branch not found");
    return;
  }
  const block = src.slice(start, end + endMark.length);
  const next = replaceOnce(src, block, pcssBlock(), "pcss");
  if (!next) return;
  // Cheap, but it is the difference between "the replace call returned a string"
  // and "the chunk that materials will compile against contains the new code".
  if (!next.includes(PCSS_MARKER) || next.includes("float depth = texture2D( shadowMap, shadowCoord.xy ).r;\n\t\t\t\t#ifdef")) {
    problems.push("pcss: chunk did not contain the new filter after replacement");
    return;
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = next;
  applied.pcss = true;
}

/* ------------------------------------------------------------------ */
/* 2. aerial perspective                                               */
/* ------------------------------------------------------------------ */

/**
 * Extra fog uniforms. These are merged into `UniformsLib.fog` before any
 * material is constructed, so every fogged material picks them up. The renderer
 * only refreshes `fogColor` / `fogDensity` per frame; these are cloned per
 * material and then left alone, which is fine because the sun does not move.
 */
export const LIGHT_FOG_UNIFORMS = {
  uHazeSunDir: { value: new THREE.Vector3(-0.91, 0.1, -0.4) },
  /**
   * Haze colour looking directly away from the sun.
   *
   * Was `(0.235, 0.300, 0.425)` - B/R 1.81, a saturated Rayleigh blue - and the
   * physics does not support it over this path length. Three reasons, and they
   * agree:
   *
   * 1. **Rayleigh cannot be the mechanism here.** Sea-level Rayleigh extinction
   *    is ~0.0116/km at 550nm, so over the ~700m to the far ridge tau is 0.008,
   *    and 0.018 even at 450nm. Negligible. The haze that is actually visible
   *    at this range is aerosol - dust and moisture - whose Angstrom exponent
   *    is ~0.5-1.3 against Rayleigh's 4. It is spectrally near-neutral and
   *    strongly forward-scattering. A blue 700m haze is the signature of tens
   *    of kilometres of clean air, which is why it reads as midday.
   * 2. **So the tint is the colour of the light in the column, not a scattering
   *    signature.** At 6.2 degrees the beam crosses ~9.5 air masses:
   *    tau_650 = 0.47, tau_450 = 2.08, so transmittance runs 5:1 red over blue.
   *    Away from the sun you see back-scatter, which is weaker and skylight-
   *    dominated, so it should be *less warm* than the solar side - not blue.
   * 3. **It contradicted our own published sky.** `report.sky.horizonRing`
   *    gives blueOverRed 0.87-0.89 away from the sun, i.e. R slightly above B.
   *    The haze was twice as blue as the dome it is supposed to be scattering.
   *
   * Now matched to that horizon chromaticity at held luminance (0.295 -> 0.304,
   * so density and depth are untouched), with G a touch under both R and B for
   * the desaturated pink of the anti-solar dawn horizon - the Belt of Venus,
   * whose blue earth-shadow band sits *below* it, not at this elevation.
   */
  uHazeCool: { value: new THREE.Color(0.355, 0.288, 0.306) },
  /** Haze colour looking toward the sun. */
  uHazeWarm: { value: new THREE.Color(0.84, 0.545, 0.335) },
  /** Extra forward-scatter lobe right around the sun. */
  uHazeGlow: { value: new THREE.Color(1.20, 0.62, 0.28) },
  /** e-folding height of the haze layer, metres. */
  uHazeHeight: { value: 46.0 },
  /** Global multiplier; 0 disables aerial perspective for a forced diff. */
  uHazeGain: { value: 1.0 },
};

function patchFog(): void {
  const parsVert = replaceOnce(
    THREE.ShaderChunk.fog_pars_vertex,
    "varying float vFogDepth;",
    "varying float vFogDepth;\n\tvarying vec3 vFogViewPos;",
    "fog_pars_vertex"
  );
  const vert = replaceOnce(
    THREE.ShaderChunk.fog_vertex,
    "vFogDepth = - mvPosition.z;",
    "vFogDepth = - mvPosition.z;\n\tvFogViewPos = mvPosition.xyz;",
    "fog_vertex"
  );
  const parsFrag = replaceOnce(
    THREE.ShaderChunk.fog_pars_fragment,
    "varying float vFogDepth;",
    [
      "varying float vFogDepth;",
      "\tvarying vec3 vFogViewPos;",
      "\tuniform vec3 uHazeSunDir;",
      "\tuniform vec3 uHazeCool;",
      "\tuniform vec3 uHazeWarm;",
      "\tuniform vec3 uHazeGlow;",
      "\tuniform float uHazeHeight;",
      "\tuniform float uHazeGain;",
    ].join("\n"),
    "fog_pars_fragment"
  );

  // `viewMatrix` and `cameraPosition` are both declared by the renderer in the
  // fragment prefix. Multiplying a direction by the view matrix from the left
  // applies its transpose, which for an orthonormal rotation is its inverse -
  // so this recovers the world-space offset from the camera without needing an
  // extra uniform or a second varying.
  const frag = replaceOnce(
    THREE.ShaderChunk.fog_fragment,
    "\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );",
    /* glsl */ `
	vec3 hazeOffset = ( vec4( vFogViewPos, 0.0 ) * viewMatrix ).xyz;
	vec3 hazeDir = normalize( hazeOffset );
	float hazeSun = max( dot( hazeDir, normalize( uHazeSunDir ) ), 0.0 );

	// Haze sits in a layer near the ground, so a ray that climbs out of it
	// accumulates less of it. Averaging the two endpoint heights is crude but
	// monotonic and cheap, and at these distances it is indistinguishable from
	// the integral.
	float hazeH = max( cameraPosition.y + 0.5 * hazeOffset.y, 0.0 );
	float hazeAtt = exp( - hazeH / max( uHazeHeight, 1.0 ) );

	float hazeFactor = clamp( fogFactor * hazeAtt * uHazeGain, 0.0, 1.0 );

	vec3 hazeCol = mix( uHazeCool, uHazeWarm, pow( hazeSun, 1.6 ) * 0.86 + hazeSun * 0.14 );
	hazeCol += uHazeGlow * pow( hazeSun, 9.0 ) * 0.9;

	gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeCol, hazeFactor );`,
    "fog_fragment"
  );

  if (!parsVert || !vert || !parsFrag || !frag) return;
  THREE.ShaderChunk.fog_pars_vertex = parsVert;
  THREE.ShaderChunk.fog_vertex = vert;
  THREE.ShaderChunk.fog_pars_fragment = parsFrag;
  THREE.ShaderChunk.fog_fragment = frag;
  Object.assign(THREE.UniformsLib.fog, LIGHT_FOG_UNIFORMS);

  // ...and into every already-merged ShaderLib entry. `UniformsLib.fog` alone
  // is not enough: `ShaderLib` merges the uniform libraries at module load,
  // long before this runs, so a built-in material's uniform set is a snapshot
  // that never sees the addition. The shader still compiles - an unset uniform
  // is simply zero - so `uHazeGain` came out 0 and the aerial perspective was
  // silently absent while every other signal said it was working. Textbook
  // NOTES.md.
  let injected = 0;
  for (const entry of Object.values(THREE.ShaderLib) as Array<{ uniforms: Record<string, THREE.IUniform> }>) {
    if (!entry?.uniforms || !("fogDensity" in entry.uniforms || "fogColor" in entry.uniforms)) continue;
    Object.assign(entry.uniforms, LIGHT_FOG_UNIFORMS);
    injected++;
  }
  if (injected === 0) problems.push("fog: no ShaderLib entry carried fog uniforms");
  applied.fog = injected > 0;
}

let done = false;

/**
 * Idempotent. Must run before any fogged material is constructed, which means
 * before every other system's `init()` - LightingSystem is registered first for
 * exactly this reason.
 *
 * `skip` exists for one reason and it is not tuning: `?lforce=nofog` sets the
 * fog density and `uHazeGain` to zero, which is the right forced test for
 * "is aerial perspective doing anything" and **useless** as a test for "is the
 * aerial perspective patch producing a non-finite value". `mix( colour, haze,
 * 0.0 )` compiles to `colour + 0.0 * ( haze - colour )`, and zero times NaN is
 * NaN, so a poisoned `hazeCol` survives its own contribution being turned off.
 * The only honest way to exonerate the patch is not to install it.
 */
export function installLightShaderPatches(
  skip: { pcf?: boolean; fog?: boolean } = {},
  opts: { pcss?: boolean } = {}
): { pcf: boolean; fog: boolean; pcss: boolean; problems: string[] } {
  if (!done) {
    done = true;
    // The two are alternatives, not layers: `patchPcf` widens the constant-radius
    // filter on the `sampler2DShadow` path, `patchPcss` replaces the raw-depth
    // path with a contact-hardening one. Installing both would leave whichever
    // `renderer.shadowMap.type` selects in force and the other inert, which is
    // precisely the kind of "the code is there so the feature must be on"
    // situation this file exists to avoid.
    if (opts.pcss) patchPcss();
    else if (!skip.pcf) patchPcf();
    if (!skip.fog) patchFog();
    if (problems.length) {
      console.error(`[lighting] shader chunk patch FAILED: ${problems.join("; ")}`);
    }
  }
  return { ...applied, problems: [...problems] };
}
