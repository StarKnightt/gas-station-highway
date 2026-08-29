# HANDOVER — the boot overlay (`#boot`, `src/core/loadingScreen.ts`)

Owner of: `src/core/loadingScreen.ts`, the `#boot` block in `index.html`,
`tools/bootshots.mjs`. Minimal additive edits in `src/core/Game.ts` (four paint
yields, three dispatched events) and `src/main.ts` (install + failure route).

Written because a summary of these numbers existed only in a chat transcript
and Perf could not find them on disk. Everything below is measured unless it
says otherwise.

---

## What the overlay is and where its progress comes from

`Game.start()` announces its **filtered** active system list once
(`systems-active`), then brackets each system's `init()` with
`system-init-start` / `system-init-done`. That is the progress source.
`window.__INIT_TIMINGS` says the same thing but only after the whole loop, which
is too late to drive a bar. Because the announced list is the post-`?solo=` /
`?skip=` one, isolation runs weight correctly with nothing to configure.

Bar weights come from one table, `INIT_COST_MS` in `loadingScreen.ts`. Correct
that table when init costs move; it is the only place they are written down.

The last 8% of the bar is reserved for shadow-map preallocation plus the first
frame, and that stage shows **no percentage at all** — driver compile time is
the largest unknown in a cold load, so any figure would be invented, and an
invented figure that stops moving is the "stuck at 94%" the overlay exists to
prevent.

## The load-bearing design decision

Procedural generation pins the main thread — terrain for ~11–13 s in one go —
so anything driven by a timer, `requestAnimationFrame` or a `Date` read freezes
for exactly the stretch the user most needs to see life. The elapsed clock, the
bar's creep inside the current segment, the heartbeat and both slow-load
notices are therefore all `transform` / `opacity` animations, which Chrome runs
on the compositor thread. **This is the claim `tools/bootshots.mjs` is built to
test**, and it is the reason that harness uses CDP screencast rather than
`page.screenshot`.

Slow-load notice at **30 s**, second notice at **90 s**. 30 s clears every warm
load ever measured here and is 11% into the cold wait. Residual risk stated
honestly: the most contended warm load measured 30.1 s, so under heavy
contention the notice can flash for a fraction of a second at the end of a warm
load. 30 s is kept because 30 s is the value there is pixel evidence for.

---

## `page.screenshot` cannot photograph a blocked main thread

The finding that prompted Perf's audit, recorded here as the primary source.

The first version of `bootshots.mjs` used `page.screenshot`. **Every capture
attempted during procedural generation timed out at 15 s** — 15 of 16 scheduled
captures on the cold load, 1 of 3 on the warm one. That path waits on the
page's own main thread, which is the thread under test.

```
[cold] 0.4s   screenshot failed: page.screenshot: Timeout 15000ms exceeded.
[cold] 15.4s  -> shots/boot/cold/t15_4s.png        <- the only one that landed
[cold] 29.4s  screenshot failed: page.screenshot: Timeout 15000ms exceeded.
   ... 14 more identical failures ...
```

CDP `Page.startScreencast` is pushed from the browser side whenever the
compositor produces a frame, so it captures during a block. After switching,
**22 of 22** scheduled cold captures landed.

The general form, which is not specific to screenshots: any harness that
samples strictly after `__SCENE_READY` cannot encounter this, which is also why
it never came up. It is the reason init has been one number for this whole
project.

---

## Measurements

### Cold vs warm, this instrument (`tools/bootshots.mjs`, port 5163)

Cold = brand new browser profile via `launchPersistentContext` (no HTTP cache,
no GPU program cache). Warm = reload in the same profile.

| run | cold ready | warm ready | other GPU load at the time |
|---|---|---|---|
| 1 (`page.screenshot`; discarded for the reason above) | 273.3 s | 25.7 s | not recorded |
| 2 | 217.9 s | 22.5 s | not recorded |
| 3 | 283.8 s | 30.1 s | not recorded |
| 4 | 205.8 s | 21.6 s | `coldload.mjs` live (5171); GPU 20%, 3038 MiB |
| 5 (shipped code) | 298.0 s | 26.4 s | `firstload.mjs` (5152) **and** `coldload.mjs` (5171) live; GPU 29%, 4374 MiB |

Cold spans 205.8–298.0 s across five runs. `283.8 s` against Perf's `279.1 s`
is agreement to 1.7% from two harnesses built for different questions, and run
4's 205.8 s is the least contended figure here. Warm run 4 at **21.6 s** lands
inside the historical clean band of 20.8–21.9 s, which retroactively confirms
that run 3's 30.1 s was contention and not a regression — and that the 30 s
slow-load threshold is safe on an uncontended machine.

