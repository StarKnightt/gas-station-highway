#!/usr/bin/env node
/**
 * Finds the anomalies in a capture *without being told where to look*.
 *
 * Every pixel instrument in this repo so far takes the region from the person
 * running it — `regionstat` takes rectangles, `edgeread` takes an x and a y,
 * `vegprobe` takes a box. That is fine when you already know where the defect
 * is, and it is exactly wrong when the question is "why does the critic see
 * something I do not". An agent who picks the coordinates picks them where the
 * feature it just built is, gets a true number about that spot, and never
 * visits the twenty pixel rows the critic actually reacted to.
 *
 * The other half of the same problem is the axis. `vegband` asserts luminance
 * against a floor, and it passed on `wide.png` at band luma 99.6 while two
 * critics independently described a cold blue band at the horizon — because a
 * band can be perfectly well lit and still be the wrong *hue* for its
 * surroundings, and nothing in the toolchain asserted hue anywhere.
 *
 * So this scans the whole frame, chooses nothing, and reports three things
 * that a viewer reacts to and that a hand-placed probe systematically misses:
 *
 *   COOL INVERSION - a horizontal run of rows whose warm/cool balance (R-B)
 *       sits below both the run above it and the run below it. A dawn scene is
 *       warm nearly everywhere, so a cool strip between two warm ones is read
 *       as a different *substance*: water, haze, glass. This is what "the
 *       horizon reads as water" is, expressed as a number.
 *
 *   FLAT BAND - a run of rows whose within-row standard deviation is far below
 *       the frame's, i.e. a region with no texture at all. Flatness is the
 *       other half of reading as water, and it is also how "one cutout" and
 *       "a painted-on panel" show up.
 *
 *   DEAD ZONE - a run of rows whose detail (mean absolute horizontal gradient)
 *       collapses relative to the rows in front of it. Ground vegetation that
 *       "stops dead past thirty metres" is precisely this: the near rows carry
 *       clumps and the far rows carry none, with a step between them.
 *
 * The sky is excluded by taking the frame's own skyline, and every reported run
 * comes with the exact rectangle to hand to `regionstat.mjs` so the finding can
 * be confirmed with the tool the rest of the project already trusts.
 *
 *   node tools/framescan.mjs <png> [more.png ...] [--x0=N --x1=N] [--quiet]
 *
 * Exits non-zero if any frame reports a finding, so a harness can gate on it.
 * Pure computation, no GPU, no server, nothing to tear down.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const num = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
const QUIET = argv.includes("--quiet");

if (!files.length && !argv.includes("--selftest")) {
  console.error("usage: framescan.mjs <png> [...] [--x0=N --x1=N] | --selftest");
  process.exit(2);
}

/* Thresholds. Each is stated with the observation that set it, because a
 * threshold whose provenance is lost is the thing that later gets "tuned"
 * until the metric stops firing (NOTES.md case 25). */

/** R-B levels a run must sit below *both* its neighbours by. The wide.png band
 *  that two critics called water is 13.8 below the ground above it and 21.4
 *  below the ground below it; ordinary shading gradients in these frames run
 *  under 4. */
const COOL_DROP = 8;
/** ...and the run must also be *cool in absolute terms*, not merely less warm
 *  than its neighbours. Without this the metric fires on every pump close-up,
 *  where a shaded panel sits at R-B 23 between two at 36 and is warm paint
 *  under a warm sun in all three places. NOTES.md case 25: a metric that fires
 *  on correct output is worse than no metric.
 *
 *  AUDITED AND KEPT, 2026-08-29, after Lighting established that the warm cast
 *  every agent had been preserving in shadow came from a ground disc 7.6x too
 *  bright and 12x too warm — so warm key against cool shadow is dawn, and
 *  uniformly warm shadow is a preset. I was asked to retire any gate asserting
 *  warmth in shadow and this looked like one. It is not, and the direction
 *  matters: this clause is a **precondition on reporting a defect**, not an
 *  assertion about correct output. A cooler, correct world makes it fire more
 *  readily, not less, so it cannot be preserving the old cast.
 *
 *  Removing it was tried and measured, not reasoned about. Across the seven
 *  poses the finding count went 4 -> 14, and the new firings sit at R-B 28.2
 *  against 42.4, and 27.4 between 45.2 and 41.0 — warm ground beside warmer
 *  ground, which is the pump-close-up false positive this clause was written
 *  for in the first place. Replacing the constant with a frame-relative cool
 *  tail was also tried: it does not help, because the 20th percentile of a
 *  uniformly warm frame is still warm and lets the same regions through.
 *
 *  The reason a constant is right here where it is usually wrong: the quantity
 *  is not a property of the population being sampled. Water, glass and haze are
 *  cool in absolute terms because of what they are, so "has this crossed into
 *  cool" is a physical question with a fixed answer, not a percentile of
 *  whatever else is in the frame.
 *
 *  Recorded in NOTES.md as the counterexample to the percentile case, and
 *  cross-referenced from the rule itself so the next reader meets both at once.
 *  The test, if you are holding a threshold and wondering which kind it is: ask
 *  what the number would be if the scene were different. If the answer depends
 *  on what else is in the frame it is a percentile and should be expressed as
 *  the statistic it is really targeting. If it is a property of the material,
 *  the physics, or human perception, it is a constant and should stay one.
 *  R-B for water is the second kind. */
