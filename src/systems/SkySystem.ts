/**
 * @deprecated Superseded by System 4.
 *
 * The placeholder sun, sky dome, PMREM environment and fog that used to live
 * here are now owned by `LightingSystem`, which publishes the same
 * `sunDirection` and `sunLight` services and is registered in its place in
 * `main.ts`. This alias exists so nothing that still imports `SkySystem` ends
 * up adding a second sun to the scene.
 */
export { LightingSystem as SkySystem } from "./LightingSystem";
