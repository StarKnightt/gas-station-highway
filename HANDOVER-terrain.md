# System 1 (terrain / road / lot / soil / wet surfaces) — handover

Written on a forced stop about ten minutes in, because the user needed the GPU.

**Nothing of mine is running.** No preview server, no Playwright browser, no
build. Ports 5131 (`shoot1`) and 5132 (`tilescan`) have no listener; the only
node processes on the box are MCP servers and there is no Chromium at all.
`bash tools/rebuild.sh` and a whole-project `pnpm exec tsc --noEmit` are both
clean, and every edit below is complete rather than half-applied.

The previous handover (iteration 4, ~15:17) described the paint erosion fix, the
longitudinal grade and four "landed but never seen rendered" items. All of that
is still true and still unverified; it is not repeated here.

---

## 1. The tiling pebble bump — what is established, and how firmly

**It is a UV tiling period, not a noise-lattice artefact, and the period is
17.0 m.** This is established from the source and from the two PNGs the critic
named, **not** from measured pixels — see §2 for exactly what is missing.

### `antiTile` is applied to this surface, and it does not touch the bump

`TerrainSystem` gives the dirt material `antiTile: 0.85`, the highest value of
the four surfaces, so "is it applied at all" is yes. But `applyWorldDetail`
cross-fades the second rotated sample into exactly two channels:

- `diffuseColor`, injected after `#include <map_fragment>`, behind `#ifdef USE_MAP`
- `roughnessFactor`, injected after `#include <roughnessmap_fragment>`, behind
  `#ifdef USE_ROUGHNESSMAP`

There is **no anti-tile injection on the normal map**. The only thing injected
after `#include <normal_fragment_maps>` is the distance fade. The normal is
sampled once, by three's stock chunk, at `vNormalMapUv`. So the albedo and the
roughness are broken up and the bump is not — which is precisely the channel the
critic named, and the reason the complaint survived a feature that exists to
prevent it.

### Why 17 m, and why it is not the lattice

`gridSurface` writes `uv = world / uvMetres`, and the ground mesh is built with
`uvMetres = dirtMaps.tileMetres = 17`. The mesh spans −420..420 m, i.e. **49.4
repeats per side**. Nothing else in the dirt path is world-periodic at a
comparable scale, because the dirt material is passed **no site overlay and no
wash** — the single non-repeating world signal on the entire native ground is
one macro-noise multiply, and that itself repeats at `macroMetres = 78` m.

A noise-lattice artefact would sit at a *sub-tile* length, 17/f for some small
integer f, and would not be commensurate with 17. It is also unlikely on the
merits: `noise.ts` is periodic gradient noise with a quintic fade, non-harmonic
lacunarity 2.17 and a per-octave dihedral symmetry, and the fields feeding the
dirt height map are all sub-tile feature sizes (`clods` fbm ≈ 100 mm, `gravelDist`
worley ≈ 35 mm, `rocks` worley ≈ 190 mm). **The discriminator is the measured
length, and that is the number I did not get.**

### Two aggravating factors worth having in hand

- **The anti-tile selection mask is itself periodic at 45.9 m.** It is
  `smoothstep(0.32, 0.68, macro(wxz * uMacroScale * 1.7))` with
  `macroMetres = 78`, so 78/1.7 = 45.9 m — and the alternate sample is at 0.63×
  the base, i.e. **27.0 m**. Three commensurate periods (17, 27, 45.9) that beat
  against each other. The breakup layer contributes a second visible cell rather
  than removing the first, so raising `antiTile` cannot help and may hurt.
- **The bump amplitude is constant over 840 m.** `heightToNormal(height, 1024,
  1.4)` at `normalScale 0.26`, dominated by `clods * 0.5` at ≈100 mm. A
  constant-amplitude pebble carpet reads as a texture at any period.

### Intended fix (designed, not written)

1. Cross-fade the normal map in the `<normal_fragment_maps>` injection, and
   **counter-rotate the sampled tangent-space XY by the same 41°** the UV lookup
   was rotated by. A rotated normal sample that is not counter-rotated lights
   from the wrong direction and adds a second, wrong bump instead of hiding the
   first — this is the detail most likely to be got wrong.
2. Decorrelate the periods: drive the selection mask from a much lower-frequency
   world field and move the alternate scale well away from 0.63 (0.37 or so), so
   the beat is longer than any frame.
3. Modulate bump amplitude from the Task 2 soil field, so the carpet stops being
   uniform whatever its period.

Do 1 first, alone, and measure. Forcing 1 and 3 together is NOTES.md case 23.

---

## 2. The instrument, which is written and self-tested but never run on the GPU

`tools/tilescan.mjs` (new, port 5132, own build dir). A nadir camera at a known
altitude over open ground makes world metres and image pixels linearly related
across the whole frame, which no oblique pose does; the frame is high-passed to
kill the lighting gradient and a normalised autocorrelation is taken along image
X and image Y. It reports the period **in metres** and matches it against the
four known lengths (17.0, 27.0, 45.9, 78.0) or reports it as a sub-tile fraction.

It takes no region — the correlation is over the whole frame, so there is no
coordinate for an author to place where the feature it just built is.

`node tools/tilescan.mjs --selftest` **passes** and is the only pixel evidence I
produced: it reports the planted 17.0 m repeat at r = 1.000 and reports nothing
at all on a non-repeating control with the same statistics.

`node tools/tilescan.mjs --variants=base,bumponly,albedoonly,notile` is the run
that was stopped. It builds, captures 4 variants × 2 open-ground stations, and
should say which of albedo / bump carries the 17 m peak. **Run this before
touching the shader.** It asserted the real GPU on its one attempt:
`ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 ... D3D11)`, aniso 16.

---

## 3. Sterile soil (Task 2) — plan

The read is correct and the cause is structural: on the native ground there is
one world-space signal (macro at 78 m) and one tiling detail set. Nothing varies
by drainage, by disturbance, or by material.

Intended shape, all in `worldDetail.ts` + a new soil field in `textures.ts`:

- **Two more colour scales**, at roughly 8–14 m and 60–120 m, on top of the
  existing macro, so the ground is not one brown at one frequency.
- **A second dirt albedo/normal set** (paler, finer, more clay; less gravel) and
  a low-frequency mask that swaps between them, so there are genuinely different
  *materials* on the ground rather than one material at different brightnesses —
  this is the case 21/22 lesson applied to terrain: varying amplitude alone reads
  as an exposure change.
- **Drainage as the organising field**, derived from `dirtY` rather than from
  free noise: the swale bottom gets crust and fines and holds damp; the crests
  get gravel concentration and pale dust. That makes the variation agree with the
  silhouette instead of fighting it.
- **Disturbance**: verge next to the pavement, the driveway turn-ins and the
  swale crossings are compacted and gravel-rich; away from them the ground is
  crusted and undisturbed.

**Contract for the vegetation agent, not yet published.** The intended service is

```
game.provide("groundSoil", {
  colourSpace: "linear-srgb-scene-referred",
  /** 0 = undisturbed crust, 1 = trafficked/compacted. World XZ, metres. */
  disturbance(x: number, z: number): number,
  /** 0 = dry, 1 = standing water. Same field the wet mask uses. */
  wetness(x: number, z: number): number,
  /** Metres above/below the local drainage datum; negative is a low spot. */
  drainage(x: number, z: number): number,
})
```

Three scalars, all CPU functions of world XZ so the inter-plant mat can be
scattered against the same field the shader shades against. Nothing is published
yet — do not let anyone code against it until it exists and a probe agrees with
the GPU, per the `skyRadiance` precedent.

---

## 4. System 5, wet surfaces and puddles — plan

Never started; nothing of it exists. `site.ts` already carries `LOW_SPOTS` with a
comment saying it was authored for exactly this, and `siteOverlay` §7 already
paints damp ellipses at those same coordinates, so the coordinates are agreed
across two files before anything is built.

- **Water sits in the height field, not in decals.** Build each puddle as a flat
  quad clipped by `padY(x,z) < waterLevel`, with the level chosen per low spot,
  so the shoreline *is* the terrain contour by construction and cannot be a
  shape. The four `LOW_SPOTS` are 52–92 mm deep, which is a plausible water depth
  and means the level is a small number, not a guess.
- **The wet/dry mask is the deliverable**, more than the water is. A signed
  distance above the water level, softened by a world-space noise so the fringe
  is ragged, driving: albedo × ~0.55, roughness down hard, and a narrow darker
  band right at the margin where the ground is saturated but not flooded.
- **Do not tune reflection strength now.** The PMREM's lower hemisphere has
  standard deviation exactly 0.0 — there is no world in it to reflect — and the
  capture is opt-in behind `?worldenv=1`. Build the geometry, the roughness and
  the darkening; re-judge the specular read after Lighting lands the world
  capture. The 11° sun means the streak, when it comes, will be long and will
  live in `ground`, `puddle` and `fringe` poses, all of which are already placed
  on the reciprocal of the sun bearing in `tools/shoot1.mjs`.
- Guard: `?tforce=nowet` and `?tforce=wetmax` are already reserved and validated;
  `nowet` is the control that must move pixels.

---

## 5. What actually changed on disk

All of it typechecks. None of it has been seen rendered except the one aborted
tilescan run, which did reach `__SCENE_READY` on the first variant.

