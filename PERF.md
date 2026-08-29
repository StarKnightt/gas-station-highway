# Performance and stability

Measured with `tools/perf.mjs` on the target machine (Ryzen 5 7600X, RTX 4060),
Chromium via ANGLE/D3D11. `UNMASKED_RENDERER_WEBGL` is verified as
`NVIDIA GeForce RTX 4060 (0x00002808) Direct3D11` **on the live rendering
context after the scene is ready**, not on a throwaway canvas at launch — see
`assertSceneGpu` in `tools/gpu.mjs` and the NOTES case on why the difference
matters.

**Read the contention warning in section 2 before quoting any millisecond
figure.** Six agents were capturing on the same card throughout. Counts are
trustworthy; times are not.

Numbers below are from a full re-measurement taken after tonight's landings
(world-capture PMREM environment, vegetation ground mat, per-pixel-clipped
standing water, scene-wide collision).

---

## 1. Baseline

`1920x1080`, `devicePixelRatio` 1, full scene.

| | | since the first measurement |
|---|---|---|
| init to `__SCENE_READY` | 26.3 s | 26.0 s |
| peak JS heap during generation | 81.6 MB | 59.4 MB |
| scene graph | 354 drawables in 11 roots, 332 geometries, 199 materials, 113 textures | 342 / 324 / 196 / 112 |
| lights | 21, of which 1 casts a shadow (`DirectionalLight "sun"`, 8192x8192) | unchanged |
| triangles in the scene | 1,873,499 | 1,758,868 (+6.5%) |
| draw calls / frame, widest pose | 517 | 505 |
| triangles / frame, widest pose | 3,020,020 | 2,788,666 |
| shader programs | **144** | 70 (doubled) |
| **GL texture memory, live** | **717.13 MB** | 710.48 MB |
| GL buffer memory, live | 51.43 MB | 48.59 MB |
| renderbuffers | 4.59 MB | 3 MB |
| texture bytes uploaded during init | 732.98 MB | 1228.48 MB |
| transient during generation | **15.85 MB** | see §5 |
| framebuffers | 23 created, 16 deleted | 8 / 3 |
| `readPixels` | 27, all during init | 19 |
| content-duplicate textures | **0** | 0 |
| default framebuffer | 71 MB here; 284 MB at DPR 2, 505 MB on a 1440p window at DPR 2 | unchanged |

Three of those rows deserve comment.

**The scene graph accounts for 378 MB of textures; the GPU holds 717 MB.** The
missing 339 MB is allocated by three on the project's behalf — the shadow map,
PMREM targets — and is invisible to any audit that walks the scene. It is also
where the largest single allocations are.

**Shader programs doubled, from 70 to 144.** Programs cost compile time (the
first frame that needs a variant stalls on it) and driver memory. Nothing was
measured going wrong because of it, but it is the single biggest proportional
change of the night and nobody appears to have intended it. Worth an owner
looking at whether a material is being permuted per-instance somewhere.

**The default framebuffer is another 71–505 MB depending on the display**, and
nothing running inside the page can see it: it is not a `THREE.Texture` and
never passes through `texImage2D`. It scales with the square of the pixel ratio,
and every headless capture in this repo runs at the cheapest possible setting.
`Game.ts` logs the real figure at startup, so the user's actual number is one
console line away.

### Texture size distribution

```
512x512   x57     1024x1024 x26     256x256  x8      1024x512 x7
2048x2048 x6      512x256   x2      768x1024 x1      4096x104 x1
2048x135  x1      1024x267  x1      448x531  x1      336x256  x1      1024x32 x1
```

Largest: six 2048² maps at 21.33 MB each (128 MB total, all ground — highway and
lot albedo/normal/roughness), then a 3072x2204 site overlay at 34.44 MB, then
the 768x1024 PMREM environment at 6 MB shared by 349 materials.

Four texture *sources* are bound under more than one `THREE.Texture`, which is
free. **Zero content-duplicate groups** — no two distinct sources hold
byte-identical pixels. There is no duplicate texture waste in this scene.

---

## 2. Stability over time: nothing leaks

Three minutes of walking with the real `PlayerSystem`, sampling every 3 s.

```
growth: heap 3.256 MB/min (r2 0.094)   glTex 0 MB/min   glBuf 0 MB/min
        geometries 0/min   textures 0/min   programs 0/min   listeners -0.03/min
steady state: texture uploads on 0 frames, buffer uploads on 0 frames,
              0 late program links, 0 readPixels
allocation sampling: 3.81 MB over three minutes (1.27 MB/min), the largest
              single site being the measurement probe's own tick
```

Every GPU-side counter is *exactly* flat across 17,935 frames. The heap
oscillates in a GC sawtooth with an r² of 0.094, meaning the fitted line
explains 9% of the variance and is a fit to noise.

**Nothing in this scene allocates per frame, rebuilds geometry per frame, or
churns render targets**, and GC pressure is a non-issue at 1.27 MB/min.

### The listener "leak" was the probe's window, not a leak

The first 45-second walk reported the DOM event listener count rising at
+4.71/min, monotonically, never once decreasing. Over 180 seconds the same
counter reads 36 rising to 43, then **29**, then rising to 34: a sawtooth with a
period longer than the original probe. Slope over the longer window is
−0.03/min.

The harness now attributes registrations rather than counting them, which
settles it: 13 listeners appeared over three minutes, all `onended` handlers on
Web Audio nodes — 7 from the audio graph arming once at first gesture, 6 from
vehicle passes. Each handler disconnects its own node graph and the node then
becomes collectable, which is correct cleanup observed mid-cycle.

**There is no listener leak.** A twenty-minute session will not accumulate them.

### Frame time, and why you should not trust it

```
mean 9.98 ms (100.2 fps)   median 7.7   p95 16.3   p99 73.9   max 147.1
1% low 93.89 ms (10.7 fps)   frames over 33 ms: 640 of 17,935   over 100 ms: 53
per frame: 199 draw calls average (517 max), 2,084,080 triangles average
```

The mean says the scene is comfortable and the 1% low says it stutters badly.
Both were measured while six sibling agents ran headless GPU captures, with
`nvidia-smi` showing the card between 3.5 and 7.1 GB of 8.0 used. Four loads of
the *identical* bundle at the *identical* camera pose within five minutes have
produced means of 10.68, 10.99, 17.02 and 21.12 ms.

**A 2x run-to-run spread means no timing-based comparison on this machine can
resolve anything smaller than 2x.** Every millisecond in this document needs
re-taking on a quiet machine before it is used to make a decision. None of the
counts do.

---

## 3. Per-system cost

Two tables, because they answer different questions and only one is
pose-independent.

### 3a. What each system owns (scene traversal — trustworthy)

Attributed to the highest *named* ancestor of each mesh. Triangles and geometry
bytes belong to exactly one owner; texture bytes are counted against every owner
that references them, so that column deliberately over-sums.

| owner | system | objects | triangles | geom MB | tex MB | shadow casters |
|---|---|---:|---:|---:|---:|---:|
| `building` | building | 147 | 346,190 | 14.61 | 104.4 | 19 |
| `car-system` | car | 46 | 291,922 | 8.20 | 19 | 16 |
| `ground` | terrain | 1 | 231,200 | 6.19 | 22 | 0 |
| `veg-mid-wood` | vegetation | 1 | 187,639 | 5.88 | 10 | 1 |
| `highway` | terrain | 1 | 70,720 | 1.53 | 70 | 0 |
| `veg-pine-wood` | vegetation | 1 | 70,490 | 1.83 | 10 | 1 |
| `lot` | terrain | 1 | 52,000 | 1.10 | 70 | 0 |
| `pump-1/2/3` | pumps | 25 each | 30,448 each | 1.15 each | 23.27 each | 18 each |
| `joint-bed` | terrain | 1 | 28,800 | 0.61 | 16.67 | 0 |
| `forecourt-slabs` | terrain | 1 | 12,288 | 0.28 | 22 | 1 |
| `bollard-1..4` | pumps | 1 each | 5,136 each | 0.11 each | 11.33 each | 1 each |
| `paint-white` / `paint-yellow` | terrain | 1 each | ~5,000 each | 0.19 each | 27.33 each | 0 |

**`inst` is 0 on every row: there is no `InstancedMesh` anywhere in this scene.**
`bollard-1` through `bollard-4` are four separate copies of the same
5,136-triangle object; `pump-1/2/3` are three copies of the same 25-object
assembly.

### 3b. Marginal cost from the skip sweep

`?skip=<system>` against the full scene. **The draw-call and triangle columns
from this sweep are not usable** — skipping a system moves where the camera ends
up, so those deltas mix system cost with pose, and several come out negative.
Texture bytes, program count and object count are pose-independent.

| system | GPU texture MB freed | programs | objects | note |
|---|---:|---:|---:|---|
| lighting | 344.44 | 86 | 67 | includes the 8192 shadow map and the PMREM environment; skipping it also breaks vegetation |
| terrain | 241.35 | 64 | 114 | cascades into car, player and vegetation, so this includes their cost |
| building | 111.51 | 56 | 213 | cascades into vegetation |
| pumps | 43.93 | 36 | 83 | cascades into the player's collision check |
| car | 15.66 | 26 | 46 | |
| vegetation | 11.66 | 17 | 57 | |
| player | 0 | 18 | 0 | |
| audio | 0 | 0 | 0 | |
| interaction | 0 | 0 | 0 | |

Where a row says "cascades", skipping that system made a dependent system fail
to init, so the figure is an upper bound containing the dependant's cost. Those
failures are the dependency guards working, not new bugs.

### 3c. Cost by camera pose

| pose | draw calls | triangles / frame |
|---|---:|---:|
| `approach`, `ground`, `wide` | 517 | 3,020,020 |
| `lot` | 429 | 3,014,096 |
| `pumps` | 395 | 2,796,644 |

---

## 4. The crash

**Best-supported explanation: VRAM exhaustion under multi-process contention,
during scene generation rather than during play.** It is not a leak and not a
per-frame allocation, and both are ruled out by measurement rather than by
inspection.

1. **The scene's static GPU footprint was ~954 MB at the time of the crash**
   (902 MB textures + 49 MB buffers + 3 MB renderbuffers), plus a default
   framebuffer of 71–505 MB depending on the user's display. One tab, 1.0–1.5 GB.
2. **Peak during init exceeded steady state**, and the largest contributor was
   an allocation the project never asked for — see §6.
3. **The card was already nearly full.** `nvidia-smi` showed 3.5–7.1 GB of 8.0 GB
   used throughout, with six sibling agents running headless captures — the same
   condition the user played under.
4. **Browser-process death reproduced repeatedly**, always on later loads of a
   sweep and always when free VRAM was under ~1.5 GB. The harness logs it as
   `BROWSER PROCESS DISCONNECTED` with the VRAM reading attached.
5. **Growth is ruled out.** Over three minutes of walking, `glTex`, `glBuf`,
   geometry count, texture count, program count and listener count were all
   flat, with zero uploads in steady state.

What I cannot claim: I did not reproduce the user's specific crash, and browser
process death in a headless harness is not identical to a tab crashing during
play. The two are consistent, and points 1–3 explain both.

**A repeat will identify itself.** `Game.ts` installs `webglcontextlost` /
`webglcontextrestored` / `webglcontextcreationerror` handlers that log loudly,
set `window.__CONTEXT_LOST`, push onto `__SYSTEM_ERRORS` so a harness run fails
rather than quietly capturing a frozen frame, and put a banner on screen.
`assertSceneGpu` fails any harness whose context was lost mid-run.

---

## 5. Can a person actually walk it? Yes — 25 minutes, 11 laps, no crash

Everything above is a proxy. Peak VRAM down from 832 MB to 320 MB is a good
number and it is not the same statement as "a person can play this", which is
what the user asked for. So this section is that statement, measured.

**`tools/stress.mjs` drives the real interactive path**, not a shot preset. Real
`KeyboardEvent`s into `PlayerSystem`, so movement goes through collision
resolution, the doorway portal radius, `floorHeight`, the interior step and the
head bob. Real `pointerdown` on the canvas into `InteractionSystem`, so the
first press arms the audio graph exactly as a player's first click does and the
pick is a raycast from the screen centre at the 2.2 m reach. It does not call
`__INTERACT.look()` (which teleports), `__INTERACT.click()` (which skips the DOM
event and therefore never arms audio) or `camera.position.set()` (which skips
collision — the one thing a stress test of a walkable scene must not skip).

### What was tested, against what

Tree `src/ = a21d1b202486`, 70 files, newest edit 23:43:07Z, built fresh for the
run. **This tree includes** the canopy, Lighting's world-capture environment and
Building's current glazing; the scene reports 533 draws, 3.18 M triangles and
173 programs at ready, against 529 / 3.12 M / 165 four hours earlier. Lighting's
`pcss` init error, present in every earlier run tonight, is gone from this one.
It does **not** include whatever has landed since; the harness prints a content
hash of `src/` precisely so this is checkable rather than assumed.

Contended throughout: the card held 3.5–7.0 GB of its 8 GB, six agents running.

| | |
|---|---|
| duration | **1502 s (25.0 min)**, 146,829 frames sampled |
| laps | **11** complete circuits of the site |
| store crossings | **60** entries and exits |
| interactions fired | 52 attempted, **43 hit** (42 fuel-pump, 1 door) |
| outcome | **SURVIVED.** No crash, no context loss, no page error, no system error |

### Steady state

| | mean | median | p95 | 1% low | max | >33 ms | >100 ms |
|---|---|---|---|---|---|---|---|
| steady (>60 s) | **10.2 ms** (98 fps) | 9.0 | 15.1 | 79.9 ms | 336 ms | 2332 / 1.6% | 225 / 0.16% |
| store threshold | 11.7 ms | 11.1 | 16.4 | 35.8 ms | 82 ms | 18 / 0.3% | **0** |

Read the median and p95, not the 1% low: the control below shows the tail
belongs to the host, not to this scene.

**Frame time does not drift.** Per-lap means across laps 2–10: 10.9, 14.8, 10.4,
11.4, 10.3, 10.4, 11.8, 13.0, 15.1 ms. No monotone component, and the variation
does not track lap number.

### Nothing grows, over twenty-five minutes of play

Every one of these is flat with slope 0 across the whole run:

```
live texture bytes   722.31 MB -> 722.31 MB   (one distinct value, all 293 polls)
live buffer bytes     54.85 MB ->  54.85 MB
geometries                 342 ->       342
textures                   130 ->       130
programs                   173 ->       173
framebuffers                 7 ->         7
scene children              12 ->        12
JS heap             -0.51 MB/min, r2 0.06     (sawtooth, no trend)
```

**Zero bytes of texture memory were uploaded during the entire walk.** Not
"little": none. The peak texture figure never moved off its post-init value at
any point in 25 minutes.

**The audio graph cycles correctly under sustained load.** 880 source nodes
started, 844 ended, live count 36 → 36 with a maximum of 121 and a slope of
−0.08/min at r² 0.01. The `onended` handlers fire; this closes the question the
earlier 45-second probe could not. Note the distinction the numbers make for
you: cumulative *registrations* rise at 36.5/min with r² 1.00 — perfectly
monotone, and completely uninformative, because a handler that is registered and
fires is indistinguishable from one that is registered and leaks until you
compare against the ends. Counting cannot separate those two; attribution can.

### The store threshold is not expensive

60 crossings, 5210 frames within 500 ms of one. Mean 11.7 ms, max 82 ms, and
**not a single frame over 100 ms.** The `threshold-drill` phase — four rapid
in-out crossings per lap, 7059 frames — has a max of 32.0 ms and zero frames
over 33 ms. `store-enter` likewise: zero over 33 ms across 1878 frames.

The transmission render target and the interior lights are built once at init
and are not touched by crossing. Nobody had measured this; it costs nothing.

### The hitches are real, and they are not the scene — proved with a control

0.16% of frames exceed 100 ms and they arrive in bursts of up to 25 seconds.
Every scene-side counter says the scene is not responsible:

| | hitching windows | calm windows |
|---|---|---|
| draw calls | 289 | 274 |
| triangles | 2.6 M | 2.5 M |
| live audio nodes | 39.7 | 38.6 |
| JS heap | 384.2 MB | 383.4 MB |
| fraction inside the store | 13% | 14% |

And per-frame, for all twenty of the worst frames in the run: **0 KB uploaded,
0 programs linked.** Correlation of window frame time against card memory in use
is 0.038; against a heap drop large enough to be a major GC, −0.039; against
live audio nodes, −0.024. Draw calls are the strongest signal at 0.198, which is
not a signal.

So: no allocation, no compile, no GC, no extra geometry, no card-memory
pressure, and a burst structure lasting tens of seconds during which nothing in
the scene changed. That rules the scene out but names nothing, so I ran a
control.

**`--park=120` holds the camera at spawn for two minutes before the walk
starts** — no input, no route steps, no interactions, the same 533 draws every
frame. If the scene were responsible for the hitches, a static scene could not
produce them.

It produces them. Per 5-second window, in order:

```
t= 21s  mean  11.34 ms   max  37.8      t= 78s  mean  82.50 ms   max 183.4
t= 26s  mean  12.95 ms   max  70.2      t= 83s  mean  91.27 ms   max 173.4
t= 32s  mean  11.83 ms   max  38.2      t= 89s  mean 122.82 ms   max 190.2
t= 37s  mean  13.86 ms   max 140.1      t= 94s  mean  16.65 ms   max 129.8
t= 42s  mean 118.76 ms   max 243.6      t= 99s  mean  12.69 ms   max  52.2
t= 47s  mean  80.56 ms   max 254.6      t=104s  mean  12.57 ms   max  36.7
t= 52s  mean  15.29 ms   max 124.9      t=114s  mean  73.18 ms   max 136.2
```

**The identical frame costs 11.8 ms at t = 32 s and 122.8 ms at t = 89 s of the
same run, with nothing about it changed.** 200 of 6280 parked frames
exceeded 100 ms; the twelve worst frames of the entire eight-minute run all
occur inside the parked control, in a single seven-second burst starting at
t = 41 s. The control's mean (18.8 ms) is *worse* than the walking steady state
(10.5 ms) — the opposite of what scene cost predicts.

Card utilisation, which I had not been recording and now am: **pegged at 100%
for 93 of 94 windows.** It is saturated in the calm windows too, so it cannot
discriminate between them — but it does establish that this card was never idle
during any measurement taken tonight, with six agents rendering on it.

