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
node tools/coldload.mjs --n=5
```

Run this **first** in the window, not last — see §9.2. It is the cheapest item
and the highest-risk one, so it is the only ordering that can save the window
rather than just fill it.

The 20-minute run loads the scene exactly once, so it says nothing about whether
a load *reliably* succeeds — and the deliverable is a single continuous take that
has to survive init on the user's machine, once, with no second attempt.

This is not hypothetical. Under contention, four cold loads gave: **one hard
`Page crashed` on `page.goto`**, and later **one timeout at 171.9 s against 21.9 s
and 30.9 s for the two that succeeded** — a 5–8× outlier on the same bundle
minutes apart. Both faults match what two sibling agents independently reported.
Neither can be separated from contention on a loaded host, which is exactly why
they belong here.

**Pass: 5 of 5 loads reach `__SCENE_READY`, and the spread across loads 2–5 is
within 2× of the fastest of them.** A single crash or timeout on a quiet host is
a deliverable blocker and outranks every frame-time number in this document.

### 2.2 The first load is a separate measurement, and it may be the real answer

Rehearsing §2.1 turned up a pattern that changes how it must be read. **Across
three independent sequences the first load was the worst every time:**

| Sequence | Load 1 | Load 2 | Load 3 |
| --- | --- | --- | --- |
| cold-load rehearsal | **218.7 s** | 20.8 s | 21.3 s |
| earlier probe | **171.9 s (timed out)** | 30.9 s | 21.9 s |
| first probe | **hard `Page crashed`** | — | — |

Three for three is not the shape of random contention. Candidates include the
preview server's first-request cost, the browser's first GPU context and shader
cache, and OS file cache — several of which the user's machine would also pay.

**This matters more than anything else in this document, because the user's run
is a first load.** The ~21 s init figure quoted everywhere is a *warm repeat*. If
first-load cost is systematic rather than contention, the number the user
experiences has never been measured and is somewhere between 21 s and 219 s.

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

### 9.1 My two runs

| Step | Quiet-host estimate | Basis |
| --- | --- | --- |
| §1 preconditions, including the 30 s drift sample | ~1.5 min | measured |
| §2.1 cold loads, 5 × cold init | **5–12 min** | 21–31 s each when healthy; the rehearsal's first load alone took 218.7 s, and a timeout costs 2.5 min |
| §2 the 20-minute run (build + 30 s baseline + ~21 s init + 20 min route + report) | **~23–25 min** | rehearsal was 7.9 min with a 3-minute route; the build took ~4 min under contention and should be faster quiet |
| **Total** | **~30–39 min** | |

Budget **45 minutes** for mine, to absorb one cold-load timeout without
re-opening the window.

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
