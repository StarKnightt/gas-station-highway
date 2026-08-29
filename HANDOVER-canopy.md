# Canopy — handover

> **SESSION OF 2026-08-29. Read this block first.**
>
> Latest round: **`2026-08-29T023036Z-99ec863748f4`**, ten poses, RTX 4060
> confirmed from the live context at sample time. `npx tsc --noEmit` clean for
> canopy-owned files. Port 5153 released.
>
> **The system is complete.** Deck, fascia with signage, soffit with a split
> two-term bake, eight fixtures publishing their positions with zero lights
> added, four instanced columns with contact occlusion at the feet, drainage as
> a route rather than a decoration. Nothing is half-built and nothing is
> waiting on another system.
>
> **The honest closing statement is that nothing remaining is worth the pixels.**
> That is a measured claim, not a shrug — see *Closing ranked state* below.
> Every element delivers, every surface sits in the correct place in the frame's
> tonal order, and the lowest `p10` anywhere is 25. Further work here would move
> numbers that are already in the right relationship to each other.

---

## Files this system owns

| File | What it is |
|---|---|
| `src/systems/CanopySystem.ts` | The system. Materials, meshes, services, self-report. |
| `src/gen/canopyParts.ts` | All geometry and the two soffit bakes. `CANOPY` is the dimension table. |
| `src/gen/canopySignage.ts` | Sign atlas and the `TYPE` table of absolute millimetre sizes. |
| `tools/probe-canopy.mjs` | CPU assertions. Runs in ~2 s, no browser. Run this first, always. |
| `tools/shoot5.mjs` | Capture harness, port 5153, archives through `tools/archive.mjs`. |
| `tools/probe-rank.mjs` | **Shared tooling**, not canopy-specific. See `NOTES.md`. |

One registration line in `src/main.ts`. `src/gen/contactShadow.ts` is Car's and
is consumed, not owned.

```
node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-canopy.mjs
node tools/shoot5.mjs
node tools/probe-rank.mjs --port=5153 --pose=approach
```

---

## The five things a fresh agent cannot re-derive

### 1. The contact decal's `res` is an alignment condition, and raising it looks like a fix while being the opposite

`CanopySystem.ts` derives the grid resolution for Car's contact-shadow builder
as an expression. **Do not replace it with a literal and do not raise it because
the decal looks soft.** Measured alpha delivered at the contact line, as a
fraction of the peak:

```
res    8     12     16     20     24     32
frac   0.48  0.72   0.96   0.73   0.70   0.95
```

Non-monotone. `res` 16 beats 20 and 24 at a quarter of their triangle cost, and
going 16 → 20 makes the decal *visibly worse*, which reads as the tool being
broken.

The governing variable is not cell size. The occluder's edge has to land just
**inside** a grid line, because that puts a near-peak sample where the quad
straddling the edge can interpolate it onto the visible side. Cells that leave
the edge mid-quad deliver a mid-quad value however fine they are. So the
condition is `cell = reach / k` for integer `k`, and it is written as
`Math.round(span / (reach / 2))` rather than as `32` because the alignment is a
*relationship* between `CANOPY.colBaseW` and the module's falloff floor, either
of which can move.

`k` is 2 and not 1 deliberately: `k = 1` leaves a single cell across the whole
falloff and flattens it to the linear ramp `contactShadow.ts` explicitly warns
produces an airbrushed oval. `k = 2` holds the squared shape — the midpoint
measures 0.198 against 0.195 for a true t².

`probe-canopy.mjs` gates the delivered value, so a `res` that stops being
aligned **fails** rather than quietly softening. If that gate fires, the answer
is almost never a bigger number.

The general rule, which is in `NOTES.md` and applies well beyond this decal:
**when a quality metric depends on alignment rather than on magnitude, sweep the
parameter instead of arguing about it.** Every "finer is better" intuition is
silently an assumption of monotonicity.

### 2. The soffit has two terms, they scale differently, and the lens emissive is the control that keeps the rule honest

This is the most load-bearing structure in the system and the easiest to break
by tidying.

| term | stands in for | scales with | where it lives |
|---|---|---|---|
| `lightMap` + `lightMapIntensity` | sky and sunlit-slab bounce entering under the fascia | **`scene.environmentIntensity`** | `makeSoffitLightmap` |
| `emissiveMap` + `emissiveIntensity` | the lamps' own spill onto the panel they are bolted to | **nothing** | `makeSoffitLampMap` |

