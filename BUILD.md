# How this was built

This is the method, and what it cost. It is not a changelog — the commit log is
the changelog. It is here because the interesting part of this project is not the
gas station, it is the eighteen hours of being confidently wrong about it and the
handful of habits that eventually caught that.

The brief it was built from is in [PROMPT.md](PROMPT.md), verbatim.

## The constraint, and the tiebreaker

Zero external assets. Every mesh, every texture and every sound generated in
code — no images, no models, no HDRIs, no audio files, no material libraries.
That is checkable rather than aspirational: there is no `TextureLoader`,
`GLTFLoader`, `RGBELoader`, `AudioLoader`, `CubeTextureLoader`, `fetch`,
`XMLHttpRequest`, `new Image` or `createImageBitmap` anywhere in `src/`, and a
load makes exactly two network requests — the HTML and one JavaScript bundle,
with Three.js bundled into it.

The tiebreaker the brief gave was **a photograph, not a game**, and it did more
work than any technical decision in the project. It is the phrase that settles
arguments, because it converts "does this look good" into "would this be in the
frame if someone had stood here at six in the morning and pressed the shutter".
Several systems have a section in their handover titled *judged as a photograph*,
and in more than one case the answer was that a feature everyone liked was
something a camera would not have recorded.

## How it was actually built

Systems were owned by separate agents working in parallel — terrain, the
building and its interior, pumps, the parked car, lighting, vegetation,
interactions, audio, performance — on one working tree, which is why the
documents in this repo are addressed to each other. The brief asked for strictly
sequential work and that constraint was relaxed; see the departures at the bottom
of [PROMPT.md](PROMPT.md).

Each system was reviewed by a critic that saw **rendered frames only** and never
the source, and the critic was never the agent that built the thing. That much
came from the brief. What the brief did not specify, and what the project
actually turned on, is the three habits that grew out of being wrong repeatedly:

**Register the prediction before capturing.** Name the number you expect and the
direction, in writing, before the frame exists. A measurement interpreted after
the fact will agree with whatever you already believed, and this project has the
receipts: a lever was approved on a pre-registered target and then declined by
that same target once the target was measured properly rather than asserted.

**Every experiment carries a control arm that must not move, and where possible
one that must.** The must-not-move arm catches a harness measuring itself; the
forced-high arm proves the lever is wired and reaching the frame at all. Without
the second, "nothing changed" is indistinguishable from "nothing was connected",
and those have opposite fixes.

**Prove an instrument can fail before believing that it passed.** A detector
that has not been shown to detect is not a detector. `tools/shaderlint.mjs`
plants four defects in a clean sample and requires all four to be caught before
it will report on the real shaders. `tools/cardclear.mjs` queries for a process
it knows is running — itself — and exits non-zero if the count comes back zero,
because the check it replaced used `wmic`, which does not exist on this Windows
build, and therefore **returned all-clear by failing to look**.

## The failure mode that defined the project

Almost every hard bug here was an instrument reporting on itself rather than on
the scene. They are collected in `NOTES.md`; these are the ones worth reading.

**A knob that was doing nothing, in a way no cheaper check could show.**
`envMapIntensity` was inherited from `scene.environment` rather than bound to the
material, which made it inert. Nulling the environment changed 68% of the frame,
which proves image-based lighting reaches the object and says exactly nothing
about the knob. The renderer's own `envMap` property was truthy either way. Only
staging the same change under two bindings separated them: inherited, taking the
value from 1 to 4 changed **0.00% of pixels**; bound to the material, the same
change moved **15.0%** and took the flank mean from 58.6 to 119.1. A feature that
does nothing and a feature that is subtle are the same screenshot.

**The control that was measuring the clock.** A parked control was compared
against a walking run to see what the camera pose cost, and reported that
standing still on the forecourt cost **18.73 ms** against **7.32 ms** walking
that same forecourt — same geometry, same view region, two and a half times the
price for doing less. The control had run from 5 s to 121 s, and the walk's
analysis discards everything before 60 s as warm-up. Texture bytes were still
falling at 51 seconds, mid-control. So the control sat inside the window the
analysis excludes and was then compared against the filtered walk. The pose was
never the difference; the clock was, and every 1% low measured on the project up
to that point was discarded on that finding's authority.

