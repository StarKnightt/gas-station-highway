# ROUND 2026-08-28T211049Z-d501f506530e — THE INJECTION AUDIT, AND THE MID-STOREY IS NOT A COUNT PROBLEM

7/7, RTX 4060 verified, no shader errors, `__SYSTEM_ERRORS` empty, port 5119
clear (TIME_WAIT only, no listener), no stray Chromium. Round marked `KEEP`.

---

# 1. AUDIT: EVERY `onBeforeCompile` INJECTION IN THE PROJECT

Twelve injection sites across seven files, plus two custom `ShaderMaterial`s.
Chunk order verified against the **installed** three (r185), not from memory:

```
opaque_fragment -> tonemapping_fragment -> colorspace_fragment
  -> fog_fragment -> premultiplied_alpha_fragment -> dithering_fragment
```

Everything at or after `tonemapping_fragment` is display-referred. Everything
before `opaque_fragment` is scene-referred linear.

## Headline: one serious defect, and it is mine

**`src/gen/vegWire.ts` had no output-space handling at all.** It is a custom
`ShaderMaterial` and it wrote `gl_FragColor = vec4(c, a)` with **no
`#include <tonemapping_fragment>` and no `#include <colorspace_fragment>`**.
Three makes those functions available in the shader prefix and then does nothing
with them; every built-in material calls the two chunks itself. So this shader
was writing scene-referred linear radiance straight to an sRGB-output
framebuffer.

Both ends were wrong at once. `uBase` is linear 0.055, which authors to roughly
71/255 through ACES at the project's 1.25 exposure, and was landing at about
14/255 — which is most of the standing "the wires read as constant-width pure
black" complaint. And `uGlint` at 3.4 clipped flat to white with no shoulder
instead of rolling off. Note that a previous round had already found and
correctly fixed a *different* colour-space bug two lines above in the same
uniform block, and this survived it, because there was no injection point to
look at — this is the same defect as the transmission term with the chunk list
removed, which makes it strictly harder to see.

Fixed, and the fog moved after the encode to match where three puts `fog_fragment`
(three mixes a linear fog colour into an encoded value, which is arguably wrong,
but a wire has to dissolve into the same haze as the pole it is strung between).
### Verified in pixels, with a control rather than a detector

Two detectors failed to separate wire pixels from pine needles and fence
hardware, so I built `?vforce=nowire` and differenced instead: whatever changes
when the wires are removed *is* the wires, by construction, with no detector to
be wrong. Pair captured in one bundle (`8b1fc779fb1b`), rounds
`2026-08-28T214602Z` and `...T214908Z`, control confirmed live at **−2 draw
calls and −5,622 triangles**. 1,364 wire pixels identified.

**The decisive signature is the glint roll-off.** `uGlint` is linear 3.4. Written
raw to the framebuffer, every pixel with a non-trivial specular term clamps to
1.0 and comes out **255** — a hard white with no shoulder. Measured, the
brightest wire pixel in the frame is **141.6**, against a background maximum of
103.3 at the same pixels. Nothing is saturated. A value of 3.4 reaching the
framebuffer as 141.6 is only possible through the tone map, so ACES is running
on this material where before it was not. Over dark backgrounds the median wire
pixel lifts its background from 17.4 to 22.6 luma, which is consistent with the
encoded base and not with 14/255.

**Still not isolated:** the base level itself. Only **2** of the 1,364 wire
pixels fall against open sky in this preset, so alpha cannot be solved for and I
cannot quote a measured base value to put beside the authored ~71/255. The
mechanism is verified; the exact number is not.

The first attempt at this control also produced a useful failure, recorded
because it is the NOTES tell working: the control came back with **identical
draw calls and identical triangles** to the uncontrolled capture. Removing two
meshes cannot leave the draw count unchanged, so that is arithmetically
impossible and the instrument was wrong, not the physics — the flag assignment
sat forty lines *after* the wires were built and was being read too late. Had I
taken the frames at face value I would have concluded "the wires are invisible
in this preset" and filed it as a finding.

`src/systems/lightSky.ts` is the counter-example and is **correct**: it includes
both chunks explicitly after writing `gl_FragColor`.

## The other eleven: all correct on stage and space

| file | chunk | writes | verdict |
| --- | --- | --- | --- |
| `worldDetail.ts` | `map_fragment` | `diffuseColor` — mixes alt/soil samples, macro multiplier | correct: linear reflectance |
| `worldDetail.ts` | `roughnessmap_fragment` | `roughnessFactor` | correct: scalar parameter, not a colour |
| `worldDetail.ts` | `normal_fragment_begin` | saves `wdGeoNormal = normal` | correct |
| `worldDetail.ts` | `normal_fragment_maps` | `normal` via `tbn` (anti-tile arm, soil arm, distance fade) | correct: unit vectors, view space, applied where normal maps are |
| `worldDetail.ts` | `alphamap_fragment` | `diffuseColor.a` | correct |
| `worldDetail.ts` | `lights_physical_fragment` | `material.specularColor`, `specularF90` | correct: linear, and after the struct exists |
| `worldDetail.ts` | `lights_fragment_maps` | `radiance`, `clearcoatRadiance` | correct: scene-referred linear radiance, right place for it |
| `buildingCoursing.ts` | `beginnormal_vertex` / `begin_vertex` | `vBcNormal`, `vBcPos` varyings | correct |
| `buildingCoursing.ts` | `map_fragment` | `diffuseColor.rgb` — joint darkening, `uBcSoil` mix, tint | correct |
| `buildingCoursing.ts` | `roughnessmap_fragment` | `roughnessFactor` | correct |
| `buildingCoursing.ts` | `normal_fragment_maps` | `normal` minus a slope term | correct |
| `buildingWeather.ts` | `beginnormal_vertex` / `begin_vertex` | varyings | correct |
| `buildingWeather.ts` | `map_fragment` | `diffuseColor.rgb` — grime mix, patch, fade-to-luma | correct |
| `buildingWeather.ts` | `roughnessmap_fragment` | `roughnessFactor` | correct |
| `carGrime.ts` | `common` (vert+frag) | declarations only | correct |
| `carGrime.ts` | `begin_vertex` | varying | correct |
| `carGrime.ts` | `color_fragment` | `diffuseColor.rgb` — dust and film mixes | correct |
| `carGrime.ts` | `roughnessmap_fragment` | `roughnessFactor` | correct |
| `hardsurface.ts` | `common`, `begin_vertex` | declarations, varying | correct |
| `hardsurface.ts` | `map_fragment` | `diffuseColor.rgb` — film, dust, base darkening, scuff | correct |
| `hardsurface.ts` | `roughnessmap_fragment` | `roughnessFactor` | correct |
| `vegTransmission.ts` | `opaque_fragment` (before) | `outgoingLight` | correct **as of last round**; was `dithering_fragment`, see NOTES |
| `TerrainSystem.ts:470` | — | no injection; a `?flat=` debug wrapper that zeroes uniforms | n/a |

I checked the second axis too, since it is where NOTES case 24 lives: every
colour uniform mixed into `diffuseColor` — `uBcSoil`, `uBwGrime`, `uWDustCol`,
`uWFilmCol`, `uGFilmCol`, `uGDustCol`, `uGScuffCol` — is built with
`new THREE.Color(0x…)`, and three's hex path decodes sRGB to linear by default.
Correct for albedo. No action.

## Two things for owners that are not defects but are worth knowing

- **`worldDetail.ts` manually samples `uSoilAltNormal`, `uMacro`, `uSoilAlt` with
  raw `texture2D`.** That bypasses three's colour-space decode entirely. For
  normal and mask data that is what you want. It is only a problem if any of
  those textures is ever tagged `SRGBColorSpace` and read as if linear, so it is
  worth an owner's glance rather than a fix.
- **`toneMapped = false`** is set deliberately in `CarSystem.ts:778` and
  `lightSky.ts:818`. Those materials skip ACES but still get the sRGB encode, so
  their colours have to be authored knowing that. Documented in CarSystem; the
  `lightSky` one is not, and its owner may want to say why.

---

# 2. THE MID-STOREY IS PRESENT. THE MISSING LAYERS ARE 0.4–1.5 m AND 3–6 m

Measured before planting anything, as instructed, and the instruction was right:
the answer changed what to do.

## First, the framing, because it generalises past this system

**The instruction I was given was "no mid-storey — plant 1–3 m shrubs". That
instruction was wrong, and it reached me through the normal channel:** a critic
named it, and it was passed on without challenge, which is exactly how every
agent here receives critic instructions. Nobody did anything unusual.

The distinction worth holding onto is that **a critic naming a cause is
reporting a symptom.** "The planting jumps from ankle height straight to full
trees" is a real, accurate, valuable observation — a trained eye saw something
genuinely wrong and said so, and the frame did look like that. But "there is no
mid-storey" is a *diagnosis*, and it is the one part of the report the critic is
not positioned to make, because they can see the frame and not the scene. In
this case the named band was already the best-covered non-ankle layer in the
scene and the actual gaps were on either side of it. Planting into the named
band would have consumed a round, raised the triangle count, and left the
symptom exactly as reported — and the next critic would have filed the same
complaint, which would have read as confirmation that still more was needed.

So: **take the symptom as evidence and the cause as a hypothesis.** The
observation is data from an instrument that is better than ours at noticing;
the attribution is a guess made without the scene graph. Measure before acting
on the attribution, and measure the thing the eye actually reads — here, ground
area occupied per height band, not plant count. This applies to every critic
instruction that arrives phrased as a fix.

A new census in `VegetationSystem` rasterises **every vertex of every mesh this
system owns** into 2 m ground cells and records the tallest thing standing in
each, measured against the terrain beneath it. 159,825 samples, 946 plantable
cells (blocked cells excluded, so asphalt does not read as a failure to plant).
Fence and power line excluded — they are this system's meshes but they are not
plants.

| tallest thing in the cell | cells | share |
| --- | --- | --- |
| nothing | 114 | 12.0% |
| 0–0.15 m | 385 | 40.7% |
| 0.15–0.4 m | 115 | 12.2% |
| **0.4–0.8 m** | **45** | **4.8%** |
| **0.8–1.5 m** | **60** | **6.3%** |
| 1.5–3 m | 158 | 16.7% |
| **3–6 m** | **18** | **1.9%** |
| 6 m+ | 51 | 5.4% |

**The 1.5–3 m band is the best-covered non-ankle layer in the scene at 16.7%.**
Planting more 1–3 m shrubs — which is what the queue item says and what I would
have done — would have added to the layer that is already the strongest, and the
critic's complaint would have survived it. The two real troughs are **0.4–1.5 m
at 11.1% combined** and **3–6 m at 1.9%**. And 52.7% of the plantable near field
has nothing above ankle height at all, which is the "bare soil with props on it"
read persisting *through* the new ground mat, because the mat is by construction
under 15 cm and lands in the bottom bin.

So the next planting round has a specific target rather than "more mid-storey":
knee-to-chest volume at 0.4–1.5 m spread across open ground, and a few 3–5 m
individuals to break the jump to the pines. Not done this round — measuring it
was the work, and planting against a number I had just derived without capturing
it would be two changes at once.

### The census was wrong twice before it was right, and both are instructive

- **v1 binned object bounding boxes.** Correct for one-plant-per-instance,
  useless for merged geometry — and the pine trunks and the mid-storey stems are
  each a single merged mesh covering every plant of their kind. Ten pines
  contributed one tall cell; 19,460 foliage cards each contributed their own
  0.3 m box. It reported 1.5–3 m at 3.0%. The truth is 16.7%. I would have
  planted hard into the one band that did not need it.
- **v2 rasterised vertices but included the fence and the poles.** 51 posts at
  1.8 m and 199 wire runs put 158 cells into 1.5–3 m by themselves.

Same family both times: a number that answers a question adjacent to the one
asked, and answers it confidently.

## 2b. PLANTED, AND RE-MEASURED — round `2026-08-28T212546Z-117fb7008ed2`

New `openGroundSites` in `vegMidstorey.ts`. The gap was structural, not a count:
**every one of the 142 existing sites is anchored to one of three paths — the
fence, the building base, the pad edge — and all three are edges.** So the
plants existed and were all hugging a boundary while the open ground between the
lot and the treeline, which is most of what a walking player looks at, had grass
and then trees. No number of additional edge-anchored plants fixes that.

76 open-ground sites: 70 shrubs at 0.45–1.15 m (sage-dominant, because sage is
the only one of the three kinds with volume) and 6 conifers at 3.4–5.6 m. Placed
in drifts, not a field — a jittered grid gated by a low-frequency mask, so they
group into patches with clear ground between. An even scatter at this density
would read as a planting scheme, which would be a worse defect than the absence.

Same census, same 946 plantable cells, before and after:

| tallest thing in the cell | before | after |
| --- | --- | --- |
| nothing | 12.0% | 10.0% |
| 0–0.15 m (the mat) | 40.7% | 35.6% |
| 0.15–0.4 m | 12.2% | 11.1% |
| **0.4–0.8 m** | 4.8% | **6.1%** |
| **0.8–1.5 m** | 6.3% | **11.7%** |
| 1.5–3 m | 16.7% | 16.0% |
| **3–6 m** | 1.9% | **4.0%** |
| 6 m+ | 5.4% | 5.4% |

The 0.4–1.5 m trough goes **11.1% → 17.8%**, the 3–6 m trough **1.9% → 4.0%**,
and the headline figure — near field with nothing above ankle height — goes
**52.7% → 45.6%**. Verified in the census over the built scene and visible in
the seven captured frames; not yet re-judged by a critic.

Not fully closed, deliberately. Getting 0.4–1.5 m to parity with 1.5–3 m would
take roughly another 60 plants and 45k triangles, and the right moment to decide
that is after someone looks at the frames, not now.

---

# 3. NEEDLE PRIMITIVE — the card is no longer a flat rectangle

The card-size cut last round addressed how big the cardboard was, not why a card
reads as card. Three geometric causes, fixed at **zero triangle cost** — still
four vertices and two triangles per plane, six per card:

- **Fanned corner normals.** A flat quad has one normal, so it has one tone, and
  a cluster of them reads as stacked shingles. This is the big one at any card
  size. Corner normals now lean outward from the shoot axis, so one card
  presents a range of orientations the way a needle bundle does.
- **Twisted quad.** The two tip corners are pushed out of plane in opposite
  directions, so the card's two triangles meet at a crease and self-shade.
- **Tapered root**, 44% width, matching what the shoot texture already draws;
  the rectangle root was carrying alpha-zero corners purely as somewhere for
  filtering to smear.

The alternative — a midline row to bend the card properly — doubles triangles,
which at 12,269 cards is +74k for one material property. Rejected.

Card alpha softening still held, for the reason agreed: it enlarges the shadow
silhouette and would fight the self-shadow work.

# 4. STRAIGHT-LINE MASKS — the pad and the driveways were the last hard ones

The road edge already had the right treatment. The forecourt pad did not: it was
an axis-aligned rectangle at ±0.02 m, so the vegetation line was ruler-straight
on all four sides of the forecourt. Both radial culls (`MAT_CULL_M`, `LOD_M`)
were perturbed last round; the linear ones are now perturbed by `edgeWander`, a
smooth deterministic three-period function of the coordinate running along each
edge (±0.34 m on the pad, ±0.30 m on the driveways). Deterministic and smooth,
not per-plant jitter, so the boundary reads as an edge that has been encroached
on rather than as noise, and plants do not move between builds.

# 5. COST

| | before | after | delta |
| --- | --- | --- | --- |
| built triangles | 588,789 | 728,816 | **+140,027 (+23.8%)** |
| draw calls | 57 | 57 | **0** |

**This is my largest single-round increase and I want it flagged rather than
buried.** All of it is the new planting; the needle primitive is a rewrite of
existing vertices, the boundary wander moves a mask, and the census is
build-time only. Both new items are hard-bounded by construction —
`budget: 70` shrubs and `conifers: 6`, both refused rather than scaled when the
scatter cannot place them.

