/**
 * Types, runtime validator and typed accessors for `hardware/calibration.json`.
 *
 * ## What this layer is for
 *
 * `hardware/joint-map.json` describes the **design**. A design is a statement
 * about every Sesame that will ever be built. A handful of the numbers a
 * simulator needs are not properties of the design at all — they are properties
 * of *one particular robot on one particular desk*: which way a horn was
 * pressed onto its spline, what subtrim that build needs, how fast its servos
 * actually slew, where its horns sit at power-on, whether the part engraved
 * `R1` really is the one on channel 0.
 *
 * Those values are **hardware-gated**: no amount of CAD, firmware reading or
 * choreography analysis settles them. Today every one of them is a
 * carried-forward default. The day a physical robot exists, every one of them
 * becomes an hour with a protractor and this file.
 *
 * ## The contract
 *
 * This module **layers over** the joint map; it never forks it. A calibration
 * document carries, for every hardware-gated value:
 *
 * - the value itself, defaulting to *exactly* today's value, so loading the
 *   shipped `calibration.json` changes no behaviour anywhere;
 * - `measured: false | true`, as a **discriminant**, not decoration;
 * - the method, the source, and `wouldBeConfirmedBy`;
 * - the checklist step in `docs/findings/V6-hardware-verification-checklist.md`
 *   that would settle it, and the issue that step closes.
 *
 * ## Why this cannot launder a guess into a fact
 *
 * Four mechanisms, all of which have to be defeated together:
 *
 * 1. **`measured` is a type discriminant.** {@link MeasuredValue} carries
 *    `measuredAt`, `measuredBy`, `robotSerial`, `instrument` and
 *    `checklistStep` as *required* fields; {@link CarriedForwardValue} has none
 *    of them and cannot be narrowed to have them. Rendering "measured on …"
 *    for a guess is a compile error, not a code review finding.
 * 2. **A carried-forward value may not differ from its documented default.**
 *    {@link parseCalibration} (and `pnpm validate:calibration`) re-derive every
 *    `measured: false` value from `hardware/joint-map.json` and the documented
 *    simulation defaults and reject any drift. You cannot change a number
 *    without also claiming you measured it.
 * 3. **Claiming you measured it costs something.** `measured: true` requires
 *    naming a robot, an instrument, a person, a timestamp and a procedure step,
 *    and requires `meta.session` to be present. That is deliberately awkward.
 * 4. **A confirmed semantic name never becomes a plain string by accident.**
 *    {@link CalibrationView.semanticNameFor} returns a discriminated union
 *    whose `"guess"` branch has no string on it at all — you still have to go
 *    through `readGuessedSemanticName`. The `"confirmed"` branch only exists if
 *    a {@link MeasuredValue} says so.
 *
 * Nothing in the shipped `hardware/calibration.json` is measured. That is not a
 * gap in this module; it is the state of the world, recorded honestly.
 */
import {
  JOINT_ORDER,
  isJointName,
  type JointIndex,
  type JointName,
} from './joints.js';
import {
  SEMANTIC_NAME_IS_A_GUESS,
  readGuessedSemanticName,
  type JointMapView,
  type UnverifiedSemanticName,
} from './joint-map.js';

// ---------------------------------------------------------------------------
// The measured / not-measured barrier
// ---------------------------------------------------------------------------

/**
 * A hardware-gated value that **nobody has measured**.
 *
 * `value` is whatever the project uses today — a CAD reading, a datasheet
 * figure, a firmware default, or an explicitly reasoned simulation choice. It
 * is safe to consume: that is the point of defaulting to today's value. It is
 * *not* safe to describe as an observation, and the type will not let you,
 * because none of the fields that would let you say when, by whom, on which
 * robot or with what instrument exist on this variant.
 */
export interface CarriedForwardValue<T> {
  readonly value: T;
  /** Literal `false`. Narrowing on this is how you tell the two apart. */
  readonly measured: false;
  /** The artefact or decision the default came from, e.g. `"hardware/joint-map.json joints[R1].directionSign.value"`. */
  readonly source: string;
  /** How the default was arrived at. Never a measurement — the validator rejects wording that claims one. */
  readonly method: string;
  /** Exactly what would settle it. Never empty. */
  readonly wouldBeConfirmedBy: readonly string[];
  /** Step id in `docs/findings/V6-hardware-verification-checklist.md`, e.g. `"V6-04"`. */
  readonly checklistStep: string;
  /** Issue ids this value keeps open, e.g. `["ISSUE-20260823-007"]`. */
  readonly closesIssues: readonly string[];
  readonly note?: string;
}

/**
 * A hardware-gated value that **was measured on a named physical robot**.
 *
 * Every field here is required, and the validator rejects empty strings. That
 * is the whole cost model: promoting a guess is not an edit to one number, it
 * is a claim with five attributions attached to it.
 */
export interface MeasuredValue<T> {
  readonly value: T;
  /** Literal `true`. */
  readonly measured: true;
  /** ISO-8601 timestamp of the measurement. */
  readonly measuredAt: string;
  /** Who measured it. */
  readonly measuredBy: string;
  /**
   * **Which robot.** Calibration is per-build, not per-design: horn spline
   * offset and subtrim differ between two robots printed from the same files.
   * A calibration document without a robot identity is not calibration.
   */
  readonly robotSerial: string;
  /** What it was measured with — `"digital protractor"`, `"the sim, twiddled to match"`, … */
  readonly instrument: string;
  /** The procedure followed. */
  readonly method: string;
  /** Step id in `docs/findings/V6-hardware-verification-checklist.md`. */
  readonly checklistStep: string;
  /** Issue ids this measurement closes or advances. */
  readonly closesIssues: readonly string[];
  readonly note?: string;
}

