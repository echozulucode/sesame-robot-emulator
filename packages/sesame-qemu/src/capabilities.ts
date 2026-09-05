/**
 * What the emulator backend is honest about — **derived from the image path,
 * and importable from a browser.**
 *
 * ## Why this file exists separately from `config.ts`
 *
 * Everything here is a pure function of a *file name*: which subsystems are
 * elided, which firmware deviations apply, which {@link TelemetryOrigin} to
 * stamp, and whether `oledFramebuffer` may be claimed. None of it needs a
 * process, a socket or a path on this machine.
 *
 * `config.ts` does. It derives `REPO_ROOT` from `import.meta.url` and hangs
 * `DEFAULT_QEMU_PATH` / `DEFAULT_IMAGE_PATH` off it, which requires `node:path`
 * and `node:url` **at module scope** — so importing the capability record used
 * to mean importing Node, and the Tauri desktop app's webview cannot.
 *
 * Phase 5 T4 needs exactly these objects on the frontend: Rust reports the
 * image's *identity* (`imageName`, `imagePath`) and refuses to invent what it
 * means (`docs/findings/T3-rust-supervisor.md` §7), so the webview has to run
 * the same derivation the Node backend runs. The alternative — a second copy of
 * the table in TypeScript or in Rust — is the one thing T2 §5 showed is
 * dangerous: `imageHasOledHook()` is a substring test on a file name, an
 * unrecognised name gets the *conservative* answer, and a rename would
 * therefore downgrade the OLED claim from `observed` to `inferred` silently, in
 * the safe-looking direction. One derivation, two consumers.
 *
 * **Nothing in this file changed when it moved.** `config.ts` re-exports every
 * symbol below, so `@sesame-lab/sesame-qemu` and every existing importer are
 * byte-for-byte unaffected; the only new thing is the `./capabilities` subpath,
 * which resolves this module without `config.ts` and therefore without Node.
 *
 * The single edit is {@link basename}: `path.basename()` became four lines of
 * string handling, because `node:path` is the import this file exists to avoid.
 * It is a *stricter* basename than the POSIX shim a bundler would have
 * substituted — that one returns the whole string for a Windows path (T2 §5).
 */
import type { SesameCapabilities } from '@sesame-lab/sesame-model';
import { COMMAND_CHANNEL, type TelemetryOrigin } from '@sesame-lab/sesame-protocol';

/**
 * The last segment of a path, on either separator.
 *
 * `node:path`'s `basename()`, restricted to what this file asks of it and with
 * both separators always honoured. Windows accepts `/` as well as `\`, and the
 * paths handed in here come from three places that spell them differently:
 * `DEFAULT_IMAGE_PATH` (`path.join`, backslashes), Tauri's
 * `app.path().resolve()` by way of Rust (backslashes, `\\?\` already stripped),
 * and `tauri.conf.json`'s bundle targets (forward slashes).
 */
function basename(filePath: string): string {
  const at = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return at === -1 ? filePath : filePath.slice(at + 1);
}

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
  return basename(imagePath).includes('cli-oled');
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
