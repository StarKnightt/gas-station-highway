#!/usr/bin/env node
/**
 * Is the bollard's impact damage discrete, and does it have a direction?
 *
 * Two rounds were lost to damage that a critic read as "a printed rust texture
 * applied as a band": first because a wide smoothstep on a smooth field
 * airbrushed it, then because narrowing that smoothstep turned the same smooth
 * field into a speckle belt at constant height. Both times the mistake was
 * invisible in the source, where the term was named `wear` and looked physical.
 *
 * Three numbers, all of which have a right answer:
 *
 *   arc with damage   Cars come from a direction. 100% is a printed band; the
 *                     target is roughly a third of the circumference.
 *   belt rows         Rows where damage covers more than half the width. Any
 *                     nonzero count is a ring, which is the giveaway.
 *   peak U            Must track the authored `impactU`, or the parameter is
 *                     not reaching the pixels.
 *
 * The classifier is the fiddly part and got this wrong once. `g < r * 0.78`
 * looks like "reddish" and also catches the base yellow, whose g/r is 0.82 — so
 * the first run reported 92% of the circumference damaged on every skin and the
 * directional gating looked broken when it was fine. Rust sits near g/r 0.5 and
 * chalked yellow near 0.90, so 0.62 separates them with room either side.
 */

import { makeBollardSkin } from "../src/gen/hardsurface.ts";

const isDamage = (r, g, b) =>
  // Rust: strongly red-dominant and not bright.
  (g < r * 0.62 && r > 45) ||
  // Bare or primed steel: near-neutral. Chalked yellow never is.
  (Math.abs(r - b) < 14 && Math.abs(r - g) < 14 && r > 120);

const SKINS = [
  ["skin0", 6161, 0.46],
  ["skin1", 7307, 0.18],
  ["skin2", 9151, 0.74],
];

console.log("Bollard impact damage: discrete, and directional?\n");
let bad = 0;
for (const [name, seed, impactU] of SKINS) {
  const n = 256;
  const { map } = makeBollardSkin(n, 1.07, seed, impactU);
  const d = map.image.data;
  const cols = new Array(n).fill(0);
  const rows = new Array(n).fill(0);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const j = (y * n + x) * 4;
      if (isDamage(d[j], d[j + 1], d[j + 2])) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  const cf = cols.map((v) => v / n);
  const rf = rows.map((v) => v / n);
  const arc = cf.filter((v) => v > 0.015).length / n;
  const belt = rf.filter((v) => v > 0.5).length;
  const damagedRows = rf.filter((v) => v > 0.02).length;
  // Circular mean, not the peak column. With damage deliberately discrete, the
  // single tallest column lands anywhere inside the struck arc and the peak was
  // reporting "BAD" on skins whose arc was correctly placed — a statistic that
  // is noisy by construction cannot test a parameter this way. The resultant
  // vector of the whole distribution is what "which way has it been hit" means.
  let sx = 0;
  let sy = 0;
  cf.forEach((v, x) => {
    const a = (2 * Math.PI * x) / n;
    sx += v * Math.cos(a);
    sy += v * Math.sin(a);
  });
  const pk = (((Math.atan2(sy, sx) / (2 * Math.PI)) % 1) + 1) % 1;
  let du = Math.abs(pk - impactU);
  if (du > 0.5) du = 1 - du;
  const aimOk = du < 0.12;
  const arcOk = arc > 0.12 && arc < 0.55;
  const ok = aimOk && arcOk && belt === 0 && damagedRows > 8;
  if (!ok) bad++;
  console.log(
    `  ${name}  arc ${(arc * 100).toFixed(0).padStart(3)}%  ${arcOk ? "ok " : "BAD"}   ` +
      `belt rows ${String(belt).padStart(3)} ${belt === 0 ? "ok " : "BAD"}   ` +
      `damaged rows ${String(damagedRows).padStart(3)}   ` +
      `mean U ${pk.toFixed(2)} vs authored ${impactU} ${aimOk ? "ok" : "BAD"}`
  );
}
console.log(bad === 0 ? "\nAll skins: discrete and directional." : `\n${bad} skin(s) failing.`);
process.exit(bad === 0 ? 0 : 1);
