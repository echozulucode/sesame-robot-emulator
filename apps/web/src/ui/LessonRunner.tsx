/**
 * Learn mode — the runner that plays `hardware/lessons.json`.
 *
 * ```text
 * lesson list  ->  one lesson  ->  one step at a time
 *                                     explanation (one level of three)
 *                                     the claim, with its citations
 *                                     a control
 *                                     a check, evaluated against real state
 * ```
 *
 * Four things in here are load-bearing and none of them is the layout.
 *
 * **1. The check is the only way forward.** There is no Next button that marks
 * a step done. `evaluateCheck()` runs on a tick against the telemetry store,
 * the trace store, the shared selection and the runtime journal, and a step
 * becomes passed when — and only when — that returns `passed`. A skip exists,
 * because staring at a check you cannot satisfy is not pedagogy, and it is
 * recorded as **skipped**: shown as skipped, and satisfying no challenge's
 * `unlockedBy` and no lesson's prerequisites.
 *
 * **2. `conceptual` comes from `grounding`.** Not from `links.symbols.length`.
 * Three of the seven conceptual modules carry firmware symbols — the pins and
 * the pose vectors are facts; the *framing* is what has no grounding — so a
 * badge driven by emptiness would mislabel `inside-the-brain`,
 * `build-a-leg-pose` and `build-a-movement`. The generator asserts `grounding`
 * against `source-annotations.json`'s curriculum so it cannot drift.
 *
 * **3. `boundaryNote` is not a caveat.** It is where a *factual* step admits
 * the fact is about a library, an emulator or Sesame Lab rather than about
 * Sesame's firmware, and it gets its own register: a dashed box keyed by
 * `claim.domain`, headed with which world the fact belongs to. Ordinary prose
 * treatment would make it read as a hedge on a Sesame fact, which is the
 * opposite of what it says.
 *
 * **4. Exactly one explanation level is on screen.** The switch replaces; it
 * never stacks. `goDeeper` is a `<details>` with no `open`, because a lesson
 * whose depth is expanded by default is the wall of text the research report
 * warns about.
 *
 * Outline lessons (7–19) are shown as outlines: readable, badged, and with
 * every step's control and check named but not playable. Pretending they were
 * would be the same lie as a check that passes on a click.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from 'react';

import { FaultInjector } from '../editors/FaultInjector.js';
import { LabModifications } from '../editors/LabModifications.js';
import { HttpConsole } from '../editors/HttpConsole.js';
import { PixelEditor } from '../editors/PixelEditor.js';
import { PwmInspector } from '../editors/PwmInspector.js';
import { SequenceEditor } from '../editors/SequenceEditor.js';
import { SubtrimControl } from '../editors/SubtrimControl.js';
import {
  blankFrame,
  countLitPixels,
  densestWindow,
  setPixel as paintPixel,
} from '../editors/pixel-frame.js';
import {
  EMPTY_SEQUENCE,
  importMovement,
  type SequenceDoc,
} from '../editors/sequence.js';
import {
  COMMAND_TRACE_FACTS,
  SERVO_PINS_BY_BOARD,
} from '../generated/architecture-graph.js';
import {
  EXPLANATION_LEVELS,
  LESSONS,
  LESSON_BY_ID,
  PROVENANCE_BADGE_IDS,
  type ExplanationLevelId,
  type Lesson,
  type LessonChallenge,
  type LessonCitation,
  type LessonStep,
  type LessonSuccess,
} from '../generated/lessons.js';
import { FACE_BITMAP_FRAMES } from '../generated/face-bitmaps.js';
import { evaluateCheck, type CheckOutcome } from '../lessons/checks.js';
import {
  CONTROL_NOT_BUILT_REASON,
  isControlImplemented,
} from '../lessons/registry.js';
import {
  challengeUnlocked,
  clearSkip,
  lessonProgress,
  loadProgress,
  lockStateFor,
  recordFor,
  recordOutcome,
  recordSkip,
  saveProgress,
  type ProgressState,
} from '../lessons/progress.js';
import { RobotExplode } from '../lessons/RobotExplode.js';
import type { LessonWiring } from '../lessons/wiring.js';

const FACE_NAMES: readonly string[] = Object.keys(FACE_BITMAP_FRAMES).sort();
const MOVEMENT_COMMANDS: readonly string[] = COMMAND_TRACE_FACTS.filter(
  (f) => f.movementFunction !== null,
).map((f) => f.command);

/** How often the checks are re-evaluated against live state. */
const EVALUATE_MS = 250;

