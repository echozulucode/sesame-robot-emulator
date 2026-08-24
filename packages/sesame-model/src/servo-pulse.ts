/**
 * What a commanded angle actually does to the pin.
 *
 * The firmware offers 181 distinct commands (`constrain(angle + subtrim, 0,
 * 180)`), and the hardware cannot produce 181 distinct pulses. Two independent
 * facts get in the way, both properties of the **real robot** rather than of
 * any emulator:
 *
 * 1. **The attach window is not what the firmware asked for.**
 *    `sesame-firmware-main.ino:742` calls `attach(pin, 732, 2929)`, but
 *    `ESP32Servo::attach()` clamps the maximum to `MAX_PULSE_WIDTH` **before
 *    storing it** (`ESP32Servo.h:98` = 2500; `ESP32Servo.cpp:126`). The widest
 *    pulse the peripheral is ever asked for is therefore **2500 µs, not 2929**.
 *    Both numbers are true and they are not interchangeable:
 *    {@link ATTACH_MAX_PULSE_REQUESTED_US} is the call,
 *    {@link ATTACH_MAX_PULSE_US} is the pulse.
 *
 * 2. **The LEDC channels are 10-bit.** `DEFAULT_TIMER_WIDTH` is 10
 *    (`ESP32Servo.h:91`, confirmed at runtime as `duty_res = 10` in the LEDC
 *    register file), so a 20 ms frame is 1024 ticks of 19.53125 µs. Only ticks
 *    37…128 are reachable across 0–180°: **92 distinct pulse values for 181
 *    commands**, so **89 of the 181 angles are indistinguishable from a
 *    neighbour at the pin**.
 *
 * A simulator that reports 181 distinct positions is claiming a precision the
 * hardware does not have. {@link quantiseCommandedAngle} is how to find out
 * what a command really produces, and which other commands produce exactly the
 * same thing.
 *
 * Provenance: `docs/findings/Q3-ledc-fidelity.md` §3, §6.2, §6.4;
 * `hardware/hardware-map.json` → `servos.servoConfig.attachPulseClamp` and
 * `…pulseQuantisation`. The ESP32Servo citations are library-relative
 * (`ESP32Servo` **3.0.9**, pinned in `reproducibility.json` →
 * `libraries.ESP32Servo`, installed by `scripts/setup-firmware-toolchain.*`
 * into the gitignored `tools/` tree) because a repo path to it would not
 * survive a clean clone.
 *
 * **What this module is not:** it is not a measurement of a real servo. It
 * reproduces the library's arithmetic exactly, which settles what the *pin* is
 * asked to emit. Whether a physical MG90S lands where 2500 µs says is checklist
 * step **V6-14**, and nothing here should be read as having answered it.
 */

/** LEDC duty resolution ESP32Servo defaults to. `ESP32Servo.h:91`. */
export const SERVO_TIMER_WIDTH_BITS = 10;

/** `2 ** SERVO_TIMER_WIDTH_BITS` — ticks in one PWM frame. */
export const SERVO_TIMER_WIDTH_TICKS = 2 ** SERVO_TIMER_WIDTH_BITS;

/** One 50 Hz servo frame, in µs. ESP32Servo's `REFRESH_USEC`. */
export const SERVO_FRAME_US = 20000;

/** 19.53125 µs. The smallest pulse change the hardware can express. */
export const SERVO_US_PER_TICK = SERVO_FRAME_US / SERVO_TIMER_WIDTH_TICKS;

/**
 * Minimum pulse, µs. Passed **and** stored: 732 is above the library's
 * `MIN_PULSE_WIDTH` of 500, so unlike the maximum it is not clamped.
 */
export const ATTACH_MIN_PULSE_US = 732;

/**
 * **Effective** maximum pulse, µs — the number every angle↔pulse calculation
 * must use.
 */
export const ATTACH_MAX_PULSE_US = 2500;

/**
 * What `attach()` was actually **asked** for at
 * `firmware/sesame-firmware-main.ino:742`.
 *
 * Kept because the call is real and a future reader must be able to see why
 * this differs from {@link ATTACH_MAX_PULSE_US}. It is **not** a pulse width
 * that is ever emitted.
 */
