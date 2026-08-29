/**
 * Sub-phase timing inside one system's `init()`.
 *
 * ## Why this exists
 *
 * `Game.ts` times each system's `init()` and publishes the result as
 * `window.__INIT_TIMINGS`. That was enough to find *which* system owns init:
 * 22.4 s of a 25.2 s load is system init, and one system is 14.27 s of it,
 * 63.6%, which is 7.6× the entire scene's shader compilation.
 *
 * It is not enough to find *what inside* that system is expensive, and that
 * question belongs to whoever owns the file. This is the same two-call shape,
 * one level down, so a system owner does not have to build one.
 *
 * ## Use
 *
 * ```ts
 * init(ctx: SystemContext): void {
 *   const phase = initPhases("terrain");
 *
 *   phase("material library");
 *   const asphaltMaps = makeAsphalt(2048, 8, 1337);
 *   const concreteMaps = makeConcrete(1024, 4, 99);
 *
 *   phase("ground mesh");
 *   // ...
 *
 *   phase("scattered stones");
 *   // ...
 *
 *   phase.end();
 * }
 * ```
 *
 * Each `phase(label)` closes the previous phase and opens a new one, so the
 * boundaries are exactly the section comments most `init()` methods already
 * have. `phase.end()` closes the last one and publishes.
 *
 * For a single expensive call there is `phase.of`:
 *
 * ```ts
 * const maps = phase.of("asphalt 2048", () => makeAsphalt(2048, 8, 1337));
 * ```
 *
 * ## It reports what it does not account for
 *
 * `phase.end()` logs the labelled total *and* the unaccounted remainder — the
 * wall time between construction and `end()` that no phase claimed. A helper
 * that only reported the phases it was given would let a system instrument
 * three cheap sections, see them sum to 400 ms, and conclude init was fast,
 * with 13 s sitting in the gaps. The remainder makes that impossible to miss.
 *
 * That is deliberate and it is the same rule the texture table follows: 85% of
 * the card attributed with the remainder named as unknown is worth more than
 * 100% attributed by guessing.
 *
 * ## The one caveat
 *
 * `performance.now()` deltas around an `await` include anything else the event
 * loop ran in the meantime. `Game.ts` awaits each system's `init()` in turn, so
 * inside one system there is usually nothing else to interleave — but a phase
 * that awaits a shared resource another system is also waiting on will absorb
 * that wait. Prefer phase boundaries around synchronous work.
 *
 * Instrumentation only. No behaviour depends on it, and reading
 * `window.__INIT_PHASES` is optional for every consumer.
 */

export interface InitPhases {
  /** Close the current phase, if any, and open one labelled `label`. */
  (label: string): void;
  /** Time a single call as its own phase, returning its result. */
  of<T>(label: string, fn: () => T): T;
  /** Close the last phase, publish, and log. Safe to call twice. */
  end(): void;
}

interface PhaseRecord {
  label: string;
  ms: number;
}

export interface InitPhaseReport {
  system: string;
  /** Wall time from `initPhases()` to `end()`. */
  totalMs: number;
  /** Sum of the labelled phases. */
  accountedMs: number;
  /** `totalMs - accountedMs`: real time that no phase claimed. */
  unaccountedMs: number;
  phases: PhaseRecord[];
}

type PhaseWindow = Window & { __INIT_PHASES?: Record<string, InitPhaseReport> };

/**
 * @param system  the system's name, matching its `GameSystem.name` so the
 *                report lines up with `window.__INIT_TIMINGS`.
 */
export function initPhases(system: string): InitPhases {
  const t0 = performance.now();
  const phases: PhaseRecord[] = [];
  let openLabel: string | null = null;
  let openAt = t0;
  let ended = false;

  const close = () => {
    if (openLabel === null) return;
    const ms = performance.now() - openAt;
    // Repeated labels accumulate rather than appearing twice, so a loop that
    // re-enters a phase reads as one line with the total cost.
    const existing = phases.find((p) => p.label === openLabel);
    if (existing) existing.ms += ms;
    else phases.push({ label: openLabel, ms });
    openLabel = null;
  };

  const phase = ((label: string) => {
    if (ended) return;
    close();
    openLabel = label;
    openAt = performance.now();
  }) as InitPhases;

  phase.of = <T>(label: string, fn: () => T): T => {
    phase(label);
    try {
      return fn();
    } finally {
      close();
    }
  };

  phase.end = () => {
    if (ended) return;
    ended = true;
    close();
    const totalMs = performance.now() - t0;
    const accountedMs = phases.reduce((a, p) => a + p.ms, 0);
    const report: InitPhaseReport = {
      system,
      totalMs,
      accountedMs,
      unaccountedMs: totalMs - accountedMs,
      phases: [...phases].sort((a, b) => b.ms - a.ms),
    };
    const w = window as PhaseWindow;
    w.__INIT_PHASES ??= {};
    w.__INIT_PHASES[system] = report;

    const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    console.log(
      `[${system}] init ${s(totalMs)} = ` +
        report.phases.map((p) => `${p.label} ${s(p.ms)}`).join(", ") +
        (report.unaccountedMs > 1 ? `, UNACCOUNTED ${s(report.unaccountedMs)}` : "")
    );
  };

  return phase;
}
