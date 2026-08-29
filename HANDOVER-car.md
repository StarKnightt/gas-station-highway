# Car — handover

> **SESSION OF 2026-08-29, PART TWO. Read this block first.**
>
> Latest round: **`2026-08-28T210000Z-7b49a22796c5`** (normal) with its mask
> **`2026-08-28T210222Z-7b49a22796c5`**. RTX 4060, `__SYSTEM_ERRORS` empty,
> zero projection fallbacks, `unnamedMeshes: []`.
>
> ## The arch column, finished and measured
>
> Four masked pairs this session, each one change, each captured either side on
> the same bundle. Every number below is `tools/carmask.mjs` on a normal capture
> using a `?cardebug=arch` capture of the same pose as a per-pixel region mask.
>
> | median display luminance | broken albedo | source-fixed albedo | + liner shadow | + tyre env |
> |---|---|---|---|---|
> | tyre | 1.1 | 3.1 | 3.1 | **10.7** |
> | arch liner | 29.9 | 29.9 | **6.3** | 6.3 |
> | arch lip | — | 16.9 | 14.8 | 14.8 |
> | body panel | — | 13.1 | 13.1 | 13.1 |
>
> | median step across the shared edge | source-fixed | + liner shadow | + tyre env |
> |---|---|---|---|
> | lip \| liner | 7.4 | **14.6** | 14.6 |
> | liner \| tyre | 12.7 | 8.5 | **18.8** |
> | body \| lip | 9.1 | 9.5 | 9.5 |
> | body \| liner | 11.3 | 9.0 | 9.0 |
> | body \| tyre | 10.7 | 10.2 | **3.2** |
>
> The ordering is now physically possible for the first time. It was liner 29.9
> over body 13.1 over tyre 3.1 — a surface deep inside a wheel arch was the
> brightest thing in the frame. It is now lip 14.8, body 13.1, tyre 10.7, liner
> 6.3. The liner's own interquartile range went 9.5 → 20.1, so it stopped being
> a flat bright band and became a gradient: shadowed at the crown, open at the
> mouth.
>
> **One boundary went the wrong way and it is the honest headline.** body|tyre
> collapsed from 10.7 to 3.2, because lifting the tyre to 10.7 brought it up
> alongside the body panel at 13.1. That is not the tyre being wrong — it is the
> body panel being dark, and the body panel is paint, which is blocked pending
> Lighting's PMREM. I did not tune the tyre back down to manufacture a contrast
> number, because that would be choosing the measurement over the thing it
> measures.
>
> ## The tyre: the answer changed once the base was corrected
>
> Pumps fixed `makeTyreSkin` at source (delivered reflectance 0.0070 → 0.0781
> mean, the 0.055–0.09 the call site always claimed), and the 5.4× car-side
> compensation came straight back out the same hour. **On eleven times the
> albedo the tyre's median moved 0.0 → 3.1.** So albedo was real, was necessary,
> and was never the dominant term.
>
> What settled it was the control that had never run: **`?cardebug=tyrelit`**
> puts a plain 0.5-albedo rough dielectric in the tyre's exact mesh, same pose,
> same shadow flags, one variable. It rendered at a median of **68.1**. Light
> was reaching the arch in abundance the whole time. 68.1 against 3.1 is 63× the
> radiance for 6.4× the albedo, so about **10× was the material discarding
> light**. The largest single piece was `envMapIntensity: 0.42`, which is not a
> measurement of anything — a rough dielectric does not reflect less of its
> surroundings than it reflects. Restoring the default of 1.0: 3.1 → **10.7**.
>
> Roughly 3× is still unaccounted for and it is in the grime patch (`film`
> 0.20–0.46 toward `0x24252a`, `baseDark` 0.24–0.36). That is the next tyre
> lead, and `tyrelit` is the instrument for it: it is cheap, it now works, and
> it brackets any material question in one capture.
>
> The earlier `__SCENE_READY` timeout on this flag was transient. It captured
> first try tonight on the same flag. Do not treat it as a property of
> `tyrelit`.
>
> ## Scene-wide winding check, shared, built and passing
>
> **`tools/probe-unseen.mjs --selftest`.** Nothing in it is car-specific; pass
> your own `--port` and `--build-dir`. It asks, for every mesh in the scene,
> *does removing this mesh change a single pixel* — real scene, real materials,
> `visible` toggled, frames differenced — which is the definition of visible
> rather than a proxy for it, and therefore holds for alpha-cut foliage and
> vertex-displaced billboards too. No debug colours, no coordinates from the
> caller. Silent meshes are re-rendered with one property forced at a time so
> the tool names the cause: HIDDEN / WINDING / OCCLUDED / CULLED / DEGENERATE.
>
> First scene-wide run: **342 meshes, zero winding failures.** Full detail and
> the two false-result stories are in NOTES above case 33. Two things to know
> before running it: it refuses to report anything unless two identical renders
> come back bit-identical, and it cannot distinguish a mesh from an identical
> mesh behind it.
>
> **96 of 342 meshes scene-wide are unnamed** and every per-mesh instrument
> prints `<Mesh>` for them. Two were in this car. `add()` now takes a required
> `name` so tsc catches the next one, and `__CAR.unnamedMeshes` is `[]`.
>
> ## The `hardsurface.ts` colour-space finding is closed
>
> Fixed at source by Pumps, audited, and the rest of the file is clean. The rule
> to carry: **a palette from physical reference is linear and must be encoded; a
> palette tuned by eye against renders already is display-referred and must
> not.** They are indistinguishable in source, so measure delivered reflectance
> rather than reading code. The bollard palette at 0.2744 linear is correct and
> must not be routed through `linearToSrgb`. All twelve non-colour maps in that
> file are correctly tagged `NoColorSpace`, so that class is not lurking in the
> shared geometry helpers.
>
> ## Three more silent parts, found by the probe once the meshes had names
>
> Not fixed. Deliberately: these arrived at the end of the session and landing a
> geometry change I cannot verify in pixels tonight is the mistake I avoided
> last session with `receiveShadow`. All three recovered strongly under forced
> depth, so the geometry is fine and the fault is burial, not construction —
> which is the case-33 family again, a third time.
>
> - **`car-rear-plate` and `car-rear-plate-frame`, 0 px each** (recovering 8712
>   and 3582 px forced). These are the two unnamed 2-triangle meshes the first
>   scan flagged. The plate sits at `z = -2.318` and the frame at `-2.312`, so
>   the frame is 6 mm *behind* the plate as seen from the rear, and both look to
>   be inside the bumper. Same mistake as the front plate, and note the front
>   plate's first fix was wrong in the opposite direction: the rim is the larger
>   patch, so standing it proud made it cover the panel and the plate rendered
>   as one blank slab. Panel proud, frame behind, and measure the bumper surface
>   rather than nudging.
> - **`car-sills`, 0 px** (990 forced), and **two instruments agree**:
>   `arch-sill` also reports "surface drew nothing in this pose" in every masked
>   `wheel_close` this session. The sills are the scuffed dark cladding that is
>   supposed to catch everything the tyres throw forward, and they have never
>   been seen. Start here — it is the strongest of the three and it sits in the
>   arch region that is the current priority.
> - `car-arch-liner-0` and `-1` are silent while `-2` and `-3` are not. Mild:
>   the liner's mean normal points into the arch so the probe's camera goes
>   inside, and self-occlusion there is expected. The **asymmetry** is the only
>   reason to look at all. One glance, not an investigation.
>
> `car-headliner` and `car-lamp-reflector` also report OCCLUDED and are almost
> certainly correct as authored — an inner roof skin and a reflector behind a
> lens are meant to be seen through something. Do not "fix" them.
>
> **Unverified observation, not a defect report: 13 vegetation meshes report
> DEGENERATE** (`veg-pine-foliage`, `veg-pine-deadfoliage` and eleven
> `veg-scrub-*`, full list in `.work/unseen-scan2.txt`). Trying three camera
> distances cut this from 25, and the residue is very probably still the probe
> interacting with shaders that fade by apparent screen size rather than
> anything wrong with the foliage — it is plainly present in every capture.
> **Do not hand Vegetation this list as a bug report.** If it is ever raised,
> raise it as "the probe cannot frame these; can you confirm from your side",
> and expect the answer to be that the tool is at fault. The limitation is
> written into `probe-unseen.mjs`'s header under "what this cannot see".
>
> ## `envMapIntensity` sweep of every car material
>
> Asked for after the tyre's 0.42 turned out to be a hand-tuned compensation
> rather than a measurement. Twenty-two values in `CarSystem`. The rule I used,
> which survives the environment being rebuilt again:
>
> **`envMapIntensity` is a physical multiplier and belongs at 1.0. Below 1.0 is
> defensible only as a stand-in for local occlusion the PMREM does not contain —
> a cabin interior, a deep cavity. Above 1.0 is never defensible: it says the
> surface returns more of its surroundings than its surroundings contain.**
>
> Six values above 1.0, all on the shiniest surfaces in the car, which is
> exactly where a dim or flat environment hurts most and therefore exactly where
> someone would have compensated:
>
> | material | value | reading |
> |---|---|---|
> | `clearLens` | **1.7** | unjustifiable; headlamp glass |
> | `reflectorMat` | **1.6** | unjustifiable |
> | `glass` | **1.6** | unjustifiable |
> | `redLensMat` | **1.5** | unjustifiable |
> | `chrome`, `capMat` | **1.45** | unjustifiable; and chrome is pure metal, so this is 45% invented light |
> | `amberLens` | **1.4** | unjustifiable |
> | `paint` | **1.1** | unjustifiable, and the comment already admits the metalness and roughness beside it were "chosen while `envMapIntensity` was inert" |
>
> Five suspiciously low on surfaces that are not enclosed:
> `cavity`/liner **0.28**, `seal` **0.22**, `darkMetal` **0.5**, `brake` 0.7,
> `blackTrim` 0.65. The two interior ones (`clothMat`, `cabinPlastic`, both
> 0.35) I am counting as justified: a cabin genuinely sees far less of the sky
> than the PMREM at the car's origin suggests, and nothing else models that.
>
> **This is a pattern, not a handful of one-offs.** Every metal and every piece
> of glass on the car is above 1.0, and the tyre's 0.42 was the same instinct in
> the other direction. All of it predates a real environment. I have not
> corrected them yet — with the world capture landing the same hour, correcting
> them and tuning paint in one step would confound the two, and the reference
> captures below are what tells me which is which.
>
> ## Paint, against the real environment
>
> Reference materials first, per the brief. `?cardebug=refdiel` puts a 0.18
> grey card in the body shell and `?cardebug=refmetal` puts a clean metal there,
> both at `envMapIntensity` 1.0, no map, no clearcoat, no weather. Five rounds,
> one bundle, `three_quarter_front` and `side_sun`, plus a sixth for the mask so
> every number below is the same pixels.
>
> **The world capture is real and it is structured.** The metal body against
> the sky-only environment reads median 79.5 with an interquartile range of
> **18.6** — a uniform bright dome, as expected. Against the world capture it
> reads median 29.5 with an IQR of **79.7**. Darker on average, because the site
> is mostly ground and building rather than sky, and four times the variance,
> which is the canopy and the pumps actually appearing in the reflection. That
> is the mirror-ball result reproduced from the car's own surface.
>
> **The grey card says there is plenty of light.** 0.18 albedo renders at
> median 112.9 (front) and 146.5 (side). The scene is correctly exposed and
> nothing is being withheld from the body.
>
> **Paint barely moved between the two environments** — 45.6 to 50.1 on
> `side_sun`, about 10%, while the metal moved threefold. So the paint's
> darkness was never the environment. It was the paint.
>
> ### What named it
>
> Absolute numbers did not settle this; a ranking did. In `side_sun` the masked
> body read **45.6** and the masked tyre **78.0** — effective reflectances 0.034
> and 0.047. **The car was darker than its own tyres**, and the tyres were
> brighter than the asphalt they stand on. Neither is a thing that happens, and
> unlike "is 45.6 too dark", neither needs an exposure or a target to argue
> about. It also said which surface to move: two rounds had gone into the tyre
> because the tyre was what looked wrong, and the ranking said the tyre was
> roughly right. Written up in NOTES.
>
> `PAINT` 0x364b62 → **0x516d8c**, the old value scaled 2.2x in linear luminance
> with hue and saturation held, not picked by eye. Body median 45.6 → **68.3**,
> and the car now reads as a painted surface rather than a dark mass.
>
> ### What this did not fix — read this before claiming the boundary
>
> `arch-body|arch-tyre` boundary contrast went 13.2 → **13.6** mean, and the max
> got *worse*, 39.0 → 31.8. **The paint lift did essentially nothing for the
> boundary it was supposed to fix.** The reason is that those boundary pixels
> are inside the arch, in shadow, where albedo is nearly irrelevant and what
> limits the surface is light arriving at the lower flank. The PMREM's lower
> hemisphere is now structured but still dim (mean 0.0100). The arch column is
> a light-transport problem, not a material one, and the next attempt on it
> should go after bounce into the arch rather than another albedo.
>
> ## Not mine: the shadow across the car is badly aliased — for Lighting
>
> Visible in every `side_sun` round tonight and impossible to miss once seen: a
> hard-edged staircase runs diagonally across the doors and rear quarter, with
> steps of roughly 15–25 px in a 1600×900 frame. `probe-zeroscan` reports the
> frame clean — it is not clamped black and not a rectangular block artefact, it
> is a *shadow* whose shadow-map texels are enormous at the car's distance. The
> same staircase continues onto the asphalt below the car, which is what rules
> out any car material as the cause. Crop at `640,300,480,420` on
> `2026-08-28T212826Z-efb0d2daf730/side_sun_paintnow.png` shows it plainly.
> It reads as a smear of dirt on the doors and it is currently the single most
> damaging thing in the car's best pose.
>
> ## The three buried parts — two fixed in pixels, one is not a burial at all
>
> Round `2026-08-28T221038Z-b0a128749d7f` (full six-pose set) and a
> `probe-unseen` pass after the change.
>
> **Rear plate and its frame: fixed, verified in pixels.** They were at
> z −2.318 while the shell's rear surface at that height is at **−2.457** — 139
> mm *inside* the bumper, not a marginal few-millimetre burial like the front
> parts. Moved to −2.468 and −2.462. Both have dropped off `probe-unseen`'s
> silent list and the plate is plainly legible in `three_quarter_rear`.
>
> **The sills are not buried and no offset will fix them.** I raised their
> offset from 1 mm to 14 mm, which was right on its own terms — 1 mm never
> survives this shell's chord-to-arc error, the same thing that ate the grille
> caprail — but they still draw zero pixels. Then I measured the body's
> half-width profile, which settles it:
>
> ```
>   y=0.20   828 mm        sill spans y 0.206..0.290
>   y=0.50   861 mm        sill half-width      871 mm
>   y=0.90   914 mm  <- widest
> ```
>
> **The body is widest at the shoulder and tapers inward all the way down.** The
> shoulder at y 0.90 overhangs the sill by **43 mm**, so the sill sits in the
> body's own silhouette and cannot be seen from any angle above the horizontal.
> Making it visible by offset alone would need a ~57 mm flange, which would look
> like a running board.
>
> **This is worth more than the sills.** A section that is widest at the
> shoulder and narrowest at the rocker is backwards for a car — real bodies
> bulge at the arches — and it plausibly explains the arch problem that three
> sessions have now failed to solve with materials: *the lower flank is dark
> because the car's own shoulder overhangs it by 43 mm and shadows it.* That is
> a light-transport cause with a geometry root, which is consistent with the
> finding that albedo could not move the `body|tyre` boundary. Before anyone
> spends another round on the arch column, consider whether the body section is
> the actual defect.
>
> ## A tool I wrote and deleted in the same hour
>
> I wrote `tools/carproud.mjs` to ray-cast each part against the triangulated
> shell. It reported the sills buried by 1220 mm and the **arch lips** — which
> are visible in every frame — buried by 325 mm, because it took one
> area-weighted mean normal per part and the sills exist on both flanks, so
> their outward normals cancel and their centroid lands inside the car. I fixed
> that with per-triangle sampling and it still called the arch lips 47% buried,
> because parts like the sill's underside return have triangles that face into
> the body by design.
>
> I deleted it. It was right about the flat two-triangle plate and wrong about
> every curved two-sided strip, and that is the worst kind of instrument to
> leave behind — this repo's notes are full of plausible helpers that returned
> plausible wrong numbers. `probe-unseen` answers the same question in rendered
> pixels and was right every time. The independent confirmation is that the
> `?cardebug=arch` mask capture reports `arch-sill 0` pixels, from a completely
> different mechanism.
>
> ## Re-look at the whole car — what is now worth fixing
>
> Composition has changed enough that the old judgements are stale.
>
> Better: the car reads as a painted object; the tyres are no longer tan in the
> rear and side poses; the rear plate, fog lamps and chrome bar are all present;
> the boot shut line reads.
>
> Still wrong, in the order I would take them:
> 1. **The nose is blank.** A large featureless expanse between the lamps and
>    the bumper. The grille aperture is a small dark slot and does not carry it.
> 2. **The lamps are flat rectangles** — no bezel, no glass thickness, no depth.
>    This is the single biggest cheap win on the front.
> 3. **The front tyre still reads pale in `three_quarter_front`** even after the
>    dust reduction, though it is fine in the rear and side poses. Pose-dependent,
>    so measure it in that pose specifically.
> 4. **The body has almost no creases**, which is why it reads soft and melted.
>    Unblocked now.
>
> ## The body section: attempted, reverted, and now much better understood
>
> Rounds `2026-08-28T222136Z-e82bce13e654` (the attempt) and a `probe-unseen`
> pass either side. **The change is not in the tree. The diagnosis is, and it
> is sharper than it was.**
>
> The change was the obvious one: `sillXAt` from `hipX − 0.072` to `hipX − 0.026`
> and the mid-flank setback from 39 mm to 14 mm, holding the widest point at the
> character line so as not to undo the documented crease fix in `lineXAt`.
>
> On the profile it did exactly what it should:
>
> | | before | after |
> |---|---|---|
> | lean, shoulder → rocker | 86 mm | **40 mm** |
> | section y 0.30 → y 0.90 | monotonic taper | near-vertical |
> | sill vs body above it | −43 mm | **+3 mm** |
> | overall width | 1842 mm | 1842 mm |
> | non-finite vertices | 0 | 0 |
>
> **And it swallowed the wheels.** The arches became tunnels, the alloy faces
> disappeared into them and the car read as though it had skirts fitted. The
> lower body moved out about 46 mm per side while the wheel track and the arch
> openings did not move at all, so the bodywork simply overhung the wheels.
>
> Two things worth keeping from that:
>
> **`probe-unseen` caught the regression independently.** Three wheel caps that
> had been drawing went to 0 px in the same pass. That is the first time the
> instrument has found a fault I introduced rather than one I was looking for,
> which is the better argument for running it as a gate than anything I could
> claim for it.
>
> **The lean is not an independent parameter.** The lower body width, the wheel
> track and the arch opening width are one decision. Moving any of them alone
> converts a proportion problem into an occlusion problem. Whoever takes this
> should move all three together, and expect to re-check the arch outline
> parameterisation as well, because `section()` re-bases the lower flank band
> onto that outline. That is a real piece of work, not a constant change, and
> starting it at the end of a session and leaving it half-done would have been
> worse than not starting it. It is all written up on `sillXAt` in `carBody.ts`
> where the next person will actually be standing.
>
> I also stopped pushing the sill offset. It is at 14 mm rather than the
> original 1 mm, which is right on its own terms — 1 mm never survives this
> shell's chord-to-arc error — but it is necessary and not sufficient, and no
> offset short of a running board clears a 43 mm overhang.
>
> ## The fittings are not missing. They do not read.
>
> The critic's list — no mirrors, no wipers, no badge, no trim, no shut lines —
> is the strongest single steer of the night, and checking it before building
> anything changed what the work is. **Every part on that list already exists**
> in `buildTrim`: door mirrors on stalks with a chrome glass panel, two wiper
> arms and blades, a roof antenna fin, door handles with recesses, a beltline
> chrome strip, a nose badge and a boot badge.
>
> So this is a legibility problem, not an absence one, and that is a completely
> different job. Cropping `side_sun` at 3× around the A-pillar shows it plainly:
>
> - **The mirror renders as a tan box overlapping the side glass.** It sat at
>   y 1.155 against a beltline of 1.038 — 117 mm above the belt — so its housing
>   was silhouetted against the DLO instead of against body colour. Fixed by
>   hanging it off `beltYAt` at belt + 34 mm and moving it 60 mm aft off the
>   A-pillar. Geometry only.
> - **It also renders far too light for a 0x191a1b material.** I have *not*
>   touched that, deliberately: Lighting is resolving an ambient regression
>   worth ~23% on shaded elevations, and darkening a material against a known-
>   broken light is precisely the stale-compensation pattern documented in NOTES
>   tonight. Re-measure after Lighting reports.
> - **The door handle reads well.** Worth knowing what already works.
> - **The beltline chrome strip does not read at all** and is the next candidate
>   for the same treatment.
> - **The cabin interior reads as bright tan blocks through the glass**, which
>   cheapens the whole car and is probably a real part of the "clay maquette"
>   impression.
>
> ### The structural reason nobody caught this
>
> `buildTrim` merges everything into **four** meshes by material — chrome,
> black, body, rubber. `probe-unseen` can therefore only ever say "car-trim-black
> draws pixels". **It cannot see an individual fitting at all.** Every one of
> the ~30 small parts that are the entire point of that function is invisible to
> the one instrument built to find absent geometry. The `debugFront` mechanism
> already in `buildTrim` is the right pattern to generalise: route every part
> into a named list, add them individually under a flag, and point the probe at
> that URL. That is the highest-value tooling change left on this system.
>
> ## `probe-unseen` is now a regression gate — shared tooling
>
> `--baseline=<file>` compares a run against a recorded one and **fails on any
> mesh that was drawing and now is not**. `--record` writes the file.
>
> ```
> node tools/probe-unseen.mjs --port=<yours> --baseline=tools/unseen-baseline.json --record
> node tools/probe-unseen.mjs --port=<yours> --baseline=tools/unseen-baseline.json
> ```
>
> Recovered and no-longer-present meshes are reported but do not fail; only the
> transition out of SEEN does. It needs no threshold and no target, which is why
> it is worth having — there is nothing in it to tune or argue about.
>
> **It has been proved to detect, not just to run.** I doctored a baseline to
> claim a known-silent mesh had been drawing; the gate failed the round and
> named it. That test also found a real bug in the gate itself: paths are not
> unique — 362 meshes share only 282 distinct paths — so keying on path alone
> collapsed duplicates last-one-wins and produced two false positives in
> building geometry nobody had touched. Keys now carry an occurrence index.
> A gate with false positives is worse than no gate, because it teaches whoever
> sees it to ignore the output.
>
> Still unproven: back-to-back stability. Run it twice with no edits between
> and confirm zero regressions before trusting it in anger.
>
> This is the third coordinate-free probe in the project, with Building's
> `probe-zeroscan` and `carmask`. They are the same insight from different
> directions: **a probe that takes no coordinates cannot be accused of choosing
> its region, and all of them find absence, which is this project's dominant
> defect class.**
>
> ## `tools/partscale.mjs` — the legibility ranking, shared tooling
>
> `buildTrim` now publishes a **`parts`** manifest: every one of its 19 named
> fitting sites alongside the four merged material meshes. `put()` records and
> routes; `front()` does the same for the aperture surfaces it already named.
> Ten lines, and it removes the information barrier described above.
>
> `tools/partscale.mjs` consumes it. Takes a pose name and no coordinates,
> projects every part into that capture camera and ranks by apparent size,
> ascending, so the least legible part is first. Copied wholesale from
> Vegetation's `vegscale` architecture, including reading the poses out of
> `shootcar.mjs` rather than restating them.
>
> ```
> node --import ./tools/extresolve.mjs tools/partscale.mjs side_sun
> node --import ./tools/extresolve.mjs tools/partscale.mjs --all
> ```
>
> **It answered in one run what I was about to guess at.** In `side_sun`,
> against a car projecting 1549 × 512 px:
>
> | part | px | reading |
> |---|---|---|
> | `beltline-strip` | **732 × 10** | 47% of the car's width and *invisible* |
> | `wiper-arm` | 137 × 40 | large |
> | `mirror-housing` | 89 × 48 | large |
> | `door-handle` | 56 × 18 | **reads well — the calibration reference** |
> | `nose-badge`, `boot-badge` | 15–17 | smallest things on the car |
> | `intake-divider` ×10 | **2 × 17** | 2 px wide; will alias and shimmer |
>
> Two conclusions worth more than the individual numbers:
>
> - **Nothing is too small to read in this pose.** Not one fitting is under
>   6 px. The legibility problem is therefore almost entirely *contrast*, not
>   scale, and the beltline strip proves it: 732 px long and nobody can see it.
> - **56 px reads.** The door handle is legible at 56 px, so any part above about
>   50 px that does not read is a contrast or orientation fault and must not be
>   made bigger. That threshold came out of the data rather than out of my
>   judgement, and it is what stops the next round being a size-tuning round.
>
> ## Detail sized as a fraction of its parent — one found, fixed, unverified
>
> Grepped for it as asked, and there is one. `CORNER_F = 0.34` took the
> rounded-rectangle corner radius as a fraction of the patch's smaller
> half-dimension, so an 11 mm grille slat got a correct 1.9 mm corner and a
> **180 mm headlamp got 30 mm** — not a corner, a lozenge. "Headlights are flat
> rounded rectangles" is what came back from two reviewers. Capped at an
> absolute `CORNER_MAX = 0.009`, because a pressed or moulded corner is a tool
> radius and does not care how big the panel is; small parts keep the fraction
> because 9 mm would consume them.
>
> **CPU-verified only. Not confirmed in pixels** — see the blocker.
>
> ## Blocked at session end: cannot render
>
> `system lighting failed in init: contact-hardening patch failed to install
> (pcss: BASIC branch not found); reverted to PCF`, so `probe-unseen` refuses
> the scene — correctly, that is its "the scene is not the scene" guard. Three
> attempts over about 25 minutes, all identical. Not mine; Lighting is active in
> that file.
>
> Consequently **three things are owed and none are done**:
>
> 1. The gate's back-to-back stability check.
> 2. Re-judging the mirror housing's brightness against the corrected ambient.
>    Declining to darken it against a broken light still looks right, but the
>    re-measure is owed.
> 3. **Re-judging `PAINT` 0x516d8c, which matters more.** It was set to double
>    the body's luminance against a measured grey card, but with the environment
>    term going 1.0 → 2.4 the lit flank will have moved and the paint may now be
>    too light. Do this before any further material work on the car, and use
>    `?cardebug=refdiel` — the grey card is still the right control.
>
> ## Next
>
> 1. **The body section, properly**: lower body width, wheel track and arch
>    opening moved together. Highest value item on the car and the one thing
>    that unblocks the arch column, the sills and the "narrow-tracked" read.
> 2. **Small hard parts, which are cheap and are what "clay maquette" means**:
>    mirrors, wipers, an antenna, a badge, trim strips, a fuel filler, and a
>    bumper that reads as a separate component rather than continuous with the
>    wing. Ahead of brake dust.
> 3. **Lamp bezels and glass thickness** — flat rounded rectangles at present.
> 4. **Creases**, now unblocked, and a shoulder highlight: the reference metal
>    measured an IQR of 79.7 under the world capture against 18.6 under sky-only,
>    so there is structured content for a shoulder reflection to pick up.
> 5. The grime patch's remaining ~3× on the tyre, bracketed with `tyrelit`.
> 2. Tyre contact patch and tessellation, and sidewall detail — the tyre's
>    interquartile range is still only 2.0, so it has almost no internal
>    structure to read even now that it is off the floor. **Report triangle and
>    draw-call deltas**: a performance agent is measuring on 5152 after a
>    browser crash.
> 3. The grille and intake interiors are clean openings onto a flat dark void.
> 4. body|tyre at 3.2 unblocks itself when Lighting lands the PMREM.
>
> ---
>
> **Session of 2026-08-29, part one.** Round
> **`2026-08-28T201132Z-d8bedca8787a`** (`KEEP` in place, 4 poses, RTX 4060,
> `__SYSTEM_ERRORS` empty, manifest written, zero projection fallbacks).
>
> ## The grille edge: found, fixed, verified in pixels
>
> **`endFrame`'s triangles were wound backwards.** Both surrounds — the analytic
> rounded-rect frames that exist for the sole purpose of lapping over the ragged
> cut — faced away from the camera and were back-face culled. They had never
> drawn a pixel. The blocky 22–33 mm edge was the raw quad-level staircase,
> uncovered, for four rounds. Everything the last three rounds measured was true
> and about something else: the hole *is* within 10 mm of spec, the cap *is*
> 48 × 528, the fallback counters *are* zero, and the frames measure **2.5 to
> 4.0 mm proud of the rendered fascia with not one vertex buried**.
>
> Found by doing what the previous handover said to do rather than reasoning a
> fourth time. Every candidate surface gets a flat, unlit, `toneMapped: false`
> colour under **`?cardebug=front`**, so the pixel value in the PNG *is* the
> authored hex; `tools/carlabel.mjs` reads the frame as labels. Zero pixels of
> surround, and the eye meeting fascia directly against the backing panel in
> 134 + 226 places. Written up as **NOTES case 33**.
>
> Verified in pixels, one bundle either side:
>
> | | before | after |
> |---|---|---|
> | grille surround, px drawn | **0** | 17159 |
> | intake surround, px drawn | **0** | 23253 |
> | fascia against grille backing (raw cut visible) | 134 | **3** |
> | fascia against intake backing | 226 | **0** |
> | surround's lower edge, median step between adjacent columns | — | **0.08 px** (p95 1, max 2) |
>
> Confirmed by eye in normal materials too: both apertures are now clean
> rounded rectangles. `nose_close` in the round above.
>
> ## The same probe found four more parts that had never drawn a pixel
>
> All in the nose, all the same underlying mistake in a different guise. **A
> negative offset from a surface is only a recess if something has removed the
> surface in front of it.** The grille backing sits 52 mm back and reads as a
> recess because there is a hole cut in front of it. The same idiom where the
> bodywork is solid is not a recess, it is burial.
>
> | part | was | now |
> |---|---|---|
> | front plate, panel and rim | 65/65 vertices each, 22.0 and 6.0 mm **inside** the bumper | 12.0 / 6.0 mm proud, panel proud of rim so the rim reads as a border |
> | both fog lamps, bezel and lens | 100/100 vertices each, mouth 8.4 mm in, tail 95.1 mm in | surface-mounted pods, 26 mm proud, lens 5 mm inside the bezel lip |
> | chrome bar over the grille | 57/57 vertices, exactly 10.0 mm in | 6 mm proud, narrowed 0.352 → 0.300 so it stops short of the headlamps |
> | nose badge | 14/91 vertices behind fascia teeth inside the mouth | 100 × 48 mm instead of 100 × 62; 3/91 |
>
> The plate's first fix was wrong in an instructive way and is worth not
> repeating: the rim is the *larger* patch, so standing it proud of the panel
> made it cover the panel entirely and the plate rendered as one blank tan slab
> 316 × 128 mm — the loudest thing on the nose. Panel proud, rim behind.
>
> ## Two new instruments, both with selftests that must fail on bad input
>
> - **`tools/carframez.mjs`** — casts a ray at the **triangulated** shell and
>   reports, per front part, clearance in mm and the **area-weighted face normal
>   z**. `tools/carburied.mjs` passes every one of these parts and always would
>   have: it measures against `endZ`, which is the function the parts are built
>   from, so `endZ(...) + off` is proud by `off` by construction. That is a check
>   on the arithmetic, not the geometry. This one consults no analytic surface
>   anywhere. Run it after touching anything on a fascia.
> - **`tools/carlabel.mjs`** (`--selftest`) and **`tools/carmask.mjs`**
>   (`--selftest`). The second measures a *normal* capture using a `?cardebug=`
>   capture of the same pose as a per-pixel region mask, so no region is ever
>   chosen by hand — see below.
>
> `?cardebug=` takes `front`, `arch` and `tyrelit`, is off by default, never
> affects a judged round, and **throws on an unrecognised token** (NOTES case
> 25). Keep it: it is the only thing here that can see a winding error.
>
> ## The arch column: measured properly for the first time, and one finding is big
>
> `?cardebug=arch` flat-colours the five arch meshes; `tools/carmask.mjs` then
> reports per-surface statistics and, more usefully, the **median luminance step
> across each pair's shared edge**, sampled 3 px either side per contact point
> and never as a difference of means. No coordinates are supplied by anyone.
>
> **The tyres render at a median of 0.0 out of 255 over 105416 px, IQR 0.1.**
> Not dark — clipped. Every piece of sidewall relief, bead ring and lettering
> added over the last several rounds has been added to a hole. Cause, measured
> off the texture on the CPU: `makeTyreSkin`'s albedo is **0.0060–0.0086 linear,
> mean 0.0070**, about six times under real carbon-black rubber. The comment at
> the call site claimed "0.055 (tread) to 0.09 (dusty sidewall)" and those are
> the authored **display** values; the map is correctly tagged sRGB, so 0.055
> display is 0.0043 linear. NOTES case 34.
>
> Compensated in `CarSystem` with a linear 5.4× multiplier on `color`, **not
> fixed at source**: `makeTyreSkin` is in `hardsurface.ts`, which this system
> does not own. **This needs reporting to whoever owns that file, and the same
> display-value-as-reflectance mistake may be in its siblings there.** Remove
> the multiplier when the source moves or the tyre is corrected twice.
>
> Verified in pixels, same pose, one bundle either side:
>
> | | before | after |
> |---|---|---|
> | arch lip against arch interior, median step | **2.0** | **7.4** (contacts 29 → 148) |
> | arch lip against body panel, median step | 7.5 | **9.1** (p90 29.2 → 43.3) |
> | arch lip, own IQR | 11.3 | 16.8 |
> | tyre, median luminance | **0.0** | **1.1** |
>
> The lip is fixed and confirmed: its flare went 9 mm → 18 mm, which is case 9's
> rule (the angle a pressing turns through, not its width) and also gives it an
> overhang that throws a mark down into the arch, which under a 6-degree sun is
> worth more than self-shading.
>
> **The tyre is not fixed.** 5.4× of albedo bought 0.0 → 1.1, so albedo was
> necessary and is nowhere near sufficient, and the remaining factor is not
> identified. **Do not treat the arch liner as evidence about the tyre's
> light:** the liner has a *lower* albedo (0x0d0e10) and a *lower*
> `envMapIntensity` (0.28 vs 0.42) and renders **27× brighter**, which is not
> possible under the same illumination. `CarSystem` adds the liner with a bare
> `new THREE.Mesh` rather than through its `add()` helper, so **`receiveShadow`
> is false on the liner and true on the tyre** — a surface deep inside a wheel
> arch is taking the direct sun term unoccluded. That is almost certainly why
> the liner is brighter than the body panel it is recessed behind.
>
> **Deliberately not changed this session.** Setting `receiveShadow` on the
> liner is correct and will make the arch *darker*, collapsing the two boundary
> numbers just improved. Landing that unverified at the end of a session would
> ship a regression on the exact metric this session moved. Do it first thing
> next session, with the masked pair captured either side.
>
> ## Next three steps
>
> 1. **`?cardebug=tyrelit`** is already in the tree and has never produced a
>    frame: it puts a plain 0.5-albedo rough dielectric in the tyre's exact
>    place, one knob, not touching the surface the result is compared against.
>    If a half-white tyre also renders near black the light is not reaching it
>    and no material change can help; if it renders bright the material is at
>    fault. **One attempt timed out on `__SCENE_READY` after 240 s** — the run
>    before and after it on adjacent bundles were both fine, so suspect a
>    neighbouring system rather than this flag, and use `?solo=car` if it
>    recurs. That capture is the whole of step 1 and it decides step 2.
> 2. Liner `receiveShadow`, with the masked pair either side.
> 3. The grille and intake interiors are now clean openings onto a flat dark
>    void — the horizontal slats read as nothing. That is the next thing a
>    critic will name, and it is not blocked.

