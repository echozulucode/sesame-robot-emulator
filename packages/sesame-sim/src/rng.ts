/**
 * A tiny seeded PRNG, and why the simulator has one at all.
 *
 * The firmware calls `randomSeed(micros())` at boot
 * (`sesame-firmware-main.ino:653`) and then uses `random()` for two things
 * only: the 3–7 s gap between idle blinks and the 30 % double-blink chance
 * (`sesame-firmware-main.ino:1016`, `:1030`). On real silicon those are
 * genuinely non-reproducible.
 *
 * A deterministic event stream is worth more to this project than reproducing
 * that non-determinism, so the simulator substitutes a seeded generator and
 * says so. This is a **simulation choice**, not a firmware property.
 */

/** Uniform generator over `[0, 1)`. Inject your own for a different stream. */
export type Rng = () => number;

/**
 * mulberry32 — 32 bits of state, one multiply-xorshift round, uniform enough
 * for blink timing and short enough to audit at a glance.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Arduino's `random(min, max)`: an integer in `[min, max)`.
 *
 * Both call sites in the firmware pass `min < max`, so the AVR-core edge case
 * where `max <= min` returns `min` is reproduced rather than guarded.
 */
export function randomInt(rng: Rng, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min));
}
