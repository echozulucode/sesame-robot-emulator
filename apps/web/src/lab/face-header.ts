/**
 * Export a drawn face as a `firmware/face-bitmaps.h`-compatible array.
 *
 * ## Two byte layouts, and they are not the same layout
 *
 * This is the detail the export exists to make visible, because getting it
 * wrong produces a face that is scrambled into eight horizontal bands and looks
 * like a bug in the display:
 *
 * - **`face-bitmaps.h` is row-major, MSB first.** `epd_bitmap_*` arrays are
 *   consumed by `Adafruit_GFX::drawBitmap()`, which walks `y` then `x` and
 *   reads bit `0x80 >> (x & 7)` out of byte `y * 16 + (x >> 3)`. That is
 *   exactly what `src/editors/pixel-frame.ts` stores, so this emitter writes
 *   the editor's buffer out byte for byte with no transform at all.
 * - **The SSD1306's GDDRAM is page-ordered.** `docs/protocol/sesame-telemetry-v1.md`
 *   §"The buffer is page-ordered, not row-ordered" pins it: 1024 bytes,
 *   `index = x + page * 128` where `page = y >> 3`, bit `y & 7` counted **from
 *   the LSB**. That is what an `oled.frame` event carries and what the virtual
 *   panel holds.
 *
 * `renderAuthoredBitmap()` in `src/oled/framebuffer.ts` is the conversion
 * between them, and it is the same conversion `drawBitmap()` performs on the
 * real robot. So the Lab pushes a drawn frame to the panel through that path
 * and exports the *un*converted bytes here — which is the right way round, and
 * is why {@link FACE_HEADER_LAYOUT_NOTE} is shown next to the code rather than
 * left in a comment.
 */
import {
  FRAME_BYTES,
  FRAME_BYTES_PER_ROW,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  blankFrame,
} from '../editors/pixel-frame.js';

export const FACE_HEADER_LAYOUT_NOTE =
  'face-bitmaps.h holds row-major bytes, MSB first — 16 bytes per row, 64 rows. The SSD1306 ' +
  'itself holds page-ordered GDDRAM (index = x + page*128, bit = y & 7 from the LSB). ' +
  'drawBitmap() is the conversion, and the panel above is showing the converted form.';

/** `face-bitmaps.h` matches face names case-insensitively; keep the identifier legal. */
export function faceIdentifier(raw: string): string {
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (/[a-z0-9_]/.test(ch)) out += ch;
    else if (out.length > 0 && !out.endsWith('_')) out += '_';
  }
  out = out.replace(/_+$/, '');
  if (out.length === 0 || /^[0-9]/.test(out)) out = `labface${out}`;
  return out;
}

export interface FaceHeaderOptions {
  /** Frame suffix. `null` for the base bitmap; `1`, `2`, … for animation frames. */
  readonly frameIndex?: number | null;
  readonly header?: boolean;
}

/**
 * Emit one `const unsigned char epd_bitmap_<name>[] PROGMEM = { … };`.
 *
 * Sixteen bytes per line, tab-indented, exactly as `image2cpp` writes them and
 * as every array already in the real header is written — so a diff against the
 * upstream file shows the pixels changing and nothing else.
 */
export function emitFaceHeader(frame: Uint8Array, name: string, options: FaceHeaderOptions = {}): string {
  if (frame.length !== FRAME_BYTES) {
    throw new Error(`frame is ${String(frame.length)} bytes, expected ${String(FRAME_BYTES)}`);
  }
  const { frameIndex = null, header = true } = options;
  const id = faceIdentifier(name);
  const symbol = frameIndex === null ? `epd_bitmap_${id}` : `epd_bitmap_${id}_${String(frameIndex)}`;
  const lines: string[] = [];

  if (header) {
    lines.push(
      '// ---------------------------------------------------------------------',
      '// Drawn in Sesame Lab. Paste into firmware/face-bitmaps.h.',
      `// The face only becomes selectable once "X(${id}) \\" is added to the`,
      '// FACE_LIST macro at the top of that file — the X-macro is the single',
      '// source of truth for which faces exist, and an array nothing lists is',
      '// dead weight in flash.',
      '//',
      '// Row-major, MSB first, 16 bytes per row, 64 rows = 1024 bytes. This is',
      '// what drawBitmap() reads; it is NOT the page-ordered layout the SSD1306',
      '// stores. See docs/protocol/sesame-telemetry-v1.md.',
      '// ---------------------------------------------------------------------',
      `// '${id}', ${String(FRAME_WIDTH)}x${String(FRAME_HEIGHT)}px`,
    );
  } else {
    lines.push(`// '${id}', ${String(FRAME_WIDTH)}x${String(FRAME_HEIGHT)}px`);
  }

  lines.push(`const unsigned char ${symbol} [] PROGMEM = {`);
  const rows: string[] = [];
  for (let i = 0; i < FRAME_BYTES; i += FRAME_BYTES_PER_ROW) {
    const bytes: string[] = [];
    for (let k = 0; k < FRAME_BYTES_PER_ROW; k += 1) {
      bytes.push(`0x${(frame[i + k] ?? 0).toString(16).padStart(2, '0')}`);
    }
    rows.push(`\t${bytes.join(', ')}`);
  }
  lines.push(rows.join(', \n'));
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

export interface ParsedFaceHeader {
  readonly symbol: string | null;
  readonly frame: Uint8Array;
  readonly byteCount: number;
  readonly ok: boolean;
  readonly detail: string;
}

const SYMBOL_RE = /const\s+unsigned\s+char\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*\]/;
const BYTE_RE = /0x([0-9a-fA-F]{1,2})/g;

/**
 * Read a `face-bitmaps.h` array back into a frame.
 *
 * Used by the Lab's own round-trip readout and by the browser harness, for the
 * same reason `parseSesameCpp()` exists: an export nobody reads back is an
 * export nobody has checked. A short or long array is reported, not padded.
 */
export function parseFaceHeader(source: string): ParsedFaceHeader {
  const body = source.replace(/\/\/[^\n]*/g, '');
  const symbol = SYMBOL_RE.exec(source)?.[1] ?? null;
  const bytes: number[] = [];
  BYTE_RE.lastIndex = 0;
  for (let m = BYTE_RE.exec(body); m !== null; m = BYTE_RE.exec(body)) {
    bytes.push(Number.parseInt(m[1] ?? '0', 16));
  }
  const frame = blankFrame();
  const n = Math.min(bytes.length, FRAME_BYTES);
  for (let i = 0; i < n; i += 1) frame[i] = bytes[i] ?? 0;
  const ok = bytes.length === FRAME_BYTES;
  return {
    symbol,
    frame,
    byteCount: bytes.length,
    ok,
    detail: ok
      ? `${String(FRAME_BYTES)} bytes, ${String(FRAME_BYTES_PER_ROW)} per row — parsed back identical`
      : `expected ${String(FRAME_BYTES)} bytes, found ${String(bytes.length)}`,
  };
}

/** Byte-for-byte comparison of an emitted header against the frame it came from. */
export function faceHeaderRoundTrip(frame: Uint8Array, name: string): { readonly ok: boolean; readonly detail: string } {
  const parsed = parseFaceHeader(emitFaceHeader(frame, name));
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  for (let i = 0; i < FRAME_BYTES; i += 1) {
    if ((frame[i] ?? 0) !== (parsed.frame[i] ?? 0)) {
      return { ok: false, detail: `byte ${String(i)} differs: 0x${(frame[i] ?? 0).toString(16)} out, 0x${(parsed.frame[i] ?? 0).toString(16)} back` };
    }
  }
  return { ok: true, detail: parsed.detail };
}
