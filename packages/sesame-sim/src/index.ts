/**
 * `@sesame-lab/sesame-sim` — a behaviour model of the Sesame robot.
 *
 * ```ts
 * import { SimulatedSesameRobot } from '@sesame-lab/sesame-sim';
 *
 * const robot = new SimulatedSesameRobot();          // virtual time, seeded
 * robot.subscribe((e) => console.log(e.seq, e.type, e.provenance));
 * await robot.connect();
 * await robot.command('wave');                        // 3.7 s of choreography,
 * console.log(robot.nowMs);                           // executed instantly
 * ```
 *
 * Three properties are worth knowing before using it:
 *
 * 1. **It is driven entirely by extracted data.** All 21 movement functions and
 *    all 395 steps come from `hardware/hardware-map.json`, which F4 pulled out
 *    of firmware source with `file:line` provenance on every fact. Nothing in
 *    this package hand-transcribes a movement, so a wrong angle is an extractor
 *    bug with one place to fix it.
 *
 * 2. **It schedules cooperatively, on virtual time.** `delayWithFace()` — which
 *    runs after *every* servo write — is not dead time on the robot: it pumps
 *    HTTP, DNS and face animation every 5 ms. The model reproduces that with
 *    generators, so faces really do animate mid-movement and an HTTP stop
 *    really can land inside a gait. Time only moves when the model moves it,
 *    which is what makes runs reproducible.
 *
 * 3. **It never claims to have measured anything.** No physical Sesame has been
 *    used in this project. Every event carries `provenance: "simulated"`,
 *    `measuredDeg` is always `null`, and the servo speed model is labelled a
 *    simulation choice at every point it surfaces.
 *
 * Upstream bugs are reproduced, not fixed — most visibly ISSUE-20260823-004,
 * where `setFace("stand")` emits nothing at all. See
 * `docs/findings/V1-behaviour-model.md`.
 */

export { SimulatedSesameRobot, type CallOptions, type SimulatedRobotState } from './robot.js';

export type { SesameRobot } from './robot-contract.js';

export { VirtualClock, type SimClock } from './clock.js';

export {
  DEFAULT_FACE_FPS,
  DEFAULT_FRAME_DELAY_MS,
  DEFAULT_SLEW_DEG_PER_SEC,
  DEFAULT_SUBTRIM_DEG,
  DEFAULT_WALK_CYCLES,
  DELAY_WITH_FACE_QUANTUM_MS,
  MOTOR_CURRENT_DELAY_MS,
  POWER_ON_FACE_NAME,
  resolveOptions,
  type ResolvedOptions,
  type SimulatedRobotOptions,
  type TimeMode,
} from './config.js';

export {
  AngleOutOfRangeError,
  SimError,
  SimNotConnectedError,
  UnknownCommandError,
  UnknownJointError,
  UnknownMovementError,
  UnsupportedStepError,
} from './errors.js';

export {
  FirmwareMachine,
  type FaceAnimMode,
  type MachineSnapshot,
  type Pump,
} from './machine.js';

export { driveRealtime, defaultSleep, type RealtimeOptions, type Sleep } from './realtime.js';

export { mulberry32, randomInt, type Rng } from './rng.js';

export {
  CHOREOGRAPHY,
  countSteps,
  getMovement,
  MOVEMENT_NAMES,
  MOVEMENTS,
  walkSteps,
} from './choreography.js';

export {
  STEP_TYPES,
  type CallStep,
  type Choreography,
  type ChoreographyStep,
  type ClearCommandIfStep,
  type ConditionalStep,
  type DelayStep,
  type FaceStep,
  type InterruptCheckStep,
  type LogStep,
  type MovementDefinition,
  type MovementKind,
  type RepeatStep,
  type ServoStep,
  type StateStep,
  type StepSource,
  type StepType,
} from './choreography-types.js';
