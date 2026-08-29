# Dawn Station

A photorealistic first-person gas station at dawn, in the browser. Everything you
see is generated in code — there are no texture files, no model files and no
downloads. A load makes exactly two network requests.

## Walking around it

```
pnpm install     # first time only
pnpm play
```

That builds the scene and opens it in your browser.

### The first load is slow. You pay it once.

The very first time you open the scene in a given browser, expect to sit on the
`generating surfaces…` screen for **three to six minutes** — longer if anything
else is using the graphics card. Every load after that is **20 to 30 seconds**.

| | |
| --- | --- |
| **the very first load, once per browser** | **3–6 minutes**, and it may crash the tab; reload if it does |
| every load after that, including after quitting and reopening | 20–30 seconds |

**The fast state survives closing the browser.** That has been measured directly —
the same browser profile reopened in a brand new browser process loads in about
half a minute, not minutes. So this is a one-time cost, not a toll you pay every
session: the shaders are compiled once and the compiled result is kept on disk
against your browser profile.

**So open the scene once and let it finish, before you start recording.** Then
reload and record. You will not meet the long wait again.

### The tab will look frozen, and that is not a bug

During the wait the page is genuinely unresponsive — the world is built in one
unbroken stretch of work on the same thread that draws the page, so the loading
text cannot even animate. Measured, that stretch is **around four minutes on a
first load and 11–13 seconds on a warm one**. Windows or your browser may offer to
kill the page. **Don't** — wait it out on the first load. Nothing is being
downloaded; the terrain, every material and every prop are being computed.

**Use `pnpm play`, not `pnpm dev`.** They render the same scene, but `dev` serves
several hundred unbundled modules and takes around **four minutes** to reach a
first frame *every time*. `dev` is for editing the code, not for looking at the
result.

### Controls

| | |
| --- | --- |
| **Click** | take the mouse — look around |
| **W A S D** | walk, strafe, back up |
| **Click** (while looking around) | use whatever you are stood in front of |
| **Esc** | give the mouse back |

### The three things you can do

Walk up to each one until you are close enough to touch it, put it in the middle
of the screen, and click.

- **A pump.** Lifts the nozzle and starts fuelling; the gallons and the dollars
  climb on the dispenser's own display. Click again to hang it up.
- **The shop door.** Rings the bell and swings the leaf.
- **A fridge door** in the drinks cooler at the back of the shop, and the bottle
  on the shelf inside it.

A small dot sits in the centre of the screen while you are looking around. It is
dim by default and **brightens and grows slightly when whatever you are pointing
at is close enough to use** — that is the whole of the interface. There are no
prompts, no labels and no outlines on objects, so the dot going bright is the only
thing that tells you a click will land.

Reach is about **2.2 m**. If a click does nothing, the dot was dim: step closer or
aim a little more squarely at the thing.

## Recording it

`pnpm play` and capture the browser window. Two things worth knowing before you
press record:

- **Load it once, all the way, before you record.** The first load in a browser
  takes minutes and can crash the tab; every load after it takes about twenty
  seconds, and that stays true after you quit and reopen. Take the slow one before
  the camera is rolling, then reload and record that.
- **Capture software wants the same GPU the scene does.** Start the capture, then
  reload the scene, then walk — rather than loading first and starting capture
  while the frame budget is already committed.

There is a reference recording at `shots/film/dawn-station.mp4` — 18 seconds,
1600x900, showing the pump, the door and the fridge. It is what the scene looks
like when everything goes right, and it is useful for comparison rather than as a
deliverable.

## If it does not start

- **`pnpm play` fails during the build.** Someone has left the tree with a
  compile error. `npx tsc --noEmit` names the file.
- **The page is black and stays black.** Open the browser console and look for
  `__SYSTEM_ERRORS`. Systems here fail loudly on purpose rather than degrading
  quietly, so a missing service is reported rather than silently skipped.
- **It runs but everything is grey and slow.** The browser has fallen back to
  software rendering. In Chrome, `chrome://gpu` says whether WebGL is hardware
  accelerated.

## For anyone working on the code

`NOTES.md` is the important file: roughly forty ways this scene has silently
looked correct while being wrong, each with the measurement that caught it. Read
it before trusting a screenshot. `RESUME-PLAN.md` is the live per-system state
and what each owner is on.

Verification harnesses live in `tools/`. Each one boots the real scene on a real
GPU and asserts on numbers rather than on how the picture looks:

| | |
| --- | --- |
| `node tools/walkprobe.mjs` | the first-person walk: spawn orientation, collision, the doorway, reach and trigger on all three interactions, and the storefront glazing at grazing angles |
| `node tools/filmwalk.mjs --no-capture` | drives a scripted route through all three interactions at the real walking speed and asserts each one actually happened, in about a minute |
| `node tools/filmwalk.mjs` | the same route, captured and encoded to `shots/film/dawn-station.mp4` |
| `node tools/coldload.mjs` | how long the scene takes to become walkable, on a brand new browser profile against a warm one — the cold/warm gap above |
| `node tools/probe-washscan.mjs <png>` | flags frames that have lost their contrast |

They all require a hardware GPU and fail rather than fall back to software.
