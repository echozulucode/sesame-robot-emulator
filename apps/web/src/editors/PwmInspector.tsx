/**
 * Angle in, computed pulse and tick count out. **Never an observed waveform.**
 *
 * Every number here comes from `quantiseCommandedAngle()` in
 * `@sesame-lab/sesame-model`, which reproduces ESP32Servo 3.0.9's own
 * `map()` → `usToTicks()` chain including the clamp that turns the firmware's
 * `attach(pin, 732, 2929)` into a 2500 µs maximum. Nothing is typed in and
 * nothing is read back from a lesson: the lesson's expectations are *checked
 * against* this arithmetic, and a disagreement fails the step loudly.
 *
 * The banner is not decoration. QEMU's LEDC model stores a duty value and
 * produces no pulse, no edge and no waveform, and there is no physical robot in
 * this project, so no pin has ever emitted any figure on this panel.
 */
import { quantiseCommandedAngle, SERVO_PULSE_QUANTISATION } from '@sesame-lab/sesame-model';
import { useMemo, type ReactElement } from 'react';

import { PWM_FACTS } from '../generated/architecture-graph.js';

export interface PwmInspectorProps {
  readonly angleDeg: number;
  readonly onAngle: (deg: number) => void;
  /** Angles the learner has already read, newest last. */
  readonly probed: readonly number[];
  readonly onSweep: () => void;
  readonly sweepRuns: number;
}

export function PwmInspector(props: PwmInspectorProps): ReactElement {
  const { angleDeg, onAngle, probed, onSweep, sweepRuns } = props;
  const q = useMemo(() => quantiseCommandedAngle(angleDeg), [angleDeg]);
  const others = q.aliases.filter((a) => a !== angleDeg);

  // The reachable set, drawn as counts rather than as a continuum: 181 commands,
  // 92 distinguishable pulses.
  const survey = SERVO_PULSE_QUANTISATION;

  return (
    <div className="editor editor-pwm" data-testid="pwm-inspector">
      <p className="lesson-lab-note is-inferred" data-testid="pwm-never-observed">
        <b>Computed here, never observed.</b> QEMU&rsquo;s LEDC model produces no pulse, no edge and no
        waveform, and there is no physical robot. This is what the code <i>asks</i> the pin for.
      </p>

      <label className="editor-row">
        <span className="mono editor-label">angle</span>
        <input
          type="range"
          min={0}
          max={180}
          step={1}
          value={angleDeg}
          data-testid="pwm-angle"
          onChange={(e) => onAngle(Number(e.target.value))}
        />
        <span className="mono editor-value">{angleDeg}&deg;</span>
      </label>

      <dl className="pwm-readout" data-testid="pwm-readout">
        <div>
          <dt>requested</dt>
          <dd className="mono" data-testid="pwm-mapped">
            {q.mappedUs} µs
          </dd>
        </div>
        <div>
          <dt>ticks</dt>
          <dd className="mono" data-testid="pwm-ticks">
            {q.ticks} / {PWM_FACTS.timerWidthBits === 10 ? 1024 : 2 ** PWM_FACTS.timerWidthBits}
          </dd>
        </div>
        <div>
          <dt>at the pin</dt>
          <dd className="mono" data-testid="pwm-pulse">
            {q.pulseUs.toFixed(5)} µs
          </dd>
        </div>
        <div>
          <dt>frame</dt>
          <dd className="mono">
            {PWM_FACTS.frequencyHz} Hz &middot; {PWM_FACTS.usPerTick} µs per tick
          </dd>
        </div>
      </dl>

      <p className="note" data-testid="pwm-alias">
        {others.length === 0
          ? `${String(angleDeg)}° is distinguishable at the pin.`
          : `Indistinguishable from ${others.join('°, ')}° at the pin.`}
      </p>

      <div className="editor-row">
        <button type="button" className="lesson-button" data-testid="pwm-sweep" onClick={onSweep}>
          sweep 0&ndash;180
        </button>
        <span className="muted small" data-testid="pwm-survey">
          {survey.commandableAngles} commandable angles &rarr; {survey.distinctPulseValues} distinct
          pulses &middot; {survey.aliasedAngleCount} aliased
          {sweepRuns > 0 ? ` · swept ${String(sweepRuns)}×` : ''}
        </span>
      </div>

      {probed.length > 0 && (
        <p className="note muted small" data-testid="pwm-probed">
          read so far:{' '}
          {probed
            .slice(-12)
            .map((deg) => `${String(deg)}°→${String(quantiseCommandedAngle(deg).ticks)}t`)
            .join('  ')}
        </p>
      )}
    </div>
  );
}
