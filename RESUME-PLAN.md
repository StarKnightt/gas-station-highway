# RESUME-PLAN — first command per system on the next GPU session

Written 2026-08-29 during a **CPU-only** pass, while the user had the GPU. No
browser, no preview server, no capture harness and no GPU process was started to
produce any of this. Everything here is read out of the six handovers, out of
`NOTES.md` and out of the source; **nothing in it has been seen in pixels.**

Its job is to make the first twenty minutes of the next GPU session zero-thought:
one command per system, what that command has to prove, and the specific number
it is being compared against.

---

## TEARDOWN — do this when the work is finished, not before

The user has asked for the disposable output to be deleted **once the work is
done**. It is still load-bearing until then: `shots/` is the evidence every
critic pass reads, and the per-round archives are what makes a before/after
comparison traceable in a tree six agents commit to.

At teardown, delete:

- `shots/` — 1.3 GB. Capture rounds, the `_*` scratch directories, the PNG
  sequences under `shots/film/frames/`, and the run logs. **Keep
  `shots/film/dawn-station.mp4` — the user has asked for it explicitly.** It is
  the only rendered artefact and is not in git, deliberately, because it is
  regenerated output, so deleting it destroys the only copy.
- `.shot-build/` — 27 MB, per-system private bundles. Pure build output.
- `tmp/` — 30 MB scratch. Contains `tmp/film-standdown/`, which is the recovery
  snapshot of `tools/filmwalk.mjs`; that one is safe to drop once the film
  harness has been confirmed good.
- `audio-plots/` — 344 KB of offline audio plots.

Then `git gc --prune=now` to reclaim the ~379 MB of unreachable loose objects
left by an early `git add -A` that touched `shots/`. None of it was pushed.

All four paths are already in `.gitignore`, so none of this affects the repo at
`StarKnightt/gas-station-highway`.

---

## 0. Read this before running anything

- **Do not run two harnesses at once.** They build into separate dirs
  (`.shot-build/<system>`) and bind separate ports, but concurrent builds have
  already produced captures that mixed one agent's source with another's.
- **A capture-to-capture diff is not trustworthy in this repo.** Pumps measured
  a rectangle of tarmac that nothing it touched could reach moving by a mean of
  **25.6/255** between two rounds, because other agents commit between builds.
  Any conclusion resting on a smaller delta is unsupportable. Prefer
  within-frame measurements or CPU probes; if you must diff across builds,
  include a control region and believe it when it moves.
- **`?solo=` / `?skip=` work now.** See "the shared `Game.ts` fix" appended to
  every handover, and NOTES case 32. If another agent's system is throwing,
  isolate instead of waiting. Keep gating on `__SYSTEM_ERRORS.length === 0`.
- **Run `node tools/framescan.mjs <png>...` over every round before a critic
  sees it.** It now also carries vegetation's `RULED HORIZON` and
  `BAND BRIGHTER THAN SKY` tests, which fire on other systems' frames too.
- **Never write anything to `.shot-build/` root — use `tmp/` for scratch.**
  Every committed harness builds into `.shot-build/<system>/`, so none of them
  is the sibling that has twice deleted another agent's build directory. The
  collision comes from `.shot-build/` doing two jobs at once: parent of the
  private per-system builds, and the scratch directory agents drop one-off
  probes into (`accumprobe.mjs`, `windcheck.mjs`, `shoreline.mjs`,
  `wherediff.mjs` all live there today). An ad-hoc `vite build` left at its
  default `outDir` lands in the root with `emptyOutDir`, taking every sibling's
  bundle with it. It presents as a navigation failure that looks like a port
  problem, which is why it costs a round before anyone suspects the build.

---

## 1. Terrain — `src/gen/worldDetail.ts`, `src/systems/TerrainSystem.ts`

### First command

```
node tools/tilescan.mjs --variants=base,bumponly,albedoonly,notile
```

### What it must prove

Which channel carries the repeat, **before** anything else is judged. Nadir
camera at known altitude, whole-frame high-pass and normalised autocorrelation,
reported in metres.

### Baseline / expected numbers

- Known world periods to match against: **17.0 m** (dirt UV tile), **27.0 m**
  (anti-tile alternate sample, 0.63x), **45.9 m** (anti-tile selection mask,
  78/1.7), **78.0 m** (macro).
- `node tools/tilescan.mjs --selftest` passes and is the only pixel evidence the
  tool has ever produced: planted 17.0 m repeat at **r = 1.000**, nothing at all
  on a non-repeating control with the same statistics. Re-run the selftest first
  if anything looks odd.
- `bumponly` must show the 17 m peak and `albedoonly` must show it much weaker.
  **If that is not what comes back, the diagnosis is wrong and the fix landed
  this session will not help** — stop and re-diagnose rather than tuning.

### Change landed this session (CPU-verified only)

The **normal-map arm of the anti-tile cross-fade** is now injected after
`#include <normal_fragment_maps>` in `applyWorldDetail`. It was the one channel
that had no anti-tile at all. Same rotation (41 degrees), same 0.63x alternate
scale, same offset and deliberately the **same selection mask** as the roughness
arm. The sampled tangent-space XY is counter-rotated by the inverse rotation,
written as a literal `mat2` because `transpose()` does not exist in GLSL ES 1.00.

Structure was respected: no uniform was hand-added, the block goes through
`assertDeclared`, and it references only `uAntiTile`, `uMacro` and `uMacroScale`,
all of which the table already declares unconditionally. No new
`customProgramCacheKey` term is needed because no new feature flag was
introduced.

**Deliberately not done:** decorrelating the 45.9 m mask period and moving the
alternate scale off 0.63. That defect is real and Terrain measured it, but it
belongs to all three arms equally. Fixing it on the normal alone would let the
bump switch to the rotated sample where the albedo had not, so a pebble's colour
and its relief would stop agreeing — a worse read than a long-period mask. It is
also NOTES case 23 territory: two changes at once measure nothing. Do the normal
arm alone, get the tilescan number, *then* move the periods on all three arms
together.

**Second command, after the number is in hand:** `node tools/shoot1.mjs`
(port 5131, poses `approach`, `lot`, `ground`, `wide`, `verge`, `puddle`,
`fringe`), then `node tools/framescan.mjs` over every frame in the round.

---

## 2. Building — `src/systems/BuildingSystem.ts`, `src/gen/building*.ts`

### Correction, 09:35 — "reachable on foot" is not "the aisle is aligned"

Read this before the section below, because a second agent has already acted on
the wrong reading of it and edited the film's route on the strength of it.

Building **has** changed the store since I measured it, and the change is real:
`ISLAND.x0` moved from −0.4 to **0.15**, which opens x −1.0 … 0.15 as a **1.15 m**
corridor from the front of the shop to the back, against 0.82 m and 0.80 m
before. That is what made the cooler and the grab bottle reachable on foot at
every body radius, and Perf's re-measurement is correct.

What it did **not** do is put a gap in the shelving at the door. From
`BuildingSystem.ts` as it stands right now:

```ts
const GONDOLA_Z = [34.6, 36.95];
const GONDOLA_X = { x0: -8.2, x1: -1.0, halfDepth: 0.6 };
const PLAN = { ..., doorX0: -6.575, doorX1: -5.425 };
const COOLER = { x0: -8.5, x1: -1.5, depth: 1.16, ... };  // front at z 38.64
```

So both runs still span x −8.2 … −1.0 across a door at x −6.0, and the aisle in
front of the cooler bank is still 38.64 − 37.55 = **1.09 m**. Every number in the
section below is unchanged. The route to the cooler is still round the east end;
it is now a **wider** detour, not a shorter one.

The consequence for anyone editing the film: a leg budgeted as if the shop could
be crossed directly will overrun, because the walk is still ~18 m to cover ~5 m,
which is ~13 s at 1.400 m/s. The route no longer takes anyone's word for it —
`cutIfOver` measures the planned path on the live collision field and cuts only
when it exceeds what the shot is worth, so the day the aisle *is* aligned the leg
becomes a walk again with no edit.

### From the film harness: a customer cannot walk to the drinks cooler

This is the one finding that blocks the deliverable. The 15–20 second video has to
show the fridge being opened, a bottle taken and the fridge closed, and a person
walking in through the front door **cannot get to the cooler**. This is not a
collision bug; the blockers are correct and describe the shop as it is built. The
shop's circulation is the problem.

Measured from `collision.field` at runtime (`node tools/filmwalk.mjs --no-capture`
prints the whole list):

| what | extent |
| --- | --- |
| shell | x −8.9 … 3.3, z 31.7 … 39.8 (interior faces) |
| front door opening | x −6.52 … −5.49 |
| gondola run A | x −8.2 … −1.0, z 34.0 … 35.2 |
| gondola run B | x −8.2 … −1.0, z 36.35 … 37.55 |
| cooler bank front | x −8.5 … −1.5, z 38.64 |
| counter / till | x −0.4 … 1.4, z 32.5 … 33.7 |
| east fixture | x 0.47 … 3.18, z 34.52 … 36.15 |

Both gondola runs span x −8.2 to −1.0, and the door is at x ≈ −6. So the runs
**cross the door's line of travel and are closed at the west end**: the gap
between the west end of the runs (x −8.2) and the inside face of the west wall
(x −8.9) is **0.70 m**, against a 0.64 m body — 30 mm a side, and no cell centre
in it is clear on a 125 mm planning grid. The only way through is round the east
end, and the route the flood fill returns is **18.8 m of walking to cover 4.99 m
in a straight line**, threading a 0.82 m corridor between the till (z 33.7) and
the east fixture (z 34.52) with four direction changes.

Two consequences:

1. **On screen.** 18.8 m at the 1.400 m/s walk is 13.4 seconds — two thirds of
   the entire video spent walking round shelving, before the fridge is even
   reached. There is no way to fit the three interactions into 15–20 s while the
   shop is laid out this way.
2. **In the walk.** The player physically sticks partway along that route
   (repeatably, at about x 1.70, z 32.18) rather than threading it. A 0.82 m gap
   with 90 mm clearance a side is not a corridor a walking human aims down.

**The one-line fix, if you want one:** align a gap in both gondola runs with the
door, at x −6.52 … −5.49 plus clearance — call it x −7.0 … −5.0 clear in both
runs. That gives a straight 7 m aisle from door to cooler, which is also how
every real forecourt shop is laid out: the drinks cooler is visible and directly
walkable from the entrance, because that is what it is for. Nothing else needs to
move.

**Second, smaller, and independent of the aisle above: the cooler doors swing
into a 1.09 m aisle.** Gondola run B ends at z 37.55 and the cooler bank front is
at z 38.64, so the aisle in front of the drinks cooler is 1.09 m. A cooler leaf
is about 0.55 m wide and swings out. Three measured consequences:

- The furthest back the camera can stand and still face a bottle square-on is
  **0.6 m**. The bottle sits at y 1.22 and the eye at 1.65, so the head pitches
  37 deg down, and the shot photographs shelf edges converging rather than a
  person looking into a fridge. The film compensates by aiming 320 mm above the
  bottle; that is a workaround, not a fix.
- Once a leaf is open it occupies z 38.09 to 38.64 — **the camera at z 38.12 is
  inside the swept volume.** There is nowhere to stand that is both in front of
  the bottle and out of the door's way.
- Therefore the film **cannot close the fridge door it opened**: from the only
  stance the aisle allows, the open leaf is beside and behind the camera and
  there is nothing to aim at. The route keeps the failing click in deliberately
  so this stays reported rather than quietly dropped. Two of the three fridge
  actions in the user's brief work (open, take a bottle); close does not, and the
  cause is the aisle width, not the interaction.

