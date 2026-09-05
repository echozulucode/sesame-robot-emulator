#!/usr/bin/env node
/**
 * `just verify-all` — the web target and the packaged target, in one run, with
 * one verdict. Phase 5 T7.
 *
 * ## The premise
 *
 * The plan's T7 says it in one line: *"two targets that are never tested
 * together will diverge."* Until now they could not be run together at all.
 * `just capture` drove the browser build; `just tauri-honesty`,
 * `just tauri-resources`, `just tauri-emulator` and `just tauri-install` each
 * drove a piece of the packaged one; and whether all of them had been run
 * against the same tree, in the same hour, was a thing a person remembered or
 * did not.
 *
 * It found a divergence on its first honest run, which is written up in
 * docs/findings/T7-two-targets-and-the-cold-clone.md §3: the flash image
 * `just qemu-image` builds is not the flash image `just tauri-build` bundles,
 * and nothing anywhere said so.
 *
 * ## Three targets
 *
 *   web        scripts/capture-web-screenshots.mjs --skip-packaged
 *              41 captures, headless Chromium, real QEMU behind two of them
 *   packaged   the built exe answering --resource-report and
 *              --emulator-selftest, then scripts/verify-packaged-honesty.mjs
 *              (T5's phase 14) driving the packaged WebView2 window
 *   installer  scripts/verify-install.mjs — install into a fresh directory
 *              with the repository stripped from PATH, check, uninstall
 *
 * Nothing here is reimplemented. Every target is an existing entry point, run
 * as a child process, and its exit code is the reading. The one composition
 * decision is `--skip-packaged` on the harness: T5 §10 recorded that two
 * packaged WebView2 windows cannot be driven at once, so phase 14 runs exactly
 * once, inside the packaged target, rather than twice in one command. The
 * capture total is unchanged — 41 from the harness plus 3 from the packaged
 * window is the same 44 `just capture` produces on its own.
 *
 * ## A skip must never read as a pass
 *
 * T5 established a third exit code because *"nothing was verified" must not be
 * reportable as "everything passed" by a CI file that only looks at zero.*
 * Combining targets creates a fourth case — *some* were verified — and it needs
 * a code of its own for the same reason:
 *
 *   0   every requested target RAN and PASSED
 *   1   a target ran and failed
 *   2   nothing ran at all — no artefacts, no browser, nothing verified
 *   3   INCOMPLETE: what ran passed, and at least one target did not run
 *
 * Exit 3 is the code this command will most often produce on a machine that has
 * not built the desktop app, and that is the point: a green web harness on a
 * tree with no packaged artefact is not a verified tree. `--only` always exits
 * 3 when it passes, because a deliberately narrowed run is still a run that did
 * not verify everything, and the code should not depend on the operator's
 * intent.
 *
 * ## Usage
 *
 *   node scripts/verify-all.mjs                          all three, ~13 min
 *   node scripts/verify-all.mjs --only packaged,installer  the desktop half, ~35 s
 *   node scripts/verify-all.mjs --list                   what it would run, and the cost
 *
 * ## There is no --fast, and that is a measurement rather than an omission
 *
 * One was written and then deleted. It ran all three targets with the harness
 * on `--skip-qemu` and the installer check on `--no-emulator`, and it was
 * measured against the full run on the same tree:
 *
 *   full    web 733 s + packaged 29 s + installer  8 s = 12m 50s
 *   "fast"  web 705 s + packaged 24 s + installer  4 s = 12m 13s
 *
 * **A 5% saving.** The web harness's cost is a headless browser driving twelve
 * phases, not the two QEMU boots inside it, so there is nothing to subtract:
 * every phase asserts something no other phase does. A flag called `--fast`
 * that saves thirty-seven seconds out of thirteen minutes is a flag that gets
 * used in place of the real thing for no benefit, which is worse than not
 * having it.
 *
 * The subset that IS worth having is `--only packaged,installer` — 35 seconds,
 * the whole desktop half, and it exits **3**, so it can never be mistaken for a
 * verified tree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const LIST = argv.includes('--list');
const ONLY = (argOf('only', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = path.resolve(REPO, argOf('out', 'docs/findings/assets'));

const log = (line = '') => process.stdout.write(`${line}\n`);
const rel = (p) => path.relative(REPO, p).replaceAll('\\', '/');

const DESKTOP_EXE = path.join(REPO, 'src-tauri/target/release/sesame-lab-desktop.exe');
const INSTALLER = path.join(REPO, 'src-tauri/target/release/bundle/nsis');
const WEB_DIST = path.join(REPO, 'apps/web/dist/index.html');
const BRIDGE_CLI = path.join(REPO, 'emulator/bridge/dist/cli.js');
/*
  The web harness always writes into gitignored scratch here, never into
  docs/findings/assets.

  `just capture` is the producer of this project's committed capture evidence,
  and it produces 44. This command runs the same harness with --skip-packaged,
  which produces 41 and records `packagedHonesty: {ran: false}`. Letting that
  overwrite the recorded set would leave a mixed directory and a report claiming
  a smaller number, with nothing on disk saying which run wrote what. So
  `just capture` owns docs/findings/assets and this owns its own scratch.
*/
const WEB_OUT = path.join(REPO, 'node_modules/.cache/verify-all/web');
const CAPTURE_REPORT = path.join(WEB_OUT, 'v3-v4-browser-capture.json');

