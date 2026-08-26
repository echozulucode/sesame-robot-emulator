/**
 * The 34 success conditions, evaluated against actual state.
 *
 * This is the file the runner's credibility lives in. L5's contract is that a
 * success condition is an **observable robot or telemetry state** — a commanded
 * angle, a pose vector, a tick count, an absent event, a face fallback, an HTTP
 * status, a boot halt — and deliberately not "clicked next". So:
 *
 *  - **No evaluator reads a step id, and none can be satisfied by pressing a
 *    button.** A check passes because the robot reached the asserted state.
 *  - **No evaluator returns `passed` by default.** Every arm either finds the
 *    state it needs or returns `pending`/`failed`. The 8 check types this task
 *    did not build return {@link UNSUPPORTED}, which the UI renders as a loud
 *    refusal and which can never become `passed`.
 *  - **Derived numbers are recomputed, never trusted.** `quantisation-collision`
 *    does not read `expectTicks` and believe it: it calls
 *    `quantiseCommandedAngle()` from `@sesame-lab/sesame-model` — the same
 *    arithmetic the trace panel uses — and if the recomputed value disagrees
 *    with what `lessons.json` asserts, the check **fails loudly** naming both
 *    numbers. A lesson cannot teach a wrong constant through this runner.
 *  - **Quiz answers are necessary and never sufficient.** Four checks ask the
 *    learner to identify something (a badge, a joint, a set of joints, a
 *    playback mode). Each one also computes the truth from live state and
 *    compares *that* to the lesson's expectation. Picking the right answer to a
 *    question the system disagrees with fails.
 *
 * ## `pending` vs `failed`
 *
 * `failed` is reserved for "you did the thing and the state contradicts the
 * assertion" — the learner sent channel 3 when the step is about channel 8, the
 * two angles did not collide, the boot completed instead of halting. It is the
 * signal that makes a check *falsifiable*, and the capture harness asserts one
 * fires. `pending` is "not demonstrated yet", which is the resting state and is
 * never an error.
 */
import {
  quantiseCommandedAngle,
  SERVO_PULSE_QUANTISATION,
  type JointName,
} from '@sesame-lab/sesame-model';

import { COMMAND_TRACE_FACTS, SERVO_PINS_BY_BOARD } from '../generated/architecture-graph.js';
import type { CheckTypeId, LessonCheck } from '../generated/lessons.js';
import type { SelectionState } from '../state/selection.js';
import { traceBadge, type Trace, type TraceRow } from '../state/trace-store.js';
import type { JointView } from '../state/telemetry-store.js';
import type { JournalAction, LabSnapshot, LessonRuntime } from './runtime.js';

export type CheckStatus = 'pending' | 'passed' | 'failed' | 'unsupported';

export interface CheckOutcome {
  readonly status: CheckStatus;
  /** One line, always rendered. Says what is being looked for or what was found. */
  readonly summary: string;
  /** What the system actually reports right now, in the learner's terms. */
  readonly observed: string | null;
  /** What the lesson asserts. */
  readonly expected: string | null;
}

/** What the model backend says right now. `null` when no backend can answer. */
export interface ModelReading {
  readonly faceName: string;
  readonly faceFrame: number;
  readonly faceMode: string;
  readonly faceFrameCount: number;
  readonly runningMovement: string | null;
  readonly currentCommand: string;
  readonly idleActive: boolean;
}

export interface CheckContext {
  readonly runtime: LessonRuntime;
  readonly lab: LabSnapshot;
  readonly joints: Readonly<Record<JointName, JointView>>;
  readonly model: ModelReading | null;
  readonly trace: Trace | null;
  readonly selection: SelectionState;
  /** Wall clock, injected so the evaluators stay testable. */
  readonly nowMs: number;
}

// ------------------------------------------------------------------ helpers

const pending = (summary: string, expected: string | null = null, observed: string | null = null): CheckOutcome => ({
  status: 'pending',
  summary,
  observed,
  expected,
});

const passed = (summary: string, observed: string | null = null, expected: string | null = null): CheckOutcome => ({
  status: 'passed',
  summary,
  observed,
  expected,
});

const failed = (summary: string, observed: string | null = null, expected: string | null = null): CheckOutcome => ({
  status: 'failed',
  summary,
  observed,
  expected,
});

/**
 * A check whose parameters do not match what `lessons.json` declares it
 * `requires`. Loud, and never passable — a malformed check is a data defect and
 * silently skipping it is exactly the failure mode this runner exists to avoid.
 */
const dataFault = (why: string): CheckOutcome =>
  failed(`this check cannot be evaluated: ${why}`, null, null);

const num = (check: LessonCheck, key: string): number | null =>
  typeof check[key] === 'number' ? (check[key] as number) : null;
const str = (check: LessonCheck, key: string): string | null =>
  typeof check[key] === 'string' ? (check[key] as string) : null;
const bool = (check: LessonCheck, key: string): boolean | null =>
  typeof check[key] === 'boolean' ? (check[key] as boolean) : null;
const strList = (check: LessonCheck, key: string): readonly string[] | null =>
  Array.isArray(check[key]) && (check[key] as unknown[]).every((v) => typeof v === 'string')
    ? (check[key] as readonly string[])
    : null;

const rowFor = (trace: Trace | null, layer: string): TraceRow | null =>
  trace?.rows.find((r) => r.layer === layer) ?? null;

/** `INFERRED FOR EXPLANATION` → `inferred-for-explanation`. */
function badgeIdOf(row: TraceRow): string {
  const badge = traceBadge(row);
  switch (badge.text) {
    case 'OBSERVED ON HARDWARE':
      // Unreachable: `isPhysicallyObserved()` is permanently false here. Kept
      // so the mapping is total rather than defaulting.
      return 'observed-on-hardware';
    case 'OBSERVED FROM EMULATOR':
      return 'observed-from-emulator';
    case 'OBSERVED IN THIS APP':
    case 'OBSERVED (HOST MODEL)':
    case 'OBSERVED (REPLAY)':
      return 'observed-in-this-app';
    case 'SIMULATED':
      return 'simulated';
    default:
      return 'inferred-for-explanation';
  }
}

/** The joints a movement's own body commands, from the extracted choreography. */
function directJointsOf(movementFunction: string): readonly string[] | null {
  const facts = COMMAND_TRACE_FACTS.find((f) => f.movementFunction === movementFunction);
  return facts === undefined ? null : facts.joints;
}

