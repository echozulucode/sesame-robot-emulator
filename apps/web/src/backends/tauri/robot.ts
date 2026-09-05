/**
 * `TauriSesameRobot` — the `SesameRobot` contract over firmware executing
 * inside the desktop app.
 *
 * ```text
 * a button in the Tauri window
 *   -> encodeCommand()            the prefix-sensitive serial-CLI model, reused
 *   -> send_command(bytes)        Rust: one write_all to the UART0 socket
 *   -> real Xtensa instructions on an emulated ESP32
 *   -> @SESAME lines back on the byte channel
 *   -> SesameTelemetryParser      the SAME parser, 255 tests, chunk-invariant
 *   -> this class -> TelemetryStore -> Object3D.quaternion
 * ```
 *
 * ## What this is, next to `QemuSesameRobot`
 *
 * `packages/sesame-qemu/src/robot.ts` is the same behaviour over Node: the
 * absorb loop, `getState()` as a report rather than a model, `everObserved`,
 * the settle after a face, the serialised command queue. **That file is the
 * reference and this one deliberately mirrors it**, because the two have to
 * pass the same fifteen contract cases and a second design would have been a
 * second set of bugs.
 *
 * What could not be mirrored is everything below the events, because in the
 * desktop app it lives in Rust:
 *
 * | `QemuSesameRobot` reaches for | here |
 * |---|---|
 * | `launchWithRetry()` (spawn, socket, retry) | `supervisor.spawn()` |
 * | `session.runCliLines()` (write **and** fence) | `#write()` here: `supervisor.send()`, then the fence below |
 * | `session.history` replay | the pre-banner bytes Rust flushes, parsed on arrival |
 * | `originForImage(opts.imagePath)` | `originForImage(rustFacts.imagePath)` — the path Rust *resolved* |
 *
 * ## The barrier protocol had to be rebuilt, and this is where it lives
 *
 * T3 §10 states it: **`send_command` writes and returns.** It does not wait,
 * because waiting requires the parser and the parser is up here. So the fence
 * is reassembled in `#write()`, from the same three protocol constants
 * `session.ts` uses:
 *
 * - append `BARRIER_COMMAND` (`subtrim`) after the real lines, in **one** write,
 *   so the firmware never sees a gap it could interleave something into;
 * - the console reads one character per `loop()` and runs a completed line
 *   synchronously inside that iteration (`sesame-firmware-main.ino:788`), so a
 *   read-only command behind a movement cannot be dispatched until the movement
 *   has fully returned;
 * - count `BARRIER_MARKER` (`Subtrim values:`) as it comes back out of the
 *   parser, and resolve when the count moves.
 *
 * No polling of the robot, no fixed sleep, no guess about how fast QEMU is
 * running today. A `TauriSesameRobot` that fired commands without this would
 * see exactly the interleaving `runCliLines` exists to prevent.
 *
 * ## What it is not
 *
 * Not hardware. `origin.kind` is `'emulator'` — stamped from what **Rust**
 * reported about the process it spawned and the file it opened, joined to the
 * frozen record `@sesame-lab/sesame-qemu` derives from that file's name — so
 * `isPhysicallyObserved()` is false for every event this class emits, and there
 * is no branch here that can make it anything else.
 */
