# Performance and stability — handover

Owner of `PERF.md`, `QUIET-HOST-PROTOCOL.md`, `src/core/capability.ts`, the `dt`
clamp instrument in `src/core/Game.ts`, and the harnesses `stress.mjs`,
`perf.mjs`, `tiers.mjs`, `timeoutaudit.mjs`, `voidcheck.mjs`, `cardclear.mjs`,
`firstload.mjs`, `devgate.mjs`, `budget.mjs`, `program-audit.mjs`,
`texture-audit.mjs`, `bloom-cost.mjs`, `permute.test.mjs`.

Full detail is in `PERF.md`; §20 is the final window run. This file is the part a
reader needs first.

---

## 1. A person can walk this scene, and it stays up

**This is the answer to the only bug the user ever reported directly.** Their
browser died walking this scene, and that started this whole thread.

Final run, quiet host, warm profile, real controller path through pump, door and
fridge:

| | |
|---|---|
| duration | 20 minutes (1204.6 s) |
| frames rendered | **151,744** |
| system errors | **0** |
| `contextLost` | **null** |
| survived | **true** |
| texture bytes | flat at 724.14 MB, start to finish |
| programs | flat at 189 |
| draw calls | flat |
| JS heap | oscillating 357–433 MB, **no trend** |

The `WEBGL CONTEXT LOST` line in that run's console arrived **at teardown**, after
the final sample — `contextLost` is null in the record. Checked, not assumed.

Peak VRAM during init was brought from **832 MB to 320 MB** earlier in the
project, and the init transient — the phase the user's browser actually died in —
from **518 MB to 8.3 MB**, reproduced to the byte across two independent runs.
That is the crash mechanism, and it is closed.

## 2. What a frame hitch costs the player: 17.6 cm

Frame time is not an abstract quality metric here. `Game.frame` clamps `dt` at
100 ms, so a frame longer than that advances the simulation less than wall clock
and **the body covers `v x excess` less ground.** The clamp must stay: unclamped,
a 300 ms frame moves the body 0.71 m against a 0.32 m collision radius, i.e.
through a wall.

Measured over the 20-minute run:

- **3 clamped frames** of 115, 149 and 161 ms, out of 151,744
- **125.7 ms** of simulation time discarded
- **17.6 cm** not covered walking, **29.9 cm** sprinting — the same stall costs a
  sprinting player 1.7x what it costs a walking one, because the loss scales with
  speed
- **frames over 100 ms: 3 of 140,077** steady-state frames, all in
  `store-interior`
- `stalls: 0`

**Contention can only make this worse, so a quiet host is not concealing a larger
number.** This figure is unaffected by the void conditions below and is the one
frame-time-derived number in this handover that is safe to quote.

Attribution uses Interaction's own accumulators rather than a duplicate
instrument: **1161.68 m travelled over 1207.3 s simulated, 16,011 collision
resolves.**

## 3. Frame time — INDICATIVE, NOT CERTIFIED

| | mean | median | p95 | max | >33 ms | >100 ms |
|---|---|---|---|---|---|---|
| whole walk | 7.94 ms | 5.5 | 17.5 | 160.7 | 230 | 4 |
| steady (>60 s) | **7.32 ms** | **5.4** | **14.4** | 160.7 | 102 | 3 |

**Why not certified, in one line:** the run is void under
`QUIET-HOST-PROTOCOL.md` §4.1 on conditions 1, 3 and 4 — the host drifted 508 MiB
of VRAM before launch with nothing of ours running, and the parked control was
mis-positioned (§5 below). The project was offered a clean re-run and declined it
as unnecessary, since §1 and §2 do not depend on it. **These numbers are good and
they are not evidence.**

Relative phase cost is a ratio and therefore survives contention:

```
parked control     18.73 ms   <- artefact, see §5
cooler-shut-look   14.28 ms
store-enter        14.24 ms
cooler-open-look   14.22 ms
store-interior     10.68 ms
forecourt-approach  7.32 ms
```

The cooler and store-entry poses are roughly 2x the open forecourt. That ranking
is stable and is the useful input for shot or route planning.

## 4. Warm versus cold: 19.7 s against 216.5 s on the same profile directory

**The single most useful number for anyone recording, demoing or testing this
build.**

Two runs, same machine, same `tmp/profiles/stress`, differing only in whether the
directory had been used before:

| profile state | time to ready |
|---|---|
| first use (cold shader cache) | **216.5 s** |
| reused (warm) | **19.7 s** |

