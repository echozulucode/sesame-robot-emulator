/**
 * Backend 2 — the Phase-0 bridge, over its WebSocket.
 *
 * ```text
 * instrumented firmware (QEMU / Renode / a real board)
 *      -> UART bytes -> @SESAME streaming parser -> TelemetryEnvelope
 *      -> ws://host:port/telemetry -> this class -> the same scene
 * ```
 *
 * This is the payoff of the Phase-0 architecture and the reason the app has a
 * backend switch at all. Q1 showed real firmware emitting real `@SESAME` lines
 * through this exact bridge with **zero bridge changes**; nothing below knows
 * or cares whether the bytes came from an emulator, a replay fixture or a board
 * on a USB cable. Point `--uart-port` at something else and this scene is
 * driven by it.
 *
 * ## Three deliberate refusals
 *
 * 1. **No commands.** `@SESAME` v1 defines no host → device messages and the
 *    bridge's hub discards anything a client sends, on purpose: "this port must
 *    not become an accidental control API" (`ws-hub.ts`). So `canCommand` is
 *    false and the UI says why instead of silently disabling buttons.
 * 2. **No provenance of our own.** Envelopes carry the parser's decision, and
 *    that decision is a deployment fact the app must not override: a live UART
 *    socket defaults to `observed`, a `--replay` fixture to `simulated`. The
 *    app reads `event.provenance` and displays it.
 * 3. **No re-derived envelope type.** `TelemetryEnvelope` is imported as a
 *    *type* from `@sesame-lab/sesame-bridge`, so the shape stays coupled to the
 *    producer. The runtime guard is local only because the bridge package's
 *    entry point pulls in `node:http` and `ws`, which cannot be bundled for a
 *    browser.
 * 4. **No mixing of the robot and the plumbing.** Every envelope carries an
 *    `origin`, and R6/R7 put it there for exactly this reason: "the bridge has
 *    to be able to talk about *itself*… those messages are not observations of
 *    the robot." Only `origin: "uart"` events reach the telemetry stream. The
 *    bridge's own lifecycle lines are surfaced as connection status, so
 *    "reconnected after 4 attempts" cannot end up counted as something the
 *    robot did — even though the bridge, correctly, tags its own lifecycle
 *    `observed`.
 */
