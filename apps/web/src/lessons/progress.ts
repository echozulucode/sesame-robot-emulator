/**
 * Progress, and what is allowed to unlock what.
 *
 * The research report is explicit that challenges unlock **because the learner
 * demonstrated a concept**, not because a timer elapsed, and L5 made a timer
 * gate structurally impossible: there is no time-based and no
 * acknowledgement-based check type in the vocabulary. Nothing here adds one
 * back.
 *
 * Two rules follow, and they are the whole module:
 *
 *  1. **A step becomes `passed` only when its check returned `passed`.** There
 *     is no `complete()` a button can call. `record()` takes an outcome, and
 *     the only outcome it will persist as passed is one the evaluator produced.
 *  2. **A skip is recorded as a skip.** A learner who is stuck can move on —
 *     staring at a check you cannot satisfy is not pedagogy — but the entry
 *     says `skipped`, it is shown as skipped, and it satisfies **nothing**: not
 *     a challenge's `unlockedBy`, not a lesson's `prerequisites`. That is the
 *     difference between a "continue anyway" and an honest record.
 *
 * ## Storage
 *
 * `localStorage`, defensively. Every read and every write is wrapped: the
 * accessor itself throws in a private window with site data blocked, the value
 * can be absent, and it can be somebody else's JSON. All three render the same
 * way — an empty progress record — and none of them is an error the learner
 * has to see. Progress is a convenience, not the source of truth: the checks
 * re-evaluate from live state every tick regardless of what is stored.
 */
import type { CheckOutcome } from './checks.js';
import type { Lesson } from '../generated/lessons.js';

const STORAGE_KEY = 'sesame-lab.lessons.v1';

export type StepOutcome = 'passed' | 'skipped';

export interface StepRecord {
  readonly outcome: StepOutcome;
  /** Epoch ms. Informational only — nothing gates on elapsed time. */
  readonly at: number;
  /** What the system reported at the moment it passed. Kept for the receipt. */
  readonly observed: string | null;
}

export interface ProgressState {
  readonly version: 1;
  /** `lessonId` → `successId` → record. Keyed by SUCCESS id, which is what
   *  `challenge.unlockedBy` names. */
  readonly steps: Readonly<Record<string, Readonly<Record<string, StepRecord>>>>;
  readonly openLessonId: string | null;
}

export const EMPTY_PROGRESS: ProgressState = Object.freeze({
  version: 1,
  steps: {},
  openLessonId: null,
});

// ------------------------------------------------------------------ storage

/**
 * Read stored progress.
 *
 * Never throws and never returns a partially-typed object: anything that is not
 * recognisably this schema is discarded rather than merged, because a
 * half-understood record would produce a lesson list that is confidently wrong
 * about what the learner has done.
 */
export function loadProgress(): ProgressState {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return EMPTY_PROGRESS;
  }
  if (raw === null) return EMPTY_PROGRESS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return EMPTY_PROGRESS;
    const candidate = parsed as Partial<ProgressState>;
    if (candidate.version !== 1 || typeof candidate.steps !== 'object' || candidate.steps === null) {
      return EMPTY_PROGRESS;
    }
    const steps: Record<string, Record<string, StepRecord>> = {};
    for (const [lessonId, byStep] of Object.entries(candidate.steps)) {
      if (byStep === null || typeof byStep !== 'object') continue;
      const clean: Record<string, StepRecord> = {};
      for (const [successId, record] of Object.entries(byStep as Record<string, unknown>)) {
        if (record === null || typeof record !== 'object') continue;
        const r = record as Partial<StepRecord>;
        if (r.outcome !== 'passed' && r.outcome !== 'skipped') continue;
        clean[successId] = {
          outcome: r.outcome,
          at: typeof r.at === 'number' ? r.at : 0,
          observed: typeof r.observed === 'string' ? r.observed : null,
        };
      }
      steps[lessonId] = clean;
    }
    return {
      version: 1,
      steps,
      openLessonId: typeof candidate.openLessonId === 'string' ? candidate.openLessonId : null,
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

/** Persist. A failure here is silent by design: storage is not the truth. */
export function saveProgress(state: ProgressState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private window, quota, or site data blocked — the app runs the same */
  }
}

