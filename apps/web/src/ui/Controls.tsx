/**
 * Backend switch, provenance banner, and the command vocabulary.
 *
 * ## Two components, one panel's worth of markup
 *
 * This was one `<Controls>` panel in the old third column. The responsive
 * shell splits it in two WITHOUT changing a word of what either half says:
 *
 *  - {@link BackendPanel} — the switch, the connection detail and the
 *    provenance banner (`#prov-banner`, `#origin-banner`,
 *    `#measurement-verdict`). It lives in the dock's inspector section, and a
 *    summary of the same two badges is pinned to the rail, which never
 *    collapses.
 *  - {@link CommandBar} — the command and face vocabulary. It lives on the
 *    STAGE, under the robot, and is therefore reachable at every breakpoint
 *    without opening anything. A button that drives the robot belongs beside
 *    the robot, and `[data-command="wave"]` is what the harness clicks in four
 *    separate phases.
 *
 * Every id, `data-*` attribute and class name below is the one it was before.
 * The split is layout; the provenance surfaces are correctness.
 *
 * Every button on this panel is generated from `COMMAND_VOCABULARY` and
 * `FACE_CATALOG` in `@sesame-lab/sesame-protocol`, which are themselves a
 * checked mirror of `hardware/hardware-map.json` (`catalog-drift.test.ts`
 * re-derives every entry and fails if they disagree). So the vocabulary a
 * learner sees is the firmware's vocabulary, and a hand-typed list cannot drift
 * away from it — including the parts nobody would have typed, like the fact
 * that `forward`/`backward`/`left`/`right` never clear `currentCommand`.
 */
import {
  COMMAND_VOCABULARY,
  FACE_CATALOG,
  type OriginKind,
  type Provenance,
  type TelemetryOrigin,
} from '@sesame-lab/sesame-protocol';
import type { ReactElement } from 'react';

import type { BackendId, BackendStatus, TelemetryBackend } from '../backends/types.js';
import {
  measurementVerdict,
  OriginTag,
  PROVENANCE_MEANING,
  ProvenanceTag,
} from './ProvenanceTag.js';

export interface ControlsProps {
  readonly backend: TelemetryBackend;
  readonly backendId: BackendId;
  readonly onBackendChange: (id: BackendId) => void;
  readonly bridgeUrl: string;
  readonly onBridgeUrlChange: (url: string) => void;
  readonly status: BackendStatus;
  readonly drivingProvenance: Provenance | null;
  /** Which boundary the driving event crossed. Rendered beside the provenance. */
  readonly drivingOrigin: TelemetryOrigin | null;
  readonly provenanceCounts: Readonly<Record<Provenance, number>>;
  readonly originCounts: Readonly<Record<OriginKind, number>>;
  readonly totalEvents: number;
}

/** What the stage's command bar needs, and nothing else. */
export interface CommandBarProps {
  readonly backend: TelemetryBackend;
  readonly status: BackendStatus;
  readonly busy: string | null;
  readonly error: string | null;
  readonly onCommand: (name: string) => void;
  readonly onFace: (name: string) => void;
  readonly onStop: () => void;
}

/**
 * The three backends, and one sentence each on what a button press reaches.
 *
 * Generated rather than hand-placed so the switch cannot grow a fourth arm in
 * the markup and forget it here.
 */
const BACKEND_CHOICES: readonly { id: BackendId; label: string; sub: string }[] = [
  { id: 'sim', label: 'Simulated model', sub: 'a host model, in this tab' },
  { id: 'bridge', label: 'Bridge WebSocket', sub: 'receive-only' },
  { id: 'qemu', label: 'QEMU firmware', sub: 'real firmware, commandable' },
];

/** Faces worth one click. The full 38 are in the model; these are the ones with pixels. */
const FACE_SHORTLIST = ['happy', 'sad', 'angry', 'surprised', 'love', 'sleepy', 'confused', 'idle'];

