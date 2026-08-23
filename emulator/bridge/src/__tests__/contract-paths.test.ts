/**
 * The Path A / Path B contract.
 *
 * The claim the whole architecture rests on is that the emulator and the replay
 * harness are *interchangeable backends*: identical telemetry through either one
 * produces identical WebSocket output. If that is not true, Phase 1 cannot be
 * written against the harness and later re-pointed at Renode "with zero
 * architecture change" — it would need a second code path, and the seam would be
 * fiction.
 *
 * Three cases, and they are deliberately not the same strength:
 *
 *   B1  the replay server, playing the fixture with realistic per-timestamp
 *       batching — the shipped Path B.
 *   B2  a raw socket that dumps the identical bytes in ONE write, then in
 *       one-byte dribbles. Different backend, wildly different chunking, same
 *       bytes. This is the substitutable-backend property under test, and it is
 *       provable today.
 *   A   real Renode: the R3 probe running on the emulated ESP32-S2, writing to
 *       the ESP32_UART model, out through a socket terminal. PROVEN — it passes.
 *       It is opt-in (`SESAME_PATH_A=1`) only because spawning Renode costs ~20 s
 *       and the checked-in .resc hard-codes TCP 3456, so a concurrent run would
 *       collide on the port and report a confusing failure instead of a skip.
 *
 * B1 == B2 alone would only prove that the bridge's output depends on the byte
 * stream and nothing else — necessary, but not the claim. Case A closes it: the
 * same telemetry, produced once by an emulated Xtensa core writing UART MMIO and
 * once by a plain `socket.end(payload)`, yields byte-identical WebSocket output.
 */
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SesameBridge } from '../bridge.js';
import { defaultConfig } from '../config.js';
import type { TelemetryEnvelope } from '../envelope.js';
import { WAVE_FIXTURE, collectEnvelopes, uartEvents } from './helpers.js';
import { pathAMode, pathAPort, pathASkipReason, r3ProbeLines, startRenode } from './path-a-renode.js';

const teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()!();
});

/** The exact bytes the fixture puts on the wire. */
function fixtureBytes(): string {
  return (
    fs
      .readFileSync(WAVE_FIXTURE, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { line?: string })
      .filter((o) => typeof o.line === 'string')
      .map((o) => o.line!)
      .join('\n') + '\n'
  );
}

/**
 * Everything a consumer is entitled to rely on, with the two things that
 * legitimately differ between runs removed: wall-clock arrival time, and the
 * envelope index (which counts bridge lifecycle events, and those differ by
 * construction between a replay server and a live emulator).
 */
function comparable(envelopes: readonly TelemetryEnvelope[]) {
  return uartEvents(envelopes);
}

async function runBridgeAgainst(port: number) {
  const bridge = new SesameBridge(
    defaultConfig({
      uartPort: port,
      wsPort: 0,
      defaultProvenance: 'observed',    // identical on both sides, on purpose
      reconnect: { initialMs: 20, maxMs: 60, factor: 2, jitter: 0 },
    }),
  );
  const addresses = await bridge.start();
  teardown.push(() => bridge.stop());
  const client = await collectEnvelopes(addresses.ws.url);
  teardown.push(() => client.close());
  return { bridge, client };
}

/** Path B, as shipped: the ReplayServer hosting the fixture. */
async function pathB_replayServer(): Promise<TelemetryEnvelope[]> {
  const bridge = new SesameBridge(
    defaultConfig({
      uartPort: 0,
      wsPort: 0,
      defaultProvenance: 'observed',
      replay: { file: WAVE_FIXTURE, speed: 0, loop: false, loopGapMs: 0 },
    }),
  );
  const addresses = await bridge.start();
  teardown.push(() => bridge.stop());
  const client = await collectEnvelopes(addresses.ws.url);
  teardown.push(() => client.close());
  const expected = fixtureBytes().trimEnd().split('\n').length;
  await client.waitFor((e) => uartEvents(e).length >= expected, `${expected} events (replay server)`);
  return client.envelopes;
}