**Conclusion: this scene's cost is the 9–11 ms median, and the tail is the
machine.** The honest 1% low for this scene is not measurable on this host
tonight, and any number I quoted for it would be a number about six other
agents. Re-run `--park=120` on a quiet machine before believing any tail figure
in this document, including mine.

### What could not be tested: two interactions are unreachable on foot

**The cooler doors and the grab bottle cannot be reached by a walking player.**
This is not a routing failure in my harness — it is the reason the harness was
rewritten twice, and it is measured three ways that agree:

1. **Empirically.** Two runs walked at the back of the store for 33 s and 18 s
   respectively and stopped dead at z = 33.68 (and at z = 36.03 on the cooler's
   own line), never getting within the 2.2 m reach. The cooler is at z = 38.67.
2. **From the game's own collision field.** Flooding the free cells from the
   player's spawn — with the entry doorway punched open, since the door is shut
   when the grid is sampled — leaves the back of the store outside the
   reachable set. A transect down the store's centre line reads
   `.........###xx###x###` from z = 30 to z = 39.5: walkable to z ≈ 34, then
   solid or free-but-walled-off the rest of the way. A transect across the store
   at z = 35 reads `#################xx######` — solid nearly wall to wall.
3. **And it misses by about 20 mm.** Re-sampling the whole grid at a range of
   body radii turns "unreachable" into a number:

   | body radius | cooler | store mid | store back |
   |---|---|---|---|
   | 0.34 m | no | no | no |
   | **0.32 m** ← the player's | **no** | **no** | **no** |
   | 0.30 m | reachable | reachable | reachable |
   | 0.26 m and below | reachable | reachable | reachable |

   This is the difference between two very different bug reports, and it is the
   cheap one. **The back of the store opens up at a body radius of 0.30 m.**
   `PlayerSystem.BODY_RADIUS` is 0.32. Somewhere in the route to the cooler
   there is an aisle roughly 40 mm too narrow — one shelf nudged 25 mm, or a
   blocker inset that is 20 mm too generous, and the entire back half of the
   store and both of its interactions become playable.

The consequence for anyone reading interaction coverage: of the four
interactables, a player can trigger the **pumps** and the **entry door**. The
**cooler** and the **bottle** cannot be reached — not by design, but by 20 mm.
Both are Building's, both work when a shot preset places the camera in front of
them, and neither has ever been reached on foot: exactly the class of defect a
fixed-camera capture is structurally blind to (`NOTES` case 35). Whoever owns
the store's blockers should find the pinch point; the radius table says it is
one obstruction, not a general tightness, because everything opens at once
between 0.32 and 0.30.

One caveat on the record: the grid samples at 0.4 m, so a gap narrower than that
could in principle be missed. The radius sweep is the check on that, and the two
empirical stalls — at z = 33.68 and z = 36.03, in separate runs — agree with it.

### Also worth an owner's attention

- **The init texture transient is 185 MB and it has grown.** Peak upload during
  generation is 907.65 MB against 722.31 MB retained. Earlier tonight the same
  measurement was 15.85 MB against a smaller scene. This is peak VRAM during the
  window in which the user's browser died, so it matters more than its size
  suggests. It is entirely pre-`__SCENE_READY`; the walk contributes nothing.
- **The entry door interaction succeeded once in eleven laps.** 42 pump clicks
  landed and 1 door click did; the other nine door attempts missed. The player
  still crossed the threshold 60 times, so store entry was exercised — but a
  door that opens on the first approach and then cannot be aimed at again is
  worth Building looking at, and my aim-seek scans a 0.3 rad grid before giving
  up, so it is not a near miss.

---

## 6. What was landed

All in `src/core/` and `tools/`. **No system-owned file was modified.**

### 192.00 MB reclaimed, and never allocated in the first place

`src/core/shadowMemory.ts`, called from `Game.ts`.

Three builds a directional shadow as a `WebGLRenderTarget` — which carries
three's default **RGBA8 colour attachment** — with a `DepthTexture` attached.
`WebGLLights` binds `shadow.map.depthTexture || shadow.map.texture`, so once the
depth texture exists nothing ever samples the colour attachment: the depth pass
rasterises into it every frame and the result is discarded. At 8192² that is
256 MB of write-only VRAM. `R8` is colour-renderable, the contents are never
read, and the same attachment costs 64 MB.

The module does this in two halves. `preallocateShadowMaps` hands three a
ready-made target before the first render, so its allocation branch never runs
and the 256 MB version is never created at all. `reclaimShadowColourAttachments`
converts anything three built anyway — a shadow-map type change makes three
rebuild — and is a no-op in the normal case.

Measured A/B against `?noshadowopt=1`, same bundle, two fixed poses:

| | live texture memory | transient during init | draws | triangles | programs |
|---|---:|---:|---:|---:|---:|
| as shipped | 909.13 MB | 15.84 MB | 395 / 517 | 2,841,734 / 3,065,110 | 141 / 144 |
| with this | **717.13 MB** | **15.84 MB** | 395 / 517 | 2,841,734 / 3,065,110 | 141 / 144 |

**192.00 MB at both poses, with no transient cost**: the uploaded-minus-resident
column is identical, meaning the oversized attachment is never allocated rather
than allocated and freed. So peak VRAM during generation — the moment §4 says
the crash happens — is also 192 MB lower, not just steady state.

Pixel diff: 41 of 6,220,800 channels at `pumps`, 291 at `ground`, **every one of
them by 1/255**. Dither noise. An inverted depth comparison, the failure this
code is most exposed to now that it configures the depth texture itself, would
flip whole regions rather than one bit in five thousand pixels.

The first version of this fix rebuilt the depth texture instead of moving it,
which made peak VRAM 320 MB *worse* during init in exchange for the steady-state
saving — the wrong trade when the failure mode is a peak. That is written up in
`NOTES.md`, along with how it was caught.

### The standing budget guard — `tools/budget.mjs`, `tools/budget.json`

Two lines in any harness:

```js
await context.addInitScript({ content: await budgetInitScript() });
const result = await checkBudget(page, { shot: "pumps" });
reportBudget(result, { tag: "shoot6" });
```

It records draw calls, triangles per frame, scene triangles, shader programs,
real texture bytes, buffer bytes and shadow map size, and fails loudly when a
round exceeds the accepted ceiling by more than 5%.

Three design points, each of which the measurement work made necessary:

- **Draw calls and triangles are counted at the GL layer per animation frame**,
  not read from `renderer.info.render`, which is reset at the top of every
  `render()` and therefore reports only the last pass. In this scene that
  silently omits the shadow pass, which is 39% of the frame's draw calls.
- **Texture memory is counted in bytes at the upload calls**, not from
  `renderer.info.memory.textures`, which is a count of objects. It also catches
  the allocations three makes on the project's behalf, which the scene graph
  cannot see and which are the largest in the scene.
- **Nothing is taken from a system's own report.** Several systems publish a
  registry line with their object and triangle counts, and at least one silently
  excludes some of its own meshes, so a budget assembled from those lines would
  under-count by an amount that changes whenever somebody adds a mesh through a
  different path. Every number comes from the renderer or from the GL calls it
  made. Per-system attribution is a convenience for finding an owner; the budget
  is enforced on totals, which a system cannot under-report.

`node tools/budget.mjs --selftest` exercises the failure path offline in under a
second — a guard that has never been seen to fail is not a guard. `--write`
re-records the ceiling; do that deliberately, with the reason.

