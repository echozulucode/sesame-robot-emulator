/**
 * Contract tests for the calibration layer and the shipped
 * `hardware/calibration.json`.
 *
 * Three things are being defended:
 *
 * 1. **Defaults are today's values.** Loading the shipped document must change
 *    no behaviour anywhere — the sim options it produces must equal the sim's
 *    own defaults, and `rigRotationDeg` must equal V2's baked pose rule.
 * 2. **The guess barrier holds.** A carried-forward value cannot become a fact
 *    by editing a number, and cannot become a measurement without naming a
 *    robot, an operator, an instrument and a date.
 * 3. **An override propagates.** The layer is only worth having if changing a
 *    number changes what a consumer does.
 */
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName } from '../joints.js';
import { JointMapView } from '../joint-map.js';
import {
  CALIBRATION_DEFAULTS,
  CALIBRATION_FIELD_COUNT,
  CALIBRATION_JOINT_FIELDS,
  CALIBRATION_ROBOT_FIELDS,
  CalibrationValidationError,
  CalibrationView,
  applyCalibrationOverride,
  calibratedValue,
  describeCalibratedValue,
  isMeasured,
  measuredValueOnly,
  parseCalibration,
  serializeCalibration,
  type Calibration,
  type CalibrationSession,
  type CalibratedValue,
  type MeasuredValue,
  type PartIdentityObservation,
} from '../calibration.js';
import { loadFixtureCalibration, loadFixtureJointMap } from './fixture.js';

const rawCal = loadFixtureCalibration();
const jointMap = JointMapView.parse(loadFixtureJointMap());
const view = CalibrationView.parse(rawCal, { jointMap });

const clone = (): Calibration => JSON.parse(JSON.stringify(rawCal)) as Calibration;

const SESSION: CalibrationSession = {
  robotSerial: 'sesame-001',
  performedBy: 'test',
  startedAt: '2026-09-01T09:00:00Z',
  location: 'bench',
  instruments: ['digital protractor'],
  firmwareProfile: 's2mini-instrumented',
  note: 'synthetic session for a unit test',
};

const measured = <T>(value: T, checklistStep = 'V6-20'): MeasuredValue<T> => ({
  value,
  measured: true,
  measuredAt: '2026-09-01T09:30:00Z',
  measuredBy: 'test',
  robotSerial: 'sesame-001',
  instrument: 'digital protractor',
  method: 'synthetic',
  checklistStep,
  closesIssues: ['ISSUE-20260823-007'],
});

// ---------------------------------------------------------------------------

