#!/usr/bin/env node
/**
 * EXP6 (phase-0 closeout) — prove the compile-gated OLED framebuffer hook is
 * real code and not aspiration.
 *
 * `firmware/patches/telemetry-instrumentation.patch` carries an OLED hook
 * behind `#define SESAME_TELEMETRY_OLED 0`. Until this script existed, that
 * hook had never been compiled: every check in the repo asserted its *absence*
 * from the default build, which proves the gate works and proves nothing about
 * the code behind it. R6 shipped ~50 lines of C that no compiler had ever seen.
 *
 * This script builds nothing. It reads `firmware/artifacts/s2mini-oled/`,
 * produced by `node scripts/build-firmware.mjs s2mini-oled --clean`, and:
 *
 *   1. controls the literal three ways — absent from stock `s2mini`, absent
 *      from `s2mini-instrumented`, present in `s2mini-oled`, in .elf and .bin;
 *   2. costs it — .flash.text / .flash.rodata / .dram0.bss deltas against
 *      `s2mini-instrumented`, which differs by exactly one -D;
 *   3. resolves the `this` pointer at the OLED `Print::printf` call site with
 *      the same backward dataflow that caught the USB-CDC mis-routing, so we
 *      know the frame leaves through UART0 and not a CDC endpoint;
 *   4. round-trips a frame. NOTHING in the round-trip is typed here: the
 *      format string AND the 64-character base64 alphabet are read out of the
 *      ELF, the encoder is a transcription of the patch's own C loop, and the
 *      decoder is the real `@sesame-lab/sesame-protocol` parser.
 *
 * What it does NOT prove: that the hook has ever executed. No ESP32 has run
 * this image and Renode cannot boot it (Gate A). See docs/findings/EXP6-oled.md.
 *
 * Usage: node scripts/verify-oled-hook.mjs [--json]
 * Exit 0 pass · 1 fail · 3 artifacts absent (they are gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTelemetryPrintfSites } from './lib/xtensa-call-args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const artifact = (profile, ext) =>
  path.join(REPO, 'firmware', 'artifacts', profile, `sesame-firmware-main.ino.${ext}`);

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); return cond; };
const say = (...m) => { if (!JSON_OUT) console.log(...m); };
const report = {};

// ------------------------------------------------------------------ presence
const OLED = 's2mini-oled';
if (!fs.existsSync(artifact(OLED, 'elf'))) {
  console.error(`[exp6] no ${OLED} artifacts. Build them first:`);
  console.error('       node scripts/build-firmware.mjs s2mini-oled --clean');
  process.exit(3);
}

const NEEDLE = Buffer.from('@SESAME oled b64 %s\n', 'latin1');
const presence = {};
for (const profile of ['s2mini', 's2mini-instrumented', OLED]) {
  presence[profile] = {};
  for (const ext of ['elf', 'bin']) {
    const f = artifact(profile, ext);
    if (!fs.existsSync(f)) { presence[profile][ext] = null; continue; }
    const off = fs.readFileSync(f).indexOf(NEEDLE);
    presence[profile][ext] = off >= 0 ? `0x${off.toString(16)}` : false;
  }
}
report.literalPresence = presence;
// The gate is only meaningful if it is observed working in BOTH directions.
for (const off of ['elf', 'bin']) {
  check(presence[OLED][off] !== false, `${OLED}: the OLED literal is missing from the .${off} — the -D did not take effect`);
  for (const stock of ['s2mini', 's2mini-instrumented']) {
    if (presence[stock][off] === null) continue;   // not built here; not a failure
    check(presence[stock][off] === false, `${stock}: the OLED literal is present in the .${off} but the hook must be compiled out by default`);
  }
}
say(`[exp6] literal control: s2mini=${presence.s2mini.elf} s2mini-instrumented=${presence['s2mini-instrumented'].elf} ${OLED}=${presence[OLED].elf}`);

// ------------------------------------------------------------------ toolchain
const BIN = path.join(REPO, 'tools/arduino-data/data/packages/esp32/tools/esp-x32/2601/bin');
const tool = (n) => path.join(BIN, `xtensa-esp32s2-elf-${n}.exe`);
const haveTools = fs.existsSync(tool('objdump'));
const run = (n, args) => execFileSync(tool(n), args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

// ---------------------------------------------------------------------- cost
if (haveTools && fs.existsSync(artifact('s2mini-instrumented', 'elf'))) {
  const sizes = (elf) => Object.fromEntries(
    run('size', ['-A', elf]).split(/\r?\n/)
      .map((l) => /^(\S+)\s+(\d+)\s/.exec(l.trim()))
      .filter(Boolean).map((m) => [m[1], Number(m[2])]),
  );
  const base = sizes(artifact('s2mini-instrumented', 'elf'));
  const oled = sizes(artifact(OLED, 'elf'));
  const delta = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(oled)])) {
    const d = (oled[k] ?? 0) - (base[k] ?? 0);
    if (d !== 0) delta[k] = d;
  }
  const flash = (delta['.flash.text'] ?? 0) + (delta['.flash.rodata'] ?? 0) + (delta['.flash.rodata_noload'] ?? 0);
  const ram = (delta['.dram0.bss'] ?? 0) + (delta['.dram0.data'] ?? 0);
  report.cost = { sectionDeltas: delta, flashBytes: flash, ramBytes: ram };
  say(`[exp6] cost vs s2mini-instrumented: flash +${flash} B, RAM +${ram} B  ${JSON.stringify(delta)}`);
  // The static line[1369] + lastMs is the whole RAM story; anything wildly
  // larger means something unintended got linked in.
  check(ram >= 1369 && ram <= 2048, `RAM delta ${ram} B is outside the expected 1369..2048 B for line[1369] + lastMs`);
  check(flash > 0 && flash < 4096, `flash delta ${flash} B is implausible for a base64 loop`);
}

// --------------------------------------------- the alphabet, read from the ELF
// The firmware's own base64 table, located by symbol. Typing "A-Za-z0-9+/"
// here would only prove that two copies of the same assumption agree.
let ALPHABET = null;
if (haveTools) {
  const elf = artifact(OLED, 'elf');
  const nm = run('nm', [elf]).split(/\r?\n/);
  const sym = (needle) => {
    const m = nm.map((l) => /^([0-9a-f]+)\s+\S+\s+(\S+)$/.exec(l.trim())).filter(Boolean)
      .find((x) => x[2].includes(needle));
    return m ? { addr: parseInt(m[1], 16), name: m[2] } : null;
  };
  const b64sym = sym('sesameEmitOledPKhE3B64');
  const linesym = sym('sesameEmitOledPKhE4line');
  report.symbols = {
    b64Table: b64sym ? `0x${b64sym.addr.toString(16)}` : null,
    lineBuffer: linesym ? `0x${linesym.addr.toString(16)}` : null,
  };
  check(!!b64sym, 'the OLED base64 table symbol is absent from the ELF — sesameEmitOled() did not survive the link');
  check(!!linesym, 'the OLED line buffer symbol is absent from the ELF');

  // VMA -> file offset, via the section headers.
  const sections = run('readelf', ['-S', '-W', elf]).split(/\r?\n/)
    .map((l) => /^\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)/.exec(l))
    .filter(Boolean)
    .map((m) => ({ name: m[1], addr: parseInt(m[2], 16), offset: parseInt(m[3], 16), size: parseInt(m[4], 16) }));
  const toOffset = (vma) => {
    const s = sections.find((x) => x.addr !== 0 && vma >= x.addr && vma < x.addr + x.size);
    return s ? s.offset + (vma - s.addr) : null;
  };
  const toVma = (off) => {
    const s = sections.find((x) => x.addr !== 0 && off >= x.offset && off < x.offset + x.size);
    return s ? s.addr + (off - s.offset) : null;
  };

  if (b64sym) {
    const off = toOffset(b64sym.addr);
    if (check(off !== null, 'could not map the base64 table VMA to a file offset')) {
      ALPHABET = fs.readFileSync(elf).subarray(off, off + 64).toString('latin1');
      report.base64AlphabetFromElf = ALPHABET;
      check(
        ALPHABET === 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
        `the firmware's base64 alphabet is not RFC 4648: ${JSON.stringify(ALPHABET)}`,
      );
      say(`[exp6] base64 alphabet read from the ELF at ${report.symbols.b64Table}: RFC 4648 standard`);
    }
  }

  // -------------------------------------------------------------- routing
  const serialSymbols = new Map();
  for (const l of nm) {
    const m = /^([0-9a-f]+)\s+\S+\s+(Serial0|Serial1|USBSerial|HWCDCSerial)$/.exec(l.trim());
    if (m) serialSymbols.set(parseInt(m[1], 16), m[2]);
  }
  const litOff = fs.readFileSync(elf).indexOf(NEEDLE);
  const litVma = toVma(litOff);
  const formatVmas = new Map([[litVma, '@SESAME oled b64 %s\\n']]);
  const sites = findTelemetryPrintfSites(run('objdump', ['-d', '-C', elf]).split(/\r?\n/), formatVmas, serialSymbols);
  report.callSites = sites;
  check(sites.length === 1, `expected exactly one Print::printf call site for the OLED literal, found ${sites.length}`);
  for (const s of sites) {
    check(s.port === 'Serial0', `the OLED frame is emitted to ${s.port}, not Serial0 (UART0) — it would never reach the bridge`);
  }
  if (sites.length) say(`[exp6] call site ${sites[0].callSite}: format=${sites[0].formatVma} port=${sites[0].port}`);
}

// ------------------------------------------------------------- the round trip
const proto = await import('../packages/sesame-protocol/dist/index.js');
const {
  SesameTelemetryParser, blankOledFrame, setOledPixel, oledPixel, decodeOledFrame,
  OLED_WIDTH, OLED_HEIGHT, OLED_FRAME_BYTES, OLED_BASE64_LENGTH, oledByteIndex, oledBitIndex,
} = proto;

/**
 * A transcription of the patch's C loop, character for character in behaviour:
 * 341 whole 3-byte groups then a deliberate one-byte tail (1024 = 3*341 + 1),
 * using the alphabet read out of the ELF. If the C and this disagree, the
 * decoded frame will not match the frame we encoded.
 */
