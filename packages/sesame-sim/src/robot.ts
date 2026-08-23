/**
 * `SimulatedSesameRobot` — the behaviour model behind the `SesameRobot`
 * contract.
 *
 * What it is: the firmware's control structure (`machine.ts`) executing the
 * choreography extracted from firmware source (`hardware/hardware-map.json`),
 * on a clock it owns, emitting `@sesame-lab/sesame-protocol` events.
 *
 * What it is emphatically **not**: a source of measurements. No physical Sesame
 * has been used at any point in this project. Every event it emits carries
 * `provenance: "simulated"`, `measuredDeg` is always `null`, and the servo
 * speed model is labelled a simulation choice wherever it appears. If a UI
 * built on this ever implies the robot sensed something, that is a bug in the
 * UI, because this class never claims it.
 */
import {
  HAS_JOINT_POSITION_FEEDBACK,
  JOINT_ORDER,
  isJointName,
  jointIndex,
  type JointName,
  type JointState,
  type RobotState,
  type SesameCapabilities,
} from '@sesame-lab/sesame-model';
import {
  ANGLE_MAX_DEG,
  ANGLE_MIN_DEG,
  COMMAND_NAMES,
  type SesameTelemetry,
} from '@sesame-lab/sesame-protocol';

import { VirtualClock, type SimClock } from './clock.js';
import { resolveOptions, type ResolvedOptions, type SimulatedRobotOptions } from './config.js';
import {
  AngleOutOfRangeError,
  SimNotConnectedError,
  UnknownCommandError,
  UnknownJointError,
} from './errors.js';
import { FirmwareMachine, type FaceAnimMode, type MachineSnapshot, type Pump } from './machine.js';
import { driveRealtime, type RealtimeOptions } from './realtime.js';
import type { SesameRobot } from './robot-contract.js';
import { CHOREOGRAPHY } from './generated/choreography.js';

/** Per-call overrides. Optional everywhere, so the `SesameRobot` shape still fits. */
export interface CallOptions {
  /**
   * Trace id threaded onto every event this call produces, so a single user
   * action can be followed end to end. Generated if omitted.
   */
  readonly traceId?: string;
}

/**
 * `RobotState` plus the things only a simulator can honestly report.
 *
 * Kept in a separate `simulated` sub-object rather than mixed into `RobotState`
 * so that nothing here can ever be mistaken for a property of the robot.
 */
export interface SimulatedRobotState extends RobotState {
  readonly simulated: {
    /** Virtual milliseconds since power-on. */
    readonly timeMs: number;
    /** Next telemetry sequence number. */
    readonly seq: number;
    /** Cooperative pumps executed so far. */
    readonly pumps: number;
    /** The one global `currentFaceMode`, not a property of the face. */
    readonly faceMode: FaceAnimMode;
    /** Frames the current face actually has. Zero for the weak-undefined ones. */
    readonly faceFrameCount: number;
    /** `idleActive` — set only by `runStandPose(face == 1)`. */
    readonly idleActive: boolean;
    /** Movement function currently executing, if any. */
    readonly runningMovement: string | null;
    /**
     * Per joint: has this channel ever been written? False means `commandedDeg`
     * is the configured power-on assumption, not something the robot did.
     */
    readonly everCommanded: Readonly<Record<JointName, boolean>>;
    /** The servo speed model in force, in °/s, or `null` for instantaneous. */
    readonly slewDegPerSec: number | null;
  };
}

/** What this backend can do. Honest, and mostly `false`. */
const CAPABILITIES: SesameCapabilities = Object.freeze({
  /** No physical robot exists in this project. */
  realHardware: false,
  /** No firmware executes. This is a model of the firmware, not the firmware. */
  firmwareExecution: false,
  /** V1 emits `face.expression`, not `oled.frame`. V4 renders pixels from that. */
  oledFramebuffer: false,
  /** No serial console; `log` events are the closest thing. */
  serialConsole: false,
  /** V5 puts an HTTP adapter in front of this; the model itself has none. */
  httpApi: false,
  /** Kinematics only. Gate E: no near-term lesson needs physics. */
  physics: false,
});

