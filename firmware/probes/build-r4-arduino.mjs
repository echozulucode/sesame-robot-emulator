#!/usr/bin/env node
/**
 * R4 / Experiment 4 - build the minimal Arduino sketch with F3's EXACT profile
 * machinery.
 *
 * This is deliberately NOT a parallel build system: it reuses
 *  - tools/arduino-cli/arduino-cli.exe + arduino-cli.yaml  (F3's portable CLI)
 *  - firmware/build/sketch.yaml                            (F3's pinned profiles)
 *  - the same ARDUINO_DIRECTORIES_* / SOURCE_DATE_EPOCH env that
 *    scripts/build-firmware.mjs sets, copied verbatim from it
 * so the produced ELF is compiled and linked with the same core (esp32:esp32
 * 3.3.11), the same FQBN + board options and the same toolchain as
 * firmware/artifacts/s2mini/sesame-firmware-main.ino.elf.
 *
 * The only difference from scripts/build-firmware.mjs is the source: the probe
 * sketch instead of the patched upstream Sesame sketch. Everything downstream of
 * "which .ino" is shared.
 *
 *   node firmware/probes/build-r4-arduino.mjs [profile]      (default s2mini)
 *
 * Output: firmware/probes/build/r4-arduino-min.elf (+ .bin, .map)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.exe');
const CFG = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.yaml');
const SKETCH_NAME = 'r4-arduino-min';
const profile = process.argv[2] || 's2mini';

// Copied verbatim from scripts/build-firmware.mjs so the two builds cannot drift.
const ENV = {
  ...process.env,
  ARDUINO_DIRECTORIES_DATA: path.join(REPO, 'tools', 'arduino-data', 'data'),
  ARDUINO_DIRECTORIES_DOWNLOADS: path.join(REPO, 'tools', 'arduino-data', 'downloads'),
  ARDUINO_DIRECTORIES_USER: path.join(REPO, 'tools', 'arduino-data', 'user'),
  ARDUINO_BUILD_CACHE_PATH: path.join(REPO, 'tools', 'arduino-data', 'builds'),
  TZ: 'UTC',
  LC_ALL: 'C',
  SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '1700000000',
};

const SRC_DIR = path.join(REPO, 'firmware', 'probes', 'r4', SKETCH_NAME);
const SCRATCH = path.join(REPO, 'tools', 'arduino-data', 'scratch', `r4-${profile}`);
const SKETCH_DIR = path.join(SCRATCH, SKETCH_NAME);
const BUILD_PATH = path.join(SCRATCH, 'build');
const OUT_DIR = path.join(REPO, 'firmware', 'probes', 'build');

fs.rmSync(SKETCH_DIR, { recursive: true, force: true });
fs.mkdirSync(SKETCH_DIR, { recursive: true });
for (const f of fs.readdirSync(SRC_DIR)) {
  fs.copyFileSync(path.join(SRC_DIR, f), path.join(SKETCH_DIR, f));
}
// F3's declarative pinning, unmodified.
fs.copyFileSync(path.join(REPO, 'firmware', 'build', 'sketch.yaml'),
                path.join(SKETCH_DIR, 'sketch.yaml'));

console.log(`[build] profile=${profile} sketch=${SKETCH_DIR}`);
const out = execFileSync(CLI, [
  '--config-file', CFG, 'compile',
  '--profile', profile,
  '--build-path', BUILD_PATH,
  '--warnings', 'default',
  SKETCH_DIR,
], { env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
console.log(out.split(/\r?\n/).filter((l) => /Sketch uses|Global variables|Used platform/.test(l)).join('\n'));

fs.mkdirSync(OUT_DIR, { recursive: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const ext of ['elf', 'bin', 'map']) {
  const src = path.join(BUILD_PATH, `${SKETCH_NAME}.ino.${ext}`);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(OUT_DIR, `${SKETCH_NAME}.${ext}`);
  fs.copyFileSync(src, dst);
  console.log(`[out]   ${path.relative(REPO, dst)}  ${fs.statSync(dst).size} bytes  sha256=${sha(dst)}`);
}
