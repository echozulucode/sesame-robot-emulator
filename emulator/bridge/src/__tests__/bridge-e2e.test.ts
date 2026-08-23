/**
 * R7 — the end-to-end proof, headless.
 *
 * "A joint moves in the browser" is the demo. This is the *evidence*: the same
 * pipeline, asserted by a machine, with nobody looking at a canvas.
 *
 *   fixture (rendered from runWavePose in hardware-map.json)
 *     -> TCP socket   (the same socket Renode's terminal would expose)
 *     -> bridge       (reconnecting client + streaming @SESAME parser)
 *     -> WebSocket    (Node's built-in client, standing in for the browser)
 *     -> assertions on order, joints and angles
 *
 * The angles are not typed out here either. They are read back out of
 * `hardware/hardware-map.json` and expanded through the same rules the fixture
 * generator uses, so this test fails if the fixture stops matching the firmware
 * choreography — which is the only thing that would make the demo a lie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JOINT_ORDER } from '@sesame-lab/sesame-model';
import { SesameBridge } from '../bridge.js';
import { defaultConfig } from '../config.js';
import { REPO, WAVE_FIXTURE, collectEnvelopes, servoEvents, uartEvents, type Collector } from './helpers.js';

const teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

/** Start a bridge on ephemeral ports, replaying `fixture` as fast as it can. */
async function startReplayBridge(overrides: Parameters<typeof defaultConfig>[0] = {}) {
  const bridge = new SesameBridge(
    defaultConfig({
      uartPort: 0,
      wsPort: 0,
      // The fixture is 3.7 s of choreography. speed 0 removes the waiting
      // entirely: this test is about ordering and values, not about proving
      // that setTimeout works.
      replay: { file: WAVE_FIXTURE, speed: 0, loop: false, loopGapMs: 0 },
      ...overrides,
    }),
  );
  const addresses = await bridge.start();
  teardown.push(() => bridge.stop());
  const client: Collector = await collectEnvelopes(addresses.ws.url);
  teardown.push(() => client.close());
  return { bridge, addresses, client };
}

/** The fixture's own lines, as ground truth for what SHOULD come out. */
function fixtureLines(): string[] {
  return fs
    .readFileSync(WAVE_FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { header?: unknown; line?: string })
    .filter((o) => typeof o.line === 'string')
    .map((o) => o.line!);
}

