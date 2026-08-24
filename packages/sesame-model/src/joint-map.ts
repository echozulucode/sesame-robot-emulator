/**
 * Types, runtime validator and typed accessors for `hardware/joint-map.json`.
 *
 * The file is data; this module is the contract. The contract's job is to make
 * the three-way epistemic distinction survive contact with application code:
 *
 * - **authoritative** — read out of firmware source or the STEP file
 *   (`firmwareName`, `firmwareIndex`, `kind`, `pinsByBoard`, the 0–180 clamp).
 * - **inferred** — derived, always with a `method` and a confidence
 *   (`rotationAxis`, `pivotOrigin`, `zeroReferenceDeg`, `directionSign`,
 *   `observedRangeDeg`).
 * - **guessed** — `semanticName`, which carries `verified: false` and is
 *   structurally prevented from ever being read as a plain authoritative name.
 *
 * Nothing in the joint map has been checked against a physical robot.
 */
import {
  JOINT_ORDER,
  isJointName,
  type JointIndex,
  type JointKind,
  type JointName,
  type ShapeEquivalenceClass,
} from './joints.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The three-way epistemic distinction, as it appears in the data. */
export type FactStatus = 'authoritative' | 'inferred' | 'guessed';

/** Confidence attached to an inferred value. */
export type Confidence = 'high' | 'medium' | 'low' | 'none';

/** Board configurations present in firmware. Exactly one (`s2-mini`) is active. */
export type BoardId = 's2-mini' | 'distro-v3' | 'distro-v2' | 'distro-v1';

/** Provenance pointer into the upstream firmware tree. */
export interface SourceRef {
  readonly file: string;
  readonly line: number;
}

/** Provenance pointer into the CAD master. */
export interface CadSourceRef {
  readonly file: string;
  readonly symbol: string;
  readonly note: string;
}

/** A 3-vector in the STL assembly frame, in millimetres (or unitless for axes). */
export type Vec3 = readonly [number, number, number];

