/**
 * **Protocol v2, host → device.** The other half of the wire.
 *
 * v1 was explicit that it defined no host → device direction
 * (`docs/protocol/sesame-telemetry-v1.md` §2, §13 limitation 5): commands were
 * to go over HTTP or the Renode monitor. Under QEMU neither exists — HTTP needs
 * a radio QEMU does not model — so v2 defines the direction, and defines it
 * over the same UART0 the telemetry leaves by.
 *
 * ## The one design decision that matters
 *
 * **v2 does not invent a wire format. The device end already exists.**
 *
 * Stock Sesame firmware has a serial console at the bottom of `loop()`
 * (`firmware/sesame-firmware-main.ino:785`–`:875`, 26 command forms extracted
 * into `hardware/hardware-map.json → commands.serialCli`). It is upstream code,
 * it is unmodified, and it is already listening on the port the telemetry
 * leaves by. Designing a second, prettier command protocol would have meant
 * patching the firmware to speak it — which would have made the "we run the
 * real firmware" claim weaker in exactly the way an emulator backend exists to
 * make it stronger.
 *
 * So the host → device wire format of v2 **is** the upstream serial CLI, and
 * this module's job is not to define it but to *encode into it safely*:
 *
 * - to the byte, so a 32-byte `command_buffer` never overflows;
 * - through the CLI's prefix-order-sensitive dispatcher, so `st save` reaches
 *   the branch a reader expects rather than the one two lines further down;
 * - with names sanitised, so nothing that came from a browser can forge an
 *   `@SESAME` segment on the way back.
 *
 * ## What did *not* change
 *
 * The device → host direction is byte-identical to v1. The firmware still
 * announces `@SESAME hello 1`, and that is still correct: `hello` announces the
 * **telemetry wire version**, which v2 does not touch. See {@link SPEC_VERSION}
 * versus `PROTOCOL_VERSION`.
 *
 * Specification: `docs/protocol/sesame-telemetry-v2.md`.
 */
import { JOINT_ORDER, jointIndex, type JointName } from '@sesame-lab/sesame-model';

import { ANGLE_MAX_DEG, ANGLE_MIN_DEG } from './catalog.js';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * The specification revision this package implements —
 * `docs/protocol/sesame-telemetry-v2.md`.
 *
 * Deliberately **not** the same number as `PROTOCOL_VERSION`. That one is the
 * `@SESAME hello <n>` telemetry wire version, it is still `1`, and bumping it
 * would have made every conforming v1 emitter — including the firmware patch in
 * `firmware/patches/telemetry-instrumentation.patch`, which this project does
 * not get to rewrite — announce a version it does not speak.
 */
export const SPEC_VERSION = 2;

/**
 * Identity of the host → device channel, for `capabilities()` and logs.
 *
 * `upstream-1.0` because the grammar belongs to upstream Sesame firmware, not
 * to this project: it is whatever `loop()`'s `strcmp` chain accepts.
 */
export const COMMAND_CHANNEL = 'serial-cli/upstream-1.0';

// ---------------------------------------------------------------------------
// The firmware's buffer
// ---------------------------------------------------------------------------

/** `static char command_buffer[32]` — `sesame-firmware-main.ino:787`. */
export const CLI_BUFFER_BYTES = 32;

/**
 * Longest line the firmware can receive.
 *
 * `else if (buffer_pos < sizeof(command_buffer) - 1) command_buffer[buffer_pos++] = c;`
 * (`:874`) — the 32nd byte is reserved for the NUL written at `:790`, and any
 * byte beyond that is **dropped silently**, so an over-long line does not
 * error, it arrives truncated and may dispatch to something else entirely.
 * That is why encoding refuses rather than truncating.
 */
export const MAX_CLI_LINE_BYTES = CLI_BUFFER_BYTES - 1;

/**
 * Line terminator to send.
 *
 * `if (c == '\n' || c == '\r')` (`:789`) accepts either, but sending CRLF would
 * submit the buffer on the CR and then submit an **empty** buffer on the LF.
 * The empty one is harmless — `if (buffer_pos > 0)` guards it — but LF alone is
 * one byte and no ambiguity.
 */
