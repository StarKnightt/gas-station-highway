/**
 * The boot overlay: what the user looks at for the twenty seconds — or the
 * three and a half minutes — between opening the page and being able to walk.
 *
 * ## The problem this exists for
 *
 * Nothing in this scene is downloaded. Every surface, mesh and texture is
 * generated on the CPU during `init()`, so there is no network progress to
 * report and a conventional loader has nothing to show. Measured first loads
 * on this machine were 218.7 s, 171.9 s and one hard tab crash, against a
 * steady 20.8–21.9 s on repeats. The previous overlay was a single line of
 * text, which meant **a slow load and a hung one looked identical**, and that
 * ambiguity — not the wait itself — is what this is here to remove.
 *
 * ## Where the progress comes from
 *
 * `Game.start()` announces the active system list once, then brackets each
 * system's `init()` with `system-init-start` / `system-init-done`. That is the
 * only honest progress signal available: the systems are known up front and
 * they complete one at a time. `?solo=` / `?skip=` are handled for free
 * because the announced list is the filtered one.
 *
 * ## Why the bar is weighted
 *
 * Counting systems equally would put the bar at 10% after `lighting` (90 ms)
 * and then leave it there for eleven seconds through `terrain`. `INIT_COST_MS`
 * below is the measured cost of each system, and each system's share of the
 * bar is its share of that total. Correct the table when the costs move; it is
 * the only place they are written down.
 *
 * ## Why so much of this runs on the compositor
 *
 * Procedural generation blocks the main thread. `terrain` holds it for about
 * eleven seconds in one go, and during that time no JavaScript runs, no
 * `setInterval` fires and nothing repaints from script. A progress bar driven
 * by a timer would freeze solid for the exact stretch the user most needs to
 * see that the page is alive.
 *
 * So the three things that must keep moving during a block are all `transform`
 * or `opacity` animations, which Chrome runs on the compositor thread
 * independently of the main thread:
 *
 * - the **elapsed clock**, a strip of pre-rendered second counts stepped by
 *   one row per second — a real clock, not an estimate;
 * - the **bar's creep inside the current segment**, an ease-out toward (but
 *   never past) the end of that system's slice, corrected to the true value
 *   the moment the system actually finishes;
 * - the **heartbeat dot** and the **slow-load notices**, whose appearance is a
 *   pure CSS `animation-delay` in `index.html` so they land at the right
 *   second even if nothing on the main thread is able to run.
 *
 * A frozen bar with a ticking clock means "busy". Everything frozen at once
 * means the tab is gone. That distinction is the whole point.
 */

/**
 * Measured `init()` cost per system, milliseconds, from `window.__INIT_TIMINGS`
 * on a warm load. Used only to weight the bar, so an error of a second or two
 * costs nothing; being wrong by an order of magnitude is what produces a bar
 * that races to 85% and then sits.
 *
 * `player`, `audio` and `interaction` have never been reported separately and
 * are estimates — they are collectively under 3% of init, so they cannot move
 * the bar much whichever way they are wrong.
 */
export const INIT_COST_MS: Record<string, number> = {
  terrain: 11000,
  building: 3440,
  pumps: 1690,
  vegetation: 1250,
  car: 1210,
  canopy: 490,
  lighting: 90,
  player: 150,
  audio: 300,
  interaction: 100,
};

/** For a system registered after this table was last corrected. */
const DEFAULT_COST_MS = 500;

/**
 * Plain language, not class names. The user is being told what is being made,
 * not which file is making it.
 */
const STEP_LABEL: Record<string, string> = {
  lighting: "raising the sun",
  terrain: "shaping the ground",
  pumps: "assembling the pumps",
  car: "parking the car",
  player: "finding your feet",
  building: "building the store",
  canopy: "raising the canopy",
  vegetation: "planting scrub and pines",
  audio: "tuning the morning air",
  interaction: "making things usable",
};

