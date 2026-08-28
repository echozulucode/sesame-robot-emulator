/**
 * The claims this package makes about itself, held to.
 *
 * None of these need QEMU, and that is deliberate: the properties that stop a
 * learner mistaking an emulator for a robot must be checkable in a plain unit
 * run, on a machine with no emulator installed, in CI, every time. A capability
 * flag that quietly flips to `true` is exactly the failure this file exists to
 * catch, and it would otherwise be invisible until someone read a UI.
 */
import { describe, expect, it } from 'vitest';

import { ROBOT_MODES, isRobotMode } from '@sesame-lab/sesame-model';
import {
  UNKNOWN_ORIGIN,
  describeOrigin,
  encodeCommand,
  isPhysicallyObserved,
} from '@sesame-lab/sesame-protocol';

import {
  CLI_IMAGE_PATH,
  DEFAULT_IMAGE_PATH,
  ELIDED_SUBSYSTEMS,
  ELIDED_WITHOUT_OLED_HOOK,
  FIRMWARE_DEVIATIONS,
  OLED_FIRMWARE_DEVIATIONS,
  OLED_IMAGE_PATH,
  PERIPHERAL_FIDELITY,
  POWER_ON_ANGLE_DEG,
  QEMU_CAPABILITIES,
  QEMU_CAPABILITIES_FULL,
  QEMU_CAPABILITIES_WITHOUT_OLED,
  QEMU_ORIGIN,
  QEMU_ORIGIN_WITHOUT_OLED,
  capabilitiesForImage,
  elidedForImage,
  imageHasOledHook,
  originForImage,
} from '../config.js';
import { BOOT_BANNER, PANIC_PATTERNS, livePids } from '../session.js';

describe('capabilities are truthful', () => {
  it('claims firmware execution and nothing about hardware', () => {
    expect(QEMU_CAPABILITIES.firmwareExecution).toBe(true);
    expect(QEMU_CAPABILITIES.realHardware).toBe(false);
    expect(QEMU_CAPABILITIES.physics).toBe(false);
  });

  it('claims no Wi-Fi and no HTTP, because QEMU models no ESP32 radio', () => {
    // Not "not implemented". `esp_phy_enable` asserts on stock firmware at
    // bootOrder step 7, and this image has the whole bring-up commented out.
    expect(QEMU_CAPABILITIES.httpApi).toBe(false);
  });

  it('claims the serial console, which is what protocol v2 adds', () => {
    expect(QEMU_CAPABILITIES.serialConsole).toBe(true);
    expect(QEMU_CAPABILITIES_FULL.commandChannel).toBe('serial-cli/upstream-1.0');
  });

  it('claims the OLED FRAMEBUFFER on the default image, and never the panel', () => {
    // EXP6-QEMU: `distro-v1-esp32-cli-oled` carries -DSESAME_TELEMETRY_OLED=1,
    // so display.getBuffer() really does cross UART0 and the pixels a UI draws
    // are the guest's. What did NOT change is the device: QEMU still attaches
    // no SSD1306, so the claim must stay pinned to the framebuffer.
    expect(QEMU_CAPABILITIES.oledFramebuffer).toBe(true);
    expect(DEFAULT_IMAGE_PATH).toBe(OLED_IMAGE_PATH);
  });

  it('claims NO framebuffer when the image booted has no hook', () => {
    // The capability is a property of the IMAGE, not of the backend. Booting
    // the `cli` image must report the old, correct answer - otherwise the
    // record would be a slogan rather than a description.
    expect(QEMU_CAPABILITIES_WITHOUT_OLED.oledFramebuffer).toBe(false);
    expect(capabilitiesForImage(CLI_IMAGE_PATH).oledFramebuffer).toBe(false);
    expect(capabilitiesForImage(OLED_IMAGE_PATH).oledFramebuffer).toBe(true);
    expect(imageHasOledHook(CLI_IMAGE_PATH)).toBe(false);
    expect(imageHasOledHook(OLED_IMAGE_PATH)).toBe(true);
    // An image this package does not recognise gets the conservative answer.
    expect(imageHasOledHook('C:/somewhere/mystery.flash.bin')).toBe(false);
  });

  it('names the boards it cannot do, including the one the report recommends', () => {
    const unsupported = QEMU_CAPABILITIES_FULL.unsupportedBoards;
    expect(QEMU_CAPABILITIES_FULL.board).toBe('distro-v1-esp32');
    // The current Distro board.
    expect(unsupported['distro-v3-s3']).toMatch(/never reaches setup/);
    // The recommended DIY board. No esp32s2 machine exists at all.
    expect(unsupported['s2mini']).toMatch(/no esp32s2 machine/);
  });

  it('surfaces the firmware deviations rather than leaving them in prose', () => {
    expect(FIRMWARE_DEVIATIONS.join(' ')).toMatch(/FlashMode=dio/);
    expect(FIRMWARE_DEVIATIONS.join(' ')).toMatch(/Wi-Fi/);
    // The default image carries one more: the OLED hook is a compile-time
    // change to the firmware and has to be declared as one.
    expect(QEMU_CAPABILITIES_FULL.firmwareDeviations).toEqual(OLED_FIRMWARE_DEVIATIONS);
    expect(OLED_FIRMWARE_DEVIATIONS.join(' ')).toMatch(/-DSESAME_TELEMETRY_OLED=1/);
    expect(QEMU_CAPABILITIES_WITHOUT_OLED.firmwareDeviations).toEqual(FIRMWARE_DEVIATIONS);
  });

  it('surfaces the known flakiness with its issue id', () => {
    expect(QEMU_CAPABILITIES_FULL.knownFlakiness).toMatch(/ISSUE-20260823-022/);
  });
});

