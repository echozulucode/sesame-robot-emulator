/**
 * The canonical, transport-independent robot state.
 *
 * Shapes follow the research report's "Virtual robot and common API
 * architecture" section. One deliberate addition: the report's
 * `measuredDeg?: number` is spelled here as `measuredDeg?: number | null` with
 * a documented invariant, because *why* it is absent is the pedagogically
 * important part. See {@link JointState.measuredDeg}.
 */
import type { JointName } from './joints.js';

/** Which backend produced this state. */
export type RobotMode = 'real' | 'simulated' | 'renode';

/**
 * Per-joint state.
 *
 * Four numbers that are routinely confused, kept apart on purpose:
 *
 * | field          | meaning                                              | who can fill it |
 * |----------------|------------------------------------------------------|-----------------|
 * | `commandedDeg` | what was last asked for, after the firmware's clamp   | everyone        |
 * | `simulatedDeg` | where a behaviour/physics model thinks it now is      | sim, Renode     |
 * | `measuredDeg`  | where a sensor says it is                             | **nobody**      |
 * | `subtrimDeg`   | the per-channel offset applied before clamping        | everyone        |
 */
export interface JointState {
  /**
   * The last commanded angle, in degrees, as the firmware would hold it —
   * i.e. after `constrain(angle + servoSubtrim[channel], 0, 180)`.
   *
   * Authoritative when it comes from firmware telemetry; this is the only joint
   * number the stock robot can actually tell you.
   */
  readonly commandedDeg: number;

  /**
   * Where a behaviour or physics model believes the joint currently is, in
   * degrees. Present only when a simulator is in the loop, and always an
   * *inference*: it models servo slew, it does not observe it.
   */
  readonly simulatedDeg?: number;

  /**
   * Where a **sensor** says the joint is, in degrees.
   *
   * **The stock Sesame robot has no joint position feedback.** The eight MG90S
   * servos are commanded over one-way PWM; there is no encoder, no potentiometer
   * tap, no current sense, and no firmware path that could report a real angle.
   * So on `mode: "real"` this field is `null` (explicitly "asked and unknowable")
   * or absent, and it is **never** filled in from `commandedDeg`.
   *
   * The type allows `null` precisely so that a UI can distinguish "no sensor"
   * from "not yet received" and can refuse to draw a measurement the robot
   * cannot make. Anything that renders this value as though it were observed is
   * teaching the learner something false about the hardware.
   *
   * A future hardware variant with encoders may populate it. Until then, see
   * {@link HAS_JOINT_POSITION_FEEDBACK}.
   */
  readonly measuredDeg?: number | null;

  /**
   * The per-channel trim offset in degrees, added to the commanded angle before
   * clamping. `int8_t servoSubtrim[8]`, defaults to all zeros, lives in RAM only
   * and is never persisted by the stock firmware.
   */
  readonly subtrimDeg?: number;
}

/**
 * Whether the stock Sesame robot can report a real joint angle. It cannot.
 *
 * Exported as a named constant so that code which needs to branch on it reads
 * as a statement about the hardware rather than as a magic `false`.
 */
export const HAS_JOINT_POSITION_FEEDBACK = false as const;

/** The OLED face state. The panel is a fixed 128×64 SSD1306 at address 0x3C. */
export interface FaceState {
  readonly expression: string;
  readonly frame: number;
  readonly width: 128;
  readonly height: 64;
}

/** Network state. `"simulated"` means a host-side compatibility server, not a radio. */
export interface NetworkState {
  readonly state: 'unavailable' | 'ap' | 'station' | 'simulated';
  readonly ip?: string;
}

/** Which movement routine is running, and how far through it. */
export interface MotionState {
  readonly command?: string;
  readonly sequenceStep?: number;
}

/** One canonical robot state, independent of transport. */
export interface RobotState {
  readonly mode: RobotMode;
  readonly joints: Readonly<Record<JointName, JointState>>;
  readonly face: FaceState;
  readonly network: NetworkState;
  readonly motion: MotionState;
}

/**
 * What a given backend can actually do.
 *
 * Note what is *not* here: there is no `jointFeedback` capability, because no
 * Sesame backend has it and offering the flag would invite someone to set it.
 * If encoder hardware ever appears, adding the flag is a deliberate act.
 */
export interface SesameCapabilities {
  readonly realHardware: boolean;
  readonly firmwareExecution: boolean;
  readonly oledFramebuffer: boolean;
  readonly serialConsole: boolean;
  readonly httpApi: boolean;
  readonly physics: boolean;
}