/** An inclusive degree interval. */
export interface DegreeRange {
  readonly min: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// The guess barrier
// ---------------------------------------------------------------------------

/**
 * A spatial name for a joint that **has not been verified against a physical
 * robot**.
 *
 * This is deliberately not a `string`. `verified` is the literal type `false`,
 * so `if (n.verified) { … }` narrows the body to `never` and TypeScript will
 * tell you that the branch is dead: there is no code path in which this name
 * is trustworthy. Promoting a guess to a fact requires changing this type, the
 * JSON Schema and the validator together — it cannot be done by editing data.
 *
 * @see readGuessedSemanticName for the (deliberately awkward) way to get at the
 * string.
 */
export interface UnverifiedSemanticName {
  /**
   * The guessed spatial name, e.g. `"right_front_hip"`.
   *
   * Do not key anything on this, do not persist it, do not send it over a wire
   * protocol, and do not display it without saying it is unverified. Key on
   * {@link JointMapEntry.firmwareName} instead.
   */
  readonly value: string;
  /** Always `false`. There is no verified variant of this type. */
  readonly verified: false;
  /** What the guess rests on, in prose. Never empty. */
  readonly basis: string;
  /** The individual evidence points behind `basis`. */
  readonly basisPoints: readonly string[];
  /** Exactly what would settle it. This is the Phase-1 verification task list. */
  readonly wouldBeConfirmedBy: readonly string[];
  /** Other names that were considered and why the chosen one won. */
  readonly alternativesConsidered: readonly string[];
  readonly alternativesNote: string;
}

/**
 * Token required by {@link readGuessedSemanticName}.
 *
 * You have to import this and pass it explicitly, which means the call site
 * literally reads "semantic name is a guess". That is the point.
 */
export const SEMANTIC_NAME_IS_A_GUESS = Symbol.for(
  '@sesame-lab/sesame-model:semantic-name-is-a-guess',
);
export type SemanticGuessAcknowledgement = typeof SEMANTIC_NAME_IS_A_GUESS;

/**
 * Extract the raw string out of an {@link UnverifiedSemanticName}, for display
 * only, having acknowledged that it is a guess.
 *
 * ```ts
 * const label = readGuessedSemanticName(entry.semanticName, SEMANTIC_NAME_IS_A_GUESS);
 * ```
 */
export function readGuessedSemanticName(
  name: UnverifiedSemanticName | undefined,
  acknowledgement: SemanticGuessAcknowledgement,
): string | undefined {
  if (acknowledgement !== SEMANTIC_NAME_IS_A_GUESS) {
    throw new TypeError('readGuessedSemanticName requires SEMANTIC_NAME_IS_A_GUESS');
  }
  return name?.value;
}

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

export interface RotationAxis {
  readonly value: Vec3;
  readonly frame: 'stl-assembly';
  readonly status: 'inferred';
  readonly axisConfidence: Confidence;
  readonly method: string;
  readonly note: string;
}

export interface PivotOrigin {
  readonly value: Vec3;
  readonly frame: 'stl-assembly';
  readonly status: 'inferred';
  readonly originConfidence: Confidence;
  /**
   * Always says, in these words, that this is **not the joint centre**. The
   * axis line is measured; the position along it is not, because nothing in the
   * printed plastic marks the servo datum plane.
   */
  readonly caveat: string;
  readonly method: string;
}

export interface LinkGeometry {
  readonly status: 'inferred';
  readonly axisAngleDeg: number;
  readonly commonNormalDistanceMm: number;
  readonly distalAxis: Vec3;
  readonly distalOrigin: Vec3;
  readonly note: string;
}

export interface ParentLink {
  /** `"internal-frame"` for a femur; the mating femur's name for a foot. */
  readonly value: 'internal-frame' | JointName;
  readonly status: FactStatus;
  readonly basis: string;
  /** The foot this femur drives, or `null` for a foot (feet are leaves). */
  readonly childLink: JointName | null;
  readonly caveat?: string;
}

export interface ZeroReference {
  readonly value: number;
  readonly status: 'inferred';
  readonly basis: readonly string[];
  readonly caveat: string;
  readonly restPoseDeg: number;
  readonly standPoseDeg: number;
}

/**
 * The **physical** rotation sense of a joint about its axis, recovered by V0
 * from the CAD servo-horn occurrences.
 *
 * Distinct from {@link DirectionSign.value}, which is a bookkeeping convention
 * for the body-relative formula and says nothing about which way anything
 * turns. `rule` reads `childRotationDeg = ±1 * (commandedDeg - 90)`.
 *
 * This is the **design** sense. A built robot adds horn-spline quantisation and
 * per-robot subtrim on top of it; both live in `hardware/calibration.json`.
 */
export interface AbsoluteRotationSense {
  readonly status: 'inferred';
  readonly frame: string;
  readonly rule: string;
  readonly axisUnitVector: Vec3;
  readonly rotatesRelativeTo: string;
  readonly source: string;
  readonly method: string;
  readonly dependsOn: string;
  readonly caveat: string;
}

export interface DirectionSign {
  readonly value: 1 | -1;
  readonly status: 'inferred';
  readonly convention: string;
  readonly basis: readonly string[];
  readonly caveat: string;
  /** Added by V0. Absent in joint-map v1.0.0 documents. */
  readonly absoluteSense?: AbsoluteRotationSense;
}

export interface AngleLimits {
  /** The firmware clamp. Authoritative, and *not* a mechanical travel limit. */
  readonly value: DegreeRange;
  readonly status: 'authoritative';
  readonly source: SourceRef;
  readonly call: string;
  readonly note: string;
  /** `null` until a physical robot or a collision study establishes it. */
  readonly mechanicalLimitsDeg: DegreeRange | null;
  readonly mechanicalLimitsNote: string;
}

/** One `(degrees, count)` bucket from the real choreography. */
export interface AngleHistogramBucket {
  readonly deg: number;
  readonly count: number;
}

/**
 * What the shipped choreography actually asks of this joint.
 *
 * Strong evidence about the range the firmware authors consider safe. No
 * evidence at all about the range the mechanism can reach.
 */
export interface ObservedRange {
  readonly status: 'inferred';
  readonly method: string;
  readonly corpus: {
    readonly functions: number;
    readonly totalSteps: number;
    readonly servoSteps: number;
  };
  readonly sampleCount: number;
  readonly functionsCommandingThisJoint: number;
  readonly minDeg: number;
  readonly maxDeg: number;
  readonly medianDeg: number;
  readonly distinctCommandedDeg: readonly AngleHistogramBucket[];
  readonly bodyRelativeMinDeg: number;
  readonly bodyRelativeMaxDeg: number;
  readonly note: string;
}

/** One joint's complete description. */
export interface JointMapEntry {
  /** Authoritative identity. Key everything on this. */
  readonly firmwareName: JointName;
  /** Authoritative identity. Equals the array position in `joints`. */
  readonly firmwareIndex: JointIndex;
  readonly firmwareIndexStatus: 'authoritative';
  readonly firmwareIndexSource: SourceRef;
  readonly firmwareIndexNote: string;

