/**
 * `@sesame-lab/sesame-protocol` — the Sesame telemetry contract.
 *
 * Two things live here and nothing else:
 *
 * 1. **`SesameTelemetry`**, the typed event union every backend emits and every
 *    frontend consumes — with `provenance` required on every event, so the
 *    difference between "the emulator observed this", "a model simulated this"
 *    and "we inferred this to explain something" is machine-checked rather than
 *    a UI convention.
 * 2. **The `@SESAME` wire codec**, a line protocol cheap enough for a
 *    `Serial.printf` in an ESP32 hot path, with a streaming parser that survives
 *    arbitrary chunk boundaries, interleaved boot logging, telnet negotiation
 *    bytes, CR-only line endings and runaway lines.
 *
 * This package is deliberately independent of whether Renode ever boots the
 * firmware. It is the seam that lets Phase 1 be written against a host-side
 * simulator and later re-pointed at Renode with no architecture change.
 *
 * Wire format specification: `docs/protocol/sesame-telemetry-v1.md`.
 *
 * ```ts
 * import { SesameTelemetryParser, serializeLine } from '@sesame-lab/sesame-protocol';
 *
 * const parser = new SesameTelemetryParser();
 * parser.push('boot ok\n@SESAME servo R4 72\n');
 * // -> [ { type: 'log', channel: 'uart', text: 'boot ok', ... },
 * //      { type: 'servo.target', joint: 'R4', angleDeg: 72, provenance: 'observed', ... } ]
 * ```
 */

export {
  BARRIER_COMMAND,
  BARRIER_MARKER,
  CLI_ACK_PREFIXES,
  CLI_BRANCHES,
  CLI_BUFFER_BYTES,
  CLI_MOVEMENT_WORDS,
  CLI_TERMINATOR,
  COMMAND_CHANNEL,
  CommandEncodeError,
  MAX_CLI_LINE_BYTES,
  SPEC_VERSION,
  classifyCliLine,
  encodeCommand,
  safeCliToken,
  type CliBranch,
  type CommandEncodeErrorCode,
  type EncodedCommand,
  type SesameCommand,
} from './commands.js';

export {
  ORIGIN_KINDS,
  UNKNOWN_ORIGIN,
  describeOrigin,
  isOriginKind,
  isPhysicallyObserved,
  type OriginKind,
  type TelemetryOrigin,
} from './origin.js';

export {
  isCoreTelemetry,
  isProvenance,
  LOG_CHANNELS,
  PROVENANCE_BY_WIRE_CODE,
  PROVENANCE_WIRE_CODE,
  PROVENANCES,
  TELEMETRY_TYPES,
  type FaceExpressionEvent,
  type LogChannel,
  type LogEvent,
  type OledFrameEvent,
  type Provenance,
  type ProtocolHelloEvent,
  type ProtocolUnknownEvent,
  type SesameCoreTelemetry,
  type SesameTelemetry,
  type ServoTargetEvent,
  type TelemetryEventBase,
  type TelemetryType,
  type TelemetryWarning,
  type TelemetryWarningCode,
  type UnknownReason,
} from './events.js';

export {
  ANGLE_MAX_DEG,
  ANGLE_MIN_DEG,
  canonicalFaceName,
  COMMAND_NAMES,
  COMMAND_VOCABULARY,
  FACE_CATALOG,
  FACE_NAMES,
  isKnownFaceName,
  lookupFace,
  MAX_FACE_FRAMES,
  MOVEMENT_FUNCTIONS,
  type CommandCatalogEntry,
  type FaceCatalogEntry,
  type FacePlaybackMode,
} from './catalog.js';

export {
  base64Decode,
  base64Encode,
  blankOledFrame,
  decodeOledFrame,
  encodeOledFrame,
  isValidOledPayload,
  OLED_BASE64_LENGTH,
  OLED_ENCODINGS,
  OLED_FRAME_BYTES,
  OLED_HEIGHT,
  OLED_PAGES,
  OLED_WIDTH,
  oledBitIndex,
  oledByteIndex,
  oledPixel,
  OledFrameError,
  setOledPixel,
  type OledEncoding,
} from './oled.js';

export {
  ACCEPTED_JOINT_NAMES,
  parseLine,
  parseTelemetryLine,
  PROTOCOL_VERSION,
  resolveParseOptions,
  sanitizeLogText,
  SENTINEL,
  serialize,
  serializeLine,
  TAG_KEYS,
  WIRE_VERBS,
  type LineParseState,
  type ResolvedParseOptions,
  type SerializeOptions,
  type TagPolicy,
  type TelemetryParseOptions,
  type WireVerb,
} from './wire.js';

export {
  parseTelemetryStream,
  SesameTelemetryParser,
  type TelemetryChunk,
} from './parser.js';
