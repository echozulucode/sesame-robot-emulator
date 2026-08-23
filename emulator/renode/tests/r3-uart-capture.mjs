#!/usr/bin/env node
/**
 * R3 end-to-end: compiled C -> emulated ESP32-S2 UART0 -> host TCP socket ->
 * the REAL `@sesame-lab/sesame-protocol` parser -> typed telemetry events.
 *
 *   node emulator/renode/tests/r3-uart-capture.mjs
 *
 * Exit code 0 means every assertion held. Anything else is a failure and the
 * reason is printed. Nothing here fakes a byte: the only input to the parser is
 * what actually arrived on the TCP socket.
 *
 * Sequencing matters. Renode's server socket terminal has no backlog, so bytes
 * the target writes before a client attaches are dropped. The script therefore:
 *   1. starts Renode with the monitor on stdin and the machine PAUSED,
 *   2. waits for the R3-READY banner,
 *   3. connects the TCP client,
 *   4. only then types `emulation RunFor` at the monitor.
 *
 * The protocol package is imported by relative path on purpose: emulator/renode
 * is not a pnpm workspace package, and this test must not require one.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const RENODE = join(ROOT, 'tools', 'renode', 'renode.exe');
const RESC = join(ROOT, 'emulator', 'renode', 'scripts', 'r3-uart-hello.resc');
const ELF = join(ROOT, 'firmware', 'probes', 'build', 'r3-uart-hello.elf');
const PORT = 3456;

const proto = await import(
  pathToFileURL(join(ROOT, 'packages', 'sesame-protocol', 'dist', 'index.js')).href,
);
const { SesameTelemetryParser } = proto;

const failures = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures.push(label);
}

for (const [p, what] of [[RENODE, 'Renode sidecar'], [ELF, 'r3 probe ELF']]) {
  if (!existsSync(p)) {
    console.error(`missing ${what}: ${p}`);
    if (p === ELF) console.error('build it with: bash firmware/probes/build-probes.sh');
    process.exit(2);
  }
}

const renode = spawn(RENODE, ['--console', '--disable-xwt', '--plain', RESC], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let renodeOut = '';
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Renode never printed R3-READY')), 60_000);
  renode.stdout.on('data', (d) => {
    renodeOut += d.toString();
    if (renodeOut.includes('R3-READY')) { clearTimeout(t); resolve(); }
  });
});
renode.stderr.on('data', (d) => { renodeOut += d.toString(); });

const cleanup = () => { try { renode.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', cleanup);

try {
  await ready;

  const chunks = [];
  const sock = connect({ host: '127.0.0.1', port: PORT });
  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
    setTimeout(() => rej(new Error('TCP connect timed out')), 15_000);
  });
  sock.on('data', (c) => chunks.push(c));

  // Client is attached; now let the target run. 20 ms of virtual time is far
  // more than the probe needs (it writes ~180 bytes and then spins).
  renode.stdin.write('emulation RunFor "0.02"\n');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const s = Buffer.concat(chunks).toString('latin1');
    if (s.includes('r3-uart-probe: done')) break;
  }

  renode.stdin.write('quit\n');
  const raw = Buffer.concat(chunks);
  sock.destroy();

  console.log('\n--- bytes received on tcp/%d (%d) ---', PORT, raw.length);
  console.log(JSON.stringify(raw.toString('latin1')));
  console.log('--- end ---\n');

  check(raw.length > 0, 'UART0 produced bytes on the host TCP socket', `${raw.length} bytes`);
  check(!raw.includes(0xff), 'no telnet IAC (0xFF) bytes in the stream',
        'telnetMode=false held');

  const parser = new SesameTelemetryParser({ defaultProvenance: 'observed' });
  const events = [...parser.push(raw), ...parser.flush()];
  console.log('--- parsed events ---');
  for (const e of events) console.log('   ', JSON.stringify(e));
  console.log('--- end ---\n');

  const servo = events.find(
    (e) => e.type === 'servo.target' && e.joint === 'R4' && e.angleDeg === 72,
  );
  check(!!servo, 'real parser produced servo.target { joint: R4, angleDeg: 72 }',
        servo ? JSON.stringify(servo) : 'not found');
  check(servo?.provenance === 'observed', 'that event is tagged provenance=observed');

  const servoL1 = events.find(
    (e) => e.type === 'servo.target' && e.joint === 'L1' && e.angleDeg === 15,
  );
  check(!!servoL1, 'second servo.target { joint: L1, angleDeg: 15 } parsed');

  const face = events.find((e) => e.type === 'face.expression');
  check(!!face, 'face.expression parsed', face ? JSON.stringify(face) : 'not found');

  const logs = events.filter((e) => e.type === 'log');
  check(logs.length >= 2, 'non-@SESAME boot chatter surfaced as log events',
        `${logs.length} log events`);

  const unknown = events.filter((e) => e.type === 'protocol.unknown');
  check(unknown.length === 0, 'no protocol.unknown events',
        unknown.length ? JSON.stringify(unknown) : '');
} catch (err) {
  check(false, 'harness completed', err.message);
} finally {
  cleanup();
}

console.log(failures.length === 0 ? '\nR3: ALL CHECKS PASSED' : `\nR3: ${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);