const installerExe = () => {
  if (!fs.existsSync(INSTALLER)) return null;
  const found = fs.readdirSync(INSTALLER).find((f) => f.endsWith('-setup.exe'));
  return found ? path.join(INSTALLER, found) : null;
};

const run = (command, args) => {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd: REPO, stdio: 'inherit', encoding: 'utf8' });
  return { status: r.error ? null : r.status, error: r.error ?? null, seconds: Math.round((Date.now() - started) / 1000) };
};
const node = (...args) => run(process.execPath, args);

/**
 * Read a number back out of a report a target wrote, rather than out of this
 * script's own idea of what the target did. `just capture`'s count is the one
 * number in this project people quote at each other, so it is quoted from the
 * file the harness itself produced.
 */
const captureSummary = () => {
  try {
    const json = JSON.parse(fs.readFileSync(CAPTURE_REPORT, 'utf8'));
    return {
      shots: Array.isArray(json.shots) ? json.shots.length : null,
      problems: Array.isArray(json.problems) ? json.problems : [],
    };
  } catch {
    return { shots: null, problems: [] };
  }
};

// ───────────────────────────────────────────────────────────────── targets
//
// `ready()` returns null when the target can run, or the reason it cannot.
// A missing artefact is a REASON, printed, never an absence that quietly
// shrinks the run.

