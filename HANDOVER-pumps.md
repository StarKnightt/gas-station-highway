# Handover — System 3, fuel pumps

> ## SESSION 2026-08-28 ~20:35Z — colour space, shut lines, crash record
>
> **Nominated round: `2026-08-28T203536Z-30638700b1c3`.** 11/11, manifest, RTX
> 4060, `__SYSTEM_ERRORS` empty. Torn down, 5113 clear, `tsc --noEmit` clean.
>
> ### FOR CAR — remove the 5.4x tyre compensation
>
> `makeTyreSkin` is **fixed at source** and your multiplier is now a double
> correction. The albedo was being written to bytes and handed to an sRGB-tagged
> `DataTexture` without encoding, so authored 0.055 arrived as 0.0043 linear;
> it now goes through `linearToSrgb` on the way in. Measured mean linear
> reflectance **0.0070 → 0.0781**, range 0.0704–0.0910, which is the 0.055–0.09
> the call-site comment always claimed. With 5.4x on top the tyre lands near 0.42
> linear, i.e. a light grey tyre. `tools/albedoaudit.mjs --selftest` is the check.
>
> ### The rest of the `hardsurface.ts` audit is clean, and here is why that is not luck
>
> `tools/albedoaudit.mjs` (new) decodes every map the file produces the way the
> GPU will and prints linear reflectance. Results: the tyre was the only colour
> map with the fault. The **bollard skin measures 0.2744 linear and is correct**,
> and the distinction is the useful part of this audit —
>
> - a palette taken from **physical reference** is linear, and writing it raw
>   into an sRGB texture darkens it by ~6x. That was the tyre.
> - a palette arrived at by **iterating on renders** is display-referred already,
>   because it was tuned *through* that same decode. It is correct however its
>   comment describes it, and "fixing" it would brighten a surface that was
>   right. That is the bollard, whose yellow went through several rounds of
>   critic feedback.
>
> The two are indistinguishable in the source, which is why the tool measures
> delivered reflectance rather than reviewing code, and why `linearToSrgb` has a
> doc comment saying explicitly that the bollard must **not** be routed through
> it. A future agent applying it "consistently" to both would regress the post.
>
> All twelve non-colour maps (normal, roughness, metalness, the grime field) are
> correctly tagged `NoColorSpace` — `hsGray` and `hsNormal` both pass
> `srgb: false`. A roughness map tagged sRGB would have been the scene-wide
> version of this bug and it is not present. Hex material colours are safe too:
> `THREE.Color` decodes hex as sRGB under `ColorManagement`.
>
> ### Shut lines — the dark half was a decal, exactly like the light half
>
> The dark ribbon was placed at `cabD/2 + rel + 0.0006`: **0.6 mm proud of the
> panel it was supposed to be a hole in**, and therefore the frontmost surface on
> the face, unoccludable by anything. Both halves of the pair were stuck on the
> front — a bright bar 0.5 mm proud and a dark bar 0.6 mm proud. Every previous
> pass tuned the ribbon's height, jitter and darkness, and none of it could work
> for the same reason the lip could not be fixed by brightening it.
>
> The slot was already there and the ribbon was covering it: `facePlate` insets
> every plate by `GAP/2` so adjacent plates are 8 mm apart, each row stands `LAP`
> further proud, and the dark backing skin sits at `cabD/2 + 0.0004`. That is a
> real 8 mm channel, 5–17 mm deep, with a dark floor. **The ribbons are deleted**
> and `seamMat`'s `envMapIntensity` is 0.3 → 0.1, which is the "reduced sky
> exposure" half — a surface at the bottom of that channel sees a wedge of sky of
> order ten degrees, there is no AO in this scene to supply it, so the material
> has to. No cast shadow is involved, so the +Z-faces-get-no-sun constraint is
> satisfied by construction rather than worked around.
>
> Whole-frame sweep of `panels`, `201909Z` → `203536Z`:
>
> | | before | after |
> |---|---|---|
> | dark troughs, count | 2851 | **2227** |
> | dark trough depth, p90 | 79.8 | **85.3** |
> | bright ridges, count | 1761 | **1311** |
> | bright ridge lift, median | 42.5 | **33.5** |
>
> Fewer competing thin features, deeper darks, a less assertive light half. They
> read as cut lines now rather than applied trim. **Still not closed**: the dark
> median is flat at ~43 and the lines are on the faint side. If this is picked up
> again, the lever left is the channel's *depth* — `LAP` is 4 mm and a deeper lap
> on the lower rows would occlude more sky without touching any material.
>
> ### Bollard crease — judged in a render, resolved
>
> The merged vertical fold from `201217Z` is gone: the struck edge now shows two
> or three separate notches. Silhouette in `203536Z` narrows **monotonically**
> 125 → 111 px (it was 125 → 107 → 114, a pinch), left edge deviates 4.7 px from
> straight and the struck right edge 6.4 px. One straight reference edge, one
> bitten, which is the shape a struck post has.
>
> ### Cost this session
>
> **-12240 triangles total**, 0 new meshes, 0 new draw calls, 0 new textures:
> -9216 from the bollard sleeve row count, -3024 from deleting the seam ribbons.
> The `pumps registry` line moved 94368 → 91344 for the second of those and did
> not move at all for the first, which is the blind spot below.
>
> ### FOR THE PERFORMANCE AGENT (port 5152) — crash datapoint
>
> Not investigated; not my system. Recording what I saw.
>
> - **Error:** `page.goto: Target page, context or browser has been closed`,
>   raised at `tools/shoot3.mjs:336` while navigating to
>   `http://127.0.0.1:5113/?shot=system3&gpu=1`.
> - **Preset:** `wide` — shot index **7 of 11**. Presumably the most
>   geometry-heavy view in this harness; eye height 4.78 m looking across the
>   whole forecourt.
> - **Progress:** 6 shots had completed and been written. Round
>   `2026-08-28T201217Z-5f11b7a4830c`, marked `DO-NOT-JUDGE` — its 6 frames are
>   real but `finalise()` never ran, so no manifest, no GPU assertion, no error
>   list.
> - **Timing beforehand:** the 6 completed shots took 25.4, 31.7, 27.3, 33.9,
>   27.6, 36.1 s. Compare the same six in the healthy round immediately before
>   (`201909Z`): 25.4, 25.6, 26.6, 27.0, 24.0, 25.2 s. **The crashing round was
>   getting progressively slower and the healthy one was not** — the last two
>   shots before the crash were 26% and 43% over their counterparts. That looks
>   like accumulation rather than a spike on `wide` alone, so `wide` may be the
>   straw rather than the cause.
> - Each shot navigates afresh, so anything not released between navigations
>   accumulates. Nothing else was noted: no console errors, no shader warnings,
>   `__SYSTEM_ERRORS` empty on every completed shot.
> - The same harness ran 11/11 twice more afterwards with **no code change that
>   would affect memory**, so it is intermittent, not deterministic.
>
> ### Registry blind spot — also now in NOTES
>
> `shoot3`'s `pumps registry` line counts **dispenser meshes only**. The six
> bollards are not registered because nothing picks them, so 9216 triangles of
> this system are invisible to that number. Any per-system cost breakdown
> assembled from harness registry lines will be wrong by whatever each system
> owns but does not register, and *self-consistently* wrong, so the totals will
> look fine. Count from `renderer.info.render` or walk the graph instead.

> ## SESSION 2026-08-28 ~20:19Z — bollards, shut lines, stratification
>
> **Nominated round: `2026-08-28T201909Z-b8c9944419cd`.** 11/11, manifest, RTX
> 4060, `__SYSTEM_ERRORS` empty. Torn down, 5113 clear, `tsc --noEmit` clean.
>
> `2026-08-28T201217Z-5f11b7a4830c` has a `DO-NOT-JUDGE`: **the browser died
> after 6 shots** with "Target page, context or browser has been closed", on the
> `wide` preset. Same crash class the user hit walking the scene. Its 6 frames
> are real and were used, but it has no manifest so nothing asserted the GPU or
> the error list at the end.
>
> ### Cost, since a performance agent is now measuring
>
> **-9216 triangles, 0 new meshes, 0 new draw calls, 0 new textures.** No chip
> geometry was added — the chips are paint loss, they belong in the albedo, and
> the existing comment in `makeBollardSkin` already establishes that relief there
> reads as blisters. The saving is the bollard sleeve going from 56 rows to 40:
> 56 rows was 16 mm of post per row, finer than any feature on it. Six posts are
> now 31104 triangles against 40320. The `pumps registry` line in `shoot3`
> reports 94368 and does not move, because it counts dispenser meshes only —
> **the bollards are not in that number**, which is worth knowing before anyone
> quotes it as this system's budget.
>
> ### Bollards: the banana was a width problem, not a bend
>
> Measured from the silhouette in round `195251Z`: centreline deviation from
> straight only **6.7 px**, but width **125 px at the top, 107 mid, 114 below** —
> and the camera in that pose is *above* the cap, so perspective predicts a
> monotonic narrowing downward. A mid-height pinch with no straight reference
> section is what the "banana" read is.
>
> Cause: `bollardDents` drew 2-3 impacts at **uniform random angles** with a half
> width of 0.72-1.27 rad. On a 98 mm radius that is 280-500 mm of pipe per
> impact against a 616 mm circumference — the widest draw wrapped 81% of the
> post. Unrelated angles at overlapping heights therefore carved *both*
> silhouette edges at once. The comment above those numbers argued for a broad
> footprint because "a bumper flattens 100-200 mm of pipe", which is right, and
> the value implemented two to three times that.
>
> Now: impacts stratified across ±39° of the traffic-facing arc, half width
> 0.40-0.66 rad, vertical extent halved, height confined to bumper level.
> `tools/bollardline.mjs` (new) separates a **bow** from a **dent**, which no
> existing probe did — envelope wander is now **0.0-0.2 mm** on all six with
> dents of **13-21 mm**. Its `--selftest` plants a 20 mm bow *and* a
> deliberately-not-undone lean, because the first version of it read the baked
> lean as a 16-33 mm outline defect. That is the third wrong-axis probe in one
> evening.
>
> Chips, counted in pixels before and after (marks by height band from the foot,
> and across the visible width):
>
> - height  `16,13,16,10,19,8,7,4,2,0` → `1,9,1,2,11,6,2,3,2,0`
> - azimuth `1,6,8,14,13,15,27,11` → `0,2,0,0,2,2,16,15`
>
> So: two discrete clusters at kick and bumper height instead of a flat wash, and
> **84% of marks on one side** against 40%. Cause was `kick` entering `paintGone`
> at 1.9 against `bumper`'s 3.0 with sigmas that overlap into one continuous
> field, and a `facing` term that reached 108° either side with a *concave*
> exponent holding it near full strength across the whole arc.
>
> The mesh dents and the paint chips now share `BOLLARD_IMPACT_U`, exported from
> `pumpParts`. They were independent — dents on one side, chips on the other.
>
> ### Shut lines: the premise, established before touching them
>
> The bright line is **not** sky exposure, an env contribution, or a gap showing
> brighter geometry behind. It is the `lip` slot, which exists to be brighter and
> was doing its job four times over: lighter *neutral* paint (`0xbfbcb2` on a
> cream cabinet), a 32° up-tilt, `envMapIntensity` 1.25, and — the one that
> decides it — **5 mm of proud box geometry, 2.2 mm thick, standing 1.2 mm off
> the plate.**
>
> The arithmetic that settles it: at the `panels` eye the face is 1.28 m away
> through a 30° fov on 900 px, i.e. **0.76 mm per pixel**, so that lip is a 7-9 px
> band with its own silhouette. The whole-frame ridge sweep found thin bright
> ridges at exactly 7-11 px. "Bright rods" is not an interpretation of a
> highlight; the lip *is* a rod. Nothing about the mechanism was wrong and the
> sun analysis below still stands — the fix is form, not lighting.
>
> Lip now 2.0 mm tall, 1.0 mm thick, 0.5 mm proud, paint warmed to `0xa9a294`,
> env back to 1.0. Ridge height median **5 px → 3 px**, p90 **11 → 9**.
> **Improved, not closed** — the lower seam still reads as a light line rather
> than a lit edge, and the next move is probably the dark side of the pair
> (`drop = 0.0055`) rather than the light one.
>
> ### Stratification
>
> `inBand` filled each third completely, so adjacent bands could meet at their
> shared boundary — units 1 and 2 are bands 1 and 0. Jittering inside the middle
> 60% guarantees a 13%-of-span gap. Median block delta across the three pairs
> went `8.8 / 18.4 / 18.1` → `10.5 / 16.4 / 14.8`: the weakest pair up 19%, the
> spread between pairs halved. Evening out is the intended effect, not a loss.
>
> ### Still open
>
> - Shut lines, as above.
> - The bollard chips are now correctly placed but read *sparse* at forecourt
>   distance, and rust bleed from them is not clearly visible in the render.
> - Dents at nearly the same angle merged into one long vertical crease in
>   `201217Z`; angles are stratified now but the fix is only verified in the CPU
>   envelope number, **not yet judged in a render at this angle**.
> - `__PUMPS report absent` on every shot; the in-page self-report is not wired.