  /** Authoritative: the STEP file names the parts `femur-joint-*` / `foot-joint-*`. */
  readonly kind: JointKind;
  readonly kindStatus: 'authoritative';
  readonly kindSource: CadSourceRef;

  readonly pinsByBoard: Readonly<Record<BoardId, number>>;
  readonly pinsStatus: 'authoritative';
  readonly pinSourceByBoard: Readonly<Record<BoardId, SourceRef>>;
  readonly pinsNote: string;

  readonly stlFile: string;
  readonly stlPath: string;
  readonly stlSha256: string;

  readonly shapeEquivalenceClass: ShapeEquivalenceClass;
  readonly shapeEquivalenceStatus: FactStatus;
  readonly shapeEquivalenceMethod: string;

  readonly rotationAxis: RotationAxis;
  readonly pivotOrigin: PivotOrigin;
  /** Femurs only: the two-axis link between the hip servo and the leg servo. */
  readonly linkGeometry?: LinkGeometry;
  readonly parentLink: ParentLink;

  readonly zeroReferenceDeg: ZeroReference;
  readonly directionSign: DirectionSign;
  readonly angleLimitsDeg: AngleLimits;
  readonly observedRangeDeg: ObservedRange;

  /** Optional by design, and never authoritative. See {@link UnverifiedSemanticName}. */
  readonly semanticName?: UnverifiedSemanticName;

