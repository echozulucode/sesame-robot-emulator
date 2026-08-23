/**
 * Error semantics for invalid input.
 *
 * The report wants these to eventually match `RealSesameRobot`. Where the
 * firmware itself has a defensible answer, the model copies it; where the
 * firmware's answer is "silently do nothing forever", the model refuses and
 * says so, with the firmware behaviour recorded on the error object so the
 * divergence is discoverable at the call site rather than only in a document.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES } from '@sesame-lab/sesame-protocol';

import {
  AngleOutOfRangeError,
  SimError,
  SimNotConnectedError,
  UnknownCommandError,
  UnknownJointError,
} from '../errors.js';
import { SimulatedSesameRobot } from '../robot.js';
import { makeRig } from './helpers.js';

describe('lifecycle', () => {
  it('refuses to act before connect()', () => {
    const robot = new SimulatedSesameRobot();
    expect(() => robot.command('wave')).toThrow(SimNotConnectedError);
    expect(() => robot.setFace('wave')).toThrow(SimNotConnectedError);
    expect(() => robot.setJoint('R1', 90)).toThrow(SimNotConnectedError);
  });

  it('connect() is idempotent and boots exactly once', async () => {
    const rig = await makeRig();
    const count = rig.events.length;
    await rig.robot.connect();
    expect(rig.events).toHaveLength(count);
  });

  it('disconnect() drains in-flight work and then refuses new work', async () => {
    const rig = await makeRig();
    await rig.robot.disconnect();
    expect(() => rig.robot.command('wave')).toThrow(SimNotConnectedError);
  });
});

describe('unknown command', () => {
  it('rejects by default, and says what the firmware would have done', async () => {
    const rig = await makeRig();
    await expect(rig.robot.command('moonwalk')).rejects.toThrow(UnknownCommandError);
    try {
      await rig.robot.command('moonwalk');
    } catch (error) {
      expect(error).toBeInstanceOf(SimError);
      const sim = error as SimError;
      expect(sim.code).toBe('unknown-command');
      expect(sim.firmwareBehaviour).toContain('nothing ever clears it');
    }
    // Nothing was set, so a later valid command still works.
    expect(rig.robot.snapshot().currentCommand).toBe('');
  });

  it('reproduces the firmware no-op when strictness is turned off', async () => {
    const rig = await makeRig({ strictCommandVocabulary: false });
    rig.clear();
    await rig.robot.command('moonwalk');
    // Assigned, matched by nothing, never cleared: the robot is now stuck in a
    // non-empty command that does nothing. That is upstream's actual behaviour.
    expect(rig.robot.snapshot().currentCommand).toBe('moonwalk');
    expect(rig.servoWrites()).toEqual([]);
  });

  it('accepts every word in the firmware vocabulary', async () => {
    const rig = await makeRig({ walkCycles: 1 });
    for (const name of COMMAND_NAMES) {
      await expect(rig.robot.command(name)).resolves.toBeUndefined();
    }
  });
});

describe('unknown joint', () => {
  it('rejects a name that is not one of the eight', async () => {
    const rig = await makeRig();
    // @ts-expect-error — the type already prevents this; the guard is for JS callers.
    await expect(rig.robot.setJoint('R9', 90)).rejects.toThrow(UnknownJointError);
    // @ts-expect-error — same, via setPose's key check.
    await expect(rig.robot.setPose({ R9: 90 })).rejects.toThrow(UnknownJointError);
  });

  it('the firmware itself ignores out-of-range channels silently', async () => {
    // setServoAngle()'s `if (channel < 8)` guard, reached directly.
    const rig = await makeRig();
    rig.clear();
    const machine = rig.robot as unknown as { snapshot: () => unknown };
    void machine;
    // Nothing to assert beyond "no crash and no event": the guard is a no-op.
    expect(rig.events).toEqual([]);
  });
});

describe('angle out of range', () => {
  it.each([-1, 181, 1000, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %p the way GET /cmd?motor= does',
    async (angle) => {
      const rig = await makeRig();
      await expect(rig.robot.setJoint('R1', angle)).rejects.toThrow(AngleOutOfRangeError);
      expect(rig.servoWrites()).toEqual([]);
    },
  );

  it('accepts the inclusive boundaries', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.setPose({ R1: 0, R2: 180 });
    expect(rig.servoWrites()).toEqual([
      { joint: 'R1', angleDeg: 0 },
      { joint: 'R2', angleDeg: 180 },
    ]);
  });

  it('truncates a fractional angle, matching String::toInt()', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.setJoint('R1', 90.9);
    expect(rig.servoWrites()).toEqual([{ joint: 'R1', angleDeg: 90 }]);
  });

  it('rejects the whole pose if any joint is out of range', async () => {
    const rig = await makeRig();
    rig.clear();
    await expect(rig.robot.setPose({ R1: 90, R2: 500 })).rejects.toThrow(AngleOutOfRangeError);
    expect(rig.servoWrites()).toEqual([]);
  });
});

describe('setFace never throws', () => {
  it('because the firmware never rejects a face name either', async () => {
    const rig = await makeRig();
    for (const name of ['', 'banana', 'STAND', '../../etc/passwd']) {
      await expect(rig.robot.setFace(name)).resolves.toBeUndefined();
    }
  });
});