> ## SESSION 2026-08-28 ~19:5xZ — nozzle form and seated pose
>
> **Nominated round: `2026-08-28T195251Z-bbf84135c45d`.** 11/11, manifest written,
> RTX 4060, `__SYSTEM_ERRORS` empty. Supersedes `194424Z-c9985bfdbee1` from the
> same session, which is the round the boot-seam defect below was *found* in and
> is worth keeping for that comparison. Torn down: nothing listening on 5113
> (TIME_WAIT remnants only), no Chromium alive, `tsc --noEmit` clean.
>
> ### The nozzle contradiction is resolved, and both sides were right
>
> The probe said seated, the critic said hovering, and the reason is that
> `nozzleprobe.mjs` only ever looks *down the mouth*. It measures spout depth and
> shoulder gap, which is the right question about seating and is completely blind
> to a spout that has swung sideways and come out through the **wall** of the
> pocket. That is what was happening: the tip sat ~75 mm off the bore axis
> against a 41 mm wall, emerged low on the front of the cup, and hung in clear
> air below it. Seated by the probe, hovering to the eye, no disagreement.
>
> `tools/bootfit.mjs` (new) tests containment instead of depth — for every vertex
> of every stowed nozzle part below the mouth, how far outside the pocket surface
> or below its floor. Has a `--selftest` that plants a 150 mm breach.
>
> **Read this before trusting it:** its first version measured the bore as a
> vertical cylinder and returned "all six contained". The bore is raked
> `face * 0.10` about X. Adding the rake turned the same scene into 4 of 6
> breaching. A flattering number from this tool means check the frame first.
>
> Verified in the pixels of `195251Z`: the nozzle sits nose-down and canted in
> the boot, and `tools/nozzleread.mjs` counts trigger 1137 px, guard 5303 px,
> latch pawl 641 px, hook 415 px, swivel 3321 px, bellows 1209 px — every feature
> the brief asks for is present *and unoccluded*, not merely authored. The spout
> lip ring reads 0 px and that is correct: it is inside the holster.
>
> ### The defect `194424Z` exposed — sections placed across a raked bore
>
> A bright tapered wedge on the outside of the boot, which was the stowed spout
> tip framed in a **gap between two boot sections**. `place()` rotates each piece
> about its own centre, so the mouth section and the sheath below it both sat at
> `bootZ` with a 0.10 rad rake and were therefore *not joined*: the mouth's lower
> rim swings 6.6 mm one way, the sheath's upper rim 3.3 mm the other, 10 mm of
> step with the inside of the cup showing through. Every section below the mouth
> is now strung down the bore with a `downBore(d)` helper. Second time in this
> system that a slot has been read as an object — the shut lines were the first.
>
> ### What moved, and what it cost
>
> `nozzleRake` 0.24–0.38 → **0.10–0.21**, `nozzleTilt` 0.10–0.19 → **0.050–0.098**,
> `rest` 19 → 11 mm. These are not taste. The bore is raked 0.10 and ovalled to
> 0.66 on Z, which leaves ~26 mm of play at the tip, i.e. the nozzle physically
> cannot deviate more than ~0.14 rad from the bore. The old values asked it to
> deviate 0.28. Containment now holds with 10–16 mm to spare on all six, and
> `nozzleprobe` still reports "canted, bearing" on all six (cant 46–66 mm).
>
> The spout crank was also reduced and the pocket given a straight 100 mm sheath
> below the mouth. The mouth's authored diameter, plan shape, taper and material
> are untouched, so none of the three things the "disposable cup" read was traced
> to is affected.
>
> ### Per-unit incidents — mechanism is in, weakest pair identified
>
> Whole-frame 40 px block sweep of `unit1/2/3` median absolute luminance delta:
> 1v2 **8.8**, 1v3 **18.4**, 2v3 **18.1** LSB; only 14–16% of blocks agree within
> 2 LSB, and those are background. Not three copies. But 1v2 is half the
> separation of the other pairs and it shows: their cabinet skin reads alike.
> `pumpVariation` already uses `seededRng`, stratified bands, and a per-unit
> `fieldOffset`/`fieldFlip` into the grime field, so the RNG traps are handled —
> what is left is that band 1 and band 0 land close on `wear`. Widening the
> stratification or giving unit 1 and 2 different *incidents* (not different
> strengths of the same incident) is the next move.
>
> ### Still open
>
> - **Bollards.** `194424Z` and `195251Z` both show the "banana" silhouette and
>   polka-dot chips. Not touched this session. Note the taper and 5 mm chamfer
>   findings already recorded below — do not redo those.
> - **Shut lines** read as thin bright rods rather than shadowed gaps in some
>   poses. `seamprobe` likes them; the eye does not entirely.
> - `__PUMPS report absent` on every shot. Harmless but it means the in-page
>   self-report is not wired, so the manifest is the only health record.

> ## STOPPED MID-ROUND, 2026-08-28 ~18:42Z — GPU handed back to the user
>
> Torn down cleanly: no listener on 5113, no Chromium or `headless_shell` alive,
> `npx tsc --noEmit` fully clean across the repo.
>
> **Nominated round: `2026-08-28T182951Z-67c77176358c`** (11/11 shots, manifest
> written, RTX 4060, `__SYSTEM_ERRORS` empty, `KEEP` file in the directory).
> `2026-08-28T183859Z-92bb895893a5` is a half-finished second capture killed by
> the interrupt — 9 shots, no manifest, so `finalise()` never asserted the GPU or
> the error list. It has a `DO-NOT-JUDGE` file. Do not score it.
>
> ### The three things this round changed
>
> **1. Cabinet material — done, and it was aliasing, not roughness.** The
> "troweled stucco or sprayed concrete" read was noise above the Nyquist
> frequency of the detail maps, so it was white noise per texel rather than a
> surface. Added a `featureFreq` guard in `hardsurface.ts` that throws if a
> requested frequency exceeds `size / 4`, then retuned `makeCabinetSteel`
> (512 px / 0.20 m), `makePaintedSteel` (512 / 0.20) and `makeMouldedPlastic`
> (512 / 0.10). `tools/bandprobe.mjs` measures adjacent-texel delta over standard
> deviation; all nine maps now report `resolved` where several were `aliased
> (white noise)`. **Confirmed in the round's own pixels** — the cabinet reads as
> smooth panel with faint orange-peel. This is the one item I would call closed.
> Specular *strength* was left alone, as instructed.
>
> **2. Lit lip on the lapped joints — landed, and it exposed a bigger error.**
> First, the measurement that matters, because it changes the brief: against the
> site's real sun (11° elevation, azimuth 203°),
>
> ```
> +Z cabinet faces   N·L = -0.390   no direct sun at all
> -Z cabinet faces   N·L = +0.390
> up-facing ledge    N·L = +0.191   half the flat face
> best horizontal chamfer, at 26°   0.434, i.e. +11% over flat
> vertical edge                      0.901
> ```
>
> **A chamfer on a horizontal edge cannot produce a bright line here.** The sun is
> 67° off the cabinet normal in azimuth and only 11° up, so a horizontal edge has
> almost no vertical light available and an up-facing ledge is *darker* than the
> wall it sits on. That is also why the vertical seams already read at −95 and the
> horizontal ones never have. So the lip is authored as **albedo plus sky
> exposure**, not as a highlight: a new `lip` geometry slot, up-tilted 32°, in a
> lighter paint at `envMapIntensity` 1.25 (an up-tilted face sees the whole dome
> where a vertical face sees half — a structural fact about the sky, so it
> survives the environment being rebuilt). Both mechanisms are honest: coating is
> thinner over a formed radius and chalk collects on an upward ledge.
> **Visible and working in `panels.png`.**
>
> **3. Bollard chips — discrete and directional, verified.** Damage is now gated
> to a ~±100° traffic-facing arc via a new `impactU` parameter, the three skins
> put their arcs at different U, and each post's `rotation.y` is computed to aim
> its arc down the island axis (`CylinderGeometry` puts U=0 at +Z, so a texel at U
> faces `(sin 2πU, 0, cos 2πU)` and a Y rotation adds to that angle — it used to
> be `bi * 1.3`, arbitrary). Crucially I removed the last smooth term from
> `paintGone`: the `wear * 0.16` was the belt, because a Gaussian in height times
> low-frequency noise crosses any threshold as a continuous ring. `wear` is
> renamed `rub` and now only drives roughness. New `tools/bollardprobe.mjs` gates
> on arc coverage, belt-row count and circular-mean U; all three skins pass at
> 18–24% coverage, **zero belt rows**, mean U tracking authored U exactly.
> Colour pulled back from "old margarine" toward real chalked yellow
> (`yellowFaded` blue channel 0.48 → 0.35, fade blend 0.85 → 0.72).
> **Confirmed in `bollard.png`: chips are hard-edged, discrete, and on one side
> only.**
>
> ### What I already know is wrong in this round
>
> I diagnosed these from the round's own frames before stopping. **The fixes are
> written and typecheck but are NOT in any capture.**
>
> - **The horizontal shut lines regressed into a row of black tabs, and it is my
>   error.** I sized the joint's dark line as the true cast shadow of the 4 mm
>   lap at an 11° sun — `LAP / tan(SUN_ELEV)` = 20.6 mm. Correct trigonometry,
>   wrong premise twice: the +Z faces get no direct sun so cast no shadow of any
>   length, and 20 mm of solid black on a 300 mm panel is not a shut line at any
>   exposure. With the along-the-run jitter I added (0.55–1.30×) it rendered as
>   discrete hanging rectangles — *further* from a gap than the flat ribbon it
>   replaced. Now a flat 5.5 mm at 0.85–1.15× jitter, i.e. the crevice's own
>   occlusion, which does not depend on where the sun is. `SUN_ELEV` and the
>   `SUN` import are gone from `pumpParts.ts`.
> - **The hose renders warm brown while the material is authored near-black.**
>   `hoseMat.color` has been `0x18181a` all along; a 0.42 grime film plus 0.5 dust
>   in warm greys was repainting it. On a light panel that much grime is a tint,
>   on near-black rubber it is a repaint. Cut to 0.12/0.16, roughness 0.78 → 0.52
>   for the sheen. **This is the buried-lamp-chamber pattern again** — the value
>   was right in the source and destroyed downstream, so reading the material
>   definition confirmed a colour that never reached a pixel.
> - **The chips render as round polka dots.** Thresholding a raw Worley distance
>   gives a disc, because that is what a level set of a distance field is. Noise
>   is now added to the distance *before* the threshold, so the boundary itself
>   scallops; adding it afterwards would only have faded the disc.
>
> ### The nozzle — an unresolved builder/critic contradiction, documented honestly
>
> I built `tools/nozzleprobe.mjs` and it says the nozzle is **38–59 mm down inside
> the boot and canted 36–63 mm front-to-back**, i.e. seated and leaning, not
> hovering. The critic says it hovers with a visible air gap. Looking at
> `nozzle.png`, **both are true**: the tool is seated, and nothing in the image
> says so. There is no darkening where the body meets the cup, and a 20 mm crevice
> between two matte surfaces does not darken from a shadow map at that scale, so
> the eye correctly refuses to believe the contact. I added authored contact
> occlusion (a dark ring inside the mouth plus a wedge under the front lip, in the
> `seam` material) — uncaptured.
>
> Worth recording that this probe lied to me twice before it worked: first it
> double-transformed already-baked geometry and reported a **1192 mm** gap, then
> a global closest-approach found only the spout passing through the mouth — the
> hole it has to go through — and reported "intersecting" while the body's
> shoulder, the only part that can bear on anything, was excluded by the radius
> filter. An absurd reading is cheaper to catch than a flattering one, but it is
> the same class of error.
>
> Also visible in `nozzle.png` and not yet addressed: the nozzle body is
> conspicuously faceted (low segment counts read as polygonal banding on the
> curved spout), and the boot is a smooth featureless tapered cylinder with a
> heavy rolled rim — the "disposable paper coffee cup" is an accurate description
> and the answer is detail (drain slot, bracket, dirt), not a smaller cup. The
> mechanisms the critic lists — trigger, guard loop, three-position latch pawl,
> hook, hex swivel, vapour bellows — are all still absent.
>
> ### Two things I checked and did NOT change, so nobody repeats the work
>
> - **The bollard profile is already correct.** It is `CylinderGeometry(r, r, …)`
>   with *no* taper, and `dr` is clamped to `+1.2 mm`, so the outline cannot bulge
>   more than ~1% anywhere. What reads as undulation in `bollard.png` is dent
>   shading, not silhouette. The critic's "taper is too aggressive" does not
>   correspond to a taper in the source. Do not "fix" this without measuring it.
> - **The chamfer was left at 5 mm**, per instruction. Missing rim highlight is an
>   expected consequence of a constant lower hemisphere plus the sun geometry
>   above, not a defect in the geometry.
>
> ### Exact next step I would have taken
>
> Re-capture on 5113 with `node tools/shoot3.mjs` — nothing else needed, the three
> fixes above are already in the tree and typecheck. Then compare `panels.png`
> against `182951Z`'s to confirm the joint reads as a line rather than tabs, and
> `hose.png` to confirm the hose is black. **After that**, the nozzle form is the
> largest remaining single defect and needs real geometry work, not a pose tweak —
> the pose is already right and measured. Then per-unit *incidents*: `buildPump`
> now takes a per-unit `rng` (seed + 8101) that jitters the joint lines, so
> unit-to-unit seam vertices already differ in 44% of positions, which is a hook
> to hang discrete incidents on.
>
> ## Superseded in part — read this box first
>
> **Latest round: see the "Edge work" section below for the current id.** Real
> NVIDIA RTX 4060, `__SYSTEM_ERRORS` empty, no shader errors of ours.
>
> ### If you read two things, the second is this
>
> **`THREE.ExtrudeGeometry` with `bevelEnabled: true` and `bevelOffset: 0` makes
> the solid bigger than you authored it.** It grows the body contour by
> `bevelSize` and only returns to your outline at the caps. Always pass
> `bevelOffset: -bevelSize`. This cost most of a round: adding a 5 mm chamfer to
> `chamferPrism` moved the cabinet skin from |z| = 0.360 to 0.365 and silently
> swallowed all 22 panel plates, which were authored to stand proud at 0.363.
> `NOTES.md` case 23 has the whole thing, including why the forced-value test
> that exists to catch this reported the feature was fine.
>
> Round `154136Z-76f6797d3b9e` scored **3/10, FAIL**. The critic contradicted the
> builder on two points and **was right about both**, which is now four for four
> on this project. Read `NOTES.md` cases 17, 18, 19 and 23 before touching
> anything; 19 is about how to tell whether per-unit variation is working, and 23
> is about how a presence test can lie to you.
>
> Everything below the line was written before anything had been rendered. See
> **Verified against pixels** for what survived contact.
>
> ### If you read one thing
>
> `applyGrime` samples object space. Two instances of the same mesh get
> **identical** dirt in identical places, and varying the *strength* per unit
> does not change that — it reads as one object under different exposure. Set
> `fieldOffset`. Every grime call in `makeUnitMaterials` goes through
> `unitGrime`, which attaches it; do not call `applyGrime` directly in there.
>
> ### The tools that settled it, use them
>
> - **`--shots=unit1,unit2,unit3`** in `tools/shoot3.mjs`. Places the camera at
>   the same offset in each dispenser's *own local frame*, so the three frames
>   are pixel-comparable. No other pose can answer "are these the same asset",
>   because every other pose sees each unit at a different angle — which is
>   exactly how a builder and a critic looked at `corner.png` and honestly
>   disagreed.
> - **`tools/regiondiff.mjs a.png b.png x,y,w,h:label`**. Reports a
>   *structural* delta: the difference remaining after each region's mean
>   luminance is equalised, so a pure sun-angle difference cancels and only
>   pattern survives. Whole-frame diffs are useless here because the background
>   behind each unit differs.
>   - Cabinet, unit1 vs unit2, in the failed round: **3.03/255 (~1%, noise)**.
>   - Same measurement now: **11.22/255, 100% of pixels changed**.
> - **`tools/pumpprobe.mjs`** prints the bollard outline band by band. In the
>   failed round **0 of 20 bands were straight** and every band bulged up to
>   15.5 mm *outside* nominal. Now 45% straight and max bulge 1.2 mm.
> - **`tools/seamprobe.mjs [panels.png]`** — new, and the tool that found case 23.
>   Casts rays from the exact camera `shoot3.mjs` builds for a `localTo` pose into
>   the exact geometry `buildPump` returns, and reports per pixel column which
>   material slot is hit and how far outboard it sits. So "is there a
>   plate-gap-plate crossing where the joint is authored" is a countable integer
>   rather than a squint. Hand it a captured `panels.png` and it also measures, in
>   frame, whether each shut line is actually *darker* in the slot — which is a
>   different question from whether it exists, and the first version of the plates
>   passed the first test while failing the second.
>
> ### A capture-to-capture diff is not trustworthy in this repo
>
> Other agents commit between your builds. In one A/B here a rectangle of bare
> tarmac that nothing I touched could reach moved by a mean of **25.6/255**. Any
> conclusion resting on a delta smaller than that is unsupportable. Prefer
> within-frame measurements (one region against another in the *same* png) or
> CPU screen-space probes. If you must diff across builds, include a control
> region and *believe it* when it moves.

