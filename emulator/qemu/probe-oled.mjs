#!/usr/bin/env node
/**
 * EXP6-QEMU — does the OLED framebuffer hook actually RUN, and what does it cost?
 *
 * EXP6 proved the `SESAME_TELEMETRY_OLED` hook compiles, links, keeps its
 * symbols and round-trips through the real parser. It had never been executed:
 * there is no board, and the s2mini profile it was proven on has no QEMU
 * machine. `distro-v1-esp32-cli-oled` is the V1 equivalent, and this script is
 * the thing that runs it.
 *
 * Three questions, three sections of output:
 *
 * 1. **Does it run?**  Boot the image and count `@SESAME oled b64` lines.
 * 2. **What does it cost?**  EXP6 priced one frame at ~120 ms of WIRE time at
 *    115200 8N1. Under QEMU UART0 is a TCP socket with no baud rate at all, so
 *    that number does not transfer and must be re-measured rather than assumed
 *    in either direction. Two independent measurements are taken:
 *      - wire span: first byte to newline of each oled line, from the socket;
 *      - guest cost: the SAME fenced workload run against the baseline `cli`
 *        image and the `cli-oled` image, differenced. This is the only number
 *        that answers "does the hook steal servo-loop time", because it is
 *        measured through the firmware's own completion barrier.
 * 3. **Are the pixels real?**  Every received 1024-byte frame is compared
 *    byte-for-byte against `Adafruit_GFX::drawBitmap` applied to the authored
 *    array in firmware/upstream/firmware/face-bitmaps.h — parsed here, from the
 *    header the firmware compiled, NOT from apps/web's generated module. If the
 *    guest's framebuffer and the authored bitmap disagree, that is the finding.
 *
 * Nothing here types the wire contract by hand: the payload is decoded with the
 * real `SesameTelemetryParser` and `decodeOledFrame` from
 * @sesame-lab/sesame-protocol, exactly as the app would.
 *
 * Tolerates ISSUE-20260823-022 (~28% per-boot cache panic) by retrying.
 *
 * Usage:
 *   node emulator/qemu/probe-oled.mjs [--image <flash.bin>] [--baseline <flash.bin>]
 *                                     [--attempts 12] [--face happy] [--json]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = parseArgs({
  name: 'probe-oled.mjs',
  summary: 'Run the SESAME_TELEMETRY_OLED hook under QEMU: does it fire, what does it cost, are the pixels right?',
  flags: {
    image:    { describe: 'flash image with the OLED hook', default: 'emulator/qemu/images/distro-v1-esp32-cli-oled.flash.bin' },
    baseline: { describe: 'flash image without it, for the A/B cost', default: 'emulator/qemu/images/distro-v1-esp32-cli.flash.bin' },
    attempts: { describe: 'boot attempts (ISSUE-20260823-022 retry budget)', type: 'number', default: 12 },
    face:     { describe: 'single-frame face to use for the byte-for-byte check', default: 'happy' },
    repeats:  { describe: 'fenced workload repetitions per image', type: 'number', default: 3 },
    json:     { describe: 'write JSON evidence to emulator/qemu/logs/', type: 'boolean', default: false },
  },
});
const arg = (n, d) => (opts[n] === undefined || opts[n] === '' ? d : opts[n]);

const QEMU = path.join(REPO, 'tools', 'qemu', 'qemu', 'bin', 'qemu-system-xtensa.exe');
const IMAGE = path.resolve(REPO, String(arg('image', 'emulator/qemu/images/distro-v1-esp32-cli-oled.flash.bin')));
const BASELINE = path.resolve(REPO, String(arg('baseline', 'emulator/qemu/images/distro-v1-esp32-cli.flash.bin')));
const ATTEMPTS = Number(arg('attempts', 12));
const FACE = String(arg('face', 'happy'));
const REPEATS = Number(arg('repeats', 3));
const LOGS = path.join(REPO, 'emulator', 'qemu', 'logs');

const proto = await import('../../packages/sesame-protocol/dist/index.js');
const {
  BARRIER_COMMAND, BARRIER_MARKER, CLI_TERMINATOR,
  SesameTelemetryParser, decodeOledFrame,
  OLED_FRAME_BYTES, OLED_WIDTH, OLED_HEIGHT, setOledPixel,
} = proto;

const BOOT_BANNER = 'HTTP server & Captive Portal started.';
const PANICS = [
  /Cache disabled but cached memory region accessed/,
  /Guru Meditation Error/,
  /assert failed:/,
  /rst:0x[0-9a-f]+ \(SW_CPU_RESET\)/,
];

for (const [n, p] of [['qemu', QEMU], ['image', IMAGE]]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${n}: ${p}`);
    if (n === 'image') console.error('build it: node emulator/qemu/build-qemu-images.mjs cli-oled');
    process.exit(3);
  }
}

// ===========================================================================
// The expected framebuffer, derived from the header the firmware compiled
// ===========================================================================

/**
 * Parse `const unsigned char epd_bitmap_<name> [] PROGMEM = { 0x.., ... };`
 * out of face-bitmaps.h. Deliberately independent of apps/web's generated
 * face-bitmaps.ts: if both sides read the same generated artefact, a bug in the
 * generator would agree with itself.
 */
