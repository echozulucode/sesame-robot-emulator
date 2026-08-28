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

/** Where `emulator/qemu/build-qemu-images.mjs` puts what it builds. */
const IMAGES_DIR = path.join(REPO_ROOT, 'emulator', 'qemu', 'images');

/**
 * The Q2 image: telemetry + Wi-Fi elision + serial CLI, **without** the OLED
 * framebuffer hook. `node emulator/qemu/build-qemu-images.mjs cli`.
 *
 * Still supported, still honest — it just cannot show pixels, and
 * {@link capabilitiesForImage} says so when it is the one booted.
 */
export const CLI_IMAGE_PATH = path.join(IMAGES_DIR, 'distro-v1-esp32-cli.flash.bin');

/**
 * The same image plus `-DSESAME_TELEMETRY_OLED=1`.
 * `node emulator/qemu/build-qemu-images.mjs cli-oled`.
 *
 * One compile-time token is the entire difference. It turns on the hook inside
 * `updateFaceBitmap()` that base64s `display.getBuffer()` — the exact 1024
 * bytes `display.display()` would shift into GDDRAM — onto UART0, so the
 * panel's pixels arrive from the guest instead of being re-derived host-side.
 */
export const OLED_IMAGE_PATH = path.join(IMAGES_DIR, 'distro-v1-esp32-cli-oled.flash.bin');

/**
 * The image this backend boots by default: the one WITH the framebuffer hook.
 *
 * **Measured, not assumed.** EXP6 kept the hook off because one frame is 1385
 * bytes ≈ 120 ms of wire time at 115200 8N1, six times the 20 ms
 * `motorCurrentDelay` budget it is emitted inside. Under QEMU, UART0 is a TCP
 * socket and that baud rate does not exist. `emulator/qemu/probe-oled.mjs`
 * measured the real cost through the firmware's own completion barrier:
 * **+14–15 ms per frame** (median over 12 isolated single-frame face sets,
 * three sessions: 29/30 ms with the hook against 15 ms without), and a full
 * `rn wv` choreography grew by 38–100 ms on ~3.9 s — **+1.0 % to +2.5 %**, a
 * spread dominated by host scheduling rather than by the hook. Per frame that
 * is under one `motorCurrentDelay`, so the reason the hook ships off on silicon
 * does not apply here.
 *
 * **Not stock firmware.** See {@link FIRMWARE_DEVIATIONS}.
 */
export const DEFAULT_IMAGE_PATH = OLED_IMAGE_PATH;

/** QEMU's release tag, pinned by `fetch-qemu.mjs`. */
export const QEMU_RELEASE = 'esp_develop_9.2.2_20260417';

/**
 * True when `imagePath` is an image built with the OLED framebuffer hook on.
 *
 * A filename test, and it is load-bearing enough to say why that is acceptable:
 * the images are produced by one script into one directory under names it
 * controls, and every consumer of this package gets its path from
 * {@link DEFAULT_IMAGE_PATH} or passes one of the two constants above. A caller
 * that hands in an arbitrary renamed image gets the conservative answer —
 * `false`, panel elided — which is the safe direction to be wrong in: it
 * under-claims rather than presenting host-drawn pixels as the emulator's.
 */
export function imageHasOledHook(imagePath: string): boolean {
  return path.basename(imagePath).includes('cli-oled');
}

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

/** The OLED image's extra deviation, appended to {@link FIRMWARE_DEVIATIONS}. */
export const OLED_FIRMWARE_DEVIATION =
  'Compiled with -DSESAME_TELEMETRY_OLED=1 and -DSESAME_TELEMETRY_OLED_MIN_MS=0, which the ' +
  "patch's own #ifndef leaves overridable without changing its in-source defaults (0 and 500). " +
  'This enables the framebuffer hook in updateFaceBitmap() and removes its rate limit; measured ' +
  'cost under QEMU is +14-15 ms per frame and +1.0%..+2.5% on a full `rn wv`. See ' +
  'docs/findings/EXP6-QEMU-oled.md.';

/** {@link FIRMWARE_DEVIATIONS} plus {@link OLED_FIRMWARE_DEVIATION}. */
export const OLED_FIRMWARE_DEVIATIONS: readonly string[] = Object.freeze([
  ...FIRMWARE_DEVIATIONS,
  OLED_FIRMWARE_DEVIATION,
]);

/**
 * Subsystems the emulator does not model, **on the default (OLED) image**.
 * Silence from these means nothing.
 *
 * `ssd1306-panel` is deliberately absent and `ssd1306-glass` deliberately
 * present, and the distinction is the whole point. QEMU still attaches no
 * SSD1306 to the I2C bus — the only slave the `esp32` machine creates is a
 * TMP105 — so `display.display()`'s I2C writes still go nowhere and nothing
 * confirms a panel received them. What changed is that the *framebuffer* is now
 * observed, from inside the guest, one layer above the missing device. Silence
 * on `oled.frame` therefore does mean something now — it means
 * `updateFaceBitmap()` was not called, which is exactly what the firmware does
 * for a face with no bitmap.
 *
 * See {@link ELIDED_WITHOUT_OLED_HOOK} for the list that applies to the `cli`
 * image, and {@link elidedForImage} for the one that applies to what you booted.
 */
