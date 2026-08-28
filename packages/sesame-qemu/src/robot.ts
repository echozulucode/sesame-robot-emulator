/**
 * `QemuSesameRobot` — the `SesameRobot` contract over firmware that is actually
 * executing.
 *
 * ## What is different about this backend
 *
 * `SimulatedSesameRobot` computes what the firmware *would* do from the
 * choreography extracted in `hardware/hardware-map.json`. This class computes
 * nothing. It writes a line to a UART, real compiled Xtensa instructions run on
 * an emulated ESP32, and whatever comes back is the answer — including when the
 * answer is nothing, which is a result rather than a bug (see `setFace`).
 *
 * The consequence worth internalising: **`getState()` here is a report, not a
 * model.** Every joint angle it returns was seen leaving `setServoAngle()`
 * after the clamp; every face name was seen leaving `updateFaceBitmap()` on its
 * way to the glass. Where the firmware genuinely does not say — a channel that
 * has never been written — it says so (`observed.everObserved`) instead of
 * filling in what a simulator would have predicted.
 *
 * ## What it is not
 *
 * Not hardware. Every event carries `origin: { kind: 'emulator', board:
 * 'distro-v1-esp32', … }`, and `isPhysicallyObserved()` is false for all of
 * them. See `config.ts`.
 */
