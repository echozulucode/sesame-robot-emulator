/**
 * Everything this app knows about how to move `assets/sesame.glb` — which is
 * almost nothing, because V2 put the rules *in the file*.
 *
 * The whole driving contract is four lines of V2's `asset.extras.forV3`:
 *
 * > set each joint node's local quaternion from `extras.rotationAxis` and
 * > `extras.signPerCommandedDeg`; parenting already carries a foot with its
 * > femur.
 *
 * So nothing here hardcodes an axis, a sign, a pivot or a parent. Every number
 * is read out of `object.userData` at runtime (three.js surfaces glTF node
 * `extras` there), and the module fails loudly if a node is missing or its rule
 * is malformed rather than quietly rendering a robot that does not match the
 * asset. If V6's calibration layer later flips a sign, it flips in the GLB and
 * this code does not change.
 *
 * The one thing worth restating, because it is the thing that makes the rig
 * simple: **every joint's rest rotation is the identity, so `commandedDeg = 90`
 * is the identity.** One number per joint, no rest-pose composition.
 */
import { JOINT_ORDER, jointIndex, type JointIndex, type JointName } from '@sesame-lab/sesame-model';
import { Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';

/** Metres per millimetre. `asset.extras.units.millimetresPerUnit` is 1000. */
export const MM_PER_UNIT = 1000;

/** The commanded angle at which every joint node is the identity rotation. */
export const NEUTRAL_COMMANDED_DEG = 90;

/** The three-way epistemic status V2 stamps on every derived value. */
export type PoseStatus = 'authoritative' | 'inferred' | 'guessed';

/** One joint, as the GLB describes itself. */
export interface JointRig {
  readonly joint: JointName;
  /** Servo channel. Cross-checked against `JOINT_ORDER` on load. */
  readonly firmwareIndex: JointIndex;
  readonly node: Object3D;
  /** Local rotation axis, unit length. */
  readonly axis: Vector3;
  /** `+1` or `-1`. Knees are `+1`, hips are `-1` — but read, never assumed. */
  readonly sign: 1 | -1;
  readonly jointKind: string;
  readonly linkKind: string;
  /** Pivot in canonical millimetres, for the inspector. */
  readonly pivotOriginMm: readonly [number, number, number];
  /** V2's own words for how sure it is about the axis and the sign. */
  readonly axisStatus: PoseStatus;
  readonly rotationSenseStatus: PoseStatus;
  /** The spatial guess. NOT the joint's identity; never key anything off it. */
  readonly semanticNameAlias: string | null;
  readonly semanticNameVerified: false;
  /** The rule string the asset carries, quoted verbatim in the inspector. */
  readonly rotationRule: string;
  readonly parentNode: string;
  readonly childNodes: readonly string[];
}

/** The parts of `asset.extras` this app reads. */
export interface AssetFacts {
  readonly millimetresPerUnit: number;
  readonly canonicalFrame: { id: string; upAxis: string; forwardAxis: string; rightAxis: string; note: string };
  readonly poseRule: { statement: string; status: PoseStatus; basis: string };
  readonly referencePose: { identifiedAs: string; status: PoseStatus; commandedDeg: Record<string, number>; note: string };
  readonly groundPlane: {
    method: string;
    atRunStandPoseMm: number;
    atRestPoseMm: number;
    computeItYourself: string;
  };
  readonly topCoverSubstitution: { shipped: string; substitutedFor: string; reason: string } | null;
  readonly oled: OledFacts;
  readonly knownDiscrepancies: readonly { id: string; detail: string; status: string }[];
  readonly verificationStatus: unknown;
  readonly doNotAssume: readonly string[];
}

/** What `oled_screen`'s extras promise V4. */
export interface OledFacts {
  readonly framebufferPx: readonly [number, number];
  readonly planeSizeMm: readonly [number, number];
  readonly planeStatus: PoseStatus;
  readonly uvConvention: string;
  readonly localAxes: Record<string, string>;
  /** `screenNormalCanonical` — the outward normal in the canonical frame. */
  readonly outwardNormal: readonly [number, number, number] | null;
  readonly tiltFromVerticalDeg: number | null;
  /** The window V2 read out of the STEP, as distinct from the plane it chose. */
  readonly cadGlassWindowMm: readonly [number, number] | null;
  /** V2's own explanation of what is measured here and what is a decision. */
  readonly planeMethod: string;
}

export class RigError extends Error {
  override readonly name = 'RigError';
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new RigError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RigError(`${what} is not a finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requireVec3(value: unknown, what: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new RigError(`${what} is not a 3-vector`);
  return [requireNumber(value[0], what), requireNumber(value[1], what), requireNumber(value[2], what)];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function poseStatus(value: unknown, fallback: PoseStatus = 'inferred'): PoseStatus {
  return value === 'authoritative' || value === 'inferred' || value === 'guessed' ? value : fallback;
}

/**
 * Build the rig from a loaded scene.
 *
 * @throws {RigError} if a joint node is absent, duplicated, out of order
 *   against `JOINT_ORDER`, or carries a rule this app cannot apply. All four
 *   are asset/consumer disagreements, and rendering a plausible-looking robot
 *   through them would be the worst possible outcome.
 */
export function buildRig(root: Object3D): Record<JointName, JointRig> {
  const rig: Partial<Record<JointName, JointRig>> = {};

  for (const joint of JOINT_ORDER) {
    const node = root.getObjectByName(joint);
    if (node === undefined) {
      throw new RigError(
        `the GLB has no node named "${joint}". Node names ARE the contract (V2 §9); ` +
          `regenerate assets/sesame.glb with scripts/build-gltf.py.`,
      );
    }
    const extras = requireRecord(node.userData, `node ${joint} userData`);

    const declaredIndex = requireNumber(extras['firmwareIndex'], `${joint}.extras.firmwareIndex`);
    const expectedIndex = jointIndex(joint);
    if (declaredIndex !== expectedIndex) {
      throw new RigError(
        `${joint} declares firmwareIndex ${declaredIndex}; @sesame-lab/sesame-model says ${expectedIndex}. ` +
          `The servo channel map and the asset disagree — do not render this.`,
      );
    }
    if (extras['firmwareName'] !== joint) {
      throw new RigError(`node "${joint}" declares firmwareName ${JSON.stringify(extras['firmwareName'])}`);
    }

    const axisArray = requireVec3(extras['rotationAxis'], `${joint}.extras.rotationAxis`);
    const axis = new Vector3(...axisArray);
    const length = axis.length();
    if (Math.abs(length - 1) > 1e-6) {
      throw new RigError(`${joint}.extras.rotationAxis has length ${length}, expected a unit vector`);
    }

    const rawSign = requireNumber(extras['signPerCommandedDeg'], `${joint}.extras.signPerCommandedDeg`);
    if (rawSign !== 1 && rawSign !== -1) {
      throw new RigError(`${joint}.extras.signPerCommandedDeg is ${rawSign}, expected +1 or -1`);
    }

    const neutral = requireNumber(extras['neutralCommandedDeg'], `${joint}.extras.neutralCommandedDeg`);
    if (neutral !== NEUTRAL_COMMANDED_DEG) {
      throw new RigError(
        `${joint}.extras.neutralCommandedDeg is ${neutral}; this app assumes ${NEUTRAL_COMMANDED_DEG} ` +
          `because V2 guarantees the rest pose is the neutral pose.`,
      );
    }

    rig[joint] = {
      joint,
      firmwareIndex: expectedIndex,
      node,
      axis,
      sign: rawSign,
      jointKind: optionalString(extras['jointKind']) ?? 'unknown',
      linkKind: optionalString(extras['linkKind']) ?? 'unknown',
      pivotOriginMm: requireVec3(extras['pivotOriginMm'], `${joint}.extras.pivotOriginMm`),
      axisStatus: poseStatus(extras['axisStatus']),
      rotationSenseStatus: poseStatus(extras['rotationSenseStatus']),
      semanticNameAlias: optionalString(extras['semanticNameAlias']),
      semanticNameVerified: false,
      rotationRule: optionalString(extras['rotationRule']) ?? '(no rotationRule in extras)',
      parentNode: optionalString(extras['parentNode']) ?? '(unknown)',
      childNodes: Array.isArray(extras['childNodes'])
        ? (extras['childNodes'].filter((c): c is string => typeof c === 'string'))
        : [],
    };
  }

  return rig as Record<JointName, JointRig>;
}

/**
 * The whole of V2's pose rule, applied.
 *
 * `localRotation = quaternion(axis, sign * (commandedDeg - 90))`. Nothing else
 * moves; the GLB's parenting already carries a foot with its femur.
 */
export function applyCommandedDeg(rig: JointRig, commandedDeg: number): void {
  const radians = (rig.sign * (commandedDeg - NEUTRAL_COMMANDED_DEG) * Math.PI) / 180;
  rig.node.quaternion.setFromAxisAngle(rig.axis, radians);
}

/**
 * Recover the commanded angle from where the node actually is.
 *
 * This is not a convenience: it is how the browser test asserts on the **scene
 * graph** rather than on React state. Reading a number back out of a
 * `THREE.Quaternion` proves the transform reached three.js, which is the only
 * thing a screenshot can be evidence of.
 */
export function commandedDegFromNode(rig: JointRig): number {
  const q = rig.node.quaternion;
  // The rotation is about `axis` by construction, so the vector part is
  // ±sin(θ/2)·axis and its projection onto the axis recovers the signed sine.
  const sinHalf = q.x * rig.axis.x + q.y * rig.axis.y + q.z * rig.axis.z;
  const radians = 2 * Math.atan2(sinHalf, q.w);
  const degrees = (radians * 180) / Math.PI;
  return NEUTRAL_COMMANDED_DEG + degrees / rig.sign;
}

/** The quaternion a joint *should* hold at `commandedDeg`, for comparison. */
export function expectedQuaternion(rig: JointRig, commandedDeg: number): Quaternion {
  const radians = (rig.sign * (commandedDeg - NEUTRAL_COMMANDED_DEG) * Math.PI) / 180;
  return new Quaternion().setFromAxisAngle(rig.axis, radians);
}

/** Angle between two unit quaternions, in degrees. */
export function quaternionAngleDeg(a: Quaternion, b: Quaternion): number {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

/**
 * The ground plane, recomputed from the pose that is actually on screen.
 *
 * V2 is explicit that this is **not** a constant: "min over the canonical Y of
 * every foot vertex at the pose in question. POSE-DEPENDENT: this is not a
 * property of the frame and must not be baked in as a constant." −68.650 mm at
 * `runStandPose`, −31.115 mm at rest, and the difference is real — at rest the
 * feet are horizontal, so the robot stands *higher*.
 *
 * So the app does what V2's `computeItYourself` says: transform the four foot
 * meshes' vertices through the posed node chain and take the minimum Y. It is
 * ~24 000 points; call it when the pose changes, not every frame.
 */
export function computeGroundPlaneMm(rig: Record<JointName, JointRig>): number | null {
  let minY = Number.POSITIVE_INFINITY;
  const world = new Matrix4();
  const v = new Vector3();

  for (const joint of JOINT_ORDER) {
    const entry = rig[joint];
    if (entry.linkKind !== 'foot') continue;
    entry.node.updateWorldMatrix(true, true);
    entry.node.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const position = child.geometry.getAttribute('position');
      if (position === undefined) return;
      world.copy(child.matrixWorld);
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(world);
        if (v.y < minY) minY = v.y;
      }
    });
  }

  return Number.isFinite(minY) ? minY * MM_PER_UNIT : null;
}

/**
 * Where the **viewer** draws its floor, in canonical millimetres — a constant.
 *
 * `computeGroundPlaneMm` above is pose-dependent by design, and V2 is right
 * that the *asset* must not bake it in. A viewer is a different consumer with a
 * different need: it wants one fixed spatial reference. Driving the grid from
 * the pose-dependent value made the only static object on screen slide
 * vertically under a robot whose root never moves, and the whole world read as
 * jumping — ISSUE-20260823-023.
 *
 * So the floor is pinned, at the reference pose's plane, read out of the asset
 * rather than typed in. Two measurements make that the right constant:
 *
 * - `runStandPose` is the pose V2 built the asset around and the pose every
 *   movement in V1's choreography begins and ends at. It is the floor this
 *   robot stands on, and at that pose the feet are flush with it.
 * - no reachable pose puts a foot meaningfully below it. The hips are **yaw**
 *   joints — sweeping R1 over 0-180 deg does not change any foot's height by a
 *   single micrometre — so foot height is a function of the knees alone, and
 *   each knee bottoms out at -68.7355 mm (R3, L3) or -68.9233 mm (R4, L4)
 *   against this plane's -68.6500 mm. Worst case 0.27 mm of interpenetration
 *   on a 130 mm robot, and only at a hand-dialled knee angle no movement uses.
 *
 * The robot root is deliberately **not** translated to settle onto it. World
 * space here *is* the canonical frame — `pivotWorldMm`, `computeGroundPlaneMm`
 * and `verifyStandPose` all read canonical coordinates straight off
 * `matrixWorld` — so moving the root would silently redefine every coordinate
 * this app reports. And where a body whose feet have left the ground would
 * settle is a physics question; Gate E says this app does not answer those.
 */
export function groundReferenceMm(facts: AssetFacts): number {
  return facts.groundPlane.atRunStandPoseMm;
}

/** Read the asset-level facts V2 shipped inside the GLB. */
export function readAssetFacts(assetExtras: unknown, oledNode: Object3D | undefined, topCover: Object3D | undefined): AssetFacts {
  const e = requireRecord(assetExtras, 'asset.extras');
  const units = requireRecord(e['units'], 'asset.extras.units');
  const millimetresPerUnit = requireNumber(units['millimetresPerUnit'], 'units.millimetresPerUnit');
  if (millimetresPerUnit !== MM_PER_UNIT) {
    throw new RigError(`the GLB declares ${millimetresPerUnit} mm per unit; this app assumes ${MM_PER_UNIT}`);
  }

  const frame = requireRecord(e['canonicalFrame'], 'asset.extras.canonicalFrame');
  const rule = requireRecord(e['poseRule'], 'asset.extras.poseRule');
  const reference = requireRecord(e['referencePose'], 'asset.extras.referencePose');
  const ground = requireRecord(e['groundPlane'], 'asset.extras.groundPlane');
  const forV3 = requireRecord(e['forV3'] ?? {}, 'asset.extras.forV3');

  const coverExtras = topCover === undefined ? null : requireRecord(topCover.userData, 'body_top_cover.userData');
  const substitutedFor = coverExtras === null ? null : optionalString(coverExtras['substitutedFor']);

  return {
    millimetresPerUnit,
    canonicalFrame: {
      id: optionalString(frame['id']) ?? 'sesame-robot',
      upAxis: optionalString(frame['upAxis']) ?? '+Y',
      forwardAxis: optionalString(frame['forwardAxis']) ?? '-Z',
      rightAxis: optionalString(frame['rightAxis']) ?? '+X',
      note: optionalString(frame['note']) ?? '',
    },
    poseRule: {
      statement: optionalString(rule['statement']) ?? '',
      status: poseStatus(rule['status']),
      basis: optionalString(rule['basis']) ?? '',
    },
    referencePose: {
      identifiedAs: optionalString(reference['identifiedAs']) ?? 'runStandPose',
      status: poseStatus(reference['status']),
      commandedDeg: requireRecord(reference['commandedDeg'], 'referencePose.commandedDeg') as Record<string, number>,
      note: optionalString(reference['note']) ?? '',
    },
    groundPlane: {
      method: optionalString(ground['method']) ?? '',
      atRunStandPoseMm: requireNumber(ground['atRunStandPoseMm'], 'groundPlane.atRunStandPoseMm'),
      atRestPoseMm: requireNumber(ground['atRestPoseMm'], 'groundPlane.atRestPoseMm'),
      computeItYourself: optionalString(ground['computeItYourself']) ?? '',
    },
    topCoverSubstitution:
      substitutedFor === null || coverExtras === null
        ? null
        : {
            shipped: optionalString(coverExtras['stlFile']) ?? '(unknown)',
            substitutedFor,
            reason: optionalString(coverExtras['substitutionReason']) ?? '',
          },
    oled: readOledFacts(oledNode),
    knownDiscrepancies: Array.isArray(e['knownDiscrepancies'])
      ? (e['knownDiscrepancies'] as { id: string; detail: string; status: string }[])
      : [],
    verificationStatus: e['verificationStatus'],
    doNotAssume: Array.isArray(forV3['doNotAssume'])
      ? forV3['doNotAssume'].filter((s): s is string => typeof s === 'string')
      : [],
  };
}

function readOledFacts(node: Object3D | undefined): OledFacts {
  if (node === undefined) {
    throw new RigError('the GLB has no node named "oled_screen"; V4 has nothing to project onto.');
  }
  const e = requireRecord(node.userData, 'oled_screen.userData');
  const framebuffer = requireArray(e['framebufferPx']) ?? [];
  if (framebuffer[0] !== 128 || framebuffer[1] !== 64) {
    throw new RigError(
      `oled_screen declares a ${framebuffer.join('x')} framebuffer; the protocol's SSD1306 encoding is 128x64.`,
    );
  }
  const plane = requireArray(e['planeSizeMm']) ?? [];
  const normalRaw = e['screenNormalCanonical'];
  const window = requireArray(e['cadGlassWindowMm']);

  return {
    framebufferPx: [128, 64],
    planeSizeMm: [Number(plane[0] ?? 0), Number(plane[1] ?? 0)],
    planeStatus: poseStatus(e['planeStatus']),
    uvConvention: optionalString(e['uvConvention']) ?? '',
    localAxes:
      typeof e['localAxes'] === 'object' && e['localAxes'] !== null
        ? (e['localAxes'] as Record<string, string>)
        : {},
    outwardNormal:
      Array.isArray(normalRaw) && normalRaw.length === 3
        ? [Number(normalRaw[0]), Number(normalRaw[1]), Number(normalRaw[2])]
        : null,
    tiltFromVerticalDeg: typeof e['tiltFromVerticalDeg'] === 'number' ? e['tiltFromVerticalDeg'] : null,
    cadGlassWindowMm: window === null ? null : [Number(window[0]), Number(window[1])],
    planeMethod: optionalString(e['planeMethod']) ?? '',
  };
}

function requireArray(value: unknown): number[] | null {
  return Array.isArray(value) ? value.map(Number) : null;
}
