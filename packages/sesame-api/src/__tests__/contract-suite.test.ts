/**
 * The contract suite, run against the one backend that exists today.
 *
 * This file is deliberately four lines of substance. Everything a backend must
 * satisfy lives in `src/contract/index.ts`, and adding `RealSesameRobot` or a
 * QEMU-backed robot means adding a second `describeRobotContract(...)` call —
 * here or in that backend's own package — and changing nothing else.
 */
import { describe, it } from 'vitest';

import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';

import { describeRobotContract } from '../contract/index.js';

describeRobotContract(() => new SimulatedSesameRobot(), {
  name: 'SesameRobot contract · SimulatedSesameRobot',
  runner: { describe, it },
});