  readonly unresolved: readonly string[];
}

export interface ShapeClassEntry {
  readonly id: ShapeEquivalenceClass;
  readonly kind: JointKind;
  readonly members: readonly [JointName, JointName];
  readonly relation: 'identical solids';
  readonly mirrorOf: ShapeEquivalenceClass;
  readonly status: FactStatus;
  readonly evidence: string;
}

export interface UnresolvedEntry {
  readonly id: string;
  readonly subject: string;
  readonly carriedForwardFrom: 'F4' | 'F5' | 'F6';
  readonly status: 'open' | 'partially-resolved';
  readonly reason: string;
  readonly resolvedBy: string;
  readonly blocking: boolean;
}

export interface JointMapMeta {
  readonly schemaVersion: string;
  readonly jointMapVersion: string;
  readonly task: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly regenerateWith: string;
  readonly validateWith: string;
  readonly epistemicContract: string;
  readonly verificationStatus: string;
  readonly sources: readonly {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly role: string;
    readonly producedBy: string;
  }[];
  readonly consumers: readonly string[];
}

export interface JointMapConventions {
  readonly angleUnit: 'degree';
  readonly lengthUnit: 'millimetre';
  readonly lengthUnitStatus: FactStatus;
  readonly lengthUnitSource: string;
  readonly coordinateFrame: {
    readonly id: 'stl-assembly';
    readonly status: FactStatus;
    readonly upAxis: string;
    readonly upAxisConfidence: Confidence;
    readonly lateralAxis: string;
    readonly lateralAxisConfidence: Confidence;
    readonly foreAftAxis: string | null;
    readonly foreAftAxisNote: string;
    readonly caveat: string;
  };
  readonly commandedAngle: {
    readonly domain: DegreeRange;
    readonly status: 'authoritative';
    readonly source: SourceRef;
    readonly call: string;
    readonly note: string;
  };
  readonly bodyRelativeAngle: {
    readonly formula: string;
    readonly status: 'inferred';
    readonly purpose: string;
    readonly caveat: string;
  };
}

export interface ChoreographyAnalysis {
  readonly status: 'inferred';
  readonly corpus: {
    readonly source: string;
    readonly functions: number;
    readonly totalSteps: number;
    readonly servoSteps: number;
    readonly note: string;
  };
  readonly method: string;
  readonly findings: readonly string[];
  readonly caveat: string;
}

/** The whole of `hardware/joint-map.json`. */
export interface JointMap {
  readonly meta: JointMapMeta;
  readonly conventions: JointMapConventions;
  readonly shapeEquivalenceClasses: readonly ShapeClassEntry[];
  readonly shapeEquivalenceNote: string;
  readonly choreographyAnalysis: ChoreographyAnalysis;
  /** In firmware order, always. */
  readonly joints: readonly JointMapEntry[];
  readonly unresolved: readonly UnresolvedEntry[];
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/** Thrown by {@link parseJointMap} when the data does not satisfy the contract. */
export class JointMapValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`joint map is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'JointMapValidationError';
    this.problems = problems;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const BOARDS: readonly BoardId[] = ['s2-mini', 'distro-v3', 'distro-v2', 'distro-v1'];

/**
 * Validate an untrusted value against the joint-map contract and return it
 * typed.
 *
 * This is a structural check plus the invariants that actually matter, not a
 * full JSON Schema implementation — `pnpm validate:joint-map` is the exhaustive
 * check and runs in CI. What is enforced here is everything a consumer could be
 * hurt by at runtime:
 *
 * - eight joints, in firmware order, indices matching positions
 * - a pin for every board configuration
 * - the femur/foot parent-child graph is a bijection with no cycles
 * - every `zeroReferenceDeg` and observed angle lies inside the joint's clamp
 * - **every `semanticName` carries `verified: false`**
 */
export function parseJointMap(value: unknown): JointMap {
  const problems: string[] = [];
  const bad = (m: string): void => { problems.push(m); };

  if (!isRecord(value)) throw new JointMapValidationError(['joint map is not an object']);

  for (const key of ['meta', 'conventions', 'shapeEquivalenceClasses', 'choreographyAnalysis', 'joints', 'unresolved'] as const) {
    if (!(key in value)) bad(`missing top-level key "${key}"`);
  }

  const joints = value['joints'];
  if (!Array.isArray(joints)) {
    throw new JointMapValidationError([...problems, 'joints is not an array']);
  }
  if (joints.length !== JOINT_ORDER.length) {
    bad(`expected ${JOINT_ORDER.length} joints, found ${joints.length}`);
  }

  const seen = new Map<string, Record<string, unknown>>();

  joints.forEach((raw: unknown, i: number) => {
    if (!isRecord(raw)) { bad(`joints[${i}] is not an object`); return; }
    const name = raw['firmwareName'];
    const expected = JOINT_ORDER[i];

    if (!isJointName(name)) { bad(`joints[${i}].firmwareName "${String(name)}" is not a Sesame joint name`); return; }
    if (expected !== undefined && name !== expected) {
      bad(`joints[${i}] is "${name}" but firmware order requires "${expected}". JOINT_ORDER is the ServoName enum; it is neither geometric nor alphabetical and must never be re-sorted.`);
    }
    if (raw['firmwareIndex'] !== i) {
      bad(`joints[${i}] (${name}) has firmwareIndex ${String(raw['firmwareIndex'])}; array position and firmware index must agree`);
    }
    if (raw['kind'] !== 'femur' && raw['kind'] !== 'foot') {
      bad(`${name}: kind must be "femur" or "foot", got ${String(raw['kind'])}`);
    }
    seen.set(name, raw);

    const pins = raw['pinsByBoard'];
    if (!isRecord(pins)) bad(`${name}: pinsByBoard is missing`);
    else {
      for (const b of BOARDS) {
        if (typeof pins[b] !== 'number') bad(`${name}: pinsByBoard is missing board "${b}"`);
      }
    }

    const limits = raw['angleLimitsDeg'];
    const clamp = isRecord(limits) && isRecord(limits['value']) ? limits['value'] : undefined;
    const min = typeof clamp?.['min'] === 'number' ? clamp['min'] : undefined;
    const max = typeof clamp?.['max'] === 'number' ? clamp['max'] : undefined;
    if (min === undefined || max === undefined) bad(`${name}: angleLimitsDeg.value must have numeric min and max`);
    if (isRecord(limits) && limits['mechanicalLimitsDeg'] !== null) {
      bad(`${name}: mechanicalLimitsDeg must be null until a physical robot or a collision study establishes it`);
    }

    const zero = raw['zeroReferenceDeg'];
    const zeroValue = isRecord(zero) && typeof zero['value'] === 'number' ? zero['value'] : undefined;
    if (zeroValue === undefined) bad(`${name}: zeroReferenceDeg.value must be a number`);
    else if (min !== undefined && max !== undefined && (zeroValue < min || zeroValue > max)) {
      bad(`${name}: zeroReferenceDeg ${zeroValue} lies outside the firmware clamp ${min}..${max}`);
    }

    const sign = raw['directionSign'];
    const signValue = isRecord(sign) ? sign['value'] : undefined;
    if (signValue !== 1 && signValue !== -1) bad(`${name}: directionSign.value must be 1 or -1, got ${String(signValue)}`);

    const observed = raw['observedRangeDeg'];
    if (!isRecord(observed)) bad(`${name}: observedRangeDeg is missing`);
    else if (min !== undefined && max !== undefined) {
      for (const k of ['minDeg', 'maxDeg'] as const) {
        const v = observed[k];
        if (typeof v !== 'number') bad(`${name}: observedRangeDeg.${k} must be a number`);
        else if (v < min || v > max) bad(`${name}: observedRangeDeg.${k} ${v} lies outside the firmware clamp ${min}..${max}`);
      }
    }

    const axis = raw['rotationAxis'];
    if (!isRecord(axis) || !Array.isArray(axis['value']) || axis['value'].length !== 3) {
      bad(`${name}: rotationAxis.value must be a 3-vector`);
    } else if (axis['status'] === 'authoritative') {
      bad(`${name}: rotationAxis is a fit to mesh geometry, it must not claim "authoritative"`);
    }

    const pivot = raw['pivotOrigin'];
    if (!isRecord(pivot) || !Array.isArray(pivot['value']) || pivot['value'].length !== 3) {
      bad(`${name}: pivotOrigin.value must be a 3-vector`);
    } else if (typeof pivot['caveat'] !== 'string' || !pivot['caveat'].includes('NOT THE JOINT CENTRE')) {
      bad(`${name}: pivotOrigin.caveat must keep the words "NOT THE JOINT CENTRE" — it is a point on the correct line, not a kinematic frame origin`);
    }

    // The invariant this whole package exists to defend.
    const semantic = raw['semanticName'];
    if (semantic !== undefined) {
      if (!isRecord(semantic)) {
        bad(`${name}: semanticName must be an object, never a bare string. A guessed spatial name must not be assignable where an authoritative name is expected.`);
      } else {
        if (semantic['verified'] !== false) {
          bad(`${name}: semanticName.verified must be the literal false. No mapping from firmware names to spatial names has been physically confirmed.`);
        }
        if (typeof semantic['value'] !== 'string' || semantic['value'].length === 0) {
          bad(`${name}: semanticName.value must be a non-empty string`);
        }
        if (typeof semantic['basis'] !== 'string' || semantic['basis'].length === 0) {
          bad(`${name}: semanticName.basis must say what the guess rests on`);
        }
        if (!Array.isArray(semantic['wouldBeConfirmedBy']) || semantic['wouldBeConfirmedBy'].length === 0) {
          bad(`${name}: semanticName.wouldBeConfirmedBy must name what would settle it`);
        }
      }
    }
  });

  // Kinematic graph: femurs hang off the chassis, feet hang off exactly one femur.
  const children = new Map<string, string>();
  for (const [name, raw] of seen) {
    const parent = raw['parentLink'];
    if (!isRecord(parent)) { bad(`${name}: parentLink is missing`); continue; }
    const pv = parent['value'];
    const cl = parent['childLink'];
    if (raw['kind'] === 'femur') {
      if (pv !== 'internal-frame') bad(`${name}: a femur's parent must be "internal-frame", got ${String(pv)}`);
      if (!isJointName(cl) || seen.get(cl)?.['kind'] !== 'foot') {
        bad(`${name}: a femur's childLink must be a foot joint, got ${String(cl)}`);
      } else {
        const prior = children.get(cl);
        if (prior !== undefined) bad(`${cl} is claimed as a child by both ${prior} and ${name}`);
        children.set(cl, name);
      }
    } else {
      if (!isJointName(pv) || seen.get(pv)?.['kind'] !== 'femur') {
        bad(`${name}: a foot's parent must be a femur joint, got ${String(pv)}`);
      }
      if (cl !== null) bad(`${name}: a foot is a leaf; childLink must be null`);
    }
  }
  for (const [name, raw] of seen) {
    if (raw['kind'] !== 'foot') continue;
    const parent = isRecord(raw['parentLink']) ? raw['parentLink']['value'] : undefined;
    if (typeof parent === 'string' && children.get(name) !== parent) {
      bad(`${name}: parent ${parent} does not name it back as its childLink; the femur/foot pairing must be a bijection`);
    }
  }

  if (problems.length > 0) throw new JointMapValidationError(problems);
  return value as unknown as JointMap;
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/**
 * A validated joint map with lookup helpers.
 *
 * Deliberately absent: any method that returns a spatial name as a plain
 * string. {@link JointMapView.labelFor} returns the firmware name, which is the
 * only name that is true.
 */
