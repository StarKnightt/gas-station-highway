# Handover — System 2, the station building and store interior

Written at a forced stop, mid-iteration, in response to a critic review that
scored the five captures **4/10, FAIL**. Assume you are picking this up cold.

Owned files: `src/systems/BuildingSystem.ts`, `src/gen/building*.ts`,
`tools/shoot2.mjs`, `tools/probe-*.mjs`, `shots/system2/`.

## Read this before you write a probe

**A probe whose maths can be checked without the card gets checked without the
card.**

This is the rule that would have saved the most time on this project, and it
generalises well past it. The GPU is the scarce resource; projection arithmetic,
plan geometry, angular size and unit conversion are not. Every one of those can
be run in Node against the constants in `src/gen/buildingLayout.ts`, for free,
before a browser is ever launched — and when it is run first, it catches the
class of bug that otherwise costs a whole load to discover.

It was validated the expensive way. A verification probe projected every bounding
box to `NaN` because a call site dropped the homogeneous coordinate from
`mul(e, x, y, z, w)`, and reported **"neither door notice produced a measurable
region"** — a confident sentence about the scene, produced by a fault in the
instrument. The same projection done on CPU afterwards predicted both boxes to
within four pixels. Run first, it costs nothing and the load is never spent.

Three corollaries, each of which also cost a load here:

- **A non-finite intermediate is an instrument fault and can never be a
  finding.** Assert `Number.isFinite` over anything you are about to measure and
  fail with "this is a fault in this probe, not in the scene". The danger is not
  a wrong number, it is a plausible sentence.
- **Assert your dependencies in the first `evaluate`.** `THREE` is not on
  `window` in a production build. One round trip against `typeof THREE` beats
  finding out after the scene loads. Better still, do not depend on it: the
  camera carries `matrixWorldInverse` and `projectionMatrix` in every build, and
  sixteen multiplies by hand need no library.
- **Redirect a probe to a file, then read the file.** `> tmp/run.log 2>&1` costs
  nothing. Piping something expensive through `tail` discards the head, which is
  where the first and usually most important ask lives.

Full write-ups are in `NOTES.md`, cases 87 through 90.

## State of the tree

- `npx tsc --noEmit` passes clean across the whole project as of this handover.
- The scene runs. The one change that broke it has been reverted (see
  "Defect 1/2" below).
- Nothing is left running: no chromium, no vite preview, nothing on port 5112.
- The transient `Cannot find name 'num'` another agent saw in
  `BuildingSystem.ts` was mine — a half-finished debug hook that existed for
  about two minutes. It is gone; the hook is now `dbg()`, defined at the top of
  the file.
- **`building.fluorescents` and `building.coolerLightSlots` are untouched.**
  Still `THREE.Object3D[]`, same names, same `userData`. The lighting agent is
  safe.

## Screenshots are slightly stale — re-capture before reviewing

`shots/system2/{front,door,interior,cooler,corner}.png` are from the capture
*before* this session's work. Since then the only live visual change is
paint patchiness and per-elevation colour drift in `buildingWeather.ts`
(`patchiness` / `elevationDrift`, defect 5). Everything else this session was
either investigation or has been reverted. Re-capture with:

```
node tools/shoot2.mjs
```

It now prints the served bundle's filename and mtime with every run, so a
stale capture is visible at a glance.

`shots/system2/interior-dbgfix.png` is a debug frame, not a deliverable — see
defect 10.

## The 16 defects

### Done

**5 — uniform paint.** `applyBuildingWeather` gained `patchiness` (two octaves
of metre-scale blotch in the paint value, separate from the dirt gradient) and
`elevationDrift` (a flat per-elevation hue and value offset keyed off the world
normal, so no two walls match exactly at a corner). Wired to `cmuExt` at 0.55 /
0.075, `cmuBase` at 0.4, `cmuInt` at 0.3. Live but never captured — look at it
before tuning it.

**10 — the featureless grey slab.** Resolved, see below.

### Investigated and settled, no code change needed

**1 — "CMU coursing is roughly double real scale."** *The geometry is correct.
Do not rescale it.* Measured, not eyeballed: in `front.png` at 1600x900 the bed
joints land 23 px apart, and `tools/probe-project.mjs` puts 1 m at 108–114 px
at that wall, giving 0.20 m per course against a 0.2032 m nominal. The texture
is 4 units x 8 courses over a 1.6256 m tile, which is 406 x 203 mm — right.

Two notes for whoever re-checks this. First, `tools/probe-column.mjs` prints
the luminance profile of a pixel column and finds the joint rows; that is how
this was settled. Second, I initially got "1.6x too big" from the same data
because I assumed the captures were 1024x576 — they are **1600x900**. The
constant is now correct in `tools/probe-project.mjs`; trust the tool, not the
image viewer.

The critic's count is a real observation with the wrong diagnosis. It is a
symptom of defect 2, and defect 2 is a genuine bug.

### Half-done — this is the important one

**2 — mortar joints read as a pale drawn grid.** Root cause found, fix written,
**fix not working, currently disabled.**

A 9.5 mm joint is about 6 texels in the 1024px CMU map and roughly *one screen
pixel* at the distance the building is normally seen from. The mip chain
averages it into the block face. The bed joints survive as a washed-out
lattice; the head joints vanish completely. With no vertical joints left, the
eye reads a stack of continuous horizontal bands and infers a much larger unit
— which is exactly what the critic reported. This is the `NOTES.md` pattern: a
defect that resisted tuning twice because the mechanism was wrong, not the
parameter. No contrast value fixes detail that is below the sampling rate.

The fix is analytic world-space coursing, filtered with `fwidth` against the
real pixel footprint, in **`src/gen/buildingCoursing.ts`**. It is complete and
typechecks, and it also gets running bond, exact unit size, per-unit tone that
is not periodic with a texture tile, and a normal across the recess for free.
It is **not called from anywhere.** The file header documents both failed
attempts in detail. Summary:

- Attempt 1 prepended the GLSL declaration block to the top of the fragment
  shader. `applyBuildingWeather` also prepends, including the `vBwPos` /
  `vBwNormal` varyings this code reuses, so the use landed ahead of the
  declaration. It compiled silently with every uniform optimised out.
  `dbgJoint=0` vs `dbgJoint=6` diffed to **exactly zero changed pixels** —
  caught only because `NOTES.md` mandates the forced-value diff.
- Attempt 2 moved the block to just before `main()`. Never captured: the scene
  stopped signalling `__SCENE_READY`, so init throws or the program fails to
  link. `tools/shoot2.mjs` now dumps the page console on a ready timeout, which
  it did not when this was written — that one run will probably name the bug.

`makeBuildingCmu` has been **reverted to the baked-coursing version** so the
walls still read as block. When the analytic path works, strip the coursing out
of the texture again and leave it as pure block face.

### Not started

3 (no typography anywhere — you are cleared to add diegetic signage: window
vinyl, fascia panel, price rails, product labels, cooler decals; invented
wording only, no real brands), 4 (bare roof), 6 (stains need physical source
objects), 7 (storefront profile — thin white mullions, no glazing stop, no
bulkhead), 8 (interior unfixtured), 9 (products unlabelled, no silhouette
variety, no shelf price strips), 11 (cooler internals), 12 (cooler glass
edges), 13 (floor wear), 14 (ceiling tile variety), 15 (interior wall
treatment and cove base), 16 (exterior clutter).

Note on 12: coordinate with lighting. Pane edges, glass thickness, water
spotting and squeegee streaks are yours; reflectance and Fresnel are not —
System 4 is landing a darker interior and real IBL, and faking those now will
double up.

## What was behind defect 10

The critic flagged a large grey slab mid-frame in the interior view as possible
unfinished geometry. It is not a placeholder and not an untextured face.

Forced-value test: `?dbgFixture=1` paints every shop fitting magenta. Capture
in `shots/system2/interior-dbgfix.png`. The slab turns magenta, so it is the
**gondola end panel** — `buildingGondola` in `src/gen/buildingProps.ts` builds
each end cap as a single 1.16 m deep x 1.55 m tall x 24 mm board.

It reads as unfinished because it *is* blank. A real gondola end has slotted
uprights, a perforated or ribbed back panel, a base deck with a recessed kick,
shelf lips, a header, and usually an end-cap wire shelf with product on it.
From this camera the shelving behind it is hidden, so the bare panel floats.
Fixing it is the same work as defect 9 — give the gondola real anatomy — and
the debug hook is left in place (defaults off) for re-testing.

## Next three things

1. **Land the analytic coursing.** Run
   `node tools/shoot2.mjs --shots=front --query=dbgJoint=6` and read the page
   console dump to find why attempt 2 never becomes ready. Then prove it with
   `node tools/diff.mjs` between `dbgJoint=0` and `dbgJoint=6` — the injector
   paints joints pure red above 4.5 specifically so a zero-pixel diff can only
   mean it is not wired. Only then strip the coursing back out of
   `makeBuildingCmu`. This unblocks the two highest-priority defects.
2. **Signage and typography (defect 3).** Called the largest single gap. Render
   text procedurally to canvas. Watch `NOTES.md` case 1: canvas backing stores
   are premultiplied, so for anything with transparency build a `DataTexture`
   from two canvases — one opaque RGB, one greyscale coverage — rather than
   reading back RGBA from a single canvas. Fascia panel, window vinyl, shelf
   price strips, a product label atlas, cooler door decals, restroom and exit
   signs.
3. **The roof (defect 4).** Called the clearest CG tell in the set. Package
   unit, condenser cages, vent stack cluster, a ladder breaking the parapet
   line, conduit runs, scupper. Note the geometric constraint I hit: at a
   standing eye height the parapet hides anything low that sits more than about
   a metre back, so either the kit goes close behind the coping or it has to be
   tall. Give the coping visible thickness, seams and drip staining underneath
   while you are there.

## Case 22 does not affect you — no action needed

`NOTES.md` case 22 records that `applyGrime` samples its noise field in **object
space**, so any mesh drawn more than once receives byte-identical dirt. It hit the
three dispensers and the car's four wheels. You may hear it described as a shared
problem; the building is not exposed, and I checked rather than assuming.

`buildingWeather.ts:135` and `buildingCoursing.ts:144` both build their varying as
`modelMatrix * vec4(transformed, 1.0)` — **world** space. Two instances at
different world positions therefore sample different field automatically, whether
or not anyone intended it. `vGObj = position` in `hardsurface.ts` is the only raw
object-space varying in the project, and the building imports nothing from it.

Keep it that way. If you ever adopt `applyGrime` for a repeated fitting — ceiling
tiles, shop products, anything instanced — read "Per-instance phase: the one
pattern to copy" in `NOTES.md` first, and give each instance a distinct
`fieldOffset`. Amplitude variation cannot substitute; that is what cost the pump
agent several rounds.

**One thing you could fix cheaply.** `BuildingSystem` cannot be loaded by any CPU
tool, because `src/systems/BuildingSystem.ts:8` imports `BuildingMaps` as a value
when it is a type-only export, and Node's strip-only TypeScript mode cannot erase
that. `src/gen/textures.ts` had the same defect and is now `import { type Rng }`.
Until it is fixed, `tools/probe-instancing.mjs` reports the building as unaudited,
and nothing under `tools/` can measure your geometry on the CPU at all — which is
the cheapest kind of measurement available here.

---

# Session 2026-08-28 evening — signage, packaging, roofline, and the `envMapIntensity` follow-up

Representative round: **`2026-08-28T174734Z-mab6V3ys`** (all six poses, GPU
RTX 4060, `systemErrors: []`). Two later rounds exist and are all black —
see "Blocked" at the bottom. Judge from `mab6V3ys`.

## The `envMapIntensity` job, and its result

The brief was that the store interior had lost 14x its ambient light and that
0.07 was "almost certainly far too aggressive now". Measured, it isn't, and the
premise was wrong. Full numbers in NOTES.md under "The channel you are tuning
may not be the channel doing the work". Short version:

- 0.07 -> 0.30 on the `interior` pose moves the foreground shelf by **2.8/255**.
  The indirect term is linear, so 1.0 is worth about +11.
- The band of pure-black product silhouetted against the storefront glass does
  **not move by one pixel** between `?ienv=0.25` and `?ienv=1.0`, while a shelf
  region 200 px away in the same frame moves 33%.

The interior is black because the room has **no bounce**: the troffers are
`RectAreaLight`s, so downward and rearward faces get nothing and clamp. That is
a `lightInterior.ts` problem and it is written up in a long comment at the
`tuneInteriorMaterials` call in `LightingSystem.ts`. **Do not compensate for it
by brightening albedos in `BuildingSystem`.** The default is now 0.25, which is
an honest value for a room with a 15 m glass front rather than a fix.

While chasing it, one real bug fell out: `tuneInteriorMaterials` matched mesh
*names* but this file batches by *material*, so dimming the ceiling grid also
dimmed the ice machine (-46% on the `corner` pose). `enamel`/`steel` are now
split into indoor and outdoor twins, `building.interiorMaterials` is published
as the non-lossy version of that name set, and `tools/probe-envmat.mjs` asserts
they stay split. Run it after touching any interior material.

## Landed

- **Typography**, all in the new `src/gen/buildingSignage.ts`: illuminated
  fascia sign, window vinyl (hours / payment / open / notice), cooler valance
  price rail, shelf-edge price strips, statutory plates, and printed paper
  notices taped inside the glass. Premultiplied-alpha rule from NOTES.md case 1
  is obeyed throughout — cut vinyl goes through `alphaTexture()`, two opaque
  canvases into a `DataTexture`, never an RGBA read-back.
- **Product packaging atlas** (`makeProductLabels`). Greyscale structure only,
  multiplied by the existing vertex palette, so the palette work survives.
  Proven live: `?dbgLabels=1` swaps in a magenta checker and moves **33.4%** of
  the shelf region against **0.0%** of the ceiling control.
- **Gondola** back panel rebuilt as slotted uprights at 3 ft centres with the
  panel set back between them, and the end caps rebuilt as a real frame.
- **Roofline**: vent cluster, antenna mast, dish, access ladder, coping splice
  plates. `tools/probe-roofline.mjs` says 3 of 7 roof batches break the parapet
  from both `front` and `corner`, and the accidental silhouette frame in round
  `KWMh7fM8` confirms it by eye.
- **Cooler end returns** rebuilt as a recessed panel in a proud frame. This is
  the one change **not visually verified** — see below.

## New instruments (all CPU, seconds not minutes)

- `tools/probe-signage.mjs` — every sign's cap height in *screen pixels* per
  pose, with a verdict. This is what showed that half the plates were correct
  artwork at 1-3 px and could never read.
- `tools/probe-pixel.mjs` — ray-casts the real scene through a capture camera
  and names the mesh under a pixel. Written after two wrong guesses about a
  blank rectangle; it found `window-notice` in two seconds.
- `tools/probe-roofline.mjs` — per-column parapet silhouette. Note its first
  cut used merged-batch bounding boxes and reported a batch clearing the coping
  by 234 px at a point in mid-air with no geometry in it. It projects real
  vertices now.

## Still weak

- Bottles in the cooler have no printed wrap — the packaging atlas is not
  applied to `buildingBottle`. Most obvious remaining flat-colour surface.
- Interior contrast is low and even, downstream of the no-bounce problem above.
- The exterior CMU grime reads as soft blobs rather than as directional dirt.
- Paint uniformity, floor wear, ceiling tiles and exterior clutter from the
  original list are untouched.

## Blocked

The last two rounds (`KWMh7fM8`, `D3NKAXzn`) are **entirely black and it is not
this system**. The console says:

    [lighting] world environment contains non-finite values: 1814 cube pixels,
    17892 filtered pixels. Peak channel 94.6875.

NaN in the environment cube poisons every `MeshStandardMaterial` that samples
it. `LightingSystem.ts` and `lightSky.ts` were being edited during those builds.
`window.__SYSTEM_ERRORS` is `[]` throughout — this fails silently, exactly as
NOTES.md warns. Re-capture once the lighting agent lands.

---

## Handover 3 — 2026-08-29, stopped mid-round for GPU

Stopped on request: user needs the GPU. No preview server, no Chromium, port
5112 has no listener. Tree typechecks clean (`npx tsc --noEmit`, exit 0).

**Last complete round: `2026-08-28T182757Z-BJCbm-gz`** (7 shots, `KEEP` in
place). It contains the coursing work, the IGU split, the reframed poses and the
health gate — but *not* the transmission fix below. A full round with everything
was interrupted and never completed. That capture is the first thing to redo.

### 1. Black glazing rectangles — SOLVED, fix landed, not yet captured

Cause found and proven, in my file, not Lighting's. `tools/probe-band.mjs` (new)
characterised the band: 34.7% of it *exactly* `rgb(0,0,0)` with **nothing at all
in luma 1..15** and 630 one-pixel steps averaging 119/255. A bimodal split with
an empty gap is not an unlit object — an unlit object still carries fog, haze
and some sky. It was a shading failure.

It was three's transmission render target. Three measurements, same region, one
lever each:

| change | exactly rgb(0,0,0) |
|---|---|
| baseline | 34.7% |
| `DoubleSide` -> `FrontSide` | 22.7% |
| roughness map off, mip 0 only | 11.8% |
| **transmission off entirely** | **0.0%** |

