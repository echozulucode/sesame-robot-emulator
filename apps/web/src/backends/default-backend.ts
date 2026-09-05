/**
 * Which backend the app opens on — Phase 4 W8.
 *
 * > *"The QEMU should be the default."*
 *
 * The literal reading of that is one word in `useState`, and it is wrong in one
 * arrangement this repository ships: `just dev-sim` runs a lab host whose
 * backend is the **behavioural simulator**, and `pnpm demo:web` serves the app
 * from the bridge with no lab host behind it at all. An app that hard-coded
 * `qemu` would sit in an error state in the first case while a perfectly good
 * robot answered on the same origin, and in the second it would show a failure
 * with no explanation — which is a problem a user of this project has already
 * reported once.
 *
 * So the default is **detected, with QEMU as the answer whenever nothing says
 * otherwise**:
 *
 * ```text
 * GET /lab/session  ->  { "backend": "sim",  ... }   ->  sim   (a lab host, running the model)
 *                   ->  { "backend": "qemu", ... }   ->  qemu  (a lab host, running the emulator)
 *                   ->  anything else that parses    ->  qemu  (a lab host that did not say)
 *                   ->  404 / network error          ->  qemu, AND `labHost: 'absent'`
 * ```
 *
 * The last row is the one worth being careful about. **It does not fall back to
 * the simulator**, and that is deliberate rather than lazy: this app's whole
 * posture is that a host model may never be substituted for an emulator without
 * saying so. Quietly landing on `sim` because the emulator was unreachable
 * would be exactly that substitution, and the reader would have no way to tell
 * a booted emulator from a model wearing its name. Staying on QEMU and
 * reporting `absent` is what makes {@link LabHostProbe.labHost} something the
 * UI can turn into the existing "no lab host is answering" guidance.
 *
 * Nothing here decides anything a backend already knows. `QemuBackend` reports
 * the same absence in `status.detail` a moment later; this exists so the
 * *default selection* is made from what the host offers rather than from a
 * constant, and so the guidance appears immediately rather than after a failed
 * poll.
 */
import type { BackendId } from './types.js';

/**
 * The backend chosen when no lab host answers.
 *
 * A constant rather than an inline literal because two tests and the UI's
 * guidance all have to agree about it, and because the user's sentence is a
 * product decision worth being able to point at.
 */
export const DEFAULT_BACKEND: BackendId = 'qemu';

/** What a `/lab/session` probe concluded. */
export interface LabHostProbe {
  /** The backend to open on. */
  readonly backend: BackendId;
  /**
   * - `qemu` / `sim` — a lab host answered and named its backend
   * - `unknown` — a lab host answered but named a backend this app has no arm
   *   for. Reported rather than mapped: a fourth backend on the host is a fact
   *   about the host, not a reason to guess.
   * - `absent` — nothing answered `/lab/session`. The UI shows the "no lab
   *   host" guidance in this state, and it is the ONLY state that does.
   * - `desktop` — Phase 5 T1. There is no lab host and none is expected: this
   *   page is inside the Tauri desktop shell, and that build has **no emulator
   *   backend**. Distinct from `absent` precisely so the "start a lab host"
   *   guidance stays off — that advice is unactionable in a packaged `.exe` —
   *   and so a line naming the behavioural simulator appears instead. **T4 gave
   *   the shell an emulator**, so this state is not reached in the build that
   *   ships; it remains the correct answer for one that has none. See
   *   {@link desktopSimulatorProbe}.
   */
  readonly labHost: 'qemu' | 'sim' | 'unknown' | 'absent' | 'desktop';
  /** One sentence, shown verbatim where the guidance appears. */
  readonly detail: string;
}

/**
 * Read a `/lab/session` document and say what to open on.
 *
 * Pure, total and given the parsed JSON rather than a `Response`, so the three
 * interesting rows of the table above are unit-testable without a server.
 * `session` is deliberately `unknown`: it is a foreign document.
 */
