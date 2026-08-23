#!/usr/bin/env node
/**
 * R6 - extract the `@SESAME` format strings the firmware ACTUALLY contains and
 * record them as checked-in evidence.
 *
 * The trap this exists to avoid: a test that compares a copy of the format
 * string to another copy of the same format string passes for the wrong reason.
 * Two copies of the same typo agree with each other perfectly.
 *
 * So there is exactly one authoritative source for the literals - the patched
 * firmware - and two independent readings of it:
 *
 *   1. `firmware/patches/telemetry-instrumentation.patch`, the checked-in text
 *      that produces the source. Always available, even on a clean clone with
 *      no toolchain, which is what lets the format contract be unit-tested.
 *   2. `firmware/artifacts/s2mini-instrumented/*.elf` and `*.bin`, the compiled
 *      output. Available only after a build (artifacts are gitignored), and the
 *      only reading that proves the bytes survived the compiler.
 *
 * And one thing neither reading catches on its own: **which serial port the
 * emitter actually writes to.** `Serial` is a compile-time alias in
 * Arduino-ESP32, and on the s2mini profile it is a USB CDC endpoint rather than
 * UART0 (R4 section 6.4). Telemetry aimed at it compiles, links, contains all the
 * right strings — and never reaches the transport anyone is listening to. The
 * string-presence check above is completely blind to that, so §"routing" below
 * disassembles the actual call sites and reads the `this` pointer.
 *
 * This script cross-checks (1) against (2) and writes the result to
 * `firmware/build/telemetry-literals.json`, which IS checked in - so the
 * binary-level evidence outlives the gitignored artifacts it came from.
 *
 * Usage: node scripts/extract-telemetry-literals.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTelemetryPrintfSites } from './lib/xtensa-call-args.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = path.join(REPO, 'firmware', 'patches', 'telemetry-instrumentation.patch');
const ARTIFACTS = path.join(REPO, 'firmware', 'artifacts', 's2mini-instrumented');
const OUT = path.join(REPO, 'firmware', 'build', 'telemetry-literals.json');
const CHECK = process.argv.includes('--check');

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---------------------------------------------------------------- reading 1
/**
 * Pull every `@SESAME…` C string literal out of the patch's ADDED lines.
 * Reading only `+` lines is deliberate: a literal that appears in a context
 * line came from upstream, and upstream has no telemetry.
 */
export function literalsFromPatch(patchText) {
  const added = patchText.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const found = [];
  for (const line of added) {
    if (line.trimStart().startsWith('+//')) continue;           // comments
    for (const m of line.matchAll(/"(@SESAME[^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      found.push({ literal: m[1], sourceLine: line.slice(1).trim() });
    }
  }
  return found;
}

const patchText = fs.readFileSync(PATCH, 'latin1');
const fromPatch = literalsFromPatch(patchText);
if (fromPatch.length === 0) {
  console.error('[literals] no @SESAME literals in the patch - refusing to write empty evidence');
  process.exit(1);
}

// ---------------------------------------------------------------- reading 2
const elf = path.join(ARTIFACTS, 'sesame-firmware-main.ino.elf');
const bin = path.join(ARTIFACTS, 'sesame-firmware-main.ino.bin');
const haveArtifacts = fs.existsSync(elf) && fs.existsSync(bin);
const elfBuf = haveArtifacts ? fs.readFileSync(elf) : null;
const binBuf = haveArtifacts ? fs.readFileSync(bin) : null;

/** The C escape sequences these literals actually use. Nothing else is allowed. */
function unescapeC(s) {
  return s.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === '\\') return '\\';
    if (c === '"') return '"';
    throw new Error(`unsupported C escape \\${c} in a telemetry literal`);
  });
}

const literals = fromPatch.map((entry) => {
  const bytes = Buffer.from(unescapeC(entry.literal), 'latin1');
  // Guarded by `#if SESAME_TELEMETRY_OLED`, which defaults to 0, so the OLED
  // literal is EXPECTED to be absent from the binary. Its absence is the proof
  // that the gate works, not a failure.
  const gated = /oled/.test(entry.literal);
  const elfOffset = elfBuf ? elfBuf.indexOf(bytes) : -1;
  const binOffset = binBuf ? binBuf.indexOf(bytes) : -1;
  return {
    literal: entry.literal,
    verb: entry.literal.split(' ')[1] ?? null,
    sourceLine: entry.sourceLine,
    compileGated: gated,
    expectedInBinary: !gated,
    foundInElf: haveArtifacts ? elfOffset >= 0 : null,
    foundInBin: haveArtifacts ? binOffset >= 0 : null,
    elfOffset: elfOffset >= 0 ? `0x${elfOffset.toString(16)}` : null,
    binOffset: binOffset >= 0 ? `0x${binOffset.toString(16)}` : null,
  };
});

