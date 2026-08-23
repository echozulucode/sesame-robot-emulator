/**
 * Driving Path A: real Renode, real emulated ESP32-S2 UART0, real TCP socket.
 *
 * This module only *reads* and *runs* what the `renode-platform` agent owns in
 * `emulator/renode/`; it writes nothing there. Two ways in:
 *
 *   SESAME_RENODE_UART_PORT=<port>   attach to a socket terminal you started
 *   SESAME_PATH_A=1                  spawn Renode from the checked-in .resc
 *
 * Neither runs by default, for two reasons: Renode takes ~15 s to reach the
 * ready banner, and the .resc hard-codes TCP 3456, so an unlucky concurrent run
 * would collide on the port and report a confusing failure instead of an honest
 * skip.
 *
 * The sequencing is not negotiable and is copied from the renode-platform
 * agent's own harness: **Renode's server socket terminal has no backlog.** Bytes
 * the target writes before a client attaches are gone. So the machine must be
 * left paused until the bridge's TCP client is connected, and only then told to
 * run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { REPO } from './helpers.js';

export const RENODE_EXE = path.join(REPO, 'tools/renode/renode.exe');
export const R3_RESC = path.join(REPO, 'emulator/renode/scripts/r3-uart-hello.resc');
export const R3_PROBE_ELF = path.join(REPO, 'firmware/probes/build/r3-uart-hello.elf');
export const R3_PROBE_SRC = path.join(REPO, 'firmware/probes/r3/uart_hello.c');

/** Port the checked-in .resc binds its socket terminal to. */
export const R3_PORT = 3456;

const envPort = Number(process.env.SESAME_RENODE_UART_PORT ?? '');

export type PathAMode = 'attach' | 'spawn' | null;

/** Which Path-A route, if any, is available in this run. */
export function pathAMode(): PathAMode {
  if (Number.isInteger(envPort) && envPort > 0) return 'attach';
  if (process.env.SESAME_PATH_A !== '1') return null;
  if (!fs.existsSync(RENODE_EXE) || !fs.existsSync(R3_RESC) || !fs.existsSync(R3_PROBE_ELF)) return null;
  return 'spawn';
}

export function pathAPort(): number {
  return pathAMode() === 'attach' ? envPort : R3_PORT;
}

export function pathASkipReason(): string {
  if (!fs.existsSync(RENODE_EXE)) return 'no Renode sidecar at tools/renode/renode.exe';
  if (!fs.existsSync(R3_RESC)) return 'no emulator/renode/scripts/r3-uart-hello.resc';
  if (!fs.existsSync(R3_PROBE_ELF)) return 'no firmware/probes/build/r3-uart-hello.elf (bash firmware/probes/build-probes.sh)';
  return 'opt-in: set SESAME_PATH_A=1 (spawns Renode, ~20 s) or SESAME_RENODE_UART_PORT=<port>';
}

/**
 * The exact lines the R3 probe writes, read out of its C source.
 *
 * Same discipline as the firmware-format test: the expected bytes are extracted
 * from the thing that produces them, never retyped. A test holding its own copy
 * of `"@SESAME servo R4 72"` would agree with a typo in the probe.
 */
export function r3ProbeLines(): string[] {
  const src = fs.readFileSync(R3_PROBE_SRC, 'utf8');
  const array = /static const char \*const lines\[\] = \{([\s\S]*?)\};/.exec(src);
  if (!array) throw new Error('could not find the lines[] array in the R3 probe source');
  const literals = [...array[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
  if (literals.length === 0) throw new Error('R3 probe lines[] is empty');
  return literals.map((l) =>
    l.replace(/\\(.)/g, (_, c: string) => {
      const table: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
      const v = table[c];
      if (v === undefined) throw new Error(`unsupported C escape \\${c} in the R3 probe`);
      return v;
    }),
  );
}

export interface RenodeSession {
  /** Type a line at the Renode monitor. */
  monitor(command: string): void;
  /** Everything Renode has printed. */
  readonly output: string;
  stop(): Promise<void>;
}

/** Spawn Renode on the R3 script and wait for its ready banner. Machine stays paused. */
export async function startRenode(readyTimeoutMs = 90_000): Promise<RenodeSession> {
  const proc: ChildProcessWithoutNullStreams = spawn(
    RENODE_EXE,
    ['--console', '--disable-xwt', '--plain', R3_RESC],
    { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });

  const started = Date.now();
  while (!output.includes('R3-READY')) {
    if (proc.exitCode !== null) throw new Error(`Renode exited early:\n${output.slice(-2000)}`);
    if (Date.now() - started > readyTimeoutMs) {
      proc.kill();
      throw new Error(`Renode never printed R3-READY in ${readyTimeoutMs} ms:\n${output.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    monitor: (command) => proc.stdin.write(`${command}\n`),
    get output() {
      return output;
    },
    async stop() {
      proc.stdin.write('quit\n');
      await new Promise((r) => setTimeout(r, 500));
      proc.kill();
    },
  };
}