Two routes into the same target. `renderTransmissionPass`
(three.module.js:18054) re-renders a `DoubleSide` transmissive object *into* the
target its own shader samples — three flags the hazard itself at the target's
creation and its mitigation is skipped unless
`WEBGL_multisampled_render_to_texture` is present, which on ANGLE/D3D11 it is
not. Separately, the glass roughness map selects high mips of that target, and
bad texels averaged up a mip chain is exactly why the artefacts were blocky,
axis-aligned and various power-of-two sizes.

Landed: storefront glazing is now **two single-sided leaves 16 mm apart** (the
IGU second-surface offset the critic asked for), `transmission: 0`, alpha
blended. Attenuation lost is `exp(-0.008/0.6)` = 1.3%, invisible; the whole
transmission pass is now gone from the frame, since this was the only
transmissive material in the project — `CarSystem` had already rejected it for
its own glazing on its own evidence. `?bgt=1` restores it for investigation.
`assertNoDoubleSidedTransmission()` throws at build time so it cannot return.

Caveat to state plainly: under alpha blending `opacity` scales the env
reflection as well as the transmitted image, so reflection strength is no longer
independent of show-through. Current values are outer 0.24, inner 0.13, cooler
0.30. **Glass reflectivity remains blocked** until the PMREM world capture
lands — the lower hemisphere is still a constant colour, std dev 0.0, so there
is nothing to reflect at any strength. When it has content the reflection wants
to be its own additive layer so the two can be set separately.

### 2. Mortar joint depth — fix landed, two-light-angle test NOT yet run

The height information already existed and was cancelling. The normal tilt is
`±1` flipping sign at the joint centreline, across a joint ~1.3 px wide at these
distances, so both flanks land in one pixel, average to zero, and the joint's
*mean* tone comes out light-independent. Same lesson as baking joints into the
albedo, one level down: sub-pixel geometry must be expressed as a change in the
mean, not as a normal.

Landed in `buildingCoursing.ts`: `bcGrooveShadow()`, an analytic self-shadow for
the groove, per joint family, from depth/width and the light's angle off the
wall normal measured perpendicular to the groove. Returns 0 on a shaded wall —
face and groove are then equally unlit, so there is no *relative* darkening.
Also a chamfer/arris term that widens the joint's footprint to ~25 mm so the
whole feature stops living below the sampling rate.

For this site's sun (az 203, el 6.2) it predicts hard dark **verticals** on the
lit front elevation (head joints 97% shadowed, bed joints 12%) and faint uniform
joints on the shaded east elevation. The `wall.png` in round `BJCbm-gz` looks
consistent with that by eye.

**Baseline for the test, measured on the critic's round** with
`tools/probe-joints.mjs` (new): head-joint contrast **9.6% lit front vs 7.6%
shaded east — ratio 1.26**, i.e. no light-direction dependence. That is the
number to beat and it quantifies the critic's claim.

**Not done:** the same measurement on the new round. My one attempt placed the
regions blind and they caught the ladder, conduit, streaks and the storefront
glazing, and the probe's autodetected periods (39–61 px) do not correspond to
coursing. Inconclusive, not a pass and not a fail. Next agent: use `--bed`/
`--head` period locks computed from geometry, on masonry-only regions of the new
`wall.png`, left half (shaded east) against right half (lit front).

### 3. Per-block colour variation — landed, unmeasured

`unitVariation` was 0.035, below the threshold of noticing. Now 0.085 with hue
as well as tone, occasional strong outliers, and per-unit *roughness* variation
(differential paint absorption, the strongest unit-to-unit cue under raking
light). The hash is keyed on world block index, so it also breaks the 1.63 m
albedo tile period the critic saw — one change, both complaints.

### 4. Product silhouette and packaging — NOT STARTED

Untouched this session. The critic's point stands and is half about silhouette,
which no texture fixes: no bags, no bottles with necks, no hanging strips, no
gaps, no product pulled forward, no toppled item. Measure a single facing's
on-screen size in `door.png` and `cooler.png` first — a forced magenta checker
proved the map is *bound*, not that the artwork *resolves*. Varied silhouettes
and irregular facing positions are probably worth more than resolution.

### 5. Poses and harness

- `wall` reframed onto the **corner at x 3.5**, so the lit front elevation and
  the shaded east elevation are in one frame: the critic's two-light-angle test
  with distance, texture and material held constant. The old pose sat square on
  the east elevation, which has a negative N·L — in full shade by construction,
  so no reframing could ever have made it prove a material. Lower-third luma
  87.8, was crushed.
- `base` added: the wall/paving junction at the same corner, for the splash zone
  that has not been built yet.
- `shoot2.mjs` gained a per-pose frame-health gate (near-black fraction, lower
  third, sky where declared). It caught two poses on its first run. `sky` is
  declared per pose because `interior`/`cooler`/`base` have none — and a sky
  check alone is not sufficient anyway, since the sky dome survives whatever
  kills every `MeshStandardMaterial`.
- `probe-pixel.mjs` fixed: it honoured `material.side` and so silently skipped
  every back face — it reported "nothing here but the glazing" for the black
  band. It now forces `DoubleSide` for the cast and labels back-face hits.
  Fourth probe in two days to return the comfortable answer.

### Exact next step

1. Re-run `node tools/shoot2.mjs` (full 7 poses) on the current tree. Confirm
   `probe-band.mjs` on `interior.png` region `780,420,340,90` reports 0.0%
   exactly-zero, and check the health gate output on all seven.
2. Run the two-light-angle test properly on the new `wall.png` per §2. Accept
   only if the lit/shaded head-joint contrast ratio is well clear of the 1.26
   baseline.
3. Then products (§4), then streak sources and the wall base — every streak
   re-authored to originate from a coping joint, sign fixing, conduit
   penetration or the scupper, with a hard leading edge and a dust fan.

Still open from the critique and untouched: signage ageing (UV yellowing,
chalking, lightbox seam, retainer shadow, vinyl edge relief), the "OPEN 24
HOURS" sign floating with no chain or bracket, floor traffic path and grout
dirt, ceiling tile imperfection, rooftop mass (no RTU or condenser; the ladder
still climbs to nothing), the untextured white box on the side wall — visible in
`wall.png` in round `BJCbm-gz` — mullion variety, and coping joint plates.

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

# Handover 4 — 2026-08-29, resumed after the GPU pause

Both of the things handover 3 landed but never captured are now **verified in
pixels**. Rounds, all RTX 4060, `systemErrors: []`, `KEEP` in place:

- **`2026-08-28T192511Z-DL-65ovI`** — the full seven poses, the redo handover 3
  asked for. This is the round to hand a critic.
- **`2026-08-28T193850Z-CQQEGJA3`** — `wall` only, and **byte-identical** to
  `DL-65ovI`'s `wall.png`. That is the proof that the `?bcshadow=` knob added
  this session is inert at its default, and it makes the two rounds directly
  comparable.
- **`2026-08-28T194052Z-CQQEGJA3`** — `wall-gs0.png`, the same bundle with
  `?bcshadow=0`. Captured with `--no-build`, so the only difference between it
  and the round above is the query string. Cross-build diffs are not trustworthy
  in this repo (RESUME-PLAN §0); this is not one.

Health gate: six of seven poses pass. `corner` reports 2.47% near-black against
a 2% limit — see "the corner health flag" below.

## 1. Black glazing rectangles — GONE, and confirmed whole-frame

`probe-band.mjs` on `interior.png` region `780,420,340,90` reports **3 pixels of
30600 exactly `rgb(0,0,0)`, 0.0%**, against the 34.7% baseline. The luma 1..15
tail that was *completely empty* is now populated at every level. The bimodal
gap that identified this as a shading failure has closed.

That region was hand-picked, so it is the weaker half of the evidence. The
stronger half is **`tools/probe-zeroscan.mjs`** (new), which takes no
coordinates at all: it counts exactly-black pixels over the whole frame, counts
the luma 1..15 population immediately above them, and reports connected
components of the black set with their bounding boxes and how completely they
fill them. The signature it hunts is the *distribution* — many exact zeros with
an empty tail — not a location. `--selftest` carries a planted clamped-black
rectangle that must be reported and a fogged unlit object that must not.

Same instrument, same seven poses, before and after:

| interior.png | exactly rgb(0,0,0) | tail/zero | black components | largest |
|---|---|---|---|---|
| `BJCbm-gz` (pre-fix) | 20590 (1.430%) | 2.21 | 41 | 8688 px, bbox 267x78 |
| `DL-65ovI` (post-fix) | **326 (0.023%)** | **127** | **2** | **53 px** |

The 8688-pixel rectangle is gone; the largest surviving black component anywhere
in the frame is 53 px and straggly. Every other pose is clean on both rounds.
**Do not reopen this.** `?bgt=1` still restores transmission if anyone needs to
reproduce it.

### The corner health flag is not this bug

`corner.png` trips the near-black gate at 2.47%. It is not the glazing artefact
and it is not new: the same measurement on `BJCbm-gz` is **4.09%**, so this
round is a large improvement that still sits over the threshold. `probe-zeroscan`
puts the tail/zero ratio at 226 with no rectangular components, i.e. ordinary
deep shade rather than a clamp. Either the pose genuinely has that much shadow
in it and the 2% limit is wrong for it, or the east elevation needs bounce it is
not getting — which is Lighting's `lightInterior`/PMREM work, not this system's.
Decide it with evidence before moving the threshold; a gate loosened to make a
frame pass is worth nothing.

## 2. Mortar joints, the two-light-angle test — PASS, ratio 3.81 against 1.26

**Baseline to beat was head-joint contrast 9.6% lit vs 7.6% shaded, ratio 1.26.
Measured now: 39.16% lit vs 10.28% shaded, ratio 3.81.**

### Why the previous attempt could not have worked, and what replaced it

`tools/probe-wallregions.mjs` (new) ray-casts the `wall` pose and reports the
largest rectangle containing nothing but one elevation of exterior masonry. On
the lit front elevation that rectangle is **128 x 896 px — 1.2 head-joint
periods wide.** There is no rectangle anywhere in the frame that is three whole
head periods across on either elevation: the storefront glazing, the ice
machine, the conduit and the ladder cut every wide band of block. So the earlier
attempt was not unlucky in its coordinates. **Any rectangle large enough to fold
contains something that is not masonry**, and `probe-joints.mjs` cannot do this
job on this pose however carefully its arguments are chosen.

One correction to handover 3 while we are here: the autodetected 39-61 px
periods were dismissed as "not corresponding to coursing", and 61 px is in fact
**exactly the bed course** — the projected 0.2032 m course measures 61.39 px on
the lit elevation and 58.84 px on the shaded one. The autodetection was picking
up real coursing *and* mullions indistinguishably, which is worse than picking
up neither.

`tools/probe-jointphase.mjs` (new) is the replacement and it does not fold
anything. The joint position is not a mystery to be recovered from the image —
the shader computes it from world position — so this recomputes the identical
expression per pixel and bins rendered luma by phase within the unit:

- the ray-cast mask is **eroded by one cell**, so no sampled pixel is within
  8 px of anything that is not block;
- inside a surviving cell the wall is planar, so each pixel's world point comes
  from an exact ray-plane intersection: no period in pixels, no perspective
  error, no autodetection;
- `horiz`, `vert`, the running bond and both phases are copied line for line out
  of `bcJoints`.

It samples **283,136 verified-masonry pixels on the lit front and 282,048 on the
shaded east**, which is most of both elevations rather than a chosen rectangle.

### The numbers

| | mean luma | head contrast | bed contrast | decoy floor |
|---|---|---|---|---|
| lit front (N dot L 0.38) | 152.5 | **39.16%** | 27.06% | 8.40% |
| shaded east (N dot L -0.90) | 56.9 | **10.28%** | 29.59% | 0.71% |

The decoy is the same pixels binned at 0.63 of the unit — non-harmonic, so a
real joint cannot leak into it. It is the noise floor for that region, and the
head signal is 4.7x and 14.5x its own floor.

**The joint minimum lands at phase 0.96-0.00 on both elevations**, i.e. exactly
on the unit boundary where the shader puts it. That is the check that says I am
measuring joints, and it is the one the previous attempt could not make.

### Three reasons to believe the ratio rather than just quote it

1. **The bed family is the built-in control and it does not move.** Bed contrast
   is 27.06% lit against 29.59% shaded — **ratio 0.91, no light dependence at
   all**, which is exactly what `bcGrooveShadow` predicts for bed joints (12%
   shadowed, i.e. nothing). The head joint projects 2.39 px on the lit elevation
   against 1.54 px on the shaded one, because the east wall is seen more
   obliquely, and that difference does inflate the head ratio. But the bed
   joints project 2.90 px against 2.78 px and show **no** inflation. If
   foreshortening or exposure were manufacturing the head result, the bed family
   would carry the same bias. It does not.
2. **The within-elevation head/bed ratio swings 4.1x**: 1.45 on the lit wall,
   0.35 on the shaded one. That is a ratio of two measurements taken in the same
   region of the same frame, so it is immune to exposure, distance and any
   per-elevation scale factor whatsoever.
3. **The causal control is one-sided and the null arm is exact.** `?bcshadow=0`
   scales `uBcShadow` and nothing else. Predicted: the lit front must move, the
   shaded east must not, because `bcGrooveShadow` already returns zero wherever
   N dot L <= 0. Measured, same bundle, one knob:

   | | head | bed |
   |---|---|---|
   | lit front, shadow on | 39.16% | 27.06% |
   | lit front, shadow off | 33.68% | 25.53% |
   | shaded east, shadow on | 10.28% | 29.59% |
   | shaded east, shadow off | **10.28%** | **29.59%** |

   Every bin of the shaded profile is numerically identical across the knob.
   That is the null the whole test rests on.

### The honest caveat, and it matters for the next round

The groove self-shadow is **live and correct, but it is not the dominant term.**
Removing it takes the ratio from 3.81 only to 3.28. Most of the light-direction
dependence is coming from the arris/chamfer and the normal perturbation, which
are also light-dependent on a lit wall and inert on a shaded one. So the feature
passes its acceptance test, but the mechanism handover 3 credited for the fix is
worth perhaps a sixth of the effect. If anyone later tunes `depth`, `shadow` or
`occlusion` expecting large movement, that is why they will not get it.

## 3. Per-block colour variation — breaks the albedo tile, confirmed

`probe-jointphase.mjs` also reports a **lag correlation over the per-unit tone
map**. Phase binning cannot answer this question — a per-block random offset
averages out and leaves the profile flat whether the tile repeats or not — so
each course is de-meaned (killing the vertical lighting gradient and the dirt
band) and blocks are correlated against blocks *n* units along the course. If
the 1.6256 m albedo tile were intact, lag 4 would have to stand out.

| lag | 1 | 2 | 3 | **4** | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| lit front | -0.17 | 0.03 | -0.17 | **-0.09** | -0.20 | -0.02 | -0.29 | -0.47 |
| shaded east | -0.11 | -0.01 | 0.02 | **0.06** | -0.06 | -0.07 | -0.10 | -0.11 |

Lag 4 is unremarkable on both elevations. **The tile period is broken.**
Per-unit tone spread measures 7.9% of mean on the lit front and 6.8% on the
shaded east over 106 and 307 block faces, against an authored `unitVariation` of
0.085 — the variation is reaching the pixels at close to its authored magnitude.
Caveat: the lit front has only 106 faces, so its individual lag figures are
inside the noise. The east elevation, with 307, is the one to quote.

## 4. Products — the premise in the queue was wrong, and here is the number

The queue's assumption was that the packaging artwork does not resolve at
on-screen size. `tools/probe-facings.mjs` (new) ray-casts each pose, keeps the
pixels where a product is the *first* hit, and does the millimetres-per-pixel
arithmetic at their real depth. The atlas is 1024 px on a 4x4 grid, so **256 px
per cell**:

| pose | product coverage | median depth | typical facing | atlas texels per screen px |
|---|---|---|---|---|
| `cooler` | 6.0% | 1.03 m | **92 px wide** | **3** |
| `interior` | 8.2% | 3.44 m | 23 px wide | 11 |

**In the `cooler` pose the artwork is barely minified** — three texels per pixel,
about 30 distinguishable marks across a facing. Resolution is *not* what makes
the cooler read flat. The cause is the one already named under "Still weak" in
the previous session: `buildingBottle` never gets `applyPackaging` at all, so
those are untextured solids. Fix that before touching the atlas.

At `interior` distance the premise does hold: 23 px per facing means about seven
distinguishable marks across the whole cell, so anything finer than ~13% of the
cell width averages to a flat tint. Design the cell for that — bold value blocks,
no letterforms — which is the "A blank object is a conspicuous object" rule in
NOTES.md with an actual number attached.

Two things about that probe worth knowing before trusting it. `door` reports no
product pixels, because the storefront glazing is the first hit along every ray;
if that pose matters the probe has to walk past transmissive hits. And two
earlier attempts to recover a per-facing extent from the merged buffer — by
atlas cell plus rounded world position, and by contiguous runs of one cell —
were **both wrong in the flattering direction**, splitting one packet into
several and reporting median facings of 15 px and then 1.3 px. Both said "the
artwork cannot possibly resolve". The depth-and-authored-width arithmetic agrees
with an independent hand calculation and does not.

## Changed this session

- `src/gen/buildingCoursing.ts` — new `shadowScale` option, multiplying `shadow`
  alone. The reasoning for why `amount` cannot serve as this control is written
  at the option.
- `src/systems/BuildingSystem.ts` — `?bcshadow=` wired to all three coursing
  call sites, and **rejected with a throw when it is not a number** (NOTES case
  25: a silently-ignored debug token produces the most persuasive wrong result
  available here, a clean null on the arm that was supposed to move).
