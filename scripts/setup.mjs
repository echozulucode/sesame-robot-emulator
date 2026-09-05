#!/usr/bin/env node
/**
 * `just setup` — take a fresh clone to `just dev` in one command. Phase 5 T7.
 *
 * ## Why this exists
 *
 * Everything a clone needs beyond `git clone` is gitignored, which means it is
 * also *invisible*: `tools/`, `firmware/upstream/`, every `dist/`, and
 * `emulator/qemu/images/`. A reader who clones this repository sees a tree that
 * looks complete and four commands' worth of absence. The README listed those
 * commands; nothing ran them, nothing checked the list was still right, and the
 * list was in fact wrong — `just qemu-image` cannot run at all without the
 * Arduino toolchain, which was named nowhere in the quick start.
 *
 * So this is one command, and the list it walks is
 * `scripts/lib/prereqs.mjs` — the same array `just doctor` prints. There is no
 * second list to drift.
 *
 * ## Idempotent, and honest about which half it did
 *
 * Every step is detected before it runs and **detected again afterwards**:
 *
 *   already   the artefact was on disk; nothing ran
 *   done      the artefact was absent, the command ran, and it is there now
 *   FAILED    the command exited non-zero, OR it exited zero and the artefact
 *             is still absent
 *
 * That second failure mode is the one worth the code. A fetcher that succeeds
 * without producing anything — a partial extract, a redirect to an error page
 * saved as an archive, a compile that wrote to the wrong directory — reports
 * exit 0, and a setup script that trusts exit codes would then hand the reader
 * a green summary and a broken clone. The post-condition is the artefact.
 *
 * Proving that check can fail: `SESAME_SETUP_NOOP_STEP=<id>` replaces one
 * step's command with a no-op that exits 0. The step then always "succeeds"
 * and the re-detection has to be the thing that refuses it. See
 * docs/findings/T7-two-targets-and-the-cold-clone.md.
 *
 * ## Usage
 *
 *   node scripts/setup.mjs                 the `just dev` path — ~37 min, ~15 GB
 *   node scripts/setup.mjs --sim           the `just dev-sim` path — ~2 min, no
 *                                          QEMU, no 14 GB Arduino toolchain
 *   node scripts/setup.mjs --all-images    also the two images the VERIFICATION
 *                                          targets need (see below)
 *   node scripts/setup.mjs --dry-run       print the plan, run nothing
 *   node scripts/setup.mjs --only <ids>    comma-separated prerequisite ids
 *
 * `--all-images` exists because there are three flash images and they have
 * three different consumers: `distro-v1-esp32-cli` is what `just dev` boots,
 * `distro-v1-esp32-nowifi` is what the capture harness's bridge phase boots,
 * and `distro-v1-esp32-cli-oled` is the one `just tauri-build` bundles. The
 * default builds only the first, because the default is "get me to `just dev`"
 * and each image is about two minutes of Xtensa compilation.
 *
 * Exit 0 when every required prerequisite is present at the end, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PREREQS } from './lib/prereqs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const ALL_IMAGES = argv.includes('--all-images');
const DRY_RUN = argv.includes('--dry-run');
/**
 * `--sim` stops before the emulator rows: dependencies, the pinned upstream
 * tree, the builds, and nothing else. That is everything `just dev-sim` needs,
 * and it is two minutes instead of thirty-seven, because it skips the 14 GB
 * Arduino toolchain and the flash image it exists to compile.
 *
 * It is a flag rather than advice in the README because the advice was
 * `pnpm install && just build`, and `just build` exits 2 the first time on a
 * clean clone — see `retryOnce` in prereqs.mjs. Telling a newcomer to run a
 * command that fails once is worse than having a flag.
 */
