/**
 * Where the pixels on the virtual OLED came from — Phase 4 W8.
 *
 * This module exists because the answer must be **derived from what the backend
 * declares**, and never from which backend it is. The firmware has an OLED
 * framebuffer hook behind `SESAME_TELEMETRY_OLED`, and a QEMU image built with
 * it enabled emits `oled.frame` events carrying the real 1024-byte page-ordered
 * buffer. The capability document is what changes underneath this app:
 *
 * ```text
 *   the `cli` image                       the `cli-oled` image (now the default)
 *   oledFramebuffer: false                oledFramebuffer: true
 *   elided: [... 'ssd1306-panel' ...]     elided: [... 'ssd1306-glass' ...]
 *          |                                     |
 *          v                                     v
 *   host-rendered, `inferred`             the guest's own framebuffer
 *   "these pixels did not come            "these pixels are the buffer the
 *    from the emulator"                    firmware handed to the driver"
 * ```
 *
 * **Nothing in this app had to change for that to happen**, and that is the
 * claim rather than a hope: both branches below were written and tested against
 * a *fabricated* capability record before an image existed that produced one.
 * `oled-provenance.test.ts` flips the two fields and asserts the pane changes
 * what it claims; the harness then reads the same derivation off a running
 * emulator and compares it against what that emulator declares, so neither the
 * app nor the check names an image.
 *
 * ## `ssd1306-panel` out, `ssd1306-glass` in — and the wording follows
 *
 * The emulator still attaches no SSD1306 to the I2C bus. What became observable
 * is the framebuffer, one layer *above* the missing device: the hook reads
 * `getBuffer()` inside `updateFaceBitmap()`, **before** `display.display()`
 * pushes it at a chip that is not there. So the honest sentence for the
 * observed case is *"this is what the firmware handed to the driver"*, never
 * *"this is what reached the glass"* — and `isPhysicallyObserved()` stays false
 * for every one of these events, because an emulated buffer is not a
 * measurement.
 *
 * {@link oledPanelIsElided} therefore tests two things and requires BOTH to be
 * clear: the `oledFramebuffer` capability, and `ssd1306-panel` in `elided`. The
 * asymmetry is deliberate — the failure being guarded against is host-drawn
 * pixels presented as the emulator's, so the conservative direction is the safe
 * one, and a renamed image that reports neither field gets the cautious answer.
 */
import type { EmulatorFacts } from '../backends/types.js';
import type { OledSource } from '../state/telemetry-store.js';

/**
 * The subsystem name that means *"no framebuffer is observable here"*.
 *
 * Not `ssd1306-glass`, which is a different and still-true statement: the panel
 * DEVICE is absent on both images, so `ssd1306-glass` is elided even when the
 * framebuffer is observed. Keying on it would make the pane say the pixels are
 * host-drawn forever.
 */
export const OLED_ELIDED_SUBSYSTEM = 'ssd1306-panel';

/** The device that is absent on every QEMU image this project has. */
export const OLED_ELIDED_DEVICE = 'ssd1306-glass';

/**
 * Does this backend say it has no panel to read pixels from?
 *
 * `null` facts — the simulator and the bridge — are **not** elided: there is no
 * emulator making a claim about a panel it does not model, and saying "these
 * pixels did not come from the emulator" about a backend that is not an
 * emulator would be a sentence about nothing.
 */
export function oledPanelIsElided(facts: EmulatorFacts | null): boolean {
  if (facts === null) return false;
  return !facts.oledFramebuffer || facts.elided.includes(OLED_ELIDED_SUBSYSTEM);
}

export type PixelOriginState =
  /** GDDRAM is zeroed; nothing has drawn. */
  | 'power-on'
  /** An `oled.frame` event carried the bytes. This is the glass. */
  | 'observed'
  /** Drawn host-side because the backend models no panel. */
  | 'elided'
  /** Drawn host-side by a backend that never claimed to have a panel. */
  | 'host-rendered';

