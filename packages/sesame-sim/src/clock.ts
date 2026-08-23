/**
 * Virtual time.
 *
 * The whole model runs on a clock it is handed. Nothing in the interpreter ever
 * calls `Date.now()`, `performance.now()` or `setTimeout`; it asks the clock for
 * the time and tells the clock to advance. That is what makes the event stream
 * reproducible, what lets a 30-second gait execute in a millisecond of test
 * time, and what will later let a lesson scrub backwards and forwards over a
 * recorded run.
 *
 * Real-time playback is a *pacer* wrapped around this, never a second
 * implementation — see `realtime.ts`.
 */

/** A monotonic virtual millisecond clock the simulator drives itself. */
export interface SimClock {
  /** Current virtual time, in milliseconds. Equivalent to Arduino `millis()`. */
  nowMs(): number;
  /** Advance by `deltaMs`. Must be non-negative; time never runs backwards. */
  advanceMs(deltaMs: number): void;
}

/** The default clock: an integer counter and nothing else. */
export class VirtualClock implements SimClock {
  #ms: number;

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs)) throw new TypeError('startMs must be finite');
    this.#ms = startMs;
  }

  nowMs(): number {
    return this.#ms;
  }

  advanceMs(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError(`clock cannot advance by ${deltaMs}`);
    }
    this.#ms += deltaMs;
  }
}