/**
 * One hardware-gated value, in exactly one of two epistemic states.
 *
 * ```ts
 * const f = view.field('R1', 'zeroReferenceDeg');
 * f.value;                     // always readable — defaults are today's values
 * f.measuredAt;                // compile error: not on CarriedForwardValue
 * if (f.measured) f.measuredAt // fine, and now `f` names a robot
 * ```
 */
export type CalibratedValue<T> = CarriedForwardValue<T> | MeasuredValue<T>;

/** Narrow a {@link CalibratedValue} to the measured variant. */
export function isMeasured<T>(field: CalibratedValue<T>): field is MeasuredValue<T> {
  return field.measured === true;
}

/**
 * Read a value, whatever its epistemic state. Safe by construction: an
 * unmeasured field holds today's value, so this never changes behaviour.
 *
 * Use {@link isMeasured} when the *status* matters — a UI label, a report, or
 * anything that must not imply an observation.
 */
export function calibratedValue<T>(field: CalibratedValue<T>): T {
  return field.value;
}

/**
 * Read a value **only if it was measured**, otherwise `undefined`.
 *
 * For code that must refuse to run on a guess — a physical-robot adapter
 * computing a real trajectory, say — rather than silently using a datasheet
 * number.
 */
export function measuredValueOnly<T>(field: CalibratedValue<T>): T | undefined {
  return field.measured ? field.value : undefined;
}

/** A one-line human description that cannot accidentally imply a measurement. */
export function describeCalibratedValue<T>(field: CalibratedValue<T>, label: string): string {
  const v = JSON.stringify(field.value);
  return field.measured
    ? `${label} = ${v} — MEASURED ${field.measuredAt} by ${field.measuredBy} on robot ${field.robotSerial} (${field.instrument}); step ${field.checklistStep}`
    : `${label} = ${v} — NOT MEASURED (${field.method}); would be settled by step ${field.checklistStep}`;
}

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/** Inclusive degree interval, mirroring the joint map's `DegreeRange`. */
export interface CalibrationDegreeRange {
  readonly min: number;
  readonly max: number;
}

/** The OLED's active (lit) plane, in millimetres. */
export interface OledActivePlaneMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Whether the part engraved with a joint's firmware name is the one on that channel. */
export interface PartIdentityObservation {
  /** `true` if the engraving on the installed part matches this channel's firmware name. */
  readonly matchesFirmwareName: boolean;
  /** The name actually engraved on the part found on this channel, if different. */
  readonly engravedName: string | null;
}

/** The per-joint hardware-gated fields, as they appear in the document. */
export interface CalibrationJointEntry {
  /** Authoritative identity, and the only key. Always matches `JOINT_ORDER`. */
  readonly firmwareName: JointName;
  /** Authoritative identity. Equals the array position. */
  readonly firmwareIndex: JointIndex;

  /**
   * The **bookkeeping** sign in `bodyRelativeDeg = (commandedDeg - zero) * sign`.
   * Not a physical rotation direction — see {@link rotationSenseSign}.
   */
  readonly directionSign: CalibratedValue<1 | -1>;

  /**
   * The **physical** rotation sense: `childRotationDeg = sign * (commandedDeg - 90)`
   * about the joint's axis. This is what a protractor settles, and what the GLB
   * bakes as `extras.signPerCommandedDeg`.
   */
  readonly rotationSenseSign: CalibratedValue<1 | -1>;

  /** The commanded degree treated as this joint's zero. Design value 90. */
  readonly zeroReferenceDeg: CalibratedValue<number>;

  /**
   * Per-channel `servoSubtrim[]`, in degrees, added **before** the firmware
   * clamp. Firmware default 0; firmware accepts −90…+90.
   */
  readonly servoSubtrimDeg: CalibratedValue<number>;

  /**
   * Residual angular error from pressing the horn onto a splined shaft, in
   * degrees. Quantised at `360 / hornSplineTeeth`; up to half that in
   * magnitude. Distinct from subtrim: subtrim is the correction, this is the
   * error being corrected.
   */
  readonly hornSplineOffsetDeg: CalibratedValue<number>;

  /**
   * The real travel the linkage allows, or `null` for "unknown". This is **not**
   * the firmware clamp (`0..180`, authoritative, in the joint map).
   */
  readonly mechanicalLimitsDeg: CalibratedValue<CalibrationDegreeRange | null>;

  /**
   * A conservative range that is safe to command with the robot elevated and
   * unloaded, or `null`. Consumed by nothing today; the hardware checklist
   * fills it in before any full-range sweep.
   */
  readonly safeTravelDeg: CalibratedValue<CalibrationDegreeRange | null>;

  /** Where this joint's horn actually sits at power-on, or `null` for unknown. */
  readonly powerOnCommandedDeg: CalibratedValue<number | null>;

  /** Whether the installed part is the one the CAD draws here. `null` = uninspected. */
  readonly partIdentity: CalibratedValue<PartIdentityObservation | null>;
}

