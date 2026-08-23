/**
 * Contract tests for the shipped `hardware/joint-map.json`.
 *
 * These run against the real artefact, not a fixture, so that a regeneration
 * that breaks an invariant fails here as well as in `pnpm validate:joint-map`.
 */
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName } from '../joints.js';
import { JointMapValidationError, JointMapView, type BoardId } from '../joint-map.js';
import { loadFixtureJointMap } from './fixture.js';

const raw = loadFixtureJointMap();
const view = JointMapView.parse(raw);

describe('joint map structure', () => {
  it('has eight joints in firmware order', () => {
    expect(view.order).toEqual([...JOINT_ORDER]);
    view.joints.forEach((j, i) => {
      expect(j.firmwareIndex).toBe(i);
      expect(j.firmwareName).toBe(JOINT_ORDER[i]);
    });
  });

  it('classifies four femurs and four feet, authoritatively, from the STEP file', () => {
    const femurs = view.joints.filter((j) => j.kind === 'femur').map((j) => j.firmwareName);
    const feet = view.joints.filter((j) => j.kind === 'foot').map((j) => j.firmwareName);
    expect(femurs).toEqual(['R1', 'R2', 'L1', 'L2']);
    expect(feet).toEqual(['R4', 'R3', 'L3', 'L4']);
    for (const j of view.joints) {
      expect(j.kindStatus).toBe('authoritative');
      expect(j.kindSource.symbol).toContain(j.firmwareName);
    }
  });

  it('carries a GPIO for every board configuration', () => {
    const boards: readonly BoardId[] = ['s2-mini', 'distro-v3', 'distro-v2', 'distro-v1'];
    for (const j of view.joints) {
      for (const b of boards) expect(typeof view.pinFor(j.firmwareName, b)).toBe('number');
    }
    // Spot-check the active board against F4's extraction.
    expect(view.pinFor('R1', 's2-mini')).toBe(1);
    expect(view.pinFor('R4', 's2-mini')).toBe(8);
    expect(view.pinFor('L4', 's2-mini')).toBe(14);
    expect(view.pinFor('R1', 'distro-v1')).toBe(15);
  });

  it('gives every board a distinct pin, so no two servos share a GPIO', () => {
    const boards: readonly BoardId[] = ['s2-mini', 'distro-v3', 'distro-v2', 'distro-v1'];
    for (const b of boards) {
      const pins = view.joints.map((j) => view.pinFor(j.firmwareName, b));
      expect(new Set(pins).size).toBe(8);
    }
  });
});

describe('shape equivalence', () => {
  it('groups the eight joints into four identical-solid pairs', () => {
    expect(view.data.shapeEquivalenceClasses).toHaveLength(4);
    const members = view.data.shapeEquivalenceClasses.flatMap((c) => c.members);
    expect(new Set(members).size).toBe(8);
  });

  it('pairs diagonally, not left/right', () => {
    expect(view.shapeTwinsOf('R1')).toEqual(['L2']);
    expect(view.shapeTwinsOf('R2')).toEqual(['L1']);
    expect(view.shapeTwinsOf('R3')).toEqual(['L4']);
    expect(view.shapeTwinsOf('R4')).toEqual(['L3']);
  });
});

describe('kinematic structure', () => {
  it('hangs every femur off the chassis and every foot off one femur', () => {
    expect(view.parentOf('R1')).toBe('internal-frame');
    expect(view.parentOf('R3')).toBe('R1');
    expect(view.parentOf('R4')).toBe('R2');
    expect(view.parentOf('L3')).toBe('L1');
    expect(view.parentOf('L4')).toBe('L2');
    expect(view.childOf('R1')).toBe('R3');
    expect(view.childOf('R3')).toBeNull();
  });

  it('gives femurs a vertical axis and feet a horizontal one', () => {
    for (const j of view.joints) {
      const axis = j.rotationAxis.value;
      if (j.kind === 'femur') expect(axis).toEqual([0, 1, 0]);
      else expect(axis).toEqual([1, 0, 0]);
      expect(j.rotationAxis.status).toBe('inferred');
      expect(j.rotationAxis.axisConfidence).toBe('high');
    }
  });

  it('keeps the "not the joint centre" warning on every pivot origin', () => {
    for (const j of view.joints) {
      expect(j.pivotOrigin.caveat).toContain('NOT THE JOINT CENTRE');
      expect(j.pivotOrigin.originConfidence).toBe('medium');
    }
  });

  it('records the femur link offset only on femurs', () => {
    for (const j of view.joints) {
      if (j.kind === 'femur') {
        expect(j.linkGeometry?.axisAngleDeg).toBe(90);
        expect(j.linkGeometry?.commonNormalDistanceMm).toBeCloseTo(36.83, 3);
      } else {
        expect(j.linkGeometry).toBeUndefined();
      }
    }
  });
});