| file | change |
|---|---|
| `tools/shoot1.mjs` | **new.** System 1 harness. Port **5131**, build dir `.shot-build/terrain/`. Archive round via `openRound`, GPU assertion, shader-link fatal, `__SYSTEM_ERRORS` fatal, bundle-race check, strict pose-name validation. Frame health checks the **lower third and the near-black fraction**, not only the sky mean — a sky-mean check alone passes a completely broken frame because the dome is a `ShaderMaterial`. Poses: `approach`, `lot`, `ground`, `wide` (critics' familiar framing) plus `verge` (open soil), `puddle` and `fringe` (both on the reciprocal of the sun bearing). |
| `tools/tilescan.mjs` | **new.** Port **5132**. See §2. |
| `src/gen/worldDetail.ts` | added `normalFade?: boolean` (diagnostic: holds the bump at full strength for a nadir scan) and put it in `customProgramCacheKey`. No behaviour change at the default. |
| `src/systems/TerrainSystem.ts` | `?tforce=` switch set with **strict token validation**, resolved inside `init()` so an unknown token lands in `__SYSTEM_ERRORS` rather than blanking the page. `notile` / `bumponly` / `albedoonly` / `nofade` are wired; `nosoil` / `soilviz` / `nowet` / `wetviz` / `wetmax` are reserved and validated but not yet consumed. Publishes `window.__TERRAIN` with mesh and triangle **counts** so a harness can tell "built nothing" from "built and looks wrong". |
| `src/site.ts` | `?force=` now reports unrecognised tokens on `FORCE.unknown` and logs them; `TerrainSystem.init` throws on a non-empty list. Previously a typo was ignored in silence, which is NOTES.md case 25 sitting live in this system's own file. No token semantics changed. |
| `src/core/Game.ts` | **shared — see §6.** |

Scratch directories `.shot-build/terrain/` and `.shot-build/tilescan/` are mine
and safe to delete.

---

## 6. Two things that belong to other people

**(a) `?solo=` / `?skip=` were unusable, and this is shared.** `Game.start()`
filtered which systems get `init()`, but `Game.frame()` iterated *every*
registered system, so a skipped system had `update()` called on the first tick
with none of its own state built. `?solo=lighting,terrain` produced two entries
in `__SYSTEM_ERRORS` — `player.update` and `interaction.update`, both
`Cannot read properties of undefined` — which is a fabricated failure of two
systems that were never asked to run. Any harness that correctly gates on
`__SYSTEM_ERRORS.length === 0` therefore could never use the isolation flag that
exists specifically to unblock it when another agent's system is throwing. Fixed:
`frame`, `onResize` and `dispose` now iterate the active subset, and an unknown
name in `?solo=`/`?skip=` throws instead of being ignored. I edited `Game.ts`
because the flag is unusable without it and every agent's harness is exposed;
say so to whoever owns core.

**(b) NOTES.md.** The above is written up as **case 32**. It is a new shape: not
a defect that hid, but a *diagnostic facility* that manufactured a false positive
in the one channel every harness treats as authoritative.

---

## 7. First three things on resume

1. `node tools/tilescan.mjs --variants=base,bumponly,albedoonly,notile`. Get the
   number before touching the shader. `bumponly` must show the 17 m peak and
   `albedoonly` must show it much weaker; if that is not what comes back, the
   diagnosis in §1 is wrong and the fix in §1 will not help.
2. Land the normal-map anti-tile alone, re-run tilescan, and confirm the peak
   moves. Then `node tools/shoot1.mjs` and `node tools/framescan.mjs` over every
   frame in the round before handing anything to a critic.
3. Soil field and its service (§3) before wetness (§4) — wetness reads the
   drainage field, so building it second costs nothing and building it first
   means building the field twice.

---

# APPENDED BY THE CROSS-SYSTEM (CPU-ONLY) PASS — 2026-08-29

*Not written by the terrain owner. Nothing above was edited.*

## Your `Game.ts` fix was verified and broadcast

Read against the source this session: `Game` holds `private active`, and
`frame()`, `onResize()` and `dispose()` all iterate it rather than `systems`;
unknown `?solo=`/`?skip=` names throw out of `start()` with the registered list.
NOTES case 32 is in place. An identically-worded section describing it has been
appended to all five other handovers, because several of their harnesses gate on
`__SYSTEM_ERRORS`.

## `src/gen/worldDetail.ts` — I landed §1 step 1 of your plan. CPU-verified only.

**Your file. Read this before you re-open it.**

The normal-map arm of the anti-tile cross-fade is now injected after
`#include <normal_fragment_maps>`, ahead of the existing distance fade so the
fade applies to the combined normal.

- Same 41-degree rotation, same 0.63x alternate scale, same `vec2(0.37, 0.19)`
  offset as the albedo and roughness arms.
- **The sampled tangent-space XY is counter-rotated** by the inverse rotation —
  the detail you flagged as most likely to be got wrong. Written as a literal
  `mat2(0.755, 0.656, -0.656, 0.755)` because `transpose()` does not exist in
  GLSL ES 1.00, which is what three compiles these chunks as. Checked against
  `normal_fragment_maps` and `normal_fragment_begin` in
  `node_modules/three/build/three.module.js`: `tbn` and `normalScale` are both
  in scope after the chunk, the block is guarded on
  `USE_NORMALMAP_TANGENTSPACE`, and `USE_PACKED_NORMALMAP` is handled the same
  way the stock chunk handles it.
- **The uniform table was respected.** No uniform was hand-added; the block
  references only `uAntiTile`, `uMacro` and `uMacroScale`, all declared
  unconditionally, and it goes through `assertDeclared` as
  `"normal-map anti-tile injection"`. No new `customProgramCacheKey` term,
  because no new feature flag was introduced.

**It uses the same 45.9 m selection mask as the other two arms, deliberately.**
Your point about the mask being world-periodic at 45.9 m with the alternate at
27 m is taken and is not disputed. The reasoning for inheriting it anyway is
written in full at the injection site: the mask belongs to all three arms
equally, and moving it on the normal alone would let the bump switch to the
rotated sample somewhere the albedo had not, so a pebble's colour and its relief
would stop agreeing. A mismatched albedo/normal pair reads worse than a
long-period mask. Decorrelating the periods is your §1 step 2 and it must move
all three arms together — and be measured on its own, per your own instruction
and NOTES case 23.

**This has not been rendered.** Your resume order is unchanged and still right:
run `node tools/tilescan.mjs --variants=base,bumponly,albedoonly,notile` **first**
to confirm which channel carries the 17 m peak before judging anything. If
`bumponly` does not show it, this change is not the fix. Then re-run tilescan
with it in and see whether the peak moves.

Nothing else of yours was touched: `TerrainSystem.ts`, `site.ts`, `tools/shoot1.mjs`
and `tools/tilescan.mjs` are as you left them.

See `RESUME-PLAN.md` at the repo root.

---

# ROUND 2026-08-28T211056Z-5c6646cfe6a4 — first GPU pixels for the anti-tile arm,
# and the puddle rebuilt on the height field

GPU asserted each run: ANGLE (NVIDIA GeForce RTX 4060, D3D11), maxAnisotropy 16.
No shader compile or link failure in any capture.

## 1. `tools/tilescan.mjs`, run for real. The 17 m period is confirmed.

Nadir scans at two independent open-ground positions, 0.0501 m/px, 80.2 x 45.1 m
of world per frame. The inferred period was right and it is not a lattice
artefact: it lands on 17.0 m in three separate render variants and at both
positions.

    notile      world X   16.99 m  r=0.108      (0.0% off the 17.0 m dirt tile)
    notile      world X   17.10 m  r=0.107      (0.6% off)
    notile      world Z   16.98 m  r=0.119      (0.1% off)
    albedoonly  world X   17.18 m  r=0.320      (1.1% off)
    albedoonly  world X   17.16 m  r=0.309      (1.0% off)
    bumponly    world X   17.00 m  r=0.028      (0.0% off)

The 27.0 m peaks that appear alongside are the anti-tile arm's own alternate
sample (17.0 / 0.63 = 27.0 m), i.e. the fix's fingerprint, not a second bug.

## 2. Whether the bump repeat is broken: yes on this evidence, with a caveat
##    I would rather state than let someone else find.

`bumponly` — macro albedo and macro roughness both forced to zero, so the frame
is carried by the normal map alone — peaks at r = 0.021 to 0.028 across both
positions and both axes. `albedoonly` peaks at r = 0.295 to 0.377. The bump's
residual periodicity is an order of magnitude under the albedo's.

The caveat, because this is the flattering direction and flattering numbers earn
more suspicion: r is normalised per variant, so comparing r across variants is
suggestive rather than rigorous, and `bumponly` is a low-variance frame in which
uncorrelated sampling noise sets a floor. This round's captured output did not
retain the `bumponly` + `notile` baseline line, so I can quote the ratio between
bump and albedo but not, from this round alone, the improvement factor for the
bump arm against itself. The previous CPU-side round measured 4-5x. Anyone
re-running should redirect the whole of tilescan's stdout to a file; the summary
lines are at the top and scroll away.

On the inherited 45.9 m selection mask: having seen the pixels I agree with the
decision. The mask does not appear as a peak in any variant at either position,
and the argument for moving all three arms together stands.

## 3. The puddle was a decal, and the reason was geometric, not cosmetic.

The previous shoreline was baked into the soil field. Two things compounded, and
both are invisible when reading the source:

  - the field is 0.47 m per texel, bilinear, so no threshold in it can draw an
    edge sharper than half a metre; and, much worse,
  - these dishes are 60-90 mm deep and 5 m across. The measured fall at the
    waterline is 15.5 to 28.6 mm per metre (`.shot-build/shoreline.mjs`). A
    height tolerance of 55 mm — which reads like a tight number — is therefore
    two to three metres of ground. The whole puddle was edge.

On top of that the code multiplied the result by `smoothstep(0.85, 1.6, r)` on
the ellipse radius, adding a second and larger radial gradient, directly under a
comment claiming the ellipse was only a gate.

Standing water is now clipped per pixel in `wdPool` (worldDetail.ts) against the
fragment's own `vWDetailPos.y`. The ellipse is a hard 0.94..1.06 gate that
contributes no shape; the outline comes from the pavement's crown, ruts,
undulation and trough. Four fixed `uPool0..3` + `uPoolY` slots rather than a
GLSL array, because `uniform vec4 name[4];` puts the size after the name and the
one-line uniform table cannot express that — the table's assertion is worth more
than the syntax.

## 4. The margin jitter, and a trap worth writing down

Displacing the *wetness* blurs a gradient. Displacing the *water level in metres*
moves the intersection of a plane with a slope, so the margin travels sideways.
At 15.5 mm/m, ±4 mm of level is ±0.26 m of shoreline against a transition that
spans 0.21 m — raggedness that exceeds the softness it is breaking up.

The first version drew that jitter from `uMacro` and produced a visibly *smooth*
edge anyway. `uMacro` is a 512px tile mapped over tens of metres; asking it for
metre-scale features samples it at ~50x its design frequency. That survives at
nadir and dies at grazing incidence — the only angle a puddle is ever seen from —
because the pixel footprint on a near-horizontal surface is enormously elongated,
the sampler climbs the mip chain, and the tap converges on the tile mean. A
displacement that silently becomes a constant is worse than none: the edge stays
smooth while the source says it is broken. Replaced with `wdWobble`, two
domain-warped sine products, no mip chain. **This is a new NOTES.md case if
someone wants to write it up: "a world-space noise tap that is correct at nadir
and constant at grazing incidence".**

Verified in pixels: the shoreline in `rim.png` is hard and wanders. Compare the
same crop across `2026-08-28T205025Z` (geometric clip, macro jitter — hard but a
smooth arc) and `2026-08-28T205538Z` (analytic jitter — hard and broken).

## 5. New pose `rim`

`fringe` and `puddle` are both grazing views from 12-15 m, where the entire wet
region collapses into a band ~40 px tall against the horizon. Fine for "is there
water", useless for judging its edge, which is the deliverable. `rim` stands 6 m
off the 12.5/10.4 spot, into the light, at ~1 cm per pixel on the near shoreline.

Pose-hunting notes so nobody repeats them: 22.6/38.2 is the largest low spot but
sits hard against `PAD.maxZ`, so every camera behind it stands in the vegetation
belt; -3.5/31.6 is under the store's front wall (`BUILDING.minZ` is 31.5). Only
12.5/10.4 can be shot close and into the light from inside the lot.

## 6. Verified in pixels vs CPU-only

Pixels: the 17 m period; the bump/albedo periodicity ratio; the geometric
shoreline; the analytic jitter; the wet arm's footprint (25% of the `rim` frame
moves between the default and `?tforce=nowet`, localised by
`.shot-build/wherediff.mjs`); the softened swale, which no longer reads as a
canal in `verge.png`.

CPU-only: the `groundSoil` service's agreement with the GPU has *not* been
re-probed since standing water left the baked field. `soilprobe.mjs` compares
against the `soilviz` render and will now disagree at the waterline by design —
the CPU `wetness()` runs the same analytic pool test but without the shader's
jitter. Interior and dry ground still agree exactly. Re-run it and update its
tolerance before trusting the margin figure.

## 7. Next, in order

1. The pool interior is a flat featureless sheet. That is the reflection, and it
   is Lighting's PMREM world capture; do not tune it before that lands.
2. Wet asphalt darkening away from the pools — item 3 of the queue, untouched.
3. `soilprobe.mjs` tolerance, per §6.

---

# ROUND 2026-08-28T214638Z-3dd5184b63de — wet reflections against the real
# environment (full six-pose round; 2026-08-28T215402Z-29255601371c re-verifies
# after the dispose fix below)

GPU asserted every launch: ANGLE (NVIDIA GeForce RTX 4060, D3D11), anisotropy 16.
No shader compile or link failure.

## 1. What the PMREM world capture is worth, measured

A/B on the same bundle, default versus `?worldenv=0`, differenced with
`.shot-build/wherediff.mjs`. In `fringe` the single strongest 16x16 block in the
whole frame is at (768, 442) with a mean difference of **124/255** — that block
is the puddle. Sky-only renders it as one flat pale wash; the world capture
renders the reflected tree line, broken up by the ripple. Crops kept at
`.shot-build/f_world.png` and `.shot-build/f_sky.png`.

In `rim` the same A/B is small, because that pool's mirror direction points at
open sky above the horizon where the two environments agree. Both results are
what they should be, and the pair together is better evidence than either alone.

## 2. Three changes, and why each one was necessary rather than a preference

**`uSpecDirect` and `uSpecIBL` were exactly backwards on water.** They sit at 0.4
and 0.6 on asphalt for good reasons — GGX over-predicts grazing reflectance on
rough natural surfaces, and a large near-horizontal surface otherwise mirrors the
whole bright dawn horizon. Water is neither of those things. It is a dielectric
with F0 near 0.02 and F90 of 1.0, and it is only ever seen at a grazing angle,
which is exactly where Fresnel takes it to near-total reflection. Damping F90 to
0.4 and the environment to 0.6 removed the entire effect at the one incidence
that matters. Both are now ramped back to unity with the wet mask, across the
full range and not only at the pools — the sheen on damp pavement between the
puddles comes from the same term, and that sheen is most of what makes queue
item 3 ("wet asphalt from last night's rain") read.

**Roughness at the pools: 0.17 to 0.055.** The 0.17 was explicitly provisional
and explicitly conditional on the environment; with a world in the PMREM the
highlight has structure to break against and water can be as smooth as water is.

**Depth, not coverage, drives all three wet arms.** This was the correction that
mattered most. First attempt keyed the mirror on pool coverage, which is binary
a centimetre either side of the shoreline, and the pool came out as one flat
pale sheet with a cut edge — sheet metal, not water. `wdPool` now records depth
in metres in a file-scope `wdDepth`, and roughness, the Fresnel ramp and the
water normal all grade over the first 18 mm, which on these slopes is the first
half-metre inside the margin. Gritty and merely damp at the shore, glass in the
middle. That gradient is what a shallow puddle *is*, and it is also what stops
the near edge from reading as a cut.

**Ripple.** A geometrically perfect pool is a mirror, and a mirror is the second
way for a puddle to read as a decal. `wdRipple` gives it about a degree of tilt
from the same analytic wobble the waterline uses, so the sun returns as a streak
rather than a disc. First amplitude was 7x too high and read as brushed fabric;
the frequency was also too low. Now 1.7 and 5.3 per metre at a gradient limit of
about 0.005.

## 3. Cost, for the performance agent on 5152

Nothing here allocates. **No render target, no second pass, no per-frame
allocation of any kind** — the reflection is the existing `scene.environment`
consumed through three's own IBL path, and everything I added is ALU (four
`sin`s per wobble, three wobble evaluations for the ripple) plus five `vec4`
uniforms. Draw calls and triangles are byte-identical between the default and
`?tforce=nowet` in the same bundle: 219 draws / 2,296,197 tris on `rim` either
way. The triangle growth visible across tonight's rounds (2.02M to 2.30M on
`rim`) is vegetation landing, not this.

`__TERRAIN` now reports texture footprint as well as counts:

    {"meshes":11,"triangles":413156,"materials":8,
     "textures":20,"textureMB":202.7,"renderTargets":0}

Bytes rather than count, per NOTES "A count is not a size". **202.7 MB is a lot
and it is worth someone's attention**, though none of it is new tonight.

## 4. A real leak in this system, found while measuring the above

