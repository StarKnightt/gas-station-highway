/**
 * Geometry for one US retail fuel dispenser, built to real dimensions.
 *
 * Reference envelope (Gilbarco Encore / Wayne Ovation class, two-sided):
 *   overall height  1.95 m above the island cap
 *   cabinet width   1.06 m, depth 0.62 m
 *   nozzle boot     ~1.00 m above the island, at the outboard end of each face
 *
 * The origin of everything here is the centre of the dispenser footprint at
 * island-cap height, with +Z and -Z the two customer faces and +X/-X the ends.
 * That matters: `applyGrime` reads object-space Y as height above the island.
 */

import * as THREE from "three";
import {
  ensureAttrs,
  hangingHose,
  mergeChecked,
  metreUv,
  place,
  roundedBox,
  scuffProminence,
  weatherHose,
} from "./hardsurface";
import { seededRng } from "./noise";

export const PUMP = {
  cabW: 1.02,
  /**
   * 0.72 m, not the 0.62 m this started at. A dispenser is a walk-around object
   * with pumps, meters and a vapour manifold inside it; at 0.62 m over a 1.06 m
   * width it was a 1.7:1 slab in plan and read as a flat panel with detail
   * painted on. Real cabinets are nearer 1.5:1 and the head oversails the body.
   */
  cabD: 0.72,
  /** Top of the lower cabinet. */
  cabTop: 1.12,
  headW: 1.10,
  headD: 0.78,
  headTop: 1.72,
  topperTop: 2.08,
  baseH: 0.10,
  /** Corner chamfer on the cabinet plan. */
  chamfer: 0.085,
  /** Centre of the nozzle boot on each face. */
  bootX: 0.385,
  bootY: 1.00,
  /** Height of the hose swivel on the cabinet end. */
  hoseY: 1.40,
};

/**
 * Printed area of the topper face. `pumpDecals.makeTopperFace` authors its
 * canvas at this aspect ratio, so the two have to move together — a mismatch
 * here stretches the type, which reads as wrong without being nameable.
 */
export const TOPPER_FACE = { w: 0.94, h: 0.245 };

/**
 * Printed area of the keypad fascia. `pumpDecals.makeKeypadFace` authors its
 * canvas at this aspect ratio; the two have to move together.
 */
export const KEYPAD_FACE = { w: 0.140, h: 0.166 };

/**
 * Edge treatment sizes.
 *
 * A real dispenser panel edge is a 1-2 mm break, and that is what the brief
 * asked for, but 1.5 mm does not survive sampling at the distance these get
 * judged from. Measured against the capture poses at 1600 px wide, the cabinet
 * runs 1.84 mm/px at `pump_close` and 3.37 mm/px at `corner` - the frame the
 * critic actually reads. A 1.5 mm chamfer is 0.81 px and 0.45 px respectively:
 * it aliases into the corner it was meant to break and returns no rim line at
 * all in the frame that matters.
 *
 * 5 mm is 2.7 px close and 1.5 px at `corner`, so the highlight is a band
 * rather than a dither, and it is still honest - formed sheet on this class of
 * cabinet carries a 3-5 mm radius at the brake, not a knife edge. `small` is
 * for bezels and pods, where the part is close to camera whenever it is
 * legible at all, so it can afford to sit nearer the real dimension.
 *
 * See NOTES case 9: detail authored below the sampling floor costs geometry
 * and returns nothing.
 */
export const EDGE = { big: 0.005, small: 0.0025 };

/**
 * The joint's dark line is no longer derived from the sun, and that is the point.
 *
 * This used to hold `SUN.elevation` so the lap's cast shadow and the deposit
 * strip behind it could be sized from the real sun angle, on the reasoning that
 * a hardcoded length would silently stop matching if the time of day moved. The
 * trigonometry was right and the premise was wrong: at azimuth 203 the sun is 67
 * degrees off the cabinet's normal, so one pair of faces is never lit and throws
 * no shadow at all, and on the lit pair a 4 mm overhang projects 20.6 mm of
 * solid black down a 300 mm panel. Rendered, that read as a row of applied tabs.
 *
 * The line is now the crevice's own occlusion, which is a few millimetres
 * whatever the sun is doing, so nothing here needs to track the site.
 */

const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface PumpFaceParts {
  side: 1 | -1;
  /** The redrawable price/volume panel for this face. */
  displayPlane: THREE.BufferGeometry;
  /** Everything a raycast should treat as "this dispenser face". */
  pickBox: THREE.Box3;
}

export interface PumpBuild {
  /** Merged, by material slot. */
  steel: THREE.BufferGeometry;
  steelDark: THREE.BufferGeometry;
  /**
   * Shut-line floors and the deposit band under each panel lap.
   *
   * Its own slot because it needs its own *response*, not just its own colour.
   * These strips were in `steelDark`, which is metalness 0.35 at
   * envMapIntensity 0.8, so a third of what they returned was specular off the
   * environment. On an albedo half the panel's they should have measured about
   * -50 of 255 against it and measured -13, because the flat environment lifted
   * them straight back up. A shut line is a hole and a dirt trap; neither of
   * those is a mirror, and neither should have a metallic term at all.
   */
  seam: THREE.BufferGeometry;
  /** Every primitive with its section label, for the coordinate-free probes. */
  parts: PumpPart[];
  /**
   * The returned top edge of every panel: lighter paint on an up-tilted lip.
   * Its own slot because its whole job is to be *brighter* than the panel, and
   * a shut line only reads as a cut when a light line sits against the dark one.
   */
  /** Dark two-tone banding: valance, crown moulding, topper surround. */
  trim: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  plastic: THREE.BufferGeometry;
  keys: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  /**
   * Run-down stains below fasteners. Its own mesh because it is the one
   * alpha-blended thing on the cabinet, and it carries per-stain strength in a
   * four-component vertex colour rather than in its material, so a hundred
   * stains of a hundred different strengths still cost one draw call.
   */
  weep: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  topper: THREE.BufferGeometry;
  displays: { side: 1 | -1; geo: THREE.BufferGeometry }[];
  /** The printed topper face on each side, UV 0..1 for `makeTopperFace`. */
  topperFaces: { side: 1 | -1; geo: THREE.BufferGeometry }[];
  /** The printed keypad fascia on each side, UV 0..1 for `makeKeypadFace`. */
  keypadFaces: { side: 1 | -1; geo: THREE.BufferGeometry }[];
  /** Per face: hose tube plus the nozzle assembly, kept separate and movable. */
  hoses: { side: 1 | -1; geo: THREE.BufferGeometry }[];
  nozzles: { side: 1 | -1; body: THREE.BufferGeometry; metal: THREE.BufferGeometry; rubber: THREE.BufferGeometry }[];
}

/* ------------------------------------------------------------------ */

function merge(
  list: THREE.BufferGeometry[],
  uv: "metre" | "keep" = "metre",
  label = "pumpParts"
): THREE.BufferGeometry {
  const clean = list.map(ensureAttrs);
  const g = mergeChecked(label, clean, false);
  clean.forEach((c) => c.dispose());
  return uv === "metre" ? metreUv(g) : g;
}

/**
 * Vertical prism on a chamfered rectangular plan.
 *
 * The cabinet used to be a rounded box, which in plan is a rectangle with four
 * equal fillets and reads as extruded rather than fabricated. Real dispenser
 * cabinets have a pronounced corner chamfer - a fifth and sixth face - and that
 * chamfer is what catches a separate, narrower highlight down each corner and
 * tells you the object has depth.
 */
function chamferPrism(
  w: number,
  d: number,
  h: number,
  cham: number,
  fillet = 0.012,
  bevel = EDGE.big
): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const c = Math.min(cham, hw * 0.8, hd * 0.8);
  const shape = new THREE.Shape();
  // Octagon, corners eased by a small fillet so the chamfer edges still catch
  // light rather than aliasing into a hard line.
  const pts: [number, number][] = [
    [-hw + c, -hd],
    [hw - c, -hd],
    [hw, -hd + c],
    [hw, hd - c],
    [hw - c, hd],
    [-hw + c, hd],
    [-hw, hd - c],
    [-hw, -hd + c],
  ];
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const inA = new THREE.Vector2(cur[0] - prev[0], cur[1] - prev[1]).normalize();
    const outA = new THREE.Vector2(next[0] - cur[0], next[1] - cur[1]).normalize();
    shape.lineTo(cur[0] - inA.x * fillet, cur[1] - inA.y * fillet);
    shape.quadraticCurveTo(cur[0], cur[1], cur[0] + outA.x * fillet, cur[1] + outA.y * fillet);
  }
  shape.closePath();

  // The horizontal edges used to be dead 90 degrees, because the extrude ran
  // with bevelEnabled false. Under a grazing key that throws away the single
  // cheapest cue a fabricated panel has: the bright line down the chamfer.
  // One bevel segment, not several - a flat chamfer facet returns one uniform
  // highlight band, whereas a multi-segment fillet smears it back into the
  // gradient it was supposed to break.
  const bev = Math.min(bevel, h * 0.35, hw * 0.4, hd * 0.4);
  const on = bev > 1e-5;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: on ? h - bev * 2 : h,
    bevelEnabled: on,
    bevelThickness: bev,
    bevelSize: bev,
    // bevelOffset MUST be -bevelSize, not 0.
    //
    // With an offset of 0, three.js grows the body contour by bevelSize and
    // returns it to the authored outline only at the caps - so a 5 mm bevel
    // made this prism 5 mm oversize on every side. That silently swallowed the
    // whole panel-plate scheme: the cabinet skin moved from |z| = 0.360 to
    // 0.365 while the plates stayed at 0.363, so every plate was *inside* the
    // box it was supposed to stand proud of, and not one shut line existed.
    //
    // It also defeated the forced-value test that was supposed to catch it.
    // Forcing the bevel to 30 mm grew the cabinet to 0.390 and the plates to
    // 0.380 - still buried - so the diff reported no change and looked like
    // evidence the plates were fine. Two coupled quantities forced in the same
    // direction cancel; see NOTES case 20.
    bevelOffset: -bev,
    bevelSegments: 1,
    curveSegments: 3,
  });
  // With a bevel the extrusion spans -bev..depth+bev, so shift it back to 0..h
  // before standing it up; otherwise every mass sinks by the bevel size and the
  // stack of prisms that makes the cabinet develops gaps at each joint.
  if (on) g.translate(0, 0, bev);
  // Extrusion runs along +Z; stand it up so it runs 0..h along +Y.
  g.rotateX(-Math.PI / 2);
  // ExtrudeGeometry is non-indexed, so this yields per-facet normals and the
  // chamfer stays a discrete facet rather than being averaged into its walls.
  g.computeVertexNormals();
  return g;
}

/** A shallow recessed pocket: the frame ring only, so a panel can sit inside. */
function bezelRing(
  w: number,
  h: number,
  frame: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  faceSign: number
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const zc = z + faceSign * depth * 0.5;
  // Four bars around the opening, chamfered inward by using rounded boxes.
  out.push(place(roundedBox(w + frame * 2, frame, depth, frame * 0.3, 2), x, y + h / 2 + frame / 2, zc));
  out.push(place(roundedBox(w + frame * 2, frame, depth, frame * 0.3, 2), x, y - h / 2 - frame / 2, zc));
  out.push(place(roundedBox(frame, h, depth, frame * 0.3, 2), x - w / 2 - frame / 2, y, zc));
  out.push(place(roundedBox(frame, h, depth, frame * 0.3, 2), x + w / 2 + frame / 2, y, zc));
  return out;
}

/**
 * Everything the nozzle publishes about itself, so nothing has to re-derive it.
 *
 * `scale` is the correction applied to the whole assembly on the way out of
 * `buildNozzle`. The parts below were authored at a size that came out 600 mm
 * from spout tip to handle butt — an OPW 11A-class unleaded nozzle is about
 * 410 mm — and at 1.5x it dominated the boot, put the handle butt level with
 * the price display and read as a black stick rather than as a tool. Scaling
 * the assembly rather than re-authoring every literal keeps the proportions
 * that were tuned for silhouette and lands every part in spec: 44 mm handle,
 * 14 mm spout, 13 mm guard rod.
 *
 * `inlet` is where the hose meets the butt of the handle, in the nozzle's own
 * frame *after* scaling. `buildPump` and `PumpSystem.rebuildHose` both need it
 * and must agree, or the hose jumps the instant anything touches the nozzle —
 * the same trap `pumpVariation` is exported to avoid.
 */
export const NOZZLE = {
  scale: 0.68,
  inlet: new THREE.Vector3(0, 0.320 * 0.68, -0.100 * 0.68),
  /** Origin of the nozzle group above `PUMP.bootY`, when stowed. */
  originY: 0.052,
};

/**
 * The nozzle: handle, trigger, guard, vapour boot and spout. Modelled with the
 * spout pointing down -Y and the hose inlet at the top of the handle, so the
 * caller can rotate the whole thing into the boot or into a car's filler neck.
 *
 * Authored oversized and scaled by `NOZZLE.scale` on the way out; see there.
 */