- New instruments: `tools/probe-zeroscan.mjs` (with `--selftest`),
  `tools/probe-wallregions.mjs`, `tools/probe-jointphase.mjs`,
  `tools/probe-facings.mjs`.

`npx tsc --noEmit` is clean across every file this system owns. The tree as a
whole currently reports one error, `VegetationSystem.ts(775,25): Property
'addGroundMat' does not exist` — another agent mid-edit, untouched by me.

Nothing left running; port 5112 has no listener.

## Next

1. `applyPackaging` on `buildingBottle`. Measured above as the actual cause of
   the flat cooler, and the cooler is the pose where artwork can resolve.
2. Silhouette variety, which no texture fixes: bags, necked bottles, hanging
   strips. Note the shelf generator already has cans-as-tubes, sold-out gaps,
   pulled-forward items and knocked-out-of-square rotation, so the gap is
   narrower than the critic note implies — check what is there before adding.
3. Streak sources and the wall base.
4. Still blocked on Lighting's PMREM world capture: storefront and cooler glass
   reflectivity. Under the alpha-blended IGU, `opacity` scales the env
   reflection and the show-through together; when there is structure to reflect,
   split the reflection into its own additive layer.

---

# Handover 6 — glazing reflection separated from opacity

Round **`2026-08-28T221421Z-BzYx0D-X`**, seven poses, all frame-health gates
green, zero `__SYSTEM_ERRORS`, no shader compile or link errors. RTX 4060
verified on every round. Port 5112 clear.

Evidence rounds, all `KEEP`-marked:

| round | what it is |
| --- | --- |
| `2026-08-28T212831Z-B7HRiqWE` | separated glazing, `front door interior cooler` |
| `2026-08-28T213334Z-B7HRiqWE` | `?bglsep=0`, the conflated control |
| `2026-08-28T213838Z-B7HRiqWE` | `?bglrefl=0`, reflection leaves forced black |
| `2026-08-28T214543Z-B7HRiqWE` | `?worldenv=0`, sky-only environment |
| `2026-08-28T215026Z / 215353Z / 215937Z / 220219Z` | `corner` at separated / refl0 / conflated / sky-only |
| `2026-08-28T220853Z-B0FvviTl` | `corner` and `base` after the base-course lift |
| `2026-08-28T221421Z-BzYx0D-X` | the full seven-pose round |

## What changed

A pane of glass **transmits** what is behind it and **reflects** what is in
front of it, and the reflection is *added* — it does not attenuate with how
transparent the glass is. One alpha-blended material cannot say that, because
`gl_FragColor.rgb` is multiplied by alpha on the way into the framebuffer. At
`opacity: 0.24` the environment reflection was arriving at 24% of strength, and
every attempt to show more interior removed more sky.

Each pane is now two coincident leaves sharing one geometry:

- the existing material, **transmission only** — `specularIntensity: 0` removes
  F0 entirely, so it carries the tint and nothing else and its `opacity` means
  one thing;
- `glassRefl` / `glassInnerRefl` / `coolerGlassRefl`, **reflection only** —
  black diffuse, `AdditiveBlending` at `opacity: 1`, `ior: 1.52` giving the
  physical F0 of 0.043 so the Fresnel curve comes from the BRDF rather than
  from a tuned rim term.

Added by `BuildingSystem.addGlazing`, which puts the reflection at
`renderOrder + 1`. **That ordering is load-bearing.** Alpha over additive gives
`(bg + refl) * (1 - a) + tint * a`, which is the original bug reintroduced;
additive over alpha gives `bg * (1 - a) + tint * a + refl`, which is the
physics. The entry-door leaf gets its reflection added to the door group rather
than the building group, or the reflection stays hanging in the doorway when
the door swings — and it would look enough like a pane to survive a glance.

`?bglsep=0` restores the single conflated material. `?bglrefl=<k>` scales every
reflection leaf; `?bglrefl=0` blacks them out, which is the cheap proof that
the leaves are the surface being measured.

**The intensity was deliberately not tuned.** Both leaves carry the 1.25 the
conflated material carried. Separating a parameter and re-tuning it in the same
change makes the measurement worthless — you cannot then tell the architecture
from the number.

## Verified in pixels

Separation reaches the framebuffer: separated versus conflated changed 38.2% of
the `door` frame (mean 3.57, max 95), 13.0% of `front`, 10.2% of `cooler`.

**The reflection now follows Fresnel; before, it was anti-correlated with
angle.** Mean luma of a glazing rectangle, against the same rectangle with the
reflection leaves forced black:

| | near-normal (`front`) | grazing (`corner`) |
| --- | --- | --- |
| no reflection | 117.7 | 152.5 |
| conflated (old) | 120.8 (**+3.1**) | 151.8 (**−0.7**) |
| separated | 121.7 (**+4.0**) | 171.0 (**+18.5**) |

The old material delivered slightly *less* than no reflection at all at grazing
incidence, because `specularIntensity: 1` takes a large `1 - F` bite out of the
diffuse term there and the specular that replaced it was then multiplied by
0.24. The separated pane reflects 4.6× more at grazing than head-on, which is
what glass does, and it is visible: the `corner` crop shows structured warm
reflection sweeping across the bays where the conflated version is a flat dead
sheet.

**The environment content is structured, not a gradient.** `?worldenv=0` versus
the new default, measured with `tools/regiondiff.mjs`, which reports the delta
remaining after each rectangle's mean brightness is equalised:

| region | structural delta | changed |
| --- | --- | --- |
| glass bay 1 | 4.35 | 53.8% |
| glass bay 2 | 4.12 | 49.2% |
| CMU wall control | 1.78 | 5.1% |
| asphalt control | 0.40 | 0.0% |

The wall moves in *level* and barely in pattern, as a rough diffuse surface
should. The glass moves in pattern over half its area. Lighting's world capture
is arriving in the glazing as content.

## Cost

**Texture memory delta: zero.** The reflection leaves share the pane geometry
and every map with the material they clone; no new texture, no new vertex.

**Draw calls: +10 to +12 per pose** (`front` 328 → 340, `door` 347 → 358,
`interior` 352 → 363, `cooler` 314 → 324), measured directly by holding
`?bglsep=0` against the default on the same bundle. Five cooler doors would
have cost ten rather than five: both leaves of each door reflect, and the
offset between the two highlights is most of what separates a cooler door from
a hole in a box, but the pair merges into one additive mesh.

For the performance agent: total texture memory on this build is **375.00 MB**,
of which building owns 98.07 MB and car 13.63 MB. **276.75 MB is in
`(unnamed group)`** — six 2048² maps at 22.4 MB each and a long tail. Whatever
owns that is a better place to look than the packaging atlases.

## Two `envMapIntensity` findings

**One of mine was dead, and it was written an hour after I read case 26.** The
`bottle` material carried `envMapIntensity: 0.5`, authored last session with a
paragraph of reasoning about clearcoated lathes reflecting a flat wash. It
cannot do anything: `bottle` is drawn by the mesh named `cooler-stock`, which is
in `tuneInteriorMaterials`' INTERIOR set, and that function assigns
`envMapIntensity = interiorEnv` over whatever is authored. The binder then
adopts Lighting's value as the authored one, so the override is permanent
rather than first-frame. Restored to 1.0 with a comment saying the value is not
used. This is case 26's shape by a different mechanism — not an inert uniform
but a live one owned by another system — and it is worth recording that the
wrong value was mine, recent, and read as deliberate.

The rest of the audit is clean: no material in this system reaches the frame
with a value that only made sense while the uniform was inert. The glazing's
1.25 is the one that was most suspect and it is now measured rather than
assumed — see the Fresnel table above.

## `buildingCoursing.ts` is not affected by the `dithering_fragment` finding

It injects at `map_fragment`, `roughnessmap_fragment` and
`normal_fragment_maps`, all of which run before lighting and therefore long
before `tonemapping_fragment` and the sRGB encode. Its terms are albedo,
roughness and normal perturbations — surface properties, not added radiance —
so there is nothing there that could be paint applied after the camera. It also
already guards every substitution: `sub()` throws if the needle is absent,
because a `.replace` that silently found nothing is the other way an injection
reaches the framebuffer as a no-op. Vegetation's audit should come back clean;
if it does not, the finding is welcome.

## A defect Lighting's promotion exposed, and what I did about it

The `corner` pose failed its near-black gate at **2.67% against a 2% limit**,
where the previous full round measured 0.41%. Attribution, on one bundle:

| variant | near-black |
| --- | --- |
| default | 2.67% |
| `?bglsep=0` — my glazing change off | 2.67% |
| `?worldenv=0` — the world capture off | **0.41%** |

Not mine. `tools/probe-zeroscan.mjs` says the frame is clean — no bimodal gap,
no rectangular black blocks, tail/zero ratio 1727 — so this is not a shading
failure but a genuine darkening. Locating the pixels that are near-black under
the world capture and not under sky-only puts 97% of them in one band, `y`
600–700, `x` 200–800: the base course of the shaded north elevation.

The cause is that the old environment's lower hemisphere was a flat bright
ground disc pushing a warm bounce into every shaded surface. On `corner` the
shaded elevation fell **59.8 → 46.3 mean luma and its warm cast collapsed from
R−B 18.8 to 3.1**, and the base course, already the darkest surface on the
building, went to a mean of 8.8 with a standard deviation of 9.7 — a black
stripe in which none of the spatter or tide line calibrated into it on the
`base` close-up survives.

**For Lighting:** the shaded elevations of this building lost 23% of their light
when the world capture became default. That is arguably correct — a real
forecourt does not bounce like a white card — but somebody should decide
whether the sky is filling shadows enough, because this is not confined to
masonry and every agent with a shaded pose will meet it.

**What I changed:** `cmuBase` albedo 0x6a6659 → 0x928b7c, one lever, on the
argument that a base course is a dirtier version of the wall above rather than a
black plinth. Result: base band 8.8 → 11.1 mean, `corner` near-black 2.67% →
**0.76%**, `base` pose 1.02%, both inside gate. The wall above moved 46.3 →
46.5, i.e. not at all, which is the control confirming the change went where it
was aimed. The grime and band strengths were left alone: they carry the detail
and were calibrated against a relative target, so they simply got a brighter
wall to modulate.

## Known approximation in the new glazing, and the next move

The transmission leaf does **not** lose energy to Fresnel. A real pane transmits
almost nothing at grazing incidence, where `F → 1`; this one transmits its full
`1 - opacity` at every angle and then has the reflection added on top. So
grazing panes are brighter than the truth — some of the +18.5 above is
double-counted.

Doing it properly is a second architectural change and did not belong in the
same round as the separation. It is not simply `a = 1 - (1-F)(1-a₀)`, because
driving alpha to 1 at grazing makes the pane show its own bright diffuse tint
where it should show a mirror; the body tint has to scale by `1 - F` as well,
which means the transmission leaf needs its own small injection rather than a
parameter change. That is the next piece of work on this material, and it is
the one that would make the door interaction read hardest, since it is the
grazing panes either side of the door that should go opaque and reflective as
you approach.

## Queue state

1. `buildingBottle` packaging — **done**, handover 5.
2. Product silhouette variety — **done**, handover 5.
3. Streak sources and wall base — **done**, handover 5, and the base course
   recalibrated again this round for the new environment.
4. Full seven-pose queue — **done**, `2026-08-28T221421Z-BzYx0D-X`.
5. Glass reflectivity — separation **done and measured**; intensity deliberately
   untuned; Fresnel-coupled transmission identified as next.

---

# Handover 7 — Fresnel-coupled transmission, and the critic's masonry findings measured

Round **`2026-08-28T224313Z-2wcG_ZcF`**, seven poses, all gates green, zero
`__SYSTEM_ERRORS`, no shader errors, RTX 4060 verified, port 5112 clear.

Controls, both `KEEP`-marked and both on the same bundle as the round:
`2026-08-28T223250Z-2wcG_ZcF` (Fresnel on) and `2026-08-28T223736Z-2wcG_ZcF`
(`?bgfres=0`).

## The base-course lift is a TEMPORARY COMPENSATION

`cmuBase` albedo is at 0x928b7c and **must go back to 0x6a6659** when Lighting
reports on the ambient loss. It is labelled as such in the source in block
capitals. It is not an art decision, nothing is tuned against it, and no work in
this handover builds on it. Five systems each quietly compensating for the same
missing light is the outcome to avoid, and a compensation that outlives its
cause is already NOTES case 17.

## Fresnel-coupled transmission — `src/gen/buildingGlazing.ts`

The gap named at the end of handover 6: the transmission leaf did not lose
energy to Fresnel, so grazing panes transmitted fully *and* reflected fully.

It is not a parameter, for two reasons. It is a function of viewing angle and
`opacity` is a constant; and driving alpha alone is wrong, because
`out = bg(1-a) + tint·a` with `a → 1` at grazing shows the pane's own bright
body tint at full weight — a milky panel where a mirror belongs. So both halves
move: `a = 1 - (1-F)(1-a₀)`, and `tint` is rescaled to hold `tint·a` equal to
`tint₀·(1-F)·a₀`. At grazing, alpha goes to 1 and the diffuse to zero, the pane
occludes the background completely and contributes nothing of its own, and the
additive reflection leaf — untouched by this — is the whole image.

Injected at `normal_fragment_maps`, the first point where a shading normal
exists and well before `lights_fragment_begin` reads `diffuseColor`. Note for
the audit: that is **before** `tonemapping_fragment` and the sRGB encode, so
this modifies a scene-referred quantity on the way in. `F0` is derived from
`material.ior` rather than authored, so it cannot drift away from the value the
reflection leaf's BRDF is using. `?bgfres=0` is the A/B.

### Verified in pixels

| | `front` (near-normal) | `corner` (most oblique pose) |
| --- | --- | --- |
| changed pixels | **0.01%**, max 4 | 1.33%, max 33 |
| glazing mean luma | 56.8 → 56.8 | 172.1 → **167.6** |

Near-normal is *supposed* to be nothing: `F(0°) = 0.043`. That it measures
0.01% of the frame is the prediction holding, not a null result.

The discriminating test is the derivative, per NOTES case 39 — a single sample
of a function is not a measurement of the function. Sliced into seven columns
across one flat elevation in one frame, the delta runs **−1.63, −2.28, −3.48,
−6.47, −5.40, −1.42, −9.93**. It varies 6× across a single plane. A constant
opacity change cannot do that; an angle-dependent term is the only thing that
can. (The −1.42 column straddles the door mullion.)

