/**
 * The sequence editor — a Lab tool, borrowed by Learn.
 *
 * A frame is a set of commanded angles plus a wait, because that is the only
 * shape the firmware has. Running one issues `setServoAngle()` per channel in
 * **firmware enum order** and then waits, which is what `runWavePose()` does;
 * the caller supplies `onRun`, so the same editor drives a lesson step and a
 * Lab project without knowing which it is in.
 *
 * The out-of-range readout is deliberately loud. `sequence-authored` checks
 * `maxCommandedAngleOutOfRange: 0`, and the interesting thing about an angle of
 * 200 is not that the editor refuses it — it is that the *firmware* would have
 * clamped it to 180 and said nothing.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { useMemo, type ReactElement } from 'react';

import {
  IMPORTABLE_MOVEMENTS,
  addFrame,
  outOfRangeAngles,
  removeFrame,
  scaleDelays,
  setFrameAngle,
  setFrameDelay,
  type SequenceDoc,
} from './sequence.js';

export interface SequenceEditorProps {
  readonly doc: SequenceDoc;
  readonly onChange: (doc: SequenceDoc) => void;
  readonly onImport: (movementFunction: string) => void;
  /** Run the document on the robot. `changedField` labels a variation run. */
  readonly onRun: (changedField: string | null) => void;
  readonly running: boolean;
  /** Restrict the import list, the way a lesson step naming one movement does. */
  readonly importOnly?: string | null;
}

export function SequenceEditor(props: SequenceEditorProps): ReactElement {
  const { doc, onChange, onImport, onRun, running, importOnly = null } = props;
  const bad = useMemo(() => outOfRangeAngles(doc), [doc]);
  const imports = importOnly === null ? IMPORTABLE_MOVEMENTS : [importOnly];

  return (
    <div className="editor editor-sequence" data-testid="sequence-editor">
      <div className="editor-row">
        <select
          className="lesson-select"
          data-testid="sequence-import"
          value=""
          onChange={(e) => {
            if (e.target.value !== '') onImport(e.target.value);
          }}
        >
          <option value="">import a movement…</option>
          {imports.map((fn) => (
            <option key={fn} value={fn}>
              {fn}
            </option>
          ))}
        </select>
        <button type="button" className="lesson-button" data-testid="sequence-add" onClick={() => onChange(addFrame(doc))}>
          + frame
        </button>
        <button
          type="button"
          className="lesson-button"
          data-testid="sequence-slower"
          disabled={doc.frames.length === 0}
          onClick={() => onChange(scaleDelays(doc, 2))}
        >
          double every wait
        </button>
      </div>

      {/*
        The timeline, and it is intrinsically spatial — Phase 4 W5. Eleven
        columns (a frame index, eight joints in firmware enum order, a wait and
        a remove) whose whole meaning is that a row is one pose; compressing the
        frame targets below a usable size is what the brief says not to do. It
        pans, with the frame number pinned.
      */}
      <table className="sequence-table" data-testid="sequence-frames" data-2d-surface="table">
        <thead>
          <tr>
            <th>#</th>
            {JOINT_ORDER.map((joint) => (
              <th key={joint} className="mono">
                {joint}
              </th>
            ))}
            <th>wait</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {doc.frames.map((frame, index) => (
            <tr key={index} data-testid={`sequence-frame-${String(index)}`}>
              <td className="muted">{index + 1}</td>
              {JOINT_ORDER.map((joint) => (
                <td key={joint}>
                  <input
                    className="mono sequence-cell"
                    type="text"
                    inputMode="numeric"
                    value={frame.angles[joint] ?? ''}
                    data-testid={`sequence-${String(index)}-${joint}`}
                    onChange={(e) => {
                      const text = e.target.value.trim();
                      onChange(
                        setFrameAngle(
                          doc,
                          index,
                          joint as JointName,
                          text === '' ? null : Number.parseInt(text, 10),
                        ),
                      );
                    }}
                  />
                </td>
              ))}
              <td>
                <input
                  className="mono sequence-cell"
                  type="text"
                  inputMode="numeric"
                  value={frame.delayMs}
                  data-testid={`sequence-${String(index)}-delay`}
                  onChange={(e) => onChange(setFrameDelay(doc, index, Number.parseInt(e.target.value, 10) || 0))}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => onChange(removeFrame(doc, index))}
                  aria-label={`remove frame ${String(index + 1)}`}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {doc.frames.length === 0 && (
        <p className="note muted">No frames yet. Import a movement, or add one and type angles.</p>
      )}

      {bad.length > 0 && (
        <p className="note is-fail" data-testid="sequence-out-of-range">
          {bad.length} angle(s) outside the firmware&rsquo;s 0&ndash;180:{' '}
          {bad.map((b) => `${b.joint}=${String(b.angleDeg)}`).join(', ')}. The firmware would clamp
          these and say nothing.
        </p>
      )}

      <div className="editor-row">
        <button
          type="button"
          className="lesson-button is-primary"
          data-testid="sequence-run"
          disabled={running || doc.frames.length === 0}
          onClick={() => onRun(null)}
        >
          {running ? 'running…' : 'run as authored'}
        </button>
        <button
          type="button"
          className="lesson-button"
          data-testid="sequence-run-variant"
          disabled={running || doc.frames.length === 0}
          onClick={() => onRun('delayMs')}
        >
          run as a timing variation
        </button>
      </div>
    </div>
  );
}
