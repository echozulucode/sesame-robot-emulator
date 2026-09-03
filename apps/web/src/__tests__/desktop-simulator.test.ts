/**
 * The desktop shell picks the simulator, and says so — Phase 5 T1.
 *
 * W8 made QEMU the default and made one rule about it that is not negotiable:
 * **an unreachable lab host stays on QEMU and reports `absent`**, because
 * quietly landing on the host model would leave a reader with no way to tell a
 * booted emulator from a model wearing its name. `default-backend.test.ts`
 * asserts that rule and this file does not touch it.
 *
 * The desktop shell is a *third* case rather than an exception to it. There is
 * no origin behind a packaged `.exe`, no lab host to start, and — until T4 —
 * no emulator at all. So it opens on the simulator, and the price of doing that
 * on the reader's behalf is that it must be announced. Both halves are asserted
 * here: the selection, and the announcement.
 *
 * The last block is the seam. T4 sets `TAURI_EMULATOR_BACKEND` to the id of its
 * `TauriSesameRobot` and every branch has to follow — including the
 * announcement, which must then stop appearing, because it will no longer be
 * true. Asserting that with the constant injected means the seam is exercised
 * before the backend on the other side of it exists.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKEND,
  desktopSimulatorProbe,
  detectDesktopShell,
  initialBackend,
  TAURI_EMULATOR_BACKEND,
  labHostAbsent,
} from '../backends/default-backend.js';

/** A plain object standing in for `globalThis`, so nothing is monkey-patched. */
const browser = {};
const tauriV2 = { __TAURI_INTERNALS__: {} };
/** `withGlobalTauri: true` in `src-tauri/tauri.conf.json` produces this one. */
const tauriGlobal = { __TAURI__: {} };

describe('detecting the desktop shell', () => {
  it('an ordinary browser is not one', () => {
    expect(detectDesktopShell(browser).present).toBe(false);
  });

  it('reads `__TAURI_INTERNALS__`, which every Tauri v2 webview has', () => {
    expect(detectDesktopShell(tauriV2).present).toBe(true);
  });

  it('reads `__TAURI__` too, so turning `withGlobalTauri` off cannot silently disable it', () => {
    expect(detectDesktopShell(tauriGlobal).present).toBe(true);
  });

  it('does not select the simulator in a browser, however the constant is set', () => {
    expect(detectDesktopShell(browser, null).selectsSimulator).toBe(false);
    expect(detectDesktopShell(browser, 'qemu').selectsSimulator).toBe(false);
  });
});

describe('what the app opens on', () => {
  it('in a browser: the W8 default, corrected by the /lab/session probe', () => {
    expect(initialBackend(detectDesktopShell(browser))).toBe(DEFAULT_BACKEND);
    expect(DEFAULT_BACKEND).toBe('qemu');
  });

  it('in the desktop shell with no emulator backend: the simulator', () => {
    expect(initialBackend(detectDesktopShell(tauriV2))).toBe('sim');
  });

  it('T1 really does ship with no emulator backend', () => {
    expect(TAURI_EMULATOR_BACKEND).toBeNull();
  });
});

describe('and it says so — the announcement is the price of choosing', () => {
  const probe = desktopSimulatorProbe();

  it('names the behavioural simulator in words', () => {
    expect(probe.backend).toBe('sim');
    expect(probe.detail).toMatch(/behavioural simulator/i);
  });

  it('denies both of the things a reader might otherwise assume', () => {
    expect(probe.detail).toMatch(/nothing here is the emulator/i);
    expect(probe.detail).toMatch(/nothing here is hardware/i);
  });

  it('is `desktop`, NOT `absent` — so the unactionable "start a lab host" line stays off', () => {
    expect(probe.labHost).toBe('desktop');
    expect(labHostAbsent('http://127.0.0.1:8099', 'x').labHost).toBe('absent');
  });
});

describe("W8's rule is untouched", () => {
  it('an unreachable lab host in a BROWSER still stays on QEMU', () => {
    const absent = labHostAbsent('http://127.0.0.1:5173', 'HTTP 404');
    expect(absent.backend).toBe('qemu');
    expect(absent.labHost).toBe('absent');
  });

  it('the desktop branch cannot fire outside Tauri, which is the only reason it is safe', () => {
    // If this ever passed, an ordinary page that failed to reach a lab host
    // could reach the simulator through the new door instead of the old rule.
    expect(detectDesktopShell(browser).selectsSimulator).toBe(false);
    expect(initialBackend(detectDesktopShell(browser))).not.toBe('sim');
  });
});

describe('the seam T4 replaces', () => {
  it('an emulator backend takes over the selection', () => {
    const shell = detectDesktopShell(tauriV2, 'qemu');
    expect(shell.selectsSimulator).toBe(false);
    expect(initialBackend(shell)).toBe('qemu');
  });

  it('and with it the announcement, because it stops being true', () => {
    // The UI renders the line off `labHost === 'desktop'`, which only
    // `desktopSimulatorProbe()` produces and which App.tsx only reaches through
    // `selectsSimulator`. One constant, one branch, nothing to unpick.
    expect(detectDesktopShell(tauriV2, 'qemu').selectsSimulator).toBe(false);
  });
});
