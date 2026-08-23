/**
 * Reconnection, on both sides.
 *
 * This matters more than it sounds for the Renode path. Renode's socket
 * terminal only exists while the emulation is running; `machine Reset`,
 * `Clear`, or simply restarting the .resc drops it. A bridge that had to be
 * restarted alongside it would make the whole interactive loop miserable — and
 * worse, would renumber the telemetry stream every time.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SesameBridge } from '../bridge.js';
import { defaultConfig } from '../config.js';
import { collectEnvelopes, servoEvents, uartEvents } from './helpers.js';

const teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

/** A stand-in for Renode's socket terminal: accepts one client, writes on demand. */
class FakeUartServer {
  readonly #server: net.Server;
  #socket: net.Socket | null = null;
  port = 0;
  connections = 0;

  constructor() {
    this.#server = net.createServer((socket) => {
      this.connections++;
      this.#socket = socket;
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        if (this.#socket === socket) this.#socket = null;
      });
    });
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.#server.listen(port, '127.0.0.1', () => {
        const addr = this.#server.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : port;
        resolve(this.port);
      });
    });
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  write(text: string): void {
    this.#socket?.write(text);
  }

  /** Yank the socket the way a stopped emulation would. */
  dropClient(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }

  close(): Promise<void> {
    this.dropClient();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

const FAST_BACKOFF = { initialMs: 20, maxMs: 80, factor: 2, jitter: 0 };

describe('UART-side reconnection', () => {
  it('retries a source that is not there yet, then connects when it appears', async () => {
    // Claim a port, then release it, so we know nothing is listening on it.
    const probe = new FakeUartServer();
    const port = await probe.listen();
    await probe.close();

    const bridge = new SesameBridge(
      defaultConfig({ uartPort: port, wsPort: 0, reconnect: FAST_BACKOFF }),
    );
    const addresses = await bridge.start();
    teardown.push(() => bridge.stop());
    const client = await collectEnvelopes(addresses.ws.url);
    teardown.push(() => client.close());

    const bridgeText = () =>
      client.envelopes
        .filter((e) => e.origin === 'bridge' && e.event.type === 'log')
        .map((e) => (e.event as { text: string }).text);

    await client.waitFor(() => bridgeText().some((t) => t.includes('retry')), 'a retry message');
    expect(bridgeText().some((t) => t.includes('uart disconnected'))).toBe(true);

    // Now bring the source up on that same port.
    const server = new FakeUartServer();
    await server.listen(port);
    teardown.push(() => server.close());

    await client.waitFor(() => bridgeText().some((t) => t.includes('uart connected')), 'connection');
    server.write('@SESAME servo R4 72\n');
    await client.waitFor((e) => servoEvents(e).length >= 1, 'a servo event');
    expect(servoEvents(client.envelopes)[0]).toMatchObject({ joint: 'R4', angleDeg: 72 });
  });

  it('survives the source going away mid-stream and keeps numbering the stream', async () => {
    const server = new FakeUartServer();
    const port = await server.listen();
    teardown.push(() => server.close());

    const bridge = new SesameBridge(
      defaultConfig({ uartPort: port, wsPort: 0, reconnect: FAST_BACKOFF }),
    );
    const addresses = await bridge.start();
    teardown.push(() => bridge.stop());
    const client = await collectEnvelopes(addresses.ws.url);
    teardown.push(() => client.close());

    await client.waitFor(() => server.connected, 'first connection');
    server.write('@SESAME servo R1 10\n@SESAME servo R2 20\n');
    await client.waitFor((e) => servoEvents(e).length >= 2, 'two servo events');

    // Half a line in flight when the socket dies. Those bytes were delivered;
    // dropping them would make the event stream depend on connection lifetime.
    server.write('@SESAME servo L1 3');
    await new Promise((r) => setTimeout(r, 30));
    server.dropClient();

    await client.waitFor((e) => servoEvents(e).length >= 3, 'the flushed partial line');
    expect(servoEvents(client.envelopes)[2]).toMatchObject({ joint: 'L1', angleDeg: 3 });

    await client.waitFor(() => server.connections >= 2, 'reconnection');
    server.write('@SESAME servo L2 40\n');
    await client.waitFor((e) => servoEvents(e).length >= 4, 'post-reconnect event');

    // The parser instance survives the reconnect, so `seq` keeps counting rather
    // than restarting at 0 and making two different events look like the same one.
    const seqs = uartEvents(client.envelopes).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(servoEvents(client.envelopes).map((s) => s.joint)).toEqual(['R1', 'R2', 'L1', 'L2']);
  });
});

describe('WebSocket-side reconnection', () => {
  it('replays the buffer to a client that dropped and came back', async () => {
    const server = new FakeUartServer();
    const port = await server.listen();
    teardown.push(() => server.close());

    const bridge = new SesameBridge(
      defaultConfig({ uartPort: port, wsPort: 0, reconnect: FAST_BACKOFF }),
    );
    const addresses = await bridge.start();
    teardown.push(() => bridge.stop());

    const first = await collectEnvelopes(addresses.ws.url);
    await client_waitConnected(server);
    server.write('@SESAME servo R1 11\n@SESAME servo R2 22\n');
    await first.waitFor((e) => servoEvents(e).length >= 2, 'two events');
    first.close();

    // Events that arrive while nobody is listening must not be lost.
    server.write('@SESAME servo L1 33\n');
    await new Promise((r) => setTimeout(r, 50));

    const second = await collectEnvelopes(addresses.ws.url);
    teardown.push(() => second.close());
    await second.waitFor((e) => servoEvents(e).length >= 3, 'the full backlog');
    expect(servoEvents(second.envelopes).map((s) => `${s.joint}=${s.angleDeg}`)).toEqual([
      'R1=11',
      'R2=22',
      'L1=33',
    ]);
  });

  it('evicts oldest-first when the buffer is smaller than the stream', async () => {
    const server = new FakeUartServer();
    const port = await server.listen();
    teardown.push(() => server.close());

    const bridge = new SesameBridge(
      defaultConfig({ uartPort: port, wsPort: 0, bufferSize: 5, reconnect: FAST_BACKOFF }),
    );
    const addresses = await bridge.start();
    teardown.push(() => bridge.stop());

    await client_waitConnected(server);
    for (let i = 0; i < 20; i++) server.write(`@SESAME servo R1 ${i}\n`);
    await new Promise((r) => setTimeout(r, 120));

    expect(bridge.buffered).toHaveLength(5);
    const late = await collectEnvelopes(addresses.ws.url);
    teardown.push(() => late.close());
    await late.waitFor((e) => e.length >= 5, 'the truncated backlog');
    // Last five servo values, i.e. the most recent state, which is what a
    // joining viewer actually needs.
    expect(servoEvents(late.envelopes).map((s) => s.angleDeg)).toEqual([15, 16, 17, 18, 19]);
  });
});

async function client_waitConnected(server: FakeUartServer): Promise<void> {
  for (let i = 0; i < 200 && !server.connected; i++) await new Promise((r) => setTimeout(r, 10));
  if (!server.connected) throw new Error('uart client never connected');
}
