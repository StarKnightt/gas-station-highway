/**
 * partscale — how big is every trim part, in pixels, in a given capture pose?
 *
 *   node --import ./tools/extresolve.mjs tools/partscale.mjs side_sun
 *   node --import ./tools/extresolve.mjs tools/partscale.mjs --all
 *
 * ---------------------------------------------------------------------------
 * SHARED TOOLING. The car half is the entry point; the rest generalises.
 * ---------------------------------------------------------------------------
 *
 * The third coordinate-free probe in this tree, after Building's
 * `probe-zeroscan` and `probe-unseen`, and a direct copy of the architecture
 * Vegetation established in `tools/vegscale.mjs`. Adopting it needs two things
 * and only the second is work: publish a per-part manifest from the builder
 * that merges, then swap the few lines that stand that builder up.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * An independent reviewer listed what the car lacked: no door mirrors, no
 * wipers, no badge, no trim strips. Every one of those already existed and was
 * drawing pixels. The mirror, for instance, was mounted 117 mm above the
 * beltline, so its housing was silhouetted against the dark side glass and read
 * as a tan box taped to the window — present, drawn, illegible.
 *
 * Nothing in the toolchain could have contradicted that report, because
 * `buildTrim` merges about thirty small parts into four meshes by material.
 * `probe-unseen` can only say `car-trim-black` draws pixels. **A merge is an
 * information barrier exactly where the small parts live**, and small parts are
 * most of what makes a shape read as a manufactured object rather than a
 * maquette.
 *
 * So the question this answers is not "is the part there" — `probe-unseen`
 * does absence. It is **"is the part big enough to be seen"**, which is the
 * axis the remaining work is actually on, and it answers it for every part at
 * once rather than for whichever one somebody thought to check.
 *
 * ---------------------------------------------------------------------------
 * WHY IT TAKES A SHOT NAME AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * Same reason as `vegscale`, and the same reason a ranking beat an absolute
 * measurement on the paint tonight: a probe that takes coordinates can be
 * accused of choosing its region, and a probe that ranks everything surfaces
 * faults nobody went looking for. The poses are imported from `shootcar.mjs`
 * rather than copied — a probe with its own idea of the camera confidently
 * answers a question nobody asked.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, AND WHAT IT CANNOT SEE
 * ---------------------------------------------------------------------------
 *
 * Apparent size in pixels of each part's projected bounding box, its share of
 * the frame, and its true size beside it. Sorted ascending, so the least
 * legible part is at the top: that is the reading order for legibility work.
 *
 * It cannot see contrast. A part can be 40 px across and invisible because it
 * is the same value as what is behind it — which is precisely what happened to
 * the beltline chrome strip. Size is necessary and not sufficient, so treat a
 * high rank as "worth looking at", not as "fine".
 *
 * It also cannot see occlusion: this projects bounding boxes, it does not
 * rasterise. A part hidden behind bodywork still gets a size. `probe-unseen`
 * is the tool for that, and the two together cover it.
 *
 * Pure computation against the real geometry and the real capture pose - no
 * servers, no browsers, nothing to tear down.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

const ROOT = path.resolve(import.meta.dirname, "..");
const parts = await import(pathToFileURL(path.join(ROOT, "src/gen/carParts.ts")).href);
const bodyMod = await import(pathToFileURL(path.join(ROOT, "src/gen/carBody.ts")).href);

// The poses, read out of the capture harness rather than restated here.
const shootSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(path.join(ROOT, "tools/shootcar.mjs"), "utf8")
);
const POSES = {};
for (const m of shootSrc.matchAll(
  /^\s{2}([a-z_]+):\s*\{\s*local:\s*true,\s*pos:\s*\[([^\]]+)\],\s*look:\s*\[([^\]]+)\],\s*fov:\s*([\d.]+)\s*\}/gm
)) {
  POSES[m[1]] = {
    pos: m[2].split(",").map(Number),
    look: m[3].split(",").map(Number),
    fov: Number(m[4]),
  };
}
if (!Object.keys(POSES).length) {
  console.error("partscale: could not read poses out of tools/shootcar.mjs - has its POSES table changed shape?");
  process.exit(2);
}

const argv = process.argv.slice(2);
const ALL = argv.includes("--all");
const RELIEF = argv.includes("--relief");
const WINDING = argv.includes("--winding");
const WIDTH = 1600;
const HEIGHT = 900;
const wanted = ALL ? Object.keys(POSES) : argv.filter((a) => !a.startsWith("--"));
if (!wanted.length && !RELIEF && !WINDING) {
  console.error(`usage: node --import ./tools/extresolve.mjs tools/partscale.mjs <pose|--all|--relief|--winding>`);
  console.error(`poses: ${Object.keys(POSES).join(", ")}`);
  process.exit(2);
}
for (const w of wanted) {
  if (!POSES[w]) {
    console.error(`partscale: unknown pose "${w}". known: ${Object.keys(POSES).join(", ")}`);
    process.exit(2);
  }
}

// The shell must exist before the trim: `endZ` projects parts onto the real
// front and tail caps and raises rather than substituting a plausible fallback
// if they are not built. Poses are `local: true`, i.e. already in car space,
// so no world transform is needed and no scene has to be stood up.
const shell = bodyMod.buildCarShell();
shell.body.computeBoundingBox();
const carBox = shell.body.boundingBox.clone();

const trim = parts.buildTrim();
if (!trim.parts?.length) {
  console.error("partscale: buildTrim published no `parts`; cannot identify fittings inside merged geometry.");
  process.exit(1);
}

/**
 * `--relief`: can this part cast or catch anything at all?
 *
 * The size ranking says the beltline strip is 732 px long, 47% of the car's
 * width, and nobody can see it. Colour will not fix that, and neither will
 * making it bigger, because **what makes a real trim strip visible is not its
 * own albedo but the pair of lines it creates** - a shadow along one edge and a
 * highlight along the other. A strip with no relief produces neither, whatever
 * it is made of.
 *
 * `wall` - the fraction of the part's area whose normal points more than 60 deg
 * away from the part's mean normal, i.e. **does this part have sides at all**.
 * This is the measurement that convicts a ribbon. `flankStrip` builds a surface
 * *offset from* the flank, not a solid: two rows of vertices displaced a few
 * millimetres outward, with no end walls. Every triangle therefore faces the
 * same way the door faces, the part shades identically to the door, and it is
 * invisible by construction at any albedo. `wall` = 0 means relief = 0 means no
 * shadow line and no highlight line, and there is no material fix.
 *
 * `relief` - for parts that do have walls, the 90th-percentile extent of a wall
 * triangle along the mean normal: how far the part stands proud. Measured
 * **per triangle**, never from a bounding box.
 *
 * `shadow` - relief / tan(6.2 deg), the length of the shadow the part throws
 * onto its own parent at the corrected sun elevation. This is Terrain's slope
 * test in the form that suits sheet metal: rather than compare a ratio against
 * a threshold, state the shadow in millimetres and let it be judged against the
 * part's own size. A 3 mm step throws 28 mm at this elevation, which is a line
 * the eye will find; a 0 mm step throws nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `slope` COLUMN
 * ---------------------------------------------------------------------------
 *
 * The obvious form of the test is relief / half-width, and the obvious source
 * for both is the part's bounding box. That is wrong here and the first version
 * of this code shipped the wrong answer confidently: the beltline strip follows
 * the beltline, which rises along the car, so its bounding box reports 85 mm of
 * "height" for an 18 mm face and 95 mm of "relief" for a 3 mm offset - the box
 * is measuring the path, not the section. `carproud.mjs` was deleted from this
 * tree for exactly that class of error, being right about flat plates and wrong
 * about every curved strip, so every quantity above is either per-triangle or
 * an area fraction, and cross-sections are not read off boxes at all.
 *
 * None of this needs a capture, which is the point: all 41 parts can be ranked
 * while the renderer is unavailable.
 */