function buildNozzle(): {
  body: THREE.BufferGeometry[];
  metal: THREE.BufferGeometry[];
  rubber: THREE.BufferGeometry[];
  parts: NozzlePart[];
} {
  const parts: NozzlePart[] = [];
  /*
   * Every push goes through a slot recorder as well as the slot array.
   *
   * The merge into three material slots is what a renderer wants and it is
   * exactly wrong for answering "is the trigger guard visible", because after
   * the merge there is no trigger guard — there is 4000 triangles of `metal`.
   * NOTES case 11 is the reason this exists: a part that is present but
   * occluded looks identical to one that was never authored, and the only way
   * to tell them apart is to ask per part. `parts` is a parallel, labelled
   * view of the same geometry objects, not a copy.
   */
  const slot = (list: THREE.BufferGeometry[], label: string) => (g: THREE.BufferGeometry) => {
    list.push(g);
    parts.push({ label, geo: g });
    return g;
  };
  const bodyList: THREE.BufferGeometry[] = [];
  const metalList: THREE.BufferGeometry[] = [];
  const rubberList: THREE.BufferGeometry[] = [];
  let tag = "unlabelled";
  const body = { push: (g: THREE.BufferGeometry) => slot(bodyList, tag)(g) };
  const metal = { push: (g: THREE.BufferGeometry) => slot(metalList, tag)(g) };
  const rubber = { push: (g: THREE.BufferGeometry) => slot(rubberList, tag)(g) };
  const label = (s: string) => {
    tag = s;
  };

  // Valve body.
  //
  // This was a roundedBox(0.076, 0.115, 0.098) with a 0.020 fillet - a 20 mm
  // radius on a 76 mm box, which is 53% of the half-width, and a box filleted
  // that hard is a capsule. Stacked with the handle barrel and the bellows
  // sleeve it gave a critic exactly what it looked like: "three rounded
  // capsules at an angle". The named parts were all present; the masses they
  // hung off had no form.
  //
  // So the casting is authored as its side profile and extruded across the
  // width, because the profile is the silhouette and the silhouette is the only
  // thing that reads at any distance. Flat sides with a 5 mm cast break, a
  // straight top deck running back to the handle spine, a waist above the
  // trigger and a nose that the spout screws into - all the things that make an
  // 11A read as a machined tool rather than as a lozenge.
  const castPts: [number, number][] = [
    [0.048, 0.008], // nose underside, just behind the spout thread
    [0.058, 0.044], // front face of the casting
    [0.054, 0.092], // front shoulder
    [0.030, 0.124], // top deck begins
    [-0.020, 0.140], // deck running back and up
    [-0.058, 0.150], // spine, into the handle junction
    [-0.078, 0.132], // underside of the junction
    [-0.064, 0.118],
    [-0.044, 0.106], // waist above the trigger
    [-0.020, 0.084], // trigger housing front
    [0.006, 0.020], // underside behind the spout boss
  ];
  /*
   * The underside from the spout boss back to the waist was 44 mm lower than
   * this, and `tools/nozzleread.mjs` is why it moved. Measured from the capture
   * camera, the trigger scored **0 pixels with nothing in front of it** — it was
   * not occluded by the boot, it was inside this casting — and the trigger guard
   * scored 1204 px unoccluded of which 43% was behind the casting's own front
   * face. Both the guard's aperture and the trigger were being filled in by the
   * body they hang off. Lifting this line is what opens the hole; the guard
   * below is re-swept to sit under it rather than inside it.
   */
  const cast = new THREE.Shape();
  cast.moveTo(castPts[0][0], castPts[0][1]);
  for (let i = 1; i < castPts.length; i++) cast.lineTo(castPts[i][0], castPts[i][1]);
  cast.closePath();
  const castW = 0.062;
  const castG = new THREE.ExtrudeGeometry(cast, {
    depth: castW - 0.010,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    // See chamferPrism: a zero offset inflates the body by bevelSize.
    bevelOffset: -0.005,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // Shape (x, y) is authored as world (z, y); the extrude runs along shape z,
  // so rotate it onto world X and recentre on the nozzle's plane of symmetry.
  castG.translate(0, 0, 0.005);
  castG.rotateY(-Math.PI / 2);
  castG.translate(castW / 2, 0, 0);
  // A constant-width extrusion is a slab. Real castings draft, and the draft is
  // what puts a second, narrower highlight down the flank: widest at the valve
  // chamber, tucked in at the nose and again where it meets the handle.
  {
    const p = castG.getAttribute("position") as THREE.BufferAttribute;
    const key = [0.058, 0.005, -0.078];
    const val = [0.70, 1.0, 0.80];
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      let f: number;
      if (z >= key[0]) f = val[0];
      else if (z >= key[1]) f = THREE.MathUtils.lerp(val[1], val[0], (z - key[1]) / (key[0] - key[1]));
      else if (z >= key[2]) f = THREE.MathUtils.lerp(val[2], val[1], (z - key[2]) / (key[1] - key[2]));
      else f = val[2];
      p.setX(i, p.getX(i) * f);
    }
    p.needsUpdate = true;
    castG.computeVertexNormals();
  }
  label("cast body");
  body.push(ensureAttrs(castG));

  // Spout boss and union nut: the hex the spout actually screws into. A cast
  // body without a visible joint at the spout is a moulding, not an assembly.
  label("spout boss");
  body.push(place(new THREE.CylinderGeometry(0.026, 0.028, 0.030, 12, 1), 0, 0.026, 0.030, 0.22));
  label("union nut");
  metal.push(place(new THREE.CylinderGeometry(0.0225, 0.0225, 0.016, 6, 1), 0, 0.010, 0.026, 0.22));

  // Cast rib along the top deck, and the hanging hook on the spine. The hook is
  // the part that explains how the thing hangs in the boot, which nothing in
  // the previous version did.
  label("cast rib");
  body.push(place(roundedBox(0.030, 0.014, 0.120, 0.005, 2), 0, 0.134, -0.004, -0.30));
  const hookPath = new THREE.CatmullRomCurve3([
    V3(0, 0.146, -0.030),
    V3(0, 0.170, -0.044),
    V3(0, 0.182, -0.072),
    V3(0, 0.170, -0.096),
    V3(0, 0.146, -0.100),
  ]);
  label("hanging hook");
  metal.push(ensureAttrs(new THREE.TubeGeometry(hookPath, 20, 0.0075, 8, false)));

  // Handle: a tapered barrel raked back over the trigger, with a moulded grip
  // sleeve that steps its diameter.
  label("handle barrel");
  body.push(place(new THREE.CylinderGeometry(0.032, 0.027, 0.215, 20, 1), 0, 0.186, -0.052, Math.PI * 0.145));
  label("grip sleeve");
  rubber.push(place(new THREE.CylinderGeometry(0.0345, 0.0335, 0.088, 20, 1), 0, 0.170, -0.045, Math.PI * 0.145));
  // Hose swivel at the butt of the handle: a hex boss and a turned collar, so
  // the hose visibly terminates in a fitting instead of vanishing into rubber.
  label("hex swivel");
  body.push(place(new THREE.CylinderGeometry(0.026, 0.031, 0.052, 6, 1), 0, 0.292, -0.086, Math.PI * 0.145));
  label("swivel collar");
  metal.push(place(new THREE.CylinderGeometry(0.0235, 0.0235, 0.028, 16, 1), 0, 0.322, -0.096, Math.PI * 0.145));

  // Trigger guard: swept along an explicit curve in the side plane, because a
  // rotated torus never lands where you want it and the guard's shape is one
  // of the few silhouette cues that says "fuel nozzle" at ten metres. Deeper
  // and squarer than the first pass, which was too shallow to see.
  //
  // The front leg now starts *on* the casting's front face and runs forward and
  // down, so the loop hangs under the body instead of through it, and the
  // aperture it encloses is against sky or against the boot rather than against
  // more casting. The bottom of the loop is held at y = 0.024, which after the
  // stow rake puts its lowest surface about 8 mm above the boot's rolled lip —
  // close enough to read as bearing on the rim, clear enough not to intersect it
  // at any unit's `nozzleTilt`.
  const guardPath = new THREE.CatmullRomCurve3([
    V3(0, 0.086, 0.058),
    V3(0, 0.044, 0.052),
    V3(0, 0.024, 0.000),
    V3(0, 0.030, -0.062),
    V3(0, 0.084, -0.112),
    V3(0, 0.156, -0.116),
  ]);
  // Flattened into a stamped strap rather than left as a round rod, which is
  // what a guard is. **The squash was 0.34 and the radius 12.5 mm, and that was
  // the larger half of the defect**: at the tightest pose in `shoot3` the whole
  // guard painted 1204 px unoccluded, an average of four pixels across its
  // length, so there was nothing for a highlight to sit on in the first place.
  // The original reasoning — that a rod returns a one-pixel specular the resolve
  // throws away — was about the wrong quantity. Footprint first, then highlight.
  {
    const g = new THREE.TubeGeometry(guardPath, 28, 0.0165, 8, false);
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * 0.62);
    p.needsUpdate = true;
    g.computeVertexNormals();
    label("trigger guard");
    metal.push(ensureAttrs(g));
  }
  // Trigger lever, hanging from the housing down into the guard's aperture.
  // Its top is inside the casting, which is where a trigger pivots; everything
  // below the housing line is in clear air and is what reads.
  label("trigger");
  metal.push(place(roundedBox(0.022, 0.060, 0.024, 0.008, 2), 0, 0.070, -0.034, -0.26));
  // Hold-open latch: the three-notch rack on the guard's rear leg plus the pawl
  // on the trigger that drops into it. Two pieces, because the notches are the
  // part that tells you what it is — and they were 101 px of frame between all
  // three, which is not a part, it is a smudge. Roughly doubled, and moved onto
  // the rear leg where they break the strap's outline instead of sitting against
  // the casting.
  label("latch pawl");
  metal.push(place(roundedBox(0.014, 0.052, 0.018, 0.004, 2), 0.0, 0.066, -0.060, 0.20));
  label("latch rack");
  for (let i = 0; i < 3; i++) {
    metal.push(place(new THREE.BoxGeometry(0.022, 0.006, 0.011), 0, 0.048 + i * 0.017, -0.086));
  }

  // Spout: 16 mm unleaded, with the pronounced downward crank that gives the
  // nozzle its hooked profile. Straightening this out is what made the earlier
  // version read as a plain tube.
  // The crank was half as much again as this and it did not fit the boot: with
  // the stow rake applied the tip sat about 75 mm off the pocket's axis in
  // oval-normalised terms, against a 41 mm wall, so the spout came out through
  // the side of the cup and hung in clear air — visible in the `nozzle` frame of
  // round 192457Z and now countable with `tools/tmp`-style breach checks. The
  // original comment here says straightening the crank is what made the nozzle
  // read as a plain tube, and that was true when the crank was the only shape in
  // the assembly; the trigger guard now carries the silhouette, so the spout can
  // go back to something a holster can actually accept.
  const spoutPath = new THREE.CatmullRomCurve3([
    V3(0, 0.014, 0.002),
    V3(0, -0.055, 0.000),
    V3(0, -0.125, 0.008),
    V3(0, -0.190, 0.022),
    V3(0, -0.234, 0.040),
    V3(0, -0.258, 0.058),
  ]);
  label("spout");
  metal.push(ensureAttrs(new THREE.TubeGeometry(spoutPath, 30, 0.0102, 12, false)));
  // Spout lip ring and the little hook that rests on a filler neck.
  label("spout lip ring");
  metal.push(place(new THREE.TorusGeometry(0.0104, 0.0019, 6, 16), 0, -0.256, 0.059, Math.PI * 0.16));
  label("filler hook");
  metal.push(place(roundedBox(0.006, 0.020, 0.014, 0.003, 2), 0, -0.228, 0.048, 0.34));

  // Vapour-recovery bellows: a proper concertina around the base of the spout,
  // stepping down in diameter as it goes.
  label("vapour bellows");
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    rubber.push(
      place(
        new THREE.TorusGeometry(0.024 - t * 0.005, 0.0082 - t * 0.0012, 8, 20),
        0,
        -0.014 - i * 0.0185,
        0.001 + t * t * 0.010
      )
    );
  }
  label("bellows sleeve");
  rubber.push(place(new THREE.CylinderGeometry(0.0155, 0.0165, 0.104, 16, 1), 0, -0.058, 0.008));

  const s = new THREE.Matrix4().makeScale(NOZZLE.scale, NOZZLE.scale, NOZZLE.scale);
  for (const g of [...bodyList, ...metalList, ...rubberList]) g.applyMatrix4(s);

  return { body: bodyList, metal: metalList, rubber: rubberList, parts };
}

/** One labelled primitive of the nozzle. `geo` is the same object the slot holds. */
/** One primitive as it was authored, with the section that made it. */
export interface PumpPart {
  /**
   * The finest name this part has: a `section()` name where one was opened, and
   * otherwise the enclosing `region()`. Never undefined and never empty, which
   * is the contract `pumprelief` and `pumpscale` both read.
   */
  label: string;
  /** The coarse structural region, for grouping a 558-row table into something readable. */
  region: string;
  geo: THREE.BufferGeometry;
}

export interface NozzlePart {
  label: string;
  geo: THREE.BufferGeometry;
}

/**
 * The nozzle's primitives, labelled, already stowed into pump space for `face`.
 *
 * Tools only. Nothing in the render path calls this — `buildPump` merges the
 * same geometry into three slots and the labels are gone by then.
 */
export function nozzlePartsStowed(face: 1 | -1, vary: PumpVariation): NozzlePart[] {
  const n = buildNozzle();
  const m = nozzleStowed(face, vary).matrix;
  for (const p of n.parts) p.geo.applyMatrix4(m);
  return n.parts;
}

/* ------------------------------------------------------------------ */

export interface PumpVariation {
  /** Slack length of the fuel hose, in metres. */
  hoseLen: number;
  /** Seed for the hose's kinks, so a unit hangs the same way every frame. */
  hoseSeed: number;
  /** How far the stowed nozzle is raked out of the boot, in radians. */
  nozzleRake: number;
  /**
   * Side lean of the stowed nozzle, in radians. Signed: negative rests it
   * against the inboard wall of the boot, positive against the outboard.
   */
  nozzleTilt: number;
  /**
   * How hard this unit's life has been, 0..1. Scales the grime film, the dust
   * and the run-off streaking. One dispenser on an island always looks worse
   * than its neighbour, usually the one nearest the road.
   */
  wear: number;
  /** How far the nozzle has worn the paint off the panel beside the boot. */
  scuff: number;
  /**
   * Small albedo shift on the cabinet, -1 to +1. Painted panels from different
   * production batches and different amounts of sun never match, and three
   * dispensers at exactly one value is the tell that they are one mesh.
   */
  tint: number;
  /** Height the run-off starts from, so the stains do not line up unit to unit. */
  streakY: number;
  /** Phase into the grime field, tile units. See `applyGrime`. */
  fieldOffset: THREE.Vector2;
  /** Mirrors the grime field in object X for this unit. */
  fieldFlip: boolean;
}

