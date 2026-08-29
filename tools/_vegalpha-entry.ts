/**
 * Bundle entry for tools/vegalpha.mjs. Exposes the procedural foliage textures
 * and the card quad's UV range to a plain Node process, with no renderer.
 */
import { makePineShoot, makeScrubCard } from "../src/gen/vegTextures";
import { foliageCardGeometry } from "../src/gen/vegPine";

export const cards = {
  "pine-live": makePineShoot(512, 5001, false),
  "pine-dead": makePineShoot(512, 5157, true),
  "scrub-grass": makeScrubCard(256, 6001, "grass"),
  "scrub-weed": makeScrubCard(256, 6101, "weed"),
};

const g = foliageCardGeometry(3);
const uv = g.getAttribute("uv");
let uMin = Infinity;
let uMax = -Infinity;
let vMin = Infinity;
let vMax = -Infinity;
for (let i = 0; i < uv.count; i++) {
  uMin = Math.min(uMin, uv.getX(i));
  uMax = Math.max(uMax, uv.getX(i));
  vMin = Math.min(vMin, uv.getY(i));
  vMax = Math.max(vMax, uv.getY(i));
}
export const cardUv = { uMin, uMax, vMin, vMax, verts: uv.count, tris: (g.getIndex()?.count ?? 0) / 3 };