const SUN_TAN = Math.tan((6.2 * Math.PI) / 180);
const WALL_DEG = 60;
function reliefOf(geo) {
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const tris = [];
  const mean = new THREE.Vector3();
  let area = 0;
  const g = (k) => {
    const j = idx ? idx.getX(k) : k;
    return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
  };
  for (let i = 0; i + 2 < n; i += 3) {
    const a = g(i), b = g(i + 1), c = g(i + 2);
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    const w = cross.length() * 0.5;
    if (!(w > 0) || !Number.isFinite(w)) continue;
    const u = cross.clone().normalize();
    tris.push({ u, w, a, b, c });
    mean.addScaledVector(u, w);
    area += w;
  }
  if (!tris.length || area <= 0) return null;
  if (mean.lengthSq() < 1e-12) {
    // A closed solid cancels to nothing. Genuine relief, nothing to diagnose.
    return { wall: 1, relief: null, closed: true };
  }
  mean.normalize();
  /**
   * `tilt`: how far this part's mean normal points away from the direction the
   * panel underneath it points.
   *
   * `wall` below is a per-part measurement and therefore blind to an assembly.
   * The beltline trim is a proud face plus an upper and a lower return - three
   * single-surface strips, each of which is a ribbon on its own, which together
   * form exactly the walled section a ribbon lacks. The arch lip is built the
   * same way, an outer flare plus a return face. So `wall = 0` does not by
   * itself convict a part; it convicts a part that is *also* aligned with its
   * parent.
   *
   * The alignment is the decisive half and it needs no grouping and no parent
   * geometry. A body panel's normal points radially outward from the body's core;
   * take the horizontal direction from the car's central axis out to the part's
   * centre and that is, to within the flank's own curvature, where the panel
   * faces. A face parallel to the door reads a few degrees. A return reads tens
   * of degrees, and tens of degrees is a different shade under any light.
   *
   * Approximate by construction - it does not know the true panel normal - but
   * the quantity it is used for is the *contrast* between a coplanar band and a
   * turned return, and that gap is far larger than the approximation.
   */
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  const outward = new THREE.Vector3(c.x, 0, c.z);
  const tilt =
    outward.lengthSq() < 1e-8
      ? null
      : (Math.acos(THREE.MathUtils.clamp(Math.abs(mean.dot(outward.normalize())), 0, 1)) * 180) / Math.PI;
  let wallArea = 0;
  const reliefs = [];
  const cosLim = Math.cos((WALL_DEG * Math.PI) / 180);
  for (const t of tris) {
    if (Math.abs(t.u.dot(mean)) > cosLim) continue;
    wallArea += t.w;
    // Extent of this one triangle along the mean normal: the local step height,
    // immune to whatever path the part follows.
    const h = [t.a, t.b, t.c].map((v) => v.dot(mean));
    reliefs.push({ h: Math.max(...h) - Math.min(...h), w: t.w });
  }
  const wall = wallArea / area;
  if (!reliefs.length) return { wall: 0, relief: 0, tilt };
  reliefs.sort((x, y) => x.h - y.h);
  let acc = 0;
  let relief = reliefs[reliefs.length - 1].h;
  for (const r of reliefs) {
    acc += r.w;
    if (acc >= wallArea * 0.9) {
      relief = r.h;
      break;
    }
  }
  return { wall, relief, tilt };
}