describe('the LEDC peripheral is not claimed to produce a waveform (Q3)', () => {
  // QEMU's esp32 machine really does contain an LEDC device, its duty ratio is
  // arithmetically correct, and it has no timer, no output wire and no
  // consumer. "The registers hold plausible values" is not "a pulse was
  // produced", and this backend must not imply otherwise.
  it('elides the LEDC waveform, so its silence is negative evidence rather than an idle pin', () => {
    expect(ELIDED_SUBSYSTEMS).toContain('ledc-waveform');
    expect(QEMU_ORIGIN.elided).toContain('ledc-waveform');
    expect(QEMU_CAPABILITIES_FULL.elided).toContain('ledc-waveform');
  });

  it('states the fidelity limit in words, not only as an absent list entry', () => {
    const fidelity = PERIPHERAL_FIDELITY.join(' ');
    // Duty ratio: modelled and correct.
    expect(fidelity).toMatch(/duty ratio is modelled and correct/i);
    // Frequency, GPIO and waveform: not modelled at all.
    expect(fidelity).toMatch(/frequency, GPIO output and waveform are not modelled/i);
    // And therefore the firmware hook is the source of servo evidence.
    expect(fidelity).toMatch(/instrumentation hook/i);
    expect(fidelity).toMatch(/Q3-ledc-fidelity\.md/);
    expect(QEMU_CAPABILITIES_FULL.peripheralFidelity).toEqual(PERIPHERAL_FIDELITY);
  });

  it('says the SSD1306 is still unmodelled even though the pixels are observed', () => {
    // The exact sentence that stops "oledFramebuffer: true" being read as "the
    // panel is emulated". Same shape as the LEDC entry above and for the same
    // reason: the evidence is a firmware hook ABOVE a device that is absent.
    const fidelity = PERIPHERAL_FIDELITY.join(' ');
    expect(fidelity).toMatch(/SSD1306 panel is NOT modelled/i);
    expect(fidelity).toMatch(/getBuffer\(\)/);
    expect(fidelity).toMatch(/NOT a readback of a panel/i);
    expect(fidelity).toMatch(/EXP6-QEMU-oled\.md/);
    // Present on BOTH records: the device is missing either way.
    expect(QEMU_CAPABILITIES_WITHOUT_OLED.peripheralFidelity).toEqual(PERIPHERAL_FIDELITY);
  });

  it('never lets "LEDC is modelled" stand alone as a claim about the servo signal', () => {
    // A regression guard with teeth: if someone drops the elided entry, the
    // capability record would say only that a peripheral exists.
    expect(QEMU_CAPABILITIES_FULL.peripheralFidelity.length).toBeGreaterThan(0);
    expect(QEMU_CAPABILITIES.realHardware).toBe(false);
  });
});

