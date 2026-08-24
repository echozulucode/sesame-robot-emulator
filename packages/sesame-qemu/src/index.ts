/**
 * `@sesame-lab/sesame-qemu` — the `SesameRobot` contract over real Sesame
 * firmware executing under Espressif's QEMU fork.
 *
 * ```ts
 * import { QemuSesameRobot } from '@sesame-lab/sesame-qemu';
 *
 * const robot = new QemuSesameRobot();
 * await robot.connect();                 // boots QEMU, waits for setup() to finish
 * robot.subscribe((e) => console.log(e));
 * await robot.command('wave');           // -> "rn wv" on UART0
 * await robot.disconnect();              // kills QEMU, waits for the OS to confirm
 * ```
 *
 * ## Why this is a separate package
 *
 * `@sesame-lab/sesame-sim` runs in a browser. This one spawns processes and
 * opens sockets — `node:child_process`, `node:net`, `node:fs` — so folding it
 * into `sesame-sim` would put a Node-only dependency on the critical path of
 * every consumer of the simulator, `apps/web` included. Keeping it separate is
 * what lets `apps/web` import the interface and one implementation without
 * importing an emulator it cannot run.
 *
 * The `SesameRobot` interface still lives in `sesame-sim`, which is now the
 * wrong home for it — that package's own doc comment already says so, and says
 * to move it "when `RealSesameRobot` (physical) and `RenodeSesameRobot`
 * (emulated) arrive". This is the second implementation, so the move is now
 * due; it is deliberately **not** done here, because moving a widely imported
 * interface in the same change that introduces a new backend makes both harder
 * to review.
 *
 * ## What it is, and is not
 *
 * | | |
 * |---|---|
 * | Real compiled firmware, real Xtensa instructions, real ESP-IDF boot | **yes** |
 * | Real hardware | **no** — `origin.kind === 'emulator'` on every event |
 * | The board it emulates | `distro-v1-esp32`, the **legacy** V1 board |
 * | The current Distro board (`distro-v3-s3`) | boots ROM + bootloader, never reaches `setup()` |
 * | The recommended DIY board (S2 Mini) | QEMU has **no** `esp32s2` machine |
 * | Wi-Fi, HTTP, captive portal, mDNS | **impossible** — QEMU models no ESP32 radio |
 * | OLED pixels | not rendered; QEMU attaches no SSD1306 |
 *
 * Findings: `docs/findings/Q1-qemu-spike.md`, `docs/findings/Q2-qemu-backend.md`.
 */

export {
  DEFAULT_IMAGE_PATH,
  DEFAULT_QEMU_PATH,
  ELIDED_SUBSYSTEMS,
  FIRMWARE_DEVIATIONS,
  PERIPHERAL_FIDELITY,
  POWER_ON_ANGLE_DEG,
  QEMU_CAPABILITIES,
  QEMU_CAPABILITIES_FULL,
  QEMU_ORIGIN,
  QEMU_RELEASE,
  REPO_ROOT,
  resolveQemuOptions,
  type QemuCapabilities,
  type QemuRobotOptions,
  type ResolvedQemuOptions,
} from './config.js';

export {
  QemuArtifactMissingError,
  QemuBootFailedError,
  QemuCommandTimeoutError,
  QemuGuestPanicError,
  QemuNotConnectedError,
  QemuUnsupportedCommandError,
} from './errors.js';

export {
  BOOT_BANNER,
  MAX_BATCH_BYTES,
  PANIC_PATTERNS,
  QemuSession,
  launchWithRetry,
  livePids,
  type BootAttempt,
  type LaunchResult,
} from './session.js';

export { QemuSesameRobot, type QemuRobotState } from './robot.js';
