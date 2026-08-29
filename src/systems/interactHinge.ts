import * as THREE from "three";

/**
 * A door leaf on a pivot, driven by a rate that varies with how far open it is.
 *
 * Deliberately not a lerp between two angles over a fixed time. Both doors in
 * this station have closers on them, and a closer is the whole character of the
 * motion: you shove the leaf and it goes, then the arm takes over and brings it
 * back down to the latch, decelerating the whole way. A linear tween reads as a
 * prop being animated; this reads as a spring fighting a damper.
 *
 * Opening   `dp/dt = openBase + openLead * (1 - p)` — quickest off the latch,
 *            easing into the backcheck at the end of the swing.
 * Closing   `dp/dt = -(closeBase + closeGain * p * p)` — the arm has most
 *            leverage when the door is wide, so it slows continuously and
 *            creeps the last few degrees into the strike.
 *
 * Integrated in fixed sub-steps so the curve is the same at 30 fps and 165 fps;
 * plain Euler on a 100 ms frame would overshoot the ease and read as a snap.
 */
export interface HingeProfile {
  openBase: number;
  openLead: number;
  closeBase: number;
  closeGain: number;
}

/** Storefront door: heavy commercial closer, wide swing, slow latch. */
export const DOOR_CLOSER: HingeProfile = { openBase: 0.75, openLead: 3.35, closeBase: 0.30, closeGain: 2.05 };

/** Reach-in cooler: lighter leaf, sprung gasket, snappier both ways. */
export const COOLER_CLOSER: HingeProfile = { openBase: 1.15, openLead: 4.1, closeBase: 0.55, closeGain: 3.1 };

const SUBSTEP = 1 / 120;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface HingeStep {
  /** True on the frame the leaf settles onto the latch. */
  latched: boolean;
  /** True on the frame the leaf reaches the end of its swing. */
  opened: boolean;
  /** True if the angle changed at all this frame. */
  moved: boolean;
}

export class InteractHinge {
  readonly pivot: THREE.Object3D;
  readonly closedAngle: number;
  readonly openAngle: number;
  readonly span: number;

  /** 0 shut, 1 wide open. */
  amount: number;
  /** Where the leaf is heading. Any value in 0..1, not just the two ends. */
  target: number;

  private profile: HingeProfile;

  constructor(pivot: THREE.Object3D, profile: HingeProfile) {
    this.pivot = pivot;
    this.profile = profile;

    const ud = (pivot.userData ?? {}) as { closedAngle?: number; openAngle?: number };
    this.closedAngle = typeof ud.closedAngle === "number" ? ud.closedAngle : 0;
    const open = typeof ud.openAngle === "number" && Math.abs(ud.openAngle) > 1e-3 ? ud.openAngle : 1.5;
    this.openAngle = open;
    this.span = this.openAngle - this.closedAngle;

    // Adopt whatever pose the leaf is already in rather than slamming it shut.
    // BuildingSystem parks the entry door open for two of its own capture
    // presets and for `?bopen=1`; snapping those closed on the first frame
    // would break another system's shots.
    this.amount = clamp01(this.span === 0 ? 0 : (pivot.rotation.y - this.closedAngle) / this.span);
    this.target = this.amount;
    this.apply();
  }

  get isOpen(): boolean {
    return this.target > 0.5;
  }

  /** Returns true if the command opens it. */
  toggle(): boolean {
    this.target = this.isOpen ? 0 : 1;
    return this.target > 0.5;
  }

  update(dt: number): HingeStep {
    const before = this.amount;
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-6) {
      const h = Math.min(SUBSTEP, remaining);
      remaining -= h;
      const p = this.amount;
      const d = this.target - p;
      if (Math.abs(d) < 1e-4) {
        this.amount = this.target;
        break;
      }
      const rate =
        d > 0
          ? this.profile.openBase + this.profile.openLead * (1 - p)
          : -(this.profile.closeBase + this.profile.closeGain * p * p);
      const next = p + rate * h;
      // Never step past the target: the closing rate goes to `closeBase` at
      // p = 0, which would otherwise push the leaf through the frame.
      this.amount = d > 0 ? Math.min(next, this.target) : Math.max(next, this.target);
    }
    this.amount = clamp01(this.amount);
    const moved = Math.abs(this.amount - before) > 1e-6;
    if (moved) this.apply();
    return {
      moved,
      latched: before > 1e-3 && this.amount <= 1e-3,
      opened: before < 0.999 && this.amount >= 0.999,
    };
  }

  private apply(): void {
    this.pivot.rotation.y = this.closedAngle + this.span * this.amount;
  }
}
