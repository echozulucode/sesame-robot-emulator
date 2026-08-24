/**
 * V4's encoding path, checked against the protocol document rather than
 * against itself.
 *
 * The interesting assertions are the ones that would fail if someone
 * "simplified" the pipeline by drawing the authored bitmap straight to a
 * canvas: the page-ordered byte index, the LSB-first bit order, and the exact
 * 1368-character payload.
 */
import {
  decodeOledFrame,
  FACE_CATALOG,
  OLED_BASE64_LENGTH,
  OLED_FRAME_BYTES,
  OLED_HEIGHT,
  OLED_WIDTH,
  oledPixel,
} from '@sesame-lab/sesame-protocol';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_FACES,
  FACE_BITMAP_FRAMES,
  UNREACHABLE_BITMAPS,
} from '../generated/face-bitmaps.js';
import {
  countLit,
  faceFrameCount,
  renderAuthoredBitmap,
  renderFace,
  VirtualOledPanel,
} from '../oled/framebuffer.js';

/** An authored (row-major, MSB-first) bitmap with exactly one pixel set. */
function authoredWithPixel(x: number, y: number): Uint8Array {
  const authored = new Uint8Array(OLED_FRAME_BYTES);
  authored[y * 16 + (x >> 3)] = 0x80 >> (x & 7);
  return authored;
}

describe('drawBitmap -> GDDRAM', () => {
  it('lands the protocol document’s worked example on byte 131, bit 1', () => {
    // docs/protocol/sesame-telemetry-v1.md §6: pixel (x=3, y=9) is page 1,
    // byte index 3 + 1*128 = 131, bit 1 -> buffer[131] & 0x02.
    const gddram = renderAuthoredBitmap(authoredWithPixel(3, 9));
    expect(gddram[131]).toBe(0x02);
    expect(countLit(gddram)).toBe(1);
    expect(oledPixel(gddram, 3, 9)).toBe(1);
  });

  it('puts bit 0 at the TOP row of a page, not the bottom', () => {
    // The easiest way to get this backwards is to treat the byte as MSB-first
    // like the authored bitmap is. Row 0 must be the LSB.
    expect(renderAuthoredBitmap(authoredWithPixel(0, 0))[0]).toBe(0x01);
    expect(renderAuthoredBitmap(authoredWithPixel(0, 7))[0]).toBe(0x80);
  });

  it('reads the authored bitmap MSB-first within each byte', () => {
    // Column 0 of a row is bit 7 of the authored byte; column 7 is bit 0.
    expect(renderAuthoredBitmap(authoredWithPixel(0, 0))[0]).toBe(0x01);
    expect(renderAuthoredBitmap(authoredWithPixel(7, 0))[7]).toBe(0x01);
    expect(renderAuthoredBitmap(authoredWithPixel(8, 0))[8]).toBe(0x01);
  });

  it('round-trips every corner through the page-ordered layout', () => {
    for (const [x, y] of [
      [0, 0],
      [OLED_WIDTH - 1, 0],
      [0, OLED_HEIGHT - 1],
      [OLED_WIDTH - 1, OLED_HEIGHT - 1],
      [64, 31],
    ] as const) {
      const gddram = renderAuthoredBitmap(authoredWithPixel(x, y));
      expect(countLit(gddram)).toBe(1);
      expect(oledPixel(gddram, x, y)).toBe(1);
    }
  });

  it('rejects a bitmap that is not 1024 bytes', () => {
    expect(() => renderAuthoredBitmap(new Uint8Array(1023))).toThrow(/1024/);
  });
});

