/**
 * Test helpers shared by the bridge suites.
 *
 * The important one is {@link collectEnvelopes}: it uses Node's *built-in*
 * WebSocket client, not the `ws` client the server side happens to use. Testing
 * a `ws` server with a `ws` client would leave a whole class of protocol bugs
 * invisible, and the real consumer is a browser, which is a third implementation
 * again — the built-in client is the closest stand-in available in-process.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TelemetryEnvelope } from '../envelope.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const WAVE_FIXTURE = path.join(REPO, 'emulator/bridge/fixtures/wave-pose.replay.jsonl');

export interface Collector {
  readonly envelopes: TelemetryEnvelope[];
  /** Resolves when `predicate` holds, or rejects on timeout with what was seen. */
  waitFor(predicate: (envelopes: TelemetryEnvelope[]) => boolean, label: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Connect a WebSocket client and accumulate every envelope it receives. */
export async function collectEnvelopes(url: string): Promise<Collector> {
  const socket = new WebSocket(url);
  const envelopes: TelemetryEnvelope[] = [];
  const waiters: { check: () => boolean; resolve: () => void }[] = [];

  socket.addEventListener('message', (event) => {
    envelopes.push(JSON.parse(String(event.data)) as TelemetryEnvelope);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.check()) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`websocket failed to open: ${url}`)), { once: true });
  });

  return {
    envelopes,
    waitFor(predicate, label, timeoutMs = 15_000) {
      if (predicate(envelopes)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out after ${timeoutMs} ms waiting for ${label}; ` +
                `saw ${envelopes.length} envelopes, last = ${JSON.stringify(envelopes.at(-1)?.event ?? null)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          check: () => predicate(envelopes),
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    close() {
      socket.close();
    },
  };
}

/** Events that came from the UART side, i.e. everything the robot "said". */
export const uartEvents = (envelopes: readonly TelemetryEnvelope[]) =>
  envelopes.filter((e) => e.origin === 'uart').map((e) => e.event);

export const servoEvents = (envelopes: readonly TelemetryEnvelope[]) =>
  uartEvents(envelopes).filter((e): e is Extract<typeof e, { type: 'servo.target' }> => e.type === 'servo.target');
