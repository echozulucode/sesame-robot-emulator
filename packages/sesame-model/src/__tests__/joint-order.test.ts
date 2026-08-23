/**
 * Regression guard for the firmware servo order.
 *
 * `R1,R2,L1,L2,R4,R3,L3,L4` is the ServoName enum in
 * `firmware/movement-sequences.h:5`. It looks like a typo — `R4` before `R3`,
 * `L1` before `L2` but `L3` before `L4` — and it is not. It is the wiring
 * order, confirmed independently from source (F4) and from the motor-index
 * labels `00`–`07` on `docs/build-guide/assets/sesame-angle-guide.png` (F5).
 *
 * "Fixing" it to alphabetical silently rewires four of the eight servos: index
 * 4 would drive R3 instead of R4 and index 5 R4 instead of R3, and every
 * choreography step in the firmware would land on the wrong leg. These tests
 * exist so that mistake fails loudly in CI instead of quietly in plastic.
 */
import { describe, expect, it } from 'vitest';

import {
  JOINT_ORDER,
  isJointName,
  jointAtIndex,
  jointIndex,
  type JointName,
} from '../joints.js';

const EXPECTED = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'] as const;

describe('JOINT_ORDER', () => {
  it('is exactly the firmware ServoName enum order', () => {
    // Do not "fix" this. See the file header.
    expect(JOINT_ORDER).toEqual(['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']);
  });

  it('is not alphabetical, and is not grouped by side or by number', () => {
    const alphabetical = [...JOINT_ORDER].sort();
    expect(JOINT_ORDER).not.toEqual(alphabetical);
    expect(JOINT_ORDER).not.toEqual(['R1', 'R2', 'R3', 'R4', 'L1', 'L2', 'L3', 'L4']);
    expect(JOINT_ORDER).not.toEqual(['R1', 'L1', 'R2', 'L2', 'R3', 'L3', 'R4', 'L4']);
  });

  it('puts R4 before R3 at indices 4 and 5', () => {
    expect(JOINT_ORDER[4]).toBe('R4');
    expect(JOINT_ORDER[5]).toBe('R3');
  });

  it('has eight distinct entries', () => {
    expect(JOINT_ORDER).toHaveLength(8);
    expect(new Set(JOINT_ORDER).size).toBe(8);
  });

  it('agrees with jointIndex() in both directions', () => {
    EXPECTED.forEach((name, i) => {
      expect(jointIndex(name)).toBe(i);
      expect(jointAtIndex(i)).toBe(name);
    });
  });

  it('returns undefined for out-of-range channels', () => {
    expect(jointAtIndex(-1)).toBeUndefined();
    expect(jointAtIndex(8)).toBeUndefined();
  });

  it('is frozen at the type level to the JointName union', () => {
    // Compile-time: every JOINT_ORDER member is a JointName and vice versa.
    const roundTrip: readonly JointName[] = JOINT_ORDER;
    expect(roundTrip).toHaveLength(8);
  });
});

describe('isJointName', () => {
  it('accepts the eight firmware names and nothing else', () => {
    for (const n of EXPECTED) expect(isJointName(n)).toBe(true);
    for (const n of ['r1', 'R5', 'L0', 'right_front_hip', '', 0, null, undefined, {}]) {
      expect(isJointName(n)).toBe(false);
    }
  });
});
