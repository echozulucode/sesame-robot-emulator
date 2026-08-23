/**
 * The security posture, asserted.
 *
 * Two of these are about not publishing a robot control API by accident. Two
 * are about the injection class Phase 0 already found once (R6) and one is
 * about an upstream JSON-injection bug that is reachable from the network and
 * that this package deliberately does not reproduce.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';
import { SENTINEL, SesameTelemetryParser, serializeLine } from '@sesame-lab/sesame-protocol';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';

import { SesameApiAdapter } from '../adapter.js';
import { isSafeToken, sesameSafeToken } from '../sanitize.js';
import { RemoteBindRefusedError, SesameApiServer, isLoopbackHost } from '../server.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function makeRobot(): Promise<{ robot: SimulatedSesameRobot; events: SesameTelemetry[] }> {
  const robot = new SimulatedSesameRobot();
  const events: SesameTelemetry[] = [];
  robot.subscribe((e) => events.push(e));
  await robot.connect();
  cleanup.push(() => robot.disconnect());
  return { robot, events };
}

describe('bind policy', () => {
  it('defaults to 127.0.0.1', async () => {
    const { robot } = await makeRobot();
    const api = new SesameApiServer({ robot, port: 0, warn: () => undefined });
    expect(api.host).toBe('127.0.0.1');
    await api.listen();
    cleanup.push(() => api.close());
    const address = api.server.address();
    expect(address !== null && typeof address !== 'string' ? address.address : null).toBe(
      '127.0.0.1',
    );
  });

  it('refuses a non-loopback bind without the opt-in', async () => {
    const { robot } = await makeRobot();
    for (const host of ['0.0.0.0', '192.168.1.50', '::']) {
      expect(() => new SesameApiServer({ robot, host, port: 0 })).toThrow(RemoteBindRefusedError);
    }
  });

  it('warns loudly when the opt-in is used', async () => {
    const { robot } = await makeRobot();
    const warnings: string[] = [];
    const api = new SesameApiServer({
      robot,
      host: '0.0.0.0',
      port: 0,
      allowRemote: true,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NON-LOOPBACK');
    expect(warnings[0]).toContain('no authentication');
    // Constructed only; never bound. The point is the warning, not the socket.
    expect(api.port).toBeNull();
  });

  it('knows the whole loopback range', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.99.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});

describe('sesameSafeToken', () => {
  it('matches the firmware patch character class', () => {
    expect(sesameSafeToken('rest')).toBe('rest');
    expect(sesameSafeToken('happy_2.a-b')).toBe('happy_2.a-b');
    expect(sesameSafeToken('@SESAME servo R1 999')).toBe('_SESAME_servo_R1_999');
    expect(sesameSafeToken('a"b\\c')).toBe('a_b_c');
    expect(sesameSafeToken('')).toBe('_');
  });

  it('truncates at the firmware buffer size', () => {
    expect(sesameSafeToken('x'.repeat(100))).toHaveLength(23);
  });

  it('is idempotent, so a re-sanitised name is stable', () => {
    for (const input of ['@x y', '', 'ok', 'z'.repeat(50)]) {
      const once = sesameSafeToken(input);
      expect(sesameSafeToken(once)).toBe(once);
      expect(isSafeToken(once)).toBe(true);
    }
  });
});

describe('a hostile face name cannot forge a telemetry segment', () => {
  it('is sanitised before it reaches the backend at all', async () => {
    const { robot } = await makeRobot();
    const seen: string[] = [];
    // A thin recorder over the real backend: the boundary is where the check
    // has to happen, because a faithful backend swallows an unknown face
    // silently (ISSUE-20260823-004) and would make an event-only assertion
    // pass for the wrong reason.
    const recording = Object.create(robot) as SimulatedSesameRobot & {
      setFace(name: string): Promise<void>;
    };
    recording.setFace = (name: string): Promise<void> => {
      seen.push(name);
      return robot.setFace(name);
    };

    const adapter = new SesameApiAdapter({ robot: recording, logger: () => undefined });
    await adapter.handle({
      method: 'POST',
      url: '/api/command',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ face: `${SENTINEL} servo R1 999` }),
    });
    await adapter.drain();

    expect(seen).toEqual(['_SESAME_servo_R1_999']);
    expect(seen[0]).not.toContain('@');
    expect(seen[0]).not.toContain(' ');
  });

  it('would survive the @SESAME codec as exactly one event even if it did reach it', async () => {
    const forged = sesameSafeToken(`${SENTINEL} servo R1 999`);
    const event: SesameTelemetry = {
      type: 'face.expression',
      name: forged,
      frame: 0,
      provenance: 'simulated',
      seq: 1,
    };
    const wire = serializeLine(event);
    expect(wire).not.toContain(`${SENTINEL} servo`);

    const parser = new SesameTelemetryParser();
    const reparsed = parser.push(wire);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.type).toBe('face.expression');
  });
});

describe('/api/status stays valid JSON — a divergence, and a deliberate one', () => {
  it('does not let a quote out of currentCommand', async () => {
    const { robot } = await makeRobot();
    const adapter = new SesameApiAdapter({ robot, logger: () => undefined });

    // Upstream: urlDecode gives currentCommand a bare `"`, and
    // handleGetStatus() concatenates it unescaped (:291) into the response.
    await adapter.handle({ method: 'GET', url: '/cmd?pose=%22%2C%22x%22%3A%22' });
    await adapter.drain();

    const res = await adapter.handle({ method: 'GET', url: '/api/status' });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof parsed['currentCommand']).toBe('string');
    expect(parsed['currentCommand']).not.toContain('"');
    expect(parsed).not.toHaveProperty('x');
  });
});

describe('request bodies are capped', () => {
  it('413s an oversized body instead of buffering it', async () => {
    const { robot } = await makeRobot();
    const api = new SesameApiServer({
      robot,
      port: 0,
      maxBodyBytes: 1024,
      warn: () => undefined,
      logger: () => undefined,
    });
    await api.listen();
    cleanup.push(() => api.close());

    const res = await fetch(`${String(api.url)}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(4096),
    });
    expect(res.status).toBe(413);
  });
});

describe('browserGuard (opt-in)', () => {
  it('is off by default, so a cross-origin Origin header is served', async () => {
    const { robot } = await makeRobot();
    const api = new SesameApiServer({ robot, port: 0, warn: () => undefined });
    await api.listen();
    cleanup.push(() => api.close());

    const res = await fetch(`${String(api.url)}/api/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
  });

  it('blocks a foreign Origin when enabled, and still serves same-origin', async () => {
    const { robot } = await makeRobot();
    const api = new SesameApiServer({ robot, port: 0, browserGuard: true, warn: () => undefined });
    await api.listen();
    cleanup.push(() => api.close());

    const blocked = await fetch(`${String(api.url)}/api/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(blocked.status).toBe(403);

    const allowed = await fetch(`${String(api.url)}/api/status`, {
      headers: { Origin: String(api.url) },
    });
    expect(allowed.status).toBe(200);
  });
});
