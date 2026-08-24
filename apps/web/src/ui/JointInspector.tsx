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
import { ProvenanceTag } from './ProvenanceTag.js';

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

export function JointInspector(props: JointInspectorProps): ReactElement {
  const { joints, rig, selected, onSelect, canCommand, onSetJoint } = props;
  const detail = selected === null ? null : joints[selected];
  const detailRig = selected === null || rig === null ? null : rig[selected];

  return (
    <section className="panel" data-testid="joint-inspector">
      <header className="panel-header">
        <h2>Joints</h2>
        <span className="panel-sub">firmware enum order — R4 before R3</span>
      </header>

      <table className="joints" id="joint-table">
        <thead>
          <tr>
            <th>ch</th>
            <th>joint</th>
            <th>commanded</th>
            <th>simulated</th>
            <th>measured</th>
            <th>prov</th>
          </tr>
        </thead>
        <tbody>
          {JOINT_ORDER.map((joint, index) => {
            const view = joints[joint];
            return (
              <tr
                key={joint}
                className={joint === selected ? 'selected' : ''}
                onClick={() => onSelect(joint === selected ? null : joint)}
                data-joint={joint}
                data-commanded={view.commandedDeg === null ? '' : String(view.commandedDeg)}
              >
                <td className="dim">{index}</td>
                <td className="joint-name">{joint}</td>
                <td className="num">
                  {view.commandedDeg === null ? <span className="muted">never</span> : `${fmt(view.commandedDeg, 0)}°`}
                </td>
                <td className="num">
                  {view.simulatedDeg === null ? <span className="muted">—</span> : `${fmt(view.simulatedDeg)}°`}
                </td>
                <td className="num null-cell" title="no sensor exists">
                  null
                </td>
                <td>{view.provenance === null ? <span className="muted">—</span> : <ProvenanceTag value={view.provenance} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
  );
}
