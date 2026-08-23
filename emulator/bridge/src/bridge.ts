/**
 * The bridge itself: UART socket -> `@SESAME` parser -> typed telemetry ->
 * WebSocket.
 *
 * Everything interesting is in the seams, not here. This class owns three
 * objects — a reconnecting TCP client, a streaming parser, and a WebSocket hub —
 * and its whole job is to keep them wired together and to say out loud, on the
 * same stream, when any of them changes state.
 *
 * Two rules it enforces:
 *
 * 1. **The parser instance survives reconnects.** It holds a partial line and a
 *    sequence counter; throwing it away on a socket blip would renumber the
 *    stream and lose the half-line that was in flight. It is reset only when the
 *    bridge itself restarts.
 * 2. **Bridge lifecycle never enters the robot's sequence space.** See
 *    `envelope.ts` for why.
 */
import path from 'node:path';
import { SesameTelemetryParser, type LogEvent, type SesameTelemetry } from '@sesame-lab/sesame-protocol';
import type { BridgeConfig } from './config.js';
import { WS_ENVELOPE_VERSION, type EnvelopeOrigin, type TelemetryEnvelope } from './envelope.js';
import { UartClient } from './uart-client.js';
import { WsHub } from './ws-hub.js';
import { loadFixture, ReplayServer, type ReplayFixture } from './replay-server.js';

export interface BridgeAddresses {
  /** What the bridge connected (or will connect) to. */
  readonly uart: { host: string; port: number };
  /** Where clients connect. */
  readonly ws: { host: string; port: number; url: string };
  /** Present only in `--replay` mode. */
  readonly replay: { file: string; lines: number; durationMs: number } | null;
}

export class SesameBridge {
  readonly config: BridgeConfig;
  readonly #parser: SesameTelemetryParser;
  #hub: WsHub | null = null;
  #uart: UartClient | null = null;
  #replayServer: ReplayServer | null = null;
  #fixture: ReplayFixture | null = null;
  #envelopeIndex = 0;
  /** Set when a non-looping replay has played out: there is nothing left to reconnect to. */
  #replayFinished = false;
  #bridgeSeq = 0;
  #addresses: BridgeAddresses | null = null;
  #started = false;
  readonly #listeners = new Set<(e: TelemetryEnvelope) => void>();

  constructor(config: BridgeConfig) {
    this.config = config;
    this.#parser = new SesameTelemetryParser({ defaultProvenance: config.defaultProvenance });
  }

  /** Everything the bridge has emitted, most recent last, capped at `bufferSize`. */
  get buffered(): readonly TelemetryEnvelope[] {
    return this.#hub?.buffered ?? [];
  }

  get addresses(): BridgeAddresses | null {
    return this.#addresses;
  }