Where it went, and the honest awkwardness in it: the 70 shrubs cost about 530
triangles each (~37k) and bought the 0.4–1.5 m band going 11.1% → 17.8%. **The 6
conifers cost about 7,000 each (~42k) and bought 3–6 m going 1.9% → 4.0%** —
that is 42k triangles for 20 cells of coverage, by far the worst ratio in the
system, because `buildPine` costs roughly the same whatever height you ask it
for. If the performance agent needs triangles back from vegetation, **the six
open-ground conifers are the first thing to cut** and they will return 42k for
the smallest visual loss of anything I own. I left them in because the 3–6 m
seam is what makes the pines read as a separate backdrop layer rather than as
part of the site, but it is a judgement call and I would not defend it hard.

Frame cost from `renderer.info` on the `wires` preset in the final bundle: 437
draws / 2,713,395 triangles.

**On the registry-count warning:** my numbers do **not** come from a registry
line that could omit meshes. The census pass now states its coverage and proves
it — there is exactly one `scene.add` in the file so everything hangs off one
group; `Line`, `Points` and `Sprite` are counted separately and reported as
`uncountedDraws`, which is **0**; and the report now carries the field
`trianglesAre: "built, not rendered; excludes culling and the shadow pass"`, so
nobody reads it as a frame cost. For frame cost, `shoot6` prints
`renderer.info.render` per shot: 505 draws / 2,787,547 tris on `approach`.

# 6. THE NaN, AND AN ASSERTION SO IT CANNOT RECUR

The NaN that poisoned the environment cube came from this system's
`vegScrub.ts`, and Lighting has fixed and documented it. Two things I added.

**The defect shape is a coin flip, not a rare edge case.** Swept over 2,000
plausible heights, `PlaneGeometry(w, h, 1, 2).translate(0, h / 2, 0)` leaves the
bottom row at a *negative* value in float32 for **50.1%** of them. That is why
55 of 56 clump geometries were affected: a clump escapes only if every one of
its cards happens to land on the safe side of the rounding.

**Reading the code cannot find this class, so I did not rely on reading it.** I
went through all nineteen fractional-power and `sqrt` sites in these generators
and would have cleared several of them, because whether an algebraically-zero
expression comes out slightly negative depends on float32 rounding that is not
visible in the source. Instead, `tools/_vegsmoke-entry.ts` now asserts **every
attribute of every geometry this system can build is finite**, plus every card
tint and instance matrix — cards are the other route into the PMREM, and the
pine card tint is built from `Math.pow(s, 0.8) * Math.pow(t, 0.7)`, the same
arithmetic shape that caused the outage. The check is verified to fire on a
planted NaN, and the tree currently passes it clean. It runs in under a second
on the CPU with no GPU and no browser.

# 7. ON THE WORLD CAPTURE

Noted, and it applies to this round: I did not change foliage albedo, but I did
add 76 plants and I did change the foliage card primitive's normals, which alters
how much light the crowns bounce. **Planting density in the near field is up
about 50% in the two bands that were empty**, so vegetation's contribution to the
PMREM cube has grown and everyone's ambient will have shifted slightly greener
and darker near the ground. Flagging it because it propagates scene-wide.

# 8. NOT DONE

- **The base level of the wire colour** is still not isolated — only 2 wire
  pixels fall against sky in the `wires` preset. A preset that puts the pole
  line against open sky would settle it in one capture.
- **0.4–1.5 m is at 17.8%, not at parity with 1.5–3 m.** Roughly another 60
  plants and 45k triangles. Deliberately left for after a critic looks at the
  frames.
- The seven-preset round `2026-08-28T212546Z-117fb7008ed2` verifies the shipping
  render of everything here. One source change was made after it: moving the
  `wiresEnabled` assignment earlier so the debug flag works. That line is inert
  when no flag is set — `on("wire")` returns true either way — so the shipping
  path in that round is the shipping path in the tree.
- The `sitesOnRoof: 96` entries at ~(134, 160) are all far-field scatter on
  terrain that is genuinely 1.7 m high out there, not on the building. Benign.


# ROUTING NOTES FOR OTHER SYSTEMS — READ IF YOU OWN TERRAIN OR LIGHTING

Two defects were isolated in vegetation's frames that are not vegetation's to
fix. Both are reproduced below with the exact control, so neither needs
re-deriving. Vegetation is not working on either; do not wait on us.

## → TERRAIN: the "lake" below the treeline is the far ground plane

**Frame.** `wide.png`, round `2026-08-28T192658Z-4aabb34149be`, in
`shots/<round>/`. A flat cool band with a straight top edge runs the full frame
width below the treeline, and reads unmistakably as water.

**Measurements**, swept over columns 100..1400 (not hand-picked regions):

| region | rows | luma | R−B |
| --- | --- | --- | --- |
| treeline base, above the strip | 270..289 | — | **+10.2** |
| **the strip** | **292..301** | **62.9** | **−1.0** |
| dirt, below the strip | 304..330 | — | **+9.8** |
| sky at the same azimuth | — | — | **+4.6** |

**The control that settles ownership.** `?vforce=noline` removes vegetation's
entire distant landscape — all four horizon bands. **The strip is still there,
unchanged.** The control region below it is byte-identical between the two
captures (48.4 luma, R−B 9.8, both). So the strip is the far ground plane. The
bands were partly *covering* it: the strip immediately above it goes 138.4 →
80.4 when the bands are present, which is why four rounds of band tonal work
never moved it — they were tuning the object standing in front of the artefact.

**The likely mechanism, for whoever picks it up.** The strip fades toward
something *cooler than the sky it is supposedly dissolving into*: sky at that
azimuth is R−B **+4.6**, the strip is **−1.0**. That is the shape of an aerial
perspective term using a plausible cool constant rather than consuming
`skyRadiance` per azimuth — the same bug vegetation removed from its own bands.
`framescan` now carries `PALE BAND` and `BAND DESATURATED AGAINST SKY`, which
both fire on it; the old cool-inversion sweep did not, because the strip is
barely cool — what identifies it to the eye is that it has lost its *colour*.

## → LIGHTING: foliage self-shadowing is removing the direct sun from the crowns

**Frame.** `sunlit.png`, same round. Crown region `250,300,500,260`.

| | luma | R−B |
| --- | --- | --- |
| shadows on (shipping) | 78.7 | **−1.8** |
| `?vshadow=0` | 84.2 | **+4.0** |

Whole-frame near-black pixels go **24% → 15%**.

The sign of R−B is the finding, not the luma. With foliage shadow casting on,
the crowns are not merely darker — they have lost the *warm* component
altogether and are left lit by cool sky only, which is exactly the
"near-black desaturated olive" read three critics have filed. **The building
beside them in the same frame takes hard direct sun with crisp shadows**, so the
sun is present and correctly aimed; this is the shadow path over-occluding a
6.2° sun through 8972 double-sided alpha-tested cards.

**This is a shadow problem, not an albedo problem.** Vegetation has darkened and
re-brightened foliage albedo across two previous rounds chasing this and both
were wasted. Do not adjust foliage albedo to compensate.

Vegetation is taking the *in-crown* half of this — an unshadowed intra-canopy
scattered-sun term, since a real needle canopy at grazing sun is lifted from
inside by multiple scattering that a binary shadow test cannot produce (see the
transmission section below). What is left for Lighting is whether the cascade
resolution and bias at this sun elevation are producing more occlusion than the
geometry warrants. `?vshadow=0` is the bound on the whole effect.

---

# SESSION OF 2026-08-29 (GPU) — READ THIS FIRST, IT RETIRES MOST OF WHAT IS BELOW

Four rounds captured on the RTX 4060. Headline round
**`2026-08-28T194807Z-789dc266c8ca`** (`KEEP`), full-queue round
**`2026-08-28T192658Z-4aabb34149be`** (`KEEP`, 7/7, `__SYSTEM_ERRORS` empty).

## The raggedness number moved the wrong way, and the instrument was the reason

Against the baseline of **0.96 px mean jump / 76% identical**, `wide.png` came
back at **0.69 px / 73%** — worse, after a change intended to improve it. Two
findings came out of chasing that, and the second is the one that matters.

**`framescan`'s RULED HORIZON test was measuring its own selection.** It kept
only columns whose skyline sat within 12 px of the modal row, then averaged how
far the skyline moved between adjacent survivors. On a frame whose skyline
wanders 30 px that gate discards precisely the columns that wander, so the
number was an average over a population selected for not moving: **0.69 px
through the gate against 10.5 px without it** on the same frame. This is this
project's standing failure one level down — not "the statistic covers more than
the feature" but "the sample is chosen by the property being measured". It also
scored whole-pixel rows, so "% of adjacent columns identical" was a measure of
quantisation for any edge moving under a pixel per column, which is the case in
dispute.

Fixed in `tools/framescan.mjs`, and it affects every system:

- The gate is now **one-sided**. Trees, poles and parapets stand in front of the
  horizon and are taller than it, so an object can only push a column's skyline
  *up*; a column below the modal row is the horizon dipping, which is signal.
  The count rejected as objects is printed.
- Sub-pixel edge position, from the half-luma crossing between that column's own
  sky and its own ground.
- Reports **p05..p95 spread** and the **longest identical run** alongside the
  per-column jump, because flat-locally and flat-globally are different claims
  and a rule is both.
- **The firing condition was wrong and fired on all seven frames of a healthy
  round.** It was `median whole-row jump <= 1 && step >= 30`, and the median of
  a set of integers is 0 the moment half of them are 0 — true of every distant
  treeline. It was a test for "the horizon is far away" dressed as a test for
  "the horizon is a drawn line". Now `sub-pixel jump < 0.25 && spread < 6`.
- `--selftest` carries a new pair: a planted dead-straight skyline that must
  fire, and one wandering 0.15 px per column that must not. **The old condition
  fired on both.** Selftest passes.

**With the corrected instrument, RULED HORIZON fires on zero of the seven
frames**, and the crops confirm it: the skyline visibly undulates. Numbers for
the next comparison, from `2026-08-28T192658Z`: `horizon.png` 0.74 px / 11.2 px
spread / longest run 33; `approach.png` 0.72 / 23.0 / 18; `wide.png` 10.90 /
27.8 / 24; `sunlit.png` 1.07 / 17.9 / 22.

**Do not re-raise the other three bands' `samples`.** That lever was documented
here as the next step and it is aimed at nothing. `tools/vegsilhouette.mjs` on
the `wide` pose shows the 520 m band clearing the horizon by **−3.7 px mean,
+2.9 px max** — it is *below* the horizon line almost everywhere, so the
5632-sample change was made to a band that does not draw the skyline in that
frame. The apparent-height ranking that justified it (13.5/520 against 16/780)
silently assumes a ground-level eye; `wide` is at 12.5 m, and subtracting eye
height reorders the bands completely.

## The lake is real, it is in the pixels, and it is not ours

`wide.png` carries an unmistakable flat cool band with a straight top edge below
the treeline, full width. Measured over columns 100..1400: rows 292..301 read
R−B **−1.0** at luma 62.9, against **+10.2** in the treeline base above and
**+9.8** in the dirt below.

**`?vforce=noline` — the entire distant landscape removed — leaves it there**,
and the control region below it is byte-identical between the two captures
(48.4 luma, R−B 9.8, both). So the strip is the far ground plane, and the four
horizon bands were partly *covering* it (the strip above it goes 138.4 → 80.4
when the bands are present). Four rounds of band tonal work never moved it
because they were tuning the object standing in front of the artefact.

This belongs to whoever owns the far ground's aerial perspective. The tell is
that it fades toward something **cooler than the sky it is supposedly dissolving
into** — sky at that azimuth measures R−B +4.6 and the strip is −1.0, which is
the `skyRadiance`-versus-plausible-constant shape exactly, in another file.

`framescan` now also carries **PALE BAND**, a two-sided sweep on saturation
rather than warm/cool, because what identifies that strip to the eye is that it
has lost its colour, not that it is cool — it is barely cool. Plus a
**BAND DESATURATED AGAINST SKY** clause beside the brighter-than-sky one.

## Verified in pixels this session

- **The roof shrub is fixed, and last session's move had made it worse.**
  `?vforce=nopines` removed the parapet clump, so it was a pine.
  `tools/vegroofshrub.mjs` (new) scores every pine against every preset on the
  CPU and reproduced the defect before the fix: pine 2 at (−30.5, 30.5), **83%
  of its height hidden, 50 px of detached crown predicted at screen x=596** —
  the clump in the frame measures 565..605. It also found that pine 4, the tree
  *moved last session to fix this*, was now 74% hidden in `approach` and 92% in
  `sunlit`. The single-pose fix relocated the coincidence, which is what the
  previous note here was afraid of. Both moved to positions swept clean against
  all seven presets: pine 2 → (−30.0, 23.5), pine 4 → (29.5, 61.5). Confirmed
  in the round above: the floating clump is gone and the tree reads as connected
  to the ground.
- **Foliage self-shadowing is eating the direct sun.** On `sunlit`, crown region
  250,300,500,260: `?vshadow=0` moves it **78.7 → 84.2 luma and R−B −1.8 → +4.0**
  — the crowns are not merely dark, they lose the *warm* sun and are left lit by
  cool sky only, which is the "near-black desaturated olive" read. Whole-frame
  near-black 24% → 15%. The building beside them in the same frame is brightly
  lit with hard shadows, so the sun is present and it is the foliage shadow path
  over-occluding at a 6.2° sun through 8972 alpha-tested cards. **This is the
  largest remaining defect and it is a shadow problem, not an albedo problem —
  do not darken or brighten albedo to chase it.**
- **Foliage cards read as broad hard-edged fronds**, with visible stair-stepped
  quad edges and sky through the crown interior. Queue item 3 confirmed, not
  started.

## Not started, in the order I would take them

1. The foliage shadow over-occlusion above — biggest measured win, and cheap to
   bound with `?vshadow=0` as the control.
2. Needle-shaped foliage primitive (item 3), now confirmed in pixels.
3. Continuous inter-plant ground mat. `groundSoil` still not published.
4. Mid-storey volume, straight-line mask audit.
5. `sitesOnRoof` is **96** in the last round with `midOnRoof` 0, and the
   reported `roofSites` are at world XZ far outside the building footprint. That
   counter is either mis-named or measuring something else; it is not evidence
   of anything until someone reads it.

## Tools added

`tools/vegroofshrub.mjs` (all-preset roof-shrub scoring, with `--sweep=I`),
`tools/hzprobe.mjs` (the gated-versus-ungated comparison that found the
framescan bias). Both CPU-only.

---

# Handover — System 6, vegetation

Halted mid-capture on request (user needed the GPU). **Everything below is
CPU-verified only: typecheck clean, arithmetic checked, but zero pixels
captured.** No round id was produced. Treat every visual claim as unverified.

Port 5119 has no listener. Two orphaned Chromium PIDs from the interrupted run
were killed; no vite/playwright/shoot6 node processes remain.

## The diagnosis that matters, and it retires a four-round artefact

The "distant lake" band was never a colour problem. Measured per column in
`wide.png`, the pale strip peaks at **luma 171.5** while my brightest horizon
band authors to about **152** — so the strip is *sky*, not my geometry. What made
sky read as water is the band edge underneath it: the skyline was identical
between **76% of adjacent columns** while dropping **55 luma** across it. A
shoreline. This unifies the water read with "flat wall", "cardboard cutout",
"perfectly constant height" and "comb-like skyline" as one defect, and explains
why three rounds of tonal fixes moved my numbers without moving what a human saw.

## Ruled horizon — changed, unverified

Two causes, both measured:

1. **Amplitude.** `envelope()` in `src/gen/vegDistant.ts` blended five independent
   uniform noise rings. An average of independent uniforms concentrates: sd 0.121,
   p1..p99 span 0.19..0.75, so a nominal 11–16 m range only produced 11.97–14.77 m
   — 2.8 m of 5, about 7 px of total edge movement. Fixed by standardising the
   composed value and squashing with `tanh` rather than clamping (a clamp gives a
   plateau at `hMax`, which this file has hit three times already). Simulated
   before/after: span 0.561 → 0.957, height range 2.80 → 4.78 m of 5, edge 7.2 →
   12.2 px, no plateau.
2. **Sampling — and this was the larger half.** The standardisation only moved the
   per-column jump 0.10 → 0.23 px. The near band (520 m) sets the skyline because
   it has the greatest apparent height (13.5/520 vs 16/780 for the next), and at
   2560 samples its polyline had a vertex every **4.9 px**, so between vertices
   the top edge is a straight line at any amplitude. Raised to 5632 samples
   (~2.2 px pitch). The old comment claiming finer sampling "is not more detail;
   it is a per-pixel sawtooth" was the wrong call — its crowns are ~16 px wide.

Also: crown weight raised to 0.52 now that amplitude is available, plus a new
1400 m `swell` ring so the canopy undulates over hundreds of metres as well as
metres.

**Target to check against:** `framescan`'s new `RULED HORIZON` reports raggedness
(mean px the skyline moves between adjacent columns) and the identical-column
fraction. Before: 0.96 px / 76% on my `wide.png`, and Lighting measured 0.39 px /
94 luma from its own pose. Both should improve; I do not know by how much.

## `skyRadiance` — consumed, unverified

- Resolved in `VegetationSystem.init()`, **throws if missing**, per the
  `groundHeight` precedent. Also throws if `colourSpace !== "linear-srgb-scene-referred"`,
  read as a field rather than assumed — two of today's bugs in that file were
  display-vs-linear confusions and both typechecked.
- Bands converge **per azimuth** via a new `DistantSpec.hazeAt`, sampled into a
  96-step ring (3.75° apart) at build time and interpolated per vertex. A single
  published colour would have reproduced my bug at a different azimuth; the
  mechanism was the snapshot, not whose snapshot it was.
- `sunColour` for the transmission term is derived from `horizonToward(sunDirection)`
  rather than a guessed constant, for the same reason.
- Old `SKY_HAZE` constant is still the fallback argument inside `buildBand` but is
  now unreachable when `hazeAt` is supplied. Worth deleting once verified.

## Also changed, unverified

- **Transmission term** — new `src/gen/vegTransmission.ts`, applied to all three
  foliage materials (pine needles, clump cards, mid-storey). Wrap-diffuse to soften
  the terminator plus a forward through-leaf lobe that peaks looking into the sun.
  Additive on outgoing radiance, alpha-weighted, normal signed toward the viewer so
  double-sided cards do not go half-black. This is the missing light path behind
  "near-black desaturated olive-brown" crowns — I chased albedo for two rounds
  when the standard Lambert term was simply evaluating to zero on every visible
  needle at a 6.2° back-lit sun.
- **Straw clump** — far-field scale was overshooting to 3–5 m (two-thirds building
  height). My compensation for `one()`'s 0.35 factor was a real bug fix that I then
  took as licence to multiply without converting back to metres. Now ~0.3–1.7 m,
  cluster count 150 → 58, and the tint inverted so the majority is living
  grey-green (`rng() * rng()` had been biasing hard toward straw).
- **`framescan`** — new `RULED HORIZON` and `BAND BRIGHTER THAN SKY` tests,
  measured per column. Fires on all six of my frames (55–86 luma at 76–85%
  identical) and on Lighting's `wide_golden.png` at the same rows as its cool
  inversion, confirming both findings are one object.
- **`sunlit` preset** in `tools/shoot6.mjs` — the first pose with the sun behind
  the camera (forward·sunDirection = −0.991, checked with the dot product because
  my first attempt scored +0.48 and was still back-lit). Every existing preset
  looks roughly along `sunDirection`, so no critic has ever seen a lit crown.
- **`NOTES.md`** — new general case: an average over a spatial extent is not
  evidence about a feature occupying part of that extent. Four instances, three
  committed while fixing another.

## Exact next step

Run `KEEP=1 node tools/shoot6.mjs` (seven presets now), then immediately
`node tools/framescan.mjs shots/system6/rounds/<id>/*.png` and compare raggedness
and identical-column fraction against 0.96 px / 76%. That single number tells you
whether the ruled-horizon fix landed, and it is the highest-value thing in the
round. If raggedness is still under ~1.5 px, the remaining cause is sampling on
the *other* three bands, not amplitude — raise their `samples` the same way.

## Not started

Continuous inter-plant ground mat (critic's #1 defect — thatch/crust/litter
*between* shrubs, not more discrete plants), needle-shaped foliage primitive
instead of broad leaves, straight-line mask and cull audit (`edge.png` x≈200–450,
`pines.png` y≈330), moving the pine that three critics read as a roof shrub.

## Not mine

Tiling pebble bump on the ground texture — routed to terrain, untouched.

---

# APPENDED BY THE CROSS-SYSTEM (CPU-ONLY) PASS — 2026-08-29

*Not written by this system's owner. Nothing above was edited. This section is
appended to all five non-terrain handovers with identical text.*

## Shared change in `src/core/Game.ts`: `?solo=` / `?skip=` now actually isolate

**Read this if any of your harnesses gate on `window.__SYSTEM_ERRORS`. All of
them should, and most of them do.**

The terrain agent fixed a bug in the shared `src/core/Game.ts`. `Game.start()`
filtered which systems received `init()`, but `Game.frame()` iterated **every
registered system**, so a system excluded by `?solo=` / `?skip=` still had
`update()` called on the first tick with none of its own state built. It threw,
and the throw was recorded on `window.__SYSTEM_ERRORS`.

Concretely: `?solo=lighting,terrain` produced two `__SYSTEM_ERRORS` entries —
`player.update` and `interaction.update`, both
`Cannot read properties of undefined` — naming two systems that were never asked
to run. So the isolation flag that exists to let you capture your own system
while somebody else's is throwing **manufactured a failure in the one channel
every harness treats as authoritative**, and any harness correctly failing on
`__SYSTEM_ERRORS.length !== 0` could never use it.

### What is in the tree now (verified by reading `Game.ts` this session)

- `Game` keeps a `private active: GameSystem[]`, set in `start()` from the
  `?solo=` / `?skip=` filter.
- `frame()`, `onResize()` and `dispose()` all iterate `this.active`, not
  `this.systems`. Only `register()` and the filter itself touch `systems`.
- An unrecognised name in `?solo=` / `?skip=` now **throws** out of `start()`
  and lists the registered names, rather than being ignored. That is NOTES
  case 25 applied here: a misspelt system name used to silently produce a
  capture of a scene nobody asked for, and it looked exactly like a correct one.

### What it means for you on resume

- `?solo=<yoursystem>` and `?skip=<someoneelse>` are usable again. If another
  agent's system is throwing and blocking your captures, isolate rather than
  waiting.
- **Keep gating on `__SYSTEM_ERRORS.length === 0`.** The point of the fix is
  that the gate is now trustworthy under isolation; it is not an invitation to
  relax it.
- Any past round whose notes blame `player.update` or `interaction.update` while
  a `solo`/`skip` flag was in the URL should be re-read: those entries were
  fabricated by this bug, not by a real failure.
- If you pass a system name to `?solo=`/`?skip=`, spell it exactly as the
  system's `name` — a typo is now a hard, loud failure instead of a silent
  wrong capture.

Written up as **NOTES.md case 32**, confirmed present in `NOTES.md` this
session. Its general shape is worth more than the bug: *a facility that
suppresses part of a lifecycle must suppress every phase of it, and the phase
that gets forgotten is the one in the hot loop.*

## Also: see `RESUME-PLAN.md` at the repo root

New this session. One first command per system, what it should prove, the
numeric baseline it is measured against, and the cross-system dependency order
(most of paint / glass / metalness / wet reflections is behind Lighting's PMREM
world capture).

---

# ROUND 2026-08-28T221024Z-67b6fbe50770 — FINAL FOR THIS SESSION

7/7, RTX 4060, no shader errors, port 5119 clear, marked `KEEP`. Supersedes the
earlier rounds in this file for the shipping state.

## Shared tooling promoted out of this system

**`tools/finitecheck.mjs`** — not vegetation-specific, for any system. Asserts
every attribute of every geometry is finite, including morph targets, plus
`instanceMatrix`, `instanceColor`, loose `{ matrix, tint }` card lists before
they reach a mesh, and object transforms. `--selftest` plants eight defects that
must each be caught and three clean inputs that must not fire, and prints the
50.1% sweep as evidence. Runs in under a second, no GPU, no browser.
`tools/_vegsmoke-entry.ts` is a worked example of calling it, and I verified it
end to end by planting a NaN in a real generator and confirming it fired with an
exact index, then reverting.

The argument for using it rather than reading code is in `NOTES.md`: **source
review is not a valid clearing method for this class.** I read all nineteen
fractional-power sites in these generators and would have wrongly cleared
several, because whether an algebraically-zero expression lands negative is
float32 rounding, not source.

**`tools/shoot6.mjs`** — GPU is now re-read **per shot from the live context
that drew the frame**, not only from the startup probe page, since Playwright
may add `--enable-unsafe-swiftshader` regardless of what we pass. Every shot
line now carries `gpu=hw`, and a software renderer or a mismatch against the
startup probe is a hard failure. All seven shots in this round report `gpu=hw`.

## Straw clumps — the early critic note, finally addressed

Colour was already done in an earlier round (majority grey-green, straw as the
minority). Scale, silhouette variety and count were not:

- **Scale.** The size distribution was `lerp(0.24, 0.98, rng()^3 + 0.12)`. A
  cube of a uniform has mean 0.125, so the typical clump came out about 0.42,
  which on the grass form's 0.8 m card is a **0.34 m** plant — ankle height. Now
  `lerp(0.34, 1.45, rng()^2 + 0.1)`, mean about 0.73, typical grass clump about
  0.58 m and the range roughly 0.3–1.2 m. Knee to hip. **This costs zero
  triangles** — instances share geometry, so size is free.
- **Silhouettes.** A per-instance horizontal aspect, x × wide and z ÷ wide so
  footprint area is preserved. 28 distinct shapes existed already, but every
  instance of a shape was scaled uniformly in x and z, so all of them presented
  the same proportions — a repeat the eye catches long before it can name the
  shape. Also free.
- **Count.** 3,244 → **2,429** (−25%).

Census, session start → now, same 946 plantable cells:

| band | start | now |
| --- | --- | --- |
| nothing | 12.0% | 10.5% |
| 0–0.15 m | 40.7% | 34.6% |
| 0.15–0.4 m | 12.2% | 8.5% |
| **0.4–1.5 m** | **11.1%** | **20.1%** |
| 1.5–3 m | 16.7% | 17.0% |
| **3–6 m** | **1.9%** | **3.9%** |
| 6 m+ | 5.4% | 5.5% |

**Nothing above ankle in the near field: 52.7% → 45.1%.**

## A cost regression caught between the two final captures

The first capture of this change came back at 749,189 triangles — *up* on the
previous round despite 25% fewer clumps. Ground mats had gone 945 → 1,834,
costing +40k, which is more than the clump reduction saved.

Cause: `sites.filter((s) => s.size > 0.44)` decides which clumps get a ground
contact decal. It reads as "clumps big enough to cast a visible contact shadow",
but 0.44 had been tuned against the old distribution whose mean was 0.42 — so it
was really "the top third of clumps" wearing an absolute label. Doubling the
clump size silently made it select nearly all of them. Raised to 0.82; mats came
back to **832** and triangles to 704,223. Worth naming as a shape: **a threshold
written in absolute units but tuned as a percentile keeps its label and changes
its meaning the moment the population moves.**

## Cost

| | session start | final | delta |
| --- | --- | --- | --- |
| built triangles | 588,789 | 704,223 | **+115,434 (+19.6%)** |
| draw calls | 57 | 57 | **0** |

Frame cost from `renderer.info`, worst preset (`approach`/`wide`/`sunlit`): 517
draws, 3,020,020 triangles.

Standing offers if the budget guard asks for triangles back, in order:
1. **The six open-ground conifers, ~42k** — pre-agreed, worst ratio in the
   system at ~7,000 triangles each for 20 cells of coverage.
2. **Ground contact decals, ~39k** — 832 mats; the threshold is one number.
3. The mid-storey open-ground shrubs, ~37k, but these are the ones that bought
   the 0.4–1.5 m band and I would give up the conifers and the decals first.

## On the world capture

Foliage albedo unchanged, deliberately, per the request not to move a target
other agents are tuning against. But planting density and clump scale both moved
this round: near-field cover above ankle is up about 7 points and the clumps are
roughly double their previous linear size, so **vegetation's contribution to the
PMREM has grown again**. Ambient will read slightly greener and darker near the
ground. I have not touched foliage albedo and will not without asking.

## Open

- Foliage albedo re-judgement against the world capture: **not done, on
  purpose.** It is the one remaining queue item and it is exactly the kind of
  change that would move everyone's ambient, so it needs a decision first.
- The wire base level is still not isolated — only 2 wire pixels fall against
  sky in the `wires` preset. A preset putting the pole line against open sky
  settles it in one capture.
- An independent critic is about to see these frames having seen none of the
  measurements above. Where it disagrees with the census, the census is a
  statement about ground area occupied per height band in the near field, and
  nothing else — in particular it says nothing about how anything reads at
  distance, in silhouette, or in colour.

---

# Round 2026-08-28T223759Z-56b2adc268dc (bundle 56b2adc268dc)

Previous round in the same sitting: `2026-08-28T222251Z-c6b94000d143`. Both are
7/7, both `gpu=hw` on every shot from the live context that drew the frame.

## Collision: `vegetation.blockers` is now published. 58 rectangles.

The one line the collision agent was waiting on. It is `vegetation.blockers`,
not `veg.blockers` — `collision.ts` matches on the `.blockers` **suffix**, and
the name in `RESUME-PLAN.md` is the one I used, so anyone grepping for either
will find it. `__VEGETATION.blockers = 58`, `blockerRangeM = 62`.

All three requirements are met, and each one is enforced somewhere a future
edit will trip over it rather than in a comment:

- **Near only.** `addTrunkBlocker` drops anything more than 62 m from `[0, 10]`.
  Ten site pines and 3,000 treeline trunks go in; 58 come out. The point is the
  broad phase, not the narrow one: one rectangle per group means a group
  spanning 3.5 km never rejects, so every member is tested every frame the
  player is anywhere.
- **Trunk radius, not drip line.** `buildPine` now returns `trunkRadius`, the
  swept radius at 1.3 m, ~0.19 m on a 15 m tree. It is *returned* rather than
  recomputed by the caller because the taper is a root flare times a fractional
  power, and a second copy of that arithmetic is a second thing to keep in step.
- **No pre-inflation.** Half-width is exactly the radius.

Fence posts and poles are in the same publish, and were the fiddlier half:
`buildFence` and `buildPoleLine` merge every upright into one geometry, so their
positions did not survive the build at all. Both now return a `posts` list.
Downed fence posts are excluded — they are lying on the ground. T-posts get
21 mm, timber posts 62 mm, poles 130 mm at standing height rather than at the
butt. Wire is not solid. Foliage is not solid.

## The critic: what was true, what was a symptom, and one hypothesis it refuted

**B9 — "foliage sits only on one side of the trunk, with a hard vertical cut" —
was a real defect and is fixed, verified in pixels.**

The critic guessed culling. It was one constant:

```ts
const asymmetry = 0.3 + rng() * 0.45;   // lightBias = 1 + asymmetry*cos(az - bestAz)
```

