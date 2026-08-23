/**
 * `setServoAngle()` semantics — ino:1051.
 *
 * ```c
 * int adjustedAngle = constrain(angle + servoSubtrim[channel], 0, 180);
 * servos[channel].write(adjustedAngle);
 * delayWithFace(motorCurrentDelay);
 * ```
 *
 * The order is the point. Subtrim is added *before* the clamp, so a channel
 * with a large trim saturates on requests that are perfectly legal on an
 * untrimmed one — and the telemetry reports the saturated value, because that
 * is what the servo was actually told.
 */
import { describe, expect, it } from 'vitest';

import { HAS_JOINT_POSITION_FEEDBACK, JOINT_ORDER } from '@sesame-lab/sesame-model';

import { makeRig } from './helpers.js';

describe('subtrim is applied before the clamp', () => {
  it('shifts an in-range angle by the trim', async () => {
    // Index 0 is R1.
    const rig = await makeRig({ subtrimDeg: [7, 0, 0, 0, 0, 0, 0, 0] });
    rig.clear();
    await rig.robot.setJoint('R1', 90);
    expect(rig.servoWrites()).toEqual([{ joint: 'R1', angleDeg: 97 }]);
  });

  it('saturates at 180 when the trim pushes past the boundary', async () => {
    const rig = await makeRig({ subtrimDeg: [40, 0, 0, 0, 0, 0, 0, 0] });
    rig.clear();
    // 170 is a legal request; 170 + 40 = 210 is not, so the servo gets 180.
    await rig.robot.setJoint('R1', 170);
    expect(rig.servoWrites()).toEqual([{ joint: 'R1', angleDeg: 180 }]);
    const state = await rig.robot.getState();
    expect(state.joints.R1.commandedDeg).toBe(180);
    expect(state.joints.R1.subtrimDeg).toBe(40);
  });

  it('saturates at 0 for a negative trim', async () => {
    const rig = await makeRig({ subtrimDeg: [0, -30, 0, 0, 0, 0, 0, 0] });
    rig.clear();
    await rig.robot.setJoint('R2', 10); // 10 - 30 = -20 -> 0
    expect(rig.servoWrites()).toEqual([{ joint: 'R2', angleDeg: 0 }]);
  });

  it('clamping *after* the addition is what produces the saturation', async () => {
    // If the firmware clamped first and then added the trim, this would be 187.
    const rig = await makeRig({ subtrimDeg: [7, 0, 0, 0, 0, 0, 0, 0] });
    rig.clear();
    await rig.robot.setJoint('R1', 180);
    expect(rig.servoWrites()).toEqual([{ joint: 'R1', angleDeg: 180 }]);
  });

  it('applies per channel, using the firmware index order', async () => {
    // JOINT_ORDER[4] is R4, not R3 — the order really is R1,R2,L1,L2,R4,R3,L3,L4.
    expect(JOINT_ORDER[4]).toBe('R4');
    const rig = await makeRig({ subtrimDeg: [0, 0, 0, 0, 5, -5, 0, 0] });
    rig.clear();
    await rig.robot.setPose({ R4: 100, R3: 100 });
    expect(rig.servoWrites()).toEqual([
      { joint: 'R4', angleDeg: 105 },
      { joint: 'R3', angleDeg: 95 },
    ]);
  });

  it('runs the whole choreography through the trim', async () => {
    const rig = await makeRig({ subtrimDeg: [0, 0, 0, 0, 0, 0, 0, 10] });
    rig.clear();
    await rig.robot.runMovement('runRestPose');
    const l4 = rig.servoWrites().filter((w) => w.joint === 'L4');
    expect(l4).toEqual([{ joint: 'L4', angleDeg: 100 }]);
  });
});

describe('every servo write costs motorCurrentDelay', () => {
  it('20 ms by default', async () => {
    const rig = await makeRig();
    const before = rig.robot.nowMs;
    await rig.robot.setJoint('R1', 90);
    expect(rig.robot.nowMs - before).toBe(20);
  });

  it('follows the runtime-settable value', async () => {
    const rig = await makeRig({ motorCurrentDelayMs: 50 });
    const before = rig.robot.nowMs;
    await rig.robot.setJoint('R1', 90);
    expect(rig.robot.nowMs - before).toBe(50);
  });

  it('accumulates across a pose: eight writes, eight delays', async () => {
    const rig = await makeRig();
    const before = rig.robot.nowMs;
    await rig.robot.runMovement('runRestPose');
    expect(rig.robot.nowMs - before).toBe(8 * 20);
  });
});

describe('measuredDeg and the speed model', () => {
  it('measuredDeg is null on every joint, always', async () => {
    expect(HAS_JOINT_POSITION_FEEDBACK).toBe(false);
    const rig = await makeRig();
    await rig.robot.runMovement('runWavePose');
    const state = await rig.robot.getState();
    for (const joint of JOINT_ORDER) expect(state.joints[joint].measuredDeg).toBeNull();
  });

  it('simulatedDeg lags commandedDeg, and the lag is a declared simulation choice', async () => {
    const rig = await makeRig({ slewDegPerSec: 100 });
    rig.clear();
    await rig.robot.setJoint('R1', 180); // from the 90 power-on assumption
    const mid = await rig.robot.getState();
    // 20 ms at 100 deg/s is 2 degrees of travel, not 90.
    expect(mid.joints.R1.commandedDeg).toBe(180);
    expect(mid.joints.R1.simulatedDeg).toBeCloseTo(92, 6);
    expect(mid.simulated.slewDegPerSec).toBe(100);

    await rig.robot.runFor(2000);
    const settled = await rig.robot.getState();
    expect(settled.joints.R1.simulatedDeg).toBe(180);
  });

  it('slewDegPerSec: null makes simulatedDeg track commandedDeg exactly', async () => {
    const rig = await makeRig({ slewDegPerSec: null });
    await rig.robot.setJoint('R1', 180);
    const state = await rig.robot.getState();
    expect(state.joints.R1.simulatedDeg).toBe(180);
    expect(state.simulated.slewDegPerSec).toBeNull();
  });

  it('says which channels have never been commanded', async () => {
    const rig = await makeRig();
    const before = await rig.robot.getState();
    // setup() attaches the servos and deliberately does not move them, so at
    // boot every commandedDeg is the configured assumption, not an observation.
    for (const joint of JOINT_ORDER) expect(before.simulated.everCommanded[joint]).toBe(false);
    expect(before.joints.R1.commandedDeg).toBe(90);

    await rig.robot.setJoint('R1', 120);
    const after = await rig.robot.getState();
    expect(after.simulated.everCommanded.R1).toBe(true);
    expect(after.simulated.everCommanded.R2).toBe(false);
  });
});
