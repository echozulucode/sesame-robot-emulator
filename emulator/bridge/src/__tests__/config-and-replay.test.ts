/**
 * Unit-level cover for the two pieces that are easy to get quietly wrong: the
 * CLI surface (where a bad default becomes a security posture) and the fixture
 * parser (where a bad default becomes a demo that lies about timing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Backoff } from '../backoff.js';
import { ConfigError, LOOPBACK, defaultConfig, parseArgs } from '../config.js';
import { ReplayError, parseFixture } from '../replay-server.js';
import { REPO, WAVE_FIXTURE } from './helpers.js';

describe('configuration', () => {
  it('binds to loopback unless explicitly told otherwise', () => {
    // The research report warns specifically against putting a robot control
    // API on a wider network. Localhost is the default; widening it is a flag.
    const config = parseArgs([]);
    expect(config).not.toBe('help');
    if (config === 'help') return;
    expect(config.wsHost).toBe(LOOPBACK);
    expect(config.uartHost).toBe(LOOPBACK);

    const remote = parseArgs(['--allow-remote']);
    if (remote === 'help') throw new Error('unexpected help');
    expect(remote.wsHost).toBe('0.0.0.0');
  });

  it('defaults a replayed stream to `simulated` provenance', () => {
    // Honest by default: a replay is not an observation. Claiming otherwise is
    // exactly the failure the provenance tag exists to prevent, so the honest
    // label is the free one.
    const replay = parseArgs(['--replay', 'x.jsonl']);
    if (replay === 'help') throw new Error('unexpected help');
    expect(replay.defaultProvenance).toBe('simulated');

    const live = parseArgs([]);
    if (live === 'help') throw new Error('unexpected help');
    expect(live.defaultProvenance).toBe('observed');

    const forced = parseArgs(['--replay', 'x.jsonl', '--provenance', 'observed']);
    if (forced === 'help') throw new Error('unexpected help');
    expect(forced.defaultProvenance).toBe('observed');
  });

  it('rejects nonsense loudly instead of guessing', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ConfigError);
    expect(() => parseArgs(['--uart-port'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--uart-port', 'abc'])).toThrow(/expected a number/);
    expect(() => parseArgs(['--provenance', 'probably'])).toThrow(/observed\|simulated\|inferred/);
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('round-trips ports and replay options', () => {
    const config = parseArgs([
      '--uart-port', '4000', '--ws-port', '0', '--replay', 'f.jsonl',
      '--replay-speed', '5', '--loop', '--loop-gap', '250', '--buffer', '7', '--quiet',
    ]);
    if (config === 'help') throw new Error('unexpected help');
    expect(config).toMatchObject({
      uartPort: 4000,
      wsPort: 0,
      bufferSize: 7,
      verbose: false,
      replay: { file: 'f.jsonl', speed: 5, loop: true, loopGapMs: 250 },
    });
  });

  it('defaultConfig is the same shape the CLI produces', () => {
    const fromCli = parseArgs(['--quiet']);
    if (fromCli === 'help') throw new Error('unexpected help');
    expect(Object.keys(fromCli).sort()).toEqual(Object.keys(defaultConfig()).sort());
  });
});

describe('backoff', () => {
  it('grows geometrically and stops at the ceiling', () => {
    const b = new Backoff({ initialMs: 100, maxMs: 800, factor: 2, jitter: 0 }, () => 0.5);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([100, 200, 400, 800, 800]);
    b.reset();
    expect(b.next()).toBe(100);
  });

  it('applies jitter symmetrically around the base delay', () => {
    const low = new Backoff({ initialMs: 100, maxMs: 100, factor: 1, jitter: 0.5 }, () => 0);
    const high = new Backoff({ initialMs: 100, maxMs: 100, factor: 1, jitter: 0.5 }, () => 1);
    expect(low.next()).toBe(50);
    expect(high.next()).toBe(150);
  });
});

describe('replay fixture parsing', () => {
  it('reads the shipped wave fixture with its header', () => {
    const fixture = parseFixture(fs.readFileSync(WAVE_FIXTURE, 'utf8'));
    expect(fixture.header).toMatchObject({ source: { movement: 'runWavePose' } });
    expect(fixture.lines.length).toBeGreaterThan(30);
    expect(fixture.durationMs).toBeGreaterThan(3000);
    // Monotonic timestamps, or the scheduler would try to go backwards.
    for (let i = 1; i < fixture.lines.length; i++) {
      expect(fixture.lines[i]!.tMs).toBeGreaterThanOrEqual(fixture.lines[i - 1]!.tMs);
    }
  });

  it('accepts a plain captured serial log with no timing at all', () => {
    const fixture = parseFixture('@SESAME servo R1 10\n@SESAME servo R2 20\n');
    expect(fixture.lines.map((l) => l.tMs)).toEqual([0, 20]);
    expect(fixture.header).toBeNull();
  });

  it('refuses a fixture that goes backwards in time', () => {
    const text = ['{"tMs":10,"line":"a"}', '{"tMs":5,"line":"b"}'].join('\n');
    expect(() => parseFixture(text)).toThrow(ReplayError);
  });

  it('refuses malformed JSONL rather than silently skipping lines', () => {
    expect(() => parseFixture('{"tMs":0,"line":"a"}\n{oops}')).toThrow(/not valid JSON/);
    expect(() => parseFixture('{"tMs":0}')).toThrow(/no string 'line'/);
  });

  it('the shipped fixture is still exactly what hardware-map.json produces', () => {
    // The demo's claim is that it shows the robot's REAL wave. That claim decays
    // the moment hardware-map.json changes and nobody regenerates the fixture,
    // so re-derive it and diff rather than trusting the file's own header.
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts/build-replay-fixture.mjs'), 'runWavePose', '--check'],
      { encoding: 'utf8' },
    );
    expect(`${result.stdout}${result.stderr}`.trim()).toMatch(/up to date/);
    expect(result.status).toBe(0);
  });
});
