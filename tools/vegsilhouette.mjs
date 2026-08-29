#!/usr/bin/env node
/**
 * CPU-only screen-space analysis of the horizon silhouette. No GPU.
 *
 * `tools/vegprofile.mjs` measures the band's top edge in *world* space and says
 * it is fine — irregular pitch, 4.5x height spread, no plateaux. The critic
 * nonetheless sees a regular sawtooth. Those are not in conflict: what reaches
 * the eye is the *projected* silhouette, and projection mixes in the radial
 * wander (which changes each sample's distance, hence its apparent height), the
 * camera's eye height (which decides how much of the band clears the horizon),
 * and the sample pitch in pixels (which decides whether the profile aliases).
 *
 * A band whose mean canopy clears the horizon by 7 px and whose peaks clear it
 * by 26 px is, on screen, almost entirely peaks — the "comb" — even though in
 * world space it is a gently varying canopy. That distinction is only visible
 * in this measurement, so this is the tool that should have existed first.
 *
 *   node tools/vegsilhouette.mjs [preset]
 */
import { rmSync } from "node:fs";
import { build } from "vite";

await build({ configFile: "tools/vegcpu.vite.config.mjs" });
const { bands, topEdge } = await import("../.shot-build/cpu/vegprofile.mjs");

const VIEW_W = 1600;
const VIEW_H = 900;
const POSES = {
  approach: { pos: [-30.0, 1.65, -7.6], look: [-1.0, 1.6, 20.0], fov: 46 },
  edge: { pos: [-27.0, 0.5, 6.15], look: [8.0, 0.3, 7.2], fov: 44 },
  pines: { pos: [14.0, 1.62, 34.0], look: [-32.0, 6.0, 19.0], fov: 55 },
  horizon: { pos: [34.0, 1.65, 20.0], look: [110.0, 3.0, 90.0], fov: 36 },
  wide: { pos: [-46.0, 12.5, -24.0], look: [3.0, 0.4, 25.0], fov: 46 },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => mul(a, 1 / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function makeCamera(p) {
  const fwd = norm(sub(p.look, p.pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const tanHalf = Math.tan((p.fov * 0.5 * Math.PI) / 180);
  const aspect = VIEW_W / VIEW_H;
  return {
    project(w) {
      const d = sub(w, p.pos);
      const z = dot(d, fwd);
      if (z <= 0.05) return null;
      const x = dot(d, right) / (z * tanHalf * aspect);
      const y = dot(d, up) / (z * tanHalf);
      if (x < -1.05 || x > 1.05) return null;
      return { sx: (x * 0.5 + 0.5) * VIEW_W, sy: (0.5 - y * 0.5) * VIEW_H, z };
    },
  };
}

/** Prominence-filtered peaks of a screen-space polyline. */
function prominentPeaks(pts, minProminence) {
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (!(pts[i].sy < pts[i - 1].sy && pts[i].sy <= pts[i + 1].sy)) continue;
    // Walk out both ways to the flanking minima (largest sy).
    let l = i;
    while (l > 0 && pts[l - 1].sy >= pts[l].sy) l--;
    let r = i;
    while (r < pts.length - 1 && pts[r + 1].sy >= pts[r].sy) r++;
    const prom = Math.min(pts[l].sy, pts[r].sy) - pts[i].sy;
    if (prom >= minProminence) out.push({ i, sx: pts[i].sx, sy: pts[i].sy, prom });
  }
  return out;
}

const stats = (xs) => {
  if (!xs.length) return { n: 0, mean: NaN, sd: NaN, cv: NaN, min: NaN, max: NaN };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  const s = [...xs].sort((a, b) => a - b);
  return { n: xs.length, mean: m, sd, cv: sd / m, min: s[0], max: s[s.length - 1] };
};

const which = process.argv[2];
for (const [name, pose] of Object.entries(POSES)) {
  if (which && name !== which) continue;
  const cam = makeCamera(pose);
  // Horizon line for this camera: a point at infinity level with the eye.
  const fwd = norm(sub(pose.look, pose.pos));
  const hz = cam.project([pose.pos[0] + fwd[0] * 1e6, pose.pos[1], pose.pos[2] + fwd[2] * 1e6]);
  console.log(`\n######## ${name}  fov ${pose.fov}  eye ${pose.pos[1]} m   horizon at y=${hz ? hz.sy.toFixed(1) : "?"} px`);

  for (const spec of bands) {
    const edge = topEdge(spec);
    const pts = [];
    for (const w of edge) {
      if (w.y <= 0) continue;
      const p = cam.project([w.x, w.y, w.z]);
      if (p) pts.push(p);
    }
    pts.sort((a, b) => a.sx - b.sx);
    if (pts.length < 8) {
      console.log(`  band r=${spec.radius}: ${pts.length} samples on screen — not visible here`);
      continue;
    }
    const clearance = pts.map((p) => (hz ? hz.sy - p.sy : 0));
    const cs = stats(clearance);
    const spacing = [];
    for (let i = 1; i < pts.length; i++) spacing.push(pts[i].sx - pts[i - 1].sx);
    const ss = stats(spacing);

    const pk = prominentPeaks(pts, 2);
    const pitch = [];
    for (let i = 1; i < pk.length; i++) pitch.push(pk[i].sx - pk[i - 1].sx);
    const ps = stats(pitch);
    const proms = stats(pk.map((p) => p.prom));

    console.log(`  band r=${spec.radius} m`);
    console.log(
      `    ${pts.length} samples across the frame, ${ss.mean.toFixed(2)} px apart` +
        (ss.mean < 2 ? "   <-- BELOW 2 px: profile aliases" : "")
    );
    console.log(
      `    clears the horizon by ${cs.mean.toFixed(1)} px mean, ${cs.max.toFixed(1)} px max, ${cs.min.toFixed(1)} px min` +
        `   peak/mean ${(cs.max / Math.max(0.01, cs.mean)).toFixed(2)}x`
    );
    console.log(
      `    prominent peaks (>=2 px): ${pk.length}   pitch mean ${ps.mean?.toFixed(1)} px  CV ${ps.cv?.toFixed(2)}` +
        `   prominence mean ${proms.mean?.toFixed(1)} px  max/min ${(proms.max / Math.max(0.5, proms.min)).toFixed(1)}x`
    );

    const v = [];
    if (ss.mean < 2.5) v.push(`sample pitch ${ss.mean.toFixed(2)} px is at or under the alias limit`);
    if (cs.mean > 0.5 && cs.max / cs.mean > 2.6)
      v.push(`silhouette is mostly teeth: peaks are ${(cs.max / cs.mean).toFixed(1)}x the mean clearance`);
    if (pk.length > 12 && ps.cv < 0.6) v.push(`peak pitch CV ${ps.cv.toFixed(2)} reads as a regular comb (want > 0.7)`);
    if (pk.length > 12 && proms.max / Math.max(0.5, proms.min) < 4)
      v.push(`peak prominence spread only ${(proms.max / Math.max(0.5, proms.min)).toFixed(1)}x (critic asks 3-4x in height)`);
    for (const s of v) console.log(`    !! ${s}`);
  }
}

rmSync(".shot-build/cpu", { recursive: true, force: true });
