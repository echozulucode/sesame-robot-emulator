/**
 * The `SesameRobot` contract, and the honesty rules that sit on top of it.
 */
import { describe, expect, it } from 'vitest';

import { JOINT_ORDER } from '@sesame-lab/sesame-model';

import { SimulatedSesameRobot } from '../robot.js';
import type { SesameRobot } from '../robot-contract.js';
import { makeRig } from './helpers.js';

describe('SesameRobot contract', () => {
  it('SimulatedSesameRobot is assignable to it', () => {
    const robot: SesameRobot = new SimulatedSesameRobot();
    expect(typeof robot.connect).toBe('function');
    expect(typeof robot.disconnect).toBe('function');
    expect(typeof robot.capabilities).toBe('function');
    expect(typeof robot.command).toBe('function');
    expect(typeof robot.setFace).toBe('function');
    expect(typeof robot.setJoint).toBe('function');
    expect(typeof robot.setPose).toBe('function');
    expect(typeof robot.getState).toBe('function');
    expect(typeof robot.subscribe).toBe('function');
  });

  it('reports capabilities honestly — almost all false', async () => {
    const rig = await makeRig();
    expect(await rig.robot.capabilities()).toEqual({
      realHardware: false,
      firmwareExecution: false,
      oledFramebuffer: false,
      serialConsole: false,
      httpApi: false,
      physics: false,
    });
  });

  it('reports mode "simulated" and a network state it can defend', async () => {
    const rig = await makeRig();
    const state = await rig.robot.getState();
    expect(state.mode).toBe('simulated');
    expect(state.network.state).toBe('unavailable');
    expect(state.face.width).toBe(128);
    expect(state.face.height).toBe(64);
    expect(Object.keys(state.joints)).toEqual([...JOINT_ORDER]);
  });

  it('subscribe returns a working unsubscribe', async () => {
    const robot = new SimulatedSesameRobot();
    const seen: number[] = [];
    const off = robot.subscribe((e) => seen.push(e.seq));
    await robot.connect();
    const afterConnect = seen.length;
    expect(afterConnect).toBeGreaterThan(0);
    off();
    await robot.runMovement('runRestPose');
    expect(seen).toHaveLength(afterConnect);
  });

  it('serialises overlapping calls, because the firmware has one thread', async () => {
    const rig = await makeRig();
    rig.clear();
    await Promise.all([
      rig.robot.runMovement('runRestPose'),
      rig.robot.runMovement('runStandPose', { face: 0 }),
    ]);
    const writes = rig.servoWrites();
    expect(writes).toHaveLength(16);
    // Rest finishes entirely before stand begins: no interleaving.
    expect(writes.slice(0, 8).every((w) => w.angleDeg === 90)).toBe(true);
  });

  it('exposes the provenance of the choreography it is running', async () => {
    const rig = await makeRig();
    expect(rig.robot.choreographyMeta).toMatchObject({
      sourceFile: 'hardware/hardware-map.json',
      movementCount: 21,
      stepCount: 395,
    });
    expect(rig.robot.choreographyMeta.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('tracks motion state through a command', async () => {
    const rig = await makeRig();
    await rig.robot.command('bow');
    const state = await rig.robot.getState();
    // A pose clears itself, so nothing is pending afterwards.
    expect(state.motion.command).toBe('');
    expect(state.motion.sequenceStep).toBeGreaterThan(0);
  });

  it('leaves a continuous command set, and stop clears it', async () => {
    const rig = await makeRig({ walkCycles: 1 });
    await rig.robot.command('forward');
    expect(rig.robot.snapshot().currentCommand).toBe('forward');
    await rig.robot.command('stop');
    expect(rig.robot.snapshot().currentCommand).toBe('');
  });

  it('every emitted event is a valid protocol event with simulated provenance', async () => {
    const rig = await makeRig();
    await rig.robot.command('cute');
    expect(rig.events.length).toBeGreaterThan(30);
    for (const event of rig.events) {
      expect(event.provenance).toBe('simulated');
      expect(['servo.target', 'face.expression', 'log', 'protocol.hello']).toContain(event.type);
      if (event.type === 'servo.target') {
        expect(JOINT_ORDER).toContain(event.joint);
        expect(event.angleDeg).toBeGreaterThanOrEqual(0);
        expect(event.angleDeg).toBeLessThanOrEqual(180);
        expect(Number.isInteger(event.angleDeg)).toBe(true);
      }
    }
  });

  it('never emits oled.frame — V1 models expressions, V4 renders pixels', async () => {
    const rig = await makeRig();
    await rig.robot.command('dance');
    expect(rig.ofType('oled.frame')).toEqual([]);
  });
});