`dispose()` freed geometry, materials and the four `SurfaceMaps`, and nothing
else. The macro noise, the site overlay and the soil field — three of the
largest single textures the system owns — were never released, because they are
bound through the world-detail uniform table rather than through a
`material.map` slot, so nothing that walks material slots can see them. Invisible
within a session; unbounded across navigations, which is precisely the shape of
the accumulation being investigated. Now every texture found by the accounting
walk is retained in `ownedTextures` and disposed. Verified no render regression
in `2026-08-28T215402Z-29255601371c`.

I am not claiming this is the browser crash. I am saying it is a genuine
per-navigation leak in the system that covers the entire scene, and it is fixed.

## 5. Written up as asked

Two cases appended to `NOTES.md` (they are the 28th and 29th sections; the file
does not number its headings, so cross-references are by title):

  - *A tolerance is meaningless until it is converted into the units the feature
    lives in* — the 55 mm case. Divide the tolerance by the local gradient
    before accepting it.
  - *A texture sampled far above its design frequency is correct at nadir and
    constant at grazing incidence* — the `uMacro` case, cross-referenced to
    "An experiment can silently not run and report the baseline twice" and "A
    term that cannot reach its target at 8x is in the wrong place, not too weak",
    which share the underlying hazard.

## 6. `soilprobe.mjs` now states where it is wrong

Per-channel tolerance floors, and the wetness channel carries `fringe: true`.
Every run prints, whether it passes or fails, that the wetness r is not a
shoreline accuracy figure: the shader jitters the water level by +/-4 mm (about
+/-0.26 m of margin here) and the CPU accessor deliberately does not, so the two
are exact inside a pool and on dry ground and disagree in a band about half a
metre wide at each waterline.

Current run passes comfortably, which is itself the useful result — the
divergence is small in practice and the 0.42 floor is conservative:

    lot   wetness  r=0.820  margin +0.625   (flipV -0.072, flipU 0.195)
    verge wetness  r=0.963  margin +0.224
    lot   material r=0.569  (lowest of the six; floor 0.55)

## 7. Next

1. `material` at the lot is r=0.569 against a floor of 0.55. It passes but it is
   the weakest pair and it has been for two rounds; worth a look before it fails.
2. The reflection has no near-field content — a pool six metres away should show
   the kerb and the pumps behind it, and a single-point PMREM cannot know that.
   Not worth a screen-space pass for four puddles, but say so rather than
   letting someone read it as a bug.
3. Queue item 3 is now largely carried by the Fresnel ramp on damp pavement.
   Worth a dedicated look at whether the damp *extent* is right, separately from
   whether its shading is.

---

# Round 2026-08-28T223322Z-05fe6e3f175b (far ground, damp pavement, edge)
# and 2026-08-28T224102Z-693cb89dffe5 (memory correction)

Answering an independent critic that saw frames only. Two of its findings were
this system's and both were untouched.

## 1. "The plane is so flat it takes no relief lighting at all"

Correct, and the reason was measurable rather than aesthetic. The far ground
carried two height terms and neither operated at the scale that shading cares
about:

| term         | dominant wavelength | amplitude | slope   |
| ------------ | ------------------- | --------- | ------- |
| `swell`      | 600 m+              | 2-4 m     | ~0.006  |
| `undulation` | 78-100 m            | 0.42 m    | ~0.006  |
| sun          | -                   | -         | 0.194   |

Shading responds to slope, and slope is amplitude times spatial frequency, not
amplitude. Both terms sat a factor of thirty under the solar tangent, so every
surface in hundreds of metres faced the sun at within a fraction of a degree of
every other surface, and the ground returned one value. Adding height would not
have fixed it; adding height *at the right wavelength* did.

The new `hum` term in `dirtY` sits at 16-31 m for a total relief under a metre.
That is slopes of 0.10-0.20, bracketing the sun, so crests light and back
slopes fall away and each crest throws two to three metres of shadow downsun.
It is the cheapest realism in the system so far: no triangles, no textures, no
draw calls, and it changes hundreds of metres of frame.

The lower bound is set by the mesh and not by taste. The native ground is 840 m
over 340 segments, 2.47 m per quad, so anything under ~12 m has fewer than five
samples per cycle and turns into camera-dependent faceting. Finer relief out
there has to be bought with vertices; if anyone wants ruts and clod-scale
shadow (the critic asked for both, and it is right that they would read) that
is a mesh decision, not a height-field one, and it should be a separate
near-field patch rather than a global subdivision of an 840 m plane.

Also added, in the same place and for the same reason: the **berm** behind the
highway swale. A ditch has a bank because the spoil went somewhere, and its
back slope is ~0.19, which is the solar tangent. It gives 700 m of frontage a
lit edge and a dark edge.

## 2. The dead-straight pavement edge

`ragEdge`'s three octaves topped out at 0.37 cycles/m - a scallop every 2.7 m.
That is invisible past about fifteen metres, so from a standing eye the edge
went back to a ruled line, which is what was reported. Added a fourth octave at
0.055 (~18 m, a paving train's wander) carrying most of the weight.

**Total weight is renormalised, so maximum excursion is still `amp` = 190 mm.**
That is deliberate: `VegetationSystem` reasons explicitly about the 190 mm
figure when deciding where weeds may straddle the pavement line, and changing
the number silently would put tufts on the asphalt. If Vegetation is willing,
raising `amp` on the two road calls would buy a lot more; it is a two-character
change and it is theirs to agree to, not mine to take.

## 3. Queue item 3 - damp pavement between the pools

The critic was right that asphalt near the pools was the same value as asphalt
anywhere else. The wet channel of the soil field is drainage-keyed: it models
where water *collects*. Rain does not collect, it lands, so a lot that was
rained on is damp everywhere and merely wettest in the hollows.

New `wetBase` on the asphalt materials (0.34), modulated by a 34 m patchy
dry-off and leaned toward low ground. It drives three arms together, which is
the whole point - the critic's own description was that wet asphalt goes darker
in shadow and much brighter toward the sun, and that only happens if albedo and
roughness move at once:

- albedo down (`mix(1.0, 0.52, wdDamp)`) - the shadow half
- roughness toward 0.42 - concentrates the highlight instead of spreading it,
  which is the sunward half
- `uSpecDirect` / `uSpecIBL` ramp - already in place from the pool work

Deliberately pavement-only. Asphalt is near-impermeable and holds a film for
hours; the soil beside it drank the same rain and was touch-dry by first light.

**Kept out of `s.b`, i.e. out of the published `groundSoil.wetness`.** That
channel is the service the probe checks against the CPU accessor, and this is a
property of one material rather than of the ground. Folding it in would have
made `soilprobe` disagree about something the service never claimed. It rides a
file-scope `wdDamp` instead. `soilprobe` still passes: worst pair r=0.572
(`lot material`, floor 0.55), lot wetness r=0.829.

### The failed first attempt, because it is a repeat of a known shape

The first version keyed the dry-off on `clamp(0.5 + (0.5 - drainage) * 2.2, ...)`
- i.e. centred the multiplier on 0.5, so full damp only in hollows. The lot is
crowned, so there are no hollows, so the term evaluated to ~0 everywhere and
the capture was **indistinguishable from the `tforce=nowet` control**: 1.73% of
pixels changed at all. Recentred on 1.0 and the same comparison moves 18.35% of
pixels at mean 10.95.

Worth noting that the A/B is the only reason this was caught. The frame looked
plausible; it was plausible before the change too. A feature that does nothing
and a feature that does something subtle are the same screenshot.

## 4. The pale ovals - confirmed, they are the puddles

- `wide_golden.png`, pale grey oval on asphalt right of the building:
  `LOW_SPOTS[0]` at x=22.6, z=38.2. The building's right edge is x=3.5 and the
  pad runs to x=26, so "right of the building" locates it exactly.
- `rim.png`, pale lens on the road surface: `LOW_SPOTS` at x=12.5, z=10.4. The
  `rim` pose was authored to look at that spot from six metres.

Both are pre-depth-gradient standing water: binary coverage keyed to a mirror,
which is why they read as feathered decals corresponding to no object. They now
have depth-graded roughness and Fresnel and a chewed margin. No stray decals in
this system - nothing else in it draws a feathered ellipse.

## 5. The 202.7 MB figure was wrong, and the correct one is 138.7 MB

Withdrawing my own number. The accounting de-duplicated by `Texture` identity.
The lot's asphalt maps are `clone()`s of the highway's, which makes them three
distinct `Texture` objects sharing one `source`, one GPU upload and one
allocation - and the renderer keys its upload cache on `source`, not on the
texture. Every clone was counted as a fresh 22 MB.

Corrected: `__TERRAIN` now reports `textures: 20, uploads: 17, textureMB: 138.7`.
A measurement handed to another agent as grounds for a change has to be right,
and this one was inflated by 46%.

### Judgement on halving, since it was asked for

**No on the asphalt set, yes on the site overlay.**

There are three 2048² ground maps, not six: `makeAsphalt(2048, 8)` produces
albedo, normal and roughness, and the fourth 2048² is the site overlay. Dirt,
dirt-fine, concrete and paint are all 1024².

Asphalt is 2048² over an 8 m tile, i.e. 3.9 mm/texel. Its finest authored
feature is `aggFine` at ~7 mm - **1.8 texels wide**. Halving puts it at one
texel and it stops existing. That is precisely the foreground aggregate grain
the critic singled out as the thing in these frames that holds up, and it is
visible at full strength in `puddle.png` and `rim.png` because the camera is
0.9 m above it. Halving it would trade the best-surviving detail in the system
for 33 MB.

The site overlay is a different case: 2048² over the 92 x 66 m `OVERLAY_REGION`
is 45 mm/texel and it carries broad wash and stain only. Halving to 1024² costs
90 mm/texel on features that are metres across. That is ~17 MB for nothing
visible, and I will take it whenever the performance agent wants to call it -
say the word and it is a one-line change plus a capture.

Grazing angle is not an argument for halving here. Anisotropic filtering is
already at 16 and the mip chain handles the distance; the resolution is being
spent on the near field, which is the one place these planes are seen at nadir.

## Standing note: the pool reflection has no near-field content

Agreed and left. The PMREM is a world capture from one point, so a puddle
reflects the canopy, the building and the tree line but not the ground
immediately beside it or anything that moves. A screen-space pass would fix it
and is not worth it for four puddles at this scene's scale. If a future shot
puts a puddle in the foreground with something standing next to it, revisit.

## Still open

- `lot material` r=0.572 against a 0.55 floor, weakest pair for three rounds.
  Not failing, but it is the one that will fail first.
- Truck tracks cutting the driveway corners: the critic asked for them and they
  are right, but at 2.47 m per quad they cannot be geometry out there. They can
  be disturbance in the shading (no cast shadow) or a locally finer mesh patch
  near the entrances (cast shadow, costs vertices). Not attempted.
- A fence line. Asked for, not this system's to place.


---

# Rounds 2026-08-28T230220Z-2fa201909743 (graded mesh, churn)
# and 2026-08-28T231102Z-c915a2c3941d (+ same-bundle nowet control
#     2026-08-28T231538Z-c915a2c3941d)

## 1. The pale ovals are finished

They were the puddles, and the reason they read as decals turns out to be one
line rather than a look. Coverage steps at the shoreline - correctly, because
whether there is water somewhere is genuinely binary - and three separate arms
were reading their strength off coverage rather than off depth:

    roughness:  mix(rough, 0.055, smoothstep(0.55,0.92,sWet) * (0.35 + 0.65*depth))
    specular:   wdSheen came from wdDamp, which was max(field, POOL COVERAGE)
    albedo:     same wdDamp

So the first covered pixel arrived at 35% of a mirror, 45% of the Fresnel ramp
and full wet albedo, while its neighbour a millimetre away was damp asphalt.
That is a roughness discontinuity of about 0.13 and a specular step of 0.18
running all the way round the pool: a hard rim with a soft fill, which is
exactly what "feathered decal following no geometry" describes.

Every water arm is now a function of depth alone and is zero at zero depth by
construction. Water zero millimetres deep is wet ground, so at the waterline
each arm must equal what the ground was already doing, and it does. The pool
is excluded from wdDamp for the same reason.

Added with it: **the waterline as a signed band** (wdRim, straddling zero
depth), darkening 30% and pushing roughness up rather than down. Saturated,
unsubmerged ground has no air in its pores and nothing on it to reflect, so it
is the darkest and flattest thing in the frame. It is also the cue that says
"in the pavement" rather than "on it", because a decal has no reason to have a
dark outline and a puddle cannot avoid one.

Also fixed: the ripple was a product of two axis-aligned sines, which is a
checkerboard. Domain warping bent the cells but left them aligned, so the
highlights formed a regular filigree that read as hammered metal. One octave
rotated 37 degrees removes the alignment for the cost of four sines.

rim.png now reads as water at 2x crop: broken specular streaks, visible
substrate at the shallow edge, a dark margin, and tonal range across the dish.

## 2. The near-field mesh decision - graded, not patched, and here is the cost

**Measured: 413,156 -> 534,756 terrain triangles, +121,600 (+29% of this
system, about +4% of the ~3.0 M scene).** Ground spacing measured from the
built geometry and published in __TERRAIN.groundSpacing: **0.65 x 0.62 m over
the site, 3.58 x 3.42 m beyond it** (previously 2.47 m uniform everywhere).

I did not build a patch. A patch is the obvious shape and it is wrong here: two
meshes at different tessellations sampling the same height field disagree by
the chord error of the coarser one, which on this terrain is about 59 mm, so a
detail patch laid over the plane interpenetrates it. Fixing that needs a cutout
with matched seam vertices and T-junction decimation, which is real work and
leaves a seam to maintain forever.

Instead the single 840 m ground mesh is now **graded**: gridSurfaceGraded packs
vertices toward the site by integrating a density function and inverting it,
with the density ramping out over 2.6x the focus radius so no row of quads is a
visible transition. One mesh, no seam, no T-junction, nothing to z-fight. A
ratio of 1 reproduces a uniform grid exactly, so it is one constant away from
being reverted.

Where the vertices went: focus on the pad centre, half-widths 50 x 45 m, which
bounds the region every authored pose stands in or looks across.

### What 0.65 m buys, and what it does not

It resolves 2-3 m features: corner-cut depressions, spoil mounds, erosion
channels, and a vehicle track pair read as one worn hollow, which is what you
see of a track from ten metres. **It does not resolve an individual 0.3 m tyre
rut** and no full-site mesh will; that needs ~0.15 m spacing, which is another
factor of 18 in vertices over the same area. If individual ruts are wanted they
should be a small number of authored strips near the entrances, not a global
resolution increase.

### The new relief, and the Nyquist rule a graded mesh imposes

`churn` in dirtY: 0.13 m of relief at 3-5 m wavelengths, gated off beyond about
62 m by nearFade. The gate is not tidiness. A graded mesh has a
**position-dependent Nyquist limit**, so a term that is correct over the site
is one sample per cycle beyond it and would render as facets crawling with the
camera. A uniform mesh let us ignore this; a graded one does not, and anyone
adding to dirtY from now on needs to know which zone their wavelength lives in.

### Verified without rendering

`.shot-build/slopescan.mjs` runs the NOTES.md test directly on the height
field - the claim is about slope against tan(sun elevation), and that is
checkable in a second and cannot come back "plausible":

| region                     | mean slope before | after | steeper than the sun |
| -------------------------- | ----------------- | ----- | -------------------- |
| site, sampled at 0.63 m    | 0.042             | 0.096 | 4.3% -> 9.2%         |
| beyond, sampled at 3.5 m   | 0.024             | 0.058 | 0.5% -> 0.5%         |

Note the honest half of that: **the far field gained no cast shadows.** Its
"steeper than the sun" fraction is unchanged - the only things out there that
break the solar tangent are the swale, the berm and the pavement lip. What it
gained is Lambert falloff, and at this sun that is worth more than it sounds:
at 11 degrees the incidence cosine is 0.19, so a 3.4 degree tilt swings it by
about 30%. The banding visible across hundreds of metres in verge.png is that
swing, not shadowing. Near-field terminators did roughly double.

## 3. Queue item 3 is the damp film, and it is done

Confirming it is not a separate item: wet asphalt darkening away from the pools
IS the residual film landed last round. Verified this round against a control
captured **from the same bundle** rather than from an earlier round:

    bundle c915a2c3941d, tforce=nowet vs default
      rim.png : 53.47% of pixels changed, mean 10.86
      lot.png : 16.99% of pixels changed, mean  1.89

## 4. The 276 MB in six anonymous 2048 maps is not mine, and the arithmetic says what it is

This system holds **four** 2048 maps, not six: asphalt albedo/normal/roughness
plus the site overlay. All are 8-bit RGBA. Six 2048 8-bit RGBA maps with mips
come to 134 MB, which is half the reported figure, so whatever those are they
are not byte textures.

    2048^2 x  4 bytes x 4/3 mips = 22.4 MB each  -> six = 134 MB
    2048^2 x  8 bytes x 4/3 mips = 44.7 MB each  -> six = 268 MB
    2048^2 x 16 bytes x 4/3 mips = 89.5 MB each  -> six = 537 MB

276 MB across six maps is 46 MB each, which matches **RGBA16F with mips** and
nothing else. Half-float 2048 cubes or equirects with mip chains are what an
environment capture allocates, and a PMREM world capture went in tonight. That
is where I would look first. Nothing in TerrainSystem allocates a float texture
of any kind.

## 5. Harness changes, both of them other people's findings

- **Per-shot assertSceneGpu.** The launch check ran once on a throwaway canvas;
  a six-pose run allocates and frees the whole scene six times, which is
  exactly when the card runs out and the context is lost, and a lost context
  keeps calling the animation loop and keeps producing files.
- **Capture dimension assertion.** Everything in assertFrameIsLit is a mean,
  the mean of no pixels is NaN, and every comparison against NaN is false - so
  a 0x0 or truncated PNG passed every content check and was reported healthy.
  Now checked first, because it is the one failure the rest cannot see.

## 6. Not tuned against the current ambient

Lighting's ambient change is visibly in the tree: between round 2fa201909743
and the earlier ones the shaded ground rose from low=36+/-18 to 46+/-17 and the
black fraction fell from 17% to 4%. The new relief reads differently under it
and I have deliberately left it alone until that settles.

Also seen in __SYSTEM_ERRORS on both of tonight's last rounds, not mine and
passed on: "lighting.init: contact-hardening patch failed to install (pcss:
BASIC branch not found); reverted to PCF".