## Edge work — round `2026-08-28T170918Z-cb4d3a6c3ed6`

Three items, all measured in frame rather than asserted.

**Edge chamfers.** `chamferPrism` extruded with `bevelEnabled: false`, so every
horizontal edge on the cabinet, valance, head, head step and both accent bands
was a dead 90°. Now bevelled via `EDGE.big`. **Sized at 5 mm, not the 1-2 mm the
brief asked for, and the reason is written into the constant** — at 1600 px the
cabinet runs 3.37 mm/px in `corner.png`, the frame a critic reads, so a 1.5 mm
chamfer is 0.45 px and dithers into the corner it was meant to break. 5 mm is
1.5 px there and 2.7 px at `pump_close`, and a 3-5 mm brake radius on formed
sheet is honest. Do not "correct" this back to spec without redoing the
mm/px table.

**Recessed shut lines.** The joints were a 5 mm dark strip lying on the skin — a
painted stripe. The panels are modelled instead: 22 plates standing `PROUD` = 5 mm
off a dark backing skin, separated by `GAP` = 8 mm. The gap floor is real, 4.6 mm
back, and the plate fillet above it faces down while the one below faces up into
the sky, which is the dark-line-with-a-bright-line-under-it that a shut line
actually is. **This fits only because the payment furniture is mounted on the
head's Z plane, 30 mm outboard of the cabinet skin.** Check that before raising
`PROUD`.

Measured with `tools/seamprobe.mjs <panels.png>`: every joint now reads darker in
the slot than the plate beside it, by 10 to 66 of 255, with the lip 12 to 19
brighter. **The first version measured −3.9, i.e. the slot was brighter than the
plate** — 2.5 mm fillets either side had eaten a 6 mm gap down to about 1 mm of
visible floor, so all that survived was lip highlight. Hence `PLATE_R` = 2 mm,
deliberately smaller than `EDGE.small`. If you widen the fillet, widen the gap.

**Nozzle form.** The valve body was `roundedBox(0.076, …, 0.020)` — a 20 mm
fillet on a 76 mm box is 53% of the half-width, which is a capsule, and stacked
with the handle barrel and the bellows sleeve it gave the critic exactly what
they described. It is now a side profile extruded across the width with a 5 mm
cast break and a drafted flank, plus a spout boss and union nut, a deck rib and
a hanging hook on the spine. The trigger guard is squashed to a flat stamped
strap (a 13 mm round rod returns a one-pixel specular the resolve throws away)
and the hold-open latch is a three-notch rack plus pawl.

**The boot was doing more damage than the nozzle.** It was
`CylinderGeometry(0.053, 0.036, 0.122)` in the cream body material: a cone of
revolution, 106 mm at the mouth narrowing to 72, i.e. literally a disposable
cup, which is what it was called. Now an oval scabbard — squashed 0.66 on Z,
near-parallel walls, in `steelDark`, with a rolled oval lip and a squarer
escutcheon where it passes through the panel.

**The stowed nozzle now has weight.** `nozzleStowed` had only a fore-aft rake and
sat on the boot centreline, which is the "placed by snap-to-grid" read. It now
takes `vary.nozzleTilt`, a signed side lean, and is offset in the same direction
by most of the clearance so it is genuinely in contact with one wall.

### Still weak here, in my own reading

- **The weakest unit pair is 5.46/255 structural** on the cabinet (unit1 vs
  unit2). unit1 vs unit3 is 21.28. Case 22 records that a pair a critic called
  "one asset" measured 3.03 and properly phased materials measure 33-53, so 5.46
  is above noise but thin. Cause is visible in `pumpVariation`: the band
  permutation `[1, 0, 2]` gives pumps 1 and 2 *adjacent* thirds of every
  stratified range, so the closest pair is closest by construction. Widening
  `fieldOffset`'s separation for adjacent bands is the cheap fix.
- **The cabinet substrate still reads as stucco**, not painted steel — the grime
  normal is too coarse and too uniform, and it runs across the plates, the slots
  and the painted band identically. This is the critic's item 10 and it is now
  the most visible thing at close range.
- **The nozzle is a dark mass at forecourt distance.** The form is right and the
  parts are there, but nothing separates them tonally.
- **Bollard colour.** The posts read as saturated orange plastic with a sooty
  band rather than chalked yellow paint over steel. The profile work from the
  previous round holds numerically; the material does not.

## Verified against pixels

Round `2026-08-28T161622Z-6ec8060d215f`.

**The two contradictions, resolved.**

- **Per-unit variation.** The critic was right; my report was wrong, and wrong
  for an instructive reason — I measured the generator (43.2% hose-length
  spread, 37.4% kink-phase spread, both true) instead of the render. See
  `NOTES.md` 19. Fixed by varying the *phase* of the grime field per unit, not
  just its strength, plus raising two amplitudes that the phase fix exposed as
  invisible, plus per-unit price-head content. Structural cabinet delta between
  two units went 3.03 → 11.22 out of 255.
- **Bollard profile.** The critic was right that the post still bulged, and
  right that the *outline* rather than the dents was the problem. Measured, the
  old post was outside nominal at every height by 3–15.5 mm with no straight
  section anywhere. Three causes: the dent lip at 18% of depth (now 7%),
  overlapping dents *summing* (now combine by max — the sum reached 56 mm inward
  on a 98 mm radius, a 57% crush), and a height-modulated ovality term that is
  not something rolled pipe does. Deformation is now clamped one-sided at
  +1.2 mm, so nominal is the outer envelope.

**Reads correctly.**

- **Hose catenary (defect 1).** Belly is off-centre and drawn toward the nozzle;
  measured sag 493–563 mm over a 456–466 mm chord, low point at 0.43–0.48 of the
  run. Note the critic's objection is *not* about the curve — it is that the
  nozzle "sits perfectly upright and centred in the boot as if placed by
  snap-to-grid" and that the hose is in tension right up to it, so the nozzle
  reads as held up by the hose rather than pulling down on it. That is a
  separate and unfixed defect.
- **Nozzle (defect 4).** 408 mm tip to butt at the new 0.68 scale, against ~410 mm
  for a real OPW 11A. It reads as a nozzle with a guard now rather than a cylinder
  with a collar. The oversize was the whole defect.
- **Control depths and seams (defects 7, 8).** Card reader, keypad, receipt slot
  and bill acceptor each catch their own shadow at `pump_close`. Seams break
  either side of the payment column instead of running through it.
- **Topper signage (defect 9).** New `src/gen/pumpDecals.ts`. Legible at the
  `island` distance and still a strong horizontal value break well past that,
  which is what the top third of the silhouette was missing.
- **Bollards (defect 6).** Chunkier stock, seed-derived dents, and a baked lean.

**New this session.**

- `src/gen/pumpDecals.ts` — canvas topper face, `alpha: false` throughout per
  NOTES case 1. Authored at 3.84:1 to match `TOPPER_FACE` in `pumpParts.ts`;
  **the two must move together** or the type stretches. `pumpprobe` asserts the
  face UVs are 0..1, because the rest of the pump carries metre-scale triplanar
  UVs and a canvas map routed through those collapses to one texel.
- `buildBollard` bakes the lean. The `post.rotation` X/Z terms in `PumpSystem`
  are gone — there were two independent out-of-plumb mechanisms adding up, and
  the probe could only see one of them.
