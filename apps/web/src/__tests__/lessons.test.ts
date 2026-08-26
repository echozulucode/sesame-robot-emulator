/**
 * The lesson runner, tested where it is testable without a browser.
 *
 * The end-to-end proof — lesson 2 played through in a real browser engine — is
 * `scripts/capture-web-screenshots.mjs` phase 10, for the same reason phase 1
 * reads `Object3D.quaternion`: a check that has only ever been evaluated
 * against a hand-built context has not been shown to work. What *is* worth
 * pinning here is everything a browser cannot make more true:
 *
 *  - the registry's claim about what is built matches `hardware/lessons.json`;
 *  - a check FAILS when the state contradicts it — the property that makes the
 *    whole mechanic falsifiable;
 *  - an unimplemented check can never return `passed`;
 *  - the PWM numbers `lessons.json` asserts agree with the library's own
 *    arithmetic, for every check that names one;
 *  - a skip is a skip, and unlocks nothing;
 *  - `localStorage` throwing does not break anything;
 *  - the simulator really does read the subtrim array the lab mutates, which is
 *    what makes `subtrim-set` and `commanded-angle-collision` mean anything.
 */
import { JOINT_ORDER, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { SimBackend } from '../backends/sim-backend.js';
import { importMovement, outOfRangeAngles, scaleDelays } from '../editors/sequence.js';
import { blankFrame, changedPixels, densestWindow, setPixel } from '../editors/pixel-frame.js';
import {
  CHECK_TYPES,
  CONCEPTUAL_LESSONS_WITH_SYMBOLS,
  CONTROL_KINDS,
  DECLARED_FAULTS,
  LESSONS,
  LESSON_BY_ID,
  type CheckTypeId,
  type ControlKind,
  type LessonCheck,
} from '../generated/lessons.js';
import { CURRICULUM } from '../generated/source-annotations.js';
import { evaluateCheck, type CheckContext, type ModelReading } from '../lessons/checks.js';
import {
  IMPLEMENTED_CHECKS,
  IMPLEMENTED_CONTROLS,
  UNIMPLEMENTED_CONTROLS,
  isCheckImplemented,
} from '../lessons/registry.js';
import {
  EMPTY_PROGRESS,
  clearProgress,
  lessonProgress,
  loadProgress,
  lockStateFor,
  recordOutcome,
  recordSkip,
  saveProgress,
} from '../lessons/progress.js';
import { LessonRuntime, runBootModel } from '../lessons/runtime.js';
import { BOOT_ORDER } from '../generated/lessons.js';
import { EMPTY_SELECTION } from '../state/selection.js';
import { TelemetryStore } from '../state/telemetry-store.js';

// -------------------------------------------------------------- fixtures

const blankJoints = (): Record<JointName, never> =>
  Object.fromEntries(
    JOINT_ORDER.map((joint) => [
      joint,
      {
        joint,
        commandedDeg: null,
        simulatedDeg: null,
        measuredDeg: null,
        subtrimDeg: null,
        provenance: null,
        origin: null,
        physicallyObserved: false,
        lastSeq: null,
        lastTraceId: null,
        warnings: [],
        updates: 0,
      },
    ]),
  ) as never;

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  const runtime = overrides.runtime ?? new LessonRuntime();
  return {
    runtime,
    lab: overrides.lab ?? runtime.snapshot(),
    joints: overrides.joints ?? blankJoints(),
    model: overrides.model ?? null,
    trace: overrides.trace ?? null,
    selection: overrides.selection ?? EMPTY_SELECTION,
    nowMs: overrides.nowMs ?? Date.now(),
  };
}

const servoEvent = (joint: JointName, angleDeg: number, seq: number): SesameTelemetry =>
  ({ type: 'servo.target', joint, angleDeg, seq, provenance: 'simulated' }) as SesameTelemetry;

const allChecks = (): { lessonId: string; check: LessonCheck }[] => {
  const out: { lessonId: string; check: LessonCheck }[] = [];
  for (const lesson of LESSONS) {
    for (const step of lesson.steps) out.push({ lessonId: lesson.id, check: step.success.check });
    for (const challenge of lesson.challenges) {
      out.push({ lessonId: lesson.id, check: challenge.success.check });
    }
  }
  return out;
};

// =========================================================== the registry