describe('the generated face bitmaps agree with the firmware catalog', () => {
  it('has the same frame count as FACE_CATALOG for every registered face', () => {
    // FACE_CATALOG is a checked mirror of hardware/hardware-map.json, which F4
    // extracted from firmware source with file:line provenance. The bitmaps
    // here were parsed independently out of face-bitmaps.h. If the two agree on
    // all 38 faces, both readings of countFrames() are the same reading.
    for (const entry of FACE_CATALOG) {
      expect(faceFrameCount(entry.name), `frame count for ${entry.name}`).toBe(entry.frameCount);
    }
  });

  it('reproduces the empty-face bug rather than papering over it', () => {
    // ISSUE-20260823-004: epd_bitmap_stand and epd_bitmap_defualt are declared
    // weak and never defined.
    expect([...EMPTY_FACES].sort()).toEqual(['default', 'defualt', 'stand']);
    for (const name of EMPTY_FACES) {
      expect(renderFace(name)).toBeNull();
      expect(faceFrameCount(name)).toBe(0);
    }
  });

  it('leaves epd_bitmap_thinking_2 unreachable, as the firmware does', () => {
    // `thinking_1` is not defined, so countFrames() stops at 1 and the _2
    // bitmap can never be displayed. Recording it is more useful than quietly
    // renumbering the frames.
    expect(UNREACHABLE_BITMAPS).toEqual(['epd_bitmap_thinking_2']);
    expect(faceFrameCount('thinking')).toBe(1);
  });

  it('every stored frame is exactly one 1024-byte page of pixels', () => {
    for (const [name, frames] of Object.entries(FACE_BITMAP_FRAMES)) {
      frames.forEach((_, index) => {
        const rendered = renderFace(name, index);
        expect(rendered, `${name}[${index}]`).not.toBeNull();
        expect(rendered?.gddram.length).toBe(OLED_FRAME_BYTES);
        expect(rendered?.base64.length).toBe(OLED_BASE64_LENGTH);
      });
    }
  });

  it('renders a real face with real pixels, and it round-trips the wire codec', () => {
    const wave = renderFace('wave');
    expect(wave).not.toBeNull();
    if (wave === null) return;
    expect(wave.litPixels).toBeGreaterThan(200);
    expect(wave.litPixels).toBeLessThan(OLED_WIDTH * OLED_HEIGHT);
    expect([...decodeOledFrame(wave.base64)]).toEqual([...wave.gddram]);
  });

  it('resolves face names case-insensitively, the way setFace() does', () => {
    // ino:917 — faceName.equalsIgnoreCase(faceEntries[i].name).
    const lower = renderFace('happy');
    const upper = renderFace('HAPPY');
    expect(upper).not.toBeNull();
    expect([...(upper?.gddram ?? [])]).toEqual([...(lower?.gddram ?? [])]);
  });

  it('draws nothing for a name the registry does not know', () => {
    // setFace() falls through to the empty face_defualt_frames table.
    expect(renderFace('not-a-face')).toBeNull();
  });
});

describe('VirtualOledPanel', () => {
  it('starts blank and stays blank until something writes', () => {
    const panel = new VirtualOledPanel();
    expect(panel.litPixels).toBe(0);
    expect(panel.writes).toBe(0);
    expect(panel.base64.length).toBe(OLED_BASE64_LENGTH);
  });

  it('retains the previous frame when nothing is drawn, exactly as the glass does', () => {
    const panel = new VirtualOledPanel();
    const happy = renderFace('happy');
    expect(happy).not.toBeNull();
    if (happy === null) return;

    panel.write(happy.gddram);
    const after = panel.base64;
    expect(panel.writes).toBe(1);

    // setFace("stand") never reaches updateFaceBitmap(), so display.display()
    // is never called and GDDRAM is untouched. Blanking here would be inventing
    // a behaviour the hardware does not have.
    expect(renderFace('stand')).toBeNull();
    expect(panel.base64).toBe(after);
    expect(panel.writes).toBe(1);
  });

  it('accepts a wire payload through the protocol decoder', () => {
    const panel = new VirtualOledPanel();
    const sad = renderFace('sad');
    expect(sad).not.toBeNull();
    if (sad === null) return;
    panel.writeBase64(sad.base64);
    expect([...panel.gddram]).toEqual([...sad.gddram]);
  });

  it('refuses a payload that is not 1024 bytes', () => {
    const panel = new VirtualOledPanel();
    expect(() => panel.writeBase64('AAAA')).toThrow();
  });

  it('reset() returns it to power-on', () => {
    const panel = new VirtualOledPanel();
    const face = renderFace('angry');
    if (face !== null) panel.write(face.gddram);
    panel.reset();
    expect(panel.litPixels).toBe(0);
    expect(panel.writes).toBe(0);
  });
});