They were one map. Both rode `lightMapIntensity`, and when that scalar was
correctly made proportional to the environment, **the lamps started brightening
when the sky did**, and `setFixtures(false)` left eight baked collars glowing
with the lenses at zero — the switch was wired to the object you look at and not
to the light it makes.

> One texture multiplied by one scalar expresses exactly one quantity. If two
> physical quantities live in that texture, every control you attach reaches
> both, and every control that should reach one of them is wrong.

**Refuse the tempting fix.** Baking the lamp term pre-divided by the environment
makes the multiply cancel and the numbers come out right today. It is a
compensation, and it divides by a value another system owns.

**The control that makes the rule usable rather than a slogan.** A rule that
fires on every constant would be useless. The lens emissive is *also* constant
and *correctly* so, because **a lamp does not dim when the sky brightens.** What
distinguishes them is what the term stands in for: a bake standing in for sky
bounce must track the sky; an emitter standing in for a lamp must not. Ask that
question, not "is this a constant".

**The dividend, and why the split is not just hygiene.** It *is* the
night-to-dawn transition, and nothing animates. As the sky comes up the bake
rises and the lamp term does not, so the lamps' relative contribution falls on
its own — measured, monotone, driving the two published controls:

```
envIntensity   lightmapIntensity   soffit lamps-off   lamps-on   lamp share
       0.15               0.091               57.3        68.7      16.6%
       0.60               0.362               83.4        93.0      10.3%
       1.20               0.725              110.4       118.3       6.7%
       2.40               1.450              147.3       153.1       3.8%
```

**Two traps inside the fix, both live.**

- `emissiveMap` defaults to `uv`, and on the soffit `uv` is a *per-metre tiling*
  set. The default repeats eight lamp collars inside every square metre of a
  13 m deck: a channel error that presents as a texture error. It is bound to
  `CANOPY.lampMapChannel` **inside the factory**, so the texture arrives
  correctly bound and there is no line a caller can forget.
- The two maps sit on the same UVs on the same material with **opposite correct
  colour spaces**: the lightMap is `NoColorSpace` because irradiance has no
  perceptual encoding, the lamp map is `SRGBColorSpace` because an emissive map
  is a colour three converts to linear before adding. This is exactly why the
  convention is to write `colorSpace` explicitly on every generated texture
  rather than rely on a default that is right for one of them.

The published controls are `setLightmapIntensity(v)` and `setLampBounce(v)`, and
they are **two setters on purpose**. Lighting hanging real luminaires here wants
to zero the lamp term and keep the bake, which one combined control could not
express. `setLightmapIntensity(0)` swaps the whole bake out with no geometry
change.

**Before increasing either level, re-read `NOTES.md` on the collar.** The lamps'
contribution was once authored with a 196 mm half-value radius under a housing
whose edge is at 310 mm, so **its entire bright core sat behind the object
casting it** and it measured +3.4 luma over 23 000 pixels. Widening it to 559 mm
was the fix; raising the level would not have been.

### 3. Signage is sized in absolute millimetres, the panel is measured from its content, and viewing distance is per element

`canopySignage.ts` holds a `TYPE` table in millimetres — wordmark cap 380,
sub-line 130, price numerals 300, column plate cap 58. **Nothing here is a
fraction of its parent.** A detail sized as a fraction of its parent is wrong
wherever the parent varies, because real detail has an absolute size set by
physics and by what a sign shop can print. The logo panel's *width* is derived
from `measureText` on the content, which is the clean inverse: the content
measures the panel, not the reverse.

`probe-canopy.mjs` converts each element to **delivered screen pixels** at four
poses and gates the ones that matter. The companion finding is the one that will
bite a fresh agent:

> **The viewing distance is per element too.** A single pose list applied to
> every element imports the fascia's viewing distance to a hand-height plate.

A gate written that way failed the column plate at **3.8 px** from a
fascia-oriented pose 15 m away — a true number from a check nobody should have
run. The plate is read at the pump, where it delivers **19.4 px**. Hence the
`at_pump` pose exists purely so hand-height elements are measured from
hand-height distance.

Current delivered pixels, for drift detection:

| element | at_pump (1 m) | sign (11 m) | approach (15 m) | road (34 m) |
|---|---|---|---|---|
| wordmark | 79.5 | 31.8 | 22.0 | 9.8 |
| sub-line | 27.2 | 10.9 | 7.5 | 3.4 |
| price numerals | 34.5 | 23.5 | 13.4 | 7.7 |
| column plate | **19.4** | 3.8 | 3.3 | 1.4 |

And Car's companion result, which decides what kind of fix to reach for:
**anything above roughly 50 px that does not read is a contrast fault, not a
size one.**

### 4. Closing ranked state, so the next agent can tell drift from noise

`node tools/probe-rank.mjs --port=5153 --pose=approach`, gate live, no
`--tolerate`:

```
surface                        px  % frame    luma    p10    p90
canopy-fixture-lenses        1356     0.09   206.8    144    235
canopy-fascia               31112     2.16   175.6     93    222
canopy-soffit               65343     4.54   154.2    138    176
canopy-signs                 8477     0.59   150.3     63    223
canopy-columns              23330     1.62   128.1     72    174
canopy-overflow-stains        565     0.04   116.6     53    182
canopy-fascia-stripe         5365     0.37    98.9     64    130
canopy-fixture-housings      3957     0.27    88.0     47    144
canopy-column-bases          748     0.05    57.1     25     90
forecourt-slabs             86522     6.01    54.9     39     71
curbs                        9642     0.67    49.6     20     74
```

`--pose=soffit`, from underneath: lenses 221.7, fascia 185.6, soffit 153.2,
housings 39.9 / p10 5.

**How to read this table.** The ranking is the measurement, not the absolute
values — it needs no exposure reference and survives any later change to tone
mapping. The order is physically possible: bright band above lit soffit above
signage above columns above the ground they stand on, and the fittings darkest
because a dark housing silhouetted against a lit panel *should* be last.

Two numbers to watch, because they were defects and could regress:

- **`canopy-fixture-housings` p10.** It was **1** — crushed to pure black —
  because `metalness` was 0.35. If it returns to single digits from `approach`,
  something has re-darkened the housing.
- **`canopy-soffit` responding to the environment.** The soffit's whole history
  is a term that did not scale with a global change. If Lighting moves
  `scene.environmentIntensity` and the soffit does not move with it in roughly
  the same ratio as the ground, that is the finding, not a null result.

**And the trap in reading it.** `canopy-fascia-stripe` measures **5365 px from
`approach` and 22 px from `column_full`**; the stains are 565 and 2. Both low
figures are correct for their frames and mean nothing about the elements —
`column_full` stands *under* the deck, where the fascia pixels are the drip
return's underside and the outer face is edge-on. A low count is a question, and
it closes only with a second pose chosen from where the element is meant to be
read. **Two poses agreeing on a low count is the finding.**

### 5. What is published, and the shapes of the contracts

```
canopy            deck rect, soffitY, copingY, dripY, clearHeight, columns[],
                  fixtures[], fixturesOn(), setFixtures(on, level),
                  lensMaterial, soffitColour,
                  setLightmapIntensity(v) / lightmapIntensity(),
                  setLampBounce(v) / lampBounce()
canopy.fixtures   8 handles: name, position, normal, width, depth, colour
canopy.blockers   4 XZ rects. Columns solid, deck does not block. The player
                  picks these up with no consumer edit — `src/core/collision.ts`.
canopy.drainage   scuppers[] with position and outward normal, discharges[] with
                  peak flow and the ground condition at each outlet
```

**Zero lights created.** `lightsCreated: 0` is in the self-report and should stay
there. The fixture geometry and lenses exist and their positions are published;
whether real lamps hang there is Lighting's decision, and the scene already
carries 21 lights including 10 `RectAreaLight`.

`__CANOPY` in the console carries the whole state. **Borrowed values are printed
there next to what was derived from them**, including `contactShadow.borrowed`,
which is the module's own account of what it took from Lighting. A borrowing must
be visible in the report of the system that borrowed it — including when shared
code does the borrowing on your behalf.

---

## Three traps from the last round, in the narrow reusable form

