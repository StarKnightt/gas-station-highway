/**
 * The reticle — the only non-diegetic thing this project draws.
 *
 * `InteractionSystem`'s header states the case against it, and that case was
 * right: standing in front of something real is a better affordance than a
 * dot. It is overridden here on one specific ground, which is worth recording
 * because it is the only ground that justifies it. The scene is going to be
 * *recorded*, and on camera a player hunting for the exact pixel that a pump
 * responds to reads as software that does not work. A viewer cannot see the
 * player's intent, so a failed click is indistinguishable from a broken pump.
 *
 * ## Two elements, one signal
 *
 * **The dot** is the reach signal and does the same job it always did. Idle it
 * is a 6 px dot at 30% white behind a 1 px dark ring — enough to aim with, not
 * enough to look at. In reach it goes to 92% white and scales 1.45x.
 *
 * **The prompt** was added after the user walked the build and asked to be
 * told what the action is, having previously chosen the wordless version. It
 * is one line under the dot, no panel and no icon, and it fades in on the same
 * 110 ms curve so the two read as one element rather than as a dot plus a
 * label. It names the *specific* action — "press E to start the pump", not
 * "interact" — because the specificity is the whole value of adding text.
 *
 * ## The wording lives here, and that is the point
 *
 * `InteractionSystem` hands over a string it derived from the same `pick()`
 * result that decides what a click and what the E key will do, and from the
 * same hinge and session state that `act()` branches on. So the verb cannot
 * disagree with the action: if the prompt says "close the cooler", the door is
 * open, and the toggle it is about to run will close it. Nothing in
 * `index.html` authors any wording, so there is no second copy to drift.
 *
 * ## Three things that are load-bearing rather than styling
 *
 * **It is DOM, not geometry.** No draw call, no shader, no material to keep in
 * sync with a program cache key, and — the reason that actually decided it —
 * nothing downstream of tone mapping or the post rig can change it. Drawn in
 * the scene it would dim and warm with the exposure, which is exactly the
 * surface it has to stay readable against.
 *
 * **Both elements carry their own contrast.** White alone disappears into the
 * dawn sky (measured at luma 220 on the sun side); dark alone disappears into
 * asphalt (luma 22). The dot's dark ring and the prompt's double text-shadow
 * are the same answer to the same problem, and both are edges rather than
 * plates so neither reads as a panel.
 *
 * **It is hidden unless pointer lock is engaged.** Same rule the pre-lock HUD
 * card follows, in the opposite direction, so exactly one of the two is on
 * screen at any moment and neither can turn up in a screenshot of the state it
 * does not belong to.
 *
 * The nodes live in `index.html` next to the HUD card rather than being created
 * here, so the whole visual definition is in one place a person can read
 * without running anything. If any of them is missing this degrades to nothing
 * at all: `present` / `promptPresent` go false, `window.__RETICLE()` says so,
 * and every other part of the interaction system is untouched.
 */

export interface ReticleReport {
  /** False when index.html carries no #reticle node — then nothing is drawn. */
  present: boolean;
  /** False when the node has no `.prompt` child — the dot still works. */
  promptPresent: boolean;
  /** Currently on screen at all. Tracks pointer lock. */
  shown: boolean;
  /** Currently in the brightened state, i.e. the prompt is faded in. */
  reach: boolean;
  /** The wording on screen right now, verbatim. Empty before the first hover. */
  prompt: string;
  /** Why it is shown or not, for a harness that finds it in the wrong state. */
  why: string;
}

declare global {
  interface Window {
    /** Live reticle state. A harness asserts on this *and* on pixels. */
    __RETICLE?: () => ReticleReport;
  }
}

export class Reticle {
  private el: HTMLElement | null;
  private promptEl: HTMLElement | null;
  /** Mirrors of the DOM, so a steady frame touches nothing. */
  private shown = false;
  private reach = false;
  private prompt = "";
  private why = "not yet updated";

  constructor() {
    this.el = typeof document === "undefined" ? null : document.getElementById("reticle");
    this.promptEl = this.el?.querySelector<HTMLElement>(".prompt") ?? null;
    if (!this.el) {
      console.warn("[reticle] no #reticle element in the page — the reticle is disabled");
    } else if (!this.promptEl) {
      console.warn("[reticle] #reticle has no .prompt child — the dot works, the wording will not appear");
    }
    if (typeof window !== "undefined") {
      window.__RETICLE = () => ({
        present: !!this.el,
        promptPresent: !!this.promptEl,
        shown: this.shown,
        reach: this.reach,
        prompt: this.prompt,
        why: this.why,
      });
    }
  }

  /**
   * `shown` is pointer lock; `reach` is whether the interaction ray is on
   * something usable *right now*; `prompt` is the wording for whatever it is
   * on. All three are decided by the caller — this holds no policy, so there is
   * exactly one place in the tree that decides when the reticle lights up and
   * what it says, and it is the same place that decides what a click does.
   */
  set(shown: boolean, reach: boolean, prompt: string, why: string): void {
    this.why = why;
    const el = this.el;
    if (!el) return;
    if (shown !== this.shown) {
      this.shown = shown;
      el.classList.toggle("shown", shown);
    }
    // Only meaningful while visible, and clearing it on hide means the reticle
    // never comes back mid-transition in the bright state from a stale hover.
    const r = shown && reach;
    if (r !== this.reach) {
      this.reach = r;
      el.classList.toggle("reach", r);
    }
    // Written only while something is in reach, and deliberately *not* cleared
    // on the way out: the text fades over 110 ms, and blanking it on the frame
    // the ray leaves the object would make the wording vanish instantly while
    // its own opacity was still animating. So the last prompt fades out intact,
    // which is what the eye expects, and is replaced only when there is
    // something new to say.
    if (r && prompt && prompt !== this.prompt) {
      this.prompt = prompt;
      if (this.promptEl) this.promptEl.textContent = prompt;
    }
  }

  dispose(): void {
    this.set(false, false, "", "disposed");
    if (this.promptEl) this.promptEl.textContent = "";
    this.prompt = "";
    if (typeof window !== "undefined" && window.__RETICLE) delete window.__RETICLE;
    this.el = null;
    this.promptEl = null;
  }
}
