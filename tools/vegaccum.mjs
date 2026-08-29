/**
 * Probe Terrain's `groundAccum` at Vegetation's own plant sites.
 *
 * A wrapper rather than a bare entry because standing `VegetationSystem` up on
 * the CPU reaches `BuildingSystem`, which reads `location.search` at init and
 * throws in Node. Same browser-global shim as `vegscale.mjs`; kept minimal, and
 * deliberately not a `typeof window` branch inside shipping code, because a
 * branch the capture never takes is a branch nothing tests.
 */
import { build } from "vite";
import { rmSync } from "node:fs";

globalThis.location ??= { search: "", href: "http://localhost/" };
globalThis.window ??= globalThis;
const noop = () => {};
const ctx2d = () =>
  new Proxy(
    {
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null,
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      canvas: null,
    },
    { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? noop : undefined), set: () => true }
  );
const canvas = (w = 256, h = 256) => ({
  width: w,
  height: h,
  style: {},
  setAttribute: noop,
  appendChild: noop,
  getContext: () => ctx2d(),
  toDataURL: () => "",
});
globalThis.document ??= {
  body: { appendChild: noop },
  createElement: (tag) => (tag === "canvas" ? canvas() : { style: {}, setAttribute: noop, appendChild: noop }),
};
globalThis.OffscreenCanvas ??= class {
  constructor(w, h) {
    Object.assign(this, canvas(w, h));
  }
};

process.env.VEGCPU_ONLY = "vegaccum";
await build({ configFile: "tools/vegcpu.vite.config.mjs" });
await import("../.shot-build/cpu/vegaccum.mjs");
rmSync(".shot-build/cpu", { recursive: true, force: true });