/** The commanded angle the FIRST `servo.target` after an action reported. */
function observedAfter(
  runtime: LessonRuntime,
  action: JournalAction,
  joint: JointName,
): number | null {
  for (const event of runtime.eventsAfter(action)) {
    if (event.type === 'servo.target' && event.joint === joint) return event.angleDeg;
  }
  return null;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

// ------------------------------------------------------- the not-built eight
//
// Every one of these is used only by an OUTLINE lesson (7–19). They are named
// here rather than falling through a `default:` so that adding a 35th check
// type is a compile error in `evaluateCheck`, not a silent pass.
export const UNIMPLEMENTED_CHECK_TYPES: readonly CheckTypeId[] = [
  'backend-switched',
  'boot-step-reached',
  'emulator-boot-observed',
  'fault-diagnosed',
  'json-repaired',
  'lab-project-saved',
  'route-method-probe',
  'serial-command',
];

const UNSUPPORTED = (type: string): CheckOutcome => ({
  status: 'unsupported',
  summary:
    `the "${type}" check is NOT BUILT. It is declared in hardware/lessons.json and used only by ` +
    `outline lessons. Nothing here can pass it, and nothing here will pretend it did.`,
  observed: null,
  expected: null,
});

// --------------------------------------------------------------- evaluators

/**
 * Evaluate one success condition.
 *
 * Total over the 34 declared types: the `switch` has an arm for every one, and
 * the `never` at the bottom makes a 35th a compile error rather than a silent
 * `pending`.
 */
export function evaluateCheck(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  switch (check.type) {
    case 'joints-identified':
      return jointsIdentified(check, ctx);
    case 'board-switched':
      return boardSwitched(check, ctx);
    case 'source-span-selected':
      return sourceSpanSelected(check, ctx);
    case 'pose-vector':
      return poseVector(check, ctx);
    case 'servo-target':
      return servoTarget(check, ctx);
    case 'telemetry-absent':
      return telemetryAbsent(check, ctx);
    case 'commanded-angle-collision':
      return commandedAngleCollision(check, ctx);
    case 'quantisation-collision':
      return quantisationCollision(check, ctx);
    case 'pwm-value-matched':
      return pwmValueMatched(check, ctx);
    case 'quantisation-survey':
      return quantisationSurvey(check, ctx);
    case 'trace-badge-identified':
      return traceBadgeIdentified(check, ctx);
    case 'trace-field-absent':
      return traceFieldAbsent(check, ctx);
    case 'trace-complete':
      return traceComplete(check, ctx);
    case 'movement-joints-identified':
      return movementJointsIdentified(check, ctx);
    case 'sequence-variation':
      return sequenceVariation(check, ctx);
    case 'sequence-authored':
      return sequenceAuthored(check, ctx);
    case 'face-selected':
      return faceSelected(check, ctx);
    case 'face-fallback':
      return faceFallback(check, ctx);
    case 'face-reselect':
      return faceReselect(check, ctx);
    case 'face-after-movement':
      return faceAfterMovement(check, ctx);
    case 'face-mode-identified':
      return faceModeIdentified(check, ctx);
    case 'pixel-edit':
      return pixelEdit(check, ctx);
    case 'http-request':
      return httpRequest(check, ctx);
    case 'http-json-field':
      return httpJsonField(check, ctx);
    case 'subtrim-set':
      return subtrimSet(check, ctx);
    case 'boot-halt':
      return bootHalt(check, ctx);

    // --------------------------------------------------------- not built yet
    case 'route-method-probe':
    case 'json-repaired':
    case 'serial-command':
    case 'boot-step-reached':
    case 'fault-diagnosed':
    case 'backend-switched':
    case 'emulator-boot-observed':
    case 'lab-project-saved':
      return UNSUPPORTED(check.type);

    default: {
      const exhaustive: never = check.type;
      return dataFault(`unknown check type ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------- 1. joints

function jointsIdentified(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const joints = strList(check, 'joints');
  if (joints === null) return dataFault('`joints` is missing or is not a list of names');
  const answers = ctx.lab.quiz.jointNaming;
  const wrong = joints.filter((j) => answers[j] !== undefined && answers[j] !== j);
  const right = joints.filter((j) => answers[j] === j);
  if (wrong.length > 0) {
    return failed(
      `${String(wrong.length)} of ${String(joints.length)} modules named wrongly — try those again`,
      wrong.map((j) => `${j}→${answers[j] ?? '?'}`).join(', '),
      joints.join(' '),
    );
  }
  if (right.length === joints.length) {
    return passed(`all ${String(joints.length)} named from the firmware's own enum`, right.join(' '), joints.join(' '));
  }
  return pending(
    `${String(right.length)} of ${String(joints.length)} named`,
    joints.join(' '),
    right.join(' ') || 'nothing yet',
  );
}

// ----------------------------------------------------------------- 2. board

function boardSwitched(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const from = str(check, 'fromBoard');
  const to = str(check, 'toBoard');
  const expectUnchanged = bool(check, 'expectJointNamesUnchanged');
  if (from === null || to === null || expectUnchanged === null) {
    return dataFault('`fromBoard`, `toBoard` and `expectJointNamesUnchanged` are all required');
  }
  const fromPins = SERVO_PINS_BY_BOARD[from];
  const toPins = SERVO_PINS_BY_BOARD[to];
  if (fromPins === undefined || toPins === undefined) {
    return dataFault(`hardware-map.json has no pin table for ${fromPins === undefined ? from : to}`);
  }
  const history = ctx.lab.boardHistory;
  const toAt = history.findIndex((h) => h.board === to);
  const fromBefore = history.slice(0, toAt < 0 ? 0 : toAt).some((h) => h.board === from);
  if (toAt < 0 || !fromBefore) {
    return pending(
      `switch the board profile from ${from} to ${to}`,
      `${from} → ${to}`,
      history.map((h) => h.board).join(' → ') || ctx.lab.board,
    );
  }
  // Recomputed from the pin tables, not from anything the control said.
  const namesUnchanged = sameSet(Object.keys(fromPins), Object.keys(toPins));
  const movedPins = Object.keys(toPins).filter((j) => fromPins[j] !== toPins[j]);
  if (expectUnchanged && !namesUnchanged) {
    return failed(
      'the joint names changed with the board — that contradicts the lesson and the pin tables',
      Object.keys(toPins).join(' '),
      Object.keys(fromPins).join(' '),
    );
  }
  if (movedPins.length === 0) {
    return failed(
      `${from} and ${to} have identical pin maps, so nothing was demonstrated`,
      JSON.stringify(toPins),
      'at least one pin should differ',
    );
  }
  return passed(
    `${String(movedPins.length)} pins moved; all eight names stayed put`,
    movedPins.map((j) => `${j}: ${String(fromPins[j])}→${String(toPins[j])}`).join(', '),
    'names unchanged',
  );
}

// ---------------------------------------------------------------- 3. source

function sourceSpanSelected(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const symbol = str(check, 'symbol');
  if (symbol === null) return dataFault('`symbol` is required');
  const reachedFrom = str(check, 'reachedFrom');
  const visits = ctx.runtime.symbolVisits;
  const index = visits.map((v) => v.symbolId).lastIndexOf(symbol);
  if (index < 0) {
    return pending(
      `open ${symbol} in the source explorer`,
      symbol,
      ctx.selection.symbolId ?? 'nothing selected',
    );
  }
  if (reachedFrom === null) {
    return passed(`${symbol} was opened in the pinned source`, symbol, symbol);
  }
  if (reachedFrom === 'trace-row') {
    const arrived = visits.some((v, i) => i >= index && v.symbolId === symbol && v.origin === 'trace');
    return arrived
      ? passed(`${symbol} was reached from a trace row`, 'origin: trace', 'origin: trace')
      : pending(
          `reach ${symbol} by clicking a row in the trace, not from the outline`,
          'origin: trace',
          visits[index]?.origin ?? 'unknown',
        );
  }
  const previous = visits[index - 1];
  if (previous?.symbolId === reachedFrom) {
    return passed(`${symbol} was reached from ${reachedFrom}`, `${reachedFrom} → ${symbol}`, `${reachedFrom} → ${symbol}`);
  }
  return pending(
    `open ${reachedFrom} first, then follow the call into ${symbol}`,
    `${reachedFrom} → ${symbol}`,
    `${previous?.symbolId ?? 'nothing'} → ${symbol}`,
  );
}

// ------------------------------------------------------------------ 4. pose

function poseVector(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const movement = str(check, 'movement');
  const expect = check['expect'];
  if (movement === null || !Array.isArray(expect)) {
    return dataFault('`movement` and `expect[]` are required');
  }
  const wanted = expect as readonly { joint: JointName; angleDeg: number }[];
  const afterAction = str(check, 'afterAction');
  if (afterAction !== null) {
    // "cancel forward mid-gait": the cancel has to have HAPPENED, and the pose
    // below is then evidence that the shipped cancel path ran a whole stand.
    const commands = ctx.runtime.actionsOfKind('command');
    const startedAt = commands.findIndex((a) => a.detail['command'] === 'forward');
    const cancelled = startedAt >= 0 && commands.slice(startedAt + 1).some((a) => a.detail['command'] !== 'forward');
    if (!cancelled) {
      return pending(
        'send forward, then interrupt it with another command',
        afterAction,
        commands.map((a) => String(a.detail['command'] ?? '?')).join(' → ') || 'nothing sent',
      );
    }
  }
  const misses = wanted.filter((w) => ctx.joints[w.joint]?.commandedDeg !== w.angleDeg);
  const anyNull = wanted.some((w) => ctx.joints[w.joint]?.commandedDeg === null);
  const expected = wanted.map((w) => `${w.joint}=${String(w.angleDeg)}`).join(' ');
  const observed = wanted
    .map((w) => `${w.joint}=${ctx.joints[w.joint]?.commandedDeg ?? '—'}`)
    .join(' ');
  if (misses.length === 0) return passed(`all eight channels hold ${movement}'s vector`, observed, expected);
  const ran = ctx.runtime.actionsOfKind('command').length > 0;
  if (!anyNull && ran) {
    return failed(
      `${String(misses.length)} of eight channels do not hold ${movement}'s angles`,
      observed,
      expected,
    );
  }
  return pending(`run ${movement} and let all eight channels arrive`, expected, observed);
}

// ----------------------------------------------------------------- 5. servo

function servoTarget(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const joint = str(check, 'joint') as JointName | null;
  const angleDeg = num(check, 'angleDeg');
  if (joint === null || angleDeg === null) return dataFault('`joint` and `angleDeg` are required');
  const view = ctx.joints[joint];
  if (view === undefined) return dataFault(`${joint} is not one of the eight channels`);
  if (view.commandedDeg === angleDeg) {
    return passed(`${joint} was commanded to ${String(angleDeg)}°`, `${joint}=${String(view.commandedDeg)}`, `${joint}=${String(angleDeg)}`);
  }
  const tried = ctx.runtime.lastAction('set-joint', (a) => a.detail['joint'] === joint);
  if (tried !== null && view.commandedDeg !== null) {
    return failed(
      `${joint} holds ${String(view.commandedDeg)}°, not ${String(angleDeg)}°`,
      `${joint}=${String(view.commandedDeg)}`,
      `${joint}=${String(angleDeg)}`,
    );
  }
  return pending(`command ${joint} to ${String(angleDeg)}°`, `${joint}=${String(angleDeg)}`, `${joint}=${view.commandedDeg ?? 'never commanded'}`);
}

// -------------------------------------------------------------- 6. absences

function telemetryAbsent(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const eventType = str(check, 'event');
  const afterAction = str(check, 'afterAction');
  const windowMs = num(check, 'windowMs');
  if (eventType === null || afterAction === null || windowMs === null) {
    return dataFault('`event`, `afterAction` and `windowMs` are required');
  }
  // Deliberately the LAST raw-channel write, whichever channel it named — not
  // one filtered down to the channel the lesson had in mind. Sending channel 3
  // and watching a row appear is a real falsification of "the guard drops it",
  // and a check that quietly ignored the wrong answer would not be a check.
  const action = ctx.runtime.lastAction('set-channel');
  if (action === null) {
    return pending(`do it: ${afterAction}`, `no ${eventType} within ${String(windowMs)} ms`, 'nothing sent yet');
  }
  const arrived = ctx.runtime.eventsInWindow(action, windowMs).filter((e) => e.type === eventType);
  if (arrived.length > 0) {
    const first = arrived[0];
    return failed(
      `a ${eventType} DID arrive after channel ${String(action.detail['channel'] ?? '?')} — that is a ` +
        `channel the guard lets through`,
      `${eventType} ${first?.joint ?? ''}=${String(first?.angleDeg ?? '')}`,
      `no ${eventType} within ${String(windowMs)} ms`,
    );
  }
  const elapsed = ctx.nowMs - action.t;
  if (elapsed < windowMs) {
    return pending(
      `watching for ${String(Math.max(0, Math.round(windowMs - elapsed)))} ms more…`,
      `no ${eventType} within ${String(windowMs)} ms`,
      `${String(Math.round(elapsed))} ms of silence so far`,
    );
  }
  return passed(
    `${String(windowMs)} ms passed and no ${eventType} row ever arrived`,
    `0 ${eventType} events`,
    `no ${eventType} within ${String(windowMs)} ms`,
  );
}

// ------------------------------------------------------------- 7. collision

function commandedAngleCollision(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const joint = str(check, 'joint') as JointName | null;
  const a = num(check, 'inputAngleA');
  const b = num(check, 'inputAngleB');
  const subtrimDeg = num(check, 'subtrimDeg');
  const expectCommanded = num(check, 'expectCommandedAngle');
  if (joint === null || a === null || b === null || subtrimDeg === null || expectCommanded === null) {
    return dataFault('`joint`, `inputAngleA`, `inputAngleB`, `subtrimDeg` and `expectCommandedAngle` are required');
  }
  const find = (angle: number): number | null => {
    const action = ctx.runtime.lastAction(
      'set-joint',
      (x) => x.detail['joint'] === joint && x.detail['requestedDeg'] === angle && x.detail['subtrimDeg'] === subtrimDeg,
    );
    return action === null ? null : observedAfter(ctx.runtime, action, joint);
  };
  const observedA = find(a);
  const observedB = find(b);
  const expected = `${String(a)}° and ${String(b)}° both commanded ${String(expectCommanded)}° at subtrim ${String(subtrimDeg)}`;
  if (observedA === null || observedB === null) {
    return pending(
      `set ${joint}'s subtrim to ${String(subtrimDeg)}, then command ${String(a)}° and ${String(b)}°`,
      expected,
      `${String(a)}°→${observedA ?? '—'}  ${String(b)}°→${observedB ?? '—'}`,
    );
  }
  const observed = `${String(a)}°→${String(observedA)}°  ${String(b)}°→${String(observedB)}°`;
  if (observedA !== expectCommanded || observedB !== expectCommanded) {
    return failed('the two requests did not collide on the angle the lesson names', observed, expected);
  }
  return passed('two requests, one commanded angle — subtrim was added before the clamp', observed, expected);
}

// ------------------------------------------------------- 8-10. the PWM model

function quantisationCollision(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const expectSame = bool(check, 'expectSameTicks');
  if (expectSame === null) return dataFault('`expectSameTicks` is required');
  const learnerChosen = bool(check, 'learnerChosen') ?? false;
  const probes = ctx.lab.pwmProbes;

  if (learnerChosen) {
    const byTicks = new Map<number, Set<number>>();
    for (const probe of probes) {
      const bucket = byTicks.get(probe.ticks) ?? new Set<number>();
      bucket.add(probe.angleDeg);
      byTicks.set(probe.ticks, bucket);
    }
    for (const [ticks, angles] of byTicks) {
      if (angles.size >= 2) {
        const list = [...angles].sort((x, y) => x - y);
        return passed(
          `${list.join('° and ')}° are the same request at the pin`,
          `${list.join('/')} → ${String(ticks)} ticks`,
          'two angles, one tick count',
        );
      }
    }
    return pending(
      `probe two angles that you think collide (${String(probes.length)} probed so far)`,
      'two angles sharing a tick count',
      probes.length === 0 ? 'nothing probed yet' : `${String(byTicks.size)} distinct tick counts so far`,
    );
  }

  const a = num(check, 'angleA');
  const b = num(check, 'angleB');
  if (a === null || b === null) return dataFault('`angleA` and `angleB` are required when learnerChosen is false');
  const probedA = probes.some((p) => p.angleDeg === a);
  const probedB = probes.some((p) => p.angleDeg === b);
  // RECOMPUTED, every time, from the library's own arithmetic. `expectTicks` in
  // lessons.json is checked against this — never substituted for it.
  const qa = quantiseCommandedAngle(a);
  const qb = quantiseCommandedAngle(b);
  const same = qa.ticks === qb.ticks;
  const expectTicks = num(check, 'expectTicks');
  if (expectTicks !== null && qa.ticks !== expectTicks) {
    return failed(
      `hardware/lessons.json says ${String(a)}° is ${String(expectTicks)} ticks; quantiseCommandedAngle() computes ${String(qa.ticks)}`,
      `${String(qa.ticks)} ticks`,
      `${String(expectTicks)} ticks`,
    );
  }
  if (same !== expectSame) {
    return failed(
      `the model says ${String(a)}° and ${String(b)}° ${same ? 'DO' : 'do NOT'} share a tick count, which contradicts the lesson`,
      `${String(qa.ticks)} vs ${String(qb.ticks)}`,
      expectSame ? 'the same tick count' : 'different tick counts',
    );
  }
  const expected = `${String(a)}° and ${String(b)}° → ${String(qa.ticks)} ticks`;
  if (!probedA || !probedB) {
    return pending(
      `step the inspector from ${String(a)}° to ${String(b)}° and watch the ticks`,
      expected,
      `probed ${[probedA ? a : null, probedB ? b : null].filter((x) => x !== null).join(', ') || 'neither'}`,
    );
  }
  return passed(
    `${String(a)}° and ${String(b)}° both program ${String(qa.ticks)} ticks — ${qa.pulseUs.toFixed(5)} µs`,
    `${String(qa.mappedUs)} µs and ${String(qb.mappedUs)} µs requested; both quantise to ${String(qa.ticks)}`,
    expected,
  );
}

function pwmValueMatched(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const angleDeg = num(check, 'angleDeg');
  const wantMapped = num(check, 'expectRequestedPulseUs');
  const wantTicks = num(check, 'expectTicks');
  const wantPulse = num(check, 'expectQuantisedPulseUs');
  if (angleDeg === null || wantMapped === null || wantTicks === null || wantPulse === null) {
    return dataFault('`angleDeg`, `expectRequestedPulseUs`, `expectTicks` and `expectQuantisedPulseUs` are required');
  }
  const q = quantiseCommandedAngle(angleDeg);
  const expected = `${String(wantMapped)} µs requested → ${String(wantTicks)} ticks → ${wantPulse.toFixed(4)} µs`;
  const computed = `${String(q.mappedUs)} µs requested → ${String(q.ticks)} ticks → ${q.pulseUs.toFixed(4)} µs`;
  if (q.mappedUs !== wantMapped || q.ticks !== wantTicks || Math.abs(q.pulseUs - wantPulse) > 1e-6) {
    return failed(
      `the lesson's numbers for ${String(angleDeg)}° disagree with ESP32Servo 3.0.9's arithmetic`,
      computed,
      expected,
    );
  }
  const probed = ctx.lab.pwmProbes.some((p) => p.angleDeg === angleDeg);
  if (!probed) {
    return pending(`set the inspector to ${String(angleDeg)}° and read the frame`, expected, 'not read yet');
  }
  return passed(`${String(angleDeg)}° reads ${computed}`, computed, expected);
}

function quantisationSurvey(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const wantDistinct = num(check, 'expectDistinctPulseValues');
  const wantAliased = num(check, 'expectAliasedAngles');
  if (wantDistinct === null || wantAliased === null) {
    return dataFault('`expectDistinctPulseValues` and `expectAliasedAngles` are required');
  }
  const distinct = SERVO_PULSE_QUANTISATION.distinctPulseValues;
  const aliased = SERVO_PULSE_QUANTISATION.aliasedAngleCount;
  const expected = `${String(wantDistinct)} distinct pulses, ${String(wantAliased)} aliased angles`;
  const computed = `${String(distinct)} distinct pulses, ${String(aliased)} aliased angles`;
  if (distinct !== wantDistinct || aliased !== wantAliased) {
    return failed('the sweep the model computes disagrees with the lesson', computed, expected);
  }
  if (ctx.lab.sweepRuns === 0) {
    return pending('sweep the whole 0–180 range and read the table', expected, 'not swept yet');
  }
  return passed(`the sweep found ${computed}`, computed, expected);
}

// ------------------------------------------------------------- 11-13. trace

function traceBadgeIdentified(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const layer = str(check, 'traceLayer');
  const expectedBadge = str(check, 'expectedProvenance');
  if (layer === null || expectedBadge === null) {
    return dataFault('`traceLayer` and `expectedProvenance` are required');
  }
  const row = rowFor(ctx.trace, layer);
  if (row === null) {
    return pending(`run a command so the ${layer} row exists, then read its badge`, expectedBadge, 'no such row yet');
  }
  const actual = badgeIdOf(row);
  if (actual !== expectedBadge) {
    return failed(
      `the ${layer} row on screen reads "${actual}", but the lesson asserts "${expectedBadge}"`,
      actual,
      expectedBadge,
    );
  }
  const answer = ctx.lab.quiz.traceBadge[layer];
  if (answer === undefined) {
    return pending(`say what the ${layer} row is really claiming`, expectedBadge, `the row reads ${actual}`);
  }
  if (answer !== actual) {
    return failed(`you picked "${answer}"; the row carries "${actual}"`, actual, expectedBadge);
  }
  return passed(`${layer} is ${actual} — and its witness line says why`, actual, expectedBadge);
}

function traceFieldAbsent(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const layer = str(check, 'traceLayer');
  const field = str(check, 'field');
  if (layer === null || field === null) return dataFault('`traceLayer` and `field` are required');
  const row = rowFor(ctx.trace, layer);
  if (row === null) {
    return pending(`run a command so the ${layer} row exists`, `no ${field} on ${layer}`, 'no such row yet');
  }
  // Verified against the row that is actually rendered, not against a promise.
  const text = `${row.label} ${row.detail}`;
  const present =
    Object.prototype.hasOwnProperty.call(row, field) ||
    new RegExp(`\\b${field}\\s*[=:]\\s*\\S`, 'i').test(text);
  if (present) {
    return failed(
      `the ${layer} row DOES carry a ${field}, so the absence the lesson asks about is not real`,
      text.slice(0, 140),
      `no ${field}`,
    );
  }
  if (ctx.lab.quiz.traceFieldAbsent[`${layer}:${field}`] !== true) {
    return pending(`find the field the ${layer} row cannot show`, `no ${field}`, 'not answered yet');
  }
  return passed(
    `${layer} shows no ${field}, and nothing in this repository records which channel carries which servo`,
    `no ${field} in "${row.label}"`,
    `no ${field}`,
  );
}

function traceComplete(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const layers = strList(check, 'traceLayers');
  if (layers === null) return dataFault('`traceLayers` is required');
  const present = new Set((ctx.trace?.rows ?? []).map((r) => r.layer));
  const missing = layers.filter((l) => !present.has(l as TraceRow['layer']));
  const expected = `${String(layers.length)} rungs, in causal order`;
  if (missing.length === 0) {
    // The rows are already stored in causal order (`orderRows`), but assert it
    // rather than assume: a reordering regression would otherwise pass here.
    const ranks = (ctx.trace?.rows ?? []).map((r) => r.rank);
    const ordered = ranks.every((r, i) => i === 0 || r >= (ranks[i - 1] ?? 0));
    return ordered
      ? passed(`all ${String(layers.length)} rungs present, in causal order`, [...present].join(' → '), expected)
      : failed('the rungs are present but not in causal order', ranks.join(','), 'non-decreasing rank');
  }
  return pending(
    `run a movement and open every rung (missing: ${missing.join(', ')})`,
    expected,
    `${String(layers.length - missing.length)} of ${String(layers.length)}`,
  );
}

// ------------------------------------------------------------- 14. movement

function movementJointsIdentified(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const movement = str(check, 'movement');
  const expect = strList(check, 'expectDirectJoints');
  if (movement === null || expect === null) {
    return dataFault('`movement` and `expectDirectJoints` are required');
  }
  const truth = directJointsOf(movement);
  if (truth === null) {
    return dataFault(`hardware-map.json's choreography has no movement called ${movement}`);
  }
  if (!sameSet(truth, expect)) {
    return failed(
      `the extracted choreography says ${movement} commands ${truth.join(' ')}, not what the lesson asserts`,
      truth.join(' '),
      expect.join(' '),
    );
  }
  const answer = ctx.lab.quiz.movementJoints[movement];
  if (answer === undefined) {
    return pending(`say which joints ${movement}'s own body commands`, expect.join(' '), 'not answered yet');
  }
  if (!sameSet(answer, truth)) {
    return failed(`you listed ${answer.join(' ') || 'nothing'}; the function body commands ${truth.join(' ')}`, answer.join(' '), truth.join(' '));
  }
  return passed(`${movement} commands ${truth.join(' ')} directly`, answer.join(' '), truth.join(' '));
}

// ------------------------------------------------------------ 15-16. editor

function sequenceVariation(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const basedOn = str(check, 'basedOnMovement');
  const changedField = str(check, 'changedField');
  const expectSame = bool(check, 'expectSameTerminalPose');
  if (basedOn === null || changedField === null || expectSame === null) {
    return dataFault('`basedOnMovement`, `changedField` and `expectSameTerminalPose` are required');
  }
  const runs = ctx.lab.sequenceRuns.filter((r) => r.basedOnMovement === basedOn);
  const baseline = runs.find((r) => r.changedField === null);
  const variant = runs.find((r) => r.changedField === changedField);
  if (baseline === undefined || variant === undefined) {
    return pending(
      `run ${basedOn} unchanged, then run it again with a different ${changedField}`,
      `two runs of ${basedOn}`,
      `${String(runs.length)} run(s) so far`,
    );
  }
  const keys = Object.keys(baseline.terminalPose) as JointName[];
  const differing = keys.filter((j) => baseline.terminalPose[j] !== variant.terminalPose[j]);
  const observed = keys.map((j) => `${j}=${variant.terminalPose[j] ?? '—'}`).join(' ');
  const same = differing.length === 0;
  if (same !== expectSame) {
    return failed(
      same
        ? 'the terminal poses matched, but the lesson expects them to differ'
        : `changing ${changedField} moved the terminal pose on ${differing.join(' ')}`,
      observed,
      expectSame ? 'the same terminal pose' : 'a different terminal pose',
    );
  }
  return passed(
    `changing ${changedField} changed how long it took and nothing else`,
    observed,
    'the same terminal pose',
  );
}

function sequenceAuthored(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const minFrames = num(check, 'minFrames');
  const maxOutOfRange = num(check, 'maxCommandedAngleOutOfRange');
  if (minFrames === null || maxOutOfRange === null) {
    return dataFault('`minFrames` and `maxCommandedAngleOutOfRange` are required');
  }
  const runs = ctx.lab.sequenceRuns.filter((r) => r.commanded.length > 0);
  const good = runs.find((r) => r.frameCount >= minFrames && r.outOfRangeCount <= maxOutOfRange);
  if (good !== undefined) {
    return passed(
      `${String(good.frameCount)} frames ran, ${String(good.commanded.length)} angles commanded, none out of range`,
      `${String(good.frameCount)} frames`,
      `at least ${String(minFrames)} frames, no angle outside 0–180`,
    );
  }
  const best = runs.at(-1);
  if (best !== undefined && best.outOfRangeCount > maxOutOfRange) {
    return failed(
      `${String(best.outOfRangeCount)} authored angles fell outside the firmware's 0–180`,
      `${String(best.outOfRangeCount)} out of range`,
      'no angle outside 0–180',
    );
  }
  return pending(
    `author at least ${String(minFrames)} frames and run them`,
    `at least ${String(minFrames)} frames`,
    best === undefined ? 'nothing run yet' : `${String(best.frameCount)} frames`,
  );
}

// ---------------------------------------------------------------- 17-21. face

function faceSelected(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const faceName = str(check, 'faceName');
  const atLeast = num(check, 'expectFramesRenderedAtLeast');
  if (faceName === null || atLeast === null) {
    return dataFault('`faceName` and `expectFramesRenderedAtLeast` are required');
  }
  const action = ctx.runtime.lastAction('set-face', (a) => a.detail['face'] === faceName);
  if (action === null) return pending(`select the ${faceName} face`, `${String(atLeast)} frame(s)`, 'not selected yet');
  const frames = ctx.runtime.eventsAfter(action).filter((e) => e.type === 'face.expression' && e.name === faceName);
  if (frames.length >= atLeast) {
    return passed(`${String(frames.length)} frames of ${faceName} were drawn`, `${String(frames.length)} frames`, `${String(atLeast)}+`);
  }
  return pending(`waiting for ${faceName} to draw`, `${String(atLeast)}+ frames`, `${String(frames.length)} frames`);
}

function faceFallback(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const requested = str(check, 'requestedFace');
  const reported = str(check, 'expectReportedFace');
  const framesExpected = num(check, 'expectFramesRendered');
  if (requested === null || reported === null || framesExpected === null) {
    return dataFault('`requestedFace`, `expectReportedFace` and `expectFramesRendered` are required');
  }
  const action = ctx.runtime.lastAction('set-face', (a) => a.detail['face'] === requested);
  if (action === null) {
    return pending(`select the ${requested} face`, `reported as "${reported}", ${String(framesExpected)} frames`, 'not selected yet');
  }
  const frames = ctx.runtime.eventsAfter(action).filter((e) => e.type === 'face.expression' && e.name === requested);
  const modelFace = ctx.model?.faceName ?? null;
  const observed = `${String(frames.length)} frames; the robot reports "${modelFace ?? 'unknown'}"`;
  const expected = `${String(framesExpected)} frames; reported as "${reported}"`;
  if (frames.length !== framesExpected) {
    return failed(`${requested} drew ${String(frames.length)} frames`, observed, expected);
  }
  if (modelFace === null) {
    return pending('waiting for the robot to report its face', expected, observed);
  }
  if (modelFace !== reported) {
    return failed(`the robot reports "${modelFace}", not "${reported}"`, observed, expected);
  }
  return passed(
    `${requested} drew nothing and the name was quietly rewritten to ${reported}`,
    observed,
    expected,
  );
}

/**
 * TN-013, measured by what the second request EMITS.
 *
 * The obvious reading of "did the animation restart?" is "did the frame index
 * go back to 0?", and it does not work: `wave` has exactly **one** frame
 * (`faceFrameCount === 1`), so its index never leaves 0 and "let it run partway"
 * is not a thing a learner can do. That is a fact about the firmware's bitmap
 * table, not a gap in the lesson.
 *
 * What `setFace()` actually does on a repeat is **early-return** — same name,
 * frames already attached, so `currentFaceFrameIndex = 0` never executes and
 * `updateFaceBitmap()` is never reached. So no `face.expression` event is
 * emitted at all. The silence is the observable, and it works for a
 * one-frame face and a forty-frame one alike.
 */
function faceReselect(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const faceName = str(check, 'faceName');
  const expectRestart = bool(check, 'expectAnimationRestart');
  if (faceName === null || expectRestart === null) {
    return dataFault('`faceName` and `expectAnimationRestart` are required');
  }
  const requests = ctx.runtime.actionsOfKind('set-face').filter((a) => a.detail['face'] === faceName);
  const expected = expectRestart ? 'a second draw' : 'no second draw — setFace() early-returns';
  if (requests.length < 2) {
    return pending(
      `select ${faceName}, then select ${faceName} again`,
      expected,
      `${String(requests.length)} of 2 selections`,
    );
  }
  const first = requests[requests.length - 2];
  const second = requests[requests.length - 1];
  if (first === undefined || second === undefined) return pending('waiting', expected, null);
  const drewFirst = ctx.runtime
    .eventsAfter(first)
    .filter((e) => e.type === 'face.expression' && e.name === faceName && e.seq <= second.seqBefore);
  if (drewFirst.length === 0) {
    return pending(
      `the first ${faceName} selection has not drawn yet`,
      expected,
      'no frames from the first selection',
    );
  }
  const drewAgain = ctx.runtime
    .eventsAfter(second)
    .filter((e) => e.type === 'face.expression' && e.name === faceName);
  const restarted = drewAgain.length > 0;
  const observed = `${String(drewFirst.length)} frame(s) the first time, ${String(drewAgain.length)} the second`;
  if (restarted !== expectRestart) {
    return failed(
      restarted
        ? 'the second request DID redraw, which contradicts the early return'
        : 'the second request drew nothing, but the lesson expects a restart',
      observed,
      expected,
    );
  }
  return passed(
    `setFace("${faceName}") the second time returned early — nothing was redrawn and the index was never reset`,
    observed,
    expected,
  );
}

function faceAfterMovement(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const movement = str(check, 'movement');
  const expectFace = str(check, 'expectFace');
  if (movement === null || expectFace === null) return dataFault('`movement` and `expectFace` are required');
  const facts = COMMAND_TRACE_FACTS.find((f) => f.movementFunction === movement);
  const commandWord = facts?.command ?? null;
  const action =
    commandWord === null ? null : ctx.runtime.lastAction('command', (a) => a.detail['command'] === commandWord);
  if (action === null) {
    return pending(`run ${commandWord ?? movement} and keep watching after the last angle`, expectFace, 'not run yet');
  }
  if (ctx.model === null) {
    return pending('this backend cannot report its face state', expectFace, 'unknown');
  }
  if (ctx.model.runningMovement !== null) {
    return pending(`${movement} is still running`, expectFace, ctx.model.faceName);
  }
  if (ctx.model.faceName === expectFace) {
    return passed(`when ${movement} finished, the face was ${expectFace}`, ctx.model.faceName, expectFace);
  }
  return failed(`the face after ${movement} is ${ctx.model.faceName}`, ctx.model.faceName, expectFace);
}

function faceModeIdentified(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const movement = str(check, 'movement');
  const expectMode = str(check, 'expectMode');
  if (movement === null || expectMode === null) return dataFault('`movement` and `expectMode` are required');
  // The FIRST sample taken while this movement was running with its own face on
  // screen. Not the last: `currentFaceMode` is one global, and by the end of a
  // wave `enterIdle()` has already overwritten it with the idle animation's
  // mode. Reading the last sample would report the mode the NEXT thing set,
  // which is the confusion the step exists to expose.
  const faceOnEntry = COMMAND_TRACE_FACTS.find((f) => f.movementFunction === movement)?.faceOnEntry ?? null;
  const samples = ctx.runtime.modelSamples().filter((s) => s.runningMovement === movement);
  const observedMode = (
    faceOnEntry === null ? samples[0] : (samples.find((s) => s.faceName === faceOnEntry) ?? samples[0])
  )?.faceMode;
  if (observedMode === undefined) {
    return pending(`run ${movement} and watch the face play`, expectMode, 'not observed yet');
  }
  if (observedMode !== expectMode) {
    return failed(
      `${movement} set the global playback mode to "${observedMode}", not "${expectMode}"`,
      observedMode,
      expectMode,
    );
  }
  const answer = ctx.lab.quiz.faceMode[movement];
  if (answer === undefined) {
    return pending(`say which playback mode ${movement} sets`, expectMode, `observed: ${observedMode}`);
  }
  if (answer !== observedMode) {
    return failed(`you picked "${answer}"; the robot reported "${observedMode}"`, observedMode, expectMode);
  }
  return passed(`${movement} sets the ONE global playback mode to ${observedMode}`, observedMode, expectMode);
}

// ----------------------------------------------------------------- 22. pixel

function pixelEdit(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const minPixels = num(check, 'minPixelsChanged');
  if (minPixels === null) return dataFault('`minPixelsChanged` is required');
  const w = num(check, 'regionWidth');
  const h = num(check, 'regionHeight');
  const pixel = ctx.lab.pixel;
  const expected =
    w === null || h === null
      ? `${String(minPixels)} pixels changed`
      : `${String(minPixels)} pixels inside one ${String(w)}×${String(h)} region`;
  if (pixel === null || pixel.changed === 0) {
    return pending('draw something in the 128×64 frame', expected, 'nothing drawn yet');
  }
  const inRegion = pixel.bestWindow?.count ?? 0;
  const observed = `${String(pixel.changed)} pixels changed; ${String(inRegion)} in the densest ${String(pixel.bestWindow?.width ?? 0)}×${String(pixel.bestWindow?.height ?? 0)}`;
  if (w !== null && h !== null && inRegion < minPixels) {
    return pending('keep drawing — the shape is not dense enough yet', expected, observed);
  }
  if (pixel.changed < minPixels) return pending('keep drawing', expected, observed);
  return passed('a frame was drawn into the same buffer the firmware pushes', observed, expected);
}

// ------------------------------------------------------------------ 23-24. http

function httpRequest(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const route = str(check, 'route');
  const method = str(check, 'method');
  const expectStatus = num(check, 'expectStatus');
  if (route === null || method === null || expectStatus === null) {
    return dataFault('`route`, `method` and `expectStatus` are required');
  }
  const duringMovement = str(check, 'duringMovement');
  const candidates = ctx.lab.http.filter((h) => h.route === route && h.method === method);
  if (candidates.length === 0) {
    return pending(`send ${method} ${route}`, `${String(expectStatus)}`, 'nothing sent yet');
  }
  const wanted = candidates.filter(
    (h) => h.status === expectStatus && (duringMovement === null || h.duringMovement === duringMovement),
  );
  if (wanted.length > 0) {
    return passed(
      duringMovement === null
        ? `${method} ${route} answered ${String(expectStatus)}`
        : `${method} ${route} answered ${String(expectStatus)} while ${duringMovement} was still running`,
      `${String(expectStatus)}`,
      `${String(expectStatus)}`,
    );
  }
  const last = candidates[candidates.length - 1];
  if (last?.error !== null && last?.error !== undefined) {
    return failed(
      `the request never completed: ${last.error}. This origin does not serve the firmware's routes — ` +
        `run apps/web/server/lab-host.mjs and point the app at it.`,
      last.error,
      `${String(expectStatus)}`,
    );
  }
  if (duringMovement !== null && candidates.some((h) => h.status === expectStatus)) {
    return pending(
      `send it again WHILE ${duringMovement} is running`,
      `${String(expectStatus)} during ${duringMovement}`,
      `${String(expectStatus)}, but nothing was moving`,
    );
  }
  const status = last?.status ?? null;
  // A 404 on one of the firmware's own routes is not a wrong status; it is the
  // absence of a robot. Say which, rather than leaving a learner to conclude
  // the route does not exist in the firmware either.
  const orphaned = status === 404 || status === 501;
  return failed(
    `${method} ${route} answered ${String(status ?? '?')}` +
      (orphaned
        ? ` — nothing on this origin is serving the robot's routes. They only exist in front of a ` +
          `robot: run apps/web/server/lab-host.mjs and open the app from it.`
        : ''),
    String(status ?? '?'),
    String(expectStatus),
  );
}

function httpJsonField(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const route = str(check, 'route');
  const jsonPath = str(check, 'jsonPath');
  if (route === null || jsonPath === null) return dataFault('`route` and `jsonPath` are required');
  const equalsLearnerInput = bool(check, 'equalsLearnerInput') ?? false;
  const equals = check['equals'];
  const exchanges = ctx.lab.http.filter((h) => h.route === route);
  const last = exchanges[exchanges.length - 1];
  if (last === undefined) return pending(`read ${route}`, jsonPath, 'nothing sent yet');
  if (last.jsonError !== null) {
    return failed(
      `${route} did not return JSON: ${last.jsonError}`,
      last.responseText.slice(0, 160),
      `a JSON object with ${jsonPath}`,
    );
  }
  const value = readPath(last.json, jsonPath);
  if (value === undefined) {
    return failed(`${route}'s response has no field ${jsonPath}`, JSON.stringify(last.json)?.slice(0, 160) ?? 'null', jsonPath);
  }
  if (equalsLearnerInput) {
    const sent = ctx.runtime.lastAction('http', (a) => typeof a.detail['commandWord'] === 'string');
    const word = sent === null ? null : String(sent.detail['commandWord']);
    if (word === null) return pending(`send a command word through ${route}'s console first`, jsonPath, String(value));
    if (value === word) {
      return passed(
        `${jsonPath} still reports "${word}" — the dispatcher never cleared it`,
        String(value),
        word,
      );
    }
    return failed(`${jsonPath} reports "${String(value)}", not the word you sent`, String(value), word);
  }
  if (equals !== undefined) {
    return value === equals
      ? passed(`${jsonPath} is ${String(value)}`, String(value), String(equals))
      : failed(`${jsonPath} is ${String(value)}`, String(value), String(equals));
  }
  return passed(`${jsonPath} reads ${String(value)}`, String(value), jsonPath);
}

function readPath(json: unknown, path: string): unknown {
  let node: unknown = json;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

// --------------------------------------------------------------- 25. subtrim

function subtrimSet(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const joint = str(check, 'joint') as JointName | null;
  const wanted = num(check, 'subtrimDeg');
  if (joint === null || wanted === null) return dataFault('`joint` and `subtrimDeg` are required');
  // Read back off the ROBOT's own state (TelemetryStore.applyModelState folds in
  // `RobotState.joints[j].subtrimDeg`), not off the slider that set it.
  const reported = ctx.joints[joint]?.subtrimDeg ?? null;
  const expected = `${joint} subtrim ${String(wanted)}°`;
  if (reported === wanted) {
    return passed(`the robot reports ${String(reported)}° of subtrim on ${joint}`, `${String(reported)}°`, expected);
  }
  if (ctx.lab.subtrimDeg[joint] === wanted) {
    return pending('waiting for the robot to report the new offset', expected, `${String(reported ?? 0)}° so far`);
  }
  return pending(`set ${joint}'s subtrim to ${String(wanted)}°`, expected, `${String(reported ?? 0)}°`);
}

// ------------------------------------------------------------------ 26. boot

function bootHalt(check: LessonCheck, ctx: CheckContext): CheckOutcome {
  const haltAt = num(check, 'expectHaltAtBootOrder');
  const logContains = str(check, 'expectLogContains');
  if (haltAt === null || logContains === null) {
    return dataFault('`expectHaltAtBootOrder` and `expectLogContains` are required');
  }
  const run = ctx.lab.bootRuns[ctx.lab.bootRuns.length - 1];
  const expected = `halt at boot step ${String(haltAt)}, printing "${logContains}"`;
  if (run === undefined) return pending('turn the fault on and boot the robot', expected, 'not booted yet');
  if (run.haltedAt === null) {
    return failed(
      'boot ran to completion — the display fault was not on',
      `reached all ${String(run.reached.length)} steps`,
      expected,
    );
  }
  const observed = `halted at ${String(run.haltedAt)}: ${run.log.join(' / ')}`;
  if (run.haltedAt !== haltAt) {
    return failed(`boot halted at step ${String(run.haltedAt)}`, observed, expected);
  }
  if (!run.log.some((line) => line.includes(logContains))) {
    return failed('the halt printed a different line', observed, expected);
  }
  return passed(
    `boot stopped at step ${String(haltAt)}; nothing after it ever ran`,
    observed,
    expected,
  );
}
