/**
 * What `QemuSesameRobot` needs to know, and what it is honest about.
 *
 * Everything in here that looks like a limitation is one. The single most
 * important thing this package exports is not the class — it is
 * {@link QEMU_ORIGIN} and {@link QEMU_CAPABILITIES}, because they are what stop
 * a learner reading an emulated servo angle as a measurement.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SesameCapabilities } from '@sesame-lab/sesame-model';
import { COMMAND_CHANNEL, type TelemetryOrigin } from '@sesame-lab/sesame-protocol';

/** Repository root, from `dist/` or `src/`. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Espressif's QEMU fork, as `emulator/qemu/fetch-qemu.mjs` installs it. */
export const DEFAULT_QEMU_PATH = path.join(
  REPO_ROOT,
  'tools',
  'qemu',
  'qemu',
  'bin',
  'qemu-system-xtensa.exe',
);

/**
 * The image this backend boots: `node emulator/qemu/build-qemu-images.mjs cli`.
 *
 * **Not stock firmware.** See {@link FIRMWARE_DEVIATIONS}.
 */
export const DEFAULT_IMAGE_PATH = path.join(
  REPO_ROOT,
  'emulator',
  'qemu',
  'images',
  'distro-v1-esp32-cli.flash.bin',
);

/** QEMU's release tag, pinned by `fetch-qemu.mjs`. */
export const QEMU_RELEASE = 'esp_develop_9.2.2_20260417';

/**
 * Every way the running image differs from stock Sesame firmware.
 *
 * Reproduced verbatim into every telemetry event's `origin`, so a consumer
 * never has to find this file to know what it is looking at.
 */
export const FIRMWARE_DEVIATIONS: readonly string[] = Object.freeze([
  'FlashMode=dio bootloader substituted for qio (QEMU models no flash Quad-Enable bit); ' +
    '67 metadata bytes differ, no instruction bytes',
  'Wi-Fi bring-up, SoftAP, mDNS, DNS server and server.begin() commented out ' +
    '(QEMU models no ESP32 radio at all)',
  'R6 telemetry instrumentation applied (firmware/patches/telemetry-instrumentation.patch)',
]);

/** Subsystems the emulator does not model. Silence from these means nothing. */
export const ELIDED_SUBSYSTEMS: readonly string[] = Object.freeze([
  'wifi-mac',
  'wifi-phy',
  'http-server',
  'captive-portal',
  'mdns',
  'ssd1306-panel',
  'servo-load',
  // Q3: QEMU's `misc.esp32.ledc` is a real device at the real address and its
  // duty *ratio* is arithmetically correct, but it has no timer, no clock, no
  // GPIO connection and no output. No pulse, no edge, no 50 Hz. Elided rather
  // than merely "unverified", because the absence of LEDC events means "there
  // is no waveform generator", not "the pin was idle" — which is exactly the
  // negative evidence this field exists to carry.
  'ledc-waveform',
  'usb-cdc',
]);

/**
 * Peripherals that ARE modelled, and how far the model actually goes.
 *
 * Distinct from {@link FIRMWARE_DEVIATIONS} (which is about the *image*) and
 * from {@link ELIDED_SUBSYSTEMS} (which is about what is absent). This is the
 * awkward middle: a device that exists, answers reads, and is still not doing
 * the thing its name implies. Left unstated, "the LEDC is modelled" reads as
 * "the servo signal is emulated", and it is not.
 */
export const PERIPHERAL_FIDELITY: readonly string[] = Object.freeze([
  'LEDC duty ratio is modelled and correct — all 29 servo writes in a boot match the ESP32 TRM ' +
    'formula applied to the pulse ESP32Servo actually programmed (Q3, 29/29, ±1% because the ' +
    "model's arithmetic is integer). LEDC frequency, GPIO output and waveform are not modelled " +
    'at all: there is no timer, no output wire and no consumer of the duty value. Servo evidence ' +
    "therefore comes from the firmware's own instrumentation hook, ABOVE the peripheral — the " +
    'hook is load-bearing and no amount of emulator work retires it. Only a logic analyser on ' +
    'real hardware (checklist V6-14) can show a pulse. See docs/findings/Q3-ledc-fidelity.md.',
]);

/**
 * **The label that keeps emulated from being read as physical.**
 *
 * Stamped onto every event this backend emits. `provenance` stays `observed` —
 * the firmware hook really did run and bytes really did cross UART0 — and
 * `origin.kind` says *what* it ran on. `isPhysicallyObserved()` returns false
 * for everything here, which is the machine-readable form of "no physical
 * Sesame robot was involved at any point".
 */
export const QEMU_ORIGIN: TelemetryOrigin = Object.freeze({
  kind: 'emulator',
  engine: `qemu-system-xtensa/9.2.2-${QEMU_RELEASE}`,
  // The legacy V1 board, and only that. QEMU's esp32s3 machine boots ROM and
  // bootloader but never reaches setup(), and there is no esp32s2 machine at
  // all — so the S2 Mini, the board the report recommends for DIY builds, is
  // not testable here by any means. Q1 §9, §12.
  board: 'distro-v1-esp32',
  elided: ELIDED_SUBSYSTEMS,
  firmwareDeviations: FIRMWARE_DEVIATIONS,
});

