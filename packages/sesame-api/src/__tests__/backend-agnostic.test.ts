/**
 * Two structural guarantees, because "backend-agnostic" is easy to claim and
 * easy to lose to one convenient import.
 *
 * 1. **No runtime coupling to `@sesame-lab/sesame-sim`** anywhere except
 *    `cli.ts`. A type-only import of the `SesameRobot` interface is fine — it
 *    is erased at build and V1 explicitly parks the interface in that package
 *    until a second implementation exists — but a value import is not.
 * 2. **The adapter works over a backend that is not the simulator.** A
 *    hand-written minimal robot exercises the same routes, which is the
 *    cheapest possible proof that nothing in the adapter reaches past the
 *    interface.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { JOINT_ORDER, type JointName, type RobotState } from '@sesame-lab/sesame-model';
import type { SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import type { SesameRobot } from '@sesame-lab/sesame-sim';

import { SesameApiAdapter } from '../adapter.js';
import { describeRobotContract, ROBOT_CONTRACT_CASES } from '../contract/index.js';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** A line that is entirely comment: `//…`, `/*…`, or a jsdoc continuation. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no runtime coupling to the simulator', () => {
  it('imports @sesame-lab/sesame-sim as a value only from cli.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const valueImport = /^import\s+(?!type\b)[^;]*from\s+'@sesame-lab\/sesame-sim'/m.test(text);
      if (valueImport && !file.endsWith('cli.ts')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('never constructs SimulatedSesameRobot outside cli.ts', () => {
    // Comments are stripped first: index.ts's usage example names the class,
    // which is exactly what a usage example should do.
    const offenders = sourceFiles(SRC).filter((file) => {
      if (file.endsWith('cli.ts')) return false;
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !COMMENT_LINE.test(line))
        .join('\n');
      return code.includes('new SimulatedSesameRobot');
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * A second backend, written by hand in thirty lines.
 *
 * It is not a good robot — it has no choreography and no faces — but it is a
 * valid `SesameRobot`, and every route has to keep working over it. Anything
 * the adapter needs beyond the interface shows up here immediately as a crash.
 */
class MinimalRobot implements SesameRobot {
  #connected = false;
  #face = 'default';
  #command = '';
  readonly #commanded = new Map<JointName, number>(JOINT_ORDER.map((j) => [j, 90]));
  readonly #listeners = new Set<(event: SesameTelemetry) => void>();

  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  capabilities(): Promise<SesameCapabilities> {
    return Promise.resolve({
      realHardware: false,
      firmwareExecution: false,
      oledFramebuffer: false,
      serialConsole: false,
      httpApi: true,
      physics: false,
    });
  }

  command(name: string): Promise<void> {
    if (!this.#connected) return Promise.reject(new Error('not connected'));
    this.#command = name === 'stop' ? '' : name;
    return Promise.resolve();
  }

  setFace(name: string): Promise<void> {
    this.#face = name;
    return Promise.resolve();
  }

  setJoint(joint: JointName, angleDeg: number): Promise<void> {
    this.#commanded.set(joint, angleDeg);
    return Promise.resolve();
  }

  setPose(pose: Partial<Record<JointName, number>>): Promise<void> {
    for (const [joint, deg] of Object.entries(pose)) {
      if (deg !== undefined) this.#commanded.set(joint as JointName, deg);
    }
    return Promise.resolve();
  }

  getState(): Promise<RobotState> {
    return Promise.resolve({
      mode: 'simulated',
      joints: Object.fromEntries(
        JOINT_ORDER.map((j) => [j, { commandedDeg: this.#commanded.get(j) ?? 90, measuredDeg: null }]),
      ) as RobotState['joints'],
      face: { expression: this.#face, frame: 0, width: 128, height: 64 },
      network: { state: 'simulated', ip: '127.0.0.1' },
      motion: { command: this.#command },
    });
  }

  subscribe(listener: (event: SesameTelemetry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

describe('the adapter over a hand-written backend', () => {
  it('serves every route without reaching past the SesameRobot interface', async () => {
    const robot = new MinimalRobot();
    await robot.connect();
    const adapter = new SesameApiAdapter({ robot, logger: () => undefined });

    const paths: Array<[string, string, number]> = [
      ['GET', '/', 200],
      ['GET', '/cmd?pose=wave', 200],
      ['GET', '/cmd?motor=1&value=10', 200],
      ['GET', '/getSettings', 200],
      ['GET', '/setSettings?walkCycles=2', 200],
      ['GET', '/api/status', 200],
      ['GET', '/api/command', 405],
      ['GET', '/api/wifi/scan', 200],
      ['GET', '/api/wifi/status', 200],
      ['GET', '/api/nope', 404],
      ['GET', '/nope', 200],
    ];
    for (const [method, url, status] of paths) {
      const res = await adapter.handle({ method, url });
      expect(res.status, `${method} ${url}`).toBe(status);
    }
    await adapter.drain();

    // network.state === 'simulated' is not 'station', so networkConnected stays
    // false and networkIP is withheld — the firmware only emits it when the
    // station interface is actually up.
    const status = JSON.parse((await adapter.handle({ method: 'GET', url: '/api/status' })).body) as
      Record<string, unknown>;
    expect(status['networkConnected']).toBe(false);
    expect(status['networkIP']).toBeUndefined();
  });

  it('exposes the contract cases as inspectable data, each with provenance', () => {
    expect(ROBOT_CONTRACT_CASES.length).toBeGreaterThanOrEqual(15);
    for (const testCase of ROBOT_CONTRACT_CASES) {
      expect(testCase.id).toMatch(/^C\d\d$/);
      expect(testCase.requirement.length).toBeGreaterThan(20);
      expect(testCase.provenance.length).toBeGreaterThan(5);
    }
    expect(new Set(ROBOT_CONTRACT_CASES.map((c) => c.id)).size).toBe(ROBOT_CONTRACT_CASES.length);
    expect(typeof describeRobotContract).toBe('function');
  });
});
