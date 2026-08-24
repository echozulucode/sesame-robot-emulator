/**
 * One QEMU process, one UART0 socket, both directions.
 *
 * This is where every difference between an emulator backend and a host-side
 * model lives: a process that can die, a socket that can refuse, a guest that
 * can panic before it prints anything, and a Windows PID that must not be left
 * behind. `QemuSesameRobot` above it is then almost boring, which is the point.
 *
 * ## The three things this file is careful about
 *
 * **1. Attaching before the guest speaks.** Q1's demo slept a fixed 1500 ms and
 * then connected. That is long enough to miss the earliest panic entirely —
 * which is exactly the class of failure ISSUE-20260823-022 is about. Here the
 * client poll-connects from the instant QEMU is spawned, so the first bytes out
 * of the mask ROM are captured. (This is a *detection* fix, not the cause: see
 * `docs/findings/Q2-qemu-backend.md`. The panic backtraces resolve entirely
 * inside `nvs_flash_init` → `spi_flash_restore_cache` → `cache_hal_resume`,
 * with no UART involvement at all.)
 *
 * **2. Boot is verified, not assumed.** A session is only usable once the
 * firmware's own end-of-`setup()` banner has crossed the wire. Anything else —
 * a panic, a silent hang, a QEMU exit — fails the attempt, and
 * {@link launchWithRetry} starts a fresh process.
 *
 * **3. Teardown leaves nothing behind.** Every live session is in a
 * module-level registry with a `process.on('exit')` hook, because the failure
 * mode that matters on Windows is not a slow shutdown, it is a `qemu.exe`
 * holding a port after the test runner has gone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

import {
  BARRIER_COMMAND,
  BARRIER_MARKER,
  CLI_TERMINATOR,
  SesameTelemetryParser,
  type SesameTelemetry,
} from '@sesame-lab/sesame-protocol';

import { QEMU_ORIGIN, type ResolvedQemuOptions } from './config.js';
import {
  QemuArtifactMissingError,
  QemuBootFailedError,
  QemuCommandTimeoutError,
  QemuGuestPanicError,
} from './errors.js';

/**
 * The line the firmware prints at the very end of `setup()` —
 * `sesame-firmware-main.ino:749`, `bootOrder` step 20.
 *
 * Chosen over `@SESAME hello` because hello is emitted three statements into
 * `setup()` (deliberately, so a boot that dies on the OLED still identifies
 * itself), and the interesting failures happen *after* it. Six of the eight
 * baseline failures printed hello and then panicked.
 */
export const BOOT_BANNER = 'HTTP server & Captive Portal started.';

/**
 * Most bytes to put on the wire in one go.
 *
 * `UART_BUFFER_SIZE` in arduino-esp32's `HardwareSerial` is 256 by default, and
 * the console drains it one character per `loop()` iteration while stalling for
 * the whole of every servo delay. 192 leaves headroom without needing to know
 * exactly how far behind the reader is.
 */
export const MAX_BATCH_BYTES = 192;

/**
 * Guest death, as it appears on the wire.
 *
 * The first entry is ISSUE-20260823-022. The others are the ESP-IDF panic
 * handler's general vocabulary; catching them means a boot that fails some
 * other way fails fast instead of burning the whole boot timeout.
 */
export const PANIC_PATTERNS: readonly RegExp[] = Object.freeze([
  /Cache disabled but cached memory region accessed/,
  /Guru Meditation Error/,
  /assert failed:/,
  /rst:0x[0-9a-f]+ \(SW_CPU_RESET\)/,
]);