describe('angles', () => {
  it('uses the firmware clamp, authoritatively, and no mechanical limits', () => {
    for (const j of view.joints) {
      expect(j.angleLimitsDeg.value).toEqual({ min: 0, max: 180 });
      expect(j.angleLimitsDeg.status).toBe('authoritative');
      expect(j.angleLimitsDeg.mechanicalLimitsDeg).toBeNull();
    }
  });

  it('clamps exactly like setServoAngle(), subtrim included', () => {
    expect(view.clampCommandedDeg('R1', 90)).toBe(90);
    expect(view.clampCommandedDeg('R1', 200)).toBe(180);
    expect(view.clampCommandedDeg('R1', -20)).toBe(0);
    expect(view.clampCommandedDeg('R1', 175, 10)).toBe(180);
    expect(view.clampCommandedDeg('R1', 90, -5)).toBe(85);
  });

  it('marks the zero reference and direction sign as inferred, never measured', () => {
    for (const j of view.joints) {
      expect(j.zeroReferenceDeg.status).toBe('inferred');
      expect(j.zeroReferenceDeg.value).toBe(90);
      expect(j.zeroReferenceDeg.caveat).toContain('NOT MEASURED');
      expect(j.directionSign.status).toBe('inferred');
      expect([1, -1]).toContain(j.directionSign.value);
    }
  });

  it('gives shape twins the same sign and mirror classes opposite signs', () => {
    const sign = (n: JointName): number => view.get(n).directionSign.value;
    expect(sign('R1')).toBe(sign('L2'));
    expect(sign('R2')).toBe(sign('L1'));
    expect(sign('R1')).toBe(-sign('R2'));
    expect(sign('R3')).toBe(sign('L4'));
    expect(sign('R4')).toBe(sign('L3'));
    expect(sign('R3')).toBe(-sign('R4'));
  });

  it('makes runRestPose all-zero in the body-relative convention', () => {
    for (const j of view.joints) {
      expect(j.zeroReferenceDeg.restPoseDeg).toBe(90);
      expect(view.toBodyRelativeDeg(j.firmwareName, j.zeroReferenceDeg.restPoseDeg)).toBe(0);
    }
  });

  it('makes runStandPose read +45 on every hip and +90 on every foot', () => {
    for (const j of view.joints) {
      const bodyRel = view.toBodyRelativeDeg(j.firmwareName, j.zeroReferenceDeg.standPoseDeg);
      expect(bodyRel).toBe(j.kind === 'femur' ? 45 : 90);
    }
  });

  it('round-trips body-relative and commanded angles', () => {
    for (const j of view.joints) {
      for (const deg of [0, 45, 90, 135, 180]) {
        expect(view.toCommandedDeg(j.firmwareName, view.toBodyRelativeDeg(j.firmwareName, deg)))
          .toBe(deg);
      }
    }
  });
});

describe('observed choreography range', () => {
  it('analyses the whole corpus: 21 functions, 395 steps, 223 servo steps', () => {
    expect(view.data.choreographyAnalysis.corpus).toMatchObject({
      functions: 21,
      totalSteps: 395,
      servoSteps: 223,
    });
    const summed = view.joints.reduce((n, j) => n + j.observedRangeDeg.sampleCount, 0);
    expect(summed).toBe(223);
  });

  it('keeps every observed angle inside the firmware clamp', () => {
    for (const j of view.joints) {
      const o = view.observedRangeOf(j.firmwareName);
      expect(o.status).toBe('inferred');
      expect(o.minDeg).toBeGreaterThanOrEqual(j.angleLimitsDeg.value.min);
      expect(o.maxDeg).toBeLessThanOrEqual(j.angleLimitsDeg.value.max);
      const total = o.distinctCommandedDeg.reduce((n, b) => n + b.count, 0);
      expect(total).toBe(o.sampleCount);
    }
  });

  it('shows hips using only half the clamp and feet using all of it', () => {
    for (const j of view.joints) {
      const o = view.observedRangeOf(j.firmwareName);
      if (j.kind === 'foot') {
        expect(o.minDeg).toBe(0);
        expect(o.maxDeg).toBe(180);
        expect(o.bodyRelativeMinDeg).toBe(-90);
        expect(o.bodyRelativeMaxDeg).toBe(90);
      } else {
        expect(o.maxDeg - o.minDeg).toBeLessThanOrEqual(100);
        expect(o.bodyRelativeMaxDeg).toBe(90);
        expect(o.bodyRelativeMinDeg).toBeGreaterThanOrEqual(-10);
      }
    }
  });
});

