/**
 * The common `SesameRobot` contract, verbatim from the research report's
 * "Virtual robot and common API architecture" section.
 *
 * It lives in this package because this package is the first implementation of
 * it. When `RealSesameRobot` (physical) and `RenodeSesameRobot` (emulated)
 * arrive it should move to a neutral home — but moving an interface that has
 * one implementation is cheap, and inventing a package to hold it before
 * anything needs it is not.
 *
 * Every type it is built from comes from `@sesame-lab/sesame-model` and
 * `@sesame-lab/sesame-protocol`. Nothing is redefined here.
 */
import type { JointName, RobotState, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';

/**
 * One robot, whatever is behind it.
 *
 * The architectural invariant the report is after: lesson code, the
 * architecture diagram, the REST console, the animation editor and the
 * automated tests all talk to this, and the backend underneath is a swap.
 */
export interface SesameRobot {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** What this backend can actually do. Deliberately not a static constant. */
  capabilities(): Promise<SesameCapabilities>;

  /** Run one of the firmware's command words. */
  command(name: string): Promise<void>;

  /** Select an OLED expression by name. */
  setFace(name: string): Promise<void>;

  /** Command one servo channel. */
  setJoint(joint: JointName, angleDeg: number): Promise<void>;

  /** Command several channels. Ordering is the implementation's business. */
  setPose(pose: Partial<Record<JointName, number>>): Promise<void>;

  getState(): Promise<RobotState>;

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: SesameTelemetry) => void): () => void;
}
