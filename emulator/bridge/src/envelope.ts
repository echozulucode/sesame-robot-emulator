/**
 * What actually travels over the WebSocket.
 *
 * The obvious design is "send the `SesameTelemetry` event and nothing else".
 * It does not survive first contact, for one reason: the bridge has to be able
 * to talk about *itself* — "the UART socket dropped", "reconnected after 4
 * attempts", "the replay finished" — and those messages are not observations of
 * the robot. If they arrive in the same undifferentiated stream, a client has no
 * way to tell a fact about the robot from a fact about the plumbing, and the
 * Path-A/Path-B contract test has no way to compare two runs whose plumbing
 * necessarily differs.
 *
 * So every frame is an envelope with an `origin`:
 *
 * - `uart`   — decoded from bytes that crossed the UART boundary. Its `seq` is
 *              the protocol parser's own counter, which depends only on the
 *              concatenated byte stream and not on chunking, so two backends
 *              feeding identical bytes produce identical `uart` frames.
 * - `bridge` — the bridge's own lifecycle. Separate `seq` space, deliberately:
 *              mixing them would make the robot's sequence numbers depend on how
 *              many times a socket happened to reconnect.
 *
 * `n` is the envelope index across both origins, so a client can detect that it
 * missed something even when it only cares about one origin.
 */
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';

/** Bumped only for a breaking change to the envelope itself, not to the payload. */
export const WS_ENVELOPE_VERSION = 1;

export type EnvelopeOrigin = 'uart' | 'bridge';

export interface TelemetryEnvelope {
  readonly v: typeof WS_ENVELOPE_VERSION;
  /** Monotonic across both origins, from 1. Gap detection for clients. */
  readonly n: number;
  readonly origin: EnvelopeOrigin;
  /** Host wall-clock milliseconds. Never confuse this with `event.simTimeUs`. */
  readonly tHostMs: number;
  readonly event: SesameTelemetry;
}

export function isTelemetryEnvelope(value: unknown): value is TelemetryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<TelemetryEnvelope>;
  return (
    e.v === WS_ENVELOPE_VERSION &&
    typeof e.n === 'number' &&
    (e.origin === 'uart' || e.origin === 'bridge') &&
    typeof e.tHostMs === 'number' &&
    typeof e.event === 'object' &&
    e.event !== null
  );
}
