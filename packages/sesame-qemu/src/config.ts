/**
 * Where the artefacts are on this machine, and what to default when a caller
 * does not say.
 *
 * **The capability record itself moved to `capabilities.ts`** and is re-exported
 * below, unchanged. The split is the only structural change Phase 5 T4 made to
 * this package, and it is a split rather than a copy for the reason T2 §5 gives:
 * `imageHasOledHook()` is a substring test on a file name whose wrong answer is
 * the *safe-looking* one, so a second implementation would downgrade the OLED
 * claim silently. The webview needs the derivation and cannot have `node:path`;
 * this file is the half that needs `node:path` and the browser does not.
 *
 * Everything that looks like a limitation in either half is one. The single most
 * important thing this package exports is not the class — it is
 * {@link QEMU_ORIGIN} and {@link QEMU_CAPABILITIES}, because they are what stop
 * a learner reading an emulated servo angle as a measurement.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Re-exported, not redefined.
 *
 * The capability record moved to `capabilities.ts` so that Phase 5 T4's webview
 * can import it without importing `node:path` — see that file's header. Every
 * symbol it owns is re-exported here so this module's public surface, and
 * therefore `index.ts` and every existing importer, is unchanged.
 */
export * from './capabilities.js';

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
