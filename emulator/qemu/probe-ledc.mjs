#!/usr/bin/env node
/**
 * Q3 - Does QEMU's ESP32 LEDC model actually produce servo PWM?
 *
 * Boots a Sesame flash image, lets the firmware run ESP32Servo's attach() +
 * write() path, then reads the LEDC peripheral's registers back OUT OF THE
 * EMULATED PERIPHERAL over QEMU's own GDB stub (gdbstub memory reads go through
 * address_space_rw, so an `m` packet at an MMIO address really does call
 * esp32_ledc_read()).  Also captures QEMU's `led_set_intensity` trace events,
 * which are the only externally observable output the LEDC model has.
 *
 * Same GDB-RSP-by-hand approach as run-boot-ladder.mjs, and for the same
 * reason: the pinned xtensa-esp-elf-gdb cannot attach to QEMU's ESP32 gdbstub.
 *
 * Tolerates ISSUE-20260823-022 (~28% per-boot cache panic) by retrying.
 *
 * Usage:
 *   node emulator/qemu/probe-ledc.mjs [--image <flash.bin>] [--tag <name>]
 *                                     [--port 3343] [--attempts 12]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs({
  name: 'probe-ledc.mjs',
  summary: "Read QEMU's ESP32 LEDC registers back after ESP32Servo has configured them.",
  flags: {
    image:    { describe: 'flash image to boot', default: 'emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin' },
    tag:      { describe: 'log-file tag', default: 'ledc' },
    port:     { describe: 'gdbstub port', type: 'number', default: 3343 },
    attempts: { describe: 'boot attempts (ISSUE-20260823-022 retry budget)', type: 'number', default: 12 },
    seconds:  { describe: 'seconds to let the firmware run before halting', type: 'number', default: 14 },
  },
});
const arg = (n, d) => (opts[n] === undefined || opts[n] === '' ? d : opts[n]);

const QEMU = path.join(REPO, 'tools', 'qemu', 'qemu', 'bin', 'qemu-system-xtensa.exe');
const IMAGE = path.resolve(arg('image', path.join(REPO, 'emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin')));
const TAG = arg('tag', 'ledc');
const PORT = Number(arg('port', 3343));
const ATTEMPTS = Number(arg('attempts', 12));
const SECONDS = Number(arg('seconds', 14));
const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// ---------------------------------------------------------------- registers
// ESP32 TRM chapter 14 (LED PWM Controller), register summary.
// DR_REG_LEDC_BASE = 0x3FF59000.
const BASE = 0x3ff59000;
const regs = [];
const chan = (grp, base, n) => {
  regs.push({ name: `LEDC_${grp}CH${n}_CONF0`,  off: base + 0x14 * n + 0x00 });
  regs.push({ name: `LEDC_${grp}CH${n}_HPOINT`, off: base + 0x14 * n + 0x04 });
  regs.push({ name: `LEDC_${grp}CH${n}_DUTY`,   off: base + 0x14 * n + 0x08 });
  regs.push({ name: `LEDC_${grp}CH${n}_CONF1`,  off: base + 0x14 * n + 0x0c });
  regs.push({ name: `LEDC_${grp}CH${n}_DUTY_R`, off: base + 0x14 * n + 0x10 });
};
for (let n = 0; n < 8; n++) chan('HS', 0x000, n);
for (let n = 0; n < 8; n++) chan('LS', 0x0a0, n);
for (let n = 0; n < 4; n++) {
  regs.push({ name: `LEDC_HSTIMER${n}_CONF`,  off: 0x140 + 8 * n });
  regs.push({ name: `LEDC_HSTIMER${n}_VALUE`, off: 0x144 + 8 * n });
}
for (let n = 0; n < 4; n++) {
  regs.push({ name: `LEDC_LSTIMER${n}_CONF`,  off: 0x160 + 8 * n });
  regs.push({ name: `LEDC_LSTIMER${n}_VALUE`, off: 0x164 + 8 * n });
}
regs.push({ name: 'LEDC_INT_RAW', off: 0x180 });
regs.push({ name: 'LEDC_INT_ST',  off: 0x184 });
regs.push({ name: 'LEDC_INT_ENA', off: 0x188 });
regs.push({ name: 'LEDC_INT_CLR', off: 0x18c });
regs.push({ name: 'LEDC_CONF',    off: 0x190 });

// ------------------------------------------------- minimal GDB-RSP client
const csum = (s) => [...s].reduce((a, c) => (a + c.charCodeAt(0)) & 0xff, 0).toString(16).padStart(2, '0');
class Rsp {
  constructor(sock) { this.sock = sock; this.buf = ''; this.waiters = []; sock.on('data', (d) => this.onData(d)); }
  onData(d) {
    this.buf += d.toString('latin1');
    for (;;) {
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
const connect = (port) => new Promise((resolve, reject) => {
  let tries = 0;
  const go = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', (e) => (++tries > 80 ? reject(e) : setTimeout(go, 100)));
  };
  go();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leHexToInt = (h) => parseInt((h.match(/../g) ?? []).reverse().join(''), 16);

function decode(v) {
  if (!v.raw) return '';
  if (/TIMER\d_CONF$/.test(v.name)) {
    const bits = v.raw >>> 0;
    const dutyRes = bits & 0x1f;              // LEDC_*TIMERx_DUTY_RES  [4:0]
    const div = (bits >>> 5) & 0x3ffff;       // LEDC_*TIMERx_DIV_NUM  [22:5], Q10.8
    const pause = (bits >>> 23) & 1;
    const rst = (bits >>> 24) & 1;
    // TICK_SEL polarity is the easy thing to get backwards. ESP-IDF's own HAL,
    // hal/esp32/include/hal/ledc_ll.h:233, writes
    //     conf.tick_sel = (clk_src == LEDC_APB_CLK)
    // so 0 == REF_TICK (1 MHz) and 1 == APB_CLK (80 MHz).
    const tick = (bits >>> 25) & 1;
    const srcHz = tick ? 80e6 : 1e6;
    const paraUp = (bits >>> 26) & 1;         // low-speed timers only
    const f = div ? srcHz / ((div / 256) * (1 << dutyRes)) : NaN;
    return `duty_res=${dutyRes}b div_num=${div} (=${(div / 256).toFixed(5)}) tick_sel=${tick}=${tick ? 'APB/80MHz' : 'REF_TICK/1MHz'} pause=${pause} rst=${rst} para_up=${paraUp} => ${f.toFixed(3)} Hz`;
  }
  if (/CH\d_CONF0$/.test(v.name)) {
    return `timer_sel=${v.raw & 3} sig_out_en=${(v.raw >>> 2) & 1} idle_lv=${(v.raw >>> 3) & 1}`
      + (/LSCH/.test(v.name) ? ` para_up=${(v.raw >>> 4) & 1}` : '');
  }
  return '';
}

// ------------------------------------------------- independent expectation
// What a REAL LEDC channel would be carrying, computed from the library source
// rather than from the emulator, so the two can be compared.
//   ESP32Servo 3.0.9 ESP32Servo.h:98   MAX_PULSE_WIDTH 2500
//   ESP32Servo.cpp:125-127             attach() clamps max to MAX_PULSE_WIDTH,
//                                      so attach(pin, 732, 2929) really means 732..2500 us
//   ESP32Servo.h:85-93                 DEFAULT_TIMER_WIDTH 10 -> 1024 ticks
//   ESP32Servo.cpp:260                 usToTicks(us) = (int)(us / (20000 / 1024))
const REFRESH_USEC = 20000;
const TICKS = 1024;
const SERVO_MIN_US = 732;
const SERVO_MAX_US = 2500;      // 2929 requested, clamped by MAX_PULSE_WIDTH
const amap = (x, a, b, c, d) => c + Math.trunc((x - a) * (d - c) / (b - a));
function expected(angleDeg) {
  const us = amap(angleDeg, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  const ticks = Math.trunc(us / (REFRESH_USEC / TICKS));
  return {
    us, ticks,
    realUs: (ticks / TICKS) * REFRESH_USEC,
    realPct: (ticks / TICKS) * 100,
    // esp32_ledc_write()'s arithmetic: duty * 100 / ((1 << duty_res) - 1)
    modelPct: Math.floor((ticks * 100) / ((1 << 10) - 1)),
  };
}

// ------------------------------------------------------------------- run
async function attempt() {
  const tracePath = path.join(LOGS, `${TAG}-trace.log`);
  const uartPath = path.join(LOGS, `${TAG}-uart.log`);
  let uart = '';
  const qemu = spawn(QEMU, [
    '-nographic', '-machine', 'esp32',
    '-drive', `file=${IMAGE},if=mtd,format=raw,snapshot=on`,
    '-d', 'trace:led_set_intensity', '-D', tracePath,
    '-gdb', `tcp::${PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => { uart += d.toString('latin1'); };
  qemu.stdout.on('data', onData);
  qemu.stderr.on('data', onData);
  const kill = () => { try { qemu.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);

  const deadline = Date.now() + SECONDS * 1000;
  let booted = false;
  while (Date.now() < deadline) {
    if (/Guru Meditation|SW_CPU_RESET/.test(uart)) { kill(); return { ok: false, why: 'panic' }; }
    if (/HTTP server & Captive Portal started\./.test(uart)) booted = true;
    if (booted && (uart.match(/@SESAME servo/g) ?? []).length >= 29) break;
    await sleep(200);
  }
  if (!booted) { kill(); return { ok: false, why: 'no banner' }; }

  // Attaching to QEMU's gdbstub vm_stop()s the machine, so everything read
  // below is a snapshot of the peripheral as the firmware left it.
  const sock = await connect(PORT);
  const rsp = new Rsp(sock);
  await rsp.send('QStartNoAckMode').catch(() => {});
  await rsp.send('?');
  const pc = leHexToInt(await rsp.send('p0'));

  const values = [];
  for (const r of regs) {
    const reply = await rsp.send(`m${(BASE + r.off).toString(16)},4`);
    const bad = /^E/.test(reply);
    values.push({ ...r, raw: bad ? null : leHexToInt(reply), err: bad ? reply : null });
  }
  try { sock.destroy(); } catch { /* closing */ }
  kill();
  await sleep(200);
  fs.writeFileSync(uartPath, uart);
  const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '';
  return { ok: true, uart, values, pc, trace };
}

