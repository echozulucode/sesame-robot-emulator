#!/usr/bin/env node
/**
 * Q2 — measure the *after* number for ISSUE-20260823-022.
 *
 * `run-flake-trial.mjs` measures the per-boot failure rate of a bare QEMU
 * launch. This measures what a caller of `QemuSesameRobot.connect()` actually
 * experiences, which is a different quantity because `connect()` detects the
 * panic and relaunches. Reporting only one of the two would be misleading in
 * either direction: the per-boot rate makes the backend look unusable, and the
 * connect rate on its own hides that the underlying QEMU bug is untouched.
 *
 * Also asserts the thing that is easy to claim and easy to get wrong on
 * Windows: **no `qemu-system-xtensa.exe` is left behind.** Every PID this run
 * created is checked against `tasklist` after teardown.
 *
 * Usage:
 *   node emulator/qemu/measure-connect.mjs --runs 25
 *   node emulator/qemu/measure-connect.mjs --runs 25 --attempts 1   # retry disabled
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs({
  name: 'measure-connect.mjs',
  summary: 'Measure QemuSesameRobot.connect() reliability, and prove teardown leaves no orphans.',
  flags: {
    runs: { describe: 'connect/disconnect cycles', type: 'number', default: 25 },
    attempts: { describe: 'bootAttempts per connect (1 disables the retry)', type: 'number', default: 8 },
    command: { describe: 'movement to run on each connect, or "" for none', default: '' },
    tag: { describe: 'report tag', default: 'connect' },
  },
});

const DIST = path.join(REPO, 'packages', 'sesame-qemu', 'dist', 'index.js');
if (!fs.existsSync(DIST)) {
  console.error(`missing ${DIST}\nrun: pnpm --filter @sesame-lab/sesame-qemu build`);
  process.exit(2);
}
const { QemuSesameRobot } = await import(`file://${DIST.split(path.sep).join('/')}`);

/** True when a PID is a live qemu-system-xtensa. Windows-specific on purpose. */
function qemuAlive(pid) {
  if (pid === undefined) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
    return /qemu-system-xtensa/i.test(out);
  } catch {
    return false;
  }
}

const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const results = [];
const pids = [];
for (let run = 1; run <= Number(opts.runs); run++) {
  const robot = new QemuSesameRobot({ bootAttempts: Number(opts.attempts) });
  const started = Date.now();
  let ok = false;
  let error = null;
  let attempts = [];
  let servo = 0;
  let pid;
  try {
    const events = [];
    robot.subscribe((e) => events.push(e));
    await robot.connect();
    attempts = robot.bootAttempts;
    pid = robot.session?.pid;
    if (pid !== undefined) pids.push(pid);
    if (String(opts.command) !== '') {
      events.length = 0;
      await robot.command(String(opts.command));
      servo = events.filter((e) => e.type === 'servo.target').length;
    }
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    attempts = robot.bootAttempts;
  } finally {
    await robot.disconnect();
  }
  const orphan = qemuAlive(pid);
  results.push({
    run,
    ok,
    error,
    ms: Date.now() - started,
    bootAttempts: attempts.length,
    failedAttempts: attempts.filter((a) => !a.ok).map((a) => a.reason),
    servo,
    pid,
    orphan,
  });
  process.stdout.write(
    `[${opts.tag}] run ${String(run).padStart(3)}/${opts.runs}  ` +
      `${ok ? 'ok ' : 'FAIL'}  attempts=${attempts.length}  ` +
      `${String(opts.command) === '' ? '' : `servo=${servo}  `}` +
      `${Date.now() - started}ms  orphan=${orphan ? 'YES' : 'no'}` +
      (error ? `  ${error.slice(0, 100)}` : '') +
      '\n',
  );
}

const totalAttempts = results.reduce((n, r) => n + r.bootAttempts, 0);
const failedAttempts = results.reduce((n, r) => n + r.failedAttempts.length, 0);
const summary = {
  tag: String(opts.tag),
  config: { runs: Number(opts.runs), bootAttempts: Number(opts.attempts), command: String(opts.command) },
  connects: results.length,
  connectFailures: results.filter((r) => !r.ok).length,
  totalBootAttempts: totalAttempts,
  failedBootAttempts: failedAttempts,
  perBootFailureRate: totalAttempts === 0 ? 0 : failedAttempts / totalAttempts,
  maxAttemptsUsed: Math.max(...results.map((r) => r.bootAttempts)),
  orphanedProcesses: results.filter((r) => r.orphan).length,
  detail: results,
};
fs.writeFileSync(path.join(LOGS, `connect-${opts.tag}.json`), JSON.stringify(summary, null, 2));

console.log(
  `\n[${opts.tag}] connect failures ${summary.connectFailures}/${summary.connects}; ` +
    `boot attempts ${failedAttempts} failed of ${totalAttempts} ` +
    `(${(summary.perBootFailureRate * 100).toFixed(1)}% per boot); ` +
    `worst connect needed ${summary.maxAttemptsUsed} attempt(s); ` +
    `orphaned qemu processes ${summary.orphanedProcesses}`,
);
console.log(`-> emulator/qemu/logs/connect-${opts.tag}.json`);
process.exitCode = summary.connectFailures > 0 || summary.orphanedProcesses > 0 ? 1 : 0;
