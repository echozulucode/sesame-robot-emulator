/**
 * The cooperative firmware machine.
 *
 * This is a transcription of the *control structure* of
 * `firmware/sesame-firmware-main.ino` — `loop()`, `setServoAngle()`,
 * `delayWithFace()`, `pressingCheck()`, `setFace()`, `updateAnimatedFace()`,
 * `updateIdleBlink()` — driving the *choreography* extracted into
 * `hardware/hardware-map.json`. No movement is written out by hand here.
 *
 * ## Why generators
 *
 * `delayWithFace()` is the single most misunderstood function in the firmware.
 * It looks like `delay()` and is not:
 *
 * ```c
 * void delayWithFace(unsigned long ms) {          // ino:996
 *   unsigned long start = millis();
 *   while (millis() - start < ms) {
 *     updateAnimatedFace();
 *     server.handleClient();
 *     dnsServer.processNextRequest();
 *     delay(5);
 *   }
 * }
 * ```
 *
 * Every `setServoAngle()` ends in one of these, so **every servo write is also
 * an HTTP poll, a DNS poll and a face-animation tick**, four times over for the
 * default 20 ms. A model that blocked for 20 ms would get the joint angles
 * right and the interleaving wrong, and the interleaving is the part a learner
 * is being shown.
 *
 * So every function that can delay is a generator that yields at each pump.
 * The driver decides what a yield costs: nothing at all in virtual time, a
 * wall-clock sleep in real-time playback. The model itself never blocks and
 * never knows which it is.
 */
import { JOINT_ORDER, jointAtIndex, jointIndex, type JointName } from '@sesame-lab/sesame-model';
import {
  COMMAND_VOCABULARY,
  lookupFace,
  PROTOCOL_VERSION,
  type FacePlaybackMode,
  type LogChannel,
  type SesameTelemetry,
} from '@sesame-lab/sesame-protocol';

import type { SimClock } from './clock.js';
import { DELAY_WITH_FACE_QUANTUM_MS, type ResolvedOptions } from './config.js';
import { UnknownMovementError, UnsupportedStepError } from './errors.js';
import { randomInt } from './rng.js';
import { CHOREOGRAPHY } from './generated/choreography.js';
import type { ChoreographyStep, MovementDefinition } from './choreography-types.js';

/** Modes `currentFaceMode` can actually hold. `'inherited'` is a catalog marker. */
export type FaceAnimMode = Exclude<FacePlaybackMode, 'inherited'>;

/**
 * A cooperative step. The interpreter yields one of these at every point the
 * firmware would have re-entered its pumps, so a driver can pace, observe or
 * interrupt there — and nowhere else, which is exactly the firmware's own
 * concurrency contract.
 */
export interface Pump {
  /** Which firmware spin loop we are inside. */
  readonly via: 'delayWithFace' | 'pressingCheck' | 'loop';
  /** Virtual time at the pump, in milliseconds. */
  readonly atMs: number;
}

/** Everything the machine mirrors from the firmware's globals. */
export interface MachineSnapshot {
  readonly timeMs: number;
  readonly seq: number;
  readonly currentCommand: string;
  readonly currentFaceName: string;
  readonly currentFaceFrameIndex: number;
  readonly currentFaceFrameCount: number;
  readonly currentFaceMode: FaceAnimMode;
  readonly currentFaceFps: number;
  readonly faceAnimFinished: boolean;
  readonly idleActive: boolean;
  readonly idleBlinkActive: boolean;
  readonly runningMovement: string | null;
  readonly sequenceStep: number;
}

const MOVEMENTS_BY_NAME: ReadonlyMap<string, MovementDefinition> = new Map(
  CHOREOGRAPHY.movements.map((m) => [m.function, m]),
);

/**
 * Callees that exist in firmware but are not movement functions.
 * Allowlisted rather than "ignore anything unknown", so an extractor gap
 * surfaces as a thrown error instead of a movement that quietly does less.
 */
const NON_MOVEMENT_CALLEES = new Set(['scheduleNextIdleBlink']);

