/**
 * The pixel encoding is the part of this protocol most likely to be
 * misimplemented, because "128x64 monochrome bitmap" has at least four plausible
 * byte layouts and three of them are wrong here. These tests pin the one the
 * SSD1306 actually uses, in the terms a C++ or Python implementer will need.
 */
import { describe, expect, it } from 'vitest';

import {
  OLED_BASE64_LENGTH,
  OLED_FRAME_BYTES,
  OLED_HEIGHT,
  OLED_PAGES,
  OLED_WIDTH,
  OledFrameError,
  base64Decode,
  base64Encode,
  blankOledFrame,
  decodeOledFrame,
  encodeOledFrame,
  isValidOledPayload,
  oledBitIndex,
  oledByteIndex,
  oledPixel,
  setOledPixel,
} from '../oled.js';
import { parseTelemetryLine, serialize } from '../wire.js';
import { sampleFrame } from './fixtures.js';

describe('SSD1306 page-ordered pixel layout', () => {
  it('has the geometry the panel has', () => {
    expect(OLED_WIDTH).toBe(128);
    expect(OLED_HEIGHT).toBe(64);
    expect(OLED_PAGES).toBe(8);
    expect(OLED_FRAME_BYTES).toBe(1024);
  });

  it('indexes exactly as Adafruit_SSD1306::drawPixel does', () => {
    // buffer[x + (y / 8) * WIDTH] |= (1 << (y & 7));
    for (let y = 0; y < OLED_HEIGHT; y++) {
      for (let x = 0; x < OLED_WIDTH; x += 17) {
        expect(oledByteIndex(x, y)).toBe(x + Math.floor(y / 8) * OLED_WIDTH);
        expect(oledBitIndex(y)).toBe(y % 8);
      }
    }
  });

  it('puts the LSB at the top of each page', () => {
    const buffer = blankOledFrame();
    setOledPixel(buffer, 0, 0, true);
    expect(buffer[0]).toBe(0b0000_0001);
    setOledPixel(buffer, 0, 7, true);
    expect(buffer[0]).toBe(0b1000_0001);
    setOledPixel(buffer, 0, 0, false);
    expect(buffer[0]).toBe(0b1000_0000);
  });

  it('places page 1 immediately after page 0, column-wise', () => {
    const buffer = blankOledFrame();
    setOledPixel(buffer, 3, 9, true);
    expect(oledByteIndex(3, 9)).toBe(131);
    expect(buffer[131]).toBe(0b0000_0010);
    expect(oledPixel(buffer, 3, 9)).toBe(1);
    expect(oledPixel(buffer, 3, 8)).toBe(0);
    expect(oledPixel(buffer, 4, 9)).toBe(0);
  });

  it('sets exactly one bit per pixel, for all 8192 pixels, with no collisions', () => {
    const seen = new Set<string>();
    let failures = 0;
    for (let y = 0; y < OLED_HEIGHT; y++) {
      for (let x = 0; x < OLED_WIDTH; x++) {
        const buffer = blankOledFrame();
        setOledPixel(buffer, x, y, true);
        let bits = 0;
        let at = -1;
        for (let i = 0; i < OLED_FRAME_BYTES; i++) {
          const byte = buffer[i] as number;
          if (byte !== 0) {
            bits += popcount(byte);
            at = i * 8 + Math.log2(byte);
          }
        }
        if (bits !== 1 || oledPixel(buffer, x, y) !== 1) failures++;
        seen.add(String(at));
      }
    }
    expect(failures).toBe(0);
    // 8192 distinct pixels must occupy 8192 distinct bits of the 1024-byte frame.
    expect(seen.size).toBe(OLED_WIDTH * OLED_HEIGHT);
  });

  it('round-trips a frame through base64 for a sample of pixel positions', () => {
    for (let y = 0; y < OLED_HEIGHT; y += 3) {
      for (let x = 0; x < OLED_WIDTH; x += 11) {
        const buffer = blankOledFrame();
        setOledPixel(buffer, x, y, true);
        expect(decodeOledFrame(encodeOledFrame(buffer))).toEqual(buffer);
      }
    }
  });

  it('rejects off-panel coordinates and wrong-size buffers', () => {
    const buffer = blankOledFrame();
    expect(() => oledPixel(buffer, 128, 0)).toThrow(OledFrameError);
    expect(() => oledPixel(buffer, 0, 64)).toThrow(OledFrameError);
    expect(() => oledPixel(buffer, -1, 0)).toThrow(OledFrameError);
    expect(() => oledPixel(new Uint8Array(10), 0, 0)).toThrow(OledFrameError);
    expect(() => encodeOledFrame(new Uint8Array(1023))).toThrow(OledFrameError);
    expect(() => decodeOledFrame('QUJD')).toThrow(OledFrameError);
  });
});

describe('base64 payload', () => {
  it('is 1368 characters for a full frame', () => {
    expect(encodeOledFrame(blankOledFrame())).toHaveLength(OLED_BASE64_LENGTH);
    expect(encodeOledFrame(sampleFrame(2))).toHaveLength(OLED_BASE64_LENGTH);
  });

  it('agrees with Node Buffer base64 on random data', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length * 11) & 0xff;
      const expected = Buffer.from(bytes).toString('base64');
      expect(base64Encode(bytes)).toBe(expected);
      expect(base64Decode(expected)).toEqual(bytes);
    }
  });

  it('rejects characters outside the alphabet instead of quietly skipping them', () => {
    expect(() => base64Decode('AA*A')).toThrow(OledFrameError);
    expect(() => base64Decode('A A A')).toThrow(OledFrameError);
    expect(isValidOledPayload('AA*A')).toBe(false);
  });

  it('survives a frame with every byte value present', () => {
    const buffer = new Uint8Array(OLED_FRAME_BYTES);
    for (let i = 0; i < OLED_FRAME_BYTES; i++) buffer[i] = i & 0xff;
    expect(decodeOledFrame(encodeOledFrame(buffer))).toEqual(buffer);
  });
});

describe('oled.frame on the wire', () => {
  it('round-trips a full frame through serialize and parse', () => {
    const buffer = sampleFrame(5);
    const line = serialize({
      type: 'oled.frame',
      seq: 9,
      provenance: 'observed',
      width: 128,
      height: 64,
      pixels: encodeOledFrame(buffer),
    });
    expect(line.startsWith('@SESAME oled b64 ')).toBe(true);
    expect(line).toHaveLength('@SESAME oled b64 '.length + OLED_BASE64_LENGTH);

    const parsed = parseTelemetryLine(line)[0];
    expect(parsed).toMatchObject({ type: 'oled.frame', width: 128, height: 64 });
    expect(decodeOledFrame((parsed as { pixels: string }).pixels)).toEqual(buffer);
  });
});

function popcount(byte: number): number {
  let n = 0;
  let v = byte;
  while (v !== 0) {
    n += v & 1;
    v >>= 1;
  }
  return n;
}
