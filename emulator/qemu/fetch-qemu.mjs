#!/usr/bin/env node
/**
 * Q1 - portable install of Espressif's QEMU fork.
 *
 * Native Windows x86-64 binaries, extracted under tools/qemu/ (gitignored).
 * Nothing machine-wide, no PATH changes, no WSL2 needed.
 *
 * The archive is checked against Espressif's own published SHA-256 manifest
 * from the same release, not against a digest hard-coded here, so a re-pin is
 * a one-line change and the check still comes from upstream.
 *
 * Usage: node emulator/qemu/fetch-qemu.mjs [--release <tag>] [--force]
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

// Pinned deliberately. Never "latest" - the same rule F3 applied to the
// arduino-esp32 core applies here: a floating emulator version would make every
// result in docs/findings/Q1-qemu-spike.md unreproducible.
const RELEASE = arg('release', 'esp-develop-9.2.2-20260417');
const STAMP = RELEASE.replace(/^esp-develop-/, 'esp_develop_').replace(/-(\d{8})$/, '_$1');
const ASSET = `qemu-xtensa-softmmu-${STAMP}-x86_64-w64-mingw32.tar.xz`;
const MANIFEST = `qemu-${STAMP}-checksum.sha256`;
const BASE = `https://github.com/espressif/qemu/releases/download/${RELEASE}`;

const DEST = path.join(REPO, 'tools', 'qemu');
const DL = path.join(DEST, 'dl');
const BIN = path.join(DEST, 'qemu', 'bin', 'qemu-system-xtensa.exe');

if (fs.existsSync(BIN) && process.argv.indexOf('--force') < 0) {
  console.log(`[q1] already installed: ${BIN}`);
  console.log(execFileSync(BIN, ['--version'], { encoding: 'utf8' }).split('\n')[0]);
  process.exit(0);
}

fs.mkdirSync(DL, { recursive: true });
const get = (url, out) => {
  console.log(`[q1] GET ${url}`);
  execFileSync('curl', ['-sSL', '--fail', '-o', out, url], { stdio: ['ignore', 'inherit', 'inherit'] });
};

const manifestPath = path.join(DL, MANIFEST);
const archivePath = path.join(DL, ASSET);
get(`${BASE}/${MANIFEST}`, manifestPath);
get(`${BASE}/${ASSET}`, archivePath);

const want = (fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  .find((l) => l.includes(ASSET) && !l.trimStart().startsWith('#')) ?? '').trim().split(/\s+/)[0];
const got = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
if (!want) { console.error(`[q1] no digest for ${ASSET} in ${MANIFEST}`); process.exit(1); }
if (want !== got) {
  console.error(`[q1] SHA-256 MISMATCH\n  expected ${want}\n  actual   ${got}`);
  fs.rmSync(archivePath, { force: true });
  process.exit(1);
}
console.log(`[q1] sha256 OK ${got}`);

execFileSync('tar', ['-xf', archivePath], { cwd: DEST, stdio: 'inherit' });
console.log(`[q1] installed ${BIN}`);
console.log(execFileSync(BIN, ['--version'], { encoding: 'utf8' }).split('\n')[0]);
console.log(execFileSync(BIN, ['-machine', 'help'], { encoding: 'utf8' })
  .split('\n').filter((l) => /esp/i.test(l)).join('\n'));
