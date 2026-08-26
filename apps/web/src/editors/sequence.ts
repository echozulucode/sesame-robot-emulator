/**
 * The sequence document — a Lab editor's model, borrowed by Learn.
 *
 * L5 §8 is explicit about the direction of the dependency: *"The sequence
 * editor, the pixel editor, the API console and the fault injector are all
 * authored as Lab tools that Learn borrows, not the other way round."* So this
 * lives in `src/editors/` with no import from `src/lessons/`, and Lab mode
 * composes the same component rather than writing a second one.
 *
 * ## What a sequence is, and what it deliberately is not
 *
 * A frame is *a set of commanded angles plus a wait* — which is exactly the
 * shape the firmware's movement functions have, because the firmware has no
 * multi-joint primitive at all. `runWavePose()` is a run of `setServoAngle()`
 * calls in enum order with `delayWithFace()` between them, and nothing else.
 * There is no interpolation here, no easing and no solver, because there is
 * none there: a lesson that let a learner author a spline would be teaching
 * them about this editor rather than about Sesame.
 *
 * `importMovement()` reads the **extracted choreography** — the same 395 steps
 * `@sesame-lab/sesame-sim` executes — and flattens nested calls, so "copy wave
 * into the editor" produces the angles the firmware really commands rather than
 * a plausible re-authoring of them.
 */
import { CHOREOGRAPHY } from '@sesame-lab/sesame-sim';
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

/** The firmware's own commandable domain: `constrain(angle + subtrim, 0, 180)`. */
export const SEQUENCE_ANGLE_MIN = 0;
export const SEQUENCE_ANGLE_MAX = 180;

export interface SequenceFrame {
  /** Channels this frame writes, in whatever order the author typed them. The
   *  runner still issues them in JOINT_ORDER, because the firmware does. */
  readonly angles: Readonly<Partial<Record<JointName, number>>>;
  /** `delayWithFace(ms)` after the writes. */
  readonly delayMs: number;
}

export interface SequenceDoc {
  readonly name: string;
  /** The movement this was imported from, or `null` for a hand-authored one. */
  readonly basedOnMovement: string | null;
  readonly frames: readonly SequenceFrame[];
}

export const EMPTY_SEQUENCE: SequenceDoc = Object.freeze({
  name: 'untitled',
  basedOnMovement: null,
  frames: [],
});

/** Angles the author has typed that the firmware could never command. */
export function outOfRangeAngles(doc: SequenceDoc): readonly { joint: JointName; angleDeg: number }[] {
  const bad: { joint: JointName; angleDeg: number }[] = [];
  for (const frame of doc.frames) {
    for (const joint of JOINT_ORDER) {
      const angle = frame.angles[joint];
      if (angle === undefined) continue;
      if (!Number.isInteger(angle) || angle < SEQUENCE_ANGLE_MIN || angle > SEQUENCE_ANGLE_MAX) {
        bad.push({ joint, angleDeg: angle });
      }
    }
  }
  return bad;
}

/** Every write the document would issue, in firmware channel order per frame. */
export function flattenWrites(doc: SequenceDoc): readonly { joint: JointName; angleDeg: number; frame: number }[] {
  const writes: { joint: JointName; angleDeg: number; frame: number }[] = [];
  doc.frames.forEach((frame, index) => {
    for (const joint of JOINT_ORDER) {
      const angle = frame.angles[joint];
      if (angle === undefined) continue;
      writes.push({ joint, angleDeg: angle, frame: index });
    }
  });
  return writes;
}

interface RawStep {
  readonly type: string;
  readonly joint?: string;
  readonly angleDeg?: number;
  readonly ms?: number;
  readonly function?: string;
}

const MOVEMENT_BY_FUNCTION = new Map(
  (CHOREOGRAPHY.movements as readonly { function: string; steps: readonly RawStep[] }[]).map((m) => [
    m.function,
    m,
  ]),
);

export const IMPORTABLE_MOVEMENTS: readonly string[] = [...MOVEMENT_BY_FUNCTION.keys()].sort();

/**
 * Flatten one movement function into frames.
 *
 * Servo writes accumulate into the current frame; a `delay` closes it. Nested
 * `call` steps are expanded in place, up to a small depth — `runWavePose` calls
 * `runStandPose`, and a learner who imported wave and got only the four writes
 * in wave's own body would be looking at a different movement.
 *
 * Everything that is not a servo write, a delay or a call is dropped, and the
 * count of what was dropped is returned rather than hidden: a movement with
 * `interruptCheck` steps genuinely does not survive the trip into an editor
 * that has no notion of interruption, and the UI says so.
 */
export function importMovement(fn: string): { doc: SequenceDoc; dropped: number } | null {
  const root = MOVEMENT_BY_FUNCTION.get(fn);
  if (root === undefined) return null;

  const frames: SequenceFrame[] = [];
  let current: Partial<Record<JointName, number>> = {};
  let dropped = 0;

  const flush = (delayMs: number): void => {
    if (Object.keys(current).length === 0 && delayMs === 0) return;
    frames.push({ angles: current, delayMs });
    current = {};
  };

  const walk = (steps: readonly RawStep[], depth: number): void => {
    for (const step of steps) {
      switch (step.type) {
        case 'servo': {
          const joint = step.joint;
          if (joint !== undefined && (JOINT_ORDER as readonly string[]).includes(joint) && typeof step.angleDeg === 'number') {
            current = { ...current, [joint as JointName]: step.angleDeg };
          } else {
            dropped += 1;
          }
          break;
        }
        case 'delay':
          flush(typeof step.ms === 'number' ? step.ms : 0);
          break;
        case 'call': {
          const nested = step.function === undefined ? undefined : MOVEMENT_BY_FUNCTION.get(step.function);
          if (nested !== undefined && depth < 4) walk(nested.steps, depth + 1);
          else dropped += 1;
          break;
        }
        case 'log':
        case 'face':
        case 'state':
          // Not a servo write and not a wait. Nothing to author.
          break;
        default:
          dropped += 1;
      }
    }
  };

  walk(root.steps, 0);
  flush(0);
  return { doc: { name: fn, basedOnMovement: fn, frames }, dropped };
}

/** Scale every wait by a factor. The one "change the timing" edit lessons ask for. */
export function scaleDelays(doc: SequenceDoc, factor: number): SequenceDoc {
  return {
    ...doc,
    frames: doc.frames.map((f) => ({ ...f, delayMs: Math.max(0, Math.round(f.delayMs * factor)) })),
  };
}

export function setFrameAngle(
  doc: SequenceDoc,
  frameIndex: number,
  joint: JointName,
  angleDeg: number | null,
): SequenceDoc {
  return {
    ...doc,
    frames: doc.frames.map((frame, i) => {
      if (i !== frameIndex) return frame;
      const angles: Partial<Record<JointName, number>> = { ...frame.angles };
      if (angleDeg === null) delete angles[joint];
      else angles[joint] = angleDeg;
      return { ...frame, angles };
    }),
  };
}

export function setFrameDelay(doc: SequenceDoc, frameIndex: number, delayMs: number): SequenceDoc {
  return {
    ...doc,
    frames: doc.frames.map((frame, i) => (i === frameIndex ? { ...frame, delayMs } : frame)),
  };
}

export function addFrame(doc: SequenceDoc): SequenceDoc {
  return { ...doc, frames: [...doc.frames, { angles: {}, delayMs: 200 }] };
}

export function removeFrame(doc: SequenceDoc, frameIndex: number): SequenceDoc {
  return { ...doc, frames: doc.frames.filter((_, i) => i !== frameIndex) };
}
