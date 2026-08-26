/**
 * The one artefact that can leave this system and touch a real robot.
 *
 * Sesame Studio's whole purpose is to emit `setServoAngle()` C++ that a person
 * pastes into `firmware/movement-sequences.h`. The research report is explicit
 * that Studio's *concepts* are worth keeping and its Tkinter UI is not, and
 * that the copy-paste-to-Arduino step should be replaced by driving the robot
 * directly — but "replaced" is not "removed". Somebody who owns a Sesame still
 * wants the code, so the export has to actually compile against the firmware it
 * claims compatibility with.
 *
 * ## The call shape is a contract, not a guess
 *
 * Two independent sources fix it, and they agree:
 *
 * - `firmware/movement-sequences.h:80` — the firmware's own `runStandPose()`:
 *   ```c
 *   setServoAngle(R1, 135);
 *   ```
 *   `R1` is not a string: `movement-sequences.h:5` declares
 *   `enum ServoName : uint8_t { R1=0, R2=1, L1=2, L2=3, R4=4, R3=5, L3=6, L4=7 }`,
 *   so the identifier is an enum constant that converts to the `uint8_t channel`
 *   of `void setServoAngle(uint8_t channel, int angle)`.
 * - `hardware/hardware-map.json` → `servos.control.setServoAngle.signature`,
 *   which records that signature and the four steps of the body.
 *
 * Studio emits exactly that call — `sesame_studio.py:196` builds
 * `f"setServoAngle({servo_idx}, {angle}); "` with `servo_idx` being the *name*
 * string `"R1"`, not the index — so an export in this shape is Studio-compatible
 * and firmware-compatible at the same time. {@link CPP_CALL_SHAPE} pins it and
 * a test asserts the emitter's output against a line lifted out of the real
 * header.
 *
 * ## Where Studio and the firmware disagree, and what we do about it
 *
 * Studio closes each frame with `delay(ms)` (`sesame_studio.py:228`). The
 * firmware's own movement functions close theirs with `delayWithFace(ms)`, and
 * that is not a cosmetic difference: `hardware-map.json` records that
 * `delayWithFace()` *"spins for the duration while servicing
 * updateAnimatedFace(), server.handleClient() and dnsServer.processNextRequest()"*.
 * A bare `delay()` pasted into the firmware freezes the face animation, the web
 * server and the captive-portal DNS for its whole duration. So
 * `delayWithFace` is the default and Studio's `delay` is an explicit choice,
 * labelled with what it costs — rather than silently picking one and calling it
 * compatibility.
 *
 * ## Round-tripping
 *
 * {@link parseSesameCpp} is not a convenience. An export nobody can read back
 * is an export nobody can check, so the emitter's output is parsed by the same
 * rules the firmware's own bodies would be read under (writes accumulate, a
 * delay closes the frame — the rule `importMovement()` already uses on the
 * extracted choreography), and {@link roundTrip} reports whether the document
 * survived. The Lab shows that verdict next to the code, and the browser
 * harness asserts it independently.
 */
import { JOINT_ORDER, jointIndex, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';

import type { SequenceDoc, SequenceFrame } from '../editors/sequence.js';

/**
 * The literal call shape, as it appears in `firmware/movement-sequences.h:80`.
 *
 * Kept as a template rather than as prose so a test can compare the emitter's
 * output against the real header's text character for character.
 */
export const CPP_CALL_SHAPE = 'setServoAngle(%JOINT%, %ANGLE%);';

/** `movement-sequences.h:5`. The identifiers the export may name. */
export const SERVO_ENUM_SOURCE = 'firmware/movement-sequences.h:5';

export type DelayStyle = 'delayWithFace' | 'delay';

export interface CppExportOptions {
  /** C++ identifier for the emitted function. Sanitised, never trusted. */
  readonly functionName?: string;
  /** `delayWithFace` (firmware) or `delay` (what Studio emits). */
  readonly delayStyle?: DelayStyle;
  /** Prepend the provenance/honesty header. On by default; off for round-trip tests. */
  readonly header?: boolean;
}

/** Reduce anything to a legal C++ identifier. An empty result becomes `runLabPose`. */
export function cppIdentifier(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    else if (out.length > 0 && !out.endsWith('_')) out += '_';
  }
  out = out.replace(/_+$/, '');
  if (out.length === 0 || /^[0-9]/.test(out)) out = `runLab${out}`;
  return out;
}

