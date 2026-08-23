/**
 * The `SesameTelemetry` event union.
 *
 * This is the contract three backends must satisfy — `RealSesameRobot`,
 * `SimulatedSesameRobot`, `RenodeSesameRobot` — and the reason the Phase-1
 * frontend can be written against a host-side simulator and later re-pointed at
 * Renode with no architecture change.
 *
 * Two things here are not cosmetic:
 *
 * 1. **`provenance` is required on every event.** The research report's "See the
 *    Signal" section demands that the UI distinguish emulator-observed from
 *    simulated from inferred-for-explanation. Making the tag a required field
 *    means teaching fidelity is machine-checked rather than a UI convention
 *    someone forgets. There is deliberately no default at the type level.
 * 2. **`seq` is required and monotonic.** It is the only ordering guarantee a
 *    consumer gets; UART delivery is a byte stream and `simTimeUs` is optional.
 */
import type { JointName } from '@sesame-lab/sesame-model';

/**
 * Where a telemetry event came from, epistemically.
 *
 * | value | meaning | may be presented as fact? |
 * |---|---|---|
 * | `observed`  | Something actually happened on the other side of a real boundary: bytes crossed the emulated UART, the firmware really executed the hook, the physical robot really moved. | yes |
 * | `simulated` | A host-side behaviour model computed what the robot *would* do. No firmware, no silicon. | only when labelled |
 * | `inferred`  | Constructed for explanation. No backend observed it; it was derived from something else because a lesson needs the intermediate step visible (e.g. a `pwm.output` stage synthesised from a servo angle). | only when labelled |
 *
 * A backend must never upgrade its own provenance. A simulator emits
 * `simulated` even when it is confident; a bridge relaying firmware output
 * emits `observed` only for events a firmware hook actually produced.
 */
export type Provenance = 'observed' | 'simulated' | 'inferred';

/** All provenance values, in increasing distance from ground truth. */
export const PROVENANCES = ['observed', 'simulated', 'inferred'] as const;

/** One-character wire codes for {@link Provenance} — the `p=` tag. */
export const PROVENANCE_WIRE_CODE: Readonly<Record<Provenance, 'o' | 's' | 'i'>> = {
  observed: 'o',
  simulated: 's',
  inferred: 'i',
};

/** Reverse of {@link PROVENANCE_WIRE_CODE}. Long spellings are accepted too. */
export const PROVENANCE_BY_WIRE_CODE: Readonly<Record<string, Provenance>> = {
  o: 'observed',
  s: 'simulated',
  i: 'inferred',
  observed: 'observed',
  simulated: 'simulated',
  inferred: 'inferred',
};

/** Narrowing guard for untrusted input. */
export function isProvenance(value: unknown): value is Provenance {
  return typeof value === 'string' && (PROVENANCES as readonly string[]).includes(value);
}

/**
 * Non-fatal problems found while parsing a line.
 *
 * A warning means "we produced an event, but something about it is suspect".
 * Anything that makes a typed event impossible produces a
 * {@link ProtocolUnknownEvent} instead — see {@link UnknownReason}.
 */
export type TelemetryWarningCode =
  /** Angle outside the firmware's `constrain(..., 0, 180)` clamp. */
  | 'angle-out-of-range'
  /** Angle had a fractional part; the firmware only ever emits integers. */
  | 'angle-not-integer'
  /** Face name is not one of the 38 in `hardware/hardware-map.json`. Passthrough: firmware can add faces. */
  | 'unknown-face'
  /** Face name matches a known face only case-insensitively. `setFace()` is case-insensitive, so this still works on the robot. */
  | 'face-name-case-mismatch'
  /** Frame index is >= `MAX_FACE_FRAMES` (6), or >= the known frame count for this face. */
  | 'frame-out-of-range'
  /** Extra positional arguments after the ones v1 defines. Ignored, per the forward-compatibility rule. */
  | 'trailing-args'
  /** A `key=value` tag whose key v1 does not define. Ignored, per the forward-compatibility rule. */
  | 'unknown-tag'
  /** A recognised tag whose value did not parse. Ignored. */
  | 'bad-tag-value'
  /** A `hello` announced a protocol version newer than this implementation. */
  | 'unsupported-version';

/** One non-fatal parse problem. */
export interface TelemetryWarning {
  readonly code: TelemetryWarningCode;
  readonly message: string;
}

/** Fields carried by every event in the union. */
export interface TelemetryEventBase {
  /**
   * Monotonically increasing sequence number, assigned by whoever created the
   * event (normally the parser). Gaps mean loss; reordering never happens
   * within one parser.
   */
  readonly seq: number;

  /** Required. See {@link Provenance} — this is not a UI hint, it is the contract. */
  readonly provenance: Provenance;

  /**
   * Emulator virtual time in microseconds, when the producer has a
   * deterministic clock. Renode does; a physical robot does not.
   */
  readonly simTimeUs?: number;

  /**
   * Causal-trace identifier threading one user action through every layer:
   * `ui.command` -> `http.request` -> `firmware.command` -> `movement.enter` ->
   * `servo.target` -> `pwm.output` -> `joint.target` -> `visual.joint`.
   * Every event produced while servicing trace `wave-0042` carries
   * `traceId: "wave-0042"`, which is what lets "See the Signal" highlight one
   * operation's path through the architecture diagram.
   */
  readonly traceId?: string;

  /** Present and non-empty only when the parser found something suspect. */
  readonly warnings?: readonly TelemetryWarning[];
}