export const ATTACH_MAX_PULSE_REQUESTED_US = 2929;

/** `ESP32Servo.h:98`, the constant that did the clamping. */
export const LIBRARY_MAX_PULSE_WIDTH_US = 2500;

/** `ESP32Servo.h:97`. Below it, `write()` treats its argument as degrees. */
export const LIBRARY_MIN_PULSE_WIDTH_US = 500;

/** The firmware's commandable domain: `constrain(angle + subtrim, 0, 180)`. */
export const COMMANDED_ANGLE_MIN_DEG = 0;

/** The firmware's commandable domain: `constrain(angle + subtrim, 0, 180)`. */
export const COMMANDED_ANGLE_MAX_DEG = 180;

/** What one commanded angle actually becomes on the way to the pin. */
export interface QuantisedServoPulse {
  /** The command, 0–180, as `setServoAngle()` would have clamped it. */
  readonly commandedDeg: number;
  /**
   * `map(deg, 0, 180, 732, 2500)` in Arduino's **integer** arithmetic —
   * the pulse the library intends, before the timer quantises it.
   */
  readonly mappedUs: number;
  /** LEDC duty ticks actually programmed. 37…128 across the whole range. */
  readonly ticks: number;
  /** `ticks × 19.53125` — what the pin is asked to emit. Not a measurement. */
  readonly pulseUs: number;
  /**
   * Every commanded angle that produces this exact tick count, **including
   * `commandedDeg` itself**, ascending. Length 1 means this command is
   * distinguishable; length > 1 means it is not.
   */
  readonly aliases: readonly number[];
  /** `aliases.length > 1` — this command is indistinguishable from another. */
  readonly aliased: boolean;
}

/** Arduino's `map()`: integer arithmetic, truncating toward zero. */
function arduinoMap(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin)) + outMin;
}

/** `ESP32Servo.cpp:260` `Servo::usToTicks()`, truncation included. */
function usToTicks(us: number): number {
  return Math.trunc(us / SERVO_US_PER_TICK);
}

const MIN_TICKS = usToTicks(ATTACH_MIN_PULSE_US);
const MAX_TICKS = usToTicks(ATTACH_MAX_PULSE_US);

/** `ESP32Servo.cpp:170` `Servo::writeTicks()` — the range guard. */
function ticksForAngle(deg: number): number {
  const us = arduinoMap(deg, COMMANDED_ANGLE_MIN_DEG, COMMANDED_ANGLE_MAX_DEG, ATTACH_MIN_PULSE_US, ATTACH_MAX_PULSE_US);
  return Math.min(MAX_TICKS, Math.max(MIN_TICKS, usToTicks(us)));
}

const ANGLE_COUNT = COMMANDED_ANGLE_MAX_DEG - COMMANDED_ANGLE_MIN_DEG + 1;

/**
 * `TICKS_BY_ANGLE[deg]` for every commandable degree, and the reverse index.
 *
 * Built by enumeration at module load rather than typed in, so the counts below
 * are derived from the arithmetic they describe and cannot drift from it.
 */
const TICKS_BY_ANGLE: readonly number[] = Object.freeze(
  Array.from({ length: ANGLE_COUNT }, (_, deg) => ticksForAngle(deg + COMMANDED_ANGLE_MIN_DEG)),
);

const ANGLES_BY_TICKS: ReadonlyMap<number, readonly number[]> = (() => {
  const byTicks = new Map<number, number[]>();
  TICKS_BY_ANGLE.forEach((ticks, i) => {
    const deg = i + COMMANDED_ANGLE_MIN_DEG;
    const bucket = byTicks.get(ticks);
    if (bucket) bucket.push(deg);
    else byTicks.set(ticks, [deg]);
  });
  for (const [ticks, bucket] of byTicks) byTicks.set(ticks, Object.freeze(bucket) as number[]);
  return byTicks;
})();

/**
 * The counts, derived — never asserted.
 *
 * `hardware/hardware-map.json` records the same numbers with their provenance;
 * `servo-pulse.test.ts` holds the two in agreement.
 */
