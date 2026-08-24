/**
 * Shared gate for the tests that need a real emulator.
 *
 * QEMU and the flash image are both gitignored build products: `fetch-qemu.mjs`
 * downloads one, `build-qemu-images.mjs` compiles the other, and the second
 * needs the whole Arduino toolchain. A clone with neither must still be able to
 * run `pnpm test` and get a green, meaningful result.
 *
 * So the emulator-backed suites skip themselves — **loudly**, naming the
 * command that would make them run. What they must never do is quietly pass:
 * a contract suite that reports success because it did not execute is worse
 * than one that fails.
 */
import fs from 'node:fs';

import { DEFAULT_IMAGE_PATH, DEFAULT_QEMU_PATH } from '../config.js';

/** True when both build products are present. */
export const QEMU_AVAILABLE =
  fs.existsSync(DEFAULT_QEMU_PATH) && fs.existsSync(DEFAULT_IMAGE_PATH);

/** Why the emulator suites are being skipped, for the suite name. */
export const SKIP_REASON = (): string => {
  const missing: string[] = [];
  if (!fs.existsSync(DEFAULT_QEMU_PATH)) missing.push('node emulator/qemu/fetch-qemu.mjs');
  if (!fs.existsSync(DEFAULT_IMAGE_PATH)) {
    missing.push('node emulator/qemu/build-qemu-images.mjs cli');
  }
  return missing.length === 0 ? '' : ` (SKIPPED — run: ${missing.join(' && ')})`;
};