- `tools/pumpprobe.mjs` fits the bollard axis from the mesh before measuring
  anything radial. See NOTES case 18; without this the lean reads as 40 mm of
  fake dent depth.

**Still weak — the critic's priority order, none of these attempted.**

The critic rates 2 and 3 as cheap and very high value, and 3 as the single best
thing available: *"Add 1–2 mm bevels so the low sun produces a bright rim line.
This alone would do more for realism than any texture work."* Given a dawn key
light that is almost entirely grazing, that is very likely true. I did not get to
either; they are geometry work across most of `buildPump` and I judged the two
contradictions to be worth more, but they are the obvious next round.

1. **Nozzle is unfinished geometry** — "three rounded capsules stacked at an
   angle" in "a disposable paper coffee cup". The 408 mm sizing is right and the
   form is not. Needs a cast body, a ~19 mm bore spout exiting the front and
   hooking down, trigger, trigger guard, hold-open latch, hanging hook, swivel at
   the hose entry.
2. **Panel breaks have no depth** — every shut line is a 1 px painted stripe.
   Recess them 2–3 mm as real geometry so there is AO in the slot and a lit
   upper lip.
3. **No edge chamfers anywhere.** Every cabinet corner and bezel edge is a
   perfect 90°. `chamferPrism` chamfers the *plan* only; the horizontal edges are
   all sharp.
4. **Bollard damage is inverted in the texture.** Geometry is now correct
   (inward, with a rim lip) but `makeBollardSkin` still paints a soft mud smear
   where it should be hard-edged paint chips to grey primer and bare steel, with
   rust bleeding *downward* from the chips. It already computes `paintGone` and
   `rust`; the band needs a crisper profile and the two need to be tied to the
   mesh dents rather than to their own noise.
5. **No hose retriever exists at all** — no spring cable, pulley, counterweight
   or arm. In scope, simply absent.
6. **Hose has no material response.** Pure matte. Real fuel hose is oily with a
   soft highlight along the top edge, embossed lettering, grey scuffing
   underneath. It is also perfectly constant in diameter, never flattens or
   bunches, and makes no contact with the cabinet and casts no contact shadow
   onto it.
7. **Payment area is blank** — no key legends, no wear on 1/2/5/ENTER, no card
   reader bezel graphics, no chip slot, no receipt door, no stickers. Real
   payment areas are dense with print. `pumpDecals.ts` is the home for this and
   already exists.
8. **Display glass is optically perfect.** The critic calls pump display glass
   "the dirtiest surface on the unit": wants sky reflection, low-sun smear, dust
   in the bezel corners, fine wipe scratches.
9. **Grime ignores substrate.** One tiling overlay running identically across the
   painted band, the shut lines and different materials. Should collect in
   recesses, under the display lip, at the cabinet base, around the boot.
10. No splash zone on the bottom 300 mm or the plinth. Toppers read as decals
    with no bracket, bolts, UV chalking or insect debris in the light box.
    Octane buttons are unlabelled grey pills. No drip stains under any boot. Red
    band is a perfect decal with no chipping or differential fade.
11. Defect 11, forecourt clutter, still untouched.

**Credit the critic gave, do not regress:** topper typography and hierarchy, the
ghost "88" segments behind the price digits, the fractional 3.499 digit, the
87/89/93 octane strip, the concrete grout collar at the bollard base, and the
coiled spring strain-relief at the top hose fitting — *"the single best-observed
detail in the entire set."* Silhouette proportions at forecourt distance also
read well; it is close range where it collapses.

**Do not re-add** the Worley height term in `makeBollardSkin`, do not narrow
`bollardDents` back toward the car's crease widths, do not let dent
contributions sum again, and do not remove the one-sided clamp in
`buildBollard`. All of those looked correct in code and all of them were read by
a critic as the post being inflated or slumped.

**Do not call `applyGrime` directly inside `makeUnitMaterials`** — use
`unitGrime`, or the unit loses its field phase and the row goes back to reading
as one asset. This is the single most expensive mistake available in this file.

## Scope

Pumps only. `src/systems/CarSystem.ts` and `src/gen/carBody.ts` belong to another
agent, as do the `car.parked` / `cars` registry entries. Untouched by this pass.

## Files owned by this system

| File | Role |
| --- | --- |
| `src/systems/PumpSystem.ts` | System, materials, placement, registry |
| `src/gen/pumpParts.ts` | Dispenser and bollard geometry |
| `src/gen/pumpDisplay.ts` | Redrawable price/volume canvas |
| `src/gen/hardsurface.ts` | Shared hard-surface helpers (**also used by `CarSystem`**) |

`hardsurface.ts` is shared with the car agent. Every change made to it this pass
was additive with defaults that reproduce the previous behaviour, so the car
should be unaffected. Keep it that way.

## State: compiles clean

`npx tsc --noEmit` reports **zero errors in all four files above**. The rest of
the repo was not checked and may be red from other agents' in-flight edits.

Nothing was left running: port 5113 is free, and there are no Playwright,
chromium or vite processes from this session.

## Registry surface — intact, unchanged

All four services still provided from `init`, with identical shapes:

- `pumps` — `PumpHandle[]`
- `pumpsByName` — `Record<string, PumpHandle>`
- `pumpFaces` — `PumpFaceHandle[]`
- `pumpPickables` — `THREE.Object3D[]`

Full `PumpFaceHandle` surface preserved: `name`, `facing`, `standPosition`,
`displayCentre`, `pickables`, `setDisplay`, `resetDisplay`, `setActive`,
`setNozzleLift`, `getNozzleLift`. `PumpHandle` also unchanged.

The only signature change is to the **private** `makeFaceHandle`, which gained a
trailing `vary: PumpVariation` argument. One call site, no public effect.

## Do not regress

The critic praised the display head as "the only element in these five frames
that would survive a squint test". None of `pumpDisplay.ts` was touched. Preserve
the ghosted seven-segment digits behind the live ones, the SALE / GALLONS /
PRICE / GAL hierarchy, the fractional-cent price, the three grade buttons with 87
highlighted, and the soft-key column down the bezel.

## Defect status

Numbering follows the critic's list.

| # | Defect | Status |
| --- | --- | --- |
| 1 | Hose reads as rigid conduit | **Code complete, unverified** |
| 2 | Cabinet reads as speckled stucco | **Code complete, unverified** |
| 3 | Zero weathering | **Partial** |
| 4 | Nozzle silhouette wrong | **Partial** |
| 5 | Cabinet too shallow | **Code complete, unverified** |
| 6 | Bollards wrong stock | **Not started** |
| 7 | Controls all same depth | **Code complete, unverified** |
| 8 | Seam lines don't follow geometry | **Code complete, unverified** |
| 9 | No silhouette complexity at distance | **Not started** |
| 10 | Three identical pumps | **Partial** |
| 11 | No forecourt clutter | **Not started** |

### 1 — Hose. Rewritten; needs looking at

This was the headline defect and the rewrite did land, but nobody has seen it.

`hardsurface.ts` gained `hangingHose(from, fromDir, to, toDir, length, opts)`,
which solves the **actual catenary** rather than drooping a lerp. Given
horizontal run `h`, height difference `v` and arc length `L`, it bisects for the
catenary parameter `a` in `sqrt(L² - v²) = 2a·sinh(h / 2a)`, then places the
vertex at `x0 = h/2 - a·atanh(v/L)`. Because the two fittings sit at different
heights the low point is genuinely off-centre, and an extra `nozzleLoad` term
skewed toward `t = 1` drags the belly further toward the nozzle.

The old `hoseCurve` is still exported and marked `@deprecated` — it offsets the
chord by a symmetric `cosh`, so its low point is always at the midpoint. Nothing
calls it any more. Delete it once you are confident, but check the car agent
first.

Routing also changed. The hose now leaves a real swivel assembly bolted to the
**cabinet end panel** — boss, two fixings, turned barrel, hex union nut and a
tapering strain-relief spring — instead of terminating in a chrome stub that
intersected the cabinet.

**`setNozzleLift(0..1)` still rebuilds the curve.** `rebuildHose(c)` is called on
every change and re-solves the catenary. Slack length is *conserved* across the
travel: lifting the nozzle takes up slack instead of shortening the hose, which
is the physically right behaviour but is exactly the sort of thing that looks
wrong in motion. **Sweep it 0 → 1 and watch it before trusting it.** Suspicion:
at high lift the chord may approach the slack length and the loop could snap
taut abruptly.

Hose slack length and kink seed come from `pumpVariation(seed)` in
`pumpParts.ts`, exported specifically so `buildPump` and `PumpSystem.rebuildHose`
agree. **If they ever disagree the hose changes shape the instant anything
touches the nozzle** — that is the trap this export exists to prevent.

### 2 — Cabinet material. Rewritten; needs looking at

New `makeCabinetSteel()` in `hardsurface.ts` replaces `makePaintedSteel()` on the
cabinet skin and the livery band. The diagnosis was that the old map packed all
its detail into a 320 mm tile, giving uniform high-frequency speckle.

- Tile raised to **0.9 m**, so one tile spans a cabinet face and the dominant
  feature is oil-canning rather than stipple.
- Roughness pulled to a **narrow band around 0.30**; the material now sets
  `roughness: 0.34, metalness: 0.10` where it was `0.52 / 0.06`. This is the
  change most likely to fix the "no specular response" complaint.
- Faint **directional brushing**, by sampling the noise with U compressed 9:1.
- Normal strength dropped to 0.30 — a strong normal on a flat panel is another
  way to lose the specular.
- Grime `roughGain` on the cabinet cut to **0.45**, so dirt can darken the albedo
  without erasing the gloss. Grime `scale` raised 0.85 → 1.9 and `film` cut
  0.52 → 0.30, since the grime field itself was a big part of the speckle.

`makePaintedSteel` is still used, correctly, for small hardware, where a 0.9 m
tile would show no detail at all.

**Risk:** lighting is being built concurrently in `LightingSystem.ts`. If the
scene looks flat when you first load it, resist flattening the roughness back —
the authoring is right and the exposure is someone else's problem.

### 3 — Weathering. Partial

`GrimeOptions` gained four optional fields, all defaulting to the old behaviour:

- `streakFocusX` / `streakFocusHalf` — confine run-off to a vertical band at
  `|x| = focus`. Used to put the fuel run **under the nozzle boot** instead of
  washing evenly down the whole cabinet. Mirrored in X, so one value serves both
  faces.
- `scuffCentre` / `scuffRadius` / `scuffAmount` / `scuffColor` — a bare-metal
  annulus centred on the nozzle's swing. *Cleans* rather than dirties: lifts the
  albedo toward raw steel and drops roughness.

The livery band was also re-authored — it sits at 0.34–0.46 m, squarely in the
splash zone, and is now the dirtiest painted surface rather than the cleanest.
That directly answers "the red stripe is factory-perfect".

**Still missing:** no dirt film on the top surfaces of the head, and the seam
grime has not been checked to see whether it actually reads now that the seams
are per-face segments.

**Unverified, and this is the one to check first.** The scuff annulus is new
shader code on a path that has never been rendered. `forceGrime()` was extended
to drive it to cyan at full strength — run the existing `force=grime` debug query
and confirm the annulus appears at all before spending any time tuning it. Given
this repo's history of code silently failing to reach the screen, assume it is
broken until you see cyan.

### 4 — Nozzle. Partial

Rebuilt for a readable silhouette: squarer valve casting with a cast rib, moulded
grip sleeve stepping the handle diameter, hex swivel boss and turned collar at
the butt, a deeper and squarer trigger guard, a much more pronounced downward
crank on the spout, a spout lip ring and filler-neck hook, and a proper six-ring
vapour-recovery concertina stepping down in diameter.

The holster is no longer a flat plate. It is a pressed pocket — a flaring open
cone with a rolled lip ring, a closed bottom, a drain spigot, and a bracket
tying it back to the cabinet with two visible fixings.

**Partial because none of it has been seen.** The nozzle is small in frame and
the previous version also looked reasonable in code and read as "a cylinder with
a collar" on screen. Judge it from `pump_close` before doing anything else to it.

### 5 — Cabinet depth. Done in code

`cabD` 0.62 → **0.72 m**, `cabW` 1.06 → 1.02, taking the plan ratio from 1.7:1 to
about 1.4:1. Head is now wider *and* deeper than the body (1.10 × 0.78).

New `chamferPrism()` builds the cabinet, valance, head and livery band on a
**chamfered octagonal plan** with eased corners, replacing rounded boxes. The head
is also stepped in again near the top. The chamfer faces should each catch their
own narrower highlight down the corner — that is the point of them, so check that
they do.

