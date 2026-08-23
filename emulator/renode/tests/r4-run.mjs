#!/usr/bin/env node
/**
 * R4 - timeout-guarded Renode runner.
 *
 * WHY THIS EXISTS: R2 section 3.6 established that the `rer` instruction makes
 * Renode 1.16.1 print "CPU abort ... reading from external register not yet
 * supported" and then never return from `emulation RunFor`. `rer` sits inside
 * esp_panic_handler, i.e. on exactly the path a failing boot takes, so any R4
 * script CAN and DOES wedge. This runner therefore:
 *   - streams stdout/stderr to a log file as they arrive (so a wedged run still
 *     leaves complete evidence up to the hang),
 *   - kills the process tree with `taskkill /T /F` on timeout, not SIGTERM,
 *     because renode.exe is a single-file bundle that ignores SIGTERM on Windows.
 *
 *   node emulator/renode/tests/r4-run.mjs <script.resc> <logname> [timeoutSec]
 *
 * Exit code: 0 normal exit, 124 killed on timeout (same convention as GNU timeout).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const RENODE = join(ROOT, 'tools', 'renode', 'renode.exe');
const LOGS = join(HERE, 'logs');

const [resc, logname, timeoutArg] = process.argv.slice(2);
if (!resc || !logname) {
  console.error('usage: node r4-run.mjs <script.resc> <logname> [timeoutSec]');
  process.exit(2);
}
const timeoutMs = (Number(timeoutArg) || 90) * 1000;
mkdirSync(LOGS, { recursive: true });
const logPath = join(LOGS, `${logname}.log`);
const out = createWriteStream(logPath);

const child = spawn(RENODE, ['--console', '--disable-xwt', '--plain', resc], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let killed = false;
const timer = setTimeout(() => {
  killed = true;
  out.write(`\n### R4-RUNNER: timeout after ${timeoutMs} ms - killing pid ${child.pid} tree\n`);
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}, timeoutMs);

child.stdout.on('data', (d) => { process.stdout.write(d); out.write(d); });
child.stderr.on('data', (d) => { process.stdout.write(d); out.write(d); });
child.on('close', (code) => {
  clearTimeout(timer);
  out.write(`\n### R4-RUNNER: exit code ${code}${killed ? ' (KILLED ON TIMEOUT)' : ''}\n`);
  out.end();
  console.log(`\n### R4-RUNNER: log -> ${logPath}  exit=${killed ? 124 : code}`);
  process.exit(killed ? 124 : (code ?? 1));
});