Per-system init, run 5, seconds:

| system | cold | warm | `INIT_COST_MS` |
|---|---|---|---|
| terrain | 12.16 | 12.50 | 11.0 |
| building | 3.87 | 3.64 | 3.44 |
| pumps | 1.84 | 1.92 | 1.69 |
| vegetation | 1.39 | 1.34 | 1.25 |
| car | 1.29 | 1.38 | 1.21 |
| canopy | 0.75 | 0.65 | 0.49 |
| lighting | 0.68 | 0.77 | 0.09 |
| player / audio / interaction | 0.00 | 0.00 | 0.15 / 0.30 / 0.10 |

The table is good to about 15% on everything that matters. Only `lighting` is
badly wrong — 0.09 declared against 0.50–0.77 measured — and at 0.4% of init it
cannot move the bar. **Note that cold and warm per-system init are within a few
percent of each other**, which is itself part of the headline below: a cold load
does not generate the scene any more slowly, it compiles for far longer.

### THE HEADLINE: the cold-load penalty is shader compilation, not generation

Two independent cold runs, both with the full series on disk:

| | run 4 | run 5 |
|---|---|---|
| cold ready | 205.8 s | 298.0 s |
| last `init()` ends | 17.96 s | 22.37 s |
| **shader-compile stage** | **187.9 s (91.3%)** | **275.6 s (92.5%)** |
| warm ready | 21.6 s | 26.4 s |
| warm compile stage | ~2 s | 3.9 s (14.6%) |

**Generating the entire scene — 534,780 terrain triangles, 24,000 gravel
stones, 10,650 instanced foliage cards, every procedural texture — is 8% of a
cold load. The other 92% is the driver compiling this scene's programs.**

This was invisible for the whole project because init was the only phase
anyone could see a number for, so init was the suspect. It is not the suspect.

Corollary for tiering, which is why this was escalated: **a low quality tier
that cuts triangles, draw calls and VRAM while leaving the program count intact
would not touch the thing users feel most.** Reducing shader *permutations* is
the lever on first-load time. Program count is in
`renderer.info.programs.length`; `coldload.mjs` already prints it.

### Compositor frame arrivals — for Perf, and the caveat

Hand over these two files directly; they are the deliverable, not the summary
lines:

```
shots/boot/cold/frames.json      727 arrivals, run 5, cold
shots/boot/warm/frames.json      738 arrivals, run 5, warm
```

Each contains the complete arrival series in seconds, the gap distribution
(p50 / p90 / p99 / max), a histogram, **gaps attributed to the load stage they
fell in**, and the `statusTrace` that gives the stage boundaries in page time.
`navOffsetMs` reconciles page time with harness time (8 ms on run 4, so the two
clocks are effectively the same).

**Caveat, and it is why runs 1–3 are not in this section: for those runs the
harness computed the maximum, printed it, and discarded the array.** The series
for runs 1–3 does not exist and cannot be recovered. What survives of them is
a subsample — each screenshot filename under `shots/boot/<tag>/` *is* the
arrival time of the frame written to it, so run 3's cold arrivals were
0.6, 1.2, 2.5, 4.0, 6.5, 9.1, 12.3, 16.0, 21.0, 27.6, 33.1, 37.2, 45.9, 61.5,
75.7, 92.2, 95.4, 120.3, 150.9, 190.3, 230.2, 272.7 s. Those are the frames
nearest each *scheduled* sample point, so the intervals are the schedule's and
not the compositor's: they bound arrival times, they do not measure gaps.

### The gap distribution, and what it settles

Run 5, cold: p50 **0.03 s**, p90 **1.78 s**, p99 **4.49 s**, max **6.19 s** at
t = 263.4 s. Run 5, warm: p50 0.03 s, p90 0.04 s, p99 0.08 s, max 1.96 s.
Run 4 cold histogram: 517 of 637 gaps at or under 0.05 s, then 77 in the
1–2 s band and 30 in the 2–5 s band — i.e. the long tail is *entirely* the
compile stage's 107 gaps.

Per stage, run 5:

