#!/usr/bin/env node
/**
 * `just doctor` — check the prerequisites the recipes actually need.
 *
 * This exists because of a real failure: `vite dev` proxies /api and /lab to a
 * lab host on :8099, so running Vite alone left the QEMU backend reporting
 * "no lab host (HTTP 500)" with nothing to say why. Several of the things
 * below are gitignored (tools/, firmware/upstream/, dist/), so a fresh clone
 * is *expected* to fail some of these — the point is to say which, and what to
 * run.
 */

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

import { PREREQS, inspect } from './lib/prereqs.mjs';

/** The row names `just setup` can actually do something about. */
const FETCHABLE = new Set(PREREQS.filter((p) => p.setup !== null).map((p) => p.name));

const REPO = process.cwd();
const rows = [];
let failures = 0;
let warnings = 0;

const add = (level, name, detail, fix = '') => {
  rows.push({ level, name, detail, fix });
  if (level === 'FAIL') failures += 1;
  if (level === 'WARN') warnings += 1;
};

// Node 24 refuses to execFile a .cmd shim directly (EINVAL, the CVE-2024-27980
// hardening), which is exactly how pnpm ships on Windows — so a plain
// execFileSync('pnpm') reports "not found" on a machine where pnpm works fine.
// Route through cmd.exe there.
const version = (cmd, args) => {
  const [bin, argv] =
    process.platform === 'win32' && !cmd.endsWith('.exe')
      ? ['cmd.exe', ['/c', cmd, ...args]]
      : [cmd, args];
  try {
    return execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0];
  } catch {
    return null;
  }
};

// ── toolchain ────────────────────────────────────────────────────────────
const node = process.version;
const major = Number(node.slice(1).split('.')[0]);
add(major >= 20 ? 'OK' : 'FAIL', 'node', node, major >= 20 ? '' : 'Node 20+ required');

const pnpm = version('pnpm', ['--version']);
add(pnpm ? 'OK' : 'FAIL', 'pnpm', pnpm ?? 'not found', pnpm ? '' : 'npm i -g pnpm');

const py = version('python', ['--version']);
add(py ? 'OK' : 'WARN', 'python', py ?? 'not found', py ? '' : 'only needed for asset regeneration');

// ── the fetched-and-built prerequisites ──────────────────────────────────
//
// One list, shared with `just setup` — scripts/lib/prereqs.mjs. Before T7
// these rows were written out here and the four fetch commands were written out
// in the README, and nothing made the two agree; `just setup` now runs the same
// array this prints, so a prerequisite cannot be visible to one and invisible
// to the other.
for (const p of inspect(REPO)) {
  add(p.present ? 'OK' : p.level, p.name, p.detail, p.present ? '' : p.fix);
}

// ── ports ────────────────────────────────────────────────────────────────
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

// 8099 and 5173 are hard requirements: dev-lab.mjs pre-flights 8099 and exits,
// and vite cannot bind 5173. Report those as blocking rather than advisory --
// an earlier version said "none blocking" while `just dev` could not start.
for (const [port, who, blocking] of [
  [8099, 'lab host (just dev)', true],
  [5173, 'vite (just dev)', true],
  [8080, 'sesame-api (just api)', false],
]) {
  // eslint-disable-next-line no-await-in-loop
  const free = await portFree(port);
  add(
    free ? 'OK' : blocking ? 'FAIL' : 'WARN',
    `port ${String(port)}`,
    free ? 'free' : `in use - ${who} cannot start`,
    free ? '' : 'stop it, or it may be your own dev server already running',
  );
}

// ── report ───────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const tint = { OK: '[32m', WARN: '[33m', FAIL: '[31m' };
process.stdout.write('\n');
for (const r of rows) {
  process.stdout.write(
    `  ${tint[r.level]}${pad(r.level, 5)}[0m ${pad(r.name, 20)} ${pad(r.detail, 34)}` +
      (r.fix && r.level !== 'OK' ? `  [2m${r.fix}[0m` : '') +
      '\n',
  );
}
process.stdout.write('\n');

// Every gitignored row above is something `just setup` fetches or builds. It is
// named here rather than only in the README because this is the screen a person
// is looking at when they need it, and because a reader who fixes the rows by
// hand, one command at a time, is doing exactly what T7 exists to remove.
const fetchable = rows.filter((r) => r.level !== 'OK' && FETCHABLE.has(r.name));
if (fetchable.length > 0) {
  process.stdout.write(
    `  ${String(fetchable.length)} of the rows above (${fetchable.map((r) => r.name).join(', ')}) ` +
      'are fetched or built by `just setup`, which is safe to re-run.\n\n',
  );
}

if (failures > 0) {
  process.stdout.write(`  ${String(failures)} blocking problem(s). Fix the FAIL rows above, then re-run.\n\n`);
  process.exit(1);
}
process.stdout.write(
  warnings > 0
    ? `  Ready - ${String(warnings)} warning(s), none blocking \`just dev\`.\n\n`
    : '  Ready. Run `just dev`.\n\n',
);