/**
 * The slice of the bar kept back for everything after the last `init()`:
 * shadow-map preallocation, then the first frame, where the driver compiles
 * every shader in the scene.
 *
 * 8% is wildly out of proportion to the time, and deliberately so. Measured
 * from `shots/boot/cold/frames.json`: init ends at 17.96 s and the scene is
 * ready at 205.79 s, so this stage is **187.9 s of a 205.8 s cold load —
 * 91.3% of it** — against roughly 2 s of a 21.6 s warm load. A 90x spread is
 * not something a bar can represent, which is exactly why this stage shows no
 * percentage at all: any figure would be invented, and an invented figure that
 * stops moving is the "stuck at 94%" this file exists to prevent. The 8% is
 * only there so the bar is visibly not finished.
 */
const SHADER_SHARE = 0.08;

/**
 * How far into its own slice the bar is allowed to creep on estimate alone.
 * The remainder is only ever crossed by a real `system-init-done`, so the bar
 * cannot arrive somewhere the scene has not.
 */
const CREEP_LIMIT = 0.96;

/**
 * The creep is stretched over this multiple of the measured cost, with an
 * ease-out, so a system that runs long still has bar left to move through
 * rather than stopping dead at its estimate.
 */
const CREEP_STRETCH = 3.5;

/** Rows in the elapsed-clock strip, and so the longest load it can display. */
const CLOCK_SECONDS = 600;
/** Must match `#boot .boot-clock` / `.boot-clock-strip i` height in index.html. */
const CLOCK_ROW_PX = 15;

/**
 * How long the overlay lingers when a system failed, so the failure is read
 * rather than replaced by a scene that is quietly missing something. This
 * project's signature fault is a plausible-looking frame with a system absent
 * from it.
 */
const FAILURE_HOLD_MS = 4000;

/**
 * `#loading` is mirrored with the live status text, and that is a deliberate
 * contract rather than a leftover.
 *
 * `tools/lightProbe.mjs`, `tools/reticleprobe.mjs` and `tools/shoot7.mjs` each
 * print `#loading`'s `textContent` as their diagnostic. When this overlay
 * replaced the old one-line `#loading`, the element was kept — `coldload.mjs`
 * times the first frame by watching for its removal — but nothing wrote into
 * it any more, so all three printed `""` in exactly the case they exist for.
 * `textContent` on an empty div is `""`, not null, so every truthiness guard
 * and optional chain in those files passed and the diagnostic degraded to
 * silence with nothing logged anywhere.
 *
 * Two fixes were available: point those three files at `#boot`'s status text,
 * or restore `#loading` as a status channel. This is the second, and the
 * deciding argument is not that it is less code.
 *
 * **All three fire when `__SCENE_READY` never arrives** — a hang, or an
 * exception that rejects `start()`. Only the second of those reaches
 * `reportBootFailure`. A load that dies inside `terrain.init()` never calls
 * it, so mirroring only the failure message would have left the *common* case
 * still printing an empty string: a fix that looks complete, passes review,
 * and silently does not cover the case it was written for. Mirroring the live
 * step label covers both, and makes the diagnostic strictly better than it was
 * before this overlay existed: instead of the constant `generating surfaces…`,
 * a hung load now names the system it hung in.
 *
 * One writer, six readers, documented at both ends. Anything that reads
 * `#loading`'s text — including a harness written next week from a sibling's
 * pattern — works without knowing this file exists.
 */
const STATUS_MIRROR_ID = "loading";

type InitEvent = CustomEvent<{ name: string }>;
type ActiveEvent = CustomEvent<{ names: string[] }>;

/**
 * Published so a harness can read the status *series* after the fact rather
 * than having to catch it live. Nothing on the main thread can be polled while
 * a system's `init()` is running, so "what was on screen at t=9 s" is not a
 * question that can be asked from outside at t=9 s; it can only be answered
 * from a trace recorded by the page itself.
 */
type StatusWindow = Window & {
  __BOOT_STATUS?: string;
  __BOOT_TRACE?: { t: number; text: string }[];
};

let installed = false;

/**
 * The single writer of the status text. Writes `#boot`'s visible label, the
 * `#loading` mirror the three probe harnesses read, and the trace.
 *
 * `#loading` is looked up every time rather than cached because `Game` removes
 * it on rendered frame 2 and a stale reference would keep writing into a
 * detached node — which is a mirror that reports the right thing to nobody.
 */