const TARGETS = [
  {
    id: 'web',
    name: 'web target',
    what: 'apps/web/dist in headless Chromium — 41 captures read back out of the three.js scene graph',
    cost: '~12 min — 95% of this command',
    ready: () => {
      if (!fs.existsSync(WEB_DIST)) return `${rel(WEB_DIST)} is missing — run \`just build-web\` (or \`just setup\`)`;
      if (!fs.existsSync(BRIDGE_CLI)) return `${rel(BRIDGE_CLI)} is missing — run \`just build\` (or \`just setup\`)`;
      return null;
    },
    run: () => {
      const r = node('scripts/capture-web-screenshots.mjs', '--skip-packaged', '--out', rel(WEB_OUT));
      // The harness exits 3 when it cannot find Edge or Chrome. That is an
      // absent verifier, not a failing app, and calling it a failure would be
      // as dishonest in one direction as calling it a pass is in the other.
      if (r.status === 3) return { ...r, skipped: 'no Edge or Chrome on this machine (set CHROME_PATH)' };
      // The count and the problems both come out of the report the harness
      // wrote, not out of this script's idea of what it did. A failed target
      // that only said "41 captures" would be reporting the half that went
      // well.
      const { shots, problems } = captureSummary();
      return {
        ...r,
        problems,
        detail:
          `${String(shots ?? '?')} captures` +
          (problems.length ? `, ${String(problems.length)} problem(s) — first: ${problems[0]}` : ''),
      };
    },
  },
  {
    id: 'packaged',
    name: 'packaged target',
    what: "the built exe's own resource report and emulator self-test, then T5's phase 14 driving the packaged window",
    cost: '~30 s, opens a real desktop window',
    ready: () =>
      fs.existsSync(DESKTOP_EXE)
        ? null
        : `${rel(DESKTOP_EXE)} does not exist — run \`just tauri-build\`. ` +
          'NOTHING about the packaged app was verified by this run.',
    run: () => {
      const steps = [];
      // T2's acceptance test: does the shipped binary find its 22 resources.
      const reportPath = path.join(REPO, 'src-tauri/target/release/resource-report.json');
      steps.push({ name: 'resources', ...run(DESKTOP_EXE, ['--resource-report', reportPath]) });
      // T3's: boot the bundled QEMU, stream UART0, stop, and ask tasklist.
      const selfTest = path.join(REPO, 'src-tauri/target/release/emulator-selftest.json');
      steps.push({ name: 'emulator', ...run(DESKTOP_EXE, ['--emulator-selftest', selfTest, '--cycles', '1']) });
      // T5's phase 14, whole. Exit 2 means it declined to grade an artefact it
      // could not confirm was a package — that is a skip, and it propagates as
      // one rather than being flattened into a failure.
      const honesty = node('scripts/verify-packaged-honesty.mjs');
      steps.push({ name: 'honesty', ...honesty });
      const seconds = steps.reduce((n, s) => n + s.seconds, 0);
      if (honesty.status === 2 && steps.every((s) => s.status === 0 || s.name === 'honesty')) {
        return { seconds, steps, skipped: 'the packaged honesty phase had no artefact it could grade (exit 2)' };
      }
      const bad = steps.filter((s) => s.status !== 0);
      return {
        seconds,
        steps,
        status: bad.length === 0 ? 0 : 1,
        detail: bad.length === 0 ? `${String(steps.length)}/3 sub-checks passed` : `${bad.map((s) => s.name).join(', ')} failed`,
      };
    },
  },
  {
    id: 'installer',
    name: 'installer target',
    what: 'T6 — install into a fresh directory with the repo stripped from PATH, check the licence manifest, uninstall',
    cost: '~10 s, boots the installed QEMU',
    ready: () =>
      installerExe()
        ? null
        : `no *-setup.exe under ${rel(INSTALLER)} — run \`just tauri-build\`. ` +
          'NOTHING about what a recipient installs was verified by this run.',
    run: () => {
      const r = node('scripts/verify-install.mjs');
      if (r.status === 2) return { ...r, skipped: 'there was no installer to check (exit 2)' };
      return {
        ...r,
        detail:
          r.status === 0
            ? 'installed into a fresh directory, checked with a QEMU boot, uninstalled'
            : 'see the problems listed above',
      };
    },
  },
];

const requested = ONLY.length === 0 ? TARGETS : TARGETS.filter((t) => ONLY.includes(t.id));
if (requested.length === 0) {
  log(`\n  --only "${ONLY.join(',')}" matched no target. Known: ${TARGETS.map((t) => t.id).join(', ')}\n`);
  process.exit(1);
}

log('');
log('  just verify-all — both targets, one verdict');
log('');
for (const t of TARGETS) {
  const asked = requested.includes(t);
  const reason = asked ? t.ready() : 'not requested (--only)';
  log(`    ${t.id.padEnd(11)} ${(asked ? (reason ? 'CANNOT RUN' : t.cost) : 'not requested').padEnd(22)} ${t.what}`);
  if (asked && reason) log(`    ${''.padEnd(11)} ${''.padEnd(22)} ${reason}`);
}
log('');
if (LIST) process.exit(0);

// ───────────────────────────────────────────────────────────────── the run
//
// Strictly sequential, and that is a requirement rather than a simplification:
// T5 §10 measured that a second packaged WebView2 window opens no debug port of
// its own, and the harness and the packaged phase both want one.

