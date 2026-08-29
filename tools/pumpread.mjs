/**
 * Is the price head legible where the game actually stands the player?
 *
 * The pump is one of three named interactions, so the display is not scenery —
 * it is something a person stops and reads. That makes the question mm-per-pixel
 * arithmetic rather than taste, and it has to be asked at the *interaction*
 * pose, not a photogenic one. `PumpSystem` publishes `standPosition` as
 * `root.position + facing * 1.15`, which is where `InteractionSystem` measures
 * abandonment from, so that is the stance: the game's own opinion of where a
 * body stands to fuel.
 *
 * Reports, for each row of the head, the screen height of a digit and the screen
 * width of a lit segment stroke. The stroke is the number that decides
 * legibility: a 7-segment digit is read from its strokes, and a stroke thinner
 * than about 1.5 px cannot survive mip selection and anisotropic filtering no
 * matter how bright it is.
 *
 * Deliberately does *not* project a bounding box. The last tool that did ranked
 * a slab hidden behind proud plates as the second largest part on the model.
 * Here the quantity is a length on a flat panel of known world size, which
 * projects honestly.
 *
 *   node --import ./tools/tsregister.mjs --experimental-strip-types tools/pumpread.mjs [--selftest]
 */

import * as THREE from "three";
import { PUMP } from "../src/gen/pumpParts.ts";

const WIDTH = 1600;
const HEIGHT = 900;

/* The head's own numbers, read from the two files that own them. Kept here as
 * named constants rather than parsed, because a regex over a canvas draw call is
 * exactly the kind of measurement that has one possible output. */
const CANVAS_W = 1024;
const PANEL_W = 0.62;
const PANEL_H = 0.31;
const PANEL_Y = 1.42;
/** row, canvas cell width, canvas cell height, from `pumpDisplay.redraw()`. */
const ROWS = [
  ["SALE $", 104, 150],
  ["GALLONS", 98, 140],
  ["PRICE/GAL", 66, 96],
];
const STROKE_OF_W = 0.17; // `digit()`: t = w * 0.17, on w = cell * 0.86
const EYE = 1.62;
const STAND_OUT = 1.15;

/** Vertical pixels subtended by a length `len` on a plane `dist` away. */
const px = (len, dist, fovDeg) => (len / (2 * dist * Math.tan((fovDeg * Math.PI) / 360))) * HEIGHT;

/** Foreshortening of a horizontal length on a panel viewed `offAxis` radians off its normal. */
const foreshorten = (offAxis) => Math.cos(offAxis);

function geometry(fov) {
  // Eye at the published stand position, panel on the face it stands in front of.
  const out = STAND_OUT - PUMP.headD / 2; // eye to panel plane, horizontally
  const drop = EYE - PANEL_Y;
  const dist = Math.hypot(out, drop);
  const pitch = Math.atan2(drop, out); // looking down onto the glass
  return { dist, pitch, fov };
}

function main() {
  const fov = 44;
  const { dist, pitch } = geometry(fov);
  const mmPerCanvas = (PANEL_W / CANVAS_W) * 1000;
  console.log(`stand pose: eye ${EYE} m, ${STAND_OUT} m out from the unit centre`);
  console.log(`  panel ${PANEL_W}x${PANEL_H} m at y=${PANEL_Y}, eye-to-glass ${dist.toFixed(3)} m`);
  console.log(`  looking down ${((pitch * 180) / Math.PI).toFixed(1)}deg off the panel normal`);
  console.log(`  1 canvas px = ${mmPerCanvas.toFixed(3)} mm;  panel = ${px(PANEL_H, dist, fov).toFixed(0)} px tall\n`);

  const rows = [];
  for (const [name, cw, ch] of ROWS) {
    const dw = cw * 0.86;
    const strokeMm = dw * STROKE_OF_W * mmPerCanvas;
    const hMm = ch * mmPerCanvas;
    // A digit's height is vertical on the panel, so the downward view
    // foreshortens it; the stroke width of a vertical bar is horizontal and does
    // not. Reporting the harsher of the two for the stroke would flatter it.
    const hPx = px(hMm / 1000, dist, fov) * foreshorten(pitch);
    const sPx = px(strokeMm / 1000, dist, fov);
    rows.push({ name, hMm, strokeMm, hPx, sPx });
  }

  console.log(`row          digit h      stroke w      on screen: h      stroke`);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(11)}  ${r.hMm.toFixed(1).padStart(6)} mm  ${r.strokeMm.toFixed(1).padStart(6)} mm` +
        `      ${r.hPx.toFixed(0).padStart(5)} px  ${r.sPx.toFixed(1).padStart(6)} px`
    );
  }

  const worst = rows.reduce((a, b) => (a.sPx < b.sPx ? a : b));
  console.log(`\nthinnest stroke: ${worst.name} at ${worst.sPx.toFixed(1)} px`);
  if (worst.sPx < 1.5) {
    console.log(
      `  BELOW the ~1.5 px filtering floor. This row cannot be made legible by\n` +
        `  contrast; its strokes are being averaged away before they reach the eye.`
    );
  } else {
    console.log(
      `  ABOVE the ~1.5 px filtering floor, and the smallest digit is` +
        ` ${worst.hPx.toFixed(0)} px tall.\n  Every row therefore resolves, so any failure to read is CONTRAST, not size,` +
        `\n  and the fix is tone against the glass rather than bigger digits.`
    );
  }
}

function selftest() {
  // A 1 m length at 1 m through a 90deg vertical FOV must subtend exactly half
  // the frame height: tan(45)=1, so len/(2*1*1) * H = H/2.
  const half = px(1, 1, 90);
  const ok1 = Math.abs(half - HEIGHT / 2) < 1e-6;
  // Halving the length must halve the pixels, and doubling distance must halve them.
  const ok2 = Math.abs(px(0.5, 1, 90) - half / 2) < 1e-6;
  const ok3 = Math.abs(px(1, 2, 90) - half / 2) < 1e-6;
  // Viewing straight on must not foreshorten; 60deg off must give exactly 0.5.
  const ok4 = foreshorten(0) === 1 && Math.abs(foreshorten(Math.PI / 3) - 0.5) < 1e-12;
  // And the stand geometry must put the eye in front of the panel, looking down.
  const g = geometry(44);
  const ok5 = g.dist > 0.5 && g.dist < 1.2 && g.pitch > 0;
  console.log(
    `pumpread selftest ${ok1 && ok2 && ok3 && ok4 && ok5 ? "OK" : "FAILED"} — ` +
      `1 m at 1 m through 90deg = ${half} px of ${HEIGHT}; halving length and doubling ` +
      `distance both halve it; cos(60deg)=0.5; stand pose ${g.dist.toFixed(3)} m looking down ` +
      `${((g.pitch * 180) / Math.PI).toFixed(1)}deg.`
  );
  if (!(ok1 && ok2 && ok3 && ok4 && ok5)) process.exit(1);
}

if (process.argv.includes("--selftest")) selftest();
else main();
