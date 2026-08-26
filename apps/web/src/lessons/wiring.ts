/**
 * What the lesson runner is allowed to do, and what it is allowed to see.
 *
 * Shaped like `DebugHookWiring`: the pane owns no robot, no backend and no
 * selection. Everything it can *do* is a function `App` passes down, and
 * everything it can *see* is a live reading off the same stores every other
 * pane reads. That is not tidiness — it is what makes the checks meaningful.
 * A runner that kept its own copy of "what angle R1 is at" would be checking
 * its own bookkeeping, and would pass a step in which nothing reached the
 * robot at all.
 */
import type { JointName } from '@sesame-lab/sesame-model';

import type { SequenceDoc } from '../editors/sequence.js';
import type { SelectionState } from '../state/selection.js';
import type { JointView } from '../state/telemetry-store.js';
import type { Trace } from '../state/trace-store.js';
import type { ModelReading } from './checks.js';
import type { LessonRuntime } from './runtime.js';

export interface LessonWiring {
  // ------------------------------------------------------------ what it sees
  readonly runtime: LessonRuntime;
  readonly joints: Readonly<Record<JointName, JointView>>;
  readonly model: ModelReading | null;
  readonly trace: Trace | null;
  readonly selection: SelectionState;
  readonly busy: string | null;
  readonly showTopCover: boolean;
  /** False on a backend whose subtrim the lab cannot reach. Never hidden. */
  readonly canSetSubtrim: boolean;

  // ------------------------------------------------------------ what it does
  runCommand(name: string): Promise<void>;
  setJoint(joint: JointName, deg: number): Promise<void>;
  /**
   * Write a RAW channel index, including out-of-range ones.
   *
   * The point of the step is `if (channel < 8)`: a channel outside 0–7 is
   * dropped with no error, no log and no return code, so nothing reaches the
   * wire and the trace stays empty. The action is journalled either way, which
   * is what lets `telemetry-absent` tell "nothing was sent" apart from "nothing
   * arrived".
   */
  setChannel(channel: number, deg: number): Promise<void>;
  setFace(name: string): Promise<void>;
  setSubtrim(joint: JointName, deg: number): void;
  setBoard(board: string): void;
  /**
   * Put every lab-side modification back.
   *
   * Subtrim and injected faults survive a step, a lesson and a page — which is
   * correct (they are state, not a mode) and is exactly how a learner ends up
   * three lessons later wondering why `stand` no longer reaches 135°. The
   * banner that offers this is the answer: the lab says out loud when it is
   * interfering with the robot, and offers to stop.
   */
  clearLabModifications(): void;
  selectSymbol(symbolId: string): void;
  /**
   * Follow a trace ROW back into the source that produced it.
   *
   * `source-span-selected` sometimes carries `reachedFrom: "trace-row"`, and
   * "click a servo.target row and follow it back" is not the same interaction
   * as "find it in the outline". This looks for a row on screen whose
   * `sourceRef` falls inside the named symbol's range and selects the symbol
   * with origin `trace`; with no such row it does nothing and returns false, so
   * the check stays pending rather than being satisfied by a button.
   */
  followTraceRow(symbolId: string): boolean;
  selectNode(nodeId: string): void;
  selectJoint(joint: JointName): void;
  onToggleTopCover(show: boolean): void;
  /** Record a PWM reading. The figures are recomputed, never passed in. */
  probePwm(angleDeg: number): void;
  /** Run an authored sequence on the robot and read the terminal pose back. */
  runSequence(doc: SequenceDoc, changedField: string | null): Promise<void>;
  /** A real request to this origin. The real status is what gets recorded. */
  sendHttp(method: string, route: string, body: string | null): Promise<void>;
  /** Run the lab's model of `setup()` with whatever faults are switched on. */
  runBoot(): void;
  /** Push an authored 128x64 frame onto the virtual panel. */
  pushPixelFrame(frame: Uint8Array): void;
}