/** Whole-robot hardware-gated fields. */
export interface CalibrationRobotEntry {
  /** Which servo is actually fitted. The CAD models an SG90; the BOM calls for MG90S. */
  readonly servoModel: CalibratedValue<'MG90S' | 'SG90' | 'other' | 'unknown'>;
  /** Output-spline tooth count. Sets the horn quantum: `360 / teeth`. */
  readonly hornSplineTeeth: CalibratedValue<number>;
  /**
   * Shaft degrees per commanded degree over the firmware's `0..180` domain,
   * given `attach(pin, 732, 2929)`. Assumed exactly 1.0; never measured.
   */
  readonly angleGainDegPerCommandedDeg: CalibratedValue<number>;
  /** Servo slew for `simulatedDeg`, °/s, or `null` for instantaneous. */
  readonly slewDegPerSec: CalibratedValue<number | null>;
  /** Fallback `commandedDeg` for a channel never written. `setup()` does not command. */
  readonly powerOnCommandedDeg: CalibratedValue<number>;
  /** Does `walk` travel toward the CAD front (OLED / notch end)? `null` = unknown. */
  readonly walkDirectionMatchesDrawnFront: CalibratedValue<boolean | null>;
  /** The OLED's lit area. V2's height is a decision, not a measurement. */
  readonly oledActivePlaneMm: CalibratedValue<OledActivePlaneMm>;
  /** Simulated period of the `pressingCheck()` busy loop. No firmware period exists. */
  readonly spinQuantumMs: CalibratedValue<number>;
  /** Simulated period of one `loop()` iteration. No firmware period exists. */
  readonly loopQuantumMs: CalibratedValue<number>;
}

/** Present only once something has actually been measured. */
export interface CalibrationSession {
  readonly robotSerial: string;
  readonly performedBy: string;
  readonly startedAt: string;
  readonly location: string;
  readonly instruments: readonly string[];
  readonly firmwareProfile: string;
  readonly note: string;
}

export interface CalibrationLayeredOver {
  readonly path: string;
  readonly jointMapVersion: string;
  readonly sha256: string;
  readonly note: string;
}

export interface CalibrationMeta {
  readonly schemaVersion: string;
  readonly calibrationVersion: string;
  readonly task: string;
  readonly robotId: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly regenerateWith: string;
  readonly validateWith: string;
  readonly layersOver: CalibrationLayeredOver;
  readonly epistemicContract: string;
  /**
   * `"uncalibrated"` when no field is measured, `"partial"` when some are,
   * `"complete"` when all are. The validator **recomputes** this rather than
   * trusting it.
   */
  readonly calibrationStatus: 'uncalibrated' | 'partial' | 'complete';
  readonly measuredFieldCount: number;
  readonly totalFieldCount: number;
  readonly checklist: string;
  readonly consumers: readonly string[];
}

export interface CalibrationUnresolvedEntry {
  readonly id: string;
  readonly subject: string;
  readonly status: 'open' | 'partially-resolved' | 'resolved';
  readonly reason: string;
  readonly resolvedBy: string;
  readonly checklistStep: string;
  readonly issues: readonly string[];
}

/** The whole of `hardware/calibration.json`. */
export interface Calibration {
  readonly meta: CalibrationMeta;
  /** `null` until somebody actually calibrates a robot. */
  readonly session: CalibrationSession | null;
  /** Eight entries, in `JOINT_ORDER`. */
  readonly joints: readonly CalibrationJointEntry[];
  readonly robot: CalibrationRobotEntry;
  readonly unresolved: readonly CalibrationUnresolvedEntry[];
}

// ---------------------------------------------------------------------------
// Field ids
// ---------------------------------------------------------------------------

/** Per-joint calibratable fields, as an addressable vocabulary. */
export const CALIBRATION_JOINT_FIELDS = [
  'directionSign',
  'rotationSenseSign',
  'zeroReferenceDeg',
  'servoSubtrimDeg',
  'hornSplineOffsetDeg',
  'mechanicalLimitsDeg',
  'safeTravelDeg',
  'powerOnCommandedDeg',
  'partIdentity',
] as const;
export type CalibrationJointField = (typeof CALIBRATION_JOINT_FIELDS)[number];

/** Whole-robot calibratable fields. */
export const CALIBRATION_ROBOT_FIELDS = [
  'servoModel',
  'hornSplineTeeth',
  'angleGainDegPerCommandedDeg',
  'slewDegPerSec',
  'powerOnCommandedDeg',
  'walkDirectionMatchesDrawnFront',
  'oledActivePlaneMm',
  'spinQuantumMs',
  'loopQuantumMs',
] as const;
export type CalibrationRobotField = (typeof CALIBRATION_ROBOT_FIELDS)[number];

/** 8 × 9 joint fields + 9 robot fields. */
export const CALIBRATION_FIELD_COUNT =
  JOINT_ORDER.length * CALIBRATION_JOINT_FIELDS.length + CALIBRATION_ROBOT_FIELDS.length;

// ---------------------------------------------------------------------------
// Defaults — "today's values", derived rather than duplicated
// ---------------------------------------------------------------------------

/**
 * The simulation and asset defaults this layer must reproduce exactly.
 *
 * These are the numbers that are *not* in `joint-map.json`. Each is a documented
 * choice made by an earlier task; the reference is in the string beside it in
 * `hardware/calibration.json`, and `calibration-defaults.test.ts` pins them
 * against the packages that actually use them.
 */