export interface PixelOrigin {
  readonly state: PixelOriginState;
  /**
   * ONE line, and the sentence the info icon shows on hover and on focus.
   *
   * Short on purpose: this is a tip, not the explanation. The paragraphs are
   * {@link PixelOrigin.paragraphs} and they live behind a click.
   */
  readonly claim: string;
  /** The explanation. Rendered in the screen the icon opens, never on the panel. */
  readonly paragraphs: readonly string[];
  /** True only when the bytes on the glass crossed a boundary to get here. */
  readonly fromEmulator: boolean;
}

/**
 * What to say about the pixels currently on the panel.
 *
 * Pure, and a function of the two things that decide it: what the backend
 * DECLARES (`facts`) and what actually wrote the buffer (`source.kind`). Both
 * are needed — a backend can report `oledFramebuffer: true` and still have had
 * nothing but a face name arrive, and claiming a framebuffer that never landed
 * would be the same lie in the other direction.
 */
export function pixelOrigin(facts: EmulatorFacts | null, source: OledSource): PixelOrigin {
  const elided = oledPanelIsElided(facts);

  if (source.kind === 'wire') {
    const glassElided = facts !== null && facts.elided.includes(OLED_ELIDED_DEVICE);
    return {
      state: 'observed',
      claim: 'These pixels came from the emulator — the buffer the firmware drew.',
      paragraphs: [
        'An oled.frame event carried 1024 bytes of page-ordered framebuffer, and this is what ' +
          'they decode to. Nothing was drawn on the host: the image is a read-out of the guest’s ' +
          'own buffer rather than a reconstruction from a face name.',
        glassElided
          ? 'One qualifier, and it is the reason the emulator still lists ssd1306-glass among the ' +
            'subsystems it does not model: the hook reads getBuffer() inside updateFaceBitmap(), ' +
            'BEFORE display.display() pushes it over I2C at a chip that is not attached. So this ' +
            'is what the firmware handed to the driver, which is not the same claim as what ' +
            'reached any glass. No pixel has been confirmed to reach a panel, real or emulated.'
          : 'These bytes crossed a boundary to get here, which is what oled.frame means.',
        'It is still not a measurement. An emulated framebuffer is an emulated framebuffer: ' +
          'isPhysicallyObserved() is false for every event on this transport, and the status line ' +
          'goes on reading PHYSICAL HARDWARE: NONE.',
        source.detail,
      ],
      fromEmulator: facts !== null,
    };
  }

  if (source.kind === 'power-on') {
    return {
      state: 'power-on',
      claim: 'Nothing has drawn yet — GDDRAM is still zeroed.',
      paragraphs: [source.detail],
      fromEmulator: false,
    };
  }

  if (elided) {
    return {
      state: 'elided',
      claim: 'These pixels did not come from the emulator.',
      paragraphs: [
        'The backend’s origin lists ' +
          OLED_ELIDED_SUBSYSTEM +
          ' among the subsystems it does not model, and its oledFramebuffer capability is false: ' +
          'QEMU attaches no SSD1306 to this machine, so display.display() inside the guest writes ' +
          'to nothing observable. What the firmware does emit is the face NAME, and that really ' +
          'did cross the UART.',
        'So the image is drawn here, on the host, from firmware/face-bitmaps.h — the same arrays ' +
          'the firmware would have used. It is shown because the 3D robot needs a screen, and it ' +
          'is labelled inferred because nothing transmitted it. It is not a capture of the ' +
          'emulator’s framebuffer, and there is no framebuffer to capture.',
        source.detail,
      ],
      fromEmulator: false,
    };
  }

  return {
    state: 'host-rendered',
    claim: 'Drawn on the host from the firmware’s own bitmaps.',
    paragraphs: [
      'This backend transmitted a face NAME rather than pixels, so the image above was rendered ' +
        'here by emulating Adafruit_GFX::drawBitmap over firmware/face-bitmaps.h. It is labelled ' +
        'inferred because nothing transmitted it.',
      source.detail,
    ],
    fromEmulator: false,
  };
}
