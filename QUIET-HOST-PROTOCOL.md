# The quiet-host frametime protocol

**Status: written, not run.** It needs an exclusive window on the GPU, which is a
coordination action the orchestrator calls. Nothing in here should be executed
until every sibling agent is stopped.

**Purpose.** Produce the project's first quotable frame-time numbers, and answer
one question that currently has two explanations fitting every measurement:
**does this scene hitch, or does the host?**

Every frame-time figure taken so far is void. The proof is not an argument, it is
a control: the camera **parked and completely static** measured a mean of
19.78 ms while the same run's **moving** median was 11.4 ms. A static frame cannot
be slower than a moving one if the scene is the bottleneck, so the scene was not
the bottleneck — six agents rendering concurrently were, at 95–100% GPU
utilisation throughout. See `PERF.md` §13.4.

This document is deliberately decision-free. During the window there is nothing
else running to answer a question with, so every choice is made here in advance.

---

## 1. Preconditions — verify, do not assume

Run these and **read the output** before starting. If any check fails, stop and
report rather than proceeding: a run taken on a host that was not actually quiet
is worse than no run, because it produces quotable-looking numbers that are not.

```bash
# 1. No other Chromium anywhere. Expect 0.
powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\").Count"

# 2. No sibling dev/preview servers. Expect no LISTENING lines.
netstat -ano | grep -E ':(5112|5113|5116|5119|5125|5131|5132|5150|5151)\s+.*LISTENING'

# 3. The card is idle and nearly empty. Expect utilisation < 5% and
#    used < 1500 MiB (desktop compositor only).
nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader

# 4. Sample the card for 30 s and confirm it is STABLE, not just low.
#    Expect peak-to-trough drift < 100 MiB.
for i in $(seq 1 30); do nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; sleep 1; done
```

**Hard gate: if check 4 shows drift above 100 MiB, the host is not quiet.** The
drift figure is the error bar on everything else; a run whose baseline moves by
1171 MiB — which has happened here — has no readable card numbers at all, and its
frame times are equally suspect.

Also confirm nothing of the user's is mid-session on port 5150 or 5151, and that
the user is not playing the scene themselves. **Never kill `node.exe` broadly.**

---

## 2. The run — one command, three phases

```bash
node tools/stress.mjs --minutes=20 --park=120 --baseline=30000 --tag=quiet
```

That is the whole run. It takes roughly 25 minutes including build and init.

| Flag | Value | Why exactly this |
| --- | --- | --- |
| `--park=120` | 120 s | The control. **Two minutes, not twenty seconds.** The existing 20 s control gave 929 frames, and at the walk's 0.78% rate of frames over 100 ms that window expects only ~7 — too few to distinguish 0 from 7 confidently in the other direction. 120 s gives ~6,000 static frames, enough for the absence of long frames to mean something. |
| `--minutes=20` | 20 min | Multiple laps of every phase. **Recurrence across laps is the whole test** (§4). One lap cannot distinguish a place from a moment; this is the mistake this protocol exists to avoid repeating. |
| `--baseline=30000` | 30 s | Card sampled before the browser launches, to measure the host's own drift and provide the error bar. |
| build | default (on) | **Do not pass `--no-build`.** The run must describe the tree as it stands, and a stale bundle silently answers a question about a different program. |

Do **not** run anything else in the window — no second harness, no capture round,
no `nvidia-smi` polling loop of your own. The harness samples the card itself.

### 2.1 Then: five cold loads, because init reliability is a separate question

```bash
node tools/firstload.mjs --n=5
```

Run this **first** in the window, not last — see §9.2. It is the cheapest item
and the highest-risk one, so it is the only ordering that can save the window
rather than just fill it.

**Which instrument, and why this one.** There are now **three** in this space,
answering three different questions. They must not be conflated, and none should
be run as a substitute for another:

- **`tools/firstload.mjs` (this one, mine)** — *is the first load slow, and how
  slow?* Every attempt runs a byte-identical path, with the GPU check moved
  outside the timed window, because the earlier version's asymmetry was a real
  confound (`PERF.md` §13.9.1). This is the measurement, and it is the one the
  pass criteria below are written against.