| stage | frames | rate | worst gap |
|---|---|---|---|
| shaping the ground (terrain's block) | 286 | ~23 fps | **2.07 s** |
| every other `init()` stage | 4–98 each | ~30 fps | ≤ 0.10 s |
| compiling shaders, cold | 164 | **0.60 fps** | **6.19 s** |
| compiling shaders, warm | 113 | 29.3 fps | 0.10 s |

**This settles the design claim.** Terrain holds the main thread for 12 s and
the compositor still delivers 286 frames in it, so the overlay's animations are
genuinely independent of the main thread. Every gap over 2.5 s falls after init
has finished, where the driver has the GPU and *nothing* on the page can be
composited — not something a loading screen can act on.

**Correction to an earlier claim of mine:** I reported terrain's worst gap as
"~1.5 s" from runs 2–3 (1.52 / 1.47 s). Under the heavier contention of runs
4–5 it is 1.94 / 2.07 s. Still inside the warning band, but the number is 2.07 s
and not 1.5 s. `bootshots.mjs` grades the two bands separately: a >2.5 s gap
during `init()` is a defect in this overlay, the same gap during compilation is
not, and >8 s anywhere fails the run.

### The compile stage needed a fix, and it could only be static text

At 0.60 fps with gaps to 6.19 s, **no animation reads** — the heartbeat's 1.7 s
pulse and the stepped clock both alias into apparent stillness, and the user
spends 92% of a first load in this stage. The clock claiming to be "live" while
the screen holds for six seconds is the overlay contradicting itself in the one
place it most needs to be believed.

Nothing can be done about the frame rate; the driver has the card. The only
thing that still works when the picture is frozen for six seconds is a sentence
that predicted it, so the compile stage now carries a static line — *"the
picture may hold still for a few seconds at a time while it does. That is the
graphics card being busy, not the page having stopped."* — shown by CSS off the
`indeterminate` class, no script involved.

The 30 s note was also reworded, because the numbers above showed it was
telling the wrong story: it led with procedural generation, which is 8%. It now
leads with the shader compile and gives the measured split. Verified in pixels
at t = 190.2 s on run 5's cold load.

---

## The `#loading` silent break, resolved — keep this as the worked example

For one round `#loading` was retained as a zero-size marker (correct —
`coldload.mjs` times the first frame by watching for its removal) but **nothing
wrote text into it**. `tools/lightProbe.mjs:78`, `tools/reticleprobe.mjs:235`
and `tools/shoot7.mjs:221` each print its `textContent` as their diagnostic
when a load fails, so all three printed `""` in precisely that case.
`textContent` on an empty div is `""`, not null or undefined, so every
truthiness guard and optional chain passed and the diagnostic degraded to
silence with nothing logged anywhere.

**Fixed by making `loadingScreen.ts` the single writer of `#loading`'s text,
mirroring the live step label.** Deliberately the live label and not only the
failure message: all three harnesses fire when `__SCENE_READY` never arrives,
and a hang inside `terrain.init()` never reaches `reportBootFailure`, so a
failure-only mirror would still have printed `""` for the common case — a fix
that looks complete and does not cover what it was written for.

Net effect: those three are correct with no edit to them, and are better off
than before. A hung load now prints the system it hung in — `shaping the
ground` — instead of the old constant `generating surfaces…`.

`bootshots.mjs` now asserts the mirror is non-empty, takes more than one
distinct value, and carries terrain's label. All three conditions, because each
fails differently and the middle one (a stuck constant) would otherwise look
identical to a working mirror.

Full dependent list lives on the element in `index.html`. **Keep it accurate.**

---

## Ports and instruments in this space

Three, and they answer different questions. One run each, no substitutions.

| harness | port | question |
|---|---|---|
| `tools/firstload.mjs` | 5152 | measurement — how long, and where |
| `tools/coldload.mjs` | 5171 | mechanism — what makes a load cold |
| `tools/bootshots.mjs` | 5163 | whether the overlay behaves |

`5137` was taken by another agent mid-session despite not being on the declared
list; `5163` was free and is what `bootshots.mjs` binds now.

## Status: finished, and what is deliberately left

The feature is done and confirmed in pixels on a genuinely cold load. Nothing
below is needed for the user to walk the scene.

1. **Split the compile stage.** 275.6 s is attributed to "shadow-map
   preallocation plus first-frame shader compilation" as one lump. The split
   between those two, and between programs, is the remaining unknown and it is
   now the most valuable measurement in the project. `__BOOT_TRACE` gives the
   stage boundary; a `getProgramParameter(LINK_STATUS)` timing hook would give
   the per-program cost. **Perf's territory, not this overlay's.**
2. `INIT_COST_MS`'s `lighting` entry wants 0.6 rather than 0.09. Worth doing the
   next time this file is open; not worth a trip.
3. `vegetation.blockers` and friends are nothing to do with this file — listed
   only so nobody reads the short "next" list as meaning the tree is clean.