export const CALIBRATION_DEFAULTS = Object.freeze({
  /** V0 §6.6 / ISSUE `servo-model-is-sg90-not-mg90s`: BOM says MG90S, CAD models SG90. */
  servoModel: 'unknown' as const,
  /** MG90S output spline, 20 teeth → an 18° quantum, ±9° worst case. */
  hornSplineTeeth: 20,
  /** V0's absolute-sense fit assumes exactly one shaft degree per commanded degree. */
  angleGainDegPerCommandedDeg: 1,
  /** `sesame-sim` `DEFAULT_SLEW_DEG_PER_SEC` — MG90S datasheet, 0.1 s / 60° at 4.8 V. */
  slewDegPerSec: 600,
  /** `sesame-sim` `powerOnDeg`. `setup()` attaches without commanding. */
  powerOnCommandedDeg: 90,
  /** V2 §6: the 11.80 mm height is a decision of V2; the 23.60 mm width is a CAD reading. */
  oledActivePlaneMm: Object.freeze({ widthMm: 23.6, heightMm: 11.8 }),
  /** `sesame-sim` `spinQuantumMs`. `pressingCheck()` spins on bare `yield()`. */
  spinQuantumMs: 1,
  /** `sesame-sim` `loopQuantumMs`. `loop()` has no delay in it. */
  loopQuantumMs: 1,
  /** `int8_t servoSubtrim[8] = {0,…}` — RAM only, never persisted by the firmware. */
  servoSubtrimDeg: 0,
  /** No horn offset assumed. A built robot is up to ±(360/teeth)/2 away from this. */
  hornSplineOffsetDeg: 0,
} as const);

/** Firmware's accepted subtrim range, `sesame-firmware-main.ino:851`. */
export const SUBTRIM_RANGE_DEG = Object.freeze({ min: -90, max: 90 });

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/** Thrown by {@link parseCalibration} when the data breaks the contract. */
export class CalibrationValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`calibration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CalibrationValidationError';
    this.problems = problems;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Wording that would let a `measured: false` field read as an observation.
 * Checked against `method` and `source`, because the type system cannot police
 * prose and prose is what a reader actually sees.
 */
const MEASUREMENT_CLAIM_PATTERN =
  /\b(measured on|as measured|observed on|verified on|calibrated on)\b/i;

/**
 * Negated wording — "NOT MEASURED on any robot" — is the honest phrasing this
 * project uses everywhere, so it is stripped before the claim test above runs.
 */
const NEGATED_MEASUREMENT =
  /\b(not|never|nobody\s+has|no\s+one\s+has|cannot\s+be|un)\s*(been\s+)?(measured|observed|verified|calibrated)/gi;

const claimsObservation = (text: string): RegExpExecArray | null =>
  MEASUREMENT_CLAIM_PATTERN.exec(text.replace(NEGATED_MEASUREMENT, ' '));

/** Options for {@link parseCalibration}. */
export interface ParseCalibrationOptions {
  /**
   * Cross-check every carried-forward per-joint value against the joint map it
   * layers over. Strongly recommended, and what the CLI validator does: it is
   * the mechanism that stops a value drifting without a measurement claim.
   */
  readonly jointMap?: JointMapView;
}

function checkField(
  problems: string[],
  path: string,
  raw: unknown,
  sessionPresent: boolean,
): boolean {
  const bad = (m: string): void => { problems.push(`${path}: ${m}`); };
  if (!isRecord(raw)) { bad('must be an object'); return false; }
  if (!('value' in raw)) bad('must have a `value`');
  if (!nonEmptyString(raw['method'])) bad('must state a `method`');
  if (!nonEmptyString(raw['checklistStep'])) bad('must name the `checklistStep` that would settle it');
  if (!Array.isArray(raw['closesIssues'])) bad('`closesIssues` must be an array');

  if (raw['measured'] === false) {
    if (!nonEmptyString(raw['source'])) bad('a carried-forward value must name its `source`');
    if (!Array.isArray(raw['wouldBeConfirmedBy']) || raw['wouldBeConfirmedBy'].length === 0) {
      bad('a carried-forward value must say what `wouldBeConfirmedBy` it');
    }
    for (const key of ['measuredAt', 'measuredBy', 'robotSerial', 'instrument'] as const) {
      if (key in raw) bad(`a carried-forward value must not carry \`${key}\` — nothing was measured`);
    }
    for (const key of ['method', 'source'] as const) {
      const text = raw[key];
      const hit = typeof text === 'string' ? claimsObservation(text) : null;
      if (hit !== null) {
        bad(`\`${key}\` claims an observation ("${hit[0]}") on a value marked measured:false`);
      }
    }
    return true;
  }

  if (raw['measured'] === true) {
    for (const key of ['measuredAt', 'measuredBy', 'robotSerial', 'instrument'] as const) {
      if (!nonEmptyString(raw[key])) {
        bad(`a measured value must name \`${key}\`. Promoting a guess is a claim about a specific robot, not a data edit.`);
      }
    }
    const at = raw['measuredAt'];
    if (typeof at === 'string' && Number.isNaN(Date.parse(at))) {
      bad('`measuredAt` must be an ISO-8601 timestamp');
    }
    if ('wouldBeConfirmedBy' in raw) bad('a measured value must not carry `wouldBeConfirmedBy` — it has been confirmed');
    if (!sessionPresent) {
      bad('a measured value requires `session` to be present. A measurement with no session has no robot, no operator and no date.');
    }
    return true;
  }

  bad('`measured` must be the literal true or false');
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Validate an untrusted value against the calibration contract and return it
 * typed.
 *
 * Enforced here (the exhaustive check is `pnpm validate:calibration`):
 *
 * - eight joints, in `JOINT_ORDER`, indices matching positions;
 * - every field present, with a `method`, a `checklistStep` and issue links;
 * - `measured: false` ⇒ no session attribution, a `source`, a non-empty
 *   `wouldBeConfirmedBy`, and prose that does not claim an observation;
 * - `measured: true` ⇒ a timestamp, an operator, a **robot serial**, an
 *   instrument, and a `session`;
 * - subtrim inside the firmware's −90…+90;
 * - `meta.calibrationStatus` and `meta.measuredFieldCount` **recomputed**, not
 *   trusted;
 * - with `options.jointMap`: every carried-forward `directionSign`,
 *   `rotationSenseSign` and `zeroReferenceDeg` still equals the joint map's,
 *   so a default cannot drift without becoming a measurement claim.
 */