import type { JointName, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import type { TelemetryEnvelope } from '@sesame-lab/sesame-bridge';
import type { SimulatedRobotState } from '@sesame-lab/sesame-sim';

import { BackendReadOnlyError, type BackendStatus, type TelemetryBackend } from './types.js';

/** The bridge's default. `--ws-port` moves it. */
export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787/telemetry';

/**
 * The origin-relative URL, used when the page is being served *by* the bridge.
 *
 * `--serve-viewer --viewer-dir apps/web/dist` puts this app on the same HTTP
 * server the WebSocket upgrades on, so the socket is one hop away with no port
 * to type and no cross-origin question. That is how the headless verification
 * drives the bridge path.
 */
export function sameOriginBridgeUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_BRIDGE_URL;
  const { protocol, host } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return DEFAULT_BRIDGE_URL;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/telemetry`;
}

const WS_ENVELOPE_VERSION = 1;

/**
 * Structural check on one frame off the socket.
 *
 * Mirrors `isTelemetryEnvelope` in the bridge package. Duplicated rather than
 * imported because that module's package entry point is Node-only; the *type*
 * is imported, so a change to the envelope shape is a compile error here.
 */
function isEnvelope(value: unknown): value is TelemetryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<TelemetryEnvelope>;
  return (
    e.v === WS_ENVELOPE_VERSION &&
    typeof e.n === 'number' &&
    (e.origin === 'uart' || e.origin === 'bridge') &&
    typeof e.tHostMs === 'number' &&
    typeof e.event === 'object' &&
    e.event !== null &&
    typeof (e.event as SesameTelemetry).type === 'string'
  );
}

export interface BridgeBackendOptions {
  readonly url?: string;
  /** Reconnect automatically. Default true. */
  readonly reconnect?: boolean;
}

export class BridgeBackend implements TelemetryBackend {
  readonly id = 'bridge' as const;
  readonly label = 'Bridge WebSocket';
  readonly description =
    'Decoded @SESAME telemetry arriving over the Phase-0 bridge. Whatever is on the far end of ' +
    "the bridge's UART socket — QEMU, Renode, a replay fixture, a real board — drives this scene " +
    'unchanged. The bridge needed no modification to make that true.';
  readonly expectedProvenance = 'per-event' as const;
  readonly canCommand = false;
  readonly commandUnavailableReason =
    '@SESAME v1 is device → host only, and the bridge hub deliberately discards client messages so ' +
    'the telemetry port cannot become an accidental control API. Drive the firmware from its own ' +
    'console, HTTP API or serial CLI; this view is a window, not a remote.';

  readonly #eventListeners = new Set<(event: SesameTelemetry) => void>();
  readonly #statusListeners = new Set<(status: BackendStatus) => void>();
  readonly #reconnect: boolean;

  #url: string;
  #socket: WebSocket | null = null;
  #closing = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retries = 0;
  #status: BackendStatus = { connection: 'idle', detail: 'not started', eventsReceived: 0 };
  /** Last envelope index seen, so a gap in the stream is reported, not hidden. */
  #lastN = 0;
  #gaps = 0;
  /** Envelopes with `origin: "bridge"` — facts about the plumbing, not the robot. */
  #lifecycle: string[] = [];

  constructor(options: BridgeBackendOptions = {}) {
    this.#url = options.url ?? sameOriginBridgeUrl();
    this.#reconnect = options.reconnect ?? true;
  }

  get url(): string {
    return this.#url;
  }

  get gaps(): number {
    return this.#gaps;
  }

  /** The bridge's own lifecycle log, kept out of the robot's event stream. */
  get lifecycle(): readonly string[] {
    return this.#lifecycle;
  }

  get status(): BackendStatus {
    return this.#status;
  }

  start(): Promise<void> {
    this.#closing = false;
    this.#open();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.#closing = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#socket?.close(1000, 'backend switched');
    this.#socket = null;
    this.#setStatus({ connection: 'closed', detail: 'socket closed', eventsReceived: this.#status.eventsReceived });
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

  command(name: string): Promise<void> {
    void name;
    return Promise.reject(new BackendReadOnlyError(this.id, this.commandUnavailableReason));
  }

  setFace(name: string): Promise<void> {
    void name;
    return Promise.reject(new BackendReadOnlyError(this.id, this.commandUnavailableReason));
  }

  setJoint(joint: JointName, angleDeg: number): Promise<void> {
    void joint;
    void angleDeg;
    return Promise.reject(new BackendReadOnlyError(this.id, this.commandUnavailableReason));
  }

  /**
   * `null`, always, and not for want of trying.
   *
   * A decoded wire stream carries the post-clamp commanded angle and nothing
   * else. There is no slew model on the far side to ask for `simulatedDeg`, and
   * there is certainly no sensor to ask for `measuredDeg`. Returning a guess
   * shaped like a state object would be worse than returning nothing.
   */
  modelState(): Promise<SimulatedRobotState | null> {
    return Promise.resolve(null);
  }

  capabilities(): Promise<SesameCapabilities | null> {
    return Promise.resolve(null);
  }

  #open(): void {
    this.#setStatus({ connection: 'connecting', detail: `dialling ${this.#url}`, eventsReceived: this.#status.eventsReceived });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#retries = 0;
      this.#setStatus({
        connection: 'connected',
        detail: `${this.#url} — the hub replays its ring buffer on connect, so a movement that already finished still appears`,
        eventsReceived: this.#status.eventsReceived,
      });
    };

    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!isEnvelope(parsed)) return;
      if (this.#lastN !== 0 && parsed.n !== this.#lastN + 1) this.#gaps += 1;
      this.#lastN = parsed.n;

      if (parsed.origin === 'bridge') {
        // Plumbing, not telemetry. Shown as connection detail so a dropped
        // UART socket is visible, but never counted as a robot event.
        const text = parsed.event.type === 'log' ? parsed.event.text : parsed.event.type;
        this.#lifecycle.push(text);
        if (this.#lifecycle.length > 50) this.#lifecycle = this.#lifecycle.slice(-50);
        this.#setStatus({ ...this.#status, detail: `${this.#url} — ${text}` });
        return;
      }

      this.#status = { ...this.#status, eventsReceived: this.#status.eventsReceived + 1 };
      for (const listener of this.#eventListeners) listener(parsed.event);
    };

    socket.onerror = () => {
      // The browser deliberately gives no detail here, for origin-privacy
      // reasons. Say that rather than inventing a cause.
      this.#fail(`could not reach ${this.#url} (the browser does not disclose why)`);
    };

    socket.onclose = (event) => {
      if (this.#closing) return;
      this.#fail(`socket closed (code ${event.code}${event.reason === '' ? '' : `: ${event.reason}`})`);
    };
  }

  #fail(detail: string): void {
    this.#socket = null;
    this.#setStatus({ connection: 'error', detail, eventsReceived: this.#status.eventsReceived });
    if (!this.#reconnect || this.#closing) return;
    this.#retries += 1;
    const delay = Math.min(500 * 2 ** (this.#retries - 1), 5000);
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.#open(), delay);
  }

  #setStatus(status: BackendStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
