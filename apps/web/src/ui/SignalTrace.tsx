/**
 * "See the Signal" — the causal ladder for one command.
 *
 * Every row shows four things and none of them is optional:
 *
 * 1. the layer, in causal order (`ui.command` … `visual.joint`);
 * 2. the value;
 * 3. the badge — `OBSERVED FROM EMULATOR` / `SIMULATED` /
 *    `INFERRED FOR EXPLANATION`, decided by `isPhysicallyObserved()` and the
 *    event's `TelemetryOrigin`, never by `provenance === 'observed'`;
 * 4. the **witness**: one clause naming who says so. A badge on its own is a
 *    colour; the witness is the teaching.
 *
 * The `pwm.output` row is the point of the whole feature. It is `inferred` on
 * every backend, forever, and its witness says why: QEMU's LEDC stores duty and
 * emits no waveform, and there is no physical robot to probe. The pulse figure
 * beside it is nonetheless exact — `quantiseCommandedAngle()` runs ESP32Servo's
 * own arithmetic — so the learner sees the number *and* sees that nothing
 * measured it. That is the line between "the code said 135°" and "a servo would
 * have gone there".
 */
import type { ReactElement } from 'react';

import {
  LAYER_MEANING,
  TRACE_LAYERS,
  rowMatchesSelection,
  traceBadge,
  type Trace,
  type TraceRow,
} from '../state/trace-store.js';
import type { SelectionState } from '../state/selection.js';
import { OriginTag } from './ProvenanceTag.js';

export interface SignalTraceProps {
  readonly trace: Trace | null;
  readonly traces: readonly Trace[];
  readonly selection: SelectionState;
  readonly onSelectRow: (row: TraceRow) => void;
  readonly onSelectTrace: (id: string) => void;
}

const MATCH_NOTE: Readonly<Record<TraceRow['match'], string>> = {
  'app-local': 'created by this app, not adopted from a stream',
  'trace-id':
    'the event carried this trace’s id end to end, so the link to your click is causal, not guessed',
  'time-window':
    'matched by arrival time only — the firmware has no trace-id field, so nothing could carry one ' +
    'across UART0. This is correlation, not causation.',
};

export function SignalTrace(props: SignalTraceProps): ReactElement {
  const { trace, traces, selection, onSelectRow, onSelectTrace } = props;

  return (
    <section className="panel trace-panel" data-testid="signal-trace">
      <header className="panel-header">
        <h2>See the Signal</h2>
        <span className="panel-sub">
          {trace === null ? 'run a command' : `${trace.rows.length} rows · ${trace.id}`}
        </span>
      </header>

      {traces.length > 1 && (
        <div className="trace-tabs">
          {traces.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === trace?.id ? 'active' : ''}
              data-trace={t.id}
              onClick={() => onSelectTrace(t.id)}
            >
              {t.command}
            </button>
          ))}
        </div>
      )}

      {trace === null ? (
        <p className="note muted" data-testid="trace-empty">
          Press a command. One trace id is minted here and threaded as far as the transport allows;
          every layer it crosses gets a row, and every row says whether anything observed it.
        </p>
      ) : (
        <>
          <div className="trace-correlation" data-testid="trace-correlation">
            {trace.carriedTraceId ? (
              <>
                <b>Causal.</b> Events came back carrying <code>{trace.id}</code>, so these rows are
                joined to your click by id.
              </>
            ) : (
              <>
                <b>Correlated, not causal.</b> {trace.windowAdopted} event
                {trace.windowAdopted === 1 ? '' : 's'} were matched to <code>{trace.id}</code> by
                arrival time. The firmware has no trace-id field — nothing can carry one across
                UART0 into the guest — so on this backend the join is a time window and is labelled
                as one on every row.
              </>
            )}
          </div>

          <ol className="trace-rows" data-testid="trace-rows">
            {trace.rows.map((row) => {
              const badge = traceBadge(row);
              const hit = rowMatchesSelection(row, selection);
              return (
                <li
                  key={row.id}
                  className={`trace-row trace-tone-${badge.tone}${hit ? ' hit' : ''}`}
                  data-trace-row={row.id}
                  data-layer={row.layer}
                  data-rank={row.rank}
                  data-joint={row.joint ?? ''}
                  data-provenance={row.provenance}
                  data-origin-kind={row.origin?.kind ?? ''}
                  data-badge={badge.text}
                  data-match={row.match}
                  data-physically-observed={String(row.physicallyObserved)}
                  onClick={() => onSelectRow(row)}
                  title={LAYER_MEANING[row.layer]}
                >
                  <div className="trace-row-head">
                    <code className="trace-layer">{row.layer}</code>
                    <span className="trace-label">{row.label}</span>
                    <span className={`prov prov-${badge.tone} trace-badge`}>{badge.text}</span>
                  </div>
                  <div className="trace-row-detail">{row.detail}</div>
                  <div className="trace-row-witness">
                    <span className="trace-witness-key">who says so</span> {row.witness}
                  </div>
                  <div className="trace-row-meta">
                    <OriginTag origin={row.origin} />
                    <span className={`trace-match trace-match-${row.match}`} title={MATCH_NOTE[row.match]}>
                      {row.match}
                    </span>
                    <span className="dim">+{row.tMs.toFixed(0)} ms</span>
                    {row.seq !== null && <span className="dim">seq {row.seq}</span>}
                    {row.updates > 1 && <span className="dim">×{row.updates}</span>}
                    {row.sourceRef !== null && (
                      <code className="dim trace-source">
                        {row.sourceRef.file}:{row.sourceRef.line}
                      </code>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <details className="trace-legend">
            <summary>what each layer is</summary>
            <dl className="kv">
              {TRACE_LAYERS.map((layer) => (
                <div key={layer}>
                  <dt>
                    <code>{layer}</code>
                  </dt>
                  <dd className="small">{LAYER_MEANING[layer]}</dd>
                </div>
              ))}
            </dl>
            <p className="note muted">
              No row will ever read <b>OBSERVED ON HARDWARE</b>. That branch exists in the code and
              is decided by <code>isPhysicallyObserved()</code>, which requires{' '}
              <code>origin.kind === &apos;physical-robot&apos;</code>. This project will never run on
              physical hardware, so the predicate is permanently false — which is a property, not a
              gap waiting to be filled.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