export function parseCalibration(
  value: unknown,
  options: ParseCalibrationOptions = {},
): Calibration {
  const problems: string[] = [];
  const bad = (m: string): void => { problems.push(m); };

  if (!isRecord(value)) throw new CalibrationValidationError(['calibration is not an object']);

  for (const key of ['meta', 'session', 'joints', 'robot', 'unresolved'] as const) {
    if (!(key in value)) bad(`missing top-level key "${key}"`);
  }

  const meta = value['meta'];
  if (!isRecord(meta)) bad('meta must be an object');

  const session = value['session'];
  const sessionPresent = isRecord(session);
  if (session !== null && !sessionPresent) bad('session must be an object or null');
  if (sessionPresent) {
    for (const key of ['robotSerial', 'performedBy', 'startedAt'] as const) {
      if (!nonEmptyString(session[key])) bad(`session.${key} must be a non-empty string`);
    }
  }

  const joints = value['joints'];
  if (!Array.isArray(joints)) {
    throw new CalibrationValidationError([...problems, 'joints is not an array']);
  }
  if (joints.length !== JOINT_ORDER.length) {
    bad(`expected ${JOINT_ORDER.length} joints, found ${joints.length}`);
  }

  let measuredCount = 0;
  const noteMeasured = (raw: unknown): void => {
    if (isRecord(raw) && raw['measured'] === true) measuredCount += 1;
  };

  joints.forEach((raw: unknown, i: number) => {
    if (!isRecord(raw)) { bad(`joints[${i}] is not an object`); return; }
    const name = raw['firmwareName'];
    const expected = JOINT_ORDER[i];
    if (!isJointName(name)) {
      bad(`joints[${i}].firmwareName "${String(name)}" is not a Sesame joint name`);
      return;
    }
    if (expected !== undefined && name !== expected) {
      bad(`joints[${i}] is "${name}" but firmware order requires "${expected}". Calibration is keyed on the servo channel; re-sorting it recalibrates the wrong motor.`);
    }
    if (raw['firmwareIndex'] !== i) {
      bad(`joints[${i}] (${name}) has firmwareIndex ${String(raw['firmwareIndex'])}; array position and firmware index must agree`);
    }

    for (const field of CALIBRATION_JOINT_FIELDS) {
      const f = raw[field];
      if (!(field in raw)) { bad(`${name}: missing field "${field}"`); continue; }
      checkField(problems, `${name}.${field}`, f, sessionPresent);
      noteMeasured(f);
    }

    const sign = isRecord(raw['directionSign']) ? raw['directionSign']['value'] : undefined;
    if (sign !== 1 && sign !== -1) bad(`${name}: directionSign.value must be 1 or -1`);
    const sense = isRecord(raw['rotationSenseSign']) ? raw['rotationSenseSign']['value'] : undefined;
    if (sense !== 1 && sense !== -1) bad(`${name}: rotationSenseSign.value must be 1 or -1`);

    const subtrim = isRecord(raw['servoSubtrimDeg']) ? raw['servoSubtrimDeg']['value'] : undefined;
    if (typeof subtrim !== 'number' || !Number.isFinite(subtrim)) {
      bad(`${name}: servoSubtrimDeg.value must be a finite number`);
    } else if (subtrim < SUBTRIM_RANGE_DEG.min || subtrim > SUBTRIM_RANGE_DEG.max) {
      bad(`${name}: servoSubtrimDeg ${subtrim} is outside the firmware's ${SUBTRIM_RANGE_DEG.min}..${SUBTRIM_RANGE_DEG.max} (sesame-firmware-main.ino:851)`);
    }

    const zero = isRecord(raw['zeroReferenceDeg']) ? raw['zeroReferenceDeg']['value'] : undefined;
    if (typeof zero !== 'number' || zero < 0 || zero > 180) {
      bad(`${name}: zeroReferenceDeg.value must be a number inside the firmware clamp 0..180`);
    }

    // Carried-forward values may not drift from the design they layer over.
    const map = options.jointMap;
    if (map !== undefined && isJointName(name)) {
      const entry = map.get(name);
      const designSense = /=\s*([+-]?1)\s*\*/.exec(entry.directionSign.absoluteSense?.rule ?? '');
      const expectations: readonly (readonly [CalibrationJointField, unknown])[] = [
        ['directionSign', entry.directionSign.value],
        ['zeroReferenceDeg', entry.zeroReferenceDeg.value],
        ['mechanicalLimitsDeg', entry.angleLimitsDeg.mechanicalLimitsDeg],
        ['servoSubtrimDeg', CALIBRATION_DEFAULTS.servoSubtrimDeg],
        ['hornSplineOffsetDeg', CALIBRATION_DEFAULTS.hornSplineOffsetDeg],
        ...(designSense === null
          ? []
          : ([['rotationSenseSign', Number(designSense[1])]] as const)),
      ];
      for (const [field, want] of expectations) {
        const f = raw[field];
        if (!isRecord(f) || f['measured'] !== false) continue;
        if (!sameValue(f['value'], want)) {
          bad(`${name}.${field}: a carried-forward value must equal the design value it layers over (${JSON.stringify(want)}), found ${JSON.stringify(f['value'])}. Change it only by marking it measured:true with a robot serial.`);
        }
      }
    }
  });

  const robot = value['robot'];
  if (!isRecord(robot)) bad('robot must be an object');
  else {
    for (const field of CALIBRATION_ROBOT_FIELDS) {
      const f = robot[field];
      if (!(field in robot)) { bad(`robot: missing field "${field}"`); continue; }
      checkField(problems, `robot.${field}`, f, sessionPresent);
      noteMeasured(f);
    }
    const defaults: readonly (readonly [CalibrationRobotField, unknown])[] = [
      ['servoModel', CALIBRATION_DEFAULTS.servoModel],
      ['hornSplineTeeth', CALIBRATION_DEFAULTS.hornSplineTeeth],
      ['angleGainDegPerCommandedDeg', CALIBRATION_DEFAULTS.angleGainDegPerCommandedDeg],
      ['slewDegPerSec', CALIBRATION_DEFAULTS.slewDegPerSec],
      ['powerOnCommandedDeg', CALIBRATION_DEFAULTS.powerOnCommandedDeg],
      ['walkDirectionMatchesDrawnFront', null],
      ['oledActivePlaneMm', CALIBRATION_DEFAULTS.oledActivePlaneMm],
      ['spinQuantumMs', CALIBRATION_DEFAULTS.spinQuantumMs],
      ['loopQuantumMs', CALIBRATION_DEFAULTS.loopQuantumMs],
    ];
    for (const [field, want] of defaults) {
      const f = robot[field];
      if (!isRecord(f) || f['measured'] !== false) continue;
      if (!sameValue(f['value'], want)) {
        bad(`robot.${field}: a carried-forward value must equal today's documented default (${JSON.stringify(want)}), found ${JSON.stringify(f['value'])}. Change it only by marking it measured:true with a robot serial.`);
      }
    }
  }

  // meta.calibrationStatus is recomputed, never trusted.
  if (isRecord(meta)) {
    const expectedStatus =
      measuredCount === 0 ? 'uncalibrated'
        : measuredCount === CALIBRATION_FIELD_COUNT ? 'complete'
          : 'partial';
    if (meta['calibrationStatus'] !== expectedStatus) {
      bad(`meta.calibrationStatus says "${String(meta['calibrationStatus'])}" but ${measuredCount} of ${CALIBRATION_FIELD_COUNT} fields are measured, which is "${expectedStatus}"`);
    }
    if (meta['measuredFieldCount'] !== measuredCount) {
      bad(`meta.measuredFieldCount says ${String(meta['measuredFieldCount'])}, recomputed ${measuredCount}`);
    }
    if (meta['totalFieldCount'] !== CALIBRATION_FIELD_COUNT) {
      bad(`meta.totalFieldCount says ${String(meta['totalFieldCount'])}, expected ${CALIBRATION_FIELD_COUNT}`);
    }
    if (measuredCount > 0 && !sessionPresent) {
      bad('meta claims measured fields but session is null');
    }
  }

  if (!Array.isArray(value['unresolved'])) bad('unresolved must be an array');

  if (problems.length > 0) throw new CalibrationValidationError(problems);
  return value as unknown as Calibration;
}

