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
} from './state.js';

export {
  JointMapValidationError,
  JointMapView,
  SEMANTIC_NAME_IS_A_GUESS,
  parseJointMap,
  readGuessedSemanticName,
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