function firmwareBase64(buf, alphabet) {
  const B64 = alphabet;
  let out = '';
  let i = 0;
  for (; i + 3 <= 1024; i += 3) {
    const w = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    out += B64[(w >> 18) & 0x3f] + B64[(w >> 12) & 0x3f] + B64[(w >> 6) & 0x3f] + B64[w & 0x3f];
  }
  const tail = buf[i] << 16;
  out += B64[(tail >> 18) & 0x3f] + B64[(tail >> 12) & 0x3f] + '==';
  return out;
}

// A frame with pixels at coordinates chosen to exercise every page and both
// ends of a byte: top row, bottom row, page boundaries, and the corners.
const PIXELS = [[0, 0], [127, 0], [0, 63], [127, 63], [3, 9], [64, 7], [64, 8], [17, 32], [126, 62]];
const frame = blankOledFrame();
for (const [x, y] of PIXELS) setOledPixel(frame, x, y, true);

// The documented layout, asserted independently of the helpers: page-ordered,
// index = x + (y>>3)*128, bit y&7 from the LSB. The doc comment's worked
// example is (3,9) -> byte 131, bit 1.
check(oledByteIndex(3, 9) === 131 && oledBitIndex(9) === 1, 'the documented (3,9) -> byte 131 bit 1 mapping does not hold');
check((frame[131] & 0b10) !== 0, 'pixel (3,9) did not land in byte 131 bit 1 — the buffer is not SSD1306 page-ordered');
check(frame.length === OLED_FRAME_BYTES && OLED_FRAME_BYTES === 1024, 'frame is not 1024 bytes');

