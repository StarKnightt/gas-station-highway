# Pine crown round — conclusion first

**The crowns are as fine as this primitive makes them, and we can say exactly
why.** The blob unit is governed by crown coverage, not by card size: 0.30 m
cards at 19.5% coverage and 0.15 m cards at 19.9% both produce a **0.34 m
blob**, at card sizes 2x apart. **A crown cannot read finer without reading
thinner.** Every change tried this round held coverage constant by design, which
is precisely why the statistic never moved through five levers. That is
architectural rather than a budget question — no triangle refund touches it, and
the only thing that would change it is a different foliage primitive, which is
not a tuning pass.

What did improve is real:

- **The damping ramp now actually ramps.** It had been fitted on scrub and was
  sitting at full saturation on every pine card at every playable distance, so
  the distance term never engaged. Landed as a correctness fix, not an
  enhancement.
- **The tan patching is reduced** — dead cards `0.07 → 0.03`, needle browning
  `0.08 → 0.05`.
- **The leaves move**, from the previous round, with shadow parity proved rather
  than assumed.
- **The trunk was investigated and found correct.** That is a result, not a
  non-result: it has a 3.12x linear cross-gradient against 1.55x and 1.51x for
  the scene's utility poles, so it is not merely acceptable but better shaded
  than its neighbours.

Five levers costed, four refuted with numbers, none landed on a percept. The
detail is below; the six refutations are worth reading only if someone wants to
re-propose one of them.

**Lever B (branch shoots) is declined.** It is costed and **one capture round
from landing** if anyone later disagrees with the frame evidence — the recipe
and the registered cast-coverage plan are written out in full in the Lever B
section, because the scratch implementation did not survive (see the note there,
which is worth reading on its own account).

---

# Pine crown round — the detail

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

## Second pass: both levers costed, P2 on a frame

**Lever A — smaller cards — is dead, and the reason retires the whole
direction.** The blob unit is a function of crown coverage, not of card size.
The original table's improvement was the crown getting thinner: at held
coverage, 0.30 m and 0.15 m cards give the same 0.34 m blob unit, and the
cheapest coverage-held option costs +186% cards and +529k triangles per frame
for a 5% move. Table in `NOTES.md`. A crown cannot be made to read as finer
without being made thinner, on this primitive, at any price.

**Lever B — shoots along the inner third of the longest branches — works and
is affordable.** At `>=0.9 m branches, 8 shoots/m, 1.45x card size`:

| | shipping | Lever B |
|---|---|---|
| pine foliage instances, scene | 23,710 | 28,347 (+19.6%) |
| triangles per frame | 285k | 340k (+55k) |
| VRAM | 1.72 MB | 2.05 MB |
| programs / draw calls / textures | — | 0 / 0 / 0 new |
| visible bark | 16.2% | 11.1% |
| longest run | 83 px (1.38 m) | 58 px (0.96 m) |
| runs 40 px or longer | 3 | 2 |

Pushing to 14 shoots/m costs another 54k triangles for 0.8 more points and is
past the knee. **Not landed** — it is a geometry change and wants the
registered cast-coverage plan, which transfers unchanged.

**P2 is real but subtle.** Two builds, control against treatment, one pose. The
probe's own classifier was contaminated and the corrected measurement is in
`tmp/tanfix.mjs`: over the 30.3% of crown pixels P2 actually changed, mean R−G
falls 22.61 → 18.10; crown-wide the warm share falls 39.4% → 35.2% and the
silhouette is unchanged at +0.03%. Card-scale warm regions 12 → 9, which failed
the registered bar of a third — the warm regions percolate across the sunward
crown rather than resolving into individual cards, so that statistic was
counting connected territory rather than dead cards.

**The frame carries a finding neither costing would have produced.** The trunk
is 48.8% bare over the 9.3 m in view, in one unbroken 2.39 m run carrying 53%
of it, at 178 codes of contrast. That run spans 2.65–4.88 m against a
`deadBelow` of 4.42 m, so four fifths of the worst-looking stretch is the
self-pruned lower stem where bare wood is correct — and the CPU model excluded
exactly that band for being correct. The cross-trunk profile through it is flat,
13 to 16 codes across 14 px. **The trunk reads as a stick because what shows has
no internal shading, not because too much of it shows**, which points at the
bark's response to a low backlight rather than at foliage count.

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

---

# Trunk shading: diagnosed, and it is not a defect

Four candidate mechanisms were separated before anything was proposed. All four
clear, and the fifth possibility — that the trunk is right and unflattering — is
what the measurement supports.

**It is not ambient-dominated, so it is not Lighting's.** `scene.environment` is
a PMREM of the actual dawn sky at `environmentIntensity` 2.4, carrying real
directional structure (blue overhead, warm toward the sun). The only genuinely
uniform term is a `HemisphereLight` at intensity **0.10**, and a hemisphere
light is itself directional in the axis that matters for a vertical cylinder.
This is not the forecourt defect on a different surface; the trunk is receiving
a distribution, not a constant. **Do not reopen Lighting on my account.**

**The geometry can carry a gradient.** `sweepTube` writes outward radial normals
per vertex and `buildPine` runs `computeVertexNormals` over the assembled wood,
so the normals are smooth rather than faceted. The stem has **9 radial
segments** and projects to **16 px** at this pose — about 1.8 px per segment,
which is ample.

**The albedo is not black.** Pine bark is authored at `PLATE [0.268, 0.226,
0.182]` with cracks at `[0.098, 0.070, 0.052]`, a mid-brown around 0.23 linear.

**And the gradient is there. I had trimmed it off.** The cross-trunk profile is
`29 26 14 13 14 13 13 13 13 14 15 16 18 23 28 29`. I reported "13 to 16 codes
across 14 px" by treating the bright ends as antialiasing into the sky. On a
16 px cylinder the rim *is* the shading. Read whole the profile runs sRGB 12.9
to 29.2, which in linear is 3.99e-3 to 1.24e-2 — a **3.12x gradient across the
body**.