export function clearProgress(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do and nothing worth saying */
  }
}

// ------------------------------------------------------------------ writing

/**
 * Fold one evaluated outcome into progress.
 *
 * The ONLY way a step becomes passed. `outcome.status` must be `passed`; every
 * other status — including `unsupported` — returns the state unchanged.
 */
export function recordOutcome(
  state: ProgressState,
  lessonId: string,
  successId: string,
  outcome: CheckOutcome,
): ProgressState {
  if (outcome.status !== 'passed') return state;
  const existing = state.steps[lessonId]?.[successId];
  if (existing?.outcome === 'passed') return state;
  return {
    ...state,
    steps: {
      ...state.steps,
      [lessonId]: {
        ...(state.steps[lessonId] ?? {}),
        [successId]: { outcome: 'passed', at: Date.now(), observed: outcome.observed },
      },
    },
  };
}

/** Record a skip. Never an outcome, never satisfies a prerequisite. */
export function recordSkip(state: ProgressState, lessonId: string, successId: string): ProgressState {
  const existing = state.steps[lessonId]?.[successId];
  // A passed step is never downgraded by a later skip.
  if (existing?.outcome === 'passed') return state;
  return {
    ...state,
    steps: {
      ...state.steps,
      [lessonId]: {
        ...(state.steps[lessonId] ?? {}),
        [successId]: { outcome: 'skipped', at: Date.now(), observed: null },
      },
    },
  };
}

/** Undo a skip so the learner can come back and actually do it. */
export function clearSkip(state: ProgressState, lessonId: string, successId: string): ProgressState {
  const byStep = state.steps[lessonId];
  if (byStep?.[successId]?.outcome !== 'skipped') return state;
  const next: Record<string, StepRecord> = { ...byStep };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete next[successId];
  return { ...state, steps: { ...state.steps, [lessonId]: next } };
}

// ------------------------------------------------------------------ reading

export const recordFor = (
  state: ProgressState,
  lessonId: string,
  successId: string,
): StepRecord | null => state.steps[lessonId]?.[successId] ?? null;

export const isPassed = (state: ProgressState, lessonId: string, successId: string): boolean =>
  recordFor(state, lessonId, successId)?.outcome === 'passed';

export interface LessonProgress {
  readonly total: number;
  readonly passed: number;
  readonly skipped: number;
  /** Every step passed. Skipping does NOT get you here. */
  readonly complete: boolean;
  /** Every step resolved one way or the other. Shown, never used to unlock. */
  readonly resolved: boolean;
}

export function lessonProgress(state: ProgressState, lesson: Lesson): LessonProgress {
  const total = lesson.steps.length;
  let passed = 0;
  let skipped = 0;
  for (const step of lesson.steps) {
    const record = recordFor(state, lesson.id, step.success.id);
    if (record?.outcome === 'passed') passed += 1;
    else if (record?.outcome === 'skipped') skipped += 1;
  }
  return { total, passed, skipped, complete: passed === total && total > 0, resolved: passed + skipped === total };
}

export interface LockState {
  readonly locked: boolean;
  /** Prerequisite lessons that are not complete. Named, so the wall has a door. */
  readonly waitingOn: readonly string[];
}

/**
 * Is this lesson open?
 *
 * A prerequisite is satisfied only when every one of its steps **passed**. A
 * lesson whose prerequisite has skipped steps stays locked and says which ones,
 * because the alternative is a skip button that quietly unlocks the curriculum
 * — which is the "continue anyway" this task rules out, wearing a hat.
 */
export function lockStateFor(
  state: ProgressState,
  lesson: Lesson,
  byId: ReadonlyMap<string, Lesson>,
): LockState {
  const waitingOn = lesson.prerequisites.filter((id) => {
    const prerequisite = byId.get(id);
    if (prerequisite === undefined) return false;
    return !lessonProgress(state, prerequisite).complete;
  });
  return { locked: waitingOn.length > 0, waitingOn };
}

/** A challenge opens because the named success was DEMONSTRATED. */
export const challengeUnlocked = (state: ProgressState, lessonId: string, unlockedBy: string): boolean =>
  isPassed(state, lessonId, unlockedBy);