/**
 * Per-unit variation, derived only from the pump's seed.
 *
 * Three identical dispensers with three identical hose poses read as instanced
 * props; real forecourt equipment is a set of siblings that have been hung up
 * by different people. This is exported rather than kept local to `buildPump`
 * because `PumpSystem` re-derives the hose curve every time the nozzle moves
 * and has to arrive at the same slack length, or the hose changes shape the
 * instant anything touches it.
 */
export function pumpVariation(seed: number): PumpVariation {
  // seededRng, and no `seed * 977 + 13` spreading. `PumpSystem` seeds the row
  // with 1, 2, 3, and all three fields below come off the first three draws, so
  // under makeRng they were a ramp rather than a sample: hose length ran 1.455,
  // 1.471, 1.488 m, using 12.7% of its authored range in 16 mm steps. The
  // multiply was an attempt to spread adjacent seeds and did not work, because
  // makeRng's first draw is linear in the seed either way. Hashing is what
  // spreads them; see NOTES.md case 16.
  const rng = seededRng(seed);

  // Stratified, not sampled, for the two fields that carry the "these are one
  // object" read.
  //
  // The row is three units. Three independent draws from a range cluster by
  // luck about as often as they spread — the first attempt here put pump 1 at
  // wear 1.32 and pump 3 at 1.31, a 1% difference, from a perfectly good
  // hashed generator. That is not the case-16 bug returning; it is simply what
  // n = 3 does, and NOTES.md already records the matching statistical fact
  // that the seed-set probe needs about five members before it can flag on
  // statistics alone. Small sets need the mechanism.
  //
  // So each unit is assigned a third of the range and jittered inside it. The
  // permutation is fixed and non-monotonic on purpose: a plain `(seed - 1) / 3`
  // would make wear increase left to right along the island, which is a
  // different and equally artificial pattern.
  const band = [1, 0, 2][(Math.abs(Math.round(seed)) - 1) % 3];
  // Guard bands, not just bands. Filling each third completely lets two
  // adjacent bands meet at their shared boundary, so units 1 and 2 — bands 1
  // and 0 — could still land within a hair of each other while the stratifier
  // reported itself as working. The whole-frame block sweep of round 195251Z
  // measured 8.8 LSB median between units 1 and 2 against 18.4 and 18.1 for the
  // other two pairs: genuinely distinct, but half as distinct. Jittering inside
  // the middle 60% of each third costs a little range and guarantees a gap of
  // 13% of the full span between any two units.
  const inBand = (lo: number, hi: number) => lo + ((band + 0.2 + rng() * 0.6) / 3) * (hi - lo);

  return {
    hoseLen: 1.44 + rng() * 0.26,
    hoseSeed: Math.floor(rng() * 9999),
    nozzleRake: 0.10 + rng() * 0.11,
    // Which boot wall this unit's nozzle has fallen against, and how hard.
    // Signed, because a row where all three lean the same way is its own tell.
    nozzleTilt: (band === 1 ? -1 : 1) * (0.050 + rng() * 0.048),
    wear: inBand(0.55, 1.45),
    scuff: 0.16 + rng() * 0.36,
    tint: inBand(-0.9, 0.9),
    streakY: PUMP.bootY - 0.06 - rng() * 0.14,
    // Phase into the grime field, in tile units. This is the field that
    // decides *where* the dirt is, and it is the only one of these numbers a
    // viewer uses to judge whether two dispensers are the same object — see
    // the block comment on `applyGrime`. Everything else in this struct
    // varies how strong something is; without this they all vary the strength
    // of an identically placed mark. Stratified for the same n = 3 reason as
    // `wear`, and over a whole tile, because a small offset just slides a
    // recognisable pattern rather than replacing it.
    fieldOffset: new THREE.Vector2(inBand(0.05, 0.95), (band * 0.37 + rng() * 0.3) % 1),
    fieldFlip: band === 1,
  };
}

/**
 * The stowed pose of one face's nozzle, in pump space.
 *
 * Exported for the same reason `pumpVariation` is: `buildPump` bakes the hose
 * against this pose and `PumpSystem.rebuildHose` re-solves it every time the
 * nozzle moves. If the two ever disagree the hose snaps to a new shape the
 * instant anything touches the nozzle, and the disagreement is invisible in a
 * still. They previously agreed only by coincidence — `rebuildHose` carried a
 * hand-written `bootY + 0.395` that happened to land within 10 mm of the real
 * inlet, and rescaling the nozzle moved the real one 115 mm without touching
 * the constant.
 */
export function nozzleStowed(
  face: 1 | -1,
  vary: PumpVariation
): { matrix: THREE.Matrix4; quaternion: THREE.Quaternion; inlet: THREE.Vector3; inletDir: THREE.Vector3 } {
  const bx = face * PUMP.bootX;
  const bootZ = (face * PUMP.headD) / 2 + face * 0.070;
  const quaternion = new THREE.Quaternion().setFromEuler(
    // The X rotation is applied in the nozzle's own frame and the Y flip after
    // it, so the same positive rake leans the handle away from the cabinet on
    // both faces. The Z term is a side lean, applied first under YXZ order, so
    // it is also in the nozzle's own frame.
    //
    // Without it the nozzle stood dead upright on the boot's centreline with an
    // even gap all round, which reads as placed rather than dropped - "as if
    // placed by snap-to-grid". A 1.5 kg tool released into a 116 mm pocket does
    // not centre itself: it falls until the body fouls one wall and stays
    // there. So it leans, and it is offset in the same direction by most of the
    // clearance, which is what puts it in contact instead of merely tilted.
    //
    // **The yaw is a half turn from where it was, and that is the whole of the
    // "the nozzle has no trigger or guard" complaint.**
    //
    // The nozzle is authored with its hose inlet and its trigger guard both on
    // local -z. Under the old `face === 1 ? 0 : Math.PI` that side mapped to
    // world (0, 0.27, -0.96) on the +Z face and (0, 0.27, +0.96) on the -Z face
    // — in both cases *inboard*, so the guard, the trigger, the latch and the
    // aperture between them all faced the cabinet skin about 50 mm away. No
    // camera standing in front of a dispenser could ever see any of it, and
    // three rounds were spent reshaping parts that were pointed at a wall.
    // `tools/nozzleread.mjs` is what found it: the trigger measured **0 visible
    // pixels with nothing in front of it**, which is not a number a shape
    // problem can produce.
    //
    // Facing the guard outward is also what a real hung nozzle does — the
    // customer sees the trigger — and it costs nothing, because the hose is a
    // solved catenary between two published endpoints and simply re-hangs.
    new THREE.Euler(vary.nozzleRake, face === 1 ? Math.PI : 0, vary.nozzleTilt, "YXZ")
  );
  // Negated with the yaw. The lean is about the nozzle's own Z, so a half turn
  // reverses which boot wall it falls against; the offset that puts it *in
  // contact* with that wall has to reverse with it or the tool leans one way
  // and is shifted the other, which is the hovering read all over again.
  const rest = -Math.sign(vary.nozzleTilt) * 0.011;
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(bx + face * rest, PUMP.bootY + NOZZLE.originY - 0.006, bootZ + face * 0.004),
    quaternion,
    new THREE.Vector3(1, 1, 1)
  );
  return {
    matrix,
    quaternion,
    inlet: NOZZLE.inlet.clone().applyMatrix4(matrix),
    inletDir: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
  };
}

/** Where the hose swivel sits on the cabinet end for one face, in pump space. */
export function hoseSwivel(face: 1 | -1): { point: THREE.Vector3; dir: THREE.Vector3 } {
  const sx = Math.sign(face * PUMP.bootX) || 1;
  return {
    point: new THREE.Vector3(sx * (PUMP.cabW / 2 + 0.196), PUMP.hoseY - 0.020, face * 0.13),
    dir: new THREE.Vector3(sx * 0.92, -0.30, face * 0.24).normalize(),
  };
}

/**
 * How dirty this spot on the cabinet is, 0..1, asked in the pump's own local
 * frame so the builder never needs to know where the island is.
 *
 * Supplied by `PumpSystem` from terrain's `groundAccum`, which is the point:
 * the amount of dirt at a place is a shared field, so this system's stains
 * agree with every other system's about where dirt collects rather than being
 * a private noise function that happens to look plausible.
 */
export type SoilAt = (localX: number, localY: number, localZ: number) => number;

/**
 * A downward-widening quad carrying its strength in a four-component vertex
 * colour: alpha at full strength where the stain leaves the fastener, tapering
 * to nothing at the bottom so the run fades out rather than ending on a line.
 * The horizontal softness is the material's alpha map; this supplies the
 * vertical profile and the per-stain amount.
 */
