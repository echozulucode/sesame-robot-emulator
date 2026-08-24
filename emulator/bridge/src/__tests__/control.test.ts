/**
 * The host → device control channel: that it is off, that it is loopback-only,
 * and that nothing arbitrary can reach the UART.
 *
 * The first test in this file is the most important one in it. v1's hub
 * discarded client messages on purpose, and the risk in adding a second
 * protocol direction is not that the new path is wrong — it is that the old
 * default quietly stops being the default. So the default is asserted first and
 * end-to-end, with a real socket, before anything about the new path is tested
 * at all.
 */
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { SesameBridge } from '../bridge.js';
import { ConfigError, defaultConfig, parseArgs } from '../config.js';
import { decodeControlMessage, isLoopbackPeer } from '../control.js';

const LOCAL = '127.0.0.1';

/** Open a client, run `body`, always tidy up. */
async function withClient(
  url: string,
  body: (socket: WebSocket, received: unknown[]) => Promise<void>,
): Promise<void> {
  const socket = new WebSocket(url);
  const received: unknown[] = [];
  socket.on('message', (data) => {
    received.push(JSON.parse(data.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  try {
    await body(socket, received);
  } finally {
    socket.close();
  }
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the v1 default: client messages are discarded', () => {
  it('a bridge without --allow-control ignores anything a client sends', async () => {
    const bridge = new SesameBridge(
      defaultConfig({ uartPort: 0, wsPort: 0, verbose: false, uartHost: LOCAL }),
    );
    const addresses = await bridge.start();
    try {
      await withClient(addresses.ws.url, async (socket) => {
        socket.send(JSON.stringify({ v: 2, type: 'command', command: { type: 'movement.run', command: 'wave' } }));
        socket.send('anything at all');
        await settle();
      });
      // Nothing about the message appears anywhere — not accepted, and not even
      // logged as refused, because the handler is never wired up.
      const text = bridge.buffered
        .map((e) => (e.event.type === 'log' ? e.event.text : ''))
        .join('\n');
      expect(text).not.toMatch(/control/);
    } finally {
      await bridge.stop();
    }
  });

  it('allowControl defaults to false', () => {
    expect(defaultConfig().allowControl).toBe(false);
    const parsed = parseArgs([]);
    expect(parsed).not.toBe('help');
    if (parsed !== 'help') expect(parsed.allowControl).toBe(false);
  });
});

describe('opting in', () => {
  it('--allow-control turns it on', () => {
    const parsed = parseArgs(['--allow-control']);
    expect(parsed).not.toBe('help');
    if (parsed !== 'help') expect(parsed.allowControl).toBe(true);
  });

  it('refuses --allow-control together with --allow-remote', () => {
    // An unauthenticated control API bound to 0.0.0.0 is not a configuration
    // anyone means to ask for, so it is refused rather than warned about.
    expect(() => parseArgs(['--allow-control', '--allow-remote'])).toThrow(ConfigError);
    expect(() => parseArgs(['--allow-remote', '--allow-control'])).toThrow(
      /loopback-only by construction/,
    );
  });

  it('an enabled bridge logs what it did with a command, on the telemetry stream', async () => {
    const bridge = new SesameBridge(
      defaultConfig({ uartPort: 0, wsPort: 0, verbose: false, uartHost: LOCAL, allowControl: true }),
    );
    const addresses = await bridge.start();
    try {
      await withClient(addresses.ws.url, async (socket) => {
        socket.send(
          JSON.stringify({ v: 2, type: 'command', command: { type: 'movement.run', command: 'wave' } }),
        );
        await settle();
      });
      const text = bridge.buffered
        .map((e) => (e.event.type === 'log' ? e.event.text : ''))
        .join('\n');
      // No UART is attached in this test, so the honest outcome is "dropped" —
      // and it is still announced, because a command that did not reach the
      // robot is exactly the thing a caller must not have to guess about.
      expect(text).toMatch(/control dropped, no uart connection: "rn wv"/);
    } finally {
      await bridge.stop();
    }
  });

  it('refuses a command the firmware could not run, and says why', async () => {
    const bridge = new SesameBridge(
      defaultConfig({ uartPort: 0, wsPort: 0, verbose: false, uartHost: LOCAL, allowControl: true }),
    );
    const addresses = await bridge.start();
    try {
      await withClient(addresses.ws.url, async (socket) => {
        socket.send(
          JSON.stringify({ v: 2, type: 'command', command: { type: 'movement.run', command: 'moonwalk' } }),
        );
        socket.send('{not json');
        socket.send(JSON.stringify({ v: 1, type: 'command' }));
        await settle();
      });
      const text = bridge.buffered
        .map((e) => (e.event.type === 'log' ? e.event.text : ''))
        .join('\n');
      expect(text).toMatch(/control refused \(unknown-movement\)/);
      expect(text).toMatch(/control refused: not JSON/);
      expect(text).toMatch(/control refused: expected v:2/);
    } finally {
      await bridge.stop();
    }
  });
});

describe('decodeControlMessage', () => {
  const good = JSON.stringify({
    v: 2,
    type: 'command',
    command: { type: 'movement.run', command: 'wave' },
  });

  it('accepts a well-formed command from loopback', () => {
    const outcome = decodeControlMessage(good, '127.0.0.1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.encoded.line).toBe('rn wv');
      expect(outcome.encoded.branch).toBe('rn-wv');
    }
  });

  it('refuses a peer that is not loopback, however well-formed the message', () => {
    for (const peer of ['192.168.1.20', '10.0.0.5', '::ffff:8.8.8.8', undefined]) {
      const outcome = decodeControlMessage(good, peer);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/not loopback/);
    }
  });

  it('knows loopback in every spelling Node produces', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    // An unknown peer is untrusted, not trusted-by-default.
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  it('has no raw-text escape hatch', () => {
    // The only thing that reaches the UART is `encodeCommand`'s output, so a
    // client cannot post a line that lands on a dispatch branch nobody modelled
    // — and cannot post one long enough to be truncated into a different one.
    const attempts = [
      { v: 2, type: 'command', command: { type: 'raw', line: 'subtrim reset' } },
      { v: 2, type: 'command', command: 'subtrim reset' },
      { v: 2, type: 'command', command: { type: 'face.set', name: 'x'.repeat(400) } },
      { v: 2, type: 'command', command: { type: 'servo.set', joint: 'R1', angleDeg: 9999 } },
      { v: 2, type: 'command', command: { type: 'servo.set', joint: 'ZZ', angleDeg: 90 } },
    ];
    const lines = attempts.map((a) => {
      const outcome = decodeControlMessage(JSON.stringify(a), '127.0.0.1');
      return outcome.ok ? outcome.encoded.line : `REFUSED: ${outcome.reason}`;
    });
    // Only one of the five gets through, and only because it is a legal command
    // once sanitised: the over-long face name becomes a 26-byte `fc` line. The
    // other four are refused, including a `{type:'raw'}` that would otherwise
    // have been a straight text-injection route to the UART.
    expect(lines[0]).toMatch(/^REFUSED: control refused \(not-expressible\)/);
    expect(lines[1]).toMatch(/^REFUSED: .*SesameCommand/);
    expect(lines[2]).toBe(`fc ${'x'.repeat(23)}`);
    expect(lines[3]).toMatch(/^REFUSED: control refused \(bad-angle\)/);
    expect(lines[4]).toMatch(/^REFUSED: control refused \(bad-joint\)/);
  });

  it('refuses an oversized message before parsing it', () => {
    const outcome = decodeControlMessage('x'.repeat(5000), '127.0.0.1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/too large/);
  });
});