That is a light bias running 0.25 to 1.75 — a **7:1** ratio between the
favoured and the starved side of the same tree. Below the starved side's
branches lies `len = Math.max(0.14, len)`, so they all collapse onto the 14 cm
floor: half the crown becomes stubs and the trunk is naked down one face, with
the cut falling exactly on the trunk line because that is where `cos` changes
sign. Real one-sided-light asymmetry is 1.2:1 to 1.7:1 and shows as a lean in
the crown's centre of mass. Now `0.1 + rng() * 0.16`. The tall right-hand pine
in `wires.png` carries foliage on both sides of the trunk in this round's frame.

**Two more construction defects found while measuring B9, both fixed:**

- *A clamp that binds on the tail is a ruler drawn along the silhouette.*
  `len = Math.min(H * 0.34, ...)` bound on only **1.0% of all branches** — but
  on **9.0% of the long branches that define the outline**, and every one came
  out at exactly `0.340 H`. That is a straight edge authored into the crown, and
  it is part of "flat quadrilateral patches with straight edges". Replaced with
  a smooth saturation, `CAP * (1 - exp(-raw / CAP))`: still bounded, never hit.
- *A profile that is a function of height alone gives every whorl the same size.*
  Whorl spacing was already irregular, so "regular vertical intervals" was not
  the spacing — it was that the crown profile is smooth in `t`, so whorls at
  similar heights got identical nominal sizes and stacked into equal discs. Added
  a per-whorl vigour, `0.62 + rng() * 0.66`. A tree grows one whorl a year and
  the years are not equal.

**B8 — "the foreground plant at left is enormous" — is real, still present, and
my diagnosis was wrong.** I read it as one of the 3.4–5.6 m open-ground conifers
landing near the forecourt, and tapered their height with distance from `[0,10]`
so the tall end sits at the back of the lot (full height past 34 m, seedling at
the pumps). That change landed — `3-6m` cells went 37 → 30 — **and the plant in
`wires.png` is pixel-for-pixel the same size.** So it is not a conifer. It is
almost certainly a fence-line `midEdgeSites` plant one or two metres from the
camera, and the next step is a probe rather than another guess. Recorded as a
refuted hypothesis rather than a fix, because the taper is defensible on its own
terms but it did not do what I predicted.

Not addressed this round, all still open: shrub species/size/spacing uniformity
(the planted-hedge read), no debris skirt where anything meets the ground, and
B5 (the horizon haze band terminating mid-frame — likely mine, the near band).

## Foliage albedo: measured, and deliberately changed by very little

Authorised as the last change, so here is the before and after and the reasoning,
because the reasoning is the part that matters for everyone else's ambient.

Live needle albedo was a three-tier linear ramp:

```
[0.052, 0.100, 0.060]     luma 0.081   <- below the band its own comment states
[0.082, 0.152, 0.084]     luma 0.128
[0.118, 0.212, 0.112]     luma 0.181
```

Only the darkest tier was actually wrong: the comment above it states a green
channel of 0.10–0.20 linear for sunlit conifer needles, and 0.100 sits on the
floor of that with a luma of 0.081, which is a near-black material. Lifted to
`[0.062, 0.124, 0.070]`, luma 0.100. The other two tiers are already correct and
are untouched.

**I did not make the large change, and other systems should not expect a large
shift.** The crowns do read too dark, but the measurement says that is not
reflectance: with `?vshadow=0` the same crowns go 78.7 → 84.2 luma and R−B goes
−1.8 → +4.0, so what is missing from them is direct sun. Raising albedo until
the crowns looked right would push a wrong number into `scene.environment`,
which is now a PMREM of the real scene — every other system would then be lit by
vegetation compensating for a shadow cascade it does not own. That is the
critic-names-a-cause trap in material form. The cause is the self-shadow finding
already routed to Lighting.

Caveat on attribution, stated plainly: this round changed the albedo tier *and*
three pine construction constants, so the +8 luma in the `pines` low-region stat
(53 → 61) cannot be attributed to the albedo alone. The albedo change is small
by construction and the pine changes are not; most of that is the pines.

## Cost: down, not up

| | previous round | this round | delta |
|---|---|---|---|
| built triangles | 704,223 | 646,332 | **−57,891 (−8.2%)** |
| draw calls | 57 | 57 | 0 |
| foliage cards | 12,269 | 9,363 | −2,906 |
| mid-storey cards | 31,039 | 24,944 | −6,095 |

The reduction is a side effect, not a target: a softer branch cap and per-whorl
vigour both shorten the average branch, and the near conifers are smaller. The
crowns look better with fewer cards in them, which is worth noting for the
performance agent's budget guard — this system gave back 8% while fixing a
defect, and I would rather that headroom went to the shrub-variety work than be
reclaimed.

## Teardown

Port 5119 has no listener (`TIME_WAIT` sockets only, which is the kernel's 2MSL
wait, not a process). No Chromium with 5119 in its command line. `tsc --noEmit`
clean. `archive.mjs --scan` reports every capture readable and of plausible size
across 180 files.

---

# Round 2026-08-28T225859Z-a2e79eb93205 (bundle a2e79eb93205)

7/7, `gpu=hw` per shot from the live context. Port 5119 clear, 187 captures
scan clean, `tsc --noEmit` clean.

## B8: answered in one run by a probe that takes no coordinates

New tool, `tools/vegscale.mjs`. It takes a pose name and nothing else, projects
**every plant the system placed** into the capture camera, and ranks them by
apparent height against the building as a reference. The ranking is the same
ranking whether or not anyone had noticed the plant, so it cannot be accused of
choosing its region — the property that makes `probe-zeroscan` and
`probe-unseen` the two probes in this tree that actually settle arguments.

It needed two pieces of plumbing, both worth keeping:

- `VegetationSystem` now publishes `vegetation.sites` — kind, x, z, height for
  all 228 plants. Merged geometry cannot answer "which plant is this": one
  `veg-mid-wood` mesh holds 218 of them.
- The capture poses moved out of `shoot6.mjs` into `tools/vegposes.mjs` and are
  imported by both. A probe with its own copy of the camera confidently answers
  a question nobody asked.

First run, `wires`:

```
    apparent   frame%   vs bldg   true h    dist    kind      at
       784 px     87%     5.00x    1.92 m     4.6 m   sage      (-18.9, -13.9)
```

**The plant is a 1.92 m sage 4.6 m from the lens**, not a conifer. My previous
round's hypothesis was wrong, as the capture had already shown.

And the actual defect was not its height, which is a real size for sagebrush.
It was the foliage primitive:

```ts
const size = height * lerp(0.30, 0.54, rng());   // a fraction of the whole plant
```

On a 1.9 m plant that is a leaf cluster **58 to 104 cm across**. A sagebrush
leaf cluster is 5 to 15 cm. So at close range the shrub resolved into a handful
of enormous smooth blades and read as a palm — which is why the critic saw
something implausible without being able to say the height was wrong. It is the
identical defect the pines had, and the third time this critic has described it
("cardboard", "flat quadrilateral patches", "enormous"): **a foliage primitive
sized as a fraction of its plant rather than as itself.**

Now absolute, 7.5–16 cm scaled mildly with plant vigour, with the count raised
from 7–14 to 15–28 to keep the silhouette mass. Verified in pixels: the
foreground plant in `wires.png` reads as a fine-textured shrub, and its bulk
collapses even though its height is unchanged.

**The conifer height taper from last round is kept, on its own merits and not as
a fix for B8.** A 5.6 m tree three metres from a pump island would be cut for
sightlines, and grading the tall end toward the back of the lot gives a
distance-ordered scale ladder that is worth having independently. Stated plainly
because an unmotivated change that happens to be harmless is still a change the
next person has to understand.

## Shrub uniformity: the mix and the stature are now properties of the place

The spacing was already gap-weighted, so spacing was not the hedge read. The
other two things the critic named were:

- **Species mix.** A fixed 72/23/5 split re-rolled per plant is, by
  construction, the same mix everywhere at every scale — a *statistically
  uniform* verge, which is exactly what a planting scheme is and what a real one
  is not. Sage share now swings 0.50–0.90 across a low-frequency field, so sage
  owns one stretch and thistle the next.
- **Height.** `lerp(a, b, rng())` is a flat histogram, a shape no population of
  anything has. Now a skewed variate shifted by a second field, so one run of
  the verge is stunted and another carries the tall ones. That matters because a
  hedge's defining property is that its variation has **no wavelength longer
  than one plant**.

One cost trap on the way, recorded in `NOTES.md`: letting all three species
shares float raised saplings from 5% to a mean 9%, and `buildPine` costs ~7,000
triangles whatever height it is asked for, so that alone was **+40,695
triangles** — 40% of a regression I first went looking for in the height
distribution, where it was not. Sapling share is now pinned; sage and thistle
trade against each other. When one member of a mix is two orders of magnitude
dearer than the others, its share is a budget line, not a style choice.

Vertical distribution after, `tallestPerCell`, against the previous round:

| band | before | after |
|---|---|---|
| 0.4–0.8 m | 75 | 105 |
| 0.8–1.5 m | 127 | 138 |
| 1.5–3 m | 163 | 85 |
| 3–6 m | 30 | 22 |

The 1.5–3 m band is down and that is a real trade against the earlier
band-filling work: a skewed distribution has fewer plants at the top by
definition. I lifted sage and thistle ranges to hold 85 rather than the 53 the
first skew gave. If the next reviewer wants that band back it is one constant,
but it costs the variety this round bought.

## Cost

684,836 built triangles against 646,332, **+38,504 (+6.0%)**, +0 draw calls.
Across the two rounds tonight the system is at 704,223 → 684,836, **−19,387
net**, so the 8.2% given back last round has funded this and left change.

## Something I cannot attribute, flagged rather than claimed

Every shot got dramatically brighter in the shadows this round — `black%` fell
from 28/25/19/14/34/20/30 to 9/11/11/2/12/7/8 across the seven poses, and the
`low` region rose 7–12 luma everywhere. **That is almost certainly Lighting's
ambient regression fix landing in my bundle, not my changes.** My foliage albedo
lift was one tier of one texture and could not do this. Recorded here so nobody
reads it off my round and credits it to vegetation.

## Debris skirt: I think this wants one shared treatment, not three

Asked for an opinion, so: **shared.** The critic gave the same note to
vegetation, the building and the pumps, and the reason it reads as one defect is
that it is one — the site has no *deposition model*. What accumulates at the
base of a thing is not a property of the thing; it is a property of where wind
and water stop, and those stopping places are continuous across the lot. Three
systems each scattering their own litter would put debris in three disagreeing
sets of places and produce a fourth wrong answer: litter neatly ringing every
object and none in the corners where it actually piles.

The shape I would want is the one Terrain already used for `groundSoil` — a
service exposing accumulation as a CPU function of world XZ, owned by whoever
owns the ground, which each system samples when deciding where to drop
material. Vegetation would contribute needle and leaf fall keyed to its own
canopy positions and read the field back for where it settles. I have not built
any of it; flagging it before three of us build three.

## Not done

- **B5**, the horizon haze band terminating mid-frame. Untouched this round.
- Debris skirt, pending the routing decision above.
- The near-field composition question `vegscale` exposes but does not answer:
  in `wires` the top of the list is a 13 m pine at 5.06x the store and a 1.9 m
  sage at 4.95x. Neither plant is wrong. The pose stands 4.6 m from a shrub.
  I have not moved the plant, because moving a plant to please one camera is the
  hand-picking this project forbids, and `vegscale --all` is the tool for
  deciding whether it is a pose problem or a planting one.

---

# Rounds 2026-08-28T231504Z-a604280f5cef and 2026-08-28T232208Z-4b8cf05f40e4

Port 5119 clear, `tsc --noEmit` clean, 200 captures scan clean under Perf's new
capture validation, `gpu=hw` per shot from the live context.

**Not mine, seen in both rounds:** `[lighting] shader chunk patch FAILED: pcss:
BASIC branch not found` on all seven shots, reverting to PCF. Lighting's patch
is mid-edit in my bundle. Shadow quality in these frames is PCF, so do not read
penumbra off them.

## B5: the lit-face term was a function of ring azimuth, so it was constant per frame

`vegDistant` lights each silhouette sample with

```ts
const facing = clamp01(-(Math.cos(a) * sunXZ.x + Math.sin(a) * sunXZ.y));
```

where `a` is the sample's azimuth **around the whole 3.5 km ring**. That turns
over a period of one revolution, and a 46 degree preset sees 13% of it — so
across any single frame the term that exists to make some stands lit and others
shadowed handed every stand the same value. Hence "a constant-value cutout with
a white fringe and no internal variation — no lit faces, no shadowed valleys".
The pale fringe follows from the same thing: a flat silhouette antialiased
against a bright sky has a light edge, and there was nothing else in the band to
compete with it.

Terrain's rule is the fix and it applies verbatim: **shading responds to slope,
so compare the characteristic slope against the tangent of the sun elevation.**
At 6.2 degrees that tangent is 0.109; this height field runs several metres over
samples 0.58 m apart, so its slopes are an order of magnitude steeper than the
sun is shallow. There was never a shortage of slope — nothing was reading it.
Now the along-ring gradient of the skyline is lit against the sun's azimuthal
component, normalised by `SOLAR_TAN`, so a facet steeper than the sun is fully
lit or fully shadowed and shallower ground grades between.

Measured on `wide.png`, mean absolute per-column luma step inside the band, with
the empty sky above it as the reference for "no structure":

| | band | sky | ratio |
|---|---|---|---|
| before | 2.197 | 0.810 | 2.71x |
| slope term into the rim only | 2.432 | 0.891 | 2.73x |
| slope term into the fill | **4.002** | 0.890 | **4.49x** |

Band mean luma 82.3 → 80.0, so this is structure and not brightness.

The middle row is the useful part. My first attempt put the term into `facing`,
which feeds the rim, and bought 10% — the rim is a thin lift on the crown line
and the *fill* is what reads as a cutout. Modulating only the top vertex has the
mirror problem: the quad interpolates up from a flat base, so variation at the
top is washed out over the visible body. Both vertices now carry it, damped at
the base to keep the haze gradient.

**B5 is improved and not closed.** 4.49x the sky's structure is a real range
rather than a cutout, but the abrupt mid-frame termination of the haze band is
untouched and the top edge is still lighter than the body.

## `vegTransmission` cache key: fixed, and the general test

Perf was right. All five keyed values are uniforms — verified by grepping the
file for template substitutions and finding **zero** — so every distinct tuple
compiled a byte-identical program under a different key, which defeated the
cache using exactly the parameters it is supposed to be indifferent to. Now a
constant. The test worth keeping: **a value belongs in
`customProgramCacheKey` if and only if changing it changes the *text* handed to
`compile`. A uniform never does.**

## Terrain's pavement question: yes, go to 400 mm

What limits me is not the excursion, it is how far a tuft's **centre** ends up on
the asphalt — worst case excursion + inset, at the phase where the asphalt
bulges out and my mask is at its innermost. A tuft is 150–250 mm across, so a
centre up to ~300 mm onto asphalt still reads as growing out of the seam.

So I have made the inset a fixed fraction of a declared excursion rather than a
bare 0.13, which keeps that worst case constant as the excursion grows. Current
behaviour is unchanged (0.19 x 0.68 = 0.129 against the previous 0.13). At
400 mm the edge line is already at a 40% slope over a scallop wavelength, so the
geometry runs out before I do.

**Better still: publish `pavementEdge(x) -> z` and I will consume it**, exactly
as I consume `groundSoil`. Then there is no shared constant to keep in step and
no ceiling at all. Until then the 190 mm in my file is a declared duplicate and
is marked as one — it was previously a bare number in a comment, which is the
percentile-wearing-an-absolute-label shape and would have bitten here first.

## framescan's absolute-coolness clause: audited, and kept

Asked to retire any gate that asserts warmth in shadow. `COOL_ABS = 6` looked
like the candidate and is not, and the direction is what matters: it is a
**precondition on reporting a defect**, not an assertion about correct output.
A cooler, correct world makes it fire *more* readily, so it cannot have been
preserving the old warm cast.