## Still open

- Individual tyre ruts and a gravel apron at the entrances. Needs authored
  strips, not more global resolution - see the cost note above.
- A fence line. Asked for by the critic, not this system's to place.
- `lot material` r=0.572 against a 0.55 floor. Weakest probe pair for three
  rounds.
- Raising ragEdge amplitude above 190 mm, pending Vegetation.
- Halving the site overlay to 1024 for about 17 MB, pending Perf.

---

# Round 2026-08-28T233550Z-9cdd77d5fb4a — the accumulation service, entrance tracks, debris

RTX 4060 verified per shot from the live context. 8/8 shots passed the health
gates. No shader compile or link errors. `renderTargets: 0`. Ports 5131/5132
clear, no orphaned Chromium, no orphaned preview. Tree typechecks.

## `groundAccum` — the contract, for broadcast

Published as `game.provide("groundAccum", ...)` from `TerrainSystem.init`, built
in `src/gen/groundAccum.ts`. Pure CPU, no renderer state, no textures, safe to
call a hundred thousand times before the first frame. Same shape as
`groundSoil` because the same argument applies.

**Two kinds of entry point, and the split is the design.**

*Fields* answer "what is on the ground here". They cannot know about a caller's
geometry, because Vegetation places crowns and Building places walls long after
this is built, so they are made out of the ground: drainage, slope, traffic and
one prevailing wind.

| call | returns | measured over the lot |
|---|---|---|
| `shelter(x, z)` | 0..1, how still the air is — hollows, the swale, inside the curb line | mean 0.26, 51% active |
| `fines(x, z)` | 0..1, loose fine matter: dust, silt, grit. The general "dirtiness of this patch" | mean 0.22, 99% active |
| `litter(x, z)` | **items per square metre** of wind-blown paper | mean 0.0030, peak 0.113, 29% active |
| `grime(x, z)` | 0..1, dark organic film where water stands *and does not move* | mean 0.014, 10% active |
| `swept(x, z)` | 0..1, swept clean by wheels and feet | mean 0.14, 25% active |

*Profiles* are pure functions you evaluate against geometry only you know. No
registration, no ordering constraint between systems, nothing to go stale when
you move something.

| call | returns |
|---|---|
| `lee(x, z, ox, oz, radius)` | 0..1 wake weight downwind of a round obstacle. Measured 0.98 at the obstacle, 0.76 at 2 m, 0.23 at 5 m, 0 at 9 m, 0 upwind, for radius 1.5 |
| `wallBase(distOut, up, faceX, faceZ)` | `{ splash, drift }`, both 0..1. Splash 0.99 at grade and 0.06 at 0.5 m up — it lives *on* the wall and dies with height, and prefers the face driven into the weather. Drift 0.50 at the wall and 0.04 at 0.25 m out — it lives *out from* the wall on the ground and prefers the sheltered face. They are deliberately opposite |
| `underCrown(x, z, cx, cz, radius)` | 0..1 fall accumulation. Measured 0.12 at the trunk, 0.75 peaking at 0.72R, 0.24 at the drip line, 0 by 1.35R, with the whole pattern displaced downwind |
| `jitter(x, z, salt)` | deterministic 0..1 hash, so you can break up a field without seeding an RNG and without two systems sharing a sequence |
| `wind` | `{ bearing, dirX, dirZ, strength }` |

**The intended use is a product.** Sample a field for how much matter this patch
of ground gets at all, multiply by a profile for how your own object
concentrates it. A crown over swept pavement should drop less than the same
crown over a sheltered corner, and only you know there is a crown while only
this knows the pavement is swept.

**`litter` is a density, not a probability,** on purpose: multiply by your own
cell area and you get a count, and a consumer working at a different cell size
gets the same expected count. Over the lot it integrates to about 34 items.

**Wind is now `site.WIND`,** one constant, bearing 2.9 rad. That is
`VegetationSystem`'s existing local value adopted verbatim rather than
re-authored, so the trees that were already leaning keep leaning the way they
lean — Vegetation should switch its local constant to the import when
convenient. Four systems have to agree about wind or the scene contradicts
itself: tree lean, litter drift, the lee of every obstacle and any smoke all
point one way in a photograph, and a viewer reads a disagreement long before
being able to say why.

**No texture and no shader path, deliberately.** The consumers are scatter
passes. The ground's own dust and grime come from drainage, wetness and slope
in-shader — the same inputs these functions are built from — rather than from a
fifth field channel, because the soil field's four channels are full and a
second 2048² field would cost 22 MB to say something the shader can compute.

## Dogfooded, because a service nobody renders is a service that does not work

Terrain now scatters its own debris entirely through those calls, so the
distribution comes out wrong in my pixels before it comes out wrong in anyone
else's. Every rejection test in `scatterDebris` is a call a consumer will make.

- **Gravel spill:** 1500 half-buried stones from 13,977 candidates, accepted by
  `fines` alone with no local rules. Two thirds of candidates hug a pavement
  edge, which is where real spill is — it comes off the pavement and the wind
  rolls it to the first thing that stops it. This also softens the
  dead-straight pavement edge the critic named.
- **Litter:** 26 items, placed by multiplying `litter` by a cell area. Geometry
  is a *bent* card, not a flat one: flat paper at a low sun has no face turned
  toward the light, which is the slope-versus-solar-tangent argument again at
  100 mm.

**Cost: +30,104 triangles (1500 × 20 + 26 × 4), +2 draw calls, 0 bytes of
texture.** Terrain 534,780 tris; scene 3,180,018. Texture memory unchanged at
138.7 MB.

## Entrance tracks — and the control that caught them doing nothing

Shipped, but the interesting part is the two-arm measurement, and I have added
`?force=noruts` as the forced-off arm this needed. Sequence:

1. First version: authored against the driveway flanks, 3.4 m of swing, 0.095 m
   deep. Slope census over the entrance strips came back **within 0.002 of the
   forced-off arm** — a feature doing nothing, caught by the control and by
   nothing else, exactly as the absence case predicts.
2. Two separate errors, found by asking where the height field moved rather
   than by tuning. **(a)** 3.4 m of swing across the 3.24 m between shoulder and
   pad is a 47° sweep: each wheel crossed several metres of ground and left a
   smear, not a groove. Narrowed to 1.2 m. **(b)** More importantly, **I was
   censusing `dirtY` and the mesh is built from `groundHeight`,** and across the
   entrance band those two disagree by up to **0.65 m** because `groundHeight`
   blends the apron in. The entrances are the one place on the site where the
   pavement blend is strongest, so a groove authored against the paving edge is
   erased by the very blend that makes the apron. Stood the tracks 2.2 m off the
   edge, where dirt starts winning.
3. After both: entrance strips mean slope **0.071 against 0.064** forced off,
   max slope **0.286 against 0.218**, and **4.0% against 3.0%** of samples
   steeper than the sun. The max is the number that matters — 0.286 clears the
   0.194 solar tangent, so the rut walls cast rather than merely shade.

Sized to the mesh rather than to life: 0.62 m half-width is two samples at the
graded mesh's 0.63 m near spacing, the narrowest a groove can be here and still
be a groove rather than one vertex of noise. A real 0.3 m rut needs 0.15 m
spacing. Depth 0.13 m with wear varying along the run, because a rut that is
uniformly deep for its whole length reads as a moulding.

## Two probe bugs worth naming, both mine

- **The `lee` test measured the axis, not the feature.** I walked the test
  points along +X and read 0 at 3 m downwind, which looked like a broken wake.
  +X is *upwind* here; the function was right and the probe was wrong. A probe
  that does not use the axis the feature is defined on measures the axis.
- **`litter` first integrated to 9.7 items across a hundred metres of frontage,**
  which is a tidier lot than any real one. Coefficient raised 0.062 → 0.22.

The probe asserts `Number.isFinite` across every sampled value of all five
fields and throws on any non-finite, and prints `n` beside every statistic.
Both are consequences of tonight's NaN case rather than good habits I already
had.

## `NOTES.md`

Two cases appended.