Pulling gondola run B back from z 37.55 to about z 36.9 would give 1.74 m — a
leaf's width plus a person — and fixes all three at once.

Do not solve this by widening the west gap from 0.70 m. A 0.70 m aisle beside a
wall is not a route a customer uses even when a body fits through it, and the
player would be squeezing along the wall rather than walking down the shop.

Re-verify with `node tools/filmwalk.mjs --no-capture --no-audio`, which prints
the route leg by leg and says for each stance whether it was reached directly or
only the long way round. When the aisle lands, the "through the shop to the
cooler" leg should report one or two legs and about 5 m, and the three fridge
clicks should stop reporting `MISSED`.

### The glazing wash, re-measured on the door approach

Building's Fresnel-coupled transmission has visibly landed. The film's stance
1.15 m off `entry-door-glass` at near-normal incidence now reads black point 30,
white 254, range 224, global sd 43.3, with the shelving, the NOW HIRING notice
and the ceiling grid all cleanly separated — nothing like the flat milky cream
the critic described. `probe-washscan.mjs` still flags the frame, but on a
different complaint than before: *"no black point — nothing in view is in
shadow"*, with 7.7% of the frame above luma 224 and a warm cast of +39. For a
frame that is entirely a fluorescent-lit interior at 1.15 m, having no shadow in
view is arguably correct, and that is a limitation of my detector rather than a
defect in the glazing — noted here so nobody chases it as one. The **oblique**
mirror regime is still unverified; that needs a stance out at 70–80° off normal,
which the film's route does not currently take.

### First command

```
node tools/shoot2.mjs
```

Full seven poses, port 5112. The last complete round is
**`2026-08-28T182757Z-BJCbm-gz`** (`KEEP` in place) and it does **not** contain
the transmission fix; a full round with everything was interrupted and never
completed. Redoing that capture is the first thing.

### What it must prove, and against what

1. **Black glazing rectangles are gone.** `node tools/probe-band.mjs` on
   `interior.png`, region `780,420,340,90`, must report **0.0% exactly
   `rgb(0,0,0)`**. Baseline on the critic's round was **34.7% exactly zero with
   nothing at all in luma 1..15** — a bimodal split with an empty gap, which is
   a shading failure and not an unlit object. Intermediate measurements for
   reference: `DoubleSide`→`FrontSide` 22.7%, roughness map off 11.8%,
   transmission off entirely 0.0%.
2. **Mortar joint depth, the two-light-angle test — NOT YET RUN.** This is the
   highest-value unrun measurement in this system.
   **Baseline to beat: head-joint contrast 9.6% on the lit front elevation
   against 7.6% on the shaded east elevation, ratio 1.26** — i.e. effectively no
   light-direction dependence, which is exactly the critic's claim quantified.
   Use `tools/probe-joints.mjs` on the reframed `wall.png` (the corner at
   x 3.5 puts both elevations in one frame), left half shaded east against right
   half lit front. **Use `--bed` / `--head` period locks computed from geometry
   and masonry-only regions.** The one previous attempt placed the regions blind,
   caught the ladder, conduit, streaks and the storefront glazing, and
   autodetected periods of 39–61 px that do not correspond to coursing;
   inconclusive, not a pass and not a fail.
   For this site's sun (az 203, el 6.2) `bcGrooveShadow()` predicts hard dark
   **verticals** on the lit front (head joints 97% shadowed, bed joints 12%) and
   faint uniform joints on the shaded east.
3. Health gate output on all seven poses.

### Still open and known

Analytic coursing in `buildingCoursing.ts` — attempt 2 never reached
`__SCENE_READY`. `shoot2.mjs` now dumps the page console on a ready timeout, and
that dump will probably name the bug in one run:
`node tools/shoot2.mjs --shots=front --query=dbgJoint=6`. Prove it with a
`dbgJoint=0` vs `dbgJoint=6` diff — the injector paints joints pure red above
4.5 specifically so that a **zero-pixel diff can only mean it is not wired**,
which is how attempt 1 was caught.

Cheap unblock while you are there: `src/systems/BuildingSystem.ts:8` imports
`BuildingMaps` as a value when it is a type-only export, so Node's strip-only TS
mode cannot erase it and **no CPU tool under `tools/` can load the building at
all**. Make it `import { type BuildingMaps }` as `textures.ts` already does.

---

## 3. Pumps — `src/systems/PumpSystem.ts`, `src/gen/pump*.ts`, `src/gen/hardsurface.ts`

### First command

```
node tools/shoot3.mjs
```

Port 5113. Nothing else is needed: the three outstanding fixes are already in
the tree and typecheck.

### What it must prove, and against what

- **Nominated round to compare against: `2026-08-28T182951Z-67c77176358c`**
  (11/11 shots, manifest written, RTX 4060, `__SYSTEM_ERRORS` empty, `KEEP`
  file present).
  **Do not score `2026-08-28T183859Z-92bb895893a5`** — 9 shots, no manifest, so
  `finalise()` never asserted the GPU or the error list. It carries a
  `DO-NOT-JUDGE` file.
- `panels.png`: the horizontal shut line must read as a **line**, not as the row
  of black tabs in the nominated round. Then `tools/seamprobe.mjs <panels.png>`
  — every joint must still read darker in the slot than the plate beside it. The
  round that worked measured **10 to 66 of 255 darker in the slot, lip 12 to 19
  brighter**; the version before it measured **−3.9**, i.e. the slot brighter
  than the plate.
- `hose.png`: the hose must read as **black semi-gloss rubber**, not warm brown.
- `bollard.png`: chips hard-edged and discrete, no belt rows.
- Per-unit variation, `tools/regiondiff.mjs` with `--shots=unit1,unit2,unit3`:
  noise floor is **3.03/255** (a pair a critic called "one asset"), properly
  phased materials measure **33–53**, current weakest cabinet pair is **5.46**
  (unit1 vs unit2) and unit1 vs unit3 is **21.28**. 5.46 is above noise but thin;
  the cause is that the band permutation `[1, 0, 2]` hands pumps 1 and 2
  *adjacent* thirds of every stratified range.

### Verified present in the tree this session (CPU-only, by reading source)

Both of the fixes the handover described as written-but-uncaptured are genuinely
there. Nothing was re-derived and nothing was touched.

- **Hose overpaint.** `PumpSystem.ts` `hoseMat` is `color: 0x17171a`,
  `roughness: 0.52`, and its `unitGrime` call is `film: 0.12`, `dust: 0.16`,
  `roughGain: 0.55`. That is the documented fix (film/dust cut from 0.42/0.5,
  roughness from 0.78). It still goes through `unitGrime`, not `applyGrime`
  directly, so the per-unit field phase is intact.
- **Horizontal shut lines.** `pumpParts.ts` uses a flat `drop = 0.0055` with
  `0.85 + j * 0.35` jitter. `SUN_ELEV` and the `site` import are gone from the
  file (only a comment naming the old `LAP / tan(SUN_ELEV)` = 20.6 mm formula
  remains, explaining why it was wrong). **This needs capture, not code.** The
  trigonometry was deliberately not re-derived this session.

---

## 4. Lighting — `src/systems/LightingSystem.ts`, `lightSky.ts`, `lightShadows.ts`, `lightInterior.ts`

### First command

```
node tools/shoot4.mjs --variants='worldenv|worldenv=1&envdump=1'
```

Lighting's own queue puts **interior bounce** first and the world capture
second, and that ordering is defensible on this system's merits. This plan
inverts it for one run only, because the world capture is the single
cross-system blocker (see §7) and the instrumentation to find the bug is already
in place and has never been run — it is likely to be one capture's work.

### What it must prove