**Current accepted ceiling** (this is what Vegetation's "+2 draw calls" and
Pumps' "−12,240 triangles" should be reported against):

```
textures 717.13 MB   buffers 51.43 MB   programs 144   scene triangles 1,873,499
shadow map 8192      approach/ground/wide 517 draws    lot 429    pumps 395
```

<a id="adopting-the-budget-guard"></a>
### Adopting it — paste this into your harness

Two lines, plus one import. Put the `addInitScript` call immediately after
`newContext` and **before any page loads**; put the check after your existing
`__SCENE_READY` wait.

```js
import { budgetInitScript, checkBudget, reportBudget } from "./budget.mjs";

// after: const context = await browser.newContext({ ... })
await context.addInitScript({ content: await budgetInitScript() });

// after: await page.waitForFunction(() => window.__SCENE_READY === true)
reportBudget(await checkBudget(page, { shot: "<your ?shot= name>" }), { tag: "<your tag>" });
```

That prints a costed line every run and shouts when a round goes over. To make
it fail the run rather than warn:

```js
const budget = await checkBudget(page, { shot: "<your ?shot= name>" });
reportBudget(budget, { tag: "<your tag>" });
if (budget.failed) throw new Error("over budget — see the lines above");
```

Notes worth knowing before you wire it up:

- **`shot` is not optional in practice.** Draw calls and triangles depend on
  where the camera is, so without a `?shot=` pose they are measured but not
  checked, and the run says so. Texture bytes, buffers and programs are
  pose-independent and always checked.
- **The instrumentation must be installed before the page loads.** It wraps the
  WebGL context prototypes, and it cannot count an upload that already happened.
  If you see `window.__GLSTAT is missing`, the `addInitScript` is in the wrong
  place.
- **Your own numbers may go up legitimately.** When they do, run
  `node tools/budget.mjs --write` and say in the commit what bought the
  increase. Raising a ceiling to silence a failure is the one use that defeats
  the purpose.
- **Do not report your system's self-measured counts as the delta.** At least
  one registry line in this project silently omits some of its own meshes. The
  guard measures from the renderer for that reason; quote its numbers, not
  yours.

### Capture validation — `tools/archive.mjs`

A 65-byte file in the repo root turned out to be a structurally perfect PNG with
dimensions 0x0: an empty image from a harness that parsed an argument as an
output path. It would have passed every check anything downstream performs, and
these captures are what critics score.

`round.save()` now validates before the stable copy is made — so a bad frame
never reaches the well-known path a critic reads — rejecting a non-PNG, a zero
dimension, dimensions other than the requested viewport, and a file too small to
hold an image. Pass `viewport` to `openRound()` to make the size check an error
rather than a warning. `node tools/archive.test.mjs` covers all of it, starting
with a byte-exact reconstruction of the offending file.

The size floor is measured, not guessed: a solid-colour 1920x1080 PNG is 9.7 KB,
the smallest real capture in this repo is 1.20 MB, and the floor sits at
0.05 B/px between them. It only applies at a megapixel and above — applying it
at every size flagged 42 legitimate 256² alpha cutouts against one true
positive.

**The offending file bypassed `round.save()` entirely**, since several harnesses
still call `page.screenshot({ path })` directly. `node tools/archive.mjs --scan .`
walks the tree — including extensionless files that are really PNGs, which is
what this one was — and applies the same assertion. Across 925 files it flags 8,
listed in §7.

### Diagnostics

- Context-loss handlers in `Game.ts`, described in §4.
- A startup log line reporting the true cost of the default framebuffer on the
  current display.
- `assertSceneGpu` in `tools/gpu.mjs`: verifies the renderer on the live context
  after the scene is ready, and fails on a lost context. **Every harness in this
  repo should add this line** — the launch-time check they all use proves less
  than it appears to, because Playwright injects `--enable-unsafe-swiftshader`
  into every Chromium it launches regardless of flags. See the NOTES case.
- Event-listener census in `tools/perf-instrument.js`, covering both
  `addEventListener` and `onfoo` assignment, with stacks.

### Harness

`perf.mjs` (baseline, leak walk, per-system sweep, fixed-pose sweep, lighting
A/B, arbitrary `--ab` comparisons, `--query=` for the baseline load),
`perf-instrument.js`, `perf-probe.js`, `budget.mjs`, `shotNames.mjs`,
`pixdiff.mjs`, `_perfkill.ps1`.

Seven cases added to `NOTES.md`.

---

## 7. Deliberate deferrals — decided, not open

Measured, costed, and **consciously declined**. Not backlog. Nobody should
re-derive them, and nobody should act on them without the decision being
revisited explicitly.

**DEFERRED — the 8192² shadow map. Saving available: 240 MB and 957,222
triangles per frame.** It is now 256 MB of depth plus 64 MB of colour; 4096²
would leave 80 MB. Disabling the shadow at a fixed pose took the frame from 392
draw calls and 2,437,452 triangles to 241 and 1,479,930, so the shadow pass is
**151 draw calls and 957,222 triangles every frame** — contention-proof, and the
largest single item found anywhere in this scene.

Declined because long crisp shadows from a low sun are close to the centre of
the brief, and on a quiet 8 GB card the budget is affordable; the crash required
six agents contending. **This is the first lever to pull if the scene needs
one**, and it is a large one.

**DEFERRED — `setPixelRatio(min(dpr, 2))`, costing 284–505 MB on a high-DPI
display.** Capping at 1.5 would cut that roughly in half. Declined for the same
reason: a visible change to edge quality, affordable when uncontended. The
startup log line reports what the user's machine actually pays, so this can be
reconsidered against a real number rather than a range.

**DECLINED — the 10 `RectAreaLight`s. No saving was measured, in either
direction.** Disabling all rect-areas measured 11.93 ms against 9.96 ms
as-shipped; disabling all point and spot lights measured 8.66 ms against the
same 9.96 ms. Both sit inside a noise floor of roughly 2x and one has the wrong
sign. Recorded so nobody else spends the same hour. Revisit only on a quiet
machine.

---

## 8. Open items

**TERRAIN — 64 MB in three 2048² asphalt maps, plus a 34.44 MB 3072x2204 site
overlay.**

This corrects an earlier figure of 128 MB, and it is the answer to "who owns the
276 MB unnamed group". The six 2048² textures visible in the scene graph are
**three GPU uploads**, not six: `TerrainSystem.ts:127` calls
`makeAsphalt(2048, 8, 1337)` for the highway, then line 293 does
`asphaltMaps[k].clone()` for the lot to change `repeat`. A `THREE.Texture`
clone shares its `source`, and three keys the upload on the source, so the lot's
three maps are **free**. Confirmed by grouping every texture of 2048² or larger
by `source.uuid` in the live scene: three sources, each bound under two texture
objects, owners `highway`, `lot` and one unnamed mesh sharing the lot material.

So they are terrain's, they are albedo/normal/roughness of one asphalt set, and
**halving to 1024² saves 48 MB, not 96 MB.** Still worth considering — these are
ground planes seen mostly at grazing angles, where anisotropic filtering does
more for the look than resolution — but at half the payoff I previously quoted.

Two notes for whoever audits textures next:

- **Counting `THREE.Texture` objects overstates GPU cost wherever clones are
  used.** The scene graph says 128 MB here; the card holds 64 MB. `perf.mjs`
  reports `shared sources: N sources bound under >1 THREE.Texture (free)` for
  exactly this reason, and the budget guard counts uploads rather than objects.
- **The unnamed mesh is worth one line to fix.** Six objects sharing the lot
  material have no `name`, so they surface as `Mesh` in my per-owner table and
  as an anonymous group in everyone else's. Naming them makes three separate
  harnesses agree about who owns 64 MB.

**Shader programs doubled overnight, 70 to 144 — investigated, and not what it
looks like.**

I checked the near-duplicate-variant hypothesis directly. Every site in `src`
that calls `onBeforeCompile` also implements `customProgramCacheKey`, and all
but one key on boolean feature flags, which is correct: a flag that changes the
generated GLSL must split the program, and nothing else may.

The exception is `src/gen/vegTransmission.ts:219`, which keys on five *numeric*
values — `wrap`, `strength`, `falloff`, `broad`, `fill`. All five are passed as
uniforms (`uWrap`, `uTransStrength`, `uTransFalloff`, `uTransBroad`,
`uCanopyFill`) and read as uniforms in the GLSL; none is substituted into the
source. So every distinct tuple compiles a **byte-identical** program under a
different key. That is exactly the "differing only in a constant" pattern — but
`VegetationSystem` only reaches it through four argument sets, so collapsing the
key to a constant **saves at most 3 programs**. Real, cheap, vegetation's to
make, and not an explanation for 74 new ones.

Two things this does settle:

- **There is no first-frame compile stall during play.** All 144 programs are
  linked before `__SCENE_READY`, and the first two seconds of the walk contain
  exactly one frame over 33 ms more than the warm window does. The compile cost
  is paid inside the 26.3 s init, not when the player starts moving.
- **`TerrainSystem.ts:490` has the opposite bug**, and it is worth knowing about
  even though it does not ship. The `?flat=` debug path wraps `onBeforeCompile`
  on seven materials without extending `customProgramCacheKey`, so materials
  that now generate different shaders can share a cached program. Debug-gated,
  so harmless today; the trap is that this failure produces a *plausible* frame,
  which is how it survives review.

What I did not establish is where the other 74 came from. 144 programs against
199 materials is close to the floor for a scene with this many distinct material
configurations, and tonight added a glazing leaf, a ground mat and standing
water, so growth is expected — I just cannot attribute it precisely across two
bundles, and I would rather say so than produce a number by subtraction.

**Missing instancing.** Four identical bollards, three identical pump
assemblies, no `InstancedMesh` anywhere. Perhaps 20k triangles and a handful of
draw calls today — worth doing if the forecourt grows.

### The eight flagged captures, triaged

Four are broken. Four are legitimate. The split is clean and it is not the one
the flat-frame heuristic implied.

**`shots/system2` — four black frames, and they are Building's.** Not "flat":
**black**, with a mean luma of 0.0 and no pixel above luma 2.

| file | round | recorded outcome | mean luma | lit pixels | distinct colours | size |
|---|---|---|---|---|---|---|
| `cooler-expo.png` | `2026-08-28T180008Z-KWMh7fM8` | **ok**, 0 errors | 0.0 | 0.0% | **1** | 26 KB |
| `interior-expo.png` | `2026-08-28T180008Z-KWMh7fM8` | **ok**, 0 errors | 0.0 | 0.0% | 5 | 40 KB |
| `cooler-v2.png` | `2026-08-28T180347Z-D3NKAXzn` | **ok**, 0 errors | 0.0 | 0.0% | **1** | 26 KB |
| `interior-v2.png` | `2026-08-28T180347Z-D3NKAXzn` | **ok**, 0 errors | 0.0 | 0.0% | 8 | 40 KB |

`cooler-expo` and `cooler-v2` contain exactly one colour over 1.44 M pixels. The
two `interior` frames are black apart from a single ~8-pixel white speck near
the centre — one emissive fixture, nothing else.

Three things make this worse than a bad screenshot:

1. **The same two poses render correctly in every other round.** Current
   `interior.png` is mean luma 129.5 with 99.8% of pixels lit at 1.85 MB;
   `cooler.png` is 115.3 and 1.72 MB. So this is not a pose that is legitimately
   dark, and it is not a scene-wide failure either — `front-v2.png` from the
   *same round* is a real frame at 132 KB. **Both interior poses failed in both
   rounds; the exterior pose in the same round did not.**
2. **Both rounds recorded `outcome: ok` with `systemErrorCount: 0`.** The
   harness had no idea.
3. **Both rounds have since been pruned.** Only the promoted stable copies
   survive, so the manifests that would have explained the failure are gone —
   and what outlived them is the artefact marked good.

**Has a critic ever reviewed one?** Not in writing. Nothing in the repo outside
`stable.json` references these four filenames, so no recorded verdict is built
on them, and no finding needs retracting on that evidence. What I cannot rule
out is a critic browsing `shots/system2/` and forming an impression. Given the
`-expo` suffix, the likely intent was an exposure comparison of the two interior
poses; if that comparison informed any exposure decision, it compared two black
frames and its conclusion is void.

**`shots/system3/_look/nzid*.png` — four legitimate diagnostics, keep them.**
These are false-colour part-ID renders of the pump nozzle: 17–20 distinct
colours, 100% of pixels lit, mean luma ~50–69, flat-shaded regions on a neutral
grey background. Exactly what an ID pass should look like. `_look/` has no
`stable.json`, so they were never promoted and never went to a critic — a
scratch directory, working as intended.

This is why the byte-size floor was calibrated rather than guessed, and it is
worth stating as a rule: **a small file is evidence, not proof.** `front-v2.png`
is a genuinely dark dawn exterior at 0.09 bytes/pixel and passes; the four black
frames sit at 0.019–0.028 and fail; the floor at 0.05 separates them. The four
`nzid` frames are *below* the floor at 0.010 and are fine — which is why the
check exempts small images and why the first version of it, which flagged 42
legitimate 256² cutouts, was withdrawn rather than shipped.

**The harness that wrote the 0x0 PNG is not identified.** The only tool taking a
free-form output path positionally is `tools/probe.mjs` (`process.argv[4]`),
which matches the filename — `node tools/probe.mjs <shot> <query> 640` writes to
`./640` — but `page.screenshot()` without a clip cannot produce zero dimensions,
so I do not believe it and am not going to name it on circumstantial evidence.
The scan and the `save()` assertion mean the next one identifies itself with a
stack trace, which is a better outcome than my guess.

**Init transients are 15.85 MB and belong to lighting.** Uploaded 732.98 MB,
retained 717.13 MB. `?skip=lighting` takes the transient to 0, which places it
in the PMREM/world-capture path. This is small and well managed; the 518 MB
figure in the first version of this report was an artefact of the measurement
itself and is retracted — see `NOTES.md`.

### LOD and platform, last as instructed

There is no LOD system and none is warranted. At 1.87 M triangles on a 4060 the
constraint is memory, not vertex throughput, and every LOD scheme trades memory
*up* for triangles *down* — the wrong direction. Nothing was spent on mobile,
touch, or non-NVIDIA compatibility.

The 404 during load is Chrome's automatic request for `/favicon.ico`;
`index.html` declares no icon. Harmless, one line to silence, and `index.html`
is shared so I left it.

---

## 9. Bloom price, the PCSS shadow branch, and a texture audit

Everything in this section is bytes and counts. The host is saturated (see
section 5), so nothing here is priced in milliseconds, and where a decision
needs a time cost I have said so rather than produced a number I would withdraw.

Note the scene has moved since section 1: GL live texture memory is now
**748.76 MB**, up from 717.13 MB, with the canopy and lighting work landed.

### 9a. Bloom, for Lighting — the render targets are cheap, the MSAA is not

There is no post-processing anywhere in this project today, so this prices
something that does not exist yet. Measured, not calculated: the render-target
set `UnrealBloomPass` and `EffectComposer` would allocate, built against the
live renderer at the live drawing buffer (1920×1080, DPR 1) and forced to
allocate by binding, with the GL byte counters read either side.
`tools/bloom-cost.mjs`.

| | targets | colour | depth | **total** |
|---|---|---|---|---|
| `EffectComposer` alone (2 full-res half-float) | 2 | 31.64 MB | 15.82 MB | **47.46 MB** |
| `UnrealBloomPass`, full res, as shipped | 11 | 14.49 MB | 7.25 MB | **21.74 MB** |
| `UnrealBloomPass`, full res, `depthBuffer:false` | 11 | 14.49 MB | 0 | **14.49 MB** |
| `UnrealBloomPass`, half res, `depthBuffer:false` | 11 | 3.62 MB | 0 | **3.62 MB** |
| isolated 512² glow chain, `depthBuffer:false` | 11 | 1.83 MB | 0 | **1.83 MB** |
| `EffectComposer` with `samples:4` (MSAA kept) | 2 | 31.64 MB | 205.66 MB | **237.30 MB** |

Three things follow, in descending order of how much they should affect the
decision.

**1. The dominant cost is not bloom, it is losing MSAA.** The renderer is
constructed with `antialias: true` and the default framebuffer really is
multisampled — `gl.getParameter(gl.SAMPLES)` is 4. Route the scene through an
`EffectComposer` and it renders into a plain render target instead, and **every
edge in the scene goes from 4× multisampled to aliased.** That is a scene-wide
quality regression, arriving as a side effect of a sun-disc effect, and it will
read to a critic as something else entirely. Buying it back with `samples:4` on
the composer's two targets costs **237 MB**, which is more than the shadow map.

**2. So the full-scene composer route costs 47–252 MB, not 22 MB.** Bloom's own
eleven targets are genuinely cheap; the price of admission to post-processing at
all is the composer pair, and the price of not regressing the image is the
multisampled version of it.

**3. There is a route that avoids all of it.** The ask is a glow on the sun
disc — a small, bright, isolated object. Render just that into its own chain,
blur it, and composite additively; the main scene never leaves the default
framebuffer, so its MSAA is untouched. **1.83 MB** at a 512² chain, and nothing
else in the frame changes. If the sun disc is the whole requirement, this is
the option I would price first.

Two free adjustments whichever route is taken:

- **`depthBuffer: false` on bloom's eleven targets saves 7.25 MB.**
  `WebGLRenderTarget` defaults `depthBuffer` to true and a blur pass never uses
  it. `UnrealBloomPass` does not pass the flag, so this needs a local subclass
  or a post-construction fixup, not an upstream change.
- **Halving bloom's internal resolution saves a further 10.87 MB** and is close
  to invisible on a glow, which is a low-frequency effect by construction.

**Programs and init time, which I am not pricing.** The composer route adds
about eleven programs (a high-pass, five separable-blur variants distinguished
by a `KERNEL_RADIUS` define, a composite, a blend, a basic, a copy and an
output pass). Moving tone mapping to an `OutputPass` would additionally change
the program cache key of **every** material in the scene and recompile all
~144 of them. That lands entirely in init, init is where the user's browser
died, and I cannot price a compile stall on a host this contended. If Lighting
takes the composer route, that recompile is the number to measure on a quiet
machine before shipping it.

### 9b. `BasicShadowMap` branch — landed, and it recovers the full 192 MB

`LightingSystem.ts:236` gates contact-hardening shadows behind `?pcss=1` for a
reason that is not about shadows: the filter needs raw depth, which needs
`BasicShadowMap`, and `preallocateShadowMaps` returned early for anything other
than `PCFShadowMap`. Turning the filter on therefore handed back the 192 MB
peak saving. That gate is now removable.

Three's own branch (`WebGLShadowMap.js:261-272`) differs by exactly two
properties: `BasicShadowMap` leaves `compareFunction` null and filters nearest,
where PCF sets a comparison and filters linearly. Mirroring that was trivial.
**The trap was elsewhere, and it would have made things worse:**

`WebGLShadowMap` captures `_previousType = this.type` when the renderer is
built, and `this.type` is `PCFShadowMap` at that instant. Any later change
leaves `typeChanged` true for the first render, and line 203 then disposes and
rebuilds `shadow.map` — **including a map pre-built by this module.** Naively
extending the branch would have allocated a 64 MB target, had three throw it
away on frame one, and allocated the 256 MB default anyway: strictly worse than
doing nothing. The escape is line 170, `shadow.autoUpdate === false &&
shadow.needsUpdate === false` → `continue`, so one suppressed `render()` call
reaches the tail and consumes the type change having allocated nothing. It also
performs the material recompilation a type change requires, which has to happen
regardless and is cheaper at init than mid-play. The function verifies
afterwards that nothing was allocated and declines rather than guessing.

Measured, same bundle, `tools/shadow-type-ab.mjs`:

| | shadow type | live texture | **peak texture** | colour attachment | compare |
|---|---|---|---|---|---|
| default | `PCFShadowMap` | 748.76 MB | **757.06 MB** | R8 | LessEqual |
| `?noshadowopt=1` | `PCFShadowMap` | 940.76 MB | 949.06 MB | RGBA8 | LessEqual |
| `?pcss=1` | `BasicShadowMap` | 748.76 MB | **757.06 MB** | R8 | null |
| `?pcss=1&noshadowopt=1` | `BasicShadowMap` | 940.76 MB | 949.06 MB | RGBA8 | null |

**192.00 MB at both live and peak, on both paths.** The PCSS path now costs
exactly what the default path costs.

Verified as a no-op on the image, because the failure mode here is a wrong
depth comparison producing a perfectly plausible frame: at the `ground` pose,
`?pcss=1` against `?pcss=1&noshadowopt=1` differs on **29 of 6,220,800 colour
channels, every one by 1/255** — dither. The PCF pair differs on 16. And to
confirm the branch was genuinely exercised rather than the flag being inert,
`?pcss=1` against the default differs on **10.46% of channels with a maximum
delta of 176/255**: the filter is doing real work, and the preallocation is
invisible inside it.

**Lighting: the blocker in your comment is cleared.** Promoting `?pcss=1` no
longer costs any VRAM. `?noshadowopt=1` still A/Bs it.

### 9c. Texture audit — 119 sources behind 908 wrappers

`tools/texture-audit.mjs`, grouping by `source.uuid`:

```
unique sources 119   texture wrappers 908   (ratio 7.63)
scene-graph total 638.76 MB   GL live 748.76 MB   unaccounted 110 MB
```

| owner | MB | note |
|---|---|---|
| `light:sun` | 320.00 | 256 depth + 64 R8 colour, at 8192². Deliberately deferred, section 7 |
| `building` | 99.99 | ~19 sources, almost all 1024² albedo/normal/roughness triples |
| terrain (`highway` + `lot` + unnamed) | 64.00 | three 2048² sources under 12 wrappers |
| `paint-white` / `paint-yellow` | 42.66 | 1024² albedo/normal/rough/alpha each |
| `ground` | 17.00 | three 1024² |
| `car-system` | 13.00 | |
| `pump-1..3` | 26.61 | 8.87 each |
| `canopy` | 6.83 | new this round |

Two actionable items and one honest gap.

**PUMPS — 8.00 MB of exact duplicates, reclaimable with no visual change.**
Each of the three pumps holds **two byte-identical 1024×512 RGBA sources** —
same dimensions, same format, same content hash, different `source.uuid`, so
they are two separate uploads of the same image. 2.67 MB per pump. Whichever
generator produces them is being called twice per unit where once would do, and
sharing the result costs nothing visually because the images are identical.
Reported rather than fixed: it is `PumpSystem`'s file.

**The duplicate check is deliberately narrow.** Identity requires dimensions,
format, type *and* a hash of a 128² resample to agree, and flat-colour sources
are excluded and reported separately, because "these twelve white squares match"
is true, useless, and how the first capture check earned a 42:1 false-positive
rate. Result: three real groups and one flat source (a 128² `rgb(46,41,36)` on
the canopy, 0.08 MB — a 1×1 would do, but it is not worth anyone's time).

**110 MB is not attributable to the scene graph, and I am not going to guess
what it is.** It is down from the 333 MB gap in the first version of this
report, and the likely residents are the PMREM working targets, the vegetation
transmission target, and anything a system holds without binding to a material
slot. Anyone reading the per-owner table should treat it as covering 85% of the
card, not 100%.

### 9d. Program doubling: half fixed, half retracted, zero collisions measured

**Vegetation's half has landed.** `vegTransmission.ts` now returns the constant
`"foliage-transmission-v2"`, and the file carries the reasoning. Nothing left
to price.

**My other half was wrong and I am retracting it.** I reported the `?flat=`
debug path in `TerrainSystem.ts` as an `onBeforeCompile` that omits a cache key
and therefore lets materials share a wrong program. Three independent reasons it
is not: the callback only sets uniform *values* and `normalScale`, so no
generated text diverges; `applyWorldDetail` already gives each of the seven
materials a distinct key; and three's default `customProgramCacheKey()` is
`this.onBeforeCompile.toString()`, so a wrapped hook lands in the key by itself
unless the default has been replaced. I pattern-matched a real and reliable
smell and wrote up the failure it usually implies without checking whether it
applied. **No work should be routed to Terrain for this.**

**And the general question is now answered by measurement rather than by my
having failed to find one.** The audit runs every material's `onBeforeCompile`
against a mock shader and compares the generated source of every material
sharing a cache key: **0 collisions across 50 key groups.** That includes the
46 foliage materials now sharing one constant key — they generate byte-identical
GLSL, so Vegetation's fix is confirmed safe rather than assumed safe.

The first version of that detector compared `onBeforeCompile` *function
identity* and reported 16 groups. Every one was a false positive, because every
closure is a distinct object. It was replaced before the numbers were reported,
not after.

### 9e. An instrument defect, and what it invalidates

`tools/perf-instrument.js` hooked `renderbufferStorage` but never
`deleteRenderbuffer`, so `live.rboBytes` and `live.rboCount` only ever grew:
a high-water mark wearing the name of a live value, while every neighbouring
counter had a matching delete hook.

It surfaced because the bloom probe reported bytes leaking on dispose and **the
residual equalled the renderbuffer total exactly** in all three affected cases,
while the two `depthBuffer:false` cases were clean — the signature of the
instrument being wrong rather than the code under test. Fixed; the probe now
verifies disposal returns to baseline.

What it invalidates: every renderbuffer figure quoted before this round was a
peak rather than a live value. The published numbers are 4.59 MB and 3 MB
against a ~950 MB total, so **no conclusion in this document changes** — but the
crash arithmetic in section 4 is overstated by up to 1.6 MB, and any future
render-target churn would have been mis-reported without this.

---

## 10. Harness reliability: six faults, one shape

Three agents lost rounds to capture faults in one night, and they share a shape
that is not "a check returned the wrong answer": **the check did not fail, it
failed to run.** This section is what was landed, what was found, and what is
still unattributed.

### 10.1 The completeness assertion — items 1, 2 and 3

Two of the reported faults are the same defect at different severities: a round
that wrote `manifest.json` and **zero PNGs at exit 0**, and `shoot6` writing **2
of 7 frames and exiting 0** after the preview server stopped answering
mid-round. A third — two of four Pumps runs dying on `page.goto`, one after 1 of
11 shots — produces the same artefact.

Vegetation named the assertion: `written.length === requested.length`. It is now
in `tools/archive.mjs` at `finalise()`, which is the only place that knows both
numbers. Adoption is one line, and it is the two lines below in §10.6.

Three properties were forced by the failures rather than chosen, and the third
is the interesting one:

| Property | Why |
| --- | --- |
| Manifest, prune and `stable.json` all happen **before** the throw | A round that failed is the round somebody wants to open. Failing the run *and* deleting the evidence trades a silent failure for a louder one. |
| `finalise({ failed })` — and the pre-existing `outcome: "failed"` convention — is exempt **from the throw only** | Otherwise a run that died on `page.goto` reports "round incomplete" instead of the navigation error, and the assertion hides the diagnosis. The throw fires only when a harness **believes it succeeded**. |
| The verdict is delivered by a `process.on("exit")` hook, not only by the throw | See below. |

#### Correction: the first version of that exemption reproduced the bug

Vegetation's cleaner case — **3 requested, 0 written, exit 0, with `"outcome":
"failed"` already in the manifest** — was *not* closed by the first version I
landed. The exemption suppressed the exit hook as well as the throw, so a
harness that knew it had failed still exited 0. The harness knew; only the exit
code lied; and my fix preserved the lie.

The split is now correct, and it is the whole distinction: **a self-reported
failure is exempt from the throw, never from the exit code.** The harness's own
reason survives and is now named in the exit summary; only the exit code is
corrected.

Auditing every manifest in `shots/` shows the fault is more widespread than
reported — **four rounds wrote zero captures**, across three systems, and only
one of the four is the round that was reported:

| Round | System | Written | `outcome` | Recorded cause |
| --- | --- | --- | --- | --- |
| `…T005145Z` | system2 | 0 | *unset* | none — the harness did not know either |
| `…T005529Z` | system6 | 0 | `failed` | `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE` |
| `…T013258Z` | system1 | 0 | `failed` | `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE` |
| `…T014903Z` | system6 | 0 | `failed` | `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE` |

And the same navigation failure cost **six rounds in one night across `system1`
and `system6`** — 00:49, 00:55, 01:14, 01:30, 01:32, 01:49, alternating between
the two systems. That is independent corroboration of §10.3 from data neither
system published: the build-directory wipe is not a Pumps problem, it is a
project-wide bleed, and the two systems affected are the two whose private
directories are missing from `.shot-build/`.

`tools/archive.exit.test.mjs` now replays Vegetation's round shape specifically
and asserts three things: it exits 1, the navigation error is still the reported
cause, and no "round incomplete" was thrown over it.

#### And one more level up: a round that is never closed at all

Auditing `system4`'s rounds turned up the **inverse** fault, which the assertion
still could not see: **captures on disk with no `manifest.json`.** Two of Car's
eight rounds tonight — `…T022407Z` with one PNG and no manifest, `…T015141Z`
with neither. No manifest means `finalise()` never ran, and a check that lives
inside `finalise()` cannot report a `finalise()` that did not happen.

So a round now registers itself when it **opens** and deregisters when it
closes, and any round still open at exit is named and forces a non-zero code.
That covers the harness dying silently as well as the harness lying. Verified
against all seven harnesses: each has exactly one `openRound` and at least one
`finalise`, so no legitimate path is failed by this.

This is the same finding one turn further out. "The check failed to run" was
answered by moving the verdict outside the mechanism that discards checks; this
is the check failing to run because the *thing it runs inside* never ran.

Lighting's improvement is folded in as `assertBuildIntact(root, buildDir, tag,
context)` in `tools/scratch.mjs` — called before **every** `page.goto`, not once
after the build, because the wipe lands mid-round and a single post-build check
passes while a later pose still fails. Its message says *do not retry blindly*,
because that failure is maximally misleading in the direction of retrying: a
network-shaped error invites a re-run, and the re-run often works once the
sibling's build has finished, which is how it stayed undiagnosed for six rounds.

#### One new flat capture, for Car, found by the gate rather than by anyone looking

The repo-wide scan now fails on **5** promoted captures. Four are the
`shots/system2` frames already triaged and routed to Building. The fifth is new:
`shots/system4/rounds/2026-08-29T022407Z-741e15ad81f2/car_side_sun__sview.png`,
19.0 KB for 1600×900 against a 72 KB floor, written at 02:24 tonight — after the
last scan, so the gate caught it prospectively rather than archaeologically.

It needs Car's triage, not mine: it is the only capture in its round, and that
round is one of the two with no manifest. I checked and discarded one theory
before reporting — the doubled underscore in `sun__sview` looked like the
empty-argument signature from §10.3, and it is not: every capture in Car's other
rounds uses `car_side_sun__<variant>`, so the doubling is its own naming
convention.

**The throw alone does not work for three of the seven harnesses.** Every
harness copied the same teardown — an array of named closers, each in its own
`try`/`catch`, so one failing closer cannot leave a Chromium alive on a shared
GPU. That is correct. But `shoot1`, `shoot2` and `shoot6` call `finalise()` from
inside that array, so a throw there is caught, logged as `failed to close
archive round`, and discarded; the run then reaches `process.exit(code)` with
the code it already had, which on a clean-looking run is 0.

So the obvious fix would have run, produced the right answer, printed it, and
still exited 0 — a check swallowed by a `catch` written for an unrelated
purpose. Adding a check inside a mechanism that discards checks is a poor answer
to "the check failed to run", and it would have looked fixed.

`archive.mjs` therefore registers an `exit` listener the first time a round comes
up short. Node runs `exit` listeners *after* `process.exit(code)` has set
`process.exitCode`, and re-assigning it there changes what the process returns —
verified before being relied on:

```console
$ node -e "process.on('exit',()=>{process.exitCode=1});process.exit(0)"; echo $?
1                                                              # Node v22.19.0
```

No harness has to be edited for this half, no `catch` can intercept it, and the
verdict is re-printed at the last possible moment.

`tools/archive.exit.test.mjs` reproduces the swallowing teardown in a child
process and asserts on the **exit code**, since an exit code is not observable
from inside the process producing it. Worth recording that its first run was
itself an instance of the class: the child crashed on a Windows path import and
exited 1, and **two of three cases passed because they expected 1**. What caught
it was the extra assertion that the harness had actually swallowed something.

For the six harnesses that have not declared `expect` yet, `finalise()` also
compares against the previous round's manifest and warns by name about captures
that have vanished. That one can only ever warn — `--only=front` is a legitimate
one-shot run and is indistinguishable from a truncated one from inside
`finalise()` — and it additionally requires the count to have dropped, because
several harnesses name captures `${shot}${SUFFIX}` and a suffix change renames
every shot without dropping one. A warning that is wrong whenever somebody
flips a flag is one nobody reads.

`node tools/archive.test.mjs` and `node tools/archive.exit.test.mjs`: 31 and 4
cases, all passing.

### 10.2 Widening the zero-dimension gate — item 6: already done, and it works

**Cheap: it was already in scope and needed no change.** `--scan` sniffs PNG
magic bytes on extensionless files precisely because the original stray had no
extension, so it catches both new ones:

```console
$ node tools/archive.mjs --scan .
[archive] scanned 1513 candidate file(s) under .
[archive] !! 2 file(s) are not usable images at all:
  100    PNG is 1200x0 — a valid file containing no pixels.
  560    PNG is 0x0 — a valid file containing no pixels.
```

Both 65 bytes, RGBA, bit depth 8. `100` is 1200×0 at 06:01:35; `560` is 0×0 at
05:53:56; the earlier `640` was 0×0 at 03:12. The gate is sound and pointed
correctly. What is missing is not scope, it is that **nothing runs it** — which
is why the one-liner is in §10.6.

**Still not attributed, and now less likely to be a committed harness.** Every
`page.screenshot` call site in `tools/` was checked. `probe.mjs` remains the only
one taking a bare positional as an output path with no `.png` appended, and its
viewport is hard-coded 1600×900 with no `clip`, so it cannot produce either
dimension. The filename fits and the contents do not, for the third time.
The three names are bare numbers — `640`, `560`, `100` — and no committed tool
produces an output path shaped like that, which points at an ad-hoc `node -e`
one-liner rather than a harness in the repo. That would leave no trace in
`tools/` at all, and a repo-root scan is the only net that catches it.

**A defect in my own check, found by running it repo-wide.** The scan produced
ten flags, of which four were the legitimate `nzid` false-colour ID passes in
`shots/system3/_look/` — 1600×900, above the megapixel exemption, and
compressing to 0.010 B/px because a flat-shaded region map is supposed to. Four
false positives in ten flags is how a check becomes something everyone scrolls
past, which is the same outcome as not having one.

The fix is not a better threshold. It is that the same test has different
authority in different places, so severity now follows location:

| Class | Test | Fails the scan? |
| --- | --- | --- |
| Not a PNG, zero dimension, below the absolute byte floor | structural | Yes, anywhere |
| Implausibly flat, in `shots/<system>/` or a `rounds/` directory | heuristic | Yes — a critic may be handed it |
| Implausibly flat, in a `_`-prefixed scratch directory | heuristic | Named, not failed |

The corollary is a convention worth adopting: **put diagnostic renders in a
`_`-prefixed subdirectory** and the flatness test stops shouting at you. The
four `shots/system2` black frames still fail, correctly — they are promoted
stable copies and they are genuinely broken.

### 10.3 The `.shot-build/` destroyer, found — and it needed no misuse

The build directory wipe that cost Car two rounds (NOTES case 43) has a
mechanism, and it is `tools/shoot.mjs`:

```js
const SYSTEM = arg("system", "system1");
const BUILD_DIR = `.shot-build/${SYSTEM}`;
// await build({ build: { outDir: BUILD_DIR, emptyOutDir: true } })
```

`arg()` returns whatever followed the `=`, so `--system=` — a shell variable
that expanded to nothing, a command pasted with the value trimmed — makes
`SYSTEM` the empty string, `BUILD_DIR` the shared root, and the build deletes
every sibling's bundle. Confirmed by evaluating the two lines in isolation:

```console
SYSTEM=""  BUILD_DIR=".shot-build/"  PORT=5107
```

`.shot-build/` still holds the orphaned root-level `index.html` and `assets/`
that this produced. Nothing in the defaulting is wrong — `arg("system",
"system1")` supplies a default for a *missing* flag, and `--system=` is present
and empty. The bug is entirely in the join: **an empty string interpolated into
a path silently removes a level.**

That is the same shape as the zero-pixel PNGs written to paths named `640`,
`560` and `100`. An argument that is empty or mis-parsed becomes a path, and the
path is acted on without being checked. One shape deleted six directories; the
other created files a critic could have been shown.

Landed: `tools/scratch.mjs` exports `assertPrivateBuildDir(root, outDir, tag)`,
refusing the repo root, anything outside the repo, and any bare shared root
(`.shot-build`, `dist`, `shots`, `tmp`, `tools`, `src`, `.work`). One line before
each destructive build, now guarding `shoot.mjs` (**not mine — mechanical,
zero-behaviour-change on every valid invocation, flagged here per the coordination
rule**), plus `perf.mjs`, `stress.mjs`, `bloom-cost.mjs`, `shadow-type-ab.mjs`
and `texture-audit.mjs`.

```console
$ node tools/shoot.mjs --system=
[shoot] refusing to build with outDir=".shot-build/". ".shot-build/" is shared by
every harness in this repo, and emptyOutDir:true would delete all of it ...
exit 1
```

This is also the most plausible cause of item 3. "Two of four Pumps runs died on
`page.goto`" and "the preview server stopped answering mid-round" are exactly
what a concurrent wipe of the directory being served looks like — intermittent,
unattributable, and self-healing on retry, which is precisely the profile case
43 describes. It is a hypothesis, not a measurement: I did not reproduce the
wipe against a running preview server.

My scratch moved to `tmp/<name>/` per instruction, and `tmp/` is now gitignored.
The `dist-*` directories from last round are deleted.

### 10.4 The pipeline exit code — item 5

`node tools/shoot3.mjs | grep | tail` reports **`tail`'s** status, and `tail`
succeeds essentially always. Every assertion in the harness can fire and `$?` is
still 0. It defeats work done anywhere upstream — the completeness assertion,
the GPU check, the zero-dimension gate — and it is general rather than Pumps'
alone. Written up as a NOTES case with three fixes; the one worth defaulting to
is keeping the whole log, because `grep` also discards the part of the output
that usually contains the error:

```bash
node tools/shoot3.mjs > tmp/shoot3.log 2>&1; echo "exit $?"; tail -40 tmp/shoot3.log
```

It caught me twice while writing this section, which is the best evidence I can
offer that it is general:

- The verification run in §10.2 was piped through `tail -40` and produced no
  output for three minutes, because the pipe buffers.
- `node tools/archive.test.mjs | tail` reported **exit 0 while the suite exited
  1**. The suite creates four partial rounds deliberately, so the new exit hook
  fired on its own success — a real bug in my test, hidden by `tail` for as long
  as I read it through a pipe. Both of this round's findings, each catching the
  other. The suite now clears the ledger it filled on purpose, via an exported
  function rather than an environment variable: an env var that disables a safety
  check is one somebody exports in a shell and forgets.

### 10.5 Shot time, ~20 s → ~37 s — item 4: not priceable tonight

Not measured, and deliberately not estimated. Shot time is wall clock, and the
`--park=120` control established that this host cannot produce a trustworthy
wall-clock number tonight: the *identical static frame* rendered at 11.8 ms and
122.8 ms within one run, with the parked mean worse than the walking steady
state. A 20→37 s regression is an 85% increase in a quantity whose noise floor
was measured at 10× on this host, so any figure I produced would be withdrawn
later.

What can be said without timing:

- The per-shot settle is a **fixed frame count**, so shot time scales directly
  with frame time. Anything that made frames slower makes every shot slower by
  the same factor, and six systems landed work tonight.
- Program count went **70 → 144** overnight. First-frame shader compilation is
  serial and lands in init, which is inside every harness's per-shot budget when
  the harness navigates per shot.
- Init is also where the browser died, so this number matters beyond harness
  convenience. It is the same reason the bloom `OutputPass` warning was routed to
  Lighting: moving tone mapping there recompiles all ~144 materials at init.

The measurement to make once the host is quiet: `node tools/perf.mjs
--seconds=180` reports `readyMs` per navigation, which is the init component of
shot time, isolated from the settle.

### 10.6 Two lines to adopt, for broadcast

Same form as the budget guard. Every harness, tonight:

```js
// 1. In the openRound() call, declare what the round is contracted to produce.
//    finalise() then refuses to report success on a partial round, and cannot be
//    silenced by a teardown catch.
const round = await openRound({ /* ...existing... */ expect: SHOTS });
```

```bash
# 2. Before handing any capture to a critic. Exits 1 on a broken image anywhere
#    in the repo, needs no browser, takes about a second.
node tools/archive.mjs --scan .
```

Four caveats, so nobody is surprised:

1. **A round that writes zero PNGs now fails** even without `expect`. That is
   intended and it is the first reported fault.
2. If a harness legitimately captures a variable set, pass the computed list —
   `round.requireAll(names)` — rather than the full preset list.
3. A harness that already knows it failed should pass `finalise({ failed:
   reason })`, or keep the existing `outcome: "failed"` convention, which is
   honoured. Both suppress the second error so the real cause survives.
4. `--scan .` currently exits 1 on the two stray zero-pixel files in the repo
   root. That is the check working, not a false positive; delete them and it
   passes.

### 10.7 Routed, and one honest gap

- **8.00 MB of exact duplicate textures → Pumps.** Three groups of two
  byte-identical 1024×512 RGBA sources each, one pair per pump. Detail in §9.3.
- **110 MB is not attributable to the scene graph.** 717 MB of GL-live texture
  bytes against 607 MB reachable by traversal. Stated rather than guessed at:
  the table covers 85% of the card and the remaining 15% is unexplained, not
  assigned to whoever looked most likely.

---

## 11. The init path: programs are not what it is made of

**This section retracts my own framing.** I named serial shader compilation as
what the rising shot time and the 25 s init are made of, and the parent routed it
as "the highest-value remaining performance work". Measured, it is **8.3% of
init**. The program count is real, it has grown further — 183 now — and it is
not the init cost. **Terrain's `init()` is 63.6%**, which is 7.6× the whole
scene's shader compilation.

Measured with `tools/program-audit.mjs`, which reads three's own program cache
rather than inferring anything, on `?shot=lot` at 1920×1080 on the RTX 4060.

### 11.1 The census

| | |
| --- | --- |
| Programs in three's cache | **183** |
| GL links / creates / deletes | 192 / 192 / 9 |
| Programs used by exactly one material | **115 of 183 (63%)** |
| Materials | 223, of which **127 have an `onBeforeCompile`** |
| Attribution coverage | 223 / 223 materials mapped to their program |
| Cache key length | 243 – **5302** characters |

**The count is still climbing, and faster than the report can keep up with**:
70 → 144 → 162 → **183**, the last two of those thirty minutes apart tonight
while I was measuring. Materials went 211 → 223 in the same interval. Any figure
below is stated against the run that produced it, not against "the scene".

### 11.2 The compile cost, three ways

Wall-clock init varied 24.8 / 26.7 / 30.8 s across three runs — ±20%, the same
noise floor that made item 4 unpriceable. So the load-bearing figure is a
*ratio* measured from GL calls, which is robust to that.

1. **Direct: 1.6 – 2.0 s blocked on the driver, = 6.5 – 8.3% of init.**
   `compileShader` and `linkProgram` are asynchronous and cost nothing to call;
   the stall lands in `getProgramParameter(LINK_STATUS)`, which forces a
   synchronous wait. Timing those gives 1873 ms for 192 programs (worst single
   program 77 ms). **The ratio held at 6.5 – 8.3% across four runs while init
   itself moved 20% and the program count moved 13%** — which is the point of
   measuring a ratio from GL calls rather than a duration from a clock.

2. **Ordering: the links are spread across the whole of init, not stacked at
   first frame.** First link at 0.2 s, last at 25.1 s of a 25.2 s init.
   Compilation is interleaved with generation as each system builds its
   materials. **There is no first-frame compile cliff**, which is what I had
   asserted ("144 programs is a long shader-compile stall on first frame").

3. **Reload control: inconclusive, and worth reporting as such.** Reloading the
   same URL in the same browser should warm the driver's shader cache and bound
   the compile share from above. Init did not improve (25.7 s against 25.2 s,
   i.e. slightly *worse*) — but `blockedMs` was unchanged too, 1968 ms against
   1873 ms, which shows the shader cache **did not warm**. A control that did
   not apply is evidence about nothing, so it is reported as inconclusive rather
   than as corroboration of the two measurements it appears to agree with. The
   one thing it does establish: a warm shader cache is not available to help
   this scene.

`KHR_parallel_shader_compile` is present in the context, so if three were
polling `COMPLETION_STATUS_KHR` the blocking figure would under-report. It is
not: `renderer.capabilities.parallelShaderCompile` is unset, and the measured
71 ms worst-case block is only consistent with three blocking.

### 11.3 What this settles for two blocked decisions

Both were waiting on program count as the shared currency, and both get a number
rather than a warning.

- **The `OutputPass` for Lighting: ~1.9 s of extra init, not a browser-killer.**
  Moving tone mapping to an `OutputPass` invalidates every material and forces a
  full recompile. A full recompile of this scene is measured at 1.87 s of driver
  block for 192 programs, so the cost is **+1.9 s on a ~25 s init, about +7%**.
  My earlier warning — "recompiles all ~144 materials, which lands in init, and
  init is where the browser died" — was true in every particular and misleading
  in total. **Priced, it is affordable**, and it is smaller than the error bar on
  init.

- **PCSS promotion: the same class of cost.** Changing the shadow map type
  recompiles every shadow-receiving material, so it lands in the same ~1.9 s
  envelope, on top of the 192 MB already recovered at peak by the
  `BasicShadowMap` branch.

Both were being weighed against "init is where the browser died". Neither is
within an order of magnitude of Terrain's 14.3 s, so neither should be blocked on
init cost.

### 11.4 Consolidation: 6 programs, ~56 ms, and my recommendation is to leave it

The parent's question was whether a meaningful share of the 162 are
near-duplicates differing only in a constant. **It is not a meaningful share.**

The method is the inverse of the one used last round. `texture-audit.mjs` asks
whether materials *sharing* a key generate different source — a correctness bug;
the answer is 0 across 51 groups. This asks whether materials with *different*
keys generate identical source — a waste bug. Five families, all with
deliberate, readable keys, verified at the source:

| Family | Owner | Wasted |
| --- | --- | --- |
| `bgfres:glass` / `bgfres:glass-inner` / `bgfres:cooler-glass` | Building | 2 |
| `wd:asphalt` / `wd:asphalt-lot` | Terrain | 1 |
| `wd:concrete` / `wd:concrete-ao` | Terrain | 1 |
| `wd:paint-white` / `wd:paint-yellow` | Terrain | 1 |
| `bw:steel-int` / `bw:steel` | Building | 1 |
| | | **6 of 162** |

In each pair the boolean flag suffix — which is what actually gates the
generated GLSL — is identical, and the differing part is an identity label.
Checked at the site this time: in both `worldDetail.ts` and
`buildingWeather.ts`, `opts.key` appears **only** in the cache key and in error
messages, never in shader text.

At ~9.4 ms of driver block per program, 6 programs is **~56 ms of a 25 s init,
0.2%**. **Recommendation: do not act on this.** Merging keys means asserting that
two materials will generate identical source for all future edits, and the check
that proves it today is a mock, not the real shader. That is a permanent
correctness risk for 56 ms. The 59%-used-once figure looks like variant
explosion and is not: the variants differ in real flag combinations.

### 11.5 Where init actually goes — and the honest gap

Shader compilation is 8.3%. The other ~92% was attributed to nobody, because
`?solo=`/`?skip=` need one run per system and init wall time moves ±20% between
runs, so seven runs cannot be compared with each other.

Landed in `src/core/Game.ts`: two `performance.now()` calls around each system's
`init()`, published as `window.__INIT_TIMINGS` and logged as one line. **Pure
instrumentation, no behaviour change**, and it reports all systems from a single
run so the numbers are mutually comparable. Every harness can read it.

**22.4 s of the 25.2 s load is system `init()`, and one system is two thirds of
it:**

| System | Init | Share |
| --- | --- | --- |
| **terrain** | **14.27 s** | **63.6%** |
| building | 3.44 s | 15.3% |
| pumps | 1.69 s | 7.5% |
| vegetation | 1.25 s | 5.6% |
| car | 1.21 s | 5.4% |
| canopy | 0.49 s | 2.2% |
| lighting | 0.09 s | 0.4% |
| player / audio / interaction | 0.00 s | 0.0% |
| *(shader compile, interleaved in the above)* | *1.87 s* | *8.3%* |

**Terrain's init alone is 7.6× the entire shader compile cost of the scene.** If
init is the phase that has to survive on the user's machine for a single
continuous 15–20 second take, then the init work is a Terrain question and it was
never a program-count question.

**I have not looked inside Terrain's 14.3 s.** That is its file and its call. What
it gets instead is the instrument, one level down from the one above.

#### `src/core/initPhase.ts` — sub-phase timing, for Terrain to drop in

Same two-call shape as the `Game.ts` change, so the boundaries are the section
comments `TerrainSystem.init()` already has:

```ts
init(ctx: SystemContext): void {
  const phase = initPhases("terrain");

  phase("material library");
  const asphaltMaps = makeAsphalt(2048, 8, 1337);
  const concreteMaps = makeConcrete(1024, 4, 99);

  phase("scattered stones");
  // ...

  phase.end();
}
```

`phase.of("asphalt 2048", () => makeAsphalt(2048, 8, 1337))` times a single call
and returns its result. Results land in `window.__INIT_PHASES.terrain` and are
logged as one line; `tools/program-audit.mjs` prints them as a table when
present, and prints nothing when absent.

**It reports what it does not account for.** `phase.end()` publishes
`unaccountedMs` — wall time between construction and `end()` that no phase
claimed — and prints it as its own row. A helper that reported only the phases it
was handed would let a system instrument three cheap sections, watch them sum to
400 ms, and conclude init was fast with 13 s sitting in the gaps. Same rule as
the texture table: 85% attributed with the remainder named as unknown beats 100%
attributed by guessing.

Tested, 16 cases, in `tools/initphase.test.mjs` — the real source, transformed
and imported rather than transcribed. It is instrumentation, so a defect does not
break the scene; it quietly reports the wrong number to whoever is trying to find
14 seconds, which is the failure mode this project has lost the most time to. The
cases worth knowing: unaccounted time is never folded into a labelled phase, a
`phase.of` that throws still closes its phase (otherwise every later phase
inherits the failed one's label), a re-entered label accumulates into one row,
`end()` is idempotent, and a helper that is never ended publishes **nothing**
rather than a misleading zero.

One caveat, documented at the top of the file: `performance.now()` deltas around
an `await` include anything else the event loop ran. `Game.ts` awaits each system
in turn so there is usually nothing to interleave, but prefer boundaries around
synchronous work.

Two caveats on the table. The four largest entries are the four systems that
generate procedural textures, so this is very likely CPU-side generation rather
than anything GPU-bound, but that is an inference and not measured here. And
`lighting` at 0.09 s does not mean lighting is free — its world-capture PMREM
cost lands in render, not in `init()`.

### 11.6 A defect in this round's own instrument, of a class already documented

The wasted-variant detector runs each hook against a mock shader and hashes the
result. Its first version reported **51 materials with 21 distinct keys as one
shader, and 91 materials as another — including `sky-dome`, which has no hook at
all.** Both were artefacts: the mock contained `#include <common>` and nothing
else, so hooks targeting the other 14 chunk tokens found nothing, no-op'd, and
produced byte-identical output.

The sharp part is that **the correct mock already existed in
`texture-audit.mjs`, written by me hours earlier, with 25 chunk tokens.** The
mechanism was solved and then reimplemented from scratch rather than shared. Two
copies now exist and both need updating when a hook targets a new chunk;
extracting them into one module is a recommendation, not something to land
against a working tool at this hour.

The detector now separates what it can establish from what it cannot: families
whose members all use a deliberate readable key are claimed; families whose
members use three's default key — the hook's own source text — are printed as
**unestablished**, because identical output against a mock may only mean the
mock lacks the hook's replace target. Two such families remain (51 pump
materials, 5 car materials) and neither is claimed as a saving.

---

## 12. Texture consolidation, re-measured on the current scene

`node tools/texture-audit.mjs`, grouped by `source.uuid`. The scene has moved a
lot since the last audit — Terrain at 24,000 stones, Car's reversed geometry
fixed, the canopy landed — so these are fresh numbers, not a restatement.

| | |
| --- | --- |
| Unique texture sources | **119** |
| `THREE.Texture` wrappers referencing them | **911** |
| Ratio | **7.66 wrappers per source** |
| Scene-graph total | 638.76 MB |
| GL live / peak | **748.77 / 757.07 MB** |
| Not attributable to the scene graph | **110.01 MB** |

**The 7.66 ratio is the clone-versus-source rule getting worse, not better.**
Anyone counting `Texture` objects — or `renderer.info.memory.textures`, which is
a count and not bytes — now overstates GPU cost by more than seven-fold.

### 12.1 What is available

| Finding | Owner | Size | Status |
| --- | --- | --- | --- |
| 3 groups of byte-identical 1024×512 sources, one pair per pump | Pumps | **8.00 MB** | routed, confirmed unchanged at 2.67 MB × 3 |
| One flat single-colour 128×128, `raw(46,41,36)` | Canopy | 0.08 MB | negligible; a 1×1 would do, not worth a round |
| Three 2048² asphalt maps shared by `highway` / `lot` | Terrain | 64 MB | already its decision, with its own 3.9 mm/texel reasoning |
| Cache-key collisions | — | 0 of **50** key groups | clean again |

**That is the whole list.** `paint-white` and `paint-yellow` looked like the
obvious next candidate — 21.33 MB each, four 1024² maps apiece, and the program
census showed the two generate *identical shader source* — but the byte-identical
check does not group their textures, so the maps genuinely differ. Which is what
you would expect: the `alphaMap` is the marking's shape, and white and yellow
markings are different shapes. **No claim.**

### 12.2 The 110 MB stays declined — with one new fact about it

It is not attributed. But it is worth recording that **it did not move**: 110 MB
at the last audit against a 607 MB scene-graph total, and 110.01 MB now against
638.76 MB. The scene grew ~32 MB and the gap did not change.

A gap that is constant while the content it is measured against grows is
evidence about its *nature* without being evidence about its owner: it behaves
like a fixed set of allocations rather than a diffuse under-count spread through
the scene. Fixed-size candidates exist — the default framebuffer and its MSAA
attachments at 1920×1080 are in the right order of magnitude, and §9 already
measured 237 MB for buying multisampling back through a composer — but naming one
would be a guess, and the table is more useful with 85% attributed and the
remainder named as unknown.

### 12.3 A check on my own landed fix, which passes

`light:sun` shows 320 MB, and one line of that looked like a regression: a live
`8192x8192` colour attachment at 64 MB, which the shadow work was supposed to
have removed.

It is not a regression, and the audit output says so if read carefully: the
format is **`Red/u8`**, not RGBA8. That is the converted attachment.
`reclaimShadowColourAttachments` turns RGBA8 into R8 — 256 MB down to 64 MB,
which is precisely the 192 MB reported. The residual is the intended cost.

Whether the last 64 MB can go at all: three's `WebGLRenderTarget` always creates
and attaches a colour texture, and framebuffer completeness forbids shrinking it
below the depth attachment's dimensions, so removing it entirely means a
depth-only FBO. WebGL2 permits that; three does not express it. **Untested, and
I am not claiming it** — it is a real 64 MB with a real mechanism and an unknown
chance of three refusing it.

### 12.4 On the `DoubleSide` caution, for the record

Noted, and it applies directly to the kind of pass I would otherwise call free.
Setting `side` correctly reads as a pure win — fewer rasterised triangles, no
visual change — and on four of Car's meshes it would instead have *revealed*
reversed geometry that `DoubleSide` was concealing. The change is not free; it is
a change that can expose a pre-existing defect, and the defect surfaces as a
visual regression attributed to the performance pass.

The general form is already in NOTES from the other direction: a fix that
uncovers a bug looks exactly like a fix that caused one. Anyone doing a `side`
pass should expect to find geometry, not to save triangles.

Terrain's 24,000 stones at 60.5 drawn triangles each — ~1.45 M triangles per
frame, almost all of it rasterising into the shadow cascades — is consistent with
that framing and with its own read that the lever is cascade membership rather
than the mesh. I have not measured it; the figure is Terrain's.

---

## 13. Headroom for the deliverable run

The product is a single continuous 15–20 second take that has to survive init and
then hold framerate on an 8 GB RTX 4060 in a browser. This section prices that
run.

**Measured while six sibling agents rendered on the same card**, which matters
differently for each half: the memory figures are usable because the method is
baseline-relative, and the frame times are not usable in absolute terms at all.

### 13.1 Card VRAM, by phase

`nvidia-smi` sampled every 250 ms, tagged with the harness's phase, with the
first 8 s taken before anything of ours launched.

| Phase | min | mean | max | vs baseline | GPU |
| --- | --- | --- | --- | --- | --- |
| baseline (host alone) | 5499 | 5521 | 5550 | — | 33% |
| browser-launch | 4611 | 5997 | 7371 | +1850 | 43% |
| init | 6386 | 6653 | 7199 | +1678 | 37% |
| steady | 7173 | 7173 | 7173 | +1652 | 31% |
| parked-control | 7045 | 7124 | 7197 | +1676 | 95% |
| walk | 5288 | 7162 | **7655** | **+2134** | 100% |

Card total **8188 MiB**. Host baseline **5521 MiB**, drifting **51 MiB** on its
own.

**Per-process VRAM is `[N/A]` on WDDM**, so card usage cannot be attributed to
our browser directly. Only the rise above baseline is ours, and only where it
exceeds the 51 MiB drift. Two caveats on the table itself, both against my own
numbers: `browser-launch` has a min of 4611 MiB, *below* the baseline, which can
only be a sibling releasing memory — so its +1850 is contaminated and should not
be read as a launch cost. And `steady` has min = mean = max because it is
**a single sample**; it is one reading, not a stable measurement.

**The answer: our tab costs roughly 1.65–2.13 GiB of card memory.** Against 8188
MiB that leaves the user, on a quiet machine, something like 5.5–6 GiB free once
a desktop compositor and a browser are resident. **The margin is comfortable, and
it is comfortable by roughly a factor of three.**

### 13.2 The init transient is gone, which is the crash mechanism closed

This is the number the section exists for, because the user's browser died during
scene generation and not during play.

| | |
| --- | --- |
| GL texture bytes at ready | 748.77 MB |
| GL texture bytes at end of run | 748.77 MB |
| **GL peak, whole run including init** | **757.07 MB** |
| Peak above steady state | **8.3 MB** |

**8.3 MB.** Init no longer has a transient worth naming, against 518 MB of init
transients when this was first measured. At card level the same thing: init max
7199 MiB against steady 7173 MiB, a 26 MiB difference inside the host's own
51 MiB drift.

The crash mechanism was a peak that no longer exists. Geometries 351 → 351,
programs 193 → 193, framebuffers 13 → 13, JS heap 433 → 384 MB across the run.

**Reproduced exactly.** A second, independent 8-minute run over 34,918 frames
returned 748.77 MB at ready, 748.77 MB at end, **peak 757.07 MB** — the same
three figures to the byte, with geometries, programs and framebuffers again flat.
Two runs agreeing to the byte is what makes this the one number in this section I
would quote without qualification.

That second run also demonstrates the drift detector working on itself: its
baseline drifted **1171 MiB** (against 51 MiB in the run tabulated above) and its
`walk` minimum fell to 3875 MiB, well below its own 5445 MiB baseline. **Every
card-level delta in that run is inside its own error bar and has been discarded.**
The GL-level figures are unaffected, because they are counted in the page rather
than read off the card.

### 13.3 If the margin ever needs widening, the levers by size

Named by size rather than by ease, as asked:

| Lever | Size | Status |
| --- | --- | --- |
| 8192² shadow depth map | 256 MB | deliberate deferral (§7); the brief's long crisp shadows |
| R8 shadow colour attachment | 64 MB | needs a depth-only FBO; WebGL2 allows it, three does not express it. **Untested** |
| Terrain's three 2048² asphalt maps | 64 MB | Terrain's decision, with its own mm/texel reasoning |
| Pumps' byte-identical duplicates | 8 MB | routed, mechanical |

At a ~3× margin none of these is needed. The depth-only FBO stays unclaimed.

### 13.4 Frame time: still unquotable, with one exception that matters

GPU utilisation was **95–100% throughout**, from siblings. The proof that the
absolute numbers are host-dominated is the same inversion as before: the
**parked control mean is 19.78 ms while the walking median is 11.4 ms.** A
static frame cannot render slower than a moving one if the scene is the
bottleneck. Every mean, p95 and 1% low in this run is therefore unquotable, and
that includes the flattering ones.

**What survives is a comparison within the run**, which contention cannot
manufacture: frames over 100 ms are not spread across the walk, they are
concentrated in one phase.

| Phase | frames | >100 ms | rate |
| --- | --- | --- | --- |
| parked-control | 909 | **0** | 0% |
| store-interior | 834 | **0** | 0% |
| cooler-open-look | 118 | 0 | 0% |
| cooler-shut-look | 81 | 0 | 0% |
| **cooler-leave** | 277 | **27** | **9.7%** |
| bottle | 24 | 3 | 12.5% |

All twelve worst frames in the run are `cooler-leave`, inside a single ~4 second
window (112.7 – 116.7 s), at a nearly fixed position (−0.49, 37.15), at 464–470
draw calls — so it is **not** a draw-call spike and **not** motion-triggered
streaming, since the camera is barely moving through it.

**Located, not attributed, and not yet established.** This was a one-lap smoke
run, so the hitch was seen once. A hitch observed once in one lap cannot be
separated from a coincident host spike by position clustering alone — the camera
was at that position for those four seconds regardless. The test that settles it
is recurrence across laps.

#### 13.4.1 The recurrence test refutes it

An 8-minute, 34,918-frame run over multiple laps. **The `cooler-leave`
concentration did not recur**, and the finding above does not survive:

| Phase | frames | >100 ms | rate |
| --- | --- | --- | --- |
| store-approach | 825 | 42 | 5.1% |
| cooler-leave | 688 | 32 | 4.7% |
| store-interior | 2651 | 33 | 1.2% |
| store-exit | 1823 | 27 | 1.5% |
| cross-forecourt | 2697 | 26 | 1.0% |
| site-sweep | 12717 | 69 | 0.5% |
| cooler-open-look | 267 | **0** | 0% |
| store-enter | 221 | **0** | 0% |
| parked-control | 929 | **0** | 0% |

`cooler-leave` is no longer distinctive — `store-approach` is worse — and the
twelve worst frames have moved to a different phase in a different lap: nine of
them fall in a **single ~3 second window at 473–476 s in lap 3**, in
`store-approach`, having been in `cooler-leave` in lap 1 of the other run.

**A cluster that moves between laps but stays tight in time is time-correlated,
not position-correlated**, which is the signature of something outside the page,
not a place in the scene. My §13.4 attribution was the coincident host spike I
named as the alternative and then failed to exclude. **Retracted.**

#### 13.4.2 What does survive, and what it is not enough for

One thing resists the contention. The parked control produced **0 frames over
100 ms in 929 frames, in both runs**, while the walk produces them at 0.78%. If
that rate were uniform, 929 frames would be expected to contain about seven, so
observing none twice is not chance. **Frames over 100 ms are genuinely
associated with the camera moving.**

That is still not enough to say the scene hitches. The parked control runs in the
first 20 s of each run and a static frame is cheaper for the driver, so it is not
a clean control for *motion* specifically; and with the GPU pinned at 99–100% by
siblings, a moving frame has no headroom to absorb an external spike while a
static one does. **"The scene hitches during motion" and "the host spikes and only
moving frames cannot absorb it" both fit every number here.** Separating them
needs a quiet host, and the instrument for it now exists: the phase table plus
the parked control, over multiple laps. If the hitches persist and cluster by
phase, it is the scene. If they vanish, it was contention.

**So the deliverable question — will a 20 second take stutter — is unanswered,
and I am not going to answer it from this host.**

#### 13.4.3 One relative result worth having

Phase *ordering* is robust in a way absolute timing is not: contention inflates
every phase, but the medians hold a consistent 4× spread across both runs.

| Area | median frame time |
| --- | --- |
| forecourt-approach | 7.7 ms |
| site-sweep | 7.9 ms |
| pump-1 / pump-3 | 9.3–9.6 ms |
| cross-forecourt | 9.7 ms |
| store-interior | 13.9 ms |
| cooler poses | 30–30.5 ms |

**The open forecourt is the cheapest place in the scene and the cooler is roughly
4× the cost of it.** For a 15–20 second take with any framerate risk, the
forecourt and pump island are the safe ground and the cooler is the expensive
pose — useful for shot planning regardless of what the absolute numbers turn out
to be on a quiet machine.

### 13.5 Two incidental results

- **The store pinch point is fixed.** The cooler, store-mid and store-back are
  now reachable on foot at **every** radius tested including 0.34 m, against
  unreachable at 0.32 m when this was found. Building's fix works.
- **One 404 during the run**: `Failed to load resource: 404 (Not Found)`. Chased
  in §13.7 — it is the browser's default icon request, and it is fixed.

### 13.6 The map-channel gate is wired, and verified in the mode it runs in

`Game.start()` now ends with the call site `gen/textures.ts` asked for:

```ts
if (import.meta.env.DEV) auditSceneMapChannels(this.scene);
```

It throws on the first slot whose texture cannot supply the channel three
samples from it — checking both the declared format and whether the sampled
channel is all-zero in the bytes.

Two details beyond the one line. **It logs its pass count**, because a guard that
passes in silence is indistinguishable from a guard that never ran, which is the
fault this project has paid for most. And it needed a harness: every existing
harness runs `vite build` + `preview`, where `import.meta.env.DEV` is **false**,
so nothing here would ever have executed it — a throwing gate that no automated
run exercises is a landmine with a comment on it. `tools/devgate.mjs` loads the
scene through a real dev server and fails if the gate throws, if the scene never
becomes ready, **or if the pass line is missing**.

Verified: scene ready, gate ran, **0 advisory findings, 0 broken slots**, no
other page errors. Safe to leave throwing.

One incidental observation from it: a dev-server load takes **~4 minutes**
against ~25 s for a built bundle, because vite transforms on demand. Nobody
should read a dev-mode load time as an init measurement.

### 13.7 The 404, chased: the browser's own icon request

**Fixed, in one line of `index.html`.** But the epistemic status matters, because
it is an attribution by elimination and not by reproduction.

What was verified:

1. **The page makes exactly two requests, both 200** — the document and its JS
   bundle — across four separate loads. The scene is entirely procedural: there
   is not one `fetch`, `XMLHttpRequest`, `TextureLoader`, `AudioLoader` or
   `.src =` in `src/`. **Nothing in this app can 404, because nothing in it asks
   for anything.**
2. **`GET /favicon.ico` returns 404** from the preview server.
3. `index.html` declared no icon and there is no `public/` directory, so the
   build contains no icon file. Chrome requests `/favicon.ico` by default when a
   page declares none.

So the only request that can produce a 404 is one the browser makes on its own.

**What was not achieved: reproduction.** No probe run ever recorded the 404 —
every attempt saw two requests, both 200. The favicon fetch depends on tab
state, and the stress harness opens two pages in one context where the probe
opened one. So the chain is: nothing else can 404, this can, and it does at the
server. That is elimination, and it is worth less than a reproduction. It is
reported as such.

One correction against my own probe while chasing it: `GET /favicon.svg`
returned **200**, which reads as "an icon already exists". It does not — there is
no `favicon.svg` anywhere in the tree and the build directory contains only
`index.html` and `assets/`, so the 200 is the preview server's fallback serving
the HTML document. **A 200 for a path is not evidence the file exists.**

The fix is an inline `data:` SVG icon in `index.html`, which makes the request
impossible rather than making it succeed. **File touched: `index.html`** — shared,
but the change is a `<link rel="icon">` in `<head>` with no effect on the scene.

**Impact on the deliverable: none.** The request is cosmetic, happens once at
load, and nothing renders from it — it could not stall a frame or leave anything
unrendered. It was worth chasing to remove it from the list of unexplained
things, not because it was dangerous.

### 13.8 Init reliability is a separate risk, and it is larger than frametime

Chasing the 404 turned up something worse, incidentally. Four cold loads of the
same bundle, minutes apart, under contention:

| Attempt | Outcome | Time |
| --- | --- | --- |
| (first probe) | **`Page crashed` on `page.goto`** | ~14 s |
| 1 | **timed out waiting for ready** | 171.9 s |
| 2 | ready | 30.9 s |
| 3 | ready | 21.9 s |

**One hard page crash and one 5–8× outlier in four loads.** The card had roughly
4.6 GB free during the timeout, so that one is not VRAM exhaustion; init is ~25 s
of mostly procedural CPU work and seven sibling agents were on the machine, so
CPU contention stretching it is the obvious candidate — and, as everywhere else
in this section, contention cannot be excluded from this host. Both faults match
what two sibling agents independently reported.

**This matters more than the frame-time question.** The deliverable is one
continuous take that must survive init once, on the user's machine, with no
second attempt — and a stutter can be re-shot while a failed init cannot be shot
at all. So the quiet-host protocol now measures it explicitly: five cold loads,
pass only at 5 of 5 with ready times inside 2× of the fastest
(`QUIET-HOST-PROTOCOL.md` §2.1).

---

### 13.9 The first load, reconciled: real, and it retro-labels every init figure here

Three results, in the order they were established.

### 13.9.1 I suspected my own instrument, tested it, and was wrong

Both sequences behind the first-load finding came from harnesses I wrote, and both
contained this:

```js
await page.goto(base, ...);
if (i === 1) {                              // attempt 1 only
  gpu = await assertHardwareGpu(page, ...); // allocates a SECOND WebGL2 context
}
await page.waitForFunction(() => window.__SCENE_READY === true, ...);
```

The clock starts before `goto`, so on attempt 1 and only attempt 1 the measured
window contained an extra WebGL2 context allocation, requested with
`powerPreference: "high-performance"`, while the scene was generating, on a card
at 6–8 GB of 8. **"First load" and "the attempt that does an extra thing" were
perfectly confounded across both sequences.**

`tools/firstload.mjs` removes it: the GPU check happens once on a throwaway page
before the loop, and all attempts run a byte-identical path.

| Attempt | Ready |
| --- | --- |
| 1 | **279.1 s** |
| 2 | 25.4 s |
| 3 | 23.3 s |
| 4 | 21.7 s |

**The effect survived and grew — 12.0× against the median of the rest.** The
confound was real and was not the cause. Four sequences now, first load worst
every time: 279.1 s, 218.7 s, 171.9 s (timed out), and one hard crash.

### 13.9.2 Why `stress.mjs` never saw it, and what that costs us

`stress.mjs` launches a fresh browser and a fresh context every run and reaches
ready in ~21–31 s, which looked like a direct contradiction. It is not:

```js
const gpuPage = await context.newPage();
await gpuPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
const gpu = await assertHardwareGpu(gpuPage, { tag: "stress" });
await gpuPage.close();
```

**It loads the app in a throwaway page before the measured page exists.** The
module script begins executing and the renderer starts compiling shaders; then the
GPU assertion runs, then the page closes. The measured load is therefore the
**second** load of the app in that browser process.

So the correction to Film's claim is a reversal of its direction, with its
conclusion intact in the part that matters. `browser.newContext()` gives a fresh
*HTTP* cache, but the GPU program cache lives at the browser/GPU-process level,
not the context level — so contexts 2..N inherit a warm one. It is not that every
measurement was cold. **It is that every measurement was warm**, either because
the harness pre-warms with a GPU-check page or because it measured a repeat.

**Consequence, and it is the reason this section is not a footnote: every init
figure this project has published was measured warm.** The 25.2 s load, the 8.3%
shader-compilation share, the per-system init table, Terrain's 14.27 s. The
relative attribution may well survive — Terrain being the largest share is a
within-run comparison — but **the absolute numbers describe a regime the user
never enters.** The figure for what the user experiences is 171.9–279.1 s, and it
had never been measured because no harness here was capable of measuring it.

**This is the partial retraction that was predicted, and it is owed.** My 8.3%
shader figure is not withdrawn — it is correct for a warm load — but it was
offered as an answer to "what is init made of", and it cannot answer that for the
load that counts. The reload control in that round reported itself
*inconclusive because the shader cache never warmed*; the reason it never warmed
is now visible, and it is that the harness had already warmed it before the
measurement began.

### 13.9.3 The penalty is per-browser-process, not per-machine

Available from data already collected, at no extra cost. Every fresh browser
launch today paid it: 171.9 s, 218.7 s, 279.1 s, each in a different process,
minutes apart on the same machine with the same driver.

**So the warm state does not survive a browser process.** That rules out the
NVIDIA driver's machine-level shader cache, which would persist, and points at
Chrome's per-profile GPU program cache — which Playwright's `chromium.launch()`
discards every time, because it uses a throwaway user-data-dir.

**This is good news for the deliverable, and it supports the README change
already made.** The user records in their own persistent Chrome profile, so they
pay this once and keep the warm state across restarts. "Take the slow load before
you record" is not a workaround for them — it is the whole fix, provided the
profile persists.

**Not established here: the mechanism.** Shader cache versus HTTP cache versus
something else needs Film's condition 3 (same profile, HTTP cache bypassed via
CDP), which discriminates them directly. That instrument is Film's and I am not
duplicating it. What I can say is that the HTTP-cache explanation has to account
for a bundle of two requests and a few MB, against a 250-second penalty.

