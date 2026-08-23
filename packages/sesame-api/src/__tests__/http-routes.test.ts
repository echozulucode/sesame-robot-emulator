/**
 * The ten routes, end to end, over a real socket.
 *
 * The contract suite (`contract-suite.test.ts`) covers what *any* backend must
 * do. This file covers what *this adapter* must do — the status codes, the
 * exact response bodies, the argument precedence and the several places where a
 * reasonable implementation would be wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';

import { SesameApiServer } from '../server.js';

let robot: SimulatedSesameRobot;
let api: SesameApiServer;
let base: string;

beforeEach(async () => {
  robot = new SimulatedSesameRobot();
  await robot.connect();
  api = new SesameApiServer({ robot, port: 0, logger: () => undefined, warn: () => undefined });
  await api.listen();
  base = api.url ?? '';
});

afterEach(async () => {
  await api.close();
  await robot.disconnect();
});

const get = (path: string): Promise<Response> => fetch(`${base}${path}`);

const post = (path: string, body: string, contentType = 'application/json'): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': contentType }, body });

describe('GET / — handleRoot (:226)', () => {
  it('serves HTML and says it is a stub', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('stub');
    // Self-contained: nothing fetched from anywhere.
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});

describe('/cmd — handleCommandWeb (:230)', () => {
  it('answers 200 "OK" before the movement has run', async () => {
    const res = await get('/cmd?pose=stand');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    await api.adapter.drain();
  });

  it('tests pose first, so ?pose=&stop= runs the pose', async () => {
    // The handler is an if/else-if chain (:232-:262): `stop` is never looked at
    // once `pose` is present. If it had won, nothing would move.
    expect((await get('/cmd?pose=stand&stop=1')).status).toBe(200);
    await api.adapter.drain();
    expect((await robot.getState()).joints.R1.commandedDeg).toBe(135);
  });

  it('400s an argument-free /cmd', async () => {
    const res = await get('/cmd');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Bad Args');
  });

  it('400s /cmd?stop but accepts /cmd?stop=', async () => {
    expect((await get('/cmd?stop')).status).toBe(400);
    expect((await get('/cmd?stop=')).status).toBe(200);
  });

  it('drives a servo by 1-based number and by firmware name', async () => {
    expect((await get('/cmd?motor=1&value=120')).status).toBe(200);
    expect((await robot.getState()).joints.R1.commandedDeg).toBe(120);

    expect((await get('/cmd?motor=L3&value=30')).status).toBe(200);
    expect((await robot.getState()).joints.L3.commandedDeg).toBe(30);
  });

  it('rejects a bad channel or angle with the firmware wording', async () => {
    for (const query of ['motor=0&value=10', 'motor=9&value=10', 'motor=1&value=181']) {
      const res = await get(`/cmd?${query}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Invalid motor or angle');
    }
  });

  it('accepts motor=3abc because String::toInt() does', async () => {
    expect((await get('/cmd?motor=3abc&value=44')).status).toBe(200);
    expect((await robot.getState()).joints.L1.commandedDeg).toBe(44);
  });

  it('is case sensitive about joint names — servoNameToIndex has no fallback', async () => {
    expect((await get('/cmd?motor=l3&value=30')).status).toBe(400);
  });
});

describe('/getSettings and /setSettings (:270, :280)', () => {
  it('returns exactly the four documented keys, in source order', async () => {
    const res = await get('/getSettings');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '{"frameDelay":100,"walkCycles":10,"motorCurrentDelay":20,"faceFps":8}',
    );
  });

  it('validates nothing except the faceFps floor', async () => {
    expect((await get('/setSettings?frameDelay=-5&walkCycles=lots&faceFps=0')).status).toBe(200);
    const settings = (await (await get('/getSettings')).json()) as Record<string, number>;
    expect(settings['frameDelay']).toBe(-5); // no range check upstream
    expect(settings['walkCycles']).toBe(0); // "lots".toInt() === 0
    expect(settings['faceFps']).toBe(1); // max(1L, …)
    expect(settings['motorCurrentDelay']).toBe(20); // absent arg, untouched
  });

  it('does not know about motorSpeed, which the portal sends anyway (F4 §1.12)', async () => {
    await get('/setSettings?motorSpeed=5');
    const settings = (await (await get('/getSettings')).json()) as Record<string, number>;
    expect(settings['motorSpeed']).toBeUndefined();
  });
});

describe('POST /api/command (:303)', () => {
  it('405s a non-POST, from inside the handler', async () => {
    const res = await get('/api/command');
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'Method not allowed' });
  });

  it('runs a command', async () => {
    const res = await post('/api/command', '{"command":"stand"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', message: 'Command executed' });
    await api.adapter.drain();
    expect((await robot.getState()).joints.R1.commandedDeg).toBe(135);
  });

  it('acknowledges a face-only body without running anything', async () => {
    const res = await post('/api/command', '{"face":"happy"}');
    expect(await res.json()).toEqual({ status: 'ok', message: 'Face updated' });
    expect((await robot.getState()).face.expression).toBe('happy');
  });

  it('stops', async () => {
    const res = await post('/api/command', '{"command":"stop"}');
    expect(await res.json()).toEqual({ status: 'ok', message: 'Command stopped' });
  });

  it('400s a form-urlencoded body — arg("plain") is empty', async () => {
    const res = await post(
      '/api/command',
      '{"command":"wave"}',
      'application/x-www-form-urlencoded',
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing command field' });
  });

  it('accepts a body with no Content-Type at all', async () => {
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      body: '{"command":"stand"}',
    });
    // fetch() adds text/plain;charset=UTF-8, which the core also treats as plain.
    expect(res.status).toBe(200);
    await api.adapter.drain();
  });

  it('accepts an unknown command word with a 200 and then does nothing (the sink)', async () => {
    const res = await post('/api/command', '{"command":"pirouette"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', message: 'Command executed' });
    await api.adapter.drain();

    const status = (await (await get('/api/status')).json()) as { currentCommand: string };
    // Set, matching nothing, never cleared — hardware-map.json commands.dispatchNote.
    expect(status.currentCommand).toBe('pirouette');
    // And nothing moved.
    expect((await robot.getState()).joints.R1.commandedDeg).toBe(90);
  });
});

describe('/api/status (:289)', () => {
  it('reports the AP address it is actually reachable at', async () => {
    const status = (await (await get('/api/status')).json()) as Record<string, unknown>;
    expect(status['apIP']).toBe('127.0.0.1');
    expect(status['networkConnected']).toBe(false);
    expect(status['networkIP']).toBeUndefined();
  });
});

describe('/api/wifi/* (:555, :597, :623)', () => {
  it('scans in two steps and finds no networks, because there is no radio', async () => {
    expect(await (await get('/api/wifi/scan')).json()).toEqual({ scanning: true });
    expect(await (await get('/api/wifi/scan')).json()).toEqual([]);
  });

  it('walks the connect ladder', async () => {
    expect((await get('/api/wifi/connect')).status).toBe(405);

    const noSsid = await post('/api/wifi/connect', 'ssid=', 'application/x-www-form-urlencoded');
    expect(noSsid.status).toBe(400);
    expect(await noSsid.json()).toEqual({ success: false, error: 'SSID required' });

    const ok = await post(
      '/api/wifi/connect',
      'ssid=Home&password=hunter2',
      'application/x-www-form-urlencoded',
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, pending: true });
  });

  it('reports a station state that is honest about having no radio', async () => {
    await post('/api/wifi/connect', 'ssid=Home', 'application/x-www-form-urlencoded');
    const status = (await (await get('/api/wifi/status')).json()) as Record<string, unknown>;
    expect(status['connected']).toBe(false);
    expect(status['connecting']).toBe(false);
    expect(String(status['lastError'])).toContain('no radio');
    expect(status['ssid']).toBeUndefined();
  });
});

describe('onNotFound (:643)', () => {
  it('gives an /api/ typo a JSON 404', async () => {
    const res = await get('/api/statuss');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('gives everything else the portal with a 200, not a 404', async () => {
    for (const path of ['/generate_204', '/hotspot-detect.html', '/cmnd', '/cmd/']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });
});

describe('requests are serviced while a movement is running', () => {
  /**
   * On the robot, `server.handleClient()` is pumped from inside
   * `delayWithFace()`, which runs after *every* servo write — so an HTTP
   * request really is accepted in the middle of a pose (F4 §2.4).
   *
   * In `timeMode: 'virtual'` the model drains a whole movement synchronously,
   * so requests queue at movement boundaries instead; in `'realtime'` the pacer
   * awaits at each pump and the Node event loop gets the same window the
   * firmware's pumps give it. This asserts the latter, which is the mode a
   * demo or a lesson would actually run in.
   */
  it('answers /api/status mid-pose in realtime mode', async () => {
    const paced = new SimulatedSesameRobot({ timeMode: 'realtime' });
    await paced.connect();
    const pacedApi = new SesameApiServer({
      robot: paced,
      port: 0,
      logger: () => undefined,
      warn: () => undefined,
    });
    await pacedApi.listen();
    try {
      const url = String(pacedApi.url);
      // runStandPose is 8 writes x 20 ms motorCurrentDelay = ~160 ms of pumps.
      expect((await fetch(`${url}/cmd?pose=stand`)).status).toBe(200);
      const status = (await (await fetch(`${url}/api/status`)).json()) as {
        currentCommand: string;
      };
      expect(status.currentCommand).toBe('stand');
      await pacedApi.adapter.drain();
      expect((await paced.getState()).joints.R1.commandedDeg).toBe(135);
    } finally {
      await pacedApi.close();
      await paced.disconnect();
    }
  });
});

describe('HTTP_ANY (F4 §1.9)', () => {
  it('serves every non-checking route from any verb', async () => {
    for (const [method, path] of [
      ['DELETE', '/getSettings'],
      ['PUT', '/api/status'],
      ['PATCH', '/'],
      ['POST', '/cmd?pose=rest'],
      ['OPTIONS', '/api/wifi/status'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    await api.adapter.drain();
  });
});
