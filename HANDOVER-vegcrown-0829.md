# Pine crown round — card size, damping range, warm patches

Follows `HANDOVER-vegwind-0829.md`. Everything here is CPU work plus the six
loads already reported from `tools/vegdampprobe.mjs`. **No card was taken this
pass.** One capture is still outstanding and is described at the end.

## What landed

| change | file | why |
|---|---|---|
| `DAMP_RAMP_PINE = { onset: 5.2, width: 2.0 }` | `vegTransmission.ts`, `VegetationSystem.ts` | correctness fix, see below |
| dead-card rate `0.07 → 0.03` | `vegPine.ts` | P2, the card-scale half of the warm patches |
| `browning` `0.08 → 0.05` on live shoots | `vegTextures.ts` | P2, the sub-card half |
| `quality: tierSettings("high")` in the CPU context | `tools/_vegscale-entry.ts` | every headless tool had been throwing since 14:34 |
| `crown` shot preset | `src/core/shots.ts` | ground-level, looking up into a backlit crown — the user's pose |
| `tools/vegdampprobe.mjs` | new | the instrument for all of the above |

## What did not land, and why

**Interwhorl stem shoots (P3) are declined by their own pre-registered target.**
The approval was correct on the evidence available; the evidence was wrong.

The 85% exposed-trunk figure came from scanning a column down the visible trunk,
which from a ground-level pose is mostly the **self-pruned lower pole below the
live crown, where bare wood is correct**. Rasterising the wood mesh with a depth
buffer and asking whether foliage covers each drawn bark pixel gives **17.0%
visible bark**. Splitting radially from the axis rather than by height — a
branch inside the live crown is at crown height but is not stem — puts the stem
at 26.4% bare and the branches at 16.5%.

And the percept is about runs, not area. There are 204 separate runs of exposed
bark; **three of them are 40 px or longer and carry 45% of all bare bark**. Those
three are **0–18% stem**. They are branch wood. Stem shoots cannot reach them,
and measurement confirms it: for +3.8% instances the longest run moved by zero
pixels and the 40 px-plus count stayed at three.

The correct object is **the inner third of the longest branches**. That is a
different change, it is not costed, and nothing should be built for it until
someone decides the 17% is worth 41 more cards per tree aimed properly.

**Larger foliage cards are refuted, monotonically, out to 3×.** Full table in
`NOTES.md` under *A sampling-ratio argument is not symmetric*. Every metric
moves the wrong way: the blob unit goes 0.35 m → 0.55 m, fragmentation falls
5.51% → 1.94%, coverage rises 20% → 44%. The internal structure gain is real and
far too slow — even at 9.4 texels per pixel a needle is still 0.46 px, and the
card would have to reach about 2 m before one resolves, by which point the blob
unit is 2 m. There is no size at which the trade wins.

The downward direction **is** the only thing measured all evening that moves the
blob unit (0.35 m → 0.19 m at 0.15 m cards), but coverage collapses 20% → 12% in
the same column, because `step` is a one-dimensional walk along a branch while
card area is two-dimensional. Holding coverage while shrinking therefore does
cost close to 4× the cards, so the original refusal stands — on a derived number
this time rather than an asserted one.

## The damping re-range is a correctness fix, not an improvement

`DAMP_RAMP_DEFAULT` was fitted on scrub and applied to pine. Pine carries 1707
texels per metre against scrub's 731, so **every pine card at every playable
distance sat at full damping** and the distance term never engaged. The original
verification passed because it was run on scrub within two metres, the one band
where the expression is genuinely zero.

5.2 is measured. Area-weighted over 6528 card triangles through the crown pose
the pine's texel footprint runs p5 4.58, median 5.23, p95 6.05 stops, so an
onset of 5.2 leaves about half the near crown undamped while a mid-distance
crown still runs at ~80%. Measured on the frame at both ends: **0.6% of crown
fragmentation recovered against 0.001 points of mid-distance sky gap**, which is
the far-field protection this was landed for.

**The near-field gain is small and that is the honest result.** The blob is the
card's outline, not the alpha inside it, so unsaturating the damping was never
going to fix it. This lands because the expression was wrong.

The head-on arithmetic that predicted 4.82 stops sits at about the **18th
percentile** of the measured distribution — `fwidth` takes the worse axis and
the cards are rolled at 0/60/120° and mostly seen at a slant, so a head-on
footprint is a lower bound. That is why the first re-range under-delivered.

## Where the blob actually comes from

Unchanged from the diagnosis and still the finding of the round: the card is
0.30 m / 22 px carrying a 512-texel texture, so it samples at 23–38 texels per
pixel and a 4.3-texel needle lands at 0.19 px. **Coverage survives the reduction
and structure does not** — 34% → 39% coverage, boundary to 12% of authored. No
texture change fixes it: needle width from 0.19 px to 1.13 px leaves
post-reduction boundary flat. No card size fixes it either, in either direction,
for the reasons above.

That leaves the mechanism identified and no cheap lever against it. **The next
real move is a different primitive, not a different constant** — and that is not
an improvement to a finished build.

## Outstanding: one capture, not yet requested

P2 is a look change and was to be judged on a frame. Two loads at the `crown`
pose — current `HEAD` against the working tree — would show whether cutting the
dead-card rate reads as aged rather than patchy. It is not urgent and it is not
a correctness question; `tools/vegdampprobe.mjs --no-build` already has the pose
and the tan-region classifier.

## Card hygiene

`node -e "import('./tools/vegdampprobe.mjs')"` **executes the tool**, because
its top level runs rather than exporting. It launched a build and a browser
before it was killed. Use `node --check` for a syntax check on anything in
`tools/`. `tools/cardclear.mjs` reports PASS as of the end of this round.