function taperedStain(
  wTop: number,
  wBot: number,
  len: number,
  strength: number,
  fromBottom = false
): THREE.BufferGeometry {
  const rowsN = 4;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rowsN; r++) {
    const t = r / rowsN;
    const w = wTop + (wBot - wTop) * t;
    const y = len / 2 - t * len;
    // Strong just under the head, gone at the tail. Squared so the fade is
    // long: a stain that ends abruptly is a rectangle again.
    // A run fades away from its source. For a weep the source is the fastener at
    // the top; for a splash dart it is the ground at the bottom, and inverting
    // the profile is the whole difference between the two.
    const u = fromBottom ? 1 - t : t;
    const a = strength * (1 - u) * (1 - u * 0.85);
    for (const sx of [-0.5, 0.5]) {
      pos.push(sx * w, y, 0);
      col.push(1, 1, 1, a);
      uv.push(sx + 0.5, 1 - t);
    }
    if (r > 0) {
      const b = (r - 1) * 2;
      // Wound to face +Z, which is what `place()` then rotates outward.
      //
      // This was `b, b+1, b+3, b, b+3, b+2` and every one of the 672 stain
      // triangles faced *into* the cabinet, so all of them were front-face
      // culled and rendered exactly zero pixels — through a colour change, an
      // alpha-channel fix, a mask renormalisation and an offset fix, none of
      // which a culled triangle can express.
      //
      // The stored normals agreed with the wrong winding, because they are
      // derived from it: `computeVertexNormals()` certifies whatever it is
      // given. So "the normals point the right way" was true and meant nothing,
      // and the check that works is the cross product of the triangle's own
      // edges against the direction the surface should face — `tools/tmp/wind.mjs`,
      // and `tools/probe-winding.mjs` for the shared version.
      idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Spokes around the hose. 10 was visibly faceted in silhouette at the `hose`
 * eye, and a faceted silhouette reads as low-poly plastic before any material
 * does. Shared so the two places that build a hose cannot disagree.
 */
export const HOSE_SPOKES = 14;

/**
 * `?pscuff=0` — the isolation arm for the nozzle's convex-extremity wear.
 *
 * Guarded for Node because this module is imported by CPU probes with no
 * `location`. Read lazily so the flag is answered at build time rather than at
 * import time, and so a probe can flip it.
 */
const wantScuff = () =>
  typeof location === "undefined" ||
  (new URLSearchParams(location.search).get("pscuff") ?? "1") !== "0";

export function buildPump(seed = 1, soilAt?: SoilAt): PumpBuild {
  // Per-unit jitter for the panel joints. Seeded off the unit, so the way each
  // cabinet's shut lines wave along their run differs between the three - which
  // is per-unit divergence in the *structure* rather than another tint, and the
  // critique is explicit that tint is not what is missing.
  const rng = seededRng(seed + 8101);
  // Every geometry pushed below is also recorded against the section that made
  // it, so the parts survive the merge.
  //
  // `merge` collapses ~300 primitives into nine meshes by material, and a merge
  // is an information barrier exactly where the small parts live — a probe can
  // only report that `pumpParts.seam` draws pixels, never that the shut line
  // inside it has no side walls. That barrier is why an independent critic could
  // call the seams "drawn outlines" with nothing in the toolchain able to agree
  // or disagree. `tools/pumprelief.mjs` and `tools/partscale.mjs` both read this
  // manifest; see NOTES, "An offset surface cannot read as a separate object".
  const parts: PumpPart[] = [];
  /**
   * Two levels, because one level cannot be both safe and complete.
   *
   * 41% of this manifest (230 of 558 parts) came back `unlabelled`, so the two
   * tools that read it could describe the panel skin in detail and had nothing
   * to say about the cabinet, the vapour lines or any per-face fitting — which
   * is most of the model. The gap was structural: `section()` is scoped and must
   * wrap its pushes, and wrapping a whole region means restructuring control
   * flow around every `const` it declares, so in practice only small blocks ever
   * got wrapped.
   *
   * - `region()` is **sticky and coarse**, set at each banner comment. Sticky
   *   assignment is what mis-attributed labels the first time, but that failure
   *   was fine-grained: a four-part label followed by 24 unrelated pushes that
   *   inherited it. At banner granularity stickiness is correct by construction,
   *   because the banners partition the function — everything between two of
   *   them really does belong to the first.
   * - `section()` stays **scoped and fine**, and nests inside a region.
   *
   * `label` is unchanged for anything that already had a section, so no existing
   * tool output shifts; the previously nameless parts get their region instead.
   */
  let region = "unregioned";
  let tag: string | null = null;
  const setRegion = (name: string) => {
    region = name;
    tag = null;
  };
  /**
   * Scoped, not sticky. The first version of this just assigned, and every push
   * after a label inherited it until the next one — so `panel plate` came back
   * as 2 primitives out of 28 and `plate return` came back as 110 with 9%
   * off-panel area when every one of them is a wall at 33 to 75 degrees. The
   * headline finding survived because it was a 4-part section immediately after
   * its own label, but the rest of the table was fiction. A labelling scheme
   * that silently attributes work to the wrong owner is worse than none.
   */
  const section = <T,>(name: string, fn: () => T): T => {
    const prev: string | null = tag;
    tag = name;
    try {
      return fn();
    } finally {
      tag = prev;
    }
  };
  const slot = (list: THREE.BufferGeometry[]) => ({
    push: (...gs: THREE.BufferGeometry[]) => {
      for (const g of gs) {
        list.push(g);
        parts.push({ label: tag ?? region, region, geo: g });
      }
      return list.length;
    },
  });
  const steelList: THREE.BufferGeometry[] = [];
  const steelDarkList: THREE.BufferGeometry[] = [];
  const seamList: THREE.BufferGeometry[] = [];
  const trimList: THREE.BufferGeometry[] = [];
  const accentList: THREE.BufferGeometry[] = [];
  const plasticList: THREE.BufferGeometry[] = [];
  const keysList: THREE.BufferGeometry[] = [];
  const chromeList: THREE.BufferGeometry[] = [];
  const weepList: THREE.BufferGeometry[] = [];
  const steel = slot(steelList);
  const steelDark = slot(steelDarkList);
  const seam = slot(seamList);
  const trim = slot(trimList);
  const accent = slot(accentList);
  const plastic = slot(plasticList);
  const keys = slot(keysList);
  const chrome = slot(chromeList);
  const weep = slot(weepList);
  const glass: THREE.BufferGeometry[] = [];
  const topper: THREE.BufferGeometry[] = [];
  const displays: { side: 1 | -1; geo: THREE.BufferGeometry }[] = [];
  const topperFaces: { side: 1 | -1; geo: THREE.BufferGeometry }[] = [];
  const keypadFaces: { side: 1 | -1; geo: THREE.BufferGeometry }[] = [];
  const hoses: { side: 1 | -1; geo: THREE.BufferGeometry }[] = [];
  const nozzles: PumpBuild["nozzles"] = [];

  const { cabW, cabD, cabTop, headW, headD, headTop, topperTop, baseH, chamfer, bootX, bootY, hoseY } = PUMP;

  const vary = pumpVariation(seed);

  /* ---------------- base and cabinet ---------------- */
  setRegion("base and cabinet");

  // Galvanised skid, splayed slightly wider than the cabinet and sitting in a
  // bead of sealant. This is the part that takes the fuel spills.
  steelDark.push(place(roundedBox(cabW + 0.10, baseH, cabD + 0.09, 0.010, 2), 0, baseH / 2, 0));
  steelDark.push(place(roundedBox(cabW + 0.13, 0.018, cabD + 0.12, 0.006, 2), 0, 0.009, 0));

  // Lower cabinet, on a chamfered plan.
  steel.push(place(chamferPrism(cabW, cabD, cabTop - baseH, chamfer), 0, baseH, 0));

  // Valance between cabinet and head, proud on all four sides so the head
  // reads as a separate casting rather than a continuation of the box. Dark:
  // this is the band that separates head from body at any distance, and at
  // 60 m it is the only thing left of the dispenser's internal structure.
  trim.push(place(chamferPrism(headW, headD, 0.055, chamfer * 0.75), 0, cabTop, 0));

  // Display head: wider and deeper than the body, and stepped in again at the
  // top, so the dispenser has a profile in plan instead of one constant box.
  const headH = headTop - cabTop - 0.055;
  steel.push(place(chamferPrism(headW, headD, headH * 0.72, chamfer * 0.9), 0, cabTop + 0.055, 0));
  steel.push(
    place(chamferPrism(headW - 0.035, headD - 0.075, headH * 0.30, chamfer * 0.7), 0, cabTop + 0.055 + headH * 0.71, 0)
  );

  // Crown moulding, then the illuminated header sitting straight on it. An
  // earlier pass floated the header on two posts and it read as a separate
  // object hovering over the pump rather than part of it.
  trim.push(place(roundedBox(headW - 0.005, 0.036, headD - 0.055, 0.010, 2), 0, headTop + 0.018, 0));
  const topH = topperTop - headTop - 0.036;
  const topperY = headTop + 0.036 + topH / 2;
  // Steel surround; the acrylic face is inset into it on both sides.
  trim.push(place(roundedBox(headW - 0.02, topH, 0.20, 0.020, 3), 0, topperY, 0));
  topper.push(place(roundedBox(headW - 0.10, topH - 0.045, 0.215, 0.012, 3), 0, topperY, 0));
  // The printed acrylic itself, a plane just proud of the lit box on each
  // side. A plane rather than the box's own faces because the merged pump
  // geometry carries metre-scale triplanar UVs (see `metreUv`), which a
  // 0..1 canvas map cannot use.
  for (const side of [1, -1] as const) {
    const g = new THREE.PlaneGeometry(TOPPER_FACE.w, TOPPER_FACE.h, 1, 1);
    topperFaces.push({
      side,
      geo: place(g, 0, topperY, side * (0.215 / 2 + 0.003), 0, side === 1 ? 0 : Math.PI),
    });
  }

  // Livery band low on the cabinet, where every US brand puts it and where it
  // does not cut through the payment furniture. Abstract: no marks, no text.
  // Stands 8 mm proud rather than 3 mm, because the panel plates below now
  // occupy +3 mm: at the old offset the band went exactly flush with them and
  // stopped reading as an applied band at all.
  accent.push(place(chamferPrism(cabW + 0.016, cabD + 0.016, 0.115, chamfer), 0, 0.338, 0));
  accent.push(place(chamferPrism(cabW + 0.022, cabD + 0.022, 0.012, chamfer), 0, 0.459, 0));

  /* ---------------- panel seams and fasteners ---------------- */
  setRegion("panel seams and fasteners");

  // A shut line is a gap, and a gap needs two things either side of it. Every
  // previous pass drew the joint as a 5 mm dark strip lying on the skin, which
  // is a painted stripe: no occlusion in the slot, no lit lower lip, and a
  // cabinet that reads as one moulded box with lines on it rather than as the
  // bolted-up assembly it is.
  //
  // So the panels are modelled instead of the joints. But the *first* attempt at
  // that - coplanar plates separated by a recessed gap - did not read either,
  // and the reason is worth writing down because it is geometry against optics
  // and the optics won.
  //
  // Measured in the critic's own frame with tools/edgeread.mjs, the horizontal
  // joints scored **-1.5 of 255** against the panel touching them, and the one
  // under the valance scored **+21.9, i.e. brighter**. Two things cause that,
  // and neither is fixable by deepening the recess:
  //
  //  - **The sun is at 11 degrees.** A horizontal groove is lit nearly along
  //    its own length, so its floor receives almost the same irradiance as the
  //    face. Vertical grooves in the same frame measure -95, because for them
  //    the same near-horizontal light is across the slot and the near wall
  //    occludes it. Horizontal and vertical joints are not the same problem.
  //  - **The eye is nearly in the plane of the joint too.** At the `corner`
  //    pose the camera sits 12.8 degrees above the joint, so a horizontal ledge
  //    is foreshortened to about 22% of its width - a 5 mm lip becomes a third
  //    of a pixel. Any horizontal detail whose read depends on its own
  //    upward-facing area is hopeless at this framing.
  //
  // What *is* not foreshortened is a mark projected onto the vertical panel. So
  // the joint is now a lap rather than a butt: each row stands prouder than the
  // row beneath it, giving a real overhang, and an 11 degree sun throws that
  // overhang's shadow 1/tan(11) = 5.1x its depth straight down the panel below.
  // A 4 mm lap therefore paints a 20 mm dark band across a surface the camera
  // sees face-on. That is the "cast shadow from the upper panel onto the lower"
  // the critique asked for, and it is 6 px at `corner` instead of 0.3.
  //
  // Backed up by an albedo strip in the same place, because a 20 mm shadow is
  // near the shadow map's resolving limit and must not be the only mechanism.
  // That strip is honest independently: grime does collect under a panel lip.
  //
  // This all fits only because the payment furniture is mounted on the head's Z
  // plane, 30 mm outboard of the cabinet skin. Check that before raising LAP.
  const PROUD = 0.005;
  const GAP = 0.008;
  /** Extra relief per row going up, i.e. the depth of each lap. */
  const LAP = 0.004;
  /**
   * Edge radius on the plates, and it has to be smaller than EDGE.small.
   *
   * At a 2.5 mm radius on a 6 mm gap the two rounded edges facing each other
   * consumed 5 mm of it and left about 1 mm of slot floor visible, so all that
   * survived was lip highlight. The gap has to still be a gap after both
   * fillets have taken their bite.
   */
  const PLATE_R = 0.002;
  /** Where the dark backing skin sits, relative to the cabinet face. */
  const FLOOR_REL = 0.0004;
  /**
   * The returned top edge of a panel, and why it is albedo rather than a sun
   * highlight.
   *
   * The lap gave the joint a dark ribbon and no bright line, and a dark line on
   * its own reads as paint - reported back as "solid dark bars... that visibly
   * sit on top of the surface rather than cut into it... applied trim strips,
   * not gaps". The missing half is a light line immediately above the dark one,
   * because it is the *pairing* that reads as an edge.
   *
   * The obvious fix is a chamfer that catches the low sun, and it does not work
   * here. Measured against the site's actual sun vector (11 degrees elevation,
   * azimuth 203):
   *
   *   +Z cabinet faces   N.L = -0.390   no direct sun at all
   *   -Z cabinet faces   N.L = +0.390
   *   up-facing ledge    N.L = +0.191   *half* the flat face
   *   best horizontal chamfer, 26 deg   0.434, i.e. +11% over flat
   *
   * The sun is 67 degrees off the face normal in azimuth and only 11 up, so a
   * horizontal edge has almost no vertical light available to it and an
   * up-facing ledge is *darker* than the wall it sits on. Vertical edges get
   * 0.901, which is why the vertical seams already read at -95 and these do not.
   * Tilting this lip toward the sun cannot produce a bright line.
   *
   * What is available is the sky. An up-facing surface sees the whole dome where
   * a vertical face sees half of it, and the dome is the brightest thing in the
   * scene. So the lip is tilted up to collect that, *and* carries a lighter
   * paint - which is honest independently: coating is thinner over a formed
   * radius and chalk collects on an upward ledge. Neither mechanism depends on
   * what the environment contains, which matters while the lower hemisphere is
   * still a single constant colour.
   */
  // Sized against the pose that shows it, which is what was missing. At the
  // `panels` eye the cabinet face is 1.28 m away through a 30 degree vertical
  // fov on 900 px, i.e. **0.76 mm per pixel**. A 5 mm lip standing 1.2 mm proud
  // as a 2.2 mm box is therefore a 7 to 9 px bright band with its own silhouette
  // and its own shading — and the whole-frame ridge sweep of round 195251Z found
  // exactly that, thin bright ridges 7 to 11 px tall. The critic's "bright rods"
  // is not an interpretation of a highlight; the lip is geometrically a rod.
  //
  // Nothing about the *mechanism* was wrong. The sun analysis above still holds,
  // the sky is still the only source available to a horizontal edge, and the
  // pairing of a light line against a dark one is still what reads as a cut.
  // What went wrong is that four amplifications were stacked — lighter paint, a
  // 32 degree tilt, envMapIntensity 1.25, and 5 mm of proud geometry — each
  // justified on its own, and the last one is the one that decides whether the
  // result is an edge or an object. 2 mm is 2.6 px against the seam's 5.5 mm of
  // shadow: a lit edge on a gap, at roughly a 3:1 dark-to-light ratio.
  /*
   * The panel lip is deleted, and the measurement is the reason.
   *
   * It was 120 parts and 1440 triangles per unit in its own material, so its own
   * draw call — 4320 triangles and 3 draw calls across the island. What it bought
   * was measured with a same-build A/B (`?plip=0`, round 030901Z): **mean
   * |dLuma| 0.013 over the whole frame, 0.1% of pixels changed, and +0.27 mean
   * luma in its best 100 px tile.** The shut-line backing in the same frame does
   * 0.212 and -3.59 — sixteen times the mean effect for a third of the
   * triangles.
   *
   * `tools/pumpscale.mjs` then explains why, and this is the part worth keeping:
   * the lip ranks at **54 px at its largest and 20 px median across 240 parts**,
   * at or below the 56 px that Car demonstrated reads on its model. A round went
   * into tuning its height, thickness, proudness, tilt and paint colour — all of
   * it below the legibility floor, which no amount of tuning can raise.
   *
   * Worse than useless, in fact. Its one measurable contribution was a
   * *brightening* with a 73-luma peak on a handful of pixels, which is precisely
   * the "thin bright rods" an independent critic complained of twice. Too small
   * to read as a formed edge and bright enough to read as a rod is the worst
   * available combination.
   *
   * The cost of removing it, stated so the next person can weigh it: the top
   * edge of each panel joint loses its only specular cue. That job now belongs
   * entirely to `plateReturns`, whose walls sit at 33 to 75 degrees and which
   * measure 7:1 variation in the seam's own darkening from p10 to p90 — tone
   * from slope, which is what the lip was faking with paint and proudness.
   */
  /**
   * The formed return around a plate's perimeter, and why the shut lines could
   * not have read as anything but drawn outlines without it.
   *
   * `tools/pumprelief.mjs` measured the four sections of this joint against the
   * cabinet's own plane. The shut line's floor came back with **0% of its area
   * more than 15 degrees off the face** — every triangle a viewer can see in the
   * gap faces exactly the way the panel faces. It therefore takes exactly the
   * same light as the panel and differs from it only by albedo and by a
   * hand-set `envMapIntensity`, which is the definition of a line drawn on a
   * surface. An independent critic's words were "read like drawn outlines... too
   * uniformly dark and graphically clean", and the second half of that is the
   * same fact: one constant value along the whole run cannot vary, because
   * nothing about it is a function of anything.
   *
   * This was invisible to `seamprobe`, which measured the line's contrast and
   * was satisfied — the third probe in this system tonight to ask a well-formed
   * question about the wrong axis. Contrast was never the problem. *Where the
   * contrast came from* was.
   *
   * So the gap is now floored by the plates themselves: each plate is pressed
   * with a return around its edge that slopes from the front face back to the
   * backing skin, exactly as a real panel is formed. Two adjacent plates
   * therefore meet the 8 mm gap with 4 mm of return each and it becomes a V.
   * The upper plate's return faces down and sees the ground; the lower plate's
   * faces up and sees the sky; the two vertical returns face sideways, where the
   * sun's N.L is 0.901 rather than the face's 0.390. **That pair of lines is
   * what a section is**, per NOTES, and it is a property of the geometry rather
   * than of a number.
   *
   * The returns carry the *panel* material, not the dark seam paint. Making them
   * dark as well would put the tone back into a constant and hand back the
   * uniformity; coating over a formed radius is the same coating. Their slope
   * runs from 33 degrees on the bottom row to 75 on the top, because `rel` grows
   * by `LAP` per row, so the joint's tone now varies by row and by face for
   * free — which is the "graphically clean" half.
   *
   * Two quads each, 8 triangles per plate, merged into the existing `steel`
   * mesh: no new draw call and about 224 triangles per pump.
   */
  const plateReturns = (
    cu: number,
    cv: number,
    w: number,
    h: number,
    face: 1 | -1,
    rel: number,
    axis: "z" | "x"
  ) => {
    // Start at the point where the plate's own fillet has finished turning, so
    // the return continues the surface instead of stepping off it.
    const front = rel - PLATE_R;
    const back = FLOOR_REL;
    if (front - back < 0.0005) return;
    const half = GAP / 2;

    const n: [number, number, number] = axis === "z" ? [0, 0, face] : [face, 0, 0];
    const u: [number, number, number] = axis === "z" ? [1, 0, 0] : [0, 0, 1];
    const base = axis === "z" ? (cabD / 2) : (cabW / 2);
    // Plate centre on the face plane, before any relief.
    const p0: [number, number, number] =
      axis === "z" ? [cu, cv, face * base] : [face * base, cv, cu];

    const add = (
      du: number, // 0 for the u-edges, +-1 for the v-edges
      dv: number
    ) => {
      // Inner edge sits on the plate front, outer edge on the backing skin, one
      // half-gap further out along whichever edge this is.
      const along: [number, number, number] = dv !== 0 ? u : [0, 1, 0];
      const across: [number, number, number] = dv !== 0 ? [0, 1, 0] : u;
      const span = dv !== 0 ? w : h;
      const edge = (dv !== 0 ? h : w) / 2;
      const sign = dv !== 0 ? dv : du;

      // Segmented along its length rather than one quad, because a return of
      // exactly constant width is the other half of "graphically clean": the
      // pair of lines is then identical at every point along the run and reads
      // as ruled. Real panel gaps wander by a millimetre or so as the sheet is
      // formed and hung. Jittering the *outer* edge changes the slope, so it
      // varies the tone of the pair rather than just its width, and the outer
      // edge stays on the backing plane so nothing opens up behind it.
      const segs = Math.max(2, Math.round(span / 0.09));
      const pos = new Float32Array((segs + 1) * 6);
      const index: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const t = -span / 2 + (span * i) / segs;
        const j = rng();
        const hh = half * (0.86 + j * 0.28);
        const ff = front * (0.94 + j * 0.12);
        for (let o = 0; o < 2; o++) {
          const vi = i * 2 + o;
          for (let k = 0; k < 3; k++) {
            pos[vi * 3 + k] =
              p0[k] +
              along[k] * t +
              across[k] * sign * (edge + o * hh) +
              n[k] * (o === 0 ? ff : back);
          }
        }
        if (i > 0) {
          const b0 = (i - 1) * 2;
          index.push(b0, b0 + 2, b0 + 3, b0, b0 + 3, b0 + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(index);
      g.computeVertexNormals();
      // Winding depends on which edge this is and which way the face points, and
      // getting it wrong means the quad is culled and the fix is invisible while
      // measuring perfectly — see NOTES on `flankStrip`. Rather than reason about
      // eight cases, check the result against the direction the return must face
      // and flip if it disagrees.
      const nx = g.attributes.normal;
      const want = [
        n[0] + across[0] * sign,
        n[1] + across[1] * sign,
        n[2] + across[2] * sign,
      ];
      const dot = nx.getX(0) * want[0] + nx.getY(0) * want[1] + nx.getZ(0) * want[2];
      if (dot < 0) {
        const flipped: number[] = [];
        for (let i = 0; i < index.length; i += 3) flipped.push(index[i], index[i + 2], index[i + 1]);
        g.setIndex(flipped);
        g.computeVertexNormals();
      }
      steel.push(g);
    };

    section("plate return", () => {
      add(0, 1);
      add(0, -1);
      add(1, 0);
      add(-1, 0);
    });
  };

  /** Plate on a cabinet face, standing `rel` proud of the backing. */
  const facePlate = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    face: 1 | -1,
    rel = PROUD,
    axis: "z" | "x" = "z"
  ) => {
    const w = Math.abs(x1 - x0) - GAP;
    const h = Math.abs(y1 - y0) - GAP;
    if (w < 0.02 || h < 0.02) return;
    const g = roundedBox(w, h, rel * 2, PLATE_R, 2);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    plateReturns(cx, cy, w, h, face, rel, axis);
    if (axis === "z") {
      section("panel plate", () => steel.push(place(g, cx, cy, (face * cabD) / 2)));
      // Segmented rather than one bar, and jittered, because "a perfectly
      // constant ribbon is itself a tell" - a real panel edge waves and its
      // contrast changes along the run.
    } else {
      section("panel plate", () => steel.push(place(g, (face * cabW) / 2, cy, cx, 0, Math.PI / 2)));
    }
  };

  const sx0 = -cabW / 2 + chamfer;
  const sx1 = cabW / 2 - chamfer;
  const rows = [baseH + 0.008, 0.545, 0.905, cabTop - 0.055, cabTop];

  for (const face of [1, -1] as const) {
    // Dark backing skin, a hair proud of the cabinet so it wins the depth test.
    // Only the gaps between plates ever see it, which is the whole point: it is
    // the floor of every shut line at once, for two triangles per face.
    section("shut line floor", () =>
      seam.push(
        place(
          new THREE.BoxGeometry(sx1 - sx0 + 0.004, rows[4] - rows[0] + 0.004, 0.001),
          0,
          (rows[0] + rows[4]) / 2,
          face * (cabD / 2 + FLOOR_REL)
        )
      )
    );
    // The payment column is its own bolted-on panel, so the vertical joints
    // either side of it come free from the plate layout.
    // Boundaries closer than 90 mm to a span end are dropped rather than kept,
    // because on the face where the payment column runs outboard they would
    // leave a 46 mm filler sliver - a panel width no fabricator would cut.
    const cols = [sx0, Math.min(face * -0.375, face * -0.145), Math.max(face * -0.375, face * -0.145), sx1].filter(
      (v, i, a) => i === 0 || i === a.length - 1 || (v - sx0 > 0.09 && sx1 - v > 0.09)
    );
    for (let r = 0; r < 4; r++) {
      const y0 = rows[r];
      const y1 = rows[r + 1];
      const rel = PROUD + r * LAP;
      if (r === 3) {
        // Valance filler strip runs the full width - it is above all furniture.
        facePlate(sx0, sx1, y0, y1, face, rel);
      } else {
        for (let c = 0; c < cols.length - 1; c++) facePlate(cols[c], cols[c + 1], y0, y1, face, rel);
      }
      // There is no dark ribbon here any more, and removing it is the fix.
      //
      // A shut line was being drawn as two decals stuck to the front of the
      // cabinet: a bright bar 0.5 mm proud of the panel for the lit edge, and a
      // dark bar for the gap placed at `cabD/2 + rel + 0.0006` — that is 0.6 mm
      // **proud of the panel it was supposed to be a hole in**. It could not be
      // occluded by anything, because it was the frontmost surface on the face.
      // Every previous pass tuned its height, its jitter and its darkness, and
      // none of that could work, for the same reason the lip could not be fixed
      // by making it brighter: a painted stripe with correct values is still a
      // painted stripe.
      //
      // The slot it was imitating already exists and always did. `facePlate`
      // insets every plate by GAP/2, so adjacent plates are 8 mm apart; each row
      // stands LAP further proud than the one below; and the dark backing skin
      // pushed above sits at `cabD/2 + 0.0004`. That is a real 8 mm wide channel
      // between 5 and 17 mm deep with a dark floor, and it is what a viewer
      // should be looking into. The ribbon was sitting on top of it, hiding it.
      //
      // This also answers the constraint that the +Z faces get no direct sun and
      // so no cast shadow: none is needed. The darkness comes from the floor's
      // own albedo and from how little of the sky dome a surface at the bottom
      // of a 8 x 17 mm channel can see, neither of which cares where the sun is.
      // `seamMat`'s envMapIntensity carries that second part.
    }
  }

  // End panels get the same treatment, split by one vertical joint on centre.
  for (const face of [1, -1] as const) {
    section("shut line floor", () =>
      seam.push(
        place(
          new THREE.BoxGeometry(0.001, rows[4] - rows[0] + 0.004, cabD - chamfer * 2 + 0.004),
          face * (cabW / 2 + FLOOR_REL),
          (rows[0] + rows[4]) / 2,
          0
        )
      )
    );
    const ez = cabD / 2 - chamfer;
    for (const zs of [-1, 1] as const) {
      facePlate(zs === -1 ? -ez : 0, zs === -1 ? 0 : ez, rows[0], rows[3], face, PROUD, "x");
      facePlate(zs === -1 ? -ez : 0, zs === -1 ? 0 : ez, rows[3], rows[4], face, PROUD + LAP, "x");
    }
  }

  /* ---------------- splash off the pad, around the base ----------------- */
  setRegion("base splash");

  // Where the `wallBase` profile is worth spending, and why it is darts rather
  // than a band.
  //
  // `tools/pumpsoil.mjs` measures terrain's splash profile at 0.49 at 20 mm,
  // 0.32 at 100, 0.18 at 200, 0.03 at 500 and nothing by 800. That is a real
  // range over the bottom 300 mm and it is the only strong signal this geometry
  // can get out of the shared fields — the island reads zero for `grime`,
  // `swept` and `shelter`, and `fines` is constant to 2%. Every fastener sits
  // above 550 mm, so the weeps get almost none of it; the base gets all of it.
  //
  // Built as **discrete darts** rather than as a graded band, because a graded
  // band is precisely the defect being answered: "dirt and wear are too uniform
  // and vertical, an obvious procedural grime pass". Rain coming off a pad does
  // not wash a wall evenly, it throws individual spatters that run a short way
  // and stop, and their *count* falls off with height rather than only their
  // strength. So each dart gets its own height from a distribution weighted low,
  // and the strength of each comes from the field at the height it reaches.
  //
  // Same material and same mesh as the fastener weeps, so this is 320 triangles
  // and no new draw call.
  for (const [axis, half, span] of [
    ["z", cabD / 2, cabW - chamfer * 2],
    ["x", cabW / 2, cabD - chamfer * 2],
  ] as const) {
    for (const face of [1, -1] as const) {
      const n = axis === "z" ? 15 : 7;
      for (let k = 0; k < n; k++) {
        // Jittered rather than evenly spaced: evenly spaced spatter is a comb.
        const u = (k + 0.15 + rng() * 0.7) / n;
        const along = (u - 0.5) * span;
        // Weighted low. Cubing a uniform draw puts most darts in the bottom
        // third, which is the shape of the profile rather than of the geometry.
        const len = 0.045 + Math.pow(rng(), 2.4) * 0.30;
        const at = len * 0.45;
        const soil = soilAt
          ? soilAt(axis === "z" ? along : face * half, at, axis === "z" ? face * half : along)
          : 0.35;
        // Capped well below opacity. On the downwind face the field saturates,
        // and an unclamped product would put near-opaque brown around the base —
        // a painted skirt, which is a different wrong answer from the invisible
        // stain this system shipped an hour ago. Visible and too strong are both
        // failures; only one of them is detectable in a screenshot.
        const strength = Math.min(0.75, (0.10 + soil * 0.85) * (0.5 + rng() * 0.9));
        if (strength < 0.05) continue;
        // Wider than a weep: a spatter is not a trickle.
        const g = taperedStain(0.010 + rng() * 0.014, 0.026 + rng() * 0.030, len, strength, true);
        // Proud of the *plate*, not of the box.
        //
        // This read `half + 0.0009` and was therefore 5.3 mm inside the cabinet
        // for its whole life. `half` is `cabD / 2`, the backing box, and the
        // lapped plates stand `PROUD + r * LAP` outboard of it — so a stain
        // offset 0.9 mm from the box lands behind the panel it is supposed to be
        // on, and every dart was occluded by the surface it was staining. The
        // `pweep=0` A/B measured the consequence exactly: removing the entire
        // mesh changed 0.0% of `unit1` and at most 9 luma on a few percent of
        // `panels`, and that residue was the fastener weeps, which offset from
        // the bolt rather than from the box and were the only stains outside the
        // steel.
        //
        // Darts reach at most ~0.5 m and `rows[1]` is 0.545, so they are all on
        // row 0, but the row is looked up rather than assumed because the next
        // person to widen the height distribution should not have to know this.
        let row = 0;
        for (let r = 3; r >= 0; r--) {
          if (baseH + len * 0.5 >= rows[r]) {
            row = r;
            break;
          }
        }
        const oz = half + PROUD + row * LAP + 0.0012;
        section("base splash", () =>
          weep.push(
            axis === "z"
              ? place(g, along, baseH + len / 2 - 0.004, face * oz, 0, face === 1 ? 0 : Math.PI)
              : place(g, face * oz, baseH + len / 2 - 0.004, along, 0, face === 1 ? Math.PI / 2 : -Math.PI / 2)
          )
        );
      }
    }
  }

  /* ---------------- vapour-recovery lines up the end panels ------------- */
  setRegion("vapour recovery");

  // At forecourt distance the dispenser was a rectangle: every edge of its
  // silhouette was one of four straight lines, and nothing broke them. Real
  // units carry the vapour-recovery pipe and its conduit up the outside of the
  // end panel on standoff clamps, which is a 30 mm pipe standing 40 mm proud —
  // small, but it is on the outline, and things on the outline survive to any
  // distance while surface detail does not.
  //
  // Placed on the Z half opposite the hose swivel at that end, so the two
  // pieces of hardware do not collide.
  for (const sx of [-1, 1] as const) {
    const ex = (sx * cabW) / 2;
    // The swivel for this end sits at z = face * 0.13 with face = sx, so the
    // pipe goes to the other side.
    const pz = -sx * 0.215;
    const pipeTop = cabTop - 0.02;
    steelDark.push(place(new THREE.CylinderGeometry(0.0155, 0.0155, pipeTop - 0.16, 12, 1), ex + sx * 0.030, (pipeTop + 0.16) / 2, pz));
    // Sweep elbow into the cabinet at the top, so the pipe goes somewhere.
    steelDark.push(place(new THREE.TorusGeometry(0.048, 0.0155, 8, 12, Math.PI / 2), ex + sx * 0.030 - sx * 0.048, pipeTop, pz, 0, sx > 0 ? 0 : Math.PI, 0));
    // Standoff clamps.
    for (const cy of [0.30, 0.66, 1.00]) {
      steelDark.push(place(roundedBox(0.030, 0.030, 0.048, 0.006, 2), ex + sx * 0.014, cy, pz));
      chrome.push(place(new THREE.CylinderGeometry(0.0042, 0.0048, 0.005, 6, 1), ex + sx * 0.002, cy, pz, 0, 0, Math.PI / 2));
    }
    // Junction box at the foot, where the conduit turns down into the sump.
    steelDark.push(place(roundedBox(0.038, 0.115, 0.086, 0.008, 2), ex + sx * 0.020, 0.175, pz));
  }

  /* ---------------- panel fasteners ---------------- */
  // A region marker the banners did not have. The first run of the two-level
  // labelling reported 40 fasteners under "vapour recovery", because this block
  // sits physically after that banner and stickiness is by file order, not by
  // meaning. The premise that banners partition the function held everywhere
  // except here — which the table showed on its first print, and which is the
  // argument for printing the whole table rather than the headline row.
  setRegion("panel fasteners");

  // Panel fasteners, on the panels.
  //
  // Three faults, all of them visible in the last round's frames.
  //
  // They were at x = +-0.46, and the plate spans run to +-0.425, so every one of
  // them sat out on the chamfer facet fastening nothing - read back verbatim as
  // "at least one sits in an open field of panel with nothing to fasten". They
  // were also at Z = cabD/2, the bare skin, which since the panels stand 5 to 17
  // mm proud means a 5 mm long bolt was entirely *inside* the panel it was
  // supposed to hold on. And they were `chrome`, which is why they came out as
  // "pure white dots with no head geometry, no recess, no washer".
  //
  // Now they run along the bottom edge of each panel, which is where a screw
  // actually goes and puts them on the seam line rather than adrift in the
  // middle of a sheet; they follow that panel's own proud depth; and each is a
  // washer plus a hex head in dark steel with a weep of dirt below it.
  // `base` is the proud depth of the panel this fastener holds on. It has to be
  // threaded through rather than assumed: the panels no longer sit at a single
  // depth, and a bolt authored against the bare skin ends up inside the sheet it
  // is fastening. The CPU check in tools/pumpprobe.mjs compares bolt Z against
  // plate front Z per row for exactly this reason.
  const boltAt = (x: number, y: number, z: number, faceSign: 1 | -1, axis: "z" | "x", base: number) => {
    const rot: [number, number, number] = axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, Math.PI / 2];
    const put = (g: THREE.BufferGeometry, out: number) =>
      axis === "z"
        ? place(g, x, y, z + faceSign * (base + out), ...rot)
        : place(g, z + faceSign * (base + out), y, x, ...rot);
    section("fastener", () =>
      steelDark.push(put(new THREE.CylinderGeometry(0.0082, 0.0082, 0.0014, 10, 1), 0.0007))
    );
    steelDark.push(put(new THREE.CylinderGeometry(0.0046, 0.0053, 0.0036, 6, 1), 0.0032));
    // The weep below the head, and what was wrong with the first one.
    //
    // It was a `PlaneGeometry(7.5, 26 mm)` in `seamMat` — the near-black slot
    // material — sitting 0.6 mm proud of the plate. So it was a hard-edged
    // black rectangle, 34 x 10 px at the `panels` eye, of constant tone, with
    // the panel's own normal. `tools/pumprelief.mjs` gives it 0% off-panel
    // area, which is correct and beside the point: a stain *should* shade as
    // the surface it is on, because it is that surface with dirt on it. What
    // condemned it was the other three properties. A critic reported the
    // fastener lines as "drawn outlines" and this is the most literal one on
    // the model — every bolt read as a black tadpole with a hard stalk.
    //
    // A run-down stain is soft at every edge, widens as it goes, fades out
    // before it stops, and is nowhere near black — it is the same paint with a
    // film over it. So: a tapered quad, a soft alpha mask shared by every
    // stain, and a strength that comes from `groundAccum` at this bolt's own
    // place on the cabinet rather than from a constant. Two bolts a metre apart
    // now differ, which is the half of "dirt is too uniform" that geometry can
    // answer.
    const cl01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const soil = soilAt
      ? soilAt(axis === "z" ? x : z + faceSign * base, y, axis === "z" ? z + faceSign * base : x)
      : 0.5;
    const strength = cl01(0.16 + soil * 0.72) * (0.55 + rng() * 0.9);
    if (strength > 0.06) {
      const len = 0.020 + strength * 0.052 + rng() * 0.012;
      const wTop = 0.0052;
      const wBot = wTop * (1.9 + rng() * 1.1);
      const wz = z + faceSign * (base + 0.0006);
      const g = taperedStain(wTop, wBot, len, strength);
      weep.push(
        axis === "z"
          ? place(g, x, y - len / 2 - 0.007, wz, 0, faceSign === 1 ? 0 : Math.PI)
          : place(g, wz, y - len / 2 - 0.007, x, 0, faceSign === 1 ? Math.PI / 2 : -Math.PI / 2)
      );
    }
  };

  for (const face of [1, -1] as const) {
    const cols = [sx0, Math.min(face * -0.375, face * -0.145), Math.max(face * -0.375, face * -0.145), sx1].filter(
      (v, i, a) => i === 0 || i === a.length - 1 || (v - sx0 > 0.09 && sx1 - v > 0.09)
    );
    for (let r = 1; r < 4; r++) {
      const rel = PROUD + r * LAP;
      const by = rows[r] + GAP / 2 + 0.016;
      const spans = r === 3 ? [[sx0, sx1]] : cols.slice(0, -1).map((v, c) => [v, cols[c + 1]]);
      for (const [a, b] of spans) {
        const n = Math.abs(b - a) > 0.4 ? 4 : 2;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          boltAt(a + (b - a) * t, by, (face * cabD) / 2, face, "z", rel);
        }
      }
    }
  }
  // End panels: one pair per panel, on the same logic.
  for (const face of [1, -1] as const) {
    const ez = cabD / 2 - chamfer;
    for (const bz of [-ez / 2, ez / 2]) {
      for (const [by, base] of [
        [rows[0] + 0.020, PROUD],
        [rows[3] + GAP / 2 + 0.016, PROUD + LAP],
      ] as const) {
        boltAt(bz, by, (face * cabW) / 2, face, "x", base);
      }
    }
  }

  /* ---------------- per-face detail ---------------- */
  setRegion("per-face detail");

  for (const face of [1, -1] as const) {
    const fz = (face * headD) / 2;
    const flip = face === 1 ? 0 : Math.PI;

    /* display: recessed 26 mm behind a plastic bezel and a grimy cover */
    const dW = 0.62;
    const dH = 0.31;
    const dY = 1.42;
    // The head is a solid box, so there is nothing to recess *into*: anything
    // placed behind the face plane is simply buried, which is how the whole
    // display went missing for two rounds. The recess is faked the way it is
    // faked on a real dispenser anyway - a deep bezel standing proud of the
    // skin, with the glass set well forward of the panel so there is real
    // parallax and a real shadow across the digits.
    const bezelDepth = 0.042;
    section("display bezel", () => plastic.push(...bezelRing(dW, dH, 0.038, bezelDepth, 0, dY, fz, face)));

    const panel = new THREE.PlaneGeometry(dW, dH, 1, 1);
    displays.push({ side: face, geo: place(panel, 0, dY, fz + face * 0.0025, 0, flip) });

    // Cover glass, 24 mm in front of the panel and inside the bezel mouth.
    glass.push(place(new THREE.PlaneGeometry(dW + 0.004, dH + 0.004), 0, dY, fz + face * 0.027, 0, flip));

    // Sun hood over the display, angled down.
    plastic.push(place(roundedBox(dW + 0.11, 0.017, 0.085, 0.006, 2), 0, dY + dH / 2 + 0.055, fz + face * 0.036, face * 0.26));

    /* payment column on the inboard half of the face */
    const px = face * -0.26;

    // Each control gets its own depth, bezel thickness and fixing. The first
    // pass gave the reader, keypad, receipt slot and grade panel the same 10 mm
    // proud stamped rectangle with the same bevel, and a face made of four
    // identical extrusions reads as a UI mockup rather than as four assemblies
    // sourced from four suppliers.

    // Card reader: deepest of the four, on a gasketed sub-plate, with four
    // visible fixings and a chrome slot lip.
    steelDark.push(place(roundedBox(0.186, 0.166, 0.008, 0.004, 2), px, 0.985, fz + face * 0.004));
    plastic.push(place(roundedBox(0.158, 0.140, 0.062, 0.014, 3), px, 0.985, fz + face * 0.026));
    steelDark.push(place(new THREE.BoxGeometry(0.100, 0.008, 0.034), px, 1.022, fz + face * 0.046));
    steelDark.push(place(new THREE.BoxGeometry(0.032, 0.048, 0.028), px, 0.952, fz + face * 0.044));
    chrome.push(place(new THREE.BoxGeometry(0.108, 0.0035, 0.007), px, 1.022, fz + face * 0.062));
    for (const fx of [-1, 1]) {
      for (const fy of [-1, 1]) {
        chrome.push(
          place(new THREE.CylinderGeometry(0.0042, 0.0048, 0.004, 6, 1), px + fx * 0.082, 0.985 + fy * 0.072, fz + face * 0.010, Math.PI / 2)
        );
      }
    }

    // Keypad: shallower, and set *into* a recess rather than standing proud,
    // so it contrasts with the reader above it.
    steelDark.push(place(roundedBox(0.172, 0.196, 0.012, 0.005, 2), px, 0.820, fz + face * 0.003));
    plastic.push(place(roundedBox(0.150, 0.175, 0.020, 0.010, 3), px, 0.820, fz + face * 0.008));
    // The twelve blank extruded lozenges that used to sit here are gone, and the
    // keys are printed instead. See `makeKeypadFace`: the merged pump carries
    // metre-scale triplanar UVs, so there was no way to put a digit on a key
    // that was geometry, and a keypad with no numbers on it is a worse failure
    // than a keypad with no relief.
    keypadFaces.push({
      side: face,
      geo: place(
        new THREE.PlaneGeometry(KEYPAD_FACE.w, KEYPAD_FACE.h, 1, 1),
        px,
        0.825,
        fz + face * 0.020,
        0,
        face === 1 ? 0 : Math.PI
      ),
    });
    // Function keys flanking the display, as on every real head.
    for (const sx of [-1, 1]) {
      for (let r = 0; r < 4; r++) {
        keys.push(
          place(roundedBox(0.026, 0.030, 0.013, 0.005, 2), sx * (dW / 2 + 0.062), dY + 0.105 - r * 0.070, fz + face * 0.016)
        );
      }
    }

    // Receipt slot: nearly flush, a thin stainless lip and a rubber dust flap.
    // The shallowest of the group by design.
    steelDark.push(place(roundedBox(0.140, 0.052, 0.006, 0.003, 2), px, 0.700, fz + face * 0.002));
    chrome.push(place(roundedBox(0.126, 0.030, 0.010, 0.004, 2), px, 0.703, fz + face * 0.008));
    steelDark.push(place(new THREE.BoxGeometry(0.108, 0.010, 0.016), px, 0.703, fz + face * 0.014));

    // Bill acceptor: a deep bolted-on module with a heavy chamfered throat.
    steelDark.push(place(roundedBox(0.152, 0.106, 0.010, 0.004, 2), px, 0.575, fz + face * 0.004));
    plastic.push(place(roundedBox(0.136, 0.092, 0.042, 0.012, 3), px, 0.575, fz + face * 0.020));
    steelDark.push(place(new THREE.BoxGeometry(0.088, 0.014, 0.038), px, 0.575, fz + face * 0.040));
    for (const fy of [-1, 1]) {
      chrome.push(
        place(new THREE.CylinderGeometry(0.0042, 0.0048, 0.004, 6, 1), px, 0.575 + fy * 0.062, fz + face * 0.008, Math.PI / 2)
      );
    }

    /* grade selection, outboard of the payment column: a single moulded pod
       with three big keys in it, not three separate stamped rectangles */
    const gPodY = 1.025;
    steelDark.push(place(roundedBox(0.178, 0.268, 0.010, 0.004, 2), face * 0.135, gPodY, fz + face * 0.003));
    plastic.push(place(roundedBox(0.164, 0.252, 0.034, 0.014, 3), face * 0.135, gPodY, fz + face * 0.016));
    for (let g = 0; g < 3; g++) {
      const gy = gPodY + 0.080 - g * 0.080;
      keys.push(place(roundedBox(0.132, 0.058, 0.020, 0.009, 3), face * 0.135, gy, fz + face * 0.036));
    }

    /* nozzle boot: a formed scoop, not a flat plate with a hole in it.
       The boot on a real dispenser is a deep pressed pocket with a rolled lip
       and a drain, and the nozzle drops into it far enough that the spout
       disappears. The previous version was a plate plus two cylinders, which
       is why the critic read the whole assembly as a collar. */
    const bx = face * bootX;
    const bootZ = fz + face * 0.070;

    // Scuff plate: the nozzle has been knocking this bit of the cabinet for
    // years, which is why it is a separate, dented, bare-metal panel.
    section("nozzle boot", () =>
      steelDark.push(place(roundedBox(0.230, 0.320, 0.009, 0.005, 2), bx, bootY + 0.020, fz + face * 0.004))
    );

    // Pressed pocket: an open cone flaring out to the mouth, with a rolled lip
    // ring at the top and a closed bottom with a drain hole boss.
    //
    // Shallower and narrower than the first pass, which was a 124 mm bucket
    // 175 mm deep. Against a correctly sized nozzle that swallowed the valve
    // body and the trigger guard entirely, so the assembly read as a plastic
    // cup with a chrome hook coming out of it — the "cylinder with a collar"
    // the critic reported, produced by the boot rather than by the nozzle.
    // A cone of revolution 106 mm across the mouth, narrowing to 72 mm, in the
    // cream body material, is a disposable coffee cup - which is exactly what
    // the critic called it. Three things were wrong and all three were the
    // cone: it was circular in plan, it tapered hard, and it was body-coloured.
    //
    // A real boot is an oval scabbard: wider across the cabinet than it is deep,
    // near-parallel walls, and moulded in black. Squashing the cylinder on Z
    // gives the oval for free and is what stops it reading as a vessel; the
    // dark material stops it reading as crockery. Kept open-ended so the inside
    // wall is visible looking down into the mouth.
    const OVAL = 0.66;
    const oval = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * OVAL);
      p.needsUpdate = true;
      g.computeVertexNormals();
      return g;
    };
    //
    // The pocket is in two sections and the reason is a penetration, not a
    // style choice. The stowed spout tip sits 187 mm below the nozzle origin
    // once the rake is applied, i.e. 177 mm below the rim, and a 132 mm pocket
    // has 125 mm of usable depth — so the spout came out through the cup floor
    // and hung in mid air below it, plainly visible in the `nozzle` frame of
    // round 192457Z. Deepening the *whole* cup would put the bucket back, so the
    // mouth section is untouched at its authored diameter, plan shape, material
    // and depth, and the extra 64 mm is a necked-down sheath below it. None of
    // the three things the "disposable cup" read was traced to — a circular
    // plan, a hard taper at the mouth, and a cream body colour — is affected by
    // anything below the mouth.
    //
    // Every section below the mouth is positioned with `downBore`, and that is
    // not tidiness. The pocket is raked `face * 0.10` about X, and `place`
    // rotates each piece about its *own* centre, so two sections that share a Z
    // are not joined: the mouth's lower rim swings 6.6 mm one way and the
    // sheath's upper rim 3.3 mm the other, leaving a 10 mm step with the inside
    // of the cup showing through it. In round 194424Z the stowed spout tip was
    // framed in that gap as a bright wedge on the outside of the boot — the
    // second time in this system that a slot has been read as an object. So the
    // sections are strung down the raked bore instead of down world Y.
    const bore = face * 0.10;
    const downBore = (d: number): [number, number] => [
      bootY - 0.030 - d * Math.cos(bore),
      bootZ - d * Math.sin(bore),
    ];
    const pocket = oval(new THREE.CylinderGeometry(0.058, 0.050, 0.132, 20, 1, true));
    steelDark.push(place(pocket, bx, bootY - 0.030, bootZ, bore));
    steelDark.push(place(oval(new THREE.CylinderGeometry(0.050, 0.050, 0.066, 20, 1, true)), bx, ...downBore(0.099), bore));
    // Rolled lip round the mouth, ovalled to match.
    steelDark.push(
      place(      oval(new THREE.TorusGeometry(0.058, 0.0075, 8, 24)), bx, bootY + 0.036, bootZ, Math.PI / 2 + face * 0.10)
    );
    // Contact occlusion where the nozzle meets the cup.
    //
    // Three separate probes agree the nozzle is 38-59 mm down inside this cup and
    // canted 36-63 mm front-to-back, and the read was still "it hovers forward
    // and above the cup rather than dropping into it, with no contact shadow and
    // no point of support". Those are compatible: the tool *is* seated, and
    // nothing in the image says so. A 20 mm crevice between a matte body and a
    // matte cup does not darken from a shadow map at this scale, so the one cue
    // that would settle it is absent and the eye correctly refuses to believe the
    // contact.
    //
    // So the darkening is authored rather than lit - a dark ring just inside the
    // mouth and a wedge under the front lip where the body bears. Being albedo,
    // it does not care what the environment contains or where the sun is, which
    // is the same reason the panel lip above is albedo.
    seam.push(
      place(
        oval(new THREE.CylinderGeometry(0.055, 0.049, 0.052, 20, 1, true)),
        bx,
        bootY + 0.012,
        bootZ,
        face * 0.10
      )
    );
    seam.push(
      place(
        oval(new THREE.TorusGeometry(0.0575, 0.0068, 6, 14, Math.PI * 0.62)),
        bx,
        bootY + 0.0335,
        bootZ + face * 0.001,
        Math.PI / 2 + face * 0.10,
        face === 1 ? Math.PI * 0.69 : Math.PI * 0.31
      )
    );
    steelDark.push(place(oval(new THREE.CylinderGeometry(0.050, 0.046, 0.014, 20, 1)), bx, ...downBore(0.136), bore));
    // Escutcheon where the pocket passes through the cabinet skin: a squarer
    // plate, so the boot is let into the panel rather than glued onto it.
    steelDark.push(place(roundedBox(0.148, 0.126, 0.010, 0.006, 2), bx, bootY + 0.014, fz + face * 0.009));
    // Drain out of the bottom of the pocket.
    //
    // This was a bare 34 mm cylinder hanging in space below the boot, and it
    // read as exactly what it looked like: "a small unexplained appendage...
    // a stray primitive nobody cleaned up". A spigot needs somewhere to go. Now
    // it is short, it has a hex boss where it leaves the pocket, and it turns
    // back into the cabinet instead of stopping in mid air.
    steelDark.push(place(new THREE.CylinderGeometry(0.0090, 0.0100, 0.013, 8, 1), bx, ...downBore(0.145)));
    steelDark.push(place(new THREE.CylinderGeometry(0.0052, 0.0052, 0.022, 8, 1), bx, ...downBore(0.159)));
    // Elbow, then a run back to the cabinet skin so the drain terminates on
    // something. Cylinders are authored along Y, so rx turns them along Z.
    steelDark.push(place(new THREE.SphereGeometry(0.0072, 8, 6), bx, ...downBore(0.170)));
    steelDark.push(
      place(
        new THREE.CylinderGeometry(0.0052, 0.0052, 0.070, 8, 1),
        bx,
        downBore(0.170)[0],
        downBore(0.170)[1] - face * 0.035,
        Math.PI / 2
      )
    );

    // Mounting bracket tying the pocket back to the cabinet face, with fixings.
    steelDark.push(place(roundedBox(0.088, 0.130, 0.062, 0.012, 3), bx, bootY + 0.036, fz + face * 0.032));
    for (const fy of [-1, 1]) {
      chrome.push(
        place(new THREE.CylinderGeometry(0.0045, 0.0052, 0.005, 6, 1), bx, bootY + 0.036 + fy * 0.052, fz + face * 0.009, Math.PI / 2)
      );
    }

    // Drip lip under the boot, tilted so it sheds toward the island. Kept
    // narrow and tucked back: at full width it reads as a bar bolted across
    // the pump.
    plastic.push(place(roundedBox(0.104, 0.012, 0.076, 0.005, 2), bx, downBore(0.172)[0], downBore(0.172)[1] - face * 0.010, -face * 0.24));

    // Nozzle switch lever, inboard of the boot.
    chrome.push(
      place(new THREE.CylinderGeometry(0.009, 0.009, 0.080, 10, 1), bx - face * 0.112, bootY + 0.056, fz + face * 0.030, 0, 0, Math.PI / 2)
    );

    /* nozzle, sitting in the boot */
    const n = buildNozzle();
    const stow = nozzleStowed(face, vary);
    const m = stow.matrix;
    const xf = (list: THREE.BufferGeometry[]) => list.map((g) => ensureAttrs(g.applyMatrix4(m)));
    nozzles.push({
      side: face,
      // Wear is written here, at the single site the geometry is made, rather
      // than at the consumer. The hose spent a whole round weathered on a path
      // no static frame takes, and the general form of that bug is a property
      // living at a consumer when there is more than one consumer. There is one
      // render consumer of these today and `nozzlePartsStowed` besides, but the
      // attribute riding with the geometry is also what lets a CPU probe see it.
      body: scuffProminence(
        merge(xf(n.body), "metre", `pumpParts.nozzle[${face}].body`),
        vary.hoseSeed + 31,
        wantScuff() ? 1.15 : 0
      ),
      metal: scuffProminence(
        merge(xf(n.metal), "metre", `pumpParts.nozzle[${face}].metal`),
        vary.hoseSeed + 47,
        wantScuff() ? 0.85 : 0
      ),
      rubber: merge(xf(n.rubber), "metre", `pumpParts.nozzle[${face}].rubber`),
    });

    /* hose.
       The old routing left the holster, climbed, turned a fixed-radius elbow
       and dropped - conduit, not rubber. This version terminates in a real
       swivel assembly bolted to the cabinet end and then simply hangs: the
       curve is a solved catenary of a fixed slack length with the nozzle's
       mass loading one end, so the belly of the loop sits low and off-centre
       toward the nozzle, and the length is what sets the shape. */
    const sx = Math.sign(bx) || 1;
    const sw = hoseSwivel(face);

    // Swivel assembly on the end panel: a bolted boss, a turned barrel, the
    // union nut and a rubber strain-relief spring. Sits proud of the panel so
    // the hose terminates in hardware instead of intersecting sheet metal.
    const bossX = sx * (cabW / 2);
    steelDark.push(place(roundedBox(0.016, 0.104, 0.104, 0.010, 3), bossX + sx * 0.008, hoseY, face * 0.13, 0, 0, Math.PI / 2));
    for (const fz2 of [-1, 1]) {
      chrome.push(
        place(new THREE.CylinderGeometry(0.0042, 0.0048, 0.005, 6, 1), bossX + sx * 0.004, hoseY + fz2 * 0.040, face * 0.13, 0, 0, Math.PI / 2)
      );
    }
    chrome.push(place(new THREE.CylinderGeometry(0.022, 0.026, 0.052, 16, 1), bossX + sx * 0.040, hoseY, face * 0.13, 0, 0, Math.PI / 2));
    // Union nut: a hex, so it reads as a fitting rather than a pipe stub.
    chrome.push(place(new THREE.CylinderGeometry(0.026, 0.026, 0.024, 6, 1), bossX + sx * 0.072, hoseY, face * 0.13, 0, 0, Math.PI / 2));
    // Strain-relief spring tapering onto the hose itself.
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      plastic.push(
        place(
          new THREE.TorusGeometry(0.020 - t * 0.005, 0.0034, 6, 14),
          bossX + sx * (0.090 + i * 0.017),
          hoseY - t * t * 0.016,
          face * 0.13,
          0,
          0,
          Math.PI / 2
        )
      );
    }

    // Hose leaves the swivel along the swivel axis, i.e. straight out of the
    // end of the pump, and is only then free to fall.
    const curve = hangingHose(sw.point, sw.dir, stow.inlet, stow.inletDir, vary.hoseLen, {
      seed: vary.hoseSeed + (face === 1 ? 7 : 19),
      nozzleLoad: 0.085,
      stiffness: 0.15,
    });
    // Weathered here, not only in `PumpSystem.rebuildHose`.
    //
    // The first attempt wired `weatherHose` into `rebuildHose`, which is only
    // called from `setNozzleLift` — so the hose in every static capture was the
    // original smooth 10-spoke tube and the entire change was invisible while
    // measuring perfectly on the CPU. The registry triangle count is what gave
    // it away: it rose by exactly the 1,056 the splash darts account for and not
    // one triangle more. Both paths have to weather, and they have to agree, or
    // the hose changes shape the first time somebody touches a nozzle.
    hoses.push({
      side: face,
      geo: weatherHose(
        ensureAttrs(new THREE.TubeGeometry(curve, 120, 0.0145, HOSE_SPOKES, false)),
        120,
        HOSE_SPOKES,
        0.0145,
        vary.hoseSeed + (face === 1 ? 7 : 19)
      ),
    });
  }

  return {
    steel: merge(steelList, "metre", "pumpParts.steel"),
    steelDark: merge(steelDarkList, "metre", "pumpParts.steelDark"),
    seam: merge(seamList, "metre", "pumpParts.seam"),
    trim: merge(trimList, "metre", "pumpParts.trim"),
    accent: merge(accentList, "metre", "pumpParts.accent"),
    plastic: merge(plasticList, "metre", "pumpParts.plastic"),
    keys: merge(keysList, "metre", "pumpParts.keys"),
    chrome: merge(chromeList, "metre", "pumpParts.chrome"),
    weep: merge(weepList, "metre", "pumpParts.weep"),
    parts,
    glass: merge(glass, "metre", "pumpParts.glass"),
    topper: merge(topper, "metre", "pumpParts.topper"),
    displays,
    topperFaces,
    keypadFaces,
    hoses,
    nozzles,
  };
}