An **11x** effect. Cold load is ~92% driver shader compilation, not scene
construction — init is only ~22 s of it.

Consequences that keep biting people:

- **Shader-cache warmth belongs to the profile directory, not the machine and not
  the driver.** A harness using Playwright's default ephemeral context throws its
  profile away and pays the full cold load every single time, on a machine that
  has compiled these shaders hundreds of times. Use `launchWarmProfile` from
  `tools/gpu.mjs`.
- **`perf.mjs` deliberately stays cold by default**, with `--warm` opt-in, and
  prints which regime it used. Warming it silently would change what `readyMs`
  *means* — from what a user waits for on first open to what a repeat costs — and
  those differ by 10x.
- **The user's own first open is a cold load.** They will wait minutes, not
  seconds. That is the largest remaining user-facing performance fact about this
  project and it is not fixed, only measured. The named fix is shader
  precompilation / `renderer.compileAsync` / a warm-up pass.
- **Any readiness wait under ~420 s will report a healthy build as broken.** See
  §6.

## 5. The parked control was measuring warm-up, and it retires every tail figure

**The most consequential correction in this handover, because the wrong version
was believed for most of a day and was used to invalidate other people's data.**

The parked control exists to separate "this scene is expensive" from "this host is
busy": hold the camera still and the cost should be a floor. It instead produced
an inversion nobody could explain — a static frame costing more than a moving
camera — and that observation was strong enough that **every tail figure and every
1% low measured on this project was discarded on its authority, including mine.**

The mechanism is the control's **position in the run.** It executed from 5 s to
121 s, and the walk's own analysis discards everything before 60 s as
unrepresentative warm-up. So the control sat inside the window the analysis
excludes, and was then compared against the filtered walk. Texture bytes were
still falling at t=51 s, mid-control.

The evidence in one line: **18.73 ms parked on the forecourt against 7.32 ms
walking that same forecourt.** Same geometry, same view region. The difference is
the clock, not the pose.

The general form is worth more than the fix: **a control broken in the direction
of more suspicion looks like rigour, which is why it survived so long.** A
flattering broken control gets challenged immediately. One that makes you doubt
your own numbers gets praised for caution.

`QUIET-HOST-PROTOCOL.md` §10a requires the control to run **after** the walk. That
is a fix to the experiment, not to a threshold, and was deliberately kept separate
from the gate question — see §7.

## 6. Suite-wide harness defects, all fixed in my files and still present elsewhere

**Readiness timeouts shorter than a cold load: 25 fatal sites, 31 rAF-starved
polls.** A 120 s wait against a ~280 s cold load reports a perfectly healthy build
as "never became ready" with an empty page console, which reads exactly like a
shader link failure and was diagnosed as one more than once. rAF polling is worse
than useless here, because rAF does not fire reliably while the main thread is
blocked for minutes — the poll is starved during precisely the window it exists to
observe. Correct settings: `{ timeout: 420_000, polling: 500 }`.
`node tools/timeoutaudit.mjs` re-runs the audit; two independent detection methods
agreed at 25 and 31.

**Playwright's `waitForFunction(fn, arg, options)` positional trap.** Passing
options in the second position makes them `arg`, silently defaulting the timeout
to 30 s. **240 in the source, 30 at runtime** — undetectable by reading the
number, so `timeoutaudit.mjs` now flags the two-argument form structurally.

**Captures that fail without failing.** `tools/archive.mjs` hard-fails on zero
dimensions, wrong dimensions and implausible byte counts, asserts
`written.length === requested.length`, and routes the verdict through a
`process.on("exit")` hook because three harnesses called `finalise()` from inside
a teardown array that swallows exceptions. A self-reported failure is exempt from
the throw, **never from the exit code.** It also detects orphan rounds — captures
on disk with no manifest, meaning `finalise()` never ran, which no check living
inside `finalise()` could ever report.

**`assertPrivateBuildDir` / `assertBuildIntact` in `tools/scratch.mjs`.**
`tools/shoot.mjs --system=` (present but empty) resolved `BUILD_DIR` to
`.shot-build/` bare and `emptyOutDir` destroyed two sibling build directories.
Needs no misuse to trigger. Assert immediately before **every** `page.goto`, not
once after the build, because the wipe lands mid-round.

**`grep | tail` reports the pipe's exit code.** This trap has now cost four
agents a round verdict, including me, twice — most recently masking five genuine
test failures behind `exit: 0`. It is still live in anything reading a suite
result through a pipe.