let res = null;
for (let i = 1; i <= ATTEMPTS; i++) {
  res = await attempt();
  console.log(`[q3] boot attempt ${i}: ${res.ok ? 'ok' : `failed (${res.why})`}`);
  if (res.ok) break;
  await sleep(300);
}
if (!res?.ok) { console.error('[q3] no clean boot within the retry budget'); process.exit(1); }

console.log(`\nhalted at PC 0x${res.pc.toString(16)}`);
console.log(`\n=== LEDC register file, read back through esp32_ledc_read() @ 0x${BASE.toString(16)} ===`);
const nz = res.values.filter((v) => v.raw);
console.log(`${res.values.length} registers read, ${nz.length} non-zero\n`);
for (const v of res.values) {
  const flag = v.err ? `ERR ${v.err}` : `0x${(v.raw >>> 0).toString(16).padStart(8, '0')}`;
  const note = decode(v);
  console.log(`  0x${v.off.toString(16).padStart(3, '0')}  ${v.name.padEnd(22)}  ${flag}${note ? '   ' + note : ''}`);
}

const traceLines = res.trace.match(/led_set_intensity[^\n]*/g) ?? [];
const pcts = traceLines.map((l) => Number(/intensity:\s*(\d+)%/.exec(l)?.[1] ?? -1));
const servo = res.uart.match(/@SESAME servo \w+ \d+/g) ?? [];
console.log('\n=== led_set_intensity trace events (the LEDC model\'s only output) ===');
console.log(`${traceLines.length} trace events vs ${servo.length} @SESAME servo lines from the firmware hook`);
const attachN = pcts.length - servo.length;
console.log(`(first ${attachN} are attach()-time writes)\n`);
console.log('   #  joint  angle |  QEMU duty% | expected: pulse us  ticks  true duty%  model duty%  match');
let mismatches = 0;
const rows = [];
for (let i = 0; i < servo.length; i++) {
  const m = /@SESAME servo (\w+) (\d+)/.exec(servo[i]);
  const joint = m[1], angle = Number(m[2]);
  const e = expected(angle);
  const got = pcts[attachN + i];
  const ok = got === e.modelPct;
  if (!ok) mismatches++;
  rows.push({ joint, angle, qemuPct: got, ...e, match: ok });
  console.log(`  ${String(i + 1).padStart(2)}  ${joint.padEnd(4)} ${String(angle).padStart(5)} | ${String(got).padStart(9)}% | ${String(e.realUs.toFixed(1)).padStart(16)}  ${String(e.ticks).padStart(5)}  ${e.realPct.toFixed(3).padStart(9)}%  ${String(e.modelPct).padStart(10)}%  ${ok ? 'ok' : 'MISMATCH'}`);
}
console.log(`\n${servo.length - mismatches}/${servo.length} duty percentages match the TRM formula applied to ESP32Servo's own arithmetic`);

fs.writeFileSync(path.join(LOGS, `${TAG}.json`), JSON.stringify({
  image: IMAGE, base: BASE, pc: res.pc,
  registers: res.values.map((v) => ({ ...v, hex: v.raw === null ? null : `0x${(v.raw >>> 0).toString(16).padStart(8, '0')}` })),
  ledSetIntensityPercents: pcts, servoTelemetry: servo, comparison: rows,
}, null, 2));
console.log(`\nlogs: emulator/qemu/logs/${TAG}.json, ${TAG}-trace.log, ${TAG}-uart.log`);
