/**
 * What the lesson runner is allowed to check against.
 *
 * L5 wrote 74 success conditions and every one of them is an observable robot
 * or telemetry state — a commanded angle, a pose vector, a tick count, an
 * absent event, a face fallback, an HTTP status, a boot halt. Deliberately not
 * "clicked next". The runner's whole credibility rests on evaluating them
 * against **actual state**, so this module is the one place that records state,
 * and it records only three kinds of thing:
 *
 *  1. **A journal of telemetry events**, appended as they arrive from the
 *     backend. This is what makes an *absence* checkable: `telemetry-absent`
 *     asserts that no `servo.target` row arrived in a window after an action,
 *     and you cannot assert that against a store which only remembers the last
 *     value. Absence needs a timeline.
 *  2. **A journal of actions**, appended when the runner actually issues one.
 *     An action entry is never evidence *on its own* — `commanded-angle-collision`
 *     needs both the request the learner made and the angle the telemetry came
 *     back with, and it is the second of those that decides the check.
 *  3. **Lab state that no telemetry event carries**: which board profile is
 *     selected, what subtrim each channel holds, which faults are on, which
 *     angles the learner actually put into the PWM inspector, what the sequence
 *     and pixel editors contain, what real HTTP exchanges returned.
 *
 * ## What it is not
 *
 * It is not a record of "the learner pressed the button for step 3". No check
 * in `checks.ts` reads a step id, and there is no field here that a step could
 * set to mark itself done. The closest thing to an opinion this module stores
 * is a *quiz answer* — the badge a learner picked for a trace row, the joints
 * they think a movement commands — and every check that reads one also computes
 * the truth from live state and fails loudly if the two disagree. Picking the
 * right answer is necessary; it is never sufficient.
 */
import { JOINT_ORDER, jointIndex, type JointName } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';

import type { BootStep } from '../generated/lessons.js';
import type { SelectionOrigin } from '../state/selection.js';

/** One telemetry event, flattened to what a check needs, with a wall clock. */
export interface JournalEvent {
  readonly t: number;
  readonly seq: number;
  readonly type: string;
  readonly joint: JointName | null;
  readonly angleDeg: number | null;
  readonly name: string | null;
  readonly frame: number | null;
  readonly text: string | null;
}

/**
 * One thing the runner did, because a learner asked for it.
 *
 * `kind` is coarse on purpose — the detail that matters is in the typed fields
 * below and in the events the action produced.
 */
