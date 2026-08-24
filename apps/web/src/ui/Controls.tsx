/**
 * Backend switch, provenance banner, and the command vocabulary.
 *
 * Every button on this panel is generated from `COMMAND_VOCABULARY` and
 * `FACE_CATALOG` in `@sesame-lab/sesame-protocol`, which are themselves a
 * checked mirror of `hardware/hardware-map.json` (`catalog-drift.test.ts`
 * re-derives every entry and fails if they disagree). So the vocabulary a
 * learner sees is the firmware's vocabulary, and a hand-typed list cannot drift
 * away from it — including the parts nobody would have typed, like the fact
 * that `forward`/`backward`/`left`/`right` never clear `currentCommand`.
 */
import { COMMAND_VOCABULARY, FACE_CATALOG, type Provenance } from '@sesame-lab/sesame-protocol';
import type { ReactElement } from 'react';

import type { BackendId, BackendStatus, TelemetryBackend } from '../backends/types.js';
import { PROVENANCE_MEANING, ProvenanceTag } from './ProvenanceTag.js';

export interface ControlsProps {
  readonly backend: TelemetryBackend;
  readonly backendId: BackendId;
  readonly onBackendChange: (id: BackendId) => void;
  readonly bridgeUrl: string;
  readonly onBridgeUrlChange: (url: string) => void;
  readonly status: BackendStatus;
  readonly drivingProvenance: Provenance | null;
  readonly provenanceCounts: Readonly<Record<Provenance, number>>;
  readonly totalEvents: number;
  readonly busy: string | null;
  readonly error: string | null;
  readonly onCommand: (name: string) => void;
  readonly onFace: (name: string) => void;
  readonly onStop: () => void;
}

/** Faces worth one click. The full 38 are in the model; these are the ones with pixels. */
const FACE_SHORTLIST = ['happy', 'sad', 'angry', 'surprised', 'love', 'sleepy', 'confused', 'idle'];

export function Controls(props: ControlsProps): ReactElement {
  const {
    backend,
    backendId,
    onBackendChange,
    bridgeUrl,
    onBridgeUrlChange,
    status,
    drivingProvenance,
    provenanceCounts,
    totalEvents,
    busy,
    error,
    onCommand,
    onFace,
    onStop,
  } = props;

  const commands = COMMAND_VOCABULARY.filter((c) => c.command !== '' && c.command !== 'stop');

  return (
    <section className="panel" data-testid="controls">
      <header className="panel-header">
        <h2>Backend</h2>
        <span className={`conn conn-${status.connection}`} id="conn">
          {status.connection}
        </span>
      </header>

      <div className="backend-switch" role="radiogroup" aria-label="telemetry backend">
        <button
          type="button"
          role="radio"
          aria-checked={backendId === 'sim'}
          className={backendId === 'sim' ? 'active' : ''}
          data-backend="sim"
          onClick={() => onBackendChange('sim')}
        >
          Simulated model
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={backendId === 'bridge'}
          className={backendId === 'bridge' ? 'active' : ''}
          data-backend="bridge"
          onClick={() => onBackendChange('bridge')}
        >
          Bridge WebSocket
        </button>
      </div>

      <p className="note">{backend.description}</p>

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

      <p className="note muted" id="conn-detail">
        {status.detail}
      </p>

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
        <div className="prov-counts" id="prov-counts">
          {(['observed', 'simulated', 'inferred'] as const).map((p) => (
            <span key={p} className={`prov prov-${p}${provenanceCounts[p] === 0 ? ' prov-zero' : ''}`}>
              {p} {provenanceCounts[p]}
            </span>
          ))}
          <span className="dim">{totalEvents} events</span>
        </div>
      </div>

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

      <div className="cmd-grid">
        {commands.map((c) => (
          <button
            key={c.command}
            type="button"
            className={`cmd${c.continuous ? ' cmd-continuous' : ''}`}
            data-command={c.command}
            disabled={!backend.canCommand || busy !== null}
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
          disabled={!backend.canCommand}
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
            disabled={!backend.canCommand || busy !== null}
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
            disabled={!backend.canCommand || busy !== null}
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
