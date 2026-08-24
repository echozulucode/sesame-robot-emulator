/**
 * `describeRobotContract` against `QemuSesameRobot`.
 *
 * This is the acceptance test and, per the plan's V5 design, the whole point:
 * the same fifteen cases that hold `SimulatedSesameRobot` to the firmware's
 * behaviour, run against firmware that is actually executing. **No case is
 * overridden, no case is skipped, and nothing in `contract/index.ts` was
 * changed to accommodate this backend** — with one exception, recorded here
 * because it would otherwise be invisible:
 *
 * > C06 asserted `mode` against a hand-copied `['real','simulated','renode']`.
 * > `RobotMode` gained `'qemu'` for this backend, so the copy was rejecting a
 * > value the type permits. The case now checks against `ROBOT_MODES` itself.
 * > The requirement — "`mode` must be a `RobotMode`" — is unchanged; only the
 * > transcription that had gone stale was removed.
 *
 * Each case gets a **fresh QEMU boot**, because that is what the suite's
 * factory contract means and because a case that wedged the guest must not
 * leak into the next one. Fifteen boots is minutes, not milliseconds; the
 * timeout is set accordingly and `describe.skipIf` keeps a machine without the
 * emulator from failing.
 */
import { describe, it } from 'vitest';

import { describeRobotContract } from '@sesame-lab/sesame-api/contract';

import { QemuSesameRobot } from '../robot.js';
import { QEMU_AVAILABLE, SKIP_REASON } from './helpers.js';

// Vitest has no per-suite timeout option on `describe`, and every case here
// boots an emulator, so the timeout is applied by wrapping `it`.
const CASE_TIMEOUT_MS = 300_000;

describe.skipIf(!QEMU_AVAILABLE)(`QemuSesameRobot${SKIP_REASON()}`, () => {
  describeRobotContract(() => new QemuSesameRobot(), {
    name: 'SesameRobot contract · QemuSesameRobot (real firmware under Espressif QEMU)',
    runner: {
      describe,
      it: (name, fn) => {
        it(name, { timeout: CASE_TIMEOUT_MS }, fn);
      },
    },
  });
});