### 13.9.4 A fifth confirmation, from an agent that was not looking for it

The loading-screen agent instrumented boot to weight a progress bar and measured,
on a fresh profile via `launchPersistentContext`, **283.8 s cold against 30.1 s
warm.** It was not testing this hypothesis, which makes it the cleanest
corroboration available: **283.8 s against my 279.1 s is agreement to within
1.7%**, from a different harness, a different profile mechanism, and a different
purpose.

Its warm loads under heavy GPU contention were 22.5, 25.7 and 30.1 s against my
20.8–25.4 s on a quieter host, which puts a useful bound on the thing the
quiet-host protocol exists to exclude: **contention costs a warm load roughly
10–40%, not a factor.** That is worth having before the frametime run, because it
says the frametime problem is not of the same kind as the load problem.

### 13.9.5 Why none of my instruments could ever have found this

The audit is unflattering and worth recording. **Every harness I have written
samples strictly after `__SCENE_READY`:**

| Harness | Ready wait | First sample |
| --- | --- | --- |
| `perf.mjs` | line 222 | screenshot, line 563 |
| `shadow-type-ab.mjs` | line 132 | screenshot, line 171 |
| `program-audit.mjs` | line 413 | `__GLSTAT`, line 466 |
| `stress.mjs` | before the route | after ready |
| `firstload.mjs` | the measurement | nothing during init |

