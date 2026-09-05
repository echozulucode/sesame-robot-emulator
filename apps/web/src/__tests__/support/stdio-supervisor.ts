/**
 * The Rust supervisor, driven from Node — **the contract suite's transport, and
 * nothing else's.**
 *
 * `describeRobotContract` is Node code: it imports `node:assert/strict`, and
 * C14 constructs a real `SesameApiServer` and calls `listen()`. There is no
 * arrangement in which those fifteen cases run inside a WebView2 window, so
 * `TauriSesameRobot` has to be reachable from a Node test — and the only
 * version of that worth running is one where the thing on the other end is the
 * **real** supervisor.
 *
 * So this speaks to `sesame-robot-emulator.exe --supervisor-stdio`:
 *
 * ```text
 * vitest (node)                       sesame-robot-emulator.exe
 * ─────────────────────────           ─────────────────────────────────────
 * describeRobotContract
 *   TauriSesameRobot                  app.path() -> the bundled qemu + image
 *     EmulatorSupervisor  ── stdin ─►  launch_with_retry (12 attempts, job object)
 *                         ◄─ stdout ─  raw UART0 bytes / progress events
 *     SesameTelemetryParser
 * ```
 *
 * Everything below the pipe is what the app itself runs: the same resolved
 * paths, the same retry loop, the same `Session::write` and its 192-byte
 * budget, the same teardown. What differs is only the carrier — an IPC
 * `Channel` in the window, a pipe here — which is why the carrier is a bare
 * length prefix and not an encoding. `src-tauri/src/stdio.rs` documents the
 * frame and asserts, in Rust, that a payload containing every byte value
 * survives it unchanged.
 *
 * **Not shipped.** Nothing under `apps/web/src` outside `__tests__` imports
 * this file, so `node:child_process` never reaches the browser bundle.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  EmulatorSupervisor,
  SupervisorEvent,
  SupervisorSession,
  SupervisorSpawnOptions,
  SupervisorStatusReport,
  SupervisorStopReport,
} from '../../backends/tauri/supervisor.js';

/** Repository root, from `apps/web/src/__tests__/support/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** Frame kinds, mirroring `src-tauri/src/stdio.rs`. */
const KIND_BYTES = 0;
const KIND_JSON = 1;

/** Where `cargo build` leaves the desktop shell. */
export function desktopExePath(profile: 'debug' | 'release' = 'debug'): string {
  return path.join(REPO_ROOT, 'src-tauri', 'target', profile, 'sesame-robot-emulator.exe');
}

/**
 * The most recently built profile, or `null` if neither exists.
 *
 * **Newest rather than release-first, and the reason is a real failure.** Both
 * profiles are built from the same source, but they are built at different
 * times, and a stale `release/` from before this workstream does not have
 * `--supervisor-stdio` at all — it would open a window and never answer, so the
 * suite would hang rather than fail. Picking by modification time means the
 * suite runs against the binary that was actually just built, whichever that is.
 */
export function findDesktopExe(): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const profile of ['release', 'debug'] as const) {
    const candidate = desktopExePath(profile);
    if (!fs.existsSync(candidate)) continue;
    const mtimeMs = fs.statSync(candidate).mtimeMs;
    if (best === null || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs };
  }
  return best?.path ?? null;
}

/** What to run to make {@link findDesktopExe} answer, for a skip message. */
export const BUILD_HINT = 'cargo build --manifest-path src-tauri/Cargo.toml';

