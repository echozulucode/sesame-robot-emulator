#!/usr/bin/env node
/**
 * F3 - reproducible Sesame firmware build.
 *
 * Copies the pinned upstream sketch to a STABLE scratch path, applies the
 * profile's board-config patch, verifies the resulting pin/I2C configuration
 * against hardware/hardware-map.json, builds with the repo-local arduino-cli,
 * and emits .elf/.bin/.map + build-manifest.json into
 * firmware/artifacts/<profile>/.
 *
 * firmware/upstream/ is NEVER modified. The scratch copy is disposable.
 *
 * Usage: node scripts/build-firmware.mjs <profile> [--clean]
 *   <profile>  s2mini | distro-v3-s3 | distro-v1-esp32
 *   --clean    wipe the scratch sketch AND the arduino-cli build cache first
 *              (this is what the determinism check uses)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.exe');
const CFG = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.yaml');
const SKETCH_NAME = 'sesame-firmware-main';
const UPSTREAM = path.join(REPO, 'firmware', 'upstream', 'firmware');

/**
 * Profile -> board-config patch + the hardware-map board id the patched source
 * must end up matching. `patch: null` means the checked-in upstream default is
 * already the wanted configuration.
 */
const PROFILES = {
  's2mini': { patch: null, boardId: 's2-mini' },
  'distro-v3-s3': { patch: 'board-distro-v3-s3.patch', boardId: 'distro-v3' },
  'distro-v1-esp32': { patch: 'board-distro-v1-esp32.patch', boardId: 'distro-v1' },
};

const args = process.argv.slice(2);
const profile = args.find((a) => !a.startsWith('--'));
const CLEAN = args.includes('--clean');
if (!profile || !PROFILES[profile]) {
  console.error(`usage: node scripts/build-firmware.mjs <${Object.keys(PROFILES).join('|')}> [--clean]`);
  process.exit(2);
}
const spec = PROFILES[profile];

// Every arduino-cli invocation MUST carry --config-file. A bare invocation
// falls back to %LOCALAPPDATA%\Arduino15 and violates the no-machine-wide-state
// requirement (observed once during F3 setup; see docs/findings/F3-firmware-build.md).
const ENV = {
  ...process.env,
  ARDUINO_DIRECTORIES_DATA: path.join(REPO, 'tools', 'arduino-data', 'data'),
  ARDUINO_DIRECTORIES_DOWNLOADS: path.join(REPO, 'tools', 'arduino-data', 'downloads'),
  ARDUINO_DIRECTORIES_USER: path.join(REPO, 'tools', 'arduino-data', 'user'),
  // Neutralise locale/TZ influence on anything the toolchain might embed.
  TZ: 'UTC',
  LC_ALL: 'C',
  SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '1700000000',
};

const acli = (cliArgs, opts = {}) =>
  execFileSync(CLI, ['--config-file', CFG, ...cliArgs], {
    env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts,
  });

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const log = (...m) => console.log(...m);

// --------------------------------------------------------------- scratch copy
// STABLE path, deliberately: the ESP-IDF/Arduino build embeds absolute source
// and build paths in assert strings and DWARF. A per-run temp dir would make
// every build byte-different for an uninteresting reason.
const SCRATCH_ROOT = path.join(REPO, 'tools', 'arduino-data', 'scratch', profile);
const SKETCH_DIR = path.join(SCRATCH_ROOT, SKETCH_NAME);
const BUILD_PATH = path.join(SCRATCH_ROOT, 'build');
const OUT_DIR = path.join(REPO, 'firmware', 'artifacts', profile);

if (CLEAN) {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  log(`[clean] removed ${SCRATCH_ROOT}`);
}
fs.rmSync(SKETCH_DIR, { recursive: true, force: true });
fs.mkdirSync(SKETCH_DIR, { recursive: true });

// Arduino requires the .ino basename to equal its directory name. Upstream
// keeps sesame-firmware-main.ino inside a directory called "firmware", so an
// in-place build is impossible - hence the renamed scratch directory.
const sources = fs.readdirSync(UPSTREAM).filter((f) => /\.(ino|h|c|cpp)$/i.test(f));
for (const f of sources) fs.copyFileSync(path.join(UPSTREAM, f), path.join(SKETCH_DIR, f));
log(`[copy]  ${sources.length} source files -> ${SKETCH_DIR}`);