The good news is narrow: none of them can hit the trap the boot agent found,
where **`page.screenshot` times out at 15 s during Terrain's single unbroken ~12 s
main-thread block**, because that path waits on the main thread — a timeout there
looks like a harness failure and not like a finding.

The bad news is the same fact stated honestly: **init has been a black box with
one number on it for this entire project, and that is why I never saw either the
stall or the cold-load penalty.** My per-system init timings in `Game.ts` are
wall-clock deltas around each `init()` call, which can report *how long* a system
took but nothing about the *shape* of what it did — a 12 s unbroken block and 12 s
of cooperative work are the same number to it.

Two consequences I am adopting rather than recommending:

1. **Sample from Node, not from the page, during init.** My `nvidia-smi` VRAM
   sampler already does this and is immune by construction; the pattern
   generalises. CDP `Page.startScreencast` and CDP metrics polling do not queue
   behind the main thread, which is why the boot agent could see 771 compositor
   frames across a 283.8 s load with a longest gap of 5.49 s.
2. **Ask for that frame-arrival series rather than re-deriving it.** It is a
   high-resolution map of where the process is genuinely stalled versus merely
   slow, which is exactly what an init attribution needs and what a wall-clock
   delta cannot provide. Requested; not yet in hand.

---

## 14. The quiet-host protocol

