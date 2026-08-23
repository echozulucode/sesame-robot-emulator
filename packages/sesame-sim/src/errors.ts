/**
 * Errors the simulator raises.
 *
 * Every one of these is a place where the stock firmware does something the
 * simulator deliberately refuses to do silently. The firmware's own behaviour
 * is recorded on each class, so a future `RealSesameRobot` can be held to the
 * same contract or the divergence can be argued about explicitly.
 * See `docs/findings/V1-behaviour-model.md` §"Judgement calls".
 */

/** Base class, so callers can `catch (e) { if (e instanceof SimError) … }`. */
export class SimError extends Error {
  /** Stable machine-readable code; safe to switch on and to put on a wire. */
  readonly code: string;
  /** What the stock firmware does in this situation, in one sentence. */
  readonly firmwareBehaviour: string;

  constructor(code: string, message: string, firmwareBehaviour: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.firmwareBehaviour = firmwareBehaviour;
  }
}

/** A method was called before {@link SimulatedSesameRobot.connect}. */
export class SimNotConnectedError extends SimError {
  constructor(method: string) {
    super(
      'not-connected',
      `${method}() called before connect()`,
      'Not applicable: the firmware is always "connected" to its own peripherals. ' +
        'The lifecycle exists because the SesameRobot contract has one and a real ' +
        'transport can fail to open.',
    );
  }
}

/**
 * A command string that no `loop()` branch matches.
 *
 * The firmware assigns it to `currentCommand` and then nothing ever matches it
 * or clears it, so the robot sits in a permanently non-empty command state that
 * does nothing (`hardware-map.json` `commands.dispatchNote`). The simulator
 * refuses by default; set `strictCommandVocabulary: false` to reproduce the
 * firmware's silent no-op instead.
 */
export class UnknownCommandError extends SimError {
  readonly command: string;
  constructor(command: string, known: readonly string[]) {
    super(
      'unknown-command',
      `unknown command '${command}'. Known: ${known.join(', ')}`,
      'Assigns it to currentCommand; no loop() branch matches, so nothing runs ' +
        'and nothing ever clears it (sesame-firmware-main.ino:762-783).',
    );
    this.command = command;
  }
}

/** `setJoint()` was given something that is not one of `JOINT_ORDER`. */
export class UnknownJointError extends SimError {
  readonly joint: string;
  constructor(joint: string, known: readonly string[]) {
    super(
      'unknown-joint',
      `unknown joint '${joint}'. Known: ${known.join(', ')}`,
      'setServoAngle() guards with `if (channel < 8)` and silently ignores ' +
        'anything else (sesame-firmware-main.ino:1052); the HTTP layer returns ' +
        '400 for a name servoNameToIndex() does not know.',
    );
    this.joint = joint;
  }
}

/**
 * An angle outside the firmware's HTTP-layer accept range, or not a number.
 *
 * Note the asymmetry this reproduces: `setServoAngle()` itself *clamps*
 * (`constrain(angle + subtrim, 0, 180)`), but the only externally reachable way
 * to set one joint — `GET /cmd?motor=&value=` — **rejects** anything outside
 * `0..180` before calling it (`sesame-firmware-main.ino:252`). So a rejection
 * here is the real robot's external contract, and the clamp still applies to
 * the subtrim sum.
 */
export class AngleOutOfRangeError extends SimError {
  readonly angleDeg: number;
  constructor(angleDeg: number, min: number, max: number) {
    super(
      'angle-out-of-range',
      `angle ${angleDeg} is outside the accepted range ${min}..${max}`,
      'GET /cmd?motor=&value= rejects it with 400 before setServoAngle() is ' +
        'reached (sesame-firmware-main.ino:252).',
    );
    this.angleDeg = angleDeg;
  }
}

/** The choreography referenced a movement function or callee that does not exist. */
export class UnknownMovementError extends SimError {
  constructor(name: string) {
    super(
      'unknown-movement',
      `no movement function '${name}' in the extracted choreography`,
      'Not applicable: in C++ this would be a link error.',
    );
  }
}

/**
 * A choreography step the interpreter does not know how to execute.
 *
 * Thrown rather than skipped, on purpose: a silently skipped step is a movement
 * that is quietly wrong, which is exactly the failure mode this package exists
 * to prevent.
 */
export class UnsupportedStepError extends SimError {
  constructor(detail: string) {
    super(
      'unsupported-step',
      `unsupported choreography step: ${detail}`,
      'Not applicable: this is an extractor/interpreter mismatch, not a robot behaviour.',
    );
  }
}