import {
  HAS_JOINT_POSITION_FEEDBACK,
  JOINT_ORDER,
  isJointName,
  type JointName,
  type JointState,
  type RobotState,
} from '@sesame-lab/sesame-model';
import {
  BARRIER_COMMAND,
  BARRIER_MARKER,
  CLI_MOVEMENT_WORDS,
  CLI_TERMINATOR,
  CommandEncodeError,
  SesameTelemetryParser,
  encodeCommand,
  type EncodedCommand,
  type SesameCommand,
  type SesameTelemetry,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';
import {
  POWER_ON_ANGLE_DEG,
  capabilitiesForImage,
  originForImage,
  type QemuCapabilities,
} from '@sesame-lab/sesame-qemu/capabilities';
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import {
  tauriSupervisor,
  type EmulatorSupervisor,
  type SupervisorBootAttempt,
  type SupervisorEvent,
  type SupervisorSession,
} from './supervisor.js';

/**
 * Most bytes to put on the wire in one go — `MAX_BATCH_BYTES`, restated.
 *
 * Rust enforces the same number and rejects a larger write with
 * `{kind:'writeTooLarge', budget:192}`. This copy exists so the refusal happens
 * *before* the bytes leave, with the reason attached: `UART_BUFFER_SIZE` in
 * arduino-esp32's `HardwareSerial` is 256, the console drains it one character
 * per `loop()` while stalling for the whole of every servo delay, and the
 * overflow is **silent**. Rust is the backstop, not the explanation. The live
 * value is read back off `SupervisorSession.maxWriteBytes` on connect, so if the
 * two ever disagree the wire's own number wins.
 */
export const DEFAULT_MAX_BATCH_BYTES = 192;

/** Milliseconds between polls of a condition the wire will satisfy. */
const POLL_MS = 10;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A method was called before `connect()`, or after `disconnect()`. */
export class TauriNotConnectedError extends Error {
  override readonly name = 'TauriNotConnectedError';
  constructor(readonly method: string) {
    super(`${method}() requires connect() first`);
  }
}

/** The guest panicked while a command was in flight. */
export class TauriGuestPanicError extends Error {
  override readonly name = 'TauriGuestPanicError';
  constructor(readonly panicText: string) {
    super(`the guest panicked: ${panicText}`);
  }
}

/** A command was acknowledged by nothing within the timeout. */
export class TauriCommandTimeoutError extends Error {
  override readonly name = 'TauriCommandTimeoutError';
  constructor(
    readonly line: string,
    readonly timeoutMs: number,
  ) {
    super(`no completion barrier for "${line}" within ${String(timeoutMs)} ms`);
  }
}

/** A command word or argument the serial CLI cannot express. */
export class TauriUnsupportedCommandError extends Error {
  override readonly name = 'TauriUnsupportedCommandError';
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`"${command}" cannot be sent over the serial CLI: ${reason}`);
  }
}

/**
 * `RobotState` plus the things only a telemetry-derived backend can say.
 *
 * Structurally the same `observed` sub-object `QemuRobotState` carries, and for
 * the same reason: a separate object so nothing in it can be mistaken for a
 * property of the robot. It is redeclared rather than imported because
 * `QemuRobotState` lives in a module that reaches `node:child_process`.
 */
export interface TauriRobotState extends RobotState {
  readonly observed: {
    /**
     * Per joint: has a `@SESAME servo` line for this channel actually been
     * seen? False means `commandedDeg` is {@link POWER_ON_ANGLE_DEG}, an
     * assumption, and a UI must not draw it as a report.
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

export interface TauriRobotOptions {
  /**
   * The transport. Defaults to Tauri IPC; the contract suite passes the same
   * Rust supervisor reached over `--supervisor-stdio` instead.
   */
  readonly supervisor?: EmulatorSupervisor;
  /** Boot attempts before `connect()` gives up. Default: Rust's 12. */
  readonly bootAttempts?: number;
  /** Milliseconds for one attempt's banner. Default: Rust's 15000. */
  readonly bootTimeoutMs?: number;
  /** Milliseconds to wait for a command's completion barrier. Default 90000. */
  readonly commandTimeoutMs?: number;
  /** Quiet period after a face change that counts as settled. Default 1200 ms. */
  readonly faceSettleMs?: number;
  /** Hard cap on face settling, for a face that never stops. Default 3000 ms. */
  readonly faceSettleMaxMs?: number;
  /** Progress, while booting. Default: nowhere. */
  readonly onEvent?: (event: SupervisorEvent) => void;
}

export class TauriSesameRobot implements SesameRobot {
  readonly #supervisor: EmulatorSupervisor;
  readonly #options: TauriRobotOptions;
  readonly #commandTimeoutMs: number;
  readonly #faceSettleMs: number;
  readonly #faceSettleMaxMs: number;
  readonly #listeners = new Set<(event: SesameTelemetry) => void>();