/**
 * `--winding`: is every exterior part facing outward?
 *
 * Copied from the assertion Canopy wrote in `tools/probe-canopy.mjs`, which
 * caught a fascia sweep wound inside out before any capture of it existed. The
 * reason this needs asserting at all is the nastiest property of the bug:
 * **back-face culling makes a reversed surface invisible rather than wrong.**
 * There is no artefact to notice, no dark patch, no z-fighting. The part is
 * simply absent, and absence is the defect class this project loses the most
 * time to. Four dark parts in this car's nose were reversed for weeks.
 *
 * Canopy tests a hand-picked band of triangles against an expected direction.
 * The manifest allows the stronger form: **assert the sign for every part at
 * once, with no region chosen by anybody.** An exterior body part's outward
 * face must point away from the body's core, so take the horizontal direction
 * from the car's central axis out to the part and require the area-weighted mean
 * geometric normal to have a positive component along it.
 *
 * Closed solids cancel to a mean of zero by construction and are skipped - they
 * cannot be judged this way and `probe-unseen` covers them from six axes.
 *
 * This is what verifies a merged part without a render. `probe-unseen` sees only
 * `car-trim-chrome`, so it cannot tell whether one of the three beltline leaves
 * inside that merge is reversed; this can, because it reads the leaf geometry
 * before the merge happens.
 */
if (WINDING) {
  console.log("");
  console.log("=== winding   every exterior part's outward face must point away from the core");
  console.log("    (a reversed surface is culled and therefore invisible, not visibly wrong)");
  console.log("");
  let bad = 0;
  let skipped = 0;
  let checked = 0;
  const rows = [];
  for (const { name, geo } of trim.parts) {
    const pos = geo.getAttribute("position");
    const idx = geo.getIndex();
    const n = idx ? idx.count : pos.count;
    const get = (k) => {
      const j = idx ? idx.getX(k) : k;
      return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
    };
    const mean = new THREE.Vector3();
    let area = 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = get(i), b = get(i + 1), c = get(i + 2);
      const cr = b.clone().sub(a).cross(c.clone().sub(a));
      const w = cr.length() * 0.5;
      if (!(w > 0) || !Number.isFinite(w)) continue;
      mean.addScaledVector(cr.normalize(), w);
      area += w;
    }
    if (!(area > 0)) {
      console.log(`  ?     ${name.padEnd(24)} no positive-area triangles`);
      bad++;
      continue;
    }
    // A mean well short of unit length means the faces cancel: a closed solid.
    const openness = mean.length() / area;
    mean.divideScalar(area);
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    const outward = new THREE.Vector3(c.x, 0, c.z);
    if (openness < 0.25 || outward.lengthSq() < 1e-8) {
      skipped++;
      continue;
    }
    const dot = mean.dot(outward.normalize()) / Math.max(1e-9, mean.length());
    checked++;
    rows.push({ name, dot });
    if (dot < -0.1) bad++;
  }
  rows.sort((a, b) => a.dot - b.dot);
  for (const r of rows) {
    const flag = r.dot < -0.1 ? "FAIL" : r.dot < 0.1 ? "edge" : "ok  ";
    console.log(`  ${flag}  ${r.name.padEnd(24)} outward dot ${r.dot.toFixed(3).padStart(7)}`);
  }
  console.log("");
  console.log(`${checked} open parts checked, ${skipped} closed solids skipped, ${bad} failed.`);
  console.log("");
  console.log("`edge` is not a failure. A part whose outward face is nearly vertical -");
  console.log("a chamfer, a return, a soffit - has little horizontal component and sits");
  console.log("near zero legitimately. Only a clearly negative dot means the surface is");
  console.log("facing into the body, which means it is culled, which means it is gone.");
  console.log("");
  process.exit(bad ? 1 : 0);
}

