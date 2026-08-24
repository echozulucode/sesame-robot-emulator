#!/usr/bin/env node
/**
 * Q2 - characterise ISSUE-20260823-022 (QEMU early-boot flakiness) and measure
 * whether a candidate fix actually moves the rate.
 *
 * Q1 saw roughly 1 run in 5 panic during early boot with
 *
 *   Guru Meditation Error: Core  0 panic'ed (Cache error).
 *   Cache disabled but cached memory region accessed
 *
 * yielding zero servo events. This script boots the same image N times under a
 * named CONFIGURATION and reports a rate, so "we fixed it" is a measurement
 * rather than a feeling. Every knob a suspect needs is a flag:
 *
 *   --snapshot on|off   QEMU `-drive ...,snapshot=on` (COW overlay)
 *   --attach            when the host TCP client attaches to UART0:
 *                         sleep:<ms>  fixed delay, what Q1's demo did
 *                         listen      poll-connect as soon as QEMU accepts
 *                         none        never attach (isolates the attach race)
 *   --icount <n>        QEMU `-icount shift=<n>` deterministic instruction clock
 *
 * Usage:
 *   node emulator/qemu/run-flake-trial.mjs --runs 20 --tag baseline
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs({
  name: 'run-flake-trial.mjs',
  summary: 'Boot one QEMU image N times under a named configuration and report the failure rate.',
  flags: {
    image:    { describe: 'flash image to boot', default: 'emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin' },
    runs:     { describe: 'iterations', type: 'number', default: 20 },
    seconds:  { describe: 'seconds of UART capture per run', type: 'number', default: 12 },
    snapshot: { describe: 'QEMU drive snapshot=on|off', default: 'off' },
    attach:   { describe: 'sleep:<ms> | listen | none', default: 'sleep:1500' },
    icount:   { describe: 'QEMU -icount shift value, or "" for none', default: '' },
    accel:    { describe: 'QEMU -accel argument, e.g. tcg,thread=single (empty = QEMU default)', default: '' },
    success:  { describe: 'what counts as a good run: servo | banner', default: 'servo' },
    tag:      { describe: 'log/report tag', default: 'flake' },
  },
});

const QEMU = path.join(REPO, 'tools', 'qemu', 'qemu', 'bin', 'qemu-system-xtensa.exe');
const IMAGE = path.resolve(REPO, String(opts.image));
const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');
fs.mkdirSync(LOGS, { recursive: true });
for (const [n, p] of [['qemu', QEMU], ['image', IMAGE]]) {
  if (!fs.existsSync(p)) { console.error(`missing ${n}: ${p}`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const PANIC = /Guru Meditation Error|Cache disabled but cached memory region accessed|assert failed/;
const CACHE = /Cache disabled but cached memory region accessed/;

/** Connect, retrying, until `deadline`. Resolves null if it never accepts. */
async function connectWithRetry(port, deadline) {
  while (Date.now() < deadline) {
    const sock = await new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.setNoDelay(true);
      s.once('connect', () => resolve(s));
      s.once('error', () => { s.destroy(); resolve(null); });
    });
    if (sock) return sock;
    await sleep(20);
  }
  return null;
}

async function oneRun(i) {
  const port = await freePort();
  const args = [
    '-display', 'none', '-machine', 'esp32',
    '-drive', `file=${IMAGE},if=mtd,format=raw${opts.snapshot === 'on' ? ',snapshot=on' : ''}`,
    '-serial', `tcp:127.0.0.1:${port},server=on,wait=off`,
  ];
  if (String(opts.icount) !== '') args.push('-icount', `shift=${opts.icount}`);
  if (String(opts.accel) !== '') args.push('-accel', String(opts.accel));

  const t0 = Date.now();
  const qemu = spawn(QEMU, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdio = '';
  qemu.stdout.on('data', (d) => { stdio += d.toString(); });
  qemu.stderr.on('data', (d) => { stdio += d.toString(); });

  let uart = '';
  let sock = null;
  const deadline = t0 + Number(opts.seconds) * 1000;
  const mode = String(opts.attach);
  if (mode.startsWith('sleep:')) {
    await sleep(Number(mode.slice(6)));
    sock = await connectWithRetry(port, deadline);
  } else if (mode === 'listen') {
    sock = await connectWithRetry(port, deadline);
  }
  const attachedAtMs = sock ? Date.now() - t0 : null;
  if (sock) sock.on('data', (c) => { uart += c.toString('latin1'); });

  await sleep(Math.max(0, deadline - Date.now()));
  try { sock?.destroy(); } catch { /* gone */ }
  qemu.kill('SIGKILL');
  await new Promise((r) => qemu.once('exit', r));

  const text = uart + stdio;
  const servo = (text.match(/@SESAME servo /g) ?? []).length;
  const hello = /@SESAME hello /.test(text);
  const banner = /HTTP server & Captive Portal started\./.test(text);
  return {
    run: i,
    port,
    attachedAtMs,
    servo,
    hello,
    banner,
    faces: (text.match(/@SESAME face /g) ?? []).length,
    panic: PANIC.test(text),
    cacheError: CACHE.test(text),
    bytes: uart.length,
    ok: (opts.success === 'banner' ? banner : servo > 0) && !CACHE.test(text),
    text,
  };
}

const results = [];
for (let i = 1; i <= Number(opts.runs); i++) {
  const r = await oneRun(i);
  results.push(r);
  process.stdout.write(
    `[${opts.tag}] run ${String(i).padStart(3)}/${opts.runs}  ` +
    `servo=${String(r.servo).padStart(3)} hello=${r.hello ? 'y' : 'n'} banner=${r.banner ? 'y' : 'n'} ` +
    `cacheErr=${r.cacheError ? 'YES' : ' no'} attach=${r.attachedAtMs ?? '-'}ms\n`,
  );
  if (!r.ok) fs.writeFileSync(path.join(LOGS, `flake-${opts.tag}-fail-${i}.log`), r.text);
}

const fails = results.filter((r) => !r.ok);
const summary = {
  tag: String(opts.tag),
  config: {
    image: path.relative(REPO, IMAGE).split(String.fromCharCode(92)).join('/'),
    runs: Number(opts.runs), seconds: Number(opts.seconds),
    snapshot: String(opts.snapshot), attach: String(opts.attach),
    icount: String(opts.icount), accel: String(opts.accel), success: String(opts.success),
  },
  runs: results.length,
  failures: fails.length,
  cacheErrors: results.filter((r) => r.cacheError).length,
  zeroServo: results.filter((r) => r.servo === 0).length,
  noBanner: results.filter((r) => !r.banner).length,
  failureRate: fails.length / results.length,
  servoCounts: results.map((r) => r.servo),
  detail: results.map(({ text, ...rest }) => rest),
};
fs.writeFileSync(path.join(LOGS, `flake-${opts.tag}.json`), JSON.stringify(summary, null, 2));
console.log(`\n[${opts.tag}] ${fails.length}/${results.length} failed ` +
  `(cache-error ${summary.cacheErrors}, zero-servo ${summary.zeroServo}) ` +
  `-> emulator/qemu/logs/flake-${opts.tag}.json`);
