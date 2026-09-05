/**
 * Backend 3, inside the desktop app — real Sesame firmware under QEMU, with no
 * lab host and no HTTP anywhere in the path.
 *
 * ```text
 * a button in the Tauri window
 *   -> TauriSesameRobot.command('wave')   encodeCommand() -> "rn wv" + a barrier
 *   -> invoke('send_command', bytes)      Rust: one write_all to UART0
 *   -> real Xtensa instructions on an emulated ESP32
 *   -> @SESAME servo lines back on the byte Channel
 *   -> SesameTelemetryParser -> this class -> TelemetryStore -> Object3D.quaternion
 * ```
 *
 * `QemuBackend` is the same three claims over the wire: `apps/web/server/lab-host.mjs`
 * fronting `QemuSesameRobot`, reached with `fetch` and `EventSource`. **That
 * path is untouched and remains what `just dev` runs.** This one exists because
 * a packaged `.exe` has no origin to fetch from, and standing up a localhost
 * HTTP server inside a desktop app to talk to itself would be a second thing
 * that must not be reachable from the network.
 *
 * ## The three things this class keeps honest, unchanged from `QemuBackend`
 *
 * 1. **Emulated is not physical.** Every event carries
 *    `origin: { kind: 'emulator', board: 'distro-v1-esp32', … }`. `provenance`
 *    is `observed`, correctly — the firmware hook really ran — which is exactly
 *    why nothing may branch on `provenance === 'observed'`. The predicate is
 *    `isPhysicallyObserved()`, and it is **false for every event here**.
 * 2. **Booting is slow and sometimes fails.** Roughly a quarter of cold boots
 *    panic inside QEMU's dual-core cache model (ISSUE-20260823-022) and the
 *    supervisor retries past them. `status.attempts` and `status.elapsedMs`
 *    carry that to the UI *while it happens*, off the `attempt` /
 *    `attemptFailed` events — a silent multi-second freeze reads as a hang, and
 *    this project has made that mistake once already.
 * 3. **What the panel may claim comes from the capability record**, not from
 *    this class. `oledFramebuffer` is whatever `capabilitiesForImage()` says
 *    about the image *Rust opened*, and `elided` is what lets the OLED pane
 *    explain why it drew something itself.
 *
 * There is no reconnect loop, for `QemuBackend`'s reason: the far end is one
 * QEMU process with a boot cost measured in seconds, and silently redialling it
 * would hide a dead emulator behind a spinner.
 */
