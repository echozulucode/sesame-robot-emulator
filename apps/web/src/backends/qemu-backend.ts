/**
 * Backend 3 — real Sesame firmware under QEMU, **commandable from this page.**
 *
 * ```text
 * a button in this tab
 *   -> POST /api/command {"command":"wave"}      the firmware's own route
 *   -> SesameApiAdapter (@sesame-lab/sesame-api) -> QemuSesameRobot
 *   -> "rn wv" on UART0 -> real Xtensa instructions on an emulated ESP32
 *   -> @SESAME servo lines back -> GET /lab/stream (SSE) -> this class
 *   -> TelemetryStore -> Object3D.quaternion
 * ```
 *
 * `apps/web/server/lab-host.mjs` is the process in the middle, and its own
 * header explains why the HTTP adapter was chosen over the bridge's
 * `--allow-control` path.
 *
 * ## The three things this class exists to keep honest
 *
 * 1. **Emulated is not physical.** Every event arriving here carries
 *    `origin: { kind: 'emulator', board: 'distro-v1-esp32', … }`, stamped by
 *    `QemuSesameRobot` — the only party that actually knows. `provenance` is
 *    `observed`, correctly: the firmware hook really ran. That is precisely why
 *    nothing may branch on `provenance === 'observed'`; the predicate is
 *    `isPhysicallyObserved()`, and it is **false for every event on this
 *    transport**.
 * 2. **Booting is slow and sometimes fails.** `connect()` is 2–17 s and retries
 *    past ISSUE-20260823-022 (28% of cold boots panic inside QEMU's dual-core
 *    cache model). `status.attempts` and `status.elapsedMs` carry that to the
 *    UI while it happens rather than after.
 * 3. **The panel is elided.** `oledFramebuffer: false` — QEMU attaches no
 *    SSD1306 — so the firmware emits face *events* and no pixels at all. The
 *    store's existing `rendered`/`inferred` split already labels host-drawn
 *    pixels correctly; `emulatorFacts().elided` is what lets the OLED panel say
 *    *why* it had to.
 *
 * There is no reconnect loop. The far end is one QEMU process with a boot cost
 * measured in seconds; silently redialling it would hide a dead emulator behind
 * a spinner. A dropped stream is reported and stays reported.
 */
import type { JointName, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import type { SimulatedRobotState } from '@sesame-lab/sesame-sim';

import type { BackendStatus, EmulatorFacts, TelemetryBackend } from './types.js';

/** Same origin by default: the lab host serves this app. */
export function defaultLabBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8099';
  return window.location.origin;
}

/** What `/lab/session` answers with. Everything optional: it is a foreign JSON. */
interface LabSession {
  readonly backend?: string;
  readonly phase?: string;
  readonly detail?: string;
  readonly attempts?: number;
  readonly failedAttempts?: number;
  readonly attemptLog?: readonly { attempt: number; ok: boolean; reason?: string; ms?: number }[];
  readonly elapsedMs?: number;
  readonly error?: string | null;
  readonly events?: number;
  readonly physicallyObservedEvents?: number;
  readonly capabilities?: Record<string, unknown> | null;
  readonly origin?: Record<string, unknown> | null;
  readonly robotState?: Record<string, unknown> | null;
}

export interface QemuBackendOptions {
  /** Where the lab host lives. Default: this page's origin. */
  readonly baseUrl?: string;
  /** How often to poll `/lab/session`. Default 700 ms. */
  readonly pollMs?: number;
}

export class QemuBackend implements TelemetryBackend {
  readonly id = 'qemu' as const;
  readonly label = 'QEMU (real firmware)';
  readonly description =
    'The actual compiled Sesame firmware executing instruction by instruction on an emulated ' +
    'ESP32 under Espressif’s QEMU fork. Buttons here become lines on the firmware’s own serial ' +
    'console, and every servo angle you see left setServoAngle() inside the guest. It is an ' +
    'emulator, not hardware, and it is the LEGACY distro-v1-esp32 board — not the S2 Mini the ' +
    'report recommends for DIY builds, which QEMU cannot emulate at all.';
  /**
   * `'observed'`, and that word is doing less work than it looks like.
   *
   * Q2 §5: `observed` means a real boundary was crossed, and an emulated UART
   * is a real boundary. What it does *not* mean is "measured on a robot" —
   * `origin` is the field that separates those, and `isPhysicallyObserved()` is
   * the predicate. See {@link emulatorFacts}.
   */
  readonly expectedProvenance = 'observed' as const;
  readonly canCommand = true;
  readonly commandUnavailableReason = null;

  readonly #baseUrl: string;
  readonly #pollMs: number;
  readonly #eventListeners = new Set<(event: SesameTelemetry) => void>();
  readonly #statusListeners = new Set<(status: BackendStatus) => void>();

