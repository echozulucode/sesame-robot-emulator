#!/usr/bin/env node
/**
 * `pnpm dev` — the lab host and the Vite dev server together.
 *
 * Why this exists: `vite dev` proxies /api, /lab, /cmd, /getSettings and
 * /setSettings to a lab host at 127.0.0.1:8099 (see apps/web/vite.config.ts).
 * Running Vite alone therefore serves the app fine but leaves the QEMU backend
 * reporting `no lab host at … (HTTP 500)`, because there is nothing behind the
 * proxy. Two terminals is the real requirement; this is one command that does
 * both and tears both down together.
 *
 * Deliberately dependency-free — no concurrently, no npm-run-all. The whole web
 * app was built without adding a dependency; a process launcher is not the
 * place to start.
 *
 *   pnpm dev                  lab host (qemu) + vite
 *   pnpm dev --backend sim    lab host (simulator) + vite, no emulator boot
 *   pnpm dev --host-port 9099 move the lab host off 8099
 *
 * For a single-origin run with no hot reload, skip this entirely:
 *   node apps/web/server/lab-host.mjs
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'Run the lab host and the Vite dev server together.\n\n' +
      'usage: pnpm dev [--backend qemu|sim] [--host-port 8099]\n\n' +
      '  --backend    which robot the lab host fronts (default: qemu)\n' +
      '  --host-port  lab host port; must match vite.config.ts proxy or\n' +
      '               SESAME_LAB_HOST (default: 8099)\n',
  );
  process.exit(0);
}

const backend = flag('backend', 'qemu');
const hostPort = flag('host-port', '8099');

if (!['qemu', 'sim'].includes(backend)) {
  process.stderr.write(`dev-lab: --backend must be qemu or sim, got "${backend}"\n`);
  process.exit(2);
}

/** @type {import('node:child_process').ChildProcess[]} */
const kids = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const kid of kids) {
    if (kid.exitCode === null && kid.signalCode === null) {
      // On Windows a plain kill() leaves the grandchild (vite's esbuild, and
      // qemu under the lab host) running, so go through the tree.
      if (process.platform === 'win32' && kid.pid !== undefined) {
        spawn('taskkill', ['/pid', String(kid.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        kid.kill('SIGTERM');
      }
    }
  }
  setTimeout(() => process.exit(code), 400);
}

function launch(label, command, args, colour, options = {}) {
  // No `shell: true`. On Windows that concatenates rather than escapes the
  // args (DEP0190) and it is unnecessary: the only non-.exe command here is
  // pnpm, which ships a .cmd shim that spawn() can execute directly.
  const kid = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  kids.push(kid);
  const prefix = `[${colour}m[${label}][0m `;
  const pipe = (stream) => {
    let carry = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      carry += chunk;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(kid.stdout);
  pipe(kid.stderr);
  kid.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${prefix}exited (${signal ?? String(code)}) - stopping the other process too\n`,
    );
    shutdown(code ?? 1);
  });
  return kid;
}

/** Fail with a sentence instead of an EADDRINUSE stack trace. */
async function requireFreePort(port) {
  const free = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(Number(port), '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (!free) {
    process.stderr.write(
      [
        `dev-lab: 127.0.0.1:${port} is already in use.`,
        '        A lab host is probably still running from an earlier session.',
        '        Stop it, or pick another port with --host-port (and set',
        '        SESAME_LAB_HOST to match, since vite.config.ts proxies to 8099).',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.stdout.write(
  `dev-lab: lab host (${backend}) on :${hostPort}, vite in front of it\n` +
    'dev-lab: open the vite URL below, not the lab host one - the proxy keeps it one origin\n\n',
);

await requireFreePort(hostPort);

launch(
  'lab-host',
  process.execPath,
  ['apps/web/server/lab-host.mjs', '--port', hostPort, '--backend', backend],
  '36',
);

// Vite starts fast and retries the proxy per request, so it does not need the
// lab host to be listening first — but the QEMU boot takes seconds, and a page
// loaded during it shows "booting real firmware". Give the host a head start so
// the first paint is usually already connected.
setTimeout(() => {
  // Run Vite's JS entry under this same node, rather than going through the
  // pnpm shim. Node 24 refuses to spawn a .cmd directly (EINVAL, the CVE-2024-27980
  // hardening), and reaching for `shell: true` to work around it reintroduces
  // DEP0190. Executing the entry point sidesteps both.
  const viteEntry = path.resolve('apps/web/node_modules/vite/bin/vite.js');
  if (!fs.existsSync(viteEntry)) {
    process.stderr.write(
      [`dev-lab: cannot find ${viteEntry}`, '        Run `pnpm install` first.', ''].join('\n'),
    );
    shutdown(2);
    return;
  }
  launch('vite', process.execPath, [viteEntry], '35', { cwd: path.resolve('apps/web') });
}, backend === 'qemu' ? 2500 : 300);