**A grid's rendered value is a property of the interpolant, not of the nearest
sample.** My contact-shadow gate failed at 0.200 against a peak of 0.780 and
looked exactly like the buried lamp collar. True number, false conclusion: with
a 22.8 mm cell the vertex nearest the contact line lands 0.6 mm *inside* the
pad, but the quad between them straddles the edge and the renderer interpolates,
so the ground 1 mm outside receives 0.739. Acting on the vertex reading meant
32 000 triangles spent on a defect that did not exist. **Any assertion over a
vertex-interpolated attribute — vertex colour, vertex alpha, baked AO, lightmap
texels — has to sample the interpolant at the point that matters.**

**A pose is named for where the camera is, not for what it can see.** The first
pixel measurement of the finished decal reported DELIVERS NOTHING, from a pose
that looks at 1.35 m from 1.1 m away and therefore frames 0.84 m to 1.86 m. The
decal is at 0.68 m. **A pose that frames an object's body will routinely miss
the 200 mm nearest the ground** — which is exactly where contact, plinths, base
plates, skirts and road film live. Ground detail needs a pose aimed at the
ground.

**A rule written down is not a check, and the part you add next is not covered
by it.** `NOTES.md` case 43 was written on the strength of the fascia sweep and
says plainly that the defence against an inverted surface is a build-time
assertion. Three new outward-facing parts then went in and only their *positions*
were asserted, because the winding assertion named the fascia. The concrete
form: **after adding a part, ask which existing assertion covers it, and if the
answer is "the one I wrote for a different part", it is not covered.**

One closed-volume corollary, because it bit the fresh test in the same round:
averaging face normals over a *closed* solid is always zero, so a winding test
applied to one reports a false failure. Test hand-wound open quads; closed solids
are proven by being visible.

---

## Cost

+4 draw calls and +3064 triangles as measured in the live frame. Geometry totals
10 146 triangles for the canopy proper plus 8192 for the contact decals, which
frustum-cull at most poses. Textures: four 512² (grime, steel normal, steel
rough, lens), one 384² soffit bake, one 256² soffit lamp map, one 1024×512 sign
atlas, one 128² overflow stain — **6.88 MB, 9.17 MB with mips.** No 2048² maps.
Columns are instanced; the two soffit bakes are the only textures unique to this
system that scale with deck area, and neither exceeds 384².

`probe-canopy.mjs` reports the cost table every run and gates a self-imposed
20 000-triangle ceiling on the canopy proper.

---

## Flagged to other systems, nothing blocking

- **Lighting.** `contactShadow`'s derived level reports `clamped: true` at
  `environmentIntensity` 2.4, so that coupling has no headroom — the term stops
  tracking if the environment rises further.
- **Terrain.** `sweepProfile`'s `chip` is two `hash1` octaves, and `hash1`
  decorrelates on *any* input change, so a frequency multiplier inside it is a
  seed. Long spalls are unreachable rather than rare. Terrain owns both
  consumers; **the canopy passes no `chip` at all**, and should not adopt it —
  a folded sheet-metal fascia dents and creases but does not spall, because
  `chip` models brittle-edge failure. If it is converted, put the wavelength in
  **metres, not stations**.
- **Vegetation.** The deck rect is on the `canopy` service as `deck`. For the
  conifer occluding the fascia panel, the sight line from the `sign` pose eye
  (0.4, 1.62, 2.4) to the logo panel centre (0.6, 5.45, 13.1) is 11.37 m at
  bearing 1.1° and elevation 19.7°, and **it is only 2.5 m up at z = 5**, so a
  conifer need not be tall to block it.

---

## Dimension table, for orientation

```
deck            x -6.6 .. 6.6   z 13.1 .. 26.7      13.20 x 13.60 m
soffit          y 5.2410        coping y 5.9930     drip y 5.1910
clear height    4.72 m nominal, 4.71-4.78 over the slab, 4.55 over the cap
fascia          H 0.700  T 0.075  coping 0.752  drip drop 0.050
                24 mm inward batter over the height
columns         0.46 sq clad, base pad 0.64 sq, at (+-3.5, 16.6 / 23.2)
                on the pump island caps; yaw restricted to 0 and 180 only
shaft           base y 0.7394, length 4.5016, one instanced geometry
island caps     0.6785  0.6751  0.6894  0.6691 — the base absorbs the difference
soffit panels   8 x 8 battens, geometric, merged into the soffit mesh
fixtures        8, 0.64 sq, surface-mounted, drop 0.09
bakes           lightmap 384 sq, lamp map 256 sq on uv1
```

