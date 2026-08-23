#!/usr/bin/env node
/**
 * Counts entries into each Xtensa register-window vector in the rung-3 execution
 * trace. This is the positive proof that the window overflow/underflow mechanism
 * actually engaged, rather than the call chains simply fitting in the register
 * file.
 *
 *   tools/renode/renode.exe --console --disable-xwt --plain \
 *       emulator/renode/scripts/r2-rung3-trace.resc
 *   node emulator/renode/tests/count-window-vectors.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const TRACE = join(HERE, 'logs', 'r2-rung3.trace');

mkdirSync(join(HERE, 'logs'), { recursive: true });
rmSync(TRACE, { force: true });

const renode = join(ROOT, 'tools', 'renode', 'renode.exe');
const r = spawnSync(renode, [
  '--console', '--disable-xwt', '--plain',
  // Renode 1.16.1 refuses to create a trace file from a repo-relative path, so
  // the absolute one is injected here rather than hard-coded in the .resc.
  '-e', `$trace=@${TRACE.split('\\').join('/')}`,
  '-e', 'include @emulator/renode/scripts/r2-rung3-trace.resc',
], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });

if (!existsSync(TRACE)) {
  console.error('Renode did not produce a trace file.');
  console.error((r.stdout || '') + (r.stderr || ''));
  process.exit(2);
}

// VECBASE is 0x40024000 - the same address Espressif's own linked S2 image uses
// for .iram0.vectors. Offsets are architectural.
const V = {
  0x40024000: 'WindowOverflow4',
  0x40024040: 'WindowUnderflow4',
  0x40024080: 'WindowOverflow8',
  0x400240c0: 'WindowUnderflow8',
  0x40024100: 'WindowOverflow12',
  0x40024140: 'WindowUnderflow12',
  0x40024300: 'KernelException',
  0x40024340: 'UserException',
  0x400243c0: 'DoubleException',
};

const counts = Object.fromEntries(Object.values(V).map((n) => [n, 0]));
let total = 0;
for (const line of readFileSync(TRACE, 'utf8').split(/\r?\n/)) {
  const m = /0x([0-9A-Fa-f]+)\s*$/.exec(line.trim());
  if (!m) continue;
  total++;
  const name = V[parseInt(m[1], 16)];
  if (name) counts[name]++;
}

console.log(`traced instructions: ${total}`);
for (const n of Object.values(V)) console.log(`  ${n.padEnd(20)} entered ${counts[n]} times`);

const windows = ['WindowOverflow4', 'WindowUnderflow4', 'WindowOverflow8',
                 'WindowUnderflow8', 'WindowOverflow12', 'WindowUnderflow12'];
const allFired = windows.every((n) => counts[n] > 0);
const balanced = counts.WindowOverflow4 === counts.WindowUnderflow4 &&
                 counts.WindowOverflow8 === counts.WindowUnderflow8 &&
                 counts.WindowOverflow12 === counts.WindowUnderflow12;
const clean = counts.UserException === 0 && counts.KernelException === 0 &&
              counts.DoubleException === 0;

console.log(`\nall six window handlers fired : ${allFired ? 'YES' : 'NO'}`);
console.log(`overflow/underflow balanced   : ${balanced ? 'YES' : 'NO'}`);
console.log(`no exception escaped to user/kernel/double : ${clean ? 'YES' : 'NO'}`);
process.exit(allFired && balanced && clean ? 0 : 1);
