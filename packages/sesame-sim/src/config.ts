/**
 * Everything the simulator needs that is *not* fixed by the firmware, kept in
 * one place and labelled.
 *
 * Two categories live here and they are never mixed:
 *
 * - **Firmware constants** — a literal in `sesame-firmware-main.ino`, cited.
 *   Changing one of these makes the model disagree with the robot.
 * - **Simulation choices** — something the firmware does not determine
 *   (a busy-loop's period, how fast a servo slews, which PRNG seed). Each one
 *   carries the reason it has the value it has.
 */
import { mulberry32, type Rng } from './rng.js';
import { CHOREOGRAPHY } from './generated/choreography.js';
import type { LogChannel } from '@sesame-lab/sesame-protocol';

// ---------------------------------------------------------------------------
// Firmware constants
// ---------------------------------------------------------------------------

/**
 * `int motorCurrentDelay = 20;` — the stagger after every servo write.
 * Read from the extracted map rather than written as `20`, so the model tracks
 * the firmware if the literal ever changes. `sesame-firmware-main.ino:119`.
 */
export const MOTOR_CURRENT_DELAY_MS = CHOREOGRAPHY.motorCurrentDelayMs;

/** `int faceFps = 8;` — the global fallback fps. `sesame-firmware-main.ino:57`. */
export const DEFAULT_FACE_FPS = 8;

/** `int frameDelay = 100;` — the `pressingCheck()` window. `:117`. */
export const DEFAULT_FRAME_DELAY_MS = 100;

/** `int walkCycles = 10;` — the gait loop bound. `:118`. */
export const DEFAULT_WALK_CYCLES = 10;

/**
 * `delay(5)` at the bottom of `delayWithFace()`'s spin loop. `:1001`.
 *
 * This is a firmware constant, not a knob: it sets the granularity at which a
 * servo delay pumps face animation, HTTP and DNS, and therefore how many times
 * a 20 ms `motorCurrentDelay` re-enters the face driver (four).
 */
export const DELAY_WITH_FACE_QUANTUM_MS = 5;

/** `String currentFaceName = "default";` at power-on. `:52`. */
export const POWER_ON_FACE_NAME = 'default';

// ---------------------------------------------------------------------------
// Simulation choices
// ---------------------------------------------------------------------------

/**
 * How the simulator advances time.
 *
 * - `virtual` — time only moves when the model says it does. Deterministic,
 *   instant, and what every test uses.
 * - `realtime` — the same model, with a wall-clock sleep at each cooperative
 *   yield so playback runs at the robot's speed. A wrapper over `virtual`,
 *   never a separate implementation.
 */
export type TimeMode = 'virtual' | 'realtime';

/** Options for {@link SimulatedSesameRobot}. Every field has a documented default. */
export interface SimulatedRobotOptions {
  /** Default `'virtual'`. */
  readonly timeMode?: TimeMode;

  /** Virtual milliseconds at power-on. Default `0`. */
  readonly startTimeMs?: number;

  /**
   * Seed for the idle-blink PRNG. Default `1`.
   *
   * **Simulation choice.** The firmware seeds from `micros()`
   * (`sesame-firmware-main.ino:653`) and is therefore not reproducible; a fixed
   * seed is what makes the event stream byte-identical between runs.
   */
  readonly seed?: number;

  /** Supply your own generator instead of seeding the built-in one. */
  readonly rng?: Rng;

  /** Per-channel subtrim in firmware index order. Default all zeros (`:113`). */
  readonly subtrimDeg?: readonly number[];

  /**
   * `commandedDeg` for a channel that has not been written yet. Default `90`.
   *
   * **Simulation choice, and a genuinely undetermined one.** `setup()` calls
   * `servos[i].attach(pin, 732, 2929)` — the call, not the pulse: ESP32Servo
   * clamps the max to 2500 µs, `@sesame-lab/sesame-model` `ATTACH_MAX_PULSE_US`
   * — and then deliberately does *not* command
   * an angle — the comment at `sesame-firmware-main.ino:746` reads "Show rest
   * face on startup without moving motors". Where a horn actually sits at that
   * moment depends on the servo's own power-on behaviour and on where the
   * builder left it, and nothing in the firmware knows. 90 is used because it
   * is the assembly datum: the build guide's calibration step commands every
   * motor to 90° with no horn fitted, and `runRestPose` is the one pose that
   * writes 90 to all eight (F6 §3.3). `RobotState.joints[j].commandedDeg` is a
   * required `number`, so some value has to appear; the accompanying
   * `everCommanded` flag in {@link SimulatedRobotState} is how a UI tells the
   * difference between "commanded to 90" and "never commanded".
   */
  readonly powerOnDeg?: number;

  /** `motorCurrentDelay`, runtime-settable on the robot via `/setSettings`. Default 20 (`:119`). */
  readonly motorCurrentDelayMs?: number;

  /** `frameDelay`. Default 100 (`:117`). */
  readonly frameDelayMs?: number;

  /** `walkCycles`. Default 10 (`:118`). */
  readonly walkCycles?: number;

  /** `faceFps` global fallback. Default 8 (`:57`). */
  readonly faceFps?: number;

  /**
   * Period of the `pressingCheck()` busy loop, in virtual milliseconds.
   * Default `1`.
   *
   * **Simulation choice.** `pressingCheck()` spins on `yield()` with no delay
   * (`sesame-firmware-main.ino:1064`), so it has no firmware-defined period at
   * all. 1 ms is fine-grained enough that a face frame flips within a
   * millisecond of when it is due, and coarse enough that a 100 ms window costs
   * 100 iterations rather than a million.
   */
  readonly spinQuantumMs?: number;

