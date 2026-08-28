/**
 * QEMU is the default, and the default is DETECTED — Phase 4 W8.
 *
 * > *"The QEMU should be the default."*
 *
 * The one-word version of that is wrong in two arrangements this repository
 * ships: `just dev-sim` runs a lab host whose backend is the behavioural
 * simulator, and `pnpm demo:web` serves the built app from the bridge with no
 * lab host at all. So the choice is a probe of `/lab/session`, and the three
 * legs below are the three answers it can get.
 *
 * The leg worth arguing about is the last one. **No lab host does NOT fall back
 * to the simulator.** Quietly landing on a host model because the emulator was
 * unreachable is exactly the substitution this project refuses everywhere else,
 * and a reader would have no way to tell a booted emulator from a model wearing
 * its name. Staying on QEMU and reporting `absent` is what lets the UI show the
 * existing "no lab host is answering" guidance instead of an unexplained error.
 */
import { describe, expect, it } from 'vitest';

import {
  backendFromSession,
  DEFAULT_BACKEND,
  labHostAbsent,
  probeLabHost,
} from '../backends/default-backend.js';

describe('the default itself', () => {
  it('is QEMU', () => {
    expect(DEFAULT_BACKEND).toBe('qemu');
  });
});

describe('reading /lab/session', () => {
  it('a QEMU lab host keeps the default', () => {
    const probe = backendFromSession({ backend: 'qemu', phase: 'ready' });
    expect(probe.backend).toBe('qemu');
    expect(probe.labHost).toBe('qemu');
  });

  it('a SIM lab host moves the app to the simulator, and says why', () => {
    const probe = backendFromSession({ backend: 'sim', phase: 'ready' });
    expect(probe.backend).toBe('sim');
    expect(probe.labHost).toBe('sim');
    expect(probe.detail).toMatch(/simulator/i);
    // The honest half: it must not let a reader think this is the emulator.
    expect(probe.detail).toMatch(/Nothing here is the emulator/i);
  });

  it('a lab host naming a backend this app has no arm for is REPORTED, not mapped', () => {
    const probe = backendFromSession({ backend: 'hardware' });
    expect(probe.backend).toBe(DEFAULT_BACKEND);
    expect(probe.labHost).toBe('unknown');
    expect(probe.detail).toContain('hardware');
  });

  it('is total over garbage, because /lab/session is a foreign document', () => {
    for (const session of [null, undefined, 42, 'sim', [], {}, { backend: null }]) {
      const probe = backendFromSession(session);
      expect(['qemu', 'sim']).toContain(probe.backend);
      expect(probe.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('when nothing answers', () => {
  it('stays on QEMU rather than substituting the host model', () => {
    const probe = labHostAbsent('http://127.0.0.1:8099', 'Failed to fetch');
    expect(probe.backend).toBe('qemu');
    expect(probe.labHost).toBe('absent');
    expect(probe.detail).toMatch(/No lab host answered/);
    expect(probe.detail).toMatch(/rather than quietly substituting/);
  });

  it('a network error is absent, not a crash', async () => {
    const probe = await probeLabHost('http://127.0.0.1:1/', () => {
      throw new TypeError('Failed to fetch');
    });
    expect(probe.labHost).toBe('absent');
    expect(probe.backend).toBe('qemu');
    expect(probe.detail).toContain('Failed to fetch');
    // The trailing slash is normalised away, so the URL in the guidance is the
    // one a reader would type.
    expect(probe.detail).toContain('http://127.0.0.1:1/lab/session');
  });

  it('a 404 is absent too — a static server is not a lab host', async () => {
    const probe = await probeLabHost('http://example.test', () =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response),
    );
    expect(probe.labHost).toBe('absent');
    expect(probe.detail).toContain('HTTP 404');
  });

  it('a body that is not JSON is absent rather than a guess', async () => {
    const probe = await probeLabHost('http://example.test', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      } as unknown as Response),
    );
    expect(probe.labHost).toBe('absent');
    expect(probe.backend).toBe('qemu');
  });
});

describe('the happy path, end to end', () => {
  it('reads the backend the host names', async () => {
    const seen: string[] = [];
    const probe = await probeLabHost('http://127.0.0.1:8099/', (url) => {
      seen.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ backend: 'sim' }),
      } as Response);
    });
    expect(seen).toEqual(['http://127.0.0.1:8099/lab/session']);
    expect(probe.backend).toBe('sim');
  });
});
