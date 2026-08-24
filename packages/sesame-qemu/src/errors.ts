/**
 * Failures this backend can have that a host-side simulator cannot.
 *
 * Each one is a real, observed condition rather than a defensive `throw new
 * Error('unreachable')`: an emulator can fail to boot, a guest can panic
 * mid-command, and a process can outlive the object that owns it.
 */

/** A method was called before `connect()`, or after `disconnect()`. */
export class QemuNotConnectedError extends Error {
  constructor(readonly method: string) {
    super(`${method}() requires connect() first`);
    this.name = 'QemuNotConnectedError';
  }
}

/** QEMU or the flash image is missing from disk. */
export class QemuArtifactMissingError extends Error {
  constructor(
    readonly what: 'qemu' | 'image',
    readonly artifactPath: string,
  ) {
    super(
      what === 'qemu'
        ? `QEMU not found at ${artifactPath} — run: node emulator/qemu/fetch-qemu.mjs`
        : `flash image not found at ${artifactPath} — run: node emulator/qemu/build-qemu-images.mjs cli`,
    );
    this.name = 'QemuArtifactMissingError';
  }
}

/**
 * Every boot attempt failed.
 *
 * `attempts` and `reasons` are carried because the interesting question is
 * never "did it fail" but "did it fail the same way every time" — a run of
 * eight cache errors is ISSUE-20260823-022, and one cache error followed by
 * seven "image not bootable" is something else.
 */
export class QemuBootFailedError extends Error {
  constructor(
    readonly attempts: number,
    readonly reasons: readonly string[],
    /**
     * The full per-attempt log, so a caller measuring ISSUE-20260823-022 sees
     * the failures as well as the successes.
     *
     * Typed loosely to keep `errors.ts` free of an import from `session.ts`,
     * which imports from here. `BootAttempt[]` is what is actually passed.
     */
    readonly log: readonly { attempt: number; ok: boolean; reason?: string; ms: number }[] = [],
  ) {
    super(
      `QEMU failed to reach the firmware boot banner in ${String(attempts)} attempt(s): ` +
        reasons.map((r, i) => `#${String(i + 1)} ${r}`).join('; '),
    );
    this.name = 'QemuBootFailedError';
  }
}

/**
 * The guest panicked while a command was in flight.
 *
 * Distinct from a timeout on purpose: a panic means the firmware is gone and
 * retrying the command against this session is pointless.
 */
export class QemuGuestPanicError extends Error {
  constructor(readonly panicText: string) {
    super(`the guest panicked: ${panicText}`);
    this.name = 'QemuGuestPanicError';
  }
}

/** A command was acknowledged by nothing within the timeout. */
export class QemuCommandTimeoutError extends Error {
  constructor(
    readonly line: string,
    readonly timeoutMs: number,
  ) {
    super(`no completion barrier for "${line}" within ${String(timeoutMs)} ms`);
    this.name = 'QemuCommandTimeoutError';
  }
}

/** A command word or argument the serial CLI cannot express. */
export class QemuUnsupportedCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`"${command}" cannot be sent over the serial CLI: ${reason}`);
    this.name = 'QemuUnsupportedCommandError';
  }
}
