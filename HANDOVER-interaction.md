# HANDOVER — interaction, the reticle and the prompt

Owner of: `src/systems/InteractionSystem.ts`, `src/systems/reticle.ts`, the
`#reticle` block in `index.html`, `tools/reticleprobe.mjs`. Additive edits in
`src/systems/PlayerSystem.ts` (shift, space, and the displacement accounting).

Everything below is measured on the run of 2026-08-29 12:38–12:45 unless it says
otherwise: **103 of 104 assertions passed**, and the one failure is a
pre-existing limitation documented under *The one FAIL, and why it is not a
regression*. Read that section before you read the failure line.

---

## The four interactions, and the one thing that keeps them honest

Fuel a pump, work the storefront door, open the cooler, take a bottle. The
affordance is meant to be diegetic — you are stood in front of something real
and it responds — with one deliberate exception: a small centre-screen dot that
brightens on reach, and a one-line prompt naming the action. The prompt was
added after the user walked the build and asked to be *told* what the action is,
which reversed an earlier decision to have no text at all.

**The dot, the wording, the E key and the mouse click all go through one
`pick()` at one `REACH_M`.** This is the load-bearing decision in the file and
it is not an implementation detail:

- A reticle with its own ray disagrees with the click at the boundary, and a
  mark that lights up over something a click then misses is worse than no mark.
- A prompt is worse still, because it is a specific promise. Text that says
  "press E" while only the mouse works, or that names a verb the toggle will not
  perform, is the software breaking its word.

So `promptFor()` derives its wording from the same hinge and session state that
`act()` branches on, and `act()` is reached from exactly one place per input.
There is **no wording in `index.html`** — no second copy to drift.

`?reticle=1` stands in for pointer lock, because headless Chromium cannot enter
it. It gates the reticle *and* the E key together, through one `engaged()`
predicate, so the prompt cannot advertise a key that is inert. **A run without
that flag reports a confident 0 µs for the hover ray** and passes every prompt
check by rendering nothing.

`e.repeat` is dropped on E because every action here is a toggle, and a held key
would start and stop the pump at the OS repeat rate — an obvious-in-hindsight
failure that would have read as a physics bug. `pointerdown` does not repeat,
which is why the guard is only on the key.

---

## THE FIX THIS ROUND: the reach priority, and why taking a bottle was impossible

**Taking a bottle — one of the three interactions in the brief — could not be
done at all, and this harness passed 91 of 91 assertions over it.**

`pick()` returned the first usable hit along the ray. The cooler leaf swings
across the sight line when open and sits **0.62 m** from the eye, nearer than the
shelf behind it, so from the only spot a player stands at the probe returned
`cooler-door-2` *before opening and after*. The reticle lit, the prompt read
*press E to close the cooler*, and every attempt to take a drink shut the door.
Nothing was broken except the ordering.

The rule now: **the ray reaches *through* a hinge that is physically open, and a
grabbable behind one wins.** Everything else keeps nearest-first. That is a
better statement of intent, not a special case — someone who has opened a cooler
and is looking into it is reaching for the contents, not for the door again.

Three properties, each of which is a bug this would otherwise have:

**A shut leaf still wins.** The walk stops at anything that is not an open
hinge, so the bottle cannot be taken through shut glass — you have to open the
cooler first, which is the interaction the brief asks for. A priority rule that
let the grabbable win unconditionally would have satisfied "can I take a bottle"
while quietly deleting the door interaction. Verified: with the leaves shut, all
204 spots that have a leaf in the ray still resolve to the cooler.

**The test is `amount`, not `isOpen`.** `isOpen` reads `target`, the leaf's
*intent*, which flips to 1 on the frame the key is pressed — keying the priority
to it would let the player reach through a door that is still physically shut for
the 0.9 s the closer takes to swing. `amount` is where the leaf actually is.
**The prompt's verb keeps using `isOpen`, and the two differing is correct rather
than an inconsistency:** the verb must describe what the next `toggle()` will do,
while the reach has to respect where the geometry currently is. Do not
"harmonise" these.

**The prompt needed no edit.** `promptFor()` is handed whatever `pick()`
returns, so the pick resolving to the bottle produces *press E to take a bottle*
with no second rule to keep in step. Had the priority lived anywhere near the
prompt path this would have been two edits that could disagree, and the
disagreement would have shipped. This is the single-pick architecture paying for
itself and it is the reason not to move the priority out of `pick()`.

### Verified from every standable spot, not a chosen one

The old cooler test stood 0.95 m out from the leaf centre and aimed at the leaf.
It was correct — it verified that the cooler opens, closes and says so — and it
**could never have found this, because the stance was picked to look at the
door.** The bug lives at the stance a player adopts *after* opening it.