  #session: SupervisorSession | null = null;
  /**
   * Created on connect, not in the constructor.
   *
   * `defaultOrigin` has to be the origin of the image that was *actually*
   * booted, and only Rust knows which file it opened. `QemuSesameRobot` can
   * build its parser up front because it chose the path itself; here the path
   * is deliberately not ours to choose (T3 §3).
   */
  #parser: SesameTelemetryParser | null = null;
  /**
   * Bytes that arrived before `spawn()` resolved.
   *
   * Not hypothetical: Rust flushes everything received before the boot banner
   * — `@SESAME hello`, the `rest` face — the instant the banner lands, which is
   * *before* the `spawn_emulator` promise settles. Dropping them would lose the
   * boot; parsing them before the origin is known would stamp the wrong one. So
   * they queue, and `#openParser()` drains them in order in the same tick it
   * creates the parser. The parser's own invariant — output depends only on the
   * concatenated stream, never on chunking — is what makes the delay free.
   */
  #queued: (ArrayBuffer | Uint8Array)[] = [];
  #maxWriteBytes = DEFAULT_MAX_BATCH_BYTES;
  #queue: Promise<unknown> = Promise.resolve();

  // Observed state. Nothing in here is predicted.
  readonly #commandedDeg: Record<JointName, number>;
  readonly #everObserved: Record<JointName, boolean>;
  #faceName = '';
  #faceFrame = 0;
  #events = 0;
  #barriers = 0;
  #panic: string | null = null;
  #exited = false;
  #inFlight: InFlight | null = null;
  #lastCommandLine: string | null = null;
  #lastFaceAtMs = 0;
  #bootAttempts: readonly SupervisorBootAttempt[] = [];

