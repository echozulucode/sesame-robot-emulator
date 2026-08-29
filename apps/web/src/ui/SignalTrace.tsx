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
 *
 * ===========================================================================
 * A SEQUENCE, NOT A COLLECTION OF CARDS — Phase 4 W5
 * ===========================================================================
 *
 * > *"Do not immediately turn every trace row into a generic card. The ordering
 * > and common fields are part of the trace's meaning."*
 *
 * The brief describes this pane as "eight layered rows". **Measured, one wave
 * renders 36 rows and 10,285 px of scroll** — because four of the eight layers
 * (`servo.target`, `pwm.output`, `joint.target`, `visual.joint`) emit one row
 * per joint, and three of those four repeat a *byte-identical* witness eight
 * times. The `pwm.output` witness alone is 640 characters, drawn eight times,
 * 439 px a copy. Nothing on screen said those eight boxes were one rung of a
 * ladder, so the ladder was the one thing the ladder did not show.
 *
 * So the list is **grouped by layer into numbered STEPS**, and the step is the
 * unit the eye lands on:
 *
 *   - one `<li class="trace-step">` per layer, in causal order, carrying the
 *     step number, the layer name, {@link LAYER_MEANING} (which until now
 *     existed only as a `title` attribute and inside a closed `<details>`), and
 *     the layer's badge when every lane in it agrees;
 *   - the witness is **hoisted to the step when every lane's witness is the
 *     same string**, and stays on the lane when they differ — a data question,
 *     answered from the data, not a rule about which layers are allowed one;
 *   - each original row is still a `<li class="trace-row" data-trace-row>`
 *     lane inside its step, carrying every attribute it carried before.
 *
 * **Nothing is dropped.** The brief's list of fields that must survive at every
 * width — step/layer, event name, primary value, provenance, origin, complete
 * witness sentence — is exactly what {@link REQUIRED_FIELDS} names in the
 * harness, and all six are laid out in all three bands.
 */
import type { ReactElement, ReactNode } from 'react';

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

/**
 * One rung of the ladder: every consecutive row that shares a layer.
 *
 * Built by a linear scan rather than a `Map`, because `trace.rows` is already
 * sorted into causal order by `LAYER_RANK` and re-grouping it through a map
 * would throw that order away and then have to reconstruct it — which is the
 * shape of bug this pane exists to make visible.
 */
interface TraceStep {
  readonly layer: TraceRow['layer'];
  readonly rank: number;
  /** 1-based position in the ladder, which is what the reader is shown. */
  readonly step: number;
  readonly rows: readonly TraceRow[];
  /** The badge every lane agrees on, or `null` when they do not. */
  readonly badge: { readonly text: string; readonly tone: string } | null;
  /** The witness every lane repeats verbatim, or `null` when they differ. */
  readonly sharedWitness: string | null;
}

export function buildSteps(rows: readonly TraceRow[]): readonly TraceStep[] {
  const steps: TraceStep[] = [];
  let current: TraceRow[] = [];
  const flush = (): void => {
    const first = current[0];
    if (first === undefined) return;
    const lanes = current;
    const badges = lanes.map((r) => traceBadge(r));
    const firstBadge = badges[0];
    const unanimous =
      firstBadge !== undefined && badges.every((b) => b.text === firstBadge.text)
        ? { text: firstBadge.text, tone: firstBadge.tone }
        : null;
    const witness = lanes.every((r) => r.witness === first.witness) ? first.witness : null;
    steps.push({
      layer: first.layer,
      rank: first.rank,
      step: steps.length + 1,
      rows: lanes,
      badge: unanimous,
      sharedWitness: witness,
    });
    current = [];
  };
  for (const row of rows) {
    const open = current[0];
    if (open !== undefined && open.layer !== row.layer) flush();
    current.push(row);
  }
  flush();
  return steps;
}

/** `01`, `02`, … — the step, which is not a channel and is not a count. */
const stepNumber = (n: number): string => String(n).padStart(2, '0');

function Witness(props: { readonly children: ReactNode; readonly shared: boolean }): ReactElement {
  return (
    <div
      className="trace-row-witness"
      data-field="witness"
      data-witness-scope={props.shared ? 'step' : 'lane'}
    >
      <span className="trace-witness-key">who says so</span> {props.children}
    </div>
  );
}

