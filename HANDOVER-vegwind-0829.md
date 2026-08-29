# Leaf wind and minification damping — Vegetation, 2026-08-29

Two changes landed, both in code Vegetation owns, both revertible by deleting
one block. Captures and the results blob are in `capture-vegwind-0829/`. The
harness is `tools/vegwindprobe.mjs`; `tools/vegwinddelta.mjs` and
`tools/vegwindcrop.mjs` read its PNGs off disk and need no card.

Program count is **179 before, 179 after, and 179 with the depth patch forced
off**. Draw calls 59 and built triangles 735,441, unchanged in every arm.
`node tools/shoot6.mjs` is 11/11 with an empty `__SYSTEM_ERRORS` and no shader
link errors.

---

## Part 1 — the jungle-trail read

`c:\Code\jungle-trail`, read as technique. Nothing was copied; no asset entered
this project and none could, since everything here is procedural.

### The honest headline: most of its machinery is budget, not technique

The species table, the tiling, the variant counts, the LOD chain, the
instanced-attribute packing and the whole placement pipeline exist to solve
**repetition and culling across a forest**. It grows a rainforest understory
procedurally and has to make ten thousand plants look unrepeated at a frame
budget. We place ten individually-built pines and 218 mid-storey plants by hand
and by site rule. Those are different problems, and adopting its answers to the
one we do not have would be cost without payoff.

That is not a dismissal, and the user rates those trees correctly. It is an
attribution: what makes them read well at a distance is a *density and coverage*
discipline, and what makes them cheap is machinery we can decline.

### Our pine crown is the better-specified object

Said plainly because it is true and it is the honest answer to "can we match
it". `vegPine.ts` builds irregular whorls with per-whorl vigour, golden-angle
placement around the stem, a thinned band where a real pine has lost its lower
interior, and a lopsided live crown. jungle-trail's canopy patches are, by
comparison, a scatter of leaf cards on a hemisphere with good texture work over
them. Its advantage is at the *aggregate* — a hundred crowns overlapping — and
ours is at the individual. We should not be trying to become it.

### What it does that we did not, ranked by visible improvement over risk

**1. Minification damping — landed.** See below. This is where its
mid-distance advantage actually comes from, and it turned out to be eight lines.

**2. Per-card transmission variance — costed and decided against. This is not
unfinished work.** It hashes per-instance data to give each leaf card its own
transmission strength, so a backlit crown has bright and dull needles rather
than one uniform glow. Cheap (one hash of `instanceMatrix[3]`, no new
attribute), medium payoff. It was explicitly deferred pending the damping's
result, the result came in, and it **closes the question**: the mid-distance is
now carried by coverage rather than by per-card variation, and the near-field
crowns were never the complaint. Nobody should pick this up as a loose end. If
it is ever revisited it needs a *new* reason, not this one.

**3. Abaxial back-face tint — declined**, and declined on geometry. It gives a
leaf a different underside colour, which is worth a great deal on a broad
rainforest leaf presenting 200 px of underside. A conifer needle at our card
resolution presents a few pixels and no distinguishable face. The payoff cannot
be argued from the geometry, which is the right reason to leave something out.

### Two things kept from the read that change nothing here

Both are in `NOTES.md` under their own headings.

**Attribute sharing is a principle, not a trick.** `aSurf.y` means "signed moss"
on wood and "which underside" on leaves, and the two cannot collide because a
leaf never has moss and a trunk never has an abaxial surface. The slot is safe
to overload because the *geometry* makes the uses disjoint, not because the code
currently keeps them apart.

**It proved its shadow map was useless by measurement before deleting it.** With
fill, environment and transmission zeroed and the sun near doubled, the forest
floor rendered completely black with no lit pixel in frame. That number turns a
trade into a deletion. Cost justifies looking; only a measurement of the output
justifies removing a pass.

---

## Part 1, landed — minification damping

`src/gen/vegTransmission.ts`, `installMinificationDamp`. Reverts by deleting the
function and its one call.