if (RELIEF) {
  const rows = [];
  for (const { name, geo } of trim.parts) {
    const r = reliefOf(geo);
    rows.push(r ? { name, ...r } : { name, bad: true });
  }
  console.log("");
  console.log(`=== relief test   sun elevation 6.2 deg, tan = ${SUN_TAN.toFixed(3)}`);
  console.log(`    shadow thrown onto the parent surface = relief / ${SUN_TAN.toFixed(3)} = relief x ${(1 / SUN_TAN).toFixed(1)}`);
  console.log("");
  console.log("  part                    wall   relief  shadow   tilt   verdict");
  console.log("                          area     (mm)    (mm)    deg");
  /**
   * Which face parts have a companion wall part built for them?
   *
   * THE UNIT OF MEASUREMENT HAS TO MATCH THE UNIT OF CONSTRUCTION. This tool
   * judges named parts, and the fix for a coplanar face is very often a SECOND
   * named part - `beltline-strip` gains `beltline-strip-skirt`, `intake-divider`
   * gains `intake-divider-wall`. Judged individually the face still reports 0%
   * wall area and the skirt reports almost nothing but wall, so a correctly
   * fixed assembly reads as two defects instead of zero.
   *
   * That is not a cosmetic reporting issue. It sends the next reader to re-fix
   * parts that are already fixed, and it hides the handful that genuinely are
   * not - which was exactly the state of this output after twelve ribbons had
   * been repaired: 30 COPLANAR lines of which 5 were real.
   */
  const WALL_SUFFIXES = ["-skirt", "-wall", "-vane", "-band"];
  const walled = new Set();
  for (const r of rows) {
    for (const suf of WALL_SUFFIXES) {
      if (r.name.endsWith(suf)) walled.add(r.name.slice(0, -suf.length));
    }
  }
  const isWallPart = (n) => WALL_SUFFIXES.some((s) => n.endsWith(s));
  const sorted = rows.sort((a, b) => (a.wall ?? 9) - (b.wall ?? 9));
  for (const r of sorted) {
    if (r.bad) {
      console.log(`  ${r.name.padEnd(22)}  no positive-area triangles`);
      continue;
    }
    if (r.closed) {
      console.log(`  ${r.name.padEnd(22)}  closed solid - has relief by construction`);
      continue;
    }
    const shadow = r.relief / SUN_TAN;
    const paired = walled.has(r.name);
    const flat = r.wall <= 0 && (r.tilt === null || r.tilt < 12) && !paired;
    // The back of a cavity is coplanar BY FUNCTION. A grille backing exists to be
    // an unbroken dark field behind the slats; giving it relief would be a defect,
    // not a fix. Reported rather than hidden, because a tool that silently exempts
    // parts by name is one rename away from passing a real one.
    const isBacking = /-backing$/.test(r.name);
    const verdict = isBacking && r.wall <= 0
      ? "BACKING - coplanar by function, not a defect"
      : paired && r.wall <= 0
      ? "flat face, but a wall part is built for it - assembly OK"
      : isWallPart(r.name) && r.wall > 0
        ? "wall part - this is another part's relief"
        : flat
      ? "COPLANAR - no sides, aligned with its parent"
      : r.wall <= 0
        ? "turned " + r.tilt.toFixed(0) + " deg - shades apart from its parent"
        : shadow < 4
          ? "shadow under 4 mm, will not read"
          : "throws a line";
    console.log(
      `  ${r.name.padEnd(22)} ${(r.wall * 100).toFixed(1).padStart(5)}% ` +
        `${(r.relief * 1000).toFixed(1).padStart(7)} ${(shadow * 1000).toFixed(0).padStart(7)} ` +
        `${(r.tilt === null ? "-" : r.tilt.toFixed(0)).padStart(6)}   ${verdict}`
    );
  }
  const ribbons = sorted.filter(
    (r) =>
      r.wall === 0 &&
      (r.tilt === null || r.tilt < 12) &&
      !walled.has(r.name) &&
      !/-backing$/.test(r.name)
  );
  console.log("");
  console.log(`${ribbons.length} of ${rows.length} parts are coplanar: no sides, and aligned with the panel they sit on.`);
  console.log("");
  console.log("COPLANAR is the fatal verdict and no material can fix it. The part is a");
  console.log("surface offset from its parent with no walls, so every one of its normals");
  console.log("points where the parent's normals point and it shades identically to the");
  console.log("panel it sits on. A trim strip is visible because of the shadow at one");
  console.log("edge and the highlight at the other, and a strip with no edges has");
  console.log("neither. These need geometry, not colour, and not size.");
  console.log("");
  process.exit(0);
}

