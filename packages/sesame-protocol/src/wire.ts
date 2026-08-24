/**
 * The `@SESAME` UART line protocol — grammar, line parser, and serializer.
 *
 * Full specification: `docs/protocol/sesame-telemetry-v1.md`.
 *
 * ```text
 * line    = *ANY sentinel-segment *( sentinel-segment )
 * segment = "@SESAME" SP verb *( SP tag ) *( SP arg )
 * tag     = key "=" value          ; key = ALPHA *( ALNUM / "_" )
 * ```
 *
 * The one structural decision worth defending: **tags come before positional
 * arguments, not after.** That is what makes `log`'s trailing free-text field
 * unambiguous — the parser stops consuming tags at the first token that is not
 * `key=value`, and for `log` that token is always the channel, so nothing in
 * the message body can ever be mistaken for a tag.
 *
 * The common case costs the firmware nothing:
 *
 * ```c
 * Serial.printf("@SESAME servo %s %d\n", ServoNames[channel], angle);
 * ```
 */
import { isJointName, JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

import {
  ANGLE_MAX_DEG,
  ANGLE_MIN_DEG,
  FACE_CATALOG,
  FACE_NAMES,
  MAX_FACE_FRAMES,
} from './catalog.js';
import {
  LOG_CHANNELS,
  PROVENANCE_BY_WIRE_CODE,
  PROVENANCE_WIRE_CODE,
  type LogChannel,
  type Provenance,
  type SesameTelemetry,
  type TelemetryWarning,
  type TelemetryWarningCode,
  type UnknownReason,
} from './events.js';
import { OLED_ENCODINGS, OLED_HEIGHT, OLED_WIDTH, isValidOledPayload } from './oled.js';
import type { TelemetryOrigin } from './origin.js';

/** The line prefix that marks a telemetry line. Chosen to be improbable in log text. */
export const SENTINEL = '@SESAME';

/** Wire protocol version announced by `@SESAME hello`. */
export const PROTOCOL_VERSION = 1;

/** The verbs v1 defines. */
export const WIRE_VERBS = ['hello', 'servo', 'face', 'oled', 'log'] as const;

/** A verb this implementation understands. */
export type WireVerb = (typeof WIRE_VERBS)[number];

/**
 * Tag keys v1 defines.
 *
 * | key | meaning |
 * |---|---|
 * | `s` | sequence number, unsigned integer. Overrides the parser's counter. |
 * | `t` | `simTimeUs`, unsigned integer microseconds of emulator virtual time. |
 * | `p` | provenance: `o` / `s` / `i` (long spellings also accepted). |
 * | `x` | `traceId`, any token without whitespace. |
 */
export const TAG_KEYS = ['s', 't', 'p', 'x'] as const;

const TAG_RE = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/;
const UINT_RE = /^\d+$/;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** Knobs for {@link parseTelemetryLine} and the streaming parser. */
export interface TelemetryParseOptions {
  /**
   * Hard cap on a single line, in bytes, before the parser gives up on it and
   * emits an `emulator` log instead. A runaway emitter must not be able to OOM
   * the bridge. Default 65536 — comfortably above the 1381-byte `oled` line.
   */
  readonly maxLineBytes?: number;

  /**
   * Provenance for events that carry no `p=` tag.
   *
   * `observed` for a real UART or a Renode socket. A replay harness or a
   * host-side behaviour model **must** set `simulated`, or the UI will present
   * synthesised data as ground truth.
   */
  readonly defaultProvenance?: Provenance;

  /**
   * Origin stamped onto every event this parser produces.
   *
   * The v2 counterpart of {@link TelemetryParseOptions.defaultProvenance}, and
   * a deployment decision in exactly the same way: a QEMU bridge must set
   * `{ kind: 'emulator', board: 'distro-v1-esp32', ... }` or its events are
   * indistinguishable from hardware measurements. There is no wire tag for it
   * and no way for the emitter to override it. Default: absent.
   */
  readonly defaultOrigin?: TelemetryOrigin;

  /** First `seq` this parser hands out. Default 0. */
  readonly startSeq?: number;

  /**
   * Face names to validate against, or `null` to disable the check.
   * Default: the 38 in `hardware/hardware-map.json`. An unrecognised name is a
   * warning with passthrough, never an error — firmware can add faces.
   */
  readonly knownFaceNames?: readonly string[] | null;

  /** Low end of the accepted servo angle range. Default 0, from the firmware clamp. */
  readonly angleMinDeg?: number;

  /** High end of the accepted servo angle range. Default 180. */
  readonly angleMaxDeg?: number;

  /**
   * If true, an out-of-range angle becomes a `protocol.unknown` instead of a
   * warned `servo.target`. Default false: a warned event is more useful than a
   * dropped one, and hiding the bad value would hide the bug.
   */
  readonly rejectOutOfRangeAngle?: boolean;

  /**
   * Turn non-`@SESAME` stream text into `log` events. Default true — that boot
   * logging is a telemetry channel, not noise.
   */
  readonly emitPlainTextAsLog?: boolean;

  /** Channel for plain stream text. Default `uart`. */
  readonly plainTextChannel?: LogChannel;
}

interface FaceIndexEntry {
  readonly name: string;
  readonly frameCount: number | null;
}

/** Fully defaulted options, plus the derived lookup tables. */
export interface ResolvedParseOptions {
  readonly maxLineBytes: number;
  readonly defaultProvenance: Provenance;
  readonly defaultOrigin: TelemetryOrigin | undefined;
  readonly startSeq: number;
  readonly faceIndex: ReadonlyMap<string, FaceIndexEntry> | null;
  readonly faceNameSet: ReadonlySet<string> | null;
  readonly angleMinDeg: number;
  readonly angleMaxDeg: number;
  readonly rejectOutOfRangeAngle: boolean;
  readonly emitPlainTextAsLog: boolean;
  readonly plainTextChannel: LogChannel;
}

const DEFAULT_FACE_INDEX: ReadonlyMap<string, FaceIndexEntry> = new Map(
  FACE_CATALOG.map((f) => [f.name.toLowerCase(), { name: f.name, frameCount: f.frameCount }]),
);
const DEFAULT_FACE_NAME_SET: ReadonlySet<string> = new Set(FACE_NAMES);

/** Apply defaults and precompute lookup tables. */
export function resolveParseOptions(options: TelemetryParseOptions = {}): ResolvedParseOptions {
  const known = options.knownFaceNames;
  let faceIndex: ReadonlyMap<string, FaceIndexEntry> | null;
  let faceNameSet: ReadonlySet<string> | null;
  if (known === null) {
    faceIndex = null;
    faceNameSet = null;
  } else if (known === undefined) {
    faceIndex = DEFAULT_FACE_INDEX;
    faceNameSet = DEFAULT_FACE_NAME_SET;
  } else {
    faceIndex = new Map(known.map((n) => [n.toLowerCase(), { name: n, frameCount: null }]));
    faceNameSet = new Set(known);
  }
  return {
    maxLineBytes: options.maxLineBytes ?? 65536,
    defaultProvenance: options.defaultProvenance ?? 'observed',
    defaultOrigin: options.defaultOrigin,
    startSeq: options.startSeq ?? 0,
    faceIndex,
    faceNameSet,
    angleMinDeg: options.angleMinDeg ?? ANGLE_MIN_DEG,
    angleMaxDeg: options.angleMaxDeg ?? ANGLE_MAX_DEG,
    rejectOutOfRangeAngle: options.rejectOutOfRangeAngle ?? false,
    emitPlainTextAsLog: options.emitPlainTextAsLog ?? true,
    plainTextChannel: options.plainTextChannel ?? 'uart',
  };
}

/** Mutable sequence counter, threaded through line parses. */
export interface LineParseState {
  nextSeq: number;
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

interface Token {
  readonly value: string;
  readonly start: number;
}

function tokenize(line: string, from: number): Token[] {
  const tokens: Token[] = [];
  let i = from;
  const n = line.length;
  while (i < n) {
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(line.charCodeAt(i))) i++;
    tokens.push({ value: line.slice(start, i), start });
  }
  return tokens;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

interface Tags {
  seq?: number;
  simTimeUs?: number;
  provenance?: Provenance;
  traceId?: string;
}

interface Common {
  readonly seq: number;
  readonly provenance: Provenance;
  readonly origin?: TelemetryOrigin;
  readonly simTimeUs?: number;
  readonly traceId?: string;
  readonly warnings?: readonly TelemetryWarning[];
}

function warn(code: TelemetryWarningCode, message: string): TelemetryWarning {
  return { code, message };
}

function common(
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): Common {
  let seq: number;
  if (tags.seq === undefined) {
    seq = state.nextSeq++;
  } else {
    seq = tags.seq;
    if (seq >= state.nextSeq) state.nextSeq = seq + 1;
  }
  return {
    seq,
    provenance: tags.provenance ?? options.defaultProvenance,
    ...(options.defaultOrigin === undefined ? {} : { origin: options.defaultOrigin }),
    ...(tags.simTimeUs === undefined ? {} : { simTimeUs: tags.simTimeUs }),
    ...(tags.traceId === undefined ? {} : { traceId: tags.traceId }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * Find every `@SESAME` in a line that is followed by whitespace or end-of-line.
 *
 * Deliberately not anchored to the start of the line, and deliberately not
 * requiring whitespace *before* the sentinel. Two independent `Serial.printf`
 * calls with no newline between them produce `...R1 90@SESAME face wave 0`, and
 * losing half of that to a stricter rule would be worse than the false-positive
 * risk of a log line that happens to contain the sentinel.
 */
function findSentinels(line: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const idx = line.indexOf(SENTINEL, from);
    if (idx < 0) break;
    const after = idx + SENTINEL.length;
    const next = line.charCodeAt(after);
    if (Number.isNaN(next) || isSpace(next)) found.push(idx);
    from = after;
  }
  return found;
}

/**
 * Parse one already-de-framed line into zero or more events.
 *
 * A line yields more than one event when non-protocol text precedes a sentinel,
 * or when two `@SESAME` segments were concatenated by a missing newline.
 */
export function parseLine(
  line: string,
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry[] {
  const events: SesameTelemetry[] = [];
  const sentinels = findSentinels(line);

  if (sentinels.length === 0) {
    pushPlainText(events, line, options, state);
    return events;
  }

  const first = sentinels[0] as number;
  if (first > 0) pushPlainText(events, line.slice(0, first), options, state);

  for (let k = 0; k < sentinels.length; k++) {
    const start = sentinels[k] as number;
    const end = k + 1 < sentinels.length ? (sentinels[k + 1] as number) : line.length;
    events.push(parseSegment(line.slice(start, end).replace(/[ \t]+$/, ''), options, state));
  }
  return events;
}

/**
 * Convenience wrapper: parse a single complete line with fresh state.
 * The streaming {@link parseLine} path is what production code should use.
 */
export function parseTelemetryLine(
  line: string,
  options?: TelemetryParseOptions,
): SesameTelemetry[] {
  const resolved = resolveParseOptions(options);
  return parseLine(line, resolved, { nextSeq: resolved.startSeq });
}

function pushPlainText(
  events: SesameTelemetry[],
  text: string,
  options: ResolvedParseOptions,
  state: LineParseState,
): void {
  if (!options.emitPlainTextAsLog) return;
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  events.push({
    type: 'log',
    seq: state.nextSeq++,
    provenance: options.defaultProvenance,
    // Plain boot logging comes off the same wire as the telemetry and must
    // carry the same origin. This path does not go through `common()`, which
    // is exactly how it ended up as the one event kind with no origin at all —
    // caught by `lifecycle.test.ts` asserting that EVERY event has one, rather
    // than sampling the interesting kinds.
    ...(options.defaultOrigin === undefined ? {} : { origin: options.defaultOrigin }),
    channel: options.plainTextChannel,
    text: trimmed,
  });
}

function parseSegment(
  raw: string,
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  const tokens = tokenize(raw, SENTINEL.length);
  const warnings: TelemetryWarning[] = [];
  const tags: Tags = {};

  if (tokens.length === 0) {
    return unknown(raw, '', [], 'missing-verb', common(tags, warnings, options, state));
  }

  const verb = (tokens[0] as Token).value;

  let i = 1;
  for (; i < tokens.length; i++) {
    const match = TAG_RE.exec((tokens[i] as Token).value);
    if (match === null) break;
    applyTag(match[1] as string, match[2] as string, tags, warnings);
  }

  const argTokens = tokens.slice(i);
  const args = argTokens.map((t) => t.value);

  switch (verb) {
    case 'servo':
      return parseServo(raw, args, tags, warnings, options, state);
    case 'face':
      return parseFace(raw, args, tags, warnings, options, state);
    case 'oled':
      return parseOled(raw, args, tags, warnings, options, state);
    case 'log':
      return parseLog(raw, argTokens, tags, warnings, options, state);
    case 'hello':
      return parseHello(raw, args, tags, warnings, options, state);
    default:
      return unknown(raw, verb, args, 'unknown-verb', common(tags, warnings, options, state));
  }
}

function applyTag(key: string, value: string, tags: Tags, warnings: TelemetryWarning[]): void {
  switch (key) {
    case 's': {
      if (!UINT_RE.test(value)) {
        warnings.push(warn('bad-tag-value', `s= expects an unsigned integer, got ${JSON.stringify(value)}`));
        return;
      }
      tags.seq = Number(value);
      return;
    }
    case 't': {
      if (!UINT_RE.test(value)) {
        warnings.push(warn('bad-tag-value', `t= expects an unsigned integer, got ${JSON.stringify(value)}`));
        return;
      }
      tags.simTimeUs = Number(value);
      return;
    }
    case 'p': {
      const provenance = PROVENANCE_BY_WIRE_CODE[value];
      if (provenance === undefined) {
        warnings.push(warn('bad-tag-value', `p= expects o|s|i, got ${JSON.stringify(value)}`));
        return;
      }
      tags.provenance = provenance;
      return;
    }
    case 'x': {
      if (value.length === 0) {
        warnings.push(warn('bad-tag-value', 'x= expects a non-empty trace id'));
        return;
      }
      tags.traceId = value;
      return;
    }
    default:
      warnings.push(warn('unknown-tag', `ignoring unknown tag ${JSON.stringify(key)}`));
  }
}

function unknown(
  raw: string,
  verb: string,
  args: readonly string[],
  reason: UnknownReason,
  base: Common,
): SesameTelemetry {
  return { type: 'protocol.unknown', ...base, verb, args: [...args], reason, raw };
}

function checkTrailing(args: readonly string[], max: number, warnings: TelemetryWarning[]): void {
  if (args.length > max) {
    warnings.push(
      warn('trailing-args', `ignoring ${args.length - max} unexpected trailing argument(s)`),
    );
  }
}

function parseServo(
  raw: string,
  args: readonly string[],
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  if (args.length < 2) {
    return unknown(raw, 'servo', args, 'bad-arity', common(tags, warnings, options, state));
  }
  const jointText = args[0] as string;
  const angleText = args[1] as string;

  if (!isJointName(jointText)) {
    return unknown(
      raw,
      'servo',
      args,
      'unknown-joint',
      common(tags, warnings, options, state),
    );
  }
  const joint: JointName = jointText;

  if (!NUMBER_RE.test(angleText)) {
    return unknown(raw, 'servo', args, 'bad-angle', common(tags, warnings, options, state));
  }
  const angleDeg = Number(angleText);

  const outOfRange = angleDeg < options.angleMinDeg || angleDeg > options.angleMaxDeg;
  if (outOfRange && options.rejectOutOfRangeAngle) {
    return unknown(raw, 'servo', args, 'angle-rejected', common(tags, warnings, options, state));
  }
  if (outOfRange) {
    warnings.push(
      warn(
        'angle-out-of-range',
        `${angleDeg} is outside the firmware clamp [${options.angleMinDeg}, ${options.angleMaxDeg}]`,
      ),
    );
  }
  if (!Number.isInteger(angleDeg)) {
    warnings.push(warn('angle-not-integer', `${angleDeg} is not an integer degree value`));
  }
  checkTrailing(args, 2, warnings);

  return { type: 'servo.target', ...common(tags, warnings, options, state), joint, angleDeg };
}

function parseFace(
  raw: string,
  args: readonly string[],
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  if (args.length < 1) {
    return unknown(raw, 'face', args, 'bad-arity', common(tags, warnings, options, state));
  }
  const name = args[0] as string;

  let frame: number | undefined;
  if (args.length >= 2) {
    const frameText = args[1] as string;
    if (!UINT_RE.test(frameText)) {
      return unknown(raw, 'face', args, 'bad-frame', common(tags, warnings, options, state));
    }
    frame = Number(frameText);
  }

  const entry = options.faceIndex?.get(name.toLowerCase());
  if (options.faceNameSet !== null) {
    if (entry === undefined) {
      warnings.push(
        warn('unknown-face', `${JSON.stringify(name)} is not a known face; passing it through`),
      );
    } else if (!options.faceNameSet.has(name)) {
      warnings.push(
        warn(
          'face-name-case-mismatch',
          `${JSON.stringify(name)} matches ${JSON.stringify(entry.name)} only case-insensitively`,
        ),
      );
    }
  }

  if (frame !== undefined) {
    if (frame >= MAX_FACE_FRAMES) {
      warnings.push(
        warn('frame-out-of-range', `frame ${frame} is >= MAX_FACE_FRAMES (${MAX_FACE_FRAMES})`),
      );
    } else if (entry !== undefined && entry.frameCount !== null && entry.frameCount > 0 && frame >= entry.frameCount) {
      warnings.push(
        warn(
          'frame-out-of-range',
          `frame ${frame} is >= the ${entry.frameCount} frame(s) defined for ${JSON.stringify(entry.name)}`,
        ),
      );
    }
  }

  checkTrailing(args, 2, warnings);

  return {
    type: 'face.expression',
    ...common(tags, warnings, options, state),
    name,
    ...(frame === undefined ? {} : { frame }),
  };
}

function parseOled(
  raw: string,
  args: readonly string[],
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  if (args.length < 2) {
    return unknown(raw, 'oled', args, 'bad-arity', common(tags, warnings, options, state));
  }
  const encoding = args[0] as string;
  const payload = args[1] as string;

  if (!(OLED_ENCODINGS as readonly string[]).includes(encoding)) {
    return unknown(raw, 'oled', args, 'bad-encoding', common(tags, warnings, options, state));
  }
  if (!isValidOledPayload(payload)) {
    return unknown(raw, 'oled', args, 'bad-payload', common(tags, warnings, options, state));
  }
  checkTrailing(args, 2, warnings);

  return {
    type: 'oled.frame',
    ...common(tags, warnings, options, state),
    width: OLED_WIDTH,
    height: OLED_HEIGHT,
    pixels: payload,
  };
}

function parseLog(
  raw: string,
  argTokens: readonly Token[],
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  const args = argTokens.map((t) => t.value);
  if (argTokens.length < 1) {
    return unknown(raw, 'log', args, 'bad-arity', common(tags, warnings, options, state));
  }
  const channel = (argTokens[0] as Token).value;
  if (!(LOG_CHANNELS as readonly string[]).includes(channel)) {
    return unknown(raw, 'log', args, 'bad-channel', common(tags, warnings, options, state));
  }
  const textToken = argTokens[1];
  const text = textToken === undefined ? '' : raw.slice(textToken.start);

  return {
    type: 'log',
    ...common(tags, warnings, options, state),
    channel: channel as LogChannel,
    text,
  };
}

function parseHello(
  raw: string,
  args: readonly string[],
  tags: Tags,
  warnings: TelemetryWarning[],
  options: ResolvedParseOptions,
  state: LineParseState,
): SesameTelemetry {
  if (args.length < 1) {
    return unknown(raw, 'hello', args, 'bad-arity', common(tags, warnings, options, state));
  }
  const versionText = args[0] as string;
  if (!UINT_RE.test(versionText)) {
    return unknown(raw, 'hello', args, 'bad-version', common(tags, warnings, options, state));
  }
  const protocolVersion = Number(versionText);
  if (protocolVersion > PROTOCOL_VERSION) {
    warnings.push(
      warn(
        'unsupported-version',
        `emitter announced protocol v${protocolVersion}; this implementation is v${PROTOCOL_VERSION}`,
      ),
    );
  }
  checkTrailing(args, 2, warnings);

  return {
    type: 'protocol.hello',
    ...common(tags, warnings, options, state),
    protocolVersion,
    emitter: args[1] ?? '',
  };
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

/** Which metadata tags {@link serialize} emits. */
export type TagPolicy =
  /** `t=` when present, `p=` when not `observed`, `x=` when present. Never `s=`. Firmware-shaped. */
  | 'auto'
  /** Everything present, plus `s=` and `p=` unconditionally. Makes serialize-then-parse exact. */
  | 'all'
  /** No tags at all. */
  | 'none';

/** Options for {@link serialize}. */
export interface SerializeOptions {
  /** Default `auto`. */
  readonly tags?: TagPolicy;
}

/**
 * Render an event as one wire line, **without** a terminator.
 *
 * `protocol.unknown` is re-emitted from its `raw` field verbatim, which is what
 * lets a bridge forward a line it did not understand without corrupting it.
 *
 * Log text is sanitised: control characters become spaces and the result is
 * trimmed, so the output is always exactly one line. A log text containing the
 * `@SESAME` sentinel followed by whitespace will be re-split on parse — emitters
 * must not embed the sentinel in message bodies.
 */
export function serialize(event: SesameTelemetry, options: SerializeOptions = {}): string {
  if (event.type === 'protocol.unknown') return event.raw;

  const policy = options.tags ?? 'auto';
  const parts: string[] = [SENTINEL, verbFor(event.type)];

  if (policy !== 'none') {
    if (policy === 'all') parts.push(`s=${event.seq}`);
    if (event.simTimeUs !== undefined) parts.push(`t=${event.simTimeUs}`);
    if (policy === 'all' || event.provenance !== 'observed') {
      parts.push(`p=${PROVENANCE_WIRE_CODE[event.provenance]}`);
    }
    if (event.traceId !== undefined) parts.push(`x=${event.traceId}`);
  }

  switch (event.type) {
    case 'servo.target':
      parts.push(event.joint, String(event.angleDeg));
      break;
    case 'face.expression':
      parts.push(event.name);
      if (event.frame !== undefined) parts.push(String(event.frame));
      break;
    case 'oled.frame':
      parts.push('b64', event.pixels);
      break;
    case 'log': {
      parts.push(event.channel);
      const text = sanitizeLogText(event.text);
      if (text.length > 0) parts.push(text);
      break;
    }
    case 'protocol.hello':
      parts.push(String(event.protocolVersion));
      if (event.emitter.length > 0) parts.push(event.emitter);
      break;
  }

  return parts.join(' ');
}

/** {@link serialize} plus the `\n` terminator this protocol uses. */
export function serializeLine(event: SesameTelemetry, options?: SerializeOptions): string {
  return `${serialize(event, options)}\n`;
}

function verbFor(type: Exclude<SesameTelemetry['type'], 'protocol.unknown'>): WireVerb {
  switch (type) {
    case 'servo.target':
      return 'servo';
    case 'face.expression':
      return 'face';
    case 'oled.frame':
      return 'oled';
    case 'log':
      return 'log';
    case 'protocol.hello':
      return 'hello';
  }
}

/** Replace control characters with spaces and trim, so the text is one safe line. */
export function sanitizeLogText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.trim();
}

/** The joint names this codec accepts, straight from `sesame-model`. */
export const ACCEPTED_JOINT_NAMES: readonly JointName[] = JOINT_ORDER;