/** `if (<name> == <literal>)`, the only conditional form the choreography contains. */
const CONDITION_RE = /^(\w+)\s*==\s*(-?\d+)$/;

/** Body of a telemetry event before the machine stamps identity onto it. */
type EventBody =
  | { readonly type: 'servo.target'; readonly joint: JointName; readonly angleDeg: number }
  | { readonly type: 'face.expression'; readonly name: string; readonly frame: number }
  | { readonly type: 'log'; readonly channel: LogChannel; readonly text: string }
  | {
      readonly type: 'protocol.hello';
      readonly protocolVersion: number;
      readonly emitter: string;
    };

export class FirmwareMachine {
  readonly clock: SimClock;
  readonly opts: ResolvedOptions;

  #seq = 0;
  #traceId: string | undefined;
  readonly #sink: (event: SesameTelemetry) => void;
  readonly #pumpHooks = new Set<() => void>();

  // --- firmware globals: same names, same initial values ------------------

  /** `String currentCommand = "";` ino:51 */
  currentCommand = '';

  /** `String currentFaceName = "default";` ino:52 */
  currentFaceName = 'default';

  /**
   * `const unsigned char* const* currentFaceFrames = nullptr;` ino:53.
   *
   * Only the null/non-null distinction is observable, and it matters: it is
   * half of `setFace()`'s early-return guard, and it is why the power-on
   * `"default"` face is not treated as already displayed.
   */
  faceFramesAttached = false;

  /** `uint8_t currentFaceFrameCount = 0;` ino:54 */
  currentFaceFrameCount = 0;

  /** `uint8_t currentFaceFrameIndex = 0;` ino:55 */
  currentFaceFrameIndex = 0;

  /**
   * `unsigned long lastFaceFrameMs = 0;` ino:56, modelled as `null`.
   *
   * `setFace()` resets this to literal `0` and `updateAnimatedFace()` then
   * tests `millis() - 0 >= interval`. On a robot that has been up for longer
   * than one frame interval — i.e. always — that is true immediately, so the
   * first animated frame advances on the very next pump regardless of fps.
   * `null` reproduces that on a clock which legitimately starts near zero.
   */
  lastFaceFrameMs: number | null = null;

  /** `FaceAnimMode currentFaceMode = FACE_ANIM_LOOP;` ino:58 — GLOBAL, per call site. */
  currentFaceMode: FaceAnimMode = 'loop';

  /** `int8_t faceFrameDirection = 1;` ino:59 */
  faceFrameDirection: 1 | -1 = 1;

  /** `bool faceAnimFinished = false;` ino:60 */
  faceAnimFinished = false;

  /** `int currentFaceFps = 0;` ino:61 */
  currentFaceFps = 0;

  /** `bool idleActive = false;` ino:62 */
  idleActive = false;

  /** `bool idleBlinkActive = false;` ino:63 */
  idleBlinkActive = false;

  /** `unsigned long nextIdleBlinkMs = 0;` ino:64 */
  nextIdleBlinkMs = 0;

  /** `uint8_t idleBlinkRepeatsLeft = 0;` ino:65 */
  idleBlinkRepeatsLeft = 0;

  // --- joint state --------------------------------------------------------

  /** Post-subtrim, post-clamp: what `Servo::write()` received. */
  readonly commandedDeg: Record<JointName, number>;

  /** The speed model's belief. An inference; see `slewDegPerSec`. */
  readonly simulatedDeg: Record<JointName, number>;

  /** False until this channel has been written at least once. */
  readonly everCommanded: Record<JointName, boolean>;

  // --- bookkeeping --------------------------------------------------------

  runningMovement: string | null = null;
  sequenceStep = 0;

  /** Cooperative pumps executed. Cheap proof that delays are not dead time. */
  pumpCount = 0;

  constructor(clock: SimClock, opts: ResolvedOptions, sink: (event: SesameTelemetry) => void) {
    this.clock = clock;
    this.opts = opts;
    this.#sink = sink;
    const power = opts.powerOnDeg;
    this.commandedDeg = Object.fromEntries(JOINT_ORDER.map((j) => [j, power])) as Record<
      JointName,
      number
    >;
    this.simulatedDeg = Object.fromEntries(JOINT_ORDER.map((j) => [j, power])) as Record<
      JointName,
      number
    >;
    this.everCommanded = Object.fromEntries(JOINT_ORDER.map((j) => [j, false])) as Record<
      JointName,
      boolean
    >;
  }