export interface JournalAction {
  readonly id: number;
  readonly t: number;
  readonly kind:
    | 'set-joint'
    | 'set-channel'
    | 'command'
    | 'set-face'
    | 'set-subtrim'
    | 'set-board'
    | 'pwm-probe'
    | 'pwm-sweep'
    | 'run-sequence'
    | 'http'
    | 'boot'
    | 'answer';
  readonly label: string;
  /** Sequence number of the last event seen BEFORE the action was issued. */
  readonly seqBefore: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** One request the learner actually sent, and what actually came back. */
export interface HttpExchange {
  readonly t: number;
  readonly method: string;
  readonly route: string;
  readonly body: string | null;
  /** `null` when the request never completed (no server, DNS, abort). */
  readonly status: number | null;
  readonly error: string | null;
  readonly responseText: string;
  /** Parsed body, when it parsed. A route that returns invalid JSON says so. */
  readonly json: unknown;
  readonly jsonError: string | null;
  /** True when a movement was still commanding joints as the reply landed. */
  readonly duringMovement: string | null;
}

/** One reading the learner took from the PWM inspector. Recomputed, not typed in. */
export interface PwmProbe {
  readonly t: number;
  readonly angleDeg: number;
  readonly mappedUs: number;
  readonly ticks: number;
  readonly pulseUs: number;
  readonly aliases: readonly number[];
}

/** One run of the lab's boot model, with whatever faults were on at the time. */
export interface BootRun {
  readonly t: number;
  readonly faults: readonly string[];
  /** Every step that executed, in order. */
  readonly reached: readonly number[];
  /** `bootOrder` of the step that stopped it, or `null` if boot completed. */
  readonly haltedAt: number | null;
  readonly log: readonly string[];
}

/** What a run of the sequence editor produced, read back off telemetry. */
export interface SequenceRun {
  readonly t: number;
  readonly label: string;
  readonly basedOnMovement: string | null;
  readonly changedField: string | null;
  readonly frameCount: number;
  /** Angles the learner authored that fell outside the firmware's 0–180. */
  readonly outOfRangeCount: number;
  /** The eight commanded angles observed AFTER the run, from telemetry. */
  readonly terminalPose: Readonly<Record<JointName, number | null>>;
  /** Every angle the run actually commanded, from `servo.target` events. */
  readonly commanded: readonly { joint: JointName; angleDeg: number }[];
}

/** What the pixel editor holds, measured against a blank 128x64 frame. */
export interface PixelEditState {
  readonly changed: number;
  /** Most changed pixels inside any single 5x5 window. Regions are checkable. */
  readonly bestWindow: { width: number; height: number; count: number } | null;
}

/** A learner's answer to a step that asks them to identify something. */
export interface QuizAnswers {
  /** joint name → the module the learner clicked when asked for that joint. */
  readonly jointNaming: Readonly<Record<string, string>>;
  /** movement → the joints the learner says its own body commands. */
  readonly movementJoints: Readonly<Record<string, readonly JointName[]>>;
  /** trace layer → the provenance badge the learner picked. */
  readonly traceBadge: Readonly<Record<string, string>>;
  /** `layer:field` → the learner asserted this field is not shown. */
  readonly traceFieldAbsent: Readonly<Record<string, boolean>>;
  /** movement → the face playback mode the learner picked. */
  readonly faceMode: Readonly<Record<string, string>>;
}

export interface LabSnapshot {
  readonly board: string;
  /** Every board the learner has selected, with the pin map that came with it. */
  readonly boardHistory: readonly {
    readonly board: string;
    readonly pins: Readonly<Record<string, number>>;
    readonly t: number;
  }[];
  readonly subtrimDeg: Readonly<Record<JointName, number>>;
  readonly faults: readonly string[];
  readonly pwmProbes: readonly PwmProbe[];
  readonly sweepRuns: number;
  readonly quiz: QuizAnswers;
  readonly sequenceRuns: readonly SequenceRun[];
  readonly pixel: PixelEditState | null;
  readonly http: readonly HttpExchange[];
  readonly bootRuns: readonly BootRun[];
}

export interface SymbolVisit {
  readonly t: number;
  readonly symbolId: string;
  readonly origin: SelectionOrigin | null;
}

/**
 * A sample of the backend's own model state, taken on the app's polling tick.
 *
 * Some things the lessons ask about are not events and are not the last value
 * of anything: `face-mode-identified` asks which playback mode a movement sets,
 * and `currentFaceMode` is a **global** that the next movement overwrites. By
 * the time `runWavePose` has finished, `enterIdle()` has already changed it. So
 * the mode has to be sampled *while the movement is running*, and that is what
 * this is: live readings off `RobotState`, kept only when something changed.
 */
export interface ModelSample {
  readonly t: number;
  readonly runningMovement: string | null;
  readonly faceName: string;
  readonly faceMode: string;
  readonly faceFrame: number;
}

const MAX_EVENTS = 3000;
const MAX_ACTIONS = 400;
const MAX_VISITS = 200;

function blankQuiz(): {
  jointNaming: Record<string, string>;
  movementJoints: Record<string, readonly JointName[]>;
  traceBadge: Record<string, string>;
  traceFieldAbsent: Record<string, boolean>;
  faceMode: Record<string, string>;
} {
  return { jointNaming: {}, movementJoints: {}, traceBadge: {}, traceFieldAbsent: {}, faceMode: {} };
}

/**
 * The runner's memory.
 *
 * Plain observable object, like `TelemetryStore` and for the same reason: the
 * event journal is appended to at 50 Hz during a wave and routing that through
 * React would re-render the whole lesson pane per servo write.
 */
export class LessonRuntime {
  #events: JournalEvent[] = [];
  #actions: JournalAction[] = [];
  #visits: SymbolVisit[] = [];
  #seq = 0;
  #actionId = 0;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  #board = 's2-mini';
  #boardHistory: { board: string; pins: Record<string, number>; t: number }[] = [];
  #subtrim: Record<JointName, number> = Object.fromEntries(
    JOINT_ORDER.map((j) => [j, 0]),
  ) as Record<JointName, number>;
  #faults = new Set<string>();
  #pwmProbes: PwmProbe[] = [];
  #sweepRuns = 0;
  #quiz = blankQuiz();
  #sequenceRuns: SequenceRun[] = [];
  #pixel: PixelEditState | null = null;
  #http: HttpExchange[] = [];
  #bootRuns: BootRun[] = [];
  #modelSamples: ModelSample[] = [];

