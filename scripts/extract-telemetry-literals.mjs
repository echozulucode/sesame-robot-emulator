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
 * This script cross-checks (1) against (2) and writes the result to
 * `firmware/build/telemetry-literals.json`, which IS checked in - so the
 * binary-level evidence outlives the gitignored artifacts it came from.
 *
 * Usage: node scripts/extract-telemetry-literals.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

let failed = false;
if (haveArtifacts) {
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
  for (const l of literals) {
    console.log(
      `           ${JSON.stringify(l.literal).padEnd(26)} ` +
        (l.expectedInBinary
          ? `elf=${l.elfOffset ?? '-'} bin=${l.binOffset ?? '-'}`
          : 'compile-gated (expected absent)'),
    );
  }
}