**Column yaw is restricted to 0 and 180 for a physical reason, not an aesthetic
one.** Object ±X faces run *along* the island toward the pumps and bollards, so
nothing can drive at them; object ±Z faces a drive lane on both islands. The
downpipe boot goes where a car cannot hit it and the bumper scuffs go where cars
can, so the two details want opposite faces. At 90° the scuffs land on faces no
car can reach. Instance yaw still does real work here — `applyGrime` samples
object space, so two orientations are enough to stop four instances carrying
byte-identical dirt.

---

## Round: the forecourt-contrast request, and why the answer was "not mine"

A request arrived to raise soffit bounce, on the grounds that this deck shadows
the whole forecourt and is why Terrain's tyre scrub delivers zero contrast. Three
findings, all CPU-verified under a GPU hold, none requiring a capture.

**1. The deck shadows none of the forecourt.** `SUN.azimuth` is 203.4 degrees, so
the anti-sun direction in XZ is (0.918, 0.397) and the 43.5 m reach is displaced
**39.9 m in X, 17.3 m in Z**. The shadow lands at x 33.3..46.5, z 30.4..44.0; the
forecourt ends at x 11.6. Ray casting all 8775 forecourt samples puts the deck at
**0.00%** and the four columns at **10.97%** together. The forecourt is 89% in
direct sun. The reported reach was right; it was applied along +Z.

Also note that a 6.2 degree sun under a 4.72 m deck penetrates 43.5 m
horizontally against a 13.2 m deck depth, so **a low sun lights the ground under
this canopy right through to the far side.**

**2. Soffit bounce was never a lever on the ground.** `lightMap` and
`emissiveMap` are receiver-side; there is no light transport between surfaces in
`WebGLRenderer`. `setLampBounce` and `setLightmapIntensity` move the soffit's own
pixels and the ground by zero. Had the knob been turned and the frame
re-measured, the null result would have been indistinguishable from a broken
control.

**3. The physically correct replacement also does not deliver.** Built the real
second bounce — soffit exitance integrated over the deck with the parallel-plate
form factor `h^2/(pi r^4) dA` — and exact deck solid-angle occlusion of the
ambient. Individually strong: the bounce field ranges 10.7x. **Summed, spread
across the deck footprint is 3.4%, flatter than the 7.3% it was meant to fix**,
because occlusion is deepest exactly where the view of the soffit is best. A 0.82
albedo ceiling returns nearly what it intercepts. That is why canopies are white.

The real cause of median 41 at 7.3% spread is arithmetic nobody had written out:

```
  direct   sun 4.4 x sin(6.2 deg) 0.108  ->  0.475
  ambient  env 2.4, one constant colour  ->  2.400
  ambient : direct = 5.05 : 1
```

Ambient-dominated by 5:1, and the ambient is a constant. Measured tonal
spread from the lighting terms alone over the open apron: **0.0%**. Under the deck
25.9%, all of it the four column streaks. **The region is flat because its
dominant term is uniform, so level is not the lever — structure is.**

### What was published anyway, and its honest amplitude

`canopy.underDeck` with a single `ambientScale(x, z)`, because the first version
exposed `skyVisible` and `soffitBounce` separately and the free coefficient
between them let the deck *brighten* the ground it shades at the arbitrary 0.42
used while testing. Combined as `skyVisible + albedo * (1 - skyVisible) * shape`
it is bounded above by 1 by construction.

It fixes a different, real defect: under the deck and out on the apron currently
render at the *same* median, so there is no tonal relationship between the canopy
and the ground beneath it at all. Amplitude, stated in the service so a consumer
reads it before integrating: **0.883 at the drip line, 0.915 mid-bay, 0.942 on
the apron.** 6.3% point to point, **0.5% median to median.** The shape is the
interesting part — an inverse vignette, darkest at the perimeter, because at the
drip line you have lost 29% of the sky but see less soffit than from mid-bay.

Recommendation to a consumer: do not spend a round on it for contrast. It is
correct, cheap and small.

### Shared tooling added

`tools/probe-shadowsource.mjs` — names the occluder shadowing a region, and the
fraction, by ray cast rather than displacement arithmetic. Takes `--rect`. Add a
conservative AABB for your geometry; too-big boxes over-report, so
`shadows NOTHING` is trustworthy. Listed in the NOTES tooling section.