function readAuthoredBitmaps(headerPath) {
  const src = fs.readFileSync(headerPath, 'utf8');
  const out = new Map();
  const re = /epd_bitmap_([A-Za-z0-9_]+)\s*\[\]\s*PROGMEM\s*=\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const bytes = [...m[2].matchAll(/0x([0-9a-fA-F]{2})/g)].map((h) => parseInt(h[1], 16));
    out.set(m[1], Uint8Array.from(bytes));
  }
  return out;
}

/**
 * `display.clearDisplay(); display.drawBitmap(0,0,bmp,128,64,SSD1306_WHITE);`
 *
 * The authored array is row-major, MSB first, 16 bytes per row. The 6-argument
 * drawBitmap overload draws only SET bits, and clearDisplay() zeroes the
 * buffer, so the result is the bitmap and nothing else. `setOledPixel` is the
 * protocol package's own page-order writer — the page arithmetic is not
 * re-implemented here.
 */
function renderAuthoredBitmap(authored) {
  if (authored.length !== OLED_FRAME_BYTES) {
    throw new Error(`authored bitmap is ${authored.length} bytes, expected ${OLED_FRAME_BYTES}`);
  }
  const gddram = new Uint8Array(OLED_FRAME_BYTES);
  for (let y = 0; y < OLED_HEIGHT; y++) {
    for (let x = 0; x < OLED_WIDTH; x++) {
      const byte = authored[y * 16 + (x >> 3)] ?? 0;
      if ((byte & (0x80 >> (x & 7))) !== 0) setOledPixel(gddram, x, y, true);
    }
  }
  return gddram;
}

const AUTHORED = readAuthoredBitmaps(path.join(REPO, 'firmware', 'upstream', 'firmware', 'face-bitmaps.h'));

/** `face_<name>_frames` is { epd_bitmap_<name>, _1.._5 } truncated at the first null. */
function faceFrames(name) {
  const frames = [];
  const base = AUTHORED.get(name);
  if (base === undefined) return frames;
  frames.push(base);
  for (let i = 1; i <= 5; i++) {
    const f = AUTHORED.get(`${name}_${i}`);
    if (f === undefined) break;
    frames.push(f);
  }
  return frames;
}

