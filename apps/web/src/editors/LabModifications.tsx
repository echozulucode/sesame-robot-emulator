/**
 * "Sesame Lab is modifying this robot."
 *
 * Subtrim and injected faults are sticky, and they should be: they are state,
 * not a mode. But a `+40` left on R1 in lesson 2 is still there in lesson 4,
 * where `stand` then commands 175° instead of 135° and the pose check fails for
 * a reason that has nothing to do with the step. That is a genuinely confusing
 * five minutes, and the confusion is entirely the lab's fault, not the
 * firmware's.
 *
 * So whenever anything lab-side is modifying the robot, it is named on screen
 * with the offer to put it back. L6 built this for Learn mode; it lives here,
 * beside the editors it describes, because **Lab mode sets far more of this
 * state than Learn does** and a banner that only appeared in one of the two
 * modes would be silently wrong in the other.
 *
 * Three kinds of modification, and the list is the *whole* list — anything the
 * Lab can do to the robot that the firmware cannot do to itself belongs here:
 *
 * | | why it is ours and not the robot's |
 * |---|---|
 * | subtrim | the arithmetic is firmware; the slider is not — the firmware only exposes `st <ch> <deg>` on the serial CLI |
 * | injected faults | the three `injectorIsLabFeature` ones; the four shipped ones are NOT listed, because nothing was injected |
 * | an authored face | pixels a person drew, sitting on the panel where the robot's own face would be |
 *
 * What is deliberately **not** here: commanded joint angles. Driving R1 to 135°
 * is what the robot is for; calling it interference would make the banner
 * permanent and therefore unreadable.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import type { ReactElement } from 'react';

export interface LabModificationsProps {
  readonly subtrimDeg: Readonly<Record<JointName, number>>;
  readonly faults: readonly string[];
  /** True while a person-drawn frame is the thing on the panel. */
  readonly panelAuthored?: boolean;
  readonly onClear: () => void;
}

export function LabModifications(props: LabModificationsProps): ReactElement | null {
  const { subtrimDeg, faults, panelAuthored = false, onClear } = props;
  const trims = JOINT_ORDER.filter((joint) => subtrimDeg[joint] !== 0);
  if (trims.length === 0 && faults.length === 0 && !panelAuthored) return null;
  return (
    <div
      className="lesson-labmods"
      data-testid="lab-modifications"
      data-trims={String(trims.length)}
      data-faults={String(faults.length)}
      data-panel-authored={String(panelAuthored)}
    >
      <b>Sesame Lab is modifying this robot.</b>{' '}
      {trims.length > 0 && (
        <span>
          subtrim{' '}
          {trims
            .map((joint) => `${joint} ${subtrimDeg[joint] > 0 ? '+' : ''}${String(subtrimDeg[joint])}°`)
            .join(', ')}
          .{' '}
        </span>
      )}
      {faults.length > 0 && <span>injected fault(s): {faults.join(', ')}. </span>}
      {panelAuthored && (
        <span>
          the face on the panel was drawn here, not by the robot.{' '}
        </span>
      )}
      <button type="button" className="linkish" data-testid="lab-modifications-clear" onClick={onClear}>
        put it all back
      </button>
    </div>
  );
}