// sketch.yaml carries the declarative pinning (core version, index URL, exact
// library versions, FQBN + board options) and is what makes the build
// reproducible from a checkout.
fs.copyFileSync(path.join(REPO, 'firmware', 'build', 'sketch.yaml'), path.join(SKETCH_DIR, 'sketch.yaml'));

// --------------------------------------------------------------------- patch
let patchSha = null;
if (spec.patch) {
  const patchFile = path.join(REPO, 'firmware', 'patches', spec.patch);
  patchSha = sha256(patchFile);
  const check = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--check', '-p1', patchFile],
    { cwd: SKETCH_DIR, encoding: 'utf8' });
  if (check.status !== 0) {
    console.error(`[patch] FAILED --check for ${spec.patch}:\n${check.stderr}`);
    process.exit(1);
  }
  const ap = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '-p1', patchFile],
    { cwd: SKETCH_DIR, encoding: 'utf8' });
  if (ap.status !== 0) { console.error(`[patch] FAILED to apply:\n${ap.stderr}`); process.exit(1); }
  log(`[patch] applied ${spec.patch} (sha256 ${patchSha.slice(0, 16)}...)`);
} else {
  log('[patch] none - upstream default configuration is already the target');
}

// ------------------------------------------------- verify against F4 boundary
// A patch that applies cleanly but produces the wrong pins is worse than one
// that fails, so assert the post-patch source against hardware-map.json.
const hwmap = JSON.parse(fs.readFileSync(path.join(REPO, 'hardware', 'hardware-map.json'), 'utf8'));
const board = hwmap.boards.find((b) => b.id === spec.boardId);
if (!board) { console.error(`[verify] no board '${spec.boardId}' in hardware-map.json`); process.exit(1); }

const src = fs.readFileSync(path.join(SKETCH_DIR, `${SKETCH_NAME}.ino`), 'latin1');
const activeLines = src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('//'));
const pinLines = activeLines.filter((l) => /const\s+int\s+servoPins\s*\[\s*8\s*\]/.test(l));
if (pinLines.length !== 1) {
  console.error(`[verify] expected exactly 1 active servoPins definition, found ${pinLines.length}`);
  process.exit(1);
}
const pins = [...pinLines[0].matchAll(/-?\d+/g)].map((m) => Number(m[0])).slice(1); // drop the [8]
const grabDefine = (name) => {
  const hits = activeLines.filter((l) => new RegExp(`^\\s*#define\\s+${name}\\s+`).test(l));
  if (hits.length !== 1) {
    console.error(`[verify] expected 1 active #define ${name}, found ${hits.length}`);
    process.exit(1);
  }
  return Number(hits[0].match(/\d+\s*$/)[0]);
};
const sda = grabDefine('I2C_SDA'), scl = grabDefine('I2C_SCL');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!eq(pins, board.servoPins) || sda !== board.i2c.sda || scl !== board.i2c.scl) {
  console.error(`[verify] MISMATCH vs hardware-map.json board ${board.id}`);
  console.error(`  source: servoPins=${JSON.stringify(pins)} SDA=${sda} SCL=${scl}`);
  console.error(`  map:    servoPins=${JSON.stringify(board.servoPins)} SDA=${board.i2c.sda} SCL=${board.i2c.scl}`);
  process.exit(1);
}
log(`[verify] OK  board=${board.id} servoPins=${JSON.stringify(pins)} SDA=${sda} SCL=${scl}`);

// --------------------------------------------------------------------- build
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
if (CLEAN) fs.rmSync(BUILD_PATH, { recursive: true, force: true });
fs.mkdirSync(BUILD_PATH, { recursive: true });