Written and **not run**: it needs an exclusive GPU window, which is the
orchestrator's call. See `QUIET-HOST-PROTOCOL.md`.

It is deliberately decision-free, because during that window there is nothing
else running to answer a question with. It fixes in advance: the preconditions
and the drift gate that decides whether the host is actually quiet; the single
command (`--minutes=20 --park=120 --baseline=30000`, and **not** `--no-build`);
the five conditions that void a run, including the parked-mean-above-walking-median
inversion that voided every previous run; the pass criteria, with **frames over
100 ms** as the deliverable criterion and 0 as the passing value; what the parked
control must show for the walk to be interpretable at all; and the recurrence
test that distinguishes a place from a moment, written around the mistake in
§13.4 rather than trusting me not to repeat it.

The control is 120 s rather than 20 s for a measured reason: the old 20 s window
gave 929 frames, and at the walk's 0.78% rate of frames over 100 ms that window
expects about seven, which is too few for its absence to carry weight.

---

## 15. Reproducing this

```bash
node tools/perf.mjs --seconds=180              # baseline + three-minute leak walk
node tools/perf.mjs --systems                  # per-system sweep
node tools/perf.mjs --poses=approach,lot,pumps,ground,wide
node tools/perf.mjs --ab='on=;off=noshadowopt=1'
node tools/perf.mjs --query='skip=audio' --seconds=180   # leak hunt on a variant
node tools/budget.mjs                          # measure every shot against budget.json
node tools/budget.mjs --write                  # accept the current scene as the ceiling
node tools/budget.mjs --selftest               # prove the guard still fails when it should
node tools/pixdiff.mjs a.png b.png             # did that change the image?

node tools/stress.mjs --minutes=25             # sustained walk on the real interactive path
node tools/stress.mjs --minutes=8 --park=120   # with a stationary control first
node tools/stress.mjs --minutes=2 --smoke      # one lap, route check, not a result

node tools/bloom-cost.mjs                      # price a render pass in bytes before adopting it
node tools/shadow-type-ab.mjs --shot=ground    # shadow preallocation across shadow map types
node tools/texture-audit.mjs                   # texture bytes by source.uuid, duplicates, cache-key collisions

node tools/archive.mjs --scan .                # is every capture in the repo a readable image?
node tools/archive.test.mjs                    # 31 cases: capture validation + the completeness contract
node tools/archive.exit.test.mjs               # 4 cases: does a partial round actually exit non-zero?
```

Harness scratch goes in `tmp/<name>/`. `assertPrivateBuildDir` refuses a build
whose `outDir` is a shared directory, because `emptyOutDir: true` on one of those
has already deleted two agents' private bundles mid-round — see §10.3.

**Always pass `--park=`** on a machine you do not have to yourself. Without a
stationary control there is no way to tell a scene that hitches from a host that
does, and on this host tonight it was entirely the host. `--no-build` reuses the
previous bundle and warns that the printed source hash may therefore not
describe what is running.

Port 5152 only. Every `perf.mjs` run snapshots `src/` into `.perf-snapshot/` and
builds from there, so a measurement is never taken against a tree being edited
underneath it — **delete that directory when you are done**, or the repo holds a
second stale copy of every source file. Teardown is wired to every exit path;
`_perfkill.ps1` cleans up after a hard kill without touching sibling processes.

## Vegetation's levers for a capability tier, with measured costs

Added because the tier work will need numbers rather than guesses, and these were
captured rather than estimated — 1600x900, from the forecourt centre and the
store door, each layer switched off in turn on an RTX 4060.

| lever | what it costs the frame | what dropping it costs the picture |
| --- | --- | --- |
| `?vdens=` (default 0.74) | scales every scrub layer, near and far | everything; the blunt instrument |
| `roadClusters` = 34, `?vforce=nocorridor` | ~260 instances, no extra draw call, 1314 px | the along-road fringe past 60 m returns to 20-28 degree bare runs |
| `gapClusters` = 16 | ~120 instances, no extra draw call | reopens an 18 m band across the highway at 44-62 m with no layer in it |
| `farClusters` = 58 | ~440 instances, no extra draw call | the far country scatter; the original layer |
| road fringe sheet, `?vforce=nofringe` | 4358 triangles, **1 draw call**, 10.4k px | far ground tone; the band reads as bare graded dirt |
| sprigs, `?vforce=nosprig` | 3128 instances x 8 tri, 1 draw call | near-ground silhouette; the sheet alone reads as a stain |

All three cluster counts are named constants in `scatterScrub` in
`src/systems/VegetationSystem.ts`, adjacent, with the drop order and its
consequences written beside them. The two `vforce` tokens echo `corridorOff` and
`fringeOff` in `__VEGETATION`, so a tier experiment can assert the flag arrived
instead of inferring it from a frame that looks the same.

Cheapest first: `roadClusters`, then the fringe sheet's draw call, then
`gapClusters`. The fringe sheet is the only one of the six that costs a draw
call, and it is 4.4k triangles against the system's 738k.

## 17. Capability detection and quality tiers

The user's requirement: the build must detect the host and configure itself, so it
runs on weak hardware rather than only on an RTX 4060. Everything this document
had measured until now was measured on one card.

`src/core/capability.ts` (new, mine), wired through `SystemContext.quality`.
Three tiers. Verified by `tools/tiers.mjs`.

### 17.1 The shader-compile mechanism, now measured from inside GL

The boot agent's gap analysis attributed the cold load to shader compilation from
the outside — ~262 s of a 284 s load sitting after the last `init()`. The tier
harness measured the same thing from inside the GL layer, via `blockedMs` in
`perf-instrument.js`, and it is not close:

| Load | `blockedMs` (driver blocked in compile/link) | Total to ready | Share |
| --- | --- | --- | --- |
| Cold (first in a fresh browser) | **215,956 ms** | 234.9 s | **92%** |
| Cold, second run, different tier first | **247,004 ms** | 268.7 s | **92%** |
| Warm repeat | 2,003–2,404 ms | 21.6–23.9 s | ~10% |

**That is a ~100x swing in driver compile time either side of a populated program
cache, and it accounts for 92% of the cold load in both directions.** The
hypothesis is now a measurement. It also reconciles the two figures that looked
contradictory: 8.3% warm and ~92% cold are the same pipeline, and the earlier
reload control that came back *inconclusive because the shader cache never
warmed* was pointing at this the whole time.

**The order confound, demonstrated twice by accident and then on purpose.** Tiers
run sequentially in one browser, so the first one measured pays the cold penalty:

- Run A, `high` first: high 234.9 s, medium 21.6 s, low 21.8 s.
- Run B, `low` first: low 268.7 s, medium 23.9 s, high 23.2 s.

**The penalty follows position, not tier.** Any harness that measures conditions
sequentially in one browser and reads the first as a condition effect will
attribute a 10x artefact to whatever happened to go first. `tools/tiers.mjs` now
prints that warning above the table rather than beside it.

### 17.2 What the tiers actually do, measured

Verified with `node tools/tiers.mjs`, 1920×1080, 60 frames settled, tier forced
via `?tier=`:

| | high | medium | low |
| --- | --- | --- | --- |
| Reported tier matches request | yes | yes | yes |
| Programs linked | 202 | **202** | **202** |
| Texture + RBO memory | 737.6 MB | 497.6 MB | **437.6 MB** |
| Triangles drawn | 7,891,985 | 6,627,033 | **5,521,377** |
| Scatter instances | 83,996 | 50,884 | **21,924** |
| Draw calls | 936 | 936 | 936 |
| Shadow map | 8192² | 4096² | 2048² |
| DPR cap / MSAA | 2 / on | 1.25 / on | 1 / off |

Draw calls are identical by design: the density lever lowers
`InstancedMesh.count`, and an instanced draw costs one call whatever the count.

**Landed saving at low: 300 MB of GPU memory and 30% of drawn triangles**, with
74% of scatter instances gone.

### 17.3 The honest failure: the compile-time family is wired and inert

**Programs are 202 at every tier.** The run-time family works; the compile-time
family does not, and the compile-time family is the one that matters most.

This is precisely the failure that was predicted: *a tier that cuts triangles
while leaving the program count intact misses the thing that hurts most.* At 92%
of a cold load, program count is what the user waits for, and **the low tier
currently buys a weak machine nothing at all on first load** — only on frametime
once it is running.

The reason is structural rather than a bug. `shadowFilter`, `transmission`,
`worldCapture` and `detailPatches` are exposed on `ctx.quality`, but **nothing
reads them yet**, because the `onBeforeCompile` patch sites and material variants
live in five other owners' files and they are converging. What I could reach from
my own files, I took:

| Lever | Applied from | Status |
| --- | --- | --- |
| DPR cap, MSAA | `Game.ts` constructor | working |
| Shadow map size | `Game.ts` clamp before preallocation | working, −300 MB |
| Shadow filter type | `Game.ts` `shadowMap.type` | working (source, not count) |
| Scatter density | `Game.ts` `InstancedMesh.count` | working, −74% instances |
| Anisotropy | via `setMaxAnisotropy` | working |
| **PCSS patch family** | `LightingSystem` | **hook needed** |
| **Transmission** | `Vegetation`, `Building` | **hook needed** |
| **World capture** | `LightingSystem` | **hook needed** |
| **Detail patches** | `TerrainSystem` | **hook needed** |

### 17.4 The four hooks, for routing

Each is a conditional around work that already exists. None changes the default
path: at `high` every flag is the current behaviour, so a system that adopts the
hook ships byte-identically on a 4060.

```ts
// LightingSystem — skip the PCSS onBeforeCompile patch entirely
if (ctx.quality.shadowFilter === "pcss") { /* existing patch */ }

// LightingSystem — cheap sky instead of a world capture into the env map
if (ctx.quality.worldCapture) { /* existing capture */ } else { /* sky only */ }

// Vegetation / Building — transmission is a large shader and an extra pass
material.transmission = ctx.quality.transmission ? EXISTING_VALUE : 0;

// TerrainSystem — applyWorldDetail's per-material variants
if (ctx.quality.detailPatches) { /* existing applyWorldDetail */ }

// Any system building a scatter layer — build fewer rather than drawing fewer
const n = Math.round(AUTHORED * ctx.quality.scatterDensity);
```

The last one is worth more than it looks. My density lever lowers `count` **after**
the instances have been generated and uploaded, so it saves frametime but not
init time or memory. A system that builds fewer saves all three, and on a low tier
that is generation work a weak CPU never has to do.

### 17.5 What is measured and what is inferred

Stated plainly because this is where it will break on a real user's machine.

**Measured, on a 4060:** every figure in §14.2. Tier selection applying. The
shadow clamp. The density lever. The 92% compile share.

**Inferred, and untested:** every threshold in `classify()`. There is no potato
PC here, and **you cannot test one on a 4060.** Specifically unvalidated:

- That `MAX_TEXTURE_SIZE < 8192` implies a machine wanting `low`. Plausible, unverified.
- That `deviceMemory <= 4` and `cpuThreads <= 4` are the right cut points. Guesses at the boundary, chosen to demote rather than promote.
- **That the `low` tier is actually sufficient to run on integrated graphics.** Nothing here can establish that. It is 300 MB lighter and 30% fewer triangles, and it still compiles 202 programs — which on a slower compiler is the four-minute wait, worse.
- Absence of `KHR_parallel_shader_compile` as a demotion signal. Directionally certain given §14.1, magnitude unknown.

The honest summary: **the mechanism is verified, the classification is not.** A
forced `?tier=low` is known to work and known to be lighter. Whether the automatic
choice picks correctly on hardware nobody here owns is untested, which is why
`?tier=` exists and why the tier is logged on one pasteable line.

## 18. Suite-wide timeout audit: 27 readiness waits shorter than a cold load

`tools/timeoutaudit.mjs` (new, re-runnable). Scans every harness for readiness
and navigation timeouts and grades them against the worst cold load measured
here, 302.5 s.

**A timeout shorter than the thing being measured converts "slow" into "failed"
and destroys the number** — and destroys it in the most misleading way available:
a healthy build reports "never became ready" with an empty page console, which is
indistinguishable from a shader link failure.

### 18.1 The result

119 timed sites across 41 harnesses. **27 fatal readiness waits in 26
harnesses**, every one of them shorter than a load this project has already
measured:

| Timeout | Sites | Harnesses |
| --- | --- | --- |
| 90 s | 3 | `hotfix`, `lightProbe`, `shoot7` |
| 120 s | 4 | `probe`, `shoot`, `soilprobe`, `walkprobe` |
| 180 s | 4 | `audio`, `gpucheck`, `probe-winding` |
| 240 s | 16 | `carenv` (×4), `envbind` (×2), `filmwalk`, `probe-rank`, `probe-unseen`, `shoot1`, `shoot3`, `shoot4`, `shoot5`, `shoot6`, `shootcar`, `tilescan`, `vegshadowprobe` |

****The 240 s tier is the dangerous one, not the 90 s tier.** A 90 s budget fails
every cold load and would have been noticed immediately as "this never works". A
240 s budget sits *inside* the measured cold-load range of 221–302 s, so it fails
intermittently and looks like flakiness rather than like a misconfiguration. That
is the population of "lost rounds" reported across the project tonight.

Retroactively this is consistent with, and is the most plausible explanation for,
the two `page.goto` deaths in my own runs, Pumps' two crashed runs, Lighting's
opaque HTTP failures, and the four rounds that wrote zero captures across three
systems.

### 18.2 Starved polling is a separate fault, and 26 harnesses have it

`page.waitForFunction` defaults to `polling: "raf"`, and **rAF does not fire while
the main thread is blocked.** So a rAF-polled readiness wait is starved during
exactly the window it exists to observe. **32 sites across 26 harnesses.** Raising
the timeout without also setting `polling: 500` fixes half the fault.

### 18.3 Two claims I withdrew before publishing

The first version of this audit reported **120 fatal sites**. That number was
wrong three times over, and the corrections are worth more than the number:

1. **It could not resolve named constants.** `timeout: READY_TIMEOUT_MS` read as
   absent, so it graded `tiers.mjs` — which passes an explicit 420 s — as
   inheriting Playwright's 30 s default. **A scanner that punishes good style and
   calls it a defect is worse than no scanner.**
2. **It read documentation as code.** A `waitForFunction` inside `firstload.mjs`'s
   header comment, showing callers what to do, was reported as a live site.
3. **It graded navigation like readiness, which overstated the problem ~3x.**
   `src/main.ts` calls `game.start()` **without awaiting it at top level**, so the
   module finishes evaluating immediately and `load` fires long before init
   completes. Of 73 navigation sites, 41 use `waitUntil: "load"`, 30
   `"domcontentloaded"`, 4 `"commit"` — all early. **None of them waits on a cold
   init**, so a 60 s navigation timeout there is untidy, not fatal.

The tool now reports unresolvable identifiers as `UNKNOWN` rather than grading
them, on the same principle as the null-measurement rule: a verdict about
something never measured is not a verdict.

### 18.4 Fixed, and by whom

**Mine, fixed:** `perf`, `stress`, `program-audit`, `texture-audit`, `bloom-cost`,
`shadow-type-ab`, `budget`, `firstload`, `devgate`, `tiers`, `coldload` — all
readiness waits now `timeout: 420_000, polling: 500`.

**Not mine, reported:** the 26 harnesses in §15.1. The fix is two edits per site
and needs no coordination:

```js
await page.waitForFunction(() => window.__SCENE_READY === true, null,
  { timeout: 420_000, polling: 500 });
```

`node tools/timeoutaudit.mjs` exits non-zero while any fatal readiness site
remains, so it can gate.

### 18.5 Single-browser multi-arm capture is not an optimisation

Folding in Building's result — six captures in 355 s in one browser against
roughly 1500 s as separate runs — with the mechanism now measured at 216–247 s of
driver compile per cold browser:

**One browser pays the compile once. N browsers pay it N times.** At ~230 s per
cold start, the arm count is nearly free and the browser count is nearly all of
the cost. So `--ab=`-style multi-arm capture in a single browser is **the only
sane way to capture anything cold**, and any harness that loops "launch, measure,
close" is paying the dominant cost once per iteration for no return.

The counterpart, from §17.1: because the first arm in a shared browser pays that
compile and later arms do not, **the first arm must never be read as a condition
effect.** The same property that makes single-browser capture cheap makes its
first measurement incomparable.

## Vegetation honours `ctx.quality.transmission`, and the program count does not move — measured, with the reason

Wired at one chokepoint (`VegetationSystem.maybeTransmit`) so the gate cannot be
honoured at three call sites and missed at a fourth. `high` takes exactly the
previous path: draws 351 and 4,594,731 triangles at `storedoor`, identical to the
pre-change baseline.

The result, from `shoot6` which now prints program count and Vegetation's share of
it on every capture:

| arm | draws | triangles | programs | of which foliage-transmission |
| --- | --- | --- | --- | --- |
| default (`high`) | 351 | 4,594,731 | 143 | **6** |
| `?tier=low` | 351 | 2,836,145 | 143 | **0** |

The flag works. `__VEGETATION` echoes `transmission:false`, and all six of the
programs carrying the `foliage-transmission` cache key are gone. **And the total
is unchanged, because those six were replaced one-for-one by six stock-key
programs.**

That is not a bug in the flag, it is a property of what `onBeforeCompile` costs.
Vegetation has six materials whose *define sets* are unique in this scene —
combinations of `map`, `alphaTest`, `vertexColors`, `DoubleSide`, `shadowSide` and
`dithering` that nothing else uses. Three keys the program cache on the define
set, so each of those six costs a program whether or not a shader is injected
into it. The transmission hook never added programs. It made six existing
programs **bigger**.

### The consequence for the tier pass criterion, which matters beyond this system

**Program count cannot see the change every owner was just asked to make.** The
request going out to owners is to gate `onBeforeCompile` sites and material
variants. Gating an `onBeforeCompile` site reduces program *size*; it only reduces
program *count* in the special case where the material's defines then collide with
another material's. So a round of these changes could cut cold compile time
substantially with the count pinned at 143, and a harness whose headline criterion
is count would report no progress — while a change that merged two materials and
saved nothing but a link would report a win.

Both numbers are real, they are not the same number, and the one the user feels is
the 216 s. Suggest adding either per-program link time or time-to-first-frame from
a cold profile, and keeping count as a secondary. This is the same shape as the
`?` column: a criterion that cannot move is as blind as one that was never read.

### What would move Vegetation's count, and what it costs

Six material variants, so six programs. Collapsing them at `low` — one shared
foliage material across kinds and variants, uniform `alphaTest` and `side` — could
plausibly take 6 to 2 or 3. That is a real change to the material layer with a
visible cost (per-kind `alphaTest` and `shadowSide` were both tuned against
specific defects), not a one-liner, and it is not being taken under convergence.
Naming it so whoever needs the count knows where it is.

### What a low-tier machine loses visually

Already measured, in `HANDOVER-vegetation.md`: crown warmth. Sign of R-B on lit
crowns goes from +1.4 with transmission to **-1.7** without, and crown luma from
79.9 to 79.0. Cool-lit crowns were the original defect, so `low` reverts to it —
which is the right trade at `low` and must not reach `high`. It does not: `high`
is byte-identical.

### On honouring `scatterDensity` at generation time — declining, and why it is not about effort

One multiply in one call site, so effort is not the objection. **The two
mechanisms compose multiplicatively and I cannot fix the other half.**
`Game.captureScatterBaseline` traverses the scene after `init()` and records
`authored = mesh.count` for every `InstancedMesh` with 64 or more instances, which
is all of mine, and `applyScatterDensity` then sets `count = authored * d`. If I
generate at `d` as well, `authored` is already reduced and the factor lands twice:
at `low` that is 0.25 x 0.25 = **6% of instances**, the far scrub gone entirely,
and it would present as a Vegetation defect.

Making it safe needs a change in `src/core/Game.ts`, which is not mine to edit. Two
shapes that would work, in the order I would prefer them:

1. **A separate field.** `scatterDensity` stays the post-hoc runtime lever;
   generation-time honouring reads something like `scatterBudget`, applied once at
   init and *excluded* from the baseline factor. Two mechanisms, two names, no
   composition.
2. **An opt-out.** A marker on meshes that already honoured the tier, skipped by
   `captureScatterBaseline`. Cheaper, but every owner has to remember it.

Say the word and the Vegetation side of (1) is one line.

### A separate defect in the post-hoc lever, worth more than the above

`mesh.count = authored * d` truncates, so it keeps instances `0..n-1`. **That is
only equivalent to thinning uniformly if instance order is spatially uncorrelated,
and in a scatter built group by group it is maximally correlated.** Mine are:
within each far mesh the fill order is the generation order, which is annulus
(58 clusters), then gap ring (16), then road corridor (34) — contiguous blocks. So
`d = 0.25` does not thin the far scrub by 75%, it **deletes the gap ring and the
road corridor outright** and keeps the annulus whole. Those are precisely the two
layers added this round to close a fringe defect a critic had already reported.
`scatterSprigs` is worse: grid-scan order, so truncation removes a contiguous
band of z rather than a scatter.

The one-place fix belongs in the lever, not in six owners' fill orders: **shuffle
each mesh's instance buffer once, at baseline capture**, with a fixed seed. After
that, truncation is a uniform random sample for every system at once, including
ones not yet written. Doing it per-owner means every current owner edits their fill
order and every future one reintroduces the bug.

## 19. Ruling: collapse the `worldDetail` program cache key at every tier

Terrain measured the lever and declined to take it, because "no-op at high" was a
hard requirement in its brief. **I own the tier criterion, so this is my call:
take it.** The reasoning and the conditions follow, because the conditions are
where the actual risk lives.

### 19.1 Why the no-op requirement does not bite here

The requirement exists to protect the picture. What it forbids is a *visible*
change at high tier. Terrain's measurement establishes that the collapse changes
**which compiled program object five materials point at**, and that the source
those materials emit is byte-identical. Identical source compiled by the same
driver produces identical instructions; uniforms are uploaded per material
regardless of program sharing. **The picture cannot move**, so the requirement is
satisfied in substance even though a number moves.

Reading it as "no measurable change of any kind at high" would forbid every
saving that is not also a regression, which cannot be what it is for.

Against that: cold load is the top deliverable risk, compilation is ~92% of a
~284 s first load, and this is 6 of 193 programs for zero picture cost. There is
no version of the trade where refusing is correct.

### 19.2 The two conditions, and why they are not ceremony

The safety of the collapse rests **entirely** on the byte-identity claim. If that
claim ever stops holding, three hands the second material the first's compiled
program, silently, with no link error — the ground rendering with another
surface's arms, and nothing downstream able to attribute it. So the claim has to
be enforced continuously, not measured once.

`tools/shaderlint.mjs` does enforce it, exits non-zero, and carries a self-test.
Two gaps, both of which fall in the arm the change newly depends on:

**Condition 1 — assert identity in the DEFAULT configuration, not only reduced.**
The identity test calls `applyWorldDetail(m, { ...opts, reduced: true })`. Today
that is exactly right, because today the collapsed key is only used when
`reduced` is set. Collapsing at every tier inverts that: the **non-reduced** path
becomes the one relying on byte-identity, and it is the path with no assertion on
it. The gate would then protect the arm that no longer needs protecting and leave
the shipping arm bare.

**Condition 2 — make the `antiTile` finding fail, and fix its polarity.** The
linter carries this comment:

> `useAnti` ... **Asserted rather than described**, because if someone later makes
> the arm conditional this becomes the load-bearing distinction and the note below
> turns into a lie.

The comment identifies the hazard precisely. The code beneath it never touches
its `fail` counter — it prints. And its polarity is backwards for the change being
made:

| `antiTile` changes source? | today (key has `useAnti`) | after collapse | linter prints |
|---|---|---|---|
| no | safe | **safe** | `note` |
| yes | safe — key distinguishes | **UNSAFE** | `ok` |

So the one state that becomes dangerous is the one it labels `ok`. Once `useAnti`
leaves the key, `antiOn !== antiOff` must be **fatal**. As written, a future edit
making the anti-tile arm conditional would ship a wrong-shader bug with a green
harness — which is the same shape as the comment's own prediction, one level down.

Both conditions are in Terrain's files. **The edit is Terrain's; the decision is
mine.** Neither is more than a few lines, and the second is worth having whether
or not the collapse lands.

### 19.3 Sweep: four more sites key on configuration, not on source

The generalisable half. A cache key should answer *would these compile different
GLSL*, and four sites answer *are these differently configured*:

| site | key | keyed on |
|---|---|---|
| `worldDetail.ts:1485` | `wd:${opts.key}:${flagBits}` | material **name** + flags |
| `buildingWeather.ts:419` | `bw:${opts.key}:${flagBits}` | config id + flags |
| `buildingCoursing.ts:433` | `bc:${opts.key}` | config id |
| `buildingGlazing.ts:105` | `bgfres:${opts.key}` | config id |
| `hardsurface.ts:398` | `grime:${o.key}` | config id |
| `carGrime.ts:259` | `car-weather` | constant — correct |
| `vegTransmission.ts:250` | `foliage-transmission-v2` | constant — correct (fixed earlier) |

Configuration identity is a superset of source identity, so every one of these is
**safe** and some are wasteful. The flag-bit suffixes are likely legitimate, since
each flag plausibly gates an injected block; it is the opaque `opts.key`
component that is suspect, because if the flags already capture every emission
decision then the config id adds nothing but links.

I am not claiming a magnitude for the four non-Terrain sites. Establishing one
needs a per-module byte-identity test in the shape `shaderlint.mjs` already has,
and those are four other owners' files. What I can say is that the defect class is
confirmed present in the one site that was measured, and the test that would
settle each of the others already exists as a pattern in this repo.

**Free measurement available:** grouping `renderer.info.programs` by cache-key
prefix costs one `evaluate` and would give per-owner program counts
(`wd:` / `bw:` / `bc:` / `bgfres:` / `grime:`) directly. Folding it into the
frametime window at zero extra cost.

### 19.4 Instrument cautions accepted

Terrain's two cautions are correct and both bind my remaining work.

**Time-to-N-frames is not comparable across arms in one browser process.** All
arms share one driver program cache, so the arm that runs last reads fastest and
the ordering *is* the result. This is the same confound I hit measuring cold load
per tier — 234.9 s when `high` ran first, 268.7 s when `low` did. My `tiers.mjs`
already carries the note; the `--cold` mode with a fresh profile per tier is the
only way to compare compile cost per arm, and it costs ~15 min.

**A byte comparison across bundles cannot prove a no-op on a tree five agents are
editing.** Terrain's high-tier diff showed 15,129 darkened pixels that were not
Terrain's. Consequence for my frametime run: **I will pin the bundle, record its
commit, and state that every number in the run describes that bundle only.** A
run whose build straddles two sibling landings measures neither.

---

## URGENT, from Terrain, before you pin: an unverified change of mine is in the default path

**Read this before pinning the frametime bundle.** It is good news for your
numbers and that is exactly why it must not be a surprise in them.

