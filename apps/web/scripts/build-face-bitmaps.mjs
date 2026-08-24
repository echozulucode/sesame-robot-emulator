#!/usr/bin/env node
/**
 * Project `firmware/face-bitmaps.h` into a typed TypeScript module.
 *
 * ## Why this exists at all
 *
 * `hardware/hardware-map.json` deliberately does *not* carry pixel data — F4
 * recorded `bitmapDataNote: "Pixel data intentionally not extracted"`, which is
 * the right call for a machine-readable *description* of the firmware. But V4
 * has to put actual lit pixels on a virtual panel, and inventing them would be
 * a placeholder face, which the plan forbids. So the pixels come from the one
 * place they exist: the firmware's own `epd_bitmap_*` arrays.
 *
 * ## What it does NOT do
 *
 * It does not convert anything. The arrays are stored exactly as the firmware
 * declares them — **horizontal scan, row-major, MSB first**, 16 bytes per row,
 * 1024 bytes per 128x64 frame — because that is what `Adafruit_GFX::drawBitmap`
 * is handed. Turning that into the SSD1306's page-ordered GDDRAM layout is the
 * *app's* job (`src/oled/framebuffer.ts`), done by emulating `drawBitmap` +
 * `SSD1306::drawPixel`, so that the transformation the real panel performs is
 * visible in the code rather than baked into an asset.
 *
 * ## Frame counting
 *
 * `countFrames()` (ino:893) walks `{ epd_bitmap_x, epd_bitmap_x_1, ...
 * epd_bitmap_x_5 }` and stops at the first null pointer. The frame arrays are
 * built by `MAKE_FACE_FRAMES` (ino:129) from weak `extern` declarations, so an
 * *undefined* symbol is a null pointer at link time. This generator reproduces
 * that exactly: it stops at the first slot with no definition in the header.
 *
 * That is what makes `stand` and `defualt` come out with **zero** frames
 * (ISSUE-20260823-004), and what makes `epd_bitmap_thinking_2` unreachable —
 * `thinking_1` is not defined, so the walk stops before it. Both facts are
 * emitted into the module rather than left to a comment.
 *
 * `firmware/upstream/` is gitignored, so the generated module is committed and
 * this script is a *check*, not a build step. Run:
 *
 *   node apps/web/scripts/build-face-bitmaps.mjs           # regenerate
 *   node apps/web/scripts/build-face-bitmaps.mjs --check    # fail on drift
 *
 * With no upstream checkout present, `--check` reports SKIPPED and exits 0 —
 * a missing source is not evidence of drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const SOURCE = path.join(REPO, 'firmware/upstream/firmware/face-bitmaps.h');
const OUT = path.join(HERE, '../src/generated/face-bitmaps.ts');
const REL_SOURCE = 'firmware/face-bitmaps.h';

const check = process.argv.includes('--check');

if (!fs.existsSync(SOURCE)) {
  const msg = `no upstream checkout at ${path.relative(REPO, SOURCE).replaceAll('\\', '/')}`;
  if (check) {
    console.log(`SKIP  face-bitmaps drift check — ${msg} (run scripts/fetch-upstream.ps1 to enable it)`);
    process.exit(0);
  }
  console.error(`FAIL  ${msg}. Run scripts/fetch-upstream.ps1 first.`);
  process.exit(1);
}

const bytes = fs.readFileSync(SOURCE);
// Normalise line endings before parsing. The upstream checkout lands with CRLF
// on Windows and LF elsewhere; the *bitmaps* must not depend on which, or this
// generator produces a different file on each platform. The recorded sha256 is
// of the bytes on disk, deliberately — it identifies the checkout, not the
// parse.
const text = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
// Hash the LF-normalised text, not the bytes on disk: a CRLF checkout and an
// LF checkout of the same upstream commit must produce the same generated file
// and the same recorded hash, or `--check` fails on whichever platform did not
// generate it.
const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
void bytes;

// ---------------------------------------------------------------- FACE_LIST
// The X-macro at the top of the header is the single source of truth for which
// faces are registered, and in what order. Read it rather than restating it.
const listMatch = /#define FACE_LIST([\s\S]*?)\n\n/.exec(text);
if (!listMatch) fail('could not find the FACE_LIST X-macro');
const FACE_LIST = [...listMatch[1].matchAll(/X\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1]);
if (FACE_LIST.length === 0) fail('FACE_LIST parsed empty');

// ------------------------------------------------------------- bitmap arrays
// `#define const extern const` above the pasted image2cpp output means every
// definition reads `const unsigned char epd_bitmap_<name> [] PROGMEM = {...};`.
const BYTES_PER_FRAME = 1024; // 128 px / 8 * 64 rows
const defs = new Map();
const defRe = /const\s+unsigned\s+char\s+(epd_bitmap_[A-Za-z0-9_]+)\s*\[\]\s*PROGMEM\s*=\s*\{([^}]*)\}/g;
for (const m of text.matchAll(defRe)) {
  const name = m[1];
  const data = [...m[2].matchAll(/0x([0-9a-fA-F]{1,2})/g)].map((h) => parseInt(h[1], 16));
  if (data.length !== BYTES_PER_FRAME) {
    fail(`${name} has ${data.length} bytes, expected ${BYTES_PER_FRAME}`);
  }
  if (defs.has(name)) fail(`${name} defined twice`);
  defs.set(name, Buffer.from(data));
}
if (defs.size === 0) fail('no epd_bitmap_* definitions found');

// ------------------------------------------------------------- frame walking
const MAX_FACE_FRAMES = 6; // ino:108
const frames = {};
for (const face of FACE_LIST) {
  const slots = [`epd_bitmap_${face}`];
  for (let i = 1; i < MAX_FACE_FRAMES; i++) slots.push(`epd_bitmap_${face}_${i}`);
  const out = [];
  for (const slot of slots) {
    const buf = defs.get(slot);
    if (buf === undefined) break; // weak symbol undefined => null pointer => countFrames stops
    out.push(buf.toString('base64'));
  }
  frames[face] = out;
}
// `faceEntries[]` appends one extra row past FACE_LIST: { "default",
// face_defualt_frames } (ino:144). Same (empty) frame array, different name.
frames['default'] = frames['defualt'] ?? [];

// Definitions that exist in the header but that `countFrames()` can never
// reach, because an earlier slot in their own face's frame array is missing.
const reachable = new Set();
for (const face of FACE_LIST) {
  frames[face].forEach((_, i) => reachable.add(i === 0 ? `epd_bitmap_${face}` : `epd_bitmap_${face}_${i}`));
}
const unreachable = [...defs.keys()].filter((n) => !reachable.has(n)).sort();

// ----------------------------------------------------------------- emit
const lines = [];
const emit = (s = '') => lines.push(s);

emit('/**');
emit(' * GENERATED FILE — do not edit.');
emit(' *');
emit(` * Source:    ${REL_SOURCE}`);
emit(` * sha256:    ${sha256}   (of the LF-normalised text)`);
emit(' * Generator: apps/web/scripts/build-face-bitmaps.mjs');
emit(' * Check:     pnpm --filter @sesame-lab/web validate:face-bitmaps');
emit(' *');
emit(' * Every value is a base64 of one 1024-byte face frame in the firmware\'s own');
emit(' * **horizontal-scan, row-major, MSB-first** layout — the bytes handed to');
emit(' * `Adafruit_GFX::drawBitmap`, NOT the SSD1306 page-ordered GDDRAM layout the');
emit(' * telemetry protocol carries. `src/oled/framebuffer.ts` performs that');
emit(' * conversion the same way the panel driver does.');
emit(' *');
emit(' * Frame arrays stop at the first undefined weak symbol, exactly as');
emit(' * `countFrames()` stops at the first null pointer (ino:893). Faces with an');
emit(' * empty array therefore draw NOTHING on the real robot.');
emit(' */');
emit('');
emit('/** Where the pixels came from, so a rendered face can cite its own source. */');
emit('export const FACE_BITMAP_SOURCE = {');
emit(`  file: ${JSON.stringify(REL_SOURCE)},`);
emit(`  sha256: ${JSON.stringify(sha256)},`);
emit(`  bytesPerFrame: ${BYTES_PER_FRAME},`);
emit(`  widthPx: 128,`);
emit(`  heightPx: 64,`);
emit(`  layout: 'horizontal scan, row-major, MSB first, 16 bytes per row',`);
emit(`  definitionsFound: ${defs.size},`);
emit('} as const;');
emit('');
emit('/**');
emit(' * Face name -> its frames, base64, in `countFrames()` order.');
emit(' *');
emit(' * An empty array is not missing data: it is the upstream bug. `stand` and');
emit(' * `defualt` (and therefore `default`) are declared in FACE_LIST but never');
emit(' * defined, so their frame arrays are all-null and nothing is ever drawn.');
emit(' * ISSUE-20260823-004.');
emit(' */');
emit('export const FACE_BITMAP_FRAMES: Readonly<Record<string, readonly string[]>> = {');
for (const face of Object.keys(frames)) {
  const fs_ = frames[face];
  if (fs_.length === 0) {
    emit(`  ${JSON.stringify(face)}: [],`);
  } else {
    emit(`  ${JSON.stringify(face)}: [`);
    for (const f of fs_) emit(`    '${f}',`);
    emit('  ],');
  }
}
emit('};');
emit('');
emit('/**');
emit(' * Bitmaps that are defined in the header but that the firmware can never');
emit(' * display, because an earlier slot in the same face\'s frame array is');
emit(' * undefined and `countFrames()` stops there.');
emit(' */');
emit(`export const UNREACHABLE_BITMAPS: readonly string[] = ${JSON.stringify(unreachable)};`);
emit('');
emit('/** Faces registered in FACE_LIST that have no bitmap at all. */');
emit(
  `export const EMPTY_FACES: readonly string[] = ${JSON.stringify(
    Object.keys(frames).filter((f) => frames[f].length === 0),
  )};`,
);
emit('');

const body = lines.join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

const total = Object.values(frames).reduce((n, f) => n + f.length, 0);
const summary =
  `${FACE_LIST.length} registered faces (+1 alias), ${total} frames, ` +
  `${defs.size} definitions, ${unreachable.length} unreachable, ` +
  `${Object.values(frames).filter((f) => f.length === 0).length} empty`;

if (check) {
  if (existing === body) {
    console.log(`OK    face-bitmaps.ts matches ${REL_SOURCE} — ${summary}`);
    process.exit(0);
  }
  console.error(`FAIL  apps/web/src/generated/face-bitmaps.ts is stale relative to ${REL_SOURCE}.`);
  console.error('      Regenerate: node apps/web/scripts/build-face-bitmaps.mjs');
  process.exit(1);
}

fs.writeFileSync(OUT, body);
console.log(`WROTE ${path.relative(REPO, OUT).replaceAll('\\', '/')} — ${summary}`);

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}