### 7 — Control depths. Done in code

Card reader, keypad, receipt slot, bill acceptor and grade panel now differ
deliberately in depth, bezel thickness and fixing:

- **Card reader** — deepest at 62 mm, on a gasketed sub-plate, four hex fixings,
  chrome slot lip.
- **Keypad** — shallow and set *into* a recess, contrasting with the reader.
- **Receipt slot** — nearly flush, thin stainless lip, rubber dust flap.
- **Bill acceptor** — deep bolted-on module, heavy chamfered throat, two fixings.
- **Grade selection** — one moulded pod with three large keys, not three separate
  stamped rectangles.

### 8 — Seams. Done in code

The old `seam()` ran a continuous box ring right round the cabinet at each
height, so lines carried straight across the payment column, the boot and the
livery band. Replaced with `faceSeam(y, x0, x1, face)`, which emits per-face
segments that break either side of the payment column. The full-width joint now
sits under the valance, above all the furniture.

### 10 — Per-unit variation. Partial

`pumpVariation(seed)` varies hose slack length (1.44–1.70 m), hose kink seed and
nozzle rake per unit. **Not yet varied:** wear amount, stain placement, the
one-degree rotation, and the bag over the nozzle. The critic said this one "kills
it in `island`", so the remaining half matters.

## Next three things

1. **Capture and look, before writing any more code.** Five presets on port 5113
   into `shots/system3/`, via `tools/shoot3.mjs`. Print the bundle mtime with the
   capture — stale shots have already cost a wasted critic round. Roughly a third
   of the work above is new geometry and new shader code that has never been
   rendered, and this repo has a documented history of correct-looking code
   silently failing to reach the screen. Specifically: sweep `setNozzleLift`
   0 → 1 and watch the hose; and run `force=grime` to confirm the scuff annulus
   goes cyan. Expect at least one thing to be plainly broken.
2. **Defect 6, bollards** — untouched and cheap. In `buildBollard`, radius is
   0.084 (168 mm dia) at 0.98–1.02 m tall, which is nominally within the
   150–200 mm spec yet still read as "lollipop posts". Go to roughly 0.098 m
   radius and drop the height nearer 0.92 m for a chunkier ratio, and raise the
   domed cap scale from 0.55. The paint, chip and rust bands in
   `makeBollardSkin` are already keyed to real heights via `heightM` — **pass the
   new height through** or the bumper rub band will land in the wrong place.
3. **Defect 9, silhouette at distance** — nothing exists yet. Needs valance
   signage, a topper graphic and vapour-recovery lines up the cabinet ends. The
   signage ruling is that diegetic text on physical objects is allowed and
   encouraged; invented wording only, no real brands or logos. A `pumpDecals.ts`
   alongside `pumpDisplay.ts` is the obvious home, reusing the same canvas
   approach. `pumpDisplay.ts` deliberately uses `alpha: false` canvases to dodge
   the premultiplied-alpha corruption documented in `NOTES.md` — do the same.

Defect 11, forecourt clutter, is last: genuinely minor and worth nothing until
the dispensers themselves hold up.

## Left for you by the RNG audit (NOTES.md case 16)

Two changes were made inside your files. Both were forced by a defect in the
shared `noise.ts`, not by anything wrong in the pump code.

- `pumpParts.ts` `pumpVariation` now calls `seededRng(seed)` instead of
  `makeRng(seed * 977 + 13)`, and `hardsurface.ts` `hangingHose` now calls
  `seededRng` too. `makeRng`'s first draw is very nearly linear in its seed, and
  `PumpSystem` seeds the row with 1, 2, 3, so all three of `pumpVariation`'s
  fields — which come off the first three draws — were a ramp rather than a
  sample. **Item 10 above was not partial for the reason it says.** Hose length
  ran 1.455 / 1.471 / 1.488 m: 12.7% of your authored 260 mm range, in ~16 mm
  steps. It now spans 112 mm (43.2%). The six hose kink phases spanned 7.9% of
  0..2π and now span 37.4%.
- Your `hoseSeed + 7` / `hoseSeed + 19` offset, which exists to stop the two
  faces of one dispenser matching, was moving the kink phase by **0.25 degrees**
  — the two hoses on every pump were phase-locked. The offset was correct; the
  RNG was not. It now separates them by 17–36 degrees. Nothing to change.

Pump geometry moved as a result: hose length by 21–117 mm and nozzle rake by
0.05–3.8 degrees per unit. Any values you tuned against the old hose poses need
re-checking against a capture, and this is worth an actual look — it is the one
place in the project this fix was allowed to change pixels.

**One defect found and deliberately not fixed, because it is yours.** In
`buildBollard`, the seed only reaches the `oval` term. The two dent lobes are at
hardcoded angles — 1.1 and 2.4 radians — so **every bollard is dented in the same
two places regardless of seed.** Six posts on the forecourt share one dent
pattern. This is not the RNG bug and `seededRng` will not help it: the fix is to
derive the lobe angles (and ideally their depth and count) from the seed like
`oval` already does. Cheap, and it pairs naturally with the proportion work in
"Defect 6" above since you will be in that function anyway. Verify with
`node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-rngsets.mjs`,
which already prints the bollard phase spread and will pick up the lobes once
they are seed-derived.

## The bollard feet were missed by the case 21 fix

Your `fieldOffset` / `fieldFlip` work is confirmed good: audited on CPU, the three
dispensers' fifteen grime keys all carry three distinct phases and every pair
measures **33-53/255** apart on the field lookup. That is the reference for
"genuinely different" and it is what cleared everything else.

Two loose ends in `PumpSystem.ts`, both shared materials outside `unitGrime`:

**`pump-grout` (`PumpSystem.ts:636`) is affected.** One material, four bollard
feet, no `fieldOffset` — mean field difference **0.00/255** across all six pairs.
Same defect as the cabinets, just on a smaller part. The feet are 390 mm discs at
ankle height in the middle of the forecourt, so it is a real if minor read.

**`pump-bollard` (`PumpSystem.ts:613`) is fine, and I checked rather than
assumed.** One material, no offset, four posts — the shape that should be
affected. It measures **35.7-38.4/255**, i.e. as decorrelated as the phased
dispensers, because the three distinct heights plus the baked lean move
corresponding surface points into different field tiles. A structural check on its
own would have flagged it as a defect and sent you after a non-problem. Worth
knowing before you touch bollard heights or the lean: if those ever converge, the
posts fall into this bug and nothing will say so. `tools/probe-instancing.mjs`
will.

For the feet, the cheapest correct fix is to give each bollard its own grout
material through the same wrapper pattern you already use, with the offset drawn
from that bollard's seed via `seededRng`. Verify with:

```
node --import ./tools/tsregister.mjs --experimental-strip-types tools/probe-instancing.mjs
```

It currently fails naming `pump-grout` plus three car keys, and reports the
bollard posts as clean.

