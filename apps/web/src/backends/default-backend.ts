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
   */
  readonly labHost: 'qemu' | 'sim' | 'unknown' | 'absent';
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