**Honest limit: the effect is small at every angle these poses contain, and that
is physics, not a weak implementation.** Schlick's `(1-cosθ)⁵` needs `cosθ <
0.2` — about 78° — before `F` passes 0.3, and the most oblique pane in the
`corner` pose is nearer 65°, giving `F ≈ 0.12` and the −4.5 luma measured. The
mirror behaviour is real and correct and **no fixed camera in this project will
ever see it**, because it lives in the approach to the door: walking along the
shopfront is exactly the geometry that drives `cosθ` towards zero. That is NOTES
case 35's shape — a feature the `?shot=` presets are structurally blind to — and
the walk probe is where it should be verified.

## The critic's masonry findings, measured

New tool: **`tools/probe-period.mjs`** (`--selftest`), shared, not
masonry-specific.

The previous test asked for the correlation between a block and the block four
along and returned −0.09. **A correlation at one lag is not a test for
periodicity** — it can only find a period you already guessed, in the units of
the quantity you chose to sample. The critic was not doing that; they were
seeing *whatever* repeats. So the probe sweeps every lag from 2 to 160 px, on
both axes, over nine bands, and takes no coordinates from the caller.

**The critic and the earlier measurement were both right, and the earlier
measurement missed it by 0.3 of a block.**

`front`, storefront band, horizontal: fundamental at **24 px, r 0.213** — the
masonry unit, which is what should dominate — and a subordinate repeat at
**89 px, r 0.143**, which is 3.7 blocks. The albedo tile is 1.63 m against a
0.4 m unit, i.e. 4.07 blocks, so the lag-4 test landed at about 98 px and found
nothing, while the thing that is actually visible sits at 89 px. Perspective
across the band accounts for the difference. So: **a real repeat at "a period of
a few blocks" exists, at r 0.143, below the per-block fundamental but not
absent.** Reducing it means either more per-unit variation or breaking the tile
with a second octave — I have deliberately not touched `buildingCoursing.ts`
while Vegetation's `dithering_fragment` audit is running on it.

Vertically: **13 px, r 0.48–0.52** across the whole elevation, with harmonics at
26 and 39 px all weaker than the fundamental. 13 px is one course. That is the
bed joints repeating at the course pitch, which is what masonry is. There is no
two-value course alternation: the critic's "alternate between two grey values"
is not in these frames.

**Parapet cap — not reproducible.** Measured along 800 columns on `front` and
290 on `corner`: peak luma mean 162.0 and 199.6, max 247 and 248, and **0.0% of
columns at or above 250**. It is not pure white and nothing is clipped. Apparent
thickness varies with a standard deviation of 9.8 px and 25 px along the run, so
it is not constant width either.

**Streaks — the origins landed.** The streak on the shaded elevation in
`wall.png` visibly begins at the coping line and fades downward; it does not
begin in mid-air. The critic's frames predate `dripPitch`.

**Base band — this one is the ambient loss, already reported and compensated.**
On the sunlit `front` elevation the base course reads as warm brown block with
visible coursing; the black band is the shaded elevations only, which is the
23% ambient loss now with Lighting. I have not done further base work, per the
instruction not to build on the compensation.

**Protected and untouched:** the storefront at middle distance, mullion spacing,
brand strip and typography, OPEN sign, interior depth, wall light, ice
merchandiser cages, roof antennas, dish, condensers, ladder. Nothing in this
round goes near any of them.

## Not mine, but visible in the numbers

Between round `2026-08-28T221421Z-BzYx0D-X` and `2026-08-28T224313Z-2wcG_ZcF`
the scene got substantially darker with no Building change in between: `front`
sky band 126.3 → 81.2, lower third 55.4 → 40.4; `corner` sky 148.1 → 120.5.
Texture count 113 → 120 and total texture memory 375.00 → 382.33 MB over the
same interval, with building flat at 98.07 MB. Something landed — the pump
island canopy is the obvious candidate, and a canopy over the forecourt would
legitimately darken the elevation facing it. Flagging it because every
before/after in this handover is deliberately taken on one bundle for that
reason, and anyone comparing across the two rounds will otherwise attribute it
to the glazing.

## Queue state

- Glazing separation — done, handover 6.
- Fresnel-coupled transmission — **done and measured**; verification of the
  mirror regime needs the walk probe, not a fixed pose.
- Base-course lift — **temporary, revert on Lighting's word.**
- Masonry periodicity — measured, one real subordinate repeat at 89 px found;
  fix deferred while `buildingCoursing.ts` is under audit.
- Interior (unshaded shelf slabs, blown light panels with no falloff, the
  unmounted poster with placeholder bars) — untouched this round, ranked below
  the glazing as instructed. The poster is the most clearly mine of the three.

---

# Handover 8 — interior, and a retracted attribution

Round `2026-08-28T232335Z-DbUOTurA` (seven poses). Control frames for the lens map are in
`2026-08-28T233155Z-DbUOTurA` as `interior-lensoff.png`, captured off the same bundle.

## Correction: the darkening is not the canopy, and I should have caught that

Handover 7 attributed a scene-wide darkening to the pump-island canopy. **That
attribution does not survive its own numbers and is withdrawn.** The figures I
reported were `front` *sky band* 126.3 → 81.2 and `corner` sky 148.1 → 120.5. A
canopy over the forecourt occludes ground and forecourt; it cannot darken the
sky dome above the horizon, and on `front` it is not even between the camera and
the sky. A 36% fall in sky luminance is exposure, tone mapping, or the sky
shader — none of which is a canopy and none of which is mine.

The error is worth naming because it is a shape rather than a slip: **I had a
plausible cause available and a set of numbers that did not discriminate between
causes, and I stopped at the first story that fitted some of them.** The sky
band was in my own table and it falsifies the canopy on its own. The general
guard is to ask, of any attribution, *which of my measurements could this cause
not have produced* — and here the answer was sitting in the same row.

This makes the base-course albedo lift **doubly provisional**: it may be
compensating for two separate movements at once. It is still in place and still
labelled as temporary in `BuildingSystem.ts`. It is now looking increasingly
unnecessary — this round's `corner` near-black is **0.06%** against a 2% gate,
where the failure that motivated the lift was 2.67%. I have not reverted it,
because the instruction is to wait for Lighting and because reverting on a night
when the sky moved twice would be tuning against a moving target. When Lighting
reports, revert to `0x6a6659` and re-run `corner` and `base`.

## Interior

### The poster — fixed, verified in pixels

The critic's "grey placeholder bars where content should be" was accurate, and
the sheet is the `hiring` cell of `makeWindowNotices`. It was ruled lines
throughout, on the stated reasoning that "at the size this is ever seen, real
words average to a grey smear".

That reasoning was right about the body and wrong about the masthead, and the
difference is arithmetic. The cell is 512 px and the `door` pose renders it
133 px wide. A 74 px masthead lands on **19 px** of screen; a 15 px body line
lands on **3.9 px**. One of those holds letterforms and the other cannot. This
is the packaging-resolution finding again with the correction that **the budget
is per element, not per texture** — a single sheet can legitimately carry real
type and deliberate illegible small print at the same time.

It now reads `NOW HIRING` over a rule, ruled body copy, and a reversed-out
`APPLY WITHIN` block. The two other cells that carry a heading at usable size
got the same treatment (`LOST DOG`, `ATM $2.50`).

The mount existed and could not be seen: two 40%-white rectangles on cream
paper, a contrast of about four values. Tape reads by its **edges**, not its
brightness, so the tabs are now angled, outlined, and run over the sheet edge on
to the glass. Both are plainly visible at 133 px.

One self-inflicted intermediate worth recording: the first attempt set the
masthead at a flat 86 px and the capture read `NOW HIRING` with the N and the G
cut off by the paper edge — **the exact failure the store-hours block one
function away already guards against**. There is now a shared `fitCentred`
helper and every headline on the sheet goes through it. Canvas draws past a
boundary and reports nothing; any headline whose text or box can change wants
measuring rather than a size chosen by eye.

### The light panels — improved, and one half of the complaint is not mine

"Blown to flat pure white with no falloff onto the tile" is two faults and they
have different owners.

**The falloff onto the tile is light.** The fittings emit nothing on to the
ceiling they are set into, and no material can fix that. Reported to Lighting
below.

**The flat clipped face is appearance, and that is mine.** The lens was a single
value, so 1.30% of the upper half of `interior` sat within one code of pure
white in hard-edged rectangles. `makeTrofferLens` now supplies an emissive
*modulation* map: two T8 tubes at a quarter and three quarters across the short
axis, a real dip between them, a hard tuck into the pan at the perimeter, and a
shallow prism grid. Deliberately a modulation and not a level — three multiplies
the emissive map into `totalEmissiveRadiance`, so Lighting keeps
`emissiveIntensity` and this only decides the distribution inside the panel.
Peak is 1.0, so it cannot brighten anything.

**The first version measured as doing nothing, and the reason generalises.** It
ran 0.60–1.00 with a perimeter floor of 0.45 and the capture was
indistinguishable from the flat lens: 4.77% vs 4.78% of the ceiling above luma
250. It had bound correctly. Lighting drives these at `emissiveIntensity` 2.4,
so a 0.45 floor is 1.08 in scene-referred linear and everything from about 1.0
up tone-maps into the top couple of codes. **A modulation map is only visible
where the product lands on a part of the tone curve that still has slope, and
0.45 was just above the line.** If you author a subtle map for an emitter whose
intensity another system owns, you are authoring against a curve you have to go
and read first.

Verified against a forced-off control on the same bundle (`?blens=0`), which is
the only way to tell a feature that is subtle from a feature that does nothing:
**45716 pixels differ (3.18% of frame), max channel-sum delta 512, mean delta over differing pixels 31.9.** The lens
edge now grades into the pan instead of ending on a hard step against the tile;
the control frame is copied into the round directory as `interior-lensoff.png` so the pair sits on one bundle.

Note the clipped fraction did **not** fall, and that is intended. A fluorescent
lens photographed at an exposure set for a dawn interior does blow out; the
unphysical part was the flatness and the hard edge, not the clipping.

While here: the troffer lens and the exterior wall-pack lens shared one material
instance. `lightInterior` matches both mesh names in one branch and dedupes by
material, so a single write drove both, and the moment either wanted to differ
one would have silently followed the other — NOTES case 40's shape, one
property, two owners. The troffer now has its own instance. Nothing about the
wall pack changed.

### The shelf slabs — not done

Third of three and untouched. Reporting it rather than claiming it.

## For Lighting

1. **Troffers put no light on the ceiling they are set into.** The pan interior
   returns and the tile around each fitting are unlit, which is what produces
   the hard edge the critic named. The `RectAreaLight` sits at the lens plane
   aiming down, so nothing reaches the surrounding grid.
2. **The sky moved again.** `front` sky 81.2 → 117.0 and `corner` 120.5 → 147.9
   between the last two rounds with no Building change. `front` near-black is
   0.02% and `corner` 0.06%, against the 2.67% that forced the base-course lift.
3. **The PCSS patch is failing.** `contact-hardening patch failed to install
   (pcss: BASIC branch not found)` on every pose of rounds `2026-08-28T231039Z-YGSZe_lY` and
   `2026-08-28T232335Z-DbUOTurA`, which the harness correctly marked untrustworthy. Not mine, but
   it means any shading comparison against those two rounds is void.

## Queue state

- Poster — **done, verified in pixels.**
- Troffer lens — **done, verified against a forced-off control on one bundle.**
- Shelf slabs — not started.
- Base-course lift — temporary, doubly provisional, revert on Lighting's word.
- 89 px masonry repeat — deferred while `buildingCoursing.ts` is under audit.
- Fresnel mirror regime — needs the walk probe; no fixed pose reaches 78°.

## Shared tooling written here

Both take **no coordinates from the caller** and both carry a `--selftest` with
a positive and a negative control. Neither is masonry- or glazing-specific and
both are worth running as gates over any system's rounds, not on suspicion:

- `tools/probe-zeroscan.mjs` — clamped-to-black regions, found by distribution
  rather than by location. A region written as exact zero with an empty tail
  just above it is a shading failure anywhere it appears.
- `tools/probe-period.mjs` — visible repetition, by sweeping every lag from 2 to
  160 px on both axes in every horizontal band. A tiling texture betraying its
  tile is a whole-project failure mode, and this is the tool that reconciled a
  critic's "repeats every few blocks" with a correlation test that had measured
  −0.09 and found nothing. See NOTES case 41 for why both were right.

---

# Handover 9 — Player's veil, and the base-course lift retired

Round `2026-08-28T234311Z-ldsqiSjD`, seven poses, **no harness failures** —
Lighting's PCSS patch is fixed. Control round `2026-08-28T235106Z-ldsqiSjD`
carries `door-tinted.png` and `front-tinted.png` off the same bundle via
`?bglabs=0`.

## The base-course lift is gone

Reverted `cmuBase` from `0x928b7c` to `0x6a6659`. Lighting has settled the
ambient at sun 4.4 and environment 2.4, and this round measures **`corner`
near-black 0.04% and `base` 0.02%** against the 2% gate that the lift existed to
clear at 2.67%. Nothing was built on it and nothing was re-tuned against it, so
it came out in one line. The comment at that site is kept, with the value
reverted, because the reusable part is the shape and not the number: a
compensation for another system's defect is only safe while it is still
recognisable as one.

## Player's milky veil — fixed, and it is the other half of case 39

Player traced the wash to `storefront-glass` rather than to lighting, by
suppressing one layer at a time. **Its diagnosis was right and its leading
hypothesis was wrong by zero** — the additive reflection leaves cost nothing in
its table, which exonerates the architecture from handover 6 and convicts the
constant it left behind.

First, the check Player asked for. **Fresnel had not already fixed this**, and it
made head-on marginally worse: at normal incidence `F = 0.043`, so
`a` went 0.24 → 0.2725 and the veil term `tint * a` went 0.240 → 0.230. Player's
frames do not predate the effect in any way that matters.

The cause. Alpha blending gives `bg * (1 - a) + tint * a`, and those are two
different physical quantities: `1 - a` is **transmittance**, `tint * a` is a
**veil added on top**. Glass has the first and does not have the second. With a
non-black diffuse the veil put a constant floor under every pixel behind the
glazing, and it could not be tuned out — shrinking `opacity` to reduce the veil
also stopped the pane attenuating anything.

**Setting the diffuse to black collapses alpha blending to `bg * (1 - a)`.** Pure
transmittance, and a black point preserved exactly because zero times anything is
zero. This is the same move as the reflection leaf in the other direction: that
one has black diffuse so *additive* blending can only carry reflection, this one
has black diffuse so *alpha* blending can only carry transmission. **Each blend
mode expresses exactly one physical process once the term it cannot express is
removed from it.** Fresnel needed no change — it raises `a` toward grazing, which
is now unambiguously more attenuation.

`opacity` re-derived in its new single meaning: 0.055 outer over 0.035 inner,
combined transmittance **0.912 against 0.661**. Cooler doors 0.3 → 0.2, which
survives at near its old magnitude because a low-e triple unit really does hold
back a fifth of the light — that one always was a transmittance claim.
`storefront-grime` 0.9 → 0.45; the map is untouched and was never the problem,
but unlike the pane this layer legitimately *is* a veil (scattered dust does add
light) so it cannot be solved by blackening a diffuse, only by being smaller.

**A note for case 39 that I owe it.** It says to keep the number identical across
an architectural separation so the architecture can be told from the tuning, and
that was right. What it does not say, and now does, is that **keeping it
identical is the first of two steps — the value then has to be re-derived in its
new single meaning.** I did the separation last round, kept 0.24, and never went
back. That is how a fixed architecture keeps a broken value, and it is worse than
not separating, because the separation makes the number look considered.

### Measured, on the glazing footprint recovered from the A/B rather than chosen

Any pixel the tint change moved is a pixel seen through a pane, so the region is
derived and not hand-placed:

| pose | footprint | | black point | range | over 224 |
| --- | --- | --- | --- | --- | --- |
| `door` | 802921 px, 55.8% | tinted veil | 87 | 167 | 11.8% |
| | | absorption only | **48** | **188** | 2.6% |
| `front` | 35083 px, 2.4% | tinted veil | 84 | 143 | 0.3% |
| | | absorption only | **46** | **174** | 0.1% |

Black point down 39 and range up 21 on `door`, matching Player's direction and
close to its magnitude for a different camera. Visibly, the cooler doors stop
reading as glowing white panels and show shelves and stock through them.

**One warning about the metric, for Player.** `over 224` fell. That is not a
regression, it is the veil being a *bright* constant: pixels the wash had pushed
past 224 are no longer there, so **the defect was manufacturing highlights and
partly satisfying the metric that was measuring it.** Black point and range moved
monotonically with the fix; `over 224` did not, and in Player's camera it moved
the other way. Score this on black point and range.

Cost: **zero.** No new materials, textures, draw calls or triangles — draw calls
are unchanged pose for pose and building texture memory is flat at 98.16 MB.

## Shelf slabs — CPU-verified analysis only, no change made

Terrain's slope test, applied before touching anything, and it says the obvious
fix would not have worked.

The gondola spine was already rebuilt into 48 mm uprights at 914 mm centres with
the panel set back. Relief is 16 mm each side against a half-spacing of 457 mm,
so **characteristic slope 0.035 against a solar tangent of 0.109** — a fifth of
what the sun could pick up. But that is the wrong comparison indoors, and the
right one is worse: **the interior light is overhead, and every face this relief
creates is vertical.** The uprights' sides point along X, the panel along Z, both
plumb, so under a near-vertical source they differ in azimuth only and receive
the same near-zero cosine. The relief is oriented for a horizontal light and lit
by a vertical one.

So the term goes somewhere else. What works under a ceiling is an **up-facing
return** — a horizontal reveal, a shelf nose, a proud rail — which is exactly
what the cooler end return found on its own evidence and what the shelf decks
already have. Adding more vertical relief to the spine would buy roughly nothing,
and roughly nothing is the dangerous outcome: a 10% gain is the size that ends an
investigation early. Where the term goes matters more than whether it is there.

## Queue state

- Glazing absorption/veil separation — **done, verified against a same-bundle
  control, zero cost.** Player to re-verify on its camera and its metric.
- Base-course lift — **retired.**
- Shelf slabs — analysed, not built. Horizontal up-facing returns, not more
  vertical relief.
- Fresnel mirror regime — Player's walk probe on the door approach; no fixed pose
  here exceeds about 65° and Schlick needs about 78°.
- 89 px masonry repeat — still deferred pending the `buildingCoursing.ts` audit.


---

# Handover 10 — shelf returns, and Terrain's accumulation field

Rounds: **`2026-08-29T001002Z-C_7pwsrc`** (treatment 1, five poses, all gates
passing) with controls `2026-08-29T001604Z-C_7pwsrc` (`?bgret=0`) and
`2026-08-29T002249Z-C_7pwsrc` (`?bgaccum=0`); then
**`2026-08-29T002902Z-DgQHgiHu`** (treatment 2, three poses, all gates passing).
Two new debug flags, both hard-failing on a non-numeric value: **`?bgret=0`**
removes the shelving's up-facing returns, **`?bgaccum=0`** forces the wall base
back to the locally authored model.

Cost: **building texture memory unchanged at 98.16 MB**, +2 textures and +2 draw
calls on the `interior` pose, +2.7 MB scene-wide (not the building's). The accum
lookup is 128 squared, 65 kB, and rounds to nothing.

## 1. Shelf returns — and the correction that mattered more than the build

The analysis in Handover 9 was right and incomplete, and the incomplete half cost
a round. Four horizontal rails went across the gondola back panel, correctly
oriented for an overhead light. Against the `?bgret=0` control they moved **1,034
pixels, 0.07% of frame**, lifting their own rows by **+2.3 luma on a mean of
108** — right sign, right place, negligible.

**An up-facing face still needs something above it to face.** Each rail sits
320 mm under the next shelf, which projects 500 mm out over it. The unobstructed
wedge from the rail's top face runs from the horizon to `atan(320/500)` = 32.6°
and forward only, which cosine-weighted is about **7% of a hemisphere**. That is
Canopy's soffit finding in miniature: a shelf is a downlight for everything
beneath it, and raising the light would not have helped.

The one place on a gondola with an open view of the ceiling is the **top capping
edge**. Moving the same idea there, with a pressed-steel cap and an upstand at
each edge, changed **5.74% of the interior frame at a mean delta of 74.9, split
40,027 brighter to 42,674 darker** — the signature of relief, a lit top face and a
shadowed underside — and the pose's lower-third rose 98.0 to 100.2, which the
back-panel rails never moved at all. Same material, same light, **80 times the
footprint**, and the only difference is what the face can see. The back rails are
kept because a real gondola back has them and they cost 12 triangles each, but
they are not the fix and must not be credited as one.

`NOTES.md` now carries both halves as the indoor corollary to Terrain's slope
rule: does the relief create faces that differ along the light's *dominant* axis,
**and what fraction of the sky can each of those faces see**.

### Still open, and now visible rather than inferred

The crop shows the far gondola still reading as a **dark blue-grey slab** against
a warm cream wall, with the left-hand run pale and well lit two metres away. My
earlier claim that the albedo was fine because `fixture` is 0xa9a69c is **not
supported by the picture** — whatever that face is receiving, it is not what a
pale putty-grey panel under a lit ceiling should receive. This is the next thing
to measure, and it is a light-transport question about the aisle rather than a
material one: the troffers are flush to the ceiling, so an aisle face sees only
the narrow strip of ceiling between two units. Do not tune the albedo up to
compensate — that is exactly the class of compensation this file spent last night
retiring.

## 2. Terrain's `groundAccum`, consumed — with one real correction

`bakeAccumField` samples `fines(x, z)` over the footprint plus a 2 m skirt into a
128-square `NoColorSpace` DataTexture, and `applyBuildingWeather` now takes
`accumField` / `accumRect` / `windDir` together — half-supplied throws, and a
missing service pushes to `__SYSTEM_ERRORS` rather than falling back quietly. The
base band's envelope is now `groundAccum.wallBase()`'s to the digit: 180 mm
e-folding off grade, `0.55 + 0.45` on the windward face, plus the **drift** term,
which lives only in the bottom 90 mm and prefers the *sheltered* face — the tight
line at grade itself, and the part no wall-only model can produce.

**The first attempt made the wall cleaner.** Consuming `fines` as a bare
multiplier, exactly as its own documentation suggests, measured a **mean delta of
5.3 luma in the cleaning direction**. A CPU probe over the elevation found why:
`fines` measures **0.11–0.21 along the front and 0.013–0.047 behind the
building**, because the field's `(1 - swept * 0.85)` term correctly reports that a
forecourt is swept by tyres and feet. **The range of a published field is part of
its contract**, and a bare multiply assumes it is 0..1 and centred. Composed as
`mix(0.5, 1.35, clamp(fines / 0.22, 0, 1))` — a floor plus a gain, since rain
bounces off swept paving just as hard and what varies is what it lifts — the same
change measured **6.95% of the base frame with 95,174 of 100,148 changed pixels
darker**, monotonic in the intended direction. `NOTES.md` case 44.

Wind resolves to `(-0.971, +0.239)`, so the east elevation is strongly windward
(facing 0.97), the front mildly so (0.24) and the west is in the lee. The dirt
line now varies across elevations for a reason, and it varies with the ground.

### What this did not fix, and cannot

The critic's "**solid black band with an abrupt horizontal top edge**" is only
half addressed. The vertical profile of the change is a broad 0.4–1.0 luma
darkening, not a hard new line, and the abrupt top edge is **a material boundary**
— `cmuBase` at 0x6a6659 meeting `cmuExt` — not a weathering boundary. No band
term inside either material can soften a discontinuity between them. The next
move there is geometric or a shared transition, not a stronger band.

## Queue state

- Shelf returns — **built and verified in pixels**, with the sky-access
  correction. The dark aisle face is a separate, open, light-transport question.
- Wall base on `groundAccum` — **built and verified in pixels**, with the field
  range corrected. The abrupt `cmuBase`/`cmuExt` seam is still open and is not a
  weathering problem.
- 89 px masonry repeat — still deferred pending the `buildingCoursing.ts` audit.
- Interior products against the corrected ambient — not started.
- Fresnel mirror regime — Player's walk probe.


---

# Handover 11 — the handheld bottle

Round **`2026-08-29T010725Z-DuaNA-Gu`** is the one to look at, `bottle.png` with
`?bgheld=1`. Gates pass on every capture in the sequence, **near-black 0.00% on
every bottle frame**, which is the check that matters most here because two of the
four leaves are transmissive and an uninitialised transmission target reads as
exactly black — this system has had that failure once already.

Earlier rounds in the sequence, kept because the progression is the argument:
`2026-08-29T004605Z-Bef4RmAE` (bottle invisible behind the shelf stock),
`2026-08-29T005627Z-M3GYSGsj` (visible, seam framed dead centre, milky through
the cooler glass).

## What it is now

`src/gen/buildingHeroBottle.ts`, new, and `buildingBottle` is untouched — the
shelf lathe is *correct* for the cooler, where a bottle delivers about 40 px and
16 segments is more than the pixels can use. Widening its budget would have cost
two hundred bottles to improve one. **The handheld bottle is the only object in
this project that gets inspected rather than glanced at**, so it is a separate
object at a separate budget: 64 segments, a blow-moulded shoulder sampled at 9
points, a neck finish with a support ring, and a moulded closure with 26 flutes
built by hand because flutes are radial and a lathe is radially uniform.

**Four leaves, one physical process each** — the compositing rule the glazing
produced, applied deliberately from the start instead of found by measurement:

| leaf | is | must not |
| --- | --- | --- |
| `shell` | PET wall, transmission 1, ior 1.5, attenuating over 0.35 m | carry print or any diffuse colour |
| `liquid` | contents, transmission 0.94 at ior 1.333, with a meniscus | pretend to be the container |
| `label` | printed sleeve, opaque film 0.4 mm proud, its own edges | be transmissive |
| `cap` | closure, own colour and roughness | share the shell's material |

The old single material had to be container, contents and print at once, and that
arithmetic is why it read as a tinted solid: a drink colour multiplied into the
surface that was also printing the label took a white label to 14/255. Splitting
them is not extra work, it is the only arrangement in which any of the four
numbers means anything.

## Two poses and a flag, because the inspection has to match delivery

- **`bottle` shot pose**, new, stands at **0.44 m — `InteractionSystem`'s own
  `HAND_OFFSET` distance** — with a 34 degree vertical field. At 1600 x 900 that
  delivers the bottle at **824 x 253 px**, which is the real budget the label is
  authored against. No previous pose came within two metres of this object, which
  is why the one thing that gets inspected was the one thing nobody here had
  looked at; the critic found it in Player's frames instead.
- **`?bgheld=1`** stands it in open air at hand height instead of on its shelf.
  Not a convenience: from the shelf you are looking *through a cooler door* —
  glass, condensation, emissive liner — and that capture came back milky at sky
  155.8 washing toward white. None of that is present in the hand. The cooler is
  1.16 m deep and the pose needs 0.44 m, so no camera position is both the right
  distance and inside the cabinet.
- **`GRAB_BOTTLE`** is now a fixed, documented position and the stock loop leaves
  it a clear facing. Player is aiming a video at this object and two agents
  cannot both point at an rng-placed spot. The first capture proved why: the
  bottle was behind a green can and the pose measured nothing.

## The label, and the third term in the resolution rule

768 x 384 wrapping a 0.22 m circumference at 0.1 m tall, **+1.50 MB** on the
building's texture total (98.16 to 99.66 MB), exactly as budgeted. It is not an
atlas cell because the delivered budget here is 410 px of label height against 23
for a cooler facing.

Masthead and descriptor get **real letterforms** (126 and 49 delivered px);
everything below gets **ruled lines** (16 px), which is the honest side of the
boundary — a glyph smear reads as a texture bug where a rule reads as small print.

Two new findings, both in `NOTES.md` beside the per-element rule:

- **On a curved surface the delivered pixels are not evenly distributed across
  the artwork.** A wrap shows 180 degrees but only the middle 120 is legible, so
  the readable width is about a *third* of the circumference. "CLEARSPRING" at
  0.86 of the panel delivered as "PRING"; at 0.56 it delivered whole, same
  texture, same distance, nothing else changed.
- **`CylinderGeometry` lays `u = 0` on +Z, so `u = 0.5` lands on -Z** — a camera
  looking from -Z frames the seam of a full wrap dead centre, which is exactly
  what the second capture did. An atlas cell on a box has no orientation to get
  wrong; the first object whose artwork has a front is the first place this bites.

## Cost

Four draw calls and about 5.2 k triangles for the hero object, plus 1.50 MB of
label. Deliberate, and the right way round: roughly two hundred shelf bottles
share one atlas cell each on one merged mesh, and the budget goes to the object
the camera is pressed against.

## Honest remainder on the bottle

- The front panel is **mostly empty white below "500 mL"**. A real label fills
  more of it. Cheap to fix, not fixed.
- The contents read **dark and slightly olive** rather than like water, because at
  transmission 0.94 they are showing the shelf behind them. Physically that is
  what a clear bottle does; whether it reads as *water* is worth a second look
  with Player once the approach shot exists.
- Nothing here has been seen at **grazing incidence**, which is where the shell's
  Fresnel will matter and which only Player's walk can reach.

## Two inbound, answered

- **`hash1`: no call sites in this system.** `buildingWeather.ts` uses its own
  `bwHash` on integer indices only — cap-section and drip-source indices — where a
  bare hash is the correct primitive and no wavelength is being claimed. Nothing
  in `buildingCoursing.ts`, `buildingProps.ts`, `buildingSignage.ts` or
  `BuildingSystem.ts` imports it. Nothing to audit here.
- **Car's `building/cooler-stock` occlusion regression** is not investigated and
  is the first thing the next session should pick up. The plausible cause is
  mine: this session cleared a facing in the cooler stock loop for the hero
  bottle and replaced the grabbable with a four-leaf group, both of which change
  that mesh's contents. `?bgheld=1` also moves an object out of the cabinet, so
  check which flag the gate ran under before concluding.

## Queue state

- Handheld bottle — **built and verified in pixels at the delivered distance.**
  Label content, cap flutes, support ring, shoulder and transmission all read.
- Aisle light transport, jointly with Lighting — not started, and now has three
  independent instances behind it (Canopy's soffit, Lighting's single-point
  interior probe, this building's aisle faces).
- Interior products against the corrected ambient — not started.
- 89 px masonry repeat — still pending the `buildingCoursing.ts` audit.

# Handover 12 — the store could not be walked into, and the probe that found the gate

Round `2026-08-29T025829Z-C5fsBPir`, all eight poses, all health-gated, RTX 4060
verified from the live context. Port 5112 clear.

## The deliverable blocker: fixed, and confirmed on foot

Perf's finding was that the cooler doors and the grab bottle cannot be reached by
a walking player — two of the three interactions the brief specifies — and that
the back of the store opened at a body radius of 0.30 m against `PlayerSystem`'s
0.32, so one obstruction about 40 mm too narrow.

**The gate is the impulse island in front of the counter**, and it was mine. It is
1.20 m deep, sitting in the 2.30 m slot between the front wall and the first
gondola, and it started at `x = -0.4` — 0.6 m east of the gondola line's east end
at −1.0. That left a 0.60 m slot beside it, too narrow for a 0.64 m body, so the
only route into the store ran *round its east end*, through a 0.80 m gap to the
south and a 0.82 m gap to the north. Both give 0.40 m of clearance: a 160 mm
window to thread, twice, to get anywhere at all.

Moved to `x = 0.15…1.95`, which opens a straight **1.15 m** corridor at
x −1.0…0.15 from the door to the back of the store, and which is also where an
impulse island belongs relative to a counter at x 0.47…3.18. Both the geometry
and the collision rect now come from one `ISLAND` constant; they were two
hand-copied literals, which for the single obstruction that decides whether the
interior is walkable is not a risk worth carrying.

After the move the tightest gate to every interior target is **the doorway
itself** at 0.528 m of clearance, +208 mm on the body radius — which is the right
answer for a building, since the door should be the narrowest thing you pass
through.

Then the walked confirmation, driving the real controller from the spawn the game
chose, with `PlayerSystem`'s own radius, portal narrowing and least-movement
slide:

| step | result |
|---|---|
| walk spawn → cooler | **arrived**, 184/184 legs, no stall |
| entry door on the way | opened, `door:entry-door` at 1.33 m |
| stand | 1.85 m from the cooler door, **0.63 m** from the bottle |
| cooler door | `cooler:cooler-door-3` on the crosshair at 1.79 m |
| open cooler | `cooler:cooler-door-2` clicked |
| take bottle | **`bottle:"building-grab-bottle"` at 1.26 m** |

So the whole specified sequence completes on foot, not from a preset.

## `tools/probe-reach.mjs` — shared tooling, and why it is not a flood fill

Perf's flood fill and my first measurement disagreed, and both were right. A
flood tests whether a **cell centre** is free, so its answer moves with the grid
pitch; the 0.80 m gap admits the body through a 0.16 m window, and whether a
centre lands in that window is a matter of phase. The pitch-independent question
is a **widest path**: build a clearance field, then find the route whose narrowest
point is widest. One number per target — the tightest gap on the best route —
which makes the radius sweep free (reachable at *r* is bottleneck > *r*) and
names the gate, by walking the parent pointers back to the cell that set the
bottleneck and reporting the two nearest blockers with their owning service key.

Any agent can use it; it reads every `*.blockers` service from the live registry
and takes no rectangle from the operator. Full write-up in `NOTES.md` case 52,
including the two traps that produced confident wrong answers first — reach
without a sight-line test measures a distance rather than an interaction, and the
blocker containing the target has to be excluded from that test or anything inside
a cabinet is unreachable by construction.

## The near-miss worth reading: case 53

The walk reported the crosshair on the cooler door leaf rather than the bottle,
and I chased it through four workarounds — wait for the swing, step back,
sidestep, sidestep further — each of which suggested a specific, physical,
plausible cause. By the second I had a defect ready to file with arithmetic
behind it: a 0.875 m leaf swinging into a 1.09 m aisle cannot clear a 0.64 m
body. Two numbers I own, a real relationship between them.

It was not the cause. The probe aimed at `eyeHeight + 0.15` = 1.80 m at a bottle
sitting at **0.65 m**. Every reading was a ray passing 1.15 m over the target.
Corrected, the interaction completed first try, and there is no door-swing defect.

**When a probe reports an obstruction, the next test is a positive control, not a
better workaround.** There was no known-good case anywhere in that sequence. Note
how it evaded the existing "failed twice the same way, question the premise" rule:
it failed four times the same way while *appearing* to fail differently, because
each workaround changed the number in the report. The invariant — the crosshair
never once named the target — was constant from the first attempt.

## `building/cooler-stock` SEEN → OCCLUDED: reproduced, and not a delivery defect

Car's gate flagged it and it reproduces in the current tree: `probe-unseen`
reports `building/cooler-stock` at 0 px, 2305 px when forced, so OCCLUDED by its
own definition. Not a flag artefact.

It is a probe-camera artefact for this particular mesh. `cooler-stock` is a
single merged bank 7 m long and 218,176 triangles with no mean shading normal, so
`probe-unseen` judges it from six axes at a distance that fits its bounding
sphere — every one of which is outside the cabinet and mostly outside the
building. In the judged `cooler` pose the stock is plainly there: rows of
labelled bottles on every shelf through the glass. Routing back to Car as
**visible in delivery, silent in the probe's own best-case view**; the documented
limitation this falls under is the tool's own "a mesh pixel-for-pixel identical to
whatever is behind it" family, extended to a mesh with no camera that can see it.

Worth noting separately for the performance agent: 218 k triangles in one merged
mesh that is only ever seen through eight glass doors.

## Two things for other owners

- **~~`PlayerSystem`'s strafe is inverted.~~ RETRACTED. The strafe is correct.**
  See below — this was the second instance in one round of a real measurement
  whose interpretation named the wrong cause, and it was settled by a control
  rather than by a second derivation.
- `hash1` audit (Terrain): checked, and this system has **no call sites**.
  `buildingWeather.ts` uses its own `bwHash` on integer indices only, so nothing
  here claims a wavelength that does not exist. No action.

## Queue state

- Reachability — **fixed and confirmed by walking**, not by a preset.
- `cooler-stock` regression — **reproduced and explained**; no change made,
  routed back to Car.
- Winding audit — `probe-unseen` reports **no winding failures** across the
  filtered runs it did tonight, including all cooler and stock meshes. Awaiting
  Vegetation's scene-wide per-triangle detector for the authoritative list.
- Aisle light transport, jointly with Lighting — not started; three independent
  instances behind it now.
- Interior products against the corrected ambient — not started. The island move
  changes what the `interior` pose frames, so re-look after it.
- The empty front panel below "500 mL", and the contents reading olive at
  transmission 0.94 — not started.
- 89 px masonry repeat — still pending the `buildingCoursing.ts` audit.

## Retraction: the strafe is correct, and this is case 53 twice in one round

I reported `PlayerSystem`'s strafe as inverted. It is not. The claim rested on
one observation — facing +Z, `KeyD` moved the camera west — plus an assertion
that the right of a viewer facing +Z is +X. That assertion is the error. With X
and Y fixed, right-handedness requires `right × up = −forward`, and for
`forward = +Z` that gives `right = −X`. `(−1,0,0) × (0,1,0) = (0,0,−1) = −forward`
checks; `(1,0,0) × (0,1,0) = (0,0,1) = +forward` does not. So
`_right.crossVectors(_fwd, _UP)` is the correct right vector, my measurement was
correct behaviour, and only the interpretation was wrong.

Settled by a positive control rather than a third desk derivation, because a desk
derivation is what produced the error and is not a control. The control stops
naming axes altogether: **column 0 of `camera.matrixWorld` is the camera's right
in world space**, so projecting the displacement onto it answers the only question
a player has, from any facing, with no convention available to get wrong.

| facing | key | world Δ(x, z) | camera right | along right | |
|---|---|---|---|---|---|
| +Z | `KeyD` | (−2.619, 0.315) | (−1, 0) | **+2.619** | correct |
| +Z | `KeyA` | (2.484, 0.282) | (−1, 0) | −2.484 | correct |
| −Z | `KeyD` | (0.777, −0.022) | (1, 0) | **+0.777** | correct |
| −Z | `KeyA` | (−0.764, −0.020) | (1, 0) | −0.764 | correct |
| +X | `KeyD` | (0.064, 1.257) | (0, 1) | **+1.257** | correct |
| +X | `KeyA` | (0.080, −1.385) | (0, 1) | −1.385 | correct |
| −X | `KeyD` | (−0.052, −1.134) | (0, −1) | **+1.134** | correct |
| −X | `KeyA` | (−0.048, 1.103) | (0, −1) | −1.103 | correct |

Eight for eight. The control now runs as `node tools/probe-reach.mjs --strafe`
and lives in the harness that made the error, which is where a control belongs.

Note the row that would have misled anyone reading a single line: facing +Z,
`KeyD` moves −2.619 in x. Read as a world displacement that is "west". Read
against the camera's own basis it is +2.619 to the right. **Same number, opposite
conclusion, and only one of the two readings is about the player.**

And the generalisation this forces on the existing rule: a round that fails twice
the same way should have its premise questioned, but the bottle probe failed
**four** times the same way while appearing to fail differently, because each
workaround changed the number in the report. **The rule has to key on the
invariant, not on the number** — there, the crosshair never once named the
target, constant from the first attempt; here, `alongCameraRight` was never once
measured before the report went out.

## Routed out with the numbers each owner needs

**To Perf** — `building/cooler-stock`: one merged mesh, **218,176 triangles**,
visible only through eight glass doors of a cooler that is itself only in frame
from inside the store. Building's share of texture memory in the same round is
**99.66 MB of 387.44 MB** total; the round's interior poses run 466–576 draw
calls. Relevant to VRAM headroom and continuous-frametime pricing for the video.

**To Vegetation / whoever owns `probe-unseen`** — the `cooler-stock`
SEEN → OCCLUDED flip is a real limitation, adjacent to the instanced-scatter case
already in that file's header: a **single merged bank with no mean shading
normal** gets judged from six axes at bounding-sphere distance, and for a 7 m
bank inside a 1.16 m cabinet every one of those cameras is outside the cabinet and
mostly outside the building. Aiming at one instance rather than the scatter bound
fixes the scatter case; this one additionally needs the camera to be allowed
*inside* the mesh's own bound. The stock is plainly visible in the judged `cooler`
pose, so nothing in the scene needs changing.

## The interior as a photograph, and two measurements that came out of it

Rounds `2026-08-29T034227Z-BjYrE4qm` (default), `…034833Z…` (`?bgao=0`),
`…035439Z…` (`?bglrefl=0`), `…040009Z-BE5QejCd` (reflection at 1.0).

New tool, `tools/probe-shelfshade.mjs`, shared: it takes no rectangles and reports
the luma percentile ladder plus the **asymmetry of vertical local contrast** —
for every pixel, the signed difference to the pixel a shelf-lip above it.
Directional shading produces dark bands under horizontal edges and so an
asymmetric distribution; albedo detail alone produces a symmetric one. It needed a
positive control before I would trust it, per case 53, and the exterior poses
supply one: 1.05–1.24x wherever the sun reaches.

**The interior reads 0.99x, the only frame in the set below 1.0**, with a 1st
percentile of luma 56 and 0.01% of pixels under 32. That is the measurement behind
the critic's "solid-colour boxes" and "plain grey slabs": the interior is lit by a
constant. It also reads *brighter* than the dawn exterior — `door` p50 181 against
`front` p50 82 — so the brief's "contrast of sunlight when the door opens" is
currently inverted. The level is Lighting's; the shading is shared.

### Attempt: slot-access shading, baked per vertex. A negative result.

`shadeBySlotAccess` in `buildingProps.ts` multiplies each shelf item's vertex
colour by the angular extent of its own slot mouth, so back corners go dark and
the front lip stays bright, plus a contact term at the deck. Deliberately *not*
"how much ceiling can it see", whose honest answer inside a gondola slot is nearly
zero — that would render every shelf black, and the missing energy is aisle bounce,
which is Lighting's term.

A/B'd with `?bgao=0` on the identical bundle: under-32 moved 0.01% → 0.03%
(`door`), 5.88% → 6.16% (`interior`), 1.39% → 1.56% (`cooler`); asymmetry
unchanged. **Bound, correct, visually indistinguishable.**

The reason is the finding: **an occlusion term baked into an object darkens the
faces pointing away from the opening, and those are the faces the camera cannot
see.** What reads as shading on a shelf is the shadow cast *on the deck, on the
underside of the shelf above, and on the neighbours* — fitting geometry, merged
into a material with no vertex colours. That is where the next attempt goes, and
it is a bigger change than this was. Kept, defaulting on, because it is free at
runtime and physically right; not kept as a fix. `NOTES.md` case 56.

### Attempt: the reflection constant. Small, correct, and a better lesson.

All three glass leaves carried `envMapIntensity` 1.25, and the file's own comment
already flagged it as suspect. Player had tested that architecture properly and
found the storefront's additive passes worth **exactly zero** — correct, and it
exonerated the compositing while leaving the constant unexamined.

Measured on the cooler with `?bglrefl=0`: the same leaves are worth **p75 191 →
163, over-224 halved from 6.51% to 3.89%.** Nothing about the constant differs;
what differs is what the pane reflects. A shopfront at dawn reflects a dim
exterior; a cooler door reflects the lit interior, which became bright and
structured the moment the world capture was promoted. **The instance that got
measured was the instance where the parameter could do the least.** `NOTES.md`
case 55.

Set to 1.0, which is what `ior` 1.52 and the BRDF's own Fresnel already give;
there was never a physical basis for the boost. Verified by arithmetic as well as
by pixels: removing 20% of a leaf worth 28 luma at p75 should recover about 5.6,
and it recovered 4 (191 → 187). `door` over-224 12.39% → 11.83%. `?bglrefl` still
scales all three for the A/B.

### What the frames say is left, in order of how much they cost the photograph

1. **No shadow anywhere in the interior.** The 0.99x asymmetry is the whole story
   and it is a light-transport problem, jointly Lighting's. Do not model it twice.
2. **The interior is brighter than the exterior it is meant to contrast with.**
   Lighting's level, but it is Building's brief item, so worth carrying to them
   with the p50 181-against-82 figure.
3. **The cooler glass is still a bright veil** after the constant came down. The
   remainder is the condensation decal and the emissive liner (`cooler-lamp-tube`,
   Lighting's) rather than the tint, which is already absorption-only.
4. **The gondola ends and the shelf decks are flat grey slabs** — the fitting
   material, and per (1) they will stay flat until something casts on them.
5. The empty front panel below "500 mL", the olive contents at transmission 0.94,
   and the 89 px masonry repeat, all as before.

Not claimed: that any of the above is fixed, that the interior reads as a
photograph, or that the slot-access term helps.

## Handover 13: the shop is crossable, and the close beat is on a knife edge

Round `2026-08-29T045056Z-Cu0llQJX` for the look; the reachability work is
`tools/probe-reach.mjs`, run five times.

### The crossing: fixed, and the diagnosis was in a different place than expected

`GONDOLA_X.x0` moved from −8.2 to **−7.55**, one constant serving both the
geometry and the blocker, which opens the west corridor from 0.70 m to 1.35 m.

But the premise it was given under does not survive measurement, and the
correction matters more than the fix. There was **no topological blockage**: the
direct interior route existed the whole time. What was wrong with it was margin.
`probe-reach.mjs` now runs a second search — a **clearance-constrained shortest
path** beside the widest path — because a widest path maximises its tightest gap
and therefore *prefers a wide detour to a narrow shortcut*. It cannot answer "what
would a player walk", and the 151-m-for-37-m detour it reported was a fact about
max-min Dijkstra, not about the shop.

| | before | after |
|---|---|---|
| widest-path bottleneck | 0.528 m (doorway) | 0.528 m (doorway) |
| **direct route tightest** | **0.333 m = 13 mm** | 0.330 m = 10 mm |
| direct route, door → cooler | stalled at the jamb | **7.67 m for 7.06 m straight, 1.09x** |
| walked | STALLED 44/55 legs | **arrived 55/55** |

The tightest cell barely moved and the outcome inverted, which is the finding: a
13 mm margin at a door *jamb* stalls the controller, a 10 mm margin at an outside
*corner* does not, because a corner-cut has open space either side. **Report the
margin on the direct route, not the existence of a route.** `NOTES.md` case 57.

The shelving is 0.65 m shorter per run and the `door` pose still reads full — the
critic's ask was to protect the *density* seen through the glass, and the stocking
is untouched.

### The full sequence completes on foot, including the close

Walked, on the direct route, one continuous drive of the real controller:

- 55/55 legs, entry door opened once at 1.75 m
- cooler door 2 opened at 1.36 m
- walked to a **derived** stance, crosshair named `building-grab-bottle` with no
  search, **bottle taken at 1.19 m**
- **cooler closed from the same stance at 1.7 m, no stepping back**

That is the user's third interaction end to end for the first time.

### But the stance band is 220 mm, and that is the real form of the aisle problem

The close beat is not geometrically impossible, and the reason it looked that way
is that the band is too narrow to land on by choosing a round number. Two
constraints bracket it from opposite sides:

- gondola run B's north face at z 37.55, so a 0.32 m body cannot stand south of
  **37.87**
- an open cooler leaf sweeps z 38.09–38.64, so the same body cannot stand north of
  **38.09**

**Standable and clear of the leaf is z 37.87 … 38.09 — 220 mm.** My first derived
stance used 37.70, which reads as "clear of the leaf" and is in fact inside the
shelving.

And within that band it is a knife edge. Two runs from stances **10 mm apart**
gave opposite outcomes: at (−6.64, 37.98) the crosshair named the bottle and the
grab succeeded; at (−6.65, 37.97) it named `cooler-door-2` and the grab failed.
The ray to the bottle grazes the open leaf's edge. **For the film this is a real
risk, not a margin** — the beat will work or not depending on millimetres of
approach.

Widening the aisle is the fix, and it does not fit without a decision above me.
Pulling run B back in z cuts the A–B shopping aisle from 1.15 m to 0.50 m, and the
depth available — island north face ≈33.7 to cooler front 38.64, so 4.94 m —
cannot host two 1.2 m runs plus three usable aisles. The options are **one gondola
run instead of two**, or **narrower cooler leaves** (more doors, less sweep each).
Both change the look, so both want a call rather than a unilateral edit. Flagged,
not done.

### Three harness faults, all of which presented as shop defects

Worth reading before trusting any walk report, mine included. `NOTES.md` case 58.

1. It **re-clicked the entry door** — a toggle with no memory, so it opened, shut
   and then stalled against a door it had closed itself. Only a direct route
   lingers at the jamb long enough to re-probe, which is why a session of widest-
   path walks never showed it.
2. It **opened cooler doors it merely walked past**, leaving two leaves across the
   aisle, and the grab then failed. Indistinguishable from an aisle defect.
3. It **searched for a stance instead of deriving one** — sidestepping until the
   crosshair found the bottle, wandering five metres, four different numbers, one
   constant invariant. Case 53 a third time.

All three are fixed: doors are actuated only if named `entry`, only once, and the
grab stance is now computed from the two bracketing faces. A harness fault and a
scene fault present identically, and the only discriminator is whether the harness
did something to the scene it should not have — which is why every actuation is
logged with its object and distance.

### Note for whoever reads the round

`2026-08-29T045056Z-Cu0llQJX` is not comparable to earlier rounds for shading:
sky luma 117 against 187, 346 draw calls against 543, 74 programs against 162.
Lighting is mid-edit — `LightingSystem.ts(641,73)` does not compile as I write
this — so that round is good for layout and worthless for tone. My own shading
measurements above stand on the `034227Z` / `034833Z` pair.

---

# Handover 14 — headless construction, and the clipped-pixel routing

No GPU work in this session. The user is walking the build; the cooler captures
(`--shots=cooler --suffix=-leaf3`) are still owed and should be the first thing
run when the window opens. Nothing about that harness needs debugging — it was
killed deliberately.

## 1. `BuildingSystem` now constructs under Node

**Was:** `init` read `location.search`, then `buildMaterials → makeConcrete →
drawWrappedMask → document.createElement("canvas")`. Every CPU-side tool that
registered this system died, and a sibling harness worked around it with an
**empty blocker list** — which over-populated its lot interior without failing.

**Now:** two changes, and one new module.

- **`src/gen/buildingLayout.ts`** owns the plan: `PLAN`, `IN`, `COOLER`,
  `COUNTER`, `ISLAND`, `GONDOLA_X`, `GONDOLA_Z`, `GRAB_BOTTLE`, `HELD_BOTTLE`,
  plus `buildingBlockers()`, `buildingFloorHeight()` and `buildingFootprint()`.
  It imports `BUILDING` and `padY` from `site.ts` and nothing else. **It must stay
  free of `document`, `window`, `location` and THREE materials** — geometry
  helpers are fine, rasterisers are not.
- `BuildingSystem` **imports** that module rather than holding its own copies.
  There is no second set of literals; `finishedFloorLevel()`, `buildBlockers()`
  and the published footprint all delegate. This is the ISLAND rule applied to
  the whole plan.
- `init` takes a **layout-only path** when `typeof document === "undefined"`
  (`initLayoutOnly`). It publishes `building.headless`, `building.bounds`,
  `building.footprint`, `building.blockers`, `building.collide` and
  `building.floorHeight` — all real — and warns on the console.

**Deliberately not published on that path:** `building.entryDoor`,
`coolerDoors`, `coolerLightSlots`, `fluorescents`, `exteriorLight`,
`grabBottle`, `grabbables`, `interiorMaterials`, `root`. Each would have to be an
empty array, and **a consumer cannot tell "none in this build" from "none because
there is no canvas"** — that ambiguity is the whole bug. They are absent so
`require` throws in the tool that had no business needing them. Check
`building.headless` rather than inferring the mode from what is missing.

`dbg()` and the `q` in `init` now go through a `query()` helper that returns an
empty `URLSearchParams` when `location` is undefined.

### Tooling, shared

- **`tools/buildinglayout.mjs`** — the plan from Node. `--json` for machine use,
  `--system` additionally constructs `BuildingSystem` and runs a positive control
  on collision (a point inside the west wall must be pushed out; a point in the
  clear corridor must not move). **Consume `--json`; do not copy numbers.**
- **`tools/ts-resolve.mjs`** — an ESM resolve hook that appends the extension
  Vite would have. Node 22 strips types already but will not resolve
  extensionless relative specifiers, so importing anything from `src/` dies on
  the *second* hop and reads like a broken module. Use
  `node --import ./tools/ts-resolve.mjs <tool>`; `buildinglayout.mjs --system`
  re-execs itself with it. **Useful to every agent, not just this system.**

Verified: 12 blockers, floor 0.5739 m, system and module agree on the count,
collision behaves. `tsc` clean.

**Sibling action:** the `stubBuilding: true` path with the empty blocker list can
be deleted. Either register the real system (layout-only path takes over
automatically) or call `buildingBlockers()`.

## 2. The 721 clipped pixels — cannot be reproduced as routed, and what is actually clipping

`tmp/hotpx.mjs` plus a new **`tools/probe-clip.mjs`**, which groups clipped pixels
into connected clusters and reports each bounding box, aspect, fill and the mean
colour of the ring just outside it. `721 px` is one number that could be one lamp
or forty specks; the shape discriminates — compact high-fill is a source, thin
high-aspect is a specular on an edge, singles are aliasing.

### The routing does not land

`shots/film/frames/` **is empty**. Re-extracted frames 11 and 12 from
`dawn-station.mp4` (1600×900, 30 fps, 540 frames, so the coordinate frame is
unambiguous):

- **0 px at exactly (255,255,255)** in either frame — H.264 4:2:0 does not
  preserve exact channel values, so the mp4 cannot carry this measurement.
- x 470–640 in the lower third has a **maximum luma of 76**. An encode does not
  take 255 to 76 over 170 × 300 px.
- Frame 11 is **under the canopy looking at the pumps; the building is not in
  shot.** The brightest things in it are the canopy soffit luminaires at luma
  237–243, y ≈ 180–200 — Canopy's.

So the 721 px is real but was measured in frames that no longer exist. Written up
as `NOTES` case 69. **To close it I need either the PNG frames kept, or a frame
index into a file that still exists.**

### What is clipping, measured on the lossless stills that survived

| still | fully clipped | where |
| --- | --- | --- |
| `_v-grab.png` | **5750** | cooler interior, x 48–247 y 288–495 (3158 px) and x 272–375 y 530–619 |
| `_t95-door.png` | 521 | mullion x 1491–1505 y 310–339; push bar x 1481–1599 y 647–710 |
| `_v-pump.png` | 327 | pump housing edge x 484–499 y 296–327 — **Pumps', not mine** |
| `_v-door.png` | 197 | same mullion and push bar |
| `_v-cut.png`, `_peek.png` | 0 | — |

Every cluster is **neutral, in a surround already at 252–255**. Not a warm surface
railing red first: a region authored or lit to sit at the very top of the curve
with a few hundred pixels tipping over.

**The door frames are one material.** The mullion and the push bar are both
`this.mat.alu`, and `alu` was the only material in this file with
`envMapIntensity` **above 1.0** — 1.1, i.e. reflecting 110% of the environment in
front of it, authored while the uniform was inert (`NOTES` case 26). Third
instance of that pattern here. **Landed at 1.0**, labelled in the code as
CPU-verified only: the pixels are measured, the attribution to this constant is
not, because separating it from the reflected radiance needs an A/B. Profiling
down the band (y 160 → 560) shows the brightness peaks at y 260–360 rather than
running uniformly, so it is a specular lobe and not a flat env wash.

**The bigger number is the cooler, and it is the interior over-brightness already
routed to Lighting.** 5750 px in the grab frame — 8× the routed figure, in the
user's third specified interaction — is the white cooler liner and the stock
against it. `mat.coolerLiner` carries `emissiveIntensity: 0.22` with a comment I
wrote saying it was *"kept low so the liner does not blow out to paper white and
swallow the silhouettes of the bottles standing against it."* It is now
measurably doing exactly that. **Not tuned blind**: whether that is the liner's
own emissive, the interior ambient (my 0.99× asymmetry, p50 181 against 82) or
`tuneInteriorMaterials` overwriting a value needs one ablation, and that is GPU.

### Queue when the GPU window opens

1. `--shots=cooler --suffix=-leaf3` — the narrower-leaf captures, still owed.
2. Ablate `alu` 1.1 → 1.0 against the door approach. Note the `--ab=` harness has
   a **118 px noise floor**; 521 px should move clearly.
3. Ablate the cooler liner emissive against the interior ambient, **with
   Lighting**, since one of the two owns it and both change the same pixels.

---

# Handover 15 — the cooler liner decomposed, and it is not mine

Rounds: **`2026-08-29T055943Z-DbgQgsX3`** (liner and bounce arms) and
**`2026-08-29T060748Z-DP_qPeDs`** (lamp sweep, door). Cost unchanged throughout:
**566 draw calls, 6911k tris, 148 programs, 126 textures, 387.44 MB (building
99.66 MB)** on `cooler`; 472/144 on `grab`. **No new shader programs** — every
lever added this session scales an existing uniform or moves the camera, because
program count is now a first-load cost.

Running concurrently on the GPU: Film, the boot agent and Vegetation (22
node/chrome processes, listeners on 5119 and 5163 that are not mine). My port
5112 is clear.

## The finding: 91% of it is one Lighting-owned lever, and my term is inert

`grab` is a **new pose** (`src/gen/buildingShots.ts`) at the stance
`probe-reach.mjs` derives — x −6.6, z 37.87, aiming at the published
`GRAB_BOTTLE` — plus **`?bcoolopen=2`**, a new flag that swings the leaf a walked
player opens. It exists because no pose this system owned came within reach of
the defect, and *a defect measured only in another system's frames cannot be
A/B'd*.

One build, one browser, arms back to back. Pixels over luma 235, of 170,315:

| term | owner | effect |
| --- | --- | --- |
| liner `emissiveIntensity: 0.22` | **mine** | **+117 px (0.07%)** |
| `?ibounce=0.35` room bounce | Lighting | 1,341 px (0.8%) |
| `?lamp=0.5` | Lighting | −53,064 px (31%) |
| `?lamp=0.25` | Lighting | −155,821 px (91%) |

Fully-clipped pixels track it: `any channel at 255` goes **11,412 → 724 → 323**
across the lamp sweep, and is **identical to the pixel** between `?bliner=0` and
`?bliner=1`.

**My double-count hypothesis was wrong.** I predicted the emissive was a second
copy of the three `RectAreaLight`s at 7.0 that `lightInterior.ts` now aims into
the cabinet. It is worth 0.07%, because the liner sits on the flat top of the
tone curve where a small additive term has nowhere to go — case 42 from the other
side, written up as `NOTES` case 71.

**Retired anyway, at `emissiveIntensity: 0.22 * 0`**, with the measurement beside
it and `?bliner=1` to restore. Not because it cost radiance but because a value
that models nothing and measures nothing is one somebody later tunes in good
faith. **I did not touch the albedo** (`0xbfc7cc`, ~0.78, physically right for a
white liner) — compensating locally for another system's lamp is the class of fix
this file spent the previous session removing.

### For Lighting

Your cooler tubes are the blowout. Three `RectAreaLight`s at `7.0 * lampGain`
aimed back into the cabinet, onto a 0.78-albedo liner, put that surface on the
flat top of the curve — and the products in front of it lose their silhouette,
which is the subject of the user's third specified interaction. At `?lamp=0.5`
the bottles visibly recover colour and separation; at `0.25` the frame is
plausibly a lit cooler.

Two caveats I cannot resolve from here, which is why this is a handover rather
than a change:

- **`?lamp=` is not a cooler-only lever.** It scales the ceiling troffers and
  their uplight as well, so 31% and 91% are upper bounds on the cooler tubes'
  share. The pose is filled by cooler interior, so most of it is theirs, but
  splitting them is yours.
- **You have two interior/exterior light changes in flight at once** — this and
  Terrain's forecourt-shadow lever. Do not land both without knowing about the
  other; the interior/exterior contrast is the deliverable here, and both move it.

My own earlier interior numbers (0.99× vertical-contrast asymmetry, p50 181
against 82) still stand as targets and are unaffected by anything in this round.

## `alu` — landed on principle, does not clear the clip, dropped

`envMapIntensity` 1.1 → **1.0** stands: 1.1 was authored while the uniform was
inert (`NOTES` case 26) and is a surface reflecting 110% of what is in front of
it. But the `door` pose at 1.0 still shows **1167 clipped px**, including a
149-px-tall vertical edge highlight at x 1119–1145 (mullion) and a 45-px
horizontal one at x 775–819 (push bar). A 9% cut was never going to clear a
specular that is 2 codes over. **Dropped as instructed** — it is glimpsed in
passing, and the remaining fix is roughness or exposure, neither of which is worth
the window.

## Harness work, shared

Three faults, all of which presented as scene or build problems:

- **`READY_TIMEOUT_MS` was 120 s against a ~280 s cold load.** A healthy build
  reported "never became ready" with an **empty page console**, which reads
  exactly like a shader link failure. Now 420 s, and `polling: 500` instead of
  the default rAF, which is throttled when four agents share a GPU (`NOTES` 54).
  Measured: first page **221–244 s**, every subsequent page **20–25 s**.
- **`--ab=<query>` ported from `shoot3.mjs`.** Repeatable. All arms from one
  build, one server, one browser — which removes sibling drift *and* pays the
  ~262 s shader compile once instead of once per arm. Six captures in 355 s
  against ~1500 s as separate runs.
- **`--shots=grab,cooler` silently returned one capture** and a round that passed
  its own completeness check, because the harness holds a hand-written
  `ALL_SHOTS` and filters against it. Unknown names now exit 2 and print the
  known list. `NOTES` case 72; same shape as case 68 in a tool.

`NOTES` case 70 documents `tools/ts-resolve.mjs` under the exact
`ERR_MODULE_NOT_FOUND` text an agent will paste into a search.

## Queue

1. **Interior products against the corrected ambient** — still untouched, and the
   grab frame shows why it is worth doing: at `?lamp=0.5` the packaging reads as
   pastel candy-stripe rather than product. Judge after Lighting moves the lamps,
   not before, and **add no material variants** (program count is a tier lever
   for Perf's quality scaling).
2. **The 89 px masonry repeat**, when the coursing audit clears.
3. `_v-grab.png` had 5750 fully clipped where my `grab` pose has 0 at the same
   nominal state. Both are 1600×900 and the still is ~2.5 h old, so the tree is
   not the difference — the pose is. If the film's exact camera is wanted as a
   preset, Film owns those numbers and I will take them.

---

# Handover 16 — the transmission tier hook

Rounds **`2026-08-29T062036Z-DleyK9V-`** (grab, three arms) and
**`2026-08-29T062735Z-DleyK9V-`** (held bottle, two arms).

## What it gates, and what it deliberately does not

`ctx.quality.transmission`, read once in `init` into `this.transmissionAllowed`
and baked into the materials — one program per tier, not a variant per call site.

**The only two transmissive materials this system owns are the handheld bottle's
`heroShell` (1.0) and `heroLiquid` (0.94).** The storefront glazing, its inner
leaf and the cooler doors are already `transmission: 0` and have been since the
black-rectangle fix: they carry transmittance through *alpha* with a black diffuse
and reflection through a separate additive leaf.

**So the "low tier windows go opaque or black" risk does not exist here**, and
that is a consequence of the earlier compositing separation, not luck. The
shopfront is byte-identical at every tier. Worth knowing if anyone reasons about
this file from the tier table rather than the source.

**What the low tier's bottle looks like was decided, not discovered.** Dropping
transmission to zero on a `color: 0xffffff` shell would have produced a solid
white plastic bottle. Instead the shell keeps `transparent: true` and drops to
`opacity: 0.62` (`heroLiquid` to 0.5), which reads as **frosted PET**: neck and
shoulder translucent, cap visible through the wall, label fully legible, 0 clipped
pixels. Plainer, not broken. `opacity` is a uniform, so this costs no program.

## Measured, on the `grab` pose, one build and one browser

| arm | programs | draw calls | triangles |
| --- | --- | --- | --- |
| high (default) | 144 | 472 | 6,908k |
| **`?bgtrans=0`** (this hook alone) | **138** | **369** | **4,959k** |
| `?tier=low` (whole tier) | 138 | 369 | 3,200k |

Held pose (`bottle` + `?bgheld=1`): **145 → 139 programs, 442 → 321 draw calls,
6,748k → 4,798k triangles.**

**Six programs, and 103 draw calls and 1.95M triangles** — 22% of the calls and
28% of the triangles in that frame, from two materials on a 200 mm object.
`transmission > 0` makes three.js re-render the whole scene into a transmission
target, so the cost is a second copy of *everything else* and scales with scene
complexity rather than with the transmissive material. **The flag was justified on
cold-load compile time and is worth more per frame than per launch.** `NOTES`
case 73.

Note `?tier=low` and `?bgtrans=0` give the **same 138**, so this hook is currently
the entire program-count delta of the low tier in this pose — the other three
owners' hooks are not landed yet.

## No-op at high, proved

`grab-tier.png` from this round is **byte-identical** — md5
`fac1fe7e3b114f1e2f31af3d5dbb602b` — to `grab-lamp.png` from
`2026-08-29T060748Z-DP_qPeDs`, a bundle built **before this hook existed**. Not an
unchanged mean, not a passing health check: identical bytes across two bundles.

## `?bgtrans=0` is the isolated arm, and why it exists

`?tier=low` moves shadow map size, world capture and detail patches at the same
time, so a program drop under it cannot be attributed to one hook. `?bgtrans=0`
forces the low branch of this flag alone, tier unchanged. Keep it — it is what
makes any future claim about this hook checkable.

**One trap for whoever writes the next hook:** the first attempt measured
**137 programs on both arms** and looked like a clean null. The pose did not
contain the hero bottle, so neither material was ever compiled. A feature flag is
only measurable in a frame that would have used the feature, and the false null
reads exactly like a flag that did not bind.

---

## Handover 17 — the two white rectangles are angle-dependent, not unmapped

Diagnosis only. **No material was changed** (Lighting has the cooler lamp work
in flight and asked to be consulted first). CPU only; the card was never taken.

### The verdict on the routed question

Film offered two causes. **It is neither.**

- **Not exposure.** `tmp/hotpx.mjs` over both rectangles: **0 px** at
  (255,255,255), **0 px** with any channel at 255, peak luma 234. Whole frame
  has 3599 clipped px but `tools/probe-clip.mjs` clusters them all as thin
  high-aspect strips (16x184, 110x9, 123x4) on the mullion and push bar — not
  the rectangles.
- **Not a missing map, and not a regression from the headless split.** The same
  object is **fully printed at 65°** (`glass-65.png`, legible "NOW HIRING /
  APPLY WITHIN") and printed from inside (`at-wall.png`) — same capture session,
  same build, after the `buildingLayout.ts` split. A null map cannot bind at 65°
  and vanish at 82°. The canvas guard is exonerated by evidence already on disk.

The objects are the **window notices** (`window-notice`, `mat.notice`, taped
inside the glass at `sfZ + 0.012`), foreshortened by the 82° view into portrait
rectangles.

### What is actually happening

Content loss to grazing-incidence reflectance, measured by distinct luma codes:

| region | mean | sd | distinct codes |
| --- | --- | --- | --- |
| notice @65° | 178.6 | 39.65 | **163** |
| notice @82° | 231.6 | 1.36 | **6** |
| shelving behind same pane @65° | 120.2 | 33.21 | 230 |
| shelving behind same pane @82° | 108.2 | 29.52 | 160 |

The control is the point: **the darker surfaces behind the same glass keep their
contrast.** Only the near-white notice, already high on the tone curve, runs out
of slope. This is NOTES case 42 reached via viewing angle rather than emitter
intensity, and is written up as **case 87**.

### The mechanism is NOT yet attributed — do not fix it blind

The obvious story is the additive reflection leaf. **It is refuted by my own
table:** a uniform additive term cannot raise the notice's mean +51 while
lowering the shelving's by 12. Two candidates remain, both in my glazing:

1. the reflection leaf washing out a bright surface, or
2. the pane at 82° mirroring something bright over that region.

**The ablation that separates them (needs the card, ~6 min, one bundle):**

```
node tools/walkprobe.mjs --port=5112 --query=bglrefl=0     # kills the additive reflection leaf
node tools/walkprobe.mjs --port=5112 --query=bgfres=0      # kills the Fresnel coupling
node tmp/clip/flat.mjs shots/walkprobe/glass-82.png 1240 300 70 180 "rect A core"
```

If rect A's distinct-code count recovers from 6 under `bglrefl=0`, it is mine and
local. If it stays at 6, the notice's own shading is the subject and it belongs
with the interior light work.

**`tools/walkprobe.mjs` writes to a fixed `shots/walkprobe/` and will overwrite
Film's frames.** They are archived at `shots/walkprobe-film-0637/` — case 69's
rule applied to someone else's evidence. Copy any new arm out before re-running.

### Third item in the same report, and it is a different defect

The "smaller blank panel near the bollard" measures **105 distinct codes**,
sd 19.85, nothing railed. It is not blank; it is low-contrast. That is a
legibility repair, not a binding or exposure one, and it should not be folded
into the rectangles.

### Corroborated, not mine

`inside-shop.png` and `at-wall.png` both show a floor and shelving with no cast
shadow anywhere, consistent with Film's ambient-lit reading and with the 0.99x
vertical-contrast asymmetry already routed to Lighting.

### New shared tooling

- `tmp/clip/flat.mjs <png> x y w h [label]` — luma spread and **distinct-code
  count** for a region. The distinct-code count is the statistic that separates
  "no map" from "map compressed into the shoulder"; mean and sd do not.

---

## Handover 18 — all three candidates refused; the rectangle is unlit and is not Building's

One bundle, rebuilt (not `--no-build`) against Lighting's landed interior grade.
Card released to Perf. Eight arms, one browser, three page loads.

### The result

At 82 deg, on the region Film reported, the rectangle reads **mean 231.6,
sd 1.36, 6 distinct codes, 0 railed — identical to four significant figures in
every arm**: reflection leaf at 0x / 1x / 4x, `scene.environmentIntensity` at
0 / 1.0 / 2.4 / 4.8, and Fresnel off as a separate program on its own load.

The control (stock behind the same pane) moved in the same arms — the 4x
reflection arm shifts it 12.8 mean and 22 codes — so **the levers are live and
reach the frame.** They do nothing to the rectangle.

- **Building's reflection leaf: refuted.**
- **Building's Fresnel coupling: refuted.**
- **Lighting's `environmentIntensity` 2.4x: refuted.** Four values spanning 0 to
  4.8 give byte-identical output. This is the number Lighting is waiting on: the
  multiplier is not the cause, and no change to it will fix this.
- **Lighting's interior grade did not move this region.** The rectangle is
  bit-identical to Film's capture from 40 minutes earlier, pre-grade.
- The physical-clipping null is also out: **nothing is railed**, peak 234.

### What it is instead, and why it is not mine

A surface invariant to every illumination term is **not being lit**. Building
ships **zero `MeshBasicMaterial`** (`grep -rn MeshBasicMaterial src/systems/BuildingSystem.ts
src/gen/building*.ts` is empty), so the owner is elsewhere. Files that do ship
unlit materials: `vegDistant.ts`, `vegGround.ts`, `vegLitter.ts`,
`vegHorizonBands.ts`, `vegMat.ts`, `contactShadow.ts`, `CarSystem.ts`,
`lightInterior.ts`, `lightSky.ts`.

`vegDistant.ts` is the strongest candidate on its own documentation — unlit
bands, colour authored directly, and a critic quote in the file describing a
"flat fill of near-uniform value, no internal detail of any kind". Note also that
`stubBuilding: true` is **still live** in `tools/vegfringe.mjs` and
`tools/_vegscale-entry.ts`, which is the empty-blocker path that over-planted the
lot interior.

**The decisive next arm is one load:** `?skip=vegetation`, then re-measure the
box. `Game.ts` validates unknown system names, so a typo fails loudly. If the
rectangle survives, sweep `?solo=` across the unlit-material owners above.

### Retraction

Handover 17's disproof of the missing-map branch — "the same object is printed at
65 deg" — **is withdrawn.** It compared a hand-drawn box on the 82 deg frame with
a hand-drawn box on the 65 deg frame and assumed both contained the same surface.
When the region was derived from geometry, the window notice projects to
**33 x 195 px in a different part of the frame** than the 180 x 360 rectangle.
The two were never the same object, so the missing-map/unlit branch was closed on
no evidence. Written up in NOTES under "A surface invariant to every lighting
lever is not lit".

The notice itself, measured properly, is healthy: **141 distinct codes at 82 deg,
155 at 45 deg.** There was never a defect there.

### Tooling

- `tools/probe-glazeablate.mjs` — arms share one browser; only a *program* change
  costs a reload. `envMapIntensity` and `scene.environmentIntensity` are live
  properties, so 6 of 8 arms need no load at all. **Derives its measurement
  region from the object's own geometry** by projecting it to screen (no `THREE`
  on `window` in a production build, so the matrices are applied by hand).
  Carries a forced-high control per lever, a darker control region in every arm,
  and a pose control against Film's frame.
- `tmp/clip/flat.mjs <png> x y w h [label]` — distinct-code count for a region.

### Two harness faults worth propagating

- The previous revision's lever-live check asked whether the forced-high arm moved
  **the region under test**, and so announced "INSTRUMENT DEAD" while the control
  region was plainly responding. A lever-live check must pass on *any* region.
- `?lforce=noenv` zeroes the env binding outright, so this file's "no reflection
  leaf found" guard aborted that arm. The `environmentIntensity 0` arm covers the
  same ground; the guard needs an opt-out rather than a fix.

### Still open, unchanged

The bollard panel at 105 distinct codes is low-contrast, not broken — noted and
left, per instruction. `GRAB_BOTTLE` and the cooler leaf untouched pending
Interaction's pick-priority rule.

---

## Handover 19 — the lens map is alive, and the lens cannot be the rectangle anyway

CPU only, no card. Two answers.

### 1. The troffer lens map binds. There is no dead map.

Traced end to end in the shipping browser path:

| link | state |
| --- | --- |
| `makeTrofferLens()` | builds 96 x 192, two tubes at u 0.27/0.73, `g` from ~0.04 at the flange to 1.00 at tube centre — deep, and well below the 0.4 shoulder |
| assignment | `map: trofferLensTex` **and** `emissiveMap: trofferLensTex`, on a dedicated material instance, not shared with the wall pack |
| gate | `dbg("blens", 1) !== 0` — **on by default**; non-numeric throws |
| geometry | `buildingQuad(hw-0.02, hl-0.02, "-y")` -> `THREE.PlaneGeometry`, which always emits full 0..1 UVs. No degenerate UV rect. |
| upload | `opaqueTexture` returns a `CanvasTexture` with `needsUpdate = true`, `SRGBColorSpace`, mips, aniso 8 |
| headless split | `init` has exactly **one** `typeof document === "undefined"` guard, at line 260, which returns before `buildMaterials` at line 289. Nothing in the material path is conditional on `document`. **No regression from that work.** |

So the missing-map branch, reopened for the lens, closes again — this time on the
construction, the slot, the UVs, the upload flag and the gate, rather than on an
inference.

### 2. The box `1240,300,70,180` contains none of the three candidates

`tools/probe-project82.mjs` — new, CPU-only, imports `buildingLayout.ts` and
projects with the matrices written out by hand. At the 82 deg stance
(eye `-6.96, 2.22, 31.10` -> look `-3.40, 2.22, 31.60`, fov 52, 1600x900):

| object | projected | covers the box |
| --- | --- | --- |
| `troffer-diffuser` x3 on screen | **140x9, 139x12, 159x12 px** | 5%, 0%, 0% |
| `troffer-diffuser` x3 off screen | — | 0% |
| `window-notice[hiring]` | 32x197 at (881, 398) | 0% |
| `cooler-liner` | off screen right, x 1892 | 0% |
| `sign-plate[exit]` | off screen right, x 1537 | 0% |

**Nothing contains the box centre (1275, 390).**

**The projector is validated against the live scene**: it puts
`window-notice[hiring]` at 32x197, and the in-browser geometry projection in
`probe-glazeablate.mjs` measured 33x195. Two independent implementations, 1 px
apart.

**The troffer lens is geometrically incapable of being this object.** It is a
horizontal quad facing -y; at 82 deg off the storefront normal it is seen
nearly edge-on and delivers a **9-12 px tall band**. The rectangle is ~165x340 px.
This holds whatever the lens map does, so it is independent of the map question
above — and it means an ablation of `lensGain` would be measuring a surface that
occupies 5% of one edge of the box at best.

### Where the object actually is

The ray through the box centre, direction (0.815, 0.058, 0.576), crosses the
storefront plane `z = 31.6` at **x = -6.25, 1.70 m above the finished floor** —
inside the door opening (`doorX0 -6.575`, `doorX1 -5.425`) — then runs on into the
shop at y 2.28 -> 2.92 m, passing *above* the gondola tops and the cooler.

Building's flat-panel inventory in that corridor is exhausted: notices, vinyl,
plates, liner, troffers, all projected and all elsewhere. Naming it needs one
raycast, not an ablation.

### Tooling ready for whoever next has the card

`tools/probe-namepx.mjs` — reports every mesh whose projected bounding box covers
a given pixel, nearest first, with material, `map` dimensions, `emissiveMap`
presence and **`mapUploaded`** (a `CanvasTexture` whose `needsUpdate` was never
set samples white and looks exactly like a flat face). **Deliberately not a
`Raycaster`:** `THREE` is not on `window` in a production build, and the first
revision of this file spent a page load discovering that. It now projects AABBs
with hand-written matrices and needs no library. One load, no extra arms.

### Corrections to Handover 18, both mine

- The five-file `MeshBasicMaterial` list was a grep over **prose**; three of those
  files construct none, and their matches are comments explaining why the
  material is deliberately not unlit. Written up in NOTES under "A grep over a
  codebase counts prose as evidence".
- "The surface is unlit" was over-read. All eight arms were levers on *reflected*
  radiance; none touches `totalEmissiveRadiance` or a `RectAreaLight`. The nulls
  establish **"not reflection-driven"** and nothing more. Also
  `tuneInteriorMaterials` returns early on the lens branch before the
  `envMapIntensity` write, so bit-identity across Lighting's grade was guaranteed
  by that function rather than being evidence.

## Handover 20 — The pixel is named, and it is ours

**(1275,390) at the 82° stance is a blank paper notice taped to the *outside* of
the entry door leaf, 0.70 m from the eye.** Source is
`BuildingSystem.buildEntryDoor`, the loop at lines 1801–1809:

```ts
for (const s of [
  { x: 0.3,  y: 1.55, w: 0.21, h: 0.29, r: 0.04,  c: 0xd9d4c4 },
  { x: 0.63, y: 1.36, w: 0.15, h: 0.2,  r: -0.07, c: 0xcac2ae },
]) {
  const p = buildingQuad(s.w, s.h, "-z");
  p.rotateZ(s.r);
  p.translate(s.x, s.y, -0.009);
  door.add(new THREE.Mesh(p, this.signMaterial(s.c)));
}
```

`signMaterial` is `MeshStandardMaterial({ color, roughness: 0.94, metalness: 0,
side: DoubleSide })` — **no map, ever.** One call site, so no other surface is
affected.

### Both rectangles, both notices

| rect | pixel | projected bbox | depth | authored size | implied h at that depth |
| --- | --- | --- | --- | --- | --- |
| A | 1275,390 | 156×392 px | 0.70 m | 0.21 × 0.29 m | 0.297 m at 392 px |
| B | 1085,570 | 58×189 px | 1.06 m | 0.15 × 0.20 m | 0.206 m at 189 px |

**Two notices in the source, two rectangles in the frame, and for each one the
height implied by its own projected box at its own depth matches its authored
height to under 4%.** That is the identification; everything else is
corroboration.

### Why every property from the reconstruction follows

`buildingQuad(w, h, "-z")` faces −z, and −z is **outside**: the push bar is at
+0.055 and the pull handle at −0.062, and the comment on line 1781 fixes push as
inside. The notices sit at −0.009, on the outward face, facing out. So they are
**sky-lit paper, not shop-lit paper**, which is why they were invariant to every
interior lighting lever — that invariance was never evidence of an unlit
material, it was evidence that we were measuring an exterior-facing surface with
interior controls. Flat, bright, not reflection-driven, and unresponsive to the
shop: all four fall out of "near-white paper facing an overcast sky, with no map,
at 0.70 m".

They are also physically wrong. `buildingSignage.ts:567` describes the notice set
as "the taped paper notices on the **inside** of the glass", which is where shop
notices go. These two are on the wrong face.

### Price, not yet spent

The atlas we need already exists and is already resident: `this.noticeSheet`
(1024², four cells, `applySheetCell` for UV remap) and `this.mat.notice`, both
confirmed alive in this run at the 65° stance.

- **A0 — move them inside the glass.** Flip the facing to `+z` and the offset to
  `+0.009` on the push side. **Two edits.** No new texture, no VRAM, no draw-call
  change. Removes the sky-lighting independently of the blankness, so it is worth
  doing whatever else happens. Risk: they end up behind the door glass, which is
  correct but will dim them.
- **A1 — give them printed content from the existing atlas.** `applySheetCell`
  plus `this.mat.notice` in place of `signMaterial`, sized from the cell aspect
  like the window notices are. **~8 lines**, no new texture, no VRAM, same two
  draw calls (they must stay children of `door` to swing with the leaf, so they
  cannot join the batch). `signMaterial` and `signCache` become dead and can go.
  **Risk: all four atlas cells are already used by window notices**, so two
  flyers would appear twice in one frame — at 0.70 m and 2.10 m, which may read
  worse than blank.
- **A2 — add two cells for the door.** The 1024² sheet is already fully divided
  into four quadrants, so this means either halving cell resolution or going to
  2048² (4 MB → 16 MB RGBA on that sheet). **~60–90 lines** in
  `buildingSignage.ts`. The correct answer, and the only one that avoids visible
  duplication.
- **C — recolour only.** Two numbers. Stops the blown-white read and leaves a
  flat blank rectangle at 0.70 m, which at 392 px is still the worst thing in the
  frame. Not a fix.

**Recommendation: A0 + A1 now, A2 when there is time to author art.** A0 alone is
two edits and strictly reduces the defect. Nothing is applied — the instruction
was to price before making, and I would rather this be chosen than assumed.

### Retractions this closes

`window-notice` was wrong (Handover 18): those are the mapped 1024² quads at
2.10 m, a different object, and they are fine. The troffer lens was wrong
(Handover 19). Neither Vegetation nor Lighting owns any part of this.

## Handover 21 — A0 and A1 landed, A2 refused

Both edits are in `buildEntryDoor`, replacing the `signMaterial` loop:

```ts
for (const s of [
  { cell: "tabs", x: 0.3, y: 1.55, w: 0.21, r: 0.04 },
  { cell: "community", x: 0.63, y: 1.36, w: 0.15, r: -0.07 },
]) {
  const p = buildingQuad(s.w, s.w / this.noticeSheet.aspect[s.cell], "-z");
  applySheetCell(p, this.noticeSheet.cells[s.cell]);
  p.rotateZ(s.r);
  p.translate(s.x, s.y, 0.009);
  const m = new THREE.Mesh(p, this.mat.notice);
  m.name = "entry-door-notice";
  door.add(m);
}
```

**A0 is the sign on the offset, and it is one character.** `-0.009` to `+0.009`
puts the paper on the interior surface; the facing stays `-z` so the print still
reads out through the pane. That is the storefront convention exactly — the
window set sits at `sfZ + 0.012` facing `-z` — and it is what
`buildingSignage.ts` already claimed the notice set did.

**Checked before making it, because A0 could have hidden them instead of fixing
them.** The leaf frame is stiles at x 0..0.055 and 0.975..1.030, top rail from y
2.02, bottom rail to y 0.26, so the glazed opening is x 0.055..0.975 by y
0.26..2.02. Notice A spans x 0.195..0.405, y 1.405..1.695; notice B spans x
0.555..0.705, y 1.26..1.46. Both are wholly over glass, so moving them behind
the pane leaves them visible rather than putting them behind an aluminium rail.
The pane is at `-0.004` and the notices now at `+0.009`, 13 mm clear, and the
leaf boxes span `±0.025` only where there is no glazing — no z-fighting either
way.

### The two cells, chosen in two words

`tabs` and `community`, because their storefront twins are the two furthest from
the door: `tabs` at x −7.4 is behind the forecourt sightline and `community` at
+0.9 is six metres the other way. `hiring` (−4.9) and `card` (−4.52) sit just
right of the door and would have put the same flyer twice within a metre.

The aspects made this free rather than a compromise: `tabs` is 0.72 and
`community` 0.78, against quads authored at 0.724 and 0.75. Deriving height from
the cell aspect moves notice A by 2 mm and notice B by 8 mm, so the elevation is
unchanged and the projected-size arithmetic from Handover 20 still holds.

**`signMaterial` and `signCache` are deleted** — that loop was the only call
site. `tsc --noEmit` clean. No new texture, no VRAM, no new draw calls; the two
meshes stay children of `door` so they swing with the leaf and cannot join the
static batch.

### A2 refused

Not proposing it again. 4 MB to 16 MB on one sheet, after the last scheduled
measurement, on a tree whose crash history is VRAM exhaustion, to avoid a
duplication that is physically correct — and halving cell resolution to avoid
the VRAM would trade the blemish for a worse one. The duplication is what a real
station looks like; the person with the tape had a stack.

### Verification, one load, queued third

`tools/probe-noticeprint.mjs`. One stance (82 deg), one screenshot, no arms.
Regions are the projected bounding boxes of the meshes named
`entry-door-notice`, inset 6 px, never boxes chosen off a picture — that
substitution is what cost the previous round. Asserts the distinct luma code
count comes off the blank baseline of 6, reports the unchanged `window-notice`
set in the same frame as a control, and checks that (1275,390) and (1085,570)
fall inside a door notice box so the measurement is tied to the original
complaint.

**It also tests the one way A0 could fail.** Moving paper behind glazing at 82
deg risks trading a blank rectangle for print drowned in the pane's reflection.
The railed-pixel fraction separates those: codes off 6 with more than half the
region railed is reported as PARTIAL, not PASS, because print that exists and is
clipped is a different defect from a blank quad and must not be signed off as
the same fix.

### Verification load spent, and lost to my own probe

The run reached the scene and then projected every bounding box to `NaN`: the
call site dropped the homogeneous coordinate from `mul(e, x, y, z, w)`. Fixed,
plus a finite-check that now fails with "fault in this probe, not in the scene"
before any pixel is read. Recorded as NOTES.md "A probe that prints `NaN` and
keeps going spends the load anyway". The card was released cleanly.

**What the spent load did establish, page-side and unaffected by the bug:**

- **Two meshes named `entry-door-notice` exist in the built bundle.** The edit
  compiles, ships and survives the production build.
- **Both carry the 1024² notice atlas, uploaded**, not a flat colour. The blank
  material is gone from those quads.
- **The UV cells are the two intended ones** — `[0.5,0.5,1,1]` is `tabs` and
  `[0.5,0,1,0.5]` is `community` — so `applySheetCell` bound the cells asked for.
- The four `window-notice` meshes still hold `hiring`, `card`, `tabs` and
  `community`, unchanged.

**And what CPU projection then established for free**, from the plan constants
with no card:

| mesh | predicted box | depth | previously measured, as blank quads |
| --- | --- | --- | --- |
| `entry-door-notice[tabs]` | 152×379 at (1188, 390) | 0.71 m | 156×392 at 0.70 m |
| `entry-door-notice[community]` | 55×187 at (1062, 597) | 1.07 m | 58×189 at 1.06 m |

Both land within four pixels of the rectangles they replace, which confirms A0
and A1 moved the paper by millimetres and not by metres. `(1085,570)` falls
inside the `community` box. `(1275,390)` sits 11 px outside the `tabs` box as
projected here, and this projection deliberately ignores the 0.04 rad tape-skew,
which widens that edge by about 15 px — so it is inside once the rotation the
real mesh carries is applied.

**The cell choice is also confirmed, for free.** At the 82 deg stance
`window-notice[tabs]` is *entirely behind the camera* and
`window-notice[community]` projects to 2×40 px at x 730, 7.74 m away. Neither
duplicate is anywhere near its door twin in this frame, so the duplication cannot
read as a repeated texture from the stance the complaint was made from.

**What is still unmeasured is the pixel claim**: distinct codes off the blank
baseline of 6, and whether the pane's reflection at 82 deg drowns the print — the
one way A0 could trade a blank rectangle for a worse defect. The probe is fixed,
guarded and ready; it is one stance, one screenshot, no arms. **Not taking a
second load without being told to.**
