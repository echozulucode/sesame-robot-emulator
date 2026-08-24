/**
 * The virtual SSD1306 panel's memory, and the one path pixels may take to
 * reach it.
 *
 * ## The chain, and why every link is here rather than short-circuited
 *
 * ```text
 * face-bitmaps.h            row-major, MSB-first, 16 B/row   (what the author drew)
 *   |  drawBitmap(0, 0, bmp, 128, 64, WHITE)                 Adafruit_GFX
 *   v
 * GDDRAM buffer             page-ordered, 1024 B             (what reaches the glass)
 *   |  base64                                                @SESAME oled b64 …
 *   v
 * oled.frame event          1368 chars, provenance-tagged
 *   |  decodeOledFrame / oledPixel                           @sesame-lab/sesame-protocol
 *   v
 * <canvas>  +  CanvasTexture on the oled_screen quad
 * ```
 *
 * It would be a third of the code to draw the authored bitmap straight onto a
 * canvas. That would also be a lie: the authored layout is not the layout the
 * panel holds, `oled.frame` carries the panel's layout, and a learner comparing
 * the virtual OLED to a real `@SESAME oled` line has to be looking at the same
 * bytes. So the simulated path is pushed through the *same* encoding the wire
 * uses — the transformation `Adafruit_GFX` performs is written out, and the
 * result round-trips through the protocol package's own codec.
 *
 * Nothing here invents pixels. A face with no bitmap draws nothing, exactly as
 * `setFace()` draws nothing when `currentFaceFrameCount == 0`.
 */
import {
  base64Decode,
  base64Encode,
  decodeOledFrame,
  OLED_FRAME_BYTES,
  OLED_HEIGHT,
  OLED_WIDTH,
  oledPixel,
  setOledPixel,
} from '@sesame-lab/sesame-protocol';

import { FACE_BITMAP_FRAMES, FACE_BITMAP_SOURCE } from '../generated/face-bitmaps.js';

/** Bytes in one row of an authored bitmap: `(128 + 7) / 8`. */
const AUTHORED_BYTES_PER_ROW = 16;

/**
 * Decode one base64 face frame into the firmware's authored byte array.
 *
 * Uses the protocol package's strict decoder rather than `atob`, which accepts
 * input it should not: a corrupted generated module must fail loudly here, not
 * produce a subtly wrong face.
 */
function decodeAuthored(b64: string): Uint8Array {
  return base64Decode(b64);
}

/**
 * `Adafruit_GFX::drawBitmap(0, 0, bitmap, 128, 64, SSD1306_WHITE)` followed by
 * the `Adafruit_SSD1306::drawPixel` write, for a full-screen bitmap.
 *
 * ```c
 * // Adafruit_GFX::drawBitmap — MSB first, one byte per 8 columns, row-padded
 * for (int16_t j = 0; j < h; j++, byte = 0)
 *   for (int16_t i = 0; i < w; i++) {
 *     if (i & 7) byte <<= 1; else byte = bitmap[j * byteWidth + i / 8];
 *     if (byte & 0x80) drawPixel(x + i, y + j, color);
 *   }
 * ```
 *
 * Note the 6-argument overload draws **only the set bits** — unset pixels are
 * left alone. `updateFaceBitmap()` calls `display.clearDisplay()` immediately
 * before (ino:888), so the result is the bitmap and nothing else; that clear is
 * reproduced by starting from a zeroed buffer.
 */
export function renderAuthoredBitmap(authored: Uint8Array): Uint8Array {
  if (authored.length !== OLED_FRAME_BYTES) {
    throw new Error(`authored bitmap is ${authored.length} bytes, expected ${OLED_FRAME_BYTES}`);
  }
  const gddram = new Uint8Array(OLED_FRAME_BYTES); // display.clearDisplay()
  for (let y = 0; y < OLED_HEIGHT; y++) {
    for (let x = 0; x < OLED_WIDTH; x++) {
      const byte = authored[y * AUTHORED_BYTES_PER_ROW + (x >> 3)] ?? 0;
      // MSB first within the byte: column 0 is bit 7.
      if ((byte & (0x80 >> (x & 7))) !== 0) setOledPixel(gddram, x, y, true);
    }
  }
  return gddram;
}

/** One frame of one face, as far as the wire. */
export interface RenderedFace {
  /** Firmware spelling of the face actually drawn. */
  readonly name: string;
  /** 0-based frame index within that face. */
  readonly frame: number;
  /** The page-ordered GDDRAM buffer — what `display.getBuffer()` would return. */
  readonly gddram: Uint8Array;
  /** The same 1024 bytes as the protocol's `oled.frame` payload, 1368 chars. */
  readonly base64: string;
  /** Lit pixels. Zero for a face that draws nothing. */
  readonly litPixels: number;
}