/**
 * Every angle in the document that is indistinguishable from a neighbour at the
 * pin, with the neighbours named.
 *
 * Recomputed from `quantiseCommandedAngle()` at export time. Not a lookup
 * table, not a remembered number: 89 of the 181 commandable angles alias, and
 * which ones is a property of ESP32Servo's arithmetic, so the export computes
 * it the same way the PWM inspector does.
 */
export function aliasingInExport(
  doc: SequenceDoc,
): readonly { readonly angleDeg: number; readonly ticks: number; readonly aliases: readonly number[] }[] {
  const seen = new Set<number>();
  const out: { angleDeg: number; ticks: number; aliases: readonly number[] }[] = [];
  for (const frame of doc.frames) {
    for (const joint of JOINT_ORDER) {
      const angle = frame.angles[joint];
      if (angle === undefined || seen.has(angle)) continue;
      seen.add(angle);
      if (angle < 0 || angle > 180 || !Number.isInteger(angle)) continue;
      const q = quantiseCommandedAngle(angle);
      const others = q.aliases.filter((a) => a !== angle);
      if (others.length > 0) out.push({ angleDeg: angle, ticks: q.ticks, aliases: others });
    }
  }
  return out.sort((a, b) => a.angleDeg - b.angleDeg);
}

/**
 * Sesame Studio's per-servo input ranges (`sesame_studio.py:198`–`:222`).
 *
 * Studio refuses `R1`/`L2` below 45 and `R2`/`L1` above 135. **The firmware
 * does not**: `setServoAngle()` clamps to 0–180 and nothing else. So this is
 * not validation — it is a note that Studio, and therefore presumably somebody
 * who built one of these, believed these joints have a smaller usable range
 * than the firmware enforces. Exported code outside it still compiles.
 */
export const STUDIO_RANGES: Readonly<Record<JointName, { readonly min: number; readonly max: number }>> = {
  R1: { min: 45, max: 180 },
  L2: { min: 45, max: 180 },
  R2: { min: 0, max: 135 },
  L1: { min: 0, max: 135 },
  R3: { min: 0, max: 180 },
  R4: { min: 0, max: 180 },
  L3: { min: 0, max: 180 },
  L4: { min: 0, max: 180 },
};

export function studioRangeViolations(
  doc: SequenceDoc,
): readonly { readonly joint: JointName; readonly angleDeg: number; readonly min: number; readonly max: number }[] {
  const out: { joint: JointName; angleDeg: number; min: number; max: number }[] = [];
  for (const frame of doc.frames) {
    for (const joint of JOINT_ORDER) {
      const angle = frame.angles[joint];
      if (angle === undefined) continue;
      const range = STUDIO_RANGES[joint];
      if (angle < range.min || angle > range.max) {
        out.push({ joint, angleDeg: angle, min: range.min, max: range.max });
      }
    }
  }
  return out;
}

/**
 * Emit the document as C++.
 *
 * One `setServoAngle()` per commanded channel **in firmware enum order**, then
 * the wait — which is what the firmware's own bodies do, because the firmware
 * has no multi-joint primitive. The export does not group, interpolate or
 * reorder, and it emits the wait for every frame including a zero one so the
 * text and the document have the same number of frames in them.
 */