Also worth knowing: the same audit found the car's four rims, four wheel caps and
four tyres at 0.00/255, so this was never a pump-only problem. `applyGrime` is now
the only object-space field sampler in the project — the building and terrain
sample in world space and are immune by construction. Recorded as `NOTES.md` case
22, with your dispenser case renumbered to 21 (it had been written as 19, which
collided with the car's grille case).

## Round 2026-08-28T180140Z-5e7832772234 — read this before trusting it

**That round's lighting is broken and it is not the pumps' fault.** Every frame
is a silhouette against a dim sky. `src/systems/lightSky.ts` and
`LightingSystem.ts` were being edited by the Lighting agent inside my build
window (23:31 local mtimes, my bundle 23:24:48), and the sun is off scene-wide
including the sky and the background buildings — nothing in `pumpParts`,
`PumpSystem` or `hardsurface` can do that.

**Judge the pumps on `2026-08-28T174654Z-eb75b216a5bc` instead.** It is one
change behind: it has everything below except the bollard chip-discreteness fix,
which is verified CPU-side only and has never been seen on screen.

### The seam contradiction, settled — the critic was right and my probe flattered me

Not stale captures: that round's bundle postdated the last source edit by 29
seconds and the stable copies were byte-identical to the round copies.

The features existed. They did not read, for two compounding reasons, and my
instrument said otherwise because it was scoring them with a minimum over a
window that had a dark valance in it. Full write-up in NOTES under "A feature can
be defeated by the light and the eye at once" and "min-over-a-window cannot tell
a groove from a shadow". Short version: at an 11 degree sun a *horizontal* groove
on a vertical wall is lit along its own length and cannot self-shadow, and at the
`corner` camera angle its lit lip is foreshortened to a third of a pixel. The
vertical joints scored -95 in the same frame under the same sun. Horizontal and
vertical instances of the same feature are not the same feature.

Fixed by lapping rather than deepening: each panel row stands `LAP` = 4 mm
prouder than the row below, so the overhang throws a shadow `1/tan(SUN_ELEV)` =
5.1x its depth down the panel below — 20 mm, on a surface the camera sees
face-on. Backed by a deposit strip sized from the same number, so the painted
mark and the real shadow land on each other. `SUN_ELEV` is imported from
`src/site.ts`; if the time of day moves, both move with it.

### Do not use `regiondiff` between rounds here

Three other agents are editing shared lighting and environment code. Two of my
five captures tonight were invalidated by someone else's mid-surgery state. Use
within-frame measurements (`tools/edgeread.mjs`) or CPU probes.

### What changed this round

- **`seam` is a new geometry slot** on `PumpBuild`, holding shut-line floors,
  the deposit band under each lap, and fastener weeps. It exists because these
  were in `steelDark` (metalness 0.35, envMapIntensity 0.8) and a third of what
  they returned was specular off a flat bright hemisphere: on half the panel's
  albedo they should have measured -50 of 255 and measured -13. `seamMat` is
  metalness 0, envMapIntensity 0.3. **Keep anything whose job is to be dark out
  of a metallic slot.**
- **Keypad legends.** The twelve blank lozenges are gone; the keys are printed
  by `makeKeypadFace` with 1-9, CANCEL, 0, ENTER, colour keys, baked per-key
  relief lit to agree with the site sun, and finger polish on 1/2/5/ENTER. Real
  relief was impossible: the merged pump carries metre-scale triplanar UVs so a
  0..1 atlas cannot ride on the key geometry. Legibility beat 14 mm of relief.
- **Fasteners.** They were at x = +-0.46 where the plate spans end at +-0.425, so
  every one sat on the chamfer facet fastening nothing, at Z = the bare skin so a
  5 mm bolt was *inside* the 5-17 mm proud panel it held on, and in `chrome`
  hence "pure white dots". Now on the bottom edge of each panel, at that panel's
  own proud depth (threaded through `boltAt`'s `base` — do not assume one depth
  again), washer plus hex head in dark steel, with a weep below.
- **Bollards: chalked, opaque, and three of them.** Albedo was 90% saturated and
  *dark*, and the faded variant was darker than the fresh one, which is
  backwards — chalking is a powder and a powder is brighter. That plus a warm
  specular is why it read as "amber acrylic lit from inside". Now value up,
  saturation down, and roughness rises with sun exposure. **One
  `makeBollardSkin` call was feeding one material shared by every post**, which
  is why all three were identical; there are now three skins round-robined, each
  with its own grime phase.
- **The stray primitive under the boot** was a bare 34 mm cylinder ending in mid
  air. It now has a hex boss, an elbow and a run back to the cabinet.

### Still weak, in my order

1. **Bollard chip discreteness is unverified on screen.** Numerically it is
   right (0 rows at >55% coverage, was a continuous belt; 25 of 256 rows carry
   damage). Look at `bollard.png` first thing.
2. **Bollard shape.** Still a smooth cylinder with no flat spot, no lean, no
   bumper gouge, and the base is still the "fondant collar" the critic named.
   The colour fix landed; the form work did not start.
3. **Nozzle** still reads as an abstract bent prism. Trigger, guard loop,
   hold-open latch, swivel and grip are still absent or unconvincing.
4. **Cabinet substrate reads as stucco.** Deliberately untouched — painted steel
   is defined by what it reflects and the PMREM's lower hemisphere is currently
   one constant colour. Re-judge with the chamfer rim highlight after Lighting
   reports.
5. **Per-unit divergence.** Still two copies and a tint variant. The right move
   is discrete incidents (one cracked bezel, one bent topper bracket, one torn
   boot), not wider continuous ranges.
6. Plinth is still spotless; grime still does not pool in the new seams or on
   ledges; hose still has no weight.

---

# APPENDED BY THE CROSS-SYSTEM (CPU-ONLY) PASS — 2026-08-29

*Not written by this system's owner. Nothing above was edited. This section is
appended to all five non-terrain handovers with identical text.*

## Shared change in `src/core/Game.ts`: `?solo=` / `?skip=` now actually isolate

**Read this if any of your harnesses gate on `window.__SYSTEM_ERRORS`. All of
them should, and most of them do.**

The terrain agent fixed a bug in the shared `src/core/Game.ts`. `Game.start()`
filtered which systems received `init()`, but `Game.frame()` iterated **every
registered system**, so a system excluded by `?solo=` / `?skip=` still had
`update()` called on the first tick with none of its own state built. It threw,
and the throw was recorded on `window.__SYSTEM_ERRORS`.

Concretely: `?solo=lighting,terrain` produced two `__SYSTEM_ERRORS` entries —
`player.update` and `interaction.update`, both
`Cannot read properties of undefined` — naming two systems that were never asked
to run. So the isolation flag that exists to let you capture your own system
while somebody else's is throwing **manufactured a failure in the one channel
every harness treats as authoritative**, and any harness correctly failing on
`__SYSTEM_ERRORS.length !== 0` could never use it.

### What is in the tree now (verified by reading `Game.ts` this session)

- `Game` keeps a `private active: GameSystem[]`, set in `start()` from the
  `?solo=` / `?skip=` filter.
- `frame()`, `onResize()` and `dispose()` all iterate `this.active`, not
  `this.systems`. Only `register()` and the filter itself touch `systems`.
- An unrecognised name in `?solo=` / `?skip=` now **throws** out of `start()`
  and lists the registered names, rather than being ignored. That is NOTES
  case 25 applied here: a misspelt system name used to silently produce a
  capture of a scene nobody asked for, and it looked exactly like a correct one.

### What it means for you on resume

- `?solo=<yoursystem>` and `?skip=<someoneelse>` are usable again. If another
  agent's system is throwing and blocking your captures, isolate rather than
  waiting.
- **Keep gating on `__SYSTEM_ERRORS.length === 0`.** The point of the fix is
  that the gate is now trustworthy under isolation; it is not an invitation to
  relax it.
- Any past round whose notes blame `player.update` or `interaction.update` while
  a `solo`/`skip` flag was in the URL should be re-read: those entries were
  fabricated by this bug, not by a real failure.
- If you pass a system name to `?solo=`/`?skip=`, spell it exactly as the
  system's `name` — a typo is now a hard, loud failure instead of a silent
  wrong capture.

Written up as **NOTES.md case 32**, confirmed present in `NOTES.md` this
session. Its general shape is worth more than the bug: *a facility that
suppresses part of a lifecycle must suppress every phase of it, and the phase
that gets forgotten is the one in the hot loop.*

## Also: see `RESUME-PLAN.md` at the repo root

New this session. One first command per system, what it should prove, the
numeric baseline it is measured against, and the cross-system dependency order
(most of paint / glass / metalness / wet reflections is behind Lighting's PMREM
world capture).

---

# Session: seams as structure, and the field-range trap

## What changed

**1. The seams had a mechanical cause, and it was measurable.** Wrote
`tools/pumprelief.mjs` (Car's test, with two corrections — see NOTES). The
shut-line floor measured **0% of its area more than 15° off the cabinet plane**:
every triangle visible in an 8 mm gap faced exactly the way the panel faced, so
it differed from the panel only by albedo and a hand-set `envMapIntensity`. That
is mechanically a line drawn on the cabinet, and it explains both halves of the
critic's phrase — "drawn outlines" and "uniformly dark" — because a constant
cannot vary.

Fix: every plate is now pressed with a **return around its perimeter**, sloping
from its front face back to the backing skin. Two adjacent plates therefore meet
the gap with 4 mm of return each and it becomes a V — the upper return faces down
and sees the ground, the lower faces up and sees the sky, the vertical pair faces
sideways where this sun's N·L is 0.901 against the face's 0.390. Slope runs 33° on
the bottom row to 75° on the top because `rel` grows per row, so the joint's tone
now varies by row and by face for free. Returns are segmented along their length
with jitter on the outer edge, so the pair is not identical at every point.
**The returns carry the panel material, not the dark seam paint** — darkening
them too would put the tone back in a constant.

Relief test after: `plate return` 88 parts at **99% off-panel**, `panel lip` at
99%. Only `shut line floor` still reads 0%, and it is now a backstop behind the
returns rather than the visible surface.

**2. The fastener weep was the same defect, unexamined.** A
`PlaneGeometry(7.5 × 26 mm)` in the *near-black slot material*, 0.6 mm proud of
the panel: a hard-edged black rectangle, 34 × 10 px, constant tone. Every bolt
read as a black tadpole with a hard stalk, visible in both `unit1.png` and
`pump_close.png`. Replaced with a tapered quad, a shared soft alpha mask
(`makeWeepMask`, 32 × 64, one texture for the system), and per-stain strength in
a **four-component vertex colour** so a hundred stains of a hundred strengths
cost one draw call. Confirmed in pixels: the stalks are gone.

Note that the relief test correctly gives a stain 0% off-panel and that is *not*
the fault — a stain should shade as the surface it lies on. What condemned it was
hard edges, a rectangular outline, and being the darkest material in the frame.
**The structural test does not subsume taste.**

**3. `groundAccum`, and the range trap Building warned about.** Wrote
`tools/pumpsoil.mjs` first, which was the right order. At the cabinet skins:
`fines` 0.105–0.125 (span 0.020), `grime` 0.0000, `swept` 0.0000, `shelter`
0.0000, `lee` 0.000–0.896. Three fields are identically zero here and all three
are right to be — a graded pad has no standing water, is not driven over, is not
sheltered. `fines` is constant to within 2%.

So the composition is `lee` (which side) × `wallBase.splash` (how high) with
`fines` demoted to a narrow level multiplier and the three zero fields **dropped
rather than down-weighted**. Predicted effect: downwind bolts land at 0.32–0.85
strength, upwind at 0.06–0.17 — a strong per-face difference that agrees with
every other system about where dirt collects.

**4. Harness hardening.** Two changes, both prompted by tonight:
- **GPU is now verified per shot from the live context**, not once at startup on
  a throwaway page. A lost context is recovered on a software backend silently,
  so a round could begin on the 4060 and end on SwiftShader with every log line
  still saying 4060.
- **Any non-empty `__SYSTEM_ERRORS` now writes `DO-NOT-JUDGE` into the round
  directory**, whoever owns the entry, and a round that never counted pump
  triangles fails outright. `Game.ts` disables a throwing system and carries on,
  so a capture of a scene with this system missing looks plausible rather than
  broken — and that nearly happened tonight.

## Cost delta

Per pump **18,068 tris in 12 meshes**; three pumps **54,204 tris, 36 draw calls**
(bollards counted separately — see the registry blind-spot note). The returns add
~880 tris/pump into the existing `steel` mesh at no new draw call; the weep slot
adds 320 tris and **one** draw call per pump.

## What I did not reach

- **Hose and nozzle** — the critic's third complaint (too smooth and plastic,
  wants kinks, scuffs, material variation). Untouched this session.
- **Splash on the cabinet base.** `wallBase.splash` is strong only below 500 mm
  and every fastener is above 550 mm, so splash contributes almost nothing to the
  weeps specifically. The valance and lower panels are where that profile should
  be spent, and they were not touched. This is the single highest-value remaining
  grime item and the measurement to justify it is already in `pumpsoil`.
- **Hand-contact wear** at the keypad and nozzle boot — nothing localised to
  where a hand goes.
- **Re-judging materials under the canopy** beyond noting that the cabinet still
  reads uniformly warm in shadow. Under environment 2.4 with blue skylight
  dominant, shadowed panels should be cooler than they are; the likely cause is
  the pump materials' own `envMapIntensity`, which was authored against the old
  light. Not investigated.
- **Vertical seams** still read as a clean bright/dark pair. The mechanism is now
  honest (geometry, not paint) but the run is straighter than a real hung panel.
- **`lightSky.ts` was unbuildable** when I started — backticks inside a GLSL
  template literal, six comment lines, blocking every agent's build. Fixed
  minimally (backticks to quotes in comments only) so I could build. The lighting
  agent should know that edit exists.

## Correction to the above, from the final round — read this before trusting the grime section

Round `2026-08-29T004205Z-65aea9458596` differs from `2026-08-29T003250Z-60dd17c1e13d`
only by the `soilAt` recomposition, and `tools/diff.mjs` on `unit1.png` reports
**changed=0, max=1**. Three frames are byte-identical outright. So the
recomposition, which is correct on the CPU — weep alpha spread widens from
0.027–0.739 to 0.012–0.887 with the mean held at 0.25 — **produced no visible
change in any frame.**

The `panels` and `pump_close` crops say why, and it is not that the service is
missing: the stains are simply **too faint to read at all**. A warm brown at a
mean vertex alpha of 0.25 through a mask that peaks at 0.86, over a panel
rendering around 0.75, lands under a value of 255. So the tadpole was removed by
making its replacement invisible, which is the opposite failure and still a
failure — *a feature that does nothing and a feature that is subtle are the same
screenshot*, and this is that case with my name on it.

**Do not respond by raising the alpha alone.** The reason the old rectangle read
was that it was near-black against a light panel, and simply restoring that
contrast in a softer shape gets the graphic quality back. What is missing is that
a real weep is a *roughness* change as much as an albedo change — wet-then-dried
dirt is duller than the paint around it and catches the sky differently — and the
material currently varies only colour. The next attempt should carry per-stain
roughness, and should be judged in `pump_close` at 2x before anything else is
tuned.

The verified-in-pixels list for this session is therefore: **fastener tadpoles
gone, horizontal shut lines reading as lap joints with a light-against-dark pair,
vertical seams softened.** The grime work is **CPU-verified only** and has not yet
changed a pixel.

---

# Session: hose, splash, and an env claim I have to withdraw

## Nominated round

**`2026-08-29T010407Z-5279a5d96d7e`** — 11/11, manifest written, RTX 4060 verified
per shot from the live context, `__SYSTEM_ERRORS` empty, registry 95,472 tris.
Contains the plate returns, the weep, and the new base splash. **Does not contain
the hose weathering**, for the reason below.

`2026-08-29T011716Z-977ce9ed6b84` carries a `DO-NOT-JUDGE`: 1 of 11 shots, no
manifest. It is the only frame with the hose weathering in the scene and is
usable for diagnosis only.

## The hose was weathered on a path no capture ever runs

`weatherHose` went into `PumpSystem.rebuildHose`, which is called only from
`setNozzleLift`. The hose in every static capture comes from `buildPump`. So the
change was correct, CPU-verified, and absent from every frame.

**The registry triangle count is what caught it**: it rose by exactly 1,056, the
number the splash darts account for, and not one triangle more, when the hose
change should have added 5,760. A total that is *precisely* the expected value of
a subset is a far stronger signal than a total that is merely lower than hoped.
Now applied at both sites through a shared `HOSE_SPOKES`, because if the two
disagree the hose visibly changes shape the first time a player touches a nozzle —
a defect no static capture can show. Written up in `NOTES.md`.

CPU-verified after the fix: 3,360 tris per hose (was 2,400 at 10 spokes), vertex
colour gain 1.000–2.615. **Not verified in pixels.**

## What the hose and nozzle work actually is

- A **real kink** — a narrow Gaussian at 3–5 cm wide with several times the
  amplitude of the two existing sine waves. The sines were an undulation over the
  whole run, which is why the hose read as an extrusion however they were tuned.
- **The section is no longer a circle**: a `cos(2θ)` ovalisation whose phase
  rotates along the run, zero at the crimped ferrules where the section is held
  round, full in the belly.
- **A helical rib** at 0.55 mm, one turn per ~90 mm, for the braid impression.
- **Scuff and bleach in vertex colour** — chalky pale on the dragged underside of
  the belly, weaker sun-bleach on top, both mottled by a hash. `vertexColors:
  true` had to be set on `hoseMat` or the attribute is silently discarded; that is
  the same failure as the weep, one step earlier.
- 10 → 14 spokes, because a faceted silhouette reads as low-poly plastic before
  any material does.

## Splash, spent where the profile has range

44 darts per pump, in the existing weep mesh: **+352 tris, no new draw call**.
Built as discrete spatters rather than a graded band, with height drawn from a
distribution weighted low (`pow(rng, 2.4)`), because a graded band is exactly the
"too uniform and vertical" defect being answered. Strength capped at 0.75 — the
field saturates on the downwind face and an unclamped product would paint a brown
skirt around the base. Visible and too strong are both failures; only one of them
is detectable in a screenshot.

## The envMapIntensity claim: withdrawn, not confirmed

I told the last reviewer this was "very likely a real regression". **That was
unsupported and should not be propagated.**

- `tools/pumpchroma.mjs` sweeps the whole frame, buckets every surface pixel by
  luma and reports opponent chromaticity per decile. Warmth falls from 0.648 at
  the bright end to 0.117 at the dark end, a −0.53 swing, in every frame tested.
  That is the *opposite* of what I reported by eye. It is confounded — dark pixels
  include dark materials that are neutral by paint rather than by light — so it is
  suggestive, not decisive.
- My first attempt at a decisive A/B **was invalid and I nearly believed it**.
  I captured with `?noenv=1` and got a frame identical to the normal one
  (`changed=0, max=2`), which reads as "the environment contributes nothing" — a
  dramatic finding, and false. Those flags are parsed from `?lforce=noenv`, not as
  bare parameters, so the flag did nothing and I had photographed the same scene
  twice. **A null result from a control that was never applied looks exactly like
  a null result from a control that was.**
- The corrected run (`?env=0`, which goes through `num("env", 2.4)` and is
  definitely wired) failed to load: `net::ERR_HTTP_RESPONSE_CODE_FAILURE` on
  `page.goto`.

So the question is open. The next person should run
`node tools/shoot3.mjs --shots=pump_close --query=env=0 --suffix=_env0` and
compare with `pumpchroma` and `diff`. If the frame barely changes, the
environment is not reaching these materials and it is scene-wide.

## Harness failures worth passing to the performance agent

Two of four capture runs tonight died on `page.goto` — one after 1 of 11 shots
with `ERR_HTTP_RESPONSE_CODE_FAILURE`, matching the earlier `201217Z` crash
(page/context/browser closed on shot 7 of 11). Full rounds now take ~9 minutes at
~37 s per shot, up from ~20 s earlier tonight.

Also: **never pipe `shoot3.mjs` through `grep | tail`.** The pipeline's exit code
is `tail`'s, so a failed round reports success. That masked the 1-shot failure
above for several minutes.

## Not reached

- **The weep as a roughness change.** Still albedo-only. This was item 4 and the
  first three consumed the session.
- **Pixel verification of the hose**, the splash beyond one unasserted frame, and
  the nozzle's own material variation (only the hose got scuff colour).
- One unasserted crop does show localised irregular vertical staining on the
  panels that reads as real dirt rather than a wash — but I cannot attribute it to
  the weep pass versus the pre-existing `applyGrime` streaks without an A/B, and I
  did not get one. **Do not record the weep as confirmed.**

---

# Round 2026-08-29T020852Z-2e8346991d0e (and the three before it)

Four rounds this session, all GPU-verified per shot from the live context:

| round | what it is |
|---|---|
| `2026-08-29T014407Z-2f65274e0416` | full 11-shot, hose weathering + nozzle scuff + weep roughness |
| `2026-08-29T015305Z-1b009aa52d1e` | `?env=0` arm, control asserted applied |
| `2026-08-29T015737Z-bdd4dbc9ad8f` | `?pweep=0` arm, stain mesh absent |
| `2026-08-29T020852Z-2e8346991d0e` | post-fix stain arm, pairs with the round above |

## 1. The hose is photographed and its weathering reads

`hose.png`, cropped to the swivel and belly. The catenary carries a real kink,
the tube shows tonal variation along the run instead of a constant, and it reads
as rubber rather than as an extruded pipe. **Confirmed in pixels.** The frame also
shows the formed panel returns doing their job — the seams read as recessed
joints with tone from slope, and the fastener weeps are visible as short vertical
runs. The critic's "drawn outlines" is answered at this framing.

Whole-frame diff against the last full round is 6.2% changed, max 160 on
`hose.png` and 14.1%, max 176 on `nozzle.png` — but **that A/B is confounded** and
should not be quoted as the hose's contribution. Contact shadow and other shared
work landed between the two rounds and the largest changed tiles are low in
frame near ground contacts, which is where contact shadow would act. The pixel
claim above rests on the crop, not on that number.

## 2. The base splash was buried and now is not

This is the round's real finding. `?pweep=0` removes the stain mesh; against the
matching normal frame it changed **0.0% of `unit1` and at most 9 luma on a few
percent of `panels`**. The strength was fine (vertex alpha to 0.976, mean 0.247),
so the cause was geometric: the darts were offset `cabD / 2 + 0.0009`, 0.9 mm
proud of the cabinet **box**, while the visible skin is the lapped plates at
`PROUD + row * LAP` — 4.1 mm further out at the bottom row. Every dart was behind
the panel it was staining. The fastener weeps in the same mesh offset from the
bolt instead and were the entire 9-luma residue.

Fixed by looking the row up and offsetting from the plate. Post-fix the same A/B
gives **0.5% changed, max 130, +6.27 mean luma over 41% of its tile**, and the
pre-fix/post-fix diff is that number's exact mirror — so the offset is the whole
of the difference. Full detail in NOTES under "Proud is measured from a reference
surface".

Two honest caveats. The stain now **brightens** its region rather than darkening
it (+6.27, not -6.27); warm dried dirt over a cool-lit panel can legitimately go
that way, but nobody has judged whether it is the right direction here. And it is
*present* rather than *legible*: at `unit1`'s framing the two crops are hard to
tell apart by eye. It is measurable, not yet readable.

## 3. `envMapIntensity`: the environment is decisive, the regression claim stays withdrawn

`?env=0` is wired to `scene.environmentIntensity`, and the harness now reads that
value back out of the running scene and hard-fails the shot if it disagrees with
what the URL asked for. Every shot logs `controls env=... envMap=... sun=...`;
the env arm logged `env=0` and the others `env=2.4`, so the control provably
applied — unlike last round's `?noenv=1`, which parses from `?lforce=noenv` and
photographed the same scene twice.

Result: **95.4% of `pump_close` changes, mean |dLuma| 30.4, max 186.** The
environment at 2.4 is a dominant light source here, not a trim. Every tile's
`d(R-B)` is negative, meaning the environment is supplying *cool* light — which
corroborates the physical claim that a dawn shadow is lit mostly by blue
skylight, and independently supports the direction my chromaticity sweep hinted
at while it was still confounded by albedo.

What this does *not* show is a regression in any pump material, and I am not
reinstating that claim. My seam and lip reductions were authored against
environment 1.0: `seamMat` at 0.1 now receives an effective 0.24 where it once
received 0.3, which is close enough that it needs re-judging by eye rather than
by arithmetic. Note also that NOTES has retired `envMapIntensity` above 1.0 as
non-physical and flags the values *below* 1.0 as the same defect still
outstanding — so these two values are on a list to remove, not to tune.

## 4. Nozzle material variation: added, not yet isolated

`scuffProminence` in `hardsurface.ts` wears convex extremities: reach from the
part centroid times how much the normal agrees with the outward direction, so
bosses and the spout tip wear and recesses do not, mottled so it is not a clean
radial gradient. Applied to the nozzle body and metal.

Deliberately applied **inside `buildPump` where the geometry is made**, not at the
consumer in `PumpSystem`. That is the direct lesson of the hose: a property that
lives at a consumer is one refactor away from a second consumer that misses it,
and putting it at the source also means a CPU probe can see it —
`tools/tmp/attrs.mjs` now confirms all four geometries carry their colour
attribute on the photographed path.

**Not isolated in pixels.** The only A/B available was against a round with
confounding shared changes. It needs a `?pscuff=0` arm of its own, which is one
capture.

## 5. Two harness fixes

- **Controls prove they applied.** Per shot, the live scene's
  `environmentIntensity`, environment presence and strongest directional
  intensity are read back and echoed, and a mismatch with a requested `env=`
  fails the shot. Unrecognised bare flags warn, since debug switches here parse
  from `?lforce=<csv>`.
- **`--no-build` against an empty `.shot-build/` is now fatal at startup.** It
  used to print `MISSING` as a note, serve nothing, and die on
  `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE` — which reads as a browser or
  network fault and was filed as one twice, including in this system's notes to
  Perf. That specific `page.goto` death was local and self-inflicted; the deaths
  during full 11-shot rounds are a separate matter and still Perf's.

## 6. Cost

**Triangle delta this round: zero, as predicted.** Registry `tris:101232` and
`meshes:78`, unchanged across all four rounds — every change was a vertex
attribute, a shader injection or an offset. The prediction was stated before the
capture, which is the point: a total that fails to move when nothing should have
added geometry is as much a check as one that moves by the wrong amount.

The registry still counts dispenser meshes only and excludes bollards; see NOTES.

## Not reached

- Nozzle scuff isolated in pixels (`?pscuff=0`).
- The stain's direction of contrast and its legibility at `unit1` framing.
- `src/gen/contactShadow.ts` for the bollard bases, which is the TODO it was
  built for.
- The parts manifest publishes **558 parts with `name === undefined`**, so
  `partscale.mjs` cannot rank anything on this model. The `section()` scoping is
  not attributing names. Worth fixing before the next relief or scale pass.
- The cabinet reads as a pale near-featureless monolith in the distant end-on
  view in `unit1.png`. The formed returns work at `hose.png` framing; whether
  anything should read at that distance is a judgement, not a defect yet.

---

# Round 2026-08-29T025721Z-8c3e8dfdae0c

## Two corrections first, both to claims I made last round

**1. "558 parts with `name === undefined`" was false, and it was my probe.** The
manifest field is `label`, not `name`; reading `p.name` off a `{ label, geo }`
object returns undefined for every part, 100% of the time, whatever the manifest
contains — a probe that could not return any other answer. The real state was 328
of 558 labelled across 9 sections and **230 unlabelled**, which is a genuine gap
but a different and smaller one. An hour was allocated to this on my report; it
did not need an hour.

The actual reason this system never had a size ranking is unrelated:
`partscale.mjs` hard-imports `src/gen/carParts.ts` and `src/gen/carBody.ts` and
parses its poses out of `tools/shootcar.mjs` with a regex requiring `local: true`.
It cannot be pointed at another model at all.

**2. The `+6.27` mean luma I attributed to the base splash was the car, and the
`-1.43` that replaced it was the shared contact shadow.** Both A/B arms were
captured 20–40 minutes apart, and in a tree six agents are committing to, that is
long enough for the comparison to be about somebody else's work. The pre/post
difference did mirror the A/B exactly, and I reported that as proof the offset
accounted for the whole difference — the arithmetic was right and the attribution
was wrong. Crops of the two tiles show a car flank and a new contact-shadow line
under the plinth. **The offset fix was real, but its pixel evidence was not; it
rests on the CPU geometry measurement alone.**

## The harness fix that follows from it

`--ab=<query>` captures both arms in one process, one server, one bundle, one
browser, back to back. Nothing in `src/` can change between them, so the
difference is guaranteed to be the flag. Every A/B below is same-build.

Also added: proof-of-effect for `?pscuff=0`, which zeroes an amplitude rather
than removing geometry so it cannot be checked by counting meshes. The harness
reads the nozzle vertex colours out of the live scene and reports span/sample
count — `nozzleScuff=0.2281/1626` on, `0.0000/1626` off. The first version of
that probe matched meshes by name, the three nozzle meshes were the only unnamed
meshes on the model, and it reported a span of 0 having sampled nothing. It now
carries the sample count and fails on zero samples separately, because **a probe
that samples nothing must say so rather than return zero.** The meshes are named
now too.

## The stain: three independent causes, all found, now rendering

`?pweep=0` same-build A/B on `hose`: **max 41 luma, 0.3% of frame, top tiles
-0.73, -0.59, -0.38** at the cabinet base. Negative, so it darkens — the correct
direction, which the earlier misattributed measurement had backwards. Crops
confirm added dark vertical runs low on the cream panels in the on-arm, with the
pre-existing `applyGrime` streaking present in both arms, which is exactly the
separation that was missing.

It took three fixes because it had three causes, each sufficient on its own:

1. **Buried** — offset from the cabinet box, 4.1 mm behind the lapped plate.
2. **`RedFormat` alpha map** — three's chunk is `diffuseColor.a *= texture(...).g`
   and an R8 texture has no green, so alpha was multiplied by zero.
3. **Inward winding** — all 672 triangles front-face culled. The stored normals
   agreed with the wrong winding, because `computeVertexNormals()` derives them
   from it: 672 of 672 agreeing, information content nil.

Plus a fourth quiet one: effective mean opacity was `0.247 × 0.40 = 0.091`,
because the hand-written mask's own range was never probed while `groundAccum`'s
was audited carefully. Renormalised so the mask mottles rather than attenuates.

Full write-up in NOTES, including why four successive fixes each measured as
"still nothing": a null result has no shape, so it cannot tell you how many
causes it has.

## `tools/pumpscale.mjs`, and what it says

New, with a selftest that checks the metric can fail (a box must shrink with
distance and must return null behind the camera). Poses parsed from
`tools/shoot3.mjs` and layout from `PumpSystem.ts`, both from source. Manifest is
now two-level — sticky coarse `region()` at banner boundaries, scoped fine
`section()` inside — and **unnamed is 0 of 558**. Its first print caught its own
mis-attribution: 40 fasteners filed under "vapour recovery" because that block
sits after the banner, and vapour recovery dropped 98 → 18, which is exactly the
arithmetic of the code.

Largest at `pump_close`, in px diagonal:

| px | label |
|---:|---|
| 950 | base and cabinet |
| **870** | **shut line floor** |
| 604 | plate return / panel plate |
| 540 | vapour recovery |
| 180 | base splash |
| **54** | **panel lip** (240 parts) |
| 43 | panel fasteners |
| **16** | **fastener** (median 7) |

Three conclusions I would not have reached without it:

- **The shut line floor is the second largest thing on the model at 870 px.** I
  spent three rounds treating it as fine detail. "0% off-panel area" on an 870 px
  surface explains the critic's "drawn outlines" completely and immediately.
- **The panel lip is 54 px at its largest and 20 px median, across 240 parts** —
  at or below the 56 px Car demonstrated reads. I spent a round tuning its height,
  thickness, proudness and paint. It is a candidate for **deletion**, not tuning.
- **Base splash is 180 px, three times the reading threshold.** So its weak
  legibility is a contrast fault and must not be answered by making it bigger —
  which is why the fix was albedo and winding rather than size or alpha.

## Nozzle scuff, isolated

Same-build `?pscuff=0`: **max 7 luma, top tile +0.65 over 33% of pixels**, sign
positive as designed. Present, correct, and below legibility. Not claimed as
answering "smooth and plastic".

Also removed: the weep roughness injection from last round. Its range was 0.97 to
0.995 because the material's base roughness was already 0.97 — a 2.5% span,
invisible by construction. The roughness cue it was meant to add already exists
as the step between this material at 0.97 and the panel at 0.34.

## Cost

`tris:101232`, `meshes:78`, unchanged across all rounds this session. Every change
was an attribute, a channel, a winding, an offset or a colour.

## Not reached

- `contactShadow.ts` for the bollard bases — **deliberately not adopted yet**, per
  the note that line 196 holds a baked constant standing in for lost ambient
  while the environment moved 1.0 → 2.4. Pulling after Car's coupling lands.
- The two sub-1.0 `envMapIntensity` values (`seamMat` 0.1, `weepMat` 0.55) are
  left untouched for the dedicated retirement round rather than tuned.
- `panel lip` deletion, which the ranking now argues for and which needs a
  same-build A/B to confirm nothing is lost.
- Cosmetic: the harness prints `4/2 screenshots` when `--ab` doubles the job list.

---

## Round `2026-08-29T032459Z-86cb5549721e` — the ranking reordered the backlog, and then corrected itself

Measurement rounds `2026-08-29T030901Z-16f526e30186` (three arms, one build:
reference, `pseam=0`, `plip=0`) and nomination round
`2026-08-29T032459Z-86cb5549721e` (pump_close, unit1, hose, wide). GPU verified
per shot from the live context, `__SYSTEM_ERRORS` empty, all four frames archive-clean.

### 1. The shut line floor is not the defect, and the 870 px was a bounding box

Ranked second largest on the model at 870 px with 0% off-panel area, which is a
complete explanation for "drawn outlines" — so it was the right thing to put
first. Both halves turn out not to hold against the current build.

- **Visible area: 6,729 px, 1.8% of the bounding box.** It is one flat slab per
  face behind lapped plates standing proud of it, so only the gap-width slivers
  are ever seen. Measured by removing the mesh (`?pseam=0`) in the same build and
  counting the pixels that change — no regions picked, occlusion included free.
- **Its tone is not uniform: p90/p10 = 7.16, cv 0.687**, mean darkening rising
  25.6 → 65.7 down the cabinet. "Uniformly dark" is a claim about variance, and
  measured as variance it is false. The formed returns from two rounds ago did
  this; the question had never been asked in the form the complaint was made.

Its contribution is the largest of any part I isolated: mean |dLuma| 0.212, peak
146 luma. **No change made.** Darkening it further or giving the slab sides would
be tuning against a satisfied measurement.

### 2. Panel lip deleted

Two instruments agreeing in different currencies, then the sign deciding it:

| | panel lip | shut-line backing |
|---|---|---|
| mean \|dLuma\| | 0.013 | 0.212 |
| frame changed | 0.1% | 0.6% |
| best tile | **+0.27** | −3.59 |
| triangles/unit | 1,440 | 464 |
| apparent size | 54 px max, 20 px median | — |

One sixteenth of the effect for three times the triangles, and the sign is
positive: its only measurable contribution was a **brightening peaking at 73
luma** — the "thin bright rods" the critic named twice. At 54 px it is at or below
the 56 px floor, so no tuning could have made it read as a formed edge while it
stayed bright enough to read as a rod.

**Cost, as asked:** each panel joint's top edge loses its only specular cue. That
job now belongs entirely to `plateReturns` (33°–75°), which is where the 7:1
variation above comes from — tone from slope rather than from paint and
proudness. **Delta: −4,320 triangles and −3 draw calls** across the island;
`lipMat` is gone. Parts manifest 558 → 438, still 0 unnamed.

### 3. Base splash — the reasoning, kept visible

The splash measures **180 px, three times the 56 px floor**. That number is why
the four fixes it needed were burial depth, alpha-map channel, winding and
albedo, and why *size and alpha were never candidates*. A 180 px surface that
cannot be seen is not too small and not too faint; it is occluded, culled, or
tonally identical to its surroundings. The measurement chose the class of fix
before any pixel was inspected, and all four causes turned out to be in that
class. Had it measured 20 px, enlarging it would have been the correct first move.

### 4. Injection audit

Generalised from the weep roughness removal by pairing every material's authored
base roughness against the range its injection can reach: `grout` (base 0.95) and
one material at base 1.0 receive a grime pass that *adds* up to 1.06 and clamps
immediately. Albedo arms still work, so these are partly inert rather than dead —
which is how they survived review. Not changed; recorded in `NOTES.md` as a class
worth sweeping repo-wide the same way.

### Harness

- **`--ab` is repeatable.** `--ab=pseam=0 --ab=plip=0` gives three arms from one
  process, one bundle, one browser, so every pair is drift-free — including
  arm-versus-arm. This is the fix for the `+6.27` misattribution.
- **Visibility controls prove themselves by naming meshes.** `?pseam=0`,
  `?plip=0`, `?pweep=0` remove meshes outright, and the harness echoes the pump
  sub-meshes present in the live scene and hard-fails in both directions —
  present under `=0` means the control failed, absent without `=0` means the arms
  are the same scene.
- That second check fired on a good round the moment the lip was deleted, being a
  true statement about a part that no longer existed. Removed with the part;
  written up, since any bidirectional control check has this end-of-life.

### Not reached

`contactShadow.ts` for the bollard bases, still held for Car's coupling to settle
so the line-196 ambient constant is not inherited. The two sub-1.0
`envMapIntensity` values are kept for the retirement round.

---

## Round `2026-08-29T033623Z-8832e37b12f3` — the display judged as an interaction, and the pump judged as a photograph

### 1. The price head reads, and the number that says so is the stroke width

New pose `read` and new tool `tools/pumpread.mjs`. Both ends of the camera are
**published values rather than typed coordinates**: eye at `standPosition`, which
is what `InteractionSystem` measures abandonment from, target at
`displayCentre`, which is the aim point for the click. It is the game's own
opinion of where a body stands to fuel, so it cannot drift away from the
interaction it is meant to judge.

At that stance, eye-to-glass 0.786 m looking 14.7° down onto the panel:

| row | digit height | stroke |
|---|---|---|
| SALE $ | 124 px | 13.0 px |
| GALLONS | 116 px | 12.3 px |
| PRICE / GAL | 80 px | 8.3 px |

The stroke is the number that decides it — a 7-segment digit is read from its
strokes, and under about 1.5 px a stroke is filtered away however bright it is.
The thinnest is 8.3 px, **five times any plausible floor**, so per the rule this
project now uses: *if it is above the floor the fix is contrast, not scale*, and
nothing about the digit sizes was touched.

The same arithmetic defends the canvas resolution, which Perf may care about:
1024×512 against a 439 px panel is **1.17 canvas px per screen px**, so halving
it to save bandwidth would go visibly soft. Verified in pixels: the head reads
`SALE $ 3.18 / GALLONS 0.91 / PRICE 3.499`, arithmetically consistent
(0.91 × 3.499 = 3.184), with unlit segments visible as dim ghosts and grade 87
lit.

### 2. The ticking is mechanical by construction, and it is measurable on the CPU

"Mechanical rather than a smooth counter" is a claim about the sequence of
strings the head shows, so no browser is needed: same flow model, sampled at
`DISPLAY_HZ`, formatted by the same formatter.

- **SALE cents step by {0,1,2,3,4}, mean 2.98** — never a constant +1. At 9.2 GPM
  and $3.499 the cents outrun an 18 Hz redraw, so the digit jumps, which is what
  a real register does.
- **GALLONS hundredths step by {0,1} and hold on 15% of redraws** — irregular,
  not a ramp.
- Tick rate ramps 0 → 6.9 Hz with the spin-up, and both digits and sound are
  integrated from the single `flow` variable, so they cannot drift apart.

### 3. For Perf, since a 20-second moving capture was mentioned

While a fuelling session runs: **18 redraws/s × 1024×512 RGBA = 36 MB/s of
texture upload**, bounded to the session and capped by `DISPLAY_HZ`. Per redraw
one radial-gradient object plus paths are allocated — modest GC pressure, no
pooling. **Nothing recompiles**: a `CanvasTexture` re-upload does not rebuild a
program, and no material or geometry changes during the animation. Idle cost is
zero, because `set()` only redraws when a value actually changed.

### 4. The glass under dawn light

Measured on the frame by separating lit amber from everything else by chroma
rather than by a hand-drawn box: **digits mean luma 184.5 (p95 216) against 119.4
(p95 169) for the rest of the frame — a ratio of 1.55.** The head is the
brightest thing in a frame whose steel is catching a low sun, which is what had
to be true or the display would read as a dark sticker. The cover glass carries a
25.5-luma gradient rather than being an inert transparent plane.

### 5. Judged as a photograph, and one eyeball read I withdrew

At walking distance it reads as a fuel pump in morning light: the silhouette and
proportions the critic protected are intact, the head is legible and correct, the
hose sags with a real kink, the nozzle sits nose-down in its boot, grime is
concentrated low and the key is warm against cool shadow. **The lip deletion is
visible as an absence — there are no bright rods on the panel joints.**

I then read the seams as *light* hairlines, which is the same complaint in the
opposite tone, and measured it before reporting it. A whole-frame ridge detector
(1–3 px lines brighter than both flanks) gives **p90/p10 = 8.25 and chroma +16.6
R−B**: neither uniform nor sky-lit, but sun-catching returns of varying angle.
Withdrawn — the same three numbers that vindicated the dark seams vindicate
these, and an eyeball was wrong about the same geometry twice in opposite
directions.

**Verdict: yes.** Remaining reservations, stated rather than fixed, both
refinements rather than defects: the upper cabinet and head are cleaner than the
lower half, with no hand-contact wear at the keypad or boot mouth, and the red
band has no chipping or fading.

### Harness and tooling

- `read` pose and `--fuel=<seconds>`, which integrates the sale with
  `InteractionSystem`'s own constants and echoes what the head ended up showing.
  It sets values through the published face handle, which is a weaker claim than
  a running session, and the log says so.
- **`tools/pumpscale.mjs` now documents its own upper-bound limitation** in its
  header, with the 870 px versus 6,729 px case and the instruction to treat its
  output as a list of parts to ask about rather than a list of areas.

### Not reached

`contactShadow.ts` for the bollard bases, still held for Car's coupling. The two
sub-1.0 `envMapIntensity` values remain for the retirement round. Nothing was
done about Lighting's finding that the terrain surface never casts — the bollard
and island bases sit on it, so if that changes their contact will change with it.