`FaceStat` now carries `bad` and `badBox`, so the dump prints the **face and
bounding box of the non-finite pixels**. That should identify the offending
object in one capture. Baseline to explain: **1814 non-finite cube pixels
becoming 17892 poisoned PMREM pixels, peak finite channel 94.7** — so this is a
shader NaN (most likely `normalize()` of a degenerate vector, or a divide at a
grazing angle, on geometry that is sub-pixel at the cube's 256²), *not*
half-float overflow.

If the culprit belongs to another system, the capture still needs a sanitize
step — the environment must not be poisonable by any single object. CPU-sanitize
the read-back faces then `pmrem.fromCubemap` on a rebuilt `CubeTexture`, and
**check the face row order before trusting it**: cube-face readback is not
bottom-up like a 2D target, which has already cost one wrong dump orientation.

### The second bug on that path, diagnosed and not fixed

Capture-time shadow refit blacks out the scene, and *this*, not the NaN, is what
produced "ground darker as it gets closer to camera". `ensureWorldEnvironment`
calls `fitSunShadowSphere` around the capture point and manipulates
`shadowMap.autoUpdate` / `needsUpdate`; everything inside `shadowFit.distance`
(**80 m**) then renders fully shadowed, and 80 m is exactly where vegetation's
fade-to-zero sat. The main-camera refit in `update()` does not recover it.
Confirm whether `update()`'s refit is order- or movement-gated before changing
anything. `fitSunShadowSphere` itself is not suspected.

### Numbers that define "still healthy" on the default path

- Sky-only PMREM: **mean 0.0741, max 2.852, intensity 1.0**.
- Round `2026-08-28T181217Z-f4e09610c4b6` (`KEEP`): lower third **23.5**
  (vegetation's healthy 24.2 / broken 0.0), sky **137.0** (their 135.8),
  `framescan` finds no dead zone.
- `skyRadiance`: `gpuAgreement` **0.0142**, `verified: true`, 18 probes.
  Divergence above 2% pushes to `__SYSTEM_ERRORS`.
- Shadow config for the cascade artefact hunt (`tools/probe-block.mjs`):
  `mapSize 8192`, `distance 80`, `bias -0.00016`, `normalBias 0.055`,
  `radius 3.2`, `texel 0.0194`.

### Two invariants that must survive whatever you do — see §7

`LightingSystem.ts:291` `worldEnvEnabled = q.get("worldenv") === "1"`, and
`LightingSystem.ts:563` the non-finite guard that **rejects**.

---

## 5. Vegetation — `src/gen/veg*.ts`, `src/systems/VegetationSystem.ts`

### First command

```
KEEP=1 node tools/shoot6.mjs && node tools/framescan.mjs shots/system6/rounds/<id>/*.png
```

Seven presets now, including `sunlit` — the first pose in the project with the
sun **behind** the camera (forward·sunDirection = −0.991, checked with the dot
product because the first attempt scored +0.48 and was still back-lit). No critic
has ever seen a lit crown.

### What it must prove, and against what

`framescan`'s `RULED HORIZON` test, on `wide.png`.

**Baseline: 0.96 px raggedness (mean pixels the skyline moves between adjacent
columns) and 76% identical adjacent columns.** Lighting measured 0.39 px / 94
luma from its own pose. Both must improve. Nobody knows by how much.

**If raggedness is still under about 1.5 px, the remaining cause is sampling on
the other three bands, not amplitude** — raise their `samples` the same way.

The related retired diagnosis, worth not re-chasing: the "distant lake" was never
a colour problem. The pale strip peaks at **luma 171.5** while the brightest
authored horizon band is about **152**, so the strip is *sky*. What made sky read
as water was the band edge underneath it — 76% identical adjacent columns
dropping 55 luma across the edge, i.e. a shoreline. Water, "flat wall",
"cardboard cutout", "constant height" and "comb-like skyline" are one defect.

### Verified present in the tree this session (CPU-only, by reading source)

The sampling fix is **already landed** and did not need re-doing:
`HORIZON_BANDS[0]` (the 520 m near band, the one that sets the skyline because
it has the greatest apparent height, 13.5/520 against 16/780) carries
`samples: 5632`, up from 2560, with the reasoning written at the call site. The
other three bands remain at 3072 — that is the deliberate next lever if the
number above does not move far enough. Amplitude work (`envelope()` standardised
and `tanh`-squashed rather than clamped: simulated span 0.561 → 0.957, height
range 2.80 → 4.78 m of 5, edge 7.2 → 12.2 px, no plateau) is also in the tree
and also uncaptured.

### Owed to the collision contract: one line, and the treeline stops being a ghost

`src/core/collision.ts` makes anything solid that publishes a service whose key
ends in `.blockers`. Every other producer on the site has been bridged by a
derivation adapter that reads geometry the owner already publishes — but
vegetation cannot be, because **every trunk on the site is merged into a single
`veg-pine-wood` mesh** whose bounding box is the whole 3.5 km treeline, and
`VegetationSystem` publishes nothing at all.

The player currently walks straight through every pine, fence post and utility
pole. Satisfying this is one `provide` at the end of `init`:

```ts
// Trunks only. Foliage must stay walk-through: it is 10650 instanced cards.
game.provide(
  "vegetation.blockers",
  nearTrunks.map((t) => ({ minX: t.x - r, maxX: t.x + r, minZ: t.z - r, maxZ: t.z + r }))
);
```

Three requirements. The first is the one that can be satisfied wrongly while
still looking satisfied, so the reasoning is spelled out rather than left as an
instruction:

1. **Near trunks only — cull to roughly 60 m of the forecourt before you
   publish, and if the thing you are publishing genuinely spans the site,
   publish it as several groups rather than one.** The broad phase is *one
   rectangle per group*, tested before any member of that group is looked at.
   That rectangle is the union of everything in the group, so a group holding
   one trunk at 3 km has a group rectangle 3 km across, which contains the
   player at all times, which means the broad phase rejects nothing and **every
   member of that group is tested on every frame, forever**. Publishing all of
   them is not "the same work plus some distant rectangles"; it is the
   difference between four comparisons and three thousand. A group is a
   locality claim, and the cost of a group is set by its worst-placed member,
   not by its typical one.

   The "or split" half of that matters more than it first looks, and it is a
   correction to the earlier wording here, which only said "cull". **A
   perimeter fence cannot be culled to the forecourt and still be a fence.**
   Its extent is the point of it. The answer for anything spatially extended —
   a fence line, a row of poles, a treeline — is therefore to publish it as a
   handful of locally compact groups (say one per run of eight posts) instead
   of one group of sixty. Sixty posts in one group is sixty tests per frame
   everywhere on the site; the same sixty posts in eight groups is eight
   rectangle tests, of which at most one or two survive. Same geometry, same
   published contract, and the broad phase starts doing its job.

   *Status: `vegetation.blockers` has since landed and publishes 58 posts and
   poles — the right geometry, at the right radii, unpadded. It is one flat
   array, so it becomes one group whose rectangle is roughly 90 x 50 m and
   spans the whole walkable site, and the broad phase never rejects it. The
   measured cost is 382 ns/frame worst case across all 83 blockers, so this is
   a refinement and not a defect; splitting it is worth doing the next time
   that file is open, not worth a special trip.*
2. **Trunks, not crowns.** Use the trunk radius at breast height, not the drip
   line. Walking into a canopy is normal; walking into a bole is not. Foliage
   must stay walk-through regardless — it is 10650 instanced cards and there is
   no version of this where that becomes collision geometry.
3. **Do not pre-inflate by a body radius.** The consumer adds its own, and a
   rectangle that has already been padded gets padded twice.

**`veg-fence-posts`, `veg-fence-tposts` and `veg-poles` want the same treatment
and are the higher priority of the two** — and are the ones that actually
arrived first, ahead of the trunks. A fence you can walk through is more
noticeable than a tree you can walk through, because a fence's entire job is to
say where the site ends — a player who strolls through one has been told the
boundary is not real. Utility poles are 300 mm of solid timber standing in open
ground where nothing else obstructs, which is exactly where an unexpected
non-collision reads as a bug rather than as generosity. Wire is not solid, and
neither is the horizon band.

### For Building: the storefront glazing eats 42% of the dynamic range

A critic called `walkprobe/at-wall.png` broken — "washed to a flat milky cream
with almost no contrast remaining". It is, and the cause is the glazing stack,
not lighting, fog, or the interior. Measured by suppressing one layer at a time
from a fixed camera 0.32 m outside the pane, everything else held constant
(`tools/_washab.mjs`, frames in `shots/washab/`, measured with
`tools/probe-washscan.mjs`):

| suppressed | black point | luma range | over 224 |
| --- | --- | --- | --- |
| nothing (as shipped) | 70 | 139 | 0.0% |
| the two additive `-refl` passes | 70 | 139 | 0.0% |
| the alpha tint (`storefront-glass` + `-inner`) | 39 | 170 | 0.0% |
| `storefront-grime` | 54 | 197 | 5.1% |
| all glazing | **13** | **238** | 3.4% |

Read three ways:

- **The interior behind the glass is fine.** With the glazing suppressed the
  same camera gives black point 13 and a 238 range, statistically the same as a
  camera standing inside the shop with nothing in the way (22 / 232). Nothing
  needs fixing in the store.
- **The two `AdditiveBlending` reflection passes are innocent** — removing them
  moves the black point by zero. That is the correct Fresnel behaviour at the
  near-normal incidence this camera sits at, so they are doing their job.
- **The constant alpha tint is the problem.** `storefront-glass` at opacity 0.24
  over `storefront-glass-inner` at 0.13 gives a combined transmittance of 0.66,
  so **34% of everything behind the pane is replaced by a flat near-white
  constant** (`#d7e2dc` / `#dae4de`) with `envMapIntensity: 0` — a veil that
  does not vary with viewing angle, which is not a thing glass does. Real
  glazing at normal incidence transmits ~92%. `storefront-grime` at opacity 0.9
  compounds it and is what flattens the highlights specifically (it alone takes
  `over 224` from 5.1% to 0.0%).

Not exposure: an exposure sweep at the interior stance moves the black point
22 → 12 → 5 for 1.0 / 0.6 / 0.35 while the range holds at 232–245, which is
exposure behaving correctly. Not fog either: `FogExp2` at density 0.0027 gives a
fog factor of 1.8e-4 at 5 m.

### For everyone authoring procedural textures: check `size / freq` before adding octaves

One finding, one grep, and it is the same shape as the mip case that was
broadcast earlier tonight — one step earlier in the pipeline, where it is worse.

**`fbm(size, freq)`'s frequency is lattice cells across the whole map, so a
feature's size in texels is `size / freq`. Below 2 it is finer than the grid
storing it, and it does not vanish — it aliases into uncorrelated per-texel
values, which is white noise, which renders as a uniform fine grain over
everything it touches.** A texture sampled above its design frequency returns
its mean and the variation is merely absent; content *written* above the
resolution of its buffer is present, visible, and looks like a deliberate
material choice.

Terrain's dirt height field had three of five clod octaves sub-texel and a
gravel Worley at 2.1 texels carrying three and a half times the clods' variance.
Measured autocorrelation was 0.41 at one texel and zero by four: very nearly
pure noise. It had rendered for many rounds as an evenly dappled carpet and
every review read it as a material rather than a defect.

**The grep is `fbm(`, `worley(`, `valueNoise(` and `gradientNoise(`** — anywhere
the second argument approaches the first divided by two. Worth checking whatever
you generate at 1024 or below with a base frequency in the hundreds.

Two things that are not obvious from the diagnosis:

**The fix is usually to move the feature, not to reduce it.** 35 mm gravel on a
16.6 mm-per-texel map cannot be shaped, only speckled — so it keeps full weight
in albedo, where aliasing reads as speckle and speckle is what gravel looks
like, and loses its weight in the normal map, where the same aliasing reads as a
crust. Albedo tolerates what a normal map cannot.

**Removing the loudest offender promotes the next one.** Gravel went first and
dead grass, at 2.0 texels, immediately took over the role. Check the
autocorrelation, not the term you looked at first.

Terrain capped octaves at its own call sites rather than inside `fbm`, because
six systems share it and changing how many octaves it returns would move
everyone's pixels at once. `tools/dirtspectrum.mjs` shows the measurement if it
is useful as a pattern; the two numbers that matter are autocorrelation against
texel lag and the spread of local slope across the map.

### For whoever owns system2 and system3 captures: the repo-wide integrity scan flags ten files

Asked whether `archive --scan`'s scope needed widening. **It does not — it is
already repo-wide.** Run with no directory argument it defaults to the whole
working tree, skips `node_modules` and `.git`, and already sniffs extensionless
files to catch an image written to a path that was meant to be an argument. The
narrow scope is purely in how harnesses invoke it, and `node tools/archive.mjs
--scan` from the repo root is the whole fix.

With one caveat that argues against making it a gate in the capture path. Run
repo-wide it currently reports:

    100, 560                          zero-pixel PNGs, owner unknown (see below)
    shots/system2/cooler-expo.png     below the byte floor
    shots/system2/cooler-v2.png       below the byte floor
    shots/system2/interior-expo.png   below the byte floor
    shots/system2/interior-v2.png     below the byte floor
    shots/system3/_look/nzid*.png     below the byte floor, four files

The `nzid` frames look like normal-ID visualisations, and a diagnostic render of
flat-shaded ID colours **is** mostly flat by design — it will compress small and
trip a byte floor while being exactly correct. So a repo-wide scan wired into
every capture would flag correct output, and a test that flags a correct surface
costs more trust than it saves. The suggestion is a per-session repo-wide run
whose output a person reads, rather than a gate. Owners: please confirm whether
those eight are deliberate, and if they are, they want either a naming
convention the scan can skip or a note so nobody chases them again.

### For whoever owns a cropping harness: two zero-pixel captures in the repo root

Found while checking teardown, reported rather than deleted because the
timestamps are the only way to identify the owner. Two files in the repo root,
untracked, named by a number:

    100   65 bytes   PNG, 1200 x 0    written 06:01 local
    560   65 bytes   PNG,    0 x 0    written 05:53 local

Both are *valid* PNGs that decode without error and contain no pixels, and both
are named as though a dimension argument was consumed as an output path — a
crop or resize invoked with its arguments one position out. `1200 x 0` and
`0 x 0` alongside filenames `100` and `560` is consistent with a `1200 560` /
`1200 100` width-height pair being mis-parsed.

Two things worth knowing rather than the files themselves:

**The shared gate catches these correctly.** Pointed at them,
`node tools/archive.mjs --scan <dir>` reports "PNG is 0x0 — a valid file
containing no pixels", and exits 1. That assertion is working as intended.

**But it will never see these, because they are in the repo root and the scan is
pointed at round directories.** A harness that writes its output somewhere
unexpected has also escaped the check on its output. If a tool of yours can
produce a path from an argument, the integrity scan wants pointing at wherever
that path can land, not only at where it is supposed to.

### For Canopy, from Terrain: may I give `sweepProfile`'s chip a real long octave?

**A direct ask, and it needs one word back.** You own the only other consumer of
`sweepProfile`'s `chip` option — `buildFascia` and the coping sweep — so this
would move your pixels and I am not doing it unilaterally.

The chip is written as two octaves:

    hash1(along * 2.9) * 1.0 + hash1(along * 11.3) * 0.6

and `hash1` is a bare hash with no interpolation, so those are not octaves at
all: they are the same white noise with two seeds, and the sum is one noise with
a larger amplitude (see `NOTES.md`, "a frequency multiplier inside a hash is not
a frequency"). The consequence is small but real — **the arris gets fine
per-station nibbles and never the long spalls the two-octave form implies.**

`geo.ts` now has `vnoise1`, real value noise with a real wavelength. Giving the
long term a ~1.2 m wavelength through it would add occasional multi-station
spalls to your fascia and coping arrises and change nothing else: same
amplitude, same seeds, same per-station short term, no change to winding,
geometry count or UVs. Chipping genuinely is uncorrelated station to station, so
the short term is correct as it stands and stays.

**Yes and I will do it; no and I will leave it and note it as declined.** Either
answer is fine — this is a small quality item, not a defect.

**Separately, and this one is not optional: the `flip` winding migration.**
`flip: true` inverts winding because negating the lateral direction mirrors the
surface, so `canopyParts.ts` compensating with `.reverse()` on two profiles and
Terrain compensating the same way on `pump-islands` are both local workarounds
for one shared bug. The three-line fix is written out in the `WINDING HAZARD`
comment in `geo.ts` and deliberately not applied, because applying it alone
would double-invert your fascia and coping. It wants one commit that changes
`sweepProfile` and un-reverses all three profiles together. Whichever of us is
quieter takes it; Terrain will report when it lands so nobody re-derives it.

**One correction to your inside-out test, and it is worth having:** it reports
Terrain's `curbs` inside out, and they are not. All four runs pass `flip: false`
and are authored lateral-outward, and a per-strip census puts the outer flank
(profile p3→p4, lateral 0.165) at nz −1.000 on the −Z run, which is correct. The
face reading **+1.000** is the one at lateral 0 — on a box section that is the
*inner* flank, the gutter face, and it is supposed to look toward the pad. The
test appears to assume lateral-0 is the outer flank. Worth fixing, because a
test that flags a correct surface costs more trust than it saves — and your
catch on `pump-islands` was real and is fixed, so the test is earning its keep
otherwise.

### For Vegetation, from Terrain: three correct call sites that will not extend

**No bug, nothing to fix, and that is why this is worth sending.**

A repo-wide audit of bare hashes this round found `vegMat.ts` lines 281, 290 and
291 feeding continuous world coordinates to a bare hash:

    fract(v.x * 0.71 + v.z * 1.13)      // lift
    fract(v.x * 0.317 + v.z * 0.211)    // angle
    fract(v.x * 0.129 - v.z * 0.283)    // thickness

`fract` there is `sin(v * 12.9898) * 43758.5453` with no interpolation, so it
decorrelates on any change of input. Each of these is therefore **white noise
per vertex**, which is exactly what a per-vertex lift, angle and thickness want,
and no comment claims otherwise. Correct as written.

The thing worth knowing: **it is not extensible, and the failure will look like
a landed change.** If anyone later wants those to vary *smoothly* across a mat,
or wants a long-wavelength trend in mat thickness across the site, the natural
move is to lower the multiplier — and that will do nothing at all, because there
is no wavelength in there to lower. The frame will look plausible, the amplitude
will be unchanged and checkable, and the structural claim will be false and
unmeasurable. That is the precise shape that cost Terrain several rounds on the
pavement edge tonight (`NOTES.md`: "the checkable half of a claim is not the
load-bearing half").

For any of that, use `valueNoise`, `gradientNoise` or `fbm` from
`src/gen/noise.ts` — all lattice-based, all with real wavelengths — or
`vnoise1` in `geo.ts` for the 1-D case. They have been there the whole time;
Terrain's own defect was hand-rolling instead of using them.

### For Canopy, from Terrain: put the downpipe outlet where `grime` is already high

Terrain publishes `groundAccum.grime(x, z)` — 0..1, dark organic film where
water stands **and does not move**. It is not the same shape as `wetness`: it
needs standing water *and* a slope under about 0.05, because above that the
water is running and the film never establishes. It is 10% active over the lot
and peaks at 0.88, so the places it is high are specific and few.

A downpipe discharging onto ground that `grime` already reports as high is two
systems agreeing about one physical fact, and it costs nothing: Terrain has
already darkened that ground for its own reasons, and the stain will read as
caused by the pipe rather than as two unrelated decals that happen to overlap.
The reverse — a downpipe discharging onto crowned pavement that drains — reads
as a pipe that has never rained.

Concretely: sample `grime` at your candidate outlet positions and prefer the
high ones, or ask for the maxima and Terrain will report them. Terrain will also
take a splash-back radius from you if the outlet lands somewhere `grime` is low
and the pipe position is fixed for other reasons; that is a better fix than
either system inventing a stain the other does not know about.

Also available and relevant to column bases and soot: `fines(x, z)` for general
ground dirtiness, `shelter(x, z)` for still air, and `wallBase(distOut, up,
faceX, faceZ)` for a column's splash-and-dirt line — note that `splash` and
`drift` are deliberately opposite, splash on the surface dying with height and
drift out from it on the ground. Full contract in §7.

### For Lighting: the store interior is running hot at the top end

Not a defect, just a number worth having. From a stance in the aisle facing the
cooler run, **11.3% of the frame is above luma 224** with a median of 183. The
interior reaches shadow properly (black point 36, range 218), so the bounce
that landed tonight is working — but the cooler fixtures are close to clipping
and there is little headroom left above them. `renderer.toneMappingExposure` is
1.25.

### A coordination hazard: `NOTES.md` case numbers are not stable identifiers

Three agents independently picked "33" for their next case in one evening, and
two of them picked "34" as well. Numbering is assigned by whoever writes last
and nobody holds a lock, so **cite a case by its title or its opening phrase,
not by its number** — a cross-reference to "case 31" may point somewhere else by
the time it is read. When you add a case, grep the existing numbers first and
take one clear of every table in the file, not just the table you are writing
in; the file has several. If you find your own number has been taken since you
wrote it, renumber *yours* rather than someone else's, who may still be editing.

Nobody else is owed anything: pumps, bollards, the parked car and the entry door
leaf are all derived. Those adapters are skipped automatically the moment the
owner publishes its own key, so adopting the contract is purely additive — there
is nothing to delete in `collision.ts` first.

**There is no canopy in this scene.** A survey of the live scene graph found no
canopy deck, fascia or columns anywhere: the only structures are the building,
three dispensers, four bollards, the ice machine, the propane cage and the car.
`AudioSystem` models a canopy in its reverb (`AudioSystem.ts:423`) and
`lightShadows.ts` names one in a comment, so at least two systems believe it
exists. Either it was never built or it was lost; worth a decision rather than a
discovery.

---

## 6. Car — `src/systems/CarSystem.ts`, `src/gen/car*.ts`

### First command

```
node tools/shootcar.mjs --tag t8
```

t8 (darker void, finer backing panels) was interrupted and never captured.
Latest captured is **`2026-08-28T183337Z-088de0d2cbe2`** (t7).

### What it must prove, and against what

- **`nose_close`, the grille edge.** `nose_close` is 34° vertical FOV at 2.176 m
  over 900 px, so visible height is 1.331 m and **one pixel is 1.48 mm**. The
  remaining blocky steps measure **22–33 mm**, i.e. 15–22 px — a real edge that
  is really wrong, not a sampling problem. The cut is *not* the cause:
  `tools/cutbounds.mjs` puts the hole at |x| 0.303–0.309 against a 0.305 spec
  and 0.450–0.462 against 0.452, within 10 mm, on a cap that is already
  48 rings × 528 spokes. The step size matched the **backing panel's own grid**
  (18×6 over a 720×180 mm panel = 40×30 mm facets); t8 takes those to 44×16 and
  52×16 and cuts `blackTrim` dust 0.33 → 0.12 with cool colours.
  **Three rounds have now been spent guessing at this edge.** If t8 does not fix
  it, stop guessing: colour the backing panel distinctly for one throwaway round
  and identify the surface.
- **`side`** — the 40 mm beltline drop. Belt was 1.078 on a 1.4585 m car =
  **0.739 of overall height against ~0.707 real**, glass 0.328 = 0.225 against
  ~0.27 real; both errors push the same way and match the "toy / Hot-Wheels mass
  distribution" note. Now 1.038 → ratio **0.712**, glass **0.368**.
- **`wheel_close`** — tyre bead ring and contact bulge. Do **not** re-litigate
  ride height: measured in tyre-relative units, arch lip y≈510, tyre top y≈512,
  tyre bottom y≈844, so the gap is **10 px on a 332 px tyre ≈ 0.03 of diameter**
  against 0.195 for one sidewall. The critic's "a full extra sidewall" is out by
  roughly 6x and the nominal 36 mm crown gap is correct. The real defect there is
  **contrast** — body panel 17, arch interior 17, tyre 6 — and that is downstream
  of the environment (§7).
- `shootcar.mjs` reads back the PMREM and **fails the round on any non-finite
  texel before spending a capture**, pointing at Lighting. If it fires, go to §4.

Only fully unbuilt item that does not depend on the environment: the boot lid's
longitudinal side cuts.

---

## 7. Cross-system dependency order

### Everything reflective is behind Lighting's PMREM world capture

`scene.environment` is a **sky-only** PMREM. `buildEnvironment` in `lightSky.ts`
renders a two-object scene — sky dome plus one flat-coloured ground disc — so the
world is never in it, and the **lower hemisphere is a single constant colour,
standard deviation 0.0, range 0.0**. Measured by two systems independently.

Proof, if anyone doubts it: set the car's paint to perfect chrome (metalness 1,
roughness 0) and it renders as a **flat tan panel**
(`shots/car/env/mirror_r0.png`). A roughness ladder gives flank range 83.1 at
r = 0.00 and 50.7 at the shipped 0.42 — roughness is second-order, because there
is no structure to reflect at any roughness. Reproduce with
`node tools/carenv.mjs --no-build --isolate-only --env-dump`.

**Blocked until it lands — do not tune these, and do not accept a critic note
about them as actionable:**

| system | blocked item |
|---|---|
| Car | paint, glass, creases, lamp materials, **and the metalness decision** — metalness currently only controls how much flat grey is mixed into the paint, which is why 0.0 went near-white and 0.36 reads dead |
| Car | wheel-arch contrast (the "void" read is downstream of reflection, not of ride height) |
| Pumps | cabinet "stucco vs painted steel" — painted steel is defined by what it reflects; the chamfer rim highlight is the acceptance test |
| Pumps | display glass ("the dirtiest surface on the unit"), which wants sky reflection and low-sun smear |
| Building | storefront and cooler glass reflectivity. Under the new alpha-blended IGU, `opacity` scales the env reflection *and* the show-through together; when the PMREM has content, the reflection wants to become its own additive layer so the two can be set separately |
| Terrain | wet-surface and puddle specular. Build the geometry, the roughness and the darkening now; re-judge the specular read afterwards |

Rough order of work, therefore:

1. **Lighting: world capture** (NaN + capture-time shadow refit). Unblocks six
   items across four systems.
2. **Lighting: interior bounce** (`lightInterior.ts`). Blocks Building's whole
   interior and `door_spill`. The building agent's null-result-with-live-control
   is conclusive: a band of pure-black product does not move one pixel between
   `?ienv=0.25` and `?ienv=1.0` while a shelf 200 px away in the same frame moves
   33%, and a 4.3x intensity change buys 2.8/255. The troffers are
   `RectAreaLight`s, so there is no indirect term at all and every downward and
   rearward face clamps to black. **Do not compensate with albedo** — the
   building agent deliberately documented it at the call site instead.
3. Everything else in parallel: Terrain's soil field and wetness, Vegetation's
   inter-plant ground mat, Building's products and streak sources, Pumps' nozzle
   geometry, Car's boot cuts.

Two things that are *not* blocked and are worth doing early, because they are
each a system's largest remaining defect and neither depends on reflection:
Pumps' **nozzle form** and Building's **product silhouette**.

### Terrain's `groundSoil` contract IS published — safe to code against

*(This section previously said the opposite. It was correct when written and is
no longer. `groundSoil` was published in round `2026-08-28T204414Z` after
`tools/soilprobe.mjs` agreed with the GPU, per the `skyRadiance` precedent.)*

`game.provide("groundSoil", ...)`, from `TerrainSystem.init`. All pure functions
of world XZ, no renderer state, callable a hundred thousand times before the
first frame.

| call | returns |
|---|---|
| `disturbance(x, z)` | 0 = undisturbed crust, 1 = trafficked / compacted |
| `wetness(x, z)` | 0 = dry, 1 = standing water |
| `drainage(x, z)` | metres above/below the local drainage datum; negative is a low spot |
| `material(x, z)` | 0 = coarse gravelly crust, 1 = fine pale clay |
| `waterLevels` | world Y of the standing water in each of `site.LOW_SPOTS` |

**One documented divergence, deliberate:** the shader dithers `wetness` inside
the shoreline band with a sub-metre world noise so the margin is ragged instead
of a smooth contour, and the CPU side does not reproduce that. Agreement is
exact in the interior of a pool and on dry ground, and approximate within about
0.3 m of the waterline. Scatter against this and you are scattering against the
field, which is right; do not use it to place something that must sit exactly on
the visible edge.

### Terrain's `groundAccum` contract — published, and the shape to copy

`game.provide("groundAccum", ...)`, built in `src/gen/groundAccum.ts`. Pure CPU,
no textures, no renderer state. Consumers: Vegetation (needle and leaf fall
under crowns), Building (wall base splash and dirt line), Pumps (the swept
island and its lee), Canopy (column bases, gutter discharge, soot).

**Why this is one service and not four.** Litter, leaf fall, blown dust and
gravel spill are not properties of the things they collect against. They are
properties of *where wind and water stop*, and those places are continuous
across a site and completely indifferent to which system owns the object
standing in them. Four systems each scattering their own debris would ring every
object neatly and leave every corner bare, which is exactly backwards: the
corner between a wall and a curb collects more than the middle of a wall does,
and the middle of an open lot collects nothing no matter how many objects are
near it.

**There are two kinds of entry point and the split is the whole design.**

**Fields** answer "what is on the ground here". They **cannot** know about any
caller's geometry, because Vegetation places its crowns and Building places its
walls long after this is built. They are made out of the ground: drainage,
slope, traffic and one prevailing wind.

| call | returns | measured over the lot |
|---|---|---|
| `shelter(x, z)` | 0..1, how still the air is — hollows, the swale, inside the curb line | mean 0.26, 51% active |
| `fines(x, z)` | 0..1, loose fine matter: dust, silt, grit. The general "dirtiness of this patch of ground", and the right thing to multiply a dirt overlay or a decal opacity by | mean 0.22, 99% active |
| `litter(x, z)` | **items per square metre** of wind-blown paper | mean 0.0030, peak 0.113, 29% active, ~34 items over the lot |
| `grime(x, z)` | 0..1, dark organic film where water stands *and does not move*. Needs standing water **and** a slope shallow enough that the water is not running, so it is not the same shape as `wetness` | mean 0.014, 10% active |
| `swept(x, z)` | 0..1, swept clean by wheels and feet | mean 0.14, 25% active |

**Profiles** are pure functions you evaluate against geometry only you know.
They take positions as arguments and hold no state, so there is **no
registration step, no ordering constraint between systems, and nothing to go
stale when a caller moves something.**

| call | returns |
|---|---|
| `lee(x, z, ox, oz, radius)` | 0..1 wake weight downwind of a round obstacle the caller owns. 1 immediately downwind, falling off over roughly five radii along the wind and one and a third across. Measured for radius 1.5: 0.98 at the obstacle, 0.76 at 2 m, 0.23 at 5 m, 0 at 9 m, 0 upwind |
| `wallBase(distOut, up, faceX, faceZ)` | `{ splash, drift }`, both 0..1, and **deliberately opposite** — see below. `distOut` metres out from the wall face along its outward normal, `up` metres above grade, `faceX`/`faceZ` the outward normal (need not be normalised) |
| `underCrown(x, z, cx, cz, radius)` | 0..1 fall accumulation under a crown the caller owns. Measured 0.12 at the trunk, peaking 0.75 at 0.72R, 0.24 at the drip line, 0 by 1.35R, with the whole pattern displaced downwind |
| `jitter(x, z, salt)` | deterministic 0..1 hash, so you can break up a field without seeding an RNG and without two systems accidentally sharing a sequence. Different salt, independent patterns; same salt, agreement |
| `wind` | `{ bearing, dirX, dirZ, strength }`, resolved from `site.WIND` |

**`splash` and `drift` are opposite and a consumer will get this backwards.**
*Splash* is rain that hit the ground and bounced back onto the wall: it lives
**on** the wall, dies with height (0.99 at grade, 0.06 at 0.5 m up — 180 mm
e-folding), and is stronger on the face **driven into** the weather. *Drift* is
matter that blew or washed against the base and stayed: it lives **out from** the
wall on the ground (0.50 at the wall, 0.04 at 0.25 m out), hardly at all above
grade, and favours the **sheltered** face.

**`underCrown` peaks at 0.72 of the radius, not at the trunk,** because that is
where a canopy actually sheds, and the whole pattern is displaced downwind.

**THE INTENDED USE IS THE PRODUCT OF A FIELD AND A PROFILE.** Sample a field for
how much matter this patch of ground gets at all, then multiply by a profile for
how your own object concentrates it. A crown over swept pavement should drop
less than the same crown over a sheltered corner, and **only you know there is a
crown while only this knows the pavement is swept.** Neither half is usable
alone.

**`litter` is a density, not a probability,** on purpose: multiply by your own
cell area and you get a count, and a consumer working at a different cell size
gets the same expected count. That is the property that stops three systems
disagreeing about how much litter the site has.

**Wind is `site.WIND`, one constant, bearing 2.9 rad — the direction the wind
blows *toward*, in the XZ plane.** That is `VegetationSystem`'s existing local
value adopted verbatim rather than re-authored, so trees that were already
leaning keep leaning the way they lean; Vegetation should switch its local
constant to the import when convenient. Four systems have to agree about wind or
the scene contradicts itself — tree lean, litter drift, the lee of every
obstacle and any smoke all point one way in a photograph, and a viewer reads a
disagreement long before being able to say why.

**No texture and no shader path, deliberately.** The consumers are scatter
passes. The ground's own dust and grime come from drainage, wetness and slope
in-shader — the same inputs these functions are built from — rather than from a
fifth field channel, because the soil field's four channels are full and a
second 2048² field would cost 22 MB to say something the shader can compute.

**Terrain is its own first consumer,** which is the only honest way to hand a
service over: `scatterDebris` places 1500 gravel stones by `fines` and 26 litter
items by `litter × cell area`, so a wrong distribution shows in Terrain's own
pixels before it shows in yours.

### Terrain's `pavementEdge(x)` contract — published, replacing the 190 mm constant

`game.provide("pavementEdge", ...)`. Requested by Vegetation, which was
reasoning against a hardcoded 190 mm excursion.

| call | returns |
|---|---|
| `edgeZ(x, side)` | world Z of the ragged asphalt edge at this X, for `side` −1 or +1. This is the actual line the shader and the height field use, not an approximation of it |
| `excursion` | metres of maximum excursion either side of the nominal edge. **Read this instead of hardcoding it** |
| `nominalZ(side)` | world Z of the straight nominal edge, so a caller can recover the offset |

There is now **no shared constant and no ceiling**: the excursion can grow and
callers that read `edgeZ` follow it for free. Excursion is 400 mm as of round
`2026-08-29T00Z`.

**Correction to the estimate that came with the request.** The concern was that
400 mm over a ~1 m scallop would put the edge line at a 40% slope. Measured, it
was far worse than that and for a different reason: **649 mm between adjacent
vertices, a 130% slope across one quad.** `ragEdge` was summing four "octaves"
built as `hash1(t * k)`, and `hash1` is a bare hash with no interpolation, so
those were not octaves at all — they were the same white noise with four seeds,
and every vertex was an independent draw from the full envelope (`NOTES.md`: a
frequency multiplier inside a hash is not a frequency). Rebuilt on real value
noise at 18 m, 6.5 m and 2.2 m, all above the 1.0 m Nyquist limit of a 0.5 m
vertex pitch, it now measures **10% slope and 52 mm between adjacent
vertices**, and it actually wanders over tens of metres for the first time.

So the geometry does *not* run out before Vegetation's tolerance does. There is
headroom, and the old edge was never delivering the long-wavelength wander its
comments claimed.

### Lighting's world capture must stay opt-in

**This is a hard constraint on Lighting, not a preference.** Five systems build
and tune against the default environment path.

- `LightingSystem.ts:291` — `worldEnvEnabled = q.get("worldenv") === "1"`. The
  world capture is **opt-in behind `?worldenv=1`** and must stay that way until
  it is clean. Making it the default with either bug live turns every other
  agent's captures black.
- `LightingSystem.ts:563` — the non-finite guard must keep **rejecting**:
  dispose the cube, keep the sky-only environment, push to `__SYSTEM_ERRORS`.
  It must not install-and-warn. Install-and-warn is what produced the black
  rounds, and it failed *silently* — the building agent's two black rounds
  (`KWMh7fM8`, `D3NKAXzn`) had `window.__SYSTEM_ERRORS === []` throughout while
  the console carried the non-finite message.
- The default sky-only environment has **not changed in structure or
  intensity**, so every other system's existing tuning is still valid. When the
  world capture does become the default, say so loudly: it will invalidate
  roughness, metalness and `envMapIntensity` tuning across all six systems at
  once.

---

## 8. What this CPU-only session changed, in full

Every item is **CPU-verified only**: `npx tsc --noEmit` clean across the tree,
source read end to end, arithmetic and GLSL scoping checked against the actual
`three` chunk source in `node_modules`. **No pixels. Nothing here is confirmed,
working or fixed.**

1. `src/gen/worldDetail.ts` — added the normal-map arm of the anti-tile
   cross-fade (§1). The only functional change of the session.
2. `HANDOVER-{building,pumps,lighting,vegetation,car}.md` — appended an
   identical, clearly delimited section describing the shared `Game.ts`
   isolation fix. No existing content was edited.
3. `HANDOVER-terrain.md` — appended a note that `worldDetail.ts` was touched.
4. This file.

Verified but not changed, because the fix was already in the tree: the
`Game.ts` isolation fix and NOTES case 32; Pumps' hose grime cut and flat 5.5 mm
shut line; Vegetation's 5632-sample near band.

---

## ALL SYSTEMS: verify the GPU per shot, from the live context. Startup checks prove nothing.

Added 2026-08-29 after the performance agent established that **Playwright adds
`--enable-unsafe-swiftshader` to the Chromium command line regardless of what a
harness passes**, and after an audit found several harnesses verifying the GPU
only once, at startup, on a throwaway probe page.

That check proves less than it looks like it proves. It establishes that *a*
page could reach the hardware once, minutes before any frame was captured, in a
context that was then closed. It says nothing about the context that drew the
frame you are about to measure — and a frame drawn by a software rasteriser is
not evidence about the frame we ship. Every number derived from it, every
before/after comparison, every "verified in pixels", is fiction.

`tools/shoot6.mjs` now does it the other way and the pattern is three lines.
Inside the same `page.evaluate` that already reads `renderer.info` for the draw
and triangle counts:

```js
const gl = renderer.getContext();
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
```

Then two hard failures per shot, not warnings:

1. `name` matches `/swiftshader|llvmpipe|software|basic render/i` → fail.
2. `name` differs from whatever the startup probe reported → fail. This is the
   one that catches the case above, where one context gets hardware and another
   does not.

Print it on the shot line so it is visible in every log — `shoot6` prints
`gpu=hw` — and put it in the round manifest so an archived round can be audited
later without re-running it.

The general principle, which is the same one behind the bundle-hash check: **an
environmental precondition must be re-established at the moment of measurement,
not once at the start of a session.** Between startup and your last shot, six
agents rebuild shared source, the driver can reset, and a context can be lost
and silently restored on a different backend.


## From Terrain: `pavedDistance(x, z)` and the shared near field

### `site.pavedDistance(x, z) -> metres`

Metres of clear ground between a point and the nearest hard surface. Covers the
carriageway with its ragged edge, the pad, and the driveway aprons.

| property | value |
|---|---|
| units | **metres** |
| range | 0 .. 60 (saturates at 60) |
| zero means | on pavement — so this is a **clearance test, not a multiplier** |
| conservative by | up to `ROAD_EDGE.excursion` (0.400 m) on the highway verge |
| direction of error | calls a thin strip of dirt "pavement", never the reverse |

The asymmetry is deliberate. Scattering a stone onto asphalt is a visible defect;
leaving a 200 mm strip bare is not. `pavementEdge(x)` remains the right call for
the highway edge line specifically; use this one when the question is "is this
spot dirt", which is what a scatter actually asks.

### The near field is one surface and it now has coverage in it

Terrain scatters 24,000 gravel stones, clumped, concentrated in a radius-80 m
ellipse about the pad, rejected within 120 mm of pavement and weighted by
`groundAccum.fines`. That is roughly 0.9 stones/m2 of dirt inside the disc, about
one clump per 10 m2, so about three clumps in the 30 m2 a walking camera has in
front of it. Cost: 534,780 static terrain triangles unchanged; drawn triangles per
frame 5,610,194 -> 6,523,566 across all passes including the shadow cascades,
which is 60.5 drawn triangles per stone for a 20-triangle icosahedron. `?force=thindebris`
returns the earlier 9,000-stone arm for comparison.

**Vegetation and Car: this is the number to divide by, not to add to.** Terrain now
occupies the 15-90 mm size band on open dirt. If you are scattering into the same
band, the near field will double up inside the clumps and stay bare between them,
which is the failure mode two independent scatters always produce. The cheap split
is by size and by placement rule: Terrain has loose stones following `fines`, so
tufts following `shelter` and larger debris following `lee` compose with it rather
than competing.

Three findings from getting this wrong twice, written up as `NOTES.md` 50 and 51,
that apply to any scatter:

- Count, extent and protrusion are three separate knobs and **only protrusion is
  what the eye receives**. Raising count while raising extent measures as progress
  and renders as nothing.
- **Do not place on the height field; place on the mesh.**
  `groundGeo.userData.surfaceAt(x, z)` now returns the surface that is actually
  rendered. The mesh is a chord across the field, so in the near field it sits up
  to 23.6 mm (p99) above it and buries anything placed at the field's own value —
  and because the shortest height term is Nyquist-gated off beyond 62 m, this
  happens *only* close to the camera and looks exactly like a distance cull.
- The reachable region is defined by **where the cameras are**, not by where the
  buildings are.

### On intermediate `metalness` in ground materials

Asked, and worth stating because others are about to change these. `metalness` is
the mixing weight between two different BRDFs — a dielectric with a coloured
diffuse lobe and a white specular at about 4% reflectance, and a conductor with no
diffuse lobe and a specular tinted by the base colour. A value of 0.3 does not
describe a slightly shiny dielectric; it describes 30% of a substance that does
not exist, and its most visible symptom is that the base colour starts tinting the
highlight, which is why "slightly metallic" asphalt goes muddy rather than glossy.

Every ground material here is 0.0 and should stay there. Wet asphalt, standing
water and polished concrete are all dielectrics: **the knob that makes them look
wet is `roughness`, plus the Fresnel ramp you get for free at grazing angles.**
The only legitimate intermediate values are a genuine per-texel mask over a
surface that is metal in some places and not others — flaking paint over steel, a
rusted panel — and then the texel is still 0 or 1 and the intermediate value is
just the filtering between them.


## From Terrain: `groundSurface(x, z)` is published

The service Car was waiting on. Available from the registry as `groundSurface`,
and the key contains "surface" so Car's pattern match over `serviceKeys()` finds
it without an edit.

| property | value |
|---|---|
| signature | `(x: number, z: number) => number` |
| units | **metres, absolute world Y** |
| range | finite everywhere; roughly -1.2 .. +1.0 over the site |
| relation to `groundHeight` | equal or greater where the field is concave |
| difference | 6.7 mm at p90 / 23.6 mm at p99 inside 62 m; 1.1 mm at p90 outside |

**Use this, not `groundHeight`, for anything that sits on the ground.**
`groundHeight` is the height *field*; this is the surface the mesh actually
renders. A mesh is a chord across its field, so wherever the field is concave the
drawn ground sits above it and an object placed at the field's own value is
buried. It matters most for a contact decal or a splash, whose whole job is the
line where two surfaces meet.

The near/far asymmetry is the trap. The shortest height octave is Nyquist-gated
off beyond 62 m, so the far field is smooth and the chord is nearly exact, while
the near field carries content the mesh cannot follow. **A feature placed on the
field therefore disappears close to the camera and looks perfect far from it,
which reads as a distance cull and sends you after culling and LOD.** That cost
Terrain two rounds on scattered gravel.

Published after the ground geometry is built rather than alongside the other four
services, which run earlier: a field can be published before there is any
geometry, a fact about a mesh cannot.

## From Terrain: the ground does not cast shadows, deliberately

`?force=terraincast` turns it on. Off by default because in the far field only
1.6% of the surface is steeper than the solar tangent of 0.198, so what it would
occlude is ground Lambert has already darkened, while the cost is rasterising a
deliberately-single 352,800-triangle graded mesh into every cascade. Near the lot
the numbers are better — 8.1% of the entrance tracks and 12.1% of the frontage
clear the tangent — so if this is ever wanted, the right form is a shadow-only
proxy over the near field sampling `userData.surfaceAt`, so the shadow matches
the surface that is drawn.

Gravel, litter, curbs, islands and slabs all cast and should keep casting: the
shadow is why 15-90 mm debris reads at all at this sun elevation. If cascade
budget needs recovering, the free end is the **far** cascades, where a 40 mm stone
casts a sub-pixel shadow.

## From Terrain: surfaces under cover can now declare a rain shadow

`SoilDetail` in `src/gen/worldDetail.ts` takes an optional `shelter` rect:

    shelter?: { minX, maxX, minZ, maxZ, softness?, floor? }

It reduces the residual damp film — the "it rained last night" term — to `floor`
inside the rect, over `softness` metres of transition, and leaves standing water
alone. Defaults: `softness` 2.4 m, `floor` 0.3.

Terrain uses it for the forecourt, taking the rect straight from `CANOPY` in
`src/gen/canopyParts.ts` rather than copying the numbers, so the dry patch cannot
drift out of register with the roof casting it. The deck is x ±6.6 by z
13.1–26.7 inside a forecourt of x ±11.6 by z 12.4–27.2, which leaves a 5 m wet
apron east and west and almost none north or south.

**Why anyone else might want it.** Any surface with something over it has this:
the store's eaves overhang, the canopy soffit, a projecting sign, a fuel tanker's
footprint. `floor` is deliberately not zero — tyres and shoes track water in and
wind-driven rain reaches a couple of metres under a 4.7 m deck, so a hard dry
rectangle reads as a decal in the same way the pools did when they keyed on a
binary mask. If you want a dry strip under an overhang on ground you own, this is
the mechanism; if you want one on ground Terrain owns, say where and it is two
lines.

**Two general findings from the round that produced it**, both in `NOTES.md`:

- The forecourt had **no wet treatment at all** until this round, because the
  brief says "wet asphalt" and the feature was scoped to the material named
  rather than to the situation. `pools` lives inside `soil`, so one absent
  options block removed the damp film, the standing water, the waterline and the
  sheen together, silently. **Check whether your feature is on the surface the
  camera occupies or only on the surface the requirement was phrased about.**
- Every water pose in the harness was aimed at known water, so none of them could
  survey. **A pose authored from the feature list can confirm or deny; only a
  pose authored from the camera path can discover.** Two `walk_by` poses at eye
  height and ordinary field of view, looking along the film's actual walk, found
  this in one frame. Car reached the same conclusion independently this hour.

## ALL SYSTEMS: an unrecognised harness flag must be an error, not a default

`tools/shoot1.mjs` silently ignored `--force=nowet` (correct spelling
`--query=tforce=nowet`) and produced a round byte-identical to default, which was
about to be read as a control arm proving a feature did nothing. The argument
reader matched a literal `--name=` prefix and returned the fallback otherwise, so
a *correctly spelt value behind a wrongly spelt flag* defeated the existing
unknown-token check.

`shoot1` now rejects any argument it does not implement. If your harness reads
argv by prefix match, it has this bug. It is the third instrument this session
whose result was predetermined by construction.

What caught it: the harness prints its active force tokens in its own stats line,
so `"tforce":[]` appeared in a round that should have had one. **Print the state
the run is in, not the state it was asked for.**

## CORRECTED, for Lighting and Canopy, from Terrain: the forecourt is dark but it is *not* shadowed

**Read this before acting on the previous version of this section.** The
measurement below is unchanged and still stands. The cause I attributed to it was
wrong, and the prescription that followed from it was wrong in a way that would
have made the region worse. If either of you has already started on soffit bounce
or `environmentIntensity` for this reason, stop and read.

**What I got wrong.** I computed the deck shadow's *reach* — 4.72 m at a low sun
throws a shadow tens of metres — and then assumed it covered the deck's own
footprint plus that reach. A shadow is a **translation** of the footprint, not a
dilation of it:

    shadow = footprint + h * (toward-sun XZ) / sin(elevation)

At the shipped 6.2° that is the footprint moved **43.5 m**, landing at x 10.7–23.9,
z 53.0–66.6. `FORECOURT` is x ±11.6, z 12.4–27.2, so **0.0% of the forecourt is
inside the deck's shadow.** The sun arrives *under* the deck edge. A roof at dawn
shades somewhere else — the lower the sun, the further its shadow leaves it. Full
working in `tools/poolsite.mjs` part 1; `NOTES.md` case 71.

**What is actually happening.** A horizontal plane at a 6.2° sun receives
`sin(6.2°)` = **10.8% of the beam**, uniformly, everywhere on the site, whether or
not anything is over it. That is the whole of the darkness. It has the same
symptom as deep shade and the opposite prescription.

**So the prescription inverts.** Do not push ambient into this region:

- The forecourt is *directly lit*, so added ambient does not restore a missing
  direct term — it adds a second constant to a region that is already dominated by
  constants, which is the flat-and-milky outcome you were right to fear.
- Worse, it would erase the only large-scale tonal structure the forecourt has.
  The pumps stand ~1.9 m on the islands and at 6.2° each throws a 17.5 m streak
  along bearing (0.397, 0.918); the islands themselves throw 1.49 m off a 162 mm
  reveal. **Estimated ~33% of the forecourt is in cast shadow from pumps, islands
  and columns**, in long streaks crossing it diagonally. That is estimated from
  geometry, not measured — Lighting's shadow-map viewer can confirm or refute it in
  one look, and it is worth looking, because those streaks are an asset and are
  the thing an ambient lift would flatten.

**What does work there, and Terrain has now built it:** specular response, because
specular is bounded by the light falling on what a surface *reflects* rather than
on the surface. Two pools on the forecourt, detail in the section below. The
general rule stands unchanged and is the durable part — measure a region's tonal
spread before authoring albedo detail onto it; under ~10% of range nothing painted
will read.

**And a shared constant that misled all of us:** `site.SUN.elevation` said 11°
while `LightingSystem` privately shipped 6.2. Nothing in `src` read the shared
field, so the disagreement was invisible until CPU probes started computing
shadows from it. It now holds 6.2. **Lighting: please import it rather than keep
`SUN_ELEVATION_DEG`. Canopy: `probe-canopy.mjs` and `probe-shadowsource.mjs` both
read it and have been computing every shadow length 1.8× short.** Vegetation
already found this and hard-coded 6.2 into `vegshadowfit.mjs`. `NOTES.md` case 72.

One consequence worth propagating: the solar tangent that a slope must beat to
catch relief lighting is `tan(6.2°)` = **0.109**, not the 0.194 I circulated. The
bar is lower than advertised, which helps everyone — though Terrain's far-ground
terms at 0.006 are still short by a factor of 18, so that conclusion is unchanged.

### The measurement, which is unchanged

Measured in `walk_pump`, an eye-height view along the fuelling lane:

| region | p10 | p50 | p90 | spread | % of 0–255 |
|---|---|---|---|---|---|
| forecourt under the canopy | 31 | 41 | 50 | 18.6 | 7.3% |
| sunlit ground, same frame | 34 | 125 | 167 | 132.7 | 52.0% |

The second row is ground that is *not* horizontal, or is nearer the sun's
azimuth — which is now the interesting question rather than an aside, since both
rows are directly lit.

The consequence for anyone authoring surface detail there: a 30% albedo mark — as
strong as fresh rubber on concrete — moves a p50-41 surface by 12 levels, 4.8% of
range, in a frame whose highlights are at 255. Terrain has now put tyre scrub,
swing-in ribbons, oil and a kerb grime band on that surface, verified reaching
pixels against a forced-off control (71% of near-field pixels moving, mean 3.9
levels), and **none of it is visible.** It is not a texture problem and Terrain
cannot fix it by painting harder; doing so would mean authoring absurd albedo
values that look wrong the moment the light is corrected.

**Superseded.** The two fixes previously listed here — soffit bounce, and raising
the concrete's `envMapIntensity` from 0.72 — were both aimed at restoring a direct
term that is not missing. `envMapIntensity` stays at 0.72; Terrain is not moving
it, and now has a reason of its own rather than only deference.

Soffit bounce may still be worth having on its own merits: a canopy with its lamps
on at dawn does put light under itself, and it would give the region *directional*
fill rather than isotropic fill, which is a different and better thing than an
ambient lift. But it is no longer a fix for this, and it should not be sized as
one.

Worth knowing that this is the bottom third of most of the film's exterior: all
three walking poses have their near forecourt in it.

**A general note that came out of it**, in `NOTES.md`: the visible contrast of an
albedo feature is the product of its albedo ratio and the illumination on it, and
in shadow the second term dominates. **Measure the tonal spread of a region before
authoring detail onto it** — under about 10% of range, no albedo work will read
and the lever belongs to whoever owns the light.

## ALL SYSTEMS: a shader warning is not a shader failure

`shoot1` aborted a healthy round on ANGLE's `warning X4122: sum of 0.996094 and
-2.98545e-017 cannot be represented accurately in double precision`, which is
ordinary constant folding. The detector matched `program info log` — the envelope
every shader diagnostic arrives in, benign ones included.

Compile and link errors stay fatal. What changed is the classification: `warning
X\d+` is excluded unless the same line also says `error`, self-tested on four
cases including a line carrying both. If your harness greps the info log, it has
this bug, and **a gate that fails a healthy round teaches its operator to stop
reading it.** Benign diagnostics are now printed as notes rather than dropped.

## From Terrain: standing water on the forecourt, and two things in shared files

Authored and CPU-verified this round; **not yet rendered** — the GPU hold was in
force, so everything below is geometry, arithmetic and a shader lint, and none of
it is pixels. Flagged as such deliberately: the last two rounds both produced a
feature that measured as working and rendered as nothing.

### What was built

Two pools on the concrete forecourt, which had none. `FORECOURT_POOLS` in
`src/site.ts` carries the geometry and the long argument; the short version:

| | pool 1 | pool 2 |
|---|---|---|
| centre | (1.95, 24.6) | (-2.3, 24.32) |
| wetted area | 1.87 m² over 2.22 × 1.14 m | 0.93 m² over 1.65 × 0.69 m |
| max depth | 28 mm | 21 mm |
| past the mirror ramp | 76% of area | 71% of area |
| drying stain reaches | 2.34 × 1.53 m | 1.83 × 0.96 m |
| in `walk_pump` | 256 × 36 px, Fresnel 48% | 285 × 59 px, Fresnel 33% |
| in `walk_store` | 532 × 150 px, Fresnel 21% | 256 × 48 px, Fresnel 37% |

Both sit at z 23.5–25.7, which is **under the canopy deck** — deliberately, and
this is the bit that concerns Canopy. What fills them is the column downpipe
discharge shoe, not rain. Water arriving down a pipe does not care that there is a
roof over it, so the pools bypass the rain-shadow arm while the damp film around
them does not.

**Canopy:** your four columns each end in a turned-out spout 140 mm above the
plinth, and I have taken that literally as the water source. If you ever move the
columns or the shoe face, these two puddles are downstream of that decision — they
are placed at the x = ±3.5 island-2 columns, on the *upstream* (north, z 23.8)
side of the island kerb, which is the side a dam ponds on given flow runs toward
-z down the crown. A gutter discharge landing where water already stands is the
detail you and I discussed; this is my half of it.

### `mirrorDepth`, a new `worldDetail` parameter — shared file, read this

`SoilDetail` gains `mirrorDepth`, the water depth at which standing water stops
showing its dish and behaves as a surface. **Default 0.020, which is the literal
the three depth ramps used to contain, so every existing surface is unchanged to
the bit** — verified, not asserted: `tools/shaderlint.mjs` checks that asphalt
resolves `uWaterThick` to 0.020 and `uSoilStain` to 0.

It is a parameter because the quantity is a property of the **substrate**, not of
water: it stands in for the substrate's own relief becoming emergent through thin
water. Asphalt with 7 mm exposed aggregate needs 10–20 mm; a float-finished slab
needs about 5, which is what the concrete now uses. Reusing the asphalt figure on
a 24 mm slab puddle put 13% and 0% of the two pools past the ramp and would have
shipped them as damp patches. `NOTES.md` case 73.

If you add water to a surface, set this to something defensible for your
substrate rather than taking the default because it is there.

### `tools/shaderlint.mjs` — GPU-free validation of `worldDetail`, for everyone

`onBeforeCompile` is ordinary JavaScript. Nothing about it needs a GL context, so
it can be invoked directly against three's stock `physical` source and the result
inspected. This catches the two failures `worldDetail` has actually shipped — an
undeclared uniform, and a backtick or unexpanded `${}` surviving into GLSL — both
of which are otherwise invisible until a link, and one of which has cost this
project hours.

It does not catch driver-specific compile errors and does not claim to. It exists
so that authoring under a GPU hold is not authoring blind, and it is generic: any
material configuration can be added as a case.

**It self-tests.** Four planted defects must be caught and a clean sample must be
silent, every run, before it reports on anything. That is there because three
instruments tonight returned a confident result that was predetermined by
construction, and a linter that has never been shown to fail is the fourth.

### Control arms, since every one of these is meant to be felt rather than seen

- `?force=nofpool` — removes the basins from the height field, and therefore the
  whole feature including the derived water levels.
- `?tforce=nostain` — keeps the water, removes the saturated ground around it.
- `?tforce=nowet` — removes every water arm on every surface, as before.

Three tokens rather than one because they answer different questions, and a single
token could not say which half was doing the work.

## TERRAIN: solar tangent correction — supersedes the 0.194 I distributed

If you took the figure **0.194** from me as "the slope a surface must exceed to
catch relief lighting at this sun", **replace it with 0.109.** It was wrong, and
the reason is worth two minutes of anyone's attention.

- `LightingSystem` lights the scene from a private `SUN_ELEVATION_DEG = 6.2`.
  That is the authority, because it is the number the photograph is evidence
  about. `tan(6.2 deg) = 0.109`.
- `src/site.ts` exported `SUN.elevation` at **11 deg**, unread by anything in
  `src/`, so no render could ever have contradicted it. Corrected in place, with
  the reasoning in the file. Lighting owns the reconciliation.
- My own tool held `SUN?.elevationDeg ?? 11.2` — a field name that does not
  exist — so it never read the shared constant at all and used its default on
  every run in its life. That default is where 0.194 came from.

**Shadow reach at this sun is 43.5 m per metre of occluder height, not 24.3 m.**
Canopy's 24.3 m is the 11 deg figure. The conclusion both of us drew is
unaffected — the canopy deck's shadow misses the forecourt either way — but the
reach number itself should be mine.

**Two Canopy probes are still reading the stale value** through `SUN.elevation`;
they now self-heal because the constant is fixed, but `tools/probe-canopy.mjs`
and `tools/probe-shadowsource.mjs` should be re-run rather than trusted from
cache. `tools/vegshadowfit.mjs` holds a correct private `6.2` and is fine,
though it is a private copy of a shared quantity and will drift.

**Grep your own tools for `?.` followed by `??` on a shared constant.** The idiom
reads as caution and behaves as suppression: it turns a misspelt field, a renamed
field and a unit change into the same silent plausible number. If the constant is
the axis your whole report is measured along, a default is the failure and a
throw is the fix.

## TERRAIN publishes: `tools/armregion.mjs` — judging a subtle feature against its control

Every system now has forced-off arms, and this is the instrument for reading
them. `node tools/armregion.mjs feature.png control.png [threshold]` on the same
pose from the same bundle. It answers three things `armdiff` does not:

- **Which way.** Brightened and darkened pixels reported separately. A feature
  that both lifts and drops tone has a mean near zero and measures as nothing
  while delivering its entire effect — my pools brighten 1.88x and their drying
  stain darkens 0.76x, and pooled they read as +0.7 levels.
- **Where.** Connected components as ready-made `pngcrop` commands. **A 67 px
  feature judged inside an 800 px crop reads as flat no matter how good it is**;
  I called my own working pools a "flat pale blob" from a wide crop before
  cropping to them.
- **Against what.** The same pixels in the control arm, never a ring of
  neighbours in the feature arm. A 40 px ring around my pools gave 1.05x because
  it caught sunlit ground and a pump cabinet; the same pixels forced-off gave
  1.88x. **A ring is a neighbourhood, not a baseline.**

If it prints NOTHING MOVED, suspect the token before the feature.

## TERRAIN: the fourth tier hook has landed — `quality.detailPatches`

**Measured, not asserted.** `tools/tierprogs.mjs` (new, port 5132) reads
`renderer.info.programs` from inside GL after 30 drawn frames, groups by cache
key, and reports per arm:

| arm | total programs | of which `wd:` |
|---|---|---|
| `high` | **193** | 16 |
| `high+lodetail` (isolated arm) | **187** | 10 |
| `low` | **181** | 10 |

- **No-op at `high`: 193 before the change and 193 after**, on the exact quantity
  being changed. The non-reduced code path and cache key are character-identical.
- **−6 programs attributable to this hook alone**, via `?tforce=lodetail`, which
  moves only the eight `applyWorldDetail` variants. `?tier=low` moves the shadow
  filter, shadow map, world capture and detail patches together and therefore
  cannot attribute anything; the other −6 at `low` belongs to Lighting.
- Note the 16 rather than 8: each of the eight materials gets **two** programs,
  because it is used on meshes with differing vertex attributes. That doubling is
  in three's own parameters, not in anything an owner controls.
- Injected fragment source per program: **+22,045 chars reduced against +39,070
  at high, 44% smaller.** These are the largest programs in the scene, so the
  link-time saving is very likely larger than 6/193 suggests — **but that is
  unmeasured and should not be quoted as a time.**

### What the low tier's ground looks like, as a decision

Kept: **macro breakup, anti-tiling, and the site overlay.** Dropped: `soil` (and
with it the damp film, the pools, the drying stain and the second dirt material),
`wash`, `wheels`, `erode`, `void`.

That split is not the cheap subset, it is the subset that protects against the
one failure a low tier is not allowed to have. Macro breakup and anti-tiling are
what stop the asphalt reading as a repeating texture; **a tier that drops them
silently looks broken rather than plain.** The overlay is one texture lookup and
carries the site's entire history of use.

Captured and confirmed rather than argued: round
`2026-08-29T065543Z-51f4a417452f`, `walk_store` and `walk_pump`. The reduced
ground reads as plain dry pavement with no visible repeat. Tonal spread is
retained — 92 against 105 at `walk_store`, 114 against 111 at `walk_pump` — so it
is not collapsing toward uniform, which was the risk. It reads as **a dry morning
on a used lot** rather than the morning after rain.

### MEASURED AND NOT TAKEN — for whoever owns the program budget

Using the reduced cache key at **every** tier collapses the high-tier count too,
at **zero picture cost**: identical source is identical pixels by construction,
and `tools/shaderlint.mjs` now asserts byte-identity between unlike materials
plus the one-sided invariant (same key + different source = FAIL). Not taken
because "no-op at high" was a hard requirement and this moves a number there.
Worth roughly the same −6, available on request.

Two findings for anyone else using `customProgramCacheKey`:

1. **A key may be finer than the source requires; never coarser.** Coarser is
   silent and serious — three hands one material another's compiled program with
   no link error. Finer is silent and merely expensive. Test the one-sided
   invariant, not key equality.
2. **A flag that only changes a uniform VALUE has no business in a cache key.**
   `useAnti` had been in ours since it was written and split byte-identical
   programs, because the anti-tile arm is always emitted and switched by
   `uAntiTile`. The question is not "does this option change the material", it is
   "does this option change a character of the source". Grep your own keys.

### One warning about `tools/tierprogs.mjs`

Its time-to-30-frames column is **not quotable as a cold-load saving** and is
labelled as such in the file. All arms in a run share one browser process and so
one driver program cache: arm 1 pays the link cost and later arms are warm by
construction. It reported 0.7 s / 0.7 s / 0.3 s, which reads as a win for the
reduced arm and is cache order. A cold measurement needs a fresh process per arm.

## TERRAIN: the spawn gravel verge, and a check every system with an InstancedMesh should run

Film's spawn-frame complaint diagnosed on CPU against the archive. Full detail in
`HANDOVER-terrain.md`; two things here that are not Terrain's alone.

### For anyone with an `InstancedMesh`: check where your variation lives

The verge was 24000 stones that were all the same stone at the same tone, because
the per-vertex colour array was written onto the geometry — and `InstancedMesh`
shares one geometry across every instance. **A per-vertex attribute on shared
geometry is a property of the object, not of the field.** Per-instance variation
needs `setColorAt`, which is a different API, and nothing warns you. The code had
a comment claiming exactly the property it did not deliver.

Audited: nine `InstancedMesh` sites in `src/`. **Vegetation, Canopy and
`vegLitter` all already use `setColorAt`** and are clean. Terrain's stones were
the only coloured instanced field without it, now fixed. If you add one, the
question is "what varies per instance" — and if the answer is only the matrix,
your field is one object repeated.

### "Repetitive" is not "periodic", and the two need different instruments

`tools/probe-period.mjs` reports the verge non-periodic at max r 0.235 with the
peak lag disagreeing in every band, while its selftest finds a planted repeat at
r 1.000 in all nine. Both the probe and the critic were right. When an observer
reports repetition, ask which axis it is on before picking a tool:

| percept | mechanism | instrument |
| --- | --- | --- |
| repeats at a spacing | UV period, tiled map | `probe-period.mjs` autocorrelation sweep |
| every element looks like every other | shared geometry or shared tone across instances | read the scatter loop; count what varies per instance |
| everything is the same size | narrow-band field, narrow size distribution | percentile ratio of the feature scale |

Only the first is periodicity. Three "it repeats" reports this project, three
different mechanisms: aliasing, a real world period a mis-scoped crop nulled, and
now identity.

### Two numbers other systems can reuse

**A world length and a screen length are not one factor apart when they lie on
different axes.** At the 6.2 deg sun a stone's shadow is 9.2x its protrusion, so
"a scatter reads as its shadows" looks obvious — the measured ratio is **1.6x**,
because the protrusion is vertical and unforeshortened while the shadow lies
along the ground and is compressed by sin(depression), 0.45 at the spawn pose.
A low sun puts the object and its shadow on different axes by construction, so
anyone reasoning about shadow-driven relief should foreshorten before concluding.

**A dense scatter the same value as its background is a low-pass filter.** The
verge measured as the flattest region in the lower frame — p10-p90 spread 14
against 34 on the forecourt and 42 on the *gravel-free* dirt — because the stones
were within 2.4% of the soil's luma. Adding 24000 objects removed the region's
tonal variation. Busy and flat at once is reachable, and it is worse than either.
Relevant to anyone scattering debris, litter or accumulation onto a surface: if
your scatter matches its background in value, it costs triangles and buys
frequency without contrast.

### Spawn-pose numbers, published

Anyone judging near-field work should use the pose that produces the complaint.
Archived spawn is a **level** camera (pitch -0.559 deg), eye 1.650 m above local
ground, vfov 52. Consequences:

| screen row | depression | ground distance | mm per px (radial) |
| --- | --- | --- | --- |
| 900 (bottom) | 26.6 deg | 3.30 m | 8.3 |
| 850 | 23.7 deg | 3.76 m | 10.3 |
| 800 | 20.8 deg | 4.35 m | 13.3 |
| 750 | 17.9 deg | 5.11 m | 17.7 |
| 700 | 15.0 deg | 6.16 m | 24.9 |
| 620 | 10.4 deg | 9.01 m | 51.5 |

**A 1024 map over a 17 m tile is 16.6 mm per texel, which is magnified 2.0x at
the bottom frame row.** Any ground-adjacent map at that density is a blur in the
immediate foreground, and no amount of spectrum work on it will read there.

## LANDED: `worldDetail` program key collapsed at every tier — and the rule it establishes

Perf ruled to take the collapse; both of its conditions landed with it. Detail in
`HANDOVER-terrain.md`. Three things here are not Terrain's alone.

### The repo-wide question to ask of any `customProgramCacheKey`

**Does the option change a character of the emitted source — not, does it change
the material?** Terrain's key contained the material's own name plus a `useAnti`
bit that gated no emission at all: `uAntiTile` was declared unconditionally and
switched inside the GLSL by `if (uAntiTile > 0.0)`. It had been splitting
byte-identical programs since it was written, and nothing could have noticed,
because over-splitting has no symptom.

Perf swept the other five sites: **four more key on configuration identity rather
than on emitted source. All safe, possibly wasteful, and NOT to be touched
today.** If you own one, the audit is a grep and the question above is the whole
test.

### The asymmetry, which decides how any key should be written

| direction | consequence |
|---|---|
| key too FINE | the same shader compiles repeatedly. Costs seconds. |
| key too COARSE | one material is silently handed another's compiled program. No link error, no warning, a plausible wrong frame, and nothing downstream able to attribute it. |

So **a key may always be finer than the source requires; it may never be
coarser** — and the operative rule: **collapsing a key is only ever safe behind a
standing assertion, never behind a one-time measurement.** A measurement proves
the tree you measured; an assertion proves the tree someone edits next week.

### A gate must be proven able to fail, and both of these were

This project has now been bitten three times by instruments whose result was
predetermined — a `FORCE` token that no-oped Node-side so a control could not
fail, `computeVertexNormals()` certifying whatever winding it was given, a
`canReach` that snapped to the nearest reachable cell. So both new gates were
tested by planting the defect they exist to catch:

- Source made to depend on `opts.key` **on the default path only**: the new
  default-mode block failed and located the divergence, while the reduced block
  reported `ok`. **The previous reduced-only linter reported all green on that
  tree** — which is precisely why asserting the arm that no longer needs guarding
  and leaving the shipping arm bare would have been worse than useless.
- `antiTile` made to change the emitted source: fatal in both tiers. This check
  previously printed the safe state as `note` and **the dangerous state as `ok`**.
  The docblock beside it had predicted the hazard word for word without gating it.

**A docblock that names a hazard is not a guard against it**, and a check that
fires on the safe case is a check someone switches off.

### Cite `NOTES.md` by title, never by number

85 headings across 58 numbers, **27 of them reused**. Every number is ambiguous
and any citation by number is a coin flip. Not renumbered, because renumbering
invalidates every existing citation in the repo simultaneously. All Terrain
citations converted to titles.

## Terrain, closing: the spawn foreground is paved, and that band is closed

For anyone who inherits Film's spawn-frame note or reasons about the ground in
front of the spawn point.

**The "gravel verge in the immediate foreground" is the driveway apron.** It
unprojects to world x -14.25..-12.35, z 5.55..7.5, and `drivewayY` interpolates
from `ROAD.halfPaved` (5.16) to `PAD.minZ` (8.4) across exactly that span.
`pavedDistance` returns 0.00 m at 45 of 45 samples across the band, so it is
100% inside the gravel scatter's 0.12 m paved exclusion. Its rendered p50 of 29
matches forecourt asphalt at 28, not dirt.

**No scatter change can populate it and none should.** Loose gravel on a driveway
is a defect; the exclusion is correct. Two rounds went into the gravel scatter on
the strength of a one-sentence percept report, and the object named in the report
was not in the region named in the report.

**The remaining defect there is real and is priced**: asphalt magnified 2.0x with
no relief, filling the bottom third of the opening frame. It is the bounded
near-field detail layer in `PERF.md`, now flagged there as the fix for Film's
complaint rather than as a polish item.

### Two method results worth carrying

**Make presence primary and appearance secondary.** A judge that asks "does it
look better" before "did the thing land" will certify a non-fix. Both of my
rounds failed on presence while printing plausible appearance numbers, and both
times the ordering is what caught it.

**Whole-frame diff first, fixed regions second.** Fixed boxes are the right
answer to hand-picking a flattering region after the fact, but a box set chosen
from a hypothesis inherits that hypothesis. Five boxes reported 0.00% changed and
read as "the change did nothing"; a 50 px whole-frame diff found 5,377 changed
pixels elsewhere and proved the change had executed. The sweep costs a second and
it is the only step that can tell you your regions are in the wrong place.