  get version(): number {
    return this.#version;
  }

  get events(): readonly JournalEvent[] {
    return this.#events;
  }

  get actions(): readonly JournalAction[] {
    return this.#actions;
  }

  get symbolVisits(): readonly SymbolVisit[] {
    return this.#visits;
  }

  get seq(): number {
    return this.#seq;
  }

  get board(): string {
    return this.#board;
  }

  get subtrimDeg(): Readonly<Record<JointName, number>> {
    return this.#subtrim;
  }

  get faults(): ReadonlySet<string> {
    return this.#faults;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ------------------------------------------------------------- telemetry

  /**
   * Append one event.
   *
   * Called from the same `onEvent` handler that feeds `TelemetryStore` and
   * `TraceStore`, so the journal sees exactly what they see — not a
   * reconstruction, and not React's idea of it.
   */
  noteEvent(event: SesameTelemetry): void {
    this.#seq += 1;
    const row: JournalEvent = {
      t: Date.now(),
      seq: this.#seq,
      type: event.type,
      joint: event.type === 'servo.target' ? event.joint : null,
      angleDeg: event.type === 'servo.target' ? event.angleDeg : null,
      name: event.type === 'face.expression' ? event.name : null,
      frame: event.type === 'face.expression' ? (event.frame ?? 0) : null,
      text: event.type === 'log' ? event.text : null,
    };
    this.#events.push(row);
    if (this.#events.length > MAX_EVENTS) this.#events = this.#events.slice(-MAX_EVENTS);
    this.#bump();
  }

  /** Events that arrived strictly after an action was issued. */
  eventsAfter(action: JournalAction): readonly JournalEvent[] {
    return this.#events.filter((e) => e.seq > action.seqBefore);
  }

  /** Events that arrived after an action and within `windowMs` of it. */
  eventsInWindow(action: JournalAction, windowMs: number): readonly JournalEvent[] {
    return this.#events.filter((e) => e.seq > action.seqBefore && e.t - action.t <= windowMs);
  }

  // ---------------------------------------------------------------- actions

  noteAction(
    kind: JournalAction['kind'],
    label: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ): JournalAction {
    this.#actionId += 1;
    const action: JournalAction = {
      id: this.#actionId,
      t: Date.now(),
      kind,
      label,
      seqBefore: this.#seq,
      detail,
    };
    this.#actions.push(action);
    if (this.#actions.length > MAX_ACTIONS) this.#actions = this.#actions.slice(-MAX_ACTIONS);
    this.#bump();
    return action;
  }

  /** Most recent action of a kind, optionally matching a predicate. */
  lastAction(
    kind: JournalAction['kind'],
    where?: (action: JournalAction) => boolean,
  ): JournalAction | null {
    for (let i = this.#actions.length - 1; i >= 0; i -= 1) {
      const action = this.#actions[i];
      if (action === undefined || action.kind !== kind) continue;
      if (where !== undefined && !where(action)) continue;
      return action;
    }
    return null;
  }

  actionsOfKind(kind: JournalAction['kind']): readonly JournalAction[] {
    return this.#actions.filter((a) => a.kind === kind);
  }

  // ------------------------------------------------------------- selection

  /**
   * Record that a source symbol became selected, and from where.
   *
   * `source-span-selected` sometimes carries `reachedFrom` — `delayWithFace`
   * must be reached *from* `setServoAngle`, and `setServoAngle` must be reached
   * from a trace row. Neither is answerable from the current selection alone,
   * so the last few are kept.
   */
  noteSymbolVisit(symbolId: string, origin: SelectionOrigin | null): void {
    const last = this.#visits[this.#visits.length - 1];
    if (last !== undefined && last.symbolId === symbolId && last.origin === origin) return;
    this.#visits.push({ t: Date.now(), symbolId, origin });
    if (this.#visits.length > MAX_VISITS) this.#visits = this.#visits.slice(-MAX_VISITS);
    this.#bump();
  }

  // ------------------------------------------------------------- lab state

  setBoard(board: string, pins: Readonly<Record<string, number>>): void {
    this.#board = board;
    this.#boardHistory.push({ board, pins: { ...pins }, t: Date.now() });
    if (this.#boardHistory.length > 20) this.#boardHistory = this.#boardHistory.slice(-20);
    this.noteAction('set-board', `board → ${board}`, { board });
  }

  setSubtrim(joint: JointName, deg: number): void {
    this.#subtrim = { ...this.#subtrim, [joint]: deg };
    this.noteAction('set-subtrim', `subtrim ${joint} = ${String(deg)}`, { joint, deg });
  }

  /** The channel-order array the simulator reads. Index is the firmware index. */
  subtrimArray(): number[] {
    return JOINT_ORDER.map((j) => this.#subtrim[j]);
  }

  setFault(id: string, on: boolean): void {
    if (on) this.#faults.add(id);
    else this.#faults.delete(id);
    this.noteAction('answer', `fault ${id} ${on ? 'on' : 'off'}`, { fault: id, on });
  }

  notePwmProbe(probe: Omit<PwmProbe, 't'>): void {
    this.#pwmProbes.push({ ...probe, t: Date.now() });
    if (this.#pwmProbes.length > 400) this.#pwmProbes = this.#pwmProbes.slice(-400);
    this.noteAction('pwm-probe', `pwm ${String(probe.angleDeg)}°`, {
      angleDeg: probe.angleDeg,
      ticks: probe.ticks,
    });
  }

  noteSweep(): void {
    this.#sweepRuns += 1;
    this.noteAction('pwm-sweep', 'swept 0–180', { runs: this.#sweepRuns });
  }

  answerJointNaming(joint: JointName, picked: string): void {
    this.#quiz = { ...this.#quiz, jointNaming: { ...this.#quiz.jointNaming, [joint]: picked } };
    this.noteAction('answer', `named ${joint} as ${picked}`, { joint, picked });
  }

  answerMovementJoints(movement: string, joints: readonly JointName[]): void {
    this.#quiz = {
      ...this.#quiz,
      movementJoints: { ...this.#quiz.movementJoints, [movement]: [...joints] },
    };
    this.noteAction('answer', `${movement} commands ${joints.join(' ')}`, {
      movement,
      joints: joints.join(' '),
    });
  }

  answerTraceBadge(layer: string, badge: string): void {
    this.#quiz = { ...this.#quiz, traceBadge: { ...this.#quiz.traceBadge, [layer]: badge } };
    this.noteAction('answer', `${layer} badge = ${badge}`, { layer, badge });
  }

  answerTraceFieldAbsent(layer: string, field: string): void {
    this.#quiz = {
      ...this.#quiz,
      traceFieldAbsent: { ...this.#quiz.traceFieldAbsent, [`${layer}:${field}`]: true },
    };
    this.noteAction('answer', `${layer} has no ${field}`, { layer, field });
  }

  answerFaceMode(movement: string, mode: string): void {
    this.#quiz = { ...this.#quiz, faceMode: { ...this.#quiz.faceMode, [movement]: mode } };
    this.noteAction('answer', `${movement} face mode = ${mode}`, { movement, mode });
  }

  noteSequenceRun(run: SequenceRun): void {
    this.#sequenceRuns.push(run);
    if (this.#sequenceRuns.length > 12) this.#sequenceRuns = this.#sequenceRuns.slice(-12);
    this.#bump();
  }

  setPixelState(state: PixelEditState | null): void {
    this.#pixel = state;
    this.#bump();
  }

  noteHttp(exchange: HttpExchange): void {
    this.#http.push(exchange);
    if (this.#http.length > 40) this.#http = this.#http.slice(-40);
    this.#bump();
  }

  /**
   * Fold in one reading of the backend's model state.
   *
   * Deduped on content: the app polls this at ~8 Hz and an idle robot would
   * otherwise fill the ring with identical rows and push the one interesting
   * sample — the mode set *during* a movement — off the end.
   */
  noteModelSample(sample: Omit<ModelSample, 't'>): void {
    const last = this.#modelSamples[this.#modelSamples.length - 1];
    if (
      last !== undefined &&
      last.runningMovement === sample.runningMovement &&
      last.faceName === sample.faceName &&
      last.faceMode === sample.faceMode &&
      last.faceFrame === sample.faceFrame
    ) {
      return;
    }
    this.#modelSamples.push({ ...sample, t: Date.now() });
    if (this.#modelSamples.length > 600) this.#modelSamples = this.#modelSamples.slice(-600);
    // Deliberately no #bump(): a face frame changing 20 times a second must not
    // re-render the lesson pane. The check evaluator reads this on its own tick.
  }

  modelSamples(): readonly ModelSample[] {
    return this.#modelSamples;
  }

  noteBootRun(run: BootRun): void {
    this.#bootRuns.push(run);
    if (this.#bootRuns.length > 10) this.#bootRuns = this.#bootRuns.slice(-10);
    this.#bump();
  }

  snapshot(): LabSnapshot {
    return {
      board: this.#board,
      boardHistory: this.#boardHistory,
      subtrimDeg: this.#subtrim,
      faults: [...this.#faults],
      pwmProbes: this.#pwmProbes,
      sweepRuns: this.#sweepRuns,
      quiz: this.#quiz,
      sequenceRuns: this.#sequenceRuns,
      pixel: this.#pixel,
      http: this.#http,
      bootRuns: this.#bootRuns,
    };
  }

  /** A backend swap is a different robot; the journal must not survive it. */
  resetTelemetry(): void {
    this.#events = [];
    this.#actions = [];
    this.#seq = 0;
    this.#sequenceRuns = [];
    this.#http = [];
    this.#modelSamples = [];
    this.#bump();
  }

  #bump(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Run the lab's model of `setup()`, given the faults currently switched on.
 *
 * This is **the lab's model, not the emulator's**. It walks the twenty
 * `bootOrder` entries `hardware/hardware-map.json` extracted from the firmware
 * and stops at the one entry whose `bootBlocker` is true when the display fault
 * is on. Two of the faults reach it:
 *
 *  - `oled-init-fail` makes `display.begin()` return false;
 *  - `oled-wrong-address` addresses the panel at 0x3D, and an SSD1306 that does
 *    not answer is the same `display.begin()` false.
 *
 * The `while (1);` and the printed line are real firmware — `bootBlocker` and
 * the message both come out of the map — but *making* `display.begin()` fail on
 * demand is a Sesame Robot Emulator injection, and the fault catalogue says so.
 */
export function runBootModel(
  steps: readonly BootStep[],
  faults: readonly string[],
): Omit<BootRun, 't'> {
  const displayFails = faults.includes('oled-init-fail') || faults.includes('oled-wrong-address');
  const reached: number[] = [];
  const log: string[] = [];
  for (const step of steps) {
    reached.push(step.order);
    if (step.bootBlocker && displayFails) {
      if (step.haltMessage !== null) log.push(step.haltMessage);
      log.push('while (1);  — nothing after this point executes');
      return { faults: [...faults], reached, haltedAt: step.order, log };
    }
  }
  log.push('setup() completed; loop() is running');
  return { faults: [...faults], reached, haltedAt: null, log };
}

/** `jointIndex`, re-exported so controls do not each import the model package. */
export const channelOf = (joint: JointName): number => jointIndex(joint);