// ---------------------------------------------------------------------------
// Semantic names, one layer up
// ---------------------------------------------------------------------------

/**
 * What we know about a joint's spatial name once calibration is taken into
 * account.
 *
 * The `"guess"` branch deliberately exposes no string. It carries the joint
 * map's {@link UnverifiedSemanticName} record, which still has to be read
 * through `readGuessedSemanticName`.
 */
export type SemanticNameStatus =
  | {
    readonly kind: 'guess';
    readonly guess: UnverifiedSemanticName | undefined;
  }
  | {
    readonly kind: 'confirmed';
    /** Safe to display as a fact: a named person checked a named robot. */
    readonly value: string;
    readonly confirmation: MeasuredValue<PartIdentityObservation | null>;
  }
  | {
    readonly kind: 'contradicted';
    /** The name actually engraved on the part found on this channel. */
    readonly engravedName: string | null;
    readonly guess: UnverifiedSemanticName | undefined;
    readonly confirmation: MeasuredValue<PartIdentityObservation | null>;
  };

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/** The subset of `SimulatedRobotOptions` this layer owns. Structurally typed on purpose. */
export interface CalibrationSimOptions {
  /** `servoSubtrim[]`, in firmware channel order. */
  readonly subtrimDeg: readonly number[];
  /** `commandedDeg` for a channel never written. */
  readonly powerOnDeg: number;
  /** `simulatedDeg` slew, or `null`. */
  readonly slewDegPerSec: number | null;
  /** `pressingCheck()` period. */
  readonly spinQuantumMs: number;
  /** `loop()` period. */
  readonly loopQuantumMs: number;
}

/** Per-joint numbers a 3D rig needs to pose a calibrated robot. */
export interface JointRigCalibration {
  readonly joint: JointName;
  readonly rotationSenseSign: 1 | -1;
  readonly zeroReferenceDeg: number;
  readonly servoSubtrimDeg: number;
  readonly hornSplineOffsetDeg: number;
  readonly angleGainDegPerCommandedDeg: number;
}

/** How many fields in each epistemic state. */
export interface CalibrationSummary {
  readonly total: number;
  readonly measured: number;
  readonly carriedForward: number;
  readonly robotId: string;
  readonly status: CalibrationMeta['calibrationStatus'];
}

/**
 * A validated calibration document with lookup helpers.
 *
 * Deliberately absent, exactly as in `JointMapView`: any method that returns a
 * *guessed* spatial name as a plain string, and any method that reports a
 * carried-forward value as an observation.
 */
export class CalibrationView {
  readonly data: Calibration;
  readonly #byName: ReadonlyMap<JointName, CalibrationJointEntry>;

  private constructor(data: Calibration) {
    this.data = data;
    this.#byName = new Map(data.joints.map((j) => [j.firmwareName, j]));
  }