Owned files: `src/systems/CarSystem.ts`, `src/gen/carBody.ts`, `src/gen/carParts.ts`,
`src/gen/carGrime.ts`, `src/gen/carSkin.ts`, `src/gen/carWheelVary.ts`, `tools/shootcar.mjs`
and the `tools/car*.mjs` diagnostics. Registry handle `car.parked` / `cars` unchanged:
seven keys — `name`, `root`, `position`, `heading`, `size`, `pickables`, `setPaint`.

## BLOCKED — do not touch until told

**Paint, glass, creases, lamp materials and the metalness decision are all blocked**
on the PMREM world capture. `scene.environment` is still a sky-only PMREM whose
**lower hemisphere is a single constant colour (std dev 0.0, range 0.0)** — measured,
not inferred. `buildEnvironment` in `lightSky.ts` (Lighting's file) renders a
two-object scene: sky dome plus one flat-coloured ground disc. The world is never
in it. The world capture exists behind `?worldenv=1` but is off by default.

Proof: set the paint to a perfect chrome (metalness 1, roughness 0) and the car
renders as a **flat tan panel** — `shots/car/env/mirror_r0.png`. A roughness ladder
gives flank range 83.1 at r=0.00 and 50.7 at the shipped 0.42, so roughness is a
second-order effect; there is simply no structure to reflect. Reproduce with
`node tools/carenv.mjs --no-build --isolate-only --env-dump`.

Consequence: metalness only controls how much flat grey gets mixed into the paint,
which is why 0.0 went near-white and 0.36 reads dead. Re-derive it **after** the
world capture lands, not before.

## Ride height — measured, the critic's estimate did not hold
**Still correct: do not drop the body.** The contrast diagnosis in this section
is superseded by the masked measurement in the 2026-08-29 block — the arch
interior is not the dark thing, the tyre is, and it is clipped to zero.


Measured in-frame off `wheel_close`, in tyre-relative units so no camera arithmetic
is needed (`tools/ridemeasure.mjs`). Arch lip at y≈510, tyre top y≈512, tyre bottom
y≈844: **gap ≈ 10 px on a 332 px tyre ≈ 0.03 of diameter.** One sidewall would be
0.195. The claim of "a full extra tyre-sidewall's worth" is out by roughly 6x, and
the nominal 36 mm crown gap is correct.

**The real defect is contrast, not height.** Down that column the body panel reads
17, the arch interior 17, the tyre 6 — the whole span from y=470 to y=512 varies by
about 11 levels. The eye cannot find the tyre's top edge, so it reads the dark mass
as a void. Do not drop the body; this is downstream of the reflection problem.

## Grille — mm/px done, three causes, two fixed
**SUPERSEDED — see the 2026-08-29 block at the top. The "still not fixed" note
below was chasing the backing panel's grid; that was another correct measurement
of the wrong thing. The cause was `endFrame`'s winding.**


`nose_close` is 34° vertical FOV at 2.176 m over 900 px, so visible height is
1.331 m and **one pixel is 1.48 mm**. The 4–10 mm sawtooth is therefore **3–7 px** —
the *opposite* of Pumps' 0.45 px chamfer. Not a sampling problem; a real edge that
is really wrong. Written up in `NOTES.md`.

Fixed:
1. **Reveal walls suppressed** (`APERTURE_REVEAL_WALLS = false` in `carBody.ts`).
   Each cut boundary emitted a 30 mm wall; the bottom one faces up, takes the sky
   and rendered as a bright pale toothed strip 20 px deep in body colour. Removing
   it eliminated the brightest artefact — confirmed in round `…182649Z-62b11a69f23a`.
2. **Analytic surround** — new `endFrame()` in `carParts.ts` lays a rounded-rect
   ring over the ragged boundary; inner edge inside the hole, outer edge on solid
   fascia. Apertures were also shrunk so the staircase sits further under the frame.
   Number plate moved to y=0.682 to make room.

**Still not fixed — this is the next step.** A blocky edge remains, steps of
22–33 mm. The cut itself is *not* the cause: `tools/cutbounds.mjs` measures the hole
at |x| 0.303–0.309 against a 0.305 spec (grille) and 0.450–0.462 against 0.452
(intake), i.e. within 10 mm, and the cap is already 48 rings x 528 spokes. The step
size matches the **backing panel's own grid** — it was 18x6 over a 720x180 mm panel
conformed to a curving fascia, i.e. 40x30 mm facets. Last edits (uncaptured):
backing panels to 44x16 and 52x16, and `blackTrim` dust 0.33 → 0.12 with cool
colours, because a lit grey dust under the orange sun is what made the void read as
"muddy brown noise". **Capture and check `nose_close` first thing.**

## Geometry — done, uncaptured or partly captured

- **Hexagon indicator: fixed and confirmed.** Root cause was `outlineK`, a
  "squared-off ellipse" that is a step function in disguise — at `ny=6` it evaluates
  to 0.06, 0.97, 1.0, 1.0, 0.97, 0.06, i.e. two sloped segments per end. Replaced
  with a true rounded rectangle (radius from the smaller half-dimension in world
  units) plus `outlineV`, which clusters rows toward the ends where the curvature
  is. Retires the old 0.06 degenerate-normal floor. In `NOTES.md`.
- **Stray nub at the right rear: found.** It is the exhaust finisher — an open-ended
  chrome tube with no bore and nothing behind it, so it caught the sun as a bright
  bead. Now has a black inner sleeve starting just inside the mouth, and moved
  inboard to x=-0.42.
- **Tyre silhouette: fixed.** Sipes were cutting 3.4 mm off the outer radius across
  the full width, 47 times per revolution — 1.7 px notches on the shoulder, which is
  the "scalloped polygonal edge". Relief now fades before the tread edge.
- **Tyre:** contact bulge 0.2 → 0.3; `around` 156 → 240; bead ring / rim protector
  added (4.2 mm, continuous, so it survives sampling where 1.6 mm lettering cannot);
  lettering relief 1.6 → 2.6 mm. Arch liner 24 → 56 segments.
- **Door handles:** now derived from `beltYAt(dz) - 0.096` instead of a literal
  1.020, and enlarged to 52x56x172 mm with a deeper recess. Third part in three
  rounds to need the ask-the-hull treatment.
- **Proportions:** measured. Belt was 1.078 on a 1.4585 m car = **0.739 of overall
  height against ~0.707 real**; glass 0.328 = 0.225 against ~0.27 real. Both errors
  push the same way and match the "toy/Hot-Wheels mass distribution" note. Belt
  dropped 40 mm to 1.038 → ratio 0.712, glass 0.368. Roof, rail and overall height
  untouched. **Uncaptured — check the `side` preset.**
- **Boot line:** transverse cuts exist at z=-1.362 and z=-2.062. What is missing is
  the pair of *longitudinal* cuts down the sides of the boot lid; `top` cuts die out
  above `upperFlank`. Needs a different mechanism (cutting along the ring direction).
  Not started.
- **Fuel filler:** exists, left rear quarter, laid on the panel via `flankX`.
- **Lamp bezels:** amber repeater now has a perimeter wall and a housing band.
  Tail/head bezel and lens-thickness work **not done** — deliberately, since the
  critic's remaining complaints there are entangled with lens *material*, which is
  blocked.

## Dirt — re-authored, verified on CPU

The old sill term was `smoothstep(0.68, 0.28, y)`, a pure latitude band. It measured
well (19.3% falloff) and read as a shading error because it ignored the arches.
Now each axle throws a plume decaying slowly rearward (1.15 m) and fast forward
(0.42 m); the band's top edge is `0.40 + 0.34 * plume` plus a two-frequency wobble,
so it scallops. `node --import ./tools/extresolve.mjs tools/carweather.mjs`:
behind rear arch **0.739**, behind front arch 0.539, ahead of front arch 0.237,
rocker 0.374, upper door 0.026. Spray fan behind the rear axle peaks 0.86 and decays
to 0.13 ahead of it.

**Brake dust** is now chromatic, not a darkening: dust and film colours lerp from
neutral grey on the rears to warm iron brown on the fronts, keyed to `v.brakeDust`,
so the rears cannot go bronze by construction. A 30-point luminance split was read
as "four copies, identical and clean".

## Tooling added

- `tools/extresolve.mjs` + `extresolve-hooks.mjs` — Node resolver hook for the
  extensionless relative imports across `src/`. **All CPU diagnostics now need
  `node --import ./tools/extresolve.mjs …`.** Touches no source; the pattern is back
  in `hardsurface.ts`, `textures.ts`, `veg*`, `building*`, `audio/*`, `LightingSystem`.
- `shootcar.mjs` now reads back the PMREM and **fails the round on any non-finite
  texel** before spending a capture, with a message pointing at Lighting.
- `tools/cutbounds.mjs`, `tools/ridemeasure.mjs`, `tools/crop.mjs`, and
  `carenv.mjs --env-dump` (PMREM dump + chrome-at-roughness ladder).

## Rounds

- `2026-08-28T181755Z-dd8949c3b78d` (t5) — first with the geometry work.
- `2026-08-28T182649Z-62b11a69f23a` (t6) — reveal walls suppressed.
- `2026-08-28T183337Z-088de0d2cbe2` (t7) — widened surround. **Latest captured.**
- t8 (darker void, finer backing panels) was interrupted — **not captured.**

`framescan` over t5 found one cool inversion in `side.png` rows 396–427 (R−B −4.6
against +11.4 above). That is the scene fog band already routed to Lighting.

## Exact next three steps

1. Capture (`node tools/shootcar.mjs --tag t8`) and check `nose_close` — does the
   blocky grille edge go with the finer backing panels and the darker void? If not,
   the remaining suspect is the backing panel's silhouette against the hole; colour
   it distinctly for one throwaway round to identify the surface rather than guess
   again. Three rounds have now been spent guessing at this edge.
2. Check the `side` preset for the 40 mm beltline drop, and `wheel_close` for the
   tyre bead ring and contact bulge.
3. Boot lid side cuts — the only fully unbuilt item that does not depend on the
   environment.

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

# Session: the two thresholds, and 34 parts with no sides

## Read this first: the two numbers that should govern the next round

Both came out of `tools/partscale.mjs` run over all 41 fittings, not out of
judgement, and together they rule out an entire category of wrong fix.

1. **Nothing on the car is under 6 px.** There is no fitting whose size is
   disqualifying, so **the legibility problem is contrast and orientation, not
   scale.** The beltline strip settles it beyond argument: 732 px long, 47% of
   the car's width, and nobody can see it.
2. **56 px reads.** The door handle is 56 px and it is the one small fitting no
   reviewer has complained about, so that is a floor with an observed witness
   rather than a guessed one. **Anything above roughly 50 px that does not read
   is a contrast or orientation fault and must not be made bigger.**

"Make it bigger" is the reflex, the critic's language invites it, and it is
wrong for every fitting on this car bar one (see the dividers below). Do not
reach for size without checking these two numbers first.

## The mechanism: 34 of 67 trim parts were surfaces with no sides

`partscale --relief` is new and measures, per part, the fraction of surface area
whose normal points more than 60 degrees off the part's mean normal — in plain
terms, **does this part have sides at all**. For 34 of 67 the answer was zero.

They are ribbons. `flankStrip` and `endPatch` build a surface *offset from* its
parent with no walls joining it back, so every triangle faces the way the panel
faces, the part shades exactly as the panel shades, and it is invisible at any
albedo in any light. What makes a real trim strip visible is **the pair of lines
it creates** — a highlight along its upper return, a shadow along its lower —
and a strip with no edges creates neither.

The correlation with legibility is the finding: **the parts that read are the
parts with walls, and size predicts nothing.** Door handle, mirror, wipers, fog
bezels — closed solids, and they read. Beltline strip, badge, plate panel, fuel
filler door, valance, lower bright bar — ribbons, and they are exactly the list
the critic reported as absent. A 56 px solid reads; a 732 px ribbon does not.

**This is the highest-value remaining seam on the car.** Twenty-eight ribbons
are still unfixed and each is a part a reviewer has been calling missing.

## Fixed this session

**Beltline trim: one strip became three.** A proud face standing 8 mm off the
door with an upper and lower return closing it, all three traversed in
increasing `y` so `flankStrip`'s side-dependent winding stays uniform. The
returns are 8 mm tall to match the 8 mm they stand proud — a first attempt gave
them 3 mm, which is 1.5 px on the flank and therefore an invisible fix for an
invisible part. Max facet angle across the section went 45 deg (pure flank
curvature, gradual, no discontinuity) to 103 deg (two real dihedrals).

**Intake dividers: nine flat patches became five walled vanes.** Nine 12 mm
patches measured **2 px wide in the side pose**, and 2 px of near-black on a
near-black backing is a shimmering comb the moment the camera moves. Now five
26 mm vanes with `endBand` skirts. Note what the pose sweep says: in the side
pose they stay 1–2 px *at any width*, because apparent width there is set by
viewing angle, not size. **The wall is the fix in every pose; the width is the
fix in none of them.** Two symptoms, opposite-looking remedies, one cause.

**Corner radius cap.** `CORNER_F = 0.34` of the patch's smaller half-dimension
gave an 11 mm grille slat a correct 1.9 mm corner and a 180 mm headlamp a 30 mm
one — a lozenge, and very likely why two independent reviewers both described
the headlights as "flat rounded rectangles". Capped at `CORNER_MAX = 0.009`,
because **a pressed corner is a tool radius and a tool radius does not care how
big the panel is.**

**Cost: +48 triangles, +0 draw calls.** The divider change is *cheaper* than
what it replaced (1,116 → 780, since five patches plus five 16-step skirts beat
nine patches) which pays for the beltline returns (192 → 576). Everything merges
into the existing four material meshes, so no new draw call.

## `probe-unseen` is now a gate, and it is stable

- Baseline recorded at `tools/unseen-baseline.json`, **364 meshes**.
- Back-to-back stability run: **0 regressed, 0 recovered, 0 no longer in scene.**
  Run it before relying on it after any scene-wide change.
- Two guard fixes, both the shape Terrain found in the zero-dimension capture:
  a bare `--baseline` used to parse to `""` and **silently skip the gate**, so
  the round passed by not being checked; and the probe now rejects a
  non-finite or under-8 px probe size and an empty pixel comparison rather than
  relying on failing safely by accident. *A gate that can be disabled by a typo
  is not a gate.*
- Invoke as `--baseline=tools/unseen-baseline.json`, add `--record` to re-record.
  A run is about 5 minutes.

## Tool caveat, please do not trust past it

`partscale --relief` judges parts **in isolation and is therefore blind to an
assembly.** The beltline trim is three cooperating single-surface strips, and the
arch lip is an outer flare plus a return face; each leaf scores as a ribbon while
the assembly has a real section. So `wall = 0` alone does not convict — check
whether the part has siblings that turn away from it.

Two metrics were tried and are documented as unreliable, in the file itself:

- **A slope ratio from the bounding box.** The first version shipped confident
  nonsense: the beltline strip follows the beltline, which rises along the car,
  so its box reports 85 mm of "face height" for an 18 mm face and 95 mm of
  "relief" for a 3 mm offset. **The box measures the path, not the section.**
  Same class of error that got `carproud.mjs` deleted. Every quantity in the
  tool is now per-triangle or an area fraction.
- **Tilt against an outward-radial proxy.** Reported the door itself as 50 deg
  off, because the proxy ignores tumblehome. The column is printed as raw data;
  do not read its absolute value.

`wall` also under-reports a multi-facet open section, because it measures
deviation from an area-weighted mean and the mean rotates toward whichever facet
grows. For "does this produce a line", the dihedral between adjacent facets is
the sound quantity.

## Verified in pixels vs CPU-only

- **Pixels:** gate stability (364 meshes, two runs); no winding failures
  scene-wide; `car-sills` still `OCCLUDED`, consistent with the unfixed body
  section, and `car-arch-liner-0/1` and `car-headliner` likewise.
- **CPU only:** the beltline and divider geometry changes. Both merge into
  shared material meshes, so `probe-unseen` cannot see the individual parts —
  **this is the merge information barrier and it means my winding claim on the
  three beltline strips is reasoned, not measured.** Capture the flank before
  trusting it.

---

## Correction to the section above: the beltline was culled, not merely a ribbon

Copying Canopy's CPU winding assertion (`tools/probe-canopy.mjs`) into
`partscale --winding` immediately failed **all six beltline leaves**, and the
face used the same edge ordering as the original single strip. So the beltline
trim was **wound inside out and had never been rasterised at all.**

The ribbon analysis was correct and would have made the strip illegible. It just
never got as far as being shaded. **Two independent sufficient causes, and the
fatal one was invisible to the measurement that found the other.** A part
reported absent deserves a culling check *before* a shading analysis: culling is
cheaper to test and strictly more fatal.

**Root cause, and it is a builder bug, not a call-site one.** Work out
`flankStrip`'s winding by hand and the face normal is `(-dz * dy, 0, 0)` — the
sign depends on the direction the *caller* sweeps `z`, which lives in a lambda
the builder never inspects. `buildArchLips` sweeps `z` decreasing and faces
outward. `buildSills` and the beltline sweep `z` increasing and faced inward. The
`side` flip in that builder was necessary and not sufficient, and its comment
claimed winding was handled.

`flankStrip` now measures its own area-weighted mean normal against the
horizontal radial and flips the index buffer if it points inward.
**Near-tangential strips are left exactly as authored** — the sill's underside
return legitimately faces downward, and guessing there would trade a known bug
for an unpredictable one. `partscale --winding` reports the whole set so an
ambiguous strip is visible rather than silently decided.

`--winding` is the only instrument that can see inside a merge. `probe-unseen`
sees `car-trim-chrome` and cannot tell which leaf within it is reversed.

### The sills: winding fixed, still 0 px, so the taper diagnosis stands

Measured after the fix: `car-sills` **still draws 0 px** (677 px when forced).
The sills had *both* defects — reversed winding and genuine occlusion — and
fixing the winding recovered nothing, because the body still buries them. **The
43 mm inverted-taper diagnosis on `sillXAt` is confirmed, not superseded.**

This is also the pixel evidence for a general caution now in NOTES:
`probe-unseen` reported the sills as `OCCLUDED` rather than `WINDING` because it
tries remedies in order, and forcing `DoubleSide` cannot reveal a part that is
also buried. **A probe that names one cause has found one cause.** Re-test after
fixing either.

## Six more ribbons fixed, taken in ranking order

Worked from `partscale`'s apparent-size ranking rather than by judgement. The
pattern is one `endBand` skirt per patch, closing the step between it and
whatever sits behind it, at 12 to 16 outline steps rather than the default 48.

Two carry named critic complaints:

- *"The bumper is body-coloured and continuous with the wing."* A valance 4 mm
  off the fascia with no wall genuinely **is** continuous with the fascia as far
  as shading is concerned — same normal, same light, no boundary. The skirt makes
  the bumper a separate component with geometry rather than with a colour change.
- *"The plate recess is an empty black rectangle."* It was not a recess. A patch
  sunk 20 mm with no wall is a dark rectangle painted on the bumper. The band
  from -0.020 out to the surround is the recess wall, and that wall is almost
  entirely what tells the eye something is set *into* a surface.

Also skirted: `plate-panel`, `plate-rim`, `lower-bright-bar`, `plate-surround`.
Closed solids went 32 to 38, winding failures 0.

**Still ribbons, in ranking order for whoever picks this up:** `intake-backing`
258 px, `intake-frame` 246, `intake-slat` x2 228, `front-valance` face 191,
`grille-backing` 179, `grille-frame` 176, `grille-caprail` 147, `grille-slat` x3
147, then the plate faces and the grille dividers. Get the ranking with
`partscale --relief` joined against any pose.

## The gate earned its keep across system boundaries

The same run flagged, against a baseline recorded 35 minutes earlier:

- `<Group>/veg-pole-insulators` **SEEN -> WINDING** — a real winding regression
  in Vegetation, the same defect class as mine.
- `building/cooler-stock` SEEN -> OCCLUDED
- `<Group>/veg-scrub-grazed-far-0` SEEN -> OCCLUDED
- `building/fixtures` recovered.

Worth routing to those owners. **No car mesh regressed** across the beltline,
divider and skirt changes.

Sibling typecheck errors seen and not mine: `BuildingSystem.ts` (`upReturns`
undefined) and `CanopySystem.ts` (unused `envIntensity`).

## Verified in pixels: round `2026-08-29T001723Z-715973d646a8`

RTX 4060 confirmed in the manifest, `systemErrors` empty, `nose_close` and
`side_sun`.

**The beltline strip reads.** A crisp bright chrome line the full length of the
flank, where three sessions of frames had nothing. Sampling a column across it
gives **four distinct levels in about 8 px — 151, 121, 90, 17** — against a
single flat value before. That is the pair-of-lines mechanism doing exactly what
the first-principles argument said it would, and it is the first thing on this
car whose fix was predicted from geometry before any capture existed.

**The nose skirts read.** Grille slats now separate from the backing as bars
rather than stripes, the caprail reads as a bar rather than a stripe, and the
plate has a rim with an edge. The mouth reads as a recess.

**Two new defects visible in these frames, neither mine, both worth routing:**

1. **The tyres are tan again.** Clearly light beige in `side_sun`, close to the
   value they had before the `makeTyreSkin` colour-space fix, and the wheels with
   them. This was believed fixed. Something has re-introduced it — a dust or
   grime term applied scene-wide is the obvious suspect given `groundAccum` has
   just landed. Do not compensate in `CarSystem`; that is the stale-compensation
   trap and this exact material has already been through it once.
2. **A soft-edged pale rectangular patch on the near door and rear quarter**, and
   a small black angular artefact at the A-pillar in `nose_close`. Both read as
   shadow or projection artefacts rather than car geometry. PCSS was repaired
   this hour, so a fresh cascade artefact is plausible.

---

## The tan tyres: named, and it is not the material. Do not compensate.

Asked to say which of three causes it was before changing anything. It is the
third: **the corrected ambient is revealing it differently.** Evidence, in order
of strength:

- **The value did not regress.** `makeTyreSkin`'s `linearToSrgb` encoding is
  intact and the delivered albedo measures **0.0828 mean linear on the sidewall,
  R-B −0.0013** — squarely in the 0.055–0.09 the call site claims, and *neutral
  to slightly cool*. CPU-measured off the generated texture, not read off the
  source.
- **Nothing downstream overrides it warm.** The grime unit is passed a cool film
  (`0x24252a`) and a neutral dust (`0x4a4b4e`), and `varyColour` cannot produce
  warmth from those: at the base's saturation of 0.026 a hue rotation moves R−B
  by at most about 4 counts.
- **The substitution control settles it.** `?cardebug=reftyre` is new and puts a
  plain 0.18 neutral grey card in the tyre's own mesh — no map, no grime, no
  tint. It renders at **R−B +44 against the real tyre's +40.** A neutral card in
  that position comes out *warmer than the tyre*. The warmth is entirely the
  environment.

The mechanism: a roughness-1.0 sidewall facing sideways integrates the lower
hemisphere, which at environment 2.4 is warm sunlit desert, while the asphalt
faces up at the cool sky and the paint is too smooth to integrate much of either.

**What is left is a question for Lighting, not for this system.** A real tyre at
dawn does pick up warm ground bounce, so the hue is defensible; what is not
obviously defensible is the magnitude — the sidewall reads lum 72 where the
asphalt beside it reads 38. Any fix belongs in the lower-hemisphere magnitude.
**Do not add a cool tint or lower the albedo here** — this exact surface has been
through the compensation trap once and the compensation outlived the bug.

Withdrawn along the way: an earlier argument that ranked the tyre against the
asphalt and the paint. Invalid, because those three differ in orientation and
roughness as well as material, so the comparison had three confounds. **A ranking
is only valid between surfaces differing in the one variable under test.**

### The 18 surface-projection fallbacks are not mine

`shootcar` exits 1 on them and it should. `probe-fallbacks` attributes all 18 to
**`buildLamps`**; `buildTrim` is at 0, so the skirts and the beltline are on the
real fascia. Pre-existing, still worth fixing: the named placement is the exhaust
finisher, off-cap at `x=-0.500 y=0.352`, needing to move **up 7.4 mm**.

Fixed one regression of mine in a shared tool: `carburied.mjs` reported
`trim.parts MISSING GEOMETRY`, because the per-part manifest I added to
`TrimBuild` is an array of named geometries rather than a merged bucket. Skipped
now, alongside `debugFront`, for the reason already in that file — a tool that
cries wolf on correct output gets ignored.

### Correction to the beltline numbers reported earlier

The "four levels in 8 px — 151, 121, 90, 17" figure was measured with coordinates
read off the 1024-wide *display* of a **1600x900** file, so it sampled the
A-pillar rather than the beltline. The correctly located profile at x=700 is
better than the wrong one: dark glass 41, then **highlight 156, shadow 99**,
against a body panel settling at 127. A symmetric pair straddling the panel value
by +29 and −28 across about 6 px, which is exactly the mechanism the
first-principles argument predicted. Read image dimensions before trusting any
pixel coordinate.

## Still owed, in priority order

1. **Re-derive `PAINT` 0x516d8c with the grey-card method.** It was set against
   a measured grey card when the environment term was 1.0; that term is now 2.4,
   so the lit flank has moved by a factor nobody chose and it may now be too
   light. This is *not* the stale-compensation pattern — the method was correct
   and a constant under it changed — so re-deriving is required, and by
   measurement rather than by eye. `?cardebug=refdiel` puts a 0.18 linear card
   in the body mesh; `?worldenv=0` gives the sky-only A/B.
2. **The 28 remaining ribbons.** Ranked in `partscale --relief`. Each one is a
   part a reviewer has called missing.
3. **The body section.** Diagnosis stands on `sillXAt`: the body is widest at
   the shoulder and tapers inward to the rocker, which is backwards, and it
   shadows its own lower flank by 43 mm. A coupled three-parameter change —
   lower body width, wheel track, arch opening are one decision — so do it with
   a clear head. A previous attempt satisfied the profile measurement fully
   while making the render worse.
4. Glass: separated additive reflection layer at F0 0.043, copying Building's
   architecture rather than rediscovering it. Then creases, lamp bezel and glass
   thickness, tyre contact patch and sidewall detail, dirt driven from arch
   distance and airflow, chromatic brake dust.

**Retired, do not satisfy:** any gate asserting warmth in shadow. The warm cast
came from the old ground disc, which was 7.6x too bright and 12x too warm. Warm
key against cool shadow is dawn; uniformly warm shadow is a preset.


---

## Round: paint re-derivation, contact shadow, groundAccum, glass

Rounds: 2026-08-29T010606Z-17b6154e42de (paint arm),
2026-08-29T011059Z-17b6154e42de (grey-card arm, same bundle sha1).

### 1. PAINT does not need re-deriving. Leave 0x516d8c alone.

Method: a neutral 0.18 linear grey card substituted into the body mesh, both arms
captured from ONE bundle, region defined by the pixels that changed rather than by
hand. tools/greycard.mjs does the derivation and is reusable by any system with a
substitution flag.

    grey card at 0.18   linear RGB 0.3408 0.2126 0.1429   lum 0.2348
    paint               linear RGB 0.1027 0.0976 0.1140   lum 0.0999
    rendered per unit albedo 1.3045
    => delivered paint reflectance 0.0766 luminance
       paint reads at 0.425x an 18% grey card in the same frame

A mid-dark blue-grey automotive colour coat sits at 0.05-0.15 linear. Delivered
0.0766 is inside that, and reading at 0.43x an 18% card is what a mid-dark blue
should do. The hypothesis that the paint became too light when the environment
term went 1.0 -> 2.4 is NOT supported. Authored albedo is (0.082, 0.153, 0.262)
and delivered is (0.054, 0.083, 0.144), i.e. 54-66% of authored, which is the
clearcoat taking energy off the base layer, not a colour-space error - that class
shows up as a factor of six, not of two.

### 2. FOR LIGHTING: a neutral card in the car flank renders 2.4x more red than blue

The strongest number this round, and it is not a car number. The grey card is
neutral by construction - 0.18, 0.18, 0.18 written as a linear triple precisely so
its reflectance is not in question - and it renders R 0.3408 against B 0.1429.
R-B = +0.198 on a surface with no colour.

Consequence for the car, quantified: authored paint R-B is -0.180 and delivered
R-B is -0.089. The illuminant is removing half the blue from a blue car. This is
the same lower-hemisphere story as the tan tyres, now measured against a
known-neutral reference in the car's own mesh rather than inferred. Changing
nothing on the car for it.

### 3. Contact shadow: src/gen/contactShadow.ts, shared not car-specific

PumpSystem.ts:137 has a TODO waiting for this; bollards and column bases want it
too. Pass your own occluders rather than copying the file.

The argument for why it is not a shadow-map job is in NOTES: at 6.2 deg sun
elevation the sun term is saturated across the entire footprint, so it carries no
contact information. The missing cue is sky occlusion, which nothing in a forward
renderer computes. A correctly shadowed scene can still have every object looking
pasted on.

The load-bearing design choice: falloff length comes from the GAP, not the
object's size. Tyres touch (gap 0) and get a tight near-black core; the floorpan
floats at 155 mm and gets a wide weak wash. Same radius for both is the airbrushed
oval that reads as a decal. Elements combine multiplicatively on remaining sky
rather than additively on darkness, or the overlap directly under the car goes
black.

Parented to this.group, not to car, because car carries a fitted pitch and roll -
the same trap as the baked tyre contact patch rotating off the ground. Neither
casts nor receives shadow: it stands in for ambient, so routing it through the
shadow pass would delete it exactly where it is needed.

### 4. groundAccum adopted, and the probe changed the design

Probed the range over the car's own stall BEFORE writing anything against it,
per Building's contract warning:

    fines  0.1334-0.1760  span 0.0426     <- level only, not pattern
    swept  0.0000-0.0049                  <- not wired up
    grime  0.0000-0.0000                  <- not wired up
    lee    0.0000-1.0000  span 1.0000     <- the only usable pattern term

A site-scale field is nearly flat across a 2.1 x 4.9 m object. fines supplies a
LEVEL (how dirty this lot is) and cannot supply a PATTERN; driving per-panel
variation from it would be a literal wearing a citation. Eight film/dust levels
now go through dirt(floor, gain) = floor + gain * lotDirt, normalised to the
measured 0.133-0.176 and clamped, so a Terrain reshape degrades to an endpoint
instead of extrapolating off a contract it no longer has. Chosen so lotDirt = 0.5
reproduces the old literals, making the adoption neutral at the measured centre.

Still owed: lee is the term that carries the sheltered-flank pattern, and using it
needs the weather baker to sample world position per vertex. Not done.

### 5. Glass: black diffuse, half the fix

color 0x1c2226 -> 0x000000. Alpha blending computes src*a + bg*(1-a), and with a
tinted colour the src term carries a lit diffuse veil that glass does not have.
At a=0.62 the surface was adding 62% of a lit dark blue-grey over whatever was
behind it - which is exactly "a uniform dark tint slab", and it does not vary
with what it covers. Now the blend is reflection + bg*0.38: pure transmittance at
38%, and the interior geometry should be visible through it.

Owed: the reflection is still multiplied by a along with the rest of src, so it is
dimmed by the same 38%. Building's separated additive layer at F0 0.043 is the
remedy and also fixes the anti-correlation with viewing angle.

### 6. Eighteen lamp fallbacks, found and fixed - the probe was looking elsewhere

These had been gating captures. probe-fallbacks named the wrong parts because its
placement list was a set of literals COPIED from call sites: it tested headlamp
bowl inner (0.429, 0.828) and outer (0.597, 0.828), both of which pass, while the
real sites were (+-0.71, 0.91) overhanging by 9.5 mm.

Fixed in the builder: FALLBACKS now records {x, y, front, over} per hit, capped at
64. over is the distance past the outline, which is the number the remedy needs.
A count without a location is not actionable, and the workaround for a missing
location is a duplicated constant that goes stale.

The defect itself: the headlamp shut line was built as HW + 0.015 / HH + 0.015 -
the lamp footprint plus a 15 mm margin - and the lamp footprint had been tuned to
exactly reach the cap limit. A margin added around a footprint tuned to its limit
overhangs by that margin. Shrank the margin to 8 mm rather than the lamp, because
two reviewers have called the headlamps featureless and shrinking the lens to make
room for its own panel gap would satisfy the probe while fighting the brief. All
six builders now report zero fallbacks.

Exhaust finisher also fixed: clearance 10 mm -> 22 mm above the cap lower edge.

### 7. BLOCKER FOR EVERYONE: .shot-build/ is being emptied by a sibling

The final verification round failed with ERR_HTTP_RESPONSE_CODE_FAILURE because
.shot-build/car/ had been deleted mid-session. ls .shot-build/ shows index.html
and assets/ at the ROOT alongside car/, canopy/, pumps/, system2/, winding/ - so
at least one harness builds into .shot-build/ root with emptyOutDir: true, which
deletes every sibling's private subdirectory. This is what the private build dirs
were introduced to prevent. Whoever owns the root-level build should move to a
subdirectory. Symptom is a navigation failure that looks like a port problem.

---

## Round: glass reflection separation, lamp bezel, grille depth, ranking closed out

Round: 2026-08-29T014405Z-963128499e45 (side_sun + nose_close).

### 1. Separated additive reflection leaf - DONE, pixel-verified

Copied Building's architecture. Transmission leaf keeps black diffuse and now has
envMapIntensity 0, specularIntensity 0 and NO clearcoat; reflection leaf is a
black-diffuse clone with ior 1.52 (F0 = 0.043), specularIntensity 1,
AdditiveBlending at opacity 1, FrontSide, renderOrder 4 behind the transmission
leaf at 3. ?carglsep=0 restores the conflated material, and it throws on a
non-numeric value rather than defaulting.

Two decisions worth carrying:

- specularIntensity had to move too, not just envMapIntensity. It is the term that
  zeroes F0, so the DIRECT sun glint is a front-surface reflection as much as the
  sky is, and leaving it on the transmission leaf would have kept it dimmed by the
  pane's transparency - the exact defect being fixed.
- Clearcoat DROPPED rather than moved. It was a second specular lobe standing in
  for the reflection the material could not deliver, and it is unphysical here:
  clearcoat models a coating over a base, glass IS the smooth surface. With ior
  1.52 the BRDF's own F0 is 0.043 and the Fresnel curve does the rest.

opacity RE-DERIVED 0.62 -> 0.34, per Building's two-step rule: this value's
MEANING changed (conflated veil + reflection + absorption -> absorption only), so
holding it would have kept a number correct for a job it no longer does.
envMapIntensity deliberately HELD at 1.0 because its meaning did not change - you
cannot tell the architecture from the number if both move at once. That 1.0 is the
next thing to re-derive.

Verified by whole-frame row sweep against the previous round: the frame brightened
in a band spanning y 254-349 only, peaking +6.49 counts at y=312, with ZERO rows
darkening anywhere and zero change below y=380. The car spans y 240-672, so the
change is confined to the glazing band and nothing else moved.

### 2. Lamp bezel and grille depth

Chrome bezel ring tracing each headlamp lens, 4 mm prouder than the glass, in its
own `bezel` group on LampBuild. This is the cheapest answer to "flat rounded
rectangles with a uniform pale fill", which two reviewers wrote independently: the
lamp is 180 mm and well past the 56 px that reads, so the complaint is not size -
it is that a pale lens fills its outline with one value, leaving the outline as the
only edge in it. A band supplies a hard specular line all the way round AND has
faces turned away from both lens and wing.

Grille depth: grille-frame and intake-frame were endFrame bands lying ON the
fascia. A frame with no faces turned away from the panel cannot cast the line that
makes an aperture read as an aperture. Both now carry a 14 mm outer return.
grille-frame-wall projects 349 px and intake-frame-wall 513 px in the nose pose.

Both badges fixed the same way. nose-badge was a flat patch RECESSED 8 mm into the
grille mouth - the offset-surface defect at its purest, a badge with no sides sunk
in a dark cavity sharing its shading with the black backing. Now 5 mm proud with a
wall, projecting 57 x 34 px, right at the reading threshold. boot-badge was proud
already but sideless, which is still a ribbon. Both were on the critic's missing-
fittings list, and in both cases the geometry was present and could not be seen.

Seven grille-dividers walled, count held at 7 rather than widened, per the intake
lesson: apparent width in the side pose is set by viewing angle, so the wall is the
fix in every pose and the width is the fix in none.

### 3. The ranking is closed. Nothing is left in this class.

0 of 94 parts coplanar, down from 34 of 67 when the class was found.

But the tool was lying about it, and that is the more useful half. It reported 30
COPLANAR after twelve ribbons had been repaired, of which 5 were real - because
the fix for a coplanar face is a SECOND named part (-skirt, -wall), so a repaired
assembly reads as two defects rather than zero. partscale --relief now pairs a face
with its wall sibling and judges the assembly. The general rule is in NOTES: when
the fix for a defect is to ADD a part, a per-part metric reports the fix as another
instance of the defect, and the signature is a count that RISES slightly after a
round of fixes.

The last two are grille-backing and intake-backing, now labelled BACKING rather
than exempted: coplanarity is a cavity backing's function, and a tool that hides
parts by name is one rename away from passing a real one.

So the honest answer to "what does the ranking put next" is: nothing in the relief
class is worth the pixels. Winding is also clean - one `edge` on antenna-fin, which
is a near-vertical outward face and not a failure. If Vegetation's per-triangle
detector names the car, that will be new information rather than a known backlog.

### Still owed on glass

The reflection leaf's envMapIntensity of 1.0 is inherited, not derived - re-measure
it now the architecture is right. And the transmission leaf does not lose energy to
Fresnel as the view grazes, which is Building's known remaining limitation too; it
applies a shader term (applyGlazingFresnel) rather than an opacity value, and that
is the pattern to copy if this becomes visible.

### Note for whoever owns capture reliability

Two more capture failures this round from the shared tree: one rolldown
"Unterminated string" from a sibling mid-save (tsc was clean seconds later), and
one more --no-build navigation failure, which is the .shot-build root problem again.
The scratch-goes-in-tmp rule should fix the second once siblings adopt it. The
first is unavoidable in a shared tree and is worth recognising on sight: a build
error in a file you did not touch, with a clean tsc, is a sibling's half-written
save, and the remedy is to retry rather than to investigate.

---

## Round 2026-08-29T020351Z-4ffe46c16158 — winding, and seven metalness values

RTX 4060 verified from the live context, zero shader/system errors, port 5116
clear. 3/3 shots.

### The tyres: 960 of 8,160 x 4, root-caused and fixed

`tools/carwind.mjs` is new and shared — per-triangle winding audit of every
geometry the car builds, CPU only, no render. It reproduces the scene-wide
detector's numbers exactly, which is the check that it is measuring the same
thing.

Localising did not need a capture. `buildTyre` sweeps an 18-point cross-section
around 240 steps with one uniform index order, so counting reversed triangles per
`vertex_index % 18` pinned it to segments 3, 4, 13, 14 — 240 each, exactly 50% of
each segment, symmetric across the two sidewalls. **50% of a segment, i.e. one
triangle of every quad, is the fingerprint of a folded quad**, not of a wrong
index order.

The profile radii were `0.2105, 0.2305, 0.2665, 0.3005, 0.2762, 0.3055, 0.3255`
— a **24 mm dip**, so the cross-section crossed itself and the sweep folded.

**Cause: two parameterisations in one ordered sequence.** Point 4 was
`rimR + 0.092` (absolute) and point 5 was `rimR * 0.45 + radius * 0.55`
(proportional). Both reasonable, not comparable by eye because they are not in
the same units, and at rimR 0.2085 / radius 0.3315 the absolute one overtakes.
Nothing asserted the sequence stayed ordered.

Fixed by an assertion that throws on a non-monotonic sidewall, plus rewriting all
seven points as absolute offsets from one origin so they are comparable. **`half *
1.085` is untouched**, so tyre maximum width, track and arch clearance did not
move — only the height at which the maximum occurs, which is now 51% up the
sidewall instead of 76%. That respects the earlier coupled-parameter finding.

Verified CPU: 960 → **0** reversed, mean agreement 0.782 → 0.979. 3,840 triangles
across four tyres no longer culled.

### Inner skin and headlining: the opposite remedy

3,229 of 52,036 and 320 of 11,350, both latent behind `DoubleSide`. Different
mechanism: both are parallel offsets of the body, inset 32 mm and 55 mm along
vertex normals, and **an offset larger than the local concave radius of curvature
turns the surface inside out.** The body has hard creases by design, so at a
crease the radius is near zero and a 32 mm inset locally inverts.

**Flipping the winding would have been wrong — 94% of those triangles were
right.** The guard applies the detector's own test at build time and drops the
folds. 3,229 → **17**, 320 → **0**, and 6,484 fewer triangles as a side effect.

The headlining needed a sign parameter, because it is deliberately flipped to face
into the cabin: testing it against the inner skin's convention would have deleted
all 11,350 of its triangles. Two surfaces from one source with different intents
need two contracts.

### Car winding: where it stands

| mesh | before | after | note |
|---|---|---|---|
| car-tyre x4 | 960 each | **0** | culled today → fixed |
| car-body | 125 | 125 | **still culled — owed** |
| car-inner-skin | 3229 | 17 | latent |
| car-headliner | 320 | 0 | latent |
| car-glass | 29 | 29 | latent — owed |
| car-slots | 5 | 5 | latent, agreement 0.635 — owed |

Culled today: 3,965 → **125**. Latent: 3,583 → **51**.

**`car-body`'s 125 are localised and the next person should start there.** All 125
sit in a horizontal band **y 0.834–0.967**, running the full length (z −2.46 to
2.40) and across |x| 0.177–0.774. A thin band spanning the whole car is the
signature of one ring row, i.e. very likely the same self-crossing-profile class
as the tyre, one row of the station profile doubling back. It is 0.09% of that
mesh, which is why it was deprioritised against seven live metalness values, not
because it is uninteresting.

### Seven metalness values, all resolved

| site | was | now | why |
|---|---|---|---|
| paint | 0.36 | **0.0** | pigmented colour coat is a dielectric |
| alloy wheel | 0.72 | **0.0** | painted and clearcoated, per its own comment |
| `darkMetal` (lamp housing) | 0.6 | **0.0** | moulded plastic; the *name* carried the error |
| brake | 0.85 | **1.0** | bare ferrous metal — resolves UP |
| black trim | 0.15 | **0.0** | polymer |
| plate | 0.25 | **0.0** | painted aluminium under retroreflective film |

Verified in pixels: side_sun changed pixels went **0.0913 → 0.1291 linear
luminance, 1.41x**, against a predicted 1/(1−0.36) = 1.56x for pure diffuse
recovery. The shortfall is the specular no longer being tinted by the base colour,
which is the other half of what metalness does — so the magnitude is predicted,
not just favourable. 28.5% of the frame moved, rows 241–739, which is the car.

This matters against the grey card: PAINT's authored albedo luminance is 0.1465
and the certified delivered value was 0.0766, a 52% shortfall. `1 − 0.36 = 0.64`
accounts for most of it. **The albedo was certified correct as an authored value
while a third of it was being deleted downstream**, which is why both halves
looked right in isolation.

Two source-level notes worth repeating: the alloy comment had already reasoned to
the right answer and left the wrong value directly beneath it; and `darkMetal` is
a lamp housing, so the material's *name* asserted a class nobody checked against
the part.

### `envMapIntensity` 1.0 — derived, and six still outstanding

Held at 1.0 through the glass separation deliberately, so any movement would be
attributable to the architecture. That was method. The derivation: with F0 0.043
from IOR 1.52 in place, `envMapIntensity` has no job left — it multiplies returned
environment radiance, so 1.0 is the only non-compensating value, and anything else
masks the F0 rather than tuning gloss.

**Six sub-1.0 values remain in `CarSystem.ts`: 0.28, 0.22, 0.5, 0.95, 0.5, 0.7.**
This file already retired every value *above* 1.0 on the ground that a surface
cannot return more than it receives. Values below 1.0 are the same defect —
roughness and F0 already encode how much a dielectric returns. Left for a
dedicated round: seven metalness changes is already as much material change as one
round can attribute.

### Owed, in order

1. `car-body`'s 125, starting at the y 0.834–0.967 band.
2. The six sub-1.0 `envMapIntensity` values.
3. `car-glass` 29 and `car-slots` 5 — latent, and `car-slots` at agreement 0.635
   is the worst per-triangle agreement on the car despite being only 5 triangles.
4. Promote `tools/carwind.mjs` into the `shootcar` gate alongside `probe-unseen`.
   It already exits non-zero above `--max`, so it is one line.

---

## Round 2026-08-29T022456Z-6e70e29a11bb — contactShadow coupled before three systems copied it

RTX 4060 verified, zero shader/system errors, 2/2 shots.

### The borrowed constant, fixed and published

`contactShadow.ts` baked peak alpha 0.78 with a comment saying it stood in for
lost ambient and must not be lit twice. Right about the second part, wrong about
what followed. The decal is an unlit black quad under normal alpha blending, so it
resolves to `background * (1 - alpha)`: **it darkens the total of sun plus ambient
while the quantity it stands in for is occluded ambient alone.** Those agree only
at a fixed ambient share, and Lighting moved environment 1.0 -> 2.4 with sun
5.6 -> 4.4, so the share moved and the decal did not.

Fixed on Canopy's pattern. `environmentIntensity` is now a **required parameter
with no default** — a default would let Canopy and Pumps inherit a hidden
borrowing, which is the exact defect it exists to remove, and it would look like
it was working. Callers pass live `scene.environmentIntensity`, never a copy of
Lighting's default.

What is coupled and what is not matters here and is symmetric: `strength` is a
*geometric* occlusion fraction — a 10 mm gap hides the same solid angle at any
exposure — so it stays constant. The **level it is drawn at** is derived. Coupling
the geometric term would have been the same error in the opposite direction.

Published on `__CAR.contactShadow`, verified in the capture:

```json
{ "environmentIntensity": 2.4, "environmentReference": 1, "occlusion": 0.78,
  "levelRaw": 1.872, "level": 0.94, "clamped": true }
```

Pixel-verified: side_sun 3.02% of frame moved, **rows 403-748 only**, i.e. the
contact region and nothing else, at 0.890x. wheel_close 0.900x. The changed pixels
sit at 0.0069 linear, which confirms the region is the shadow core rather than
anything on the car.

**`clamped: true` is a real finding and is owed to whoever takes this next.** The
raw derivation is 1.872 and saturates at 0.94, so the linear ambient-share model
has run out of range at environment 2.4 — an alpha cannot express it. The clamp is
reported rather than applied silently, because a clamp that binds quietly turns a
first-order approximation back into the constant this started as. If the
environment rises again, this term needs a better model, not a bigger number.

### For Canopy and Pumps, adopting this file

`makeContactShadow` now returns `{ geometry, material, report }` and **throws** on
a missing or non-finite `environmentIntensity`. Print the report in your own system
report; the failure being prevented is not a wrong number but an invisible
dependency.

### car-body's 125: now fully localised

Not the flank. Characterising by shading-normal axis and position:

- **105 of 125 face ±Z**, 20 face +Y
- **z clusters entirely at ±2.5** — 83 at the nose, 42 at the tail
- |x| spread 0.2-0.8, y band 0.834-0.967

So they are on the **nose and tail end caps**, in the band where the shoulder
crease wraps around the end. The section at that height is `lowerFlank` rows 19-25
into `lineStep` 26-27, and `lineStep` is where the section's x reverses
(0.9184 -> 0.9172) as tumblehome begins — a legitimate maximum on the flank, which
folds where the cap's own z profile turns through it.

Not fixed this round on purpose: the cap construction is the machinery `endZ`,
`endPatch` and `endBand` all read, which every grille, lamp and badge part is
placed against, and it is 0.09% of that mesh. It wants a round with capture budget
rather than the end of one. The monotonicity assertion from `buildTyre` is the
right instrument to point at it.

### Owed, in order

1. `car-body`'s 125 on the nose and tail caps, with the assertion pointed at the
   cap section rather than the tyre profile.
2. The six sub-1.0 `envMapIntensity` values as a dedicated round.
3. A better model for the contact decal's level, since the linear one now clamps.
4. `car-glass` 29 and `car-slots` 5, latent; `car-slots` has the worst
   per-triangle agreement on the car at 0.635 despite being 5 triangles.
5. Promote `tools/carwind.mjs` into the gate; it already exits non-zero above
   `--max`.

### Two corrections taken into the record

- **The `.shot-build` destroyer is `tools/shoot.mjs --system=`** — an empty flag,
  so the default never fires, the outDir collapses to the bare root and
  `emptyOutDir` does the rest. It cost me a **third** round this session: the
  bundle built at 02:15:08 and the preview then served a wiped directory,
  `ERR_HTTP_RESPONSE_CODE_FAILURE`. Retrying was the correct remedy and worked
  first time. A tool defect needing no misuse.
- **`probe-unseen` aims at the mesh bounding sphere**, which for a scattered
  `InstancedMesh` describes the scatter rather than the object. I have used it as a
  regression gate, but only on car geometry, which is not instanced — the car's
  wheels are four separate meshes. The cross-system catches it reported in
  Vegetation and Building are the ones that need re-reading, not the car's.

---

## Round 2026-08-29T024048Z-b769612b61df — the end caps, and the detector's ceiling

RTX 4060 verified, zero shader/system errors, 3/3 shots. `car-body` 125 -> **0**.
**Reversed-and-culled across the whole car is now 0.**

### The caps: root cause is an unwritten star-shapedness contract

`makeCap` builds concentric rings scaled about a centroid onto a shallow dome, so
quad orientation comes out as radial x tangential. That is consistent only while
the ring is **star-shaped about that centroid** - while the polar angle increases
monotonically as `j` advances.

The nose and tail sections are not. Measured on the shipping profile, the
`upperFlank` band runs **16 edges at the front and 18 at the rear** where the
polar angle *decreases*, because the shoulder overhangs the bonnet and boot line:
y falls while x falls, so the ring doubles back in the plane the fan radiates in.
Checked at three candidate centroids (cy 0.5, 0.788, 0.95) - **no choice of centre
fixes it**, because the ring doubles back rather than being merely off-centre.

**The shape is not the bug.** A nose section whose highest point is the shoulder
rather than the centreline is a correct car. So unlike `buildTyre`, this cannot be
an assertion that refuses to build - there the doubling back was a mistake, here
it is the design. The implicit contract was star-shapedness, nobody wrote it down,
and the shape that violates it is the one we want, so the builder absorbs it.

Fixed by orienting every fan triangle against the one direction a cap
unambiguously has, its own axis. Safe because the dome is 42 mm of bulge over
~800 mm of radius, so every fan normal is strongly ±Z; a dominance guard leaves
anything radial alone, so an aperture reveal wall is never touched. **Third place
in this system to need this remedy** after `flankStrip` and the inset skins, and
the shape is identical each time: a builder deriving orientation from something
the caller controls, fixed by measuring against a direction the builder knows.

### The finding that changes how every winding count should be read

`capFlips` reports **4,540 front and 1,344 rear** - 5,884 triangles the correction
had to move, against the detector's 125. A factor of 47, and the paint material
has no explicit `side`, so it defaults to `FrontSide`: **those 5,884 were being
culled.** A hole in each cap, invisible in the presets because the caps sit behind
the grille, bumper, lamps and bonnet shut line.

The reason for the discrepancy is a ceiling on the detector itself, now documented
in `tools/carwind.mjs`:

> The detector compares a triangle's geometric normal against the mean of its own
> shading normals, and those came from `computeVertexNormals`, which derives them
> from the winding. Inside a **contiguous** reversed region the shading normals are
> reversed too, they agree with the geometry, and the region reports clean. **What
> it detects is the PERIMETER of a reversed region, not its interior.**

So a small non-zero count is not a small defect - it is a boundary, and the region
behind it needs measuring another way. **The scene-wide 5,828 across 370 meshes is
a floor, not a total**, and every system with a small non-zero count should assume
a region behind it. This is worth broadcasting more than the cap fix is.

### Placements verified, not assumed

Only `idx` changed; `pos`, `cap.ring`, `cap.centre`, `cap.zEnd` and `cap.bulge` are
untouched, so `endZ` and `capContains` are mathematically unaffected. Confirmed by
checksumming every placed fitting's positions after the change, plus
`endZOutsideOutline: 0` and `flankXNoCrossing: 0`, and 94 trim parts still built.

Pixel-verified, with attribution kept honest: nose_close moved 0.83% of frame,
and the row histogram separates the two changes cleanly - **rows 700-800 (10,213
px) are the contact decal** from the previous round, **rows 300-400 (1,699 px) are
the cap**, in exactly the predicted nose-shoulder band. side_sun and wheel_close
barely moved, which is the expected result for geometry sitting behind the grille.

So the cap's value is not its preset footprint. It is 5,884 triangles no longer
culled, a latent trap removed, and robustness for **the walked-path video, which
will see the nose from angles no car preset covers.**

### `envMapIntensity`: a test rather than a sweep

1.0 is the only physically correct value, but there is one legitimate reason to
sit below it and it is a real missing term: `scene.environment` is a single PMREM
sampled with **no occlusion**, so a surface sealed inside the bodyshell receives
the full outdoor sky. A reduced value stands in for **occlusion of the
environment**, and the honest fix is an AO map rather than a number.

Note this reaches the OPPOSITE conclusion to the contact decal from the same
question, and the reason is the control: an occluded *fraction of the sky* is
dimensionless and therefore correctly constant when the sky brightens, whereas the
decal was a fraction of a total the environment sets.

**So the test is: name the geometry that occludes, or go to 1.0.** Applied to the
eight I enumerated, it swept two - the alloy wheel face at 0.95 and exterior black
trim at 0.65, neither of which has an enclosure to name. The rule is written at
the first surviving site.

**Owed, and stated plainly: a fresh grep finds NINE sub-1.0 values, not eight.**
My first enumeration was truncated by a `head -8`, so three at lines 1117, 1127
and 1292 (0.35, 0.8, 0.85) have **not** been inspected against the test. That is a
measurement error of mine, not a judgement call, and it is the same class as the
`--baseline` typo: a check that silently examined less than it claimed to.

### Owed, in order

1. The three uninspected `envMapIntensity` values, then an AO map to replace the
   six legitimate occlusion stand-ins with the real term.
2. `car-glass` 29 and `car-slots` 5, latent - and now assume a region behind each
   rather than 34 triangles.
3. A better model for the contact decal's level, which clamps at environment 2.4.
4. Promote `tools/carwind.mjs` into the gate.

---

## Round 2026-08-29T030942Z-3ad5e60e20e8 — surface adoption, resolution trap, enumeration closed

RTX 4060 verified, zero shader/system errors. `carwind` PASS, culled 0.

### `surfaceAt` adoption: wired, and honestly reporting that it is not yet live

Terrain's finding applies directly: `groundHeight` is the analytic field, the
ground MESH is a chord across it, so the rendered surface sits **6.7 mm low at p90
and 23.6 mm at p99 in the near field** against 1.1 mm far away. For a decal whose
job is to draw the contact line, being buried up to 24 mm removes the thing it
exists to show - **and it fails only near the camera**, which presents as a
distance cull rather than a placement bug. The walked-path film capture is exactly
the near field.

A margin cannot fix it: the margin has to be the p99, and lifting 24 mm to cover a
24 mm worst case floats it 23 mm in the median.

**The publish has not landed.** `surfaceAt` exists on Terrain's ground geometry at
`TerrainSystem.ts:676` and is held in a private field; nothing in the tree
`game.provide`s it. Rather than hard-code a guessed key - which would return
undefined forever while looking wired up - the car **discovers it by key pattern**
over `serviceKeys()`, the same approach `core/collision.ts` uses for `*.blockers`.
The match must be a function and must return a finite height under the car, and
the matched key is published. Currently:

```json
"surfaceExact": false, "surfaceKey": null
```

It will start working the moment Terrain publishes under any key containing
"surface", with no edit here. **Terrain owes the one-line `game.provide`.**

### The resolution trap, and a compromise published rather than hidden

Canopy's non-monotone table - 0.96 at 16, 0.73 at 20, 0.70 at 24, 0.95 at 32 - is
an **alignment condition wearing a resolution condition's clothes**. The occlusion
peak sits exactly at the occluder edge, alpha is sampled at vertices and
interpolated, so quality depends on whether a grid line lands near that edge, and
alignment is not monotone in `res`. Aligning is unavailable with several occluders
on one grid, so the module instead requires
`cell <= min(reach) / 4`, at which point alignment stops mattering.

**Measuring it exposed something worse in the car's own decal:** requested `res`
72, needed **430**, so `cellsPerReach` was **0.67** - the shipped decal was six
times too coarse and squarely in the alignment lottery.

But 430 is roughly **163,000 triangles, comparable to the entire bodyshell**, for
a ground decal, with a perf pass measuring this scene. So `RES_MAX` is 160 and the
shortfall is **reported, not hidden**: `underResolved: true` with the achieved
`cellsPerReach` beside it. Far better than 0.67, honestly short of 4.

**The structural fix is not a bigger number, and this is the note for the next
adopter:** one uniform grid is the wrong structure. Fine cells are needed only
within centimetres of the four tyre patches; the underbody occluder at gap 0.155
has a 248 mm reach and is fully resolved at res 84. **Per-occluder local grids**
give every element its correct cell size at a fraction of the cost. Anyone wanting
a sharper contact line should build that rather than raise `RES_MAX`.

Two rules encoded in the module for adopters: treat the caller's `res` as a floor
never a ceiling, since a value too coarse to describe the falloff is a wrong answer
rather than a performance choice; and publish the DERIVED quantity - `cellsPerReach`
predicts quality, `res` is what people tune, and reporting only `res` is what the
non-monotone table is a picture of.

### `envMapIntensity`: enumeration closed properly

Eleven sub-1.0 values, not the eight I first reported. Four swept, seven kept, and
**every kept one now names its enclosure in its own comment**:

| swept to 1.0 | was | why it failed the test |
|---|---|---|
| alloy wheel face | 0.95 | looks straight at the sky |
| exterior black trim | 0.65 | outside of the bodyshell |
| number plate | 0.8 | 10 mm recess hides almost no hemisphere |
| B-pillar applique | 0.85 | **its own comment says it exists to pick up a smear of sky** |

The B-pillar is the alloy pattern again: prose reasoned to the right answer and the
value beneath it said otherwise. Third instance of that in this file tonight.

Kept, each with a named enclosure: shut-line cavity 0.28, aperture seal 0.22,
headliner 0.5, lamp housing 0.5, brake 0.7, cabin cloth 0.35, cabin plastic 0.35.

Pixel-verified and predicted: changed pixels brightened **1.176x to 1.269x** across
three poses, against predictions of 1.176x for the pillars (0.85 -> 1.0) and 1.25x
for the plate (0.8 -> 1.0). The measured range brackets the two predictions.

### One of mine, reported because it is the interesting kind

A rewrite script printed "report extended" while its `String.replace` had matched
nothing, so three report fields were silently never added. Caught two steps later
only because a capture was missing them. **A rewrite must verify its own effect in
the same run and exit non-zero on a mismatch** - an unconditional success message
is worse than no message, because it converts an obvious absence into a false
positive. The replacement guard is now in the scripts, and it immediately caught my
own bad expectation arithmetic on the next edit.

### Owed, in order

1. **Terrain's one-line publish**, then `surfaceExact` should flip to true with no
   change here. Verify it in a near-field pose.
2. **Per-occluder local grids** in `contactShadow.ts`, which retires
   `underResolved` properly instead of budgeting around it.
3. The `clamped: true` level ceiling, coordinated with Lighting's environment
   decision.
4. `car-glass` 29 and `car-slots` 5 latent - and per the detector-ceiling finding,
   assume a region behind each rather than 34 triangles.
5. Promote `tools/carwind.mjs` into the gate.

### Correction to the above, measured after writing it

I called the 160 cap a compromise. It is not, and the numbers say so. Same poses,
three rounds: **72 -> 430 moved 16,591 pixels. 430 -> 160 moved 57.**

So the cliff sits below `cellsPerReach` about **1.5**, not at 4. The shipped 0.67
was genuinely broken; 1.49 is visually indistinguishable from 4.0 while costing a
seventh of the triangles (~23k against ~163k). **CELLS_PER_REACH = 4 is
over-specified**, and `underResolved: true` on the car should be read as
"over-specified target, not met, no visible cost" rather than as a defect.

The target stays at 4 because for a small footprint - column feet, bollards, pump
bases - it is nearly free and removes the alignment sensitivity outright. Both
figures are in the module so the next adopter calibrates against measurement rather
than against my first estimate.

Worth noting the shape: I published a pessimistic flag and then measured it, and
the measurement moved the conclusion. Had I not diffed the final round the file
would carry a scary constant nobody could calibrate.

**Final: round 2026-08-29T031746Z-b47dd36bde0d.** RTX 4060, zero shader/system
errors, `carwind` culled 0, tree typechecks, port 5116 clear.

---

## Round 2026-08-29T034745Z-283fde9f8ef6 — the walk-by pose, and what it found

RTX 4060 verified, zero shader/system errors, tree typechecks, port 5116 clear.

### 1. `car-glass` 29 and `car-slots` 5: REFUTED, and by a new instrument

I had reasoned these should be assumed perimeters of regions. `tools/windregion.mjs`
settles it topologically, needing no normals at all: two triangles sharing an edge
are consistently wound iff they traverse it in opposite directions, so flood-filling
across consistent adjacencies finds maximal agreeing patches and a "clash edge" is a
real discontinuity.

**Both meshes have exactly zero clash edges.** No discontinuity anywhere, so no
region, because there is no perimeter. The counts are averaged vertex normals
disagreeing with their own faces at a hard crease - a shading artefact on a
`DoubleSide` mesh, not a culling defect. The ceiling finding makes small counts
*suspicious*, not guilty, and this is the distinction being drawn in practice.

`car-body` reports 186 clash edges, which is the expected price of the cap fix
absorbing a non-star-shaped ring: per-triangle facing is correct, which is what
culling reads, but the fan is no longer *globally* consistently oriented.
`carwind` still reports culled 0.

**Two traps in the tool, both of which gave confident wrong answers first.** Patch
count is not defect count - every mesh here reports 8-93 patches because they are
assemblies of disconnected pieces, and reading that as damage would condemn every
clean mesh. And vertices must be welded first, with the tool able to return VOID:
`car-seals` still has three open edges on every triangle after welding, so it gets
no verdict rather than a clean one.

**Only declare a facing expectation where the renderer enforces one.** I got this
wrong twice in opposite directions - "out" for everything reported 627 headliner
triangles reversed, then "in" reported 40,277 the other way. Both meshes are
`DoubleSide`, so neither has a correct facing to be wrong about, and any
expectation manufactures a defect in whichever direction I chose. Fourth instance
in this system of a check deriving orientation from something the caller owns.

Shared tooling, and it is the instrument **Pumps** needs for its 23 hose triangles.

### 2. Per-occluder local grids: `underResolved` retired structurally

One grid had to carry the finest occluder's cell size across the widest occluder's
extent - a 45 mm tyre reach across a 5.2 m footprint, requiring res 430 and about
**163,000 triangles for a ground decal**. Each occluder now gets a grid over its
own footprint plus its own reach, at its own cell size, merged into one draw call:

| | uniform, target met | uniform, capped | per-occluder |
|---|---|---|---|
| triangles | ~163,000 | 22,720 | **9,800** |
| cellsPerReach | 4 | 1.49 | **4** |
| underResolved | false | true | **false** |

Measured difference against the capped version: **55 pixels.** Same picture, 57%
fewer triangles, target met rather than missed.

**Why overlapping is safe is a property of the blend, not the geometry**, and this
is the part an adopter must check: the decal is black under normal alpha blending,
so layers resolve to `dst*(1-a1)*(1-a2)` - the identical multiplicative composition
the single grid computed in its `open` product. **Under additive blending this
would be wrong**, saturating to black exactly under the car.

### 3. The `clamped: true` ceiling, and it is now derived

Was an authored 0.94 while the geometry occludes 0.78, so the decal removed more
light than the underbody obstructs. The fix comes from the derivation already
above it: the environment scaling approximates the **ambient share** of incident
light, occlusion removes sky and not sun, so `alpha = occlusion * ambientShare`
with `ambientShare <= 1` - and **the alpha cannot exceed the occlusion it is a
fraction of.** Ceiling is now `strength`.

This answers Lighting's question directly. `clamped: true` now means "the ambient
share has saturated, and raising the environment cannot deepen contact because the
geometry only blocks so much sky." If Lighting raises the environment, this term
correctly does nothing.

### 4. THE POSE THAT MATTERS DID NOT EXIST

Every pose in `shootcar.mjs` was a car portrait - close, long lens, framed to fill.
The deliverable is a 15-20 second walk-through where the car is glanced at from
walking distance, so **every judgement in this system's history was made on frames
no viewer will ever see.** Added `walk_by`: eye height 1.65 m, 8.8 m back, 40
degree field, which is what a person sees.

It found a defect on its first run that no portrait pose had surfaced.

### 5. Paint: I invalidated my own certification and nothing re-checked it

`0x516d8c` was grey-card derived and certified. Then `metalness` went 0.36 -> 0.0,
correctly, and **added a measured 1.41x to the delivered diffuse.** The derivation
predates that, so from that moment the paint was 41% lighter than the certified
value.

This is the stale-compensation pattern running the other way: not a compensation
left after its bug was fixed, but **a derived value left after a term it was
derived through changed.** The rule: *a value certified through a pipeline is
certified against that pipeline, and any later change to it retires the
certificate.* Corrected to `0x445c77` by the same method as the original 2.2x -
linear luminance / 1.41, hue and saturation held. Measured flank 0.2058 -> 0.1431,
**0.695x against 0.709x predicted**, on a region verified as 99% moved.

**And one of mine, withdrawn.** The number that first prompted this - "flank 1.48x
brighter than lit asphalt" - was measured on the wrong pixels: I read coordinates
off a 1024-wide view of a 1600x900 capture, off by 1.5625, sampling sky and tree
line. The tell was flank and roof coming back **identical to four decimal places**
across a round that changed the paint. A region that does not move when the thing
it measures changes was never on that thing - same trap as the tyre patches, same
file, caught by the same check. A sweep also shows no valid reference exists in
that pose: the brightest unchanged ground is 0.0086-0.0137, so the whole foreground
is in the car's own shadow, and flank-versus-shaded-road confounds orientation,
illumination and material at once. **The change stands on the metalness argument,
which is source-level and needs no pose.** The comment records the withdrawal.

### 6. The photograph judgement

**It reads as a real parked car in real dawn light at walking distance.** The
silhouette is a coherent saloon, the wheels read with visible alloy spokes and dark
tyres, the glass reads as glass with a mirror and a door handle catching light, and
the car sits in its bay with a long raking cast shadow and bay lines around it. A
glance in a moving shot would accept it.

**One element reads as broken rather than unfinished, and it is now the top item.**
The bonnet-to-wing shut line is a black chasm rather than a seam. The root cause is
structural and measured: shut lines are not authored geometry at all, they are whole
body-ring quads **reclassified** to the cavity material at zero inset. So their
width is quantised to the tessellation - short edges at **p10 6.2 mm and median
11.6 mm against a real panel gap of 3-5 mm**, i.e. 1.6x to 2.9x too wide - and at
zero inset each one is a flat dark stripe with no bright edge beside it.

That is exactly the ribbon failure this system already diagnosed and fixed on the
beltline, now found in the shut lines: **a dark line without a highlight is not a
panel gap.** The fix pattern is known and proven here - an authored-width dark line
with a lit edge, independent of ring density. Deliberately not started at the end of
a session; a half-finished shut-line change would be worse than the chasm.

### Owed, in order

1. **The shut lines.** Highest value remaining, specified above, and the only thing
   in the frame that reads as wrong rather than merely simple.
2. **Terrain's one-line `game.provide`** of `surfaceAt`, which must go after
   `TerrainSystem.ts:676`, since the geometry does not exist at the other four
   provide sites. The car's discovery path is already waiting for it, and
   `surfaceExact` flips to true with no edit on this side.
3. Promote `carwind` and `windregion` into the gate.

---

## Round 2026-08-29T040011Z-f13064d3df51 — the shut lines were never broken

RTX 4060 verified, zero shader/system errors, tree typechecks, port 5116 clear.

**CORRECTION TO MY OWN PREVIOUS HANDOVER.** I reported the bonnet shut line as "a
black chasm... reads as broken", specified a fix, and named it the top remaining
item. That was wrong, three times over, and the shut lines are correct as built.
Nothing needed changing and nothing was changed.

### What the region mask showed

`?cardebug=slots` flat-colours `car-slots` magenta - the same instrument that ended
three rounds of inference on the grille edge. In `walk_by` the shut lines are **fine
1 px hairlines, correctly placed** around doors, bonnet and boot, each with a lit lip
beside it: a slot pixel reads 0.0201 against a neighbour at 0.3566, which is exactly
the dark-line-with-a-highlight pair a real panel gap makes. 863 slot pixels across
the whole car. The black band I had described sits **beside** the magenta, is not
`car-slots`, and is largely not the car at all.

### Three wrong diagnoses of one correct feature

| attempt | instrument | error |
|---|---|---|
| 1 | 3x magnified crop | a crop is a portrait - I made the exact error I had just named, one step after naming it |
| 2 | column sweep for the darkest run | the search window ran off the silhouette into dark background |
| 3 | slot quad edge statistics | geometry width is not rendered width, and says nothing about the lip |

Attempt 2 is the one worth broadcasting. The dark pixels at the top of each column
read `rgb(75,46,34)` and `rgb(62,35,24)` - **warm brown**, i.e. scrub and soil, not
any material in this car. **A sweep is not automatically safe:** "sweep, do not
hand-pick" protects against choosing a flattering region, and not at all against a
window containing things other than the object. A sweep needs a mask as much as a
rectangle needs a validator.

### The cost the error would have had

Had I implemented the specified fix, it would have narrowed a 1 px line toward a
physically-correct 4 mm gap. At walking distance the frame is **4.0 mm/px**, so a
4 mm gap is *one pixel* and 3 mm is below one - the fix would have **deleted the
shut lines** while every geometry statistic improved. Physical correctness and
legibility part company at viewing distance, and only the delivery scale can say
which is being asked for.

### Verdict: the car is done for the take

Judged from `walk_by`, the frame that found the paint defect:

- It reads as a real parked car in real dawn light at walking distance. Coherent
  saloon silhouette, wheels with visible alloy spokes and dark tyres, glass reading
  as glass with mirror and door handle catching light, shut lines present as
  hairlines with lips, sitting in its bay with a long raking cast shadow and a
  contact decal at the ground line.
- Winding is clean: `carwind` culled 0, and `windregion` finds no reversed region in
  glass or slots.
- Paint is correct against a certification that is now current rather than expired.
- The contact decal is 9,800 triangles with its level derived rather than authored.

**Film should shoot it.** Nothing outstanding reads as wrong at the delivery
distance; what remains is bookkeeping that does not need to precede the take.

### Left for whoever picks this up after the film

1. **Terrain's `surfaceAt` publish** - must go after `TerrainSystem.ts:676`, since
   the geometry does not exist at the other four provide sites. The car discovers it
   by key pattern already, so `surfaceExact` flips with no edit here.
2. The three remaining `envMapIntensity` values with named enclosures, if anyone
   wants the enumeration closed to zero rather than to seven-with-reasons.
3. Promote `carwind` and `windregion` into the gate.
4. `probe-unseen` DEGENERATE verdicts against `InstancedMesh` recorded before today
   are void per Vegetation's bounding-sphere finding. Nothing in this system gated on
   one - the car has no instanced geometry - so no car result needs re-running.

### Late confirmation: `surfaceAt` landed and the decal picked it up with no edit

Final round **2026-08-29T040817Z-8db964057adf** reports:

```json
"surfaceExact": true, "surfaceKey": "groundSurface"
```

Terrain published, and the pattern-discovery path resolved it **without a line
changing on this side** - which was the whole point of matching by key pattern over
`serviceKeys()` rather than hard-coding a guessed name. Item 1 of the owed list is
closed by someone else's commit, as intended.

It also explains a diff I had briefly flagged. Comparing the default path against
the pre-flag round showed 0.725% of pixels moved, and I had set an arbitrary
2,000-pixel threshold that duly cried wolf. Splitting it by region: 8,900 of 10,434
are outside the car and concentrated in rows 700-800, the foreground ground, and only
81 are on the painted body. **The decal is now drawing on the exact rendered surface
rather than the analytic field**, which is up to 23.6 mm different in the near field
- so the ground-line pixels *should* have moved, and the body's should not have. The
urgent fix is delivering, verified in pixels.

The threshold is worth a word: a bare pixel count with a made-up bound is not a
check. What made the result readable was partitioning by region and asking which
region *ought* to have moved - the same discipline as splitting the nose histogram so
the decal and the cap were attributed separately.
