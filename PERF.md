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