describe('unresolved items', () => {
  it('carries forward all six of F5\'s open items', () => {
    const fromF5 = view.unresolved.filter((u) => u.carriedForwardFrom === 'F5');
    expect(fromF5).toHaveLength(6);
    expect(fromF5.map((u) => u.id)).toEqual([
      'servo-datum-plane',
      'per-instance-assembly-poses',
      'stl-to-cad-frame-mapping',
      'joint-zero-sign-and-limits',
      'front-rear-orientation',
      'hip-to-foot-instance-naming',
    ]);
  });

  it('adds F6\'s own open items and blocks nothing', () => {
    const fromF6 = view.unresolved.filter((u) => u.carriedForwardFrom === 'F6');
    expect(fromF6.length).toBeGreaterThan(0);
    for (const u of view.unresolved) expect(u.blocking).toBe(false);
  });

  it('leaves every joint with at least the pivot-origin caveat open', () => {
    for (const j of view.joints) expect(j.unresolved.length).toBeGreaterThan(0);
  });
});

describe('the validator rejects broken data', () => {
  const clone = (): { joints: Record<string, unknown>[] } =>
    structuredClone(raw) as { joints: Record<string, unknown>[] };

  it('rejects an alphabetised joints array', () => {
    const broken = clone();
    broken.joints.sort((a, b) => String(a['firmwareName']).localeCompare(String(b['firmwareName'])));
    expect(() => JointMapView.parse(broken)).toThrow(JointMapValidationError);
    expect(() => JointMapView.parse(broken)).toThrow(/firmware order requires/);
  });

  it('rejects a mismatched firmware index', () => {
    const broken = clone();
    const first = broken.joints[0];
    if (first === undefined) throw new Error('fixture has no joints');
    first['firmwareIndex'] = 7;
    expect(() => JointMapView.parse(broken)).toThrow(/array position and firmware index must agree/);
  });

  it('rejects a zero reference outside the clamp', () => {
    const broken = clone();
    const first = broken.joints[0];
    if (first === undefined) throw new Error('fixture has no joints');
    first['zeroReferenceDeg'] = { ...(first['zeroReferenceDeg'] as object), value: 240 };
    expect(() => JointMapView.parse(broken)).toThrow(/lies outside the firmware clamp/);
  });

  it('rejects invented mechanical limits', () => {
    const broken = clone();
    const first = broken.joints[0];
    if (first === undefined) throw new Error('fixture has no joints');
    first['angleLimitsDeg'] = {
      ...(first['angleLimitsDeg'] as object),
      mechanicalLimitsDeg: { min: 20, max: 160 },
    };
    expect(() => JointMapView.parse(broken)).toThrow(/mechanicalLimitsDeg must be null/);
  });

  it('rejects a broken femur/foot pairing', () => {
    const broken = clone();
    const foot = broken.joints.find((j) => j['firmwareName'] === 'R3');
    if (foot === undefined) throw new Error('fixture has no R3');
    foot['parentLink'] = { ...(foot['parentLink'] as object), value: 'L1' };
    expect(() => JointMapView.parse(broken)).toThrow(/does not name it back as its childLink/);
  });

  it('rejects a pivot origin that has lost its caveat', () => {
    const broken = clone();
    const first = broken.joints[0];
    if (first === undefined) throw new Error('fixture has no joints');
    first['pivotOrigin'] = { ...(first['pivotOrigin'] as object), caveat: 'looks fine to me' };
    expect(() => JointMapView.parse(broken)).toThrow(/NOT THE JOINT CENTRE/);
  });
});
