/**
 * Per-channel subtrim — a Lab tool, borrowed by Learn.
 *
 * ## The one thing this control must not let a learner believe
 *
 * The **arithmetic** is real firmware: `setServoAngle()` computes
 * `constrain(angle + servoSubtrim[channel], 0, 180)`, subtrim first and the
 * clamp second, so a channel with +40 of trim has silently lost the top 40° of
 * its range. That is TN-003 and it happens on every robot that ships this
 * firmware.
 *
 * **Setting the offset from a slider is not.** The firmware exposes subtrim
 * over the serial CLI (`st <ch> <deg>`) and nowhere else — no HTTP route, no
 * button. `hardware/lessons.json` records that in the fault catalogue as
 * `subtrim-saturation` with `injectorIsLabFeature: true`, and this control says
 * so on screen rather than leaving a learner to assume the robot has a trim
 * knob. The split matters more here than almost anywhere: the *consequence* is
 * genuine, the *affordance* is ours.
 */
import { JOINT_ORDER, SUBTRIM_RANGE_DEG, type JointName } from '@sesame-lab/sesame-model';
import type { ReactElement } from 'react';

export interface SubtrimControlProps {
  readonly value: Readonly<Record<JointName, number>>;
  readonly onChange: (joint: JointName, deg: number) => void;
  /** Restrict the control to one channel, the way a lesson step does. */
  readonly only?: JointName | null;
  /** What the robot itself reports, so the slider can be shown to disagree. */
  readonly reported?: Readonly<Partial<Record<JointName, number | null>>>;
  readonly disabled?: boolean;
}

export function SubtrimControl(props: SubtrimControlProps): ReactElement {
  const { value, onChange, only = null, reported, disabled = false } = props;
  const joints = only === null ? JOINT_ORDER : [only];

  return (
    <div className="editor editor-subtrim" data-testid="subtrim-control">
      <p className="lesson-lab-note" data-testid="subtrim-lab-note">
        <b>Lab feature.</b> The offset arithmetic below is the firmware&rsquo;s own
        (<code>constrain(angle + servoSubtrim[channel], 0, 180)</code>), but the firmware only lets
        you set it over the serial CLI. This slider is Sesame Robot Emulator&rsquo;s, not the robot&rsquo;s.
      </p>
      {joints.map((joint) => {
        const deg = value[joint];
        const back = reported?.[joint] ?? null;
        return (
          <label key={joint} className="editor-row">
            <span className="mono editor-label">{joint}</span>
            <input
              type="range"
              min={SUBTRIM_RANGE_DEG.min}
              max={SUBTRIM_RANGE_DEG.max}
              step={1}
              value={deg}
              disabled={disabled}
              data-testid={`subtrim-${joint}`}
              onChange={(e) => onChange(joint, Number(e.target.value))}
            />
            <span className="mono editor-value">
              {deg > 0 ? '+' : ''}
              {deg}&deg;
            </span>
            <span className="muted small">
              {back === null ? 'robot has not reported' : `robot reports ${back > 0 ? '+' : ''}${String(back)}°`}
            </span>
          </label>
        );
      })}
    </div>
  );
}