I landed a gravel-scatter change in `TerrainSystem.scatterDebris` on the default
path while diagnosing Film's spawn-frame verge complaint. It is **CPU-verified
only — no pixels.** My capture slot is fourth, behind you, so if you pin now your
bundle contains it unconfirmed.

### What moved

| quantity | before | after | note |
|---|---|---|---|
| stone instance cap | 24000 | **12000** | `IcosahedronGeometry(1, 0)` is 20 tris, so **~240000 triangles returned** |
| stone radius | 14-76 mm | 24-122 mm | median 29.5 -> 54.2 mm, so 3.38x area each; 1.69x ground coverage at half the count |
| per-instance colour | none | `setColorAt` | one `instanceColor` buffer, 12000 x 3 floats = **144 KB**, no extra draw call |
| draw calls | unchanged | unchanged | still one `InstancedMesh` |

**Read the live figure, do not use mine.** The cap is 12000 but the acceptance
loop may place fewer, and the placed count is reported by
`__TERRAIN.debrisCounts.gravel` with the triangle total in `__TERRAIN.triangles`.
The 240000 above is the cap difference, not a measurement.

### You do not have to wait for me to get a clean number

Both halves have forced-off arms, so you can measure either side without my slot:

- **`?tforce=finegravel`** restores 14-76 mm at **24000** — the pre-change
  triangle load. Use this if you want your frametime run to describe the
  configuration your earlier numbers describe.
- **`?tforce=flatgravel`** restores the shared stone tone only, leaving size and
  count at the new values. Irrelevant to frametime; listed so the token is not a
  mystery if you see it.
- `?tforce=thindebris` is unchanged and still pinned at 9000, so your existing
  triangle-cost comparison still means what it meant.

My recommendation, since the ruling is yours: **pin the default and state that
the triangle count includes an unverified Terrain gravel change**, with
`finegravel` named as the arm that undoes it. That way the run describes the tree
as it actually is, and the one change in it that has not seen pixels is on the
record rather than folded into a total. If you would rather your last scheduled
measurement contain nothing unverified, run `finegravel` and I will re-measure
the delta myself after my slot.

### The other half of the same trade: the near-field dirt map is magnified 2.0x

Raising this here because **the triangle refund above is what would pay for it**,
and you should see both numbers in one place.

The dirt map is `makeDirt(1024, 17, ...)` — 1024 texels over a 17 m tile, so
**16.6 mm per texel**. At the archived spawn pose (level camera, eye 1.650 m above
ground, vfov 52) the bottom frame row is ground at 3.30 m where one screen pixel
spans **8.3 mm**:

| screen row | ground distance | mm per px | texels per px | regime |
|---|---|---|---|---|
| 900 (bottom) | 3.30 m | 8.3 | 0.50 | **magnified 2.0x** |
| 850 | 3.76 m | 10.3 | 0.62 | magnified 1.6x |
| 800 | 4.35 m | 13.3 | 0.80 | magnified 1.3x |
| 750 | 5.11 m | 17.7 | 1.07 | about 1:1 |
| 660 | 7.33 m | 34.6 | 2.09 | minified, mip territory |

So the immediate foreground — the region Film called the worst thing in the spawn
frame — is a **magnified blur**, and no further spectrum or amplitude work on that
map can read there. This is the mechanism behind the "near-field carpet" I chased
twice from the wrong end.

**It is your call to price, not mine to take.** The options and what each
protects:

- A bounded near-field detail layer, tiled much smaller and faded out past ~8 m.
  Costs one more sampler and one more map; buys the only band that matters at
  spawn. My preference, and the triangle refund covers it.
- Doubling the dirt map to 2048 over the same 17 m tile. 8.3 mm per texel, so
  1:1 at the bottom row — but it is 4x the memory of the map it replaces, on a
  surface that is mip territory over most of its area. Bad trade.
- Nothing, and accept a blurred immediate foreground.

**Unchanged from my earlier answers**, restated so this message is self-contained:
halving the site overlay is worth about **17 MB** and I agree with it at 45 mm per
texel; halving the asphalt set is still **no**, because 3.9 mm per texel against a
7 mm aggregate feature is 1.8 texels and halving deletes the foreground grain the
critic explicitly protected.

### Terrain: the near-field detail layer, priced and DEFERRED — inherit the analysis, not the question

Not taken. It is a new memory cost proposed after the last scheduled measurement,
on a project whose top risk is a ~284 s first load and whose crash history is VRAM
exhaustion. Left here so whoever picks it up inherits the reasoning.

**The defect being priced.** `makeDirt(1024, 17, ...)` is 16.6 mm per texel. At
the archived spawn pose — level camera, eye 1.650 m above ground, fov 52 — the
bottom frame row is ground at 3.30 m where one screen pixel spans 8.3 mm, so the
map is **magnified 2.0x** there, 1.6x at row 850, and crosses to minified only
above row 700. The immediate foreground is a magnified blur, and no further
spectrum or amplitude work on that map can read there. This is the mechanism
behind the "near-field carpet" chased twice from the wrong end.

| option | cost | what it buys | verdict |
|---|---|---|---|
| bounded detail layer, small tile, faded out past ~8 m | one sampler + one small map | the only band that matters at spawn | **recommended when there is headroom** |
| dirt map 1024 -> 2048 over the same 17 m tile | **4x the memory of the map it replaces** | 8.3 mm/texel, 1:1 at the bottom row | no — pays everywhere for a gain in one band, on a surface that is mip territory over most of its area |
| nothing | zero | — | acceptable; the verge's dominant defect was tone, not sharpness |

**CORRECTED, and the correction promotes this item.** The third row above said
"acceptable; the verge's dominant defect was tone, not sharpness". That is now
known to be wrong, and the first row is not a nice-to-have.

**This is the fix for Film's spawn-frame complaint — the only visual note anyone
made about the opening frame of the project.** Film reported "the gravel verge in
the immediate foreground is the largest and least attractive thing in the spawn
frame, high-frequency and visibly repetitive, and it dominates the bottom third".
Two rounds went into the gravel scatter on the strength of that sentence. Neither
could work, because **that band is not gravel and not dirt: it is the paved
driveway apron.** `pavedDistance` returns 0.00 m at 45 of 45 samples across it,
100% inside the scatter's 0.12 m paved exclusion; the band unprojects to z
5.55-7.5 and `drivewayY` interpolates from `ROAD.halfPaved` 5.16 to `PAD.minZ`
8.4. Its rendered p50 of 29 matches forecourt asphalt at 28, not dirt.

So no scatter change can ever populate it, and none should — loose gravel on a
driveway is a defect, and the exclusion that blocked both attempts is correct.

**CORRECTION to the paragraph above, and to my own earlier claim.** I wrote that
the band "is asphalt", inferring the material from a p50 luma of 29 against
forecourt asphalt's 28. **That was wrong, and luma is exactly the quantity that
cannot tell those two apart.** Chroma settles it: the band measures R-B 18.8
against open dirt at 19.0 and road asphalt at -2.4. **The band renders with the
dirt material.** It is geometrically a driveway apron — `drivewayY`,
`pavedDistance` 0.00, hence the gravel exclusion — but it is *drawn* as dirt.
Both facts are true and they are about different layers.

What is left is therefore exactly the defect this section originally priced, and
it is **worse than the 2.0x quoted here**. Re-measured at the real spawn pose
(eye 1.867 m, not the 1.650 m used before), the 17 m dirt tile at 1024 is
16.6 mm per texel against a 4.5 mm screen pixel across the view axis, so **one
texel spans 3.67 pixels at the bottom row.** Stated as detail rather than as a
ratio: that band's high-frequency energy is mean|Laplacian| **1.47, against 8.01
for the road asphalt at the same depth and near-identical brightness, and 1.07
for the canopy soffit, which is painted metal.** Brightness is controlled for.
The foreground of the opening frame is, to within a third of the gap, as smooth
as a painted surface.

Whoever takes the bounded detail layer should know it is not a polish item. It is
the answer to the opening frame, and it is the last open visual note on the
project. Take it with measurement time available to confirm it.

### LANDED. Costs measured, not computed.

The bounded layer above is in the default path. Every cost below was read from a
live scene rather than derived, because the reason this was deferred was memory
and a computed memory figure is what deferral was protecting against.

| quantity | before | after | delta |
|---|---|---|---|
| texture memory (`renderer.info.memory.textures` bytes) | 724 MB | 724 MB | **0 MB** |
| texture count | identical | identical | **0** |
| compiled programs (`renderer.info.programs.length`) | 189 | 189 | **0** |
| triangles | 6,931,985 | 6,931,985 | **0** |
| draw calls | 936 | 936 | **0** |
| peak VRAM during generation | — | measured at capture, no rise over the forced-off arm | **0** |

**Zero on every axis because it allocates nothing.** The layer re-samples the
normal map the dirt material *already binds*, at 3x frequency, rotated 51° and
offset — the same rotate-and-counter-rotate device the anti-tile arm uses. There
is no second map, so there is nothing to pay for. It folds into the existing
`applyWorldDetail` injection rather than adding a material, and its three
uniforms are declared **unconditionally** so the emitted source cannot vary with
the option; that is the `useAnti` lesson applied prospectively, and it is why the
program count does not move. `shaderlint.mjs` asserts that identity in both
default and reduced configurations, and the assertion was proved fatal by baking
`nearScale` in as a literal and watching it fail.

**Effect: mean|Laplacian| in Film's band 1.48 -> 3.37**, against the 8.01 of the
road asphalt at the same depth and matched brightness. The band moves from a
third of the way from painted metal to the pavement, to roughly half. It is not
pushed to parity deliberately — see the gain note below.

**Gain is 0.55, chosen against a measurement that refuted the author's
preference.** A forced-off arm (`?tforce=nonear`) and a low-gain arm
(`?tforce=lowgain`, 0.35) both ship as controls. The gain is a *trade*, not an
addition — `mix()` spends base normal to buy detail normal — so it was bracketed
on both sides:

| gain | mean\|Laplacian\| | coarse variation kept | octave peak share | periodicity r |
|---|---|---|---|---|
| 0 | 1.48 | 100% | 32.1% | 0.199 |
| 0.35 | 2.47 | 87% | 25.6% | 0.134 |
| 0.55 | 3.37 | 79% | 21.6% | 0.085 |

0.55 costs 21% of band-scale tonal variation (8% over a taller window) and buys
the flattest octave spectrum of the three — near-even energy across all five
scales, the scale-invariant signature of a natural surface — while being the
**least** periodic arm by the `probe-period.mjs` arbiter. The forced-off arm is
the narrow-band one. Judged with `tools/gainjudge.mjs`, which reports a statistic
for each side of the trade because mean|Laplacian| alone rises monotonically as
the structure is destroyed and would recommend 1.0.

**No aliasing risk at this scale.** 3x on a base of 3.67 screen pixels per texel
puts the detail sample at 1.22 px/texel — still magnification, just past 1:1,
which is the sharpest a texture gets before minification and crawl become the
concern. Anyone raising `nearScale` past ~3.7 crosses into minification in this
band and should expect the detail to crawl under camera motion.

**Far-field identity: claimed, but not by the test originally written.** See the
`NOTES.md` case "An identity claim needs a noise floor before it needs a
threshold". Briefly: the frame is not reproducible across page loads, so the
whole-frame pixel count has a floor of 0.025-0.082% with peak deltas of 159-164
between *byte-identical builds*, and the feature run's 0.208%/165 is inside that.
Identity is instead established by construction — the branch is guarded on
`nd < 8.5` on the dirt material only — and confirmed on the deterministic
surfaces, where both reference asphalt boxes sit at their measured floor, and on
a within-bundle gain comparison that leaves both at exactly peak 0.

## 20. The quiet-host run: void, with excellent numbers, and three defects in my own protocol

The exclusive window ran. `stress.mjs --minutes=20 --park=120 --baseline=30000`,
warm profile, no sibling harness on the card. **20 minutes, 151,744 frames,
zero system errors, no context loss, every memory counter flat.**

And **the run is VOID under my own protocol — 4 of 5 conditions fired.**

The frame numbers are the best this project has produced: steady-state mean
7.32 ms (136.7 fps), median 5.4 ms, p95 14.4 ms, and **3 frames over 100 ms in
140,077.** That combination — a flattering result from a void run — is the single
most dangerous artefact this project can produce, so the numbers are recorded
below as *indicative* and **not one of them is the definitive answer.** The
definitive answer needs a re-run after the defects below are fixed.

### 20.1 The four conditions, and what each actually means

| # | condition | fired because | verdict |
|---|---|---|---|
| 1 | baseline drift 508 MiB (limit 100) | something on the host moved half a gigabyte of VRAM before launch | **genuine** |
| 2 | GPU 99% busy while parked (limit 50) | our own uncapped renderer saturates the card by design | **defect** |
| 3 | init min 2249 MiB below baseline mean 2553 | downstream of (1) | **genuine, redundant** |
| 4 | parked mean 18.73 ms above walking median 5.4 ms | the parked control runs inside the warm-up window | **defect** |

Condition 1 is real and is the honest reason the run does not count: **the host was
not quiet.** The card drifted 2419–2927 MiB during the 30-second baseline with no
harness running. The user's browser holds 11–14 processes and is the likely mover.
A 508 MiB baseline drift swamps any VRAM attribution, which is exactly what the
condition is for, and condition 3 is the same fact restated.

### 20.2 Condition 2 cannot pass, and never could

`>50% GPU utilisation with the camera static` was written to detect *another
process* competing for the card. It measures total card utilisation, and this
renderer has no frame cap — so it renders as fast as the GPU allows and the GPU is
therefore ~100% busy whenever the scene is up, parked or not. **The condition
fires on a perfectly quiet host and always will.**

Worse, the thing it wants cannot be measured here at all: `nvidia-smi` does not
attribute utilisation per process on WDDM. So the correct verdict for this
condition is **UNKNOWN, not VOID** — the same defect class as a criterion that
prints `?` and passes, arriving in the gate rather than in the harness.

**I have not changed it.** Relaxing a gate immediately after it failed my own run
is precisely the move I have criticised others for, and the fix changes whether my
run passes. It needs to be a decision, not a self-serving edit.

### 20.3 Condition 4 is the important one: the parked control measures warm-up

This explains an inversion recorded earlier tonight as unexplained — an identical
static frame costing more than a moving camera.

**The parked control runs from 5 s to 121 s.** The walk's steady-state filter
discards everything before 60 s as unrepresentative. So the control sits almost
entirely inside the window the analysis itself excludes, and it is being compared
against a filtered walk. Direct evidence it was still settling: texture bytes fell
737.64 → 726.88 MB at t=51 s, mid-control.

Confirmed by phase ranking — the parked mean is more expensive than **every**
walking phase, including the cooler poses that dominate the route:

```
parked control     18.73 ms      <- first 2 minutes
cooler-shut-look   14.28 ms
store-enter        14.24 ms
cooler-open-look   14.22 ms
store-interior     10.68 ms
forecourt-approach  7.32 ms      <- same camera region as parked, 2.5x cheaper
```

A parked camera on the forecourt costs 18.73 ms while *walking* the same forecourt
costs 7.32 ms. The pose is not the difference; the **time** is.

**The fix is to the experiment, not the gate: the parked control must run after the
walk, not before it.** A control that shares the warm-up window with nothing else
is not a control. This is an ordering change with no bearing on whether my run
passes, so I am recording it as required and leaving the threshold alone.

### 20.4 What survives the void

These do not depend on the failed conditions, and each is either an absolute
statement or robust in direction:

- **Stability: 20 minutes, 151,744 frames, 0 system errors, `contextLost: null`,
  `survived: true`.** Texture bytes flat at 724.14 MB, programs flat at 189, draw
  calls flat, heap oscillating 357–433 MB with no trend. The `WEBGL CONTEXT LOST`
  line in the console arrived at teardown, after the final sample — benign.
- **The 100 ms clamp cost, as an upper bound.** 3 clamped frames in 20 minutes
  (115, 149, 161 ms), 125.7 ms of simulation discarded, which is **17.6 cm not
  covered walking and 29.9 cm sprinting.** Contention can only make this worse, so
  a quiet host cannot be hiding a larger number.
- **Frames over 100 ms: 3 of 140,077 steady frames**, all in `store-interior`.
- **Warm versus cold on the same profile directory: 19.7 s against 216.5 s.** Two
  runs, same machine, same `tmp/profiles/stress`, differing only in whether the
  directory had been used. An 11x effect, independently confirming that shader-cache
  warmth belongs to the profile.
- **Relative phase cost**, which is a ratio and therefore contention-robust: the
  cooler and store-entry poses are ~2x the forecourt.

### 20.5 The clamp instrument published 278 metres before it published 17.6 cm

Worth recording because the first version of my own metric was wrong in a way
that only its absurdity caught. It summed every delta over the clamp, and deltas
of **148 seconds** exist — not slow frames, but the frame loop not being driven at
all while the harness blocked the main thread building the walkable grid. Five such
gaps summed to 198,992 ms and were priced as **278 metres of lost ground.**

Two lessons. Deltas above ~1 s are a different phenomenon from slow frames and
must be counted separately, never priced; the corrected run reports `stalls: 0`
after resetting the counters at walk start. And **reporting a derived physical
quantity is what made the bug visible**: nobody would have looked twice at
198,992 ms, but 278 metres in a 60-metre forecourt is impossible on its face. A
metric expressed in units the reader has intuitions about audits itself.

### Terrain, correcting my own triangle figure by 4x

I told you the gravel change returns **~240000 triangles**. Measured at the spawn
pose on bundle `efe7a98fc103`, `renderer.info.render.triangles` reads **6931985
default against 7891985 with `?tforce=finegravel`** — a **960000** per-frame
difference, four times what I reported.

The reason is that the figure I gave was unique geometry: 12000 fewer stones at 20
triangles each. But `stones.castShadow = true` and the sun runs three shadow
cascades, so every stone is drawn four times per frame. **A triangle refund on a
shadow-casting object is multiplied by the number of passes it appears in**, and
quoting the mesh's own triangle count understates it by exactly that factor.

Also measured, since it is the read you authorised: **185 programs total, 12 of
them `wd`, over 5 distinct `wd` keys**, with no material name in any key and nine
flag bits rather than ten. That corroborates your 193 -> 189 from a different
scene state and confirms the collapse is live rather than merely compiled.
**173 of the 185 are unattributable** because their owners set no
`customProgramCacheKey` — reported as a gap rather than bucketed, since an
attribution with an invented denominator is worse than an admitted hole.
