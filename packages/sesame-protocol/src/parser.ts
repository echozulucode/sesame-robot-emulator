/**
 * The streaming `@SESAME` parser.
 *
 * A UART is a byte stream. Lines arrive split at arbitrary offsets, interleaved
 * with ordinary `Serial.println` boot logging, and — if anyone ever forgets
 * `telnetMode: false` on the Renode socket terminal (see
 * `docs/findings/R1-renode-capability-audit.md` section 5.4) — with telnet IAC
 * negotiation bytes spliced into the middle of them.
 *
 * The single invariant this class exists to guarantee:
 *
 * > **The emitted event sequence depends only on the concatenated byte stream,
 * > never on how that stream was chopped into chunks.**
 *
 * Everything below follows from it:
 *
 * - Framing is decided on **bytes**, before any decoding, so a multi-byte UTF-8
 *   sequence or an IAC escape split across two `push()` calls cannot change the
 *   outcome.
 * - A trailing lone `CR` at the end of the buffer is **held**, not treated as a
 *   terminator, because the next byte might be `LF` and `CRLF` is one
 *   terminator. {@link SesameTelemetryParser.flush} resolves it at EOF.
 * - Oversized-line handling counts every discarded byte exactly once, so the
 *   `emulator` log event it produces reports the same total no matter where the
 *   overflow threshold happened to be crossed.
 */
import type { LogEvent, SesameTelemetry } from './events.js';
import {
  parseLine,
  resolveParseOptions,
  type LineParseState,
  type ResolvedParseOptions,
  type TelemetryParseOptions,
} from './wire.js';

const LF = 0x0a;
const CR = 0x0d;
const IAC = 0xff;

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

/** Anything the parser will accept as a chunk of the stream. */
export type TelemetryChunk = Uint8Array | ArrayBuffer | string;

/**
 * Incremental parser: feed it bytes, get typed events.
 *
 * ```ts
 * const parser = new SesameTelemetryParser({ defaultProvenance: 'observed' });
 * socket.on('data', (chunk) => {
 *   for (const event of parser.push(chunk)) handle(event);
 * });
 * socket.on('end', () => { for (const event of parser.flush()) handle(event); });
 * ```
 */
export class SesameTelemetryParser {
  readonly options: ResolvedParseOptions;

  #buffer: Uint8Array;
  #length = 0;
  #state: LineParseState;

  /** True while bytes of an oversized line are being thrown away. */
  #discarding = false;
  /** Bytes of the current oversized line already thrown away. */
  #discarded = 0;

  constructor(options: TelemetryParseOptions = {}) {
    this.options = resolveParseOptions(options);
    this.#buffer = new Uint8Array(Math.min(4096, this.options.maxLineBytes + 1));
    this.#state = { nextSeq: this.options.startSeq };
  }

  /** The `seq` the next event will get. */
  get nextSeq(): number {
    return this.#state.nextSeq;
  }

  /** Bytes currently held in the partial-line buffer. */
  get pendingBytes(): number {
    return this.#length;
  }

  /** Feed one chunk. Returns every event completed by it, in stream order. */
  push(chunk: TelemetryChunk): SesameTelemetry[] {
    this.#append(toBytes(chunk));
    return this.#drain(false);
  }

  /**
   * End of stream: emit any trailing partial line as if it had been terminated,
   * and resolve a held trailing `CR`. Safe to call more than once.
   */
  flush(): SesameTelemetry[] {
    return this.#drain(true);
  }

  /** Discard buffered bytes and reset the sequence counter. */
  reset(): void {
    this.#length = 0;
    this.#discarding = false;
    this.#discarded = 0;
    this.#state = { nextSeq: this.options.startSeq };
  }

  #append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const needed = this.#length + bytes.length;
    if (needed > this.#buffer.length) {
      let capacity = this.#buffer.length;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(bytes, this.#length);
    this.#length = needed;
  }

  #drain(final: boolean): SesameTelemetry[] {
    const events: SesameTelemetry[] = [];
    const buf = this.#buffer;
    let lineStart = 0;
    let i = 0;