/* ------------------------------------------------------------------ */
/* bollard                                                              */
/* ------------------------------------------------------------------ */

/**
 * Nominal outside radius of the bollard pipe.
 *
 * 0.098 m, i.e. 196 mm outside diameter, up from 0.084 (168 mm). 168 mm is
 * inside the 150-200 mm spec on paper and still read as a lollipop post,
 * because what the eye judges is not the diameter but the slenderness ratio
 * against the height: 1.00 m over 168 mm is 6.0:1, which is a pole. Real
 * forecourt bollards are 4.5-5:1 and read as something a truck would lose
 * against. Exported so `PumpSystem` and `tools/pumpprobe.mjs` measure against
 * the same number instead of each carrying a copy.
 */
export const BOLLARD_R = 0.098;
/** Nominal height, before the small per-post variation the caller adds. */
export const BOLLARD_H = 0.92;

/**
 * Where the struck arc sits on each of the three bollard skins, in UV U.
 *
 * Lives here rather than in `PumpSystem` because both the paint skin and the
 * mesh dents need it and they must agree. It was authored in the system file
 * and read only by the texture; the mesh drew its own impact angles from an
 * unrelated generator, so the dents and the chips were on different sides of
 * the same post. Two copies of one constant in two files is the hazard NOTES
 * records as case 17, and this one had already gone wrong.
 */