import {
  HAS_JOINT_POSITION_FEEDBACK,
  JOINT_ORDER,
  isJointName,
  jointIndex,
  type JointName,
  type JointState,
  type RobotState,
} from '@sesame-lab/sesame-model';
import {
  CLI_MOVEMENT_WORDS,
  CommandEncodeError,
  encodeCommand,
  type EncodedCommand,
  type SesameCommand,
  type SesameTelemetry,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import {
  POWER_ON_ANGLE_DEG,
  capabilitiesForImage,
  originForImage,
  resolveQemuOptions,
  type QemuCapabilities,
  type QemuRobotOptions,
  type ResolvedQemuOptions,
} from './config.js';
import {
  QemuBootFailedError,
  QemuNotConnectedError,
  QemuUnsupportedCommandError,
} from './errors.js';
import { launchWithRetry, type BootAttempt, type QemuSession } from './session.js';

/**
 * `RobotState` plus the things only an emulator-backed, telemetry-derived
 * backend can honestly say.
 *
 * Separate sub-object rather than mixed into `RobotState`, exactly as
 * `SimulatedRobotState.simulated` is, so nothing here can be mistaken for a
 * property of the robot.
 */
export interface QemuRobotState extends RobotState {
  readonly observed: {
    /**
     * Per joint: has a `@SESAME servo` line for this channel actually been
     * seen? False means `commandedDeg` is `POWER_ON_ANGLE_DEG`, an assumption,
     * and a UI must not draw it as a report.
     */
    readonly everObserved: Readonly<Record<JointName, boolean>>;
    /** Telemetry events consumed since `connect()`. */
    readonly events: number;
    /** Boot attempts `connect()` needed. >1 means ISSUE-20260823-022 fired. */
    readonly bootAttempts: number;
    /** QEMU's PID, while it is running. */
    readonly pid: number | undefined;
    /** UART0's TCP port. */
    readonly uartPort: number;
    /** The last CLI line written, verbatim. What a lesson should show. */
    readonly lastCommandLine: string | null;
    /**
     * The guest's panic text, if it died. Non-null means every field above is
     * a last-known value rather than a current one.
     */
    readonly panic: string | null;
  };
}

/** Word we sent, versus what the firmware does with it. */
interface InFlight {
  readonly word: string;
  readonly encoded: EncodedCommand;
}

export class QemuSesameRobot implements SesameRobot {
  readonly #opts: ResolvedQemuOptions;
  readonly #listeners = new Set<(event: SesameTelemetry) => void>();

  #session: QemuSession | null = null;
  #unsubscribe: (() => void) | null = null;
  #bootAttempts: readonly BootAttempt[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  // Observed state. Nothing in here is predicted.
  readonly #commandedDeg: Record<JointName, number>;
  readonly #everObserved: Record<JointName, boolean>;
  #faceName = '';
  #faceFrame = 0;
  #events = 0;
  #inFlight: InFlight | null = null;
  #lastCommandLine: string | null = null;
  /** Wall-clock of the most recent `face.expression`, for settling. */
  #lastFaceAtMs = 0;

  constructor(options: QemuRobotOptions = {}) {
    this.#opts = resolveQemuOptions(options);
    this.#commandedDeg = Object.fromEntries(
      JOINT_ORDER.map((j) => [j, POWER_ON_ANGLE_DEG]),
    ) as Record<JointName, number>;
    this.#everObserved = Object.fromEntries(JOINT_ORDER.map((j) => [j, false])) as Record<
      JointName,
      boolean
    >;
  }

  // =========================================================================
  // Introspection
  // =========================================================================

  /** Resolved options, every default filled in. */
  get options(): ResolvedQemuOptions {
    return this.#opts;
  }

  /**
   * What each boot attempt did.
   *
   * Exposed because it is the measurement, not a debug aid: a caller running
   * this in CI should be able to report how often ISSUE-20260823-022 fired
   * without parsing a log.
   */
  get bootAttempts(): readonly BootAttempt[] {
    return this.#bootAttempts;
  }

  /** The live session, for a caller that needs the process or the port. */
  get session(): QemuSession | null {
    return this.#session;
  }

  // =========================================================================
  // SesameRobot
  // =========================================================================

  /**
   * Boot QEMU and wait for the firmware's own end-of-`setup()` banner.
   *
   * Retries past ISSUE-20260823-022 — see {@link launchWithRetry}, and note
   * that this is a mitigation for a QEMU modelling bug, not a fix for it.
   *
   * Boot telemetry (`@SESAME hello`, the `rest` face `setup()` ends with) is
   * replayed to subscribers afterwards, so a listener attached before
   * `connect()` sees the boot it actually got and none of the boots that
   * panicked.
   */
  async connect(): Promise<void> {
    if (this.#session !== null) return;
    let session;
    let attempts;
    try {
      ({ session, attempts } = await launchWithRetry(this.#opts));
    } catch (error) {
      // Keep the attempt log even when every attempt failed. Without this a
      // caller measuring ISSUE-20260823-022 would see `bootAttempts` empty for
      // exactly the connects it most wants to count — which is how the
      // retry-disabled arm of `measure-connect.mjs` first reported "0 failed
      // boots" for a run in which two boots failed.
      if (error instanceof QemuBootFailedError) this.#bootAttempts = error.log;
      throw error;
    }
    this.#session = session;
    this.#bootAttempts = attempts;
    for (const event of session.history) this.#absorb(event);
    this.#unsubscribe = session.subscribe((event) => this.#absorb(event));
  }

  /**
   * Kill QEMU and wait for the OS to confirm the process is gone.
   *
   * Idempotent, and safe to call on a robot that never connected.
   */
  async disconnect(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const session = this.#session;
    this.#session = null;
    // Let anything already queued finish rather than tearing the socket out
    // from under it; a rejected in-flight command is noise, not information.
    await this.#queue.catch(() => undefined);
    await session?.dispose();
  }

  /**
   * Truthful, and mostly qualifiers.
   *
   * Returns the widened {@link QemuCapabilities}: `SesameCapabilities` is six
   * booleans and six booleans cannot say "the board this works on is not the
   * board anyone is told to buy".
   */
  capabilities(): Promise<QemuCapabilities> {
    return Promise.resolve(capabilitiesForImage(this.#opts.imagePath));
  }

  /**
   * Run one of the firmware's command words over the serial console.
   *
   * Two documented divergences from the HTTP path, both forced by the CLI
   * being a different entry point rather than by the emulator:
   *
   * - `forward` / `backward` / `left` / `right` run **one** iteration and stop,
   *   because `:795`–`:798` clear `currentCommand` after the call. Over HTTP
   *   they repeat forever. This matches `SimulatedSesameRobot`'s default
   *   (`continuousIterations: 1`).
   * - `stop` has no CLI verb at all. It is encoded as a no-op face write, which
   *   is the only branch that clears `currentCommand`; see the `command.stop`
   *   member of `SesameCommand`.
   *
   * A word outside the vocabulary is **rejected**, not sent. Sending it would
   * be the more faithful reproduction of the firmware's unknown-command sink —
   * but the sink lives in `loop()`'s `currentCommand` dispatch, which the CLI
   * does not go through, so an unknown word on the console reaches the
   * `sscanf` fallthrough and does nothing at all. Refusing says the same thing
   * out loud, and stops a word like `st` being posted as a command and silently
   * dumping subtrim values instead.
   */
  command(name: string): Promise<void> {
    const session = this.#require('command');
    const spec: SesameCommand =
      name === 'stop' || name === ''
        ? { type: 'command.stop', currentFace: this.#faceName === '' ? 'rest' : this.#faceName }
        : { type: 'movement.run', command: name };

    let encoded: EncodedCommand;
    try {
      encoded = encodeCommand(spec);
    } catch (error) {
      if (error instanceof CommandEncodeError) {
        return Promise.reject(
          new QemuUnsupportedCommandError(
            name,
            `${error.message} (the console accepts ${String(CLI_MOVEMENT_WORDS.length)} movement words)`,
          ),
        );
      }
      throw error;
    }

    return this.#enqueue(async () => {
      this.#inFlight = { word: name, encoded };
      try {
        await this.#write(session, [encoded]);
      } finally {
        this.#inFlight = null;
      }
    });
  }

  /**
   * `setFace(name)` over the console — `fc <name>`.
   *
   * **An unknown face emits nothing, and that is the correct result.**
   * `countFrames()` returns 0 for a face with no bitmaps, the `defualt` fallback
   * table is also empty, `updateFaceBitmap()` is therefore never reached, and
   * `currentFaceName` is silently rewritten to `"default"`
   * (ISSUE-20260823-004). The firmware hook is *inside* `updateFaceBitmap()`,
   * so silence on the wire is the firmware telling the truth about a face it
   * cannot draw. This backend does not paper over it, and neither should a UI.
   *
   * The settle afterwards is not politeness either: `currentFaceMode` powers on
   * as `FACE_ANIM_LOOP` (`:58`), so a multi-frame face keeps emitting one frame
   * per second forever. Returning the instant the console acknowledged would
   * hand the caller's next assertion a stream that is still moving.
   */
  setFace(name: string): Promise<void> {
    const session = this.#require('setFace');
    const encoded = encodeCommand({ type: 'face.set', name });
    return this.#enqueue(async () => {
      await this.#write(session, [encoded]);
      await this.#settleFace();
    });
  }

  /** One channel, by firmware index — `<motor> <angle>` at `:870`. */
  setJoint(joint: JointName, angleDeg: number): Promise<void> {
    const session = this.#require('setJoint');
    if (!isJointName(joint)) {
      return Promise.reject(new QemuUnsupportedCommandError(String(joint), 'not a joint name'));
    }
    const encoded = encodeCommand({ type: 'servo.set', joint, angleDeg });
    return this.#enqueue(() => this.#write(session, [encoded]));
  }

  /**
   * Several channels, in **firmware channel order** rather than the caller's
   * key order.
   *
   * The firmware has no multi-joint primitive — every pose in
   * `movement-sequences.h` is a run of `setServoAngle()` calls in enum order —
   * so this is one console line per channel, each paying its own
   * `motorCurrentDelay`, fenced by a single barrier.
   */
  setPose(pose: Partial<Record<JointName, number>>): Promise<void> {
    const session = this.#require('setPose');
    for (const key of Object.keys(pose)) {
      if (!isJointName(key)) {
        return Promise.reject(new QemuUnsupportedCommandError(key, 'not a joint name'));
      }
    }
    const encoded: EncodedCommand[] = [];
    for (const joint of JOINT_ORDER) {
      const deg = pose[joint];
      if (deg === undefined) continue;
      encoded.push(encodeCommand({ type: 'servo.set', joint, angleDeg: deg }));
    }
    if (encoded.length === 0) return Promise.resolve();
    return this.#enqueue(() => this.#write(session, encoded));
  }

  /**
   * The robot as the wire has described it.
   *
   * `motion.command` deserves a note, because it is the one field where "what
   * the firmware currently holds" and "what the host asked for" could diverge
   * and nobody would notice. It cannot diverge here, and that is derivable
   * rather than assumed: **every** serial-CLI movement branch either never sets
   * `currentCommand` (`run rest`, `run stand`, `:799`–`:800`), clears it
   * immediately (`:795`–`:798`), or is a pose function that clears it on the
   * way out (`if (currentCommand == "wave") currentCommand = "";`,
   * `movement-sequences.h:106` and its fourteen siblings). So once a console
   * command has completed, `currentCommand` is `""` — always. While one is in
   * flight this reports the word that was sent.
   */
  getState(): Promise<QemuRobotState> {
    const joints = Object.fromEntries(
      JOINT_ORDER.map((joint): [JointName, JointState] => [
        joint,
        {
          commandedDeg: this.#commandedDeg[joint],
          // No `simulatedDeg`: nothing here models where a horn actually is
          // between commands, and inventing a slew curve would be a simulation
          // wearing an emulator's clothes.
          //
          // No `measuredDeg` either, ever. Eight MG90S on one-way PWM: no
          // encoder, no pot tap, no current sense, no firmware path.
          measuredDeg: HAS_JOINT_POSITION_FEEDBACK ? this.#commandedDeg[joint] : null,
          // Subtrim is RAM-only in the firmware and is not reported on the
          // telemetry wire. `subtrim` on the console prints it, and a future
          // version could scrape that; until it does, claiming a value would be
          // claiming something unobserved.
        },
      ]),
    ) as Record<JointName, JointState>;

    return Promise.resolve({
      // 'qemu', not 'renode' and not 'real'. See ROBOT_MODES in
      // @sesame-lab/sesame-model — this value was added for this backend
      // because reporting either of the existing ones would have been false.
      mode: 'qemu',
      joints,
      face: {
        expression: this.#faceName,
        frame: this.#faceFrame,
        width: 128,
        height: 64,
      },
      // Not "we did not connect" — there is no radio to connect with. QEMU
      // models no ESP32 Wi-Fi MAC or PHY, and this image has the bring-up
      // commented out. `'ap'` with a plausible IP would be a lie.
      network: { state: 'unavailable' },
      motion: { command: this.#inFlight?.word ?? '' },
      observed: {
        everObserved: { ...this.#everObserved },
        events: this.#events,
        bootAttempts: this.#bootAttempts.length,
        pid: this.#session?.pid,
        uartPort: this.#session?.port ?? 0,
        lastCommandLine: this.#lastCommandLine,
        panic: this.#session?.panic ?? null,
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
  // Extras a lesson wants and the contract does not define
  // =========================================================================

  /** Send any {@link SesameCommand}, including the subtrim family. */
  send(command: SesameCommand): Promise<void> {
    const session = this.#require('send');
    const encoded = encodeCommand(command);
    return this.#enqueue(() => this.#write(session, [encoded]));
  }

  /** The origin stamped on every event this backend produces. */
  get origin(): TelemetryOrigin {
    return originForImage(this.#opts.imagePath);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  #require(method: string): QemuSession {
    const session = this.#session;
    if (session === null) throw new QemuNotConnectedError(method);
    return session;
  }

  async #write(session: QemuSession, encoded: readonly EncodedCommand[]): Promise<void> {
    const lines = encoded.map((e) => e.line);
    this.#lastCommandLine = lines.join('; ');
    await session.runCliLines(lines, this.#opts.commandTimeoutMs);
  }

  /**
   * Wait until the panel has stopped moving, or until the next frame lands.
   *
   * Two exits, because there are two kinds of face. A static one (`happy`,
   * `wave` — one bitmap) emits once and goes quiet, so the quiet period is the
   * signal. An animated one in `FACE_ANIM_LOOP` never goes quiet, so the best
   * available signal is *a frame just landed*: returning immediately after one
   * gives the caller the full inter-frame interval before the next, instead of
   * an arbitrary slice of it.
   */
  async #settleFace(): Promise<void> {
    const start = Date.now();
    const seenAt = this.#lastFaceAtMs;
    for (;;) {
      const now = Date.now();
      if (this.#lastFaceAtMs > seenAt && this.#lastFaceAtMs > start) return;
      if (now - Math.max(this.#lastFaceAtMs, start) >= this.#opts.faceSettleMs) return;
      if (now - start >= this.#opts.faceSettleMaxMs) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #absorb(event: SesameTelemetry): void {
    this.#events += 1;
    if (event.type === 'servo.target') {
      this.#commandedDeg[event.joint] = event.angleDeg;
      this.#everObserved[event.joint] = true;
    } else if (event.type === 'face.expression') {
      this.#faceName = event.name;
      this.#faceFrame = event.frame ?? 0;
      this.#lastFaceAtMs = Date.now();
    }
    for (const listener of this.#listeners) listener(event);
  }

  /** Serialise: the firmware has one console reader and so does this. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Firmware channel index for a joint. Re-exported for demos and lessons. */
export { jointIndex };
