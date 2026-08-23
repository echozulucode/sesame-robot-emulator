/**
 * The contract suite's hard-coded expectations, cross-checked against the
 * extractor.
 *
 * `STAND_POSE_TARGETS` and `WAVE_OPENING_WRITES` are transcribed by hand from
 * `firmware/movement-sequences.h` on purpose: a contract suite that derived its
 * expectations from `hardware-map.json` would agree with `sesame-sim` by
 * construction, since `sesame-sim`'s choreography is generated from that same
 * file. Two independent readings of the firmware are worth more than one
 * reading used twice.
 *
 * The cost of a hand transcription is a typo, so this test closes that: the
 * literals must also match the extraction. If they ever diverge, either the
 * transcription is wrong or the extractor is — and both are worth knowing.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';

import { STAND_POSE_TARGETS, WAVE_OPENING_WRITES } from '../contract/index.js';

interface Step {
  type: string;
  joint?: JointName;
  angleDeg?: number;
  steps?: Step[];
}

interface Movement {
  function: string;
  steps: Step[];
}

const hardwareMap = JSON.parse(
  readFileSync(new URL('../../../../hardware/hardware-map.json', import.meta.url), 'utf8'),
) as { movements: Movement[] };

function movement(name: string): Movement {
  const found = hardwareMap.movements.find((m) => m.function === name);
  if (found === undefined) throw new Error(`no movement ${name}`);
  return found;
}

/** Servo writes in the function's own body; `call` steps are not followed. */
function ownServoWrites(name: string): Array<readonly [JointName, number]> {
  const out: Array<readonly [JointName, number]> = [];
  const walk = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if (step.type === 'servo' && step.joint !== undefined && step.angleDeg !== undefined) {
        out.push([step.joint, step.angleDeg]);
      } else if (step.steps !== undefined && step.type !== 'call') {
        walk(step.steps);
      }
    }
  };
  walk(name === '' ? [] : movement(name).steps);
  return out;
}

describe('the contract suite agrees with the extractor', () => {
  it('runStandPose writes exactly the eight targets, in firmware channel order', () => {
    const writes = ownServoWrites('runStandPose');
    expect(writes).toHaveLength(8);
    expect(writes.map(([joint]) => joint)).toEqual([...JOINT_ORDER]);
    for (const [joint, angle] of writes) {
      expect(angle, joint).toBe(STAND_POSE_TARGETS[joint]);
    }
  });

  it('runWavePose opens with the four setup writes the suite expects', () => {
    const writes = ownServoWrites('runWavePose');
    expect(writes.slice(0, WAVE_OPENING_WRITES.length)).toEqual([...WAVE_OPENING_WRITES]);
  });
});
