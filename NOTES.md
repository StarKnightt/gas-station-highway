# Silent failure modes seen in this project

> ## CITE CASES BY TITLE, NEVER BY NUMBER
>
> **The numbers in this file are not unique.** Seven agents append concurrently,
> so at the time of writing there are 84 numbered cases across 52 distinct
> numbers: 26 numbers are reused and "case 55" matches four different cases. A
> citation by number is therefore ambiguous, including in reports already written
> that cite correctly by their author's local numbering.
>
> **The file is deliberately not renumbered.** Renumbering would invalidate every
> citation in every report written tonight, including all the correct ones, which
> costs more than the ambiguity does. So the numbers stay as a rough chronology
> and **the title is the identifier.**
>
> When adding a case: give it a title that states the lesson as a sentence, and
> assume the number you pick is already taken.

Cases 1-7, 9-16, 18, 21, 26 and 27 are silent failures. Case 8 is the opposite and
is documented here anyway, because the outcome was the same. Case 17 is a third
kind: a feature that reached the screen intact and was read by the eye as the
opposite of what it was. Cases 19, 21, 22 and 24 are a fourth: a feature that
reached the screen, was measured, was correct, and answered a different question
than the one being asked.

Cases 28 and 29 are the fourth kind again, and case 28 is its purest example so
far: the capture was honest, the file was the right file, the instrument read it
correctly off disk in display space — and it measured luminance when the critic
was reacting to hue. Case 30 is the pipeline audit that came out of chasing 28.

Cases 33 and 34 are the first two written up from the *constructive* side: not
"here is how the measurement lied" but "here is the measurement that could not".
33 is region selection failing for a structural reason — no rectangle in the
frame contained a whole period of the feature — and the fix of recomputing the
feature's phase from world position instead of recovering it from the image. 34
is the observation that an **impossible distribution** identifies a defect faster
than any amount of reasoning about materials, and that a probe taking no
coordinates cannot be accused of choosing its region.

Case 31 is a fifth kind, and the only one so far where the project detected its
own defect and shipped it regardless: the guard fired, printed the correct
number, and then installed the poisoned data anyway. **A guard that reports
without refusing is worse than no guard**, because the artefact then carries the
authority of having been checked. Every validity guard in this project should be
read with one question: what does it *do* when it fails?

Cases 35, 36 and 37 are a sixth kind and they arrived together, from the first
time anyone actually walked the scene rather than photographing it. Case 35 is a
defect that **no fixed-camera capture could ever have seen**, because a `?shot=`
preset disables the player controller and poses the camera itself — so every
verification this project has run was structurally blind to everything the
controller does. Case 36 is an instrument that **performed the fix it was
testing for** and reported the result as evidence. Case 37 is a constant whose
name and comment described a speed the code never produced, above a clamp that
could never fire. Ask of any capture tool: what does it bypass, and does it
write to anything it reads? And of any named constant: has anyone measured the
quantity it claims to be?

Cases 39 and 40 are a seventh kind: **a number that cannot mean what it says.**
Case 39 is one parameter scaling two independent physical quantities, so every
value of it is a compromise between them and tuning it measures nothing — the
tell was a reflection that got *weaker* at grazing incidence, and a quantity
with the wrong sign is a far stronger signal than one with the wrong magnitude.
Case 40 is an authored value silently overwritten by another system, written by
an author who had read the closely-related case 26 an hour earlier. Ask of any
number you are about to tune: how many things does it control, and who else
writes it? Case 41 is a measurement and an observer disagreeing where **both
were right** — a correlation tested at one lag in block units could not see a
period that exists in tile units, and the two coordinate systems in one material
share no common lag. When those two disagree, suspect the question before either
answer. Case 42 is a map that bound, was read, and was thrown away by the tone
curve because another system owned the multiplier — the same symptom as a map
that never bound, and none of the defences for that one detect it. Case 43 is one
parameter conflating transmittance with an added veil, which alpha blending puts
in a single expression: **each blend mode expresses exactly one physical process
once the term it cannot express is removed from it**, and the fix was to zero a
term rather than to balance it — the third time in one night that removing a term
beat tuning it.

Two more, both about **the denominator rather than the measurement**. Counting
`THREE.Texture` objects to estimate VRAM is wrong wherever `clone()` is used,
because the renderer keys uploads on `source` — three agents found this
independently on one night, each having doubled or tripled their own system's
apparent cost, and note that the error makes you look *worse*, which is why
nobody had questioned it. And an `onBeforeCompile` that does not extend
`customProgramCacheKey` hands two materials the same compiled program: it is the
exact inverse of a key that is too specific, and where the specific key merely
wastes programs, the missing one **fails by producing a plausible frame** — in a
debug path, which is what you reach for when you are already confused.

**Case 33 now has a permanent instrument, and it is scene-wide, not car-only.**
`tools/probe-unseen.mjs` (`--selftest`) answers, for every mesh in the scene,
*does removing this mesh change a single pixel* — the real scene, the real
materials, `visible` toggled, frames differenced. That is the definition of
visible rather than a proxy for it, so it holds for alpha-cut foliage and
vertex-displaced billboards as well as for solid panels, and it needs no
authored debug colours and no coordinates from the caller. Each mesh is judged
from its own best-case camera, derived from its own mean shading normal, at
three distances; a preset list cannot be complete, and "not in any preset" is a
different finding from "cannot be seen from anywhere". Silent meshes are then
re-rendered with one property forced at a time so the tool names the cause:
HIDDEN, WINDING, OCCLUDED, CULLED or DEGENERATE. WINDING is the only one that
is never legitimate and the only one that fails the run by default.

Three things about it are worth copying into any probe of this kind:

- It refuses to report anything until it has rendered the same view twice with
  nothing changed and got bit-identical frames. Without that control every
  result is noise, and an animated uniform would return a flattering all-clear.
- Its selftest plants a good quad, a backwards quad, an occluded quad and a
  hidden quad in the live scene and requires exactly those four verdicts.
- Both of its early false results were the probe measuring **itself**. It first
  reported twenty-five vegetation meshes as drawing nothing, because those
  shaders fade by apparent screen size and the camera had been shoved up
  against them — fixed by trying three distances. And its own selftest reported
  a planted occluded quad as DEGENERATE because the occluder in front of it was
  the same white material, so forcing the hidden quad in front changed no
  pixels. That second one is a real limit of the method and is documented in
  the file: **a mesh identical to what is behind it cannot be distinguished
  from a mesh that did not draw.**

First scene-wide run: 342 meshes, 96 unnamed, **zero winding failures**. An
unnamed mesh is not a rendering fault but it is a diagnosis fault — every
per-mesh instrument prints `<Mesh>` for it, so whatever it is doing wrong lands
on nobody's desk. Two such meshes were in the car. `CarSystem`'s `add()` now
takes a required `name`, so tsc is what notices the next one, and `__CAR`
reports `unnamedMeshes`.

Case 33 is a sixth kind and the most expensive single defect recorded here: a
part that was **correct in every respect that anything checks** — present,
merged, in spec, proud of the surface, zero fallbacks, `tsc` green — and wound
backwards, so it drew nothing. Winding is checked by nothing in this project,
and "drew nothing" is indistinguishable in a capture from "drew something
subtle". It took four rounds, three of them spent on hypotheses that were each
correctly ruled out by a correct measurement. **When inference has failed three
times, stop inferring and make the frame answer**: flat-colour the candidates
and read the pixels as labels. That cost one throwaway capture and was decisive,
and the same probe immediately found four more invisible parts in the same nose.

**Cases 9, 17, 18, 19, 21, 22, 24, 28 and 29 are all the same shape and it is now much the
most common failure on this project.** Not "the code didn't run" but "the code
ran, the measurement passed, and the render still looks wrong". Every one of them
was found by measuring the thing a viewer actually judges — the angle between two
panels, the outline of a post, the pixels of two instances side by side — rather
than the parameter that was supposed to produce it. When a builder and a critic
disagree, that gap is where the bug is: in cases 21 and 22 the builder measured a
43% spread in the generator and the critic saw one asset, and **both were right**,
because the spread was all in amplitude and none of it in position.

**Cases 5, 16, 22 and 27 are the other recurring shape: one shared misunderstanding
surfacing as unrelated symptoms in several systems.** A noise function's grid
artifact in both dirt and asphalt; an RNG's seed correlation in both pines and fuel
hoses; an object-space field on both wheels and dispensers; a colour-space default
in a treeline, a duff mat and an overhead wire. When a root cause lives in shared
code, **audit every consumer of it in the same round** — in all four cases the
system that reported the bug was not the only victim, and in case 27 the agent who
correctly diagnosed and fixed it left three siblings untouched in its own files.

Fifteen times now, code that was written correctly has failed to reach the screen
without raising anything. In every case the scene still rendered, so the only
signal was "the feature I just wrote doesn't look like it's there" — which is
indistinguishable from "the feature is there but needs tuning", and that
ambiguity cost three review cycles.

**If a feature you just wrote doesn't read, force it to an absurd value and diff
the frame before you touch a single aesthetic parameter.** `tools/diff.mjs`
reports changed-pixel count and max delta. If forcing it to an extreme does not
move pixels, it is not wired up, and no amount of tuning will help. If it *does*
move pixels but not in the shape you expected, the logic is wrong rather than the
strength — which is how the wheel-path bug below was finally caught.

| # | Symptom | Root cause |
|---|---|---|
| 1 | Bright and dark blooms over the concrete, especially white blobs that debug material IDs confirmed were concrete, not a stray mesh | The site overlay was a `CanvasTexture`. Canvas backing stores are premultiplied, so writing low-alpha pixels and then reading them back corrupted the RGB channels. Fixed by assembling a `DataTexture` from two separate canvases, one for RGB and one for alpha. |
| 2 | White blobs punching up through the forecourt slabs | The joint-bed plane was tessellated more coarsely than the slabs above it, so the shared height field evaluated to different values on each and the bed bulged through. Compounded by a hash term in `undulation()` that made the field discontinuous. Fixed by removing the hash and deriving the bed height from the slab height minus a fixed offset. |
| 3 | Painted road markings completely invisible | `stripeGeometry` emitted indices in the wrong winding order, so every stripe was back-face culled. |
| 4 | Wheel-path polish, reported as implemented, described by an independent viewer as absent | Two separate faults. The fragment shader was failing to *link* (`uWheelDark : undeclared identifier`) because the uniform declaration string had not been updated alongside its use — the software rasteriser accepted it, the NVIDIA driver did not. And once linked, the mask summed four ~1 m Gaussian lobes and clamped, saturating across the entire carriageway, so it darkened the road uniformly instead of in ribbons. |
| 5 | Dirt shoulder reading as regular corduroy ripples, and the asphalt normal map showing a regular directional grain — both resistant to three rounds of parameter tuning | Shared bug in `noise.ts`. `valueNoise` is bilinear-interpolated lattice noise, whose signature artifact is axis-aligned structure, and `fbm` stacked it with `lacunarity = 2`, so every octave's lattice lines fell on exactly the same rows and columns as the previous octave's and reinforced into visible plaid. Fixed with periodic gradient noise, a quintic fade, non-harmonic octave frequencies, and a per-octave dihedral symmetry. |

| 6 | `uWheelLimit : undeclared identifier` — a *recurrence* of case 4 with a different uniform name, caught by another agent running the live page | Structural, not a typo. `applyWorldDetail` kept three lists that had to agree by hand: the GLSL `uniform` declarations, the `shader.uniforms` assignments, and the uses scattered through the injected chunks. Renaming `wheelLimit` to `wheelBand` updated the declaration and the main use but missed a second use inside the sun-bleach block. A parallel `#ifdef WD_WHEELS` gate duplicated the JS `useWheels` flag, giving the same feature two sources of truth. Fixed by generating declarations and uniform values from one table, deleting the feature `#define`s in favour of JS interpolation, and asserting at injection time that every `uXxx` in the injected GLSL is in the table. |

| 7 | Aerial perspective (System 4) completely absent, while the shader compiled, the chunk patch reported success, and every uniform name resolved | The extra fog uniforms were added to `THREE.UniformsLib.fog`, which is where they belong — but `THREE.ShaderLib` merges the uniform libraries at *module load*, so every built-in material's uniform set is a snapshot taken before any of our code runs and never sees the addition. GLSL treats an unset uniform as zero rather than an error, so `uHazeGain` was 0 and the whole feature multiplied out to nothing with no diagnostic anywhere. Fixed by injecting into every `ShaderLib` entry that already carries fog uniforms, and reporting a failure if none does. **Generalises: mutating a `UniformsLib` after import is a no-op for built-in materials, and a uniform that is missing from the JS side is silently zero on the GLSL side — the opposite of case 4, where a missing *declaration* was at least a hard link error.** |

| 8 | The whole page blank. `PumpSystem.init` threw `pumpParts: merge failed (mismatched attributes)` after `THREE.mergeGeometries(): failed with geometry at index 4`, so `Game.start()` rejected out of its bare `await s.init(...)` loop and *no* system after the pumps ever initialised — player, building, audio, the interior lighting pass and interaction were all dead, and `__SCENE_READY` never fired | `ensureAttrs` normalised `normal` and `uv` and stripped `uv1`/`uv2`, but never the index buffer. `mergeGeometries` requires the whole list to agree on *three* things and indexed-ness is the third: `chamferPrism` returns an `ExtrudeGeometry`, which is non-indexed, while every `BoxGeometry`/`CylinderGeometry`/`TubeGeometry` primitive is indexed. In `buildPump`'s `steel` list, entries 0-3 are chamfer prisms (cabinet, valance, head, head step) and entry 4 is the `roundedBox` crown moulding — the first indexed member of a non-indexed list, hence "index 4". Fixed by giving non-indexed geometries an identity index in `ensureAttrs` (exactly lossless, unlike `toNonIndexed()`), and by routing every pump merge through `mergeChecked`, which on failure prints a per-geometry table of attributes, vertex count and indexed-ness instead of a bare index number. |

Case 8 is the inverse of every case above and worth its own note. **It was not silent — it was maximally loud**: a thrown `Error`, a `console.error`, a stack trace and a completely white page. It still went unnoticed for over an hour, because between 15:16 and 16:29 five agents were working in five different source files and none of them loaded `index.html`. Loudness is worthless without a listener. Two things follow, and both are now in place:

- `Game.start()` no longer lets one system's failure abort the others. Each `init()` and `update()` is wrapped; a throwing system is logged as `SYSTEM FAILED`, recorded on `window.__SYSTEM_ERRORS` and skipped, and the scene still reaches `__SCENE_READY`. A broken pump can no longer hide a working building. Harnesses should assert `__SYSTEM_ERRORS.length === 0` and treat a non-empty list as a hard failure — the isolation exists so failures cannot mask each other, not so they become invisible.
- If you have not loaded the page since your last commit, you do not know the page loads.

| 9 | The car's flank creases reported as reaching the screen by a forced-value diff — 47,093 pixels changed against a control of 0 — while an independent visual critic reported "no feature lines anywhere on the body; highlights flow uninterrupted across the entire side; nothing on this car ever makes a highlight terminate". Both observations were correct | A shape error, not a shading or resolution error. Measuring the angle between the mean outward normal of the panel below each crease and the panel above: the character-line fillet tilted +36° and came straight back −33°, a **net 3.3°** between the two panels either side; the beltline was +30.6° then −30.0°, a **net 0.6°**. The creases were real and sharp, and pointless — a 15 mm fillet between two near-coplanar panels is a thin bright sliver, roughly two pixels at ~7 mm per pixel, which the mip chain averages into a soft tonal band that reads as a paint tone change rather than an edge. The cause was that the body's maximum half-width sat 230 mm *below* the character line, so the flank was still swelling outward as it rose past the crease and both panels faced outward and slightly up. Fixed by making the character line itself the widest point, with a mid-flank pull-in below it, so the lower panel faces outward-and-down and the upper faces outward-and-up: net +28° at the shoulder and +25° at the belt, both monotonic. Verified with a luminance probe down one screen column rather than by pixel count — 95.9 to 66.1 across two rows, flat panels for 12–13 rows either side, a terminate rather than a ramp. **Generalises two ways. A feature line reads because of the angle between the surfaces it separates, not because of its own width or contrast — measure the angle, not the pixel count. And, against the advice at the top of this document, a forced-value diff proves a feature reaches the screen; it does not prove the feature is doing anything worth seeing — diff is a test for silent failure, not a test for quality.** This is also a second, distinct failure mode alongside sub-pixel detail: detail can fail for being too small to survive sampling, *or* for separating surfaces that are nearly parallel. The two look identical in a render and need different fixes. |

| 10 | Tyres sitting weightlessly on mathematically perfect tori, despite the tyre builder correctly baking a contact-patch flat and sidewall bulge at −Y | The car system set `rotation.x` per wheel to vary the tread appearance. That is rotation about the axle, so it rolled the baked flat up to 2.1 rad away from the road. Fixed by making tread variety a phase argument that moves only the pattern, leaving the baked geometry oriented. **Generalises: if geometry bakes in a world-direction-dependent feature, any later rotation of that mesh silently invalidates it — either bake in local space and orient once, or parameterise the variation so it cannot touch the transform.** |

| 11 | The car criticised for having no grille or front intake | The grille and intake meshes already existed and were correct. The fascia cap was a closed fan, so they were sealed inside the prow and never visible. Two follow-on faults came out of cutting the apertures: the cap's ring needed refining 4:1, because 132 points put only about 10 across the grille and the cut came out as a staircase; and the reveal walls needed separate vertices per winding, because sharing them makes `computeVertexNormals` average a normal with its own negation, land on zero, and shade as white confetti. **Generalises: before adding a missing feature, check it isn't already there and occluded. A detail that is present but enclosed looks identical to a detail that was never authored.** |

| 12 | The building's analytic world-space coursing absent from the surface, silently, in the same manner as cases 4 and 6 | The coursing shader contained `void(bcNJ);` — the C/JavaScript idiom for explicitly discarding an unused value. GLSL has no void cast, so this is a syntax error and the shader failed to link. Fixed by removing the cast; the correct way to discard a value in GLSL is to assign it into something the compiler cannot eliminate, or simply to leave it unused. A warning comment now sits at `src/gen/buildingCoursing.ts:250`, and there is no remaining void-cast idiom anywhere in `src/`. **Generalises: GLSL is not C and is not JavaScript, and habits carried over from either compile fine in a text editor and fail at link time. TypeScript checking gives no protection at all here, because shader source is just a string as far as `tsc` is concerned — the same blind spot as the undeclared uniforms in cases 4 and 6.** |

Cases 4, 6 and 12 together establish that shader source is the one part of this
codebase with no static checking whatsoever — not `tsc`, not the linter, not the
type system — and therefore the one part where an automated hard-failure check on
link errors is not optional.

| 13 | Two critic passes over the car scored 5/10 and then 3/10, and the drop was read as the two critics disagreeing about the same build | They were not looking at the same build. Every harness wrote to a fixed path — `shots/car/side.png` — and overwrote it each round, so the second critic was shown a *later* car through the same filenames the first had reviewed. Nothing recorded which bundle any PNG came from, the earlier round no longer existed to compare against, and a stale PNG that a failed run had left behind would have looked exactly like a fresh one. Fixed by `tools/archive.mjs`, below. **Generalises: a capture must be traceable to the build that produced it, and comparing two rounds requires that both still exist. A score delta between two runs means nothing unless both sets of pixels are still on disk and each is stamped with the bundle that made it.** |

| 14 | The car's tail lamps reported as "red-and-white noise painted directly onto the flat rear panel with no housing, no recess, no lens" — twice, across two critic passes, and after a rebuild that gave them three chambers, reflector bowls and lens flutes. Every one of those parts was verified present, unoccluded and reaching the screen | The parts were fine. The *surface they were built on* was corrugated. `endZ` returns the fascia depth for a point on the nose or tail by intersecting a ray from the cap centroid with the section outline; it derived the ray parameter by dividing a crossing coordinate by a component of the direction vector, which blows up as the ray approaches axis-aligned, and then kept the **largest** result over all edges rather than the nearest, which on a non-convex ring picks the far side of the car. When the result came out short the function fell through to a flat fallback plane. Sampled over the tail-lamp rectangle, **39% of points snapped to the flat plane and the rest sat on the true fascia, a 39 mm sawtooth**; the front grille was 13% and 42 mm. `endPatch` calls `endZ` per vertex, so every lamp, grille, badge and plate on the car was being laid on that sawtooth — which is precisely what "noise painted on a flat panel" and the torn grille edges I had previously blamed on tessellation actually were. Fixed by solving the ray-segment intersection with Cramer's rule, keeping the nearest crossing ahead of the ray, and never dividing by a direction component: grille 13% → 0%, worst neighbour-to-neighbour step 42 mm → 0.6 mm. A second, unrelated contribution: the lamp and headlamp footprints extended past the edge of the cap outline, where there is no fascia to sample, so their outer rows legitimately had nowhere to sit — both were resized to the measured usable envelope. **Generalises: when a part looks wrong, check the surface it is positioned against before adding detail to the part. Two rounds were spent adding internal structure to a lamp whose problem was that the panel under it was 39 mm of sawtooth. A helper that silently substitutes a fallback value on failure will hide this indefinitely — prefer one that is correct everywhere, and measure its output over the region you care about rather than at a single point.** |

| 15 | Generalising case 14, and the reason it cost what it did. A geometry helper that cannot compute an answer and substitutes a *plausible* one does not produce a missing feature — it produces a **subtly wrong surface**, and that is a far more expensive defect to find. A missing part is obvious in one look. A part built on a surface that is right in most places and 39 mm out in the rest looks like a *material* or *tuning* problem, so that is what gets attacked | `endZ` fell through to a flat fallback plane whenever its ray-outline solve came out short. Nothing was missing, nothing threw, nothing logged, and the returned number was always in the right range — so no caller, and no reviewer, could tell the difference. The bill: **39% of tail-lamp samples on the flat plane** giving a 39 mm sawtooth, which produced two critic passes describing "red-and-white noise painted directly onto a flat panel", two full rounds spent rebuilding lamp internals (three chambers, reflector bowls, lens flutes) that were never at fault, and a torn grille edge misattributed to coarse tessellation and "fixed" by refining it. Three review cycles, all of them aimed at the part instead of the panel under it. **The rule: a geometry or placement fallback must be either loud, or counted and asserted on. It must never be merely plausible.** "Plausible" is the property that makes it survive code review and two critics. Note the trade-off changed and this is why the rule is now affordable: per case 8, `Game` catches a throwing system, logs `SYSTEM FAILED`, records it on `window.__SYSTEM_ERRORS` and carries on, so throwing costs one system rather than the page. Before that, throwing meant a blank screen and a quiet wrong number was the defensible choice. It is not any more. Audited the rest of the codebase for the same class and acted: `endZ`'s cap-uninitialised branch and `groundHeight`'s degradation to `() => 0` in `PlayerSystem` and `interactCheck` now throw; `endZ`'s off-outline clamp and `flankX`'s fall back to `hipX(z)` are counted per call site and asserted zero by `tools/carburied.mjs`. **A near-miss worth recording separately: `flankX` looks exactly like the `endZ` bug — same `Math.max` over segment crossings, same trailing fallback — and is correct.** It walks a half section starting at the floor pan on the centreline, so a low `y` legitimately crosses twice (at z = −1.172, y = 0.192: floor pan at x = 0.000, rocker at x = 0.799), and the outermost crossing is the one flank trim belongs on. "Fixing" it to the nearest crossing by analogy would have laid the sills and arch lips on the underbody. Measuring beat pattern-matching; a comment at `carBody.ts:701` now says so, because the resemblance is genuinely misleading. |
| 16 | Ten pines seeded from consecutive integers all came out the same species — radially symmetric and spike-topped — and a critic independently reported "wrong species" and "mechanical branch-radial symmetry throughout". The tree code was correct and each pine did independently have a 45% chance of a broken leader. Separately, the three fuel dispensers read as instanced props despite `pumpVariation` existing specifically to stop that | `makeRng` in `noise.ts` is a bare xorshift32 seeded directly with the caller's integer, and **its first draw is very nearly a linear function of the seed** — for seeds 1..10 it is exactly `seed * 0.000063`. Measured correlation of draw 1 against seed: **1.0000** over seeds 1..10, **0.9988** over 1..200, 0.7746 over 4000..4599. In every consecutive range tested, *all* seeds fell on the same side of a 0.5 threshold. The cause is a dead stage: `s ^= s >> 17` is a no-op while `s < 2^17`, so for small seeds the middle of the three shifts vanishes. Draws 2 and 3 are also correlated when seeds are below about 10^4; clean from draw 4. **Generalises, and this is the expensive part: a shared RNG whose early draws are a function of the seed turns "add more variation" into an unwinnable tuning problem in every system downstream.** Any generator that seeds a *set* from adjacent integers and branches on an early draw produces a uniform set, and the symptom is indistinguishable from a logic bug or a missing feature — so it gets attacked in the consuming system, where the fix is not. The pines cost a critic round in tree code that was never at fault. The two confirmed victims, measured: the pines, where draw 1 chose the species for all ten; and the pumps, where the six hose kink phases spanned **7.9% of the 0..2π they were meant to cover** (p ≈ 0.0000) and hose length ran 1.455, 1.471, 1.488 m — **12.7% of the authored 260 mm range, in a monotonic ~16 mm-per-pump ramp** rather than a sample, Spearman 1.000 against pump index. **The single most instructive detail is the decorrelation attempt that silently did nothing:** `hangingHose` was called with `hoseSeed + 7` and `hoseSeed + 19` for the two faces of one dispenser, deliberately, to stop them matching. Because draw 1 is linear in the seed, a difference of 12 moved the kink phase by **0.004 rad — a quarter of a degree.** The two hoses on every pump were phase-locked, and the code that was supposed to prevent it was present, readable and inert. `pumpVariation`'s `seed * 977 + 13` spreading was the same mistake: multiplying does not help when the output is linear in the input. Same shape as case 5 — one shared `noise.ts` defect surfacing as unrelated symptoms in systems that have nothing to do with each other, there dirt and asphalt, here trees and fuel hoses. Fixed by adding `seededRng` to `noise.ts` (murmur3 finaliser on the seed, then eight draws discarded) and pointing the affected sites at it; draw 1 now correlates at −0.007 over 200 consecutive seeds. **Deliberately a narrow fix:** hashing inside `makeRng` would have rerolled every texture and noise field across five systems to fix two call sites, invalidated every archived reference capture at once (case 13) and discarded tuning work two agents did against the current fields, for no visual gain at the ~30 sites measured as unaffected. Three pump hoses of churn to fix three pump hoses. |

| 17 | The bollards rendered with a scatter of small round *blisters* pushed out of the paint. The feature that produced them was authored as dents, was reaching the screen, and was measurably working | Two separate faults that looked like one, and neither was a wiring failure — this is a case 9 relative, not a case 4 relative. **First, the shape was wrong for the object.** `bollardDents` had been given the car's crease rule from case 9 — keep the footprint narrow or the normal barely swings — and produced Gaussian pits about 50 mm across and 15 mm deep, ringed by a raised lip. The rule was right; the analogy was not. A crease is a designed line and needs to be tight; a bollard dent is a bumper flattening 100–200 mm of pipe. The normal swing has to come from the *profile* being flat-bottomed with a steep wall, not from the footprint being small — a super-Gaussian `exp(-s⁴)` over a wide ellipse gives 22–72° of swing where the narrow Gaussians gave 13–19°. **Second, and the actual source of the blisters,** `makeBollardSkin` was independently pushing a Worley cell field into its height map at 0.55 strength, which through `hsNormal` at 1.35 came out as isolated circular normal disturbances roughly 40 mm across. **An isolated circular normal-map disturbance with no silhouette and no cast shadow reads as convex.** Nothing in the image disambiguates a pit from a bump at that scale; the eye defaults to convex, and it defaults there regardless of the sign in the height field. Fixed by demoting that field to albedo only — real relief now lives in the mesh, where it occludes and breaks the outline, which is what settles the ambiguity. **Generalises three ways. (a) A rule derived from one feature on one object is not a rule about features; check that the analogy holds before importing the number. (b) Small circular bumpiness with no silhouette consequence is close to unusable — normal-mapped relief needs either an edge that crosses the object's outline, or a companion in geometry, or the viewer will read it convex and read it as a defect. (c) When two subsystems author the same physical feature — here texture dents and mesh dents — fixing one leaves the other, and the surviving one gets blamed on the code you just changed.** A third, smaller instance of the same double-authoring: the bollard lean existed both as `post.rotation` in `PumpSystem` and, newly, baked into the mesh in `buildBollard`. They added. Worse, `tools/pumpprobe.mjs` measures geometry and could only ever see the baked one, so the instrument would have under-reported the tilt a critic was looking at by roughly a third. Consolidated into the mesh. |

| 18 | Adding the bollard lean silently broke the tool that measures bollard dents, and the broken tool reported *better* numbers | `dentProfile` in `tools/pumpprobe.mjs` measured radial deviation about the world Y axis. A 2° lean on a 0.94 m post displaces each cross-section's centre by up to 40 mm, which enters that measurement as a sinusoid in angle — **twice the depth of the 24 mm dents the function exists to measure.** The first run after the lean landed reported 60 mm dents and a normal swing of 50–55°, both roughly double the truth, and both moving in the direction that suggested the change had worked. Fixed by fitting the post's axis from the mesh (band centroids, least squares) and measuring radius and normals about that instead; the same run then read 12.7–63° honestly, and exposed a genuinely marginal post that the inflated numbers had concealed. A second dilution came out of the same audit: the per-column mean normal was averaged over the full height of the post, so a dent occupying 10% of the height was mixed with 90% plain pipe and its swing under-reported by roughly the duty cycle. **Generalises: a change to the thing being measured can invalidate the instrument, and an instrument that fails this way does not go quiet — it reports a plausible number in the direction you were hoping for. Any probe that assumes a canonical frame (plumb, centred, axis-aligned) must either recover that frame from the data or assert it.** **Addendum, one round later, because the sentence above is half wrong.** Recovering the frame from the data is only safe when the data does not also contain the feature being measured, and here it does: an inward dent removes material from one side of a band, which drags that band's centroid across and tilts the fitted axis. The fit came out **2.4 to 4.7 degrees wrong on a 1.3 to 2.6 degree lean** — larger than the quantity it was estimating — and reported dent depths of 57-74 mm on a post whose outward deformation is clamped to 1.2 mm and whose real dents are 26 mm. It was caught only because a second measurement of the same geometry (the outline envelope) disagreed by 2.5x. `buildBollard` now *returns* the lean it baked and both probes undo it exactly; the centroid fit is still computed, purely so its error can be printed next to the true value. **The rule, corrected: a probe must be handed its frame by whatever established it. Fitting the frame from the same mesh you are measuring is a last resort, and if you do it, cross-check against an independent measurement of the same geometry — two instruments that disagree are how you find out one of them is estimating something it was told.** |

| 19 | The car's front grille and lower intake rendered as a bowtie of bright torn shards for three consecutive capture rounds. The openings were being cut correctly the entire time | Three independent faults in one cut, none of which produced an error, and the decisive measurement separated them in one run: **0% of the upper grille was still covered by fascia, but 1840 reveal-wall triangles were standing inside it.** That pair of numbers says immediately that the hole is fine and the *walls* are the defect — which no amount of looking at the render would have said, and I had already spent a round rewriting the slat geometry on the assumption that the parts were wrong. **(a)** The reveal wall around the opening was emitted unconditionally on the innermost ring (`rr === rings - 2`), because that ring's inner neighbour is the tip fan rather than another ring and the check had no way to ask it. The cap centroid sits inside the grille mouth on this nose, so that put an ~800-triangle collar of 30 mm-deep sunlit wall across the middle of the opening. **(b)** The despeckle pass filled every quad between the lowest and highest cut quad on each angular spoke. Fine for a spoke crossing one opening; catastrophic for a spoke crossing two, where it welded the grille to the intake and took the number-plate panel with it — measured, the intake's top edge ran **150 mm** past where it should have stopped. The same pass also *restored* any cut only one quad deep, which is precisely how an island of fascia gets left floating in a mouth, and each island brings four walls with it: the despeckle was manufacturing the speckle it was named for. **(c)** The angular direction had been refined 4:1 specifically so the cut would be clean, and the radial direction was left at ten rings — about 60 mm of spacing where the grille is. A cut edge's teeth are one ring apart, so the opening was a 60 mm sawtooth on one axis and smooth on the other. Refining the front cap only (the tail has nothing cut in it) took the edges from 60 mm to **4-10 mm** of deviation from nominal. **Generalises: (i) a refinement applied to one axis of a 2D grid is not finished until the other axis is checked — the reason for the 4:1 angular refinement applied verbatim to the radial direction and nobody carried it across; (ii) when a feature looks torn, measure what is *present* inside it and what is *missing*, separately, because 'hole clean, walls wrong' and 'hole ragged' look identical in a render and have nothing in common as fixes; (iii) a cleanup pass that both grows and shrinks a mask can create the artefact it removes — prefer one that only ever moves in the safe direction, here cutting one quad too many, which is invisible behind the backing panel.** |

| 20 | Two instruments lied in this round, in opposite directions, and both were mine. **`tools/carsmoke.mjs` reported 8920 degenerate normals on a body that draws none of them:** cutting the grille and intake orphans every ring vertex inside the openings, `computeVertexNormals` leaves an untouched vertex at zero, and the check counted all vertices rather than the ones the index references. Zero were in use. A tool that cries wolf on correct geometry gets ignored on wrong geometry, which is the whole reason the tool exists. **And the wheels were chased for two rounds as 'brass'.** The albedo was neutralised, the grime dust neutralised, the metalness dropped — and the rim got *warmer and brighter*, because lowering metalness raises the diffuse term and the diffuse term is lit by a 6-degree orange sun. Measuring the rim against its own neighbours in the same frame ended it in one run: tarmac R−B 41, tyre 40, rocker 38, rim 54. Roughly 13 points of the cast were ever the wheel's; the rest was the light, and no change to the material could have removed it. **Generalises: before concluding an object's colour is wrong, measure it against something adjacent in the same frame under the same light. An absolute reading cannot distinguish a warm object from a warm sun, and 'it looks gold' is an absolute reading.** Related to case 18: an instrument that assumes a canonical condition — there plumb, here neutral illumination — must recover it from the data or assert it. |
| 21 | Three fuel dispensers, each built with its own material set from its own seeded `pumpVariation`, reported by the builder as reading "as individual units" and by an independent critic as "three copies of one asset, unambiguously". The variation was real, measured, and reaching the materials | **Amplitude was varying; position was not.** `applyGrime` samples its noise field as a function of **object-space position**, and the three cabinets are the same mesh, so every dirt mark landed on exactly the same square centimetre of all three units. Everything `pumpVariation` fed in — `wear` into `film` and `streak`, `tint` into albedo, `scuff` into the annulus — scaled how *strong* each mark was. Nothing moved where it was. The critic named the tell precisely: *"the same streak falls in the same place relative to the panel edge"* — which is the signature of a shared texture, not of a shared seed. Three units with the same marks at slightly different strengths are indistinguishable from one unit under slightly different exposure, so the more variation was added the more it read as a lighting difference. **The builder's error was measuring the generator instead of the pixels.** A 43.2% spread in hose length and a 37.4% spread in kink phase were both true and both irrelevant to the question being asked. What settled it was a new pose type, `unitN` in `tools/shoot3.mjs`, which puts the camera at the same offset *in each unit's own local frame* so the three frames are pixel-comparable — any pose that sees two pumps sees them at different angles, which buries the comparison under perspective and is why builder and critic could look at one frame and honestly disagree. Measured that way with `tools/regiondiff.mjs`, the structural difference (delta after equalising mean luminance, so a pure sun-angle difference cancels) across the cabinet was **3.03/255, about 1%, i.e. noise.** Fixed with `fieldOffset` and `fieldFlip` on `GrimeOptions` — a per-unit phase into the field, in *tile units* so it is independent of each material's own `scale` — plus two amplitude corrections that the position fix exposed as also being too timid to see: per-unit albedo tint was ±3.5% lightness (raised to ±9%, and hue as well as lightness, since a lighter-or-darker set reads as one object under different exposure), and `film` was linear in `wear` for a 2.6x ratio across the row (squared, for 7x). Same measurement after: **11.22/255 with 100% of pixels changed.** A third contributor was not RNG at all — all three price heads were constructed from the same literals, so they posted the same price with the same grade lit and the same zeroed totals; they now differ by grade, by the residue of the last sale, and one has a burnt-out segment. **Generalises: variation that changes only the intensity of a mark does not make two instances of a mesh look like different objects, and no amount of tuning it will. Vary the phase. And when a builder and a critic disagree about whether two things look alike, the builder is measuring the generator and the critic is measuring the render — build the pose that makes them comparable rather than arguing from the data.** |
| 22 | Case 21 was not a pump problem. `applyGrime` is shared, and an audit of every mesh that draws it found **three more sets carrying byte-identical grime: the car's four alloy rims, its four wheel centre caps, its four tyres, and the four bollard feet.** Measured as the mean absolute difference of the actual field lookup over corresponding surface points, 0..255: **0.00 for every pair in all four sets.** Not "similar" — the same numbers. For scale, the properly phased dispenser materials measure 33-53 on the same metric, and the pump cabinets that a critic called "unambiguously one asset" measured 3.03 | **The general rule: per-instance variation has to move *where* features are, not just how strong they are.** Amplitude-only variation is indistinguishable from an exposure difference, so a set varied only in strength reads as one object photographed under slightly different light — and it reads that way *no matter how large the amplitude spread is*, which is why case 21 survived several rounds of "add more variation". Position is what the eye uses to decide whether two things are the same object. The car case is worse than the pumps were: all four wheels share one material, so they have no per-instance variation of any kind, not even the ineffective amplitude sort. **The scope is exactly one helper, and that is worth knowing precisely** rather than assuming it is everywhere. `vGObj = position` in `hardsurface.ts` is the only raw object-space varying in the project; `buildingWeather`, `buildingCoursing` and `worldDetail` all build theirs as `modelMatrix * position`, i.e. **world** space, which is immune by construction — two instances at different world positions sample different field whether anyone thought about it or not. `carGrime`'s `aWeather` is a baked smooth radial ramp with no pattern to repeat, so sharing it across four wheels is correct. So the building, the terrain and the vegetation were never exposed, and no agent needed to be sent to look. **And measuring is what kept the list honest in both directions.** A topology-only check flagged the four bollard *posts* as well, on the reasonable-sounding grounds that four near-identical 1 m posts must sample near-identical field. Evaluating the lookup said 35.7-38.4 — genuinely decorrelated, because three distinct heights plus a baked lean move corresponding surface points into different tiles. That would have been a false positive sent to an agent as a defect. The inverse also showed up: the two tyre tread phases, which exist specifically to differentiate the wheels, move the grime by only 3.23 — the same figure the critic called one asset. A variation that is real in the generator can still be below the threshold where it does any work. |

| 23 | 22 panel plates were added to the dispenser cabinet to turn every shut line into a real 3 mm recess. `tsc` clean, the plates present in the merged geometry, triangle count matching the layout arithmetic exactly — and **not one shut line existed in the render.** Worse, the forced-value test that exists to catch precisely this reported that the feature was fine | Two things, and the second is the transferable one. **The mechanism:** `THREE.ExtrudeGeometry` with `bevelEnabled: true` and `bevelOffset: 0` does not bevel the authored solid — it *grows the body contour by `bevelSize`* and returns to the authored outline only at the caps. Adding a 5 mm edge chamfer to `chamferPrism` therefore moved the cabinet skin from \|z\| = 0.360 to 0.365, while the plates stayed where they were authored at 0.363, so every plate was **inside** the box it was supposed to stand proud of. The fix is `bevelOffset: -bevelSize`, which puts the body back on its nominal contour and insets the bevel toward the caps; verified by measuring the bounding box at three bevel sizes. Anything that extrudes to a spec dimension and then adds a bevel is exposed, and nothing in the type system or the render says so — the object just quietly gets bigger. **The trap, which is new: forcing two coupled quantities in the same direction cancels, and the forced diff then reads as evidence of health.** The presence test forced the chamfer from 5 mm to 30 mm *and* the plate relief from 3 mm to 20 mm in one build. Both grew, so the cabinet went to 0.390 and the plates to 0.380 — still buried — and the region diff duly reported 8.4% of pixels moved by a mean of 2.5/255, which looks exactly like a feature that is present and merely subtle. **A forced-value test is only valid if the forced knob does not also move the reference surface the feature is measured against**; force one thing at a time, or force them in opposite directions. Two further notes on why this took so long. **A cross-build A/B has no clean control in this repo:** the same run's deliberately-unaffected `ground_control` rectangle moved by a mean of 25.6, because another agent's system changed between my two builds. Any conclusion drawn from a delta smaller than that was unsupportable, in either direction. And **the instrument that settled it was a screen-space one, not a capture.** `tools/seamprobe.mjs` casts rays from the exact camera `shoot3.mjs` builds for a `localTo` pose into the exact geometry `buildPump` returns, and reports per pixel column which material slot is hit and how far outboard it sits — so "is there a plate-gap-plate crossing where the joint is authored" becomes a countable integer. It read 0 gap runs before the fix and 3-4 after. This is the same class as case 22's lesson from the other side: there the generator was measured when the pixels were the question; here the pixels were too polluted to measure, so the question was moved into screen space without leaving the CPU. |

| 26 | Every `envMapIntensity` in the project had been inert since the day IBL landed — 148 materials across five systems, spanning 0.07 to 1.7, all of them rendering at exactly `scene.environmentIntensity`. The environment lit every object correctly, `renderer.properties.get(mat).envMap` was truthy, nothing threw, and multiple agents had spent rounds tuning the number. At least one critic complaint ("lamp lenses don't separate from the paint", "wheels read flat") traces to it | In three 0.185.1 the per-material value is only pushed into the uniform behind a guard on the material's *own* map — `WebGLMaterials.refreshUniformsStandard`: `if ( material.envMap ) { uniforms.envMapIntensity.value = material.envMapIntensity; }`. Every material here inherits from `scene.environment` and has `material.envMap === null`, so that branch never runs. **The half of this that the first diagnosis missed, and that matters for the fix: the uniform is not merely left at its declared default of 1.** `WebGLRenderer.setProgram` has the complementary branch — `if ( ( material.isMeshStandardMaterial \|\| ... ) && material.envMap === null && scene.environment !== null ) m_uniforms.envMapIntensity.value = scene.environmentIntensity;` — which overwrites it *every frame* with the scene-wide value. It looked like a stuck default only because `scene.environmentIntensity` happens to be 1 here. So a naive fix that assigns `material.envMap = scene.environment` and stops there silently kills `?env=`, `?lforce=noenv` and `?lforce=env8`, which are the lighting system's own knobs, and does it in exactly the same way: no error, scene still lit. Fixed in `src/systems/lightEnvBinding.ts`, owned by `LightingSystem` because it owns the PMREM: it assigns the environment onto every `MeshStandardMaterial` in the scene from `scene.onBeforeRender`, keeps the authored value, and writes `authored * scene.environmentIntensity`. Deliberately a shared mechanism rather than a line in each system — this bug exists precisely because the correct-looking thing (authoring the property) silently did nothing, and an opt-in fix has the identical failure mode for the next system. Three details worth keeping: for a `MeshStandardMaterial` the assignment is otherwise a no-op (`setProgram` resolves `material.envMap \|\| materialProperties.environment` to the same PMREM, `envMapRotation` falls from `scene.environmentRotation` to `material.envMapRotation` and both are identity, and the program cache key does not move, so nothing recompiles and no `needsUpdate` is needed); the binder must re-bind on every environment rebuild or materials hold a disposed texture, so `setEnvironment()` syncs before it returns; and it must treat any value it did not itself write as a *new* authored value, or it would revert `tuneInteriorMaterials` and anything else that retunes a material later — which would be this bug's mirror image. **Generalises, and this is the part worth carrying: a property that is only refreshed when a related field is non-null will silently keep its default, and the object will still look plausibly lit, so authored values can be inert with no error anywhere. Close cousin of case 7** — there a uniform missing on the JS side read as zero in GLSL; here a uniform present on both sides is simply never written from the place the author was writing to. Both are invisible to `tsc`, to the linker, and to the render. The distinguishing question to ask of any such guard is **whether the gate is the same thing as the enabler**: `if (material.aoMap)` gating `aoMapIntensity` is safe because no aoMap means there is no occlusion to scale, but `if (material.envMap)` gating `envMapIntensity` is not, because `scene.environment` enables the effect without satisfying the gate. `tools/envbind.mjs --systems ...` audits the live scene for the rest of that family and currently finds none. |
| 24 | A four-layer horizon treeline asserted, on every build, that each band was lighter and bluer than the one in front. The assertion passed for three consecutive rounds while three independent critics described "a continuous dark brown-to-black silhouette", "one flat cutout", and "the furthest element in frame is the darkest and most saturated thing in the scene". Both were true at the same time | **Two independent faults with one symptom, and the assertion could not have caught either.** **(a) The colours were authored as display tones and converted as if they were.** The file described its own values as "0.043 luma" and handed them to `new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)`, which converts display-referred to linear: sRGB 0.046 is linear **0.0036**, thirteen times darker than the number written. Measured in the rendered pixels, the four bands came out at display luma **30-57 against a sky of 140-166** — correctly ordered, and all four crushed into the bottom fifth of the scale. The material is `MeshBasicMaterial` with baked vertex colours, so the value written *is* the pixel and there was no shading to disguise it. **(b) The skyline was drawn by a different term from the one being tuned.** `radiusVary` wobbles each sample's *distance* by up to ±17% of the band radius, and apparent angular height is height/distance — so on its own it swings apparent height by **1.40x**, against the **1.50x** contributed by the entire height field, and it does it with two sinusoids at 2.3 and 5.9 cycles per revolution: feature widths far wider than a frame, roughly eight extrema across a wide shot. That is ridge-scale undulation, i.e. the "eight or more discrete conical peaks plus a broad flat-topped butte" a critic counted. Three rounds were spent re-weighting the noise spectrum in the height field while this line owned most of the silhouette. Fixed by scaling height by `r / radius`, which makes apparent height exactly independent of the wobble; measured effect, the skyline went from stepping 0.89 px per column to 2.45 px. **The transferable rule, and the reason this case is here: an assertion that a set of values is *ordered* is a true statement about the wrong quantity.** Ordering survives any monotonic transform, so it cannot detect the entire range collapsing toward one end — and a colour-space conversion is exactly a monotonic transform. **Anything whose job is a tonal relationship must be asserted in output pixels, not in authored values.** `tools/vegband.mjs` now measures rendered sky-versus-band contrast off the capture and fails a band below display luma 60; the authored-value check was demoted to structural (the colours are now derived by interpolating toward the sky, so a further band *cannot* be darker) since it can no longer fail and no longer implies anything. Second half of the same lesson, in the opposite direction and nearly a self-inflicted wound: **two successive large cuts to the band colour moved the measured value by 0.2 of a display level, and the obvious reading — a third "authored value not reaching the screen" bug — was wrong.** A CPU dump of the merged geometry's `color` attribute (`tools/vegcolour.mjs`) showed the values were correct and present, and a `vforce=magenta` capture showed they reached the screen. The measurement was simply too insensitive: it averaged across the full frame width, where four bands at different distances and two near pine crowns all contribute, so a large change to one contributor moves the mean very little. **A whole-frame average is not a control for a feature that occupies part of the frame — the same trap as the 1.53% whole-image diff that nearly hid a missing feature, arrived at from the aggregation side rather than the area side.** |

| 25 | `?vforce=nohorizon` was typed where the flag is `?vforce=noline`. The unrecognised token was ignored in silence, the capture came back **byte-identical to the baseline**, and that was read as strong evidence that the horizon band belonged to another system. It did not — it was the only thing on the horizon | The forcing hook built `new Set(query.split(","))` and tested membership with `force.has("noline")`, so an unknown member is simply never consulted. No throw, no warning, no diagnostic. **This is worse than a hook that fails, because a hook that fails is noticed. A hook that accepts a typo returns a perfectly clean negative result, and a clean negative result from a forced-value test is the single most persuasive artefact in this project's whole verification vocabulary** — the discipline in this file rests on "if forcing it to an extreme does not move pixels, it is not wired up", and a silently-ignored token satisfies that test's precondition while telling you nothing. It manufactures a confident wrong conclusion and costs a capture round to unwind. Fixed by validating every token against the known set and throwing, which `Game.ts` surfaces in `__SYSTEM_ERRORS` and the capture harness treats as fatal. **Generalises to every harness here, not one system: any hook that selects behaviour by string — force flags, preset names, shot names, probe modes, `?query` parameters — must reject an unrecognised value rather than default to inaction.** Two sibling instruments in the same round were also lying and are worth recording as the same family: a "MESA" check compared band heights against `(hMin + hMax) / 2 * 1.12` and counted everything above it, which is not a plateau but "how much of the range is in its upper half", so it fired on a perfectly healthy 22% and would have been chased for another round; and a skyline-roughness metric keyed off a fixed luma-step threshold, which makes it silently contrast-dependent and therefore not comparable across any change that alters tone. **A metric that fires on correct output is worse than no metric, and a metric whose reading depends on a variable it does not report is worse still.** |
| 27 | Case 24 fixed the treeline and left three siblings. An audit of every numeric colour literal in `src/` found the **identical** defect at `vegGround.ts:80-81` (the needle-duff mats under every pine, `DUFF` and `DAMP`) and `vegWire.ts:120` (`uBase`, the overhead conductors): dark values handed to `setRGB(..., THREE.SRGBColorSpace)`, landing **12.8x, 12.2x and 12.6x** darker than written. All three are unlit — two vertex colours on a `MeshBasicMaterial` at alpha 0.5-0.85, one written straight to `gl_FragColor` — so, as in case 24, the value written *is* the pixel. Through ACES at exposure 1.25 they render at **0, 1 and 1 out of 255**, against 30, 45 and 40 if tagged linear. The duff mats are currently dark holes under every pine rather than brown litter | **The audit's most useful output was the negative half: this is confined to vegetation, and for a structural reason worth knowing.** All 114 `new THREE.Color(0x...)` sites are safe *by construction*, because `setHex` defaults to `SRGBColorSpace` — a hex literal always means what the person who picked it expected. The texture pipeline is likewise clean: all five generators route through one helper taking an explicit `srgb` flag, every `map:` passes `true` and every normal/roughness/gray map passes `false`, both `CanvasTexture` sites set `SRGBColorSpace`, and `siteOverlay`'s `NoColorSpace` is correct because its four channels are masks rather than colour. **So the exposure is not "colour space" broadly — it is three's asymmetric defaults.** `setHex` and `setStyle` default to sRGB; `setRGB`, `setHSL` and therefore `new THREE.Color(r, g, b)` default to **workingColorSpace, i.e. linear**. A hex literal is always right and a numeric triple is only right if the author meant linear. The single idiom that produces this bug is a numeric triple plus an explicit `SRGBColorSpace` — the argument that *looks* like diligence is the one that destroys dark values, because sRGB decoding divides by up to 12.9 near zero and by almost nothing near one. Which yields a **mechanical, intent-free detector**: flag a literal tagged `SRGBColorSpace` whose largest component is below ~0.12. That found all three and nothing else. **Two review rules fall out that are cheaper than any probe.** First, *adjacent terms of one expression must share a space*: `vec3 c = uBase + uGlint * spec` had `uBase` tagged sRGB and `uGlint` tagged `LinearSRGBColorSpace` two lines apart, which is wrong on sight without knowing either value — the author knew the distinction existed and applied it to one of two terms in the same sum. Second, **a ratio must never be transfer-encoded.** `STRAW`/`SAGE` (`VegetationSystem.ts:779-780`) are per-instance tint *multipliers* tagged sRGB; a brightness check clears them, since STRAW's luminance moves 1.00x — but its R:B goes 1.28 to 1.74, **36% warmer**, because a power curve does not scale components equally. A multiplier tagged with any transfer function is wrong in hue even when it is right in level, so brightness-based checking cannot find it. Finally, on sequencing: **all three broken sites are unlit, which means they are exactly the ones `envMapIntensity` (case 26) does not touch**, and nothing anywhere compensates for them — the duff alpha is 0.5-0.85, not reduced to hide a too-dark colour. So this is the rare colour fix that is safe to land while reflectance is being retuned underneath everyone, and fixing it does not require unpicking a compensation. |


| 28 | **Three capture rounds in a row were reported "verified in pixels" and three independent critics, reading the PNGs in those exact round directories, reported the defect fully present.** The suspicion was staleness: a harness photographing a bundle it had not built, or the stable-copy step writing an old image into the archive. It was neither. **The captures are honest and the instruments were measuring the wrong axis of the right frame** | Established by reading the PNGs off disk with `pngjs` and comparing against what the owning agents reported. `shots/system6/rounds/2026-08-28T174415Z-f3ccdfca121f/wide.png`, averaged over columns 100..900: rows 270-284 run **R−B +9 to +11** (warm ground), rows 288-304 run **R−B −5 to −2**, rows 320-360 run **+14 to +21**. A cool strip roughly twenty rows tall, sandwiched between warm ground above and warm ground below — which is exactly the "cold blue band that reads as water" two critics described, present in the file the agent said proved it fixed. The staleness hypotheses were all checked and all cleared: the round's `bundleHash` `f3ccdfca121f` and `bundleMtime` `23:12:28` reproduce **exactly** from `.shot-build/system6/` today; every archive PNG is byte-identical to its stable copy, so the copy direction is right; no harness can serve the shared `dist/` — all six build into a private `.shot-build/<system>/` and `preview()` is pointed at the same directory; and every pixel instrument in `tools/` (`vegband`, `regionstat`, `regiondiff`, `edgeread`, `vegprobe`, `probe-column`, `diff`) reads the saved PNG with `pngjs`. **No agent measured in linear space, at a different resolution, or before tone mapping.** The leading hypothesis was wrong and the frames were right. **The mechanism is `tools/vegband.mjs`, and it failed in two independent ways at once, both of which are about *what* is measured rather than *where the pixels came from*.** **(a) Region.** It finds the skyline as the topmost strong downward luma step per column, which in any frame containing a pine, a pole or a parapet is the crown, not the horizon; on `edge.png` only **47%** of columns put the skyline within 10 px of the modal row, so every mean it prints is a blend of tree pixels and horizon pixels. On `wide.png` the detection is good (81%) and the tool still passed, because of (b). **(b) Axis.** Every assertion in it is luminance. It reported `sky 156.6, band 99.6, contrast 57.0` and fired no warning, and all three numbers are true — the band is well lit and correctly ordered against the sky. **"Reads as water" is a hue statement, and nothing in the whole toolchain asserted hue anywhere.** The tool even prints a `b/r` column that goes 0.913, 0.899, 0.892, 0.911, **0.970, 0.992** as it descends into the band, and asserts nothing on it. This is case 24 repeated exactly one axis over: case 24's lesson was "assert the tonal relationship in output pixels, not in authored values", the fix asserted it in output pixels, and it asserted the wrong channel. **Generalises, and it is the sharpest form of this project's most common failure: moving a check into pixels is only half the job — the other half is checking the axis the viewer is reacting to. A number can be measured off the correct file, in the correct space, at the correct resolution, and still answer a different question than the critic is asking.** Fixed by adding `tools/framescan.mjs`, below. |

| 29 | The same vegetation round reported "a ground layer extending to 380 m" and "124 mid-storey plants at 0.75-4.1 m". The critic reported vegetation "stops dead past about 30 m" and "nothing at 1-4 m anywhere in six frames". Both are correct | `tools/vegscatter.mjs` and `tools/vegprofile.mjs` build the generator on the CPU and count `sites()`. They are counting **the point set**, over the whole 380 m site, in metres. The critic is counting **what covers pixels in one frame**, which is the subset inside the frustum, above the horizon cull, and large enough to survive sampling at its distance. Those two numbers are allowed to differ by two orders of magnitude with nothing wrong on either side, and they did. This is case 21 and case 22 for the third time — the builder measures the generator, the critic measures the render — and the reason it keeps recurring is that the CPU probes are *cheap and correct*, so they get run, and the frame-space question has never had a tool. `framescan`'s DEAD ZONE test is the beginning of one: on `horizon.png` it reports rows 458-473 carrying detail **0.46 against 1.70** in the sixteen rows nearer the camera — a step rather than a falloff, which is what a cull distance looks like and what a real receding ground layer never looks like. **Rule: a count of instances is not a claim about a frame. If the claim is "it reaches 380 m", the measurement has to be taken in a frame that contains 380 m, along the axis distance runs in that frame.** |

| 30 | Auditing the capture pipeline for case 28 found the archive itself sound and its *convenience path* quietly re-creating case 13 | Four defects in `tools/archive.mjs`, none of which had bitten yet and all of which were one ordinary afternoon away from doing so. **(a) The stable directory has no provenance.** `shots/system6/` held `horizon.png` from 23:15, `horizon_nohz.png` from 21:38 and `edge_noscrub.png` from 18:33 — three different bundles, in one directory, indistinguishable by inspection. The archive is stamped and the stable copies are not, so a critic handed `shots/<system>/*.png` is looking at several builds at once, which is case 13 verbatim, arriving through the path the case-13 fix created. **(b) A round refreshed by a run that *failed* is indistinguishable at the stable path from one that passed.** `shots/system6/approach_lineonly.png` came from a round whose manifest says `outcome: "failed"` and whose `__VEGETATION` reported nothing built. Nothing at the stable path says so. **(c) Pruning could delete a round while a critic was reading it.** `keep` is 10 and `shots/system6/rounds` was sitting at exactly 10, with rounds landing five minutes apart; the two rounds named in this audit were two capture runs from deletion. A critic quoting a round id while an agent captures the next one is the *normal* case here. **(d) The round id is time-plus-hash, so two runs of the same bundle in the same second collide, and `mkdir { recursive: true }` merges them** — one directory, two runs' PNGs, one manifest, and no way to tell afterwards. Fixed: the stable directory now carries `stable.json` recording round id, bundle hash, capture time and outcome per stable filename, written on every save and stamped with the verdict at finalise; pruning refuses to touch a round younger than 45 minutes or one containing a `KEEP` file, and now *names* what it deleted and what it spared, because "the round I was told to look at is gone" is otherwise indistinguishable from "the agent gave me the wrong id"; a colliding round id gets a `-2` suffix rather than merging. And one addition that is a diagnostic rather than a fix: **`finalise` byte-compares every capture against the same name in the previous round and records `identicalToPreviousRound` in the manifest, warning on the console.** Identical pixels do not prove staleness — an unchanged scene renders the same twice — but they are the one cheap observation that separates "my change did nothing to the pixels" from "my change did not reach the pixels", and neither the bundle hash nor anything else in the manifest could tell those apart. |

| 31 | Rendering the real scene into the PMREM — the fix for a lower hemisphere that was one constant colour — put **1814 non-finite pixels into the environment cube, which the GGX filter smeared into 17892 poisoned PMREM pixels**, and blacked out the lower two-thirds of every frame in every other system. Three agents held their rounds. `__SYSTEM_ERRORS` stayed **empty** throughout, three separate guards passed, and the failure presented as four different plausible bugs in four other people's code | **The interesting part is not the NaN, it is that this defect was detected and then published anyway.** The guard existed, fired, printed an accurate count of the non-finite pixels to the console — and then fell through to `scene.environment = built.texture` and installed the poisoned cube, because the guard had been written as a diagnostic rather than as a gate. A guard that reports and does not reject is worth less than no guard, because the console line scrolls past while the artefact ships with the authority of having been checked. **Three properties made this near-undiagnosable from outside, and all three are general.** (a) *A poisoned environment blacks out direct light too.* NaN propagates through the whole fragment, so the sun term dies with the ambient term, and the frame looks like a lighting failure rather than an environment failure. (b) *It spares exactly the materials that would exonerate it.* The sky dome is a `ShaderMaterial` and the distant backdrop is `MeshBasicMaterial`; neither samples `scene.environment`, so both render perfectly. The vegetation agent measured its sky as **byte-identical** across the regression — 135.8 both rounds — while its lower third went 24.2 → **exactly 0.0**. A frame with a flawless sky and a dead ground does not look like one bug. (c) *The statistics that were supposed to catch it were structurally blind to it.* The per-face mean and standard deviation skipped non-finite samples — the obvious and otherwise-correct way to write that loop — so a cube with 1814 NaN pixels reported a healthy mean, a healthy standard deviation, and a peak finite channel of 94.7, which actively argued *against* an HDR overflow. **`meanLuminance > 0` has now failed to catch two distinct real defects in one day**: a constant-colour hemisphere (case 28's sibling) and this. Both passed it cleanly, because a constant is non-zero and a mean over the finite subset is non-zero. The lesson is not "add a NaN check", it is that a summary statistic is the wrong instrument for a validity guard: the mean is a *property of the population that survived measurement*, and the failures that matter are the samples that did not. Assert the property you actually depend on — every pixel finite, the lower hemisphere varying — and make the assertion refuse to publish. The secondary lesson is about defaults: an in-flight change to shared state must be **opt-in**, because the cost of the wrong default is not the owner's round, it is every other agent's |

| 32 | `?solo=` and `?skip=` — the isolation flags that exist so an agent can capture its own system while someone else's is throwing — **manufactured failures in the systems they had just excluded**. `?solo=lighting,terrain` produced two entries in `__SYSTEM_ERRORS`, `player.update` and `interaction.update`, both `Cannot read properties of undefined`, naming two systems that were never asked to run | `Game.start()` filtered which systems receive `init()`, but `Game.frame()` iterated **every registered system**, so a skipped system had `update()` called on the first tick with none of its own state built. The general shape is worth more than the bug: **a facility that suppresses part of a lifecycle must suppress every phase of it, and the phase that gets forgotten is the one in the hot loop**, because `init` is written once in a function you are looking at and `update` is dispatched from a loop you are not. What makes it costly rather than annoying is *where the false positive lands*. Every harness in this project gates on `__SYSTEM_ERRORS.length === 0`, correctly and on this document's advice — so the flag whose entire purpose is to unblock a capture could never be used by any harness that took the advice, and it failed by **inventing** faults in innocent code rather than by hiding real ones. An agent meeting this cold has every reason to believe it has broken two other people's systems. Two corollaries. (a) *A diagnostic facility needs the same evidence as a feature.* This one was never checked against the channel it feeds; "the page still loads" was the whole test, and the page did still load. (b) *An unrecognised token in a debug flag must be fatal.* `?solo=terrian` selected zero systems and rendered an empty scene in silence, which is case 25 again — the same defect, in the mechanism built to work around the defects |

| 33 | The two-light-angle test for the mortar joints — "do the joints look different under raking light than under flat light" — came back **inconclusive twice**, and the second attempt was carefully done. The instrument folds a rectangle of pixels at its own dominant period; the periods it autodetected were 39-61 px, which were read as "not corresponding to coursing" and the run was discarded. The regions had also caught the access ladder, a conduit run, runoff streaks and the storefront glazing | **No rectangle in that frame could have worked, and that is a property of the frame rather than of anybody's coordinates.** Ray-casting the pose and asking for the largest axis-aligned rectangle containing nothing but one elevation of exterior masonry returns **128 x 896 px on the lit elevation — 1.2 head-joint periods wide.** A fold needs three whole periods; there is no rectangle in the frame that is three head periods across on *either* elevation, because the glazing, the ice machine, the conduit and the ladder cut every wide band of block. So the choice was never between good coordinates and bad ones: **any rectangle large enough to fold necessarily contained something that was not the feature.** Worse, the discarded periods were partly right — the projected 0.2032 m bed course measures **61.39 px** on the lit elevation and 58.84 px on the shaded one, so "39-61 px" was the mullion spacing *and* the real coursing, indistinguishably. An autodetected period cannot tell you which of two coincident signals it found, and a mixed region guarantees there are two. **The constructive half, which generalises well beyond masonry: when a feature's position is computed by the shader from world position, the phase is not a mystery to be recovered from the image — recompute it.** The replacement (`tools/probe-jointphase.mjs`) casts a coarse ray grid to classify pixels by which surface they belong to, **erodes that mask by one cell** so no sample is within 8 px of anything that is not the feature's own surface, intersects each pixel's ray with the surviving cell's plane analytically, and then evaluates the *identical* phase expression copied line for line out of the fragment shader. There is no period in pixels, no perspective error, no autodetection, and the sample is 283,136 verified pixels per elevation instead of a chosen rectangle. Head-joint contrast came out **39.16% lit against 10.28% shaded, ratio 3.81** against a 1.26 baseline. Two design notes that are the difference between this and another flattering probe. **(a) It prints where the minimum lands.** The joint minimum sits at phase 0.96-0.00, i.e. exactly on the unit boundary where the shader puts it — that single number is what says "I am measuring joints" and it is precisely the assurance a fold cannot give. **(b) It carries a decoy.** The same pixels are binned against a period at 0.63 of the unit, non-harmonic so a real joint cannot leak into it; that is the region's own noise floor, and it read 8.40% on the busy lit wall against 0.71% on the plain shaded one. A signal that is not several times its own decoy is not a measurement. **Corollary about erosion specifically:** every region-selection failure on this project has been a contamination failure, and the general fix is not better coordinates but a mask with a margin. Vegetation and Pumps both lost regions to this on the same night. |

| 34 | Two hypotheses for a band of hard-edged black rectangles in the storefront glazing — "an unlit object" and "a shading failure" — have opposite fixes, and looking at the image cannot separate them. Three earlier guesses at the responsible material were all wrong, and one probe returned "nothing here but the glazing" because it honoured `material.side` and skipped every back face | **An impossible *distribution* identified it in one measurement, and it did so without any theory about materials at all.** The band was **34.7% exactly `rgb(0,0,0)` with literally nothing in luma 1..15** — bimodal with an empty gap. No unlit object can produce that, because an unlit object still carries fog, haze and a little sky and therefore *fills* the low teens; only a clamp writes exact zero and leaves the band above it empty. That one observation skipped the entire material argument and pointed straight at the shading path, where a three-measurement ladder (`DoubleSide` to `FrontSide` 22.7%, roughness map off 11.8%, transmission off entirely **0.0%**) named three's transmission render target. **The generalisation worth keeping is about the shape of the evidence: a value that is *impossible* beats a value that is merely *surprising*, and distributions carry impossibility where means and extremes do not.** A mean of 40 in that band is consistent with a dozen explanations; an empty histogram bucket between two populated ones is consistent with about one. When a defect resists identification, look for a statistic that some hypotheses cannot produce at all rather than one that ranks them. **The second half is about who chooses the region.** The fix was verified with `tools/probe-band.mjs`, which takes a rectangle from the caller — fine for confirming a known location, and exactly the failure mode this document keeps recording, because *an agent who picks the coordinates picks them where it already believes the defect is*. So the durable instrument is `tools/probe-zeroscan.mjs`, which **takes no coordinates**: it counts exactly-black pixels over the whole frame, counts the luma 1..15 population immediately above them, reports the ratio between the two, and reports connected components of the black set with their bounding boxes and how completely each fills its own box — because a compact component that fills its bounding box is a rectangle somebody drew and a straggly one is a genuine dark crevice. It moved `interior.png` from **20590 exact zeros in 41 components, largest 8688 px filling a 267x78 box, tail/zero ratio 2.21** to **326 in 2 components, largest 53 px, ratio 127**. It carries `--selftest` with both controls: a planted clamped-black rectangle that must be reported and a fogged unlit object that must not. **It is shared tooling and nothing about it is masonry- or building-specific** — a clamped-to-black region is a whole-project failure mode, so run it over any round before a critic sees it. |

| 35 | The first-person view spawned **upside down** — "head is down, legs are up" — and stayed that way. It survived every verification this project has ever run, because every one of them was a `?shot=` preset capture, and a preset makes `PlayerSystem` disable itself and hand the camera to `applyShot`. The interactive spawn path had never once been exercised. Throughout, `camera.up` read exactly `(0, 1, 0)` | `PlayerSystem.update()` writes the head-bob sway straight onto an Euler component, `camera.rotation.z = bobX * 0.35`, every frame — and the camera was still on three's default `XYZ` order. **In `XYZ` the `y` term is recovered through an `asin` and is therefore confined to ±90°.** The spawn yaw is about 141°, which that order cannot express directly, so three decomposes the perfectly upright `lookAt` pose as `x = -3.1291, y = -0.6747, z = -3.1338`: a pair of near-π terms that cancel each other out. Zeroing `z` for the bob removed one half of the cancelling pair and left the camera rolled 180° about X. `bobX` is 0 while standing still, so it fired on the very first `update()`, before any input, and re-fired every frame afterwards — including immediately after `PointerLockControls` wrote a fresh quaternion — so this was "inverted permanently", not "inverted until the first mouse move". Fixed by setting `camera.rotation.order = "YXZ"` before the camera is first posed, while the rotation is still `(0,0,0)` so the change is a no-op rather than a reinterpretation of existing angles. **Two things generalise, and the first is the reason this is in this file.** (a) *A correct-looking invariant can be preserved while the orientation is still wrong.* `camera.up` was `(0,1,0)` the whole time and was never going to be anything else — `up` is an **input** to `lookAt`, not a readback of the resulting orientation. The quantity that was actually wrong is the derived one, `new Vector3(0,1,0).applyQuaternion(camera.quaternion)`, which read `(0.000, -0.9999, -0.0125)`. Any invariant check must assert the *derived* quantity rather than the field the author set, and even then it is not a substitute for looking at the frame: the decisive evidence here was the top screen band measuring luma 18.8 against 123.2 at the bottom — sky underneath ground. (b) *Assigning a single Euler component is only meaningful if you control the rotation order.* `rotation.z = k` is a roll assignment in `YXZ` (or `ZXY`) and an arbitrary reorientation in `XYZ`, whose magnitude depends on the current yaw — which is why this was invisible at small yaws and catastrophic at 141°. **And the reason it hid for so long is worth stating on its own: a fixed camera preset bypasses the controller entirely, so an entire class of defect — everything the player controller does to the camera — is structurally invisible to `tools/shoot.mjs` and to every probe built on it.** `tools/walkprobe.mjs` boots the page with no query string at all and asserts on the derived up vector, roll about the view axis, the NDC of world-up and world-down through the render matrices, and the rendered band luminance. **Second instance, different system, same structure and no bug involved.** The storefront glazing was given a Fresnel-coupled transmission leaf, so the pane occludes more as the view goes oblique. Schlick puts the visually decisive part of that curve past about 78 deg, and the most oblique pane in any fixed pose in the set is nearer 65 deg — so the mirror regime is real, is the whole point of the change, and **no camera this project can capture will ever show it.** What the fixed poses could show was the derivative rather than the effect: the same flat pane measured at both ends of its run gave a delta rising from -1.63 to -9.93 luma, a six-fold variation across one plane, which a constant is arithmetically incapable of producing. That is the general move when the regime is out of reach — **stop trying to photograph the effect and measure a quantity the null hypothesis cannot produce** — but it is a proof of mechanism, not a proof of appearance, and the appearance still has to be verified by the walk probe on the approach to the door. The lesson is not about cameras being upside down. It is that **a fixed set of poses defines what can be found, and any behaviour whose interesting range falls outside it is invisible to every gate built on that set** — whether the cause is a controller the presets bypass or an angle the presets never reach. |

| 36 | A collision probe reported **"solid geometry stopped the player at the shop front"** — cleanly, plausibly, with the player halting at `z = 31.180` against a wall plane at 31.5 — in a build where `PlayerSystem` contained no collision code of any kind | The probe called `building.collide(camera.position)` once per frame to ask "is the player inside solid geometry". **`building.collide` does not answer that question; it pushes the point out of the blocker, in place, and returns whether it had to.** So the instrument was performing the very resolution it was testing for, and then reporting the result as an observation about the code under test. The only thing that gave it away was the stopping distance: 31.180 is exactly `31.5 - 0.32`, the wall plane minus that function's own default radius argument — a number that has no reason to appear anywhere in a system that does not call it. A frame trace confirmed `z` frozen at 31.180 with W held and forward `(0,0,1)`. Fixed by querying a throwaway clone; the player then walks straight through the wall from z = 30.00 to 33.58, 68 frames inside a blocker, and ends up standing inside the store clipped through the shelving. **Generalises: a predicate that mutates is a command with a return value, and nothing in the name will warn you.** `collide` reads as a question, `groundHeight` reads as a question and is one; the difference is only in the body. Before an instrument calls a service, establish whether it is a query or a command — and treat any service taking a mutable object (a `Vector3`, a `Box3`, a material) as a command until the source says otherwise. The sharper form: **an observer that writes to the thing it observes reports the state it created, not the state that existed**, which is the measurement-side twin of case 31's guard that reported without refusing. Both produce an artefact carrying the authority of having been checked. |

| 33 | The car's grille edge was read as blocky and torn for **four** capture rounds. Three of those rounds were spent inferring the cause. Each hypothesis was correctly ruled out by a correct measurement — the hole is within 10 mm of spec, the cap is 48 rings by 528 spokes, the projection fallback counters are zero — and the culprit was never named. The part built specifically to cover that edge, an analytic rounded-rect surround lapping over the ragged cut, **had never drawn a single pixel** | `endFrame`'s triangle indices were one step out of phase with its own loop orientation, so **every triangle of both surrounds faced away from the camera** and the whole part was back-face culled. Nothing else was wrong with it: it was in the merged geometry, `tsc` was green, `carburied` passed it, and it measured **2.5 to 4.0 mm proud of the rendered fascia with not one vertex buried**. What the eye had been looking at the whole time was the raw quad-level staircase, uncovered. **Winding has no representation in any check this project had.** It is not a type error, not a link error, not a fallback, not an arithmetic error, and every positional test returns the right answer — the part is exactly where it should be, facing the wrong way. It is also invisible in a capture, because "drew nothing" and "drew something subtle in a dark recess" look identical. **What ended it was refusing to reason a fourth time.** Every candidate surface was given a flat, unlit, `toneMapped: false` colour behind `?cardebug=front`, so the pixel value in the PNG *is* the authored hex and "which surface owns this pixel" became an exact byte match rather than a judgement (`tools/carlabel.mjs`). The frame answered in one capture: zero pixels of surround anywhere, and 134 + 226 places where the eye met bare fascia directly against the backing panel. After the fix, 17159 + 23253 pixels of surround, and the fascia-to-backing contacts fell to **3 and 0**. **The same probe then found four more parts in the same nose that had never drawn a pixel**, all by the same underlying mistake in a different guise: the front number plate (both pieces, 65 of 65 vertices each, 22.0 and 6.0 mm inside the bumper), both fog lamps (100 of 100 vertices each, mouth 8.4 mm in and tail 95.1 mm in) and the chrome bar over the grille (57 of 57, exactly 10.0 mm in). **A negative offset from a surface is only a recess if something has removed the surface in front of it.** The grille backing sits 52 mm behind the fascia and reads as a recess because there is a cut aperture in front of it; the identical idiom at the plate, the fog lamps and the caprail — where the bodywork is solid — is not a recess, it is burial. Five parts, one nose, all silent. **Two rules.** *(a) A test that measures a part against the surface it was built from can only return the offset it was handed.* `carburied` compares against `endZ`, and every one of these parts is authored as `endZ(...) + off`, so it was checking the arithmetic, not the geometry. `tools/carframez.mjs` casts a ray at the **triangulated** shell instead, consults no analytic surface anywhere, and reports the area-weighted face normal alongside — because burial and inverted winding are the two ways a correct part draws nothing and they are indistinguishable from a render. *(b) When three rounds of inference have each been correctly ruled out, the next round should not be a fourth hypothesis.* Make the frame answer the question directly. Flat-colouring costs one throwaway capture and is decisive where every measurement taken so far had been true, precise, and about something else |

| 34 | The four tyres measured a **median display luminance of 0.0 across 105416 pixels**, interquartile range 0.1 — not dark, clipped. Every piece of sidewall relief, bead ring and lettering added over several rounds was being added to a surface that renders as a hole | `makeTyreSkin`'s albedo, measured off the actual texture, is **0.0060 to 0.0086 linear, mean 0.0070** — the whole map, tread and sidewall together. The comment at the consuming site read "0.055 (tread) to about 0.09 (dusty sidewall), which *is* carbon black", and it is right that those numbers look like carbon black: they are the authored **display** values. The map is correctly tagged sRGB, so 0.055 display decodes to 0.0043 linear. Real carbon-black rubber is about 0.04 reflectance, so the tyre is roughly **six times** under. This is case 27's family with the colour-space tag *correct* — nothing is mis-decoded; the value was simply chosen as though a display number were a reflectance. **The mechanical detector from case 27 cannot see it**, because that screens literals tagged `SRGBColorSpace`, and there is no tag here to be wrong: it is a texture generator writing bytes. The general form: **a "this is what carbon black looks like" number picked by eye is a display number, and reflectance is not.** Anywhere an albedo is authored as a small fraction and consumed as linear, the two differ by up to 12.9x, and the error is largest exactly where it is hardest to see. Also worth recording: the arch liner, at a *lower* albedo (0x0d0e10) and a *lower* `envMapIntensity` (0.28 against 0.42), renders **27x brighter** than the tyre in the same frame. Lifting the albedo 5.4x moved the tyre's median only 0.0 to 1.1, so albedo was necessary and is not sufficient, and the remaining factor has not been identified. Do not accept the liner as evidence about the tyre's light: `CarSystem` adds the liner with a bare `new THREE.Mesh` rather than through its `add()` helper, so **`receiveShadow` is false on it and true on the tyre** — a surface deep inside a wheel arch is taking the direct sun term unoccluded, which is most likely why it is the brightest thing in the arch and brighter than the body panel it is recessed behind. **RESOLVED, and the resolution changes the lesson.** The albedo was fixed at source by the pumps agent, who owns `hardsurface.ts`: the authored values were written to bytes and handed to an sRGB-tagged `DataTexture` without being encoded, and now go through `linearToSrgb`, moving delivered reflectance from 0.0070 mean to **0.0781 mean, range 0.0704–0.0910** — exactly the 0.055–0.09 the call site had always claimed. The car-side 5.4x compensation was removed the same hour; stacked on the corrected map it would have produced a light grey tyre. **The rest of that file audited clean, and why is the part to remember: the bollard palette measures 0.2744 linear and is *correct*, because it was arrived at by iterating on renders and is therefore already display-referred.** A palette taken from physical reference is linear and must be encoded; a palette tuned by eye against renders already has been. **The two are indistinguishable in source**, which is why the audit measured delivered reflectance rather than reviewing code, and why "fix it consistently everywhere" is the wrong instinct here. All twelve non-colour maps in that file are correctly tagged `NoColorSpace`. **And the albedo was never the dominant term.** On the corrected map — eleven times the old reflectance — the tyre's median moved only 0.0 to 3.1. What settled it was a control that changes one thing: `?cardebug=tyrelit` puts a plain 0.5-albedo rough dielectric in the tyre's exact mesh, in the same pose, with the same shadow flags. It rendered at a median of **68.1**. Light was reaching the arch in abundance the whole time. 68.1 against 3.1 is 63x the radiance for 6.4x the albedo, so roughly **10x was the material throwing light away**, and the largest single piece of it was `envMapIntensity: 0.42` — a number that is not a measurement of anything, since a rough dielectric does not reflect less of its surroundings than it reflects. Restoring the physical default of 1.0 took the tyre from 3.1 to **10.7**. The generalisation: **when a surface is too dark, a control that substitutes a known material into the same mesh separates "no light arrives" from "this material discards it" in one capture, and no amount of adjusting the suspect material can.** |

| 37 | `const WALK_SPEED = 1.4; // m/s, unhurried walking-sim pace` sat at the top of `PlayerSystem`, and the player walked at a measured **1.07 m/s** — 24% slow, for as long as the controller has existed. Three lines below the integrator sat `if (this.velocity.length() > WALK_SPEED) this.velocity.setLength(WALK_SPEED)`: a clamp that **could never once have fired** | The integrator was `v += dir * ACCEL * WALK_SPEED * dt` and then `v *= 1 - DAMPING * dt`, whose fixed point is `ACCEL * WALK_SPEED / DAMPING` = 9 × 1.4 / 11 = 1.15 m/s in the continuous limit, and lower still once discretised at 60 Hz. `WALK_SPEED` was never a speed. It was a scale factor on the acceleration, and the identifier, the comment and the unit all said otherwise. Nothing threw, nothing looked wrong, and the scene walked at a plausible pace. **Three things generalise.** (a) *A constant that names a quantity has to be tested against the quantity, not read alongside the code that consumes it.* Every one of those three lines is individually correct; only their **fixed point** is wrong, and a fixed point is not visible in any single line, so no amount of careful reading finds this. The test is one line in a harness — walk for three seconds and divide — and it did not exist because nobody had ever walked. (b) *An unreachable guard is evidence, and this project has no way to notice one.* `setLength(WALK_SPEED)` was dead code for precisely the reason the bug existed, so the one construct in the file that encoded the author's intent correctly was also the one that could never assert it. This is the mirror of case 31: there a guard fired and published anyway; here a guard would have done the right thing and was never reached. Both leave a reader more confident than the code deserves, and **an assertion that cannot fail is indistinguishable from one that passes**. (c) *Fixing the constant broke a second number that had been tuned against the wrong one.* Head-bob phase advances with **distance**, not time — cadence is `speed * BOB_RATE / pi` — so the authored 5.4 gave a correct 1.84 Hz at the 1.07 m/s the controller actually achieved, and a 2.41 Hz trot the moment the speed was right. Any value dialled in by eye against a broken input silently inherits the breakage, and **correcting the root cause is the event that surfaces it**; when you fix a number, re-measure everything that was tuned while it was wrong. **Same family as the dispenser dent half-width found by Pumps in this same round**, where sound physical reasoning was implemented at two to three times the value it justified, and as cases 17 and 18 before it: in all of them the reasoning in the comment is correct and the number beside it is not, so reviewing the prose cannot find it — only measuring the produced quantity can. |

| 38 | The sequel to case 31, and the answer to it. The NaN that poisoned the environment cube, blacked out every `MeshStandardMaterial` in the scene and cost the better part of a day across six agents was described throughout as **intermittent**. It was not. It was present in **55 of the 56 clump geometries** `src/gen/vegScrub.ts` can build, on every run, deterministically — and it had been on screen, harmlessly, for the entire life of the project | See the three sections below. The one-line cause: `buildClump` shades its cards with `Math.pow(t, 0.55)` where `t = Math.min(1, y / h)`, clamped above but **not below**, and `t` is very slightly negative on the base row of nearly every card |

| 39 | The storefront glazing's environment reflection had been **anti-correlated with viewing angle** for the whole life of the material: measured against a control with the reflection forced off, it contributed **+3.1 luma head-on and −0.7 at grazing incidence**. No reflection can do that. Glass reflects *more* at grazing, which is the one thing about glass everybody already knows | One number was doing two jobs. Under alpha blending `gl_FragColor.rgb` is multiplied by alpha on the way into the framebuffer, so `opacity: 0.24` was scaling the environment reflection *and* the show-through together — but a reflection is **added** to what is behind the glass and does not attenuate with how transparent the glass is. The angle dependence then came out backwards for a second reason stacked on the first: `specularIntensity: 1` takes a `1 - F` bite out of the diffuse term, and at grazing `F` is large, so the material lost more transmitted light than the attenuated specular put back. **Two things generalise.** (a) *A parameter that scales two independent physical quantities cannot be tuned, and tuning it is how you produce values that measure nothing* — every attempt to show more interior removed more sky, and both directions felt like progress. The fix is architectural, not numerical: the reflection became its own additive leaf, black diffuse, `AdditiveBlending`, sharing the pane geometry, and `specularIntensity: 0` on the transmission leaf so `opacity` means one thing. Do the separation **before** touching the number, and keep the number identical across the change, or you cannot tell the architecture from the tuning. (b) *Ordering an additive layer is not a detail.* Alpha over additive gives `(bg + refl) * (1 - a) + tint * a`, which is the original bug reintroduced and looks almost right; additive over alpha gives `bg * (1 - a) + tint * a + refl`. **The most useful diagnostic here cost nothing, and it is the part that generalises furthest: a quantity whose sign is wrong is a far stronger signal than one whose magnitude is wrong — and a single-angle measurement of an angle-dependent quantity cannot produce it.** One angle showed +3.1, which is small but positive, entirely plausible, and would have been reported as "the reflection is a bit weak, try raising `envMapIntensity`". The wrongness only exists *between* two viewing angles, so no measurement taken at one of them contains it, however carefully that one is made. **The rule: when a quantity is a function of some parameter — angle, distance, time of day, light direction — measure it at two values of that parameter and check the derivative, not the level.** A wrong level is a number you argue about; a wrong sign is a proof. This is the same move as the two-light-angle mortar test in this system and the lit-versus-shaded elevation control that validated it, and it applies to anything with a known monotonicity: reflections against angle, texture detail against distance, shadow contrast against sun elevation, wear against height above grade. Pick the pair first; a single sample of a function is not a measurement of the function. |

| 40 | An `envMapIntensity` was authored at 0.5, with a paragraph of correct reasoning beside it, **one hour after its author had read case 26 and written a warning about exactly this**. It had no effect whatsoever | **There are two ways an authored value can be wrong, and they need different defences.** Case 26 is the first: an **inert uniform**, where nothing reads the value at all — three only refreshes `envMapIntensity` when `material.envMap` is non-null, so materials inheriting from `scene.environment` ignored whatever was written. This is the second: a **live uniform owned by another system**, where the value is read perfectly well and then overwritten. `tuneInteriorMaterials` walks the building for a set of *mesh names* and assigns `envMapIntensity = interiorEnv` to their materials, and the material in question is drawn by a mesh in that set. The binder then adopts the overwriting value as the authored one, so the override is permanent rather than first-frame, and no capture at any time would show the authored value doing anything. **Generalises past env maps: a material property is owned by whoever writes it last, and in a multi-system scene that is not necessarily the system that created the material.** The practical difference between the two kinds is that **only the second one survives a grep.** An inert uniform has no other writer to find, so searching the tree tells you nothing and the only detection is a forced-value diff — set it to something absurd and see whether the frame moves. An overwritten one has a second writer sitting in the source with the property name in it, so `grep -rn envMapIntensity src/` finds it in ten seconds. Do both, in that order of cost: grep first for other writers, then force a value and re-capture if the grep is clean. The alternative is a plausible number with a plausible justification that survives review indefinitely, because everything about it reads as deliberate. The corollary for reviewers is worse: **a wrong value written by someone who has just read the warning about it is indistinguishable from a right one**, so the defence has to be mechanical rather than attentive. |
| 41 | An independent critic reading rendered frames said the block courses "repeat visibly across the wall at a period of a few blocks". The measurement that was supposed to have settled that question had returned **-0.09 and +0.06** — nothing. Both were right | The test was a correlation at a **single lag of four blocks**, chosen because the albedo tile is about four blocks wide. The tile is 1.63 m and the masonry unit is 0.4 m, so the tile is 4.075 units and the real repeat landed at 89 px against a lag-4 test sitting at about 98 px — far enough off to read as noise. **A lag test expressed in one coordinate system cannot find a period expressed in another, and a single material routinely carries both.** Here the shader indexes per-block variation by world block index while the albedo map repeats in metres; the two share no common lag except by coincidence, and nothing warns you which one your chosen lag is in. The generalisation is not "sweep instead of sampling" — it is that **a correlation at one lag answers "does it repeat at exactly this spacing", which is a different question from the one an observer looking at a picture is answering.** An observer sees *whatever* repeats. So ask their question: `tools/probe-period.mjs` high-passes every row to kill the shading gradient, then sweeps every lag from 2 to 160 px on both axes in every horizontal band, and reports the strongest peaks with the caller supplying neither the lag nor the region. It found the vertical course repeat at 13 px as the fundamental (correct, that is one course) and the horizontal tile repeat at 89 px, r 0.143, subordinate to the per-block variation at r 0.213 — which is why the wall does not look banded up close and does at the critic's distance. **When a measurement and an observer disagree, the most likely explanation is not that one is wrong but that they asked different questions**; on this project that has now been the answer three times running. |
| 42 | An emissive modulation map for the ceiling troffers bound correctly, ran 0.60 to 1.00 with a perimeter floor of 0.45, and produced a capture **indistinguishable from the flat lens it replaced** — 4.77% of the ceiling above display luma 250 against 4.78% before. Nothing was wrong with the texture, the UVs, the material or the binding | Lighting drives those fittings at `emissiveIntensity` **2.4**, so the map's floor of 0.45 was **1.08 in scene-referred linear**, and everything from roughly 1.0 upward tone-maps into the top two or three display codes. The map was doing exactly what it said and the tone curve was throwing all of it away. **A modulation map is only visible where the product of map and intensity lands on a part of the tone curve that still has slope.** Deepened to a 0.10 floor — which is also the more physical value, since a prismatic lens genuinely does tuck dark under the pan flange — the same map moved 45716 pixels, 3.18% of frame, max channel-sum delta 512. **This is a different failure from a map that never binds, and it produces a byte-for-byte identical symptom**, which is why it deserves its own entry rather than a line under case 26: the defences do not overlap. A binding failure is found by grepping for other writers and by forcing an absurd value; this one survives both, because the value *is* being read and an absurd value would have shown up fine. It is found by multiplying your map's range by the intensity somebody else owns and asking where that lands on the curve. **Generalises to every map that modulates a quantity another system scales** — emissive, envMapIntensity, light colour, exposure. If you do not own the multiplier, you are authoring against a curve you have to go and read first, and "subtle" and "absent" are the same screenshot until you do. |
| 43 | A milky wash lay over the whole shop interior seen through the storefront. Traced by suppressing one layer at a time from a fixed camera: with the glazing present the frame read **black point 70, range 139**; with it gone, **13 and 238**, against 22 and 232 for a camera genuinely inside the shop. **Every attempt to tune it out had failed, and necessarily so** | Alpha blending computes `bg * (1 - a) + tint * a`. **Those are two different physical quantities.** `1 - a` is **transmittance**; `tint * a` is a **veil added on top**. Glass has the first and does not have the second — a pane attenuates what is behind it, it does not add a flat lit surface to it. With a non-black diffuse the veil term put a constant floor under every pixel behind the glazing, which is exactly a black point of 70 where the scene's own is 13. And it was **untunable by construction**: lowering `opacity` to shrink the veil also stopped the pane attenuating anything, so every value was a compromise between two things one number was doing, and no value measured either. **The fix is to remove the term, not to balance it: set the diffuse to black and alpha blending collapses to `bg * (1 - a)`, pure transmittance, with the black point preserved *exactly* because zero times anything is zero.** `opacity` then means `1 - transmittance` and nothing else; re-derived on that basis it went 0.24 and 0.13 to 0.055 and 0.035, combined transmittance 0.661 to 0.912, and the measured black point over the glazing footprint fell 87 to 48 with range rising 167 to 188, at zero cost in draw calls, textures or triangles. **The general result is the symmetry, and it is not about glass.** The reflection leaf on the same panes has black diffuse so that *additive* blending can only carry reflection; this one has black diffuse so that *alpha* blending can only carry transmission. **Each blend mode expresses exactly one physical process once the term it cannot express is removed from it** — additive cannot express attenuation, alpha cannot express addition, and a leaf that tries to carry both carries neither correctly. Anyone compositing a material out of multiple leaves can apply this directly: name the one process each leaf is for, then zero whatever the blend mode cannot say. **A footnote on metrics, because this defect scored well on one of the ones detecting it.** The veil was a *bright* constant, so it pushed pixels past a "fraction above display 224" threshold that the fix then removed — `over 224` moved the wrong way while black point and range moved monotonically with the fix. A defect that partly satisfies a metric measuring it is close to the worst case for measurement-driven work, and the discrimination is to check which metrics move monotonically with a change you can force on and off. |
| 44 | Terrain published `groundAccum`, and Building consumed `fines(x, z)` the way the service documents — "the right thing to multiply a dirt overlay by". The wall base then measured a **mean delta of 5.3 luma in the *cleaning* direction**: consuming the service made the wall cleaner than the local model it replaced, which is the opposite of the intent and would have been reported as "landed, subtle" by anyone not checking the sign | **The range of a published field is part of its contract, and a bare multiply silently assumes that range is 0..1.** `fines` is genuinely 0..1 *by type* but on this site it measures **0.11 to 0.21 along the front elevation and 0.013 to 0.047 behind the building** — the field's own `(1 - swept * 0.85)` term, correctly reporting that a forecourt is swept clean by tyres and feet. Multiplied into a 0.34 coverage that gives a peak of 0.033, a 3% tint, and there is nothing at the call site to reveal the assumption. The consumer's job is not to multiply, it is to **decide whether the field should gate the feature or modulate it**, and that is a physical question the publisher cannot answer: splash is rain bouncing off paving, and rain bounces off swept paving just as hard — what varies is how much loose matter it lifts. So the right composition was a floor plus a gain, normalised against the range the field actually reaches: `mix(0.5, 1.35, clamp(fines / 0.22, 0, 1))`. That reads 0.5x on the swept forecourt and 1.35x in the sheltered back corner, and the whole point of consuming the service survives, because **what reads is the wall being dirtier where the ground beside it is dirtier, not any absolute value**. Same round, same shape: the fix took the changed-pixel count from a 5.3-mean cleaning to a 6.95%-of-frame change with **95,174 of 100,148 changed pixels darker**, monotonic in the intended direction. Two general defences. **Print the field over the region you will consume it in before wiring it to anything** — a twenty-line CPU probe found this in one run and no capture would have, since the symptom is a feature that quietly fails to appear. And **check the sign of a consumed term against a control**, because a service integration that reduces the effect it was meant to strengthen is indistinguishable, in a single frame, from one that is merely subtle. Related: case 42, where a modulation vanished into the flat part of a tone curve — same symptom, different mechanism; there the range was crushed downstream, here it was never what the consumer assumed. |
| 43 | The canopy fascia — the swept ring that carries the whole silhouette — was wound **inside out**, with a geometric face normal of **+0.999 in Z on the −Z run** where it must be −0.999. It was caught before any capture existed, by an assertion written specifically to look for it | **This is the second instance of case 33 in one night, in a different system, from a different cause, and the two together settle what the defence has to be.** Car's was `endFrame`'s indices one step out of phase with its own loop orientation; this was a profile written in the natural reading order — bottom to top, outer face first — where `sweepProfile` winds its quads in the direction the profile is *traversed*, so the natural order is the wrong one and nothing in the signature says so. Neither cause is detectable by reading the source: both look right, and in this case the *same* helper produces correct windings for `TerrainSystem`'s island because its profile happens to run the other way. **The asymmetry that makes this class expensive is that an inverted surface is invisible rather than wrong** — back-face culling removes it, and "drew nothing" is pixel-identical to "drew something subtle", so the defect survives review indefinitely and the eye ends up diagnosing whatever was *behind* it. Car spent four rounds, three of them on hypotheses correctly ruled out by correct measurements of the wrong thing. **What changed here is the order of operations: `probe-unseen` finds an inverted part after the fact, and a face-normal assertion refuses to let one be built.** The assertion is six lines and needs no render — take the triangles on a face whose outward direction you know analytically, compute `(b−a)×(c−a)`, and require the mean to point outward. It runs in `tools/probe-canopy.mjs` on every invocation, alongside the same test applied to the soffit (must face −Y), the roof (+Y) and the fixture lenses. Two practical notes from writing it. *(a) Do not average over a closed volume* — the first version tested the lens box's mean face normal, got exactly 0.000 by construction, and reported a failure that did not exist; select the face you mean, by centroid within the lowest slice of the part's own height, and area-weight so a bevel's many small triangles do not outvote the flat face they surround. *(b) The vertex normals are not an independent check* — `computeVertexNormals` derives them from the winding, so they agree with it and always will. Assert the geometric normal, then assert the shipped one agrees, and understand that the second test catches a later mutation rather than the original mistake. |

Case 38 is the most expensive defect this project has had and the general shape is new to this catalogue, so it gets three sections rather than a table cell.

#### 38a. A defect can be present on every run and still look intermittent

**If a fault's visible consequence depends on a downstream stage that only sometimes samples it, the fault will present as intermittent no matter how deterministic it is.** That is the transferable lesson and it is worth more than the clamp.

Here the chain was: NaN in a vertex colour → NaN fragment → **discarded by the rasteriser, costing nothing** → unless that fragment happens to land in a texel of a 256² cube capture → in which case the PMREM's GGX filter spreads it across a neighbourhood of every mip → and every material sampling `scene.environment` renders black, direct sun term included. Only the last two links are visible, and whether they fire depends on the capture point, the cube resolution, and whether the card survived alpha test — none of which are properties of the bug.

So the observable was **two stages downstream of the fault**, and its frequency was a property of the sampling, not of the defect. Chasing frequency was chasing the wrong variable.

The corollary is a rule about where to look: **an intermittent symptom arising from deterministic code means your measurement is too far downstream. Move the measurement, do not gather more samples of the symptom.** Every hour spent re-running captures to characterise "how often" was an hour not spent asking what was in the buffer.

The second corollary is about latency: **a latent non-finite value has no cost at all until something integrates over it, and then it has unbounded cost.** "It doesn't show up in the frame" is not evidence that geometry data is clean. This project has several systems feeding data into things that filter, convolve, mip or capture — the PMREM, the shadow cascade, every generated texture with mipmaps, the transmission render target — and **each of those turns a locally-invisible bad value into a global one.** Validate the inputs to those stages rather than guarding their outputs.

#### 38b. The specific hazard: `translate` on a symmetric geometry does not cancel in float32

Worth knowing on its own, because it is a one-liner that looks exactly like correct code:

```js
const g = new THREE.PlaneGeometry(w, h, 1, 2);
g.translate(0, h / 2, 0);        // bottom row is now ~ -1e-8, not 0
```

`-h/2 + h/2` is not exactly zero in float32 for most `h`. The result is a value that is **mathematically zero and numerically slightly negative**, and then:

- `Math.pow(t, fractional)` → **NaN**
- `Math.sqrt(t)` → **NaN**
- `Math.log(t)` → **NaN** (or `-Infinity` at exact zero)
- `t ** 0.5` in GLSL, and `pow()` in GLSL, are formally **undefined** for a negative base — which means the driver may give you NaN, zero, or something else, and the answer may differ between the software rasteriser and the NVIDIA driver, exactly as in case 4.

**Clamp to the domain of the function, not to the range you were thinking about.** `Math.min(1, x)` was written by someone correctly worried that `t` could exceed 1 — the actual risk was at the other end, and the author had no reason to suspect a coordinate they had just constructed to be zero. Prefer `clamp01` over a one-sided `min`/`max` whenever the value feeds a fractional power, a root, a log, or a `normalize`.

#### 38c. How it was found, since the method generalises

Four steps, and the last three are the transferable ones.

1. `tools/envnan.mjs` bisected by `?skip=`/`?vforce=` down to a system.
2. `src/systems/lightEnvCulprit.ts` (`?envculprit=1`) bisected the scene **by visibility** down to one mesh and then one instance. Two design points: it tests "show only this subset", never "hide this subset", because showing proves the subset is sufficient *on its own* whereas hiding only proves it necessary given everything else; and it carries **two controls** — the full scene must poison the cube and the all-candidates-hidden scene must not — so a predicate stuck on true reports BROKEN instead of walking confidently to an arbitrary leaf.
3. Its **ablation table**. With only the culprit drawn, switch off one material feature at a time and re-measure. `noVertexColors` was the only row of seven that read 0. **Naming the mesh had not been enough** — at that point it was still four plausible bugs in three people's files, with different owners and different fixes.
4. Its **attribute scan**. CPU-scan every buffer the culprit draws from: `color: 48 of 198 floats non-finite`, with position, normal, uv, instanceMatrix and instanceColor all clean. That converted a GPU bug into a CPU one, and `tools/clumpcolor.mjs` now reproduces and regression-checks it in about a second with no browser and no GPU.

**One cheap measurement upstream beat every downstream refinement.** Splitting `FaceStat.bad` into `nan` and `inf` cost four lines and killed the half-float-overflow theory in a single run: all 129 bad pixels were NaN, zero were Inf, peak finite channel 221 against a ceiling of 65504. Without it the next round would have gone into clamping the capture — a fix for a bug that did not exist. **Count failures by kind before theorising about their cause. "Non-finite" is two different bugs with two different fixes wearing one name.**

| 39 | The handover entry for a "capture-time shadow refit blacks out the scene" bug read, flatly: *"This, not the NaN, is what produced 'ground darker as it gets closer to camera'"*, with a mechanism, a radius (80 m) and a suspected gating condition. When the NaN was actually fixed, **the shadow-refit bug did not reproduce at all** | There was most likely never a second bug. A poisoned environment blacks out every `MeshStandardMaterial` while unlit geometry and the sky dome keep rendering perfectly, which presents *exactly* as "the ground is fully shadowed out to the shadow-fit radius" — and the shadow refit was the plausible-looking thing on the same code path. Measured same-build, same-pose, world capture on versus off: lower-third mean luma **24.5 vs 24.8**, 20.4 vs 20.5, 17.5 vs 17.8 on three poses. **Two process points, and they pull in opposite directions, which is the whole content of this entry.** (a) *A hypothesis recorded in the confident voice becomes a finding for the next reader.* Nobody was going to re-derive that sentence; it would have been inherited, and the eventual bug hunt would have started from a mechanism that does not exist. When you write down a diagnosis you have not verified in pixels, write it in the voice of a hypothesis, and when you later find it was one, **go back and change the wording rather than only appending the correction** — an appended note at the bottom does not reach someone who stops reading at the confident sentence. (b) *But do not close it either.* Three non-reproducing poses on one build is not a disproof; it is an absence of evidence over a narrow sample, and the honest state is "unfalsified", not "fixed". The entry stays open with the measurement attached and a trigger written down — if pure-black lower thirds return, check `badCube` in `__LIGHTING.worldEnv` **before** re-opening the shadow theory. **The general rule: downgrade the claim, keep the entry.** A defect that has stopped reproducing for a reason you have not established is a different thing from a defect you have fixed, and the catalogue is worth less if the two are recorded the same way. |

| 41 | The doorway was too tight, so the player was allowed to shrink from a 0.32 m body radius to 0.20 m "whenever the wide radius is blocked and the narrow one is completely clear" — phrased, and believed, as a rule that could only fire in a gap it could actually fit through. It fired **against every flat wall in the scene**, and the player crept 120 mm closer to all of them | Standing 0.25 m from a featureless wall also satisfies "clear at the narrow radius". There is no gap there; the condition simply cannot tell a gap from proximity, and once it is true on one frame the player advances and it is true again on the next, so the effect is not a relief at a threshold but a **new, smaller radius everywhere**, arrived at by ratchet. The lesson is about the shape of the mistake rather than the geometry, and it generalises past collision to anything conditional: **a relief intended for particular places must be addressed to those places, not inferred from a local condition that those places happen to satisfy.** The doorway satisfies "wide blocked, narrow clear" — that is what made the condition look like a description of the doorway. It is not a description of anything; it is a property the doorway shares with every wall in the scene, and when you write the condition you are picturing the motivating example rather than the set. Ask of any predicate standing in for a place: *what else satisfies this?* If the answer is "most of the world", the predicate is a coincidence at the one site you tested it. The fix was a `portals` list on the collision contract: the doorway declares itself, and the radius is a function of **where the player is** rather than of whether the last test failed. Worth noting how it was caught, because it was not caught by looking: an existing assertion pinned the stop distance at the wall to `0.32 m` *exactly*, and it went red on the same run. A tolerance of "within 100 mm" would have passed a 120 mm regression, and nothing about the doorway — which now worked — would have suggested anything else had changed. That is the part worth carrying: **a fix that works can hide a regression it caused.** The change was assessed against the thing it was for, the thing it was for got better, and the evidence of collateral damage was a number on the other side of the scene that nobody had any reason to re-read. Success on the target is not evidence about anything else, and the louder the success the less anyone goes looking. **An invariant is worth pinning to the exact number the moment you know it, because its whole job is to fail when some unrelated change moves it — and it can only do that job if the tolerance is tighter than the damage.** |
| 42 | An independent critic called two of the walk probe's four reference frames **broken**: one washed to a flat milky cream with no shadow anywhere in it, the other with the page's own "Click to look around / WASD to walk" HUD baked across the middle. Both were the harness's fault, and neither was a rendering defect | Two separate mistakes in one capture call, and the second is the more general. **(a)** Playwright's `locator("canvas").screenshot()` photographs *the page, clipped to the canvas box* — it does not read the canvas. Every DOM element overlapping the viewport is therefore in the file, and `#hud` had been in the middle of every reference frame the harness ever produced. Suppress the UI, or read the drawing buffer; do not assume an element screenshot is an element. **(b)** The washed frame was named `inside-shop.png` and was taken **outside the building**. The capture fired wherever the previous test happened to leave the player, and the previous test was an aiming sweep whose last run failed to get through the door — so the camera was pressed against the storefront glazing, looking in. Nothing was wrong with the shop; the same view with the glazing suppressed has a black point of 13 against the veiled frame's 70. **A filename is an assertion, and it is the only assertion in a test harness that nothing checks.** Every number in this probe was measured, bounded and re-derived; the one claim carried in pure prose was wrong for the life of the tool, and it was wrong in the direction that mattered because a reviewer with no access to the source has nothing *but* the filename to tell them where they are standing. The fix is to make the capture take the camera pose as a required argument and refuse to fire without one, which turns the name into something the code has to satisfy. **(c)** A smaller note on method: the veil was attributed by suppressing one layer at a time and re-measuring, and the leading hypothesis going in — that the two `AdditiveBlending` reflection passes were setting a floor under the frame, since additive cannot darken — was **wrong**, and measurably so: removing them changed the black point **by zero**. Not by less than expected; by nothing. The mechanism was the plain alpha tint and the grime layer. This is the useful kind of wrong, and worth distinguishing from the usual kind: **a specific mechanism that predicts a real effect and delivers exactly none of it is far more informative than a vague suspicion that delivers something.** "Additive cannot darken, so it must set a floor" is true as physics and still did not apply, because at the near-normal incidence that camera sits at the Fresnel term is correctly near zero — so the reasoning was sound, the passes were innocent, and a null result of exactly 0 said both at once. A vague hypothesis could not have been refuted like that; it would have absorbed the result. Prefer the hypothesis that can produce a zero, and pay the one run it costs to find out. |

| 40 | **Anything you assign to `material.envMap` is silently reverted, every frame, unless the material is excluded from `EnvironmentBinding`.** Assign it in `init`, capture five minutes later, and the frame you measure was rendered with `scene.environment` instead — no error, no warning, and the material still has an environment so nothing looks broken | `EnvironmentBinding.bind()` ends with `if ( m.envMap !== this.texture ) m.envMap = this.texture;`, unconditionally, for every `MeshStandardMaterial` in the scene, driven from a scene `onBeforeRender` hook. It has to be unconditional to do its own job, which is why this was not an oversight. **The irony is the whole point of this entry and is worth stating plainly: that binder exists because `envMapIntensity` was inert project-wide (case 21) — authoring it did nothing, because three only refreshes that uniform for a material that owns an `envMap`, and every material here inherits `scene.environment` instead. The fix for one silent failure became the cause of the next one.** A facility that enforces an invariant across every object in the scene is, by construction, a facility that overwrites anyone who has a legitimate reason to differ, and the first such person will not be told. `EnvironmentBinding.exclude(materials)` is now the supported way to own a different environment — the interior irradiance probe is the first caller — and `envBinding.excluded` is reported so the count is visible in `__LIGHTING`. **Call `exclude` *before* the assignment, not after: the binder runs from a render hook, so a single frame between the two is enough to lose it.** The general rule for this codebase: before assigning any material property in a system that is not that property's owner, check whether something is enforcing it globally. `envMap`, `envMapIntensity`, `fog` and `toneMapped` all currently have an owner that will win. |

Case 40 came out of a false positive that is worth its own paragraph, because the measurement did not merely fail to catch it — **the measurement actively endorsed it.**

The interior bounce was A/B'd against a live control on one build, with a whole-frame instrument written specifically to distinguish the fix from the obvious wrong fix. It reported a large improvement of exactly the predicted shape: the dark tail lifted 14.5x more than the lit end moved, comfortably past the 3x bar the tool was given. Every part of that was true. It was also **not the feature being tested** — the probe had been reverted, and what actually improved the frame was the interior materials landing on the *world* environment at the probe's intensity of 1.0 instead of their authored 0.25. A flat ambient lift, which is precisely the failure the instrument was built to reject, slipped through it because the world environment's contribution indoors happens to be low-frequency and dark, and therefore happens to be tail-weighted too.

Only reading `EnvironmentBinding` caught it, and only because of an unrelated worry about whether the binder might fight the assignment.

**The lesson is narrow and should be applied literally: "the number moved in the right direction, by roughly the right amount, with the right shape" is evidence that *something* changed. It is not evidence that *your change* caused it.** This project's standing advice — force the feature to an absurd value and diff (case 21's preamble) — does not catch this either, because the absurd value propagates into whatever is actually reaching the screen. What does catch it is asserting that the mechanism is *in place at capture time* rather than at assignment time: the report now carries `envBinding.excluded` and `interiorProbe.applied`, and a future round can assert that a sampled interior material still has `envMap === probe.texture` in the captured frame. **Verify the wiring in the same frame you verify the result, or you are testing the scene's behaviour rather than your change's.**

### The `skyRadiance` service, and why it is a function and not a colour

`LightingSystem` publishes `game.provide("skyRadiance", ...)`. Any system that
fades distant geometry toward "the sky" must read it rather than hold a sampled
constant, because **this sky has no single colour**. The dome's azimuthal term
scales the warm band from 0.055 away from the sun to 0.675 toward it, and the
aureole adds more on top. Measured off the service's own horizon ring, blue/red
at 1 degree of elevation runs:

| azimuth | 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315 |
|---|---|---|---|---|---|---|---|---|
| blue/red | 0.889 | 0.889 | 0.870 | 0.642 | **0.349** | **0.340** | 0.627 | 0.866 |

A factor of 2.6 between the sun side and the far side, with the sun at azimuth
−157 degrees. That is why case 28's cool band survived a fix: vegetation
converged its bands toward a constant sampled from poses that happened to face
the cool side, so on any sun-facing pose the bands sat cooler than the air they
were dissolving into. **Publishing a single colour from Lighting would have
reproduced the identical bug at a different azimuth** — the mechanism is the
snapshot, not whose snapshot it is.

Shape, and the parts that are contract rather than convenience:

- `at(dir, out?) -> Color` — radiance from `dir`. `atHorizon(azimuthRadians)`
  and `horizonToward(dir)` sample 1 degree above the skyline, which is the
  value distant geometry should converge toward.
- `colourSpace` is `"linear-srgb-scene-referred"`. **Not display sRGB and not
  tone mapped.** Stated on the object so a consumer cannot get it wrong by
  assumption; cases 24 and 27 were both this confusion inside one file, and it
  is worse across a system boundary.
- `horizonElevation` is 1 degree, not 0. At exactly h = 0 the dome begins
  mixing toward `uGround`, so sampling the seam returns a value contaminated by
  the ground-bounce term.
- `gpuAgreement` and `verified`. The service is a **CPU port of a fragment
  shader**, and ports drift. `verifySkyRadiance` renders the real dome from 18
  directions into an 8x8 half-float target at init and compares; worst relative
  error is currently **1.4%**, and a failure pushes to `__SYSTEM_ERRORS` rather
  than handing out a plausible wrong colour. This is the direct defence against
  cases 21, 22 and 29 — a CPU probe and the GPU render answering different
  questions while both look right. Nothing else in the project compares them.
- The port deliberately excludes the sun disc, its smear, and the stratus
  layer. The disc is a 1-degree feature at radiance 3.7 and would swing the
  value by an order of magnitude across a few degrees of azimuth, which is
  useless as a convergence target; haze carries the scatter around the sun, not
  the disc, and the aureole *is* included. The stratus is `fbm`, and porting a
  noise function is the likeliest place for a port to diverge invisibly.

### Scanning a frame without choosing where to look

Five tools now share this design point, and all five are **shared tooling that
any system should run over any round** — none is specific to whoever wrote it.
They are worth running as *gates* rather than on suspicion: `probe-unseen`
caught a regression on a night nobody had gone looking for one, which is the
whole argument for a check that costs nothing to run and takes no coordinates.

- `tools/framescan.mjs` — cool inversions, flat bands, dead zones, ruled
  horizons. Written for vegetation, fires on other systems' frames.
- `tools/probe-zeroscan.mjs` — clamped-to-black regions, by distribution rather
  than by location (case 34). Written for the building's glazing; a region
  clamped to exact zero is a whole-project failure mode and this one has a
  `--selftest` carrying both controls.
- `tools/probe-unseen.mjs` — meshes that change no pixel from any camera
  (case 33). Written for the car.
- `tools/probe-period.mjs` — visible repetition, by sweeping every lag on both
  axes in every horizontal band (case 41). Written for the building's masonry;
  a tiling texture betraying its tile is a whole-project failure mode, and the
  `--selftest` carries a striped control and a noise control.
- `tools/probe-rank.mjs` — where each named surface sits in the frame's tonal
  order, with **each surface selecting its own measurement region**. Written for
  the canopy soffit. See below: it is the only one of the five that solves the
  region problem constructively rather than by avoiding it.
- `tools/probe-shadowsource.mjs` — which occluder shadows a region, and what
  fraction, by ray casting toward the real sun vector (case 68). CPU only, no
  browser, under a second. Written for the canopy after a shadow reach was
  applied along the wrong axis and cost a full authoring cycle on a forecourt
  that turned out to be 89% sunlit. **Add a box for your geometry and pass
  `--rect` before authoring albedo detail onto anything you believe is shaded.**
  Conservative AABBs, so `shadows NOTHING` is trustworthy and a positive number
  is an upper bound.
  - It resolves the elevation from `LightingSystem`'s shipped `SUN_ELEVATION_DEG`,
    **prints which source it used**, and refuses to run if that disagrees with
    `site.SUN.elevation` by more than 0.05 degrees. That guard exists because the
    two disagreed by 11 versus 6.2 for most of a night; a constant no shipping
    code reads cannot be validated by the scene looking right, so a tool has to
    do it. `--selftest` fires the guard on the historical case as a positive
    control, because a guard sitting on a reconciled pair has never been observed
    to work.
  - `--elevation=` overrides for what-if sweeps. Worth using whenever a result
    does *not* move after an input changes: the canopy's 10.97% was identical at
    11 and 6.2 degrees, and only a sweep distinguished a real invariance with a
    derivable band from a probe reading a cached value.

#### `probe-rank.mjs` — letting the surface choose its own region

The other four tools deal with case 28 by refusing to take a region and sweeping
instead. That works when the question is "is there a defect anywhere". It does
not work when the question is "how does *my* surface compare to the ones around
it", because now you need the pixels belonging to one specific object and there
was previously no way to get them that did not involve somebody typing a
rectangle.

This one gets them by construction. Render the frame, hide **one object's
`visible` flag and nothing else**, render again, and take the pixels that
differ. Those are that object's pixels, wherever they turned out to be,
including the ones nobody would have thought to include. The selection is not a
proxy for visibility, it *is* visibility — the same definition `probe-unseen`
uses — so it inherits that tool's central property: it is exactly as correct for
an alpha-cut leaf card or a vertex-displaced billboard as for a solid panel, and
it needs no debug material, no flat colours and no second render path that could
disagree with the real one.

It then **ranks**, which is the output that matters. Ranking needs no exposure
reference and no agreed target, and it survives the intermediate states that
fool an absolute number: the canopy soffit at luma 74 was much brighter than the
27.9 it started at and still sat *below* the asphalt it shades, which is
impossible for white paint under lamps. "My surface is in the wrong place in the
tonal order" is a defect statement that no later change to exposure or tone
mapping can overturn, which is more than can be said for any threshold in this
repo.

```
node tools/probe-rank.mjs --port=<yours> --build-dir=<yours> --pose=<name> --no-build
node tools/probe-rank.mjs --port=<yours> --names=my-mesh,other-mesh,forecourt-slabs
```

Per object it reports `px` (zero means it draws nothing anywhere in this frame —
`probe-unseen`'s question, answered for free), `% frame`, mean `luma`, and
`p10`/`p90` so a bright specular streak is not mistaken for a uniformly bright
surface.

**Adoption path.** Three things to change and one to understand.

1. `--names` defaults to the canopy's meshes plus four reference surfaces from
   other systems. Replace with your own, and **keep some foreign ones** — they
   are not decoration, they are the entire method. A frame containing only your
   own parts has no reference in it.
2. `--pose` is a small table duplicated from `shoot5.mjs` so the tool stands
   alone. Add yours. It resolves eye height through the `groundHeight` service
   rather than by hand, for the reason recorded elsewhere in this document.
3. Your meshes must be **named**. 55 of 364 meshes in the scene are not, and an
   unnamed mesh cannot be addressed by any tool in this family.
4. Two controls run automatically and both should be read. The **determinism
   control** renders twice with nothing changed; whatever is currently unstable
   in this scene drifts by 0 to 48 pixels of 1.44 M, and those pixels are
   identified and then *excluded from every object's set* rather than tolerated
   as a threshold, so no object can be credited with a pixel that moves on its
   own. The **restore control** re-renders at the end and must match the
   original frame: a missed `visible` restore is thousands of pixels, so it is
   not close to the drift and the two cannot be confused.
5. `--tolerate=<systems>` exists because a sibling's failure aborts the run by
   default, and that default is right: a ranking taken from a half-built scene
   omits the missing system's surfaces and **nothing in the output says so**.
   It is a comma list of names rather than a boolean specifically so that
   tolerating one known problem cannot silently tolerate a different one that
   appears later, and every tolerated message is printed in full. Note that
   three of this project's systems report non-fatal problems by pushing to
   `__SYSTEM_ERRORS` and then continuing, so "a system reported an error" and
   "a system did not build" are genuinely different states and a tool that
   conflates them will refuse to measure a perfectly good frame.

   **Never persist it.** It defaults to empty and it must stay that way: pass it
   on the command line for the run you are doing, and drop it the moment the
   sibling fixes the problem. A tolerate list committed into a script or a
   default is a permanently silenced gate, and the cost is not the noise it
   suppresses now but the *next* occurrence, which will be a different bug
   wearing the same system name. The canopy tolerated a lighting divergence for
   two rounds and it never entered the file, which is the only reason no
   deletion was needed when lighting fixed it — the correct outcome reached by
   the flag having no memory rather than by anyone remembering.

Known limitation worth stating: an object measured from a pose that does not see
it reports `DRAWS NOTHING`, which is correct for the frame and says nothing
about the object. The canopy roof does this from every ground-level pose,
because it is the top surface of a deck. Use `probe-unseen` for the "from any
camera" question — it judges each mesh from its own best-case view — and use
this one for "in this frame, where does my surface sit".

**A small non-zero count is the same limitation wearing a disguise, and it is
much more dangerous than a zero.** `DRAWS NOTHING` announces itself as a
statement about the frame. *22 pixels* does not: it reads as "authored and
invisible", which is a defect this project has found repeatedly and is therefore
primed to believe. The canopy's fascia accent stripe measured **22 px from
`column_full` and 5365 px from `approach`**, and the low figure was not a defect
at all — `column_well` and `column_full` stand *under* the deck, where the fascia
pixels are the drip return's underside and the outer face carrying the stripe is
edge-on. Same for the overflow stains: 2 px from under, 565 px from outside.

So before treating a low count as a fault, ask whether the pose can see the
surface at all — which is the per-element viewing-distance finding in its ranking
form. The rule that follows: **a low count is a question, not an answer, and the
only way to close it is a second pose chosen from where the element is meant to
be read.** Two poses disagreeing by a factor of 240 is normal and means nothing
is wrong; two poses agreeing on a low count is the finding.

Two systems already have questions this answers and cannot currently answer:
the building's shelf slabs read flat, and the car has a trim strip that occupies
732 px and is invisible. Both are "is this surface in the right place in the
tonal order" and neither needs a new instrument.

**Read `p10` and `p90`, not just the ranking.** The ranking finds a surface in
the wrong place in the order; the percentiles find a surface that is in the right
place and clipping anyway. The canopy's fixture housings ranked last, which was
correct — a dark fitting under a lit panel *should* be last — and `p10 = 1` was
the actual defect, because pure black is not a value a painted object under an
open sky takes. A tool used only for its sort order would have cleared them.

**When the surface fills the frame, the mean is the wrong statistic and the tool
will say so quietly.** Ranking the canopy soffit with its lamps on and off gave
149.6 against 149.6, which reads as a control that did nothing; the control was
correctly applied and the effect was real, but the soffit is 98% of that pose and
the change was concentrated near eight fittings, so the mean divided it by thirty
before comparing it to itself. The fix is this tool's own method applied one level
down: **toggle the thing under test, keep the pixels that changed, and report the
statistics of that set** — the changed set is the region, so there is nothing to
choose and no dilution to argue about. It also separates modes the mean merges: on
the soffit, the changed pixels were bimodal at +168 and +4.3, which is the lamp
seen directly and the lamp's light on the panel, two different quantities that a
single mean reports as one number belonging to neither.

`tools/framescan.mjs` is the general defence for case 28, and the design point is
what it *refuses* to take as an argument:

```
node tools/framescan.mjs shots/system6/rounds/<id>/*.png [--x0=N --x1=N]
node tools/framescan.mjs --selftest
```

Every other pixel instrument here takes the region from the caller —
`regionstat` takes rectangles, `edgeread` takes an x and a y, `vegprobe` takes a
box. That is right when you know where the defect is and exactly wrong when the
question is "why does the critic see something I do not", because **an agent
who picks the coordinates picks them where the feature it just built is.** It
gets a true number about that spot and never visits the twenty rows the critic
reacted to. So this one picks nothing. It sweeps the frame and reports three
things a viewer reacts to:

- **COOL INVERSION** — a run of rows whose R−B sits below *both* the run above
  and the run below, and which is cool in absolute terms rather than merely
  less warm. This is "the horizon reads as water" as a number.
- **FLAT BAND** — a run whose within-row texture collapses against the ground
  median. Flatness is the other half of reading as water, and how "one flat
  cutout" shows up.
- **DEAD ZONE** — a run whose detail is a *step* below the rows nearer the
  camera rather than a falloff. This is what a cull distance looks like.

Four details are load-bearing and were each paid for during the build:

- **The window is swept over six run lengths.** A single fixed 8-row window put
  its own reference block *inside* the 20-row band and cancelled the difference
  it exists to find — case 23 again, a test whose reference moves with the
  thing being tested reports health.
- **The horizon is the modal skyline row, not the mean.** The mean is dragged
  into the pine crowns, which is half of what went wrong in case 28. The
  agreement fraction is printed on every run, and below 50% the flat-band and
  dead-zone tests, which assume a receding ground plane, **decline to run**
  rather than reporting on a frame they cannot read.
- **A cool run must be cool absolutely, not just relatively.** Without that
  gate the tool reported 25 findings across 18 frames, most of them shaded pump
  panels at R−B 23 between two panels at 36 — warm paint under a warm sun in
  all three places. With it, 5 findings across the same 18 frames. Per case 25,
  a metric that fires on correct output is worse than no metric.
- **The topmost run of ground is tested separately, against the ground below
  it only.** The two-sided test needs warm ground above the band and there is
  none when the band touches the skyline — which is the *worse* case, not a
  rarer one: round `2026-08-28T171609Z`'s `wide.png` carries the artefact at
  R−B **−37** with its top row on the horizon, and the two-sided sweep alone
  called that frame clean.
- **`--selftest` carries both controls.** A synthetic frame with a planted cool
  band, which must be reported, and one with only a legitimate warm-to-cool
  aerial gradient, which must not be. A probe that cannot fail is not evidence.

What it found on existing captures, with no coordinates supplied, is the
corroboration that settled case 28: the same cool band at the horizon in
`system6/wide.png` (R−B **−2.7** against 8.1 above and 10.1 below),
`system3/wide.png` (**−11.9** against 1.3 and 0.4) and **six of the car's seven
poses** — the seventh, `wheel_close`, is the only one with no horizon in it.
`three_quarter_front_t4.png` reads **−30.8** against −13.1 above and −4.0 below,
at rows 270-277, which is the band running the full width of the frame between
warm sky and warm dirt. **Three systems' harnesses, three
independent capture runs, one artefact** — which by this file's own standing
rule points at shared code rather than at any of the three, and none of the
three agents' instruments could see it because all three measure luminance.

### `makeRng` versus `seededRng`

`noise.ts` now exports both, and the choice is not stylistic:

- **`makeRng(seed)`** — bare xorshift32. Correct for a *single fixed seed*, which is
  what every texture builder does: one `makeRng(3301)` feeding hundreds of draws
  into a noise lattice. The biased first draw lands on one lattice cell out of
  thousands. Measured: adjacent-seed noise fields from the car's 3301/3313/3319/3323
  correlate at worst 0.17 against a distant-seed control of 0.06, with identical
  means and standard deviations. Draw 1 sets 1.2% of a frequency-9 lattice. These
  sites were left alone and are byte-identical.
- **`seededRng(seed)`** — hashed, prefix discarded. Required whenever seeding a
  *set* from consecutive or closely-spaced integers. Prefer it by default; reach
  for `makeRng` only to keep an existing generated result identical.

One caveat on the boundary: at frequency 3 the first draw sets 11% of the first
octave, so a builder whose *first* rng consumer was a freq-3 field would be
marginal. None currently is — `makeAsphalt` spends its first draws on worley
aggregate, not on its freq-3 patch noise.

**Known deviation in `makeRng`, documented rather than fixed.** Marsaglia's
xorshift32 specifies `s >>> 17`; this uses an arithmetic `s >> 17`, so once
`s >= 2^31` the sign bit is extended back into bits 31..15 and the recurrence is
not the standard one — its period is not the verified 2^32−1. Correcting the
shift would reroll every texture in the project, which is exactly the churn case
16 declined, and there is no observed defect: adjacent-seed fields measure
uncorrelated and no short cycle appeared in streams of 4096 draws. Recorded so it
is not quietly assumed sound, and so a future reroll taken for other reasons can
pick it up cheaply. **If evidence of visible structure or a short cycle ever
turns up, that changes the trade.**

### Seed-set decorrelation assertion

`tools/probe-rngsets.mjs` is the general defence, and per this project's pattern
it is worth more than either individual fix. It carries a registry of the real
seed sets — pumps, pump hoses, pines, ground clumps, scatter — and runs two tests
per set per early draw:

- **Unanimity.** Across eleven decision thresholds, flags when all N members of a
  set agree on `rng() < p`. This maps directly onto the observed symptom: "these
  N seeds produced N identical early decisions."
- **Coverage and rank correlation.** How much of 0..1 the draw actually spans
  across the set, plus Spearman against the seed. A draw spanning 8% of its range
  is not providing variation even when no single decision is unanimous.

**Why every flag is a p-value rather than a plain threshold, which is the part
worth keeping:** the first version used bare magnitudes and reported a vegetation
false positive. Sweeping eleven thresholds over four draws and six sets is ~264
tests, so a 2%-level coincidence appears every run; and a Spearman of 1.000
across the three pumps happens one run in six by chance. So unanimity is
Bonferroni-corrected across the threshold sweep, and rank correlation uses an
exact permutation null for n ≤ 8. **A probe that cries wolf gets ignored, and an
ignored probe is worth nothing** — the correction is what makes a green run mean
something. The cost is a real limitation: the test needs about five set members to
flag on statistics alone, so the three-pump hose-length ramp was confirmed from
the mechanism (`tools/probe-rng.mjs`, correlation over 200 seeds) rather than from
the three-sample statistic. Small sets need the mechanism; the probe catches the
rest.

It also carries a **deliberately known-bad control** — bare `makeRng` on ten
consecutive seeds — which *must* fail, and the run reports BROKEN if it ever
passes. A probe that cannot fail is not evidence, and building in a case that has
to fail is the cheap way to keep it honest.

`tools/probe-rng.mjs` is the characterisation behind the numbers above:
correlation tables per draw index, the no-op mechanism, the pump call site, the
texture scope bound, and what the fix moved.

`tools/rngfingerprint.mjs` guards the decision rather than the defect. It hashes
the draw stream for every fixed seed reaching `makeRng` anywhere in the project,
plus the noise fields built from them; run it before and after touching
`noise.ts` and diff. Any line that moves is a rerolled generated result. This is
what confirmed the case-16 fix left all ~30 texture sites byte-identical, and
what will catch a later change quietly taking the whole-project reroll that case
16 declined.

### Surface-projection fallback counters

Case 15's mechanism, in place. `carBody.ts` counts fallback hits per call site and
exports `resetProjectionStats()` / `projectionStats()`:

- `endZOutsideOutline` — the point is off the end of the nose or tail cap, so
  there is no fascia to project onto. Both paths to the flat plane are counted,
  including the `len >= r` rim clamp, which is the one that fires when a
  footprint overhangs the fascia and had previously been reaching `cap.zEnd`
  silently through a `Math.min(1, …)`.
- `flankXNoCrossing` — `y` is off the end of the section at this station, so the
  half width fell back to `hipX(z)`, roughly 100 mm out.

They are reported separately on purpose: the two need different fixes, and a
single total would hide which. `tools/carburied.mjs` resets them, builds the
whole car on the CPU, **snapshots the counts before it starts its own
`clearance()` probing**, and exits non-zero on any hit. That snapshot ordering
matters — the harness queries `endZ`/`flankX` itself at arbitrary part vertices,
which is legitimate, and interleaving the two put 202 hits on the report when
the car build was responsible for 1.

Diagnostics, all read-only and CPU-only:

- `tools/probe-fallbacks.mjs` — run this when `carburied` fails. Asserts the
  cap-uninitialised branch still throws, attributes hits per builder, names the
  offending placement and prints how far to move it.
- `tools/probe-endz.mjs` — flat-plane rate per shipping footprint, plus the
  usable cap envelope by height (the nose is good to |x| = 0.775 at y = 0.85 and
  only 0.215 by y = 1.00, which is what caught two lamp footprints).
- `tools/probe-shape.mjs` — distinguishes real curvature from a sawtooth by
  counting sign changes and second differences, prints `flankX`'s per-station
  cliff margins, and models how far the body can be reshaped before parts fall
  off it.

First run found one real defect that nobody knew about: the exhaust finisher is
authored at y = 0.352 and the tail cap's lower edge is at y = 0.3594, so it is
placed 7.4 mm below the fascia and gets the flat plane. Current Z error is only
about 2 mm, because the bulge goes to zero at the rim and the fallback and the
truth nearly coincide there — but it is no longer tracking the surface it claims
to conform to, and per `carParts.ts:711-717` that exact part has already once
ended up 128 mm inside the tail when the body was reshaped under it.

### Per-instance phase: the one pattern to copy

The remedy for case 22 lives in `applyGrime` and every system should adopt the
same one rather than inventing its own, because the failure is invisible and a
half-measure looks identical to a fix.

Give each instance **its own material**, and pass that instance a distinct
`fieldOffset` plus an alternating `fieldFlip`:

```ts
const unitGrime = (mat, o) =>
  applyGrime(mat, { ...o, fieldOffset: vary.fieldOffset, fieldFlip: vary.fieldFlip });
```

`PumpSystem` wraps it exactly once per unit and routes every grime call in the
factory through the wrapper, which is the detail that makes it stick: a bare
`applyGrime` added later silently opts that material out, and nothing complains.

Three properties of that design are load-bearing:

- **`fieldOffset` is in tile units, not metres,** and is added *after* the divide
  by `scale`. `0.37` means "just over a third of a tile" whichever material it is
  applied to. In metres it would have to be re-chosen against every material's own
  `scale`, and any material later re-tuned would drift back into alignment with
  its neighbours without anyone touching the offset.
- **Draw the offsets from the unit's seed, not from its index.** Use `seededRng`
  (case 16), or consecutive units get near-identical phases and the fix does
  nothing while appearing to be present.
- **The flip matters as much as the offset.** A pure translation slides the same
  pattern along, and a streak that leans the same way in both units still reads as
  one asset shifted. Mirroring object X changes which way the trails lean.

Only the *field lookups* take the offset. The height gates (`streakY`, `baseY`)
and `scuffCentre` are real positions on the object and must keep using unphased
`vGObj`, or run-off starts above the nozzle on one unit.

`CarSystem` adopted the same pattern for the four road wheels, which were the
worst instance of the defect in the project — one rim geometry, one material,
four corners, measured at exactly 0.00/255 on `car-alloy`, `car-chrome` and
`car-tyre`. Two things there looked like mitigations and were not, and are worth
naming so they are not re-attempted: `hub.rotation.y` does nothing at all,
because rotating an instance does not change any vertex's object-space position,
and the two tread phases in `buildTyre` move the field by only 3.23. After
phasing, 0.00 → 34–43 (`car-alloy`), 40–41 (`car-tyre`), 24–29 (`car-wheel-cap`,
split out from the body brightwork, which is a single instance and stays on
`car-chrome`).

Two things that round taught which are not in the pump write-up:

- **Stratify the offsets; do not just draw them.** A seeded draw across the whole
  tile lets two instances land next to each other by chance, and did: the caps
  first measured 27.2 on their closest pair because a 0.66-wide jitter on a 0.5
  quadrant stride overlaps. Give each instance its own quadrant and jitter
  inside it, and any two differ by at least 0.20 tile on one axis whatever the
  seed does.
- **A part much smaller than its own grime tile cannot be phased.** The centre
  caps sit at 24–29 rather than the 33–53 band because at `scale: 0.35` a 0.1 m
  cap spans under a third of a tile, so the field is very nearly constant across
  it and moving the phase swaps one flat value for another. Tightening the tile
  to roughly the size of the part raised the peak difference from 88 to 179,
  though the mean barely moved. If a small part must read as four different
  parts, the tile has to be smaller than the part.

**Then check the amplitudes, because fixing the phase usually exposes them.**
The pumps had two that did nothing: per-unit albedo tint at ±3.5% lightness,
invisible across a 40 cm gap, and a `film` term linear in `wear` giving only a
2.6× ratio end to end. Vary **hue**, not just value — a set that differs only in
lightness reads as one object under different exposure, which is the same trap one
level down.

### Colour-space convention

Adopted after case 27. The rule is short because three's defaults already do the
right thing for the common case, and the churn of changing 114 working sites would
buy nothing:

- **Author colours as hex literals wherever possible.** `new THREE.Color(0x8b8478)`
  is sRGB by default, which is what a person picking a colour means. All 114 sites
  in the project are correct for free and need no annotation.
- **A numeric triple is linear, so use one only when you mean linear** — scene
  radiance, an HDR value above 1, a light colour, or a multiplier. `lightSky.ts`
  is the model: `uZenith` at 0.020 sits in the same set as `uSunDisc` at 3.7, and
  a value above 1 is self-documenting proof that the author meant linear.
- **Never pass `THREE.SRGBColorSpace` to `setRGB`/`setHSL`.** This is the whole of
  case 27, and it is the argument that looks like diligence. If a value is
  display-referred, write it as hex; if it is linear, omit the argument. There is
  no case left where the explicit sRGB tag on a numeric triple is the right answer.
- **Never transfer-encode a multiplier.** A ratio through a power curve is wrong in
  hue even when it is right in level, and brightness-based review will not catch it.
- **Adjacent terms of one expression must share a space.** `uBase + uGlint * spec`
  with the two tagged differently is wrong on sight, without knowing either value.

For texture data, keep the existing discipline, which the audit found already
correct everywhere: one helper per generator taking an explicit `srgb` flag,
`true` for anything used as a `map`, `false` (`NoColorSpace`) for normal,
roughness, gray and mask data. Set `colorSpace` explicitly on every
`CanvasTexture` — the default is `NoColorSpace`, so a colour canvas that forgets it
renders too bright, the same bug in the opposite direction.

### Authored-colour assertion

`tools/probe-colourspace.mjs` is the general defence for case 27:

```
node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-colourspace.mjs
```

Pure computation, no GPU and no capture. It does two things, and the split matters
because intent is not in the code:

- **A mechanical screen that needs no intent at all:** every literal tagged
  `SRGBColorSpace` whose largest component is under 0.12. This works precisely
  because the error is asymmetric — sRGB decoding divides by up to 12.9 near zero
  and by almost nothing near one — so restricting it to dark values makes it
  specific enough to be worth reading. It found all three real sites and nothing
  else. **A version that flagged every space mismatch regardless of magnitude
  would have reported bright values at 1.1x and been ignored**, which is the case
  16 lesson again.
- **A curated table classified by how each value is consumed,** because that is
  what decides which space is correct: `unlit` (written straight to the
  framebuffer, the worst case), `albedo`, `radiance`, `multiplier`, `light`. The
  same number is right or wrong depending only on this, so it cannot be inferred
  from the literal and is stated per site.

It reports through the real tone curve — three's ACES fit at the project's 1.25
exposure — rather than in linear, because "0.0041 linear" persuades nobody and
"0 out of 255" ends the argument.

**What it cannot do, and what should back it up.** It cannot know intent, so it
would not catch a value that is genuinely meant to be near-black. The durable
complement is the shape `tools/vegband.mjs` established in case 24: assert the
*rendered* tonal relationship in output pixels — a treeline lighter than the
element in front of it, a duff mat darker than the dirt but above black — rather
than the authored number. Authored-value checks catch the mechanical mistake
cheaply and on every run; only a pixel check can catch "this is the wrong tone".
Both, not either.

### Instanced-weathering assertion

`tools/probe-instancing.mjs` is the general defence for case 22, and it is a
static check rather than a pixel one:

```
node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-instancing.mjs
```

It builds `PumpSystem` and `CarSystem` headless — no GPU, no browser, no capture —
walks the real scene graph, replicates `applyGrime`'s triplanar lookup on the CPU,
and fails with a per-site breakdown when two instances of anything resolve to the
same pattern. Three design notes worth keeping:

- **The measured field difference is the assertion; the topology scan is only a
  screen.** That ordering was not obvious and the numbers settled it: the three
  dispensers of case 21 report three *distinct* object-space extents, so a
  topology-only check would have passed the exact defect the probe exists for.
  An identical extent is one way to get an identical lookup, not the only way, so
  the cheap structural test cannot be the one that decides.

- **It reports the real graph, not the source text.** `applyGrime` records its
  uniforms on `mat.userData.grime`, so the probe needs no knowledge of any
  system's syntax and picks up new call sites for free. Building the systems
  headless needed only a stub `location`, a no-op 2D canvas, and a flat
  `groundHeight`. The canvas is no-op deliberately: this audit is about topology,
  so the textures it would draw are irrelevant — do not reuse that stub for
  anything that inspects texture content, it will silently report blank.
- **Sharing a material is not the defect, and the first version got this wrong.**
  It flagged the car's `paint`, which is correctly shared by the body, the boot
  trim and the arch lips — different panels at different object-space positions,
  sampling different field, nothing repeated to see. Sending an agent to "fix"
  that is the cost of a lazy criterion. The test needs a repeated *extent* drawn at
  more than one *world position*, and even that is only a screen: the verdict comes
  from evaluating the field lookup directly and reporting the difference in 0..255,
  which is what cleared the bollard posts at 35.7-38.4 and condemned the rims at
  0.00.
- **It carries a known-bad control**, for the case 16 reason: it fails on real data
  today, but once the wheels and bollard feet are phased it goes green and nothing
  is left proving the comparison still discriminates. So every run also measures a
  deliberately unphased pair, which must flag at 0.00, and a phased pair, which
  must not, at 45.97. If either moves, the probe is broken rather than the scene
  being clean.

`BuildingSystem` and `VegetationSystem` cannot be built headless yet and the probe
says so rather than skipping them quietly. Neither uses `applyGrime`, so there is
nothing to find in them today. Both fail on **type-only imports written as value
imports** — `import { BuildingMaps }` and a constructor parameter property — which
Node's strip-only mode cannot erase. `src/gen/textures.ts` had the same defect
(`import { Rng }`, fixed to `type Rng`) and it is worth fixing on sight, because
it is what decides whether a system can be measured on the CPU at all.

## Capture archive

`tools/archive.mjs` is the shared helper for case 13. It is opt-in: harnesses
adopt it when they are next open, and nothing breaks in the meantime. Layout:

```
shots/<system>/rounds/2026-08-28T175859Z-82a250250970/side.png
shots/<system>/rounds/2026-08-28T175859Z-82a250250970/manifest.json
shots/<system>/side.png          <- stable copy, refreshed every round
```

The round directory is keyed by UTC capture time plus the short bundle hash the
harness already computes in `bundleStamp()`, so a lexical sort is chronological
and the build is legible without opening anything. The archive is authoritative;
the stable path is a **copy**, not a move, so existing critic prompts and the
habit of opening a known filename keep working, and pruning can never remove the
last readable capture.

`manifest.json` records the capture time, bundle hash, bundle mtime, system
name, presets captured, GPU renderer string, and `window.__SYSTEM_ERRORS` as it
stood at capture time. That last field is the point of the file: per case 8,
`Game` now catches and disables a throwing system, so a page that renders is not
necessarily a page that is healthy, and a round where a system silently failed
must be identifiable months later from the manifest alone.

To adopt it in a harness, alongside the existing `bundleStamp()` and
`assertHardwareGpu()` calls:

```js
import { openRound } from "./archive.mjs";

const round = await openRound({
  root: ROOT,
  system: OUT,                 // becomes shots/<system>/
  bundleHash: stamp.hash,
  bundleMtime: stamp.iso,      // or stamp.mtime, whichever the harness has
  tag: "shootcar",             // log prefix only
});

// Replaces `page.screenshot({ path: file })`. Returns the archive path — log
// that one, it is the copy that will still be there next week.
const file = await round.save(`${shot}${SUFFIX}`, (dest) => page.screenshot({ path: dest, type: "png" }));

// Once, at the end, on the failure paths too: a round that failed is exactly
// the round somebody will want to read later.
await round.finalise({ gpu: gpuInfo.renderer, systemErrors: sysErrs, keep: 10 });
```

`save()` also takes a Buffer instead of a writer function. `finalise()` prunes
to the most recent `keep` rounds per system (default 10) and never touches the
stable copies. Neither pruning nor a failed stable copy throws — a cleanup
problem must never fail a capture run that has already spent minutes on the GPU.
Node built-ins only; no new dependency.

**Changed by the case-30 audit. No harness needs editing — the API is
unchanged — but four behaviours are different and everyone should know:**

- **`shots/<system>/stable.json`** now records, per stable filename, the round
  it came from, the bundle hash and mtime, the capture time and the run's
  outcome. Read it before quoting a stable path. A frame whose outcome is
  `failed`, `system-errors` or `incomplete` came from a run that did not pass
  its own checks, and `incomplete` specifically means the run died before
  finalising, so that PNG is from a capture nobody verified.
- **Pruning will not delete a round younger than 45 minutes**, and will not
  delete one containing a file called `KEEP` — drop an empty `KEEP` into any
  round you have handed to a critic. Prune now prints the names it removed and
  the names it spared.
- **A colliding round id gets a `-2` suffix** instead of two runs merging into
  one directory under one manifest.
- **`manifest.identicalToPreviousRound`** lists every capture that is
  byte-identical to the same name in the previous round, and the console warns
  when the list is non-empty. This is not a staleness verdict — an unchanged
  scene renders the same twice — but if you just changed something and the
  frame that should show it is byte-identical to last round's, stop and find
  out why before measuring anything.

## Contract drift

`BuildingSystem` publishes `building.coolerDoors` as `Object3D[]`, while the
documented contract (and `HANDOVER-building.md`) says `Group[]`. Harmless today:
every element genuinely is a `Group`, and `InteractionSystem` only touches
`rotation`, `userData` and `matrixWorld`, all of which live on `Object3D`. Worth
narrowing the published type when `BuildingSystem.ts` is next open — left alone
here because another agent is live in that file.

Two lessons generalise beyond these cases:

- **A defect that resists tuning twice is a bug, not a parameter.** Cases 4 and 5
  were both re-tuned repeatedly before anyone questioned whether the mechanism
  worked at all.
- **Suspect shared code when two unrelated surfaces show the same artifact.**
  Case 5 was reported independently against dirt and against asphalt; that
  coincidence was the tell, and it pointed at the noise kit rather than at
  either material.
- **Fine procedural detail is the recurring loss.** Three separate systems have
  now lost time to detail that was authored correctly but did not survive to the
  screen — mortar joints on the building, and creases and lamp flutes on the
  car. In every case the first instinct was to raise contrast, which never
  helped. The check that does help is to ask, in order: is the detail large
  enough to survive sampling at the distance it is viewed from, and is there
  enough angular difference between the surfaces it separates for the lighting
  to distinguish them?

## Renderer

Per the user's `gpu-rendering.mdc`: never infer the renderer from launch flags in
either direction. `--enable-unsafe-swiftshader` *permits* a software fallback, it
does not force one — this project spent three iterations believing its captures
were CPU-rendered when they were already on the discrete GPU. Always query
`WEBGL_debug_renderer_info` and print it, and treat shader link errors as fatal
in automated capture. `tools/gpu.mjs` does both.

**Do not panic when you grep for `--enable-unsafe-swiftshader` and find it.**
Playwright's own default Chromium argument list includes it in the version
pinned here, so it appears in the launch command of every harness in this
project whether or not the harness asked for it — `launchOptions()` only adds it
under `--allow-software`, and no harness passes that. This is exactly the
"infer the renderer from the launch flags" mistake the paragraph above warns
about, now available in the *opposite* direction: seeing the flag proves nothing,
because it permits a fallback that never happens. The renderer string is the only
evidence, it is printed on every run, and `assertHardwareGpu` refuses to continue
on a software rasteriser. If you want to know what rendered a capture, read the
`ANGLE (NVIDIA, ...)` line in its log, not the argv.

## "Roughness reads as dirt" inverts on a surface that reflects the ground

Standing advice when dialling grime is to reach for the roughness gain before
darkening anything, since killing a reflection reads as dirt without touching the
paint colour. That holds for a panel reflecting sky and reverses for a rocker.

Raising the car's weathering roughness gain from 0.55 to 0.66 made the sill
*brighter* than the shoulder: what roughness destroyed there was a dark tarmac
reflection, and what replaced it was blurred sky. Measured as the luminance
falloff from upper flank to sill, where positive means the sill is darker, which
is what grime does:

| film | rough | falloff |
|---|---|---|
| 0.55 | 0.55 | 2.8% |
| 0.74 | 0.66 | **−6.7%** |
| 0.74 | 0.40 | 8.9% |
| 0.95 | 0.25 | 19.3% |
| 1.20 | 0.25 | 22.6% |

So on the lower body the lever is film, and roughness has to come *down* to let
the dark ground reflection do the darkening for free. Check the sign before
trusting the rule on any surface below the beltline.

Swept live through the `__CAR_WEATHER` hook rather than by rebuilding, which is
what that hook is for: a capture round is about four minutes and this question
needed six values.

## Brightness is not quality: a metric that cannot see pigment

With `envMapIntensity` live, the car's paint was re-measured at metalness 0 —
physically correct for a colour coat — and every luminance statistic improved:
flank mean 61.2 to 70.9, largest single-row step 4.1 to 4.9. Brighter *and*
better differentiated. The frame it produced was a near-white car with the blue
washed out of it, and the value was put back to 0.36.

Mean flank saturation is the number that sees it: 0.326 at metalness 0.36 against
0.282 at 0. Lowering `envMapIntensity` to compensate does not recover it (0.325
at 0.85), because what saturates a reflection is the base colour tinting it,
which is exactly what metalness buys on a dielectric that also has a clearcoat
lobe doing the white specular.

Generalises: when a change improves every number you are watching and looks
worse, the metric is incomplete rather than the eye being wrong. Add the axis
that would have caught it before deciding.

## `envMapIntensity` — the mechanism, and the diagnostic that found it

Case 21 above is the full account. `src/systems/lightEnvBinding.ts` is the fix
and carries the three-js source excerpts it depends on; `LightingSystem` owns
it. Systems do not opt in and must not: every material in the scene is bound
before every render, including materials created lazily or swapped at runtime.

**The technique is the transferable part, and it works on this whole family of
bugs: stage the change two ways and diff the pixels.** Neither cheaper check
settles it. Nulling `scene.environment` changes 68% of the frame, which proves
IBL reaches the object and says nothing about the knob. `renderer.properties
.get(mat).envMap` is truthy either way. Only varying the intensity under two
different bindings separates them:

| variant | `envMapIntensity` 1 -> 4 |
|---|---|
| inherited from `scene.environment` | 0.00% of pixels changed |
| `material.envMap = scene.environment` | 15.0% changed, flank mean 58.6 -> 119.1 |

`tools/carenv.mjs --isolate-only` is where that came from, on the car alone.
`tools/envbind.mjs` is the general form and the regression test: own port 5127
and build directory, one pose per system, and five staged captures each —

- **control**, nothing changed, captured twice. Must be ~0%. Its first run was
  not: the harness had loaded the page without `?shot=`, so `PlayerSystem` was
  live and re-seating the camera every frame, and two captures of an unchanged
  scene differed by up to 64%. Every other number in that run was worthless and
  looked fine. **A no-change control is not ceremony.**
- **bound x4** — must move pixels.
- **pre-fix x1 versus x4** — the binder is suspended and `material.envMap`
  nulled, reproducing the bug live, and the same x4 staged inside it. Must
  *not* move pixels. This is the control that has to fail, per the seed-set
  probe: a probe that cannot fail is not evidence. Note the first cut of this
  row compared the pre-fix frame against the *fixed* baseline and duly reported
  a difference — it was measuring the fix, not the knob. Both frames in a
  control have to be on the same side of the change.
- **restored**, twice — must return to the baseline exactly, because the binder
  adopts any value it did not write as the new authored one.

Measured on the current build, x4 on one system at a time, all five systems
green: car 19.8% / building 21.6% / pumps 3.6% / terrain 37.3% / vegetation
6.8% of the frame moved, against 0.00% for every control and 0.00% for every
pre-fix row.

The same run also reports what making the knob live *cost*, which is the number
to quote when the scene looks different: against the pre-fix render, car 12.4%,
building 18.2%, terrain 14.4%, vegetation 1.4%, pumps 0.2%. Those are not
regressions. They are five systems' authored intensities applying for the first
time, and every system's material tuning is now suspect.

## The channel you are tuning may not be the channel doing the work

Case 21 left every system's material tuning suspect, and System 2 was the most
affected of the five. The obvious next move was to re-tune the store interior,
whose `envMapIntensity` had been authored at 0.07 against a control that did
nothing and was therefore "almost certainly far too aggressive now".

It was not. Staged through `?ienv=` on the `interior` pose, measured over the
foreground gondola:

| interior `envMapIntensity` | mean luma of the shelf region | floor |
| -------------------------- | ----------------------------- | ----- |
| 0.07                       | 42.7                          | 2     |
| 0.30                       | 45.5                          | 8     |

A **4.3x change in the control buys 2.8 out of 255.** The indirect term is
linear, so even 1.0 is worth about +11. The interior IBL is a weak channel and
was never what made that room black.

What actually makes it black is that the room has no bounce at all: the
troffers are `RectAreaLight`s, so every downward and rearward face receives
literally nothing and clamps. The evidence that this is a different problem and
not a smaller version of the same one is a control that stayed at **0.0%**: the
band of pure-black product silhouettes against the storefront glass does not
move by a single pixel between `?ienv=0.25` and `?ienv=1.0`, while a shelf
region 200 px away in the same frame moves 33%. One frame, two regions, one
knob, opposite answers — which is the only reason the null result is
trustworthy. A whole-frame diff would have shown movement and been read as
progress.

**Before spending a round tuning a value, spend one bounding what that value
can do.** Two captures and a region diff cost seven minutes and would have
saved an afternoon of moving 0.07 around.

## A blank object is a conspicuous object

Three separate blank cream rectangles in the `door` capture, each identified
only after being mistaken for something else:

- A 0.20 x 0.30 m product that drew the packaging atlas's deliberately
  restrained cell. The cell was *empty*, not restrained.
- A `window-notice` quad, flat-coloured on purpose, with the reasoning written
  in the source: "no legible content, because a label you can nearly read is
  worse than none." Correct instinct, wrong conclusion — at 130 x 190 px it was
  the most conspicuous thing in that half of the frame.
- Sign plates whose type is 1.0 to 2.6 px of cap height, i.e. correct artwork
  averaging to a flat tint.

The rule that resolves all three: at small sizes a surface must average to the
right **value**, and carry structure at a scale that survives the mip chain.
"Nothing" is not a neutral default, it is a light grey slab, and a light grey
slab is the loudest thing on a shelf. Print value structure and no letterforms.

`tools/probe-signage.mjs` reports every sign's cap height in screen pixels per
pose, which is the number that decides whether artwork is worth drawing.
`tools/probe-pixel.mjs` ray-casts the real scene through a capture camera and
names the mesh under a pixel — the second one exists because three guesses at
"which of four hundred merged batches drew that rectangle" would have cost ten
minutes of capture each, and it costs two seconds.

## A feature can be defeated by the light and the eye at once

Three rounds were spent on dispenser shut lines that a critic kept describing as
"drawn lines on a single moulded box". They were not drawn. They were recessed
geometry, verified by CPU raycast through the actual capture camera, and the
probe was right every time. The frames still showed nothing.

Measured in the critic's own frame, a mid-face horizontal joint scored **-1.5 of
255** against the panel beside it, and the one under the valance scored **+21.9,
i.e. brighter**. Vertical joints in the same frame scored **-95**. Same slot
width, same depth, same material, two orders of magnitude apart — because a
groove needs the light across it and the eye onto it, and a horizontal groove on
a vertical wall at dawn has neither:

- **The sun was at 11 degrees.** A horizontal slot is lit nearly along its own
  length, so its floor gets almost the same irradiance as the face. The
  vertical slots scored -95 under the identical sun because for them that same
  near-horizontal light is *across* the slot and the near wall occludes it.
- **The camera was 12.8 degrees above the joint.** A horizontal ledge is
  foreshortened to about 22% of its width at that angle, so the 5 mm lit lip
  that was supposed to pair with the shadow was a third of a pixel.

Deepening the recess makes the second problem worse, so the fix was to stop
relying on either: the panels now **lap**, each row standing 4 mm prouder than
the row below. An 11 degree sun throws that overhang's shadow 1/tan(11) = 5.1x
its depth *down the panel below* — a 20 mm mark on a surface the camera sees
face-on, 6 px instead of 0.3. A mark projected onto the wall is not
foreshortened and does not care where the eye is.

Two things worth keeping from this:

**Horizontal and vertical instances of "the same" feature are different
features.** They had been authored, measured and reasoned about as one. Anything
whose read depends on self-occlusion has a preferred orientation relative to the
key, and under a low sun the difference is not subtle.

**Ask what mechanism carries the signal, then check that mechanism is available.**
Occlusion, projected shadow, albedo and reflection fail under different
conditions. The shut lines were built to read by occlusion in a situation where
occlusion could not happen, and no amount of correct geometry was going to fix
that.

## min-over-a-window cannot tell a groove from a shadow

The instrument that reported those shut lines as healthy scored them by taking
the darkest pixel in a window around the joint and comparing it to a region
average. It reported 10 to 66 of 255 of darkening. The honest figures were -1.5
and +21.9.

It was not measuring the joints. Two of its samples sat next to the dark valance
and one sat inside a cast shadow, and a minimum over a window happily returns
whichever dark thing is nearest — the statistic has no way to distinguish "there
is a groove here" from "this whole area is darker". Both of the strong readings
came from the contaminated samples, and the two clean ones read -10 and -11,
which was the real number and was ignored because the headline looked better.

The replacement (`tools/edgeread.mjs`) scores against the panel 6..12 px above
**and below** the joint, separately, and credits the slot only against the
*nearer* of the two. A shadow gradient moves both references together and the
score collapses; a groove darkens relative to the panel touching it and it does
not. Same pixels, same joint, opposite verdict.

Generalising, because this is the fourth instrument on this project to flatter
its author: **a summary statistic over a spatial window imports whatever else is
in the window.** If the feature is local, the reference has to be local too, and
it has to be on both sides.

## A dark material with a metalness term is not a dark material

The lapped joints above were backed by a deposit strip on an albedo half the
panel's, which should have measured about -50 of 255 against it. In frame it
measured **-13**.

The strip had been put in the cabinet's `steelDark` slot — metalness 0.35 at
envMapIntensity 0.8 — so a third of what it returned was specular off the
environment, and the environment is a flat bright hemisphere. The albedo
contrast was real and was simply added back on top of.

Shut-line floors, dirt deposits and anything else whose job is *to be dark* want
metalness 0 and a low envMap term, in their own slot. Otherwise the darkness is
at the mercy of what the sky happens to be doing, and on this project the sky is
currently a single constant colour, so anything whose read depends on what it
reflects cannot even be judged.

## Hard edges do not make damage discrete

Bollard impact damage was "a soft, airbrushed brown band... reads as a scorch
mark or a bruise on fruit". The cause looked obvious: the paint-failure mask was
a 0.36-wide smoothstep, and enamel does not fade into bare metal. So it was
narrowed to 0.04.

That produced something worse. Thresholding a *continuous* field hard does not
give you chips, it gives you a speckle belt at constant height with a hard top
and bottom edge, and in render it read as a printed camouflage stripe wrapped
round the post — a clear regression from the bruise it replaced.

The edge was never the problem on its own. The mask now thresholds a Worley cell
field, which already comes in separated round marks, with height only biasing
which cells fire. Checked numerically rather than by eye: rows at >55% coverage
went from a continuous belt to **0**, max row coverage 39%, damage present on 25
of 256 rows. **Discreteness is a property of the field, not of the transfer
function applied to it** — sharpening the transition on a smooth field just
converts blur into noise.

## A shape profile can be a step function wearing a curve's clothing

The car's amber repeater rendered as a literal hexagon, and a critic named it as
one. The outline was authored as a "squared-off ellipse":

```js
Math.max(0.06, Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * v - 1), 5)), 0.2))
```

Read as a curve that is what it looks like. Sampled, it is not: at six rows it
evaluates to **0.06, 0.972, 0.999, 1.0, 0.999, 0.972, 0.06**. The fifth power
collapses everything away from the ends to 1 and the 0.2 root pulls the rest up,
so the profile is a step with exactly one intermediate value per end — two
sloped segments, i.e. a hexagon. It looked fine on the parts that happened to
carry 16 rows.

Two compounding faults, both worth recognising elsewhere:

1. **The taper was a fraction of the patch's own height**, so it had no idea
   whether it was radiusing a 180 mm lamp or an 11 mm slat. The same helper had
   already turned the grille slats into a bowtie of bright shards for this
   reason, and that was patched by adding a `rect` profile rather than by fixing
   the profile.
2. **Rows were spaced evenly.** A rounded rectangle has *all* of its curvature
   in the last R of its height and none in the middle, so uniform rows spend
   almost all of their resolution where nothing is happening.

The fix is a genuine rounded rectangle — straight sides, a circular quadrant
into each corner, radius taken from the *smaller half-dimension in world units*
— plus a row distribution that clusters toward the ends. Taking the radius from
real dimensions also retired a 0.06 floor that existed only to stop the end row
collapsing to a point and producing degenerate normals: the end row is now
`1 - R/W` wide by construction.

**If a profile function's output is nearly binary across its domain, it is not a
shape, it is a threshold.** Print it at the row count you actually build with
before trusting it.

## "Below the sampling rate" is a measurement, not a default explanation

The pumps agent found its 5 mm chamfer was 0.45 px at the critic's framing and
correctly stopped tuning contrast on it. That result is now well known here, and
the risk is that it becomes the reflex answer for anything a critic calls ragged
or invisible.

The car's grille was reported as "torn, jagged, aliased edges". The same
arithmetic gives the opposite answer. `nose_close` is a 34° vertical FOV at
2.176 m over 900 px, so the visible height is `2 * 2.176 * tan(17°) = 1.331 m`
and one pixel is **1.48 mm**. The aperture's 4–10 mm sawtooth is therefore
**3–7 px** — not sub-pixel at all, and squarely in the range where raggedness is
unmissable.

That changed the fix completely. Sub-pixel detail wants removing or replacing
with something larger; 3–7 px raggedness is a real edge that is really wrong.
The cause was structural: the aperture is cut at quad granularity from a *radial
fan*, so its boundary is a staircase running diagonally across the grid however
the opening is specified. Despeckling makes the staircase contiguous; nothing
makes it straight. The fix is not a finer cut but a **surround** — a frame whose
inner edge is an analytic curve lapping over the ragged boundary and whose outer
edge lands on solid fascia. Real cars have that part for exactly this reason.

**Do the mm/px arithmetic for the specific frame before choosing between "too
small to see" and "big enough to be obviously wrong".** They are opposite
diagnoses and the same complaint fits both.

## An environment failure renders the sky correctly and the ground black, so it is read as a defect in whoever owns the ground

Four harnesses lost or nearly lost a round to this in one hour, and every one of
them initially blamed its own system.

The mechanism: a non-finite value anywhere in the PMREM propagates through every
material that samples the environment. The sky is not one of those materials, so
it renders perfectly. Everything lit by the environment goes black. `tsc` is
green, no shader fails to link, and **`__SYSTEM_ERRORS` stays empty**, because
nothing threw — the frame is simply wrong.

What makes it expensive is that the failure looks exactly like the defect the
agent is already hunting. My captures came back with a correct sky and a black
ground, and every symptom matched the foliage problems I had spent three rounds
on: dark crowns, no separation between sunlit and shadowed faces, a flat horizon
band. I would have spent a round darkening or brightening albedo to fix a bug in
another system. The building agent got two entirely black rounds; the pumps agent
got one where "every frame is a silhouette".

Three lessons, in order of how much they save:

1. **Assert on frame content, not just on error channels.** Every existing
   assertion in my harness passed. The check that catches this needs no
   cooperation from the system that broke: read the PNG you just wrote and refuse
   a frame that cannot be the scene you asked for. Mine are sky mean luma,
   lower-third mean luma, and near-black fraction, with thresholds derived from a
   known-good and a known-broken round on disk rather than picked by eye.
2. **The sky is not evidence of environment health.** My known-broken frame had a
   sky mean of 126.1 against a known-good 126.9 — byte-comparable. The sky test
   alone would have passed it. It was the lower-third mean (0.0 against 24.2) and
   the near-black fraction (66% against 33%) that caught it. Anyone tuning these
   thresholds needs to know which of the three does the work.
3. **A guard that fires on healthy frames protects nobody.** My first version of
   the console pattern was `/non-finite|NaN|Infinity/i`, and it failed all six
   frames of a healthy round on its first run, by matching the middle of the word
   "lumi*nan*ce" in a benign log line. It would also match "nanometre" and
   "finance". `NaN` and `Infinity` are JS literals with exactly one correct
   spelling, so the `/i` that felt like caution was the entire bug — being
   permissive about a token that has one spelling only widens the false-positive
   surface. Word boundaries and case sensitivity, plus a self-test over both
   classes of string, which is the only reason I caught it before promoting the
   module to five other harnesses.

Corollary for distinguishing this from its neighbour: a poisoned environment
blacks out **uniformly**, because NaN has no distance falloff. A shadow frustum
that is too small blacks out **to a radius**. My ground faded from luma 28 to
zero as it approached the camera, and that gradient is what identified it as the
shadow bug rather than the environment bug — two independent faults in one
commit. The shape of a blackout tells you which one you have.

## An average over a spatial extent is not evidence about a feature that occupies part of that extent

This has now bitten the project at least four times, in four different files, and
three of those were committed while fixing one of the others. It is worth stating
as a general rule because the local symptom looks different every time.

The shape: you want to know something about a feature. You compute a statistic
over a region that contains the feature *and* other things. The statistic is
dominated by the other things, comes back healthy, and you conclude the feature
is healthy.

Four instances:

1. **`vegband` passed a broken frame.** It averaged luminance over "the rows
   below the skyline". In a frame with a pine in it, those rows are part crown
   and part horizon, so the average was a blend and the band's own value never
   appeared in it. Reported band luma 99.6 on a frame two critics independently
   described as a cold blue band.
2. **`framescan`, written to replace it, made the same mistake in its first
   version.** The new `RULED HORIZON` test measured the luma step across the
   skyline as a mean over the full frame width. Buildings and trees occupy some
   columns, so an edge that is **79 luma in clean columns averaged to 19** and
   the test did not fire. Fixed by measuring per column at each column's own
   skyline, at which point it fired on all six frames at 55-86 luma.
3. **The horizon band's height field.** `shape` blended five independent uniform
   noise rings. An average of independent uniforms concentrates on its mean:
   measured sd 0.121, p1..p99 span 0.19..0.75, so a nominal 11-16 m height range
   only ever produced 11.97..14.77 m. The *amplitude* of the feature was
   destroyed by the averaging, which is the same failure one level down — and I
   spent three rounds re-weighting that average, which cannot fix it, because any
   reweighted average of uniforms still concentrates.
4. **The mean-luminance environment check.** Whole-frame mean luma passed a frame
   whose lower two thirds were pure black, because the sky is bright and is most
   of the frame's energy.

The fix is the same every time and it is not "pick a better threshold": **measure
per column, per unit, per instance, at each one's own reference point.** If a
statistic has to be aggregated, aggregate a per-unit measurement (median of
per-column steps), never measure an aggregate.

The corollary worth remembering: a guard built this way does not fail loudly. It
returns a plausible number and a green tick, which is worse than having no guard,
because it converts "unknown" into "verified". Every one of the four reported
health on something visibly broken.

## An average over a population selected by the property being measured

The case above is about a statistic whose *region* is wrong. This is the same
family one level down, and it is worse, because widening the region does not
help and the number does not merely dilute — it is forced.

The shape: you want to know whether a feature varies. You select the units you
will measure, using a criterion that is a function of how much they vary. Then
you average variation over the survivors. The answer is now a property of the
gate, not of the feature, and it is a *reassuring* answer by construction.

**The instance.** `framescan`'s `RULED HORIZON` test asked "does the skyline
wander column to column?" It first kept only columns whose skyline row sat
within 12 px of the modal row, then averaged the row change between adjacent
survivors. On a frame whose skyline wanders 30 px, that gate discards precisely
the columns that wander. Measured both ways on the same frame
(`tools/hzprobe.mjs`): **0.69 px per-column jump through the gate, 10.5 px
without it.** The gate had a legitimate purpose — reject columns where a tree or
a parapet stands in front of the horizon — but it was two-sided, and the
"too low" half of it has no such justification, because an object in front of
the horizon can only push a column's skyline *up*. That half was pure selection
on the measurand.

Two further defects were sitting underneath it and are worth naming separately,
because either alone would have been enough to make the test useless:

- **Whole-pixel rows.** It compared integer row indices, so "% of adjacent
  columns identical" was a measurement of *quantisation* for any edge moving
  less than one pixel per column — which is the case actually in dispute. A
  sub-pixel edge position (half-luma crossing between each column's own sky and
  its own ground) is now used instead.
- **The firing condition was a test for something else.** It was
  `median whole-row jump <= 1 && step >= 30`. The median of a set of small
  integers is 0 as soon as half of them are 0, which is true of every distant
  treeline. So it fired on all seven frames of a healthy round: it was a test
  for "the horizon is far away" wearing the label "the horizon is a drawn line".

**Consequence for the record: any past round that cited framescan's
`RULED HORIZON` verdict — in either direction — is uninformative.** A fire meant
nothing, because it fired on everything; and the raggedness number quoted
alongside it was an average over a population selected for not moving. Several
rounds of horizon work in `HANDOVER-vegetation.md` were steered by that number
and their conclusions should be re-derived, not inherited.

Fixed in `tools/framescan.mjs`: one-sided gate with the object-rejection count
printed, sub-pixel edge position, `p05..p95` spread and longest identical run
reported beside the per-column jump (flat-locally and flat-globally are
different claims and a ruled edge is both), and a firing condition of
`sub-pixel jump < 0.25 && spread < 6`. `--selftest` now carries a planted
dead-straight skyline that must fire and one wandering 0.15 px per column that
must not; **the old condition fired on both.**

The generalisation, and it is the one to carry forward: **a filter applied
before a statistic is part of the statistic.** Before averaging over a selected
set, state the selection criterion and check whether it mentions — or correlates
with — the quantity being averaged. If it does, the result is circular. The
honest version is to report the ungated number alongside the gated one and
justify the gap, which is what the tool now does.

## A well-formed question about the wrong axis validates a defect indefinitely

The two cases above are about a statistic whose region or population is wrong.
This is the same family again, and it is the hardest of the three to notice,
because nothing about the tool is sloppy: the question is well posed, the
arithmetic is right, the number is stable across rounds, and it is measuring a
real property. It is simply not measuring the property in dispute, and it is
*silent* about the one that is, so it comes back green forever.

**The instance.** `tools/nozzleprobe.mjs` asks whether the fuel nozzle is seated
in its boot. It reports how far the spout has dropped into the cup and whether
the body bears on the rim, and both numbers were correct. It reported "canted,
bearing" for months. The critic kept saying the nozzle was hovering, and the
critic was also right: the spout had swung sideways and come out through the
**wall** of the pocket, emerging low on the front of the boot and hanging in
clear air below it. The probe only ever looks down the mouth. A tool that has
left the holster through the side is, in depth terms, still deeply inside it.

Neither party was wrong and no amount of re-litigating either measurement would
have found it. What found it was asking what question the probe was *not*
asking, which turned out to be lateral containment.
`tools/bootfit.mjs` now tests that: for every vertex of every stowed nozzle part
below the mouth, how far outside the pocket surface or below its floor.

**The second half of this case is the important half.** `bootfit`'s first
version modelled the pocket as a vertical cylinder and returned *all six
contained*. The bore is raked `face * 0.10` about X. Adding the rake turned the
same unchanged scene into **four of six breaching**, by up to 8.4 mm. The new
tool had reproduced the exact failure of the old one — a defensible question
asked about the wrong axis — while the author was in the middle of writing up
that failure. The axis-aligned model is the default that costs nothing to write,
and every raked, ovalled or instanced feature in this project will invite it.

Carry forward: **state the axis and the frame a probe measures in, in the tool,
next to the constants.** If the feature has a rake, an oval, or a parent
transform, the probe must work in the feature's own frame or it is measuring a
slice through the thing rather than the thing. And a containment claim that comes
back clean on the first try deserves the same suspicion as any other flattering
number — `bootfit --selftest` plants a 150 mm breach for exactly this reason,
because a tool that believes the pocket is enormous contains everything.

## Two sections sharing a coordinate on a raked axis are not joined

A geometry-assembly hazard, not a measurement one, and it has now produced the
same visible artefact twice in System 3.

`place(geo, x, y, z, rx, ry, rz)` rotates each piece about **its own centre**.
So when two sections of one assembly are given the same `z` and the same rake,
they do not meet. The pump's nozzle boot is a mouth section over a sheath,
both at `bootZ`, both raked 0.10 rad about X: the mouth's lower rim swings
6.6 mm one way, the sheath's upper rim 3.3 mm the other, and the result is a
10 mm step with the inside of the cup visible through it. In round
`2026-08-28T194424Z` the stowed spout tip was framed in that gap and read as a
bright tapered wedge stuck to the outside of the boot — the same "a slot has
been read as an object" failure the cabinet shut lines produced earlier in the
same system.

The fix is not to nudge the `z` values until it looks right. It is to place
every section by distance *along the shared axis*:

```ts
const bore = face * 0.10;
const downBore = (d: number): [number, number] => [
  bootY - 0.030 - d * Math.cos(bore),
  bootZ - d * Math.sin(bore),
];
```

Two things generalise. First, when an assembly has an axis, author positions as
distances along it and derive the Cartesian pair; a literal `y` and `z` per
section is a latent bug the moment anyone changes the rake. Second, a thin
bright sliver at a section boundary is almost never a lighting artefact — check
for a gap showing the interior, or a neighbouring object framed by one, before
touching materials.

## A per-system count that silently excludes part of the system

`shoot3.mjs` prints a `pumps registry` line ending `"meshes":75,"tris":94368`, and
that number did not move across three rounds in which System 3's triangle count
changed by nearly ten thousand. It is not stale and it is not wrong: it counts
the dispenser meshes registered for interaction, and the six forecourt bollards
are not registered because nothing picks them. So the figure is accurate about
what it measures and misleading about what its name suggests, which is the worst
combination — nobody re-derives a number that looks plausible.

This matters now that cost is being measured across systems. A per-system
triangle breakdown assembled from each harness's own registry line will be wrong
by whatever each system owns but does not register — props, footings, decals,
anything added straight to a group rather than through the system's `add()`
helper. It will also be *self-consistently* wrong, so the totals will look fine.

If you are auditing cost, count from `renderer.info.render` after a frame, or
walk the scene graph, and treat any harness's self-reported figure as a claim
about its registry rather than about its geometry. The same applies in reverse:
a system whose count looks suspiciously stable across a change that should have
moved it is reporting a registry, not a scene.

## A term that cannot reach its target at 8x is in the wrong place, not too weak

This is the decisive experiment, and it is worth reaching for early because it
is cheap and its answer is unambiguous:

> **Scale the term by eight and measure. If eight times the authored strength
> does not get you to the target, the term is not too weak — it is in the wrong
> place.** No amount of further tuning will fix a misplaced term, and every
> round spent turning the knob makes the frame worse in some other way while the
> original defect survives.

The corollary is the reason this is worth stating as a rule: a misplaced term
does not read as broken. It responds to tuning — slightly, monotonically, in the
right direction — so an owner gets continuous positive feedback while walking
away from the actual cause. That is why several rounds can be spent on it.

**The instance.** Vegetation's foliage transmission term had existed for several
rounds, had never worked, and had been strengthened repeatedly. Measured on the
`sunlit` crown region, all one bundle:

| `?vtrans=` | crown luma | R−B |
| --- | --- | --- |
| 0 | 78.0 | −2.7 |
| 1 (shipping) | 78.2 | −2.4 |
| **8** | **79.6** | **−0.2** |
| ceiling, `?vshadow=0` | 83.6 | +3.4 |

Eight times bought +1.6 luma against a +5.6 deficit. That result is what
converted "the transmission term seems weak" into "the transmission term is not
where I think it is", in one capture.

### The cause: injection-point / pipeline-stage mismatch

The term was injected at `#include <dithering_fragment>`. Verified against the
installed three (r185), the tail of `meshphysical_frag` is:

```
opaque_fragment -> tonemapping_fragment -> colorspace_fragment
  -> fog_fragment -> premultiplied_alpha_fragment -> dithering_fragment
```

`dithering_fragment` is **last**. So a scene-referred linear radiance was being
added to a value that had already been through ACES and the sRGB transfer
encode. It was not light; it was paint, applied after the camera. Moving the
same expression to `outgoingLight` immediately before `#include
<opaque_fragment>` — where the value is still scene-referred linear — was worth
the same as the 8x crank at 1x, and it now responds like light instead of like
an offset.

**This is NOTES case 24 running backwards.** Case 24 is display-referred values
entering a linear pipeline; this is a linear value entering a display-referred
one. Same class, opposite direction, and neither is visible to a brightness
check, because both produce a plausible number.

### What to check whenever you write `onBeforeCompile`

The chunk you target is a statement about **which pipeline stage** and
**which colour space** your value is in. Get it explicitly right:

| chunk | variable | space / meaning |
| --- | --- | --- |
| `map_fragment`, `color_fragment` | `diffuseColor` | linear reflectance 0..1 |
| `alphamap_fragment` | `diffuseColor.a` | coverage |
| `roughnessmap_fragment` | `roughnessFactor` | perceptual 0..1, not a colour |
| `normal_fragment_begin/_maps` | `normal` | unit vector, view space |
| `lights_physical_fragment` | `material.*` | linear |
| `lights_fragment_maps` | `radiance`, `irradiance` | scene-referred linear radiance |
| before `opaque_fragment` | `outgoingLight` | **scene-referred linear — put light here** |
| `tonemapping_fragment` and later | `gl_FragColor` | **display-referred; do not add radiance** |

### Absence is the hardest defect class to see

Worth stating on its own, because this project keeps meeting it in new costumes.
The transmission bug was a wrong injection point — a thing present and wrong,
which you can find by reading. The `vegWire.ts` bug found in the same audit was
a **missing** injection point, and it had survived a round that correctly
diagnosed and fixed a *different* colour-space bug two lines above it in the
same uniform block. The earlier round found its bug because there was something
to inspect; it walked straight past this one because there was not. An absent
chunk has no line number, appears in no grep, and produces no wrong value to
notice — only a right value in the wrong place, which looks like nothing.

This project has now lost time to absence three times in different disguises: a
missing shader chunk, four meshes invisible because nothing said which side to
render, and a service published and never consumed. None of the three is
findable by reading the code that has the defect, because the defect is not in
that code. **The only instruments that catch absence are the ones that enumerate
what ought to be there and check each item** — an audit across every injection
site, an assertion over every geometry attribute, a registry of published
services against consumers. Build the list, then check the list.

And the case that has no chunk to get wrong, so it gets forgotten entirely: a
custom `ShaderMaterial` receives **no** tone mapping and **no** output encode.
Three only makes the functions available; the shader must `#include
<tonemapping_fragment>` and `#include <colorspace_fragment>` itself. A custom
shader that writes a linear value straight to `gl_FragColor` is the same defect
with the chunk list removed — and it is harder to spot, because there is no
suspicious injection point to look at.

## Two frames are not comparable unless the bundle hash matches

Six agents rebuild shared source continuously. Any agent that captures a control
after capturing its main round may be comparing two different builds, and the
difference it attributes to its own flag can be somebody else's edit.

**The tell, and it is the generalisable part: when a control produces a result
that violates the arithmetic of what you changed, suspect the bundle before you
suspect the physics.** In the instance, a purely additive shader term measured
as *negative* in the crown tiles when enabled. An additive term cannot be
negative. That is not a surprising physical result to be explained; it is proof
that the two frames do not differ only by the flag. Chasing it as physics would
have produced an elaborate and entirely fictional explanation, and the fiction
would have been persuasive because the number was real.

Other impossible-sign checks worth keeping in mind: a feature-removal flag that
*adds* geometry, a density knob that moves a count the wrong way, a cull radius
that increases the instance count, disabling shadows making something darker.

**Mitigation, recommended for all systems.** `shoot6.mjs` already prints the
bundle hash and build time on every captured line and re-checks the hash after
the last shot, which is what made this recoverable. The practice that goes with
it:

1. Capture the control and the baseline **in the same session**, or at least
   assert the hashes match before comparing. Build once, then use `--no-build`
   for every frame in the comparison set.
2. Put the hash in the round id, as `shoot6` does, so the pairing is visible in
   the filename and cannot be lost when results are quoted later.
3. Never compare against a round from an earlier session without checking the
   hash first, however recent it is — "twenty minutes ago" is several rebuilds.
4. When a comparison is unavoidably cross-bundle, say so next to the number.

A control captured against a different build is not weak evidence. It is
evidence about an unknown pair of changes, which is worse, because it looks
exactly like evidence about yours.

## Ruling every suspect out is not the same as finding the culprit

A twenty-five minute walk produced a 1% low of 80 ms against a median of 9 ms,
in bursts lasting up to 25 seconds. Everything measurable said the scene was
innocent: hitching and calm five-second windows had the same draw calls (289 vs
274), the same triangles, the same heap, the same live audio node count; all
twenty of the run's worst frames uploaded 0 bytes and linked 0 programs;
correlation against card memory in use was 0.038, against a major-GC-sized heap
drop −0.039.

That is a strong negative result and it names nothing. The temptation at that
point — the whole reason this case is here — is to write "probably GPU
contention from the sibling agents", which is plausible, consistent with
everything above, and *unmeasured*. A plausible cause accepted because nothing
else survived elimination is a guess wearing a conclusion's clothes, and it
would have been indistinguishable in the report from something demonstrated.

**The fix is a control, not more counters.** Park the camera at spawn, take no
input, run no route steps, and sample the same static frame for two minutes:

```
t= 21s  mean  11.34 ms   max  37.8      t= 78s  mean  82.50 ms   max 183.4
t= 32s  mean  11.83 ms   max  38.2      t= 89s  mean 122.82 ms   max 190.2
t= 42s  mean 118.76 ms   max 243.6      t=104s  mean  12.57 ms   max  36.7
```

Identical scene, identical camera, identical 533 draw calls — **11 ms in one
window and 122 ms in another.** Nothing in the process changed, so nothing in
the process is responsible. Two minutes of doing nothing was worth more than
every correlation computed over 146,829 frames of doing something.

Two details worth copying:

- **The control was *worse* than the workload**: parked mean 18.8 ms against a
  walking steady state of 10.5 ms. When the null condition costs more than the
  test condition, stop attributing anything to the test condition.
- **`utilization.gpu` was pegged at 100% in 93 of 94 windows** — including every
  calm one. A saturated counter discriminates nothing, and had it been the only
  evidence gathered it would have looked like a measurement. The control is what
  carried the result; the utilisation reading only established that this card
  was never idle during any number taken tonight.

The general form: when a measurement has eliminated every mechanism you can
name, the next step is a condition in which the remaining hypothesis predicts a
*different* observation — not another counter that agrees with all of them.

## An `onBeforeCompile` without a cache key hands you the wrong shader

`WebGLRenderer` caches compiled programs. If two materials whose callbacks
generate *different* GLSL share a cache key, one silently renders with the
other's compiled program.

**Read this part before believing you have found an instance, because three
already defends against the obvious version.** `Material.customProgramCacheKey`
is not empty by default — `Material.js:543` is

```js
customProgramCacheKey() {
    return this.onBeforeCompile.toString();
}
```

so the *stringified callback* is the default key. Wrap `onBeforeCompile` and
change nothing else and the key changes by itself. The hazard therefore needs
someone to have **replaced** that default with a key of their own, which is what
every `apply*` helper in `src/gen/` does, and it needs the replacement to be
blind to something that changes the generated source. Two materials with
textually identical callbacks that differ only in captured closure values is the
other route in.

The corollary for anyone auditing this: **"same key, different
`onBeforeCompile` function object" finds nothing.** Every closure is a distinct
object, so that test flags every correctly-shared program in the project — 16
groups here, including 46 foliage materials that were all fine. The test that
works is to run each callback against a mock shader and compare the *text* it
produces. Measured that way, this project has **0 collisions across 50 key
groups**, which is a different and much more useful statement than "I could not
find one".

There is a matching error in the other direction. This project had a confirmed
instance of the second kind and a *reported* instance of the first that did not
survive checking — see below, because how the false one was produced is worth
more than the true one:

| | | |
|---|---|---|
| **Key omitted** | different shaders share a program | wrong image, silently |
| **Key too specific** | identical shaders compile separately | wasted programs and compile time |

`src/gen/vegTransmission.ts` was the second kind, and is fixed: the key embedded
five numeric values that are all passed as uniforms and never substituted into
the GLSL, so every distinct tuple compiled a byte-identical program under its own
key. Wasteful, obvious once measured, and harmless to the image. It now returns
a constant.

**The first kind has no confirmed instance in this project, and the way I came
to believe it did is the more useful half of this case.**

I reported `src/systems/TerrainSystem.ts` (the `?flat=` debug path, which wraps
`onBeforeCompile` on seven terrain materials and does not extend the cache key)
as an example of it, and wrote a paragraph here about how it would fail by
producing a plausible frame. On checking the site properly rather than reading
its shape, **neither condition for the bug holds**:

1. **The callback changes no GLSL.** It sets `shader.uniforms.*.value` and
   `material.normalScale` — a uniform value and a material property. Nothing it
   touches is substituted into the source, so there is no divergent text for a
   shared program to be wrong about. By the test at the bottom of this case, it
   is *correct* for it not to extend the key.
2. **The seven materials never shared a key anyway.** `applyWorldDetail` already
   gives each one a distinct `customProgramCacheKey` — `wd:asphalt:…`,
   `wd:concrete:…`, `wd:dirt:…` and so on — so they land in different cache
   slots regardless.

3. **And three's default key would have covered it anyway** had the key not been
   replaced — a third independent reason, which I also did not check.

Any one of them alone makes the report wrong. What produced it was pattern-matching:
*wrapped `onBeforeCompile` + no `customProgramCacheKey` in the same edit* is a
genuinely reliable smell, I recognised it, and I wrote up the failure it usually
implies without checking the two things that decide whether it applies here.
The write-up was fluent and specific and completely fictional, and it was
heading for a document that seven agents read.

**A recognised pattern is a reason to check, not a finding.** The check is three
questions and none is expensive: does the callback alter the shader *text*, do
any two materials actually share a key, and was the default key replaced? Ask
them before writing the paragraph, not after someone routes the work.

For the real thing, the mechanism to look for is specific. `WebGLRenderer`
line 2216 calls `material.onBeforeCompile( parameters, _this )` for every
material — the per-material `programs` map at line 2191 is keyed per material,
so the callback is never skipped because another material got there first. The
next line, `programCache.acquireProgram( parameters, programCacheKey )`, then
consults the **global** program cache by key alone and hands back a previously
compiled program if one matches, discarding whatever text this material's
callback just produced. So the bug needs *both* a shared key *and* divergent
generated source, and it is invisible without them.

**Rule: if you wrap `onBeforeCompile` in a way that changes the generated
source, extend `customProgramCacheKey` in the same edit.** Chain rather than
replace — three's own materials may already have one:

```js
const prior = mat.customProgramCacheKey?.bind(mat);
mat.customProgramCacheKey = () => `${prior ? prior() : ""}|myfeature:${flagsThatChangeTheGLSL}`;
```

Put in the key exactly what changes the *generated source*, and nothing else.
Values that only reach the shader as uniforms must stay out, or you land in the
right-hand column of the table above.

## Counting textures overstates VRAM wherever `clone()` is used

**The renderer keys a GPU upload on `texture.source`, not on the `THREE.Texture`
wrapper. `Texture.clone()` copies the wrapper and shares the source. So N cloned
textures cost one upload, and any audit that counts texture objects reports N
times the truth.**

Three agents hit this on the same night from three directions, which is why it
is stated here rather than in any one of their reports:

- Building's harness attributed a 276 MB anonymous group partly to six 2048²
  maps it could see in the scene graph.
- The performance audit recommended halving those six to save 96 MB.
- Terrain independently found the same distinction from its own end and revised
  202.7 MB down to 138.7 MB.

All three were counting wrappers. `TerrainSystem` builds one asphalt set with
`makeAsphalt(2048, 8, 1337)` and then does `asphaltMaps[k].clone()` for the lot
so it can change `repeat` — `repeat`, `offset`, `wrapS/T`, `colorSpace` and the
filters all live on the wrapper, which is the entire reason `clone()` exists.
Six texture objects; three uploads; **64 MB, not 128**. Halving them saves
48 MB, not 96.

### The scale of the error, measured

A full audit of this scene by `source.uuid` (`tools/texture-audit.mjs`):
**119 unique sources behind 908 `THREE.Texture` wrappers — a factor of 7.63.**

The worst single case is the environment map. One 768×1024 RGBA16F PMREM
cube-UV target, 6 MB, is bound as `envMap` on **345 texture wrappers**. Counted
by object it reads as 2.07 GB. Counted correctly it is 6 MB, on a card with 8.
Any audit that reports texture memory by counting objects is not off by a bit;
it can be off by three orders of magnitude on a single entry, and it will
volunteer a number that looks like a crash cause.

### How to count correctly

Group by `source.uuid` and count each group once:

```js
const bySource = new Map();
scene.traverse((o) => {
  for (const m of [].concat(o.material ?? [])) {
    for (const k of Object.keys(m)) {
      const t = m[k];
      if (t?.isTexture && t.image) bySource.set(t.source.uuid, t);  // one entry per upload
    }
  }
});
```

Better still, do not count objects at all. `tools/perf.mjs` and
`tools/budget.mjs` take the byte count straight off the `texImage2D` /
`texStorage2D` calls, which is the only figure that cannot be wrong, and
`perf.mjs` prints `shared sources: N sources bound under >1 THREE.Texture (free)`
so the gap between the two accountings is visible rather than implied.

Note the direction of the error: **it flatters nobody.** It makes your system
look more expensive than it is, so it survives review — nobody interrogates a
number that makes them look bad. That is why it took three independent
discoveries to surface, and why one of the recommendations built on it would
have delivered half of what it promised.

## "Free" is not "reachable", and only one of them means you can walk there

A stress test that walks the scene needs to know where the floor is. The obvious
way is to sample the collision field on a grid: for each cell, is there a
blocker here? That gives a map that is 94.5% free, which sounds like a site you
can walk around.

It is the wrong question. The first routed walk marched into the store, stopped
at z = 33.68, and spent 33 of its 125 seconds strafing left and right against
something — while the grid cheerfully reported every cell beyond it as free.
**"No blocker at this point" says nothing about whether a body can get to the
point.** Free cells behind a wall are free.

Flood-fill from where the player actually stands and the map tells the truth: of
12,758 free cells, 153 are stranded — and among them is the entire back half of
the store, including two of the scene's four interactables.

Three traps in a row here, each of which produced a confidently wrong answer:

1. **The `canReach` predicate snapped to the nearest reachable cell** before
   testing reachability, so it could never return false — it answered a question
   about somewhere else and reported yes. A helper that finds the nearest
   *valid* thing must not then be asked whether that thing is valid.
2. **The entry door is shut when the grid is sampled**, so the flood walled off
   the whole store and reported the interior unreachable — while the walk
   strolled in, because the route opens the door first. A static map of a scene
   with doors in it is wrong in both directions unless you punch the openings
   through deliberately.
3. **"Unreachable" was nearly reported as a design fact.** Re-sampling at a
   range of body radii showed the back of the store opens at 0.30 m and closes
   at 0.32 m, which is the player's. The finding is not "the store has no
   aisle", it is "an aisle is 40 mm too narrow" — a one-line fix rather than a
   redesign, and the two would have been routed to entirely different work.

**Any spatial probe should report reachable, not free, and should sweep the
parameter the answer is sensitive to.** A binary yes/no about geometry that is
within 6% of the threshold is not an answer; it is a coin the next person will
flip again.

## A count is not a size, and `renderer.info` reports counts

`renderer.info.memory.textures` is the number of texture objects three is
tracking. It is the number everyone reaches for when asked "how much VRAM does
this scene use", and it cannot answer that question: 212 textures is equally
consistent with 40 MB of icons and with 900 MB of 4K maps. `geometries` is the
same, a count of `BufferGeometry` instances with no relation to bytes.

Worse, `renderer.info.render` (`calls`, `triangles`) is **reset on every
`render()` call**. Reading it after the frame gives you the last pass only. In a
scene with shadow passes and a PMREM rebuild, that can be a small fraction of
the frame's real work, and it will look like an encouragingly cheap scene.

The measurement that does answer the question is at the GL level: wrap
`texImage2D`, `texImage3D`, `texStorage2D/3D`, `compressedTexImage2D`,
`renderbufferStorage*` and `bufferData` on `WebGL2RenderingContext.prototype`
before the page's own script runs, compute bytes from the internal format and
dimensions, add the 1.333x for a mip chain, and subtract on `deleteTexture`.
`tools/perf-instrument.js` does this. On this scene the count-based estimate and
the byte-accurate one disagreed by about 500 MB, all of it in allocations three
makes on your behalf that never appear in the scene graph at all — see the next
case.

The generalisable form: **when a metric is a count and the question is about
size, the metric is not a weak proxy, it is a different quantity.** Distrust any
budget expressed in "number of textures".

## The renderer allocates memory you never asked for

Nothing in this project's source ever created a 256 MB texture. The scene held
one anyway, and it was never read.

`WebGLShadowMap`, for a non-VSM directional light, builds the shadow as a
`WebGLRenderTarget` — which comes with three's default **RGBA8 colour
attachment** — and then attaches a `DepthTexture` to it. `WebGLLights` binds
`shadow.map.depthTexture || shadow.map.texture`, so once the depth texture
exists, *the colour attachment is never sampled by anything.* The depth pass
rasterises into it every frame and the result is discarded. At this project's
8192 shadow map that is 256 MB of write-only VRAM sitting alongside the 256 MB
that does the work. Converting it to `R8` (colour-renderable in WebGL2, contents
irrelevant because nothing reads them) reclaimed exactly 192.00 MB, measured, on
a frame that differs by 1/255 on 17 of 6,220,800 channels. `src/core/shadowMemory.ts`.

Two lessons, and the second is the load-bearing one:

1. **Auditing your own allocations is not auditing the scene's memory.** Sum the
   textures in the scene graph and you will miss shadow maps, PMREM targets,
   the default framebuffer, and every internal target the library makes. Those
   are the big ones, because they scale with resolution rather than with art.
2. **An allocation nobody reads produces no visual symptom at any size.** There
   is no frame you can look at, and no screenshot diff you can run, that would
   have revealed this. It is only visible to a byte-level accounting of GL
   calls, which is an argument for having one before you need it.

## A GPU check at startup cannot see a fallback mid-run

The rule was "hard-fail on a software renderer", and the obvious implementation
— create a throwaway canvas at launch, read `UNMASKED_RENDERER_WEBGL`, assert it
says NVIDIA — passes happily and proves less than it appears to.

Playwright injects **`--enable-unsafe-swiftshader` into every Chromium it
launches**, whether or not you pass it, and it survives `--use-angle=d3d11
--enable-gpu --ignore-gpu-blocklist`. Confirmed by reading the command line of a
running browser (`Get-CimInstance Win32_Process`), not from documentation. So
the guarantee that flag exists to remove is not available to any Playwright
harness in this repo, including `shoot.mjs` and `shoot6.mjs`. The flag does not
*cause* software rendering; it permits a silent fall back to it when the real
device is lost — which, on a card that six agents are contending for, is exactly
the condition under which the fall back would happen.

The startup probe cannot catch that, because it runs before the pressure and on
a different context than the one that will render the scene.

**Every harness in this repo currently has this hole**, because they all call
`assertHardwareGpu(page)` and nothing else.

### What to do instead — concretely

`tools/gpu.mjs` now exports `assertSceneGpu`, which reads the unmasked renderer
out of `window.__GAME.renderer.getContext()` — the live context the frame was
drawn with — and additionally fails if the context has been lost. Add one line
to your harness, after the scene is ready and before you trust any pixel:

```js
import { assertHardwareGpu, assertSceneGpu } from "./gpu.mjs";

await assertHardwareGpu(page, { tag });                 // keep: catches a bad launch early
await page.waitForFunction(() => window.__SCENE_READY === true);
await assertSceneGpu(page, { tag, when: "after ready" });   // add: covers the actual measurement
```

On a long run, call it again at the end (`when: "after the last frame"`). A
fallback or a context loss that happens at minute four invalidates everything
captured after it and is otherwise completely silent — the animation loop keeps
running, the screenshots keep arriving, and they are all the same stale frame.

**The generalisable rule, which outlives this particular flag: assert the
property on the context you are actually measuring, at the time you are
measuring it.** A precondition checked on a proxy, before the conditions that
would break it, is not a precondition. It is a note about the past.

## Wall-clock frame time is not a property of the scene here

Same bundle, same fixed camera pose, four loads inside five minutes: 10.68,
10.99, 17.02 and 21.12 ms mean, with 1% lows from 34 to 136 ms. Nothing about
the scene changed. Six sibling agents were doing headless GPU captures, and
`nvidia-smi` showed the card between 4.0 and 7.1 GB of 8.0 used and 71–100%
busy throughout.

A 2x spread means any timing-based A/B on this machine needs the effect to be
larger than 2x before it says anything, and almost none of them are. Two
specific traps this produced:

- The *flattering* direction is the dangerous one. The R8 shadow change measured
  as a 2x frame-time improvement in one pairing. It is a memory change; it
  cannot plausibly halve frame time. Reporting that number would have been
  reporting sibling scheduling as a win. (Same shape as "two frames are not
  comparable unless the bundle hash matches", one section up — a real number,
  produced by something other than your change.)
- Ordering effects masquerade as trends. Rows measured later in a sweep are
  slower on average because VRAM pressure accumulates across the run, so any
  sweep whose configurations are in a meaningful order will show a fake gradient
  along it.

**Prefer counters that are deterministic under contention** — draw calls,
triangles, programs, texture and buffer bytes, allocation counts. Across those
same four loads, every one of those was bit-identical between the pairs that
should match. When you do need timing, say what else was on the card, and treat
anything under ~2x as unmeasured rather than as a small effect.

## A capture can be a valid file, a valid PNG, and contain no pixels

A 65-byte file named `640` appeared in the repo root. It was not a shell
redirect artefact. It was a **structurally perfect PNG with dimensions 0x0**:
correct signature, correct IHDR, correct CRCs, an empty IDAT, a correct IEND.
Some harness parsed an argument as an output path and wrote an empty image.

Everything downstream would have accepted it. It exists, so an existence check
passes. It is a PNG, so a type check passes. It opens without error in every
viewer. And these captures are fed to critics: a critic handed an empty image
reviews it as evidence and returns a score, and no one downstream can tell that
score from a real one. This is the same silent-absence class as every other case
in this file, arriving through the one path in the project whose entire job is
to produce evidence.

`assertCaptureUsable` in `tools/archive.mjs` now rejects, at the moment of
writing: a non-PNG, a zero dimension, dimensions other than the requested
viewport, and a file too small to contain an image. Every harness that archives
through `round.save()` gets this for free.

Three things worth keeping from the exercise:

**Set the size floor from measurement.** A solid-colour 1920x1080 PNG compresses
to 9.7 KB; the smallest genuine capture in this repo is 1.20 MB. 0.05 bytes per
pixel sits an order of magnitude clear of both. A guessed threshold would have
been either useless or a source of false alarms.

**Then check the false-positive rate before shipping the check.** The first
version applied that ratio at every size and flagged 42 files, all of them
legitimate: alpha cutouts and material swatches at 256² really are almost flat.
One true positive against 42 false ones is a check everybody learns to skip, and
a check everybody skips is worse than no check, because it looks like coverage.
Restricting the ratio test to images of a megapixel or more — which is what a
scene capture is and what a diagnostic crop is not — took it to 8 flagged files,
all of which look like genuine blank frames.

**The offending file was not in `shots/`.** It was in the repo root, written by a
harness calling `page.screenshot({ path })` directly, so hardening `round.save()`
would not have caught this specific one. `node tools/archive.mjs --scan .` walks
the tree for PNGs — including extensionless files that are PNGs, which is what
`640` was — and reports any that fail the same assertion. Run it before handing
anything to a critic. Fixing the shared path is necessary; assuming everything
goes through the shared path is how the file got there.

## Your own fix shows up in the measurement as somebody else's bug

The first performance report said "518 MB of transient texture uploads during
generation — whoever generates through intermediate canvases should dispose them
promptly", and ranked it as the highest-value stability work available, because
peak upload during init is the best explanation for the crash.

**512 of those 518 MB were allocated and freed by the optimisation the same
report was landing.** Reclaiming the shadow map's colour attachment builds a
replacement target and disposes the original; measured as "uploaded minus still
resident", that is a 512 MB transient with a stack trace pointing into three's
`WebGLTextures`, sitting in exactly the same column as a generator that forgot
to dispose a canvas. The real generator churn was 6 MB.

The arithmetic that caught it: `frees` was **4 texture objects**, and the swap
frees exactly 2 of them at exactly 256 MB each. A 518 MB leak spread across
dozens of procedural textures would have freed dozens of objects. One number
being oddly round, next to a count that was oddly small, was the whole tell.

Two things to carry forward:

1. **Measure the baseline before your change is in the build, or subtract
   yourself explicitly.** A metric collected on a bundle containing your own fix
   is not a measurement of the codebase; it is a measurement of the codebase
   plus you, and the part that is you is the part you are least likely to
   suspect.
2. **A derived quantity inherits every allocation in the pipeline, not just the
   interesting ones.** "Uploaded minus live" is a good proxy for wasteful
   generation right up until something legitimately allocates-then-frees, at
   which point it reports a large number with a real stack trace and no way to
   tell the two cases apart except by knowing what you changed.
3. **When a measurement implies a mechanism, check the other counters in the
   same readout against that mechanism before acting.** This is the cheapest
   check available and it would have caught the error at the moment the
   hypothesis was formed, not a day later. The hypothesis was "many procedural
   textures are generated and not disposed". That mechanism predicts *dozens* of
   frees. The same readout said `frees: 4`. Four frees, two of them at exactly
   256 MB, is a swap, not a leak — the refutation was already on screen,
   unread, because the interesting number had been found and the rest of the
   line was skimmed. A readout is a set of simultaneous constraints on what can
   be happening; use all of them.

The fix was then rewritten to move the existing depth texture to the new target
instead of rebuilding it (order matters — see `src/core/shadowMemory.ts`), and
to pre-build the shadow map before three does, so the oversized attachment is
never allocated at all. Peak went from 832 MB, to 576 MB, to 320 MB. **The first
version made peak VRAM worse in exchange for making steady state better**, which
is the wrong trade when the failure mode is a crash at the peak — and it would
never have been noticed without the byte-level accounting, because the steady
state it reports was correct and flattering.

## A leak needs a window longer than the thing that is not leaking

The 45-second walk reported the DOM event listener count growing at +4.71/min,
monotonically, never once decreasing across fifteen samples. It was written up
as the only unbounded quantity in the scene and prioritised as the thing that is
"harmless in a 45-second probe and fatal in a twenty-minute session".

Over 180 seconds the same counter reads: 36 rising to 43, then **29**, then
rising to 34. It is a sawtooth with a period longer than the original probe.
Slope over the longer window: −2.88/min.

Attributing the registrations rather than counting them finished the job: 13
listeners appeared over three minutes, all of them `onended` handlers on Web
Audio nodes — 7 from the audio graph arming once, 6 from vehicle passes, each of
which disconnects its node graph in the handler and then becomes collectable.
That is correct cleanup, observed mid-cycle.

The generalisable trap: **a bounded resource whose collection is less frequent
than your sample window is indistinguishable from a leak, and it will look more
convincing than a real leak because the curve is so clean.** Monotonic over a
short window is not evidence of unbounded growth — it is evidence that you have
not yet observed a collection. Before believing a leak: extend the window until
you see at least two collections, and attribute the allocations to a source
rather than watching an aggregate counter. If you cannot name what is
allocating, you cannot say whether it is bounded.

Corollary for anything counted by `Performance.getMetrics`: those are aggregates
over the whole page. `JSEventListeners` includes the harness's own listeners,
and it is the *browser's* count, so it drops when GC runs and not when your code
releases something.

**The wider rule, which applies to every counter-based probe in this project:
counting cannot distinguish a leak from correct cleanup observed mid-cycle, and
attribution can.** "The number went up by 13" and "13 `onended` handlers were
registered, 7 by the audio graph arming once and 6 by vehicle passes, each of
which disconnects its own node graph" are the same observation, and only the
second one answers the question. Aggregate counters tell you *that* something
happened; they never tell you *what*, and *what* is the entire content of the
judgement you are about to make. Before you believe an aggregate, make it name
its sources — usually by wrapping the allocation site and keeping a stack for
the first few of each kind, which is cheap enough to leave switched on
permanently (`tools/perf-instrument.js` does exactly this for listeners and for
GL allocations over 2 MB).

## An experiment can silently not run and report the baseline twice

Playwright's `page.evaluate(str)` evaluates the string as an **expression**. Pass
it `"() => window.__PERF.setLights('none')"` and it dutifully creates a function
object, returns `undefined`, and calls nothing. The sweep then measured the
unmodified page under six different labels and printed six plausible, nearly
identical rows — the lighting A/B "showed" that disabling all 21 lights saved
nothing, which is a perfectly interesting-sounding finding.

The tell was `fxResult: undefined` in one record. That is the only difference
between this and a working run, and it is easy to skim past because the
interesting columns all have numbers in them.

Generalisable: **an experiment harness must verify that the manipulation
happened, not merely that the run completed.** Every effect function now returns
a description of what it changed (`{ hidden: 10, kept: 11 }`), the sweep treats
a `null`/`undefined` return as a hard error, and the returned value is printed
next to the row. An A/B where the "B" leg quietly no-ops does not look broken;
it looks like a negative result, and negative results are exactly what one tends
not to re-examine.

## A tolerance is meaningless until it is converted into the units the feature lives in

The puddles were clipped by testing the ground height against the water level
with a tolerance band of 55 mm. Fifty-five millimetres sounds like a tight
number. Written next to a water surface it reads as "the shoreline is accurate
to a couple of centimetres", and it survived review on that basis.

The dishes it was applied to are 60 to 90 mm deep and about 5 m across. Measured
at the waterline (`.shot-build/shoreline.mjs`) the pavement falls between 15.5
and 28.6 mm per metre. So the band was not 55 mm of anything the viewer can see.
It was **two to three and a half metres of ground** — comparable to the radius
of the puddle. The entire pool was transition. That is why it rendered as an
airbrushed blob, and no amount of adjusting the noise, the colour or the
roughness was ever going to fix it, because the defect was not in any of those.

The conversion is one division and it was never done:

    horizontal extent of the band = tolerance / local slope
    0.055 m / 0.0155 m per m = 3.5 m

The same error is available anywhere a threshold is expressed in one unit and
seen in another. A 2-degree angular tolerance on a surface 40 m away is 1.4 m of
position. A 1% depth-buffer margin is metres at the far plane and micrometres at
the near one. A "5 mm" weld gap on a part modelled at 1:10 is 50 mm on screen.
In every case the number in the source is not the number in the frame, and the
one in the source is the one that gets reviewed.

Generalisable: **before accepting a tolerance, divide it by the local gradient
of whatever it is a tolerance on, and check the result against the size of the
feature.** If the answer is a significant fraction of the feature, the tolerance
is not tight, it is the whole feature. Where the gradient is not obvious,
measure it — the number above came out of a twenty-line script that prints depth
and slope along the axes of each low spot, and it converted an argument about
aesthetics into an arithmetic fact in one run.

Related: "'Below the sampling rate' is a measurement, not a default explanation"
and "A count is not a size, and `renderer.info` reports counts" — both are the
same shape, a quantity accepted in the units it was written in rather than the
units the question is asked in.

## A texture sampled far above its design frequency is correct at nadir and constant at grazing incidence

The waterline is displaced by a world-space noise so the margin is ragged rather
than a smooth analytic contour. The first version drew that displacement from
`uMacro`, the shared macro-breakup texture, at `wxz * 0.9` and `wxz * 3.3`, i.e.
world periods of about 1.1 m and 0.30 m.

It rendered a perfectly smooth edge. The code was correct, the uniform was bound,
the arithmetic was right, and the feature did nothing.

`uMacro` is a 512 px tile mapped over tens of metres — `uMacroScale` is
`1 / macroMetres`, around 1/78. Asking it for metre-scale features samples it at
roughly fifty times its design frequency, which is legal and looks fine in a
nadir test frame. At grazing incidence it dies. The footprint of a screen pixel
on a near-horizontal surface is enormously elongated; the sampler resolves that
by walking up the mip chain; and the top of a mip chain is the mean of the tile.
The tap returns very nearly the same number everywhere, so
`(e - 0.5) * amplitude` becomes a **constant offset** to the threshold. A
constant offset to a threshold moves an edge uniformly and does not roughen it.

The trap is the incidence dependence. Ground surfaces are authored and inspected
from above and seen from eye height, so a defect of this shape passes every check
made while writing it and appears only in the shipped view. Worse, it is silent:
the source still says the edge is broken up, so the natural next move is to
increase the amplitude, which does nothing either, and then to conclude that the
displacement approach is wrong.

Fixed by replacing the tap with two domain-warped sine products evaluated in
world space (`wdWobble` in `src/gen/worldDetail.ts`). No texture, no mip chain,
nothing to average away, and it costs four `sin` calls.

Generalisable, three parts:

1. **A texture has a design frequency**, set by its resolution and the world
   extent it is mapped over. Sampling far above it is not "more detail", it is
   detail the mip chain will remove for you at the first oblique angle.
2. **Judge any world-space noise at the incidence the surface is actually seen
   at.** For ground that is grazing, always, and grazing is the worst case for
   footprint elongation.
3. **A term that silently degenerates to a constant is worse than one that
   errors**, because the source keeps asserting the feature exists. Where a term
   is meant to vary, it is cheap to check that it does — sample it at two nearby
   points in a debug view and show the difference, rather than showing the value.

Related, and the same underlying hazard: "An experiment can silently not run and
report the baseline twice", and "A term that cannot reach its target at 8x is in
the wrong place, not too weak". In all three the code says the feature is
present, the pixels say otherwise, and the natural response — turn it up — is
the one that cannot work.

## A compensation outlives the bug it compensated for, and becomes the bug

Three of these turned up in two sessions on the car, all with the same shape,
and the shape is worth naming because the codebase will keep producing them.

Someone finds a surface that looks wrong. They cannot find the cause, or the
cause is in a file they do not own, so they put a corrective term nearby: a
colour multiplier, a lowered `envMapIntensity`, a heavier dust layer. The
render now looks right, so the correction is committed and the comment beside
it — if there is one — describes the *symptom* it cured, not the *bug* it was
standing in for.

Later the real bug is fixed at source. The correction is now pure error, of
the same magnitude, in the opposite direction. Nothing fails. Nothing warns.
The surface just looks wrong again, differently, and the next person to look
at it has no reason to suspect the innocuous-looking parameter three layers
away from the thing they are staring at.

The three, in the order they were caught, and note how the detection cost rose
each time:

| compensation | for | how it was caught |
|---|---|---|
| `color: Color(5.4, 5.4, 5.4)` on the tyre | albedo delivered 6x dark | one line, its own comment said "workaround"; removed the hour the source fix landed |
| `envMapIntensity: 0.42` on the tyre, and eight values above 1.0 elsewhere | a flat/absent environment | a sweep, prompted by someone noticing the 0.42 was hand-tuned |
| `dust: 0.30 + 0.20 * roadFilm` at `0x6e6f72` on the tyre | the same 6x-dark albedo | **not caught by measurement at all** — only by looking at a sunlit pose and seeing tan tyres |

The third is the instructive one. It was not recognisable as a compensation:
it is a plausible dust parameter in a weathering block, and its value is not
obviously wrong for dust. It only became wrong because the surface underneath
it changed by 6x. And the measurement that should have caught it did not,
because the pose it was measured in was shaded — see below.

**When a bug is fixed at source, someone must go looking for the compensations
that were authored while it was live.** This is not optional tidying and it
does not happen by itself. A compensation is *indistinguishable from intent*
once it is committed — a dust coefficient, a colour multiplier, an intensity —
and the only person who can tell them apart is the one who knows a bug was
live when they were written. That knowledge expires. Fixing a shared generator
without sweeping its consumers converts every compensation downstream into a
new defect of equal size and opposite sign, and hands it to someone with no way
to recognise it.

**What to do.** When you write a corrective term, say in the comment what you
believe the underlying bug is and where, not what the correction achieves. A
comment reading "compensates for makeTyreSkin delivering ~6x dark" is greppable
the day that file changes; "lifts the tyre out of black" is not. And when a
shared generator is fixed, do not only remove the corrections that announce
themselves — go and re-measure every surface that consumes it, because the
corrections that do not announce themselves are the ones still there.

## A single pose is not a measurement of a material

The corollary, and the more expensive half of the case above.

The tyre was measured in `wheel_close`, went 3.1 to 10.7, and was recorded as
fixed. In `side_sun` the same tyre was at **78.0** — pale tan, brighter than
the asphalt beneath it, which no tyre has ever been. Both numbers were correct.
`wheel_close` looks into the wheel arch, which is shadowed, so it measures the
material's behaviour under almost no direct light; the dust layer that was
dominating the surface contributes nearly nothing there and everything in sun.

A material has at least two regimes — lit and shadowed — and a parameter can be
badly wrong in one while correct in the other. The pose that shows a fix is
usually the pose the fix was aimed at, which is exactly the pose least likely
to reveal what the fix broke.

**A material measured only where it is dark cannot be judged at all**, and the
remedy is a lit pose rather than a better metric. No refinement of the
statistics gathered in `wheel_close` would ever have produced the tan tyres,
because the information was not in those pixels. This is the uncomfortable part
of the case above: the stale dust compensation was found **by looking**, and no
measurement anyone ran caught it or could have.

Measure any material change in at least one lit and one shadowed pose. Both
were already available; nobody ran the second one.

## Ranking two surfaces is a stronger test than measuring either

**Comparing two surfaces in the same frame is a stronger test than measuring
either one, because it needs no exposure reference, no tone-curve assumption
and no agreed target.** If you are arguing about an absolute value, you are
arguing about the exposure and the tone curve as much as about the surface,
and that argument does not converge. Find a ranking instead.

What actually broke the deadlock on the car's paint, after a lot of careful
absolute measurement that led nowhere.

The car's body measured a median of 45.6. Is that too dark? Unanswerable in
isolation — it depends on the exposure, the sun angle, the tone curve and the
intended colour, and every one of those is arguable. A grey-card substitution
gave an effective reflectance of 0.034, which is better, but still needs a
target to compare against.

Then: the **tyre** in the same frame measured 78.0, an effective 0.047.

The car was darker than its own rubber. That needs no exposure, no target, no
tone-curve arithmetic and no agreement about what colour the car is supposed to
be — it is simply not a thing that occurs, and it immediately says which of the
two surfaces to move. Two rounds had been spent looking at the tyre because the
tyre was the surface that *looked* wrong; the ranking said the tyre was roughly
right and the body was not.

Look for orderings that hold regardless of exposure. Paint above rubber. Road
above rubber. Sky above ground. Lit above shadowed. They cost nothing to check
once two surfaces are masked, they survive every change to the lighting, and
they point at a specific surface instead of yielding a number to argue about.

## A material transition keyed on a binary mask reads as a cut

The puddles reflect the environment. The first version keyed that reflection —
roughness, Fresnel, and the flattening of the water normal — on the pool
coverage mask, which is the obvious thing to key it on: it is exactly the set of
pixels that have water on them.

It rendered as sheet metal. One flat pale tone with a hard boundary, sitting on
the ground rather than in it.

The reason is that coverage is binary a centimetre either side of the shoreline.
Keying a mirror on it puts full glass immediately against dry grit, and no
amount of adjusting the two end states fixes a transition that has no middle.
Every knob available — reflection strength, roughness value, edge softness,
noise on the mask — changes one side or the other or blurs the join, and
blurring the join is the airbrush this system already learned to avoid.

The fix was not a better mask. It was noticing that the physical quantity is not
"is there water", it is **how deep the water is**, that depth was already being
computed one line earlier to decide coverage, and that it is continuous. Water a
millimetre deep over asphalt is asphalt with a sheen; the same water 30 mm deep
is a mirror. Grading roughness, Fresnel and the normal over the first 18 mm of
depth — which on these slopes is the first half-metre inside the margin —
produces a gritty damp shore reading into a reflective middle, and that gradient
is most of what makes it read as a dish with water in it.

Generalisable: **when a material transition looks like a cut, check whether the
mask driving it is a thresholded version of something continuous.** It usually
is, because masks are convenient and the underlying quantity is often computed
and then immediately discarded. Recovering it is nearly free and it is a better
fix than anything that can be done downstream of the threshold, because
downstream you are choosing between two values and the problem is that there
ought to be a range.

The same shape recurs well beyond water. Wear keyed on "is this a wheel path"
rather than on distance from the path centre. Dust keyed on "is this surface
horizontal" rather than on the surface normal's Y. Weathering keyed on "is this
edge exposed" rather than on ambient occlusion. In each case the binary version
is the cheap read of a quantity that was continuous a moment before, and in each
case the tell is the same: a boundary the eye can trace.

Related: "Hard edges do not make damage discrete", which is the same error
observed from the other end.

## A threshold tuned against a distribution is a percentile, whatever its units say

> **Read the exception with the rule.** There is a genuine counterexample at the
> end of this case, in `tools/framescan.mjs`. This rule fires on thresholds
> calibrated against a *population*; it does not apply to thresholds that encode
> a *physical* boundary. Within hours of this case being written the rule was
> aimed at a clause it did not cover and would have broken a working detector.
> The test for which kind you are holding is at the bottom.

Third instance tonight, in three unrelated systems, so it is worth naming.

**The rule: a threshold tuned by looking at results is a percentile of the
distribution it was tuned against. It keeps its absolute-looking units and
silently becomes a different percentile the moment that distribution moves.**
Nothing warns you, because the number in the source has not changed — and the
number in the source is the only thing anybody reviews.

The three:

- **Vegetation, ground contact decals.** `sites.filter((s) => s.size > 0.44)`,
  written and read as "clumps big enough to cast a visible contact shadow". The
  clump size distribution had mean 0.42, so it was really "the top third". When
  the clumps were rescaled to knee height, mean 0.73, the same line started
  selecting nearly every clump: decals went 945 → 1,834 and cost +40k triangles,
  more than the clump-count reduction had just saved. Nothing failed; the
  triangle total simply went up while the change was supposed to bring it down.
- **Terrain, puddle tolerance.** A 55 mm depth tolerance, which sounds tight and
  physical, was two to three metres of *ground* once divided by the local
  gradient. The units were millimetres of water; the quantity that mattered was
  horizontal extent, and the conversion factor was a property of the terrain.
- **Building, bollard dent half-width.** Justified in a comment as "a bumper
  flattens 100–200 mm" and implemented at two to three times that. The
  justification was a real measurement of a real thing; the number in the code
  was tuned by eye until the dent looked right and then wore the justification.

Two different mechanisms, same failure: in the first the population moved under
a fixed number, in the second and third the number was never in the units its
justification was in. Both produce a threshold whose stated meaning and actual
meaning have come apart, and both are invisible to review, because the comment
explains the intent and the intent is fine.

**What to do about it.** When you tune a threshold by looking at output, write
down the statistic you were actually targeting next to it — "top third of
clumps", "about 2 m of shoreline", "half the bumper's contact patch" — and,
where it is cheap, assert it. A line that says `filter(s => s.size > 0.82)`
tells the next reader nothing; one that also reports how many of the population
passed will fail loudly the day the population moves. Vegetation's `groundMats`
count in `__VEGETATION` is that assertion by accident, and it is the only reason
the regression was caught between two captures rather than shipped.

The related shape already recorded above — a filter applied before a statistic
is part of the statistic — is the same idea from the measurement side. This is
it from the authoring side.

## Parameters that look independent in the source are coupled in the geometry

The car body was widest at the shoulder and tapered inward 86 mm to the rocker,
which is backwards for a car, was shadowing its own lower flank, and was hiding
the sills behind a 43 mm overhang. The fix looked like a two-constant change:
move the sill station out, reduce the mid-flank setback.

Every number it was designed to move, it moved:

| | before | after |
|---|---|---|
| lean, shoulder to rocker | 86 mm | 40 mm |
| section y 0.30 to y 0.90 | monotonic taper | near-vertical |
| sill vs body above it | -43 mm | +3 mm |
| overall width | 1842 mm | 1842 mm |
| non-finite vertices | 0 | 0 |

**And the render was worse.** The lower body had moved out 46 mm per side while
the wheel track and the arch openings had not moved at all, so the bodywork
overhung the wheels, the arches became tunnels and the alloy faces disappeared
into them. The car read as though skirts had been fitted.

**The lower body width, the wheel track and the arch opening width are one
decision.** They appear in the source as three unrelated numbers in three
functions. Moving one alone does not make the shape a bit wrong; it converts a
proportion problem into an occlusion problem, which is a different and worse
class. This project has been bitten by this repeatedly - a part's offset and
the tessellation of the surface it sits on, a material's albedo and the dust
layer over it, an environment's intensity and every `envMapIntensity` tuned
against it - and the common shape is that the coupling is real in the geometry
or the render while the source presents the terms as separable.

Before changing a shape constant, ask what else has to move with it. If the
answer is "nothing", check that against the render rather than against the
metric, because:

**A metric that improves while the thing it stands for degrades is the most
dangerous kind of success available here.** The profile was not wrong; it
measured the lean and the lean genuinely halved. It simply did not measure
wheel occlusion, and nothing said it did not. Every metric in this repo stands
for something larger than itself, and the gap is where this class of failure
lives. The counter is cheap and this project keeps relearning it: look at the
frame. The regression was obvious in one glance at a pose already being
captured.

The corollary for tooling: `probe-unseen` caught this independently, reporting
three wheel caps that had been drawing as newly at 0 px. **An absence check is
a better regression gate than a quality metric**, because absence is
unambiguous and needs no target to compare against - the same reason a ranking
beats an absolute value. It is now wired as a gate for exactly this reason.

## A surface that reads unlit has the wrong slope, not the wrong amplitude

A reviewer working from frames alone said of the ground beyond the lot that
"the plane is so flat it takes no relief lighting at all". It was not flat. It
carried two height terms, one of them several metres tall. The reviewer was
still right, and the reason converts into a number that anyone can check in a
minute.

Shading responds to the angle between a surface and the light. For a surface
described by a height field, that angle is set by the **slope**, and slope is
amplitude times spatial frequency. So the question to ask about any relief is
not "how tall is it" but "how tall is it over how far", and the answer only
means anything when compared against the light:

    characteristic slope  =  amplitude / (wavelength / 2)
    solar tangent         =  tan(sun elevation)

If the slope is far below the solar tangent, every surface faces the light at
within a fraction of a degree of every other surface, the shading term returns
the same value everywhere, and the surface reads as a plane no matter how much
vertical relief it actually has. If the slope brackets the solar tangent, some
faces turn toward the light and some turn away, and shadow terminators appear.

The terrain case, with a sun at 11 degrees:

| term         | wavelength | amplitude | slope  | vs 0.194 |
| ------------ | ---------- | --------- | ------ | -------- |
| broad swell  | 600 m      | 2-4 m     | ~0.006 | 1/32     |
| undulation   | 78-100 m   | 0.42 m    | ~0.006 | 1/32     |
| added term   | 16-31 m    | 0.5 m     | 0.10-0.20 | ~1    |

Four metres of relief did nothing and half a metre fixed it. **Amplitude is the
wrong knob. Wavelength is the right one**, because halving the wavelength
doubles the slope at no extra height, and height is what costs — it moves
silhouettes, it makes things intersect, and past a point it stops looking like
the thing being modelled.

The failure mode is easy to fall into because the loop is: surface looks flat,
increase the amplitude, look again, it still looks flat, increase it more. Each
step is reasonable and the whole sequence is wrong. Nothing in it computes a
slope, and the slope is the only quantity that was ever going to move.

This is not a terrain result. Any surface lit by a low sun is subject to it:

- Foliage clumps that are individually rounded over a metre read as one mass
  if the mass's own envelope varies by centimetres over that metre.
- A wall's rustication, panel joints or block coursing reads as a printed
  pattern rather than as relief if the depth-over-spacing ratio is under the
  solar tangent — which for shallow reveals at a low sun it usually is, and it
  is why a facade can be full of modelled detail and still look like wallpaper.
- A canopy fascia, a curb, any long horizontal element: the slope of interest
  is the one across its visible face, not the one along its length.

Two practical corollaries. First, the check is cheap and does not need a
render: divide the amplitude by half the wavelength and compare to
`tan(elevation)`. Second, a low sun makes the test *easier* to pass, not
harder — a solar tangent of 0.194 is a low bar, and a surface that fails it at
dawn is failing by an order of magnitude, not by a little.

### The indoor form of the same test, which is a different question

Applied indoors the slope-versus-solar-tangent form gives the wrong answer, and
it gives it confidently. The gondola spine in the shop was rebuilt into 48 mm
uprights at 914 mm centres standing 16 mm proud of a set-back panel: 16 mm over a
457 mm half-spacing is a characteristic slope of **0.035 against a solar tangent
of 0.109**, a fifth of the bar, so the outdoor test says "too shallow, deepen the
relief". Deepening it would have bought essentially nothing, because the real
problem is not the depth.

**Indoors the light is overhead, and every face that relief creates is vertical.**
The uprights' sides face along X, the panel faces along Z; both are plumb, so
under a near-vertical source they differ in *azimuth only* and every one of them
receives the same near-zero cosine. There is nothing wrong with the amount of
relief. It is relief **oriented for a horizontal light and lit by a vertical
one**, and no amount more of it changes the orientation.

So the general statement, of which the solar-tangent form is the outdoor special
case:

> **Does this relief create faces that differ along the light's dominant axis?**

Outdoors the dominant axis is near-horizontal, so a *vertical* step across a
surface differentiates and the test reduces to depth over spacing versus
`tan(elevation)`. Indoors under ceiling fittings the dominant axis is vertical,
so what differentiates is a **horizontal, up-facing return** — a shelf nose, a
proud rail, a reveal with a soffit — and depth over spacing is close to
irrelevant. The cooler end return reached the same conclusion independently and
from pixels: its one horizontal return facing up into the troffers is what broke
a 380 × 520 px flat slab, and it worked "because of the direction the face
points, not because of any shading trick".

The trap is that the outdoor test still *returns a number* indoors, and the
number points at the wrong fix. A test whose assumptions have quietly changed is
more dangerous than no test, because it launders a guess into a measurement.

### And the second half, which the first build got wrong

Orienting the relief correctly is necessary and **not sufficient, because an
up-facing face still needs something above it to face.** Four horizontal rails
were added across the gondola back panel on exactly the reasoning above. Measured
against a same-bundle control they lifted their own rows by **+2.3 luma on a mean
of 108** — right sign, right place, negligible. Each rail sits 320 mm under the
next shelf, which projects 500 mm out over it, so the unobstructed wedge from the
rail's top face runs from the horizon up to `atan(320/500)` = 32.6 degrees and
forward only: cosine-weighted, about **7% of a hemisphere**. A return with 7% sky
access returns 7% of the effect.

Moving the same idea to the one place on a gondola with an open view of the
ceiling — the top capping edge, nothing above it — changed **5.74% of the frame
at a mean delta of 74.9, with the changed pixels split 40,027 brighter to 42,674
darker**, which is what relief looks like: a lit top face and a shadowed
underside. Same mechanism, same material, same light, **80 times the footprint**,
and the only difference is what the face can see.

So the indoor test has two parts, both arithmetic and neither needing a render:

> **Does this relief create faces that differ along the light's dominant axis,
> and what fraction of the sky can each of those faces see?**

This is Canopy's finding in miniature. It measured its soffit at luma 27.9,
darker than the highway underneath it, and found that raising the light level
twice did not help — the signal that the mechanism was wrong rather than the
magnitude. **A surface-mounted fitting is a downlight and never lights the panel
it is bolted to**, and a shelf is a downlight for everything beneath it. Any
interior has this problem wherever a fixture or a shelf is flush to the surface
meant to be lit.

Related: "A texture sampled far above its design frequency is correct at nadir
and constant at grazing incidence", which is the same class of error — a term
that varies in principle and does not vary in the frame — arriving through
mipmapping instead of through geometry.

## When more of a quantity does not help, the mechanism is wrong, not the magnitude

The canopy soffit is the largest single surface in the scene and the first round
put it at **40.4% of the frame at luma 27.9** — darker than the highway it
stands over, with a p10..p90 of 13..22, which is to say 40% of the frame with no
information in it. The bake driving it was raised from 1.0 to 2.2. The soffit
got brighter. It did not get any more legible: still a flat field with eight
bright rectangles stuck on it.

**That second unsuccessful increase is the signal, and it is worth treating as a
formal one.** A term that is the right mechanism at the wrong strength gets
better monotonically as you turn it up, and it gets better in the way you
predicted. A term that is the wrong mechanism gets *bigger* and stays wrong,
because what is missing is not amplitude but spatial structure, and no scalar
multiplies structure into existence.

Here the mechanism error was physical and obvious in hindsight. The bake modelled
the eight soffit fixtures as throwing pools of light onto the panel around them.
They do not: a surface-mounted fitting is a **downlight**, it throws at the cars,
and it puts almost nothing on the panel it is bolted to. There was never a pool
there to find, so every increase was scaling a term that had the wrong *shape*
regardless of its size. What actually lights a canopy underside at dawn is sky
and sunlit-slab bounce entering under the fascia at a grazing angle, which
produces a strong gradient from a bright perimeter to a dim centre over a couple
of metres — the structure every photograph of a canopy underside has, and the one
the bake did not contain. Rebuilt around that, with the lamps demoted to a tight
collar where the housing meets the panel, the soffit measured **148.4** and took
its correct place in the frame's tonal order, above the concrete slab at 46.0 and
the highway at 42.2.

The general form:

| symptom | likely reading |
| --- | --- |
| turning it up helps, roughly as predicted | right mechanism, wrong magnitude |
| turning it up changes the level and not the *pattern* | wrong mechanism |
| turning it up helps, then reverses | right mechanism, now clipping — check where your product lands on the tone curve (case 42) |
| turning it up does nothing at all | it is not bound (case 26), or another system owns it (case 40) |

Those last two rows matter because they are the failures this document already
catalogues, and they are **not** this one. An inert or overwritten uniform
produces a byte-identical frame; a wrong mechanism produces a frame that
visibly responds and still does not improve. The diagnostic that separates them
is free: if the frame moved, the plumbing is fine and the argument is about
physics, so stop adjusting and go and work out what actually illuminates the
surface.

This is the general case of "A surface that reads unlit has the wrong slope, not
the wrong amplitude", which is the same rule for the specific instance where the
mechanism is relief against a low sun — four metres of terrain amplitude did
nothing and half a metre at a shorter wavelength fixed it. Both entries describe
a loop that is individually reasonable at every step and wrong as a whole:
*surface looks wrong → increase the obvious number → look again → increase it
more.* Nothing in that loop ever asks what the number is a coefficient **of**.

Two operational rules, both cheap:

- **Budget two increases, then stop.** Not because the third could not work, but
  because by the third you have paid for two rounds and learned one bit. The
  brief's standing rule — *if a round fails twice the same way, question the
  premise rather than iterating* — is this rule stated in advance, and the
  monotone test is how you tell that a round has in fact failed "the same way"
  rather than merely failed.
- **Name the physical mechanism out loud before turning any knob.** "Light from
  the fixtures reflecting off the panel" survives being said aloud a lot less
  well than it survives being typed as `pool += 1.05 / (1 + d2 * 2.35)`. The
  sentence is checkable against reality; the expression only looks plausible.

A note on why this went unnoticed for two rounds. Both intermediate states
*looked* better in isolation — dark grey became mid grey became bright — and a
reviewer shown any one of them would have said "brighter, good". The thing that
made the failure legible was `probe-rank`, which reported the *tonal order* of
the surfaces rather than the level of one of them: at luma 74 the soffit was
already brighter than it had been and still ranked below the asphalt, which is
impossible for white paint under lamps and is a defect statement no exposure
change can overturn. **Ranking survives the intermediate states that fool an
absolute measurement.**

## A term that stands in for another system's quantity has to scale with it

The canopy soffit is lit by a baked `lightMap`, and the thing that bake
*represents* is sky and sunlit-slab bounce entering under the fascia — an
environment quantity that Lighting owns and this system does not. It was
authored as a constant. When Lighting moved `scene.environmentIntensity` from
1.0 to 2.4, `probe-rank` reported:

| surface         | env 1.0 | env 2.4 | ratio |
| --------------- | ------- | ------- | ----- |
| forecourt slabs | 30.8    | 45.9    | x1.49 |
| highway         | 28.2    | 42.0    | x1.49 |
| canopy columns  | 111.7   | 135.6   | x1.21 |
| canopy soffit   | 139.2   | 148.3   | x1.07 |
| fixture lenses  | 219.4   | 220.6   | x1.00 |

**The soffit was the only surface in the frame that did not respond to a global
lighting change.** Nothing looked wrong in either frame. The defect is that the
soffit's *rank* drifts every time somebody retunes the environment — it was 4.5
times the slab at env 1.0 and 3.2 times at 2.4 — so a bake that was correct when
it was calibrated slowly becomes incorrect through no edit of its own, and
whoever notices will recalibrate a bake that was never wrong.

This is the **mirror of case 40**, and the pair is the useful part:

- Case 40: a value was read perfectly well and then **overwritten** by the
  system that owns the property. Detected by grepping for other writers.
- This: a value that **should have been owned** by another system was silently
  independent of it. A grep finds nothing, because there is no second writer —
  the whole problem is that there isn't one.

The lens emissive in the same table is the control that makes the argument
precise. It is also constant, and it is *correct* to be constant, because a lamp
does not dim when the sky brightens. So the rule is not "couple everything":

> **Ask what physical quantity your term stands in for. If another system owns
> that quantity, your term is a coefficient of theirs, not a constant.**

The fix is two lines — read `scene.environmentIntensity` at init, divide by the
value the bake was calibrated against, multiply — and it comes with two things
worth stating. First, one documented approximation: the lamp-collar term is in
the same map and therefore also scales, which is wrong, and it is accepted
because the collar covers roughly 200 mm around each of eight housings on a
13 x 13 m deck while splitting it out costs a second map and a second UV
binding. Say which way an approximation is wrong, in the file, next to it.

Second, a hazard created by the fix. Reading `scene.environmentIntensity` is
reading **another system's side effect**, not a service, and it works here only
because Lighting is registered first. If Lighting ever fails before writing it,
this system reads three's default of 1.0 and quietly under-bakes by a factor of
2.4 with no error anywhere. The mitigation is not a comment: the value and the
bake level derived from it are both in `window.__CANOPY`, so the round's own
report shows the coupling. **A value borrowed from another system should appear
in your self-report, because that is the only place a reader can check that the
borrowing worked.**

## Playwright swallows exceptions thrown by init scripts, so a probe dies halfway and reports zeros

`document.documentElement` **is null inside `page.addInitScript`**. Measured, not
inferred: `readyState` reads `"loading"` and `documentElement` reads `NULL`.

So a probe written in this obvious order silently loses its second half:

```js
window.__LOAD = { t0: performance.now(), marks: {}, frames: [] };   // survives
window.addEventListener("scene-ready", ...);                        // survives
new MutationObserver(fn).observe(document.documentElement, {...});   // THROWS
let last = performance.now();                                        // never runs
requestAnimationFrame(tick);                                         // never runs
```

`observe(null)` throws `TypeError: parameter 1 is not of type 'Node'`, and
**Playwright swallows it** — nothing reaches `pageerror`, nothing is logged, the
run continues to completion and exits 0.

Eight consecutive loads were measured this way. The scene rendered 235 frames per
load; the probe reported an empty frame array every time.

### Why it read as a working instrument rather than a broken one

Everything established *before* the throwing line survived, and those were the
parts that looked like proof of life. `window.__LOAD` was readable with plausible
fields. The `scene-ready` mark was not just present but **correct**, at 185.9 s
cold and 18.8 s warm, because a listener added to `window` needs no document.

Then the derived figures laundered the absence into numbers:

- `Math.max(...[])` is `-Infinity`, printed as `-Infinity ms` and easy to skim
  past as a formatting quirk.
- An unset mark divided by 1000 and `.toFixed(1)` prints **`0.0 s`** — a
  measurement of nothing wearing the units of the best possible result.
- "Walkable: never" was reported for every condition, which reads as a finding
  about the scene rather than as an instrument that took no samples.

### The diagnosis came from the ordering, not from the values

Three instruments, two dead and one alive, and **the boundary between them was
exactly the line that threw**. Nothing else explains a correct `scene-ready` mark
sitting beside an empty frame array. When a script can die halfway, the set of
things that still work localises the death to a statement.

### What to do instead

Inject after the navigation commits — `page.goto(url, { waitUntil: "commit" })`
then `page.evaluate(recorder)`. The document exists, an exception surfaces as a
rejected `evaluate` in Node, and `performance.now()` still measures from the
document's time origin so no precision is lost.

Then guard on **liveness rather than value**: carry the sample count through, and
return `null` for every derived figure when it is zero. `null` prints as an em
dash; zero prints as good news. Note the asymmetry that makes this worth the
trouble — a broken instrument and a fast scene produce the same output, and only
one of them is worth reporting.

Corollary, from the same session: the very next version of this file failed with
`ReferenceError: PROBE is not defined` and stopped in four seconds. **Identical
class of mistake — a reference to something that is not there — and it was
instantly loud, because it happened in Node instead of inside an init script.**
The mistake was not the problem. The place it was allowed to happen was.

## A check that validates the wrong layer: three independent witnesses in one night

Three agents, three unrelated systems, one shape. In each case a check existed,
ran, passed, and was inspecting something one level away from the thing it was
believed to be inspecting.

1. **A pair assertion that could not fail.** It compared a quantity against
   itself rather than against its partner, so it validated arithmetic rather than
   agreement.
2. **Vegetation compared flag echoes.** The assertion read back the *setting it
   had just written* rather than any consequence of it, so it proved the
   configuration mechanism worked and said nothing about the geometry.
3. **A `--port N` default that resolved to `NaN`.** Written as
   `argv[argv.indexOf("--port") + 1]`, which for an absent flag is `argv[-1 + 1]`
   — the node executable's path. `node --check` passed, the syntax was fine, the
   override path worked, and **the default path, the one nobody passes a flag
   for, was the broken one.** Caught only by printing the resolved value.

### What the three have in common

Each check was one level too shallow. Syntax instead of value; the setting
instead of its effect; a quantity instead of a relationship. And each is
*persuasive at the layer it does test* — the syntax really is valid, the flag
really was set, the arithmetic really does hold — which is why all three passed
review by the person who wrote them.

The practical rule: **assert on the thing downstream of the mechanism you are
worried about.** Not that the flag was set, but that behaviour changed. Not that
the file parses, but that the value came out right. Not that a number equals
itself, but that two numbers that must agree do. If a check would still pass with
the feature ripped out, it is testing the wrong layer.

The default-argument case has a corollary worth its own sentence: **the path with
no flag on it is a path, and it is the one that runs in production.** Overrides
get tested because you type them; defaults get tested because someone thought to.

## A rule written down is not a check, and the part you add next is not covered by it

Two hours after writing the case-43 entry above — whose entire argument is that
an inverted surface must be caught by a build-time assertion rather than by a
capture — three new outward-facing parts went into this system and **only their
positions were asserted**. The overflow stains are hand-wound from explicit
corners, which is the single most likely place in the file for a winding to be
backwards, and a backwards one is invisible rather than wrong.

They turned out to be correct. That is luck, not process, and the omission is
the finding:

> After adding a part, ask which existing assertion covers it. If the honest
> answer is "the one I wrote for a different part", it is not covered.

The generalisation past winding: every check in this repo was written against
the part that motivated it, and a check's coverage is the set of parts it
actually iterates over — which is a much smaller set than the failure mode it
was written to defend against. The fascia winding check named the fascia. It
would have gone on passing forever with four inverted stains beside it.

Worth adding while extending it: the closed-volume trap from case 43 bit again
immediately. The scupper sleeves are `roundedBox` solids, their mean face normal
is exactly **0.000** by construction, and the freshly written test reported a
failure that did not exist — the third time tonight a probe has been wrong about
a part rather than the other way round. Hand-wound open quads are the parts that
need this test; shared solid helpers are proven by anything at all being
visible.

## An element is sized against the pose it is read from, and one system's elements have different ones

The delivered-pixel table for the canopy signage covers four elements. The
first version of the gate measured all of them from the fascia poses, reported
the column plate at **3.8 px** and failed. The number was true and the check was
wrong: nobody reads a 360 mm plate screwed to a column from 15 m across the lot.
From `at_pump`, which is where somebody putting fuel in a car actually stands,
the same plate delivers 19.4 px and reads.

This sits directly under Building's finding that **the resolution budget is per
element, not per texture** — its 74-texel masthead delivered 19 screen pixels
and read, while a body line in the same texture delivered 3.9 and did not. The
addition is that **the viewing distance is per element too.** A single pose list
applied to every element on a system silently imports the fascia's viewing
distance into a decision about a hand-height plate, and the failure is
symmetrical: size the plate for the road and it becomes absurd up close.

The bands used, all from other systems' measurements rather than from taste:

| delivered px | reading |
| ------------ | ------- |
| under 6      | gone; averages to a flat tint |
| 6 to 14      | a shape, not words — where a logo mark has to carry it |
| 14 to 50     | reads as words |
| over 50      | reads; a failure here is contrast, not size (Car) |

**Third term, from Building's handheld bottle: on a curved surface the delivered
pixels are not evenly distributed across the artwork.** A wrap label shows about
180 degrees of its circumference, but only the middle 120 or so is legible —
beyond that the texels compress toward the silhouette faster than any anisotropy
setting recovers. **The readable width of a wrap is roughly a third of its
circumference**, so a masthead authored to the full panel width puts its first and
last letters exactly where they cannot be read. "CLEARSPRING" at 0.86 of the panel
delivered as "PRING"; at 0.56 it delivered whole, in the same texture at the same
distance with nothing else changed. The band table above is in delivered pixels
and stays valid — but the budget has to be computed against the **legible arc**,
not the printed one, and nothing about the canvas reveals which is which.

A companion to it that is invisible in source rather than in pixels:
`CylinderGeometry` lays `u = 0` on +Z and runs through +X, so `u = 0.5` lands on
-Z. A camera looking at the object from -Z therefore frames the **seam** of a full
wrap dead centre. An atlas cell on a box has no orientation to get wrong, so the
first object whose artwork has a *front* is the first place this can bite, and it
presents as artwork that bound correctly, prints correctly, and is nonetheless
showing the wrong part of itself.

Two corollaries. **Cap height and glyph width fail differently.** An oblique
view foreshortens width and leaves cap height almost untouched, so folding
obliquity into one number reports a legible sign as illegible when it is merely
seen at an angle; the canopy table carries the width factor in its own column
and the wordmark is 22.0 px tall at a width factor of 0.53 on the approach.
**And delivered pixels above the texels backing them is magnification**, which
is mush however large the delivered figure looks — so the gate is a pair, not a
floor: at least 14 delivered, and never more delivered than authored.

The construction that makes this cheap is worth copying. Type sizes are absolute
millimetres, the artwork is drawn in a millimetre coordinate system, and the
**panel width is measured from the content it has to hold** rather than the type
being scaled to fit the panel. That is the inverse of the fraction-of-parent trap
and it is what a sign shop does: it cuts 15-inch letters and the panel comes out
as wide as it needs to be.

## A feature that does nothing and a feature that is subtle are the same screenshot

This project's dominant defect class is **absence**: a thing that was written,
compiles, typechecks, runs, and contributes nothing to any pixel. Roughly a
third of the cases in this file are an instance of it. The reason it keeps
happening is contained in the heading, and it is worth stating as flatly as
possible, because every one of these cost time that a two-minute control would
have saved.

The damp-pavement film is the cleanest example so far. It was keyed so that the
full effect appeared in drainage hollows. The lot it was applied to is crowned,
which is to say it has no hollows, so the term evaluated to approximately zero
over the entire surface it was written for. The capture looked correct. It
looked exactly as correct as the capture taken before the feature existed,
because it *was* the capture taken before the feature existed, and the only
thing that separated the two was a numeric comparison:

    feature on vs `tforce=nowet` control, first attempt:   1.73% of pixels changed
    feature on vs the same control, after the fix:        18.35% of pixels changed

Nothing about the first frame said "broken". A shipped-and-doing-nothing
feature and a shipped-and-working-subtly feature produce images that a human,
a critic, and the author who just wrote the code all read the same way. There
is no amount of looking that separates them. The separation is arithmetic or it
does not happen.

**The rule: every subtle feature ships with a forced-off control, and the
control is captured from the same bundle in the same round.** Not from an
earlier round — a different bundle means a different build and the diff is then
measuring everything anyone changed, which is how a stale PNG got read as a
critic disagreement (see the capture-archive case). Same bundle, one query
parameter apart, and a pixel count.

Three things this catches that nothing else does:

1. A term multiplied by something that is zero in practice. The damp film.
2. A term that is present but an order of magnitude too small to survive tone
   mapping. Common when a value was tuned in linear space and judged in sRGB.
3. A uniform that was never bound, or bound to the wrong material. The
   uniform-table assertion catches the link failure; it cannot catch a uniform
   that links fine and is left at zero.

The corollary is a habit as much as a rule: **when a feature looks right the
first time, that is the moment to be suspicious, not the moment to move on.**
Getting a subtle effect right on the first attempt and getting nothing at all
are indistinguishable from the chair, and one of those two outcomes is much
more common than the other.

## A fudge that is large enough stops looking like a fudge and starts looking like the physics

The lighting had two numbers that were each wrong by a lot, in opposite
directions, and the product of the two errors was approximately right. That is
why neither was found for so long, and it is the general shape worth carrying
forward: **an error that is being compensated by a second error is invisible to
every test that only looks at the result.**

Concretely. `buildEnvironment` floored the environment map with a flat ground
disc of radiance `(0.115, 0.062, 0.030)`, luminance 0.0710. The real ground,
once it was actually photographed, measures 0.0094 — the disc was 7.6x too
bright and 12x too warm. Independently, the sun was set to 5.6 at 6.2 degrees of
elevation, which is 0.48 of horizontal irradiance against roughly 0.23 from the
sky: the sun beating the sky better than two to one, at an hour when the sun is
crossing ten air masses and ought to lose. Both wrong. Together, fine, because
the over-bright disc supplied exactly the fill that the under-bright sky was
failing to supply.

Three things made this durable, and each is reusable:

**The compensating error was in a different unit than the thing it compensated.**
Nobody comparing sun intensity against sky intensity would have looked at a
`THREE.Color` literal in the environment builder. The disc was not a light. It
was three floats describing a surface, and it was doing a light's job.

**The fudge was checked for being non-zero, not for being possible.** The disc
passed every guard it ever met, because the guards asked whether the lower
hemisphere was black. The question that would have caught it in one line is
whether a 9%-albedo surface can return as much radiance as the sky that lights
it, which it cannot, ever, under any illumination. A sanity check phrased as a
*physical bound* rather than a *non-degeneracy check* would have fired
immediately. Most of this project's guards are non-degeneracy checks.

**Removing the fudge presented as a regression.** When the real world capture
replaced the disc, a sibling measured a clean, well-attributed 23% loss of light
on shaded elevations and could show by bisection that it was the environment
change and nothing else. Every part of that measurement was correct. The
conclusion it invites — "the change that removed the light is the bug" — was
wrong, because the light being removed was counterfeit. **A bisection tells you
which change revealed a defect, not which change contains it.** The instinct to
restore what was taken away is exactly how a fudge survives being deleted.

**The companion failure is attribution without falsification, and it happened on
the same night.** A sibling reported a scene-wide darkening and attributed it to
a canopy newly built over the pump island — a real change, landing in the right
interval, and capable of darkening a forecourt-facing elevation. The attribution
was wrong, and **the number that falsified it was in the same table as the number
that suggested it**: the reported figures were *sky band* 126.3 → 81.2 and
148.1 → 120.5, and a canopy over the forecourt occludes ground, not the sky dome
above the horizon. On one of the two poses it was not even between the camera and
the sky. The real cause was exposure and ambient, i.e. lighting.

The general guard costs one question and it is not "is this cause plausible":

> **Which of my own measurements could this cause not have produced?**

A cause that explains some of your numbers and is *silent* on the rest has not
been tested at all against the ones it is silent on, and silence reads as assent.
This is the attribution counterpart of the bisection rule above: bisection
narrows *where* a change is, and this narrows *whether a named mechanism is even
capable of the effect you measured*. Run it before reporting a cause upward,
because a well-written attribution is acted on — the canopy claim was one round
away from sending another system to re-tune a canopy that was innocent.

The fix was to charge the fill to the account it belonged to: sun 5.6 → 4.4,
environment 1.0 → 2.4, which is near-parity between sun and sky on horizontal
surfaces — the ratio the file's own header had specified from the beginning and
never met. Aspiration written in a doc comment is not a constraint, and this one
had sat directly above the code that violated it for the whole life of the file.

A note on how it was verified, because the measurement design mattered. A
rebalance can be faked by simply raising exposure, so the claim to test was not
"the shadows got brighter" but "**the shadows got brighter and the highlights did
not**". Whole-frame percentiles over four poses show p75/p90/p99 moving by at
most 4 of 255, and by 0 in one pose, while p01 goes 2 → 9 and the fraction below
8 goes 8.5% → 0.3%. No region was hand-picked; that is a distribution-shaped
claim, and it is not one that an exposure change could have produced.

The last piece is the one most likely to be got wrong next time. The same
sibling reported that shaded surfaces had lost their warm cast, R−B falling
18.8 → 3.1, and treated it as part of the same defect. It was not. The warmth
came from the 12x-over-warm disc, and correcting the ambient does not bring it
back — measured, corrected shadow R−B runs 15–21 in the mid deciles and *lower*
in the darkest ones, because a shaded surface at dawn is lit mostly by blue sky.
Warm key against cool shadow is what dawn is. **When a compensation is removed,
some of what disappears with it was never supposed to be there, and the
downstream gates that were written against it have to be retired rather than
satisfied.** Otherwise the compensation grows back somewhere further from its
cause — in this instance, as albedo, in five different material systems.

### Addendum: a clamp's global bind rate is not its effect

Two more instances of the same shape turned up in one file, and both are clamps
rather than filters, which is worth spelling out because a clamp does not look
like a threshold at all.

`vegPine`'s branch length was `Math.min(H * 0.34, ...)`. Measured over the ten
site pines, that bound on **1.0% of all branches** — a number you would round to
zero and move on. But it bound on **9.0% of the long branches**, and the long
branches are the ones that draw the outline: every one of them came out at
exactly `0.340 H`, so the crown had a ruler laid along its edge. A critic
described the result as "flat quadrilateral patches with straight edges" without
being able to see the source.

The rule that generalises: **a clamp's bind rate over the whole population tells
you nothing about its effect, because the bound population is never a random
sample — it is the tail, and the tail is usually the part that is visible.**
Measure the bind rate over the sub-population the clamp actually affects, and
ask what that sub-population does.

The second instance, an hour later in `vegMidstorey`, is the same thing from the
other end. A plant height built as `clamp01(skew * 0.72 + stature * 0.5)` has a
sum exceeding 1 for a large slice of its inputs, so the clamp was not a guard at
all — it was a **mode**, a spike of plants piled against the ceiling, and it
grew 39,555 wood triangles of uniformly maximum-height shrubs while the code
read as though it were adding variation. Changed to shift rather than add:
`clamp01(skew * 0.82 + (stature - 0.5) * 0.42)`.

So: if a clamp fires on more than a percent or two of anything, it is part of
the distribution and has to be designed, not treated as a rail.

## "It is missing" and "I cannot see it" are the same report and have opposite fixes

An independent reviewer looked at the car and listed what it lacked: no door
mirrors, no wipers, no badge, no trim strips, no shut lines. Specific,
confident, and the kind of list that reads as a modelling backlog.

**Every single item already existed in the code.** Door mirrors on stalks with
a chrome glass panel, two wiper arms and blades, a roof antenna fin, door
handles with recesses behind them, a beltline chrome strip, a nose badge and a
boot badge. All of it built, all of it in the scene, all of it drawing pixels.

The mirror is the whole lesson in one part. It was mounted at y 1.155 against a
beltline at 1.038 — 117 mm above the belt — so its housing was silhouetted
against the dark side glass instead of against body colour, and at capture
distance it read as a tan box taped to the window. Present, drawn, and
illegible. Hung off `beltYAt` at belt + 34 mm it reads as a mirror immediately.
Only then did a second defect become visible: the chrome glass was on the
*outboard* face of the pod, aimed at the camera, returning a pale slab of sky —
the brightest thing on the door. Real mirror glass faces rearward. Both faults
were geometry. Neither was a missing part.

**A reviewer working from rendered frames cannot distinguish "absent" from
"present and unreadable". It can only report that it cannot see the thing.**
Those two diagnoses have almost no work in common: one is a modelling job, the
other is a placement, contrast or scale job. Acting on the wrong one costs the
whole effort, and worse, modelling a second copy of a part that already exists
leaves two of them in the scene.

**So the first step on any "X is missing" report is to confirm X is genuinely
not drawn.** Grep for it. If it exists, find it in a frame — crop and magnify
at the pose the reviewer used. Only model it if it truly is not there. This
costs minutes and it decides which of two unrelated jobs you are doing.

The corollary for tooling. The reason nobody had caught this is that
`buildTrim` merges ~30 small parts into four meshes by material, so
`probe-unseen` — the instrument built specifically to find geometry that draws
nothing — can only report that "car-trim-black draws pixels". **A merge is an
information barrier exactly where the small parts live**, and small parts are
what makes a shape read as a manufactured object. Vegetation hit the same wall
with 218 plants in one mesh and solved it by publishing a per-instance service.
Any builder that merges for draw-call reasons should publish a per-part list
alongside the merged geometry, or its parts are unauditable by construction.

## A detail element sized as a fraction of its parent is wrong wherever the parent varies

Real detail has an absolute size, set by physics. A leaf cluster is 5 to 15 cm
because that is how big a leaf cluster is; it is not 3% of whatever it is
attached to. So the moment a detail element's size is written as a fraction of
its parent, it is correct at exactly one parent size and wrong everywhere else —
and wrong in the most misleading direction, because it stays *proportionally*
right, which is what makes it survive review.

Found twice in one system, in the same evening:

- **`vegPine` foliage cards.** Sized off tree height. On the tall pines the
  needle sprays came out 40 to 60 cm across. A critic called them "hard-edged
  wood-brown quads reading as cardboard".
- **`vegMidstorey` sage cards.** `size = height * lerp(0.30, 0.54, rng())`, i.e.
  30 to 54% of the whole shrub. On the 1.92 m sage that a probe identified as
  the critic's B8 complaint, that is a leaf cluster **58 to 104 cm across**
  against a real 5 to 15 cm. At 4.6 m from the lens the plant resolved into a
  handful of enormous smooth blades and read as a palm, which is why the
  complaint arrived as "the foreground plant is enormous" — an observation about
  the *plant* caused by the size of its *detail*.

Both were fixed the same way: an absolute size in metres, with the count raised
to keep the silhouette mass the fraction had been providing by accident.

**Then found a third time, in sheet metal, which is the evidence that this is a
general defect and not a vegetation one.** `carParts.ts` rounded every stamped
panel's corners with `CORNER_F = 0.34` of the patch's smaller half-dimension.
On an 11 mm grille slat that is a correct 1.9 mm corner. On a 180 mm headlamp it
is a **30 mm** corner — not a corner, a lozenge. Two independent reviewers, in
separate sessions with no access to the source, both described the headlights as
"flat rounded rectangles", which is precisely what a 30 mm radius on a 180 mm
lamp looks like.

The justification for the absolute cap is worth stating in its own right,
because it is the sentence that lets the next person recognise their own
instance: **a pressed corner is a tool radius, and a tool radius does not care
how big the panel is.** The press brake has whatever radius it has. Every
fillet, chamfer, bevel, weld fillet and moulding radius in a manufactured object
is set by the tool that made it, never by the extent of the thing it is made
into — so all of them belong in this class, and all of them are wrong as soon as
they are written as a fraction.

**The tell in the complaint.** This defect is almost never reported as "the
detail is too big", because a viewer has no reference for a leaf cluster in
isolation. It is reported as the parent looking wrong — the wrong scale, the
wrong species, made of cardboard, "reads as procedural". Three separate
observations from one critic turned out to be this one cause. So when something
reads as the wrong size and its dimensions check out, measure its detail.

**Where else to look.** Anything whose size comes from physics rather than from
its host: aggregate in asphalt and concrete, brick and block courses, mortar
joints, tyre tread blocks, rivets, fasteners, weld beads, chips and scratches,
fabric weave, wood grain, gravel, rust blistering, paint flake. If any of those
is written as a fraction of the panel, wall, wheel or plant it sits on, it is
this bug. A useful grep is a multiplication by a parent dimension near anything
named for a small thing.

### Two smaller rules from the same round

**`lerp(a, b, rng())` is a flat histogram, and no natural population has one.**
Heights, sizes, spacings, ages, wear: all of them are skewed, usually with many
small and a few large. A uniform variate is not a neutral default, it is a
positive claim that every value in the range is equally likely, and it reads as
manufactured because manufacturing is the only process that produces it. Treat
it as a defect wherever it appears in generated content, not as a tuning choice.

**Check the obvious cause before the interesting one, and record it when it is
innocent.** The shrub complaint was "same species, same size, similar
intervals". Spacing was the obvious suspect and was already gap-weighted at
0.3–2.1x the nominal step — innocent. Species mix and height distribution were
guilty. Half an hour would have gone into re-noising the spacing, and it would
have changed nothing, because the loudest-sounding term in a complaint is not
reliably the responsible one.

**A cost regression in a mixed population usually lives in the mix, not in the
per-item size.** Letting three species shares float moved saplings from 5% to a
mean 9%. `buildPine` costs about 7,000 triangles whatever height it is asked
for, so that drift alone was **+40,695 triangles** — and it was first hunted
through the height distribution, where it was not, because "things got bigger"
is the intuitive explanation and "slightly more of the expensive kind" is not.
When one member of a mix is orders of magnitude dearer than the others, its
share is a budget line and has to be pinned, not sampled.

## An offset surface cannot read as a separate object, and no material or size change can fix it

**The general rule, for every system in this scene.** A part built as a surface
*offset from* its parent, rather than as a closed solid, **cannot read as a
separate object**, because it has no faces at a different orientation to the
thing it sits on. Its normals are its parent's normals, so it takes the same
light, resolves to the same value, and disappears into the panel. The failure is
invisible to size changes, colour changes, roughness changes and lighting
changes alike — every knob an author would reach for is the wrong knob.

**The cheap test, which any system can run on the CPU with no capture:** for each
part, the fraction of surface area whose face normal points more than 60° away
from the part's area-weighted mean normal. Zero means the part has no sides.
Implemented as `partscale --relief`; about twenty lines, needs only the geometry.

Applies to: applied trim strips, panel plates, badges, coping, sills, rockers,
fascia returns, gutters, plate surrounds, recesses, valances, bright bars,
mouldings, signage panels, decals given depth — anything an author thinks of as
"a strip on a surface" and therefore builds as a strip on a surface.

### Why it is a diagnosis rather than an observation

In this car, **34 of 67 trim parts had zero side area**, and the split predicted
legibility exactly. Closed solids — door handle, mirror, wipers, fog bezels —
read, and no reviewer complained about them. Ribbons — beltline, badge, plate
panel, fuel filler door, valance, lower bright bar — were precisely the list two
independent critics reported as *absent*. **A 56 px solid reads and a 732 px
ribbon does not**, which kills the size explanation, and both were the same
chrome or body material, which kills the colour explanation.

### What a real trim strip is actually made of

Not its albedo. **The pair of lines it creates**: a highlight along one return
where the up-facing surface catches the sky, and a shadow along the other where
the down-facing surface sees only the ground. That pair is a property of the
*section*, not of the material. A strip with no returns produces neither line at
any brightness, and a strip whose returns are too shallow to resolve produces
two lines nobody can see — the beltline's returns were first authored at 3 mm,
about 1.5 px on the flank, which is an invisible fix for an invisible part. **A
return has to present the full depth the part stands proud**, so an 8 mm strip
needs an 8 mm chamfer and the face gets whatever the section has left.

### The rule this produced, stated plainly

**A part reported absent deserves a culling check before a shading analysis.**
Culling is cheaper to test and strictly more fatal. And the general form, which
is the one to carry: **a probe that names one cause has found one cause.** Not
the cause, and not all of them.

The pixel evidence is the sills. `probe-unseen` filed them as `OCCLUDED` rather
than `WINDING`, and it was not wrong — it was incomplete, because it tries
remedies in order and **forcing `DoubleSide` cannot reveal a part that is also
buried.** The sills had both defects. Fixing the winding recovered exactly
nothing: still 0 px, because the body still buries them. So the ribbon framing
of the critic's absent list was *a* mechanism and got promoted to *the*
mechanism, which is the error to avoid — re-test after fixing either cause, and
do not let a sufficient explanation close the question.

### The sting in the tail: it is often not even the reason

Having diagnosed the beltline as a ribbon and rebuilt it with returns, a CPU
winding assertion showed all three leaves were **wound inside out and had never
been rasterised at all**. The ribbon analysis was correct and would have made
the strip illegible — but the strip never got as far as being shaded. Two
independent sufficient causes, the fatal one invisible to the measurement that
found the other. See the winding case below; the lesson to carry is that
**finding a sufficient cause is not finding the cause**, and a part reported
absent deserves a culling check before a shading analysis, because culling is
cheaper to test and strictly more fatal.

## `flankStrip`-style builders get their winding from the caller's sweep direction

`flankStrip(samples, edge, side)` flips its index order by `side`, which is
necessary and **not sufficient**. Working the winding out by hand, a strip's face
normal comes to `(-dz * dy, 0, 0)` — so the sign depends on the direction the
*caller* sweeps the path, which lives in a lambda the builder never inspects.
`buildArchLips` sweeps `z` decreasing and faces outward. `buildSills` and the
beltline trim sweep `z` increasing and faced **inward**, so they were back-face
culled and drew nothing, for months, in a builder whose comment said winding was
handled.

Two things generalise:

**Back-face culling makes a reversed surface invisible, not wrong.** No dark
patch, no z-fighting, no artefact to notice — the part is simply absent, which is
this project's dominant and most expensive defect class. Canopy caught a fascia
sweep the same way on the same night, by asserting face normals against an
expected direction on the CPU before any capture of it existed.

**The fix belongs in the builder, as a measurement, not in the call sites.** A
caller cannot reasonably be asked to track a sign that is the product of two
independent conventions. `flankStrip` now computes its own area-weighted mean
normal, compares it against the horizontal radial from the body's core, and
flips the index buffer if it points inward — and deliberately **leaves
near-tangential strips exactly as authored**, because the sill's underside return
legitimately faces downward and guessing there would trade a known bug for an
unpredictable one. Ambiguous cases are reported by `partscale --winding` rather
than silently decided.

### The same family in `geo.ts`, and why it is not being fixed the same way

Terrain found the sibling defect in the shared sweep: **`flip` negates the
lateral direction, which mirrors the surface, and a mirror reverses handedness —
so every sweep passing `flip: true` comes out inside out.** Measured on the
shipped `pump-islands`: 0 of 64 flank faces outward. There is a `WINDING HAZARD`
comment at `src/gen/geo.ts` describing it, and the three-line fix is deliberately
**not** applied, because `canopyParts.ts` already compensates by reversing two
profiles and fixing the shared function would double-invert Canopy's fascia.

That is the right call and it is the general lesson about this class: **once call
sites have compensated for a builder's wrong contract, the builder can no longer
be fixed unilaterally.** The compensations are indistinguishable from intent —
the same trap as a stale material compensation — so the fix becomes a coordinated
migration. Fix a builder's winding early or not at all.

The car is clear of this one: nothing in `carParts.ts`, `carBody.ts`,
`carWheelVary.ts` or `CarSystem.ts` imports `geo.ts`, and `carBody.ts`'s own flip
loop does reverse its index order. Worth checking rather than assuming — three
winding defects appeared in one night in three different systems, and two of them
were in builders whose comments claimed winding was handled.

**The strongest form of the assertion takes no region.** Canopy's version tests a
hand-picked band of triangles. Given a per-part manifest the same check runs over
every part at once with nothing chosen by anybody: an exterior part's mean normal
must have a positive component along the outward radial. That found six reversed
leaves in one run, and it is the only instrument that can see inside a merge —
`probe-unseen` sees only `car-trim-chrome` and cannot tell which leaf within it
is reversed.

### Verdicts from a probe are not mutually exclusive

`probe-unseen` reported the sills as `OCCLUDED` rather than `WINDING`, because it
tries fixes in order and forcing `DoubleSide` cannot reveal a part that is *also*
buried. The sills had both defects. A probe that names one cause has found one
cause, and a part with two will be filed under whichever remedy the probe tried
first — so re-test after fixing either.

## A substitution control also tells you whether you were sampling the part at all

Swapping a known 0.18 neutral grey card into the tyre's own mesh answered the
question it was set up to answer, and then answered a second one for free.

Three patches were sampled as "the tyre". Between the real material and the grey
card, two of them **did not change by a single count** — 77,49,35 against
77,50,35 — which means those pixels were never on the tyre. Only one patch moved.
A patch that does not respond when you swap the material is not showing you that
material, whatever the coordinates suggested.

**So a substitution control doubles as a region validator, and it is the only
cheap one there is.** Every measurement in this project that hand-picks a region
is exposed to this, and nothing else catches it: the numbers look plausible, they
are stable across rounds, and they are of the wrong surface. If a measurement
matters, capture the control and require the region to move.

This is also why the earlier version of the same finding was wrong. The first
argument was a ranking: the tyre reads R-B +40 while the asphalt beside it reads
+3 and the paint reads -2, same sun and same environment, therefore the warmth is
in the tyre. That reasoning does not hold, and ranking does not license it —
**a ranking is only valid between surfaces that differ in the one variable under
test.** The tyre sidewall faces sideways at roughness 1.0 and integrates the
lower hemisphere; the asphalt faces up at the sky; the paint is too smooth to
integrate much of either. Three different orientations and three different
roughnesses, so the comparison had three confounds and proved nothing. The grey
card in the same mesh has none.

## Rank every part before fixing any part, and the ranking will tell you which fix is wrong

An independent reviewer scored the car 1.5/10 and then 2/10, and both times the
complaint was a list of *absent small parts*: no mirrors, no wipers, no badge,
no trim strips, no fuel filler, no separate bumper. Every one of those existed
in the geometry and was drawing pixels. The reflex fix for "I cannot see the
trim strip" is to make the trim strip bigger, and it is the wrong fix, and the
thing that proves it is wrong is a ranking rather than an argument.

### The two thresholds, both derived from the data rather than chosen

`tools/partscale.mjs` projects every part's bounding box into a capture pose and
reports apparent size in pixels. Run over all 41 fittings it produced two
numbers that between them rule out an entire category of fix:

- **Nothing on the car is under 6 px.** There is no part whose size is
  disqualifying. So **the legibility problem is contrast and orientation, not
  scale.** The beltline strip settles it beyond argument: 732 px long, 47% of
  the car's width, and nobody can see it. No size argument survives that
  measurement.
- **56 px reads**, because the door handle is 56 px and the door handle is the
  one small fitting no reviewer complained about. That gives a floor with an
  observed witness rather than a guessed one, and therefore a rule: **anything
  above roughly 50 px that does not read is a contrast or orientation fault and
  must not be made bigger.**

Write both down wherever this recurs, because "make it bigger" is the reflex
every one of us reaches for, and a critic's language actively invites it — a
reviewer says "no trim strips" and it sounds like a size complaint.

**The building reached the same rule from the opposite end, and the pair is worth
holding together.** A window notice was authored as ruled grey bars throughout,
on the written reasoning that "at the size this is ever seen, real words average
to a grey smear" — one judgement applied to a whole texture. The measurement it
never got: the cell is 512 px, the pose renders it 133 px wide, so its **74 px
masthead lands on 19 px of screen while its 15 px body lines land on 3.9 px**.
One of those holds letterforms comfortably and the other cannot at any contrast.
The sheet now carries real type in the masthead and deliberate illegible small
print in the body, which is what a real notice looks like anyway.

So: **the resolution budget is a property of the individual element in delivered
pixels, not of the texture, the object, or the pose.** Car's rule says an element
above about 50 px that does not read has a contrast or orientation fault and must
not be enlarged; the building's says an element's size must be computed before
deciding what can live in it, and that a single surface routinely spans both
regimes at once. Neither is discoverable by looking at the asset, and both are
two multiplications away once you think to do them.

### The mechanism the ranking then exposed: 34 of 67 parts had no sides

The size ranking says what the defect is *not*. `partscale --relief` says what
it is. For each part it measures the fraction of surface area whose normal
points more than 60° away from the part's mean normal — in plain terms, **does
this part have sides at all** — and the answer for 34 of 67 was zero.

They were ribbons. `flankStrip` and `endPatch` build a surface *offset from* its
parent: two rows of vertices displaced a few millimetres outward, with no walls
joining them back to the panel. Every triangle therefore faces the way the panel
faces, so the part shades identically to the panel, at any albedo, in any light.
A trim strip is visible because of **the pair of lines it creates** — a shadow
along one edge and a highlight along the other — and a strip with no edges
creates neither. That is why the beltline strip is unseeable at 732 px, and it
is why colour could never have fixed it.

The correlation with the legibility data is the part worth keeping. The door
handle, the mirror, the wipers, the fog bezels are closed solids. The beltline
strip, the badge, the plate panel, the fuel filler door, the valance, the lower
bright bar are ribbons. **The parts that read are the parts with walls, and
size predicts nothing.** A 56 px solid reads and a 732 px ribbon does not.

### Both halves of the size finding, including where it reverses

The intake dividers are the one place the size finding cuts toward bigger. Nine
of them at 12 mm measured **2 px wide in the side pose**, and 2 px of near-black
against a near-black backing is a shimmering comb the moment the camera moves —
which it does, the deliverable being video. So they were widened and halved in
count.

But note what the pose breakdown says about that fix: in the side pose they stay
1–2 px *at any width*, because their apparent width there is set by viewing
angle, not by size. Widening helps only the poses where they were already
adequate. **The wall is the fix in every pose; the width is the fix in none of
them.** Aliasing and illegibility looked like two problems with two opposite
remedies, and they had one remedy, and it was not the one either symptom named.

This is the sharpest available caution against the size reflex, because it is the
one case where the data appeared to license it. The measurement said 2 px, 2 px
genuinely does alias, widening was genuinely correct for the front poses — and
the fix that mattered was still the wall. **An apparent size below the floor
justifies widening only where apparent size is a function of size**; where it is
a function of viewing angle, no width exists that helps, and reaching for width
there produces a bigger part with the original defect.

### Keep discarded metrics in the tool, labelled, rather than deleting them

Two metrics were tried here and are wrong, and both are still printed or
documented in `partscale` with an explicit warning not to trust them. That is
deliberate. A deleted metric gets rederived by the next person, because it is the
obvious thing to compute — the bounding-box slope ratio is what anyone would
reach for first, and its failure mode is invisible unless someone tells you. **A
plausible wrong metric is worth documenting precisely because it is plausible.**
The exception is a whole tool that is confidently wrong in a plausible direction,
like `carproud.mjs`; that is worse than no tool and should go. The distinction is
whether the wrongness can be labelled in place.

### Why there is no slope-ratio column, and how the first version was wrong

The natural form of this test is Terrain's: relief divided by half the feature
width, compared against the tangent of the sun elevation. The natural source for
both quantities is the part's bounding box, and that is wrong here — the first
version of the tool shipped confident nonsense. The beltline strip follows the
beltline, which rises along the car, so its box reported 85 mm of "face height"
for an 18 mm face and 95 mm of "relief" for a 3 mm offset. **The box measures the
path, not the section.** It scored the strip as comfortably able to cast a
shadow, which is the opposite of the truth.

`carproud.mjs` was deleted from this tree a few hours earlier for exactly that
class of error — right about flat plates, wrong about every curved strip — so the
replacement measures per triangle or not at all: wall area as a fraction, and
relief as the 90th-percentile extent of a single wall triangle along the mean
normal. Cross-sections are not read off bounding boxes anywhere in it. The
reported output is the shadow length in millimetres, relief / tan(6.2°), because
a length can be judged against the part's own size and a dimensionless ratio
cannot.

### The general shape

A ranking over every part is cheap, needs no capture, and is worth more than a
careful investigation of the one part somebody thought to check. Both thresholds
here, the mechanism, and the reversal on the dividers came out of running the
same two measurements over all 67 parts at once. None of them would have come
out of studying the beltline strip, which is what the complaint pointed at.

## A threshold comparison is not a check unless something rejects non-finite input

A harness in this repo wrote a 0x0 PNG and reported the capture healthy. Every
content assertion in that harness passed. So did every assertion in a second
harness, on a separate occasion, on a different non-finite value. The mechanism
is the same both times and it is worth stating on its own, because it is not a
bug in either harness, it is a defect in the shape of guard this project writes
everywhere:

    every content check is a mean
    the mean of no pixels is NaN
    every comparison against NaN is false

`if (mean < FLOOR) fail()` does not fire on NaN. Neither does
`if (mean > CEILING) fail()`. Neither does `if (sd < 4) fail()`. NaN is not
less than, not greater than, and not equal to anything, including itself, so a
guard built out of comparisons **cannot distinguish a value that is fine from a
value that does not exist**, and it silently reports the first when handed the
second. The failure is worse than a missing check, because a missing check is
visible in the source and this one reads as thorough.

The same hole swallows more than empty inputs. Any of these produce a NaN or an
Inf that then satisfies every threshold in sight:

- a mean over a count that turned out to be zero — an empty region, a mask that
  matched nothing, a frame that was not written
- normalising by a range that collapsed, `(v - lo) / (hi - lo)` with `hi == lo`
- `acos`, `sqrt`, `log` or a division taken one epsilon outside its domain
- a correlation coefficient where one series has no variance, which is exactly
  the shape of "the feature did nothing" that these probes exist to detect
- anything that has been through a shader and come back: a normalize of a zero
  vector, or a `pow` of a negative base

The last two are the dangerous ones, because they are the cases where the guard
was specifically written to catch a broken feature and the broken feature
produces the value that defeats it.

**The rule: a numeric guard asserts finiteness first, and asserts the shape of
its input before it computes any statistic.** In order:

1. Reject the input if it is the wrong shape or empty — dimensions, counts,
   sample size. Do this before any arithmetic, because it is the only check
   that can see this class of failure at all.
2. Reject non-finite results explicitly, with `Number.isFinite`, as a distinct
   failure from being out of range. A NaN and a value below the floor are
   different diagnoses and should not print the same message.
3. Only then compare against thresholds.

Written the other way round — thresholds first, sanity later — the sanity check
never runs, because the threshold already passed.

Corollary for the report line: **print the sample size next to the statistic.**
Both instances of this would have been caught instantly by a log line that said
`n=0` beside the mean, and a harness that prints `mean=NaN` in a field the
reader skims is not much better off. A statistic without its `n` is not a
measurement.

Related: "A feature that does nothing and a feature that is subtle are the same
screenshot" — the control-capture rule there is the other half of this. A
control tells you the feature moved pixels; a finiteness check tells you the
number that said so is real.

### The same class again, and the one most worth broadcasting: a gate a typo can disable

`probe-unseen` takes `--baseline=<file>`. Invoked as a bare `--baseline` it
parsed to the empty string, took the "no baseline configured" branch, and
**silently skipped the gate — so the round passed by not being checked.** Exit
code 0, no warning, and a summary line that simply was not printed. This is the
identical shape to the zero-dimension capture that passed every health assertion:
the check did not fail, it *failed to run*, and nothing downstream can tell those
two apart.

The rule that catches the whole family: **any flag that switches a check on must
fail loudly when it is malformed, never fall back to not checking.** A default of
"off" is defensible for a feature and indefensible for a verification, because a
verification's whole value is that its absence is noticed. Concretely: reject a
bare form of a `--key=value` flag, reject a `--record` with nothing to record
into, reject a probe size that is not a finite number at least 8 px, and reject an
empty pixel comparison rather than reporting zero differences over zero pixels.
All four were present in one tool, and all four would have reported success.

## Two tessellations of one height field do not agree, so detail patches interpenetrate

The obvious way to buy near-field geometric detail on a large ground plane is a
second, finer mesh laid over the region the camera can reach. It does not work,
and the reason is arithmetic rather than tuning.

A triangle mesh represents a curved height field by chords. The error of a
chord against the curve it spans goes as the square of the span, so two meshes
sampling the *same* height field at different tessellations disagree
everywhere except at shared vertices — the fine one follows the curve, the
coarse one cuts across it. On this terrain, with relief of 0.5 m at 16 m
wavelengths and a coarse spacing of 2.47 m, the disagreement is about **59 mm**:
the coarse surface sits up to 59 mm below the fine one at crests and above it
in troughs. A detail patch therefore punches through the plane it is sitting
on, in a pattern that changes with the camera, and no offset fixes it because
the sign of the error alternates.

This is the same failure the height field's "continuous terms only" rule was
written for — one surface punching through another because two meshes disagree
about the ground — arriving through tessellation instead of through hashing.

Making a patch work needs the coarse mesh cut out, the seam vertices shared
exactly, and the fine mesh's boundary row decimated to kill the T-junctions.
That is real work and it leaves a seam to maintain forever.

**The alternative is to grade the single mesh.** Vertices are packed toward the
region of interest by integrating a density function and inverting it, with the
density ramping out over a couple of focus radii so no row of quads is a
visible transition. One mesh: no seam, no T-junction, nothing to z-fight, and
a ratio of 1 reproduces the uniform grid exactly, so it is revertible with one
constant. Here it bought 0.65 m spacing over the site against 3.58 m beyond,
for 121,600 triangles, where a uniform grid at 0.65 m everywhere would have
cost about 3.3 million.

### The consequence nobody expects: Nyquist becomes position-dependent

A uniform mesh has one sampling limit and you can forget about it after the
first time. **A graded mesh has a different limit in every region, and a height
field term is only valid where the mesh can resolve it.** The near-field relief
added here sits at 3-5 m wavelengths, which is eight samples per cycle over the
site and *one* sample per cycle beyond it, so it is explicitly gated off past
62 m. Without the gate it would not read as relief out there, it would read as
facets crawling as the camera moves — a moving artefact, which is the worst
kind, because it is invisible in a still and obvious in motion.

So: anyone adding a term to a height field sampled by a graded mesh has to know
which zone the wavelength lives in and fade the term out where the mesh runs
out of vertices. It is a new obligation that a uniform mesh did not impose, and
it is the price of not having a seam.

### The counterexample: when a constant is right and the percentile rule does not apply

The rule above was written at about 04:00 and by 05:00 it had been aimed at a
threshold it does not cover. Recorded here, attached to the rule, because a rule
with no known exception gets applied where it does not belong — and this one is
attractive enough to be over-applied.

`tools/framescan.mjs` requires a suspected water/haze band to be **cool in
absolute terms** (`COOL_ABS = 6` in R−B), not merely cooler than its neighbours.
That looks exactly like the defect this case describes: a constant calibrated
when every frame in the project was warm, kept after Lighting established that
the warmth was itself a bug — a ground disc 7.6x too bright and 12x too warm,
sitting essentially at the sky's own radiance. The instruction to retire it was
reasonable and was wrong.

**Two reasons, and the first generalises further than the second.**

1. **Direction.** The clause is a *precondition on reporting a defect*, not an
   assertion about correct output. Those fail in opposite directions. An
   assertion about output ("shadow should be warm") bakes in the old world and
   passes the defect. A precondition on a report only ever *suppresses* reports,
   so a cooler, correct world makes it fire more readily, and it cannot have
   been preserving anything. Before deciding a threshold encodes a stale
   assumption, ask which side of the test the correct output sits on.
2. **The quantity is physical, not populational.** Water, glass and wet haze are
   cool *because of what they are*. "Has this crossed into cool" therefore has a
   fixed answer that does not move when the rest of the frame changes. A
   percentile of the frame is the wrong instrument for it — and this was
   measured, not argued: replacing the constant with the frame's own 20th
   percentile of row temperature does not work, because the 20th percentile of a
   uniformly warm frame is still warm and passes the same regions.

**The disproof, since removal was tried rather than reasoned about.** Across the
seven capture poses, retiring the clause took the finding count from **4 to 14**.
The new firings sat at R−B 28.2 against 42.4, and 27.4 between 45.2 and 41.0 —
warm ground beside warmer ground, which is the pump-close-up false positive the
clause was written for, and NOTES case 25: a metric that fires on correct output
is worse than no metric.

**The test for which kind of threshold you are holding.** Ask what the number
would be if the scene were different. A threshold whose correct value depends on
what else is in the frame is a percentile and belongs in the rule above; it
should be expressed as the statistic it is really targeting. A threshold whose
correct value is a property of the material, the physics, or human perception is
a constant and should stay one — and should say so next to itself, or the next
reader will apply the rule to it.

## Where a term is applied matters more than whether it is applied, and the cheap placement returns about 10%

A 10% improvement is the most dangerous result in this project, because it is
large enough to look like progress and small enough to leave the defect in
place. It is also the characteristic yield of putting a correct term in the
wrong part of the pipeline — the term does something, so the change is real, and
the number moves in the right direction, so the investigation ends.

Two instances, one night, in the same system.

**The distant range, B5.** The band read as "a constant-value cutout with no
internal variation — no lit faces, no shadowed valleys". The cause was a lit-face
term keyed to the wrong variable (see the case below). Adding a correct
slope-based lighting term to the place it was easiest to add it — the rim, which
is a thin warm lift along the crown line — moved the band's mean absolute
per-column luma step from **2.197 to 2.432**, against 0.890 for the empty sky as
a no-structure reference. Ten percent. Everything about that number invites you
to stop: the term is right, it is in, it helped. Moving the same term into the
**fill**, and onto both vertices of the quad rather than only the top, gave
**4.002** — 4.49x the sky's structure against 2.71x before, at unchanged mean
luma. The fill is what reads as a cutout; the rim was never going to fix it, and
modulating only the top vertex let the quad interpolate the variation away over
the visible body of the band.

**The foliage transmission term, earlier the same night.** Same shape, more
extreme. The term was injected after tone mapping and sRGB encode, so a
scene-referred linear quantity was being added to display-referred output. It
responded slightly to tuning — which is what kept it alive through a round of
strengthening — and it could not reach its target at 8x its authored strength.
Moving the injection from `dithering_fragment` to `opaque_fragment`, adding to
`outgoingLight` instead of `gl_FragColor.rgb`, fixed it at the authored value.

**The decisive experiment, from that earlier case and worth repeating here:** a
term that cannot reach its target at 8x is in the wrong place, not too weak.
Its counterpart for the 10% case: before accepting a small improvement, name the
*other* places the term could have gone and what each would be expected to
yield. If the placement you chose was the cheapest one, that is the reason to
distrust the result, not to bank it.

## A term keyed to the wrong variable is not a weak term, and it looks plausible in source

Three instances in one night, in three systems. In every case the term existed,
was written correctly for what it claimed to compute, and produced no visible
effect — because the variable it read was not the one that varies over the thing
being looked at.

- **Distant range lit faces (vegetation).** `facing` was
  `clamp01(-(cos(a) * sunXZ.x + sin(a) * sunXZ.y))`, where `a` is the sample's
  azimuth **around a 3.5 km ring**. That turns over a period of one revolution,
  and a 46 degree preset sees 13% of one revolution — so a term whose whole job
  is to make some stands lit and others shadowed handed every stand in the frame
  the same value. The variable it wanted was the *local slope of the skyline*,
  which varies at crown scale. Nothing was short of slope: the height field's
  slopes are an order of magnitude steeper than the sun is shallow.
- **Far-ground shading (terrain).** Shading responds to slope, and that surface's
  characteristic slope was 0.006 against a solar tangent of 0.194 — thirty times
  too flat to shade at all. Every round spent on the shading term was spent on a
  term with nothing to read.
- **A continuous quantity read off a binary mask.** Same family: the value exists
  and is correct, but the input has been quantised to two levels, so the output
  has two levels whatever the arithmetic downstream.

**Why source review does not catch this.** The term is *locally* correct. Read on
its own, `-(cos(a) * sunXZ.x + sin(a) * sunXZ.y)` is exactly the cosine between
a surface's outward direction and the sun, which is what a lit-face term should
be. The bug is a relationship between the term's input and the *frame*, and the
frame is not in the file.

**The check, which is cheap and mechanical.** For any term intended to produce
variation, ask what its input's period or range is over the region that will be
looked at, and compare that against the scale of the variation you want. Two
numbers, both usually available without a capture:

- ring azimuth over a 46 degree frame: 13% of one period — one value, no variation;
- characteristic slope 0.006 against solar tangent 0.194: 3% of what shading
  needs — one value, no variation;
- a mask with two levels: two values.

If the answer is "less than one period" or "two levels", the term is not weak and
tuning it is wasted. Change what it reads.

## The file you read is not always the file that runs

A shader-chunk patch was written against this needle, copied verbatim out of
`node_modules/three/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js`:

```
\t#else // SHADOWMAP_TYPE_BASIC
```

It appears in that file exactly as written. It can never match at runtime.
three's `package.json` `exports` point at `build/three.module.js`, which is what
Vite bundles, and the build strips GLSL comments and blank lines — the branch
marker survives as a bare `\t#else`, at one tab rather than two, in a chunk whose
whole preprocessor structure differs from the source tree's. The source is real,
readable, correct, and never loaded.

The failure was well-instrumented and still nearly cost a round. The patch
reported `anchor not found`, the system caught it, reverted to PCF, and pushed a
`__SYSTEM_ERRORS` entry. Then a round was captured comparing "contact hardening"
against "constant-radius PCF" — which was PCF against PCF — and it took a
*different agent* noticing the error line in its own unrelated capture to stop
the comparison being read as a result. Three lessons, in descending order of how
much they cost:

**A graceful fallback is only graceful when the caller can tell.** Reverting to
PCF and logging it substituted the control for the experiment and then rendered a
plausible frame. The frame is the thing being judged, so "it still works" is the
worst possible outcome: nothing about the image says the treatment under test is
absent. This now throws, and the message says why it refuses to fall back. The
general rule: when a fallback changes what a measurement means, it must not be a
fallback. Degrade gracefully on things nobody is measuring; fail loudly on the
thing under test.

**Author string anchors against the runtime value, never the source tree.** For
anything reached through a bundler this is not paranoia, it is the only evidence.
`node --input-type=module -e "import * as THREE from 'three'; ..."` prints the
real chunk in a second and would have shown both differences immediately. And
never anchor on a comment or on blank lines, because those are exactly what a
minifier is entitled to remove.

**Verify the patched artefact, not the patch call.** `replaceOnce` returning a
string means the replace ran, not that the result contains the new code. The
patch now asserts the marker is present *and* that the code it replaced is gone,
which is two cheap string checks standing in for "did this actually take".

There is a second, independent lesson from the same round, about the measurement
rather than the patch. The tool written to prove the shadows were contact-hardened
divided the steepest edge found in frame A by the steepest edge found in frame B,
per scan line. On a cluttered frame those are frequently two different edges
metres apart, and it duly reported a 3.8x variation with a confident verdict
attached. The number was not wrong arithmetic; it was a ratio between unrelated
things. Once the tool was made to refuse any pair whose detections were more than
3 px apart or below a contrast floor, thirteen scan lines produced **two** usable
comparisons. **A probe that always returns a number will sometimes return a
number about nothing**, and it will be a flattering one often enough to be
dangerous. Make the probe say "unmatched" and "faint" out loud; a measurement
tool's most important output is its refusals.

## A frequency multiplier inside a hash is not a frequency

This one produced two separate wrong conclusions in this repo and both of them
survived review, because the claim it makes is the kind nobody checks.

`hash1(n) = fract(sin(n * 12.9898) * 43758.5453)` is a bare hash. It has no
interpolation and no lattice, so it decorrelates on *any* change of input,
including a change in the eighth decimal place. Therefore:

    hash1(t * 0.055)   is NOT an 18 m wave
    hash1(t * 5.30)    is NOT a 0.19 m wave
    they are the same white noise with different seeds

A sum of them is not a spectrum of octaves. It is one white-noise field with a
larger amplitude. The multiplier changes nothing observable at all.

What went wrong because of it:

1. **A fix that did nothing looked like it had worked.** A reviewer working from
   frames reported the pavement edge reading as a ruled line past about fifteen
   metres. The response was to add an octave "at ~18 m" and give it most of the
   weight, with a comment explaining that a paving train wanders over tens of
   metres. The amplitude claim in that change was true and checkable. The
   wavelength claim was false and nobody could check it, so the edge still had
   no long-wavelength wander and the defect was still there under a comment
   saying it had been addressed.
2. **The error only became visible when an unrelated number changed.** Raising
   the excursion from 190 mm to 400 mm turned the edge into a sawtooth: measured
   moving **649 mm between adjacent vertices** at the mesh's 0.5 m pitch, more
   than the entire declared excursion, a 130% slope across one quad. White noise
   has no wavelength to be limited by, so every vertex was an independent draw
   from the full envelope. At 190 mm the same defect was present and merely too
   small to see. **A latent error scaled into visibility by a change somewhere
   else is the normal way this class surfaces**, which means the trigger and the
   cause will be in different files and probably in different systems.

The fix is a lattice and an interpolation — hash the integer cells and blend
between them — after which `t / 18` means 18 metres. Measured after: steepest
edge slope 10% and 52 mm between adjacent vertices, against 130% and 649 mm.

**The general rule: a claim about wavelength is a claim about the second
derivative of your noise, and a hash has none.** If a comment names a
wavelength, something should be able to measure it. The cheap measurement is a
finite difference at the spacing the geometry actually samples at: white noise
returns a slope that scales as 1/step, and a real wave returns a slope that
stops changing once the step is well below the wavelength. Those two are
trivially distinguishable and one line of probe apart.

Related: the same distinction is why domain warping fails to unalign a lattice
(below). Warping and hashing both change *where* values land; neither changes
the frequency content, and frequency content is what the eye reads.

## Domain warping does not unalign a lattice; superposing non-aligned waves does

Three separate features in one system read as artificial for one reason:

- water ripple normals read as hammered metal
- the specular highlights on them formed a regular filigree
- the near-field ground relief read as an evenly dappled pebbled carpet

All three were built the same way: a product or sum of a wave in x and a wave in
z, with the arguments domain-warped by another sine to "break it up".

**A product of an x-wave and a z-wave is a lattice.** Its peaks sit on a
rectangular grid whose spacing is set by the two wavelengths, and the eye finds
a rectangular grid immediately — it is one of the few patterns human vision is
specialised for. Domain warping bends the cells, so no individual peak is where
a ruler would put it, but there is still **exactly one peak per cell**, the
cells still tile the plane in two dominant directions, and the count and the
directions are what read as a lattice. Warping makes the grid wobbly. Wobbly
grids are still grids.

What actually works is superposing *directional* waves whose wavevectors are
neither axis-aligned nor rationally related — three is enough. Rotate the basis
of each term by an odd angle (37° and −61° here) so no two share a common period
in any direction, and the interference pattern has no repeating cell for the eye
to lock onto.

Two practical notes:

- **Rotating one octave of an existing set is the cheap version** and it worked
  on the ripples. Rewriting all terms on separate rotated bases is the thorough
  version and it is what the ground relief needed, because the lattice there was
  the dominant term rather than a secondary one.
- **Summed waves partly cancel where a product does not**, so a rewrite at the
  same nominal amplitude loses relief. Measured here: near-field mean slope fell
  from 0.096 to 0.087 at equal amplitude, and needed 1.18× to restore. If a
  slope census exists, re-run it after any change of *pattern*, because pattern
  and amplitude are not independent.

And the reason to be suspicious in the first place: **a lattice replaced by a
different lattice is another plausible screenshot.** All three of these looked
fine in a still until named. Fix the frequency content, then verify with a
capture, and do not tune this class by eye.

## When two functions describe the same surface, a feature authored against one is silently erased where they disagree

Entrance wheel tracks were authored into `dirtY`, the native ground height. The
mesh is built from `groundHeight`, which blends `dirtY` with the pavement and
apron surfaces. A slope census over the entrance strips returned a value within
**0.002** of the same census with the feature forced off: the tracks were doing
nothing.

The cause is not that the two functions disagree — that is their job. It is
*where* they disagree. Across the entrance band `dirtY` and `groundHeight`
differ by up to **0.65 m**, because the entrances are precisely where the apron
blend is doing the most work. So a groove authored against the paving edge was
erased by the very blend that makes the apron, and it was erased **most
completely exactly where it was most wanted.**

That is the general shape, and it is not about terrain:

> A blend, a decal, a projection or an override exists in order to disagree with
> the thing underneath it. It disagrees *most* where it is doing the most work,
> and the places where it is doing the most work are the interesting places —
> edges, transitions, junctions, thresholds. So a feature authored against the
> underlying function and rendered through the override is suppressed in
> proportion to how interesting its location is.

Anyone with a blend has this: a wall-base dirt line authored against a wall
plane but rendered through an AO blend, a decal authored against a nominal
surface but projected onto a displaced one, a colour authored into a base map
but overridden by an overlay wherever the overlay is opaque. In every case the
feature works in the flat middle of nowhere and vanishes at the junction.

**The habit that catches it: author against the function that the renderer
reads, and if you cannot, measure the two functions' disagreement over the
region you are authoring into before you tune anything.** A single line —
`max |a(x,z) - b(x,z)|` over the feature's footprint — would have saved the
whole detour here, and it is a line worth writing whenever a feature's
footprint overlaps a blend.

Corollary, and it is the reason this is written up rather than just fixed: **the
probe was measuring the wrong function too.** The census that reported the
tracks as working before the control arm was added read `dirtY`, so it was
measuring a surface that is never rendered. A probe and a feature reading the
same wrong function agree with each other perfectly, which is the most
convincing kind of wrong answer available.

## Author string anchors against the runtime value, never against the source tree

Stated as an instruction because it has already cost a round and every agent
patching a shader chunk by string match has the same exposure:

**Before writing a `ShaderChunk` anchor, print the chunk that is actually
loaded.** One command:

```
node --input-type=module -e "import * as THREE from 'three'; console.log(THREE.ShaderChunk.shadowmap_pars_fragment)"
```

Reading `node_modules/three/src/renderers/shaders/ShaderChunk/*.glsl.js` is not
evidence about what runs. three's `package.json` `exports` resolve `three` to
`build/three.module.js`, which is what Vite bundles, and the build **strips GLSL
comments and blank lines** and does not preserve the source's preprocessor
nesting. A needle copied verbatim from the source tree can therefore be
character-perfect against a real file and match nothing at runtime. Two concrete
differences in r185's shadow chunk: `\t#else // SHADOWMAP_TYPE_BASIC` in source
is a bare `\t#else` in the build, and the indentation drops a level.

Corollaries:

- **Never anchor on a comment or on blank lines.** Those are exactly what a
  minifier is entitled to delete, and a comment is the most tempting anchor
  because it is the most human-readable landmark in the file.
- **On a miss, print the haystack, not the needle.** The natural debugging loop is
  to re-open the source file, confirm the needle is there, and conclude three is
  doing something strange — and that loop never terminates, because the source
  file will confirm the needle forever. `reportAnchorMiss` in
  `lightShaderPatches.ts` now truncates the needle until it matches, reports the
  longest matching prefix, and dumps the diverging text from both sides with
  whitespace escaped, which points at the exact character.
- **Verify the patched artefact, not the patch call.** A replace returning a
  string means the replace ran, not that the output contains the new code. Assert
  the new marker is present *and* the replaced code is gone.

The reason this was nearly missed despite being well instrumented is worth
keeping separate, and it is the more general lesson: the patch failed, was
caught, logged to `__SYSTEM_ERRORS`, and **reverted to the previous filter** — so
a round was then captured comparing the new treatment against the old one when
both were the old one. It took another agent noticing the error line in its own
unrelated capture to stop that being read as a result. **A fallback that changes
what a measurement means must not be a fallback.** Degrade gracefully on things
nobody is measuring; fail loudly on the thing under test. The throw now says so
in as many words: refusing to fall back, because the fallback frame is
indistinguishable from a working one and would be measured as if it were the
feature.

## A single-lag difference metric cannot tell structure from noise, and rewards whichever one it was not built for

> Read this next to **case 41** (Building's block courses) and to *A metric with
> no control fabricates the finding it was built to look for*, below. All three
> are the same instrument failing three different ways. Case 41 tested one lag in
> the wrong coordinate system and found nothing where a repeat existed; this case
> tested one lag at the wrong scale and reported a genuine improvement as a
> regression; the control case swept every lag correctly and still produced a
> fabricated peak, because sweeping every lag does not by itself tell you what
> a given r means. The full recipe is: sweep every lag, check for harmonics, and
> run the sweep on a signal known to have no period so the noise ceiling is
> measured rather than assumed. `tools/probe-period.mjs` does all three and
> ships a selftest; prefer it to anything hand-rolled.


`mean absolute per-column step` was introduced to catch a *ruled* horizon — an
edge so smooth that adjacent columns were identical. Against that defect, higher
is better, and it worked: it took the skyline from 0.10 px to 12.89 px per column
across several rounds.

Then the defect changed shape. The distant band's lit-face term was saturating on
alternating samples, which at a 1.86 px sample pitch is a sub-pixel dither that
resolves to flat grey with vertical corduroy over it. Fixing it — moving the
slope measurement to a fixed 46 m physical baseline — moved the same metric
**down**, from 2.02 to 0.91 per column and from 2.67 to 1.74 over the band body.
By the metric the fix was a 55% regression. By eye, the corduroy was gone.

Both readings were correct. The metric measures energy at a one-pixel lag, and
the fix deliberately moved variation from a one-pixel scale to a 41-149 px scale.
Nothing was wrong with the number; it was answering a question that had stopped
being the question.

**Measure the same quantity at several lags and report all of them.** The three
together separate the cases in a way no one of them can:

| version | lag 1 | lag 40 | lag 120 |
|---|---|---|---|
| per-sample dither | 2.02 | 10.64 | 11.66 |
| facet-scale slope | 0.91 | 9.09 | 13.92 |
| sky reference | 0.41 | 3.84 | 4.29 |

Read across, the trade is legible: high-frequency energy down 55%, ridge-scale
energy up 19%, and both well clear of the sky's own gradient. Read down the first
column only, it is a regression.

**The tell that you are in this situation:** a change you can see is an
improvement moves a metric the wrong way, and the metric was written for an
earlier defect in the same region. Before adjusting the change, work out what
spatial scale the metric is sensitive to and what scale the fix operates at. If
they differ, the metric is not wrong and neither is the fix — the metric is
incomplete, and adding a second lag costs one line.

Corollary, and the reason this is worth a case rather than a footnote: **do not
change the metric after seeing the result and then report only the new one.**
Report both, and say which was chosen first. The multi-lag table above was
written because the single number disagreed, which is exactly the circumstance in
which a convenient new metric is least trustworthy.

## The checkable half of a claim is not the load-bearing half

The most consequential defect found in this repo so far survived review for
several rounds, and it survived for a reason that is entirely about how the
change was written rather than about the code.

A reviewer working from frames reported the pavement edge reading as a ruled
line from about fifteen metres out. The fix added an octave "at ~18 m" and gave
it most of the weight, with a comment explaining that a paving train wanders
over tens of metres and that the total was renormalised so the maximum
excursion was unchanged. Everything about that change read as careful. It was
reviewed and accepted. It did nothing structural, because the "octaves" were
`hash1(t * k)` and `hash1` is a bare hash — see the frequency case above — so
there were no wavelengths at all and the edge still had no long-scale wander.

The reason it passed:

> **The amplitude claim was true and checkable; the wavelength claim was false
> and unmeasurable. The change looked as though it had worked because the half of
> it anyone could verify was the half that was correct.**

Both halves were stated with the same confidence and in the same comment. One of
them could be confirmed in seconds — the excursion number was right there, and
`amp` really was renormalised. The other required knowing what "at 18 m" meant
operationally, and nothing in the repo could answer that, so nobody asked.
Reviewer attention went to the verifiable claim, found it sound, and generalised
the finding to the whole change.

**This is the general mechanism by which a fix passes review while doing
nothing.** It does not need dishonesty or carelessness. It needs a change that
makes two claims of unequal verifiability, where the cheap one is true. The
cheap claim acts as a certificate for the expensive one.

Practical consequences:

- **When a change makes a claim about structure — a wavelength, a distribution,
  a correlation, a falloff, a shape — that claim is the one to verify, and it is
  the one nobody will verify unless a probe exists.** Amplitudes, counts, ranges
  and totals are all easy and all beside the point. If a comment names a length
  scale, something should be able to measure that length scale.
- **Reviewing your own change, ask which of its claims you could not check.**
  Then check that one, or say plainly in the write-up that it is unverified. "I
  believe this puts a scallop every 18 m and nothing here measures that" is a
  sentence that would have saved several rounds.
- The corresponding reviewer habit: **a well-argued change with one verifiable
  number in it is not thereby verified.** Ask what the number governs. If it
  governs amplitude and the complaint was about structure, nothing has been
  established.

## A parameter increase that reveals a bug is a diagnostic, not a cause

The same edge defect became visible when the excursion was raised from 190 mm to
400 mm and the edge turned into a sawtooth, moving 649 mm between adjacent
vertices. The obvious reading is that 400 mm was too much. It is the wrong
reading. At 190 mm the identical defect was producing about 300 mm of
inter-vertex jump — already larger than the whole nominal excursion — and was
merely too small to name from a frame.

> **Raising the parameter did not create the defect. It scaled a latent one into
> visibility.**

This matters because the two readings lead to opposite actions. "400 mm is too
much" leads to reverting to 190 mm, which restores a scene that looks acceptable
and leaves the bug in place, still wrong, still waiting. "400 mm made a latent
bug visible" leads to fixing the noise, after which 400 mm is fine and 190 mm
was never right either.

The tell is proportionality. If a defect grows *linearly* with the parameter
from zero, the parameter is plausibly the cause. If it is already large at the
old value, or grows faster than the parameter, or appears at a scale the
parameter does not set — 649 mm of movement from a ±400 mm envelope is
arithmetically impossible for anything with a wavelength — then the parameter is
a magnifying glass and the cause is elsewhere.

**So when turning a knob makes something ugly, measure at the old setting before
turning it back.** The most valuable moment in a defect's life is the moment it
first becomes visible, and reverting the change that exposed it throws that
moment away. A parameter increase is one of the cheapest bug-finding tools
available, and it is usually mistaken for the bug.

## A stale warning is worse than no warning, because it is believed

`RESUME-PLAN.md` carried a section headed "Terrain's `groundSoil` contract is
NOT published — do not code against it". It was accurate when written. It was
wrong for two rounds after the service was published and probe-verified, and
during those rounds it was the only statement in the repo about that contract,
sitting in the file every agent reads first.

A missing note costs a question. A stale note costs the work that the question
would have produced, plus the work spent on the alternative someone built
because they believed the thing they needed was unavailable. It is strictly
worse than silence, and the more authoritative the document, the worse it gets.

Two habits follow, and the second is the one that actually works:

- A warning that says "not yet" should say **what would make it obsolete**, so a
  reader can check the condition instead of trusting the sentence. "Not
  published; will be once `soilprobe` agrees with the GPU" is falsifiable from
  outside.
- **The publishing act and the retraction are one commit.** Whoever publishes a
  contract deletes the note that said it did not exist, in the same change, and
  the write-up says the deletion happened. Anything that leaves the retraction
  as a follow-up will not get it, because the person who knows is now busy with
  the thing they just published.

---

## 39. A defect can suppress a correct variation, so deleting the defect makes the frame look *less* consistent while being more right

This is the inverse of the usual assumption and it caught the whole team for an
hour, including me. It is close in shape to case 36 (the counterfeit ground
disc) without being the same failure: there, two errors multiplied to a
plausible product. Here, **one error masked a correct behaviour**, so the fix
made a symptom worse.

The scene had a complaint of "warm frames and cool frames that do not look like
the same moment." Hypothesis on the table, and it was a good one: something in
the lighting is inconsistent across view directions, find it and remove it.

Measured instead. Ground R−B by pose, ordered by the view's angle to the sun:

| angle to sun | 0° (contre-jour) | 60° | 105° | 160° (anti-solar) |
| --- | --- | --- | --- | --- |
| ground R−B | 23.7 | 9.4 | 7.6 | 5.0 |

**Monotonic. That is one light seen from four directions, which is what
consistency looks like** — not four lights. There was no inconsistency defect to
find.

Then the part that matters. Cross-pose spread across the ambient fix that
deleted the over-warm non-directional fill: **15.7 → 18.7.** Removing the defect
made the frame *more* view-dependent, because the defect was a constant warm
floor added to every bearing equally, and a constant floor compresses the
relative spread of everything above it. The counterfeit was doing double duty:
it was wrong about the absolute level *and* it was hiding a correct variation.

### The general form

**A defect that adds a constant to a varying quantity suppresses the variation's
visibility. Removing it therefore increases apparent inconsistency.** Any
non-directional term — an ambient fudge, a flat fill light, a clamped floor, a
minimum-value guard, a uniform bias — is capable of this. When you delete one,
expect variance to go *up*, and do not read that as a regression.

The trap for whoever meets this next: the instinct on seeing spread widen after
a fix is to restore some fraction of what was removed, "to taste." That puts the
counterfeit back at reduced strength, which is strictly worse than either
endpoint — you now have a fudge too small to hide the variation and too large to
be correct, and no measurement will tell you what fraction is right because
there is no correct value for a term that should not exist.

### How to tell this case from a real regression

Ask whether the variation that appeared is *ordered by something physical*. A
correct variation that was being masked will correlate monotonically with a
geometric quantity — here, angle to the sun. A genuine regression will not; it
will look like noise across poses, or it will be ordered by something
irrelevant like render order or pose index. Check the ordering before you touch
the fix.

---

## 40. Name a measurement region after where it is, never after the effect you are hunting

Cost: a grade decision was taken by the project lead on the strength of a
number I had mis-attributed, and the change authored against it was a no-op.

I reported "upper band R−B = −37.4" as evidence that **the haze** was too blue
at dawn, and built a physical argument for warming it — an argument that was
itself sound, and is preserved in `lightShaderPatches.ts`. Then I warmed
`uHazeCool` from B/R 1.81 to 0.86, rebuilt, re-measured, and the pixels did not
move: upper R−B −19.8 → −20.0, ridge R−B 12.0 → 11.9, far field 11.4 → 11.5.
Nothing, anywhere.

Cause: **the region I had named "upper band" was almost entirely sky dome.** The
dome is built with `fog: false` (`lightSky.ts`), so no haze uniform can reach it
by construction. The −37.4 was `uMid`/`uZenith`, the dome's own gradient. And
the geometry that *does* sit at the distances where the haze term dominates —
the horizon bands — sets `fog: false` too and runs its own `hazed()` ramp
(`VegetationSystem.ts:561`, which carries an explicit note saying so). Measured,
that far field was already **warm**, R−B +10 to +12. The premise "the far field
is blue" was false for every surface the haze can actually touch.

So there were two independent errors and they pointed the same way: I named a
region after the effect I was looking for, and I never checked which system
owned the pixels inside it.

### The rule

**Name regions by location and then separately establish what geometry is in
them.** `upper` is a fine name; `haze_band` is not, because the name asserts the
conclusion and every later reader — including the author an hour later — will
take the assertion as established. A region name is not a place to record a
hypothesis.

### The cheap check that would have caught it, and it is not a region

Before attributing a band to a term, **run the forced ablation for that term and
diff whole frames.** The haze already had `?haze=0` for exactly this purpose. A
whole-frame diff against `?haze=0` needs no region choice at all, cannot be
contaminated by a bright bush at the edge of the box, and answers the only
question that matters — *which pixels does this term touch* — directly rather
than by inference. My first ridge measurement had sd 51.6 in an 8400-pixel box,
which was the tool telling me the box held several different things; I read past
it.

Corollary worth its own line: **a material that opts out of scene fog silently
removes itself from the lighting agent's reach.** Two of them here, one of which
left a comment addressed to me that I found only after the wasted round. If you
opt a material out of a scene-wide term, the comment is necessary and not
sufficient — publish or consume a service instead, so the coupling is a call
site rather than a note. That is what `hazeTint` now exists for.

---

## 41. Backticks inside a GLSL comment terminate the template literal

Thirty seconds to fix, worth four lines so nobody spends longer. Shader source
in this project lives in JS template literals. This project's comment style
quotes identifiers in backticks. Those two conventions are incompatible:

```
    // the disc terms are omitted from the `evaluateSky` CPU port
```

inside a template literal ends the string at `evaluateSky`, and the errors
surface as `TS1005: ',' expected` several lines further on, pointing at the
*shader* rather than at the comment. Write identifiers bare inside GLSL. The
compiler catches it immediately, so the only real cost is misreading the error
location.

## A probe that cannot fail is not evidence, and "has sides" is the wrong half of the question

Car's rule — *an offset surface cannot read as a separate object* — is right, and the
twenty-line test it recommends is worth having in every system. Implementing it
for pumps produced two corrections worth carrying, because both are traps in the
recommendation itself rather than in the idea.

**The reference frame in the recipe is undefined for a closed solid.** The test
as written is "the fraction of area whose normal points more than 60° off the
part's *area-weighted mean* normal". For a ribbon that is exactly right. For any
closed solid the opposite faces cancel, the mean is the zero vector,
`normalize()` returns zero rather than erroring, every dot product against it is
zero, and every triangle therefore scores as a side. The first run of
`tools/pumprelief.mjs` reported **100% side area and 0.00 mm depth for a cube**
and pronounced all seven sections of the pump "solid". It was caught only by a
selftest that fed it a plane and a box and demanded opposite answers.

Use the **modal** normal — the heaviest bin of face directions, ~7° buckets,
sign-folded — which is well defined for a plane, a ribbon and a box alike.
Anti-parallel must count as *the same* orientation, not as a side: a back face is
never visible at the same time as the front and contributes no second line.

**"Does it have sides" is not the question that predicts legibility.** The
corrected test then condemned the 110 plate returns that had just been added to
fix the seams — every one of them a wall at 33° to 75°, each correctly reporting
zero depth along its own normal, because *a wall does not need a wall*. The
column that actually decides whether a part can read is its area **measured
against the parent surface's plane**, not against its own. On an axis-aligned
cabinet that is one line:

```
offPanel = area whose |n.x| and |n.z| are both under cos(15°), over total area
```

The pump's shut-line floor came back at **0%** — every triangle a viewer can see
in an 8 mm gap faced exactly the way the panel faced, so it differed from the
panel only by albedo and by a hand-set `envMapIntensity`. That is the mechanism
behind an independent critic's phrase "read like drawn outlines... too uniformly
dark and graphically clean", and both halves of it fall out of the one number:
a constant cannot vary, because nothing about it is a function of anything.

### The fix is a section, and the section can be free

The gap was already real geometry — 8 mm wide, 5 to 17 mm deep, with a dark
floor. What it lacked was any surface *turning into* it. Pressing a return around
each plate's perimeter, sloping from the plate's front face back to the backing
skin, means two adjacent plates meet the gap with 4 mm of return each and it
becomes a V: the upper plate's return faces down and sees the ground, the lower
one faces up and sees the sky, and the vertical pair faces sideways where this
sun's N·L is 0.901 against the face's 0.390. **The tone is now a consequence of
the slope**, and because `rel` grows per row the slope runs 33° to 75° up the
cabinet, so the joint varies by row and by face without anyone authoring it.

Two quads per edge, merged into the mesh that was already there: **no new draw
call, ~700 triangles per pump**. The returns carry the *panel* material, not the
dark seam paint — darkening them as well would put the tone back into a constant
and hand the uniformity straight back.

### And the same defect was sitting next to it, unexamined

The weep stain under each fastener was a `PlaneGeometry(7.5 × 26 mm)` in the
near-black slot material, 0.6 mm proud of the panel: a hard-edged black
rectangle, 34 × 10 px, of constant tone. Every bolt read as a tadpole. Note that
`offPanel` correctly gives a stain 0% and this is *not* the fault — a stain
should shade as the surface it lies on, because it is that surface with dirt on
it. What condemned it was hard edges, a rectangular outline, and being the
darkest material in the frame. **The structural test does not subsume taste**;
it tells you which complaints have a mechanical cause, and the ones left over
still have to be looked at.

The third probe in this system caught asking a well-formed question about the
wrong axis, in one evening. `seamprobe` measured the seam's *contrast* and was
satisfied throughout. Contrast was never the problem; where the contrast came
from was.

## The range a published field reaches at *your* geometry is the contract, and it can be zero

Building found that `groundAccum.fines` bare-multiplied into its wall coverage
made the wall *cleaner*, because the field reads 0.013–0.21 across the site and
nothing at a call site reveals that. Pumps is the harder case, because the island
is the most swept ground on the site, and the shape of the answer is different
enough to be worth recording separately.

`tools/pumpsoil.mjs` samples all four cabinet skins on both islands, 96 points:

```
fines    0.1053 .. 0.1250   span 0.020    (site-wide 0.0059 .. 0.9936)
grime    0.0000 .. 0.0000   span 0
swept    0.0000 .. 0.0000   span 0
shelter  0.0000 .. 0.0001   span 0.0001
lee      0.0000 .. 0.8963   span 0.896
wallBase(0, up).splash — 0.49 at 20 mm, 0.18 at 200 mm, 0.03 at 500 mm, 0 by 800
```

**Three of the five fields are identically zero at this geometry, and all three
are right to be.** A graded island pad has no standing water, is not driven over
and is not sheltered. `fines` is not zero but is *constant to within 2%*, which is
worse in one specific way: it looks like a signal in the source and is a flat
tint in the frame, so an author who multiplies it in and then reaches for the
per-instance RNG to get variation has written a private noise function wearing
the shared field's clothes. That is the failure mode to watch for, and it passes
review because the shared field is right there in the call.

### What to do instead of normalising

The tempting repair is to rescale each field to the span it reaches locally.
**Do not**, for the flat ones: dividing by a 0.020 span amplifies 2% of noise to
full scale and manufactures structure the field is explicitly denying. The fields
that are flat here are flat *because the place is*.

- A field with real local range (`lee`, 0–0.90) is used directly.
- A **profile** always has range, because it is a function of geometry rather than
  of place — `wallBase.splash` spans its full useful extent over the bottom
  500 mm whatever the site does. Profiles are where the structure comes from when
  the fields are flat.
- A field that is locally constant is demoted to a *level* — a narrow multiplier
  whose absolute value is read for what it means. 0.116 on a site range of
  0.006–0.994 says "this is clean ground", and clean is the correct answer for a
  forecourt island.
- A field that is locally zero is **dropped, not down-weighted**. A term that
  does nothing and a term that is subtle are the same screenshot; a zero term is
  strictly worse than no term, because it reads as though the field had been
  consulted.

The general rule: **probe before you compose, and compose fields with profiles.**
The field says *where*, the profile says *how*, and if the field is flat the
profile is carrying the whole result and you should know that before you tune it.

## Two quantities that scale differently cannot share one scalar, and the switch will only reach one of them

The companion to *"ask what physical quantity your term stands in for"*, and the
reason to write it separately is that the earlier note tells you a term is wrong
and this one tells you what shape the fix has.

The canopy soffit is lit by two things: sky and slab bounce entering under the
fascia, and the lamps' own spill onto the panel they are bolted to. Both were
baked into one lightmap, summed per texel, and the map rode one
`lightMapIntensity`. Then that scalar was correctly made proportional to
`scene.environmentIntensity`, because the sky term stands in for a quantity
Lighting owns. **That fix silently broke the other term**: the lamps now
brightened when the sky did.

The second defect is worse and was found by asking what `setFixtures(false)`
does. It set the lens emissive to zero. The lenses went dark and *eight baked
lamp collars kept glowing on the soffit* — the switch was wired to the object you
look at and not to the light it makes. A control that half applies is the most
expensive kind this project has met, because the half that works is the half you
photograph to confirm it worked.

Both follow from one structural fact, which is worth stating without the canopy:

> One texture multiplied by one scalar expresses exactly one quantity. If two
> physical quantities live in that texture, every control you attach reaches
> both of them, and every control that should reach one of them is wrong.

**The tempting fix is a compensation and should be refused.** Baking the lamp
term pre-divided by the environment makes the multiply cancel and the numbers
come out right today. It is also a division by a value owned by another system,
which blows up as that value approaches zero, and it is a compensation — this
document already records those as things that outlive the bug and become the bug.
The correct fix is to stop sharing: a second map, on the same UVs, on a channel
whose scalar means what that term means. Here the lamp term became an
`emissiveMap` with `emissiveIntensity`, which is independent of the environment
by construction rather than by arithmetic.

**How to test it, given neither symptom is visible in one frame and neither is
greppable.** The two terms have different *shapes*: the sky term depends only on
distance to the deck edge, the lamp term only on distance to a fixture. So sample
the sky bake at a fixture, and at a second point with the *same edge distance*
that is far from every fixture — sweeping the iso-contour for the furthest such
point rather than naming one, so the test survives a change to the fixture plan.
If a lamp signal is still in there, the fixture sample is brighter. Two samples
that must agree, no absolute target: the ranking discipline applied to a texture
rather than to a frame.

**The dividend, and the reason this is not just hygiene.** Splitting the terms
*is* the night-to-dawn transition, and it costs nothing to animate. As the sky
comes up Lighting raises the environment, the sky bake rises with it, the lamp
term stays where it is, and the lamps' relative contribution falls on its own.
"Canopy lights still on at dawn" is then a consequence of two terms scaling
differently, not a curve somebody authored and will have to re-tune. **When
separating two conflated quantities makes a feature you wanted appear for free,
that is the strongest available evidence that they were genuinely two
quantities** — a distinction that was merely tidy would not have paid for itself.

One trap sits inside the fix. The second map went onto `uv1` to match the bake,
but `emissiveMap` defaults to `uv`, and on this mesh `uv` is a *per-metre tiling*
set. The default would have repeated eight lamp collars inside every square metre
of a 13 m deck: a channel error that presents as a texture error, and one you
would debug by looking at the texture. Bind the channel **inside the factory that
makes the texture**, not at the call site — then the texture arrives correctly
bound and there is no line for a caller to forget. Same reasoning as naming the
channel in the shared constants rather than writing `1` in the factory and `1` in
the probe, because two literals that match today are not agreement.

Cross-references: *"A term keyed to the wrong variable is not a weak term"* is
the single-term version of this; *"A term that stands in for another system's
quantity has to scale with it"* is the note whose fix created this bug; case 26
and *"When more of a quantity does not help, the mechanism is wrong"* are the
same soffit, two rounds earlier.

## A grid's rendered value is a property of the interpolant, not of the nearest sample

Two mistakes in one small adoption, in opposite directions, and the pair is more
useful than either.

Adopting `contactShadow.ts` for the canopy column feet meant choosing a grid
resolution. The occluder is a 640 mm plinth that touches, so the module's falloff
is its 45 mm floor, and most of the grid therefore lies under the plinth. The
first assertion asked for the darkest **vertex** outside the pad and reported
0.200 against a peak of 0.780 — apparently the lamp-collar defect again, a
near-black core buried under the object casting it.

That number was true and the conclusion was false. With a 22.8 mm cell the vertex
nearest the contact line lands 0.6 mm *inside* the pad, so the nearest visible
vertex is a full cell out — but **the quad between them straddles the pad edge,
and the renderer interpolates across it**, so the ground 1 mm outside the plinth
receives 0.739, which is 95% of the peak. Nothing was buried. Acting on the
vertex reading would have meant a much finer grid: 32 000 triangles spent fixing
a defect that did not exist.

> Any assertion over a vertex-interpolated attribute — vertex colour, vertex
> alpha, baked AO, a lightmap's texels — has to sample the interpolant at the
> point that matters. A statement about the samples is a statement about
> something the viewer never sees.

The second mistake was the resolution derivation itself, and it was corrected by
sweeping rather than by reasoning. Alpha delivered at the contact line, as a
fraction of peak:

```
res    8     12     16     20     24     32
frac   0.48  0.72   0.96   0.73   0.70   0.95
```

**Non-monotone.** res 16 beats res 20 and res 24 at a quarter of their triangle
cost. Fineness is not the governing variable: what governs it is whether the
occluder's edge lands just *inside* a grid line, because that is what puts a
near-peak sample where the straddling quad can carry it outward. Cells that leave
the edge mid-quad deliver a mid-quad value however small they are.

This one is a live trap for anyone adopting the module, because the natural
response to a soft-looking decal is to raise `res` — and raising it from 16 to 20
makes it visibly worse, which looks like the tool being broken. The condition is
`cell = reach / k` for integer k, written as an expression so it survives a
change to either the footprint or the module's falloff floor. Take k = 2 rather
than k = 1: k = 1 leaves a single cell across the whole falloff and flattens it
to the linear ramp the module warns gives an airbrushed oval, while k = 2 holds
the squared shape (midpoint 0.198 against 0.195 for a true t²).

The general form, since sweeping is cheap and reasoning about grids is not:
**when a quality metric depends on alignment rather than on magnitude, sweep the
parameter instead of arguing about it** — an alignment-governed metric is
non-monotone, and every intuition about "finer is better" is silently an
assumption of monotonicity.

Related: `probe-rank` structurally cannot find a missing contact shadow, because
it ranks surfaces and a missing shadow is not a surface. The canopy's column
bases sat correctly in the tonal order at 57.1 with p10 25 while not appearing to
stand on anything, and no ranking of surfaces would ever have said so.

Postscript, and it is the third mistake in the same adoption. The first pixel
measurement of the finished decal reported **DELIVERS NOTHING**, from a pose
named `at_pump` that looks at 1.35 m from 1.1 m away and therefore frames 0.84 m
to 1.86 m. The decal is at 0.68 m: below the bottom edge of the frame. That is
the 22-pixel trap in its absolute form — and it caught me *one hour after I
wrote the note warning about it*, on the element the note was written about,
because the pose list was already there and reusing it felt like rigour. The
reusable form is narrower than "check your pose": **a pose is named for where the
camera is, not for what it can see, so a pose that sees an object's body will
routinely miss the 200 mm of it nearest the ground** — which is exactly where
contact, plinths, base plates, skirts and road film all live. Give ground detail
its own pose aimed at the ground.

## Some parameters have two physically meaningful values and a continuous slider, and `metalness` is one

`probe-rank` put the canopy's light-fixture housings at the bottom of the frame's
tonal order: luma 26.6, **p10 = 1**, under a soffit at 149.6. p10 = 1 is crushed
black, which no photograph of a painted object under an open sky contains.

The cause was `metalness: 0.35`. That is not a dark grey painted metal, it is not
a slightly-metallic anything, and the number is not wrong by degree:

> A surface is a conductor or it is a dielectric. `metalness` is the mixing
> weight between two different BRDFs, not a "how shiny" control, so a fractional
> value asks the renderer to make a material that does not exist. Every value
> except 0 and 1 is a request for a physical impossibility, and the ones near
> the middle are the most impossible.

What 0.35 actually did: discard 35% of the diffuse response, and replace it with
a specular lobe *tinted by the base colour*. On a dark base colour that is a dark
specular, and a specular only appears where the environment is bright — which,
for a fitting tucked up under a deck, is nowhere. So the parameter removed a
third of the light the housing could return and gave back something that could
not be collected. Painted die-cast aluminium is a dielectric; the answer is 0,
not a smaller fraction.

Three separate darkenings were stacked on one already-dark surface: the base
colour, the metalness diffuse loss, and a grime film at 0.42 with a near-black
`filmColor`. **Each was defensible alone and the product was black.** That is
worth watching for on its own — darkening terms compose multiplicatively and
each one is reviewed against the surface as it was *before* the others, so a
review of each term in isolation passes while the result is off the floor.
Setting metalness to 0 and easing the film to 0.32 moved the housings to luma
39.9 with p10 = 5, still comfortably the darkest thing in the frame, which is
correct for a dark fitting silhouetted against a lit panel.

The general form, since `metalness` is not the only such parameter: **when a
continuous parameter has only a small set of physically meaningful values, an
intermediate value is a bug that looks like a tuning decision** — and it will
survive review indefinitely, because a reviewer sees a plausible number in a
plausible range rather than a category error. Ask which of the meaningful values
this material is, and if the answer is "between them", the material is two
materials and needs two meshes.

Found by ranking rather than by looking. Nobody reported the housings as a
defect, and they read as acceptably dark bronze in a screenshot; it was being
last in a sorted list with p10 pinned to the floor that made it a finding.

## A metric with no control fabricates the finding it was built to look for

Asked to test a critic's periodicity complaint ("repeating vertical columns /
evenly scalloped silhouette"), I ran Building's `probe-period.mjs`, which sweeps
every lag and reported no repeat above r 0.25 anywhere in the frame, max 0.100.
I did not believe it, because a 100-row band dilutes a 48-row horizon, so I wrote
my own autocorrelation over the band's own rows. It found a peak at lag 293 px
at r 0.711, up from r 0.444 before that round's change — a term of mine
apparently strengthening the exact defect the critic had named.

All of it was my instrument. Two independent faults, both of which only inflate:

 1. **A normalisation that grows with lag.** I divided by the overlap count to
    "correct" for the shrinking sample at long lags (`s / v0 * (n / m)`). That is
    not a correction, it is a gain of `n/m` applied to the noisiest end of the
    curve. Recomputed unbiased, lag 293 is **r 0.155**, not 0.711.
 2. **A peak detector with no null model.** I took the largest local maximum of
    the autocorrelation and called it a period. Run on low-pass noise with no
    periodicity whatsoever, the same detector returns apparent peaks at r 0.075,
    0.221, 0.017, **0.456** and -0.181 across five seeds. So anything under about
    0.46 from that detector is indistinguishable from nothing, and my "finding"
    of 0.444 was *below* the noise ceiling.

A real period also has harmonics. At lag 586, twice the claimed 293, r is 0.024.
That single check would have closed it before I spent a build and a capture
testing a fix for it.

The generalisable part is not "be careful with autocorrelation". It is that
**a detector applied to a signal known to contain the defect cannot be
calibrated by that signal.** The only way to know what my number meant was to
run it on something guaranteed to have no period, and that control costs four
lines. Every measurement in this project that has embarrassed someone tonight
has been a measurement without a null: the horizon-raggedness average over
columns selected for not moving, the clamp bind rate over the wrong population,
the single-lag step metric. The fix is the same each time and it is cheap.

Corollary, worth stating separately because I got this backwards: **when a
shared instrument and a private one disagree, the shared one has been
controlled and the private one has not.** `probe-period.mjs` ships a selftest
that plants a 23 px repeat and recovers it at r 1.000, and reports r 0.054 on
the noise control beside it. Mine shipped nothing. I should have weighted them
accordingly instead of assuming the disagreement meant the shared tool was
too coarse.

## A consistency check can agree on the wrong value, and then it certifies the bug

`sweepTube` in `src/gen/vegPine.ts` builds every tube in the vegetation system —
pine trunks and branches, fence posts, steel T-posts, utility poles, crossarms,
braces, insulators. Its wall triangles have been wound inside out since the
function was written. Measured: **24 of every 30 triangles reversed**, the walls,
with the end cap correct, in all six path directions.

It survived because two different things hid it, and each looked like a pass:

**1. A normal recomputation that made the geometry agree with itself.**
`buildPine` calls `wood.computeVertexNormals()` after assembly. That derives the
shading normals *from* the winding, so geometry and shading agree — and a
scene-wide per-triangle audit reported `veg-pine-wood` at **0.0% reversed**
while the props built by the same function reported 80%. The check passed. It
passed on the wrong value: the recomputed normals pointed into the trunk, so
every trunk and branch was lit inside out, and front-face culling drew the far
wall of each tube rather than the near one. `computeVertexNormals` cannot fail.
Whatever winding it is given, it produces normals that agree with it, which
means calling it converts a winding bug into a shading bug and destroys the
evidence in the same statement.

**2. Pixel evidence too small to read.** Car's `probe-unseen` did flag one of
the four affected meshes as WINDING, on the right general principle — invisible
normally, visible with `DoubleSide`. But it could recover only **1 px out of 540
triangles**, because framed to fit a six-pole line every insulator is 5.8 cm and
sub-pixel, and `DoubleSide` roughly doubles the chance a sub-pixel fragment
survives. So "0 px -> 1 px" is what a correctly wound sub-pixel mesh looks like
too, and the probe said as much in its own output: it had to judge that mesh
from six axes because it is a closed shell with no mean normal. The strongest
available pixel evidence for a scene-wide geometry bug was one pixel, and it was
reasonable to discount it.

The instrument that settles it needs no pixels, no framing and no threshold,
and it is exact: for each triangle compare the geometric normal from the vertex
order, `(b - a) x (c - a)`, against the mean of the three shading normals the
generator wrote. Disagreement in sign is a reversed triangle, full stop. It also
sees inside a merge, which is the only reason this was findable at all — 218
plants share one mesh here. In `tools/_vegscale-entry.ts` as `auditWinding()`
and `tools/_vegwind-entry.ts` for a builder in isolation; both belong to
whoever wants them.

Two rules out of it:

 - **`computeVertexNormals()` on generated geometry is a claim that the winding
   is already right.** If it is not, the call launders the defect. Audit winding
   before recomputing normals, or do not recompute.
 - **Auditing the builder in isolation is worth more than auditing the scene.**
   The scene audit gave two conflicting answers, 0% and 80%, from one function,
   and I spent time hunting a mirroring transform that did not exist. Six
   direction cases against the raw builder gave the answer in one run and
   incidentally refuted the offered hypothesis, which was that the winding
   depended on the direction the caller swept the path. It does not; it is
   unconditional.

## Prove a quantity is out of range before you tune it, and then bound it rather than setting it

The distant bands had a white fringe along the crown edge. The tempting move is
to tune the rim term down until the fringe goes, which is a value hunt with no
stopping condition and no way to know you have finished.

There was an argument available instead. What reaches the eye from a distant
stand is `L_surface * T + L_haze * (1 - T)`, a convex combination, so it cannot
exceed the larger of the two. For an 0.08-albedo conifer stand `L_surface` is
below the sky at dawn, therefore **a crown pixel brighter than the sky behind it
is impossible at any parameter setting.** Measured, 44.9% of unoccluded columns
had one, mean excess 8.6 luma. That converts a taste question into an
out-of-range assertion, and the fix is then a *bound* — hold crown luma under the
sky radiance for that azimuth — not a value. A bound needs no tuning and cannot
be wrong in the direction that matters.

Same move as Lighting's ground disc, which was found 7.6x too bright and 12x too
warm by arguing from what a ground plane can return rather than by grading it
until it looked right; and the same as the transmission-term case, where the
argument "a term that cannot reach its target at 8x is in the wrong place, not
too weak" replaced a tuning search with a decisive experiment. When a quantity
has a physical ceiling, find the ceiling first.

**The rejected first attempt is the more useful half.** `ceil * (1 - exp(-v / ceil))`
closed the fringe and darkened every band by 10 luma to correct an 8.6 luma
overshoot, because it compresses from *zero* — it is a correction applied across
the whole range to fix a fault at one end of it. The tell was general and worth
keeping: **the mean moved when only the maximum was wrong.** If a correction
aimed at an extreme shifts the centre of the distribution, it is applied at the
wrong end of the range. The working version puts a soft knee at 78% of the
ceiling so everything below it is untouched, and the band mean is unchanged to
0.1 luma.

---

## 42. A bug report names a cause, and the name is not evidence — switch the term off and look before you ablate

Cost: three headless rounds, roughly fifteen minutes of GPU, and I came close to
shipping a shadow change for a defect that is not in the shadows.

The report was "patterned blotches on the ground that read like shadow-map
noise, not surface detail." The clause after the comma is a *conclusion the
reporter drew*, and I adopted it without noticing that I had. Everything I did
next was competent and pointed at the wrong subsystem:

1. Built a purpose-made instrument (`tools/mottle.mjs`) that band-limits to the
   blotch spatial scale so surface grain cannot masquerade as shadow noise, and
   sweeps the whole frame so no region is hand-picked. Good tool. Still a
   shadow tool.
2. Swept filter radius 0.02 / 3.2 / 10 texels. Mottle p50 7.280 / 6.443 / 5.569
   — **falling** with radius, which falsifies every filter-error mechanism.
3. Swept `normalBias` 0.055 → 0.002. Moved p50 by 0.6%. Falsifies acne and bias.
4. Held filter width constant in world space at 6.2 cm and coarsened the map 4x
   (8192@3.2, 4096@1.6, 2048@0.8 texels). Moved p50 by 2%. Falsifies "the texel
   grid is showing through".

Three falsifications, each clean. **A run of falsifications is itself a
finding**: when a series of well-controlled experiments on a subsystem all come
back negative, the hypothesis under test is not "which mechanism in this
subsystem" but "is it this subsystem at all."

Then I cropped the same ground patch at 2x with the sun's shadows **completely
off** and compared. The regular diagonal cross-hatch lattice and the pale
speckles were present and unchanged. It was the ground material all along, and
the likely mechanism is a bare hash sampled on a grid, which produces exactly a
regular lattice.

### The rule, and it is cheap

**Before ablating within a subsystem, ablate the subsystem.** One capture with
the whole term disabled, cropped at 1:1 and looked at, costs one render and
answers "is this mine" before any effort goes into "which part of mine is it".
I had that capture — `lforce=noshadow` was in my second round — and I fed it to
a statistic instead of my eyes. The statistic said +25%, which is true (real
cast shadow from the canopy) and which I read as confirmation.

That is the trap in its exact form: **the frame contained a true positive for
"shadows affect this region" and I accepted it as a true positive for "shadows
cause this pattern."** A region can be genuinely affected by a term and still
have its *appearance* determined by something else entirely.

### Corollary on inherited vocabulary

Once a defect has a name containing a subsystem, every later discussion of it
routes to that subsystem's owner, including in the owner's own head. Rename it
to a description as soon as you have one: not "the shadow blotches" but "the
diagonal lattice on the concrete." The renaming is what let it be routed
correctly, and it should have happened before the measurement, not after.

### 41. A narrow-band random field is not a lattice, and rotating it again will not help

The near-field ground rendered as an evenly dappled stipple — a pebbled carpet
rather than uneven ground. It had already been rewritten once that night for
exactly this symptom, from `sin(x) * cos(z)` to a sum of waves on rotated bases,
because two axis-aligned sines are a lattice and domain warping bends the cells
without unaligning them. So the obvious read was that the de-latticing had not
gone far enough, and the obvious next move was more rotations.

A 2-D autocorrelation of the rendered dirt refuted it. Correlation decayed
monotonically from r = 0.92 at a 2 px lag to zero by 40 px, with **no secondary
peak anywhere in the sweep**. That is the signature of a random field. There was
nothing periodic left to decorrelate, and a fourth rotated basis would have
produced another plausible screenshot and no change.

What was actually wrong: the three waves had k = 1.07, 1.31 and 2.21 — a spread
of 2.07x, **barely one octave.** The field was random in position and uniform in
*scale*, and that reads as a pattern, because the eye picks up scale uniformity
and not only repetition. Blobs of one size scattered randomly look like a
texture applied to a surface; real ground has clods at every size. Widening the
band to about 3.2 octaves, 13.7 m down to 1.8 m, fixed what four rotations would
not have touched.

Two things generalise past this case:

**"Looks like a pattern" has at least two causes and they need opposite fixes.**
Periodicity is cured by decorrelation; scale uniformity is cured by widening the
spectrum. Autocorrelation tells them apart in about twenty lines, and guessing
picks wrong roughly half the time — with the added cost that the wrong fix is
indistinguishable from an insufficient right one, so it invites a third attempt
down the same dead end.

**Amplitude per octave should be set so each octave contributes equal slope, not
equal height.** Shading responds to slope (case 33), so with equal amplitude the
long wavelengths shade almost nothing and the shortest dominates, which is a
narrow band in effect however wide it is on paper. Holding `a / k` constant is
what makes a spectrum visible across its whole range.

And one boundary condition that is specific to graded meshes but bites the same
way: **Nyquist has to be checked per octave, not per term.** A single distance
gate for a multi-octave field is correct for one octave and wrong for the rest.
The 1.8 m octave here needed its own gate at 52 m, where the coarsening vertex
spacing passes its limit, while the 13.7 m octave is happy to 145 m.

### 42. A diagnostic stored in a build directory is deleted by the build

Five probes — the slope census, the rut control, the accumulation range, a
winding check and an edge-parity measurement — were written into `.shot-build/`,
which is the capture harness's private build tree. The harness cleans that tree
on teardown. Every one of them was destroyed by the next capture, and several
rounds silently re-derived the same census from scratch because reaching for the
tool was cheaper than noticing it was gone.

The cost is not the retyping. It is that **a measurement you cannot re-run is an
anecdote**: the range block in a published contract cannot be checked against
the field it describes, a forced-off control cannot be repeated after a retune,
and every number in a handover becomes a claim about the past rather than a
property that can be tested now. The stale-contract failure (case 40) is a
direct consequence — a declared range drifts because nothing re-measures it.

The fix is one line of judgement: scratch output belongs in the scratch tree,
and the thing that *produces* it does not. `tools/dirtscan.mjs` now re-runs the
whole census in two seconds and asserts the published ranges still match the
field, printing `STALE` if they have drifted.

### 43. A forced-off control that reads no switch is worse than no control

The site's feature gates read `location.search`, which is undefined in Node, so
in a CPU probe every token evaluated to nothing and every feature stayed fully
on. A probe run with `nochurn` therefore returned the census **identical to the
default arm to within 0.001** — and the correct reading of two identical arms is
that the feature does nothing.

That is the trap. The control exists to distinguish "subtle" from "absent"
(case 34), so when the control is itself broken it does not fail loudly, it
returns the exact signature of the defect it was built to detect. The natural
response is to go and strengthen a feature that was working, or to delete it.

The cause was two mechanisms for one concept: a query string for the browser and
a private env var inside each probe, which no longer agreed once a name changed
on one side. The gate now reads the query string *and* the environment through
the same validated table, so `?force=nochurn` and `TFORCE=nochurn` are the same
switch — and the unknown-token report that already existed for the browser now
covers the probes too, which is what would have caught this immediately.

**A control arm needs its own positive evidence that it took effect.** The
cheapest form is that the arms differ *somewhere*: after the fix, each of the
three arms moved its own region and left the other two unchanged, which is
evidence the switch works and not merely that a number came out.

## Two code paths build the same thing and only one of them is photographed

The hose in this system is built twice: once in `buildPump`, which is what every
static capture photographs, and once in `PumpSystem.rebuildHose`, which runs only
from `setNozzleLift`. Weathering was wired into the second one. So the geometry
was correct, the CPU probe confirmed a vertex-colour range of 1.0–2.6 and a
faceting fix from 10 spokes to 14, **and every frame contained the original
smooth tube**, because nothing in a capture ever lifts a nozzle.

What caught it was not a probe and not the eye. It was the harness's own
**registry triangle count rising by exactly the number the other change in the
same round accounted for** — 1,056 for the splash darts, and not one triangle
more, when the hose change should have added 5,760. A total that is *precisely*
the expected value of a subset is a much stronger signal than a total that is
merely lower than hoped, and it costs nothing to print.

The general shape, which is not specific to hoses:

- A thing that is **rebuilt on interaction** has an initial build somewhere else,
  and the initial build is the one in every screenshot. Look for the second call
  site before concluding a geometry change is too subtle to see.
- **Publish the shared constants** (`HOSE_SPOKES` here) rather than repeating the
  literal, because the two paths must agree or the object visibly changes shape
  the first time a player touches it — a defect no static capture can ever show.
- The related trap one step earlier in the same change: a vertex-colour attribute
  does nothing at all unless the material sets `vertexColors: true`. Attribute and
  flag are two halves of one edit, and writing only the first produces a
  screenshot identical to writing neither.

Three variants of one failure in one evening — the invisible weep, the
un-photographed hose path, and the unset material flag — all of which measure
perfectly on the CPU. **The CPU can only tell you what you built, never what was
drawn.**

---

## A probe that hard-codes the value it checks will eventually check nothing

`probe-fallbacks.mjs` reports the car's surface-projection fallbacks — geometry
laid on a substituted flat plane instead of the real fascia, which reads as
tearing rather than as absence and so is easy to look straight past. It had a
section that named the offending placements, and the way it named them was a
list of literals copied from the call sites:

```js
["trim: exhaust finisher", -0.5, 0.352, false],
```

That literal was correct on the day it was written. Two consequences followed.

**It kept reporting a defect after the defect was fixed.** The call site moved to
0.364 and the probe went on printing the same "move the part up 7.4 mm" for
rounds, because it was measuring its own copy of the old number. A tool that
reports a stale failure gets ignored, which is the expensive part.

**Far worse, it was pointing at the wrong parts entirely.** Eighteen fallbacks
were being reported in `buildLamps`, and the probe's literal list contained
`headlamp bowl inner` at (0.429, 0.828) and `bowl outer` at (0.597, 0.828) —
both of which pass. When the builder was changed to record *where* it fell back
rather than only *how many* times, the real sites came out immediately:

```
front x=0.71 y=0.91  x 7  over the outline by 9.5 mm
front x=-0.71 y=0.91  x 7  over the outline by 9.5 mm
```

Nowhere near any coordinate the probe was testing. The count had been non-zero
and correct for a long time; the location had been unknowable, so the only way to
act on it was to guess, and the guesses were enshrined as a list that then went
stale. **A count without a location is not actionable, and the workaround for a
missing location tends to be a duplicated constant.**

The fix is in the builder, not the probe: `FALLBACKS` now pushes `{x, y, front,
over}` for each hit, capped at 64 entries, and `over` is the distance past the
outline — which is the number the remedy needs, because it is exactly how far the
footprint has to shrink or the part has to move.

### The defect it found, which is a rule in its own right

The failing sites were the headlamp shut line. The lamp's own footprint carries
this comment:

> Pulled inboard from 0.545/0.208. The front cap is usable to |x| ~ 0.775 at
> y = 0.85 but only 0.730 by y = 0.90, and the old footprint reached 0.753 at its
> top corner — off the fascia, onto the flat fallback plane. **It now stays inside
> the cap.**

True of the lamp. False of the shut line, which was built as `HW + 0.015` and
`HH + 0.015` — the lamp's footprint plus a 15 mm margin. **A margin added around
a footprint that was tuned to exactly reach its limit overhangs by that margin.**
The tuning note reads as a guarantee about the region and is only a guarantee
about one part of it.

Worth stating separately because the reflex fix is the wrong one: the remedy is
to shrink the *margin*, not the lamp. Two independent reviewers had already
complained that the headlamps read as featureless rectangles, so shrinking the
lens to make room for its own panel gap would have satisfied the probe while
fighting the brief. A shut line at 8 mm still reads as a line — real panel gaps
are 3–5 mm — and the 15 mm was generosity, not requirement. **When a constraint
is violated by A + B, check which of A and B you actually wanted.**

---

## Contact is an ambient-occlusion problem, and a correct shadow map cannot fix it

An independent critic reviewing rendered frames said every object in the scene
felt "placed rather than weighted", and named the car, the bollards, the pump
bases and the column bases together. That reads as a shadow complaint and is not
one.

A shadow map answers "does the sun reach this pixel". At this scene's 6.2° sun
elevation, essentially the whole footprint of every object is already inside its
own long shadow, so the sun term is saturated across exactly the region where
contact needs to read — it carries no information there. What is missing is the
ambient term: the sky is a hemisphere, and ground 20 mm from a car sill can see
almost none of it. **The cue the eye reads as weight is sky occlusion, which a
standard forward renderer does not compute at all.** So a scene can be correctly
shadowed, be verified as correctly shadowed, and still have every object looking
pasted on — and no amount of shadow tuning will move it.

`src/gen/contactShadow.ts` is the shared remedy, deliberately not car-specific.
Two things in it are the difference between contact and a smudge:

**The falloff length comes from the gap, not from the object's size.** Sky
occlusion at distance `d` from an occluder floating `h` above the ground falls
off over a length of roughly `h`. So a tyre, which touches, gets a small
near-black core, and a floorpan at 155 mm gets a wide weak wash. Giving both the
same radius — which is what happens when the radius is derived from the object's
plan size — produces the airbrushed grey oval that reads as a decal. The
*contrast between the hard core and the soft wash* is the whole effect.

**Elements combine multiplicatively on how much sky is left, not additively on
darkness.** Adding darkness saturates to black wherever two footprints overlap,
which is directly under the car, which is where the result is most visible.

Three smaller points that are each their own trap:

- The decal must be parented to the **ground**, not to the object. The car
  carries a fitted pitch and roll, and parenting the shadow to the body tilts it
  off the surface. This system has already had that bug once, in the baked tyre
  contact patch rotating off the ground.
- It must **not** receive shadows. It stands in for ambient the renderer does not
  compute; feeding it back through the shadow pass makes it vanish in shade,
  which is precisely where contact most needs reading.
- `depthWrite: false` with `depthTest: true`. A decal 8 mm off the ground that
  writes depth will occlude the tyre sitting in it.

---

## Probe the range of a shared field where *your* geometry samples it, and expect it to be flat

Terrain publishes `groundAccum` so every system agrees about where dirt collects.
Building found the contract hazard first: `fines` reads 0.11–0.21 on the swept
forecourt and 0.013–0.047 behind the building, so a bare multiplier tuned on one
made its wall *cleaner* on the other. **The range of a published field is part of
its contract**, and the composition has to be floor-plus-gain normalised to the
range you actually sample.

Probing that range over the car's own footprint before writing anything against
it changed the design, which is the point of probing first:

```
over the car footprint at (13.585, 34.97) +-1.05 x +-2.45:
  fines      lo 0.1334  hi 0.1760  mean 0.1560  span 0.0426
  swept      lo 0.0000  hi 0.0049  mean 0.0005  span 0.0049
  grime      lo 0.0000  hi 0.0000  mean 0.0000  span 0.0000
  lee        lo 0.0000  hi 1.0000  mean 0.2998  span 1.0000
```

**A site-scale field is very nearly flat across an object the size of a car.**
Over a 2.1 × 4.9 m stall, `fines` varies by 0.043 on a field published as
spanning 0.11–0.21. So it can supply a *level* — how dirty this lot is — and it
cannot supply a *pattern*. Driving per-panel variation from it would have
produced a uniform wash that merely looked data-driven, which is a worse outcome
than the literals it replaced, because it is a literal wearing a citation.

The corollary is the useful half: **pattern has to come from a field whose
variation is at your object's scale.** `lee` spans the full 0–1 across the same
footprint, because it is evaluated *relative to the object itself* rather than to
the site, so the sheltered flank is a real signal where `fines` is not.

And a field that does not vary where you sample it is not a signal at all:
`grime` is identically zero over the entire footprint and `swept` never exceeds
0.005, so neither is wired up. Reading a constant out of a shared service and
multiplying by it is strictly worse than a literal — it costs a dependency and
buys nothing.

---

## A region defined by a substitution diff still has to be the right *shape*

The substitution control's second job - proving a hand-picked measurement region
is actually on the thing being measured - extends further than picking regions.
It can *define* the region: measure the pixels that changed when the material was
swapped, because a pixel that did not move was not showing the material and has
no business in the average.

That is strictly better than a hand-picked rectangle, and it is still not
sufficient. The first grey-card derivation of the car's paint came back with a
clean-looking answer over 25% of the frame. The mean said nothing was wrong. The
bounding box of the same region said everything:

    extent: x 0-1599 (1600px), y 240-672 (433px) in 1600x900

Full frame width. The two arms had been captured from **different bundles** -
source was edited between them - so the diff contained every sibling's changes
as well as the material swap, and the "paint reflectance" was a number derived
from an arbitrary quarter of the scene. Re-capturing both arms from one bundle
(verified by identical sha1) brought the region to x 0-1401, y 240-672 at 57%
fill, which is a car-shaped silhouette in a close side pose.

So the check is two-part and the second part is the cheap one: **report the
extent and the fill of any diff-defined region, because a leak is wide and
sparse and a solid object is bounded and dense.** A mean cannot distinguish them
and will look plausible either way.

The underlying discipline is one already stated here, and it was violated by
accident rather than by reasoning: when you need a real before/after in a tree
several agents are writing to, both arms must come from the same bundle, selected
by a URL flag. Two sequential capture runs with a build in between are not an
A/B, and the failure is silent - the numbers are perfectly stable and perfectly
meaningless.

## A grid's indices imply a winding, and jitter makes that implication false

`buildMatSheet` lays a square grid, jitters every vertex by up to +/-0.4 of the
pitch in **both** axes so the sheet does not read as a grid, then triangulates the
cells using the original `(i, j)` indices. The indices are the only thing saying
which way round a triangle goes, and after the jitter they are sometimes wrong:
three corners can end up in the opposite rotational order from the one their grid
positions imply, most easily on the near-collinear ones. The `normal` attribute is
built from a tilt about +Y and always points up, so geometry and shading disagree,
the material is FrontSide, and the triangle is culled — **a hole in the mat, not a
visible error.**

92 of 22,882 triangles, 0.4%. Small enough never to be noticed and exactly the
wrong size to go looking for. Found only because a scene-wide per-triangle audit
existed and was cheap enough to run over everything.

The general shape: **any generator that separates "where the vertices are" from
"what order they are in" can have the second go stale when the first is
perturbed.** Jitter, relaxation, projection onto a displaced surface, snapping to a
mask, welding near-duplicates — all of them move positions while leaving an index
buffer that was correct for the positions before the move. The index buffer does
not know it has been invalidated and nothing will tell you.

### The instructive half: test the quantity the renderer consumes

The first fix tested each triangle's geometric normal against **+Y** and emitted
whichever order faced up. That is the obvious criterion for a horizontal sheet,
and it left **1 triangle of 22,882 still disagreeing.**

That one triangle is the whole lesson. The shading normals in this sheet are
deliberately tilted up to 30 degrees off vertical — that tilt is the term that
stops the mat reading as paint. On a sliver whose geometric normal is nearly
horizontal, "faces up" and "agrees with its own normals" are *different
questions*, and back-face culling only ever asks the second one. Testing against
the triangle's own mean shading normal instead of against +Y is the same cost and
is exact by construction: it cannot leave a residue, because it is literally the
predicate the renderer will apply.

**When a check leaves a small residue, suspect that the check and the thing it is
protecting are asking slightly different questions.** Chasing the residue with a
tolerance would have hidden that; the residue was the signal.

## An exit code of 0 on a partial round is worse than a crash

`tools/shoot6.mjs` wrote 2 of 7 frames and exited **0**. The cause is visible in
the log: the preview server stopped answering mid-round
(`net::ERR_HTTP_RESPONSE_CODE_FAILURE` on the third navigation), and the harness
treats a failed navigation as a reason to *stop the loop* rather than to fail the
run. It then went on to finalise the round, prune old rounds, and print its
normal closing lines.

Two things make this worse than an ordinary flake:

 - **The stable copies in `shots/system6/*.png` are now a mixture** of two
   bundles, because the harness copies each frame as it is written. Anything that
   reads the stable paths — which is the documented, convenient way to read them —
   gets a frame set that never existed as a single render of a single build. That
   is the cross-bundle trap arriving through the front door, with no hash
   mismatch to notice, since each individual file is internally consistent.
 - **An empty or partial round is indistinguishable from a successful one in the
   exit code**, so any automation that gates on `$?` passes. An earlier round the
   same night wrote a manifest and *zero* PNGs, also at exit 0; at the time it
   looked intermittent and unexplained, and it is the same fault.

The assertion wanted is not about image contents, which is what the existing 0x0
PNG check covers: it is `written.length === requested.length, else exit non-zero`.
Same family as the `--baseline` typo that silently skipped a gate, and Terrain's
zero-dimension capture: **the check did not fail, it failed to run, and nothing in
the exit code can tell those apart.**

### The assertion, and why throwing was not enough

It is now in `tools/archive.mjs`, at `finalise()`, which is the one place that
knows both numbers. A harness declares its contract and gets the check:

```js
const round = await openRound({ ..., expect: SHOTS });   // or round.requireAll(SHOTS)
```

Three details were forced by the failure rather than chosen:

**The manifest is written before the throw, not after.** A round that failed is
exactly the round somebody will want to open, and an assertion that fails the run
*and* removes the evidence has traded a silent failure for a louder one. The
round directory, the manifest — now carrying `requested`, `written`, `missing`,
`complete` and `shortfall` — and the prune all happen first. `stable.json` marks
that round's stable copies `"incomplete"`, so the mixture of two bundles at the
well-known path is at least labelled.

**A harness that already knows it failed is exempt from the throw — and must not
be exempt from the exit code.** `finalise({ failed })`, or the `outcome:
"failed"` convention `shoot1` and `shoot6` already used, records the shortfall
without throwing. Otherwise a run that died on `page.goto` would report "round
incomplete" instead of the navigation error that caused it, and the assertion
would be actively hiding the diagnosis. **The throw fires only when a harness
believes it succeeded** — the only case where it tells anyone something they did
not know.

The first version of this got that split wrong, and the wrong version
reproduced the bug it was written to fix. A cleaner instance of the fault turned
up — **3 requested, 0 written, exit 0, with `"outcome": "failed"` already in the
manifest** — and the exemption suppressed the exit hook along with the throw, so
the harness that knew it had failed still exited 0. Four rounds on disk have that
shape (`system6` at 005529Z and 014903Z, `system1` at 013258Z, `system2` at
005145Z with `outcome` unset), and three of them record
`net::ERR_HTTP_RESPONSE_CODE_FAILURE` as the cause.

The rule that falls out is worth more than the fix: **an exemption granted for
one reason must not be applied to a different mechanism.** The exemption existed
to protect the *diagnosis*, and it was silently extended to the *exit code*,
which is the thing being repaired. When you suppress a check, suppress exactly
the part you meant to.

**And the throw alone does not work, for three of the seven harnesses.** This is
the part worth remembering. Every harness copied the same teardown: an array of
named closers, each in its own `try`/`catch`, so that one failing closer cannot
leave a Chromium alive on a shared GPU. That is correct. But `shoot1`, `shoot2`
and `shoot6` call `finalise()` *from inside that array*, so the throw is caught,
logged as `failed to close archive round`, discarded — and the run proceeds to
`process.exit(code)` with the code it already had, which on a clean-looking run
is 0.

So a check added in the obvious place would have run, produced the right answer,
printed it, and still exited 0: **a check swallowed by a `catch` written for an
unrelated purpose.** Adding a check inside a mechanism that discards checks is a
poor answer to "the check failed to run", and it would have looked fixed.

The fix is an `exit` listener, registered by `archive.mjs` the first time a round
comes up short. Node runs `exit` listeners *after* `process.exit(code)` has set
`process.exitCode`, and re-assigning it there changes what the process actually
returns:

```console
$ node -e "process.on('exit',()=>{process.exitCode=1});process.exit(0)"; echo $?
1
```

Verified on Node v22.19 before relying on it. No harness has to be edited, no
`catch` can intercept it, and the verdict is re-printed at the last possible
moment — which matters, because on the swallowing path the only earlier mention
was a line reading "failed to close archive round".

`tools/archive.exit.test.mjs` reproduces the swallowing teardown in a child
process and asserts on the exit code, because an exit code is not observable
from inside the process producing it. Its first run is itself an example of the
class: the child crashed on a Windows path import and exited 1, and **two of the
three cases passed, because they expected 1.** The case that caught it was the
extra assertion that the harness had actually swallowed something. A test whose
pass condition is also its failure condition is not a test.

### The half that could not be asserted, and is a warning instead

Six harnesses have not declared `expect` yet, and the fault happened three times
in one night, so `finalise()` also compares this round's captures against the
previous round's manifest and warns, by name, about any that have vanished. It
only ever warns: `--only=front` is a legitimate one-shot run and is
indistinguishable from a truncated one from inside `finalise()`. **Guessing is
allowed to be noisy; it is not allowed to fail somebody's deliberate subset
run.** It also requires the *count* to have dropped, because several harnesses
name captures `${shot}${SUFFIX}` and a suffix change renames every shot without
dropping one — a warning that is wrong every time somebody flips a flag is one
nobody reads.

Only two things are unconditional failures: a declared contract that was not
met, and a round that wrote **no captures at all**, which is the first fault
above and can never be legitimate.

---

## A total that equals a subset *exactly* accuses the instrument, not the code

A disposal test in `tools/perf-instrument.js` reported bytes that were never
freed. The residual was suspicious in the ordinary way — a leak is a plausible
thing to find — but it was suspicious in a second, much sharper way: it was
equal to the renderbuffer total **to the byte**.

A real leak does not do that. Leaks are fractions of things: some textures
survive, some are freed, the residual is a number with no particular
relationship to any other number in the readout. A residual that reproduces
another counter exactly means the two are *the same quantity*, which means one
of them is not measuring what its name says.

It was not. `live.rboBytes` had every appearance of a live value and no
`deleteRenderbuffer` hook, so it only ever accumulated: a high-water mark
wearing the name of a live value. Every other `live.*` counter had a matching
delete hook; this one had been missed. Render targets are created and destroyed
routinely here — the shadow reclaim path alone does it at startup — so the error
was not hypothetical, and it had been silently inflating one column for as long
as the instrument existed.

### The general form

**Exactness is evidence about mechanism.** When a discrepancy equals a subset of
itself, or equals another reported figure, the relationship is almost never
coincidence, and the cheapest hypothesis is that the two figures share a term —
usually because one is double-counted, never decremented, or is literally the
other under a different name. Check that before believing the phenomenon the
number implies.

Pumps reached the same rule the same night from a different subsystem, which is
why it is stated here once rather than twice: **a total that equals a subset
exactly is a much stronger signal than a total that is merely wrong.** A wrong
total invites tuning. An exactly-coincident total names the bug.

This is the same discipline as case 40's "several probes in this project have
lied", applied to arithmetic rather than to sampling: before acting on what a
measurement implies, check whether the *other* counters in the same readout are
consistent with that mechanism. `frees: 4` was visible the whole time during the
518 MB "leak" and was inconsistent with a leak across dozens of procedural
textures; four frees at 256 MB each is a swap. The tell was already in the data.

---

## A shell pipeline reports the exit code of its last stage, so a failed round looks clean

`node tools/shoot3.mjs | grep -E '...' | tail -5` reports **`tail`'s** exit
status, not the harness's. `tail` succeeds essentially always. So every
assertion in the harness can fire, and `$?` is still 0.

This is the same failure as the partial round above arriving through the shell
instead of through the code, and it defeats work done anywhere upstream: the
completeness assertion, the GPU check, the zero-dimension gate. All of them
report correctly, and the pipeline throws the verdict away.

It is worth stating as a rule because the habit that causes it is a good one —
harness output is long, and piping it through `grep` and `tail` is how you read
it. The fix is not to stop doing that:

```bash
# bash: the first non-zero status in the pipeline wins
set -o pipefail
node tools/shoot3.mjs | grep -E 'wrote|round' | tail -5

# or, without pipefail, check the stage you care about
node tools/shoot3.mjs | grep -E 'wrote|round' | tail -5; echo "exit ${PIPESTATUS[0]}"

# or keep the full log and read it afterwards, which also keeps the parts
# grep discarded — usually including the error
node tools/shoot3.mjs > tmp/shoot3.log 2>&1; echo "exit $?"; tail -40 tmp/shoot3.log
```

The general form: **anything that transforms a command's output also replaces
its exit status, and a filter that cannot fail reports success unconditionally.**
`grep` is the exception that hides this, since `grep` at least fails when it
matches nothing — which is why `| grep | tail` is more dangerous than `| grep`,
and why the safest habit is to keep the whole log.

---

## The unit of measurement has to match the unit of construction

partscale --relief judges named parts. The fix for a coplanar face is very often
a SECOND named part: beltline-strip gains beltline-strip-skirt, intake-divider
gains intake-divider-wall. Judged individually the face still reports 0% wall area
and the skirt reports almost nothing but wall, so **a correctly repaired assembly
reads as two defects instead of zero.**

After twelve ribbons had been repaired the tool reported 30 COPLANAR parts, of
which 5 were real. That is not a cosmetic reporting problem. It sends the next
reader to re-fix parts that are already fixed, and it buries the handful that
genuinely are not - the worst of both, because the false positives are load-
bearing evidence that the tool is broken and the true positives look identical to
them.

The tool now pairs a face with any -skirt, -wall, -vane or -band sibling and
judges the assembly. Same list, after: 4 coplanar, and every one of the four was
a real finding.

The general shape, and it is not specific to this tool: **when the fix for a
defect is to add a part, a per-part metric will report the fix as a second
instance of the defect.** Any measurement whose unit is finer than the unit the
repair operates on has this property. Check it before trusting a count that did
not fall after a round of fixes - and note that the count RISING slightly is the
signature, which reads as a regression and is the opposite.

### And the companion rule: coplanar by function is not a defect

Two of the last four were grille-backing and intake-backing - the flat dark field
behind a set of slats. Coplanarity is that part's entire job; giving it relief
would be the defect. They are now labelled BACKING rather than silently exempted,
because **a tool that hides parts by name is one rename away from passing a real
one.** Report the exemption, do not apply it invisibly.

---

## Clone order decides which blending mode a material transformation lands in

Copying Building's separated additive reflection leaf to the car glass has a trap
in it that has nothing to do with glass.

applyGrime patches a material's shader to mix its diffuse toward a dust colour and
a film colour. On a normal alpha-blended material that is dirt. On a **black-
diffuse additive** leaf it is *light*: a non-black diffuse under AdditiveBlending
makes the pane glow the colour of its own dust, brightest where it is dirtiest.

The reflection leaf is a clone of the transmission leaf, so whether it inherits
that patch is decided by one thing only - whether the clone is taken before or
after applyGrime. Both orderings compile, both run, and the wrong one produces a
pane that gets brighter as it gets dirtier, which is subtle enough to survive a
review. Building takes its clones before applying its glazing Fresnel for the
mirror-image reason.

**A material transformation written for one blending mode is not safe to inherit
into another, and clone order is the only thing that decides which side of it you
land on.** Worth checking anywhere a material is cloned and then re-blended -
decals, additive glows, and any -Blending change applied to a clone.

### 44. Content authored below the resolution of the channel storing it becomes white noise, not absence

The dirt normal map read as an evenly dappled carpet over the whole near field.
Its height buffer was measured directly: autocorrelation 0.41 at a one-texel lag
and zero by four, which is to say very nearly uncorrelated per-texel values.

The arithmetic, once looked at. `fbm`'s frequency argument is lattice cells
across the map, so a feature's size in texels is `size / freq`. At 1024 px over
a 17 m tile the clod octaves ran 6.0, 2.8, 1.3, 0.6 and 0.3 texels — **three of
five below the grid storing them** — and the gravel Worley was 2.1 texels and
near-binary after its threshold, giving it about three and a half times the
variance of the clods. The dominant term in the relief was two-texel binary
noise. The map rendered as an even fine grain because that is nearly all it
contained.

This is the mip failure (case 38) one step earlier in the pipeline, and the
earlier position is worse. A texture sampled above its design frequency returns
its mean, so the variation is merely *absent*. Content **written** above the
resolution of its buffer does not vanish politely: it aliases into per-texel
noise, which is then faithfully rendered as a uniform crust. Absence is
invisible; this is visible and looks like a deliberate material.

Three things worth carrying:

**The fix is usually to move the feature, not to scale it down.** 35 mm gravel on
a 16.6 mm-per-texel map cannot be *shaped*, only speckled — so it keeps full
weight in albedo, where aliasing reads as speckle and speckle is what gravel
looks like, and gives up its weight in height, where aliasing reads as a crust
over the entire lot. Albedo tolerates what a normal map cannot.

**Removing the loudest sub-texel term only promotes the next one.** Gravel went
first, and grass — 2.0 texels, near-binary — immediately inherited the role. It
is a sweep against a measurement, not a fix to one term.

**Capping octaves at the call site rather than inside `fbm`.** Six systems share
it, and silently changing how many octaves it returns would move everyone's
pixels at once. Any generator that computes `fbm(size, freq)` with
`size / freq < 2` has this defect; that is worth telling people, not doing to
them.

### 45. A probe's own speed parameter can be the dominant term in its result

The first run of the height-field probe used a 512 px map to halve its cost and
reported the field as very nearly pure noise. That was true of the map it
generated and false of the map that ships, because halving resolution over a
fixed 17 m tile doubles every feature's size in texels and pushes three more
octaves under the grid. **The probe's speed parameter changed the thing being
measured, in the same direction as the defect being looked for.**

It was caught only because the numbers were implausible — an r of 0.07 at one
texel for a field with 100 mm clods is not a subtle discrepancy. A milder
version would have passed, and the conclusion would have been "the octave cap
did not help" when the cap was fine and the probe was wrong.

Anything sampling-limited must be measured at the resolution it runs at.
Resolution, tile size, mesh spacing, timestep, texture size: if a probe sets one
of these differently from production, it is measuring a different system, and
downsampling for speed is the most natural way to do it by accident.

### 46. Slope conserved across a wavelength change is not appearance conserved

Removing the sub-texel terms halved the height field's mean local slope, because
two-texel binary noise carries enormous slope for its size — precisely why it
had dominated. Restoring the budget by raising the normal-map strength 1.4 → 2.5
was defensible arithmetic and looked, in the frame, like a golf ball.

The same mean slope carried at 100 mm instead of 33 mm is not the same
appearance, because each feature is now individually resolved. **The eye reads a
fine texture at a given slope as roughness and a coarse one as holes.** Slope is
the right invariant for asking whether relief will be *lit* (case 33); it is not
an invariant for what the relief will look like. Conserving it across an order of
magnitude in wavelength conserves nothing anyone can see.

The general habit: when a change moves a feature's wavelength, the amplitude that
looked right before is evidence about the old wavelength only. Re-judge it, and
expect the answer to be smaller than the arithmetic suggests.

### 47. A baked normal map is structurally narrow-band and cannot be widened by adding octaves

`heightToNormal` is a fixed one-texel Sobel and its input is clamped to 0..1, so
the slope it reports for a feature goes as amplitude over wavelength with the
amplitude bounded above by one. **The longest wavelength in a baked normal map
is therefore always its weakest, and no number of added octaves changes that.**
A 0.55 m term carries about a fifth of the slope of a 0.1 m one at equal
amplitude, so adding it produces one more feature that does nothing — case 34,
arrived at from the other direction.

Which means the equal-slope-per-octave rule (case 41) is achievable in a
geometric height field and *not achievable* in a clamped baked one. The same
authoring rule has a different answer depending on whether the clamp exists,
which is not obvious from either side.

What does widen it: **modulating the amplitude of the fine relief by a long
wavelength.** A 0.1 m carrier under a 1.6 m envelope puts energy at the sum and
difference of the two, so the perceived spectrum broadens without requiring any
long-wavelength slope. Physically it is also the right model — soil is patchy in
roughness, packed in places and broken in others — and reusing the fields that
already drive the colour variation ties relief to albedo, which is how ground
actually works: the patches that look different are the patches that are
different.

One honest footnote. The modulation tripled the measured spread of local grain
while the noise floor was present (0.012 → 0.039) and then made almost no
difference once the sub-texel terms were removed (0.036 → 0.038), because the
resolvable field already varies naturally. **It was largely compensating for the
defect rather than adding to the result** — worth knowing before reaching for it
first next time.

---

## 43. A private build directory is not private if a sibling empties its parent — and the symptom is an opaque network error

Two capture variants died tonight on:

```
page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:5125/?shot=system4&gpu=1&smap=2048
```

That reads like a server fault or a page fault. It is neither. The build output
directory had been **deleted between the build and the navigation**.

Every agent here builds into its own `.shot-build/<system>/` precisely so that a
sibling's concurrent build cannot make a capture stale. That convention has a
hole in it: an agent that builds into `.shot-build/` **itself** rather than a
subdirectory, with vite's `emptyOutDir: true`, empties the whole directory and
takes every other agent's subdirectory with it. The evidence at the time was a
top-level `assets/` and `index.html` timestamped inside my round's window,
sitting next to `canopy/`, `pumps/` and `winding/` that had all been rebuilt in
the following four minutes — siblings recovering from the same wipe without
necessarily knowing why.

### Why this is worth a case rather than a bug fix

The failure mode is **maximally misleading in the direction of retrying.** A
network-shaped error invites "the server was slow, run it again", and running it
again often works, because by then the sibling's build has finished and yours
rebuilds into the hole. So the defect is intermittent, unattributable, and
self-healing on retry — the exact profile that consumes a night without ever
being diagnosed. I lost one variant to it an hour before I understood it, and
attributed that one to a page error.

### The guard, and where it has to go

`tools/shoot4.mjs` now checks `OUT_DIR/index.html` exists **immediately before
every `page.goto`**, not once after the build. That placement is the whole point:
the wipe can land mid-round, so a single post-build check passes and a later pose
still fails. The thrown message names the likely cause and says explicitly not
to retry.

This is the general rule from case 30 turned on the harness itself: **a control
must prove it was applied, and the harness is a control.** Everything downstream
of the build silently assumes the build is still there. One `existsSync` per
pose converts an opaque intermittent network error into a named, attributable,
actionable one.

### Generalisation worth remembering

**`emptyOutDir: true` is a destructive operation scoped to a directory you did
not necessarily choose carefully.** Any build, cache, or artefact directory
shared between concurrent processes has this shape: the isolation is only as good
as the *shallowest* writer's discipline, and one writer at the parent level
defeats every sibling's correct behaviour. If you must share a parent, make the
parent unwritable to builds and require a subdirectory.

### The writer, found later: an empty argument removes a path level

It happened again — `.shot-build/` still holds the orphaned root-level
`index.html` and `assets/`, and it cost a third agent two rounds. The mechanism
is in `tools/shoot.mjs`, and it needs no misuse and no unusual invocation:

```js
const SYSTEM = arg("system", "system1");
const BUILD_DIR = `.shot-build/${SYSTEM}`;
// ... await build({ build: { outDir: BUILD_DIR, emptyOutDir: true } })
```

`arg()` returns whatever followed the `=`. So `--system=` — a shell variable
that expanded to nothing, a command pasted with the value trimmed — makes
`SYSTEM` the empty string and `BUILD_DIR` the shared root `.shot-build/`, and
the build deletes every sibling's bundle. Confirmed by evaluating the two lines
in isolation rather than by running it.

Nothing here is a mistake in the ordinary sense. The fallback is right:
`arg("system", "system1")` supplies a default for a **missing** flag, and
`--system=` is not missing — it is present and empty. The bug is entirely in the
join, where **an empty string interpolated into a path silently removes a
level** instead of erroring. `path.join("a", "")` is `"a"`, and `` `a/${""}` ``
is `"a/"`; both are valid paths to somewhere you did not mean.

That is the same shape as the three 65-byte 0×0 PNGs in the repo root, written
to paths named `640`, `560` and `100`: **an argument that is empty or mis-parsed
becomes a path, and the path is acted on without being checked.** One of those
two shapes deleted six directories; the other created files a critic could have
been shown. Neither announced itself.

So the rule is not "be careful with defaults", it is **assert the destination
before performing a destructive operation on it**, because the destination is
the last point at which a mis-parsed argument is still cheap to catch.
`tools/scratch.mjs` exports `assertPrivateBuildDir(root, outDir, tag)`, which
refuses the repo root, anything outside the repo, and any bare shared root
(`.shot-build`, `dist`, `shots`, `tmp`, `tools`, `src`, `.work`). It is one line
before each `emptyOutDir` build and it now guards `shoot.mjs`, `perf.mjs`,
`stress.mjs`, `bloom-cost.mjs`, `shadow-type-ab.mjs` and `texture-audit.mjs`:

```js
assertPrivateBuildDir(ROOT, BUILD_DIR, "shoot");
await build({ root: ROOT, build: { outDir: BUILD_DIR, emptyOutDir: true } });
```

`node tools/shoot.mjs --system=` now exits 1 with a named cause instead of
deleting six directories. Ad-hoc scratch belongs in `tmp/<name>/` —
`scratchDir(ROOT, name)` — which is gitignored and which nothing else reads.

## 44. Run the detector on the case whose answer you already know, and when it disagrees, explain the difference before believing either

Four instruments in one night produced confident results their own construction
guaranteed. The fifth was a horizon detector that reported "BAND BRIGHTER THAN
SKY" on `sunlit` and `pines`. Before acting, it was run on `wide`, whose answer
was independently known to be ~0% after the `holdUnderSky` bound landed.

It read 0.0%. That is a pass, and the temptation is to stop there and believe the
other frames. The useful work was in the *difference*: `wide` skipped 0 columns,
`sunlit` skipped 631. A metric that passes its control and disagrees elsewhere is
either finding a real difference or being fed different content, and the skip
count said the second. Three refinements followed, each of which changed the
answer:

1. **Restrict to the horizon.** The first version accepted the first big luma
   drop anywhere in a 180-row window, so in a low-eye pose it latched onto
   near-field poles and shrubs. Keeping only columns whose skyline sits within
   15 rows of the frame's modal skyline is the fix.
2. **Require a persistent occluder.** The drop was defined against a fixed
   reference 60 rows higher and the comparison was against sky 6 rows above the
   drop. So a *one-row* dark feature — an antialiased edge, a wire, a needle —
   makes "the rows below are brighter than the rows above" true **by
   construction**. `sunlit` fell from 418 qualifying columns to 58 and its median
   excess from 41.8 to 1.3 luma. The entire finding was a thin-line trap.
3. **Ask who painted the pixel.** With both fixes, `pines` still read 25%. Two
   controls (`vforce=noline`, then `+noscrub`) moved it by 0.2 percentage points,
   so it was neither the distant band nor the far scrub. Classifying the
   offending pixels by colour gave rgb 115,115,133 — blue-dominant and
   desaturated, i.e. *sky*. The vertical profile at one flagged column ran
   115 → 25 → 121 → 42 → 162: those are gaps between pine branches. A dappled
   crown makes every column oscillate, and every dark minimum followed by a
   brighter run flags.

**The whole family of findings was an artefact of dappled crowns**, which is why
the pose named for pines flagged hardest and the pose looking down from 12.5 m
flagged zero. Retracted in full.

The general point, and it is not a threshold problem: **a pixel metric cannot
answer a question about a band without knowing which mesh painted the pixel.**
No further threshold repairs this detector; it needs ownership information, the
kind an ID render gives. This is the same wall that made pixel evidence
unusable for the `sweepTube` winding bug — see the case on consistency checks
certifying a bug. Two separate investigations reached the same limit from
opposite directions, which is what a real limit looks like.

Cross-reference: the single-lag case, the missing-null-model case, and the
control-group case are the other four instruments. The recipe that catches all
five is the same: **a null model, a control with a known answer, and an
explanation of any difference between them.**


## 45. A percentile is a statistic of somebody else's sampling domain

Terrain published `groundAccum` with units, p50, p95, a shape word, and whether
zero means no effect — measured on a 1 m grid over the lot, n=11,468. Exemplary,
and still not directly usable, because **my geometry is not a sample of that
grid.** Plant sites are chosen by planting rules that prefer sheltered ground,
so they are a biased subset by construction.

Measured at the 228 real plant sites, against a matched 1 m grid over the same
bounding box:

| field | published p50 | at my sites | matched grid | ratio |
|---|---|---|---|---|
| shelter | 0.026 | 0.115 | 0.021 | **4.42x** |
| swept | 0.004 | 0.012 | 0.004 | **3.02x** |
| fines | 0.147 | 0.122 | 0.147 | 0.83x |

**The matched grid is the part that makes this a finding rather than a
discrepancy.** It reproduces the published p50 for four of the five fields, which
proves the 4.42x is selection bias in *where my geometry is* and not error in
*how I sampled*. Without that arm the same two numbers would have been an
accusation against Terrain's contract.

So a consumer scattering debris off the published median would have
under-scattered under crowns by 4.4x — in the one place a debris skirt is
supposed to be heaviest.

Two further traps the contract itself defused, both worth restating because they
are shape-of-the-quantity errors rather than value errors:

- `litter` is **items per square metre**, not a probability. Terrain's note says
  treating it as a probability at a 0.2 m cell scatters 25x too much. A needle
  and leaf skirt works at exactly that cell size.
- `shelter` and `swept` are **bimodal**: at my sites 49%/16% and 61%/20% of
  samples sit in the outer tenth at each end. They are masks wanting soft edges,
  not ramps. Used as a gradient they deliver a hard cut with a fringe, which is
  the defect they look like rather than the defect they are.

**Publish the shape and the units, not just the range — and probe the range at
your own geometry before composing.** A number can be correct, well documented,
and still wrong where you stand.


## 46. The same word in two tools is two different findings

Seven far scrub meshes were carried in the handover as DEGENERATE, alongside a
separate occlusion report on `veg-scrub-grazed-far-0`, with a note that they
might be one cause. They were one cause. It was not the one being looked for.

`DEGENERATE` in the winding audit means a triangle with no area or with vertex
normals that cancel. `DEGENERATE` in `probe-unseen` means a mesh that rendered
zero pixels in an isolation render and that forcing side, depth and frustum could
not recover. **The finding came from the second tool and was investigated against
the first**, which cost a CPU probe over all 42 clump geometries. That probe came
back perfectly clean: zero no-area, zero null-normal, zero reversed, both LODs,
minimum triangle area 1.1e-2 against a 1e-12 threshold.

Reading the real scan output corrected two things at once. There were **eleven**,
not seven — and three of them were **near** meshes, which refutes the far-LOD
hypothesis the count had suggested. The shared cause is in the instrument: the
isolation render frames the mesh's bounding sphere, and for an `InstancedMesh`
scattered over a 100 m annulus that sphere describes the *scatter*, not the
plant. Every clump lands sub-pixel, alphaTest discards it, and nothing about
side, depth or frustum brings it back — which is exactly the verdict reported.
The three meshes that did recover came back at 2 px and 13 px, confirming it.

Two lessons, and the second is the one that generalises:

- **Check which tool emitted the finding before choosing the tool to test it
  with.** The shared vocabulary made two instruments look like one.
- **A probe that aims at a bounding volume cannot isolate a scattered instanced
  mesh.** Aim at one instance. This affects every system that scatters
  instances, so it is a shared-tool fix rather than a Vegetation one.

## A swept profile that doubles back reverses one triangle of every quad, and `computeVertexNormals` will certify it

The scene-wide per-triangle winding detector named the car as the largest owner
of reversed geometry: **8 meshes, 5,828 reversed triangles, 3,965 of them being
culled.** All four tyres reported an *identical* 960 of 8,160 at an identical
agreement of 0.918, which is the signature that matters — one wrong loop
reproduced four times, not four accidents of geometry.

Localising it took one CPU script and no render. `buildTyre` sweeps a
cross-section profile of 18 points around 240 angular steps and emits index in
one uniform order, so a reversal cannot be sporadic: it has to belong to
particular segments of the profile. Counting reversed triangles per segment
`vertex_index % 18` gave `c = 3, 4, 13, 14` — 240 each, exactly 50% of each
segment, symmetric across the two sidewalls. 4 segments x 240 quads x 1 triangle
= 960.

**50% of a segment, meaning exactly one triangle of every quad, is the fingerprint
of a folded quad.** A quad whose four corners no longer lie on a single-valued
surface splits into one triangle facing out and one facing in, whatever order
the index is written in.

The cause was in the profile radii:

```
0.2105, 0.2305, 0.2665, 0.3005, 0.2762, 0.3055, 0.3255
                        ^^^^^^  ^^^^^^ a 24 mm dip
```

The cross-section crossed itself, so sweeping it folded the surface.

### The actual cause is two parameterisations in one ordered sequence

The two offending points were written in different units:

```ts
addProf(sign * half * 1.085, rimR + 0.092);              // absolute offset from the rim
addProf(sign * half * 1.05,  rimR * 0.45 + radius * 0.55); // proportional rim-to-tread
```

Both lines are individually reasonable. Neither can be checked against the other
by eye, because they are not in the same units. At `rimR` 0.2085 and `radius`
0.3315 the absolute term overtakes the proportional one and the profile crosses.
**Nothing anywhere asserted that the sequence stayed ordered**, and that is the
defect — the numbers are just this instance.

The fix is the assertion, which throws on a non-monotonic sidewall. The numbers
were then rewritten so all seven points are absolute offsets from one origin,
which makes them comparable by eye. Note the maximum width term `half * 1.085`
was left alone, so the track and the arch clearance did not move; only the height
at which the maximum occurs did. That matters because of the earlier coupled-
parameter finding: tyre width, track and arch opening are one decision.

### Why this survived every existing check, and why it will survive yours

**`computeVertexNormals()` derives normals from the winding, so it certifies
whatever it is given.** Calling it converts a winding bug into a shading bug and
destroys the evidence in the same statement. Every geometry in this project ends
with that call.

And the check that *looked* like it covered this did not. `partscale --winding`
compares a part's area-weighted mean normal against an outward radial, which is
well defined for a strip and **undefined for a closed solid — the area-weighted
mean normal of a cube is zero.** So every mean-normal method certifies every
solid. It reported the car clean while 5,828 reversed triangles sat in it. A tool
reporting clean was consistent with the defect rather than contradicting it,
which is the worst possible relationship between a tool and a bug.

The detector that works compares **each triangle's geometric normal against the
mean of its own shading normals.** No region, no camera, no render, exact by
construction. `tools/carwind.mjs` is the car's copy.

## An offset larger than the local concave radius of curvature turns the surface inside out

The second half of the car's reversed geometry was a different mechanism with the
same symptom, and the remedy is the opposite one.

The inner skin and the headlining are parallel offsets of the outer body, inset
32 mm and 55 mm along the vertex normals, keeping the body's winding — which is
correct, because a parallel offset faces the same way as its source. But the body
has hard creases by design, and **at a crease the concave radius is near zero, so
a 32 mm inset locally inverts.** That produced 3,229 reversed triangles of 52,036
in the inner skin and 320 of 11,350 in the headlining.

**So flipping the winding would have been exactly wrong: 94% of those triangles
were right.** The defect is per-triangle and so is the remedy. The guard uses the
detector's own test at build time — compare the offset triangle's geometric
normal against the source surface normal it was built from — and drops the ones
that fold. A folded triangle is not a degraded surface that a fallback can stand
in for; it is a surface that does not exist, sitting inside the bodyshell where
nothing can see it. Dropping it costs triangles rather than adding them: 3,229 →
17 and 320 → 0, with 6,484 fewer triangles.

The test cannot be `computeVertexNormals` on the result, for the reason above: it
would derive normals from the fold and certify it.

### The trap in reusing an orientation check across two surfaces from one source

The headlining is the roof offset downward and deliberately turned to face into
the cabin, so "correct" for it is the **opposite** of the roof's outward normal.
The guard needed a sign parameter. Testing it against the inner skin's convention
would have rejected all 11,350 of its triangles — a guard that deletes the part it
was added to protect. Two surfaces built from one source with different intents
need two contracts, and the shared builder cannot infer which is which.

## `DoubleSide` does not fix reversed winding, it hides it, and the reveal looks like a free change

Four of the eight car meshes were reversed and **latent**: drawn `DoubleSide`, so
nothing was culled and nothing looked wrong. They surface the moment anyone sets
`side` correctly for a performance pass — which is a change that looks free, is
correct in itself, and would have been blamed for the breakage it merely revealed.

Any winding tool must therefore report latent counts separately and must not let
them be dismissed as "not currently visible". `tools/carwind.mjs` prints them
under their own total with that warning attached.

## `metalness` between 0 and 1 is a category error, not a tuning choice

`metalness` is the **mixing weight between two mutually exclusive BRDFs** — the
dielectric one, with a coloured diffuse term and a white specular at F0 0.04, and
the metallic one, with no diffuse term at all and its specular colour taken from
the base colour. Every value strictly between 0 and 1 asks the renderer to
average two physical models that cannot both apply. It describes a material that
does not exist.

The car had seven. The expensive one was `0.36` on the paint, which was **deleting
a third of the paint's diffuse immediately after the albedo had been certified
correct by grey card.** A correct albedo behind an intermediate metalness is a
correct number with a third of it thrown away downstream, and it is the hardest
kind of error to find because both halves look right in isolation.

Removing it lifted the flank 1.41x in pixels, against a predicted 1/(1-0.36) =
1.56x for pure diffuse recovery — the shortfall being the specular no longer
tinted by the base colour, which is the other half of what metalness does.

Two details worth carrying:

- **The source comment had already reasoned its way to the right answer and left
  the wrong value.** It said an alloy wheel "is painted and clearcoated, not
  polished" directly above `metalness: 0.72`. Prose and value disagreed and only
  the value ran.
- **A material's name can carry the error.** `darkMetal` at 0.6 was a lamp
  housing, which is moulded plastic. The name asserted a material class and
  nothing checked it against the part.
- **Resolving does not always mean resolving to 0.** A brake disc is bare ferrous
  metal, so `0.85` resolved up to 1.0. The rule is that the two ends are the only
  honest values, not that everything is a dielectric.
- **0.15 is the most seductive form of it** — small enough to read as a nudge,
  and it still deletes 15% of the diffuse from a part whose entire appearance is
  diffuse.

`envMapIntensity` is the same shape with one physical value. It multiplies the
environment radiance a surface returns, so 1.0 is the only value that is not a
compensation: above it a surface returns more than it receives, below it the
energy goes nowhere, and how much a dielectric actually reflects is already
encoded by F0 and roughness. This file had already retired every value above 1.0
on exactly that ground; the values *below* 1.0 are the same defect and are still
outstanding.


## "Proud" is measured from a reference surface, and the obvious reference is often not the one the viewer sees

A stain, decal, badge or patch offset from the wrong surface is not slightly
wrong, it is invisible, and the source reads as correct at the call site because
the offset is positive and small.

The pump cabinet's base splash was placed at `cabD / 2 + 0.0009`, i.e. 0.9 mm
proud of the cabinet box. But the cabinet's visible skin is not the box — it is a
set of lapped panel plates standing `PROUD + row * LAP` outboard of it, 5 mm at
the bottom row and 17 mm at the top. So the splash sat **4.1 mm behind the plate
it was staining**, and every one of the 150 vertices was occluded by the surface
it was supposed to be on. Nothing at the call site hints at this: `half` is in
scope, it is the obvious thing to offset from, and `+ 0.0009` looks like exactly
the epsilon such an offset needs.

The fastener weeps in the same mesh and same material were visible, because they
offset from the bolt's own base rather than from the box. **One mesh, two
offsets, one of them right** — so the mesh was not wholly absent from the frame,
which is worse than if it had been, because the residue looked like a weak effect
rather than a buried one.

Two things found it, in this order:

- **A visibility A/B on the mesh, not on its parameters.** A flag that skips
  building the mesh entirely, then a whole-frame diff. `changed=0.0%, max=2` on
  one pose and `0.1%, max=9` on another says the pass contributes nothing, with
  no theory required about why. Diffing *parameter* changes cannot do this: a
  buried mesh is equally buried at every alpha.
- **Then the vertex data, before any theorising.** Composed strength was healthy
  (alpha to 0.976, mean 0.247 over 840 vertices), which eliminated the whole
  family of "the field is too weak" explanations that would otherwise have
  absorbed a round. Printing the distinct Z planes the mesh occupies, next to the
  distinct Z planes the parent occupies and the Y range of each, made the
  occlusion arithmetic unavoidable.

The general form: **when a surface detail cannot be seen, measure where it is
before measuring how strong it is.** Strength is the more interesting hypothesis
and the less likely one, and chasing it produces exactly the outcome this project
has hit most often — a defect removed by making its replacement invisible, which
is the same screenshot as doing nothing.

Corollary for the range-composition lesson: probing that a field reaches useful
values at your geometry is necessary and not sufficient. The field was right, the
composition was right, the alpha was right, and the result was zero pixels.

## A duplicate key in an object literal is not an error, and the winner is the one written last

The film harness's route planner reported that the entire station was
unwalkable. Its flood fill returned **one cell** — the cell the camera was
standing on — from a scene with a 90 x 50 m forecourt and a shop the walk probe
had been walking around all night.

Every direct check said the opposite. `free()` at the origin returned `true`.
`free()` half a metre north returned `true`. `free()` inside a wall correctly
returned `false`. The grid pitch printed as `0.125`, the origin printed as
`(0.30, 27.50)`, and both coordinates were finite. Lifting the flood-fill loop
out into a standalone script with a synthetic room gave **4909 cells** and a
correct three-leg route around a wall. The logic was right and the environment
was right, and together they produced one cell.

The planner's page-side object had grown a `cellId`-style helper:

```js
const D = {
  key: (i, j) => (i + 4096) * 65536 + (j + 4096),   // grid cell id
  ...
  key(type, code) { window.dispatchEvent(new KeyboardEvent(type, { code })); },
  ...
};
```

Two properties named `key`. JavaScript does not object: in a non-strict object
literal the later definition simply replaces the earlier one. So every grid cell
was being "hashed" by the *keydown dispatcher*, which takes two arguments,
returns `undefined` for all of them, and has a side effect. The first cell was
stored under `undefined`; every neighbour then hit `dist.has(undefined)`, which
was `true`; the frontier discarded all eight; and the search terminated having
visited nothing. It also fired eight synthetic keyboard events per cell
expansion, which nothing noticed because the events had `type: 2` and
`code: 220`.

### Why every check missed it

The failure is invisible to exactly the checks a person reaches for, because
each component *is* correct:

- Unit-testing the algorithm passes — the algorithm is fine.
- Instrumenting the inputs passes — the inputs are fine.
- Printing the function source passes — the source is the source you wrote.
- A NaN guard, added on the reasonable theory that `Map.has(NaN)` is `true` and
  would produce precisely this one-cell signature, fires never. The theory was
  the right *shape* — a value that is its own duplicate — and the wrong value.

What finds it is enumerating the object's property names and counting them,
which took one line and should have been the second thing tried rather than the
tenth:

```js
const names = [...src.matchAll(/^    (\w+)\s*[:(]/gm)].map((m) => m[1]);
// duplicates: [ [ 'key', 2 ] ]
```

### The generalisation

**A name collision is the one class of bug where reading the code that is wrong
tells you nothing, because the code that is wrong is correct.** Both definitions
of `key` were individually sensible and locally readable. Nothing at either site
hints that the other exists, and the site that loses does not fail — it is never
called at all. This is worse than shadowing in a scope, which tooling warns
about, and worse than an override in a class, which is at least visible as an
override.

Two practical consequences for this codebase:

1. The harnesses accumulate helpers on one big page-side object (`__FILM`,
   `__INTERACT`, `__GAME`) precisely because it is convenient to reach them from
   `page.evaluate`. That convenience is a namespace with no collision
   detection. When adding to one, list its members first.
2. `key`, `state`, `find`, `path`, `dist`, `log`, `pos` and `free` are all
   generic enough to be reinvented. Three of those are already on `__FILM`.
   Prefer a name that says what domain it belongs to: `cellId`, not `key`.

### The other half of the round: a filename is not the only unchecked assertion

This sits next to the earlier case about `inside-shop.png` not being inside the
shop. Both are assertions nothing verifies, and they fail in opposite
directions: the filename claimed something false about a real frame, while the
duplicate key made a real function claim to be something it was not. The common
element is that **identity in this project is asserted by naming and checked
nowhere**, whether the name is a file on disk or a property on an object.

## A probe that has to be somewhere will be somewhere wrong, and audio has a listener position too

The film's rendered soundtrack was checked by measuring broadband RMS and peak in
quarter-second windows. It came back as a smooth ramp from 0.055 to 0.085 with no
transients anywhere, which reads unambiguously as *the continuous beds are
rendering and the discrete events are not* — no bell, no pump ticks. Since the
whole offline-audio path was new that night, the natural next move was to
establish whether the events were failing to fire or failing to render, so a
minimal probe booted the scene, armed audio, called `doorOpen`, `pumpStart`,
`fridgeOpen` and `bottleGrab` at known times, rendered twelve seconds and
compared peak at the events against peak away from them.

It printed `median peak away from events: 0.2548`, `median peak at events:
0.2699`, and `FAIL — one-shots are not in the render`.

Both measurements were wrong, in two different ways, and the audio was correct
the whole time.

**The probe put the microphone in the wrong place.** `AudioSystem` attaches a
`THREE.AudioListener` to the camera and routes every source through its own
panner with inverse-distance attenuation — its own comment says "distance
attenuation is the panner's job, not the voice's". The bell hangs over the door
leaf; the ticks come from the pump bay. The probe never moved the camera, so it
called the triggers and then measured from wherever the player spawns, tens of
metres away. It was not asking whether the bell rendered. It was asking whether
the bell is audible from across the forecourt, and correctly answering no.

**The broadband window was the one measurement guaranteed to hide the answer.**
The beds it was competing against are a distant highway wash and a compressor
hum: broad, low, and loud. The events are a narrow bright ring and a click. Split
the same file into three bands and the picture inverts —

```
low  <200 Hz  (highway)     median hop peak 0.07838   transients >4x: 0
mid  200-1500 (hum/room)    median hop peak 0.08185   transients >4x: 0
high >2500 Hz (bell/tick)   median hop peak 0.00364   transients >4x: 2
    9.66s  50.4x   <= door click at 9.533s
    9.90s   6.6x   <= the second ring
```

The bell is **fifty times** the high band's own floor, 130 ms after the door
click, with a second strike 240 ms later. It was never missing. It was 1.4% of
the broadband peak, which is roughly what a small bell is next to a highway, and
a quarter-second window that takes a maximum cannot see it at all.

The pump ticks show up as a different shape and are worth reading, because they
are the case a spike detector also misses: the high band sits at 0.0055–0.0065
for the whole 1.5 s the camera stands at the pump, against a film-wide median of
0.0036, and then **collapses to 0.0027 the moment the walk to the door begins**.
A train of small ticks is a raised floor, not a transient, and the collapse at
the moment the listener leaves is the positional attenuation being confirmed for
free.

### The generalisations

1. **A probe must state where it is measuring from, and audio has a position just
   as much as a camera does.** Every visual harness in this project names its
   pose; the audio one had no notion of pose at all, and its answer depended
   entirely on an implicit one. This is the same defect as the frame named
   `inside-shop.png` that was taken outside the shop — a measurement whose
   location is a silent assumption — arriving in a domain where nobody thinks to
   look for it because there is no picture to notice it in.
2. **A detector's window and band have to be chosen against the thing being
   looked for, not against the signal as a whole.** Broadband peak over 250 ms is
   a reasonable default and it is the wrong instrument for a 40 ms ring buried
   under a wash 70x its amplitude. Ask what the target looks like in time and in
   frequency first; here, one band split turned a flat `FAIL` into a 50x
   detection with no change to the thing being measured.
3. **A steady stream and a single event need different tests.** The ticks would
   have failed the same >4x-median spike test the bell passed, while being
   plainly present. "Is there a transient here" and "did the floor move here" are
   two questions, and a stream of small events only answers the second.
4. This is the fourth instrument tonight that confidently measured the wrong
   thing — after the collision probe that performed the resolution it was
   testing, the capture that named a pose it was not at, and the threshold rate
   computed against the sampler's interval rather than the simulation's. The
   pattern across all four is that **the instrument was more likely to be wrong
   than the system**, and in all four cases the system was in fact right. When a
   new measurement disagrees with a working system, suspect the measurement
   first — it is younger, it has been run fewer times, and nobody has ever
   looked at its output before.

## Every harness here measured a warm load, and I deduced the exact opposite from the same mechanism

Perf found that the scene's **first** load takes 279.1 s, or crashes the tab,
against a steady 21.7-25.4 s on repeats — **12.0x**, reproduced across four
independent sequences. The gap is not the interesting part. The interesting part
is that this project had been measuring load time all night and could not have
observed it, and that when I worked out why, I got the sign backwards.

Every harness in `tools/` opens its page the same way:

```js
const browser = await chromium.launch(launchOptions());
const context = await browser.newContext();   // <- deliberately incognito
```

I reasoned: `newContext()` is a fresh throwaway profile, so every load these
harnesses ever timed was **cold**, and the warm case was inexpressible. The
mechanism I cited was the **GPU program cache**, the store where Chrome keeps
shaders already compiled to driver binaries.

That mechanism was the right one and it refutes my conclusion. **The GPU program
cache lives at the browser-process and GPU-process level, not the context level.**
`newContext()` clears cookies and the HTTP cache; it does not clear compiled
shaders. So contexts 2..N in a process inherit a warm one. And `stress.mjs` opens
a throwaway page purely to assert the GPU *before* the page it measures:

```js
const gpuPage = await context.newPage();
await gpuPage.goto(base, ...);            // <- loads the whole app
await assertHardwareGpu(gpuPage, ...);
await gpuPage.close();                     // measured load is now the SECOND
```

So it is not that every measurement was cold. **Every measurement was warm** —
either the harness pre-warmed itself, or it was timing a repeat.

### The datum that settled it was already in my own report

A steady 21-25 s across repeats **cannot happen if every load is cold**, because
cold loads are the 279 s ones. I quoted both numbers in the same paragraph as the
claim they contradict. The tiebreaker required no new measurement, no new tool and
no privileged information: only reading the two figures I had already written down
as though they had to be consistent with each other.

That is the part worth remembering. I had a mechanism I could argue for
persuasively, and an arithmetic check sitting in the adjacent sentence, and I
shipped the argument. **A mechanism explains why a number could be what it is; it
cannot establish what the number is.** When the two are in tension the number
wins, and the check is usually cheaper than the argument was.

### The general form survives, and is strengthened

**An experiment that holds a variable fixed cannot discover that the variable
matters, and test isolation is exactly such a variable held fixed.** The suite did
hold it fixed. It held it at *warm*, which is worse than holding it at cold,
because the user's experience is the cold path — so the number the whole suite
converged on stably, repeatably, and correctly was the one number no user will
ever see.

Anything that depends on state accumulated across sessions — shader caches, HTTP
caches, driver caches, warmed JITs, OS file caches — is invisible to a suite built
this way, and invisible in the manner hardest to notice: not as a failure, but as
a result that is stable, repeatable, and answering a slightly different question
than the one asked. Note also that Perf's own harness had "first load" perfectly
confounded with "the attempt that allocates a second WebGL2 context", and removing
the confound made the effect *larger*, 3-10x to 12x. A confound can hide an effect
as easily as manufacture one.

Two practical notes:

1. Asking the question needs `launchPersistentContext(dir, ...)` and a directory
   that outlives the browser **process**, not merely the context. A profile that
   dies with the process cannot tell you whether anything survives a restart —
   which is the only form of the question the user cares about.
2. When a measurement's spread is much larger than its precision, suspect a
   hidden condition before averaging it away. A 12x range is not noise around a
   mean; it is two populations.

## Ask what physical quantity your constant stands in for, and whether that quantity is a fraction of something

*Second instance of the rule stated earlier in this file, in a second system, and
it adds two things that case did not have: the **control** that stops the rule
being applied everywhere, and the distinction between the term that is coupled and
the term that must stay constant.*

`contactShadow.ts` baked a peak alpha of 0.78 with a comment saying it stood in
for lost ambient and was deliberately not multiplied by the lighting. The comment
was right that it must not be lit twice and wrong about what followed from that.

The decal is an unlit black quad under normal alpha blending, so it resolves to
`background * (1 - alpha)`: **it darkens the total of sun plus ambient, while the
quantity it stands in for is occluded ambient alone.** Those two agree only at a
fixed ambient share. Lighting then moved `scene.environmentIntensity` 1.0 -> 2.4
and the sun 5.6 -> 4.4 in one change, so the ambient share moved from a small
fraction of the frame to a large one, and the decal did not move at all. It was
authored against the old share and silently mismeasured the new one.

This is Canopy's soffit bug in a second system, found by enumerating the tree for
the class rather than by anyone noticing the decal looked wrong.

### The rule, and the control that keeps it from being applied everywhere

**Ask what physical quantity your constant stands in for.** Then ask whether that
quantity is a fraction *of* something the scene owns.

The control matters as much as the rule: **a lamp emissive is correctly constant,
because a lamp does not dim when the sky brightens.** An occlusion term is not,
because occlusion is a fraction of incident light and something else sets that.
Without the control this rule couples everything to the environment, which is a
second bug wearing the first one's clothes.

### What is coupled and what is not, because getting this backwards is symmetric

The geometric occlusion fraction — how much of the hemisphere a 10 mm gap hides —
is **environment-independent** and stays a constant. The *level the decal is drawn
at* is not, and that is the derived value:

```
level = occlusion * scene.environmentIntensity / STRENGTH_ENV_REFERENCE
```

Coupling the geometric term itself would have been the same error in the opposite
direction. Two constants that look alike sit either side of the line, and the
question that separates them is which one is a fraction of a scene quantity.

### Publish the borrowing, because a comment is invisible to everything downstream

The failure was not the number. It was that a scene-wide quantity was being
consumed through a baked constant and disclosed only in prose, so **nothing
downstream could tell that Lighting moving the environment had invalidated it.**
The fix therefore publishes both the borrowed value and the level derived from it,
on the caller's own report.

Two supporting decisions:

- **`environmentIntensity` is a required parameter with no default.** A default
  would let the two systems now adopting this file inherit a hidden borrowing,
  which is the exact defect the parameter exists to remove — and it would look
  like it was working. Callers must pass the live `scene.environmentIntensity`
  rather than a copy of Lighting's current default, because a copy goes stale the
  next time that default moves and nothing says so.
- **The clamp is reported, not just applied.** At environment 2.4 the raw
  derivation exceeds 1, so it saturates at 0.94. A clamp that binds silently turns
  a first-order approximation into a constant again, which is where this started,
  so the report prints the raw value and a `clamped` flag beside the drawn one.

The timing is the general lesson about shared code: this constant was about to be
reproduced in three systems, because a file is copied at the moment it becomes
useful and not at the moment it becomes correct.

## 54. A probe that aims at a bounding volume cannot see a mesh whose copies live in a transform it ignores

`probe-unseen` renders each mesh alone from its own viewpoint and reports the ones
that draw no pixels. It framed `o.geometry.boundingSphere` transformed by
`o.matrixWorld`, and for an `InstancedMesh` that is the sphere of ONE copy at the
geometry's local origin, because every per-instance transform lives in
`instanceMatrix` and was never applied. The camera was pointed at half a metre of
empty ground near the group origin. Nothing was in frame, so forcing `side`,
`depthTest` and `frustumCulled` recovered nothing, and the verdict printed was
DEGENERATE — "nothing forced brings it back" — which is a true statement about
the probe and a false one about the mesh.

Fourteen of 42 scrub meshes were silent. After aiming at up to six real
instances, each with its own view direction: **42 of 42 draw pixels, 0 draw
none**, with the tool's own determinism control passing at 0 differing pixels and
no winding failures.

Three things worth keeping:

- **It masqueraded as an LOD bug.** Instances scattered near the local origin
  landed in frame and read SEEN; ones 70-200 m out never did. That correlates
  with distance without being about distance, so it survived for a while as "the
  far variants are broken", and the count of affected meshes was miscopied as
  seven far ones when it was eleven including three near ones. **A hypothesis
  that explains the correlation is not the same as one that explains the
  mechanism.**
- **The "recovered" pixel counts were the tell.** Three meshes came back at 2 px
  and 13 px. That is not a recovery, it is an instance clipping the corner of
  frame by luck, and a recovery measured in single pixels should be read as
  evidence about the instrument rather than about the mesh.
- **Each instance needs its own aim direction.** Sharing one mean-normal
  direction across instances aims at the back of any rotated copy and reports
  WINDING. A false WINDING is strictly worse than the false DEGENERATE it
  replaces, because WINDING is the verdict the tool documents as never
  defensible and the one that fails the run.

The general form: **an isolation render is only isolating the thing you think it
is if it consumes every transform the renderer consumes.** Car and Building both
use this tool as a regression gate, so the fix is announced in the file header
with the date and the re-run instruction rather than only in a handover.


## 55. Two systems scattering into one surface need one of them to publish coverage

Terrain raises near-field debris density from the geometry side; Vegetation drops
needle and leaf duff under crowns. Same ground, independent rules — and both
rules keyed off the same `shelter` field.

That correlation is the whole problem. Two independent scatters average out; two
scatters driven by the same input **both go heavy in the same places**, so the
result is double coverage under every crown and bare ground everywhere neither
rule fires. The clumping becomes systematic rather than random, which is worse
than either system alone and looks like a bug in whichever one is examined
second.

The fix is not a shared constant or a negotiated split. It is for one side to
publish what it actually covered, as a **function** rather than a list of
numbers, for the reason Terrain gave when publishing `pavementEdge`: there is
then nothing for two systems to disagree about, and the answer describes the
geometry rather than a model of it. `vegetationDebris.coverAt(x, z)` reads the
same post-cull disc set that was handed to the mesh builder, with the same radial
falloff the discs fade their alpha by, so "covered" means what a viewer sees.

Two details that make such a service usable rather than merely present:

- **Publish the drawn set, not the authored set.** Mats past the ~70 m cull are
  excluded, because a consumer subtracting for geometry that was never drawn
  leaves a hole exactly where nothing existed.
- **Echo the distribution into the report.** A published function backed by an
  empty list reads identically to a working one until somebody renders the
  difference. `debrisCover` reports 929 discs and p50 0.373 at the plant sites,
  which is checkable from a capture.


## 49. Backtick-quoting an identifier in a comment is a syntax error inside page-injected source

Half of `probe-unseen.mjs` is one template literal, installed into the browser
page as a string. Documenting the instanced-aim fix in the house style — backticks
around `instanceMatrix` and friends — terminated the literal, and Node reported
`SyntaxError: Unexpected identifier 'o'` pointing at a line that was plainly a
comment.

The trap is that the convention is correct everywhere else in the same file,
including its header, which is outside the literal. So the fix is not "stop using
backticks" but knowing which region you are in, and `node --check` is a
one-second gate that catches it before a five-minute build does.

**Case 41 is this same bug in GLSL**, found by another author in a shader
template literal. Two independent hits on one mechanism, in two languages, in
one project, is the signal that the hazard belongs to *page-injected and
shader source as a category* rather than to either file. Anywhere source is
carried inside a template literal, the house comment style is a syntax error
waiting for the next person to document something.


## 50. A scatter has a count, an extent and a protrusion, and only the last one is what the eye receives

Near-field gravel was invisible. It got fixed three times, and the first two were
the wrong quantity.

**Count.** 1500 stones went to 9000. Nothing appeared. The old distribution had
put a third of its candidates over 145 x 105 m of open ground, which is 0.03
stones per square metre: a whole square metre of ground in front of the eye held
a stone three per cent of the time. Raising the count was the right direction.

**Extent.** The near arm was then a disc of radius 52 m about the site centre,
scoped to "what the camera can reach". That was wrong, because one of the eight
poses stands 75 m west of the site centre, so its entire foreground fell outside
the disc. **The reachable region is defined by where the cameras are, not by
where the buildings are**, and it is easy to substitute the second for the first
without noticing. Widening the disc to 88 m fixed the coverage and *divided the
density by three*, cancelling the count increase that was the whole point. A
scatter has a count and an extent, only their ratio is visible, and raising both
is a change that measures as progress and renders as nothing. The number worth
computing is clumps per square metre of near view, which for a walking camera is
about 30 m2 of ground.

**Protrusion.** The stones were sunk by 0.42 of their radius, with a flattened
vertical scale of 0.45 to 0.8 radii, so they stood 0.03 to 0.38 radii proud — a
median of 4 mm on a 20 mm stone, which at a metre and a half from the eye is two
pixels. Every stone was present, correctly placed, correctly lit, and buried. The
only ones that read were the largest few per cent, which produces exactly the
sparse-sprinkle look the density work was meant to remove, so the symptom after
the fix looked like the symptom before it.

The general form: for anything scattered, the visible quantity is not how many
there are or how far they spread but **how much of each one is above the surface
it sits on**. That is the term nobody parameterises deliberately, because it
usually arrives as a burial fudge factor chosen once to stop things floating.


## 51. A mesh is a chord across its own height field, so placing on the field buries things in the near field and not in the far

The stones had one more reason to be invisible, and it is a general trap for
anything placed on generated terrain.

A mesh samples the height function at its vertices and renders straight lines
between them. Wherever the function is concave, the rendered surface sits
**above** the function, so an object placed at the function's own value is below
the ground that is drawn. Measured on this ground at 0.65 m vertex spacing:
chord error 6.7 mm at p90 and 23.6 mm at p99 in the near field, against 1.1 mm at
p90 in the far field.

The near/far asymmetry is the part that misleads. This height field gates its
shortest-wavelength term off beyond 62 m for Nyquist reasons, so the far field is
smooth and the chord is nearly exact, while the near field carries content the
mesh cannot follow. Gravel therefore vanished close to the camera and read
perfectly far from it, **which looks exactly like a distance cull** and sent the
investigation after culling, LOD and density before the real cause.

The fix is to publish the rendered surface rather than add a margin at each call
site. A margin has to be sized at the p99 or it fails somewhere, and a 24 mm lift
on a 20 mm stone is a floating stone. An exact sampler is a dozen lines: find the
cell, pick the same triangle the index buffer made, interpolate that plane.

This is the third instance tonight of one shape — a feature authored against one
description of a surface and rendered from another. Entrance ruts authored against
`dirtY` while the mesh was built from `groundHeight` was the first. **The places
two descriptions disagree most are the interesting places, because that is where
the blend, the gate or the tessellation is doing work.**


## 52. An instrument dominated by the signal it is not measuring returns a confident null

A tool reported "no periodic peak, this is a random field" on a rendered ground
crop that visibly contained a regular hatch. It was not broken and it was not
lying: autocorrelation is dominated by variance, the crop's variance was almost
all in the broad shading gradient across it, and the faint fine pattern
contributed a fraction of a per cent. The correct answer about the dominant
signal was reported as an answer about the fine one.

Subtracting a running box mean — everything coarser than the window goes, the
detail stays — turned the same crop and the same tool from "no peak" into a
periodic peak whose screen period scaled with depth, i.e. a fixed world-space
period, i.e. a real lattice. The tool already detrended per row with a linear
fit, which is why the gap was not obvious; a straight ramp is not a curved
gradient, and every lit ground plane has the second one.

The general rule for any correlation, ratio or contrast measurement: **state which
band the answer is about, and high-pass or band-pass to that band before
measuring.** A null from an instrument whose variance budget is spent elsewhere is
not evidence of absence. It cost a round here, and the same shape had already
appeared tonight as a mip-collapsed texture whose variation was measured at nadir
and consumed at grazing incidence.

## A per-triangle winding detector finds the perimeter of a reversed region, not its interior

This is a ceiling on the best winding instrument anyone here has, and it means
**every count it prints is a lower bound.**

The detector compares a triangle's geometric normal against the mean of its own
shading normals. Those shading normals came from `computeVertexNormals`, which
derives them from the winding. So inside a **contiguous** reversed region the
shading normals are reversed too, they agree with the geometry, and the region
reports clean. Only where reversed geometry meets correctly wound geometry do the
two disagree.

Measured, on one car: the nose and tail cap fans had **4,540 and 1,344**
consistently reversed triangles, all culled against a `FrontSide` material. The
detector reported **125** - the boundary between the reversed band and the
bodywork around it. **A factor of 47.**

So a small non-zero count is not a small defect. It is a perimeter, and the region
behind it has to be measured another way: by orienting against a direction the
builder actually knows and reporting how many triangles the correction had to move.
The scene-wide audit total is a floor, not a total.

## An unwritten star-shapedness contract, and why this one could not be an assertion

`makeCap` builds a nose or tail as concentric rings scaled about a centroid, so
quad orientation comes out as radial x tangential. That is consistent only while
the ring is **star-shaped about that centroid** - while the polar angle about it
increases monotonically as the index advances.

A car's nose section is not. The shoulder overhangs the bonnet line, so y falls
while x falls and the ring doubles back in the plane the fan radiates in: 16 edges
at the front and 18 at the rear, mirrored. And **no choice of centroid fixes it** -
checked at three - because the ring doubles back rather than being off-centre.

**The important part is that the shape is not the bug.** A nose whose highest
point is the shoulder rather than the centreline is a correct car. Compare
`buildTyre`, where a self-crossing profile was a mistake and an assertion that
throws is the right fix. Same geometric failure, opposite remedy, and the thing
that decides which is whether the violating shape is wanted:

- **Violation is a mistake** -> assert and throw. The builder should refuse.
- **Violation is the design** -> the builder absorbs it, and reports how much it
  had to absorb so the count can be watched for change.

Getting this backwards either ships a fold or refuses to build a correct car.

The absorbing fix is the same one this system has now needed three times - in
`flankStrip`, in the inset skins, and here: **a builder that derives orientation
from something the caller controls should instead measure orientation against a
direction the builder itself knows.** A cap knows its own axis.

## Name the geometry that occludes, or go to 1.0

`envMapIntensity` has one physically correct value. It multiplies the environment
radiance a surface returns, so above 1.0 a surface returns more than it receives
and below it energy vanishes.

But there is exactly one legitimate reason to sit below it, and it is a missing
physical term rather than a taste adjustment: `scene.environment` is a single PMREM
sampled with **no occlusion at all**, so a surface sealed inside a bodyshell or a
housing receives the full outdoor sky in the shader. A reduced value stands in for
**occlusion of the environment**. The honest fix is an AO map; a number is the
crude version.

That makes the test cheap and mechanical: **name the geometry that does the
occluding in the comment, or set it to 1.0.** A value that cannot name its
enclosure is a compensation wearing an occlusion costume. Applied to one file it
swept two of eight - a wheel face and exterior trim, both of which look straight
at the sky.

### The control, and why it points the other way here

This reaches the **opposite** conclusion to the contact-shadow decal from the same
question, and the difference is worth holding onto because both constants look
alike:

- The decal's alpha was a fraction **of a total the environment sets**, so it had
  to be coupled to `scene.environmentIntensity`.
- An occluded fraction **of the sky** is dimensionless, so it is correctly constant
  when the sky brightens.

Ask what the constant is a fraction *of*. That is the question that separates them,
and answering it wrong couples something that should be fixed or freezes something
that should move.

## 47. The measurement that refuted its own author, twice in one night

Two claims of mine were routed as work by the coordinator on the strength of
plausibility alone, and both were wrong in the same direction: **a real mechanism,
correctly described, whose magnitude was never measured.**

### The claim and the number

I reported that program count had gone 70 → 144 and wrote that "144 programs is a
long shader-compile stall on first frame — which is part of your 26.3 s init, and
init is where the browser died." Every clause is a true statement about how
WebGL works. The coordinator, reasonably, made it the highest-value remaining
performance work.

Measured: shader compilation is **8.3% of init**. System `init()` is 22.4 s of a
25.2 s load, and **`terrain` alone is 14.27 s of it, 63.6%** — 7.6 times the
whole scene's shader compilation. The thing I named as the init cost was the
eighth-largest contributor to it.

### Why the wrong answer was so stable

Because the count really did double, and a doubling invites you to skip the
question of what it doubled *from*. 70 programs was already not the problem, so
144 was twice not-the-problem. **A ratio that changes dramatically says nothing
about whether the quantity matters**; only the absolute cost does, and I had
never taken it.

### How to time shader compilation, since the obvious way returns zero

`compileShader` and `linkProgram` are asynchronous in every modern driver. They
queue work and return: timing them measured **3 ms** across 192 programs, which
is how a real cost hides in plain sight. The stall lands wherever something first
*asks for the result* — `getProgramParameter(LINK_STATUS)`,
`getShaderParameter`, an info log — because those force a synchronous wait.
Timing those gives 1873 ms.

Check `KHR_parallel_shader_compile` before trusting that figure. If three is
polling `COMPLETION_STATUS_KHR` the wait lands in frames that draw nothing and
the blocking measure *under*-reports. Here the extension is present but
`renderer.capabilities.parallelShaderCompile` is unset, and a 77 ms worst-case
block is only consistent with three blocking.

### Two facts about ordering that a duration cannot give you

- **First link at 0.2 s, last at 25.1 s of a 25.2 s init.** Compilation is
  interleaved with generation, system by system. There is no first-frame compile
  cliff — the specific thing I had asserted. An *ordering* claim survives an
  arbitrarily noisy host, which a duration does not.
- The blocked-time ratio held at **6.5 – 8.3% across four runs** while init
  itself moved 20% and the program count moved 13%. On a host where every
  wall-clock number is untrustworthy, a ratio measured from GL call durations is
  still worth publishing.

### The control that did not apply, and why it was still reported

Reloading the same URL in the same browser should warm the driver's shader cache
and bound the compile share from above. Init did not improve — 25.7 s against
25.2 s. Read carelessly that is a second, independent confirmation that
compilation is cheap.

It is not, and `blockedMs` says why: **1968 ms against 1873 ms, unchanged.** The
shader cache never warmed, so the control did not apply, so it is evidence about
nothing. **A control that agrees with you is exactly the one you must check
applied**, because a disagreeing control gets investigated automatically and an
agreeing one gets quoted.

### Pricing turns a warning into a decision

I had warned Lighting that an `OutputPass` "recompiles all ~144 materials, which
lands in init, and init is where the browser died". True, and useless: it named
a mechanism and implied a magnitude it never measured, which is enough to block a
decision indefinitely. Priced, a full recompile is **+1.9 s on a 25 s init**, and
smaller than init's own run-to-run variance. **A warning without a number is not
a finding, it is a veto.**

---

## 48. Two mocks, one author, four hours apart

A detector that runs `onBeforeCompile` against a mock shader and hashes the
result can answer two opposite questions: whether materials *sharing* a cache key
generate different source (a correctness bug), and whether materials with
*different* keys generate identical source (a waste bug).

The second detector's first version reported **51 materials with 21 distinct keys
as one shader, and 91 materials as another — including a material with no hook at
all.** Both were artefacts. The mock contained `#include <common>` and nothing
else, so every hook targeting one of the other fourteen chunk tokens used in this
codebase found nothing, no-op'd, and returned byte-identical output. **The mock
manufactured the finding it was built to detect.**

The part worth keeping: **the correct mock already existed**, with 25 chunk
tokens, in a sibling tool written by me the same night. The mechanism had been
solved and was then reimplemented from scratch instead of shared. A second copy
of a subtle mechanism does not inherit the first copy's lessons — it starts from
whatever the author remembers, which is less than what the first copy knows.

Two rules fell out:

- **Grep the codebase for what the mock has to contain**, rather than writing
  down what seems representative. Here: every `#include <...>` token any hook
  replaces.
- **A test must separate what it can establish from what it cannot.** Families
  whose members all use three's default cache key — the hook's own source text —
  are now printed as *unestablished* rather than as savings, because identical
  output against a mock may only mean the mock lacks the replace target. Two such
  families remain and neither is claimed.

The verified result, after both fixes, is **6 wasted programs out of 183, worth
~56 ms of a 25 s init** — and the recommendation is to leave them alone, because
merging cache keys asserts that two materials will generate identical source
across all future edits, and the only evidence for that is a mock. 56 ms is not
worth a permanent correctness risk. **"Real, measured, and not worth acting on"
is a complete answer.**

## A single-channel texture used as an `alphaMap` multiplies alpha by zero

`MeshStandardMaterial`'s alpha map chunk is, verbatim in three 0.185:

    diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;

It samples **green**. Sampling an `R8` texture yields `(r, 0, 0, 1)`, so a
`THREE.RedFormat` `DataTexture` used as an `alphaMap` sets alpha to zero
everywhere. It compiles, it binds, it costs texture memory, it passes any check
that inspects the data you wrote, and it renders nothing. `grayTexture` in
`src/gen/textures.ts` already wrote all four channels for terrain's alpha map —
the precedent existed and was not followed.

The generalisation is the useful part: **a map slot has a channel convention, and
the convention is not always the channel you named.** `alphaMap` reads green,
`aoMap` reads red, `metalnessMap` reads blue and `roughnessMap` reads green, so
three of those cannot be fed a red-only texture. Check the chunk, not the
material property name.

### Three independent reasons to be invisible look exactly like one weak effect

The same stain had all of these at once:

1. offset 0.9 mm proud of the cabinet *box* while the visible skin is lapped
   plates 5 mm further out, so it was behind the panel it stained;
2. a `RedFormat` alpha map, so its alpha was multiplied by zero;
3. **all 672 triangles wound facing inward**, so every one was front-face culled.

Any one of them alone produces zero pixels. Together they produce *the same* zero
pixels, which is why four successive fixes each measured as "still nothing" and
each looked like the previous diagnosis having been wrong. **A null result has no
shape**, so it cannot tell you how many causes it has, and the temptation after
each fix is to conclude the last hypothesis was mistaken and back it out.

What breaks the loop is refusing to re-measure the same way. Each cause was found
by a *different* kind of question — where is the geometry, what does the shader
read, which way does the triangle face — and none of them by another A/B.

### The winding check that works, and the one that certifies anything

`computeVertexNormals()` derives normals from winding, so the normals always
agree with the winding, however wrong it is. On this mesh: 672 triangles, 672
agreeing with their stored normal, 0 disagreeing — a perfect score that carries no
information. "The normals point the right way" was true and meaningless.

The check with content is the cross product of the triangle's own two edges,
dotted against the direction that surface is *supposed* to face, which has to come
from the model rather than from the geometry. Here it is "away from the cabinet
centre line at this point", and it read 0 outward, 672 inward.

### A mask's job is to vary a quantity, not to reduce it

Beneath all three bugs there was also a quiet fourth problem. The stain's opacity
was `vertexAlpha * maskGreen`, where the vertex alpha carried a carefully composed
and range-checked `groundAccum` profile with a mean of 0.247, and the mask — hand
written in this file, never probed — had a mean of 0.40 and a peak of 0.80. The
product was an effective mean opacity of **0.091**. The field's range was audited;
the range of the author's own multiplier was not.

Put the physical magnitude in one place, cap it there, and let every other factor
be normalised so its peak reaches 1. Otherwise each factor looks reasonable on its
own line and the product is a tenth of the intent.

---

## 44. Four ways an instrument can run perfectly and never reach the screen, found in one afternoon in one 180-line file

Building a shadow-map viewer took **five rounds**, and every single failure was
the instrument breaking rather than the subject misbehaving. None of them threw.
Collected because the shapes recur far beyond this file, and because the pattern
across them is one idea: **an instrument's own report proves the code ran, which
is not the claim anyone cares about.**

### 1. `camera.add(mesh)` silently does not render

`WebGLRenderer.render` traverses the **scene** graph. A child of a camera that
was never itself added to the scene is not drawn. No error, no warning, and the
frame looks completely normal — which is the problem, because a debug overlay
that fails to draw leaves you looking at the subject and believing it is the
instrument. Add overlays to the scene.

### 2. `needsUpdate = true` on a render-target texture can wipe it

Setting it asks three to re-upload from `texture.image`, which does not exist for
a render-target attachment. I set it while clearing `compareFunction`, and got a
uniformly black depth read. **The instrument destroyed the data it was built to
inspect,** and a uniformly black map is a plausible-looking answer.

### 3. `glslVersion: GLSL3` does not give a ShaderMaterial `gl_FragColor`

The compiler says `'gl_FragColor' : undeclared identifier` followed by three type
errors that are all consequences of the first, so it reads like four problems.
Declare your own `layout(location = 0) out vec4`.

### 4. Transparent materials paint over an opaque overlay whatever its renderOrder

Three renders the whole transparent group after the whole opaque group;
`renderOrder` only sorts **within** a group. So an opaque overlay at renderOrder
9999 is still covered by every transparent material in the scene. This one is
the most dangerous of the four, because the overlay *mostly* worked: it was
correct across the sky and the treeline, and wrong exactly over the car — the
region under investigation. Set `transparent: true` on the overlay so it joins
the later group.

### The control is what caught it, and only because it covered the hard part

The shader draws the map twice: left half at comparison reference 0.0, which
**must** be saturated by construction since every possible depth passes, and
right half at the reference being tested. Failure 4 was invisible in the
measurement half — a slightly-wrong magenta is still magenta — but the control
half read 216 of 255 green over the car while reading exactly 255 everywhere
else. A control placed only where the frame is easy would have passed and the
round would have produced a confident wrong answer about the car.

**Corollary worth generalising: put the control where the measurement is hardest,
not where it is convenient.** And in a false-colour debug view, use a channel
that cannot be produced by the thing you are looking for, so contamination is
visible as a hue shift rather than a value shift.

### And one self-inflicted repeat

Round three died on a build error because I put backticks in a GLSL comment
inside a template literal — **case 41, which I wrote up myself a few hours
earlier after Pumps hit it.** Reading a trap is not the same as having internalised
it. The comment in the shader now says so.

## A mesh is a chord across its own height field, so anything drawing a contact line needs the rendered surface

Terrain found this and it lands hardest on the contact decal, which is why it is
recorded here too rather than only in Terrain's notes.

`groundHeight` is the analytic field. The ground **mesh** is a triangulation of it,
and a triangle is a chord across the curve it samples, so the rendered surface sits
BELOW the field almost everywhere: **6.7 mm at p90 and 23.6 mm at p99 in the near
field**, where the short-wavelength churn term is enabled, against 1.1 mm far away
where Nyquist gates it off.

For a contact decal that is not cosmetic, it is the whole function: the decal
exists to draw the line where the object meets the ground, and being buried by up
to 24 mm removes exactly that. **And it fails only close to the camera**, which
presents as a distance cull or an LOD bug rather than as a placement error — so the
symptom points away from the cause.

### A margin cannot fix a chord error

Worth stating because a margin is the reflex: the margin has to be sized at the
p99, and lifting everything 24 mm to cover a 24 mm worst case floats it by 23 mm in
the median. The exact per-triangle surface is the only answer, which is why the fix
belongs in a published surface accessor rather than in a pad at each call site.
This was the third instance of the shape in one night.

### Discover the service by key pattern when the name has not settled

The consuming side has its own trap. The surface was computed but not yet published
under a settled name, and hard-coding a guessed key gives the worst available
outcome: a lookup that returns undefined forever, silently reverting to the buried
field **while looking wired up**.

So match the key by pattern over `serviceKeys()` — the same "pick up a family of
services" approach `core/collision.ts` uses for `*.blockers` — and then make the
match legible: require the value to be a function, probe it for a finite result,
and **publish the key that matched** in the report alongside a flag for whether an
exact surface was found at all. A fallback nobody can see is the defect, not the
fallback.

## Decal quality can be non-monotone in resolution, because the real condition is alignment

Canopy measured contact-decal quality against `res` and got **0.96 at 16, 0.73 at
20, 0.70 at 24, 0.95 at 32.** Not monotone — so the natural response to a soft
decal, raising the resolution, makes it worse about half the time.

The mechanism: the occlusion peak sits exactly at the occluder's footprint edge and
decays over a reach length. Alpha is evaluated at **vertices** and interpolated
across each cell, so whether the core reads at full strength depends on whether a
grid line happens to land near that edge. **It is an alignment condition wearing a
resolution condition's clothes**, and alignment is not monotone in `res`, which is
why the numbers look random.

Aligning the grid to the edges is not available as a fix, because several occluders
with different edges cannot all align to one grid. So remove the sensitivity
instead: require the cell to be small enough that the peak is captured wherever it
falls,

```
cell <= min(reach) / CELLS_PER_REACH        (4 in practice)
```

at which point alignment stops mattering and quality *is* monotone in `res`.

Two things about the shape of that fix generalise:

- **Treat the caller's resolution as a floor, never a ceiling.** A number too
  coarse to describe the feature is not a performance trade-off, it is a wrong
  answer. Raise it and report that you did.
- **Publish the derived quantity, not just the requested one.** `cellsPerReach` is
  the number that actually predicts quality; `res` is the one people tune. Report
  both, or the next adopter tunes the wrong one — which is what the non-monotone
  table is a picture of.

## A rewrite script that prints success without checking the replacement took

Small, mine, and the same family as four other instruments whose result was fixed
by their own construction.

A `String.replace` with a pattern that does not match returns the original string
and reports nothing. A script that then prints "report extended" has certified
work it did not do. It was caught only because the field was missing from a capture
two steps later; nothing in the script itself would ever have said so.

**A rewrite must verify its own effect, in the same run, and fail loudly.** Count
the occurrences afterwards, compare against what was expected, and exit non-zero on
a mismatch. Printing an unconditional success message is worse than printing
nothing, because it converts an obvious absence into a false positive.

## 49. A gap that does not move is evidence about its nature, not its owner

The texture audit reports GL-live bytes against bytes reachable by scene-graph
traversal, and the difference has been 110 MB for two rounds. It is still not
attributed, and it should not be. But it acquired one new property worth
recording: **110 MB against a 607 MB scene-graph total, then 110.01 MB against
638.76 MB.** The scene grew about 32 MB and the gap did not change at all.

That is worth more than it looks. An unexplained residual has two very different
shapes:

- **Proportional** — the traversal systematically misses a fraction of what it
  walks, in which case the gap grows with the scene and the fix is in the
  traversal.
- **Constant** — a fixed set of allocations exists that traversal cannot reach
  at all, in which case the traversal is fine and the gap is a real, separate
  thing.

Measuring the same gap against two different scene sizes distinguishes them, for
free, with no new instrument. Here it is constant, so the traversal is not the
problem.

**And that still is not an attribution.** Fixed-size candidates are easy to name
— a 1920×1080 default framebuffer with MSAA attachments is the right order of
magnitude — and naming one because it fits the magnitude is exactly the failure
that cost a retraction earlier tonight. The honest report is: constant, therefore
fixed-size, therefore not a traversal defect, owner unknown. **A table covering
85% with the remainder named beats one covering 100% by guessing**, and the way
to make the unknown 15% more useful is to establish properties of it rather than
candidates for it.

---

## 50. Read the units before believing your own fix regressed

A texture audit showed a live `8192×8192` shadow colour attachment at 64 MB, on a
scene where that attachment was supposed to have been dealt with. First reading:
the fix has regressed.

It had not. The audit line said **`Red/u8`**, not RGBA8, and that is the whole
answer — `reclaimShadowColourAttachments` converts the attachment from RGBA8 to
R8, which takes 256 MB to 64 MB. The 64 MB *is* the fix working. The saving
reported as 192 MB is exactly the 3/4 removed.

The near-miss is the useful part. The instinct on seeing a number you thought you
had removed is to go and re-verify the code, which costs a run and finds nothing.
The cheaper move is to check whether the number is the *same* number: 64 is not
256, and a quarter of the original with a changed format in the same line is a
converted resource, not a resurrected one. **A magnitude that is a clean fraction
of what you expected, with a changed unit next to it, is your own change looking
back at you.**

This is the same instrument-reading discipline as the `rboBytes` case, which also
turned on a total that was suspiciously *exactly* something: there, a residual
equalling a subset accused the instrument; here, a residual equalling a quarter
exonerated the code. In both, the arithmetic relationship between the numbers was
the evidence, not the numbers themselves.

---

## 51. Setting `side` correctly is not a free performance win

Backface culling looks like the purest kind of cost reduction: fewer triangles
rasterised, no visual change, one property per material. It is not, and the
reason is that `THREE.DoubleSide` **conceals reversed geometry**.

Four car meshes in this project had inverted winding, invisible for as long as
they were double-sided. A performance pass setting `side` to `FrontSide` would
have made them disappear or turn inside out — and the regression would have been
attributed to the performance pass, which did not cause it.

So the expectation to set before starting: **a `side` pass is a geometry audit
that happens to save triangles.** Budget for finding defects, not for banking a
saving, and land the winding fixes and the `side` change together so neither is
blamed for the other. A change that uncovers a latent bug is indistinguishable,
from the outside, from a change that introduced one — which is the same trap as a
fix whose first effect is to make a previously silent failure loud.

## 52. "Can the player get there" is a threshold on a continuous quantity, and a flood fill reports it with an error equal to its grid pitch

Two interactions in this project — open the cooler, take the bottle — could not be
reached on foot. The performance agent found it by flooding the collision field
at a 0.4 m pitch across a sweep of body radii and reporting the crossing: the
back of the store was unreachable at the player's 0.32 m and reachable at 0.30 m,
so "one aisle roughly 40 mm too narrow".

Re-measured, the tightest gate on the best route was **0.40 m of clearance**,
which a 0.32 m body passes with 80 mm to spare. Both measurements were right, and
the disagreement is the useful part:

- A flood fill tests whether a **cell centre** is free. A corridor 0.80 m wide
  admits a 0.32 m body through a 0.16 m window, and whether a centre lands inside
  that window depends on the grid phase. So the answer moves with the pitch, in
  both directions: a real gap can be missed and a real path can be broken.
- The *reported* quantity was a yes/no, and a yes/no cannot express margin. "It
  opens at 0.30" reads as "widen by 40 mm", when the honest statement was "the
  only route through this store requires threading a 160 mm window twice".

The pitch-independent form of the question is a **widest path**: build a
clearance field (distance from each cell to the nearest blocker), then search for
the route whose narrowest point is widest. That is a max-min shortest path — a
Dijkstra with `min` for path cost and a max-heap — and it returns one number per
target, the tightest gap on the best route. The radius sweep then falls out for
free, because reachable at radius *r* is exactly bottleneck > *r*, and so does
the diagnosis, because walking the parent pointers back to the cell that set the
bottleneck names the two rectangles that form the gate.

`tools/probe-reach.mjs` does this and is shared tooling; it reads every
`*.blockers` service from the live registry, so it cannot disagree with the game
about what is solid, and its targets come from the registry rather than being
typed in.

Two traps inside it, both of which produced a confident wrong answer first:

1. **Reach without occlusion is a distance, not an interaction.** The first
   version accepted any walkable cell within 2.2 m of the target and every target
   passed with half a metre of margin, because the widest route ran round the
   *outside* of the building and stood 2.2 m from the bottle with the back wall
   in between. A sight-line test is not a refinement here; without it the probe
   measures something else entirely.
2. **The blocker containing the target must be excluded from that test**, or a
   thing inside a cabinet is unreachable by construction. You interact with the
   contents of a cooler through the cooler's own front.

And the reason nobody found this for the whole life of the project is `NOTES`
case 35 again, in its strongest form yet: **both interactables worked perfectly
whenever a shot preset placed the camera in front of them, and neither had ever
been reached by walking.** Fixed-camera capture is structurally blind to
reachability. Every review of this scene has been fixed-camera.

## 53. Four workarounds, four plausible new defects, one probe pointed at the wrong height

After the pinch was widened, the walked confirmation drove the real controller
from the spawn to the cooler, opened the cooler door, and then reported that the
crosshair was on the **door leaf** rather than on the bottle behind it. So:

1. Wait for the leaf to finish swinging. Still the door.
2. Step back, since the leaf swings toward the player. Still the door, now at
   0.26 m — apparently pressed into the camera.
3. Sidestep clear of the hinge. Still the door.
4. Sidestep with a real 0.55 m stride instead of 0.2 m. Now *nothing*.

Each failure suggested a cause, and each cause was specific, physical and
plausible. By step two I had the arithmetic for a genuine defect ready to file: a
0.875 m door leaf swinging into a 1.09 m aisle cannot clear a 0.64 m body, so the
player must stand inside the swept arc. That is a real relationship between two
numbers I own, and it is exactly the kind of finding this project rewards.

It was not the cause. The probe aimed with
`lookAt(x, eyeHeight + 0.15, z)` — 1.80 m — at a bottle sitting **0.65 m** above
the floor. Every reading was a ray passing 1.15 m over the target and landing on
whatever cabinet was behind it. Corrected, the interaction completed on the first
attempt: walk from spawn, open the entry door, open cooler door 2, take the
bottle.

The general rule, and it is the one this file most needed:

> **When a probe reports an obstruction, the next test is not a better
> workaround. It is a positive control.**

There was no known-good case anywhere in that sequence. A probe that has never
been shown to succeed cannot distinguish "the scene is wrong" from "I am not
looking at it", and a workaround that fails tells you nothing about which. Note
also how the four attempts interacted with the existing rule that a round failing
twice the same way should have its premise questioned: this failed four times the
same way while *appearing* to fail differently each time, because each workaround
changed the number in the report. Changing numbers feel like progress. The
invariant — the crosshair never once named the target — was the signal, and it was
constant from the first attempt.

## 54. A harness can time out waiting for a condition the page satisfied a minute earlier

Four consecutive runs of a new probe died on `page.waitForFunction`, against a
page that had booted cleanly, logged no errors, and published every service the
predicate asked for. The cause is that **Playwright's `waitForFunction` polls on
`requestAnimationFrame` by default**, and a Chromium tab that nothing is driving
throttles rAF to roughly nothing — the game had rendered 2 frames in 120 seconds.
Switching to `polling: 100` did not help either; the reliable form is a plain
loop of `page.evaluate` with a `setTimeout` between attempts, which is unaffected.

The same throttle makes `window.__SCENE_READY` the wrong condition for any probe
that does not render, since it is set on the sixth rendered frame. Wait for the
thing you actually depend on. Once something inside the page asks for animation
frames, rAF resumes at full rate, so a probe that *does* need frames can drive
them itself — the throttle is not a capability limit.

Also worth knowing, since it cost two of those four runs: a sibling building into
`.shot-build/` root with `emptyOutDir: true` deletes every other agent's private
subdirectory. The symptom is a page that loads and never becomes ready, or a bare
404. `.gitignore` covers `.shot*-build/`, so a private build directory outside
`.shot-build/` is immune.

---

### A bounding box is an upper bound, and for a part seen through a slot it is a wild one

`tools/pumpscale.mjs` ranked the pumps' `shut line floor` at **870 px**, the second
largest part on the model, and that number reordered a backlog: a 0%-off-panel
surface at 870 px is a complete explanation for a critic's "seams read like drawn
outlines". The instrument was right to raise it and the priority was right to
follow it.

Measured, it is **6,729 px** — 1.8% of the bounding box. The part is a single flat
slab spanning the whole cabinet face, sitting behind lapped plates that stand
proud of it, so all but the gap-width slivers is covered. The ranking projects a
bounding box; it cannot see occlusion, and its own documentation says so.

Two rules, and the second is the useful one:

- **Take the ranking as a list of parts to ask about, not a list of areas.** For
  anything not convex and unobstructed, its number is an upper bound.
- **The measurement that closes it is a same-build A/B on the part's own
  visibility.** `?pseam=0` removes the mesh and the difference is exactly the
  pixels it owns — no region picking, no bounding boxes, and it counts only what
  survives occlusion. Prove the control applied by *naming the meshes present in
  the live scene*, so absence is checkable rather than assumed.

The same probe answered the complaint's actual wording. "Too uniformly dark" is a
claim about variance, not level, and it is directly measurable as the spread of
the part's own contribution: **p90/p10 = 7.16, cv 0.687**, with mean darkening
rising 25.6 → 65.7 down the cabinet. A drawn outline is a constant and would sit
near 1. The seam had already stopped being one when the formed returns landed;
nobody had asked the question in the form the complaint was made.

### A part below the legibility floor whose only measurable effect is an artefact

The pumps' panel lip: 120 parts and 1,440 triangles per unit in its own material,
so its own draw call. A whole round went into tuning its height, thickness,
proudness, tilt and paint.

Two instruments agreed, in different currencies:

- `pumpscale.mjs`: **54 px at largest, 20 px median over 240 parts**, at or below
  the 56 px demonstrated to read on the Car model. Tuning cannot raise a part
  above the legibility floor.
- A same-build A/B (`?plip=0`): **mean |dLuma| 0.013, 0.1% of pixels, +0.27 luma
  in its best tile** — one sixteenth of the shut-line backing's effect for three
  times its triangles.

The deciding number is the sign. Its one measurable contribution was a
*brightening* with a **73-luma peak** — which is precisely the "thin bright rods"
the critic had complained of twice. **Too small to read as a form and bright
enough to read as an artefact is the worst available combination**, and it is a
state that tuning tends to preserve, because every adjustment keeps the part.

Delete rather than tune, and name the cost so the next person can weigh it: the
joint's top edge loses its only specular cue, a job that now belongs to the
formed returns, where the tone comes from slope rather than from paint.

### An injection whose range sits inside its base value is a no-op, and they cluster

Removing a weep roughness injection (0.97 → 0.995 against a 0.97 base) was worth
generalising into a sweep of every material receiving one. Pairing each
material's authored base with the range its injection can reach found two more:
`grout` at base roughness 0.95 and one at 1.0, both receiving a grime pass that
*adds* up to 1.06 and therefore clamps immediately. Their albedo arms still work,
so this is a partly inert injection rather than a dead one — which is why it
survives review.

**Sweep by comparing authored base against reachable range, not by reading the
injection.** The injection looks correct in isolation; only the pair is wrong.

### A self-check outliving its subject reports a stale expectation as a defect

The visibility assertions check both directions: a part still present under `=0`
means the control failed, and a part absent *without* `=0` means both arms are
the same scene. That second check is what catches a silently-renamed mesh — and
it fired on all four shots of a nomination round the moment the panel lip was
deleted, because the part it named no longer existed. Correct logic, true
statement, entirely stale.

**A bidirectional control check has to come off the list with the part it
names.** The failure mode is mild but expensive: it fails a good round, and its
message argues confidently that the scene is broken.


### Case 53, addendum: it happened twice in the same round, and the rule needs rewording

The second instance was a report that `PlayerSystem`'s strafe was inverted. The
measurement was real — facing +Z, `KeyD` moved the camera in −x — and the
interpretation named the wrong cause, because the right of a viewer facing +Z
**is** −x. With X and Y fixed, right-handedness requires `right × up = −forward`;
`(−1,0,0) × (0,1,0) = (0,0,−1)` checks and `(1,0,0) × (0,1,0) = (0,0,1)` does not.

Two things generalise out of it.

**A desk derivation is not a control.** The error was produced by a derivation and
would not have been caught by a better one; both parties to the disagreement had
done the algebra. What settled it in one run was refusing to name axes at all:
**column 0 of `camera.matrixWorld` is the camera's right in world space**, so
projecting the displacement onto it answers the question with no convention
available to get wrong. Eight facing-and-key combinations, all correct. If a
quantity is defined relative to an observer, measure it in the observer's own
basis; a world-space component of an observer-relative quantity is a different
quantity that happens to share its units.

**And the existing "if a round fails twice the same way, question the premise"
rule keys on the wrong thing.** The bottle probe failed four times the same way
while *appearing* to fail differently, because every workaround changed the number
in the report — 0.57 m, then 0.26 m, then 0.56 m, then nothing — and moving
numbers feel like progress. The invariant was constant from the first attempt: the
crosshair never once named the target. Reworded:

> **Find the invariant across your failures before designing the next attempt. If
> some number changed but the thing you are actually asserting did not, you have
> not tested anything yet.**

The same test applies to the strafe report, and would have stopped it: the
assertion was "D moves the player left", and `alongCameraRight` — the quantity
that assertion is *about* — was never measured before the report went out.


## 53. An upscaled crop has a period that belongs to the image file, and it is indistinguishable from a material defect

An evidence crop showed a regular fine hatch on asphalt. It was identical with
sun shadows on and fully off, which correctly excluded shadowing, and the
conclusion drawn was "therefore it is in the material". Two agents then spent a
round on the material.

The crop was a 2x upscale. Measured directly: mean run of horizontally identical
pixels 2.09 px, against 1.01 px in an unresampled render of the same surface. An
upscale imposes a fixed screen-space period, which the peak finder reports as a
fundamental with harmonics at 2x, 3x and 4x of it — and that is exactly what the
crop produced.

Two lessons, and the second is the general one.

**Screen period versus world period.** A world-space feature's screen period
scales with depth, so measuring at several depths distinguishes the two. It only
works on narrow constant-depth bands: over a tall crop, perspective smears a
fixed world period across many screen periods and the peak vanishes. Reading
"period grows with proximity" off three bands is sound; reading it off one tall
crop is not.

**"Identical under the ablation" excludes the ablated cause and nothing else.**
Shadows on and shadows off being identical rules out shadowing. It does not
implicate the material, because it equally fails to rule out everything else the
two frames share — the pose, the camera, the tone mapping, the resolution, and
the image pipeline that produced both crops. A clean negative on one hypothesis is
not evidence for whichever hypothesis you happened to have next. The
resample-detection line now printed before any periodicity result is there so the
next person is told, rather than having to suspect.


## 54. An amplitude schedule is not portable between a height field and a colour field, and adding octaves to a normalised sum adds nothing

Two consecutive attempts to widen the band of an analytic macro-variation term
measured as exact nulls — correlation length 45 px against 45 px, identical to
three decimals — for two different reasons, both of which look like progress
while they are being made.

**Equal slope is a height rule.** Shading responds to gradient, so for a height
field halving the wavelength must roughly quarter the amplitude or the surface
turns into a golf ball. That result was hard won and is correct. Carrying it
across to a term that modulates albedo is a category error: the eye reads
albedo contrast directly, there is no gradient in it, and an equal-slope schedule
therefore makes every octave below the first invisible. **A rule earned on one
channel is not a rule about the world.**

**Adding octaves to a normalised sum moves content, it does not add content.**
The corrected equal-contrast schedule also measured null, because the standard
deviation of the sum is set by its outer scale and the outer scale had not
changed: sigma 0.209 before, 0.207 after. Five octaves instead of three, larger
per-octave amplitudes, and the same total contrast. The octave list is what an
author looks at and the total swing is what the surface shows.

There is a third failure stacked on top, which is why neither attempt was even
falsifiable. The measurement high-passed at 48 px and then reported a correlation
length of 45 px — the window, not the content — so it could not have detected the
band being changed even had the change been real. **Choose the filter window from
the feature size under test, not from the previous run**, and be suspicious when a
reported length lands on a parameter you chose.

Both attempts were reverted rather than left in. An unverified change that is
documented as unverified is still an unverified change, and this project's
dominant defect is absence that looks like a choice.

## Measure the reversed *region* topologically, and stop inferring it from a perimeter

The detector ceiling said every winding count in the project is a floor: the
per-triangle test compares a face against the mean of its own shading normals, and
`computeVertexNormals` reverses shading normals *inside* a contiguous reversed
region, so the interior certifies clean and only the boundary disagrees. 125
detected against 5,884 real on `car-body`.

That leaves the actual question - **how large is the region** - unanswerable by that
detector. `tools/windregion.mjs` answers it, and needs no normals at all:

**Two triangles sharing an edge are consistently wound iff they traverse that
shared edge in opposite directions.** That is the definition of consistent
orientation on a surface. It appeals to no normal, no centroid, no outward radial
and no camera, so it cannot be fooled by anything downstream of the winding.
Flood-filling across consistently-wound adjacencies partitions a mesh into maximal
agreeing patches, and an edge traversed the SAME way by both its triangles - a
"clash edge" - is a genuine winding discontinuity.

### The result, which refuted my own hypothesis

I had reasoned that `car-glass` (29) and `car-slots` (5) should be assumed
perimeters of regions rather than loose triangles. **Both have exactly zero clash
edges.** There is no discontinuity anywhere in either, so there is no region behind
the perimeter, because there is no perimeter. The counts are triangles whose
averaged vertex normals disagree with their own faces at a hard crease - a shading
artefact on a `DoubleSide` mesh, not a culling defect. Refuted, and worth recording
as a refutation: the ceiling finding makes small counts *suspicious*, not guilty.

### Two traps in the tool, both of which produced confident wrong answers first

**Patch count is not defect count.** Every one of these meshes reports 8 to 93
patches, because they are assemblies of disconnected pieces - separate window
panes, separate slots. Multiple patches means multiple components and nothing more.
The clash count is the discriminator, and reading patch count as damage would have
condemned every clean mesh in the car.

**Vertices must be welded first, and the tool must be able to say "void".**
Procedural geometry splits vertices for hard normals and UV seams, and split
vertices make every edge unshared, so an unwelded mesh reports one patch per
triangle and the tool reports nothing wrong with total confidence. `car-seals`
still fails this after welding - every one of its 1,792 triangles has three open
edges - so it returns VOID rather than a verdict. A tool that cannot fail is not a
measurement.

### Only declare a facing expectation where the renderer enforces one

Topological consistency is blind to one case: a disconnected patch reversed *as a
whole unit* has zero clash edges, forms one consistent patch, and has its shading
normals reversed to match - invisible to both tests while being culled entirely. So
each patch also gets an orientation check, and the mean normal is legitimate *here*
precisely because a patch is a sheet rather than a closed solid.

Which needs to know which way the surface should face, and **I got that wrong twice
in opposite directions.** Guessing "out" for everything reported 627 headliner
triangles as reversed. Declaring the headliner and inner skin "in" reported 40,277
the other way. Both were inventions: both meshes are `DoubleSide`, so neither has a
correct facing to be wrong about, and any expectation manufactures a defect in
whichever direction was chosen. **`FrontSide` is what makes an orientation
checkable, so `FrontSide` is what earns an expectation** - and this is the fourth
time in this system that a check derived orientation from an assumption the caller
actually owned.

## Per-occluder local grids: when one grid must satisfy two elements' demands, split the grid

A single decal grid has to carry the FINEST occluder's cell size across the WIDEST
occluder's extent, and those two demands belong to different elements. On the car:
a 45 mm tyre reach and a 5.2 m footprint, multiplying out to a required resolution
of 430, about **163,000 triangles for a ground decal** - comparable to the entire
bodyshell. Nothing needed that; the fine cells are wanted within centimetres of the
four contact patches, while the underbody at gap 0.155 has a 248 mm reach fully
resolved at 84.

Giving each occluder its own grid over its own footprint plus its own reach, merged
into one draw call, produced **9,800 triangles meeting the quality target in full**,
against 22,720 missing it under the capped compromise. Measured pixel difference
against the uniform grid: **55 pixels.** Same picture, 57% fewer triangles, target
met rather than missed.

**Why the pieces may safely overlap is the part that makes it work, and it is a
property of the blend rather than of the geometry.** The decal is black under normal
alpha blending, so each layer resolves to `dst * (1 - a)` and two overlapping layers
give `dst * (1 - a1) * (1 - a2)` - the *same* multiplicative composition the single
grid computed analytically in its `open` product, now performed by the blender. Not
an approximation of the old behaviour, the identical quantity. **This would be wrong
under additive blending**, where overlaps saturate to black exactly under the car
where it shows most. Anyone splitting a decal must check which blend they are in
before assuming the pieces compose.

## A fraction cannot exceed the thing it is a fraction of

The contact decal's alpha was clamped at an authored 0.94 while the geometry it
stands for occludes 0.78, so the decal was removing more light than the underbody
obstructs.

The correction comes from the derivation already written above it: the environment
scaling is a first-order approximation to **the ambient share of the light incident
at that point**, because occlusion removes sky and not sun. So
`alpha = occlusion * ambientShare` with `ambientShare <= 1`, and the ceiling is
`occlusion` - derived, not chosen.

The valuable part is what this does to the clamp's meaning. `clamped: true` used to
say "an authored ceiling bound and the term stopped tracking", which is a worry.
It now says **"the ambient share has saturated, and raising the environment further
cannot deepen contact, because the geometry only blocks so much sky"** - a statement
about the scene rather than about a constant, and a complete answer to what happens
if Lighting raises the environment. Nothing, correctly.

The general form: when a constant is a fraction of a quantity, find the bound that
quantity implies before authoring a ceiling. An aesthetic ceiling standing where a
derived bound exists will be wrong in a direction nobody checks.

---

### Measure the complaint in the currency the complaint was made in

An independent critic said the pumps' seams were "too uniformly dark". Three
rounds went into the level — darker, lighter, different paint, formed returns —
and `seamprobe` reported healthy contrast throughout, which is why nobody could
shift the note.

"Uniformly" is a claim about **spread**, and spread is directly measurable: take
the part's own contribution as a same-build A/B difference, then report the
distribution rather than the mean. **p90/p10 = 7.16, cv 0.687**, with mean
darkening rising 25.6 → 65.7 down the cabinet. A drawn outline is a constant and
would sit near 1. The complaint was already answered and the answer was invisible
because every instrument was pointed at level.

The same test then cost nothing to reuse in the opposite direction. Seams read to
me as light hairlines in the next round's frames, which is the identical
complaint in the other tone — but a ridge detector over the whole frame put them
at **p90/p10 = 8.25 with chroma +16.6 R−B**, so they are neither uniform nor
sky-lit; they are sun-catching returns of varying angle. **An eyeball reading
"uniform thin line" was wrong twice about the same geometry, in opposite
directions**, and the same three numbers settled it both times.

Pick the statistic from the words: *uniform* means variance, *dark* means mean,
*thin* means width, *graphic* means the pairing of width with contrast.

### A legibility question is mm-per-pixel arithmetic, and it must be asked at the interaction pose

Before tuning anything on a display a player is meant to read, project the
feature that carries the meaning. For 7-segment digits that is the **stroke
width**, not the digit height: a digit is read from its strokes, and a stroke
under about 1.5 px cannot survive mip selection and anisotropic filtering however
bright it is.

Two things make the answer trustworthy:

- **Stand where the game stands the player.** `PumpSystem` publishes
  `standPosition` and `displayCentre`, and `InteractionSystem` measures
  abandonment from the first — so a pose built from both is the game's own
  opinion of the stance and cannot drift away from it. A pose with typed
  coordinates is a guess about an interaction that is already specified in code.
- **Do not project a bounding box.** A length on a flat panel of known world size
  projects honestly; a box does not (see the note above).

Measured this way the pumps' digits are 80–124 px tall with 8.3–13.0 px strokes,
five times any plausible floor — which converts "the display should read better"
from a scale problem into a contrast problem before a single value is touched.
The same arithmetic also sized the canvas: 1024×512 against a 439 px panel is
1.17 canvas px per screen px, so halving it to save upload bandwidth would go
visibly soft. **A texture resolution defended by an arithmetic ratio is a
different thing from one defended by taste.**

### Whether an animated counter reads as mechanical is answerable without a browser

"Does the ticking read as mechanical or as a smooth counter" sounds like a thing
to watch, but it is a claim about **the sequence of strings the display shows**,
so it can be integrated on the CPU and inspected exactly: run the same flow
model, sample at the redraw rate, format with the same formatter.

A smooth counter advances its least significant digit by exactly one per redraw,
forever. The pumps': cents step by **{0,1,2,3,4} with mean 2.98** and never a
constant one, and gallons-hundredths step by **{0,1}, holding on 15% of
redraws**. Both are irregular, which is what a mechanical register does, and the
result is a claim with numbers behind it rather than an impression.

The same simulation prices the cost, which is what a performance owner actually
needs: 18 redraws/s × 1024×512 RGBA is **36 MB/s of texture upload while a
session runs**, bounded to the session, with one gradient object allocated per
redraw and no shader recompilation — a `CanvasTexture` re-upload does not rebuild
a program.


## 55. A gate behind a build mode none of your harnesses use is not protection

`gen/textures.ts` left a **throwing** dev-time guard with no call site, and was
explicit that it should not be counted as protection until it had one. Wiring it
is one line at the end of `Game.start()`:

    if (import.meta.env.DEV) auditSceneMapChannels(this.scene);

The trap is in the gate condition. **Every harness in this repo runs `vite build`
plus `preview`, where `import.meta.env.DEV` is `false`.** So the one line makes
the guard live for a human opening a dev server and live for nothing else: no
automated run in the project would ever execute it, and the first party to
discover whether it passes would be an agent whose dev server suddenly refuses to
start, mid-edit, with a thrown error from a file they had not touched.

That is worse than no gate, because a throwing check that has never been run is a
landmine with a comment on it. The fix is a harness that loads the scene through
a real dev server (`tools/devgate.mjs`) and fails on three separate conditions:
the gate throwing, the scene never becoming ready, **and the pass line being
absent**. The third is the one that matters — a silent pass and a gate that was
compiled out are the same observation, so the guard logs its finding count and
the harness requires that line to exist.

Generalised: **before adding a check, ask which of your automated runs will
execute it.** If the answer is none, you have not added a check, you have added a
future interruption for whoever trips it first. And the corollary for any
build-mode-gated code: `DEV`-only paths in this project are exercised by nothing
unless something is built to exercise them.

(Verified on the current tree: ready, gate ran, 0 advisory findings, 0 broken
slots. A dev-server load takes ~4 minutes against ~25 s for a built bundle, so
nobody should read a dev-mode load as an init measurement either.)

## 56. Baseline-relative sampling makes a contended card measurable, and one number tells you when it has failed

Six agents render on this card concurrently, and `nvidia-smi
--query-compute-apps=used_memory` returns **`[N/A]`** on Windows/WDDM, so card
memory cannot be attributed to a process. The absolute `used` figure is worthless
as a statement about any one scene.

What works is to stop asking for the level and ask for the **rise**: sample the
card for several seconds before launching anything, then keep sampling with each
sample tagged by the phase the harness is in. Two things come out of the
pre-launch window — the host's own level, and, more usefully, **its drift**
(peak-to-trough with nothing of yours running). The drift is the error bar. A
per-phase delta smaller than it is correctly readable as "cannot tell" instead of
being reported as a small effect.

The self-check is the part worth copying, because it caught a number in this very
table. The `browser-launch` phase reported a mean rise of +1850 MiB — plausible,
in the right direction, and contaminated: its **minimum was 4611 MiB, below the
5521 MiB baseline**. A phase cannot use less than the host used before we
existed, so that can only be a sibling releasing memory inside the window, and
the phase's delta has to be discarded rather than explained.

**A phase minimum below baseline is a contamination detector**, and it costs
nothing to compute. The general form: when you measure a delta against a
background you do not control, record enough of the background to be able to
prove a given delta is unreadable — otherwise every reading looks like a result.

Two smaller disciplines from the same table: a row whose min, mean and max are
identical is **one sample** wearing the appearance of stability, and should say
so; and the phase most worth trusting is the one you can compare *within* the
same run, because contention can inflate every phase but cannot concentrate an
effect into one of them.

## 57. A cluster that moves between laps but stays tight in time is not a place

A one-lap run put **all twelve** of its worst frames in a single phase, inside a
four-second window, at a nearly fixed position, with an unremarkable draw count —
27 of 277 frames over 100 ms where the parked control had 0 of 909. Leaving the
cooler, on the path a fridge-interaction video has to walk. It looked like a
located scene-side hitch and it had a plausible mechanism waiting for it (the
transmission render target and the interior lights transition there).

The recurrence test killed it. Over 34,918 frames and several laps, that phase
was no longer distinctive — another phase was worse — and the worst frames had
moved to a **different phase in a different lap**, again inside a single
three-second window.

**The tell is the shape of the cluster, not its location.** A defect that lives in
a place recurs every time the camera passes through that place. A cluster that is
tight in *time* and moves in *space* between laps is an external event, and the
position it appears at is just wherever the camera happened to be. Position
clustering proves nothing on its own: in a one-lap run the camera is at one
position for the whole window by construction, so the clustering is guaranteed
whatever the cause.

This is the same failure as the earlier retraction, arriving through data instead
of through fluency: a real mechanism was available, the numbers were consistent
with it, and consistency is not attribution. **The cheap defence is to ask what
the observation would look like if the cause were external, and check whether that
also fits — here it fit perfectly and cost one extra run to discover.**

What did survive is smaller and stated separately: 0 frames over 100 ms in 929
parked frames in **both** runs, against 0.78% while walking, where a uniform rate
predicts about seven. So the long frames really are associated with motion. That
still does not say the scene causes them, because a static frame is cheaper for
the driver and a saturated GPU leaves a moving frame no headroom to absorb an
external spike — two explanations, one dataset, and the honest answer is that it
needs a quiet host.

## Judge a defect at the scale of the deliverable, or you will fix the wrong property

The rule that produced this project's most consequential finding tonight, stated
so it applies beyond one system.

Every capture pose in this harness was a **portrait** of its own object: close, long
lens, framed to fill. The deliverable is a 15-20 second first-person walk in which
each object is glanced at from walking distance, often peripherally. So every
judgement made about this car - proportion, legibility, material, every ranked
backlog - was made on frames no viewer will ever see. Adding one eye-height,
walking-distance, normal-field pose found a real defect on its first run.

### And then the same error one level down, in my own hands

Having added that pose, I saw a dark band on the bonnet shoulder, **cropped it and
magnified it 3x to look closer**, and diagnosed a chasm. That crop is a portrait. I
had reproduced the exact error I had just finished naming, one step after naming it.

Measuring at native scale contradicted the diagnosis outright:

| claim from the magnified crop | measurement at native walk-by scale |
|---|---|
| shut line far too wide | band is 12-68 mm; a slot quad is 6.2 mm p10, 11.6 mm median |
| flat dark stripe, no highlight | lit lip present either side at 12x to 280x the dark value |

Both halves wrong, and wrong in a way that would have produced a confident fix to a
property that was not the defect - narrowing a line that is not the band, and adding
a highlight that is already there.

**The frame that found the defect is the frame that must judge the fix.** A crop is
a different instrument, and magnification changes which properties dominate: at 4
mm/px a real 4 mm panel gap is *one pixel*, so "make the gap physically correct"
would have made it vanish rather than improve. Physical correctness and legibility
part company at viewing distance, and only the deliverable's scale can say which one
is being asked for.

### The general form

Three questions before believing any visual diagnosis:

1. **At what scale will this be seen?** Compute mm per pixel at the delivery
   distance, not at the inspection distance.
2. **Is the feature above one pixel there?** If not, no amount of correctness helps,
   and the fix has to be legibility rather than fidelity.
3. **Did I measure at that scale, or at the scale I zoomed to?** A magnified crop is
   a portrait, and it is subject to every objection portraits are subject to.


## 55. A loop over a lazily-populated collection reports zero without erroring, and zero is a plausible number

A texture-memory figure was wrong twice, in the same place, for a reason that had
nothing to do with the arithmetic.

Six of this system's textures are bound through a shader injection's uniform table
rather than through a material slot, so they are invisible to a walk over
`material.map`, `material.normalMap` and friends. That was known, and there was a
second loop for exactly them, reading
`material.userData.shader.uniforms[name].value`. The loop was correct. Its input
was empty, because `userData.shader` is populated by `onBeforeCompile`, which the
renderer calls at the **first render** — and the statistics are assembled at the
end of `init()`, before anything has been rendered. So the loop ran, found
nothing, added nothing, and reported a total that omitted the largest single
texture in the system.

The reported figure had already been corrected once, from 202.7 MB to 138.7 MB, by
fixing a genuine double count. That correction was right, was checked, and was
routed to another agent — and it was still short by about 38 MB, because the
double count and the omission were independent bugs in the same function and
finding one gave no reason to look for the other. **A number that has just been
corrected feels verified, and that is the worst moment to stop looking at it.**

What exposed it was not inspection. Shrinking the largest contributing texture by
a factor of 2.25 left the reported total **unchanged to one decimal place**. A
real change producing a byte-identical measurement is not a small discrepancy to
explain later; it is proof that the measurement does not depend on the thing being
changed. That inference is cheap and general: after any parameter change, ask
whether the metric moved *at all* before asking whether it moved the right way.

The fix is to hold references at creation instead of discovering them later. A
lazily-populated field is fine to read from a consumer that runs after the
population; it is never safe to read from instrumentation, because
instrumentation runs when it runs and reports a number either way.

Related, and the reason this class keeps recurring here: every guard and every
metric in this project is a comparison or a sum, and an empty input satisfies a
sum with 0 and a comparison with false. NaN did it twice, an empty loop has now
done it once, and in each case the code was correct and the input was not there.

## 55. A constant measured on the instance where it does nothing has not been measured

Three glass materials in this building shared one reflection strength, 1.25, on
an additive leaf. Player tested that architecture properly — suppressed the
storefront's additive passes from a fixed camera, one layer at a time — and
reported their contribution as **exactly zero**. That was correct, it exonerated
the compositing, and it is the reason the constant then went unexamined for a
night.

Measured on the cooler doors instead, with `?bglrefl=0` against the default, the
same leaves are worth **p75 191 → 163 and the fraction over luma 224 halved,
6.51% → 3.89%**.

Nothing about the constant differs. What differs is **what the pane reflects**: a
shopfront at dawn reflects a dim exterior, so a 25% boost on nearly nothing is
nearly nothing, while a cooler door reflects the lit shop interior — which became
a bright, structured thing the moment the PMREM world capture was promoted. The
storefront was the instance where the parameter could do the least, and it was
the instance that got measured.

So, beside the two-angle rule in case 39:

> **A parameter shared across several instances has to be measured on the
> instance where it does the most, and "what does this term multiply *here*"
> is a different question from "is this term wired up".**

A zero result is the weakest possible evidence about a multiplier's value, and it
is easy to mistake for the strongest, because it comes from a clean measurement
that found a real answer to a different question.

The follow-through also checked itself, which is the cheap habit: 1.25 → 1.0
removes 20% of a leaf worth 28 luma at p75, so it should recover about 5.6, and it
recovered 4 (191 → 187). A term that does not scale the way its own arithmetic
says it should is a term that is not doing what you think.

## 56. An occlusion term baked into an object darkens the faces the camera cannot see

The interior of this shop has been called "solid-colour boxes" and "plain grey
slabs" by a critic twice, and both times the reading was a texture problem. It is
not. Measured, the `door` pose — the pose for the interaction the brief actually
specifies — has a vertical local-contrast asymmetry of **0.99x** against 1.05–1.24x
on every pose the sun reaches, and its 1st percentile sits at luma 56. An interior
whose contrast is symmetric in the vertical is an interior lit by a constant, and
no amount of print on the packaging substitutes for shading.

The fix attempted was a slot-access term baked per vertex into every shelf item:
the angular extent of the slot mouth as seen from that vertex, so the back corners
go dark and the front lip stays bright. Correct, cheap, bound — and **visually
indistinguishable**, moving under-32 by 0.02 to 0.28 percentage points across
three poses.

The reason generalises well past shelves: **the faces an object-space occlusion
term darkens are the faces that face away from the opening, and those are the
faces the viewer cannot see.** The same geometry that makes a back corner dark
hides it. What a viewer reads as shading on a shelf is not the shading of the
item, it is the shadow the item casts on the deck, on the underside of the shelf
above, and on its neighbours — all of which belong to the *fitting*, not to the
product.

Same shape as Vegetation's result that where a term is applied matters more than
whether it is applied, and this is a stronger instance: applying it to the object
was not merely a weaker choice, it was applying it to the only surfaces guaranteed
to be invisible. Before baking occlusion anywhere, ask which surfaces the term
will darken and whether any of them are in shot.

### The third error in the same diagnosis, and it is the most reusable

Having been wrong from the magnified crop, I measured at native scale by sweeping
columns for the darkest run in each. That produced "the band is 12-68 mm wide",
which was also wrong, and the mechanism is worth naming: **the search window ran off
the object.** Each column swept y380-470 looking for the darkest pixel, and where
the column crosses above the bonnet's silhouette it leaves the car entirely and
finds dark background - tree line and dirt. The "dark run" was then measured as the
contiguous dark span, which happily merged unrelated background with the car.

The tell, once the region mask existed, is unmistakable: the dark pixels at the top
of each column read `rgb(75,46,34)` and `rgb(62,35,24)` - **warm brown**, which is
scrub and soil, not a near-black cavity material. A colour that does not belong to
any material in the object is proof the sample left the object.

So a sweep is not automatically safe. "Do not hand-pick regions, sweep the frame"
protects against choosing a flattering region; it does **not** protect against a
window that includes things other than the thing being measured. **A sweep needs a
mask as much as a hand-picked rectangle needs a validator**, and the region mask -
flat-colouring the candidate surface and asking which pixels are it - supplies both.

### What the mask actually showed, which was the opposite of the diagnosis

The shut lines are **fine 1 px hairlines, correctly placed** around doors, bonnet and
boot, each with a lit lip beside it: at 4 mm/px a slot pixel reads 0.0201 against a
neighbour at 0.3566, which is exactly the dark-line-plus-highlight pair a real panel
gap makes. 863 slot pixels across the whole car at walking distance. **There was no
chasm and nothing to fix.**

Three wrong diagnoses of one feature, each defeated by a different instrument error:
magnification, an unmasked sweep, and inference from geometry statistics. The
feature was correct throughout. Worth recording because the cost of the wrong fix
was high and specific - narrowing a 1 px line toward a physically-correct 4 mm gap
would have taken it below one pixel and **deleted the shut lines entirely** while
every geometry statistic improved.

## 58. A 200 is not evidence that a file exists, and a dev server will tell you so

While attributing an unexplained 404, `GET /favicon.svg` came back **200**, which
reads unambiguously as "an icon already exists, so that is not the problem".

There is no `favicon.svg` anywhere in the tree. The build directory contains
exactly `index.html` and `assets/`. The 200 was the preview server's fallback
handing back the HTML document for an unmatched path — so the probe that was
meant to establish what exists had instead been told "yes" for a path that
cannot exist.

**Any dev or preview server with an SPA fallback answers 200 for infinitely many
paths that are not files.** Checking existence over HTTP therefore proves nothing
unless you also check *what came back*: a content type, a length, or the first
bytes. `ls` the build directory instead, which cannot lie about this.

The wider form is worth keeping because it recurs in this project: **a probe's
"yes" is only as trustworthy as its ability to say "no".** A `canReach` that
snapped to the nearest reachable cell could never return false; a `GET` against
an SPA fallback can barely return 404. Both answer confidently and neither has
the power to disagree with you.

## 59. Elimination is an attribution only when the enumeration is complete, and it is still worth less than a reproduction

The 404 above was attributed without ever being reproduced. The chain: the app
contains no `fetch`, no `XMLHttpRequest`, no loader and no `.src =`, and four
separate loads each recorded **exactly two requests, both 200** — so nothing in
the page can 404, because nothing in it asks for anything. The browser's default
`/favicon.ico` request does 404 at the server, and no icon was declared. Only one
candidate remains.

That is a much stronger position than the usual "it fits", because the
enumeration is closed and mechanically verifiable: a request count of two, twice,
is a complete inventory rather than a survey. Contrast the earlier retraction,
where a mechanism fit a magnitude and nothing bounded the space of alternatives.

**But it is still not a reproduction, and the write-up has to say so.** No probe
run ever saw the 404: the icon fetch depends on tab state and the harness that
recorded it opens two pages in one context where the probe opened one. The fix —
an inline `data:` icon, which makes the request *impossible* rather than making
it succeed — is verified by construction rather than by observing the 404 stop.

Stating "attributed by elimination, not reproduced" costs one clause and tells
the next reader exactly how much weight the claim carries. **The failure mode is
not being wrong, it is being right in a way nobody can tell apart from a guess.**

---

## 45. Three ways a purpose-built measurement rig defeats itself, and the physics you must do before building one

Built an isolated-post rig to settle whether contact-hardening shadows actually
harden with distance. It took four rounds, and the first three failed for reasons
that were all predictable from the sun elevation alone. **At a 6.2 degree sun,
low-angle geometry dominates every measurement decision, and none of these were
instrument bugs — the rig was physically incapable of the measurement.**

### 1. Horizontal ground is the worst available receiver at a low sun

A horizontal surface takes `sin(6.2) = 10.8%` of the beam, so on flat ground the
ambient dominates and lit-versus-shadow is a small absolute difference sitting on
a dark asphalt albedo. Measured edge contrasts came out at 33 luma levels falling
to 6, the fits were noise, and the ratio was flat and meaningless.

Fixed with a high-albedo pad under the shadow. **This biases nothing**, because
penumbra width is purely geometric — albedo scales the absolute contrast without
touching the edge position. The same argument says a *vertical* sun-facing
receiver would be better still, at 9.2x the irradiance of ground.

### 2. A thin occluder cannot cast a long measurable penumbra

An occluder of radius R has **no umbra at all** beyond `R / tan(theta)`, because
past that distance the penumbrae from opposite limbs of the sun overlap and the
shadow fades to nothing. At the project's 0.0185 rad sun a 6 cm post gives an
umbra 3.2 m down an 11 m shadow, and every row past that returned "faint".

**The measurement was being defeated by the effect it was measuring** — a wider
penumbra is exactly what destroys the contrast the fit needs. Widening the post
to 25 cm buys an umbra to 13.5 m. Compute this *before* choosing the geometry.

### 3. A measurement window spanning two edges will silently swap between them

`penumbra.mjs` reported `unmatched dx≈30` on the far rows, and 30 px was the
shadow's own width: as one edge softened, the *other* edge became the steepest
feature in the window and the fit jumped across. Narrowing the window to a single
edge turned seven unmatched rows into seven matched ones **with no re-render**.

Worth noting the tool behaved correctly — it refused rather than reporting a
number, which is why this cost minutes instead of a wrong conclusion. The window
was wrong, not the instrument. Measure one feature per window.

### The control that made the result trustworthy

Both arms in one build and one browser, and **the arms were proven distinct in
pixels before anything was read from them**: 38.45% of channels differing, max
delta 94. An earlier attempt had produced a perfectly flat ratio, and the natural
reading was "the treatments are equivalent"; the actual cause was that a single
report block in the log came from one arm, so the flag state of the other arm was
simply unknown. A whole-frame diff answers "was it applied" in one line and
cannot be confounded by which arm got logged.

### And the shape of the positive result

The comparison arm's own trend was the control. A constant world-space kernel
**must** shrink in image space as it recedes, and PCF did, by 23%. PCSS grew
instead, and the ratio crossed 1.0 — some edges sharpened while others softened.
**A change of kernel width moves every edge the same way, so a crossing cannot be
produced by "softer" or "sharper" and is specific to distance-dependence.** Design
comparisons so the wrong hypothesis predicts a *different sign*, not a smaller
magnitude.

## 60. A feature named after a material gets built on that material, and the camera stands somewhere else

*(Numbering in this file has collided several times — there are two 55s and a
second 45. Treat the titles as the identifiers.)*

The brief says "wet asphalt from last night's rain". So the wet arm — damp film,
standing water, waterline, sheen — was built on the asphalt material, verified in
pixels, and reported as landed. It was landed. It was also entirely absent from
the concrete forecourt, which is the bottom third of most of an 18-second walk,
and which is the surface a person at this station actually stands on.

Three things had to line up for that to survive several rounds:

1. **The feature was scoped to the noun in the brief.** "Wet asphalt" is a
   material plus a state, and only the state was the requirement. The lot was
   rained on; so was the forecourt, the kerb, the island tops and the walk.
2. **One missing options block removed four features at once.** `pools` lives
   inside `soil`, so a material with no `soil` block has no damp film *and* no
   standing water *and* no waterline *and* no wet sheen. Nested optional config
   fails in bulk and reports nothing, because absent is a legal value.
3. **Every pose that examined water was aimed at water.** `puddle`, `rim` and
   `fringe` all point at `LOW_SPOTS`, which are on asphalt and dirt. A pose
   authored to inspect a feature is authored from knowledge of where the feature
   is, so it cannot discover where the feature is not.

The general form: **a pose that knows what it is looking for can only confirm or
deny it, never survey.** The defect was found within one frame of adding a pose
authored from the *camera path* instead of from the feature list — eye height,
ordinary lens, looking along the walk. Ask of every system: what surface is under
the camera for most of the deliverable, and has that surface got the feature, or
only the surface the requirement was phrased about?

## 61. In `mix(a, b, w)` the reviewable number is `b` and the operative number is `w`

The wet roughness arm read:

    roughnessFactor = mix(roughnessFactor, 0.42, smoothstep(0.05, 0.55, wdDamp) * 0.75);

The 0.42 is correct. It is the right roughness for a damp hard surface, it is
what the comment explains, and it is the number any reader — including its
author, twice — takes away as what the surface becomes when wet.

The surface never got near it. The substrate sits near 0.95, the blend weight is
capped at 0.75, and ordinary apron damp produces a weight near 0.40, so the
achieved roughness was **0.74** and full damp reached only 0.55. Nothing
concentrates a highlight at 0.74. The frames therefore had the darkening half of
"it rained last night" and none of the specular half — and the specular half is
the half that survives being seen from eye height into a low sun, because that is
the geometry where Fresnel is strongest.

**A ceiling on a blend weight makes the target aspirational, and the target is the
only part of the expression that gets read.** The failure is invisible in review
because every symbol is individually defensible: the target is physically right,
the smoothstep bounds are sensible, and the 0.75 looks like ordinary restraint.
Only the composition is wrong, and composition is what nobody evaluates.

The check is one line of arithmetic and it should be routine wherever a `mix`
implements a physical transition: **substitute the realistic input, not the
extreme one, and print the achieved value.** `wdDamp` is about 0.34 on the apron,
not 1.0, so 1.0 was never the case to reason about.

Note what the fix was *not*. Lowering 0.42 would also have produced more sheen,
and it was the wrong knob: the reach was broken, so the target was innocent.
Fixing the visible symptom through the innocent parameter would have left the
ceiling in place, made the pool a mirror as a side effect, and buried the real
defect under a tuning value that now looks deliberate. Two levers on one quantity,
one of them broken — establish which is broken before you move either.

## 62. A term that is not shadowed changes the mean and the spread independently, and the eye reports the mean

Having given the forecourt its wet arm, the first frame looked to me like the
raking shadows had washed out — which would have been a serious regression, since
the long-shadow composition is one of the few things a critic has protected. The
reasoning was sound: an environment reflection is unshadowed by construction, the
shadow map gates only the sun, so adding sheen lifts shadowed pixels and flattens
relief.

Measured, the nearest band's contrast had **more than doubled**, p90-p10 from
19.4 to 45.0. Nothing had washed out. Brighter overall and higher contrast at the
same time, and the eye reported the first and inferred the second.

**A mean cannot distinguish "brighter" from "flatter" and neither can looking.**
The statistic that separates them is a spread — here p90-p10 within a band of
constant depth, because at a low sun each band is nearly bimodal between sun and
shadow, so the percentiles land on the two modes. The two subsequent changes both
raised p90 while leaving p10 within a level, which is the signature of a specular
highlight and could not have been produced by a tint; a tint moves both ends.

So: **a suspected loss of contrast is a measurable claim, and it is cheap.** I was
one command from being wrong in the direction of reverting a good change.

### And a control arm that could not have failed, again

While establishing the above I passed `--force=nowet` to the capture harness. The
correct spelling is `--query=tforce=nowet`. The harness's argument reader matches
the literal prefix `--name=` and returns the fallback otherwise, so the flag was
silently ignored and the round was byte-identical to default — a round I was about
to read as a control arm showing wetness doing nothing.

This is the third instrument this session whose result was predetermined by
construction, and the first where the *value* was spelt correctly and the *flag
name* was wrong, which the existing unknown-token check could not see. The fix is
to reject every argument the harness does not implement, including well-formed
ones. **An unrecognised flag must be an error and not a default**, because the
default of a control arm is the thing it is controlling against.

What caught it was an unrelated habit: the harness prints the active force tokens
in its own stats line, so `"tforce":[]` appeared in a round that was supposed to
have one. **Print the state a run is in, not the state it was asked for.**

## 60. A protocol whose safeguards are prose has no safeguards

A document was written specifying five conditions that void a measurement run,
each with a numeric threshold, to be applied after a 25-minute run in a window
where the whole project stops and waits. All five were **prose in a markdown
file**: someone would have to remember them, find the relevant figure in a
60-line report, and compare by eye.

That is the fault this project has paid for most, one level up. **A void
condition nobody evaluates is not a safeguard, it is a paragraph**, and the
contended run it should have discarded gets argued about instead — at exactly the
moment when nothing else is running to settle the argument with.

Moving them into a pure function over the run record, printed **above** the
numbers the verdict governs, found two defects immediately:

- **Condition 3 was wrong as written, not merely unexecuted.** "Any card phase
  with a minimum below the baseline mean" includes the baseline phase itself,
  whose own minimum is below its own mean by construction. The gate would have
  voided **every run ever taken**, which is the failure mode where a check gets
  switched off within a day. It was caught by the deliberate *clean-run control*
  in the test, not by any of the cases written to make gates fire.
- **The report printed a fired condition as `ok` and then again as `VOID`**,
  because the record of evaluated conditions naturally includes the violated
  ones. Four `ok` lines above four `VOID` lines is a report a skimming reader
  closes as a pass.

One design point generalises past this file: **a condition whose inputs are
missing must report `UNKNOWN`, not pass.** Collapsing "could not evaluate" into
"did not fire" means a run with no VRAM sampling at all sails through every
memory gate by having nothing to test — the purest form of "the check did not
fail, it failed to run".

And the rule the clean-run control encodes: **test that a gate stays silent, not
only that it can shout.** Four cases proving conditions fire told me nothing
about the one that always fired.

## 61. The first measurement in a sequence is a different measurement

A harness was built to load the scene five times and check the ready times agree
within 2×. Rehearsing it produced, across three independent sequences:

| Sequence | Load 1 | Load 2 | Load 3 |
| --- | --- | --- | --- |
| A | **218.7 s** | 20.8 s | 21.3 s |
| B | **171.9 s, timed out** | 30.9 s | 21.9 s |
| C | **hard `Page crashed`** | — | — |

The criterion would have failed all three and blamed the harness or the host. But
**three for three is not the shape of random contention**, and the honest reading
is that the first load into a fresh process is measuring something the repeats
are not: first-request cost, first GPU context, cold shader and file caches.

The consequence is the part worth keeping. **The user's run is a first load.** The
~21 s init figure quoted throughout this project is a *warm repeat*, and the
number that describes what the user experiences had never been measured at all —
it sits somewhere between 21 s and 219 s and nobody had noticed the distinction,
because every harness loads once and every repeated harness reuses a process.

So the criterion now scores load 1 separately and reports it prominently, rather
than averaging it in or discarding it as an outlier. **A rule that treats the
most decision-relevant sample as noise is worse than no rule**, and the giveaway
was that the "outlier" was in the same position every time.

## 57. "Passable" and "crossable" are different properties, and a widest path only answers the first

A widest-path search maximises the tightest gap on the route. That makes it the
right instrument for "can the player get there at all", and it made this shop
pass: bottleneck 0.528 m at the doorway, +208 mm of margin, and a walked
confirmation that completed 176 legs.

It is the wrong instrument for "what would a player walk", and not by a little.
**Maximising the bottleneck makes the search prefer a wide detour to a narrow
shortcut — by construction it returns the longest acceptable route.** A detour
ratio measured on it says more about the search than about the shop: it reported
151 m walked for 37 m of straight line, which is a fact about max-min Dijkstra.

A player walks the shortest route their body fits through. That is a plain
shortest path on the same grid and the same clearance field, admitting only cells
with clearance above the body radius. Running both, and reporting both, separates
the two questions:

| | widest path | constrained shortest |
|---|---|---|
| answers | is it passable, and where is the gate | is it crossable, and what does it cost |
| bottleneck | 0.528 m — the doorway | **0.330 m — a 10 mm margin** |

The second row is the one that mattered. The direct interior route existed the
whole time and threaded gaps of 13 to 30 mm. **A gap can be admissible and
unwalkable at the same time**: 0.70 m of gap for a 0.64 m body passes every
threshold test and is a scrape, not a corridor, and a driven controller drifts
into the jamb and jams. Report the margin on the direct route, not just the
existence of a route.

One asymmetry worth knowing when reading those margins: a 13 mm margin at a door
*jamb* stalled the controller, and a 10 mm margin at an outside *corner* did not.
A corner-cut has open space on both sides of the tight cell; a jamb has wall.

## 58. A walk harness must not actuate scenery it passes, and must not search for a stance it can derive

Three failures in one session, all of which produced reports that read as
geometry defects in the shop:

1. **It re-clicked the entry door.** The interaction is a toggle and the opener
   had no memory, so on a route that lingered near the jamb it opened the door,
   then shut it, then stalled against a door it had closed itself. The report read
   `opened: entry-door at 1.52 m, at 0.10 m, at 0.22 m` — which is one opening and
   two closings. It hid for a whole session because only a *direct* route passes
   the doorway slowly enough to re-probe it.
2. **It opened cooler doors it merely walked past.** Once the route was direct
   enough to run along the cooler bank, "open anything named door within 2 m" left
   two leaves standing across the aisle, and the grab then failed. That looked
   exactly like an aisle-clearance defect.
3. **It searched for a stance instead of deriving one.** Sidestep left and right
   until the crosshair finds the bottle: it wandered five metres away, and each
   attempt reported a different number while the invariant — the crosshair never
   naming the bottle — held throughout. Case 53, for the third time.

The rules that fall out:

> **A harness may actuate only what stands in its way, and only once.** Anything
> it toggles twice it has restored, and anything it toggles in passing it has
> broken for the test that follows.

> **If a stance can be computed from the geometry, compute it.** The stance here
> is bracketed by two known faces and its centre is one line of arithmetic; the
> search that replaced that line generated four plausible false defects.

And the reason all three were expensive: **a harness fault and a scene fault
present identically.** Both come back as "the player could not do the thing". The
discriminator is whether the harness did something to the scene it would not have
had to do — and that is visible in its own log, which is why the log has to name
the object and the distance for every actuation.

## 62. Suspecting your own instrument is right; concluding from the suspicion is not

A finding had been escalated to the top of the project and a user-facing README
had been rewritten around it: the first load of the scene costs 3-10x what later
loads cost. Re-reading my own harness, I found a confound that fitted perfectly:

    await page.goto(base, ...);
    if (i === 1) {                              // attempt 1 only
      gpu = await assertHardwareGpu(page, ...); // a SECOND WebGL2 context
    }
    await page.waitForFunction(() => __SCENE_READY, ...);

The clock started before `goto`, so attempt 1 — and only attempt 1 — carried an
extra WebGL2 context allocation inside its measured window, on a card at 6-8 GB
of 8. Both sequences had it. **"First load" and "the attempt that does an extra
thing" were perfectly confounded.** There was even a control already in the data:
a different harness that loads once in a fresh browser and is always fast.

Everything about that invited immediate retraction, and retracting on it would
have been wrong. Removing the confound entirely — GPU check moved to a throwaway
page, all attempts byte-identical — gave **279.1 s, then 25.4, 23.3, 21.7**. The
effect was not merely intact, it was *larger* than before.

The lesson is symmetric with the one about accepting a flattering finding. **A
mechanism that explains your result is not evidence against your result**, in
either direction. I had a plausible artefact, a matching confound in my own code,
and a sibling harness that appeared to contradict me — three independent reasons
to withdraw, and the measurement said no. The cost of testing it was one run; the
cost of retracting a true user-facing finding would have been the deliverable.

And the sibling harness that "contradicted" it turned out to be the second half
of the explanation rather than a counterexample: **it loads the app in a
throwaway GPU-check page before the measured page exists**, so its fast number
was a warm load wearing the label of a cold one. A contradiction between two
harnesses is a fact about the harnesses until someone reads both.

## 63. "Every measurement was cold" and "every measurement was warm" are the same discovery pointed backwards

Two agents independently noticed that load-time measurements in this project had
never distinguished cold from warm. One concluded **every measurement was cold**,
because `browser.newContext()` is incognito and gives an empty cache each time.
The evidence said the opposite: repeats inside a sequence were a steady 21-25 s,
which cannot happen if every load is cold.

Both had hold of the same real defect and the direction resolves cleanly:
`newContext()` clears the **HTTP** cache, but the **GPU program cache lives at the
browser and GPU-process level, not the context level**, so contexts 2..N inherit a
warm one. Add a harness that loads the app once in a pre-flight GPU-check page,
and its measured load is the *second* load in that process.

**So every published init figure here was warm** — the 25.2 s load, the 8.3%
shader-compilation share, the per-system table — and the number describing what a
user experiences, 172-279 s, had never been measured by anything.

Two things worth carrying:

- **Test isolation is a variable, and an experiment that holds it fixed cannot
  discover that it matters.** Every harness chose incognito for good reasons and
  the choice was invisible because it was unanimous.
- **When two people derive opposite claims from the same observation, neither
  should be adopted until the mechanism is named.** "All cold" and "all warm"
  both explain "nobody ever compared", and only one of them survives contact with
  the repeat times that were sitting in both agents' logs.

The related deduction came free from data already collected: the penalty recurred
in **every fresh browser process** minutes apart on one machine, so the warm state
does not survive a process. That rules out the driver's machine-level cache and
points at Chrome's per-profile one — which matters, because a user with a
persistent profile pays it once and a harness with a throwaway profile pays it
always.

## 63. Albedo detail on a surface in shadow is bounded by the light, not by the paint

Three rounds went into making the forecourt read as a working forecourt: tyre
scrub at the stances, swing-in ribbons, a kerb grime band. All of it is in the
map, all of it reaches pixels — the forced-off control moved 71% of near-field
pixels with a mean of 3.9 levels — and none of it is visible.

The reason is arithmetic that should have been done first:

| | tonal spread (p90−p10) | % of 0–255 |
|---|---|---|
| forecourt under the canopy | 18.6 | 7.3% |
| sunlit ground, same frame | 132.7 | 52.0% |

The canopy deck is 4.72 m up and the sun is at 11°, so its shadow reaches
4.72/tan(11°) = **24.3 m** past the deck edge, ending at z ≈ 51 against a
forecourt that ends at z = 27.2. **The entire forecourt is in shadow, and so is
the lot behind it.** Its median luminance is 41. A 30% albedo mark — which is a
strong mark, about what fresh rubber does to concrete — moves such a surface by
12 levels, or 4.8% of the range, in a frame whose highlights are at 255.

So the general result: **the visible contrast of an albedo feature is the product
of its albedo ratio and the illumination on it, and in shadow the second term is
the one that dominates.** Painting harder is multiplying the term that is already
fine. This is the same shape as the slope-versus-solar-tangent case — compute the
condition the feature has to survive before choosing an amplitude — and it has the
same corollary: the number to check is cheap and nobody checks it.

Practical rule: **before authoring surface detail, measure the tonal spread of the
region it is going onto.** If that spread is under about 10% of range, no albedo
work will read there and the lever is the light, which usually belongs to someone
else. Ask for it rather than compensating, because compensating means authoring
absurd albedo values that will look wrong the moment the light is fixed.

### The two wrong turns, both instructive

**Reusing a helper whose side effect dominated.** The swing-in ribbons were first
drawn with the existing `drivenPath`, which paints a dusty sun-bleached strip at
1.22x albedo across `gauge + 1.5` metres. That is correct for an open lane, where
the ground between the wheel tracks really is paler. Sixteen of them layered over
the stances flooded the area with *light* wash: measured, stance oil tint fell
from 63 to 50 and 5th-percentile albedo rose from 88 to 94, so the first version
of a change made to add contrast **removed** it. A helper's incidental behaviour
is load-bearing when you call it sixteen times in one place.

**Measuring "it does not read" from a view that could not contain it.** The first
two walking poses were authored to judge the ground plane and its wetness, so both
look across open forecourt. The scrub is at the stances, x within ±4 and z of
21.25 and 25.15 — **neither pose had a stance in frame.** One round was spent
concluding the marks were weak from frames that could not have shown them. Same
defect as the crop whose variance was all broad shading: an instrument pointed
away from the signal returns a confident null.

### And the input check that saved a round

Before any of this, the premise was "the forecourt has no grime, add some". A
byte-level scan of the overlay map (`tools/overlayscan.mjs`, written for this)
found the forecourt is already **the dirtiest surface on the site** — oil-tint
channel averaging 33 against the asphalt lot's 11, and 100% coverage at the
stances. The forecourt was never undirtied, and painting more of the same would
have changed nothing. **Check what the input already says before adding to it**,
which is the same lesson as the empty-uniforms loop from an hour earlier, and the
second time in one session that reading the input beat auditing the consumer.

## 64. A warning reported as a failure is the false positive that gets the gate switched off

`shoot1` aborted a round on this console line:

    THREE.WebGLProgram: Program Info Log: (210,81-129): warning X4122: sum of
    0.996094 and -2.98545e-017 cannot be represented accurately in double precision

That is ANGLE's HLSL backend commenting on ordinary constant folding. The frame
had already been captured correctly. The detector matched `program info log`,
which is the envelope *every* shader diagnostic arrives in, benign ones included.

Shader compile and link errors must stay fatal — that rule has earned its place
here. The defect is the classification, not the severity: a gate that fails a
healthy round teaches its operator to pass `--force` and stop reading it, which
costs more than the gate ever saved. Fixed by excluding `warning X\d+` unless the
same line also says `error`, with a four-case self-test including a line carrying
both, since a warning followed by a real error must stay fatal.

The benign ones are now printed as notes rather than dropped. **A diagnostic
nobody ever prints is where a real one hides in a familiar shape.**

## 65. One scalar over several terms attributes the whole drop to whichever term you were thinking about

`?lforce=nofluoro` is named after the fluorescents. It took `interior_cold` from
129.9 to 37.7 mean luma, and I reported that the lamps supply 71% of the interior
frame. They supply 39%.

The flag zeroed one `gain` scalar that four independent things multiplied by: the
ceiling fluorescents, the cooler tubes, the storefront daylight rect, and the two
point lights standing in for sun bounce off the floor. Splitting it into separate
levers and re-measuring in one bundle gave the real ranking, which was close to
the reverse of my first two guesses:

| term | luma | share |
| --- | --- | --- |
| door bounce + jamb glow | 44.8 | 49% |
| all lamps together | 36.1 | 39% |
| storefront daylight rect | 11.1 | 12% |

I then guessed wrong a *second* time in the same hour, on the same evidence: with
the lamps ruled out I attributed the room to the storefront rect, because a
wall-sized area light is the conspicuous thing in that file. The rect is 12%.

**A flag's name is a hypothesis and its blast radius is a fact, and only one of
them is in the code.** The rule that follows is mechanical rather than a matter of
care: before quoting a share, count how many terms the flag multiplies. If it is
more than one, it can bound the total and cannot attribute any part of it. Both my
wrong attributions were arithmetically consistent with the measurement I had —
that is what made them comfortable, and neither survived contact with a lever that
moved one term.

Related to **"A bug report names a cause, and the name is not evidence"**, where
the misleading name was on a *report*. This is the instrument-side version, and it
is worse, because a report is obviously someone's opinion while a measured 92-luma
drop feels like a fact.
The 92 was a fact. The attribution was decoration.

## 66. Byte-identical variants are a build failure before they are a null result

A four-point sweep of a new parameter produced four byte-identical frames. I read
that as "the parameter never reached the lights" and started looking for the
plumbing mistake.

The plumbing was fine. `num` was not defined in that scope, the whole interior
lighting threw during construction, and every arm rendered a room with no interior
lights at all — identical because they were all equally broken. The harness had
already said so, in the line directly above the pixel numbers I was reading:

    exit=1
    [shoot4] shutting down: __SYSTEM_ERRORS -> num is not defined;
             interior lighting was not built

`npx tsc --noEmit` had also printed `error TS2304: Cannot find name 'num'` before
the round started. I had run it, in the same command, and piped it somewhere I did
not read.

Two habits, both cheap:

- **Read the exit code before the pixels.** A non-zero exit means the numbers
  below it describe something other than what you asked for. This project's whole
  thesis is silent failure; this one was screaming.
- **An edit script must verify its own match.** Mine ended with
  `print("wired")` on an unconditional line after a `str.replace` that had not
  matched. Every later edit in this session ends with a `count != 1` check that
  raises, and prints `EDITS_APPLIED_OK` only on the far side of it. A control must
  prove it was applied — including the controls that are three lines of Python.

A third thing worth naming, because it wasted a paragraph of confident writing.
The X4122 shader warning of **"A warning reported as a failure is the false
positive that gets the gate switched off"** appeared in none of my logs before
05:01 and ten times at 05:09, so I attributed it to the spot shadow I had just
added. It is
not mine: the count was two per capture across all five arms *including the arm
with the spot disabled*, and a sibling had landed a shader change in the eight
minutes between my two rounds. **A novelty test across two rounds in a shared tree
measures the tree, not your change** — the same finding Pumps reached for pixels,
which applies just as well to console output.

## 64. Every instrument here samples after readiness, which is why init was a black box

An audit of my own harnesses, prompted by a sibling finding that `page.screenshot`
**times out at 15 s during a single unbroken ~12 s main-thread block in init**:

| Harness | waits for ready at | first sample at |
| --- | --- | --- |
| `perf.mjs` | line 222 | line 563 |
| `shadow-type-ab.mjs` | line 132 | line 171 |
| `program-audit.mjs` | line 413 | line 466 |
| `stress.mjs` | before the route | after ready |

**Every one samples strictly after `__SCENE_READY`.** The narrow good news is that
none of them can hit that timeout. The real content is the same fact stated
honestly: **init has been a black box with a single number written on it for the
entire project**, which is why neither the 12 s stall nor a 10x cold-load penalty
was ever visible from here.

Per-system `init()` timings do not fix this. A wall-clock delta around a call
reports how long a system took and nothing about the *shape* of what it did — **12 s
of unbroken blocking and 12 s of cooperative work are the same number to it**, and
only one of them makes a progress bar freeze and a screenshot time out.

The pattern that works was already in this codebase without being recognised as a
pattern: **sample from the harness process, not from the page.** The `nvidia-smi`
VRAM sampler polls from Node and is immune to main-thread state by construction;
CDP `Page.startScreencast` and CDP metrics have the same property, which is how a
sibling recorded 771 compositor frames across a 283.8 s load with a longest gap of
5.49 s. Anything routed through `page.evaluate` or `page.screenshot` queues behind
the very stall you are trying to measure — **the instrument is blind exactly when
the interesting thing happens**, and it reports that blindness as a failure of
itself rather than as a property of the program.

## 65. A marker element with no visible purpose is the most dangerous kind of dependency

`index.html` carries `<div id="loading"></div>`: zero size, empty, no text, no
styling beyond being invisible. It looks like debris.

It has **six** dependents, and every one of them fails quietly if it goes:
`Game.ts` removes it on rendered frame 2; one harness times **first frame** by
watching for that removal with a `MutationObserver`, so if the element never
exists the observer never fires and the harness reports no first-frame time
*while otherwise succeeding*; another asserts its presence during boot; and three
more print its `textContent` as their diagnostic when a load fails.

Those last three are already broken and nobody noticed. The element is now empty
and **nothing writes text into it any more**, so their `#loading text:` diagnostic
prints an empty string — in precisely the failure case it was added for. The
status text moved to a different overlay when the loading screen was rewritten,
and three harnesses kept reading the old address and getting a valid, meaningless
answer.

Two rules. **An element that exists only to be observed must say so at the
element**, not in the report of whoever added the observer — a comment pointing at
a CSS rule explains why it is invisible, not why it may not be deleted. And
**reading a property that is now always empty returns success**: `textContent` on
an empty div is `""`, not `null`, so no probe, no test and no type checker can
distinguish "the diagnostic is blank" from "there was nothing wrong".

## 66. A failing verdict survives contention; a passing one does not

Deciding whether to spend a scarce quiet window on the cold-load gate produced a
rule worth keeping, because the intuitive answer is wrong in a specific way.

The cold-load effect is **immune to contention** and has been shown so five times:
279.1 s and 283.8 s from two different harnesses with two different purposes,
agreeing to 1.7%, both on busy hosts. So a contended run measures the effect
fine, and it is tempting to conclude the measurement does not need a quiet host.

That conflates the effect with the verdict. **Contention only ever inflates**, so
for a gate that fails above 180 s:

- A contended cold load of 279 s, discounted by the largest contention penalty
  ever measured here (40% on a warm load), is still ≥ 199 s. **The FAIL is robust
  — the margin is 99 s and contention cannot account for it.**
- But a *future* contended run at 70 s cannot be distinguished from a quiet 50 s.
  **The PASS is not available at any level of contention.**

So the phase a measurement belongs in depends on **which direction the answer is
expected to point**, not on how robust the underlying effect is. Confirming a
known failure with a magnitude is contention-tolerant work. Verifying that a fix
crossed a threshold is not, and must be re-run quiet even though it is the same
command against the same criteria.

The corollary is the part that would have been missed: **a crash during a
contended run is not attributable.** Cold loads have crashed the page before under
contention, so a crash in this phase must be reported as uninformative rather than
as the strongest possible version of the finding — which is exactly what it will
look like at the time.

## 67. `addEventListener` with an undefined listener succeeds and does nothing

Caught mid-edit in a sibling's file while checking a precondition, and it is this
project's signature failure in one line:

```js
window.addEventListener("keydown", this.onKeyDown);   // onKeyDown does not exist yet
```

`tsc` reports it (`Property 'onKeyDown' does not exist`), but nothing at runtime
does. The DOM spec types the callback as a nullable `EventListener?`, so
`undefined` coerces to null and the call **returns early without throwing**. The
listener is silently never registered.

The consequences are ordered from harmless to expensive:

- Init does **not** throw, so `__SCENE_READY` still fires and the scene still
  loads. A load-time measurement over this build is valid.
- But the key it was registering is dead. **The feature is absent and the program
  reports success**, so any harness driving that key sees no effect and attributes
  it to the interaction being broken, or to its own input dispatch — never to a
  listener that was never attached.
- A build step that does not typecheck (Vite, esbuild, oxc all strip types without
  checking them) will ship this happily. **`tsc` is the only thing in the pipeline
  that can see it**, which is why "leave the tree typechecking" is a runtime
  correctness requirement here and not a tidiness one.

The general form, third instance tonight after the empty `textContent` and the
zero-dimension PNG: **an API that accepts absence as a valid argument cannot
report absence as an error.**

## 68. A shadow's reach is one number and its direction is two, and a reach applied to the wrong axis lands somewhere real-looking and wrong

Terrain reported, with arithmetic, that the canopy deck shadows the entire
forecourt and that this is why a full cycle of tyre scrub, swing-in ribbons and
kerb grime delivered a contrast delta of exactly zero. The deck is 4.72 m up at
a sun elevation taken from `site.SUN`, so the reach came out as
4.72 / tan(11 deg) = 24.3 m. The conclusion drawn from it — "ending at z = 51,
and the forecourt ends at 27.2, so the entire forecourt is inside the canopy's
shadow" — placed all of that along +Z.

Two independent errors, and they are worth separating because only one of them is
the interesting one.

**The elevation was stale.** `site.SUN.elevation` held 11 degrees while
`LightingSystem` shipped 6.2 privately, and nothing in `src` imported the shared
field, so the renderer never disagreed with it. Corrected, the reach is
**43.5 m**, not 24.3. See the unused-constant entry below; the shared field has
since been reconciled to 6.2 and this tooling now cross-checks it.

**The direction was applied to the wrong axis, and that was the load-bearing
mistake.** `SUN.azimuth` is `Math.PI * 1.13`, or 203.4 degrees, so the anti-sun
direction in XZ is (0.918, 0.397) and the displacement is **39.9 m in X and
17.3 m in Z**. The deck's shadow lands at x 33.3..46.5, z 30.4..44.0. **The
forecourt ends at x 11.6, so the deck's shadow misses it by a wide margin** — and
note that the stale elevation made the error *look smaller* than it was. Fixing
only the elevation would not have found this; fixing only the axis would have
given the right answer for the wrong reach.

Ray casting every forecourt sample toward the real sun vector against the deck,
the fascia, the four columns and the store building:

```
  canopy deck + fascia    shadows NOTHING on the forecourt
  canopy column 1..4      2.20% .. 4.03% each, 11.0% together
  store building          shadows NOTHING on the forecourt
```

The forecourt is **89% in direct sun**. Two systems then spent effort on a
shading problem that did not exist, and a third was asked to raise a light level
to fix it.

Why it survived review: a reach is a scalar and reads like a complete answer, so
`24.3 m` invites `z + 24.3` without the azimuth ever being consulted. Both the
number and the region were real, which is what made the composite credible.
Note also that a 6.2 degree sun under a 4.72 m deck penetrates **43.5 m**
horizontally, against a deck only 13.2 m across — **so a low sun lights the ground
under a canopy right through to the far side and out the other end, more than
three times over**, which is the opposite of the intuition that a canopy shades
what is beneath it.

### The coverage figure did not move when the elevation was corrected, and that is a result rather than a stale read

Re-running at 6.2 degrees returned column coverage of **10.97%, identical to the
figure computed at 11**. The inputs had plainly changed — `sunDirection` from
(-0.9009, 0.1908, -0.3899) to (-0.9124, 0.1080, -0.3948), metres of shadow per
metre of height from 5.14 to 9.21 — so the invariance needed explaining rather
than accepting. Sweeping the elevation with an override:

```
   3 deg  10.97%      20 deg  22.75%
   4 deg  10.97%      35 deg  42.03%
 6.2 deg  10.97%      50 deg  49.91%
  11 deg  10.97%      65 deg  51.41%
```

Exactly constant to 11 degrees, then rising. The mechanism: the columns span the
full clear height, so a ground point is shadowed if its sightline crosses a
column footprint *while still below the soffit*, and a ray reaches soffit height
only after 4.76/tan(el) — 43.8 m at 6.2 degrees, 24.5 m at 11. Both exceed the
furthest any forecourt sample sits from a column, so the test degenerates to a
purely two-dimensional question about the footprint, and **the answer cannot
depend on elevation at all** inside that band. Above about 14 degrees the deck's
own shadow begins landing on the forecourt, which is what the rise is: at 20
degrees the deck contributes 16.41% where it had contributed nothing.

Two things follow. The correction from 11 to 6.2 degrees sits entirely inside the
invariant band, so **every forecourt number reported at 11 degrees stands
unchanged** — the streaks are not longer or differently placed within the
forecourt, only outside it. And an invariance across a changed input deserves one
sweep before it is either trusted or disbelieved: had the probe been reading a
cached value, the sweep would have shown a flat line all the way to 65 degrees
rather than a band whose boundary has a derivable cause.

The check is cheap and there was no excuse for not running it: cast the ray
rather than reasoning about the offset. `tools/probe-shadowsource.mjs` runs
in under a second with no GPU, and names the occluder per sample. **Anything
attributing a region's darkness to a specific occluder should identify that
occluder by ray test, not by displacement arithmetic.** Cross-reference case 63,
which is correct as written but whose premise — that the surface was in shadow —
did not hold for the case that produced it.

## 69. Occlusion and the bounce off the occluder are anti-correlated by construction, so a bright ceiling cannot give the floor beneath it tonal structure

Having established the forecourt was flat, the request was to raise Canopy's
"soffit bounce". Two mechanisms were in the way.

First, **the named lever does not connect at all.** The soffit's brightness comes
from a `lightMap` and an `emissiveMap`, and both are receiver-side terms:
`WebGLRenderer` has no light transport between surfaces, so `setLampBounce(2)`
brightens the soffit's own pixels and moves the ground by exactly zero levels.
Turning it and re-measuring would have produced a null result indistinguishable
from a broken control — the failure mode of case 42, arrived at from the other
end.

So the real second bounce was built instead: integrate the soffit's baked
exitance over the deck with the parallel-surface form factor `h^2/(pi r^4) dA`,
and occlude the ambient by the exact solid angle of the deck. Both purely
geometric, no level baked in. Individually they are strong — the bounce field
ranges 10.7x across the forecourt.

**Their sum is flatter than what it was meant to fix.** Combined spread across
the deck footprint: **3.4%, against the 7.3% Terrain measured.** The reason is
structural, not a tuning error: sky occlusion is deepest exactly where the view
of the soffit is best, and vice versa. At the deck centre sky visibility is 0.535
and soffit bounce is 0.996; at the drip line they are 0.707 and 0.734. A ceiling
with albedo `a` returns `a` times what it intercepts, so the two terms cancel to
within `(1 - a)`, and the soffit's albedo is 0.82.

Which is why canopies are painted white, and why a forecourt under one is not
gloomy. The near-cancellation is the physics.

Two things worth keeping from it:

- **The free coefficient between two fields is where the error lives.** The first
  version published `skyVisible` and `soffitBounce` separately and left the
  consumer to weight them; the weight used while testing was an arbitrary 0.42,
  which can and did produce a deck that *brightens* the ground it shades. The
  fix was to publish one combined `ambientScale = skyVisible + albedo * (1 -
  skyVisible) * shape`, which is bounded above by 1 by construction and cannot be
  mis-weighted because there is nothing left to weight.
- **Measure the amplitude a published field reaches at the consumer's geometry
  and put that number in the service.** This one is 0.883 at the drip line, 0.915
  mid-bay, 0.942 on the apron: 6.3% point to point and 0.5% median to median. It
  is published with those figures in its own doc comment and an explicit note not
  to spend a round on it, because the alternative is a consumer discovering the
  amplitude after integrating it. Same principle as a borrowed value being
  visible in the borrower's report, pointed outward.

## 70. A region lit mainly by a constant is flat at every brightness, so the lever is structure and not level

The forecourt measures median luminance 41 with a tonal spread of 7.3% of range,
and 89% of it is in direct sun. Decomposing the terms actually reaching it at the
current levels:

```
  direct   sun 4.4 x sin(6.2 deg) = 0.108  ->  0.475
  ambient  env 2.4, one constant colour    ->  2.400
  ambient : direct = 5.05 : 1 on horizontal ground
```

Two consequences. The region is dark because a horizontal surface at 6.2 degrees
of elevation collects **10.8%** of the beam — dawn, working correctly, and not
something an occluder is doing to it. And it is *flat* because the term that
dominates it by 5:1 is spatially constant. Measured over the open apron
inside the forecourt, tonal spread from the lighting terms alone is **0.0%**;
under the deck it is 25.9%, and every bit of that comes from the four column
shadow streaks, which are the only structure present in that region.

> A spatially constant term cannot produce spatial variation, at any magnitude.
> Raising it makes the region lighter and equally flat.

This is the complement of case 63 rather than a restatement: that entry says
albedo detail in shadow is bounded by the light, and gives the level. This one
says that on a surface whose dominant term is *uniform*, no amount of level
restores structure either, and the only levers are terms that vary — occlusion,
and shadow.

The same argument was already written down in this system's own file, for the
soffit, months of agent-hours earlier in the night: *"there is no ambient
occlusion anywhere in this scene and the environment's lower hemisphere is a
single constant colour, so a flat soffit lit only by that hemisphere comes out as
one value across 178 square metres."* The surface facing it, 4.7 m below, has the
identical problem for the identical reason, and neither system connected the two
until the ratio was written out. **A diagnosis recorded for one surface does not
propagate to the surface facing it.** Fourth instance tonight of a rule covering
the case that produced it and not the next one.

## 68. A system that rasterises at construction cannot be measured, and the workaround is always an empty collection

`BuildingSystem.init` read `location.search`, then rasterised every texture it
owns through `document.createElement("canvas")`. **`location` is shimmable; a
canvas is not.** So the system could not be constructed under Node at all, and
every CPU-side harness that registered it died on the second line of its own
setup.

The interesting part is not that it failed. It is **what the failure forced
downstream**. A sibling harness needed this building's collision rects, could
not construct the system to ask for them, and so added an opt-in path that
supplied the published footprint with an **empty blocker list**. That harness
then over-populated the lot interior for an unknown number of runs, and only its
results outside the footprint meant anything.

An empty collection is the worst possible stand-in, because **it is a valid
answer to the question that was asked**. `blockers.length === 0` is exactly what
a building with nothing in it returns. Nothing throws, nothing warns, and the
consumer's own arithmetic runs to completion on it. Compare the alternative
failure — `require("building.blockers")` throwing — which is unmissable and lands
in the tool that had no business needing them.

Two rules from it.

**Split what describes *where things are* from what describes *how they look*.**
The plan of this building is pure arithmetic over about thirty dimensions; the
rasteriser is a separate concern that happened to sit in the same `init`. Once
the plan lives in its own module (`gen/buildingLayout.ts`, free of `document`,
`window`, `location` and THREE materials) the footprint, the blockers, the
bounds, the collision function and the floor height all come for free under Node,
because none of them ever needed a pixel. There is now no second copy: the system
imports that module rather than owning its own literals, so the two cannot
disagree — which is the same rule that the impulse island's geometry-versus-
collision pair nearly broke.

**Publish nothing you would have to fake.** The layout-only path deliberately
does *not* provide the door lists, the light slots, the grabbables or the
interior material set. Each of those would have to be an empty array, and a
consumer cannot distinguish "no cooler doors in this build" from "no cooler doors
because there is no canvas". They are left absent so `require` throws. A
`building.headless` marker is published instead, so a tool can *assert* which
path it took rather than infer it from what is missing — inferring a mode from
absent data is how the empty blocker list survived in the first place.

The general form: **when a system cannot be constructed in an environment,
somebody will construct a fake one, and the fake will be shaped like a correct
answer.** The cost of not being headless is not paid by the system. It is paid,
silently, by whoever needed it.

## 69. The frames a defect was measured in are part of the report, and an mp4 cannot stand in for them

A routed finding: **721 pixels at exactly (255,255,255)** in frames 11 and 12 of
the film, clustered at x 480–630 in the lower third, attributed to the store
front. Neutral, all three channels railed, and therefore unrecoverable by any
grading — a real defect described precisely, with the right instrument, and with
a correct inference about mechanism (a neutral clip is something white, emissive
or specular; a warm sunlit surface clips red first and shows colour on the way
up).

It could not be reproduced, and the reason is worth more than the finding.

`shots/film/frames/` **was empty** by the time it was read. The only surviving
artefacts were the encoded mp4 and a handful of PNG stills. So the frames were
re-extracted from the mp4 — and **frames 11 and 12 contain zero pixels at exactly
(255,255,255)**. Not because the defect was fixed: because H.264 with 4:2:0
chroma subsampling and lossy quantisation does not preserve exact channel values.
The single measurement the finding rests on is **the one quantity an encode
destroys**.

Location does survive an encode, and that is what settled it. In those frames the
region x 470–640 in the lower third has a **maximum luma of 76**. Compression
moves a value by a few codes, not from 255 to 76 across a 170 × 300 region, and
the frame turns out to be under the canopy with the building not in shot at all.
So the coordinates cannot describe the store front *in this file*, and the frames
they do describe no longer exist.

Three rules.

**Keep the frames that carry the claim, or cite a frame that can be regenerated
deterministically.** A frame index into a lossy encode is not a citation; it is a
pointer into a different image than the one measured.

**Match the instrument's precision to the medium's.** "Exactly 255" is a
meaningful test on a PNG and a meaningless one on an mp4. The same probe run on
the two media gives 721 and 0, and neither number is wrong.

**Use the quantity that survives to check the one that does not.** The encode
could not confirm the clip, but it could refute the location, and refuting the
location was enough to stop a fix being aimed at the wrong object. When the
primary measurement is unavailable, look for a secondary one that the failure
mode cannot have affected.

What replaced it was a measurement on the lossless stills that *were* on disk:
521 px and 197 px fully clipped in the two door-approach frames, every one of
them on a single material, localised by clustering the clipped pixels and reading
their bounding boxes rather than their count. **721 was one number that could have
been one lamp or forty specks**; the cluster shapes said mullion and push bar, and
the material followed from that in one grep.

## 71. A shadow is displaced, not extended, and getting that wrong invents an occluder that is not there

I told two systems the forecourt was in the canopy deck's shadow. It is not, and
the error was one line of geometry.

What I computed was the shadow's **reach**: a 4.72 m deck at a low sun throws a
shadow 24 m long. What I then assumed was that the shadow covered the deck's own
footprint and continued 24 m past its edge — that a roof shades the ground under
it and a strip beyond. That is what a roof does at noon. At a low sun it is
wrong, and the correct statement is a translation rather than a dilation:

    shadow region = caster footprint + h * (toward-sun XZ) / sin(elevation)

For this deck that is the footprint moved 43.5 m, so the shadow lands out in the
lot at x 10.7..23.9, z 53.0..66.6 and **0.0% of the forecourt is inside it.**
The sun comes in *under* the deck edge and the ground beneath the canopy is
directly lit. The lower the sun, the further the shadow leaves the object, and at
6.2 degrees it leaves entirely — a roof at dawn shades somewhere else.

The reason this is worth a case rather than an erratum is what it did downstream.
The measurement it was attached to was correct and remains correct: the forecourt
sits at 41 luma with 7% of range of tonal spread, and albedo detail cannot read
there. But an attributed cause travels further than a measurement, because it is
what tells other people what to change. On the strength of "the forecourt is in
deep shade" one system was asked to bounce light off the soffit and another to
raise the environment intensity — two fixes aimed at an occluder that does not
exist. The real cause is that a horizontal plane at a 6.2 degree sun receives
sin(6.2) = **10.8% of the beam**, uniformly, everywhere, whether or not anything
is over it. That has the same symptom and the opposite prescription: the
illumination cannot be raised without destroying the dawn, so the lever is
specular response and relief, not more light.

**A number and its explanation should be routed with different confidence.** The
41 luma was measured; "because the canopy shades it" was inferred in one step from
a figure I never checked the direction of, and it was the inference that got acted
on. When passing a diagnosis to someone who will spend a round on it, say which
half was measured.

Two corollaries.

**A cast shadow you cannot find is often displaced rather than absent.** Lighting
ablated three shadow causes on the ground lattice earlier tonight and found all
three negative; a shadow that has moved 43 m is indistinguishable from a shadow
that is not being cast, from inside the region it left.

**Grazing incidence is a stronger darkener than occlusion at dawn.** Being fully
shaded costs a surface its direct term. Being horizontal at 6.2 degrees costs it
89% of the same term. So a scene at dawn is full of surfaces that are dark for
Lambert reasons and read as shadowed, and the first thing to check when something
looks shaded is its own orientation, not what is above it.

## 72. An unused constant cannot be wrong, so nothing corrects it, and the first consumer inherits a number nobody has checked

`site.SUN.elevation` said 11 degrees. The renderer ships 6.2, held privately in
`LightingSystem` as `SUN_ELEVATION_DEG`. Nothing in `src` reads the shared field —
only `SUN.azimuth` is imported — so the two numbers coexisted for as long as the
project has existed without anything going wrong, because nothing depended on it.

Then the CPU probes arrived, and shadow geometry is exactly what a CPU probe
computes. Three tools reached for the shared constant. One (Vegetation's
`vegshadowfit.mjs`) discovered the discrepancy and hard-coded 6.2 locally with a
comment. Two (`probe-canopy.mjs`, `probe-shadowsource.mjs`) are still reading 11
and computing every shadow length **1.8x short**. My own `poolsite.mjs` did the
same on its first run and reported a Lambert factor of 19% where the truth is
11%.

The failure mode is specific and it is not "a stale constant". It is that
**staleness is unobservable in exactly the constants that are unused, and being
unused is not a stable property.** A field with no consumers is never validated
by anything, accumulates no pressure to be right, and looks authoritative because
it sits in the shared file next to constants that are load-bearing. The moment a
consumer appears it inherits a number whose only credential is that it has never
been contradicted.

Two habits follow. **A shared constant that the shipped code overrides privately
is worse than no constant**, because the override is invisible from the consumer's
side and the shared name is the one that gets imported — the same shape as the
stale "`groundSoil` is NOT published" warning, which was believed because it was
written down. And **when a constant is duplicated, the copy in the file that
renders is the true one**; the fix is not to reconcile them but to delete one.
`site.SUN.elevation` now holds 6.2 so that every consumer is right by default, and
`LightingSystem` should import it rather than keep its own.

## 73. A tolerance calibrated on one feature and reused on another can consume the whole range of the second

The water arms in `worldDetail` grade over depth: `smoothstep(0.0, 0.020, depth)`
takes standing water from "damp ground" to "mirror" over the first 20 mm. That
number is right, and the reason it is right is a property of asphalt — water
thinner than the 7 mm exposed aggregate presents the aggregate's microsurface
rather than its own, so it takes 10 to 20 mm before a pool behaves as a surface.
It was calibrated against `LOW_SPOTS`, whose dishes are 52 to 92 mm deep.

Reused unchanged on a concrete slab-panel puddle it produced a null. A puddle in a
settled forecourt panel is 20 to 30 mm deep at its deepest, so the 20 mm ramp
consumed the entire depth range of the feature: measured before capturing, **76%
and 71% of each pool now sits past the ramp, and with the inherited number it was
13% and 0%.** The second pool had no mirror anywhere in it. Both would have
rendered as damp patches and the round would have reported "the pools are subtle".

What makes this its own case rather than an instance of "convert a tolerance into
the units the feature lives in" is that the units were fine. 20 mm is 20 mm in
both places. What differed was the **range of the quantity being thresholded**:
the ramp was a small fraction of a lot hollow and the whole of a slab puddle. A
threshold is only meaningful relative to the distribution it cuts, and reusing one
across features means reusing it across distributions.

The fix was not to retune the constant, which is shared and correct where it came
from, but to notice that the thing it encodes — the depth at which water stops
showing its dish — **is a property of the substrate and not of water.** It became
a per-material parameter defaulting to the old value, so asphalt is unchanged to
the bit and the slab gets 5 mm, which is what sub-millimetre float finish
deserves. When a constant has to differ between two call sites, the useful
question is which physical property it was standing in for; if that property
varies between the sites, the constant was always a parameter.

## 74. Restructuring generated content reseeds all of it, so a single-realization A/B compares two different worlds

Any scatter that draws from one shared rng stream has this property, and every
system here has one. Change the *structure* of the scatter — split a loop, add a
group, reorder two branches — and every subsequent draw shifts, so the arm you
are comparing against is not the old world with your change in it. It is a
different random world. The diff you measure is your change plus a complete
reseed of everything the scatter placed, and there is no way to tell those apart
from one pair of frames.

I read three consecutive rounds of exactly this as evidence about one change:
"the road corridor helped", "it hurt", "it hurt differently". The change was
substantially the same each time. What moved was the seed.

The size of the trap, measured: sweeping 16 seeds through the far scrub scatter,
the seed-to-seed standard deviation of one measure — filled bearing bins across
the highway at 60-90 m — is **3.9 against an effect of 6.4**. Every swing I had
been reacting to was inside one standard deviation. The instrument was not wrong;
it was being read one sample at a time.

Three things fix it, and the third is the one that generalises:

- **Sweep seeds and report the spread.** `scatterScrub` took an optional `seed`
  and `tools/vegfringe.mjs` runs 16, printing the sd beside every figure so a
  reader can see whether a difference clears it. The shipped seed is quoted
  separately, because what ships is one draw and the photograph is judged on that
  one.
- **Make the change additive and prove it.** Groups selected by loop index rather
  than by an rng draw, appended after everything else, cannot perturb an earlier
  draw. That converts "probably fine" into a checkable claim, and it was checked:
  1858 sites before, 2183 after, **identical prefix 1858, zero plants present
  before and absent after**. With that established the comparison is paired and a
  single realization *is* valid, because only the added members differ.
- **Prefer the arrangement that cannot reseed.** Where a change can be expressed
  as additive it should be, not for tidiness but because it makes the A/B sound.

The general form: **a control arm must differ from the test arm in one thing, and
"same code, different rng draw" is not one thing — it is everything the generator
touches.** Before trusting any before/after over generated content, ask whether
the change moved the stream. If it did, either sweep the seed or make the change
additive and prove the prefix.

## 75. A window that spans two directions reports their sum and hides the trade between them

I measured the continuity of a scrub fringe by binning plants into 2-degree
bearing bins and reporting the filled ones over bearings 140-220 degrees, which I
named "the highway half". The highway runs along x and every standing position is
at positive z, so the road side of the view is 180-360 degrees and *along* the
road is 180 and 0. My window was one along-road cone plus a slice of the road
side, and it could not see the +x direction at all.

The consequence is specific and worth stating because it is not "the number was
noisy": a change that added clusters **symmetrically in plus and minus x** read
as a **loss**, because the window contained one of the two halves it added to.
The measurement was correct. The aggregation destroyed the signal and inverted
its sign.

The fix was five named windows — road side, along road -x, along road +x, across
road, behind lot — and the reason is general. **A scatter's shape decides how
coverage is distributed between directions, so an instrument that sums over
directions cannot see what the shape decides.** It reported "road side is up 5
bins" for a change that took 6 bins from across-the-road and gave 11 to along-it,
which is a trade a reader would want to weigh and could not.

Two smells that name this class in advance: an aggregate whose window was chosen
before the thing being measured was understood, and a window whose name is a
direction ("the highway half") while its definition is a numeric range nobody has
re-derived since. If the name and the arithmetic have to be checked against each
other, check them.

## 76. A predicate that encodes an assumption about extent becomes a different predicate when the extent changes

`sitesOnRoof` in VegetationSystem asks whether a plant's ground height exceeds
1.6 m and reports the hits as plants standing on the building's parapet. That is
sound, and it was sound for as long as the assumption underneath it held: every
plant lived within about 170 m of the lot, and inside 170 m the only ground above
1.6 m is the roof.

Extending the far scatter along the highway to 230 m broke the assumption without
touching the check. The terrain genuinely rises out there, so the count went
**17 to 36** in the round the corridor was added and the named culprits were
clumps at (226, 12) and (-194, 13). They are on a hillside. Nothing in the output
said "these are outside the range I was written for" — it said "36 plants are on
the roof", in the same format as when it was right.

The check now tests a place, because the roof is a place: restricted to the lot,
and back to 0. The general form is that **an implicit precondition on a
predicate's domain is invisible in its output, so a predicate whose false
positives depend on where the population lives will start lying the moment the
population moves** — and it will lie in the confident voice it used when it was
correct. Two of these have now been found in this project by noticing a count
change at the same time as an unrelated extent change; neither would have been
found by reading the predicate.

## 68. A criterion that cannot be read must fail, not print a question mark

`tools/tiers.mjs` was written to prove quality tiers change what they claim to.
Its first run printed this and reported **PASS**:

```
  tier  reported  programs  shaderMs  texMB  draws     tris  instances
  high      high         ?         ?      ?    936  7891985      83996
```

Program count is the *headline* criterion — it predicts the ~92% of a cold load
that is driver shader compilation. It was absent, and the run passed, because the
only assertion compared instance counts and those were present. **The check did
not fail; it failed to run, and printed a question mark where the answer should
have been.** Fifth instance of this class today.

Two fixes, and the second is the general one:

- The instrumentation was not injected. `__GLSTAT` is not part of the app; it is
  injected per page by the harness, and this harness had not been told to.
- **A null measurement is now a failure.** Any tier whose program count or
  texture bytes come back null fails the run explicitly, on the grounds that a
  criterion which was not evaluated has not been satisfied.

There is a coda worth keeping, because it is a smaller version of the same fault.
After adding the injection the columns were *still* `?`, and the failure message
said `__GLSTAT missing` — which was now wrong. The accessor was
`__GLSTAT.snapshot()` and the real method is `mark()`, so the object was present
the whole time and the harness was reading a name that did not exist. Optional
chaining turned a typo into a silent null. **The guard was right and its
diagnostic was wrong**, which is worse than a bare failure: it sends the next
person to look at injection instead of at the property name.

## 69. Sequential conditions in one browser: whatever runs first wears the artefact

The tier harness measures three tiers back to back in one browser. Cold shader
compilation costs ~10x on the first load of a fresh browser profile, so:

| Run | first tier | its time | the other two |
| --- | --- | --- | --- |
| A | `high` | 234.9 s | 21.6 s, 21.8 s |
| B | `low` | 268.7 s | 23.9 s, 23.2 s |

**The penalty follows position, not tier.** Reversing the order reversed which
tier looked catastrophic, and the effect is an order of magnitude — large enough
to swamp anything a tier actually does.

This was not designed as a control; it happened because a later change reordered
the list. It is the substitution control anyway, and it would have been trivially
easy to publish run A as "the high tier is ten times slower to load", which is
false, plausible, and consistent with every other number in the table.

The rule: **when conditions are measured sequentially in one process, the first
measurement is a different measurement** (case 61 again, from a new direction),
and a harness must either randomise order, warm the shared state before the first
condition, or give each condition its own fresh process. Until it does one of
those, it must print the warning *above* the table rather than beside it, because
the table is what gets pasted into a report.

## 70. A quality tier is two independent budgets, and cutting the wrong one changes nothing

Measured here: a cold load is ~235–284 s, of which the driver is blocked
compiling and linking shaders for **~216–247 s, or 92%**. Warm, the same figure
is 2.0–2.4 s and ~10%. Same pipeline, either side of a populated program cache.

So a quality system has two axes that do not substitute for each other:

- **Compile-time**: program count, `onBeforeCompile` permutations, material
  variants, transmission. Governs the wait before anything appears.
- **Run-time**: triangles, instances, shadow resolution, fill rate, DPR.
  Governs whether it holds framerate once running.

The first tier system built here pulled the second axis hard — 300 MB of GPU
memory, 30% of triangles, 74% of scatter instances — and **left program count at
202 across all three tiers.** By the numbers above that means the low tier, aimed
squarely at weak hardware, buys such a machine *nothing at all* on the thing its
owner actually experiences: a four-minute wait, which on a slower compiler is
worse than four minutes.

The trap is that the run-time axis is the one that is easy to measure and easy to
move from outside a system — instance counts and render targets are visible in a
scene graph traversal, so a central module can pull them without anyone's
cooperation. **The compile-time axis lives inside other people's material code**,
which is exactly why a well-intentioned central tier system will pull the axis
that does not matter and report a convincing table of savings.

And it cannot be recovered at runtime: by frame 1 the programs are compiled, so
lowering a compile-time lever later would trigger the recompile stall it exists
to prevent. **The compile-time family is boot-only by nature**, which is why
capability detection cannot be replaced by adaptive measurement, however much
better measurement is than guessing.

## 70. `ERR_MODULE_NOT_FOUND` on a file that exists is Node's resolver, not a broken module — `tools/ts-resolve.mjs`

If a CPU tool dies like this:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\...\src\gen\buildingGeo'
    imported from C:\...\src\systems\BuildingSystem.ts
```

the module is fine. **Node 22 strips TypeScript types on its own, so
`import "../src/gen/foo.ts"` works — but it will not resolve an *extensionless*
relative specifier**, and `src/` is written for Vite, where `./noise` means
`./noise.ts`. So the first hop succeeds and the second fails, which reads like
the imported file being broken rather than the resolver being stricter than the
bundler.

Fix:

```
node --import ./tools/ts-resolve.mjs tools/your-tool.mjs
```

That hook appends the extension Vite would have (`.ts`, `.tsx`, `/index.ts`,
`.js`) and does nothing else — no transpile, no DOM shim, no effect on the
browser path. Without it, importing anything from `src/` with its own
dependencies is a dead end, which is a large part of why CPU-side tooling here
tended to re-implement `src/` logic instead of calling it. Re-implementing is how
two copies of a constant get created, and two copies is the failure in case 68.

## 71. A term can be inert because of where the surface sits on the tone curve, and removing it is still right

The cooler liner carried `emissiveIntensity: 0.22` as a stand-in for tube lights,
with a comment saying it was kept low "so the liner does not blow out to paper
white and swallow the silhouettes of the bottles standing against it" — and 5750
clipped pixels later said it was doing exactly that.

The obvious diagnosis was a **double count**: `lightInterior.ts` had since placed
three `RectAreaLight`s at 7.0 in the cooler, aimed back into the cabinet, so the
lamps the term stood in for now existed. Confident, mechanical, and wrong.

Measured on one pose from one build and one browser, as pixels over luma 235 out
of 170,315:

| term | owner | effect |
| --- | --- | --- |
| liner emissive 0.22 | this system | **+117 px (0.07%)** |
| `?ibounce=0.35` room bounce | Lighting | 1,341 px (0.8%) |
| `?lamp=0.5` | Lighting | −53,064 px (31%) |
| `?lamp=0.25` | Lighting | −155,821 px (91%) |

The term I was about to claim as the cause is worth **0.07%**. The reason is case
42 from the other direction: **a surface pinned to the flat top of the tone curve
absorbs any small additive term without showing it.** The same 0.22 on a
mid-tone surface would have been plainly visible. So "is this term doing
anything" has no answer independent of where its surface lands on the curve —
which means an inert term cannot be exonerated *or* convicted by reading it.

Two things follow.

**Removing it was still correct, for a different reason than the one I had.** Not
because it was costing radiance, but because a value that models nothing and
measures nothing is a value somebody later tunes in good faith. It went out with
its measurement written next to it and a flag to restore it.

**And the decomposition is the deliverable, not the fix.** The blowout is 91%
one lever, and that lever belongs to another system. Handing over "your cooler
lamps at 7.0 put a 0.78-albedo liner on the top of the curve, here are the four
numbers" is worth more than any adjustment I could have made on my side — and
adjusting my albedo to compensate would have been the exact class of local
correction this file spent the previous night removing.

## 72. A harness with its own copy of the shot list silently drops the pose you came for

`shoot2.mjs --shots=grab,cooler` reported `1/1 screenshots` and a complete round.
`grab` — the pose added specifically to reproduce the defect under investigation
— does not appear anywhere in the output, because the harness holds a
hand-written `ALL_SHOTS` array and the argument is applied as
`ALL_SHOTS.filter(s => ONLY.includes(s))`. A name the array does not know
filters to nothing, quietly.

This is case 68's shape in a tool rather than a system: **a second copy of a list,
and the copy that wins is the one nobody thought of as authoritative.** It is
worse than a missing capture, because the round's own completeness check compared
what was written against the same filtered list and agreed with itself.

The import cannot be removed here — pulling `src/gen/buildingShots.ts` into Node
drags the whole Vite-resolved graph with it (see case 70) — so the duplicate
stays. What was removed is the silence: an unrecognised shot name now exits 2 and
prints the known list. **If a duplicate cannot be eliminated, make disagreement
between the copies fatal.**

## 77. A shared constant that no shipping code reads cannot be validated by the scene looking right

`src/site.ts` exported `SUN.elevation` at 11 degrees. `LightingSystem` lights the
scene from a private `SUN_ELEVATION_DEG = 6.2`. Nothing in `src/` imported the
shared field. So the wrong number sat in the file that looks most authoritative
in the repository, for as long as the file has existed, and no render could ever
have disagreed with it — because no render consulted it.

The usual defence against a wrong constant is that the scene would look wrong.
That defence requires the constant to be on the path that draws pixels. This one
was not. Its only consumers were CPU probes, which is exactly the population that
trusts a shared constant most: a probe imports `site.ts` **because** it wants the
authoritative number rather than a local guess, and importing it is the
responsible thing to do. The reward for being responsible was a sun 1.8x steeper
than the one that ships.

It misled three probes across two systems, and the derived quantity travelled:
the solar tangent 0.194 was circulated to four systems as the threshold for
"will this slope catch relief lighting", against a true 0.109. Shadow reach came
out at 24.3 m instead of 43.5 m. Both conclusions happened to survive, which is
luck, not validation.

**A constant is only as checked as its most pixel-facing consumer.** Two rules
follow. If a shared constant is not read by shipping code, it has no error
signal at all and needs an explicit cross-check — one probe whose whole job is
to assert that the shared field and the private field agree, and to fail when
they do not. And when shipping code holds a private copy of a shared quantity,
the private copy is the authority whether anyone intended that or not, because
it is the one the photograph is evidence about.

### The sharper form: a defensive read that has never once read anything

The tool that produced the 0.194 figure held this line:

```js
const sunTan = Math.tan((SUN?.elevationDeg ?? 11.2) * (Math.PI / 180));
```

The field is `SUN.elevation`, and it is in radians. `SUN.elevationDeg` does not
exist and never did, so `??` fired on every run the tool has ever made. The tool
did not read a stale constant — **it never read the constant.** It read its own
default, while naming the shared field in the source, which is why the audit that
grepped for consumers of `SUN.elevation` found it and assumed it was fixed by
fixing the constant.

`?.` plus `??` reads as caution and behaves as suppression. It converts a misspelt
field, a renamed field, a unit change and a deleted field into the same outcome: a
plausible number, no warning, no stack. The two defects it is protecting against
are not comparable — an absent optional input deserves a default, a misspelt
required input deserves a throw — and the idiom cannot tell them apart.

The corrected line has no fallback and throws, because a tool that cannot find
the sun must not guess it, and because **every conclusion in that tool's output
is a comparison against that one number.** A default is appropriate exactly when
the caller can tolerate being wrong about it; when the number is the axis the
whole report is measured along, tolerating being wrong about it is the failure.

## 78. A timeout shorter than the phenomenon reports a healthy system as broken

Cold loads here are 221-302 s. Readiness waits across the suite were 90-240 s, and
Playwright's default is 30 s. **27 fatal sites in 26 harnesses.**

The failure mode is what makes this expensive rather than merely wrong. A build
that is working perfectly reports *"never became ready"* with an empty page
console — which is indistinguishable from a shader link failure, and was
diagnosed as one more than once. **A timeout converts "slow" into "failed", and
"failed" is a different kind of claim: it invites a root-cause hunt for a defect
that does not exist.**

The dangerous tier is not the shortest one. A 90 s budget fails every cold load
and gets noticed as "this never works". **A 240 s budget sits inside the 221-302 s
range, so it fails intermittently and reads as flakiness** — and sixteen of the
twenty-seven sites were at 240 s. Intermittent is worse than never, because never
gets fixed.

Second fault, independent of the first and present in 26 harnesses:
`waitForFunction` defaults to `polling: "raf"`, and **rAF does not fire while the
main thread is blocked.** The poll is starved during precisely the stall it exists
to observe. Raising the timeout without setting `polling: 500` fixes half of it
and leaves a check that still cannot see the thing it waits for.

## 79. Three ways a static analyser lies about the code it audits

The timeout audit above first reported **120 fatal sites**. The real number was
27. All three errors inflated it, and all three are generic to any tool that
greps code for defects:

1. **Constants.** `timeout: READY_TIMEOUT_MS` matched no numeric literal, so it
   was graded as absent and therefore fatal — including in a harness that passes
   an explicit 420 s. **A scanner that reports named constants as missing values
   punishes good style and calls it a defect**, and the harnesses most likely to
   name their constants are the ones most likely to have thought about them.
2. **Documentation.** A `waitForFunction` inside a header comment, written to
   show callers the correct call, was counted as a live site. Comments must be
   blanked *while preserving line numbers*, or every reported location shifts.
3. **Grading unlike things alike.** Navigation timeouts were graded against the
   same threshold as readiness waits, which tripled the count. `main.ts` does not
   await `start()` at top level, so `load` fires before init and a navigation
   timeout never waits on a cold load. **The two look identical in a grep and
   have entirely different risk.**

The general rule, and it is the same one as the null-measurement case: **when the
analyser cannot resolve something, the answer is UNKNOWN, not the default.** The
tool now reports unresolvable identifiers rather than assuming the worst about
them — because a scanner that inflates its own findings gets ignored at exactly
the rate a 42:1 false-positive rate earns.

## 80. Paying a fixed cost per iteration instead of per run

Six captures in one browser: 355 s. The same six as separate runs: ~1500 s. The
difference is that **a cold browser pays 216-247 s of driver shader compilation
and a warm one pays 2 s**, so at ~230 s per cold start the *browser* count is
nearly the entire cost and the *arm* count is nearly free.

So multi-arm capture in a single browser is not an optimisation to reach for when
convenient — with a fixed cost this large it is the only viable way to capture
anything cold, and any harness shaped as `for (arm) { launch; measure; close }` is
paying the dominant cost once per arm for no return.

The same property has a sharp edge, and both halves must be held at once: because
the first arm pays the compile and the rest do not, **the first arm is never
comparable to the others** (case 69, tier ordering). The thing that makes the
pattern cheap is the thing that makes its first measurement worthless.

## 81. A new overlay does not need a new entry in the suppression list, if it goes inside an existing one

**If you are adding a DOM overlay to `index.html`, read this before you add it to
anything.**

Canvas screenshots in this project photograph the *page* clipped to the canvas
box, not the canvas contents, so any element over the viewport lands in the file
— this is how `#hud`'s "Click to look around / WASD to walk" ended up baked
across every reference frame `walkprobe` had ever produced, and an outside critic
called the frame unusable before anyone noticed the text was ours.

The defence is an enumerated list of element ids that each harness hides before
it shoots, e.g. `tools/walkprobe.mjs`:

```js
const OVERLAYS = ["hud", "loading", "reticle"];
await page.evaluate((ids) => { for (const id of ids)
  document.getElementById(id)?.style.setProperty("visibility", "hidden"); }, OVERLAYS);
```

Enumerated on purpose, so a new overlay shows up in a reference frame and gets
noticed rather than being silently swallowed by a rule written before it existed.
The cost of that choice is the obvious one: **every new overlay looks like it
needs an edit to every harness that has such a list, and those harnesses belong
to other agents.**

It usually does not, and the reason is one line of CSS semantics: the list uses
`visibility`, and **`visibility` inherits.** So an overlay nested inside an
element already on the list is suppressed by the existing entry, in every harness
that has one, with no edit anywhere.

The interaction prompt ("press E to start the pump") is a child of `#reticle` for
exactly this reason, and it joined three harnesses' suppression lists without
touching any of them. **Anything added inside `#reticle` later inherits the same
protection.** Two conditions, both easy to check and both easy to lose:

- The list must hide with `visibility`, not `opacity` or a class. `display: none`
  would also inherit in effect, since children of a `display: none` parent are
  not rendered; `opacity` would not compose the same way and a class-based hide
  reaches only the element it is put on.
- The nesting must be real containment, not just visual adjacency. A prompt
  positioned *near* the reticle but parented to `<body>` gets none of this.

There is a design dividend rather than only a testing one, which is why it is
worth preferring the nesting even where the suppression list is not a concern:
one element to show and hide means one visibility rule, one transition curve and
one state machine deciding when the whole assembly is on screen — so the parts
cannot disagree about whether they are visible. The reticle's dot and its prompt
share `.shown` and `.reach` and therefore cannot get out of step.

The trap to avoid while doing it: put the state class on the *container* and the
visual transforms on the *children*. `#reticle.reach .dot { transform: scale(1.45) }`
scales the dot only. Had the dot stayed the container, the prompt would have
inherited its 1.45x scale and the wording would have jumped size every time
something came into reach.

## 73. A shader feature's cost is not its program count, and the flag that gates it may buy far more than it was chosen for

`ctx.quality.transmission` was picked as a tier lever because **transmission is a
large shader**, and shader compilation is 92% of the cold load here (215,956 ms
cold against 2,003 ms warm, measured from inside GL). The expected win was
program count.

Measured on one build and one browser, three arms, on a pose containing the only
two transmissive materials this system owns:

| arm | programs | draw calls | triangles |
| --- | --- | --- | --- |
| high | 144 | 472 | 6,908k |
| `?bgtrans=0` (this flag alone) | **138** | **369** | **4,959k** |
| `?tier=low` (whole tier) | 138 | 369 | 3,200k |

Six programs, as expected. **And 103 draw calls and 1.95 million triangles** —
22% of the draw calls and 28% of the triangles in that frame, from two materials
on one object 200 mm across.

The reason is that `transmission > 0` in three.js does not only compile a bigger
shader: it makes the renderer **re-render the whole scene into a transmission
target**. So the cost is not attached to the transmissive object at all. It is a
second copy of everything else, and it scales with scene complexity rather than
with the size or number of the transmissive materials. Two leaves on a bottle
priced a full extra pass over the building, the shelving and the stock.

Three things follow.

**Price a feature by what the renderer does with it, not by what it looks like in
the material.** A `transmission: 1.0` on one small object and a `transmission:
1.0` on forty of them cost nearly the same, and both cost roughly the whole
frame again.

**A flag chosen for compile time can be a frametime lever, and vice versa.** This
one was justified on the cold load and is worth more per frame than it is per
launch. Neither number would have been found by reading the material.

**Isolate the flag from the tier.** `?tier=low` moves shadow map size, world
capture and detail patches at once, so its 144 → 138 cannot be attributed to any
one hook — and here it happens to be *entirely* this hook, which a whole-tier
measurement would have credited to the tier. The instruction was to prove
`programs.length` falls rather than that the flag parsed; a per-flag override that
does not change the tier is what makes that provable.

**And the no-op direction needs proving too.** The high-tier capture is
**byte-identical (md5 `fac1fe7e…`)** to the same pose from the previous round,
built before this hook existed. An unchanged mean or a passing health check would
not have been evidence; identical bytes across two different bundles are.

One trap on the way: the first attempt measured the arms at **137 programs each**
and looked like a null. The pose did not contain the hero bottle, so neither
material was ever compiled. **A feature flag is only measurable in a frame that
would have used the feature**, which is obvious in hindsight and reads exactly
like a flag that did not bind.

## 83. Shader-cache warmth belongs to the profile directory, not to the machine

The finding that makes the previous three cases actionable, and it inverts the
intuition. A cold load here is 192-349 s and a warm one ~21 s, and the difference
is **not** a property of the host, the driver, or how many times that machine has
compiled these shaders. It is a property of **the browser profile directory.**

Every fresh `mkdtemp` profile measures cold on a host that has compiled this
scene's shaders dozens of times over. `chromium.launch()` creates a throwaway
profile and discards it, so a harness using it pays the full cold compile on
every single run, forever, no matter what ran before.

Two consequences that pull in opposite directions, and both must be held:

- **For anything where load is setup cost**, an ephemeral launch is a standing
  tax of five to six minutes per run. A persistent `user-data-dir` removes it
  entirely. On a thirty-minute exclusive window, that is a quarter of the window
  spent on a step budgeted at twenty seconds.
- **For anything measuring load**, a persistent profile *silently deletes the
  phenomenon*. The run does not fail; it succeeds and reports a healthy 21 s for
  something a user experiences as four minutes. That is the more expensive
  direction, so the warm launcher is opt-in, refuses to be the default in the
  harness that reports a ready time, and prints which regime produced the number
  next to the number itself.

The intra-process exception is worth knowing because it explains an old
reconciliation: within one browser process, contexts 2..N *do* inherit warmth
from context 1. That is why a pre-warm page works at all, and why a harness with
one can look warm while believing itself cold. But it dies with the process, and
it only helps if the pre-warm actually waited for compilation rather than for
`domcontentloaded`.

## 84. A timeout that cannot be found by reading the number

The sharpest version of the timeout class, and it defeats careful review rather
than rewarding it.

```js
await page.waitForFunction(fn, { timeout: 240_000 });   // effective: 30 s
```

Playwright's signature is `waitForFunction(pageFunction, arg, options)`. A
two-argument call puts the options object in the **arg** slot, where it is passed
to the page function as data and quietly ignored, and the real options default.
**The source says 240 s. The runtime uses 30 s.** Verified directly: the same call
with a never-true predicate throws `Timeout 30000ms exceeded`, and 5 s once a
`null` is placed in the second position.

Three things make this worth its own case:

1. **It is invisible to a scanner that reads literals**, which is what my own
   timeout audit did. The number is present, correct-looking, and never used. The
   detector now checks the *shape* — counting top-level commas outside the
   predicate body — and grades a positional call as fatal whatever its literal
   says.
2. **It punishes diligence.** An auditor who opens the file and reads the timeout
   sees eight times the margin that exists, and comes away reassured.
3. **It survives review by coinciding.** The only other instance found across the
   suite had an intended value that happened to equal the 30 s default, so
   nothing ever behaved unexpectedly and nothing prompted a second look.

The general form: **an API that accepts a valid object in the wrong position
cannot report the misplacement**, which is the same shape as `addEventListener`
accepting `undefined` and as `textContent` returning `""`. The argument was
well-formed; only its position was wrong, and position is not a type.

## 85. Truncating an ordered list is only sampling if the order is random

`InstancedMesh.count = authored * d` draws instances `0..n-1`. That is uniform
thinning **only if instance order is spatially uncorrelated**, and a scatter built
group by group is maximally correlated.

Measured consequence in the shipped low tier: one layer fills as annulus, then
gap ring, then road corridor in contiguous blocks, so `d = 0.25` **did not thin
the far scrub — it deleted the gap ring and the road corridor outright and kept
the annulus whole.** Those two blocks existed to close a fringe defect a critic
had already reported. Another layer fills in grid-scan order, where the same
operation removes a contiguous band of z.

Three things make this worth recording beyond the fix:

- **The aggregate metric was correct and useless.** The harness verified
  instances fell 83,996 → 21,924 and passed. The count was right, the spatial
  distribution was destroyed, and no count-based check can tell those apart.
- **It reads as someone else's bug.** A hole where the gap ring was looks like
  the layer failed to generate, in the file of whoever owns that layer, not like
  a central lever thinning wrongly.
- **The fix belongs in the lever, not in each system.** Shuffling each baseline
  mesh's instance buffer once with a fixed seed gives uniform sampling to every
  system including ones not yet written. Fixing it per-system would need every
  future scatter author to know.

Guards worth keeping, because the shuffle is only safe under conditions that
could quietly change: it runs **only when something is actually being thinned**,
so the default tier never touches an instance buffer; it refuses meshes whose
geometry is shared or which carry custom instanced attributes; and it records
each mesh's `instanceMatrix.version` so a system that starts rewriting instances
by index gets a loud warning instead of silently swapped objects. **Every
`setMatrixAt` in this scene is in a build loop, which is exactly why the check
that it stays that way is cheap and worth having.**

## 86. Program count cannot see the change that saves the time

Four owners were asked to gate `onBeforeCompile` sites to cut a 216 s cold shader
compile, with program count as the pass criterion. The first hook landed, worked,
and moved nothing: **143 programs before and after**, with the system's own share
going 6 → 0.

The six were replaced one-for-one by stock-key programs, because those materials
have **define sets unique in this scene** — combinations of `map`, `alphaTest`,
`vertexColors`, `DoubleSide`, `shadowSide`, `dithering` that nothing else uses —
and three.js keys its program cache on the define set. Each costs a program
whether or not a shader is injected.

**Gating a patch site reduces program *size*. It reduces program *count* only
when the material's defines then collide with another's.**

So the criterion was measuring the wrong quantity in a way that would have
actively misdirected effort: a full round of correct gating could cut a real slice
of 216 s with the count pinned at 143 and be scored as no progress, while a change
that merged two materials and saved one link would be scored as a win.

The generalisation is about proxies, not about shaders. **Program count was
chosen because it is cheap to count and hard to fake** — both true, and neither
implies it tracks the cost. The number that moves is `blockedMs`, driver time
blocked in compile and link, 215,956 ms cold against 2,003 ms warm.

And the sharpest form of the proof problem, which applies to every one of these
hooks: **"count unchanged" is what a working flag and a broken flag both print.**
The resolution is not a better threshold but a better observable — the system
printing *its own share* of the cache alongside the total turned a null into a
diagnosis, and belongs in every hook's verification.

## 87. A surface can lose its printed content to the viewing angle, and that looks exactly like a map that never bound

Film's playtest called two large white rectangles floating in the shop interior
the single worst-looking thing in the build, and offered the two candidate
causes that a still frame cannot separate: **a material with no map assigned**,
which renders as flat geometry, or **a correctly-mapped surface blown out** by
interior lighting. The routing was sound and the instrument for it was named:
railed pixels mean exposure, flat-but-below-255 means nothing is being drawn.

It was neither, and the third possibility is the one worth writing down.

The measurement, on frames already on disk. The clipped-pixel count inside both
rectangles was **zero**, with a peak luma of 234, so the exposure branch was out
in one command. But the missing-map branch was out too, and by a stronger
argument than a pixel value: **the same object, in the same capture session, from
the same build, at a shallower angle, is fully printed.** `glass-65.png` shows it
as a legible "NOW HIRING / APPLY WITHIN" notice, and `at-wall.png` shows it
printed from inside. A map is bound or it is not; it cannot be bound at 65° and
absent at 82°.

What changed with the angle was the amount of content left, and the right
observable for that is not the mean or the standard deviation but the **number
of distinct luma codes the region spends its pixels on**:

| region | mean | sd | distinct codes |
| --- | --- | --- | --- |
| the notice at 65° | 178.6 | 39.65 | **163** |
| the notice at 82° | 231.6 | 1.36 | **6** |
| shelving behind the same pane, 65° | 120.2 | 33.21 | 230 |
| shelving behind the same pane, 82° | 108.2 | 29.52 | 160 |

Twelve thousand pixels spending themselves on six codes is not a subtle loss,
and the control is what makes it attributable: **the darker things behind the
same glass at the same angle keep their contrast.** A pane that had simply gone
opaque or milky would have taken the shelving with it. Only the surface that was
already near the top of the tone curve ran out of room.

So this is case 42 — *a modulation is only visible where the product lands on a
part of the tone curve that still has slope* — arriving from a new direction.
There the emitter's intensity was owned by another system and pushed the map
into the shoulder. Here the **viewing angle** does it, through grazing-incidence
reflectance, and the surface with the least headroom is the first to go blank.

### The rule

**Before concluding a map never bound, find the same surface at a different
angle, distance or exposure in a frame you already have.** A map is a property
of the material; content loss that depends on the camera is a property of the
tone curve, and the two are the same picture and opposite fixes. The
discriminating statistic is the distinct-code count, not the mean, and it needs a
*darker control in the same frame behind the same intervening surface* — without
it, "flat and bright" is equally consistent with a veil over everything.

### And the measurement that stopped a clean story being told

The obvious mechanism was the additive reflection leaf adding a near-constant
radiance over everything behind the pane. It is refuted by the table above,
using the attribution guard: **ask which of your own measurements the proposed
cause could not have produced.** A uniform additive term cannot raise the
notice's mean by 51 codes while *lowering* the shelving's by 12. Two mechanisms
remain — the reflection leaf washing a bright surface, and the pane at 82°
mirroring something bright over that part of the frame — and they are separable
only by an ablation, not by more staring. The finding was published with the
mechanism named as unresolved rather than with the plausible half asserted.

Related: the third item in the same report, a "smaller blank panel near the
bollard", measured **105 distinct codes** and is not blank at all. It is
low-contrast, which is a legibility complaint and a different repair from either
candidate cause. Three objects described identically by eye; three different
numbers.

## 78. A cache key containing the object's identity is correct, maximally pessimistic, and looks like neither

`applyWorldDetail` keyed its shader programs `wd:<materialName>:<flags>`. That is
correct: no material can ever be handed another's compiled program. It is also
the most expensive key expressible, because the material's *name* cannot affect a
single instruction — so eight materials got eight programs even though five of
them emit byte-identical source, on a project where the cold load is ~92% driver
link time.

The reason it survives review is that both failure directions look the same in
the source and neither shows up in the picture:

- **Key coarser than the source** — silent and serious. three hands the second
  material the first's program. No link error, no warning, no console output; the
  ground simply renders with another surface's arms.
- **Key finer than the source** — silent and merely expensive. A duplicate
  program, paid for once per material at load, invisible in every frame.

**A key may always be finer than the source requires; it may never be coarser.**
So the safe transformation is to key on the things that *determine* the emitted
source and nothing else — here the gate booleans plus the uniform declaration
block — and the safe test is not equality of keys but the one-sided invariant:
*same key with different source must fail; different key with same source is a
note.* The first version of that test asserted key equality and failed on the
harmless side, which is the shape of check that gets switched off.

Measuring it also refuted a bit that had been in the key since it was written:
`useAnti` distinguished programs whose source was identical, because the
anti-tile arm is always emitted and switched by a uniform *value*. Values are
free — they are not part of a program — so a flag that only changes a value has
no business in a cache key. That is worth checking for wherever
`customProgramCacheKey` is used: **the question is not "does this option change
the material", it is "does this option change a character of the source".**

### And the instrument that could not measure what it was built for

The same round added a timer for the thing the tier exists to cut — the
main-thread block that is the driver linking — and it reported 0.7 s, 0.7 s and
0.3 s across three arms, which reads as a clean win for the reduced arm.

It is cache order. All three arms ran in one browser process and therefore shared
one driver program cache: arm 1 paid the link cost and arms 2 and 3 were warm by
construction. **An A/B where B runs after A on shared warm state measures the
order, not the change** — and it will always favour whichever arm ran last, which
is usually the one being advocated for. The timer is kept, labelled, and
explicitly not quotable; a cold measurement needs one fresh process per arm.

## 88. A stance chosen by the person writing the test can only test what they were thinking about

Taking a bottle from the cooler was **impossible** — one of the three
interactions in the brief — and the interaction harness passed 91 of 91
assertions over it. Nearest-first picking meant the open cooler leaf, which
swings across the sight line and sits 0.62 m from the eye, always beat the shelf
behind it. Every attempt to take a drink shut the door instead.

The harness had a cooler test. It stood 0.95 m out from the leaf centre and
aimed at the leaf, and it was correct: it verified that the cooler opens, closes,
and says so. **It could never have found this, because the stance was picked to
look at the door.** The bug lives at the stance a player adopts *after* opening
it, which nobody writing a cooler test thinks to choose.

The general shape: a stance, pose, distance or heading chosen by hand encodes the
author's model of what the code does, so it tests that model rather than the
code. The fix is not a better-chosen stance, it is to stop choosing — enumerate
every position the collision field says a body fits in within reach, and assert
over all of them. That derivation is ten lines and it turns "I checked the
cooler" into "there is nowhere a player can stand and fail".

Two details that make the enumeration honest rather than decorative. **Derive per
state**, because a cooler leaf is a blocker that moves and the pocket in front of
a shut door is somewhere the open door sweeps through — one list reused for both
states tests the open door from places a player cannot be. And **keep the
counter-test**: before the cooler is opened the bottle must *not* win, or a
priority rule that fixed the taking would silently delete the opening by letting
the player reach through shut glass.

Also worth knowing before writing this kind of derivation: **`collision.field` is
published by `PlayerSystem.init()` after its `if (ctx.shot) return`**, so on any
`?shot=` capture page the service is simply absent. A spot-derivation written on
the capture page produces an empty list and every assertion over it passes.

## 89. A clamped `dt` turns a frame hitch into lost ground, in proportion to speed

Two runs measured sprint speed by ground displacement in the same build: 2.38 m/s
and 2.158 m/s, the second 9.3% short. The walk measured **exactly 1.400** in both.
A speed that is right at one target and 9.3% low at a higher one looks like an
acceleration or collision defect at the higher target, and it is neither.

`Game.frame` runs `const dt = Math.min(this.clock.getDelta(), 0.1)`. A frame that
takes 300 ms advances the simulation 100 ms, so the body covers 200 ms less ground
than wall clock says it should — and **the loss is `v` times the excess**, so the
identical stall costs a 2.38 m/s sprint exactly 1.7x what it costs a 1.4 m/s walk.
One 290 ms frame inside a 2 s window is the whole 9.3%. Whichever window the
hitching lands in reads short, and the other reads exact.

The clamp is right and must stay: unclamped, that same 300 ms frame advances the
body 0.71 m in one step against a 0.32 m collision radius, i.e. through a wall.

What this changes is measurement. Displacement over **wall clock** is what the
player feels and is the number to quote for feel; displacement over **simulated
time** is what the controller delivered and is the only one an assertion may use,
because otherwise a busy machine reports a working feature as broken (case 78).
Carry both, and report their difference as the clamp loss rather than absorbing it
into a tolerance — a tolerance wide enough for a contended run is also wide enough
to pass a real regression.

The same correction applies to anything integrated per frame. The jump apex read
311 mm on a contended machine and 297 mm on a clean one against an analytic
319 mm, and neither was wrong: semi-implicit Euler takes gravity off the velocity
before integrating position, losing about `JUMP_SPEED * dt / 2` — 21 mm at 60 Hz,
and 106 mm at the 100 ms clamp. **A fixed band wide enough to survive the worst
frame rate would also pass a hop that had lost a third of its height**, so the
expectation is computed from the frame time the arc was actually built out of.

## 90. A detector that cannot read its input should say UNKNOWN, not pick a branch

Built a pre-measurement check that answers "is the card clear of browsers". Two
failures in it inside ten minutes, both instructive, and the second nearly
destroyed a sibling's live run.

**First: the check that returns all-clear by failing to look.** `wmic` does not
exist on current Windows builds, so `wmic process where "name='chrome.exe'"` does
not report zero processes — it fails to execute and prints nothing, which is
indistinguishable from finding nothing. A harness reported clean shutdown and
left fifteen Chromium processes alive; a `wmic`-based verification would have
agreed with the harness. The fix is a **negative control inside the tool**: query
for a process known to be running (this very `node`) and refuse to report a clear
card if the control returns zero. A detector that has not been shown to detect is
not a detector.

**Second, and worse: a verdict manufactured out of unreadable data.**
`CreationDate` came back in a form `new Date()` could not parse, so ages were
`NaN`. `NaN` propagates silently through `Math.max`, and every comparison against
it is `false`, so `oldest - newest < 120` was `false` and the tool printed:

```
age: newest NaN s, oldest NaN s, spread NaN s
      wide spread -> more than one cohort; the older ones are probably leaked
```

**It had no data whatsoever and produced a confident, actionable, wrong verdict**
— and the action it recommended was killing eight processes that were a sibling's
measurement running normally. With the date parsed correctly the same eight read
`spread 0 s -> consistent with ONE live harness, not a leak`. The verdict was not
merely unreliable, it was **inverted**, because `NaN` fails the comparison that
would have produced the benign answer.

Two rules from it. **A missing input must produce UNKNOWN, never a default
branch** — same shape as a mean over zero pixels being NaN, and as the harness
that printed `?` for its only real column and reported PASS. And **the
consequential direction of a false verdict is worth checking explicitly**: this
one defaulted toward destructive action, which is the expensive way round.

Also worth keeping: **a process count cannot distinguish a leak from a live run.**
One Playwright Chromium is four to six processes, so eight alive is equally
consistent with one healthy harness and with two dead ones. Only start time
separates them, which is why the age column exists at all.

## 91. Key the program cache on the source, not on the material

A cache key exists to answer one question: **would these two materials compile
different GLSL?** Four of the six keyed sites in this repo answer a different
question — *are these two materials differently configured* — by interpolating a
caller-supplied `key: string` that identifies the configuration:

```
worldDetail.ts    wd:${opts.key}:${flagBits}      <- material NAME in the key
buildingWeather   bw:${opts.key}:${flagBits}
buildingCoursing  bc:${opts.key}
buildingGlazing   bgfres:${opts.key}
hardsurface       grime:${o.key}
```

Configuration identity is a **superset** of source identity, so this is always
safe and sometimes wasteful: every distinct configuration costs a program link
even when it emits byte-identical source. Measured in `worldDetail`, five of
eight materials emit identical GLSL and paid five links for one program's worth
of code — 6 of 193 programs at high tier, on a cold load where compilation is
~92% of a four-minute wait.

The generalisation, which is the useful half: **a value belongs in the cache key
if and only if it changes a character of the emitted source.** Anything reaching
the shader as a uniform *value* is free, no matter how visually significant it is.
`antiTile` had been in one key since it was written while the anti-tile arm is
always emitted and switched by a uniform — so it split byte-identical programs
for the lifetime of the file.

And the inverse error is far more expensive than this one, which is why the safe
direction is worth naming rather than assuming: a key that fails to distinguish
materials that *do* emit different source makes three hand the second material
the first one's compiled program, silently, with no link error — the ground
rendering with another surface's arms. **Over-splitting wastes seconds;
under-splitting produces a plausible wrong frame.** So collapsing a key is only
safe behind a standing byte-identity assertion, not behind a one-time
measurement.

**One live instance of the assertion being weaker than its docblock.** A
compile-adjacent linter carries the comment *"Asserted rather than described,
because if someone later makes the arm conditional this becomes the load-bearing
distinction and the note below turns into a lie"* — and the code beneath it never
touches its `fail` counter. It prints. Worse, its polarity is backwards for the
change being contemplated: it prints `ok` when the option **does** change the
source, which is the unsafe case once that option is dropped from the key. The
comment correctly identified the future hazard, named it, and then did not gate
it.

## 67. Reading position four of your own tool's output as a percentile

I quoted "interior p50 132.3 → 76.9" through a whole session of interior work, in a
handover other agents act on. `regionstat` prints
`mean, sd, meanR, meanG, meanB, R-B, min, max`, and position four is the mean of
the green channel. The real p50s were 136 → 64.

Nothing downstream broke, because the comparison was self-consistent — I was
reading the same wrong column on both sides, so the *direction* held and only the
labels were wrong. That is what made it survive: **a mislabelled statistic that is
consistently mislabelled still produces correct comparisons, so the error cannot be
caught by the numbers disagreeing with each other.**

It was caught by crossing tools. `probe-shelfshade` prints an actual percentile
ladder, and its p50 did not match the number I had been calling p50. Cross-tool
agreement is usually run as a check on the *measurement*; here it caught a defect in
the *reading*, which is the more common failure and the one nobody instruments for.

It also nearly cost a real corroboration. Film had independently reported an
exterior p50 of 82; my exterior "p50" of 91.6 looked like a 12% disagreement on a
different pose. On the correct statistic mine is 84, which is two levels from
Film's — agreement between two harnesses, which is worth more than either number
alone and would have been written off as noise.

**Print the header, or name the column in the call site.** A row of eight bare
floats invites this, and it invites it most from the person who wrote the tool.

## 92. "Repetitive" and "periodic" are different claims, and a tiling probe only tests the second

Film's playtest called the gravel verge in the spawn frame "high-frequency,
visibly repetitive, and it dominates the bottom third" — the largest and least
attractive thing in the first frame anyone records.

`tools/probe-period.mjs` says the region is **not periodic**: max r 0.235, and
the peak lag disagrees between every band (120, 150, 82, 25, 101, 27 px
horizontally) where a real repeat shows the same lag in all of them, as its own
selftest does at r 1.000 on a planted 23 px stripe.

Both are correct, because they are about different quantities. The verge is an
`InstancedMesh` of 24000 stones, and **every stone was the same stone at the
same tone.** A field of identical instances repeats in *identity* while having
no spatial period whatsoever — the instances are scattered at random positions,
so autocorrelation finds nothing, and there is genuinely nothing for it to find.

The mechanism is worth stating on its own, because it is a one-line mistake that
reads as correct and had a comment defending it:

```ts
// Per-vertex tone so a field of stones is not one colour at two sizes.
const sc = new Float32Array(stoneGeo.getAttribute("position").count * 3);
for (let i = 0; i < sc.length; i += 3) { const v = 0.72 + rng() * 0.5; ... }
stoneGeo.setAttribute("color", new THREE.BufferAttribute(sc, 3));
const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, 24000);
```

**A per-vertex attribute on shared geometry is a property of the object, not of
the field.** `InstancedMesh` shares one geometry across every instance, so those
twelve random vertex colours were drawn once and then reproduced 24000 times.
The randomness is real, it is just spent inside a single stone. Per-instance
variation needs `setColorAt`, which is a different API, and nothing warns you.

The comment is the part that made it survive. It named the exact failure it was
preventing — "not one colour at two sizes" — and it was true of the geometry and
false of the field. A comment asserting the property you want is not evidence
that the code delivers it, and it actively suppresses the question.

### Ask which axis the repetition is on before reaching for a probe

When an observer reports repetition, there are at least three different things
they can be seeing, and they need different instruments:

| percept | mechanism | what finds it |
| --- | --- | --- |
| repeats at a spacing | UV period, tiled map | autocorrelation sweep (`probe-period`) |
| every element looks like every other | shared geometry, shared tone, one mesh | read the scatter loop; count what varies per instance |
| everything is the same size | narrow-band field or narrow size distribution | percentile ratio of the feature scale |

Only the first is periodicity. This project has now been told "it repeats" three
times and found a different mechanism each time — aliasing in the near-field
carpet, a real fixed world period in the asphalt lattice that a badly-scoped
crop returned a confident null on, and now identity. **A critic reporting a
percept from a rendered frame is right that something is wrong and owes you no
mechanism**; treating their word as the diagnosis picks the instrument for them.

### Two hypotheses refuted by arithmetic, including the one I preferred

Worth recording because the refutations were cheap and both were wrong in an
instructive direction.

**Shadow dominance.** At a 6.2 deg sun a stone's shadow is 9.2x its protrusion,
so the obvious guess is that a scatter reads as its shadows. It does not: the
measured ratio is **1.6x and constant** across every percentile. A protrusion is
vertical and subtends its own angle unforeshortened, while the shadow lies along
the ground and is compressed by roughly sin(depression) — 0.45 at this pose — so
the 9.2x stretch and the foreshortening very nearly cancel. **A world-space
length and a screen-space length are not related by one factor when the two
features lie on different axes**, and a low sun puts them on different axes by
construction.

**Contrast.** The intuition for "high-frequency and dominates" is that the region
is too busy and too contrasty. It is the opposite: the verge is the **flattest**
region in the lower frame, p10-p90 luma spread 14 in the immediate foreground and
20 mid-band, against 34 on the forecourt and **42 on the dirt beyond the lot that
has no gravel on it at all.** Adding 24000 stones *reduced* the tonal variation of
the ground they covered, because at luma 128.3 against a soil of 125.2 they were
within 2.4% of their own background. **A dense scatter the same value as its
background is a low-pass filter on the region's appearance**: it adds spatial
frequency, subtracts nothing, and averages away whatever large-scale structure
the surface had. Busy and flat at the same time is a reachable state and it is
worse than either.

### Resolvability and spread are two properties, and one change moved only one

The same round widened the stone size distribution, 14-76 mm to 24-122 mm. That
raised the median stone from 3.9 to 7.2 screen pixels tall at the spawn pose,
which is resolvability — below about 4 px a 20-facet icosahedron shows three or
four facets at a pixel each and has no room for the lit facet that makes a lump
read as a lump, so it contributes a dot and aliases as the camera moves. Same
rule as `resolvableOctaves` on the dirt fbm, applied to geometry: **detail below
what the view can resolve does not become detail, it becomes noise.**

But the mark-scale spread went 4.9x to 4.5x — essentially unmoved. **Widening a
single population's range does not widen the perceived scale spread**, because
percentile ratios of a bounded distribution are stubborn; multi-scale needs a
second population at a different scale and a much lower density. Claiming the
size change fixed scale uniformity would have been the same error as claiming
the amplitude fixed the wavelength in the `hash1` case: two properties, one
measurement, and the one that moved is not the one that was wrong.

## An unquoted heredoc delimiter eats the code out of your prose

Appending a handover section with `cat >> file << EOF` rather than `<< 'EOF'`
truncated it. An unquoted delimiter leaves backtick and `$` expansion on, so a
document densely written in `` `identifiers` `` is parsed as command substitution.
Bash warned about an unterminated heredoc, wrote a partial file, and **exited 0**.

Third instance of one shape in this project, each in a different quoting context:

- backticks in a **GLSL comment** ended the JS template literal holding the shader;
- backticks in a **JS template literal** inside a shader-debug overlay, again;
- backticks in **shell heredoc prose** describing both of the above.

So the rule is not "watch out for backticks in GLSL". It is that **prose about code
carries code characters, and every quoting context treats some of them as
syntax.** Whenever documentation passes through a shell, quote the delimiter.

The reason it is worth a case rather than a shrug is the failure mode, not the
typo: a truncated document reads perfectly correct right up to the point where it
stops. There is no error marker in the artefact, the exit code is 0, and the part
that went missing is the part you wrote last — which is usually the conclusion.
**Check the tail of anything you append.**

## A gate that fires on the safe case is a gate someone switches off — and its polarity is worth checking twice

A cache-key check in `tools/shaderlint.mjs` tested whether `antiTile` changed the
emitted shader source. Its output:

| does it change the source? | risk after the key collapse | what the linter printed |
|---|---|---|
| no | safe | `note` |
| yes | **unsafe** | `ok` |

**The one state that was dangerous was the one labelled `ok`.** Both labels were
chosen while a coarser key made both states safe, and neither was revisited when
the key changed — so the check kept reporting, accurately, in a vocabulary that
had inverted underneath it.

Two separate defects are stacked here and they are worth separating.

**The polarity was backwards**, which is a one-character class of bug that no
amount of reading the *value* catches, because the value was right. Only reading
the value against the consequence catches it.

**And it printed rather than failed.** The docblock beside it named the hazard
exactly — "if someone later makes the anti-tile arm conditional this becomes the
load-bearing distinction and the note below turns into a lie" — and then did not
gate it. **A docblock that names a hazard is not a guard against it.** It is a
note to a reader who may not exist, in a file that may be edited by someone who
does not read it, and it converts a mechanical check into a human one.

The general form, and the reason it matters more than it looks: a check whose
output is a `note` costs nothing to ignore, so it will be ignored, and a check
that flags a *correct* state trains the reader to ignore the ones that matter.
**Every assertion should be asked which of its outcomes is meant to stop work.**
If the answer is "none of them", it is telemetry and should be labelled as such;
if the answer is "one of them", that one must be non-zero exit and not a word.

### And prove the gate can fail, by planting the defect it exists to catch

Both replacement gates were verified by planting their own failure. The sharper
of the two: a source dependence on the material's name, gated to the **default**
path only. The default-mode assertion failed and located the divergence; the
reduced-mode assertion reported `ok`. **The previous version of the linter, which
asserted only the reduced path, reported all green on that tree.**

That is the fourth instrument in this project whose result was predetermined by
construction — after a `FORCE` token that no-oped Node-side so its control arm
could not fail, `computeVertexNormals()` certifying whatever winding it was
given, and a `canReach` that snapped to the nearest reachable cell and could
never return false. The pattern is consistent enough to be a habit: **a new gate
is not known to work until it has been made to fail on purpose.** Green on first
run is the least informative outcome available.

### The asymmetry that makes this specific gate load-bearing

Worth recording because it generalises to any cache, memo, or dedup key:

- A key that is too **fine** compiles the same thing repeatedly. Costs seconds,
  has no other symptom, and is self-limiting.
- A key that is too **coarse** silently hands one consumer another's compiled
  artefact. No error, a plausible wrong result, and nothing able to attribute it.

So **a key may always be finer than what it identifies requires; it may never be
coarser** — and therefore **collapsing a key is only ever safe behind a standing
assertion, never behind a one-time measurement.** A measurement proves the tree
you measured. An assertion proves the tree someone edits next week. The two are
routinely confused because both produce a green line in a terminal.

## A surface invariant to every lighting lever is not lit, and that names the owner without naming the object

Follow-up to "A surface can lose its printed content to the viewing angle". Film
reported two large white rectangles in the shop interior. Three mechanisms were
in play, owned by two systems: Building's additive reflection leaf, Building's
Fresnel coupling, and Lighting's `scene.environmentIntensity` raised 1.0 -> 2.4,
which was the favoured candidate because Fresnel peaks at exactly the grazing
angle where the print dies.

Eight arms in one browser, on the region Film reported, at 82 deg:

| arm | rectangle | control (stock behind the same pane) |
| --- | --- | --- |
| shipped | mean 231.6, sd 1.36, **6 codes** | mean 82.0, 127 codes |
| reflection leaf x0 | 231.6, 1.36, 6 | 81.7, 127 |
| reflection leaf x4 | 231.6, 1.36, 6 | **94.8, 149** |
| environmentIntensity 0 | 231.6, 1.36, 6 | 83.8, 121 |
| environmentIntensity 1.0 | 231.6, 1.36, 6 | 83.9, 122 |
| environmentIntensity 4.8 | 231.6, 1.36, 6 | 83.7, 123 |
| Fresnel off (separate program, own load) | 231.6, 1.36, 6 | 83.0, 127 |

**Identical to four significant figures in all seven arms, while the control
moves.** The forced-high arm is what makes that readable: 4x on the reflection
leaf shifts the control by 12.8 mean and 22 codes, so the levers are wired and
reaching the frame. They do nothing to the rectangle.

And the rectangle is **bit-identical to the capture taken 40 minutes earlier**,
before Lighting's interior grade landed — so that grade did not touch this
region either, though it was reported as having moved it.

### The rule

**A surface that does not respond to any light in the scene is not being lit.**
That is a property of the material, and it is measurable without ever
identifying the object: no ablation of any *illumination* term can explain a
constant. So the question stops being "which light is too bright" and becomes
"which system ships an unlit material", which a grep answers in one command.
Building ships **zero** `MeshBasicMaterial`, which is enough to route it out of
this system without knowing what the object is.

Invariance across a **page reload with a different shader program** is the
strongest form of this, because it also rules out everything that could differ
between two compiles.

### And the retraction

The earlier disproof — "the map is bound, because the same object is printed at
65 deg" — was **wrong, and wrong in a way that had already been catalogued.** It
compared a box drawn on the 82 deg frame with a box drawn on the 65 deg frame and
assumed the two contained the same surface. Nothing had measured that. When the
region was finally derived from geometry instead of drawn by eye, the notice
projected to **33 x 195 px at a different part of the frame** than the 180 x 360
rectangle, so the two were never the same object and the missing-map branch had
been closed on no evidence.

This is the invariant trap from "Same number, opposite conclusion" for the second
time in one project: five numbers were collected and the quantity the assertion
was actually about — the identity of the surface — was not among them. **Derive
the measurement region from the object, not from the picture**, and a whole class
of confident false disproof becomes unavailable.

### Addendum: the rule above is one step too strong, and it is the last step that named the wrong system

Written by Vegetation, on CPU, after the routed card was declined. The table is
sound and the eight arms were run correctly. What does not follow is the last
sentence of "The rule".

Enumerate what the arms actually vary. The reflection leaf is an additive
specular term; the Fresnel coupling scales it; `scene.environmentIntensity`
scales the IBL. **All three are levers on *reflected* radiance.** None of them
appears in `totalEmissiveRadiance`, and none of them scales a `RectAreaLight`.
So the set the eight nulls select is not "surfaces that respond to no light" — it
is **"surfaces that are not reflection-driven"**, and in a room lit by six
`RectAreaLight` troffers plus emissive lamp faces those two sets are nothing
alike. The second one contains most of the shop.

The same correction applies to the third forwarded fact. Bit-identity across
Lighting's interior grade was read as evidence that the grade could not reach
the region. It is not evidence: `tuneInteriorMaterials` matches the lens meshes
in its **first** branch and `return`s before the `envMapIntensity` write, so a
grade that moves `interiorEnv` cannot touch a lens face *by construction*. A
guarantee in the code reads exactly like a null in the data, and only one of them
tells you anything about the object.

**The general form, and it is the cheap part.** Before concluding from a set of
nulls, write down the expression each arm actually multiplies. If every arm lands
in the same term of the shading sum, the nulls bound one term and say nothing
about the others — and "no lever moved it" is then a statement about the levers.
The tell here was available before the card was ever booked: **eight arms, three
distinct mechanisms, one term.** A control region that moves proves the levers
are wired; it does not widen what they cover.

What the arms could not see, and what a CPU reconstruction of the emissive path
predicts, is under "A modulation map authored above the tone curve's shoulder";
`?blens=0` — the control built for exactly this question — has still never been
run at 82 deg, and the closure of the missing-map branch retracted above has not
been reopened.

---

## A grep over source counts prose as evidence, and a comment explaining why something is *not* X matches every search for X

The suspect list for the two white rectangles was built by grepping for
`MeshBasicMaterial` across `src/`, and it named five vegetation files. **Three of
them construct none.** Every match in those three is a comment explaining why
the material is deliberately something else:

- `vegMat.ts`: *"which is the whole reason this is not `MeshBasicMaterial` like
  its sibling in `vegGround`"*
- `vegLitter.ts`: *"Not `MeshBasicMaterial` like the decal discs"*
- `vegHorizonBands.ts`: ships no material at all — only numbers — and mentions
  the type while describing what consumes them.

So the search returned the highest possible number of hits on the files that had
most carefully documented *not* doing the thing being searched for. The list was
then forwarded, twice, without anyone opening the files, and it aimed a card at
the system with the best comments rather than at the system with the material.

### Why this is worse than an ordinary false positive

A false positive you can see is cheap. This one is **anti-correlated with the
defect**: the density of the word `MeshBasicMaterial` in a file is driven by how
much its author thought about unlit materials, and an author who thought about
them and chose against them writes the word several times while shipping zero.
The ranking a grep produces is therefore close to the reverse of the ranking you
wanted. The same applies to `envMapIntensity`, `toneMapped`, `DoubleSide` and
every other term this project has a documented opinion about — which is most of
them, in a tree whose comments outweigh its code.

### What to do instead, and it is one flag

`rg -n --type ts 'new THREE\.MeshBasicMaterial'` — match the **construction**,
not the identifier. Where a type can also arrive by assignment or by clone, the
honest instrument is not a grep at all: it is a traversal of the built scene
reporting `material.type` per mesh, which is what `tools/lensregion.mjs` now
prints alongside the region. A claim about what a system *ships* is a claim about
the object graph, and the object graph is available.

### The corollary that costs the most

**A suspect list is evidence about whoever wrote it, until someone opens the
files.** Two agents and one coordinator passed this list along; the check that
refuted it was reading three files and took less time than the grep's output took
to read. Any list that arrives with a mechanism attached should have the mechanism
verified in the source before the card is booked, because the list is the cheapest
part of the round and the card is the most expensive.

---

## A value match is not an identification, and the cheap discriminator is angular size

Same round, and this one is against my own work. Told that a region measured
**mean 231.6, sd 1.36, 6 distinct luma codes, peak 234, nothing railed**, I
reconstructed the interior emissive path on CPU — the lens texture texel for
texel, the emissive colour and intensity Lighting sets, three's ACESFilmic fit at
the project's 1.25 exposure — and predicted that a *flat, unmapped* lens face
lands on **231-233 at a single intrinsic value**, while a live modulation map
leaves **17-38 codes of range** at any glass transmittance and therefore cannot
produce 6. The measurement fell inside the first prediction and outside the
second.

That was a correct piece of arithmetic and it identified the wrong object.

The lenses are horizontal downward-facing quads. Projected through the actual
82 deg camera they come out **140x9, 139x12 and 159x12 px** — the 1.22 m long
axis lands almost entirely as *width* and almost nothing as height. The rectangle
is about **165x340 px**, portrait. The nearest lens clips 5% of one edge of the
box and the other two miss it. An ablation bundle aimed at them would have
returned a clean null about a surface covering a twentieth of one edge of the
region.

### The rule

**A tone-curve reconstruction narrows *what kind of surface* it is, never *which*
surface.** Every flat, bright, unmapped surface in the scene goes through the
same curve and lands in the same few codes, so a value match has a large
equivalence class and says nothing about identity. What I proved was "flat,
bright, and not reflection-driven". I then attached the nearest object I could
think of that had those properties, which is the step with no evidence in it.

### The check that would have caught it, and it is arithmetic

**Before proposing an object, require it to subtend the region at its own
range.** One line of trigonometry, no card:

```
box height / viewport height * 2 * range * tan(fov / 2) = world height
```

At fov 52 vertical over 900 px, a 340 px box subtends 1.33 m at 3.6 m, 2.58 m at
7 m and 3.83 m at 10.4 m. Two consequences, and the first is the one I skipped:

- a 0.61 x 1.22 m panel can only fill 340 px if it is **within about 3.5 m and
  close to face-on**, and a ceiling panel seen from below at a grazing stance is
  neither. The candidate was excluded by its own dimensions before any capture.
- run the other way it bounds the search: the shop is 2.78 m floor to ceiling, so
  **an object that fits in the room and fills a 340 px box has to be nearer than
  7.5 m.** With the camera 3.6 m off the pane that is the front few metres of the
  interior or the aperture itself, not the back of the shop.

### And the corollary about the instrument

`probe-namepx.mjs` picks by **projected geometry AABB**, and its own comment says
that over-reports. In this tree that is not a small effect: `BuildingSystem`
batches geometry by material, so `ceiling-tiles`, `cmu-interior` and `product`
are each *one mesh* whose bounding box covers most of the frame. A single-pixel
AABB pick will therefore return most of the shop, ranked by a `near` that is the
nearest corner of a room-sized box rather than of the surface at that pixel.

The tighter estimator costs nothing extra in the same load: transform a strided
subset of each mesh's own `position` attribute by `matrixWorld`, project, and
count how many samples land **inside the box** — coverage rather than
containment, with per-sample depth so the ordering means something. It
under-reports thin geometry, which is the opposite error and the safe one when
the question is "which of these actually occupies the region". Both estimators
on the same load, disagreeing, is a stronger result than either alone; that is
the same argument that made two independent projectors agreeing on the hiring
notice to one pixel — 32x197 against 33x195 — the most trustworthy number
produced that day.

## A grep over a codebase counts prose as evidence, and a comment explaining why something is not X matches every search for X

Routing the white-rectangle defect, this file reported that five Vegetation files
ship unlit materials, on the strength of `grep -rln MeshBasicMaterial src/`.
**Three of the five construct none.** Every match in them was a comment saying
why the material is deliberately *not* unlit — `vegMat.ts` says so in as many
words, and `vegLitter.ts`'s match begins "Not `MeshBasicMaterial` like the decal
discs". The grep was right about the string and wrong about the code, and the
conclusion was forwarded to another system at full strength.

The failure is not carelessness about the tool; it is that **the tool answers a
question about text and the claim was about behaviour.** A well-commented
codebase makes this *worse*, because the better the prose, the more often a
concept is named in the places that consciously avoid it. A file that explains
its choice not to use X is exactly the file a search for X surfaces first.

### The rule

**Search source, not files.** `grep -n "new THREE.MeshBasicMaterial"` asks about
construction; `grep -l MeshBasicMaterial` asks about mention. Where the claim is
"this system ships an X", the evidence has to be a **constructor call**, and the
cheap way to get it is to strip comments first or to grep for the call form.

State the count, not the file list: "three constructor calls in two files" is
checkable, and "five files match" invites the reader to assume five owners.

### And the inference it was supporting was over-read too

Eight ablation arms had established that the surface was invariant to the
reflection leaf, to Fresnel and to `scene.environmentIntensity`. That was
published as "the surface is unlit". It is not: **every one of those levers acts
on *reflected* radiance.** None appears in `totalEmissiveRadiance`, and none
scales a `RectAreaLight`. In a lamp-lit room most of the light arrives by paths
none of those arms touched, so the nulls establish "not reflection-driven" and
stop there.

**An ablation bounds the mechanism to the terms the levers actually reach**, and
the write-up has to name that set. "Invariant to everything I tried" and
"invariant to light" differ by exactly the terms you did not have a lever for,
and only the first one is a measurement.

## A probe written against the dev environment fails in a way that looks like the scene being wrong

`probe-namepx.mjs` was written to raycast through a pixel and name the object
under it. It used `new THREE.Raycaster()`, which works in dev and is **absent
from a production build**: nothing puts `THREE` on `window`, so the probe died
with `Cannot read properties of undefined (reading 'Raycaster')` — after paying a
full page load, which on this machine is most of a scheduled card slot.

The trap is the failure's shape. It arrives as a `TypeError` from inside
`page.evaluate`, at the moment the probe touches the scene, in a session whose
only other output was the GPU banner. That reads as **the scene failing to expose
what the probe expected**, which is one keystroke from "the system under test is
broken" — and it costs a page load per hypothesis to find out otherwise. The
adjacent case, "A timeout shorter than the phenomenon reports a healthy system as
broken", has the same signature from a different cause.

### The rule

**A probe may only depend on what the shipped bundle exposes.** The service
registry, `game.scene`, `game.camera` and the DOM are contracts; a library global
is an artefact of the dev server. Where a probe needs library maths, write the
maths: projecting a mesh's bounding box needs `matrixWorldInverse` and
`projectionMatrix`, both of which are on the camera in any build, and sixteen
multiplies applied by hand.

The substitute is also the better instrument here. A `Raycaster` returns the
first triangle hit; a projected AABB returns **every** mesh whose extent covers
the pixel, nearest first, which is what a question about a surface behind a pane
of glass actually needs. And it can be validated on CPU: the same arithmetic in
Node, over the same plan constants, agreed with the in-browser version to **one
pixel** on the same object.

### Cheap check before spending a load

Assert the dependency in the first `evaluate` and fail with the reason, not the
symptom. One round trip against `typeof THREE` would have turned a wasted load
into a line of output.

## Case 88 — The safe direction is where the answer was hiding

**The white rectangle in the shop window was a four-vertex quad, and the picking
method that was supposed to be conservative could not see it at all.**

`probe-namepx.mjs` picks by projecting a mesh's bounding box and asking whether
it contains the pixel. `BuildingSystem` batches by material, so `ceiling-tiles`,
`cmu-interior` and `product` are each **one mesh whose box covers most of the
frame** — ranking those by depth returns the nearest corner of a room-sized box,
which is a fact about the batching and not about the pixel.

The fix was to add a second column: walk the `position` attribute on a stride,
project each vertex, and count how many land inside a small box around the pixel,
recording the nearest depth among those. That is a statement about the surface at
the pixel. It **under-reports thin and sparse geometry**, and that was chosen
deliberately as the safe direction — a thin surface wrongly demoted is
recoverable, a room-sized box wrongly promoted sends the next person after the
wrong object.

### What actually happened

The coverage column, at the target pixel, returned exactly one mesh: a tree
**33.27 m away**, whose implied height was 12.26 m in a room 2.78 m tall. Every
plausible interior candidate scored zero. Read alone, that column says the
rectangle is not an object standing in the room.

The object was in the other column. A **four-vertex quad has no interior
vertices**, so no matter how much of the pixel's neighbourhood it covers, none of
its four corners will land within 24 px of the centre. Coverage-by-vertex-sample
is structurally blind to exactly the geometry class that a flat blank rectangle
belongs to. It appeared only as a bounding-box hit, unnamed, unmapped,
`#d9d4c4`, projecting 156×392 px at 0.70 m.

### The rule

**Report both columns and neither wins by default.** The under-reporting
direction being "safe" is a claim about the cost of each error, not about which
answer is right — and a method's blind spot is defined by geometry, so it is
worth asking in advance which shapes it cannot see. Here the blind spot and the
target were the same shape.

The discriminator that closed it was arithmetic, not another load. A 340 px box
at fov 52 over 900 px subtends `340 / 900 × 2 × range × tan(26°)`, which is
0.258 m at 0.70 m. The candidate quad is authored **0.29 m** tall. The implied
height at the candidate's own depth matching its authored height is a much
stronger identification than any property from the reconstruction, because
angular size is one number that both the picture and the source code have to
agree on.

## Case 89 — Piping a probe through `tail` throws away the first ask

The run above cost a full page load, printed five asks, and was piped through
`tail -60`. **The target pixel was the first ask**, so the only block that
mattered was the one discarded, and the terminal log had already rolled. The
answer existed and was destroyed in the same command that displayed it.

Recovery was cheap only by luck: `--no-build` against the surviving
`.shot-build` directory meant a page load rather than a rebuild.

### The rule

**Redirect a probe to a file, then read the file.** `> tmp/run.log 2>&1` costs
nothing and cannot truncate the interesting end. Reach for `tail` on a file that
is already on disk, never on a pipe from something expensive. If a probe's output
is worth a GPU load, it is worth a path.

## 92. A control that runs during warm-up measures warm-up

The parked control exists to separate "this scene is expensive" from "this host is
busy": hold the camera still and the frame cost should be a floor. Earlier tonight
it produced an inversion nobody could explain — an identical static frame costing
more than a moving camera, parked mean worse than walking steady state — and that
observation was strong enough to retire every tail figure measured on this project.

The mechanism is the control's **position in the run**. It executes from 5 s to
121 s, and the walk's own analysis discards everything before 60 s as
unrepresentative warm-up. So the control sat almost entirely inside the window the
analysis excludes, and was then compared against the filtered walk. Texture bytes
were still falling at t=51 s, mid-control, which is direct evidence the scene had
not settled.

The confirmation is that the parked pose came out more expensive than **every**
walking phase, including the cooler poses that dominate the route — and 2.5x more
expensive than *walking the same forecourt the camera was parked on*. Same
geometry, same view region, same everything except when.

Three things generalise:

- **A control must share conditions with the thing it controls, and time is a
  condition.** Ordering was treated as an implementation detail because the control
  is conceptually independent of the route. It is not independent of the clock.
- **The inversion was read as a finding about the scene for hours.** It was
  genuinely useful — it correctly invalidated a pile of tail figures — while being
  the wrong explanation. A control that is broken in the direction of *more*
  suspicion is much harder to catch than one that flatters, because its output
  looks like rigour.
- **Fix the experiment, not the threshold.** Moving the control after the walk
  costs nothing and changes no gate. Adjusting the threshold instead would have
  made the run pass, which is exactly why it is the wrong repair.

## 93. Express a metric in units the reader has intuitions about, and it audits itself

A metric was added to price what the 100 ms simulation clamp costs a player: every
frame past the clamp advances the world less than wall clock, so the body covers
`v * excess` less ground.

The first version summed every over-clamp delta. It reported **198,992 ms of lost
simulation** off a "worst frame" of **148,443 ms**, which it then priced as **278
metres of ground not covered.**

`198,992 ms` is a number that slides past. **278 metres in a 60-metre forecourt is
impossible on its face**, and that is the only reason the bug was caught before it
was published. The derived, physical, bounded-by-the-world quantity audited the raw
one.

The bug itself is worth knowing: deltas of 148 seconds are not slow frames, they
are the frame loop **not being driven at all** — init, a background tab, or a
harness blocking the main thread for a long `evaluate`. Pricing those as lost
player motion is a category error. Fixed by counting deltas over 1 s separately as
stalls and never pricing them, and by resetting the counters at the start of the
phase of interest so init is excluded rather than averaged in. The corrected run
reports 3 clamped frames, 125.7 ms lost, and **17.6 cm walking / 29.9 cm
sprinting** — a fifth of a step over twenty minutes.

So: where a counter can be converted into a distance, a duration a human can
picture, or a fraction of something with a known size, report the conversion
too. It costs one line and it is the cheapest self-check available.

## 94. A flattering number from a void run is the most dangerous artefact available

The exclusive quiet-host window produced the best frame numbers this project has
measured — steady-state mean 7.32 ms, median 5.4 ms, 3 frames over 100 ms in
140,077 — **and the run was void on 4 of 5 integrity conditions.**

The temptation is not subtle: the conditions that fired were about VRAM accounting
and about a control, none of them obviously about frame time, and the frame numbers
were exactly what everyone wanted to hear after a day of work. Every ingredient for
publishing a number that later has to be withdrawn was present, including a
sincere argument that the failures were unrelated to the measurement.

The reason to hold is that **the argument for "unrelated" is only available after
seeing the result.** Had the numbers come back poor, the same four conditions would
have been reported as reasons to discard them. A gate whose applicability is
decided by whether you like the output is not a gate.

What is legitimate is separating claims by what the failed conditions can touch.
Absolute stability facts (frames rendered, counters flat, no context loss) and
ratios (phase A versus phase B in the same run) survive; anything whose magnitude
depends on the host not being busy does not. Publishing the survivors and
explicitly refusing the rest is a different act from publishing the lot with a
caveat attached.

## Verifying that an object has a defect is not verifying that the object is in the frame

A critic named a region: the gravel verge in the bottom third of the spawn frame,
"high-frequency, visibly repetitive", the worst thing in the first frame anyone
records.

Everything measured about that region was correct, and all of it reproduced on a
second bundle three hours later. It is not periodic — max r 0.235 with the peak
lag disagreeing in every band. It is the flattest region in the lower frame,
p10-p90 spread 14 against 42 on gravel-free dirt. The texture over it is
magnified 2.0x at the bottom frame row.

Then a real defect turned up in the gravel scatter: 24000 `InstancedMesh`
instances sharing one geometry, so the per-vertex colour array written onto it
gave every stone the identical tone, 2.4% from its own background, with no
`setColorAt` anywhere in the file. Real, worth fixing, fixed — and measured
afterwards at 1.77x brighter and 0.43x darker on the pixels it owns.

**The gravel is not in that region.** Capturing the fix against a forced-off arm
with twice the stone count moved **0 of 50000 pixels** in the band under
complaint, and 2345 in the whole frame. The dark blobs in a 2x crop that I called
stones are dirt.

### The shape of the error

There were two claims and only one was ever tested.

1. *This object has a defect.* Tested exhaustively — the shared geometry, the
   luma against the background, the missing API, a repo-wide audit of nine other
   instanced meshes.
2. *This object causes that percept.* *Never tested at all.* It entered as a
   glance at a crop and was thereafter treated as established.

Every subsequent measurement was consistent with the diagnosis because none of
them examined the link. Consistency with a hypothesis is cheap when the
measurements are all on one side of it.

This is the inverse of the confident null. There the instrument was dominated by
a signal it was not measuring and reported nothing where something was. Here the
instrument reported something real, correctly, about an object that does not
appear in the frame that prompted the question. **A correct finding about the
wrong object is more durable than a wrong finding, because everything you check
about it confirms it.**

### The check that catches it, and it is one line

**Require the arm to move its own region.** Not "does the feature work" and not
"did anything change" — did *this* change move *the pixels under complaint*. It
is the same rule that catches a control that cannot fail, applied to the feature
instead of the control, and it costs nothing once every change already ships with
a forced-off arm.

Here the judge had it. It reported the tone result and still exited 1, because
the target region had not moved. Had it printed the 1.77x and stopped, the round
would have shipped as a success: a genuine measured improvement, a real bug
fixed, and the reported complaint untouched.

Note the near miss in the failure branch. The prediction was written with one:
"if the spread does not move, check `setColorAt` rather than the palette." The
spread did not move and **`setColorAt` was fine**. A pre-registered failure branch
is still a guess about the mechanism, and guessing the failure mode narrows the
search exactly as much as guessing the success mode does. It is worth writing —
it forced the tone arm to be captured, which is what proved the fix works — but
it is not a diagnosis, and a branch that names one cause will be read as
excluding others.

## The literal reading of an instruction can measure worse than its intent

I was told to loosen a scatter's gate "so candidates can land in open dirt rather
than only within ~1.5 m of a pavement edge". Implementing exactly that — floor
the acceptance for open-ground candidates only — put **0.37 stones/m2 in the
target band, below the 0.44 it was meant to improve.** Flooring every branch put
1.59.

The reason is that the band was not open dirt. It unprojects to z 5.55-7.5
against a road edge at z 5.16, so it is a road verge 0.4-2.3 m out from pavement
— inside the very "within 1.5 m of a pavement edge" the instruction contrasted it
with. 5.25 of its 5.88 stones come from the road-edge branch. The branch the
instruction told me to stop favouring was the branch that serves the region the
instruction told me to fix.

The general form: **an instruction names a mechanism and a goal, and when they
disagree the mechanism is the guess and the goal is the requirement.** A brief is
written from the same incomplete model you are about to correct — that is why you
were asked to measure. Implement the goal, measure both readings, and report the
disagreement rather than silently picking one. Had I shipped the literal version
it would have measured as a regression and read as "the fix did not work", which
is a much harder failure to unpick than "the fix was aimed wrong".

## An instrument returning exactly zero in every arm has not measured zero

A placement simulation returned 0 stones in the target region for all seven arms,
including one deliberately loosened to the point of absurdity. Seven zeros where
the expectation was ~0.8 each is a 0.4% coincidence, which is the tell. The cause
was an LCG whose multiply exceeded 2^53 before the mask, so floating-point
precision loss degenerated the stream.

**A constant result across arms designed to differ is evidence about the
instrument, not about the world.** The check that catches it costs one line: a
control region where the answer is known to be non-zero. Mine now carries three.
This is the fifth instrument on this project whose output was fixed by
construction, after `computeVertexNormals()` certifying any winding, `canReach`
snapping to the nearest reachable cell, a forced-off arm reading only
`location.search`, and a parked frametime control sampling only warm-up.

## A selftest standing in for a distribution needs that distribution's shape

A judge's selftest planted stone pixels into a synthetic band and required the
p10-p90 spread to rise. It failed on correct code, twice. The synthetic base was
uniform 40-50 (spread 8) standing in for a real band at p10 23 / p50 29 / p90 37
(spread 13.7), and the same planted coverage moves those two distributions'
percentiles by quite different amounts.

Worse, the first version planted 2.9% coverage and demanded a rise that the
tool's own calibration table says does not occur below about 4%. **The selftest
was asserting something the prediction did not claim.** Both halves are the same
error: a synthetic stand-in inherits none of the real signal's statistics unless
you give them to it, and a threshold copied from intuition rather than from the
calibration is a second, unmeasured prediction hiding inside the instrument.

Fixing it was worth more than the time it cost, because it also corrected the
prediction: the calibration showed the expected spread rise was 15.5-19.0, not
the 17-21 I had written down and nothing like the 25-34 predicted a round earlier.

## Case 90 — A probe that prints `NaN` and keeps going spends the load anyway

The verification probe for the door notices found both meshes, read their
materials correctly, confirmed the atlas cells, then projected every bounding box
to `NaNxNaN` and reported **"FAIL: neither door notice produced a measurable
region"** — a sentence about the scene, produced by a fault in the probe.

The fault was one dropped argument. The projection helper takes a homogeneous
coordinate, `mul(e, x, y, z, w)`, and the call site inlined three ternaries for
the box corners and lost the trailing `, 1`. `undefined` propagates silently
through sixteen multiplies and comes out the far end as `NaN`, which compares
false against every bound, so the containment tests said "not on screen" and the
region tests said "too small to measure". **Every downstream check failed in a
way that reads as a finding.**

### The rule

**A non-finite intermediate is an instrument fault and can never be a finding,
so assert it before measuring anything.** One `Number.isFinite` sweep over the
projected boxes, failing with "this is a fault in this probe, not in the scene",
turns a wasted load into a line of output — the same shape as asserting a
dependency before spending the load, applied to the arithmetic rather than the
environment.

The cheaper half is free and should come first. **The same projection done on
CPU from the plan constants needs no card at all.** Run afterwards, it predicted
both boxes to within four pixels of what the GPU had measured for the quads they
replaced, which is the check that would have caught the `NaN` before the browser
was ever launched. A probe whose maths can be validated without the scarce
resource should be validated without it.

## A simulation that omits one guard is exact about a region the code never reaches

A placement simulation predicted 5.88 stones in a target band. The render put
zero there, and the arms were provably different — 46,847 acceptance tries
against 85,165. The replica modelled two spatial branches and a probabilistic
gate correctly enough to reproduce branch attribution and floor sensitivity
across eight seeds. It omitted the `pavedDistance(x, z) < 0.12` guard sitting
above all of it, and the band was 100% inside that exclusion because it is a
paved driveway apron.

**Everything the simulation said was true of the model and irrelevant to the
band**, and nothing downstream could reveal that, because the simulation and the
prediction and the judge all inherited the same missing line. The calibration
curve was good, the attribution table was right, the seeds were swept — rigour
applied to a region the real code discards at the top of the loop.

The general form: **a simulation of your own code is only as good as its most
silently-omitted early return.** Every other kind of modelling error shows up as
a number that looks wrong. An omitted guard shows up as a number that looks
right, because the model reproduces everything downstream of it perfectly — the
distributions, the sensitivities, the seed sweep — and the guard is the one line
whose absence cannot be detected by any of them.

The check that catches it is cheap and I did not do it: **before simulating
placement in a region, evaluate the real code's early-out predicates at that
region.** A replica should start from the guards, not the distributions, because
a guard turns a region off entirely while a distribution only makes it rarer, and
only one of those is visible in an expected count.

This is the same shape as the previous round's failure one level up. Then it was
a correct measurement of an object that was not in the frame; now it is a correct
model of a region the code excludes. Both times the instrument agreed with itself
all the way down.

## A judge's regions can be right about their pixels and wrong about the frame

Five fixed boxes reported 0.00% changed pixels between two arms, which read as
"the change did nothing". A whole-frame diff at 50 px blocks found 5,377 changed
pixels — the change had worked, in a region none of the five boxes covered.

Fixed boxes are the correct answer to a different failure (hand-picking a
flattering region after the fact), and they were adopted here for that reason.
But a box set chosen from a hypothesis inherits the hypothesis: when the
hypothesis about *where* the feature lives is wrong, every box reports honestly
and the ensemble misleads. **Whole-frame first to find where the change landed,
fixed boxes second to judge it** — the sweep costs a second and it is the only
step that can tell you your regions are in the wrong place.

## Case 91 — The angular-size number that excluded the wrong object confirmed the right one

Worth recording as an outcome rather than a lesson, because the discriminator
earned it twice.

`box height / viewport height × 2 × range × tan(fov/2)` was introduced to
*exclude* a candidate: a troffer that matched on "flat, bright, not
reflection-driven" could not also match on angular size, so the value match was
not an identification. The same line then **confirmed** the real object — a quad
authored 0.29 m tall, projecting 392 px at 0.70 m, where the formula says 0.297 m
— and did it from the source code and the picture independently, with no load
required.

**A discriminator that can only reject is worth less than one that can also
confirm.** Angular size does both because it is a single number that the
geometry, the projection and the photograph all have to agree on, and it is
computable on CPU from constants. Reach for it before reaching for the card.

The confirmation held to the end: the fixed object measured 160×393 at 0.70 m
against a CPU prediction of 152×379, and the pixel under investigation fell
inside the measured box once the 0.04 rad tape-skew the CPU model omitted was
accounted for.

## The speckled grey mid-distance is not the leaves, it is the sky between them

An appearance complaint restated as a coverage failure, which is the move that
also solved the gravel, the notices and the treeline.

Alpha-tested foliage minifies badly in a way that has nothing to do with colour.
A card five pixels tall samples a mip level where its whole atlas cell has
collapsed to a handful of texels, so the needle gaps, the chewed margin and the
alpha-zero corners are all averaged into mid-range alpha. Every one of those
values is *below* the alpha test, so the card is eroded from **every edge at
once** — and what shows through the resulting gap between each card and the card
it should be touching is whatever is behind the crown. At a 6.2 degree sun that
is bright sky. Repeated across a few thousand cards, the pale speckle in the
middle of the frame is not foliage that has gone grey; it is background leaking
through holes that alpha averaging opened.

The diagnostic value is that it changes what a fix is allowed to be. Darkening
the crowns, greening them or reaching for their albedo cannot close a hole, and
four rounds spent on a colour that was never wrong is the standard outcome of
reading this as an appearance problem. The fix is to *dilate* alpha with the
mip footprint so small cards merge into one larger silhouette — which is what
real foliage does at that distance anyway — and to hold the ramp at the identity
in the near field so the foreground provably cannot move.

Measured here at 5.00% of the frame moving by more than three codes with the
wind held at zero, and a row profile across the knee-height pose that runs 0% in
the top two bands, 18% at mid distance and 0.94% in the bottom band. The shape
of that profile is the claim: the effect appears where things minify and nowhere
else.

The general form: **when a surface reads as noisy, ask what is behind it before
asking what colour it is.** A speckle whose brightness matches the background is
a coverage failure wearing an appearance failure's clothes.

## An attribute means what the geometry it is on cannot contradict

From `c:\Code\jungle-trail`, and it is a principle rather than a trick.

That project packs one `vec2` per vertex called `aSurf`. On wood, `y` is signed
moss — positive is living moss on the bark, negative is heartwood where the bark
has rotted off. On leaves the same slot is a per-leaf random that selects one of
three undersides. The justification is exact: **a leaf never has moss on it and
a trunk never has an abaxial surface, so the two meanings cannot collide.**

The alternative it rejects is the one that looks more disciplined — a fifth
per-vertex float, holding one number per leaf, on every leaf in a forest. That
is described as the most expensive possible way to say it, and the arithmetic is
not close.

The rule that generalises: an attribute slot is safe to overload when the
*geometry* makes the two uses disjoint, not when the code currently happens to
keep them apart. The first is a property nobody can break by editing a shader;
the second is a comment. Ask what object the vertex belongs to, and if no object
of that kind can ever want both meanings, the slot is one slot.

## Prove a pass is useless by measurement before deleting it

Also from `c:\Code\jungle-trail`, and it is the only defensible way to remove a
rendering pass.

Three storeys of canopy patches were being rendered into the shadow map. The
argument for taking them out could have been made from cost — the roof was the
heaviest thing in the depth pass — and that argument would have been an
optimisation dressed as a correction. What was done instead was a measurement:
with the hemisphere fill, the environment and the leaf transmission all set to
zero and the sun at nearly double strength, the forest floor rendered
**completely black, with no lit pixel anywhere in frame.**

That single number converts the change from a trade to a deletion. The pass was
spending most of its resolution and most of its fill rate to produce a constant,
and the constant it produced was the reason the frame had no direct light in it
anywhere. Nothing is lost by removing a pass whose output has been shown to be
constant, and the replacement — an analytic transmittance with a penumbra that
widens with distance to the occluder — could then be judged on whether it looked
right rather than on whether it was cheaper.

The inverse is the failure mode: a pass removed because it was expensive, with
its visual contribution assumed rather than measured, and the loss discovered
three rounds later in a critique. **Cost justifies looking; only a measurement
of the output justifies deleting.**

## A "bit-identical" prediction needs the determinism floor measured first, and the floor is a peak

Registered before a capture: two null frames must differ by exactly zero pixels.
They differed by 43 and 74, at a peak of **1 code**.

The instinct at that point is to soften the threshold, and the instinct is
wrong — a threshold chosen after seeing the number is not a prediction. What is
right is to find out what the achievable floor is, by adding an arm that is
byte-for-byte identical to an existing one and diffing the two.

**Zero is not the null hypothesis on a GPU.** A real-time renderer reproduces
itself to about one code, so any prediction phrased as "identical" is really a
prediction about a floor nobody has measured. The floor arm is cheap insurance
that has to be registered *with* the predictions, because adding it afterwards
is indistinguishable from moving the goalposts.

**And the floor has to be a peak, not a count.** The first correction here was
to gate on the identical pair's pixel count, which failed on the next run for a
reason worth keeping: across three runs of the same bundle, two byte-identical
loads gave **84, 19 and 13** differing pixels — always at peak exactly 1. The
count in that regime is not reproducible and a count-based bar flaps; the peak
is reproducible and is also the *stricter* statistic for what a null test is
actually looking for. The failure being guarded against — a silhouette
divergence between the beauty and shadow passes — moves needle-edge pixels by
tens of codes against a bright sky, so a peak bar catches a single mismatched
pixel where an 84-pixel count bar would absorb dozens of them.

Changing a criterion after seeing data is the thing this note opens by warning
about, so the distinction has to be stated: the count was not loosened to make a
number pass, it was **replaced by a statistic shown to be reproducible**, and
the replacement is tighter on the defect it exists to find. Keep printing the
count anyway — a null pair that suddenly moved ten thousand pixels at peak 1
would be worth knowing about even though every one of them is invisible.

The separation this bought, for scale: null pairs sit at tens of pixels and peak
1, while the arms they are compared against sit at 128,000 pixels and peak 172.
Three orders of magnitude in count and two in amplitude.

## `onBeforeCompile` is a property, so a second feature assigns over the first

Three shader features now inject into the foliage materials — transmission,
vertex wind and minification damping — and the natural way to add the second and
third is a second and third `mat.onBeforeCompile = ...`. That silently deletes
the earlier one. The material still compiles, still renders, and quietly loses
the single largest visual feature in the vegetation, which is the failure this
project keeps meeting under different names.

The fix is not care, it is structure: **one function in one file assigns
`onBeforeCompile`, and every term is a branch inside it.** Composition then
cannot be forgotten, because there is nowhere else to put it. Two corollaries
fell out of doing it:

- Terms that both patch the *same* chunk have to be composed by hand rather than
  chained. The wind replaces `<worldpos_vertex>` outright, so the transmission's
  append to that chunk has no needle left to find, and the composed version
  writes its varying from the wind's already-displaced world position — which is
  also the more correct value.
- The cache key has to name **which terms are present**, because that is what
  changes the text. It must still not name their parameters. Amplitude, reach,
  direction, atlas size, wrap, strength and falloff are all uniforms, and a
  uniform never changes the source handed to `compile`.

The same hazard has now bitten three files here. It is worth grepping for two
assignments to the same `onBeforeCompile` before believing any shader term is
merely too weak.

## A harness that spawns through a shell has not killed what it started

The teardown contract in this repo says the preview server and the browser are
registered with one shutdown routine wired to every exit path. A new harness
obeyed it exactly and still left a listener on its port, twice.

`spawn(cmd, args, { shell: true })` returns the **shell's** handle, not the
child's. `server.kill()` signals the shell; `vite preview` under it survives,
keeps the port, and the next run fails with `EADDRINUSE` after burning its full
sixty-second readiness budget. On Windows the fix is `taskkill /PID <pid> /T /F`
alongside the `kill()`, and a short await before `process.exit` so the tree has
unwound before the process image goes.

Two smaller things learned in the same half hour. A port can be free of
listeners and still refuse `--strictPort`, because half a dozen sockets are
sitting in `TIME_WAIT` on it; moving to a fresh port is correct and dropping
`--strictPort` is not, since a harness that silently relocates is a harness
whose captures came from somewhere nobody checked. And a readiness wait should
fail *immediately* on `EADDRINUSE` in the child's stderr rather than timing out,
because sixty seconds of silence reads as "slow" and sends you looking in the
wrong place.

Recorded alongside the two existing backtick-in-a-template-literal entries for
the same underlying reason: this one is the shell's turn. A heredoc carrying
prose about `taskkill /PID <pid> /T /F` truncated mid-sentence and appended a
half-written section, which is the **fourth** occurrence of prose about code
carrying characters the surrounding language reserves. Write documentation with
a file-writing tool, not by piping text through a shell.

## A statistic that cannot discriminate between the hypotheses in play is not evidence

I claimed a surface was asphalt because its p50 luma was 29 and the forecourt
asphalt's was 28. The two hypotheses in play were "warm dirt" and "grey asphalt",
and **luma is precisely the quantity that cannot separate warm dirt from grey
asphalt at equal brightness.** One line of chroma settled it the other way: the
band measures R-B 18.8 against dirt at 19.0 and road asphalt at -2.4.

The part worth keeping is why it survived. **I had an 8x crop and the chroma
available when I made the claim and used neither, because the luma number agreed
with the story I already had.** A close match on an uninformative statistic feels
like confirmation and carries none, and it is more dangerous than no evidence
because it ends the enquiry.

The test before quoting a number: **name the two hypotheses, then ask whether
this statistic would differ between them.** If it would not, it is not evidence
however closely it matches. Brightness cannot identify a material, a triangle
count cannot identify draw cost, and an amplitude cannot identify a wavelength —
all three have produced a confident wrong answer on this project.

## An identity claim needs a noise floor before it needs a threshold

I predicted that a distance-guarded feature would leave the far field
bit-identical, and set the acceptance threshold at exactly zero changed pixels.
The measurement came back at 0.208% with a largest delta of 165 and the judge
failed the round.

The feature was not leaking. **The renderer is not bit-reproducible across page
loads** — wind-animated foliage moves, its shadows move with it, and even the sky
shifted by 5 levels, which no change to a ground material's normal can cause. The
threshold was unachievable by anything, so the test could only ever fail.

**A zero-difference threshold is a claim about the instrument as much as about
the code, and it needs its own control**: capture the same arm twice and measure
what "nothing changed" actually looks like. That noise floor is as necessary as
the forced-off arm. The forced-off arm establishes what the feature does; the
identical pair establishes what not-doing-anything looks like, and without it a
null result and a broken test are the same number.

The evidence still pointed the right way — the large deltas were all on foliage,
and the quietest ground in the frame was the one surface with nothing growing
above it — but that was inference standing where a control should be. So the
control was run: a bundle with two byte-identical arms.

**The floor is not zero and it is not even stable.** Over rows 0-599, three
pairs in which a far-field change was impossible by construction measured
0.025%, 0.078% and 0.082% changed, with peak deltas of 159, 159 and 164 — against
the feature run's 0.208% and 165. On the strictest any-delta form the identical
pair reaches 0.92%. The count varies by an order of magnitude between pairs where
nothing differs at all, because it is driven by which phase the wind was on when
the frame was grabbed. **The peak delta, by contrast, is flat across every pair
including the identical one**, which is what makes it the usable statistic.

Two things this changes about how the claim should have been written. The
whole-frame pixel count was retired as a gate and kept only as context printed
beside its measured floor, because a number whose floor moves 8x cannot carry a
threshold. And the surfaces that *are* deterministic — Film's band measures
0.00% between identical builds, so the ground reproduces exactly even though the
frame does not — became the place the identity claim is actually tested.

**Even those needed their floor measured rather than assumed.** Setting the
reference tolerance to zero because zero is the tidy number would have repeated
the original error one level down: one reference box came out at peak 0 between
identical builds and the other at peak 2. The tolerance is 2 because 2 is what
was measured, and it is not permissive — a guard genuinely reaching past the fade
produces the mean|d| 12.6 the band shows, six times that.

**Cross-reference: Vegetation reached the same wall this afternoon from the plant
side and settled on peak-delta over pixel-count for exactly this reason.** Two
independent discoveries of one fact about this renderer, and they should be read
as one finding. Anyone writing an identity gate here should start from
peak-delta against a measured floor, not from a pixel count against zero.

## An instrument that reports a fault on an impossible case is finished, not tunable

Chasing the floor above, I built a tool on what still looks like a good idea:
two captures of one build partition the frame into pixels that reproduce and
pixels that do not, so mask to the first set and a zero threshold becomes honest.
Its selftest passed, including a planted leak it correctly caught and a planted
animated-only change it correctly ignored.

Then I ran it on two byte-identical builds, where a leak is impossible, and it
reported a leak: 0.92% of the deterministic set, peak 159. **A mask built from
two samples cannot identify a pixel that flickers, because a flickering pixel has
a fair chance of agreeing across any two draws** and then disagreeing with a
third. The partition was the whole idea and the partition does not work at two
samples.

I deleted it rather than raise its threshold. **A tool that fires on a case where
the fault cannot exist has no working range to tune into** — every number it
produces afterwards has to be argued away, and the arguing is where the next
wrong answer comes from. This project has now found four instruments whose
result was predetermined by construction; this is the first one caught by being
run on an impossibility rather than by someone noticing later.

The general habit that caught it: **run a new instrument on the case where the
answer is known to be "nothing" before running it on the case you care about.**
The selftest checked that it could detect a fault. It never checked that it could
report the absence of one.

## A one-sided statistic will happily recommend destroying the thing it does not measure

The near-field detail layer is `mix(baseNormal, detailNormal, w)`. It does not
add detail — it **trades** base for detail, and the base is where the large-scale
clod and blob structure lives. mean|Laplacian|, the statistic that defined the
defect, rises monotonically as the blobs are destroyed, so judging the gain on it
alone recommends w = 1.0 and a band of uniform crunch.

I went in believing 0.35 over the shipped 0.55, having seen at 3x magnification
what I read as an even stipple of same-sized marks — the scale-uniformity failure
this project documented earlier. **Three instruments refuted me and my eye was
wrong on every axis I had reasoned about.**

| gain | mean\|Laplacian\| | coarse variation kept | octave peak share | periodicity |
|---|---|---|---|---|
| 0 (off) | 1.48 | 100% | 32.1% | r 0.199 |
| 0.35 | 2.47 | 87% | 25.6% | r 0.134 |
| 0.55 | 3.37 | 79% | 21.6% | r 0.085 |

The layer at 0.55 is the **least** periodic of the three and has the **flattest**
octave spectrum — energy within a few points of even across all five scales,
which is the scale-invariant signature of a natural surface. The forced-off arm
is the narrow-band one, with 63% of its energy in the two coarsest octaves. The
percept I was reacting to was pattern-seeking in a broadband field.

Three transferable pieces. **A magnified crop is the wrong place to judge whether
a surface is too busy**, because busyness is a density and magnification changes
it; the 1x view is the only one the viewer sees, and my read flipped between 3x
and 1x. **Bracket a tuning parameter with a statistic for each side of its
trade**, not one for the side you are trying to improve. And when the eye and
three measurements disagree, the useful move is to find the measurement that
would vindicate the eye — I looked for periodicity and scale-narrowing
specifically because that is what I thought I was seeing, and their absence is
worth far more than the agreement of the statistics I already had.

## A sampling-ratio argument is not symmetric, because the card's own outline is the blob

Halving the foliage card was refused with a ratio: 23 texels per pixel becomes
46, so each smaller card is a worse-resolved lump. That refutation appears to
run backwards just as well — **double the card and the ratio falls to 11.5, so
the shoot's internal structure should start surviving the reduction, and the
count falls instead of rising.** It is also what jungle-trail did on purpose.
It is wrong, and monotonically so.

Rasterising one 13 m pine through a ground-level pose, thinning the count as
card size rises so crown coverage is roughly held:

| card | on screen | texels/px | cards | coverage | boundary | fragmentation | blob unit |
|---|---|---|---|---|---|---|---|
| 0.10 m | 6 px | 80.9 | 2973 | 9.5% | 9496 | 12.65% | 0.12 m |
| 0.15 m | 9 px | 56.7 | 2293 | 12.0% | 8584 | 9.20% | 0.19 m |
| 0.21 m | 13 px | 40.5 | 1573 | 16.6% | 8712 | 7.00% | 0.27 m |
| **0.30 m** | **18 px** | **28.3** | **1088** | **20.0%** | **8096** | **5.51%** | **0.35 m** |
| 0.42 m | 25 px | 20.2 | 790 | 23.5% | 6590 | 3.81% | 0.45 m |
| 0.60 m | 36 px | 14.2 | 526 | 30.1% | 6608 | 3.19% | 0.51 m |
| 0.90 m | 54 px | 9.4 | 377 | 44.4% | 5280 | 1.94% | 0.55 m |

**Every metric moves the wrong way as the card grows.** The blob unit tracks
card size nearly one-for-one, fragmentation falls by two thirds, coverage rises
to 44% — a more solid, coarser, lumpier crown at every step out to 3x.

The reason the argument does not reverse: **the visible lump is the card's
outline, not the alpha inside it, and the internal structure never catches up.**
Even at 9.4 texels per pixel a 4.3-texel needle is 0.46 px, still sub-pixel. To
resolve one needle the card must reach roughly 2 m across, at which point the
blob unit is 2 m rather than the 0.35 m being complained about. There is no
size at which the trade wins, because the thing being bought arrives six times
slower than the thing being sold.

Two further pieces. **The card-size sweep is the only change measured all
evening that moves the blob unit at all** — downward, 0.35 m to 0.19 m at 0.15 m
cards — and no damping setting touched it. And **the count scales as
1/cardSize, not 1/cardSize², because `step` is a one-dimensional walk along a
branch while the card's area is two-dimensional**, which is why coverage
collapses from 20.0% to 12.0% in that same column. Holding coverage while
shrinking therefore does cost close to 4x the cards, so the original refusal
stands — but it stood on a number that had not been derived, and the derivation
is the part worth keeping.

**jungle-trail's larger-and-fewer choice is a far-field argument and does not
transfer.** Out there the failure is sky-speckle between cards and coverage held
in big shapes is the fix. In the near field the blob unit *is* the complaint, so
the same move is precisely backwards.

## Registering the target caught the wrong object for the fourth time today

Interwhorl stem shoots were approved to fix an observation nobody disputed —
85% exposed trunk from a ground-level pose — and were declined by their own
pre-registered metric before a single pixel was captured.

**The 85% was the wrong population.** It came from scanning a column down the
visible trunk, which from a ground-level pose is mostly the self-pruned lower
pole *below* the live crown, where bare wood is correct and covering it would
be a different error. Rasterising the wood mesh with a depth buffer and asking
whether foliage covers each drawn bark pixel gives **17.0% visible bark**, not
85%.

**And the exposure is not on the stem.** Split radially from the axis rather
than by height — a branch inside the live crown is at crown height but is not
stem, and tagging by height silently merges the two populations the complaint
distinguishes:

| | HEAD | with stem shoots |
|---|---|---|
| stem inside the live crown | 26.4% bare | 24.9% |
| branches, all heights | 16.5% bare | 15.9% |
| longest unbroken run | 83 px (1.38 m) | 83 px |
| runs 40 px or longer | 3 | 3 |
| share of bare bark in those runs | 45% | 45% |

**Three runs carry 45% of all bare bark, and they are 0–18% stem.** They are
branch wood. Shoots on the stem cannot reach them, which is why the longest run
does not move by one pixel for 3.8% more instances.

The transferable part is not the pine. **"Long stretches of naked pole" is a
claim about run length, and exposure area cannot confirm or refute it** — a tree
can be 17% bare and still read as sticks if the 17% is in three unbroken
lengths, or read as full if it is in two hundred short ones. Here it was both:
204 runs, of which three carry nearly half. Measuring the area would have said
the tree was fine; measuring the runs says where the fix has to go. **Pick the
statistic whose shape matches the percept's shape**, and if the percept is about
extent, area is the wrong moment of the distribution.

## A constant fitted on one population is an untested assumption wearing a number

`DAMP_RAMP_DEFAULT` — onset 0.8 stops, width 2.4 — was fitted on scrub and
applied to every foliage layer. It was landed with the claim that it is identity
at mip 0 and provably cannot move the foreground. **It is at full saturation on
every pine card at every playable distance**, so the near crown was getting the
far crown's alpha dilation and roughness clamp, and the distance term never
engaged for anything from eight metres out.

Pine carries 512 texels on a 0.30 m shoot, 1707 per metre; scrub carries 256 on
a 0.35 m card, 731 per metre. A pine crown at 14 m therefore samples at a higher
rate than scrub at 40 m. **One global ramp in texels-per-pixel must treat a near
pine as a far scrub, and no choice of onset and width escapes it** — the layers
are not separated by the quantity the ramp is a function of. The fix is a
per-layer constant, not a better global one.

**The verification failed in the hardest possible way: it passed.** It was run
on scrub within two metres, which is the one narrow band where the expression is
genuinely zero. A check that samples the single region where the term is inert
will confirm identity no matter how wrong the term is everywhere else.

The replacement is measured rather than fitted by eye. Area-weighted over 6528
card triangles through a ground-level pose, the pine's texel footprint runs p5
4.58, median 5.23, p95 6.05 stops. **The head-on arithmetic that predicted 4.82
sits at about the 18th percentile** — `fwidth` takes the worse axis, the cards
are rolled at 0/60/120° and mostly seen at a slant, so a footprint computed
head-on is a lower bound and randomly oriented cards do not live at the bound.
That is why the first re-range under-delivered, and it is worth more than the
re-range: **a per-pixel derivative quantity has a distribution, and reasoning
about it from a single head-on case gets the tail wrong in a predictable
direction.**

## A tool that has not been run since a change is not a tool that works

Every headless CPU tool in `tools/` threw for five hours and nobody noticed.
Tier gating had started reading `quality.transmission` inside
`VegetationSystem.init`, and the shared CPU entry built a context without a
`quality` field — so `collectSites`, the pine geometry probes and the scale
sweeps all died on `Cannot read properties of undefined`. Nothing was wrong with
the tools; the thing they instantiate grew a requirement.

This is the class of failure that hides best, because **a tool is only exercised
when someone reaches for it, and the gap between a change and the next reach is
unbounded.** The browser path was run continuously all afternoon and was fine.
The headless path was run at 14:34 and again at 19:20.

Two cheap defences, neither of which was in place. **A CPU entry that constructs
a system should construct it the way the app does** — here that means calling
`tierSettings(...)` rather than hand-rolling a partial context, so a new
required field is a type error at build time instead of a runtime throw five
hours later. And **anything that shares a constructor with the shipping path
belongs in whatever runs on every change**, because the cost of one headless
build in CI is far below the cost of discovering the breakage while trying to
use the tool to diagnose something else.

## The blob unit is a function of crown coverage, not of card size

The card-size table appeared to contain one working lever: shrinking the
foliage card from 0.30 m to 0.15 m took the blob unit from 0.35 m to 0.19 m,
the only movement in that statistic all round. It was an artefact of the
crown getting thinner, and holding coverage removes all of it.

The table thinned the count as 1/cardSize, because `step` follows card size, so
coverage fell from 20.0% to 12.0% as the cards shrank. Solving for the density
that restores coverage instead:

| card | density | cards/pine | scene cards | tri/frame | coverage | blob unit |
|---|---|---|---|---|---|---|
| **0.30 m** | **1.00x** | **1088** | **23710** | **285k** | **19.5%** | **0.34 m** |
| 0.21 m | 2.29x | 4039 | 67823 | 814k | 21.6% | 0.32 m |
| 0.15 m | 8.90x | 18703 | 316848 | 3802k | 17.1% | 0.31 m |
| 0.10 m | 24.0x | 67178 | 1006140 | 12074k | 13.5% | 0.25 m |

**At held coverage the blob unit moves 5% for 186% more cards.** The rows that
show a real reduction are the rows where coverage collapsed, and one pairing
settles it: 0.30 m at 19.5% coverage and 0.15 m at 19.9% both give a 0.34 m
blob unit, at card sizes 2x apart. Sorting every row measured, in either
sweep, by coverage rather than by card size puts them in order — 19.5% and
19.9% both at 0.34 m, 17.0% and 16.0% both at ~0.25 m — and sorting by card
size does not.

So the crown's apparent lump size is set by **how much of the crown is filled**,
not by what fills it. That is why nothing moved it: every change tried, from
damping to needle width to card size, held coverage roughly constant by
design, and the one quantity that governs it was the one being controlled for.

The consequence is not a tuning result, it is an architectural one. **A crown
cannot be made to read as finer without being made thinner**, on this
primitive, at any price. Smaller cards do not buy resolution; they buy sparsity,
and sparsity is what the eye was reading as finer.

## The most salient bare wood was the part that is correct, and the model excluded it for being correct

The CPU rasterisation put visible bark at 17.0% in 204 runs and reported the
stem inside the live crown as 74% covered. The captured frame shows a pine
whose trunk is a single unbroken black line, and that line is the most
prominent thing in the crop by a wide margin. Both are accurate.

Measured on the frame instead of the model: over the 9.3 m of stem in view the
trunk is **48.8% bare, in 25 runs, one of which is 2.39 m long and carries 53%
of all the bare rows**, at **178 codes of contrast** against the sky — bark at
luminance 22.6 against sky at 200.4.

That run spans 2.65 m to 4.88 m of tree height. `deadBelow` on a 13 m pine is
4.42 m. **Four fifths of the worst-looking stretch on the tree is the
self-pruned lower stem, where bare wood is botanically correct** — and the
rasterisation excluded exactly that band, deliberately, on the grounds that
covering it would be a different error.

Three things worth keeping. **A model that excludes a region as correct cannot
tell you that the region looks wrong**, and "correct" and "reads well" are
independent; the exclusion was right for the question asked and hid the answer
to the question that mattered. **Contrast is part of salience and no
coverage statistic carries it** — 17% of bark exposed says nothing about a
line at 178 codes against the brightest thing in the frame. And the cross-trunk
luminance profile through that run is flat: 13 to 16 codes across 14 px of
bark, with a 3-px rim on the sunward edge. A lit cylinder has a gradient.
**The trunk does not read as a stick because there is too much of it showing;
it reads as a stick because what shows has no internal shading.** That points
at the bark's response to a low backlight rather than at the amount of foliage,
and it is the cheaper thing to change.