export function SignalTrace(props: SignalTraceProps): ReactElement {
  const { trace, traces, selection, onSelectRow, onSelectTrace } = props;
  const steps = trace === null ? [] : buildSteps(trace.rows);

  return (
    <section className="panel trace-panel" data-testid="signal-trace">
      <header className="panel-header">
        <h2 className="panel-title-echo">See the Signal</h2>
        <span className="panel-sub">
          {trace === null
            ? 'run a command'
            : `${steps.length} steps · ${trace.rows.length} rows · ${trace.id}`}
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

          {/*
            The column head. It is `aria-hidden` and only laid out at the wide
            band: below it, the lane is two lines rather than four columns and a
            header would name tracks that are not there. The lanes and this row
            share one track list (`--trace-lane-cols`), which is what the
            harness measures when it asserts that the words sit over the fields
            they name.
          */}
          <div className="trace-columns" data-testid="trace-columns" aria-hidden="true">
            <span data-col="event">event</span>
            <span data-col="value">value</span>
            <span data-col="says">provenance · origin</span>
            <span data-col="witness">witness</span>
          </div>

          <ol className="trace-rows" data-testid="trace-rows">
            {steps.map((step) => {
              const stepHit = step.rows.some((row) => rowMatchesSelection(row, selection));
              return (
                <li
                  key={step.layer}
                  className={`trace-step${stepHit ? ' hit' : ''}`}
                  data-trace-step={step.layer}
                  data-step={step.step}
                  data-rank={step.rank}
                  data-lanes={step.rows.length}
                  data-badge={step.badge?.text ?? ''}
                  data-witness-shared={String(step.sharedWitness !== null)}
                >
                  <div className="trace-step-head">
                    <span className="trace-step-no" aria-label={`step ${String(step.step)} of ${String(steps.length)}`}>
                      {stepNumber(step.step)}
                    </span>
                    <code className="trace-layer">{step.layer}</code>
                    {/*
                      LAYER_MEANING was a `title` and a line inside a closed
                      `<details>`. A ladder whose rungs do not say what they are
                      is a list of jargon, so it is rendered.
                    */}
                    <span className="trace-step-meaning">{LAYER_MEANING[step.layer]}</span>
                    {/*
                      The step's badge is drawn only when the step has more than
                      one lane. On a one-lane step the lane IS the step, and the
                      badge beside the layer name and the badge on the lane six
                      pixels below it are the same claim printed twice — which
                      is the density the brief is complaining about, not a
                      second correctness surface. The lane's badge is the one
                      that stays, because it is the one attached to a value.
                    */}
                    {step.badge !== null && step.rows.length > 1 && (
                      <span className={`prov prov-${step.badge.tone} trace-badge`} data-badge-scope="step">
                        {step.badge.text}
                      </span>
                    )}
                    {step.rows.length > 1 && (
                      <span className="trace-step-count">
                        {step.rows.length} rows, one per joint
                      </span>
                    )}
                  </div>

                  {step.sharedWitness !== null && <Witness shared>{step.sharedWitness}</Witness>}

                  <ol className="trace-lanes">
                    {step.rows.map((row) => {
                      const badge = traceBadge(row);
                      const hit = rowMatchesSelection(row, selection);
                      return (
                        <li
                          key={row.id}
                          className={`trace-row trace-tone-${badge.tone}${hit ? ' hit' : ''}`}
                          data-trace-row={row.id}
                          data-layer={row.layer}
                          data-rank={row.rank}
                          data-step={step.step}
                          data-joint={row.joint ?? ''}
                          data-provenance={row.provenance}
                          data-origin-kind={row.origin?.kind ?? ''}
                          data-badge={badge.text}
                          data-match={row.match}
                          data-physically-observed={String(row.physicallyObserved)}
                          onClick={() => onSelectRow(row)}
                          /*
                            THE KEYBOARD PATH TO A TRACE ROW — Phase 4 W6.

                            The other of the two pointer-only families the
                            `cursor: pointer` scan found. Clicking a lane is how
                            the ladder drives the other three panes — it is the
                            cross-linking that phase 8 calls the point of the
                            feature — and until now 36 of them were reachable
                            only with a mouse.

                            `role="button"` on the `<li>` rather than a nested
                            `<button>`: `.trace-row` IS the three-track grid
                            W5 built, and wrapping its six lane children in a
                            button would have replaced that grid with a button's
                            own box. The `<li>` keeps every data attribute the
                            harness reads.
                          */
                          role="button"
                          tabIndex={0}
                          aria-pressed={hit}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            // Space scrolls the pane otherwise, which moves the
                            // row out from under the reader who just chose it.
                            event.preventDefault();
                            onSelectRow(row);
                          }}
                          title={LAYER_MEANING[row.layer]}
                        >
                          <span className="trace-label" data-field="event">
                            {row.label}
                          </span>
                          <span className="trace-row-detail" data-field="value">
                            {row.detail}
                          </span>
                          <span className="trace-row-says" data-field="says">
                            {/*
                              The lane keeps its OWN badge even when the step
                              agrees on one. A badge is a correctness surface and
                              the step head is a summary of it, not a substitute:
                              a reader looking at `R3 128 ticks` must be able to
                              read what claims that number without moving their
                              eye to a heading.
                            */}
                            <span className={`prov prov-${badge.tone} trace-badge`} data-badge-scope="lane">
                              {badge.text}
                            </span>
                            <OriginTag origin={row.origin} />
                          </span>
                          {step.sharedWitness === null && (
                            <Witness shared={false}>{row.witness}</Witness>
                          )}
                          <span className="trace-row-meta" data-field="aside">
                            <span
                              className={`trace-match trace-match-${row.match}`}
                              title={MATCH_NOTE[row.match]}
                            >
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
                          </span>
                        </li>
                      );
                    })}
                  </ol>
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
