/**
 * Joint identity for the Sesame robot.
 *
 * The ONLY authoritative identity of a joint is its firmware name and its
 * firmware index. Everything spatial — "front", "rear", "left", "right" — is a
 * guess until someone holds a built robot, and the types in this file are
 * arranged so that a guess cannot be mistaken for a fact by accident.
 */

/**
 * The eight servo channels, written in **firmware enum order**.
 *
 * ```c
 * // firmware/movement-sequences.h:5
 * enum ServoName { R1=0, R2=1, L1=2, L2=3, R4=4, R3=5, L3=6, L4=7 };
 * ```
 *
 * The order is deliberately neither geometric nor alphabetical: it is the
 * wiring order the firmware and the build guide's motor-index diagram both
 * use. `R4` really does come before `R3`.
 */
export type JointName = 'R1' | 'R2' | 'L1' | 'L2' | 'R4' | 'R3' | 'L3' | 'L4';

/**
 * The firmware enum order as a readonly tuple.
 *
 * `JOINT_ORDER[i]` is the joint driven by servo channel `i`, which is the index
 * that appears in `setServoAngle(index, deg)`, in `servoPins[]`, in
 * `servoSubtrim[]` and in the `00`–`07` labels on
 * `docs/build-guide/assets/sesame-angle-guide.png`.
 *
 * **Do not sort this.** Alphabetising it, or "fixing" it to `R1,R2,R3,R4,…`,
 * silently rewires four of the eight servos. `joint-order.test.ts` exists to
 * make that mistake loud.
 */
export const JOINT_ORDER = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'] as const;

/** Compile-time proof that `JOINT_ORDER` covers `JointName` exactly once each. */
type _JointOrderCoversJointName =
  JointName extends (typeof JOINT_ORDER)[number]
    ? (typeof JOINT_ORDER)[number] extends JointName ? true : never
    : never;
const _jointOrderIsExhaustive: _JointOrderCoversJointName = true;
void _jointOrderIsExhaustive;

/** Servo channel index, 0–7, as used by `setServoAngle()`. */
export type JointIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

const INDEX_BY_NAME: Readonly<Record<JointName, JointIndex>> = {
  R1: 0, R2: 1, L1: 2, L2: 3, R4: 4, R3: 5, L3: 6, L4: 7,
};

/** The firmware servo-channel index for a joint. Authoritative. */
export function jointIndex(joint: JointName): JointIndex {
  return INDEX_BY_NAME[joint];
}

/** The joint on a given firmware servo channel, or `undefined` if out of range. */
export function jointAtIndex(index: number): JointName | undefined {
  return JOINT_ORDER[index];
}

/** Narrowing type guard for untrusted input. */
export function isJointName(value: unknown): value is JointName {
  return typeof value === 'string' && (JOINT_ORDER as readonly string[]).includes(value);
}

/**
 * The two kinds of printed joint link. This IS authoritative: the CAD master
 * names the parts `femur-joint-R1` … `foot-joint-L4`.
 */
export type JointKind = 'femur' | 'foot';

/**
 * The four distinct printed solids. Eight joints, four shapes: F5 measured
 * `R1 ≡ L2`, `R2 ≡ L1`, `R3 ≡ L4`, `R4 ≡ L3`. The identical pairs are
 * *diagonal*, so the robot has two-fold rotational symmetry about its vertical
 * axis rather than simple bilateral symmetry.
 */
export type ShapeEquivalenceClass = 'femur-A' | 'femur-B' | 'foot-A' | 'foot-B';