export function BackendPanel(props: ControlsProps): ReactElement {
  const {
    backend,
    backendId,
    onBackendChange,
    bridgeUrl,
    onBridgeUrlChange,
    status,
    drivingProvenance,
    drivingOrigin,
    provenanceCounts,
    originCounts,
    totalEvents,
  } = props;

  return (
    <section className="panel" data-testid="controls">
      <header className="panel-header">
        <h2>Backend</h2>
        <span className={`conn conn-${status.connection}`} id="conn">
          {status.connection}
        </span>
      </header>

      <div className="backend-switch" role="radiogroup" aria-label="telemetry backend">
        {BACKEND_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={backendId === choice.id}
            className={backendId === choice.id ? 'active' : ''}
            data-backend={choice.id}
            title={choice.sub}
            onClick={() => onBackendChange(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <p className="note">{backend.description}</p>

      {backendId === 'qemu' && status.connection === 'connecting' && (
        <div className="warn" data-testid="qemu-connecting">
          <strong>Booting real firmware — this takes 2 to 17 seconds.</strong>
          <p>
            {status.detail}
            {(status.attempts ?? 1) > 1 && (
              <>
                {' '}
                <b>
                  Attempt {status.attempts}: {(status.attempts ?? 1) - 1} earlier boot(s) panicked
                  inside QEMU’s cache model and were relaunched (ISSUE-20260823-022).
                </b>
              </>
            )}
          </p>
        </div>
      )}

      {backendId === 'bridge' && (
        <label className="field">
          <span>bridge URL</span>
          <input
            type="text"
            value={bridgeUrl}
            spellCheck={false}
            onChange={(e) => onBridgeUrlChange(e.target.value)}
            id="bridge-url"
          />
        </label>
      )}

      {backendId === 'qemu' && status.connection === 'error' && (
        <div className="warn" data-testid="qemu-unreachable">
          <strong>No lab host is answering.</strong>
          <p>{status.detail}</p>
          <p className="muted">
            The emulator runs in a Node process, not in this tab: it spawns{' '}
            <code>qemu-system-xtensa</code> and opens a TCP socket for UART0. Start it with{' '}
            <code>node apps/web/server/lab-host.mjs</code>, which serves this page and puts the
            firmware’s own ten HTTP routes in front of the running guest.
          </p>
        </div>
      )}

      <p className="note muted" id="conn-detail">
        {status.detail}
      </p>

      {/*
        Two badges, never one. `provenance` says how much epistemic weight an
        event carries; `origin` says which boundary it crossed. Only the second
        distinguishes an emulated servo write from a measurement, which is why
        the verdict line below is computed with `isPhysicallyObserved()` and
        never by comparing `provenance === 'observed'`.
      */}
      <div className={`prov-banner prov-${drivingProvenance ?? 'none'}`} id="prov-banner">
        <div className="prov-banner-head">
          <span>this scene is being driven by</span>
          {drivingProvenance === null ? (
            <span className="prov prov-none prov-lg">nothing yet</span>
          ) : (
            <ProvenanceTag value={drivingProvenance} size="lg" />
          )}
        </div>
        <p>{drivingProvenance === null ? 'No event has moved a joint yet.' : PROVENANCE_MEANING[drivingProvenance]}</p>
        <div className="prov-banner-head" id="origin-banner">
          <span>which crossed</span>
          <OriginTag origin={drivingOrigin} />
        </div>
        <p id="measurement-verdict">{measurementVerdict(drivingProvenance, drivingOrigin)}</p>
        <div className="prov-counts" id="prov-counts">
          {(['observed', 'simulated', 'inferred'] as const).map((p) => (
            <span key={p} className={`prov prov-${p}${provenanceCounts[p] === 0 ? ' prov-zero' : ''}`}>
              {p} {provenanceCounts[p]}
            </span>
          ))}
          <span className="dim">{totalEvents} events</span>
        </div>
        <div className="prov-counts" id="origin-counts">
          {(['physical-robot', 'emulator', 'host-model', 'replay', 'unknown'] as const).map((k) => (
            <span
              key={k}
              className={`prov origin origin-${k}${originCounts[k] === 0 ? ' prov-zero' : ''}`}
            >
              {k} {originCounts[k]}
            </span>
          ))}
        </div>
      </div>

    </section>
  );
}

/**
 * The command vocabulary, on the stage.
 *
 * Generated from `COMMAND_VOCABULARY` and `FACE_CATALOG`, exactly as before —
 * a hand-typed list cannot drift away from `hardware/hardware-map.json`, and
 * that includes the parts nobody would have typed, like the fact that the two
 * ⚠ faces have zero frames and draw nothing at all.
 */
export function CommandBar(props: CommandBarProps): ReactElement {
  const { backend, status, busy, error, onCommand, onFace, onStop } = props;

  const commands = COMMAND_VOCABULARY.filter((c) => c.command !== '' && c.command !== 'stop');

  // A backend that has not finished connecting cannot run anything, and on the
  // QEMU path saying so matters: the lab host answers a command posted mid-boot
  // with 503, and a button that looks live but is not is worse than one that is
  // visibly waiting. The emulator takes 2-17 s to boot.
  const ready = status.connection === 'connected';
  const commandsDisabled = !backend.canCommand || !ready || busy !== null;

  return (
    <section className="panel command-bar" data-testid="command-bar">
      <header className="panel-header">
        <h2>Commands</h2>
        <span className="panel-sub">from hardware-map.json, not hardcoded</span>
      </header>

      {!backend.canCommand && (
        <div className="warn" data-testid="read-only-warning">
          <strong>This backend is receive-only.</strong>
          <p>{backend.commandUnavailableReason}</p>
        </div>
      )}

      {backend.canCommand && !ready && (
        <p className="note muted" data-testid="commands-not-ready">
          Commands are disabled until the backend is connected — it is{' '}
          <code>{status.connection}</code>. Posting a command to an emulator that has not finished
          booting gets a <code>503</code>, and a button that looks live but is not teaches the wrong
          thing about what is happening.
        </p>
      )}

      <div className="cmd-grid">
        {commands.map((c) => (
          <button
            key={c.command}
            type="button"
            className={`cmd${c.continuous ? ' cmd-continuous' : ''}`}
            data-command={c.command}
            disabled={commandsDisabled}
            onClick={() => onCommand(c.command)}
            title={
              c.movementFunction === null
                ? c.command
                : `${c.movementFunction}()${c.continuous ? ' — never clears currentCommand, so loop() repeats it' : ''}`
            }
          >
            {c.command}
          </button>
        ))}
        <button
          type="button"
          className="cmd cmd-stop"
          data-command="stop"
          disabled={!backend.canCommand || !ready}
          onClick={onStop}
          title="/cmd?stop= just clears currentCommand — and notably does NOT call exitIdle()"
        >
          stop
        </button>
      </div>

      <div className="cmd-grid faces">
        {FACE_SHORTLIST.map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face"
            data-face={name}
            disabled={commandsDisabled}
            onClick={() => onFace(name)}
          >
            {name}
          </button>
        ))}
        {['stand', 'default'].map((name) => (
          <button
            key={name}
            type="button"
            className="cmd cmd-face cmd-broken"
            data-face={name}
            disabled={commandsDisabled}
            onClick={() => onFace(name)}
            title={`setFace("${name}") draws nothing — the bitmap is weak-undefined. ISSUE-20260823-004`}
          >
            {name} ⚠
          </button>
        ))}
      </div>

      <p className="note muted">
        {FACE_CATALOG.length} faces are registered in the firmware; the two marked ⚠ have zero frames and
        draw nothing at all.
      </p>

      {busy !== null && (
        <p className="note" id="busy">
          running <code>{busy}</code>…
        </p>
      )}
      {error !== null && (
        <p className="warn-inline" id="cmd-error">
          {error}
        </p>
      )}
    </section>
  );
}
