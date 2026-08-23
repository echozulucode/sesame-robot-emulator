#!/usr/bin/env node
/**
 * R4 - fetch Espressif's official ESP32-S2 mask-ROM image and slice it into flat
 * binaries Renode can load.
 *
 * WHY: docs/findings/R4-boot-probe.md, blocker 2. The Sesame S2 ELF makes 1209
 * references to 126 distinct symbols in the ROM window 0x40000000-0x4001FFFF
 * (memcpy, memset, esp_rom_printf, the libgcc soft-float set, ...). The
 * esp32s2-sesame platform has no ROM, so the FIRST ROM call aborts the CPU with
 * "Trying to execute code outside RAM or ROM". Espressif publishes the ROM as an
 * ELF with symbols in github.com/espressif/esp-rom-elfs (the same artifact
 * OpenOCD/GDB use for ROM backtraces), so this is a download, not a reverse
 * engineering exercise.
 *
 * Everything lands under tools/ (gitignored, never machine-wide), per ADR-0002.
 *
 *   node scripts/fetch-esp32s2-rom.mjs
 *
 * Produces in tools/esp-rom-elfs/:
 *   esp32s2_rev0_rom.elf   the upstream ELF (symbols; also usable by GDB)
 *   rom-code.bin           all AX sections, flat, load at 0x40000000
 *   rom-rodata.bin         .rodata,               load at 0x3FFAC600
 *   rom-data.bin           the non-empty .data_* set,     load at 0x3FFFEB70
 *
 * The three flat images are used instead of `sysbus LoadELF` on the ROM ELF
 * because that ELF carries a program header with p_offset 0 / p_filesz 0x434
 * over a NOBITS range, i.e. loading it verbatim would splatter the ELF header
 * into the ROM's shared-buffer area at 0x3FFEA6D0. Slicing by section makes the
 * loaded bytes exactly auditable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(REPO, 'tools', 'esp-rom-elfs');
const TAG = '20260528';
const TARBALL = `esp-rom-elfs-${TAG}.tar.gz`;
const URL = `https://github.com/espressif/esp-rom-elfs/releases/download/${TAG}/${TARBALL}`;
// From esp-rom-elfs-20260528-checksum.sha256 published beside the tarball.
const TARBALL_SHA256 = 'caa463d3cbef2430a5a35847c1d9f2f152403b17a802050927ff60c8da54fe46';
const ELF = path.join(DIR, 'esp32s2_rev0_rom.elf');
const OBJCOPY = path.join(REPO, 'tools', 'arduino-data', 'data', 'packages', 'esp32', 'tools',
  'esp-x32', '2601', 'bin', 'xtensa-esp32s2-elf-objcopy.exe');

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

fs.mkdirSync(DIR, { recursive: true });
const tar = path.join(DIR, TARBALL);
if (!fs.existsSync(tar)) {
  console.log(`[fetch] ${URL}`);
  execFileSync('curl', ['-sL', '--fail', '-m', '600', '-o', tar, URL], { stdio: 'inherit' });
}
const got = sha256(tar);
if (got !== TARBALL_SHA256) {
  console.error(`[verify] SHA-256 MISMATCH\n  expected ${TARBALL_SHA256}\n  got      ${got}`);
  process.exit(1);
}
console.log(`[verify] ${TARBALL} sha256 ${got}  OK`);
if (!fs.existsSync(ELF)) {
  execFileSync('tar', ['xzf', tar, '-C', DIR], { stdio: 'inherit' });
}
console.log(`[elf]    ${path.relative(REPO, ELF)}  ${fs.statSync(ELF).size} bytes  sha256=${sha256(ELF)}`);

// Section groups, verified against `readelf -S esp32s2_rev0_rom.elf`.
const GROUPS = [
  ['rom-code.bin', 0x40000000, [
    '.WindowVectors.text', '.Level2InterruptVector.text', '.Level3InterruptVector.text',
    '.Level4InterruptVector.text', '.Level5InterruptVector.text', '.DebugExceptionVector.text',
    '.NMIExceptionVector.text', '.KernelExceptionVector.text', '.UserExceptionVector.text',
    '.DoubleExceptionVector.text', '.ResetVector.text', '.bt_text', '.text',
  ]],
  ['rom-rodata.bin', 0x3ffac600, ['.rodata']],
  // Only the non-empty initialised-data sections, based at the first of them, so
  // objcopy's gap fill cannot spill zeros across the ROM BSS/stack area below.
  ['rom-data.bin', 0x3fffeb70, [
    '.data_xtos', '.data_usbdev', '.data_spi_flash', '.data_ets_delay',
    '.data_c', '.data_phyrom',
  ]],
];

for (const [name, base, sections] of GROUPS) {
  const out = path.join(DIR, name);
  const args = ['-O', 'binary', '--gap-fill', '0'];
  // The ROM ELF's .data_* sections carry SHF_WRITE but NOT SHF_ALLOC, and
  // `objcopy -O binary` silently drops non-alloc sections - which produced a
  // 0-byte rom-data.bin the first time. Force the flag before selecting them.
  for (const s of sections) args.push('--set-section-flags', `${s}=alloc,load,contents`);
  for (const s of sections) args.push('-j', s);
  args.push(ELF, out);
  execFileSync(OBJCOPY, args, { stdio: 'inherit' });
  const size = fs.statSync(out).size;
  console.log(`[slice]  ${name.padEnd(16)} load @ 0x${base.toString(16).toUpperCase()}  ` +
              `${size} bytes  ends 0x${(base + size).toString(16).toUpperCase()}  sha256=${sha256(out)}`);
}
