/**
 * The OLED's pixel provenance is DERIVED — Phase 4 W8.
 *
 * The pane used to say *"these pixels did not come from the emulator"* because
 * `ssd1306-panel` was in QEMU's `elided` list and `oledFramebuffer` was false.
 * That sentence is now false on the default image and still true on the older
 * one, and the app has to say the right thing in both cases **without naming an
 * image anywhere**.
 *
 * These tests fabricate the capability record and flip the two fields. That is
 * deliberately not the same evidence as the browser harness reading a running
 * emulator: this proves the DERIVATION, at the boundary, in both directions and
 * in combinations no image produces; the harness proves the app is actually
 * wired to the emulator's own declaration. Both are needed, and this one was
 * written before an image with the hook existed.
 */
import { describe, expect, it } from 'vitest';

import type { EmulatorFacts } from '../backends/types.js';
import {
  OLED_ELIDED_DEVICE,
  OLED_ELIDED_SUBSYSTEM,
  oledPanelIsElided,
  pixelOrigin,
} from '../oled/pixel-provenance.js';
import type { OledSource } from '../state/telemetry-store.js';

/** A capability record shaped exactly like `packages/sesame-qemu` transports. */
function facts(overrides: Partial<EmulatorFacts>): EmulatorFacts {
  return {
    origin: { kind: 'emulator', engine: 'qemu-system-xtensa/9.2.2', board: 'distro-v1-esp32' },
    board: 'distro-v1-esp32',
    unsupportedBoards: {},
    commandChannel: 'uart0',
    elided: [],
    firmwareDeviations: [],
    knownFlakiness: '',
    oledFramebuffer: false,
    mode: null,
    everObserved: null,
    lastCommandLine: null,
    panic: null,
    ...overrides,
  };
}

/** The two ways pixels reach the panel. */
const RENDERED: OledSource = {
  kind: 'rendered',
  pixelProvenance: 'inferred',
  triggerProvenance: 'observed',
  triggerOrigin: { kind: 'emulator' },
  detail: 'Rendered host-side: epd_bitmap_happy from firmware/face-bitmaps.h.',
};
const WIRE: OledSource = {
  kind: 'wire',
  pixelProvenance: 'observed',
  triggerProvenance: 'observed',
  triggerOrigin: { kind: 'emulator' },
  detail: 'These 1024 bytes arrived as an oled.frame event. This is what reached the glass.',
};
const POWER_ON: OledSource = {
  kind: 'power-on',
  pixelProvenance: null,
  triggerProvenance: null,
  triggerOrigin: null,
  detail: 'GDDRAM is zeroed. Nothing has called display.display() yet.',
};