The general form is worth more than the fix. **A control broken in the direction
of more suspicion looks like rigour**, which is why it survived so long. A
flattering broken control gets challenged the moment someone reads it. One that
makes you doubt your own numbers gets praised for caution. The protocol now
requires the control to run *after* the walk.

**A classifier that assumed a different scene.** A sky test was written as
`blue >= green - 4 && luminance > 90`. That describes a midday sky. This project
is entirely a sunrise, where the sky above the horizon is warm and not
particularly bright, so the test quietly disagreed with the thing it was pointed
at. The fix was to stop classifying by hue and use luminance above the horizon.

**A shell pipeline that discarded the verdict.** `node tools/archive.test.mjs |
tail` reported **exit 0 while the suite itself exited non-zero**, because `$?`
belongs to `tail`. The same shape appeared again with `shoot3.mjs | grep | tail`.
The lesson is not "use `PIPESTATUS`", though the tools now do. It is that a
pipeline is a place where a failure can be converted into a success without
anybody touching the code that failed.

## The wrong-object pattern

The other half of the project's mistakes were correct measurements of the wrong
thing. This is harder to guard against than a broken instrument, because every
individual step is sound.

**Two white rectangles, and three wrong owners.** A playtest reported two large
white rectangles floating in the shop interior. Three mechanisms were in play
across two systems, and the favoured candidate — an interior environment
intensity raised from 1.0 to 2.4 — was favoured for a good reason: the coupling
it fed peaks at exactly the grazing angle where the print died. Eight arms were
captured in one browser on the reported region. The rectangle came back **mean
231.6, sd 1.36, six distinct luma codes in all seven test arms, identical to four
significant figures**, while the control region behind the same pane moved by
12.8 mean and 22 codes under a forced-high arm. The levers were wired. They did
nothing to the rectangle, which was also bit-identical to a capture taken forty
minutes earlier, before the grade that was blamed for it had landed.

The rectangles were **two blank sheets of paper taped to the outside face of the
entry door**, 0.21 × 0.29 m, facing away from the shop, lit by the sky. Every
interior and environment lever that had been pushed was aimed at a surface that
interior and environment light does not reach. The invariance was a property of
the measurement, not of the material, and it had pointed at an innocent system
twice.

**Gravel that was fixed three times, and the first two were the wrong
quantity.** Near-field gravel was invisible. First the count went from 1,500
stones to 9,000; nothing appeared, because a third of the candidates were spread
over 145 × 105 m of open ground — 0.03 stones per square metre, so a square metre
in front of the eye held a stone three per cent of the time. Then the extent was
widened from a 52 m disc to 88 m, which fixed a pose whose entire foreground fell
outside the old disc and **divided the density by three, cancelling the count
increase that was the whole point**. A scatter has a count and an extent and only
their ratio is visible. The actual cause was the third thing: the stones were
sunk by 0.42 of their radius and vertically flattened, standing a median of 4 mm
proud on a 20 mm stone, which at a metre and a half from the eye is two pixels.
Every stone was present, correctly placed, correctly lit, and buried.

A later gravel change is recorded in the handover as **kept but not a picture
fix**, which is the more disciplined outcome. It made generation 45% cheaper —
85,165 acceptance tries down to 46,847 for the same 12,000 stones — and moved the
visible region's spread by 1.5, which is about what reseeding the same scatter
would move it on its own. So it is kept on the cost number and explicitly not
claimed on the picture.

**And the inverse: the number that was trimmed.** A pine trunk measured flat,
which looked like a real defect, since a lit cylinder has a gradient and a flat
one would be wrong. The object was right and the physics was right. The profile's
ends had been cropped as noise — a routine and usually correct habit — and on a
16-pixel-wide object that crop removes the signal. The trunk did have its
gradient; 16 codes of correct gradient are simply invisible next to a 178-code
contrast edge. Worth keeping separate from the wrong-object cases, because the
guard is different: not "derive the region from geometry" but "look at the whole
profile before deciding which part of it is the object".

## What was refused

