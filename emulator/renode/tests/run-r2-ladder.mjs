#!/usr/bin/env node
/**
 * Runs the whole R2 execution-probe ladder under the portable Renode sidecar and
 * prints a per-rung verdict plus the decoded special-register and instruction
 * tables. This is the script that produced every number in
 * docs/findings/R2-xtensa-execution-probe.md.
 *
 *   bash firmware/probes/build-probes.sh        # build the ELFs first
 *   node emulator/renode/tests/run-r2-ladder.mjs
 *
 * Raw Renode console output for every rung is written to
 * emulator/renode/tests/logs/<rung>.log (deliberately not gitignored - the logs
 * are the evidence).
 *
 * Exit code 0 iff every rung reached its done-marker.
 *
 * NOTE: r2-rung5b-rer is NOT run here. The `rer` instruction makes Renode 1.16.1
 * emit "CPU abort ... reading from external register not yet supported" and hang
 * with RunFor never returning, so it would wedge this script. Run it by hand if
 * you want to see the abort:
 *   tools/renode/renode.exe --console --disable-xwt --plain \
 *       emulator/renode/scripts/r2-rung5b-rer.resc
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const RENODE = join(ROOT, 'tools', 'renode', 'renode.exe');
const LOGS = join(HERE, 'logs');

const RUNGS = [
  ['r2-rung1-arith', 1, 'straight-line arithmetic, call0 ABI'],
  ['r2-rung2-call', 2, 'windowed ABI: entry / retw / call8 / callx8'],
  ['r2-rung3-window', 3, 'register-window overflow + underflow, all six handlers'],
  ['r2-rung4-sr', 4, 'memw, sync ops, special/user registers'],
  ['r2-rung5-mem', 5, 'memory at real S2 addresses + remaining instruction classes'],
];

const DONE_MAGIC = 0xd09ef00d;
const SENTINEL = 0xbadbad00;

function blocks(text) {
  const out = {};
  let cur = null;
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^### (.+)$/.exec(line.trim());
    if (m) {
      if (cur) out[cur] = buf;
      cur = m[1];
      buf = [];
    } else if (cur) buf.push(line);
  }
  if (cur) out[cur] = buf;
  return out;
}

function words(lines) {
  const bytes = [...(lines || []).join(' ').matchAll(/0x([0-9A-Fa-f]{2})/g)].map((m) =>
    parseInt(m[1], 16),
  );
  const n = Math.floor(bytes.length / 4);
  const w = new Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) |
            (bytes[i * 4 + 3] << 24)) >>> 0;
  }
  return w;
}

const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

function srNames() {
  const src = readFileSync(join(ROOT, 'firmware', 'probes', 'r2', 'sr_list.h'), 'utf8');
  const rows = [];
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*X\(\s*(\d+),\s*([a-z0-9_]+),\s*(RWB|RW|R|W)\s*,/.exec(line);
    if (m) rows.push({ idx: Number(m[1]), name: m[2], mode: m[3] });
  }
  // The UR table reuses index 0; drop the duplicate that follows the SR table.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.idx) ? false : (seen.add(r.idx), true)));
}

function tag(w) {
  let s = '';
  for (const sh of [24, 16, 8, 0]) s += String.fromCharCode((w >>> sh) & 0xff);
  return s;
}

if (!existsSync(RENODE)) {
  console.error(`missing Renode sidecar: ${RENODE}`);
  process.exit(2);
}
mkdirSync(LOGS, { recursive: true });

let failures = 0;
const summary = [];

for (const [name, rungId, what] of RUNGS) {
  const elf = join(ROOT, 'firmware', 'probes', 'build', `${name}.elf`);
  if (!existsSync(elf)) {
    console.error(`missing ${elf} - run: bash firmware/probes/build-probes.sh`);
    process.exit(2);
  }
  const resc = join(ROOT, 'emulator', 'renode', 'scripts', `${name}.resc`);
  const r = spawnSync(RENODE, ['--console', '--disable-xwt', '--plain', resc], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = (r.stdout || '') + (r.stderr || '');
  writeFileSync(join(LOGS, `${name}.log`), text);

  const b = blocks(text);
  const res = words(b['RESULTS+FAULTS 0x3FFD0000 .. 0x3FFD01FF']);
  const errs = text.split(/\r?\n/).filter((l) => l.includes('[ERROR]'));

  const startup = res.slice(0, 5);
  const done = res[31] === DONE_MAGIC;
  const rung = res[8];
  const faults = res[64 + 4];

  console.log('='.repeat(78));
  console.log(`${name}  --  ${what}`);
  console.log('-'.repeat(78));
  console.log(`  startup markers 1..5 : ${startup.join(', ')}  ` +
              `(all five means start.S completed and C returned)`);
  console.log(`  rung id written      : ${rung}  (expected ${rungId})`);
  console.log(`  done marker          : ${done ? 'SET (0xD09EF00D)' : 'ABSENT'}`);
  console.log(`  exceptions taken     : ${faults}` +
              (faults ? `  last EXCCAUSE=${res[64 + 2]} EPC1=${hex(res[64 + 3])}` : ''));
  console.log(`  Renode [ERROR] lines : ${errs.length}`);
  for (const e of errs) console.log(`      ${e.trim()}`);

  if (rungId === 1) {
    const exp = {
      9: 0x12345723, 10: 0x123455cd, 11: 0x123456d3, 12: 0x00340078,
      13: 0x468acf00, 14: 0x002468ac, 15: 0xfffda52f, 16: 0x28f5c228,
      17: 0x001b40e1, 18: 0x0000002d, 19: 0x00000456, 20: 0x00000078,
      21: 0x000000ab, 22: 0x0000000c,
    };
    let bad = 0;
    for (const [k, v] of Object.entries(exp)) if (res[k] !== v >>> 0) bad++;
    console.log(`  arithmetic results   : ${bad === 0 ? 'all 14 correct' : `${bad} WRONG`}`);
    if (bad) failures++;
  }
  if (rungId === 2) {
    console.log(`  leaf_add(0x1234,0x56): ${hex(res[10])} (expect 0x00001336)`);
    console.log(`  leaf_mix via callx8  : ${hex(res[12])} (expect 0x0001231d)`);
    if (res[10] !== 0x1336 || res[12] !== 0x1231d) failures++;
  }
  if (rungId === 3) {
    console.log(`  callx8 depth-48 sum  : ${hex(res[11])}`);
    console.log(`  w4_chain(40)         : ${res[13]} (expect 40)`);
    console.log(`  w8_chain(40)         : ${res[15]} (expect 40)`);
    console.log(`  w12_chain(40)        : ${res[17]} (expect 40)`);
    if (res[13] !== 40 || res[15] !== 40 || res[17] !== 40) failures++;
  }
  if (rungId === 4) {
    console.log(`  memw faults          : ${res[9]}   (expect 0)`);
    console.log(`  value through memw   : ${hex(res[10])} (expect 0xc0ffee01)`);
    console.log(`  isync/rsync/esync/dsync faults: ` +
                `${res[11]}/${res[12]}/${res[13]}/${res[14]}`);
    console.log(`  rsil faults          : ${res[15]}/${res[17]}, old PS ${hex(res[16])}`);
    const srt = words(b['SRTAB 0x3FFD0200 .. 0x3FFD067F']);
    console.log('  --- special registers ---');
    let srBad = 0;
    for (const { idx, name: rn, mode } of srNames()) {
      const [v, wf, rf, w] = srt.slice(idx * 4, idx * 4 + 4);
      let verdict;
      if (mode === 'W') verdict = wf ? 'wsr ILLEGAL' : 'wsr ok';
      else if (rf) verdict = 'rsr ILLEGAL';
      else if (wf) verdict = 'wsr ILLEGAL';
      else if (v === ((SENTINEL | idx) >>> 0)) verdict = 'rsr SKIPPED';
      else if (mode === 'RW' && v !== w) verdict = `readback MISMATCH (wrote ${hex(w)})`;
      else verdict = 'ok';
      if (verdict !== 'ok' && !verdict.endsWith('wsr ok')) srBad++;
      console.log(`    ${String(idx).padStart(3)} ${rn.padEnd(14)} ${mode.padEnd(3)} ` +
                  `read ${hex(v)}  wrote ${hex(w)}  ${verdict}`);
    }
    const urBase = (0x3ffd0600 - 0x3ffd0200) / 4;
    const [uv, uwf, urf, uw] = srt.slice(urBase, urBase + 4);
    console.log(`    UR  threadptr      RW  read ${hex(uv)}  wrote ${hex(uw)}  ` +
                `${uwf || urf ? 'ILLEGAL' : 'ok'}`);
    console.log(`  special registers rejected: ${srBad}`);
  }
  if (rungId === 5) {
    const ins = words(b['INSTAB 0x3FFD0700 .. 0x3FFD0AFF']);
    console.log('  --- instruction / memory probes ---');
    let bad = [];
    for (let i = 0; i < 64; i++) {
      const [f, v, t0, t1] = ins.slice(i * 4, i * 4 + 4);
      if (t0 === 0 && t1 === 0) break;
      const nm = (tag(t0) + tag(t1)).replaceAll('_', ' ').trim();
      const verdict = f ? 'ILLEGAL / unimplemented' : 'ok';
      if (f) bad.push(nm);
      console.log(`    ${String(i).padStart(3)} ${nm.padEnd(10)} faults=${f} ` +
                  `value=${hex(v)}  ${verdict}`);
    }
    console.log(`  rejected instructions: ${bad.length ? bad.join(', ') : 'none'}`);
  }

  if (!done || rung !== rungId) failures++;
  summary.push([name, done && rung === rungId ? 'PASS' : 'FAIL', faults, errs.length]);
}

console.log('\n' + '='.repeat(78));
console.log('R2 LADDER SUMMARY');
console.log('='.repeat(78));
console.log('rung                      verdict  guest-exceptions  renode-errors');
for (const [n, v, f, e] of summary) {
  console.log(`${n.padEnd(24)}  ${v.padEnd(7)}  ${String(f).padStart(16)}  ${String(e).padStart(13)}`);
}
console.log(failures === 0
  ? '\nEvery rung reached its done marker.'
  : `\n${failures} rung-level failure(s).`);
process.exit(failures === 0 ? 0 : 1);