export function backendFromSession(session: unknown): LabHostProbe {
  const named =
    typeof session === 'object' && session !== null && 'backend' in session
      ? (session as { backend?: unknown }).backend
      : undefined;
  if (named === 'sim') {
    return {
      backend: 'sim',
      labHost: 'sim',
      detail:
        'The lab host on this origin is running the behavioural simulator (--backend sim), so ' +
        'that is what this page opened on. Nothing here is the emulator.',
    };
  }
  if (named === 'qemu') {
    return {
      backend: 'qemu',
      labHost: 'qemu',
      detail: 'The lab host on this origin is running real firmware under QEMU.',
    };
  }
  return {
    backend: DEFAULT_BACKEND,
    labHost: 'unknown',
    detail:
      `A lab host answered /lab/session but named backend ${JSON.stringify(named)}, which this ` +
      `app has no arm for. It opened on ${DEFAULT_BACKEND}, which is the default.`,
  };
}

/** What {@link probeLabHost} answers with when nothing is there. */
export function labHostAbsent(baseUrl: string, why: string): LabHostProbe {
  return {
    backend: DEFAULT_BACKEND,
    labHost: 'absent',
    detail:
      `No lab host answered ${baseUrl}/lab/session (${why}). QEMU is the default and this page ` +
      'stayed on it rather than quietly substituting the host model for the emulator.',
  };
}

/**
 * Ask the origin what is behind it.
 *
 * `fetchImpl` is a parameter so the three branches are testable without a
 * network; the app passes nothing and gets `globalThis.fetch`.
 */
