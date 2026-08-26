/**
 * What Lab mode is allowed to do, and what it is allowed to see.
 *
 * Shaped like `LessonWiring` and `DebugHookWiring`, and for the same reason:
 * the pane owns no robot, no backend and no store. Everything it can *do* is a
 * function `App` passes down, and everything it can *see* is a live reading off
 * the same stores every other pane reads.
 *
 * That matters more in Lab than in Learn, not less. Learn's checks would be
 * meaningless if the runner kept its own copy of "what angle R1 is at"; Lab has
 * no checks at all, so the only thing keeping its readouts honest is that they
 * are the *same* readouts the joint inspector and the trace are showing. A Lab
 * that remembered what it had commanded would report a pose the robot never
 * reached, on any backend where a command can fail.
 *
 * Nothing here imports from `src/lessons/`, and nothing here is a lesson. Lab
 * mode has no steps, no checks, no progression and no success conditions — it
 * is the surface where the learner does what they want. The report's phrase is
 * *"an engineering lab with training wheels"*, and the training wheels are the
 * honesty labelling, not a rail.
 */
import type { JointName } from '@sesame-lab/sesame-model';

import type { SequenceDoc } from '../editors/sequence.js';

/**
 * One request/response, structurally.
 *
 * Declared here rather than imported from `src/lessons/runtime.js` so the
 * dependency runs the right way: `LessonRuntime.HttpExchange` satisfies this
 * shape, and Lab does not learn about Learn in order to show a status code.
 */
export interface LabHttpExchange {
  readonly method: string;
  readonly route: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly responseText: string;
  readonly duringMovement: string | null;
  readonly json: unknown;
  readonly jsonError: string | null;
}

export interface LabWiring {
  // ------------------------------------------------------------ what it sees
  /** Commanded angle per joint, off the telemetry store. `null` before anything ran. */
  readonly commandedDeg: Readonly<Record<JointName, number | null>>;
  readonly subtrimDeg: Readonly<Record<JointName, number>>;
  readonly faults: ReadonlySet<string>;
  readonly httpExchanges: readonly LabHttpExchange[];
  readonly bootLog: readonly string[];
  readonly bootHaltedAt: number | null;
  /** Non-null while a command is in flight. Same value the sidebar shows. */
  readonly busy: string | null;
  /** False on a backend whose subtrim the lab cannot reach. Never hidden. */
  readonly canSetSubtrim: boolean;
  /** True while the pixels on the panel are ones a person drew here. */
  readonly panelAuthored: boolean;

  // ------------------------------------------------------------ what it does
  setJoint(joint: JointName, deg: number): Promise<void>;
  setSubtrim(joint: JointName, deg: number): void;
  setFault(id: string, on: boolean): void;
  runBoot(): void;
  /** Run an authored animation on the robot: one `setServoAngle()` per channel. */
  runSequence(doc: SequenceDoc, changedField: string | null): Promise<void>;
  /** A real request to this origin. The real status is what gets recorded. */
  sendHttp(method: string, route: string, body: string | null): Promise<void>;
  /** Push an authored 128x64 frame onto the virtual panel. */
  pushPixelFrame(frame: Uint8Array): void;
  /** Put every lab-side modification back, panel included. */
  clearLabModifications(): void;
  selectSymbol(symbolId: string): void;
  /**
   * Tell the pane when lab-side state changed.
   *
   * Not optional, and not something the pane can do without. `App` re-renders
   * on TELEMETRY, and injecting a fault or moving subtrim produces no
   * telemetry at all — so on a quiet robot the banner would keep saying
   * nothing was modified until the next servo event happened to arrive. Learn
   * mode does not hit this because its runner re-evaluates checks on a 250 ms
   * timer; Lab has no checks and therefore no timer, so it subscribes.
   */
  subscribe(listener: () => void): () => void;
}
