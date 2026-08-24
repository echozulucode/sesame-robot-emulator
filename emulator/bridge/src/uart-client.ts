/**
 * The UART side: a reconnecting TCP client.
 *
 * This is the *only* place the bridge knows where telemetry comes from, and it
 * is deliberately ignorant of which backend is on the other end. Renode's
 * `emulation CreateServerSocketTerminal <port> "term" false` is a TCP server;
 * the replay harness is also a TCP server, on the same host and port, speaking
 * the same bytes. Path A and Path B therefore exercise byte-for-byte the same
 * client code — which is what makes the contract test between them meaningful
 * rather than a comparison of two different programs.
 *
 * Note the `false` in that Renode command: it is `telnetMode`, and with it true
 * the stream gets IAC negotiation bytes spliced in. R1 established `false`, and
 * the protocol parser strips IAC anyway, but this client does not try to be
 * clever about it — framing happens downstream, on bytes.
 */
import net from 'node:net';
import { Backoff } from './backoff.js';
import type { BackoffConfig } from './config.js';

export interface UartClientHandlers {
  /** Raw bytes, in arrival order. No framing is done here. */
  onData(chunk: Buffer): void;
  /** Socket established. `attempt` is 0 on the first success after a reset. */
  onUp(info: { host: string; port: number; attempt: number }): void;
  /** Socket lost or refused. `retryInMs` is null when the client is stopping. */
  onDown(info: { reason: string; attempt: number; retryInMs: number | null }): void;
}

export interface UartClientOptions {
  readonly host: string;
  readonly port: number;
  readonly backoff: BackoffConfig;
  readonly handlers: UartClientHandlers;
}

export class UartClient {
  #socket: net.Socket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #connected = false;
  readonly #backoff: Backoff;

  constructor(private readonly options: UartClientOptions) {
    this.#backoff = new Backoff(options.backoff);
  }

  get connected(): boolean {
    return this.#connected;
  }

  /**
   * Write bytes back to the device — protocol v2's host -> device direction.
   *
   * v1 was device -> host only, and this client had no send path at all. It has
   * one now because the firmware's serial console lives on the same UART0 the
   * telemetry leaves by, so "the other direction" needs no second transport and
   * no second socket: it is the same TCP connection, written to.
   *
   * Returns false when there is nothing connected. Deliberately not an error
   * and not a queue: a command issued while the emulator is down is a command
   * the robot never heard, and buffering it to deliver on reconnect would
   * silently run a movement minutes after someone asked for it.
   */
  write(data: string | Uint8Array): boolean {
    const socket = this.#socket;
    if (socket === null || !this.#connected) return false;
    return socket.write(data);
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  /** Idempotent. Cancels any pending retry and destroys the socket. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    if (this.#connected) {
      this.#connected = false;
      this.options.handlers.onDown({ reason: 'stopped', attempt: this.#backoff.attempt, retryInMs: null });
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    const { host, port, handlers } = this.options;

    const socket = net.createConnection({ host, port });
    this.#socket = socket;
    socket.setNoDelay(true);

    socket.once('connect', () => {
      this.#connected = true;
      const attempt = this.#backoff.attempt;
      this.#backoff.reset();
      handlers.onUp({ host, port, attempt });
    });

    socket.on('data', (chunk: Buffer) => handlers.onData(chunk));

    // 'error' and 'close' both fire for a refused connection; only the first
    // one through may schedule a retry, or the backoff doubles twice per failure.
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      const wasConnected = this.#connected;
      this.#connected = false;
      socket.removeAllListeners();
      socket.destroy();
      if (this.#socket === socket) this.#socket = null;
      if (this.#stopped) return;
      // A clean disconnect after a good session should retry promptly rather
      // than inheriting the backoff from whenever we last had trouble.
      if (wasConnected) this.#backoff.reset();
      const delay = this.#backoff.next();
      // Arm the retry BEFORE notifying. A handler is allowed to decide there is
      // nothing left to reconnect to and call stop() — and stop() can only
      // cancel a timer that already exists.
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#connect();
      }, delay);
      this.#timer.unref?.();
      handlers.onDown({ reason, attempt: this.#backoff.attempt, retryInMs: delay });
    };

    socket.on('error', (err: Error) => fail(err.message));
    socket.on('close', () => fail('closed'));
    socket.on('end', () => fail('remote ended'));
  }
}
