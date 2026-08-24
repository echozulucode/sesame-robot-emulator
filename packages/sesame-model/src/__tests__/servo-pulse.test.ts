/**
 * The quantisation facts, held to — and held against `hardware-map.json`.
 *
 * Two mistakes this file exists to make loud:
 *
 * 1. **Re-introducing 2929 µs as a pulse width.** It is the value
 *    `attach(pin, 732, 2929)` passes and it is not a pulse anything emits:
 *    `ESP32Servo::attach()` clamps to `MAX_PULSE_WIDTH` (2500) before storing.
 *    Q3 confirmed it independently by measurement — 180° produced 12 % duty at
 *    a 20 ms frame, which is 2500 µs; 2929 µs would have been 14.6 %.
 * 2. **Claiming 181 distinct servo positions.** There are 92. The other 89
 *    commands land on a neighbour's tick.
 *
 * The counts are recomputed here from the library's own arithmetic and then
 * cross-checked against the numbers `hardware/hardware-map.json` publishes, so
 * the two artefacts cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ATTACH_MAX_PULSE_REQUESTED_US,
  ATTACH_MAX_PULSE_US,
  ATTACH_MIN_PULSE_US,
  SERVO_FRAME_US,
  SERVO_PULSE_QUANTISATION,
  SERVO_TIMER_WIDTH_BITS,
  SERVO_TIMER_WIDTH_TICKS,
  SERVO_US_PER_TICK,
  anglesIndistinguishableFrom,
  quantiseCommandedAngle,
  reachablePulses,
} from '../servo-pulse.js';

const here = dirname(fileURLToPath(import.meta.url));
const HARDWARE_MAP_PATH = resolve(here, '..', '..', '..', '..', 'hardware', 'hardware-map.json');

interface ServoConfigShape {
  readonly attachMinPulseUs: number;
  readonly attachMaxPulseUs: number;
  readonly attachMaxPulseRequestedUs: number;
  readonly attachPulseClamp: {
    readonly requestedMaxUs: number;
    readonly effectiveMaxUs: number;
    readonly maxClamped: boolean;
    readonly minClamped: boolean;
  };
  readonly pulseQuantisation: {
    readonly timerWidthBits: number;
    readonly usPerTick: number;
    readonly minTick: number;
    readonly maxTick: number;
    readonly commandableAngles: number;
    readonly distinctReachablePulseValues: number;
    readonly aliasedAngleCount: number;
  };
}

function servoConfig(): ServoConfigShape {
  const map = JSON.parse(readFileSync(HARDWARE_MAP_PATH, 'utf8')) as {
    servos: { servoConfig: ServoConfigShape };
  };
  return map.servos.servoConfig;
}

describe('the attach window is not the window the firmware asked for', () => {
  it('records the requested value and the effective value as different numbers', () => {
    expect(ATTACH_MAX_PULSE_REQUESTED_US).toBe(2929);
    expect(ATTACH_MAX_PULSE_US).toBe(2500);
    expect(ATTACH_MAX_PULSE_US).toBeLessThan(ATTACH_MAX_PULSE_REQUESTED_US);
  });

  it('never emits the requested 2929 µs at any commandable angle', () => {
    for (let deg = 0; deg <= 180; deg += 1) {
      expect(quantiseCommandedAngle(deg).pulseUs).toBeLessThanOrEqual(ATTACH_MAX_PULSE_US);
    }
  });

  it('leaves the minimum unclamped, because 732 is above MIN_PULSE_WIDTH 500', () => {
    expect(ATTACH_MIN_PULSE_US).toBe(732);
    expect(quantiseCommandedAngle(0).mappedUs).toBe(732);
  });

  it('puts 180° at 12 % duty, which is what Q3 measured — not the 14.6 % 2929 µs implies', () => {
    const top = quantiseCommandedAngle(180);
    expect(top.pulseUs).toBe(2500);
    // The LEDC model's own integer arithmetic: duty% = duty / (2^res - 1) * 100.
    const dutyPct = (top.ticks / (SERVO_TIMER_WIDTH_TICKS - 1)) * 100;
    expect(Math.trunc(dutyPct)).toBe(12);
    expect(Math.trunc((ATTACH_MAX_PULSE_REQUESTED_US / SERVO_FRAME_US) * 100)).toBe(14);
  });
});

describe('10-bit resolution means angles alias', () => {
  it('is 10 bits, 1024 ticks, 19.53125 µs each', () => {
    expect(SERVO_TIMER_WIDTH_BITS).toBe(10);
    expect(SERVO_TIMER_WIDTH_TICKS).toBe(1024);
    expect(SERVO_US_PER_TICK).toBe(19.53125);
  });

  it('reaches 92 distinct pulses across 181 commands, aliasing 89 of them', () => {
    expect(SERVO_PULSE_QUANTISATION.commandableAngles).toBe(181);
    expect(SERVO_PULSE_QUANTISATION.distinctPulseValues).toBe(92);
    expect(SERVO_PULSE_QUANTISATION.aliasedAngleCount).toBe(89);
    expect(reachablePulses()).toHaveLength(92);
  });

  it('spans ticks 37…128, i.e. 722.65625…2500 µs', () => {
    expect(SERVO_PULSE_QUANTISATION.minTick).toBe(37);
    expect(SERVO_PULSE_QUANTISATION.maxTick).toBe(128);
    expect(SERVO_PULSE_QUANTISATION.minPulseUs).toBeCloseTo(722.65625, 5);
    expect(SERVO_PULSE_QUANTISATION.maxPulseUs).toBe(2500);
  });

  it('agrees with the seven angles Q3 published from the LEDC trace', () => {
    // docs/findings/Q3-ledc-fidelity.md §3. Pulse µs to 1 decimal place, as printed there.
    const expected: ReadonlyArray<readonly [number, number, number]> = [
      // [commanded deg, ticks, pulse µs]
      [0, 37, 722.7],
      [45, 60, 1171.9],
      [80, 77, 1503.9],
      [90, 82, 1601.6],
      [100, 87, 1699.2],
      [135, 105, 2050.8],
      [180, 128, 2500.0],
    ];
    for (const [deg, ticks, us] of expected) {
      const q = quantiseCommandedAngle(deg);
      expect(q.ticks).toBe(ticks);
      expect(q.pulseUs).toBeCloseTo(us, 1);
    }
  });

  it('names the neighbours a command cannot be told apart from', () => {
    const ninety = quantiseCommandedAngle(90);
    expect(ninety.aliased).toBe(true);
    expect(ninety.aliases).toContain(90);
    // Every alias really does produce the identical tick count.
    for (const deg of ninety.aliases) {
      expect(quantiseCommandedAngle(deg).ticks).toBe(ninety.ticks);
    }
    expect(anglesIndistinguishableFrom(90)).not.toContain(90);
    expect(anglesIndistinguishableFrom(90).length).toBe(ninety.aliases.length - 1);
  });

  it('counts exactly 89 aliased commands by walking all 181', () => {
    let aliased = 0;
    for (let deg = 0; deg <= 180; deg += 1) {
      if (quantiseCommandedAngle(deg).aliased) aliased += 1;
    }
    // 89 angles are surplus to the 92 reachable values; the number of angles
    // that SHARE a tick with someone is larger, because sharing is mutual.
    expect(aliased).toBeGreaterThan(SERVO_PULSE_QUANTISATION.aliasedAngleCount);
    const distinct = new Set(
      Array.from({ length: 181 }, (_, deg) => quantiseCommandedAngle(deg).ticks),
    );
    expect(181 - distinct.size).toBe(89);
  });

  it('rejects a command outside the firmware clamp rather than absorbing it', () => {
    expect(() => quantiseCommandedAngle(181)).toThrow(RangeError);
    expect(() => quantiseCommandedAngle(-1)).toThrow(RangeError);
    expect(() => quantiseCommandedAngle(90.5)).toThrow(RangeError);
  });
});

describe('hardware-map.json publishes the same numbers', () => {
  it('matches the attach clamp', () => {
    const sc = servoConfig();
    expect(sc.attachMinPulseUs).toBe(ATTACH_MIN_PULSE_US);
    expect(sc.attachMaxPulseUs).toBe(ATTACH_MAX_PULSE_US);
    expect(sc.attachMaxPulseRequestedUs).toBe(ATTACH_MAX_PULSE_REQUESTED_US);
    expect(sc.attachPulseClamp.maxClamped).toBe(true);
    expect(sc.attachPulseClamp.minClamped).toBe(false);
  });

  it('matches the quantisation counts', () => {
    const q = servoConfig().pulseQuantisation;
    expect(q.timerWidthBits).toBe(SERVO_TIMER_WIDTH_BITS);
    expect(q.usPerTick).toBe(SERVO_US_PER_TICK);
    expect(q.minTick).toBe(SERVO_PULSE_QUANTISATION.minTick);
    expect(q.maxTick).toBe(SERVO_PULSE_QUANTISATION.maxTick);
    expect(q.commandableAngles).toBe(SERVO_PULSE_QUANTISATION.commandableAngles);
    expect(q.distinctReachablePulseValues).toBe(SERVO_PULSE_QUANTISATION.distinctPulseValues);
    expect(q.aliasedAngleCount).toBe(SERVO_PULSE_QUANTISATION.aliasedAngleCount);
  });
});