const results = [];
for (const t of requested) {
  const reason = t.ready();
  if (reason) {
    log(`\n════ ${t.name}: SKIPPED — ${reason}\n`);
    results.push({ id: t.id, name: t.name, status: 'skipped', reason, seconds: 0 });
    continue;
  }
  log(`\n════ ${t.name} — ${t.what}`);
  log(`     expected ${t.cost}\n`);
  const r = t.run();
  if (r.skipped) {
    log(`\n════ ${t.name}: SKIPPED — ${r.skipped}\n`);
    results.push({ id: t.id, name: t.name, status: 'skipped', reason: r.skipped, seconds: r.seconds });
  } else if (r.error) {
    results.push({ id: t.id, name: t.name, status: 'failed', reason: r.error.message, seconds: r.seconds });
  } else {
    results.push({
      id: t.id,
      name: t.name,
      status: r.status === 0 ? 'passed' : 'failed',
      exit: r.status,
      detail: r.detail ?? null,
      steps: r.steps ?? null,
      problems: r.problems ?? null,
      seconds: r.seconds,
    });
  }
}

// ───────────────────────────────────────────────────────────────── verdict

const ran = results.filter((r) => r.status !== 'skipped');
const failed = results.filter((r) => r.status === 'failed');
const passed = results.filter((r) => r.status === 'passed');
const skipped = results.filter((r) => r.status === 'skipped');
const notRequested = TARGETS.filter((t) => !requested.includes(t));
const total = results.reduce((n, r) => n + r.seconds, 0);

const code = failed.length > 0 ? 1 : ran.length === 0 ? 2 : skipped.length > 0 || notRequested.length > 0 ? 3 : 0;
const VERDICT = { 0: 'OK', 1: 'FAIL', 2: 'NOTHING VERIFIED', 3: 'INCOMPLETE' }[code];

const report = {
  verdict: VERDICT,
  exit: code,
  webCaptureDir: rel(WEB_OUT),
  ranAt: new Date().toISOString(),
  seconds: total,
  targets: results,
  notRequested: notRequested.map((t) => t.id),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 't7-verify-all.json'), `${JSON.stringify(report, null, 2)}\n`);

log('');
log('  ─────────────────────────────────────────────────────────────────────');
for (const r of results) {
  log(`    ${r.status.toUpperCase().padEnd(8)} ${r.name.padEnd(18)} ${`${String(r.seconds)}s`.padEnd(6)} ${r.detail ?? r.reason ?? ''}`);
}
for (const t of notRequested) log(`    ${'—'.padEnd(8)} ${t.name.padEnd(18)} ${''.padEnd(6)} not requested (--only)`);
log('  ─────────────────────────────────────────────────────────────────────');
log('');
log(
  `  ${String(passed.length)} target(s) verified, ${String(failed.length)} failed, ` +
    `${String(skipped.length + notRequested.length)} not verified. ` +
    `${String(Math.floor(total / 60))}m ${String(total % 60)}s.`,
);
log('');

if (code === 0) {
  log(`  OK    every target ran and passed: ${passed.map((r) => r.id).join(', ')}.`);
  log(`        Report: ${rel(path.join(OUT, 't7-verify-all.json'))}`);
} else if (code === 1) {
  log(`  FAIL  ${String(failed.length)} target(s) failed:`);
  for (const r of failed) log(`    - ${r.name}: ${r.detail ?? r.reason ?? `exit ${String(r.exit)}`}`);
} else if (code === 2) {
  log('  NOTHING VERIFIED. Not one target could run, so this run says nothing about this tree.');
  for (const r of skipped) log(`    - ${r.name}: ${r.reason}`);
} else {
  log(`  INCOMPLETE — ${String(passed.length)} target(s) passed and ${String(skipped.length + notRequested.length)} were not verified.`);
  log('  This is exit 3, not exit 0, deliberately: a green half is not a green tree.');
  for (const r of skipped) log(`    - ${r.name}: ${r.reason}`);
  for (const t of notRequested) log(`    - ${t.name}: not requested (--only)`);
}
log('');
process.exit(code);