describe('provenance cannot be mistaken for hardware', () => {
  it('an emulator origin is never physically observed', () => {
    // The exact confusion the origin field was added to prevent: `observed` is
    // the correct provenance here — a firmware hook really ran — and it is
    // still not a measurement.
    expect(isPhysicallyObserved({ provenance: 'observed', origin: QEMU_ORIGIN })).toBe(false);
    expect(isPhysicallyObserved({ provenance: 'observed', origin: UNKNOWN_ORIGIN })).toBe(false);
    expect(isPhysicallyObserved({ provenance: 'observed' })).toBe(false);
    expect(
      isPhysicallyObserved({ provenance: 'observed', origin: { kind: 'physical-robot' } }),
    ).toBe(true);
  });

  it('the origin names the emulator, the board, and what is missing', () => {
    expect(QEMU_ORIGIN.kind).toBe('emulator');
    expect(QEMU_ORIGIN.engine).toMatch(/^qemu-system-xtensa\//);
    expect(QEMU_ORIGIN.board).toBe('distro-v1-esp32');
    expect(QEMU_ORIGIN.elided).toEqual(ELIDED_SUBSYSTEMS);
    expect(QEMU_ORIGIN.elided).toContain('wifi-phy');
    // `ssd1306-panel` is gone on the default image because the framebuffer is
    // observed; `ssd1306-glass` replaces it because the DEVICE still is not
    // modelled and no pixel has been confirmed to reach any panel.
    expect(QEMU_ORIGIN.elided).not.toContain('ssd1306-panel');
    expect(QEMU_ORIGIN.elided).toContain('ssd1306-glass');
    // And the image without the hook keeps the original claim exactly.
    expect(QEMU_ORIGIN_WITHOUT_OLED.elided).toContain('ssd1306-panel');
    expect(QEMU_ORIGIN_WITHOUT_OLED.elided).not.toContain('ssd1306-glass');
    expect(originForImage(CLI_IMAGE_PATH)).toBe(QEMU_ORIGIN_WITHOUT_OLED);
    expect(originForImage(OLED_IMAGE_PATH)).toBe(QEMU_ORIGIN);
    expect(elidedForImage(CLI_IMAGE_PATH)).toEqual(ELIDED_WITHOUT_OLED_HOOK);
    expect(elidedForImage(OLED_IMAGE_PATH)).toEqual(ELIDED_SUBSYSTEMS);
  });

  it('enabling the framebuffer moves NOTHING towards hardware', () => {
    // The whole point of TelemetryOrigin. `observed` now covers pixels as well
    // as servo angles, and it is still an emulator on both counts.
    expect(QEMU_ORIGIN.kind).toBe('emulator');
    expect(QEMU_ORIGIN_WITHOUT_OLED.kind).toBe('emulator');
    expect(isPhysicallyObserved({ provenance: 'observed', origin: QEMU_ORIGIN })).toBe(false);
    expect(QEMU_CAPABILITIES.realHardware).toBe(false);
    expect(QEMU_CAPABILITIES_WITHOUT_OLED.realHardware).toBe(false);
    expect(QEMU_ORIGIN.board).toBe(QEMU_ORIGIN_WITHOUT_OLED.board);
  });

  it('describeOrigin never renders as a bare "observed"', () => {
    expect(describeOrigin(QEMU_ORIGIN)).toMatch(/^emulated \(qemu-system-xtensa/);
    expect(describeOrigin(undefined)).toBe('origin not stated');
  });
});

describe('RobotMode', () => {
  it('has a distinct value for this backend', () => {
    // Reporting 'renode' would have been the only alternative and it is false.
    expect(isRobotMode('qemu')).toBe(true);
    expect(ROBOT_MODES).toContain('qemu');
    expect(ROBOT_MODES).toContain('renode');
  });
});

describe('assumptions are labelled as assumptions', () => {
  it('the power-on angle is the servo library mid-point, not a measurement', () => {
    expect(POWER_ON_ANGLE_DEG).toBe(90);
  });
});

describe('session constants come from firmware source', () => {
  it('the boot banner is the end-of-setup() line, bootOrder step 20', () => {
    expect(BOOT_BANNER).toBe('HTTP server & Captive Portal started.');
  });

  it('the cache-error signature from ISSUE-20260823-022 is detected', () => {
    const sample =
      "Guru Meditation Error: Core  0 panic'ed (Cache error). \n" +
      'Cache disabled but cached memory region accessed\n';
    expect(PANIC_PATTERNS.some((p) => p.test(sample))).toBe(true);
  });

  it('a healthy boot log trips no panic pattern', () => {
    const healthy = [
      'ets Jul 29 2019 12:21:46',
      'rst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)',
      'mode:DIO, clock div:1',
      'entry 0x4008059c',
      '@SESAME hello 1 sesame-fw-s2mini/0.1.0',
      '@SESAME face rest 0',
      BOOT_BANNER,
    ].join('\n');
    expect(PANIC_PATTERNS.some((p) => p.test(healthy))).toBe(false);
  });

  it('a guest-initiated reboot is treated as a failed boot', () => {
    // A panic that recovers by rebooting still means the first boot died, and a
    // caller that waited it out would silently get a much slower connect. Seen
    // in 2 of 8 baseline failures.
    expect(PANIC_PATTERNS.some((p) => p.test('rst:0xc (SW_CPU_RESET),boot:0x12'))).toBe(true);
  });
});

describe('orphan registry', () => {
  it('is empty when nothing has been launched', () => {
    expect(livePids()).toEqual([]);
  });
});

describe('what the backend will actually put on the wire', () => {
  it('a wave is five bytes', () => {
    expect(encodeCommand({ type: 'movement.run', command: 'wave' }).line).toBe('rn wv');
  });

  it('a stand is the long form, which cannot be confused with the subtrim dump', () => {
    expect(encodeCommand({ type: 'movement.run', command: 'stand' }).line).toBe('run stand');
  });
});
