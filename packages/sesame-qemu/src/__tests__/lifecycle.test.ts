/**
 * Process lifecycle, the part that is only hard on a real backend.
 *
 * The claim being tested is "`disconnect()` leaves no orphaned `qemu.exe`",
 * and it is tested the only way that is worth anything on Windows: by asking
 * the operating system, by PID, after the fact. `child.kill()` returning true
 * proves nothing — `TerminateProcess` is asynchronous from the caller's point
 * of view, so a check that ran immediately after would pass on a process that
 * is still there.
 */
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { QemuSesameRobot } from '../robot.js';
import { livePids } from '../session.js';
import { QEMU_AVAILABLE, SKIP_REASON } from './helpers.js';

/** Ask Windows, by PID, whether a QEMU process is still running. */
function qemuAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/NH'], {
      encoding: 'utf8',
    });
    return /qemu-system-xtensa/i.test(out);
  } catch {
    return false;
  }
}

describe.skipIf(!QEMU_AVAILABLE)(`QemuSesameRobot lifecycle${SKIP_REASON()}`, () => {
  it('connects, reports the boot it got, and tears down with no orphan', { timeout: 180_000 }, async () => {
    const robot = new QemuSesameRobot();
    let pid: number | undefined;
    try {
      await robot.connect();
      pid = robot.session?.pid;
      expect(pid).toBeTypeOf('number');
      expect(qemuAlive(pid)).toBe(true);
      expect(livePids()).toContain(pid);

      // Boot is verified against the firmware's own banner, so a session that
      // exists has definitely reached the end of setup().
      expect(robot.session?.booted).toBe(true);
      expect(robot.session?.panic).toBeNull();

      // Every attempt is recorded, successful or not — this is how a caller
      // measures ISSUE-20260823-022 without parsing a log.
      const attempts = robot.bootAttempts;
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts.at(-1)?.ok).toBe(true);
      for (const failed of attempts.slice(0, -1)) {
        expect(failed.ok).toBe(false);
        expect(failed.reason).toBeTypeOf('string');
      }
    } finally {
      await robot.disconnect();
    }

    expect(qemuAlive(pid)).toBe(false);
    expect(livePids()).not.toContain(pid);
  });

  it('disconnect is idempotent and safe before connect', { timeout: 60_000 }, async () => {
    const robot = new QemuSesameRobot();
    await robot.disconnect();
    await robot.disconnect();
    expect(livePids()).toEqual([]);
  });

  it('refuses to command a robot that is not connected', () => {
    const robot = new QemuSesameRobot();
    expect(() => robot.command('wave')).toThrow(/requires connect/);
  });

  it(
    'boot telemetry is replayed to a subscriber attached before connect()',
    { timeout: 180_000 },
    async () => {
      const robot = new QemuSesameRobot();
      const events: string[] = [];
      robot.subscribe((e) => {
        events.push(e.type);
      });
      try {
        await robot.connect();
      } finally {
        await robot.disconnect();
      }
      // `@SESAME hello 1 …` and the `rest` face setup() ends with, both of
      // which happen long before `connect()` can return.
      expect(events).toContain('protocol.hello');
      expect(events).toContain('face.expression');
    },
  );

  it(
    'every event carries an emulator origin, not a bare "observed"',
    { timeout: 180_000 },
    async () => {
      const robot = new QemuSesameRobot();
      const origins = new Set<string>();
      const provenances = new Set<string>();
      robot.subscribe((e) => {
        origins.add(e.origin?.kind ?? 'MISSING');
        provenances.add(e.provenance);
      });
      try {
        await robot.connect();
      } finally {
        await robot.disconnect();
      }
      expect([...provenances]).toEqual(['observed']);
      expect([...origins]).toEqual(['emulator']);
    },
  );

  it(
    'a commanded wave produces the firmware’s own servo stream',
    { timeout: 300_000 },
    async () => {
      const robot = new QemuSesameRobot();
      const servo: { joint: string; angleDeg: number }[] = [];
      robot.subscribe((e) => {
        if (e.type === 'servo.target') servo.push({ joint: e.joint, angleDeg: e.angleDeg });
      });
      try {
        await robot.connect();
        // Nothing has moved yet: this image, unlike Q1's, has no injected
        // movement in setup(). Any servo event after this point was caused by
        // the host asking for one.
        expect(servo).toHaveLength(0);

        await robot.command('wave');
        const state = await robot.getState();
        expect(state.observed.lastCommandLine).toBe('rn wv');

        // Q1 measured exactly 29 servo events for one runWavePose(), three runs
        // in a row. Same count, now on demand instead of at power-on.
        expect(servo).toHaveLength(29);
        expect(servo.slice(0, 8)).toEqual([
          { joint: 'R1', angleDeg: 135 },
          { joint: 'R2', angleDeg: 45 },
          { joint: 'L1', angleDeg: 45 },
          { joint: 'L2', angleDeg: 135 },
          { joint: 'R4', angleDeg: 0 },
          { joint: 'R3', angleDeg: 180 },
          { joint: 'L3', angleDeg: 0 },
          { joint: 'L4', angleDeg: 180 },
        ]);
        for (const joint of Object.keys(state.observed.everObserved)) {
          expect(
            state.observed.everObserved[joint as keyof typeof state.observed.everObserved],
          ).toBe(true);
        }
      } finally {
        await robot.disconnect();
      }
    },
  );

  it(
    'a joint written directly reports back, and the others stay marked unobserved',
    { timeout: 300_000 },
    async () => {
      const robot = new QemuSesameRobot();
      try {
        await robot.connect();
        await robot.setJoint('L3', 42);
        const state = await robot.getState();
        expect(state.observed.lastCommandLine).toBe('6 42'); // L3 is channel 6
        expect(state.joints.L3.commandedDeg).toBe(42);
        expect(state.observed.everObserved.L3).toBe(true);
        // The honest part: R1 was never written, so its 90 is an assumption and
        // the state says so rather than reporting it as a reading.
        expect(state.observed.everObserved.R1).toBe(false);
        expect(state.joints.R1.commandedDeg).toBe(90);
        expect(state.joints.R1.measuredDeg).toBeNull();
      } finally {
        await robot.disconnect();
      }
    },
  );

  it(
    'setPose writes every requested channel in firmware order',
    { timeout: 300_000 },
    async () => {
      const robot = new QemuSesameRobot();
      const servo: string[] = [];
      robot.subscribe((e) => {
        if (e.type === 'servo.target') servo.push(`${e.joint}=${String(e.angleDeg)}`);
      });
      try {
        await robot.connect();
        // Deliberately out of firmware order in the request.
        await robot.setPose({ L4: 100, R1: 10, L3: 20 });
        expect(servo).toEqual(['R1=10', 'L3=20', 'L4=100']);
      } finally {
        await robot.disconnect();
      }
    },
  );
});