describe('the shipped reference calibration', () => {
  it('covers eight joints in firmware order and nothing else', () => {
    expect(view.joints.map((j) => j.firmwareName)).toEqual([...JOINT_ORDER]);
    view.joints.forEach((j, i) => expect(j.firmwareIndex).toBe(i));
  });

  it('has 81 hardware-gated fields, none of them measured', () => {
    expect(CALIBRATION_FIELD_COUNT).toBe(
      JOINT_ORDER.length * CALIBRATION_JOINT_FIELDS.length + CALIBRATION_ROBOT_FIELDS.length,
    );
    const summary = view.summary();
    expect(summary.total).toBe(CALIBRATION_FIELD_COUNT);
    expect(summary.measured).toBe(0);
    expect(summary.carriedForward).toBe(CALIBRATION_FIELD_COUNT);
    expect(summary.status).toBe('uncalibrated');
    expect(view.isUncalibrated).toBe(true);
    expect(view.robotId).toBe('reference-uncalibrated');
  });

  it('names, for every outstanding field, the checklist step that would settle it', () => {
    const outstanding = view.outstanding();
    expect(outstanding).toHaveLength(CALIBRATION_FIELD_COUNT);
    for (const o of outstanding) {
      expect(o.checklistStep).toMatch(/^V6-\d{2}[a-z]?$/);
    }
  });

  it('layers over the joint map rather than forking it', () => {
    // Identity, geometry and the firmware clamp stay in the joint map.
    const keys = new Set(Object.keys(view.joints[0] as object));
    for (const forbidden of ['pinsByBoard', 'rotationAxis', 'pivotOrigin', 'cadPose', 'angleLimitsDeg', 'semanticName', 'stlSha256']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(view.data.meta.layersOver.path).toBe('hardware/joint-map.json');
    expect(view.data.meta.layersOver.jointMapVersion).toBe(jointMap.data.meta.jointMapVersion);
  });
});

describe('defaults are exactly today’s values', () => {
  it('reproduces the joint map’s sign and zero on every joint', () => {
    for (const joint of JOINT_ORDER) {
      const entry = jointMap.get(joint);
      expect(view.directionSignFor(joint)).toBe(entry.directionSign.value);
      expect(view.zeroReferenceDegFor(joint)).toBe(entry.zeroReferenceDeg.value);
      expect(view.subtrimDegFor(joint)).toBe(0);
    }
  });

  it('reproduces V0’s absolute rotation sense: -1 on hips, +1 on knees', () => {
    for (const joint of JOINT_ORDER) {
      const entry = jointMap.get(joint);
      const expected = entry.kind === 'femur' ? -1 : 1;
      expect(view.rotationSenseSignFor(joint)).toBe(expected);
      expect(entry.directionSign.absoluteSense?.rule).toContain(`${expected === -1 ? '-1' : '+1'} * (commandedDeg - 90)`);
    }
  });

  it('reproduces V2’s baked pose rule exactly: sign x (commandedDeg - 90)', () => {
    for (const joint of JOINT_ORDER) {
      const sign = view.rotationSenseSignFor(joint);
      for (const deg of [0, 45, 90, 135, 180]) {
        expect(view.rigRotationDeg(joint, deg)).toBeCloseTo(sign * (deg - 90), 12);
      }
    }
  });

  it('agrees with JointMapView.toBodyRelativeDeg on every joint and every shipped angle', () => {
    for (const joint of JOINT_ORDER) {
      for (const bucket of jointMap.observedRangeOf(joint).distinctCommandedDeg) {
        expect(view.toBodyRelativeDeg(joint, bucket.deg)).toBe(
          jointMap.toBodyRelativeDeg(joint, bucket.deg),
        );
      }
    }
  });

  it('produces the simulator’s own documented defaults', () => {
    expect(view.toSimOptions()).toEqual({
      subtrimDeg: [0, 0, 0, 0, 0, 0, 0, 0],
      powerOnDeg: CALIBRATION_DEFAULTS.powerOnCommandedDeg,
      slewDegPerSec: CALIBRATION_DEFAULTS.slewDegPerSec,
      spinQuantumMs: CALIBRATION_DEFAULTS.spinQuantumMs,
      loopQuantumMs: CALIBRATION_DEFAULTS.loopQuantumMs,
    });
  });

  it('carries V2’s inferred OLED plane, height included, unchanged', () => {
    expect(view.robotField('oledActivePlaneMm').value).toEqual({ widthMm: 23.6, heightMm: 11.8 });
    expect(view.robotField('oledActivePlaneMm').measured).toBe(false);
  });

  it('reproduces the firmware clamp order: subtrim before constrain', () => {
    // sesame-firmware-main.ino:1053 — constrain(angle + servoSubtrim[ch], 0, 180)
    expect(view.appliedCommandedDeg('R1', 175)).toBe(175);
    const trimmed = applyCalibrationOverride(
      clone(),
      { session: SESSION, joints: { R1: { servoSubtrimDeg: measured(10) } } },
      { jointMap },
    );
    const trimmedView = CalibrationView.parse(trimmed, { jointMap });
    // 175 + 10 = 185 -> saturates at 180. A trimmed channel loses range.
    expect(trimmedView.appliedCommandedDeg('R1', 175)).toBe(180);
  });

  it('exposes the 20-tooth horn quantum the ±9° caveat rests on', () => {
    expect(view.hornSplineQuantumDeg).toBe(18);
    expect(view.robotField('hornSplineTeeth').value).toBe(CALIBRATION_DEFAULTS.hornSplineTeeth);
  });
});

describe('the guess barrier', () => {
  it('refuses a carried-forward value that has drifted from the design', () => {
    const bad = clone();
    (bad.joints[0] as { zeroReferenceDeg: { value: number } }).zeroReferenceDeg.value = 87;
    expect(() => parseCalibration(bad, { jointMap })).toThrow(CalibrationValidationError);
    try {
      parseCalibration(bad, { jointMap });
    } catch (err) {
      expect((err as CalibrationValidationError).problems.join('\n')).toContain(
        'must equal the design value it layers over',
      );
    }
  });

  it('refuses a measured value with no robot serial', () => {
    const bad = clone();
    const field = { ...measured(87), robotSerial: '' };
    (bad.joints[0] as unknown as Record<string, unknown>)['zeroReferenceDeg'] = field;
    (bad as { session: CalibrationSession | null }).session = SESSION;
    expect(() => parseCalibration(bad, { jointMap })).toThrow(/must name `robotSerial`/);
  });

  it('refuses a measured value with no session', () => {
    const bad = clone();
    (bad.joints[0] as unknown as Record<string, unknown>)['zeroReferenceDeg'] = measured(87);
    expect(() => parseCalibration(bad, { jointMap })).toThrow(/requires `session`/);
  });

  it('refuses a carried-forward value that carries measurement attribution', () => {
    const bad = clone();
    (bad.joints[0] as unknown as Record<string, unknown>)['zeroReferenceDeg'] = {
      ...(bad.joints[0]!.zeroReferenceDeg as object),
      measuredBy: 'somebody',
    };
    expect(() => parseCalibration(bad, { jointMap })).toThrow(/must not carry `measuredBy`/);
  });

  it('refuses prose that claims an observation on an unmeasured value', () => {
    const bad = clone();
    (bad.joints[0] as unknown as Record<string, unknown>)['zeroReferenceDeg'] = {
      ...(bad.joints[0]!.zeroReferenceDeg as object),
      method: 'measured on the robot with a protractor',
    };
    expect(() => parseCalibration(bad, { jointMap })).toThrow(/claims an observation/);
  });

  it('does not mistake the honest phrasing "NOT MEASURED on any robot" for a claim', () => {
    // Every zeroReferenceDeg in the shipped document uses exactly that wording.
    const method = view.field('R1', 'zeroReferenceDeg').method;
    expect(method).toContain('NOT MEASURED on any robot');
    expect(() => parseCalibration(rawCal, { jointMap })).not.toThrow();
  });

  it('recomputes calibrationStatus rather than trusting it', () => {
    const bad = clone();
    (bad.meta as { calibrationStatus: string }).calibrationStatus = 'complete';
    expect(() => parseCalibration(bad, { jointMap })).toThrow(/calibrationStatus says "complete"/);
  });

  it('makes measurement attribution unreachable on a carried-forward value, at the type level', () => {
    const field = view.field('R1', 'zeroReferenceDeg');
    // @ts-expect-error — measuredAt does not exist on a carried-forward value.
    void field.measuredAt;
    if (isMeasured(field)) {
      // Only reachable after narrowing, and then it is a full attribution.
      expect(field.robotSerial.length).toBeGreaterThan(0);
    }
    expect(measuredValueOnly(field)).toBeUndefined();
    expect(calibratedValue(field)).toBe(90);
  });

  it('describes an unmeasured value without implying an observation', () => {
    const text = describeCalibratedValue(view.field('R1', 'zeroReferenceDeg'), 'R1 zero');
    expect(text).toContain('NOT MEASURED');
    expect(text).toContain('V6-20');
    expect(text).not.toContain('MEASURED 20');
  });
});

describe('semantic names', () => {
  it('stays a guess while partIdentity is unmeasured, with no bare string on the branch', () => {
    const status = view.semanticNameFor('R1', jointMap);
    expect(status.kind).toBe('guess');
    if (status.kind === 'guess') {
      expect(status.guess?.verified).toBe(false);
      // @ts-expect-error — the guess branch exposes no `value` string.
      void status.value;
    }
  });

  it('is promoted only by a measured partIdentity, never by editing the joint map', () => {
    const observation: PartIdentityObservation = { matchesFirmwareName: true, engravedName: 'R1' };
    const next = applyCalibrationOverride(
      clone(),
      { session: SESSION, joints: { R1: { partIdentity: measured(observation, 'V6-02') } } },
      { jointMap },
    );
    const status = CalibrationView.parse(next, { jointMap }).semanticNameFor('R1', jointMap);
    expect(status.kind).toBe('confirmed');
    if (status.kind === 'confirmed') {
      expect(status.value).toBe('right_front_hip');
      expect(status.confirmation.robotSerial).toBe('sesame-001');
    }
    // The joint map itself is untouched and still says verified:false.
    expect(jointMap.semanticGuessFor('R1')?.verified).toBe(false);
    expect(jointMap.hasUnverifiedSemantics).toBe(true);
  });

  it('reports a contradiction rather than silently keeping the guess', () => {
    const observation: PartIdentityObservation = { matchesFirmwareName: false, engravedName: 'L2' };
    const next = applyCalibrationOverride(
      clone(),
      { session: SESSION, joints: { R1: { partIdentity: measured(observation, 'V6-02') } } },
      { jointMap },
    );
    const status = CalibrationView.parse(next, { jointMap }).semanticNameFor('R1', jointMap);
    expect(status.kind).toBe('contradicted');
    if (status.kind === 'contradicted') expect(status.engravedName).toBe('L2');
  });
});

describe('overriding at run time', () => {
  it('changes only the field it names, and keeps the rest of the provenance', () => {
    const next = applyCalibrationOverride(
      clone(),
      { session: SESSION, joints: { R4: { servoSubtrimDeg: measured(-7) } } },
      { jointMap },
    );
    const v = CalibrationView.parse(next, { jointMap });
    expect(v.subtrimDegFor('R4')).toBe(-7);
    expect(v.subtrimDegFor('R3')).toBe(0);
    expect(v.summary().measured).toBe(1);
    expect(v.summary().status).toBe('partial');
    expect(v.robotId).toBe('sesame-001');
    // Everything else is byte-identical to the reference.
    expect(v.field('R3', 'servoSubtrimDeg')).toEqual(view.field('R3', 'servoSubtrimDeg'));
  });

  it('feeds the changed value straight into the sim options', () => {
    const next = applyCalibrationOverride(
      clone(),
      {
        session: SESSION,
        joints: { R4: { servoSubtrimDeg: measured(-7) } },
        robot: { slewDegPerSec: measured(410, 'V6-15') as CalibratedValue<number | null> },
      },
      { jointMap },
    );
    const opts = CalibrationView.parse(next, { jointMap }).toSimOptions();
    // R4 is firmware channel 4, not channel 7. Ordering is JOINT_ORDER, always.
    expect(opts.subtrimDeg).toEqual([0, 0, 0, 0, -7, 0, 0, 0]);
    expect(opts.slewDegPerSec).toBe(410);
  });

  it('rotates the rig by the calibrated amount', () => {
    const next = applyCalibrationOverride(
      clone(),
      {
        session: SESSION,
        joints: {
          R1: {
            zeroReferenceDeg: measured(93),
            hornSplineOffsetDeg: measured(-4.5),
            servoSubtrimDeg: measured(2),
          },
        },
      },
      { jointMap },
    );
    const v = CalibrationView.parse(next, { jointMap });
    // sense(-1) * gain(1) * ((135 + 2) - 93) + (-4.5) = -44 - 4.5 = -48.5
    expect(v.rigRotationDeg('R1', 135)).toBeCloseTo(-48.5, 12);
    // and the untouched joints still follow V2's rule
    expect(v.rigRotationDeg('L1', 135)).toBeCloseTo(-45, 12);
  });

  it('revalidates, so an override cannot smuggle in an invalid document', () => {
    expect(() =>
      applyCalibrationOverride(
        clone(),
        { session: SESSION, joints: { R1: { servoSubtrimDeg: measured(999) } } },
        { jointMap },
      ),
    ).toThrow(/outside the firmware's -90..90/);
  });

  it('round-trips through serializeCalibration', () => {
    const text = serializeCalibration(view.data, { jointMap });
    expect(text.endsWith('\n')).toBe(true);
    const reparsed = CalibrationView.parse(JSON.parse(text), { jointMap });
    expect(reparsed.summary()).toEqual(view.summary());
  });
});

describe('field vocabulary', () => {
  it('addresses every field on every joint', () => {
    for (const joint of JOINT_ORDER as readonly JointName[]) {
      for (const f of CALIBRATION_JOINT_FIELDS) {
        expect(view.field(joint, f)).toBeDefined();
        expect(view.field(joint, f).checklistStep).toMatch(/^V6-/);
      }
    }
    for (const f of CALIBRATION_ROBOT_FIELDS) {
      expect(view.robotField(f)).toBeDefined();
    }
  });
});