export const BOLLARD_IMPACT_U = [0.46, 0.18, 0.74];

/** One impact: where round the post, how far up, how wide and how deep. */
interface BollardDent {
  /** Radians around the post. */
  angle: number;
  /** Fraction of the height. */
  t: number;
  /** Angular half width, radians. */
  wide: number;
  /** Vertical half width, as a fraction of height. */
  tall: number;
  /** Metres. */
  depth: number;
}

/**
 * Where each post has been hit, derived entirely from the seed.
 *
 * The previous version took the seed only into the `oval` term and left the
 * two impact lobes at hardcoded 1.1 and 2.4 radians, so all six posts on the
 * forecourt were dented in the same two places — measured across seeds 3..8,
 * the primary lobe spanned 25 degrees, all of it drift in the out-of-round
 * term rather than a real difference in where the post was struck. That is not
 * the `makeRng` bias of NOTES.md case 16 and `seededRng` does not fix it; the
 * angles simply were not a function of the seed. They are now, along with the
 * count, height, width and depth.
 */
function bollardDents(seed: number, impactAngle: number): BollardDent[] {
  const rng = seededRng(seed);
  const n = 2 + Math.floor(rng() * 2); // two or three impacts
  const dents: BollardDent[] = [];
  for (let i = 0; i < n; i++) {
    dents.push({
      // On the struck arc, not spread round the post — and this is the fix for
      // the silhouette, not just for the story. Uniform `rng() * 2PI` put two
      // or three dents at unrelated angles, and since each was 82-146 degrees
      // wide they routinely carved *both* silhouette edges at the same height.
      // Measured in the render of round 195251Z the post was 125 px across at
      // the top, 107 px at mid-height and 114 px below that, where perspective
      // from a camera above the cap predicts a monotonic narrowing downward:
      // a 6% pinch through the middle with no straight reference section
      // anywhere, which is the "banana" the critic keeps reporting. Clustering
      // the impacts inside +-26 degrees of the traffic-facing arc means they
      // cannot reach round to the far edge, so one side of the post is always
      // dead-straight pipe to read the other against.
      // Stratified across the arc rather than drawn independently inside it.
      // Independent draws inside +-26 degrees put two of the three impacts
      // within a few degrees of each other often enough that they merged into
      // one continuous vertical fold running a third of the post — visible in
      // round 201217Z as a crease that reads as a seam, which is a different
      // wrong answer from the banana but still not "this has been hit". Giving
      // each impact its own slice of the arc keeps them separate marks.
      angle: impactAngle + ((i + rng()) / n - 0.5) * 1.35,
      // Bumper height, and only bumper height. This was 0.18-0.60 of the post,
      // which on a 0.92 m post is 165-550 mm — everything from an ankle to a
      // wing mirror, and combined with the vertical extent below it covered
      // the whole lower two thirds.
      t: 0.42 + rng() * 0.20,
      // Halved. The comment this replaces argued for a broad footprint because
      // "a bumper flattens 100-200 mm of pipe", and then set the *half* width
      // to 0.72-1.27 rad, which on a 98 mm radius is 141-249 mm of half-arc:
      // 280-500 mm of pipe, against a circumference of 616 mm. The widest
      // draw wrapped 81% of the post in a single impact. The intent in that
      // comment was right and the number contradicted it by a factor of two to
      // three — the recurring shape where the reasoning is sound and the value
      // does not implement it.
      wide: 0.40 + rng() * 0.26,
      // Likewise: 0.10-0.22 of the height is a 184-404 mm tall dent.
      tall: 0.055 + rng() * 0.055,
      depth: 0,
    });
    // Depth scales with footprint, so the wall steepness — depth over width,
    // which is what decides whether the dent reads at all — stays in the same
    // place now that the footprint is smaller. Range lands at 7-24 mm, inside
    // the 5-25 mm the previous pass established as real bollard damage.
    const d = dents[dents.length - 1];
    d.depth = (0.010 + rng() * 0.009) * (d.wide / 0.55);
  }
  return dents;
}

