#!/usr/bin/env node
/**
 * Q1 - build the flash images this spike boots.
 *
 * Why this exists rather than "just use firmware/artifacts/<profile>":
 * arduino-esp32's `FlashMode=qio` selects the QIO second-stage bootloader, and
 * QEMU's SPI flash model does not implement the status-register Quad-Enable
 * bit. The stock QIO image therefore panics in ESP-IDF's `init_flash`
 * (startup_funcs.c:118) before user code, on a completely healthy emulator.
 * Rebuilding with `FlashMode=dio` is the ONLY change; on the esp32 board that
 * option does not even alter the image header (boards.txt sets
 * `build.flash_mode=dio` for both), it only picks bootloader_dio_80m over
 * bootloader_qio_80m. The application code is unchanged.
 *
 * Three images are produced:
 *   distro-v1-esp32-dio      stock Sesame V1 firmware, DIO bootloader
 *   distro-v3-s3-dio         stock Sesame V3 firmware, DIO bootloader
 *   distro-v1-esp32-nowifi   V1 + R6 telemetry patch + the Wi-Fi elision, with
 *                            `currentCommand = "wave"` injected at boot
 *                            (see make-nowifi-variant.mjs - NOT stock firmware)
 *   distro-v1-esp32-cli      the same elision WITHOUT the injected movement.
 *                            What QemuSesameRobot boots: it comes up idle and
 *                            takes its orders from the firmware's own serial
 *                            CLI on UART0 (Q2). NOT stock firmware either.
 *   distro-v1-esp32-cli-oled byte-for-byte the `cli` recipe plus ONE token,
 *                            -DSESAME_TELEMETRY_OLED=1, which the patch's own
 *                            `#ifndef SESAME_TELEMETRY_OLED` leaves overridable
 *                            without touching its in-source default of 0. That
 *                            turns on the `@SESAME oled b64` hook so the 1024
 *                            bytes of Adafruit_SSD1306's framebuffer leave the
 *                            guest over UART0 and the panel's pixels stop being
 *                            re-derived host-side. EXP6 proved the hook
 *                            compiles and round-trips; this image is what makes
 *                            it RUN. See docs/findings/EXP6-QEMU-oled.md.
 *
 * Everything happens in gitignored scratch under tools/; firmware/ is untouched
 * and the repo's firmware/build/sketch.yaml is not modified - the extra
 * profiles are injected into the SCRATCH copy of sketch.yaml by this script, so
 * the profile text itself is version-controlled here.
 *
 * Usage: node emulator/qemu/build-qemu-images.mjs [v1|s3|nowifi|cli|cli-oled|all]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import { parseArgs } from './args.mjs';

const opts = parseArgs({
  name: 'build-qemu-images.mjs',
  summary: 'Assemble bootloader + partition table + app into QEMU-bootable flash images.',
  flags: {
    // The patch's `#ifndef SESAME_TELEMETRY_OLED_MIN_MS` default is 500, sized
    // for a 115200 UART where one frame is ~120 ms of wire time. QEMU's UART0
    // is a TCP socket with no baud rate, so the right value here is a
    // measurement rather than an inheritance - see docs/findings/EXP6-QEMU-oled.md
    // and emulator/qemu/probe-oled.mjs. Overridden the same way the hook itself
    // is: one -D, source default untouched.
    'oled-min-ms': { describe: 'SESAME_TELEMETRY_OLED_MIN_MS for the cli-oled image', type: 'number', default: 0 },
    'oled-suffix': { describe: 'suffix for the cli-oled output name (for A/B builds)', default: '' },
  },
  positional: ['all|v1|nowifi|cli|cli-oled|s3'],
});
const which = (opts._[0] ?? 'all').toLowerCase();

const CLI = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.exe');
const CFG = path.join(REPO, 'tools', 'arduino-cli', 'arduino-cli.yaml');
const SCRATCH = path.join(REPO, 'tools', 'arduino-data', 'scratch');
const IMAGES = path.join(REPO, 'emulator', 'qemu', 'images');
const SKETCH_NAME = 'sesame-firmware-main';

// Same environment discipline as scripts/build-firmware.mjs: every arduino-cli
// call is confined to tools/, and the build is made deterministic.
const ENV = {
  ...process.env,
  ARDUINO_DIRECTORIES_DATA: path.join(REPO, 'tools', 'arduino-data', 'data'),
  ARDUINO_DIRECTORIES_DOWNLOADS: path.join(REPO, 'tools', 'arduino-data', 'downloads'),
  ARDUINO_DIRECTORIES_USER: path.join(REPO, 'tools', 'arduino-data', 'user'),
  ARDUINO_BUILD_CACHE_PATH: path.join(REPO, 'tools', 'arduino-data', 'builds'),
  TZ: 'UTC', LC_ALL: 'C', SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '1700000000',
};

const LIBS = `    platforms:
      - platform: esp32:esp32 (3.3.11)
        platform_index_url: https://espressif.github.io/arduino-esp32/package_esp32_index.json
    libraries:
      - ESP32Servo (3.0.9)
      - Adafruit SSD1306 (2.5.17)
      - Adafruit GFX Library (1.12.6)
      - Adafruit BusIO (1.17.4)
`;
// Identical to firmware/build/sketch.yaml's distro-v1-esp32 / distro-v3-s3
// entries except for FlashMode.
const PROFILES = {
  'distro-v1-esp32-qemu': `  distro-v1-esp32-qemu:
    notes: Q1 spike - distro-v1-esp32 with FlashMode=dio for Espressif QEMU.
    fqbn: esp32:esp32:esp32:FlashMode=dio,FlashFreq=80,FlashSize=4M,PartitionScheme=default,UploadSpeed=921600,CPUFreq=240,PSRAM=disabled,DebugLevel=none,LoopCore=1,EventsCore=1,EraseFlash=none
${LIBS}`,
  'distro-v3-s3-qemu': `  distro-v3-s3-qemu:
    notes: Q1 spike - distro-v3-s3 with FlashMode=dio for Espressif QEMU.
    fqbn: esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=dio,FlashSize=4M,PartitionScheme=default,UploadSpeed=921600,CPUFreq=240,PSRAM=disabled,DebugLevel=none,LoopCore=1,EventsCore=1,USBMode=hwcdc,EraseFlash=none
${LIBS}`,
};

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env: ENV, encoding: 'utf8', maxBuffer: 512 << 20, ...opts });
  if (r.status !== 0) { console.error(r.stdout ?? ''); console.error(r.stderr ?? ''); throw new Error(`${cmd} exited ${r.status}`); }
  return r.stdout ?? '';
};

/** The base profile's patched scratch sketch, built by the standard machinery. */
function ensureBaseScratch(baseProfile) {
  const dir = path.join(SCRATCH, baseProfile, SKETCH_NAME);
  if (fs.existsSync(path.join(dir, `${SKETCH_NAME}.ino`))) return dir;
  console.log(`[q1] scratch for ${baseProfile} missing - running the standard build to produce it`);
  run(process.execPath, [path.join(REPO, 'scripts', 'build-firmware.mjs'), baseProfile], { stdio: 'inherit' });
  return dir;
}