export const CLI_TERMINATOR = '\n';

// ---------------------------------------------------------------------------
// The dispatcher, as a value
// ---------------------------------------------------------------------------

/**
 * Every branch of the serial CLI's `if / else if` chain, in **source order**.
 *
 * Source order is the whole point. `hardware-map.json →
 * commands.serialCliDispatchNote` records that the matching is
 * prefix-order-sensitive: `strcmp("subtrim save")` at `:833` is tested *after*
 * the exact `strcmp("subtrim")` at `:825` but *before* `strncmp("subtrim ", 8)`
 * at `:846`, and `strncmp(command_buffer, "st ", 3)` at `:846` would also match
 * `"st save"` and `"st reset"` if those were not caught earlier.
 *
 * Encoding a command is therefore not "write the obvious string": it is "write
 * a string that lands on the branch you meant". {@link classifyCliLine} makes
 * that checkable instead of assumed.
 */
export const CLI_BRANCHES = [
  'run-walk',
  'rn-wb',
  'rn-tl',
  'rn-tr',
  'run-rest',
  'run-stand',
  'rn-wv',
  'rn-dn',
  'rn-sw',
  'rn-pt',
  'rn-pu',
  'rn-bw',
  'rn-ct',
  'rn-fk',
  'rn-wm',
  'rn-sk',
  'rn-sg',
  'rn-dd',
  'rn-cb',
  'face',
  'subtrim-show',
  'subtrim-save',
  'subtrim-reset',
  'subtrim-set',
  'all',
  'motor',
  /** Fell off the end of the chain. The firmware prints nothing and does nothing. */
  'none',
] as const;

/** Which branch of the CLI chain a line reaches. */
export type CliBranch = (typeof CLI_BRANCHES)[number];

/** Exact-match branches, in the order the firmware tests them. */
const EXACT_BRANCHES: readonly (readonly [CliBranch, readonly string[]])[] = Object.freeze([
  ['run-walk', ['run walk', 'rn wf']],
  ['rn-wb', ['rn wb']],
  ['rn-tl', ['rn tl']],
  ['rn-tr', ['rn tr']],
  ['run-rest', ['run rest', 'rn rs']],
  ['run-stand', ['run stand', 'rn st']],
  ['rn-wv', ['rn wv']],
  ['rn-dn', ['rn dn']],
  ['rn-sw', ['rn sw']],
  ['rn-pt', ['rn pt']],
  ['rn-pu', ['rn pu']],
  ['rn-bw', ['rn bw']],
  ['rn-ct', ['rn ct']],
  ['rn-fk', ['rn fk']],
  ['rn-wm', ['rn wm']],
  ['rn-sk', ['rn sk']],
  ['rn-sg', ['rn sg']],
  ['rn-dd', ['rn dd']],
  ['rn-cb', ['rn cb']],
]);