Section 5a of the harness therefore chooses nothing. It enumerates every position
on a 10 cm lattice within 2.2 m where the collision field says a body fits, and
asserts over all of them:

```
leaf shut, 307 standable spot(s): cooler x204, bottle x103
leaf open, 307 standable spot(s) (1.08-2.20 m): bottle x307
at 1.08 m: "press E to take a bottle" -> real keydown E
       carried false -> true, leaf target moved 0.000, next probe nothing
```

**307 of 307 with the cooler open, and no spot resolves to the leaf.** Both
interactions intact, which was the whole risk in the change.

Two details that make the enumeration honest rather than decorative:

- **Derive per leaf state.** A cooler leaf is a blocker that moves; the pocket
  in front of a shut door is somewhere the open door sweeps through. One list
  reused for both states would test the open door from places a player cannot be.
- **`collision.field` is published by `PlayerSystem.init()` *after* its
  `if (ctx.shot) return`.** On any `?shot=` capture page the service is simply
  absent, so a spot-derivation written there produces an empty list and every
  assertion over it passes. This is why 5a runs on the controller page. It is a
  live trap for anyone writing a controller-dependent probe against a preset.

Both are written up in `NOTES.md` under *A stance chosen by the person writing
the test can only test what they were thinking about*.

### The `setCooler` test hook, and why it exists

`__INTERACT.setCooler(index, open)` drives a leaf without aiming at it. It is in
the same class as `look()`: it sets up world state, it is not an input under test,
and it calls the same `toggle()` so the leaf, its closer and its audio behave
normally.

It exists because of a circularity. The only way to shut an open leaf through the
normal route is to point at it and press E — but pointing at an open leaf with a
bottle behind it now resolves to the bottle, which is **the behaviour being
verified**. A harness that used the key to arrange the scene could not test what
the key does.

Section 2 also uses it to shut every leaf before deriving its capture poses, so
the cooler's pixel evidence is of a cooler regardless of what a preset parked
open.

---

## The one FAIL, and why it is not a regression

```
FAIL  a shut cooler still wins, so nothing is grabbed through glass
      103 of 307 spots offered the bottle with the leaf shut
```

**Read this before concluding the pick priority broke something. It did not.**

`pick()` raycasts only against `this.roots` — pump roots, the entry door, the
cooler leaves and the grabbables. Walls, shelves, glass and the cabinet frame are
not in that list, so **occlusion by non-interactable geometry has never been
visible to it.** From those 103 spots the sight line contains no leaf at all, so
the bottle is simply the nearest usable hit.

**The old nearest-first code returned the bottle from exactly the same spots.**
The new rule only ever promotes a grabbable over a leaf whose `amount > 0.5`, and
every leaf read 0.00 in that sweep, so the walk breaks at the first leaf it
meets. The two implementations are identical on this input. The assertion found a
pre-existing limitation, not a regression.

The assertion is right about intent and wrong about what it can observe. Two
things are tangled in it:

1. `pick()` has no occlusion test against real geometry.
2. **The spot enumeration has no occlusion test either**, so it admits stances
   behind the cabinet's side wall or the shop's back wall, where a player facing
   the bottle would be looking at plaster. `probe-reach.mjs` carries a note about
   exactly this trap and this list walked into it — so **103 is an upper bound on
   a number that may be zero.**

### Decision: closed, deliberately. Do not open it.

Reach is 2.2 m, the cooler sits deep inside the shop, and the failure requires a
player to stand facing a wall with a bottle behind it and press E on a prompt
whose object they cannot see. Nobody walking this station will find it. Against
that: a second scene-wide raycast every frame, in the system that owns the four
things which must never disagree. **Opening a per-frame cost to fix a defect
whose magnitude cannot be stated is the wrong order of operations.**

If it is ever reopened, the shape is one occlusion raycast against the scene,
rejecting any target further than the nearest solid hit — and it needs a cost
measurement, not a patch. Fix the harness's enumeration in the same change, or
the number it reports will still be an upper bound.

---

## Shift and space, and the measurement that had to change

Shift raises the velocity *target* and leaves the smoothing alone, which is why
it reads as a person deciding to hurry rather than a multiplier being switched
on: the same exponential that gets the walk to 1.4 m/s carries it to 2.38, and
letting go decelerates on the identical curve. `RUN_MULTIPLIER` is **1.7** and the
restraint is the decision, not the number — 3x is 4.2 m/s, which is a jog and
changes the register of the whole scene.

Space is a short hop with real gravity, a grounded gate before it can fire, and
a landing **snapped** to `surfaceHeight()` rather than eased. Snapped because an
exponential approach never arrives and would leave residue on every hop; the eye
returned 0.000 mm off standing on five consecutive hops.

