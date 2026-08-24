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
  ELIDED_SUBSYSTEMS,
  FIRMWARE_DEVIATIONS,
  POWER_ON_ANGLE_DEG,
  QEMU_CAPABILITIES,
  QEMU_CAPABILITIES_FULL,
  QEMU_ORIGIN,
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

  it('claims no OLED framebuffer: QEMU attaches no SSD1306 to the I2C bus', () => {
    expect(QEMU_CAPABILITIES.oledFramebuffer).toBe(false);
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
    expect(QEMU_CAPABILITIES_FULL.firmwareDeviations).toEqual(FIRMWARE_DEVIATIONS);
  });

  it('surfaces the known flakiness with its issue id', () => {
    expect(QEMU_CAPABILITIES_FULL.knownFlakiness).toMatch(/ISSUE-20260823-022/);
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
    expect(QEMU_ORIGIN.elided).toContain('ssd1306-panel');
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
