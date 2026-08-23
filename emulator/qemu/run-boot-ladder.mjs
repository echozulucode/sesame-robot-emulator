#!/usr/bin/env node
/**
 * Q1 - Espressif QEMU boot ladder.
 *
 * Boots a Sesame flash image on Espressif's QEMU ESP32 machine and records
 * which of the 20 steps in hardware-map.json -> bootOrder are actually reached,
 * by planting a breakpoint on the exact source line each step is anchored to.
 *
 * Why this speaks the GDB remote protocol directly instead of running GDB:
 * the pinned xtensa-esp-elf-gdb 17.1 and QEMU's ESP32 gdbstub disagree on the
 * Xtensa register-file layout ("Remote 'g' packet reply is too long (expected
 * 388 bytes, got 628 bytes)"), which kills `target remote` before any
 * breakpoint can be set. The ladder never needs the general register file - it
 * needs Z0 breakpoints and one register (PC) - so it asks for exactly that.
 * GDB is still used, but only OFFLINE, to turn source lines into addresses.
 *
 * Usage:
 *   node emulator/qemu/run-boot-ladder.mjs [--image <flash.bin>] [--elf <app.elf>]
 *                                          [--tag <name>] [--port 3333]
 *                                          [--seconds 40]
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

const QEMU = path.join(REPO, 'tools', 'qemu', 'qemu', 'bin', 'qemu-system-xtensa.exe');
const GDB = path.join(REPO, 'tools', 'arduino-data', 'data', 'packages', 'esp32', 'tools',
  'xtensa-esp-elf-gdb', '17.1_20260402', 'bin', 'xtensa-esp-elf-gdb-no-python.exe');
const IMAGE = path.resolve(arg('image', path.join(REPO, 'emulator/qemu/images/distro-v1-esp32-dio.flash.bin')));
const ELF = path.resolve(arg('elf', path.join(REPO, 'tools/arduino-data/scratch/qemu-dio/out/sesame-firmware-main.ino.elf')));
const TAG = arg('tag', 'ladder');
const PORT = Number(arg('port', '3333'));
const SECONDS = Number(arg('seconds', '40'));
// hardware-map.json's bootOrder line numbers are against the STOCK upstream
// .ino. A build whose source has extra lines inserted (the R6 telemetry patch
// inserts 176 of them, four of which land inside setup()) shifts every step.
// Rather than hard-code an offset, diff the two sources and remap.
const REMAP_FROM = arg('remap-from', null);   // stock .ino  (line numbers in hardware-map)
const REMAP_TO = arg('remap-to', null);       // the .ino actually compiled

for (const [n, p] of [['qemu', QEMU], ['gdb', GDB], ['image', IMAGE], ['elf', ELF]]) {
  if (!fs.existsSync(p)) { console.error(`missing ${n}: ${p}`); process.exit(2); }
}

const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const SRC = 'sesame-firmware-main.ino';

// The 20 steps come from hardware-map.json rather than being transcribed here,
// so this ladder cannot silently drift from F4's recorded boot order.
const map = JSON.parse(fs.readFileSync(path.join(REPO, 'hardware', 'hardware-map.json'), 'utf8'));
const steps = map.bootOrder.map((s) => ({
  label: `STEP${String(s.order).padStart(2, '0')}`,
  order: s.order, line: s.source.line,
  subsystem: s.subsystem, op: s.operation.slice(0, 62),
}));

// Extra probe, not a bootOrder step: line 661 is the `while (1);` that
// display.begin() falls into on failure. A hit there means the OLED blocked the
// boot; no hit plus a hit on step 5 means it did not.
const probes = [{ label: 'OLED-HARDFAIL', order: null, line: 661, subsystem: 'display', op: 'while(1) after display.begin() returned false' }];
const all = [...steps, ...probes];

// --------------------------------------------------- stock -> built line map
// Built from `git diff --no-index -U0`, so it survives any insertion, not just
// the one patch we happen to use today. Pure insertions remap exactly; a step
// whose own line was rewritten is reported rather than guessed at.
if (REMAP_FROM && REMAP_TO) {
  const d = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '-U0',
    '--', path.resolve(REMAP_FROM), path.resolve(REMAP_TO)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const hunks = [...(d.stdout ?? '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newLen: m[4] === undefined ? 1 : +m[4] }));
  const remap = (L) => {
    let off = 0;
    for (const h of hunks) {
      if (h.oldStart + h.oldLen <= L) off += h.newLen - h.oldLen;          // hunk entirely above L
      else if (h.oldLen > 0 && L >= h.oldStart && L < h.oldStart + h.oldLen) return { line: L + off, dirty: true };
      else if (h.oldLen === 0 && h.oldStart < L) off += h.newLen;          // pure insertion above L
    }
    return { line: L + off, dirty: false };
  };
  for (const s of all) {
    const r = remap(s.line);
    s.stockLine = s.line;
    s.line = r.line;
    s.rewritten = r.dirty;
  }
  console.log(`[q1] remapped bootOrder lines via ${hunks.length} diff hunks (${path.basename(REMAP_FROM)} -> ${path.basename(REMAP_TO)})`);

  // A step whose line has been commented out by make-nowifi-variant.mjs has no
  // code of its own, so GDB resolves it to the NEXT line that does - which
  // makes an elided step look "reached" by borrowing a neighbour's address.
  // Detect and label it, and keep it out of the reached count.
  const built = fs.readFileSync(path.resolve(REMAP_TO), 'utf8').split(/\r?\n/);
  for (const s of all) {
    if (/^\s*\/\/ \[Q1-NOWIFI\]/.test(built[s.line - 1] ?? '')) s.elided = true;
  }
}

// ---------------------------------------------------------- line -> address
// GDB offline. `info line` also tells us when a line carries no code of its own
// (the compiler folded it into a neighbour), which we must report rather than
// silently treat as "not reached".
const cmdFile = path.join(LOGS, `${TAG}.lines.gdb`);
fs.writeFileSync(cmdFile, ['set pagination off', ...all.map((s) => `info line ${SRC}:${s.line}`)].join('\n') + '\n');
const lineOut = spawnSync(GDB, ['-batch', '-x', cmdFile, ELF], { encoding: 'utf8', maxBuffer: 64 << 20 });
fs.writeFileSync(path.join(LOGS, `${TAG}.lines.log`), `${lineOut.stdout ?? ''}\n${lineOut.stderr ?? ''}`);

for (const s of all) {
  const re = new RegExp(`Line ${s.line} of [^\\n]*?(?:starts at address|is at address) (0x[0-9a-f]+)`);
  const m = re.exec(lineOut.stdout ?? '');
  s.addr = m ? parseInt(m[1], 16) : null;
  s.noCode = new RegExp(`Line ${s.line} of [^\\n]*?but contains no code`).test(lineOut.stdout ?? '');
}
// Two bootOrder lines legitimately share an address with a later step (the
// compiler emitted no code of their own). Sharing an address would make one
// step steal the other's hit, so the duplicate is dropped and reported.
const byAddr = new Map();
for (const s of all) {
  if (s.addr === null || s.elided) continue;
  if (byAddr.has(s.addr)) { s.aliasOf = byAddr.get(s.addr).label; continue; }
  byAddr.set(s.addr, s);
}

// ------------------------------------------------------------------- QEMU
console.log(`[q1] image ${IMAGE}`);
console.log(`[q1] elf   ${ELF}`);
const uartPath = path.join(LOGS, `${TAG}.uart.log`);
const uartLog = fs.createWriteStream(uartPath);
const qemu = spawn(QEMU, [
  '-nographic', '-machine', 'esp32',
  '-drive', `file=${IMAGE},if=mtd,format=raw`,
  '-gdb', `tcp::${PORT}`, '-S',
], { stdio: ['ignore', 'pipe', 'pipe'] });
qemu.stdout.pipe(uartLog);
qemu.stderr.pipe(uartLog);
const killQemu = () => { try { qemu.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', killQemu);

// ------------------------------------------------- minimal GDB-RSP client
const csum = (s) => [...s].reduce((a, c) => (a + c.charCodeAt(0)) & 0xff, 0).toString(16).padStart(2, '0');

class Rsp {
  constructor(sock) { this.sock = sock; this.buf = ''; this.waiters = []; sock.on('data', (d) => this.onData(d)); }
  onData(d) {
    this.buf += d.toString('latin1');
    for (;;) {
      // Acks are noise once we are past the handshake.
      if (this.buf[0] === '+' || this.buf[0] === '-') { this.buf = this.buf.slice(1); continue; }
      const i = this.buf.indexOf('$');
      const j = this.buf.indexOf('#', i + 1);
      if (i < 0 || j < 0 || this.buf.length < j + 3) return;
      const payload = this.buf.slice(i + 1, j);
      this.buf = this.buf.slice(j + 3);
      this.sock.write('+');
      const w = this.waiters.shift();
      if (w) w(payload);
    }
  }
  send(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`RSP timeout on '${cmd}'`)), timeoutMs);
      this.waiters.push((p) => { clearTimeout(t); resolve(p); });
      this.sock.write(`$${cmd}#${csum(cmd)}`);
    });
  }
}

const connect = () => new Promise((resolve, reject) => {
  let tries = 0;
  const go = () => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', (e) => (++tries > 50 ? reject(e) : setTimeout(go, 100)));
  };
  go();
});

// QEMU's Xtensa gdbstub puts PC at register 0 (verified: the reset value read
// back is 0x40000400, the ESP32 ROM reset vector).
const PC_REGNO = 0;
const leHexToInt = (h) => parseInt((h.match(/../g) ?? []).reverse().join(''), 16);

const hits = [];
const trace = [];
let stopReason = 'unknown';

try {
  const sock = await connect();
  const rsp = new Rsp(sock);
  await rsp.send('QStartNoAckMode').catch(() => {});
  await rsp.send('?');

  for (const s of all) {
    if (s.addr === null || s.aliasOf) continue;
    const r = await rsp.send(`Z0,${s.addr.toString(16)},1`);
    if (r !== 'OK') console.warn(`[q1] breakpoint refused for ${s.label} @0x${s.addr.toString(16)}: '${r}'`);
  }

  const deadline = Date.now() + SECONDS * 1000;
  for (;;) {
    if (Date.now() > deadline) { stopReason = `wall-clock budget of ${SECONDS}s exhausted`; break; }
    const stop = await rsp.send('c', Math.max(1000, deadline - Date.now()));
    if (!stop.startsWith('T') && !stop.startsWith('S')) { stopReason = `target reported '${stop}'`; break; }
    const pcHex = await rsp.send(`p${PC_REGNO.toString(16)}`);
    const pc = leHexToInt(pcHex);
    const s = byAddr.get(pc);
    if (!s) { trace.push({ pc, label: '(unmapped stop)' }); continue; }
    trace.push({ pc, label: s.label });
    if (!hits.some((h) => h.label === s.label)) hits.push({ label: s.label, pc });
    // Retire it, so a loop cannot pin the ladder on one line.
    await rsp.send(`z0,${pc.toString(16)},1`);
  }
  try { sock.destroy(); } catch { /* closing anyway */ }
} catch (e) {
  stopReason = `harness: ${e.message}`;
}
killQemu();