  // =========================================================================
  // Telemetry
  // =========================================================================

  /** Current trace id, threaded onto every event the machine emits. */
  get traceId(): string | undefined {
    return this.#traceId;
  }

  set traceId(value: string | undefined) {
    this.#traceId = value;
  }

  /** Next sequence number that will be assigned. Monotonic, never reset. */
  get seq(): number {
    return this.#seq;
  }

  /**
   * Register a hook fired at every cooperative pump — the same instant
   * `server.handleClient()` and `dnsServer.processNextRequest()` run on the
   * robot. V5's HTTP adapter services requests here, so that its timing matches
   * the firmware's instead of being a separate event loop.
   */
  onPump(hook: () => void): () => void {
    this.#pumpHooks.add(hook);
    return () => {
      this.#pumpHooks.delete(hook);
    };
  }

  #emit(body: EventBody): void {
    const seq = this.#seq++;
    const simTimeUs = Math.round(this.clock.nowMs() * 1000);
    const stamped: SesameTelemetry =
      this.#traceId === undefined
        ? { ...body, seq, provenance: 'simulated', simTimeUs }
        : { ...body, seq, provenance: 'simulated', simTimeUs, traceId: this.#traceId };
    this.#sink(stamped);
  }

  /** A `log` on the `emulator` channel: the simulator talking about itself. */
  emitEmulatorLog(text: string): void {
    this.#emit({ type: 'log', channel: 'emulator', text });
  }