describe('the image WITHOUT the framebuffer hook', () => {
  /** What `packages/sesame-qemu` reports for the `cli` image. */
  const withoutHook = facts({
    oledFramebuffer: false,
    elided: ['wifi-mac', OLED_ELIDED_SUBSYSTEM, 'servo-load'],
  });

  it('is elided, and says the pixels did not come from the emulator', () => {
    expect(oledPanelIsElided(withoutHook)).toBe(true);
    const origin = pixelOrigin(withoutHook, RENDERED);
    expect(origin.state).toBe('elided');
    expect(origin.fromEmulator).toBe(false);
    expect(origin.claim).toMatch(/did not come from the emulator/i);
  });

  it('puts the whole explanation in the paragraphs and not in the claim', () => {
    const origin = pixelOrigin(withoutHook, RENDERED);
    // The claim is a TIP: one line, shown on hover and on focus.
    expect(origin.claim.length).toBeLessThan(80);
    expect(origin.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(origin.paragraphs.join(' ')).toMatch(/ssd1306-panel/);
    expect(origin.paragraphs.join(' ')).toMatch(/face-bitmaps\.h/);
    // ...and the store's own sentence is carried rather than paraphrased.
    expect(origin.paragraphs).toContain(RENDERED.detail);
  });

  it('stays elided even if only ONE of the two fields says so', () => {
    // Two independent statements of the same fact, and either is enough. The
    // conservative direction is the safe one: the failure being guarded against
    // is host-drawn pixels presented as the emulator's.
    expect(oledPanelIsElided(facts({ oledFramebuffer: false, elided: [] }))).toBe(true);
    expect(
      oledPanelIsElided(facts({ oledFramebuffer: true, elided: [OLED_ELIDED_SUBSYSTEM] })),
    ).toBe(true);
  });
});

describe('the image WITH the framebuffer hook — the default now', () => {
  /**
   * What `packages/sesame-qemu` reports for `cli-oled`: the capability is true,
   * `ssd1306-panel` is gone, and `ssd1306-glass` is there in its place because
   * the DEVICE is still absent.
   */
  const withHook = facts({
    oledFramebuffer: true,
    elided: ['wifi-mac', OLED_ELIDED_DEVICE, 'servo-load'],
  });

  it('is not elided', () => {
    expect(oledPanelIsElided(withHook)).toBe(false);
  });

  it('says the pixels came from the emulator once a frame has arrived', () => {
    const origin = pixelOrigin(withHook, WIRE);
    expect(origin.state).toBe('observed');
    expect(origin.fromEmulator).toBe(true);
    expect(origin.claim).toMatch(/came from the emulator/i);
    expect(origin.claim).not.toMatch(/did not come/i);
  });

  it('does not claim anything reached the glass, because the device is still absent', () => {
    // The hook reads getBuffer() BEFORE display.display() pushes it at a chip
    // that is not attached, which is exactly why `ssd1306-glass` is still
    // elided. The wording has to survive that distinction.
    const text = pixelOrigin(withHook, WIRE).paragraphs.join(' ');
    expect(text).toMatch(/getBuffer\(\)/);
    expect(text).toMatch(/before/i);
    expect(text).toMatch(/ssd1306-glass/);
    expect(text).toMatch(/isPhysicallyObserved\(\) is false/);
  });

  it('still says host-rendered while only a face NAME has arrived', () => {
    // The capability being true is not a licence to claim a framebuffer that
    // never landed. That would be the same lie in the other direction.
    const origin = pixelOrigin(withHook, RENDERED);
    expect(origin.state).toBe('host-rendered');
    expect(origin.fromEmulator).toBe(false);
    expect(origin.claim).toMatch(/host/i);
  });
});

describe('backends that are not emulators', () => {
  it('the simulator and the bridge are not "elided"', () => {
    // Saying "these pixels did not come from the emulator" about a backend that
    // is not an emulator is a sentence about nothing.
    expect(oledPanelIsElided(null)).toBe(false);
    const origin = pixelOrigin(null, RENDERED);
    expect(origin.state).toBe('host-rendered');
    expect(origin.claim).not.toMatch(/emulator/i);
  });

  it('a blank panel says so rather than claiming anything about pixels', () => {
    const origin = pixelOrigin(null, POWER_ON);
    expect(origin.state).toBe('power-on');
    expect(origin.fromEmulator).toBe(false);
    expect(origin.claim).toMatch(/zeroed/i);
  });
});

describe('every state is total and every claim is a tip-sized line', () => {
  it('holds for the whole cross product', () => {
    const capabilities = [
      null,
      facts({ oledFramebuffer: false, elided: [OLED_ELIDED_SUBSYSTEM] }),
      facts({ oledFramebuffer: true, elided: [OLED_ELIDED_DEVICE] }),
      facts({ oledFramebuffer: true, elided: [] }),
    ];
    for (const capability of capabilities) {
      for (const source of [RENDERED, WIRE, POWER_ON]) {
        const origin = pixelOrigin(capability, source);
        expect(['power-on', 'observed', 'elided', 'host-rendered']).toContain(origin.state);
        expect(origin.claim.length).toBeGreaterThan(0);
        expect(origin.claim.length).toBeLessThan(80);
        expect(origin.paragraphs.length).toBeGreaterThan(0);
        // `fromEmulator` may never be true unless a frame actually arrived.
        if (origin.fromEmulator) expect(source.kind).toBe('wire');
      }
    }
  });
});
