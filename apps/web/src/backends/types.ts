/**
 * The backend seam.
 *
 * The research report's architectural claim is that lesson code, the inspector
 * and the 3D scene talk to *one* thing and the backend underneath is a swap.
 * Phase 0 built the bridge for exactly this reason, Q1 then proved real
 * firmware emits real `@SESAME` telemetry through it unchanged — so this app
 * ships **two** backends and no third. Anything that wants to drive the scene
 * either implements `SesameRobot` in-process or speaks the wire protocol.
 *
 * What the interface deliberately does NOT do is pretend the two are
 * symmetrical:
 *
 * - `canCommand` is false for the WebSocket backend, and
 *   `commandUnavailableReason` says why in the UI rather than greying a button
 *   out mysteriously. `@SESAME` v1 is device → host only, and the bridge's hub
 *   discards client messages on purpose so the telemetry port cannot become an
 *   accidental control API (R6/R7).
 * - `modelState()` returns `null` where a backend cannot honestly answer.
 *   A stream of wire events knows the last commanded angle and nothing else:
 *   there is no slew model behind it and no `simulatedDeg` to report.
 */
import type { JointName, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { Provenance, SesameTelemetry } from '@sesame-lab/sesame-protocol';
import type { SimulatedRobotState } from '@sesame-lab/sesame-sim';

export type BackendId = 'sim' | 'bridge';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export interface BackendStatus {
  readonly connection: ConnectionState;
  /** Human-readable, shown verbatim. Carries the failure text when it fails. */
  readonly detail: string;
  /** Events delivered since start, so "connected but silent" is distinguishable. */
  readonly eventsReceived: number;
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
}

/** Thrown when a caller asks a receive-only backend to move something. */
export class BackendReadOnlyError extends Error {
  override readonly name = 'BackendReadOnlyError';
  constructor(readonly backend: BackendId, reason: string) {
    super(`the ${backend} backend cannot send commands: ${reason}`);
  }
}