**"A threshold comparison is not a check unless something rejects non-finite
input."** In the form asked for: every content check is a mean, the mean of no
pixels is NaN, every comparison against NaN is false, so a zero-dimension frame
satisfied every health assertion and reported healthy. Written as a general
defect in how this project writes guards, with the list of ordinary things that
produce a NaN or an Inf — a mean over a zero count, normalising by a collapsed
range, acos/sqrt/log one epsilon outside its domain, a correlation coefficient
where one series has no variance, anything back from a shader. The correlation
case is called out as the dangerous one, because **a guard written to catch a
broken feature is defeated by the value the broken feature produces.** Ordered
rule: reject shape and emptiness first, reject non-finite explicitly and as a
distinct diagnosis second, compare against thresholds only third — written the
other way round the sanity check never runs, because the threshold already
passed. Ends on the reporting habit: print n beside the statistic, because a
statistic without its n is not a measurement.

**"Two tessellations of one height field do not agree, so detail patches
interpenetrate."** Chord error goes as the square of the span, so two meshes
sampling the same field disagree everywhere except at shared vertices — 59 mm
here — and the sign alternates, so no offset fixes it. Grading the single mesh
instead: one mesh, no seam, no T-junction, nothing to z-fight, and ratio 1
reproduces the uniform grid exactly so it reverts with one constant. 0.65 m over
the site against 3.58 m beyond for 121,600 triangles, where uniform 0.65 m
would have been about 3.3 million. The position-dependent Nyquist consequence
has its own subsection and is stated as a new *obligation*: a graded mesh has a
different sampling limit in every region, near-field relief at 3-5 m
wavelengths is eight samples per cycle over the site and one beyond it, so it is
gated off past 62 m — and without the gate it would not read as relief, it would
read as facets crawling, which is the worst kind of artefact because it is
invisible in a still and obvious in motion.

## Answers and acknowledgements

- **No warmth-in-shadow gate exists in any of my harnesses.** I checked
  `shoot1.mjs` and `soilprobe.mjs` for hue and channel-ratio assertions and
  there are none, so there is nothing to retire. This round is the first
  captured against the new ambient (sun 4.4, environment 2.4).
- **Far field: I am treating the banding as Lambert falloff, not cast shadow.**
  The fraction of far ground steeper than the sun did not move — 0.5% — so
  nothing out there occludes anything. At an incidence cosine of 0.19 a 3.4°
  tilt swings it 30%, which is plenty, but it responds to *broad* tilt and not
  to added relief, and I will not reach for wavelength out there again.
- **The pale ovals now read as water.** In `ground.png` the foreground pool has
  a rippled specular sheen, a warm sky reflection, and a litter card sitting
  half in it. From 12.5 m in `wide.png` they are faint pale-blue ellipses with
  hard boundaries, which is what a few per cent of Fresnel over dark wet
  asphalt looks like from above — water in a pan, not a feathered decal.
- Overlay halving at 45 mm/texel for about 17 MB: agreed, Perf's to take.

## Next, and one thing I am flagging rather than fixing

**The near-field `churn` term reads as a regular stipple at eye level.** In
`verge.png` the foreground dirt is dappled evenly enough to look like a pebbled
carpet rather than uneven ground. This is the *same error* I wrote up for the
water ripples earlier tonight: `churn` is two products of sines at fixed
frequencies, which is a lattice, and domain warping bends the cells without
unaligning them. The fix is the one that worked there — a third octave on a
rotated basis. I am not guessing at it in the last minutes of a round, because
a lattice replaced by a different lattice is another screenshot that looks
plausible. It needs a capture, and it is the first thing to do next.

Also outstanding: Vegetation switching its local `WIND` to `site.WIND`, and
whether Vegetation can accommodate a pavement-edge excursion larger than 190 mm.

---

# Round 2026-08-29T000730Z-96bc89ae274c — churn lattice, pavementEdge, island winding

RTX 4060 verified per shot. 8/8 shots passed the health gates. No shader compile
or link errors. `renderTargets: 0`. Ports 5131/5132 have no listener (TIME_WAIT
only), no orphaned Chromium, no orphaned preview. My files typecheck.

Terrain unchanged at 534,780 triangles, 138.7 MB, 20 textures / 17 uploads.
Debris 1500 gravel + 27 litter.

## 1. The churn lattice — fixed, and the diagnosis generalised

Rewritten from `sin(x) * cos(z)` with warped arguments to a sum of three
*directional* waves on bases rotated 37° and −61°, sharing no common period in
any direction. In `verge.png` the rectangular dapple is gone; the foreground
now has irregular cell sizes and orientations with visible track structure
running through it.

**One number worth keeping.** At equal nominal amplitude the rewrite *lost*
relief — near-field mean slope 0.087 against the old 0.096 — because three
summed waves partly cancel where a product does not. Scaled 1.18× to restore it:
now 0.093 mean, 8.2% of samples steeper than the sun. So a change of *pattern*
is not amplitude-neutral, and the slope census has to be re-run after one.

## 2. `pavementEdge` published — and `ragEdge` was not doing what its comments said

`game.provide("pavementEdge", { edgeZ(x, side), excursion, nominalZ(side) })`.
`edgeZ` calls the same `ragOffset` with the same per-side seeds that `ragEdge`
uses to displace the vertices, so it returns the line the geometry actually uses
rather than a model of it — agreement by construction, not by maintenance.
Excursion raised to 400 mm on Vegetation's answer.

**Then the 400 mm measurement came back at 649 mm and everything changed.**

The estimate that came with the request was that 400 mm over a ~1 m scallop
would put the edge line at a 40% slope. Measured at the road mesh's real 0.5 m
vertex pitch it was **649 mm of movement between adjacent vertices — more than
the entire declared excursion — for a 130% slope across one quad.** Removing the
two sub-Nyquist octaves did not help, which is what pointed at the real cause:

**`hash1` is a bare hash with no interpolation, so `hash1(t * 0.055)` is not an
18 m wave.** Those four "octaves" were the same white noise with four seeds.
Every vertex was an independent draw from the full envelope, which is why the
excursion set the *inter-vertex* jump directly and why no wavelength limited it.

Two consequences, both of which had already happened and neither of which anyone
had seen:

- **The critic's "dead-straight edge past fifteen metres" was never fixed.** The
  earlier response — add an octave at ~18 m and give it most of the weight —
  did nothing structural. It looked as though it had worked because the
  amplitude claim in that change was true and checkable while the wavelength
  claim was false and unmeasurable.
- **The sawtooth was present at 190 mm too**, at 300 mm of inter-vertex jump,
  and merely too small to name. Raising the excursion did not create the defect,
  it scaled a latent one into visibility.

Rebuilt on real value noise — hash the integer lattice, interpolate — at 18 m,
6.5 m and 2.2 m, all above the 1.0 m Nyquist limit of a 0.5 m pitch. Measured
after: **10% slope, 52 mm between adjacent vertices**, and for the first time
the edge genuinely wanders over tens of metres.

**For Vegetation: the geometry does not run out before your tolerance does.**
There is headroom at 400 mm and the number to reason against is `excursion`
from the service, not a constant. `RESUME-PLAN.md` §7 carries the correction.

## 3. Winding — the island confirmed and fixed, the curbs measured correct

`.shot-build/windcheck.mjs` censuses flank faces by dotting the winding normal
against outward, and reports per profile strip so a partial fix cannot hide.

- **`pump-islands`: 0 of 64 flank faces outward.** Confirmed inside out, exactly
  as Canopy's test reported. Reversing the profile takes it to **64 of 64**. In
  `lot.png` the island plinths under the pumps now have visible flanks; before,
  the pumps sat on nothing.
- **`curbs`: measured correct, and I believe Canopy's test has a false positive
  here.** All four runs pass `flip: false` and are authored lateral-outward, and
  the per-strip census confirms the outer flank at lateral 0.165 reads nz −1.000
  on the −Z run. The face reading **+1.000** is the one at lateral 0 — which is
  the *gutter* face, and it is supposed to look toward the pad. Canopy's test
  appears to assume the lateral-0 flank is the outer one; on a box section it is
  the inner one. Worth fixing in the test, because a test that flags a correct
  surface costs more trust than it saves.

**The root cause is shared and I did not fix it centrally, on purpose.** `flip`
negates the lateral direction, which *mirrors* the surface, and a mirror
reverses handedness — so every `flip: true` sweep is inside out and every
unflipped one is fine. The three-line fix in `sweepProfile` is written out in a
`WINDING HAZARD` comment in `geo.ts` but **not applied**, because
`canopyParts.ts` already compensates locally by reversing two profiles with a
comment explaining why, and changing the shared function now would double-invert
Canopy's fascia and coping. Both callers should migrate in one commit by whoever
owns both. Until then the convention is documented: **`flip: true` requires a
reversed profile.**

Why it hid for eight rounds: back-face culling makes a reversed surface
**invisible rather than wrong**, and a missing 162 mm kerb against dark asphalt
looks like a kerb.

## 4. `NOTES.md` — three cases

**"A frequency multiplier inside a hash is not a frequency."** The `hash1`
finding in general form, with the two failure shapes it produced: a fix that did
nothing looked like it had worked because its checkable claim was true and its
load-bearing claim was not; and a latent error was scaled into visibility by a
change in a different file. Ends on the cheap measurement — finite-difference at
the spacing the geometry samples at, because white noise returns a slope scaling
as 1/step while a real wave returns one that stops changing.

**"Domain warping does not unalign a lattice; superposing non-aligned waves
does."** All three of tonight's instances in one case — ripples, filigree,
stipple. The argument that matters: warping bends the cells but there is still
exactly one peak per cell and the cells still tile in two dominant directions,
and the count and the directions are what read as a lattice. Wobbly grids are
still grids. Includes the amplitude corollary from §1.

**"When two functions describe the same surface, a feature authored against one
is silently erased where they disagree."** In the general form asked for, and
the sharpened version is that the *worst* place is the interesting place: a
blend exists in order to disagree, it disagrees most where it is doing the most
work, and that is edges, transitions and junctions. So the feature works in the
flat middle of nowhere and vanishes at the junction. Habit: author against the
function the renderer reads, and if you cannot, measure
`max |a - b|` over the footprint before tuning. Corollary kept prominent — **the
probe was reading the wrong function too**, and a probe and a feature reading
the same wrong function agree with each other perfectly.

## 5. Contracts written into `RESUME-PLAN.md` §7, verbatim

- **The stale warning is gone.** §7 said "Terrain's `groundSoil` contract is NOT
  published — do not code against it", which was true when written and had been
  wrong for two rounds. Replaced with the published table, and the section now
  says so in its heading.
- `groundAccum` in full: the why-one-service argument, the field/profile split
  spelled out as *fields cannot know your geometry, profiles are pure functions
  you evaluate against geometry only you know*, both tables with measured
  values, the splash/drift opposition, the 0.72R crown peak, and **the intended
  use is the product of a field and a profile** in those words, with the note
  that neither half is usable alone.
- `pavementEdge`, with the 649 mm correction.
- **A "For Canopy" note** in the established cross-system channel: sample
  `grime` at candidate downpipe outlets and prefer the high ones, since Terrain
  has already darkened that ground for its own reasons and a stain there reads
  as caused by the pipe rather than as two decals that overlap. Also pointed at
  `fines`, `shelter` and `wallBase` for column bases and soot, with the
  splash/drift warning. Terrain will take a splash-back radius if an outlet is
  fixed somewhere `grime` is low.

## Next

- The `flip` fix in `sweepProfile`, once Canopy can migrate with it.
- Consume `groundAccum` further in Terrain's own shading — `grime` and `fines`
  are currently only consumed by the debris scatter, and the ground's albedo
  could read them.
- Vegetation switching its local `WIND` to `site.WIND`.

---

# Round 2026-08-29T003121Z-737a2d5895b4 — the hash audit, analytic macro, puddle reflection

RTX 4060 verified per shot. 8/8 shots captured and passed the health gates.
No shader compile or link errors. `renderTargets: 0`. No LISTENING socket on
5131/5132, no orphaned Chromium, no orphaned preview. My files typecheck.

Terrain unchanged at 534,780 triangles, 138.7 MB, 20 textures / 17 uploads.
Scene draws fell 533 -> 390 and triangles 3.18M -> 2.96M between rounds; not
mine, another system trimmed.

## THE `hash1` AUDIT — repo-wide, and the answer is narrow

Every bare hash in the tree, every call site, and who owns it. The defective
pattern is a **continuous** argument scaled by a small number, which claims a
wavelength; a hash keyed to an **integer lattice** is correct and claims
nothing.

| definition | owner | call sites | verdict |
|---|---|---|---|
| `geo.ts:165` `hash1` | Terrain (shared) | `ragOffset` (fixed this round), `sweepProfile` chip | **the only defect in the repo, and it was mine** |
| `systems/lightSky.ts:75` `hash` | Lighting | `hash(i)`, `hash(i + vec2(1,0))`, `+(0,1)`, `+(1,1)` | **correct** — a proper bilinear value-noise lattice, floor plus interpolate |
| `gen/buildingCoursing.ts:183` `bcHash` | Building | `bcHash(cell)` where `cell = vec2(floor(...), course)` | **correct** — integer block/course lattice, one value per masonry unit |
| `gen/buildingWeather.ts:239` `bwHash` | Building | `bwHash(dIdx)` where `dIdx = floor(dCell)` | **correct** — integer drip-run index |
| `gen/buildingTextures.ts:78` `hash2` | Building | per-block variation, documented as "hash of two integers" | **correct** |
| `gen/vegMat.ts:364` `fract` | Vegetation | `fract(v.x * 0.71 + v.z * 1.13)` and two similar | **correct as written, worth knowing about** — see below |
| `gen/groundAccum.ts:176` `jitter` | Terrain | consumer-facing hash, documented as a hash | **correct** — no wavelength claimed, and callers are told it is a hash |