log(`[build] arduino-cli compile --profile ${profile}`);
const t0 = Date.now();
const res = spawnSync(CLI, [
  '--config-file', CFG,
  'compile', '--profile', profile,
  '--build-path', BUILD_PATH,
  '--output-dir', OUT_DIR,
  '--warnings', 'default',
  '--json', SKETCH_DIR,
], { env: ENV, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
fs.writeFileSync(path.join(OUT_DIR, 'compile.stdout.json'), res.stdout ?? '');
fs.writeFileSync(path.join(OUT_DIR, 'compile.stderr.log'), res.stderr ?? '');

let parsed = null;
try { parsed = JSON.parse(res.stdout); } catch { /* non-JSON on a hard failure */ }

if (res.status !== 0) {
  console.error(`[build] FAILED after ${elapsed}s (exit ${res.status})`);
  console.error(String(parsed?.compiler_err || parsed?.error || res.stderr || '').split('\n').slice(0, 80).join('\n'));
  process.exit(1);
}
log(`[build] OK in ${elapsed}s`);

// ------------------------------------------------------------------ manifest
// The .map lands in the build dir; --output-dir does not always copy it.
const mapSrc = path.join(BUILD_PATH, `${SKETCH_NAME}.ino.map`);
if (fs.existsSync(mapSrc) && !fs.existsSync(path.join(OUT_DIR, `${SKETCH_NAME}.ino.map`))) {
  fs.copyFileSync(mapSrc, path.join(OUT_DIR, `${SKETCH_NAME}.ino.map`));
}

const props = Object.fromEntries(
  acli(['compile', '--profile', profile, '--show-properties', SKETCH_DIR])
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
);
const fqbn = props['build.fqbn'] ?? null;

// Compiler version, straight from the binary the build actually invoked.
let compiler = { path: null, version: null };
const ccBase = props['compiler.path']
  ? path.join(props['compiler.path'], props['compiler.c.cmd'] || 'gcc')
  : null;
for (const cand of [ccBase, ccBase && `${ccBase}.exe`].filter(Boolean)) {
  if (fs.existsSync(cand)) {
    compiler = { path: cand, version: execFileSync(cand, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim() };
    break;
  }
}

const artifacts = fs.readdirSync(OUT_DIR)
  .filter((f) => /\.(elf|bin|map)$/i.test(f))
  .map((f) => ({ file: f, bytes: fs.statSync(path.join(OUT_DIR, f)).size, sha256: sha256(path.join(OUT_DIR, f)) }))
  .sort((a, b) => a.file.localeCompare(b.file));

const libraries = (parsed?.builder_result?.used_libraries ?? [])
  .map((l) => ({ name: l.name, version: l.version ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name));

const cliVersion = JSON.parse(acli(['version', '--format', 'json'])).VersionString;
const coreVersion = (JSON.parse(acli(['core', 'list', '--format', 'json'])).platforms ?? [])
  .find((p) => p.id === 'esp32:esp32')?.installed_version ?? null;

const sections = parsed?.builder_result?.executable_sections_size ?? null;

const manifest = {
  profile,
  fqbn,
  boardOptions: Object.fromEntries(
    (fqbn?.split(':')[3] ?? '').split(',').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  ),
  hardwareMapBoardId: board.id,
  verifiedConfig: { servoPins: pins, i2cSda: sda, i2cScl: scl },
  upstreamCommit: JSON.parse(fs.readFileSync(path.join(REPO, 'firmware', 'upstream.pin.json'), 'utf8')).commit ?? null,
  patch: spec.patch ? { file: `firmware/patches/${spec.patch}`, sha256: patchSha } : null,
  arduinoCliVersion: cliVersion,
  arduinoEsp32CoreVersion: coreVersion,
  libraries,
  compiler,
  buildFlags: {
    'build.extra_flags': props['build.extra_flags'] ?? null,
    'build.defines': props['build.defines'] ?? null,
    'compiler.c.flags': props['compiler.c.flags'] ?? null,
    'compiler.cpp.flags': props['compiler.cpp.flags'] ?? null,
    'compiler.c.elf.flags': props['compiler.c.elf.flags'] ?? null,
    'build.partitions': props['build.partitions'] ?? null,
    'build.flash_mode': props['build.flash_mode'] ?? null,
    'build.flash_freq': props['build.flash_freq'] ?? null,
    'build.flash_size': props['build.flash_size'] ?? null,
    'build.cdc_on_boot': props['build.cdc_on_boot'] ?? null,
  },
  memory: { sections },
  artifacts,
  scratchSketchDir: SKETCH_DIR,
  buildPath: BUILD_PATH,
  sourceDateEpoch: ENV.SOURCE_DATE_EPOCH,
  buildDurationSeconds: Number(elapsed),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

log(`[out]   ${OUT_DIR}`);
for (const a of artifacts) log(`        ${a.file.padEnd(44)} ${String(a.bytes).padStart(9)}  ${a.sha256}`);