**The finding, which matters more than the change: the speckled grey
mid-distance is not the leaves, it is the sky between them.** A card five pixels
tall samples a mip level where the needle gaps and the alpha-zero corners have
averaged into mid-range alpha, all of it below `alphaTest`, so the card erodes
from every edge at once and bright dawn sky shows through the gap between each
card and the one it should touch. An appearance complaint restated as a coverage
failure — the same move that solved the gravel, the notices and the treeline.
No colour change can close a hole.

So alpha is dilated with the mip footprint, letting small cards merge into one
larger silhouette. Roughness is clamped toward 0.97 over the same ramp, because
`foliageCardGeometry` fans its normals and randomly oriented sub-pixel cards
each holding a full specular lobe alias rather than average. jungle-trail's
normal-flattening half is omitted: it mixes toward `nonPerturbedNormal` and no
foliage material here carries a normal map, so it would be an exact no-op.

**Measured** with the wind held at zero, `?vegdamp=0` against shipping:

| | |
|---|---|
| frame moved by >3 codes | 5.00% |
| frame moved by >12 codes | 2.60% |
| row profile, knee-height pose | 0% in the top two bands, 18% at mid distance, 0.94% in the bottom band |

The row profile is the claim, not the totals: the effect appears where things
minify and nowhere else. The near-field crops are indistinguishable by eye. The
mid-distance scrub goes from wiry broken stalks with sky between them to
connected tufts, without going blobby.

**Deliberately not installed on the depth pass**, and the reasoning is the
opposite of what looks tidier. Parity between beauty and shadow silhouettes is a
rule here. The ramp is the identity in the near field, which is the only place a
crown's own shadow is resolvable, so parity holds where it is checkable.
Injecting it into the depth pass would *break* parity, because `fwidth` there
measures the shadow map's footprint from the light's viewpoint rather than the
screen's from the camera's — the two passes would dilate differently on the same
texel, by an amount that depends on where the sun is.

---

## Part 2, landed — vertex wind, **with the depth patch**

**I took the proper path, not the fallback.** The vertical shortening term is
in, the custom depth materials are in, the assertion is in, and it measured
clean.

### Where it lives

`src/gen/vegTransmission.ts`, composed into the single existing
`onBeforeCompile` rather than assigned as a second one. There is now exactly one
function in the codebase that assigns `onBeforeCompile` on a foliage material,
and transmission, wind and damping are branches inside it. Cache key
`foliage-transmission-v2` → `foliage-v3-{t}{w}{d}`, where the letters name which
terms are present and nothing else; every parameter remains a uniform.

Injection is at `<project_vertex>`, which is the last point at which a
displacement still reaches `gl_Position` and the first at which an instanced
card has a world position. `<worldpos_vertex>` is fed the displaced value rather
than recomputing from `transformed`, so the shadow lookup and the environment
map read where the leaf actually is. A missing `<project_vertex>` throws rather
than being a silent no-op.

`uTime` is written in `VegetationSystem.update()` **above** the `wireMats`
early return. Below it, the leaves would stop whenever the wire layer was
absent — including under somebody else's `?vforce=nowire` control arm, where it
would look like evidence about the wires.

### Amplitudes, as shipped

Peak tip excursion, scaled by `site.WIND.strength` and reported in
`__VEGETATION.windTipMetres`:

| layer | metres |
|---|---|
| pine crown | 0.025 |
| mid-storey | 0.006 |
| scrub | 0.001 |
| thatch sprigs | none — a ground sheet that ripples reads as water |

Two harmonics at 11.4 s and 4.8 s, a travelling gust at 48 s squared so still
air is the default state rather than the mean, and phase from world position so
the 41,000 cards vary without a per-instance attribute. Direction is consumed
from `site.WIND.bearing`, the same bearing the ground accumulation drifts litter
along, so the leaves lean the way the rubbish piles.

Amplitude is the square of a cantilever coordinate measured in object space from
the instance origin, so the base of a shoot is anchored and the tip moves. Object
space rather than world, because the instance matrices carry non-uniform scale
and a world reach would make a large clump limp and a small one stiff.

### The depth patch and its precondition

Every casting foliage mesh gets a `customDepthMaterial` built **from its beauty
material's own fields** and carrying the same wind. `assertShadowSilhouetteParity()`
runs at the end of `init`, over the built scene, and throws on any of:

- `depth.map !== beauty.map`
- `depth.alphaTest !== beauty.alphaTest`
- `beauty.alphaToCoverage` being on, since three then forces the shadow cut to
  0.5 regardless of anything we set — this is the trigger for the recorded case
  where 6.9% of drawn pixels cast nothing
- `depth.side !== beauty.shadowSide`
- no pairs registered at all while foliage is casting, unless `?vegdepth=0`
  asked for that

45 pairs registered and asserted; the list is in `__VEGETATION.shadowPairs`.

**And then measured rather than trusted, which is the part that matters.** At
`?vegwind=0` the depth material displaces nothing, so if it also cuts the same
silhouette the frame must be unchanged. `?vegdepth=0` against shipping at zero
amplitude: **18 pixels at peak 1, against a determinism floor of 13 pixels at
peak 1** — the same regime two byte-identical loads occupy. Cast-pixel coverage
is unchanged by the depth patch.

Cost: **zero programs.** All 45 depth materials share one cache key and one
define set, so three collapses them into one program, which replaces the stock
depth program those meshes were already using. 179 programs with the patch, 179
without.

### Verification

`?vegwind=` is a scale rather than a toggle, and that is what makes any of this
readable: at shipping amplitude a working wind and a dead wind are
indistinguishable in a still frame. `?vegdamp=` is the same shape for the
damping. Both are uniforms, so every arm runs the identical program and a diff
between them is a diff of pixels rather than of two different shaders.

Final run, exit 0, all seven passing:

| registered prediction | result |
|---|---|
| two identical loads — the floor | 13 px, **peak 1** |
| two null frames, four seconds apart | 24 px, peak 1 |
| `?vegdepth=0` vs shipping at zero wind | 18 px, peak 1 |
| shipping wind, two scene times | 129,639 px, peak 172 |
| `?vegwind=8` vs still | 127,778 px, peak 173 |
| `?vegwind=8` with and without the depth patch | 49,632 px — this difference *is* the shadow displacement |
| damping on vs off, wind at zero | 171,238 px, peak 173 |

**A prediction I got wrong, and then a criterion I got wrong, and both are worth
the space.** Two of these were registered as "bit-identical, exactly zero" and
came back at 43 and 74 pixels, peak 1. The right response was not to soften the
threshold but to measure the achievable floor, so an arm byte-for-byte identical
to an existing one was added.

The floor was then gated on *pixel count*, and that failed on the next run —
because across three runs two identical loads gave **84, 19 and 13** pixels,
always at peak exactly 1. The count in that regime is not reproducible. The bar
is now the peak, which is reproducible and is also the stricter statistic for
what the test is actually for: a beauty-versus-shadow silhouette divergence
moves needle-edge pixels by tens of codes against a bright sky, so a peak bar
catches one mismatched pixel where an 84-pixel count bar would absorb dozens.
That is a statistic replaced, not a threshold loosened. Recorded in `NOTES.md`.

Zero is not the null hypothesis on a GPU; a real-time renderer reproduces itself
to about one code.

### Is it actually subtle?

A changed-pixel count cannot tell breathing from shimmering — a peak of 172 is
what *any* sub-pixel motion produces at a needle-against-sky edge. The
distribution can. Over four seconds of shipping wind:

| | |
|---|---|
| median delta on changed pixels | 1 code |
| 90th percentile | 5 codes |
| frame moving by more than 3 codes | 1.67% |
| frame moving by more than 12 codes | 0.32% |

The 9% headline is almost entirely one- and two-code edge shimmer at the
quantiser. The amplitudes stand; I did not need to halve them. For contrast the
`?vegwind=8` arm reaches 2.21% over three codes and the *minification damping*
reaches 5.00% — the damping is a bigger visual change than eight times the wind.

---

## Levers added

| query | effect |
|---|---|
| `?vegwind=0` | wind off, bit-identical to no wind — every product contains an exact zero |
| `?vegwind=8` | the arm that proves the term is wired and that the shadows follow |
| `?vegdamp=0` | minification damping off, exact identity |
| `?vegdepth=0` | no custom depth materials; the fallback path, and the arm that measures the patch |

All four are echoed into `__VEGETATION`, so a capture can assert the lever
arrived rather than assuming a query string was spelled correctly.