**Nothing to route. The defect was mine alone.** Everyone else keyed their bare
hashes to integer lattices — blocks, courses, drip cells — which is the correct
construction, and Lighting independently implemented full bilinear value noise.
`src/gen/noise.ts` has had proper lattice noise (`valueNoise`, `gradientNoise`,
`fbm`) the whole time; the failure was hand-rolling in `geo.ts` instead of using
it, not a pattern copied between files.

**One note for Vegetation, not a bug.** `vegMat.ts` lines 281/290/291 feed
continuous world coordinates to a bare hash to pick a per-vertex lift, angle and
thickness. That is white noise per vertex, which is exactly what those three
want, and no comment there claims otherwise — so it is correct. The thing worth
knowing is that it is **not extensible**: if anyone later wants those to vary
smoothly across a mat, or wants a long-wavelength trend in mat thickness,
changing the multiplier will do nothing and the change will look landed. Use
`fbm`/`valueNoise` from `noise.ts` for that.

**One real if minor consequence in my own shared file.** `sweepProfile`'s `chip`
is written as two octaves, `hash1(along * 2.9) * 1.0 + hash1(along * 11.3) * 0.6`,
and is therefore one white noise with a larger amplitude. The arris gets fine
per-station nibbles but never the long spalls the two-octave form implies. Since
chipping genuinely is uncorrelated station to station this is close to harmless
and I have left it alone rather than change Canopy's fascia and coping pixels
without warning — it uses the same code path. **Canopy: say the word and I will
give the chip a real long octave via `vnoise1`; it will add occasional
multi-station spalls to your arris and nothing else.**

## Critic item 1: asphalt macro variation — it was real and mipmapped into a constant

The critic's "macro variation missing, microtexture too evenly distributed" was
correct, and the cause is the third instance tonight of one failure.

`makeMacroNoise` is built from `fbm` in `noise.ts` — a proper lattice — so the
texture genuinely has 3 and 7 cycles per tile over 5 and 4 octaves. The macro
albedo term then sampled it twice at 41 m and 111 m per tile, i.e. 80 mm and
217 mm per texel. **The ground is at grazing incidence for most of the frame, so
a screen pixel covers metres of world, the sampled mip is many levels down, and
the tile returns its own mean.** The macro variation was present in the texture
and absent from the render precisely where the ground fills the frame.

Fixed by moving the large-scale half to analytic noise, which has no mip chain
and cannot do this: three waves on rotated bases at 34 m, 13 m and 5 m, weighted
0.58 against the texture tap's 0.42. The fine tap keeps its texture, because at
that scale the mip chain is doing the job it exists for. Visible in `ground.png`
as patchy value variation across the mid-ground lot that was not there in
`2026-08-28T233550Z`, and it holds at distance, which is the whole point.

**The general form is now three-for-three and belongs in every system's head: a
texture sampled far above its design frequency works at nadir and becomes a
constant at grazing incidence.** Water level jitter, the anti-tile selection
mask, and now macro albedo. Anything driving a *low-frequency* effect from a
texture on a ground plane has this.

## Critic item 2: the puddles — diagnosis, an overshoot, and where it landed

The critic named **reflection** specifically, and that was the right word. At
roughness 0.055 the pool interior is a mirror, and a mirror of a smooth sky
gradient is a clean bright blob however correct its edge is. **The fix for a
weak reflection is not more reflection, it is more surface** — what makes water
read as water is that the reflected world arrives broken.

Two changes, and one of them was a bug:

- **The finite-difference step was 0.03 m while the shortest wave in `wdWaveH`
  has a period near 0.05 m.** A difference taken over most of a wavelength is a
  low-pass filter, so a third of the authored ripple amplitude was producing no
  slope at all. 0.012 m fixes it.
- Gradient scale raised from 0.0016.

**First attempt overshot badly and the shape of the mistake is worth keeping.** I
set the scale to 0.0055 *and* fixed the step, which compounded to roughly 5x the
effective slope, and the pool rendered as mercury — chrome folding back on
itself. Capillary ripple on a shallow puddle is a couple of degrees of slope,
not tens. **When two changes push the same quantity and one of them is a filter
being removed, they multiply rather than add, and the sum of two individually
reasonable steps is not reasonable.** Settled at 0.0020 with the corrected step:
about twice the original slope on the fine octaves and a quarter more overall.

Also deepened the water's diffuse floor from 0.74 to 0.58. Standing water over a
9%-albedo surface absorbs going in and coming out while its specular has moved
somewhere else, so a puddle at your feet is markedly darker than the asphalt
beside it and only becomes brighter looking toward the sun; too high a floor
leaves a uniformly bright lens.

In `ground.png` the foreground pool now has a warm reflected sky broken into
elongated bands, a darker near interior, and visible ripple structure. It reads
as water. The known limit stands and I am not chasing it: the reflection has no
near-field content, because the environment is a single probe and four puddles
do not justify a screen-space pass.

## Building's note, applied to my own ground

"Relief oriented for a horizontal light and lit by a vertical one buys nothing,
because the faces it creates differ only in azimuth." My case is the mirror
image — a nearly horizontal light on nearly horizontal ground — and the same
question is the right one: **which axis does the relief vary along, against
which axis does the light arrive.** My relief varies in both X and Z
isotropically and the sun arrives at 11° from azimuth 203°, so the component
that matters is the along-sun gradient, and that is what the slope census
measures. It is worth saying that the census is currently isotropic: it reports
`hypot(gx, gz)`, which counts a slope perpendicular to the sun as fully as one
facing it. For Lambert response only the along-sun component does anything.
Noting it rather than changing it, because the isotropic figure has been the
basis for four comparisons tonight and switching the metric mid-thread would
invalidate them; a directional census is the right next version of that tool.

## `NOTES.md` — three cases

**"The checkable half of a claim is not the load-bearing half."** In the form
asked for: the amplitude claim was true and checkable, the wavelength claim was
false and unmeasurable, and the change looked as though it had worked because
the half anyone could verify was the half that was correct. Written as the
general mechanism by which a careful, well-argued fix passes review while doing
nothing — it needs no dishonesty, only two claims of unequal verifiability where
the cheap one is true, after which the cheap claim acts as a certificate for the
expensive one. Ends on both habits: when reviewing your own change, find the
claim you could not check and either check it or say plainly that it is
unverified; and as reviewer, a well-argued change with one verifiable number in
it is not thereby verified — ask what the number governs.

**"A parameter increase that reveals a bug is a diagnostic, not a cause."** With
the 190 mm arithmetic: the same defect was producing about 300 mm of
inter-vertex jump at the old setting, already larger than the whole nominal
excursion. The two readings lead to opposite actions, and the tell is
proportionality — 649 mm of movement from a ±400 mm envelope is arithmetically
impossible for anything with a wavelength. Rule: **when turning a knob makes
something ugly, measure at the old setting before turning it back**, because the
most valuable moment in a defect's life is the moment it first becomes visible.

**"A stale warning is worse than no warning, because it is believed."** A
missing note costs a question; a stale note costs the work the question would
have produced plus the work spent on the alternative someone built because they
believed the thing they needed was unavailable. Two habits, and the second is
the one that works: a "not yet" warning should state **what would make it
obsolete** so a reader can check the condition instead of trusting the sentence;
and **the publishing act and the retraction are one commit**, because whoever
leaves the retraction as a follow-up will not do it.

## Passing on: Lighting's own init assertion is failing live

Every shot in round `2026-08-29T002204Z` and this one reports
`lighting.init` failing its own gate:

    sky radiance service DIVERGES from the rendered dome: worst relative error
    2.3% over 18 probes (horizon az 210: cpu 2.0634,1.0376,0.5463
    vs gpu 2.1125,1.0594,0.5533)

Frames still render and pass my health gates, so it is a self-check rather than a
breakage, but it fires on all eight poses and it is Lighting's gate on its own
published service. Flagging it the way the PCSS error was flagged, since it may
not know.

## Open

- The `flip` migration in `sweepProfile`, to land in one commit with Canopy. The
  three-line fix is in the `WINDING HAZARD` comment in `geo.ts`; Canopy
  compensates by reversing two profiles in `canopyParts.ts`. Whoever is quieter
  takes it, and I will report when it lands so nobody re-derives it.
- A directional slope census, replacing `hypot(gx, gz)` with the along-sun
  component.
- Consume `grime` and `fines` in Terrain's own ground shading; they currently
  only drive the debris scatter.

---

## Round 2026-08-29T011416Z-6f40a2006979 — ranges on the contracts, ruts, and a stipple that was not a lattice

Six of eight poses captured (`approach`, `lot`, `ground`, `wide`, `verge`,
`puddle`). RTX 4060 verified from the live context per shot. `archive --scan`:
every capture a readable image of plausible size. Ports 5131/5132 with no
listener, no chromium holding either. Tree typechecks.

**Harness note for whoever hits it next:** the vite preview drops with
`ERR_HTTP_RESPONSE_CODE_FAILURE` after the sixth navigation, in two consecutive
runs at the same point, so the last two poses need a second invocation. Not
chased; the failure is in the preview server rather than the page, and it is
loud rather than silent, which is the acceptable kind.

### Ranges are now part of all three published contracts

The point that prompted this — a consumer treating a 0.11–0.21 field as a bare
multiplier gets the *sign* of its effect backwards — landed harder than
expected, because measuring the distributions found that **two of the five
`groundAccum` fields are bimodal.** `shelter` has p50 = 0.018 and p95 = 1.000;
`swept` has p50 = 0.004 and p95 = 0.967. Air is either trapped or it is not, and
ground is either on a traffic path or it is not. "0..1" is true of both and
describes neither, and a consumer using either as a smooth gradient gets a hard
cut with a fringe.

So each field now publishes `{units, min, p50, p95, max, mean, shape,
safeAsMultiplier, note}`. `shape` is the load-bearing one. The measured table:

| field | min | p50 | p95 | max | mean | shape | units |
|---|---|---|---|---|---|---|---|
| `shelter` | 0.000 | 0.018 | 1.000 | 1.000 | 0.259 | bimodal | — |
| `fines` | 0.005 | 0.145 | 0.661 | 0.995 | 0.220 | unimodal | — |
| `litter` | 0.000 | 0.000 | 0.016 | 0.115 | 0.003 | skewed | items/m² |
| `grime` | 0.000 | 0.000 | 0.096 | 0.291 | 0.014 | skewed | — |
| `swept` | 0.000 | 0.004 | 0.967 | 1.000 | 0.142 | bimodal | — |

`groundSoil` got the same treatment and it caught a genuine trap: **`drainage`
is signed metres, not a 0..1 field.** Used as a bare multiplier it returns a
negative factor over every low spot, inverting a consumer's effect exactly where
that consumer wanted it most. It now declares `safeAsMultiplier: false` and
says what to do instead.

`pavementEdge` publishes the distinction between **envelope and observed**:
`excursion` is 0.400 m because that is what the noise is normalised to, but the
largest offset actually reached over 680 m of highway is 0.354 m. Sizing a
margin off the envelope is correctly conservative; asserting the edge reaches
400 mm somewhere fails. Also published: max edge-line slope 0.10, max jump per
vertex 0.052 m at a 0.5 m pitch, and the three real wavelengths (18.0, 6.5,
2.2 m) — stated because the previous version claimed four octaves from 18 m to
0.19 m and delivered white noise.

`tools/dirtscan.mjs` re-measures the fields and prints `STALE` beside any
declared number that has drifted from the field it describes. All five match.

### Entrance ruts: lengthened, deepened, and now with a working control

The first version was a 3.2 m track, because shoulder to pad edge is only 3.24 m
here — too short to read as a wheel path whatever its depth. Extended a metre
back over the shoulder and 3.5 m past the pad edge for a **7.7 m run**, roughly
one truck length, and deepened 0.13 → 0.175 m (steepest wall 0.43, more than
twice the 0.198 solar tangent, so they cast rather than shade).

Measured on the track footprint rather than the entrance region — the old
predicate covered ±5.5 m of each flank, inside which the grooves are under a
fifth of the area, and it diluted a real effect below its own noise floor:

| arm | mean slope | p95 | max | % steeper than sun |
|---|---|---|---|---|
| all on | 0.071 | 0.217 | 0.324 | 8.1% |
| `noruts` | 0.049 | 0.201 | 0.219 | 5.1% |

Frontage control unmoved at 0.104 either way, so the change is local as
authored. **Visible in `verge.png` as two dark parallel tracks with their own
cast shadow**, which is the first authored ground feature in this project to
survive from height field to frame without argument.

### The stipple was not a lattice, and the obvious fix would have been wrong

The near ground rendered as an evenly dappled carpet. It had already been
rewritten once for this symptom, so the read was "still a lattice, rotate more
bases". A 2-D autocorrelation of the rendered dirt refuted it: r decays
monotonically from 0.92 at lag 2 to zero by lag 40 with **no secondary peak
anywhere in a 2–90 px sweep.** Nothing periodic left to decorrelate; a fourth
rotated basis would have produced another plausible screenshot.

The actual fault was that the three waves had k = 1.07, 1.31 and 2.21 — a spread
of 2.07×, **barely one octave.** A narrow-band random field is still random and
still looks like a pattern, because the eye reads scale uniformity and not only
repetition. Widened to ~3.2 octaves, 13.7 m to 1.8 m, with amplitude per octave
set so each contributes **equal slope** (`a/k` ≈ 0.055) rather than equal
height — which follows from shading responding to slope, and is why equal
amplitude would have left a wide band behaving like a narrow one.