  constructor(options: TauriRobotOptions = {}) {
    const supervisor = options.supervisor ?? tauriSupervisor();
    if (supervisor === null) {
      // Constructing this in a browser tab is a wiring mistake, not a runtime
      // condition: `default-backend.ts` selects this backend only inside the
      // desktop shell. Failing here rather than on first use puts the error
      // where the wiring is.
      throw new Error(
        'TauriSesameRobot: there is no Tauri IPC on this page, so there is no emulator to ' +
          'supervise. This backend exists only inside the desktop shell.',
      );
    }
    this.#supervisor = supervisor;
    this.#options = options;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 90_000;
    this.#faceSettleMs = options.faceSettleMs ?? 1200;
    this.#faceSettleMaxMs = options.faceSettleMaxMs ?? 3000;
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

  /** The live session as Rust described it, or `null`. */
  get session(): SupervisorSession | null {
    return this.#session;
  }

  /**
   * What each boot attempt did.
   *
   * The measurement, not a debug aid: ISSUE-20260823-022 fires on roughly a
   * quarter of cold boots and `> 1` has to be reportable without parsing a log.
   */
  get bootAttempts(): readonly SupervisorBootAttempt[] {
    return this.#bootAttempts;
  }

  /**
   * The origin stamped on every event this backend produces.
   *
   * **Composed, and each half comes from the party entitled to say it.**
   *
   * - `kind`, `board`, `elided`, `firmwareDeviations` come from
   *   `originForImage()` — the frozen, tested derivation in
   *   `@sesame-lab/sesame-qemu`, keyed off the image path. Rust refuses to
   *   invent these (T3 §7) precisely so there is one copy of them.
   * - `engine` is overridden with what **Rust read out of the binary it
   *   spawned** (`qemu-system-xtensa --version`). The derived value is a
   *   constant pinned to `QEMU_RELEASE`; the measured one is a fact about the
   *   process that ran. Where they can disagree — a differently built bundle —
   *   the measurement is the honest answer.
   *
   * The app cannot substitute a different identity: `SupervisorSpawnOptions`
   * has no path fields, the paths come from `resources::resolve`, and
   * `imageName` is reported by the process that opened the file. That is V7's
   * property, preserved without HTTP.
   */
  get origin(): TelemetryOrigin {
    const facts = this.#session?.origin;
    if (facts === undefined) return originForImage('');
    const derived = originForImage(facts.imagePath);
    return facts.engine === null ? derived : { ...derived, engine: facts.engine };
  }

  // =========================================================================
  // SesameRobot
  // =========================================================================

  /**
   * Boot QEMU through Rust and wait for the firmware's own end-of-`setup()`
   * banner.
   *
   * The retry past ISSUE-20260823-022 is Rust's — the mitigation for a QEMU
   * modelling bug, not a fix for it — and every attempt is reported on the
   * event channel while it happens, because a silent 17-second freeze reads as
   * a hang.
   *
   * Boot telemetry is not lost: Rust hands over everything it buffered before
   * the banner, and `#openParser()` replays it into subscribers here, so a
   * listener attached before `connect()` sees the boot it actually got and none
   * of the boots that panicked.
   */
  async connect(): Promise<void> {
    if (this.#session !== null) return;
    const info = await this.#supervisor.spawn(
      {
        ...(this.#options.bootAttempts === undefined
          ? {}
          : { bootAttempts: this.#options.bootAttempts }),
        ...(this.#options.bootTimeoutMs === undefined
          ? {}
          : { bootTimeoutMs: this.#options.bootTimeoutMs }),
      },
      (chunk) => this.#receive(chunk),
      (event) => this.#absorbSupervisorEvent(event),
    );
    this.#session = info;
    this.#bootAttempts = info.attempts;
    if (info.maxWriteBytes > 0) this.#maxWriteBytes = info.maxWriteBytes;
    this.#openParser();
  }

  /**
   * Stop QEMU and wait for the OS to confirm the process is gone.
   *
   * Idempotent, and safe on a robot that never connected. Anything already
   * queued is allowed to finish rather than having the socket torn out from
   * under it — a rejected in-flight command is noise, not information.
   */
  async disconnect(): Promise<void> {
    const wasConnected = this.#session !== null;
    this.#session = null;
    await this.#queue.catch(() => undefined);
    if (wasConnected) {
      try {
        await this.#supervisor.stop();
      } catch {
        // A stop that fails because nothing was running is not an error, and a
        // stop that fails because the transport is gone cannot be retried.
      }
    }
    this.#parser = null;
    this.#queued = [];
    await this.#supervisor.dispose?.();
  }

  /**
   * Truthful, and mostly qualifiers.
   *
   * The widened {@link QemuCapabilities} — the *same frozen object*
   * `QemuSesameRobot` returns for the same image, because it is the same
   * function. `oledFramebuffer` is `true` only when the booted image's name
   * says the framebuffer hook is compiled in, and an unrecognised name gets the
   * conservative answer.
   */
  capabilities(): Promise<QemuCapabilities> {
    return Promise.resolve(capabilitiesForImage(this.#session?.origin.imagePath ?? ''));
  }

  /**
   * Run one of the firmware's command words over the serial console.
   *
   * The two documented divergences from the HTTP path are the CLI's, not the
   * emulator's, and are reproduced exactly as `QemuSesameRobot` reproduces
   * them: `forward`/`backward`/`left`/`right` run **one** iteration because
   * `:795`–`:798` clear `currentCommand` after the call, and `stop` has no CLI
   * verb at all so it is encoded as a no-op face write — the only branch that
   * clears `currentCommand`.
   *
   * A word outside the vocabulary is **rejected**, not sent: an unknown word on
   * the console reaches the `sscanf` fallthrough and does nothing at all, and
   * refusing says so out loud instead of letting `st` silently dump subtrim
   * values.
   */
  command(name: string): Promise<void> {
    this.#require('command');
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
          new TauriUnsupportedCommandError(
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
        await this.#write([encoded]);
      } finally {
        this.#inFlight = null;
      }
    });
  }

  /**
   * `setFace(name)` over the console — `fc <name>`.
   *
   * **An unknown face emits nothing, and that is the correct result**
   * (ISSUE-20260823-004): `countFrames()` returns 0, the `defualt` fallback
   * table is also empty, `updateFaceBitmap()` is never reached and the firmware
   * hook is *inside* it. Silence on the wire is the firmware telling the truth
   * about a face it cannot draw, and neither this class nor a UI may paper over
   * it.
   *
   * The settle afterwards is not politeness: `currentFaceMode` powers on as
   * `FACE_ANIM_LOOP`, so a multi-frame face keeps emitting a frame per second
   * forever, and returning the instant the console acknowledged would hand the
   * caller's next assertion a stream that is still moving.
   */
  setFace(name: string): Promise<void> {
    this.#require('setFace');
    const encoded = encodeCommand({ type: 'face.set', name });
    return this.#enqueue(async () => {
      await this.#write([encoded]);
      await this.#settleFace();
    });
  }

  /** One channel, by firmware index — `<motor> <angle>` at `:870`. */
  setJoint(joint: JointName, angleDeg: number): Promise<void> {
    this.#require('setJoint');
    if (!isJointName(joint)) {
      return Promise.reject(new TauriUnsupportedCommandError(String(joint), 'not a joint name'));
    }
    const encoded = encodeCommand({ type: 'servo.set', joint, angleDeg });
    return this.#enqueue(() => this.#write([encoded]));
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
    this.#require('setPose');
    for (const key of Object.keys(pose)) {
      if (!isJointName(key)) {
        return Promise.reject(new TauriUnsupportedCommandError(key, 'not a joint name'));
      }
    }
    const encoded: EncodedCommand[] = [];
    for (const joint of JOINT_ORDER) {
      const deg = pose[joint];
      if (deg === undefined) continue;
      encoded.push(encodeCommand({ type: 'servo.set', joint, angleDeg: deg }));
    }
    if (encoded.length === 0) return Promise.resolve();
    return this.#enqueue(() => this.#write(encoded));
  }

  /**
   * The robot as the wire has described it. **A report, not a model.**
   *
   * Every angle here was seen leaving `setServoAngle()` after the clamp, or is
   * {@link POWER_ON_ANGLE_DEG} with `everObserved[joint]` false to say so.
   * There is no `simulatedDeg`, because nothing here models where a horn is
   * between commands, and no `measuredDeg`, because eight MG90S on one-way PWM
   * have no encoder, no pot tap and no firmware path.
   */
  getState(): Promise<TauriRobotState> {
    const joints = Object.fromEntries(
      JOINT_ORDER.map((joint): [JointName, JointState] => [
        joint,
        {
          commandedDeg: this.#commandedDeg[joint],
          measuredDeg: HAS_JOINT_POSITION_FEEDBACK ? this.#commandedDeg[joint] : null,
        },
      ]),
    ) as Record<JointName, JointState>;

    return Promise.resolve({
      // 'qemu' — real firmware really is executing. The desktop shell does not
      // change what is behind the wire, only which process owns the socket.
      mode: 'qemu',
      joints,
      face: {
        expression: this.#faceName,
        frame: this.#faceFrame,
        width: 128,
        height: 64,
      },
      // Not "we did not connect" — there is no radio to connect with. QEMU
      // models no ESP32 Wi-Fi MAC or PHY and this image has the bring-up
      // commented out; `'ap'` with a plausible IP would be a lie.
      network: { state: 'unavailable' },
      motion: { command: this.#inFlight?.word ?? '' },
      observed: this.observed,
    });
  }

  /**
   * The `observed` block of {@link getState}, **synchronously**.
   *
   * `TelemetryBackend.emulatorFacts()` is polled by the UI and is not async, on
   * purpose: it has to be able to render "still booting, attempt 3" without
   * awaiting anything. Everything in here is already a plain field, so there is
   * nothing to await — the promise `getState()` returns is a contract
   * requirement, not a computation.
   */
  get observed(): TauriRobotState['observed'] {
    return {
      everObserved: { ...this.#everObserved },
      events: this.#events,
      bootAttempts: this.#bootAttempts.length,
      pid: this.#session?.pid,
      uartPort: this.#session?.port ?? 0,
      lastCommandLine: this.#lastCommandLine,
      panic: this.#panic,
    };
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
    this.#require('send');
    const encoded = encodeCommand(command);
    return this.#enqueue(() => this.#write([encoded]));
  }

  // =========================================================================
  // Internals
  // =========================================================================

  #require(method: string): SupervisorSession {
    const session = this.#session;
    if (session === null) throw new TauriNotConnectedError(method);
    return session;
  }

  /** Create the parser, then replay everything that arrived before it existed. */
  #openParser(): void {
    this.#parser = new SesameTelemetryParser({
      // The firmware hook really ran and bytes really crossed UART0, so
      // `observed` is correct — and on its own it is also the exact ambiguity
      // that makes an emulator look like hardware. `defaultOrigin` is the half
      // that says which, and it names the image Rust actually opened.
      defaultProvenance: 'observed',
      defaultOrigin: this.origin,
    });
    const queued = this.#queued;
    this.#queued = [];
    for (const chunk of queued) this.#ingest(chunk);
  }

  #receive(chunk: ArrayBuffer | Uint8Array): void {
    if (this.#parser === null) {
      this.#queued.push(chunk);
      return;
    }
    this.#ingest(chunk);
  }