export const ELIDED_SUBSYSTEMS: readonly string[] = Object.freeze([
  'wifi-mac',
  'wifi-phy',
  'http-server',
  'captive-portal',
  'mdns',
  // The panel DEVICE, still absent, still unmodelled. Kept as its own entry so
  // that dropping `ssd1306-panel` does not quietly also drop the fact that no
  // pixel has ever been confirmed to reach any glass, real or emulated.
  'ssd1306-glass',
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
 * The elision list for the `cli` image, which has no framebuffer hook.
 *
 * `ssd1306-panel` is back: with the hook off, the firmware emits face *names*
 * and no pixels at all, so anything a UI draws it drew itself.
 */
export const ELIDED_WITHOUT_OLED_HOOK: readonly string[] = Object.freeze([
  ...ELIDED_SUBSYSTEMS.filter((s) => s !== 'ssd1306-glass'),
  'ssd1306-panel',
]);

/** Whichever of the two lists describes `imagePath`. */
export function elidedForImage(imagePath: string): readonly string[] {
  return imageHasOledHook(imagePath) ? ELIDED_SUBSYSTEMS : ELIDED_WITHOUT_OLED_HOOK;
}

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
  // The OLED sits in exactly the same awkward middle as the LEDC, and for
  // exactly the same reason: the evidence comes from a firmware hook above a
  // peripheral the emulator does not have. Saying "the OLED works now" without
  // this paragraph would be the same error as "the LEDC is modelled".
  'SSD1306 panel is NOT modelled and never has been: QEMU attaches no SSD1306 to the ESP32 I2C ' +
    'bus (the only slave the esp32 machine creates is a TMP105), so display.display()\'s I2C ' +
    'writes go nowhere. What IS observed, on the default image, is the FRAMEBUFFER — the ' +
    'SESAME_TELEMETRY_OLED hook base64s display.getBuffer() from inside updateFaceBitmap(), ' +
    'BEFORE display.display(), so the 1024 bytes are the driver\'s own page-ordered GDDRAM buffer ' +
    'read out of guest RAM. Verified byte-for-byte against Adafruit_GFX::drawBitmap applied to ' +
    'face-bitmaps.h: 7/7 frames identical in a probe session. That makes the pixels a report of ' +
    'what the driver was about to shift out, NOT a readback of a panel — if an I2C write failed ' +
    'the telemetry would still say the frame was drawn. Only real hardware can close that gap. ' +
    'See docs/findings/EXP6-QEMU-oled.md.',
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
  firmwareDeviations: OLED_FIRMWARE_DEVIATIONS,
});

/**
 * The origin for the `cli` image — same emulator, same board, no framebuffer.
 *
 * Kept as its own frozen object rather than built on demand so that the two are
 * comparable by identity in a test, and so that neither can drift into
 * describing the other.
 */
export const QEMU_ORIGIN_WITHOUT_OLED: TelemetryOrigin = Object.freeze({
  ...QEMU_ORIGIN,
  elided: ELIDED_WITHOUT_OLED_HOOK,
  firmwareDeviations: FIRMWARE_DEVIATIONS,
});

/**
 * The origin that describes the image actually booted.
 *
 * `kind` is `emulator` either way, and `isPhysicallyObserved()` is false either
 * way. Nothing about enabling the framebuffer hook moves this any closer to
 * hardware; it moves `oled.frame` from *absent* to *observed*, and that is all.
 */
export function originForImage(imagePath: string): TelemetryOrigin {
  return imageHasOledHook(imagePath) ? QEMU_ORIGIN : QEMU_ORIGIN_WITHOUT_OLED;
}

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
   * **True on the default image, and it means the framebuffer — not the panel.**
   *
   * QEMU still attaches no SSD1306 to the ESP32 I2C bus; the only slave the
   * machine creates is a TMP105, and `display.display()`'s writes still go
   * nowhere. What is true is that the R6 framebuffer hook
   * (`SESAME_TELEMETRY_OLED=1`, on in `distro-v1-esp32-cli-oled`) reads
   * `display.getBuffer()` from inside `updateFaceBitmap()` and puts those 1024
   * bytes on UART0, so the pixels a UI draws are the guest's own GDDRAM rather
   * than a host-side re-render of `face-bitmaps.h`.
   *
   * EXP6 left this off because a frame is ~120 ms of wire time at 115200 8N1.
   * Under QEMU the UART is a TCP socket: measured +14-15 ms per frame and +1.0 %
   * to +2.5 % on a full `rn wv`. See {@link DEFAULT_IMAGE_PATH} and
   * `docs/findings/EXP6-QEMU-oled.md`.
   *
   * `false` for the `cli` image — use {@link capabilitiesForImage}.
   */
  oledFramebuffer: true,
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
  firmwareDeviations: OLED_FIRMWARE_DEVIATIONS,
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

/** {@link QEMU_CAPABILITIES_FULL} for the `cli` image: no framebuffer, panel elided. */
export const QEMU_CAPABILITIES_WITHOUT_OLED: QemuCapabilities = Object.freeze({
  ...QEMU_CAPABILITIES_FULL,
  oledFramebuffer: false,
  origin: QEMU_ORIGIN_WITHOUT_OLED,
  firmwareDeviations: FIRMWARE_DEVIATIONS,
  elided: ELIDED_WITHOUT_OLED_HOOK,
});

/**
 * The capability record for the image actually booted.
 *
 * This is what `QemuSesameRobot.capabilities()` returns, and it is the reason
 * the app needs no QEMU-specific branch to decide whether the panel's pixels
 * are the emulator's: booting the `cli` image reports `oledFramebuffer: false`
 * with `ssd1306-panel` elided, booting `cli-oled` reports `true` without it, and
 * the UI follows the record rather than the backend's identity.
 */
export function capabilitiesForImage(imagePath: string): QemuCapabilities {
  return imageHasOledHook(imagePath) ? QEMU_CAPABILITIES_FULL : QEMU_CAPABILITIES_WITHOUT_OLED;
}

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