  /** The instrumented firmware's boot banner. */
  emitHello(): void {
    this.#emit({
      type: 'protocol.hello',
      protocolVersion: PROTOCOL_VERSION,
      emitter: this.opts.emitter,
    });
  }

  // =========================================================================
  // Time
  // =========================================================================

  /** Advance virtual time and integrate the servo speed model. */
  advance(deltaMs: number): void {
    if (deltaMs <= 0) return;
    this.clock.advanceMs(deltaMs);
    const rate = this.opts.slewDegPerSec;
    if (rate === null) return;
    const maxStep = (rate * deltaMs) / 1000;
    for (const joint of JOINT_ORDER) {
      const target = this.commandedDeg[joint];
      const current = this.simulatedDeg[joint];
      const delta = target - current;
      this.simulatedDeg[joint] =
        Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;
    }
  }

  #pump(via: Pump['via']): Pump {
    this.pumpCount++;
    for (const hook of this.#pumpHooks) hook();
    return { via, atMs: this.clock.nowMs() };
  }

  // =========================================================================
  // Faces — sesame-firmware-main.ino:903-1002
  // =========================================================================

  /** `getFaceFpsForName()` (ino:948): `faceFpsEntries[]`, else the global `faceFps`. */
  faceFpsForName(name: string): number {
    return lookupFace(name)?.fps ?? this.opts.faceFps;
  }

  /**
   * `setFace()` — ino:903.
   *
   * Reproduced statement for statement, including the two things that surprise
   * people:
   *
   * 1. The early return compares `currentFaceName` **case-sensitively** even
   *    though the registry lookup below it is case-insensitive, so
   *    `setFace("Wave")` after `setFace("wave")` re-runs the whole body.
   * 2. A face with zero defined frames falls back to `face_defualt_frames`,
   *    which is *also* empty, so `updateFaceBitmap()` is never reached and
   *    **nothing is emitted at all** — while `currentFaceName` is quietly
   *    rewritten to `"default"`. That is ISSUE-20260823-004: `epd_bitmap_stand`
   *    and `epd_bitmap_defualt` are declared `__attribute__((weak))`
   *    (`face-bitmaps.h:52`) and never defined, which F3 confirmed at binary
   *    level with `nm`. It is a bug, it is upstream's, and this model keeps it.
   */
  setFace(name: string): void {
    if (name === this.currentFaceName && this.faceFramesAttached) return;

    this.currentFaceName = name;
    this.currentFaceFrameIndex = 0;
    this.lastFaceFrameMs = null;
    this.faceFrameDirection = 1;
    this.faceAnimFinished = false;
    this.currentFaceFps = this.faceFpsForName(name);

    // currentFaceFrames = face_defualt_frames — non-null, but zero frames.
    this.faceFramesAttached = true;
    this.currentFaceFrameCount = defualtFrameCount();

    const entry = lookupFace(name);
    if (entry !== undefined) this.currentFaceFrameCount = entry.frameCount;

    if (this.currentFaceFrameCount === 0) {
      this.currentFaceFrameCount = defualtFrameCount();
      this.currentFaceName = 'default';
      this.currentFaceFps = this.faceFpsForName('default');
    }

    if (this.currentFaceFrameCount > 0) this.#emitFace(0);
  }

  /** `setFaceMode()` — ino:936. Writes the ONE global playback mode. */
  setFaceMode(mode: FaceAnimMode): void {
    this.currentFaceMode = mode;
    this.faceFrameDirection = 1;
    this.faceAnimFinished = false;
  }

  /** `setFaceWithMode()` — ino:942. Mode first, then the face. */
  setFaceWithMode(name: string, mode: FaceAnimMode): void {
    this.setFaceMode(mode);
    this.setFace(name);
  }

  #emitFace(frame: number): void {
    this.#emit({ type: 'face.expression', name: this.currentFaceName, frame });
  }

  /**
   * `updateAnimatedFace()` — ino:956. Called from `loop()`, from
   * `delayWithFace()` and from `pressingCheck()`; nowhere else.
   */
  updateAnimatedFace(): void {
    if (!this.faceFramesAttached || this.currentFaceFrameCount <= 1) return;
    if (this.currentFaceMode === 'once' && this.faceAnimFinished) return;

    const now = this.clock.nowMs();
    const fps = Math.max(1, this.currentFaceFps > 0 ? this.currentFaceFps : this.opts.faceFps);
    const interval = Math.floor(1000 / fps);
    if (this.lastFaceFrameMs !== null && now - this.lastFaceFrameMs < interval) return;

    this.lastFaceFrameMs = now;
    const count = this.currentFaceFrameCount;
    if (this.currentFaceMode === 'loop') {
      this.currentFaceFrameIndex = (this.currentFaceFrameIndex + 1) % count;
    } else if (this.currentFaceMode === 'once') {
      if (this.currentFaceFrameIndex + 1 >= count) {
        this.currentFaceFrameIndex = count - 1;
        this.faceAnimFinished = true;
      } else {
        this.currentFaceFrameIndex++;
      }
    } else if (this.faceFrameDirection > 0) {
      if (this.currentFaceFrameIndex + 1 >= count) {
        this.faceFrameDirection = -1;
        if (this.currentFaceFrameIndex > 0) this.currentFaceFrameIndex--;
      } else {
        this.currentFaceFrameIndex++;
      }
    } else if (this.currentFaceFrameIndex === 0) {
      this.faceFrameDirection = 1;
      if (count > 1) this.currentFaceFrameIndex++;
    } else {
      this.currentFaceFrameIndex--;
    }
    this.#emitFace(this.currentFaceFrameIndex);
  }

  // =========================================================================
  // Idle — ino:1005-1047
  // =========================================================================

  /** `scheduleNextIdleBlink()` — ino:1005. */
  scheduleNextIdleBlink(minMs: number, maxMs: number): void {
    this.nextIdleBlinkMs = this.clock.nowMs() + randomInt(this.opts.rng, minMs, maxMs);
  }

  /**
   * `exitIdle()` — ino:1017. Reached from `/cmd?pose=`, `/cmd?go=` and
   * `POST /api/command`; **not** from `/cmd?stop=`, and not from choreography.
   */
  exitIdle(): void {
    this.idleActive = false;
    this.idleBlinkActive = false;
  }

  /**
   * `updateIdleBlink()` — ino:1024.
   *
   * Called **only from `loop()`**. `delayWithFace()` does not call it, so idle
   * blinking is frozen for the whole duration of a movement — including the
   * three-second hold in `runBowPose`.
   */
  updateIdleBlink(): void {
    if (!this.idleActive) return;

    if (!this.idleBlinkActive) {
      if (this.clock.nowMs() >= this.nextIdleBlinkMs) {
        this.idleBlinkActive = true;
        if (this.idleBlinkRepeatsLeft === 0 && randomInt(this.opts.rng, 0, 100) < 30) {
          this.idleBlinkRepeatsLeft = 1; // double blink
        }
        this.setFaceWithMode('idle_blink', 'once');
      }
      return;
    }

    if (this.currentFaceMode === 'once' && this.faceAnimFinished) {
      this.idleBlinkActive = false;
      this.setFaceWithMode('idle', 'boomerang');
      if (this.idleBlinkRepeatsLeft > 0) {
        this.idleBlinkRepeatsLeft--;
        this.scheduleNextIdleBlink(120, 220);
      } else {
        this.scheduleNextIdleBlink(3000, 7000);
      }
    }
  }

  // =========================================================================
  // Servos — ino:1051
  // =========================================================================

  /** `constrain(angle + servoSubtrim[channel], 0, 180)` — subtrim BEFORE the clamp. */
  adjustedAngle(channel: number, angle: number): number {
    const subtrim = this.opts.subtrimDeg[channel] ?? 0;
    const { min, max } = CHOREOGRAPHY.angleClamp;
    return Math.min(max, Math.max(min, angle + subtrim));
  }

  /**
   * `setServoAngle()` — ino:1051. The single convergence point for all motion.
   *
   * ```c
   * void setServoAngle(uint8_t channel, int angle) {
   *   if (channel < 8) {
   *     int adjustedAngle = constrain(angle + servoSubtrim[channel], 0, 180);
   *     servos[channel].write(adjustedAngle);
   *     delayWithFace(motorCurrentDelay);
   *   }
   * }
   * ```
   *
   * Order matters and is preserved: subtrim, then clamp, then write, then the
   * cooperative delay. Out-of-range channels are ignored silently, exactly as
   * the `if (channel < 8)` guard does.
   */
  *setServoAngle(channel: number, angle: number): Generator<Pump, void, void> {
    const joint = jointAtIndex(channel);
    if (joint === undefined) return; // if (channel < 8) — a silent no-op upstream
    const adjusted = this.adjustedAngle(channel, angle);
    this.commandedDeg[joint] = adjusted;
    this.everCommanded[joint] = true;
    if (this.opts.slewDegPerSec === null) this.simulatedDeg[joint] = adjusted;
    this.#emit({ type: 'servo.target', joint, angleDeg: adjusted });
    yield* this.delayWithFace(this.opts.motorCurrentDelayMs);
  }

  // =========================================================================
  // The two re-entrancy points
  // =========================================================================

  /** `delayWithFace()` — ino:996. Pumps face/HTTP/DNS every 5 ms. */
  *delayWithFace(ms: number): Generator<Pump, void, void> {
    const start = this.clock.nowMs();
    while (this.clock.nowMs() - start < ms) {
      this.updateAnimatedFace();
      yield this.#pump('delayWithFace');
      this.advance(DELAY_WITH_FACE_QUANTUM_MS);
    }
  }

  /**
   * `pressingCheck()` — ino:1064. Returns `false` the moment `currentCommand`
   * stops being `cmd`, having run `runStandPose(1)` on the way out.
   *
   * Unlike `delayWithFace()` this loop has no `delay()` in it at all — just
   * `yield()`. Its period is therefore a simulation choice
   * (`spinQuantumMs`, default 1 ms).
   */
  *pressingCheck(cmd: string, ms: number): Generator<Pump, boolean, void> {
    const start = this.clock.nowMs();
    while (this.clock.nowMs() - start < ms) {
      this.updateAnimatedFace();
      if (this.currentCommand !== cmd) {
        yield* this.runMovement('runStandPose', { face: 1 }, 1);
        return false;
      }
      yield this.#pump('pressingCheck');
      this.advance(this.opts.spinQuantumMs);
    }
    return true;
  }

  // =========================================================================
  // The choreography interpreter
  // =========================================================================

  /** Look up one of the 21 extracted functions. */
  static movement(name: string): MovementDefinition | undefined {
    return MOVEMENTS_BY_NAME.get(name);
  }

  /** Run one movement function by name, binding its C++ default arguments. */
  *runMovement(
    name: string,
    args: Readonly<Record<string, number>> | null,
    depth: number,
  ): Generator<Pump, void, void> {
    if (depth > this.opts.maxCallDepth) {
      throw new UnsupportedStepError(`call depth ${depth} exceeded at '${name}'`);
    }
    const movement = MOVEMENTS_BY_NAME.get(name);
    if (movement === undefined) throw new UnknownMovementError(name);

    const previous = this.runningMovement;
    this.runningMovement = name;
    const bound = { ...(movement.defaultArgs ?? {}), ...(args ?? {}) };
    try {
      yield* this.#walk(movement.steps, bound, depth, name);
    } finally {
      this.runningMovement = previous;
    }
  }

  *#walk(
    steps: readonly ChoreographyStep[],
    args: Readonly<Record<string, number>>,
    depth: number,
    owner: string,
  ): Generator<Pump, void, void> {
    for (const step of steps) {
      this.sequenceStep++;
      switch (step.type) {
        case 'log':
          this.#emit({ type: 'log', channel: this.opts.logChannel, text: step.text });
          break;

        case 'face':
          if (step.mode === null || step.mode === 'inherited') this.setFace(step.name);
          else this.setFaceWithMode(step.name, step.mode);
          break;

        case 'servo':
          if (jointIndex(step.joint) !== step.index) {
            throw new UnsupportedStepError(
              `${owner}: joint/index disagreement ${step.joint}@${step.index}`,
            );
          }
          yield* this.setServoAngle(step.index, step.angleDeg);
          break;

        case 'delay':
          yield* this.delayWithFace(step.ms);
          break;

        case 'repeat': {
          const count = this.#resolveRepeatCount(step, owner);
          for (let i = 0; i < count; i++) yield* this.#walk(step.steps, args, depth, owner);
          break;
        }

        case 'conditional':
          if (this.#evalCondition(step.condition, args, owner)) {
            yield* this.#walk(step.steps, args, depth, owner);
          }
          break;

        case 'call':
          if (step.function === 'scheduleNextIdleBlink') {
            this.scheduleNextIdleBlink(step.args?.['minMs'] ?? 0, step.args?.['maxMs'] ?? 0);
            break;
          }
          if (NON_MOVEMENT_CALLEES.has(step.function)) break;
          yield* this.runMovement(step.function, step.args, depth + 1);
          break;

        case 'clearCommandIf':
          if (this.currentCommand === step.command) this.currentCommand = '';
          break;

        case 'interruptCheck': {
          const ms = this.#resolveInterruptMs(step.durationMsRef, step.durationMsDefault, owner);
          const held = yield* this.pressingCheck(step.command, ms);
          if (!held) return; // `if (!pressingCheck(...)) return;`
          break;
        }

        case 'state':
          this.#applyState(step.variable, step.value, owner);
          break;

        default: {
          const unreachable: never = step;
          throw new UnsupportedStepError(`${owner}: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  #resolveRepeatCount(step: Extract<ChoreographyStep, { type: 'repeat' }>, owner: string): number {
    if (step.count !== null) return step.count;
    if (step.countRef === 'walkCycles') return this.opts.walkCycles;
    if (step.countRef !== null) {
      throw new UnsupportedStepError(`${owner}: unknown loop bound '${step.countRef}'`);
    }
    if (step.countDefault !== null) return step.countDefault;
    throw new UnsupportedStepError(`${owner}: repeat step has no bound`);
  }

  #resolveInterruptMs(ref: string | null, fallback: number | null, owner: string): number {
    if (ref === 'frameDelay') return this.opts.frameDelayMs;
    if (ref !== null) throw new UnsupportedStepError(`${owner}: unknown duration ref '${ref}'`);
    if (fallback !== null) return fallback;
    throw new UnsupportedStepError(`${owner}: interruptCheck has no duration`);
  }

  #evalCondition(
    condition: string,
    args: Readonly<Record<string, number>>,
    owner: string,
  ): boolean {
    const match = CONDITION_RE.exec(condition);
    const name = match?.[1];
    if (match === null || name === undefined) {
      throw new UnsupportedStepError(`${owner}: unsupported condition '${condition}'`);
    }
    const value = args[name];
    if (value === undefined) {
      throw new UnsupportedStepError(`${owner}: condition references unbound '${name}'`);
    }
    return value === Number(match[2]);
  }

  #applyState(variable: string, value: boolean | number, owner: string): void {
    switch (variable) {
      case 'idleActive':
        this.idleActive = Boolean(value);
        return;
      case 'idleBlinkActive':
        this.idleBlinkActive = Boolean(value);
        return;
      case 'idleBlinkRepeatsLeft':
        this.idleBlinkRepeatsLeft = Number(value);
        return;
      default:
        throw new UnsupportedStepError(`${owner}: unknown state variable '${variable}'`);
    }
  }

  // =========================================================================
  // loop() — ino:752
  // =========================================================================

  /**
   * One iteration of `loop()`.
   *
   * `dnsServer.processNextRequest(); server.handleClient(); updateWifiSetup();
   * updateAnimatedFace(); updateIdleBlink(); updateWifiInfoScroll();` then the
   * `currentCommand` dispatch chain. WiFi setup and the info scroll are not
   * modelled — there is no radio — and their absence is recorded rather than
   * papered over.
   */
  *loopIteration(): Generator<Pump, void, void> {
    yield this.#pump('loop');
    this.updateAnimatedFace();
    this.updateIdleBlink();

    const cmd = this.currentCommand;
    if (cmd !== '') {
      const entry = COMMAND_VOCABULARY.find((c) => c.command === cmd);
      const fn = entry?.movementFunction ?? null;
      if (fn !== null) {
        this.sequenceStep = 0;
        yield* this.runMovement(fn, null, 0);
        // `rest` and `stand` are cleared *inline in loop()*, not by the pose
        // function, which is why the choreography carries no clearCommandIf
        // for them. Derived from the choreography rather than hardcoded.
        if (entry?.continuous === false && !clearsItself(fn, cmd)) {
          if (this.currentCommand === cmd) this.currentCommand = '';
        }
      }
    }
    this.advance(this.opts.loopQuantumMs);
  }

  /** A structural snapshot of the firmware globals, for `getState()` and tests. */
  snapshot(): MachineSnapshot {
    return {
      timeMs: this.clock.nowMs(),
      seq: this.#seq,
      currentCommand: this.currentCommand,
      currentFaceName: this.currentFaceName,
      currentFaceFrameIndex: this.currentFaceFrameIndex,
      currentFaceFrameCount: this.currentFaceFrameCount,
      currentFaceMode: this.currentFaceMode,
      currentFaceFps: this.currentFaceFps,
      faceAnimFinished: this.faceAnimFinished,
      idleActive: this.idleActive,
      idleBlinkActive: this.idleBlinkActive,
      runningMovement: this.runningMovement,
      sequenceStep: this.sequenceStep,
    };
  }
}

/**
 * `countFrames(face_defualt_frames, MAX_FACE_FRAMES)`.
 *
 * Read from the catalog rather than written as `0`, so that if someone ever
 * defines `epd_bitmap_defualt` upstream the model follows instead of lying.
 */
function defualtFrameCount(): number {
  return lookupFace('defualt')?.frameCount ?? 0;
}

/** True when the movement's own body contains `if (currentCommand == cmd) …`. */
function clearsItself(fn: string, cmd: string): boolean {
  const movement = MOVEMENTS_BY_NAME.get(fn);
  if (movement === undefined) return false;
  const scan = (steps: readonly ChoreographyStep[]): boolean =>
    steps.some((s) => {
      if (s.type === 'clearCommandIf') return s.command === cmd;
      if (s.type === 'repeat' || s.type === 'conditional') return scan(s.steps);
      return false;
    });
  return scan(movement.steps);
}