// -------------------------------------------------------------- reporting
const hit = new Map(hits.map((h) => [h.label, h]));
const resolveHit = (s) => hit.get(s.aliasOf ?? s.label);

console.log('\n=== hardware-map.json bootOrder, walked under Espressif QEMU ===');
let reached = 0;
let elided = 0;
for (const s of steps) {
  const h = s.elided ? null : resolveHit(s);
  if (s.elided) elided++;
  if (h) reached = Math.max(reached, s.order);
  const addr = s.addr === null ? 'unresolved' : `0x${s.addr.toString(16)}`;
  const note = (s.aliasOf ? ` (no own code; shares ${addr} with ${s.aliasOf})` : s.noCode && !s.elided ? ' (no own code)' : '')
    + (s.rewritten ? ' (line rewritten by patch - remap approximate)' : '');
  const verdict = s.elided ? 'ELIDED ' : h ? 'REACHED' : '   -   ';
  const ln = s.stockLine ? `${String(s.stockLine).padStart(3)}->${String(s.line).padStart(4)}` : `${String(s.line).padStart(3)}       `;
  console.log(`${String(s.order).padStart(2)}  ${verdict}  line ${ln}  ${(s.elided ? '-' : addr).padEnd(10)}  ${s.subsystem.padEnd(8)}  ${s.op}${note}`);
}
for (const p of probes) {
  console.log(`--  ${hit.has(p.label) ? 'HIT !!!' : 'not hit'}  line ${String(p.line).padStart(3)}  0x${(p.addr ?? 0).toString(16).padEnd(8)}  ${p.subsystem.padEnd(8)}  ${p.op}`);
}
const executed = steps.filter((s) => !s.elided && resolveHit(s)).length;
console.log(`\nhighest bootOrder step reached: ${reached} / 20`);
console.log(`steps whose own code was observed executing: ${executed} / ${steps.length - elided} present` + (elided ? `  (${elided} elided from this build)` : ''));
console.log(`stopped because: ${stopReason}`);

const uart = fs.existsSync(uartPath) ? fs.readFileSync(uartPath, 'utf8') : '';
const sesame = uart.split(/\r?\n/).filter((l) => /@SESAME|AP Created|Network mode disabled|SSD1306|HTTP server/.test(l));
if (sesame.length) { console.log('\n=== Sesame UART lines ==='); for (const l of sesame.slice(0, 40)) console.log(l); }

fs.writeFileSync(path.join(LOGS, `${TAG}.ladder.json`), JSON.stringify({
  image: IMAGE, elf: ELF, reached, stopReason,
  steps: steps.map((s) => ({ ...s, hit: Boolean(resolveHit(s)) })),
  probes: probes.map((p) => ({ ...p, hit: hit.has(p.label) })),
  trace,
}, null, 2));
console.log(`\nlogs: emulator/qemu/logs/${TAG}.{uart.log,ladder.json,lines.log}`);