/** `sscanf(buf, "%d %d", &a, &b) == 2` — leading spaces allowed, as C does. */
function scanTwoInts(input: string): [number, number] | null {
  const match = /^[ \t]*([+-]?\d+)[ \t\n\r\f\v]+([+-]?\d+)/.exec(input);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

/** `sscanf(buf, "%d", &a) == 1`. */
function scanOneInt(input: string): number | null {
  const match = /^[ \t]*([+-]?\d+)/.exec(input);
  return match === null ? null : Number(match[1]);
}

/**
 * Run the firmware's dispatch chain over a candidate line, in source order.
 *
 * A faithful transcription of `sesame-firmware-main.ino:791`–`:872`, including
 * the two places the firmware disambiguates an abbreviation by peeking at
 * `command_buffer[1]` (`:819` for `fc`/`face`, `:847` for `st`/`subtrim`).
 *
 * This exists so that "does this encoding survive the dispatcher?" is a unit
 * test rather than a code review. It is a *model* of the firmware, so it is
 * only as good as the transcription — `commands-dispatch.test.ts` pins it
 * against every one of the 26 forms in `hardware/hardware-map.json`.
 *
 * @param line the buffer contents, **without** a terminator.
 */
export function classifyCliLine(line: string): CliBranch {
  // The firmware never sees the terminator: it is consumed by the `c == '\n'`
  // test, and anything past byte 31 was dropped as it arrived.
  const buffer = line.slice(0, MAX_CLI_LINE_BYTES);
  if (buffer.length === 0) return 'none'; // `if (buffer_pos > 0)` — :790

  for (const [branch, forms] of EXACT_BRANCHES) {
    if (forms.includes(buffer)) return branch;
  }

  // :818 — strncmp("face ", 5) || strncmp("fc ", 3). Note this is tested BEFORE
  // every subtrim branch, so `fc save` is a face named "save", not a subtrim
  // save. The name may still be empty ("face " with nothing after it), in which
  // case the firmware prints a usage line and does nothing — still this branch.
  if (buffer.startsWith('face ') || buffer.startsWith('fc ')) return 'face';

  // :825 — exact.
  if (buffer === 'subtrim' || buffer === 'st') return 'subtrim-show';
  // :833 — exact, and deliberately after :825 and before :846.
  if (buffer === 'subtrim save' || buffer === 'st save') return 'subtrim-save';
  // :842 — prefix, so "st resetXYZ" also lands here.
  if (buffer.startsWith('subtrim reset') || buffer.startsWith('st reset')) return 'subtrim-reset';
  // :846 — prefix. Reaching here means the three branches above did not match.
  // Note there is no fallthrough out of this branch: if the inner
  // `sscanf(params, "%d %d") == 2` fails the firmware simply does nothing, so
  // `st x` is a no-op rather than a motor command. That distinction is why the
  // classifier returns the branch and not "what happened".
  if (buffer.startsWith('subtrim ') || buffer.startsWith('st ')) return 'subtrim-set';
  // :864 — prefix.
  if (buffer.startsWith('all ')) return scanOneInt(buffer.slice(4)) === null ? 'none' : 'all';
  // :870 — the fallthrough, and the only branch with no keyword at all.
  if (scanTwoInts(buffer) !== null) return 'motor';
  return 'none';
}

// ---------------------------------------------------------------------------
// The typed command union
// ---------------------------------------------------------------------------

/**
 * One host → device instruction.
 *
 * Modelled on what the CLI can *do*, not on what it looks like. The encoding is
 * this module's problem; a caller should never be assembling `"rn wv"` by hand,
 * because getting it subtly wrong (`"st"` instead of `"rn st"`) silently prints
 * subtrim values instead of standing the robot up.
 */
export type SesameCommand =
  /** Run one of the firmware's 19 movement words. */
  | { readonly type: 'movement.run'; readonly command: string }
  /** `setFace(name)`. Also clears `currentCommand` — that is upstream's doing (`:821`). */
  | { readonly type: 'face.set'; readonly name: string }
  /** `setServoAngle(channel, angle)` for one channel. */
  | { readonly type: 'servo.set'; readonly joint: JointName; readonly angleDeg: number }
  /** `setServoAngle(i, angle)` for i in 0..7. */
  | { readonly type: 'servo.setAll'; readonly angleDeg: number }
  /** `servoSubtrim[channel] = valueDeg`. RAM only; the firmware never persists it. */
  | { readonly type: 'subtrim.set'; readonly channel: number; readonly valueDeg: number }
  /** Zero all eight. */
  | { readonly type: 'subtrim.reset' }
  /** Print all eight. Read-only — see {@link BARRIER_COMMAND}. */
  | { readonly type: 'subtrim.show' }
  /** Print a C initialiser for `servoSubtrim[8]`. Read-only. */
  | { readonly type: 'subtrim.save' }
  /**
   * Clear `currentCommand`, which is what `/cmd?stop=` does on the HTTP path.
   *
   * **Derived, not a CLI verb.** There is no `stop` in the serial console, and
   * that is a real gap in upstream rather than an omission here. The only CLI
   * branch that writes `currentCommand = ""` is the face branch (`:821`), so
   * this encodes as `fc <currentFace>` — and asking for the face the robot is
   * *already* showing makes it a no-op on the display too, because `setFace()`
   * opens with `if (faceName == currentFaceName && currentFaceFrames != nullptr) return;`
   * (`:904`).
   *
   * The current face has to be supplied by the caller rather than guessed,
   * because supplying the wrong one changes the face — which is precisely the
   * side effect this encoding exists to avoid.
   */
  | { readonly type: 'command.stop'; readonly currentFace: string };

/** Movement word → the CLI form that runs it. */
const MOVEMENT_FORMS: Readonly<Record<string, string>> = Object.freeze({
  // The four gaits. The CLI sets `currentCommand`, runs ONE iteration and
  // clears it (`:795`–`:798`); the HTTP path leaves it set and `loop()` repeats
  // forever. One iteration is also `SimulatedSesameRobot`'s default
  // (`continuousIterations: 1`), so the two backends agree by construction.
  forward: 'rn wf',
  backward: 'rn wb',
  left: 'rn tl',
  right: 'rn tr',
  // `run rest` / `run stand` are preferred over `rn rs` / `rn st`: same branch,
  // but the abbreviations are one keystroke away from `st`, which is the
  // subtrim dump. Being explicit costs three bytes out of thirty-one.
  rest: 'run rest',
  stand: 'run stand',
  wave: 'rn wv',
  dance: 'rn dn',
  swim: 'rn sw',
  point: 'rn pt',
  pushup: 'rn pu',
  bow: 'rn bw',
  cute: 'rn ct',
  freaky: 'rn fk',
  worm: 'rn wm',
  shake: 'rn sk',
  shrug: 'rn sg',
  dead: 'rn dd',
  crab: 'rn cb',
});

/** Movement words the serial CLI can run. 19 of the vocabulary's 20. */
export const CLI_MOVEMENT_WORDS: readonly string[] = Object.freeze(Object.keys(MOVEMENT_FORMS));

/** Which CLI branch each movement word lands on. */
const MOVEMENT_BRANCH: Readonly<Record<string, CliBranch>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MOVEMENT_FORMS).map(([word, form]) => [word, classifyCliLine(form)]),
  ),
);

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Why a command could not be turned into a line. */
export type CommandEncodeErrorCode =
  | 'unknown-movement'
  | 'not-expressible'
  | 'bad-joint'
  | 'bad-angle'
  | 'bad-channel'
  | 'bad-subtrim'
  | 'empty-name'
  | 'line-too-long';

