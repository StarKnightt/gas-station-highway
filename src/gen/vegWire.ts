/**
 * Wires that survive being thinner than a pixel.
 *
 * This is the fourth time this project has lost a feature to sub-pixel
 * geometry, and NOTES.md documents the class. The arithmetic for a distribution
 * conductor, which is the version of the problem this file solves:
 *
 *   conductor diameter        10 mm
 *   distance from camera      40 m  (the near pole in the `pines` preset)
 *   angular size              0.010 / 40 = 250 urad = 0.0143 deg
 *   scale at fov 46, 1600 px  1600 / 46 = 34.8 px/deg
 *   on-screen width           0.50 px          <-- and 0.25 px at 80 m
 *
 * A half-pixel-wide triangle strip is rasterised only where its centre happens
 * to land inside a pixel centre, so the wire is drawn as a dashed line whose
 * dashes move when the camera moves. Subdividing the geometry does not help —
 * the samples are not the problem, the coverage is. The fix has two halves and
 * needs both:
 *
 *  - **A screen-space width floor.** The wire is built as a ribbon rather than a
 *    tube and widened in the vertex shader to at least `minPixels` across, in
 *    view space, so it always covers whole pixels.
 *  - **Coverage-compensated alpha.** Widening alone makes a distant wire far too
 *    prominent — a 10 mm cable rendered 2 px wide at 300 m is a rope. So the
 *    fragment's alpha is scaled by (true width / drawn width), which is exactly
 *    the fraction of the pixel the real wire would have covered. The result
 *    integrates to the right amount of darkening: continuous, stable, and
 *    correctly faint at distance. This is the standard treatment for thin
 *    features and the only one that is right at both ends of the range.
 *
 * It also gets the specular right, which the previous constant-width black tube
 * could not. A taut wire is a cylinder, so its highlight is anisotropic: it
 * reflects the sun in a band along its length wherever the geometry works out,
 * and at a 6 degree sun that band is a bright thread against the sky and the
 * single most photographic thing about a power line. The shader evaluates a
 * cylindrical-normal specular from the wire's tangent rather than a surface
 * normal, because a ribbon has no meaningful normal of its own.
 */

import * as THREE from "three";

export interface WireRibbonOptions {
  /** True radius of the conductor, metres. Used for the coverage term. */
  radius: number;
  /** Never draw narrower than this many pixels. */
  minPixels?: number;
  /** Never let coverage alpha fall below this, or distant spans vanish. */
  minAlpha?: number;
}

/**
 * Ribbon geometry for one or more polylines. Two vertices per point, carrying a
 * `side` of -1 / +1 and the local `tangent`; the shader turns those into a
 * camera-facing strip of controlled screen width.
 */
