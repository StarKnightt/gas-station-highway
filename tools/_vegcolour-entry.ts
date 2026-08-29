/**
 * CPU-only dump of the horizon geometry's vertex colours.
 *
 * Written because two successive large cuts to the band colours moved the
 * rendered pixels by 0.2 of a display level. A parameter change that does not
 * move pixels is either not reaching the geometry or not reaching the shader,
 * and this settles which: it reads the actual `color` attribute off the merged
 * geometry that the runtime builds.
 */
import { buildDistantLandscape } from "../src/gen/vegDistant";
import { HORIZON_BANDS } from "../src/gen/vegHorizonBands";
import * as THREE from "three";

export function dump() {
  const geo = buildDistantLandscape({
    sunDirection: new THREE.Vector3(-0.62, 0.108, 0.777).normalize(),
    baseY: -12,
    hazeColour: [0.30, 0.34, 0.44],
    bands: HORIZON_BANDS,
  });
  const col = geo.getAttribute("color");
  const pos = geo.getAttribute("position");
  const out: {
    band: number;
    authored: number[];
    topMean: number[];
    baseMean: number[];
    topLumaSpread: number;
  }[] = [];

  let v = 0;
  for (let b = 0; b < HORIZON_BANDS.length; b++) {
    const n = HORIZON_BANDS[b].samples ?? 1024;
    const top = [0, 0, 0];
    const base = [0, 0, 0];
    let lmin = Infinity;
    let lmax = -Infinity;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 2; k++) {
        const j = v + i * 2 + k;
        const c = [col.getX(j), col.getY(j), col.getZ(j)];
        const tgt = pos.getY(j) > -1 ? top : base;
        tgt[0] += c[0];
        tgt[1] += c[1];
        tgt[2] += c[2];
        if (pos.getY(j) > -1) {
          const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          lmin = Math.min(lmin, l);
          lmax = Math.max(lmax, l);
        }
      }
    }
    out.push({
      band: b,
      authored: HORIZON_BANDS[b].colour as unknown as number[],
      topMean: top.map((x) => x / n),
      baseMean: base.map((x) => x / n),
      topLumaSpread: lmax / Math.max(lmin, 1e-6),
    });
    v += n * 2;
  }
  return { vertices: col.count, bands: out };
}