export class SimulatedSesameRobot implements SesameRobot {
  readonly #opts: ResolvedOptions;
  readonly #clock: SimClock;
  readonly #machine: FirmwareMachine;
  readonly #listeners = new Set<(event: SesameTelemetry) => void>();
  readonly #realtime: RealtimeOptions;

  #connected = false;
  #traceCounter = 0;
  /** Serialises calls, because the firmware is single-threaded and so is this. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SimulatedRobotOptions = {}, realtime: RealtimeOptions = {}) {
    this.#opts = resolveOptions(options);
    this.#clock = new VirtualClock(this.#opts.startTimeMs);
    this.#realtime = realtime;
    this.#machine = new FirmwareMachine(this.#clock, this.#opts, (event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  // =========================================================================
  // Introspection (synchronous — nothing here moves the robot)
  // =========================================================================

  /** The clock the model runs on. Read it; do not advance it behind the model's back. */
  get clock(): SimClock {
    return this.#clock;
  }

  /** Virtual milliseconds since power-on. */
  get nowMs(): number {
    return this.#clock.nowMs();
  }

  /** Resolved options, every default filled in. Useful in reports and UIs. */
  get options(): ResolvedOptions {
    return this.#opts;
  }

  /** The firmware globals as the model currently holds them. */
  snapshot(): MachineSnapshot {
    return this.#machine.snapshot();
  }

  /** Provenance of the choreography this instance is executing. */
  get choreographyMeta(): (typeof CHOREOGRAPHY)['meta'] {
    return CHOREOGRAPHY.meta;
  }

  /**
   * Hook fired at every cooperative pump — where `server.handleClient()` and
   * `dnsServer.processNextRequest()` run on the robot. This is the seam V5's
   * HTTP adapter uses so its request servicing has the firmware's timing.
   */
  onPump(hook: () => void): () => void {
    return this.#machine.onPump(hook);
  }

  // =========================================================================
  // SesameRobot
  // =========================================================================

  async connect(): Promise<void> {
    if (this.#connected) return;
    this.#connected = true;
    return this.#enqueue(() => {
      const trace = this.#trace('boot');
      this.#machine.traceId = trace;
      try {
        if (this.#opts.emitHello) this.#machine.emitHello();
        // setup() ends with setFace("rest") — ino:747, bootOrder step 19.
        // Deliberately no servo writes: "Show rest face on startup without
        // moving motors".
        if (this.#opts.bootFace) this.#machine.setFace('rest');
      } finally {
        this.#machine.traceId = undefined;
      }
      return Promise.resolve();
    });
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
    await this.#queue;
  }

  capabilities(): Promise<SesameCapabilities> {
    return Promise.resolve(CAPABILITIES);
  }

  /**
   * Run one of the firmware's command words.
   *
   * Models `POST /api/command` (`sesame-firmware-main.ino:375-386`) followed by
   * the `loop()` dispatch that actually executes it: `exitIdle()`, assign
   * `currentCommand`, then run `loop()` until the command clears itself.
   *
   * Two documented divergences, both forced:
   *
   * - An unknown command **throws** by default. The firmware assigns it and
   *   leaves it set forever with nothing matching it; set
   *   `strictCommandVocabulary: false` to get that behaviour instead.
   * - `forward` / `backward` / `left` / `right` never clear `currentCommand`,
   *   so the firmware repeats them indefinitely. This runs
   *   `continuousIterations` dispatches (default 1) and leaves the command set,
   *   because a promise that models "forever" never resolves. Call
   *   {@link tick} for more, or `command('stop')` to clear.
   */
  command(name: string, options: CallOptions = {}): Promise<void> {
    this.#requireConnected('command');

    if (name === 'stop') {
      // /cmd?stop= and POST {"command":"stop"} both just clear the variable,
      // and neither calls exitIdle(). Synchronous on purpose: on the robot this
      // runs inside server.handleClient(), i.e. from inside a pump, so it can
      // and does interrupt a movement already in flight.
      this.#machine.currentCommand = '';
      return Promise.resolve();
    }

    if (this.#opts.strictCommandVocabulary && !COMMAND_NAMES.includes(name)) {
      return Promise.reject(new UnknownCommandError(name, COMMAND_NAMES));
    }

    // exitIdle() runs at the HTTP layer, before dispatch (ino:384).
    this.#machine.exitIdle();
    this.#machine.currentCommand = name;

    const iterations = this.#opts.continuousIterations;
    return this.#enqueue(() =>
      this.#run(
        (function* (machine: FirmwareMachine) {
          for (let i = 0; i < iterations; i++) {
            yield* machine.loopIteration();
            if (machine.currentCommand === '') break;
          }
        })(this.#machine),
        options.traceId ?? this.#trace(name),
      ),
    );
  }

