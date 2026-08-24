/**
 * The V6 calibration layer, end to end into this simulator's output.
 *
 * The whole point of `hardware/calibration.json` is that a hardware-gated value
 * is *runtime-swappable data*, not something baked into three packages. This
 * file is the proof: it loads the real document, spreads
 * `CalibrationView.toSimOptions()` into a `SimulatedSesameRobot`, and asserts
 * two things that must both hold.
 *
 * 1. **The shipped, uncalibrated document changes nothing.** Defaults are
 *    today's values, so a robot built from the reference calibration emits a
 *    byte-identical event stream to one built with no options at all.
 * 2. **An override really does propagate.** Change one field and the emitted
 *    `servo.target` angles change accordingly — through the calibration layer,
 *    with no edit to this package.
 *
 * **No source file in `@sesame-lab/sesame-sim` was modified for this.** The
 * layer feeds the existing `SimulatedRobotOptions`, which is why it needed no
 * new seam.
 */
import { describe, expect, it } from 'vitest';

import {
  CalibrationView,
  applyCalibrationOverride,
  type Calibration,
  type CalibrationSession,
  type MeasuredValue,
} from '@sesame-lab/sesame-model';
import { loadCalibration, loadJointMap } from '@sesame-lab/sesame-model/node';

import { DEFAULT_SLEW_DEG_PER_SEC, resolveOptions } from '../config.js';
import { makeRig } from './helpers.js';

const jointMap = loadJointMap();
const reference = loadCalibration({ useEnv: false, jointMap });

const SESSION: CalibrationSession = {
  robotSerial: 'sesame-propagation-test',
  performedBy: 'calibration-propagation.test.ts',
  startedAt: '2026-09-01T09:00:00Z',
  location: 'unit test',
  instruments: ['none — synthetic'],
  firmwareProfile: 's2mini-instrumented',
  note: 'A synthetic calibration used only to prove that an override reaches sesame-sim.',
};

const measured = <T>(value: T, checklistStep: string): MeasuredValue<T> => ({
  value,
  measured: true,
  measuredAt: '2026-09-01T09:30:00Z',
  measuredBy: 'calibration-propagation.test.ts',
  robotSerial: SESSION.robotSerial,
  instrument: 'none — synthetic',
  method: 'synthetic value, asserted only for propagation',
  checklistStep,
  closesIssues: [],
});

const clone = (): Calibration => JSON.parse(JSON.stringify(reference.data)) as Calibration;

describe('the reference calibration is a no-op', () => {
  it('produces exactly the simulator’s own defaults', () => {
    const opts = reference.toSimOptions();
    const resolved = resolveOptions();
    expect(opts.subtrimDeg).toEqual([...resolved.subtrimDeg]);
    expect(opts.powerOnDeg).toBe(resolved.powerOnDeg);
    expect(opts.slewDegPerSec).toBe(resolved.slewDegPerSec);
    expect(opts.slewDegPerSec).toBe(DEFAULT_SLEW_DEG_PER_SEC);
    expect(opts.spinQuantumMs).toBe(resolved.spinQuantumMs);
    expect(opts.loopQuantumMs).toBe(resolved.loopQuantumMs);
  });

  it('emits a byte-identical event stream to an uncalibrated robot', async () => {
    const plain = await makeRig();
    await plain.robot.command('wave');

    const calibrated = await makeRig(reference.toSimOptions());
    await calibrated.robot.command('wave');

    expect(JSON.stringify(calibrated.events)).toBe(JSON.stringify(plain.events));
  });

  it('reports nothing as measured, because nothing has been', () => {
    expect(reference.isUncalibrated).toBe(true);
    expect(reference.summary().measured).toBe(0);
    expect(reference.outstanding()).toHaveLength(reference.summary().total);
  });
});

describe('an override propagates into sesame-sim’s output', () => {
  it('shifts the emitted servo angle by the calibrated subtrim, on the right channel', async () => {
    const view = CalibrationView.parse(
      applyCalibrationOverride(
        clone(),
        {
          session: SESSION,
          // R4 is firmware channel 4, not channel 7 — JOINT_ORDER is the wiring
          // order and a calibration keyed on the wrong index trims the wrong motor.
          joints: { R4: { servoSubtrimDeg: measured(-7, 'V6-20') } },
        },
        { jointMap },
      ),
      { jointMap },
    );
    expect(view.toSimOptions().subtrimDeg).toEqual([0, 0, 0, 0, -7, 0, 0, 0]);

    const rig = await makeRig(view.toSimOptions());
    rig.clear();
    await rig.robot.setJoint('R4', 90);
    await rig.robot.setJoint('R3', 90);

    expect(rig.servoWrites()).toEqual([
      { joint: 'R4', angleDeg: 83 },
      { joint: 'R3', angleDeg: 90 },
    ]);

    const state = await rig.robot.getState();
    expect(state.joints.R4.subtrimDeg).toBe(-7);
    expect(state.joints.R3.subtrimDeg).toBe(0);
    // Still no position feedback, calibrated or not.
    expect(state.joints.R4.measuredDeg).toBeNull();
  });

  it('reproduces the firmware’s subtrim-before-clamp order through the layer', async () => {
    const view = CalibrationView.parse(
      applyCalibrationOverride(
        clone(),
        { session: SESSION, joints: { R1: { servoSubtrimDeg: measured(40, 'V6-20') } } },
        { jointMap },
      ),
      { jointMap },
    );
    const rig = await makeRig(view.toSimOptions());
    rig.clear();
    // 170 is a legal request untrimmed; 170 + 40 saturates at the clamp.
    await rig.robot.setJoint('R1', 170);
    expect(rig.servoWrites()).toEqual([{ joint: 'R1', angleDeg: 180 }]);
    // …and the calibration layer's own preview agrees with what the sim emitted.
    expect(view.appliedCommandedDeg('R1', 170)).toBe(180);
  });

  it('changes the whole choreography, not just a single setJoint', async () => {
    const view = CalibrationView.parse(
      applyCalibrationOverride(
        clone(),
        { session: SESSION, joints: { L3: { servoSubtrimDeg: measured(5, 'V6-20') } } },
        { jointMap },
      ),
      { jointMap },
    );
    const plain = await makeRig();
    await plain.robot.command('wave');
    const trimmed = await makeRig(view.toSimOptions());
    await trimmed.robot.command('wave');

    const plainL3 = plain.servoWrites().filter((w) => w.joint === 'L3');
    const trimmedL3 = trimmed.servoWrites().filter((w) => w.joint === 'L3');
    expect(trimmedL3).toHaveLength(plainL3.length);
    expect(trimmedL3.length).toBeGreaterThan(0);
    trimmedL3.forEach((w, i) => {
      expect(w.angleDeg).toBe(Math.min(180, (plainL3[i]?.angleDeg ?? 0) + 5));
    });
    // Every other joint is untouched.
    expect(trimmed.servoWrites().filter((w) => w.joint !== 'L3')).toEqual(
      plain.servoWrites().filter((w) => w.joint !== 'L3'),
    );
  });

  it('propagates a measured slew rate into the simulated angle model', async () => {
    const view = CalibrationView.parse(
      applyCalibrationOverride(
        clone(),
        { session: SESSION, robot: { slewDegPerSec: measured(150, 'V6-25') } },
        { jointMap },
      ),
      { jointMap },
    );
    expect(view.toSimOptions().slewDegPerSec).toBe(150);
    const rig = await makeRig(view.toSimOptions());
    const state = await rig.robot.getState();
    expect(state.simulated.slewDegPerSec).toBe(150);
  });
});
