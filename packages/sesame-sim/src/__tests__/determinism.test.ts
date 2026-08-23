/**
 * Determinism.
 *
 * Same commands + same seed + same clock => byte-identical event stream,
 * including `seq`, `simTimeUs`, `traceId` and the RNG-driven idle blinks. This
 * is what makes the simulator usable as a fixture generator, as a regression
 * baseline, and eventually as reproducible lesson playback.
 *
 * It is also the property most easily lost by accident: one `Date.now()`, one
 * `Math.random()`, one `Set` iterated in insertion-dependent order, and it is
 * gone. So the test runs the whole script twice in the same process and
 * compares serialised output rather than spot-checking fields.
 */
import { describe, expect, it } from 'vitest';

import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';

import { SimulatedSesameRobot } from '../robot.js';
import type { SimulatedRobotOptions } from '../config.js';
import { MOVEMENT_NAMES } from '../choreography.js';

/**
 * A script that touches every source of non-determinism the model has: virtual
 * time, the trace counter, the sequence counter, the seeded PRNG behind idle
 * blinking, and a face animation whose frame timing depends on the clock.
 */
async function run(options: SimulatedRobotOptions = {}): Promise<string> {
  const robot = new SimulatedSesameRobot(options);
  const lines: string[] = [];
  robot.subscribe((event: SesameTelemetry) => lines.push(JSON.stringify(event)));

  await robot.connect();
  await robot.command('wave');
  await robot.setFace('dance');
  await robot.command('stand'); // enters idle
  await robot.runFor(25_000); // idle blinks: PRNG territory
  await robot.setJoint('R4', 137);
  await robot.setPose({ L4: 10, R1: 170, L1: 5 });
  await robot.command('shrug');

  const state = await robot.getState();
  lines.push(JSON.stringify(state));
  return lines.join('\n');
}

describe('determinism', () => {
  it('produces a byte-identical stream on a second run', async () => {
    const first = await run();
    const second = await run();
    expect(second).toBe(first);
    // Sanity: the script is actually doing something substantial.
    expect(first.split('\n').length).toBeGreaterThan(100);
  });

  it('changes when the seed changes, and only in the RNG-driven parts', async () => {
    const a = await run({ seed: 1 });
    const b = await run({ seed: 99 });
    expect(b).not.toBe(a);
    // Both still start with the same boot and the same wave, because nothing
    // before the first idle blink consumes a random number.
    expect(b.split('\n').slice(0, 30)).toEqual(a.split('\n').slice(0, 30));
  });

  it('gives every movement a stable event stream', async () => {
    for (const name of MOVEMENT_NAMES) {
      const once = await capture(name);
      const twice = await capture(name);
      expect(twice, name).toBe(once);
    }
  });

  it('keeps seq strictly increasing and simTimeUs non-decreasing', async () => {
    const robot = new SimulatedSesameRobot();
    const events: SesameTelemetry[] = [];
    robot.subscribe((e) => events.push(e));
    await robot.connect();
    await robot.command('dance');
    await robot.command('crab');

    let seq = -1;
    let time = -1;
    for (const event of events) {
      expect(event.seq).toBe(seq + 1);
      seq = event.seq;
      expect(event.simTimeUs ?? 0).toBeGreaterThanOrEqual(time);
      time = event.simTimeUs ?? 0;
    }
    expect(events.length).toBeGreaterThan(50);
  });
});

async function capture(movement: string): Promise<string> {
  const robot = new SimulatedSesameRobot();
  const lines: string[] = [];
  robot.subscribe((event) => lines.push(JSON.stringify(event)));
  await robot.connect();
  await robot.runMovement(movement);
  return lines.join('\n');
}
