/**
 * Cooperative scheduling.
 *
 * `delayWithFace()` is the firmware's re-entrancy point, and getting it wrong
 * is the easiest way to build a simulator whose joint angles are perfect and
 * whose behaviour is subtly unlike the robot's. Every `setServoAngle()` ends in
 * one, so during those 20 ms the robot is still animating its face, still
 * answering HTTP and still serving captive-portal DNS.
 */
import { describe, expect, it } from 'vitest';

import { DELAY_WITH_FACE_QUANTUM_MS } from '../config.js';
import { driveRealtime } from '../realtime.js';
import { FirmwareMachine } from '../machine.js';
import { SimulatedSesameRobot } from '../robot.js';
import { VirtualClock } from '../clock.js';
import { resolveOptions } from '../config.js';
import { makeRig } from './helpers.js';

describe('delayWithFace is not dead time', () => {
  it('pumps every 5 ms — four times per default servo delay', async () => {
    const rig = await makeRig();
    await rig.robot.setJoint('R1', 90);
    const state = await rig.robot.getState();
    // One 20 ms delayWithFace = 20 / 5 = 4 pumps.
    expect(state.simulated.pumps).toBe(20 / DELAY_WITH_FACE_QUANTUM_MS);
  });

  it('services an HTTP-shaped hook from inside a servo delay', async () => {
    const rig = await makeRig();
    const seen: number[] = [];
    rig.robot.onPump(() => seen.push(rig.robot.nowMs));
    await rig.robot.setJoint('R1', 90);
    expect(seen).toEqual([0, 5, 10, 15]);
  });

  it('lets face animation advance during a servo delay', async () => {
    // `point`: 3 frames at 5 fps, so a 200 ms frame interval — long enough that
    // a blocking model would show nothing at all inside a servo write.
    const rig = await makeRig({ motorCurrentDelayMs: 500 });
    rig.clear();
    await rig.robot.setFaceWithMode('point', 'boomerang');
    const drawnBySetFace = rig.ofType('face.expression').length;
    expect(drawnBySetFace).toBe(1); // frame 0

    // One servo write. Everything after the first face event happened *inside*
    // delayWithFace(), between the write and the next statement.
    await rig.robot.setJoint('R1', 90);
    const frames = rig.ofType('face.expression').map((e) => e.frame);
    expect(frames.length).toBeGreaterThan(drawnBySetFace);
    expect(frames).toEqual([0, 1, 2, 1]);

    // And the servo event is the second one, so the frames really are interleaved
    // after it rather than before.
    expect(rig.events[1]?.type).toBe('servo.target');
  });

  it('interleaves face frames between servo writes in a real pose', async () => {
    const rig = await makeRig();
    rig.clear();
    // runPointPose selects `point` (3 frames, 5 fps, boomerang), writes eight
    // servos and then holds for 2 s.
    await rig.robot.runMovement('runPointPose');
    const types = rig.events.map((e) => e.type);
    const firstServo = types.indexOf('servo.target');
    const lastServo = types.lastIndexOf('servo.target');
    const faceBetween = rig.events
      .slice(firstServo, lastServo)
      .filter((e) => e.type === 'face.expression');
    // Face frames really do land between servo writes; a blocking delay would
    // have produced none.
    expect(faceBetween.length).toBeGreaterThan(0);
  });

  it('freezes idle blinking during a movement, because loop() is not running', async () => {
    const rig = await makeRig();
    await rig.robot.runMovement('runStandPose', { face: 1 });
    rig.clear();
    await rig.robot.runMovement('runBowPose'); // >4 s of choreography
    const names = rig.ofType('face.expression').map((e) => e.name);
    expect(names).not.toContain('idle_blink');
  });
});

describe('pressingCheck is where an interrupt lands', () => {
  it('a stop mid-gait bails out and stands up', async () => {
    const rig = await makeRig({ walkCycles: 10 });
    rig.clear();

    // The robot's own HTTP handler runs from inside a pump, so model the stop
    // the same way: fire it from a pump hook part-way through the gait.
    let pumps = 0;
    const off = rig.robot.onPump(() => {
      pumps += 1;
      if (pumps === 40) rig.robot.stop();
    });
    await rig.robot.command('forward');
    off();

    const uninterrupted = await makeRig({ walkCycles: 10 });
    uninterrupted.clear();
    await uninterrupted.robot.command('forward');

    expect(rig.servoWrites().length).toBeLessThan(uninterrupted.servoWrites().length);
    // pressingCheck() runs runStandPose(1) on its way out, so the last eight
    // writes are a stand pose either way.
    expect(rig.servoWrites().slice(-8).map((w) => w.joint)).toEqual([
      'R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4',
    ]);
    expect(rig.robot.snapshot().currentCommand).toBe('');
  });

  it('a gait that is never interrupted runs its full walkCycles', async () => {
    const rig = await makeRig({ walkCycles: 3 });
    rig.clear();
    await rig.robot.command('left');
    // 8 writes per cycle in runTurnLeft, plus the closing stand pose.
    expect(rig.servoWrites()).toHaveLength(3 * 16 + 8);
  });
});

describe('virtual time and its real-time wrapper', () => {
  it('executes seconds of choreography in no wall-clock time at all', async () => {
    const rig = await makeRig();
    const wallBefore = Date.now();
    await rig.robot.command('wave');
    expect(rig.robot.nowMs).toBeGreaterThan(3000);
    expect(Date.now() - wallBefore).toBeLessThan(2000);
  });

  it('real-time playback is the same generator with a pacer around it', async () => {
    const machine = new FirmwareMachine(new VirtualClock(0), resolveOptions(), () => {
      /* discarded */
    });
    const slept: number[] = [];
    let wall = 0;
    await driveRealtime(machine.runMovement('runRestPose', null, 0), {
      wallNowMs: () => wall,
      sleep: (ms) => {
        slept.push(ms);
        wall += ms;
        return Promise.resolve();
      },
      minSleepMs: 1,
    });
    // 8 servo writes x 20 ms = 160 ms of virtual time, paced in 5 ms pumps.
    expect(slept.reduce((a, b) => a + b, 0)).toBeCloseTo(155, 6);
    expect(machine.clock.nowMs()).toBe(160);
  });

  it('honours a speed multiplier', async () => {
    const machine = new FirmwareMachine(new VirtualClock(0), resolveOptions(), () => {
      /* discarded */
    });
    let wall = 0;
    const slept: number[] = [];
    await driveRealtime(machine.runMovement('runRestPose', null, 0), {
      speed: 5,
      wallNowMs: () => wall,
      sleep: (ms) => {
        slept.push(ms);
        wall += ms;
        return Promise.resolve();
      },
      minSleepMs: 0.1,
    });
    expect(slept.reduce((a, b) => a + b, 0)).toBeCloseTo(31, 6);
  });

  it('accepts an explicit start time on the clock', async () => {
    const robot = new SimulatedSesameRobot({ startTimeMs: 3000 });
    await robot.connect();
    expect(robot.nowMs).toBe(3000);
    await robot.runMovement('runRestPose');
    expect(robot.nowMs).toBe(3160);
  });
});
