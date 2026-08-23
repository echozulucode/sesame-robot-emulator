/**
 * Path B: the replay harness.
 *
 * It is a **TCP server**, not a file reader wired into the bridge's internals,
 * and that is the entire design. Renode exposes its UART as a TCP server; if the
 * replay path fed the parser directly it would prove that the parser works and
 * nothing else. By putting a socket in exactly the same place, Path B exercises
 * the reconnect logic, the chunk boundaries, the framing, the backpressure and
 * the WebSocket fan-out — every part of the pipeline except the emulator itself.
 *
 * The fixture is generated from real firmware choreography by
 * `scripts/build-replay-fixture.mjs`; see that file for what is and is not
 * modelled.
 */
import net from 'node:net';
import fs from 'node:fs';
import type { ReplayConfig } from './config.js';

export interface ReplayLine {
  /** Milliseconds from the start of the fixture. */
  readonly tMs: number;
  /** The line, without its terminator. */
  readonly line: string;
  readonly note?: string;
}

export interface ReplayFixture {
  readonly header: Record<string, unknown> | null;
  readonly lines: readonly ReplayLine[];
  readonly durationMs: number;
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

/**
 * Parse a fixture.
 *
 * Two accepted shapes:
 * - **`.jsonl`** — one JSON object per line. An optional first object with a
 *   `header` key carries provenance metadata; every other object is
 *   `{tMs, line}`.
 * - **anything else** — plain text, one `@SESAME` line per line, played at a
 *   fixed 20 ms spacing (the firmware's `motorCurrentDelay`). This is the
 *   "paste a captured serial log in and watch it" mode.
 */
export function parseFixture(text: string, { fixedSpacingMs = 20 } = {}): ReplayFixture {
  const raw = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const looksJsonl = raw.length > 0 && raw[0]!.trimStart().startsWith('{');

  if (!looksJsonl) {
    const lines = raw.map((line, i) => ({ tMs: i * fixedSpacingMs, line }));
    return { header: null, lines, durationMs: lines.at(-1)?.tMs ?? 0 };
  }

  let header: Record<string, unknown> | null = null;
  const lines: ReplayLine[] = [];
  for (const [i, text_] of raw.entries()) {
    let obj: unknown;
    try {
      obj = JSON.parse(text_);
    } catch {
      throw new ReplayError(`fixture line ${i + 1} is not valid JSON`);
    }
    if (typeof obj !== 'object' || obj === null) throw new ReplayError(`fixture line ${i + 1} is not an object`);
    const rec = obj as Record<string, unknown>;
    if (i === 0 && 'header' in rec) {
      header = rec.header as Record<string, unknown>;
      continue;
    }
    if (typeof rec.line !== 'string') throw new ReplayError(`fixture line ${i + 1} has no string 'line'`);
    const tMs = typeof rec.tMs === 'number' ? rec.tMs : (lines.at(-1)?.tMs ?? 0);
    if (tMs < (lines.at(-1)?.tMs ?? 0)) throw new ReplayError(`fixture line ${i + 1} goes backwards in time`);
    const entry: ReplayLine = typeof rec.note === 'string'
      ? { tMs, line: rec.line, note: rec.note }
      : { tMs, line: rec.line };
    lines.push(entry);
  }
  if (lines.length === 0) throw new ReplayError('fixture contains no replayable lines');
  return { header, lines, durationMs: lines.at(-1)!.tMs };
}

export function loadFixture(file: string): ReplayFixture {
  if (!fs.existsSync(file)) throw new ReplayError(`fixture not found: ${file}`);
  return parseFixture(fs.readFileSync(file, 'utf8'));
}

export interface ReplayServerOptions {
  readonly host: string;
  /** 0 for an ephemeral port; read the real one back from `port` after `listen()`. */
  readonly port: number;
  readonly fixture: ReplayFixture;
  readonly config: Pick<ReplayConfig, 'speed' | 'loop' | 'loopGapMs'>;
  /** Called once per completed pass of the fixture. */
  readonly onPass?: (pass: number) => void;
}

/** Serves one fixture to every client that connects, then ends the connection. */
export class ReplayServer {
  readonly #server: net.Server;
  #port = 0;
  #passes = 0;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: ReplayServerOptions) {
    this.#server = net.createServer((socket) => this.#play(socket));
    this.#server.on('error', () => {
      /* surfaced through listen()'s rejection; a late error must not crash the host */
    });
  }

  get port(): number {
    return this.#port;
  }

  /** Number of complete passes served so far, across all connections. */
  get passes(): number {
    return this.#passes;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once('error', onError);
      this.#server.listen(this.options.port, this.options.host, () => {
        this.#server.removeListener('error', onError);
        const addr = this.#server.address();
        this.#port = typeof addr === 'object' && addr !== null ? addr.port : this.options.port;
        resolve(this.#port);
      });
    });
  }

  async close(): Promise<void> {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #play(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.on('error', () => socket.destroy());

    const { fixture, config } = this.options;
    // speed 0 means "no waiting". Anything else scales fixture time.
    const scale = config.speed > 0 ? 1 / config.speed : 0;
    const startedAt = Date.now();
    let cursor = 0;
    let originMs = 0;

    const finishPass = (): void => {
      this.#passes++;
      if (!config.loop) {
        // Stop listening as well as ending the connection. Otherwise the
        // bridge's reconnect logic dials straight back in, gets served the
        // fixture again, and "play it once" quietly becomes an infinite loop
        // with a backoff-sized gap in it.
        this.#server.close();
        socket.end();
        this.options.onPass?.(this.#passes);
        return;
      }
      this.options.onPass?.(this.#passes);
      cursor = 0;
      originMs += fixture.durationMs + config.loopGapMs;
      schedule();
    };

    const schedule = (): void => {
      if (socket.destroyed) return;
      if (cursor >= fixture.lines.length) {
        finishPass();
        return;
      }
      const entry = fixture.lines[cursor]!;
      // Absolute schedule, not a per-step sleep: `tMs` is an offset from the
      // start of the fixture, so waiting `tMs - previousTMs` each time would let
      // timer overshoot accumulate across 400 steps.
      const delay = (originMs + entry.tMs) * scale - (Date.now() - startedAt);
      const emit = (): void => {
        if (socket.destroyed) return;
        // Emit every line that is due at this instant before yielding, so a
        // burst of same-timestamp lines really does arrive in one TCP segment —
        // the parser must handle both that and the opposite, and the fixture is
        // the place where both actually happen.
        let batch = '';
        const dueAt = entry.tMs;
        while (cursor < fixture.lines.length && fixture.lines[cursor]!.tMs === dueAt) {
          batch += `${fixture.lines[cursor]!.line}\n`;
          cursor++;
        }
        socket.write(batch);
        schedule();
      };
      if (delay <= 0) {
        // setImmediate rather than a direct call: unbounded recursion through a
        // 400-step fixture would blow the stack at speed 0.
        setImmediate(emit);
      } else {
        const t = setTimeout(() => {
          this.#timers.delete(t);
          emit();
        }, delay);
        this.#timers.add(t);
      }
    };

    schedule();
  }
}