export class JointMapView {
  readonly data: JointMap;
  readonly #byName: ReadonlyMap<JointName, JointMapEntry>;

  private constructor(data: JointMap) {
    this.data = data;
    this.#byName = new Map(data.joints.map((j) => [j.firmwareName, j]));
  }

  /** Validate untrusted data and wrap it. Throws {@link JointMapValidationError}. */
  static parse(value: unknown): JointMapView {
    return new JointMapView(parseJointMap(value));
  }

  /** The eight entries, in firmware order. */
  get joints(): readonly JointMapEntry[] {
    return this.data.joints;
  }

  /** The joint names, in firmware order. Always equals `JOINT_ORDER`. */
  get order(): readonly JointName[] {
    return this.data.joints.map((j) => j.firmwareName);
  }

  /** Look up by firmware name. Total: every `JointName` is present. */
  get(joint: JointName): JointMapEntry {
    const entry = this.#byName.get(joint);
    if (entry === undefined) throw new Error(`joint map has no entry for ${joint}`);
    return entry;
  }

  /** Look up by firmware servo-channel index. */
  at(index: number): JointMapEntry | undefined {
    return this.data.joints[index];
  }

  /** The GPIO this joint's servo is wired to on a given board configuration. */
  pinFor(joint: JointName, board: BoardId): number {
    return this.get(joint).pinsByBoard[board];
  }

