/**
 * `describeRobotContract` against `TauriSesameRobot` — Phase 5 T4's acceptance.
 *
 * > **Acceptance is `describeRobotContract`** — the same 15-case suite QEMU had
 * > to pass, as one more call. No weakened cases. That is what makes this a
 * > backend rather than a special case.
 * > — `docs/plans/phase-5-tauri-desktop-app.md` §5 T4
 *
 * So this file is one call, and nothing in `packages/sesame-api/src/contract/`
 * changed to accommodate it. `packages/sesame-qemu/src/__tests__/contract.test.ts`
 * is the same call for the Node backend; the two are deliberately identical
 * apart from the factory, because the factory is the only injection point the
 * suite has.
 *
 * ## What is actually on the other end
 *
 * The real one. Each case boots the **bundled** QEMU through the **shipped**
 * Rust supervisor — `app.path()`-resolved paths, the twelve-attempt retry past
 * ISSUE-20260823-022, the 192-byte write budget, the job-object teardown — and
 * the bytes it returns go through the **existing** `SesameTelemetryParser`.
 * Nothing is faked, which matters because C01 and C02 assert the firmware's own
 * choreography and no stub could satisfy them.
 *
 * The transport is a pipe rather than an IPC channel, because the suite is Node
 * code (C14 opens a real `node:http` listener) and cannot run inside a WebView2
 * window. `apps/web/src/__tests__/support/stdio-supervisor.ts` and
 * `src-tauri/src/stdio.rs` both state that, and the framing is a bare length
 * prefix so the byte stream stays byte-identical.
 *
 * ## Why it skips rather than fails without a build
 *
 * `src-tauri/target/` is gitignored and building it needs cargo, the bundled
 * QEMU (`node emulator/qemu/fetch-qemu.mjs`) and the flash image
 * (`just qemu-image`). A clone with none of those must still get a green,
 * meaningful `pnpm test`. The skip names the command, loudly, exactly as
 * `packages/sesame-qemu/src/__tests__/helpers.ts` does — a contract suite that
 * reported success because it did not execute would be worse than one that
 * failed.
 */
import { describe, it } from 'vitest';

import { describeRobotContract } from '@sesame-lab/sesame-api/contract';

import { TauriSesameRobot } from '../backends/tauri/robot.js';
import { BUILD_HINT, findDesktopExe, stdioSupervisor } from './support/stdio-supervisor.js';

const DESKTOP_EXE = findDesktopExe();

/**
 * Every case boots an emulator through a freshly spawned desktop binary, and a
 * boot is up to twelve attempts. Vitest has no per-suite timeout on `describe`,
 * so it is applied by wrapping `it` — the same shape `contract.test.ts` uses.
 */
const CASE_TIMEOUT_MS = 300_000;

const SKIP_REASON = DESKTOP_EXE === null ? ` (SKIPPED — run: ${BUILD_HINT})` : '';

describe.skipIf(DESKTOP_EXE === null)(`TauriSesameRobot${SKIP_REASON}`, () => {
  describeRobotContract(
    () =>
      new TauriSesameRobot({
        // The only argument. Everything else — the paths, the machine, the
        // attempt budget, `snapshot=on` — is Rust's, and deliberately not
        // ours to choose: a frontend that could pick its own image could
        // change what `capabilitiesForImage()` reports about pixels it never
        // observed. T3 §3, deviation 2.
        supervisor: stdioSupervisor(DESKTOP_EXE ?? ''),
      }),
    {
      name: 'SesameRobot contract · TauriSesameRobot (real firmware, through the Rust supervisor)',
      runner: {
        describe,
        it: (name, fn) => {
          it(name, { timeout: CASE_TIMEOUT_MS }, fn);
        },
      },
    },
  );
});