`tools/probe-canopy.mjs` gained four assertions covering the above, because the
claims are now prose in a service doc comment and NOTES 43 is explicit that prose
is not a check. If `SUN`, the deck rect or the clear height moves, the probe fails
rather than the documentation going stale.

### NOTES entries

68 (shadow reach vs direction), 69 (occlusion and its own bounce cancel; the free
coefficient between two published fields is where the error lives), 70 (a region
lit mainly by a constant is flat at every brightness — the complement of 63).

NOTES 70 also records that the same diagnosis had been written in this system's
own file for the soffit, 4.7 m above the surface with the identical problem, and
neither system connected them. Fourth instance of a rule covering the case that
produced it and not the next.

### Coordination

- **Terrain**: the premise is wrong and its albedo restraint was still correct.
  Its detail is on a surface that is 89% sunlit, so the illumination term is not
  the blocker there; the blocker is that the term is *uniform*. Column shadow
  streaks are the one structure crossing that region and they already render.
- **Lighting**: do **not** raise `environmentIntensity` for this. At 5.05:1 it is
  already the dominant term and raising a constant produces exactly the flat and
  milky outcome. If anything is worth doing it is giving the ambient spatial
  variation, and `canopy.underDeck.ambientScale` is one input to that.
- Nothing was asked of anyone and no sibling file was touched.

### State

No GPU work, no build, no capture, no browser. Port 5153 had no listener before
and after. Canopy files typecheck clean; `Game.ts`, `BuildingSystem` and
`VegetationSystem` had sibling errors during the round. `probe-canopy` passes in
full, 10146 triangles, 6.88 MB of texture, unchanged — the field is a function,
not geometry, so the cost delta is zero.

### Correction: the elevation was stale, and every conclusion survived

`site.SUN.elevation` held 11 degrees while `LightingSystem` shipped 6.2 from a
private `SUN_ELEVATION_DEG`. Nothing in `src` imported the shared field, so the
renderer never disagreed with it and only CPU probes were exposed. Terrain found
it; `site.ts` has since been reconciled to 6.2 by its owner. **Not fixed here, on
instruction — Lighting owns the sun.** All figures above have been recomputed.

What changed: reach 24.3 -> **43.5 m**, displacement 22.1/9.5 -> **39.9 m X,
17.3 m Z**, shadow landing x 33.3..46.5 instead of 15.5..28.7. The deck misses
the forecourt by considerably more than first reported. Direct term 0.840 ->
**0.475**, so ambient:direct goes from 2.86:1 to **5.05:1** and the
ambient-dominance argument in NOTES 70 strengthens rather than weakens.

What did **not** change: deck coverage of the forecourt is still 0.00%, column
coverage still **10.97%**, and `ambientScale` is unchanged at 0.883/0.915/0.942
because it depends only on geometry. `probe-canopy` passes in full.

The invariance was checked rather than assumed, since identical output from
changed input is exactly what a cached value looks like. An elevation sweep gives
10.97% at 3, 4, 6.2 and 11 degrees, then 22.75% at 20 and 42.03% at 35. The
columns span the full clear height and a ray needs 4.76/tan(el) to climb to the
soffit — 43.8 m at 6.2 degrees against a maximum in-region distance of about
20 m — so below roughly 14 degrees the shadow test is purely two-dimensional and
cannot depend on elevation. Above that the deck itself starts landing on the
forecourt: at 20 degrees it contributes 16.41% where it had contributed nothing.

So **the column streaks are not longer or differently placed within the
forecourt**, only outside it, and Terrain's position that they are the region's
only large-scale structure is unaffected.

`probe-shadowsource` now resolves the elevation from `LightingSystem`'s shipped
constant, prints which source it used, and refuses to run if that disagrees with
`site.SUN` by more than 0.05 degrees — because a constant no shipping code reads
can only ever be validated by a tool. The guard ships a `--selftest` with the
historical 11-versus-6.2 case as a positive control, since a guard sitting on a
reconciled pair has never been seen to fire. It also takes `--elevation=` for
what-if sweeps, which is how the invariance band above was established.

Still stale and not mine to edit: NOTES case 63 carries the 11-degree reach and
the claim that the entire forecourt is in shadow, and the one-line doc comment
directly above `SUN` in `site.ts` still reads "~11 degrees elevation" immediately
above the corrected 6.2 value.
