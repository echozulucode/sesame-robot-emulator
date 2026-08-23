/**
 * `RobotState` shape tests, and the one thing about it that is a claim about
 * hardware rather than about TypeScript: the stock robot cannot measure a joint
 * angle, so `measuredDeg` must never be filled in from `commandedDeg`.
 */
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName } from '../joints.js';
import {
  HAS_JOINT_POSITION_FEEDBACK,
  type JointState,
  type RobotState,
  type SesameCapabilities,
} from '../state.js';
import { loadJointMap } from '../node.js';

const emptyJoints = (): Record<JointName, JointState> =>
  Object.fromEntries(JOINT_ORDER.map((n) => [n, { commandedDeg: 90 }])) as Record<JointName, JointState>;

describe('RobotState', () => {
  it('keys joints by firmware name, all eight present', () => {
    const state: RobotState = {
      mode: 'simulated',
      joints: emptyJoints(),
      face: { expression: 'rest', frame: 0, width: 128, height: 64 },
      network: { state: 'simulated' },
      motion: {},
    };
    expect(Object.keys(state.joints).sort()).toEqual([...JOINT_ORDER].sort());
    expect(state.face.width).toBe(128);
    expect(state.face.height).toBe(64);
  });

  it('models a real robot with no joint feedback at all', () => {
    expect(HAS_JOINT_POSITION_FEEDBACK).toBe(false);

    const joint: JointState = { commandedDeg: 135, measuredDeg: null, subtrimDeg: 0 };
    expect(joint.measuredDeg).toBeNull();
    // `null` means "asked, and unknowable" — distinct from "not yet received".
    expect(joint.measuredDeg).not.toBe(joint.commandedDeg);

    const absent: JointState = { commandedDeg: 135 };
    expect('measuredDeg' in absent).toBe(false);
  });

  it('lets a simulator report a modelled angle without pretending it is measured', () => {
    const joint: JointState = { commandedDeg: 180, simulatedDeg: 142.5, measuredDeg: null };
    expect(joint.simulatedDeg).toBe(142.5);
    expect(joint.measuredDeg).toBeNull();
  });

  it('has no capability flag that could advertise joint feedback', () => {
    const caps: SesameCapabilities = {
      realHardware: true,
      firmwareExecution: true,
      oledFramebuffer: true,
      serialConsole: true,
      httpApi: true,
      physics: false,
    };
    expect(Object.keys(caps)).not.toContain('jointFeedback');
    expect(Object.keys(caps)).toHaveLength(6);
  });
});

describe('the node loader', () => {
  it('reads and validates the repository joint map', () => {
    const view = loadJointMap();
    expect(view.order).toEqual([...JOINT_ORDER]);
    expect(view.hasUnverifiedSemantics).toBe(true);
  });

  it('throws a useful error for a missing file', () => {
    expect(() => loadJointMap('does-not-exist.json')).toThrow(/cannot read hardware\/joint-map\.json/);
  });
});