/** A different backend entirely: a raw socket with a caller-chosen write pattern. */
async function pathB_rawSocket(write: (socket: net.Socket, payload: string) => void): Promise<TelemetryEnvelope[]> {
  const payload = fixtureBytes();
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    write(socket, payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;

  const { client } = await runBridgeAgainst(port);
  const expected = payload.trimEnd().split('\n').length;
  await client.waitFor((e) => uartEvents(e).length >= expected, `${expected} events (raw socket)`);
  return client.envelopes;
}

describe('Path A / Path B contract', () => {
  it('Path B is proven: the fixture arrives as typed telemetry', async () => {
    const events = comparable(await pathB_replayServer());
    expect(events.length).toBeGreaterThan(30);
    expect(events[0]?.type).toBe('protocol.hello');
    expect(events.filter((e) => e.type === 'servo.target')).toHaveLength(29);
    expect(events.filter((e) => e.type === 'protocol.unknown')).toEqual([]);
  });

  it('two different backends emitting the same bytes produce identical output', async () => {
    const viaReplayServer = comparable(await pathB_replayServer());
    // One giant write: no relationship at all to the fixture's timestamps.
    const viaOneWrite = comparable(await pathB_rawSocket((socket, payload) => socket.end(payload)));
    expect(viaOneWrite).toEqual(viaReplayServer);
  });

  it('is immune to the chunking the backend happens to use', async () => {
    const viaReplayServer = comparable(await pathB_replayServer());
    // The pathological case: one byte per write, which is roughly what a slow
    // emulated UART looks like from the host side.
    const viaDribble = comparable(
      await pathB_rawSocket((socket, payload) => {
        let i = 0;
        const tick = (): void => {
          if (socket.destroyed) return;
          if (i >= payload.length) {
            socket.end();
            return;
          }
          socket.write(payload[i++]!);
          setImmediate(tick);
        };
        tick();
      }),
    );
    expect(viaDribble).toEqual(viaReplayServer);
  });
});

// ---------------------------------------------------------------------------
// Path A — real Renode.
// ---------------------------------------------------------------------------
const mode = pathAMode();

describe('Path A — Renode emulated UART', () => {
  it.skipIf(mode === null)(
    `produces byte-identical WebSocket output to Path B for the same telemetry [${
      mode ?? pathASkipReason()
    }]`,
    async () => {
      // The probe's lines, read out of its C source rather than retyped — a
      // hard-coded copy here would agree with a typo in the probe.
      const probeLines = r3ProbeLines();
      const payload = probeLines.join('');

      // --- Path A: Renode -> emulated UART0 -> TCP -----------------------
      let renode: Awaited<ReturnType<typeof startRenode>> | null = null;
      if (mode === 'spawn') {
        renode = await startRenode();
        teardown.push(() => renode!.stop());
      }

      const { client: aClient } = await runBridgeAgainst(pathAPort());
      // The socket terminal has no backlog: only run the machine once the
      // bridge's client is attached, or the first lines are simply lost.
      await new Promise((r) => setTimeout(r, 1500));
      renode?.monitor('emulation RunFor "0.05"');

      await aClient.waitFor(
        (e) => uartEvents(e).length >= probeLines.length,
        `${probeLines.length} events from Renode`,
        60_000,
      );
      const viaRenode = comparable(aClient.envelopes);

      // --- Path B: the same bytes, from a plain socket --------------------
      const server = net.createServer((socket) => {
        socket.on('error', () => socket.destroy());
        socket.end(payload);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const { client: bClient } = await runBridgeAgainst((server.address() as net.AddressInfo).port);
      await bClient.waitFor((e) => uartEvents(e).length >= probeLines.length, 'the same events from Path B');
      const viaReplay = comparable(bClient.envelopes);

      // THE contract: identical telemetry, two backends, identical output.
      expect(viaRenode).toEqual(viaReplay);
      expect(viaRenode.some((e) => e.type === 'servo.target')).toBe(true);
      expect(viaRenode.filter((e) => e.type === 'protocol.unknown')).toEqual([]);
    },
    150_000,
  );
});