/** A servo channel was commanded to an angle. The single highest-value event. */
export interface ServoTargetEvent extends TelemetryEventBase {
  readonly type: 'servo.target';
  /** Firmware joint identity. Always one of `JOINT_ORDER`. */
  readonly joint: JointName;
  /**
   * Degrees, post-subtrim and post-clamp — i.e. the value the firmware actually
   * handed to `Servo::write()`. Normally an integer in `[0, 180]`; values
   * outside that carry an `angle-out-of-range` warning rather than being
   * silently clamped, because a clamp would hide the bug that produced them.
   */
  readonly angleDeg: number;
}

/** The OLED face changed, named by expression rather than by pixels. */
export interface FaceExpressionEvent extends TelemetryEventBase {
  readonly type: 'face.expression';
  /** Expression name as the firmware spelled it. Not normalised — see `canonicalFaceName()`. */
  readonly name: string;
  /** Animation frame index, 0-based. Absent means "the face, frame unspecified". */
  readonly frame?: number;
}

/** A full 128x64 OLED framebuffer. See `oled.ts` for the exact bit layout. */
export interface OledFrameEvent extends TelemetryEventBase {
  readonly type: 'oled.frame';
  readonly width: 128;
  readonly height: 64;
  /**
   * Base64 of the 1024-byte SSD1306 GDDRAM page-ordered buffer.
   * Decode with `decodeOledFrame()`; index with `oledPixel()`.
   */
  readonly pixels: string;
}

/** Which layer produced a log line. */
export type LogChannel = 'uart' | 'firmware' | 'emulator';

/** All log channels. */
export const LOG_CHANNELS = ['uart', 'firmware', 'emulator'] as const;

/**
 * A line of text.
 *
 * `uart` is the default for anything on the serial stream that is not a
 * `@SESAME` line — ordinary `Serial.println` boot logging. That text is itself
 * a telemetry channel and is never discarded.
 */
export interface LogEvent extends TelemetryEventBase {
  readonly type: 'log';
  readonly channel: LogChannel;
  readonly text: string;
}

/**
 * Extension event: the emitter announced itself and its protocol version.
 *
 * Not in the research report's four-member union. It exists because a wire
 * protocol without a version line cannot be evolved safely, and because the
 * bridge wants to log "firmware speaks v1" as data rather than as prose.
 */
export interface ProtocolHelloEvent extends TelemetryEventBase {
  readonly type: 'protocol.hello';
  readonly protocolVersion: number;
  /** Free-form emitter identity, e.g. `sesame-fw-s2mini/0.1.0`. May be empty. */
  readonly emitter: string;
}

/** Why a `@SESAME` line could not become a typed event. */
export type UnknownReason =
  /** `@SESAME` with nothing after it. */
  | 'missing-verb'
  /** The verb is not one v1 defines. */
  | 'unknown-verb'
  /** Right verb, wrong number of positional arguments. */
  | 'bad-arity'
  /** `servo` angle was not a number. */
  | 'bad-angle'
  /** `servo` angle was out of range and the parser is configured to reject. */
  | 'angle-rejected'
  /** `servo` joint name is not in `JOINT_ORDER`. */
  | 'unknown-joint'
  /** `face` frame index was not a non-negative integer. */
  | 'bad-frame'
  /** `log` channel is not `uart` / `firmware` / `emulator`. */
  | 'bad-channel'
  /** `oled` encoding token is not one v1 defines. */
  | 'bad-encoding'
  /** `oled` payload did not decode to exactly 1024 bytes. */
  | 'bad-payload'
  /** `hello` version was not a non-negative integer. */
  | 'bad-version';

/**
 * Extension event: a `@SESAME` line the parser could not turn into a typed
 * event.
 *
 * The parser never throws on wire input and never silently drops a `@SESAME`
 * line. `raw` holds the line verbatim from the sentinel onward, which is what
 * makes serialize-then-parse a fixed point even for garbage — the bridge can
 * forward it, a replay harness can re-emit it, and a human can read it.
 */
export interface ProtocolUnknownEvent extends TelemetryEventBase {
  readonly type: 'protocol.unknown';
  readonly verb: string;
  /** Positional arguments after the tag run. Empty for `missing-verb`. */
  readonly args: readonly string[];
  readonly reason: UnknownReason;
  /** The line verbatim, starting at `@SESAME`. Re-emitted byte-for-byte by `serialize()`. */
  readonly raw: string;
}

/**
 * Every telemetry event.
 *
 * The first four members are the research report's union verbatim. The last two
 * are extensions this package adds so that versioning and malformed input are
 * representable instead of being exceptions. Consumers that only care about the
 * report's four can filter with {@link isCoreTelemetry}.
 */
export type SesameTelemetry =
  | ServoTargetEvent
  | FaceExpressionEvent
  | OledFrameEvent
  | LogEvent
  | ProtocolHelloEvent
  | ProtocolUnknownEvent;

/** The discriminator values, useful for exhaustiveness tests. */
export const TELEMETRY_TYPES = [
  'servo.target',
  'face.expression',
  'oled.frame',
  'log',
  'protocol.hello',
  'protocol.unknown',
] as const;

/** Union of the `type` discriminators. */
export type TelemetryType = (typeof TELEMETRY_TYPES)[number];

/** The four members the research report specifies. */
export type SesameCoreTelemetry =
  | ServoTargetEvent
  | FaceExpressionEvent
  | OledFrameEvent
  | LogEvent;

/** True for the report's four event kinds; false for the two protocol extensions. */
export function isCoreTelemetry(event: SesameTelemetry): event is SesameCoreTelemetry {
  return event.type !== 'protocol.hello' && event.type !== 'protocol.unknown';
}