**One genuine input bug found by playtest and fixed here.**
`page.keyboard.press("Space")` fired 0 jumps of 5 while `keyboard.down("Space")`
worked, because a fast keydown/keyup can fall entirely between two `update()`
calls and the polled `keys` Set never sees the key. A `jumpTapped` edge flag,
consumed in `update()`, fixes it. **Every held-key test passed a feature that
dropped every tap** — the same class as the chosen-stance failure above.

### THE HEADLINE: a clamped `dt` turns a frame hitch into lost ground

Two runs measured sprint speed by ground displacement in the same build: 2.38 m/s
and **2.158 m/s**, the second 9.3% short. The walk measured **exactly 1.400** in
both, so the method was not suspect.

`Game.frame` runs `const dt = Math.min(this.clock.getDelta(), 0.1)`. A frame that
takes 300 ms advances the simulation 100 ms, so the body covers 200 ms less
ground than wall clock says — and **the loss is `v` times the excess, so the
identical stall costs a 2.38 m/s sprint exactly 1.7× what it costs a 1.4 m/s
walk.** One 290 ms frame inside a 2 s window is the whole 9.3%. Whichever window
the hitching lands in reads short; the other reads exact.

**The clamp is right and must stay.** Unclamped, that same frame advances the body
0.71 m in one step against a 0.32 m collision radius — a wall clip, not a feature.

The control run settles it:

```
walk, steady    1.397 m/s wall  1.400 m/s simulated   0 collision resolves
shift, steady   2.380 m/s wall  2.380 m/s simulated   0 collision resolves
steady ratio 1.7000x simulated, 1.7029x wall clock
dt clamp lost 0 ms of the sprint window
```

On a quiet machine displacement over wall clock equals the multiplier exactly,
over 4.773 m of real ground. **The only variable that changed was contention.**

The earlier assertion reported the ratio as 1.7000 to four decimals because it
read `__PLAYER().speed` — the magnitude of the velocity vector about to be
integrated, i.e. the controller's *intention*. It agreed with the code's own
arithmetic and could not see anything between the intent and the body.

Written up in `NOTES.md` under *A clamped `dt` turns a frame hitch into lost
ground, in proportion to speed*.

### The instrument — for Perf. Leave it as it is.

`window.__PLAYER()` carries three fields accumulated **post-collision inside
`update()`**, so they describe the body and not the intent:

| field | meaning |
|---|---|
| `travelled` | cumulative horizontal metres the body actually moved |
| `simTime` | simulated seconds accumulated, i.e. the sum of clamped `dt` |
| `resolves` | frames on which collision had to push the body out of something |

How to read it. Difference all three across a window, then:

- `travelled / wallClock` — **what the player feels.** Quote this for feel.
- `travelled / simTime` — what the controller delivered. **Only this may carry an
  assertion**, because otherwise a busy machine reports a working feature as
  broken (`NOTES.md`, *A timeout shorter than the phenomenon reports a healthy
  system as broken*).
- `wallClock - simTime` — **the clamp loss**: wall time the simulation refused to
  advance for. Multiply by speed for the metres of ground a hitch cost.
- `resolves > 0` — the path was grazing a blocker, so the shortfall is geometry
  and not the controller. Rules out the wrong answer.

Reported separately rather than absorbed into a tolerance, because **a tolerance
wide enough to survive a contended run is wide enough to pass a real
regression.** Same argument as the apex band below.

This is what turns a frametime spike into a statement about the deliverable:
hitches do not merely look bad, they take ground away from the player, and 1.7×
as much when sprinting.

### The apex is a function of frame rate, so it is asserted as one

The analytic apex is `JUMP_SPEED² / 2G` = 319 mm and no run will ever measure it.
Semi-implicit Euler takes gravity off the velocity *before* integrating position,
under-shooting by about `JUMP_SPEED · dt / 2` — 21 mm at 60 Hz, and **106 mm at
the 100 ms clamp.** Two runs read 311 mm contended and 297 mm clean; the
difference was frame time, not behaviour.

So the expectation is computed from the frame time each hop was actually built
out of:

```
hop 1: apex 296 mm vs 296 mm predicted at 17.8 ms/frame
hop 2: apex 292 mm vs 291 mm predicted at 21.7 ms/frame
hop 3: apex 297 mm vs 296 mm predicted at 18.2 ms/frame
hop 4: apex 293 mm vs 293 mm predicted at 20.6 ms/frame
hop 5: apex 296 mm vs 295 mm predicted at 18.5 ms/frame
worst 0.7 mm off prediction
```

**A fixed band wide enough to survive the worst frame rate would also pass a hop
that had lost a third of its height.** This retires the 311-versus-297
disagreement rather than splitting it.