export async function probeLabHost(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LabHostProbe> {
  const root = baseUrl.replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${root}/lab/session`, { cache: 'no-store' });
    if (!response.ok) return labHostAbsent(root, `HTTP ${String(response.status)}`);
    return backendFromSession(await response.json());
  } catch (error) {
    return labHostAbsent(root, error instanceof Error ? error.message : String(error));
  }
}

/*
 * ---------------------------------------------------------------------------
 * The THIRD case: this page is inside the Tauri desktop shell — Phase 5 T1.
 * ---------------------------------------------------------------------------
 *
 * Everything above is unchanged, and deliberately so. W8's rule — *an
 * unreachable lab host stays on QEMU and says so, rather than quietly
 * substituting the host model* — is not weakened here, because the desktop
 * shell is not an unreachable lab host. It is a **different arrangement**:
 * there is no origin to probe, there never will be one, and `just dev`'s
 * guidance ("start `node apps/web/server/lab-host.mjs`") is advice a reader of
 * a packaged `.exe` cannot act on and should not be shown.
 *
 * ```text
 * window.__TAURI__ absent   ->  probe /lab/session   ->  the table above, unchanged
 * window.__TAURI__ present  ->  no probe at all      ->  sim, ANNOUNCED
 * ```
 *
 * The announcement is the whole point. Selecting the simulator silently would
 * be the substitution this project refuses; selecting it while
 * `labHost: 'desktop'` drives a visible line on the trust panel — and while the
 * status line already reads `SYSTEM: HOST MODEL · PHYSICAL HARDWARE: NONE`,
 * because it derives that from the driving origin rather than from a
 * constant — is the app telling the reader exactly what it did.
 *
 * **This was a seam, and T4 flipped it.** {@link TAURI_EMULATOR_BACKEND} is now
 * `'qemu'`, so `selectsSimulator` is false, the desktop shell opens on the
 * emulator, and the announcement below is no longer reachable —
 * `desktop-simulator.test.ts` asserted that this is what flipping the constant
 * would do, before the backend on the other side existed, and it is what it
 * did.
 *
 * {@link desktopSimulatorProbe} is kept rather than deleted, and so is its
 * branch: it is the correct thing to render for *any* desktop build with no
 * emulator behind it, which is what setting the constant back to `null` would
 * produce. Deleting it would make that state silently indistinguishable from a
 * booted emulator.
 */

/**
 * The backend a Tauri build opens on.
 *
 * **`'qemu'` since Phase 5 T4** — `TauriBackend`, over `TauriSesameRobot`, over
 * the Rust supervisor and the bundled QEMU. T1 left this `null` and everything
 * else was already written to follow it: `selectsSimulator` goes false,
 * `initialBackend()` returns the emulator, and {@link desktopSimulatorProbe}
 * stops being reached, so the "this is the behavioural simulator" line stops
 * rendering because it has stopped being true.
 *
 * `'qemu'` rather than a fourth `BackendId`, deliberately. What is behind the
 * wire is the same thing the browser path has: real firmware under Espressif's
 * QEMU, commanded over the firmware's own serial console. The difference is
 * only *who owns the process* — a lab host on an origin, or this app — and
 * `App.tsx` is where that is decided, in one line, next to the other backend
 * arms. A new id would have meant teaching the rail, the trace panel and W8's
 * default about a distinction the reader does not have.
 */
export const TAURI_EMULATOR_BACKEND: BackendId | null = 'qemu';

/** What {@link detectDesktopShell} concluded about the runtime. */
export interface DesktopShell {
  /** True when this page is inside the Tauri webview. */
  readonly present: boolean;
  /** {@link TAURI_EMULATOR_BACKEND}, repeated so a test can inject it. */
  readonly emulatorBackend: BackendId | null;
  /**
   * True when the desktop shell must open on the simulator *and say so*: it is
   * present, and it has no emulator backend of its own yet.
   */
  readonly selectsSimulator: boolean;
}

/**
 * Is this page running inside the Tauri desktop shell?
 *
 * Two globals, because only one of them is guaranteed. `__TAURI_INTERNALS__` is
 * injected into every Tauri v2 webview unconditionally; `__TAURI__` exists only
 * while `app.withGlobalTauri` is true in `src-tauri/tauri.conf.json`, which it
 * currently is. Reading both means a later workstream can turn that flag off —
 * and it should, once T4 imports `@tauri-apps/api` properly — without silently
 * turning this detection off with it.
 *
 * `scope` and `emulatorBackend` are parameters so all four combinations are
 * unit-testable in a jsdom that is not, and will never be, a Tauri webview.
 */
export function detectDesktopShell(
  scope: object = globalThis,
  emulatorBackend: BackendId | null = TAURI_EMULATOR_BACKEND,
): DesktopShell {
  const present = '__TAURI_INTERNALS__' in scope || '__TAURI__' in scope;
  return {
    present,
    emulatorBackend,
    selectsSimulator: present && emulatorBackend === null,
  };
}

/**
 * What the app opens on, given the runtime.
 *
 * Outside Tauri this is {@link DEFAULT_BACKEND} and the `/lab/session` probe
 * then corrects it, exactly as W8 built it.
 */
export function initialBackend(shell: DesktopShell): BackendId {
  if (!shell.present) return DEFAULT_BACKEND;
  return shell.emulatorBackend ?? 'sim';
}

/**
 * The announcement, in the same shape the probe answers with.
 *
 * `labHost: 'desktop'` rather than `'absent'`, and the distinction is load
 * bearing: `'absent'` is the state that renders *"No lab host on this origin,
 * so there is no emulator to drive — how to start one"*, and that sentence is
 * false and unactionable in a packaged app. `'desktop'` renders its own line,
 * which names the behavioural simulator instead.
 */
export function desktopSimulatorProbe(): LabHostProbe {
  return {
    backend: 'sim',
    labHost: 'desktop',
    detail:
      'This is the Sesame Robot Emulator desktop app, which has no emulator backend yet, so it opened on ' +
      'the BEHAVIOURAL SIMULATOR — a host model of the robot running in this window. Nothing ' +
      'here is the emulator and nothing here is hardware. Run `just dev` in the repository for ' +
      'real firmware under QEMU.',
  };
}
