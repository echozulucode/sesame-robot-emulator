/**
 * Real-time playback: a pacer wrapped around the virtual-time model.
 *
 * The model itself is unchanged — it still advances its own clock and still
 * yields at every cooperative pump. All this does is decide how long a yield
 * takes in wall-clock terms. That is the whole reason the interpreter is a
 * generator: "run this gait at robot speed in a browser" and "run this gait in
 * 200 µs inside a test" differ only in the driver.
 */
import type { Pump } from './machine.js';

/** Sleep helper. Injected in tests so nothing has to wait for real seconds. */
export type Sleep = (ms: number) => Promise<void>;

/** The default: `setTimeout`. */
export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Pacing knobs for {@link driveRealtime}. */
export interface RealtimeOptions {
  /** Wall-clock speed multiplier. `2` runs twice as fast. Default `1`. */
  readonly speed?: number;
  /** Wall clock, in milliseconds. Default `Date.now`. */
  readonly wallNowMs?: () => number;
  /** Default {@link defaultSleep}. */
  readonly sleep?: Sleep;
  /**
   * Do not sleep for less than this. Default `1` ms.
   *
   * `delayWithFace()` pumps every 5 virtual ms, and `pressingCheck()` every
   * virtual millisecond; without a floor, a fast host would issue a `setTimeout`
   * per pump and spend more time in the timer queue than in the model.
   */
  readonly minSleepMs?: number;
}

/**
 * Drive a machine generator at wall-clock speed.
 *
 * Pacing is anchored, not incremental: each sleep is computed from the *total*
 * virtual time elapsed since the drive started, so a slow host falls behind and
 * catches up rather than accumulating error at every pump.
 */
export async function driveRealtime<T>(
  generator: Generator<Pump, T, void>,
  options: RealtimeOptions = {},
): Promise<T> {
  const speed = options.speed ?? 1;
  const wallNowMs = options.wallNowMs ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const minSleepMs = options.minSleepMs ?? 1;

  let result = generator.next();
  if (result.done === true) return result.value;

  const virtualAnchor = result.value.atMs;
  const wallAnchor = wallNowMs();

  while (result.done !== true) {
    const owedMs = (result.value.atMs - virtualAnchor) / speed - (wallNowMs() - wallAnchor);
    if (owedMs >= minSleepMs) await sleep(owedMs);
    result = generator.next();
  }
  return result.value;
}
