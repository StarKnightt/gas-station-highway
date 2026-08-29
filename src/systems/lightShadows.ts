import * as THREE from "three";

/**
 * Shadow-frustum fitting for a near-horizon sun.
 *
 * A 6 degree sun is the worst case for shadow mapping. The light frustum has to
 * span the whole visible lot laterally *and* a hundred-odd metres of depth
 * along a direction that is almost parallel to the ground, and the surfaces
 * receiving the shadow are at grazing incidence to the light, so the depth
 * gradient per shadow texel is enormous and ordinary constant bias either acnes
 * or peter-pans. Three things keep it honest:
 *
 *  - **Fit to the camera, not to the world.** A static frustum big enough for
 *    the whole 800 m terrain would put ~10 cm between texels. Fitting to the
 *    first 90 m of the view frustum gets that to under 2 cm at 8192.
 *  - **Fit a sphere, then snap.** Fitting the frustum's bounding *box* changes
 *    the box size as the camera turns, which makes the shadow crawl. A sphere
 *    is rotation-invariant, so the box size is constant and the centre can be
 *    snapped to whole texels, which removes the crawl entirely.
 *  - **Pull the near plane a long way back.** Casters behind the camera - the
 *    store, the canopy - still throw shadows into frame when the sun is this
 *    low, and a near plane fitted to the visible set silently clips them.
 */

export interface ShadowFitOptions {
  /** How far down the view frustum shadows are maintained, metres. */
  distance: number;
  /** Extra depth behind the fitted sphere for off-screen casters, metres. */
  casterDepth: number;
  mapSize: number;
}

const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _centre = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _fitCam = new THREE.Object3D();
const _inv = new THREE.Matrix4();
const _tmp = new THREE.Vector3();

/**
 * Bounding sphere of the slice of `camera`'s frustum between its near plane and
 * `distance`. Returned in world space.
 */
function frustumSphere(camera: THREE.PerspectiveCamera, distance: number, out: THREE.Vector3): number {
  const near = camera.near;
  const far = Math.min(camera.far, distance);
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const hNear = tan * near;
  const wNear = hNear * camera.aspect;
  const hFar = tan * far;
  const wFar = hFar * camera.aspect;

  let i = 0;
  for (const [z, w, h] of [
    [near, wNear, hNear],
    [far, wFar, hFar],
  ] as const) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        _corners[i++].set(sx * w, sy * h, -z);
      }
    }
  }

  // The exact minimal sphere of a symmetric frustum slice has its centre on the
  // view axis; solving for it beats averaging the corners, which over-sizes the
  // sphere by up to 40% at wide fields of view.
  const a = hNear * hNear * (1 + camera.aspect * camera.aspect);
  const b = hFar * hFar * (1 + camera.aspect * camera.aspect);
  let cz = (b - a) / (2 * (far - near)) + (far + near) / 2;
  cz = THREE.MathUtils.clamp(cz, near, far);
  out.set(0, 0, -cz);
  let radius = 0;
  for (const c of _corners) radius = Math.max(radius, c.distanceTo(out));

  camera.updateMatrixWorld();
  out.applyMatrix4(camera.matrixWorld);
  return radius;
}

/**
 * Point `light` at the fitted region and size its orthographic shadow camera.
 * Returns the world-space texel size, which is the number to look at when
 * choosing bias.
 */
export function fitSunShadow(
  light: THREE.DirectionalLight,
  camera: THREE.PerspectiveCamera,
  sunDirection: THREE.Vector3,
  opts: ShadowFitOptions
): number {
  const radius = frustumSphere(camera, opts.distance, _centre);
  return fitSunShadowSphere(light, _centre, radius, sunDirection, opts);
}

/**
 * The same fit against an explicit world sphere rather than the view frustum.
 *
 * The environment capture needs this: it photographs the scene from a fixed
 * point that has nothing to do with where the player camera is, and a shadow
 * map still fitted to the camera would bake whatever happened to be shadowed
 * near the camera into the environment every object in the scene reflects.
 */
export function fitSunShadowSphere(
  light: THREE.DirectionalLight,
  centre: THREE.Vector3,
  radius: number,
  sunDirection: THREE.Vector3,
  opts: ShadowFitOptions
): number {
  if (centre !== _centre) _centre.copy(centre);
  const texel = (radius * 2) / opts.mapSize;

  const back = radius + opts.casterDepth;
  _lightPos.copy(_centre).addScaledVector(sunDirection, back);

  // Reproduce exactly the basis three will build for the shadow camera, so the
  // snapping below is done in the same space the depth pass rasterises in.
  _fitCam.position.copy(_lightPos);
  _fitCam.up.copy(light.shadow.camera.up);
  _fitCam.lookAt(_centre);
  _fitCam.updateMatrixWorld(true);
  _inv.copy(_fitCam.matrixWorld).invert();

  _tmp.copy(_centre).applyMatrix4(_inv);
  // Snap the centre to whole texels. Without this the shadow edges swim by up
  // to one texel per frame as the camera moves, which at this sun angle is a
  // very visible crawl along every long shadow.
  const snappedX = Math.round(_tmp.x / texel) * texel;
  const snappedY = Math.round(_tmp.y / texel) * texel;
  const dx = snappedX - _tmp.x;
  const dy = snappedY - _tmp.y;

  const cam = light.shadow.camera;
  cam.left = -radius + dx;
  cam.right = radius + dx;
  cam.bottom = -radius + dy;
  cam.top = radius + dy;
  cam.near = 0.5;
  cam.far = back + radius + 2;
  cam.updateProjectionMatrix();

  light.position.copy(_lightPos);
  light.target.position.copy(_centre);
  light.target.updateMatrixWorld();

  return texel;
}