describe('R7 end-to-end: replay -> TCP -> bridge -> WebSocket', () => {
  it('delivers every fixture line as a typed event, in order', async () => {
    const { client } = await startReplayBridge();
    const expected = fixtureLines();

    await client.waitFor((e) => uartEvents(e).length >= expected.length, `${expected.length} uart events`);
    const events = uartEvents(client.envelopes);
    expect(events).toHaveLength(expected.length);

    // Envelope numbering must be a gapless run, or a client cannot detect loss.
    const ns = client.envelopes.map((e) => e.n);
    expect(ns).toEqual(ns.map((_, i) => i + 1));

    // The protocol parser's own sequence numbers, which are what a consumer
    // orders by, must be gapless too.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('reproduces the real runWavePose servo sequence, joint for joint', async () => {
    const { client } = await startReplayBridge();

    // Ground truth straight from the fixture text, independent of the parser.
    const wanted = fixtureLines()
      .filter((l) => l.startsWith('@SESAME servo '))
      .map((l) => {
        const [, , joint, deg] = l.split(' ');
        return { joint, angleDeg: Number(deg) };
      });
    expect(wanted.length).toBeGreaterThan(20);   // 29 in the shipped fixture

    await client.waitFor((e) => servoEvents(e).length >= wanted.length, `${wanted.length} servo events`);
    const got = servoEvents(client.envelopes).map((e) => ({ joint: e.joint, angleDeg: e.angleDeg }));
    expect(got).toEqual(wanted);

    // The wave is L3 flapping between 180 and 100 four times, then a stand pose.
    // Assert the shape, not just the count: a pipeline that dropped every other
    // event would still have "some" servo events.
    const l3 = got.filter((s) => s.joint === 'L3').map((s) => s.angleDeg);
    expect(l3.join(',')).toContain('180,100,180,100,180,100,180,100');

    for (const s of got) {
      expect(JOINT_ORDER).toContain(s.joint);
      expect(s.angleDeg).toBeGreaterThanOrEqual(0);
      expect(s.angleDeg).toBeLessThanOrEqual(180);
    }
  });

  it('keeps the boot banner, the face changes and the plain log text interleaved correctly', async () => {
    const { client } = await startReplayBridge();
    await client.waitFor((e) => uartEvents(e).length >= fixtureLines().length, 'the whole fixture');
    const events = uartEvents(client.envelopes);

    expect(events[0]?.type).toBe('protocol.hello');

    // `WAVE` and `STAND` are plain Serial.println output in firmware. They must
    // arrive as log events on channel `uart`, not be swallowed.
    const uartLogs = events.filter((e) => e.type === 'log' && e.channel === 'uart').map((e) => (e as { text: string }).text);
    expect(uartLogs).toContain('WAVE');
    expect(uartLogs).toContain('STAND');

    const faces = events.filter((e) => e.type === 'face.expression').map((e) => (e as { name: string }).name);
    expect(faces).toEqual(['wave', 'idle']);

    // Nothing may fall through to protocol.unknown: if the fixture and the
    // parser disagree about the grammar, this is where it shows.
    expect(events.filter((e) => e.type === 'protocol.unknown')).toEqual([]);
  });

  it('labels a replayed stream as simulated when asked, and never upgrades it', async () => {
    // The default for --replay is `simulated`; defaultConfig() is the library
    // default (`observed`), so set it explicitly here.
    const { client } = await startReplayBridge({ defaultProvenance: 'simulated' });
    await client.waitFor((e) => servoEvents(e).length >= 5, 'some servo events');
    for (const event of uartEvents(client.envelopes)) {
      expect(event.provenance).toBe('simulated');
    }
  });

  it('reports its own lifecycle on a separate origin and sequence space', async () => {
    const { client } = await startReplayBridge();
    await client.waitFor((e) => servoEvents(e).length >= 5, 'some servo events');

    const bridgeEvents = client.envelopes.filter((e) => e.origin === 'bridge').map((e) => e.event);
    expect(bridgeEvents.length).toBeGreaterThan(0);
    for (const event of bridgeEvents) {
      expect(event.type).toBe('log');
      expect((event as { channel: string }).channel).toBe('emulator');
    }
    expect(bridgeEvents.map((e) => e.seq)).toEqual(bridgeEvents.map((_, i) => i));
    expect(bridgeEvents.some((e) => (e as { text: string }).text.includes('uart connected'))).toBe(true);
  });

  it('hands a late-joining client the backlog it missed', async () => {
    const { bridge, addresses, client } = await startReplayBridge();
    await client.waitFor((e) => uartEvents(e).length >= fixtureLines().length, 'the whole fixture');

    // Second client connects after everything has already happened. Without the
    // ring buffer it would see an empty screen forever, because a finished
    // movement produces no further events.
    const late = await collectEnvelopes(addresses.ws.url);
    teardown.push(() => late.close());
    await late.waitFor((e) => servoEvents(e).length >= 20, 'backlog replay');

    expect(servoEvents(late.envelopes).map((s) => s.angleDeg)).toEqual(
      servoEvents(client.envelopes).map((s) => s.angleDeg),
    );
    expect(bridge.buffered.length).toBeGreaterThan(20);
  });

  it('serves the debug viewer from the same origin as the socket', async () => {
    const { addresses } = await startReplayBridge({
      serveViewer: true,
      viewerDir: path.join(REPO, 'debug-viewer'),
    });
    const res = await fetch(`http://${addresses.ws.host}:${addresses.ws.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The viewer must carry the firmware joint order, not an alphabetical one.
    expect(html).toContain("['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']");
    expect(html).toContain('THIS IS A THROWAWAY');

    const escape = await fetch(`http://${addresses.ws.host}:${addresses.ws.port}/../../package.json`);
    expect([403, 404]).toContain(escape.status);
  });

  it('shuts down cleanly, releasing both ports', async () => {
    const bridge = new SesameBridge(
      defaultConfig({
        uartPort: 0,
        wsPort: 0,
        replay: { file: WAVE_FIXTURE, speed: 0, loop: true, loopGapMs: 0 },
      }),
    );
    const addresses = await bridge.start();
    const client = await collectEnvelopes(addresses.ws.url);
    await client.waitFor((e) => servoEvents(e).length >= 5, 'some servo events');
    client.close();

    await bridge.stop();
    await expect(fetch(`http://${addresses.ws.host}:${addresses.ws.port}/`)).rejects.toThrow();
    // Stopping twice must not throw: shutdown paths get called from signal
    // handlers and from tests, sometimes both.
    await bridge.stop();
  });
});