The tree crowns are the part of this project most worth reading, because the
outcome was a refusal supported by numbers rather than a fix.

Pine foliage reads as blobs. The diagnosis is not in dispute: a card is 0.30 m
and about 22 pixels carrying a 512-texel texture, so it samples at 23–38 texels
per pixel and a 4.3-texel needle lands at 0.19 px. Five levers were costed
against that. Four were refuted with measurements:

- **Larger cards are refuted monotonically out to 3×.** Every metric moves the
  wrong way — the blob unit grows 0.35 m to 0.55 m, fragmentation falls 5.51% to
  1.94%, coverage rises 20% to 44%. Even at 9.4 texels per pixel a needle is
  still 0.46 px, and a card would have to reach about 2 m before one resolved, by
  which point the blob unit is 2 m. There is no size at which the trade wins.
- **Smaller cards are the only thing that moved the blob unit** — 0.35 m to
  0.19 m at 0.15 m cards — but coverage collapses from 20% to 12% in the same
  column, because the walk along a branch is one-dimensional while card area is
  two-dimensional. Holding coverage while shrinking costs close to 4× the cards.
- **Stem shoots were declined by their own pre-registered target.** The 85%
  exposed-trunk figure came from scanning a column down the visible trunk, which
  from a ground pose is mostly the self-pruned pole below the live crown, where
  bare wood is correct. Rasterising the wood with a depth buffer and asking
  whether foliage covers each drawn bark pixel gives **17.0%**. And the percept
  is about runs, not area: of 204 runs of exposed bark, three are 40 px or longer
  and carry 45% of all bare bark — and those three are 0–18% stem. They are
  branch wood, which stem shoots cannot reach, confirmed by measurement.
- **A texture change cannot fix it either.** Taking needle width from 0.19 px to
  1.13 px leaves the post-reduction boundary flat.

What landed instead was a correctness fix that nobody had asked for: a damping
ramp fitted on scrub was being applied to pine, which carries 1,707 texels per
metre against scrub's 731, so **every pine card at every playable distance sat at
full damping** and the distance term never engaged at all. Its original
verification had passed because it was run on scrub within two metres — the one
band where the expression is genuinely zero.

The finding underneath all of it is that **the blob is the card's outline, not
the alpha inside it**, and blob size is governed by crown coverage rather than
card size. A crown therefore cannot read finer without reading thinner. That
leaves the mechanism identified and no cheap lever against it, and the honest
conclusion recorded in the handover is that the next real move is a different
primitive, not a different constant — which is not an improvement to a finished
build.

## What it costs to run

**The cold load is the project's worst number and it is not what anyone assumed.**
Two runs on the same machine and the same profile directory, differing only in
whether that directory had been used before: **216.5 s on first use, 19.7 s
warm**. An 11× effect. About **92% of the cold load is the graphics driver
compiling this scene's shader programs**, not scene construction — generation is
only around 22 s of it. That reordered the quality tiers, which now scale the
shader program count as well as the triangle count, because a tier that cuts
geometry and leaves the programs alone misses the thing that hurts.

**Stability, over a twenty-minute walking session on a warm profile with no
sibling harness on the card:** 151,744 frames, **zero system errors**, no context
loss, mean frame time **7.32 ms**, median 5.4 ms, p95 14.4 ms. Three frames
exceeded 100 ms in twenty minutes — 115, 149 and 161 ms — which cost 125.7 ms of
discarded simulation time and 17.6 cm of ground not covered while walking.

Post-processing was specified in the brief and is not enabled at any tier. The
reason is recorded rather than quietly dropped: the dominant cost was not the
effect but losing multisampling to run it, and the composer's two targets cost
237 MB, more than the shadow map.

## If you are reading this to work on it

`NOTES.md` is the file that matters — every way this scene has looked correct
while being wrong, each with the measurement that caught it. `PERF.md` carries
the costs, `RESUME-PLAN.md` the per-system state, and the `HANDOVER-*.md` files
the reasoning of each system's owner, including the parts they got wrong and
withdrew. They are internal documents and they read like it. They are published
because a build log that only contains the things that worked is a sales
brochure.