/**
 * What this backend can do. Every `false` is load-bearing.
 *
 * `firmwareExecution: true` is the one thing it has that the simulator does
 * not, and it is the whole reason the package exists: these are real Xtensa
 * instructions from the real compiled image, through the real mask ROM and the
 * real ESP-IDF startup.
 */
export const QEMU_CAPABILITIES: SesameCapabilities = Object.freeze({
  /** No physical Sesame exists in this project, and none is involved here. */
  realHardware: false,
  /** The actual compiled firmware executes, instruction by instruction. */
  firmwareExecution: true,
  /**
   * False, and not for want of a hook. QEMU attaches no SSD1306 to the ESP32
   * I2C bus — the only slave the machine creates is a TMP105 — so
   * `display.display()` writes go nowhere. The R6 framebuffer hook
   * (`SESAME_TELEMETRY_OLED=1`) would produce pixels from inside the guest, but
   * it is off by default: one frame is 1385 bytes, ~120 ms of wire time at
   * 115200 baud, inside a 20 ms servo delay budget.
   */
  oledFramebuffer: false,
  /**
   * **True, and this is the change v2 makes.** The firmware's own serial
   * console on UART0 is the command channel — the same UART the telemetry
   * leaves by, in the other direction.
   */
  serialConsole: true,
  /**
   * False. Not "not implemented yet" — *impossible on this backend*. The HTTP
   * server needs a radio for lwIP's tcpip thread, QEMU models no ESP32 Wi-Fi
   * MAC or PHY, and stock firmware asserts in `esp_phy_enable` at bootOrder
   * step 7. `server.begin()` is one of the lines the image elides.
   *
   * `@sesame-lab/sesame-api` can still put the ten firmware routes in front of
   * this backend, but that is a **host-side proxy** speaking to the serial CLI,
   * not the robot's own web server.
   */
  httpApi: false,
  /** Kinematics only. No load, no torque, no gravity, no contact. */
  physics: false,
});

/**
 * The capability record with the qualifiers a `SesameCapabilities` has no field
 * for.
 *
 * `SesameCapabilities` is six booleans, and six booleans cannot express "works,
 * but only on the board nobody is told to buy". Returning a widened object
 * keeps the interface satisfied while putting the caveats somewhere a UI can
 * actually read them, rather than in a README nobody renders next to the servo
 * angle.
 */
export interface QemuCapabilities extends SesameCapabilities {
  readonly origin: TelemetryOrigin;
  /** `hardware-map.json` board profile. The only one that works. */
  readonly board: string;
  /** Boards this backend cannot emulate, and why, keyed by profile name. */
  readonly unsupportedBoards: Readonly<Record<string, string>>;
  /** Identity of the host → device channel. */
  readonly commandChannel: string;
  /** How the image differs from stock firmware. */
  readonly firmwareDeviations: readonly string[];
  /** Subsystems not modelled; their silence is not evidence. */
  readonly elided: readonly string[];
  /**
   * Peripherals that are modelled, and the limit of that model. See
   * {@link PERIPHERAL_FIDELITY} — a device answering reads is not a device
   * doing its job.
   */
  readonly peripheralFidelity: readonly string[];
  /** Known non-determinism, measured. See `docs/findings/Q2-qemu-backend.md`. */
  readonly knownFlakiness: string;
}

/** {@link QEMU_CAPABILITIES} plus the qualifiers. */
export const QEMU_CAPABILITIES_FULL: QemuCapabilities = Object.freeze({
  ...QEMU_CAPABILITIES,
  origin: QEMU_ORIGIN,
  board: 'distro-v1-esp32',
  unsupportedBoards: Object.freeze({
    'distro-v3-s3':
      'QEMU has an esp32s3 machine and the image boots ROM + bootloader, but execution ' +
      'never reaches setup(): the PC pins inside the mask-ROM routine rom_pkdet_vol_start. ' +
      'This is the CURRENT Distro board (Q1 §9).',
    s2mini:
      'QEMU has no esp32s2 machine at all, and Espressif has shown no sign of adding one. ' +
      'This is the board the research report RECOMMENDS for DIY builds (Q1 §12).',
  }),
  commandChannel: COMMAND_CHANNEL,
  firmwareDeviations: FIRMWARE_DEVIATIONS,
  elided: ELIDED_SUBSYSTEMS,
  peripheralFidelity: PERIPHERAL_FIDELITY,
  knownFlakiness:
    'ISSUE-20260823-022: 30 of 107 measured cold boots (28%, and bursty) panic with "Cache disabled but ' +
    'cached memory region accessed" inside the dual-core cache/flash dance in nvs_flash_init ' +
    '(esp_flash_read -> spi_flash_restore_cache -> cache_hal_resume). A QEMU modelling bug, ' +
    'not fixable from outside it: snapshot=on does not change the rate, and both knobs that ' +
    'would serialise the cores (-accel tcg,thread=single, -icount) stop the machine booting ' +
    'at all. connect() detects it in ~2 s and relaunches: 0 failures in 25 connects, worst ' +
    'case 7 attempts. See docs/findings/Q2-qemu-backend.md.',
});

