/**
 * `@sesame-lab/sesame-model` — the canonical model of the Sesame robot.
 *
 * Environment-agnostic: nothing in this entry point imports `node:*`, so it
 * runs in a browser. To read `hardware/joint-map.json` off disk, import
 * `@sesame-lab/sesame-model/node`.
 *
 * The one rule this package exists to enforce: **`R1`…`L4` and the firmware
 * index are the only authoritative joint identity.** Spatial names are guesses
 * until a physical robot says otherwise, and the types make that structural
 * rather than advisory.
 */
export {
  JOINT_ORDER,
  isJointName,
  jointAtIndex,
  jointIndex,
  type JointIndex,
  type JointKind,
  type JointName,
  type ShapeEquivalenceClass,
} from './joints.js';

export {
  HAS_JOINT_POSITION_FEEDBACK,
  type FaceState,
  type JointState,
  type MotionState,
  type NetworkState,
  type RobotMode,
  type RobotState,
  type SesameCapabilities,
  ROBOT_MODES,
  isRobotMode,
} from './state.js';

export {
  CALIBRATION_DEFAULTS,
  CALIBRATION_FIELD_COUNT,
  CALIBRATION_JOINT_FIELDS,
  CALIBRATION_ROBOT_FIELDS,
  CalibrationValidationError,
  CalibrationView,
  SUBTRIM_RANGE_DEG,
  applyCalibrationOverride,
  calibratedValue,
  describeCalibratedValue,
  isMeasured,
  measuredValueOnly,
  parseCalibration,
  serializeCalibration,
  type Calibration,
  type CalibrationDegreeRange,
  type CalibrationJointEntry,
  type CalibrationJointField,
  type CalibrationMeta,
  type CalibrationOverride,
  type CalibrationRobotEntry,
  type CalibrationRobotField,
  type CalibrationSession,
  type CalibrationSimOptions,
  type CalibrationSummary,
  type CalibrationUnresolvedEntry,
  type CalibratedValue,
  type CarriedForwardValue,
  type JointRigCalibration,
  type MeasuredValue,
  type OledActivePlaneMm,
  type ParseCalibrationOptions,
  type PartIdentityObservation,
  type SemanticNameStatus,
} from './calibration.js';

export {
  ATTACH_MAX_PULSE_REQUESTED_US,
  ATTACH_MAX_PULSE_US,
  ATTACH_MIN_PULSE_US,
  COMMANDED_ANGLE_MAX_DEG,
  COMMANDED_ANGLE_MIN_DEG,
  LIBRARY_MAX_PULSE_WIDTH_US,
  LIBRARY_MIN_PULSE_WIDTH_US,
  SERVO_FRAME_US,
  SERVO_PULSE_QUANTISATION,
  SERVO_TIMER_WIDTH_BITS,
  SERVO_TIMER_WIDTH_TICKS,
  SERVO_US_PER_TICK,
  anglesIndistinguishableFrom,
  quantiseCommandedAngle,
  reachablePulses,
  type QuantisedServoPulse,
} from './servo-pulse.js';

export {
  JointMapValidationError,
  JointMapView,
  SEMANTIC_NAME_IS_A_GUESS,
  parseJointMap,
  readGuessedSemanticName,
  type AbsoluteRotationSense,
  type AngleHistogramBucket,
  type AngleLimits,
  type BoardId,
  type CadSourceRef,
  type ChoreographyAnalysis,
  type Confidence,
  type DegreeRange,
  type DirectionSign,
  type FactStatus,
  type JointMap,
  type JointMapConventions,
  type JointMapEntry,
  type JointMapMeta,
  type LinkGeometry,
  type ObservedRange,
  type ParentLink,
  type PivotOrigin,
  type RotationAxis,
  type SemanticGuessAcknowledgement,
  type ShapeClassEntry,
  type SourceRef,
  type UnresolvedEntry,
  type UnverifiedSemanticName,
  type Vec3,
  type ZeroReference,
} from './joint-map.js';