// ---------------------------------------------------------------- routing --
/**
 * Which serial object does each telemetry `printf` call actually take as its
 * `this` pointer?
 *
 * This is the check that would have caught R4's finding. String presence proves
 * nothing about routing: the defect version of this patch contained all three
 * literals, in the right sections, and emitted every one of them out a USB CDC
 * endpoint.
 *
 * Xtensa `call8` passes arg0 in a10 and arg1 in a11, so a telemetry emission is
 * a `call8 <Print::printf>` whose a11 holds one of our format strings and whose
 * a10 holds the port. Reading the two `l32r`s nearest the call is NOT enough —
 * the compiler keeps a live port pointer in a callee-saved register and forwards
 * it, which in this build really does happen:
 *
 *   40084f8b:  l32r  a7, (3ffca168 <Serial0>)
 *   ...        (0x25 bytes of other work)
 *   40084fb5:  mov.n a10, a7
 *   40084fba:  call8 <Print::printf>
 *
 * The register resolution lives in scripts/lib/xtensa-call-args.mjs, pure and
 * dependency-free, so it can be unit-tested against captured disassembly from
 * BOTH the defective and the fixed build — the only way to know the check can
 * actually fail.
 */
function analyseRouting() {
  const target = /esp32s3/.test(manifestFqbn)
    ? 'esp32s3'
    : /esp32s2|lolin_s2_mini/.test(manifestFqbn)
      ? 'esp32s2'
      : 'esp32';
  const binDir = path.join(REPO, 'tools/arduino-data/data/packages/esp32/tools/esp-x32/2601/bin');
  const tool = (name) => path.join(binDir, `xtensa-${target}-elf-${name}.exe`);
  if (!fs.existsSync(tool('objdump'))) return { available: false, reason: `no toolchain at ${binDir}` };

  const run = (name, args) =>
    execFileSync(tool(name), args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

  const serialSymbols = new Map();
  for (const line of run('nm', [elf]).split(/\r?\n/)) {
    const m = /^([0-9a-f]+)\s+\S+\s+(Serial0|Serial1|USBSerial|HWCDCSerial)$/.exec(line.trim());
    if (m) serialSymbols.set(parseInt(m[1], 16), m[2]);
  }

  // File offset -> virtual address, via the section headers.
  const sections = [];
  for (const line of run('readelf', ['-S', '-W', elf]).split(/\r?\n/)) {
    const m = /^\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)/.exec(line);
    if (m) sections.push({ name: m[1], addr: parseInt(m[2], 16), offset: parseInt(m[3], 16), size: parseInt(m[4], 16) });
  }
  const toVma = (fileOffset) => {
    const sec = sections.find((x) => x.addr !== 0 && fileOffset >= x.offset && fileOffset < x.offset + x.size);
    return sec ? sec.addr + (fileOffset - sec.offset) : null;
  };

  const formatVmas = new Map();
  for (const entry of literals) {
    if (!entry.expectedInBinary || entry.elfOffset === null) continue;
    const vma = toVma(parseInt(entry.elfOffset, 16));
    if (vma !== null) formatVmas.set(vma, entry.literal);
  }

  const lines = run('objdump', ['-d', '-C', elf]).split(/\r?\n/);
  const sites = findTelemetryPrintfSites(lines, formatVmas, serialSymbols);

  return {
    available: true,
    target,
    method: 'backward dataflow on the a10/a11 argument registers at each Print::printf call8',
    serialSymbols: Object.fromEntries([...serialSymbols].map(([a, n]) => [n, `0x${a.toString(16)}`])),
    expectedPort: 'Serial0',
    sites,
  };
}

