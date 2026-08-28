/**
 * The joint inspector: all eight channels, and an honest account of what is
 * and is not known about each.
 *
 * The load-bearing design decision is the `measuredDeg` row. It is always
 * `null`, it is always shown, and it always carries the reason. Leaving it out
 * would be tidier and would teach the learner that the robot has feedback it
 * does not have; filling it from `commandedDeg` would be worse. The model
 * package exports `HAS_JOINT_POSITION_FEEDBACK = false` as a named constant so
 * that code branching on it reads as a statement about the hardware, and this
 * component surfaces that constant rather than hardcoding the word "null".
 *
 * Second decision: the joints are listed in **firmware enum order**
 * (`R1 R2 L1 L2 R4 R3 L3 L4`), never sorted. `R4` really does come before `R3`.
 * Alphabetising the list would silently rewire four servos in the reader's head.
 */
import { HAS_JOINT_POSITION_FEEDBACK, JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import type { ReactElement } from 'react';

import type { JointView } from '../state/telemetry-store.js';
import type { JointRig } from '../three/rig.js';
import { commandedDegFromNode } from '../three/rig.js';
import { OriginTag, ProvenanceTag } from './ProvenanceTag.js';

export interface JointInspectorProps {
  readonly joints: Record<JointName, JointView>;
  readonly rig: Record<JointName, JointRig> | null;
  readonly selected: JointName | null;
  readonly onSelect: (joint: JointName | null) => void;
  readonly canCommand: boolean;
  readonly onSetJoint: (joint: JointName, deg: number) => void;
}

const fmt = (value: number | null, digits = 1): string =>
  value === null ? '—' : value.toFixed(digits);

/**
 * The seven columns, once — Phase 4 W2.
 *
 * The brief asks this pane the container question directly: *"Should Inspector
 * be a table or stacked joint records?"* Below 520 px of PANE width it is
 * records, and a record needs a label per value where a table needed one per
 * column. Both come from this array, so the two bands cannot disagree about
 * what a column is called and there is no second copy of the words to update.
 *
 * The labels are real DOM text rather than `content: attr(data-label)` for two
 * reasons. Generated content is not reliably in the accessibility tree, and the
 * harness reads `innerText` when it checks that no correctness surface has been
 * ellipsised — a label a test cannot see is a label the invariant cannot check.
 * Exactly one of the two is displayed at a time (`.cell-label` is `display:
 * none` in the table band, `thead` is `display: none` in the record band), so
 * every cell has one accessible name in both.
 */
const JOINT_COLUMNS = [
  { id: 'ch', label: 'ch' },
  { id: 'joint', label: 'joint' },
  { id: 'commanded', label: 'commanded' },
  { id: 'simulated', label: 'simulated' },
  { id: 'measured', label: 'measured' },
  { id: 'prov', label: 'prov' },
  { id: 'origin', label: 'origin' },
] as const;

type JointColumnId = (typeof JOINT_COLUMNS)[number]['id'];

const COLUMN_LABEL: Readonly<Record<JointColumnId, string>> = Object.freeze(
  Object.fromEntries(JOINT_COLUMNS.map((c) => [c.id, c.label])) as Record<JointColumnId, string>,
);

/**
 * One cell, carrying its own label.
 *
 * `role="cell"` is stated explicitly because the record band sets `display:
 * block` on the row, and a `display` that is not a table display drops the
 * implicit table roles. The semantics must not depend on which container band
 * the pane happens to be in.
 */
function JointCell(props: {
  readonly column: JointColumnId;
  readonly className?: string;
  readonly title?: string;
  readonly physicallyObserved?: boolean;
  readonly children: React.ReactNode;
}): ReactElement {
  const { column, className, title, physicallyObserved, children } = props;
  return (
    <td
      role="cell"
      className={className}
      data-column={column}
      {...(title === undefined ? {} : { title })}
      {...(physicallyObserved === undefined
        ? {}
        : { 'data-physically-observed': String(physicallyObserved) })}
    >
      <span className="cell-label">{COLUMN_LABEL[column]}</span>
      <span className="cell-value">{children}</span>
    </td>
  );
}

export function JointInspector(props: JointInspectorProps): ReactElement {
  const { joints, rig, selected, onSelect, canCommand, onSetJoint } = props;
  const detail = selected === null ? null : joints[selected];
  const detailRig = selected === null || rig === null ? null : rig[selected];

  return (
    /*
      A PANE WRAPPER, so W2's container sweep can still drive the seven-column
      table through its two bands — Phase 4 W7. The table moved into the "more
      info" screen and the pane it used to live in became a 280 px glance card,
      so without this the container query that decides table-vs-stacked-records
      would have stopped being asserted anywhere.

      A wrapper rather than the class on `.panel` itself: `.panel` carries 12 px
      of padding, and a container query evaluates against the CONTENT box, so a
      pane driven to 522 px would query 496 and land on the wrong side of its
      own 520 px threshold. The sweep asserts a boundary; a box that is 24 px
      narrower than the number it reports cannot stand on one.
    */
    <div className="pane" data-pane="joints">
    <section className="panel" data-testid="joint-inspector">
      <header className="panel-header">
        <h2>Joints</h2>
        <span className="panel-sub">firmware enum order — R4 before R3</span>
      </header>

      <table className="joints" id="joint-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            {JOINT_COLUMNS.map((column) => (
              <th key={column.id} role="columnheader" scope="col" data-column={column.id}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {JOINT_ORDER.map((joint, index) => {
            const view = joints[joint];
            return (
              <tr
                key={joint}
                role="row"
                className={joint === selected ? 'selected' : ''}
                onClick={() => onSelect(joint === selected ? null : joint)}
                data-joint={joint}
                data-commanded={view.commandedDeg === null ? '' : String(view.commandedDeg)}
              >
                <JointCell column="ch" className="dim">
                  {index}
                </JointCell>
                <JointCell column="joint" className="joint-name">
                  {joint}
                </JointCell>
                <JointCell column="commanded" className="num">
                  {view.commandedDeg === null ? <span className="muted">never</span> : `${fmt(view.commandedDeg, 0)}°`}
                </JointCell>
                <JointCell column="simulated" className="num">
                  {view.simulatedDeg === null ? <span className="muted">—</span> : `${fmt(view.simulatedDeg)}°`}
                </JointCell>
                <JointCell column="measured" className="num null-cell" title="no sensor exists">
                  null
                </JointCell>
                <JointCell column="prov">
                  {view.provenance === null ? <span className="muted">—</span> : <ProvenanceTag value={view.provenance} />}
                </JointCell>
                <JointCell column="origin" physicallyObserved={view.physicallyObserved}>
                  {view.origin === null ? <span className="muted">—</span> : <OriginTag origin={view.origin} />}
                </JointCell>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/*
        The origin column is not decoration. `provenance` is `observed` for both
        an emulated UART and a real robot — the same word for two very different
        claims — so the column beside it is what tells a reader which of the two
        produced the number in the `commanded` column. `physicallyObserved` on
        the cell is `isPhysicallyObserved()`, not a string comparison.
      */}
      <div className="feedback-note" data-testid="no-feedback-note">
        <strong>`measuredDeg` is null on every joint, always.</strong>
        <p>
          <code>HAS_JOINT_POSITION_FEEDBACK = {String(HAS_JOINT_POSITION_FEEDBACK)}</code> in{' '}
          <code>@sesame-lab/sesame-model</code>. The stock Sesame drives eight MG90S servos over one-way
          PWM: no encoder, no potentiometer tap, no current sense, and no firmware path that could report a
          real angle. This column is not "not yet received" — it is <em>unknowable on this hardware</em>,
          and it is never filled in from <code>commandedDeg</code>.
        </p>
      </div>

      {detail !== null && detailRig !== null && (
        <div className="joint-detail" data-testid="joint-detail">
          <h3>
            {detail.joint} <span className="dim">servo channel {detailRig.firmwareIndex}</span>
          </h3>

          <dl className="kv">
            <dt>commandedDeg</dt>
            <dd>
              {detail.commandedDeg === null ? (
                <span className="muted">never commanded — the node sits at the asset's rest transform</span>
              ) : (
                <>
                  {detail.commandedDeg}° <span className="muted">post-subtrim, post-clamp</span>
                  <br />
                  <OriginTag origin={detail.origin} />{' '}
                  <span className="muted">
                    {detail.physicallyObserved
                      ? 'measured on physical hardware'
                      : 'not a measurement — see the origin badge for what produced it'}
                  </span>
                </>
              )}
            </dd>

            <dt>simulatedDeg</dt>
            <dd>
              {detail.simulatedDeg === null ? (
                <span className="muted">no model behind this backend</span>
              ) : (
                <>
                  {fmt(detail.simulatedDeg, 2)}°{' '}
                  <span className="muted">
                    slew model, datasheet 600 °/s — an inference about where the horn is, never an
                    observation
                  </span>
                </>
              )}
            </dd>

            <dt>measuredDeg</dt>
            <dd>
              <span className="null-cell">null</span>{' '}
              <span className="muted">no sensor — see above</span>
            </dd>

            <dt>subtrimDeg</dt>
            <dd>
              {detail.subtrimDeg === null ? <span className="muted">—</span> : `${detail.subtrimDeg}°`}{' '}
              <span className="muted">added before the 0–180 clamp, RAM only, never persisted</span>
            </dd>

            <dt>scene-graph angle</dt>
            <dd>
              {fmt(commandedDegFromNode(detailRig), 2)}°{' '}
              <span className="muted">recovered from the node's quaternion, not from state</span>
            </dd>

            <dt>rotation rule</dt>
            <dd className="mono small">{detailRig.rotationRule}</dd>

            <dt>axis</dt>
            <dd className="mono small">
              [{detailRig.axis.x}, {detailRig.axis.y}, {detailRig.axis.z}] · sign{' '}
              {detailRig.sign > 0 ? '+1' : '−1'} · <em>{detailRig.axisStatus}</em> /{' '}
              <em>{detailRig.rotationSenseStatus}</em>
            </dd>

            <dt>pivot</dt>
            <dd className="mono small">
              ({detailRig.pivotOriginMm.map((n) => n.toFixed(3)).join(', ')}) mm, canonical frame
            </dd>

            <dt>parent → children</dt>
            <dd className="mono small">
              {detailRig.parentNode} → {detailRig.childNodes.length === 0 ? '(leaf)' : detailRig.childNodes.join(', ')}
            </dd>

            <dt>spatial name</dt>
            <dd>
              <code>{detailRig.semanticNameAlias ?? '(none)'}</code>{' '}
              <span className="warn-inline">unverified guess</span>
              <div className="muted small">
                V0 corroborated the eight spatial names from the CAD, but the CAD cannot say which printed
                part was bolted where. The joint's identity is <code>{detail.joint}</code> and its servo
                channel; nothing in this app keys off the alias.
              </div>
            </dd>

            <dt>last event</dt>
            <dd>
              {detail.lastSeq === null ? (
                <span className="muted">—</span>
              ) : (
                <>
                  seq {detail.lastSeq}
                  {detail.lastTraceId === null ? null : (
                    <>
                      {' '}
                      · trace <code>{detail.lastTraceId}</code>
                    </>
                  )}{' '}
                  · {detail.updates} update{detail.updates === 1 ? '' : 's'}
                </>
              )}
            </dd>

            {detail.warnings.length > 0 && (
              <>
                <dt>warnings</dt>
                <dd>
                  {detail.warnings.map((w) => (
                    <div key={w.code} className="warn-inline">
                      {w.code}: {w.message}
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>

          <label className="slider">
            <span>drive this joint</span>
            <input
              type="range"
              min={0}
              max={180}
              step={1}
              disabled={!canCommand}
              value={detail.commandedDeg ?? 90}
              onChange={(e) => onSetJoint(detail.joint, Number(e.target.value))}
            />
            <span className="dim">0–180, the firmware's own clamp</span>
          </label>
        </div>
      )}
    </section>
    </div>
  );
}

export interface JointGlanceProps {
  readonly joints: Record<JointName, JointView>;
  readonly selected: JointName | null;
  readonly totalEvents: number;
  readonly jointsCommanded: number;
}

/**
 * The side panel's inspector card — Phase 4 W7.
 *
 * §11.4 names the seven-column table as the first thing that belongs in a "more
 * info" screen, and it is right: what a reader wants *while executing commands*
 * is which joint is selected and what it is doing, which is four lines. The
 * table, the per-joint slider and the asset facts are one click away.
 *
 * **What did NOT move.** `measuredDeg` is here, it is `null`, and it carries
 * `HAS_JOINT_POSITION_FEEDBACK` as the reason — that row is the load-bearing
 * design decision of the whole pane (see this module's header), and leaving it
 * to the popover would teach a reader that the robot has feedback it does not
 * have. The provenance and origin of the selected reading are here for the same
 * reason: they are correctness surfaces, and a popover may expand them rather
 * than be where they first appear.
 *
 * With nothing selected it says so, and says how to select — an empty card that
 * simply showed dashes would look like a robot with no telemetry.
 */
export function JointGlance(props: JointGlanceProps): ReactElement {
  const { joints, selected, totalEvents, jointsCommanded } = props;
  const view = selected === null ? null : joints[selected];
  return (
    <div className="joint-glance" data-testid="joint-glance" data-selected={selected ?? ''}>
      {view === null || selected === null ? (
        <p className="note muted" data-testid="joint-glance-empty">
          No joint selected. Click a joint on the robot, or a node in the architecture graph, and
          it lights up in every pane at once.
        </p>
      ) : (
        <dl className="kv">
          <dt>joint</dt>
          <dd>
            <b>{selected}</b>{' '}
            <span className="muted">servo channel {JOINT_ORDER.indexOf(selected)}</span>
          </dd>
          <dt>commanded</dt>
          <dd>
            <code>{fmt(view.commandedDeg)}</code>°
          </dd>
          <dt>simulated</dt>
          <dd>
            <code>{fmt(view.simulatedDeg)}</code>°
          </dd>
          <dt>measured</dt>
          <dd
            data-physically-observed={String(view.physicallyObserved)}
            title={`HAS_JOINT_POSITION_FEEDBACK = ${String(HAS_JOINT_POSITION_FEEDBACK)}`}
          >
            <b>null</b>{' '}
            <span className="muted">— no position feedback exists on this robot</span>
          </dd>
          <dt>says</dt>
          <dd>
            {view.provenance === null ? (
              <span className="muted">nothing yet</span>
            ) : (
              <ProvenanceTag value={view.provenance} />
            )}{' '}
            <OriginTag origin={view.origin} />
          </dd>
        </dl>
      )}
      <p className="note muted" data-testid="joint-glance-counts">
        {jointsCommanded}/{JOINT_ORDER.length} joints commanded · {totalEvents} events
      </p>
    </div>
  );
}