Removal was measured rather than reasoned about. Across the seven poses the
finding count went **4 → 14**, and the new firings sit at R-B 28.2 against 42.4,
and 27.4 between 45.2 and 41.0 — warm ground beside warmer ground, which is the
pump close-up this clause was written for. A frame-relative cool tail was also
tried and does not help: the 20th percentile of a uniformly warm frame is still
warm and passes the same regions.

Why a constant is right here where it is usually wrong, which is now in the
file: the quantity is not a property of the population being sampled. Water,
glass and haze are cool in absolute terms because of what they are, so "has this
crossed into cool" is a physical question with a fixed answer. **Recorded as the
counterexample to the percentile case** — a rule with no known counterexample
gets applied where it does not belong.

Selftest passes both controls throughout, including the gradient-only frame that
must return zero. Current state matches pre-experiment behaviour exactly.

## Ambient revert check: nothing to revert

The only thing I authored tonight that could have been aimed at the dark ambient
was the needle albedo tier, and it was reasoned from the band stated in its own
comment (green 0.10–0.20 linear for sunlit conifer needles; the tier was at
0.100 with a luma of 0.081) rather than from how the frame looked. It stands. I
explicitly declined to raise albedo further because `?vshadow=0` showed the
crowns were missing sun rather than reflectance — which Lighting's finding has
now confirmed was the real cause.

## Debris: consuming, not building

Accepted that Terrain owns accumulation as a CPU function of world XZ. I will
consume it and contribute needle and leaf fall keyed to canopy positions when it
lands. **I have not scattered any of my own and will not.**

## `vegscale.mjs` is flagged as shared tooling

Header now carries the adoption path: publish `<system>.sites` with a kind,
position and size per instance, then copy `tools/_vegscale-entry.ts` and change
which system it inits. The projection and ranking are system-agnostic. The
manifest is the same data the collision contract wants, so it pays twice.

One incidental find while doing it: Building added a `createImageData` caller
tonight, which my CPU stub answered with `undefined` via a Proxy fallback and
failed inside `makeTrofferLens` with a stack naming Building rather than the
stub. Stub fixed. Worth knowing if another agent copies this entry — a Proxy
that returns a no-op for unknown keys turns a missing stub into a confusing
crash somewhere else.

## Not done

- B5's abrupt haze-band termination and the light top edge.
- Shrub debris skirt, pending Terrain's service.
- Shrub form variety beyond mix and stature: all sage is still one silhouette.

---

# Round 2026-08-29T002011Z-7143d072372c — B5 closed, and a legibility answer

All numbers below are from rendered pixels on the RTX 4060, verified per shot
from the live context that drew the frame. Ownership of the horizon pixels is
established by a `?vforce=noline` control captured from the **same bundle hash**
as its main round (`171145ca4b76`), with the control proved to have applied:
`force:["noline"]`, `horizonTriangles` absent from the report, and built
triangles 685,180 -> 655,484, a difference of exactly the 29,696 the bands
contribute.

## B5, part 1: "terminates abruptly mid-frame" is not in the frame

Measured, not judged. Using the ownership mask from the control, the four-band
stack occupies **1,576 of 1,600 columns**. The largest 16-column smoothed jump in
band mean luma is 26.3 at x=1361, and x=1361 is where a foreground pine crosses
the skyline — an occlusion breaking the mask, not a discontinuity in the bands.
There is no azimuthal seam and no termination.

Logging it as **not reproduced**. The critic wrote this against frames from
before the ambient correction and before the slope work, so it may well have been
real then; it is not now, and there was nothing left to fix. Recording it rather
than quietly dropping it, because the other half of the same note was a genuine
defect and it would be easy for the next reader to assume both were.

## B5, part 2: the band was flat because the slope baseline was sized in samples

The finding, and it is not a vegetation bug.

`dh` was `(h[i+1] - h[i-1]) / (2 * metresPerBandSample)` — a slope over a
baseline of **two samples**. That reads as a physical measurement and is not one:
`samples` is a rendering parameter chosen to keep the *silhouette* above the
alias threshold. The same line of code therefore meant

| band | samples | m / sample | slope baseline |
|---|---|---|---|
| r=520 | 5632 | 0.58 | **1.16 m** |
| r=780 | 3072 | 1.60 | 3.19 m |
| r=1150 | 3072 | 2.35 | 4.70 m |
| r=1800 | 3072 | 3.68 | **7.36 m** |

A factor of 6.3 in what was being measured, for identical source. This is the
same defect as the leaf cluster sized as a fraction of its plant, written up in
`NOTES.md` — a detail quantity taking its size from the thing it is attached to
instead of from the physics. **Third instance in this system.**

The consequence was directional, which is why it survived a round. A 5 m crown
feature over a 1.16 m baseline is a gradient of 4.3, which is 40x the 0.109
tangent of a 6.2 degree sun, so the term saturated. Measured with the new
`tools/_vegfacet-entry.ts`, the old version ran **66-79% of samples pinned at 0
or 1** — a two-level mask with a soft edge, not a shading term. At the near
band's 1.86 px sample pitch that is a sub-pixel dither, which resolves to flat
grey with vertical corduroy over it. The outer bands, whose accidental 7.36 m
baseline happened to land near facet scale, shaded correctly. So the band with by
far the largest area in frame was the one still reading as a cutout while the
ones behind it looked fixed.

Now measured over a baseline fixed at 46 m of hillside, converted to a sample
count per band, giving facets 149 / 95 / 68 / 41 px wide — coherent at ridge
scale, and the per-band difference is itself the depth layering the same critic
note asked for. Pinned fraction is down to 8-28%.

**A correction to my own previous report.** I claimed 4.49x sky structure from
moving the slope term into the fill. That measurement used mean absolute
per-column step, which is sensitive at a one-pixel lag, and a large part of what
it was crediting was the dither. The honest figures are in `NOTES.md` under the
multi-lag case; the fill placement was still right, and for the reason given, but
the multiple was overstated.

## B5, part 3: the white fringe was a bound, not a value

Sweeping every column and taking the sky value from the control so the comparison
is against what is actually behind the crown: **44.9% of unoccluded columns had a
crown pixel brighter than the sky above it**, mean excess 8.6 display luma, worst
23.4. A previous round had already halved the rim colour for looking too bright
and left it at 37.5% — the shape of a value being tuned when it needed a bound.

It needs a bound because it is not a preference. What reaches the eye is
`L_surface * T + L_haze * (1 - T)`, a convex combination, so it can exceed
`L_haze` only if the surface does. A conifer stand at 520-1800 m has an albedo
around 0.08 under a sun 6.2 degrees up, while the haze is integrating scattered
light along the whole path. There is no parameter setting in which exceeding the
sky is correct.

Now held under 0.97 of the local sky radiance from `hazeAt`, per azimuth, as a
**soft-knee saturation**: identity below 0.78 of the ceiling, exponential
approach above it, derivative 1 on both sides of the knee. Not `min()`, which
would build a plateau of crowns at exactly the ceiling — the defect already found
twice here, in the branch-length clamp binding 9% of silhouette-defining branches
at exactly 0.340 H and in `envelope`'s height ceiling.

**The knee was the second attempt and the first attempt is the instructive one.**
`ceil * (1 - exp(-v / ceil))` has the right asymptote but compresses from zero:
at half the ceiling it returns 79% of its input. Applied to the top vertex, which
the quad interpolates down through the entire visible band, it closed the fringe
to 0.0% and took the band stack's mean display luma from 99.6 to **89.1** and the
near band from 85.8 to 79.6. A 10-luma darkening of every band — means that
`vegHorizonBands` tunes against the sky and against each other — to correct an
overshoot averaging 8.6 on 45% of columns. The tell was that the **mean moved
when only the maximum was wrong**; that is worth keeping as a check on any
limiter.

## Measured result, four versions

| | fringe > sky | mean excess | worst | lag 1 | lag 40 | lag 120 | mean near | mean stack |
|---|---|---|---|---|---|---|---|---|
| before | 37.5% | 11.7 | 28.3 | 2.02 | 10.64 | 11.66 | 85.7 | 99.2 |
| facet slope only | 44.9% | 8.6 | 23.4 | 0.91 | 9.09 | 13.92 | 85.8 | 99.6 |
| + ceiling, no knee | 0.0% | 0.0 | 0.0 | 0.78 | 7.76 | 11.77 | 79.6 | 89.1 |
| **+ ceiling with knee** | **2.9%** | **0.4** | **0.9** | **0.91** | **9.08** | **13.91** | **85.9** | **99.0** |
| sky reference | — | — | — | 0.41 | 3.84 | 4.29 | — | 154.5 |

Fringe effectively closed: worst excess 0.9 luma, below the antialiasing noise on
that edge. Ridge-scale structure up 19% on the near band and 3.2x the sky's own
gradient. Per-column energy down 55%, which is the corduroy leaving. **Band mean
luma unchanged at 99.0 against 99.2**, so nothing downstream of the band tones
needs retuning and the environment cube's contribution from the horizon is
unmoved.

`framescan`: **0 findings**, selftest passes all four controls. Skyline
raggedness 12.89 px per-column jump, 64% of adjacent columns identical, against
the ruled-edge baseline of 0.96 px and 76%.

## Cost

Built triangles 685,180, draw calls 57 — **both unchanged**. The facet slope is a
box-blur and two array reads per sample at build time, and the sky ceiling is one
exp per crown vertex. Nothing was added to the frame.

## The legibility threshold, and it transfers cleanly

Car's two measured numbers were applied to the foliage primitive via `vegscale`,
which now reports this for any pose. The thresholds are borrowed, not invented,
which is the whole point.

| pose | cards >= 56 px | 6-56 px | < 6 px | largest card |
|---|---|---|---|---|
| wires | **0** | 12 | 170 | 44 px, sage at 4.6 m |
| approach | **0** | 4 | 196 | 8 px, sapling at 17.8 m |
| edge | **0** | 2 | 131 | 32 px, sage at 4.1 m |
| pines | **0** | 4 | 112 | 9 px, sage at 11.2 m |

**No foliage card anywhere reaches the size at which its silhouette is read
directly**, and 93% are sub-pixel. Before the absolute-sizing fix, the same sage
at 4.6 m carried cards of `2.26 * 0.42` = 0.95 m, which is **347 px** — 6.2x the
legibility threshold, unambiguously in the regime where a flat quad is inspected
as a shape. That is the "cardboard" and "flat quadrilateral patches" complaint stated in the
critic's own terms, and the fix moved it from 6.2x above the threshold to 0.8x of
it.

The consequence for whoever picks this up: **the remaining primitive-shape
complaint cannot be about card size, and must not be fixed by changing it.** Same
conclusion Car reached about its own parts, in a different regime — above the
threshold the fault is contrast or orientation, below it the shape is irrelevant.
If the crowns still read wrong, look at contrast, alpha fringing and card
orientation, and leave the dimensions alone.

## Still open

- **B8 is still flagged, and I made it worse.** The `wires` pose has a 2.26 m
  sage at 4.6 m drawing 5.84x the building's apparent height. The ratio is
  geometrically correct — a near plant does dwarf a distant building — but the
  plant was 1.92 m before my shrub-height work, and the skewed height
  distribution raised it. 2.26 m is at the extreme of real big sagebrush. Not
  touched tonight because the light has changed and I did not want to tune a
  height against a frame I had not re-read; flagging it rather than leaving it
  buried in a table.
- **Faint vertical streaks remain** in two places on the range, visible at 2x on
  the full-width strip. Not characterised. Suspect the same family as the
  corduroy, at a scale the 46 m baseline does not cover.
- **Debris skirt.** Waiting on Terrain's accumulation service; needle and leaf
  fall under crowns is my half. Nothing built, by agreement.
- **`pavementEdge(x) -> z`.** Commissioned from Terrain. The 400 mm interim
  constant stands until it lands; consuming it is a one-line change at the
  `blocked` predicate.

## Shared tooling changed

- `tools/vegscale.mjs` — added the foliage-primitive legibility report above.
  Coordinate-free; takes a pose name and no regions.
- `tools/_vegfacet-entry.ts` (new) — CPU-only, exposes the band height envelope
  so the facet slope term can be measured as a *term*. This is what separated
  "the term's authority collapsed" from "the metric was measuring noise I had
  deliberately removed", in one number, with no capture and no GPU.
- `tools/vegcpu.vite.config.mjs` — `VEGCPU_ONLY=name,name` now builds a subset.
  Not a convenience. Rolldown fails the whole build if any entry's import graph
  fails to parse, and these entries do not share a graph: `vegscale` reaches
  `BuildingSystem` and therefore every generator Building owns. At 05:35 an
  unterminated GLSL template literal, mid-edit in `buildingWeather.ts`, took
  every CPU tool offline including ones that touch none of it. **Siblings with
  multi-entry CPU builds should expect this and add the same escape hatch** — a
  tool that cannot run while a neighbour is mid-edit is a tool that cannot run
  when it is most needed.
- `tools/framescan.mjs` — comment only. The absolute-coolness clause now carries
  the test for distinguishing a percentile from a physical constant, and points
  at the `NOTES.md` case, which points back at it.

## Note for Lighting and everyone downstream

The band mean display luma is **99.0 against 99.2** before this round, so the
horizon's contribution to `scene.environment` is unchanged. Both changes this
round were deliberately mean-preserving: the facet term is symmetric about
`slopeLight = 0.5`, and the sky ceiling is identity below its knee. Nothing that
was tuned against the previous horizon needs revisiting.

---

# Round 2026-08-29T010006Z-a1314bee94aa — periodicity not reproduced, and a scene-wide winding bug

## 1. The critic's top-ranked complaint: NOT REPRODUCED, with controls

The independent pass named the far horizon as the most damaging thing in the
project, in two claims: **"repeating vertical columns"** and **"evenly scalloped
silhouette"**. Both are periodicity claims. Neither reproduces.

Four instruments, three of them controlled:

| test | result | control |
|---|---|---|
| Building's `probe-period.mjs`, whole frame, every lag both axes | no repeat above r 0.25; **max r 0.100** | selftest recovers a planted 23 px repeat at r 1.000 and reports r 0.054 on noise |
| `envelope`'s own height field, every lag, in metres, closed ring so no window bias | **max r 0.165** across all four bands | ring is closed, so every lag has the full sample count |
| band-fill autocorrelation, unbiased, every lag | **r 0.155** at the strongest candidate; r 0.024 at its first harmonic | low-pass noise with no period yields apparent peaks to **r 0.456** under the same detector |
| crown peak-pitch CV, `envelope`'s own metric | **0.683–0.752** | non-periodic profiles score **0.601–0.759** under the identical test |

The last row is the direct answer to "evenly scalloped": the crown pitch
distribution is now statistically indistinguishable from an irregular profile.
`envelope`'s comment records 0.42–0.60 when the two incommensurate crown octaves
and the 30 m domain warp were added, with a stated target of > 0.7. **That work
landed and closed the defect**; the critic's frames predate it, as they do the
flatness fix.

There is a residual autocorrelation shoulder at 10–22 px, peak r 0.347 against a
control ceiling of about 0.20, so it is real. It is a **characteristic scale, not
a period** — r at its first harmonic is 0.054, where a true period would put a
strong second peak. A characteristic crown size is correct; real conifer stands
have one. I would not act on it.

**Defensible "not reproduced" for both claims.** The atmospheric-perspective half
is Lighting's warm-haze grade and I consume its sky colour, so it will arrive
through the registry.

### What this cost me, and the correction