  /** In-process tap, for tests and for embedding. Returns an unsubscribe. */
  onEnvelope(listener: (e: TelemetryEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<BridgeAddresses> {
    if (this.#started) throw new Error('bridge already started');
    this.#started = true;
    const cfg = this.config;

    const hub = new WsHub({
      host: cfg.wsHost,
      port: cfg.wsPort,
      bufferSize: cfg.bufferSize,
      staticDir: cfg.serveViewer ? path.resolve(cfg.viewerDir) : null,
      onClientCount: (count) => this.#lifecycle(`${count} viewer client${count === 1 ? '' : 's'} connected`),
    });
    this.#hub = hub;
    const wsPort = await hub.listen();

    // The replay server must be listening BEFORE the client starts, or the first
    // connect attempt burns a backoff interval for no reason.
    let uartPort = cfg.uartPort;
    if (cfg.replay) {
      const fixture = loadFixture(cfg.replay.file);
      this.#fixture = fixture;
      const server = new ReplayServer({
        host: cfg.uartHost,
        port: cfg.uartPort,
        fixture,
        config: cfg.replay,
        onPass: (pass) => {
          this.#lifecycle(`replay pass ${pass} complete`);
          if (!cfg.replay?.loop) this.#replayFinished = true;
        },
      });
      this.#replayServer = server;
      uartPort = await server.listen();
    }

    this.#addresses = {
      uart: { host: cfg.uartHost, port: uartPort },
      ws: { host: cfg.wsHost, port: wsPort, url: `ws://${displayHost(cfg.wsHost)}:${wsPort}/telemetry` },
      replay: cfg.replay && this.#fixture
        ? { file: cfg.replay.file, lines: this.#fixture.lines.length, durationMs: this.#fixture.durationMs }
        : null,
    };

    this.#lifecycle(
      `bridge up: uart tcp://${cfg.uartHost}:${uartPort} -> ${this.#addresses.ws.url} ` +
        `(default provenance ${cfg.defaultProvenance}${cfg.replay ? ', replay' : ''})`,
    );

    this.#uart = new UartClient({
      host: cfg.uartHost,
      port: uartPort,
      backoff: cfg.reconnect,
      handlers: {
        onData: (chunk) => this.#ingest(chunk),
        onUp: ({ host, port, attempt }) =>
          this.#lifecycle(
            `uart connected to ${host}:${port}${attempt > 0 ? ` after ${attempt} failed attempt${attempt === 1 ? '' : 's'}` : ''}`,
          ),
        onDown: ({ reason, attempt, retryInMs }) => {
          // Flush whatever the parser was holding: a socket that dies mid-line
          // has still delivered those bytes, and silently dropping them would
          // make the event stream depend on connection lifetime.
          this.#emitAll(this.#parser.flush(), 'uart');
          if (this.#replayFinished) {
            // A one-shot replay has ended. Retrying would either find nothing
            // or, worse, restart the fixture and turn "play once" into a loop.
            this.#lifecycle('replay complete; not reconnecting (pass --loop to repeat)');
            this.#uart?.stop();
            return;
          }
          this.#lifecycle(
            retryInMs === null
              ? `uart disconnected (${reason})`
              : `uart disconnected (${reason}); retry ${attempt} in ${retryInMs} ms`,
          );
        },
      },
    });
    this.#uart.start();

    return this.#addresses;
  }

  /** Idempotent, and safe to call before `start()`. */
  async stop(): Promise<void> {
    this.#uart?.stop();
    this.#uart = null;
    this.#emitAll(this.#parser.flush(), 'uart');
    this.#lifecycle('bridge shutting down');
    await this.#replayServer?.close();
    this.#replayServer = null;
    await this.#hub?.close();
    this.#hub = null;
    this.#started = false;
  }

  #ingest(chunk: Buffer): void {
    // Never let a malformed byte sequence take the process down: the parser
    // contract says it does not throw, and this is the belt to that's braces.
    let events: SesameTelemetry[];
    try {
      events = this.#parser.push(chunk);
    } catch (err) {
      this.#lifecycle(`parser threw on ${chunk.length} bytes: ${(err as Error).message}`);
      return;
    }
    this.#emitAll(events, 'uart');
  }

  #emitAll(events: readonly SesameTelemetry[], origin: EnvelopeOrigin): void {
    for (const event of events) this.#emit(event, origin);
  }

  #emit(event: SesameTelemetry, origin: EnvelopeOrigin): void {
    const envelope: TelemetryEnvelope = {
      v: WS_ENVELOPE_VERSION,
      n: ++this.#envelopeIndex,
      origin,
      tHostMs: Date.now(),
      event,
    };
    this.#hub?.broadcast(envelope);
    for (const listener of this.#listeners) listener(envelope);
  }

  /**
   * A bridge lifecycle message.
   *
   * Channel `emulator`, because the protocol reserves that channel for the
   * harness rather than the device. Provenance `observed`, deliberately: the
   * bridge really did watch its own socket open and close, and that is a fact
   * about the harness, not a claim about the robot. The robot-facing events it
   * wraps carry the stream's own provenance, which in replay mode is
   * `simulated` — so the two are never confused.
   */
  #lifecycle(text: string): void {
    const event: LogEvent = {
      type: 'log',
      seq: this.#bridgeSeq++,
      provenance: 'observed',
      channel: 'emulator',
      // The protocol re-splits a log body containing the sentinel (spec 3.2).
      // Bridge text is ours to control, so just make it impossible.
      text: text.replaceAll('@SESAME', '@_SESAME'),
    };
    this.#emit(event, 'bridge');
    if (this.config.verbose) process.stderr.write(`[bridge] ${text}\n`);
  }
}

function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}