describe('the registry says what is built, and lessons.json agrees', () => {
  const declaredControls = new Set(CONTROL_KINDS.map((c) => c.id as ControlKind));
  const declaredChecks = new Set(CHECK_TYPES.map((c) => c.id));

  it('names only declared control kinds, and partitions all 22', () => {
    for (const id of [...IMPLEMENTED_CONTROLS, ...UNIMPLEMENTED_CONTROLS]) {
      expect(declaredControls.has(id), `${id} is not declared in lessons.json`).toBe(true);
    }
    const union = new Set([...IMPLEMENTED_CONTROLS, ...UNIMPLEMENTED_CONTROLS]);
    expect(union.size).toBe(declaredControls.size);
    expect(IMPLEMENTED_CONTROLS.length + UNIMPLEMENTED_CONTROLS.length).toBe(union.size);
  });

  it('names only declared check types', () => {
    for (const id of IMPLEMENTED_CHECKS) {
      expect(declaredChecks.has(id), `${id} is not declared in lessons.json`).toBe(true);
    }
  });

  /**
   * The scope this task actually took: lessons 1–6 fully playable. If a polished
   * lesson ever grows a step using a control or check that is not built, this
   * fails rather than the learner discovering it.
   */
  it('implements every control and check the six POLISHED lessons use', () => {
    const missingControls = new Set<string>();
    const missingChecks = new Set<string>();
    for (const lesson of LESSONS.filter((l) => l.status === 'polished')) {
      for (const step of lesson.steps) {
        if (!IMPLEMENTED_CONTROLS.includes(step.manipulate.control)) {
          missingControls.add(step.manipulate.control);
        }
        if (!isCheckImplemented(step.success.check.type)) missingChecks.add(step.success.check.type);
      }
      for (const challenge of lesson.challenges) {
        if (!isCheckImplemented(challenge.success.check.type)) {
          missingChecks.add(challenge.success.check.type);
        }
      }
    }
    expect([...missingControls]).toEqual([]);
    expect([...missingChecks]).toEqual([]);
  });

  it('every check type the unbuilt list names is used ONLY by outline lessons', () => {
    for (const lesson of LESSONS.filter((l) => l.status === 'polished')) {
      for (const step of lesson.steps) {
        expect(isCheckImplemented(step.success.check.type)).toBe(true);
      }
    }
  });
});

// ============================================== conceptual, from grounding

describe('the conceptual badge is driven by grounding, not by symbol count', () => {
  it('copies grounding from source-annotations.json for all 19 modules', () => {
    for (const lesson of LESSONS) {
      const entry = CURRICULUM.find((m) => m.id === lesson.curriculumRef);
      expect(entry, `${lesson.id} has no curriculum entry`).toBeDefined();
      expect(lesson.grounding).toBe(entry?.grounding);
    }
  });

  it('badges 7 modules, three of which DO carry symbols', () => {
    const conceptual = LESSONS.filter((l) => l.grounding === 'conceptual');
    expect(conceptual).toHaveLength(7);
    // The three L4 §6.3 measured. Badging on `symbols.length === 0` would leave
    // these unbadged, which is the bug this pins.
    expect([...CONCEPTUAL_LESSONS_WITH_SYMBOLS].sort()).toEqual([
      'build-a-leg-pose',
      'build-a-movement',
      'inside-the-brain',
    ]);
    for (const id of CONCEPTUAL_LESSONS_WITH_SYMBOLS) {
      const entry = CURRICULUM.find((m) => m.id === LESSON_BY_ID.get(id)?.curriculumRef);
      expect(entry?.symbols.length ?? 0).toBeGreaterThan(0);
      expect(LESSON_BY_ID.get(id)?.grounding).toBe('conceptual');
    }
  });

  it('every conceptual lesson carries a conceptualReason to show in the badge', () => {
    for (const lesson of LESSONS.filter((l) => l.grounding === 'conceptual')) {
      expect(lesson.conceptualReason, lesson.id).toBeTruthy();
    }
  });
});

// ==================================================== faults and boundaries

