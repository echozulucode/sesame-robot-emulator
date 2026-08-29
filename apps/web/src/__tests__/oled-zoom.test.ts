/**
 * The integer-pixel zoom policy — Phase 4 W5.
 *
 * Unit tests here and a measurement in the browser harness, and the pair is the
 * point: this file proves the LADDER is a ladder, and the harness proves the
 * rendered box is the rung the attribute claims. W7 shipped
 * `data-oled-zoom={compact ? '2' : '4'}` — an attribute that stated the answer
 * — on a canvas whose `max-width: 100%` clamped it to 1.77x in the panel it was
 * written for. An assertion against that attribute could not have failed.
 */
import { describe, expect, it } from 'vitest';

import {
  EDITOR_MIN_ZOOM,
  MIN_OLED_ZOOM,
  OLED_ZOOM_LADDER,
  integerOledZoom,
  isIntegerOledZoom,
} from '../oled/zoom.js';

describe('the zoom ladder', () => {
  it('is strictly descending, so the first fitting rung is the largest', () => {
    for (let i = 1; i < OLED_ZOOM_LADDER.length; i += 1) {
      expect(OLED_ZOOM_LADDER[i]).toBeLessThan(OLED_ZOOM_LADDER[i - 1] as number);
    }
  });

  it('is whole numbers only — that is the entire policy', () => {
    for (const zoom of OLED_ZOOM_LADDER) expect(Number.isInteger(zoom)).toBe(true);
  });

  it('carries the brief’s three editor rungs', () => {
    for (const rung of [8, 6, 4]) expect(OLED_ZOOM_LADDER).toContain(rung);
  });
});

describe('integerOledZoom', () => {
  it('takes the largest rung that FITS, never the one that nearly does', () => {
    expect(integerOledZoom(1024)).toBe(8);
    expect(integerOledZoom(1023)).toBe(6);
    expect(integerOledZoom(768)).toBe(6);
    expect(integerOledZoom(767)).toBe(4);
    expect(integerOledZoom(512)).toBe(4);
    expect(integerOledZoom(511)).toBe(2);
    expect(integerOledZoom(256)).toBe(2);
    expect(integerOledZoom(255)).toBe(1);
  });

  it('never returns a size larger than the box it was given', () => {
    for (let width = 100; width <= 1200; width += 1) {
      const zoom = integerOledZoom(width);
      if (zoom > MIN_OLED_ZOOM) expect(128 * zoom).toBeLessThanOrEqual(width);
    }
  });

  it('honours a height budget when the caller has a real one', () => {
    // 1024 px of width would be 8x, but 8x is 512 px tall.
    expect(integerOledZoom(1024, { heightPx: 300 })).toBe(4);
    expect(integerOledZoom(1024, { heightPx: 512 })).toBe(8);
  });

  it('holds the editor floor and lets the surface pan instead', () => {
    // The measured Lab column at 1440x900, before its padding was given back.
    expect(integerOledZoom(506, { minZoom: EDITOR_MIN_ZOOM })).toBe(EDITOR_MIN_ZOOM);
    // ...and without the floor it would have halved, which is the regression
    // the floor exists to stop.
    expect(integerOledZoom(506)).toBe(2);
  });

  it('never returns a rung that is not on the ladder', () => {
    for (let width = 0; width <= 2000; width += 7) {
      expect(OLED_ZOOM_LADDER).toContain(integerOledZoom(width));
    }
  });

  it('reads the panel card and the editor column as measured in the browser', () => {
    expect(integerOledZoom(271)).toBe(2); // the 280 px side panel's Face card
    expect(integerOledZoom(868, { minZoom: EDITOR_MIN_ZOOM })).toBe(6); // the "more info" screen
    expect(integerOledZoom(530, { minZoom: EDITOR_MIN_ZOOM })).toBe(4); // Lab at 1440x900
    expect(integerOledZoom(776, { minZoom: EDITOR_MIN_ZOOM })).toBe(6); // Lab at 1920x1080
    expect(integerOledZoom(1090, { minZoom: EDITOR_MIN_ZOOM })).toBe(8); // Lab at 2560x1440
  });
});

describe('isIntegerOledZoom', () => {
  it('accepts a rendered box that is exactly a rung', () => {
    expect(isIntegerOledZoom(256)).toBe(true);
    expect(isIntegerOledZoom(768)).toBe(true);
  });

  it('rejects the fractional zooms this policy was written to remove', () => {
    expect(isIntegerOledZoom(227)).toBe(false); // W7's card: 1.77x
    expect(isIntegerOledZoom(377)).toBe(false); // W2's measurement: 2.94x
    expect(isIntegerOledZoom(397)).toBe(false); // the flex-shrunk editor: 3.10x
    expect(isIntegerOledZoom(498)).toBe(false); // and at 1440: 3.89x
  });

  it('rejects an integer ratio that is not on the ladder', () => {
    expect(isIntegerOledZoom(128 * 3)).toBe(false);
    expect(isIntegerOledZoom(128 * 5)).toBe(false);
  });
});