/** Refusal, with the reason attached rather than logged and dropped. */
export class CommandEncodeError extends Error {
  constructor(
    readonly code: CommandEncodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommandEncodeError';
  }
}

/** A command, encoded and checked. */
export interface EncodedCommand {
  /** The bytes to send, **without** {@link CLI_TERMINATOR}. */
  readonly line: string;
  /** `line.length`, which is also its byte count — the encoding is ASCII. */
  readonly bytes: number;
  /** The branch {@link classifyCliLine} says these bytes reach. */
  readonly branch: CliBranch;
  /**
   * True when the encoding is not a CLI verb but a documented consequence of
   * one. Today only `command.stop`. A UI that shows a learner "what was sent"
   * should say so rather than implying the firmware has a stop command.
   */
  readonly derived: boolean;
  /** A one-line explanation for a derived or otherwise surprising encoding. */
  readonly note?: string;
}

/**
 * The firmware's own `sesameSafeToken()`, host-side.
 *
 * `firmware/patches/telemetry-instrumentation.patch:105`–`:116`: reduce to
 * `[A-Za-z0-9_.-]`, substitute `_` for everything else, never return empty.
 * `@sesame-lab/sesame-api` has the same function for the same reason at the
 * HTTP boundary; this copy exists because the protocol package must be usable
 * without the API package and because the *sending* side has to be safe even
 * when nothing HTTP-shaped is in the path.
 *
 * Sanitising before transmission, rather than trusting the firmware to sanitise
 * on the way back out, matters: a space in a face name would be read by the CLI
 * as the end of the name and the start of nothing, and a newline would submit
 * the buffer early and turn the remainder into a second command.
 */
