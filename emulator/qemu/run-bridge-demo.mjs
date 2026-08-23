#!/usr/bin/env node
/**
 * Q1 - end-to-end: Espressif QEMU -> UART0 over TCP -> the EXISTING Phase-0
 * bridge -> WebSocket telemetry envelopes.
 *
 * The point of this script is what it does NOT contain: there is no QEMU-aware
 * code in the bridge, and no bridge-aware code in QEMU. Renode exposed UART0
 * with `emulation CreateServerSocketTerminal 3456`; QEMU exposes it with
 * `-serial tcp:127.0.0.1:3456,server=on,wait=off`. Both are a TCP server
 * speaking raw bytes, which is the only thing the bridge ever required.
 *
 * The bridge is run from emulator/bridge/dist AS BUILT - unmodified.
 *
 * Usage: node emulator/qemu/run-bridge-demo.mjs [--image <flash.bin>]
 *                                               [--seconds 25] [--uart-port 3456]
 *                                               [--ws-port 8791]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

const QEMU = path.join(REPO, 'tools', 'qemu', 'qemu', 'bin', 'qemu-system-xtensa.exe');
const BRIDGE = path.join(REPO, 'emulator', 'bridge', 'dist', 'cli.js');
const IMAGE = path.resolve(arg('image', path.join(REPO, 'emulator/qemu/images/distro-v1-esp32-nowifi.flash.bin')));
// Ports are picked by asking the OS for a free one unless overridden, because
// this repo already has other agents' dev servers on the usual numbers.
const freePort = async () => await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const UART_PORT = Number(arg('uart-port', '0')) || await freePort();
const WS_PORT = Number(arg('ws-port', '0')) || await freePort();
const SECONDS = Number(arg('seconds', '25'));
const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');
fs.mkdirSync(LOGS, { recursive: true });

for (const [n, p] of [['qemu', QEMU], ['bridge', BRIDGE], ['image', IMAGE]]) {
  if (!fs.existsSync(p)) { console.error(`missing ${n}: ${p}`); process.exit(2); }
}
// `ws` is a dependency of the bridge package, not of this script.
const require = createRequire(path.join(REPO, 'emulator', 'bridge', 'package.json'));
const WebSocket = require('ws');

const kids = [];
const killAll = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. QEMU, with UART0 published as a TCP server instead of stdio.
const qemu = spawn(QEMU, [
  '-display', 'none', '-machine', 'esp32',
  '-drive', `file=${IMAGE},if=mtd,format=raw`,
  '-serial', `tcp:127.0.0.1:${UART_PORT},server=on,wait=off`,
], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(qemu);
const qemuLog = fs.createWriteStream(path.join(LOGS, 'bridge-demo.qemu.log'));
qemu.stdout.pipe(qemuLog); qemu.stderr.pipe(qemuLog);
console.log(`[q1] qemu serving UART0 on tcp/${UART_PORT}`);
await sleep(1500);

// 2. The Phase-0 bridge, unmodified, pointed at that socket.
const bridge = spawn(process.execPath, [
  BRIDGE, '--uart-host', '127.0.0.1', '--uart-port', String(UART_PORT),
  '--ws-port', String(WS_PORT), '--provenance', 'observed',
], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(bridge);
const bridgeLog = fs.createWriteStream(path.join(LOGS, 'bridge-demo.bridge.log'));
bridge.stdout.pipe(bridgeLog); bridge.stderr.pipe(bridgeLog);
bridge.stderr.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
await sleep(2000);

// 3. A plain WebSocket client - what apps/web would be.
const envelopes = [];
const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/telemetry`);
ws.on('message', (m) => { try { envelopes.push(JSON.parse(m.toString())); } catch { /* not json */ } });
ws.on('error', (e) => console.error('[ws] ', e.message));
await new Promise((r) => { ws.once('open', r); ws.once('error', r); });
console.log(`[q1] websocket client attached to ws://127.0.0.1:${WS_PORT}/telemetry`);

await sleep(SECONDS * 1000);
try { ws.close(); } catch { /* closing */ }
killAll();

fs.writeFileSync(path.join(LOGS, 'bridge-demo.envelopes.jsonl'),
  envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n');

const byType = new Map();
for (const e of envelopes) {
  const t = e?.type ?? e?.event?.type ?? e?.kind ?? 'unknown';
  byType.set(t, (byType.get(t) ?? 0) + 1);
}
console.log(`\n=== ${envelopes.length} envelopes over the WebSocket ===`);
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${t}`);
console.log('\nfirst 6:');
for (const e of envelopes.slice(0, 6)) console.log('  ' + JSON.stringify(e));
const servo = envelopes.filter((e) => JSON.stringify(e).includes('servo'));
console.log(`\nservo-bearing envelopes: ${servo.length}`);
for (const e of servo.slice(0, 4)) console.log('  ' + JSON.stringify(e));
console.log('\nlogs: emulator/qemu/logs/bridge-demo.{qemu,bridge}.log, .envelopes.jsonl');
