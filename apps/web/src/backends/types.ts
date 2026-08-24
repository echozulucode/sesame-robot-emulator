/**
 * The backend seam.
 *
 * The research report's architectural claim is that lesson code, the inspector
 * and the 3D scene talk to *one* thing and the backend underneath is a swap.
 * Phase 0 built the bridge for exactly this reason, Q1 then proved real
 * firmware emits real `@SESAME` telemetry through it unchanged, and Q2 turned
 * that firmware into a *commandable* `SesameRobot` — so this app ships **three**
 * backends. Anything that wants to drive the scene either implements
 * `SesameRobot` in-process or speaks a wire protocol to something that does.
 *
 * What the interface deliberately does NOT do is pretend they are symmetrical:
 *
 * - `canCommand` is false for the WebSocket backend, and
 *   `commandUnavailableReason` says why in the UI rather than greying a button
 *   out mysteriously. `@SESAME` v1 is device → host only, and the bridge's hub
 *   discards client messages on purpose so the telemetry port cannot become an
 *   accidental control API (R6/R7).
 * - `modelState()` returns `null` where a backend cannot honestly answer.
 *   A stream of wire events knows the last commanded angle and nothing else:
 *   there is no slew model behind it and no `simulatedDeg` to report.
 * - `emulatorFacts()` is how a backend that is **not hardware and not a model**
 *   says so in a form the UI can render. Q2 §5: `provenance` answers *how much
 *   weight does this carry*, `origin` answers *which boundary was crossed*, and
 *   only the second one distinguishes a QEMU servo write from a measurement.
 *   The predicate to branch on is `isPhysicallyObserved()`, never
 *   `provenance === 'observed'`.
 */
import type { JointName, RobotMode, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { Provenance, SesameTelemetry, TelemetryOrigin } from '@sesame-lab/sesame-protocol';
import type { SimulatedRobotState } from '@sesame-lab/sesame-sim';

export type BackendId = 'sim' | 'bridge' | 'qemu';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export interface BackendStatus {
  readonly connection: ConnectionState;
  /** Human-readable, shown verbatim. Carries the failure text when it fails. */
  readonly detail: string;
  /** Events delivered since start, so "connected but silent" is distinguishable. */
  readonly eventsReceived: number;
  /**
   * Attempts the backend has burned getting to where it is.
   *
   * `undefined` for a backend where the question is meaningless. It exists
   * because `QemuSesameRobot.connect()` retries past ISSUE-20260823-022 — 28%
   * of cold boots panic, worst case measured was 7 attempts for one connect —
   * and a 17-second silence that never says "that was four failed boots" is the
   * same under-measurement Q2 §1.1 had to undo. `> 1` must be visible.
   */
  readonly attempts?: number;
  /** Milliseconds spent connecting, so a slow start reads as progress. */
  readonly elapsedMs?: number;
}

/**
 * What a backend that is neither hardware nor a host model has to declare.
 *
 * Shaped after `QemuCapabilities`: `SesameCapabilities` is six booleans and six
 * booleans cannot say "works, but only on the board nobody is told to buy".
 */
export interface EmulatorFacts {
  /** Stamped by whoever owns the transport. Rendered via `describeOrigin()`. */
  readonly origin: TelemetryOrigin;
  /** `hardware-map.json` board profile actually executing. */
  readonly board: string;
  /** Boards this backend cannot emulate, and why. Must be shown, not hidden. */
  readonly unsupportedBoards: Readonly<Record<string, string>>;
  /** Identity of the host → device channel that carries the button press. */
  readonly commandChannel: string;
  /** Subsystems not modelled. Their silence is not evidence of anything. */
  readonly elided: readonly string[];
  /** How the running image differs from stock firmware. */
  readonly firmwareDeviations: readonly string[];
  /** Measured non-determinism, in the backend's own words. */
  readonly knownFlakiness: string;
  /** `false` means the emulator produces face events but no pixels. */
  readonly oledFramebuffer: boolean;
  /** `RobotState.mode` the backend reports. `'qemu'` is a `RobotMode`. */
  readonly mode: RobotMode | null;
  /**
   * Per joint: has this channel actually been reported, or is the angle on
   * screen the documented power-on assumption? `null` where unknown.
   */
  readonly everObserved: Readonly<Record<string, boolean>> | null;
  /** The last line written to the firmware's console, verbatim. */
  readonly lastCommandLine: string | null;
  /** Non-null means the guest died and every number above is a last-known one. */
  readonly panic: string | null;
}

export interface TelemetryBackend {
  readonly id: BackendId;
  readonly label: string;
  /** One sentence: what is actually producing these events. */
  readonly description: string;
  /**
   * What provenance this backend's events carry, if it is fixed. `'per-event'`
   * where the answer depends on the stream — the bridge tags a live UART socket
   * `observed` and a replayed fixture `simulated`, and the app must read the
   * event rather than assume.
   */
  readonly expectedProvenance: Provenance | 'per-event';

  readonly canCommand: boolean;
  readonly commandUnavailableReason: string | null;

  readonly status: BackendStatus;

  start(): Promise<void>;
  stop(): Promise<void>;

  onEvent(listener: (event: SesameTelemetry) => void): () => void;
  onStatus(listener: (status: BackendStatus) => void): () => void;

  command(name: string): Promise<void>;
  setFace(name: string): Promise<void>;
  setJoint(joint: JointName, angleDeg: number): Promise<void>;

  /** Extra model state, or `null` when this backend genuinely cannot know it. */
  modelState(): Promise<SimulatedRobotState | null>;

  /** `null` until the backend has connected and can answer. */
  capabilities(): Promise<SesameCapabilities | null>;

  /**
   * Emulator qualifiers, or `null` for a backend that is not an emulator.
   *
   * Synchronous and polled, because the UI has to be able to render "still
   * booting, attempt 3" without awaiting anything.
   */
  emulatorFacts(): EmulatorFacts | null;
}

/** Thrown when a caller asks a receive-only backend to move something. */
export class BackendReadOnlyError extends Error {
  override readonly name = 'BackendReadOnlyError';
  constructor(readonly backend: BackendId, reason: string) {
    super(`the ${backend} backend cannot send commands: ${reason}`);
  }
}