function publishStatus(stepEl: HTMLElement | null, visible: string, mirror = visible): void {
  if (stepEl) stepEl.textContent = visible;
  const el = document.getElementById(STATUS_MIRROR_ID);
  if (el) el.textContent = mirror;
  const w = window as StatusWindow;
  w.__BOOT_STATUS = mirror;
  (w.__BOOT_TRACE ??= []).push({ t: Math.round(performance.now()), text: mirror });
}

export function installLoadingScreen(): void {
  if (installed) return;
  const found = document.getElementById("boot");
  if (!found) return;
  const root: HTMLElement = found;
  installed = true;

  const q = (sel: string) => root.querySelector(sel) as HTMLElement | null;
  const fill = q(".boot-fill");
  const stepEl = q(".boot-step");
  const pctEl = q(".boot-pct");
  const failEl = q(".boot-fail");
  const strip = q(".boot-clock-strip");

  const setStatus = (visible: string, mirror?: string) => publishStatus(stepEl, visible, mirror);

  startClock(strip);
  // Populated before the first system starts, so a load that dies in module
  // evaluation or in `lighting` still has something to report.
  setStatus("starting up");

  /** Fraction of the bar that real completions have earned. */
  let earned = 0;
  let weights: Record<string, number> = {};
  let creep: Animation | null = null;
  let order: string[] = [];
  let doneCount = 0;

  const setFill = (v: number) => {
    creep?.cancel();
    creep = null;
    if (fill) fill.style.transform = `scaleX(${v.toFixed(4)})`;
  };

  /**
   * A step count, not a percentage, and that is a considered choice.
   *
   * This readout can only be written from the main thread, so it holds its
   * value for the whole of a system's `init()` — eleven seconds, for terrain.
   * A percentage that sits on "0%" while the bar beside it visibly creeps a
   * quarter of the way across contradicts itself, and the first captures did
   * exactly that. "2 of 10" is a discrete count of things that have actually
   * finished: it is *supposed* to hold still between them, so holding still
   * reads as correct rather than as broken. The continuous sense of progress
   * is the bar's job, and only the bar's.
   */
  const setStep = () => {
    if (pctEl) pctEl.textContent = order.length ? `${doneCount} of ${order.length}` : "";
  };

  window.addEventListener("systems-active", (e) => {
    order = (e as ActiveEvent).detail.names;
    const cost = (n: string) => INIT_COST_MS[n] ?? DEFAULT_COST_MS;
    const total = order.reduce((a, n) => a + cost(n), 0) || 1;
    weights = {};
    for (const n of order) weights[n] = (cost(n) / total) * (1 - SHADER_SHARE);
  });

  window.addEventListener("system-init-start", (e) => {
    const name = (e as InitEvent).detail.name;
    const w = weights[name] ?? 0;
    setStatus(STEP_LABEL[name] ?? name);
    setStep();
    // Compositor-side creep across this system's own slice. It is an estimate
    // and it is bounded by the slice, so it can be optimistic without ever
    // claiming a system finished that has not.
    if (fill && w > 0) {
      creep = fill.animate(
        [{ transform: `scaleX(${earned.toFixed(4)})` }, { transform: `scaleX(${(earned + w * CREEP_LIMIT).toFixed(4)})` }],
        {
          duration: (INIT_COST_MS[name] ?? DEFAULT_COST_MS) * CREEP_STRETCH,
          easing: "cubic-bezier(0.08, 0.72, 0.2, 1)",
          fill: "forwards",
        }
      );
    }
  });

  window.addEventListener("system-init-done", (e) => {
    const name = (e as InitEvent).detail.name;
    earned += weights[name] ?? 0;
    doneCount++;
    setFill(earned);
    setStep();
    if (doneCount >= order.length && order.length > 0) enterShaderStage();
  });

  function enterShaderStage() {
    setStatus("compiling shaders for your graphics card");
    setFill(1 - SHADER_SHARE);
    // No percentage here, deliberately. How long the driver takes to compile
    // this scene's programs is the single biggest unknown in a cold load, so
    // any number shown would be invented, and an invented number that stops
    // moving is exactly the "stuck at 94%" the rest of this file exists to
    // avoid. An explicitly indeterminate stage cannot stall at a figure it
    // never claimed.
    if (pctEl) pctEl.textContent = "";
    root.classList.add("indeterminate");
    if (fill) {
      creep = fill.animate(
        [{ transform: `scaleX(${(1 - SHADER_SHARE).toFixed(4)})` }, { transform: "scaleX(0.995)" }],
        { duration: 90_000, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", fill: "forwards" }
      );
    }
  }

  window.addEventListener("scene-ready", () => {
    root.classList.remove("indeterminate");
    setFill(1);
    if (pctEl) pctEl.textContent = "100%";
    setStatus("ready");

    const errors = window.__SYSTEM_ERRORS ?? [];
    // `?boothold=ms` keeps the overlay up past readiness so a capture harness
    // can photograph the 100% and failure states, which are otherwise on
    // screen for a single frame. Debug only; nothing reads it in normal play.
    const hold = Number(new URLSearchParams(location.search).get("boothold") ?? 0);

    if (errors.length && failEl) {
      failEl.hidden = false;
      failEl.textContent =
        `${errors.length} system${errors.length > 1 ? "s" : ""} failed to build and ${errors.length > 1 ? "are" : "is"} missing from the scene: ` +
        errors.map((f) => `${f.system} (${f.message})`).join("; ");
    }

    const wait = Math.max(hold, errors.length ? FAILURE_HOLD_MS : 0);
    if (wait > 0) window.setTimeout(dismiss, wait);
    else dismiss();
  });

  function dismiss() {
    root.remove();
  }

  /**
   * Only reachable when `start()` rejects outright, which the per-system
   * try/catch in `Game` makes rare — but when it happens the page is otherwise
   * a black rectangle with a stopped progress bar, which is the one state this
   * overlay must never present.
   */
  (window as unknown as { __bootFailed?: (m: string) => void }).__bootFailed = (message: string) => {
    root.classList.remove("indeterminate");
    root.classList.add("failed");
    // The visible label stays short — `.boot-fail` below carries the detail on
    // screen — but the mirror gets the whole message, because a harness reading
    // `#loading` has nothing else to go on.
    setStatus("the scene could not be built", `the scene could not be built: ${message}`);
    if (pctEl) pctEl.textContent = "";
    if (failEl) {
      failEl.hidden = false;
      failEl.textContent = message;
    }
  };
}

/** Reported by `main.ts` when `game.start()` rejects. */
export function reportBootFailure(err: unknown): void {
  const fn = (window as unknown as { __bootFailed?: (m: string) => void }).__bootFailed;
  fn?.(err instanceof Error ? err.message : String(err));
}

/**
 * A real elapsed-seconds readout that survives a blocked main thread.
 *
 * The strip holds one row per second and is stepped upward by one row per
 * second by a `transform` animation, which Chrome runs on the compositor. That
 * is the only mechanism available here that can display a *number* while
 * `terrain` is holding the main thread for eleven seconds; anything driven by
 * `setInterval`, `requestAnimationFrame` or a `Date` read would freeze for the
 * whole block and then jump, which is precisely the behaviour that makes a
 * slow load indistinguishable from a hung one.
 *
 * The negative delay pins second zero to navigation rather than to whenever
 * this module happened to be evaluated.
 */
function startClock(strip: HTMLElement | null): void {
  if (!strip) return;
  const rows: string[] = [];
  for (let s = 0; s <= CLOCK_SECONDS; s++) rows.push(`<i>${s}</i>`);
  strip.innerHTML = rows.join("");
  strip.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-CLOCK_ROW_PX * CLOCK_SECONDS}px)` }], {
    duration: CLOCK_SECONDS * 1000,
    easing: `steps(${CLOCK_SECONDS}, end)`,
    fill: "forwards",
    delay: -performance.now(),
  });
}
