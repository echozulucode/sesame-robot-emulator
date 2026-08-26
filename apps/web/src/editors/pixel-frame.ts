/**
 * A 128×64 monochrome frame — the pixel editor's model, shared with Lab.
 *
 * The buffer is stored **the way the firmware stores a face bitmap**: one bit
 * per pixel, row-major, MSB first, 16 bytes per row — which is what
 * `drawBitmap()` consumes and what `renderAuthoredBitmap()` in
 * `src/oled/framebuffer.ts` converts into the SSD1306's page-ordered GDDRAM.
 * Storing a boolean array and converting at the end would have been easier and
 * would have quietly taught that a face bitmap is a grid of booleans; it is
 * not, and the page/row distinction is half of what makes the OLED interesting.
 */
import { OLED_HEIGHT, OLED_WIDTH } from '@sesame-lab/sesame-protocol';

export const FRAME_WIDTH = OLED_WIDTH;
export const FRAME_HEIGHT = OLED_HEIGHT;
export const FRAME_BYTES_PER_ROW = FRAME_WIDTH / 8;
export const FRAME_BYTES = FRAME_BYTES_PER_ROW * FRAME_HEIGHT;

export const blankFrame = (): Uint8Array => new Uint8Array(FRAME_BYTES);

export function getPixel(frame: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= FRAME_WIDTH || y >= FRAME_HEIGHT) return false;
  const byte = frame[y * FRAME_BYTES_PER_ROW + (x >> 3)] ?? 0;
  return (byte & (0x80 >> (x & 7))) !== 0;
}

/** Returns a NEW buffer; the editor keeps frames immutable so undo is trivial. */
export function setPixel(frame: Uint8Array, x: number, y: number, on: boolean): Uint8Array {
  if (x < 0 || y < 0 || x >= FRAME_WIDTH || y >= FRAME_HEIGHT) return frame;
  const next = new Uint8Array(frame);
  const index = y * FRAME_BYTES_PER_ROW + (x >> 3);
  const mask = 0x80 >> (x & 7);
  const current = next[index] ?? 0;
  next[index] = on ? current | mask : current & ~mask;
  return next;
}

export function countLitPixels(frame: Uint8Array): number {
  let n = 0;
  for (const byte of frame) {
    let b = byte;
    while (b !== 0) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

/**
 * The densest `w × h` window in the frame.
 *
 * `pixel-edit` asks for "a 5×5 shape anywhere", which is a statement about
 * locality, not about a total. Scanning every window is 128×64×25 ≈ 200k
 * operations on a click, which is nothing, and it means the check can say "you
 * drew 9 pixels but they are scattered" rather than passing a diagonal line.
 */
export function densestWindow(
  frame: Uint8Array,
  w: number,
  h: number,
): { readonly width: number; readonly height: number; readonly count: number; readonly x: number; readonly y: number } {
  let best = { width: w, height: h, count: 0, x: 0, y: 0 };
  for (let y = 0; y + h <= FRAME_HEIGHT; y += 1) {
    for (let x = 0; x + w <= FRAME_WIDTH; x += 1) {
      let count = 0;
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          if (getPixel(frame, x + dx, y + dy)) count += 1;
        }
      }
      if (count > best.count) best = { width: w, height: h, count, x, y };
    }
  }
  return best;
}

/** How many pixels differ between two frames. */
export function changedPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < FRAME_BYTES; i += 1) {
    let diff = (a[i] ?? 0) ^ (b[i] ?? 0);
    while (diff !== 0) {
      n += diff & 1;
      diff >>= 1;
    }
  }
  return n;
}