function stage(name, baseProfile) {
  const src = ensureBaseScratch(baseProfile);
  const dst = path.join(SCRATCH, name, SKETCH_NAME);
  fs.rmSync(path.join(SCRATCH, name), { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === 'build') continue;
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return dst;
}

/** git apply, in a throwaway repo rooted at the sketch - see F3 section 5. */
function applyPatch(dir, patch) {
  run('git', ['init', '-q', '.'], { cwd: dir });
  try {
    const out = run('git', ['-c', 'core.autocrlf=false', 'apply', '-v', '-p1', patch], { cwd: dir });
    if (/Skipped patch/.test(out)) throw new Error(`git apply silently skipped ${patch}`);
  } finally {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  }
}

function addProfile(dir, profile) {
  const p = path.join(dir, 'sketch.yaml');
  const s = fs.readFileSync(p, 'utf8');
  if (s.includes(`  ${profile}:`)) return;
  fs.writeFileSync(p, s.replace('default_profile:', `${PROFILES[profile]}\ndefault_profile:`));
}

/**
 * `defines` are injected through `compiler.cpp.extra_flags`, the same lever
 * scripts/build-firmware.mjs uses for the s2mini-oled profile, rather than by
 * editing the patch. The checked-in source default stays 0, every other build
 * property stays identical, and the difference between two images is then
 * exactly the tokens listed here - which is what makes the cost delta
 * attributable to the hook instead of to "a different build".
 */
function compile(name, profile, outName, defines = []) {
  const dir = path.join(SCRATCH, name, SKETCH_NAME);
  const build = path.join(SCRATCH, name, 'build');
  const out = path.join(SCRATCH, name, 'out');
  const extra = defines.length
    ? ['--build-property', `compiler.cpp.extra_flags=${defines.map((d) => `-D${d}`).join(' ')}`]
    : [];
  run(CLI, ['--config-file', CFG, 'compile', '--profile', profile, ...extra,
    '--build-path', build, '--output-dir', out, '--warnings', 'default', dir], { stdio: 'inherit' });
  fs.mkdirSync(IMAGES, { recursive: true });
  const merged = path.join(out, `${SKETCH_NAME}.ino.merged.bin`);
  const img = path.join(IMAGES, `${outName}.flash.bin`);
  fs.copyFileSync(merged, img);
  console.log(`[q1] ${outName}.flash.bin  sha256 ${sha256(img)}`);
  console.log(`[q1]   elf                 sha256 ${sha256(path.join(out, `${SKETCH_NAME}.ino.elf`))}`);
}

if (!fs.existsSync(CLI)) {
  console.error(`missing arduino-cli: ${CLI}\nrun scripts/setup-firmware-toolchain.ps1 first`);
  process.exit(2);
}

if (which === 'v1' || which === 'all') {
  console.log('\n=== distro-v1-esp32-dio (stock firmware, DIO bootloader) ===');
  const d = stage('qemu-dio', 'distro-v1-esp32');
  addProfile(d, 'distro-v1-esp32-qemu');
  compile('qemu-dio', 'distro-v1-esp32-qemu', 'distro-v1-esp32-dio');
}
if (which === 's3' || which === 'all') {
  console.log('\n=== distro-v3-s3-dio (stock firmware, DIO bootloader) ===');
  const d = stage('qemu-s3-dio', 'distro-v3-s3');
  addProfile(d, 'distro-v3-s3-qemu');
  compile('qemu-s3-dio', 'distro-v3-s3-qemu', 'distro-v3-s3-dio');
}
if (which === 'nowifi' || which === 'all') {
  console.log('\n=== distro-v1-esp32-nowifi (MODIFIED: telemetry + Wi-Fi elided + boot wave) ===');
  const d = stage('qemu-nowifi', 'distro-v1-esp32');
  applyPatch(d, path.join(REPO, 'firmware', 'patches', 'telemetry-instrumentation.patch'));
  addProfile(d, 'distro-v1-esp32-qemu');
  execFileSync(process.execPath, [path.join(REPO, 'emulator', 'qemu', 'make-nowifi-variant.mjs')], { stdio: 'inherit' });
  compile('qemu-nowifi', 'distro-v1-esp32-qemu', 'distro-v1-esp32-nowifi');
}
if (which === 'cli' || which === 'all') {
  // Q2: identical to `nowifi` except that nothing is injected into setup().
  // The robot boots idle and every movement it performs is one the host asked
  // for over the serial CLI, which is what makes QemuSesameRobot's event stream
  // attributable to a command instead of to a boot-time side effect.
  console.log('\n=== distro-v1-esp32-cli (MODIFIED: telemetry + Wi-Fi elided, serial CLI only) ===');
  const d = stage('qemu-cli', 'distro-v1-esp32');
  applyPatch(d, path.join(REPO, 'firmware', 'patches', 'telemetry-instrumentation.patch'));
  addProfile(d, 'distro-v1-esp32-qemu');
  execFileSync(process.execPath, [
    path.join(REPO, 'emulator', 'qemu', 'make-nowifi-variant.mjs'),
    '--scratch', 'qemu-cli', '--trigger', 'none',
  ], { stdio: 'inherit' });
  compile('qemu-cli', 'distro-v1-esp32-qemu', 'distro-v1-esp32-cli');
}
if (which === 'cli-oled' || which === 'all') {
  // EXP6-QEMU: the `cli` recipe verbatim - same base scratch, same telemetry
  // patch, same Wi-Fi elision, same `--trigger none` - plus one -D.
  //
  // On distro-v1-esp32 there is no USB peripheral, so ARDUINO_USB_CDC_ON_BOOT
  // is 0, `Serial` IS `Serial0`, and the hook's printf goes to the same UART0
  // socket QemuSesameRobot already reads. Nothing else has to change.
  const minMs = Number(opts['oled-min-ms'] ?? 0);
  const suffix = String(opts['oled-suffix'] ?? '');
  const scratch = `qemu-cli-oled${suffix}`;
  console.log(`\n=== distro-v1-esp32-cli-oled${suffix} (MODIFIED: cli + -DSESAME_TELEMETRY_OLED=1, MIN_MS=${minMs}) ===`);
  const d = stage(scratch, 'distro-v1-esp32');
  applyPatch(d, path.join(REPO, 'firmware', 'patches', 'telemetry-instrumentation.patch'));
  addProfile(d, 'distro-v1-esp32-qemu');
  execFileSync(process.execPath, [
    path.join(REPO, 'emulator', 'qemu', 'make-nowifi-variant.mjs'),
    '--scratch', scratch, '--trigger', 'none',
  ], { stdio: 'inherit' });
  compile(scratch, 'distro-v1-esp32-qemu', `distro-v1-esp32-cli-oled${suffix}`,
    ['SESAME_TELEMETRY_OLED=1', `SESAME_TELEMETRY_OLED_MIN_MS=${minMs}`]);
}