  /** Validate untrusted data and wrap it. Throws {@link CalibrationValidationError}. */
  static parse(value: unknown, options: ParseCalibrationOptions = {}): CalibrationView {
    return new CalibrationView(parseCalibration(value, options));
  }

  /** The eight entries, in firmware order. */
  get joints(): readonly CalibrationJointEntry[] {
    return this.data.joints;
  }

  /** Which robot this document describes. `"reference-uncalibrated"` for the shipped one. */
  get robotId(): string {
    return this.data.meta.robotId;
  }

  /** `true` when nothing in the document has been measured. */
  get isUncalibrated(): boolean {
    return this.data.meta.calibrationStatus === 'uncalibrated';
  }

  get(joint: JointName): CalibrationJointEntry {
    const entry = this.#byName.get(joint);
    if (entry === undefined) throw new Error(`calibration has no entry for ${joint}`);
    return entry;
  }

  /** The raw field record, so a caller can inspect its epistemic state. */
  field<F extends CalibrationJointField>(
    joint: JointName,
    field: F,
  ): CalibrationJointEntry[F] {
    return this.get(joint)[field];
  }

  /** The raw whole-robot field record. */
  robotField<F extends CalibrationRobotField>(field: F): CalibrationRobotEntry[F] {
    return this.data.robot[field];
  }

  /** `servoSubtrim[joint]`, in degrees. */
  subtrimDegFor(joint: JointName): number {
    return this.get(joint).servoSubtrimDeg.value;
  }

  /** The commanded degree this joint treats as zero. */
  zeroReferenceDegFor(joint: JointName): number {
    return this.get(joint).zeroReferenceDeg.value;
  }

  /** The bookkeeping sign for the body-relative formula. */
  directionSignFor(joint: JointName): 1 | -1 {
    return this.get(joint).directionSign.value;
  }

  /** The physical rotation sense about the joint axis. */
  rotationSenseSignFor(joint: JointName): 1 | -1 {
    return this.get(joint).rotationSenseSign.value;
  }

  /**
   * What the firmware would actually hand the servo library:
   * `constrain(requestedDeg + servoSubtrim[channel], 0, 180)`.
   *
   * Subtrim is applied **before** the clamp, exactly as at
   * `sesame-firmware-main.ino:1053`, so a trimmed channel saturates on a
   * request that is legal untrimmed.
   */
  appliedCommandedDeg(joint: JointName, requestedDeg: number, clamp = { min: 0, max: 180 }): number {
    const withTrim = requestedDeg + this.subtrimDegFor(joint);
    return Math.min(clamp.max, Math.max(clamp.min, withTrim));
  }

  /**
   * The rotation a 3D rig should apply to this joint's node, in degrees about
   * its own axis, for a given *requested* angle.
   *
   * `sense × gain × (applied − zero) + hornOffset`. With the shipped defaults
   * (subtrim 0, zero 90, gain 1, offset 0) this is exactly V2's baked rule,
   * `signPerCommandedDeg × (commandedDeg − 90)`, so nothing moves until
   * somebody calibrates.
   */
  rigRotationDeg(joint: JointName, requestedDeg: number): number {
    const applied = this.appliedCommandedDeg(joint, requestedDeg);
    const gain = this.data.robot.angleGainDegPerCommandedDeg.value;
    const zero = this.zeroReferenceDegFor(joint);
    const sense = this.rotationSenseSignFor(joint);
    const offset = this.get(joint).hornSplineOffsetDeg.value;
    const deg = sense * gain * (applied - zero) + offset;
    return deg === 0 ? 0 : deg;
  }

  /**
   * `(commandedDeg − zero) × directionSign`, with the calibrated zero and sign.
   * The calibrated twin of `JointMapView.toBodyRelativeDeg`.
   */
  toBodyRelativeDeg(joint: JointName, commandedDeg: number): number {
    const deg = (commandedDeg - this.zeroReferenceDegFor(joint)) * this.directionSignFor(joint);
    return deg === 0 ? 0 : deg;
  }

  /** Inverse of {@link CalibrationView.toBodyRelativeDeg}. */
  toCommandedDeg(joint: JointName, bodyRelativeDeg: number): number {
    return bodyRelativeDeg * this.directionSignFor(joint) + this.zeroReferenceDegFor(joint);
  }

  /**
   * The worst-case angular error the horn spline can contribute, in degrees:
   * half of `360 / hornSplineTeeth`. 9° on a 20-tooth MG90S output shaft.
   */
  get hornSplineQuantumDeg(): number {
    return 360 / this.data.robot.hornSplineTeeth.value;
  }

  /**
   * The subset of `SimulatedRobotOptions` this layer owns, ready to spread into
   * a `new SimulatedSesameRobot({ ...calibration.toSimOptions() })`.
   *
   * Structurally typed rather than imported: `@sesame-lab/sesame-model` is a
   * dependency *of* `@sesame-lab/sesame-sim`, so it must not depend back on it.
   */
  toSimOptions(): CalibrationSimOptions {
    return {
      subtrimDeg: JOINT_ORDER.map((j) => this.subtrimDegFor(j)),
      powerOnDeg: this.data.robot.powerOnCommandedDeg.value,
      slewDegPerSec: this.data.robot.slewDegPerSec.value,
      spinQuantumMs: this.data.robot.spinQuantumMs.value,
      loopQuantumMs: this.data.robot.loopQuantumMs.value,
    };
  }

