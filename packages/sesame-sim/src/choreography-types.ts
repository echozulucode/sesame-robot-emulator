/**
 * The shape of the choreography this package executes.
 *
 * Every value here is a **projection of `hardware/hardware-map.json`**, which
 * F4 extracted from `firmware/movement-sequences.h` and
 * `firmware/sesame-firmware-main.ino` with `file:line` provenance on every
 * fact. Nothing in this package hand-transcribes a movement: if a joint angle
 * is wrong, the bug is in the extractor, not here.
 *
 * `src/generated/choreography.ts` is produced from that JSON by
 * `scripts/build-choreography.mjs` and re-checked by
 * `src/__tests__/choreography-drift.test.ts`, so the mirror cannot rot.
 */
import type { JointIndex, JointName } from '@sesame-lab/sesame-model';
import type { FacePlaybackMode } from '@sesame-lab/sesame-protocol';

/** A pointer back into the upstream firmware tree. Present on every step. */
export interface StepSource {
  readonly file: string;
  readonly line: number;
}

/** `Serial.println(F("WAVE"))` — a plain UART print, not a `@SESAME` line. */
export interface LogStep {
  readonly type: 'log';
  readonly text: string;
  readonly source: StepSource;
}

/**
 * A `setFace()` / `setFaceWithMode()` call site.
 *
 * `mode` is the mode observed **at this call site**, not a property of the
 * face: `currentFaceMode` is one global (`sesame-firmware-main.ino:58`) that
 * `setFaceWithMode()` overwrites. A `null` mode means the call site used bare
 * `setFace()` and inherited whatever mode was already global.
 */
export interface FaceStep {
  readonly type: 'face';
  readonly name: string;
  readonly mode: FacePlaybackMode | null;
  readonly source: StepSource;
}

/** A `setServoAngle(index, angleDeg)` call. `joint` and `index` must agree. */
export interface ServoStep {
  readonly type: 'servo';
  readonly joint: JointName;
  readonly index: JointIndex;
  readonly angleDeg: number;
  readonly source: StepSource;
}

/** A `delayWithFace(ms)` call — a re-entrancy point, not dead time. */
export interface DelayStep {
  readonly type: 'delay';
  readonly ms: number;
  readonly via: string;
  readonly source: StepSource;
}

/**
 * A `for` loop.
 *
 * `count` is a literal bound; `countDefault` + `countRef` describe a bound read
 * from a mutable global (`walkCycles`, `sesame-firmware-main.ino:118`), which
 * the simulator resolves from its runtime settings so the two stay in step.
 */
export interface RepeatStep {
  readonly type: 'repeat';
  readonly count: number | null;
  readonly countDefault: number | null;
  readonly countRef: string | null;
  readonly steps: readonly ChoreographyStep[];
  readonly source: StepSource;
}

/** `if (<condition>)` over the movement function's bound arguments. */
export interface ConditionalStep {
  readonly type: 'conditional';
  readonly condition: string;
  readonly steps: readonly ChoreographyStep[];
  readonly source: StepSource;
}

/** A call to another movement function, or to `scheduleNextIdleBlink()`. */
export interface CallStep {
  readonly type: 'call';
  readonly function: string;
  readonly args: Readonly<Record<string, number>> | null;
  readonly source: StepSource;
}

/** `if (currentCommand == "<command>") currentCommand = "";` */
export interface ClearCommandIfStep {
  readonly type: 'clearCommandIf';
  readonly command: string;
  readonly source: StepSource;
}

/**
 * `if (!pressingCheck("<command>", <ms>)) return;`
 *
 * `pressingCheck()` spins for `ms`, pumping HTTP/DNS/face animation, and bails
 * out the moment `currentCommand` changes — running `runStandPose(1)` on the
 * way out (`sesame-firmware-main.ino:1064`).
 */
export interface InterruptCheckStep {
  readonly type: 'interruptCheck';
  readonly command: string;
  readonly durationMsDefault: number | null;
  readonly durationMsRef: string | null;
  readonly source: StepSource;
}

/** An assignment to one of the idle-state globals. */
export interface StateStep {
  readonly type: 'state';
  readonly variable: string;
  readonly value: boolean | number;
  readonly source: StepSource;
}

/** Every step kind the extractor produces. */
export type ChoreographyStep =
  | LogStep
  | FaceStep
  | ServoStep
  | DelayStep
  | RepeatStep
  | ConditionalStep
  | CallStep
  | ClearCommandIfStep
  | InterruptCheckStep
  | StateStep;

/** The discriminators, for exhaustiveness tests. */
export const STEP_TYPES = [
  'log', 'face', 'servo', 'delay', 'repeat',
  'conditional', 'call', 'clearCommandIf', 'interruptCheck', 'state',
] as const;

/** Union of {@link ChoreographyStep} discriminators. */
export type StepType = (typeof STEP_TYPES)[number];

/** F4's classification of a movement function. Not a firmware concept. */
export type MovementKind = 'pose' | 'movement' | 'idle-routine';

/** One of the 21 functions in `firmware/movement-sequences.h`. */
export interface MovementDefinition {
  /** The C++ symbol, e.g. `runWavePose`. Identity. */
  readonly function: string;
  readonly kind: MovementKind;
  readonly signature: string;
  /** True for the four gaits, which `loop()` re-invokes while the key is held. */
  readonly loops: boolean;
  /** True where the body contains `pressingCheck()` bail-outs. */
  readonly interruptible: boolean;
  /** Command strings that dispatch to this function. Often empty. */
  readonly triggeredByCommand: readonly string[];
  /** Default values for the C++ default arguments, e.g. `{ face: 1 }`. */
  readonly defaultArgs: Readonly<Record<string, number>> | null;
  /** F4's prose note, where the extractor recorded a surprise. */
  readonly note: string | null;
  readonly source: StepSource;
  readonly sourceRange: { readonly from: StepSource; readonly to: StepSource };
  readonly steps: readonly ChoreographyStep[];
}

/** The executable choreography, plus the servo facts it is executed against. */
export interface Choreography {
  /** Provenance of the projection itself. */
  readonly meta: {
    readonly generatedBy: string;
    readonly sourceFile: string;
    readonly upstreamCommit: string;
    readonly movementCount: number;
    /** Recursive step count. 395 at the time of writing. */
    readonly stepCount: number;
  };
  /** All 21 functions, in `hardware-map.json` order. */
  readonly movements: readonly MovementDefinition[];
  /** `constrain(angle + servoSubtrim[channel], 0, 180)` — the one clamp. */
  readonly angleClamp: { readonly min: number; readonly max: number };
  /** `int motorCurrentDelay = 20;` (`sesame-firmware-main.ino:119`). */
  readonly motorCurrentDelayMs: number;
  /** `int8_t servoSubtrim[8] = {0,…};` (`sesame-firmware-main.ino:113`). */
  readonly subtrimDefaults: readonly number[];
  /** `servos.order` — must equal `JOINT_ORDER`. Asserted at load. */
  readonly jointOrder: readonly JointName[];
}