- **`tools/coldload.mjs` (Film's)** — *why is it slow?* Three conditions
  differing in one variable each, the decisive one being **same profile with the
  HTTP cache bypassed via CDP**, which separates bundle transfer from compiled
  shaders. Better than anything I would have written for the mechanism, and it
  also reports where time goes inside a load and defines walkable as thirty
  consecutive frames under 25 ms.

- **`tools/bootshots.mjs` (the loading-screen agent's, port 5163)** — *does the
  overlay behave during a slow load?* Screencast-based via CDP
  `Page.startScreencast`, which is why it can see inside init at all. **A third
  question again**, and the source of the 283.8 s cold figure and the 771
  compositor-frame series.

**Do not run any of these as "the cold-load measurement".** One run each, for its
own question. If the window is tight, `firstload.mjs` is the one that gates the
deliverable; the mechanism and the overlay behaviour can both be established
outside a quiet window, because **a 12× effect is not going to hide behind
contention** — contention is now bounded at 10–40% on a warm load.

**Ports:** mine is **5152**. Film's `coldload.mjs` is on **5171** and the boot
harness on **5163**. The user is live on **5199** — leave it alone. (An earlier
revision of Film's tool bound 5151, a sibling's port; that has been changed.)

**One coupling that will break silently if anyone tidies it:** Film's harness
times the first frame by watching for the removal of `#loading` from
`index.html`. That element is a zero-size marker with no other purpose, so it
looks removable and is not. If it goes, the MutationObserver never fires and the
harness reports no first-frame time **while otherwise succeeding**. Documented at
the element itself now, with all six dependents listed, rather than only in a
report.

The 20-minute run loads the scene exactly once, so it says nothing about whether
a load *reliably* succeeds — and the deliverable is a single continuous take that
has to survive init on the user's machine, once, with no second attempt.

This is not hypothetical. Under contention, four cold loads gave: **one hard
`Page crashed` on `page.goto`**, and later **one timeout at 171.9 s against 21.9 s
and 30.9 s for the two that succeeded** — a 5–8× outlier on the same bundle
minutes apart. Both faults match what two sibling agents independently reported.
Neither can be separated from contention on a loaded host, which is exactly why
they belong here.

**Pass criteria, with the two regimes scored separately** — because the cold and
warm loads are now known to be different measurements, not a spread:

| Measurement | Pass | Marginal | Fail |
| --- | --- | --- | --- |
| All 5 loads reach `__SCENE_READY` | 5 of 5 | — | any crash or timeout |
| **Cold load (attempt 1)** | ≤ 60 s | ≤ 180 s | > 180 s |
| Warm loads (2–5), spread | within 2× of fastest | ≤ 2.5× | > 2.5× |
| Warm load median | ≤ 25 s | ≤ 35 s | > 35 s |

The cold thresholds are set against what is now measured five times over —
279.1 s, 283.8 s, 218.7 s, 171.9 s and one crash — so **the honest expectation is
that the cold row FAILS on a quiet host too.** That is the point: it is a
deliverable defect with a number attached, not a criterion tuned to be passable.
The warm rows exist to confirm the two regimes stay distinguishable, since a warm
figure drifting toward the cold one would mean the mechanism had changed.

A crash or timeout on a quiet host outranks every frame-time number in this
document.

**Contention allowance, now bounded.** The boot agent's warm loads under heavy
GPU contention were 22.5–30.1 s against 20.8–25.4 s quieter, so contention costs
a warm load roughly **10–40%, not a factor**. The marginal columns absorb that,
which means a *fail* here cannot be explained away as host noise.

### 2.2 The first load is a separate measurement, and it may be the real answer

Rehearsing §2.1 turned up a pattern that changes how it must be read. **Across
four independent sequences the first load was the worst every time:**

| Sequence | Load 1 | Load 2 | Load 3 | Load 4 |
| --- | --- | --- | --- | --- |
| `firstload.mjs`, symmetric path | **279.1 s** | 25.4 s | 23.3 s | 21.7 s |
| cold-load rehearsal | **218.7 s** | 20.8 s | 21.3 s | — |
| earlier probe | **171.9 s (timed out)** | 30.9 s | 21.9 s | — |
| first probe | **hard `Page crashed`** | — | — | — |

The first row is the one that matters: the earlier rows had a confound — attempt
1 allocated an extra WebGL2 context inside its own timed window — and removing it
made the effect **larger**, at 12.0× the median of the repeats. See `PERF.md`
§13.9.

It is per-**browser-process**, not per-machine: every fresh launch paid it,
minutes apart, same driver. That rules out the NVIDIA machine-level shader cache
and points at Chrome's per-profile GPU program cache, which Playwright discards
on every launch and a real user keeps.

**This matters more than anything else in this document, because the user's run
is a first load.** The ~21 s init figure quoted everywhere is a *warm repeat* —
and that is now established rather than suspected: `stress.mjs` loads the app in
a throwaway GPU-check page before its measured page exists, so **every init
figure this project has published, including the 8.3% shader-compilation share
and the per-system init table, was measured warm.** The number the user
experiences is 172–279 s and no harness here could previously observe it.

So the criterion scores it separately rather than treating it as an outlier: the
spread limit applies to loads 2–5, and load 1's absolute time and its ratio to
the repeat median are reported prominently. `tools/coldload.mjs` prints it as
`FIRST LOAD` with the reminder attached. Treating it as noise would have
discarded the most deliverable-relevant number here as a harness fault.

**On the quiet host, the question to answer is whether load 1 is still 3–10× the
repeats.** If it is, that is a real finding about what the user will experience
and it needs its own work. If it collapses to parity, it was contention and the
warm figure stands.

---

## 3. What to sample

All of it comes out of that one command; nothing extra needs wiring.

- **Frame times**, per phase, with mean / median / p95 / 1% low / max and counts
  over 33, 100 and 250 ms.
- **The parked control**, reported separately and never merged into the walk.
- **Card VRAM by phase**, with the pre-launch baseline and its drift.
- **GL bytes, geometries, programs, framebuffers, JS heap** at ready and at end.
- **Worst-frame table** with time, lap, phase and position for each.
- The full JSON record in `tools/perf-out/stress-quiet-*.json`.

---

## 4. Pass criteria

Decided now, so that no criterion can be chosen after seeing the numbers.

### 4.1 Does the run count at all?

**These are evaluated in code, not by eye.** `tools/voidcheck.mjs` implements
them and `tools/stress.mjs` prints the verdict at the top of its report, before
any number the verdict governs. They were prose here first, and prose gates do
not fire — see §8.

The run is **void** and must be repeated if any of these hold:

1. **Baseline drift ≥ 100 MiB** during the 30 s pre-launch window.
2. **Mean GPU utilisation during the parked control ≥ 50%.** With the camera
   static and one browser on an idle card this should be low; if it is high,
   something else was on the GPU and the window was not exclusive.
3. **Any card phase after launch has a minimum below the baseline mean.** That
   can only be another process releasing memory, so the window was not
   exclusive. *("After launch" is a correction: as first written this said "any
   card phase", which includes the baseline phase itself — whose own minimum is
   below its own mean by construction. It would have voided every run ever
   taken. See §8.)*
4. **The parked control mean exceeds the walking median.** This is the specific
   inversion that voided every previous run. If it reappears, the host is still
   the bottleneck and no frame-time number from the run may be quoted.
5. The scene fails to reach ready, the page crashes, or the browser disconnects.
   That is a different and more serious result — report it as a crash, not as a
   frametime run.

### 4.2 If the run counts, the deliverable criteria

The product is a continuous 15–20 s first-person take through pump, door and
fridge, so the criteria are about *sustained* frames, not averages.

| | Pass | Marginal | Fail |
| --- | --- | --- | --- |
| Median frame time, walking | ≤ 13.9 ms (72 fps) | ≤ 20 ms | > 20 ms |
| p95, walking | ≤ 16.7 ms | ≤ 25 ms | > 25 ms |
| Frames > 33 ms | < 0.5% | < 2% | ≥ 2% |
| **Frames > 100 ms** | **0** | ≤ 2 per 20 min | > 2 per 20 min |
| Frames > 250 ms | 0 | 0 | any |

**The >100 ms row is the deliverable criterion and the others are context.** A
single 200 ms frame is a visible stutter in a 20-second take, and the take cannot
be re-rolled indefinitely on the user's machine.

### 4.3 What the parked control must show for the run to be interpretable

The control is not a performance measurement, it is what makes the walk one.

- **Required: 0 frames over 100 ms in the ~6,000 parked frames.** If the static
  camera produces long frames on a quiet host, the long frames are not motion,
  not streaming and not the scene's geometry — and the *walking* numbers cannot
  then be attributed to walking.
- **Required: parked p95 below the walking median.** If a static frame is not
  comfortably cheaper than a moving one, the run is measuring something other
  than the scene.
- Parked mean is expected around 8–11 ms (the scene's floor with no motion). A
  parked mean near the previous 19.78 ms on a quiet host would mean the floor
  itself is expensive, which is a different and larger finding — report it as
  such rather than folding it into the walk.

---

## 5. How to read the result — the question, and the trap

**If the run counts and >100 ms frames are 0:** the scene holds framerate, the
deliverable is unblocked on performance grounds, and the hitches seen so far were
contention. Say so plainly and close the item.

**If >100 ms frames persist, the next question is where — and the test is
recurrence, not location.**

Take the phase table and ask whether long frames concentrate in the **same phase
across every lap**. That is the only form of evidence that separates the two
explanations, and it is the specific trap this protocol is written around:

> A one-lap run already produced twelve worst frames in one phase, in a
> four-second window, at a nearly fixed position, with an ordinary draw count and
> a plausible mechanism waiting for it. It was **wrong**. Over multiple laps the
> concentration moved to a different phase in a different lap. A cluster that is
> tight in *time* but moves in *space* between laps is an external event; the
> position is just wherever the camera happened to be. In a single lap the
> clustering is guaranteed by construction whatever the cause.

So:

- **Same phase, every lap** → scene-side. Attribute it, and only then look for a
  mechanism.
- **Different phase each lap, tight in time** → external, even on a quiet host
  (a driver event, a compositor stall, Windows doing something). Not the scene.
- **Spread evenly across all phases** → a per-frame cost, not a hitch. Look at
  the steady-state numbers instead.

Do not name a mechanism before the recurrence test has run. Candidates that fit
the magnitude are not evidence, and a mechanism named without a magnitude blocks
other agents' work rather than informing it.

---

## 6. If the answer is "the scene hitches", the levers already priced

Nothing here needs re-measuring first:

| Lever | Effect | Note |
| --- | --- | --- |
| Shoot the take on the forecourt, not the store interior | forecourt median 7.7–9.7 ms vs cooler poses ~30 ms | Free. Robust under contention because it is a relative measurement, and already with Film. |
| Shadow cascade membership for Terrain's 24,000 stones | 60.5 drawn triangles per stone, into the cascades | Terrain's decision. The lever is which cascades gravel casts into, not the mesh. |
| 8192² shadow map → smaller | 256 MB and 957k triangles/frame | Deliberate deferral; visible change, close to the brief. |
| DPR cap | visible change | Deferred for the same reason. |

Memory needs no lever: GL peak is 757.07 MB against 748.77 MB steady, reproduced
to the byte across two runs, on a card with roughly a 3× margin once quiet.

---

## 7. Rehearsal status

Rehearsed end to end on a **contended** host, deliberately, with `--rehearsal`
so no output can later be mistaken for a result. Every number the rehearsal
produced is void by construction; what was being tested is the harness.

**Preconditions (§1): all four correctly refused the host** — 32 Chromium
processes against an expected 0, four sibling servers listening, 6391 of
8188 MiB used, and 162 MiB of drift in a 10-second sample against the 100 MiB
gate.

**The cold-load harness (§2.1), shortened to 3 loads:** ran, and its criterion is
measurable — it reported a 10.5× spread and failed correctly. It also produced
the first-load finding in §2.2, which is the most valuable thing the rehearsal
turned up.

**The run (§2), shortened to `--minutes=3 --park=25 --baseline=12000`:** completed
in 7.9 min, reached ready in 21.1 s, and **four of the five void conditions fired
on live data**:

| # | Condition | Rehearsal value | Limit |
| --- | --- | --- | --- |
| 1 | baseline drift | **237 MiB** | 100 |
| 2 | GPU busy while parked | **100%** | 50 |
| 3 | phase min below baseline | every post-launch phase, e.g. init 3917 vs baseline 6652 MiB | none allowed |
| 4 | parked mean above walking median | **parked 21.11 ms vs walking median 9.7 ms** | — |
| 5 | run did not complete | did not fire; the run completed | — |

Condition 5 was forced in the unit tests instead, across all five of its sub-cases.
Every condition has now been observed to fire.

Only durations were shortened, never a code path: `--minutes=3` still exceeds
`60 s + park`, so the steady-state window that condition 4 reads from is
genuinely populated.

**The rehearsal found two real defects, which is what it was for:**

1. **Condition 3 was wrong as written**, not merely unexecuted. "Any card phase
   has a minimum below the baseline mean" includes the `baseline` phase itself,
   whose own minimum is below its own mean by construction — so the gate would
   have voided **every run ever taken**. Caught by the deliberate clean-run
   control in the test, not by the four cases designed to make gates fire.
2. **The verdict printed a fired condition as `ok` and then again as `VOID`**,
   because the record of evaluated conditions includes the violated ones. Four
   `ok` lines above four `VOID` lines is a report a skimming reader closes as a
   pass. Now a condition prints once, and `ok` means it passed.

3. **The §2.1 spread criterion was measuring the wrong thing** — it would have
   failed on the systematic first-load cost in §2.2 and reported the most
   deliverable-relevant number in this document as a harness fault.

All three are the same shape as the fault this protocol exists to prevent,
arriving one level up: **the safeguard itself needed a control and a rehearsal.**

---

## 8. Why the conditions are code and not this document

They were prose here first. Five numbered thresholds that someone would have to
remember, locate in a 60-line report, and apply by eye — after a 25-minute run,
in a window where the whole project is stopped and waiting.

That is precisely the failure mode documented across `NOTES.md`: **a check that
is present, correct, and never executed.** A void condition nobody evaluates is
not a safeguard, it is a paragraph, and the contended run it should have
discarded gets argued about instead.

So `tools/voidcheck.mjs` implements them as a pure function over the run record,
`tools/stress.mjs` prints the verdict **above** the numbers it governs, and
`tools/voidcheck.test.mjs` forces each condition plus a clean-run control. One
design point is load-bearing: a condition whose inputs are missing is reported
as **`UNKNOWN`, not as passing**, and makes the run void. Otherwise a run with no
VRAM sampling at all would sail through all three memory gates by having nothing
to test.

---

## 9. What the window costs, and how to schedule it

### 9.0 Final scheduling decision — §2.1 leaves the quiet block

**`firstload.mjs` runs in the contended phase, not the quiet block.** The
reasoning is in NOTES case 66 and the short form is this: contention only
inflates, so a contended cold load of ~279 s discounted by the largest contention
penalty ever measured here (40%) is still ≥ 199 s against a 180 s fail threshold.
**The FAIL is robust with a 99 s margin.** Confirming a known failure with a
magnitude is contention-tolerant work.

Two limits I am accepting explicitly by making this choice:

- **The pass is not purchasable in this phase.** When a fix lands, its
  verification run needs the quiet host, because distinguishing 70 s contended
  from 50 s quiet is exactly what contention prevents. Same command, same
  criteria, different phase — the direction the answer points decides.
- **A crash in this phase is uninformative.** Cold loads have crashed under
  contention before. If it happens I will report it as unattributable rather than
  as the strongest version of the finding.

This buys the quiet block back **5–12 minutes** and spends them on frametime,
which is the one measurement that provably cannot survive a busy host: the parked
control has produced 11.8 ms and 122.8 ms for the *identical static frame* in the
same run.

### 9.1 My two runs

| Step | Quiet-host estimate | Basis |
| --- | --- | --- |
| §1 preconditions, including the 30 s drift sample | ~1.5 min | measured |
| §2.1 cold loads, 5 × cold init | **5–12 min** | 21–31 s each when healthy; the rehearsal's first load alone took 218.7 s, and a timeout costs 2.5 min |
| §2 the 20-minute run (build + 30 s baseline + ~21 s init + 20 min route + report) | **~23–25 min** | rehearsal was 7.9 min with a 3-minute route; the build took ~4 min under contention and should be faster quiet |
| **Total** | **~30–39 min** | |

With §2.1 moved to the contended phase, **the quiet block needs only §1 + §2:
~25 minutes. Budget 30.**

### 9.1.1 What the quiet block must look like

**Film's unscripted playtest immediately before me is fine, and I prefer it to a
cold card.** Two reasons, both measurable:

- A card that has been rendering for twenty minutes is at thermal and clock steady
  state. **A cold card gives boost clocks that flatter the first minute of a
  twenty-minute run** and then decay into it, which would show up as a downward
  frametime drift I would have to spend the run explaining. Film's playtest puts
  the GPU in the state the user's own session will actually be in.
- It warms the driver shader cache, so my run loads warm in ~21 s instead of
  spending ~280 s on a cold init before the route even starts. **Nobody should
  "helpfully" clear the browser profile before my run** — a cold profile would cost
  the block a quarter of an hour and measure nothing I want.

Three hard requirements, in order:

1. **Every one of Film's browser processes fully exited, confirmed by process
   list, not by the harness reporting completion.** My VRAM accounting is
   baseline-relative, so a residual Chromium holding VRAM inflates my baseline and
   then void condition 3 fires on its teardown — the run would void for a reason
   that has nothing to do with the scene.
2. **~90 s settle after the last exit**, before I sample baseline, for VRAM to
   release and fans/clocks to normalise.
3. **Then my 30 s baseline drift sample**, which is the error bar every card
   figure in the run is quoted against.

**Precondition, and it must happen BEFORE the block opens:** warm the `stress`
profile. `stress.mjs` now launches against a persistent profile at
`tmp/profiles/stress`, because **shader-cache warmth is a property of the profile
directory, not of the machine** — every fresh `mkdtemp` profile measures 192–349 s
cold on a host that has compiled these exact shaders many times. An ephemeral
launch therefore pays the full cold compile on every run, which is 5–6 minutes of
a 30-minute block spent on setup budgeted at twenty seconds.

The profile prints `FIRST USE` on its first run. **If the block opens on a
first-use profile, close the window and warm it first** — warming is
contention-tolerant (it only has to populate a cache) so it belongs in the
contended phase, not in the quiet one.

### 9.1.2 `bootshots.mjs`: outside, with one caveat worth 5 minutes

The overlay question — does the progress indicator keep moving during a slow load
— **belongs in the contended phase**, and is arguably better answered there:
overlays exist to reassure a user during a bad load, and a contended host produces
a worse load. Its animations run on the compositor thread by design, so the
measurement is qualitative and contention-tolerant.

**The caveat is the part that is mine.** Its frame-arrival series is my init
attribution input, and gap *magnitudes* in a contended series are upper bounds
polluted by other processes' stalls. So: take the contended series now as an
indicative map of where the process stalls, and if the quiet block has five
minutes spare at the end, **one cold screencast load inside it converts that
series from indicative to trustworthy** for the price of a single cold init. Worth
it, but not worth displacing any part of §2.

### 9.1.3 The route must exercise the three new inputs, or it measures a dead build

A "press E" prompt, shift-to-sprint and space-to-jump are landing immediately
before this run. **Measuring before they land describes a build that no longer
exists**, so §2 runs after, and the route changes as follows.

The autopilot dispatches real `KeyboardEvent`s by `code` (`tools/stress-drive.js`
lines 58/64), so `ShiftLeft` and `Space` go through the real input path with no
special-casing — one line each, and no harness privilege that a player would not
have.

| Addition | Why it changes *my* numbers, specifically |
| --- | --- |
| **Sprint (`ShiftLeft`)** | The one I expect to matter most, and it is not a per-frame cost argument. Higher speed means the camera crosses shadow-cascade boundaries and any streaming threshold **more times per unit time**, so *hitch frequency* scales with speed even if per-hitch cost is unchanged. A 20-minute walk-speed route systematically undercounts hitches for a player who sprints. **The route needs a sustained sprint leg**, not a token one. |
| **Jump (`Space`)** | Makes collision three-dimensional, adds a grounded test per frame, and puts the camera at heights nothing has been measured from. Terrain LOD and cascade selection have only ever been sampled from eye height on the ground. |
| **"Press E" prompt** | Cheap unless it writes to the DOM every frame. A per-frame `textContent` write is a layout-thrash and per-frame-allocation source, and it would land in the 1% low rather than the mean. Advisory to the owner, not my file: **write only when the string changes.** |

**Measured costs of the three additions, from Interaction:** hover ray 188 µs per
frame over 2157 samples, `PlayerSystem.update()` 28.3 µs standing and 29.5 µs
sprinting-and-hopping. Total ~0.22 ms, or **1.3% of a 16.7 ms budget, and zero
shader programs** — so they add nothing to the compile-time family and sit inside
run-to-run noise for the mean. They still have to be *present*, because the
argument for measuring after they land was never about the mean: sprint changes
hitch *frequency* by crossing cascade boundaries faster, which no per-frame
microbenchmark can show.

**A route requirement that came out of Interaction's own bug, and it applies
directly to my autopilot.** Its `update()` polled a key Set once per frame, so a
press that began *and ended* between two frames was never observed — five taps
produced zero jumps while a held key hopped fine. It manifests only on long
frames, which is precisely what a frametime run under load produces.

So the route must **hold every key across at least two frames and never tap
within a tick.** `tools/stress-drive.js` already does this for movement, since
`hold()` and `release()` are separate calls separated by real time. Any jump leg
must follow that shape rather than dispatching `keydown`+`keyup` together — a
route that taps would silently produce zero jumps, and the run would report a
clean frametime for a leg that never happened.

One interaction worth flagging beyond frametime: **jump may change the
reachability conclusions**, including the cooler pinch routed to Building. A 40 mm
horizontal pinch is not opened by jumping, but a step-up or mantle would be, and
"unreachable on foot" was measured against a walking controller that could not
leave the ground. Worth re-running the reachability sweep once jump lands rather
than assuming either way.

### 9.2 Ordering with Film, and the overlap question

**Overlap voids my run categorically — not marginally.** Two concurrent capture
runs would fire conditions 1, 2 and 3 together: the drift gate, the parked-GPU
gate, and the phase-minimum gate all detect exactly "another process is using
this card". The rehearsal above is what that looks like. **So the window must be
strictly serial**, and my §2 baseline must be sampled only after Film's browsers
have fully exited, or condition 3 fires on their teardown.

Recommended order, and the reasoning rather than just the answer:

1. **My §2.1 cold loads first — 5–12 minutes.** This is the highest-risk item in
   the project and the cheapest to run. If init is unreliable, **Film needs to
   know before it spends ten minutes on a take that may not survive its own
   load.** Running this first is the only ordering that can save the window
   rather than just fill it.
2. **Film's two runs — `filmwalk` and `walkprobe`, ~20 minutes.** Film's runs do
   not invalidate anything of mine as long as they do not overlap: they write
   into `shots/` and change nothing about the scene. And a successful continuous
   take is itself deliverable-level evidence that the scene survives init and
   holds framerate — my §2 run is the instrumented version of the same question,
   not a substitute for it.
3. **My §2 twenty-minute run last — ~25 minutes.** It is diagnostic. Nothing
   inside the window depends on its result, so it should not stand in front of
   anything that does.

**Total for one quiescence: ~55–70 minutes.**

One ask of Film, worth two lines in its harness: record **whether the run reached
ready, and how long init took**. If the window runs short and my §2 run is cut,
those two numbers still give an init data point from the run that matters most.

---

## 10. Report

State, in this order: whether the run counted and against which of §4.1's five
conditions; the parked control and whether it met §4.3; the walking numbers
against §4.2; and the recurrence verdict from §5 with the per-lap phase evidence
rather than a summary of it. If any criterion was missed, say which and by how
much — **a criterion adjusted after the fact is not a criterion.**

## 10a. REQUIRED FIX before the next run: the parked control must run LAST

The window run of 2026-08-29 was void on four conditions, and one of them
(condition 4, parked mean above walking median) fired because **the parked control
executes from 5 s to 121 s** while the walk analysis discards everything before
60 s as warm-up. The control therefore sat inside the window the analysis excludes,
and was compared against a filtered walk. Texture bytes were still falling at
t=51 s, mid-control.

Measured consequence: the parked pose read 18.73 ms while *walking the same
forecourt* read 7.32 ms. Same geometry, same view region; the difference is the
clock, not the pose.

**So `--park` must place its window after the walk, not before it.** This is a
change to the experiment, not to a threshold — it does not alter any pass
criterion, and it is required before any parked figure or 1% low from this
protocol can be quoted.

Two gate questions are deliberately left open for the coordinator rather than
edited here, because both would change whether the run that found them passes:

- **Condition 2 (`>50% GPU utilisation while parked`) cannot pass.** This renderer
  has no frame cap, so it saturates the card whenever the scene is up, on a
  perfectly quiet host. The condition wants *another process's* share, which
  `nvidia-smi` cannot attribute per process on WDDM. Correct verdict is therefore
  UNKNOWN rather than VOID.
- **Condition 4's threshold** may still be wrong once the ordering is fixed, since
  a fixed pose can legitimately be more expensive than a route median.

Relaxing either immediately after it failed a run is the move this protocol exists
to prevent.

## 11. Rulings of 2026-08-29, and the decision to ship without a clean run

### 11.1 Condition 2 is advisory, by ruling. The threshold was not touched.

`>50% GPU utilisation while parked` **no longer votes.** It is printed as a note.

It was written to detect another process competing for the card, on the premise
that a static camera cannot pin the GPU. **The premise is false for this build:**
the renderer has no frame cap, so it renders as fast as the card allows and pins
utilisation near 100% whenever the scene is up — parked or walking, on a
perfectly quiet host. It measured 99% during the only exclusive quiet window this
project ever got.

The quantity it actually wants is **unmeasurable with the instrument available**:
`nvidia-smi` does not attribute GPU utilisation per process on WDDM, so card-wide
utilisation cannot be split into ours and theirs. Measuring it for real needs a
per-process source — PresentMon, or GPU timer queries inside the page.

A gate that no valid run can pass is not a gate, it is a permanent failure, and
it dilutes the conditions that do mean something. **So the verdict changed and
the threshold did not.** `voidcheck.test.mjs` now asserts the opposite of what it
originally asserted for this condition, deliberately and with the reason recorded
at the assertion.

### 11.2 Conditions 1 and 3 stand as written, and were overridden by decision

Conditions 1 and 3 fired correctly on the window run: **508 MiB of pre-launch
baseline drift with nothing of ours on the card**, and phase minima below the
baseline mean as a consequence. That is exactly the state they exist to catch, and
the VRAM figures from that run are therefore not attributable.

The project was offered a clean 25-minute re-run — requiring the user's browser
closed — and **declined it, informed that it would buy VRAM attribution only,
because the stability result and the clamp figures do not depend on it.**

This is recorded here in the form it actually took: **a project decision to ship
without satisfying a valid gate.** It is not evidence that 508 MiB of drift is
acceptable, and the thresholds must not be read as negotiable because a run once
shipped without meeting them. If anyone later needs a defensible VRAM number for
this scene, the gate is still the gate and the run still has to be done.
