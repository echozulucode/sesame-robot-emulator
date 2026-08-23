/**
 * Parity with Phase 0's replay fixture.
 *
 * `scripts/build-replay-fixture.mjs` (R7) renders `runWavePose` into a timed
 * `@SESAME` UART stream. It reads the same `hardware/hardware-map.json` this
 * package does, but it is an entirely separate implementation written months
 * earlier for a different purpose — so where the two agree, two independent
 * readings of the extractor's output agree, and where they disagree the
 * disagreement had better be one we can name.
 *
 * They should agree exactly on the servo stream and on elapsed time. They
 * should *not* agree on faces: the fixture explicitly declines to model
 * `updateAnimatedFace()`'s inter-frame emissions, because it had no clock. This
 * package does have one, so it emits them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { JointName } from '@sesame-lab/sesame-model';

import { makeRig, REPO_ROOT, type ServoWrite } from './helpers.js';

const FIXTURE = resolve(REPO_ROOT, 'emulator', 'bridge', 'fixtures', 'wave-pose.replay.jsonl');
const available = existsSync(FIXTURE);

interface FixtureLine {
  tMs: number;
  line: string;
  note?: string;
}

describe.runIf(available)('parity with the R7 replay fixture', () => {
  const raw = available ? readFileSync(FIXTURE, 'utf8').trim().split('\n') : [];
  const header = available
    ? (JSON.parse(raw[0] as string) as { header: { durationMs: number } }).header
    : { durationMs: 0 };
  const lines = raw.slice(1).map((l) => JSON.parse(l) as FixtureLine);

  const fixtureServos: ServoWrite[] = lines
    .map((l) => /^@SESAME servo (\S+) (-?\d+)$/.exec(l.line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ joint: m[1] as JointName, angleDeg: Number(m[2]) }));

  it('renders the identical servo stream for runWavePose', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement('runWavePose');
    expect(rig.servoWrites()).toEqual(fixtureServos);
    expect(fixtureServos.length).toBeGreaterThan(20);
  });

  it('agrees on elapsed time to within the loop quantum', async () => {
    const rig = await makeRig();
    const before = rig.robot.nowMs;
    await rig.robot.runMovement('runWavePose');
    expect(rig.robot.nowMs - before).toBe(header.durationMs);
  });

  it('matches the fixture on faces too, because wave selects only static ones', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.runMovement('runWavePose');
    const fixtureFaces = lines
      .map((l) => /^@SESAME face (\S+) (\d+)$/.exec(l.line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ name: m[1] as string, frame: Number(m[2]) }));
    expect(rig.ofType('face.expression').map((e) => ({ name: e.name, frame: e.frame }))).toEqual(
      fixtureFaces,
    );
    // `wave` and `idle` both have one frame and `stand` has none, so there is
    // nothing for updateAnimatedFace() to advance — which is why the fixture's
    // "inter-frame emissions not modelled" caveat costs it nothing here.
    expect(fixtureFaces.map((f) => f.name)).toEqual(['wave', 'idle']);
  });

  it('does model the inter-frame emissions the fixture had to skip', async () => {
    const rig = await makeRig();
    rig.clear();
    // `dead` has 3 frames at 2 fps and runShrugPose holds it for a second, so a
    // renderer without a clock could only ever have emitted frame 0.
    await rig.robot.runMovement('runShrugPose');
    const deadFrames = rig
      .ofType('face.expression')
      .filter((e) => e.name === 'dead')
      .map((e) => e.frame);
    expect(deadFrames.length).toBeGreaterThan(1);
    expect(new Set(deadFrames).size).toBeGreaterThan(1);
  });
});