interface PendingReply {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * A `QemuError` as Rust serialized it — the *same* tagged shape the IPC command
 * produces, so the robot above sees one error vocabulary rather than two.
 */
interface WireError {
  readonly kind: string;
  readonly message?: string;
  readonly bytes?: number;
  readonly budget?: number;
  readonly artifact?: string;
  readonly path?: string;
  readonly reasons?: readonly string[];
}

function toError(wire: unknown): Error {
  const detail = wire as WireError | undefined;
  if (detail === undefined || typeof detail.kind !== 'string') {
    return new Error(`the supervisor failed: ${JSON.stringify(wire)}`);
  }
  const error = new Error(detail.message ?? `${detail.kind}: ${JSON.stringify(detail)}`);
  error.name = detail.kind;
  return error;
}

/**
 * One `--supervisor-stdio` process, as an {@link EmulatorSupervisor}.
 *
 * The child is started lazily on the first `spawn()` and killed by `dispose()`,
 * which `TauriSesameRobot.disconnect()` calls — so each contract case gets a
 * fresh process, a fresh QEMU and a fresh job object, which is what the suite's
 * per-case factory contract means.
 */
export function stdioSupervisor(exePath: string): EmulatorSupervisor {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, PendingReply>();
  let onBytes: ((chunk: Uint8Array) => void) | null = null;
  let onEvent: ((event: SupervisorEvent) => void) | null = null;
  let exitReason: string | null = null;

  const failAllPending = (reason: string): void => {
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  };

  const consume = (): void => {
    // 1 byte of kind + 4 bytes of little-endian length + payload. A partial
    // frame is left in the buffer; a chunk boundary must never be visible to
    // anything above this line, for the same reason the parser downstream is
    // chunk-invariant.
    for (;;) {
      if (buffer.length < 5) return;
      const kind = buffer[0];
      const length = buffer.readUInt32LE(1);
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (kind === KIND_BYTES) {
        // A copy, because `subarray` is a view onto a buffer this loop is about
        // to advance past.
        onBytes?.(Uint8Array.prototype.slice.call(payload));
      } else if (kind === KIND_JSON) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString('utf8'));
        } catch {
          continue;
        }
        const frame = parsed as {
          type?: string;
          id?: number;
          ok?: boolean;
          result?: unknown;
          error?: unknown;
          event?: SupervisorEvent;
        };
        if (frame.type === 'event' && frame.event !== undefined) {
          onEvent?.(frame.event);
        } else if (frame.type === 'reply' && typeof frame.id === 'number') {
          const entry = pending.get(frame.id);
          pending.delete(frame.id);
          if (entry === undefined) continue;
          if (frame.ok === true) entry.resolve(frame.result);
          else entry.reject(toError(frame.error));
        }
      }
    }
  };

  const start = (): ChildProcessWithoutNullStreams => {
    if (child !== null) return child;
    const started = spawn(exePath, ['--supervisor-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    child = started;
    started.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    // The child's stderr is its own progress log, not the guest's. It is
    // deliberately dropped rather than merged into anything: it is the same
    // class of output QEMU's diagnostics are, and the honesty rule about those
    // does not stop at the process boundary.
    started.stderr.resume();
    started.on('exit', (code) => {
      exitReason = `the supervisor process exited with code ${String(code)}`;
      child = null;
      failAllPending(exitReason);
    });
    started.on('error', (error) => {
      exitReason = `the supervisor process failed: ${error.message}`;
      failAllPending(exitReason);
    });
    return started;
  };

  const request = async (op: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const live = child;
    if (live === null) throw new Error(exitReason ?? 'the supervisor process is not running');
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    live.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    return promise;
  };

  return {
    async spawn(
      options: SupervisorSpawnOptions,
      bytes: (chunk: ArrayBuffer | Uint8Array) => void,
      event: (e: SupervisorEvent) => void,
    ): Promise<SupervisorSession> {
      onBytes = bytes;
      onEvent = event;
      start();
      return (await request('spawn', { options })) as SupervisorSession;
    },
    async send(bytes: Uint8Array): Promise<number> {
      return (await request('send', { bytes: Array.from(bytes) })) as number;
    },
    async stop(): Promise<SupervisorStopReport> {
      return (await request('stop')) as SupervisorStopReport;
    },
    async status(): Promise<SupervisorStatusReport> {
      return (await request('status')) as SupervisorStatusReport;
    },
    async dispose(): Promise<void> {
      const live = child;
      if (live === null) return;
      const exited = new Promise<void>((resolve) => {
        live.once('exit', () => resolve());
      });
      try {
        live.stdin.end(`${JSON.stringify({ id: nextId++, op: 'quit' })}\n`);
      } catch {
        // The pipe is already gone; the exit handler will fire regardless.
      }
      // The job object is the guarantee that QEMU dies with this process, so a
      // hard kill after a grace period is safe rather than a leak — T3 §5.
      const killed = new Promise<void>((resolve) => {
        setTimeout(() => {
          live.kill();
          resolve();
        }, 5000).unref?.();
      });
      await Promise.race([exited, killed]);
      child = null;
      failAllPending('the supervisor process was disposed');
    },
  };
}