**`tools/cardclear.mjs`** verifies the card is clear before a measurement. `wmic`
does not exist on current Windows builds, so a check built on it **returns
all-clear by failing to look.** This one runs a negative control first — it
queries for a process it knows exists and refuses to report a clear card if that
comes back zero. It found two defects in itself before use, both recorded in
`NOTES.md`; the worse one produced a confident "probably leaked" verdict from an
unparseable date, whose recommended action was killing a sibling's healthy run.

## 7. The one thing I would not do, and why

Three of my own gates failed my own final run. Two of the three were genuinely
defective. **I did not fix them.**

The reason is the sharpest thing I learned here: **the argument "these failures are
unrelated to frame time" only became available after I saw that the frame time was
good.** Had the numbers come back poor, the same conditions would have been
reported as reasons to discard them. A gate whose applicability is decided by
whether you like the output is not a gate.

So the split was: fix the **experiment** (the control's position, §10a), and refer
the **gates** upward. The coordinator then ruled — condition 2 becomes advisory,
because an uncapped renderer pins the card by design and per-process GPU share is
not attributable on WDDM, so it asked for a state no valid run can reach;
conditions 1 and 3 stand as written and were **overridden by an informed project
decision**, which is recorded as that rather than as a relaxed threshold. §11 of
the protocol has both, with the reasoning, so nobody later reads a shipped run as
evidence that 508 MiB of baseline drift is acceptable.

## 8. Deferred with the saving attached, not open items

| item | saving | why deferred |
|---|---|---|
| 8192² shadow map | 240 MB, 957k tris/frame | long crisp low-sun shadows are central to the brief; affordable on a quiet 8 GB card. **First lever if one is needed.** |
| DPR cap | visible | same reasoning |
| RectAreaLight removal | measured *slower* than shipping | no conclusion drawn from a contended host |
| depth-only shadow FBO | 64 MB | 3x margin exists; untested, unclaimed, has a known blocker |
| `worldDetail` program-key collapse | 6 of 193 programs, zero picture cost | **ruled: take it**, gated on two `shaderlint.mjs` prerequisites (see §9) |
| 4 other `customProgramCacheKey` sites | unquantified | safe, possibly wasteful; needs a per-module byte-identity test in four other owners' files |

## 9. Two durable rules

**On program cache keys.** A value belongs in `customProgramCacheKey` **if and only
if it changes a character of the emitted source.** Uniform values are free however
visually significant. Keying on configuration identity is a superset of source
identity: always safe, sometimes wasteful. And the asymmetry that decides the safe
direction —

> **Over-splitting wastes seconds; under-splitting produces a plausible wrong
> frame with no link error and nothing able to attribute it. Collapsing a key is
> only ever safe behind a standing assertion, never behind a one-time
> measurement.**

**On instrument design.** Express a counter in units the reader has intuitions
about and it audits itself. My clamp metric's first version reported **198,992 ms
of lost simulation** and priced it as **278 metres** of ground. The millisecond
figure slides straight past; 278 metres inside a 60-metre forecourt is impossible
on its face, and that is the only reason the bug was caught before publication.
The bug was a category error — a delta of 148 seconds is the frame loop **not
being driven at all** (init, a background tab, a harness blocking the main thread),
not a slow frame. Deltas over 1 s are now counted as `stalls` and never priced,
and the counters reset at the start of the phase of interest.

## 10. Standing tools

```
node tools/cardclear.mjs           # is the card clear? runs a negative control first
node tools/timeoutaudit.mjs        # readiness/nav timeouts and starved polling
node tools/voidcheck.test.mjs      # 40 assertions on the protocol gates
node tools/permute.test.mjs        # 14 assertions on the scatter shuffle
node tools/budget.mjs              # triangles, draws, programs, real texture bytes
node tools/devgate.mjs             # exercises the DEV-only map-channel guard
node tools/stress.mjs --smoke      # one lap; also warms tmp/profiles/stress
```

Two lines for any harness that wants the budget guard, unchanged:

```js
import { recordBudget } from "./budget.mjs";
await recordBudget(page, { tag: "<system>-<round>" });
```

## 11. Final state

`npx tsc --noEmit` clean. Port 5152 free, ports 5150 and 5151 untouched
throughout. No harness browsers left alive; the user's own browser was never
touched. Every measurement in `PERF.md` states the tree hash it was taken against,
because a byte comparison across a tree five agents are editing cannot prove a
no-op.

**`NOTES.md` cases are cited by title, never by number** — 84 cases share 52
numbers because seven agents appended concurrently, and the file is deliberately
not renumbered, since that would invalidate every correct citation already
written.