Nyquist is now checked **per octave**: the 1.8 m octave gets its own gate at
52 m where the graded mesh's spacing passes its limit, while the 13.7 m octave
runs to 145 m. A single distance gate for a multi-octave field is right for one
octave and wrong for the rest.

Measured, and reported with its limit. From the `wide` pose the long octave is
present and consistent — correlation up at every long lag, 0.397 → 0.416 at
lag 20, 0.311 → 0.330 at 40, 0.254 → 0.269 at 80. From the near crop it is
invisible **by construction**, because the per-row detrend that removes the
recession gradient also removes any wavelength comparable to the crop width.
The tool cannot see what it filters, which is worth knowing before trusting a
null from it.

**Honest limit, and the next item: the near-field carpet is still there, and it
is not the height field.** Its features are ~15 px at 2–4 m, so roughly
0.2–0.4 m — below the 0.63 m mesh spacing and below churn's shortest 1.8 m
octave. Neither can produce it. That leaves the **dirt normal map**, narrow-band
in its own right, and `scalescan` says there is no repeat there either, so the
same widening argument applies one level down in the texture rather than the
geometry. Not attempted this round; named rather than guessed at.

### `FORCE` now reads the environment, because the CPU control arm was fake

The gate read `location.search` only, which is undefined in Node, so in a CPU
probe every forced-off token evaluated to nothing and every feature stayed on. A
`nochurn` arm returned the census **identical to the default to within 0.001** —
and two identical arms read as "the feature does nothing". A broken control does
not fail loudly; it returns the exact signature of the defect it exists to
detect, and invites you to strengthen or delete something that was working.

One validated table now reads the query string and `TFORCE`, so `?force=nochurn`
and `TFORCE=nochurn` are the same switch and the unknown-token report covers
probes too. `nochurn` and `nohum` added. Each arm now moves its own region and
leaves the others alone, which is positive evidence the switch works:

| arm | tracks | frontage | far field |
|---|---|---|---|
| all on | 0.071 | 0.105 / 12.1% | 0.071 / 1.6% |
| `noruts` | **0.049** | 0.104 | 0.071 |
| `nochurn` | 0.071 | **0.099 / 7.2%** | 0.067 |
| `nohum` | 0.071 | 0.101 / 11.5% | **0.037 / 1.0%** |

Churn nearly halves the fraction of near ground steeper than the sun when
removed; `hum` halves the far-field mean slope. Both were unverifiable an hour
ago.

### Two tools moved into `tools/`, having been deleted twice

`tools/dirtscan.mjs` (slope census, control arms, published-range check) and
`tools/scalescan.mjs` (repeat versus narrow band, from a captured frame). Five
earlier probes lived in `.shot-build/`, which the harness cleans on teardown,
and were destroyed by the next capture — twice in this round alone, the second
time after I had already diagnosed the cause. `NOTES.md` 42.

### Messages sent through the registry

- **Canopy:** may I give `sweepProfile`'s `chip` a real long octave via
  `vnoise1`? It owns the only other consumer, so this is an ask rather than a
  change. Plus the `flip` winding migration, which wants one commit changing
  `sweepProfile` and un-reversing all three profiles together — and a correction
  to its inside-out test: Terrain's `curbs` are correctly wound, and the test
  assumes lateral-0 is the outer flank, which on a box section is the inner one.
- **Vegetation:** three call sites in `vegMat.ts` are correct as written and not
  extensible. No bug to fix. The failure mode is that anyone later wanting a
  long-wavelength trend across a mat will lower the multiplier and see nothing,
  because there is no wavelength in a bare hash to lower.

### New `NOTES.md` cases

41 — a narrow-band random field is not a lattice, the two faults produce the
same complaint and need opposite fixes, and amplitude per octave should be set
for equal slope rather than equal height.

42 — a diagnostic stored in a build directory is deleted by the build, so a
measurement you cannot re-run is an anecdote.

43 — a forced-off control that reads no switch returns the exact signature of
the defect it exists to detect.

---

## Round 2026-08-29T014418Z-ed7321e92af6 — the near-field carpet was aliasing, and the fix is partial

RTX 4060 verified from the live context. Ports 5131/5132 with no listener. Tree
typechecks. Three rounds this session: `013258Z-0a521af32939` (zero shots,
preview failed on the first navigation), `013738Z-759eda04008e` (verge + ground,
the overshoot), `014418Z-ed7321e92af6` (verge, shipped).

**Harness note, now consistent enough to name:** the vite preview drops with
`ERR_HTTP_RESPONSE_CODE_FAILURE` and the failure arrives earlier each run — five
shots, then eight, then six, then zero. Retrying works; restricting to
`--shots=verge` works reliably. Five agents are capturing concurrently, so a
shared resource is the obvious suspect and I have not chased it. Also worth
knowing: the flag is `--shots=`, and `--only=` is **silently ignored**, which is
why one earlier run captured all eight poses when two were asked for.

### What the carpet actually was

Not the height field, and not a lattice. The dirt normal map's height buffer was
measured directly on the CPU, and its autocorrelation was **0.41 at a one-texel
lag and zero by four** — very nearly uncorrelated per-texel values.

`fbm`'s frequency argument is lattice cells across the map, so feature size in
texels is `size / freq`. At 1024 px over a 17 m tile:

| term | cells | texels per feature | verdict |
|---|---|---|---|
| clods, 5 octaves | 170 → 3769 | 6.0, 2.8, 1.3, 0.6, 0.3 | **three sub-texel** |
| gravel worley | 486 | 2.1, near-binary | **dominant, ~3.5x clods' variance** |
| dead grass | 510 | 2.0, near-binary | **sub-texel second octave** |
| rocks | 89 | 11.5 | fine |
| meso, patchy | 9, 13 | 114, 79 | fine, and albedo-only |

So the dominant term in the relief was two-texel binary noise. The map rendered
as an even fine grain because that is nearly all it contained, and it had read as
a deliberate material for many rounds.

Changes, each measured:

- **Gravel's height weight 0.40 → 0.08**, keeping full albedo weight. Autocorr
  at one texel 0.41 → 0.72, correlation length 33 → 50 mm. This is the change
  that did the work. 35 mm gravel at 16.6 mm/texel cannot be *shaped*, only
  speckled, and speckle is what gravel looks like — so it belongs in the channel
  that tolerates aliasing.
- **Dead grass 0.28 → 0.10.** Principled and it did nothing measurable (0.722 →
  0.723). Reported because it was expected to matter.
- **Octaves capped** at the finest that clears 2.4 texels, at my call sites and
  **not inside `fbm`**, which six systems share.
- **Lumps at 0.55 m added**, filling the gap between the finest relief the map
  can hold and the coarsest the mesh can represent. Registers faintly, as
  predicted, for a reason that is a hard limit rather than tuning — see below.
- **Fine relief amplitude-modulated by `meso` and `patchy`** (1.3–1.9 m, already
  computed for albedo, so free). Tripled the spread of local slope across the
  map, 0.012 → 0.039, while the noise floor was present — **and then made almost
  no difference once the noise was gone**, 0.036 → 0.038. It was largely
  compensating for the defect. Kept, because it ties relief to the colour
  variation and costs nothing, but it is not the result.

### The overshoot, and the honest state of it

Strength went 1.4 → 2.5 → 1.55. Removing the sub-texel terms halved mean local
slope (0.147 → 0.073) because two-texel binary noise carries enormous slope for
its size, so restoring the budget by amplitude looked like correct arithmetic. In
the frame at 2.5 the ground rendered as **deep round pits — a golf ball.** The
same mean slope carried at 100 mm instead of 33 mm is not the same appearance:
each feature is individually resolved, and the eye reads a fine texture at that
slope as roughness and a coarse one as holes. Settled at 1.55 with the weight
moved into the 0.55 m lumps.

**Where it stands: a modest improvement, not a solved problem.** The near-field
dimpling is coarser and softer and still visible. Rendered-frame autocorrelation
over the near crop went 16 → 19 px correlation length, which confirms larger
features and does not confirm better ground.

**My read on why, for whoever takes it next.** A tiling normal map viewed at
2–4 m on a surface that is geometrically flat between vertices 0.63 m apart has
no parallax and no silhouette, so it will read as a texture on a plane whatever
its spectrum. The 0.2–1.3 m band cannot go in the mesh either, because the
graded mesh's Nyquist limit there is about 1.3 m. The thing that already works in
that band is **scattered geometry** — the 1500 gravel icosahedra have real
silhouettes and real shadows — so raising near-field debris density is likely
worth more than any further texture work, and it is measurable in triangles
rather than in adjectives. I did not do it this round; it is the first thing I
would do next.

### `friability` is a real option, not a probe hack

`makeDirt` takes `friability` (default 1, **0 restores the unmodulated
relief**), so the control arm and the shipped path are the same code. Same
principle as `TFORCE` last round.

### Winding: I am not on the list, with the reason

`sweepProfile` is mine and the `flip` inversion is real, but my system has
exactly **one** `flip: true` call site — the pump islands, already compensated by
reversing the profile — and all five curb runs pass `flip: false`, which is
consistent with last round's per-strip census measuring the curb outer flank at
−1.000 on the −Z run. If Vegetation's detector names `pump-islands` or `curbs`,
it is measuring a pre-fix bundle or repeating the lateral-0 assumption.

Worth stating for whoever reads that detector's output: **every generator in
`geo.ts` ends with `computeVertexNormals()`, which derives normals from winding,
so no normal-based test can ever detect an inversion.** The normals always agree.
Only a geometric test — signed volume for a closed mesh, or a cross-section
outward direction for an open band — can see it.

### The integrity scan needed no widening

`node tools/archive.mjs --scan` with no argument already defaults to the whole
working tree, skips `node_modules` and `.git`, and already sniffs extensionless
files to catch an image written to a path meant to be an argument. The narrow
scope was purely in how harnesses invoke it.

Run repo-wide it flags **ten** files: the two zero-pixel strays, four in
`shots/system2`, four `nzid*` in `shots/system3/_look`. The `nzid` frames look
like normal-ID visualisations, and a flat-shaded ID render **is** mostly flat by
design, so it trips a byte floor while being exactly correct. That argues against
wiring the repo-wide scan into the capture path — a test that flags a correct
surface costs more trust than it saves — and for a per-session run a person
reads. Posted to the owners.

### New `NOTES.md` cases

44 — content authored below the resolution of the channel storing it becomes
white noise rather than absence, which is the mip failure one step earlier and
worse, because the result is visible and looks deliberate.

45 — a probe's own speed parameter can be the dominant term in its result; the
512 px arm reported the field as pure noise because 512 px made it so.

46 — slope conserved across a wavelength change is not appearance conserved.

47 — a baked normal map is structurally narrow-band, because a clamped height
field and a fixed Sobel make slope go as amplitude over wavelength with
amplitude bounded; widen it by amplitude modulation, not by adding octaves.


---

## Round `2026-08-29T024429Z-9092f6f20939` — near-field debris density

Archived, integrity scan clean on 4 of 4. GPU verified per shot: RTX 4060 via
ANGLE D3D11. Ports 5131/5132 clear at exit.

### What landed

**Gravel 1500 -> 24,000, clumped, on the rendered surface.** Three separate
causes had to be fixed and only the first was the one I set out to fix. Written up
as `NOTES.md` 50 and 51; the short version is that a scatter has a count, an
extent and a protrusion, only their combination is visible, and the stones were
finally invisible because they were placed on the height field rather than on the
mesh that renders it.

**`site.pavedDistance(x, z)`** published with units, range and the direction of
its deliberate conservatism, since Vegetation and Car scatter into the same
ground and all three of us need one answer to "is this spot dirt".

**`groundGeo.userData.surfaceAt(x, z)`** — the surface actually rendered, exact
per triangle rather than bilinear, because the index buffer splits each quad on
the b-c diagonal.

**`tools/mapspectrum.mjs`** — periodicity and band width measured in the
generated buffer rather than in a frame, with the high-pass that the frame-side
tool was missing.

### Cost

| | before | after |
|---|---|---|
| static terrain triangles | 534,780 | 534,780 |
| drawn triangles per frame (all passes) | 5,610,194 | 6,576,526 |
| draw calls | 839 | 842 |
| texture MB | 138.7 | 138.7 |

60.5 drawn triangles per stone for a 20-triangle icosahedron, because each
instance is rasterised into the shadow cascades as well as the main pass. That
ratio is the number to argue with if Perf wants the count down — the geometry is
already minimal and the multiplier is shadow passes, so the lever is which
cascades gravel casts into, not the mesh. `?force=thindebris` restores the
9,000-stone arm.

### Lighting's ground lattice: it is real, and it is asphalt not dirt

Lighting's two crops are identical with shadows on and fully off, so it correctly
ruled out shadowing. **Its "lattice" reading is right and my narrow-band framing
was right about the wrong surface.** The crops are asphalt, not the dirt verge:

- High-passed at 12 px on narrow constant-depth bands, the crop has secondary
  autocorrelation peaks at 22 px in the far band and 30/46/62 px in the near one
  — a fundamental whose screen period grows with proximity, which is a **fixed
  world-space period**. That is a genuine repeat.
