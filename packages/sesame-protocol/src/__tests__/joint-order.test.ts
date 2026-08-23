/**
 * The joint vocabulary is `sesame-model`'s, not this package's.
 *
 * `packages/sesame-model` exists so that `R1,R2,L1,L2,R4,R3,L3,L4` has exactly
 * one definition in the repository. A protocol package that copy-pasted the list
 * would silently diverge the day someone "fixed" one copy to alphabetical order,
 * and four servos would move to the wrong angles with every test still green.
 * These assertions import the list rather than restating it.
 */
import { JOINT_ORDER, jointIndex, type JointName } from '@sesame-lab/sesame-model';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_JOINT_NAMES, parseTelemetryLine, serialize } from '../wire.js';
import type { ProtocolUnknownEvent, ServoTargetEvent } from '../events.js';

describe('accepted joint names', () => {
  it('are exactly JOINT_ORDER, in JOINT_ORDER order', () => {
    expect(ACCEPTED_JOINT_NAMES).toEqual(JOINT_ORDER);
    expect([...ACCEPTED_JOINT_NAMES]).not.toEqual([...JOINT_ORDER].sort());
  });

  it('parse successfully, one per firmware servo channel', () => {
    JOINT_ORDER.forEach((joint, channel) => {
      const events = parseTelemetryLine(`@SESAME servo ${joint} 90`);
      const event = events[0] as ServoTargetEvent;
      expect(event.type).toBe('servo.target');
      expect(event.joint).toBe(joint);
      expect(jointIndex(event.joint)).toBe(channel);
    });
  });

  it('round-trip through the wire without renaming', () => {
    for (const joint of JOINT_ORDER) {
      const line = serialize({
        type: 'servo.target',
        seq: 0,
        provenance: 'observed',
        joint,
        angleDeg: 90,
      });
      expect(line).toBe(`@SESAME servo ${joint} 90`);
    }
  });

  it('are the ONLY names the parser accepts', () => {
    const accepted = new Set<string>(JOINT_ORDER);
    const candidates: string[] = [];
    for (const side of ['R', 'L', 'r', 'l']) {
      for (let n = 0; n <= 9; n++) candidates.push(`${side}${n}`);
    }
    candidates.push(
      'R10', 'L10', 'FL', 'FR', 'BL', 'BR', '0', '7', 'servo0',
      'right_front_hip', 'left_rear_knee', 'R1 ', ' R1', 'R_1', 'R-1',
    );

    for (const candidate of candidates) {
      const event = parseTelemetryLine(`@SESAME servo ${candidate.trim()} 90`)[0];
      if (accepted.has(candidate.trim()) && candidate === candidate.trim()) {
        expect(event?.type, `${candidate} should parse`).toBe('servo.target');
      } else if (!accepted.has(candidate.trim())) {
        expect(event?.type, `${candidate} should not parse`).toBe('protocol.unknown');
        expect((event as ProtocolUnknownEvent).reason).toBe('unknown-joint');
      }
    }
  });

  it('has the non-geometric order the firmware really uses', () => {
    // R4 before R3 is not a typo; it is the wiring order in
    // firmware/movement-sequences.h. Guarding it here as well as in
    // sesame-model means a "fix" has to defeat two packages.
    const order: readonly JointName[] = JOINT_ORDER;
    expect(order.indexOf('R4')).toBeLessThan(order.indexOf('R3'));
    expect(order.indexOf('L3')).toBeLessThan(order.indexOf('L4'));
  });
});