I did not accept `probe-period`'s answer, because its 100-row bands dilute a
48-row horizon, and I wrote my own sweep. It reported a peak at lag 293 px rising
from r 0.444 to r 0.711 with the previous round's facet-slope term — a term of
mine apparently strengthening the exact defect the critic named. **It was my
instrument, on two counts that both only inflate:** a normalisation growing as
`n/m` with lag (unbiased, the same lag is r 0.155), and a peak detector with no
null model (non-periodic noise scores up to r 0.456 under it). I spent a build
and a capture on a fix for a defect that was not there. Written up in `NOTES.md`
as *A metric with no control fabricates the finding it was built to look for*,
cross-referenced to Building's case 41 and to the single-lag case, since all
three are the same instrument blind in a different direction.

**Refuted hypothesis, logged not buried.** A single fixed differencing baseline is
genuinely a comb filter — response `2 sin(pi f B)`, maximal at period 2B — so it
was the obvious source of a repeat. Replacing the single 46 m baseline with a
weighted sum over 21 / 46 / 98 m left the peak at **exactly** lag 293 px, r 0.699
against 0.711. A different set of combs would have *moved* the peak, not merely
weakened it. Reverted to the single baseline; the reasoning is kept as a comment
in `vegDistant.ts` because the next person will have the same idea.

## 2. `sweepTube` has been wound inside out since it was written

**This is the substantive find and it is not confined to the mesh Car flagged.**

`sweepTube` in `src/gen/vegPine.ts` builds every tube in the system: pine trunks
and branches, timber fence posts, steel T-posts, utility poles, crossarms,
braces, insulators. Its wall triangles were wound inside out. Measured against
the raw builder with no transform, **24 of every 30 triangles reversed** — the
walls, with the end cap correct — in all six path directions tested.

Assembled scene, per-triangle, before and after:

| mesh | triangles | reversed before | after |
|---|---|---|---|
| `veg-fence-posts` | 1225 | 980 (80.0%) | 0 |
| `veg-poles` | 642 | 516 (80.4%) | 0 |
| `veg-pole-insulators` | 540 | 432 (80.0%) | 0 |
| `veg-fence-tposts` | 425 | 340 (80.0%) | 0 |
| `veg-pine-wood` | 68660 | 0 — see below | 0, agreement 0.913 -> 0.921 |

The fix is the index order in one loop: `(a, c, b), (b, c, d)` -> `(a, b, c), (b, d, c)`.

### Why it survived, which is the transferable part

Two independent maskings, each of which looked like a pass:

**`computeVertexNormals()` certified it.** `buildPine` calls it after assembly, so
the shading normals are derived *from* the winding. Geometry and shading then
agree, and my own scene-wide audit reported `veg-pine-wood` at **0.0% reversed**
while props from the same function reported 80% — which sent me hunting a
mirroring transform in `vegProps.ts` that does not exist. The check passed on the
wrong value: the recomputed normals pointed *into* the trunk, so every trunk and
branch was lit inside out and front-face culling drew the far wall of each tube
instead of the near one. `computeVertexNormals` cannot fail — whatever winding it
is given, it produces normals agreeing with it. Calling it converts a winding bug
into a shading bug and destroys the evidence in the same statement.

**The pixel evidence was one pixel.** Car's `probe-unseen` flagged
`veg-pole-insulators` as WINDING on the right principle, but recovered **1 px of
540 triangles**, because framed to fit a six-pole line every insulator is 5.8 cm
and sub-pixel, and `DoubleSide` roughly doubles the chance a sub-pixel fragment
survives. "0 px -> 1 px" is also what a correctly wound sub-pixel mesh looks
like, and the probe said so itself — it had to judge that mesh from six axes
because it is a closed shell with no mean normal. Discounting it was reasonable;
the gate was right and its evidence was too small to act on.

### For Car specifically

Your hypothesis — a builder whose winding depends on the direction the caller
sweeps the path — is **refuted**. It is unconditional: identical 24/30 for
vertical up, vertical down, horizontal +X, horizontal -X, and two diagonals. The
comment claiming winding was handled was simply wrong rather than
direction-dependent. Your `SEEN -> WINDING` transition was a true positive and it
found four meshes' worth of defect through one 1-pixel signal.

Your generalised assertion (mean normal positive along the outward radial) will
not catch this class, for the reason your own output flagged: these are closed
shells with no mean normal. **The assertion that does catch it needs no region,
no framing and no threshold, and is exact:** for each triangle compare the
geometric normal from the vertex order, `(b - a) x (c - a)`, against the mean of
the three shading normals the generator wrote; a sign disagreement is a reversed
triangle. It also sees inside a merge, which is the only reason this was findable
— 218 plants share one mesh here.

### Shared tooling, new

- **`auditWinding()` in `tools/_vegscale-entry.ts`** — per-triangle winding audit
  over every mesh in an assembled scene. Reports reversed count, degenerate count
  (kept separate, since a zero-area face has no winding and averaging it in
  dilutes a real failure toward the pass mark) and mean normal/winding agreement.
  CPU only, no GPU, no capture, ~7 s for 203 meshes and 643k triangles.
- **`tools/_vegwind-entry.ts`** — audits a *builder* in isolation across six path
  directions. This is the one that settled it. The scene audit gave two
  conflicting answers from one function; six direction cases against the raw
  builder gave the answer in one run.

Both are generic over `THREE.BufferGeometry` and nothing in them is
vegetation-specific. Any system with generated geometry should run them.

**Known benign result, so the tool is not misread:** `veg-thatch-sprigs` reports
4/8 reversed at agreement 0.096. That is an 8-triangle crossed-card template
whose normals are deliberately fanned outward rather than being face normals; the
low agreement is the tell. Cards are two-sided by design. Only interpret a
reversed count on meshes whose agreement is high.

### Verified in pixels

Against the bundle differing **only** in the winding (`7143d072372c` -> `a1314bee94aa`,
same `vegDistant.ts`, per the cross-bundle rule):

- whole frame **19.7% of pixels changed by >= 1 luma**, mean |dLuma| 1.016, max 183
- strongest tile a post column at x~1000, y 400–800: **-6.5 to -7.6 luma, d(R-B) -5.0 to -5.4**

The direction is right and worth stating so nobody reads the darkening as a
regression: the renderer now draws each tube's camera-facing wall instead of its
far wall, and at dawn with a low side sun a post's camera-facing side is in
shade. Previously we were being shown a sun-facing inner surface that should have
been hidden, which is why posts and trunks were too warm and too bright.

Cost: **0 triangles, 0 draw calls.** An index reorder.

## 3. Harness: a round wrote a manifest and zero PNGs, exit 0

`node tools/shoot6.mjs --shots=wires,pines,wide` produced round
`2026-08-29T005529Z-12057f01d4d7` containing **`manifest.json` and no frames**,
with a zero exit code and no error. All three pose names are valid; an immediate
re-run with the identical command wrote 3/3. So it is intermittent, not a
usage error.

This is the sibling of the 0x0 PNG that Perf is gating in `tools/archive.mjs`:
**the check did not fail, it failed to run, and the exit code cannot tell those
apart.** The 0x0 assertion should be joined by a written-count assertion — if
`written.length !== SHOTS.length`, exit non-zero. Without it a round can be
"finalised" empty, and the next agent to diff against it gets ENOENT rather than
a diff, which at least fails loudly; worse is diffing against a *stale* stable
copy in `shots/system6/`, which does not.

## 4. Still open

- **B8** (oversized foreground sage). Made worse by the absolute card sizing; not
  retuned tonight because the light has changed under it and the winding fix has
  now changed prop and trunk shading as well. Re-read the frame first.
- **Debris skirt.** Consuming Terrain's service when it publishes; needle and leaf
  fall under crowns is my half.
- **`pavementEdge(x) -> z`** from Terrain. The 400 mm interim stands.
- **Occlusion regression on `veg-scrub-grazed-far-0`** that Car reported. Not
  reached this round. Note `probe-unseen` currently classifies seven far scrub
  meshes as DEGENERATE with nothing recoverable by forcing, which wants a look
  and may be the same finding.

## 5. Notes for other owners

- **Anyone calling `computeVertexNormals()` on generated geometry** is asserting
  the winding is already correct. Audit winding first, or do not recompute. This
  is the second time tonight a check has passed by agreeing with the defect.
- **`probe-period.mjs` deserves more trust than it got from me.** It ships a
  selftest that plants a repeat and recovers it, and a noise control beside it.
  When a shared instrument and a private one disagree, the shared one has been
  controlled and the private one has not.
- Band mean luma is unchanged this round to within 0.1 luma; the horizon
  contributes nothing new to `scene.environment`. Foliage albedo untouched.

---

# Round 2026-08-29T013046Z-b17686769a67 — scene-wide winding audit, and a mat with holes in it

## 1. THE AUDIT: `tools/probe-winding.mjs`, whole scene, every system

New shared tool. Read-only, no capture, generic over `BufferGeometry`, ~30 s of
traversal after the build. It runs **in the page against the real assembled
scene** rather than on the CPU, because a CPU run would need stubs for every
system's services and stubs are how you end up auditing something other than what
ships.

**370 meshes, 1,631,778 triangles.**

| system | meshes | triangles | meshes w/ reversed | reversed tri | of those, FrontSide (actually culled) |
|---|---|---|---|---|---|
| **car** | 47 | 299,190 | **8** | **5,828** | **3,965** |
| **pumps** | 79 | 96,472 | **6** | **23** | **23** |
| vegetation | 54 | 310,308 | 1 | 4 | 0 (benign, see below) |
| terrain | 1 | 352,800 | 0 | 0 | 0 |
| building | 146 | 355,600 | 0 | 0 | 0 |
| canopy | 11 | 9,752 | 0 | 0 | 0 |
| sky | 1 | 4,992 | 0 | 0 | 0 |
| lighting | 12 | 372 | 0 | 0 | 0 |
| unattributed | 19 | 202,292 | 0 | 0 | 0 |

### Car — 8 meshes, and the tyres are the actionable one

| mesh | reversed/tri | % | agreement | side |
|---|---|---|---|---|
| `car-tyre-0` | 960/8160 | 11.8 | 0.918 | **front** |
| `car-tyre-1` | 960/8160 | 11.8 | 0.918 | **front** |
| `car-tyre-2` | 960/8160 | 11.8 | 0.918 | **front** |
| `car-tyre-3` | 960/8160 | 11.8 | 0.918 | **front** |
| `car-body` | 125/142012 | 0.1 | 0.996 | **front** |
| `car-inner-skin` | 3229/52036 | 6.2 | 0.952 | double |
| `car-headliner` | 320/11350 | 2.8 | 0.977 | double |
| `car-glass` | 29/9132 | 0.3 | 0.999 | double |
| `car-slots` | 5/3592 | 0.1 | 0.636 | double |

**3,840 triangles are being culled on the four tyres and 125 on the body.** All
four tyres reporting the identical 960/8160 at identical agreement is a builder
contract error, not an accident of geometry — one wrong loop reproduced four
times. High agreement (0.918) means the normals are face-derived, so the count
means what it says.

The DoubleSide four are masked today and are only a latent hazard: they will
appear the moment anyone sets `side` correctly for a performance pass, which is
a change that looks free and is not. `car-slots` at agreement 0.636 is
ambiguous and may be intentional.

### Pumps — 6 hose meshes, 23 triangles, all FrontSide

`pump-{1,2,3}:hose:{north,south}`, 2 to 5 triangles each out of 3,360, agreement
0.993. Tiny, but FrontSide, so they are holes in a hose.

**The shape is the diagnosis.** A builder-wide contract error gives 80% (mine
did). A handful of triangles in the same place in every instance says "something
specific about a few stations on a curved path". My first hypothesis was the
reference-axis switch — `sweepTube` picks `|tangent.y| > 0.94 ? X : UP` per
station, and a hose is exactly the geometry that hangs through vertical, so a
path crossing that threshold mid-sweep gets an abruptly rotated frame.
**Tested and refuted:** arcs through vertical at 8 and 24 stations, a full loop
crossing twice, and a boot-to-ground hose profile all come out 0/N. The switch
rotates the frame about the tangent and preserves handedness.

So it is not that. The remaining candidate, offered as a hypothesis and not a
finding: a swept path with a **reversal** in it — two consecutive stations whose
tangents oppose, which a tight hose kink can produce — inverts one ring of
quads. Pumps owns the check; `tools/_vegwind-entry.ts` shows the pattern for
auditing a builder in isolation across path shapes, which is what settled mine.

### Vegetation — clean, with one intentional exception

`veg-thatch-sprigs`, 4 of 8 triangles, **agreement 0.096**. That is an
8-triangle crossed-card template whose normals are deliberately fanned outward
rather than face-derived; the low agreement is the tell, and cards are two-sided
by design. Correct as it is.

### How to read the output, which matters more than the numbers

**Read `agreement` before believing a `reversed` count.** It is the mean |cos|
between each face normal and its own vertices' mean normal. Above ~0.7 the
normals are face-derived and a reversed count is a defect. Below ~0.3 the normals
are fanned or splayed — crossed cards, fake-volume tricks — and two-sidedness is
intentional. `side` tells you whether the renderer is hiding it right now:
FrontSide means those triangles are being culled today.

Not fixed for anyone else, per Car's rule that compensations at call sites become
indistinguishable from intent. Reported for routing.

## 2. My own: `veg-ground-mat` had 92 culled triangles

Found by my own tool on its first run, which is the argument for running it
everywhere.

`buildMatSheet` jitters every vertex by up to +/-0.4 of the pitch in both axes
and then triangulates using the original grid indices. After that jitter the
indices sometimes imply the wrong rotational order, the `normal` attribute always
points up, and `matSheetMaterial` is FrontSide — so 92 of 22,882 triangles were
culled. **A hole in the mat, not a visible error**, at 0.4%: small enough never to
be noticed, exactly the wrong size to look for.

Fixed by choosing the winding per triangle at build time. Verified: **92 -> 0.**
Cost 0 triangles, 0 draw calls; two subtractions and a cross product per triangle
at build time.

**Worth one paragraph because the first attempt was subtly wrong.** Testing the
geometric normal against **+Y** — the obvious criterion for a horizontal sheet —
left **1 triangle of 22,882**. The mat's shading normals are deliberately tilted
up to 30 degrees off vertical, so on a sliver whose geometric normal is nearly
horizontal, "faces up" and "agrees with its own normals" are different questions,
and back-face culling only asks the second. Testing against the triangle's own
mean shading normal is the same cost and is exact by construction. **When a check
leaves a small residue, suspect the check and the thing it protects are asking
slightly different questions** — the residue was the signal, and a tolerance
would have buried it.

## 3. Canopy's deck rect: consumed

`canopy.deck` read from the service and added to the plant exclusion, expanded by
**1.2 m**. That expansion is a *drip line* allowance, not a trunk radius,
deliberately — the complaint is about what a crown hides, and a crown overhangs
its trunk. Confirmed live in the round report as
`canopyDeck: [-6.6, 6.6, 13.1, 26.7]`.

Read with `tryGet`, not a throw, because the CPU-only analysis entries stand up
Building but not Canopy and a throw would take them offline for a cosmetic
exclusion. It is reported either way (`canopyDeck: null` on the CPU path) so
absence is visible rather than silently reverting to the old planting — this
project's dominant defect class is a service published and never consumed.

## 4. B8 re-read: it is a distance problem, not a scale problem

Re-measured under the corrected light with `tools/vegscale.mjs wires`. The plant
is a **2.26 m sage at 4.6 m** from the lens, drawing 913 px, 101% of frame height,
**5.83x** the building's apparent height. It grew from 1.92 m, which is my shrub
variety work widening the sage range, so I did make it worse.

But the arithmetic closes the question: 2.26 m at 4.6 m subtends 0.491 rad; a
4.6 m building at 52.4 m subtends 0.0878 rad. The ratio **must** be about 5.6x.
There is no size for this plant that fixes the frame while it stands 4.6 m from
the camera, and 2.26 m is entirely plausible for big sagebrush.

So the critic observed correctly — it is enormous in frame — and diagnosed
incorrectly: scale is not implausible, *composition* is. The defect is that a
2.26 m plant stands 4.6 m in front of a camera whose subject is 52 m away.