/** How many frames `countFrames()` would report for a name, matching case-insensitively. */
export function faceFrameCount(name: string): number {
  return lookupFrames(name)?.length ?? 0;
}

function lookupFrames(name: string): readonly string[] | undefined {
  const direct = FACE_BITMAP_FRAMES[name];
  if (direct !== undefined) return direct;
  // `setFace()` matches faceEntries[] with equalsIgnoreCase (ino:917).
  const lower = name.toLowerCase();
  for (const key of Object.keys(FACE_BITMAP_FRAMES)) {
    if (key.toLowerCase() === lower) return FACE_BITMAP_FRAMES[key];
  }
  return undefined;
}

/**
 * Render `name`'s frame `frame`, or `null` if the firmware would draw nothing.
 *
 * `null` is the honest answer in three distinct situations and the caller is
 * expected to say which:
 *
 * - the face is registered but has no bitmap (`stand`, `defualt`, `default` —
 *   ISSUE-20260823-004);
 * - the name is not in the registry at all, so `setFace()` falls through to the
 *   empty `face_defualt_frames`;
 * - the frame index is past `countFrames()`.
 *
 * In every one of them `updateFaceBitmap()` is never reached, so the panel is
 * left holding whatever it was already showing. See {@link VirtualOledPanel}.
 */
export function renderFace(name: string, frame = 0): RenderedFace | null {
  const frames = lookupFrames(name);
  if (frames === undefined || frames.length === 0) return null;
  const b64 = frames[frame];
  if (b64 === undefined) return null;

  const gddram = renderAuthoredBitmap(decodeAuthored(b64));
  return {
    name,
    frame,
    gddram,
    base64: base64Encode(gddram),
    litPixels: countLit(gddram),
  };
}

/** Lit-pixel population count over a GDDRAM buffer. */
export function countLit(gddram: Uint8Array): number {
  let n = 0;
  for (const byte of gddram) {
    let b = byte;
    while (b !== 0) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

/**
 * The panel itself: 1024 bytes of GDDRAM that only ever change when something
 * calls `display.display()`.
 *
 * Modelling *retention* rather than clearing on every event is the point. When
 * `setFace("stand")` finds zero frames it never reaches `updateFaceBitmap()`,
 * so the glass keeps showing the previous image. A virtual panel that blanked
 * instead would be inventing a behaviour the hardware does not have — and one
 * that happens to make the upstream bug *less* visible, not more, because a
 * blank screen looks like a deliberate clear.
 *
 * At power-on the buffer is zeroed, which is why the bug reads as a genuinely
 * blank screen if `stand` is the first face ever selected.
 */
export class VirtualOledPanel {
  #gddram = new Uint8Array(OLED_FRAME_BYTES);
  #base64 = base64Encode(new Uint8Array(OLED_FRAME_BYTES));
  #writes = 0;

  /** GDDRAM as the panel currently holds it. Do not mutate. */
  get gddram(): Uint8Array {
    return this.#gddram;
  }

  /** The current contents as an `oled.frame` payload. */
  get base64(): string {
    return this.#base64;
  }

  /** How many times `display.display()` would have run. */
  get writes(): number {
    return this.#writes;
  }

  get litPixels(): number {
    return countLit(this.#gddram);
  }

  /** `updateFaceBitmap()` — clear, draw, display. */
  write(gddram: Uint8Array): void {
    if (gddram.length !== OLED_FRAME_BYTES) {
      throw new Error(`frame is ${gddram.length} bytes, expected ${OLED_FRAME_BYTES}`);
    }
    this.#gddram = gddram.slice();
    this.#base64 = base64Encode(this.#gddram);
    this.#writes += 1;
  }

  /**
   * Accept an `oled.frame` payload straight off the wire.
   *
   * This is the path a backend that emits real frames takes — instrumented
   * firmware under QEMU, say. It goes through the protocol package's decoder,
   * which enforces the 1024-byte length, so a malformed payload is an error
   * here rather than a corrupted picture.
   */
  writeBase64(payload: string): void {
    this.write(decodeOledFrame(payload));
  }

  /** Power-on state: GDDRAM zeroed. */
  reset(): void {
    this.#gddram = new Uint8Array(OLED_FRAME_BYTES);
    this.#base64 = base64Encode(this.#gddram);
    this.#writes = 0;
  }

  /** `1` if lit. The protocol's own accessor, so the index arithmetic is not restated. */
  pixel(x: number, y: number): 0 | 1 {
    return oledPixel(this.#gddram, x, y);
  }
}

/** Provenance for the pixel data, so the UI never has to guess. */
export const FACE_PIXEL_SOURCE = FACE_BITMAP_SOURCE;

export { OLED_HEIGHT, OLED_WIDTH };