  /** `"femur"` or `"foot"`. Authoritative — the STEP file names the parts. */
  kindOf(joint: JointName): JointKind {
    return this.get(joint).kind;
  }

  /** The joints that are the same printed solid as this one (excluding itself). */
  shapeTwinsOf(joint: JointName): readonly JointName[] {
    const cls = this.get(joint).shapeEquivalenceClass;
    return this.data.joints
      .filter((j) => j.shapeEquivalenceClass === cls && j.firmwareName !== joint)
      .map((j) => j.firmwareName);
  }

  /** The kinematic parent: the chassis for a femur, the mating femur for a foot. */
  parentOf(joint: JointName): 'internal-frame' | JointName {
    return this.get(joint).parentLink.value;
  }

  /** The foot a femur drives, or `null` for a foot. */
  childOf(joint: JointName): JointName | null {
    return this.get(joint).parentLink.childLink;
  }

  /**
   * Clamp a commanded angle exactly as the firmware does, subtrim included:
   * `constrain(angle + servoSubtrim[channel], 0, 180)`.
   */
  clampCommandedDeg(joint: JointName, deg: number, subtrimDeg = 0): number {
    const { min, max } = this.get(joint).angleLimitsDeg.value;
    return Math.min(max, Math.max(min, deg + subtrimDeg));
  }