**Not fixed tonight, deliberately.** The fix I would make is to taper edge-anchor
heights near the trafficked ground the way open-ground sites already taper from
the forecourt — physically motivated, since people and vehicles clear vegetation
where they walk, rather than fitted to a pose. But making that change after this
round's capture would invalidate the capture that verifies the winding, mat and
canopy work, and an unverified change is not a fix. It is the first thing to do
next round.

Also from `vegscale`: still **0 plants with foliage cards at or above 56 px**,
largest card 44 px, 170 of 182 plants sub-pixel. The "cardboard" complaint is
still not about card size.

## 5. HARNESS: `shoot6` wrote 2 of 7 frames and exited 0

Stronger than my earlier report, because this time the cause is in the log:
`net::ERR_HTTP_RESPONSE_CODE_FAILURE` on the third navigation — the preview server
stopped answering mid-round — and the harness treats a failed navigation as a
reason to **stop the loop** rather than to fail the run. It then finalised the
round, pruned old rounds, and printed its normal closing lines. Exit 0.

The earlier zero-PNG round is the same fault, not an unexplained flake.

Two consequences worth Perf's attention:

 - **The stable copies in `shots/system6/*.png` are now a mixture of two
   bundles**, since frames are copied as they are written. Anything reading the
   stable paths gets a frame set that never existed as one render of one build —
   the cross-bundle trap through the front door, with no hash mismatch to notice
   because each file is individually consistent.
 - A partial round is indistinguishable from a complete one in `$?`.

The assertion wanted is not about image contents, which the 0x0 check covers:
`written.length === requested.length, else exit non-zero`.

## 6. Verified this round

`framescan` on the frames that landed: **0 findings across 2 frames.** Raggedness
well clear of the 0.96 px / 76% baseline — `approach` 0.68 px with 73% of adjacent
columns on the same row, `edge` 2.48 px with 53%.

Cost: **686,636 built triangles at 57 draw calls**, against 694,180 at 56 last
round. The +1 draw call is the ground mat sheet becoming non-empty (the CPU-stub
path culls it, the real `groundSoil` does not); triangles down 7,544.

## 7. Still open, in order

1. **B8 composition** — taper edge-anchor heights near trafficked ground. Reasoned
   above, unverified, first thing next round.
2. **`veg-scrub-grazed-far-0` occlusion, and the seven DEGENERATE far-scrub
   meshes.** One cause is cheaper than eight symptoms and I did not get to it. The
   hypothesis worth testing first: all seven are alpha-tested **card** geometry
   (pine foliage, dead foliage, five far scrub), and `veg-pine-foliage` at 48,270
   triangles is among them while demonstrably rendering in every capture. A flat
   card can be exactly edge-on from a bounds-derived viewing axis, and a mesh of
   cards has no mean normal to derive one from — the same undefined-mean trap
   Canopy and Pumps hit. If so it is one probe artefact, not eight geometry
   defects, and it needs Car's tool rather than mine.
3. **Terrain's debris service** when it publishes.
4. **`pavementEdge(x) -> z`** from Terrain; the 400 mm interim stands.

## 8. Terrain's `vegMat.ts` note: acknowledged, agreed, not acted on

Correct on both counts. The three call sites feeding continuous world coordinates
to a bare `fract`-style hash for per-vertex lift, angle and thickness are right
for what they want — a per-vertex value with no spatial correlation, which is
what thatch stems have — and they are not extensible: the hash has no notion of
wavelength, so anyone adding a long-wavelength trend to mat thickness will change
the multiplier and see nothing, because changing the multiplier of a hash
reshuffles rather than rescales.

Not changed tonight because it is a latent ergonomics problem rather than a defect
and this round already has three verified changes in it. The shape of the fix,
for whoever hits it: the trend and the per-vertex hash are different terms and
want separate sources — a smooth field sampled in metres, plus the hash as
uncorrelated jitter on top. Written here so the next person meets the warning
before they change the multiplier.

## 9. Capture addendum — the seven poses span TWO bundles, and three findings are open

The round above died at 2 of 7. The remaining five were captured as round
`2026-08-29T013651Z-08962c6f0891`, and **that is a different bundle**
(`b17686769a67` for `approach` and `edge`, `08962c6f0891` for the other five) even
though I changed no source between them. Car, Pumps and Canopy landed seven files
in the six minutes in between: `carParts.ts`, `hardsurface.ts`, `pumpParts.ts`,
`textures.ts`, `CanopySystem.ts`, `CarSystem.ts`, `PumpSystem.ts`.

So this is not a seven-pose round and must not be read as one. It is the
cross-bundle trap arriving without anybody making a mistake — a harness failure
forced a split, and five concurrent editors guaranteed the halves would differ.
**The mitigation that would have caught it is already in the harness and worked:
`shoot6` prints the bundle hash on every line.** Read it.

### framescan: 0 findings on the two, 3 on the five

| pose | finding |
|---|---|
| `approach`, `edge` | none |
| `wide`, `horizon`, `wires` | none |
| `pines` | PALE BAND rows 502..513, chroma 10.1 against 18.6 above and 30.6 below |
| `sunlit` | BAND BRIGHTER THAN SKY rows 316..330, 166 against 144; PALE BAND rows 572..619, chroma 20.0 against 34.3 / 29.6 |

`pines` rows 502-513 sit well below that frame's skyline (modal row 260), so that
one is ground, not horizon band — and the ground mat became non-empty this round,
which makes it a suspect worth checking before anything else.

**`sunlit` is the first scan of that pose since the B5 work**, and I could not
settle it honestly, so it is open rather than answered:

 - My first explanation was that framescan compares the band against sky 20 rows
   higher and the dawn sky has a steep vertical gradient. **Measured and wrong:**
   the gradient is 3.7 luma over 90 rows. framescan is not measuring that.
 - I then wrote a per-column check against the sky *immediately* behind the band.
   It reported 34.9% of columns brighter with a median excess of 50 luma, which is
   not credible next to `wide` measuring 0% after the same `holdUnderSky` bound.
   In a sun-facing pose my skyline finder is probably latching onto sunlit near
   objects rather than the horizon.

I am not asserting either. **This round's own lesson is that a hand-rolled
detector produced a confident number and was wrong, and it applies to the second
detector as much as the first.** What this needs is a control: run the check on
`wide`, where the answer is independently known to be 0%, and see whether the
detector reproduces it. If it does not, the detector is the fault. That is one
run and it is the first thing to do on this item.

### Teardown

`tsc --noEmit` clean. `tools/archive.mjs --scan` reports every capture a readable
image of plausible size across 173 files. No LISTENING socket on 5119, no
Chromium holding it, `.shot-build/winding` removed.


---

# Round: detector control, B8 composition, scrub DEGENERATE, groundAccum

## Retracted: the "BAND BRIGHTER THAN SKY" findings

**`sunlit` and `wires` are withdrawn entirely. `pines` and `horizon` are withdrawn
as vegetation findings.** The detector was run first on `wide`, whose answer was
independently known to be ~0%, and read 0.0% of 1538 columns. It passed, and the
difference against the other frames turned out to be its own construction:

- It accepted the first luma drop anywhere in a 180-row window, so low-eye poses
  latched onto near-field objects rather than the horizon.
- It defined the drop against a reference 60 rows higher and compared against sky
  6 rows above the drop, so a **one-row** dark feature satisfies "brighter below
  than above" by construction. Fixing this alone took `sunlit` from 418
  qualifying columns to 58 and its median excess from 41.8 to **1.3 luma**.
  `wires` reads 1.0 luma excess: sub-perceptual.
- The `pines` residue survived two controls, `vforce=noline` and then
  `+noscrub`, moving 0.2 percentage points. Colour classification of the
  offending pixels gave **rgb 115,115,133 — blue-dominant and desaturated, i.e.
  sky**. The vertical profile at a flagged column runs 115 -> 25 -> 121 -> 42 ->
  162: gaps between pine branches. A dappled crown makes every column oscillate.

**Nothing to fix, and no threshold repairs this.** A pixel metric cannot answer a
band question without knowing which mesh painted the pixel. Same wall that made
pixel evidence unusable for the `sweepTube` winding bug, reached from the other
side. See NOTES.md case 44.

## For Terrain: a desaturated band on the ground in `pines`, not mine

Separate from the above, and this one is real. The framescan's "PALE BAND" at
rows 502-513 of `pines.png` is **pale in chroma, not in luma**, and my ground mat
is not the cause.

| rows | live | with all my scrub off |
|---|---|---|
| 506-514 | L 86, rgb 91,85,85 (R-B = **6**) | L 129, rgb 137,127,123 (R-B = **14**) |
| 518-524 | L 95, rgb 115,91,80 (R-B = **35**) | L 99, rgb 120,95,83 (R-B = **37**) |

A near-neutral band sits on warm ground with a boundary around row 516, **in both
arms**, so removing every clump and the whole distant landscape does not touch it.
My mat's three albedo tones are THATCH (0.108, 0.092, 0.055), SILT (0.078, 0.070,
0.058) and SWARD (green) — all warm or green, none neutral, so the grey is not my
albedo. Desaturation with a hard boundary is the signature of an aerial
perspective or haze term with a cut in it, which matches your own warning that
two `groundAccum` fields are bimodal and read as hard cuts with a fringe.
Reproduce with `node tools/shoot6.mjs --shots=pines --query=vforce=noline,noscrub`.

## B8: refused again, and now for a second independent reason

Measured, not argued. The plant is a **2.26 m sage at (-18.9, -13.9)**, 4.6 m from
the `wires` camera, centre at screen (93, 248), drawing 913 px in a 900 px frame.

- **Not scale.** 0.491 rad against the building's 0.0878 rad at 52.4 m forces a
  5.6x ratio. No size change fixes the frame.
- **Not the primitive.** Largest card on it is 44 px, below Car's 56 px
  "inspected as a shape" threshold.
- **Not planting.** The road is paved to |z| = 5.16, so this plant stands
  **8.74 m clear of the pavement** on the opposite verge. That is open desert.
  No setback rule is violated and 2.26 m is within big sagebrush range.
- **It is the pose.** At fov 30 and 4.6 m the frame is only **2.47 m tall**. Any
  lawful shrub on that verge fills it. The `wires` camera stands in the middle
  of a vegetation band.

**Routed to whoever owns the shot list**, with the general rule: a camera at
range d and field of view f sees 2*d*tan(f/2) metres of height, and the planting
rules legitimately grow 2.26 m shrubs anywhere on the verge. Either the pose
moves back or the foreground occluder is intentional. Nothing in Vegetation
changes. Third time this round that a correct observation carried an incorrect
named cause.

## `veg-scrub-grazed-far-0` and the DEGENERATE far scrub: one cause, and it is the tool

It was one cause rather than eight symptoms, as suspected — but not in my
geometry, and the count in my own handover was wrong twice.

- **Eleven, not seven**, and **three are `near` meshes** (`sprawl-near-2`,
  `seed-near-2`, `tuft-near-3`), which refutes the far-LOD reading the count
  suggested.
- A CPU audit of all 42 clump geometries, both LODs, came back **clean**: zero
  no-area, zero null-normal, zero reversed, minimum triangle area 1.1e-2 against
  a 1e-12 threshold. Kept as `tools/_vegclump-entry.ts`.
- The word `DEGENERATE` means different things in two tools. The finding came from
  `probe-unseen` — a mesh that rendered zero pixels in an isolation render — and
  I tested it against the winding audit's meaning.

**For whoever owns `probe-unseen`:** `aim()` frames the mesh's bounding sphere.
For an `InstancedMesh` scattered over a 100 m annulus that sphere describes the
scatter, not the plant, so every instance lands sub-pixel and alphaTest discards
it. Forcing side, depth and frustum cannot recover a scale problem, which is
exactly the reported verdict; the three that did recover came back at 2 px and
13 px. **Aim at one instance, not the mesh bound.** This affects every system that
scatters instances, so it is a shared-tool fix. `probe-unseen` already documents
this as a limit of the method at its line 659 — the limit is now measured.

## Consumed: Terrain's `groundAccum`, probed at my own geometry first

New tool `tools/vegaccum.mjs`. Samples the five fields at the 228 real plant
sites **and at a matched 1 m grid over the same bounding box**.

| field | shape | published p50 | at my sites | matched grid | ratio |
|---|---|---|---|---|---|
| shelter | bimodal | 0.026 | 0.115 | 0.021 | **4.42x** |
| swept | bimodal | 0.004 | 0.012 | 0.004 | **3.02x** |
| fines | unimodal | 0.147 | 0.122 | 0.147 | 0.83x |
| litter | skewed | 0.000 | 0.000 | 0.000 | - |
| grime | skewed | 0.000 | 0.000 | 0.000 | - |

**Thank you for the grid arm being possible.** It reproduces your published p50
for four of five fields, which proves the 4.42x is selection bias in where my
geometry sits — planting rules prefer sheltered ground — and not error in how I
sampled. A debris skirt scattered off the published median would have
under-scattered under crowns by 4.4x, in the one place it is meant to be
heaviest.

Your two shape warnings both apply directly to the debris skirt and both would
have bitten:

- `litter` is **items per m2**, and a needle skirt works at ~0.2 m cells, which is
  precisely the 25x over-scatter you called out.
- `shelter` and `swept` are bimodal at my sites too: 49%/16% and 61%/20% of
  samples in the outer tenth. Masks with soft edges, not ramps.

**Debris skirt itself is not built this round.** The contract is probed and the
numbers are banked; the geometry is next.

## Controls, and one that failed to prove itself

`report.force` echoes the parsed flags back out of the running scene and unknown
tokens throw, so `vforce` controls can be verified rather than trusted. The
`noline` arm printed `"force":["noline"]` and is sound.

**The `noscrub` arm did not prove it applied** — I piped shoot6 through `tail` and
cut the echo off. Its conclusion is corroborated by the teardown line
(`__VEGETATION.clumps is undefined`) and by being bit-identical to the `noline`
arm, but it is not proven and is labelled as such above. Do not pipe away the
line that carries the proof.

Also note for anyone building a CPU probe: `BuildingSystem.init` reads
`location.search` and **throws** in Node. That is better than the failure mode
described in Terrain's forced-off arm, where reading only `location.search`
silently no-oped every command-line token, but it means every CPU entry that
reaches Building needs the browser-global shim. `tools/vegaccum.mjs` carries a
copy of `vegscale.mjs`'s.

## Harness, for Perf

Second reproduction tonight, and this one is cleaner than the first. Round
`2026-08-29T014903Z-bbf622b07541` requested 3 frames, wrote **0**, and exited **0**.
Its manifest already contains everything needed:

```
"outcome": "failed",
"failure": "page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE ..."
```

**The harness already knows it failed. Only the exit code lies.** `written.length
=== requested.length` remains the assertion, and `outcome === "failed"` should be
enough on its own.

---

# Round: debris skirt built, probe-unseen instanced aim fixed

## For Car and Building: `probe-unseen` was wrong about instanced meshes, and you both gate on it

**Re-run your gates.** Every `DEGENERATE` this tool reported on an `InstancedMesh`
before 2026-08-29 is suspect.

`aim()` framed `o.geometry.boundingSphere` under `o.matrixWorld` and never applied
`instanceMatrix`. For an instanced mesh that is one copy's sphere at the geometry's
local origin, so the camera was aimed at empty ground near the group origin.
Nothing was in frame, which is why forcing `side`, `depthTest` and `frustumCulled`
recovered nothing and the verdict came out "nothing forced brings it back".

Measured before and after, on Vegetation's 42 scrub meshes:

| | silent meshes | verdicts |
|---|---|---|
| before | 14 of 42 | 11 DEGENERATE, 3 "OCCLUDED" recovering at 2-13 px |
| after | **0 of 42** | all SEEN, no winding failures |

Determinism control passed both times at 0 differing pixels.

