# Handover — System 2, the station building and store interior

Written at a forced stop, mid-iteration, in response to a critic review that
scored the five captures **4/10, FAIL**. Assume you are picking this up cold.

Owned files: `src/systems/BuildingSystem.ts`, `src/gen/building*.ts`,
`tools/shoot2.mjs`, `tools/probe-*.mjs`, `shots/system2/`.

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