for (const poseName of wanted) {
  const p = POSES[poseName];
  const cam = new THREE.PerspectiveCamera(p.fov, WIDTH / HEIGHT, 0.1, 200);
  cam.position.set(p.pos[0], p.pos[1], p.pos[2]);
  cam.lookAt(p.look[0], p.look[1], p.look[2]);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  /** Projected pixel extent of a box, and whether any corner is in frame. */
  const project = (box) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anyInFront = false;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z
      );
      const view = v.clone().applyMatrix4(cam.matrixWorldInverse);
      if (view.z < -0.05) anyInFront = true;
      const ndc = v.clone().project(cam);
      minX = Math.min(minX, ndc.x); maxX = Math.max(maxX, ndc.x);
      minY = Math.min(minY, ndc.y); maxY = Math.max(maxY, ndc.y);
    }
    if (!anyInFront) return null;
    return {
      w: ((maxX - minX) / 2) * WIDTH,
      h: ((maxY - minY) / 2) * HEIGHT,
      onScreen: maxX > -1.1 && minX < 1.1 && maxY > -1.1 && minY < 1.1,
    };
  };

  const carProj = project(carBox);
  const rows = [];
  for (const { name, geo } of trim.parts) {
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    if (!b || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) {
      rows.push({ name, bad: "no finite bounding box" });
      continue;
    }
    const pr = project(b);
    const trueSize = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    if (!pr) {
      rows.push({ name, behind: true, trueSize });
      continue;
    }
    rows.push({
      name,
      px: Math.max(pr.w, pr.h),
      w: pr.w,
      h: pr.h,
      onScreen: pr.onScreen,
      trueSize,
    });
  }

  console.log("");
  console.log(`=== ${poseName}  (${WIDTH}x${HEIGHT}, fov ${p.fov})`);
  console.log(`    whole car projects ${carProj ? carProj.w.toFixed(0) : "?"} x ${carProj ? carProj.h.toFixed(0) : "?"} px`);
  console.log("");
  console.log("  part                     px (max)    w x h px     true mm   % of car   note");
  const sortable = rows.filter((r) => r.px !== undefined).sort((a, b) => a.px - b.px);
  for (const r of sortable) {
    const pctCar = carProj ? (100 * r.px) / Math.max(carProj.w, carProj.h) : 0;
    const note = !r.onScreen ? "off-frame" : r.px < 6 ? "SUB-6px - cannot read" : r.px < 14 ? "small" : "";
    console.log(
      `  ${r.name.padEnd(24)} ${r.px.toFixed(1).padStart(8)}  ` +
        `${r.w.toFixed(0).padStart(4)} x ${r.h.toFixed(0).padEnd(4)} ` +
        `${(r.trueSize * 1000).toFixed(0).padStart(8)}  ${pctCar.toFixed(2).padStart(7)}   ${note}`
    );
  }
  for (const r of rows.filter((x) => x.behind)) console.log(`  ${r.name.padEnd(24)}   behind the camera`);
  for (const r of rows.filter((x) => x.bad)) console.log(`  ${r.name.padEnd(24)}   ${r.bad}`);
}
console.log("");
console.log("Ascending, so the least legible part is first. Size is necessary and");
console.log("not sufficient: this cannot see contrast, and the beltline strip was");
console.log("invisible at a perfectly adequate pixel size because it matched what");
console.log("was behind it. Nor can it see occlusion - use probe-unseen for that.");
console.log("");