**What changed in the tool:** it now aims at up to `INSTANCE_SPOTS` (6) real
instances, strided across `o.count` rather than taking the first few, and **each
spot carries its own view direction** derived from its own normal matrix. That last
part matters — sharing one direction would aim at the back of a rotated instance
and report WINDING, and a false WINDING is worse than the false DEGENERATE it
replaces because WINDING is the verdict that fails the run. Verified: no winding
failures appeared. Reports on instanced meshes now carry `spots` and `spot`, so a
verdict can be read against how many instances were actually aimed at.

**Two recognition rules for old reports.** A `DEGENERATE` on anything instanced,
and a "recovered" count of a handful of pixels — that is an instance clipping the
corner of frame by luck, not a recovery. The fix is announced in the file header
with the date, not only here.

How it was caught: the tool accused eleven of my clump meshes, so I audited all 42
clump geometries on the CPU (`tools/_vegclump-entry.ts`) — zero no-area, zero
null-normal, zero reversed, minimum triangle area 1.1e-2 against a 1e-12
threshold. The geometry was sound and the probe was not. NOTES.md case 54.

## Debris skirt: built, composed against site-conditional values, bounded

Needle and leaf fall under crowns, which is my half.

**Composed against my own measurements, not the published medians.** `shelter` at
my 228 plant sites has p50 0.115 against Terrain's published 0.026, and `swept`
0.012 against 0.004. The matched 1 m grid arm reproduces the published figures,
which is what makes that selection bias rather than sampling error. Scaling off
the published median would have made the skirt 4.4x too light directly under the
crowns.

**Both shape warnings respected.**

- `shelter` and `swept` are bimodal, so they are used as masks through a
  smoothstep, never as gradients. The result is **bounded by construction**:
  shelter contributes [0.78, 1.30], traffic [0.30, 1.00], so the product is inside
  [0.23, 1.30]. Measured at the real sites: min 0.234, p50 0.780, max 1.300,
  **0 samples outside the declared bound**, spread 1.066. Checked by
  `tools/vegaccum.mjs`, which fails if the bound is violated — a declared bound
  that is wrong is worse than no bound.
- `litter` is **deliberately unconsumed**. It is items per m², Terrain renders its
  own items from it, and a needle skirt works at ~0.2 m cells where treating it as
  a probability over-scatters 25x. Consuming it would also have stacked my leaf
  fall on top of Terrain's paper.

**A hardcoded number replaced by your published one.** The downwind pile offset was
a literal bearing of 2.9 rad. It now uses `groundAccum.wind` and scales the offset
by `wind.strength`, so a still site does not get a displaced pile it has no
mechanism for.

**Cost, and a threshold that will not rot.** 97 of the 218 mid-storey crowns get a
litter disc, for +5,180 triangles (ground mats 832 to 929, 38,770 to 43,950
triangles). The height floor is *derived*, not tuned: a litter disc has radius
`max(0.34, h*0.3) * [1.05, 1.5]` and the mid-storey contact patch already at the
same spot has radius `MID_CONTACT_RADIUS_M` = 0.42, so below
`h = 0.42/(0.3*1.05) = 1.33 m` the litter disc is entirely inside a darker patch
that is already drawn — 48 triangles that change no pixel. Both numbers are now one
named constant and one expression, so the floor moves if either does. This file's
own history has the opposite case, where a 0.44 m clump threshold written in
absolute units but chosen as a percentile silently went from selecting a third of
the clumps to nearly all of them.

## For Terrain: `vegetationDebris`, so you can subtract mine

You are raising near-field debris density on the same ground from the geometry
side. Between us the near field is one surface, and **we are both keyed off
`shelter`** — so independent scatters do not average out, they both go heavy in the
same places. Double coverage under every crown, bare ground where neither rule
fires, and the clumping is systematic rather than random.

Published after the skirt is built, so what is advertised is what was drawn:

- `coverAt(x, z) -> 0..1`, opacity-weighted. A function rather than a constant for
  the reason you gave with `pavementEdge`: it reads the same post-cull disc set
  handed to the mesh builder, with the same radial falloff the discs fade their
  alpha by, so agreement is exact by construction and "covered" means what a
  viewer sees rather than a bounding circle.
- `discs` — the drawn set, if you would rather do your own maths. Mats past the
  ~70 m cull are excluded: subtracting for geometry that was never drawn would
  leave a hole exactly where nothing existed.
- `range` — units, min/max, neutral, `safeAsMultiplier`, a shape word, and the
  distribution **at my plant sites** rather than on a uniform grid, since that is
  the form of your contract that was actually useful to me.

Echoed into the report as `debrisCover` so you can check from a capture that the
service has real discs behind it: `{"discs":929,"p50":0.355,"p95":0.652,"max":1}`.
A published function backed by an empty list reads identically to a working one
until somebody renders the difference.

**Suggested split, yours to accept or refuse:** gate your near-field scatter on
`1 - coverAt(x, z)` so your density rises where my duff is thin. I have not
changed my own density to compensate, because whichever of us compensates second
would be reacting to a number the other is still moving.

## Controls, and both proved they applied

Both services are proven end-to-end in the real assembled scene, not inferred:

- `debrisAccum` `{"samples":117,"min":0.234,"p50":0.78,"max":1.3,"bound":[0.23,1.3]}`
  — non-null means `tryGet("groundAccum")` found Terrain's service, and the
  figures match `tools/vegaccum.mjs` on the CPU exactly. 117 = 20 pine duff mats
  plus 97 crown litter discs.
- `debrisCover` as above, 929 discs.
- 0 systems failed in init.

Practices held this round: no harness output read through a pipe — I made that
mistake once on the probe run, killed it and re-ran to a file in `tmp/`, because a
pipeline reports the last stage's status and swallows the line that carries the
proof. All scratch in `tmp/`.

One warning for anyone editing `tools/probe-unseen.mjs`: half of it is a template
literal injected into the page, so backtick-quoting an identifier in a comment
there terminates the string and yields a `SyntaxError` pointing at a comment line.
`node --check` catches it in a second; the five-minute build does not. NOTES.md
case 49.

## Addendum: the skirt in pixels, and a substitution control that changed my mind

Everything above this heading was verified on the CPU. This is the pixel arm, and
it moved one conclusion.

Measured against a `?vforce=nolitter` frame from the same bundle, the shipping
scatter is **294 changed px in `edge` and 546 in `pines`**, out of 1.44 Mpx. That
is 0.02–0.04% of the frame. My first reaction was that the scatter had not been
placed — 13 240 items and 26 480 triangles ought to be more than a rounding error
— so before tuning anything I added `?vlitter=` to `buildLitterMesh`, which scales
item size and **nothing** else: not the count, not the placement, not the colour.
A knob that also moved the count would have answered neither question.

At `?vlitter=6` the same scatter moves **975 px in `edge` and 528 in `pines`**,
inside the same bounding box, with the same row distribution. Scaling item size 6×
scales projected area ~36×, and edge went 294 → 975. So the items are exactly
where they are supposed to be and there are exactly as many as reported. **The
scatter is sub-pixel, not absent.** Those two look identical in a screenshot and I
would have "fixed" the wrong one: my next move without the control would have been
to raise `itemsPerSquareMetre`, which was already correct, and I would have paid
for it in triangles and got the same invisible frame.

That is worth stating as a general shape, because it is not specific to litter: an
instanced scatter of *physically-sized* objects at mid distance is a texture tint,
not a set of objects. Items are 45–105 mm long; at 8–15 m in a 1600 px 44° frame a
pixel subtends roughly 5–15 mm, so each item is a few pixels long and under one
pixel wide, and alpha-averages into the ground. Growing the geometry to make it
"read" would be making it physically wrong to satisfy a screenshot. I did not do
it, and `?vlitter=` is a diagnostic, not a feature knob — it echoes as
`debrisScatter.sizeScale` so a capture taken under it cannot be mistaken for a
shipping frame.

### The real gap, which is a placement finding and belongs to Terrain

The changed pixels in `edge` are confined to rows 3–4 of 8 (y 386–555 of 900) and
in `pines` to rows 4–5. **Rows 6–7 — the near foreground, the ground within a
couple of metres of the camera — do not change at all in either pose.** That is
not sub-pixel; at that distance an item would be tens of pixels. It is that litter
only exists under crowns, and neither camera stands under one. None of the eight
poses in `tools/vegposes.mjs` does.

So the coverage split with Terrain lands cleanly and I am not double-covering:
**mine is the mid-distance band under and around the 228 plant sites, and the near
field is empty and is yours.** If Terrain's near-field debris pass lands, the two
should meet without overlapping, because mine is bounded by `underCrown` and stops
where crowns stop. Worth one joint frame to confirm the seam once both are in.

### `probe-unseen`: the instanced arms pass, and the full scene is clean

`--selftest` now plants seven arms and all seven reproduce their planted verdict,
including the two new instanced ones (`__unseen_selftest_scattered` → SEEN,
`__unseen_selftest_scattered_backwards` → WINDING). Full scene, 374 meshes: 321
draw pixels from their own view, 53 OCCLUDED, **0 DEGENERATE, 0 WINDING**. Every
one of the 53 is building or car interior geometry behind glass — the expected
kind. No vegetation mesh is accused.

Before the aim fix, eleven sound vegetation meshes reported DEGENERATE. **If you
gate on this tool, any DEGENERATE verdict against an `InstancedMesh` recorded
before 2026-08-29 is void and needs re-reading** — the camera was framing the
geometry's local bounding sphere, which for a scatter describes the empty space at
the group origin rather than any instance. Single-mesh verdicts are unaffected.

### Ports and teardown

Ran on 5119 (`shoot6`) and 5147 (`probe-unseen`); 5147 because another agent holds
5116, which is `probe-unseen`'s default — worth knowing if you get a bind failure.
Both confirmed to have no listener at exit. One orphaned `shoot6` from an earlier
hung run was holding 5119 and had to be killed by PID; if a build fails to bind,
check for a stale harness before assuming the port is someone else's.

# Round: the crown pose, and what it found in the first frame

## `underpine`: a new pose, and it was worth the whole round

Added `underpine` to `tools/vegposes.mjs` as a new entry, nothing shared edited:
eye height 1.6 m inside the west pine grove, aimed at ground 1.4 m from the
centre of the 9.8 m pine at (-38.5, 19.5), inside its litter radius, camera 3.9 m
off the trunk so the frame is ground rather than bark. Cross-lit at 6.2 degrees,
because flat scatter and scatter with relief separate under raking light and are
hard to tell apart under either of the other two.

Aimed at published geometry rather than a guess: `debrisScatter.widestCrowns` now
lists the five widest crown discs with positions, added for exactly this purpose.
A pose aimed at a coordinate that happens to miss looks identical to a skirt that
was never built, and I was not willing to add a ninth pose that could lie.

The skirt moves **9167 px** here against a `nolitter` control from the same
bundle, versus 294 in `edge` and 546 in `pines` — 31x — and reaches row 7, the
ground at the lens. Both arms echoed their state (`sizeScale:1` / `force:[]` and
`built:false, why:"vforce disabled the scatter"` / `force:["nolitter"]`).

**The litter itself reads acceptably and the frame contains two defects it did not
put there.** Judged as a photograph, the skirt is fine: a fine dark speckle that
concentrates under the crown and thins outward. Its albedo was too low — at 0.105
against a sand near 0.4, items standing proud in crown shade came out as black
hard-edged shards, reading as holes rather than litter, and it is now 0.145 for
needle and 0.265 for leaf, still well under the sand.

## The white sparklers are the thatch sprigs, and this is the headline

The first `underpine` frame has roughly fifteen **blown-out white star-bursts
scattered across the near foreground**, at ankle height, in crown shade. In a
photorealism project they read as bits of white plastic and they are the single
worst thing in the frame — far worse than anything about the litter.

Attribution proven, not assumed: they are absent under `?vforce=nosprig` with
`force:["nosprig"]` echoed, and my litter flakes remain in that same frame. They
are `veg-thatch-sprigs`, mine.

Two real defects found, one fixed:

- **`DRY` was `Color(1.05, 0.98, 0.78)` — a reflectance above 1.0.** It reaches
  the shader as `instanceColor` and multiplies diffuse, so it is an albedo and
  nothing renormalises it. Now (0.44, 0.38, 0.24), a real cured-grass figure,
  with `GREEN` brought to (0.26, 0.36, 0.18) likewise.
- **`strength: 6.8` and `fill: 1.8` were tuned on the pines and reused here.**
  The shader multiplies the transmitted term by diffuse albedo, and the pines'
  diffuse comes from a needle texture near 0.1, so the quantity actually tuned
  was the product `strength * albedo`, about 0.7. Holding that product at the
  sprigs' real albedo gives 1.6, and fill scales the same way to 0.45. Measured
  effect, isolated: 2562 px, all darker, all ground rows, no crowns.

**Still open, with the suspect named.** Neither fix clears the white cores. `fill`
is deliberately not shadow-multiplied and it multiplies `uSunCol`, which is
scene-referred sun radiance and well above 1 at dawn — so a sprig in full crown
shade still receives `albedo * fill * uSunCol`, which clips on its own. That is
precisely what the frame shows: the cores blow out *in shade*, where every
shadowed term should be weakest. Bound the fill term against the sun radiance it
is expressed as a fraction of. Do not lower it by feel.

## RETRACTED: the transmission uniform leak, and how it nearly shipped

I wrote a long note in `src/gen/vegTransmission.ts` asserting that the constant
`customProgramCacheKey` leaks uniforms between foliage call sites, on this
evidence: editing only the sprig call site changed 306622 px, 21% of the frame,
including the pine crowns and the sky. Nothing in that call site can reach a pine,
so it looked conclusive — and I had already reverted a correct fix on the strength
of it.

**It is false.** Another agent committed to `src/systems/LightingSystem.ts`
between my two captures, at 09:49 against builds at 09:44 and 09:50. The diff was
measuring their lighting change and attributing it to my edit. Isolating to two of
my own rounds that straddle only my edit gives 2562 px, ground only. The retracted
note is left in place as a retraction.

The transferable hazard, and it is a sharp one in a tree several agents are
editing: **a cross-round pixel diff attributes every concurrent edit to the last
thing you touched, and it is most convincing exactly when the frame moves in a way
your change could not possibly have caused.** That impossibility is the tell, and
I read it backwards. Before believing a whole-frame move, check the mtimes of
files you do not own. `find src -name "*.ts" -newermt <time>` takes a second and
would have saved this round a wrong bug report and a wrong revert.

## Void verdicts: my own backlog was the tool, and it is now clear

`probe-unseen --verbose`, full scene: **`veg-scrub-grazed-far-0` is SEEN at 1925
px**, and all 42 `veg-scrub-*` meshes are SEEN. The eight DEGENERATE far-scrub
verdicts on my list were the instanced-aim bug and nothing else. No geometry work
is needed and that round is cancelled.

## For Car: an unstable mesh at the 0-px boundary

Two consecutive full-scene `probe-unseen` runs on the same bundle disagree by one
mesh: `car-system/car-contact-shadow` is OCCLUDED in one and SEEN in the other,
while the tool's own determinism control reports 0 differing pixels across four
re-rendered views. So it is genuinely marginal rather than noisy measurement. Any
gate keyed on the exact OCCLUDED count is flaky by one because of it.

## For Perf: the skirt's cost, named rather than pre-emptively cut

13240 instances, 26480 triangles, one instanced draw, one material, no texture, no
shadow-pass cost (`castShadow = false`). It adds 1 draw call and about 26.5k built
triangles to a 718k scene. `budget` is 26000 items and `overBudget` is false, so
the cap is real and reported rather than silently thinning. Not cutting it without
a number from you.

## For Terrain: the seam, unchanged

Near foreground is still empty of litter in `edge` and `pines` and full of it in
`underpine`, which is the expected signature of a skirt bounded by `underCrown`.
Mine is under and around planting; the open near-field ground is yours.