/**
 * Power-on joint angle assumed when a channel has never been observed.
 *
 * `RobotState.commandedDeg` is not optional, and the contract requires every
 * one of the eight to be inside the firmware clamp — so a number has to go
 * here. The honest one is 90: `servos[i].attach(pin, 732, 2929)` at
 * `sesame-firmware-main.ino:742` — the call as written; ESP32Servo clamps the
 * requested max to 2500 µs, so the effective window is 732…2500 (Q3 §6.2) —
 * puts the channel at its mid-point default, and
 * setup() deliberately does not write any of them ("Show rest face on startup
 * without moving motors", `:746`).
 *
 * It is still an assumption, so {@link QemuRobotState.observed.everObserved}
 * says which joints it applies to. A UI that draws an unobserved joint as
 * though it were reported is drawing this constant.
 */
export const POWER_ON_ANGLE_DEG = 90;

/** Constructor options. Every one has a defensible default. */
export interface QemuRobotOptions {
  /** Path to `qemu-system-xtensa`. Default: the pinned portable install. */
  readonly qemuPath?: string;
  /** Flash image. Default: `distro-v1-esp32-cli.flash.bin`. */
  readonly imagePath?: string;
  /** QEMU `-machine`. Default `esp32`; nothing else is supported (see above). */
  readonly machine?: string;
  /**
   * Boot attempts before `connect()` gives up.
   *
   * The retry is not politeness, it is the documented mitigation for
   * ISSUE-20260823-022; see {@link QemuCapabilities.knownFlakiness}.
   *
   * Twelve, not eight, and the reason is a measurement rather than a round
   * number: across 25 connects (37 boots, 12 of them failed) the **worst
   * connect needed 7 attempts**. At an independent 35% per boot, seven failures
   * in a row should happen about once in 1600 connects, so seeing it in 25 is
   * evidence that the failures cluster rather than being independent — which is
   * plausible for a host-timing-sensitive race. Eight would have left almost no
   * margin above an outcome that was actually observed.
   */
  readonly bootAttempts?: number;
  /** Milliseconds to wait for the boot banner on one attempt. Default 15000. */
  readonly bootTimeoutMs?: number;
  /** Milliseconds to wait for a command's completion barrier. Default 90000. */
  readonly commandTimeoutMs?: number;
  /**
   * After a face change, how long with no further `face.expression` event
   * counts as "the panel has settled". Default 1200 ms.
   *
   * Needed because `currentFaceMode` powers on as `FACE_ANIM_LOOP`
   * (`sesame-firmware-main.ino:58`), so a multi-frame face keeps emitting a
   * frame per second forever, and a caller that returned the instant the
   * command was acknowledged would hand its next assertion a moving target.
   */
  readonly faceSettleMs?: number;
  /** Hard cap on face settling, for a face that never stops animating. Default 3000 ms. */
  readonly faceSettleMaxMs?: number;
  /** UART TCP port. Default 0 = ask the OS for a free one. */
  readonly uartPort?: number;
  /**
   * QEMU `-drive ...,snapshot=on`. Default true, and there is no good reason to
   * turn it off.
   *
   * `if=mtd` is read-write and the guest's NVS and core-dump writes land in the
   * image file, so a run silently mutates the artefact it booted. Q1 recommended
   * this and the Q1 demo script never applied it. It does **not** affect
   * ISSUE-20260823-022 — measured, 6/20 failures with it versus 8/20 without —
   * it protects the image, not the boot.
   */
  readonly snapshot?: boolean;
  /** Where diagnostics go. Default: nowhere. */
  readonly logger?: (message: string) => void;
}

/** Options with every default filled in. */
export interface ResolvedQemuOptions {
  readonly qemuPath: string;
  readonly imagePath: string;
  readonly machine: string;
  readonly bootAttempts: number;
  readonly bootTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly faceSettleMs: number;
  readonly faceSettleMaxMs: number;
  readonly uartPort: number;
  readonly snapshot: boolean;
  readonly logger: (message: string) => void;
}

/** Apply defaults. */
export function resolveQemuOptions(options: QemuRobotOptions = {}): ResolvedQemuOptions {
  return {
    qemuPath: options.qemuPath ?? DEFAULT_QEMU_PATH,
    imagePath: options.imagePath ?? DEFAULT_IMAGE_PATH,
    machine: options.machine ?? 'esp32',
    bootAttempts: options.bootAttempts ?? 12,
    bootTimeoutMs: options.bootTimeoutMs ?? 15000,
    commandTimeoutMs: options.commandTimeoutMs ?? 90000,
    faceSettleMs: options.faceSettleMs ?? 1200,
    faceSettleMaxMs: options.faceSettleMaxMs ?? 3000,
    uartPort: options.uartPort ?? 0,
    snapshot: options.snapshot ?? true,
    logger: options.logger ?? ((): void => undefined),
  };
}
