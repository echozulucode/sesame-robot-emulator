/**
 * The OLED framebuffer encoding for `oled.frame` events.
 *
 * ## Why this layout and not a nicer one
 *
 * The Sesame panel is an SSD1306 128x64 at I2C `0x3C`, driven by
 * `Adafruit_SSD1306`. That library's internal buffer — the one you get from
 * `display.getBuffer()`, and the one whose bytes are shifted out to GDDRAM
 * verbatim by `display.display()` — is **page-ordered**, not row-ordered:
 *
 * ```c
 * // Adafruit_SSD1306::drawPixel
 * buffer[x + (y / 8) * WIDTH] |= (1 << (y & 7));
 * ```
 *
 * So we adopt that byte-for-byte. The firmware emitter (R6) is then a base64 of
 * `display.getBuffer()` with **zero transformation** — no transpose, no bit
 * reversal, no 1 KB scratch buffer on a device that does not have one to spare.
 * Any other choice would buy prettiness with ESP32 RAM and CPU in a hot path.
 *
 * Note this is *not* the layout of the face bitmaps in `firmware/face-bitmaps.h`:
 * those are horizontal-scan arrays fed to `Adafruit_GFX::drawBitmap`, which
 * converts them into this layout on the way in. `oled.frame` is what reaches the
 * glass, not what was authored.
 *
 * ## The exact encoding
 *
 * - Buffer length is exactly **1024 bytes** = 128 columns x 8 pages.
 * - `index = x + page * 128`, where `page = y >> 3`, `x` in `[0,128)`, `y` in `[0,64)`.
 * - Within a byte, **bit `y & 7` counting from the LSB** is the pixel.
 *   Bit 0 (LSB) is the *top* row of that page; bit 7 (MSB) is the bottom row.
 * - `1` means the pixel is lit (white on the panel), `0` means dark.
 * - Byte order on the wire is buffer order: page 0 columns 0..127, then page 1, etc.
 * - The wire payload is that 1024-byte buffer in **standard base64** (RFC 4648
 *   alphabet `A-Za-z0-9+/`, `=` padding), producing exactly 1368 characters.
 *
 * A worked example: pixel `(x=3, y=9)` lives in page 1, byte index `3 + 1*128 = 131`,
 * bit 1. `buffer[131] & 0b00000010`.
 */

/** Panel width in pixels. Fixed by the hardware. */
export const OLED_WIDTH = 128 as const;

/** Panel height in pixels. Fixed by the hardware. */
export const OLED_HEIGHT = 64 as const;

/** SSD1306 pages: 8 rows of pixels per page, so 64 / 8 = 8. */
export const OLED_PAGES = 8 as const;

/** Bytes in one full frame: 128 columns x 8 pages. */
export const OLED_FRAME_BYTES = 1024 as const;

/** Length of the base64 payload for one frame. */
export const OLED_BASE64_LENGTH = 1368 as const;

/** The only pixel encoding v1 defines. Present on the wire so v2 can add another. */
export const OLED_ENCODINGS = ['b64'] as const;

/** Pixel-encoding token as it appears on the wire. */
export type OledEncoding = (typeof OLED_ENCODINGS)[number];

/** Thrown by {@link decodeOledFrame} and {@link base64Decode} on malformed input. */
export class OledFrameError extends Error {
  override readonly name = 'OledFrameError';
}

/**
 * Byte index in the frame buffer for a pixel coordinate.
 * Does not range-check; see {@link oledPixel}.
 */
export function oledByteIndex(x: number, y: number): number {
  return x + (y >> 3) * OLED_WIDTH;
}

/** Bit position (0 = LSB = topmost row of the page) for a pixel coordinate. */
export function oledBitIndex(y: number): number {
  return y & 7;
}

/**
 * Read one pixel. Returns `0` or `1`.
 *
 * @throws {OledFrameError} if the buffer is the wrong size or the coordinate is
 *   off-panel. Off-panel reads are a bug in the caller, not bad wire data, so
 *   throwing here is correct — nothing in the parse path calls this.
 */
export function oledPixel(buffer: Uint8Array, x: number, y: number): 0 | 1 {
  assertFrameSize(buffer);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) {
    throw new OledFrameError(`pixel (${x}, ${y}) is outside the ${OLED_WIDTH}x${OLED_HEIGHT} panel`);
  }
  const byte = buffer[oledByteIndex(x, y)] ?? 0;
  return ((byte >> oledBitIndex(y)) & 1) as 0 | 1;
}

/** Write one pixel in place. Mirrors {@link oledPixel}. */
export function setOledPixel(buffer: Uint8Array, x: number, y: number, on: boolean): void {
  assertFrameSize(buffer);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) {
    throw new OledFrameError(`pixel (${x}, ${y}) is outside the ${OLED_WIDTH}x${OLED_HEIGHT} panel`);
  }
  const index = oledByteIndex(x, y);
  const mask = 1 << oledBitIndex(y);
  const current = buffer[index] ?? 0;
  buffer[index] = on ? current | mask : current & ~mask;
}

/** An all-dark frame. */
export function blankOledFrame(): Uint8Array {
  return new Uint8Array(OLED_FRAME_BYTES);
}

/**
 * Encode a 1024-byte page-ordered buffer as the wire payload.
 * @throws {OledFrameError} if the buffer is not exactly 1024 bytes.
 */
export function encodeOledFrame(buffer: Uint8Array): string {
  assertFrameSize(buffer);
  return base64Encode(buffer);
}

/**
 * Decode a wire payload back to a 1024-byte page-ordered buffer.
 * @throws {OledFrameError} on invalid base64 or a wrong decoded length.
 */
export function decodeOledFrame(payload: string): Uint8Array {
  const bytes = base64Decode(payload);
  assertFrameSize(bytes);
  return bytes;
}

/** True if `payload` decodes to exactly one frame. Never throws. */
export function isValidOledPayload(payload: string): boolean {
  try {
    decodeOledFrame(payload);
    return true;
  } catch {
    return false;
  }
}

function assertFrameSize(buffer: Uint8Array): void {
  if (buffer.length !== OLED_FRAME_BYTES) {
    throw new OledFrameError(
      `OLED frame must be exactly ${OLED_FRAME_BYTES} bytes, got ${buffer.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// base64
//
// Hand-rolled rather than `Buffer` or `atob`, because this package must run
// unchanged in a browser (the debug viewer and the Phase-1 frontend import it)
// and in Node (the bridge), and because `atob` is lax about invalid input in a
// way that would let a corrupt frame through silently.
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_REVERSE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([...B64_ALPHABET].map((c, i) => [c, i])),
);

/** Standard RFC 4648 base64 with `=` padding. */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triple >> 18) & 63];
    out += B64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < n ? B64_ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < n ? B64_ALPHABET[triple & 63] : '=';
  }
  return out;
}

/**
 * Strict RFC 4648 base64 decode. Padding is optional on input; any character
 * outside the alphabet, or a length that cannot be a base64 body, throws.
 *
 * @throws {OledFrameError}
 */
export function base64Decode(text: string): Uint8Array {
  let body = text;
  while (body.endsWith('=')) body = body.slice(0, -1);
  if (body.length % 4 === 1) {
    throw new OledFrameError(`invalid base64: length ${text.length} cannot be a base64 body`);
  }
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    const value = B64_REVERSE[ch];
    if (value === undefined) {
      throw new OledFrameError(`invalid base64 character ${JSON.stringify(ch)} at offset ${i}`);
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (accumulator >> bits) & 0xff;
    }
  }
  return out;
}