const COOL_ABS = 6;
/** Whether COOL_ABS may reject on its own. False since the ambient fix: see
 *  above. Left as a named constant rather than deleted so that anyone reading
 *  a past round's verdict can see which rule produced it. */
const COOL_ABS_IS_VETO = false;
/** The flat-band and dead-zone tests assume a receding ground plane, so they
 *  only run on a frame with a real horizon. A pump close-up has a large smooth
 *  panel in it and that is not a defect. */
const HORIZON_AGREE = 0.5;
/** Minimum rows in a run. Twenty pixels at 1600x900 is a band you cannot miss;
 *  three is a shading edge. */
const MIN_RUN = 8;
/** A flat band is one whose row texture is this fraction of the ground median. */
const FLAT_RATIO = 0.45;
/** A dead zone's detail is this fraction of the band immediately in front. */
const DEAD_RATIO = 0.35;

function scan(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const W = png.width;
  const H = png.height;
  const x0 = Math.max(0, num("x0", 0));
  const x1 = Math.min(W, num("x1", W));

  const px = (x, y) => {
    const i = (y * W + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  /* --- per-row statistics over the requested column span ------------- */
  const row = [];
  for (let y = 0; y < H; y++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    let sL = 0;
    let sL2 = 0;
    let grad = 0;
    let sC = 0;
    let prev = null;
    for (let x = x0; x < x1; x++) {
      const c = px(x, y);
      const L = luma(c);
      r += c[0];
      g += c[1];
      b += c[2];
      sL += L;
      sL2 += L * L;
      // Per-pixel chroma, averaged. Not the chroma of the row mean: averaging
      // the colours first and measuring saturation after reports a flat grey
      // for a row of alternating strong red and strong green, which is the
      // same "measure the aggregate instead of aggregating the measurement"
      // mistake this file exists to avoid.
      sC += Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      if (prev !== null) grad += Math.abs(L - prev);
      prev = L;
      n++;
    }
    const mL = sL / n;
    row.push({
      y,
      r: r / n,
      g: g / n,
      b: b / n,
      rb: (r - b) / n,
      luma: mL,
      chroma: sC / n,
      sd: Math.sqrt(Math.max(0, sL2 / n - mL * mL)),
      grad: grad / Math.max(1, n - 1),
    });
  }

  /* --- where does the ground start? ---------------------------------- */
  // The modal skyline, not the mean: in a frame with a pine in it the mean is
  // pulled up into the crowns and every subsequent statistic is a blend of
  // tree and horizon. That blending is one of the two reasons `vegband`
  // reported a healthy band on a frame with a defect in it.
  const tops = [];
  for (let x = x0; x < x1; x++) {
    for (let y = Math.round(H * 0.05); y < H - 1; y++) {
      if (luma(px(x, y)) - luma(px(x, y + 1)) > 25) {
        tops.push(y + 1);
        break;
      }
    }
  }
  let ground = Math.round(H * 0.35);
  let modalShare = 0;
  if (tops.length) {
    const bucket = new Map();
    for (const t of tops) {
      const k = Math.floor(t / 10) * 10;
      bucket.set(k, (bucket.get(k) ?? 0) + 1);
    }
    const [k, c] = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0];
    ground = k;
    modalShare = c / tops.length;
  }

  const rel = path.relative(process.cwd(), file) || file;
  console.log(`\n${rel}  ${W}x${H}  columns ${x0}..${x1}`);
  console.log(
    `  skyline: modal row ${ground}, ${(modalShare * 100).toFixed(0)}% of columns agree` +
      (modalShare < 0.5
        ? `  !! only ${(modalShare * 100).toFixed(0)}% — this frame has objects crossing the horizon,` +
          ` so any statistic averaged over "the row below the skyline" is a blend`
        : "")
  );

  const band = row.slice(ground + 2, H - 2);
  if (band.length < MIN_RUN * 3) {
    console.log("  ground band too short to scan");
    return [];
  }
  const medSd = [...band.map((v) => v.sd)].sort((a, b) => a - b)[band.length >> 1];
  const hits = [];

  /* --- RULED HORIZON, and a band brighter than the sky ----------------- */
  // Added because this scanner reported zero findings on a frame a human called
  // "unmistakably a distant lake... a serious, immediately noticeable artefact".
  // That made it the fourth guard in one day to pass confidently while checking
  // the wrong property, so it is worth being exact about which property.
  //
  // The existing test looks for a run *cooler* than its neighbours, because that
  // is what the previous artefact was. This one is the opposite sign, and the
  // tonal reading turned out to be a symptom rather than the cause: measured in
  // clean columns the pale strip peaks at luma 171.5, while the brightest horizon
  // band in that scene authors to about 152. The strip is **sky**. What makes sky
  // read as water is what sits under it — a skyline at a near-constant row with a
  // 79-luma drop across eight pixels. A shoreline.
  //
  // So the general property is not a colour. It is: **the horizon is a ruled
  // edge.** Real distant vegetation has a skyline whose row wanders column to
  // column. A flat-topped backdrop does not, and every "reads as water",
  // "cardboard cutout" and "dead-straight ruled edge" report in this project has
  // had that behind it.
  //
  // Measured per column, not on row means. My first attempt averaged the step
  // over the full width and got 19 luma for an edge that is 79 in clean columns,
  // because buildings and trees occupy some columns and smooth it out — the same
  // averaging mistake that made `vegband` pass a broken frame. Both halves are
  // reported because either alone is ambiguous: a hard step with a ragged skyline
  // is a legitimate dark treeline, and a straight skyline with a soft step is
  // haze.
  {
    // Two corrections to how this set is chosen and measured, both of which
    // were making the number an artefact of the instrument. They were found by
    // capturing a round in which the *fix* for a ruled horizon moved the
    // reported raggedness the wrong way (0.96 px -> 0.69 px) while the frame,
    // looked at, plainly undulates.
    //
    // (a) THE GATE WAS TWO-SIDED AND IT SELECTED FLAT COLUMNS. It kept only
    //     columns whose skyline sat within 12 px of the modal row, then
    //     averaged how far the skyline moves between adjacent survivors. On a
    //     frame whose skyline genuinely wanders 30 px that discards precisely
    //     the columns that wander, so it is an average over a population
    //     selected for not moving — this file's own recurring failure, one
    //     level up from the frame into the sample. Measured on one frame:
    //     0.69 px through the gate against 10.5 px without it.
    //     The gate is now ONE-SIDED, which is what the geometry supports.
    //     Trees, poles and parapets stand in front of the horizon and are
    //     taller than it, so an object can only ever push a column's skyline
    //     *up*. A column below the modal row is never an object; it is the
    //     horizon dipping, which is the signal. So: reject above, keep below.
    //
    // (b) AN INTEGER ROW INDEX CANNOT RESOLVE THE THING BEING ASKED ABOUT.
    //     "% of adjacent columns identical" on a whole-pixel row is a measure
    //     of quantisation for any edge moving under one pixel per column — and
    //     an edge moving under a pixel per column is exactly the case in
    //     dispute. The sub-pixel position below is the linear crossing of the
    //     half-way luma between that column's own sky and its own ground, so
    //     the reference is local and on both sides.
    const colEdge = [];
    for (let x = x0; x < x1; x++) {
      for (let y = Math.round(H * 0.05); y < H - 6; y++) {
        if (luma(px(x, y)) - luma(px(x, y + 1)) > 25) {
          const yi = y + 1;
          const skyHere = luma(px(x, Math.max(0, yi - 4)));
          const gndHere = luma(px(x, Math.min(H - 1, yi + 4)));
          const half = (skyHere + gndHere) / 2;
          let sy = yi;
          for (let k = yi - 4; k < yi + 4; k++) {
            const a = luma(px(x, k));
            const b = luma(px(x, k + 1));
            if (a >= half && b < half) {
              sy = k + (a - half) / Math.max(1e-6, a - b);
              break;
            }
          }
          colEdge.push({ x, y: yi, sy });
          break;
        }
      }
    }
    const horizonCols = colEdge.filter((c) => c.y >= ground - 12);
    const rejected = colEdge.length - horizonCols.length;
    if (horizonCols.length >= (x1 - x0) * 0.15) {
      const med = (a) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0);
      // Raggedness: how far the skyline moves between adjacent horizon columns.
      const jumps = [];
      const subJumps = [];
      for (let i = 1; i < horizonCols.length; i++)
        if (horizonCols[i].x === horizonCols[i - 1].x + 1) {
          jumps.push(Math.abs(horizonCols[i].y - horizonCols[i - 1].y));
          subJumps.push(Math.abs(horizonCols[i].sy - horizonCols[i - 1].sy));
        }
      const ragged = med(jumps);
      const raggedMean = jumps.length ? jumps.reduce((t, v) => t + v, 0) / jumps.length : 0;
      const subMean = subJumps.length ? subJumps.reduce((t, v) => t + v, 0) / subJumps.length : 0;
      const flatFrac = jumps.length ? jumps.filter((v) => v === 0).length / jumps.length : 0;
      // How far the skyline ranges over the whole frame, which is the other
      // half of "ruled" and the half a per-column jump cannot see: an edge can
      // step a quarter pixel per column and still cross 40 px of frame, and
      // that is a landscape. An edge that is flat locally *and* globally is a
      // rule.
      const sorted = [...horizonCols.map((c) => c.sy)].sort((p, q) => p - q);
      const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      const spread = pct(0.95) - pct(0.05);
      // The longest run of columns on exactly the same row. A drawn line has
      // one enormous run; a canopy has none worth naming.
      let longest = 0;
      let cur = 1;
      for (let i = 1; i < horizonCols.length; i++) {
        if (horizonCols[i].x === horizonCols[i - 1].x + 1 && horizonCols[i].y === horizonCols[i - 1].y) cur++;
        else {
          if (cur > longest) longest = cur;
          cur = 1;
        }
      }
      if (cur > longest) longest = cur;
      // The step each column actually shows across its own skyline.
      const steps = horizonCols
        .filter((c) => c.y > 5 && c.y < H - 6)
        .map((c) => luma(px(c.x, c.y - 4)) - luma(px(c.x, c.y + 4)));
      const step = med(steps);
      // Sky and near-ground, per column, so neither reference is an average over
      // content that is not sky or not ground.
      const skyL = med(horizonCols.map((c) => luma(px(c.x, Math.max(0, c.y - 26)))));
      const underL = med(horizonCols.map((c) => luma(px(c.x, Math.min(H - 1, c.y + 5)))));
      const chroma = (c) => Math.max(...c) - Math.min(...c);
      const skyC = med(horizonCols.map((c) => chroma(px(c.x, Math.max(0, c.y - 26)))));
      console.log(
        `  horizon edge: ${horizonCols.length} columns (${rejected} rejected as objects above the ` +
          `skyline), step ${step.toFixed(0)} luma, sky ${skyL.toFixed(0)} -> under ${underL.toFixed(0)}`
      );
      console.log(
        `    mean jump ${subMean.toFixed(2)} px sub-pixel (${raggedMean.toFixed(2)} px whole-row, ` +
          `median ${ragged.toFixed(1)}), p05..p95 spread ${spread.toFixed(1)} px, longest identical ` +
          `run ${longest} columns, ${(flatFrac * 100).toFixed(0)}% of adjacent columns on the same row`
      );
      // Both halves must be flat, and this is the correction that stopped the
      // test firing on all seven frames of a healthy round.
      //
      // The old condition was `median whole-row jump <= 1 && step >= 30`. The
      // median of a set of integers is 0 the moment more than half of them are
      // 0, which happens for *any* edge moving under about one pixel per
      // column — including every legitimate distant treeline this project will
      // ever draw. It was therefore a test for "the horizon is far away",
      // dressed as a test for "the horizon is a drawn line", and per NOTES case
      // 25 a metric that fires on correct output is worse than no metric.
      //
      // The two thresholds below are set from measured frames rather than
      // chosen: on round 2026-08-28T192658Z the seven poses run 0.6..3.0 px of
      // sub-pixel jump over 26..90 px of spread and none of them is a ruled
      // line to look at, while a genuinely drawn edge is 0 and 0 by
      // construction. `--selftest` carries both a planted straight horizon,
      // which must fire, and a planted wandering one, which must not.
      const RULED_JUMP = 0.25;
      const RULED_SPREAD = 6;
      if (subMean < RULED_JUMP && spread < RULED_SPREAD && step >= 30) {
        hits.push({
          kind: "RULED HORIZON",
          y0: ground - 2,
          y1: ground + 6,
          detail:
            `the skyline moves ${subMean.toFixed(2)} px between adjacent columns and covers only ` +
            `${spread.toFixed(1)} px across the whole frame, with a longest identical run of ` +
            `${longest} columns, while dropping ${step.toFixed(0)} luma across it — flat locally ` +
            `and flat globally is a ruled edge, not vegetation. A flat top edge under bright sky ` +
            `acts as a shoreline and makes the sky above it read as water`,
        });
      }
      // The tonal half, generalised to either direction rather than just cool.
      const bandTop = med(
        horizonCols.map((c) => luma(px(c.x, Math.max(0, c.y - 8))))
      );
      const bandC = med(horizonCols.map((c) => chroma(px(c.x, Math.max(0, c.y - 8)))));
      // Two ways for the same strip to read as water, and the tool previously
      // only had one of each pair: it tested *cooler* than its neighbours
      // (COOL INVERSION) and *brighter* than the sky. It had no test for
      // **more desaturated**, and desaturation is the reading that does not
      // depend on which way the hue happens to sit — a pale grey strip under a
      // warm sky is water, and so is a pale grey strip under a cool one.
      // Reported as a separate clause rather than folded into the brightness
      // one so that a frame failing only on saturation says so.
      if (bandTop > skyL + 6) {
        hits.push({
          kind: "BAND BRIGHTER THAN SKY",
          y0: Math.max(0, ground - 14),
          y1: ground,
          detail:
            `the strip just above the skyline reads ${bandTop.toFixed(0)} against sky ` +
            `${skyL.toFixed(0)} higher up, chroma ${bandC.toFixed(1)} against ${skyC.toFixed(1)} — ` +
            `a pale strip at the horizon reads as water or fog whichever way its hue sits`,
        });
      } else if (skyC >= 4 && bandC < skyC * 0.55) {
        hits.push({
          kind: "BAND DESATURATED AGAINST SKY",
          y0: Math.max(0, ground - 14),
          y1: ground,
          detail:
            `the strip just above the skyline carries chroma ${bandC.toFixed(1)} against ` +
            `${skyC.toFixed(1)} in the sky above it, at luma ${bandTop.toFixed(0)} against ` +
            `${skyL.toFixed(0)} — a strip that loses its colour while keeping its brightness is ` +
            `read as haze or standing water, and no luminance test can see it`,
        });
      }
    }
  }

  /* --- COOL INVERSION ------------------------------------------------- */
  // Slide a window; a run qualifies when its mean R-B is COOL_DROP below the
  // mean of the equally sized run above AND the one below. Requiring both is
  // what separates a cool band from a simple warm-to-cool gradient, which is
  // legitimate aerial perspective and must not fire.
  // Swept over several run lengths, which is not optional: the band in
  // `wide.png` is 20 rows tall, and a single fixed 8-row window put its own
  // reference block *inside* the band and cancelled the very difference it
  // exists to find. Same shape as NOTES.md case 23 — a test whose reference
  // moves with the thing being tested reports health.
  {
    const m = (a) => a.reduce((s, v) => s + v.rb, 0) / a.length;
    const cand = [];
    for (const L of [8, 12, 16, 24, 32, 48]) {
      if (L * 3 > band.length) break;
      for (let i = L; i + L * 2 <= band.length; i += Math.max(2, L >> 2)) {
        const mid = band.slice(i, i + L);
        const above = band.slice(i - L, i);
        const below = band.slice(i + L, i + 2 * L);
        const mm = m(mid);
        const dA = m(above) - mm;
        const dB = m(below) - mm;
        if (dA >= COOL_DROP && dB >= COOL_DROP && mm <= COOL_ABS) {
          cand.push({ lo: i, hi: i + L, score: Math.min(dA, dB), rb: mm, a: m(above), b: m(below) });
        }
      }
    }
    // Keep the strongest, then drop anything overlapping it, so a band found
    // at four window sizes is reported once.
    cand.sort((p, q) => q.score - p.score);
    const kept = [];
    for (const c of cand) {
      if (kept.some((k) => c.lo < k.hi && k.lo < c.hi)) continue;
      kept.push(c);
    }
    // A band that starts *at* the skyline has no ground above it to be warm,
    // so the two-sided test above cannot see it — and that is the worse case,
    // not a rarer one: round 2026-08-28T171609Z's `wide.png` carries the same
    // artefact at R-B -37 with its top row touching the horizon, and the
    // two-sided sweep reported it clean. So the topmost run of ground is
    // tested separately, against the ground further down only.
    if (!kept.some((k) => k.lo < MIN_RUN)) {
      for (const L of [8, 12, 16, 24, 32, 48]) {
        if (L * 3 > band.length) break;
        const mid = band.slice(0, L);
        const below = band.slice(L, L * 3);
        const mm = m(mid);
        const dB = m(below) - mm;
        if (dB >= COOL_DROP && mm <= COOL_ABS) {
          const c = { lo: 0, hi: L, score: dB, rb: mm, a: NaN, b: m(below) };
          if (!kept.some((k) => c.lo < k.hi && k.lo < c.hi)) kept.push(c);
          break;
        }
      }
    }
    for (const c of kept.sort((p, q) => p.lo - q.lo)) {
      if (Number.isNaN(c.a)) {
        hits.push({
          kind: "COOL INVERSION",
          y0: band[c.lo].y,
          y1: band[c.hi - 1].y,
          detail:
            `R-B ${c.rb.toFixed(1)} in the first rows of ground, against ${c.b.toFixed(1)} further down` +
            ` — the ground starts cool and turns warm, which is a material boundary at the horizon,` +
            ` not aerial perspective`,
        });
        continue;
      }
      hits.push({
        kind: "COOL INVERSION",
        y0: band[c.lo].y,
        y1: band[c.hi - 1].y,
        detail:
          `R-B ${c.rb.toFixed(1)} against ${c.a.toFixed(1)} above and ${c.b.toFixed(1)} below` +
          ` — a cool strip between two warm ones reads as a different material` +
          ` (water, haze, glass), not as distance`,
      });
    }
  }

  /* --- PALE BAND ------------------------------------------------------- */
  // The same two-sided sweep as COOL INVERSION, on saturation instead of
  // warm/cool, and it exists because the cool test missed a real artefact.
  //
  // A capture of round 2026-08-28T192658Z shows an unmistakable lake below the
  // treeline in `wide.png`: a flat band with a straight top edge, running the
  // full width, that survives `?vforce=noline` unchanged and is therefore the
  // far ground plane and not this system's geometry. What identifies it to the
  // eye is not that it is cool — it is barely cool, R-B -1.0 — but that it has
  // lost almost all of its colour while the dirt above and below it keeps
  // hers. Water and wet haze desaturate; distance alone does not, or not
  // nearly as fast.
  //
  // Same window sweep and same reasoning as the cool test: a single fixed
  // window puts its own reference inside the band it is looking for.
  {
    const m = (a) => a.reduce((s, v) => s + v.chroma, 0) / a.length;
    /** Chroma levels the run must sit below both neighbours by. */
    const PALE_DROP = 4;
    const cand = [];
    for (const L of [8, 12, 16, 24, 32, 48]) {
      if (L * 3 > band.length) break;
      for (let i = L; i + L * 2 <= band.length; i += Math.max(2, L >> 2)) {
        const mid = band.slice(i, i + L);
        const mm = m(mid);
        const dA = m(band.slice(i - L, i)) - mm;
        const dB = m(band.slice(i + L, i + 2 * L)) - mm;
        // Relative as well as absolute: losing 4 of 30 chroma is a shading
        // change, losing 4 of 9 is a different substance.
        if (dA >= PALE_DROP && dB >= PALE_DROP && mm < (mm + Math.min(dA, dB)) * 0.7) {
          cand.push({ lo: i, hi: i + L, score: Math.min(dA, dB), c: mm, a: m(band.slice(i - L, i)), b: m(band.slice(i + L, i + 2 * L)) });
        }
      }
    }
    cand.sort((p, q) => q.score - p.score);
    const kept = [];
    for (const c of cand) {
      if (kept.some((k) => c.lo < k.hi && k.lo < c.hi)) continue;
      kept.push(c);
    }
    for (const c of kept.sort((p, q) => p.lo - q.lo)) {
      hits.push({
        kind: "PALE BAND",
        y0: band[c.lo].y,
        y1: band[c.hi - 1].y,
        detail:
          `chroma ${c.c.toFixed(1)} against ${c.a.toFixed(1)} above and ${c.b.toFixed(1)} below` +
          ` — a strip that has lost its colour between two that have not is read as water or wet` +
          ` haze, and it is invisible to both a luminance test and a warm/cool test`,
      });
    }
  }

  /* --- FLAT BAND ------------------------------------------------------ */
  if (modalShare < HORIZON_AGREE) {
    console.log(
      `  flat-band and dead-zone tests skipped: no agreed horizon in this frame,` +
        ` and both assume a receding ground plane`
    );
  } else {
    let run = null;
    for (let i = 0; i <= band.length; i++) {
      const flat = i < band.length && band[i].sd < medSd * FLAT_RATIO;
      if (flat && !run) run = { from: i, to: i };
      else if (flat) run.to = i;
      else if (run) {
        if (run.to - run.from + 1 >= MIN_RUN * 2) {
          const rows = band.slice(run.from, run.to + 1);
          const sd = rows.reduce((s, v) => s + v.sd, 0) / rows.length;
          hits.push({
            kind: "FLAT BAND",
            y0: rows[0].y,
            y1: rows[rows.length - 1].y,
            detail:
              `row texture sd ${sd.toFixed(1)} against a ground median of ${medSd.toFixed(1)}` +
              ` — ${(rows.length)} rows carrying no detail at all`,
          });
        }
        run = null;
      }
    }
  }

  /* --- DEAD ZONE ------------------------------------------------------ */
  // Compare each block of rows against the block below it, i.e. against the
  // same surface nearer the camera. Detail must fall off with distance; a
  // *step* down rather than a falloff is a cull distance or a missing layer.
  if (modalShare >= HORIZON_AGREE) {
    const blk = MIN_RUN * 2;
    for (let i = 0; i + blk * 2 <= band.length; i += blk) {
      const far = band.slice(i, i + blk);
      const near = band.slice(i + blk, i + blk * 2);
      const g = (a) => a.reduce((s, v) => s + v.grad, 0) / a.length;
      if (g(near) > 1 && g(far) < g(near) * DEAD_RATIO) {
        hits.push({
          kind: "DEAD ZONE",
          y0: far[0].y,
          y1: far[far.length - 1].y,
          detail:
            `detail ${g(far).toFixed(2)} against ${g(near).toFixed(2)} in the ${blk} rows nearer the` +
            ` camera — a step, not a falloff, so something stops being drawn here`,
        });
      }
    }
  }

  if (!hits.length) {
    console.log("  no cool inversion, flat band or dead zone found");
    return hits;
  }
  for (const h of hits) {
    console.log(`  !! ${h.kind}  rows ${h.y0}..${h.y1}`);
    console.log(`     ${h.detail}`);
    if (!QUIET) {
      console.log(
        `     confirm: node tools/regionstat.mjs ${rel} ` +
          `${x0},${h.y0},${x1 - x0},${h.y1 - h.y0 + 1}:suspect ` +
          `${x0},${Math.max(0, h.y0 - 30)},${x1 - x0},20:above ` +
          `${x0},${Math.min(H - 20, h.y1 + 10)},${x1 - x0},20:below`
      );
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* known-bad and known-good controls                                   */
/* ------------------------------------------------------------------ */

/**
 * Two synthetic frames, per the discipline in NOTES.md: a probe that cannot
 * fail is not evidence, and a probe that fires on correct output gets ignored.
 * `--selftest` builds one frame carrying a deliberate cool band, which MUST be
 * reported, and one carrying only a legitimate warm-to-cool aerial gradient,
 * which MUST NOT be. If either moves, this tool is broken rather than the
 * scene being clean.
 */
function selftest() {
  const W = 400;
  const H = 400;
  const make = (name, coolBand) => {
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let r;
        let g;
        let b;
        if (y < 150) {
          // sky, bright, so the skyline detector has a step to find
          r = 190;
          g = 190;
          b = 200;
        } else {
          // ground: warm, cooling gently with distance, with texture so the
          // flat-band test has a nonzero median to compare against
          const t = (H - y) / (H - 150);
          const n = ((x * 37 + y * 11) % 23) - 11;
          r = 120 + n;
          g = 100 + n;
          b = 100 - 24 * (1 - t) + n;
          if (coolBand && y >= 200 && y < 224) {
            r = 96 + n;
            g = 100 + n;
            b = 112 + n;
          }
        }
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
    }
    const out = path.join(os.tmpdir(), `framescan-selftest-${name}.png`);
    fs.writeFileSync(out, PNG.sync.write(png));
    return out;
  };

  /**
   * The RULED HORIZON pair. The cool-band controls above say nothing about it,
   * and it needs its own because its threshold was just moved: the previous
   * condition fired on all seven frames of a healthy round, so it had no
   * discriminating power at all and nothing in this file could tell.
   *
   * `wander` is the control that has to *not* fire, and it is deliberately a
   * hard case — a skyline that moves well under one whole pixel per column,
   * which is what a real distant treeline does and what the old whole-row
   * median could not distinguish from a drawn line.
   */
  const makeHorizon = (name, amplitude) => {
    const png = new PNG({ width: W, height: H });
    for (let x = 0; x < W; x++) {
      const edge =
        200 +
        amplitude *
          (Math.sin(x * 0.041) * 0.5 + Math.sin(x * 0.0093 + 1.7) * 0.35 + Math.sin(x * 0.13 + 0.4) * 0.15);
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        // Soft one-pixel edge, so the sub-pixel estimator has a ramp to read
        // rather than a step that quantises exactly like the old measure.
        const t = Math.max(0, Math.min(1, y - edge + 0.5));
        const n = ((x * 37 + y * 11) % 17) - 8;
        png.data[i] = 190 - 110 * t + n * (1 - t);
        png.data[i + 1] = 186 - 108 * t + n * (1 - t);
        png.data[i + 2] = 196 - 130 * t + n * (1 - t);
        png.data[i + 3] = 255;
      }
    }
    const out = path.join(os.tmpdir(), `framescan-selftest-${name}.png`);
    fs.writeFileSync(out, PNG.sync.write(png));
    return out;
  };

  const bad = make("cool-band", true);
  const good = make("gradient-only", false);
  console.log("=== selftest: a frame with a planted cool band MUST report one");
  const badHits = scan(bad).filter((h) => h.kind === "COOL INVERSION");
  console.log("\n=== selftest: a frame with only aerial perspective MUST report none");
  const goodHits = scan(good).filter((h) => h.kind === "COOL INVERSION");

  const ruled = makeHorizon("ruled", 0);
  const wander = makeHorizon("wander", 9);
  console.log("\n=== selftest: a dead-straight skyline MUST report RULED HORIZON");
  const ruledHits = scan(ruled).filter((h) => h.kind === "RULED HORIZON");
  console.log("\n=== selftest: a skyline wandering under 1 px per column MUST NOT");
  const wanderHits = scan(wander).filter((h) => h.kind === "RULED HORIZON");

  for (const f of [bad, good, ruled, wander]) fs.rmSync(f, { force: true });

  const ok =
    badHits.length > 0 && goodHits.length === 0 && ruledHits.length > 0 && wanderHits.length === 0;
  console.log(
    `\nselftest ${ok ? "PASS" : "BROKEN"}: planted cool band -> ${badHits.length} (want >=1),` +
      ` gradient only -> ${goodHits.length} (want 0),` +
      ` straight skyline -> ${ruledHits.length} (want >=1),` +
      ` wandering skyline -> ${wanderHits.length} (want 0)`
  );
  process.exit(ok ? 0 : 3);
}

if (argv.includes("--selftest")) selftest();

let findings = 0;
for (const file of files) findings += scan(file).length;
console.log(`\n${findings} finding(s) across ${files.length} frame(s)`);
process.exit(findings ? 1 : 0);