const SIM = argv.includes('--sim');
const SIM_SKIPS = new Set(['qemu', 'arduino-toolchain', 'image-cli', 'image-nowifi', 'image-oled']);
const ONLY = (argOf('only', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const NOOP_STEP = process.env.SESAME_SETUP_NOOP_STEP ?? '';

const log = (line = '') => process.stdout.write(`${line}\n`);

/**
 * Windows: Node 24 refuses to spawn a `.cmd` shim directly (the CVE-2024-27980
 * hardening), which is how pnpm ships. `just doctor` already learned this;
 * route those through cmd.exe rather than reporting "not found" on a machine
 * where the tool works.
 */
const spawnStep = (command, args) => {
  const viaCmd = process.platform === 'win32' && command !== process.execPath && !command.endsWith('.exe');
  const [bin, argv2] = viaCmd ? ['cmd.exe', ['/c', command, ...args]] : [command, args];
  return spawnSync(bin, argv2, { cwd: REPO, stdio: 'inherit', encoding: 'utf8' });
};

// ─────────────────────────────────────────────────────────────── the plan
//
// Built before anything runs, so the cost is printed up front rather than
// discovered a gigabyte in.

const steps = PREREQS.filter((p) => p.setup !== null)
  .filter((p) => (ONLY.length === 0 ? true : ONLY.includes(p.id)))
  .filter((p) => (SIM ? !SIM_SKIPS.has(p.id) : true))
  .filter((p) => (p.setup.extra ? ALL_IMAGES || ONLY.includes(p.id) : true));

/** A narrowed run is not a claim about the whole clone — see the verdict below. */
const PARTIAL = SIM || ONLY.length > 0;

const state = new Map(steps.map((p) => [p.id, p.detect(REPO)]));

/**
 * The Arduino toolchain is a means, not an end: it exists to compile a flash
 * image. A clone that already has every image it was asked for has no reason to
 * download a gigabyte of compiler, so that step is dropped from the plan — and
 * it is dropped from the PLAN rather than skipped silently at run time, so the
 * printed cost is the cost.
 */
const imageStepsToRun = steps.filter((p) => p.setup.image && !state.get(p.id).present);
const plan = steps.filter((p) => !(p.setup.onlyIfImagesMissing && imageStepsToRun.length === 0));

const willRun = plan.filter((p) => p.setup.always === true || !state.get(p.id).present);

log('');
log('  just setup — everything a clone needs that git does not carry');
log('');
for (const p of plan) {
  const before = state.get(p.id);
  const verb = before.present && p.setup.always !== true ? 'already present' : `will run  (${p.setup.minutes})`;
  log(`    ${p.name.padEnd(20)} ${verb.padEnd(26)} ${p.setup.label}`);
}
// Everything with a setup command that this run is NOT going to do, and why.
// The plan is the place a reader finds out what they are not getting.
const skipped = PREREQS.filter((p) => p.setup !== null && !plan.includes(p));
for (const p of skipped) {
  const why = SIM && SIM_SKIPS.has(p.id)
    ? '--sim excludes it'
    : p.setup.extra
      ? '--all-images builds it'
      : ONLY.length > 0
        ? '--only excludes it'
        : p.setup.onlyIfImagesMissing
          ? 'every image this run wants is already built'
          : 'not needed by this plan';
  log(`    ${p.name.padEnd(20)} ${'not in this run'.padEnd(26)} ${why} (${p.setup.label})`);
}
log('');

/*
  The Arduino toolchain is 14 GB on disk. That is measured, not estimated —
  `tools/arduino-data` after one cold `just setup` is 14,327 MB, because
  installing esp32:esp32@3.3.11 installs every Xtensa and RISC-V toolchain and
  every per-target library set, and the flash image is compiled with one of
  them.

  A command that quietly starts a 14 GB download is not a good command, so when
  the plan contains it the plan says so before anything begins, along with the
  path that needs none of it.
*/
if (plan.some((p) => p.id === 'arduino-toolchain' && !state.get(p.id).present)) {
  log('  NOTE  this plan includes the Arduino/ESP32 toolchain: about 31 minutes and 14 GB under');
  log('        tools/, all of it to compile one 4 MB flash image. `just dev-sim` — the behavioural');
  log('        simulator — needs none of it, and neither does anything above the emulator rows.');
  log('');
}

if (DRY_RUN) {
  log(`  --dry-run: ${String(willRun.length)} of ${String(plan.length)} step(s) would run. Nothing was changed.`);
  log('');
  process.exit(0);
}

// ────────────────────────────────────────────────────────────── the walk

const results = [];
let failures = 0;

for (const p of plan) {
  const before = state.get(p.id);
  if (before.present && p.setup.always !== true) {
    results.push({ id: p.id, name: p.name, status: 'already', detail: before.detail, seconds: 0 });
    continue;
  }

  log(`\n──── ${p.name} — ${p.setup.label}`);
  log(`     ${before.present ? `present (${before.detail}), running anyway` : `absent (${before.detail})`}: ` +
      `${p.setup.command} ${p.setup.args.join(' ')}\n`);

  const started = Date.now();
  let r =
    p.id === NOOP_STEP
      ? // The negative control. The command "succeeds" and produces nothing, so
        // the only thing that can refuse this step is the re-detection below.
        (log(`     [SESAME_SETUP_NOOP_STEP] the command for "${p.id}" was replaced with a no-op that exits 0.`),
        { status: 0 })
      : spawnStep(p.setup.command, p.setup.args);
  let attempts = 1;

  // One named retry, for one named hazard — see `retryOnce` in prereqs.mjs.
  // Never a general retry loop: that turns a real failure into a slower real
  // failure and hides which attempt was the one that mattered.
  if (r.status !== 0 && !r.error && p.setup.retryOnce && p.id !== NOOP_STEP) {
    log(`\n     first attempt exited ${String(r.status)}. Retrying once — ${p.setup.retryOnce}\n`);
    r = spawnStep(p.setup.command, p.setup.args);
    attempts = 2;
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  if (r.error) {
    failures += 1;
    results.push({
      id: p.id,
      name: p.name,
      status: 'FAILED',
      seconds,
      detail: `could not start "${p.setup.command}": ${r.error.message}`,
    });
    continue;
  }

  // The post-condition is the ARTEFACT, not the exit code — see the header.
  const after = p.detect(REPO);
  state.set(p.id, after);

  if (r.status !== 0) {
    failures += 1;
    results.push({
      id: p.id,
      name: p.name,
      status: 'FAILED',
      seconds,
      detail:
        `${p.setup.command} exited ${String(r.status)}` +
        (attempts > 1 ? ' on both attempts' : '') +
        (after.present ? ' (the artefact is there anyway)' : ''),
    });
  } else if (!after.present) {
    failures += 1;
    results.push({
      id: p.id,
      name: p.name,
      status: 'FAILED',
      seconds,
      detail: `${p.setup.command} exited 0 but ${p.name} is still ${after.detail} — the command reported success ` +
        'and produced nothing',
    });
  } else {
    results.push({
      id: p.id,
      name: p.name,
      status: before.present ? 'refreshed' : 'done',
      seconds,
      detail: attempts > 1 ? `${after.detail} (on the second attempt)` : after.detail,
    });
  }
}

// ───────────────────────────────────────────────────────────── the report

const glyph = { already: 'already', done: 'done', refreshed: 'refreshed', FAILED: 'FAILED' };
log('');
log('  ─────────────────────────────────────────────────────────────────────');
for (const r of results) {
  log(`    ${glyph[r.status].padEnd(10)} ${r.name.padEnd(20)} ${r.seconds ? `${String(r.seconds)}s`.padEnd(6) : ''.padEnd(6)} ${r.detail}`);
}
log('');

const did = results.filter((r) => r.status === 'done').length;
const kept = results.filter((r) => r.status === 'already').length;
log(`  ${String(did)} fetched or built, ${String(kept)} already present, ${String(failures)} failed.`);

// The final word is another reading of the disk rather than a tally of what
// this script believes it did. `just setup` claiming success while `just
// doctor` still fails is precisely the drift T7 exists to close, so the claim
// is made with doctor's own array.
const stillMissing = PREREQS.filter((p) => p.level === 'FAIL' && !p.detect(REPO).present);

// A narrowed run reports the blocking rows it did not address, and does not
// FAIL on them: `--sim` deliberately leaves the emulator out, and calling that
// "not ready" would be as wrong as calling it ready. What it must never do is
// stay quiet about them.
if (stillMissing.length > 0 && PARTIAL) {
  log('');
  log(`  ${String(stillMissing.length)} blocking prerequisite(s) are still absent — NOT part of this run:`);
  for (const p of stillMissing) log(`    ${p.name.padEnd(20)} ${p.fix}`);
  log('');
  log(SIM ? '  `just setup` (no --sim) fetches these; `just dev` needs them and `just dev-sim` does not.' : '  `just setup` with no --only fetches these.');
}
if (stillMissing.length > 0 && !PARTIAL) {
  log('');
  log(`  NOT READY — ${String(stillMissing.length)} blocking prerequisite(s) are still absent:`);
  for (const p of stillMissing) log(`    ${p.name.padEnd(20)} ${p.fix}`);
  log('');
  process.exit(1);
}
if (failures > 0) {
  log('');
  log(`  ${String(failures)} step(s) failed, but every prerequisite this run is responsible for is present.`);
  log('  Run `just doctor` to see the rest.');
  log('');
  process.exit(1);
}
log('');
log(
  SIM
    ? '  Ready for `just dev-sim` — the behavioural simulator, no emulator involved.'
    : '  Ready. Run `just dev` (real firmware in QEMU) or `just dev-sim` (the behavioural simulator).',
);
log('  `just doctor` lists everything, including what is only needed for the desktop app.');
log('');
process.exit(0);
