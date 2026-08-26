/**
 * The exploded view: one body, eight joint modules, in the firmware's own order.
 *
 * ## Why this is a diagram and not the 3D scene
 *
 * The step asks the learner to "pull the exploded view apart to separate the
 * eight joint modules from the body". Doing that by translating nodes in the
 * three.js scene would move the posed feet, and the ground plane the harness
 * measures is computed *from the posed foot vertices* —
 * ISSUE-20260823-023 was a sliding ground plane found by a user, and moving the
 * robot's frame for decoration is the same class of change. So the explode
 * happens here, in SVG, and the 3D view keeps its frame. Clicking a module
 * still selects that joint everywhere in the app, and the top cover still comes
 * off in 3D.
 *
 * ## What the layout is claiming
 *
 * The order is `JOINT_ORDER` — R1, R2, L1, L2, R4, R3, L3, L4 — laid out as the
 * enum reads and **not** tidied into a tour around the body. R4 comes before
 * R3, which looks scrambled and is the point: the enum is the wiring order, and
 * anything that re-sorts it is inventing an order the firmware does not have.
 * The pin under each name comes from the selected board profile, so switching
 * boards visibly moves the pins and visibly does not move the names.
 *
 * The spatial arrangement is **not** a claim about the robot. `semanticName` is
 * a guess everywhere in this project and it stays a guess here: the modules are
 * drawn in two columns because the names begin with R and L, which is a fact
 * about the strings.
 */
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import type { ReactElement } from 'react';

import { JOINT_FACTS, SERVO_PINS_BY_BOARD } from '../generated/architecture-graph.js';

const MODULE_W = 78;
const MODULE_H = 34;
const BODY_W = 96;
const BODY_H = 130;

export interface RobotExplodeProps {
  readonly board: string;
  readonly selected: JointName | null;
  readonly onSelectJoint: (joint: JointName) => void;
  readonly explode: number;
  readonly onExplode: (value: number) => void;
  /** Hide the names, for the "name a joint with the labels turned off" challenge. */
  readonly labelsHidden: boolean;
  readonly showTopCover: boolean;
  readonly onToggleTopCover: (show: boolean) => void;
  /** When set, clicking a module answers "which module is <askingFor>?". */
  readonly askingFor: JointName | null;
  readonly onAnswer: (picked: JointName) => void;
  readonly answers: Readonly<Record<string, string>>;
}

export function RobotExplode(props: RobotExplodeProps): ReactElement {
  const {
    board,
    selected,
    onSelectJoint,
    explode,
    onExplode,
    labelsHidden,
    showTopCover,
    onToggleTopCover,
    askingFor,
    onAnswer,
    answers,
  } = props;
  const pins = SERVO_PINS_BY_BOARD[board] ?? {};
  const spread = 8 + explode * 82;
  const width = BODY_W + 2 * (MODULE_W + 8 + 82) + 40;
  const height = 4 * (MODULE_H + 10) + 20;

  return (
    <div className="editor editor-explode" data-testid="robot-explode">
      <div className="editor-row">
        <label className="editor-row">
          <span className="editor-label">explode</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={explode}
            data-testid="explode-amount"
            onChange={(e) => onExplode(Number(e.target.value))}
          />
        </label>
        <label className="editor-row">
          <input
            type="checkbox"
            checked={!showTopCover}
            data-testid="explode-top-cover"
            onChange={(e) => onToggleTopCover(!e.target.checked)}
          />
          <span className="small">take the top cover off the 3D robot</span>
        </label>
      </div>

      <svg
        className="explode-svg"
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="group"
        aria-label="exploded view of the eight joint modules"
      >
        <rect
          x={width / 2 - BODY_W / 2}
          y={height / 2 - BODY_H / 2}
          width={BODY_W}
          height={BODY_H}
          rx={10}
          className="explode-body"
        />
        <text x={width / 2} y={height / 2 - 4} className="explode-body-label" textAnchor="middle">
          body
        </text>
        <text x={width / 2} y={height / 2 + 12} className="explode-body-sub" textAnchor="middle">
          one controller
        </text>

        {JOINT_ORDER.map((joint, index) => {
          const isRight = joint.startsWith('R');
          const row = index % 4;
          const x = isRight
            ? width / 2 - BODY_W / 2 - MODULE_W - spread
            : width / 2 + BODY_W / 2 + spread;
          const y = 10 + row * (MODULE_H + 10);
          const facts = JOINT_FACTS[joint];
          const answered = answers[joint];
          const state =
            askingFor === null
              ? ''
              : answered === undefined
                ? ''
                : answered === joint
                  ? ' is-right'
                  : ' is-wrong';
          return (
            <g
              key={joint}
              className={`explode-module${selected === joint ? ' is-selected' : ''}${state}`}
              data-explode-joint={joint}
              data-testid={`explode-module-${joint}`}
              onClick={() => {
                if (askingFor !== null) onAnswer(joint);
                onSelectJoint(joint);
              }}
            >
              <rect x={x} y={y} width={MODULE_W} height={MODULE_H} rx={6} />
              <line
                x1={isRight ? x + MODULE_W : x}
                y1={y + MODULE_H / 2}
                x2={isRight ? width / 2 - BODY_W / 2 : width / 2 + BODY_W / 2}
                y2={height / 2}
                className="explode-wire"
              />
              <text x={x + MODULE_W / 2} y={y + 15} textAnchor="middle" className="explode-name mono">
                {labelsHidden ? '？' : joint}
              </text>
              <text x={x + MODULE_W / 2} y={y + 27} textAnchor="middle" className="explode-pin mono">
                {labelsHidden
                  ? `ch ${String(facts?.firmwareIndex ?? '?')}`
                  : `GPIO ${String(pins[joint] ?? '?')}`}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="note muted small" data-testid="explode-order-note">
        Drawn in <code>JOINT_ORDER</code> &mdash; R1, R2, L1, L2, R4, R3, L3, L4. R4 really does come
        before R3: that is the wiring order, not a tour around the body. Two columns because the
        names start with R and L, which is a fact about the strings and not about the robot.
      </p>
    </div>
  );
}