  /**
   * Clear `currentCommand` immediately, without queueing.
   *
   * The synchronous shape is the faithful one: on the robot, `/cmd?stop=` is
   * serviced from inside `server.handleClient()`, which runs from inside
   * `delayWithFace()` — so a stop really does land in the middle of a gait, at
   * the next `pressingCheck()`.
   */
  stop(): void {
    this.#machine.currentCommand = '';
  }

  /**
   * `setFace()` — ino:903. No validation, deliberately.
   *
   * An unknown name is not an error on the robot: it falls through to the
   * `defualt` frame table, which is empty, so nothing is drawn and
   * `currentFaceName` silently becomes `"default"`. Same for `"stand"` and
   * `"default"` themselves (ISSUE-20260823-004). Throwing here would hide the
   * bug this model exists to show.
   *
   * Note also that this does **not** touch the playback mode: `currentFaceMode`
   * is one global that only `setFaceWithMode()` writes. See
   * {@link setFaceWithMode}.
   */
  setFace(name: string, options: CallOptions = {}): Promise<void> {
    this.#requireConnected('setFace');
    return this.#enqueue(() => {
      const trace = options.traceId ?? this.#trace('face');
      this.#machine.traceId = trace;
      try {
        this.#machine.setFace(name);
      } finally {
        this.#machine.traceId = undefined;
      }
      return Promise.resolve();
    });
  }

  /**
   * `setFaceWithMode()` — ino:942. Not reachable over the robot's HTTP API, but
   * it is what every choreography face step does, and the mode it writes is
   * global.
   */
  setFaceWithMode(name: string, mode: FaceAnimMode, options: CallOptions = {}): Promise<void> {
    this.#requireConnected('setFaceWithMode');
    return this.#enqueue(() => {
      this.#machine.traceId = options.traceId ?? this.#trace('face');
      try {
        this.#machine.setFaceWithMode(name, mode);
      } finally {
        this.#machine.traceId = undefined;
      }
      return Promise.resolve();
    });
  }

  /**
   * Command one servo channel, then wait out `motorCurrentDelay` exactly as
   * `setServoAngle()` does.
   *
   * Validation follows the robot's *external* contract, which is stricter than
   * `setServoAngle()`'s own: `GET /cmd?motor=&value=` rejects anything outside
   * `0..180` with a 400 before ever reaching the servo (ino:252), so this
   * throws {@link AngleOutOfRangeError}. The clamp still exists and still
   * matters — it applies to `angle + subtrim`, which is how a trimmed channel
   * saturates on a perfectly legal request.
   *
   * Non-integer angles are truncated toward zero, matching `String::toInt()`.
   */
  setJoint(joint: JointName, angleDeg: number, options: CallOptions = {}): Promise<void> {
    this.#requireConnected('setJoint');
    if (!isJointName(joint)) {
      return Promise.reject(new UnknownJointError(String(joint), JOINT_ORDER));
    }
    if (!Number.isFinite(angleDeg)) {
      return Promise.reject(new AngleOutOfRangeError(angleDeg, ANGLE_MIN_DEG, ANGLE_MAX_DEG));
    }
    const requested = Math.trunc(angleDeg);
    if (requested < ANGLE_MIN_DEG || requested > ANGLE_MAX_DEG) {
      return Promise.reject(new AngleOutOfRangeError(requested, ANGLE_MIN_DEG, ANGLE_MAX_DEG));
    }
    return this.#enqueue(() =>
      this.#run(
        this.#machine.setServoAngle(jointIndex(joint), requested),
        options.traceId ?? this.#trace('joint'),
      ),
    );
  }

  /**
   * Command several channels.
   *
   * Order is **firmware channel order**, not the caller's key order, so the
   * same pose object always produces the same event sequence. The firmware has
   * no multi-joint primitive at all — every pose is a run of `setServoAngle()`
   * calls in enum order — so this is the shape that matches it, and each write
   * still costs its own `motorCurrentDelay`.
   */
  setPose(pose: Partial<Record<JointName, number>>, options: CallOptions = {}): Promise<void> {
    this.#requireConnected('setPose');
    const writes: Array<{ joint: JointName; deg: number }> = [];
    for (const joint of JOINT_ORDER) {
      const deg = pose[joint];
      if (deg === undefined) continue;
      if (!Number.isFinite(deg)) {
        return Promise.reject(new AngleOutOfRangeError(deg, ANGLE_MIN_DEG, ANGLE_MAX_DEG));
      }
      const requested = Math.trunc(deg);
      if (requested < ANGLE_MIN_DEG || requested > ANGLE_MAX_DEG) {
        return Promise.reject(new AngleOutOfRangeError(requested, ANGLE_MIN_DEG, ANGLE_MAX_DEG));
      }
      writes.push({ joint, deg: requested });
    }
    for (const key of Object.keys(pose)) {
      if (!isJointName(key)) return Promise.reject(new UnknownJointError(key, JOINT_ORDER));
    }
    const machine = this.#machine;
    return this.#enqueue(() =>
      this.#run(
        (function* () {
          for (const write of writes) {
            yield* machine.setServoAngle(jointIndex(write.joint), write.deg);
          }
        })(),
        options.traceId ?? this.#trace('pose'),
      ),
    );
  }

  getState(): Promise<SimulatedRobotState> {
    const m = this.#machine;
    const joints = Object.fromEntries(
      JOINT_ORDER.map((joint): [JointName, JointState] => [
        joint,
        {
          commandedDeg: m.commandedDeg[joint],
          simulatedDeg: m.simulatedDeg[joint],
          // Never anything else. The stock robot has no encoder, no pot tap,
          // no current sense and no firmware path that could report an angle.
          measuredDeg: HAS_JOINT_POSITION_FEEDBACK ? m.simulatedDeg[joint] : null,
          subtrimDeg: this.#opts.subtrimDeg[jointIndex(joint)] ?? 0,
        },
      ]),
    ) as Record<JointName, JointState>;

    return Promise.resolve({
      mode: 'simulated',
      joints,
      face: {
        expression: m.currentFaceName,
        frame: m.currentFaceFrameIndex,
        width: 128,
        height: 64,
      },
      // No radio, and V1 ships no HTTP server either — V5 is what makes this
      // `"simulated"`. Saying `"ap"` here would be a lie with a plausible IP.
      network: { state: 'unavailable' },
      motion: { command: m.currentCommand, sequenceStep: m.sequenceStep },
      simulated: {
        timeMs: m.clock.nowMs(),
        seq: m.seq,
        pumps: m.pumpCount,
        faceMode: m.currentFaceMode,
        faceFrameCount: m.currentFaceFrameCount,
        idleActive: m.idleActive,
        runningMovement: m.runningMovement,
        everCommanded: { ...m.everCommanded },
        slewDegPerSec: this.#opts.slewDegPerSec,
      },
    });
  }

  subscribe(listener: (event: SesameTelemetry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // =========================================================================
  // Simulator-only controls
  // =========================================================================

  /**
   * Run `n` iterations of `loop()`.
   *
   * This is how a continuous command is kept going, and how idle blinking gets
   * a chance to run at all: `updateIdleBlink()` is called from `loop()` and
   * from nowhere else, so a robot that is only ever asked to run poses never
   * blinks.
   */
  tick(iterations = 1): Promise<void> {
    this.#requireConnected('tick');
    const machine = this.#machine;
    return this.#enqueue(() =>
      this.#run(
        (function* () {
          for (let i = 0; i < iterations; i++) yield* machine.loopIteration();
        })(),
        this.#trace('tick'),
      ),
    );
  }

  /** Run `loop()` until at least `ms` of virtual time has passed. */
  runFor(ms: number): Promise<void> {
    this.#requireConnected('runFor');
    const machine = this.#machine;
    const until = this.#clock.nowMs() + ms;
    return this.#enqueue(() =>
      this.#run(
        (function* () {
          while (machine.clock.nowMs() < until) yield* machine.loopIteration();
        })(),
        this.#trace('run'),
      ),
    );
  }

  /**
   * Execute one of the 21 extracted movement functions directly, bypassing
   * `currentCommand` dispatch.
   *
   * This is exactly what the serial CLI does — `rn wf` is
   * `currentCommand = "forward"; runWalkPose(); currentCommand = "";`
   * (`sesame-firmware-main.ino:795`) — and the command assignment is not
   * optional dressing: the four gaits check `pressingCheck("forward", …)` after
   * almost every write, so calling `runWalkPose()` with an empty
   * `currentCommand` bails out on the first check and stands up. The CLI's
   * assignment is therefore reproduced here, and only when the caller has not
   * set a command already.
   */
  runMovement(
    name: string,
    args: Readonly<Record<string, number>> | null = null,
    options: CallOptions = {},
  ): Promise<void> {
    this.#requireConnected('runMovement');
    const machine = this.#machine;
    const hold =
      machine.currentCommand === ''
        ? (FirmwareMachine.movement(name)?.triggeredByCommand[0] ?? null)
        : null;
    return this.#enqueue(() =>
      this.#run(
        (function* () {
          if (hold !== null) machine.currentCommand = hold;
          try {
            yield* machine.runMovement(name, args, 0);
          } finally {
            // The CLI clears it afterwards. Only clear what we set, and only if
            // nothing else has changed it in the meantime (a stop, say).
            if (hold !== null && machine.currentCommand === hold) machine.currentCommand = '';
          }
        })(),
        options.traceId ?? this.#trace(name),
      ),
    );
  }

  /** Set `currentCommand` without dispatching. Models the serial CLI's assignments. */
  setCurrentCommand(command: string): void {
    this.#machine.currentCommand = command;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  #requireConnected(method: string): void {
    if (!this.#connected) throw new SimNotConnectedError(method);
  }

  #trace(prefix: string): string {
    this.#traceCounter += 1;
    return `${prefix}-${String(this.#traceCounter).padStart(4, '0')}`;
  }

  /** Serialise: the firmware has one thread and so does the model. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Drive a machine generator to completion.
   *
   * Virtual mode drains it synchronously — no timers, no scheduling, no
   * interleaving, which is exactly why the event stream is reproducible.
   * Real-time mode hands the same generator to the pacer.
   */
  async #run<T>(generator: Generator<Pump, T, void>, traceId: string): Promise<T> {
    this.#machine.traceId = traceId;
    try {
      if (this.#opts.timeMode === 'virtual') {
        let step = generator.next();
        while (step.done !== true) step = generator.next();
        return step.value;
      }
      return await driveRealtime(generator, this.#realtime);
    } finally {
      this.#machine.traceId = undefined;
    }
  }
}