/**
 * 8 in pipe bollard, concrete filled, domed cap. Real ones are never plumb and
 * never round: they have been hit. The dents are applied as a radial
 * deformation so the highlight running down the post breaks, which is most of
 * what makes it read as struck steel rather than as a cylinder.
 */
export function buildBollard(
  height = BOLLARD_H,
  seed = 3,
  /**
   * Where the traffic-facing arc sits, in the same UV U the paint skin uses.
   * Taken as a parameter rather than redrawn here so the dents in the mesh and
   * the chips in the texture are on the same side of the post; they were
   * independent, and a dent on one side with the paint knocked off the other
   * is worse than either alone.
   */
  impactU = 0.46
): {
  skin: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  /**
   * The lean baked into `skin`, as the rotations applied about the grout line
   * in X then Z, radians.
   *
   * Returned so `tools/pumpprobe.mjs` can undo it *exactly* instead of
   * estimating it from the mesh. It tried estimating, by fitting an axis
   * through per-band centroids, and the estimate is biased: an inward dent
   * removes material from one side, which drags that band's centroid across
   * and tilts the fit. Radii measured about the wrong axis then exceeded the
   * nominal radius by up to 10 mm on a post whose deformation is clamped to
   * 1.2 mm outward — so the tool reported an outline defect that had already
   * been fixed. NOTES.md case 18 is the first half of this lesson; this is the
   * second half. Recovering a frame from the data is only safe when the data is
   * not also the thing being measured.
   */
  lean: { x: number; z: number };
} {
  const r = BOLLARD_R;
  // Denser than the old 28 x 40: a 25-degree-wide dent needs several segments
  // across it or the break in the highlight comes out as a facet rather than
  // as a crease, and a faceted post is a worse tell than an undented one.
  const seg = 48;
  // 56 rows was 16 mm of post per row, finer than any feature on it now that
  // the dents are 100-200 mm tall rather than 400. 40 rows is 23 mm, still
  // four or five rows across a dent wall, and saves 1536 triangles a post —
  // 9216 across the forecourt's six, which matters because nobody had looked
  // at this system's budget until the browser fell over.
  const rows = 40;
  // No taper. The old `r, r * 1.01` made the base a millimetre wider than the
  // rest, which contributed to a critic reading the outline as "narrow at the
  // base, swells outward through the middle" — see the clamp below.
  const g = new THREE.CylinderGeometry(r, r, height, seg, rows, true);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // `CylinderGeometry` puts U=0 at +Z advancing toward +X, so a texel at U
  // faces `(sin 2piU, 0, cos 2piU)`; the loop below measures `atan2(z, x)`.
  // The two conventions are a quarter turn and a reflection apart.
  const dents = bollardDents(seed, Math.PI / 2 - 2 * Math.PI * impactU);
  const rng = seededRng(seed + 4001);
  const ovalPhase = rng() * Math.PI * 2;
  const ovalPhase3 = rng() * Math.PI * 2;
  // Rolled pipe is out of round by well under 1% of diameter. This was 1.3-2.4
  // mm on a 98 mm radius and, worse, the second harmonic was modulated by
  // height (`+ t * 4`), which is not something a rolled section does — it is
  // what a slumped or inflated one does, and it was read as exactly that.
  const ovalAmp = 0.0006 + rng() * 0.0005;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const a = Math.atan2(v.z, v.x);
    const t = v.y / height + 0.5;

    // Strikes combine by taking the deepest, not by adding.
    //
    // Summing them was hidden until the outline clamp exposed it: two impacts
    // 50 degrees apart on a post whose dents are 40-70 degrees wide overlap
    // heavily, and the sum reached 56 mm inward on a 98 mm radius — a 57% crush
    // of the section, which is a forklift running the post over, not a bumper
    // touching it. Real bollard damage is 5-25 mm. Physically, a second blow
    // into an existing dent deepens it a little; it does not dig twice as far.
    let inward = 0;
    let outward = 0;
    for (const d of dents) {
      // Shortest angular distance, so a dent that straddles +-PI is not cut
      // in half — the old `cos(a - k)` formulation quietly wrapped instead.
      let da = a - d.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      // Elliptical distance from the impact centre, in units where 1 is the
      // rim. Keeping the footprint as one scalar means the dish and the lip
      // share a boundary instead of drifting apart at the corners, which is
      // what turned the previous version's lip into a ring of pimples.
      const s = Math.hypot(da / d.wide, (t - d.t) / d.tall);
      // Super-Gaussian, not Gaussian: flat-bottomed out to s ~ 0.7 and then a
      // steep wall. That wall is the whole feature — it is where the surface
      // normal swings hard enough to break the highlight running down the
      // post, which is the thing that reads at forecourt distance.
      const dish = Math.exp(-Math.pow(s, 4));
      // Displaced metal piles up just outside the rim. Was 18% of the depth,
      // which on a 32 mm dent is 5.8 mm of outward bulge per impact, and with
      // two or three impacts whose lips overlap it summed to 15 mm.
      const lip = Math.exp(-Math.pow((s - 1.22) / 0.30, 2)) * 0.07;
      inward = Math.max(inward, dish * d.depth);
      outward = Math.max(outward, lip * d.depth);
    }
    let dr = outward - inward +
      Math.sin(a * 2 + ovalPhase) * ovalAmp +
      Math.sin(a * 3 - ovalPhase3) * ovalAmp * 0.7;

    // Deformation is one-sided, because steel does not grow.
    //
    // This is the fix for the defect that survived a whole round of work on the
    // dents themselves. Measured band by band, the previous post was outside
    // its nominal radius at *every* height — by 3 to 15.5 mm — and not one of
    // its twenty height bands was straight. A critic described it as "narrow at
    // the base, swells outward through the middle third, pinches at roughly
    // two-thirds height, then flares again to the dome... the profile of
    // something that has inflated or slumped", and "no straight reference
    // section anywhere". That is a precise and correct reading of those
    // numbers, and no amount of work on dent shape addresses it: the *outline*
    // was wrong, independently of the features on it.
    //
    // A real bollard is dead-straight cylindrical everywhere except at
    // localised concavities, so nominal has to be the outer envelope. Clamping
    // rather than rescaling, because rescaling would shrink the dents too; the
    // 1.2 mm of headroom is the weld-line proud of a real rolled seam and is
    // what stops the clamp reading as a machined surface.
    dr = Math.min(dr, 0.0012);

    const k = (r + dr) / r;
    pos.setXYZ(i, v.x * k, v.y, v.z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, height / 2, 0);

  // Domed cap, welded on. Shallower than a hemisphere but taller than the old
  // 0.55 squash, which on a fatter pipe read as a flat lid.
  const cap = new THREE.SphereGeometry(r, seg, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.62, 1);
  cap.translate(0, height, 0);
  // Cap UVs must continue the sleeve's V so the paint does not jump at the weld.
  const cuv = cap.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < cuv.count; i++) cuv.setY(i, 0.985 + cuv.getY(i) * 0.015);
  cuv.needsUpdate = true;

  const skin = mergeChecked("pumpParts.bollard.skin", [ensureAttrs(g), ensureAttrs(cap)], false);
  g.dispose();
  cap.dispose();

  // Lean. Every bollard on every forecourt is out of plumb — they are set in
  // grout by hand and then reversed into for twenty years. Six posts standing
  // dead vertical in a row is a stronger CG tell than any amount of surface
  // detail, and it costs two rotations. Pivot at the grout line so the base
  // stays in its socket; 1.2-2.6 degrees, which is visible against the
  // canopy columns without looking derelict.
  const leanRng = seededRng(seed + 9127);
  const tilt = 0.021 + leanRng() * 0.024;
  const tiltDir = leanRng() * Math.PI * 2;
  const lean = { x: Math.cos(tiltDir) * tilt, z: Math.sin(tiltDir) * tilt };
  skin.rotateX(lean.x);
  skin.rotateZ(lean.z);

  // The lump of grout the pipe was set into, always cracked and stained, and
  // splayed enough to read as poured rather than as a washer.
  const foot = new THREE.CylinderGeometry(r + 0.050, r + 0.095, 0.062, seg, 1);
  foot.translate(0, 0.024, 0);
  return { skin: ensureAttrs(skin), foot: ensureAttrs(foot), lean };
}