function firstPanic(text: string): string | null {
  for (const pattern of PANIC_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orphan protection
// ---------------------------------------------------------------------------

/**
 * Every session that has a live process.
 *
 * A `SIGKILL` from `dispose()` handles the normal path. This handles the one
 * that actually bites: a test file that throws, a Ctrl-C, an unhandled
 * rejection — anything that ends the Node process without unwinding. QEMU has
 * no children of its own, so killing the direct child is sufficient; there is
 * no process tree to walk.
 */
const LIVE_SESSIONS = new Set<QemuSession>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = (): void => {
    for (const session of LIVE_SESSIONS) session.killNow();
  };
  process.on('exit', killAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

/** PIDs of every QEMU process this module currently believes is alive. */
export function livePids(): readonly number[] {
  return [...LIVE_SESSIONS].map((s) => s.pid).filter((p): p is number => p !== undefined);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A live QEMU process with an attached, bidirectional UART0. */
export class QemuSession {
  readonly #options: ResolvedQemuOptions;
  readonly #parser: SesameTelemetryParser;
  readonly #listeners = new Set<(event: SesameTelemetry) => void>();

  #child: ChildProcess | null = null;
  #socket: net.Socket | null = null;
  #exited = false;
  #panic: string | null = null;
  /** Raw UART text, kept only far enough back to match a banner across chunks. */
  #tail = '';
  /** Completion barriers seen so far. See `BARRIER_COMMAND`. */
  #barriers = 0;
  #banner = false;
  /**
   * Every event this session has produced, in order.
   *
   * Boot itself is telemetry — `@SESAME hello`, the `rest` face `setup()` ends
   * with — and a caller that could only subscribe once `start()` had returned
   * would miss all of it. Retrying complicates that further: a subscriber
   * attached before the first attempt would also see the events of every boot
   * that then panicked. Buffering and replaying only the surviving session's
   * history keeps both properties.
   */
  readonly #history: SesameTelemetry[] = [];

  /** TCP port QEMU published UART0 on. */
  port = 0;

  private constructor(options: ResolvedQemuOptions) {
    this.#options = options;
    this.#parser = new SesameTelemetryParser({
      // The firmware hook really ran and bytes really crossed UART0, so
      // `observed` is correct — and on its own it is also the exact ambiguity
      // that makes an emulator look like hardware. `defaultOrigin` is the half
      // that says which.
      defaultProvenance: 'observed',
      defaultOrigin: QEMU_ORIGIN,
    });
  }

  /** PID of the QEMU process, while it is alive. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** True once the end-of-`setup()` banner has been seen. */
  get booted(): boolean {
    return this.#banner;
  }

  /** The panic text, if the guest died. */
  get panic(): string | null {
    return this.#panic;
  }

  /** True while the QEMU process is running. */
  get alive(): boolean {
    return this.#child !== null && !this.#exited;
  }

  subscribe(listener: (event: SesameTelemetry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Everything produced before a subscriber existed, in order. */
  get history(): readonly SesameTelemetry[] {
    return this.#history;
  }

  // -------------------------------------------------------------------------
  // Bring-up
  // -------------------------------------------------------------------------

  /**
   * Spawn QEMU, attach to UART0, and wait for the boot banner.
   *
   * Resolves a usable session or throws; on any failure the process is already
   * dead by the time the rejection surfaces.
   */
  static async start(options: ResolvedQemuOptions): Promise<QemuSession> {
    installExitHook();
    const session = new QemuSession(options);
    try {
      await session.#spawn();
      await session.#waitForBanner();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  async #spawn(): Promise<void> {
    const { qemuPath, imagePath, machine, snapshot, uartPort } = this.#options;
    if (!fs.existsSync(qemuPath)) throw new QemuArtifactMissingError('qemu', qemuPath);
    if (!fs.existsSync(imagePath)) throw new QemuArtifactMissingError('image', imagePath);

    this.port = uartPort === 0 ? await freePort() : uartPort;
    const drive = `file=${imagePath},if=mtd,format=raw${snapshot ? ',snapshot=on' : ''}`;
    const args = [
      '-display',
      'none',
      '-machine',
      machine,
      '-drive',
      drive,
      '-serial',
      `tcp:127.0.0.1:${String(this.port)},server=on,wait=off`,
    ];
    this.#options.logger(`[qemu] ${qemuPath} ${args.join(' ')}`);

    const child = spawn(qemuPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;
    LIVE_SESSIONS.add(this);
    child.once('exit', () => {
      this.#exited = true;
      LIVE_SESSIONS.delete(this);
    });
    // QEMU's own diagnostics ("Adding SPI flash device", bind failures) are not
    // guest output and must never reach the telemetry parser — a log event
    // claiming `provenance: observed` for something the emulator said about
    // itself would be exactly the kind of laundering this package exists to
    // avoid.
    child.stdout?.on('data', (d: Buffer) => this.#options.logger(`[qemu:out] ${d.toString().trim()}`));
    child.stderr?.on('data', (d: Buffer) => this.#options.logger(`[qemu:err] ${d.toString().trim()}`));
  }

  /** Poll-connect from t=0 rather than sleeping a fixed interval. */
  async #attach(deadline: number): Promise<net.Socket> {
    for (;;) {
      if (this.#exited) throw new Error('QEMU exited before UART0 accepted a connection');
      if (Date.now() > deadline) throw new Error('UART0 never accepted a connection');
      const socket = await new Promise<net.Socket | null>((resolve) => {
        const s = net.createConnection({ host: '127.0.0.1', port: this.port });
        s.setNoDelay(true);
        s.once('connect', () => resolve(s));
        s.once('error', () => {
          s.destroy();
          resolve(null);
        });
      });
      if (socket !== null) return socket;
      await sleep(10);
    }
  }

  async #waitForBanner(): Promise<void> {
    const deadline = Date.now() + this.#options.bootTimeoutMs;
    const socket = await this.#attach(deadline);
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#ingest(chunk));
    socket.on('error', () => undefined);

    while (!this.#banner) {
      if (this.#panic !== null) throw new QemuGuestPanicError(this.#panic);
      if (this.#exited) throw new Error('QEMU exited before the firmware boot banner');
      if (Date.now() > deadline) {
        throw new Error(
          this.#tail.length === 0
            ? 'no UART output at all before the boot timeout'
            : 'boot timed out after some UART output but no banner',
        );
      }
      await sleep(20);
    }
  }

  // -------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------

  #ingest(chunk: Buffer): void {
    // Scan the raw byte stream for the banner and for panics, independently of
    // the telemetry parser. These are plain `Serial.println` output, and a
    // panic dump in particular is not line-shaped in any way the protocol cares
    // about; going through the parser first would work but would couple boot
    // detection to telemetry framing for no benefit.
    const text = chunk.toString('latin1');
    this.#tail = (this.#tail + text).slice(-4096);
    if (!this.#banner && this.#tail.includes(BOOT_BANNER)) this.#banner = true;
    if (this.#panic === null) {
      const panic = firstPanic(this.#tail);
      if (panic !== null) this.#panic = panic;
    }

    for (const event of this.#parser.push(chunk)) {
      if (event.type === 'log' && event.text.startsWith(BARRIER_MARKER)) this.#barriers += 1;
      this.#history.push(event);
      for (const listener of this.#listeners) listener(event);
    }
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * Write one CLI line and wait for the firmware to finish executing it.
   *
   * The barrier trick, in full: the console reads **one character per `loop()`
   * iteration** (`sesame-firmware-main.ino:788`) and runs a completed line
   * synchronously inside that iteration, so two lines written back to back are
   * strictly ordered. Appending a read-only `subtrim` and waiting for its
   * unmistakable first line therefore fences the command in front of it,
   * however long that command's choreography took — with no polling, no fixed
   * sleep, and no guess about how fast QEMU is running today.
   *
   * Writing both lines in one `write()` also means the firmware never sees a
   * gap it could interleave something into.
   */
  async runCliLine(line: string, timeoutMs: number): Promise<void> {
    await this.runCliLines([line], timeoutMs);
  }

  /**
   * Write several CLI lines and fence them all behind one barrier.
   *
   * Used for a multi-joint pose: the firmware has no multi-joint primitive at
   * all — every pose in `movement-sequences.h` is a run of `setServoAngle()`
   * calls — so the faithful encoding is N separate lines, and one barrier at
   * the end is enough because the console is strictly ordered.
   *
   * The batch is capped at {@link MAX_BATCH_BYTES}. UART0's receive path is an
   * ISR-filled ring buffer, but it is a *finite* one (256 bytes by default in
   * arduino-esp32), and the console drains it at one character per `loop()` —
   * which stalls completely for the duration of every `setServoAngle()`. Enough
   * queued lines really would overflow it, and the loss would be silent.
   */
  async runCliLines(lines: readonly string[], timeoutMs: number): Promise<void> {
    const socket = this.#socket;
    if (socket === null || !this.alive) throw new Error('session is not connected');
    const payload = `${lines.map((l) => l + CLI_TERMINATOR).join('')}${BARRIER_COMMAND}${CLI_TERMINATOR}`;
    if (payload.length > MAX_BATCH_BYTES) {
      throw new Error(
        `batch of ${String(payload.length)} bytes exceeds the ${String(MAX_BATCH_BYTES)}-byte ` +
          `UART0 receive budget; split it`,
      );
    }
    const want = this.#barriers + 1;
    socket.write(payload);
    const line = lines.join(' ; ');

    const deadline = Date.now() + timeoutMs;
    while (this.#barriers < want) {
      if (this.#panic !== null) throw new QemuGuestPanicError(this.#panic);
      if (this.#exited) throw new Error(`QEMU exited while running "${line}"`);
      if (Date.now() > deadline) throw new QemuCommandTimeoutError(line, timeoutMs);
      await sleep(10);
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Synchronous, best-effort. Safe from an `exit` handler, where async is not. */
  killNow(): void {
    try {
      this.#socket?.destroy();
    } catch {
      /* already gone */
    }
    this.#socket = null;
    try {
      this.#child?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /**
   * Kill QEMU and wait for the OS to confirm it.
   *
   * Awaiting the `exit` event rather than returning after `kill()` is the whole
   * difference between "no orphaned processes" as a claim and as a fact:
   * `ChildProcess.kill` on Windows calls `TerminateProcess` and returns
   * immediately, so a test that checked straight afterwards would be racing.
   */
  async dispose(): Promise<void> {
    const child = this.#child;
    this.killNow();
    if (child === null || this.#exited) {
      LIVE_SESSIONS.delete(this);
      this.#child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      child.once('error', done);
      // TerminateProcess does not fail politely; if the handle is already gone
      // the exit event may have fired before we listened.
      setTimeout(done, 5000).unref?.();
    });
    LIVE_SESSIONS.delete(this);
    this.#child = null;
  }
}

// ---------------------------------------------------------------------------
// Launcher: the ISSUE-20260823-022 mitigation
// ---------------------------------------------------------------------------

/** One boot attempt's outcome, for reporting. */
export interface BootAttempt {
  readonly attempt: number;
  readonly ok: boolean;
  readonly reason?: string;
  readonly ms: number;
}

/** Result of a (possibly retried) launch. */
export interface LaunchResult {
  readonly session: QemuSession;
  readonly attempts: readonly BootAttempt[];
}

/**
 * Boot QEMU, retrying past ISSUE-20260823-022.
 *
 * **This is a mitigation, not a fix, and the distinction is the honest part.**
 * The panic is a modelling bug in QEMU's ESP32 cache/DPORT handling around the
 * dual-core flash-operation dance, reproducible under a single host core and
 * unaffected by `snapshot=on`; the two QEMU knobs that would serialise the
 * cores — `-accel tcg,thread=single` and `-icount` — stop the machine booting
 * at all. Measurements and backtraces: `docs/findings/Q2-qemu-backend.md`.
 *
 * What retrying does buy is that the failure is *independent per boot* and
 * *detected in about two seconds*, so a bounded number of attempts turns a
 * 40%-per-boot fault into a connect that has not been observed to fail.
 */
export async function launchWithRetry(options: ResolvedQemuOptions): Promise<LaunchResult> {
  const attempts: BootAttempt[] = [];
  for (let attempt = 1; attempt <= options.bootAttempts; attempt++) {
    const started = Date.now();
    try {
      const session = await QemuSession.start(options);
      attempts.push({ attempt, ok: true, ms: Date.now() - started });
      return { session, attempts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, ok: false, reason, ms: Date.now() - started });
      options.logger(`[qemu] boot attempt ${String(attempt)} failed: ${reason}`);
      // An artefact that is not on disk will not appear on the next attempt.
      if (error instanceof QemuArtifactMissingError) throw error;
    }
  }
  throw new QemuBootFailedError(
    attempts.length,
    attempts.map((a) => a.reason ?? 'unknown'),
    attempts,
  );
}