const countBits = (n) => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
function diffPixels(a, b) {
  let n = 0;
  for (let i = 0; i < OLED_FRAME_BYTES; i++) n += countBits((a[i] ?? 0) ^ (b[i] ?? 0));
  return n;
}
function firstDifferingByte(a, b) {
  for (let i = 0; i < OLED_FRAME_BYTES; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ===========================================================================
// One QEMU session
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * A booted guest with UART0 attached, byte-level receive timestamps, and the
 * real telemetry parser running alongside.
 */
class Probe {
  constructor(image) { this.image = image; }

  async start(attempts) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ok = await this.#boot();
      if (ok) { this.attempt = attempt; return; }
      await this.stop();
      process.stderr.write(`[oled] boot attempt ${attempt} failed (${this.failure}) - retrying\n`);
    }
    throw new Error(`no clean boot in ${attempts} attempts (last: ${this.failure})`);
  }

  async #boot() {
    this.port = await freePort();
    this.banner = false;
    this.failure = null;
    this.tail = '';
    this.barriers = 0;
    this.events = [];
    this.lines = [];          // { text, firstMs, lastMs, bytes }
    this.#pending = '';
    this.#pendingFirstMs = 0;
    this.parser = new SesameTelemetryParser({ defaultProvenance: 'observed' });
    this.exited = false;

    this.child = spawn(QEMU, [
      '-display', 'none', '-machine', 'esp32',
      '-drive', `file=${this.image},if=mtd,format=raw,snapshot=on`,
      '-serial', `tcp:127.0.0.1:${this.port},server=on,wait=off`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    this.child.once('exit', () => { this.exited = true; });

    const deadline = Date.now() + 20000;
    this.socket = await this.#attach(deadline);
    if (this.socket === null) { this.failure = 'no UART0'; return false; }
    this.t0 = Date.now();
    this.socket.on('data', (c) => this.#ingest(c));
    this.socket.on('error', () => undefined);

    while (!this.banner) {
      if (this.failure !== null) return false;
      if (this.exited) { this.failure = 'qemu exited'; return false; }
      if (Date.now() > deadline) { this.failure = 'boot timeout'; return false; }
      await sleep(20);
    }
    return true;
  }

  async #attach(deadline) {
    for (;;) {
      if (this.exited || Date.now() > deadline) return null;
      const s = await new Promise((resolve) => {
        const c = net.createConnection({ host: '127.0.0.1', port: this.port });
        c.setNoDelay(true);
        c.once('connect', () => resolve(c));
        c.once('error', () => { c.destroy(); resolve(null); });
      });
      if (s !== null) return s;
      await sleep(10);
    }
  }

  #pending = '';
  #pendingFirstMs = 0;

  /**
   * Raw framing with per-line arrival timestamps, alongside the real parser.
   *
   * The timestamps are the whole reason this is not just `parser.push()`:
   * "1385 bytes cost 120 ms" is a claim about how long the bytes take to cross
   * the transport, and only the socket can answer it.
   */
  #ingest(chunk) {
    const now = Date.now();
    const text = chunk.toString('latin1');
    this.tail = (this.tail + text).slice(-8192);
    if (!this.banner && this.tail.includes(BOOT_BANNER)) this.banner = true;
    if (this.failure === null) {
      for (const p of PANICS) if (p.test(this.tail)) { this.failure = p.source.slice(0, 40); break; }
    }

    let rest = text;
    for (;;) {
      const nl = rest.indexOf('\n');
      if (nl < 0) {
        if (rest.length > 0 && this.#pending.length === 0) this.#pendingFirstMs = now;
        this.#pending += rest;
        break;
      }
      if (this.#pending.length === 0) this.#pendingFirstMs = now;
      const text2 = this.#pending + rest.slice(0, nl);
      this.lines.push({
        text: text2.replace(/\r$/, ''),
        firstMs: this.#pendingFirstMs - this.t0,
        lastMs: now - this.t0,
        bytes: text2.length + 1,
      });
      this.#pending = '';
      rest = rest.slice(nl + 1);
    }

    for (const event of this.parser.push(chunk)) {
      event.__atMs = now - this.t0;
      if (event.type === 'log' && event.text.startsWith(BARRIER_MARKER)) this.barriers += 1;
      this.events.push(event);
    }
  }

  /** Write CLI lines and wait for the firmware's own completion barrier. */
  async fenced(lines, timeoutMs = 60000) {
    const want = this.barriers + 1;
    const started = Date.now();
    this.socket.write(`${lines.map((l) => l + CLI_TERMINATOR).join('')}${BARRIER_COMMAND}${CLI_TERMINATOR}`);
    while (this.barriers < want) {
      if (this.failure !== null) throw new Error(`guest died: ${this.failure}`);
      if (this.exited) throw new Error('qemu exited mid-command');
      if (Date.now() - started > timeoutMs) throw new Error(`barrier timeout on ${lines.join(';')}`);
      await sleep(5);
    }
    return Date.now() - started;
  }

  async stop() {
    try { this.socket?.destroy(); } catch { /* gone */ }
    try { this.child?.kill('SIGKILL'); } catch { /* gone */ }
    if (this.child && !this.exited) {
      await new Promise((r) => { this.child.once('exit', r); setTimeout(r, 4000).unref?.(); });
    }
  }

  oledLines() { return this.lines.filter((l) => l.text.startsWith('@SESAME oled ')); }
  oledEvents() { return this.events.filter((e) => e.type === 'oled.frame'); }
  faceEvents() { return this.events.filter((e) => e.type === 'face.expression'); }
}

// ===========================================================================
// Run
// ===========================================================================

const report = { image: path.relative(REPO, IMAGE), baseline: path.relative(REPO, BASELINE) };
const say = (s) => process.stdout.write(`${s}\n`);

say('');
say('=== EXP6-QEMU: the OLED framebuffer hook, running ===');
say(`image     ${report.image}`);
say(`baseline  ${report.baseline}`);
say('');

const oled = new Probe(IMAGE);
await oled.start(ATTEMPTS);
say(`[boot] OK on attempt ${oled.attempt}, UART0 on 127.0.0.1:${oled.port}`);

// --- 1. does it fire at all? -----------------------------------------------
// setup() ends with setFace("rest"); `rest` has three frames at 1 fps, so the
// panel keeps redrawing on its own. Watch it for a few seconds untouched.
await sleep(6000);
const bootOled = oled.oledLines();
report.bootFrames = bootOled.length;
say('');
say(`[1] fires: ${bootOled.length} @SESAME oled lines in the first ${Math.round(bootOled.at(-1)?.lastMs ?? 0)} ms of session`);
if (bootOled.length === 0) {
  say('    NONE. The hook did not run. Everything below is moot.');
}

// --- 2. wire span ----------------------------------------------------------
const spans = bootOled.map((l) => l.lastMs - l.firstMs);
const bytes = bootOled.map((l) => l.bytes);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
report.lineBytes = bytes[0] ?? null;
report.wireSpanMs = { min: Math.min(...spans), median: median(spans), max: Math.max(...spans) };
say('');
say(`[2a] wire: ${report.lineBytes} bytes per line; socket span min ${report.wireSpanMs.min} ms, ` +
    `median ${report.wireSpanMs.median} ms, max ${report.wireSpanMs.max} ms`);
say(`     EXP6 priced the same line at ~120 ms of 115200 8N1 wire time. That rate does not exist here.`);

// --- 3. byte-for-byte against the authored bitmap --------------------------
// A single-frame face: setFace() draws it once and updateAnimatedFace() returns
// immediately for frameCount <= 1, so exactly one frame is expected and the
// comparison has no animation phase to guess at.
say('');
const before = oled.oledEvents().length;
await oled.fenced([`fc ${FACE}`]);
await sleep(1500);
const after = oled.oledEvents();
const faceFrame = after.slice(before).at(-1) ?? null;
const expectedFrames = faceFrames(FACE);
report.face = FACE;
report.faceFrameCount = expectedFrames.length;

if (faceFrame === null) {
  say(`[3] NO oled.frame after \`fc ${FACE}\` - cannot compare`);
  report.byteForByte = 'no-frame';
} else if (expectedFrames.length === 0) {
  say(`[3] face-bitmaps.h has no epd_bitmap_${FACE} - cannot compare`);
  report.byteForByte = 'no-bitmap';
} else {
  const got = decodeOledFrame(faceFrame.pixels);
  const want = renderAuthoredBitmap(expectedFrames[0]);
  const differing = diffPixels(got, want);
  const at = firstDifferingByte(got, want);
  report.byteForByte = { bytes: got.length, differingPixels: differing, firstDifferingByte: at };
  say(`[3] byte-for-byte vs drawBitmap(epd_bitmap_${FACE}): ` +
      (at < 0
        ? `IDENTICAL over all ${got.length} bytes`
        : `DIFFERS - first at byte ${at}, ${differing} pixels of 8192`));
}

// Every frame the session has seen, matched against the expected frame table.
const allChecks = [];
for (const e of oled.oledEvents()) {
  const nearestFace = oled.faceEvents().filter((f) => (f.__atMs ?? 0) <= (e.__atMs ?? 0)).at(-1);
  const name = nearestFace?.name ?? '';
  const idx = nearestFace?.frame ?? 0;
  const frames = faceFrames(name);
  if (frames.length === 0) { allChecks.push({ name, idx, verdict: 'no-bitmap' }); continue; }
  const want = renderAuthoredBitmap(frames[Math.min(idx, frames.length - 1)]);
  const got = decodeOledFrame(e.pixels);
  allChecks.push({ name, idx, verdict: firstDifferingByte(got, want) < 0 ? 'identical' : `differs:${diffPixels(got, want)}px` });
}
const identical = allChecks.filter((c) => c.verdict === 'identical').length;
report.allFrames = { total: allChecks.length, identical, other: allChecks.filter((c) => c.verdict !== 'identical') };
say(`    across the whole session: ${identical}/${allChecks.length} frames byte-identical to the ` +
    `authored bitmap they claim to be`);
for (const c of report.allFrames.other) say(`      ${c.name}[${c.idx}] -> ${c.verdict}`);

// --- 4. A/B guest cost through the firmware's own barrier ------------------
// The number that matters: does emitting a frame steal servo-loop time?
//
// `rn wv` and NOT `run wave` — the console's dispatch table (ino:796) has no
// `run wave` entry at all, so that string falls through to the `sscanf("%d %d")`
// arm and does nothing, returning in ~5 ms. The abbreviation is the one the
// firmware actually implements: setFaceWithMode("wave") then ~30 setServoAngle()
// calls, each paying delayWithFace(motorCurrentDelay = 20 ms), plus five
// explicit delayWithFace(200..300). Several seconds of real choreography, with
// updateFaceBitmap() re-entered from inside every one of those delays — the
// exact hot path EXP6 was worried about.
say('');
const WORKLOAD = ['rn wv'];
async function measure(probe, label) {
  const runs = [];
  const before = { oled: probe.oledLines().length, face: probe.faceEvents().length, servo: probe.events.filter((e) => e.type === 'servo.target').length };
  for (let i = 0; i < REPEATS; i++) runs.push(await probe.fenced(WORKLOAD, 180000));
  const during = {
    oled: probe.oledLines().length - before.oled,
    face: probe.faceEvents().length - before.face,
    servo: probe.events.filter((e) => e.type === 'servo.target').length - before.servo,
  };
  say(`[4] ${label}: ${runs.map((r) => `${r} ms`).join(', ')}  (median ${median(runs)} ms)`);
  say(`    during: ${during.servo} servo events, ${during.face} face frames drawn, ${during.oled} oled frames emitted`);
  return { runs, median: median(runs), during };
}

/**
 * The isolated per-frame cost, which the `rn wv` A/B can only bound.
 *
 * `fc happy` / `fc sad` alternate because setFace() early-returns on the same
 * name (ino:904). Both are single-frame faces, so each line is exactly one
 * updateFaceBitmap() and updateAnimatedFace() stays out of it entirely
 * (frameCount <= 1 returns immediately, ino:957). Spaced past
 * SESAME_TELEMETRY_OLED_MIN_MS so the throttle never suppresses one, and fenced
 * by `subtrim` so each timing is guest work plus the wire drain that precedes
 * the barrier - which is the whole cost a consumer actually pays.
 */
async function measureOneFrame(probe, label, n) {
  const runs = [];
  const oledBefore = probe.oledLines().length;
  for (let i = 0; i < n; i++) {
    await sleep(600);
    runs.push(await probe.fenced([`fc ${i % 2 === 0 ? 'happy' : 'sad'}`], 60000));
  }
  const emitted = probe.oledLines().length - oledBefore;
  say(`[6] ${label}: ${n} single-frame face sets, median ${median(runs)} ms, ` +
      `mean ${(runs.reduce((a, b) => a + b, 0) / runs.length).toFixed(1)} ms (${emitted} oled frames)`);
  return { runs, median: median(runs), mean: runs.reduce((a, b) => a + b, 0) / runs.length, emitted };
}
const withHook = await measure(oled, 'cli-oled');
const oneFrameHook = await measureOneFrame(oled, 'cli-oled', 12);
await oled.stop();

let withoutHook = null;
let oneFrameBase = null;
if (fs.existsSync(BASELINE)) {
  const base = new Probe(BASELINE);
  await base.start(ATTEMPTS);
  say(`[boot] baseline OK on attempt ${base.attempt}`);
  await sleep(6000);
  withoutHook = await measure(base, 'cli (no hook)');
  oneFrameBase = await measureOneFrame(base, 'cli (no hook)', 12);
  report.baselineOledLines = base.oledLines().length;
  await base.stop();
} else {
  say(`[4] baseline image missing (${report.baseline}) - no A/B`);
}

report.workload = WORKLOAD;
report.withHook = withHook;
report.withoutHook = withoutHook;
if (withoutHook !== null) {
  const perRunFrames = withHook.during.oled / REPEATS;
  const delta = (withHook.median - withoutHook.median);
  const perFrame = perRunFrames > 0 ? delta / perRunFrames : null;
  report.deltaMs = delta;
  report.framesPerRun = perRunFrames;
  report.perFrameMs = perFrame;
  // The throttle's own cost: face frames the firmware DREW but did not emit,
  // because SESAME_TELEMETRY_OLED_MIN_MS had not elapsed. Every one of those is
  // a panel update the host never sees.
  report.throttleDropped = withHook.during.face - withHook.during.oled;
  say('');
  say(`[4] delta ${delta >= 0 ? '+' : ''}${delta} ms per \`${WORKLOAD.join('; ')}\` ` +
      `(${perRunFrames.toFixed(1)} oled frames per run)` +
      (perFrame === null ? '' : ` => ${perFrame.toFixed(1)} ms per frame`));
  say(`    baseline emitted ${report.baselineOledLines} oled lines, which must be 0.`);
  say(`[5] throttle: ${withHook.during.face} frames drawn, ${withHook.during.oled} emitted ` +
      `=> ${report.throttleDropped} suppressed by SESAME_TELEMETRY_OLED_MIN_MS`);
}
if (oneFrameBase !== null) {
  report.oneFrame = { withHook: oneFrameHook, without: oneFrameBase };
  report.oneFrameDeltaMs = { median: oneFrameHook.median - oneFrameBase.median,
                             mean: oneFrameHook.mean - oneFrameBase.mean };
  say('');
  say(`[6] isolated per-frame cost: ${report.oneFrameDeltaMs.median} ms (median), ` +
      `${report.oneFrameDeltaMs.mean.toFixed(1)} ms (mean) - vs EXP6's ~120 ms of 115200-baud wire time`);
}

say('');
if (report.json !== false && arg('json', false)) {
  fs.mkdirSync(LOGS, { recursive: true });
  const out = path.join(LOGS, 'probe-oled.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  say(`json: ${path.relative(REPO, out)}`);
}
const pixelsOk = report.byteForByte !== 'no-frame' && report.byteForByte !== 'no-bitmap'
  && report.byteForByte.firstDifferingByte < 0;
say(pixelsOk
  ? 'VERDICT: the hook runs under QEMU and the pixels are the guest\'s own framebuffer.'
  : 'VERDICT: see above - the pixels do NOT match the authored bitmap.');
process.exit(pixelsOk ? 0 : 1);