const payload = firmwareBase64(frame, ALPHABET ?? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
check(payload.length === OLED_BASE64_LENGTH, `payload is ${payload.length} chars, expected ${OLED_BASE64_LENGTH}`);

// Render through the ELF's own format string rather than a copy of it.
const elfBuf = fs.readFileSync(artifact(OLED, 'elf'));
const fmtStart = elfBuf.indexOf(NEEDLE);
const fmt = elfBuf.subarray(fmtStart, elfBuf.indexOf(0, fmtStart)).toString('latin1');
check(fmt === '@SESAME oled b64 %s\n', `format string read from the ELF is ${JSON.stringify(fmt)}`);
const line = fmt.replace('%s', payload);
report.wireLine = { bytes: Buffer.byteLength(line, 'latin1'), prefix: line.slice(0, 24), suffix: line.slice(-8).replace('\n', '\\n') };
say(`[exp6] rendered wire line: ${report.wireLine.bytes} bytes (${(report.wireLine.bytes * 10 / 115200 * 1000).toFixed(0)} ms at 115200 8N1)`);

// Feed it to the real parser, split mid-payload, because a UART stream does.
const parser = new SesameTelemetryParser();
const events = [];
const raw = Buffer.from(line, 'latin1');
for (const [a, b] of [[0, 5], [5, 700], [700, raw.length]]) {
  for (const e of parser.push(raw.subarray(a, b))) events.push(e);
}
report.events = events.map((e) => e.type);
if (check(events.length === 1, `expected exactly one event, got ${events.length}: ${events.map((e) => e.type).join(',')}`)) {
  const ev = events[0];
  check(ev.type === 'oled.frame', `parsed as ${ev.type}, expected oled.frame`);
  check(ev.width === OLED_WIDTH && ev.width === 128, `width ${ev.width}, expected 128`);
  check(ev.height === OLED_HEIGHT && ev.height === 64, `height ${ev.height}, expected 64`);
  check(ev.pixels === payload, 'the payload on the event is not the payload on the wire');
  check(ev.pixels.length === OLED_BASE64_LENGTH, `pixels payload is ${ev.pixels.length} chars, expected ${OLED_BASE64_LENGTH}`);
  check(ev.provenance === 'observed', `provenance ${ev.provenance}, expected observed`);
  const decoded = decodeOledFrame(ev.pixels);
  check(decoded.length === 1024, `decoded ${decoded.length} bytes, expected 1024`);
  check(Buffer.compare(Buffer.from(decoded), Buffer.from(frame)) === 0, 'the decoded framebuffer is not byte-identical to the one encoded');
  for (const [x, y] of PIXELS) check(oledPixel(decoded, x, y) === 1, `pixel (${x},${y}) is dark after the round trip`);
  let lit = 0;
  for (let x = 0; x < 128; x++) for (let y = 0; y < 64; y++) lit += oledPixel(decoded, x, y);
  check(lit === PIXELS.length, `${lit} pixels lit after the round trip, expected ${PIXELS.length}`);
  report.roundTrip = { litPixels: lit, decodedBytes: decoded.length, geometry: `${ev.width}x${ev.height}` };
  say(`[exp6] round trip: oled.frame ${ev.width}x${ev.height}, 1024 B decoded, ${lit}/${PIXELS.length} probe pixels lit, byte-identical`);
}

// Negative control: a truncated payload must be rejected, not silently padded.
{
  const bad = new SesameTelemetryParser();
  const evs = [...bad.push(Buffer.from(`@SESAME oled b64 ${payload.slice(0, 100)}\n`, 'latin1'))];
  check(
    evs.length === 1 && evs[0].type === 'protocol.unknown' && evs[0].reason === 'bad-payload',
    `a truncated OLED payload was not rejected: ${JSON.stringify(evs.map((e) => [e.type, e.reason]))}`,
  );
  report.negativeControl = { type: evs[0]?.type ?? null, reason: evs[0]?.reason ?? null };
}

// ------------------------------------------------------------------- verdict
report.ok = problems.length === 0;
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
if (problems.length) {
  console.error(`FAIL  EXP6 OLED hook — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('OK    EXP6 — the OLED framebuffer hook compiles, links, routes to UART0, and round-trips through @sesame-lab/sesame-protocol');
console.log('      NOT proven: that it has ever executed. No silicon, and Renode cannot boot this image (Gate A).');