The control makes it decisive and it cost nothing, because it was already in a
capture taken for something else. **The two utility poles in the same frame** —
different geometry, different material, different system, same sky and same tone
curve — profile at **1.55x and 1.51x**. The pine trunk has **twice the
cross-sectional shading of the scene's other cylinders.**

**The honest outcome.** The sun is 11.5 degrees off the view axis and behind the
tree, so the camera side of the trunk is its shadow side, and the correct
appearance of a 0.5 m dark cylinder silhouetted against a 200-code dawn sky is a
dark body with brighter rims. That is exactly what it is. It reads as a stick
because 16 codes of correct gradient are invisible beside a 178-code contrast
edge — not because the gradient is missing. **There is nothing to fix in the
bark, and a change that produced a visible gradient here would be producing one
the light is not delivering.**

**This is the inverse of the day's usual failure.** The pattern all day was that
the number was right and the object was wrong — the troffer inference, the
region drawn on the wrong frame, the stem shoots aimed at the self-pruned pole.
Here the object was right and the physical argument behind it was sound: a lit
cylinder does have a gradient, and a flat one would have been a defect. **The
number was trimmed.** Cropping a profile's ends as filtering noise is a routine
and usually correct habit, and on a 16 px object it removes the signal. Worth
keeping separate from the wrong-object cases, because the guard against it is
different: not "derive the region from geometry" but "look at the whole profile
before deciding which part of it is the object".

# Lever B, re-judged on the frame: I recommend declining it

The instruction was to re-judge after the trunk, on the reasoning that a trunk
with a gradient would stop reading as a black line and cheapen the lever. The
trunk did not gain a gradient — it turned out to have one — so that particular
discount does not apply. A different one does.

Splitting the near pine's dark pixels on the captured frame:

| | pixels | share of dark wood | share of tree |
|---|---|---|---|
| trunk column | 6,900 | 32.5% | 6.6% |
| everything else | 14,328 | 67.5% | 13.8% |

**Carry this caveat, it is load-bearing:** at a luminance cut, "everything else"
is not branch wood. It is branch wood *plus* every shaded needle, card back and
interior gap in the crown, and there is no way to separate them on a lit frame.
The 67.5% is an upper bound and probably a loose one.

The run statistics are what decide it. **Non-trunk dark pixels fall into 4,995
horizontal runs whose longest is 45 px — 0.75 m — with only 45 runs of 20 px or
more, carrying 8% of the total.** The trunk column, one contiguous vertical
object, carries 32.5% by itself. **The frame does not show branch wood as long
lines.** Whatever is dark out in the crown is speckle between needles, which is
the texture of foliage rather than the outline of a stick.

That is a real disagreement with the CPU costing, which found three runs of
40 px or more carrying 45% of bare bark, and the costing is the one I trust
less: it measured 4-connected runs through an **unlit** wood mask, where a run
may snake in two dimensions and where dark foliage and dark bark are the same
colour because there is no light to tell them apart.

So Lever B buys **+19.6% instances and +55k triangles** to act on a statistic
the frame does not corroborate, while the object that does drive the percept —
one contiguous high-contrast vertical line — is correct and is staying. I do not
think that is a good trade, and I would rather close the trees with the honest
account than spend the instances.

## Lever B: how to rebuild it, and why this section exists

I said I would "leave it in scratch". **I could not, and the reason is worth one
paragraph.** `tmp/` is in `.gitignore` and gets swept — the implementation I
costed against, `tmp/_vegPineB.ts`, was already gone by the time I went to
annotate it. *"Left in scratch" is not a place to leave anything*, and a
handover pointing at an ignored directory points at nothing. The durable form of
a deferred change is the recipe, so here it is.

In `src/gen/vegPine.ts`, in the whorl branch loop, after the branch tube is
pushed to `parts` and after the `if (stub) continue;` guard:

- select branches with `len >= 0.9`
- place shoots along the **inner third** of the branch path, `s` in `[0, 0.33]`
- **8 shoots per metre** of that inner third, so `Math.round(len * 0.33 * 8)`
- card scale **1.45x** the interwhorl shoot size, oriented off the branch
  tangent rather than the trunk axis
- they are ordinary live foliage cards: no new material, texture or draw call

Measured cost: **+19.6% instances, +55k triangles**, visible bark 16.2% to
11.1%, longest bare run 1.38 m to 0.96 m. Denser settings were swept and this
one sits at the knee rather than past it.

**The registered cast-coverage plan transfers unchanged** and must be run before
landing: capture at `?vegwind=0` on the `crown` shot and check cast-pixel
coverage, drawn-pixel coverage, the **cast-to-drawn ratio** — the one that
matters, because it catches added cards casting at a different rate, which
"shadows still exist" would not — and the peak per-pixel delta against the
determinism floor of 13 at peak 1.

# The line for the user

**A crown cannot read finer without being thinner.** The blob unit is a function
of crown coverage, not of card size: 0.30 m cards at 19.5% coverage and 0.15 m
cards at 19.9% both give a 0.34 m blob unit, at card sizes 2x apart. Every
change tried this evening held coverage constant by design, which is exactly why
none of them moved the statistic. That is architectural. No triangle refund
touches it, and there is no version of this crown that is both as dense and less
lumpy.

What did change: the pine damping ramp was fitted on scrub and had been running
at full saturation on every pine card at every playable distance, which is now
fixed as a correctness bug rather than shipped as an enhancement; and the warm
patchiness is down, with the dead-card rate cut from 0.07 to 0.03 and needle
browning from 0.08 to 0.05.