  /**
   * Convert a commanded angle into the inferred body-relative convention, in
   * which the same number means the same physical thing on all four legs:
   * `(commandedDeg - zeroReferenceDeg) * directionSign`.
   *
   * **Both inputs are inferred, not measured.** See the entry's
   * `zeroReferenceDeg.caveat` and `directionSign.caveat`.
   */
  toBodyRelativeDeg(joint: JointName, commandedDeg: number): number {
    const e = this.get(joint);
    const deg = (commandedDeg - e.zeroReferenceDeg.value) * e.directionSign.value;
    // Normalise -0 to 0: a negative-sign joint at its zero reference otherwise
    // produces -0, which is === 0 but not Object.is 0, and leaks into snapshots.
    return deg === 0 ? 0 : deg;
  }

  /** Inverse of {@link JointMapView.toBodyRelativeDeg}. */
  toCommandedDeg(joint: JointName, bodyRelativeDeg: number): number {
    const e = this.get(joint);
    return bodyRelativeDeg * e.directionSign.value + e.zeroReferenceDeg.value;
  }

  /** What the shipped choreography actually asks of this joint. Inferred. */
  observedRangeOf(joint: JointName): ObservedRange {
    return this.get(joint).observedRangeDeg;
  }

  /**
   * The **only** name that is authoritative. Use this in wire protocols, in
   * persisted state, as a React key, and in any UI that must not lie.
   */
  labelFor(joint: JointName): JointName {
    return this.get(joint).firmwareName;
  }

  /**
   * The unverified spatial-name guess, as a structured record. There is no
   * accessor that returns it as a plain string; see
   * {@link readGuessedSemanticName}.
   */
  semanticGuessFor(joint: JointName): UnverifiedSemanticName | undefined {
    return this.get(joint).semanticName;
  }

  /** Every open or partially-resolved item, including the six carried from F5. */
  get unresolved(): readonly UnresolvedEntry[] {
    return this.data.unresolved;
  }

  /** `true` — and it will stay true until someone measures a physical robot. */
  get hasUnverifiedSemantics(): boolean {
    return this.data.joints.some((j) => j.semanticName?.verified === false);
  }
}