import type { JointName, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { capabilitiesForImage, type QemuCapabilities } from '@sesame-lab/sesame-qemu/capabilities';
import type { SimulatedRobotState } from '@sesame-lab/sesame-sim';

import type { BackendStatus, EmulatorFacts, TelemetryBackend } from '../types.js';

import { TauriSesameRobot, type TauriRobotOptions } from './robot.js';
import type { SupervisorEvent } from './supervisor.js';

export interface TauriBackendOptions {
  /** Passed straight to {@link TauriSesameRobot}. The suite injects a transport. */
  readonly robot?: TauriRobotOptions;
}

export class TauriBackend implements TelemetryBackend {
  /**
   * `'qemu'`, and it is the same id the browser path uses.
   *
   * A fourth `BackendId` was the other option and it is the wrong one: this is
   * not a fourth kind of thing to reason about, it is the *same* backend —
   * real firmware under Espressif's QEMU, commanded over the firmware's own
   * serial console — reached without a lab host in between. Everything keyed
   * off the id (the rail's `QEM` chip, the trace panel's row matching, W8's
   * default selection) is already correct for it, and a new id would have meant
   * teaching each of those about a distinction the reader does not have.
   */
  readonly id = 'qemu' as const;
  readonly label = 'QEMU (real firmware)';
  readonly description =
    'The actual compiled Sesame firmware executing instruction by instruction on an emulated ' +
    'ESP32 under Espressif’s QEMU fork, bundled inside this app. Buttons here become lines on ' +
    'the firmware’s own serial console, and every servo angle you see left setServoAngle() ' +
    'inside the guest. It is an emulator, not hardware, and it is the LEGACY distro-v1-esp32 ' +
    'board — not the S2 Mini the report recommends for DIY builds, which QEMU cannot emulate ' +
    'at all.';
  /**
   * `'observed'`, doing less work than it looks like.
   *
   * An emulated UART is a real boundary, so `observed` is the honest word. What
   * it does not mean is "measured on a robot"; `origin` is the field that
   * separates those. See {@link emulatorFacts}.
   */
  readonly expectedProvenance = 'observed' as const;
  readonly canCommand = true;
  readonly commandUnavailableReason = null;

  readonly #options: TauriBackendOptions;
  readonly #eventListeners = new Set<(event: SesameTelemetry) => void>();
  readonly #statusListeners = new Set<(status: BackendStatus) => void>();

  #robot: TauriSesameRobot | null = null;
  #unsubscribe: (() => void) | null = null;
  #capabilities: QemuCapabilities | null = null;
  #status: BackendStatus = { connection: 'idle', detail: 'not started', eventsReceived: 0 };
  #startedAtMs = 0;
  #attempts = 0;
  #failedAttempts = 0;
  #stopped = false;

  constructor(options: TauriBackendOptions = {}) {
    this.#options = options;
  }

  get status(): BackendStatus {
    return this.#status;
  }

  /** The robot itself, for the debug hook and the lab panes. */
  get robot(): TauriSesameRobot | null {
    return this.#robot;
  }

  async start(): Promise<void> {
    if (this.#robot !== null) return;
    this.#stopped = false;
    this.#startedAtMs = Date.now();
    this.#attempts = 0;
    this.#failedAttempts = 0;
    this.#setStatus({
      connection: 'connecting',
      detail: 'starting the bundled emulator',
      eventsReceived: 0,
      attempts: 1,
      elapsedMs: 0,
    });

    const robot = new TauriSesameRobot({
      ...this.#options.robot,
      onEvent: (event) => this.#onSupervisorEvent(event),
    });
    this.#robot = robot;
    // Subscribed BEFORE connect(), so the boot telemetry Rust buffers ahead of
    // the banner — `@SESAME hello`, the `rest` face `setup()` ends with —
    // reaches the store. A subscriber attached afterwards would miss the boot.
    this.#unsubscribe = robot.subscribe((event) => {
      this.#status = { ...this.#status, eventsReceived: this.#status.eventsReceived + 1 };
      for (const listener of this.#eventListeners) listener(event);
    });

    try {
      await robot.connect();
    } catch (error) {
      this.#setStatus({
        connection: 'error',
        detail:
          `the bundled emulator failed to boot: ${error instanceof Error ? error.message : String(error)}` +
          this.#retryNote(),
        eventsReceived: this.#status.eventsReceived,
        attempts: Math.max(this.#attempts, 1),
        elapsedMs: Date.now() - this.#startedAtMs,
      });
      return;
    }
    if (this.#stopped) return;

    this.#capabilities = await robot.capabilities();
    const session = robot.session;
    this.#setStatus({
      connection: 'connected',
      detail:
        `real firmware executing under QEMU · booted in ${String(session?.bootMs ?? 0)} ms ` +
        `after ${String(session?.attempts.length ?? 1)} attempt(s)${this.#retryNote()}`,
      eventsReceived: this.#status.eventsReceived,
      attempts: session?.attempts.length ?? 1,
      elapsedMs: session?.totalMs ?? Date.now() - this.#startedAtMs,
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const robot = this.#robot;
    this.#robot = null;
    await robot?.disconnect();
    this.#setStatus({
      connection: 'closed',
      // Unlike the lab-host path, stopping here really does stop the emulator:
      // this app owns the process. Saying otherwise would be a claim about a
      // QEMU that no longer exists.
      detail: 'the emulator was stopped and the QEMU process is gone',
      eventsReceived: this.#status.eventsReceived,
    });
  }

  onEvent(listener: (event: SesameTelemetry) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onStatus(listener: (status: BackendStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * `options.traceId` is dropped, and the trace panel says so.
   *
   * The `@SESAME` wire has an `x=` trace tag, but it is device → host: the
   * firmware would have to *know* an id to echo one and it has no such concept.
   * The channel into the guest is `rn wv` on a 32-byte CLI buffer — no room and
   * no field. Anything displayed as a causal join here would be a fiction.
   */
  async command(name: string, options: { readonly traceId?: string } = {}): Promise<void> {
    void options.traceId;
    await this.#require().command(name);
  }

  async setFace(name: string): Promise<void> {
    await this.#require().setFace(name);
  }

  async setJoint(joint: JointName, angleDeg: number): Promise<void> {
    await this.#require().setJoint(joint, angleDeg);
  }

  /**
   * `null`, always.
   *
   * `TauriSesameRobot.getState()` reports, it does not model. There is no
   * `simulatedDeg` because nothing here computes where a horn would be between
   * commands, and inventing a slew curve would be a simulator wearing an
   * emulator's clothes. The joint inspector shows an empty cell instead.
   */
  modelState(): Promise<SimulatedRobotState | null> {
    return Promise.resolve(null);
  }

  capabilities(): Promise<SesameCapabilities | null> {
    return Promise.resolve(this.#capabilities);
  }

  /**
   * The qualifiers, and **not one of them is asserted by this app.**
   *
   * `origin` is composed by the robot from Rust's measured facts and the frozen
   * path-derived record in `@sesame-lab/sesame-qemu`; everything else comes out
   * of `capabilitiesForImage()`, the same function `QemuSesameRobot` calls, on
   * the image Rust actually opened. If the bundled image were renamed so the
   * framebuffer hook could not be recognised, this would report
   * `oledFramebuffer: false` with `ssd1306-panel` back on the elision list —
   * under-claiming rather than showing host-drawn pixels as the emulator's.
   */
  emulatorFacts(): EmulatorFacts | null {
    const robot = this.#robot;
    if (robot === null) return null;
    const session = robot.session;
    const caps =
      this.#capabilities ?? capabilitiesForImage(session?.origin.imagePath ?? '');
    const observed = robot.observed;
    return {
      origin: robot.origin,
      board: caps.board,
      unsupportedBoards: caps.unsupportedBoards,
      commandChannel: caps.commandChannel,
      elided: caps.elided,
      firmwareDeviations: caps.firmwareDeviations,
      knownFlakiness: caps.knownFlakiness,
      oledFramebuffer: caps.oledFramebuffer,
      // Only once the emulator is actually up: `'qemu'` is the mode of a robot
      // that is running, and reporting it while the boot is still retrying
      // would name a machine that does not exist yet.
      mode: session === null ? null : 'qemu',
      everObserved: observed.everObserved,
      lastCommandLine: observed.lastCommandLine,
      panic: observed.panic,
    };
  }

  // ------------------------------------------------------------------ inner

  #require(): TauriSesameRobot {
    const robot = this.#robot;
    if (robot === null) {
      throw new Error('the emulator backend has not been started');
    }
    return robot;
  }

  /**
   * The retry, made visible.
   *
   * `attempt` fires before each boot and `attemptFailed` after each failure, so
   * the counter moves during the wait rather than being reconstructed from the
   * attempt log afterwards. That is the whole reason T3 put them on the event
   * channel.
   */
  #onSupervisorEvent(event: SupervisorEvent): void {
    if (event.type === 'attempt') {
      this.#attempts = event.attempt;
      this.#setStatus({
        connection: 'connecting',
        detail:
          `booting real firmware — attempt ${String(event.attempt)} of ${String(event.of)}, ` +
          `${String(Math.round((Date.now() - this.#startedAtMs) / 100) / 10)} s elapsed` +
          this.#retryNote(),
        eventsReceived: this.#status.eventsReceived,
        attempts: event.attempt,
        elapsedMs: Date.now() - this.#startedAtMs,
      });
    } else if (event.type === 'attemptFailed') {
      this.#failedAttempts += 1;
    }
    // `diagnostic` is QEMU talking about itself and is deliberately not shown
    // as telemetry anywhere; `guestPanic` after boot reaches the UI through
    // `emulatorFacts().panic`, which is where a last-known-value warning
    // belongs.
  }

  #retryNote(): string {
    if (this.#failedAttempts === 0) return '';
    return (
      ` · ${String(this.#failedAttempts)} boot(s) panicked and were relaunched — ` +
      'ISSUE-20260823-022, a QEMU cache-modelling bug this retries past rather than fixes'
    );
  }

  #setStatus(status: BackendStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