  /**
   * Period of one `loop()` iteration while no command is running, in virtual
   * milliseconds. Default `1`.
   *
   * **Simulation choice**, for the same reason: `loop()` has no delay in it.
   */
  readonly loopQuantumMs?: number;

  /**
   * Servo slew rate for `simulatedDeg`, in degrees per second, or `null` for
   * "snaps instantly to the commanded angle". Default `600`.
   *
   * **Simulation choice, and the one most likely to be mistaken for a
   * measurement.** 600 °/s is the MG90S datasheet figure (0.1 s per 60° at
   * 4.8 V) with no load, no gear backlash and no supply sag. Nobody has timed
   * this robot's servos. `measuredDeg` stays `null` no matter what this is set
   * to, because the stock robot has no position feedback at all.
   */
  readonly slewDegPerSec?: number | null;

  /**
   * Channel for `log` events rendered from the choreography's
   * `Serial.println()` steps. Default `'firmware'`.
   *
   * **Simulation choice.** On the robot these are bytes on UART0, so the R7
   * bridge tags them `'uart'`. Nothing here crosses a serial line, and
   * `'uart'` means "bytes were observed on a wire", so the simulator says
   * `'firmware'`. Set to `'uart'` if you are feeding a consumer that was
   * written against the bridge's stream.
   */
  readonly logChannel?: LogChannel;

  /**
   * Reject command strings outside the firmware's 21-word vocabulary.
   * Default `true`.
   *
   * With `false`, the firmware's real behaviour is reproduced instead:
   * `currentCommand` is set, no `loop()` branch matches, and it is never
   * cleared.
   */
  readonly strictCommandVocabulary?: boolean;

  /**
   * How many `loop()` dispatch iterations one `command()` call runs for a
   * *continuous* command (`forward`, `backward`, `left`, `right`). Default `1`.
   *
   * **Simulation choice, forced by the API shape.** Those four never clear
   * `currentCommand`, so `loop()` re-invokes them forever; an `await
   * robot.command('forward')` that reproduced that would never resolve. One
   * iteration is one full `walkCycles` gait plus the closing stand pose. Use
   * {@link SimulatedSesameRobot.tick} to run more, or `command('stop')` to clear.
   */
  readonly continuousIterations?: number;

  /**
   * Run the boot sequence's `setFace("rest")` (`sesame-firmware-main.ino:747`)
   * on `connect()`. Default `true`.
   */
  readonly bootFace?: boolean;

  /**
   * Emit a `protocol.hello` on `connect()`, matching what the instrumented
   * firmware prints at the end of `setup()`. Default `true`.
   */
  readonly emitHello?: boolean;

  /** Identity string for that hello. Default `'sesame-sim/0.1.0'`. */
  readonly emitter?: string;

  /** Maximum movement-call nesting before the interpreter gives up. Default `8`. */
  readonly maxCallDepth?: number;
}

/** Options with every default filled in. */
export interface ResolvedOptions {
  readonly timeMode: TimeMode;
  readonly startTimeMs: number;
  readonly rng: Rng;
  readonly seed: number;
  readonly subtrimDeg: readonly number[];
  readonly powerOnDeg: number;
  readonly motorCurrentDelayMs: number;
  readonly frameDelayMs: number;
  readonly walkCycles: number;
  readonly faceFps: number;
  readonly spinQuantumMs: number;
  readonly loopQuantumMs: number;
  readonly slewDegPerSec: number | null;
  readonly logChannel: LogChannel;
  readonly strictCommandVocabulary: boolean;
  readonly continuousIterations: number;
  readonly bootFace: boolean;
  readonly emitHello: boolean;
  readonly emitter: string;
  readonly maxCallDepth: number;
}

/** Firmware defaults + simulation defaults, in one place. */
export const DEFAULT_SUBTRIM_DEG: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);

/** MG90S datasheet slew, 0.1 s / 60° at 4.8 V. A specification, not a measurement. */
export const DEFAULT_SLEW_DEG_PER_SEC = 600;

/** Fill in every default. Pure; called once per robot. */
export function resolveOptions(options: SimulatedRobotOptions = {}): ResolvedOptions {
  const seed = options.seed ?? 1;
  return {
    timeMode: options.timeMode ?? 'virtual',
    startTimeMs: options.startTimeMs ?? 0,
    rng: options.rng ?? mulberry32(seed),
    seed,
    subtrimDeg: options.subtrimDeg ?? DEFAULT_SUBTRIM_DEG,
    powerOnDeg: options.powerOnDeg ?? 90,
    motorCurrentDelayMs: options.motorCurrentDelayMs ?? MOTOR_CURRENT_DELAY_MS,
    frameDelayMs: options.frameDelayMs ?? DEFAULT_FRAME_DELAY_MS,
    walkCycles: options.walkCycles ?? DEFAULT_WALK_CYCLES,
    faceFps: options.faceFps ?? DEFAULT_FACE_FPS,
    spinQuantumMs: options.spinQuantumMs ?? 1,
    loopQuantumMs: options.loopQuantumMs ?? 1,
    slewDegPerSec:
      options.slewDegPerSec === undefined ? DEFAULT_SLEW_DEG_PER_SEC : options.slewDegPerSec,
    logChannel: options.logChannel ?? 'firmware',
    strictCommandVocabulary: options.strictCommandVocabulary ?? true,
    continuousIterations: options.continuousIterations ?? 1,
    bootFace: options.bootFace ?? true,
    emitHello: options.emitHello ?? true,
    emitter: options.emitter ?? 'sesame-sim/0.1.0',
    maxCallDepth: options.maxCallDepth ?? 8,
  };
}