const manifestPath = path.join(ARTIFACTS, 'build-manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const manifestFqbn = manifest?.fqbn ?? '';
const routing = haveArtifacts ? analyseRouting() : { available: false, reason: 'no built artifact' };

let failed = false;
if (haveArtifacts) {
  // Every telemetry emission must go to Serial0. Anything else means the bytes
  // leave through a USB CDC endpoint that nothing on the host is reading.
  if (routing.available) {
    if (routing.sites.length === 0) {
      console.error('[literals] found no telemetry call sites in the disassembly - the check is not working');
      failed = true;
    }
    for (const site of routing.sites) {
      if (site.port !== 'Serial0') {
        console.error(
          `[literals] WRONG TRANSPORT at ${site.callSite}: ${JSON.stringify(site.literal)} ` +
            `emits to ${site.port ?? '(unidentified)'}, not Serial0/UART0`,
        );
        failed = true;
      }
    }
  }

  for (const l of literals) {
    if (l.expectedInBinary && !(l.foundInElf && l.foundInBin)) {
      console.error(`[literals] MISSING from the built artifact: ${JSON.stringify(l.literal)}`);
      failed = true;
    }
    if (!l.expectedInBinary && (l.foundInElf || l.foundInBin)) {
      console.error(`[literals] compile-gated literal LEAKED into the binary: ${JSON.stringify(l.literal)}`);
      failed = true;
    }
  }
  // Control: the stock build must contain no telemetry at all, or the delta
  // being attributed to instrumentation is not really the instrumentation.
  const stock = path.join(REPO, 'firmware', 'artifacts', 's2mini', 'sesame-firmware-main.ino.elf');
  if (fs.existsSync(stock) && fs.readFileSync(stock).indexOf(Buffer.from('@SESAME')) >= 0) {
    console.error('[literals] the STOCK s2mini ELF contains @SESAME - the profiles are not distinct');
    failed = true;
  }
}
if (failed) process.exit(1);

const doc = {
  $comment:
    'R6 evidence. Generated by scripts/extract-telemetry-literals.mjs. The literals are read out of ' +
    'firmware/patches/telemetry-instrumentation.patch and cross-checked against the compiled artifact; ' +
    'this file is checked in so the binary-level evidence outlives the gitignored artifacts.',
  generatedBy: 'scripts/extract-telemetry-literals.mjs',
  protocol: 'docs/protocol/sesame-telemetry-v1.md',
  patch: { file: 'firmware/patches/telemetry-instrumentation.patch', sha256: sha256(PATCH) },
  // The routing decision, read out of the machine code. See analyseRouting().
  routing,
  artifact: haveArtifacts
    ? {
        profile: 's2mini-instrumented',
        elf: { file: path.relative(REPO, elf).replace(/\\/g, '/'), sha256: sha256(elf) },
        bin: { file: path.relative(REPO, bin).replace(/\\/g, '/'), sha256: sha256(bin) },
      }
    : null,
  literals,
};

const text = JSON.stringify(doc, null, 2) + '\n';
if (CHECK) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // Only the literal set is compared in --check mode: artifact hashes are only
  // present when a build has been run, so demanding them would fail on a clean
  // clone for a reason that has nothing to do with the format contract.
  const strip = (t) => JSON.stringify(JSON.parse(t || '{}').literals ?? null);
  // Routing is artifact-derived, so it is compared only when a build exists.
  if (strip(existing) !== strip(text)) {
    console.error(`[literals] ${path.relative(REPO, OUT)} is STALE - re-run scripts/extract-telemetry-literals.mjs`);
    process.exit(1);
  }
  console.log(`[literals] ${path.relative(REPO, OUT)} up to date (${literals.length} literals)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(
    `[literals] ${path.relative(REPO, OUT)}  ${literals.length} literals, ` +
      (haveArtifacts ? 'cross-checked against the built ELF + bin' : 'NO ARTIFACT - patch reading only'),
  );
  if (routing.available) {
    console.log(`[routing]  ${routing.sites.length} telemetry call site(s), all -> Serial0 (UART0)`);
    for (const site of routing.sites) {
      console.log(`           ${site.callSite}  ${JSON.stringify(site.literal).padEnd(26)} this=${site.port}`);
    }
  }
  for (const l of literals) {
    console.log(
      `           ${JSON.stringify(l.literal).padEnd(26)} ` +
        (l.expectedInBinary
          ? `elf=${l.elfOffset ?? '-'} bin=${l.binOffset ?? '-'}`
          : 'compile-gated (expected absent)'),
    );
  }
}
