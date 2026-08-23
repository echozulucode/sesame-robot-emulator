/**
 * `src/generated/choreography.ts` must stay a faithful projection of
 * `hardware/hardware-map.json`.
 *
 * Without this, the generated file is a fork: someone edits an angle here to
 * "fix" a movement, the extractor stays wrong, and the two drift apart with no
 * signal. Same discipline as `sesame-protocol`'s `catalog-drift.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, jointIndex, type JointName } from '@sesame-lab/sesame-model';

import { CHOREOGRAPHY, countSteps, MOVEMENTS, MOVEMENT_NAMES, walkSteps } from '../choreography.js';
import {
  DEFAULT_FACE_FPS,
  DEFAULT_FRAME_DELAY_MS,
  DEFAULT_WALK_CYCLES,
} from '../config.js';
import { STEP_TYPES } from '../choreography-types.js';
import { readHardwareMap, REPO_ROOT, type HwStep } from './helpers.js';

const hardwareMap = readHardwareMap();

describe('generated choreography', () => {
  it('is byte-identical to a fresh generation from hardware-map.json', () => {
    // --check exits non-zero and prints if the file on disk is stale.
    const output = execFileSync(
      process.execPath,
      [resolve(REPO_ROOT, 'packages', 'sesame-sim', 'scripts', 'build-choreography.mjs'), '--check'],
      { encoding: 'utf8' },
    );
    expect(output).toContain('up to date');
  });

  it('carries all 21 movement functions, in extractor order', () => {
    expect(MOVEMENTS).toHaveLength(21);
    expect(MOVEMENT_NAMES).toEqual(hardwareMap.movements.map((m) => m.function));
  });

  it('carries all 395 machine-readable steps, none silently dropped', () => {
    const total = MOVEMENTS.reduce((n, m) => n + countSteps(m), 0);
    expect(total).toBe(395);
    expect(CHOREOGRAPHY.meta.stepCount).toBe(395);

    // Re-count from the raw JSON independently of the generator.
    const countRaw = (steps: readonly HwStep[]): number =>
      steps.reduce((n, s) => n + 1 + countRaw(s.steps ?? []), 0);
    const raw = hardwareMap.movements.reduce((n, m) => n + countRaw(m.steps), 0);
    expect(total).toBe(raw);
  });

  it('preserves file:line provenance on every step', () => {
    for (const movement of MOVEMENTS) {
      for (const step of walkSteps(movement.steps)) {
        expect(step.source.file).toMatch(/^firmware\//);
        expect(step.source.line).toBeGreaterThan(0);
      }
    }
  });

  it('uses only step kinds the interpreter declares', () => {
    const seen = new Set<string>();
    for (const movement of MOVEMENTS) {
      for (const step of walkSteps(movement.steps)) seen.add(step.type);
    }
    for (const type of seen) expect(STEP_TYPES).toContain(type);
    // Every declared kind is actually exercised: no dead branches in the
    // interpreter's switch, and no kind the extractor stopped emitting.
    expect([...seen].sort()).toEqual([...STEP_TYPES].sort());
  });

  it('agrees with JOINT_ORDER on every servo step', () => {
    expect(CHOREOGRAPHY.jointOrder).toEqual([...JOINT_ORDER]);
    for (const movement of MOVEMENTS) {
      for (const step of walkSteps(movement.steps)) {
        if (step.type !== 'servo') continue;
        expect(jointIndex(step.joint as JointName)).toBe(step.index);
      }
    }
  });

  it('pins the firmware constants that are typed out rather than projected', () => {
    // These three are literals in `config.ts`. They are cheap to type and
    // expensive to get wrong, so they are checked against the extractor here
    // rather than trusted.
    const map = readHardwareMap() as unknown as {
      faces: { defaultFps: number };
      movements: { steps: HwStep[] }[];
    };
    expect(DEFAULT_FACE_FPS).toBe(map.faces.defaultFps);

    const refs = new Map<string, number>();
    const collect = (steps: readonly HwStep[]): void => {
      for (const step of steps) {
        if (step.type === 'repeat' && step.countRef !== null && step.countRef !== undefined) {
          refs.set(step.countRef, step.countDefault as number);
        }
        if (
          step.type === 'interruptCheck' &&
          step.durationMsRef !== null &&
          step.durationMsRef !== undefined
        ) {
          refs.set(step.durationMsRef, step.durationMsDefault as number);
        }
        collect(step.steps ?? []);
      }
    };
    for (const movement of map.movements) collect(movement.steps);
    expect(refs.get('walkCycles')).toBe(DEFAULT_WALK_CYCLES);
    expect(refs.get('frameDelay')).toBe(DEFAULT_FRAME_DELAY_MS);
  });

  it('keeps the servo facts the model executes against', () => {
    const sc = hardwareMap.servos.servoConfig as {
      angleClamp: { min: number; max: number };
      motorCurrentDelay: { defaultMs: number };
      subtrim: { defaults: number[] };
    };
    expect(CHOREOGRAPHY.angleClamp).toEqual({ min: sc.angleClamp.min, max: sc.angleClamp.max });
    expect(CHOREOGRAPHY.motorCurrentDelayMs).toBe(sc.motorCurrentDelay.defaultMs);
    expect(CHOREOGRAPHY.subtrimDefaults).toEqual(sc.subtrim.defaults);
  });
});