    while (i < this.#length) {
      const byte = buf[i] as number;
      if (byte === CR) {
        // CRLF is one terminator. A CR at the very end of what we have is
        // ambiguous until the next byte arrives, so hold it — this is the whole
        // reason chunk boundaries cannot change the output.
        if (i + 1 >= this.#length && !final) break;
        const crlf = i + 1 < this.#length && buf[i + 1] === LF;
        this.#finishLine(events, buf.subarray(lineStart, i));
        lineStart = i + (crlf ? 2 : 1);
        i = lineStart;
        continue;
      }
      if (byte === LF) {
        this.#finishLine(events, buf.subarray(lineStart, i));
        lineStart = i + 1;
        i = lineStart;
        continue;
      }
      i++;
    }

    if (lineStart > 0) {
      buf.copyWithin(0, lineStart, this.#length);
      this.#length -= lineStart;
    }

    if (final) {
      if (this.#length > 0 || this.#discarding) {
        this.#finishLine(events, buf.subarray(0, this.#length));
        this.#length = 0;
      }
    } else if (this.#length > this.options.maxLineBytes) {
      this.#discarded += this.#length;
      this.#discarding = true;
      this.#length = 0;
    }

    return events;
  }

  #finishLine(events: SesameTelemetry[], bytes: Uint8Array): void {
    // The total is computed the same way whether the overflow threshold was
    // crossed mid-stream (many small chunks) or the whole oversized line
    // arrived at once, which is what keeps the output chunk-independent.
    const total = this.#discarded + bytes.length;
    if (this.#discarding || total > this.options.maxLineBytes) {
      this.#discarding = false;
      this.#discarded = 0;
      events.push(this.#overflowEvent(total));
      return;
    }
    const text = decodeLine(bytes);
    if (text.length === 0) return;
    for (const event of parseLine(text, this.options, this.#state)) events.push(event);
  }

  #overflowEvent(totalBytes: number): LogEvent {
    return {
      type: 'log',
      seq: this.#state.nextSeq++,
      // `observed` because the parser really did count these bytes; the claim
      // is about the harness, not about the robot. The origin is still the
      // stream's, so a consumer filtering on it does not lose the one event
      // that tells it data was dropped.
      provenance: 'observed',
      ...(this.options.defaultOrigin === undefined
        ? {}
        : { origin: this.options.defaultOrigin }),
      channel: 'emulator',
      text:
        `oversized line discarded: ${totalBytes} bytes with no line terminator ` +
        `(limit ${this.options.maxLineBytes})`,
    };
  }
}

/**
 * Convenience: run a whole byte stream through a fresh parser, including the
 * final flush. Useful for replay harnesses and tests, not for live sockets.
 */
export function parseTelemetryStream(
  stream: TelemetryChunk,
  options?: TelemetryParseOptions,
): SesameTelemetry[] {
  const parser = new SesameTelemetryParser(options);
  return [...parser.push(stream), ...parser.flush()];
}

function toBytes(chunk: TelemetryChunk): Uint8Array {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  return new Uint8Array(chunk);
}

/**
 * Turn one line's bytes into text the grammar can be run against.
 *
 * Three cleanups, in order:
 *
 * 1. **Telnet IAC removal.** R1 proved the Renode UART socket works, and warned
 *    that the socket terminal defaults to `telnetMode: true`, which injects
 *    `0xFF`-prefixed negotiation sequences into the stream. We strip them rather
 *    than trusting every operator to remember the flag. (An IAC option byte that
 *    happens to be `0x0A` will still split a line early; that is a documented
 *    limitation, not an inconsistency — line splitting stays chunk-independent.)
 * 2. **UTF-8 decode**, non-fatal, so undecodable bytes become U+FFFD.
 * 3. **Control and replacement character removal**, then trim. Whatever noise
 *    survived stops here instead of reaching the grammar.
 */
function decodeLine(bytes: Uint8Array): string {
  const filtered = stripTelnet(bytes);
  const decoded = decoder.decode(filtered);
  let out = '';
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '�') continue;
    out += ch;
  }
  return out.trim();
}

function stripTelnet(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(IAC)) return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== IAC) {
      out[n++] = bytes[i] as number;
      i++;
      continue;
    }
    const command = bytes[i + 1];
    if (command === undefined) {
      i++; // lone trailing IAC
    } else if (command >= 0xfb && command <= 0xfe) {
      i += 3; // IAC WILL/WONT/DO/DONT <option>
    } else if (command >= 0xf0 && command <= 0xfa) {
      i += 2; // IAC <command>
    } else {
      i += 2; // IAC IAC (escaped 0xFF) and anything else: drop both
    }
  }
  return out.subarray(0, n);
}
