#!/usr/bin/env node
/**
 * Phase 14 alone — the honesty surfaces asserted against the PACKAGED app.
 *
 * Phase 5 T5. This is the same code `scripts/capture-web-screenshots.mjs` runs
 * as its last phase; the file exists because the packaged phase has different
 * prerequisites from the other thirteen. Those need a browser, a bridge, a lab
 * host and about six minutes; this needs a `tauri build` artefact and about
 * ninety seconds, and during development of the desktop app it is the one you
 * want to re-run.
 *
 * The report is the same object the harness records under
 * `phases.packagedHonesty`, written beside the captures so the two can be
 * compared.
 *
 *   node scripts/verify-packaged-honesty.mjs
 *   node scripts/verify-packaged-honesty.mjs --packaged-exe <path to an INSTALLED copy>
 *
 * `--packaged-exe` is how the same assertions are pointed at an installed
 * artefact rather than at `target/release`: `app.path()` resolves against the
 * directory the executable is in, so the installed copy checks the installed
 * copy — the same property T2's `just tauri-resources` relies on.
 *
 * Exit code 0 with no problems, 1 with problems, and **2 when there was no
 * artefact to check**. Three codes rather than two, because "nothing was
 * verified" must not be reportable as "everything passed" by a CI file that
 * only looks at zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackagedHonestyPhase } from './lib/packaged-honesty.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const problems = [];
const notes = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
  return condition;
};

const OUT = path.resolve(REPO, argOf('out', 'docs/findings/assets'));

const report = await runPackagedHonestyPhase({
  repo: REPO,
  check,
  note: (text) => notes.push(text),
  log: console.log,
  problemCount: () => problems.length,
  exePath: argOf('packaged-exe', null),
  shoot: argv.includes('--no-shots')
    ? null
    : (name, caption, buffer) => {
        fs.mkdirSync(OUT, { recursive: true });
        const file = path.join(OUT, name);
        fs.writeFileSync(file, buffer);
        console.log(`[t5] shot ${name} — ${caption} (${buffer.length} B)`);
        return { name, caption, bytes: buffer.length };
      },
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 't5-packaged-honesty.json'),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), report, notes, problems, ok: problems.length === 0 }, null, 2)}\n`,
);

for (const note of notes) console.log(`NOTE  ${note}`);

if (report.ran !== true && problems.length === 0) {
  console.error(`SKIP  the packaged honesty phase did not run: ${report.reason}`);
  process.exit(2);
}
if (problems.length > 0) {
  console.error(`FAIL  the packaged artefact — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `OK    the PACKAGED window at ${report.cdpTarget} was driven end to end: the environment line read ` +
    `"${report.environmentLine}" whole, ${report.origins?.physicallyObservedEvents} of ` +
    `${report.origins?.totalEvents} events satisfied isPhysicallyObserved(), the origin's engine ` +
    `"${report.origin?.engine}" is what the BUNDLED qemu-system-xtensa.exe answers to --version ` +
    `rather than the frontend's constant, the board is named as the legacy V1 board and not the S2 ` +
    `Mini, the OLED is observed with the getBuffer()-before-display.display() qualifier intact, ` +
    `pwm.output is still INFERRED FOR EXPLANATION, and ` +
    `${report.negativeControls?.filter((c) => c.fired).length}/${report.negativeControls?.length} ` +
    `checks were proved by breaking the packaged window first. ` +
    `Survivors after close: qemu=${report.survivorsAfterClose?.qemu}, ` +
    `desktop=${report.survivorsAfterClose?.desktop}.`,
);
process.exit(0);