  #source: EventSource | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #status: BackendStatus = { connection: 'idle', detail: 'not started', eventsReceived: 0 };
  #session: LabSession | null = null;
  #capabilities: SesameCapabilities | null = null;
  /** Last envelope index seen, so a gap in the SSE stream is reported. */
  #lastN = 0;
  #gaps = 0;

  constructor(options: QemuBackendOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? defaultLabBaseUrl()).replace(/\/$/, '');
    this.#pollMs = options.pollMs ?? 700;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get gaps(): number {
    return this.#gaps;
  }

  get status(): BackendStatus {
    return this.#status;
  }

  /** The raw `/lab/session` document, for the debug hook. */
  get session(): unknown {
    return this.#session;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#setStatus({
      connection: 'connecting',
      detail: `asking ${this.#baseUrl}/lab/session what is behind it`,
      eventsReceived: 0,
      attempts: 1,
      elapsedMs: 0,
    });
    await this.#refresh();
    this.#poll = setInterval(() => void this.#refresh(), this.#pollMs);
    this.#openStream();
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#poll !== null) clearInterval(this.#poll);
    this.#poll = null;
    this.#source?.close();
    this.#source = null;
    this.#setStatus({
      connection: 'closed',
      detail: 'stream closed (the emulator keeps running; the lab host owns it)',
      eventsReceived: this.#status.eventsReceived,
    });
    return Promise.resolve();
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
   * `POST /api/command {"command":"wave"}` — the firmware's own route, verbatim.
   *
   * Deliberately the same request the real robot would answer on port 80. The
   * response comes back *before* the movement finishes, because that is what
   * `handleApiCommand` does upstream ("We send 200 OK immediately so the web
   * browser doesn't hang waiting for animation to finish", `:231`). So a
   * resolved promise here means "the firmware accepted it", not "the robot
   * finished" — the telemetry stream is what says that.
   */
  async command(name: string): Promise<void> {
    if (name === 'stop') {
      await this.#postCommand({ command: 'stop' });
      return;
    }
    await this.#postCommand({ command: name });
  }

  async setFace(name: string): Promise<void> {
    await this.#postCommand({ face: name });
  }

  /**
   * `GET /cmd?motor=<joint>&value=<deg>` — `handleCommandWeb`'s motor branch.
   *
   * The firmware accepts the eight enum names as well as 1-based indices
   * (`servoNameToIndex()`), and unlike a pose it answers *after* the write.
   */
  async setJoint(joint: JointName, angleDeg: number): Promise<void> {
    const url =
      `${this.#baseUrl}/cmd?motor=${encodeURIComponent(joint)}` +
      `&value=${encodeURIComponent(String(Math.round(angleDeg)))}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`the firmware refused /cmd?motor=${joint}: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * `null`, always.
   *
   * Q2 §3.1: `QemuSesameRobot.getState()` reports, it does not model. There is
   * no `simulatedDeg` because nothing here computes where a horn would be
   * between commands, and inventing a slew curve would be a simulator wearing
   * an emulator's clothes. The joint inspector shows an empty cell instead.
   */
  modelState(): Promise<SimulatedRobotState | null> {
    return Promise.resolve(null);
  }

  capabilities(): Promise<SesameCapabilities | null> {
    return Promise.resolve(this.#capabilities);
  }

  /**
   * The qualifiers, straight out of `QemuSesameRobot.capabilities()`.
   *
   * Nothing here is asserted by this app. Every field is transported from the
   * package that owns the emulator, which is the only party entitled to say
   * what it does and does not model.
   */
  emulatorFacts(): EmulatorFacts | null {
    const caps = this.#session?.capabilities;
    const origin = (caps?.['origin'] ?? this.#session?.origin) as EmulatorFacts['origin'] | undefined;
    if (caps === undefined || caps === null || origin === undefined || origin === null) return null;
    const state = this.#session?.robotState as
      | { mode?: EmulatorFacts['mode']; observed?: Record<string, unknown> }
      | null
      | undefined;
    const observed = state?.observed;
    return {
      origin,
      board: String(caps['board'] ?? origin.board ?? 'unknown'),
      unsupportedBoards: (caps['unsupportedBoards'] ?? {}) as Readonly<Record<string, string>>,
      commandChannel: String(caps['commandChannel'] ?? 'unknown'),
      elided: (caps['elided'] ?? origin.elided ?? []) as readonly string[],
      firmwareDeviations: (caps['firmwareDeviations'] ?? origin.firmwareDeviations ?? []) as readonly string[],
      knownFlakiness: String(caps['knownFlakiness'] ?? ''),
      oledFramebuffer: caps['oledFramebuffer'] === true,
      mode: state?.mode ?? null,
      everObserved: (observed?.['everObserved'] as Readonly<Record<string, boolean>>) ?? null,
      lastCommandLine: (observed?.['lastCommandLine'] as string | null) ?? null,
      panic: (observed?.['panic'] as string | null) ?? null,
    };
  }

  // ------------------------------------------------------------------ inner

  async #postCommand(payload: Record<string, string>): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/api/command`, {
      method: 'POST',
      // `application/json`, not a form: `server.arg("plain")` is empty for a
      // form-urlencoded body, which is the single most common way to get a
      // mystifying 400 out of the real robot (adapter.ts, `buildRequestArgs`).
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        response.status === 503
          ? `the emulator is not ready yet: ${text}`
          : `POST /api/command → ${response.status} ${text}`,
      );
    }
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) return;
    let session: LabSession;
    try {
      const response = await fetch(`${this.#baseUrl}/lab/session`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      session = (await response.json()) as LabSession;
    } catch (error) {
      this.#setStatus({
        connection: 'error',
        detail:
          `no lab host at ${this.#baseUrl} (${error instanceof Error ? error.message : String(error)}). ` +
          'Start it with: node apps/web/server/lab-host.mjs',
        eventsReceived: this.#status.eventsReceived,
      });
      return;
    }
    this.#session = session;
    this.#capabilities = (session.capabilities ?? null) as SesameCapabilities | null;

    const attempts = session.attempts ?? 1;
    const failed = session.failedAttempts ?? 0;
    const retryNote =
      failed === 0
        ? ''
        : ` · ${String(failed)} boot(s) panicked and were relaunched — ISSUE-20260823-022, a QEMU ` +
          `cache-modelling bug this retries past rather than fixes`;

    if (session.phase === 'failed') {
      this.#setStatus({
        connection: 'error',
        detail: `the emulator failed to boot: ${session.error ?? 'no reason given'}${retryNote}`,
        eventsReceived: this.#status.eventsReceived,
        attempts,
        elapsedMs: session.elapsedMs ?? 0,
      });
      return;
    }
    if (session.phase === 'booting' || session.phase === 'starting') {
      this.#setStatus({
        connection: 'connecting',
        detail:
          `booting real firmware — attempt ${String(attempts)}, ` +
          `${String(Math.round((session.elapsedMs ?? 0) / 100) / 10)} s elapsed. ` +
          `${session.detail ?? ''}${retryNote}`,
        eventsReceived: this.#status.eventsReceived,
        attempts,
        elapsedMs: session.elapsedMs ?? 0,
      });
      return;
    }
    if (this.#source !== null && this.#source.readyState === 1) {
      this.#setStatus({
        connection: 'connected',
        detail:
          `real firmware executing under QEMU · booted in ${String(session.elapsedMs ?? 0)} ms ` +
          `after ${String(attempts)} attempt(s)${retryNote}`,
        eventsReceived: this.#status.eventsReceived,
        attempts,
        elapsedMs: session.elapsedMs ?? 0,
      });
    }
  }

  #openStream(): void {
    if (this.#stopped) return;
    const source = new EventSource(`${this.#baseUrl}/lab/stream`);
    this.#source = source;

    source.onopen = () => {
      // Deliberately not composing a status here. Spreading the previous one
      // would carry a stale `elapsedMs`/`attempts` forward and announce
      // "connected, 0 ms" a poll ahead of the real numbers — the boot cost
      // would then be reported as zero, which is exactly the fact this backend
      // is supposed to stop hiding. Ask the session endpoint instead.
      void this.#refresh();
    };

    source.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data as string);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const frame = parsed as { n?: number; event?: SesameTelemetry };
      const event = frame.event;
      if (event === undefined || typeof event.type !== 'string') return;
      if (this.#lastN !== 0 && frame.n !== this.#lastN + 1) this.#gaps += 1;
      this.#lastN = frame.n ?? this.#lastN;
      this.#status = { ...this.#status, eventsReceived: this.#status.eventsReceived + 1 };
      for (const listener of this.#eventListeners) listener(event);
    };

    source.onerror = () => {
      if (this.#stopped) return;
      // EventSource redials on its own; what must not happen is the UI
      // continuing to claim "connected" while nothing is arriving.
      this.#setStatus({
        connection: 'error',
        detail:
          `the telemetry stream from ${this.#baseUrl}/lab/stream dropped. The emulator may have ` +
          'panicked — check the lab host’s output.',
        eventsReceived: this.#status.eventsReceived,
        ...(this.#status.attempts === undefined ? {} : { attempts: this.#status.attempts }),
      });
    };
  }

  #setStatus(status: BackendStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
