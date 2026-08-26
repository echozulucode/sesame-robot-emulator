/**
 * Eight sliders, and the four things that happen between the slider and the pin.
 *
 * The naive version of this control is a row of sliders labelled "front left
 * hip" that report the number you typed. Every part of that is wrong here:
 *
 * 1. **The names are the firmware's.** `JOINT_ORDER` is
 *    `R1 R2 L1 L2 R4 R3 L3 L4` — the wiring order, neither geometric nor
 *    alphabetical, with `R4` genuinely before `R3` — and the channel index is
 *    shown beside each one because that index is what `setServoAngle()` takes
 *    and what `servoPins[]` and `servoSubtrim[]` are keyed by. Anything
 *    spatial is a guess until somebody holds a built robot (`joints.ts`), so
 *    this control says nothing spatial at all.
 * 2. **Subtrim is added BEFORE the clamp.** `hardware-map.json` →
 *    `servos.control.setServoAngle.steps[2]`: `adjustedAngle = constrain(angle
 *    + servoSubtrim[channel], 0, 180)`. The order is the whole of TN-003: a
 *    channel with +40 of trim has silently lost the top 40° of its range, and
 *    the arithmetic is written out here in that order rather than summarised.
 * 3. **The pin cannot do 1°.** `quantiseCommandedAngle()` reproduces ESP32Servo
 *    3.0.9's `map()` → `usToTicks()` chain, including the clamp that turns the
 *    firmware's `attach(pin, 732, 2929)` into a 2500 µs maximum. 181 commands,
 *    92 distinct pulses: the readout shows the tick number and names the
 *    neighbouring angles that program the same one.
 * 4. **Nothing here is a measurement.** No servo moved. There is no physical
 *    robot in this project and `isPhysicallyObserved()` is false everywhere.
 *    The "robot reports" column is the telemetry store's commanded angle — what
 *    the model says it was asked for, not where anything is.
 */
import { JOINT_ORDER, jointIndex, quantiseCommandedAngle, type JointName } from '@sesame-lab/sesame-model';
import { useMemo, type ReactElement } from 'react';

import type { Pose } from './lab-doc.js';

export interface PoseControlProps {
  readonly pose: Pose;
  readonly onChange: (joint: JointName, deg: number) => void;
  readonly subtrimDeg: Readonly<Record<JointName, number>>;
  /** What the telemetry store says was commanded. `null` before anything ran. */
  readonly reported: Readonly<Record<JointName, number | null>>;
  readonly onSend: (joint: JointName) => void;
  readonly onSendAll: () => void;
  readonly onCapture: () => void;
  readonly busy: boolean;
}

export function PoseControl(props: PoseControlProps): ReactElement {
  const { pose, onChange, subtrimDeg, reported, onSend, onSendAll, onCapture, busy } = props;

  const rows = useMemo(
    () =>
      JOINT_ORDER.map((joint) => {
        const commanded = pose[joint];
        const trim = subtrimDeg[joint];
        // The firmware's own order: add, THEN clamp. Written as two steps so
        // the saturation is visible rather than folded into one number.
        const summed = commanded + trim;
        const adjusted = Math.max(0, Math.min(180, summed));
        const saturated = summed !== adjusted;
        const q = quantiseCommandedAngle(adjusted);
        const others = q.aliases.filter((a) => a !== adjusted);
        return { joint, commanded, trim, summed, adjusted, saturated, q, others };
      }),
    [pose, subtrimDeg],
  );

  const aliasing = rows.filter((r) => r.others.length > 0).length;

  return (
    <div className="editor editor-pose" data-testid="pose-control">
      <p className="lesson-lab-note is-inferred" data-testid="pose-never-observed">
        <b>Commanded, never observed.</b> <code>setServoAngle()</code> is write-only and the stock
        robot has no joint-position feedback (<code>hardware-map.json</code> &rarr;{' '}
        <code>positionFeedbackNote</code>). Every number below is what the code <i>asks</i> for.
      </p>

      <table className="pose-table" data-testid="pose-table">
        <thead>
          <tr>
            <th>ch</th>
            <th>joint</th>
            <th>commanded</th>
            <th>+ subtrim</th>
            <th>constrain(…, 0, 180)</th>
            <th>LEDC tick</th>
            <th>pulse</th>
            <th>robot reports</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.joint} data-testid={`pose-row-${row.joint}`} data-adjusted={String(row.adjusted)} data-ticks={String(row.q.ticks)}>
              <td className="mono muted">{jointIndex(row.joint)}</td>
              <td className="mono">{row.joint}</td>
              <td>
                <input
                  type="range"
                  min={0}
                  max={180}
                  step={1}
                  value={row.commanded}
                  data-testid={`pose-slider-${row.joint}`}
                  onChange={(e) => onChange(row.joint, Number(e.target.value))}
                />
                <span className="mono editor-value" data-testid={`pose-value-${row.joint}`}>
                  {row.commanded}&deg;
                </span>
              </td>
              <td className="mono muted">
                {row.trim > 0 ? '+' : ''}
                {row.trim}
              </td>
              <td className={row.saturated ? 'mono is-fail' : 'mono'} data-testid={`pose-adjusted-${row.joint}`}>
                {row.adjusted}&deg;
                {row.saturated && (
                  <span className="small"> &nbsp;{row.summed}&deg; clamped</span>
                )}
              </td>
              <td className="mono muted">{row.q.ticks}</td>
              <td className="mono muted">
                {row.q.pulseUs.toFixed(2)}&nbsp;&micro;s
                {row.others.length > 0 && (
                  <span className="small" data-testid={`pose-alias-${row.joint}`}>
                    {' '}
                    = {row.others.join(', ')}&deg;
                  </span>
                )}
              </td>
              <td className="mono muted" data-testid={`pose-reported-${row.joint}`}>
                {reported[row.joint] === null ? '—' : `${String(reported[row.joint])}°`}
              </td>
              <td>
                <button
                  type="button"
                  className="linkish"
                  data-testid={`pose-send-${row.joint}`}
                  disabled={busy}
                  onClick={() => onSend(row.joint)}
                >
                  send
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="note muted small" data-testid="pose-aliasing">
        {aliasing === 0
          ? 'None of the eight adjusted angles shares its pulse with a neighbour right now.'
          : `${String(aliasing)} of the eight adjusted angles is indistinguishable from a neighbouring angle at the pin.`}{' '}
        92 distinct pulses exist across the 181 commands ESP32Servo can be given.
      </p>

      <div className="editor-row">
        <button
          type="button"
          className="lesson-button is-primary"
          data-testid="pose-send-all"
          disabled={busy}
          onClick={onSendAll}
        >
          {busy ? 'sending…' : 'send all eight'}
        </button>
        <button type="button" className="lesson-button" data-testid="pose-capture" onClick={onCapture}>
          add as a frame
        </button>
        <span className="muted small">
          &ldquo;send all eight&rdquo; issues one <code>setServoAngle()</code> per channel in enum
          order. The firmware has no multi-joint call, so neither does this.
        </span>
      </div>
    </div>
  );
}