export const SERVO_PULSE_QUANTISATION = Object.freeze({
  /** 181. What the firmware lets a caller ask for. */
  commandableAngles: ANGLE_COUNT,
  /** 92. What the pin can actually distinguish. */
  distinctPulseValues: ANGLES_BY_TICKS.size,
  /** 89. Commands that produce a pulse identical to some other command's. */
  aliasedAngleCount: ANGLE_COUNT - ANGLES_BY_TICKS.size,
  /** 37. */
  minTick: MIN_TICKS,
  /** 128. */
  maxTick: MAX_TICKS,
  /** 722.65625 µs — the *quantised* minimum, below the 732 µs requested. */
  minPulseUs: MIN_TICKS * SERVO_US_PER_TICK,
  /** 2500 µs exactly — 128 ticks lands on it. */
  maxPulseUs: MAX_TICKS * SERVO_US_PER_TICK,
  /** ≈1.978° of command per reachable pulse value. */
  degreesPerTick: (COMMANDED_ANGLE_MAX_DEG - COMMANDED_ANGLE_MIN_DEG) / (ANGLES_BY_TICKS.size - 1),
});

/**
 * What pulse a commanded angle actually produces, and which angles are
 * indistinguishable from it.
 *
 * ```ts
 * quantiseCommandedAngle(90).pulseUs;   // 1601.5625, not 1616
 * quantiseCommandedAngle(90).aliases;   // [89, 90] — 89° and 90° are the same pulse
 * quantiseCommandedAngle(180).pulseUs;  // 2500, not 2929
 * ```
 *
 * @param commandedDeg an **integer** 0–180. `setServoAngle()` has already
 *   applied `constrain(angle + subtrim, 0, 180)` by the time a command reaches
 *   the servo, so anything outside that range is a caller bug rather than
 *   something to silently absorb.
 * @throws RangeError if `commandedDeg` is not an integer in 0…180.
 */
export function quantiseCommandedAngle(commandedDeg: number): QuantisedServoPulse {
  if (
    !Number.isInteger(commandedDeg) ||
    commandedDeg < COMMANDED_ANGLE_MIN_DEG ||
    commandedDeg > COMMANDED_ANGLE_MAX_DEG
  ) {
    throw new RangeError(
      `commandedDeg must be an integer ${COMMANDED_ANGLE_MIN_DEG}..${COMMANDED_ANGLE_MAX_DEG} ` +
        `(the firmware's own clamp at sesame-firmware-main.ino:1053); received ${String(commandedDeg)}`,
    );
  }
  const ticks = TICKS_BY_ANGLE[commandedDeg - COMMANDED_ANGLE_MIN_DEG] as number;
  const aliases = ANGLES_BY_TICKS.get(ticks) as readonly number[];
  return Object.freeze({
    commandedDeg,
    mappedUs: arduinoMap(
      commandedDeg,
      COMMANDED_ANGLE_MIN_DEG,
      COMMANDED_ANGLE_MAX_DEG,
      ATTACH_MIN_PULSE_US,
      ATTACH_MAX_PULSE_US,
    ),
    ticks,
    pulseUs: ticks * SERVO_US_PER_TICK,
    aliases,
    aliased: aliases.length > 1,
  });
}

/**
 * The other commanded angles a servo cannot tell apart from this one.
 *
 * Empty when the command is distinguishable. This is
 * {@link quantiseCommandedAngle}`(deg).aliases` minus `deg` itself.
 */
export function anglesIndistinguishableFrom(commandedDeg: number): readonly number[] {
  return Object.freeze(quantiseCommandedAngle(commandedDeg).aliases.filter((d) => d !== commandedDeg));
}

/**
 * Every distinct pulse the servo can actually produce, ascending by tick.
 *
 * 92 entries. Useful for a UI that wants to draw the reachable set rather than
 * imply a continuum.
 */
export function reachablePulses(): readonly QuantisedServoPulse[] {
  return Object.freeze(
    [...ANGLES_BY_TICKS.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, angles]) => quantiseCommandedAngle(angles[0] as number)),
  );
}