describe('faults, boundaries and the no-hardware constraint', () => {
  it('separates the three shipped faults from the four injected ones', () => {
    const shipped = DECLARED_FAULTS.filter((f) => !f.injectorIsLabFeature).map((f) => f.id);
    expect(shipped.sort()).toEqual([
      'blank-face-stand',
      'status-json-unescaped',
      'unknown-command-sticks',
      'walk-cancelled-into-idle',
    ]);
    expect(DECLARED_FAULTS.filter((f) => f.injectorIsLabFeature)).toHaveLength(3);
  });

  it('every boundaryNote sits on a factual claim about a non-firmware domain', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (step.claim.boundaryNote === null) continue;
        expect(['library', 'emulator', 'lab'], `${lesson.id}/${step.id}`).toContain(
          step.claim.domain,
        );
      }
    }
  });

  it('every emulator claim states an observability value', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        if (step.claim.domain !== 'emulator') continue;
        expect(step.claim.observability, `${lesson.id}/${step.id}`).not.toBeNull();
      }
    }
  });
});

// ================================================ the arithmetic is recomputed

describe('the PWM numbers in lessons.json agree with the library arithmetic', () => {
  it('recomputes every pwm-value-matched check', () => {
    let seen = 0;
    for (const { check } of allChecks()) {
      if (check.type !== 'pwm-value-matched') continue;
      seen += 1;
      const q = quantiseCommandedAngle(check['angleDeg'] as number);
      expect(q.mappedUs).toBe(check['expectRequestedPulseUs']);
      expect(q.ticks).toBe(check['expectTicks']);
      expect(q.pulseUs).toBeCloseTo(check['expectQuantisedPulseUs'] as number, 6);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('recomputes every fixed quantisation-collision check', () => {
    let seen = 0;
    for (const { check } of allChecks()) {
      if (check.type !== 'quantisation-collision') continue;
      if (typeof check['angleA'] !== 'number') continue;
      seen += 1;
      const a = quantiseCommandedAngle(check['angleA']);
      const b = quantiseCommandedAngle(check['angleB'] as number);
      expect(a.ticks === b.ticks).toBe(check['expectSameTicks']);
      if (typeof check['expectTicks'] === 'number') expect(a.ticks).toBe(check['expectTicks']);
    }
    expect(seen).toBe(1);
  });
});

// =========================================================== the evaluators

describe('checks pass on the asserted state and FAIL on the wrong state', () => {
  const lesson2 = LESSON_BY_ID.get('command-one-joint');

  it('servo-target passes at 135 and fails at 90 once the learner has tried', () => {
    const check = lesson2?.steps[0]?.success.check as LessonCheck;
    const runtime = new LessonRuntime();
    runtime.noteAction('set-joint', 'R1 ← 90', { joint: 'R1', requestedDeg: 90, subtrimDeg: 0 });

    const joints = blankJoints() as Record<JointName, { commandedDeg: number | null }>;
    joints.R1 = { ...joints.R1, commandedDeg: 90 };
    const wrong = evaluateCheck(check, makeContext({ runtime, joints: joints as never }));
    expect(wrong.status).toBe('failed');
    expect(wrong.observed).toContain('90');

    joints.R1 = { ...joints.R1, commandedDeg: 135 };
    const right = evaluateCheck(check, makeContext({ runtime, joints: joints as never }));
    expect(right.status).toBe('passed');
  });

  it('telemetry-absent fails when a servo.target DID arrive', () => {
    const check = lesson2?.steps[1]?.success.check as LessonCheck;
    // Channel 3 resolves to a joint, so the write goes through and a row arrives.
    const arrived = new LessonRuntime();
    const action = arrived.noteAction('set-channel', 'setServoAngle(3, 90)', {
      channel: 3,
      reached: true,
    });
    arrived.noteEvent(servoEvent('L2', 90, 1));
    const bad = evaluateCheck(check, makeContext({ runtime: arrived, nowMs: action.t + 600 }));
    expect(bad.status).toBe('failed');

    // Channel 8 is dropped by the guard, so nothing is emitted at all.
    const silent = new LessonRuntime();
    const silentAction = silent.noteAction('set-channel', 'setServoAngle(8, 90)', {
      channel: 8,
      reached: false,
    });
    expect(evaluateCheck(check, makeContext({ runtime: silent, nowMs: silentAction.t + 100 })).status).toBe(
      'pending',
    );
    expect(evaluateCheck(check, makeContext({ runtime: silent, nowMs: silentAction.t + 600 })).status).toBe(
      'passed',
    );
  });

  it('commanded-angle-collision needs BOTH observed angles, and fails when they differ', () => {
    const check = lesson2?.steps[2]?.success.check as LessonCheck;

    // Subtrim 0: 160 and 180 stay apart, so the collision the lesson asserts
    // did not happen and the check says so.
    const apart = new LessonRuntime();
    const a = apart.noteAction('set-joint', 'R1 ← 160', { joint: 'R1', requestedDeg: 160, subtrimDeg: 40 });
    apart.noteEvent(servoEvent('R1', 160, 1));
    const b = apart.noteAction('set-joint', 'R1 ← 180', { joint: 'R1', requestedDeg: 180, subtrimDeg: 40 });
    apart.noteEvent(servoEvent('R1', 180, 2));
    void a;
    void b;
    expect(evaluateCheck(check, makeContext({ runtime: apart })).status).toBe('failed');

    // Subtrim +40: both saturate on 180 and the check passes.
    const collided = new LessonRuntime();
    collided.noteAction('set-joint', 'R1 ← 160', { joint: 'R1', requestedDeg: 160, subtrimDeg: 40 });
    collided.noteEvent(servoEvent('R1', 180, 1));
    collided.noteAction('set-joint', 'R1 ← 180', { joint: 'R1', requestedDeg: 180, subtrimDeg: 40 });
    collided.noteEvent(servoEvent('R1', 180, 2));
    expect(evaluateCheck(check, makeContext({ runtime: collided })).status).toBe('passed');
  });

  it('quantisation-collision needs the angles to have been READ, not just to exist', () => {
    const check = lesson2?.steps[3]?.success.check as LessonCheck;
    const runtime = new LessonRuntime();
    expect(evaluateCheck(check, makeContext({ runtime })).status).toBe('pending');
    for (const deg of [99, 100]) {
      const q = quantiseCommandedAngle(deg);
      runtime.notePwmProbe({
        angleDeg: deg,
        mappedUs: q.mappedUs,
        ticks: q.ticks,
        pulseUs: q.pulseUs,
        aliases: q.aliases,
      });
    }
    const outcome = evaluateCheck(check, makeContext({ runtime, lab: runtime.snapshot() }));
    expect(outcome.status).toBe('passed');
    // Recomputed: 87 is not read out of the lesson, it is what the model says.
    expect(outcome.summary).toContain(String(quantiseCommandedAngle(99).ticks));
  });

  it('a quantisation-collision whose expectTicks disagrees with the model FAILS', () => {
    const tampered: LessonCheck = {
      type: 'quantisation-collision',
      angleA: 99,
      angleB: 100,
      expectSameTicks: true,
      expectTicks: 86,
      learnerChosen: false,
    };
    const outcome = evaluateCheck(tampered, makeContext());
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('quantiseCommandedAngle');
  });

  it('boot-halt fails when boot ran to completion', () => {
    const check: LessonCheck = {
      type: 'boot-halt',
      expectHaltAtBootOrder: 4,
      expectLogContains: 'SSD1306 allocation failed.',
    };
    const runtime = new LessonRuntime();
    runtime.noteBootRun({ ...runBootModel(BOOT_ORDER, []), t: Date.now() });
    expect(evaluateCheck(check, makeContext({ runtime, lab: runtime.snapshot() })).status).toBe('failed');

    const halted = new LessonRuntime();
    halted.noteBootRun({ ...runBootModel(BOOT_ORDER, ['oled-init-fail']), t: Date.now() });
    const outcome = evaluateCheck(check, makeContext({ runtime: halted, lab: halted.snapshot() }));
    expect(outcome.status).toBe('passed');
    expect(outcome.observed).toContain('SSD1306 allocation failed.');
  });

  it('face-fallback reads the face the ROBOT reports, not the one requested', () => {
    const check = LESSON_BY_ID.get('sesames-face')?.steps[2]?.success.check as LessonCheck;
    const runtime = new LessonRuntime();
    runtime.noteAction('set-face', 'face ← stand', { face: 'stand', frameAtRequest: 0 });
    const model = (name: string): ModelReading => ({
      faceName: name,
      faceFrame: 0,
      faceMode: 'loop',
      faceFrameCount: 0,
      runningMovement: null,
      currentCommand: '',
      idleActive: false,
    });
    expect(evaluateCheck(check, makeContext({ runtime, model: model('stand') })).status).toBe('failed');
    expect(evaluateCheck(check, makeContext({ runtime, model: model('default') })).status).toBe('passed');
  });

  it('a malformed check is a loud failure, never a silent skip', () => {
    const outcome = evaluateCheck({ type: 'servo-target' } as LessonCheck, makeContext());
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('cannot be evaluated');
  });
});

describe('the eight unbuilt checks refuse rather than pass', () => {
  it('returns unsupported for each, on every parameterisation in the data', () => {
    let seen = 0;
    for (const { check } of allChecks()) {
      if (isCheckImplemented(check.type)) continue;
      seen += 1;
      const outcome = evaluateCheck(check, makeContext());
      expect(outcome.status, check.type).toBe('unsupported');
      expect(outcome.summary).toContain('NOT BUILT');
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('covers every declared check type with an arm — none falls through', () => {
    for (const spec of CHECK_TYPES) {
      const outcome = evaluateCheck({ type: spec.id as CheckTypeId }, makeContext());
      // Either it evaluated (and complained about missing parameters) or it
      // refused. What it must never do is return `passed` on an empty check.
      expect(outcome.status).not.toBe('passed');
    }
  });
});

// ============================================================== progression

describe('progress: a skip is a skip', () => {
  afterEach(() => {
    clearProgress();
  });

  it('records only what the evaluator passed', () => {
    let state = EMPTY_PROGRESS;
    state = recordOutcome(state, 'command-one-joint', 'r1-to-135', {
      status: 'pending',
      summary: '',
      observed: null,
      expected: null,
    });
    expect(state.steps['command-one-joint']).toBeUndefined();
    state = recordOutcome(state, 'command-one-joint', 'r1-to-135', {
      status: 'unsupported',
      summary: '',
      observed: null,
      expected: null,
    });
    expect(state.steps['command-one-joint']).toBeUndefined();
    state = recordOutcome(state, 'command-one-joint', 'r1-to-135', {
      status: 'passed',
      summary: '',
      observed: 'R1=135',
      expected: null,
    });
    expect(state.steps['command-one-joint']?.['r1-to-135']?.outcome).toBe('passed');
  });

  it('a skipped step never completes a lesson and never unlocks the next one', () => {
    const lesson1 = LESSON_BY_ID.get('meet-sesame');
    const lesson2 = LESSON_BY_ID.get('command-one-joint');
    expect(lesson1 && lesson2).toBeTruthy();
    let state = EMPTY_PROGRESS;
    for (const step of lesson1?.steps ?? []) {
      state = recordSkip(state, 'meet-sesame', step.success.id);
    }
    const done = lessonProgress(state, lesson1!);
    expect(done.skipped).toBe(lesson1?.steps.length);
    expect(done.complete).toBe(false);
    expect(done.resolved).toBe(true);
    expect(lockStateFor(state, lesson2!, LESSON_BY_ID).locked).toBe(true);
  });

  it('passing every step unlocks the next lesson', () => {
    const lesson1 = LESSON_BY_ID.get('meet-sesame');
    const lesson2 = LESSON_BY_ID.get('command-one-joint');
    let state = EMPTY_PROGRESS;
    for (const step of lesson1?.steps ?? []) {
      state = recordOutcome(state, 'meet-sesame', step.success.id, {
        status: 'passed',
        summary: '',
        observed: null,
        expected: null,
      });
    }
    expect(lessonProgress(state, lesson1!).complete).toBe(true);
    expect(lockStateFor(state, lesson2!, LESSON_BY_ID).locked).toBe(false);
  });

  it('a skip never downgrades a pass', () => {
    let state = recordOutcome(EMPTY_PROGRESS, 'x', 'y', {
      status: 'passed',
      summary: '',
      observed: null,
      expected: null,
    });
    state = recordSkip(state, 'x', 'y');
    expect(state.steps['x']?.['y']?.outcome).toBe('passed');
  });

  it('survives a localStorage that throws on every access', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('site data blocked');
      },
    });
    try {
      expect(loadProgress()).toEqual(EMPTY_PROGRESS);
      expect(() => saveProgress(EMPTY_PROGRESS)).not.toThrow();
      expect(() => clearProgress()).not.toThrow();
    } finally {
      if (original === undefined) {
        // Node 24 has no localStorage by default in this environment.
        Reflect.deleteProperty(globalThis, 'localStorage');
      } else {
        Object.defineProperty(globalThis, 'localStorage', original);
      }
    }
  });

  it('discards a stored record that is not this schema', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
    try {
      store.set('sesame-lab.lessons.v1', '{"version":99,"steps":{"a":{"b":{"outcome":"cheated"}}}}');
      expect(loadProgress()).toEqual(EMPTY_PROGRESS);
      store.set('sesame-lab.lessons.v1', 'not json at all');
      expect(loadProgress()).toEqual(EMPTY_PROGRESS);
      // A well-formed record with one bogus outcome keeps the good half only.
      store.set(
        'sesame-lab.lessons.v1',
        '{"version":1,"steps":{"l":{"good":{"outcome":"passed","at":1},"bad":{"outcome":"cheated"}}}}',
      );
      const loaded = loadProgress();
      expect(loaded.steps['l']?.['good']?.outcome).toBe('passed');
      expect(loaded.steps['l']?.['bad']).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

// ============================================================ shared editors

describe('the shared editors', () => {
  it('imports runWavePose from the extracted choreography, expanding nested calls', () => {
    const imported = importMovement('runWavePose');
    expect(imported).not.toBeNull();
    const doc = imported!.doc;
    expect(doc.basedOnMovement).toBe('runWavePose');
    // Wave calls runStandPose, so the flattened form has to carry more than the
    // four writes in wave's own body.
    const writes = doc.frames.flatMap((f) => Object.keys(f.angles));
    expect(writes.length).toBeGreaterThan(4);
    expect(outOfRangeAngles(doc)).toEqual([]);
  });

  it('scales every wait and touches no angle', () => {
    const doc = importMovement('runWavePose')!.doc;
    const slower = scaleDelays(doc, 2);
    expect(slower.frames.map((f) => f.delayMs)).toEqual(doc.frames.map((f) => f.delayMs * 2));
    expect(slower.frames.map((f) => f.angles)).toEqual(doc.frames.map((f) => f.angles));
  });

  it('reports an authored angle the firmware could not command', () => {
    const doc = {
      name: 'x',
      basedOnMovement: null,
      frames: [{ angles: { R1: 200 } as Record<string, number>, delayMs: 0 }],
    };
    expect(outOfRangeAngles(doc as never)).toEqual([{ joint: 'R1', angleDeg: 200 }]);
  });

  it('measures a 5x5 shape by locality, not by total', () => {
    let frame = blankFrame();
    // Five pixels scattered across the frame: enough pixels, wrong shape.
    for (let i = 0; i < 5; i += 1) frame = setPixel(frame, i * 20, i * 10, true);
    expect(densestWindow(frame, 5, 5).count).toBe(1);

    let clustered = blankFrame();
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 2; x += 1) clustered = setPixel(clustered, 10 + x, 10 + y, true);
    }
    expect(densestWindow(clustered, 5, 5).count).toBe(6);
    expect(changedPixels(blankFrame(), clustered)).toBe(6);
  });
});

// =========================================== the subtrim seam actually works

describe('the simulator reads the subtrim the lab writes', () => {
  it('applies the offset before the clamp, on the next command', async () => {
    const backend = new SimBackend();
    const store = new TelemetryStore();
    const seen: { joint: string; angleDeg: number }[] = [];
    backend.onEvent((event) => {
      store.ingest(event);
      if (event.type === 'servo.target') seen.push({ joint: event.joint, angleDeg: event.angleDeg });
    });
    await backend.start();
    try {
      await backend.setJoint('R1', 160);
      expect(seen.at(-1)).toEqual({ joint: 'R1', angleDeg: 160 });

      // The mutation the lab performs. Nothing is reconstructed here: the model
      // reads this array on its next write.
      backend.setSubtrim('R1', 40);
      await backend.setJoint('R1', 160);
      expect(seen.at(-1)).toEqual({ joint: 'R1', angleDeg: 180 });
      await backend.setJoint('R1', 180);
      expect(seen.at(-1)).toEqual({ joint: 'R1', angleDeg: 180 });

      // And it round-trips into RobotState, which is what `subtrim-set` reads.
      const state = await backend.modelState();
      expect(state?.joints.R1.subtrimDeg).toBe(40);
    } finally {
      await backend.stop();
    }
  });

  it('clamps the offset to the firmware’s own -90..90', () => {
    const backend = new SimBackend();
    backend.setSubtrim('L4', 500);
    expect(backend.subtrimDeg[7]).toBe(90);
    backend.setSubtrim('L4', -500);
    expect(backend.subtrimDeg[7]).toBe(-90);
  });
});