export function emitSesameCpp(doc: SequenceDoc, options: CppExportOptions = {}): string {
  const { functionName, delayStyle = 'delayWithFace', header = true } = options;
  const name = cppIdentifier(functionName ?? doc.name);
  const lines: string[] = [];

  if (header) {
    lines.push(
      '// ---------------------------------------------------------------------',
      '// Generated by Sesame Lab. Paste into firmware/movement-sequences.h and',
      `// add "void ${name}();" to the prototypes near the top of that file.`,
      '//',
      '// THESE ARE COMMANDED ANGLES. Nothing here has been verified against a',
      '// physical robot: Sesame Lab has never driven one and cannot. What the',
      '// joints do when this runs on real hardware is unknown.',
      '//',
      '// 89 of the 181 commandable angles are indistinguishable at the pin',
      '// (ESP32Servo 3.0.9 maps 0-180 onto 732-2500us and quantises to 10-bit',
      '// LEDC ticks, so 181 commands produce 92 distinct pulses). Neighbouring',
      '// values in this file may therefore be the same instruction to the servo.',
      '// ---------------------------------------------------------------------',
      '',
    );
  }

  lines.push(`void ${name}() {`);
  doc.frames.forEach((frame, index) => {
    lines.push(`  // Frame ${String(index + 1)}`);
    const calls: string[] = [];
    for (const joint of JOINT_ORDER) {
      const angle = frame.angles[joint];
      if (angle === undefined) continue;
      calls.push(
        CPP_CALL_SHAPE.replace('%JOINT%', joint).replace('%ANGLE%', String(Math.trunc(angle))),
      );
    }
    for (const call of calls) lines.push(`  ${call}`);
    lines.push(`  ${delayStyle}(${String(Math.max(0, Math.round(frame.delayMs)))});`);
    if (index < doc.frames.length - 1) lines.push('');
  });
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

export interface ParsedCpp {
  readonly functionName: string | null;
  readonly frames: readonly SequenceFrame[];
  /** Lines that looked like a call this parser knows and were not usable. */
  readonly rejected: readonly string[];
  /** Channels written by numeric index rather than by enum name, with the name. */
  readonly numericChannels: readonly { readonly index: number; readonly joint: JointName | null }[];
}

const CALL_RE = /setServoAngle\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*,\s*(-?\d+)\s*\)/g;
const DELAY_RE = /\b(delayWithFace|delay)\s*\(\s*(\d+)\s*\)/g;
const FUNCTION_RE = /\bvoid\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Strip `//` and block comments without disturbing line structure. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Read `setServoAngle()` C++ back into frames.
 *
 * The reading rule is the firmware's, not a new one: servo writes accumulate
 * into the frame being built and a `delay`/`delayWithFace` closes it — the same
 * rule `importMovement()` applies to the extracted choreography, so a movement
 * copied out of `movement-sequences.h` and one exported from the Lab come back
 * as the same shape.
 *
 * Both spellings of a channel are accepted, because both occur in the real
 * header: `setServoAngle(R1, 135)` in the pose bodies and `setServoAngle(i, 90)`
 * from the `for` loop at `:74` which the extractor expands to eight numeric
 * writes.
 */
export function parseSesameCpp(source: string): ParsedCpp {
  const text = stripComments(source);
  const frames: SequenceFrame[] = [];
  const rejected: string[] = [];
  const numericChannels: { index: number; joint: JointName | null }[] = [];
  let current: Partial<Record<JointName, number>> = {};

  // One ordered pass over both kinds of call, so the interleaving is preserved.
  interface Token {
    readonly at: number;
    readonly kind: 'servo' | 'delay';
    readonly a: string;
    readonly b: number;
  }
  const tokens: Token[] = [];
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(text); m !== null; m = CALL_RE.exec(text)) {
    tokens.push({ at: m.index, kind: 'servo', a: m[1] ?? '', b: Number.parseInt(m[2] ?? '0', 10) });
  }
  DELAY_RE.lastIndex = 0;
  for (let m = DELAY_RE.exec(text); m !== null; m = DELAY_RE.exec(text)) {
    tokens.push({ at: m.index, kind: 'delay', a: m[1] ?? '', b: Number.parseInt(m[2] ?? '0', 10) });
  }
  tokens.sort((x, y) => x.at - y.at);

  for (const token of tokens) {
    if (token.kind === 'delay') {
      if (Object.keys(current).length === 0 && token.b === 0) continue;
      frames.push({ angles: current, delayMs: token.b });
      current = {};
      continue;
    }
    let joint: JointName | undefined;
    if (/^\d+$/.test(token.a)) {
      const index = Number.parseInt(token.a, 10);
      joint = JOINT_ORDER[index];
      numericChannels.push({ index, joint: joint ?? null });
    } else if ((JOINT_ORDER as readonly string[]).includes(token.a)) {
      joint = token.a as JointName;
    }
    if (joint === undefined) {
      rejected.push(`setServoAngle(${token.a}, ${String(token.b)}) — not one of ${JOINT_ORDER.join(' ')}`);
      continue;
    }
    current = { ...current, [joint]: token.b };
  }
  if (Object.keys(current).length > 0) frames.push({ angles: current, delayMs: 0 });

  return {
    functionName: FUNCTION_RE.exec(text)?.[1] ?? null,
    frames,
    rejected,
    numericChannels,
  };
}

