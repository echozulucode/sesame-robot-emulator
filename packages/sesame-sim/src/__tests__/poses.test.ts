/**
 * F6's round-number collapses, re-derived through the model.
 *
 * F6 found that under `bodyRelativeDeg = (commandedDeg − 90) × sign`, with the
 * sign classes `{R1, L2, R3, L4} = +1` and `{R2, L1, R4, L3} = −1`, whole poses
 * become a single number: rest → 0 everywhere, stand → +45 on every hip and
 * +90 on every foot, shrug → −90 on every foot, dead → 0 on every foot.
 *
 * That transform was **not fitted to those poses**; it came from a per-joint
 * histogram plus F5's shape classes, and the collapse is what made it
 * credible. Re-checking it here is a three-way cross-check: if the simulator,
 * `hardware/joint-map.json` and the choreography ever stop agreeing about which
 * joint is which, this fails — which is a much louder signal than any of the
 * three failing alone.
 *
 * Both inputs to the transform are **inferred, not measured**. See each entry's
 * `zeroReferenceDeg.caveat` and `directionSign.caveat` in the joint map.
 */
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { loadJointMap } from '@sesame-lab/sesame-model/node';

import { getMovement } from '../choreography.js';
import type { ChoreographyStep } from '../choreography-types.js';
import { indexOfSubsequence, makeRig, type ServoWrite } from './helpers.js';

const jointMap = loadJointMap();

/**
 * The last angle a function writes to each joint **in its own body**, ignoring
 * calls to other functions.
 *
 * That distinction is what makes "the shrug pose" a well-defined thing:
 * `runShrugPose` ends with `runStandPose(1)`, so its final *state* is a stand.
 * The pose F6 is talking about is the last thing the function itself commands.
 */
function ownFinalPose(name: string): ReadonlyMap<JointName, number> {
  const movement = getMovement(name);
  if (movement === undefined) throw new Error(`no movement '${name}'`);
  const pose = new Map<JointName, number>();
  const order: JointName[] = [];
  const walk = (steps: readonly ChoreographyStep[]): void => {
    for (const step of steps) {
      if (step.type === 'servo') {
        pose.set(step.joint, step.angleDeg);
        order.push(step.joint);
      } else if (step.type === 'repeat' || step.type === 'conditional') {
        walk(step.steps);
      }
      // `call` deliberately not followed.
    }
  };
  walk(movement.steps);
  return pose;
}

/** The final consecutive run of writes that establishes that pose. */
function finalWriteRun(name: string): ServoWrite[] {
  const movement = getMovement(name);
  if (movement === undefined) throw new Error(`no movement '${name}'`);
  const flat: ServoWrite[] = [];
  const walk = (steps: readonly ChoreographyStep[]): void => {
    for (const step of steps) {
      if (step.type === 'servo') flat.push({ joint: step.joint, angleDeg: step.angleDeg });
      else if (step.type === 'repeat' || step.type === 'conditional') walk(step.steps);
    }
  };
  walk(movement.steps);
  const pose = ownFinalPose(name);
  // Walk back from the end taking one write per joint, newest first.
  const seen = new Set<JointName>();
  const run: ServoWrite[] = [];
  for (let i = flat.length - 1; i >= 0 && seen.size < pose.size; i--) {
    const write = flat[i];
    if (write === undefined) continue;
    run.unshift(write);
    seen.add(write.joint);
  }
  return run;
}

const HIPS: readonly JointName[] = ['R1', 'R2', 'L1', 'L2'];
const FEET: readonly JointName[] = ['R4', 'R3', 'L3', 'L4'];

describe('F6 body-relative collapses', () => {
  it('the joint map still holds the sign classes F5 and F6 agreed on', () => {
    const positive = JOINT_ORDER.filter((j) => jointMap.get(j).directionSign.value === 1);
    const negative = JOINT_ORDER.filter((j) => jointMap.get(j).directionSign.value === -1);
    expect(new Set(positive)).toEqual(new Set(['R1', 'L2', 'R3', 'L4']));
    expect(new Set(negative)).toEqual(new Set(['R2', 'L1', 'R4', 'L3']));
    for (const joint of JOINT_ORDER) {
      expect(jointMap.get(joint).zeroReferenceDeg.value).toBe(90);
    }
  });

  it('runStandPose commands the documented eight targets', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement('runStandPose', { face: 0 });
    expect(rig.servoWrites()).toEqual([
      { joint: 'R1', angleDeg: 135 },
      { joint: 'R2', angleDeg: 45 },
      { joint: 'L1', angleDeg: 45 },
      { joint: 'L2', angleDeg: 135 },
      { joint: 'R4', angleDeg: 0 },
      { joint: 'R3', angleDeg: 180 },
      { joint: 'L3', angleDeg: 0 },
      { joint: 'L4', angleDeg: 180 },
    ]);
  });

  it.each([
    ['runRestPose', JOINT_ORDER, 0],
    ['runStandPose', HIPS, 45],
    ['runStandPose', FEET, 90],
    ['runShrugPose', FEET, -90],
    ['runDeadPose', FEET, 0],
  ] as const)('%s collapses %s to %d body-relative', async (name, joints, expected) => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement(name, name === 'runStandPose' ? { face: 0 } : null);

    // The pose the function itself establishes must appear, verbatim and
    // consecutively, in what the model actually emitted.
    const run = finalWriteRun(name);
    expect(indexOfSubsequence(rig.servoWrites(), run)).toBeGreaterThanOrEqual(0);

    const pose = ownFinalPose(name);
    for (const joint of joints) {
      const commanded = pose.get(joint);
      expect(commanded, `${name} never commands ${joint}`).toBeTypeOf('number');
      expect(jointMap.toBodyRelativeDeg(joint, commanded as number)).toBe(expected);
    }
  });

  it('runDeadPose does not return to stand — the robot is left collapsed', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement('runDeadPose');
    const writes = rig.servoWrites();
    expect(writes.slice(-4)).toEqual([
      { joint: 'R3', angleDeg: 90 },
      { joint: 'R4', angleDeg: 90 },
      { joint: 'L3', angleDeg: 90 },
      { joint: 'L4', angleDeg: 90 },
    ]);
  });

  it('runShrugPose shows two different faces, dead then shrug', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement('runShrugPose');
    const names = rig.ofType('face.expression').map((e) => e.name);
    expect(names).toContain('dead');
    expect(names).toContain('shrug');
    expect(names.indexOf('dead')).toBeLessThan(names.indexOf('shrug'));
  });
});