export function safeCliToken(input: string, maxLength = 23): string {
  let out = '';
  for (const ch of input) {
    if (out.length >= maxLength) break;
    const ok =
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '-' ||
      ch === '.';
    out += ok ? ch : '_';
  }
  return out.length === 0 ? '_' : out;
}

function checkLength(line: string, branch: CliBranch, derived = false, note?: string): EncodedCommand {
  if (line.length > MAX_CLI_LINE_BYTES) {
    throw new CommandEncodeError(
      'line-too-long',
      `"${line}" is ${String(line.length)} bytes; command_buffer holds ${String(MAX_CLI_LINE_BYTES)} ` +
        `and drops the rest silently, which would dispatch a different command`,
    );
  }
  const actual = classifyCliLine(line);
  if (actual !== branch) {
    // Not reachable from the encoders below; it is here so that a future
    // encoder cannot quietly aim at the wrong branch.
    throw new CommandEncodeError(
      'not-expressible',
      `"${line}" was meant for branch ${branch} but the dispatcher reaches ${actual}`,
    );
  }
  return note === undefined
    ? { line, bytes: line.length, branch, derived }
    : { line, bytes: line.length, branch, derived, note };
}

function requireInteger(value: number, code: CommandEncodeErrorCode, what: string): number {
  if (!Number.isInteger(value)) {
    throw new CommandEncodeError(code, `${what} must be an integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Turn one {@link SesameCommand} into the line to write to UART0.
 *
 * Throws {@link CommandEncodeError} rather than emitting something that would
 * reach the wrong branch or overflow the buffer. Both failure modes are silent
 * on the device — the firmware has no error path for either — so the host side
 * is the only place they can be caught at all.
 */
export function encodeCommand(command: SesameCommand): EncodedCommand {
  switch (command.type) {
    case 'movement.run': {
      const form = MOVEMENT_FORMS[command.command];
      const branch = MOVEMENT_BRANCH[command.command];
      if (form === undefined || branch === undefined) {
        throw new CommandEncodeError(
          command.command === 'stop' ? 'not-expressible' : 'unknown-movement',
          command.command === 'stop'
            ? 'the serial CLI has no stop verb; use { type: "command.stop", currentFace }'
            : `"${command.command}" is not one of the ${String(CLI_MOVEMENT_WORDS.length)} ` +
              `movement words the serial CLI accepts`,
        );
      }
      return checkLength(form, branch);
    }

    case 'face.set': {
      if (command.name.length === 0) {
        throw new CommandEncodeError('empty-name', 'a face name is required');
      }
      // `fc ` over `face `: two bytes cheaper out of a 31-byte budget, and the
      // firmware treats them identically (`command_buffer[1] == 'c'` picks the
      // offset, `:819`).
      return checkLength(`fc ${safeCliToken(command.name)}`, 'face');
    }

    case 'servo.set': {
      if (!JOINT_ORDER.includes(command.joint)) {
        throw new CommandEncodeError('bad-joint', `"${String(command.joint)}" is not a joint name`);
      }
      const angle = requireInteger(command.angleDeg, 'bad-angle', 'angle');
      // The CLI branch itself does not range-check (`:870`); `setServoAngle()`
      // clamps at `:1053`. Refusing here is the *external* contract, the same
      // one `GET /cmd?motor=&value=` enforces at `:252` — and it keeps a caller
      // from believing a 400° request did something.
      if (angle < ANGLE_MIN_DEG || angle > ANGLE_MAX_DEG) {
        throw new CommandEncodeError(
          'bad-angle',
          `angle ${String(angle)} is outside ${String(ANGLE_MIN_DEG)}..${String(ANGLE_MAX_DEG)}`,
        );
      }
      return checkLength(`${String(jointIndex(command.joint))} ${String(angle)}`, 'motor');
    }

    case 'servo.setAll': {
      const angle = requireInteger(command.angleDeg, 'bad-angle', 'angle');
      if (angle < ANGLE_MIN_DEG || angle > ANGLE_MAX_DEG) {
        throw new CommandEncodeError(
          'bad-angle',
          `angle ${String(angle)} is outside ${String(ANGLE_MIN_DEG)}..${String(ANGLE_MAX_DEG)}`,
        );
      }
      return checkLength(`all ${String(angle)}`, 'all');
    }

    case 'subtrim.set': {
      const channel = requireInteger(command.channel, 'bad-channel', 'channel');
      if (channel < 0 || channel >= JOINT_ORDER.length) {
        throw new CommandEncodeError('bad-channel', `channel ${String(channel)} is not 0..7`);
      }
      const value = requireInteger(command.valueDeg, 'bad-subtrim', 'subtrim');
      if (value < -90 || value > 90) {
        throw new CommandEncodeError('bad-subtrim', `subtrim ${String(value)} is not -90..90`);
      }
      // The long form. `st 0 5` reaches the same branch, but only because
      // `st save` and `st reset` were caught two branches earlier — a fragility
      // worth not depending on when three bytes buys immunity from it.
      return checkLength(`subtrim ${String(channel)} ${String(value)}`, 'subtrim-set');
    }

    case 'subtrim.reset':
      return checkLength('subtrim reset', 'subtrim-reset');

    case 'subtrim.show':
      return checkLength('subtrim', 'subtrim-show');

    case 'subtrim.save':
      return checkLength('subtrim save', 'subtrim-save');

    case 'command.stop': {
      const face = safeCliToken(command.currentFace);
      return checkLength(
        `fc ${face}`,
        'face',
        true,
        `the serial CLI has no stop verb; "fc ${face}" clears currentCommand at :821 and ` +
          `setFace() returns immediately at :904 because "${face}" is already showing`,
      );
    }

    default: {
      // Unreachable for a well-typed caller, and very much reachable for one
      // that is not: the bridge's control channel hands this function whatever
      // arrived over a WebSocket. Falling off the end of the switch would have
      // returned `undefined` and put a literal "undefined" nowhere useful —
      // found by `control.test.ts`, which is the point of testing the escape
      // hatches rather than the happy path.
      const unknown: never = command;
      throw new CommandEncodeError(
        'not-expressible',
        `unknown command type ${JSON.stringify((unknown as { type?: unknown }).type)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Acknowledgements, and the completion barrier
// ---------------------------------------------------------------------------

/**
 * The read-only CLI command used as a **completion barrier**.
 *
 * The firmware's console reads **one character per `loop()` iteration** (`:788`
 * — a single `Serial.read()`, not a drain loop) and executes a line
 * synchronously inside that iteration. So the console is strictly serial: if
 * two lines are written back to back, the second cannot be dispatched until the
 * first has fully returned, however long its movement took.
 *
 * That turns any command with distinctive output into a fence. `subtrim` is the
 * right one: it is the only CLI verb that is purely read-only *and* prints an
 * unmistakable first line, it needs no arguments, and it changes no servo, no
 * face and no `currentCommand`.
 *
 * The cost, stated plainly: it also calls `recordInput()` (`:792`), so it
 * refreshes `lastInputTime` and suppresses the 30-second Wi-Fi info scroll.
 * There is no read-only CLI branch that avoids `recordInput()` — it runs before
 * the chain.
 */
export const BARRIER_COMMAND = 'subtrim';

/** First line `subtrim` prints — `sesame-firmware-main.ino:826`. */
export const BARRIER_MARKER = 'Subtrim values:';

/**
 * Lines the CLI prints back, as prefixes, for callers that want an ack rather
 * than a barrier. Nothing depends on these being exhaustive; they are a
 * convenience for logging and for tests.
 */
export const CLI_ACK_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  face: 'Face set to ', // :822
  motor: 'Servo ', // :872
  all: 'All servos set to ', // :867
  'subtrim-show': BARRIER_MARKER, // :826
  'subtrim-save': 'Copy and paste this into your code:', // :834
  'subtrim-reset': 'All subtrim values reset to 0', // :844
  'subtrim-set': 'Motor ', // :853
});