export function LessonRunner(props: { readonly wiring: LessonWiring }): ReactElement {
  const { wiring } = props;
  // Read once. A second `loadProgress()` would parse the same record twice and,
  // worse, could disagree with the first if storage changed between them.
  const progressAtMount = useMemo(() => loadProgress(), []);
  const [progress, setProgress] = useState<ProgressState>(progressAtMount);
  const [openId, setOpenId] = useState<string | null>(progressAtMount.openLessonId);
  const [stepIndex, setStepIndex] = useState(0);
  const [level, setLevel] = useState<ExplanationLevelId>('beginner12');
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CheckOutcome>>>({});

  // ------------------------------------------------------- control-local UI
  const [pwmAngle, setPwmAngle] = useState(90);
  const [channelInput, setChannelInput] = useState('8');
  const [channelAngle, setChannelAngle] = useState('90');
  const [sliderDeg, setSliderDeg] = useState(90);
  const [sequence, setSequence] = useState<SequenceDoc>(EMPTY_SEQUENCE);
  const [sequenceBusy, setSequenceBusy] = useState(false);
  const [pixel, setPixel] = useState<Uint8Array>(() => blankFrame());
  const [explode, setExplode] = useState(0.55);
  const [quizIndex, setQuizIndex] = useState(0);
  const [jointGuess, setJointGuess] = useState<readonly JointName[]>([]);
  const [httpBusy, setHttpBusy] = useState(false);

  const open = openId === null ? null : (LESSON_BY_ID.get(openId) ?? null);
  const step = open?.steps[stepIndex] ?? null;

  /*
   * Measure the drawn frame after React has settled, not inside the paint
   * handler. The paint handler runs several times per stroke and would measure
   * a frame that is one or two pixels behind; this runs once per committed
   * state and reads the buffer that is actually on screen.
   */
  const regionW = Number(step?.success.check['regionWidth'] ?? 5);
  const regionH = Number(step?.success.check['regionHeight'] ?? 5);
  useEffect(() => {
    const lit = countLitPixels(pixel);
    wiring.runtime.setPixelState(
      lit === 0 ? null : { changed: lit, bestWindow: densestWindow(pixel, regionW, regionH) },
    );
    // `wiring` is rebuilt every App render; the runtime inside it is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixel, regionW, regionH]);

  // Persist. `openLessonId` rides along so reopening the tab lands where the
  // learner left off; everything else is re-derived from live state anyway.
  useEffect(() => {
    saveProgress({ ...progress, openLessonId: openId });
  }, [progress, openId]);

  // ----------------------------------------------------------- evaluation
  //
  // The whole mechanic. Every 250 ms the ACTIVE step's check and every unlocked
  // challenge's check are re-run against the stores. Nothing here consults a
  // button press, and a `passed` is the only thing `recordOutcome` will store.
  const wiringRef = useRef(wiring);
  wiringRef.current = wiring;
  const openRef = useRef(open);
  openRef.current = open;
  const stepRef = useRef(step);
  stepRef.current = step;
  // The evaluator runs off an interval and cannot close over `progress`.
  const loadedRef = useRef(progress);
  loadedRef.current = progress;

  useEffect(() => {
    const id = setInterval(() => {
      const current = openRef.current;
      if (current === null) return;
      const live = wiringRef.current;
      const ctx = {
        runtime: live.runtime,
        lab: live.runtime.snapshot(),
        joints: live.joints,
        model: live.model,
        trace: live.trace,
        selection: live.selection,
        nowMs: Date.now(),
      };
      const successes: LessonSuccess[] = [];
      const active = stepRef.current;
      if (active !== null) successes.push(active.success);
      for (const challenge of current.challenges) {
        if (challengeUnlocked(loadedRef.current, current.id, challenge.unlockedBy)) {
          successes.push(challenge.success);
        }
      }
      const next: Record<string, CheckOutcome> = {};
      for (const success of successes) next[success.id] = evaluateCheck(success.check, ctx);
      setOutcomes((previous) => {
        let changed = false;
        for (const [id2, outcome] of Object.entries(next)) {
          const before = previous[id2];
          if (
            before === undefined ||
            before.status !== outcome.status ||
            before.summary !== outcome.summary ||
            before.observed !== outcome.observed
          ) {
            changed = true;
            break;
          }
        }
        return changed ? { ...previous, ...next } : previous;
      });
      for (const success of successes) {
        const outcome = next[success.id];
        if (outcome?.status === 'passed') {
          setProgress((p) => recordOutcome(p, current.id, success.id, outcome));
        }
      }
    }, EVALUATE_MS);
    return () => clearInterval(id);
  }, []);

  const openLesson = useCallback((id: string) => {
    setOpenId(id);
    setStepIndex(0);
    setLevel('beginner12');
    setQuizIndex(0);
  }, []);

  if (open === null) {
    return (
      <section className="lesson-panel" data-testid="lesson-runner" data-open="false">
        <LessonList progress={progress} onOpen={openLesson} />
      </section>
    );
  }

  const lock = lockStateFor(progress, open, LESSON_BY_ID);
  // A locked lesson is READABLE and not playable. Hiding it would be a wall
  // without a door; playing it would let a learner skip the demonstration its
  // prerequisites exist to require.
  const outline = open.status === 'outline' || lock.locked;

  return (
    <section
      className="lesson-panel is-open"
      data-testid="lesson-runner"
      data-open="true"
      data-lesson={open.id}
      data-locked={String(lock.locked)}
    >
      <LessonHeader
        lesson={open}
        progress={progress}
        onClose={() => setOpenId(null)}
        stepIndex={stepIndex}
        onStep={setStepIndex}
        lock={lock}
      />
      <LessonLabModifications wiring={wiring} />
      {outline ? (
        <OutlineBody lesson={open} locked={lock.locked} />
      ) : (
        step !== null && (
          <StepBody
            lesson={open}
            step={step}
            level={level}
            onLevel={setLevel}
            outcome={outcomes[step.success.id] ?? null}
            record={recordFor(progress, open.id, step.success.id)}
            onSkip={() => setProgress((p) => recordSkip(p, open.id, step.success.id))}
            onUnskip={() => setProgress((p) => clearSkip(p, open.id, step.success.id))}
            wiring={wiring}
            controls={{
              pwmAngle,
              setPwmAngle,
              channelInput,
              setChannelInput,
              channelAngle,
              setChannelAngle,
              sliderDeg,
              setSliderDeg,
              sequence,
              setSequence,
              sequenceBusy,
              setSequenceBusy,
              pixel,
              setPixel,
              explode,
              setExplode,
              quizIndex,
              setQuizIndex,
              jointGuess,
              setJointGuess,
              httpBusy,
              setHttpBusy,
            }}
          />
        )
      )}
      {!outline && (
        <Challenges
          lesson={open}
          progress={progress}
          outcomes={outcomes}
        />
      )}
    </section>
  );
}

/**
 * "Sesame Lab is modifying this robot."
 *
 * The banner itself lives in `src/editors/LabModifications.tsx`, beside the
 * controls that create the state it names. Lab mode sets far more of that state
 * than Learn does, and a banner implemented twice would eventually say two
 * different things about the same robot. Learn passes what it can see: the
 * runtime's subtrim and injected faults. It does not pass `panelAuthored`,
 * because the lesson runner has no window onto the panel — that argument is
 * Lab's, and its absence here is the honest reading rather than a `false`
 * asserting the panel is clean.
 */
function LessonLabModifications(props: { readonly wiring: LessonWiring }): ReactElement | null {
  const { wiring } = props;
  return (
    <LabModifications
      subtrimDeg={wiring.runtime.subtrimDeg}
      faults={[...wiring.runtime.faults]}
      onClear={() => wiring.clearLabModifications()}
    />
  );
}

// ============================================================== lesson list

function LessonList(props: {
  readonly progress: ProgressState;
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const { progress, onOpen } = props;
  return (
    <>
      <div className="panel-header">
        <h2>Learn</h2>
        <span className="panel-sub">
          {LESSONS.length} modules &middot; {LESSONS.filter((l) => l.status === 'polished').length}{' '}
          playable &middot; every step ends on a checkable observable, never a Next button
        </span>
      </div>
      <div className="lesson-list" data-testid="lesson-list">
        {LESSONS.map((lesson) => {
          const lock = lockStateFor(progress, lesson, LESSON_BY_ID);
          const done = lessonProgress(progress, lesson);
          return (
            <button
              key={lesson.id}
              type="button"
              className={`lesson-card${lock.locked ? ' is-locked' : ''}${lesson.status === 'outline' ? ' is-outline' : ''}`}
              data-testid={`lesson-card-${lesson.id}`}
              data-grounding={lesson.grounding}
              data-status={lesson.status}
              data-locked={String(lock.locked)}
              onClick={() => onOpen(lesson.id)}
            >
              <span className="lesson-card-order">{lesson.order}</span>
              <span className="lesson-card-title">{lesson.title}</span>
              <span className="lesson-card-badges">
                {lesson.grounding === 'conceptual' && (
                  <span className="badge is-conceptual" data-testid={`conceptual-${lesson.id}`} title={lesson.conceptualReason ?? ''}>
                    conceptual
                  </span>
                )}
                {lesson.groundingNote !== null && (
                  <span className="badge is-boundary" title={lesson.groundingNote}>
                    boundary
                  </span>
                )}
                {lesson.status === 'outline' && <span className="badge is-outline">outline</span>}
              </span>
              <span className="lesson-card-progress">
                {done.passed}/{done.total}
                {done.skipped > 0 ? ` · ${String(done.skipped)} skipped` : ''}
              </span>
              {lock.locked && (
                <span className="lesson-card-lock">
                  locked — read it, but finish {lock.waitingOn.join(', ')} first to play it (every
                  step passed, not skipped)
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ============================================================ lesson header

function LessonHeader(props: {
  readonly lesson: Lesson;
  readonly progress: ProgressState;
  readonly onClose: () => void;
  readonly stepIndex: number;
  readonly onStep: (index: number) => void;
  readonly lock: ReturnType<typeof lockStateFor>;
}): ReactElement {
  const { lesson, progress, onClose, stepIndex, onStep, lock } = props;
  return (
    <header className="lesson-header">
      <div className="panel-header">
        <h2>
          <button type="button" className="linkish" data-testid="lesson-back" onClick={onClose}>
            ← all modules
          </button>{' '}
          {lesson.order}. {lesson.title}
        </h2>
        <span className="panel-sub">{lesson.estimatedMinutes} min</span>
      </div>

      {lesson.grounding === 'conceptual' && (
        <div className="lesson-conceptual" data-testid="lesson-conceptual-badge">
          <b>CONCEPTUAL.</b> {lesson.conceptualReason}{' '}
          <span className="muted">
            Nothing in this module may be read as &ldquo;this is how Sesame actually works&rdquo;.
          </span>
        </div>
      )}
      {lesson.groundingNote !== null && (
        <div className="lesson-grounding-note" data-testid="lesson-grounding-note">
          <b>Where this module&rsquo;s ground ends.</b> {lesson.groundingNote}
        </div>
      )}
      {lesson.supersedes !== null && (
        <p className="note muted small">
          supersedes <code>{lesson.supersedes}</code>
        </p>
      )}

      {lock.locked && (
        <div className="lesson-grounding-note" data-testid="lesson-locked">
          <b>Locked, and readable anyway.</b> Every step of {lock.waitingOn.join(', ')} has to be{' '}
          <b>passed</b> before this one is playable. A skipped step does not count — that is the
          whole difference between a skip and a &ldquo;continue anyway&rdquo;.
        </div>
      )}

      <p className="lesson-goal">{lesson.learningGoal}</p>

      <nav className="lesson-steps" data-testid="lesson-step-nav">
        {lesson.steps.map((step, index) => {
          const record = recordFor(progress, lesson.id, step.success.id);
          return (
            <button
              key={step.id}
              type="button"
              className={`lesson-step-chip${index === stepIndex ? ' is-current' : ''}${
                record === null ? '' : record.outcome === 'passed' ? ' is-passed' : ' is-skipped'
              }`}
              data-testid={`lesson-step-${step.id}`}
              data-outcome={record?.outcome ?? 'open'}
              onClick={() => onStep(index)}
            >
              {index + 1}
              {record?.outcome === 'passed' && ' ✓'}
              {record?.outcome === 'skipped' && ' ↷'}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

// ================================================================ step body

interface ControlBag {
  readonly pwmAngle: number;
  readonly setPwmAngle: (n: number) => void;
  readonly channelInput: string;
  readonly setChannelInput: (s: string) => void;
  readonly channelAngle: string;
  readonly setChannelAngle: (s: string) => void;
  readonly sliderDeg: number;
  readonly setSliderDeg: (n: number) => void;
  readonly sequence: SequenceDoc;
  readonly setSequence: (doc: SequenceDoc) => void;
  readonly sequenceBusy: boolean;
  readonly setSequenceBusy: (b: boolean) => void;
  readonly pixel: Uint8Array;
  /** The updater form, so a drag does not read a stale frame per event. */
  readonly setPixel: Dispatch<SetStateAction<Uint8Array>>;
  readonly explode: number;
  readonly setExplode: (n: number) => void;
  readonly quizIndex: number;
  readonly setQuizIndex: (n: number) => void;
  readonly jointGuess: readonly JointName[];
  readonly setJointGuess: (joints: readonly JointName[]) => void;
  readonly httpBusy: boolean;
  readonly setHttpBusy: (b: boolean) => void;
}

function StepBody(props: {
  readonly lesson: Lesson;
  readonly step: LessonStep;
  readonly level: ExplanationLevelId;
  readonly onLevel: (level: ExplanationLevelId) => void;
  readonly outcome: CheckOutcome | null;
  readonly record: ReturnType<typeof recordFor>;
  readonly onSkip: () => void;
  readonly onUnskip: () => void;
  readonly wiring: LessonWiring;
  readonly controls: ControlBag;
}): ReactElement {
  const { lesson, step, level, onLevel, outcome, record, onSkip, onUnskip, wiring, controls } = props;
  const text = step.explanation[level];

  return (
    <div className="lesson-step" data-testid="lesson-step" data-step={step.id} data-kind={step.kind}>
      <div className="lesson-step-head">
        <h3>
          <span className="lesson-kind" data-kind={step.kind}>
            {step.kind}
          </span>{' '}
          {step.title}
        </h3>
        <div className="level-switch" role="tablist" data-testid="lesson-level-switch">
          {EXPLANATION_LEVELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`level-tab${entry.id === level ? ' active' : ''}`}
              data-level={entry.id}
              data-testid={`lesson-level-${entry.id}`}
              aria-selected={entry.id === level}
              disabled={step.explanation[entry.id as ExplanationLevelId] === null}
              onClick={() => onLevel(entry.id as ExplanationLevelId)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {/* Exactly one. The switch replaces; it never stacks. */}
      <p className="lesson-explanation" data-testid="lesson-explanation" data-shown-level={level}>
        {text ?? `This step has no ${level} copy yet — the module is an outline.`}
      </p>

      {step.goDeeper !== null && (
        <details className="lesson-godeeper" data-testid="lesson-godeeper">
          <summary>{step.goDeeper.title}</summary>
          <p>{step.goDeeper.body}</p>
          <Citations citations={step.goDeeper.citations} onSelectSymbol={wiring.selectSymbol} />
        </details>
      )}

      <Claim step={step} onSelectSymbol={wiring.selectSymbol} />

      <div className="lesson-control" data-testid="lesson-control" data-control={step.manipulate.control}>
        <p className="lesson-affordance">{step.manipulate.affordance}</p>
        <StepControl step={step} wiring={wiring} controls={controls} />
      </div>

      <Expect step={step} />

      <CheckPanel
        lesson={lesson}
        success={step.success}
        outcome={outcome}
        record={record}
        onSkip={onSkip}
        onUnskip={onUnskip}
        failureIsNormal={step.success.failureIsNormal}
      />
    </div>
  );
}

// ==================================================================== claim

function Claim(props: {
  readonly step: LessonStep;
  readonly onSelectSymbol: (id: string) => void;
}): ReactElement {
  const { step, onSelectSymbol } = props;
  const claim = step.claim;
  return (
    <div className="lesson-claim" data-testid="lesson-claim" data-claim-type={claim.type} data-claim-domain={claim.domain}>
      <p className="lesson-claim-text">{claim.text}</p>

      {claim.conceptualReason !== null && (
        <p className="lesson-claim-conceptual" data-testid="claim-conceptual-reason">
          <b>Conceptual:</b> {claim.conceptualReason}
        </p>
      )}

      {/*
        A different register entirely from the prose above. `boundaryNote` is
        where a FACTUAL claim says which world its fact belongs to — the
        library's, the emulator's, or Sesame Lab's — and reading it as a hedge
        on a Sesame fact gets it exactly backwards.
      */}
      {claim.boundaryNote !== null && (
        <div className="lesson-boundary" data-testid="lesson-boundary-note" data-domain={claim.domain}>
          <span className="lesson-boundary-label">
            {claim.domain === 'library'
              ? 'this fact is about a pinned LIBRARY, not about Sesame source'
              : claim.domain === 'emulator'
                ? 'this fact is about the EMULATOR, not about Sesame source'
                : claim.domain === 'lab'
                  ? 'this fact is about SESAME LAB itself, not about the robot'
                  : 'boundary'}
          </span>
          <p>{claim.boundaryNote}</p>
          {claim.observability !== null && (
            <p className="lesson-observability" data-testid="lesson-observability">
              observability: <b>{claim.observability}</b>
            </p>
          )}
        </div>
      )}

      <Citations citations={claim.citations} onSelectSymbol={onSelectSymbol} />
    </div>
  );
}

function Citations(props: {
  readonly citations: readonly LessonCitation[];
  readonly onSelectSymbol: (id: string) => void;
}): ReactElement {
  const { citations, onSelectSymbol } = props;
  return (
    <p className="lesson-citations" data-testid="lesson-citations">
      {citations.map((citation, index) => {
        const key = `${citation.kind}-${String(index)}`;
        if (citation.kind === 'symbol' && citation.symbol !== undefined) {
          return (
            <button
              key={key}
              type="button"
              className="linkish mono cite cite-symbol"
              data-cite-symbol={citation.symbol}
              onClick={() => onSelectSymbol(citation.symbol as string)}
              title={citation.signature ?? ''}
            >
              {citation.file?.split('/').pop() ?? '?'}:{citation.startLine ?? '?'}
            </button>
          );
        }
        const label =
          citation.kind === 'hardware-map'
            ? `hardware-map ${citation.path ?? ''}`
            : citation.kind === 'library'
              ? `${citation.library ?? ''} ${citation.version ?? ''}`
              : citation.kind === 'document'
                ? `${citation.doc ?? ''}${citation.evidenceTag == null ? '' : ` [${citation.evidenceTag}]`}`
                : citation.kind === 'teaching-note'
                  ? String(citation.note ?? '')
                  : String(citation.id ?? citation.kind);
        return (
          <span key={key} className={`cite cite-${citation.kind}`} title={citation.title ?? ''}>
            {label}
          </span>
        );
      })}
    </p>
  );
}

function Expect(props: { readonly step: LessonStep }): ReactElement | null {
  const { step } = props;
  // `null` on an outline step: the cause-and-effect text is unwritten, and an
  // empty box would read as "nothing is expected to happen".
  if (step.expect === null) return null;
  return (
    <div className="lesson-expect" data-testid="lesson-expect">
      <p>{step.expect.text}</p>
      <ul className="lesson-observables">
        {step.expect.observable.map((observable) => (
          <li key={observable.traceLayer}>
            <span className="mono lesson-layer">{observable.traceLayer}</span> {observable.what}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================= check panel

function CheckPanel(props: {
  readonly lesson: Lesson;
  readonly success: LessonSuccess;
  readonly outcome: CheckOutcome | null;
  readonly record: ReturnType<typeof recordFor>;
  readonly onSkip: () => void;
  readonly onUnskip: () => void;
  readonly failureIsNormal: string | null;
}): ReactElement {
  const { success, outcome, record, onSkip, onUnskip, failureIsNormal } = props;
  const status = record?.outcome === 'passed' ? 'passed' : (outcome?.status ?? 'pending');
  return (
    <div
      className={`lesson-check is-${status}`}
      data-testid="lesson-check"
      data-success={success.id}
      data-check-type={String(success.check.type)}
      data-status={status}
      data-skipped={String(record?.outcome === 'skipped')}
    >
      <div className="lesson-check-head">
        <span className="lesson-check-status">{statusWord(status)}</span>
        <span className="mono lesson-check-type">{String(success.check.type)}</span>
      </div>
      <p className="lesson-check-summary" data-testid="lesson-check-summary">
        {outcome?.summary ?? success.description}
      </p>
      {(outcome?.expected ?? null) !== null && (
        <dl className="lesson-check-detail">
          <div>
            <dt>expected</dt>
            <dd className="mono" data-testid="lesson-check-expected">
              {outcome?.expected}
            </dd>
          </div>
          <div>
            <dt>observed</dt>
            <dd className="mono" data-testid="lesson-check-observed">
              {outcome?.observed ?? '—'}
            </dd>
          </div>
        </dl>
      )}
      {failureIsNormal !== null && (
        <p className="lesson-failure-normal" data-testid="lesson-failure-normal">
          {failureIsNormal}
        </p>
      )}
      {status !== 'passed' && <p className="lesson-hint">Hint: {success.hint}</p>}
      <div className="editor-row">
        {record?.outcome === 'skipped' ? (
          <>
            <span className="lesson-skipped-note" data-testid="lesson-skipped">
              recorded as <b>skipped</b>, not passed — it unlocks nothing
            </span>
            <button type="button" className="linkish" data-testid="lesson-unskip" onClick={onUnskip}>
              come back to it
            </button>
          </>
        ) : (
          status !== 'passed' && (
            <button type="button" className="linkish" data-testid="lesson-skip" onClick={onSkip}>
              skip this step (recorded as skipped)
            </button>
          )
        )}
      </div>
    </div>
  );
}

function statusWord(status: string): string {
  switch (status) {
    case 'passed':
      return 'PASSED';
    case 'failed':
      return 'NOT YET — the state says otherwise';
    case 'unsupported':
      return 'NOT BUILT';
    default:
      return 'waiting for the robot';
  }
}

// ============================================================== challenges

function Challenges(props: {
  readonly lesson: Lesson;
  readonly progress: ProgressState;
  readonly outcomes: Readonly<Record<string, CheckOutcome>>;
}): ReactElement | null {
  const { lesson, progress, outcomes } = props;
  if (lesson.challenges.length === 0) return null;
  return (
    <div className="lesson-challenges" data-testid="lesson-challenges">
      <h4>Challenges</h4>
      {lesson.challenges.map((challenge: LessonChallenge) => {
        const unlocked = challengeUnlocked(progress, lesson.id, challenge.unlockedBy);
        const record = recordFor(progress, lesson.id, challenge.success.id);
        const status = record?.outcome === 'passed' ? 'passed' : (outcomes[challenge.success.id]?.status ?? 'pending');
        return (
          <div
            key={challenge.id}
            className={`lesson-challenge${unlocked ? '' : ' is-locked'}`}
            data-testid={`challenge-${challenge.id}`}
            data-unlocked={String(unlocked)}
            data-status={status}
          >
            <b>{challenge.title}</b> <span className="badge">{challenge.level}</span>
            {unlocked ? (
              <p className="note">
                {outcomes[challenge.success.id]?.summary ?? challenge.success.description}
              </p>
            ) : (
              <p className="note muted">
                Opens when you have <b>demonstrated</b> <code>{challenge.unlockedBy}</code>. Not a
                timer, and a skipped step does not count.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ================================================================= outlines

function OutlineBody(props: { readonly lesson: Lesson; readonly locked: boolean }): ReactElement {
  const { lesson, locked } = props;
  return (
    <div className="lesson-outline" data-testid="lesson-outline">
      {locked && lesson.status === 'polished' ? (
        <p className="lesson-outline-note">
          <b>This module is written and playable — once its prerequisites are passed.</b> Until then
          it is shown the way an outline is: readable, with every step&rsquo;s control and check
          named, and nothing pretending to be checkable.
        </p>
      ) : (
      <p className="lesson-outline-note">
        <b>This module is an outline.</b> Its goal, its ordered steps, its grounding and every
        citation are settled and machine-checked, but the <code>beginnerProgrammer</code> and{' '}
        <code>architecture</code> copy and the full cause-and-effect text are unwritten, and the
        runner does not play it. Reading it is honest; pretending it were playable would not be.
      </p>
      )}
      <p className="lesson-goal">{lesson.learningGoal}</p>
      <ol className="lesson-outline-steps">
        {lesson.steps.map((step) => (
          <li key={step.id} data-testid={`outline-step-${step.id}`}>
            <b>{step.title}</b>{' '}
            <span className="lesson-kind" data-kind={step.kind}>
              {step.kind}
            </span>
            <p className="note">{step.explanation.beginner12}</p>
            <p className="note muted small">
              control <code>{step.manipulate.control}</code>
              {!isControlImplemented(step.manipulate.control) && (
                <span className="badge is-notbuilt"> not built</span>
              )}{' '}
              &middot; check <code>{String(step.success.check.type)}</code>
            </p>
            {step.claim.boundaryNote !== null && (
              <div className="lesson-boundary" data-domain={step.claim.domain}>
                <span className="lesson-boundary-label">boundary</span>
                <p>{step.claim.boundaryNote}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="note muted small">
        Leaves behind for Lab: {lesson.labHandoff}
      </p>
    </div>
  );
}

// ================================================================= controls

/** The refusal. Loud, named, and impossible to mistake for a rendered control. */
function NotBuilt(props: { readonly kind: string }): ReactElement {
  return (
    <div className="lesson-notbuilt" data-testid="lesson-control-notbuilt" data-control-kind={props.kind}>
      <b>This control is not built yet: {props.kind}.</b>
      <p>{CONTROL_NOT_BUILT_REASON[props.kind] ?? 'Not implemented by the lesson runner.'}</p>
    </div>
  );
}

function StepControl(props: {
  readonly step: LessonStep;
  readonly wiring: LessonWiring;
  readonly controls: ControlBag;
}): ReactElement {
  const { step, wiring, controls } = props;
  const kind = step.manipulate.control;
  if (!isControlImplemented(kind)) return <NotBuilt kind={kind} />;
  const target = step.manipulate.target;
  const check = step.success.check;

  switch (kind) {
    case 'robot-explode': {
      const wanted = Array.isArray(check['joints']) ? (check['joints'] as JointName[]) : JOINT_ORDER;
      const asking = wanted[controls.quizIndex] ?? null;
      const answers = wiring.runtime.snapshot().quiz.jointNaming;
      return (
        <>
          <RobotExplode
            board={wiring.runtime.board}
            selected={wiring.selection.joint}
            onSelectJoint={wiring.selectJoint}
            explode={controls.explode}
            onExplode={controls.setExplode}
            labelsHidden={asking !== null}
            showTopCover={wiring.showTopCover}
            onToggleTopCover={wiring.onToggleTopCover}
            askingFor={asking}
            onAnswer={(picked) => {
              if (asking === null) return;
              wiring.runtime.answerJointNaming(asking, picked);
              // Only a CORRECT answer advances. A wrong one is recorded, the
              // check reads failed, and the same joint is asked again — which
              // is what makes the naming quiz retryable rather than a trap.
              if (picked === asking) {
                controls.setQuizIndex(Math.min(controls.quizIndex + 1, wanted.length));
              }
            }}
            answers={answers}
          />
          <p className="lesson-quiz" data-testid="joint-quiz" data-asking={asking ?? ''}>
            {asking === null ? (
              <>All {wanted.length} named. Turn the labels back on by reloading the step.</>
            ) : (
              <>
                Which module does the firmware call <b className="mono">{asking}</b>? Click it.{' '}
                <span className="muted">
                  ({controls.quizIndex} of {wanted.length})
                </span>
              </>
            )}
          </p>
        </>
      );
    }

    case 'board-selector': {
      const options = Array.isArray(step.manipulate.bounds?.['options'])
        ? (step.manipulate.bounds['options'] as string[])
        : Object.keys(SERVO_PINS_BY_BOARD);
      return (
        <div className="editor-row" data-testid="board-selector">
          {options.map((board) => (
            <button
              key={board}
              type="button"
              className={`lesson-button${wiring.runtime.board === board ? ' is-primary' : ''}`}
              data-testid={`board-${board}`}
              onClick={() => wiring.setBoard(board)}
            >
              {board}
            </button>
          ))}
          <span className="muted small mono">
            {JOINT_ORDER.map((j) => `${j}:${String(SERVO_PINS_BY_BOARD[wiring.runtime.board]?.[j] ?? '?')}`).join('  ')}
          </span>
        </div>
      );
    }

    case 'graph-node-picker':
      return (
        <div className="editor-row" data-testid="graph-node-picker">
          <button
            type="button"
            className="lesson-button is-primary"
            data-testid={`graph-node-${target}`}
            onClick={() => wiring.selectNode(target)}
          >
            select the {target} node in the architecture graph
          </button>
          <span className="muted small">then follow it down to the source span it names</span>
        </div>
      );

    case 'pose-runner':
    case 'command-button':
      return (
        <div className="editor-row" data-testid="pose-runner">
          {[target, ...MOVEMENT_COMMANDS.filter((c) => c !== target).slice(0, 5)].map((command) => (
            <button
              key={command}
              type="button"
              className={`lesson-button${command === target ? ' is-primary' : ''}`}
              data-testid={`run-${command}`}
              // NOT disabled while something is running. The firmware takes a
              // command word at any moment — that is what makes cancelling a
              // walk possible at all — and `busy` only means this app is
              // awaiting a promise. (The in-process simulator serialises the
              // two calls rather than interrupting, so what a learner sees here
              // is the second command arriving after the first, not the
              // firmware’s pressingCheck() cancel path.)
              onClick={() => void wiring.runCommand(command)}
            >
              {command}
            </button>
          ))}
          <button
            type="button"
            className="lesson-button"
            data-testid="run-stop"
            onClick={() => void wiring.runCommand('stop')}
          >
            stop
          </button>
          {check.type === 'movement-joints-identified' && (
            <JointSetQuiz
              movement={String(check['movement'] ?? '')}
              guess={controls.jointGuess}
              onGuess={controls.setJointGuess}
              onSubmit={(joints) =>
                wiring.runtime.answerMovementJoints(String(check['movement'] ?? ''), joints)
              }
            />
          )}
          {check.type === 'face-mode-identified' && (
            <ModeQuiz
              movement={String(check['movement'] ?? '')}
              onPick={(mode) => wiring.runtime.answerFaceMode(String(check['movement'] ?? ''), mode)}
            />
          )}
          {/*
            "Send wave and watch the dispatcher" ends in the source, not in the
            button: the step's check names a span. The follow-through is here so
            the lesson is playable without the learner having to know which file
            tab the dispatcher lives in.
          */}
          {check.type === 'source-span-selected' && typeof check['symbol'] === 'string' && (
            <button
              type="button"
              className="lesson-button"
              data-testid={`open-symbol-${String(check['symbol'])}`}
              onClick={() => wiring.selectSymbol(String(check['symbol']))}
            >
              open {String(check['symbol'])} in the source explorer
            </button>
          )}
        </div>
      );

    case 'joint-slider': {
      const joint = (JOINT_ORDER as readonly string[]).includes(target)
        ? (target as JointName)
        : 'R1';
      return (
        <div className="editor-row" data-testid="joint-slider">
          <span className="mono editor-label">{joint}</span>
          <input
            type="range"
            min={Number(step.manipulate.bounds?.['min'] ?? 0)}
            max={Number(step.manipulate.bounds?.['max'] ?? 180)}
            step={Number(step.manipulate.bounds?.['step'] ?? 1)}
            value={controls.sliderDeg}
            data-testid="joint-slider-input"
            onChange={(e) => controls.setSliderDeg(Number(e.target.value))}
          />
          <span className="mono editor-value">{controls.sliderDeg}&deg;</span>
          <button
            type="button"
            className="lesson-button is-primary"
            data-testid="joint-slider-send"
            onClick={() => void wiring.setJoint(joint, controls.sliderDeg)}
          >
            command it
          </button>
          <span className="muted small mono">
            robot reports {wiring.joints[joint]?.commandedDeg ?? '— never commanded'}
          </span>
        </div>
      );
    }

    case 'channel-number':
      return (
        <div className="editor-row" data-testid="channel-number">
          <label className="editor-row">
            <span className="editor-label">channel</span>
            <input
              className="mono sequence-cell"
              data-testid="channel-input"
              value={controls.channelInput}
              onChange={(e) => controls.setChannelInput(e.target.value)}
            />
          </label>
          <label className="editor-row">
            <span className="editor-label">angle</span>
            <input
              className="mono sequence-cell"
              data-testid="channel-angle"
              value={controls.channelAngle}
              onChange={(e) => controls.setChannelAngle(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="lesson-button is-primary"
            data-testid="channel-send"
            onClick={() =>
              void wiring.setChannel(
                Number.parseInt(controls.channelInput, 10),
                Number.parseInt(controls.channelAngle, 10),
              )
            }
          >
            setServoAngle()
          </button>
          <p className="note muted small">
            Channels are 0&ndash;7. The model&rsquo;s <code>setServoAngle()</code> reproduces the
            firmware&rsquo;s <code>if (channel &lt; 8)</code> guard exactly: out of range, it returns
            without writing, without logging and without a return code, so nothing reaches the wire.
            Watch the trace, not the robot.
          </p>
        </div>
      );

    case 'subtrim-control': {
      const joint = (JOINT_ORDER as readonly string[]).includes(target) ? (target as JointName) : null;
      return (
        <>
          <SubtrimControl
            value={wiring.runtime.subtrimDeg}
            onChange={wiring.setSubtrim}
            only={joint}
            reported={Object.fromEntries(JOINT_ORDER.map((j) => [j, wiring.joints[j]?.subtrimDeg ?? null]))}
            disabled={!wiring.canSetSubtrim}
          />
          {!wiring.canSetSubtrim && (
            <p className="note is-fail">
              This backend cannot be given a subtrim offset from the lab. Switch to the in-process
              simulator.
            </p>
          )}
          <JointSendRow wiring={wiring} joint={joint ?? 'R1'} controls={controls} />
        </>
      );
    }

    case 'pwm-inspector':
      return (
        <PwmInspector
          angleDeg={controls.pwmAngle}
          onAngle={(deg) => {
            controls.setPwmAngle(deg);
            wiring.probePwm(deg);
          }}
          probed={wiring.runtime.snapshot().pwmProbes.map((p) => p.angleDeg)}
          onSweep={() => wiring.runtime.noteSweep()}
          sweepRuns={wiring.runtime.snapshot().sweepRuns}
        />
      );

    case 'trace-inspector':
      return (
        <TraceQuiz
          layer={String(check['traceLayer'] ?? target)}
          check={String(check.type)}
          field={typeof check['field'] === 'string' ? check['field'] : null}
          layers={
            Array.isArray(check['traceLayers']) ? (check['traceLayers'] as string[]) : null
          }
          wiring={wiring}
        />
      );

    case 'source-selector': {
      const symbol = typeof check['symbol'] === 'string' ? check['symbol'] : target;
      const fromTrace = check['reachedFrom'] === 'trace-row';
      return (
        <div className="editor-row" data-testid="source-selector">
          <button
            type="button"
            className={`lesson-button${fromTrace ? '' : ' is-primary'}`}
            data-testid={`open-symbol-${symbol}`}
            onClick={() => wiring.selectSymbol(symbol)}
          >
            open {symbol} in the source explorer
          </button>
          {fromTrace && (
            <button
              type="button"
              className="lesson-button is-primary"
              data-testid={`follow-trace-to-${symbol}`}
              onClick={() => wiring.followTraceRow(symbol)}
            >
              follow the trace row back into {symbol}
            </button>
          )}
          <span className="muted small">
            currently selected: <code>{wiring.selection.symbolId ?? 'nothing'}</code>
          </span>
        </div>
      );
    }

    case 'sequence-editor':
      return (
        <SequenceEditor
          doc={controls.sequence}
          onChange={controls.setSequence}
          onImport={(fn) => {
            const imported = importMovement(fn);
            if (imported !== null) controls.setSequence(imported.doc);
          }}
          onRun={(changedField) => {
            controls.setSequenceBusy(true);
            void wiring.runSequence(controls.sequence, changedField).finally(() => {
              controls.setSequenceBusy(false);
            });
          }}
          running={controls.sequenceBusy}
          importOnly={target === 'new' ? null : target}
        />
      );

    case 'face-picker':
      return (
        <div className="editor-row" data-testid="face-picker">
          {[target, ...FACE_NAMES.filter((f) => f !== target).slice(0, 7)].map((face) => (
            <button
              key={face}
              type="button"
              className={`lesson-button${face === target ? ' is-primary' : ''}`}
              data-testid={`face-${face}`}
              onClick={() => void wiring.setFace(face)}
            >
              {face}
            </button>
          ))}
          <span className="muted small">
            robot reports <code>{wiring.model?.faceName ?? '—'}</code> frame{' '}
            {wiring.model?.faceFrame ?? '—'}
          </span>
        </div>
      );

    case 'pixel-editor': {
      const changed = countLitPixels(controls.pixel);
      const w = Number(check['regionWidth'] ?? 5);
      const h = Number(check['regionHeight'] ?? 5);
      const densest = changed === 0 ? null : densestWindow(controls.pixel, w, h);
      return (
        <PixelEditor
          frame={controls.pixel}
          onPaint={(x, y, on) => {
            controls.setPixel((previous) => paintPixel(previous, x, y, on));
          }}
          onClear={() => {
            controls.setPixel(blankFrame());
          }}
          onPush={() => wiring.pushPixelFrame(controls.pixel)}
          changed={changed}
          densest={densest}
        />
      );
    }

    case 'fault-injector':
      return (
        <FaultInjector
          active={wiring.runtime.faults}
          onToggle={(id, on) => wiring.runtime.setFault(id, on)}
          only={target === 'random' || target === 'catalogue' ? null : target}
          onSelectSymbol={wiring.selectSymbol}
          onBoot={wiring.runBoot}
          bootLog={wiring.runtime.snapshot().bootRuns.at(-1)?.log}
          bootHaltedAt={wiring.runtime.snapshot().bootRuns.at(-1)?.haltedAt}
        />
      );

    case 'http-console':
      return (
        <HttpConsole
          onSend={(method, route, body) => {
            controls.setHttpBusy(true);
            void wiring.sendHttp(method, route, body).finally(() => {
              controls.setHttpBusy(false);
            });
          }}
          exchanges={wiring.runtime.snapshot().http}
          defaultRoute={target.startsWith('/') ? target : '/api/status'}
          defaultMethod={String(check['method'] ?? 'GET')}
          defaultBody={'{"command":"wiggle"}'}
          busy={controls.httpBusy}
        />
      );

    default:
      return <NotBuilt kind={kind} />;
  }
}

function JointSendRow(props: {
  readonly wiring: LessonWiring;
  readonly joint: JointName;
  readonly controls: ControlBag;
}): ReactElement {
  const { wiring, joint, controls } = props;
  return (
    <div className="editor-row" data-testid="subtrim-send">
      <span className="mono editor-label">command {joint}</span>
      <input
        type="range"
        min={0}
        max={180}
        step={1}
        value={controls.sliderDeg}
        data-testid="subtrim-angle"
        onChange={(e) => controls.setSliderDeg(Number(e.target.value))}
      />
      <span className="mono editor-value">{controls.sliderDeg}&deg;</span>
      <button
        type="button"
        className="lesson-button is-primary"
        data-testid="subtrim-send-button"
        onClick={() => void wiring.setJoint(joint, controls.sliderDeg)}
      >
        send
      </button>
      <span className="muted small mono">
        robot commanded {wiring.joints[joint]?.commandedDeg ?? '—'}&deg;
      </span>
    </div>
  );
}

function JointSetQuiz(props: {
  readonly movement: string;
  readonly guess: readonly JointName[];
  readonly onGuess: (joints: readonly JointName[]) => void;
  readonly onSubmit: (joints: readonly JointName[]) => void;
}): ReactElement {
  const { movement, guess, onGuess, onSubmit } = props;
  return (
    <div className="lesson-quiz" data-testid="movement-joint-quiz">
      <span>Which joints does {movement}&rsquo;s own body command?</span>
      {JOINT_ORDER.map((joint) => (
        <button
          key={joint}
          type="button"
          className={`lesson-button${guess.includes(joint) ? ' is-primary' : ''}`}
          data-testid={`quiz-joint-${joint}`}
          onClick={() =>
            onGuess(guess.includes(joint) ? guess.filter((j) => j !== joint) : [...guess, joint])
          }
        >
          {joint}
        </button>
      ))}
      <button
        type="button"
        className="lesson-button"
        data-testid="quiz-joint-submit"
        onClick={() => onSubmit(guess)}
      >
        that&rsquo;s my answer
      </button>
    </div>
  );
}

function ModeQuiz(props: {
  readonly movement: string;
  readonly onPick: (mode: string) => void;
}): ReactElement {
  return (
    <div className="lesson-quiz" data-testid="face-mode-quiz">
      <span>Which playback mode does {props.movement} set?</span>
      {['loop', 'once', 'pingpong'].map((mode) => (
        <button
          key={mode}
          type="button"
          className="lesson-button"
          data-testid={`quiz-mode-${mode}`}
          onClick={() => props.onPick(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function TraceQuiz(props: {
  readonly layer: string;
  readonly check: string;
  readonly field: string | null;
  readonly layers: readonly string[] | null;
  readonly wiring: LessonWiring;
}): ReactElement {
  const { layer, check, field, layers, wiring } = props;
  const rows = wiring.trace?.rows ?? [];
  const present = useMemo(() => new Set(rows.map((r) => r.layer)), [rows]);
  return (
    <div className="lesson-trace-quiz" data-testid="trace-inspector">
      <div className="editor-row">
        <button
          type="button"
          className="lesson-button is-primary"
          data-testid="trace-run-stand"
          onClick={() => void wiring.runCommand('stand')}
        >
          run stand
        </button>
        <span className="muted small">
          {rows.length} rows on screen &middot; {present.size} of 8 rungs
        </span>
      </div>
      {layers !== null && (
        <ul className="lesson-observables" data-testid="trace-rungs">
          {layers.map((l) => (
            <li key={l} data-rung={l} data-present={String(present.has(l as never))}>
              <span className="mono lesson-layer">{l}</span> {present.has(l as never) ? '✓' : '—'}
            </li>
          ))}
        </ul>
      )}
      {check === 'trace-badge-identified' && (
        <div className="lesson-quiz">
          <span>
            What is the <code className="mono">{layer}</code> row really claiming?
          </span>
          {PROVENANCE_BADGE_IDS.map((badge) => (
            <button
              key={badge}
              type="button"
              className="lesson-button"
              data-testid={`quiz-badge-${badge}`}
              onClick={() => wiring.runtime.answerTraceBadge(layer, badge)}
            >
              {badge}
            </button>
          ))}
        </div>
      )}
      {check === 'trace-field-absent' && field !== null && (
        <div className="lesson-quiz">
          <span>
            Find the field the <code className="mono">{layer}</code> row cannot show.
          </span>
          {['channel', 'pin', 'joint', 'µs'].map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="lesson-button"
              data-testid={`quiz-absent-${candidate}`}
              onClick={() => wiring.runtime.answerTraceFieldAbsent(layer, candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