  /** The per-joint numbers a viewer needs, in firmware order. */
  toRigCalibration(): readonly JointRigCalibration[] {
    const gain = this.data.robot.angleGainDegPerCommandedDeg.value;
    return JOINT_ORDER.map((joint) => ({
      joint,
      rotationSenseSign: this.rotationSenseSignFor(joint),
      zeroReferenceDeg: this.zeroReferenceDegFor(joint),
      servoSubtrimDeg: this.subtrimDegFor(joint),
      hornSplineOffsetDeg: this.get(joint).hornSplineOffsetDeg.value,
      angleGainDegPerCommandedDeg: gain,
    }));
  }

  /**
   * The spatial name's status, taking calibration into account.
   *
   * The joint map can only ever say `verified: false` — it describes the
   * design, and the design cannot know which printed part a builder bolted
   * where. A `partIdentity` measurement is the *only* thing that can promote
   * one, and it does so here rather than by editing `joint-map.json`.
   */
  semanticNameFor(joint: JointName, jointMap?: JointMapView): SemanticNameStatus {
    const guess = jointMap?.semanticGuessFor(joint);
    const identity = this.get(joint).partIdentity;
    if (!identity.measured || identity.value === null) {
      return { kind: 'guess', guess };
    }
    if (!identity.value.matchesFirmwareName) {
      return {
        kind: 'contradicted',
        engravedName: identity.value.engravedName,
        guess,
        confirmation: identity,
      };
    }
    const value = readGuessedSemanticName(guess, SEMANTIC_NAME_IS_A_GUESS);
    if (value === undefined) return { kind: 'guess', guess };
    return { kind: 'confirmed', value, confirmation: identity };
  }

  /** Every field, flattened, for reporting. */
  allFields(): readonly { readonly path: string; readonly field: CalibratedValue<unknown> }[] {
    const out: { path: string; field: CalibratedValue<unknown> }[] = [];
    for (const j of this.data.joints) {
      for (const f of CALIBRATION_JOINT_FIELDS) {
        out.push({ path: `joints.${j.firmwareName}.${f}`, field: j[f] as CalibratedValue<unknown> });
      }
    }
    for (const f of CALIBRATION_ROBOT_FIELDS) {
      out.push({ path: `robot.${f}`, field: this.data.robot[f] as CalibratedValue<unknown> });
    }
    return out;
  }

  /** Counts by epistemic state. */
  summary(): CalibrationSummary {
    const all = this.allFields();
    const measured = all.filter((f) => f.field.measured).length;
    return {
      total: all.length,
      measured,
      carriedForward: all.length - measured,
      robotId: this.robotId,
      status: this.data.meta.calibrationStatus,
    };
  }

  /** Everything still unmeasured, with the checklist step that would settle it. */
  outstanding(): readonly { readonly path: string; readonly checklistStep: string; readonly closesIssues: readonly string[] }[] {
    return this.allFields()
      .filter((f) => !f.field.measured)
      .map((f) => ({
        path: f.path,
        checklistStep: f.field.checklistStep,
        closesIssues: f.field.closesIssues,
      }));
  }
}

// ---------------------------------------------------------------------------
// Overriding at run time
// ---------------------------------------------------------------------------

/**
 * A partial override, keyed the same way the document is.
 *
 * This is what a live calibration UI produces: a handful of numbers, not a
 * whole document.
 */
export interface CalibrationOverride {
  readonly robotId?: string;
  readonly session?: CalibrationSession;
  readonly joints?: Partial<Record<JointName, Partial<Record<CalibrationJointField, CalibratedValue<unknown>>>>>;
  readonly robot?: Partial<Record<CalibrationRobotField, CalibratedValue<unknown>>>;
}

/**
 * Layer an override onto a base calibration and revalidate.
 *
 * Field-level, not document-level: an override that touches `R4.servoSubtrimDeg`
 * leaves the other 71 fields exactly as they were, including their provenance.
 * The result goes back through {@link parseCalibration}, so an override cannot
 * smuggle in a value that the base document could not have carried.
 */
export function applyCalibrationOverride(
  base: Calibration,
  override: CalibrationOverride,
  options: ParseCalibrationOptions = {},
): Calibration {
  const session = override.session ?? base.session;
  const joints = base.joints.map((entry) => {
    const patch = override.joints?.[entry.firmwareName];
    if (patch === undefined) return entry;
    return { ...entry, ...patch } as CalibrationJointEntry;
  });
  const robot = { ...base.robot, ...(override.robot ?? {}) } as CalibrationRobotEntry;

  const countMeasured = (): number => {
    let n = 0;
    for (const j of joints) {
      for (const f of CALIBRATION_JOINT_FIELDS) if ((j[f] as CalibratedValue<unknown>).measured) n += 1;
    }
    for (const f of CALIBRATION_ROBOT_FIELDS) if ((robot[f] as CalibratedValue<unknown>).measured) n += 1;
    return n;
  };
  const measuredFieldCount = countMeasured();

  const next: Calibration = {
    ...base,
    meta: {
      ...base.meta,
      robotId: override.robotId ?? session?.robotSerial ?? base.meta.robotId,
      measuredFieldCount,
      calibrationStatus:
        measuredFieldCount === 0 ? 'uncalibrated'
          : measuredFieldCount === CALIBRATION_FIELD_COUNT ? 'complete'
            : 'partial',
    },
    session,
    joints,
    robot,
  };
  return parseCalibration(next, options);
}

/**
 * Serialise a calibration document the way `hardware/calibration.json` is
 * written: two-space indent, trailing newline, keys in document order.
 *
 * This is the engine behind an "export calibration" button. It revalidates
 * first, so a UI cannot emit a document the loader would reject.
 */
export function serializeCalibration(
  calibration: Calibration,
  options: ParseCalibrationOptions = {},
): string {
  return `${JSON.stringify(parseCalibration(calibration, options), null, 2)}\n`;
}