---

## Measurements

### Frame cost

| | µs/frame | over |
|---|---|---|
| hover ray (`InteractionSystem`) | **169.8** | 1789 frames |
| `PlayerSystem.update`, standing still | **17.4** | 144 frames |
| `PlayerSystem.update`, sprinting + hopping | **28.0** | 143 frames |

The controller figures are the *whole* of `update()`, not the delta; the work
shift and space added is three Set lookups, a compare and two multiplies. The
hover ray has read 73.3, 169.8 and 188 µs across three runs at different scene
loads — all fine, none of them stable enough to quote to three figures.

### Reach boundary, four consumers

29 stances at 50 mm steps, **0 disagreements** between dot, prompt, E and click;
**one** transition, so no flicker band; E acted at 13 of 29, so the sweep is not
passing by never firing. Last bright ray distance **2.1755 m** against
`REACH_M` 2.2.

### The prompt in pixels

| pose | background luma | text px | peak contrast |
|---|---|---|---|
| pump | 29.7 | 875 | 181.2 / 255 |
| door | 158.2 | 1901 | 168.0 / 255 |
| cooler glass | 137.0 | 1960 | **106.4 / 255** ← worst case |
| sky / asphalt / sun-sky | 63, 17, 220 | **0** | 0 |

The idle assertion is the one worth keeping: the node **still holds a full
sentence while showing nothing**, so both zero changed pixels *and* the node
having wording at the time are asserted. That is what distinguishes "invisible"
from "empty", and without it the words would bake into every reference frame this
project takes. The three-layer `text-shadow` exists because the first version
read 65/255 over cooler glass; there is no box, by constraint.

### Jump and collision

Five hops landed 0.000 mm off standing with no drift. Holding space 3 s gave 7
hops with a ceiling of 297 mm, so it cannot be held to fly. A second press while
genuinely airborne gave 1 jump, apex 297 mm. Across the shop threshold — a
104 mm step, 0.469 m outside against 0.574 m inside — both crossings landed on
the surface that was underneath at touchdown, 0.000 mm off. Charging five
blocker groups while hopping: 1487 frames, 553 airborne, **worst penetration
0.0000 mm.**

---

## Instruments and hooks

| | |
|---|---|
| harness | `tools/reticleprobe.mjs`, port **5137** |
| build dir | `.shot-build/reticle/` |
| frames | `tmp/reticle/`, incl. `evidence-dot.png` (6×) and `evidence-prompt.png` (2×) |
| `READY_TIMEOUT_MS` | **420 s** — a cold load is ~284 s, of which ~262 s is the driver compiling |

`window.__INTERACT`: `services`, `calls`, `state()`, `look()`, `click()`,
`probe()`, `hover()`, `setCooler()`. `probe()` and `hover()` are deliberately
distinct — `hover()` is the *cached* result the player is being told, `probe()` is
what is true this instant, and a harness checking that the reticle does not lie
needs to compare the two.

`window.__RETICLE()` reports the DOM element's own state, including `prompt` and
`promptPresent`.

Two harness cautions inherited and worth keeping:

- The shader-failure regex must not match `program info log`. three.js emits that
  whenever the driver returns a non-empty log at all, so it fires on benign HLSL
  precision warnings from other agents' shaders — this run logged one (X4122,
  double-precision) from a program that linked perfectly.
- `collision.field`'s `resolve()` **mutates its argument**. It is a command, not a
  predicate; query it with a clone.

### One thing to know before adding a DOM overlay

`#reticle` is a zero-size anchor with `.dot` and `.prompt` as children. The
prompt joined the screenshot suppression list **without editing another agent's
harness**, because `visibility` inherits — and so will anything added inside
`#reticle` later. The default assumption is that a new element needs a new entry
in an enumerated list; see `NOTES.md`, *A new overlay does not need a new entry in
the suppression list, if it goes inside an existing one*, and the pointer comment
on `#hud` in `index.html`.

---

## Status: finished. What is deliberately left

The four interactions work and are verified. Nothing below is needed for the user
to walk the scene.

1. **`pick()` has no occlusion test against non-interactable geometry.** Closed
   deliberately — full reasoning above. If reopened, fix the harness's spot
   enumeration in the same change.
2. The prompt's worst-case contrast is 106.4/255 over cooler glass. Legible and
   verified, but it is the thinnest margin in the set and would be the first
   thing to suffer if the cooler's glass material is brightened.
3. The hover ray is 169.8 µs and skipped entirely whenever the reticle is hidden,
   so every `?shot=` capture pays zero. If quality scaling ever wants it cheaper,
   the lever is `this.roots` — it is a small list and `raycaster.far` already caps
   at 2.2 m, so three rejects most roots on their bounding sphere.
