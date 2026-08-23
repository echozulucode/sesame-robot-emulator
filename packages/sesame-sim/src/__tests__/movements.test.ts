/**
 * All 21 movement functions execute, and the servo stream they produce matches
 * the extracted choreography exactly.
 *
 * This is the core fidelity test. The expected `(joint, angle)` sequence is
 * expanded straight from `hardware/hardware-map.json` by `expandServoWrites()`,
 * which shares no code with the interpreter — if `machine.ts` mis-expands a
 * loop, mis-binds a default argument or skips a nested call, the two disagree.
 */
import { describe, expect, it } from 'vitest';

import { MOVEMENT_NAMES } from '../choreography.js';
import { expandServoWrites, makeRig, readHardwareMap } from './helpers.js';

const hardwareMap = readHardwareMap();

describe('every extracted movement function', () => {
  it.each(MOVEMENT_NAMES)('%s executes and matches the choreography', async (name) => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement(name);

    const expected = expandServoWrites(hardwareMap.movements, name);
    expect(rig.servoWrites()).toEqual(expected);
  });

  it('covers all 21 functions with nothing skipped', () => {
    expect(MOVEMENT_NAMES).toHaveLength(21);
    expect(new Set(MOVEMENT_NAMES).size).toBe(21);
  });

  it('emits at least one servo write for every function that has one', async () => {
    // enterIdle and exitIdle deliberately move nothing. Everything else must.
    const silent = new Set(['enterIdle', 'exitIdle']);
    for (const name of MOVEMENT_NAMES) {
      const rig = await makeRig();
      rig.clear();
      await rig.robot.runMovement(name);
      const count = rig.servoWrites().length;
      if (silent.has(name)) expect(count).toBe(0);
      else expect(count).toBeGreaterThan(0);
    }
  });

  it('tags every event simulated, with a monotonic seq and a trace id', async () => {
    const rig = await makeRig();
    await rig.robot.runMovement('runWavePose');
    expect(rig.events.length).toBeGreaterThan(10);
    let previous = -1;
    for (const event of rig.events) {
      expect(event.provenance).toBe('simulated');
      expect(event.seq).toBeGreaterThan(previous);
      previous = event.seq;
      expect(event.traceId).toBeTypeOf('string');
      expect(event.simTimeUs).toBeTypeOf('number');
    }
  });

  it('threads one trace id through a whole command', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.command('wave', { traceId: 'lesson-42' });
    const traces = new Set(rig.events.map((e) => e.traceId));
    expect([...traces]).toEqual(['lesson-42']);
    // The trace really does span the whole architecture of one command: a log,
    // a face and dozens of servo writes.
    expect(rig.ofType('log').length).toBeGreaterThan(0);
    expect(rig.ofType('servo.target').length).toBeGreaterThan(20);
  });

  it('honours walkCycles when expanding the gait loops', async () => {
    const rig = await makeRig({ walkCycles: 2 });
    rig.clear();
    await rig.robot.runMovement('runTurnLeft');
    const expected = expandServoWrites(hardwareMap.movements, 'runTurnLeft', {}, { walkCycles: 2 });
    expect(rig.servoWrites()).toEqual(expected);
    // And the default really is 10, so the knob is doing something.
    const ten = expandServoWrites(hardwareMap.movements, 'runTurnLeft', {}, { walkCycles: 10 });
    expect(ten.length).toBeGreaterThan(expected.length);
  });

  it('binds C++ default arguments: runStandPose(0) skips the face and idle entry', async () => {
    const withFace = await makeRig();
    withFace.clear();
    await withFace.robot.runMovement('runStandPose', { face: 1 });

    const withoutFace = await makeRig();
    withoutFace.clear();
    await withoutFace.robot.runMovement('runStandPose', { face: 0 });

    // Same eight servo writes either way...
    expect(withoutFace.servoWrites()).toEqual(withFace.servoWrites());
    // ...but only face == 1 enters idle, which is the ONLY entry point there is.
    expect(withFace.robot.snapshot().idleActive).toBe(true);
    expect(withoutFace.robot.snapshot().idleActive).toBe(false);
  });
});