export interface RoundTripResult {
  readonly ok: boolean;
  /** The first disagreement, phrased so it can be read without the diff. */
  readonly detail: string;
  readonly framesIn: number;
  readonly framesOut: number;
  /** Every `setServoAngle()` the text would issue, in order. */
  readonly writes: readonly { readonly joint: JointName; readonly angleDeg: number; readonly frame: number }[];
}

/** Canonical write list for a frame: firmware enum order, integer angles. */
function writesOf(frame: SequenceFrame): { joint: JointName; angleDeg: number }[] {
  const out: { joint: JointName; angleDeg: number }[] = [];
  for (const joint of JOINT_ORDER) {
    const angle = frame.angles[joint];
    if (angle === undefined) continue;
    out.push({ joint, angleDeg: Math.trunc(angle) });
  }
  return out;
}

/**
 * Emit, parse back, and compare — the check the Lab shows beside the code.
 *
 * Compares the *pose sequence*, not the text: frames in order, each frame's
 * writes in firmware enum order, and each frame's wait. That is the property
 * that matters, because it is the one a robot would experience.
 */
export function roundTrip(doc: SequenceDoc, options: CppExportOptions = {}): RoundTripResult {
  const source = emitSesameCpp(doc, options);
  const parsed = parseSesameCpp(source);
  const writes: { joint: JointName; angleDeg: number; frame: number }[] = [];
  parsed.frames.forEach((frame, index) => {
    for (const w of writesOf(frame)) writes.push({ ...w, frame: index });
  });

  const framesIn = doc.frames.length;
  const framesOut = parsed.frames.length;
  const fail = (detail: string): RoundTripResult => ({ ok: false, detail, framesIn, framesOut, writes });

  if (parsed.rejected.length > 0) return fail(`the emitted code contains ${String(parsed.rejected.length)} call(s) this parser could not read: ${parsed.rejected[0] ?? ''}`);
  if (framesIn !== framesOut) return fail(`${String(framesIn)} frame(s) went in and ${String(framesOut)} came back`);

  for (let i = 0; i < framesIn; i += 1) {
    const a = writesOf(doc.frames[i] as SequenceFrame);
    const b = writesOf(parsed.frames[i] as SequenceFrame);
    if (a.length !== b.length) {
      return fail(`frame ${String(i + 1)} issued ${String(a.length)} write(s) and came back with ${String(b.length)}`);
    }
    for (let k = 0; k < a.length; k += 1) {
      const x = a[k] as { joint: JointName; angleDeg: number };
      const y = b[k] as { joint: JointName; angleDeg: number };
      if (x.joint !== y.joint) {
        return fail(`frame ${String(i + 1)} write ${String(k + 1)}: ${x.joint} (channel ${String(jointIndex(x.joint))}) went out, ${y.joint} came back`);
      }
      if (x.angleDeg !== y.angleDeg) {
        return fail(`frame ${String(i + 1)} ${x.joint}: ${String(x.angleDeg)}° went out, ${String(y.angleDeg)}° came back`);
      }
    }
    const delayIn = Math.max(0, Math.round((doc.frames[i] as SequenceFrame).delayMs));
    const delayOut = (parsed.frames[i] as SequenceFrame).delayMs;
    if (delayIn !== delayOut) {
      return fail(`frame ${String(i + 1)} wait: ${String(delayIn)} ms went out, ${String(delayOut)} came back`);
    }
  }

  return {
    ok: true,
    detail: `${String(framesIn)} frame(s), ${String(writes.length)} setServoAngle() call(s) — parsed back identical`,
    framesIn,
    framesOut,
    writes,
  };
}