export function wireRibbonGeometry(lines: THREE.Vector3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const tan: number[] = [];
  const side: number[] = [];
  const along: number[] = [];
  const idx: number[] = [];

  for (const pts of lines) {
    if (pts.length < 2) continue;
    const base = pos.length / 3;
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const t = new THREE.Vector3().subVectors(next, prev).normalize();
      if (i > 0) run += pts[i].distanceTo(pts[i - 1]);
      for (const s of [-1, 1]) {
        pos.push(pts[i].x, pts[i].y, pts[i].z);
        tan.push(t.x, t.y, t.z);
        side.push(s);
        along.push(run);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("tangent", new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute("side", new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute("along", new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  // The shader moves vertices sideways by up to a few pixels' worth of world
  // space, which the bounding sphere computed from the raw positions does not
  // account for. Padding it keeps the ribbon from being frustum-culled just as
  // it reaches the edge of frame.
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 1.0;
  return g;
}

export function wireMaterial(
  sunDirection: THREE.Vector3,
  opts: WireRibbonOptions
): THREE.ShaderMaterial {
  const minPixels = opts.minPixels ?? 1.7;
  const minAlpha = opts.minAlpha ?? 0.16;

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      uRadius: { value: opts.radius },
      uMinPixels: { value: minPixels },
      uMinAlpha: { value: minAlpha },
      uViewportHeight: { value: 900 },
      uSunDir: { value: sunDirection.clone() },
      // Weathered aluminium-steel: nearly black in shadow, and the brief's sun
      // is far too warm and low to light it as a mid grey.
      //
      // Both linear, and the old code was wrong on sight without measuring
      // anything: `uBase` was tagged `SRGBColorSpace` while `uGlint` two lines
      // below was tagged `LinearSRGBColorSpace`, and the shader *sums them in
      // one expression*. Adjacent terms of a single expression have to share a
      // space; two different tags on two lines of one uniform block is a
      // statement that they do not. Measured, uBase landed 12.6x too dark, at
      // **1/255**, which is most of why these wires read as constant-width pure
      // black with no glint: the glint was being added to a black that could not
      // be lifted off the floor.
      uBase: { value: new THREE.Color(0.055, 0.052, 0.05) },
      // The glint. Bright enough to blow out, because the sun is bright enough
      // to blow out the building. Was already effectively linear — `setRGB` with
      // `LinearSRGBColorSpace` is a pass-through — so only its neighbour moved.
      uGlint: { value: new THREE.Color(3.4, 2.05, 1.05) },
      // These two are named to match `UniformsLib.fog`, so with `fog: true`
      // three's `refreshFogUniforms` overwrites them from `scene.fog` on every
      // draw (three.module.js:14990). The values here are only the fallback if
      // the scene has no fog; the wire's aerial perspective therefore stays in
      // step with whatever the lighting system sets, with nothing to keep
      // manually synchronised.
      fogColor: { value: new THREE.Color(0.3, 0.34, 0.44) },
      fogDensity: { value: 0.0027 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 tangent;
      attribute float side;
      attribute float along;

      uniform float uRadius;
      uniform float uMinPixels;
      uniform float uViewportHeight;

      varying float vCoverage;
      varying vec3 vViewPos;
      varying vec3 vTangentView;
      varying float vAlong;

      void main() {
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vec3 tv = normalize( ( modelViewMatrix * vec4( tangent, 0.0 ) ).xyz );

        // Offset direction: perpendicular to both the wire and the eye ray, so
        // the ribbon always presents its full width to the camera and never
        // disappears edge-on the way a flat quad would.
        vec3 toEye = normalize( -mv.xyz );
        vec3 offDir = cross( tv, toEye );
        float l = length( offDir );
        // Looking straight down the wire: any perpendicular will do.
        offDir = l > 1e-4 ? offDir / l : normalize( cross( tv, vec3( 0.0, 0.0, 1.0 ) ) );

        // World size of one pixel at this depth. projectionMatrix[1][1] is
        // 1/tan(fov/2), so depth / that / (height/2) is metres per pixel.
        float metresPerPixel = -mv.z / projectionMatrix[1][1] / ( uViewportHeight * 0.5 );
        // halfWidth, not half: "half" is a reserved word in GLSL ES, and this
        // shader silently failed to link for an entire capture round because of
        // it. tsc has nothing to say about the contents of a template literal,
        // so the only thing that catches this class of mistake is treating a
        // shader link failure as fatal in the harness, which shoot6.mjs does.
        // (Nor may this comment contain a backtick, for the same reason.)
        float halfWidth = max( uRadius, uMinPixels * 0.5 * metresPerPixel );
        // How much of the drawn width the real wire actually accounts for.
        vCoverage = clamp( uRadius / max( halfWidth, 1e-6 ), 0.0, 1.0 );

        mv.xyz += offDir * side * halfWidth;
        vViewPos = mv.xyz;
        vTangentView = tv;
        vAlong = along;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase;
      uniform vec3 uGlint;
      uniform vec3 uSunDir;
      uniform float uMinAlpha;
      uniform vec3 fogColor;
      uniform float fogDensity;

      varying float vCoverage;
      varying vec3 vViewPos;
      varying vec3 vTangentView;
      varying float vAlong;

      void main() {
        vec3 v = normalize( -vViewPos );
        vec3 t = normalize( vTangentView );
        vec3 s = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );

        // Anisotropic specular for a cylinder: the strength depends on how close
        // the half vector is to perpendicular to the wire's axis, which is what
        // produces a glint that runs *along* a span rather than a dot on it.
        vec3 h = normalize( s + v );
        float axial = dot( h, t );
        float spec = pow( max( 0.0, 1.0 - axial * axial ), 220.0 );
        // Only the sunward side of the wire glints.
        float lit = smoothstep( -0.15, 0.35, dot( s, v ) * 0.5 + 0.5 );

        // A hand-twisted conductor has a slow helical variation in which facet
        // faces the sun, so the glint is a dashed thread, not a continuous line.
        float twist = 0.62 + 0.38 * sin( vAlong * 5.3 );

        vec3 c = uBase + uGlint * spec * lit * twist;

        // Coverage is the whole point: a wire widened to a pixel floor must give
        // back in alpha exactly what it gained in width, or it reads as a rope.
        // The glint is allowed to punch through, because a specular highlight on
        // a sub-pixel wire really is bright enough to register on its own.
        float a = max( uMinAlpha, vCoverage );
        a = clamp( a + spec * lit * 0.8, 0.0, 1.0 );
        gl_FragColor = vec4( c, a );

        // A ShaderMaterial gets NO tone mapping and NO output encode. Three
        // makes the functions available in the prefix and then does nothing
        // with them; every built-in material calls these two chunks itself, and
        // this shader did not. So it was writing scene-referred linear values
        // straight to an sRGB-output framebuffer.
        //
        // Same defect as the transmission term (NOTES, the 8x rule), with the
        // chunk list removed so there was no suspicious injection point to
        // look at. Consequences here were both directions at once: uBase at
        // linear 0.055 rendered at 14/255 instead of the ~71/255 it authors to
        // through ACES at 1.25 exposure — which is most of the "wires read as
        // constant-width pure black" complaint, and it survived a previous
        // round that correctly fixed a *different* colour-space bug two lines
        // above in the uniform block — while uGlint at 3.4 clipped flat to
        // white instead of rolling off, so the glint had no shoulder either.
        #include <tonemapping_fragment>
        #include <colorspace_fragment>

        // Fog last, and after the encode, because that is where three puts it.
        //
        // Three's own fog_fragment runs after colorspace_fragment, mixing a
        // linear fogColor into an encoded framebuffer value. That is arguably
        // wrong, but it is what every other material in this scene does, and a
        // wire has to dissolve into exactly the same haze as the pole it is
        // strung between. Matching three matters more here than being locally
        // correct; if three's ordering ever changes, this moves with it.
        float d = length( vViewPos );
        float f = 1.0 - exp( - fogDensity * fogDensity * d * d );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp( f, 0.0, 1.0 ) );
      }
    `,
  });
}