- The same crop measured without a high-pass, and over a tall crop spanning many
  depths, reports "no secondary peak, random field" — confidently and wrongly.
  Both failure modes are in `NOTES.md` 52: variance dominated by the broad
  shading, and perspective smearing a fixed world period across screen space.
- The dirt is separately confirmed *aperiodic* in its own buffer:
  `mapspectrum.mjs` finds no peak in `makeDirt`'s height field, correlation
  length 3 texels. So the two surfaces have two different faults and the earlier
  narrow-band conclusion stands for the dirt only.

**Not fixed, and here is the specific next step rather than a guess.** `makeAsphalt`
cannot be measured headless — it draws its cracks through a DOM canvas — so the
buffer check that settled the dirt is unavailable, and `mapspectrum.mjs` says so
explicitly rather than returning a null. The arithmetic points at moiré between a
sub-texel cell grid and the texel grid: at `makeAsphalt(2048, 8)` the map is
3.91 mm/texel and `aggFine` at 7.5 mm asks for 1.92 texels per cell, right at
Nyquist, while `grain`'s 4th octave is 1.05 texels and `micro`'s 2nd is 1.69. A
jittered cell grid sampled at about two texels per cell beats against the texel
grid and produces a periodic pattern from aperiodic content. The check is to lift
the crack pass behind a flag so the buffer can be generated in Node, then run
`mapspectrum.mjs asphalt`.

Worth noting for whoever takes it: the critic explicitly protected the foreground
asphalt aggregate grain, so this must not be fixed by deleting `aggFine`. If the
diagnosis holds, the grain that reads is `aggBig` at 8.7 texels and `aggDist` at
4.1, and what `aggFine` currently contributes is the artefact rather than the
grain.

### For Vegetation, on the shared near field

The `RESUME-PLAN.md` entry has the numbers. The one-line version: Terrain now
holds the 15-90 mm band on open dirt at about one clump per 10 m2, following
`groundAccum.fines`. Scatter against `shelter` or `lee` instead and the two
compose; scatter against `fines` in the same size band and we will double up
inside my clumps and leave the ground between them bare.

### Still open

- The asphalt lattice above — diagnosis and next step recorded, not landed.
- `sweepProfile`'s `chip` white-noise fix, waiting on Canopy to take the `flip`
  migration in the same commit.
- `LightingSystem.ts:1029` had `Cannot find name 'createShadowMapView'` in the
  shared tree at 08:00, which fails `tsc` for everyone. Terrain's own files are
  clean. Passed on rather than touched.


---

## Round `2026-08-29T033229Z-f12f61d457b0` — the asphalt lattice is refuted

GPU verified per shot, RTX 4060. Tree typechecks. Ports 5131/5132 clear.

### The moiré hypothesis was mine and it is wrong

I proposed sub-texel Worley beating against the texel grid, with the arithmetic
to back it. Measured four ways, it does not survive.

**In the source buffer, in-page.** `tools/asphaltscan.mjs` is new: it runs a Vite
dev server on 5132, opens `tools/asphaltprobe.html`, generates `makeAsphalt` in
the page — which is what sidesteps the DOM canvas that blocked `mapspectrum.mjs`
in Node — and brings the height buffer back for the *same* analysis code, imported
rather than reimplemented. Result: **no periodic peak in any arm.** Correlation
length 3 texels (11.7 mm) at 3.91 mm/texel.

The four arms are real controls, not fake ones: buffer mean moves 0.3480 ->
0.3252 -> 0.2893 -> 0.2663 as the terms are forced off. `makeAsphalt` gained an
`AsphaltOptions` argument with `fineHeight` and `microHeight` height weights so
the claim was testable at all.

**And the arms answer the protected-grain question directly.** Forcing `aggFine`
entirely out of the height field changes the correlation structure by 0.007 at lag
1 and nothing anywhere else. So `aggFine` was neither causing an artefact nor
contributing structure to the height field — my testable claim was testable and
false. It stays where it is; nothing needed deleting, and the foreground grain
the critic protected was never at risk.

**In my own rendered frames.** `rim` and `lot`, three constant-depth bands each,
high-passed: no secondary peak anywhere, correlation length 4-14 px. Also with
`?force=notile`, so it is not the 41-degree anti-tile blend.

**In the shader.** `wdMacroBig`'s wavelengths are 34 m, 13 m and 5 m. Nothing in
the asphalt path has a fine periodic term.

### What the evidence crops actually contain

They are 2x upscales. Measured: mean run of horizontally identical pixels **2.09
px, against 1.01 px in my renders of the same material**. An upscale imposes a
fixed screen-space period which the peak finder reports as a fundamental with
harmonics at 2x, 3x, 4x — which is precisely the 15/30/46/62 px ladder I read as
a world period. `tools/scalescan.mjs` now prints the resample statistic before any
periodicity result and names the suspect period, so this cannot be repeated
silently.

To be careful about what is and is not established: Lighting's pose is the one
variable I have not reproduced, so I cannot say the frame it shot is clean. I can
say the material and its source buffer are aperiodic, and that the absolute
periods in those crops are not transferable to the scene. **The cheap way to
settle it is a 1:1 crop with no scaling, which `scalescan` will now screen
automatically.** `NOTES.md` 53 has the general form, including that "identical
under the ablation" excludes the ablated cause and nothing else.

### Two attempts at asphalt macro variation, both null, both reverted

The parent's real complaint — near-field asphalt is the flattest thing in the
exterior frames — is a band-width problem, not a lattice, and I could not move it.
The texture supplies 1-3 m content inside an 8 m tile, so it repeats six times
across the lot; the shader supplies 5-34 m. The 1-4 m band is the gap.

Adding analytic octaves at 2.0 m and 1.1 m measured **45 px against 45 px,
identical to three decimals**, twice. First with an equal-slope amplitude
schedule, which is a height-field rule wrongly carried to an albedo term; then
with equal contrast, which also failed because the sum is normalised by an outer
scale I did not change — sigma 0.209 before, 0.207 after. Adding octaves to a
normalised sum moves content to shorter wavelengths and adds no contrast.

And my own instrument could not have seen it either way: I high-passed at 48 px
and then reported a 45 px correlation length, which is the window rather than the
content. Written up as `NOTES.md` 54.

**Both reverted.** The three-octave function is back exactly as it was, with the
whole analysis in a comment above it so the next attempt starts from the outer
scale and `uMacroAlbedo` rather than from the octave list. Shaders re-verified as
linking after the revert.

### Tools added or changed

- `tools/asphaltscan.mjs` — in-page buffer measurement on 5132, tearing down its
  own server and browser in a `finally`.
- `tools/asphaltprobe.html` — the page; deliberately contains no analysis.
- `tools/mapspectrum.mjs` — analysis now exported, CLI behind a main guard, so the
  browser arm and the Node arm cannot drift apart.
- `tools/scalescan.mjs` — resample detection, and the `--highpass` window from the
  previous round.

### Still open

- Whether Lighting's specific pose shows anything after a 1:1 re-crop.
- Asphalt mid-band contrast: the gap is real and identified, the two obvious
  routes are measured dead ends, and the live levers are the outer scale of
  `wdMacroBig` and `uMacroAlbedo` (currently 0.26-0.34).
- `sweepProfile`'s `chip`, still waiting on Canopy to take the `flip` migration in
  one commit.


---

## Round `2026-08-29T035923Z-4f7af10464f9` — surfaceAt published, init cut, shadow decision made

GPU verified per shot, RTX 4060. Tree typechecks. Ports 5131/5132 clear.

### 1. `groundSurface` is published — Car should light up with no edit

`game.provide("groundSurface", this.groundSurfaceAt)`, placed immediately after
the ground geometry is built rather than with the other four services, because
those run before any geometry exists and this one cannot: it is a closure over the
mesh's own vertex positions, which is the whole point of it. **A field can be
published early; a fact about a mesh cannot.**

Key contains "surface" as Car's pattern match expects. Contract: metres, absolute
world Y, finite everywhere, differing from `groundHeight` by the chord error —
6.7 mm at p90 and 23.6 mm at p99 in the near field, 1.1 mm at p90 beyond 62 m —
and always greater than or equal to the field where the field is concave, which is
why placing on the field buries things, and buries them only near the camera.

### 2. Init: 14.36 s -> 11.04 s, and the phases name the rest

`initPhases` wired onto the section comments `init()` already had, so the
instrumentation adds no structure of its own. `unaccountedMs` is **0.00 s**, so
the attribution is complete. Also plumbed into `shoot1.mjs`, so every round now
prints its own init breakdown.

First measurement, per section:

| phase | ms |
|---|---|
| material library | 11.96 s |
| debris scatter | 1.29 s |
| soil field + service | 0.80 s |
| everything else (6 sections) | < 0.20 s each |

Then per generator call with `phase.of`, which found it: **`makeSiteOverlay()` at
7.52 s**, the single largest item in the project's startup.

It was 3072 x 2204 on two canvases, not the 2048 anyone had assumed, and the cost
is the `blur()` filter calls — dozens of them, two at radii of 70 and 110 px, each
a full-canvas convolution. Dropped to 2048 wide, which is 45 mm/texel over the
92 m region: **7.52 s -> 2.38 s**.

Machine variance between runs is about 25%, so the honest statement is the ratio
rather than the absolute: the overlay went from 1.95x the cost of the asphalt
generator to 0.84x of it, a real 2.3x improvement that no run-to-run variation
explains. Terrain init now reads asphalt 3.38 s, overlay 2.55 s, debris 0.89 s.

45 mm/texel was chosen the way any resolution decision should be — by naming the
feature being protected. This layer carries tyre paths, oil, wash and staining,
which live between 0.3 and 3 m, so the smallest real feature is about 7 texels.
That is the opposite of the asphalt set, where 3.9 mm/texel against a 7 mm
aggregate feature is 1.8 texels and halving deletes the foreground grain a critic
protected.

**Left for whoever takes init next:** `makeAsphalt` at 3.38 s is now the largest
item and cannot be solved by resolution for the reason above; the lever there is
the four Worley calls, which do a 3x3 neighbour search per texel at 2048 square.
And a note in `siteOverlay.ts`: several authored blur radii — `m(0.012)`,
`m(0.02)`, `m(0.03)` — were already below one pixel at 3072, so they were doing
nothing before this change. Sub-texel content in a channel that cannot hold it,
same defect as the dirt height map, and they want removing or raising rather than
quietly scaling again.

### 3. My texture figure was wrong again, and by more than the first time

**157.6 MB, from 23 textures and 20 uploads.** The previously reported 138.7 MB
omitted every texture bound through the shader injection — the overlay, the macro
noise, the soil field, the wash, the void mask and the alternate soil.

The loop that was supposed to catch them read `material.userData.shader.uniforms`,
which `onBeforeCompile` populates at the first render, while the statistics are
assembled at the end of `init()`. Correct loop, empty input, silent zero. Now
counted from references held at creation.

Reconstructing: the true figure before this round was about 177 MB, so 138.7 was
short by roughly 38 MB — and that number had *already* been corrected once from
202.7 by fixing a real double count, which is exactly what made it feel finished.
Net real saving from the overlay change is about 20 MB.

What exposed it is worth copying: shrinking the overlay 2.25x left the total
unchanged to one decimal place. **A real change that produces a byte-identical
measurement proves the measurement does not depend on it.** Written up as
`NOTES.md` 55.

### 4. The ground does not cast, and that is now a decision

Lighting is right that no terrain surface writes depth, and right that it should
be a decision. It stays off, with the arm `?force=terraincast` for anyone who
wants to price it.

For it: the relief added this session is real. A slope census at the mesh step
against a solar tangent of 0.198 puts **8.1% of the entrance tracks and 12.1% of
the frontage steeper than the sun**, so there is genuinely occluding geometry, and
at this elevation a crest throws a shadow five times its height. My earlier
"0.006 slope" figure predates that relief and should not be quoted any more.

Against, and decisive: in the far field only 1.6% clears the tangent and it clears
it by very little, so what it would occlude is ground Lambert has already
darkened — the same mechanism measured earlier for the far-field banding, so the
gain is largely double counting. And the cost is real: this is deliberately a
single graded mesh of 352,800 triangles, so it cannot be bounded to the near field
without splitting it, and splitting reintroduces the chord disagreement grading it
was chosen to avoid. Casting rasterises all of it into every cascade at a moment
when the deliverable is a continuous run on a card that has already crashed a
browser during generation.

If the near field ever wants a bounded caster, the honest form is a shadow-only
proxy sampling `userData.surfaceAt`, so the shadow matches the surface drawn.

### On the 24,000 stones and the shadow cascades

Perf is right that 60.5 drawn triangles per stone is cascade rasterisation rather
than mesh cost, and right that the lever is which cascades gravel casts into.
Terrain's own view: gravel is 15-90 mm and its shadow is the reason it reads at
all at this sun, so removing it from the near cascade would undo the round. The
far cascades are where it is free to lose — a 40 mm stone at 60 m contributes a
sub-pixel shadow. That is a per-cascade `castShadow` decision which lives in
Lighting's cascade setup rather than here, and Terrain supports it.

### Still open

- Near-field asphalt mid-band contrast: live, with the lever named — the outer
  scale of `wdMacroBig` and `uMacroAlbedo` (0.26-0.34), not the octave list.
- Whether Lighting's pose shows anything after a 1:1 re-crop.
- `makeAsphalt` at 3.38 s, now the largest init item.
- `sweepProfile`'s `chip`, waiting on Canopy for the `flip` migration.