  #ingest(chunk: ArrayBuffer | Uint8Array): void {
    const parser = this.#parser;
    if (parser === null) return;
    for (const event of parser.push(chunk)) this.#absorb(event);
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
    } else if (event.type === 'log' && event.text.startsWith(BARRIER_MARKER)) {
      // The fence. Counted off the *parsed* stream rather than off the bytes,
      // which is exactly why it could not be ported into Rust.
      this.#barriers += 1;
    }
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * Progress from the supervisor. **Never parsed as telemetry.**
   *
   * `diagnostic` in particular is QEMU talking about itself; feeding it to the
   * parser would produce a `log` event tagged `provenance: 'observed'` for
   * something the guest never said.
   *
   * ## `guestPanic` and `exited` are ignored until there is a session, and that
   * is not a shortcut
   *
   * Roughly a quarter of cold boots panic inside QEMU's dual-core cache model
   * (ISSUE-20260823-022) and Rust retries past them — so a single `connect()`
   * routinely produces `guestPanic` and `exited` for processes that were
   * **abandoned**, before the one that booted. Recording those would leave a
   * healthy robot permanently holding a panic from a guest that no longer
   * exists, and the first command would fail with it. `session.ts` never had to
   * think about this: each attempt there is a fresh `QemuSession` object, so a
   * failed attempt's state is discarded with the object.
   *
   * Here the object outlives the retry loop, so the equivalent rule is
   * explicit: nothing before `spawn()` resolves describes the session that
   * survived. Found by the contract suite — four cases failed with
   * *"the guest panicked: Guru Meditation Error"* against an emulator that had
   * booted perfectly well on its third attempt.
   */
  #absorbSupervisorEvent(event: SupervisorEvent): void {
    if (this.#session !== null) {
      if (event.type === 'guestPanic') this.#panic = event.text;
      if (event.type === 'exited') this.#exited = true;
    }
    this.#options.onEvent?.(event);
  }

  /**
   * Write CLI lines and wait for the firmware to finish executing them.
   *
   * One write for the lines *and* the barrier, capped at the UART0 receive
   * budget, then a wait on the barrier count. See the class header for why the
   * barrier is a fence at all.
   */
  async #write(encoded: readonly EncodedCommand[]): Promise<void> {
    const lines = encoded.map((e) => e.line);
    this.#lastCommandLine = lines.join('; ');
    const payload = `${lines.map((l) => l + CLI_TERMINATOR).join('')}${BARRIER_COMMAND}${CLI_TERMINATOR}`;
    const bytes = new TextEncoder().encode(payload);
    if (bytes.length > this.#maxWriteBytes) {
      throw new Error(
        `batch of ${String(bytes.length)} bytes exceeds the ${String(this.#maxWriteBytes)}-byte ` +
          `UART0 receive budget; split it`,
      );
    }
    const want = this.#barriers + 1;
    await this.#supervisor.send(bytes);

    const line = lines.join(' ; ');
    const deadline = Date.now() + this.#commandTimeoutMs;
    while (this.#barriers < want) {
      if (this.#panic !== null) throw new TauriGuestPanicError(this.#panic);
      if (this.#exited) throw new Error(`QEMU exited while running "${line}"`);
      if (Date.now() > deadline) throw new TauriCommandTimeoutError(line, this.#commandTimeoutMs);
      await sleep(POLL_MS);
    }
  }

  /**
   * Wait until the panel has stopped moving, or until the next frame lands.
   *
   * Two exits, because there are two kinds of face. A static one (`happy`,
   * `wave` — one bitmap) emits once and goes quiet, so the quiet period is the
   * signal. An animated one in `FACE_ANIM_LOOP` never goes quiet, so the best
   * available signal is *a frame just landed*: returning immediately after one
   * gives the caller the full inter-frame interval instead of a slice of it.
   */
  async #settleFace(): Promise<void> {
    const start = Date.now();
    const seenAt = this.#lastFaceAtMs;
    for (;;) {
      const now = Date.now();
      if (this.#lastFaceAtMs > seenAt && this.#lastFaceAtMs > start) return;
      if (now - Math.max(this.#lastFaceAtMs, start) >= this.#faceSettleMs) return;
      if (now - start >= this.#faceSettleMaxMs) return;
      await sleep(20);
    }
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
